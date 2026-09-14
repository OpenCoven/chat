use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::Path,
    sync::Mutex,
};

use serde::{Deserialize, Serialize};

const LIMIT: usize = 2 * 1024 * 1024;
const ENTRY_LIMIT: usize = 10_000;
pub(crate) static STORAGE_LOCK: Mutex<()> = Mutex::new(());

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Lifecycle {
    Active,
    Archived,
    Deleted,
}

pub(crate) fn load(data: &Path) -> Result<BTreeMap<String, Lifecycle>, String> {
    let path = data.join("chat-lifecycle-v1.json");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(_) => return Err("Cannot inspect Chat lifecycle storage.".into()),
    };
    if !metadata.is_file() || metadata.len() > LIMIT as u64 {
        return Err("Chat lifecycle storage is invalid or exceeds 2 MiB.".into());
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| "Cannot open Chat lifecycle storage.")?
        .take((LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read Chat lifecycle storage.")?;
    if bytes.len() > LIMIT {
        return Err("Chat lifecycle storage exceeds 2 MiB.".into());
    }
    let entries: BTreeMap<String, Lifecycle> =
        serde_json::from_slice(&bytes).map_err(|_| "Chat lifecycle storage is invalid.")?;
    if entries.len() > ENTRY_LIMIT {
        return Err("Chat lifecycle storage exceeds 10,000 entries.".into());
    }
    for id in entries.keys() {
        crate::coven_runtime::validate_id(id)?;
    }
    Ok(entries)
}

pub(crate) fn state(data: &Path, id: &str) -> Result<Lifecycle, String> {
    crate::coven_runtime::validate_id(id)?;
    Ok(load(data)?.get(id).copied().unwrap_or(Lifecycle::Active))
}

pub(crate) fn require_visible(data: &Path, id: &str) -> Result<(), String> {
    if state(data, id)? == Lifecycle::Deleted {
        return Err(
            "This chat was deleted from Chat. Original CLI/Cave history is untouched.".into(),
        );
    }
    Ok(())
}

pub(crate) fn require_active(data: &Path, id: &str) -> Result<(), String> {
    match state(data, id)? {
        Lifecycle::Active => Ok(()),
        Lifecycle::Archived => Err("Restore this archived chat before sending a message.".into()),
        Lifecycle::Deleted => {
            Err("This chat was deleted from Chat. Original CLI/Cave history is untouched.".into())
        }
    }
}

// Caller holds STORAGE_LOCK and the runtime's run-registration lock.
pub(crate) fn change(data: &Path, id: &str, next: Lifecycle) -> Result<(), String> {
    crate::coven_runtime::validate_id(id)?;
    let mut entries = load(data)?;
    if entries.get(id) == Some(&Lifecycle::Deleted) {
        if next != Lifecycle::Deleted {
            return Err("Deleted chats cannot be restored.".into());
        }
    } else if crate::chat_origin::read_import(data, id)?.is_none() {
        crate::chat_origin::require_chat_origin(data, id)?;
    }
    if next == Lifecycle::Active {
        entries.remove(id);
    } else {
        entries.insert(id.to_owned(), next);
    }
    if entries.len() > ENTRY_LIMIT {
        return Err("Chat lifecycle storage is full (10,000 entries); no change was saved.".into());
    }
    let bytes = serde_json::to_vec(&entries).map_err(|_| "Cannot encode Chat lifecycle.")?;
    if bytes.len() > LIMIT {
        return Err("Chat lifecycle storage is full (2 MiB); no change was saved.".into());
    }
    fs::create_dir_all(data).map_err(|_| "Cannot create Chat lifecycle storage.")?;
    let temporary = data.join(format!("chat-lifecycle-{}.tmp", uuid::Uuid::new_v4()));
    let write = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|_| "Cannot create Chat lifecycle.")?;
        file.write_all(&bytes)
            .map_err(|_| "Cannot save Chat lifecycle.")?;
        file.sync_all()
            .map_err(|_| "Cannot persist Chat lifecycle.")?;
        fs::rename(&temporary, data.join("chat-lifecycle-v1.json"))
            .map_err(|_| "Cannot register Chat lifecycle.")?;
        #[cfg(unix)]
        File::open(data)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| "Cannot persist Chat lifecycle directory.")?;
        Ok::<_, String>(())
    })();
    if write.is_err() && temporary.exists() {
        if let Err(error) = fs::remove_file(&temporary) {
            eprintln!("Cannot clean incomplete Chat lifecycle: {error}");
        }
    }
    write?;
    if next == Lifecycle::Deleted {
        // Persist the tombstone first: even interrupted cleanup must never resurrect history.
        let path = if id.starts_with("cave-import-") {
            data.join("cave-imports").join(format!("{id}.json"))
        } else {
            data.join("coven-transcripts").join(format!("{id}.jsonl"))
        };
        match fs::remove_file(path) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err("Chat is hidden permanently, but its local copy could not be removed. Retry Delete to finish cleanup.".into()),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn archive_restore_delete_are_durable_and_deleted_ids_never_restore() {
        let data = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let transcripts = data.join("coven-transcripts");
        fs::create_dir_all(&transcripts).unwrap();
        let path = transcripts.join("owned.jsonl");
        let original =
            json!({"type":"user","source":"chat-input","session_id":"owned"}).to_string();
        fs::write(&path, &original).unwrap();
        change(&data, "owned", Lifecycle::Archived).unwrap();
        assert_eq!(state(&data, "owned").unwrap(), Lifecycle::Archived);
        assert!(require_visible(&data, "owned").is_ok());
        assert!(require_active(&data, "owned").is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), original);
        change(&data, "owned", Lifecycle::Active).unwrap();
        assert!(require_active(&data, "owned").is_ok());
        assert!(load(&data).unwrap().is_empty());
        change(&data, "owned", Lifecycle::Deleted).unwrap();
        assert!(!path.exists());
        assert!(require_visible(&data, "owned").is_err());
        assert!(change(&data, "owned", Lifecycle::Active).is_err());
        assert!(change(&data, "owned", Lifecycle::Archived).is_err());
        change(&data, "owned", Lifecycle::Deleted).unwrap();
        assert_eq!(load(&data).unwrap().get("owned"), Some(&Lifecycle::Deleted));
        fs::remove_file(data.join("chat-lifecycle-v1.json")).unwrap();
        fs::remove_dir(transcripts).unwrap();
        fs::remove_dir(data).unwrap();
    }

    #[test]
    fn rejects_unowned_paths_corrupt_and_oversized_storage_without_overwriting() {
        let data = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        assert!(change(&data, "../outside", Lifecycle::Deleted).is_err());
        assert!(change(&data, "external-cli", Lifecycle::Deleted).is_err());
        fs::create_dir_all(&data).unwrap();
        let path = data.join("chat-lifecycle-v1.json");
        for bytes in [b"{broken".to_vec(), vec![b' '; LIMIT + 1]] {
            fs::write(&path, &bytes).unwrap();
            assert!(load(&data).is_err());
            assert!(change(&data, "external-cli", Lifecycle::Archived).is_err());
            assert_eq!(fs::read(&path).unwrap(), bytes);
        }
        let entries: BTreeMap<_, _> = (0..=ENTRY_LIMIT)
            .map(|i| (format!("chat-{i}"), Lifecycle::Deleted))
            .collect();
        fs::write(&path, serde_json::to_vec(&entries).unwrap()).unwrap();
        assert!(load(&data).unwrap_err().contains("10,000"));
        fs::remove_file(path).unwrap();
        fs::remove_dir(data).unwrap();
    }
}
