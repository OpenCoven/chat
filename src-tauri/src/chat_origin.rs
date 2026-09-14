use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

const IMPORT_LIMIT: usize = 4 * 1024 * 1024;

pub(crate) fn has_chat_origin(data: &Path, id: &str) -> Result<bool, String> {
    Ok(
        crate::coven_runtime::read_local_events(data, id)?.is_some_and(|events| {
            events.iter().any(|event| {
                event["type"] == "user"
                    && event["source"] == "chat-input"
                    && event["session_id"].as_str() == Some(id)
            })
        }),
    )
}

pub(crate) fn require_chat_origin(data: &Path, id: &str) -> Result<(), String> {
    if has_chat_origin(data, id)? {
        Ok(())
    } else {
        Err("This session was not created in Chat. Cave imports are read-only snapshots; start a new Chat conversation to send.".into())
    }
}

fn text<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Invalid Cave conversation: {key} must be text."))
}

// Reviewed Cave ConversationFile and active-path contract:
// OpenCoven/coven-cave@5217470786d72e05d2d0d8820c3c7d30c03eafb2
// src/lib/cave-conversations.ts and src/lib/conversation-tree.ts.
fn snapshot(source: &str, id: &str) -> Result<Value, String> {
    if source.len() > IMPORT_LIMIT {
        return Err("Cave conversation exceeds the 4 MiB import limit.".into());
    }
    let value: Value = serde_json::from_str(source).map_err(|_| {
        "Choose a Cave conversations/*.json file, not a CLI session or encrypted backup."
    })?;
    for key in ["sessionId", "familiarId", "harness", "updatedAt"] {
        text(&value, key)?;
    }
    if text(&value, "sessionId")?.is_empty() {
        return Err("Invalid Cave conversation: sessionId is empty.".into());
    }
    let turns = value["turns"]
        .as_array()
        .ok_or("Invalid Cave conversation: turns must be an array.")?;
    if turns.len() > 20_000 {
        return Err("Cave conversation has too many turns.".into());
    }
    let mut by_id = HashMap::new();
    for turn in turns {
        let turn_id = text(turn, "id")?;
        if turn_id.is_empty() || by_id.insert(turn_id, turn).is_some() {
            return Err("Cave conversation has duplicate or empty turn IDs.".into());
        }
        if !matches!(text(turn, "role")?, "user" | "assistant" | "system") {
            return Err("Cave conversation contains an unsupported turn role.".into());
        }
        text(turn, "text")?;
        text(turn, "createdAt")?;
        if !matches!(
            turn.get("parentId"),
            None | Some(Value::Null) | Some(Value::String(_))
        ) {
            return Err("Cave conversation has an invalid parentId.".into());
        }
    }
    let mut ordered: Vec<&Value>;
    if let Some(leaf) = value
        .get("activeLeafId")
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty())
    {
        let mut current = Some(leaf);
        let mut seen = HashSet::new();
        ordered = Vec::new();
        while let Some(id) = current {
            if !seen.insert(id) {
                return Err("Cave conversation contains a branch cycle.".into());
            }
            let turn = by_id
                .get(id)
                .ok_or("Cave conversation references a missing turn.")?;
            ordered.push(*turn);
            current = turn.get("parentId").and_then(Value::as_str);
        }
        ordered.reverse();
        let mut systems: Vec<_> = turns
            .iter()
            .filter(|turn| {
                turn["role"] == "system"
                    && turn.get("parentId").is_none_or(Value::is_null)
                    && !seen.contains(turn["id"].as_str().unwrap_or_default())
            })
            .collect();
        systems.sort_by_key(|turn| (turn["createdAt"].as_str(), turn["id"].as_str()));
        for system in systems {
            let index = ordered
                .iter()
                .position(|turn| turn["createdAt"].as_str() > system["createdAt"].as_str())
                .unwrap_or(ordered.len());
            ordered.insert(index, system);
        }
    } else {
        if turns
            .iter()
            .any(|turn| turn.get("parentId").is_some_and(|v| !v.is_null()))
        {
            return Err("Branched Cave conversation is missing activeLeafId.".into());
        }
        ordered = turns.iter().collect();
        ordered.sort_by_key(|turn| (turn["createdAt"].as_str(), turn["id"].as_str()));
    }
    let events: Vec<_> = ordered
        .iter()
        .map(|turn| {
            json!({
                "type": turn["role"], "source": "cave-import", "session_id": id,
                "message": {"role": turn["role"], "content": [{"type":"text","text":turn["text"]}]}
            })
        })
        .collect();
    let title = value["title"]
        .as_str()
        .filter(|title| !title.trim().is_empty())
        .unwrap_or("Imported Cave conversation");
    Ok(json!({
        "session": {"id":id, "title":title, "harness":"cave-import", "status":"imported",
            "updatedAt":value["updatedAt"], "projectRoot":"", "origin":"cave-import"},
        "events":events, "hasMore":false
    }))
}

fn import_id(source: &str) -> String {
    format!("cave-import-{:x}", Sha256::digest(source.as_bytes()))
}

fn read_source(path: &Path) -> Result<String, String> {
    let metadata = fs::symlink_metadata(path).map_err(|_| "Cannot inspect saved Cave import.")?;
    if !metadata.is_file() || metadata.len() > IMPORT_LIMIT as u64 {
        return Err("Saved Cave import is invalid or too large.".into());
    }
    let mut source = String::new();
    File::open(path)
        .map_err(|_| "Cannot open saved Cave import.")?
        .take((IMPORT_LIMIT + 1) as u64)
        .read_to_string(&mut source)
        .map_err(|_| "Cannot read saved Cave import.")?;
    if source.len() > IMPORT_LIMIT {
        return Err("Saved Cave import is too large.".into());
    }
    Ok(source)
}

pub(crate) fn read_import(data: &Path, id: &str) -> Result<Option<Value>, String> {
    let Some(hash) = id.strip_prefix("cave-import-") else {
        return Ok(None);
    };
    if hash.len() != 64
        || !hash
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    {
        return Err("Invalid Cave import identifier.".into());
    }
    let source = read_source(&data.join("cave-imports").join(format!("{id}.json")))?;
    if import_id(&source) != id {
        return Err("Saved Cave import failed its content identity check.".into());
    }
    snapshot(&source, id).map(Some)
}

pub(crate) fn list_imports(data: &Path) -> Result<Vec<Value>, String> {
    let lifecycle = crate::chat_lifecycle::load(data)?;
    let directory = data.join("cave-imports");
    if !directory
        .try_exists()
        .map_err(|_| "Cannot inspect Cave imports.")?
    {
        return Ok(Vec::new());
    }
    let mut sessions = Vec::new();
    for entry in fs::read_dir(directory).map_err(|_| "Cannot list Cave imports.")? {
        let entry = entry.map_err(|_| "Cannot list Cave imports.")?;
        let name = entry.file_name();
        let Some(id) = name.to_str().and_then(|name| name.strip_suffix(".json")) else {
            continue;
        };
        if lifecycle.get(id) == Some(&crate::chat_lifecycle::Lifecycle::Deleted) {
            continue;
        }
        if let Some(snapshot) = read_import(data, id)? {
            sessions.push(snapshot["session"].clone());
        }
    }
    sessions.sort_by(|a, b| b["updatedAt"].as_str().cmp(&a["updatedAt"].as_str()));
    Ok(sessions)
}

fn save_import(data: &Path, source: &str) -> Result<Value, String> {
    if source.len() > IMPORT_LIMIT {
        return Err("Cave conversation exceeds the 4 MiB import limit.".into());
    }
    let id = import_id(source);
    crate::chat_lifecycle::require_visible(data, &id)?;
    let result = snapshot(source, &id)?;
    let directory = data.join("cave-imports");
    fs::create_dir_all(&directory).map_err(|_| "Cannot create local Cave import storage.")?;
    let target = directory.join(format!("{id}.json"));
    if target
        .try_exists()
        .map_err(|_| "Cannot inspect existing Cave import.")?
    {
        return read_import(data, &id)?.ok_or_else(|| "Cannot read existing Cave import.".into());
    }
    let temporary = directory.join(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let write = (|| {
        let mut file = options
            .open(&temporary)
            .map_err(|_| "Cannot create Cave import.")?;
        file.write_all(source.as_bytes())
            .map_err(|_| "Cannot save Cave import.")?;
        file.sync_all().map_err(|_| "Cannot persist Cave import.")?;
        fs::rename(&temporary, target).map_err(|_| "Cannot register Cave import.")?;
        Ok::<_, String>(())
    })();
    if write.is_err() && temporary.exists() {
        if let Err(error) = fs::remove_file(&temporary) {
            eprintln!("Cannot clean incomplete Cave import: {error}");
        }
    }
    write?;
    Ok(result)
}

#[tauri::command]
pub(crate) async fn coven_runtime_import_cave(
    app: AppHandle,
    source: String,
) -> Result<Value, String> {
    let data = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate local chat storage.")?;
    tauri::async_runtime::spawn_blocking(move || {
        let _storage = crate::chat_lifecycle::STORAGE_LOCK
            .lock()
            .map_err(|_| "Chat lifecycle storage is unavailable.")?;
        save_import(&data, &source)
    })
    .await
    .map_err(|_| "Cave import task failed.")?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn source() -> String {
        json!({"sessionId":"cave-owned","familiarId":"fam","harness":"claude",
        "updatedAt":"2026-09-14T00:00:00Z", "turns":[
            {"id":"a","role":"user","text":"Hello","createdAt":"2026-09-14T00:00:00Z"}
        ]})
        .to_string()
    }

    #[test]
    fn explicit_import_is_durable_idempotent_and_never_cli_resumable() {
        let data = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let source = source();
        let saved = save_import(&data, &source).unwrap();
        let id = saved["session"]["id"].as_str().unwrap();
        assert_eq!(save_import(&data, &source).unwrap(), saved);
        assert_eq!(read_import(&data, id).unwrap(), Some(saved.clone()));
        assert_eq!(list_imports(&data).unwrap(), vec![saved["session"].clone()]);
        assert!(require_chat_origin(&data, id).is_err());
        assert_eq!(
            fs::read_to_string(data.join("cave-imports").join(format!("{id}.json"))).unwrap(),
            source
        );
        fs::remove_file(data.join("cave-imports").join(format!("{id}.json"))).unwrap();
        fs::remove_dir(data.join("cave-imports")).unwrap();
        fs::remove_dir(data).unwrap();
    }

    #[test]
    fn imported_snapshots_archive_restore_delete_without_reimport_resurrection() {
        use crate::chat_lifecycle::{change, Lifecycle};
        let data = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let source = source();
        let saved = save_import(&data, &source).unwrap();
        let id = saved["session"]["id"].as_str().unwrap();
        change(&data, id, Lifecycle::Archived).unwrap();
        assert_eq!(read_import(&data, id).unwrap(), Some(saved.clone()));
        assert_eq!(list_imports(&data).unwrap().len(), 1);
        change(&data, id, Lifecycle::Active).unwrap();
        change(&data, id, Lifecycle::Deleted).unwrap();
        assert!(list_imports(&data).unwrap().is_empty());
        assert!(save_import(&data, &source).unwrap_err().contains("deleted"));
        assert!(!data
            .join("cave-imports")
            .join(format!("{id}.json"))
            .exists());
        fs::remove_file(data.join("chat-lifecycle-v1.json")).unwrap();
        fs::remove_dir(data.join("cave-imports")).unwrap();
        fs::remove_dir(data).unwrap();
    }

    #[test]
    fn only_exact_app_input_proves_origin() {
        let data = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let directory = data.join("coven-transcripts");
        fs::create_dir_all(&directory).unwrap();
        for (source, session, accepted) in [
            ("cli", "one", false),
            ("chat_input", "one", false),
            ("chat-input", "other", false),
            ("chat-input", "one", true),
        ] {
            fs::write(
                directory.join("one.jsonl"),
                json!({"type":"user","source":source,"session_id":session}).to_string(),
            )
            .unwrap();
            assert_eq!(has_chat_origin(&data, "one").unwrap(), accepted);
        }
        assert!(!has_chat_origin(&data, "missing").unwrap());
        assert!(has_chat_origin(&data, "../escape").is_err());
        fs::remove_file(directory.join("one.jsonl")).unwrap();
        fs::remove_dir(directory).unwrap();
        fs::remove_dir(data).unwrap();
    }

    #[test]
    fn rejects_cli_and_broken_branches_and_selects_active_path() {
        assert!(snapshot(r#"{"sessions":[]}"#, "id").is_err());
        let mut value: Value = serde_json::from_str(&source()).unwrap();
        value["turns"].as_array_mut().unwrap().extend([
            json!({"id":"b","parentId":"a","role":"assistant","text":"selected","createdAt":"2026-09-14T00:00:01Z"}),
            json!({"id":"c","parentId":"a","role":"assistant","text":"other","createdAt":"2026-09-14T00:00:02Z"}),
        ]);
        value["activeLeafId"] = json!("b");
        let read = snapshot(&value.to_string(), "id").unwrap();
        assert_eq!(read["events"].as_array().unwrap().len(), 2);
        assert_eq!(
            read["events"][1]["message"]["content"][0]["text"],
            "selected"
        );
        value["turns"][0]["parentId"] = json!("b");
        assert!(snapshot(&value.to_string(), "id").is_err());
        value["activeLeafId"] = json!("missing");
        assert!(snapshot(&value.to_string(), "id").is_err());
        assert!(snapshot(&"x".repeat(IMPORT_LIMIT + 1), "id").is_err());
    }
}
