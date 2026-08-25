use std::{
    path::{Path, PathBuf},
    process::{Child, Command},
};

#[cfg(unix)]
use std::{env, fs, io::Read};

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

#[cfg(unix)]
const DISCOVERY_FILE_NAME: &str = "client-v1-discovery.json";
#[cfg(unix)]
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

#[cfg(not(unix))]
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

pub(crate) trait CaveChild: Send {
    fn try_wait(&mut self) -> NativeResult<bool>;
    fn terminate(&mut self) -> NativeResult<()>;
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
    use std::path::Path;

    use serde_json::json;

    #[cfg(unix)]
    use super::record_process_is_alive;
    use super::{
        approved_cave_paths, build_cave_command, pin_owner_discovery_record,
        resolve_installed_cave_binary_from, OwnerDiscoveryRecord, OwnerDiscoveryRecordMetadata,
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

    #[test]
    fn discovery_metadata_reports_a_dead_record_process_as_not_alive() {
        assert!(!record_process_is_alive(br#"{ "pid": -1 }"#));
    }
}
