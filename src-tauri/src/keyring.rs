#[cfg(unix)]
use std::{
    env, fs,
    sync::{Mutex, MutexGuard},
    time::{Duration, Instant},
};

#[cfg(any(windows, test))]
use std::marker::PhantomData;
use std::sync::OnceLock;

#[cfg(any(windows, test, feature = "phase1-conformance"))]
use sha2::{Digest, Sha256};

#[cfg(unix)]
use fs2::FileExt;
use keyring_core::{Entry, Error as KeyringBackendError};
use serde::{Deserialize, Serialize};
use url::{Host, Url};
use uuid::{Uuid, Variant, Version};
use zeroize::{Zeroize, Zeroizing};

use crate::cave::NativeDiagnostic;

const SERVICE: &str = "ai.opencoven.chat";
#[cfg(feature = "phase1-conformance")]
const CONFORMANCE_SERVICE_ENV: &str = "OPENCOVEN_PHASE1_CONFORMANCE_KEYRING_SERVICE";
#[cfg(feature = "phase1-conformance")]
pub(crate) const CONFORMANCE_SERVICE_PREFIX: &str = "ai.opencoven.chat.phase1.";
pub(crate) const CREDENTIAL_ACCOUNT_PREFIX: &str = "cave-client-v1";
pub(crate) const INSTALLATION_ID_ACCOUNT: &str = "installation-id-v1";
#[cfg(unix)]
const CREDENTIAL_LOCK_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CREDENTIAL_RECORD_BYTES: usize = 4 * 1024;
#[cfg(feature = "phase1-conformance")]
const CONFORMANCE_CLEANUP_SERVICE: &str = "ai.opencoven.chat.conformance-cleanup";
#[cfg(feature = "phase1-conformance")]
const CONFORMANCE_CLEANUP_ACCOUNT_PREFIX: &str = "cleanup-reservation-v1";
#[cfg(feature = "phase1-conformance")]
const CONFORMANCE_HARNESS_IDENTITY: &str = "phase1-native-rpc-v1";

static STORE_INITIALIZED: OnceLock<()> = OnceLock::new();

#[cfg(feature = "phase1-conformance")]
fn conformance_service_name_from_value(value: Option<&str>) -> Result<String, KeyringError> {
    let service = value.ok_or(KeyringError::Unavailable)?;
    if service
        .strip_prefix(CONFORMANCE_SERVICE_PREFIX)
        .is_some_and(|suffix| {
            suffix.len() == 32
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
    {
        Ok(service.to_owned())
    } else {
        Err(KeyringError::Unavailable)
    }
}

#[cfg(feature = "phase1-conformance")]
fn configured_conformance_service() -> Result<String, KeyringError> {
    match std::env::var(CONFORMANCE_SERVICE_ENV) {
        Ok(value) => conformance_service_name_from_value(Some(&value)),
        Err(std::env::VarError::NotPresent) => conformance_service_name_from_value(None),
        Err(std::env::VarError::NotUnicode(_)) => Err(KeyringError::Unavailable),
    }
}

#[derive(Debug)]
pub(crate) enum KeyringError {
    NotFound,
    Unavailable,
    Failure,
    #[cfg(feature = "phase1-conformance")]
    CleanupGrantRejected,
}

impl KeyringError {
    pub(crate) const fn diagnostic(&self) -> NativeDiagnostic {
        match self {
            Self::NotFound => NativeDiagnostic::new("credential_missing", true),
            Self::Unavailable => NativeDiagnostic::new("secure_store_unavailable", true),
            Self::Failure => NativeDiagnostic::new("keychain_failure", true),
            #[cfg(feature = "phase1-conformance")]
            Self::CleanupGrantRejected => NativeDiagnostic::new("cleanup_grant_rejected", false),
        }
    }
}

#[derive(Clone)]
pub(crate) struct Credential {
    pub(crate) bearer: String,
    pub(crate) credential_id: String,
    pub(crate) origin: String,
}

impl Credential {
    pub(crate) fn is_same_identity(&self, other: &Self) -> bool {
        self.bearer == other.bearer
            && self.credential_id == other.credential_id
            && self.origin == other.origin
    }
}

impl Drop for Credential {
    fn drop(&mut self) {
        self.bearer.zeroize();
    }
}

#[derive(Serialize, Deserialize)]
struct StoredCredential {
    bearer: String,
    credential_id: String,
    origin: String,
}

impl Drop for StoredCredential {
    fn drop(&mut self) {
        self.bearer.zeroize();
    }
}

#[derive(Clone)]
pub(crate) enum CredentialSlot {
    Missing,
    Current(Credential),
    Stale(Credential),
}

pub(crate) trait CredentialCustody: Send + Sync {
    fn installation_id(&self) -> Result<String, KeyringError> {
        Err(KeyringError::Unavailable)
    }

    fn read(&self, instance_id: &str, origin: &str) -> Result<Credential, KeyringError>;
    fn read_for_pairing_update(
        &self,
        instance_id: &str,
        origin: &str,
    ) -> Result<CredentialSlot, KeyringError>;
    fn store_if_current(
        &self,
        instance_id: &str,
        origin: &str,
        expected_credential: Option<&Credential>,
        bearer: &str,
        credential_id: &str,
    ) -> Result<bool, KeyringError>;
    fn replace_stale_if_current(
        &self,
        instance_id: &str,
        origin: &str,
        expected_stale_credential: &Credential,
        bearer: &str,
        credential_id: &str,
    ) -> Result<bool, KeyringError>;
    fn delete_if_matches(
        &self,
        instance_id: &str,
        origin: &str,
        expected_credential: &Credential,
    ) -> Result<bool, KeyringError>;
}

#[derive(Clone, Default)]
pub(crate) struct NativeKeyring {
    #[cfg(feature = "phase1-conformance")]
    provider_preset: Option<NativeProviderPreset>,
    #[cfg(feature = "phase1-conformance")]
    conformance_service: Option<String>,
    #[cfg(feature = "phase1-conformance")]
    reservation_required: bool,
    #[cfg(feature = "phase1-conformance")]
    prepared_instance: std::sync::Arc<std::sync::Mutex<Option<String>>>,
    #[cfg(feature = "phase1-conformance")]
    prepared_cleanup: std::sync::Arc<std::sync::Mutex<Option<ConformanceCleanupReservation>>>,
    #[cfg(feature = "phase1-conformance")]
    cleanup_process_secret: std::sync::Arc<OnceLock<Zeroizing<[u8; 32]>>>,
    #[cfg(feature = "phase1-conformance")]
    issued_cleanup_grants: std::sync::Arc<std::sync::Mutex<std::collections::HashSet<String>>>,
}

#[cfg(feature = "phase1-conformance")]
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConformanceCleanupReservation {
    pub(crate) reservation_handle: String,
    pub(crate) capability: String,
    pub(crate) owner_token: String,
}

#[cfg(feature = "phase1-conformance")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ConformanceCleanupOutcome {
    Deleted,
    Transferred,
}

#[cfg(feature = "phase1-conformance")]
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ConformanceCleanupMarker {
    version: u8,
    store_schema_version: u8,
    run_id: String,
    harness_identity: String,
    instance_id: String,
    target_account: String,
    capability_sha256: String,
    owner_token: String,
    pending_owner_token: Option<String>,
}

#[cfg(feature = "phase1-conformance")]
fn conformance_sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(feature = "phase1-conformance")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum NativeProviderPreset {
    MissingKeychainTrust,
}

#[cfg(feature = "phase1-conformance")]
impl NativeKeyring {
    pub(crate) fn with_provider_preset(preset: NativeProviderPreset) -> Self {
        Self {
            provider_preset: Some(preset),
            ..Self::default()
        }
    }

    pub(crate) fn for_conformance() -> Self {
        Self {
            reservation_required: true,
            ..Self::default()
        }
    }

    pub(crate) fn for_schema_v2() -> Result<Self, KeyringError> {
        Ok(Self {
            conformance_service: Some(configured_conformance_service()?),
            ..Self::default()
        })
    }

    fn reject_provider_if_configured(&self) -> Result<(), KeyringError> {
        match self.provider_preset {
            Some(NativeProviderPreset::MissingKeychainTrust) => Err(KeyringError::Unavailable),
            None => Ok(()),
        }
    }

    fn service_name(&self) -> &str {
        self.conformance_service.as_deref().unwrap_or(SERVICE)
    }

    fn cleanup_process_secret(&self, create: bool) -> Result<&[u8; 32], KeyringError> {
        if self.cleanup_process_secret.get().is_none() && create {
            let mut secret = Zeroizing::new([0_u8; 32]);
            getrandom::fill(secret.as_mut()).map_err(|_| KeyringError::Unavailable)?;
            let _ = self.cleanup_process_secret.set(secret);
        }
        self.cleanup_process_secret
            .get()
            .map(|secret| &**secret)
            .ok_or(KeyringError::CleanupGrantRejected)
    }

    fn conformance_reservation_entry(handle: &str) -> Result<Entry, KeyringError> {
        validate_installation_id(handle)?;
        Self::entry_for(
            CONFORMANCE_CLEANUP_SERVICE,
            &format!("{CONFORMANCE_CLEANUP_ACCOUNT_PREFIX}:{handle}"),
        )
    }

    pub(crate) fn prepare_conformance_cleanup(
        &self,
        instance_id: &str,
    ) -> Result<ConformanceCleanupReservation, KeyringError> {
        self.reject_provider_if_configured()?;
        validate_installation_id(instance_id)?;
        let _guard = acquire_mutation_lock()?;
        match Self::credential_entry_for_service(self.service_name(), instance_id)?.get_secret() {
            Err(KeyringBackendError::NoEntry) => {}
            Ok(mut value) => {
                value.zeroize();
                return Err(KeyringError::Failure);
            }
            Err(error) => return Err(map_keyring_error(error)),
        }
        if self
            .prepared_instance
            .lock()
            .map_err(|_| KeyringError::Failure)?
            .is_some()
        {
            return Err(KeyringError::Failure);
        }
        let handle = Uuid::new_v4().to_string();
        let capability = Uuid::new_v4().to_string();
        let owner_token = Uuid::new_v4().to_string();
        let entry = Self::conformance_reservation_entry(&handle)?;
        match entry.get_secret() {
            Err(KeyringBackendError::NoEntry) => {}
            Ok(mut value) => {
                value.zeroize();
                return Err(KeyringError::Failure);
            }
            Err(error) => return Err(map_keyring_error(error)),
        }
        let marker = ConformanceCleanupMarker {
            version: 2,
            store_schema_version: 1,
            run_id: handle.clone(),
            harness_identity: CONFORMANCE_HARNESS_IDENTITY.to_owned(),
            instance_id: instance_id.to_owned(),
            target_account: format!("{CREDENTIAL_ACCOUNT_PREFIX}:{instance_id}"),
            capability_sha256: conformance_sha256_hex(capability.as_bytes()),
            owner_token: owner_token.clone(),
            pending_owner_token: None,
        };
        let bytes = Zeroizing::new(serde_json::to_vec(&marker).map_err(|_| KeyringError::Failure)?);
        entry
            .set_secret(bytes.as_slice())
            .map_err(map_keyring_error)?;
        let reservation = ConformanceCleanupReservation {
            reservation_handle: handle,
            capability,
            owner_token,
        };
        *self
            .prepared_cleanup
            .lock()
            .map_err(|_| KeyringError::Failure)? = Some(reservation.clone());
        *self
            .prepared_instance
            .lock()
            .map_err(|_| KeyringError::Failure)? = Some(instance_id.to_owned());
        Ok(reservation)
    }

    pub(crate) fn cleanup_conformance_credential(
        &self,
        handle: &str,
        capability: &str,
        owner_token: &str,
    ) -> Result<ConformanceCleanupOutcome, KeyringError> {
        self.reject_provider_if_configured()?;
        validate_installation_id(handle)?;
        validate_installation_id(capability)?;
        validate_installation_id(owner_token)?;
        let _guard = acquire_mutation_lock()?;
        let marker_entry = Self::conformance_reservation_entry(handle)?;
        let marker_bytes = match marker_entry.get_secret() {
            Ok(value) => Zeroizing::new(value),
            Err(KeyringBackendError::NoEntry) => return Err(KeyringError::NotFound),
            Err(error) => return Err(map_keyring_error(error)),
        };
        let marker: ConformanceCleanupMarker =
            serde_json::from_slice(marker_bytes.as_slice()).map_err(|_| KeyringError::Failure)?;
        validate_installation_id(&marker.instance_id)?;
        validate_installation_id(&marker.owner_token)?;
        if marker.version != 2
            || marker.store_schema_version != 1
            || marker.run_id != handle
            || marker.harness_identity != CONFORMANCE_HARNESS_IDENTITY
            || marker.target_account
                != format!("{CREDENTIAL_ACCOUNT_PREFIX}:{}", marker.instance_id)
            || marker.capability_sha256 != conformance_sha256_hex(capability.as_bytes())
        {
            return Err(KeyringError::Failure);
        }
        if marker.owner_token != owner_token {
            return Ok(ConformanceCleanupOutcome::Transferred);
        }
        let target = Self::credential_entry_for_service(self.service_name(), &marker.instance_id)?;
        match target.delete_credential() {
            Ok(()) | Err(KeyringBackendError::NoEntry) => {}
            Err(error) => return Err(map_keyring_error(error)),
        }
        match target.get_secret() {
            Err(KeyringBackendError::NoEntry) => {}
            Ok(mut value) => {
                value.zeroize();
                return Err(KeyringError::Failure);
            }
            Err(error) => return Err(map_keyring_error(error)),
        }
        marker_entry
            .delete_credential()
            .map_err(map_keyring_error)?;
        match marker_entry.get_secret() {
            Err(KeyringBackendError::NoEntry) => {
                *self
                    .prepared_instance
                    .lock()
                    .map_err(|_| KeyringError::Failure)? = None;
                let mut prepared_cleanup = self
                    .prepared_cleanup
                    .lock()
                    .map_err(|_| KeyringError::Failure)?;
                if prepared_cleanup
                    .as_ref()
                    .is_some_and(|prepared| prepared.reservation_handle == handle)
                {
                    *prepared_cleanup = None;
                }
                Ok(ConformanceCleanupOutcome::Deleted)
            }

            Ok(mut value) => {
                value.zeroize();
                Err(KeyringError::Failure)
            }
            Err(error) => Err(map_keyring_error(error)),
        }
    }

    pub(crate) fn begin_adopt_conformance_cleanup(
        &self,
        handle: &str,
        capability: &str,
        owner_token: &str,
        successor_owner_token: &str,
    ) -> Result<ConformanceCleanupReservation, KeyringError> {
        self.reject_provider_if_configured()?;
        validate_installation_id(handle)?;
        validate_installation_id(capability)?;
        validate_installation_id(owner_token)?;
        validate_installation_id(successor_owner_token)?;
        let _guard = acquire_mutation_lock()?;
        let marker_entry = Self::conformance_reservation_entry(handle)?;
        let marker_bytes = match marker_entry.get_secret() {
            Ok(value) => Zeroizing::new(value),
            Err(KeyringBackendError::NoEntry) => return Err(KeyringError::NotFound),
            Err(error) => return Err(map_keyring_error(error)),
        };
        let mut marker: ConformanceCleanupMarker =
            serde_json::from_slice(marker_bytes.as_slice()).map_err(|_| KeyringError::Failure)?;
        validate_installation_id(&marker.instance_id)?;
        validate_installation_id(&marker.owner_token)?;
        if marker.version != 2
            || marker.store_schema_version != 1
            || marker.run_id != handle
            || marker.harness_identity != CONFORMANCE_HARNESS_IDENTITY
            || marker.target_account
                != format!("{CREDENTIAL_ACCOUNT_PREFIX}:{}", marker.instance_id)
            || marker.capability_sha256 != conformance_sha256_hex(capability.as_bytes())
            || marker.owner_token != owner_token
        {
            return Err(KeyringError::Failure);
        }
        if let Some(pending) = marker.pending_owner_token.as_deref() {
            if pending == successor_owner_token {
                return Ok(ConformanceCleanupReservation {
                    reservation_handle: handle.to_owned(),
                    capability: capability.to_owned(),
                    owner_token: successor_owner_token.to_owned(),
                });
            }
            return Err(KeyringError::Failure);
        }
        match Self::credential_entry_for_service(self.service_name(), &marker.instance_id)?
            .get_secret()
        {
            Ok(mut value) => value.zeroize(),
            Err(error) => return Err(map_keyring_error(error)),
        }
        marker.pending_owner_token = Some(successor_owner_token.to_owned());
        let bytes = Zeroizing::new(serde_json::to_vec(&marker).map_err(|_| KeyringError::Failure)?);
        marker_entry
            .set_secret(bytes.as_slice())
            .map_err(map_keyring_error)?;
        Ok(ConformanceCleanupReservation {
            reservation_handle: handle.to_owned(),
            capability: capability.to_owned(),
            owner_token: successor_owner_token.to_owned(),
        })
    }

    pub(crate) fn commit_adopt_conformance_cleanup(
        &self,
        handle: &str,
        capability: &str,
        owner_token: &str,
        successor_owner_token: &str,
    ) -> Result<(), KeyringError> {
        self.reject_provider_if_configured()?;
        for value in [handle, capability, owner_token, successor_owner_token] {
            validate_installation_id(value)?;
        }
        let _guard = acquire_mutation_lock()?;
        let entry = Self::conformance_reservation_entry(handle)?;
        let bytes = match entry.get_secret() {
            Ok(value) => Zeroizing::new(value),
            Err(error) => return Err(map_keyring_error(error)),
        };
        let mut marker: ConformanceCleanupMarker =
            serde_json::from_slice(bytes.as_slice()).map_err(|_| KeyringError::Failure)?;
        if marker.capability_sha256 != conformance_sha256_hex(capability.as_bytes()) {
            return Err(KeyringError::Failure);
        }
        let already_committed =
            marker.owner_token == successor_owner_token && marker.pending_owner_token.is_none();
        if !already_committed {
            if marker.owner_token != owner_token
                || marker.pending_owner_token.as_deref() != Some(successor_owner_token)
            {
                return Err(KeyringError::Failure);
            }
            marker.owner_token = successor_owner_token.to_owned();
            marker.pending_owner_token = None;
            let bytes =
                Zeroizing::new(serde_json::to_vec(&marker).map_err(|_| KeyringError::Failure)?);
            entry
                .set_secret(bytes.as_slice())
                .map_err(map_keyring_error)?;
        }
        let reservation = ConformanceCleanupReservation {
            reservation_handle: handle.to_owned(),
            capability: capability.to_owned(),
            owner_token: successor_owner_token.to_owned(),
        };
        *self
            .prepared_cleanup
            .lock()
            .map_err(|_| KeyringError::Failure)? = Some(reservation);
        *self
            .prepared_instance
            .lock()
            .map_err(|_| KeyringError::Failure)? = Some(marker.instance_id);
        Ok(())
    }

    pub(crate) fn abort_adopt_conformance_cleanup(
        &self,
        handle: &str,
        capability: &str,
        owner_token: &str,
        successor_owner_token: &str,
    ) -> Result<(), KeyringError> {
        self.reject_provider_if_configured()?;
        for value in [handle, capability, owner_token, successor_owner_token] {
            validate_installation_id(value)?;
        }
        let _guard = acquire_mutation_lock()?;
        let entry = Self::conformance_reservation_entry(handle)?;
        let bytes = match entry.get_secret() {
            Ok(value) => Zeroizing::new(value),
            Err(KeyringBackendError::NoEntry) => return Ok(()),
            Err(error) => return Err(map_keyring_error(error)),
        };
        let mut marker: ConformanceCleanupMarker =
            serde_json::from_slice(bytes.as_slice()).map_err(|_| KeyringError::Failure)?;
        if marker.capability_sha256 != conformance_sha256_hex(capability.as_bytes()) {
            return Err(KeyringError::Failure);
        }
        if marker.owner_token == successor_owner_token && marker.pending_owner_token.is_none() {
            return Ok(());
        }
        if marker.owner_token != owner_token {
            return Err(KeyringError::Failure);
        }
        if marker.pending_owner_token.as_deref() == Some(successor_owner_token) {
            marker.pending_owner_token = None;
            let bytes =
                Zeroizing::new(serde_json::to_vec(&marker).map_err(|_| KeyringError::Failure)?);
            entry
                .set_secret(bytes.as_slice())
                .map_err(map_keyring_error)?;
        }
        Ok(())
    }

    pub(crate) fn cancel_prepared_conformance_cleanup(&self) -> Result<(), KeyringError> {
        self.reject_provider_if_configured()?;
        let prepared = self
            .prepared_cleanup
            .lock()
            .map_err(|_| KeyringError::Failure)?
            .clone();
        match prepared {
            Some(reservation) => self.cleanup_conformance_credential(
                &reservation.reservation_handle,
                &reservation.capability,
                &reservation.owner_token,
            ),
            None => Ok(ConformanceCleanupOutcome::Deleted),
        }
        .map(|_| ())
    }

    pub(crate) fn conformance_state(
        &self,
        instance_ids: &[String],
    ) -> Result<(&'static str, bool, String), KeyringError> {
        let service = self.service_name();
        self.reject_provider_if_configured()?;
        if service == SERVICE && !instance_ids.is_empty() {
            return Err(KeyringError::Failure);
        }
        let accounts = canonical_conformance_cleanup_accounts(instance_ids)?;
        let _guard = acquire_mutation_lock()?;
        Self::conformance_state_for_accounts(service, &accounts)
    }

    pub(crate) fn issue_conformance_cleanup_grant(
        &self,
        instance_ids: &[String],
    ) -> Result<String, KeyringError> {
        let service = self.service_name();
        self.reject_provider_if_configured()?;
        if service == SERVICE {
            return Err(KeyringError::Unavailable);
        }
        let accounts = canonical_conformance_cleanup_accounts(instance_ids)?;
        let grant =
            crate::cleanup_grant::issue(service, &accounts, self.cleanup_process_secret(true)?)?;
        let grant_identity = crate::cleanup_grant::grant_identity(&grant)?;
        let mut issued = self
            .issued_cleanup_grants
            .lock()
            .map_err(|_| KeyringError::Failure)?;
        if !issued.insert(grant_identity) {
            return Err(KeyringError::Failure);
        }
        Ok(grant)
    }

    pub(crate) fn redeem_conformance_cleanup_grant(
        &self,
        grant: &str,
    ) -> Result<(&'static str, bool, String), KeyringError> {
        let service = self.service_name();
        self.reject_provider_if_configured()?;
        if service == SERVICE {
            return Err(KeyringError::Unavailable);
        }
        let grant_identity = crate::cleanup_grant::grant_identity(grant)?;
        {
            let mut issued = self
                .issued_cleanup_grants
                .lock()
                .map_err(|_| KeyringError::CleanupGrantRejected)?;
            if !issued.remove(&grant_identity) {
                return Err(KeyringError::CleanupGrantRejected);
            }
        }
        let scope =
            crate::cleanup_grant::redeem(grant, service, self.cleanup_process_secret(false)?)?;
        let _guard = acquire_mutation_lock()?;
        for account in &scope.accounts {
            let entry = Self::entry_for(scope.service.as_str(), account)?;
            match entry.delete_credential() {
                Ok(()) | Err(KeyringBackendError::NoEntry) => {}
                Err(error) => return Err(map_keyring_error(error)),
            }
        }
        Self::conformance_state_for_accounts(&scope.service, &scope.accounts)
    }

    fn conformance_state_for_accounts(
        service: &str,
        accounts: &[String],
    ) -> Result<(&'static str, bool, String), KeyringError> {
        validate_conformance_cleanup_accounts(accounts)?;
        let mut occupied = false;
        for account in accounts {
            occupied |= Self::conformance_entry_present(&Self::entry_for(service, account)?)?;
        }
        let digest = Sha256::digest(if occupied {
            b"phase1-native-custody-occupied-v1".as_slice()
        } else {
            b"phase1-native-custody-empty-v1".as_slice()
        });
        Ok((native_keyring_backend(), !occupied, format!("{digest:x}")))
    }

    fn require_prepared_instance(&self, instance_id: &str) -> Result<(), KeyringError> {
        if !self.reservation_required {
            return Ok(());
        }
        match self
            .prepared_instance
            .lock()
            .map_err(|_| KeyringError::Failure)?
            .as_deref()
        {
            Some(prepared) if prepared == instance_id => Ok(()),
            _ => Err(KeyringError::Failure),
        }
    }
}

#[cfg(feature = "phase1-conformance")]
fn canonical_conformance_cleanup_accounts(
    instance_ids: &[String],
) -> Result<Vec<String>, KeyringError> {
    let mut instance_ids = instance_ids.to_vec();
    for instance_id in &instance_ids {
        validate_installation_id(instance_id)?;
    }
    instance_ids.sort();
    instance_ids.dedup();
    let mut accounts = Vec::with_capacity(instance_ids.len() + 1);
    accounts.push(INSTALLATION_ID_ACCOUNT.to_owned());
    accounts.extend(
        instance_ids
            .into_iter()
            .map(|instance_id| format!("{CREDENTIAL_ACCOUNT_PREFIX}:{instance_id}")),
    );
    validate_conformance_cleanup_accounts(&accounts)?;
    Ok(accounts)
}

#[cfg(feature = "phase1-conformance")]
pub(crate) fn validate_conformance_cleanup_accounts(
    accounts: &[String],
) -> Result<(), KeyringError> {
    if accounts.is_empty() || accounts.len() > 9 || accounts[0] != INSTALLATION_ID_ACCOUNT {
        return Err(KeyringError::Failure);
    }
    let prefix = format!("{CREDENTIAL_ACCOUNT_PREFIX}:");
    let mut previous: Option<&str> = None;
    for account in &accounts[1..] {
        let instance_id = account.strip_prefix(&prefix).ok_or(KeyringError::Failure)?;
        validate_installation_id(instance_id)?;
        if previous.is_some_and(|previous| previous >= account.as_str()) {
            return Err(KeyringError::Failure);
        }
        previous = Some(account);
    }
    Ok(())
}

#[cfg(unix)]
fn mutation_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

#[cfg(unix)]
struct CredentialMutationGuard {
    _process: MutexGuard<'static, ()>,
    _file: fs::File,
}

#[cfg(all(unix, any(not(feature = "phase1-conformance"), test)))]
fn default_credential_lock_root(home: &std::path::Path) -> std::path::PathBuf {
    home.join(".coven").join("chat")
}

#[cfg(unix)]
fn credential_lock_path_for_root(
    root: &std::path::Path,
) -> Result<std::path::PathBuf, KeyringError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    if !root.is_absolute() {
        return Err(KeyringError::Unavailable);
    }
    fs::create_dir_all(root).map_err(|_| KeyringError::Unavailable)?;
    fs::set_permissions(root, fs::Permissions::from_mode(0o700))
        .map_err(|_| KeyringError::Unavailable)?;
    let metadata = fs::symlink_metadata(root).map_err(|_| KeyringError::Unavailable)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(KeyringError::Unavailable);
    }
    Ok(root.join("credential-mutation.lock"))
}

#[cfg(unix)]
fn credential_lock_path() -> Result<std::path::PathBuf, KeyringError> {
    #[cfg(all(feature = "phase1-conformance", not(test)))]
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    #[cfg(feature = "phase1-conformance")]
    if let Some(path) = env::var_os("OPENCOVEN_PHASE1_CONFORMANCE_LOCK_ROOT") {
        return credential_lock_path_for_root(&std::path::PathBuf::from(path));
    }
    let home = env::var_os("HOME").ok_or(KeyringError::Unavailable)?;
    let home = std::path::PathBuf::from(home);
    #[cfg(all(feature = "phase1-conformance", not(test)))]
    {
        let home_metadata = fs::symlink_metadata(&home).map_err(|_| KeyringError::Unavailable)?;
        if home_metadata.file_type().is_symlink()
            || !home_metadata.is_dir()
            || home_metadata.uid() != unsafe { libc::geteuid() }
            || home_metadata.mode() & 0o777 != 0o700
        {
            return Err(KeyringError::Unavailable);
        }
        let mut current = home;
        for component in [".coven", "chat"] {
            current.push(component);
            match fs::create_dir(&current) {
                Ok(()) => fs::set_permissions(&current, fs::Permissions::from_mode(0o700))
                    .map_err(|_| KeyringError::Unavailable)?,
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err(KeyringError::Unavailable),
            }
            let metadata = fs::symlink_metadata(&current).map_err(|_| KeyringError::Unavailable)?;
            if metadata.file_type().is_symlink()
                || !metadata.is_dir()
                || metadata.uid() != unsafe { libc::geteuid() }
                || metadata.mode() & 0o777 != 0o700
            {
                return Err(KeyringError::Unavailable);
            }
        }
        Ok(current.join("credential-mutation.lock"))
    }
    #[cfg(any(not(feature = "phase1-conformance"), test))]
    credential_lock_path_for_root(&default_credential_lock_root(&home))
}

#[cfg(unix)]
fn acquire_mutation_lock() -> Result<CredentialMutationGuard, KeyringError> {
    acquire_mutation_lock_with_timeout(CREDENTIAL_LOCK_TIMEOUT)
}

#[cfg(unix)]
fn acquire_mutation_lock_with_timeout(
    timeout: Duration,
) -> Result<CredentialMutationGuard, KeyringError> {
    acquire_mutation_lock_with_timeout_at(timeout, None)
}

#[cfg(unix)]
fn acquire_mutation_lock_with_timeout_at(
    timeout: Duration,
    explicit_root: Option<&std::path::Path>,
) -> Result<CredentialMutationGuard, KeyringError> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

    let deadline = Instant::now() + timeout;
    let process = loop {
        match mutation_lock().try_lock() {
            Ok(guard) => break guard,
            Err(std::sync::TryLockError::Poisoned(_)) => return Err(KeyringError::Failure),
            Err(std::sync::TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(std::sync::TryLockError::WouldBlock) => return Err(KeyringError::Unavailable),
        }
    };
    let path = match explicit_root {
        Some(root) => credential_lock_path_for_root(root)?,
        None => credential_lock_path()?,
    };
    let file = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
        .map_err(|_| KeyringError::Unavailable)?;
    let metadata = file.metadata().map_err(|_| KeyringError::Unavailable)?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(KeyringError::Unavailable);
    }
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
        .map_err(|_| KeyringError::Unavailable)?;
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => break,
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                ) && Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => return Err(KeyringError::Unavailable),
        }
    }
    Ok(CredentialMutationGuard {
        _process: process,
        _file: file,
    })
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy)]
enum WindowsMutexWait {
    Acquired,
    Abandoned,
    TimedOut,
    Failed,
}

#[cfg(any(windows, test))]
trait WindowsMutexApi {
    type Handle;

    fn create(&self, name: &str) -> Result<Self::Handle, KeyringError>;
    fn wait(&self, handle: &Self::Handle) -> WindowsMutexWait;
    fn release(&self, handle: &Self::Handle);
    fn close(&self, handle: Self::Handle);
}

#[cfg(any(windows, test))]
struct WindowsMutexGuard<'a, Api: WindowsMutexApi> {
    api: &'a Api,
    handle: Option<Api::Handle>,
    _scope: PhantomData<&'a ()>,
}

#[cfg(any(windows, test))]
impl<Api: WindowsMutexApi> Drop for WindowsMutexGuard<'_, Api> {
    fn drop(&mut self) {
        if let Some(handle) = self.handle.take() {
            self.api.release(&handle);
            self.api.close(handle);
        }
    }
}

#[cfg(any(windows, test))]
fn acquire_windows_mutex<'a, Api: WindowsMutexApi>(
    api: &'a Api,
    name: &str,
) -> Result<WindowsMutexGuard<'a, Api>, KeyringError> {
    let handle = api.create(name)?;
    match api.wait(&handle) {
        WindowsMutexWait::Acquired | WindowsMutexWait::Abandoned => Ok(WindowsMutexGuard {
            api,
            handle: Some(handle),
            _scope: PhantomData,
        }),
        WindowsMutexWait::TimedOut | WindowsMutexWait::Failed => {
            api.close(handle);
            Err(KeyringError::Unavailable)
        }
    }
}

#[cfg(windows)]
struct NativeWindowsMutexApi;

#[cfg(windows)]
struct LegacyWindowsMutexApi;

#[cfg(windows)]
impl WindowsMutexApi for NativeWindowsMutexApi {
    type Handle = windows_sys::Win32::Foundation::HANDLE;

    fn create(&self, name: &str) -> Result<Self::Handle, KeyringError> {
        use std::os::windows::ffi::OsStrExt;

        use windows_sys::Win32::{
            Foundation::{CloseHandle, LocalFree, ERROR_SUCCESS, HANDLE, HLOCAL},
            Security::{
                Authorization::{
                    GetExplicitEntriesFromAclW, GetSecurityInfo, SetEntriesInAclW,
                    EXPLICIT_ACCESS_W, GRANT_ACCESS, SE_KERNEL_OBJECT, TRUSTEE_IS_SID,
                    TRUSTEE_IS_USER,
                },
                EqualSid, GetLengthSid, GetTokenInformation, InitializeSecurityDescriptor,
                SetSecurityDescriptorDacl, SetSecurityDescriptorOwner, TokenUser,
                DACL_SECURITY_INFORMATION, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID,
                SECURITY_ATTRIBUTES, SECURITY_DESCRIPTOR, TOKEN_QUERY, TOKEN_USER,
            },
            System::Threading::{
                CreateMutexW, GetCurrentProcess, OpenProcessToken, MUTEX_ALL_ACCESS,
            },
        };

        struct OwnedHandle(HANDLE);

        impl Drop for OwnedHandle {
            fn drop(&mut self) {
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }

        struct LocalAllocation(HLOCAL);

        impl Drop for LocalAllocation {
            fn drop(&mut self) {
                if !self.0.is_null() {
                    unsafe {
                        LocalFree(self.0);
                    }
                }
            }
        }

        let mut token = std::ptr::null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw mut token) } == 0 {
            return Err(KeyringError::Unavailable);
        }
        let token = OwnedHandle(token);
        let mut token_length = 0;
        unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                std::ptr::null_mut(),
                0,
                &raw mut token_length,
            );
        }
        if token_length < std::mem::size_of::<TOKEN_USER>() as u32 {
            return Err(KeyringError::Unavailable);
        }
        let word_size = std::mem::size_of::<usize>();
        let mut token_buffer = vec![0_usize; (token_length as usize).div_ceil(word_size)];
        if unsafe {
            GetTokenInformation(
                token.0,
                TokenUser,
                token_buffer.as_mut_ptr().cast(),
                token_length,
                &raw mut token_length,
            )
        } == 0
        {
            return Err(KeyringError::Unavailable);
        }
        let current_sid = unsafe { (*(token_buffer.as_ptr().cast::<TOKEN_USER>())).User.Sid };
        let sid_length = unsafe { GetLengthSid(current_sid) };
        if sid_length == 0 {
            return Err(KeyringError::Unavailable);
        }

        let mut wide = std::ffi::OsStr::new(name).encode_wide().collect::<Vec<_>>();
        wide.push(0);

        let mut access = EXPLICIT_ACCESS_W::default();
        access.grfAccessPermissions = MUTEX_ALL_ACCESS;
        access.grfAccessMode = GRANT_ACCESS;
        access.grfInheritance = 0;
        access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
        access.Trustee.TrusteeType = TRUSTEE_IS_USER;
        access.Trustee.ptstrName = current_sid.cast();
        let mut acl = std::ptr::null_mut();
        let acl_status =
            unsafe { SetEntriesInAclW(1, &raw const access, std::ptr::null(), &raw mut acl) };
        let acl_allocation = LocalAllocation(acl.cast());
        if acl_status != ERROR_SUCCESS || acl.is_null() {
            return Err(KeyringError::Unavailable);
        }
        let mut descriptor = SECURITY_DESCRIPTOR::default();
        if unsafe {
            InitializeSecurityDescriptor((&raw mut descriptor).cast(), 1) == 0
                || SetSecurityDescriptorOwner((&raw mut descriptor).cast(), current_sid, 0) == 0
                || SetSecurityDescriptorDacl((&raw mut descriptor).cast(), 1, acl, 0) == 0
        } {
            return Err(KeyringError::Unavailable);
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: (&raw mut descriptor).cast(),
            bInheritHandle: 0,
        };
        let handle = unsafe { CreateMutexW(&raw const attributes, 0, wide.as_ptr()) };
        drop(acl_allocation);
        if handle.is_null() {
            return Err(KeyringError::Unavailable);
        }
        let handle = OwnedHandle(handle);

        let mut owner: PSID = std::ptr::null_mut();
        let mut dacl = std::ptr::null_mut();
        let mut security_descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        let security_status = unsafe {
            GetSecurityInfo(
                handle.0,
                SE_KERNEL_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &raw mut owner,
                std::ptr::null_mut(),
                &raw mut dacl,
                std::ptr::null_mut(),
                &raw mut security_descriptor,
            )
        };
        let descriptor_allocation = LocalAllocation(security_descriptor.cast());
        if security_status != ERROR_SUCCESS
            || owner.is_null()
            || dacl.is_null()
            || security_descriptor.is_null()
            || unsafe { EqualSid(owner, current_sid) } == 0
        {
            return Err(KeyringError::Unavailable);
        }
        let mut entry_count = 0;
        let mut entries = std::ptr::null_mut();
        let entries_status =
            unsafe { GetExplicitEntriesFromAclW(dacl, &raw mut entry_count, &raw mut entries) };
        let entries_allocation = LocalAllocation(entries.cast());
        if entries_status != ERROR_SUCCESS || entry_count != 1 || entries.is_null() {
            return Err(KeyringError::Unavailable);
        }
        let entry = unsafe { &*entries };
        // Reconstructed SID ACEs may report TRUSTEE_IS_UNKNOWN; the exact SID
        // comparison below is the authoritative trustee identity check.
        if entry.grfAccessPermissions != MUTEX_ALL_ACCESS
            || entry.grfAccessMode != GRANT_ACCESS
            || entry.grfInheritance != 0
            || !entry.Trustee.pMultipleTrustee.is_null()
            || entry.Trustee.TrusteeForm != TRUSTEE_IS_SID
            || entry.Trustee.ptstrName.is_null()
            || unsafe { EqualSid(entry.Trustee.ptstrName.cast(), current_sid) } == 0
        {
            return Err(KeyringError::Unavailable);
        }
        drop(entries_allocation);
        drop(descriptor_allocation);

        let raw = handle.0;
        std::mem::forget(handle);
        Ok(raw)
    }

    fn wait(&self, handle: &Self::Handle) -> WindowsMutexWait {
        use windows_sys::Win32::{
            Foundation::{WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT},
            System::Threading::WaitForSingleObject,
        };

        match unsafe { WaitForSingleObject(*handle, 5_000) } {
            WAIT_OBJECT_0 => WindowsMutexWait::Acquired,
            WAIT_ABANDONED => WindowsMutexWait::Abandoned,
            WAIT_TIMEOUT => WindowsMutexWait::TimedOut,
            _ => WindowsMutexWait::Failed,
        }
    }

    fn release(&self, handle: &Self::Handle) {
        unsafe {
            windows_sys::Win32::System::Threading::ReleaseMutex(*handle);
        }
    }

    fn close(&self, handle: Self::Handle) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(handle);
        }
    }
}

#[cfg(windows)]
impl WindowsMutexApi for LegacyWindowsMutexApi {
    type Handle = windows_sys::Win32::Foundation::HANDLE;

    fn create(&self, name: &str) -> Result<Self::Handle, KeyringError> {
        use std::os::windows::ffi::OsStrExt;

        let mut wide = std::ffi::OsStr::new(name).encode_wide().collect::<Vec<_>>();
        wide.push(0);
        let handle = unsafe {
            windows_sys::Win32::System::Threading::CreateMutexW(std::ptr::null(), 0, wide.as_ptr())
        };
        if handle.is_null() {
            Err(KeyringError::Unavailable)
        } else {
            Ok(handle)
        }
    }

    fn wait(&self, handle: &Self::Handle) -> WindowsMutexWait {
        use windows_sys::Win32::Foundation::{WAIT_ABANDONED, WAIT_OBJECT_0, WAIT_TIMEOUT};

        match unsafe { windows_sys::Win32::System::Threading::WaitForSingleObject(*handle, 5_000) }
        {
            WAIT_OBJECT_0 => WindowsMutexWait::Acquired,
            WAIT_ABANDONED => WindowsMutexWait::Abandoned,
            WAIT_TIMEOUT => WindowsMutexWait::TimedOut,
            _ => WindowsMutexWait::Failed,
        }
    }

    fn release(&self, handle: &Self::Handle) {
        unsafe {
            windows_sys::Win32::System::Threading::ReleaseMutex(*handle);
        }
    }

    fn close(&self, handle: Self::Handle) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(handle);
        }
    }
}

#[cfg(windows)]
struct CredentialMutationGuard {
    _global: WindowsMutexGuard<'static, NativeWindowsMutexApi>,
    _legacy: WindowsMutexGuard<'static, LegacyWindowsMutexApi>,
}

#[cfg(windows)]
fn acquire_mutation_lock() -> Result<CredentialMutationGuard, KeyringError> {
    static GLOBAL_MUTEX: NativeWindowsMutexApi = NativeWindowsMutexApi;
    static LEGACY_MUTEX: LegacyWindowsMutexApi = LegacyWindowsMutexApi;

    let identity =
        crate::cave::current_windows_user_identity().map_err(|_| KeyringError::Unavailable)?;
    let global = acquire_windows_mutex(&GLOBAL_MUTEX, &windows_mutex_name(&identity))?;
    let legacy = acquire_windows_mutex(&LEGACY_MUTEX, &legacy_windows_mutex_name(&identity))?;
    Ok(CredentialMutationGuard {
        _global: global,
        _legacy: legacy,
    })
}

#[cfg(any(windows, test))]
fn windows_mutex_name(identity: &str) -> String {
    let scope = format!("{SERVICE}:{CREDENTIAL_ACCOUNT_PREFIX}:{identity}");
    format!(
        "Global\\OpenCoven.Chat.{:x}",
        Sha256::digest(scope.as_bytes())
    )
}

#[cfg(any(windows, test))]
fn legacy_windows_mutex_name(identity: &str) -> String {
    windows_mutex_name(identity).replacen("Global\\", "Local\\", 1)
}

#[cfg(all(not(unix), not(windows)))]
fn acquire_mutation_lock() -> Result<(), KeyringError> {
    Err(KeyringError::Unavailable)
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WindowsPersistenceAction {
    Accept,
    Migrate,
    Reject,
}

#[cfg(any(windows, test))]
fn windows_persistence_action(value: Option<&str>) -> WindowsPersistenceAction {
    match value {
        Some("Local") => WindowsPersistenceAction::Accept,
        Some("Enterprise") => WindowsPersistenceAction::Migrate,
        _ => WindowsPersistenceAction::Reject,
    }
}

#[cfg(windows)]
fn ensure_windows_local_persistence(entry: &Entry, value: &[u8]) -> Result<(), KeyringError> {
    let attributes = entry.get_attributes().map_err(map_keyring_error)?;
    match windows_persistence_action(attributes.get("persistence").map(String::as_str)) {
        WindowsPersistenceAction::Accept => Ok(()),
        WindowsPersistenceAction::Migrate => entry.set_secret(value).map_err(map_keyring_error),
        WindowsPersistenceAction::Reject => Err(KeyringError::Unavailable),
    }
}

#[cfg(not(windows))]
fn ensure_windows_local_persistence(_entry: &Entry, _value: &[u8]) -> Result<(), KeyringError> {
    Ok(())
}

#[cfg(any(windows, test))]
fn decode_legacy_windows_password(value: &[u8]) -> Result<Zeroizing<Vec<u8>>, KeyringError> {
    if value.is_empty()
        || !value.len().is_multiple_of(2)
        || value.len() > MAX_CREDENTIAL_RECORD_BYTES * 2
    {
        return Err(KeyringError::Failure);
    }
    let units = Zeroizing::new(
        value
            .chunks_exact(2)
            .map(|unit| u16::from_le_bytes([unit[0], unit[1]]))
            .collect::<Vec<_>>(),
    );
    let decoded =
        Zeroizing::new(String::from_utf16(units.as_slice()).map_err(|_| KeyringError::Failure)?);
    Ok(Zeroizing::new(decoded.as_bytes().to_vec()))
}

fn parse_installation_id_entry(entry: &Entry, value: &[u8]) -> Result<String, KeyringError> {
    if let Ok(installation_id) = std::str::from_utf8(value) {
        if validate_installation_id(installation_id).is_ok() {
            ensure_windows_local_persistence(entry, value)?;
            return Ok(installation_id.to_owned());
        }
    }

    #[cfg(windows)]
    {
        let decoded = decode_legacy_windows_password(value)?;
        let installation_id =
            std::str::from_utf8(decoded.as_slice()).map_err(|_| KeyringError::Failure)?;
        validate_installation_id(installation_id)?;
        entry
            .set_secret(decoded.as_slice())
            .map_err(map_keyring_error)?;
        ensure_windows_local_persistence(entry, decoded.as_slice())?;
        return Ok(installation_id.to_owned());
    }

    #[cfg(not(windows))]
    Err(KeyringError::Failure)
}

fn parse_stored_credential_entry(
    entry: &Entry,
    value: &[u8],
) -> Result<StoredCredential, KeyringError> {
    if let Ok(stored) = parse_stored_credential(value) {
        ensure_windows_local_persistence(entry, value)?;
        return Ok(stored);
    }

    #[cfg(windows)]
    {
        let decoded = decode_legacy_windows_password(value)?;
        let stored = parse_stored_credential(decoded.as_slice())?;
        entry
            .set_secret(decoded.as_slice())
            .map_err(map_keyring_error)?;
        ensure_windows_local_persistence(entry, decoded.as_slice())?;
        return Ok(stored);
    }

    #[cfg(not(windows))]
    Err(KeyringError::Failure)
}

impl CredentialCustody for NativeKeyring {
    fn installation_id(&self) -> Result<String, KeyringError> {
        #[cfg(feature = "phase1-conformance")]
        self.reject_provider_if_configured()?;
        #[cfg(feature = "phase1-conformance")]
        let service = self.service_name();
        #[cfg(not(feature = "phase1-conformance"))]
        let service = SERVICE;
        let _guard = acquire_mutation_lock()?;
        let entry = Self::installation_id_entry_for_service(service)?;
        match entry.get_secret() {
            Ok(bytes) => {
                let bytes = Zeroizing::new(bytes);
                parse_installation_id_entry(&entry, bytes.as_slice())
            }
            Err(KeyringBackendError::NoEntry) => {
                let installation_id = Uuid::new_v4().to_string();
                entry
                    .set_secret(installation_id.as_bytes())
                    .map_err(map_keyring_error)?;
                ensure_windows_local_persistence(&entry, installation_id.as_bytes())?;
                Ok(installation_id)
            }
            Err(error) => Err(map_keyring_error(error)),
        }
    }

    fn read(&self, instance_id: &str, origin: &str) -> Result<Credential, KeyringError> {
        match self.read_for_pairing_update(instance_id, origin)? {
            CredentialSlot::Current(credential) => Ok(credential),
            CredentialSlot::Missing | CredentialSlot::Stale(_) => Err(KeyringError::NotFound),
        }
    }

    fn read_for_pairing_update(
        &self,
        instance_id: &str,
        origin: &str,
    ) -> Result<CredentialSlot, KeyringError> {
        #[cfg(feature = "phase1-conformance")]
        self.reject_provider_if_configured()?;
        #[cfg(feature = "phase1-conformance")]
        let service = self.service_name();
        #[cfg(not(feature = "phase1-conformance"))]
        let service = SERVICE;
        validate_credential_origin(origin)?;
        let _guard = acquire_mutation_lock()?;
        let entry = Self::credential_entry_for_service(service, instance_id)?;
        let raw = entry.get_secret();
        let stored = match raw {
            Ok(raw) => {
                let raw = Zeroizing::new(raw);
                parse_stored_credential_entry(&entry, raw.as_slice())?
            }
            Err(KeyringBackendError::NoEntry) => return Ok(CredentialSlot::Missing),
            Err(error) => return Err(map_keyring_error(error)),
        };
        let mut stored = stored;
        let credential = Credential {
            bearer: std::mem::take(&mut stored.bearer),
            credential_id: std::mem::take(&mut stored.credential_id),
            origin: std::mem::take(&mut stored.origin),
        };
        if credential.origin == origin {
            Ok(CredentialSlot::Current(credential))
        } else {
            Ok(CredentialSlot::Stale(credential))
        }
    }

    fn store_if_current(
        &self,
        instance_id: &str,
        origin: &str,
        expected_credential: Option<&Credential>,
        bearer: &str,
        credential_id: &str,
    ) -> Result<bool, KeyringError> {
        #[cfg(feature = "phase1-conformance")]
        {
            self.reject_provider_if_configured()?;
            self.require_prepared_instance(instance_id)?;
        }
        #[cfg(feature = "phase1-conformance")]
        let service = self.service_name();
        #[cfg(not(feature = "phase1-conformance"))]
        let service = SERVICE;
        validate_credential_origin(origin)?;
        if let Some(expected_credential) = expected_credential {
            validate_credential_origin(&expected_credential.origin)?;
        }
        if bearer.is_empty() || credential_id.is_empty() {
            return Err(KeyringError::Failure);
        }
        let _guard = acquire_mutation_lock()?;
        let entry = Self::credential_entry_for_service(service, instance_id)?;
        let current = match entry.get_secret() {
            Ok(value) => {
                let value = Zeroizing::new(value);
                Some(parse_stored_credential_entry(&entry, value.as_slice())?)
            }
            Err(KeyringBackendError::NoEntry) => None,
            Err(error) => return Err(map_keyring_error(error)),
        };
        let matches_expected = match (current.as_ref(), expected_credential) {
            (None, None) => true,
            (Some(stored), Some(expected)) => {
                stored.origin == origin
                    && stored.bearer == expected.bearer
                    && stored.credential_id == expected.credential_id
                    && stored.origin == expected.origin
            }
            _ => false,
        };
        if !matches_expected {
            return Ok(false);
        }
        let value = Zeroizing::new(
            serde_json::to_vec(&StoredCredential {
                bearer: bearer.to_owned(),
                credential_id: credential_id.to_owned(),
                origin: origin.to_owned(),
            })
            .map_err(|_| KeyringError::Failure)?,
        );
        entry
            .set_secret(value.as_slice())
            .map_err(map_keyring_error)
            .and_then(|()| ensure_windows_local_persistence(&entry, value.as_slice()))
            .map(|()| true)
    }

    fn replace_stale_if_current(
        &self,
        instance_id: &str,
        origin: &str,
        expected_stale_credential: &Credential,
        bearer: &str,
        credential_id: &str,
    ) -> Result<bool, KeyringError> {
        #[cfg(feature = "phase1-conformance")]
        {
            self.reject_provider_if_configured()?;
            self.require_prepared_instance(instance_id)?;
        }
        #[cfg(feature = "phase1-conformance")]
        let service = self.service_name();
        #[cfg(not(feature = "phase1-conformance"))]
        let service = SERVICE;
        validate_credential_origin(origin)?;
        validate_credential_origin(&expected_stale_credential.origin)?;
        if bearer.is_empty()
            || credential_id.is_empty()
            || expected_stale_credential.origin == origin
        {
            return Err(KeyringError::Failure);
        }
        let _guard = acquire_mutation_lock()?;
        let entry = Self::credential_entry_for_service(service, instance_id)?;
        let stored = match entry.get_secret() {
            Ok(value) => {
                let value = Zeroizing::new(value);
                parse_stored_credential_entry(&entry, value.as_slice())?
            }
            Err(KeyringBackendError::NoEntry) => return Ok(false),
            Err(error) => return Err(map_keyring_error(error)),
        };
        if stored.origin == origin
            || stored.bearer != expected_stale_credential.bearer
            || stored.credential_id != expected_stale_credential.credential_id
            || stored.origin != expected_stale_credential.origin
        {
            return Ok(false);
        }
        let replacement = Zeroizing::new(
            serde_json::to_vec(&StoredCredential {
                bearer: bearer.to_owned(),
                credential_id: credential_id.to_owned(),
                origin: origin.to_owned(),
            })
            .map_err(|_| KeyringError::Failure)?,
        );
        entry
            .set_secret(replacement.as_slice())
            .map_err(map_keyring_error)
            .and_then(|()| ensure_windows_local_persistence(&entry, replacement.as_slice()))
            .map(|()| true)
    }

    fn delete_if_matches(
        &self,
        instance_id: &str,
        origin: &str,
        expected_credential: &Credential,
    ) -> Result<bool, KeyringError> {
        #[cfg(feature = "phase1-conformance")]
        self.reject_provider_if_configured()?;
        #[cfg(feature = "phase1-conformance")]
        let service = self.service_name();
        #[cfg(not(feature = "phase1-conformance"))]
        let service = SERVICE;
        validate_credential_origin(origin)?;
        validate_credential_origin(&expected_credential.origin)?;
        let _guard = acquire_mutation_lock()?;
        let entry = Self::credential_entry_for_service(service, instance_id)?;
        let stored = match entry.get_secret() {
            Ok(value) => {
                let value = Zeroizing::new(value);
                parse_stored_credential_entry(&entry, value.as_slice())?
            }
            Err(KeyringBackendError::NoEntry) => return Ok(false),
            Err(error) => return Err(map_keyring_error(error)),
        };
        if stored.origin != origin
            || stored.bearer != expected_credential.bearer
            || stored.credential_id != expected_credential.credential_id
            || stored.origin != expected_credential.origin
        {
            return Ok(false);
        }
        match entry.delete_credential() {
            Ok(()) | Err(KeyringBackendError::NoEntry) => Ok(true),
            Err(error) => Err(map_keyring_error(error)),
        }
    }
}

pub(crate) fn validate_installation_id(installation_id: &str) -> Result<(), KeyringError> {
    if installation_id.len() != 36 {
        return Err(KeyringError::Failure);
    }
    let parsed = Uuid::parse_str(installation_id).map_err(|_| KeyringError::Failure)?;
    if parsed.get_version() != Some(Version::Random)
        || parsed.get_variant() != Variant::RFC4122
        || parsed.to_string() != installation_id
    {
        return Err(KeyringError::Failure);
    }
    Ok(())
}

fn parse_stored_credential(raw: impl AsRef<[u8]>) -> Result<StoredCredential, KeyringError> {
    let raw = raw.as_ref();
    if raw.len() > MAX_CREDENTIAL_RECORD_BYTES {
        return Err(KeyringError::Failure);
    }
    let stored =
        serde_json::from_slice::<StoredCredential>(raw).map_err(|_| KeyringError::Failure)?;
    if stored.bearer.is_empty() || stored.credential_id.is_empty() || stored.origin.is_empty() {
        return Err(KeyringError::Failure);
    }
    validate_credential_origin(&stored.origin)?;
    Ok(stored)
}

pub(crate) fn validate_credential_origin(origin: &str) -> Result<(), KeyringError> {
    let url = Url::parse(origin).map_err(|_| KeyringError::Failure)?;
    let is_loopback = match url.host() {
        Some(Host::Ipv4(address)) => address.is_loopback(),
        Some(Host::Ipv6(address)) => address.is_loopback(),
        Some(Host::Domain(_)) | None => false,
    };
    if !is_loopback
        || url.scheme() != "http"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
        || url.as_str() != origin
    {
        return Err(KeyringError::Failure);
    }
    Ok(())
}

impl NativeKeyring {
    fn entry_for(service: &str, account: &str) -> Result<Entry, KeyringError> {
        if STORE_INITIALIZED.get().is_none() {
            if !initialize_store() {
                return Err(KeyringError::Unavailable);
            }
            let _ = STORE_INITIALIZED.set(());
        }
        #[cfg(windows)]
        {
            return Entry::new_with_modifiers(
                service,
                account,
                &std::collections::HashMap::from([("persistence", "Local")]),
            )
            .map_err(map_keyring_error);
        }
        #[cfg(not(windows))]
        {
            Entry::new(service, account).map_err(map_keyring_error)
        }
    }

    fn installation_id_entry_for_service(service: &str) -> Result<Entry, KeyringError> {
        Self::entry_for(service, INSTALLATION_ID_ACCOUNT)
    }

    fn credential_entry_for_service(
        service: &str,
        instance_id: &str,
    ) -> Result<Entry, KeyringError> {
        if instance_id.is_empty() || instance_id.len() > 128 {
            return Err(KeyringError::Failure);
        }
        Self::entry_for(
            service,
            &format!("{CREDENTIAL_ACCOUNT_PREFIX}:{instance_id}"),
        )
    }

    #[cfg(feature = "phase1-conformance")]
    fn conformance_entry_present(entry: &Entry) -> Result<bool, KeyringError> {
        match entry.get_secret() {
            Ok(mut value) => {
                value.zeroize();
                Ok(true)
            }
            Err(KeyringBackendError::NoEntry) => Ok(false),
            Err(error) => Err(map_keyring_error(error)),
        }
    }
}

#[cfg(target_os = "macos")]
const fn native_keyring_backend() -> &'static str {
    "macos-keychain"
}

#[cfg(target_os = "linux")]
const fn native_keyring_backend() -> &'static str {
    "linux-keyring"
}

#[cfg(target_os = "windows")]
const fn native_keyring_backend() -> &'static str {
    "windows-credential-manager"
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
const fn native_keyring_backend() -> &'static str {
    "unsupported"
}

fn initialize_store() -> bool {
    #[cfg(target_os = "macos")]
    {
        return apple_native_keyring_store::keychain::Store::new()
            .map(|store| keyring_core::set_default_store(store))
            .is_ok();
    }
    #[cfg(target_os = "linux")]
    {
        return zbus_secret_service_keyring_store::Store::new()
            .map(|store| keyring_core::set_default_store(store))
            .is_ok();
    }
    #[cfg(target_os = "windows")]
    {
        return windows_native_keyring_store::Store::new()
            .map(|store| keyring_core::set_default_store(store))
            .is_ok();
    }
    #[allow(unreachable_code)]
    false
}

fn map_keyring_error(error: KeyringBackendError) -> KeyringError {
    match error {
        KeyringBackendError::NoEntry => KeyringError::NotFound,
        KeyringBackendError::NoDefaultStore
        | KeyringBackendError::NoStorageAccess(_)
        | KeyringBackendError::PlatformFailure(_) => KeyringError::Unavailable,
        KeyringBackendError::BadEncoding(mut bytes)
        | KeyringBackendError::BadDataFormat(mut bytes, _) => {
            bytes.zeroize();
            KeyringError::Failure
        }
        _ => KeyringError::Failure,
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::{acquire_mutation_lock_with_timeout_at, default_credential_lock_root};
    use super::{
        acquire_windows_mutex, decode_legacy_windows_password, legacy_windows_mutex_name,
        parse_stored_credential, validate_installation_id, windows_mutex_name,
        windows_persistence_action, KeyringError, WindowsMutexApi, WindowsMutexWait,
        WindowsPersistenceAction, MAX_CREDENTIAL_RECORD_BYTES,
    };

    #[cfg(feature = "phase1-conformance")]
    #[test]
    fn conformance_storage_gate_accepts_only_the_native_prepared_uuid() {
        const PREPARED: &str = "00000000-0000-4000-8000-000000000001";
        const DIFFERENT: &str = "00000000-0000-4000-8000-000000000002";
        let keyring = super::NativeKeyring::for_conformance();
        assert!(keyring.require_prepared_instance(PREPARED).is_err());
        *keyring.prepared_instance.lock().unwrap() = Some(PREPARED.to_owned());
        assert!(keyring.require_prepared_instance(PREPARED).is_ok());
        assert!(keyring.require_prepared_instance(DIFFERENT).is_err());
        assert!(keyring
            .require_prepared_instance("installation-id-v1")
            .is_err());
    }

    #[cfg(feature = "phase1-conformance")]
    #[test]
    fn production_keyring_state_rejects_caller_selected_accounts() {
        let keyring = super::NativeKeyring::for_conformance();
        assert!(matches!(
            keyring.conformance_state(&["00000000-0000-4000-8000-000000000001".to_owned()]),
            Err(KeyringError::Failure)
        ));
    }

    #[cfg(feature = "phase1-conformance")]
    #[test]
    fn phase1_keyring_service_never_falls_back_to_production() {
        assert!(matches!(
            super::conformance_service_name_from_value(None),
            Err(KeyringError::Unavailable)
        ));
        assert!(matches!(
            super::conformance_service_name_from_value(Some("ai.opencoven.chat")),
            Err(KeyringError::Unavailable)
        ));
        assert_eq!(
            super::conformance_service_name_from_value(Some(
                "ai.opencoven.chat.phase1.0123456789abcdef0123456789abcdef"
            ))
            .unwrap(),
            "ai.opencoven.chat.phase1.0123456789abcdef0123456789abcdef"
        );
    }

    #[test]
    fn accepts_canonical_lowercase_v4_installation_ids() {
        assert!(validate_installation_id("0b59fec4-5d8e-4d5c-894d-39fcb5f3eef7").is_ok());
    }

    #[test]
    fn rejects_malformed_installation_ids() {
        for installation_id in [
            "",
            "0b59fec4-5d8e-4d5c-894d-39fcb5f3eef",
            "0b59fec4-5d8e-4d5c-894d-39fcb5f3eef70",
            "0B59FEC4-5D8E-4D5C-894D-39FCB5F3EEF7",
            "0b59fec45d8e4d5c894d39fcb5f3eef7",
            "0b59fec4-5d8e-4d5c-794d-39fcb5f3eef7",
        ] {
            assert!(matches!(
                validate_installation_id(installation_id),
                Err(KeyringError::Failure)
            ));
        }
    }

    #[test]
    fn rejects_non_v4_installation_ids() {
        for installation_id in [
            "f47ac10b-58cc-11cf-8f0b-08002be10318",
            "00000000-0000-0000-0000-000000000000",
        ] {
            assert!(matches!(
                validate_installation_id(installation_id),
                Err(KeyringError::Failure)
            ));
        }
    }

    #[test]
    fn corrupt_stored_credentials_fail_closed() {
        for stored in [
            "not-json",
            r#"{"bearer":"","credential_id":"credential","origin":"http://127.0.0.1/"}"#,
            r#"{"bearer":"bearer","credential_id":"","origin":"http://127.0.0.1/"}"#,
            r#"{"bearer":"bearer","credential_id":"credential","origin":""}"#,
            r#"{"bearer":"bearer","credential_id":"credential","origin":"https://127.0.0.1/"}"#,
            r#"{"bearer":"bearer","credential_id":"credential","origin":"http://example.test/"}"#,
            r#"{"bearer":"bearer","credential_id":"credential","origin":"http://user@127.0.0.1/"}"#,
            r#"{"bearer":"bearer","credential_id":"credential","origin":"http://127.0.0.1/path"}"#,
        ] {
            assert!(matches!(
                parse_stored_credential(stored),
                Err(KeyringError::Failure)
            ));
        }
    }

    #[cfg(unix)]
    #[test]
    fn unix_credential_lock_contention_is_bounded() {
        use std::{
            fs,
            path::Path,
            time::{Duration, Instant},
        };

        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join("keyring-lock-tests")
            .join(uuid::Uuid::new_v4().to_string());
        let operator_lock = default_credential_lock_root(&std::path::PathBuf::from(
            std::env::var_os("HOME").unwrap_or_default(),
        ))
        .join("credential-mutation.lock");
        assert_ne!(Some(root.as_path()), operator_lock.parent());
        let first = acquire_mutation_lock_with_timeout_at(Duration::from_secs(1), Some(&root))
            .expect("first credential lock");
        let started = Instant::now();
        let contender_root = root.clone();
        let contender = std::thread::spawn(move || {
            matches!(
                acquire_mutation_lock_with_timeout_at(
                    Duration::from_millis(50),
                    Some(&contender_root)
                ),
                Err(KeyringError::Unavailable)
            )
        });
        assert!(contender.join().expect("contender thread"));
        assert!(started.elapsed() < Duration::from_secs(1));
        drop(first);
        fs::remove_dir_all(root).expect("explicit lock root cleanup");
        assert_eq!(
            default_credential_lock_root(Path::new("/operator/home")),
            Path::new("/operator/home").join(".coven").join("chat")
        );
    }

    #[test]
    fn windows_mutex_is_global_and_user_scoped() {
        let first = windows_mutex_name("S-1-5-21-test-user");
        let second = windows_mutex_name("S-1-5-21-other-user");
        let legacy = legacy_windows_mutex_name("S-1-5-21-test-user");

        assert!(first.starts_with("Global\\OpenCoven.Chat."));
        assert!(legacy.starts_with("Local\\OpenCoven.Chat."));
        assert_eq!(
            first.strip_prefix("Global\\"),
            legacy.strip_prefix("Local\\")
        );
        assert_ne!(first, second);
        assert!(!first.contains("S-1-5-21-test-user"));
    }

    #[test]
    fn windows_credentials_require_local_persistence() {
        assert_eq!(
            windows_persistence_action(Some("Local")),
            WindowsPersistenceAction::Accept
        );
        assert_eq!(
            windows_persistence_action(Some("Enterprise")),
            WindowsPersistenceAction::Migrate
        );
        for value in [None, Some("Session"), Some("unknown")] {
            assert_eq!(
                windows_persistence_action(value),
                WindowsPersistenceAction::Reject
            );
        }
    }

    #[test]
    fn windows_legacy_password_bytes_decode_for_validated_migration() {
        let credential =
            r#"{"bearer":"secret","credential_id":"credential","origin":"http://127.0.0.1/"}"#;
        let legacy = credential
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        let decoded = decode_legacy_windows_password(&legacy).expect("legacy password");

        let stored = parse_stored_credential(decoded.as_slice()).expect("stored credential");
        assert_eq!(stored.bearer, "secret");
        assert_eq!(stored.credential_id, "credential");
        assert_eq!(stored.origin, "http://127.0.0.1/");
    }

    #[test]
    fn windows_legacy_password_decode_fails_closed() {
        for value in [
            Vec::new(),
            vec![b'a'],
            vec![0x00, 0xd8],
            vec![0; MAX_CREDENTIAL_RECORD_BYTES * 2 + 2],
        ] {
            assert!(matches!(
                decode_legacy_windows_password(&value),
                Err(KeyringError::Failure)
            ));
        }
    }

    #[cfg(feature = "phase1-conformance")]
    #[test]
    fn missing_keychain_trust_preset_rejects_before_provider_access() {
        let keyring = super::NativeKeyring::with_provider_preset(
            super::NativeProviderPreset::MissingKeychainTrust,
        );

        assert!(matches!(
            super::CredentialCustody::installation_id(&keyring),
            Err(KeyringError::Unavailable)
        ));
    }

    #[test]
    fn windows_mutex_accepts_abandonment_and_releases_its_handle() {
        let mutex = FakeWindowsMutex::with_wait(WindowsMutexWait::Abandoned);
        {
            let _guard = acquire_windows_mutex(&mutex, "Global\\OpenCoven.Chat.test").unwrap();
            assert_eq!(mutex.wait_calls(), 1);
        }
        assert_eq!(mutex.release_calls(), 1);
        assert_eq!(mutex.close_calls(), 1);
    }

    #[test]
    fn windows_mutex_serializes_contenders_and_releases_after_each_guard() {
        let mutex = FakeWindowsMutex::with_wait(WindowsMutexWait::Acquired);
        {
            let _first = acquire_windows_mutex(&mutex, "Global\\OpenCoven.Chat.test").unwrap();
            assert_eq!(mutex.wait_calls(), 1);
            assert!(matches!(
                acquire_windows_mutex(&mutex, "Global\\OpenCoven.Chat.test"),
                Err(KeyringError::Unavailable)
            ));
            assert_eq!(mutex.release_calls(), 0);
        }
        {
            let _second = acquire_windows_mutex(&mutex, "Global\\OpenCoven.Chat.test").unwrap();
            assert_eq!(mutex.wait_calls(), 3);
        }
        assert_eq!(mutex.release_calls(), 2);
        assert_eq!(mutex.close_calls(), 3);
    }

    #[test]
    fn windows_mutex_fails_closed_on_timeout_or_api_failure() {
        for wait in [WindowsMutexWait::TimedOut, WindowsMutexWait::Failed] {
            let mutex = FakeWindowsMutex::with_wait(wait);
            assert!(matches!(
                acquire_windows_mutex(&mutex, "Global\\OpenCoven.Chat.test"),
                Err(KeyringError::Unavailable)
            ));
            assert_eq!(mutex.release_calls(), 0);
            assert_eq!(mutex.close_calls(), 1);
        }
    }

    struct FakeWindowsMutex {
        wait: WindowsMutexWait,
        waits: std::sync::atomic::AtomicUsize,
        releases: std::sync::atomic::AtomicUsize,
        closes: std::sync::atomic::AtomicUsize,
        held: std::sync::atomic::AtomicBool,
    }

    impl FakeWindowsMutex {
        fn with_wait(wait: WindowsMutexWait) -> Self {
            Self {
                wait,
                waits: std::sync::atomic::AtomicUsize::new(0),
                releases: std::sync::atomic::AtomicUsize::new(0),
                closes: std::sync::atomic::AtomicUsize::new(0),
                held: std::sync::atomic::AtomicBool::new(false),
            }
        }

        fn wait_calls(&self) -> usize {
            self.waits.load(std::sync::atomic::Ordering::SeqCst)
        }

        fn release_calls(&self) -> usize {
            self.releases.load(std::sync::atomic::Ordering::SeqCst)
        }

        fn close_calls(&self) -> usize {
            self.closes.load(std::sync::atomic::Ordering::SeqCst)
        }
    }

    impl WindowsMutexApi for FakeWindowsMutex {
        type Handle = ();

        fn create(&self, _name: &str) -> Result<Self::Handle, KeyringError> {
            Ok(())
        }

        fn wait(&self, _handle: &Self::Handle) -> WindowsMutexWait {
            self.waits.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            if matches!(self.wait, WindowsMutexWait::Acquired)
                && self.held.swap(true, std::sync::atomic::Ordering::SeqCst)
            {
                WindowsMutexWait::TimedOut
            } else {
                self.wait
            }
        }

        fn release(&self, _handle: &Self::Handle) {
            self.releases
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            self.held.store(false, std::sync::atomic::Ordering::SeqCst);
        }

        fn close(&self, _handle: Self::Handle) {
            self.closes
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        }
    }
}
