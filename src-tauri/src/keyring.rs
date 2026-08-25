use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

use crate::cave::NativeDiagnostic;

const SERVICE: &str = "ai.opencoven.chat";
const CREDENTIAL_ACCOUNT_PREFIX: &str = "cave-client-v1";

#[derive(Debug)]
pub(crate) enum KeyringError {
    NotFound,
    Unavailable,
    Failure,
}

impl KeyringError {
    pub(crate) const fn diagnostic(&self) -> NativeDiagnostic {
        match self {
            Self::NotFound => NativeDiagnostic::new("credential_missing", true),
            Self::Unavailable => NativeDiagnostic::new("secure_store_unavailable", true),
            Self::Failure => NativeDiagnostic::new("keychain_failure", true),
        }
    }
}

#[derive(Clone)]
pub(crate) struct Credential {
    pub(crate) bearer: String,
    pub(crate) credential_id: String,
    pub(crate) origin: String,
}

#[derive(Serialize, Deserialize)]
struct StoredCredential {
    bearer: String,
    credential_id: String,
    origin: String,
}

pub(crate) trait CredentialCustody: Send + Sync {
    fn read(&self, instance_id: &str, origin: &str) -> Result<Credential, KeyringError>;
    fn store(
        &self,
        instance_id: &str,
        origin: &str,
        bearer: &str,
        credential_id: &str,
    ) -> Result<(), KeyringError>;
    fn delete_if_matches(
        &self,
        instance_id: &str,
        origin: &str,
        credential_id: &str,
    ) -> Result<bool, KeyringError>;
}

#[derive(Clone, Default)]
pub(crate) struct NativeKeyring;

fn mutation_lock() -> &'static Mutex<()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
}

impl CredentialCustody for NativeKeyring {
    fn read(&self, instance_id: &str, origin: &str) -> Result<Credential, KeyringError> {
        let _guard = mutation_lock().lock().map_err(|_| KeyringError::Failure)?;
        let raw = Self::entry(instance_id)?
            .get_password()
            .map_err(map_keyring_error)?;
        let stored =
            serde_json::from_str::<StoredCredential>(&raw).map_err(|_| KeyringError::Failure)?;
        if stored.bearer.is_empty()
            || stored.credential_id.is_empty()
            || stored.origin.is_empty()
            || stored.origin != origin
        {
            return Err(KeyringError::NotFound);
        }
        Ok(Credential {
            bearer: stored.bearer,
            credential_id: stored.credential_id,
            origin: stored.origin,
        })
    }

    fn store(
        &self,
        instance_id: &str,
        origin: &str,
        bearer: &str,
        credential_id: &str,
    ) -> Result<(), KeyringError> {
        if bearer.is_empty() || credential_id.is_empty() || origin.is_empty() {
            return Err(KeyringError::Failure);
        }
        let _guard = mutation_lock().lock().map_err(|_| KeyringError::Failure)?;
        let value = serde_json::to_string(&StoredCredential {
            bearer: bearer.to_owned(),
            credential_id: credential_id.to_owned(),
            origin: origin.to_owned(),
        })
        .map_err(|_| KeyringError::Failure)?;
        Self::entry(instance_id)?
            .set_password(&value)
            .map_err(map_keyring_error)
    }

    fn delete_if_matches(
        &self,
        instance_id: &str,
        origin: &str,
        credential_id: &str,
    ) -> Result<bool, KeyringError> {
        let _guard = mutation_lock().lock().map_err(|_| KeyringError::Failure)?;
        let entry = Self::entry(instance_id)?;
        let value = match entry.get_password() {
            Ok(value) => value,
            Err(keyring::Error::NoEntry) => return Ok(false),
            Err(error) => return Err(map_keyring_error(error)),
        };
        let stored =
            serde_json::from_str::<StoredCredential>(&value).map_err(|_| KeyringError::Failure)?;
        if stored.origin != origin || stored.credential_id != credential_id {
            return Ok(false);
        }
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(true),
            Err(error) => Err(map_keyring_error(error)),
        }
    }
}

impl NativeKeyring {
    fn entry(instance_id: &str) -> Result<keyring::Entry, KeyringError> {
        if instance_id.is_empty() || instance_id.len() > 128 {
            return Err(KeyringError::Failure);
        }
        keyring::Entry::new(
            SERVICE,
            &format!("{CREDENTIAL_ACCOUNT_PREFIX}:{instance_id}"),
        )
        .map_err(map_keyring_error)
    }
}

fn map_keyring_error(error: keyring::Error) -> KeyringError {
    match error {
        keyring::Error::NoEntry => KeyringError::NotFound,
        keyring::Error::NoStorageAccess(_) => KeyringError::Unavailable,
        _ => KeyringError::Failure,
    }
}
