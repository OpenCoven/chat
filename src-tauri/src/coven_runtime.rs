use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant},
};

use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{ipc::Channel, AppHandle, Manager, State};

use crate::coven::{CovenHealth, NativeCovenHealth};

#[path = "chat_attachments.rs"]
mod attachments;

const OUTPUT_LIMIT: usize = 4 * 1024 * 1024;
pub(crate) const TRANSCRIPT_LIMIT: usize = OUTPUT_LIMIT + 256 * 1024;
const LEDGER_METADATA_LIMIT: usize = 16 * 1024 * 1024;
const ERROR_LIMIT: usize = 8192;
pub(crate) const RUN_CANCELLED: &str = "Coven run cancelled.";
const READ_TIMEOUT: Duration = Duration::from_secs(20);
const RUN_TIMEOUT: Duration = Duration::from_secs(600);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(25);
const HISTORY_SESSION_LIMIT: usize = 64;
const HISTORY_PAGE_LIMIT: usize = 16;
type Runs = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;

#[derive(Default)]
pub(crate) struct CovenRuntimeState {
    runs: Runs,
    shutting_down: Arc<AtomicBool>,
    exit_ready: Arc<AtomicBool>,
}

impl CovenRuntimeState {
    pub(crate) fn register_run(
        &self,
        id: &str,
    ) -> Result<(Arc<AtomicBool>, RunRegistration), String> {
        validate_id(id)?;
        let mut runs = self
            .runs
            .lock()
            .map_err(|_| "Coven runtime state is unavailable.")?;
        if self.shutting_down.load(Ordering::SeqCst) {
            return Err("Coven is shutting down; new runs are disabled.".into());
        }
        if !runs.is_empty() {
            return Err("A Coven run is already active. Cancel it or wait for completion.".into());
        }
        let cancel = Arc::new(AtomicBool::new(false));
        runs.insert(id.to_owned(), cancel.clone());
        Ok((
            cancel,
            RunRegistration {
                runs: self.runs.clone(),
                id: id.to_owned(),
            },
        ))
    }

    fn begin_shutdown(&self) -> Result<bool, String> {
        let runs = self
            .runs
            .lock()
            .map_err(|_| "Coven runtime state is unavailable.")?;
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return Ok(false);
        }
        for cancel in runs.values() {
            cancel.store(true, Ordering::SeqCst);
        }
        Ok(true)
    }
}

fn wait_for_runs(runs: &Runs, timeout: Duration) -> Result<bool, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if runs
            .lock()
            .map_err(|_| "Coven runtime state is unavailable.")?
            .is_empty()
        {
            return Ok(true);
        }
        if Instant::now() >= deadline {
            return Ok(false);
        }
        thread::sleep(Duration::from_millis(20));
    }
}

pub(crate) fn handle_exit_requested(app: &AppHandle, api: &tauri::ExitRequestApi, code: i32) {
    let state = app.state::<CovenRuntimeState>();
    if state.exit_ready.load(Ordering::SeqCst) {
        return;
    }
    api.prevent_exit();
    match state.begin_shutdown() {
        Ok(false) => return,
        Err(error) => {
            eprintln!("Coven shutdown refused: {error}");
            return;
        }
        Ok(true) => {}
    }
    let runs = state.runs.clone();
    let ready = state.exit_ready.clone();
    let shutting_down = state.shutting_down.clone();
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || match wait_for_runs(&runs, SHUTDOWN_TIMEOUT) {
        Ok(true) => {
            ready.store(true, Ordering::SeqCst);
            app.exit(code);
        }
        Ok(false) => {
            eprintln!("Coven shutdown cleanup exceeded 25 seconds; exit was prevented. Retry closing after cleanup.");
            shutting_down.store(false, Ordering::SeqCst);
        }
        Err(error) => {
            eprintln!("Coven shutdown cleanup failed; exit was prevented: {error}");
            shutting_down.store(false, Ordering::SeqCst);
        }
    });
}

impl Drop for CovenRuntimeState {
    fn drop(&mut self) {
        if let Ok(runs) = self.runs.lock() {
            for cancel in runs.values() {
                cancel.store(true, Ordering::SeqCst);
            }
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SendInput {
    run_id: String,
    prompt: String,
    session_id: Option<String>,
    familiar_id: Option<String>,
    harness: Option<String>,
    #[serde(default)]
    attachments: Vec<attachments::Attachment>,
}

pub(crate) fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id.as_bytes()[0].is_ascii_alphanumeric()
        || !id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    {
        return Err("Invalid Coven identifier.".into());
    }
    Ok(())
}

pub(crate) fn home() -> Result<PathBuf, String> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.parent().is_some())
        .ok_or("Cannot resolve the local user home.")?;
    Ok(home)
}

fn executable(path: &Path) -> bool {
    let Ok(metadata) = path.metadata() else {
        return false;
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o111 != 0
    }
    #[cfg(not(unix))]
    true
}

fn platform_package() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "cli-macos",
        ("macos", "x86_64") => "cli-macos-x64",
        ("linux", "x86_64") => "cli-linux-x64",
        ("windows", "x86_64") => "cli-windows",
        _ => "unsupported",
    }
}

pub(crate) fn resolve_cli() -> Result<PathBuf, String> {
    let name = if cfg!(windows) { "coven.exe" } else { "coven" };
    let mut candidates = Vec::new();
    if let Ok(home) = home() {
        // Prefer the npm package's native executable, not its env-node wrapper:
        // Finder launches need neither a shell PATH nor Node to run Coven.
        candidates.push(home.join(format!(
            ".local/lib/node_modules/@opencoven/cli/node_modules/@opencoven/{}/bin/{name}",
            platform_package()
        )));
        candidates.push(home.join(".local/bin").join(name));
        candidates.push(home.join(".cargo/bin").join(name));
    }
    for prefix in ["/opt/homebrew", "/usr/local", "/usr"] {
        candidates.push(PathBuf::from(prefix).join(format!(
            "lib/node_modules/@opencoven/cli/node_modules/@opencoven/{}/bin/{name}",
            platform_package()
        )));
        candidates.push(PathBuf::from(prefix).join("bin").join(name));
    }
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(
            std::env::split_paths(&path)
                .filter(|path| path.is_absolute())
                .map(|path| path.join(name)),
        );
    }
    candidates
        .into_iter()
        .find(|path| executable(path))
        .ok_or_else(|| "Coven CLI is not installed. Install Coven CLI, then retry.".into())
}

struct OwnedChild(Child, bool);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            if !self.1 {
                // Coven supervises harnesses in their own groups. Let its
                // signal handler reap those before escalating our group.
                unsafe { libc::kill(self.0.id() as i32, libc::SIGTERM) };
                let deadline = Instant::now() + Duration::from_secs(2);
                while Instant::now() < deadline {
                    if matches!(self.0.try_wait(), Ok(Some(_))) {
                        self.1 = true;
                        break;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
            }
            unsafe { libc::kill(-(self.0.id() as i32), libc::SIGKILL) };
        }
        if !self.1 {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }
}

enum PipeData {
    Bytes(bool, Vec<u8>),
    End,
    Error,
}

fn pipe_reader(
    mut pipe: impl Read + Send + 'static,
    stderr: bool,
    sender: mpsc::SyncSender<PipeData>,
) -> std::io::Result<thread::JoinHandle<()>> {
    thread::Builder::new()
        .name("coven-output".into())
        .spawn(move || {
            let mut buffer = [0; 4096];
            loop {
                let message = match pipe.read(&mut buffer) {
                    Ok(0) => PipeData::End,
                    Ok(n) => PipeData::Bytes(stderr, buffer[..n].to_vec()),
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(_) => PipeData::Error,
                };
                let done = matches!(message, PipeData::End | PipeData::Error);
                if sender.send(message).is_err() || done {
                    break;
                }
            }
        })
}

pub(crate) fn run_process(
    args: &[String],
    cwd: Option<&Path>,
    cancel: &AtomicBool,
    timeout: Duration,
    on_event: Option<&mut dyn FnMut(Value) -> Result<(), String>>,
) -> Result<Vec<u8>, String> {
    run_process_input(args, cwd, cancel, timeout, on_event, None)
}

fn run_process_input(
    args: &[String],
    cwd: Option<&Path>,
    cancel: &AtomicBool,
    timeout: Duration,
    on_event: Option<&mut dyn FnMut(Value) -> Result<(), String>>,
    input_file: Option<File>,
) -> Result<Vec<u8>, String> {
    let mut command = Command::new(resolve_cli()?);
    command
        .args(args)
        .stdin(input_file.map_or_else(Stdio::null, Stdio::from))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("NO_COLOR", "1");
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    } else {
        command.current_dir(home()?);
    }
    // Also make harness discovery independent of Finder's minimal PATH.
    let mut path = vec![home()?.join(".local/bin"), home()?.join(".cargo/bin")];
    path.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ]);
    if let Some(inherited) = std::env::var_os("PATH") {
        path.extend(std::env::split_paths(&inherited).filter(|p| p.is_absolute()));
    }
    command.env(
        "PATH",
        std::env::join_paths(path).map_err(|_| "Invalid executable search path.")?,
    );
    let output_limit = if args == ["sessions", "--all", "--json"] {
        LEDGER_METADATA_LIMIT
    } else {
        OUTPUT_LIMIT
    };
    execute_command_bounded(command, cancel, timeout, on_event, output_limit)
}

#[cfg(test)]
fn execute_command(
    command: Command,
    cancel: &AtomicBool,
    timeout: Duration,
    on_event: Option<&mut dyn FnMut(Value) -> Result<(), String>>,
) -> Result<Vec<u8>, String> {
    execute_command_bounded(command, cancel, timeout, on_event, OUTPUT_LIMIT)
}

fn execute_command_bounded(
    mut command: Command,
    cancel: &AtomicBool,
    timeout: Duration,
    mut on_event: Option<&mut dyn FnMut(Value) -> Result<(), String>>,
    output_limit: usize,
) -> Result<Vec<u8>, String> {
    if cancel.load(Ordering::SeqCst) {
        return Err(RUN_CANCELLED.into());
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = OwnedChild(
        command
            .spawn()
            .map_err(|_| "Could not launch installed Coven CLI.")?,
        false,
    );
    let (sender, receiver) = mpsc::sync_channel(16);
    let stdout = child
        .0
        .stdout
        .take()
        .ok_or("Coven stdout is unavailable.")?;
    let stderr = child
        .0
        .stderr
        .take()
        .ok_or("Coven stderr is unavailable.")?;
    let _stdout =
        pipe_reader(stdout, false, sender.clone()).map_err(|_| "Cannot read Coven output.")?;
    let _stderr =
        pipe_reader(stderr, true, sender).map_err(|_| "Cannot read Coven diagnostics.")?;
    let deadline = Instant::now() + timeout;
    let mut output = Vec::new();
    let mut errors = Vec::new();
    let mut pending = Vec::new();
    let mut ended = 0;
    let mut status = None;
    while ended < 2 || status.is_none() {
        if cancel.load(Ordering::SeqCst) {
            return Err(RUN_CANCELLED.into());
        }
        if Instant::now() >= deadline {
            return Err("Coven operation timed out.".into());
        }
        status = child
            .0
            .try_wait()
            .map_err(|_| "Could not inspect Coven process.")?;
        child.1 = status.is_some();
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(PipeData::End) => ended += 1,
            Ok(PipeData::Error) => return Err("Could not read Coven process output.".into()),
            Ok(PipeData::Bytes(is_error, bytes)) => {
                if is_error {
                    let remaining = ERROR_LIMIT.saturating_sub(errors.len());
                    errors.extend_from_slice(&bytes[..bytes.len().min(remaining)]);
                    continue;
                }
                if output.len() + bytes.len() > output_limit {
                    return Err("Coven output exceeded the local safety limit.".into());
                }
                output.extend_from_slice(&bytes);
                if let Some(callback) = on_event.as_mut() {
                    pending.extend_from_slice(&bytes);
                    while let Some(end) = pending.iter().position(|b| *b == b'\n') {
                        let line: Vec<u8> = pending.drain(..=end).collect();
                        if line.iter().all(u8::is_ascii_whitespace) {
                            continue;
                        }
                        let event: Value = serde_json::from_slice(&line)
                            .map_err(|_| "Coven returned invalid stream JSON.")?;
                        if event.get("type").and_then(Value::as_str).is_none() {
                            return Err("Coven returned an invalid stream event.".into());
                        }
                        callback(event)?;
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) if ended == 2 => {
                thread::sleep(Duration::from_millis(20));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("Coven output closed unexpectedly.".into())
            }
        }
    }
    if !pending.is_empty() {
        return Err("Coven returned an incomplete stream event.".into());
    }
    if !status.is_some_and(|status| status.success()) {
        let diagnostic: String = String::from_utf8_lossy(&errors)
            .chars()
            .filter(|c| !c.is_control() || *c == '\n')
            .take(2048)
            .collect();
        return Err(format!("Coven command failed. {diagnostic}"));
    }
    Ok(output)
}

/// Like `execute_command_bounded`, but for tools whose output is plain text
/// rather than stream JSON: every complete line (and a trailing partial line)
/// reaches `on_line(is_stderr, text)`. Returns the exit code; a non-zero code
/// is not an error here because the caller shows it to the person.
/// Sets `NO_COLOR=1` so tools do not emit ANSI colour sequences; the
/// control-character filter would otherwise leave their CSI bodies in the
/// text.
/// Lines are ordered within each stream, but interleaving between stdout and
/// stderr is per read chunk: a stderr line may land between two stdout lines
/// that were written contiguously. Both streams draw on one shared
/// `OUTPUT_LIMIT` budget; exceeding it aborts the run.
#[allow(dead_code)] // wired in Task 12
pub(crate) fn execute_command_lines(
    mut command: Command,
    cancel: &AtomicBool,
    timeout: Duration,
    on_line: &mut dyn FnMut(bool, &str) -> Result<(), String>,
) -> Result<i32, String> {
    if cancel.load(Ordering::SeqCst) {
        return Err(RUN_CANCELLED.into());
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    command.env("NO_COLOR", "1");
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = OwnedChild(
        command
            .spawn()
            .map_err(|_| "Could not start the installer.")?,
        false,
    );
    let (sender, receiver) = mpsc::sync_channel(16);
    let stdout = child
        .0
        .stdout
        .take()
        .ok_or("Command stdout is unavailable.")?;
    let stderr = child
        .0
        .stderr
        .take()
        .ok_or("Command stderr is unavailable.")?;
    let _stdout =
        pipe_reader(stdout, false, sender.clone()).map_err(|_| "Cannot read command output.")?;
    let _stderr =
        pipe_reader(stderr, true, sender).map_err(|_| "Cannot read command diagnostics.")?;
    let deadline = Instant::now() + timeout;
    let mut pending: [Vec<u8>; 2] = [Vec::new(), Vec::new()];
    let mut total = 0usize;
    let mut ended = 0;
    let mut status = None;
    let flush = |is_stderr: bool,
                 buffer: &mut Vec<u8>,
                 on_line: &mut dyn FnMut(bool, &str) -> Result<(), String>|
     -> Result<(), String> {
        while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buffer.drain(..=end).collect();
            let text = String::from_utf8_lossy(&line[..line.len() - 1]);
            let text: String = text
                .chars()
                .filter(|c| !c.is_control() || *c == '\t')
                .take(2048)
                .collect();
            on_line(is_stderr, &text)?;
        }
        Ok(())
    };
    while ended < 2 || status.is_none() {
        if cancel.load(Ordering::SeqCst) {
            return Err(RUN_CANCELLED.into());
        }
        if Instant::now() >= deadline {
            return Err("The command timed out.".into());
        }
        status = child
            .0
            .try_wait()
            .map_err(|_| "Could not inspect the command process.")?;
        child.1 = status.is_some();
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(PipeData::End) => ended += 1,
            Ok(PipeData::Error) => return Err("Could not read command output.".into()),
            Ok(PipeData::Bytes(is_stderr, bytes)) => {
                total += bytes.len();
                if total > OUTPUT_LIMIT {
                    return Err("Command output exceeded the local safety limit.".into());
                }
                let buffer = &mut pending[usize::from(is_stderr)];
                buffer.extend_from_slice(&bytes);
                flush(is_stderr, buffer, on_line)?;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) if ended == 2 => {
                thread::sleep(Duration::from_millis(20));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("Command output closed unexpectedly.".into())
            }
        }
    }
    for (index, buffer) in pending.iter_mut().enumerate() {
        if buffer.iter().any(|b| !b.is_ascii_control()) {
            buffer.push(b'\n');
            flush(index == 1, buffer, on_line)?;
        }
    }
    Ok(status.and_then(|s| s.code()).unwrap_or(-1))
}

pub(crate) fn cli_json(args: &[&str]) -> Result<Value, String> {
    let args: Vec<String> = args.iter().map(|s| (*s).to_owned()).collect();
    let bytes = run_process(&args, None, &AtomicBool::new(false), READ_TIMEOUT, None)?;
    serde_json::from_slice(&bytes).map_err(|_| "Coven returned invalid JSON.".into())
}

fn string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Coven returned an invalid {key}."))
}

fn normalize_session(value: &Value) -> Result<Value, String> {
    Ok(without_nulls(json!({
        "id": string(value, "id")?,
        "title": value.get("title").and_then(Value::as_str).unwrap_or("Untitled session"),
        "harness": string(value, "harness")?,
        "status": string(value, "status")?,
        "familiarId": value.get("familiar_id").and_then(Value::as_str),
        "conversationId": value.get("conversation_id").and_then(Value::as_str),
        "updatedAt": string(value, "updated_at")?,
        "projectRoot": string(value, "project_root")?,
    })))
}

fn without_nulls(mut value: Value) -> Value {
    if let Some(object) = value.as_object_mut() {
        object.retain(|_, value| !value.is_null());
    }
    value
}

fn get_session(id: &str) -> Result<Value, String> {
    validate_id(id)?;
    let value = cli_json(&["sessions", "show", id, "--json"])?;
    if string(&value, "id")? != id {
        return Err("Coven session identity does not match the requested session.".into());
    }
    Ok(value)
}

fn validate_input(input: &SendInput) -> Result<(), String> {
    validate_id(&input.run_id)?;
    for id in [&input.session_id, &input.familiar_id]
        .into_iter()
        .flatten()
    {
        validate_id(id)?;
    }
    attachments::validate(&input.attachments)?;
    if (input.prompt.trim().is_empty() && input.attachments.is_empty())
        || input.prompt.len() > 32_768
        || input.prompt.contains('\0')
    {
        return Err("Enter a prompt between 1 and 32768 bytes.".into());
    }
    Ok(())
}

fn run_arguments(input: &SendInput, harness: &str, cwd: &Path) -> Result<Vec<String>, String> {
    validate_input(input)?;
    if !matches!(harness, "coven-code" | "codex" | "claude") {
        return Err(
            "This harness is not enabled for read-only chat. Use Coven Code, Codex or Claude."
                .into(),
        );
    }
    let mut args = vec![
        "run".into(),
        harness.into(),
        "--stream-json".into(),
        "--permission".into(),
        "read-only".into(),
        "--cwd".into(),
        cwd.to_str().ok_or("Workspace path is not UTF-8.")?.into(),
    ];
    if let Some(id) = &input.session_id {
        validate_id(id)?;
        args.extend(["--continue".into(), id.clone()]);
    }
    if let Some(id) = &input.familiar_id {
        validate_id(id)?;
        args.extend(["--familiar".into(), id.clone()]);
    }
    if input.attachments.is_empty() {
        args.extend(["--".into(), input.prompt.clone()]);
    } else {
        if harness != "coven-code" {
            return Err("Attachments are currently supported only with Coven Code.".into());
        }
        args.push("--stream-json-input".into());
    }
    Ok(args)
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    static WORKERS: OnceLock<Arc<tokio::sync::Semaphore>> = OnceLock::new();
    let permit = WORKERS
        .get_or_init(|| Arc::new(tokio::sync::Semaphore::new(4)))
        .clone()
        .try_acquire_owned()
        .map_err(|_| "Local Coven is busy. Retry shortly.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        work()
    })
    .await
    .map_err(|_| "Local Coven worker failed.".to_string())?
}

#[tauri::command]
pub(crate) async fn coven_runtime_status() -> Result<Value, String> {
    blocking(|| {
        let result = run_process(
            &["--version".into()],
            None,
            &AtomicBool::new(false),
            READ_TIMEOUT,
            None,
        );
        Ok(match result {
            Ok(version) => {
                let engine = cli_json(&["engine", "status", "--json"])?;
                let installed = engine.get("installed").and_then(Value::as_bool)
                    .ok_or("Coven returned invalid engine readiness.")?;
                // The pinned SDK exposes health only. Its real daemon discovery
                // remains informative; chat uses CLI contracts, never Cave.
                let sdk_health = if NativeCovenHealth::default().health().is_ok() { "ok" } else { "unavailable" };
                without_nulls(json!({
                    "available": installed && cfg!(unix),
                    "version": String::from_utf8_lossy(&version).trim(),
                    "sdkHealth": sdk_health,
                    "transport": "cli",
                    "error": if !cfg!(unix) {
                        Some("Local Coven chat currently requires macOS or Linux for safe process-tree cancellation.")
                    } else if !installed {
                        Some("The Coven engine is missing. Run coven engine install, then retry.")
                    } else { None },
                }))
            }
            Err(error) => json!({"available": false, "error": error}),
        })
    })
    .await
}

#[tauri::command]
pub(crate) async fn coven_runtime_familiars() -> Result<Value, String> {
    blocking(|| {
        let value = cli_json(&["familiars", "--json"])?;
        let familiars = value
            .as_array()
            .ok_or("Coven returned invalid familiars.")?;
        familiars
            .iter()
            .map(|f| normalize_familiar(f, crate::familiar_avatar::read_avatar))
            .collect::<Result<Vec<_>, String>>()
            .map(Value::Array)
    })
    .await
}

fn normalize_familiar(
    familiar: &Value,
    read_avatar: impl FnOnce(&Path, &str) -> Result<Option<String>, String>,
) -> Result<Value, String> {
    let id = string(familiar, "id")?;
    validate_id(id)?;
    let name = string(familiar, "name")?;
    let avatar = if let Some(workspace) = familiar.get("workspace").and_then(Value::as_str) {
        match read_avatar(Path::new(workspace), name) {
            Ok(avatar) => avatar,
            Err(error) => {
                let diagnostic: String = error
                    .chars()
                    .filter(|character| !character.is_control())
                    .take(512)
                    .collect();
                eprintln!("Coven familiar avatar [{id}]: {diagnostic}");
                None
            }
        }
    } else {
        None
    };
    Ok(without_nulls(json!({
        "id": id, "name": name,
        "displayName": string(familiar, "display_name")?,
        "description": familiar.get("description"), "emoji": familiar.get("emoji"),
        "workspace": familiar.get("workspace"), "avatarUrl": avatar,
    })))
}

#[tauri::command]
pub(crate) async fn coven_runtime_sessions(app: AppHandle) -> Result<Value, String> {
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate local chat storage.")?;
    blocking(move || {
        let _storage = crate::chat_lifecycle::STORAGE_LOCK
            .lock()
            .map_err(|_| "Chat lifecycle storage is unavailable.")?;
        let value = cli_json(&["sessions", "--all", "--json"])?;
        visible_sessions(&data, &value)
    })
    .await
}

fn visible_sessions(data: &Path, value: &Value) -> Result<Value, String> {
    let lifecycle = crate::chat_lifecycle::load(data)?;
    let mut sessions = Vec::new();
    for session in value
        .get("sessions")
        .and_then(Value::as_array)
        .ok_or("Coven returned invalid sessions.")?
    {
        if lifecycle.get(string(session, "id")?) == Some(&crate::chat_lifecycle::Lifecycle::Deleted)
            || crate::chat_origin::has_chat_origin(data, string(session, "id")?)?
        {
            sessions.push(normalize_session(session)?);
        }
    }
    crate::chat_canonical::project(data, &sessions).map(Value::Array)
}

#[tauri::command]
pub(crate) async fn coven_runtime_chat_lifecycle(
    app: AppHandle,
    state: State<'_, CovenRuntimeState>,
    id: String,
    lifecycle: crate::chat_lifecycle::Lifecycle,
) -> Result<(), String> {
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate local chat storage.")?;
    let runs = state.runs.clone();
    let shutdown = state.shutting_down.clone();
    blocking(move || change_chat_lifecycle(&data, &runs, &shutdown, &id, lifecycle)).await
}

fn change_chat_lifecycle(
    data: &Path,
    runs: &Runs,
    shutdown: &AtomicBool,
    id: &str,
    lifecycle: crate::chat_lifecycle::Lifecycle,
) -> Result<(), String> {
    let runs = runs
        .lock()
        .map_err(|_| "Coven runtime state is unavailable.")?;
    if !runs.is_empty() || shutdown.load(Ordering::SeqCst) {
        return Err(
            "Wait for the active Coven run and cancellation cleanup before changing chats.".into(),
        );
    }
    let _storage = crate::chat_lifecycle::STORAGE_LOCK
        .lock()
        .map_err(|_| "Chat lifecycle storage is unavailable.")?;
    crate::chat_canonical::require_current(data, id)?;
    crate::chat_lifecycle::change(data, id, lifecycle)?;
    if lifecycle == crate::chat_lifecycle::Lifecycle::Deleted {
        crate::chat_canonical::clear(data, id)?;
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn coven_runtime_read(app: AppHandle, id: String) -> Result<Value, String> {
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate local chat storage.")?;
    blocking(move || {
        let _storage = crate::chat_lifecycle::STORAGE_LOCK
            .lock()
            .map_err(|_| "Chat lifecycle storage is unavailable.")?;
        read_session(&data, &id)
    })
    .await
}

fn read_session(data: &Path, id: &str) -> Result<Value, String> {
    crate::chat_lifecycle::require_visible(data, id)?;
    crate::chat_origin::require_chat_origin(data, id)?;
    let familiar = crate::chat_canonical::require_current(data, id)?;
    let deadline = Instant::now() + Duration::from_secs(60);
    let selected = get_session(id)?;
    if selected.get("familiar_id").and_then(Value::as_str) != Some(familiar.as_str()) {
        return Err("The canonical Chat session no longer belongs to its mapped familiar.".into());
    }
    if let Some((events, has_more)) = read_captured_history(data, &selected, get_session)? {
        return Ok(
            json!({"session": normalize_session(&selected)?, "events": events, "hasMore": has_more}),
        );
    }
    let siblings = if selected
        .get("conversation_id")
        .and_then(Value::as_str)
        .is_some()
    {
        let listing = cli_json(&["sessions", "--all", "--json"])?;
        history_sessions(
            &selected,
            listing
                .get("sessions")
                .and_then(Value::as_array)
                .ok_or("Coven returned invalid session history.")?,
        )?
    } else {
        vec![selected.clone()]
    };
    let mut events = Vec::new();
    let mut bytes = 0;
    let mut has_more = siblings.len() > HISTORY_SESSION_LIMIT;
    'history: for sibling in siblings.iter().take(HISTORY_SESSION_LIMIT) {
        if crate::chat_lifecycle::state(data, string(sibling, "id")?)?
            == crate::chat_lifecycle::Lifecycle::Deleted
        {
            continue;
        }
        if Instant::now() >= deadline {
            has_more = true;
            break;
        }
        let (turn, partial) = read_single_session(data, string(sibling, "id")?)?;
        for event in turn {
            bytes += serde_json::to_vec(&event)
                .map_err(|_| "Cannot measure saved history.")?
                .len()
                + 1;
            if bytes > OUTPUT_LIMIT {
                has_more = true;
                break 'history;
            }
            events.push(event);
        }
        if partial {
            has_more = true;
            break;
        }
    }
    Ok(json!({"session": normalize_session(&selected)?, "events": events, "hasMore": has_more}))
}

fn history_sessions(selected: &Value, sessions: &[Value]) -> Result<Vec<Value>, String> {
    let selected_id = string(selected, "id")?;
    let Some(group) = selected.get("conversation_id").and_then(Value::as_str) else {
        return Ok(vec![selected.clone()]);
    };
    let workspace = string(selected, "project_root")?;
    let harness = string(selected, "harness")?;
    let cutoff = string(selected, "created_at")?;
    let mut seen = HashSet::new();
    let mut result = Vec::new();
    for candidate in sessions.iter().chain(std::iter::once(selected)) {
        let candidate_id = string(candidate, "id")?;
        if (candidate_id == group
            || candidate.get("conversation_id").and_then(Value::as_str) == Some(group)
            || candidate_id == selected_id)
            && candidate.get("project_root").and_then(Value::as_str) == Some(workspace)
            && candidate.get("harness").and_then(Value::as_str) == Some(harness)
            && string(candidate, "created_at")? <= cutoff
            && seen.insert(candidate_id.to_owned())
        {
            validate_id(candidate_id)?;
            result.push(candidate.clone());
        }
    }
    result.sort_by(|a, b| {
        a["created_at"]
            .as_str()
            .cmp(&b["created_at"].as_str())
            .then_with(|| a["id"].as_str().cmp(&b["id"].as_str()))
    });
    Ok(result)
}

fn read_single_session(data: &Path, id: &str) -> Result<(Vec<Value>, bool), String> {
    crate::chat_origin::require_chat_origin(data, id)?;
    if let Some(events) = read_local_events(data, id)? {
        return Ok((events, false));
    }
    read_cli_history(id, |after| {
        let cursor = after.map(|seq| seq.to_string());
        let mut args = vec!["sessions", "events", id, "--json", "--limit", "1000"];
        if let Some(cursor) = cursor.as_deref() {
            args.extend(["--after-seq", cursor]);
        }
        cli_json(&args)
    })
}

fn read_captured_history(
    data: &Path,
    selected: &Value,
    mut resolve: impl FnMut(&str) -> Result<Value, String>,
) -> Result<Option<(Vec<Value>, bool)>, String> {
    let selected_id = string(selected, "id")?;
    let Some(mut events) = read_local_events(data, selected_id)? else {
        return Ok(None);
    };
    if !events.iter().any(is_captured_input) {
        return Ok(None);
    }
    let group = selected
        .get("conversation_id")
        .and_then(Value::as_str)
        .unwrap_or(selected_id);
    let mut current = selected.clone();
    let mut seen = HashSet::new();
    let mut turns = Vec::new();
    let mut buffered_bytes = 0;
    let mut partial = false;
    let deadline = Instant::now() + Duration::from_secs(60);
    loop {
        let id = string(&current, "id")?;
        if !seen.insert(id.to_owned()) {
            return Err("Saved Coven history contains a session lineage cycle.".into());
        }
        let input = events.iter().find(|event| is_captured_input(event));
        let parent = match input {
            Some(input) => {
                if input.get("session_id").and_then(Value::as_str) != Some(id) {
                    return Err("Saved Coven input has an inconsistent session identity.".into());
                }
                match input.get("parent_session_id") {
                    None | Some(Value::Null) => None,
                    Some(value) => Some(
                        value
                            .as_str()
                            .ok_or("Saved Coven lineage has an invalid parent identifier.")?
                            .to_owned(),
                    ),
                }
            }
            None => {
                partial |= id != group;
                None
            }
        };
        let turn_bytes = events.iter().try_fold(0usize, |bytes, event| {
            serde_json::to_vec(event)
                .map(|encoded| bytes + encoded.len() + 1)
                .map_err(|_| "Cannot measure saved history.".to_string())
        })?;
        if buffered_bytes + turn_bytes > OUTPUT_LIMIT && !turns.is_empty() {
            partial = true;
            break;
        }
        buffered_bytes += turn_bytes;
        turns.push(events);
        if buffered_bytes > OUTPUT_LIMIT {
            partial = true;
            break;
        }
        let Some(parent) = parent else { break };
        if turns.len() >= HISTORY_SESSION_LIMIT || Instant::now() >= deadline {
            partial = true;
            break;
        }
        validate_id(&parent)?;
        if crate::chat_lifecycle::state(data, &parent)? == crate::chat_lifecycle::Lifecycle::Deleted
        {
            break;
        }
        if !crate::chat_origin::has_chat_origin(data, &parent)? {
            partial = true;
            break;
        }
        current = resolve(&parent)?;
        if string(&current, "id")? != parent
            || current.get("project_root") != selected.get("project_root")
            || current.get("harness") != selected.get("harness")
            || (parent != group
                && current.get("conversation_id").and_then(Value::as_str) != Some(group))
        {
            return Err(
                "Saved Coven lineage does not match the actual conversation workspace.".into(),
            );
        }
        let (parent_events, truncated) = read_single_session(data, &parent)?;
        events = parent_events;
        partial |= truncated;
    }
    let mut result = Vec::new();
    let mut bytes = 0;
    for event in turns.into_iter().rev().flatten() {
        bytes += serde_json::to_vec(&event)
            .map_err(|_| "Cannot measure saved history.")?
            .len()
            + 1;
        if bytes > OUTPUT_LIMIT {
            partial = true;
            break;
        }
        result.push(event);
    }
    Ok(Some((result, partial)))
}

fn is_captured_input(event: &Value) -> bool {
    event["type"] == "user"
        && matches!(
            event.get("source").and_then(Value::as_str),
            Some("chat-input" | "chat_input")
        )
}

fn is_cli_input_echo(event: &Value, prompt: &str) -> bool {
    event["type"] == "user"
        && event.pointer("/message/role").and_then(Value::as_str) == Some("user")
        && event
            .pointer("/message/content")
            .and_then(Value::as_array)
            .is_some_and(|content| {
                content.len() == 1
                    && content[0]["type"] == "text"
                    && content[0]["text"].as_str() == Some(prompt)
            })
}

/// The app-owned transcript directory. It must be a real directory (never a
/// symlink) so that reads, writes and deletes cannot be redirected outside
/// app storage; `create` makes it when it does not exist yet.
pub(crate) fn transcripts_dir(data: &Path, create: bool) -> Result<PathBuf, String> {
    let directory = data.join("coven-transcripts");
    match fs::symlink_metadata(&directory) {
        Ok(metadata) if metadata.file_type().is_dir() => Ok(directory),
        Ok(_) => {
            Err("Local transcript storage is not a real directory; refusing to use it.".into())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if create {
                fs::create_dir_all(&directory)
                    .map_err(|_| "Cannot create local transcript storage.")?;
            }
            Ok(directory)
        }
        Err(_) => Err("Cannot inspect local transcript storage.".into()),
    }
}

pub(crate) fn read_local_events(data: &Path, id: &str) -> Result<Option<Vec<Value>>, String> {
    validate_id(id)?;
    let transcript = transcripts_dir(data, false)?.join(format!("{id}.jsonl"));
    if transcript
        .try_exists()
        .map_err(|_| "Cannot inspect saved Coven transcript.")?
    {
        let metadata = fs::symlink_metadata(&transcript)
            .map_err(|_| "Cannot inspect saved Coven transcript.")?;
        if !metadata.is_file() || metadata.len() > TRANSCRIPT_LIMIT as u64 {
            return Err("Saved Coven transcript is invalid or too large.".into());
        }
        let mut bytes = Vec::new();
        File::open(transcript)
            .map_err(|_| "Cannot read saved Coven transcript.")?
            .take((TRANSCRIPT_LIMIT + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|_| "Cannot read saved Coven transcript.")?;
        if bytes.len() > TRANSCRIPT_LIMIT {
            return Err("Saved Coven transcript exceeds the safety limit.".into());
        }
        let events = bytes
            .split(|b| *b == b'\n')
            .filter(|line| !line.is_empty())
            .map(serde_json::from_slice::<Value>)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|_| "Saved Coven transcript contains invalid events.")?;
        return Ok(Some(events));
    }
    Ok(None)
}

fn read_cli_history(
    id: &str,
    mut fetch: impl FnMut(Option<u64>) -> Result<Value, String>,
) -> Result<(Vec<Value>, bool), String> {
    let deadline = Instant::now() + READ_TIMEOUT;
    let mut events = Vec::new();
    let mut after = None;
    let mut last_seq = 0;
    let mut bytes = 0;
    for _ in 0..HISTORY_PAGE_LIMIT {
        if Instant::now() >= deadline {
            return Ok((events, true));
        }
        let recorded = fetch(after)?;
        let records = recorded
            .get("events")
            .and_then(Value::as_array)
            .ok_or("Coven returned invalid session events.")?;
        for record in records {
            let seq = record
                .get("seq")
                .and_then(Value::as_u64)
                .ok_or("Coven returned an invalid event sequence.")?;
            if seq <= last_seq {
                return Err("Coven returned non-increasing event sequences.".into());
            }
            last_seq = seq;
            let payload: Value = serde_json::from_str(string(record, "payload_json")?)
                .map_err(|_| "Coven returned an invalid event payload.")?;
            let event = if payload.get("type").and_then(Value::as_str).is_some() {
                payload
            } else if string(record, "kind")? == "output" {
                json!({"type": "output", "text": string(&payload, "data")?, "session_id": id})
            } else {
                json!({"type": "recorded", "kind": string(record, "kind")?, "payload": payload})
            };
            bytes += serde_json::to_vec(&event)
                .map_err(|_| "Cannot measure recorded history.")?
                .len()
                + 1;
            if bytes > OUTPUT_LIMIT {
                return Ok((events, true));
            }
            events.push(event);
        }
        let has_more = recorded
            .get("hasMore")
            .and_then(Value::as_bool)
            .ok_or("Coven returned invalid event pagination.")?;
        if !has_more {
            return Ok((events, false));
        }
        let cursor = recorded
            .pointer("/nextCursor/afterSeq")
            .and_then(Value::as_u64)
            .ok_or("Coven omitted the next event cursor.")?;
        if cursor <= after.unwrap_or(0) || cursor < last_seq {
            return Err("Coven returned a non-advancing event cursor.".into());
        }
        after = Some(cursor);
    }
    Ok((events, true))
}

pub(crate) struct RunRegistration {
    runs: Runs,
    id: String,
}
impl Drop for RunRegistration {
    fn drop(&mut self) {
        if let Ok(mut runs) = self.runs.lock() {
            runs.remove(&self.id);
        }
    }
}

#[tauri::command]
pub(crate) async fn coven_runtime_send(
    app: AppHandle,
    state: State<'_, CovenRuntimeState>,
    input: SendInput,
    on_event: Channel<Value>,
) -> Result<Value, String> {
    if !cfg!(unix) {
        return Err(
            "Read-only chat process-tree cancellation is currently supported on macOS and Linux."
                .into(),
        );
    }

    validate_input(&input)?;
    let (cancel, registration) = state.register_run(&input.run_id)?;
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate local chat storage.")?;
    blocking(move || {
        let _registration = registration;
        send_local(&data, input, &cancel, &mut |event| {
            on_event
                .send(event)
                .map_err(|_| "The chat event receiver disconnected.".into())
        })
    })
    .await
}

fn send_local(
    data: &Path,
    input: SendInput,
    cancel: &AtomicBool,
    on_event: &mut dyn FnMut(Value) -> Result<(), String>,
) -> Result<Value, String> {
    validate_input(&input)?;
    let mut input = input;
    let selected_familiar = input
        .familiar_id
        .clone()
        .ok_or("Select a familiar before sending a message.")?;
    {
        let _storage = crate::chat_lifecycle::STORAGE_LOCK
            .lock()
            .map_err(|_| "Chat lifecycle storage is unavailable.")?;
        if !crate::chat_canonical::load(data)?.contains_key(&selected_familiar) {
            visible_sessions(data, &cli_json(&["sessions", "--all", "--json"])?)?;
            crate::chat_canonical::ensure_empty(data, &selected_familiar)?;
        }
        if crate::chat_canonical::head(data, &selected_familiar)? != input.session_id {
            return Err(
                "This familiar's chat has changed since this view loaded. Reopen the familiar from the sidebar before sending."
                    .into(),
            );
        }
    }
    let (harness, workspace) = if let Some(id) = &input.session_id {
        crate::chat_lifecycle::require_active(data, id)?;
        crate::chat_origin::require_chat_origin(data, id)?;
        let session = get_session(id)?;
        if let Some(requested) = &input.harness {
            if requested != string(&session, "harness")? {
                return Err("A resumed session must use its original harness.".into());
            }
        }
        let familiar = session
            .get("familiar_id")
            .and_then(Value::as_str)
            .map(str::to_owned);
        if input.familiar_id.is_some() && input.familiar_id != familiar {
            return Err("A resumed session must use its original familiar.".into());
        }
        input.familiar_id = familiar;
        (
            string(&session, "harness")?.to_owned(),
            PathBuf::from(string(&session, "project_root")?),
        )
    } else if let Some(id) = &input.familiar_id {
        validate_id(id)?;
        let familiars = cli_json(&["familiars", "--json"])?;
        let familiar = familiars
            .as_array()
            .ok_or("Coven returned invalid familiars.")?
            .iter()
            .find(|f| f.get("id").and_then(Value::as_str) == Some(id))
            .ok_or("The selected familiar is not installed in Coven.")?;
        (
            input.harness.clone().unwrap_or_else(|| "coven-code".into()),
            PathBuf::from(string(familiar, "workspace")?),
        )
    } else {
        return Err("Select a familiar before sending a message.".into());
    };
    if !workspace.is_absolute() {
        return Err("Coven workspace must be an absolute local directory.".into());
    }
    let workspace = workspace
        .canonicalize()
        .map_err(|_| "The Coven workspace does not exist.")?;
    if workspace.parent().is_none() || workspace == home()? || !workspace.is_dir() {
        return Err(
            "Coven requires a dedicated project workspace, not a filesystem or home root.".into(),
        );
    }
    let mut args = run_arguments(&input, &harness, &workspace)?;
    let staged = if input.attachments.is_empty() {
        None
    } else {
        Some(attachments::stage(
            data,
            &input.run_id,
            &input.prompt,
            &input.attachments,
        )?)
    };
    let input_file = if let Some((directory, path, _)) = &staged {
        args.extend([
            "--add-dir".into(),
            directory
                .to_str()
                .ok_or("Attachment path is not UTF-8.")?
                .into(),
        ]);
        // Coven requires a positional prompt to create a ledger session; the
        // stream-mode engine consumes the full user message from stdin instead.
        args.extend([
            "--".into(),
            if input.prompt.trim().is_empty() {
                "Read the attached text files.".into()
            } else {
                input.prompt.clone()
            },
        ]);
        Some(File::open(path).map_err(|_| "Cannot open staged attachment input.")?)
    } else {
        None
    };
    let echo_prompt = staged
        .as_ref()
        .map_or(input.prompt.as_str(), |(_, _, echo)| echo.as_str());
    let transcripts = transcripts_dir(data, true)?;
    let mut transcript: Option<File> = None;
    let mut events = Vec::new();
    let mut input_session: Option<String> = None;
    let mut observe = |event: Value| -> Result<(), String> {
        if input_session
            .as_deref()
            .is_some_and(|id| event.get("session_id").and_then(Value::as_str) == Some(id))
            && (is_cli_input_echo(&event, echo_prompt) || is_cli_input_echo(&event, &input.prompt))
        {
            return Ok(());
        }
        let mut captured_input = None;
        if transcript.is_none()
            && event.get("type").and_then(Value::as_str) == Some("system")
            && event.get("subtype").and_then(Value::as_str) == Some("init")
        {
            let id = string(&event, "session_id")?;
            validate_id(id)?;
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            transcript = Some(
                options
                    .open(transcripts.join(format!("{id}.jsonl")))
                    .map_err(|_| "Cannot create the local Coven transcript.")?,
            );
            // Preserve the exact submitted input even when the engine does not
            // echo it. Matching CLI user echoes are suppressed above.
            captured_input = Some(json!({
                "type": "user", "source": "chat-input", "session_id": id,
                "parent_session_id": input.session_id,
                "attachments": attachments::metadata(&input.attachments),
                "message": {"role": "user", "content": [{"type": "text", "text": input.prompt}]},
            }));
            input_session = Some(id.to_owned());
        }
        let file = transcript
            .as_mut()
            .ok_or("Coven stream did not begin with session identity.")?;
        let initialized = captured_input.is_some();
        let mut published = Vec::new();
        for event in std::iter::once(event).chain(captured_input) {
            serde_json::to_writer(&mut *file, &event)
                .map_err(|_| "Cannot save Coven transcript.")?;
            file.write_all(b"\n")
                .map_err(|_| "Cannot save Coven transcript.")?;
            file.flush().map_err(|_| "Cannot save Coven transcript.")?;
            published.push(event);
        }
        if initialized {
            file.sync_all()
                .map_err(|_| "Cannot persist the new Chat thread.")?;
            #[cfg(unix)]
            File::open(&transcripts)
                .and_then(|directory| directory.sync_all())
                .map_err(|_| "Cannot persist the new Chat transcript directory.")?;
            let _storage = crate::chat_lifecycle::STORAGE_LOCK
                .lock()
                .map_err(|_| "Chat lifecycle storage is unavailable.")?;
            crate::chat_canonical::advance(
                data,
                &selected_familiar,
                input.session_id.as_deref(),
                input_session
                    .as_deref()
                    .ok_or("Coven omitted the new session identity.")?,
            )?;
        }
        for event in published {
            events.push(event.clone());
            on_event(event)?;
        }
        Ok(())
    };
    run_process_input(
        &args,
        Some(&workspace),
        cancel,
        RUN_TIMEOUT,
        Some(&mut observe),
        input_file,
    )?;
    if !events
        .iter()
        .any(|event| event.get("type").and_then(Value::as_str) == Some("result"))
    {
        return Err("Coven exited without a terminal result.".into());
    }
    if let Some(event) = events.iter().find(|event| {
        event.get("type").and_then(Value::as_str) == Some("result")
            && event.get("is_error").and_then(Value::as_bool) == Some(true)
    }) {
        let detail: String = event
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("The harness reported an unsuccessful result.")
            .chars()
            .take(2048)
            .collect();
        return Err(format!("Coven run failed. {detail}"));
    }
    Ok(json!({"runId": input.run_id, "events": events}))
}

#[tauri::command]
pub(crate) fn coven_runtime_cancel(
    state: State<'_, CovenRuntimeState>,
    run_id: String,
) -> Result<(), String> {
    validate_id(&run_id)?;
    let runs = state
        .runs
        .lock()
        .map_err(|_| "Coven runtime state is unavailable.")?;
    let cancel = runs
        .get(&run_id)
        .ok_or("No active Coven run matches this identifier.")?;
    cancel.store(true, Ordering::SeqCst);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn local_transcripts_are_never_read_through_a_symlinked_directory() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let data = root.join("data");
        let outside = root.join("outside");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("one.jsonl"), "{\"type\":\"system\"}").unwrap();
        std::os::unix::fs::symlink(&outside, data.join("coven-transcripts")).unwrap();
        let error = read_local_events(&data, "one").unwrap_err();
        assert!(error.contains("transcript"), "{error}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deduplicates_only_exact_cli_echoes_of_the_submitted_prompt() {
        let echo = json!({"type":"user","message":{"role":"user","content":[{"type":"text","text":"exact prompt"}]}});
        assert!(is_cli_input_echo(&echo, "exact prompt"));
        assert!(!is_cli_input_echo(&echo, "different prompt"));
        assert!(!is_cli_input_echo(
            &json!({"type":"assistant","message":echo["message"]}),
            "exact prompt"
        ));
        assert!(!is_cli_input_echo(
            &json!({"type":"user","message":{"role":"user","content":[
                {"type":"text","text":"exact prompt"},{"type":"text","text":"additional context"}
            ]}}),
            "exact prompt"
        ));
    }

    #[test]
    fn recognizes_canonical_and_preexisting_captured_input_provenance() {
        assert!(is_captured_input(
            &json!({"type":"user","source":"chat-input"})
        ));
        assert!(is_captured_input(
            &json!({"type":"user","source":"chat_input"})
        ));
        assert!(!is_captured_input(
            &json!({"type":"assistant","source":"chat-input"})
        ));
    }

    #[cfg(unix)]
    #[test]
    fn quit_cancels_a_quiet_request_and_waits_for_real_reaping() {
        let state = CovenRuntimeState::default();
        let (cancel, registration) = state.register_run("quiet-run").unwrap();
        let (started, ready) = mpsc::channel();
        let worker = thread::spawn(move || {
            let _registration = registration;
            let mut command = Command::new("/bin/sh");
            command.args([
                "-c",
                "printf '%s\\n' '{\"type\":\"system\",\"subtype\":\"init\"}'; exec /bin/sleep 30",
            ]);
            execute_command(
                command,
                &cancel,
                RUN_TIMEOUT,
                Some(&mut |_| {
                    started
                        .send(())
                        .map_err(|_| "The test observer disconnected.".into())
                }),
            )
        });
        ready.recv_timeout(Duration::from_secs(10)).unwrap();
        assert!(state.begin_shutdown().unwrap());
        assert!(state.register_run("too-late").is_err());
        assert!(wait_for_runs(&state.runs, Duration::from_secs(3)).unwrap());
        assert_eq!(worker.join().unwrap().unwrap_err(), RUN_CANCELLED);
        assert!(!state.begin_shutdown().unwrap());
        assert!(include_str!("lib.rs").contains("handle_exit_requested"));
    }

    #[test]
    fn continuation_history_is_ordered_unique_and_workspace_bound() {
        let first = json!({"id":"first","conversation_id":null,"created_at":"2026-09-14T01:00:00Z","project_root":"/work","harness":"coven-code"});
        let second = json!({"id":"second","conversation_id":"first","created_at":"2026-09-14T02:00:00Z","project_root":"/work","harness":"coven-code"});
        let unrelated = json!({"id":"other","conversation_id":"first","created_at":"2026-09-14T01:30:00Z","project_root":"/elsewhere","harness":"coven-code"});
        let history = history_sessions(
            &second,
            &[second.clone(), unrelated, first.clone(), second.clone()],
        )
        .unwrap();
        assert_eq!(
            history
                .iter()
                .map(|s| s["id"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["first", "second"]
        );
        assert_eq!(
            history_sessions(&first, &[first.clone(), second])
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn session_listing_requires_persisted_app_origin_even_after_reload() {
        let data = std::env::temp_dir().join(format!("opencoven-origin-{}", uuid::Uuid::new_v4()));
        let transcripts = data.join("coven-transcripts");
        fs::create_dir_all(&transcripts).unwrap();
        let owned = json!({"id":"owned","familiar_id":"f","harness":"coven-code","status":"completed","updated_at":"2026-09-14","project_root":"/work"});
        let external = json!({"id":"external"});
        let listing = json!({"sessions":[owned.clone(), external]});
        assert_eq!(visible_sessions(&data, &listing).unwrap(), json!([]));
        fs::write(
            transcripts.join("owned.jsonl"),
            json!({"type":"user","source":"chat-input","session_id":"owned"}).to_string(),
        )
        .unwrap();
        let mut expected = normalize_session(&owned).unwrap();
        expected["archived"] = json!(false);
        for _ in 0..2 {
            assert_eq!(
                visible_sessions(&data, &listing).unwrap(),
                json!([expected])
            );
        }
        fs::remove_file(transcripts.join("owned.jsonl")).unwrap();
        fs::remove_file(data.join("chat-canonical-v1.json")).unwrap();
        fs::remove_dir(transcripts).unwrap();
        fs::remove_dir(data).unwrap();
    }

    #[test]
    fn durable_lineage_reopens_both_turns_without_ledger_enumeration() {
        let data = std::env::temp_dir().join(format!("opencoven-lineage-{}", uuid::Uuid::new_v4()));
        let transcripts = data.join("coven-transcripts");
        fs::create_dir_all(&transcripts).unwrap();
        let first = json!({"id":"first","conversation_id":null,"project_root":"/work","harness":"coven-code"});
        let second = json!({"id":"second","conversation_id":"first","project_root":"/work","harness":"coven-code"});
        let first_events = [
            json!({"type":"user","source":"chat-input","session_id":"first","parent_session_id":null}),
            json!({"type":"text_delta","session_id":"first","text":"first response"}),
        ];
        let second_events = [
            json!({"type":"user","source":"chat-input","session_id":"second","parent_session_id":"first"}),
            json!({"type":"text_delta","session_id":"second","text":"second response"}),
        ];
        for (id, events) in [("first", &first_events), ("second", &second_events)] {
            let lines = events
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n");
            fs::write(transcripts.join(format!("{id}.jsonl")), lines).unwrap();
        }
        let (history, partial) = read_captured_history(&data, &second, |id| {
            assert_eq!(id, "first");
            Ok(first.clone())
        })
        .unwrap()
        .unwrap();
        assert!(!partial);
        assert_eq!(
            history,
            first_events
                .into_iter()
                .chain(second_events)
                .collect::<Vec<_>>()
        );
        assert!(read_captured_history(&data, &second, |_| {
            let mut mismatched = first.clone();
            mismatched["project_root"] = json!("/unrelated");
            Ok(mismatched)
        })
        .is_err());
        fs::remove_file(transcripts.join("first.jsonl")).unwrap();
        let (history, partial) = read_captured_history(&data, &second, |_| {
            panic!("External parent must not trigger CLI history access")
        })
        .unwrap()
        .unwrap();
        assert!(partial);
        assert_eq!(history.len(), 2);
        fs::write(
            transcripts.join("first.jsonl"),
            json!({"type":"user","source":"chat-input","session_id":"first"}).to_string(),
        )
        .unwrap();
        crate::chat_lifecycle::change(&data, "first", crate::chat_lifecycle::Lifecycle::Deleted)
            .unwrap();
        // Even a stale/recreated local transcript cannot bypass the tombstone.
        fs::write(transcripts.join("first.jsonl"), "{}").unwrap();
        let (history, partial) = read_captured_history(&data, &second, |_| {
            panic!("Deleted ancestors must not be resolved or replayed")
        })
        .unwrap()
        .unwrap();
        assert!(!partial);
        assert_eq!(history.len(), 2);
        assert!(read_session(&data, "first")
            .unwrap_err()
            .contains("deleted"));
        assert!(read_session(&data, "external-session")
            .unwrap_err()
            .contains("not created in Chat"));
        fs::remove_file(transcripts.join("second.jsonl")).unwrap();
        fs::remove_file(transcripts.join("first.jsonl")).unwrap();
        fs::remove_file(data.join("chat-lifecycle-v1.json")).unwrap();
        fs::remove_dir(transcripts).unwrap();
        fs::remove_dir(data).unwrap();
    }

    #[test]
    fn cli_history_follows_cursors_beyond_one_thousand_events() {
        let mut requests = Vec::new();
        let (events, more) = read_cli_history("session-1", |after| {
            requests.push(after);
            Ok(match after {
                None => json!({"events": (1..=1000).map(|seq| json!({"seq":seq,"kind":"output","payload_json":"{\"data\":\"x\"}"})).collect::<Vec<_>>(),
                    "hasMore":true,"nextCursor":{"afterSeq":1000}}),
                Some(1000) => json!({"events":[{"seq":1001,"kind":"output","payload_json":"{\"data\":\"last\"}"}],"hasMore":false}),
                _ => panic!("unexpected cursor"),
            })
        }).unwrap();
        assert_eq!(requests, [None, Some(1000)]);
        assert_eq!(events.len(), 1001);
        assert_eq!(events[1000]["text"], "last");
        assert!(!more);
    }

    #[test]
    fn cli_history_rejects_non_advancing_cursors() {
        let result = read_cli_history("session-1", |_| {
            Ok(json!({
                "events":[],"hasMore":true,"nextCursor":{"afterSeq":0}
            }))
        });
        assert!(result.is_err());
    }

    #[test]
    fn cli_history_reports_partial_at_its_explicit_page_budget() {
        let mut count = 0;
        let (events, more) = read_cli_history("session-1", |after| {
            count += 1;
            let next = after.unwrap_or(0) + 1;
            Ok(
                json!({"events":[{"seq":next,"kind":"output","payload_json":"{\"data\":\"x\"}"}],
                "hasMore":true,"nextCursor":{"afterSeq":next}}),
            )
        })
        .unwrap();
        assert!(more);
        assert_eq!(count, HISTORY_PAGE_LIMIT);
        assert_eq!(events.len(), HISTORY_PAGE_LIMIT);
    }

    #[test]
    fn shutdown_timeout_does_not_claim_reaped_runs() {
        let state = CovenRuntimeState::default();
        let (_, registration) = state.register_run("still-cleaning-up").unwrap();
        assert!(state.begin_shutdown().unwrap());
        assert!(!wait_for_runs(&state.runs, Duration::from_millis(1)).unwrap());
        assert!(!state.exit_ready.load(Ordering::SeqCst));
        drop(registration);
        assert!(wait_for_runs(&state.runs, Duration::from_millis(1)).unwrap());
    }

    #[test]
    fn chat_lifecycle_waits_for_run_registration_to_be_released_not_just_cancelled() {
        use crate::chat_lifecycle::Lifecycle;
        let data = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let transcripts = data.join("coven-transcripts");
        fs::create_dir_all(&transcripts).unwrap();
        fs::write(
            transcripts.join("owned.jsonl"),
            json!({"type":"user","source":"chat-input","session_id":"owned"}).to_string(),
        )
        .unwrap();
        let state = CovenRuntimeState::default();
        let (cancel, registration) = state.register_run("active").unwrap();
        for lifecycle in [Lifecycle::Archived, Lifecycle::Active, Lifecycle::Deleted] {
            assert!(change_chat_lifecycle(
                &data,
                &state.runs,
                &state.shutting_down,
                "owned",
                lifecycle
            )
            .unwrap_err()
            .contains("active Coven run"));
        }
        cancel.store(true, Ordering::SeqCst);
        assert!(change_chat_lifecycle(
            &data,
            &state.runs,
            &state.shutting_down,
            "owned",
            Lifecycle::Deleted
        )
        .is_err());
        assert!(!data.join("chat-lifecycle-v1.json").exists());
        drop(registration);
        crate::chat_canonical::advance(&data, "f", None, "owned").unwrap();
        change_chat_lifecycle(
            &data,
            &state.runs,
            &state.shutting_down,
            "owned",
            Lifecycle::Deleted,
        )
        .unwrap();
        assert!(!transcripts.join("owned.jsonl").exists());
        fs::remove_file(data.join("chat-lifecycle-v1.json")).unwrap();
        fs::remove_file(data.join("chat-canonical-v1.json")).unwrap();
        fs::remove_dir(transcripts).unwrap();
        fs::remove_dir(data).unwrap();
    }

    #[test]
    fn canonical_send_guards_reject_stale_archived_and_standalone_inputs_before_cli_access() {
        use crate::chat_lifecycle::Lifecycle;
        let data = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let transcripts = data.join("coven-transcripts");
        fs::create_dir_all(&transcripts).unwrap();
        fs::write(
            transcripts.join("owned.jsonl"),
            json!({"type":"user","source":"chat-input","session_id":"owned"}).to_string(),
        )
        .unwrap();
        crate::chat_canonical::advance(&data, "f", None, "owned").unwrap();
        let input = |session: Option<&str>, familiar: Option<&str>| SendInput {
            run_id: "guard-test".into(),
            prompt: "Do not run a model".into(),
            session_id: session.map(str::to_owned),
            familiar_id: familiar.map(str::to_owned),
            harness: None,
            attachments: vec![],
        };
        let cancel = AtomicBool::new(false);
        let mut no_events = |_| panic!("Rejected inputs must never execute a model");
        assert!(
            send_local(&data, input(None, None), &cancel, &mut no_events)
                .unwrap_err()
                .contains("Select a familiar")
        );
        assert!(
            send_local(&data, input(None, Some("f")), &cancel, &mut no_events)
                .unwrap_err()
                .contains("chat has changed since this view loaded")
        );
        crate::chat_lifecycle::change(&data, "owned", Lifecycle::Archived).unwrap();
        assert!(send_local(
            &data,
            input(Some("owned"), Some("f")),
            &cancel,
            &mut no_events
        )
        .unwrap_err()
        .contains("Restore"));
        crate::chat_lifecycle::change(&data, "owned", Lifecycle::Deleted).unwrap();
        crate::chat_canonical::clear(&data, "owned").unwrap();
        assert!(send_local(
            &data,
            input(Some("owned"), Some("f")),
            &cancel,
            &mut no_events
        )
        .unwrap_err()
        .contains("chat has changed since this view loaded"));
        fs::remove_file(data.join("chat-lifecycle-v1.json")).unwrap();
        fs::remove_file(data.join("chat-canonical-v1.json")).unwrap();
        fs::remove_dir(transcripts).unwrap();
        fs::remove_dir(data).unwrap();
    }

    #[test]
    fn familiar_avatar_uses_the_cli_workspace_and_name() {
        let familiar = json!({"id":"sage","name":"sage","display_name":"Sage","workspace":"/custom/coven/sage"});
        let result = normalize_familiar(&familiar, |workspace, name| {
            assert_eq!(workspace, Path::new("/custom/coven/sage"));
            assert_eq!(name, "sage");
            Ok(Some("data:image/png;base64,fixture".into()))
        })
        .unwrap();
        assert_eq!(result["avatarUrl"], "data:image/png;base64,fixture");
    }

    #[test]
    fn familiar_avatar_failure_does_not_block_the_roster() {
        let familiar = json!({"id":"sage","name":"sage","display_name":"Sage","workspace":"/custom/coven/sage"});
        let result = normalize_familiar(&familiar, |_, _| Err("Invalid image".into())).unwrap();
        assert_eq!(result["id"], "sage");
        assert!(result.get("avatarUrl").is_none());
        let result = normalize_familiar(&familiar, |_, _| Ok(None)).unwrap();
        assert!(result.get("avatarUrl").is_none());
    }

    #[test]
    fn identifiers_are_not_options_or_paths() {
        for value in ["", "--help", "../secret", "a/b", "a\nb"] {
            assert!(validate_id(value).is_err());
        }
        assert!(validate_id("session-a123").is_ok());
    }

    #[test]
    fn prompts_are_single_arguments_after_option_terminator() {
        let input = SendInput {
            run_id: "run-1".into(),
            prompt: "--permission full; touch file".into(),
            session_id: None,
            familiar_id: Some("sage".into()),
            harness: Some("codex".into()),
            attachments: vec![],
        };
        let args = run_arguments(&input, "codex", std::path::Path::new("/safe/work")).unwrap();
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--permission", "read-only"]));
        assert_eq!(
            &args[args.len() - 2..],
            ["--", "--permission full; touch file"]
        );
        assert!(!args.iter().any(|arg| arg == "full"));
    }

    #[test]
    fn unsupported_permission_harness_is_rejected() {
        let input = SendInput {
            run_id: "run-1".into(),
            prompt: "hello".into(),
            session_id: None,
            familiar_id: None,
            harness: Some("copilot".into()),
            attachments: vec![],
        };
        assert!(run_arguments(&input, "copilot", std::path::Path::new("/safe")).is_err());
    }

    #[test]
    fn attachment_only_input_uses_supported_stream_transport_and_read_only_permission() {
        let input: SendInput = serde_json::from_value(json!({
            "runId": "attachment-run",
            "prompt": "",
            "attachments": [{"name": "note.txt", "bytes": [65, 66]}]
        }))
        .unwrap();
        let args = run_arguments(&input, "coven-code", Path::new("/safe")).unwrap();
        assert!(args.iter().any(|arg| arg == "--stream-json-input"));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--permission", "read-only"]));
        assert!(run_arguments(&input, "codex", Path::new("/safe")).is_err());
        assert!(run_arguments(&input, "claude", Path::new("/safe")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn process_output_is_bounded() {
        let command = Command::new("/usr/bin/yes");
        let result = execute_command(command, &AtomicBool::new(false), READ_TIMEOUT, None);
        assert_eq!(
            result.unwrap_err(),
            "Coven output exceeded the local safety limit."
        );
    }

    #[cfg(unix)]
    #[test]
    fn process_timeout_terminates_and_reaps() {
        let mut command = Command::new("/bin/sleep");
        command.arg("10");
        let start = Instant::now();
        let result = execute_command(
            command,
            &AtomicBool::new(false),
            Duration::from_millis(50),
            None,
        );
        assert_eq!(result.unwrap_err(), "Coven operation timed out.");
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[cfg(unix)]
    #[test]
    fn process_cancellation_terminates_and_reaps() {
        let mut command = Command::new("/bin/sleep");
        command.arg("10");
        let result = execute_command(command, &AtomicBool::new(true), READ_TIMEOUT, None);
        assert_eq!(result.unwrap_err(), RUN_CANCELLED);
    }

    #[cfg(unix)]
    #[test]
    fn process_delivers_real_jsonl_events() {
        let mut command = Command::new("/usr/bin/printf");
        command.arg("%s\n").arg(
            r#"{"type":"assistant","message":{"content":[{"type":"text","text":"fixture"}]}}"#,
        );
        let mut events = Vec::new();
        let mut observe = |event| {
            events.push(event);
            Ok(())
        };
        execute_command(
            command,
            &AtomicBool::new(false),
            READ_TIMEOUT,
            Some(&mut observe),
        )
        .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0]["message"]["content"][0]["text"], "fixture");
    }

    #[test]
    fn bundled_engine_is_read_only_and_preserves_session_identity() {
        let input = SendInput {
            run_id: "run-1".into(),
            prompt: "hello".into(),
            session_id: Some("session-1".into()),
            familiar_id: Some("sage".into()),
            harness: None,
            attachments: vec![],
        };
        let args = run_arguments(&input, "coven-code", Path::new("/workspace")).unwrap();
        assert_eq!(&args[..2], ["run", "coven-code"]);
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--continue", "session-1"]));
        assert!(args.windows(2).any(|pair| pair == ["--familiar", "sage"]));
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--permission", "read-only"]));
    }

    #[test]
    fn frontend_cannot_supply_paths_permissions_or_arbitrary_arguments() {
        for field in ["argv", "cwd", "permission", "executable", "url"] {
            let mut input = json!({"runId": "run-1", "prompt": "hello"});
            input[field] = json!("untrusted");
            assert!(serde_json::from_value::<SendInput>(input).is_err());
        }
    }

    #[test]
    fn absent_optional_fields_are_omitted_not_mistyped_as_null() {
        let session = normalize_session(&json!({
            "id": "session-1", "harness": "coven-code", "status": "completed",
            "updated_at": "today", "project_root": "/workspace", "familiar_id": null,
        }))
        .unwrap();
        assert!(session.get("familiarId").is_none());
        assert_eq!(session["title"], "Untitled session");
    }

    #[test]
    fn new_commands_have_explicit_local_window_permissions() {
        let capability: Value =
            serde_json::from_str(include_str!("../capabilities/default.json")).unwrap();
        let permissions = capability["permissions"].as_array().unwrap();
        for suffix in [
            "status",
            "familiars",
            "sessions",
            "read",
            "send",
            "cancel",
            "chat-lifecycle",
        ] {
            assert!(permissions.contains(&json!(format!("allow-coven-runtime-{suffix}"))));
        }
        assert_eq!(capability["windows"], json!(["main"]));
        assert!(capability.get("remote").is_none());
        assert!(!permissions.contains(&json!("allow-coven-runtime-import-cave")));
        assert!(!include_str!("lib.rs").contains("coven_runtime_import_cave"));
        assert!(!include_str!("../build.rs").contains("coven_runtime_import_cave"));
    }

    #[test]
    #[ignore = "requires an installed local Coven CLI; read-only integration probe"]
    fn installed_cli_read_contracts() {
        let executable = resolve_cli().unwrap();
        assert!(executable.is_absolute());
        let version = run_process(
            &["--version".into()],
            None,
            &AtomicBool::new(false),
            READ_TIMEOUT,
            None,
        )
        .unwrap();
        assert!(String::from_utf8_lossy(&version).contains("coven"));
        assert!(cli_json(&["engine", "status", "--json"]).unwrap()["installed"].is_boolean());
        assert!(cli_json(&["familiars", "--json"]).unwrap().is_array());
        assert!(cli_json(&["sessions", "--json"]).unwrap()["sessions"].is_array());
        assert!(cli_json(&["sessions", "--all", "--json"]).unwrap()["sessions"].is_array());
    }

    #[test]
    #[ignore = "requires installed Coven familiars with local PNG/JPEG avatars; read-only probe"]
    fn installed_familiar_thumbnail_contract() {
        let value = tauri::async_runtime::block_on(coven_runtime_familiars()).unwrap();
        let familiars = value.as_array().unwrap();
        let avatars: Vec<&str> = familiars
            .iter()
            .filter_map(|familiar| familiar["avatarUrl"].as_str())
            .collect();
        assert!(
            !avatars.is_empty(),
            "No installed familiar avatar was returned."
        );
        assert!(avatars.iter().all(
            |avatar| avatar.starts_with("data:image/png;base64,") && avatar.len() <= 256 * 1024
        ));
        if let Ok(expected) = std::env::var("COVEN_CHAT_EXPECT_AVATAR") {
            validate_id(&expected).unwrap();
            let familiar = familiars
                .iter()
                .find(|familiar| familiar["id"] == expected)
                .expect("The required familiar is not present in the installed roster.");
            assert!(
                familiar["avatarUrl"]
                    .as_str()
                    .is_some_and(|avatar| avatar.starts_with("data:image/png;base64,")),
                "The required familiar did not receive a PNG thumbnail."
            );
            println!("Verified required familiar PNG thumbnail: {expected}");
        }
        println!(
            "Native roster returned {} bounded PNG thumbnails for {} familiars.",
            avatars.len(),
            familiars.len()
        );
    }

    #[test]
    #[ignore = "opt-in configured-model probe: creates and retains two real Coven ledger sessions"]
    fn installed_native_chat_send_read_resume() {
        assert_eq!(
            std::env::var("COVEN_CHAT_MODEL_SMOKE").as_deref(),
            Ok("1"),
            "Set COVEN_CHAT_MODEL_SMOKE=1 to authorize the configured-model probe."
        );
        let data = home()
            .unwrap()
            .join("Library/Application Support/com.opencoven.chat")
            .join("native-smoke")
            .join(uuid::Uuid::new_v4().to_string());
        println!("Retaining isolated app smoke storage: {}", data.display());
        let cancel = AtomicBool::new(false);
        let mut previous = None;
        let mut ids = Vec::new();
        let mut complete_transcript = Vec::new();
        for prompt in [
            "Reply exactly COVEN_CHAT_READY. Do not use tools or access files.",
            "Reply exactly COVEN_CHAT_RESUMED. Do not use tools or access files.",
        ] {
            let input = SendInput {
                run_id: uuid::Uuid::new_v4().to_string(),
                prompt: prompt.into(),
                session_id: previous.clone(),
                familiar_id: None,
                harness: Some("coven-code".into()),
                attachments: vec![],
            };
            let mut observed = Vec::new();
            let result = send_local(&data, input, &cancel, &mut |event| {
                if event["type"] == "system" && event["subtype"] == "init" {
                    println!(
                        "Retaining Coven smoke ledger ID: {}",
                        string(&event, "session_id")?
                    );
                }
                observed.push(event);
                Ok(())
            })
            .expect("Actual configured-model native send failed");
            assert_eq!(result["events"], json!(observed));
            assert!(observed.iter().any(|event| event["type"] == "user"
                && event["source"] == "chat-input"
                && event
                    .pointer("/message/content/0/text")
                    .and_then(Value::as_str)
                    == Some(prompt)));
            complete_transcript.extend(observed.iter().cloned());
            let init = observed
                .iter()
                .find(|event| event["type"] == "system" && event["subtype"] == "init")
                .unwrap();
            let id = string(init, "session_id").unwrap().to_owned();
            assert_eq!(init["permission"], "read-only");
            let expected = if previous.is_none() {
                "COVEN_CHAT_READY"
            } else {
                "COVEN_CHAT_RESUMED"
            };
            let delta_text: String = observed
                .iter()
                .filter(|event| event["type"] == "text_delta")
                .filter_map(|event| event["text"].as_str())
                .collect();
            assert!(
                delta_text.trim() == expected
                    || observed
                        .iter()
                        .filter(|event| event["type"] == "assistant")
                        .filter_map(|event| event
                            .pointer("/message/content")
                            .and_then(Value::as_array))
                        .flatten()
                        .any(|block| block["type"] == "text"
                            && block["text"]
                                .as_str()
                                .is_some_and(|text| text.trim() == expected)),
                "The actual assistant did not return the requested marker"
            );
            assert!(!observed.iter().any(|event| event["type"]
                .as_str()
                .is_some_and(|kind| kind.starts_with("tool"))));
            assert!(!observed
                .iter()
                .filter_map(|event| event.pointer("/message/content").and_then(Value::as_array))
                .flatten()
                .any(|block| block["type"] == "tool_use"));
            let saved = read_session(&data, &id).expect("Persisted native readback failed");
            assert_eq!(saved["events"], json!(complete_transcript));
            assert_eq!(saved["hasMore"], false);
            assert_eq!(saved["session"]["id"], id);
            assert_eq!(saved["session"]["harness"], "coven-code");
            assert_eq!(saved["session"]["status"], "completed");
            assert_eq!(
                saved["session"]["projectRoot"],
                data.join("coven-workspace")
                    .canonicalize()
                    .unwrap()
                    .to_string_lossy()
                    .as_ref()
            );
            if let Some(old) = &previous {
                assert_ne!(
                    old, &id,
                    "Coven resume must return its real sibling ledger identity"
                );
                let old_record = get_session(old).unwrap();
                let resumed_record = get_session(&id).unwrap();
                assert_eq!(resumed_record["project_root"], old_record["project_root"]);
                let expected_group = old_record
                    .get("conversation_id")
                    .and_then(Value::as_str)
                    .unwrap_or(old);
                assert_eq!(resumed_record["conversation_id"], expected_group);
            }
            ids.push(id.clone());
            previous = Some(id);
        }
        let reopened = read_session(&data, previous.as_deref().unwrap()).unwrap();
        assert_eq!(reopened["events"], json!(complete_transcript));
        assert_eq!(
            complete_transcript
                .iter()
                .filter(|event| is_captured_input(event))
                .count(),
            2
        );
        println!("Retained Coven native smoke ledger IDs: {}", ids.join(", "));
        println!("Retained isolated app smoke storage: {}", data.display());
    }

    #[test]
    #[ignore = "read-only verification of retained real model-smoke records"]
    fn retained_model_smoke_reopens_both_turns() {
        let data = PathBuf::from(
            std::env::var("COVEN_CHAT_SMOKE_READBACK_DIR")
                .expect("Provide the retained native-smoke storage directory."),
        );
        let id = std::env::var("COVEN_CHAT_SMOKE_READBACK_ID")
            .expect("Provide the retained resumed ledger ID.");
        assert!(data.is_absolute());
        validate_id(&id).unwrap();
        let saved = read_session(&data, &id).unwrap();
        let events = saved["events"].as_array().unwrap();
        assert_eq!(saved["session"]["id"], id);
        assert_eq!(saved["hasMore"], false);
        let input_count = events
            .iter()
            .filter(|event| is_captured_input(event))
            .count();
        assert_eq!(input_count, 2);
        for marker in ["COVEN_CHAT_READY", "COVEN_CHAT_RESUMED"] {
            assert_eq!(
                events
                    .iter()
                    .filter(|event| event["type"] == "text_delta"
                        && event["text"]
                            .as_str()
                            .is_some_and(|text| text.trim() == marker))
                    .count(),
                1
            );
        }
        let ids: Vec<&str> = events
            .iter()
            .filter(|event| event["type"] == "system" && event["subtype"] == "init")
            .map(|event| {
                assert_eq!(event["permission"], "read-only");
                string(event, "session_id").unwrap()
            })
            .collect();
        assert_eq!(ids.len(), 2);
        assert_ne!(ids[0], ids[1]);
        assert_eq!(ids[1], id);
        assert_eq!(saved["session"]["conversationId"], ids[0]);
        assert!(!events.iter().any(|event| event["type"]
            .as_str()
            .is_some_and(|kind| kind.starts_with("tool"))));
        println!(
            "Verified retained real model turns, ordered without duplicates: {}",
            ids.join(", ")
        );
    }

    #[cfg(unix)]
    #[test]
    fn execute_command_lines_streams_stdout_and_stderr_then_exit_code() {
        let mut command = Command::new("sh");
        command.args(["-c", "echo one; echo two >&2; printf 'no-newline'; exit 3"]);
        let cancel = AtomicBool::new(false);
        let mut seen: Vec<(bool, String)> = Vec::new();
        let code = execute_command_lines(
            command,
            &cancel,
            Duration::from_secs(5),
            &mut |stderr, line| {
                seen.push((stderr, line.to_owned()));
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(code, 3);
        assert!(seen.contains(&(false, "one".to_owned())));
        assert!(seen.contains(&(true, "two".to_owned())));
        assert!(
            seen.contains(&(false, "no-newline".to_owned())),
            "trailing partial line must flush"
        );
    }

    #[cfg(unix)]
    #[test]
    fn execute_command_lines_honours_cancel() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30"]);
        let cancel = AtomicBool::new(true);
        let error =
            execute_command_lines(command, &cancel, Duration::from_secs(5), &mut |_, _| Ok(()))
                .unwrap_err();
        assert_eq!(error, RUN_CANCELLED);
    }

    #[cfg(unix)]
    #[test]
    fn execute_command_lines_cancel_mid_run_reaps_the_child_promptly() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30"]);
        let cancel = Arc::new(AtomicBool::new(false));
        let flipper = {
            let cancel = Arc::clone(&cancel);
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(150));
                cancel.store(true, Ordering::SeqCst);
            })
        };
        let start = Instant::now();
        let error = execute_command_lines(
            command,
            &cancel,
            Duration::from_secs(30),
            &mut |_, _| Ok(()),
        )
        .unwrap_err();
        flipper.join().unwrap();
        assert_eq!(error, RUN_CANCELLED);
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "cancellation must return promptly, not wait for the child's own exit"
        );
    }

    #[cfg(unix)]
    #[test]
    fn execute_command_lines_returns_zero_for_success_and_keeps_tabs() {
        let mut command = Command::new("sh");
        command.args(["-c", "printf 'a\\tb\\n'"]);
        let cancel = AtomicBool::new(false);
        let mut seen = Vec::new();
        let code =
            execute_command_lines(command, &cancel, Duration::from_secs(5), &mut |_, line| {
                seen.push(line.to_owned());
                Ok(())
            })
            .unwrap();
        assert_eq!(code, 0);
        assert_eq!(seen, vec!["a\tb".to_owned()]);
    }
}
