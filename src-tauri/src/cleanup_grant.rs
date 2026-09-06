use std::process;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use zeroize::Zeroizing;

use crate::keyring::{
    validate_conformance_cleanup_accounts, KeyringError, CONFORMANCE_SERVICE_PREFIX,
};

#[cfg(windows)]
pub(crate) fn create_windows_private_test_directory(path: &std::path::Path) -> std::io::Result<()> {
    marker_io::create_private_directory(path)
}

#[cfg(windows)]
pub(crate) fn write_windows_private_test_file(
    path: &std::path::Path,
    bytes: &[u8],
) -> std::io::Result<()> {
    marker_io::write_private_test_file(path, bytes)
}

const GRANT_BYTES: usize = 32;
const GRANT_DOMAIN: &str = "opencoven-chat-phase1-keyring-cleanup";
const GRANT_ID_DOMAIN: &[u8] = b"opencoven-chat-phase1-keyring-cleanup-id-v1\0";
const PROCESS_ID_DOMAIN: &[u8] = b"opencoven-chat-phase1-keyring-cleanup-process-v1\0";
const MARKER_VERSION: u32 = 1;
const MAX_MARKER_BYTES: usize = 16 * 1024;

#[derive(Debug, PartialEq, Eq)]
enum MarkerIdentityError {
    HomeUnavailable,
    DirectoryCreateUnavailable,
    DirectoryOpenUnavailable,
    DirectoryMetadataUnavailable,
    DirectoryTrustUnavailable,
    SyncUnavailable,
    IdentityUnavailable,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CleanupGrantPayload {
    version: u32,
    domain: String,
    grant_id: String,
    service: String,
    accounts: Vec<String>,
    issuer_pid: u32,
    process_identity: String,
    storage_identity: String,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CleanupGrantMarker {
    payload: CleanupGrantPayload,
    mac: String,
}

#[derive(Clone)]
pub(crate) struct CleanupGrantScope {
    pub(crate) service: String,
    pub(crate) accounts: Vec<String>,
}

pub(crate) struct PreparedCleanupGrant {
    scope: CleanupGrantScope,
    marker: marker_io::MarkerLease,
}

impl PreparedCleanupGrant {
    pub(crate) fn scope(&self) -> &CleanupGrantScope {
        &self.scope
    }

    pub(crate) fn consume(self) -> Result<(), KeyringError> {
        self.marker
            .consume()
            .map_err(|_| KeyringError::CleanupGrantRejected)
    }
}

pub(crate) fn issue(
    service: &str,
    accounts: &[String],
    process_secret: &[u8; GRANT_BYTES],
) -> Result<String, KeyringError> {
    validate_service(service).map_err(|error| match error {
        KeyringError::Unavailable => KeyringError::CleanupGrantServiceUnavailable,
        other => other,
    })?;
    validate_conformance_cleanup_accounts(accounts)?;
    let storage_identity = marker_io::identity().map_err(|error| match error {
        MarkerIdentityError::HomeUnavailable => KeyringError::CleanupGrantMarkerHomeUnavailable,
        MarkerIdentityError::DirectoryCreateUnavailable => {
            KeyringError::CleanupGrantMarkerDirectoryCreateUnavailable
        }
        MarkerIdentityError::DirectoryOpenUnavailable => {
            KeyringError::CleanupGrantMarkerDirectoryOpenUnavailable
        }
        MarkerIdentityError::DirectoryMetadataUnavailable => {
            KeyringError::CleanupGrantMarkerDirectoryMetadataUnavailable
        }
        MarkerIdentityError::DirectoryTrustUnavailable => {
            KeyringError::CleanupGrantMarkerDirectoryTrustUnavailable
        }
        MarkerIdentityError::SyncUnavailable => KeyringError::CleanupGrantMarkerSyncUnavailable,
        MarkerIdentityError::IdentityUnavailable => {
            KeyringError::CleanupGrantMarkerIdentityUnavailable
        }
    })?;
    #[cfg(windows)]
    marker_io::test_hook("issue-storage-identity").map_err(|_| KeyringError::Unavailable)?;

    for _ in 0..4 {
        let mut grant = Zeroizing::new([0_u8; GRANT_BYTES]);
        getrandom::fill(grant.as_mut()).map_err(|_| KeyringError::CleanupGrantRandomUnavailable)?;
        let grant_id = grant_id(grant.as_ref());
        let payload = CleanupGrantPayload {
            version: MARKER_VERSION,
            domain: GRANT_DOMAIN.to_owned(),
            grant_id: grant_id.clone(),
            service: service.to_owned(),
            accounts: accounts.to_vec(),
            issuer_pid: process::id(),
            process_identity: process_identity(process_secret),
            storage_identity: storage_identity.clone(),
        };
        let payload_bytes = serde_json::to_vec(&payload).map_err(|_| KeyringError::Failure)?;
        let marker = CleanupGrantMarker {
            payload,
            mac: URL_SAFE_NO_PAD.encode(mac(process_secret, &payload_bytes)?),
        };
        let marker_bytes = serde_json::to_vec(&marker).map_err(|_| KeyringError::Failure)?;
        if marker_bytes.len() > MAX_MARKER_BYTES {
            return Err(KeyringError::Failure);
        }
        match marker_io::publish(&grant_id, &marker_bytes, &storage_identity) {
            Ok(()) => return Ok(URL_SAFE_NO_PAD.encode(grant.as_ref())),
            Err(marker_io::PublishError::Collision) => continue,
            Err(marker_io::PublishError::Unavailable) => {
                return Err(KeyringError::CleanupGrantMarkerPublishUnavailable);
            }
        }
    }
    Err(KeyringError::CleanupGrantCollisionExhausted)
}

pub(crate) fn prepare(
    grant: &str,
    current_service: &str,
    process_secret: &[u8; GRANT_BYTES],
) -> Result<PreparedCleanupGrant, KeyringError> {
    validate_service(current_service)?;
    let grant = decode_grant(grant)?;
    let expected_grant_id = grant_id(grant.as_ref());
    let (marker_bytes, storage_identity, marker_lease) =
        marker_io::hold(&expected_grant_id).map_err(|_| KeyringError::CleanupGrantRejected)?;
    if marker_bytes.len() > MAX_MARKER_BYTES {
        return Err(KeyringError::CleanupGrantRejected);
    }
    let marker = serde_json::from_slice::<CleanupGrantMarker>(&marker_bytes)
        .map_err(|_| KeyringError::CleanupGrantRejected)?;
    let payload_bytes =
        serde_json::to_vec(&marker.payload).map_err(|_| KeyringError::CleanupGrantRejected)?;
    let marker_mac = URL_SAFE_NO_PAD
        .decode(marker.mac.as_bytes())
        .map_err(|_| KeyringError::CleanupGrantRejected)?;
    verify_mac(process_secret, &payload_bytes, &marker_mac)?;

    let expected_process_identity = process_identity(process_secret);
    if marker.payload.version != MARKER_VERSION
        || marker.payload.domain != GRANT_DOMAIN
        || !constant_time_eq(
            marker.payload.grant_id.as_bytes(),
            expected_grant_id.as_bytes(),
        )
        || marker.payload.service != current_service
        || marker.payload.issuer_pid != process::id()
        || !constant_time_eq(
            marker.payload.process_identity.as_bytes(),
            expected_process_identity.as_bytes(),
        )
        || !constant_time_eq(
            marker.payload.storage_identity.as_bytes(),
            storage_identity.as_bytes(),
        )
    {
        return Err(KeyringError::CleanupGrantRejected);
    }
    validate_service(&marker.payload.service)?;
    validate_conformance_cleanup_accounts(&marker.payload.accounts)
        .map_err(|_| KeyringError::CleanupGrantRejected)?;
    Ok(PreparedCleanupGrant {
        scope: CleanupGrantScope {
            service: marker.payload.service,
            accounts: marker.payload.accounts,
        },
        marker: marker_lease,
    })
}

pub(crate) fn grant_identity(value: &str) -> Result<String, KeyringError> {
    decode_grant(value).map(|grant| grant_id(grant.as_ref()))
}

fn validate_service(service: &str) -> Result<(), KeyringError> {
    if service
        .strip_prefix(CONFORMANCE_SERVICE_PREFIX)
        .is_some_and(|suffix| {
            suffix.len() == 32
                && suffix
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        })
    {
        Ok(())
    } else {
        Err(KeyringError::Unavailable)
    }
}

fn decode_grant(value: &str) -> Result<Zeroizing<Vec<u8>>, KeyringError> {
    let decoded = Zeroizing::new(
        URL_SAFE_NO_PAD
            .decode(value.as_bytes())
            .map_err(|_| KeyringError::CleanupGrantRejected)?,
    );
    if decoded.len() != GRANT_BYTES || URL_SAFE_NO_PAD.encode(decoded.as_slice()) != value {
        return Err(KeyringError::CleanupGrantRejected);
    }
    Ok(decoded)
}

fn grant_id(grant: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(GRANT_ID_DOMAIN);
    hasher.update(grant);
    hex(&hasher.finalize())
}

fn process_identity(process_secret: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(PROCESS_ID_DOMAIN);
    hasher.update(process_secret);
    hex(&hasher.finalize())
}

fn mac(key: &[u8], payload: &[u8]) -> Result<[u8; 32], KeyringError> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).map_err(|_| KeyringError::Failure)?;
    mac.update(payload);
    Ok(mac.finalize().into_bytes().into())
}

fn verify_mac(key: &[u8], payload: &[u8], expected: &[u8]) -> Result<(), KeyringError> {
    let mut mac = <Hmac<Sha256> as Mac>::new_from_slice(key).map_err(|_| KeyringError::Failure)?;
    mac.update(payload);
    mac.verify_slice(expected)
        .map_err(|_| KeyringError::CleanupGrantRejected)
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(DIGITS[(byte >> 4) as usize] as char);
        encoded.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    encoded
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(unix)]
mod marker_io {
    use std::{
        env,
        ffi::CString,
        fs::{self, File, OpenOptions},
        io::{Read, Write},
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::fs::{MetadataExt, OpenOptionsExt},
        },
        path::{Component, PathBuf},
    };

    use super::{MarkerIdentityError, MAX_MARKER_BYTES};

    const DIRECTORY_NAMES: [&str; 3] = [".coven", "chat", "phase1-cleanup-grants-v1"];

    pub(super) enum PublishError {
        Collision,
        Unavailable,
    }

    pub(super) enum HoldError {
        Rejected,
    }

    struct MarkerDirectory {
        file: File,
        identity: String,
    }

    pub(super) struct MarkerLease {
        directory: MarkerDirectory,
        file: File,
        name: String,
        device: u64,
        inode: u64,
        length: u64,
    }

    impl MarkerLease {
        pub(super) fn consume(self) -> Result<(), ()> {
            let held = self.file.metadata().map_err(|_| ())?;
            validate_file(&held, Some(self.length))?;
            if held.dev() != self.device || held.ino() != self.inode {
                return Err(());
            }
            let reopened = self.directory.open_file(&self.name)?;
            let reopened_metadata = reopened.metadata().map_err(|_| ())?;
            validate_file(&reopened_metadata, Some(self.length))?;
            if reopened_metadata.dev() != self.device || reopened_metadata.ino() != self.inode {
                return Err(());
            }

            let consumed_name = random_name(".consumed-")?;
            self.directory.rename(&self.name, &consumed_name)?;
            let consumed = match self.directory.open_file(&consumed_name) {
                Ok(file) => file,
                Err(()) => {
                    let _ = self.directory.rename(&consumed_name, &self.name);
                    let _ = self.directory.sync();
                    return Err(());
                }
            };
            let consumed_metadata = consumed.metadata().map_err(|_| ())?;
            if validate_file(&consumed_metadata, Some(self.length)).is_err()
                || consumed_metadata.dev() != self.device
                || consumed_metadata.ino() != self.inode
            {
                let _ = self.directory.rename(&consumed_name, &self.name);
                let _ = self.directory.sync();
                return Err(());
            }
            self.directory.sync()?;
            let _ = self.directory.unlink(&consumed_name);
            let _ = self.directory.sync();
            Ok(())
        }
    }

    impl MarkerDirectory {
        fn open() -> Result<Self, MarkerIdentityError> {
            let home = env::var_os("HOME").ok_or(MarkerIdentityError::HomeUnavailable)?;
            Self::open_at(PathBuf::from(home))
        }

        fn open_at(home: PathBuf) -> Result<Self, MarkerIdentityError> {
            if !home.is_absolute()
                || home
                    .components()
                    .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
            {
                return Err(MarkerIdentityError::HomeUnavailable);
            }
            let initial =
                fs::symlink_metadata(&home).map_err(|_| MarkerIdentityError::HomeUnavailable)?;
            validate_home_directory(&initial)?;
            let mut current = OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
                .open(&home)
                .map_err(|_| MarkerIdentityError::HomeUnavailable)?;
            let opened = current
                .metadata()
                .map_err(|_| MarkerIdentityError::HomeUnavailable)?;
            validate_home_directory(&opened)?;
            if initial.dev() != opened.dev() || initial.ino() != opened.ino() {
                return Err(MarkerIdentityError::HomeUnavailable);
            }

            for name in DIRECTORY_NAMES {
                let name = CString::new(name)
                    .map_err(|_| MarkerIdentityError::DirectoryCreateUnavailable)?;
                let created =
                    unsafe { libc::mkdirat(current.as_raw_fd(), name.as_ptr(), 0o700) } == 0;
                if !created {
                    let error = std::io::Error::last_os_error();
                    if error.kind() != std::io::ErrorKind::AlreadyExists {
                        return Err(MarkerIdentityError::DirectoryCreateUnavailable);
                    }
                }
                let descriptor = unsafe {
                    libc::openat(
                        current.as_raw_fd(),
                        name.as_ptr(),
                        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                    )
                };
                if descriptor < 0 {
                    return Err(MarkerIdentityError::DirectoryOpenUnavailable);
                }
                let next = unsafe { File::from_raw_fd(descriptor) };
                let metadata = next
                    .metadata()
                    .map_err(|_| MarkerIdentityError::DirectoryMetadataUnavailable)?;
                validate_directory(&metadata)
                    .map_err(|_| MarkerIdentityError::DirectoryTrustUnavailable)?;
                if created {
                    next.sync_all()
                        .map_err(|_| MarkerIdentityError::SyncUnavailable)?;
                    current
                        .sync_all()
                        .map_err(|_| MarkerIdentityError::SyncUnavailable)?;
                }
                current = next;
            }
            let metadata = current
                .metadata()
                .map_err(|_| MarkerIdentityError::IdentityUnavailable)?;
            Ok(Self {
                file: current,
                identity: format!("{:x}:{:x}", metadata.dev(), metadata.ino()),
            })
        }

        fn create_file(&self, name: &str) -> Result<File, ()> {
            let name = CString::new(name).map_err(|_| ())?;
            let descriptor = unsafe {
                libc::openat(
                    self.file.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o600,
                )
            };
            if descriptor < 0 {
                return Err(());
            }
            let file = unsafe { File::from_raw_fd(descriptor) };
            validate_file(&file.metadata().map_err(|_| ())?, None)?;
            Ok(file)
        }

        fn open_file(&self, name: &str) -> Result<File, ()> {
            let name = CString::new(name).map_err(|_| ())?;
            let descriptor = unsafe {
                libc::openat(
                    self.file.as_raw_fd(),
                    name.as_ptr(),
                    libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                )
            };
            if descriptor < 0 {
                return Err(());
            }
            Ok(unsafe { File::from_raw_fd(descriptor) })
        }

        fn link(&self, source: &str, destination: &str) -> Result<(), PublishError> {
            let source = CString::new(source).map_err(|_| PublishError::Unavailable)?;
            let destination = CString::new(destination).map_err(|_| PublishError::Unavailable)?;
            if unsafe {
                libc::linkat(
                    self.file.as_raw_fd(),
                    source.as_ptr(),
                    self.file.as_raw_fd(),
                    destination.as_ptr(),
                    0,
                )
            } == 0
            {
                return Ok(());
            }
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                Err(PublishError::Collision)
            } else {
                Err(PublishError::Unavailable)
            }
        }

        fn rename(&self, source: &str, destination: &str) -> Result<(), ()> {
            let source = CString::new(source).map_err(|_| ())?;
            let destination = CString::new(destination).map_err(|_| ())?;
            if unsafe {
                libc::renameat(
                    self.file.as_raw_fd(),
                    source.as_ptr(),
                    self.file.as_raw_fd(),
                    destination.as_ptr(),
                )
            } == 0
            {
                Ok(())
            } else {
                Err(())
            }
        }

        fn unlink(&self, name: &str) -> Result<(), ()> {
            let name = CString::new(name).map_err(|_| ())?;
            if unsafe { libc::unlinkat(self.file.as_raw_fd(), name.as_ptr(), 0) } == 0 {
                Ok(())
            } else {
                Err(())
            }
        }

        fn sync(&self) -> Result<(), ()> {
            self.file.sync_all().map_err(|_| ())
        }
    }

    pub(super) fn identity() -> Result<String, MarkerIdentityError> {
        MarkerDirectory::open().map(|directory| directory.identity)
    }

    #[cfg(test)]
    pub(super) fn identity_at(home: &std::path::Path) -> Result<String, MarkerIdentityError> {
        MarkerDirectory::open_at(home.to_path_buf()).map(|directory| directory.identity)
    }

    pub(super) fn publish(
        grant_id: &str,
        marker: &[u8],
        expected_identity: &str,
    ) -> Result<(), PublishError> {
        let directory = MarkerDirectory::open().map_err(|_| PublishError::Unavailable)?;
        if !super::constant_time_eq(directory.identity.as_bytes(), expected_identity.as_bytes()) {
            return Err(PublishError::Unavailable);
        }
        let final_name = marker_name(grant_id);
        let temporary_name = random_name(".pending-").map_err(|_| PublishError::Unavailable)?;
        let mut temporary = directory
            .create_file(&temporary_name)
            .map_err(|_| PublishError::Unavailable)?;
        let temporary_metadata = temporary
            .metadata()
            .map_err(|_| PublishError::Unavailable)?;
        if let Err(error) = temporary
            .write_all(marker)
            .and_then(|()| temporary.sync_all())
            .map_err(|_| PublishError::Unavailable)
        {
            let _ = directory.unlink(&temporary_name);
            return Err(error);
        }
        let link_result = directory.link(&temporary_name, &final_name);
        if link_result.is_err() {
            let _ = directory.unlink(&temporary_name);
            return link_result;
        }
        if directory.unlink(&temporary_name).is_err() || directory.sync().is_err() {
            let _ = directory.unlink(&final_name);
            let _ = directory.sync();
            return Err(PublishError::Unavailable);
        }
        let published = directory
            .open_file(&final_name)
            .map_err(|_| PublishError::Unavailable)?;
        let published_metadata = published
            .metadata()
            .map_err(|_| PublishError::Unavailable)?;
        if validate_file(&published_metadata, Some(marker.len() as u64)).is_err()
            || temporary_metadata.dev() != published_metadata.dev()
            || temporary_metadata.ino() != published_metadata.ino()
        {
            let _ = directory.unlink(&final_name);
            let _ = directory.sync();
            return Err(PublishError::Unavailable);
        }
        Ok(())
    }

    pub(super) fn hold(grant_id: &str) -> Result<(Vec<u8>, String, MarkerLease), HoldError> {
        let directory = MarkerDirectory::open().map_err(|_| HoldError::Rejected)?;
        let source_name = marker_name(grant_id);
        let mut marker = directory
            .open_file(&source_name)
            .map_err(|_| HoldError::Rejected)?;
        let before = marker.metadata().map_err(|_| HoldError::Rejected)?;
        validate_file(&before, None).map_err(|_| HoldError::Rejected)?;
        if before.len() > MAX_MARKER_BYTES as u64 {
            return Err(HoldError::Rejected);
        }
        let mut bytes = Vec::with_capacity(before.len() as usize);
        Read::by_ref(&mut marker)
            .take(MAX_MARKER_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| HoldError::Rejected)?;
        let after = marker.metadata().map_err(|_| HoldError::Rejected)?;
        validate_file(&after, Some(bytes.len() as u64)).map_err(|_| HoldError::Rejected)?;
        if before.dev() != after.dev()
            || before.ino() != after.ino()
            || bytes.len() > MAX_MARKER_BYTES
        {
            return Err(HoldError::Rejected);
        }
        let storage_identity = directory.identity.clone();
        Ok((
            bytes,
            storage_identity,
            MarkerLease {
                directory,
                file: marker,
                name: source_name,
                device: before.dev(),
                inode: before.ino(),
                length: before.len(),
            },
        ))
    }

    fn marker_name(grant_id: &str) -> String {
        format!("grant-{grant_id}.json")
    }

    fn random_name(prefix: &str) -> Result<String, ()> {
        let mut bytes = [0_u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| ())?;
        Ok(format!("{prefix}{}", super::hex(&bytes)))
    }

    fn validate_directory(metadata: &fs::Metadata) -> Result<(), ()> {
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o777 != 0o700
        {
            return Err(());
        }
        Ok(())
    }

    fn validate_home_directory(metadata: &fs::Metadata) -> Result<(), MarkerIdentityError> {
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o022 != 0
        {
            return Err(MarkerIdentityError::HomeUnavailable);
        }
        Ok(())
    }

    fn validate_file(metadata: &fs::Metadata, expected_len: Option<u64>) -> Result<(), ()> {
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.mode() & 0o777 != 0o600
            || metadata.nlink() != 1
            || expected_len.is_some_and(|expected| metadata.len() != expected)
        {
            return Err(());
        }
        Ok(())
    }
}

#[cfg(windows)]
mod marker_io {
    use std::{
        env,
        fs::{self, File, OpenOptions},
        io::{self, Read, Write},
        os::windows::{
            ffi::OsStrExt,
            fs::OpenOptionsExt,
            io::{AsRawHandle, FromRawHandle},
        },
        path::{Component, Path, PathBuf},
        thread,
        time::{Duration, Instant},
    };

    use windows_sys::Win32::{
        Foundation::{
            GetLastError, LocalFree, ERROR_ALREADY_EXISTS, ERROR_FILE_EXISTS, GENERIC_READ,
            GENERIC_WRITE, INVALID_HANDLE_VALUE,
        },
        Security::{
            Authorization::{
                ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
            },
            PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES,
        },
        Storage::FileSystem::{
            CreateDirectoryW, CreateFileW, MoveFileExW, CREATE_NEW, FILE_ATTRIBUTE_NORMAL,
            FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_FLAG_WRITE_THROUGH,
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE, MOVEFILE_WRITE_THROUGH,
        },
    };

    use super::{MarkerIdentityError, MAX_MARKER_BYTES};

    const DIRECTORY_NAMES: [&str; 3] = [".coven", "chat", "phase1-cleanup-grants-v1"];
    const TEST_HOOK_ENV: &str = "OPENCOVEN_PHASE1_CONFORMANCE_CLEANUP_TEST_HOOK";
    const TEST_HOOK_DIRECTORY_ENV: &str =
        "OPENCOVEN_PHASE1_CONFORMANCE_CLEANUP_TEST_HOOK_DIRECTORY";

    pub(super) enum PublishError {
        Collision,
        Unavailable,
    }

    pub(super) enum HoldError {
        Rejected,
    }

    struct LocalSecurityDescriptor(PSECURITY_DESCRIPTOR);

    impl Drop for LocalSecurityDescriptor {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe {
                    LocalFree(self.0.cast());
                }
            }
        }
    }

    struct PinnedDirectory {
        path: PathBuf,
        file: File,
        identity: crate::cave::WindowsPrivatePathMetadata,
    }

    struct MarkerDirectory {
        chain: Vec<PinnedDirectory>,
        path: PathBuf,
        identity: String,
    }

    pub(super) struct MarkerLease {
        directory: MarkerDirectory,
        path: PathBuf,
        file: File,
        identity: crate::cave::WindowsPrivatePathMetadata,
        length: u64,
    }

    impl MarkerLease {
        pub(super) fn consume(self) -> Result<(), ()> {
            self.directory.revalidate()?;
            let held = validate_handle(&self.file, false)?;
            if held != self.identity || held.links != 1 {
                return Err(());
            }
            if self.file.metadata().map_err(|_| ())?.len() != self.length {
                return Err(());
            }
            let reopened = open_existing(&self.path)?;
            if validate_handle(&reopened, false)? != self.identity {
                return Err(());
            }

            let consumed_path = self.directory.path(&random_name(".consumed-")?);
            move_write_through(&self.path, &consumed_path).map_err(|_| ())?;
            self.directory.revalidate()?;
            let consumed = match open_existing(&consumed_path) {
                Ok(file) => file,
                Err(()) => {
                    let _ = move_write_through(&consumed_path, &self.path);
                    return Err(());
                }
            };
            if validate_handle(&consumed, false)? != self.identity
                || consumed.metadata().map_err(|_| ())?.len() != self.length
            {
                let _ = move_write_through(&consumed_path, &self.path);
                return Err(());
            }
            let _ = fs::remove_file(&consumed_path);
            let _ = self.directory.revalidate();
            Ok(())
        }
    }

    impl MarkerDirectory {
        fn open() -> Result<Self, ()> {
            let home = env::var_os("HOME").ok_or(())?;
            let home = PathBuf::from(home);
            if !home.is_absolute()
                || home
                    .components()
                    .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
            {
                return Err(());
            }
            let mut chain = vec![pin_directory(home.clone())?];
            let mut current = home;
            for name in DIRECTORY_NAMES {
                current.push(name);
                match create_private_directory(&current) {
                    Ok(()) => {}
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(_) => return Err(()),
                }
                chain.push(pin_directory(current.clone())?);
            }
            let identity = chain_identity(&chain);
            let directory = Self {
                chain,
                path: current,
                identity,
            };
            directory.revalidate()?;
            Ok(directory)
        }

        fn path(&self, name: &str) -> PathBuf {
            self.path.join(name)
        }

        fn revalidate(&self) -> Result<(), ()> {
            for pinned in &self.chain {
                let held = validate_directory_handle(&pinned.file)?;
                if held != pinned.identity {
                    return Err(());
                }
                let reopened = open_directory(&pinned.path)?;
                let reopened_identity = validate_directory_handle(&reopened)?;
                if reopened_identity != pinned.identity {
                    return Err(());
                }
            }
            Ok(())
        }
    }

    pub(super) fn identity() -> Result<String, MarkerIdentityError> {
        MarkerDirectory::open()
            .map(|directory| directory.identity)
            .map_err(|_| MarkerIdentityError::IdentityUnavailable)
    }

    pub(super) fn publish(
        grant_id: &str,
        marker: &[u8],
        expected_identity: &str,
    ) -> Result<(), PublishError> {
        let directory = MarkerDirectory::open().map_err(|_| PublishError::Unavailable)?;
        if !super::constant_time_eq(directory.identity.as_bytes(), expected_identity.as_bytes()) {
            return Err(PublishError::Unavailable);
        }
        directory
            .revalidate()
            .map_err(|_| PublishError::Unavailable)?;
        test_hook("publish-pinned").map_err(|_| PublishError::Unavailable)?;
        directory
            .revalidate()
            .map_err(|_| PublishError::Unavailable)?;
        let final_path = directory.path(&marker_name(grant_id));
        let temporary_path =
            directory.path(&random_name(".pending-").map_err(|_| PublishError::Unavailable)?);
        let mut temporary = open_new(&temporary_path).map_err(|_| PublishError::Unavailable)?;
        directory
            .revalidate()
            .map_err(|_| PublishError::Unavailable)?;
        temporary
            .write_all(marker)
            .and_then(|()| temporary.sync_all())
            .map_err(|_| PublishError::Unavailable)?;
        let temporary_identity =
            validate_handle(&temporary, false).map_err(|_| PublishError::Unavailable)?;
        match move_write_through(&temporary_path, &final_path) {
            Ok(()) => {}
            Err(MoveError::Collision) => {
                let _ = fs::remove_file(&temporary_path);
                return Err(PublishError::Collision);
            }
            Err(MoveError::Unavailable) => {
                let _ = fs::remove_file(&temporary_path);
                return Err(PublishError::Unavailable);
            }
        }
        if directory.revalidate().is_err() {
            let _ = fs::remove_file(&final_path);
            return Err(PublishError::Unavailable);
        }
        let published = open_existing(&final_path).map_err(|_| PublishError::Unavailable)?;
        let published_identity =
            validate_handle(&published, false).map_err(|_| PublishError::Unavailable)?;
        if temporary_identity != published_identity
            || published_identity.links != 1
            || published
                .metadata()
                .map_err(|_| PublishError::Unavailable)?
                .len()
                != marker.len() as u64
        {
            let _ = fs::remove_file(&final_path);
            return Err(PublishError::Unavailable);
        }
        directory
            .revalidate()
            .map_err(|_| PublishError::Unavailable)?;
        Ok(())
    }

    pub(super) fn hold(grant_id: &str) -> Result<(Vec<u8>, String, MarkerLease), HoldError> {
        let directory = MarkerDirectory::open().map_err(|_| HoldError::Rejected)?;
        directory.revalidate().map_err(|_| HoldError::Rejected)?;
        test_hook("claim-pinned").map_err(|_| HoldError::Rejected)?;
        directory.revalidate().map_err(|_| HoldError::Rejected)?;
        let source_path = directory.path(&marker_name(grant_id));
        let mut marker = open_existing(&source_path).map_err(|_| HoldError::Rejected)?;
        let before = validate_handle(&marker, false).map_err(|_| HoldError::Rejected)?;
        if before.links != 1 {
            return Err(HoldError::Rejected);
        }
        let length = marker.metadata().map_err(|_| HoldError::Rejected)?.len();
        if length > MAX_MARKER_BYTES as u64 {
            return Err(HoldError::Rejected);
        }
        let mut bytes = Vec::with_capacity(length as usize);
        Read::by_ref(&mut marker)
            .take(MAX_MARKER_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| HoldError::Rejected)?;
        let after = validate_handle(&marker, false).map_err(|_| HoldError::Rejected)?;
        if before != after
            || after.links != 1
            || bytes.len() > MAX_MARKER_BYTES
            || marker.metadata().map_err(|_| HoldError::Rejected)?.len() != bytes.len() as u64
        {
            return Err(HoldError::Rejected);
        }
        directory.revalidate().map_err(|_| HoldError::Rejected)?;
        let storage_identity = directory.identity.clone();
        Ok((
            bytes,
            storage_identity,
            MarkerLease {
                directory,
                path: source_path,
                file: marker,
                identity: before,
                length,
            },
        ))
    }

    fn marker_name(grant_id: &str) -> String {
        format!("grant-{grant_id}.json")
    }

    fn random_name(prefix: &str) -> Result<String, ()> {
        let mut bytes = [0_u8; 16];
        getrandom::fill(&mut bytes).map_err(|_| ())?;
        Ok(format!("{prefix}{}", super::hex(&bytes)))
    }

    fn with_private_security_attributes<T>(
        directory: bool,
        operation: impl FnOnce(*const SECURITY_ATTRIBUTES) -> io::Result<T>,
    ) -> io::Result<T> {
        let sid = crate::cave::current_windows_user_sid()
            .map_err(|()| io::Error::other("current Windows user SID is unavailable"))?;
        let sddl = if directory {
            format!("O:{sid}D:P(A;OICI;FA;;;{sid})")
        } else {
            format!("O:{sid}D:P(A;;FA;;;{sid})")
        };
        let mut wide = std::ffi::OsStr::new(&sddl)
            .encode_wide()
            .collect::<Vec<_>>();
        wide.push(0);
        let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
        if unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide.as_ptr(),
                SDDL_REVISION_1,
                &raw mut descriptor,
                std::ptr::null_mut(),
            )
        } == 0
            || descriptor.is_null()
        {
            return Err(io::Error::last_os_error());
        }
        let descriptor = LocalSecurityDescriptor(descriptor);
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: descriptor.0,
            bInheritHandle: 0,
        };
        operation(&raw const attributes)
    }

    pub(super) fn create_private_directory(path: &Path) -> io::Result<()> {
        let mut wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
        wide.push(0);
        with_private_security_attributes(true, |attributes| {
            if unsafe { CreateDirectoryW(wide.as_ptr(), attributes) } == 0 {
                Err(io::Error::last_os_error())
            } else {
                Ok(())
            }
        })
    }

    fn create_private_file(path: &Path) -> io::Result<File> {
        let mut wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
        wide.push(0);
        with_private_security_attributes(false, |attributes| {
            let handle = unsafe {
                CreateFileW(
                    wide.as_ptr(),
                    GENERIC_READ | GENERIC_WRITE,
                    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                    attributes,
                    CREATE_NEW,
                    FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_WRITE_THROUGH,
                    std::ptr::null_mut(),
                )
            };
            if handle == INVALID_HANDLE_VALUE {
                Err(io::Error::last_os_error())
            } else {
                Ok(unsafe { File::from_raw_handle(handle.cast()) })
            }
        })
    }

    pub(super) fn write_private_test_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
        let mut file = create_private_file(path)?;
        file.write_all(bytes)?;
        file.sync_all()
    }

    fn open_new(path: &Path) -> Result<File, ()> {
        create_private_file(path).map_err(|_| ())
    }

    fn open_existing(path: &Path) -> Result<File, ()> {
        OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
            .map_err(|_| ())
    }

    fn open_directory(path: &Path) -> Result<File, ()> {
        OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(path)
            .map_err(|_| ())
    }

    fn pin_directory(path: PathBuf) -> Result<PinnedDirectory, ()> {
        let file = open_directory(&path)?;
        let identity = validate_directory_handle(&file)?;
        Ok(PinnedDirectory {
            path,
            file,
            identity,
        })
    }

    fn chain_identity(chain: &[PinnedDirectory]) -> String {
        let mut identity = String::with_capacity(chain.len() * 34);
        for pinned in chain {
            identity.push_str(&format!(
                "{:x}:{:x};",
                pinned.identity.volume_serial, pinned.identity.file_index
            ));
        }
        identity
    }

    fn validate_directory_handle(
        file: &File,
    ) -> Result<crate::cave::WindowsPrivatePathMetadata, ()> {
        crate::cave::validate_windows_private_handle(file.as_raw_handle() as _, true)
    }

    fn validate_handle(
        file: &File,
        directory: bool,
    ) -> Result<crate::cave::WindowsPrivatePathMetadata, ()> {
        crate::cave::validate_windows_private_handle(file.as_raw_handle() as _, directory)
    }

    enum MoveError {
        Collision,
        Unavailable,
    }

    fn move_write_through(source: &Path, destination: &Path) -> Result<(), MoveError> {
        let mut source = source.as_os_str().encode_wide().collect::<Vec<_>>();
        source.push(0);
        let mut destination = destination.as_os_str().encode_wide().collect::<Vec<_>>();
        destination.push(0);
        if unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_WRITE_THROUGH,
            )
        } == 0
        {
            match unsafe { GetLastError() } {
                ERROR_ALREADY_EXISTS | ERROR_FILE_EXISTS => Err(MoveError::Collision),
                _ => Err(MoveError::Unavailable),
            }
        } else {
            Ok(())
        }
    }

    pub(super) fn test_hook(checkpoint: &str) -> Result<(), ()> {
        if env::var(TEST_HOOK_ENV).ok().as_deref() != Some(checkpoint) {
            return Ok(());
        }
        let directory = env::var_os(TEST_HOOK_DIRECTORY_ENV)
            .map(PathBuf::from)
            .ok_or(())?;
        if !directory.is_absolute() {
            return Err(());
        }
        crate::cave::validate_windows_private_path(&directory, true)?;
        let ready = directory.join(format!("{checkpoint}.ready"));
        let release = directory.join(format!("{checkpoint}.release"));
        let mut ready_file = open_new(&ready)?;
        ready_file.write_all(b"ready").map_err(|_| ())?;
        ready_file.sync_all().map_err(|_| ())?;
        drop(ready_file);

        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            match open_existing(&release) {
                Ok(file) => {
                    validate_handle(&file, false)?;
                    break;
                }
                Err(()) if Instant::now() < deadline => {
                    thread::sleep(Duration::from_millis(20));
                }
                Err(()) => {
                    let _ = fs::remove_file(&ready);
                    return Err(());
                }
            }
        }
        fs::remove_file(&release).map_err(|_| ())?;
        fs::remove_file(&ready).map_err(|_| ())
    }
}

#[cfg(all(not(unix), not(windows)))]
mod marker_io {
    use super::MarkerIdentityError;

    pub(super) enum PublishError {
        Collision,
        Unavailable,
    }

    pub(super) enum HoldError {
        Rejected,
    }

    pub(super) struct MarkerLease;

    impl MarkerLease {
        pub(super) fn consume(self) -> Result<(), ()> {
            Err(())
        }
    }

    pub(super) fn identity() -> Result<String, MarkerIdentityError> {
        Err(MarkerIdentityError::IdentityUnavailable)
    }

    pub(super) fn publish(
        _grant_id: &str,
        _marker: &[u8],
        _expected_identity: &str,
    ) -> Result<(), PublishError> {
        Err(PublishError::Unavailable)
    }

    pub(super) fn hold(_grant_id: &str) -> Result<(Vec<u8>, String, MarkerLease), HoldError> {
        Err(HoldError::Rejected)
    }
}

#[cfg(all(test, unix))]
mod tests {
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::{SystemTime, UNIX_EPOCH},
    };

    use super::{marker_io, MarkerIdentityError};

    struct TestHome(PathBuf);

    impl TestHome {
        fn new(mode: u32) -> Self {
            static NEXT_HOME: AtomicU64 = AtomicU64::new(0);
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock must follow Unix epoch")
                .as_nanos();
            let sequence = NEXT_HOME.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "opencoven-cleanup-marker-home-{}-{nonce}-{sequence}",
                std::process::id()
            ));
            fs::create_dir(&path).expect("test home must be created");
            fs::set_permissions(&path, fs::Permissions::from_mode(mode))
                .expect("test home mode must be set");
            Self(path)
        }
    }

    impl Drop for TestHome {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn marker_identity_accepts_an_owned_non_writable_traversable_home() {
        let home = TestHome::new(0o755);

        assert!(marker_io::identity_at(&home.0).is_ok());
    }

    #[test]
    fn marker_identity_rejects_a_group_writable_home() {
        let home = TestHome::new(0o770);

        assert_eq!(
            marker_io::identity_at(&home.0),
            Err(MarkerIdentityError::HomeUnavailable)
        );
    }

    #[test]
    fn marker_identity_classifies_an_unsafe_existing_marker_directory() {
        let home = TestHome::new(0o700);
        let coven = home.0.join(".coven");
        fs::create_dir(&coven).expect("marker parent must be created");
        fs::set_permissions(&coven, fs::Permissions::from_mode(0o755))
            .expect("marker parent mode must be set");

        assert_eq!(
            marker_io::identity_at(&home.0),
            Err(MarkerIdentityError::DirectoryTrustUnavailable)
        );
    }

    #[test]
    fn marker_identity_classifies_an_existing_marker_file() {
        let home = TestHome::new(0o700);
        fs::write(home.0.join(".coven"), b"not a directory")
            .expect("marker parent file must be created");

        assert_eq!(
            marker_io::identity_at(&home.0),
            Err(MarkerIdentityError::DirectoryOpenUnavailable)
        );
    }
}
