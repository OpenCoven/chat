use sha2::{Digest, Sha256};

use crate::sdk_diagnostics::NativeError;

pub(crate) struct CredentialMutationLock {
    _platform: PlatformCredentialLock,
}

impl CredentialMutationLock {
    pub(crate) fn acquire(service: &str, account: &str) -> Result<Self, NativeError> {
        let key = credential_key(service, account);
        Ok(Self {
            _platform: PlatformCredentialLock::acquire(&key)?,
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

#[cfg(unix)]
struct PlatformCredentialLock {
    _file: std::fs::File,
}

#[cfg(unix)]
impl PlatformCredentialLock {
    fn acquire(key: &str) -> Result<Self, NativeError> {
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
        loop {
            // SAFETY: flock operates on the live lock-file descriptor.
            if unsafe { libc::flock(descriptor, libc::LOCK_EX) } == 0 {
                break;
            }
            if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
                return Err(platform_error());
            }
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
    fn acquire(key: &str) -> Result<Self, NativeError> {
        use windows_sys::Win32::{
            Foundation::{
                CloseHandle, LocalFree, ERROR_SUCCESS, HANDLE, HLOCAL, WAIT_ABANDONED,
                WAIT_OBJECT_0,
            },
            Security::{
                Authorization::{GetSecurityInfo, SE_KERNEL_OBJECT},
                EqualSid, GetLengthSid, GetTokenInformation, TokenUser, OWNER_SECURITY_INFORMATION,
                PSECURITY_DESCRIPTOR, PSID, TOKEN_QUERY, TOKEN_USER,
            },
            System::Threading::{
                CreateMutexW, GetCurrentProcess, OpenProcessToken, WaitForSingleObject, INFINITE,
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
        let user_key = Sha256::digest(sid_bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let name = format!("Local\\OpenCoven.Chat.Credential.{user_key}.{key}")
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        // SAFETY: the name is NUL-terminated and the default DACL comes from the current token.
        let mutex = unsafe { CreateMutexW(std::ptr::null(), 0, name.as_ptr()) };
        if mutex.is_null() {
            return Err(platform_error());
        }
        let mutex = OwnedHandle(mutex);

        let mut owner: PSID = std::ptr::null_mut();
        let mut security_descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        // SAFETY: GetSecurityInfo initializes owner and the allocated security descriptor.
        let security_status = unsafe {
            GetSecurityInfo(
                mutex.0,
                SE_KERNEL_OBJECT,
                OWNER_SECURITY_INFORMATION,
                &raw mut owner,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                &raw mut security_descriptor,
            )
        };
        if security_status != ERROR_SUCCESS
            || owner.is_null()
            || security_descriptor.is_null()
            // SAFETY: both SIDs are valid while their backing buffers remain alive.
            || unsafe { EqualSid(owner, current_sid) } == 0
        {
            if !security_descriptor.is_null() {
                // SAFETY: GetSecurityInfo allocated this descriptor with LocalAlloc.
                unsafe {
                    LocalFree(security_descriptor as HLOCAL);
                }
            }
            return Err(platform_error());
        }
        // SAFETY: GetSecurityInfo allocated this descriptor with LocalAlloc.
        unsafe {
            LocalFree(security_descriptor as HLOCAL);
        }

        // SAFETY: the mutex handle is live.
        let wait = unsafe { WaitForSingleObject(mutex.0, INFINITE) };
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
    fn acquire(_key: &str) -> Result<Self, NativeError> {
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
}
