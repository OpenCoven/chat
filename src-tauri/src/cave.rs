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
    fn process_liveness(&self, bytes: &[u8]) -> NativeResult<bool>;
}

#[cfg(any(windows, test))]
trait WindowsProcessInspector {
    fn inspect_process(&self, pid: u32) -> NativeResult<WindowsProcessState>;
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy)]
enum WindowsProcessState {
    Exited,
    NotFound,
    Running { creation_time: u64 },
}

#[cfg(any(windows, test))]
#[derive(Clone, Copy, Debug)]
struct WindowsDiscoveryStartedAt {
    filetime: u64,
}

#[cfg(any(windows, test))]
fn parse_windows_discovery_liveness_metadata(
    bytes: &[u8],
) -> NativeResult<(u32, WindowsDiscoveryStartedAt)> {
    /*
     * This extracts only process-liveness metadata from the already bounded
     * record. The packed SDK remains authoritative for the record schema.
     */
    let value: serde_json::Value = serde_json::from_slice(bytes)
        .map_err(|_| NativeDiagnostic::new("invalid_discovery_record", false))?;
    let pid = value
        .get("pid")
        .and_then(serde_json::Value::as_i64)
        .and_then(|pid| u32::try_from(pid).ok())
        .filter(|pid| *pid != 0)
        .ok_or_else(|| NativeDiagnostic::new("invalid_discovery_record", false))?;
    let started_at = value
        .get("startedAt")
        .and_then(serde_json::Value::as_str)
        .and_then(parse_windows_discovery_started_at)
        .ok_or_else(|| NativeDiagnostic::new("invalid_discovery_record", false))?;
    Ok((pid, started_at))
}

#[cfg(any(windows, test))]
fn windows_record_process_is_alive(
    bytes: &[u8],
    inspector: &dyn WindowsProcessInspector,
) -> NativeResult<bool> {
    let (pid, started_at) = parse_windows_discovery_liveness_metadata(bytes)?;
    match inspector.inspect_process(pid)? {
        WindowsProcessState::Exited | WindowsProcessState::NotFound => Ok(false),
        // startedAt is emitted after the owner process has started. A process
        // created after it is a PID reuse, while an older creation time is the
        // affirmative proof available from discovery metadata.
        WindowsProcessState::Running { creation_time } => Ok(creation_time <= started_at.filetime),
    }
}

#[cfg(any(windows, test))]
fn parse_windows_discovery_started_at(value: &str) -> Option<WindowsDiscoveryStartedAt> {
    const WINDOWS_EPOCH_OFFSET_SECONDS: i64 = 11_644_473_600;
    const HUNDRED_NANOSECONDS_PER_SECOND: u64 = 10_000_000;

    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return None;
    }
    let year = decimal_u32(&bytes[0..4])? as i64;
    let month = decimal_u32(&bytes[5..7])?;
    let day = decimal_u32(&bytes[8..10])?;
    let hour = decimal_u32(&bytes[11..13])?;
    let minute = decimal_u32(&bytes[14..16])?;
    let second = decimal_u32(&bytes[17..19])?;
    if !(1..=12).contains(&month)
        || day == 0
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }

    let mut cursor = 19;
    let fraction = if bytes.get(cursor) == Some(&b'.') {
        cursor += 1;
        let fraction_start = cursor;
        while bytes.get(cursor).is_some_and(u8::is_ascii_digit) {
            cursor += 1;
        }
        let digits = cursor - fraction_start;
        if !(1..=9).contains(&digits) {
            return None;
        }
        let recorded_digits = digits.min(7);
        let mut fraction =
            decimal_u32(&bytes[fraction_start..fraction_start + recorded_digits])? as u64;
        for _ in recorded_digits..7 {
            fraction *= 10;
        }
        fraction
    } else {
        0
    };
    let timezone_seconds = match bytes.get(cursor) {
        Some(b'Z') if cursor + 1 == bytes.len() => 0_i64,
        Some(b'+') | Some(b'-')
            if cursor + 6 == bytes.len() && bytes.get(cursor + 3) == Some(&b':') =>
        {
            let timezone_hour = decimal_u32(&bytes[cursor + 1..cursor + 3])?;
            let timezone_minute = decimal_u32(&bytes[cursor + 4..cursor + 6])?;
            if timezone_hour > 23 || timezone_minute > 59 {
                return None;
            }
            let offset = (timezone_hour as i64)
                .checked_mul(60)?
                .checked_add(timezone_minute as i64)?
                .checked_mul(60)?;
            if bytes[cursor] == b'+' {
                -offset
            } else {
                offset
            }
        }
        _ => return None,
    };
    let unix_seconds = civil_days_since_unix_epoch(year, month, day)?
        .checked_mul(86_400)?
        .checked_add(hour as i64 * 3_600)?
        .checked_add(minute as i64 * 60)?
        .checked_add(second as i64)?
        .checked_add(timezone_seconds)?;
    let filetime_seconds = unix_seconds.checked_add(WINDOWS_EPOCH_OFFSET_SECONDS)?;
    let filetime = u64::try_from(filetime_seconds)
        .ok()?
        .checked_mul(HUNDRED_NANOSECONDS_PER_SECOND)?
        .checked_add(fraction)?;
    Some(WindowsDiscoveryStartedAt { filetime })
}

#[cfg(any(windows, test))]
fn decimal_u32(bytes: &[u8]) -> Option<u32> {
    (!bytes.is_empty() && bytes.iter().all(u8::is_ascii_digit))
        .then(|| std::str::from_utf8(bytes).ok()?.parse().ok())?
}

#[cfg(any(windows, test))]
fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        _ => 0,
    }
}

#[cfg(any(windows, test))]
fn civil_days_since_unix_epoch(year: i64, month: u32, day: u32) -> Option<i64> {
    let year = year.checked_sub((month <= 2) as i64)?;
    let era = if year >= 0 {
        year
    } else {
        year.checked_sub(399)?
    } / 400;
    let year_of_era = year.checked_sub(era.checked_mul(400)?)?;
    let month = month as i64;
    let day_of_year = (153_i64)
        .checked_mul(month.checked_add(if month > 2 { -3 } else { 9 })?)?
        .checked_add(2)?
        / 5
        + day as i64
        - 1;
    let day_of_era = year_of_era
        .checked_mul(365)?
        .checked_add(year_of_era / 4)?
        .checked_sub(year_of_era / 100)?
        .checked_add(day_of_year)?;
    era.checked_mul(146_097)?
        .checked_add(day_of_era)?
        .checked_sub(719_468)
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
    let process_alive = backend.process_liveness(&opened.bytes)?;

    Ok(OwnerDiscoveryRecord {
        handle: String::new(),
        bytes: opened.bytes,
        record: OwnerDiscoveryRecordMetadata {
            identity: backend.owner_identity().map_err(windows_discovery_error)?,
            device: opened.opened.volume_serial,
            inode: opened.opened.file_index,
            process_alive,
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
            CloseHandle, GetLastError, LocalFree, ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND,
            ERROR_INVALID_PARAMETER, ERROR_PATH_NOT_FOUND, FILETIME, GENERIC_ALL, GENERIC_WRITE,
            HANDLE, INVALID_HANDLE_VALUE, STILL_ACTIVE, WAIT_OBJECT_0, WAIT_TIMEOUT,
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
            Threading::{
                GetCurrentProcess, GetExitCodeProcess, GetProcessTimes, OpenProcess,
                OpenProcessToken, WaitForSingleObject, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::Shell::GetUserProfileDirectoryW,
    };

    use super::{
        windows_record_process_is_alive, NativeDiagnostic, NativeResult, WindowsDiscoveryBackend,
        WindowsDiscoveryIoError, WindowsFileMetadata, WindowsOpenedDiscovery,
        WindowsProcessInspector, WindowsProcessState, MAX_DISCOVERY_BYTES,
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

        fn process_liveness(&self, bytes: &[u8]) -> NativeResult<bool> {
            windows_record_process_is_alive(bytes, self)
        }
    }

    impl WindowsProcessInspector for NativeWindowsDiscovery {
        fn inspect_process(&self, pid: u32) -> NativeResult<WindowsProcessState> {
            // The Win32 SYNCHRONIZE access right is 0x0010_0000.
            const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;

            let handle = unsafe {
                OpenProcess(
                    PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE_ACCESS,
                    0,
                    pid,
                )
            };
            if handle.is_null() {
                return match unsafe { GetLastError() } {
                    ERROR_INVALID_PARAMETER => Ok(WindowsProcessState::NotFound),
                    // Owner-checked discovery does not guarantee this process
                    // handle is queryable; do not turn denied access into alive.
                    ERROR_ACCESS_DENIED => {
                        Err(NativeDiagnostic::new("cave_discovery_unavailable", true))
                    }
                    _ => Err(NativeDiagnostic::new("cave_discovery_unavailable", true)),
                };
            }
            let handle = Handle(handle);
            match unsafe { WaitForSingleObject(handle.0, 0) } {
                WAIT_OBJECT_0 => return Ok(WindowsProcessState::Exited),
                WAIT_TIMEOUT => {}
                _ => return Err(NativeDiagnostic::new("cave_discovery_unavailable", true)),
            }
            let mut exit_code = 0;
            if unsafe { GetExitCodeProcess(handle.0, &mut exit_code) } == 0 {
                return Err(NativeDiagnostic::new("cave_discovery_unavailable", true));
            }
            if exit_code != STILL_ACTIVE as u32 {
                return Ok(WindowsProcessState::Exited);
            }
            let mut created = unsafe { std::mem::zeroed::<FILETIME>() };
            let mut exited = unsafe { std::mem::zeroed::<FILETIME>() };
            let mut kernel = unsafe { std::mem::zeroed::<FILETIME>() };
            let mut user = unsafe { std::mem::zeroed::<FILETIME>() };
            if unsafe {
                GetProcessTimes(handle.0, &mut created, &mut exited, &mut kernel, &mut user)
            } == 0
            {
                return Err(NativeDiagnostic::new("cave_discovery_unavailable", true));
            }
            Ok(WindowsProcessState::Running {
                creation_time: ((created.dwHighDateTime as u64) << 32)
                    | created.dwLowDateTime as u64,
            })
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
        parse_windows_discovery_liveness_metadata, read_windows_discovery_with,
        windows_record_process_is_alive, NativeDiagnostic, NativeResult, WindowsDiscoveryBackend,
        WindowsDiscoveryIoError, WindowsFileMetadata, WindowsOpenedDiscovery,
        WindowsProcessInspector, WindowsProcessState,
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
    #[test]
    fn windows_discovery_marks_an_affirmatively_live_owner_process_as_alive() {
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
                opened: safe_windows_metadata(1, 3),
                bytes: br#"{
                    "endpoint": "http://127.0.0.1:4310",
                    "pid": 42,
                    "startedAt": "2026-01-01T00:00:00Z"
                }"#
                .to_vec(),
            })),
            identity: "current-user".to_owned(),
            process: Ok(WindowsProcessState::Running { creation_time: 0 }),
        };

        assert!(
            read_windows_discovery_with(&reader)
                .unwrap()
                .record
                .process_alive
        );
    }

    #[cfg(not(windows))]
    struct FixedWindowsProcess(NativeResult<WindowsProcessState>);

    #[cfg(not(windows))]
    impl WindowsProcessInspector for FixedWindowsProcess {
        fn inspect_process(&self, _pid: u32) -> NativeResult<WindowsProcessState> {
            self.0.clone()
        }
    }

    #[cfg(not(windows))]
    fn windows_liveness_record() -> Vec<u8> {
        br#"{
            "endpoint": "http://127.0.0.1:4310",
            "pid": 42,
            "startedAt": "2026-01-01T00:00:00.000Z"
        }"#
        .to_vec()
    }

    #[cfg(not(windows))]
    #[test]
    fn windows_process_liveness_requires_a_live_process_created_no_later_than_started_at() {
        let record = windows_liveness_record();
        let (_, started_at) = parse_windows_discovery_liveness_metadata(&record).unwrap();

        assert!(windows_record_process_is_alive(
            &record,
            &FixedWindowsProcess(Ok(WindowsProcessState::Running {
                creation_time: started_at.filetime,
            })),
        )
        .unwrap());
        assert!(windows_record_process_is_alive(
            &record,
            &FixedWindowsProcess(Ok(WindowsProcessState::Running {
                creation_time: started_at.filetime - 1,
            })),
        )
        .unwrap());
        assert!(!windows_record_process_is_alive(
            &record,
            &FixedWindowsProcess(Ok(WindowsProcessState::Exited)),
        )
        .unwrap());
        assert!(!windows_record_process_is_alive(
            &record,
            &FixedWindowsProcess(Ok(WindowsProcessState::NotFound)),
        )
        .unwrap());
        assert!(!windows_record_process_is_alive(
            &record,
            &FixedWindowsProcess(Ok(WindowsProcessState::Running {
                creation_time: started_at.filetime + 1,
            })),
        )
        .unwrap());
    }

    #[cfg(not(windows))]
    #[test]
    fn windows_process_liveness_fails_closed_when_process_inspection_is_unavailable() {
        let unavailable = FixedWindowsProcess(Err(NativeDiagnostic::new(
            "cave_discovery_unavailable",
            true,
        )));

        assert_eq!(
            windows_record_process_is_alive(&windows_liveness_record(), &unavailable)
                .unwrap_err()
                .code,
            "cave_discovery_unavailable"
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn windows_process_liveness_rejects_malformed_or_overflowing_pids() {
        for malformed in [
            br#"{"pid": 0, "startedAt": "2026-01-01T00:00:00Z"}"#.as_slice(),
            br#"{"pid": -1, "startedAt": "2026-01-01T00:00:00Z"}"#.as_slice(),
            br#"{"pid": 4294967296, "startedAt": "2026-01-01T00:00:00Z"}"#.as_slice(),
            br#"{"pid": "42", "startedAt": "2026-01-01T00:00:00Z"}"#.as_slice(),
        ] {
            assert_eq!(
                windows_record_process_is_alive(
                    malformed,
                    &FixedWindowsProcess(Ok(WindowsProcessState::Running { creation_time: 0 })),
                )
                .unwrap_err()
                .code,
                "invalid_discovery_record"
            );
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn windows_process_liveness_accepts_sdk_rfc3339_fractional_precision_through_nanoseconds() {
        for fraction in ["", ".1", ".123", ".12345678", ".123456789"] {
            let record = format!(r#"{{"pid":42,"startedAt":"2026-01-01T00:00:00{fraction}Z"}}"#);
            let (_, started_at) =
                parse_windows_discovery_liveness_metadata(record.as_bytes()).unwrap();
            assert!(
                windows_record_process_is_alive(
                    record.as_bytes(),
                    &FixedWindowsProcess(Ok(WindowsProcessState::Running {
                        creation_time: started_at.filetime,
                    })),
                )
                .unwrap(),
                "fraction {fraction:?} should be accepted"
            );
        }

        for invalid in [
            r#"{"pid":42,"startedAt":"2026-01-01T00:00:00.1234567890Z"}"#,
            r#"{"pid":42,"startedAt":"2026-01-01T00:00:00.Z"}"#,
        ] {
            assert_eq!(
                parse_windows_discovery_liveness_metadata(invalid.as_bytes())
                    .unwrap_err()
                    .code,
                "invalid_discovery_record"
            );
        }
    }

    #[cfg(not(windows))]
    struct FakeWindowsDiscovery {
        root: PathBuf,
        directories: Mutex<VecDeque<Result<WindowsFileMetadata, WindowsDiscoveryIoError>>>,
        file: Option<Result<WindowsOpenedDiscovery, WindowsDiscoveryIoError>>,
        identity: String,
        process: NativeResult<WindowsProcessState>,
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

        fn process_liveness(&self, bytes: &[u8]) -> NativeResult<bool> {
            windows_record_process_is_alive(bytes, &FixedWindowsProcess(self.process.clone()))
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
            process: Ok(WindowsProcessState::Running { creation_time: 0 }),
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
            process: Ok(WindowsProcessState::Running { creation_time: 0 }),
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
            process: Ok(WindowsProcessState::Running { creation_time: 0 }),
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
            process: Ok(WindowsProcessState::Running { creation_time: 0 }),
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
            process: Ok(WindowsProcessState::Running { creation_time: 0 }),
        };

        assert_eq!(
            windows_error_code(read_windows_discovery_with(&reader)),
            "unsafe_discovery_record"
        );
    }
}
