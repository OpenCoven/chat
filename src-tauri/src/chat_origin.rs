use std::{
    fs::{self, File},
    io::{BufRead, BufReader, Read},
    path::Path,
};

use serde_json::Value;

/// Chat writes its provenance marker as the second transcript line, straight
/// after the engine's `system/init` event, so this much prefix always covers it.
const ORIGIN_PROBE_LIMIT: u64 = 256 * 1024;

pub(crate) fn has_chat_origin(data: &Path, id: &str) -> Result<bool, String> {
    Ok(captured_input(data, id)?.is_some())
}

/// The input event Chat saved for session `id`, which also names the session
/// it continued (`parent_session_id`). `None` when the transcript is missing
/// or Chat did not create it. Only the first two lines are read.
pub(crate) fn captured_input(data: &Path, id: &str) -> Result<Option<Value>, String> {
    crate::coven_runtime::validate_id(id)?;
    let transcript =
        crate::coven_runtime::transcripts_dir(data, false)?.join(format!("{id}.jsonl"));
    let metadata = match fs::symlink_metadata(&transcript) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("Cannot inspect saved Coven transcript.".into()),
    };
    if !metadata.is_file() {
        return Err("Saved Coven transcript is invalid.".into());
    }
    let file = File::open(&transcript).map_err(|_| "Cannot read saved Coven transcript.")?;
    let mut reader = BufReader::new(file.take(ORIGIN_PROBE_LIMIT));
    let mut line = Vec::new();
    let mut lines = 0;
    while lines < 2 {
        line.clear();
        let read = reader
            .read_until(b'\n', &mut line)
            .map_err(|_| "Cannot read saved Coven transcript.")?;
        if read == 0 {
            break;
        }
        let text = line.strip_suffix(b"\n").unwrap_or(&line);
        if text.is_empty() {
            continue;
        }
        lines += 1;
        let Ok(event) = serde_json::from_slice::<Value>(text) else {
            continue;
        };
        if event["type"] == "user"
            && event["source"] == "chat-input"
            && event["session_id"].as_str() == Some(id)
        {
            return Ok(Some(event));
        }
    }
    Ok(None)
}

pub(crate) fn require_chat_origin(data: &Path, id: &str) -> Result<(), String> {
    if has_chat_origin(data, id)? {
        Ok(())
    } else {
        Err(
            "This session was not created in Chat. Only app-owned familiar threads can be opened."
                .into(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

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
        // The marker is always the second transcript line, so origin must be
        // decided from a bounded prefix: listing hundreds of sessions must not
        // parse every full transcript, and an oversized history still proves
        // origin without being loaded.
        let mut oversized = String::new();
        oversized
            .push_str(&json!({"type":"system","subtype":"init","session_id":"one"}).to_string());
        oversized.push('\n');
        oversized
            .push_str(&json!({"type":"user","source":"chat-input","session_id":"one"}).to_string());
        oversized.push('\n');
        let filler = json!({"type":"assistant","text":"x".repeat(4096)}).to_string();
        while oversized.len() <= crate::coven_runtime::TRANSCRIPT_LIMIT {
            oversized.push_str(&filler);
            oversized.push('\n');
        }
        oversized.push_str("{not json");
        fs::write(directory.join("one.jsonl"), oversized).unwrap();
        assert!(has_chat_origin(&data, "one").unwrap());
        assert!(crate::coven_runtime::read_local_events(&data, "one").is_err());
        assert!(!has_chat_origin(&data, "missing").unwrap());
        assert!(has_chat_origin(&data, "../escape").is_err());
        fs::remove_file(directory.join("one.jsonl")).unwrap();
        fs::remove_dir(directory).unwrap();
        fs::remove_dir(data).unwrap();
    }
}
