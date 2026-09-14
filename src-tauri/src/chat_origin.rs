use std::path::Path;

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
        assert!(!has_chat_origin(&data, "missing").unwrap());
        assert!(has_chat_origin(&data, "../escape").is_err());
        fs::remove_file(directory.join("one.jsonl")).unwrap();
        fs::remove_dir(directory).unwrap();
        fs::remove_dir(data).unwrap();
    }
}
