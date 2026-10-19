//! Missions (#155): send one bounded, read-only familiar mission to Coven,
//! follow it, and cancel it.
//!
//! Chat reaches the mission contract (OpenCoven/coven#1313) only through the
//! installed CLI: the hidden `coven missions` commands and
//! `coven familiar-ledger history`. Coven decides every state. Chat checks that
//! each answer is about the mission, familiar and owner it asked about, drops
//! anything else, and never reports an answer it did not get as "nothing
//! happened".
//!
//! Adoption keys stay on this side; the window names a mission by its id.
//! Each record is kept in a private file in Chat's app data folder, as
//! docs/mission-storage-design.md describes, so Chat can learn a mission's
//! outcome after a restart. The file holds keys and bindings only, never a
//! task body.

use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{ipc::Channel, AppHandle, Manager, State};

use super::{
    blocking, home, pipe_reader, resolve_cli, stderr_text, tool_search_path, validate_id,
    OwnedChild, PipeData, ERROR_LIMIT,
};

/// The only envelope Chat offers: Coven's read-only R0 launch.
const ENVELOPE_ID: &str = "r0-read.1";
const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);
/// A mission command answer is at most 64 KiB; a view, far less.
const OUTPUT_LIMIT: usize = 256 * 1024;
const STATEMENT_LIMIT: usize = 200;
const PROMPT_LIMIT: usize = 32 * 1024;
const PATH_LIMIT: usize = 4096;
/// How long Coven may take to begin a submit. Coven allows at most 15 minutes.
const VALIDITY: Duration = Duration::from_secs(10 * 60);
/// Sends of one command whose answer never arrived, all with the same key.
const SENDS: usize = 3;
const WATCH_INTERVAL: Duration = Duration::from_secs(1);
const RECORD_LIMIT: usize = 100;
const WATCH_LIMIT: usize = 4;

const STATES: &[&str] = &[
    "queued",
    "running",
    "needs_approval",
    "cancelling",
    "reconciling",
    "completed",
    "failed",
    "cancelled",
    "rejected",
    "revoked",
    "unavailable",
];
const TERMINAL_STATES: &[&str] = &[
    "completed",
    "failed",
    "cancelled",
    "rejected",
    "revoked",
    "unavailable",
];
const REASONED_STATES: &[&str] = &[
    "failed",
    "rejected",
    "revoked",
    "unavailable",
    "reconciling",
];
const REASONS: &[&str] = &[
    "timeout",
    "harness_failed",
    "familiar_revision_stale",
    "familiar_revision_revoked",
    "grant_revoked",
    "envelope_unsupported",
    "expired_before_dispatch",
    "authority_unavailable",
    "runtime_unavailable",
    "ambiguous_execution",
];
const CANCEL_OUTCOMES: &[&str] = &[
    "cancelled",
    "pending",
    "lost_to_completion",
    "recovery_required",
];
const OBSERVATIONS: &[&str] = &["complete", "partial", "unknown"];

// ---------------------------------------------------------------------------
// Running the CLI

/// What one `coven` invocation printed and how it ended. `code` is `None`
/// when the process was stopped by a signal.
#[derive(Debug, Clone, PartialEq)]
pub(super) struct CliOutput {
    pub(super) code: Option<i32>,
    pub(super) stdout: Vec<u8>,
    pub(super) stderr: String,
}

/// Why an invocation has no exit status to read.
#[derive(Debug, Clone, PartialEq)]
pub(super) enum RunFailure {
    /// The process never started, so nothing reached Coven.
    NotStarted(String),
    /// It started and was stopped or lost before it finished: a command it
    /// carried may have reached Coven.
    Interrupted(String),
}

/// Runs one `coven` command for the mission contract.
type Run<'a> = &'a dyn Fn(&[&str], Option<&[u8]>) -> Result<CliOutput, RunFailure>;

fn coven(
    args: &[&str],
    input: Option<&[u8]>,
    cancel: &AtomicBool,
) -> Result<CliOutput, RunFailure> {
    let mut command = Command::new(resolve_cli().map_err(RunFailure::NotStarted)?);
    command
        .args(args)
        .env("NO_COLOR", "1")
        .env("PATH", tool_search_path().map_err(RunFailure::NotStarted)?)
        .current_dir(home().map_err(RunFailure::NotStarted)?);
    execute(command, input, cancel, COMMAND_TIMEOUT)
}

/// Runs `command` contained like every Coven process Chat starts, writes
/// `input` to its stdin, and keeps stdout whatever the exit status: the
/// mission commands print their typed refusals there.
fn execute(
    mut command: Command,
    input: Option<&[u8]>,
    cancel: &AtomicBool,
    timeout: Duration,
) -> Result<CliOutput, RunFailure> {
    if cancel.load(Ordering::SeqCst) {
        return Err(RunFailure::NotStarted(
            "Stopped before Coven was asked.".into(),
        ));
    }
    command
        .stdin(if input.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = OwnedChild::spawn(&mut command, "Could not launch installed Coven CLI.")
        .map_err(RunFailure::NotStarted)?;
    // From here on the CLI may have reached Coven.
    let lost = |message: &str| RunFailure::Interrupted(message.to_owned());
    if let (Some(bytes), Some(mut stdin)) = (input, child.0.stdin.take()) {
        let bytes = bytes.to_vec();
        // A failed write shows up as the CLI's own answer about the payload.
        thread::Builder::new()
            .name("coven-mission-input".into())
            .spawn(move || {
                let _ = stdin.write_all(&bytes);
            })
            .map_err(|_| lost("Could not hand the mission to Coven."))?;
    }
    let (sender, receiver) = mpsc::sync_channel(16);
    let stdout = child
        .0
        .stdout
        .take()
        .ok_or_else(|| lost("Coven stdout is unavailable."))?;
    let stderr = child
        .0
        .stderr
        .take()
        .ok_or_else(|| lost("Coven stderr is unavailable."))?;
    let _stdout = pipe_reader(stdout, false, sender.clone())
        .map_err(|_| lost("Cannot read Coven output."))?;
    let _stderr =
        pipe_reader(stderr, true, sender).map_err(|_| lost("Cannot read Coven diagnostics."))?;
    let deadline = Instant::now() + timeout;
    let (mut output, mut errors) = (Vec::new(), Vec::new());
    let (mut ended, mut status) = (0, None);
    while ended < 2 || status.is_none() {
        if cancel.load(Ordering::SeqCst) {
            return Err(lost("Stopped while Coven was answering."));
        }
        if Instant::now() >= deadline {
            return Err(lost("Coven did not answer in time."));
        }
        status = child
            .0
            .try_wait()
            .map_err(|_| lost("Could not inspect Coven process."))?;
        child.1 = status.is_some();
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(PipeData::End) => ended += 1,
            Ok(PipeData::Error) => return Err(lost("Could not read Coven process output.")),
            Ok(PipeData::Bytes(true, bytes)) => {
                let room = ERROR_LIMIT.saturating_sub(errors.len());
                errors.extend_from_slice(&bytes[..bytes.len().min(room)]);
            }
            Ok(PipeData::Bytes(false, bytes)) => {
                if output.len() + bytes.len() > OUTPUT_LIMIT {
                    return Err(lost("Coven's answer exceeded the local safety limit."));
                }
                output.extend_from_slice(&bytes);
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) if ended == 2 => {
                thread::sleep(Duration::from_millis(20));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(lost("Coven output closed unexpectedly."))
            }
        }
    }
    Ok(CliOutput {
        code: status.and_then(|status| status.code()),
        stdout: output,
        stderr: stderr_text(&errors),
    })
}

/// The single JSON object a command printed, if it printed exactly one.
fn printed_object(stdout: &[u8]) -> Option<Value> {
    let value: Value = serde_json::from_slice(stdout).ok()?;
    value.is_object().then_some(value)
}

fn printed_nothing(stdout: &[u8]) -> bool {
    stdout.iter().all(u8::is_ascii_whitespace)
}

// ---------------------------------------------------------------------------
// Identifiers and time

fn lower_hex(text: &str, length: usize) -> bool {
    text.len() == length && text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn root_id(text: &str) -> bool {
    text.strip_prefix("familiar:")
        .is_some_and(|hex| lower_hex(hex, 32))
}

fn revision_id(text: &str) -> bool {
    text.len() <= 128
        && text.strip_prefix("familiar-revision:").is_some_and(|rest| {
            rest.split_once(':').is_some_and(|(hex, position)| {
                lower_hex(hex, 32)
                    && !position.is_empty()
                    && position.len() <= 12
                    && position.bytes().all(|b| b.is_ascii_digit())
            })
        })
}

pub(super) fn mission_id_shape(text: &str) -> bool {
    text.strip_prefix("mission-")
        .is_some_and(|hex| lower_hex(hex, 32))
}

/// The id Coven gives the submit with `key`: `mission-` and the first 32 hex
/// digits of SHA-256 over the key.
fn mission_id_for(key: &str) -> String {
    let digest = Sha256::digest(key.as_bytes());
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("mission-{}", &hex[..32])
}

fn new_key(prefix: &str) -> String {
    format!("{prefix}:{}", uuid::Uuid::new_v4())
}

/// `at` as the millisecond UTC timestamp Coven accepts.
fn timestamp(at: SystemTime) -> String {
    let since = at.duration_since(UNIX_EPOCH).unwrap_or_default();
    let (seconds, millis) = (since.as_secs() as i64, since.subsec_millis());
    let (days, of_day) = (seconds.div_euclid(86_400), seconds.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (H. Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        of_day / 3600,
        of_day % 3600 / 60,
        of_day % 60
    )
}

/// The instant a timestamp in `timestamp`'s form names.
fn parse_timestamp(text: &str) -> Option<SystemTime> {
    let bytes = text.as_bytes();
    if bytes.len() != 24 || &text[23..] != "Z" || [4, 7].iter().any(|&at| bytes[at] != b'-') {
        return None;
    }
    if bytes[10] != b'T' || bytes[13] != b':' || bytes[16] != b':' || bytes[19] != b'.' {
        return None;
    }
    let number = |range: std::ops::Range<usize>| -> Option<i64> {
        let digits = text.get(range)?;
        digits
            .bytes()
            .all(|b| b.is_ascii_digit())
            .then(|| digits.parse().ok())?
    };
    let (year, month, day) = (number(0..4)?, number(5..7)?, number(8..10)?);
    let (hour, minute, second, millis) = (
        number(11..13)?,
        number(14..16)?,
        number(17..19)?,
        number(20..23)?,
    );
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    // Days since 1970-01-01 from a civil date (H. Hinnant's algorithm).
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let days = era * 146_097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719_468;
    let millis = ((days * 86_400 + hour * 3600 + minute * 60 + second) * 1000) + millis;
    let at = UNIX_EPOCH + Duration::from_millis(u64::try_from(millis).ok()?);
    (timestamp(at) == text).then_some(at)
}

// ---------------------------------------------------------------------------
// What the window sees

/// A mission as Coven reports it, after Chat checked it is the one it asked
/// about. The prompt is never part of it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MissionView {
    mission_id: String,
    familiar_id: String,
    revision: u64,
    state: String,
    terminal: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    root_id: String,
    revision_id: String,
    principal_id: String,
    statement: String,
    project_cwd: String,
    submitted_at: String,
    valid_until: String,
    attempts: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    cancellation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<MissionResult>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MissionResult {
    outcome: String,
    settled_at: String,
    observation: String,
    reports: usize,
    /// Token and cost figures exactly as the harness reported them, or `None`
    /// when it reported none. Never estimated.
    usage: Option<Value>,
}

/// One answer about one mission.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum MissionAnswer {
    /// Coven's current view of the mission.
    View { mission: Box<MissionView> },
    /// Coven refused the command and changed nothing.
    Refused {
        code: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        current_revision_id: Option<String>,
    },
    /// The command never reached Coven.
    NotSent { message: String },
    /// No answer proved what happened yet. Chat keeps checking with the same
    /// key; it never treats this as "nothing happened".
    Checking { mission_id: String },
    /// The submit never reached Coven: Coven has no such mission, and the time
    /// in which it could have accepted one has passed. Nothing ran.
    NeverSent { mission_id: String },
    /// Coven no longer has a mission it once accepted, for example because
    /// Chat now talks to a different Coven home.
    Gone { mission_id: String },
    /// The mission had already finished, so there was nothing to cancel.
    Settled { mission: Box<MissionView> },
    /// The answer was about a different mission, familiar or owner, and was
    /// dropped.
    Mismatch { mission_id: String },
}

/// Whether a familiar can take a mission, and what the window must show the
/// person before they send one.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub(crate) enum MissionPreparation {
    Ready {
        familiar_id: String,
        root_id: String,
        revision_id: String,
        envelope_id: &'static str,
        envelope_digest: String,
    },
    Unavailable {
        /// `update-coven`, `coven-not-ready`, `no-read-envelope`,
        /// `familiar-unregistered`, `familiar-inactive` or `ledger-unreadable`.
        reason: &'static str,
        detail: String,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MissionEntry {
    mission_id: String,
    phase: Phase,
}

// ---------------------------------------------------------------------------
// Records

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Phase {
    /// Written before the submit is sent; no answer has proved a commit.
    Sending,
    Committed,
    Terminal,
}

#[derive(Debug, Clone)]
struct Record {
    key: String,
    mission_id: String,
    familiar_id: String,
    root_id: String,
    revision_id: String,
    principal_id: Option<String>,
    phase: Phase,
    valid_until: SystemTime,
    created_at: SystemTime,
    /// The exact submit body, kept in memory only, so an unanswered submit is
    /// sent again unchanged.
    payload: Option<Vec<u8>>,
    cancel_key: Option<String>,
}

#[derive(Default)]
pub(crate) struct Missions {
    records: Mutex<HashMap<String, Record>>,
    watches: Mutex<HashMap<String, Arc<AtomicBool>>>,
    store: Mutex<Store>,
}

#[derive(Default, Clone)]
pub(crate) struct MissionState(Arc<Missions>);

impl Drop for Missions {
    fn drop(&mut self) {
        if let Ok(watches) = self.watches.lock() {
            for stop in watches.values() {
                stop.store(true, Ordering::SeqCst);
            }
        }
    }
}

const STATE_UNAVAILABLE: &str = "Chat's mission list is unavailable.";

impl Missions {
    /// Records a mission before anything is sent for it. If the record can't
    /// be saved, it is dropped again and nothing is sent.
    fn insert(&self, record: Record) -> Result<(), String> {
        let mission_id = record.mission_id.clone();
        let mut evicted = None;
        {
            let mut records = self.records.lock().map_err(|_| STATE_UNAVAILABLE)?;
            if records.len() >= RECORD_LIMIT {
                let oldest = records
                    .values()
                    .filter(|record| record.phase == Phase::Terminal)
                    .min_by_key(|record| record.created_at)
                    .map(|record| record.mission_id.clone())
                    .ok_or("Chat is already following 100 unfinished missions. Wait for one to finish, then try again.")?;
                evicted = records.remove(&oldest);
            }
            records.insert(mission_id.clone(), record);
        }
        if let Err(error) = self.save() {
            let mut records = self.records.lock().map_err(|_| STATE_UNAVAILABLE)?;
            records.remove(&mission_id);
            if let Some(evicted) = evicted {
                records.insert(evicted.mission_id.clone(), evicted);
            }
            return Err(error);
        }
        Ok(())
    }

    fn record(&self, mission_id: &str) -> Result<Record, String> {
        self.records
            .lock()
            .map_err(|_| STATE_UNAVAILABLE)?
            .get(mission_id)
            .cloned()
            .ok_or_else(|| "Chat didn't send this mission, so it won't read it.".into())
    }

    /// Changes a record and saves it. The change stays in memory even when
    /// the save fails, and the error says so.
    fn update(&self, mission_id: &str, change: impl FnOnce(&mut Record)) -> Result<(), String> {
        {
            let mut records = self.records.lock().map_err(|_| STATE_UNAVAILABLE)?;
            if let Some(record) = records.get_mut(mission_id) {
                change(record);
            }
        }
        self.save()
    }

    fn remove(&self, mission_id: &str) -> Result<(), String> {
        self.records
            .lock()
            .map_err(|_| STATE_UNAVAILABLE)?
            .remove(mission_id);
        self.save()
    }

    /// Saves what an answer proved. The answer is shown whatever happens to
    /// the file: a record that stays behind is settled again after a restart.
    fn settle(&self, result: Result<(), String>) {
        if let Err(error) = result {
            eprintln!("Coven Chat: a mission record could not be saved ({error}).");
        }
    }

    fn list(&self, familiar_id: &str) -> Result<Vec<MissionEntry>, String> {
        let records = self.records.lock().map_err(|_| STATE_UNAVAILABLE)?;
        let mut mine: Vec<&Record> = records
            .values()
            .filter(|record| record.familiar_id == familiar_id)
            .collect();
        mine.sort_by_key(|record| std::cmp::Reverse(record.created_at));
        Ok(mine
            .into_iter()
            .map(|record| MissionEntry {
                mission_id: record.mission_id.clone(),
                phase: record.phase,
            })
            .collect())
    }

    /// Records what a view proved: the mission exists, under this owner.
    fn observed(&self, view: &MissionView) -> Result<(), String> {
        let result = self.update(&view.mission_id, |record| {
            record.principal_id = Some(view.principal_id.clone());
            record.payload = None;
            record.phase = if view.terminal {
                Phase::Terminal
            } else {
                Phase::Committed
            };
        });
        self.settle(result);
        Ok(())
    }

    /// Forgets a mission the person removed. One Chat is still settling
    /// can't be removed.
    fn forget(&self, mission_id: &str) -> Result<(), String> {
        if self.record(mission_id)?.phase == Phase::Sending {
            return Err("Chat is still checking whether Coven received this mission, so it can't be removed yet.".into());
        }
        self.remove(mission_id)
    }

    /// Opens the record file in `data`, loading what an earlier run of Chat
    /// kept. Until the file is readable, every mission command refuses.
    fn open(&self, data: &Path) -> Result<(), String> {
        let mut store = self.store.lock().map_err(|_| STATE_UNAVAILABLE)?;
        let folder = data.join(STORE_FOLDER);
        if store.open && store.folder.as_deref() == Some(folder.as_path()) {
            return Ok(());
        }
        let kept = load(&folder)?;
        let mut records = self.records.lock().map_err(|_| STATE_UNAVAILABLE)?;
        for record in kept {
            records.entry(record.mission_id.clone()).or_insert(record);
        }
        store.folder = Some(folder);
        store.open = true;
        Ok(())
    }

    fn save(&self) -> Result<(), String> {
        let store = self.store.lock().map_err(|_| STATE_UNAVAILABLE)?;
        let Some(folder) = store.folder.as_deref().filter(|_| store.open) else {
            return Ok(());
        };
        let records = self.records.lock().map_err(|_| STATE_UNAVAILABLE)?;
        let mut kept: Vec<&Record> = records.values().collect();
        kept.sort_by_key(|record| record.created_at);
        let file = KeptRecords {
            version: 1,
            missions: kept.into_iter().map(KeptRecord::from).collect(),
        };
        let bytes =
            serde_json::to_vec(&file).map_err(|_| "Chat could not encode its mission list.")?;
        persist(folder, &bytes)
    }
}

// ---------------------------------------------------------------------------
// The record file (docs/mission-storage-design.md)

const STORE_FOLDER: &str = "coven-missions";
const STORE_FILE: &str = "missions-v1.json";
const STORE_LIMIT: usize = 64 * 1024;
const UNREADABLE: &str = "Chat can't read its mission list, so it won't send or follow missions until the list is readable. Chat left the file unchanged.";

#[derive(Default)]
struct Store {
    folder: Option<PathBuf>,
    open: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeptRecords {
    version: u32,
    missions: Vec<KeptRecord>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeptFamiliar {
    familiar_id: String,
    root_id: String,
    revision_id: String,
}

/// One record as it is kept: keys and bindings, never a task body.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct KeptRecord {
    adoption_key: String,
    mission_id: String,
    familiar: KeptFamiliar,
    principal_id: Option<String>,
    phase: Phase,
    valid_until: String,
    cancel_key: Option<String>,
    created_at: String,
}

impl From<&Record> for KeptRecord {
    fn from(record: &Record) -> Self {
        Self {
            adoption_key: record.key.clone(),
            mission_id: record.mission_id.clone(),
            familiar: KeptFamiliar {
                familiar_id: record.familiar_id.clone(),
                root_id: record.root_id.clone(),
                revision_id: record.revision_id.clone(),
            },
            principal_id: record.principal_id.clone(),
            phase: record.phase,
            valid_until: timestamp(record.valid_until),
            cancel_key: record.cancel_key.clone(),
            created_at: timestamp(record.created_at),
        }
    }
}

fn key_shape(key: &str, prefix: &str) -> bool {
    key.strip_prefix(prefix)
        .and_then(|rest| rest.strip_prefix(':'))
        .is_some_and(|uuid| uuid::Uuid::parse_str(uuid).is_ok() && uuid.len() == 36)
}

impl KeptRecord {
    fn record(self) -> Option<Record> {
        let familiar = self.familiar;
        let valid = key_shape(&self.adoption_key, "chat-mission")
            && self.mission_id == mission_id_for(&self.adoption_key)
            && validate_id(&familiar.familiar_id).is_ok()
            && root_id(&familiar.root_id)
            && revision_id(&familiar.revision_id)
            && self
                .principal_id
                .as_deref()
                .is_none_or(|principal| !principal.is_empty() && principal.len() <= 200)
            && self
                .cancel_key
                .as_deref()
                .is_none_or(|key| key_shape(key, "chat-mission-cancel"));
        valid.then_some(Record {
            key: self.adoption_key,
            mission_id: self.mission_id,
            familiar_id: familiar.familiar_id,
            root_id: familiar.root_id,
            revision_id: familiar.revision_id,
            principal_id: self.principal_id,
            phase: self.phase,
            valid_until: parse_timestamp(&self.valid_until)?,
            created_at: parse_timestamp(&self.created_at)?,
            payload: None,
            cancel_key: self.cancel_key,
        })
    }
}

/// The records an earlier run kept in `folder`, or none when it never kept
/// any. A file that is not exactly what Chat writes is refused, and left as
/// it is: its keys may be the only way to learn a mission's outcome.
fn load(folder: &Path) -> Result<Vec<Record>, String> {
    let path = folder.join(STORE_FILE);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(_) => return Err(UNREADABLE.into()),
    };
    if !metadata.is_file() || metadata.len() > STORE_LIMIT as u64 {
        return Err(UNREADABLE.into());
    }
    let mut bytes = Vec::new();
    File::open(&path)
        .and_then(|file| file.take(STORE_LIMIT as u64 + 1).read_to_end(&mut bytes))
        .map_err(|_| UNREADABLE)?;
    let kept: KeptRecords = serde_json::from_slice(&bytes).map_err(|_| UNREADABLE)?;
    if kept.version != 1 || kept.missions.len() > RECORD_LIMIT {
        return Err(UNREADABLE.into());
    }
    let records: Vec<Record> = kept
        .missions
        .into_iter()
        .map(KeptRecord::record)
        .collect::<Option<_>>()
        .ok_or(UNREADABLE)?;
    let mut ids: Vec<&str> = records
        .iter()
        .map(|record| record.mission_id.as_str())
        .collect();
    ids.sort_unstable();
    ids.dedup();
    if ids.len() != records.len() {
        return Err(UNREADABLE.into());
    }
    Ok(records)
}

/// Writes the record file in a private folder: a new temporary file, synced,
/// renamed into place, then the folder synced.
fn persist(folder: &Path, bytes: &[u8]) -> Result<(), String> {
    const FAILED: &str = "Chat could not save its mission list, so nothing was sent.";
    if bytes.len() > STORE_LIMIT {
        return Err(FAILED.into());
    }
    match fs::symlink_metadata(folder) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => return Err(FAILED.into()),
        Err(_) => {
            let mut builder = fs::DirBuilder::new();
            builder.recursive(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder.create(folder).map_err(|_| FAILED)?;
        }
    }
    let temporary = folder.join(format!("missions-{}.tmp", uuid::Uuid::new_v4()));
    let write = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(|_| FAILED)?;
        file.write_all(bytes).map_err(|_| FAILED)?;
        file.sync_all().map_err(|_| FAILED)?;
        fs::rename(&temporary, folder.join(STORE_FILE)).map_err(|_| FAILED)?;
        #[cfg(unix)]
        File::open(folder)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| FAILED)?;
        Ok::<_, String>(())
    })();
    if write.is_err() && temporary.exists() {
        let _ = fs::remove_file(&temporary);
    }
    write
}

// ---------------------------------------------------------------------------
// Reading Coven's answers

fn text_field<'a>(value: &'a Value, pointer: &str, limit: usize) -> Result<&'a str, String> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|text| !text.is_empty() && text.chars().count() <= limit)
        .ok_or_else(|| "Coven returned an invalid mission view.".into())
}

fn one_of(value: &Value, pointer: &str, allowed: &[&str]) -> Result<String, String> {
    value
        .pointer(pointer)
        .and_then(Value::as_str)
        .filter(|text| allowed.contains(text))
        .map(str::to_owned)
        .ok_or_else(|| "Coven returned an invalid mission view.".into())
}

/// Token and cost figures, kept only as the non-negative numbers Coven's view
/// defines.
fn usage(value: &Value) -> Result<Option<Value>, String> {
    if value.is_null() {
        return Ok(None);
    }
    let invalid = || "Coven returned an invalid mission view.".to_owned();
    let fields = value.as_object().ok_or_else(invalid)?;
    if fields.get("source").and_then(Value::as_str) != Some("harness_result_event") {
        return Err(invalid());
    }
    let mut kept = serde_json::Map::new();
    for (name, number) in fields {
        match name.as_str() {
            "source" => {}
            "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" => {
                kept.insert(name.clone(), json!(number.as_u64().ok_or_else(invalid)?));
            }
            "costUsd" => {
                let cost = number
                    .as_f64()
                    .filter(|cost| *cost >= 0.0)
                    .ok_or_else(invalid)?;
                kept.insert(name.clone(), json!(cost));
            }
            _ => return Err(invalid()),
        }
    }
    Ok(Some(Value::Object(kept)))
}

/// The view, if it is shaped as Coven's mission view and is consistent.
fn parse_view(value: &Value, familiar_id: &str) -> Result<MissionView, String> {
    let invalid = || "Coven returned an invalid mission view.".to_owned();
    let mission_id = text_field(value, "/missionId", 40)?;
    if !mission_id_shape(mission_id) {
        return Err(invalid());
    }
    let state = one_of(value, "/state", STATES)?;
    let terminal = value
        .get("terminal")
        .and_then(Value::as_bool)
        .ok_or_else(invalid)?;
    if terminal != TERMINAL_STATES.contains(&state.as_str()) {
        return Err(invalid());
    }
    let reason = match value.get("reason") {
        None => None,
        Some(_) => Some(one_of(value, "/reason", REASONS)?),
    };
    if reason.is_some() != REASONED_STATES.contains(&state.as_str()) {
        return Err(invalid());
    }
    let result = match value.get("result") {
        None => None,
        Some(result) => {
            let outcome = one_of(result, "/outcome", TERMINAL_STATES)?;
            if outcome != state {
                return Err(invalid());
            }
            Some(MissionResult {
                outcome,
                settled_at: text_field(result, "/settledAt", 40)?.to_owned(),
                observation: one_of(result, "/observation", OBSERVATIONS)?,
                reports: result
                    .get("artifacts")
                    .and_then(Value::as_array)
                    .ok_or_else(invalid)?
                    .len(),
                usage: usage(result.get("usage").ok_or_else(invalid)?)?,
            })
        }
    };
    if result.is_some() != terminal {
        return Err(invalid());
    }
    let root = text_field(value, "/familiar/rootId", 41)?;
    let revision = text_field(value, "/familiar/revisionId", 128)?;
    if !root_id(root) || !revision_id(revision) {
        return Err(invalid());
    }
    let cancellation = match value.get("cancellation") {
        None => None,
        Some(_) => Some(one_of(value, "/cancellation/outcome", CANCEL_OUTCOMES)?),
    };
    Ok(MissionView {
        mission_id: mission_id.to_owned(),
        familiar_id: familiar_id.to_owned(),
        revision: value
            .get("revision")
            .and_then(Value::as_u64)
            .ok_or_else(invalid)?,
        state,
        terminal,
        reason,
        root_id: root.to_owned(),
        revision_id: revision.to_owned(),
        principal_id: text_field(value, "/principal/principalId", 200)?.to_owned(),
        statement: text_field(value, "/task/statement", STATEMENT_LIMIT)?.to_owned(),
        project_cwd: text_field(value, "/project/cwd", PATH_LIMIT)?.to_owned(),
        submitted_at: text_field(value, "/submittedAt", 40)?.to_owned(),
        valid_until: text_field(value, "/validUntil", 40)?.to_owned(),
        attempts: value
            .get("attempts")
            .and_then(Value::as_array)
            .ok_or_else(invalid)?
            .len(),
        cancellation,
        result,
    })
}

/// The view if it is this record's mission, for its familiar revision and its
/// owner. `None` drops it (M-11 b).
fn bound(record: &Record, value: &Value) -> Result<Option<MissionView>, String> {
    let view = parse_view(value, &record.familiar_id)?;
    let owner_matches = record
        .principal_id
        .as_deref()
        .is_none_or(|principal| principal == view.principal_id);
    Ok((view.mission_id == record.mission_id
        && view.root_id == record.root_id
        && view.revision_id == record.revision_id
        && owner_matches)
        .then_some(view))
}

/// How a mission command's answer reads.
#[derive(Debug, PartialEq)]
enum Reply {
    /// `committed` or `replayed`: the command response as Coven sent it.
    Applied(Value),
    /// A typed refusal; nothing was committed.
    Refused(Value),
    NotSent(String),
    /// Nothing proves what happened.
    Unknown,
}

fn command_reply(output: &CliOutput, command: &str, key: &str) -> Reply {
    let response = printed_object(&output.stdout);
    let about = |response: &Value| {
        response.get("command").and_then(Value::as_str) == Some(command)
            && response.get("adoptionKey").and_then(Value::as_str) == Some(key)
    };
    match output.code {
        Some(0) => match response {
            Some(response)
                if about(&response)
                    && matches!(
                        response.get("outcome").and_then(Value::as_str),
                        Some("committed" | "replayed")
                    )
                    && response.get("result").is_some_and(Value::is_object) =>
            {
                Reply::Applied(response)
            }
            _ => Reply::Unknown,
        },
        // `coven missions` prints nothing on stdout only when it sent
        // nothing: a payload it refused, or no daemon to reach.
        Some(1) if printed_nothing(&output.stdout) => Reply::NotSent(output.stderr.clone()),
        Some(1) => match response {
            Some(response)
                if about(&response)
                    && response.get("outcome").and_then(Value::as_str) == Some("rejected")
                    && response
                        .pointer("/error/code")
                        .is_some_and(Value::is_string) =>
            {
                Reply::Refused(response["error"].clone())
            }
            _ => Reply::Unknown,
        },
        // A usage error: this Coven has no such command, so nothing was sent.
        Some(2) => Reply::NotSent(UPDATE_COVEN.into()),
        _ => Reply::Unknown,
    }
}

const UPDATE_COVEN: &str =
    "This version of Coven can't take missions. Update Coven, then try again.";

fn refusal(error: &Value) -> MissionAnswer {
    MissionAnswer::Refused {
        code: error["code"].as_str().unwrap_or("UNKNOWN").to_owned(),
        message: error["message"]
            .as_str()
            .unwrap_or("Coven refused the mission.")
            .chars()
            .take(2048)
            .collect(),
        current_revision_id: error
            .pointer("/details/currentRevisionId")
            .and_then(Value::as_str)
            .filter(|revision| revision_id(revision))
            .map(str::to_owned),
    }
}

// ---------------------------------------------------------------------------
// Preparing

/// The newest Coven release without `coven missions`. Such a Coven reads
/// `coven missions …` as a task to cast rather than a command, so Chat never
/// sends it one.
const LAST_RELEASE_WITHOUT_MISSIONS: (u64, u64, u64) = (0, 4, 10);

/// The release a `coven --version` line names, such as `coven v0.4.10 (…)`.
/// A development build names no release.
fn release(version: &[u8]) -> Option<(u64, u64, u64)> {
    let line = std::str::from_utf8(version).ok()?;
    let mut parts = line
        .split_whitespace()
        .nth(1)?
        .strip_prefix('v')?
        .split('.');
    let mut number = || parts.next()?.parse::<u64>().ok();
    let release = (number()?, number()?, number()?);
    parts.next().is_none().then_some(release)
}

fn prepare(run: Run, familiar_id: &str) -> Result<MissionPreparation, String> {
    validate_id(familiar_id)?;
    let unavailable = |reason: &'static str, detail: String| {
        Ok(MissionPreparation::Unavailable { reason, detail })
    };
    match run(&["--version"], None) {
        Err(RunFailure::NotStarted(detail)) => return unavailable("coven-not-ready", detail),
        Ok(output)
            if output.code == Some(0)
                && release(&output.stdout)
                    .is_some_and(|release| release <= LAST_RELEASE_WITHOUT_MISSIONS) =>
        {
            return unavailable(
                "update-coven",
                String::from_utf8_lossy(&output.stdout).trim().to_owned(),
            );
        }
        _ => {}
    }
    let output = match run(&["missions", "envelopes", "--json"], None) {
        Ok(output) => output,
        Err(RunFailure::NotStarted(detail) | RunFailure::Interrupted(detail)) => {
            return unavailable("coven-not-ready", detail)
        }
    };
    let envelope_digest = match output.code {
        Some(0) => printed_object(&output.stdout)
            .and_then(|printed| {
                printed["envelopes"]
                    .as_array()?
                    .iter()
                    .find(|envelope| envelope["id"] == ENVELOPE_ID)
                    .cloned()
            })
            .filter(|envelope| {
                envelope["descriptorDigest"]["algorithm"] == "sha256"
                    && envelope["descriptorDigest"]["canonicalization"] == "jcs-rfc8785"
            })
            .and_then(|envelope| {
                envelope["descriptorDigest"]["value"]
                    .as_str()
                    .filter(|value| lower_hex(value, 64))
                    .map(str::to_owned)
            }),
        Some(2) => return unavailable("update-coven", output.stderr),
        // No daemon, and a Coven too old to have the command, both exit 1 with
        // nothing printed. Asking the command for its own help needs no daemon.
        Some(1) if printed_nothing(&output.stdout) => {
            let knows_it = run(&["missions", "envelopes", "--help"], None)
                .is_ok_and(|help| help.code == Some(0));
            return if knows_it {
                unavailable("coven-not-ready", output.stderr)
            } else {
                unavailable("update-coven", output.stderr)
            };
        }
        _ => return unavailable("coven-not-ready", output.stderr),
    };
    let Some(envelope_digest) = envelope_digest else {
        return unavailable("no-read-envelope", String::new());
    };

    let output = match run(&["familiar-ledger", "history", familiar_id, "--json"], None) {
        Ok(output) if output.code == Some(0) => output,
        Ok(output) => return unavailable("ledger-unreadable", output.stderr),
        Err(RunFailure::NotStarted(detail) | RunFailure::Interrupted(detail)) => {
            return unavailable("ledger-unreadable", detail)
        }
    };
    let Some(history) = printed_object(&output.stdout) else {
        return unavailable(
            "ledger-unreadable",
            "Coven returned an invalid familiar history.".into(),
        );
    };
    let Some(root) = history["roots"].as_array().and_then(|roots| {
        roots
            .iter()
            .find(|root| root["familiarId"] == familiar_id && root["retiredAt"].is_null())
    }) else {
        return unavailable("familiar-unregistered", String::new());
    };
    let head = root["revisions"]
        .as_array()
        .and_then(|revisions| revisions.last());
    let (Some(root), Some(revision)) = (
        root["rootId"].as_str().filter(|root| root_id(root)),
        head.and_then(|head| head["revisionId"].as_str())
            .filter(|revision| revision_id(revision)),
    ) else {
        return unavailable(
            "ledger-unreadable",
            "Coven returned an invalid familiar history.".into(),
        );
    };
    if head.and_then(|head| head["status"].as_str()) != Some("active") {
        return unavailable("familiar-inactive", String::new());
    }
    Ok(MissionPreparation::Ready {
        familiar_id: familiar_id.to_owned(),
        root_id: root.to_owned(),
        revision_id: revision.to_owned(),
        envelope_id: ENVELOPE_ID,
        envelope_digest,
    })
}

// ---------------------------------------------------------------------------
// Submitting

/// What the person reviewed and asked for.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SubmitInput {
    familiar_id: String,
    root_id: String,
    revision_id: String,
    envelope_digest: String,
    project_cwd: String,
    statement: String,
    prompt: String,
    timeout_minutes: u32,
}

/// The submit payload, after the bounds Coven also enforces (M-15). Chat
/// checks them first so the person gets a clear message and Coven gets a
/// payload it can take.
fn submit_payload(input: &SubmitInput, now: SystemTime) -> Result<(Vec<u8>, SystemTime), String> {
    validate_id(&input.familiar_id)?;
    if !root_id(&input.root_id) || !revision_id(&input.revision_id) {
        return Err("This familiar's Coven identity is invalid. Review the mission again.".into());
    }
    if !lower_hex(&input.envelope_digest, 64) {
        return Err("The mission's runtime is invalid. Review the mission again.".into());
    }
    let statement = input.statement.trim();
    if statement.is_empty() || statement.chars().count() > STATEMENT_LIMIT {
        return Err(format!(
            "Give the mission a title of 1 to {STATEMENT_LIMIT} characters."
        ));
    }
    if input.prompt.trim().is_empty() || input.prompt.len() > PROMPT_LIMIT {
        return Err("Describe what to diagnose in 1 byte to 32 KiB.".into());
    }
    if !(1..=60).contains(&input.timeout_minutes) {
        return Err("Choose a time limit from 1 to 60 minutes.".into());
    }
    let path = Path::new(&input.project_cwd);
    if input.project_cwd.len() > PATH_LIMIT || !path.is_absolute() {
        return Err("Choose a project folder by its full path.".into());
    }
    let cwd = path
        .canonicalize()
        .ok()
        .filter(|cwd| cwd.is_dir())
        .ok_or("Choose a project folder that exists.")?;
    let cwd = cwd
        .to_str()
        .ok_or("Choose a project folder whose path is valid text.")?;
    let valid_until = now + VALIDITY;
    let payload = json!({
        "familiar": { "rootId": input.root_id, "revisionId": input.revision_id },
        "envelope": {
            "id": ENVELOPE_ID,
            "descriptorDigest": {
                "algorithm": "sha256",
                "canonicalization": "jcs-rfc8785",
                "value": input.envelope_digest,
            },
        },
        "project": { "cwd": cwd },
        "task": { "statement": statement, "prompt": input.prompt },
        "limits": { "timeoutMinutes": input.timeout_minutes },
        "validUntil": timestamp(valid_until),
    });
    let bytes = serde_json::to_vec(&payload).map_err(|_| "Chat could not encode the mission.")?;
    Ok((bytes, valid_until))
}

fn submit(
    missions: &Missions,
    run: Run,
    input: &SubmitInput,
    now: SystemTime,
    pause: &dyn Fn(usize),
) -> Result<MissionAnswer, String> {
    let (payload, valid_until) = submit_payload(input, now)?;
    let key = new_key("chat-mission");
    let mission_id = mission_id_for(&key);
    // Recorded before anything is sent, so no answer is ever lost track of.
    missions.insert(Record {
        key: key.clone(),
        mission_id: mission_id.clone(),
        familiar_id: input.familiar_id.clone(),
        root_id: input.root_id.clone(),
        revision_id: input.revision_id.clone(),
        principal_id: None,
        phase: Phase::Sending,
        valid_until,
        created_at: now,
        payload: Some(payload.clone()),
        cancel_key: None,
    })?;
    let record = missions.record(&mission_id)?;
    send_submit(missions, run, &record, &payload, pause)
}

/// Sends the submit with its key until an answer proves what happened, at
/// most `SENDS` times. A later send can only replay the first commit.
fn send_submit(
    missions: &Missions,
    run: Run,
    record: &Record,
    payload: &[u8],
    pause: &dyn Fn(usize),
) -> Result<MissionAnswer, String> {
    let args = [
        "missions",
        "submit",
        "--json",
        "-",
        "--adoption-key",
        record.key.as_str(),
    ];
    let mission_id = record.mission_id.clone();
    for send in 0..SENDS {
        if send > 0 {
            pause(send);
        }
        let reply = match run(&args, Some(payload)) {
            Ok(output) => command_reply(&output, "mission.submit.v1", &record.key),
            Err(RunFailure::NotStarted(message)) => Reply::NotSent(message),
            Err(RunFailure::Interrupted(_)) => Reply::Unknown,
        };
        match reply {
            Reply::Applied(response) => {
                let result = &response["result"];
                if result["missionId"] != mission_id.as_str() {
                    return Err("Coven answered about a different mission.".into());
                }
                return Ok(match bound(record, &result["mission"])? {
                    Some(view) => {
                        missions.observed(&view)?;
                        MissionAnswer::View {
                            mission: Box::new(view),
                        }
                    }
                    None => MissionAnswer::Mismatch { mission_id },
                });
            }
            Reply::Refused(error) => {
                missions.settle(missions.remove(&mission_id));
                return Ok(refusal(&error));
            }
            // Only the first send can prove nothing reached Coven; a later
            // one leaves an earlier send's outcome open.
            Reply::NotSent(message) if send == 0 => {
                missions.settle(missions.remove(&mission_id));
                return Ok(MissionAnswer::NotSent { message });
            }
            Reply::NotSent(_) | Reply::Unknown => {}
        }
    }
    Ok(MissionAnswer::Checking { mission_id })
}

// ---------------------------------------------------------------------------
// Reading

fn read(
    missions: &Missions,
    run: Run,
    mission_id: &str,
    now: SystemTime,
    pause: &dyn Fn(usize),
) -> Result<MissionAnswer, String> {
    if !mission_id_shape(mission_id) {
        return Err("Invalid mission id.".into());
    }
    let record = missions.record(mission_id)?;
    // An unanswered submit is settled by sending it again with its key, while
    // Chat still holds the exact payload and Coven could still accept it.
    // After validUntil, reading the mission settles it instead.
    if record.phase == Phase::Sending && now < record.valid_until {
        if let Some(payload) = record.payload.clone() {
            return send_submit(missions, run, &record, &payload, pause);
        }
    }
    let output = run(&["missions", "get", mission_id, "--json"], None).map_err(
        |(RunFailure::NotStarted(detail) | RunFailure::Interrupted(detail))| {
            format!("Chat couldn't read the mission from Coven. {detail}")
        },
    )?;
    match output.code {
        Some(0) => {
            let view =
                printed_object(&output.stdout).ok_or("Coven returned an invalid mission view.")?;
            Ok(match bound(&record, &view)? {
                Some(view) => {
                    missions.observed(&view)?;
                    MissionAnswer::View {
                        mission: Box::new(view),
                    }
                }
                None => MissionAnswer::Mismatch {
                    mission_id: mission_id.to_owned(),
                },
            })
        }
        Some(1) if !printed_nothing(&output.stdout) => {
            let refused = printed_object(&output.stdout)
                .filter(|refused| refused["missionId"] == mission_id)
                .filter(|refused| refused.pointer("/error/code").is_some_and(Value::is_string))
                .ok_or("Coven returned an invalid mission refusal.")?;
            if refused["error"]["code"] != "NOT_FOUND" {
                return Ok(refusal(&refused["error"]));
            }
            Ok(match record.phase {
                // Coven refuses a submit once its validUntil has passed, so
                // only then is "no such mission" final (M-01).
                Phase::Sending if now >= record.valid_until => {
                    missions.settle(missions.remove(mission_id));
                    MissionAnswer::NeverSent {
                        mission_id: mission_id.to_owned(),
                    }
                }
                Phase::Sending => MissionAnswer::Checking {
                    mission_id: mission_id.to_owned(),
                },
                // M-11 a: this Coven doesn't know the mission it accepted.
                Phase::Committed | Phase::Terminal => MissionAnswer::Gone {
                    mission_id: mission_id.to_owned(),
                },
            })
        }
        Some(2) => Err(UPDATE_COVEN.into()),
        _ => Err(format!(
            "Chat couldn't read the mission from Coven. {}",
            output.stderr
        )),
    }
}

// ---------------------------------------------------------------------------
// Cancelling

fn cancel(
    missions: &Missions,
    run: Run,
    mission_id: &str,
    pause: &dyn Fn(usize),
) -> Result<MissionAnswer, String> {
    if !mission_id_shape(mission_id) {
        return Err("Invalid mission id.".into());
    }
    let record = missions.record(mission_id)?;
    if record.phase == Phase::Sending {
        return Err(
            "Chat is still checking whether Coven received this mission. Try again in a moment."
                .into(),
        );
    }
    // The same key for every send of this cancel, so a repeat returns the same
    // cancellation (M-09).
    let key = record
        .cancel_key
        .clone()
        .unwrap_or_else(|| new_key("chat-mission-cancel"));
    missions.update(mission_id, |record| record.cancel_key = Some(key.clone()))?;
    let args = [
        "missions",
        "cancel",
        mission_id,
        "--json",
        "--adoption-key",
        key.as_str(),
    ];
    for send in 0..SENDS {
        if send > 0 {
            pause(send);
        }
        let reply = match run(&args, None) {
            Ok(output) => command_reply(&output, "mission.cancel.v1", &key),
            Err(RunFailure::NotStarted(message)) => Reply::NotSent(message),
            Err(RunFailure::Interrupted(_)) => Reply::Unknown,
        };
        let forget_key = || missions.update(mission_id, |record| record.cancel_key = None);
        match reply {
            Reply::Applied(response) => {
                return Ok(match bound(&record, &response["result"]["mission"])? {
                    Some(view) => {
                        missions.observed(&view)?;
                        MissionAnswer::View {
                            mission: Box::new(view),
                        }
                    }
                    None => MissionAnswer::Mismatch {
                        mission_id: mission_id.to_owned(),
                    },
                });
            }
            Reply::Refused(error) => {
                missions.settle(forget_key());
                // A settled mission answers with its view (M-09).
                if error["code"] == "ILLEGAL_TRANSITION" {
                    if let Some(settled) = error.pointer("/details/mission") {
                        return Ok(match bound(&record, settled)? {
                            Some(view) if view.terminal => {
                                missions.observed(&view)?;
                                MissionAnswer::Settled {
                                    mission: Box::new(view),
                                }
                            }
                            _ => MissionAnswer::Mismatch {
                                mission_id: mission_id.to_owned(),
                            },
                        });
                    }
                }
                return Ok(refusal(&error));
            }
            Reply::NotSent(message) if send == 0 => {
                missions.settle(forget_key());
                return Ok(MissionAnswer::NotSent { message });
            }
            Reply::NotSent(_) | Reply::Unknown => {}
        }
    }
    Ok(MissionAnswer::Checking {
        mission_id: mission_id.to_owned(),
    })
}

// ---------------------------------------------------------------------------
// Commands

fn pause_between_sends(send: usize) {
    thread::sleep(Duration::from_millis(500 * send as u64));
}

fn live(args: &[&str], input: Option<&[u8]>) -> Result<CliOutput, RunFailure> {
    coven(args, input, &AtomicBool::new(false))
}

/// The mission records, opened in this app's data folder.
fn opened(app: &AppHandle, state: &State<'_, MissionState>) -> Result<Arc<Missions>, String> {
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate local chat storage.")?;
    state.0.open(&data)?;
    Ok(state.0.clone())
}

#[tauri::command]
pub(crate) async fn mission_prepare(familiar_id: String) -> Result<MissionPreparation, String> {
    blocking(move || prepare(&live, &familiar_id)).await
}

#[tauri::command]
pub(crate) async fn mission_list(
    app: AppHandle,
    state: State<'_, MissionState>,
    familiar_id: String,
) -> Result<Vec<MissionEntry>, String> {
    validate_id(&familiar_id)?;
    opened(&app, &state)?.list(&familiar_id)
}

/// Forgets a finished mission the person removed from the list.
#[tauri::command]
pub(crate) async fn mission_remove(
    app: AppHandle,
    state: State<'_, MissionState>,
    mission_id: String,
) -> Result<(), String> {
    if !mission_id_shape(&mission_id) {
        return Err("Invalid mission id.".into());
    }
    opened(&app, &state)?.forget(&mission_id)
}

#[tauri::command]
pub(crate) async fn mission_submit(
    app: AppHandle,
    state: State<'_, MissionState>,
    input: SubmitInput,
) -> Result<MissionAnswer, String> {
    let missions = opened(&app, &state)?;
    blocking(move || {
        submit(
            &missions,
            &live,
            &input,
            SystemTime::now(),
            &pause_between_sends,
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn mission_get(
    app: AppHandle,
    state: State<'_, MissionState>,
    mission_id: String,
) -> Result<MissionAnswer, String> {
    let missions = opened(&app, &state)?;
    blocking(move || {
        read(
            &missions,
            &live,
            &mission_id,
            SystemTime::now(),
            &pause_between_sends,
        )
    })
    .await
}

#[tauri::command]
pub(crate) async fn mission_cancel(
    app: AppHandle,
    state: State<'_, MissionState>,
    mission_id: String,
) -> Result<MissionAnswer, String> {
    let missions = opened(&app, &state)?;
    blocking(move || cancel(&missions, &live, &mission_id, &pause_between_sends)).await
}

/// Follows one mission: sends each answer on `on_event` as it changes, until
/// the mission is terminal, its answer ends the watch, or the window stops it.
/// It reads with `coven missions get` once per interval, so a stop takes
/// effect between reads and no watch outlives a read.
#[tauri::command]
pub(crate) async fn mission_watch(
    app: AppHandle,
    state: State<'_, MissionState>,
    mission_id: String,
    on_event: Channel<MissionAnswer>,
) -> Result<(), String> {
    if !mission_id_shape(&mission_id) {
        return Err("Invalid mission id.".into());
    }
    let missions = opened(&app, &state)?;
    missions.record(&mission_id)?;
    let stop = Arc::new(AtomicBool::new(false));
    let mine = stop.clone();
    {
        let mut watches = missions.watches.lock().map_err(|_| STATE_UNAVAILABLE)?;
        if let Some(previous) = watches.get(&mission_id) {
            previous.store(true, Ordering::SeqCst);
        } else if watches.len() >= WATCH_LIMIT {
            return Err(
                "Chat is already following four missions. Close one, then try again.".into(),
            );
        }
        watches.insert(mission_id.clone(), stop.clone());
    }
    let ended = missions.clone();
    let id = mission_id.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let run = |args: &[&str], input: Option<&[u8]>| coven(args, input, &stop);
        watch(&missions, &run, &id, &stop, &|answer| {
            on_event
                .send(answer)
                .map_err(|_| "The window stopped listening.".to_owned())
        })
    })
    .await
    .map_err(|_| "Chat's mission watch failed.".to_string())?;
    // A newer watch of the same mission keeps its own entry.
    if let Ok(mut watches) = ended.watches.lock() {
        if watches
            .get(&mission_id)
            .is_some_and(|flag| Arc::ptr_eq(flag, &mine))
        {
            watches.remove(&mission_id);
        }
    }
    result
}

#[tauri::command]
pub(crate) async fn mission_watch_stop(
    state: State<'_, MissionState>,
    mission_id: String,
) -> Result<(), String> {
    if let Some(stop) = state
        .0
        .watches
        .lock()
        .map_err(|_| STATE_UNAVAILABLE)?
        .remove(&mission_id)
    {
        stop.store(true, Ordering::SeqCst);
    }
    Ok(())
}

/// The watch loop: one read per interval, each answer sent once when it
/// differs from the last one sent.
fn watch(
    missions: &Missions,
    run: Run,
    mission_id: &str,
    stop: &AtomicBool,
    send: &dyn Fn(MissionAnswer) -> Result<(), String>,
) -> Result<(), String> {
    let mut last: Option<MissionAnswer> = None;
    loop {
        if stop.load(Ordering::SeqCst) {
            return Ok(());
        }
        let answer = read(missions, run, mission_id, SystemTime::now(), &|_| {})?;
        let done = match &answer {
            MissionAnswer::View { mission } => mission.terminal,
            MissionAnswer::Checking { .. } => false,
            _ => true,
        };
        // Views only move forward; an older revision is a late answer.
        let newer = match (&last, &answer) {
            (Some(MissionAnswer::View { mission: shown }), MissionAnswer::View { mission }) => {
                mission.revision > shown.revision
            }
            (Some(previous), answer) => previous != answer,
            (None, _) => true,
        };
        if newer {
            send(answer.clone())?;
            last = Some(answer);
        }
        if done {
            return Ok(());
        }
        let resume = Instant::now() + WATCH_INTERVAL;
        while Instant::now() < resume {
            if stop.load(Ordering::SeqCst) {
                return Ok(());
            }
            thread::sleep(Duration::from_millis(50));
        }
    }
}

#[cfg(test)]
#[path = "chat_missions_tests.rs"]
mod tests;
