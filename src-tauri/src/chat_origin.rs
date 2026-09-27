use std::{
    fs::{self, File},
    io::Read,
    path::Path,
};

use serde_json::Value;

/// Chat writes its provenance marker as the second transcript line, straight
/// after the engine's `system/init` event, so this much prefix always covers it.
const ORIGIN_PROBE_LIMIT: u64 = 256 * 1024;

pub(crate) fn has_chat_origin(data: &Path, id: &str) -> Result<bool, String> {
    crate::coven_runtime::validate_id(id)?;
    let transcript =
        crate::coven_runtime::transcripts_dir(data, false)?.join(format!("{id}.jsonl"));
    let metadata = match fs::symlink_metadata(&transcript) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(_) => return Err("Cannot inspect saved Coven transcript.".into()),
    };
    if !metadata.is_file() {
        return Err("Saved Coven transcript is invalid.".into());
    }
    let mut prefix = Vec::new();
    File::open(&transcript)
        .map_err(|_| "Cannot read saved Coven transcript.")?
        .take(ORIGIN_PROBE_LIMIT)
        .read_to_end(&mut prefix)
        .map_err(|_| "Cannot read saved Coven transcript.")?;
    Ok(prefix
        .split(|b| *b == b'\n')
        .filter(|line| !line.is_empty())
        .take(2)
        .filter_map(|line| serde_json::from_slice::<Value>(line).ok())
        .any(|event| {
            event["type"] == "user"
                && event["source"] == "chat-input"
                && event["session_id"].as_str() == Some(id)
        }))
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
