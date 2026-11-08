//! Familiars asking for permission, and the record of what happened next.
//!
//! Every Chat turn runs read-only. A familiar that needs more ends its reply
//! with a `coven-permission-request` block. The host reads that block from the
//! run's own output, never from the webview or the phone, and records it here.
//! Only a person's Allow, in this window or on the paired iPhone, starts one
//! turn with write access, and that turn logs each tool call it reports.
//!
//! The log is append-only and is also the state: a request stays open until the
//! log records an answer, it expires, or the chat moves on. Allow spends the
//! request, durably, before the turn starts, so one click is never two turns.

use std::{
    fs::{self, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::Path,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;

const LOG_FILE: &str = "permission-log.jsonl";
const ROTATED_LOG_FILE: &str = "permission-log.1.jsonl";
const LOCK_FILE: &str = "permission-log.lock";
const LOCK_TIMEOUT: Duration = Duration::from_secs(2);
const LOG_ROTATE_BYTES: u64 = 2 * 1024 * 1024;
const REQUEST_TTL_MS: u64 = 60 * 60 * 1000;
const SUMMARY_LIMIT: usize = 200;
const REASON_LIMIT: usize = 600;
const DETAIL_LIMIT: usize = 240;
pub(crate) const LOG_UNAVAILABLE: &str =
    "Chat can't reach its permission log. Check the disk, then try again.";
/// The same keys, in the same order, as `SUMMARY_KEYS` in `src/coven/events.ts`.
const DETAIL_KEYS: [&str; 7] = [
    "command",
    "file_path",
    "path",
    "pattern",
    "url",
    "query",
    "description",
];
/// What the dialog says when a familiar's block carries no usable summary.
const UNDESCRIBED: &str = "Make the changes described in its reply";
const FENCE: &str = "```coven-permission-request";
const CLOSING_FENCE: &str = "\n```";
/// How a tool call opens in an engine's text: `src/coven/tool-activity.ts` reads
/// the same three.
const MARKERS: [char; 3] = ['⚒', '✶', '✳'];
const VARIATION_SELECTORS: [char; 2] = ['\u{FE0E}', '\u{FE0F}'];
/// A call that never ends stops being waited for at this size.
const PROSE_LIMIT: usize = 64 * 1024;

/// The thread-visible disclosure at the top of a turn with write access.
pub(crate) const GRANT_NOTICE: &str =
    "You allowed this turn to change files and run commands. That access ends when this reply does.";
pub(crate) const NOTICE_SOURCE: &str = "chat-approval";

static LOG_LOCK: Mutex<()> = Mutex::new(());

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX)
        })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Device {
    Desktop,
    Iphone,
}
impl Device {
    fn name(self) -> &'static str {
        match self {
            Device::Desktop => "desktop",
            Device::Iphone => "iphone",
        }
    }
}

/// One line of the log. `event` is `requested`, `allowed`, `declined`,
/// `superseded`, `action` or `finished`.
#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Entry {
    pub at: u64,
    pub event: String,
    pub approval_id: String,
    pub familiar_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
}

/// An open request, as the window and the phone see it. The chat's real session
/// id stays on the host.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Approval {
    pub id: String,
    pub familiar_id: String,
    pub summary: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    pub requested_at: u64,
    pub expires_at: u64,
}

/// Write access for exactly one turn. Only `allow` makes one, and it can't
/// arrive from outside the host: see the `grant` field on `SendInput`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Grant {
    pub approval_id: String,
    pub familiar_id: String,
    pub session_id: String,
    pub summary: String,
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) struct Proposal {
    pub summary: String,
    pub reason: Option<String>,
}

/// Whether a familiar can ask for permission in this release. While this is
/// false, no turn is told it can ask, nothing is filed, nothing is shown, and no
/// answer becomes a [`Grant`], so nothing in Chat can start a turn with full
/// permission. `allow` and `pending` are private so that the window and the phone
/// can only reach them through the checks below.
const ASKING_ENABLED: bool = false;

/// Only a window or a phone holding a request from a build that could ask sees this.
pub(crate) const ASKING_OFF: &str =
    "Familiars can't ask for permission in this version of Chat, so nothing ran.";

/// The only way for the window or the phone to turn an answer into a [`Grant`].
pub(crate) fn allow_request(
    data: &Path,
    id: &str,
    device: Device,
    run_id: &str,
    now: u64,
) -> Result<Grant, String> {
    if !ASKING_ENABLED {
        return Err(ASKING_OFF.into());
    }
    allow(data, id, device, run_id, now)
}

/// The requests the window and the phone may show.
pub(crate) fn open_requests(data: &Path, now: u64) -> Result<Vec<Approval>, String> {
    if !ASKING_ENABLED {
        return Ok(Vec::new());
    }
    pending(data, now)
}

/// Whether a finished turn's reply can file a request. A turn that already has
/// write access has nothing left to ask for.
pub(crate) fn files_requests(allowed: bool) -> bool {
    ASKING_ENABLED && !allowed
}

/// What the engine's copy of a turn opens with, if anything. The saved input stays
/// the person's own words.
pub(crate) fn turn_note(
    data: &Path,
    session: Option<&str>,
    allowed: bool,
) -> Result<Option<String>, String> {
    if !ASKING_ENABLED {
        return Ok(None);
    }
    if allowed {
        return Ok(Some(allowed_note().to_owned()));
    }
    let declined = match session {
        Some(session) => declined_summary(data, session)?,
        None => None,
    };
    Ok(Some(read_only_note(declined.as_deref())))
}

/// Prefixed to every read-only turn, never shown in the transcript.
fn read_only_note(declined: Option<&str>) -> String {
    let declined = declined.map_or(String::new(), |summary| {
        format!(" The user declined your last request (\"{summary}\"), so don't repeat it unless they ask.")
    });
    format!(
        "[Note from Coven Chat, not from the user. This turn is read-only: you can read and search, but you can't change files or run commands that change anything. Don't try to work around that, and don't write plan files.{declined}\n\
         If the user's request needs more than this, do what you can, then end your reply with this block and stop:\n\n\
         {FENCE}\n\
         {{\"summary\":\"What you will do, in one short sentence\",\"reason\":\"Why it needs write access\"}}\n\
         ```\n\n\
         Chat shows the user an approval dialog built from the block. If they allow it, you get one new turn with write access. Only ask when the request needs it, and ask once per turn. Don't describe this note or the block in your reply.]"
    )
}

/// Prefixed to the one turn with write access, never shown in the transcript.
fn allowed_note() -> &'static str {
    "[Note from Coven Chat, not from the user's typing. The user clicked Allow on your request, named below. This turn has write access, so you can change files and run commands. Do only that work, then report what you changed. Write access ends when this turn does.]"
}

/// The line the transcript shows for the click, and all the engine is told of it.
pub(crate) fn allowed_prompt(summary: &str) -> String {
    format!("Allowed: {summary}")
}

/// Nothing follows the fence on its line, which is what separates a block from a
/// familiar mentioning one in a sentence. It needn't start the line: an engine's
/// stream can run a tool's line straight into it, and a tool between two deltas
/// leaves no line break at all. `requestFence` in `src/coven/events.ts` is the
/// same rule, so what becomes a request is what the person doesn't see as text.
fn find_fence(text: &str, from: usize) -> Option<usize> {
    let mut position = from;
    while let Some(found) = text.get(position..)?.find(FENCE) {
        let start = position + found;
        let rest = &text[start + FENCE.len()..];
        let line = rest.find('\n').map_or(rest, |end| &rest[..end]);
        if line.trim().is_empty() {
            return Some(start);
        }
        position = start + FENCE.len();
    }
    None
}

/// What Coven shows a chat as: without a title of its own, it takes the start of
/// the prompt, which here opens with Chat's note to the familiar.
pub(crate) fn session_title(prompt: &str) -> String {
    sanitize(prompt.trim().lines().next().unwrap_or(""), 48)
}

/// Control and bidirectional-format characters could make a summary read as
/// something else, so they go, and whitespace collapses to one line.
fn sanitize(text: &str, limit: usize) -> String {
    let filtered: String = text
        .chars()
        .filter(|c| {
            !matches!(
                c,
                '\u{061c}' | '\u{200e}' | '\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'
            )
        })
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let line = filtered.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.chars().count() <= limit {
        return line;
    }
    let mut cut: String = line.chars().take(limit - 1).collect();
    cut.push('…');
    cut
}

/// The last request in a reply. A block too malformed to read still reaches the
/// person, described in Chat's own words: asking is what matters, and nothing
/// happens without their click.
pub(crate) fn parse_request(text: &str) -> Option<Proposal> {
    let mut start = find_fence(text, 0)?;
    while let Some(next) = find_fence(text, start + FENCE.len()) {
        start = next;
    }
    let after = &text[start + FENCE.len()..];
    let body = after.find('\n').map_or("", |line| &after[line + 1..]);
    let body = body.find("```").map_or(body, |end| &body[..end]);
    #[derive(Deserialize)]
    struct Body {
        summary: Option<String>,
        reason: Option<String>,
    }
    let parsed = serde_json::from_str::<Body>(body.trim()).ok();
    let summary = parsed
        .as_ref()
        .and_then(|body| body.summary.as_deref())
        .map(|summary| sanitize(summary, SUMMARY_LIMIT))
        .filter(|summary| !summary.is_empty())
        .unwrap_or_else(|| UNDESCRIBED.to_owned());
    let reason = parsed
        .as_ref()
        .and_then(|body| body.reason.as_deref())
        .map(|reason| sanitize(reason, REASON_LIMIT))
        .filter(|reason| !reason.is_empty());
    Some(Proposal { summary, reason })
}

/// A reply as a person reads it: the request becomes a dialog, not prose. A
/// block still arriving is hidden as soon as it can be recognized. The same rule
/// is `stripPermissionRequests` in `src/coven/events.ts`.
pub(crate) fn strip_requests(text: &str) -> String {
    let mut out = text.to_owned();
    while let Some(start) = find_fence(&out, 0) {
        let search = start + FENCE.len();
        let end = out[search..]
            .find(CLOSING_FENCE)
            .map_or(out.len(), |found| search + found + CLOSING_FENCE.len());
        out.replace_range(start..end, "");
    }
    if let Some(tail) = out.rfind("```") {
        let partial = &out[tail..];
        if partial.len() > 3 && FENCE.starts_with(partial) {
            out.truncate(tail);
        }
    }
    if out == text {
        out
    } else {
        out.trim_end().to_owned()
    }
}

/// A subagent's text carries the tool call it answers.
fn own_words(event: &Value) -> bool {
    event.get("parent_tool_use_id").is_none_or(Value::is_null)
}

/// The request in a finished run's own words: its top-level assistant text.
pub(crate) fn proposal_in(events: &[Value]) -> Option<Proposal> {
    let mut text = String::new();
    for event in events {
        match event.get("type").and_then(Value::as_str) {
            Some("text_delta") if own_words(event) => {
                if let Some(delta) = event.get("text").and_then(Value::as_str) {
                    text.push_str(delta);
                }
            }
            Some("assistant") if own_words(event) => {
                let blocks = event.pointer("/message/content").and_then(Value::as_array);
                for block in blocks.into_iter().flatten() {
                    if block["type"] == "text" {
                        text.push_str(block["text"].as_str().unwrap_or(""));
                        text.push('\n');
                    }
                }
            }
            _ => {}
        }
    }
    parse_request(&text)
}

fn tool_detail(input: Option<&Value>) -> String {
    let Some(input) = input else {
        return String::new();
    };
    let preferred = DETAIL_KEYS
        .iter()
        .find_map(|key| input.get(*key).and_then(Value::as_str))
        .filter(|text| !text.trim().is_empty());
    match preferred {
        Some(text) => sanitize(text, DETAIL_LIMIT),
        None if input.is_null() => String::new(),
        None => sanitize(&input.to_string(), DETAIL_LIMIT),
    }
}

/// The tool calls a turn reports, as `(tool, one-line detail)`.
///
/// Engines report some of them as structured events and the rest as a line of
/// text, which can land anywhere in a delta or be split across two. The window
/// reads those with `segmentToolCalls`. This reader finds at least what the window
/// does: it doesn't skip code spans, so a line a familiar merely quotes is logged
/// too, because a false line costs less here than a missing one.
#[derive(Default)]
pub(crate) struct ActionReader {
    prose: String,
}

impl ActionReader {
    pub(crate) fn read(&mut self, event: &Value) -> Vec<(String, String)> {
        let mut found = Vec::new();
        match event.get("type").and_then(Value::as_str) {
            Some("text_delta" | "output") => {
                if let Some(text) = event.get("text").and_then(Value::as_str) {
                    self.prose.push_str(text);
                }
                self.drain(&mut found, false);
            }
            Some("tool_start") => {
                self.drain(&mut found, true);
                let name = event
                    .get("tool")
                    .or_else(|| event.get("tool_name"))
                    .and_then(Value::as_str)
                    .filter(|name| !name.is_empty());
                if let Some(name) = name {
                    found.push((sanitize(name, 80), tool_detail(event.get("input"))));
                }
            }
            Some("assistant") => {
                self.drain(&mut found, true);
                let blocks = event.pointer("/message/content").and_then(Value::as_array);
                for block in blocks.into_iter().flatten() {
                    if block["type"] == "tool_use" {
                        if let Some(name) = block["name"].as_str().filter(|name| !name.is_empty()) {
                            found.push((sanitize(name, 80), tool_detail(block.get("input"))));
                        }
                    } else if block["type"] == "text" {
                        self.prose.push_str(block["text"].as_str().unwrap_or(""));
                        self.drain(&mut found, true);
                    }
                }
            }
            _ => self.drain(&mut found, true),
        }
        found
    }

    /// Whatever was still arriving when the run ended.
    pub(crate) fn finish(&mut self) -> Vec<(String, String)> {
        let mut found = Vec::new();
        self.drain(&mut found, true);
        found
    }

    fn drain(&mut self, found: &mut Vec<(String, String)>, finished: bool) {
        loop {
            let Some(start) = self.prose.find(MARKERS) else {
                self.prose.clear();
                return;
            };
            self.prose.drain(..start);
            let finished = finished || self.prose.len() > PROSE_LIMIT;
            let Some((call, end)) = read_call(&self.prose, finished) else {
                return;
            };
            found.extend(call);
            self.prose.drain(..end);
        }
    }
}

/// The call at the marker `text` starts with, and how much of `text` it used.
/// `None` means the rest hasn't arrived yet, which `finished` rules out.
fn read_call(text: &str, finished: bool) -> Option<(Option<(String, String)>, usize)> {
    let marker = text.chars().next().map_or(0, char::len_utf8);
    let call = text[marker..]
        .trim_start_matches(VARIATION_SELECTORS)
        .trim_start_matches([' ', '\t']);
    let name_start = text.len() - call.len();
    let name_end = call
        .find(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-')))
        .unwrap_or(call.len());
    if name_end == call.len() && !finished {
        return None;
    }
    let name = &call[..name_end];
    if !name.starts_with(|c: char| c.is_ascii_alphabetic()) {
        return Some((None, marker));
    }
    let named = |detail: &str| Some((sanitize(name, 80), sanitize(detail, DETAIL_LIMIT)));
    let rest = &call[name_end..];
    let rest_start = name_start + name_end;
    if let Some(args) = rest.strip_prefix('(') {
        let args_start = rest_start + 1;
        let ended = args_end(args, true).or_else(|| {
            // A quote still open when the text ran out was an apostrophe.
            finished.then(|| args_end(args, false)).flatten()
        });
        return match ended {
            Some((end, closed)) => {
                Some((named(&args[..end]), args_start + end + usize::from(closed)))
            }
            None if finished => Some((named(args), text.len())),
            None => None,
        };
    }
    let line_end = rest.find(|c: char| c == '\n' || MARKERS.contains(&c));
    match line_end {
        Some(end) => Some((named(&rest[..end]), rest_start + end)),
        None if finished => Some((named(rest), text.len())),
        None => None,
    }
}

/// Where a call's arguments stop, and whether a `)` closed them rather than the
/// end of the line or the next call. Quoted text is the argument's own, as in
/// `closingParen` in `src/coven/tool-activity.ts`.
fn args_end(args: &str, quoting: bool) -> Option<(usize, bool)> {
    let mut depth = 1;
    let mut quote = None;
    let mut escaped = false;
    for (index, c) in args.char_indices() {
        if let Some(open) = quote {
            if c == '\n' {
                return args_end(args, false);
            }
            if escaped {
                escaped = false;
            } else if c == '\\' && open == '"' {
                escaped = true;
            } else if c == open {
                quote = None;
            }
            continue;
        }
        match c {
            '"' | '\'' if quoting => quote = Some(c),
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth == 0 {
                    return Some((index, true));
                }
            }
            '\n' => return Some((index, false)),
            c if MARKERS.contains(&c) => return Some((index, false)),
            _ => {}
        }
    }
    None
}

fn read_file(path: &Path) -> Result<Vec<Entry>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(LOG_UNAVAILABLE.into()),
    };
    // A line torn by a crash is skipped; everything before it stands.
    Ok(String::from_utf8_lossy(&bytes)
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect())
}

fn append(data: &Path, entry: &Entry) -> Result<(), String> {
    fs::create_dir_all(data).map_err(|_| LOG_UNAVAILABLE)?;
    let path = data.join(LOG_FILE);
    // The oldest half goes first. A request caught in it stops being open,
    // which is the safe direction: the familiar can ask again.
    if fs::metadata(&path).is_ok_and(|metadata| metadata.len() >= LOG_ROTATE_BYTES) {
        fs::rename(&path, data.join(ROTATED_LOG_FILE)).map_err(|_| LOG_UNAVAILABLE)?;
    }
    let mut line = serde_json::to_vec(entry).map_err(|_| LOG_UNAVAILABLE)?;
    line.push(b'\n');
    let mut options = OpenOptions::new();
    options.read(true).append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path).map_err(|_| LOG_UNAVAILABLE)?;
    // A line torn by a crash or a full disk costs only itself. This one starts
    // fresh, or it would join the tear and be skipped with it.
    let length = file.metadata().map_err(|_| LOG_UNAVAILABLE)?.len();
    if length > 0 {
        let mut last = [0; 1];
        file.seek(SeekFrom::End(-1)).map_err(|_| LOG_UNAVAILABLE)?;
        file.read_exact(&mut last).map_err(|_| LOG_UNAVAILABLE)?;
        if last[0] != b'\n' {
            line.insert(0, b'\n');
        }
    }
    file.write_all(&line).map_err(|_| LOG_UNAVAILABLE)?;
    file.sync_all().map_err(|_| LOG_UNAVAILABLE.to_owned())
}

/// The file lock is released before the local mutex. It is a stable sidecar,
/// never the log itself: rotation replaces that inode while an answer is saved.
struct LogGuard {
    _file: fs::File,
    _local: std::sync::MutexGuard<'static, ()>,
}

fn lock(data: &Path) -> Result<LogGuard, String> {
    let local = LOG_LOCK.lock().map_err(|_| LOG_UNAVAILABLE.to_owned())?;
    fs::create_dir_all(data).map_err(|_| LOG_UNAVAILABLE)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(data.join(LOCK_FILE))
        .map_err(|_| LOG_UNAVAILABLE)?;
    let metadata = file.metadata().map_err(|_| LOG_UNAVAILABLE)?;
    if !metadata.is_file() {
        return Err(LOG_UNAVAILABLE.into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
            return Err(LOG_UNAVAILABLE.into());
        }
    }
    // Logging errors must stop an allowed turn. A peer stuck while holding the
    // file must not turn that fail-closed path into an unbounded wait.
    let deadline = Instant::now() + LOCK_TIMEOUT;
    let contended = fs2::lock_contended_error().raw_os_error();
    loop {
        match fs2::FileExt::try_lock_exclusive(&file) {
            Ok(()) => break,
            Err(error)
                if (error.kind() == io::ErrorKind::Interrupted
                    || contended.is_some_and(|code| error.raw_os_error() == Some(code)))
                    && Instant::now() < deadline =>
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => return Err(LOG_UNAVAILABLE.into()),
        }
    }
    Ok(LogGuard {
        _file: file,
        _local: local,
    })
}

fn is_answer(event: &str) -> bool {
    matches!(event, "allowed" | "declined" | "superseded")
}

fn approval(request: &Entry) -> Approval {
    Approval {
        id: request.approval_id.clone(),
        familiar_id: request.familiar_id.clone(),
        summary: request.summary.clone().unwrap_or_default(),
        reason: request.reason.clone(),
        requested_at: request.at,
        expires_at: request.at.saturating_add(REQUEST_TTL_MS),
    }
}

/// Records a familiar's request. Its turn has already superseded any older one.
pub(crate) fn submit(
    data: &Path,
    familiar: &str,
    session: &str,
    run_id: &str,
    proposal: Proposal,
    now: u64,
) -> Result<Approval, String> {
    let request = Entry {
        at: now,
        event: "requested".into(),
        approval_id: uuid::Uuid::new_v4().to_string(),
        familiar_id: familiar.to_owned(),
        session_id: Some(session.to_owned()),
        run_id: Some(run_id.to_owned()),
        summary: Some(proposal.summary),
        reason: proposal.reason,
        ..Entry::default()
    };
    let _log = lock(data)?;
    append(data, &request)?;
    Ok(approval(&request))
}

/// The requests still waiting for an answer, oldest first.
fn pending(data: &Path, now: u64) -> Result<Vec<Approval>, String> {
    let entries = {
        let _log = lock(data)?;
        read_file(&data.join(LOG_FILE))?
    };
    let mut open: Vec<&Entry> = Vec::new();
    for entry in &entries {
        if entry.event == "requested" && now < entry.at.saturating_add(REQUEST_TTL_MS) {
            open.push(entry);
        } else if is_answer(&entry.event) {
            open.retain(|request| request.approval_id != entry.approval_id);
        }
    }
    if open.is_empty() {
        return Ok(Vec::new());
    }
    let _storage = crate::chat_lifecycle::STORAGE_LOCK
        .lock()
        .map_err(|_| "Chat's archive and delete records are unavailable.")?;
    let mut approvals = Vec::new();
    for request in open {
        if request.session_id == crate::chat_canonical::head(data, &request.familiar_id)? {
            approvals.push(approval(request));
        }
    }
    Ok(approvals)
}

fn open_request(data: &Path, id: &str, now: u64) -> Result<Entry, String> {
    let entries = read_file(&data.join(LOG_FILE))?;
    let request = entries
        .iter()
        .find(|entry| entry.event == "requested" && entry.approval_id == id)
        .ok_or("Chat has no record of this request. Ask the familiar again.")?;
    if entries
        .iter()
        .any(|entry| entry.approval_id == id && is_answer(&entry.event))
    {
        return Err("This request was already answered.".into());
    }
    if now >= request.at.saturating_add(REQUEST_TTL_MS) {
        return Err("This request expired. Ask the familiar again.".into());
    }
    Ok(request.clone())
}

/// Spends the request and returns the grant. The caller holds the run slot, so
/// a busy runtime never costs anyone their request.
fn allow(data: &Path, id: &str, device: Device, run_id: &str, now: u64) -> Result<Grant, String> {
    crate::coven_runtime::validate_id(id)?;
    crate::coven_runtime::validate_id(run_id)?;
    let request = {
        let _log = lock(data)?;
        open_request(data, id, now)?
    };
    let session = request
        .session_id
        .clone()
        .ok_or("This request names no chat. Ask the familiar again.")?;
    {
        let _storage = crate::chat_lifecycle::STORAGE_LOCK
            .lock()
            .map_err(|_| "Chat's archive and delete records are unavailable.")?;
        if crate::chat_canonical::head(data, &request.familiar_id)?.as_deref() != Some(&session) {
            return Err("This chat has moved on since the request. Ask the familiar again.".into());
        }
        crate::chat_lifecycle::require_active(data, &session)?;
    }
    let _log = lock(data)?;
    // Checked again under the same hold as the write: two devices can't both win.
    let request = open_request(data, id, now)?;
    append(
        data,
        &Entry {
            at: now,
            event: "allowed".into(),
            approval_id: id.to_owned(),
            familiar_id: request.familiar_id.clone(),
            device: Some(device.name().into()),
            run_id: Some(run_id.to_owned()),
            summary: request.summary.clone(),
            ..Entry::default()
        },
    )?;
    Ok(Grant {
        approval_id: id.to_owned(),
        familiar_id: request.familiar_id,
        session_id: session,
        summary: request.summary.unwrap_or_default(),
    })
}

/// Records the answer and returns the request, for the transcript's notice.
pub(crate) fn decline(data: &Path, id: &str, device: Device, now: u64) -> Result<Entry, String> {
    crate::coven_runtime::validate_id(id)?;
    let _log = lock(data)?;
    let request = open_request(data, id, now)?;
    append(
        data,
        &Entry {
            at: now,
            event: "declined".into(),
            approval_id: id.to_owned(),
            familiar_id: request.familiar_id.clone(),
            device: Some(device.name().into()),
            summary: request.summary.clone(),
            ..Entry::default()
        },
    )?;
    Ok(request)
}

/// A new turn replaces whatever the familiar was still waiting on.
pub(crate) fn supersede(data: &Path, familiar: &str, now: u64) -> Result<(), String> {
    let _log = lock(data)?;
    let entries = read_file(&data.join(LOG_FILE))?;
    let waiting: Vec<&Entry> = entries
        .iter()
        .filter(|entry| {
            entry.event == "requested"
                && entry.familiar_id == familiar
                && now < entry.at.saturating_add(REQUEST_TTL_MS)
                && !entries.iter().any(|answer| {
                    answer.approval_id == entry.approval_id && is_answer(&answer.event)
                })
        })
        .collect();
    for request in waiting {
        append(
            data,
            &Entry {
                at: now,
                event: "superseded".into(),
                approval_id: request.approval_id.clone(),
                familiar_id: familiar.to_owned(),
                summary: request.summary.clone(),
                ..Entry::default()
            },
        )?;
    }
    Ok(())
}

/// Which familiar an open request belongs to.
pub(crate) fn open_familiar(data: &Path, id: &str, now: u64) -> Result<Option<String>, String> {
    Ok(pending(data, now)?
        .into_iter()
        .find(|approval| approval.id == id)
        .map(|approval| approval.familiar_id))
}

/// What the familiar's last request in this chat turned into, when it was
/// declined: the next read-only note says so, once, because the chat then moves on.
pub(crate) fn declined_summary(data: &Path, session: &str) -> Result<Option<String>, String> {
    let asked =
        |entry: &Entry| entry.event == "requested" && entry.session_id.as_deref() == Some(session);
    let _log = lock(data)?;
    let mut entries = read_file(&data.join(LOG_FILE))?;
    if !entries.iter().any(asked) {
        // Writing the answer can rotate the request out from under it.
        let mut older = read_file(&data.join(ROTATED_LOG_FILE))?;
        older.append(&mut entries);
        entries = older;
    }
    let Some(request) = entries.iter().rev().find(|entry| asked(entry)) else {
        return Ok(None);
    };
    let declined = entries
        .iter()
        .any(|entry| entry.approval_id == request.approval_id && entry.event == "declined");
    Ok(declined.then(|| request.summary.clone()).flatten())
}

/// A turn with write access stops if its actions can't be logged: the caller
/// passes this error back up the stream, which ends the run.
pub(crate) fn record_action(
    data: &Path,
    grant: &Grant,
    run_id: &str,
    tool: &str,
    detail: &str,
    now: u64,
) -> Result<(), String> {
    let _log = lock(data)?;
    append(
        data,
        &Entry {
            at: now,
            event: "action".into(),
            approval_id: grant.approval_id.clone(),
            familiar_id: grant.familiar_id.clone(),
            run_id: Some(run_id.to_owned()),
            tool: Some(tool.to_owned()),
            detail: (!detail.is_empty()).then(|| detail.to_owned()),
            ..Entry::default()
        },
    )
}

pub(crate) fn record_finished(
    data: &Path,
    grant: &Grant,
    run_id: &str,
    outcome: &str,
    now: u64,
) -> Result<(), String> {
    let _log = lock(data)?;
    append(
        data,
        &Entry {
            at: now,
            event: "finished".into(),
            approval_id: grant.approval_id.clone(),
            familiar_id: grant.familiar_id.clone(),
            run_id: Some(run_id.to_owned()),
            outcome: Some(outcome.to_owned()),
            ..Entry::default()
        },
    )
}

/// The newest `limit` entries, newest first, without the chats' real session ids.
pub(crate) fn recent(data: &Path, limit: usize) -> Result<Vec<Entry>, String> {
    let _log = lock(data)?;
    let mut entries = read_file(&data.join(LOG_FILE))?;
    if entries.len() < limit {
        let mut older = read_file(&data.join(ROTATED_LOG_FILE))?;
        older.append(&mut entries);
        entries = older;
    }
    Ok(entries
        .into_iter()
        .rev()
        .take(limit)
        .map(|mut entry| {
            entry.session_id = None;
            entry
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Data(std::path::PathBuf);
    impl Data {
        fn new() -> Self {
            let path =
                std::env::temp_dir().join(format!("chat-approvals-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        /// A familiar whose chat is `session`, as a run's init event leaves it.
        fn head(&self, familiar: &str, session: &str) {
            let transcripts = self.0.join("coven-transcripts");
            fs::create_dir_all(&transcripts).unwrap();
            fs::write(
                transcripts.join(format!("{session}.jsonl")),
                json!({"type":"user","source":"chat-input","session_id":session}).to_string(),
            )
            .unwrap();
            let _storage = crate::chat_lifecycle::STORAGE_LOCK
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            let advanced = crate::chat_canonical::ensure_empty(&self.0, familiar).and_then(|()| {
                let current = crate::chat_canonical::head(&self.0, familiar)?;
                crate::chat_canonical::advance(&self.0, familiar, current.as_deref(), session)
            });
            drop(_storage);
            advanced.unwrap();
        }
    }
    impl Drop for Data {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn proposal() -> Proposal {
        Proposal {
            summary: "Create probe.txt".into(),
            reason: Some("It needs a new file".into()),
        }
    }
    const BLOCK: &str = "```coven-permission-request\n{\"summary\":\"Create probe.txt\",\"reason\":\"It needs a new file\"}\n```";

    #[test]
    fn reads_the_request_the_engines_actually_write() {
        // The shapes Coven Code, Claude and Codex each produced on read-only runs.
        let text = format!("I can't create files this turn.\n\n{BLOCK}\n");
        assert_eq!(parse_request(&text), Some(proposal()));
        let events = [
            json!({"type":"text_delta","text":"⚒ Read(notes.md)"}),
            json!({"type":"text_delta","text":BLOCK}),
        ];
        assert_eq!(proposal_in(&events), Some(proposal()));
        let events = [
            json!({"type":"assistant","parent_tool_use_id":null,"message":{"content":[
                {"type":"text","text":format!("Needs access.\n\n{BLOCK}")},
            ]}}),
        ];
        assert_eq!(proposal_in(&events), Some(proposal()));
    }

    #[test]
    fn only_the_familiars_own_block_counts() {
        assert_eq!(
            parse_request("A request starts with ```coven-permission-request inline."),
            None
        );
        // A subagent's words aren't the familiar's, and a person's aren't either.
        let events = [
            json!({"type":"assistant","parent_tool_use_id":"tool-1","message":{"content":[
                {"type":"text","text":BLOCK},
            ]}}),
            json!({"type":"user","message":{"content":[{"type":"text","text":BLOCK}]}}),
            json!({"type":"tool_result","content":BLOCK}),
        ];
        assert_eq!(proposal_in(&events), None);
    }

    #[test]
    fn a_malformed_block_still_asks_in_chats_own_words() {
        for body in ["{\"summary\":", "not json", "{\"summary\":\"  \"}", "{}"] {
            let text = format!("```coven-permission-request\n{body}\n```");
            assert_eq!(parse_request(&text).unwrap().summary, UNDESCRIBED);
        }
    }

    #[test]
    fn a_summary_cannot_disguise_itself() {
        let text =
            "```coven-permission-request\n{\"summary\":\"Fix\\u202e txt.exe\\n\\u0007 now\"}\n```";
        assert_eq!(parse_request(text).unwrap().summary, "Fix txt.exe now");
        let long = format!(
            "```coven-permission-request\n{{\"summary\":\"{}\"}}\n```",
            "x".repeat(900)
        );
        let summary = parse_request(&long).unwrap().summary;
        assert_eq!(summary.chars().count(), SUMMARY_LIMIT);
        assert!(summary.ends_with('…'));
    }

    #[test]
    fn a_reply_reads_without_the_block() {
        assert_eq!(strip_requests(&format!("Done.\n\n{BLOCK}\n")), "Done.");
        assert_eq!(strip_requests(BLOCK), "");
        // Still arriving, however far it has got.
        assert_eq!(
            strip_requests("Needs access.\n\n```coven-permission-request\n{\"summ"),
            "Needs access."
        );
        assert_eq!(
            strip_requests("Needs access.\n\n```coven-perm"),
            "Needs access."
        );
        // Everything else stays exactly as written.
        let code = "```rust\nfn main() {}\n```\n";
        assert_eq!(strip_requests(code), code);
        assert_eq!(strip_requests("Text\n```"), "Text\n```");
    }

    /// Pins the release that keeps asking off. Turning it back on changes this
    /// test in the same commit, along with the notes and the acceptance row.
    #[test]
    fn while_asking_is_off_nothing_can_start_a_full_permission_turn() {
        let data = Data::new();
        data.head("astra", "session-1");
        // A request a build that could ask left open on disk.
        let request = submit(&data.0, "astra", "session-1", "run-1", proposal(), 1_000).unwrap();

        for device in [Device::Desktop, Device::Iphone] {
            assert_eq!(
                allow_request(&data.0, &request.id, device, "run-2", 2_000).unwrap_err(),
                ASKING_OFF
            );
        }
        // Neither answer reached the ledger, and nothing offers the request again.
        assert_eq!(pending(&data.0, 2_000).unwrap(), vec![request]);
        assert!(recent(&data.0, 10)
            .unwrap()
            .iter()
            .all(|entry| entry.event == "requested"));
        assert!(open_requests(&data.0, 2_000).unwrap().is_empty());

        // No turn is told it can ask, and no reply files a request.
        for allowed in [false, true] {
            assert_eq!(
                turn_note(&data.0, Some("session-1"), allowed).unwrap(),
                None
            );
            assert!(!files_requests(allowed));
        }
    }

    #[test]
    fn an_answer_closes_the_request_and_allow_spends_it_once() {
        let data = Data::new();
        data.head("astra", "session-1");
        let request = submit(&data.0, "astra", "session-1", "run-1", proposal(), 1_000).unwrap();
        assert_eq!(pending(&data.0, 2_000).unwrap(), vec![request.clone()]);

        let grant = allow(&data.0, &request.id, Device::Iphone, "run-2", 2_000).unwrap();
        assert_eq!(grant.session_id, "session-1");
        assert_eq!(grant.summary, "Create probe.txt");
        assert!(pending(&data.0, 2_000).unwrap().is_empty());
        assert_eq!(
            allow(&data.0, &request.id, Device::Desktop, "run-3", 2_000).unwrap_err(),
            "This request was already answered."
        );
        assert_eq!(
            decline(&data.0, &request.id, Device::Desktop, 2_000).unwrap_err(),
            "This request was already answered."
        );

        let log = recent(&data.0, 10).unwrap();
        assert_eq!(log[0].event, "allowed");
        assert_eq!(log[0].device.as_deref(), Some("iphone"));
        assert_eq!(log[0].run_id.as_deref(), Some("run-2"));
        assert_eq!(log[1].event, "requested");
        assert!(log.iter().all(|entry| entry.session_id.is_none()));
    }

    #[test]
    fn a_declined_request_cannot_be_allowed_and_tells_the_next_turn_once() {
        let data = Data::new();
        data.head("astra", "session-1");
        let request = submit(&data.0, "astra", "session-1", "run-1", proposal(), 1_000).unwrap();
        assert_eq!(declined_summary(&data.0, "session-1").unwrap(), None);
        decline(&data.0, &request.id, Device::Desktop, 2_000).unwrap();
        assert_eq!(
            allow(&data.0, &request.id, Device::Desktop, "run-2", 2_000).unwrap_err(),
            "This request was already answered."
        );
        assert_eq!(
            declined_summary(&data.0, "session-1").unwrap().as_deref(),
            Some("Create probe.txt")
        );
        // The chat moving on is what makes it once.
        assert_eq!(declined_summary(&data.0, "session-2").unwrap(), None);
        assert!(read_only_note(Some("Create probe.txt")).contains("declined"));
        assert!(!read_only_note(None).contains("declined"));
    }

    #[test]
    fn a_request_expires() {
        let data = Data::new();
        data.head("astra", "session-1");
        let request = submit(&data.0, "astra", "session-1", "run-1", proposal(), 1_000).unwrap();
        let late = 1_000 + REQUEST_TTL_MS;
        assert!(pending(&data.0, late - 1).unwrap().len() == 1);
        assert!(pending(&data.0, late).unwrap().is_empty());
        assert_eq!(
            allow(&data.0, &request.id, Device::Desktop, "run-2", late).unwrap_err(),
            "This request expired. Ask the familiar again."
        );
    }

    #[test]
    fn a_request_dies_with_the_turn_it_belongs_to() {
        let data = Data::new();
        data.head("astra", "session-1");
        let request = submit(&data.0, "astra", "session-1", "run-1", proposal(), 1_000).unwrap();
        data.head("astra", "session-2");
        assert!(pending(&data.0, 2_000).unwrap().is_empty());
        assert_eq!(
            allow(&data.0, &request.id, Device::Desktop, "run-2", 2_000).unwrap_err(),
            "This chat has moved on since the request. Ask the familiar again."
        );
        supersede(&data.0, "astra", 2_000).unwrap();
        assert_eq!(recent(&data.0, 1).unwrap()[0].event, "superseded");
    }

    #[test]
    fn nothing_opens_without_a_real_request() {
        let data = Data::new();
        assert_eq!(
            allow(&data.0, "no-such-request", Device::Desktop, "run-1", 1).unwrap_err(),
            "Chat has no record of this request. Ask the familiar again."
        );
        assert!(allow(&data.0, "../escape", Device::Desktop, "run-1", 1).is_err());
        assert!(pending(&data.0, 1).unwrap().is_empty());
    }

    #[test]
    fn the_turn_with_write_access_logs_what_it_did() {
        let data = Data::new();
        let grant = Grant {
            approval_id: "approval-1".into(),
            familiar_id: "astra".into(),
            session_id: "session-1".into(),
            summary: "Create probe.txt".into(),
        };
        let events = [
            json!({"type":"tool_start","tool":"Bash","input":{"command":"touch a\nb"}}),
            json!({"type":"tool_start","tool_name":"Grep","input":{"pattern":"x"}}),
            json!({"type":"text_delta","text":"⚒ Write(/tmp/probe.txt)"}),
            json!({"type":"assistant","message":{"content":[
                {"type":"text","text":"Writing."},
                {"type":"tool_use","name":"Edit","input":{"file_path":"/tmp/b","old_string":"x"}},
            ]}}),
            json!({"type":"text_delta","text":"Just prose."}),
        ];
        let found = read_all(&events);
        assert_eq!(
            found,
            vec![
                ("Bash".to_owned(), "touch a b".to_owned()),
                ("Grep".to_owned(), "x".to_owned()),
                ("Write".to_owned(), "/tmp/probe.txt".to_owned()),
                ("Edit".to_owned(), "/tmp/b".to_owned()),
            ]
        );
        for (tool, detail) in &found {
            record_action(&data.0, &grant, "run-2", tool, detail, 5).unwrap();
        }
        record_finished(&data.0, &grant, "run-2", "completed", 6).unwrap();
        let log = recent(&data.0, 10).unwrap();
        assert_eq!(log[0].event, "finished");
        assert_eq!(log[0].outcome.as_deref(), Some("completed"));
        assert_eq!(log[4].tool.as_deref(), Some("Bash"));
        assert_eq!(log[4].detail.as_deref(), Some("touch a b"));
    }

    fn read_all(events: &[Value]) -> Vec<(String, String)> {
        let mut reader = ActionReader::default();
        let mut found: Vec<_> = events.iter().flat_map(|event| reader.read(event)).collect();
        found.extend(reader.finish());
        found
    }

    fn call(name: &str, detail: &str) -> (String, String) {
        (name.to_owned(), detail.to_owned())
    }

    #[test]
    fn logs_a_tool_call_wherever_the_text_puts_it() {
        for (text, expected) in [
            ("⚒ Bash(ls)", vec![call("Bash", "ls")]),
            ("\n⚒ Write(x)", vec![call("Write", "x")]),
            ("Done.⚒ Bash(rm y)", vec![call("Bash", "rm y")]),
            (
                "⚒ Read(a)⚒ Bash(rm y)",
                vec![call("Read", "a"), call("Bash", "rm y")],
            ),
            ("✶ Bash(ls)", vec![call("Bash", "ls")]),
            ("✳ Bash(ls)", vec![call("Bash", "ls")]),
            ("⚒\u{FE0F} Bash(ls)", vec![call("Bash", "ls")]),
            ("⚒\u{FE0E}Bash(ls)", vec![call("Bash", "ls")]),
            // The next call on the line ends one whose summary was cut short.
            (
                "⚒ Bash(echo ...⚒ Read(a.ts)",
                vec![call("Bash", "echo ..."), call("Read", "a.ts")],
            ),
            // Parentheses and markers in quotes are the argument's own.
            (
                "⚒ Bash(echo \")\" && (ls))",
                vec![call("Bash", "echo \")\" && (ls)")],
            ),
            (
                "⚒ Bash(echo \"⚒ Read(x)\")",
                vec![call("Bash", "echo \"⚒ Read(x)\"")],
            ),
            // An apostrophe isn't a quote.
            ("⚒ Read(it's.md)\nNext", vec![call("Read", "it's.md")]),
            // A summary cut short by the end of the run still counts.
            ("⚒ Bash(rm -r", vec![call("Bash", "rm -r")]),
            ("⚒ Write\nDone.", vec![call("Write", "")]),
            ("No tools here. (Really.)", vec![]),
            ("⚒ ", vec![]),
            ("⚒ 1st(x)", vec![]),
        ] {
            let delta = json!({"type":"text_delta","text":text});
            assert_eq!(read_all(&[delta]), expected, "as a delta: {text:?}");
            let output = json!({"type":"output","text":text});
            assert_eq!(read_all(&[output]), expected, "as output: {text:?}");
            let whole =
                json!({"type":"assistant","message":{"content":[{"type":"text","text":text}]}});
            assert_eq!(read_all(&[whole]), expected, "as a block: {text:?}");
        }
    }

    #[test]
    fn logs_a_tool_call_split_across_deltas_once() {
        let events: Vec<Value> = ["Now ⚒", " Ba", "sh(rm", " y", ")", " and more"]
            .iter()
            .map(|text| json!({"type":"text_delta","text":text}))
            .collect();
        assert_eq!(read_all(&events), vec![call("Bash", "rm y")]);
    }

    #[test]
    fn logs_a_closed_call_as_soon_as_it_closes() {
        let mut reader = ActionReader::default();
        let found = reader.read(&json!({"type":"text_delta","text":"⚒ Bash(ls)"}));
        assert_eq!(found, vec![call("Bash", "ls")]);
        assert_eq!(reader.finish(), vec![]);
    }

    #[test]
    fn logs_the_calls_engines_report_as_events() {
        assert_eq!(
            read_all(&[
                json!({"type":"tool_start","tool":"Bash"}),
                json!({"type":"tool_start","tool_name":"Read","input":{"file_path":"a.txt"}}),
                json!({"type":"assistant","message":{"content":[
                    {"type":"tool_use","name":"Write","input":{"path":"b.txt"}},
                ]}}),
            ]),
            vec![
                call("Bash", ""),
                call("Read", "a.txt"),
                call("Write", "b.txt")
            ]
        );
    }

    #[test]
    fn a_tool_between_two_deltas_doesn_t_hide_the_request() {
        // The window shows these as two messages, and the block as nothing.
        let events = [
            json!({"type":"text_delta","text":"Checking."}),
            json!({"type":"tool_start","tool":"Read"}),
            json!({"type":"text_delta","text":BLOCK}),
        ];
        assert_eq!(proposal_in(&events), Some(proposal()));
    }

    #[test]
    fn a_block_run_into_a_tool_line_is_still_a_request_and_still_hidden() {
        let text = format!("⚒ Read(notes.md){BLOCK}");
        assert_eq!(parse_request(&text), Some(proposal()));
        assert_eq!(strip_requests(&text), "⚒ Read(notes.md)");
        assert_eq!(
            strip_requests("⚒ Read(notes.md)```coven-perm"),
            "⚒ Read(notes.md)"
        );
    }

    #[test]
    fn a_sentence_mentioning_the_block_is_neither_a_request_nor_hidden() {
        let prose = "A request starts with ```coven-permission-request inline.";
        assert_eq!(parse_request(prose), None);
        assert_eq!(strip_requests(prose), prose);
    }

    #[test]
    fn a_subagent_s_text_is_not_the_familiar_asking() {
        let events = [
            json!({"type":"text_delta","parent_tool_use_id":"tool-1","text":BLOCK}),
            json!({"type":"assistant","parent_tool_use_id":"tool-1","message":{"content":[
                {"type":"text","text":BLOCK},
            ]}}),
        ];
        assert_eq!(proposal_in(&events), None);
    }

    #[test]
    fn a_line_after_a_tear_still_counts() {
        let data = Data::new();
        data.head("astra", "session-1");
        let request = submit(&data.0, "astra", "session-1", "run-1", proposal(), 1_000).unwrap();
        let mut file = OpenOptions::new()
            .append(true)
            .open(data.0.join(LOG_FILE))
            .unwrap();
        file.write_all(b"{\"at\":2,\"event\":\"allo").unwrap();
        // Told it was declined, the person must find it closed.
        decline(&data.0, &request.id, Device::Desktop, 2_000).unwrap();
        assert_eq!(pending(&data.0, 3_000).unwrap(), vec![]);
        assert_eq!(
            declined_summary(&data.0, "session-1").unwrap().as_deref(),
            Some("Create probe.txt")
        );
    }

    #[test]
    fn the_familiar_hears_of_a_decline_that_rotated_its_request_away() {
        let data = Data::new();
        data.head("astra", "session-1");
        let request = submit(&data.0, "astra", "session-1", "run-1", proposal(), 1_000).unwrap();
        let path = data.0.join(LOG_FILE);
        // Resizing needs write access on Windows; append-only access cannot
        // extend the fixture. Close it before exercising production rotation.
        OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(LOG_ROTATE_BYTES + 1)
            .unwrap();
        decline(&data.0, &request.id, Device::Desktop, 2_000).unwrap();
        assert!(!fs::read_to_string(&path).unwrap().contains("requested"));
        assert_eq!(
            declined_summary(&data.0, "session-1").unwrap().as_deref(),
            Some("Create probe.txt")
        );
    }

    #[test]
    fn a_torn_line_costs_only_itself() {
        let data = Data::new();
        data.head("astra", "session-1");
        let request = submit(&data.0, "astra", "session-1", "run-1", proposal(), 1_000).unwrap();
        let path = data.0.join(LOG_FILE);
        let mut file = OpenOptions::new().append(true).open(&path).unwrap();
        file.write_all(b"{\"at\":2,\"event\":\"allo").unwrap();
        assert_eq!(pending(&data.0, 2_000).unwrap(), vec![request]);
    }

    #[test]
    fn a_full_log_rotates_and_recent_still_reads_across_it() {
        let data = Data::new();
        fs::write(
            data.0.join(LOG_FILE),
            format!(
                "{}\n{}",
                serde_json::to_string(&Entry {
                    at: 1,
                    event: "requested".into(),
                    approval_id: "old".into(),
                    ..Entry::default()
                })
                .unwrap(),
                " ".repeat(LOG_ROTATE_BYTES as usize)
            ),
        )
        .unwrap();
        let grant = Grant {
            approval_id: "new".into(),
            familiar_id: "astra".into(),
            session_id: "session".into(),
            summary: String::new(),
        };
        record_finished(&data.0, &grant, "run", "completed", 2).unwrap();
        assert!(data.0.join(ROTATED_LOG_FILE).exists());
        let log = recent(&data.0, 10).unwrap();
        assert_eq!(log[0].approval_id, "new");
        assert_eq!(log[1].approval_id, "old");
    }

    #[cfg(unix)]
    #[test]
    fn the_log_is_private_to_this_user() {
        use std::os::unix::fs::PermissionsExt;
        let data = Data::new();
        data.head("astra", "session-1");
        submit(&data.0, "astra", "session-1", "run-1", proposal(), 1_000).unwrap();
        for name in [LOG_FILE, LOCK_FILE] {
            let mode = fs::metadata(data.0.join(name))
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o600, "{name}");
        }
    }

    /// This same test binary acts as a real second host process when the parent
    /// supplies its disposable fixture. No app, listener or engine is started.
    #[test]
    fn approval_answers_are_exclusive_across_processes() {
        use std::{process::Command, time::Instant};

        fn wait_for(path: &Path) {
            let deadline = Instant::now() + std::time::Duration::from_secs(10);
            while !path.exists() {
                assert!(Instant::now() < deadline, "Waiting for {}", path.display());
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }

        if let Some(path) = std::env::var_os("CHAT_APPROVAL_TEST_DATA") {
            let data = std::path::PathBuf::from(path);
            let id = std::env::var("CHAT_APPROVAL_TEST_ID").unwrap();
            let run = std::env::var("CHAT_APPROVAL_TEST_RUN").unwrap();
            if run == "lock-holder" {
                let _guard = lock(&data).unwrap();
                fs::write(data.join(format!("ready-{run}")), b"").unwrap();
                loop {
                    std::thread::sleep(Duration::from_secs(1));
                }
            }
            fs::write(data.join(format!("ready-{run}")), b"").unwrap();
            wait_for(&data.join("start-workers"));
            fs::write(data.join(format!("attempting-{run}")), b"").unwrap();
            let device = if run == "phone" {
                Device::Iphone
            } else {
                Device::Desktop
            };
            let answer = allow(&data, &id, device, &run, 2_000).map(|grant| grant.approval_id);
            fs::write(
                data.join(format!("answer-{run}")),
                serde_json::to_vec(&answer).unwrap(),
            )
            .unwrap();
            return;
        }

        struct Worker {
            child: Option<std::process::Child>,
            answer: std::path::PathBuf,
        }
        impl Worker {
            fn start(data: &Path, id: &str, run: &str) -> Self {
                let child = Command::new(std::env::current_exe().unwrap())
                    .args([
                        "--exact",
                        "chat_approvals::tests::approval_answers_are_exclusive_across_processes",
                        "--test-threads=1",
                    ])
                    .env("CHAT_APPROVAL_TEST_DATA", data)
                    .env("CHAT_APPROVAL_TEST_ID", id)
                    .env("CHAT_APPROVAL_TEST_RUN", run)
                    .stdout(std::process::Stdio::null())
                    .spawn()
                    .unwrap();
                Self {
                    child: Some(child),
                    answer: data.join(format!("answer-{run}")),
                }
            }

            fn finish(mut self) -> Result<String, String> {
                let deadline = Instant::now() + std::time::Duration::from_secs(10);
                while self.child.as_mut().unwrap().try_wait().unwrap().is_none() {
                    assert!(Instant::now() < deadline, "Approval worker did not finish");
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                assert!(self.child.take().unwrap().wait().unwrap().success());
                serde_json::from_slice(&fs::read(&self.answer).unwrap()).unwrap()
            }
        }
        impl Drop for Worker {
            fn drop(&mut self) {
                if let Some(mut child) = self.child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
            }
        }

        for rotation in ["none", "before-request", "on-answer"] {
            let data = Data::new();
            data.head("astra", "session-1");
            if rotation == "before-request" {
                fs::write(data.0.join(LOG_FILE), " ".repeat(LOG_ROTATE_BYTES as usize)).unwrap();
            }
            let request =
                submit(&data.0, "astra", "session-1", "run-1", proposal(), 1_000).unwrap();
            assert_eq!(
                data.0.join(ROTATED_LOG_FILE).exists(),
                rotation == "before-request"
            );
            if rotation == "on-answer" {
                OpenOptions::new()
                    .write(true)
                    .open(data.0.join(LOG_FILE))
                    .unwrap()
                    .set_len(LOG_ROTATE_BYTES)
                    .unwrap();
            }
            let refusal = if rotation == "on-answer" {
                "Chat has no record of this request. Ask the familiar again."
            } else {
                "This request was already answered."
            };

            // A different process already owns the ledger. An answer must wait
            // even after rotation replaced the log inode.
            let mut options = OpenOptions::new();
            options.read(true).write(true).create(true).truncate(false);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let held = options.open(data.0.join(LOCK_FILE)).unwrap();
            fs2::FileExt::lock_exclusive(&held).unwrap();
            let workers = ["desktop", "phone"].map(|run| Worker::start(&data.0, &request.id, run));
            for run in ["desktop", "phone"] {
                wait_for(&data.0.join(format!("ready-{run}")));
            }
            fs::write(data.0.join("start-workers"), b"").unwrap();
            for run in ["desktop", "phone"] {
                wait_for(&data.0.join(format!("attempting-{run}")));
            }
            std::thread::sleep(std::time::Duration::from_millis(250));
            assert!(
                workers.iter().all(|worker| !worker.answer.exists()),
                "An approval bypassed the other process's ledger lock"
            );
            drop(held);

            let answers = workers.map(Worker::finish);
            assert_eq!(answers.iter().filter(|answer| answer.is_ok()).count(), 1);
            assert!(answers
                .iter()
                .any(|answer| answer.as_ref().is_err_and(|error| error == refusal)));
            // A fresh process after both answerers exit must still see it spent.
            assert_eq!(
                Worker::start(&data.0, &request.id, "restarted").finish(),
                Err(refusal.into())
            );
            assert_eq!(
                recent(&data.0, 10)
                    .unwrap()
                    .iter()
                    .filter(|entry| entry.event == "allowed")
                    .count(),
                1
            );
        }

        // Killing a host while it owns the ledger must release the OS lock,
        // without spending the request or requiring deletion of the sidecar.
        let data = Data::new();
        data.head("astra", "session-1");
        let request = submit(&data.0, "astra", "session-1", "run-1", proposal(), 1_000).unwrap();
        let mut holder = Worker::start(&data.0, &request.id, "lock-holder");
        wait_for(&data.0.join("ready-lock-holder"));
        fs::write(data.0.join("start-workers"), b"").unwrap();
        assert_eq!(
            Worker::start(&data.0, &request.id, "blocked").finish(),
            Err(LOG_UNAVAILABLE.into())
        );
        let mut child = holder.child.take().unwrap();
        child.kill().unwrap();
        assert!(!child.wait().unwrap().success());
        assert_eq!(
            Worker::start(&data.0, &request.id, "after-kill").finish(),
            Ok(request.id.clone())
        );
        assert_eq!(
            Worker::start(&data.0, &request.id, "after-restart").finish(),
            Err("This request was already answered.".into())
        );
        assert_eq!(
            recent(&data.0, 10)
                .unwrap()
                .iter()
                .filter(|entry| entry.event == "allowed")
                .count(),
            1
        );
    }

    #[test]
    fn a_failed_log_rotation_cannot_authorize_a_turn() {
        let data = Data::new();
        data.head("astra", "session-1");
        let request = submit(&data.0, "astra", "session-1", "run-1", proposal(), 1_000).unwrap();
        OpenOptions::new()
            .write(true)
            .open(data.0.join(LOG_FILE))
            .unwrap()
            .set_len(LOG_ROTATE_BYTES)
            .unwrap();
        let rotated = data.0.join(ROTATED_LOG_FILE);
        fs::create_dir(&rotated).unwrap();
        fs::write(rotated.join("obstruction"), b"keep").unwrap();
        assert_eq!(
            allow(&data.0, &request.id, Device::Desktop, "run-2", 2_000),
            Err(LOG_UNAVAILABLE.into())
        );
        assert!(!read_file(&data.0.join(LOG_FILE))
            .unwrap()
            .iter()
            .any(|entry| entry.event == "allowed"));
        fs::remove_file(rotated.join("obstruction")).unwrap();
        fs::remove_dir(rotated).unwrap();
        assert!(allow(&data.0, &request.id, Device::Desktop, "run-2", 2_000).is_ok());
    }

    #[test]
    fn an_unavailable_process_lock_does_not_spend_the_request() {
        let data = Data::new();
        data.head("astra", "session-1");
        let request = submit(&data.0, "astra", "session-1", "run-1", proposal(), 1_000).unwrap();
        let path = data.0.join(LOCK_FILE);
        // Remove a previously created lock only in this single-process fixture.
        let _ = fs::remove_file(&path);
        fs::create_dir(&path).unwrap();
        assert_eq!(
            allow(&data.0, &request.id, Device::Desktop, "run-2", 2_000),
            Err(LOG_UNAVAILABLE.into())
        );
        fs::remove_dir(&path).unwrap();
        assert!(allow(&data.0, &request.id, Device::Desktop, "run-2", 2_000).is_ok());
    }

    #[test]
    fn a_busy_process_lock_times_out_without_spending_the_request() {
        let data = Data::new();
        data.head("astra", "session-1");
        let request = submit(&data.0, "astra", "session-1", "run-1", proposal(), 1_000).unwrap();
        let held = OpenOptions::new()
            .read(true)
            .write(true)
            .open(data.0.join(LOCK_FILE))
            .unwrap();
        fs2::FileExt::lock_exclusive(&held).unwrap();
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        let path = data.0.clone();
        let id = request.id.clone();
        let worker = std::thread::spawn(move || {
            let _ = send.send(allow(&path, &id, Device::Desktop, "run-2", 2_000));
        });
        let answer = receive.recv_timeout(LOCK_TIMEOUT + Duration::from_secs(10));
        // Release the peer before asserting, so even a regression to an
        // unbounded OS lock cannot strand this test's worker.
        drop(held);
        worker.join().unwrap();
        assert_eq!(answer.unwrap(), Err(LOG_UNAVAILABLE.into()));
        assert!(allow(&data.0, &request.id, Device::Desktop, "run-2", 2_000).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn a_process_lock_must_be_private_and_cannot_be_redirected() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let data = Data::new();
        data.head("astra", "session-1");
        let request = submit(&data.0, "astra", "session-1", "run-1", proposal(), 1_000).unwrap();
        let path = data.0.join(LOCK_FILE);
        fs::remove_file(&path).unwrap();
        let unrelated = data.0.join("unrelated");
        fs::write(&unrelated, "untouched").unwrap();
        symlink(&unrelated, &path).unwrap();
        assert_eq!(
            allow(&data.0, &request.id, Device::Desktop, "run-2", 2_000),
            Err(LOG_UNAVAILABLE.into())
        );
        assert_eq!(fs::read_to_string(&unrelated).unwrap(), "untouched");
        fs::remove_file(&path).unwrap();
        fs::write(&path, "").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        assert_eq!(
            allow(&data.0, &request.id, Device::Desktop, "run-2", 2_000),
            Err(LOG_UNAVAILABLE.into())
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(allow(&data.0, &request.id, Device::Desktop, "run-2", 2_000).is_ok());
    }
}
