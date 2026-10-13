//! First-run readiness: what a person still needs before Chat can hold a
//! conversation. Each piece is detected, never assumed, and every check is
//! read-only. Nothing here installs software, signs in, or writes to Coven's
//! home; the window shows what is missing and how to add it.

use std::{
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde_json::{json, Value};
use tauri::ipc::Channel;

use crate::coven_runtime::{
    blocking, cli_json, execute_command_lines, home, resolve_cli, run_process, tool_search_path,
    READ_TIMEOUT,
};

/// Sign-in probes start other programs (`claude`, the engine). A probe that
/// takes longer than this reports "unknown" rather than holding up setup.
const PROBE_TIMEOUT: Duration = Duration::from_secs(15);
/// More than any status report needs; the rest is dropped, not buffered.
const PROBE_OUTPUT_LIMIT: usize = 64 * 1024;
/// Anthropic's documented native installer for Claude Code. The window shows
/// it for the person to run; Chat never runs it.
const CLAUDE_INSTALLER: &str = if cfg!(windows) {
    "irm https://claude.ai/install.ps1 | iex"
} else {
    "curl -fsSL https://claude.ai/install.sh | bash"
};

/// Whether a model provider can be reached through one route.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SignIn {
    SignedIn,
    SignedOut,
    /// The tool the route needs is not installed.
    Missing,
    /// The probe could not tell, for example because it failed or timed out.
    Unknown,
}

impl SignIn {
    fn as_str(self) -> &'static str {
        match self {
            Self::SignedIn => "signed-in",
            Self::SignedOut => "signed-out",
            Self::Missing => "missing",
            Self::Unknown => "unknown",
        }
    }
}

fn supported_platform() -> bool {
    matches!(
        (std::env::consts::OS, std::env::consts::ARCH),
        ("macos", "aarch64") | ("macos", "x86_64") | ("linux", "x86_64") | ("windows", "x86_64")
    )
}

/// Runs a tool with the same PATH Coven gets and returns its exit code and
/// standard output. Standard error is ignored: status commands report there
/// in prose that the window does not show.
fn probe(program: &Path, args: &[&str]) -> Result<(i32, String), String> {
    let mut command = Command::new(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .current_dir(home()?)
        .env("PATH", tool_search_path()?);
    let mut stdout = String::new();
    let code = execute_command_lines(
        command,
        &AtomicBool::new(false),
        PROBE_TIMEOUT,
        &mut |is_stderr, line| {
            if !is_stderr && stdout.len() + line.len() < PROBE_OUTPUT_LIMIT {
                stdout.push_str(line);
                stdout.push('\n');
            }
            Ok(())
        },
    )?;
    Ok((code, stdout))
}

/// `loggedIn` from a JSON status report, as written by both
/// `claude auth status --json` and `coven-code auth status --json`.
fn logged_in(report: &str) -> Option<bool> {
    serde_json::from_str::<Value>(report.trim())
        .ok()?
        .get("loggedIn")?
        .as_bool()
}

fn json_sign_in(program: Option<&Path>, args: &[&str]) -> SignIn {
    let Some(program) = program else {
        return SignIn::Missing;
    };
    match probe(program, args).map(|(_, stdout)| logged_in(&stdout)) {
        Ok(Some(true)) => SignIn::SignedIn,
        Ok(Some(false)) => SignIn::SignedOut,
        Ok(None) | Err(_) => SignIn::Unknown,
    }
}

/// `coven-code codex status` answers with its exit code alone.
fn exit_code_sign_in(program: Option<&Path>, args: &[&str]) -> SignIn {
    let Some(program) = program else {
        return SignIn::Missing;
    };
    match probe(program, args) {
        Ok((0, _)) => SignIn::SignedIn,
        Ok((1, _)) => SignIn::SignedOut,
        _ => SignIn::Unknown,
    }
}

/// Claude Code, found where its installers put it: the PATH Coven gets
/// (which includes `~/.local/bin`, the native installer's home) and the
/// older `~/.claude/local` install.
fn find_claude(search: &std::ffi::OsStr, home: Option<&Path>) -> Option<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["claude.exe", "claude.cmd"]
    } else {
        &["claude"]
    };
    let mut directories: Vec<PathBuf> = std::env::split_paths(search)
        .filter(|path| path.is_absolute())
        .collect();
    if let Some(home) = home {
        directories.push(home.join(".claude").join("local"));
    }
    directories
        .iter()
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .find(|candidate| candidate.is_file())
}

/// The model-provider step is satisfied by any route that is signed in: the
/// engine's own sign-in, a Claude subscription through Claude Code, or
/// ChatGPT through the engine's Codex sign-in.
fn sign_in_report(engine: SignIn, claude: SignIn, chatgpt: SignIn) -> Value {
    let ok = [engine, claude, chatgpt].contains(&SignIn::SignedIn);
    json!({
        "ok": ok,
        "engine": engine.as_str(),
        "claude": claude.as_str(),
        "chatgpt": chatgpt.as_str(),
        "claudeInstaller": CLAUDE_INSTALLER,
    })
}

fn check() -> Result<Value, String> {
    if !supported_platform() {
        return Ok(json!({
            "platform": { "ok": false, "os": std::env::consts::OS },
            "coven": { "ok": false },
            "engine": { "ok": false },
            "signIn": sign_in_report(SignIn::Unknown, SignIn::Unknown, SignIn::Unknown),
            "familiar": { "ok": false, "count": 0 },
        }));
    }
    let claude = json_sign_in(
        tool_search_path()
            .ok()
            .and_then(|search| find_claude(&search, home().ok().as_deref()))
            .as_deref(),
        &["auth", "status", "--json"],
    );
    if resolve_cli().is_err() {
        return Ok(json!({
            "platform": { "ok": true, "os": std::env::consts::OS },
            "coven": { "ok": false },
            "engine": { "ok": false },
            "signIn": sign_in_report(SignIn::Missing, claude, SignIn::Missing),
            "familiar": { "ok": false, "count": 0 },
        }));
    }
    let version = run_process(
        &["--version".into()],
        None,
        &AtomicBool::new(false),
        READ_TIMEOUT,
        None,
    )
    .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_owned())
    .ok()
    .filter(|version| !version.is_empty() && version.len() <= 256);
    let engine_status = cli_json(&["engine", "status", "--json"]).ok();
    let engine_installed = engine_status
        .as_ref()
        .and_then(|status| status.get("installed"))
        .and_then(Value::as_bool)
        == Some(true);
    let engine_path = engine_status
        .as_ref()
        .filter(|_| engine_installed)
        .and_then(|status| status.get("path"))
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .filter(|path| path.is_absolute() && path.is_file());
    // Ask the engine directly, as `coven run` starts it, so the answer reflects
    // the sign-in a chat run will actually use.
    let engine = json_sign_in(engine_path.as_deref(), &["auth", "status", "--json"]);
    let chatgpt = exit_code_sign_in(engine_path.as_deref(), &["codex", "status"]);
    let familiars = cli_json(&["familiars", "--json"])
        .ok()
        .and_then(|value| value.as_array().map(Vec::len));
    let mut coven = json!({ "ok": true });
    if let Some(version) = version {
        coven["version"] = Value::String(version);
    }
    Ok(json!({
        "platform": { "ok": true, "os": std::env::consts::OS },
        "coven": coven,
        "engine": { "ok": engine_installed },
        "signIn": sign_in_report(engine, claude, chatgpt),
        "familiar": {
            "ok": familiars.is_some_and(|count| count > 0),
            "count": familiars.unwrap_or(0),
        },
    }))
}

/// Reports each setup step as `{ ok, ... }`. Read-only: it starts Coven and
/// the sign-in tools only to ask for their status.
#[tauri::command]
pub(crate) async fn setup_check() -> Result<Value, String> {
    blocking(check).await
}

/// `coven engine install` downloads and verifies the engine; give it time.
const ENGINE_INSTALL_TIMEOUT: Duration = Duration::from_secs(20 * 60);
/// A progress line is shown, not stored; longer lines are cut.
const LINE_LIMIT: usize = 512;

/// The one setup run allowed at a time, with its cancellation flag.
static ACTIVE_RUN: Mutex<Option<(String, Arc<AtomicBool>)>> = Mutex::new(None);

/// Clears `ACTIVE_RUN` when the run ends, however it ends.
struct ActiveRun(String);

impl ActiveRun {
    fn start(run_id: &str) -> Result<(Self, Arc<AtomicBool>), String> {
        let mut active = ACTIVE_RUN
            .lock()
            .map_err(|_| "Setup is unavailable. Restart Coven Chat.")?;
        if active.is_some() {
            return Err("Another setup step is still running.".into());
        }
        let cancel = Arc::new(AtomicBool::new(false));
        *active = Some((run_id.to_owned(), cancel.clone()));
        Ok((Self(run_id.to_owned()), cancel))
    }
}

impl Drop for ActiveRun {
    fn drop(&mut self) {
        if let Ok(mut active) = ACTIVE_RUN.lock() {
            if active.as_ref().is_some_and(|(id, _)| id == &self.0) {
                *active = None;
            }
        }
    }
}

/// The steps the window may ask for. Each maps to a fixed action: no string
/// from the window reaches a download address, a path or a command line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SetupStep {
    InstallCoven,
    InstallEngine,
}

impl SetupStep {
    fn parse(step: &str) -> Result<Self, String> {
        match step {
            "install_coven" => Ok(Self::InstallCoven),
            "install_engine" => Ok(Self::InstallEngine),
            _ => Err("Unknown setup step.".into()),
        }
    }
}

fn shown_line(line: &str) -> String {
    line.chars()
        .filter(|c| !c.is_control())
        .take(LINE_LIMIT)
        .collect::<String>()
        .trim()
        .to_owned()
}

/// Runs `coven engine install`, passing each line of its output to `on_event`
/// as `{ type: "line", text }`.
fn install_engine(
    cancel: &AtomicBool,
    on_event: &mut dyn FnMut(Value) -> Result<(), String>,
) -> Result<Value, String> {
    let mut command = Command::new(resolve_cli()?);
    command
        .args(["engine", "install"])
        .stdin(Stdio::null())
        .current_dir(home()?)
        .env("PATH", tool_search_path()?);
    let mut last = String::new();
    let code = execute_command_lines(command, cancel, ENGINE_INSTALL_TIMEOUT, &mut |_, line| {
        let text = shown_line(line);
        if text.is_empty() {
            return Ok(());
        }
        last.clone_from(&text);
        on_event(json!({ "type": "line", "text": text }))
    })?;
    if code != 0 {
        return Err(if last.is_empty() {
            "The engine could not be installed. Try again.".to_owned()
        } else {
            format!("The engine could not be installed: {last}")
        });
    }
    Ok(json!({ "installed": true }))
}

/// Runs one setup step, streaming progress to `on_event`. Only one step runs
/// at a time; `setup_cancel` with the same `run_id` stops it.
#[tauri::command]
pub(crate) async fn setup_run(
    run_id: String,
    step: String,
    on_event: Channel<Value>,
) -> Result<Value, String> {
    crate::coven_runtime::validate_id(&run_id)?;
    let step = SetupStep::parse(&step)?;
    let (registration, cancel) = ActiveRun::start(&run_id)?;
    let result = match step {
        SetupStep::InstallCoven => {
            let mut send = |event: Value| {
                on_event
                    .send(event)
                    .map_err(|_| "The setup window closed.".to_owned())
            };
            crate::coven_install::install(&cancel, &mut send).await
        }
        SetupStep::InstallEngine => {
            let cancel = cancel.clone();
            blocking(move || {
                install_engine(&cancel, &mut |event| {
                    on_event
                        .send(event)
                        .map_err(|_| "The setup window closed.".to_owned())
                })
            })
            .await
        }
    };
    drop(registration);
    result
}

/// Stops the setup run with this `run_id`, if it is still running.
#[tauri::command]
pub(crate) fn setup_cancel(run_id: String) -> Result<(), String> {
    crate::coven_runtime::validate_id(&run_id)?;
    let active = ACTIVE_RUN
        .lock()
        .map_err(|_| "Setup is unavailable. Restart Coven Chat.")?;
    match active.as_ref() {
        Some((id, cancel)) if id == &run_id => {
            cancel.store(true, Ordering::SeqCst);
            Ok(())
        }
        _ => Err("No setup step matches this identifier.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_steps_are_a_fixed_set() {
        assert_eq!(
            SetupStep::parse("install_coven"),
            Ok(SetupStep::InstallCoven)
        );
        assert_eq!(
            SetupStep::parse("install_engine"),
            Ok(SetupStep::InstallEngine)
        );
        for step in ["", "install", "INSTALL_COVEN", "install_coven ", "rm -rf"] {
            assert!(SetupStep::parse(step).is_err(), "{step:?}");
        }
    }

    #[test]
    fn one_setup_run_at_a_time_and_cancel_matches_its_id() {
        let (first, cancel) = ActiveRun::start("run-one").unwrap();
        assert_eq!(
            ActiveRun::start("run-two").err().as_deref(),
            Some("Another setup step is still running.")
        );
        assert!(setup_cancel("run-two".into()).is_err());
        setup_cancel("run-one".into()).unwrap();
        assert!(cancel.load(Ordering::SeqCst));
        drop(first);
        let (second, _) = ActiveRun::start("run-two").unwrap();
        drop(second);
        assert!(setup_cancel("run-two".into()).is_err());
    }

    #[test]
    fn shown_lines_are_bounded_and_plain() {
        assert_eq!(
            shown_line("  \u{1b}[32mDownloading\u{1b}[0m 40%\r "),
            "[32mDownloading[0m 40%"
        );
        assert_eq!(shown_line(&"x".repeat(5000)).len(), LINE_LIMIT);
    }

    #[test]
    fn logged_in_reads_only_the_json_flag() {
        assert_eq!(
            logged_in("{\"loggedIn\": true, \"email\": \"x\"}"),
            Some(true)
        );
        assert_eq!(logged_in("\n{\n  \"loggedIn\": false\n}\n"), Some(false));
        assert_eq!(logged_in("{\"loggedIn\": \"yes\"}"), None);
        assert_eq!(logged_in("Logged in as someone"), None);
        assert_eq!(logged_in(""), None);
    }

    #[test]
    fn any_signed_in_route_satisfies_the_sign_in_step() {
        let report = sign_in_report(SignIn::SignedOut, SignIn::SignedIn, SignIn::Missing);
        assert_eq!(report["ok"], json!(true));
        assert_eq!(report["claude"], json!("signed-in"));
        assert_eq!(report["chatgpt"], json!("missing"));
        assert_eq!(report["claudeInstaller"], json!(CLAUDE_INSTALLER));
        let report = sign_in_report(SignIn::SignedOut, SignIn::Unknown, SignIn::SignedOut);
        assert_eq!(report["ok"], json!(false));
        assert_eq!(report["claude"], json!("unknown"));
    }

    #[test]
    fn find_claude_checks_the_search_path_then_the_legacy_install() {
        let root = std::env::temp_dir().join(format!("opencoven-claude-{}", uuid::Uuid::new_v4()));
        let name = if cfg!(windows) {
            "claude.exe"
        } else {
            "claude"
        };
        let first = root.join("first");
        let second = root.join("second");
        let home = root.join("home");
        let legacy = home.join(".claude").join("local");
        for directory in [&first, &second, &legacy] {
            std::fs::create_dir_all(directory).unwrap();
        }
        let search = std::env::join_paths([&first, &second]).unwrap();
        assert_eq!(find_claude(&search, Some(&home)), None);
        std::fs::write(legacy.join(name), "").unwrap();
        assert_eq!(find_claude(&search, Some(&home)), Some(legacy.join(name)));
        std::fs::write(second.join(name), "").unwrap();
        assert_eq!(find_claude(&search, Some(&home)), Some(second.join(name)));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn probes_report_sign_in_from_json_and_exit_codes() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("opencoven-probe-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let script = |name: &str, body: &str| {
            let path = root.join(name);
            std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
            path
        };
        let signed_in = script("in", "echo '{\"loggedIn\": true}'; echo noise >&2");
        let signed_out = script("out", "echo '{\"loggedIn\": false}'; exit 1");
        let garbled = script("garbled", "echo 'not json'");
        let codex_out = script("codex-out", "exit 1");
        let codex_broken = script("codex-broken", "exit 7");
        let args = ["auth", "status", "--json"];
        assert_eq!(json_sign_in(Some(&signed_in), &args), SignIn::SignedIn);
        assert_eq!(json_sign_in(Some(&signed_out), &args), SignIn::SignedOut);
        assert_eq!(json_sign_in(Some(&garbled), &args), SignIn::Unknown);
        assert_eq!(json_sign_in(None, &args), SignIn::Missing);
        assert_eq!(exit_code_sign_in(Some(&signed_in), &[]), SignIn::SignedIn);
        assert_eq!(exit_code_sign_in(Some(&codex_out), &[]), SignIn::SignedOut);
        assert_eq!(exit_code_sign_in(Some(&codex_broken), &[]), SignIn::Unknown);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
