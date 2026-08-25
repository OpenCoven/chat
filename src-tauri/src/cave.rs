use std::{
    path::{Path, PathBuf},
    process::{Child, Command},
    time::{Duration, Instant},
};

#[cfg(unix)]
use std::{env, fs, io::Read};

use async_trait::async_trait;
use serde::Serialize;
use sha2::{Digest, Sha256};
use url::{Host, Url};

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct NativeDiagnostic {
    pub code: &'static str,
    pub retryable: bool,
}

impl NativeDiagnostic {
    pub const fn new(code: &'static str, retryable: bool) -> Self {
        Self { code, retryable }
    }
}

pub type NativeResult<T> = Result<T, NativeDiagnostic>;

#[cfg(any(unix, windows))]
const DISCOVERY_FILE_NAME: &str = "client-v1-discovery.json";
#[cfg(any(unix, windows))]
const MAX_DISCOVERY_BYTES: u64 = 16 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerDiscoveryRecord {
    pub handle: String,
    pub bytes: Vec<u8>,
    pub record: OwnerDiscoveryRecordMetadata,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnerDiscoveryRecordMetadata {
    pub identity: String,
    pub device: u64,
    pub inode: u64,
    pub process_alive: bool,
}

#[derive(Clone)]
pub(crate) struct PinnedCaveAuthority {
    origin: Url,
    digest: [u8; 32],
    credential_binding: String,
    device: u64,
    inode: u64,
}

impl PinnedCaveAuthority {
    pub(crate) fn origin(&self) -> &Url {
        &self.origin
    }

    pub(crate) fn credential_binding(&self) -> &str {
        &self.credential_binding
    }

    pub(crate) fn is_same_pin(&self, other: &Self) -> bool {
        self.origin == other.origin
            && self.digest == other.digest
            && self.credential_binding == other.credential_binding
            && self.device == other.device
            && self.inode == other.inode
    }

    pub(crate) fn discovery_digest(bytes: &[u8]) -> [u8; 32] {
        Sha256::digest(bytes).into()
    }

    pub(crate) fn endpoint(&self, path: &str) -> NativeResult<Url> {
        self.origin
            .join(path)
            .map_err(|_| NativeDiagnostic::new("invalid_cave_destination", false))
    }

    pub(crate) fn matches_owner_record(&self, record: &OwnerDiscoveryRecord) -> bool {
        pin_owner_discovery_record(record, 0).is_ok_and(|candidate| self.is_same_pin(&candidate))
    }
}

pub(crate) trait CaveDiscoveryReader: Send + Sync {
    fn read(&self) -> NativeResult<OwnerDiscoveryRecord>;
}

#[derive(Default)]
pub(crate) struct NativeCaveDiscoveryReader;

impl CaveDiscoveryReader for NativeCaveDiscoveryReader {
    fn read(&self) -> NativeResult<OwnerDiscoveryRecord> {
        read_owner_discovery_record()
    }
}

#[cfg(unix)]
fn owner_discovery_root() -> NativeResult<PathBuf> {
    use std::os::unix::fs::MetadataExt;

    let root = env::var_os("COVEN_CAVE_HOME")
        .map(PathBuf::from)
        .or_else(|| {
            env::var_os("COVEN_HOME")
                .map(PathBuf::from)
                .map(|home| home.join("cave"))
        })
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".coven/cave")))
        .ok_or_else(|| NativeDiagnostic::new("cave_discovery_not_found", true))?;
    let metadata = fs::symlink_metadata(&root)
        .map_err(|_| NativeDiagnostic::new("cave_discovery_not_found", true))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o022 != 0
    {
        return Err(NativeDiagnostic::new("unsafe_discovery_record", false));
    }

    let canonical = root
        .canonicalize()
        .map_err(|_| NativeDiagnostic::new("unsafe_discovery_record", false))?;
    if canonical != root {
        return Err(NativeDiagnostic::new("unsafe_discovery_record", false));
    }
    Ok(canonical)
}

#[cfg(unix)]
fn read_owner_discovery_record() -> NativeResult<OwnerDiscoveryRecord> {
    use std::fs::OpenOptions;
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};

    let root = owner_discovery_root()?;
    let path = root.join(DISCOVERY_FILE_NAME);
    let initial = fs::symlink_metadata(&path)
        .map_err(|_| NativeDiagnostic::new("cave_discovery_not_found", true))?;
    if initial.file_type().is_symlink()
        || !initial.is_file()
        || initial.uid() != unsafe { libc::geteuid() }
        || initial.mode() & 0o077 != 0
        || initial.len() > MAX_DISCOVERY_BYTES
    {
        return Err(NativeDiagnostic::new("unsafe_discovery_record", false));
    }

    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&path)
        .map_err(|_| NativeDiagnostic::new("unsafe_discovery_record", false))?;
    let opened = file
        .metadata()
        .map_err(|_| NativeDiagnostic::new("unsafe_discovery_record", false))?;
    if !opened.is_file()
        || opened.uid() != unsafe { libc::geteuid() }
        || opened.mode() & 0o077 != 0
        || opened.len() > MAX_DISCOVERY_BYTES
        || opened.dev() != initial.dev()
        || opened.ino() != initial.ino()
    {
        return Err(NativeDiagnostic::new("unsafe_discovery_record", false));
    }

    let mut bytes = Vec::with_capacity(opened.len() as usize);
    file.read_to_end(&mut bytes)
        .map_err(|_| NativeDiagnostic::new("cave_discovery_unavailable", true))?;
    if bytes.len() > MAX_DISCOVERY_BYTES as usize {
        return Err(NativeDiagnostic::new("discovery_body_limit", false));
    }
    let process_alive = record_process_is_alive(&bytes);

    let identity = {
        use std::os::unix::ffi::OsStrExt;

        format!("{:x}", Sha256::digest(path.as_os_str().as_bytes()))
    };
    Ok(OwnerDiscoveryRecord {
        handle: String::new(),
        bytes,
        record: OwnerDiscoveryRecordMetadata {
            identity,
            device: opened.dev(),
            inode: opened.ino(),
            process_alive,
        },
    })
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy)]
struct WindowsFileMetadata {
    is_directory: bool,
    is_regular: bool,
    is_reparse_point: bool,
    owner_matches_current_user: bool,
    len: u64,
    volume_serial: u64,
    file_index: u64,
}

#[cfg(any(windows, test))]
#[derive(Clone)]
struct WindowsOpenedDiscovery {
    initial: WindowsFileMetadata,
    opened: WindowsFileMetadata,
    bytes: Vec<u8>,
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy)]
enum WindowsDiscoveryIoError {
    Missing,
    Unavailable,
}

#[cfg(any(windows, test))]
trait WindowsDiscoveryBackend {
    fn canonical_root(&self) -> Result<PathBuf, WindowsDiscoveryIoError>;
    fn open_directory(&self, path: &Path) -> Result<WindowsFileMetadata, WindowsDiscoveryIoError>;
    fn open_discovery(
        &self,
        path: &Path,
    ) -> Result<WindowsOpenedDiscovery, WindowsDiscoveryIoError>;
    fn owner_identity(&self) -> Result<String, WindowsDiscoveryIoError>;
}

#[cfg(any(windows, test))]
fn windows_discovery_error(error: WindowsDiscoveryIoError) -> NativeDiagnostic {
    match error {
        WindowsDiscoveryIoError::Missing => NativeDiagnostic::new("cave_discovery_not_found", true),
        WindowsDiscoveryIoError::Unavailable => {
            NativeDiagnostic::new("cave_discovery_unavailable", true)
        }
    }
}

#[cfg(any(windows, test))]
fn same_windows_file(left: WindowsFileMetadata, right: WindowsFileMetadata) -> bool {
    left.volume_serial == right.volume_serial && left.file_index == right.file_index
}

#[cfg(any(windows, test))]
fn validate_windows_directory(metadata: WindowsFileMetadata) -> NativeResult<()> {
    if !metadata.is_directory
        || metadata.is_regular
        || metadata.is_reparse_point
        || !metadata.owner_matches_current_user
    {
        return Err(NativeDiagnostic::new("unsafe_discovery_record", false));
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn validate_windows_file(metadata: WindowsFileMetadata) -> NativeResult<()> {
    if !metadata.is_regular
        || metadata.is_directory
        || metadata.is_reparse_point
        || !metadata.owner_matches_current_user
        || metadata.file_index == 0
    {
        return Err(NativeDiagnostic::new("unsafe_discovery_record", false));
    }
    if metadata.len > MAX_DISCOVERY_BYTES {
        return Err(NativeDiagnostic::new("discovery_body_limit", false));
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn read_windows_discovery_with(
    backend: &dyn WindowsDiscoveryBackend,
) -> NativeResult<OwnerDiscoveryRecord> {
    let root = backend.canonical_root().map_err(windows_discovery_error)?;
    let coven = root.join(".coven");
    let cave = coven.join("cave");
    for directory in [&root, &coven, &cave] {
        validate_windows_directory(
            backend
                .open_directory(directory)
                .map_err(windows_discovery_error)?,
        )?;
    }

    let opened = backend
        .open_discovery(&cave.join(DISCOVERY_FILE_NAME))
        .map_err(windows_discovery_error)?;
    validate_windows_file(opened.initial)?;
    validate_windows_file(opened.opened)?;
    if !same_windows_file(opened.initial, opened.opened) {
        return Err(NativeDiagnostic::new("unsafe_discovery_record", false));
    }
    if opened.bytes.len() > MAX_DISCOVERY_BYTES as usize {
        return Err(NativeDiagnostic::new("discovery_body_limit", false));
    }

    Ok(OwnerDiscoveryRecord {
        handle: String::new(),
        bytes: opened.bytes,
        record: OwnerDiscoveryRecordMetadata {
            identity: backend.owner_identity().map_err(windows_discovery_error)?,
            device: opened.opened.volume_serial,
            inode: opened.opened.file_index,
            process_alive: false,
        },
    })
}

#[cfg(windows)]
mod windows_discovery {
    use std::{
        ffi::OsString,
        fs::File,
        io::Read,
        os::windows::{
            ffi::{OsStrExt, OsStringExt},
            io::{AsRawHandle, FromRawHandle},
        },
        path::{Path, PathBuf},
        ptr,
    };

    use sha2::{Digest, Sha256};
    use windows_sys::Win32::{
        Foundation::{
            CloseHandle, GetLastError, LocalFree, ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND,
            GENERIC_ALL, GENERIC_WRITE, HANDLE, INVALID_HANDLE_VALUE,
        },
        Security::{
            AclSizeInformation,
            Authorization::{GetSecurityInfo, SE_FILE_OBJECT},
            EqualSid, GetAce, GetAclInformation, GetLengthSid, GetTokenInformation, IsWellKnownSid,
            TokenUser, WinBuiltinAdministratorsSid, WinLocalSystemSid, ACCESS_ALLOWED_ACE,
            ACE_HEADER, ACL, ACL_SIZE_INFORMATION, DACL_SECURITY_INFORMATION,
            OWNER_SECURITY_INFORMATION, TOKEN_QUERY, TOKEN_USER,
        },
        Storage::FileSystem::{
            CreateFileW, GetFileInformationByHandle, GetFileType, BY_HANDLE_FILE_INFORMATION,
            DELETE, FILE_APPEND_DATA, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT,
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_GENERIC_READ,
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, FILE_TYPE_DISK,
            FILE_WRITE_ATTRIBUTES, FILE_WRITE_DATA, FILE_WRITE_EA, OPEN_EXISTING, WRITE_DAC,
            WRITE_OWNER,
        },
        System::{
            SystemServices::ACCESS_ALLOWED_ACE_TYPE,
            Threading::{GetCurrentProcess, OpenProcessToken},
        },
        UI::Shell::GetUserProfileDirectoryW,
    };

    use super::{
        WindowsDiscoveryBackend, WindowsDiscoveryIoError, WindowsFileMetadata,
        WindowsOpenedDiscovery, MAX_DISCOVERY_BYTES,
    };

    struct Handle(HANDLE);

    impl Handle {
        fn into_raw(self) -> HANDLE {
            let handle = self.0;
            std::mem::forget(self);
            handle
        }
    }

    impl Drop for Handle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }

    pub(super) struct NativeWindowsDiscovery {
        root: PathBuf,
        sid: Vec<u8>,
        identity: String,
    }

    impl NativeWindowsDiscovery {
        pub(super) fn new() -> Result<Self, WindowsDiscoveryIoError> {
            let token = open_current_token()?;
            let sid = token_user_sid(token.0)?;
            let root = user_profile_directory(token.0)?;
            let identity = format!("{:x}", Sha256::digest(&sid));
            Ok(Self {
                root,
                sid,
                identity,
            })
        }

        fn open(&self, path: &Path, directory: bool) -> Result<Handle, WindowsDiscoveryIoError> {
            let mut wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
            wide.push(0);
            let flags = FILE_FLAG_OPEN_REPARSE_POINT
                | if directory {
                    FILE_FLAG_BACKUP_SEMANTICS
                } else {
                    0
                };
            let handle = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    FILE_GENERIC_READ,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    ptr::null(),
                    OPEN_EXISTING,
                    flags,
                    ptr::null_mut(),
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                return Err(last_file_error());
            }
            Ok(Handle(handle))
        }

        fn metadata(&self, handle: HANDLE) -> Result<WindowsFileMetadata, WindowsDiscoveryIoError> {
            let mut information = unsafe { std::mem::zeroed::<BY_HANDLE_FILE_INFORMATION>() };
            if unsafe { GetFileInformationByHandle(handle, &mut information) } == 0 {
                return Err(WindowsDiscoveryIoError::Unavailable);
            }
            let owner_matches_current_user = owner_matches(handle, &self.sid)?;
            let attributes = information.dwFileAttributes;
            let is_directory = attributes & FILE_ATTRIBUTE_DIRECTORY != 0;
            Ok(WindowsFileMetadata {
                is_directory,
                is_regular: !is_directory && unsafe { GetFileType(handle) } == FILE_TYPE_DISK,
                is_reparse_point: attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0,
                owner_matches_current_user,
                len: ((information.nFileSizeHigh as u64) << 32) | information.nFileSizeLow as u64,
                volume_serial: information.dwVolumeSerialNumber as u64,
                file_index: ((information.nFileIndexHigh as u64) << 32)
                    | information.nFileIndexLow as u64,
            })
        }
    }

    pub(super) fn current_user_identity() -> Result<String, WindowsDiscoveryIoError> {
        NativeWindowsDiscovery::new().map(|discovery| discovery.identity)
    }

    impl WindowsDiscoveryBackend for NativeWindowsDiscovery {
        fn canonical_root(&self) -> Result<PathBuf, WindowsDiscoveryIoError> {
            Ok(self.root.clone())
        }

        fn open_directory(
            &self,
            path: &Path,
        ) -> Result<WindowsFileMetadata, WindowsDiscoveryIoError> {
            let handle = self.open(path, true)?;
            self.metadata(handle.0)
        }

        fn open_discovery(
            &self,
            path: &Path,
        ) -> Result<WindowsOpenedDiscovery, WindowsDiscoveryIoError> {
            let initial_handle = self.open(path, false)?;
            let initial = self.metadata(initial_handle.0)?;
            let opened_handle = self.open(path, false)?;
            let opened = self.metadata(opened_handle.0)?;
            let mut file = unsafe { File::from_raw_handle(opened_handle.into_raw() as _) };
            let mut bytes = Vec::with_capacity(opened.len.min(MAX_DISCOVERY_BYTES) as usize);
            file.by_ref()
                .take(MAX_DISCOVERY_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| WindowsDiscoveryIoError::Unavailable)?;
            Ok(WindowsOpenedDiscovery {
                initial,
                opened: self.metadata(file.as_raw_handle() as _)?,
                bytes,
            })
        }

        fn owner_identity(&self) -> Result<String, WindowsDiscoveryIoError> {
            Ok(self.identity.clone())
        }
    }

    fn open_current_token() -> Result<Handle, WindowsDiscoveryIoError> {
        let mut token = ptr::null_mut();
        if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
            return Err(WindowsDiscoveryIoError::Unavailable);
        }
        Ok(Handle(token))
    }

    fn token_user_sid(token: HANDLE) -> Result<Vec<u8>, WindowsDiscoveryIoError> {
        let mut length = 0;
        unsafe {
            GetTokenInformation(token, TokenUser, ptr::null_mut(), 0, &mut length);
        }
        if length == 0 {
            return Err(WindowsDiscoveryIoError::Unavailable);
        }
        let mut buffer = vec![0_u8; length as usize];
        if unsafe {
            GetTokenInformation(
                token,
                TokenUser,
                buffer.as_mut_ptr().cast(),
                length,
                &mut length,
            )
        } == 0
        {
            return Err(WindowsDiscoveryIoError::Unavailable);
        }
        let user = unsafe { &*(buffer.as_ptr().cast::<TOKEN_USER>()) };
        let sid_length = unsafe { GetLengthSid(user.User.Sid) };
        if sid_length == 0 {
            return Err(WindowsDiscoveryIoError::Unavailable);
        }
        let sid = unsafe {
            std::slice::from_raw_parts(user.User.Sid.cast::<u8>(), sid_length as usize).to_vec()
        };
        Ok(sid)
    }

    fn user_profile_directory(token: HANDLE) -> Result<PathBuf, WindowsDiscoveryIoError> {
        let mut length = 0;
        unsafe {
            GetUserProfileDirectoryW(token, ptr::null_mut(), &mut length);
        }
        if length == 0 {
            return Err(WindowsDiscoveryIoError::Unavailable);
        }
        let mut buffer = vec![0_u16; length as usize];
        if unsafe { GetUserProfileDirectoryW(token, buffer.as_mut_ptr(), &mut length) } == 0 {
            return Err(WindowsDiscoveryIoError::Unavailable);
        }
        let length = buffer
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(buffer.len());
        Ok(PathBuf::from(OsString::from_wide(&buffer[..length])))
    }

    fn owner_matches(
        handle: HANDLE,
        current_user_sid: &[u8],
    ) -> Result<bool, WindowsDiscoveryIoError> {
        let mut owner = ptr::null_mut();
        let mut dacl = ptr::null_mut();
        let mut descriptor = ptr::null_mut();
        let result = unsafe {
            GetSecurityInfo(
                handle,
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
                &mut owner,
                ptr::null_mut(),
                &mut dacl,
                ptr::null_mut(),
                &mut descriptor,
            )
        };
        if result != 0 {
            return Err(WindowsDiscoveryIoError::Unavailable);
        }
        let owner_matches = !owner.is_null()
            && unsafe { EqualSid(owner, current_user_sid.as_ptr().cast_mut().cast()) } != 0;
        let dacl_is_safe = dacl_permits_only_trusted_writers(dacl, current_user_sid);
        unsafe {
            LocalFree(descriptor.cast());
        }
        Ok(owner_matches && dacl_is_safe?)
    }

    fn dacl_permits_only_trusted_writers(
        dacl: *mut ACL,
        current_user_sid: &[u8],
    ) -> Result<bool, WindowsDiscoveryIoError> {
        if dacl.is_null() {
            return Ok(false);
        }
        let mut information = unsafe { std::mem::zeroed::<ACL_SIZE_INFORMATION>() };
        if unsafe {
            GetAclInformation(
                dacl,
                (&mut information as *mut ACL_SIZE_INFORMATION).cast(),
                std::mem::size_of::<ACL_SIZE_INFORMATION>() as u32,
                AclSizeInformation,
            )
        } == 0
        {
            return Err(WindowsDiscoveryIoError::Unavailable);
        }
        for index in 0..information.AceCount {
            let mut ace = ptr::null_mut();
            if unsafe { GetAce(dacl, index, &mut ace) } == 0 {
                return Err(WindowsDiscoveryIoError::Unavailable);
            }
            let header = unsafe { &*ace.cast::<ACE_HEADER>() };
            if header.AceType as u32 != ACCESS_ALLOWED_ACE_TYPE {
                return Ok(false);
            }
            let allowed = unsafe { &*ace.cast::<ACCESS_ALLOWED_ACE>() };
            if allowed.Mask & writable_file_rights() != 0
                && !trusted_writer(
                    (&allowed.SidStart as *const u32).cast_mut().cast(),
                    current_user_sid,
                )
            {
                return Ok(false);
            }
        }
        Ok(true)
    }

    fn writable_file_rights() -> u32 {
        GENERIC_ALL
            | GENERIC_WRITE
            | FILE_WRITE_DATA
            | FILE_APPEND_DATA
            | FILE_WRITE_EA
            | FILE_WRITE_ATTRIBUTES
            | DELETE
            | WRITE_DAC
            | WRITE_OWNER
    }

    fn trusted_writer(sid: *mut std::ffi::c_void, current_user_sid: &[u8]) -> bool {
        (unsafe { EqualSid(sid, current_user_sid.as_ptr().cast_mut().cast()) } != 0)
            || (unsafe { IsWellKnownSid(sid, WinLocalSystemSid) } != 0)
            || (unsafe { IsWellKnownSid(sid, WinBuiltinAdministratorsSid) } != 0)
    }

    fn last_file_error() -> WindowsDiscoveryIoError {
        match unsafe { GetLastError() } {
            ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND => WindowsDiscoveryIoError::Missing,
            _ => WindowsDiscoveryIoError::Unavailable,
        }
    }
}

#[cfg(windows)]
fn read_owner_discovery_record() -> NativeResult<OwnerDiscoveryRecord> {
    let backend =
        windows_discovery::NativeWindowsDiscovery::new().map_err(windows_discovery_error)?;
    read_windows_discovery_with(&backend)
}

#[cfg(windows)]
pub(crate) fn current_windows_user_identity() -> Result<String, ()> {
    windows_discovery::current_user_identity().map_err(|_| ())
}

#[cfg(all(not(unix), not(windows)))]
fn read_owner_discovery_record() -> NativeResult<OwnerDiscoveryRecord> {
    Err(NativeDiagnostic::new("native_discovery_unavailable", true))
}

#[cfg(unix)]
fn record_process_is_alive(bytes: &[u8]) -> bool {
    let Some(pid) = serde_json::from_slice::<serde_json::Value>(bytes)
        .ok()
        .and_then(|record| record.get("pid").and_then(serde_json::Value::as_i64))
        .filter(|pid| *pid > 0)
    else {
        return false;
    };
    let result = unsafe { libc::kill(pid as libc::pid_t, 0) };
    result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/*
 * This is native transport binding only. The packed SDK remains the sole
 * discovery-record and Client v1 protocol parser; native code reads only the
 * loopback origin needed to constrain its privileged HTTP client.
 */
pub(crate) fn pin_owner_discovery_record(
    record: &OwnerDiscoveryRecord,
    generation: u64,
) -> NativeResult<PinnedCaveAuthority> {
    let value: serde_json::Value = serde_json::from_slice(&record.bytes)
        .map_err(|_| NativeDiagnostic::new("invalid_discovery_record", false))?;
    let endpoint = value
        .get("endpoint")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| NativeDiagnostic::new("invalid_discovery_record", false))?;
    let mut origin = Url::parse(endpoint)
        .map_err(|_| NativeDiagnostic::new("invalid_discovery_record", false))?;
    validate_loopback_origin(&origin)?;
    origin.set_path("/");

    let _ = generation;
    Ok(PinnedCaveAuthority {
        origin,
        digest: PinnedCaveAuthority::discovery_digest(&record.bytes),
        credential_binding: record.record.identity.clone(),
        device: record.record.device,
        inode: record.record.inode,
    })
}

fn validate_loopback_origin(url: &Url) -> NativeResult<()> {
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
        || !matches!(url.path(), "" | "/")
    {
        return Err(NativeDiagnostic::new("unsafe_discovery_record", false));
    }
    Ok(())
}

pub(crate) trait CaveClock: Send + Sync {
    fn now(&self) -> Duration;
}

#[derive(Clone)]
pub(crate) struct NativeCaveClock {
    started_at: Instant,
}

impl Default for NativeCaveClock {
    fn default() -> Self {
        Self {
            started_at: Instant::now(),
        }
    }
}

impl CaveClock for NativeCaveClock {
    fn now(&self) -> Duration {
        self.started_at.elapsed()
    }
}

#[async_trait]
pub(crate) trait CaveSleeper: Send + Sync {
    async fn sleep(&self, duration: Duration);
}

#[derive(Default)]
pub(crate) struct NativeCaveSleeper;

#[async_trait]
impl CaveSleeper for NativeCaveSleeper {
    async fn sleep(&self, duration: Duration) {
        tokio::time::sleep(duration).await;
    }
}

pub(crate) trait CaveTaskRunner: Send + Sync {
    fn execute(&self, task: Box<dyn FnOnce() + Send>) -> NativeResult<()>;
}

#[derive(Default)]
pub(crate) struct NativeCaveTaskRunner;

impl CaveTaskRunner for NativeCaveTaskRunner {
    fn execute(&self, task: Box<dyn FnOnce() + Send>) -> NativeResult<()> {
        std::thread::Builder::new()
            .name("opencoven-cave-worker".to_owned())
            .spawn(task)
            .map(|_| ())
            .map_err(|_| NativeDiagnostic::new("service_unavailable", true))
    }
}

pub(crate) trait CaveChild: Send {
    fn try_wait(&mut self) -> NativeResult<bool>;
    fn terminate(&mut self) -> NativeResult<()>;
    fn wait(&mut self) -> NativeResult<()>;
}

pub(crate) trait CaveLauncher: Send + Sync {
    fn launch(&self) -> NativeResult<Box<dyn CaveChild>>;
}

pub(crate) struct NativeCaveLauncher;

struct NativeChild(Child);

impl CaveChild for NativeChild {
    fn try_wait(&mut self) -> NativeResult<bool> {
        self.0
            .try_wait()
            .map(|status| status.is_some())
            .map_err(|_| NativeDiagnostic::new("cave_launch_failed", true))
    }

    fn terminate(&mut self) -> NativeResult<()> {
        match self.0.kill() {
            Ok(()) | Err(_) => {}
        }
        Ok(())
    }

    fn wait(&mut self) -> NativeResult<()> {
        self.0
            .wait()
            .map(|_| ())
            .map_err(|_| NativeDiagnostic::new("cave_launch_failed", true))
    }
}

impl CaveLauncher for NativeCaveLauncher {
    fn launch(&self) -> NativeResult<Box<dyn CaveChild>> {
        Ok(Box::new(NativeChild(launch_installed_cave()?)))
    }
}

pub(crate) fn approved_cave_paths() -> &'static [&'static str] {
    #[cfg(target_os = "macos")]
    {
        &["/Applications/OpenCoven Cave.app/Contents/MacOS/OpenCoven Cave"]
    }

    #[cfg(target_os = "windows")]
    {
        &[
            r"C:\Program Files\OpenCoven Cave\OpenCoven Cave.exe",
            r"C:\Program Files (x86)\OpenCoven Cave\OpenCoven Cave.exe",
        ]
    }

    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    {
        &["/opt/opencoven-cave/opencoven-cave"]
    }
}

pub(crate) fn resolve_installed_cave_binary() -> NativeResult<PathBuf> {
    resolve_installed_cave_binary_from(|candidate| candidate.is_file())
}

pub(crate) fn resolve_installed_cave_binary_from(
    is_installed_file: impl Fn(&Path) -> bool,
) -> NativeResult<PathBuf> {
    approved_cave_paths()
        .iter()
        .map(PathBuf::from)
        .find(|candidate| is_installed_file(candidate))
        .ok_or_else(|| NativeDiagnostic::new("cave_not_installed", true))
}

pub(crate) fn build_cave_command(path: &Path) -> Command {
    Command::new(path)
}

pub(crate) fn launch_installed_cave() -> NativeResult<Child> {
    let executable = resolve_installed_cave_binary()?;
    build_cave_command(&executable)
        .spawn()
        .map_err(|_| NativeDiagnostic::new("cave_launch_failed", true))
}

#[cfg(test)]
mod tests {
    #[cfg(not(windows))]
    use std::{
        collections::VecDeque,
        path::{Path, PathBuf},
        sync::Mutex,
    };

    use serde_json::json;

    #[cfg(unix)]
    use super::record_process_is_alive;
    #[cfg(unix)]
    use super::{approved_cave_paths, build_cave_command, resolve_installed_cave_binary_from};
    use super::{pin_owner_discovery_record, OwnerDiscoveryRecord, OwnerDiscoveryRecordMetadata};

    #[cfg(not(windows))]
    use super::{
        read_windows_discovery_with, WindowsDiscoveryBackend, WindowsDiscoveryIoError,
        WindowsFileMetadata, WindowsOpenedDiscovery,
    };

    #[cfg(unix)]
    #[test]
    fn cave_launch_resolves_and_uses_an_exact_approved_installed_path() {
        let approved = Path::new(approved_cave_paths()[0]);
        let executable =
            resolve_installed_cave_binary_from(|candidate| candidate == approved).unwrap();
        assert_eq!(build_cave_command(&executable).get_program(), approved);
    }

    #[test]
    fn owner_checked_record_pins_only_a_loopback_origin() {
        let record = OwnerDiscoveryRecord {
            handle: String::new(),
            bytes: serde_json::to_vec(&json!({
                "version": 1,
                "endpoint": "http://127.0.0.1:4310",
                "pid": 1,
                "nonce": "not-validated-here",
                "startedAt": "2026-01-01T00:00:00Z",
            }))
            .unwrap(),
            record: OwnerDiscoveryRecordMetadata {
                identity: "record".to_owned(),
                device: 1,
                inode: 2,
                process_alive: true,
            },
        };

        assert_eq!(
            pin_owner_discovery_record(&record, 3)
                .unwrap()
                .origin()
                .as_str(),
            "http://127.0.0.1:4310/",
        );
    }

    #[cfg(unix)]
    #[test]
    fn discovery_metadata_reports_a_dead_record_process_as_not_alive() {
        assert!(!record_process_is_alive(br#"{ "pid": -1 }"#));
    }

    #[cfg(not(windows))]
    #[derive(Default)]
    struct FakeWindowsDiscovery {
        root: PathBuf,
        directories: Mutex<VecDeque<Result<WindowsFileMetadata, WindowsDiscoveryIoError>>>,
        file: Option<Result<WindowsOpenedDiscovery, WindowsDiscoveryIoError>>,
        identity: String,
    }

    #[cfg(not(windows))]
    impl WindowsDiscoveryBackend for FakeWindowsDiscovery {
        fn canonical_root(&self) -> Result<PathBuf, WindowsDiscoveryIoError> {
            Ok(self.root.clone())
        }

        fn open_directory(
            &self,
            _path: &Path,
        ) -> Result<WindowsFileMetadata, WindowsDiscoveryIoError> {
            self.directories
                .lock()
                .expect("directory queue")
                .pop_front()
                .expect("directory result")
        }

        fn open_discovery(
            &self,
            _path: &Path,
        ) -> Result<WindowsOpenedDiscovery, WindowsDiscoveryIoError> {
            self.file.clone().expect("discovery result")
        }

        fn owner_identity(&self) -> Result<String, WindowsDiscoveryIoError> {
            Ok(self.identity.clone())
        }
    }

    #[cfg(not(windows))]
    fn safe_windows_metadata(volume_serial: u64, file_index: u64) -> WindowsFileMetadata {
        WindowsFileMetadata {
            is_directory: false,
            is_regular: true,
            is_reparse_point: false,
            owner_matches_current_user: true,
            len: 42,
            volume_serial,
            file_index,
        }
    }

    #[cfg(not(windows))]
    fn windows_error_code(result: super::NativeResult<OwnerDiscoveryRecord>) -> &'static str {
        match result {
            Err(error) => error.code,
            Ok(_) => panic!("expected Windows discovery to fail"),
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn windows_discovery_rejects_foreign_owner_and_reparse_points() {
        let root = PathBuf::from(r"C:\Users\Coven");
        let directory = WindowsFileMetadata {
            is_directory: true,
            is_regular: false,
            ..safe_windows_metadata(1, 2)
        };
        let discovery = WindowsOpenedDiscovery {
            initial: safe_windows_metadata(1, 3),
            opened: safe_windows_metadata(1, 3),
            bytes: br#"{"endpoint":"http://127.0.0.1:4310"}"#.to_vec(),
        };

        let foreign_owner = FakeWindowsDiscovery {
            root: root.clone(),
            directories: Mutex::new(VecDeque::from(vec![
                Ok(directory),
                Ok(directory),
                Ok(WindowsFileMetadata {
                    owner_matches_current_user: false,
                    ..directory
                }),
            ])),
            file: Some(Ok(discovery.clone())),
            identity: "current-user".to_owned(),
        };
        assert_eq!(
            windows_error_code(read_windows_discovery_with(&foreign_owner)),
            "unsafe_discovery_record"
        );

        let reparse = FakeWindowsDiscovery {
            root,
            directories: Mutex::new(VecDeque::from(vec![
                Ok(directory),
                Ok(WindowsFileMetadata {
                    is_reparse_point: true,
                    ..directory
                }),
                Ok(directory),
            ])),
            file: Some(Ok(discovery)),
            identity: "current-user".to_owned(),
        };
        assert_eq!(
            windows_error_code(read_windows_discovery_with(&reparse)),
            "unsafe_discovery_record"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn windows_discovery_preserves_missing_and_unavailable_results() {
        let missing = FakeWindowsDiscovery {
            root: PathBuf::from(r"C:\Users\Coven"),
            directories: Mutex::new(VecDeque::from(vec![Err(WindowsDiscoveryIoError::Missing)])),
            file: None,
            identity: "current-user".to_owned(),
        };
        assert_eq!(
            windows_error_code(read_windows_discovery_with(&missing)),
            "cave_discovery_not_found"
        );

        let unavailable = FakeWindowsDiscovery {
            root: PathBuf::from(r"C:\Users\Coven"),
            directories: Mutex::new(VecDeque::from(vec![Err(
                WindowsDiscoveryIoError::Unavailable,
            )])),
            file: None,
            identity: "current-user".to_owned(),
        };
        assert_eq!(
            windows_error_code(read_windows_discovery_with(&unavailable)),
            "cave_discovery_unavailable"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn windows_discovery_rejects_file_replacement_before_reading() {
        let root = PathBuf::from(r"C:\Users\Coven");
        let directory = WindowsFileMetadata {
            is_directory: true,
            is_regular: false,
            ..safe_windows_metadata(1, 2)
        };
        let reader = FakeWindowsDiscovery {
            root,
            directories: Mutex::new(VecDeque::from(vec![
                Ok(directory),
                Ok(directory),
                Ok(directory),
            ])),
            file: Some(Ok(WindowsOpenedDiscovery {
                initial: safe_windows_metadata(1, 3),
                opened: safe_windows_metadata(1, 4),
                bytes: br#"{"endpoint":"http://127.0.0.1:4310"}"#.to_vec(),
            })),
            identity: "current-user".to_owned(),
        };

        assert_eq!(
            windows_error_code(read_windows_discovery_with(&reader)),
            "unsafe_discovery_record"
        );
    }
}
