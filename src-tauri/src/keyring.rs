use std::{
    fs,
    sync::{Mutex, MutexGuard, OnceLock},
};

#[cfg(unix)]
use std::env;

use fs2::FileExt;
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
    fn store_if_current(
        &self,
        instance_id: &str,
        origin: &str,
        expected_credential_id: Option<&str>,
        bearer: &str,
        credential_id: &str,
    ) -> Result<bool, KeyringError>;
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

struct CredentialMutationGuard {
    _process: MutexGuard<'static, ()>,
    _file: fs::File,
}

#[cfg(unix)]
fn credential_lock_path() -> Result<std::path::PathBuf, KeyringError> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let home = env::var_os("HOME").ok_or(KeyringError::Unavailable)?;
    let root = std::path::PathBuf::from(home).join(".coven").join("chat");
    fs::create_dir_all(&root).map_err(|_| KeyringError::Unavailable)?;
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
        .map_err(|_| KeyringError::Unavailable)?;
    let metadata = fs::symlink_metadata(&root).map_err(|_| KeyringError::Unavailable)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(KeyringError::Unavailable);
    }
    Ok(root.join("credential-mutation.lock"))
}

#[cfg(not(unix))]
fn credential_lock_path() -> Result<std::path::PathBuf, KeyringError> {
    Err(KeyringError::Unavailable)
}

fn acquire_mutation_lock() -> Result<CredentialMutationGuard, KeyringError> {
    #[cfg(unix)]
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

    let process = mutation_lock().lock().map_err(|_| KeyringError::Failure)?;
    let path = credential_lock_path()?;
    let file = {
        #[cfg(unix)]
        {
            fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .mode(0o600)
                .custom_flags(libc::O_NOFOLLOW)
                .open(&path)
                .map_err(|_| KeyringError::Unavailable)?
        }
        #[cfg(not(unix))]
        {
            fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .open(&path)
                .map_err(|_| KeyringError::Unavailable)?
        }
    };
    #[cfg(unix)]
    {
        let metadata = file.metadata().map_err(|_| KeyringError::Unavailable)?;
        if !metadata.is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o077 != 0
        {
            return Err(KeyringError::Unavailable);
        }
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
            .map_err(|_| KeyringError::Unavailable)?;
    }
    file.lock_exclusive()
        .map_err(|_| KeyringError::Unavailable)?;
    Ok(CredentialMutationGuard {
        _process: process,
        _file: file,
    })
}

impl CredentialCustody for NativeKeyring {
    fn read(&self, instance_id: &str, origin: &str) -> Result<Credential, KeyringError> {
        let _guard = acquire_mutation_lock()?;
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

    fn store_if_current(
        &self,
        instance_id: &str,
        origin: &str,
        expected_credential_id: Option<&str>,
        bearer: &str,
        credential_id: &str,
    ) -> Result<bool, KeyringError> {
        if bearer.is_empty() || credential_id.is_empty() || origin.is_empty() {
            return Err(KeyringError::Failure);
        }
        let _guard = acquire_mutation_lock()?;
        let entry = Self::entry(instance_id)?;
        let current = match entry.get_password() {
            Ok(value) => Some(
                serde_json::from_str::<StoredCredential>(&value)
                    .map_err(|_| KeyringError::Failure)?,
            ),
            Err(keyring::Error::NoEntry) => None,
            Err(error) => return Err(map_keyring_error(error)),
        };
        let matches_expected = match (current.as_ref(), expected_credential_id) {
            (None, None) => true,
            (Some(stored), Some(expected)) => {
                stored.origin == origin && stored.credential_id == expected
            }
            _ => false,
        };
        if !matches_expected {
            return Ok(false);
        }
        let value = serde_json::to_string(&StoredCredential {
            bearer: bearer.to_owned(),
            credential_id: credential_id.to_owned(),
            origin: origin.to_owned(),
        })
        .map_err(|_| KeyringError::Failure)?;
        entry
            .set_password(&value)
            .map_err(map_keyring_error)
            .map(|()| true)
    }

    fn delete_if_matches(
        &self,
        instance_id: &str,
        origin: &str,
        credential_id: &str,
    ) -> Result<bool, KeyringError> {
        let _guard = acquire_mutation_lock()?;
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
