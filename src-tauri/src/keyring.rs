#[cfg(unix)]
use std::{
    env, fs,
    sync::{Mutex, MutexGuard, OnceLock},
};

#[cfg(any(windows, test))]
use std::marker::PhantomData;

#[cfg(windows)]
use sha2::{Digest, Sha256};

#[cfg(unix)]
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

impl Credential {
    pub(crate) fn is_same_identity(&self, other: &Self) -> bool {
        self.bearer == other.bearer
            && self.credential_id == other.credential_id
            && self.origin == other.origin
    }
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
        expected_credential: Option<&Credential>,
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
pub(crate) struct NativeKeyring;

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

#[cfg(unix)]
fn acquire_mutation_lock() -> Result<CredentialMutationGuard, KeyringError> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};

    let process = mutation_lock().lock().map_err(|_| KeyringError::Failure)?;
    let path = credential_lock_path()?;
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
    file.lock_exclusive()
        .map_err(|_| KeyringError::Unavailable)?;
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
impl WindowsMutexApi for NativeWindowsMutexApi {
    type Handle = windows_sys::Win32::Foundation::HANDLE;

    fn create(&self, name: &str) -> Result<Self::Handle, KeyringError> {
        use std::os::windows::ffi::OsStrExt;

        use windows_sys::Win32::System::Threading::CreateMutexW;

        let mut wide = std::ffi::OsStr::new(name).encode_wide().collect::<Vec<_>>();
        wide.push(0);
        let handle = unsafe { CreateMutexW(std::ptr::null(), 0, wide.as_ptr()) };
        if handle.is_null() {
            return Err(KeyringError::Unavailable);
        }
        Ok(handle)
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
struct CredentialMutationGuard {
    _mutex: WindowsMutexGuard<'static, NativeWindowsMutexApi>,
}

#[cfg(windows)]
fn acquire_mutation_lock() -> Result<CredentialMutationGuard, KeyringError> {
    static MUTEX: NativeWindowsMutexApi = NativeWindowsMutexApi;

    let identity =
        crate::cave::current_windows_user_identity().map_err(|_| KeyringError::Unavailable)?;
    let scope = format!("{SERVICE}:{CREDENTIAL_ACCOUNT_PREFIX}:{identity}");
    let name = format!(
        "Local\\OpenCoven.Chat.{:x}",
        Sha256::digest(scope.as_bytes())
    );
    acquire_windows_mutex(&MUTEX, &name).map(|mutex| CredentialMutationGuard { _mutex: mutex })
}

#[cfg(all(not(unix), not(windows)))]
fn acquire_mutation_lock() -> Result<(), KeyringError> {
    Err(KeyringError::Unavailable)
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
        expected_credential: Option<&Credential>,
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
        expected_credential: &Credential,
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
        if stored.origin != origin
            || stored.bearer != expected_credential.bearer
            || stored.credential_id != expected_credential.credential_id
            || stored.origin != expected_credential.origin
        {
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

#[cfg(test)]
mod tests {
    use super::{acquire_windows_mutex, KeyringError, WindowsMutexApi, WindowsMutexWait};

    #[test]
    fn windows_mutex_accepts_abandonment_and_releases_its_handle() {
        let mutex = FakeWindowsMutex::with_wait(WindowsMutexWait::Abandoned);
        {
            let _guard = acquire_windows_mutex(&mutex, "Local\\OpenCoven.Chat.test").unwrap();
            assert_eq!(mutex.wait_calls(), 1);
        }
        assert_eq!(mutex.release_calls(), 1);
        assert_eq!(mutex.close_calls(), 1);
    }

    #[test]
    fn windows_mutex_serializes_contenders_and_releases_after_each_guard() {
        let mutex = FakeWindowsMutex::with_wait(WindowsMutexWait::Acquired);
        {
            let _first = acquire_windows_mutex(&mutex, "Local\\OpenCoven.Chat.test").unwrap();
            assert_eq!(mutex.wait_calls(), 1);
            assert!(matches!(
                acquire_windows_mutex(&mutex, "Local\\OpenCoven.Chat.test"),
                Err(KeyringError::Unavailable)
            ));
            assert_eq!(mutex.release_calls(), 0);
        }
        {
            let _second = acquire_windows_mutex(&mutex, "Local\\OpenCoven.Chat.test").unwrap();
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
                acquire_windows_mutex(&mutex, "Local\\OpenCoven.Chat.test"),
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
