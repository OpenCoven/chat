use sha2::{Digest, Sha256};

use crate::sdk_diagnostics::NativeError;

const CREDENTIAL_LOCK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);

pub(crate) struct CredentialMutationLock {
    _platform: PlatformCredentialLock,
}

impl CredentialMutationLock {
    pub(crate) fn acquire(service: &str, account: &str) -> Result<Self, NativeError> {
        Self::acquire_with_timeout(service, account, CREDENTIAL_LOCK_TIMEOUT)
    }

    fn acquire_with_timeout(
        service: &str,
        account: &str,
        timeout: std::time::Duration,
    ) -> Result<Self, NativeError> {
        let key = credential_key(service, account);
        Ok(Self {
            _platform: PlatformCredentialLock::acquire(&key, timeout)?,
        })
    }
}

fn credential_key(service: &str, account: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(service.as_bytes());
    digest.update([0]);
    digest.update(account.as_bytes());
    digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsPersistenceAction {
    Accept,
    Migrate,
    Reject,
}

#[cfg(any(windows, test))]
pub(crate) fn windows_persistence_action(value: Option<&str>) -> WindowsPersistenceAction {
    match value {
        Some("Local") => WindowsPersistenceAction::Accept,
        Some("Enterprise") => WindowsPersistenceAction::Migrate,
        _ => WindowsPersistenceAction::Reject,
    }
}

#[cfg(any(windows, test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsAclPolicy {
    CurrentUserFullControlOnly,
}

#[cfg(any(windows, test))]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WindowsMutexSpec {
    pub(crate) name: String,
    pub(crate) acl: WindowsAclPolicy,
}

#[cfg(any(windows, test))]
pub(crate) fn windows_mutex_spec(
    current_user_sid: &[u8],
    credential_key: &str,
) -> Result<WindowsMutexSpec, NativeError> {
    if current_user_sid.is_empty()
        || credential_key.len() != 64
        || credential_key
            .bytes()
            .any(|byte| !byte.is_ascii_digit() && !(b'a'..=b'f').contains(&byte))
    {
        return Err(NativeError::platform_security_unavailable());
    }
    let user_key = Sha256::digest(current_user_sid)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let name = format!("Global\\OpenCoven.Chat.Credential.{user_key}.{credential_key}");
    if name.len() > 240 {
        return Err(NativeError::platform_security_unavailable());
    }
    Ok(WindowsMutexSpec {
        name,
        acl: WindowsAclPolicy::CurrentUserFullControlOnly,
    })
}

#[cfg(unix)]
struct PlatformCredentialLock {
    _file: std::fs::File,
}

#[cfg(unix)]
impl PlatformCredentialLock {
    fn acquire(key: &str, timeout: std::time::Duration) -> Result<Self, NativeError> {
        use std::{
            ffi::CString,
            os::fd::{FromRawFd, RawFd},
        };

        struct DirectoryDescriptor(RawFd);

        impl Drop for DirectoryDescriptor {
            fn drop(&mut self) {
                // SAFETY: this descriptor is owned by the guard.
                unsafe {
                    libc::close(self.0);
                }
            }
        }

        fn platform_error() -> NativeError {
            NativeError::platform_security_unavailable()
        }

        fn stat_descriptor(descriptor: RawFd) -> Result<libc::stat, NativeError> {
            // SAFETY: fstat initializes the provided stat buffer for a live descriptor.
            let mut stat = unsafe { std::mem::zeroed::<libc::stat>() };
            // SAFETY: both pointers are valid for this call.
            if unsafe { libc::fstat(descriptor, &raw mut stat) } != 0 {
                return Err(platform_error());
            }
            Ok(stat)
        }

        // SAFETY: geteuid has no preconditions.
        let uid = unsafe { libc::geteuid() };
        let directory_path = CString::new(format!("/tmp/opencoven-chat-credential-locks-{uid}"))
            .map_err(|_| platform_error())?;
        // SAFETY: the path is a valid C string and the mode is owner-private.
        let created = unsafe { libc::mkdir(directory_path.as_ptr(), 0o700) };
        if created != 0 && std::io::Error::last_os_error().raw_os_error() != Some(libc::EEXIST) {
            return Err(platform_error());
        }
        // SAFETY: the path is valid and O_NOFOLLOW rejects a substituted directory symlink.
        let directory = unsafe {
            libc::open(
                directory_path.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if directory < 0 {
            return Err(platform_error());
        }
        let directory = DirectoryDescriptor(directory);
        let directory_stat = stat_descriptor(directory.0)?;
        if directory_stat.st_uid != uid
            || (directory_stat.st_mode & libc::S_IFMT) != libc::S_IFDIR
            || (directory_stat.st_mode & 0o077) != 0
        {
            return Err(platform_error());
        }

        let file_name =
            CString::new(format!("credential-{key}.lock")).map_err(|_| platform_error())?;
        // SAFETY: openat is anchored to the validated directory and O_NOFOLLOW rejects symlinks.
        let descriptor = unsafe {
            libc::openat(
                directory.0,
                file_name.as_ptr(),
                libc::O_CREAT | libc::O_RDWR | libc::O_CLOEXEC | libc::O_NOFOLLOW,
                0o600,
            )
        };
        if descriptor < 0 {
            return Err(platform_error());
        }
        // SAFETY: ownership of the newly opened descriptor transfers to File.
        let file = unsafe { std::fs::File::from_raw_fd(descriptor) };
        let file_stat = stat_descriptor(descriptor)?;
        if file_stat.st_uid != uid
            || (file_stat.st_mode & libc::S_IFMT) != libc::S_IFREG
            || (file_stat.st_mode & 0o077) != 0
            || file_stat.st_nlink != 1
        {
            return Err(platform_error());
        }
        let deadline = std::time::Instant::now() + timeout;
        loop {
            // SAFETY: flock operates on the live lock-file descriptor.
            if unsafe { libc::flock(descriptor, libc::LOCK_EX | libc::LOCK_NB) } == 0 {
                break;
            }
            let code = std::io::Error::last_os_error().raw_os_error();
            if code == Some(libc::EINTR) {
                continue;
            }
            if code != Some(libc::EWOULDBLOCK) && code != Some(libc::EAGAIN) {
                return Err(platform_error());
            }
            if std::time::Instant::now() >= deadline {
                return Err(NativeError::credential_update_in_progress());
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        Ok(Self { _file: file })
    }
}

#[cfg(windows)]
struct PlatformCredentialLock {
    handle: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
impl PlatformCredentialLock {
    fn acquire(key: &str, timeout: std::time::Duration) -> Result<Self, NativeError> {
        use windows_sys::Win32::{
            Foundation::{
                CloseHandle, LocalFree, ERROR_SUCCESS, HANDLE, HLOCAL, WAIT_ABANDONED,
                WAIT_OBJECT_0, WAIT_TIMEOUT,
            },
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
                CreateMutexW, GetCurrentProcess, OpenProcessToken, WaitForSingleObject,
                MUTEX_ALL_ACCESS,
            },
        };

        fn platform_error() -> NativeError {
            NativeError::platform_security_unavailable()
        }

        struct OwnedHandle(HANDLE);

        impl Drop for OwnedHandle {
            fn drop(&mut self) {
                // SAFETY: this handle is owned by the guard.
                unsafe {
                    CloseHandle(self.0);
                }
            }
        }

        struct LocalAllocation(HLOCAL);

        impl Drop for LocalAllocation {
            fn drop(&mut self) {
                if !self.0.is_null() {
                    // SAFETY: this pointer was allocated by a Windows local-allocation API.
                    unsafe {
                        LocalFree(self.0);
                    }
                }
            }
        }

        let mut token = std::ptr::null_mut();
        // SAFETY: the pseudo process handle is valid and token receives an owned handle.
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &raw mut token) } == 0 {
            return Err(platform_error());
        }
        let token = OwnedHandle(token);
        let mut token_length = 0;
        // SAFETY: this probes the required buffer length.
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
            return Err(platform_error());
        }
        let word_size = std::mem::size_of::<usize>();
        let mut token_buffer = vec![0_usize; (token_length as usize).div_ceil(word_size)];
        // SAFETY: the aligned buffer has the probed size and TOKEN_USER layout.
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
            return Err(platform_error());
        }
        // SAFETY: GetTokenInformation initialized a TOKEN_USER at the buffer start.
        let current_sid = unsafe { (*(token_buffer.as_ptr().cast::<TOKEN_USER>())).User.Sid };
        // SAFETY: current_sid points into the initialized TOKEN_USER buffer.
        let sid_length = unsafe { GetLengthSid(current_sid) };
        if sid_length == 0 {
            return Err(platform_error());
        }
        // SAFETY: GetLengthSid returned the readable byte length for current_sid.
        let sid_bytes =
            unsafe { std::slice::from_raw_parts(current_sid.cast::<u8>(), sid_length as usize) };
        let spec = windows_mutex_spec(sid_bytes, key)?;
        let name = spec
            .name
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();

        let mut access = EXPLICIT_ACCESS_W::default();
        access.grfAccessPermissions = MUTEX_ALL_ACCESS;
        access.grfAccessMode = GRANT_ACCESS;
        access.grfInheritance = 0;
        access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
        access.Trustee.TrusteeType = TRUSTEE_IS_USER;
        access.Trustee.ptstrName = current_sid.cast();
        let mut acl = std::ptr::null_mut();
        // SAFETY: access references the live current-user SID and acl receives local allocation.
        let acl_status =
            unsafe { SetEntriesInAclW(1, &raw const access, std::ptr::null(), &raw mut acl) };
        let acl_allocation = LocalAllocation(acl.cast());
        if acl_status != ERROR_SUCCESS || acl.is_null() {
            return Err(platform_error());
        }
        let mut descriptor = SECURITY_DESCRIPTOR::default();
        // SAFETY: descriptor is writable and current_sid remains alive through CreateMutexW.
        if unsafe {
            InitializeSecurityDescriptor((&raw mut descriptor).cast(), 1) == 0
                || SetSecurityDescriptorOwner((&raw mut descriptor).cast(), current_sid, 0) == 0
                || SetSecurityDescriptorDacl((&raw mut descriptor).cast(), 1, acl, 0) == 0
        } {
            return Err(platform_error());
        }
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: (&raw mut descriptor).cast(),
            bInheritHandle: 0,
        };
        // SAFETY: the name and owner-only security attributes remain live for this call.
        let mutex = unsafe { CreateMutexW(&raw const attributes, 0, name.as_ptr()) };
        drop(acl_allocation);
        if mutex.is_null() {
            return Err(platform_error());
        }
        let mutex = OwnedHandle(mutex);

        let mut owner: PSID = std::ptr::null_mut();
        let mut dacl = std::ptr::null_mut();
        let mut security_descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: GetSecurityInfo initializes owner, dacl, and the allocated descriptor.
        let security_status = unsafe {
            GetSecurityInfo(
                mutex.0,
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
            // SAFETY: both SIDs are valid while their backing buffers remain alive.
            || unsafe { EqualSid(owner, current_sid) } == 0
        {
            return Err(platform_error());
        }
        let mut entry_count = 0;
        let mut entries = std::ptr::null_mut();
        // SAFETY: dacl is owned by security_descriptor and entries receives local allocation.
        let entries_status =
            unsafe { GetExplicitEntriesFromAclW(dacl, &raw mut entry_count, &raw mut entries) };
        let entries_allocation = LocalAllocation(entries.cast());
        if entries_status != ERROR_SUCCESS || entry_count != 1 || entries.is_null() {
            return Err(platform_error());
        }
        // SAFETY: the API returned exactly one initialized explicit entry.
        let entry = unsafe { &*entries };
        if entry.grfAccessPermissions != MUTEX_ALL_ACCESS
            || entry.grfAccessMode != GRANT_ACCESS
            || entry.grfInheritance != 0
            || !entry.Trustee.pMultipleTrustee.is_null()
            || entry.Trustee.TrusteeForm != TRUSTEE_IS_SID
            || entry.Trustee.TrusteeType != TRUSTEE_IS_USER
            || entry.Trustee.ptstrName.is_null()
            // SAFETY: trustee name is a SID for TRUSTEE_IS_SID.
            || unsafe { EqualSid(entry.Trustee.ptstrName.cast(), current_sid) } == 0
        {
            return Err(platform_error());
        }
        drop(entries_allocation);
        drop(descriptor_allocation);

        let timeout_millis = timeout.as_millis().min(u128::from(u32::MAX - 1)) as u32;
        // SAFETY: the mutex handle is live.
        let wait = unsafe { WaitForSingleObject(mutex.0, timeout_millis) };
        if wait == WAIT_TIMEOUT {
            return Err(NativeError::credential_update_in_progress());
        }
        if wait != WAIT_OBJECT_0 && wait != WAIT_ABANDONED {
            return Err(platform_error());
        }
        let handle = mutex.0;
        std::mem::forget(mutex);
        Ok(Self { handle })
    }
}

#[cfg(windows)]
impl Drop for PlatformCredentialLock {
    fn drop(&mut self) {
        use windows_sys::Win32::{Foundation::CloseHandle, System::Threading::ReleaseMutex};

        // SAFETY: this guard owns and acquired the mutex handle.
        unsafe {
            ReleaseMutex(self.handle);
            CloseHandle(self.handle);
        }
    }
}

#[cfg(not(any(unix, windows)))]
struct PlatformCredentialLock;

#[cfg(not(any(unix, windows)))]
impl PlatformCredentialLock {
    fn acquire(_key: &str, _timeout: std::time::Duration) -> Result<Self, NativeError> {
        Err(NativeError::platform_security_unavailable())
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::{
        os::unix::fs::{symlink, MetadataExt, PermissionsExt},
        path::PathBuf,
        sync::{mpsc, Arc, Mutex},
        time::Duration,
    };

    use super::{credential_key, CredentialMutationLock};

    fn lock_path(service: &str, account: &str) -> PathBuf {
        // SAFETY: geteuid has no preconditions.
        let uid = unsafe { libc::geteuid() };
        PathBuf::from(format!("/tmp/opencoven-chat-credential-locks-{uid}")).join(format!(
            "credential-{}.lock",
            credential_key(service, account)
        ))
    }

    struct TestLockedStore {
        service: String,
        account: String,
        stored: Arc<Mutex<Vec<u8>>>,
    }

    impl TestLockedStore {
        fn new(service: &str, account: &str, stored: Arc<Mutex<Vec<u8>>>) -> Self {
            Self {
                service: service.into(),
                account: account.into(),
                stored,
            }
        }

        fn replace_while_locked(
            &self,
            replacement: &[u8],
            acquired: mpsc::Sender<()>,
            release: mpsc::Receiver<()>,
        ) {
            let _lock = CredentialMutationLock::acquire(&self.service, &self.account)
                .expect("replacement store lock");
            acquired.send(()).expect("signal acquired lock");
            release.recv().expect("release replacement");
            *self.stored.lock().expect("test value lock") = replacement.to_vec();
        }

        fn compare_delete(
            &self,
            expected: &[u8],
            attempting: mpsc::Sender<()>,
            proceed: mpsc::Receiver<()>,
        ) -> &'static str {
            attempting.send(()).expect("signal rollback attempt");
            proceed.recv().expect("start rollback attempt");
            let _lock = CredentialMutationLock::acquire(&self.service, &self.account)
                .expect("rollback store lock");
            let mut stored = self.stored.lock().expect("test value lock");
            if stored.as_slice() != expected {
                return "changed";
            }
            stored.clear();
            "deleted"
        }
    }

    #[test]
    fn independent_store_instances_serialize_replacement_before_rollback() {
        let account = format!("test-{}", uuid::Uuid::new_v4());
        let stored = Arc::new(Mutex::new(b"old".to_vec()));
        let replacement = TestLockedStore::new("ai.opencoven.chat.test", &account, stored.clone());
        let rollback = TestLockedStore::new("ai.opencoven.chat.test", &account, stored.clone());
        let (acquired_tx, acquired_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let replacement_thread = std::thread::spawn(move || {
            replacement.replace_while_locked(b"replacement", acquired_tx, release_rx);
        });
        acquired_rx
            .recv()
            .expect("replacement acquired shared lock");

        let (attempting_tx, attempting_rx) = mpsc::channel();
        let (proceed_tx, proceed_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();
        let rollback_thread = std::thread::spawn(move || {
            finished_tx
                .send(rollback.compare_delete(b"old", attempting_tx, proceed_rx))
                .expect("send rollback result");
        });
        attempting_rx.recv().expect("rollback thread is ready");
        proceed_tx.send(()).expect("start rollback acquisition");
        assert!(
            finished_rx
                .recv_timeout(Duration::from_millis(500))
                .is_err(),
            "rollback must wait for the independently opened replacement store"
        );
        release_tx.send(()).expect("release replacement store");

        replacement_thread.join().expect("replacement thread");
        assert_eq!(
            finished_rx.recv().expect("rollback result"),
            "changed",
            "rollback must not delete the replacement"
        );
        rollback_thread.join().expect("rollback thread");
        assert_eq!(
            stored.lock().expect("test value lock").as_slice(),
            b"replacement"
        );
        std::fs::remove_file(lock_path("ai.opencoven.chat.test", &account))
            .expect("remove test lock");
    }

    #[test]
    fn unix_lock_file_is_empty_owner_private_and_never_follows_symlinks() {
        let service = "ai.opencoven.chat.test";
        let account = format!("test-{}", uuid::Uuid::new_v4());
        let lock = CredentialMutationLock::acquire(service, &account).expect("owner-private lock");
        let path = lock_path(service, &account);
        let metadata = std::fs::symlink_metadata(&path).expect("lock metadata");
        assert_eq!(metadata.len(), 0);
        assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
        assert_eq!(metadata.permissions().mode() & 0o077, 0);
        drop(lock);
        std::fs::remove_file(&path).expect("remove test lock");

        symlink("/dev/null", &path).expect("create hostile lock symlink");
        assert!(CredentialMutationLock::acquire(service, &account).is_err());
        std::fs::remove_file(path).expect("remove hostile lock symlink");
    }

    #[test]
    fn contended_lock_times_out_with_retryable_failure() {
        let service = "ai.opencoven.chat.test";
        let account = format!("test-{}", uuid::Uuid::new_v4());
        let first = CredentialMutationLock::acquire(service, &account).expect("first lock");
        let started = std::time::Instant::now();
        let error = CredentialMutationLock::acquire_with_timeout(
            service,
            &account,
            Duration::from_millis(50),
        )
        .err()
        .expect("second lock must not wait indefinitely");
        assert_eq!(
            error.code,
            crate::sdk_diagnostics::DiagnosticCode::CredentialUpdateInProgress
        );
        assert!(error.retryable);
        assert!(started.elapsed() < Duration::from_secs(1));
        drop(first);
        std::fs::remove_file(lock_path(service, &account)).expect("remove test lock");
    }
}

#[cfg(test)]
mod windows_contract_tests {
    use super::{
        windows_mutex_spec, windows_persistence_action, WindowsAclPolicy, WindowsPersistenceAction,
    };

    #[test]
    fn windows_credentials_are_local_machine_and_enterprise_values_migrate() {
        assert_eq!(
            windows_persistence_action(Some("Local")),
            WindowsPersistenceAction::Accept
        );
        assert_eq!(
            windows_persistence_action(Some("Enterprise")),
            WindowsPersistenceAction::Migrate
        );
        assert_eq!(
            windows_persistence_action(Some("Session")),
            WindowsPersistenceAction::Reject
        );
    }

    #[test]
    fn windows_mutex_spec_is_global_bounded_and_current_user_only() {
        let spec = windows_mutex_spec(&[7_u8; 28], &"a".repeat(64))
            .expect("bounded current-user mutex spec");
        assert!(spec.name.starts_with("Global\\OpenCoven.Chat.Credential."));
        assert!(spec.name.len() <= 240);
        assert_eq!(spec.acl, WindowsAclPolicy::CurrentUserFullControlOnly);
        assert!(!spec.name.contains("S-1-"));
    }
}
