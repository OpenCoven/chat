use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::Read,
    path::Path,
};

use crate::chat_lifecycle::{self, Lifecycle};
use serde_json::Value;

const FILE: &str = "chat-canonical-v1.json";
const LIMIT: usize = 2 * 1024 * 1024;
const ENTRY_LIMIT: usize = 10_000;
type Heads = BTreeMap<String, Option<String>>;

pub(crate) fn load(data: &Path) -> Result<Heads, String> {
    let path = data.join(FILE);
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Heads::new()),
        Err(_) => {
            return Err(
                "Chat's record of which chat belongs to each familiar could not be checked.".into(),
            )
        }
    };
    if !metadata.is_file() || metadata.len() > LIMIT as u64 {
        return Err("Chat's record of which chat belongs to each familiar is unreadable or larger than 2 MiB; it was left unchanged.".into());
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| "Chat's record of which chat belongs to each familiar could not be opened.")?
        .take((LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "Chat's record of which chat belongs to each familiar could not be read.")?;
    if bytes.len() > LIMIT {
        return Err(
            "Chat's record of which chat belongs to each familiar is larger than 2 MiB.".into(),
        );
    }
    let heads: Heads = serde_json::from_slice(&bytes).map_err(|_| {
        "Chat's record of which chat belongs to each familiar is unreadable; it was left unchanged."
    })?;
    validate(&heads)?;
    Ok(heads)
}

fn validate(heads: &Heads) -> Result<(), String> {
    if heads.len() > ENTRY_LIMIT {
        return Err("Chat's record of which chat belongs to each familiar lists more than 10,000 familiars.".into());
    }
    for (familiar, head) in heads {
        crate::coven_runtime::validate_id(familiar)?;
        if let Some(head) = head {
            crate::coven_runtime::validate_id(head)?;
        }
    }
    Ok(())
}

fn save(data: &Path, heads: &Heads) -> Result<(), String> {
    validate(heads)?;
    let bytes = serde_json::to_vec(heads)
        .map_err(|_| "Chat's record of which chat belongs to each familiar could not be saved.")?;
    chat_lifecycle::persist(data, FILE, &bytes)
}

pub(crate) fn head(data: &Path, familiar: &str) -> Result<Option<String>, String> {
    crate::coven_runtime::validate_id(familiar)?;
    let head = load(data)?.remove(familiar).flatten();
    match head {
        Some(id) if chat_lifecycle::state(data, &id)? != Lifecycle::Deleted => Ok(Some(id)),
        _ => Ok(None),
    }
}

// Callers serialize every canonical transaction with STORAGE_LOCK.
pub(crate) fn project(data: &Path, sessions: &[Value]) -> Result<Vec<Value>, String> {
    let mut heads = load(data)?;
    let before = heads.clone();
    let mut newest: BTreeMap<&str, &Value> = BTreeMap::new();
    for session in sessions {
        let Some(familiar) = session["familiarId"].as_str() else {
            continue;
        };
        crate::coven_runtime::validate_id(familiar)?;
        let candidate = newest.entry(familiar).or_insert(session);
        if (session["updatedAt"].as_str(), session["id"].as_str())
            > (candidate["updatedAt"].as_str(), candidate["id"].as_str())
        {
            *candidate = session;
        }
    }
    for (familiar, session) in newest {
        if !heads.contains_key(familiar) {
            let id = session["id"]
                .as_str()
                .ok_or("Coven listed a chat without a usable identifier.")?;
            heads.insert(familiar.to_owned(), Some(id.to_owned()));
        }
    }
    if heads != before {
        save(data, &heads)?;
    }
    let states = chat_lifecycle::load(data)?;
    let mut result = Vec::new();
    for (familiar, id) in heads {
        let Some(id) = id else { continue };
        if states.get(&id) == Some(&Lifecycle::Deleted) {
            continue;
        }
        let session = sessions.iter().find(|session|
            session["id"].as_str() == Some(&id) &&
            session["familiarId"].as_str() == Some(&familiar))
            .ok_or("A chat Chat recorded for a familiar is no longer in Coven's list. The record was left unchanged and no older chat was opened. Refresh Coven and open the familiar again.")?;
        let mut session = session.clone();
        session["archived"] = Value::Bool(states.get(&id) == Some(&Lifecycle::Archived));
        result.push(session);
    }
    result.sort_by(|a, b| b["updatedAt"].as_str().cmp(&a["updatedAt"].as_str()));
    Ok(result)
}

pub(crate) fn require_current(data: &Path, id: &str) -> Result<String, String> {
    load(data)?
        .into_iter()
        .find_map(|(familiar, head)| (head.as_deref() == Some(id)).then_some(familiar))
        .ok_or_else(|| {
            "This conversation is no longer this familiar's current chat. Reopen the familiar from the sidebar to continue.".into()
        })
}

pub(crate) fn ensure_empty(data: &Path, familiar: &str) -> Result<(), String> {
    let mut heads = load(data)?;
    if !heads.contains_key(familiar) {
        heads.insert(familiar.to_owned(), None);
        save(data, &heads)?;
    }
    Ok(())
}

pub(crate) fn advance(
    data: &Path,
    familiar: &str,
    parent: Option<&str>,
    id: &str,
) -> Result<(), String> {
    if head(data, familiar)?.as_deref() != parent {
        return Err(
            "This familiar's chat has changed since the run started, so the run cannot save its reply here."
                .into(),
        );
    }
    crate::chat_origin::require_chat_origin(data, id)?;
    chat_lifecycle::require_active(data, id)?;
    let mut heads = load(data)?;
    heads.insert(familiar.to_owned(), Some(id.to_owned()));
    save(data, &heads)
}

pub(crate) fn clear(data: &Path, id: &str) -> Result<(), String> {
    let familiar = require_current(data, id)?;
    let mut heads = load(data)?;
    // An explicit empty head is a durable reset, not permission to rediscover an older chat.
    heads.insert(familiar, None);
    save(data, &heads)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn captured(data: &Path, id: &str, date: &str) -> Value {
        fs::create_dir_all(data.join("coven-transcripts")).unwrap();
        fs::write(
            data.join("coven-transcripts").join(format!("{id}.jsonl")),
            json!({"type":"user","source":"chat-input","session_id":id}).to_string(),
        )
        .unwrap();
        json!({"id":id,"familiarId":"f","updatedAt":date,"title":id,
            "harness":"coven-code","status":"completed","projectRoot":"/work"})
    }

    fn cleanup(data: &Path, ids: &[&str]) {
        for id in ids {
            let path = data.join("coven-transcripts").join(format!("{id}.jsonl"));
            if path.exists() {
                fs::remove_file(path).unwrap();
            }
        }
        for file in [FILE, "chat-lifecycle-v1.json"] {
            if data.join(file).exists() {
                fs::remove_file(data.join(file)).unwrap();
            }
        }
        if data.join("coven-transcripts").exists() {
            fs::remove_dir(data.join("coven-transcripts")).unwrap();
        }
        fs::remove_dir(data).unwrap();
    }

    #[test]
    fn newest_owned_head_is_chosen_once_and_only_explicit_resume_advances_it() {
        let data = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let old = captured(&data, "old", "2026-09-01");
        let current = captured(&data, "current", "2026-09-02");
        let initial = vec![old.clone(), current.clone()];
        assert_eq!(project(&data, &initial).unwrap()[0]["id"], "current");
        let newer = captured(&data, "newer-unrelated", "2026-09-03");
        let all = vec![old, current.clone(), newer.clone()];
        assert_eq!(project(&data, &all).unwrap()[0]["id"], "current");
        assert!(advance(&data, "f", Some("old"), "newer-unrelated").is_err());
        advance(&data, "f", Some("current"), "newer-unrelated").unwrap();
        assert_eq!(
            head(&data, "f").unwrap().as_deref(),
            Some("newer-unrelated")
        );
        assert_eq!(project(&data, &all).unwrap()[0]["id"], "newer-unrelated");
        assert!(require_current(&data, "current").is_err());
        assert!(project(&data, &[current])
            .unwrap_err()
            .contains("no longer in Coven's list"));
        cleanup(&data, &["old", "current", "newer-unrelated"]);
    }

    #[test]
    fn delete_remains_cleared_after_crash_reload_and_newer_unrelated_history() {
        let data = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let old = captured(&data, "old", "2026-09-01");
        let selected = captured(&data, "selected", "2026-09-02");
        let all = vec![old, selected];
        project(&data, &all).unwrap();
        let old_bytes = fs::read(data.join("coven-transcripts/old.jsonl")).unwrap();
        fs::create_dir_all(data.join("cave-imports")).unwrap();
        fs::write(
            data.join("cave-imports/existing.json"),
            "retained import data",
        )
        .unwrap();
        chat_lifecycle::change(&data, "selected", Lifecycle::Archived).unwrap();
        assert_eq!(project(&data, &all).unwrap()[0]["archived"], true);
        chat_lifecycle::change(&data, "selected", Lifecycle::Active).unwrap();
        chat_lifecycle::change(&data, "selected", Lifecycle::Deleted).unwrap();
        // Simulate interruption between the tombstone and explicit empty-head commits.
        assert!(project(&data, &all).unwrap().is_empty());
        assert_eq!(head(&data, "f").unwrap(), None);
        clear(&data, "selected").unwrap();
        let unrelated = captured(&data, "unrelated", "2026-09-04");
        let mut all = all;
        all.push(unrelated);
        assert!(project(&data, &all).unwrap().is_empty());
        assert_eq!(load(&data).unwrap().get("f"), Some(&None));
        assert_eq!(
            fs::read(data.join("coven-transcripts/old.jsonl")).unwrap(),
            old_bytes
        );
        let fresh = captured(&data, "fresh", "2026-09-05");
        advance(&data, "f", None, "fresh").unwrap();
        all.push(fresh);
        assert_eq!(project(&data, &all).unwrap()[0]["id"], "fresh");
        assert_eq!(
            fs::read_to_string(data.join("cave-imports/existing.json")).unwrap(),
            "retained import data"
        );
        fs::remove_file(data.join("cave-imports/existing.json")).unwrap();
        fs::remove_dir(data.join("cave-imports")).unwrap();
        cleanup(&data, &["old", "selected", "unrelated", "fresh"]);
    }

    #[test]
    fn invalid_full_or_corrupt_mapping_is_not_replaced() {
        let data = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&data).unwrap();
        for source in [
            "{invalid".to_owned(),
            " ".repeat(LIMIT + 1),
            r#"{"../invalid":null}"#.to_owned(),
        ] {
            fs::write(data.join(FILE), &source).unwrap();
            assert!(load(&data).is_err());
            assert!(ensure_empty(&data, "f").is_err());
            assert_eq!(fs::read_to_string(data.join(FILE)).unwrap(), source);
        }
        let heads: Heads = (0..=ENTRY_LIMIT)
            .map(|index| (format!("f-{index}"), None))
            .collect();
        assert!(save(&data, &heads).unwrap_err().contains("10,000"));
        cleanup(&data, &[]);
    }
}
