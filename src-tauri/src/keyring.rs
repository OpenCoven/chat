use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::cave::{NativeDiagnostic, ValidatedCaveAuthority};

const SERVICE: &str = "ai.opencoven.chat";
const INSTALLATION_ACCOUNT: &str = "cave-client-v1-installation";
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

#[derive(Clone, Default)]
pub(crate) struct NativeKeyring;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CredentialMetadata {
    pub credential_id: String,
}

#[derive(Serialize, Deserialize)]
struct StoredCredential {
    bearer: String,
    credential_id: String,
    origin_binding: String,
    epoch: u64,
}

pub(crate) struct Credential {
    pub(crate) bearer: String,
    pub(crate) credential_id: String,
    pub(crate) origin_binding: String,
    pub(crate) epoch: u64,
}

impl NativeKeyring {
    pub(crate) fn installation_id(&self) -> Result<String, KeyringError> {
        let entry = Self::entry(INSTALLATION_ACCOUNT)?;

        match entry.get_password() {
            Ok(value) if Uuid::parse_str(&value).is_ok() => Ok(value),
            Ok(_) => Err(KeyringError::Failure),
            Err(keyring::Error::NoEntry) => {
                let installation_id = Uuid::new_v4().to_string();
                entry
                    .set_password(&installation_id)
                    .map_err(map_keyring_error)?;
                Ok(installation_id)
            }
            Err(error) => Err(map_keyring_error(error)),
        }
    }

    pub(crate) fn read_credential(&self, instance_id: &str) -> Result<Credential, KeyringError> {
        let value = Self::entry(&credential_account(instance_id))?
            .get_password()
            .map_err(map_keyring_error)?;
        let stored =
            serde_json::from_str::<StoredCredential>(&value).map_err(|_| KeyringError::Failure)?;

        if stored.bearer.is_empty()
            || stored.credential_id.is_empty()
            || stored.origin_binding.is_empty()
        {
            return Err(KeyringError::Failure);
        }

        Ok(Credential {
            bearer: stored.bearer,
            credential_id: stored.credential_id,
            origin_binding: stored.origin_binding,
            epoch: stored.epoch,
        })
    }

    pub(crate) fn store_credential(
        &self,
        authority: &ValidatedCaveAuthority,
        bearer: &str,
        credential_id: &str,
    ) -> Result<CredentialMetadata, KeyringError> {
        if bearer.is_empty() || credential_id.is_empty() {
            return Err(KeyringError::Failure);
        }

        let serialized = serde_json::to_string(&StoredCredential {
            bearer: bearer.to_owned(),
            credential_id: credential_id.to_owned(),
            origin_binding: authority.origin_binding(),
            epoch: authority.identity().epoch,
        })
        .map_err(|_| KeyringError::Failure)?;

        Self::entry(&credential_account(&authority.identity().instance_id))?
            .set_password(&serialized)
            .map_err(map_keyring_error)?;
        Ok(CredentialMetadata {
            credential_id: credential_id.to_owned(),
        })
    }

    pub(crate) fn delete_credential_if_matches(
        &self,
        authority: &ValidatedCaveAuthority,
        credential_id: &str,
    ) -> Result<bool, KeyringError> {
        let entry = Self::entry(&credential_account(&authority.identity().instance_id))?;
        let value = match entry.get_password() {
            Ok(value) => value,
            Err(keyring::Error::NoEntry) => return Ok(false),
            Err(error) => return Err(map_keyring_error(error)),
        };
        let stored =
            serde_json::from_str::<StoredCredential>(&value).map_err(|_| KeyringError::Failure)?;
        if stored.credential_id != credential_id
            || stored.origin_binding != authority.origin_binding()
            || stored.epoch != authority.identity().epoch
        {
            return Ok(false);
        }

        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(true),
            Err(error) => Err(map_keyring_error(error)),
        }
    }

    fn entry(account: &str) -> Result<keyring::Entry, KeyringError> {
        keyring::Entry::new(SERVICE, account).map_err(map_keyring_error)
    }
}

fn credential_account(instance_id: &str) -> String {
    format!("{CREDENTIAL_ACCOUNT_PREFIX}:{instance_id}")
}

fn map_keyring_error(error: keyring::Error) -> KeyringError {
    match error {
        keyring::Error::NoEntry => KeyringError::NotFound,
        keyring::Error::NoStorageAccess(_) => KeyringError::Unavailable,
        _ => KeyringError::Failure,
    }
}
