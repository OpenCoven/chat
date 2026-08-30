use std::{
    collections::HashMap,
    env,
    fs::OpenOptions,
    io::{self, BufRead, Read, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex, MutexGuard},
};

use serde::Deserialize;
use serde_json::{json, Map, Value};
use zeroize::{Zeroize, Zeroizing};

use crate::{
    cave::{
        CaveChild, CaveLauncher, NativeCaveClock, NativeCaveDiscoveryReader, NativeCaveSleeper,
        NativeCaveTaskRunner, NativeDiagnostic, NativeResult,
    },
    keyring::{
        validate_credential_origin, validate_installation_id, ConformanceCleanupOutcome,
        ConformanceCleanupReservation, Credential, CredentialCustody, CredentialSlot, KeyringError,
        NativeKeyring, NativeProviderPreset,
    },
    operation::{
        NativeCancelReason, NativeMutationQueue, NativeOperationInput, NativeOperationRegistry,
        MAX_NATIVE_OPERATION_TIMEOUT_MS,
    },
    transport::{
        validate_pairing_request, CaveReadPath, ConstrainedTransport, NativeCaveTransport,
        NativePage,
    },
    NativeConnectionState,
};

const MAX_LINE_BYTES: usize = 64 * 1024;
const MAX_REQUEST_ID_BYTES: usize = 128;
const MAX_RPC_WORKERS: usize = 256;
const INVALID_REQUEST_ID: &str = "invalid-request";
pub const CONFORMANCE_INSTALLATION_ID: &str = "4e1d02ca-833b-4d9d-8e9f-31bb8f44f9b5";
pub const CONFORMANCE_NODE_PATH_ENV: &str = "OPENCOVEN_PHASE1_CONFORMANCE_NODE_PATH";
pub const CONFORMANCE_CAVE_SERVER_PATH_ENV: &str = "OPENCOVEN_PHASE1_CONFORMANCE_CAVE_SERVER_PATH";
pub const CONFORMANCE_NATIVE_PROVIDER_PRESET_ENV: &str =
    "OPENCOVEN_PHASE1_CONFORMANCE_NATIVE_PROVIDER_PRESET";
const WINDOWS_JOB_REQUIRED_ENV: &str = "OPENCOVEN_WINDOWS_JOB_REQUIRED";
const WINDOWS_JOB_NONCE_ENV: &str = "OPENCOVEN_WINDOWS_JOB_NONCE";
const WINDOWS_JOB_NAME_ENV: &str = "OPENCOVEN_WINDOWS_JOB_NAME";
const CONFORMANCE_NATIVE_PROVIDER_MISSING_KEYCHAIN_TRUST: &str = "missing-keychain-trust";
const CONFORMANCE_NATIVE_PROVIDER_PRODUCTION_KEYRING: &str = "production-keyring";
const CONFORMANCE_NATIVE_PROVIDER_SYSTEM: &str = "system-native";
const INTERNAL_TEST_RESERVATION_OUTPUT_ARGUMENT: &str =
    "--opencoven-internal-test-reservation-output-v1";
const INTERNAL_TEST_RESERVATION_EOF_ARGUMENT: &str = "--opencoven-internal-test-reservation-eof-v1";
const INTERNAL_TEST_KEYCHAIN_ISOLATED_ENV: &str = "OPENCOVEN_PHASE1_TEST_KEYCHAIN_ISOLATED";
const INTERNAL_TEST_RESERVATION_RESULT_PATH_ENV: &str =
    "OPENCOVEN_PHASE1_TEST_RESERVATION_RESULT_PATH";
const TEST_ADOPTION_BARRIER_ENV: &str = "OPENCOVEN_PHASE1_TEST_ADOPTION_BARRIER";
const TEST_ADOPTION_BARRIER_ROOT_ENV: &str = "OPENCOVEN_PHASE1_TEST_ADOPTION_BARRIER_ROOT";

fn adoption_fault_barrier(phase: &str) -> Result<(), NativeDiagnostic> {
    if env::var(INTERNAL_TEST_KEYCHAIN_ISOLATED_ENV).as_deref() != Ok("1")
        || env::var(TEST_ADOPTION_BARRIER_ENV).as_deref() != Ok(phase)
    {
        return Ok(());
    }
    let root = PathBuf::from(
        env::var_os(TEST_ADOPTION_BARRIER_ROOT_ENV)
            .ok_or_else(|| NativeDiagnostic::new("invalid_native_input", false))?,
    );
    let allowed = PathBuf::from(
        env::var_os("CARGO_TARGET_DIR")
            .ok_or_else(|| NativeDiagnostic::new("invalid_native_input", false))?,
    )
    .join("phase1-native-rpc-tests");
    if !root.is_absolute() || !root.starts_with(&allowed) {
        return Err(NativeDiagnostic::new("invalid_native_input", false));
    }
    let ready = root.join(format!("{phase}.ready"));
    let gate = root.join(format!("{phase}.gate"));
    OpenOptions::new()
        .write(true)
        .open(ready)
        .and_then(|mut file| file.write_all(b"ready\n"))
        .map_err(|_| NativeDiagnostic::new("keychain_failure", false))?;
    std::fs::File::open(gate)
        .map(|_| ())
        .map_err(|_| NativeDiagnostic::new("keychain_failure", false))
}

fn validate_windows_job_binding_values(
    required: &str,
    nonce: &str,
    name: &str,
) -> NativeResult<()> {
    let valid_nonce = nonce.len() == 32
        && nonce
            .bytes()
            .all(|value| value.is_ascii_digit() || (b'a'..=b'f').contains(&value));
    if required != "1"
        || !valid_nonce
        || name != format!(r"Local\OpenCoven.Chat.Conformance.{nonce}")
    {
        return Err(NativeDiagnostic::new("invalid_native_input", false));
    }
    Ok(())
}

fn require_windows_job_supervision_from_environment() -> NativeResult<()> {
    let required = match env::var(WINDOWS_JOB_REQUIRED_ENV) {
        Ok(value) => value,
        Err(env::VarError::NotPresent) => return Ok(()),
        Err(env::VarError::NotUnicode(_)) => {
            return Err(NativeDiagnostic::new("invalid_native_input", false));
        }
    };
    let nonce = env::var(WINDOWS_JOB_NONCE_ENV)
        .map_err(|_| NativeDiagnostic::new("invalid_native_input", false))?;
    let name = env::var(WINDOWS_JOB_NAME_ENV)
        .map_err(|_| NativeDiagnostic::new("invalid_native_input", false))?;
    validate_windows_job_binding_values(&required, &nonce, &name)?;

    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::{
            Foundation::CloseHandle,
            System::{
                JobObjects::{IsProcessInJob, OpenJobObjectW},
                Threading::GetCurrentProcess,
            },
        };

        const JOB_OBJECT_QUERY: u32 = 0x0004;
        let wide_name = std::ffi::OsStr::new(&name)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let job = unsafe { OpenJobObjectW(JOB_OBJECT_QUERY, 0, wide_name.as_ptr()) };
        if job.is_null() {
            return Err(NativeDiagnostic::new("invalid_native_input", false));
        }
        let mut member = 0;
        let inspected = unsafe { IsProcessInJob(GetCurrentProcess(), job, &mut member) };
        unsafe {
            CloseHandle(job);
        }
        if inspected == 0 || member == 0 {
            return Err(NativeDiagnostic::new("invalid_native_input", false));
        }
        Ok(())
    }

    #[cfg(not(windows))]
    {
        Err(NativeDiagnostic::new("invalid_native_input", false))
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StrictRequest {
    id: String,
    command: String,
    #[serde(default)]
    args: Option<Value>,
}

struct RpcRequest {
    id: String,
    command: RpcCommand,
}

enum RpcCommand {
    AppInstallationId,
    CaveReadDiscovery {
        operation: NativeOperationInput,
    },
    CaveCancelOperation {
        attempt_id: String,
        reason: NativeCancelReason,
    },
    CaveLaunch,
    CaveHealth {
        handle: String,
        operation: NativeOperationInput,
    },
    CovenHealth {
        operation: NativeOperationInput,
    },
    CavePairingCreate {
        handle: String,
        request: Value,
        operation: NativeOperationInput,
    },
    CavePairingPoll {
        handle: String,
        request_id: String,
        operation: NativeOperationInput,
    },
    CavePairingExchange {
        handle: String,
        request_id: String,
        operation: NativeOperationInput,
    },
    CaveResetPairing {
        handle: String,
    },
    CaveCredentialStatus {
        handle: String,
        operation: NativeOperationInput,
    },
    CaveForgetCredential {
        handle: String,
        operation: NativeOperationInput,
    },
    ConformancePrepareNativeCleanup {
        handle: String,
    },
    ConformanceBeginAdoptNativeCleanup {
        reservation_handle: String,
        capability: String,
        owner_token: String,
        successor_owner_token: String,
    },
    ConformanceCommitAdoptNativeCleanup {
        reservation_handle: String,
        capability: String,
        owner_token: String,
        successor_owner_token: String,
    },
    ConformanceAbortAdoptNativeCleanup {
        reservation_handle: String,
        capability: String,
        owner_token: String,
        successor_owner_token: String,
    },
    ConformanceCancelPreparedNativeCleanup,
    ConformanceDeleteNativeCredential {
        reservation_handle: String,
        capability: String,
        owner_token: String,
    },
    ConformanceNativeCustodyState {
        instance_ids: Vec<String>,
    },
    ConformanceIssueNativeCustodyCleanup {
        instance_ids: Vec<String>,
    },
    ConformanceCleanupNativeCustody {
        grant: Zeroizing<String>,
    },
    CaveListFamiliars {
        handle: String,
        page: NativePage,
        operation: NativeOperationInput,
    },
    CaveListProjects {
        handle: String,
        page: NativePage,
        operation: NativeOperationInput,
    },
    CaveListConversations {
        handle: String,
        page: NativePage,
        operation: NativeOperationInput,
    },
    CaveGetConversation {
        handle: String,
        conversation_id: String,
        operation: NativeOperationInput,
    },
    CaveListConversationMessages {
        handle: String,
        conversation_id: String,
        page: NativePage,
        operation: NativeOperationInput,
    },
    ResetNativeState,
    Shutdown,
}

impl RpcCommand {
    fn runs_concurrently(&self) -> bool {
        matches!(
            self,
            Self::CaveReadDiscovery { .. }
                | Self::CaveHealth { .. }
                | Self::CovenHealth { .. }
                | Self::CavePairingCreate { .. }
                | Self::CavePairingPoll { .. }
                | Self::CavePairingExchange { .. }
                | Self::CaveCredentialStatus { .. }
                | Self::CaveForgetCredential { .. }
                | Self::CaveListFamiliars { .. }
                | Self::CaveListProjects { .. }
                | Self::CaveListConversations { .. }
                | Self::CaveGetConversation { .. }
                | Self::CaveListConversationMessages { .. }
        )
    }

    fn is_barrier(&self) -> bool {
        matches!(
            self,
            Self::CaveLaunch
                | Self::CaveResetPairing { .. }
                | Self::ConformancePrepareNativeCleanup { .. }
                | Self::ConformanceDeleteNativeCredential { .. }
                | Self::ConformanceNativeCustodyState { .. }
                | Self::ConformanceIssueNativeCustodyCleanup { .. }
                | Self::ConformanceCleanupNativeCustody { .. }
                | Self::ResetNativeState
                | Self::Shutdown
        )
    }
}

#[derive(Clone)]
pub struct SharedMemoryCredentialCustody {
    store: Arc<Mutex<SharedCredentialStore>>,
}

struct SharedCredentialStore {
    credentials: HashMap<String, Credential>,
}

impl SharedMemoryCredentialCustody {
    pub fn new() -> Self {
        Self {
            store: Arc::new(Mutex::new(SharedCredentialStore {
                credentials: HashMap::new(),
            })),
        }
    }

    fn lock(&self) -> Result<MutexGuard<'_, SharedCredentialStore>, KeyringError> {
        self.store.lock().map_err(|_| KeyringError::Failure)
    }
}

impl Default for SharedMemoryCredentialCustody {
    fn default() -> Self {
        Self::new()
    }
}

fn validate_instance_id(instance_id: &str) -> Result<(), KeyringError> {
    if instance_id.is_empty() || instance_id.len() > 128 {
        return Err(KeyringError::Failure);
    }
    Ok(())
}

impl CredentialCustody for SharedMemoryCredentialCustody {
    fn installation_id(&self) -> Result<String, KeyringError> {
        Ok(CONFORMANCE_INSTALLATION_ID.to_owned())
    }

    fn read(&self, instance_id: &str, origin: &str) -> Result<Credential, KeyringError> {
        match self.read_for_pairing_update(instance_id, origin)? {
            CredentialSlot::Current(credential) => Ok(credential),
            CredentialSlot::Missing | CredentialSlot::Stale(_) => Err(KeyringError::NotFound),
        }
    }

    fn read_for_pairing_update(
        &self,
        instance_id: &str,
        origin: &str,
    ) -> Result<CredentialSlot, KeyringError> {
        validate_instance_id(instance_id)?;
        validate_credential_origin(origin)?;
        let store = self.lock()?;
        let Some(credential) = store.credentials.get(instance_id).cloned() else {
            return Ok(CredentialSlot::Missing);
        };
        if credential.origin == origin {
            Ok(CredentialSlot::Current(credential))
        } else {
            Ok(CredentialSlot::Stale(credential))
        }
    }

    fn store_if_current(
        &self,
        instance_id: &str,
        origin: &str,
        expected_credential: Option<&Credential>,
        bearer: &str,
        credential_id: &str,
    ) -> Result<bool, KeyringError> {
        validate_instance_id(instance_id)?;
        validate_credential_origin(origin)?;
        if let Some(expected_credential) = expected_credential {
            validate_credential_origin(&expected_credential.origin)?;
        }
        if bearer.is_empty() || credential_id.is_empty() {
            return Err(KeyringError::Failure);
        }
        let mut store = self.lock()?;
        let matches_expected = match (store.credentials.get(instance_id), expected_credential) {
            (None, None) => true,
            (Some(current), Some(expected)) => {
                current.origin == origin
                    && current.bearer == expected.bearer
                    && current.credential_id == expected.credential_id
                    && current.origin == expected.origin
            }
            _ => false,
        };
        if !matches_expected {
            return Ok(false);
        }
        store.credentials.insert(
            instance_id.to_owned(),
            Credential {
                bearer: bearer.to_owned(),
                credential_id: credential_id.to_owned(),
                origin: origin.to_owned(),
            },
        );
        Ok(true)
    }

    fn replace_stale_if_current(
        &self,
        instance_id: &str,
        origin: &str,
        expected_stale_credential: &Credential,
        bearer: &str,
        credential_id: &str,
    ) -> Result<bool, KeyringError> {
        validate_instance_id(instance_id)?;
        validate_credential_origin(origin)?;
        validate_credential_origin(&expected_stale_credential.origin)?;
        if bearer.is_empty()
            || credential_id.is_empty()
            || expected_stale_credential.origin == origin
        {
            return Err(KeyringError::Failure);
        }
        let mut store = self.lock()?;
        let Some(current) = store.credentials.get(instance_id) else {
            return Ok(false);
        };
        if current.origin == origin
            || current.bearer != expected_stale_credential.bearer
            || current.credential_id != expected_stale_credential.credential_id
            || current.origin != expected_stale_credential.origin
        {
            return Ok(false);
        }
        store.credentials.insert(
            instance_id.to_owned(),
            Credential {
                bearer: bearer.to_owned(),
                credential_id: credential_id.to_owned(),
                origin: origin.to_owned(),
            },
        );
        Ok(true)
    }

    fn delete_if_matches(
        &self,
        instance_id: &str,
        origin: &str,
        expected_credential: &Credential,
    ) -> Result<bool, KeyringError> {
        validate_instance_id(instance_id)?;
        validate_credential_origin(origin)?;
        validate_credential_origin(&expected_credential.origin)?;
        let mut store = self.lock()?;
        let Some(current) = store.credentials.get(instance_id) else {
            return Ok(false);
        };
        if current.origin != origin
            || current.bearer != expected_credential.bearer
            || current.credential_id != expected_credential.credential_id
            || current.origin != expected_credential.origin
        {
            return Ok(false);
        }
        store.credentials.remove(instance_id);
        Ok(true)
    }
}

pub struct ConformanceCaveLauncher;

struct ConformanceCaveChild {
    child: Child,
    reaped: bool,
    #[cfg(windows)]
    _job: WindowsCaveJob,
}

#[cfg(windows)]
struct WindowsCaveJob(isize);

#[cfg(windows)]
impl Drop for WindowsCaveJob {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(
                self.0 as windows_sys::Win32::Foundation::HANDLE,
            );
        }
    }
}

#[cfg(windows)]
fn bind_windows_cave_job(child: &Child) -> io::Result<WindowsCaveJob> {
    use std::{mem::size_of, os::windows::io::AsRawHandle, ptr};

    use windows_sys::Win32::{
        Foundation::CloseHandle,
        System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
    };

    let job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
    if job.is_null() {
        return Err(io::Error::last_os_error());
    }
    let mut information = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    information.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            (&raw const information).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        )
    } == 0
    {
        let error = io::Error::last_os_error();
        unsafe {
            CloseHandle(job);
        }
        return Err(error);
    }
    if unsafe { AssignProcessToJobObject(job, child.as_raw_handle()) } == 0 {
        let error = io::Error::last_os_error();
        unsafe {
            CloseHandle(job);
        }
        return Err(error);
    }
    Ok(WindowsCaveJob(job as isize))
}

#[cfg(windows)]
fn resume_windows_cave(child: &Child) -> io::Result<()> {
    use std::mem::size_of;

    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD,
                THREADENTRY32,
            },
            Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME},
        },
    };

    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
    if snapshot == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    let mut entry = THREADENTRY32 {
        dwSize: size_of::<THREADENTRY32>() as u32,
        ..THREADENTRY32::default()
    };
    let mut found = false;
    let mut status = unsafe { Thread32First(snapshot, &mut entry) };
    while status != 0 {
        if entry.th32OwnerProcessID == child.id() {
            found = true;
            let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
            if thread.is_null() {
                let error = io::Error::last_os_error();
                unsafe {
                    CloseHandle(snapshot);
                }
                return Err(error);
            }
            if unsafe { ResumeThread(thread) } == u32::MAX {
                let error = io::Error::last_os_error();
                unsafe {
                    CloseHandle(thread);
                    CloseHandle(snapshot);
                }
                return Err(error);
            }
            unsafe {
                CloseHandle(thread);
            }
        }
        status = unsafe { Thread32Next(snapshot, &mut entry) };
    }
    unsafe {
        CloseHandle(snapshot);
    }
    if !found {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "suspended Cave process had no resumable thread",
        ));
    }
    Ok(())
}

impl ConformanceCaveChild {
    fn terminate_and_reap(&mut self) {
        if self.reaped {
            return;
        }
        let _ = self.child.kill();
        if self.child.wait().is_ok() {
            self.reaped = true;
        }
    }
}

impl CaveChild for ConformanceCaveChild {
    fn try_wait(&mut self) -> NativeResult<bool> {
        if self.reaped {
            return Ok(true);
        }
        self.child
            .try_wait()
            .map(|status| {
                self.reaped = status.is_some();
                self.reaped
            })
            .map_err(|_| NativeDiagnostic::new("cave_launch_failed", true))
    }

    fn terminate(&mut self) -> NativeResult<()> {
        if self.reaped {
            return Ok(());
        }
        match self.child.kill() {
            Ok(()) | Err(_) => {}
        }
        Ok(())
    }

    fn wait(&mut self) -> NativeResult<()> {
        if self.reaped {
            return Ok(());
        }
        self.child
            .wait()
            .map(|_| {
                self.reaped = true;
            })
            .map_err(|_| NativeDiagnostic::new("cave_launch_failed", true))
    }
}

impl Drop for ConformanceCaveChild {
    fn drop(&mut self) {
        self.terminate_and_reap();
    }
}

fn regular_absolute_environment_path(name: &str) -> NativeResult<PathBuf> {
    let path = env::var_os(name)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .ok_or_else(|| NativeDiagnostic::new("cave_launch_configuration_invalid", false))?;
    if !path.is_absolute() {
        return Err(NativeDiagnostic::new(
            "cave_launch_configuration_invalid",
            false,
        ));
    }
    let metadata = std::fs::symlink_metadata(&path)
        .map_err(|_| NativeDiagnostic::new("cave_launch_configuration_invalid", false))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(NativeDiagnostic::new(
            "cave_launch_configuration_invalid",
            false,
        ));
    }
    Ok(path)
}

impl CaveLauncher for ConformanceCaveLauncher {
    fn launch(&self) -> NativeResult<Box<dyn CaveChild>> {
        let node = regular_absolute_environment_path(CONFORMANCE_NODE_PATH_ENV)?;
        let server = regular_absolute_environment_path(CONFORMANCE_CAVE_SERVER_PATH_ENV)?;
        let mut command = Command::new(node);
        command
            .arg(server)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            use windows_sys::Win32::System::Threading::CREATE_SUSPENDED;

            command.creation_flags(CREATE_SUSPENDED);
        }
        let child = command
            .spawn()
            .map_err(|_| NativeDiagnostic::new("cave_launch_failed", true))?;
        #[cfg(windows)]
        let mut child = child;
        #[cfg(windows)]
        let job = bind_windows_cave_job(&child).map_err(|_| {
            let _ = child.kill();
            let _ = child.wait();
            NativeDiagnostic::new("cave_launch_failed", true)
        })?;
        #[cfg(windows)]
        if resume_windows_cave(&child).is_err() {
            drop(job);
            let _ = child.kill();
            let _ = child.wait();
            return Err(NativeDiagnostic::new("cave_launch_failed", true));
        }
        Ok(Box::new(ConformanceCaveChild {
            child,
            reaped: false,
            #[cfg(windows)]
            _job: job,
        }))
    }
}

pub struct RpcRuntime {
    custody: Arc<dyn CredentialCustody>,
    emergency_cleanup: Option<Arc<dyn ConformanceCredentialCleanup>>,
    pending_reservation_response: Option<PreparedResponseRollback>,
    armed_reservation_cleanup: Option<PreparedResponseRollback>,
    state: NativeConnectionState,
}

impl Clone for RpcRuntime {
    fn clone(&self) -> Self {
        Self {
            custody: Arc::clone(&self.custody),
            emergency_cleanup: self.emergency_cleanup.clone(),
            pending_reservation_response: None,
            armed_reservation_cleanup: None,
            state: self.state.clone(),
        }
    }
}

trait ConformanceCredentialCleanup: Send + Sync {
    fn state(&self, instance_ids: &[String]) -> Result<(&'static str, bool, String), KeyringError>;
    fn issue_cleanup_grant(&self, instance_ids: &[String]) -> Result<String, KeyringError>;
    fn cleanup_state(&self, grant: &str) -> Result<(&'static str, bool, String), KeyringError>;
    fn prepare(&self, instance_id: &str) -> Result<ConformanceCleanupReservation, KeyringError>;
    fn begin_adopt(
        &self,
        handle: &str,
        capability: &str,
        owner_token: &str,
        successor_owner_token: &str,
    ) -> Result<ConformanceCleanupReservation, KeyringError>;
    fn commit_adopt(
        &self,
        handle: &str,
        capability: &str,
        owner_token: &str,
        successor_owner_token: &str,
    ) -> Result<(), KeyringError>;
    fn abort_adopt(
        &self,
        handle: &str,
        capability: &str,
        owner_token: &str,
        successor_owner_token: &str,
    ) -> Result<(), KeyringError>;
    fn cancel_prepared(&self) -> Result<(), KeyringError>;
    fn cleanup(
        &self,
        handle: &str,
        capability: &str,
        owner_token: &str,
    ) -> Result<ConformanceCleanupOutcome, KeyringError>;
}

impl ConformanceCredentialCleanup for NativeKeyring {
    fn state(&self, instance_ids: &[String]) -> Result<(&'static str, bool, String), KeyringError> {
        self.conformance_state(instance_ids)
    }

    fn issue_cleanup_grant(&self, instance_ids: &[String]) -> Result<String, KeyringError> {
        self.issue_conformance_cleanup_grant(instance_ids)
    }

    fn cleanup_state(&self, grant: &str) -> Result<(&'static str, bool, String), KeyringError> {
        self.redeem_conformance_cleanup_grant(grant)
    }

    fn prepare(&self, instance_id: &str) -> Result<ConformanceCleanupReservation, KeyringError> {
        self.prepare_conformance_cleanup(instance_id)
    }

    fn begin_adopt(
        &self,
        handle: &str,
        capability: &str,
        owner_token: &str,
        successor_owner_token: &str,
    ) -> Result<ConformanceCleanupReservation, KeyringError> {
        self.begin_adopt_conformance_cleanup(handle, capability, owner_token, successor_owner_token)
    }

    fn commit_adopt(
        &self,
        handle: &str,
        capability: &str,
        owner_token: &str,
        successor_owner_token: &str,
    ) -> Result<(), KeyringError> {
        self.commit_adopt_conformance_cleanup(
            handle,
            capability,
            owner_token,
            successor_owner_token,
        )
    }

    fn abort_adopt(
        &self,
        handle: &str,
        capability: &str,
        owner_token: &str,
        successor_owner_token: &str,
    ) -> Result<(), KeyringError> {
        self.abort_adopt_conformance_cleanup(handle, capability, owner_token, successor_owner_token)
    }

    fn cancel_prepared(&self) -> Result<(), KeyringError> {
        self.cancel_prepared_conformance_cleanup()
    }

    fn cleanup(
        &self,
        handle: &str,
        capability: &str,
        owner_token: &str,
    ) -> Result<ConformanceCleanupOutcome, KeyringError> {
        self.cleanup_conformance_credential(handle, capability, owner_token)
    }
}

impl RpcRuntime {
    pub fn new() -> Self {
        Self::with_custody(Arc::new(SharedMemoryCredentialCustody::new()), None)
    }

    fn with_custody(
        custody: Arc<dyn CredentialCustody>,
        emergency_cleanup: Option<Arc<dyn ConformanceCredentialCleanup>>,
    ) -> Self {
        let operations = Arc::new(NativeOperationRegistry::default());
        let mutations = Arc::new(NativeMutationQueue::default());
        Self {
            state: state_with_custody(Arc::clone(&custody), operations, mutations),
            custody,
            emergency_cleanup,
            pending_reservation_response: None,
            armed_reservation_cleanup: None,
        }
    }

    fn from_environment() -> Result<Self, NativeDiagnostic> {
        require_windows_job_supervision_from_environment()?;
        match env::var(CONFORMANCE_NATIVE_PROVIDER_PRESET_ENV) {
            Ok(value) if value == CONFORMANCE_NATIVE_PROVIDER_MISSING_KEYCHAIN_TRUST => {
                Ok(Self::with_custody(
                    Arc::new(NativeKeyring::with_provider_preset(
                        NativeProviderPreset::MissingKeychainTrust,
                    )),
                    None,
                ))
            }
            Ok(value) if value == CONFORMANCE_NATIVE_PROVIDER_PRODUCTION_KEYRING => {
                let keyring = Arc::new(NativeKeyring::for_conformance());
                Ok(Self::with_custody(
                    keyring.clone(),
                    Some(keyring as Arc<dyn ConformanceCredentialCleanup>),
                ))
            }
            Ok(value) if value == CONFORMANCE_NATIVE_PROVIDER_SYSTEM => {
                let keyring = Arc::new(
                    NativeKeyring::for_schema_v2()
                        .map_err(|_| NativeDiagnostic::new("invalid_native_input", false))?,
                );
                Ok(Self::with_custody(
                    keyring.clone(),
                    Some(keyring as Arc<dyn ConformanceCredentialCleanup>),
                ))
            }
            Ok(_) | Err(env::VarError::NotUnicode(_)) => {
                Err(NativeDiagnostic::new("invalid_native_input", false))
            }
            Err(env::VarError::NotPresent) => Ok(Self::new()),
        }
    }

    fn reset_native_state(&mut self) {
        self.state
            .cancel_all_operations(NativeCancelReason::Aborted);
        let operations = self.state.operation_registry();
        let mutations = self.state.mutation_queue();
        self.state = state_with_custody(Arc::clone(&self.custody), operations, mutations);
    }

    pub fn process_line(&mut self, line: &[u8]) -> Value {
        self.process_line_with_action(line).0
    }

    fn process_line_with_action(&mut self, line: &[u8]) -> (Value, bool) {
        let request = match parse_request_line(line) {
            Ok(request) => request,
            Err(response) => return (response, false),
        };
        let result = self.process_request(request);
        if let Some(rollback) = self.pending_reservation_response.take() {
            self.armed_reservation_cleanup = Some(rollback);
        }
        result
    }

    fn process_request(&mut self, request: RpcRequest) -> (Value, bool) {
        let id = request.id;
        match self.dispatch(request.command) {
            Ok((result, shutdown)) => (success_response(id, result), shutdown),
            Err(error) => (failure_response(id, error.code, error.retryable), false),
        }
    }

    fn dispatch(&mut self, command: RpcCommand) -> Result<(Value, bool), NativeDiagnostic> {
        let result = match command {
            RpcCommand::AppInstallationId => json!(self.state.installation_id()?),
            RpcCommand::CaveReadDiscovery { operation } => {
                let runner = self.state.clone();
                let operation_state = runner.clone();
                value_from(tauri::async_runtime::block_on(
                    runner.run_controlled_operation(operation, move |lease| async move {
                        operation_state.cave_read_discovery_managed(lease).await
                    }),
                )?)?
            }
            RpcCommand::CaveCancelOperation { attempt_id, reason } => {
                value_from(self.state.cancel_operation(attempt_id, reason)?)?
            }
            RpcCommand::CaveLaunch => {
                tauri::async_runtime::block_on(self.state.cave_launch())?;
                Value::Null
            }
            RpcCommand::CaveHealth { handle, operation } => {
                let runner = self.state.clone();
                let operation_state = runner.clone();
                tauri::async_runtime::block_on(runner.run_operation(operation, async move {
                    operation_state.cave_health(handle).await
                }))?
            }
            RpcCommand::CovenHealth { operation } => {
                let runner = self.state.clone();
                let operation_state = runner.clone();
                value_from(tauri::async_runtime::block_on(
                    runner.run_operation(
                        operation,
                        async move { operation_state.coven_health().await },
                    ),
                )?)?
            }
            RpcCommand::CavePairingCreate {
                handle,
                request,
                operation,
            } => {
                let runner = self.state.clone();
                let operation_state = runner.clone();
                tauri::async_runtime::block_on(runner.run_operation(operation, async move {
                    operation_state.cave_pairing_create(handle, request).await
                }))?
            }
            RpcCommand::CavePairingPoll {
                handle,
                request_id,
                operation,
            } => {
                let runner = self.state.clone();
                let operation_state = runner.clone();
                tauri::async_runtime::block_on(runner.run_operation(operation, async move {
                    operation_state.cave_pairing_poll(handle, request_id).await
                }))?
            }
            RpcCommand::CavePairingExchange {
                handle,
                request_id,
                operation,
            } => {
                let runner = self.state.clone();
                let operation_state = runner.clone();
                tauri::async_runtime::block_on(runner.run_mutating_operation(
                    operation,
                    move |mutation| async move {
                        operation_state
                            .cave_pairing_exchange_managed(handle, request_id, mutation)
                            .await
                    },
                ))?
            }
            RpcCommand::CaveResetPairing { handle } => self.state.cave_reset_pairing(handle)?,
            RpcCommand::CaveCredentialStatus { handle, operation } => {
                let runner = self.state.clone();
                let operation_state = runner.clone();
                tauri::async_runtime::block_on(runner.run_mutating_operation(
                    operation,
                    move |mutation| async move {
                        operation_state
                            .cave_credential_status_managed(handle, mutation)
                            .await
                    },
                ))?
            }
            RpcCommand::CaveForgetCredential { handle, operation } => {
                let runner = self.state.clone();
                let operation_state = runner.clone();
                tauri::async_runtime::block_on(runner.run_mutating_operation(
                    operation,
                    move |mutation| async move {
                        operation_state
                            .cave_forget_credential_managed(handle, mutation)
                            .await
                    },
                ))?
            }
            RpcCommand::ConformancePrepareNativeCleanup { handle } => {
                let cleanup = self
                    .emergency_cleanup
                    .as_ref()
                    .ok_or_else(|| NativeDiagnostic::new("invalid_native_input", false))?;
                let instance_id = self.state.conformance_authorized_instance_id(&handle)?;
                let reservation = cleanup
                    .prepare(&instance_id)
                    .map_err(|error| error.diagnostic())?;
                let rollback = PreparedResponseRollback::new(cleanup.clone(), reservation.clone());
                let result = value_from(reservation.clone())?;
                self.pending_reservation_response = Some(rollback);
                result
            }
            RpcCommand::ConformanceBeginAdoptNativeCleanup {
                reservation_handle,
                capability,
                owner_token,
                successor_owner_token,
            } => {
                let cleanup = self
                    .emergency_cleanup
                    .as_ref()
                    .ok_or_else(|| NativeDiagnostic::new("invalid_native_input", false))?;
                let reservation = cleanup
                    .begin_adopt(
                        &reservation_handle,
                        &capability,
                        &owner_token,
                        &successor_owner_token,
                    )
                    .map_err(|error| error.diagnostic())?;
                let rollback = PreparedResponseRollback::new_pending(
                    cleanup.clone(),
                    reservation.clone(),
                    owner_token,
                );
                let result = value_from(reservation)?;
                self.pending_reservation_response = Some(rollback);
                result
            }
            RpcCommand::ConformanceCommitAdoptNativeCleanup {
                reservation_handle,
                capability,
                owner_token,
                successor_owner_token,
            } => {
                let cleanup = self
                    .emergency_cleanup
                    .as_ref()
                    .ok_or_else(|| NativeDiagnostic::new("invalid_native_input", false))?;
                adoption_fault_barrier("before-commit")?;
                cleanup
                    .commit_adopt(
                        &reservation_handle,
                        &capability,
                        &owner_token,
                        &successor_owner_token,
                    )
                    .map_err(|error| error.diagnostic())?;
                adoption_fault_barrier("after-commit")?;
                let reservation = ConformanceCleanupReservation {
                    reservation_handle,
                    capability,
                    owner_token: successor_owner_token.clone(),
                };
                if let Some(rollback) = self.armed_reservation_cleanup.take() {
                    rollback.disarm();
                }
                self.armed_reservation_cleanup = Some(PreparedResponseRollback::new_active(
                    cleanup.clone(),
                    reservation,
                ));
                json!({ "status": "committed", "ownerToken": successor_owner_token })
            }
            RpcCommand::ConformanceAbortAdoptNativeCleanup {
                reservation_handle,
                capability,
                owner_token,
                successor_owner_token,
            } => {
                let cleanup = self
                    .emergency_cleanup
                    .as_ref()
                    .ok_or_else(|| NativeDiagnostic::new("invalid_native_input", false))?;
                cleanup
                    .abort_adopt(
                        &reservation_handle,
                        &capability,
                        &owner_token,
                        &successor_owner_token,
                    )
                    .map_err(|error| error.diagnostic())?;
                if let Some(rollback) = self.armed_reservation_cleanup.take() {
                    rollback.disarm();
                }
                json!({ "status": "aborted" })
            }
            RpcCommand::ConformanceCancelPreparedNativeCleanup => {
                let cleanup = self
                    .emergency_cleanup
                    .as_ref()
                    .ok_or_else(|| NativeDiagnostic::new("invalid_native_input", false))?;
                cleanup
                    .cancel_prepared()
                    .map_err(|error| error.diagnostic())?;
                if let Some(rollback) = self.armed_reservation_cleanup.take() {
                    rollback.disarm();
                }
                json!({ "status": "missing" })
            }
            RpcCommand::ConformanceDeleteNativeCredential {
                reservation_handle,
                capability,
                owner_token,
            } => {
                let cleanup = self
                    .emergency_cleanup
                    .as_ref()
                    .ok_or_else(|| NativeDiagnostic::new("invalid_native_input", false))?;
                let outcome = cleanup
                    .cleanup(&reservation_handle, &capability, &owner_token)
                    .map_err(|error| error.diagnostic())?;
                if outcome == ConformanceCleanupOutcome::Transferred {
                    return Err(NativeDiagnostic::new("stale_cleanup_owner", false));
                }
                if self
                    .armed_reservation_cleanup
                    .as_ref()
                    .is_some_and(|rollback| {
                        rollback.matches(&reservation_handle, &capability, &owner_token)
                    })
                {
                    self.armed_reservation_cleanup
                        .take()
                        .expect("checked armed reservation")
                        .disarm();
                }
                json!({ "status": "missing" })
            }
            RpcCommand::ConformanceNativeCustodyState { instance_ids } => {
                let cleanup = self
                    .emergency_cleanup
                    .as_ref()
                    .ok_or_else(|| NativeDiagnostic::new("invalid_native_input", false))?;
                let (backend, empty, state_sha256) = cleanup
                    .state(&instance_ids)
                    .map_err(|error| error.diagnostic())?;
                json!({
                    "backend": backend,
                    "available": true,
                    "empty": empty,
                    "stateSha256": state_sha256,
                })
            }
            RpcCommand::ConformanceIssueNativeCustodyCleanup { instance_ids } => {
                let cleanup = self
                    .emergency_cleanup
                    .as_ref()
                    .ok_or_else(|| NativeDiagnostic::new("invalid_native_input", false))?;
                let grant = cleanup
                    .issue_cleanup_grant(&instance_ids)
                    .map_err(|error| error.diagnostic())?;
                json!({ "grant": grant })
            }
            RpcCommand::ConformanceCleanupNativeCustody { grant } => {
                let cleanup = self
                    .emergency_cleanup
                    .as_ref()
                    .ok_or_else(|| NativeDiagnostic::new("invalid_native_input", false))?;
                let (backend, empty, state_sha256) = cleanup
                    .cleanup_state(&grant)
                    .map_err(|error| error.diagnostic())?;
                json!({
                    "backend": backend,
                    "available": true,
                    "empty": empty,
                    "stateSha256": state_sha256,
                })
            }
            RpcCommand::CaveListFamiliars {
                handle,
                page,
                operation,
            } => {
                let runner = self.state.clone();
                let operation_state = runner.clone();
                tauri::async_runtime::block_on(runner.run_operation(operation, async move {
                    operation_state
                        .cave_read(handle, CaveReadPath::Familiars { page })
                        .await
                }))?
            }
            RpcCommand::CaveListProjects {
                handle,
                page,
                operation,
            } => {
                let runner = self.state.clone();
                let operation_state = runner.clone();
                tauri::async_runtime::block_on(runner.run_operation(operation, async move {
                    operation_state
                        .cave_read(handle, CaveReadPath::Projects { page })
                        .await
                }))?
            }
            RpcCommand::CaveListConversations {
                handle,
                page,
                operation,
            } => {
                let runner = self.state.clone();
                let operation_state = runner.clone();
                tauri::async_runtime::block_on(runner.run_operation(operation, async move {
                    operation_state
                        .cave_read(handle, CaveReadPath::Conversations { page })
                        .await
                }))?
            }
            RpcCommand::CaveGetConversation {
                handle,
                conversation_id,
                operation,
            } => {
                let runner = self.state.clone();
                let operation_state = runner.clone();
                tauri::async_runtime::block_on(runner.run_operation(operation, async move {
                    operation_state
                        .cave_read(handle, CaveReadPath::Conversation { conversation_id })
                        .await
                }))?
            }
            RpcCommand::CaveListConversationMessages {
                handle,
                conversation_id,
                page,
                operation,
            } => {
                let runner = self.state.clone();
                let operation_state = runner.clone();
                tauri::async_runtime::block_on(runner.run_operation(operation, async move {
                    operation_state
                        .cave_read(
                            handle,
                            CaveReadPath::ConversationMessages {
                                conversation_id,
                                page,
                            },
                        )
                        .await
                }))?
            }
            RpcCommand::ResetNativeState => {
                self.reset_native_state();
                json!({ "status": "reset" })
            }
            RpcCommand::Shutdown => return Ok((json!({ "status": "shutting_down" }), true)),
        };
        Ok((result, false))
    }

    fn take_pending_reservation_response(&mut self) -> Option<PreparedResponseRollback> {
        self.pending_reservation_response.take()
    }

    fn arm_delivered_reservation(&mut self, rollback: Option<PreparedResponseRollback>) {
        if let Some(rollback) = rollback {
            self.armed_reservation_cleanup = Some(rollback);
        }
    }

    fn cleanup_armed_reservation(&mut self) -> Result<(), KeyringError> {
        match self.armed_reservation_cleanup.take() {
            Some(rollback) => rollback.rollback(),
            None => Ok(()),
        }
    }
}

impl Drop for RpcRuntime {
    fn drop(&mut self) {
        if let Some(rollback) = self.pending_reservation_response.take() {
            let _ = rollback.rollback();
        }
        if let Some(rollback) = self.armed_reservation_cleanup.take() {
            let _ = rollback.rollback();
        }
    }
}

impl Default for RpcRuntime {
    fn default() -> Self {
        Self::new()
    }
}

fn state_with_custody(
    custody: Arc<dyn CredentialCustody>,
    operations: Arc<NativeOperationRegistry>,
    mutations: Arc<NativeMutationQueue>,
) -> NativeConnectionState {
    NativeConnectionState::with_test_launch_collaborators(
        Arc::new(ConstrainedTransport) as Arc<dyn NativeCaveTransport>,
        custody,
        Arc::new(NativeCaveDiscoveryReader),
        Arc::new(ConformanceCaveLauncher),
        Arc::new(NativeCaveClock::default()),
        Arc::new(NativeCaveSleeper),
        Arc::new(NativeCaveTaskRunner),
    )
    .using_runtime_guards(operations, mutations)
}

fn value_from<T: serde::Serialize>(value: T) -> NativeResult<Value> {
    serde_json::to_value(value)
        .map_err(|_| NativeDiagnostic::new("conformance_serialization_failure", false))
}

fn valid_request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_REQUEST_ID_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn parsed_request_id(value: &Value) -> &str {
    value
        .as_object()
        .and_then(|object| object.get("id"))
        .and_then(Value::as_str)
        .filter(|id| valid_request_id(id))
        .unwrap_or(INVALID_REQUEST_ID)
}

fn parse_request_line(line: &[u8]) -> Result<RpcRequest, Value> {
    if line.len() > MAX_LINE_BYTES {
        return Err(failure_response(
            INVALID_REQUEST_ID,
            "invalid_request",
            false,
        ));
    }
    let value = match serde_json::from_slice::<Value>(line) {
        Ok(value) => value,
        Err(_) => {
            return Err(failure_response(
                INVALID_REQUEST_ID,
                "invalid_request",
                false,
            ));
        }
    };
    let id = parsed_request_id(&value).to_owned();
    let object = value
        .as_object()
        .ok_or_else(|| failure_response(INVALID_REQUEST_ID, "invalid_request", false))?;
    if object
        .keys()
        .any(|key| !matches!(key.as_str(), "id" | "command" | "args"))
    {
        return Err(failure_response(id, "invalid_request", false));
    }
    if object.contains_key("args") && !object["args"].is_object() {
        return Err(failure_response(id, "invalid_request", false));
    }
    let strict = serde_json::from_slice::<StrictRequest>(line)
        .map_err(|_| failure_response(id.clone(), "invalid_request", false))?;
    if !valid_request_id(&strict.id) {
        return Err(failure_response(
            INVALID_REQUEST_ID,
            "invalid_request",
            false,
        ));
    }
    let command = parse_command(&strict.command, strict.args)
        .map_err(|(code, retryable)| failure_response(strict.id.clone(), code, retryable))?;
    Ok(RpcRequest {
        id: strict.id,
        command,
    })
}

fn parse_command(command: &str, args: Option<Value>) -> Result<RpcCommand, (&'static str, bool)> {
    let args = args.unwrap_or_else(|| Value::Object(Map::new()));
    let object = args.as_object().ok_or(("invalid_native_input", false))?;
    let invalid = || Err(("invalid_native_input", false));
    match command {
        "app_installation_id" => {
            expect_exact_args(object, &[])?;
            Ok(RpcCommand::AppInstallationId)
        }
        "cave_read_discovery" => {
            expect_exact_args(object, &["operation"])?;
            Ok(RpcCommand::CaveReadDiscovery {
                operation: required_operation(object)?,
            })
        }
        "cave_cancel_operation" => {
            expect_exact_args(object, &["attemptId", "reason"])?;
            Ok(RpcCommand::CaveCancelOperation {
                attempt_id: required_attempt_id(object, "attemptId")?,
                reason: required_cancel_reason(object, "reason")?,
            })
        }
        "cave_launch" => {
            expect_exact_args(object, &[])?;
            Ok(RpcCommand::CaveLaunch)
        }
        "cave_health" => {
            expect_exact_args(object, &["handle", "operation"])?;
            Ok(RpcCommand::CaveHealth {
                handle: required_string(object, "handle")?,
                operation: required_operation(object)?,
            })
        }
        "coven_health" => {
            expect_exact_args(object, &["operation"])?;
            Ok(RpcCommand::CovenHealth {
                operation: required_operation(object)?,
            })
        }
        "cave_pairing_create" => {
            expect_exact_args(object, &["handle", "operation", "request"])?;
            let request = object
                .get("request")
                .filter(|value| value.is_object())
                .cloned();
            match request {
                Some(request) if validate_pairing_request(&request).is_ok() => {
                    Ok(RpcCommand::CavePairingCreate {
                        handle: required_string(object, "handle")?,
                        request,
                        operation: required_operation(object)?,
                    })
                }
                None => invalid(),
                Some(_) => invalid(),
            }
        }
        "cave_pairing_poll" => {
            expect_exact_args(object, &["handle", "operation", "requestId"])?;
            Ok(RpcCommand::CavePairingPoll {
                handle: required_string(object, "handle")?,
                request_id: required_pairing_request_id(object, "requestId")?,
                operation: required_operation(object)?,
            })
        }
        "cave_pairing_exchange" => {
            expect_exact_args(object, &["handle", "operation", "requestId"])?;
            Ok(RpcCommand::CavePairingExchange {
                handle: required_string(object, "handle")?,
                request_id: required_pairing_request_id(object, "requestId")?,
                operation: required_operation(object)?,
            })
        }
        "cave_reset_pairing" => {
            expect_exact_args(object, &["handle"])?;
            Ok(RpcCommand::CaveResetPairing {
                handle: required_string(object, "handle")?,
            })
        }
        "cave_credential_status" => {
            expect_exact_args(object, &["handle", "operation"])?;
            Ok(RpcCommand::CaveCredentialStatus {
                handle: required_string(object, "handle")?,
                operation: required_operation(object)?,
            })
        }
        "cave_forget_credential" => {
            expect_exact_args(object, &["handle", "operation"])?;
            Ok(RpcCommand::CaveForgetCredential {
                handle: required_string(object, "handle")?,
                operation: required_operation(object)?,
            })
        }
        "conformance_prepare_native_cleanup" => {
            expect_exact_args(object, &["handle"])?;
            Ok(RpcCommand::ConformancePrepareNativeCleanup {
                handle: required_string(object, "handle")?,
            })
        }
        "conformance_begin_adopt_native_cleanup"
        | "conformance_commit_adopt_native_cleanup"
        | "conformance_abort_adopt_native_cleanup" => {
            expect_exact_args(
                object,
                &[
                    "capability",
                    "ownerToken",
                    "reservationHandle",
                    "successorOwnerToken",
                ],
            )?;
            let reservation_handle = required_string(object, "reservationHandle")?;
            let capability = required_string(object, "capability")?;
            let owner_token = required_string(object, "ownerToken")?;
            let successor_owner_token = required_string(object, "successorOwnerToken")?;
            validate_installation_id(&reservation_handle)
                .and_then(|_| validate_installation_id(&capability))
                .and_then(|_| validate_installation_id(&owner_token))
                .and_then(|_| validate_installation_id(&successor_owner_token))
                .map_err(|_| ("invalid_native_input", false))?;
            match command {
                "conformance_begin_adopt_native_cleanup" => {
                    Ok(RpcCommand::ConformanceBeginAdoptNativeCleanup {
                        reservation_handle,
                        capability,
                        owner_token,
                        successor_owner_token,
                    })
                }
                "conformance_commit_adopt_native_cleanup" => {
                    Ok(RpcCommand::ConformanceCommitAdoptNativeCleanup {
                        reservation_handle,
                        capability,
                        owner_token,
                        successor_owner_token,
                    })
                }
                _ => Ok(RpcCommand::ConformanceAbortAdoptNativeCleanup {
                    reservation_handle,
                    capability,
                    owner_token,
                    successor_owner_token,
                }),
            }
        }
        "conformance_cancel_prepared_native_cleanup" => {
            expect_exact_args(object, &[])?;
            Ok(RpcCommand::ConformanceCancelPreparedNativeCleanup)
        }
        "conformance_delete_native_credential" => {
            expect_exact_args(object, &["capability", "ownerToken", "reservationHandle"])?;
            let reservation_handle = required_string(object, "reservationHandle")?;
            let capability = required_string(object, "capability")?;
            let owner_token = required_string(object, "ownerToken")?;
            validate_installation_id(&reservation_handle)
                .and_then(|_| validate_installation_id(&capability))
                .and_then(|_| validate_installation_id(&owner_token))
                .map_err(|_| ("invalid_native_input", false))?;
            Ok(RpcCommand::ConformanceDeleteNativeCredential {
                reservation_handle,
                capability,
                owner_token,
            })
        }
        "conformance_native_custody_state" => {
            expect_exact_args(object, &["instanceIds"])?;
            Ok(RpcCommand::ConformanceNativeCustodyState {
                instance_ids: required_instance_ids(object, "instanceIds")?,
            })
        }
        "conformance_issue_native_custody_cleanup" => {
            expect_exact_args(object, &["instanceIds"])?;
            Ok(RpcCommand::ConformanceIssueNativeCustodyCleanup {
                instance_ids: required_instance_ids(object, "instanceIds")?,
            })
        }
        "conformance_cleanup_native_custody" => {
            expect_exact_args(object, &["grant"])?;
            Ok(RpcCommand::ConformanceCleanupNativeCustody {
                grant: required_cleanup_grant(object, "grant")?,
            })
        }
        "cave_list_familiars" => {
            expect_exact_args(object, &["handle", "operation", "page"])?;
            Ok(RpcCommand::CaveListFamiliars {
                handle: required_string(object, "handle")?,
                page: required_page(object)?,
                operation: required_operation(object)?,
            })
        }
        "cave_list_projects" => {
            expect_exact_args(object, &["handle", "operation", "page"])?;
            Ok(RpcCommand::CaveListProjects {
                handle: required_string(object, "handle")?,
                page: required_page(object)?,
                operation: required_operation(object)?,
            })
        }
        "cave_list_conversations" => {
            expect_exact_args(object, &["handle", "operation", "page"])?;
            Ok(RpcCommand::CaveListConversations {
                handle: required_string(object, "handle")?,
                page: required_page(object)?,
                operation: required_operation(object)?,
            })
        }
        "cave_get_conversation" => {
            expect_exact_args(object, &["conversationId", "handle", "operation"])?;
            Ok(RpcCommand::CaveGetConversation {
                handle: required_string(object, "handle")?,
                conversation_id: required_conversation_id(object, "conversationId")?,
                operation: required_operation(object)?,
            })
        }
        "cave_list_conversation_messages" => {
            expect_exact_args(object, &["conversationId", "handle", "operation", "page"])?;
            Ok(RpcCommand::CaveListConversationMessages {
                handle: required_string(object, "handle")?,
                conversation_id: required_conversation_id(object, "conversationId")?,
                page: required_page(object)?,
                operation: required_operation(object)?,
            })
        }
        "conformance_reset_native_state" => {
            expect_exact_args(object, &[])?;
            Ok(RpcCommand::ResetNativeState)
        }
        "conformance_shutdown" => {
            expect_exact_args(object, &[])?;
            Ok(RpcCommand::Shutdown)
        }
        _ => Err(("invalid_rpc_command", false)),
    }
}

fn expect_exact_args(
    object: &Map<String, Value>,
    expected: &[&str],
) -> Result<(), (&'static str, bool)> {
    if object.len() != expected.len()
        || object
            .keys()
            .any(|key| !expected.iter().any(|expected| key == expected))
    {
        return Err(("invalid_native_input", false));
    }
    Ok(())
}

fn required_string(object: &Map<String, Value>, key: &str) -> Result<String, (&'static str, bool)> {
    object
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(("invalid_native_input", false))
}

fn required_attempt_id(
    object: &Map<String, Value>,
    key: &str,
) -> Result<String, (&'static str, bool)> {
    let attempt_id = required_string(object, key)?;
    NativeOperationInput::new(attempt_id.clone(), 1)
        .map_err(|_| ("invalid_native_input", false))?;
    Ok(attempt_id)
}

fn required_instance_ids(
    object: &Map<String, Value>,
    key: &str,
) -> Result<Vec<String>, (&'static str, bool)> {
    let values = object
        .get(key)
        .and_then(Value::as_array)
        .filter(|values| values.len() <= 8)
        .ok_or(("invalid_native_input", false))?;
    let mut instance_ids = Vec::with_capacity(values.len());
    for value in values {
        let instance_id = value
            .as_str()
            .filter(|value| validate_installation_id(value).is_ok())
            .ok_or(("invalid_native_input", false))?
            .to_owned();
        instance_ids.push(instance_id);
    }
    Ok(instance_ids)
}

fn required_cleanup_grant(
    object: &Map<String, Value>,
    key: &str,
) -> Result<Zeroizing<String>, (&'static str, bool)> {
    object
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| {
            value.len() == 43
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        })
        .map(|value| Zeroizing::new(value.to_owned()))
        .ok_or(("invalid_native_input", false))
}

fn required_operation(
    object: &Map<String, Value>,
) -> Result<NativeOperationInput, (&'static str, bool)> {
    let operation = object
        .get("operation")
        .and_then(Value::as_object)
        .ok_or(("invalid_native_input", false))?;
    expect_exact_args(operation, &["attemptId", "timeoutMs"])?;
    let attempt_id = required_string(operation, "attemptId")?;
    let timeout_ms = operation
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value <= MAX_NATIVE_OPERATION_TIMEOUT_MS)
        .ok_or(("invalid_native_input", false))?;
    NativeOperationInput::new(attempt_id, timeout_ms).map_err(|_| ("invalid_native_input", false))
}

fn required_cancel_reason(
    object: &Map<String, Value>,
    key: &str,
) -> Result<NativeCancelReason, (&'static str, bool)> {
    match object.get(key).and_then(Value::as_str) {
        Some("aborted") => Ok(NativeCancelReason::Aborted),
        Some("timeout") => Ok(NativeCancelReason::Timeout),
        _ => Err(("invalid_native_input", false)),
    }
}

fn required_conversation_id(
    object: &Map<String, Value>,
    key: &str,
) -> Result<String, (&'static str, bool)> {
    let value = required_string(object, key)?;
    if value.trim().is_empty()
        || matches!(value.as_str(), "." | "..")
        || value.len() > 2_048
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~'))
    {
        return Err(("invalid_native_input", false));
    }
    Ok(value)
}

fn required_pairing_request_id(
    object: &Map<String, Value>,
    key: &str,
) -> Result<String, (&'static str, bool)> {
    let value = required_string(object, key)?;
    let parsed = uuid::Uuid::parse_str(&value).map_err(|_| ("invalid_native_input", false))?;
    if parsed.to_string() != value || parsed.get_variant() != uuid::Variant::RFC4122 {
        return Err(("invalid_native_input", false));
    }
    Ok(value)
}

fn required_page(object: &Map<String, Value>) -> Result<NativePage, (&'static str, bool)> {
    let page = object
        .get("page")
        .and_then(Value::as_object)
        .ok_or(("invalid_native_input", false))?;
    expect_allowed_args(page, &["limit", "cursor"])?;
    let limit = match page.get("limit") {
        Some(value) => value
            .as_u64()
            .and_then(|limit| u16::try_from(limit).ok())
            .ok_or(("invalid_native_input", false))?,
        None => 0,
    };
    let cursor = match page.get("cursor") {
        Some(value) => Some(
            value
                .as_str()
                .map(str::to_owned)
                .ok_or(("invalid_native_input", false))?,
        ),
        None => None,
    };
    let page = NativePage {
        limit: page.contains_key("limit").then_some(limit),
        cursor,
    };
    page.validate()
        .map_err(|_| ("invalid_native_input", false))?;
    Ok(page)
}

fn expect_allowed_args(
    object: &Map<String, Value>,
    allowed: &[&str],
) -> Result<(), (&'static str, bool)> {
    if object
        .keys()
        .any(|key| !allowed.iter().any(|allowed| key == allowed))
    {
        return Err(("invalid_native_input", false));
    }
    Ok(())
}

fn success_response(id: String, result: Value) -> Value {
    json!({
        "id": id,
        "ok": true,
        "result": result,
    })
}

fn failure_response(id: impl Into<String>, code: &'static str, retryable: bool) -> Value {
    json!({
        "id": id.into(),
        "ok": false,
        "error": {
            "code": code,
            "retryable": retryable,
        },
    })
}

enum BoundedLine {
    Line(Vec<u8>),
    Oversized,
}

fn read_bounded_line(reader: &mut impl BufRead) -> io::Result<Option<BoundedLine>> {
    let mut line = Vec::with_capacity(8 * 1024);
    let mut oversized = false;
    let mut read_any = false;

    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return if read_any {
                Ok(Some(if oversized {
                    BoundedLine::Oversized
                } else {
                    BoundedLine::Line(line)
                }))
            } else {
                Ok(None)
            };
        }
        read_any = true;

        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let content_len = newline.unwrap_or(buffer.len());
        if !oversized {
            let remaining = MAX_LINE_BYTES - line.len();
            let copy_len = content_len.min(remaining);
            line.extend_from_slice(&buffer[..copy_len]);
            oversized = content_len > remaining;
        }

        let consumed = newline.map_or(buffer.len(), |position| position + 1);
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(Some(if oversized {
                BoundedLine::Oversized
            } else {
                BoundedLine::Line(line)
            }));
        }
    }
}

pub fn run_stdio() -> io::Result<()> {
    let stdin = io::stdin();
    let mut stdin = stdin.lock();
    let stdout = Arc::new(Mutex::new(io::BufWriter::new(io::stdout())));
    let mut runtime = match RpcRuntime::from_environment() {
        Ok(runtime) => runtime,
        Err(error) => {
            write_rpc_response(
                &stdout,
                &failure_response(INVALID_REQUEST_ID, error.code, error.retryable),
            )?;
            return Ok(());
        }
    };
    let mut workers = Vec::new();
    while let Some(line) = read_bounded_line(&mut stdin)? {
        reap_rpc_workers(&mut workers)?;
        let request = match line {
            BoundedLine::Line(mut line) => {
                let request = parse_request_line(&line);
                line.zeroize();
                match request {
                    Ok(request) => request,
                    Err(response) => {
                        write_rpc_response(&stdout, &response)?;
                        continue;
                    }
                }
            }
            BoundedLine::Oversized => {
                write_rpc_response(
                    &stdout,
                    &failure_response(INVALID_REQUEST_ID, "invalid_request", false),
                )?;
                continue;
            }
        };
        if request.command.runs_concurrently() {
            if workers.len() >= MAX_RPC_WORKERS {
                write_rpc_response(
                    &stdout,
                    &failure_response(request.id, "service_unavailable", true),
                )?;
                continue;
            }
            let mut worker_runtime = runtime.clone();
            let worker_stdout = Arc::clone(&stdout);
            workers.push(std::thread::spawn(move || {
                let (response, _) = worker_runtime.process_request(request);
                write_rpc_response(&worker_stdout, &response)
            }));
            continue;
        }
        if request.command.is_barrier() {
            runtime
                .state
                .cancel_all_operations(NativeCancelReason::Aborted);
            join_rpc_workers(&mut workers)?;
        }
        let (response, shutdown) = runtime.process_request(request);
        let reservation = runtime.take_pending_reservation_response();
        let delivered = write_rpc_response_transaction(&stdout, &response, reservation)?;
        runtime.arm_delivered_reservation(delivered);
        if shutdown {
            break;
        }
    }
    runtime
        .state
        .cancel_all_operations(NativeCancelReason::Aborted);
    join_rpc_workers(&mut workers)?;
    runtime
        .cleanup_armed_reservation()
        .map_err(|_| io::Error::other("native reservation cleanup failed"))?;
    Ok(())
}

pub fn run_internal_test_reservation_output_if_requested() -> Option<io::Result<()>> {
    let args = env::args_os().collect::<Vec<_>>();
    if args.len() != 2 {
        return None;
    }
    let wait_for_eof = if args[1] == INTERNAL_TEST_RESERVATION_OUTPUT_ARGUMENT {
        false
    } else if args[1] == INTERNAL_TEST_RESERVATION_EOF_ARGUMENT {
        true
    } else {
        return None;
    };
    Some(run_internal_test_reservation_output(wait_for_eof))
}

fn run_internal_test_reservation_output(wait_for_eof: bool) -> io::Result<()> {
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;

    if env::var(INTERNAL_TEST_KEYCHAIN_ISOLATED_ENV).as_deref() != Ok("1") {
        return Err(io::Error::other("isolated test keychain is not configured"));
    }
    let result_path = PathBuf::from(
        env::var_os(INTERNAL_TEST_RESERVATION_RESULT_PATH_ENV)
            .ok_or_else(|| io::Error::other("reservation result path is unavailable"))?,
    );
    let allowed_root = PathBuf::from(
        env::var_os("CARGO_TARGET_DIR")
            .ok_or_else(|| io::Error::other("isolated Cargo target root is unavailable"))?,
    )
    .join("phase1-native-rpc-tests");
    let parent = result_path
        .parent()
        .ok_or_else(|| io::Error::other("reservation result parent is unavailable"))?;
    if !result_path.is_absolute()
        || result_path.file_name().and_then(|name| name.to_str()) != Some("reservation.json")
        || !parent.starts_with(&allowed_root)
        || std::fs::canonicalize(parent)
            .map(|canonical| !canonical.starts_with(&allowed_root))
            .unwrap_or(true)
    {
        return Err(io::Error::other("reservation result path is invalid"));
    }

    let keyring = Arc::new(NativeKeyring::for_conformance());
    let instance_id = uuid::Uuid::new_v4().to_string();
    let reservation = keyring
        .prepare_conformance_cleanup(&instance_id)
        .map_err(|_| io::Error::other("test reservation creation failed"))?;
    let cleanup: Arc<dyn ConformanceCredentialCleanup> = keyring.clone();
    let rollback = PreparedResponseRollback::new(cleanup.clone(), reservation.clone());
    let control = json!({
        "reservationHandle": reservation.reservation_handle,
        "capability": reservation.capability,
        "ownerToken": reservation.owner_token,
        "instanceId": instance_id,
    });
    let mut options = OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut control_file = options.open(&result_path)?;
    serde_json::to_writer(&mut control_file, &control)?;
    control_file.write_all(b"\n")?;
    control_file.sync_all()?;

    let response = success_response("prepare".to_owned(), control);
    let stdout = Arc::new(Mutex::new(io::BufWriter::new(io::stdout())));
    match write_rpc_response_transaction(&stdout, &response, Some(rollback)) {
        Ok(Some(rollback)) => {
            if wait_for_eof {
                keyring
                    .store_if_current(
                        &instance_id,
                        "http://127.0.0.1:4310/",
                        None,
                        "test-bearer",
                        "test-credential",
                    )
                    .map_err(|_| io::Error::other("test credential storage failed"))?;
                let mut input = Vec::new();
                io::stdin().read_to_end(&mut input)?;
            }
            rollback
                .rollback()
                .map_err(|_| io::Error::other("test reservation cleanup failed"))
        }
        Ok(None) => Err(io::Error::other("test reservation guard was unavailable")),
        Err(error) => Err(error),
    }
}

struct PreparedResponseRollback {
    cleanup: Arc<dyn ConformanceCredentialCleanup>,
    reservation: ConformanceCleanupReservation,
    mode: ReservationGuardMode,
    armed: bool,
}

enum ReservationGuardMode {
    Active,
    Pending { predecessor_owner_token: String },
}

impl PreparedResponseRollback {
    fn new(
        cleanup: Arc<dyn ConformanceCredentialCleanup>,
        reservation: ConformanceCleanupReservation,
    ) -> Self {
        Self::new_active(cleanup, reservation)
    }

    fn new_active(
        cleanup: Arc<dyn ConformanceCredentialCleanup>,
        reservation: ConformanceCleanupReservation,
    ) -> Self {
        Self {
            cleanup,
            reservation,
            mode: ReservationGuardMode::Active,
            armed: true,
        }
    }

    fn new_pending(
        cleanup: Arc<dyn ConformanceCredentialCleanup>,
        reservation: ConformanceCleanupReservation,
        predecessor_owner_token: String,
    ) -> Self {
        Self {
            cleanup,
            reservation,
            mode: ReservationGuardMode::Pending {
                predecessor_owner_token,
            },
            armed: true,
        }
    }

    fn disarm(mut self) {
        self.armed = false;
    }

    fn matches(&self, handle: &str, capability: &str, owner_token: &str) -> bool {
        self.reservation.reservation_handle == handle
            && self.reservation.capability == capability
            && self.reservation.owner_token == owner_token
    }

    fn rollback(mut self) -> Result<(), KeyringError> {
        let result = match &self.mode {
            ReservationGuardMode::Active => self
                .cleanup
                .cleanup(
                    &self.reservation.reservation_handle,
                    &self.reservation.capability,
                    &self.reservation.owner_token,
                )
                .map(|_| ()),
            ReservationGuardMode::Pending {
                predecessor_owner_token,
            } => self.cleanup.abort_adopt(
                &self.reservation.reservation_handle,
                &self.reservation.capability,
                predecessor_owner_token,
                &self.reservation.owner_token,
            ),
        };
        if result.is_ok() {
            self.armed = false;
        }
        result
    }
}

impl Drop for PreparedResponseRollback {
    fn drop(&mut self) {
        if self.armed {
            let _ = match &self.mode {
                ReservationGuardMode::Active => self
                    .cleanup
                    .cleanup(
                        &self.reservation.reservation_handle,
                        &self.reservation.capability,
                        &self.reservation.owner_token,
                    )
                    .map(|_| ()),
                ReservationGuardMode::Pending {
                    predecessor_owner_token,
                } => self.cleanup.abort_adopt(
                    &self.reservation.reservation_handle,
                    &self.reservation.capability,
                    predecessor_owner_token,
                    &self.reservation.owner_token,
                ),
            };
        }
    }
}

fn write_rpc_response_transaction<W: Write>(
    stdout: &Arc<Mutex<W>>,
    response: &Value,
    rollback: Option<PreparedResponseRollback>,
) -> io::Result<Option<PreparedResponseRollback>> {
    match write_rpc_response(stdout, response) {
        Ok(()) => Ok(rollback),
        Err(write_error) => {
            if let Some(rollback) = rollback {
                rollback.rollback().map_err(|_| {
                    io::Error::other("native cleanup reservation output rollback failed")
                })?;
            }
            Err(write_error)
        }
    }
}

#[cfg(test)]
fn write_prepared_response_for_test<W: Write>(
    stdout: &Arc<Mutex<W>>,
    response: Value,
    cleanup: Arc<dyn ConformanceCredentialCleanup>,
    reservation: ConformanceCleanupReservation,
) -> io::Result<()> {
    write_rpc_response_transaction(
        stdout,
        &response,
        Some(PreparedResponseRollback::new(cleanup, reservation)),
    )
    .map(|_| ())
}

fn write_rpc_response<W: Write>(stdout: &Arc<Mutex<W>>, response: &Value) -> io::Result<()> {
    let mut stdout = stdout
        .lock()
        .map_err(|_| io::Error::other("RPC stdout lock was poisoned"))?;
    serde_json::to_writer(&mut *stdout, response)?;
    stdout.write_all(b"\n")?;
    stdout.flush()
}

fn join_rpc_workers(workers: &mut Vec<std::thread::JoinHandle<io::Result<()>>>) -> io::Result<()> {
    for worker in workers.drain(..) {
        worker
            .join()
            .map_err(|_| io::Error::other("RPC worker panicked"))??;
    }
    Ok(())
}

fn reap_rpc_workers(workers: &mut Vec<std::thread::JoinHandle<io::Result<()>>>) -> io::Result<()> {
    let mut index = 0;
    while index < workers.len() {
        if workers[index].is_finished() {
            let worker = workers.swap_remove(index);
            worker
                .join()
                .map_err(|_| io::Error::other("RPC worker panicked"))??;
        } else {
            index += 1;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        env,
        sync::{Arc, Mutex, OnceLock},
    };

    use super::{
        parse_command, parse_request_line, read_bounded_line, validate_windows_job_binding_values,
        BoundedLine, ConformanceCaveLauncher, ConformanceCredentialCleanup, RpcCommand, RpcRuntime,
        SharedMemoryCredentialCustody, CONFORMANCE_INSTALLATION_ID,
        CONFORMANCE_NATIVE_PROVIDER_PRESET_ENV, CONFORMANCE_NODE_PATH_ENV, INVALID_REQUEST_ID,
        MAX_LINE_BYTES,
    };
    use crate::{
        cave::CaveLauncher,
        keyring::{
            ConformanceCleanupOutcome, ConformanceCleanupReservation, Credential,
            CredentialCustody, CredentialSlot, KeyringError,
        },
    };
    use serde_json::json;

    const INSTANCE_ID: &str = "instance-1";
    const FIRST_ORIGIN: &str = "http://127.0.0.1:4310/";
    const SECOND_ORIGIN: &str = "http://127.0.0.1:4320/";
    const FIRST_OPERATION_ATTEMPT: &str = "op1-1787900000000-1-00000000000000000000000000000000";
    const SECOND_OPERATION_ATTEMPT: &str = "op1-1787900000000-2-11111111111111111111111111111111";
    const OWNER_TOKEN: &str = "00000000-0000-4000-8000-000000000004";
    static ENVIRONMENT_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

    #[test]
    fn windows_job_binding_requires_the_exact_nonce_bound_job_name() {
        let nonce = "0123456789abcdef0123456789abcdef";
        let name = format!(r"Local\OpenCoven.Chat.Conformance.{nonce}");

        assert!(validate_windows_job_binding_values("1", nonce, &name).is_ok());
        assert!(validate_windows_job_binding_values("0", nonce, &name).is_err());
        assert!(validate_windows_job_binding_values("1", "short", &name).is_err());
        assert!(validate_windows_job_binding_values(
            "1",
            nonce,
            r"Local\OpenCoven.Chat.Conformance.other"
        )
        .is_err());
    }

    struct RecordingEmergencyCleanup {
        cleanup_inputs: Mutex<Vec<(String, String)>>,
        present: Mutex<bool>,
        expected_handle: String,
        expected_capability: String,
        expected_owner_token: String,
    }

    impl ConformanceCredentialCleanup for RecordingEmergencyCleanup {
        fn state(
            &self,
            _instance_ids: &[String],
        ) -> Result<(&'static str, bool, String), KeyringError> {
            Err(KeyringError::Failure)
        }

        fn issue_cleanup_grant(&self, _instance_ids: &[String]) -> Result<String, KeyringError> {
            Err(KeyringError::Failure)
        }

        fn cleanup_state(
            &self,
            _grant: &str,
        ) -> Result<(&'static str, bool, String), KeyringError> {
            Err(KeyringError::Failure)
        }

        fn prepare(
            &self,
            _instance_id: &str,
        ) -> Result<ConformanceCleanupReservation, KeyringError> {
            Err(KeyringError::Failure)
        }

        fn begin_adopt(
            &self,
            _handle: &str,
            _capability: &str,
            _owner_token: &str,
            _successor_owner_token: &str,
        ) -> Result<ConformanceCleanupReservation, KeyringError> {
            Err(KeyringError::Failure)
        }

        fn commit_adopt(
            &self,
            _handle: &str,
            _capability: &str,
            _owner_token: &str,
            _successor_owner_token: &str,
        ) -> Result<(), KeyringError> {
            Err(KeyringError::Failure)
        }

        fn abort_adopt(
            &self,
            _handle: &str,
            _capability: &str,
            _owner_token: &str,
            _successor_owner_token: &str,
        ) -> Result<(), KeyringError> {
            Ok(())
        }

        fn cancel_prepared(&self) -> Result<(), KeyringError> {
            *self.present.lock().unwrap() = false;
            Ok(())
        }

        fn cleanup(
            &self,
            handle: &str,
            capability: &str,
            owner_token: &str,
        ) -> Result<ConformanceCleanupOutcome, KeyringError> {
            self.cleanup_inputs
                .lock()
                .unwrap()
                .push((handle.to_owned(), capability.to_owned()));
            let mut present = self.present.lock().unwrap();
            if !*present
                || handle != self.expected_handle
                || capability != self.expected_capability
                || owner_token != self.expected_owner_token
            {
                return Err(KeyringError::Failure);
            }
            *present = false;
            Ok(ConformanceCleanupOutcome::Deleted)
        }
    }

    struct BrokenPipeWriter;

    impl std::io::Write for BrokenPipeWriter {
        fn write(&mut self, _buffer: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "closed output",
            ))
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "closed output",
            ))
        }
    }

    #[test]
    fn parses_the_bounded_coven_health_rpc_command() {
        let command = parse_command(
            "coven_health",
            Some(json!({
                "operation": {
                    "attemptId": FIRST_OPERATION_ATTEMPT,
                    "timeoutMs": 100
                }
            })),
        )
        .expect("coven health should be registered");

        assert!(matches!(command, RpcCommand::CovenHealth { .. }));
    }

    #[test]
    fn parses_only_bounded_native_custody_proof_commands() {
        const INSTANCE_ID: &str = "00000000-0000-4000-8000-000000000001";
        let state = parse_command(
            "conformance_native_custody_state",
            Some(json!({"instanceIds": [INSTANCE_ID]})),
        )
        .expect("native custody state should be registered");
        let issue = parse_command(
            "conformance_issue_native_custody_cleanup",
            Some(json!({"instanceIds": [INSTANCE_ID, INSTANCE_ID]})),
        )
        .expect("native custody cleanup issuance should be registered");
        let cleanup = parse_command(
            "conformance_cleanup_native_custody",
            Some(json!({"grant": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"})),
        )
        .expect("native custody cleanup should be registered");

        assert!(matches!(
            state,
            RpcCommand::ConformanceNativeCustodyState { .. }
        ));
        assert!(matches!(
            issue,
            RpcCommand::ConformanceIssueNativeCustodyCleanup { .. }
        ));
        assert!(matches!(
            cleanup,
            RpcCommand::ConformanceCleanupNativeCustody { .. }
        ));
        assert!(parse_command(
            "conformance_native_custody_state",
            Some(json!({"instanceIds": [
                INSTANCE_ID,
                INSTANCE_ID,
                INSTANCE_ID,
                INSTANCE_ID,
                INSTANCE_ID,
                INSTANCE_ID,
                INSTANCE_ID,
                INSTANCE_ID,
                INSTANCE_ID,
            ]})),
        )
        .is_err());
        assert!(parse_command(
            "conformance_cleanup_native_custody",
            Some(json!({
                "grant": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "instanceIds": [INSTANCE_ID],
            })),
        )
        .is_err());
        assert!(parse_command(
            "conformance_cleanup_native_custody",
            Some(json!({
                "grant": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
                "service": "ai.opencoven.chat.phase1.0123456789abcdef0123456789abcdef",
            })),
        )
        .is_err());
    }

    #[test]
    fn emergency_native_credential_cleanup_is_exact_and_production_gated() {
        const HANDLE: &str = "00000000-0000-4000-8000-000000000001";
        const CAPABILITY: &str = "00000000-0000-4000-8000-000000000002";
        let cleanup = Arc::new(RecordingEmergencyCleanup {
            cleanup_inputs: Mutex::new(Vec::new()),
            present: Mutex::new(true),
            expected_handle: HANDLE.to_owned(),
            expected_capability: CAPABILITY.to_owned(),
            expected_owner_token: OWNER_TOKEN.to_owned(),
        });
        let crashed_runtime = RpcRuntime::with_custody(
            Arc::new(SharedMemoryCredentialCustody::new()),
            Some(cleanup.clone()),
        );
        drop(crashed_runtime);
        let mut runtime = RpcRuntime::with_custody(
            Arc::new(SharedMemoryCredentialCustody::new()),
            Some(cleanup.clone()),
        );

        let forged = runtime.process_line(
            format!(
                r#"{{"id":"forged","command":"conformance_delete_native_credential","args":{{"reservationHandle":"{HANDLE}","capability":"00000000-0000-4000-8000-000000000003","ownerToken":"{OWNER_TOKEN}"}}}}"#
            )
            .as_bytes(),
        );
        assert_eq!(forged["error"]["code"], "keychain_failure");

        let response = runtime.process_line(
            format!(
                r#"{{"id":"cleanup","command":"conformance_delete_native_credential","args":{{"reservationHandle":"{HANDLE}","capability":"{CAPABILITY}","ownerToken":"{OWNER_TOKEN}"}}}}"#
            )
            .as_bytes(),
        );
        assert_eq!(
            response,
            json!({"id":"cleanup","ok":true,"result":{"status":"missing"}})
        );
        assert_eq!(
            cleanup.cleanup_inputs.lock().unwrap().last(),
            Some(&(HANDLE.to_owned(), CAPABILITY.to_owned()))
        );
        assert!(!*cleanup.present.lock().unwrap());
        let replay = runtime.process_line(
            format!(
                r#"{{"id":"replay","command":"conformance_delete_native_credential","args":{{"reservationHandle":"{HANDLE}","capability":"{CAPABILITY}","ownerToken":"{OWNER_TOKEN}"}}}}"#
            )
            .as_bytes(),
        );
        assert_eq!(replay["error"]["code"], "keychain_failure");

        let mut unprivileged = RpcRuntime::new();
        let rejected = unprivileged.process_line(
            format!(
                r#"{{"id":"cleanup","command":"conformance_delete_native_credential","args":{{"reservationHandle":"{HANDLE}","capability":"{CAPABILITY}","ownerToken":"{OWNER_TOKEN}"}}}}"#
            )
            .as_bytes(),
        );
        assert_eq!(
            rejected,
            json!({
                "id":"cleanup",
                "ok":false,
                "error":{"code":"invalid_native_input","retryable":false}
            })
        );
        let invalid = runtime.process_line(
            br#"{"id":"cleanup-invalid","command":"conformance_delete_native_credential","args":{"reservationHandle":"not-a-uuid","capability":"also-invalid","ownerToken":"invalid"}}"#,
        );
        assert_eq!(invalid["error"]["code"], "invalid_native_input");
    }

    #[test]
    fn prepared_native_cleanup_can_be_canceled_without_response_capability() {
        let cleanup = Arc::new(RecordingEmergencyCleanup {
            cleanup_inputs: Mutex::new(Vec::new()),
            present: Mutex::new(true),
            expected_handle: "00000000-0000-4000-8000-000000000001".to_owned(),
            expected_capability: "00000000-0000-4000-8000-000000000002".to_owned(),
            expected_owner_token: OWNER_TOKEN.to_owned(),
        });
        let mut runtime = RpcRuntime::with_custody(
            Arc::new(SharedMemoryCredentialCustody::new()),
            Some(cleanup.clone()),
        );

        let response = runtime.process_line(
            br#"{"id":"cancel","command":"conformance_cancel_prepared_native_cleanup"}"#,
        );
        assert_eq!(
            response,
            json!({"id":"cancel","ok":true,"result":{"status":"missing"}})
        );
        assert!(!*cleanup.present.lock().unwrap());

        let mut unprivileged = RpcRuntime::new();
        let rejected = unprivileged.process_line(
            br#"{"id":"cancel","command":"conformance_cancel_prepared_native_cleanup"}"#,
        );
        assert_eq!(rejected["error"]["code"], "invalid_native_input");
    }

    #[test]
    fn native_rpc_broken_output_rolls_back_unacknowledged_reservation() {
        const HANDLE: &str = "00000000-0000-4000-8000-000000000001";
        const CAPABILITY: &str = "00000000-0000-4000-8000-000000000002";
        let cleanup = Arc::new(RecordingEmergencyCleanup {
            cleanup_inputs: Mutex::new(Vec::new()),
            present: Mutex::new(true),
            expected_handle: HANDLE.to_owned(),
            expected_capability: CAPABILITY.to_owned(),
            expected_owner_token: OWNER_TOKEN.to_owned(),
        });
        let output = Arc::new(Mutex::new(BrokenPipeWriter));
        let error = super::write_prepared_response_for_test(
            &output,
            json!({
                "id":"prepare",
                "ok":true,
                "result":{"reservationHandle":HANDLE,"capability":CAPABILITY,"ownerToken":OWNER_TOKEN}
            }),
            cleanup.clone(),
            ConformanceCleanupReservation {
                reservation_handle: HANDLE.to_owned(),
                capability: CAPABILITY.to_owned(),
                owner_token: OWNER_TOKEN.to_owned(),
            },
        )
        .expect_err("closed native RPC output must fail");

        assert_eq!(error.kind(), std::io::ErrorKind::BrokenPipe);
        assert!(!*cleanup.present.lock().unwrap());
        assert!(cleanup.cleanup(HANDLE, CAPABILITY, OWNER_TOKEN).is_err());
        assert_eq!(cleanup.cleanup_inputs.lock().unwrap().len(), 2);
    }

    #[test]
    fn native_rpc_runtime_drop_cleans_an_acknowledged_reservation() {
        const HANDLE: &str = "00000000-0000-4000-8000-000000000001";
        const CAPABILITY: &str = "00000000-0000-4000-8000-000000000002";
        let cleanup = Arc::new(RecordingEmergencyCleanup {
            cleanup_inputs: Mutex::new(Vec::new()),
            present: Mutex::new(true),
            expected_handle: HANDLE.to_owned(),
            expected_capability: CAPABILITY.to_owned(),
            expected_owner_token: OWNER_TOKEN.to_owned(),
        });
        let output = Arc::new(Mutex::new(Vec::<u8>::new()));
        let delivered = super::write_rpc_response_transaction(
            &output,
            &json!({"id":"prepare","ok":true,"result":{}}),
            Some(super::PreparedResponseRollback::new(
                cleanup.clone(),
                ConformanceCleanupReservation {
                    reservation_handle: HANDLE.to_owned(),
                    capability: CAPABILITY.to_owned(),
                    owner_token: OWNER_TOKEN.to_owned(),
                },
            )),
        )
        .expect("reservation response must be acknowledged");
        let mut runtime = RpcRuntime::with_custody(
            Arc::new(SharedMemoryCredentialCustody::new()),
            Some(cleanup.clone()),
        );
        runtime.arm_delivered_reservation(delivered);
        drop(runtime);

        assert!(!*cleanup.present.lock().unwrap());
        assert_eq!(cleanup.cleanup_inputs.lock().unwrap().len(), 1);
    }

    #[test]
    fn dispatches_coven_health_through_the_bounded_rpc_operation() {
        let _environment = ENVIRONMENT_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let original = env::var_os("COVEN_HOME");
        env::set_var(
            "COVEN_HOME",
            env::current_dir().unwrap().join("missing-coven-health"),
        );
        let mut runtime = RpcRuntime::new();

        let response = runtime.process_line(
            format!(
                r#"{{"id":"coven","command":"coven_health","args":{{"operation":{{"attemptId":"{FIRST_OPERATION_ATTEMPT}","timeoutMs":100}}}}}}"#
            )
            .as_bytes(),
        );

        assert_eq!(
            response,
            json!({
                "id": "coven",
                "ok": false,
                "error": {
                    "code": "service_unavailable",
                    "retryable": true
                }
            })
        );
        match original {
            Some(value) => env::set_var("COVEN_HOME", value),
            None => env::remove_var("COVEN_HOME"),
        }
    }

    #[test]
    fn accepts_the_production_keyring_conformance_preset() {
        let _environment = ENVIRONMENT_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let original = env::var_os(CONFORMANCE_NATIVE_PROVIDER_PRESET_ENV);
        env::set_var(CONFORMANCE_NATIVE_PROVIDER_PRESET_ENV, "production-keyring");

        assert!(RpcRuntime::from_environment().is_ok());

        match original {
            Some(value) => env::set_var(CONFORMANCE_NATIVE_PROVIDER_PRESET_ENV, value),
            None => env::remove_var(CONFORMANCE_NATIVE_PROVIDER_PRESET_ENV),
        }
    }

    struct ScopedCaveHome(Option<std::ffi::OsString>);

    impl ScopedCaveHome {
        fn missing() -> Self {
            let original = env::var_os("COVEN_CAVE_HOME");
            env::set_var(
                "COVEN_CAVE_HOME",
                env::current_dir().unwrap().join("no-cave"),
            );
            Self(original)
        }
    }

    impl Drop for ScopedCaveHome {
        fn drop(&mut self) {
            match self.0.take() {
                Some(value) => env::set_var("COVEN_CAVE_HOME", value),
                None => env::remove_var("COVEN_CAVE_HOME"),
            }
        }
    }

    fn credential(origin: &str, bearer: &str, credential_id: &str) -> Credential {
        Credential {
            bearer: bearer.to_owned(),
            credential_id: credential_id.to_owned(),
            origin: origin.to_owned(),
        }
    }

    #[test]
    fn rejects_unknown_top_level_keys_and_malformed_lines_without_echoing_them() {
        let canary = "native-rpc-input-canary";
        let unknown_key =
            format!(r#"{{"id":"request-1","command":"app_installation_id","leak":"{canary}"}}"#);
        let malformed = format!(r#"{{"id":"request-1","command":"{canary}""#);

        for line in [unknown_key.as_bytes(), malformed.as_bytes()] {
            let response = match parse_request_line(line) {
                Ok(_) => panic!("malformed request must fail"),
                Err(response) => response,
            };

            assert_eq!(response["ok"], false);
            assert_eq!(response["error"]["code"], "invalid_request");
            assert!(!response.to_string().contains(canary));
        }
    }

    #[test]
    fn rejects_oversized_lines_and_unsafe_request_ids() {
        let oversized = vec![b'x'; MAX_LINE_BYTES + 1];
        let oversized_response = match parse_request_line(&oversized) {
            Ok(_) => panic!("oversized request must fail"),
            Err(response) => response,
        };
        let unsafe_response =
            match parse_request_line(br#"{"id":"unsafe id","command":"app_installation_id"}"#) {
                Ok(_) => panic!("unsafe request id must fail"),
                Err(response) => response,
            };

        assert_eq!(oversized_response["id"], INVALID_REQUEST_ID);
        assert_eq!(unsafe_response["id"], INVALID_REQUEST_ID);
        assert_eq!(oversized_response["error"]["code"], "invalid_request");
    }

    #[test]
    fn bounded_reader_drains_oversized_lines_before_reading_the_next_request() {
        let mut input = vec![b'x'; MAX_LINE_BYTES + 1];
        input.extend_from_slice(b"\n{\"id\":\"next\",\"command\":\"app_installation_id\"}\n");
        let mut reader = std::io::Cursor::new(input);

        assert!(matches!(
            read_bounded_line(&mut reader).unwrap(),
            Some(BoundedLine::Oversized)
        ));
        match read_bounded_line(&mut reader).unwrap() {
            Some(BoundedLine::Line(line)) => {
                assert_eq!(line, br#"{"id":"next","command":"app_installation_id"}"#);
            }
            _ => panic!("the next bounded request must remain readable"),
        }
        assert!(read_bounded_line(&mut reader).unwrap().is_none());
    }

    #[test]
    fn rejects_unknown_commands_and_malformed_exact_args() {
        let _environment = ENVIRONMENT_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _cave_home = ScopedCaveHome::missing();
        let mut runtime = RpcRuntime::new();
        let unknown = runtime.process_line(br#"{"id":"one","command":"not-a-command"}"#);
        let extra = runtime.process_line(
            br#"{"id":"two","command":"cave_health","args":{"handle":"x","extra":true}}"#,
        );
        let missing = runtime.process_line(
            br#"{"id":"three","command":"cave_list_familiars","args":{"handle":"x"}}"#,
        );
        let zero_limit = runtime.process_line(
            br#"{"id":"four","command":"cave_list_familiars","args":{"handle":"x","page":{"limit":0}}}"#,
        );
        let noncanonical_cursor = runtime.process_line(
            br#"{"id":"five","command":"cave_list_projects","args":{"handle":"x","page":{"limit":20,"cursor":"A"}}}"#,
        );
        let unsafe_conversation = runtime.process_line(
            br#"{"id":"six","command":"cave_get_conversation","args":{"handle":"x","conversationId":".."}}"#,
        );
        let widened_pairing = runtime.process_line(
            br#"{"id":"seven","command":"cave_pairing_create","args":{"handle":"x","request":{"appName":"OpenCoven Chat","installationId":"00000000-0000-4000-8000-000000000001","scopes":["chat:write"],"headers":{"authorization":"forbidden"}}}}"#,
        );
        let unsafe_pairing_id = runtime.process_line(
            br#"{"id":"eight","command":"cave_pairing_poll","args":{"handle":"x","requestId":"../request"}}"#,
        );
        let bounded_operation = runtime.process_line(
            br#"{"id":"nine","command":"cave_health","args":{"handle":"x","operation":{"attemptId":"op1-1787900000000-1-00000000000000000000000000000000","timeoutMs":25}}}"#,
        );
        let cancellation = runtime.process_line(
            br#"{"id":"ten","command":"cave_cancel_operation","args":{"attemptId":"op1-1787900000000-2-11111111111111111111111111111111","reason":"aborted"}}"#,
        );
        let oversized_timeout = runtime.process_line(
            br#"{"id":"eleven","command":"cave_health","args":{"handle":"x","operation":{"attemptId":"op1-1787900000000-3-22222222222222222222222222222222","timeoutMs":5001}}}"#,
        );
        let malformed_cancel = runtime.process_line(
            br#"{"id":"twelve","command":"cave_cancel_operation","args":{"attemptId":"not-an-attempt","reason":"secret-cause"}}"#,
        );

        assert_eq!(unknown["error"]["code"], "invalid_rpc_command");
        assert_eq!(extra["error"]["code"], "invalid_native_input");
        assert_eq!(missing["error"]["code"], "invalid_native_input");
        assert_eq!(zero_limit["error"]["code"], "invalid_native_input");
        assert_eq!(noncanonical_cursor["error"]["code"], "invalid_native_input");
        assert_eq!(unsafe_conversation["error"]["code"], "invalid_native_input");
        assert_eq!(widened_pairing["error"]["code"], "invalid_native_input");
        assert_eq!(unsafe_pairing_id["error"]["code"], "invalid_native_input");
        assert_eq!(
            bounded_operation["error"]["code"],
            "cave_discovery_not_found"
        );
        assert_eq!(
            cancellation,
            json!({
                "id": "ten",
                "ok": true,
                "result": { "status": "queued" },
            })
        );
        assert_eq!(oversized_timeout["error"]["code"], "invalid_native_input");
        assert_eq!(malformed_cancel["error"]["code"], "invalid_native_input");
        assert!(!malformed_cancel.to_string().contains("secret-cause"));
    }

    #[test]
    fn rpc_cancellation_is_single_use_and_cannot_affect_a_new_attempt() {
        let _environment = ENVIRONMENT_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let _cave_home = ScopedCaveHome::missing();
        let mut runtime = RpcRuntime::new();
        let cancelled_attempt = FIRST_OPERATION_ATTEMPT;
        let fresh_attempt = SECOND_OPERATION_ATTEMPT;

        assert_eq!(
            runtime.process_line(
                format!(
                    r#"{{"id":"cancel","command":"cave_cancel_operation","args":{{"attemptId":"{cancelled_attempt}","reason":"aborted"}}}}"#
                )
                .as_bytes(),
            ),
            json!({
                "id": "cancel",
                "ok": true,
                "result": { "status": "queued" },
            })
        );
        assert_eq!(
            runtime.process_line(
                format!(
                    r#"{{"id":"aborted","command":"cave_health","args":{{"handle":"x","operation":{{"attemptId":"{cancelled_attempt}","timeoutMs":100}}}}}}"#
                )
                .as_bytes(),
            ),
            json!({
                "id": "aborted",
                "ok": false,
                "error": { "code": "aborted", "retryable": false },
            })
        );
        assert_eq!(
            runtime.process_line(
                format!(
                    r#"{{"id":"stale","command":"cave_cancel_operation","args":{{"attemptId":"{cancelled_attempt}","reason":"timeout"}}}}"#
                )
                .as_bytes(),
            ),
            json!({
                "id": "stale",
                "ok": true,
                "result": { "status": "unknown" },
            })
        );
        assert_eq!(
            runtime.process_line(
                format!(
                    r#"{{"id":"fresh","command":"cave_health","args":{{"handle":"x","operation":{{"attemptId":"{fresh_attempt}","timeoutMs":100}}}}}}"#
                )
                .as_bytes(),
            )["error"]["code"],
            "cave_discovery_not_found"
        );
    }

    #[test]
    fn emits_only_the_safe_response_shapes() {
        let canary = "bearer-canary-must-not-escape";
        let success = super::success_response("request-1".to_owned(), json!({"status": "ok"}));
        let failure = super::failure_response("request-2", "cave_discovery_not_found", true);

        assert_eq!(
            success,
            json!({"id":"request-1","ok":true,"result":{"status":"ok"}})
        );
        assert_eq!(
            failure,
            json!({
                "id":"request-2",
                "ok":false,
                "error":{"code":"cave_discovery_not_found","retryable":true}
            })
        );
        assert!(!failure.to_string().contains(canary));
        assert!(!failure["error"]
            .as_object()
            .unwrap()
            .contains_key("message"));
        assert!(!failure["error"].as_object().unwrap().contains_key("cause"));
    }

    #[test]
    fn shared_custody_uses_fixed_id_and_matches_current_stale_and_cas_semantics() {
        let custody = SharedMemoryCredentialCustody::new();
        let first = credential(FIRST_ORIGIN, "bearer-first-canary", "credential-1");
        let replacement = credential(SECOND_ORIGIN, "bearer-second-canary", "credential-2");

        assert_eq!(
            custody.installation_id().unwrap(),
            CONFORMANCE_INSTALLATION_ID
        );
        assert!(custody
            .store_if_current(
                INSTANCE_ID,
                FIRST_ORIGIN,
                None,
                &first.bearer,
                &first.credential_id,
            )
            .unwrap());
        assert!(matches!(
            custody
                .read_for_pairing_update(INSTANCE_ID, FIRST_ORIGIN)
                .unwrap(),
            CredentialSlot::Current(current) if current.is_same_identity(&first)
        ));
        assert!(matches!(
            custody
                .read_for_pairing_update(INSTANCE_ID, SECOND_ORIGIN)
                .unwrap(),
            CredentialSlot::Stale(current) if current.is_same_identity(&first)
        ));
        assert!(!custody
            .store_if_current(
                INSTANCE_ID,
                FIRST_ORIGIN,
                Some(&replacement),
                "bearer-third",
                "credential-3",
            )
            .unwrap());
        assert!(custody
            .replace_stale_if_current(
                INSTANCE_ID,
                SECOND_ORIGIN,
                &first,
                &replacement.bearer,
                &replacement.credential_id,
            )
            .unwrap());
        assert_eq!(
            custody
                .read(INSTANCE_ID, SECOND_ORIGIN)
                .unwrap()
                .credential_id,
            replacement.credential_id
        );
        assert!(!custody
            .delete_if_matches(INSTANCE_ID, SECOND_ORIGIN, &first)
            .unwrap());
        assert!(custody
            .delete_if_matches(INSTANCE_ID, SECOND_ORIGIN, &replacement)
            .unwrap());
        assert!(matches!(
            custody.read(INSTANCE_ID, SECOND_ORIGIN),
            Err(KeyringError::NotFound)
        ));

        let source = include_str!("conformance.rs");
        assert!(!source.contains(&["derive(", "Debug"].concat()));
        assert!(!source.contains(&["derive(", "Serialize"].concat()));
    }

    #[test]
    fn shared_custody_reports_failure_after_a_poisoned_lock() {
        let custody = SharedMemoryCredentialCustody::new();
        let poisoned = custody.clone();
        let _ = std::thread::spawn(move || {
            let _guard = poisoned.store.lock().unwrap();
            panic!("poison the conformance-only custody lock");
        })
        .join();

        assert!(matches!(
            custody.read_for_pairing_update(INSTANCE_ID, FIRST_ORIGIN),
            Err(KeyringError::Failure)
        ));
    }

    #[test]
    fn launcher_requires_absolute_regular_node_configuration() {
        let _environment = ENVIRONMENT_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let original = env::var_os(CONFORMANCE_NODE_PATH_ENV);
        env::set_var(CONFORMANCE_NODE_PATH_ENV, "relative-node");

        let error = match ConformanceCaveLauncher.launch() {
            Ok(_) => panic!("relative node configuration must fail"),
            Err(error) => error,
        };

        assert_eq!(error.code, "cave_launch_configuration_invalid");
        match original {
            Some(value) => env::set_var(CONFORMANCE_NODE_PATH_ENV, value),
            None => env::remove_var(CONFORMANCE_NODE_PATH_ENV),
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_job_close_terminates_cave_descendants_without_touching_unrelated_processes() {
        use std::{
            fs,
            path::PathBuf,
            process::Command,
            thread,
            time::{Duration, Instant},
        };
        use windows_sys::Win32::{
            Foundation::{CloseHandle, WAIT_OBJECT_0},
            System::Threading::{OpenProcess, WaitForSingleObject},
        };

        fn exited(pid: u32) -> bool {
            const SYNCHRONIZE_ACCESS: u32 = 0x0010_0000;
            let process = unsafe { OpenProcess(SYNCHRONIZE_ACCESS, 0, pid) };
            if process.is_null() {
                return true;
            }
            let result = unsafe { WaitForSingleObject(process, 0) };
            unsafe {
                CloseHandle(process);
            }
            result == WAIT_OBJECT_0
        }

        let _environment = ENVIRONMENT_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let node_output = Command::new("where.exe")
            .arg("node.exe")
            .output()
            .expect("node lookup must run");
        assert!(node_output.status.success(), "node must be available");
        let node = PathBuf::from(
            String::from_utf8(node_output.stdout)
                .unwrap()
                .lines()
                .next()
                .unwrap(),
        );
        let root = env::temp_dir().join(format!("chat-job-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let descendant_path = root.join("descendant.pid");
        let script = root.join("server.cjs");
        fs::write(
            &script,
            format!(
                "const{{spawn}}=require('node:child_process');const{{writeFileSync}}=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{{}},1000)'],{{stdio:'ignore'}});writeFileSync({},String(c.pid));setInterval(()=>{{}},1000);",
                serde_json::to_string(&descendant_path).unwrap()
            ),
        )
        .unwrap();
        let original_node = env::var_os(CONFORMANCE_NODE_PATH_ENV);
        let original_server = env::var_os(super::CONFORMANCE_CAVE_SERVER_PATH_ENV);
        env::set_var(CONFORMANCE_NODE_PATH_ENV, &node);
        env::set_var(super::CONFORMANCE_CAVE_SERVER_PATH_ENV, &script);
        let cave = ConformanceCaveLauncher
            .launch()
            .expect("Cave child must launch");
        let mut unrelated = Command::new(&node)
            .args(["-e", "setInterval(()=>{},1000)"])
            .spawn()
            .expect("unrelated process must launch");
        let deadline = Instant::now() + Duration::from_secs(5);
        while !descendant_path.exists() {
            assert!(
                Instant::now() < deadline,
                "descendant PID must be published"
            );
            thread::sleep(Duration::from_millis(10));
        }
        let descendant_pid = fs::read_to_string(&descendant_path)
            .unwrap()
            .parse::<u32>()
            .unwrap();

        drop(cave);

        while !exited(descendant_pid) {
            assert!(Instant::now() < deadline, "job descendant must terminate");
            thread::sleep(Duration::from_millis(10));
        }
        assert!(unrelated.try_wait().unwrap().is_none());
        unrelated.kill().unwrap();
        unrelated.wait().unwrap();
        match original_node {
            Some(value) => env::set_var(CONFORMANCE_NODE_PATH_ENV, value),
            None => env::remove_var(CONFORMANCE_NODE_PATH_ENV),
        }
        match original_server {
            Some(value) => env::set_var(super::CONFORMANCE_CAVE_SERVER_PATH_ENV, value),
            None => env::remove_var(super::CONFORMANCE_CAVE_SERVER_PATH_ENV),
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn runtime_uses_native_discovery_and_can_reset_without_touching_a_keyring() {
        let _environment = ENVIRONMENT_LOCK
            .get_or_init(|| Mutex::new(()))
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let original = env::var_os("COVEN_CAVE_HOME");
        env::set_var(
            "COVEN_CAVE_HOME",
            env::current_dir().unwrap().join("no-cave"),
        );
        let mut runtime = RpcRuntime::new();

        let before = runtime.process_line(br#"{"id":"one","command":"app_installation_id"}"#);
        let discovery = runtime.process_line(
            br#"{"id":"two","command":"cave_read_discovery","args":{"operation":{"attemptId":"op1-1787900000000-1-00000000000000000000000000000000","timeoutMs":100}}}"#,
        );
        let reset =
            runtime.process_line(br#"{"id":"three","command":"conformance_reset_native_state"}"#);
        let after = runtime.process_line(br#"{"id":"four","command":"app_installation_id"}"#);
        let (shutdown, should_exit) =
            runtime.process_line_with_action(br#"{"id":"five","command":"conformance_shutdown"}"#);

        assert_eq!(before["result"], CONFORMANCE_INSTALLATION_ID);
        assert_eq!(
            discovery["error"],
            json!({"code":"cave_discovery_not_found","retryable":true})
        );
        assert_eq!(reset["result"], json!({"status": "reset"}));
        assert_eq!(after["result"], before["result"]);
        assert_eq!(shutdown["result"], json!({"status": "shutting_down"}));
        assert!(should_exit);

        match original {
            Some(value) => env::set_var("COVEN_CAVE_HOME", value),
            None => env::remove_var("COVEN_CAVE_HOME"),
        }
    }
}
