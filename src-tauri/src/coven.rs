use std::{
    env,
    ffi::{OsStr, OsString},
    io,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread,
    time::{Duration, Instant},
};

use coven_client::{ClientError, DaemonClient, DaemonEndpoint};
use serde::Serialize;

use crate::cave::{NativeDiagnostic, NativeResult};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CovenHealthResult {
    pub status: &'static str,
}

pub(crate) trait CovenHealth: Send + Sync {
    fn health(&self) -> NativeResult<CovenHealthResult>;
}

pub(crate) const COVEN_HEALTH_PROBE_ARGUMENT: &str = "--opencoven-internal-coven-health-probe-v1";
const COVEN_HEALTH_PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const COVEN_HEALTH_PROBE_POLL_INTERVAL: Duration = Duration::from_millis(10);
const COVEN_HEALTH_PROBE_SUCCESS: i32 = 0;
const COVEN_HEALTH_PROBE_FAILURE: i32 = 1;

pub(crate) fn exit_if_internal_coven_health_probe_requested() {
    if !internal_coven_health_probe_requested(env::args_os()) {
        return;
    }

    let status = if DirectCovenHealth::default().health().is_ok() {
        COVEN_HEALTH_PROBE_SUCCESS
    } else {
        COVEN_HEALTH_PROBE_FAILURE
    };
    std::process::exit(status);
}

fn internal_coven_health_probe_requested<I, S>(args: I) -> bool
where
    I: IntoIterator<Item = S>,
    S: AsRef<OsStr>,
{
    let mut args = args.into_iter();
    if args.next().is_none() {
        return false;
    }
    matches!(
        (args.next(), args.next()),
        (Some(argument), None) if argument.as_ref() == OsStr::new(COVEN_HEALTH_PROBE_ARGUMENT)
    )
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ProbeStdio {
    Null,
}

struct CovenProbeLaunchRequest {
    executable: PathBuf,
    arguments: [&'static str; 1],
    stdin: ProbeStdio,
    stdout: ProbeStdio,
    stderr: ProbeStdio,
}

trait CovenProbeChild: Send {
    fn try_wait(&mut self) -> io::Result<Option<bool>>;
    fn terminate(&mut self) -> io::Result<()>;
    fn wait(&mut self) -> io::Result<()>;
}

trait CovenProbeLauncher: Send + Sync {
    fn launch(&self, request: &CovenProbeLaunchRequest) -> io::Result<Box<dyn CovenProbeChild>>;
}

struct NativeCovenProbeLauncher;

struct NativeCovenProbeChild {
    child: Child,
    reaped: bool,
}

impl CovenProbeChild for NativeCovenProbeChild {
    fn try_wait(&mut self) -> io::Result<Option<bool>> {
        if self.reaped {
            return Ok(Some(false));
        }
        self.child.try_wait().map(|status| {
            status.map(|status| {
                self.reaped = true;
                status.success()
            })
        })
    }

    fn terminate(&mut self) -> io::Result<()> {
        if self.reaped {
            return Ok(());
        }
        self.child.kill()
    }

    fn wait(&mut self) -> io::Result<()> {
        if self.reaped {
            return Ok(());
        }
        self.child.wait().map(|_| {
            self.reaped = true;
        })
    }
}

impl Drop for NativeCovenProbeChild {
    fn drop(&mut self) {
        if !self.reaped {
            let _ = self.child.kill();
            let _ = self.child.wait();
            self.reaped = true;
        }
    }
}

impl CovenProbeLauncher for NativeCovenProbeLauncher {
    fn launch(&self, request: &CovenProbeLaunchRequest) -> io::Result<Box<dyn CovenProbeChild>> {
        debug_assert_eq!(request.arguments, [COVEN_HEALTH_PROBE_ARGUMENT]);
        debug_assert_eq!(request.stdin, ProbeStdio::Null);
        debug_assert_eq!(request.stdout, ProbeStdio::Null);
        debug_assert_eq!(request.stderr, ProbeStdio::Null);

        Command::new(&request.executable)
            .args(request.arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map(|child| {
                Box::new(NativeCovenProbeChild {
                    child,
                    reaped: false,
                }) as Box<dyn CovenProbeChild>
            })
    }
}

pub(crate) struct NativeCovenHealth {
    launcher: Arc<dyn CovenProbeLauncher>,
    timeout: Duration,
}

impl Default for NativeCovenHealth {
    fn default() -> Self {
        Self {
            launcher: Arc::new(NativeCovenProbeLauncher),
            timeout: COVEN_HEALTH_PROBE_TIMEOUT,
        }
    }
}

impl NativeCovenHealth {
    #[cfg(test)]
    fn with_launcher(launcher: Arc<dyn CovenProbeLauncher>, timeout: Duration) -> Self {
        Self { launcher, timeout }
    }
}

impl CovenHealth for NativeCovenHealth {
    fn health(&self) -> NativeResult<CovenHealthResult> {
        let request = CovenProbeLaunchRequest {
            executable: std::env::current_exe()
                .map_err(|_| NativeDiagnostic::new("service_unavailable", true))?,
            arguments: [COVEN_HEALTH_PROBE_ARGUMENT],
            stdin: ProbeStdio::Null,
            stdout: ProbeStdio::Null,
            stderr: ProbeStdio::Null,
        };
        let mut child = self
            .launcher
            .launch(&request)
            .map_err(|_| NativeDiagnostic::new("service_unavailable", true))?;
        let deadline = Instant::now() + self.timeout;

        loop {
            match child.try_wait() {
                Ok(Some(true)) => return Ok(CovenHealthResult { status: "ok" }),
                Ok(Some(false)) => {
                    return Err(NativeDiagnostic::new("service_unavailable", true));
                }
                Ok(None) => {}
                Err(_) => {
                    terminate_and_reap(child.as_mut());
                    return Err(NativeDiagnostic::new("service_unavailable", true));
                }
            }

            let now = Instant::now();
            if now >= deadline {
                terminate_and_reap(child.as_mut());
                return Err(NativeDiagnostic::new("service_unavailable", true));
            }
            thread::sleep(
                deadline
                    .saturating_duration_since(now)
                    .min(COVEN_HEALTH_PROBE_POLL_INTERVAL),
            );
        }
    }
}

fn terminate_and_reap(child: &mut dyn CovenProbeChild) {
    let _ = child.terminate();
    let _ = child.wait();
}

#[derive(Default)]
pub(crate) struct NativeCovenHealthExecutor {
    busy: Arc<AtomicBool>,
}

impl NativeCovenHealthExecutor {
    pub(crate) async fn execute(
        self: &Arc<Self>,
        health: Arc<dyn CovenHealth>,
    ) -> NativeResult<CovenHealthResult> {
        if self
            .busy
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_err()
        {
            return Err(NativeDiagnostic::new("service_unavailable", true));
        }

        let executor = Arc::clone(self);
        tokio::task::spawn_blocking(move || {
            struct BusyReset(Arc<AtomicBool>);

            impl Drop for BusyReset {
                fn drop(&mut self) {
                    self.0.store(false, Ordering::SeqCst);
                }
            }

            let _busy = BusyReset(Arc::clone(&executor.busy));
            health.health()
        })
        .await
        .map_err(|_| NativeDiagnostic::new("service_unavailable", true))?
    }
}

type CovenHomeResolver = dyn Fn() -> NativeResult<PathBuf> + Send + Sync;

struct DirectCovenHealth {
    home: Arc<CovenHomeResolver>,
}

impl Default for DirectCovenHealth {
    fn default() -> Self {
        Self {
            home: Arc::new(resolve_coven_home),
        }
    }
}

impl DirectCovenHealth {
    #[cfg(all(test, unix))]
    fn with_home(home: Arc<CovenHomeResolver>) -> Self {
        Self { home }
    }
}

impl CovenHealth for DirectCovenHealth {
    fn health(&self) -> NativeResult<CovenHealthResult> {
        let home = (self.home)()?;
        let endpoint = DaemonEndpoint::discover(home).map_err(map_client_error)?;
        let mut client = DaemonClient::new(endpoint);
        client.health().map_err(map_client_error)?;
        Ok(CovenHealthResult { status: "ok" })
    }
}

fn resolve_coven_home() -> NativeResult<PathBuf> {
    resolve_coven_home_with(env::var_os("COVEN_HOME"), platform_home)
}

fn resolve_coven_home_with(
    explicit: Option<OsString>,
    fallback: impl FnOnce() -> Option<PathBuf>,
) -> NativeResult<PathBuf> {
    if let Some(explicit) = explicit {
        if explicit.is_empty() {
            return Err(NativeDiagnostic::new("service_unavailable", true));
        }
        return Ok(PathBuf::from(explicit));
    }
    fallback()
        .map(|home| home.join(".coven"))
        .ok_or_else(|| NativeDiagnostic::new("service_unavailable", true))
}

#[cfg(unix)]
fn platform_home() -> Option<PathBuf> {
    use std::{ffi::CStr, mem::MaybeUninit, os::unix::ffi::OsStringExt, ptr};

    const INITIAL_BUFFER_BYTES: usize = 16 * 1024;
    const MAX_BUFFER_BYTES: usize = 1024 * 1024;
    let uid = unsafe { libc::geteuid() };
    let mut buffer_bytes = INITIAL_BUFFER_BYTES;
    while buffer_bytes <= MAX_BUFFER_BYTES {
        let mut password = MaybeUninit::<libc::passwd>::uninit();
        let mut result = ptr::null_mut();
        let mut buffer = vec![0_u8; buffer_bytes];
        let status = unsafe {
            libc::getpwuid_r(
                uid,
                password.as_mut_ptr(),
                buffer.as_mut_ptr().cast(),
                buffer.len(),
                &mut result,
            )
        };
        if status == libc::ERANGE {
            buffer_bytes = buffer_bytes.saturating_mul(2);
            continue;
        }
        if status != 0 || result.is_null() {
            return None;
        }
        let password = unsafe { password.assume_init() };
        if password.pw_dir.is_null() {
            return None;
        }
        let bytes = unsafe { CStr::from_ptr(password.pw_dir) }.to_bytes();
        if bytes.is_empty() {
            return None;
        }
        return Some(PathBuf::from(OsString::from_vec(bytes.to_vec())));
    }
    None
}

#[cfg(windows)]
fn platform_home() -> Option<PathBuf> {
    use std::os::windows::ffi::OsStringExt;
    use windows_sys::Win32::{
        System::Com::CoTaskMemFree,
        UI::Shell::{FOLDERID_Profile, SHGetKnownFolderPath, KF_FLAG_DEFAULT},
    };

    let mut raw = std::ptr::null_mut();
    let flags = u32::try_from(KF_FLAG_DEFAULT).ok()?;
    let status =
        unsafe { SHGetKnownFolderPath(&FOLDERID_Profile, flags, std::ptr::null_mut(), &mut raw) };
    if status < 0 {
        if !raw.is_null() {
            unsafe { CoTaskMemFree(raw.cast()) };
        }
        return None;
    }
    if raw.is_null() {
        return None;
    }
    let mut length = 0;
    while unsafe { *raw.add(length) } != 0 {
        length += 1;
    }
    let home = PathBuf::from(OsString::from_wide(unsafe {
        std::slice::from_raw_parts(raw, length)
    }));
    unsafe { CoTaskMemFree(raw.cast()) };
    (!home.as_os_str().is_empty()).then_some(home)
}

#[cfg(not(any(unix, windows)))]
fn platform_home() -> Option<PathBuf> {
    None
}

fn map_status(status: u16) -> NativeDiagnostic {
    match status {
        401 => NativeDiagnostic::new("unauthorized", false),
        403 => NativeDiagnostic::new("scope_denied", false),
        404 => NativeDiagnostic::new("not_found", true),
        409 => NativeDiagnostic::new("conflict", false),
        429 => NativeDiagnostic::new("rate_limited", true),
        500..=599 => NativeDiagnostic::new("service_unavailable", true),
        _ => NativeDiagnostic::new("invalid_response", false),
    }
}

fn map_client_error(error: ClientError) -> NativeDiagnostic {
    match error {
        ClientError::Discovery(_) => NativeDiagnostic::new("reconcile_required", false),
        ClientError::Io { source, .. } if source.kind() == std::io::ErrorKind::TimedOut => {
            NativeDiagnostic::new("timeout", true)
        }
        ClientError::Io { .. } => NativeDiagnostic::new("service_unavailable", true),
        ClientError::ResponseTooLarge { .. } | ClientError::RequestTooLarge { .. } => {
            NativeDiagnostic::new("body_limit", false)
        }
        ClientError::InvalidHttpResponse(_)
        | ClientError::InvalidUtf8(_)
        | ClientError::InvalidJson(_)
        | ClientError::InvalidRouteParameter(_) => NativeDiagnostic::new("invalid_response", false),
        ClientError::ProtocolVersion { .. }
        | ClientError::StructuredErrorsUnavailable
        | ClientError::CapabilityUnavailable { .. } => {
            NativeDiagnostic::new("incompatible_version", false)
        }
        ClientError::HealthNotReady => NativeDiagnostic::new("service_unavailable", true),
        ClientError::DaemonInstanceChanged => NativeDiagnostic::new("reconcile_required", false),
        ClientError::Daemon { status, .. } | ClientError::HttpStatus(status) => map_status(status),
        ClientError::LegacyShutdownUpgradeRequired { .. } | ClientError::UnsupportedPlatform => {
            NativeDiagnostic::new("unsupported_operation", false)
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::VecDeque,
        io,
        path::PathBuf,
        process::{Child, Command, Stdio},
        sync::{Arc, Condvar, Mutex},
        time::{Duration, Instant},
    };

    use coven_client::{ClientError, DaemonError};
    use serde_json::json;

    #[cfg(unix)]
    use super::DirectCovenHealth;
    use super::{
        internal_coven_health_probe_requested, map_client_error, resolve_coven_home_with,
        CovenHealth, CovenHealthResult, CovenProbeChild, CovenProbeLaunchRequest,
        CovenProbeLauncher, NativeCovenHealth, NativeCovenHealthExecutor, ProbeStdio,
        COVEN_HEALTH_PROBE_ARGUMENT,
    };

    struct CompletedChild(bool);

    impl CovenProbeChild for CompletedChild {
        fn try_wait(&mut self) -> io::Result<Option<bool>> {
            Ok(Some(self.0))
        }

        fn terminate(&mut self) -> io::Result<()> {
            Ok(())
        }

        fn wait(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct RecordedLaunch {
        executable: PathBuf,
        arguments: Vec<&'static str>,
        stdin: ProbeStdio,
        stdout: ProbeStdio,
        stderr: ProbeStdio,
    }

    #[derive(Default)]
    struct RecordingLauncher {
        requests: Mutex<Vec<RecordedLaunch>>,
    }

    impl CovenProbeLauncher for RecordingLauncher {
        fn launch(
            &self,
            request: &CovenProbeLaunchRequest,
        ) -> io::Result<Box<dyn CovenProbeChild>> {
            self.requests.lock().unwrap().push(RecordedLaunch {
                executable: request.executable.clone(),
                arguments: request.arguments.to_vec(),
                stdin: request.stdin,
                stdout: request.stdout,
                stderr: request.stderr,
            });
            Ok(Box::new(CompletedChild(true)))
        }
    }

    struct ProcessChild(Child);

    impl CovenProbeChild for ProcessChild {
        fn try_wait(&mut self) -> io::Result<Option<bool>> {
            self.0
                .try_wait()
                .map(|status| status.map(|status| status.success()))
        }

        fn terminate(&mut self) -> io::Result<()> {
            self.0.kill()
        }

        fn wait(&mut self) -> io::Result<()> {
            self.0.wait().map(|_| ())
        }
    }

    struct PanickingProcessLauncher;

    impl CovenProbeLauncher for PanickingProcessLauncher {
        fn launch(
            &self,
            _request: &CovenProbeLaunchRequest,
        ) -> io::Result<Box<dyn CovenProbeChild>> {
            Command::new(std::env::current_exe()?)
                .args([
                    "--exact",
                    "coven::tests::child_probe_panic_is_redacted_and_bounded",
                    "--nocapture",
                ])
                .env("OPENCOVEN_TEST_COVEN_PROBE_PANIC", "1")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .map(|child| Box::new(ProcessChild(child)) as Box<dyn CovenProbeChild>)
        }
    }

    #[derive(Default)]
    struct HangingChildState {
        terminated: bool,
        wait_started: bool,
        allow_reap: bool,
        terminate_calls: usize,
        wait_calls: usize,
    }

    struct HangingChild {
        state: Arc<(Mutex<HangingChildState>, Condvar)>,
    }

    impl CovenProbeChild for HangingChild {
        fn try_wait(&mut self) -> io::Result<Option<bool>> {
            Ok(None)
        }

        fn terminate(&mut self) -> io::Result<()> {
            let mut state = self.state.0.lock().unwrap();
            state.terminated = true;
            state.terminate_calls += 1;
            self.state.1.notify_all();
            Ok(())
        }

        fn wait(&mut self) -> io::Result<()> {
            let mut state = self.state.0.lock().unwrap();
            state.wait_started = true;
            state.wait_calls += 1;
            self.state.1.notify_all();
            while !state.allow_reap {
                state = self.state.1.wait(state).unwrap();
            }
            Ok(())
        }
    }

    struct SequencedLauncher {
        launches: Mutex<VecDeque<Box<dyn CovenProbeChild>>>,
    }

    impl CovenProbeLauncher for SequencedLauncher {
        fn launch(
            &self,
            _request: &CovenProbeLaunchRequest,
        ) -> io::Result<Box<dyn CovenProbeChild>> {
            self.launches
                .lock()
                .unwrap()
                .pop_front()
                .ok_or_else(|| io::Error::other("unexpected Coven probe launch"))
        }
    }

    fn wait_for_child_state(
        state: &Arc<(Mutex<HangingChildState>, Condvar)>,
        predicate: impl Fn(&HangingChildState) -> bool,
    ) {
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut child = state.0.lock().unwrap();
        while !predicate(&child) {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .expect("child state transition timed out");
            let (next, timeout) = state.1.wait_timeout(child, remaining).unwrap();
            assert!(!timeout.timed_out(), "child state transition timed out");
            child = next;
        }
    }

    #[test]
    fn maps_client_failures_to_bounded_diagnostics_without_leaking_details() {
        let canary = "/Users/owner/private/.coven/coven.sock secret-native-cause";
        let errors = [
            (
                ClientError::Discovery(canary.to_owned()),
                ("reconcile_required", false),
            ),
            (
                ClientError::Io {
                    operation: "failed to connect to Coven daemon socket",
                    source: std::io::Error::other(canary),
                },
                ("service_unavailable", true),
            ),
            (
                ClientError::ProtocolVersion {
                    expected: "coven.daemon.v1",
                    actual: canary.to_owned(),
                },
                ("incompatible_version", false),
            ),
            (
                ClientError::Daemon {
                    status: 503,
                    error: DaemonError {
                        code: canary.to_owned(),
                        message: canary.to_owned(),
                        details: json!({ "path": canary }),
                    },
                },
                ("service_unavailable", true),
            ),
            (
                ClientError::UnsupportedPlatform,
                ("unsupported_operation", false),
            ),
        ];

        for (error, expected) in errors {
            let diagnostic = map_client_error(error);
            assert_eq!((diagnostic.code, diagnostic.retryable), expected);
            assert!(!serde_json::to_string(&diagnostic).unwrap().contains(canary));
        }
    }

    #[test]
    fn explicit_home_wins_and_missing_platform_home_fails_closed() {
        let explicit = PathBuf::from("explicit-coven-home");
        assert_eq!(
            resolve_coven_home_with(Some(explicit.clone().into_os_string()), || None).unwrap(),
            explicit
        );
        assert_eq!(
            resolve_coven_home_with(None, || Some(PathBuf::from("platform-home"))).unwrap(),
            PathBuf::from("platform-home").join(".coven")
        );
        assert_eq!(
            resolve_coven_home_with(Some(std::ffi::OsString::new()), || {
                Some(PathBuf::from("platform-home"))
            })
            .unwrap_err()
            .code,
            "service_unavailable"
        );
        assert_eq!(
            resolve_coven_home_with(None, || None).unwrap_err().code,
            "service_unavailable"
        );
    }

    #[test]
    fn internal_probe_mode_requires_the_exact_fixed_argv() {
        assert!(internal_coven_health_probe_requested([
            "trusted-app",
            COVEN_HEALTH_PROBE_ARGUMENT,
        ]));
        assert!(!internal_coven_health_probe_requested(["trusted-app"]));
        assert!(!internal_coven_health_probe_requested([
            "trusted-app",
            COVEN_HEALTH_PROBE_ARGUMENT,
            "extra",
        ]));
        assert!(!internal_coven_health_probe_requested([
            "trusted-app",
            "--other-mode",
        ]));
    }

    #[test]
    fn successful_native_probe_uses_fixed_launch_and_releases_capacity() {
        let launcher = Arc::new(RecordingLauncher::default());
        let health: Arc<dyn CovenHealth> = Arc::new(NativeCovenHealth::with_launcher(
            launcher.clone(),
            Duration::from_millis(100),
        ));
        let executor = Arc::new(NativeCovenHealthExecutor::default());

        for _ in 0..2 {
            let result =
                tauri::async_runtime::block_on(executor.execute(Arc::clone(&health))).unwrap();
            assert_eq!(result, CovenHealthResult { status: "ok" });
            assert_eq!(
                serde_json::to_value(result).unwrap(),
                json!({"status": "ok"})
            );
        }

        let requests = launcher.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        for request in requests.iter() {
            assert_eq!(
                request,
                &RecordedLaunch {
                    executable: std::env::current_exe().unwrap(),
                    arguments: vec![COVEN_HEALTH_PROBE_ARGUMENT],
                    stdin: ProbeStdio::Null,
                    stdout: ProbeStdio::Null,
                    stderr: ProbeStdio::Null,
                }
            );
        }
    }

    #[test]
    fn child_probe_panic_is_redacted_and_bounded() {
        const OUTER_PROCESS: &str = "OPENCOVEN_TEST_COVEN_PROBE_OUTER";
        const PANIC_PROCESS: &str = "OPENCOVEN_TEST_COVEN_PROBE_PANIC";
        const SECRET: &str = "secret child probe panic marker";

        if std::env::var_os(PANIC_PROCESS).is_some() {
            panic!("{SECRET}");
        }
        if std::env::var_os(OUTER_PROCESS).is_none() {
            let output = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "coven::tests::child_probe_panic_is_redacted_and_bounded",
                    "--nocapture",
                ])
                .env(OUTER_PROCESS, "1")
                .output()
                .unwrap();
            assert!(output.status.success());
            assert!(!String::from_utf8_lossy(&output.stdout).contains(SECRET));
            assert!(!String::from_utf8_lossy(&output.stderr).contains(SECRET));
            return;
        }

        let health = NativeCovenHealth::with_launcher(
            Arc::new(PanickingProcessLauncher),
            Duration::from_secs(1),
        );
        let started = Instant::now();
        assert_eq!(
            health.health(),
            Err(super::NativeDiagnostic::new("service_unavailable", true))
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn timeout_terminates_and_reaps_the_spawned_child_before_releasing_capacity() {
        let child_state = Arc::new((Mutex::new(HangingChildState::default()), Condvar::new()));
        let launcher = Arc::new(SequencedLauncher {
            launches: Mutex::new(VecDeque::from([
                Box::new(HangingChild {
                    state: child_state.clone(),
                }) as Box<dyn CovenProbeChild>,
                Box::new(CompletedChild(true)) as Box<dyn CovenProbeChild>,
            ])),
        });
        let health = Arc::new(NativeCovenHealth::with_launcher(
            launcher.clone(),
            Duration::from_millis(10),
        ));
        let executor = Arc::new(NativeCovenHealthExecutor::default());
        let first_executor = executor.clone();
        let first_health: Arc<dyn CovenHealth> = health.clone();
        let first =
            tauri::async_runtime::spawn(async move { first_executor.execute(first_health).await });

        wait_for_child_state(&child_state, |state| state.wait_started);
        assert_eq!(
            tauri::async_runtime::block_on(executor.execute(health.clone())),
            Err(super::NativeDiagnostic::new("service_unavailable", true))
        );
        assert_eq!(launcher.launches.lock().unwrap().len(), 1);

        {
            let mut state = child_state.0.lock().unwrap();
            state.allow_reap = true;
            child_state.1.notify_all();
        }
        assert_eq!(
            tauri::async_runtime::block_on(first).unwrap(),
            Err(super::NativeDiagnostic::new("service_unavailable", true))
        );
        {
            let state = child_state.0.lock().unwrap();
            assert!(state.terminated);
            assert_eq!(state.terminate_calls, 1);
            assert_eq!(state.wait_calls, 1);
        }

        assert_eq!(
            tauri::async_runtime::block_on(executor.execute(health)),
            Ok(CovenHealthResult { status: "ok" })
        );
        assert!(launcher.launches.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn owner_current_connected_socket_health_succeeds() {
        use std::{
            fs,
            io::{Read, Write},
            os::unix::{fs::PermissionsExt, net::UnixListener},
            thread,
        };

        let root = std::env::temp_dir().join(format!(".c{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        let socket = root.join("coven.sock");
        let listener = UnixListener::bind(&socket).unwrap();
        fs::set_permissions(&socket, fs::Permissions::from_mode(0o600)).unwrap();
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            stream.read_to_end(&mut request).unwrap();
            assert!(request.starts_with(b"GET /api/v1/health HTTP/1.1\r\n"));
            let body = br#"{"ok":true,"apiVersion":"coven.daemon.v1","covenVersion":"0.1.0","capabilities":{"sessions":true,"events":true,"eventCursor":"sequence","structuredErrors":true}}"#;
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .unwrap();
            stream.write_all(body).unwrap();
        });

        let resolver_root = root.clone();
        let health = DirectCovenHealth::with_home(Arc::new(move || Ok(resolver_root.clone())));
        assert_eq!(health.health().unwrap(), CovenHealthResult { status: "ok" });
        server.join().unwrap();
        fs::remove_dir_all(&root).unwrap();
    }
}
