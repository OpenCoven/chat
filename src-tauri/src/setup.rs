//! First-run readiness: what a person still needs before Chat can hold a
//! conversation. Each piece is detected, never assumed, and every check is
//! read-only. Nothing here installs software, signs in, or writes to Coven's
//! home; the window shows what is missing and how to add it.
//!
//! An engine counts only when it is new enough ([`ENGINE_VERSION`]). Coven
//! keeps running the engine it already has when Coven itself is updated, so
//! "an engine is installed" says nothing about which one. An older engine,
//! or one whose version cannot be read, holds the chat back until it is
//! updated; `coven_runtime_status` applies the same rule.

use std::{
    path::{Path, PathBuf},
    process::Stdio,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use serde_json::{json, Value};
use tauri::ipc::Channel;

use crate::coven_runtime::{
    blocking, child_env, cli_json, execute_command_lines, home, resolve_cli, run_process,
    tool_search_path, READ_TIMEOUT,
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

/// The oldest engine Chat runs familiars on, and the one it installs when
/// Coven's own choice is older. Engines before 0.9.3 cannot take a finite
/// model-round budget: Coven checks the engine before every Coven Code send,
/// and refuses the send when it can't. Engines before 0.9.1 also start a
/// familiar that is signed in with Claude without the access Chat asked for,
/// and lack 0.9.1's security fixes. Moving this means updating every digest
/// in [`engine_archive_sha256`] from that engine release's `SHA256SUMS`.
const ENGINE_VERSION: &str = "0.9.3";

/// SHA-256 of the [`ENGINE_VERSION`] release archive `coven engine install`
/// downloads for a platform. Coven refuses an archive that does not match.
fn engine_archive_sha256(os: &str, arch: &str) -> Option<&'static str> {
    match (os, arch) {
        ("macos", "aarch64") => {
            Some("a433f3e5766c328c4e57699166fee9043e8d59aba5671797e0906f6cac3b1a5f")
        }
        ("macos", "x86_64") => {
            Some("5977f2ef4eb151bb99f1e1ec690d65a8955b4cdc4c8ac2b31cccf8f513ce0b65")
        }
        ("linux", "x86_64") => {
            Some("e559d79685b60fb84dc4cbc3e75166f15c7301867eeb69306867bbd3ae306db0")
        }
        ("windows", "x86_64") => {
            Some("4ee43d3d2f53437b5ba81a481f4a2781329ec57368789be603a96edcd79ddaf3")
        }
        _ => None,
    }
}

/// The leading `major.minor.patch` of a version, whatever follows it:
/// "0.9.1", "v0.9.1" and "0.9.1-4-gabc123" all read as (0, 9, 1).
fn version_triple(version: &str) -> Option<(u64, u64, u64)> {
    let mut parts = version.trim().trim_start_matches('v').splitn(3, '.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch: String = parts
        .next()?
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    Some((major, minor, patch.parse().ok()?))
}

/// Whether `version` is at least [`ENGINE_VERSION`]. `None` when it cannot be
/// read as a version.
fn new_enough(version: &str) -> Option<bool> {
    Some(version_triple(version)? >= version_triple(ENGINE_VERSION)?)
}

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
    let mut command = child_env::command(program);
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

/// Claude Code, if it is installed where Chat can find it.
pub(crate) fn claude_path() -> Option<PathBuf> {
    tool_search_path()
        .ok()
        .and_then(|search| find_claude(&search, home().ok().as_deref()))
}

/// Shown where an older engine stops a chat outside the setup screen.
const ENGINE_OUTDATED: &str = "The Coven engine on this computer is older than Coven Chat needs. Quit and reopen Coven Chat, then choose Update the engine.";
/// An engine named by `COVEN_ENGINE_BIN` wins over any engine Coven installs,
/// so installing one would change nothing. The person who set it must act.
const ENGINE_OVERRIDE_OUTDATED: &str = "COVEN_ENGINE_BIN points to an engine older than Coven Chat needs. Update that engine or remove the variable, then reopen Coven Chat.";

/// What `coven engine status` says about the engine Coven would start.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct Engine {
    /// The installed engine executable.
    path: Option<PathBuf>,
    /// The version that executable reports. Coven says "unknown" when the
    /// engine would not tell it.
    version: Option<String>,
    /// The version a plain `coven engine install` would install.
    pin: Option<String>,
    /// `COVEN_ENGINE_BIN` chose this engine.
    overridden: bool,
}

impl Engine {
    pub(crate) fn read(status: &Value) -> Self {
        let text = |key: &str| {
            status
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty() && value.len() <= 64)
                .map(str::to_owned)
        };
        let installed = status.get("installed").and_then(Value::as_bool) == Some(true);
        let path = installed
            .then(|| status.get("path").and_then(Value::as_str))
            .flatten()
            .map(PathBuf::from)
            .filter(|path| path.is_absolute() && path.is_file());
        Self {
            version: path.as_ref().and_then(|_| text("version")),
            overridden: path.is_some()
                && text("source").is_some_and(|source| source.starts_with("COVEN_ENGINE_BIN")),
            path,
            pin: text("pin"),
        }
    }

    pub(crate) fn installed(&self) -> bool {
        self.path.is_some()
    }

    /// Installed and known to be new enough to run familiars.
    fn ready(&self) -> bool {
        self.installed() && self.version.as_deref().and_then(new_enough) == Some(true)
    }

    /// Installed, but older than Chat needs or of a version Chat cannot
    /// read. Either way Chat cannot say familiars get the access it asks for.
    fn outdated(&self) -> bool {
        self.installed() && !self.ready()
    }

    /// Why an installed engine cannot run a chat, for the chat window.
    /// `None` when it can, or when no engine is installed: a missing engine
    /// has its own message there.
    pub(crate) fn problem(&self) -> Option<&'static str> {
        match (self.outdated(), self.overridden) {
            (false, _) => None,
            (true, true) => Some(ENGINE_OVERRIDE_OUTDATED),
            (true, false) => Some(ENGINE_OUTDATED),
        }
    }

    /// The arguments to `coven` that install an engine Chat can use. Coven's
    /// own choice when that is new enough, so a newer Coven is never taken
    /// back to an older engine; otherwise [`ENGINE_VERSION`] with its digest.
    fn install_args(&self, os: &str, arch: &str) -> Result<Vec<String>, String> {
        let mut args = vec!["engine".to_owned(), "install".to_owned()];
        if self.pin.as_deref().and_then(new_enough) != Some(true) {
            let sha256 = engine_archive_sha256(os, arch)
                .ok_or("Coven Chat cannot install the engine on this computer.")?;
            args.extend(["--version", ENGINE_VERSION, "--sha256", sha256].map(str::to_owned));
        }
        Ok(args)
    }

    /// What the engine step runs: nothing for an engine that is already new
    /// enough, an install otherwise, and a refusal when `COVEN_ENGINE_BIN`
    /// chose the older engine, which would still win after any install.
    fn install_plan(&self, os: &str, arch: &str) -> Result<Option<Vec<String>>, String> {
        if self.ready() {
            return Ok(None);
        }
        if self.overridden {
            return Err(ENGINE_OVERRIDE_OUTDATED.into());
        }
        self.install_args(os, arch).map(Some)
    }

    /// The engine step's answer once `coven engine install` has finished,
    /// read from the status Coven reports afterwards. An install that
    /// succeeded but left Coven starting something else is a failure the
    /// person must hear about, not a step that quietly comes back.
    fn installed_outcome(&self) -> Result<Value, String> {
        if self.ready() {
            return Ok(json!({ "installed": true }));
        }
        let found = if !self.installed() {
            "finds no engine".to_owned()
        } else if let Some(version) = self
            .version
            .as_ref()
            .filter(|v| version_triple(v).is_some())
        {
            format!("starts engine {version}")
        } else {
            "starts an engine whose version Chat cannot read".to_owned()
        };
        Err(format!(
            "The engine install finished, but Coven still {found}. Coven Chat needs {ENGINE_VERSION} or newer. Run coven engine status in a terminal to see which engine Coven starts and where it comes from."
        ))
    }

    fn report(&self, os: &str, arch: &str) -> Value {
        let mut report = json!({
            "ok": self.ready(),
            "installed": self.installed(),
            "required": ENGINE_VERSION,
        });
        // Only a version a person can compare with `required`.
        if let Some(version) = self
            .version
            .as_ref()
            .filter(|v| version_triple(v).is_some())
        {
            report["version"] = Value::String(version.clone());
        }
        if self.outdated() && self.overridden {
            // Nothing Chat installs would be used, so it offers no command.
            report["override"] = json!(true);
        } else if let Ok(args) = self.install_args(os, arch) {
            report["command"] = Value::String(format!("coven {}", args.join(" ")));
        }
        report
    }
}

fn engine_status() -> Engine {
    cli_json(&["engine", "status", "--json"])
        .map(|status| Engine::read(&status))
        .unwrap_or_default()
}

/// The installed engine executable, as `coven engine status` reports it.
fn engine_path() -> Option<PathBuf> {
    engine_status().path
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

/// `coven --version` without its parenthetical status, which the setup
/// steps already report in their own words: "coven 0.4.9 (engine not
/// installed, pinned 0.8.0)" becomes "coven 0.4.9".
fn shown_version(output: &str) -> String {
    let first = output.lines().next().unwrap_or_default();
    first
        .split(" (")
        .next()
        .unwrap_or_default()
        .trim()
        .to_owned()
}

/// The Coven step for an installed Coven. It is ready only when it can give
/// Coven Code a run budget, since every Coven Code send asks for one; an
/// older Coven (0.4.10, from Chat v0.1.3, say) is offered the update.
/// `shadow` is a copy that Chat's install would not replace: then the person
/// has to update that copy, so the report names it.
fn coven_report(takes_budgets: bool, shadow: Option<&Path>) -> Value {
    let mut coven = json!({
        "ok": takes_budgets,
        "installed": true,
        "required": crate::coven_install::COVEN_VERSION,
    });
    if !takes_budgets {
        if let Some(path) = shadow
            .and_then(Path::to_str)
            .filter(|path| path.len() <= 1024)
        {
            coven["path"] = Value::String(path.to_owned());
        }
    }
    coven
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
    let claude = json_sign_in(claude_path().as_deref(), &["auth", "status", "--json"]);
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
    .map(|bytes| shown_version(&String::from_utf8_lossy(&bytes)))
    .ok()
    .filter(|version| !version.is_empty() && version.len() <= 256);
    let installed_engine = engine_status();
    let engine_path = installed_engine.path.as_deref();
    // Ask the engine directly, as `coven run` starts it, so the answer reflects
    // the sign-in a chat run will actually use.
    let engine = json_sign_in(engine_path, &["auth", "status", "--json"]);
    let chatgpt = exit_code_sign_in(engine_path, &["codex", "status"]);
    let familiars = cli_json(&["familiars", "--json"])
        .ok()
        .and_then(|value| value.as_array().map(Vec::len));
    let mut coven = coven_report(
        crate::coven_runtime::cli_takes_run_budgets(),
        crate::coven_runtime::cli_shadowing_install().as_deref(),
    );
    if let Some(version) = version {
        coven["version"] = Value::String(version);
    }
    Ok(json!({
        "platform": { "ok": true, "os": std::env::consts::OS },
        "coven": coven,
        "engine": installed_engine.report(std::env::consts::OS, std::env::consts::ARCH),
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
    SignInClaude,
    SignInChatgpt,
}

impl SetupStep {
    fn parse(step: &str) -> Result<Self, String> {
        match step {
            "install_coven" => Ok(Self::InstallCoven),
            "install_engine" => Ok(Self::InstallEngine),
            "sign_in_claude" => Ok(Self::SignInClaude),
            "sign_in_chatgpt" => Ok(Self::SignInChatgpt),
            _ => Err("Unknown setup step.".into()),
        }
    }
}

/// The first web address in a line of output, for a sign-in link the tool
/// prints in case it could not open the browser itself.
fn link_in(line: &str) -> Option<&str> {
    let start = line.find("https://")?;
    let link = line[start..]
        .split(char::is_whitespace)
        .next()?
        .trim_end_matches(['.', ',', ')', ']', '>', '"', '\'']);
    (link.len() > "https://".len()
        && link.len() <= 2048
        && link.chars().all(|c| c.is_ascii_graphic()))
    .then_some(link)
}

fn shown_line(line: &str) -> String {
    line.chars()
        .filter(|c| !c.is_control())
        .take(LINE_LIMIT)
        .collect::<String>()
        .trim()
        .to_owned()
}

/// Sign-in waits for the person to finish in their browser.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(10 * 60);

/// Runs `program args`, passing each line of its output to `on_event` as
/// `{ type: "line", text }`, and returns the last line for a failure message.
fn stream_tool(
    program: &Path,
    args: &[&str],
    timeout: Duration,
    cancel: &AtomicBool,
    on_event: &mut dyn FnMut(Value) -> Result<(), String>,
) -> Result<(i32, String), String> {
    let mut command = child_env::command(program);
    command
        .args(args)
        .stdin(Stdio::null())
        .current_dir(home()?)
        .env("PATH", tool_search_path()?);
    let mut last = String::new();
    let code = execute_command_lines(command, cancel, timeout, &mut |_, line| {
        let text = shown_line(line);
        if text.is_empty() {
            return Ok(());
        }
        last.clone_from(&text);
        if let Some(link) = link_in(&text) {
            on_event(json!({ "type": "link", "url": link }))?;
        }
        on_event(json!({ "type": "line", "text": text }))
    })?;
    Ok((code, last))
}

fn failed(what: &str, last: &str) -> String {
    if last.is_empty() {
        format!("{what} did not finish. Try again.")
    } else {
        format!("{what} did not finish: {last}")
    }
}

/// Runs `coven engine install` for an engine Chat can use, replacing one that
/// is missing or too old. An engine that is already new enough is left alone:
/// installing over it could put an older one in its place. So is an older
/// one chosen by `COVEN_ENGINE_BIN`, which would still win afterwards.
fn install_engine(
    cancel: &AtomicBool,
    on_event: &mut dyn FnMut(Value) -> Result<(), String>,
) -> Result<Value, String> {
    let Some(args) = engine_status().install_plan(std::env::consts::OS, std::env::consts::ARCH)?
    else {
        return Ok(json!({ "installed": true }));
    };
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let (code, last) = stream_tool(
        &resolve_cli()?,
        &args,
        ENGINE_INSTALL_TIMEOUT,
        cancel,
        on_event,
    )?;
    if code != 0 {
        return Err(failed("The engine install", &last));
    }
    // Coven decides which engine it starts. Ask it again rather than take
    // the install's word for it.
    engine_status().installed_outcome()
}

/// Starts a provider's own browser sign-in and waits for the person to
/// finish it. The tool opens the browser itself and prints a link to use if
/// it could not, which reaches the window as a line.
fn sign_in(
    step: SetupStep,
    cancel: &AtomicBool,
    on_event: &mut dyn FnMut(Value) -> Result<(), String>,
) -> Result<Value, String> {
    let (program, args, what): (PathBuf, &[&str], &str) = match step {
        SetupStep::SignInClaude => (
            claude_path().ok_or("Install Claude Code first, then choose Check again.")?,
            &["auth", "login", "--claudeai"],
            "Signing in with Claude",
        ),
        SetupStep::SignInChatgpt => (
            engine_path().ok_or("Install the engine first.")?,
            &["codex", "login"],
            "Signing in with ChatGPT",
        ),
        _ => return Err("Unknown setup step.".into()),
    };
    let (code, last) = stream_tool(&program, args, SIGN_IN_TIMEOUT, cancel, on_event)?;
    if code != 0 {
        return Err(failed(what, &last));
    }
    Ok(json!({ "signedIn": true }))
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
        SetupStep::InstallEngine | SetupStep::SignInClaude | SetupStep::SignInChatgpt => {
            let cancel = cancel.clone();
            blocking(move || {
                let mut send = |event: Value| {
                    on_event
                        .send(event)
                        .map_err(|_| "The setup window closed.".to_owned())
                };
                if step == SetupStep::InstallEngine {
                    install_engine(&cancel, &mut send)
                } else {
                    sign_in(step, &cancel, &mut send)
                }
            })
            .await
        }
    };
    drop(registration);
    result
}

/// The longest familiar name setup accepts.
const FAMILIAR_NAME_LIMIT: usize = 64;

/// The one value from the window that reaches a command: a familiar's name.
/// It must be a short line of text with a letter or number in it, and it is
/// passed to Coven as a single argument after `--`, never parsed as a flag.
fn familiar_name(name: &str) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give your familiar a name.".into());
    }
    if name.chars().count() > FAMILIAR_NAME_LIMIT {
        return Err(format!(
            "Keep the name to {FAMILIAR_NAME_LIMIT} characters or fewer."
        ));
    }
    if name.chars().any(char::is_control) {
        return Err("Use one line of text for the name.".into());
    }
    if !name.chars().any(|c| c.is_ascii_alphanumeric()) {
        return Err("Use at least one letter or number in the name.".into());
    }
    Ok(name.to_owned())
}

/// Coven's `familiars create --json` answer, in words a person can act on.
fn created_familiar(code: i32, stdout: &str) -> Result<Value, String> {
    let Ok(answer) = serde_json::from_str::<Value>(stdout.trim()) else {
        return Err(
            "This version of Coven cannot create familiars yet. Update Coven, then try again."
                .into(),
        );
    };
    if code == 0 && answer.get("created").and_then(Value::as_bool) == Some(true) {
        let id = answer.get("id").and_then(Value::as_str).unwrap_or_default();
        let name = answer
            .get("displayName")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if id.is_empty() || name.is_empty() {
            return Err("Coven returned an invalid familiar.".into());
        }
        return Ok(json!({ "id": id, "displayName": name }));
    }
    Err(match answer
        .pointer("/error/code")
        .and_then(Value::as_str)
        .unwrap_or_default()
    {
        "familiar_exists" => "You already have a familiar with that name. Choose another name.",
        "invalid_id" | "invalid_argument" => "Use letters or numbers in the name, then try again.",
        "roster_invalid" => {
            "Coven's list of familiars has a problem, so nothing was added. Fix it, then try again."
        }
        "roster_changed" => "Your familiars changed at the same moment. Try again.",
        _ => "The familiar could not be created. Try again.",
    }
    .into())
}

fn create_familiar(name: &str) -> Result<Value, String> {
    let name = familiar_name(name)?;
    let (code, stdout) = probe(
        &resolve_cli()?,
        &["familiars", "create", "--json", "--", &name],
    )?;
    created_familiar(code, &stdout)
}

/// Creates a familiar named `name` through Coven, which owns the roster.
#[tauri::command]
pub(crate) async fn setup_create_familiar(name: String) -> Result<Value, String> {
    blocking(move || create_familiar(&name)).await
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
    fn a_coven_without_run_budgets_is_offered_the_update() {
        let ready = coven_report(true, Some(Path::new("/elsewhere/coven")));
        assert_eq!(ready["ok"], true);
        assert_eq!(ready["required"], crate::coven_install::COVEN_VERSION);
        assert!(ready.get("path").is_none(), "a ready Coven needs no path");

        let ours = coven_report(false, None);
        assert_eq!(ours["ok"], false);
        assert_eq!(ours["installed"], true);
        assert!(ours.get("path").is_none());

        let shadowed = coven_report(
            false,
            Some(Path::new("/home/val/.local/lib/node_modules/coven")),
        );
        assert_eq!(shadowed["ok"], false);
        assert_eq!(shadowed["path"], "/home/val/.local/lib/node_modules/coven");
    }

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

    fn engine(version: Option<&str>, pin: Option<&str>) -> Engine {
        Engine {
            // Any path stands for "installed"; these tests never start it.
            path: version.map(|_| PathBuf::from("/engine/coven-code")),
            version: version.map(str::to_owned),
            pin: pin.map(str::to_owned),
            overridden: false,
        }
    }

    #[test]
    fn versions_compare_by_their_leading_numbers() {
        for (version, triple) in [
            ("0.9.1", Some((0, 9, 1))),
            ("v0.9.1\n", Some((0, 9, 1))),
            ("0.10.0", Some((0, 10, 0))),
            ("0.9.1-4-gabc123", Some((0, 9, 1))),
            ("1.0.0+build", Some((1, 0, 0))),
            ("0.9", None),
            ("0.9.x", None),
            ("latest", None),
            ("", None),
        ] {
            assert_eq!(version_triple(version), triple, "{version:?}");
        }
        // 0.10.0 is newer than 0.9.3: compared as numbers, not as text.
        assert_eq!(new_enough("0.10.0"), Some(true));
        assert_eq!(new_enough(ENGINE_VERSION), Some(true));
        // 0.9.2 and 0.9.1 can't take a run budget.
        assert_eq!(new_enough("0.9.2"), Some(false));
        assert_eq!(new_enough("0.9.1"), Some(false));
        assert_eq!(new_enough("0.9.0"), Some(false));
        assert_eq!(new_enough("0.8.0"), Some(false));
        assert_eq!(new_enough("unknown"), None);
    }

    #[test]
    fn an_engine_older_than_chat_needs_is_installed_but_not_ready() {
        let old = engine(Some("0.9.0"), Some("0.9.0"));
        assert!(old.installed() && old.outdated() && !old.ready());
        assert_eq!(old.problem(), Some(ENGINE_OUTDATED));
        let report = old.report("macos", "aarch64");
        assert_eq!(report["ok"], json!(false));
        assert_eq!(report["installed"], json!(true));
        assert_eq!(report["version"], json!("0.9.0"));
        assert_eq!(report["required"], json!(ENGINE_VERSION));

        for version in [ENGINE_VERSION, "0.9.4", "0.10.0", "1.0.0"] {
            let current = engine(Some(version), Some("0.9.0"));
            assert!(current.ready() && !current.outdated(), "{version}");
            assert_eq!(current.problem(), None);
            assert_eq!(current.report("macos", "aarch64")["ok"], json!(true));
        }

        // Coven says "unknown" when the engine would not give a version.
        // Chat cannot vouch for that engine, so it is held back like an old
        // one, and the report carries no version to compare.
        for version in ["unknown", "dev build"] {
            let unread = engine(Some(version), Some("0.9.0"));
            assert!(unread.outdated() && !unread.ready(), "{version}");
            assert_eq!(unread.problem(), Some(ENGINE_OUTDATED));
            let report = unread.report("macos", "aarch64");
            assert_eq!(report["ok"], json!(false));
            assert_eq!(report["installed"], json!(true));
            assert!(report.get("version").is_none());
            assert!(report["command"].as_str().unwrap().contains("--sha256"));
        }

        // A missing engine is not an outdated one: it has its own step.
        let missing = engine(None, Some("0.9.0"));
        assert!(!missing.installed() && !missing.outdated() && !missing.ready());
        assert_eq!(missing.problem(), None);
        let report = missing.report("macos", "aarch64");
        assert_eq!(report["ok"], json!(false));
        assert_eq!(report["installed"], json!(false));
        assert!(report.get("version").is_none());
    }

    #[test]
    fn the_engine_install_names_chats_version_only_when_covens_is_older() {
        let digest = engine_archive_sha256("macos", "aarch64").unwrap();
        let explicit = vec![
            "engine",
            "install",
            "--version",
            ENGINE_VERSION,
            "--sha256",
            digest,
        ];
        // Coven 0.4.10 and 0.5.0 choose 0.8.0 and 0.9.0, and a Coven built
        // before the 0.9.3 pin chooses 0.9.2; a Coven that says nothing is
        // treated the same way.
        for pin in [
            Some("0.8.0"),
            Some("0.9.0"),
            Some("0.9.2"),
            Some("unknown"),
            None,
        ] {
            assert_eq!(
                engine(Some("0.9.0"), pin)
                    .install_args("macos", "aarch64")
                    .unwrap(),
                explicit,
                "{pin:?}"
            );
        }
        // A Coven whose own choice is new enough keeps it, so a newer Coven
        // is never taken back to Chat's older version.
        for pin in [ENGINE_VERSION, "0.9.4", "0.10.0"] {
            assert_eq!(
                engine(None, Some(pin))
                    .install_args("macos", "aarch64")
                    .unwrap(),
                ["engine", "install"],
                "{pin}"
            );
        }
        assert_eq!(
            engine(Some("0.9.0"), Some("0.9.0")).report("macos", "aarch64")["command"],
            json!(format!(
                "coven engine install --version {ENGINE_VERSION} --sha256 {digest}"
            ))
        );
        assert_eq!(
            engine(None, Some("0.10.0")).report("linux", "x86_64")["command"],
            json!("coven engine install")
        );
        // The step runs exactly what it shows, and nothing for an engine
        // that is already new enough, whatever Coven would choose.
        let old = engine(Some("0.9.0"), Some("0.9.0"));
        assert_eq!(
            old.install_plan("macos", "aarch64")
                .unwrap()
                .unwrap()
                .join(" "),
            old.report("macos", "aarch64")["command"]
                .as_str()
                .unwrap()
                .trim_start_matches("coven ")
        );
        assert_eq!(
            engine(None, Some("0.9.0")).install_plan("macos", "aarch64"),
            Ok(Some(explicit.iter().map(|arg| (*arg).to_owned()).collect()))
        );
        assert_eq!(
            engine(Some("0.10.0"), Some("0.8.0")).install_plan("macos", "aarch64"),
            Ok(None)
        );
        // No digest, no install: Chat never asks Coven for an unchecked archive.
        let unsupported = engine(None, Some("0.9.0"));
        assert!(unsupported.install_args("linux", "aarch64").is_err());
        assert!(unsupported
            .report("linux", "aarch64")
            .get("command")
            .is_none());
    }

    #[test]
    fn an_older_engine_chosen_by_the_override_is_reported_not_replaced() {
        let chosen = Engine {
            overridden: true,
            ..engine(Some("0.9.0"), Some("0.9.0"))
        };
        assert!(chosen.outdated());
        assert_eq!(chosen.problem(), Some(ENGINE_OVERRIDE_OUTDATED));
        let report = chosen.report("macos", "aarch64");
        assert_eq!(report["ok"], json!(false));
        assert_eq!(report["installed"], json!(true));
        assert_eq!(report["override"], json!(true));
        assert_eq!(report["version"], json!("0.9.0"));
        // Whatever Chat installed would not be the engine Coven starts.
        assert!(report.get("command").is_none());
        assert_eq!(
            chosen.install_plan("macos", "aarch64"),
            Err(ENGINE_OVERRIDE_OUTDATED.to_owned())
        );
        for message in [ENGINE_OVERRIDE_OUTDATED, ENGINE_OUTDATED] {
            assert!(message.contains("older than Coven Chat needs"), "{message}");
        }
        assert!(ENGINE_OVERRIDE_OUTDATED.contains("COVEN_ENGINE_BIN"));
        assert!(ENGINE_OUTDATED.contains("Update the engine"));

        // An override that already points at a usable engine is no fault.
        let fine = Engine {
            overridden: true,
            ..engine(Some(ENGINE_VERSION), Some("0.9.0"))
        };
        assert!(fine.ready());
        assert_eq!(fine.problem(), None);
        assert_eq!(fine.install_plan("macos", "aarch64"), Ok(None));
        let report = fine.report("macos", "aarch64");
        assert_eq!(report["ok"], json!(true));
        assert!(report.get("override").is_none());
    }

    #[test]
    fn an_install_that_did_not_take_says_what_coven_still_starts() {
        assert_eq!(
            engine(Some(ENGINE_VERSION), Some("0.9.0")).installed_outcome(),
            Ok(json!({ "installed": true }))
        );
        assert_eq!(
            engine(Some("0.10.0"), Some("0.10.0")).installed_outcome(),
            Ok(json!({ "installed": true }))
        );
        for (after, found) in [
            (
                engine(Some("0.9.0"), Some("0.9.0")),
                "still starts engine 0.9.0.",
            ),
            (
                engine(Some("unknown"), Some("0.9.0")),
                "still starts an engine whose version Chat cannot read.",
            ),
            (engine(None, Some("0.9.0")), "still finds no engine."),
        ] {
            let message = after.installed_outcome().unwrap_err();
            assert!(
                message.starts_with("The engine install finished, but Coven "),
                "{message}"
            );
            assert!(message.contains(found), "{message}");
            assert!(
                message.contains(&format!("Coven Chat needs {ENGINE_VERSION} or newer.")),
                "{message}"
            );
            assert!(
                message.contains("Run coven engine status in a terminal"),
                "{message}"
            );
        }
    }

    #[test]
    fn every_supported_platform_has_an_engine_digest() {
        let digests: Vec<&str> = [
            ("macos", "aarch64"),
            ("macos", "x86_64"),
            ("linux", "x86_64"),
            ("windows", "x86_64"),
        ]
        .into_iter()
        .map(|(os, arch)| engine_archive_sha256(os, arch).unwrap())
        .collect();
        for digest in &digests {
            assert_eq!(digest.len(), 64);
            assert!(digest
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
        }
        let unique: std::collections::HashSet<_> = digests.iter().collect();
        assert_eq!(unique.len(), digests.len());
        assert_eq!(engine_archive_sha256("linux", "aarch64"), None);
    }

    #[test]
    fn engine_status_is_read_from_covens_report() {
        let here = std::env::current_exe().unwrap();
        let status = json!({
            "installed": true,
            "path": here,
            "pin": "0.9.0",
            "source": "managed (~/.coven/engine)",
            "version": " 0.9.0 ",
        });
        assert_eq!(
            Engine::read(&status),
            Engine {
                path: Some(here.clone()),
                version: Some("0.9.0".into()),
                pin: Some("0.9.0".into()),
                overridden: false,
            }
        );
        // Coven 0.4.10, 0.5.0 and main all label the override this way.
        let chosen = json!({
            "installed": true,
            "path": here,
            "pin": "0.9.0",
            "source": "COVEN_ENGINE_BIN override",
            "version": "0.9.0",
        });
        assert!(Engine::read(&chosen).overridden);
        for source in [
            "PATH",
            "legacy (~/.coven-code/bin)",
            "managed (~/.coven/engine)",
        ] {
            let status = json!({ "installed": true, "path": here, "source": source });
            assert!(!Engine::read(&status).overridden, "{source}");
        }
        // Not installed: no path and no version, whatever else is reported.
        let absent =
            json!({ "installed": false, "path": here, "pin": "0.9.1", "version": "0.9.0" });
        assert_eq!(
            Engine::read(&absent),
            Engine {
                path: None,
                version: None,
                pin: Some("0.9.1".into()),
                overridden: false,
            }
        );
        // A path that is not an existing absolute file is not an engine.
        let relative = json!({ "installed": true, "path": "coven-code", "version": "0.9.1" });
        assert!(!Engine::read(&relative).installed());
        assert_eq!(Engine::read(&json!({})), Engine::default());
        assert_eq!(
            Engine::read(&json!({ "version": 9, "pin": "" })),
            Engine::default()
        );
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
    fn versions_drop_their_parenthetical_status() {
        assert_eq!(
            shown_version("coven v0.4.8-10-ge6fc281f (engine not installed, pinned 0.8.0)\n"),
            "coven v0.4.8-10-ge6fc281f"
        );
        assert_eq!(shown_version("coven 0.4.9\nmore"), "coven 0.4.9");
        assert_eq!(shown_version(""), "");
    }

    #[test]
    fn familiar_names_are_one_short_line_with_a_letter_or_number() {
        assert_eq!(familiar_name("  Astra  ").as_deref(), Ok("Astra"));
        assert_eq!(familiar_name("Nova 2").as_deref(), Ok("Nova 2"));
        assert_eq!(familiar_name("--id").as_deref(), Ok("--id"));
        for bad in ["", "   ", "Astra\nNova", "Tab\there", "!!!", "✨✨"] {
            assert!(familiar_name(bad).is_err(), "{bad:?}");
        }
        assert!(familiar_name(&"a".repeat(65)).is_err());
        assert!(familiar_name(&"a".repeat(64)).is_ok());
    }

    #[test]
    fn coven_create_answers_become_plain_results() {
        let created = r#"{"id":"astra","displayName":"Astra","workspace":"/w","created":true}"#;
        assert_eq!(
            created_familiar(0, created),
            Ok(json!({ "id": "astra", "displayName": "Astra" }))
        );
        let exists = r#"{"created":false,"error":{"code":"familiar_exists","message":"familiar `astra` already exists in /x"}}"#;
        let error = created_familiar(1, exists).unwrap_err();
        assert!(error.starts_with("You already have a familiar"), "{error}");
        assert!(!error.contains("/x"), "no paths reach the window: {error}");
        assert!(
            created_familiar(1, r#"{"created":false,"error":{"code":"roster_changed"}}"#)
                .unwrap_err()
                .contains("Try again")
        );
        assert!(
            created_familiar(2, "error: unexpected argument 'Astra' found")
                .unwrap_err()
                .contains("Update Coven")
        );
        assert!(created_familiar(0, r#"{"created":true}"#).is_err());
    }

    #[test]
    fn sign_in_links_are_found_in_tool_output() {
        assert_eq!(
            link_in(
                "If the browser did not open, visit: https://auth.example.com/oauth?code=1&x=2."
            ),
            Some("https://auth.example.com/oauth?code=1&x=2")
        );
        assert_eq!(
            link_in("Open (https://claude.ai/login) to continue"),
            Some("https://claude.ai/login")
        );
        assert_eq!(link_in("Waiting for the browser…"), None);
        assert_eq!(link_in("https://"), None);
        assert_eq!(link_in(&format!("https://{}", "a".repeat(3000))), None);
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

    /// Runs the real check as a brand-new person would meet it. Run with a
    /// scratch home so nothing reads or writes your own setup:
    /// `HOME=$(mktemp -d) COVEN_HOME=$HOME/.coven cargo test --lib live_check -- --ignored --nocapture`.
    #[test]
    #[ignore = "starts the installed Coven and Claude Code; run with a scratch HOME and COVEN_HOME"]
    fn live_check_in_a_scratch_home() {
        let home = home().unwrap();
        let coven_home = std::env::var_os("COVEN_HOME").map(PathBuf::from).unwrap();
        assert!(
            coven_home.starts_with(&home),
            "point COVEN_HOME inside the scratch HOME"
        );
        let report = check().unwrap();
        println!("{}", serde_json::to_string_pretty(&report).unwrap());
        assert_eq!(report["platform"]["ok"], json!(true));
        assert_eq!(report["familiar"]["count"], json!(0));
    }

    /// Takes a scratch home from the engine the installed Coven chooses (or
    /// an older one already on the search path) to one Chat can use, with
    /// real downloads. Run it like
    /// `live_check_in_a_scratch_home`, with `live_engine_update` as the filter.
    #[test]
    #[ignore = "downloads engines with the installed Coven; run with a scratch HOME and COVEN_HOME"]
    fn live_engine_update_in_a_scratch_home() {
        let home = home().unwrap();
        let coven_home = std::env::var_os("COVEN_HOME").map(PathBuf::from).unwrap();
        assert!(
            coven_home.starts_with(&home),
            "point COVEN_HOME inside the scratch HOME"
        );
        let cancel = AtomicBool::new(false);
        let mut lines = |event: Value| {
            println!("  {event}");
            Ok(())
        };
        if !engine_status().installed() {
            // What a person who installed the engine before Chat asked for a
            // newer one has: Coven's own choice.
            let (code, _) = stream_tool(
                &resolve_cli().unwrap(),
                &["engine", "install"],
                ENGINE_INSTALL_TIMEOUT,
                &cancel,
                &mut lines,
            )
            .unwrap();
            assert_eq!(code, 0);
        }
        let before = engine_status();
        println!("before: {before:?}");
        assert!(before.installed());

        install_engine(&cancel, &mut lines).unwrap();
        let after = engine_status();
        println!("after: {after:?}");
        assert!(after.ready());
        assert_eq!(after.version.as_deref().and_then(new_enough), Some(true));
        if before.outdated() {
            assert_ne!(before.version, after.version);
        }
        assert_eq!(check().unwrap()["engine"]["ok"], json!(true));

        // Asking again changes nothing.
        install_engine(&cancel, &mut lines).unwrap();
        assert_eq!(engine_status(), after);
    }
}
