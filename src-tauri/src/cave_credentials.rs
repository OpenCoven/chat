use std::sync::OnceLock;

use keyring_core::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use uuid::{Uuid, Version};
use zeroize::Zeroizing;

use crate::sdk_diagnostics::{DiagnosticCode, NativeError};

const INSTALLATION_ACCOUNT: &str = "installation-id-v1";
const CREDENTIAL_ACCOUNT_PREFIX: &str = "cave-credential-v1:";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CredentialStoreAvailability {
    Available,
    PlatformUnavailable,
    Unavailable,
}

pub struct SecretValue(Zeroizing<Vec<u8>>);

impl SecretValue {
    pub fn bearer(value: Vec<u8>) -> Result<Self, NativeError> {
        Self::opaque_32_byte_base64url(value)
    }

    pub fn pairing(value: Vec<u8>) -> Result<Self, NativeError> {
        Self::opaque_32_byte_base64url(value)
    }

    fn opaque_32_byte_base64url(value: Vec<u8>) -> Result<Self, NativeError> {
        if value.len() != 43
            || value
                .iter()
                .any(|byte| !byte.is_ascii_alphanumeric() && *byte != b'_' && *byte != b'-')
        {
            return Err(NativeError::invalid_response());
        }
        Ok(Self(Zeroizing::new(value)))
    }

    pub fn expose(&self) -> &[u8] {
        self.0.as_slice()
    }
}

impl Clone for SecretValue {
    fn clone(&self) -> Self {
        Self(Zeroizing::new(self.0.to_vec()))
    }
}

pub struct CredentialRecord {
    pub installation_id: String,
    pub authority_fingerprint: String,
    pub bearer: SecretValue,
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
    fn write_credential(&self, credential: &CredentialRecord) -> Result<(), NativeError>;
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

    fn write_credential(&self, _credential: &CredentialRecord) -> Result<(), NativeError> {
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
        Entry::new(self.service, account).map_err(|error| map_keyring_error(&error, operation))
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
    bearer: String,
}

impl CredentialCustody for KeyringCredentialCustody {
    fn availability(&self) -> CredentialStoreAvailability {
        store_availability()
    }

    fn installation_id(&self) -> Result<String, NativeError> {
        let entry = self.entry(INSTALLATION_ACCOUNT, StoreOperation::Read)?;
        match entry.get_password() {
            Ok(value) => {
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
                validate_installation_id(&stored)?;
                Ok(stored)
            }
            Err(error) => Err(map_keyring_error(&error, StoreOperation::Read)),
        }
    }

    fn read_credential(&self, installation_id: &str) -> Result<CredentialLookup, NativeError> {
        let account = Self::credential_account(installation_id)?;
        let entry = self.entry(&account, StoreOperation::Read)?;
        let bytes = match entry.get_secret() {
            Ok(bytes) => Zeroizing::new(bytes),
            Err(KeyringError::NoEntry) => return Ok(CredentialLookup::Missing),
            Err(
                KeyringError::BadEncoding(_)
                | KeyringError::BadDataFormat(_, _)
                | KeyringError::BadStoreFormat(_)
                | KeyringError::Ambiguous(_),
            ) => return Ok(CredentialLookup::Invalid),
            Err(error) => return Err(map_keyring_error(&error, StoreOperation::Read)),
        };
        let wire = match serde_json::from_slice::<CredentialWire>(&bytes) {
            Ok(wire) => wire,
            Err(_) => return Ok(CredentialLookup::Invalid),
        };
        if wire.version != 1
            || wire.installation_id != installation_id
            || validate_installation_id(&wire.installation_id).is_err()
            || validate_authority_fingerprint(&wire.authority_fingerprint).is_err()
        {
            return Ok(CredentialLookup::Invalid);
        }
        let bearer = match SecretValue::bearer(wire.bearer.into_bytes()) {
            Ok(bearer) => bearer,
            Err(_) => return Ok(CredentialLookup::Invalid),
        };

        Ok(CredentialLookup::Present(CredentialRecord {
            installation_id: wire.installation_id,
            authority_fingerprint: wire.authority_fingerprint,
            bearer,
        }))
    }

    fn write_credential(&self, credential: &CredentialRecord) -> Result<(), NativeError> {
        validate_installation_id(&credential.installation_id)?;
        validate_authority_fingerprint(&credential.authority_fingerprint)?;
        let bearer = std::str::from_utf8(credential.bearer.expose())
            .map_err(|_| NativeError::invalid_response())?;
        let bytes = Zeroizing::new(
            serde_json::to_vec(&CredentialWireRef {
                version: 1,
                installation_id: &credential.installation_id,
                authority_fingerprint: &credential.authority_fingerprint,
                bearer,
            })
            .map_err(|_| operation_error(StoreOperation::Write))?,
        );
        let account = Self::credential_account(&credential.installation_id)?;
        self.entry(&account, StoreOperation::Write)?
            .set_secret(&bytes)
            .map_err(|error| map_keyring_error(&error, StoreOperation::Write))
    }

    fn delete_credential(&self, installation_id: &str) -> Result<bool, NativeError> {
        let account = Self::credential_account(installation_id)?;
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
    use super::{validate_authority_fingerprint, validate_installation_id};

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
}
