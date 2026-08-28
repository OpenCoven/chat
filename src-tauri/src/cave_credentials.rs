use std::sync::OnceLock;

use keyring_core::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use uuid::{Uuid, Version};
use zeroize::{Zeroize, Zeroizing};

#[cfg(windows)]
use crate::credential_lock::{windows_persistence_action, WindowsPersistenceAction};
use crate::{
    credential_lock::CredentialMutationLock,
    sdk_diagnostics::{DiagnosticCode, NativeError},
};

const INSTALLATION_ACCOUNT: &str = "installation-id-v1";
const CREDENTIAL_ACCOUNT_PREFIX: &str = "cave-credential-v1:";
const MAX_CREDENTIAL_RECORD_BYTES: usize = 4 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialStoreAvailability {
    Available,
    PlatformUnavailable,
    Unavailable,
}

struct ZeroizingBuffer {
    value: Option<Vec<u8>>,
    #[cfg(test)]
    observer: Option<std::sync::Arc<ZeroizeTestObserver>>,
}

impl ZeroizingBuffer {
    fn new(value: Vec<u8>) -> Self {
        Self {
            value: Some(value),
            #[cfg(test)]
            observer: current_zeroize_test_observer(),
        }
    }

    fn as_slice(&self) -> &[u8] {
        self.value.as_deref().unwrap_or_default()
    }
}

impl Drop for ZeroizingBuffer {
    fn drop(&mut self) {
        if let Some(value) = self.value.as_mut() {
            value.as_mut_slice().zeroize();
            #[cfg(test)]
            if let Some(observer) = &self.observer {
                observer.observe(value);
            }
            value.clear();
        }
    }
}

struct ZeroizingText {
    value: Option<String>,
    #[cfg(test)]
    observer: Option<std::sync::Arc<ZeroizeTestObserver>>,
}

impl ZeroizingText {
    fn into_bytes(mut self) -> Vec<u8> {
        self.value.take().unwrap_or_default().into_bytes()
    }
}

impl<'de> Deserialize<'de> for ZeroizingText {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Ok(Self {
            value: Some(String::deserialize(deserializer)?),
            #[cfg(test)]
            observer: current_zeroize_test_observer(),
        })
    }
}

impl Drop for ZeroizingText {
    fn drop(&mut self) {
        if let Some(value) = self.value.as_mut() {
            // SAFETY: replacing every byte with zero preserves valid UTF-8.
            let bytes = unsafe { value.as_bytes_mut() };
            bytes.zeroize();
            #[cfg(test)]
            if let Some(observer) = &self.observer {
                observer.observe(bytes);
            }
            value.clear();
        }
    }
}

pub struct SecretValue(ZeroizingBuffer);

impl SecretValue {
    pub fn bearer(value: Vec<u8>) -> Result<Self, NativeError> {
        Self::opaque_32_byte_base64url(value)
    }

    pub fn pairing(value: Vec<u8>) -> Result<Self, NativeError> {
        Self::opaque_32_byte_base64url(value)
    }

    fn opaque_32_byte_base64url(value: Vec<u8>) -> Result<Self, NativeError> {
        let value = ZeroizingBuffer::new(value);
        if value.as_slice().len() != 43
            || value
                .as_slice()
                .iter()
                .any(|byte| !byte.is_ascii_alphanumeric() && *byte != b'_' && *byte != b'-')
        {
            return Err(NativeError::invalid_response());
        }
        Ok(Self(value))
    }

    pub fn expose(&self) -> &[u8] {
        self.0.as_slice()
    }
}

impl Clone for SecretValue {
    fn clone(&self) -> Self {
        Self(ZeroizingBuffer::new(self.0.as_slice().to_vec()))
    }
}

pub struct CredentialRecord {
    pub installation_id: String,
    pub authority_fingerprint: String,
    pub bearer: SecretValue,
}

pub struct PreparedCredential {
    installation_id: String,
    encoded: Zeroizing<Vec<u8>>,
}

impl PreparedCredential {
    pub fn from_record(credential: &CredentialRecord) -> Result<Self, NativeError> {
        validate_installation_id(&credential.installation_id)?;
        validate_authority_fingerprint(&credential.authority_fingerprint)?;
        let bearer = std::str::from_utf8(credential.bearer.expose())
            .map_err(|_| NativeError::invalid_response())?;
        Ok(Self {
            installation_id: credential.installation_id.clone(),
            encoded: Zeroizing::new(
                serde_json::to_vec(&CredentialWireRef {
                    version: 1,
                    installation_id: &credential.installation_id,
                    authority_fingerprint: &credential.authority_fingerprint,
                    bearer,
                })
                .map_err(|_| operation_error(StoreOperation::Write))?,
            ),
        })
    }

    fn encoded(&self) -> &[u8] {
        self.encoded.as_slice()
    }

    #[cfg(test)]
    pub(crate) fn exact_value(&self) -> &[u8] {
        self.encoded()
    }
}

impl Clone for PreparedCredential {
    fn clone(&self) -> Self {
        Self {
            installation_id: self.installation_id.clone(),
            encoded: Zeroizing::new(self.encoded.to_vec()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialDeleteResult {
    Absent,
    Changed,
    Deleted,
}

pub enum CredentialLookup {
    Missing,
    Present(CredentialRecord),
    Invalid,
}

pub trait CredentialCustody: Send + Sync {
    fn availability(&self) -> CredentialStoreAvailability;
    fn installation_id(&self) -> Result<String, NativeError>;
    fn read_credential(&self, installation_id: &str) -> Result<CredentialLookup, NativeError>;
    fn write_credential(&self, credential: &PreparedCredential) -> Result<(), NativeError>;
    fn compare_delete_credential(
        &self,
        expected: &PreparedCredential,
    ) -> Result<CredentialDeleteResult, NativeError>;
    fn delete_credential(&self, installation_id: &str) -> Result<bool, NativeError>;
}

pub struct UnavailableCredentialCustody {
    error: NativeError,
}

impl UnavailableCredentialCustody {
    pub fn secure_store() -> Self {
        Self {
            error: NativeError::secure_store_unavailable(),
        }
    }

    pub fn platform() -> Self {
        Self {
            error: NativeError::platform_security_unavailable(),
        }
    }

    pub fn installation_id(&self) -> Result<String, NativeError> {
        Err(self.error.clone())
    }
}

impl CredentialCustody for UnavailableCredentialCustody {
    fn availability(&self) -> CredentialStoreAvailability {
        if self.error.code == DiagnosticCode::PlatformSecurityUnavailable {
            CredentialStoreAvailability::PlatformUnavailable
        } else {
            CredentialStoreAvailability::Unavailable
        }
    }

    fn installation_id(&self) -> Result<String, NativeError> {
        self.installation_id()
    }

    fn read_credential(&self, _installation_id: &str) -> Result<CredentialLookup, NativeError> {
        Err(self.error.clone())
    }

    fn write_credential(&self, _credential: &PreparedCredential) -> Result<(), NativeError> {
        Err(self.error.clone())
    }

    fn compare_delete_credential(
        &self,
        _expected: &PreparedCredential,
    ) -> Result<CredentialDeleteResult, NativeError> {
        Err(self.error.clone())
    }

    fn delete_credential(&self, _installation_id: &str) -> Result<bool, NativeError> {
        Err(self.error.clone())
    }
}

pub struct KeyringCredentialCustody {
    service: &'static str,
}

static STORE_AVAILABILITY: OnceLock<CredentialStoreAvailability> = OnceLock::new();

impl KeyringCredentialCustody {
    pub const fn new(service: &'static str) -> Self {
        Self { service }
    }

    fn entry(&self, account: &str, operation: StoreOperation) -> Result<Entry, NativeError> {
        match store_availability() {
            CredentialStoreAvailability::Available => {}
            CredentialStoreAvailability::PlatformUnavailable => {
                return Err(NativeError::platform_security_unavailable());
            }
            CredentialStoreAvailability::Unavailable => {
                return Err(NativeError::secure_store_unavailable());
            }
        }
        #[cfg(windows)]
        {
            return Entry::new_with_modifiers(
                self.service,
                account,
                &std::collections::HashMap::from([("persistence", "Local")]),
            )
            .map_err(|error| map_keyring_error(&error, operation));
        }
        #[cfg(not(windows))]
        {
            Entry::new(self.service, account).map_err(|error| map_keyring_error(&error, operation))
        }
    }

    #[cfg(windows)]
    fn ensure_windows_local_persistence(
        entry: &Entry,
        secret: &[u8],
        operation: StoreOperation,
    ) -> Result<(), NativeError> {
        let persistence = entry
            .get_attributes()
            .map_err(|error| map_keyring_error(&error, operation))?
            .get("persistence")
            .cloned();
        match windows_persistence_action(persistence.as_deref()) {
            WindowsPersistenceAction::Accept => Ok(()),
            WindowsPersistenceAction::Migrate => {
                entry
                    .set_secret(secret)
                    .map_err(|error| map_keyring_error(&error, StoreOperation::Write))?;
                let migrated = entry
                    .get_attributes()
                    .map_err(|error| map_keyring_error(&error, StoreOperation::Read))?;
                if windows_persistence_action(migrated.get("persistence").map(String::as_str))
                    == WindowsPersistenceAction::Accept
                {
                    Ok(())
                } else {
                    Err(NativeError::platform_security_unavailable())
                }
            }
            WindowsPersistenceAction::Reject => Err(NativeError::platform_security_unavailable()),
        }
    }

    #[cfg(not(windows))]
    fn ensure_windows_local_persistence(
        _entry: &Entry,
        _secret: &[u8],
        _operation: StoreOperation,
    ) -> Result<(), NativeError> {
        Ok(())
    }

    fn credential_account(installation_id: &str) -> Result<String, NativeError> {
        validate_installation_id(installation_id)?;
        Ok(format!("{CREDENTIAL_ACCOUNT_PREFIX}{installation_id}"))
    }
}

#[derive(Clone, Copy)]
enum StoreOperation {
    Read,
    Write,
    Delete,
}

fn operation_error(operation: StoreOperation) -> NativeError {
    NativeError::new(
        match operation {
            StoreOperation::Read => DiagnosticCode::SecretStoreReadFailed,
            StoreOperation::Write => DiagnosticCode::SecretStoreWriteFailed,
            StoreOperation::Delete => DiagnosticCode::SecretStoreDeleteFailed,
        },
        false,
    )
}

fn map_keyring_error(error: &KeyringError, operation: StoreOperation) -> NativeError {
    match error {
        KeyringError::Invalid(attribute, _) if attribute == "platform" => {
            NativeError::platform_security_unavailable()
        }
        KeyringError::NoDefaultStore => NativeError::platform_security_unavailable(),
        KeyringError::NoStorageAccess(_) | KeyringError::PlatformFailure(_) => {
            NativeError::secure_store_unavailable()
        }
        _ => operation_error(operation),
    }
}

fn store_availability() -> CredentialStoreAvailability {
    *STORE_AVAILABILITY.get_or_init(initialize_store)
}

fn initialize_store() -> CredentialStoreAvailability {
    #[cfg(target_os = "macos")]
    {
        return match apple_native_keyring_store::keychain::Store::new() {
            Ok(store) => {
                keyring_core::set_default_store(store);
                CredentialStoreAvailability::Available
            }
            Err(_) => CredentialStoreAvailability::Unavailable,
        };
    }

    #[cfg(target_os = "linux")]
    {
        return match zbus_secret_service_keyring_store::Store::new() {
            Ok(store) => {
                keyring_core::set_default_store(store);
                CredentialStoreAvailability::Available
            }
            Err(_) => CredentialStoreAvailability::Unavailable,
        };
    }

    #[cfg(target_os = "windows")]
    {
        return match windows_native_keyring_store::Store::new() {
            Ok(store) => {
                keyring_core::set_default_store(store);
                CredentialStoreAvailability::Available
            }
            Err(_) => CredentialStoreAvailability::Unavailable,
        };
    }

    #[allow(unreachable_code)]
    CredentialStoreAvailability::PlatformUnavailable
}

fn validate_installation_id(value: &str) -> Result<(), NativeError> {
    let parsed = Uuid::parse_str(value).map_err(|_| NativeError::invalid_response())?;
    if parsed.get_version() != Some(Version::Random) || parsed.to_string() != value {
        return Err(NativeError::invalid_response());
    }
    Ok(())
}

fn validate_authority_fingerprint(value: &str) -> Result<(), NativeError> {
    let Some(digest) = value.strip_prefix("sha256:") else {
        return Err(NativeError::invalid_response());
    };
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(NativeError::invalid_response());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialWireRef<'a> {
    version: u8,
    installation_id: &'a str,
    authority_fingerprint: &'a str,
    bearer: &'a str,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CredentialWire {
    version: u8,
    installation_id: String,
    authority_fingerprint: String,
    bearer: ZeroizingText,
}

fn decode_credential_bytes(bytes: Vec<u8>, installation_id: &str) -> CredentialLookup {
    let bytes = ZeroizingBuffer::new(bytes);
    if bytes.as_slice().len() > MAX_CREDENTIAL_RECORD_BYTES {
        return CredentialLookup::Invalid;
    }
    let wire = match serde_json::from_slice::<CredentialWire>(bytes.as_slice()) {
        Ok(wire) => wire,
        Err(_) => return CredentialLookup::Invalid,
    };
    if wire.version != 1
        || wire.installation_id != installation_id
        || validate_installation_id(&wire.installation_id).is_err()
        || validate_authority_fingerprint(&wire.authority_fingerprint).is_err()
    {
        return CredentialLookup::Invalid;
    }
    let bearer = match SecretValue::bearer(wire.bearer.into_bytes()) {
        Ok(bearer) => bearer,
        Err(_) => return CredentialLookup::Invalid,
    };

    CredentialLookup::Present(CredentialRecord {
        installation_id: wire.installation_id,
        authority_fingerprint: wire.authority_fingerprint,
        bearer,
    })
}

#[cfg(test)]
#[derive(Default)]
struct ZeroizeTestObserver {
    drops: std::sync::atomic::AtomicUsize,
    observed_nonzero: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl ZeroizeTestObserver {
    fn observe(&self, value: &[u8]) {
        if value.iter().any(|byte| *byte != 0) {
            self.observed_nonzero
                .store(true, std::sync::atomic::Ordering::Relaxed);
        }
        self.drops
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    }

    fn assert_zeroized(&self) {
        assert!(
            self.drops.load(std::sync::atomic::Ordering::Relaxed) > 0,
            "at least one secret owner must be dropped"
        );
        assert!(
            !self
                .observed_nonzero
                .load(std::sync::atomic::Ordering::Relaxed),
            "secret owners must zero their allocation before drop"
        );
    }
}

#[cfg(test)]
std::thread_local! {
    static ZEROIZE_TEST_OBSERVER: std::cell::RefCell<Option<std::sync::Arc<ZeroizeTestObserver>>> =
        const { std::cell::RefCell::new(None) };
}

#[cfg(test)]
fn current_zeroize_test_observer() -> Option<std::sync::Arc<ZeroizeTestObserver>> {
    ZEROIZE_TEST_OBSERVER.with(|observer| observer.borrow().clone())
}

#[cfg(test)]
fn with_zeroize_test_observer<T>(
    observer: std::sync::Arc<ZeroizeTestObserver>,
    operation: impl FnOnce() -> T,
) -> T {
    struct RestoreObserver(Option<std::sync::Arc<ZeroizeTestObserver>>);

    impl Drop for RestoreObserver {
        fn drop(&mut self) {
            ZEROIZE_TEST_OBSERVER.with(|observer| {
                *observer.borrow_mut() = self.0.take();
            });
        }
    }

    let previous = ZEROIZE_TEST_OBSERVER.with(|current| current.borrow_mut().replace(observer));
    let _restore = RestoreObserver(previous);
    operation()
}

impl CredentialCustody for KeyringCredentialCustody {
    fn availability(&self) -> CredentialStoreAvailability {
        store_availability()
    }

    fn installation_id(&self) -> Result<String, NativeError> {
        let _lock = CredentialMutationLock::acquire(self.service, INSTALLATION_ACCOUNT)?;
        let entry = self.entry(INSTALLATION_ACCOUNT, StoreOperation::Read)?;
        match entry.get_password() {
            Ok(value) => {
                Self::ensure_windows_local_persistence(
                    &entry,
                    value.as_bytes(),
                    StoreOperation::Read,
                )?;
                validate_installation_id(&value)?;
                Ok(value)
            }
            Err(KeyringError::NoEntry) => {
                let candidate = Uuid::new_v4().to_string();
                entry
                    .set_password(&candidate)
                    .map_err(|error| map_keyring_error(&error, StoreOperation::Write))?;
                let stored = entry
                    .get_password()
                    .map_err(|error| map_keyring_error(&error, StoreOperation::Read))?;
                Self::ensure_windows_local_persistence(
                    &entry,
                    stored.as_bytes(),
                    StoreOperation::Read,
                )?;
                validate_installation_id(&stored)?;
                Ok(stored)
            }
            Err(KeyringError::BadEncoding(bytes) | KeyringError::BadDataFormat(bytes, _)) => {
                drop(ZeroizingBuffer::new(bytes));
                Err(operation_error(StoreOperation::Read))
            }
            Err(error) => Err(map_keyring_error(&error, StoreOperation::Read)),
        }
    }

    fn read_credential(&self, installation_id: &str) -> Result<CredentialLookup, NativeError> {
        let account = Self::credential_account(installation_id)?;
        let _lock = CredentialMutationLock::acquire(self.service, &account)?;
        let entry = self.entry(&account, StoreOperation::Read)?;
        let bytes = match entry.get_secret() {
            Ok(bytes) => {
                Self::ensure_windows_local_persistence(&entry, &bytes, StoreOperation::Read)?;
                bytes
            }
            Err(KeyringError::NoEntry) => return Ok(CredentialLookup::Missing),
            Err(KeyringError::BadEncoding(bytes) | KeyringError::BadDataFormat(bytes, _)) => {
                drop(ZeroizingBuffer::new(bytes));
                return Ok(CredentialLookup::Invalid);
            }
            Err(KeyringError::BadStoreFormat(_) | KeyringError::Ambiguous(_)) => {
                return Ok(CredentialLookup::Invalid);
            }
            Err(error) => return Err(map_keyring_error(&error, StoreOperation::Read)),
        };
        Ok(decode_credential_bytes(bytes, installation_id))
    }

    fn write_credential(&self, credential: &PreparedCredential) -> Result<(), NativeError> {
        let account = Self::credential_account(&credential.installation_id)?;
        let _lock = CredentialMutationLock::acquire(self.service, &account)?;
        let entry = self.entry(&account, StoreOperation::Write)?;
        entry
            .set_secret(credential.encoded())
            .map_err(|error| map_keyring_error(&error, StoreOperation::Write))?;
        Self::ensure_windows_local_persistence(&entry, credential.encoded(), StoreOperation::Write)
    }

    fn compare_delete_credential(
        &self,
        expected: &PreparedCredential,
    ) -> Result<CredentialDeleteResult, NativeError> {
        let account = Self::credential_account(&expected.installation_id)?;
        let _lock = CredentialMutationLock::acquire(self.service, &account)?;
        let entry = self.entry(&account, StoreOperation::Delete)?;
        let current = match entry.get_secret() {
            Ok(current) => {
                Self::ensure_windows_local_persistence(&entry, &current, StoreOperation::Read)?;
                Zeroizing::new(current)
            }
            Err(KeyringError::NoEntry) => return Ok(CredentialDeleteResult::Absent),
            Err(KeyringError::BadEncoding(bytes) | KeyringError::BadDataFormat(bytes, _)) => {
                drop(ZeroizingBuffer::new(bytes));
                return Err(operation_error(StoreOperation::Read));
            }
            Err(error) => return Err(map_keyring_error(&error, StoreOperation::Read)),
        };
        if current.as_slice() != expected.encoded() {
            return Ok(CredentialDeleteResult::Changed);
        }
        entry
            .delete_credential()
            .map(|()| CredentialDeleteResult::Deleted)
            .or_else(|error| match error {
                KeyringError::NoEntry => Ok(CredentialDeleteResult::Absent),
                error => Err(map_keyring_error(&error, StoreOperation::Delete)),
            })
    }

    fn delete_credential(&self, installation_id: &str) -> Result<bool, NativeError> {
        let account = Self::credential_account(installation_id)?;
        let _lock = CredentialMutationLock::acquire(self.service, &account)?;
        let entry = self.entry(&account, StoreOperation::Delete)?;
        match entry.delete_credential() {
            Ok(()) => Ok(true),
            Err(KeyringError::NoEntry) => Ok(false),
            Err(error) => Err(map_keyring_error(&error, StoreOperation::Delete)),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::{
        decode_credential_bytes, validate_authority_fingerprint, validate_installation_id,
        with_zeroize_test_observer, CredentialLookup, ZeroizeTestObserver,
        MAX_CREDENTIAL_RECORD_BYTES,
    };

    #[test]
    fn rejects_non_v4_or_noncanonical_installation_ids() {
        assert!(validate_installation_id("00000000-0000-0000-0000-000000000000").is_err());
        assert!(validate_installation_id("00000000-0000-4000-8000-000000000001").is_ok());
        assert!(validate_installation_id("00000000-0000-4000-8000-000000000001\n").is_err());
    }

    #[test]
    fn bounds_authority_fingerprints() {
        assert!(validate_authority_fingerprint(&format!("sha256:{}", "a".repeat(64))).is_ok());
        assert!(validate_authority_fingerprint(&format!("sha256:{}", "a".repeat(65))).is_err());
    }

    #[test]
    fn credential_decode_zeroizes_invalid_metadata_bearer_ownership() {
        let observer = Arc::new(ZeroizeTestObserver::default());
        let result = with_zeroize_test_observer(observer.clone(), || {
            decode_credential_bytes(
                br#"{"version":1,"installationId":"invalid","authorityFingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bearer":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"}"#.to_vec(),
                "00000000-0000-4000-8000-000000000010",
            )
        });
        assert!(matches!(result, CredentialLookup::Invalid));
        observer.assert_zeroized();
    }

    #[test]
    fn credential_decode_zeroizes_invalid_json_after_bearer() {
        let observer = Arc::new(ZeroizeTestObserver::default());
        let result = with_zeroize_test_observer(observer.clone(), || {
            decode_credential_bytes(
                br#"{"version":1,"installationId":"00000000-0000-4000-8000-000000000010","authorityFingerprint":"sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","bearer":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"} trailing"#.to_vec(),
                "00000000-0000-4000-8000-000000000010",
            )
        });
        assert!(matches!(result, CredentialLookup::Invalid));
        observer.assert_zeroized();
    }

    #[test]
    fn credential_decode_zeroizes_oversized_raw_records() {
        let observer = Arc::new(ZeroizeTestObserver::default());
        let result = with_zeroize_test_observer(observer.clone(), || {
            decode_credential_bytes(
                vec![b'x'; MAX_CREDENTIAL_RECORD_BYTES + 1],
                "00000000-0000-4000-8000-000000000010",
            )
        });
        assert!(matches!(result, CredentialLookup::Invalid));
        observer.assert_zeroized();
    }
}
