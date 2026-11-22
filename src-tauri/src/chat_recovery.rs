//! Durable, single-use recovery of provider-identified research attempts.
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, Write},
    path::{Path, PathBuf},
};

pub(crate) const STALE:&str="This task already changed or another device requested it. Refresh the conversation to see its progress.";
pub(crate) const STORAGE: &str =
    "The Mac could not save the recovery request. Check its free space and try again.";
pub(crate) const LIMITED: &str =
    "The provider limit is still active. Try again at the reset time shown in this conversation.";
pub(crate) const UNSUPPORTED: &str = "This engine cannot resume the saved researcher. Review its progress or draft a follow-up naming only the remaining work.";

#[derive(Deserialize, Copy, Clone, PartialEq)]
#[serde(rename_all = "snake_case")]
enum Phase {
    Started,
    Continuable,
    Completed,
    Failed,
    Stopped,
}

#[derive(Deserialize)]
struct Task<'a> {
    provider_session_id: &'a str,
    task_id: &'a str,
    run_id: Option<&'a str>,
    phase: Phase,
    detail: &'a str,
}

#[derive(Serialize)]
struct Checkpoint<'a> {
    provider_session_id: &'a str,
    task_id: &'a str,
    run_id: &'a str,
}

struct Attempt<'a> {
    checkpoint: Option<Checkpoint<'a>>,
    name: String,
    phase: Phase,
    detail: String,
    continuable: bool,
    latest: bool,
}

struct Work<'a> {
    attempts: Vec<Attempt<'a>>,
    reset_at: Option<i64>,
    admitted: std::collections::HashSet<&'a str>,
}

fn display(text: &str) -> String {
    text.chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(1024)
        .collect()
}

/// Resolve a five-hour window's wall-clock reset only when the notice arrives.
/// The persisted instant survives relaunch, midnight and daylight-saving changes.
pub(crate) fn capture_clock(event: &mut Value, observed: i64) {
    if event["type"] != "provider_limit"
        || event["version"] != 1
        || event["limit"]["resets_at"].is_i64()
    {
        return;
    }
    static RESET: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"^(?:API Error: Request rejected \(429\) · )?You've hit your 5-hour limit · resets (1[0-2]|[1-9]):([0-5][0-9])([ap])m \(([A-Za-z_+-]+(?:/[A-Za-z0-9_+-]+)*)\)$").expect("five-hour reset notice")
    });
    let instant = (|| {
        let c = RESET.captures(event["limit"]["notice"].as_str()?)?;
        let hour = c[1].parse::<i8>().ok()? % 12 + if &c[3] == "p" { 12 } else { 0 };
        let minute = c[2].parse::<i8>().ok()?;
        let zone = jiff::tz::TimeZone::get(&c[4]).ok()?;
        let day = jiff::Timestamp::from_second(observed)
            .ok()?
            .to_zoned(zone.clone())
            .date();
        for day in [Some(day), day.tomorrow().ok()].into_iter().flatten() {
            let dt = day.at(hour, minute, 0, 0);
            let ambiguous = zone.to_ambiguous_timestamp(dt);
            for stamp in [ambiguous.earlier().ok(), ambiguous.later().ok()]
                .into_iter()
                .flatten()
            {
                let t = stamp.as_second();
                if t >= observed - 59 && t <= observed + 5 * 3600 + 60 {
                    return Some(t);
                }
            }
        }
        None
    })();
    if let Some(t) = instant {
        event["hostRetryAt"] = json!(t);
    }
}

fn work<'a>(events: &'a [Value], session: &str) -> Work<'a> {
    let mut indices = HashMap::new();
    let mut latest: HashMap<(&str, &str), usize> = HashMap::new();
    let mut attempts = Vec::<Attempt>::new();
    let mut reset_at = None;
    let mut admitted = std::collections::HashSet::new();
    for event in events.iter().filter(|e| e["session_id"] == session) {
        if event["type"] == "system"
            && event["source"] == "chat-recovery"
            && event["subtype"] == "admitted"
        {
            if let Some(id) = event["recoveryId"].as_str() {
                admitted.insert(id);
            }
        }
        if event["type"] == "provider_limit" && event["version"] == 1 {
            if let Some(v) = event["limit"]["resets_at"]
                .as_i64()
                .or_else(|| event["hostRetryAt"].as_i64())
                .filter(|v| (1..=253402300799).contains(v))
            {
                reset_at = Some(v);
            }
        }
        if event["type"] != "provider_task" || event["version"] != 1 {
            continue;
        }
        let Ok(t) = Task::deserialize(&event["task"]) else {
            continue;
        };
        if t.provider_session_id.is_empty() || t.task_id.is_empty() {
            continue;
        }
        let key = (t.provider_session_id, t.task_id, t.run_id);
        if t.phase == Phase::Started {
            indices.entry(key).or_insert_with(|| {
                let index = attempts.len();
                if let Some(previous) = latest.insert((t.provider_session_id, t.task_id), index) {
                    attempts[previous].latest = false;
                }
                attempts.push(Attempt {
                    checkpoint: t.run_id.map(|run_id| Checkpoint {
                        provider_session_id: t.provider_session_id,
                        task_id: t.task_id,
                        run_id,
                    }),
                    name: if t.detail.is_empty() {
                        "Research task".into()
                    } else {
                        display(t.detail)
                    },
                    phase: t.phase,
                    detail: String::new(),
                    continuable: false,
                    latest: true,
                });
                index
            });
        } else if let Some(&index) = indices.get(&key) {
            let attempt = &mut attempts[index];
            if t.phase == Phase::Continuable {
                attempt.continuable = true;
            } else if attempt.phase == Phase::Started {
                attempt.phase = t.phase;
                if t.phase == Phase::Completed {
                    attempt.detail = display(t.detail);
                }
            }
        }
    }
    Work {
        attempts,
        reset_at,
        admitted,
    }
}

pub(crate) fn progress(events: &[Value], session: &str) -> Vec<String> {
    work(events, session)
        .attempts
        .iter()
        .map(|a| {
            let status = match a.phase {
                Phase::Completed => "Finished",
                Phase::Failed => "Failed",
                Phase::Stopped => "Stopped",
                _ => "Outcome unknown",
            };
            if a.detail.is_empty() {
                format!("{}: {status}", a.name)
            } else {
                format!("{}: {status} — {}", a.name, a.detail)
            }
        })
        .collect()
}

fn action_id(session: &str, c: &Checkpoint<'_>) -> String {
    let mut h = Sha256::new();
    for field in [session, c.provider_session_id, c.task_id, c.run_id] {
        h.update(field.as_bytes());
        h.update([0]);
    }
    format!("{:x}", h.finalize())
}

impl Work<'_> {
    fn eligible(&self) -> impl Iterator<Item = (&str, &Checkpoint<'_>)> {
        self.attempts.iter().filter_map(|a| {
            let c = a.checkpoint.as_ref()?;
            if !a.latest || !a.continuable || !matches!(a.phase, Phase::Failed | Phase::Stopped) {
                return None;
            }
            Some((a.name.as_str(), c))
        })
    }
}

pub(crate) fn actions(events: &[Value], session: &str) -> Vec<Value> {
    let record = work(events, session);
    record
        .eligible()
        .filter_map(|(name, c)| {
            let id = action_id(session, c);
            (!record.admitted.contains(id.as_str()))
                .then(|| json!({"id":id,"name":name,"resetAt":record.reset_at}))
        })
        .collect()
}

/// A host-issued admission remains consumed after a disconnect or crash.
pub(crate) struct Admission {
    path: PathBuf,
    source: String,
    id: String,
    owner: String,
    task: String,
    previous: String,
}

impl Admission {
    pub(crate) fn completed(&self, events: &[Value], session: &str) -> bool {
        work(events, session).attempts.into_iter().any(|a| {
            a.phase == Phase::Completed
                && a.continuable
                && a.checkpoint.is_some_and(|c| {
                    c.provider_session_id == self.owner
                        && c.task_id == self.task
                        && c.run_id != self.previous
                })
        })
    }

    pub(crate) fn finish(&self, state: &str) -> Result<(), String> {
        let mut file = OpenOptions::new()
            .append(true)
            .open(&self.path)
            .map_err(|_| "Refresh the conversation to check the recovery outcome.")?;
        FileExt::lock_exclusive(&file)
            .map_err(|_| "The saved conversation is busy. Refresh to check the outcome.")?;
        let event = json!({"type":"system","source":"chat-recovery","subtype":"outcome","session_id":self.source,"recoveryId":self.id,"state":state});
        let mut line =
            serde_json::to_vec(&event).map_err(|_| "Cannot save the recovery outcome.")?;
        line.push(b'\n');
        file.write_all(&line)
            .and_then(|()| file.sync_all())
            .map_err(|_| "Cannot save the recovery outcome.".into())
    }
}

/// The parent was found in the validated Chat lineage. Serialize admission
/// across Mac processes and devices on that very transcript. A lost response
/// cannot turn the original checkpoint into another launch after a restart.
pub(crate) fn reserve(
    data: &Path,
    history: &[Value],
    id: &str,
    run: &str,
    now: i64,
) -> Result<(File, Admission), String> {
    let source = history
        .iter()
        .find_map(|e| {
            if e["type"] == "system"
                && (e["source"] == crate::coven_runtime::RUN_FAILURE_SOURCE
                    || (e["source"] == "chat-recovery" && e["subtype"] == "progress"))
                && e["recoverableTasks"]
                    .as_array()?
                    .iter()
                    .any(|t| t["id"] == id)
            {
                e["session_id"].as_str()
            } else {
                None
            }
        })
        .ok_or(STALE)?;
    crate::coven_runtime::validate_id(source)?;
    let dir = crate::coven_runtime::transcripts_dir(data, false)?;
    let path = dir.join(format!("{source}.jsonl"));
    if !std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_file()) {
        return Err(STORAGE.into());
    }
    let mut file = OpenOptions::new()
        .read(true)
        .append(true)
        .open(&path)
        .map_err(|_| STORAGE)?;
    FileExt::try_lock_exclusive(&file).map_err(|_| STALE)?;
    let max = crate::coven_runtime::TRANSCRIPT_LIMIT as u64;
    if file.metadata().map_err(|_| STORAGE)?.len() > max {
        return Err(STORAGE.into());
    }
    let mut events = Vec::new();
    for line in BufReader::new((&file).take(max + 1)).lines() {
        let line = line.map_err(|_| STORAGE)?;
        if !line.trim().is_empty() {
            events.push(serde_json::from_str(&line).map_err(|_| STORAGE)?);
        }
    }
    let record = work(&events, source);
    if record.admitted.contains(id) {
        return Err(STALE.into());
    }
    if record.reset_at.is_some_and(|r| now < r) {
        return Err(LIMITED.into());
    }
    let (_, checkpoint) = record
        .eligible()
        .find(|(_, c)| action_id(source, c) == id)
        .ok_or(STALE)?;
    let mut input = tempfile::tempfile_in(dir).map_err(|_| STORAGE)?;
    writeln!(
        input,
        "{}",
        json!({"type":"recover_provider_task","version":1,"checkpoint":checkpoint})
    )
    .map_err(|_| STORAGE)?;
    input.rewind().map_err(|_| STORAGE)?;
    let entry = json!({"type":"system","subtype":"admitted","source":"chat-recovery","session_id":source,"recoveryId":id,"requestId":run});
    let mut encoded = serde_json::to_vec(&entry).map_err(|_| STORAGE)?;
    encoded.push(b'\n');
    file.write_all(&encoded)
        .and_then(|()| file.sync_all())
        .map_err(|_| STORAGE)?;
    Ok((
        input,
        Admission {
            path,
            source: source.to_owned(),
            id: id.to_owned(),
            owner: checkpoint.provider_session_id.to_owned(),
            task: checkpoint.task_id.to_owned(),
            previous: checkpoint.run_id.to_owned(),
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Barrier};
    fn frame(task: &str, run: &str, phase: &str, detail: &str) -> Value {
        json!({"type":"provider_task","version":1,"session_id":"chat","task":{"provider_session_id":"parent","task_id":task,"run_id":run,"phase":phase,"detail":detail}})
    }
    #[test]
    fn completion_belongs_to_its_attempt_and_unknown_work_stays_unknown() {
        let events = [
            frame("task", "1", "started", "Check contrast"),
            frame("task", "2", "started", "Check new colors"),
            frame("task", "1", "completed", "AA passed"),
            frame("other", "2", "failed", "unobserved"),
        ];
        assert_eq!(
            progress(&events, "chat"),
            [
                "Check contrast: Finished — AA passed",
                "Check new colors: Outcome unknown"
            ]
        );
        assert!(actions(&events, "chat").is_empty());
    }
    #[test]
    fn only_the_selected_childs_new_acknowledged_attempt_can_finish_the_request() {
        let ticket = Admission {
            path: PathBuf::new(),
            source: "old-chat".into(),
            id: "action".into(),
            owner: "parent".into(),
            task: "selected".into(),
            previous: "old".into(),
        };
        for (task, run, accepted, expected) in [
            ("other", "new", true, false),
            ("selected", "old", true, false),
            ("selected", "new", false, false),
            ("selected", "new", true, true),
        ] {
            let mut events = vec![frame(task, run, "started", "Reading order")];
            if accepted {
                events.push(frame(task, run, "continuable", ""));
            }
            events.push(frame(task, run, "completed", "Result"));
            assert_eq!(ticket.completed(&events, "chat"), expected);
            assert!(!ticket.completed(&events, "another-chat"));
        }
    }

    #[test]
    fn reset_clock_handles_midnight_and_the_second_fall_back_hour() {
        let second = |s: &str| s.parse::<jiff::Timestamp>().unwrap().as_second();
        for (observed, notice, expected) in [
            ("2026-11-22T05:45:00Z", "1:10am", "2026-11-22T07:10:00Z"),
            ("2026-11-01T06:30:00Z", "1:10am", "2026-11-01T07:10:00Z"),
        ] {
            let mut event = json!({"type":"provider_limit","version":1,"limit":{"notice":format!("You've hit your 5-hour limit · resets {notice} (America/Chicago)")}});
            capture_clock(&mut event, second(observed));
            assert_eq!(event["hostRetryAt"], second(expected));
        }
    }
    #[test]
    fn simultaneous_devices_relaunch_and_reset_share_one_admission() {
        let tmp = tempfile::tempdir().unwrap();
        let data = tmp.path();
        let mut events = vec![
            frame("done", "1", "started", "First"),
            frame("done", "1", "continuable", ""),
            frame("done", "1", "completed", "Saved first result"),
            frame("open", "2", "started", "Second"),
            frame("open", "2", "continuable", ""),
            frame("open", "2", "failed", "private details"),
            frame("missing", "3", "started", "Third"),
            frame("missing", "3", "failed", ""),
            json!({"type":"provider_limit","version":1,"session_id":"chat","limit":{"resets_at":50}}),
        ];
        let offered = actions(&events, "chat");
        assert_eq!(offered.len(), 1);
        let id = offered[0]["id"].as_str().unwrap().to_owned();
        events.push(json!({"type":"system","source":"chat-diagnostic","subtype":"notice","session_id":"chat","recoverableTasks":offered}));
        let dir = crate::coven_runtime::transcripts_dir(data, true).unwrap();
        let path = dir.join("chat.jsonl");
        let mut host = File::create(&path).unwrap();
        for e in &events {
            writeln!(host, "{e}").unwrap();
        }
        drop(host);
        assert!(reserve(data, &events, &id, "early", 49).is_err());
        let start = Arc::new(Barrier::new(2));
        let admitted = std::thread::scope(|scope| {
            let jobs: Vec<_> = ["desktop", "phone"]
                .into_iter()
                .map(|device| {
                    let start = start.clone();
                    let events = &events;
                    let id = &id;
                    scope.spawn(move || {
                        start.wait();
                        reserve(data, events, id, device, 50).is_ok()
                    })
                })
                .collect();
            jobs.into_iter()
                .map(|j| usize::from(j.join().unwrap()))
                .sum::<usize>()
        });
        assert_eq!(admitted, 1);
        assert!(reserve(data, &events, &id, "after-relaunch", 51).is_err());
        let history = crate::coven_runtime::read_local_events(data, "chat")
            .unwrap()
            .unwrap();
        assert_eq!(
            history
                .iter()
                .filter(|e| e["source"] == "chat-recovery")
                .count(),
            1
        );
        assert!(actions(&history, "chat").is_empty());
    }
}
