use std::{
    collections::{BTreeMap, HashSet},
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
        Err(_) => return Err("Chat's archive and delete records could not be checked.".into()),
    };
    if !metadata.is_file() || metadata.len() > LIMIT as u64 {
        return Err("Chat's archive and delete records are unreadable or larger than 2 MiB; they were left unchanged.".into());
    }
    let mut bytes = Vec::new();
    File::open(path)
        .map_err(|_| "Chat's archive and delete records could not be opened.")?
        .take((LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "Chat's archive and delete records could not be read.")?;
    if bytes.len() > LIMIT {
        return Err("Chat's archive and delete records are larger than 2 MiB.".into());
    }
    let entries: BTreeMap<String, Lifecycle> = serde_json::from_slice(&bytes)
        .map_err(|_| "Chat's archive and delete records are unreadable.")?;
    if entries.len() > ENTRY_LIMIT {
        return Err("Chat's archive and delete records hold more than 10,000 entries.".into());
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
    } else {
        crate::chat_origin::require_chat_origin(data, id)?;
    }
    if next == Lifecycle::Active {
        entries.remove(id);
    } else {
        entries.insert(id.to_owned(), next);
    }
    if entries.len() > ENTRY_LIMIT {
        return Err(
            "Chat's archive and delete records are full (10,000 entries); nothing was changed."
                .into(),
        );
    }
    let bytes = serde_json::to_vec(&entries).map_err(|_| "Cannot encode Chat lifecycle.")?;
    if bytes.len() > LIMIT {
        return Err(
            "Chat's archive and delete records are full (2 MiB); nothing was changed.".into(),
        );
    }
    persist(data, "chat-lifecycle-v1.json", &bytes)?;
    if next == Lifecycle::Deleted {
        // Commit the tombstone before cleanup; imported files are never touched.
        remove_transcripts(data, id)?;
    }
    Ok(())
}

/// Removes a deleted chat's saved transcripts and the attachments staged for
/// them. Chat saves one transcript per message, so the chat is its own session
/// plus every earlier session it continues. Sessions another current chat
/// continues are kept. Ancestors go oldest first and the chat's own transcript
/// last, each after its attachments: if a removal fails, what remains is still
/// reachable from the chat, so retrying Delete finishes it.
fn remove_transcripts(data: &Path, id: &str) -> Result<(), String> {
    const RETRY: &str = "Chat is hidden permanently, but its local copy could not be removed. Retry Delete to finish cleanup.";
    let directory = crate::coven_runtime::transcripts_dir(data, false)?;
    for session in removal_order(data, id)? {
        if let Some(run) = attachment_run(data, &session) {
            crate::coven_runtime::attachments::remove(data, &run).map_err(|_| RETRY)?;
        }
        match fs::remove_file(directory.join(format!("{session}.jsonl"))) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(RETRY.into()),
        }
    }
    Ok(())
}

/// The folder session `id`'s attachments were staged in, as its saved input
/// names it. Inputs saved before Chat recorded the folder name none.
fn attachment_run(data: &Path, id: &str) -> Option<String> {
    let input = crate::chat_origin::captured_input(data, id).ok()??;
    let run = input.get("attachment_run_id")?.as_str()?;
    crate::coven_runtime::validate_id(run).ok()?;
    Some(run.to_owned())
}

fn removal_order(data: &Path, id: &str) -> Result<Vec<String>, String> {
    let mut kept = HashSet::new();
    for head in crate::chat_canonical::load(data)?.into_values().flatten() {
        if head != id {
            kept.extend(lineage(data, &head));
        }
    }
    let mut order: Vec<String> = lineage(data, id)
        .into_iter()
        .rev()
        .filter(|session| session != id && !kept.contains(session))
        .collect();
    order.push(id.to_owned());
    Ok(order)
}

/// Session `id` followed by each session it continues, newest first, through
/// the parent Chat records in each transcript. The walk ends at a session Chat
/// did not create, a transcript it cannot read, an invalid parent, or a cycle.
fn lineage(data: &Path, id: &str) -> Vec<String> {
    let mut chain = Vec::new();
    let mut seen = HashSet::new();
    let mut next = Some(id.to_owned());
    while let Some(session) = next.take() {
        if !seen.insert(session.clone()) {
            break;
        }
        let Ok(Some(input)) = crate::chat_origin::captured_input(data, &session) else {
            break;
        };
        chain.push(session);
        next = input
            .get("parent_session_id")
            .and_then(serde_json::Value::as_str)
            .filter(|parent| crate::coven_runtime::validate_id(parent).is_ok())
            .map(str::to_owned);
    }
    chain
}

pub(crate) fn persist(data: &Path, name: &str, bytes: &[u8]) -> Result<(), String> {
    if bytes.len() > LIMIT {
        return Err(
            "This change would make Chat's records larger than 2 MiB, so nothing was saved.".into(),
        );
    }
    fs::create_dir_all(data)
        .map_err(|_| "Chat's archive and delete records could not be created.")?;
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
        file.write_all(bytes)
            .map_err(|_| "Cannot save Chat lifecycle.")?;
        file.sync_all()
            .map_err(|_| "Cannot persist Chat lifecycle.")?;
        fs::rename(&temporary, data.join(name)).map_err(|_| "Cannot register Chat lifecycle.")?;
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
    write
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

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

    /// Writes a transcript the way a Chat run does: the engine's init event,
    /// then Chat's captured input naming the turn it continues.
    fn write_turn(transcripts: &Path, id: &str, parent: Option<&str>) {
        let lines = [
            json!({"type":"system","subtype":"init","session_id":id}),
            json!({"type":"user","source":"chat-input","session_id":id,"parent_session_id":parent}),
        ];
        let text = lines.map(|line| line.to_string()).join("\n");
        fs::write(transcripts.join(format!("{id}.jsonl")), text).unwrap();
    }

    #[test]
    fn delete_removes_every_transcript_the_chat_continues() {
        let data = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let transcripts = data.join("coven-transcripts");
        fs::create_dir_all(&transcripts).unwrap();
        write_turn(&transcripts, "first", None);
        write_turn(&transcripts, "second", Some("first"));
        write_turn(&transcripts, "third", Some("second"));
        change(&data, "third", Lifecycle::Deleted).unwrap();
        for id in ["first", "second", "third"] {
            assert!(
                !transcripts.join(format!("{id}.jsonl")).exists(),
                "{id} must not outlive its deleted chat"
            );
        }
        fs::remove_dir_all(data).unwrap();
    }

    /// A turn sent with attachments: its saved input names the folder the
    /// files were staged in, and that folder holds a copy of them.
    fn write_attached_turn(data: &Path, id: &str, parent: Option<&str>, run: &str) -> PathBuf {
        let input = json!({"type":"user","source":"chat-input","session_id":id,
            "parent_session_id":parent,"attachments":[{"name":"notes.txt","size":6}],
            "attachment_run_id":run});
        let init = json!({"type":"system","subtype":"init","session_id":id});
        fs::write(
            data.join("coven-transcripts").join(format!("{id}.jsonl")),
            format!("{init}\n{input}"),
        )
        .unwrap();
        let folder = data.join("coven-attachments").join(run);
        if crate::coven_runtime::validate_id(run).is_ok() {
            fs::create_dir_all(&folder).unwrap();
            fs::write(folder.join("0-notes.txt"), "secret").unwrap();
        }
        folder
    }

    #[test]
    fn delete_removes_the_attachments_of_every_turn_in_the_chat() {
        let data = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let transcripts = data.join("coven-transcripts");
        let attachments = data.join("coven-attachments");
        fs::create_dir_all(&transcripts).unwrap();
        fs::create_dir_all(&attachments).unwrap();
        let first = write_attached_turn(&data, "first", None, "run-1");
        write_turn(&transcripts, "second", Some("first"));
        let third = write_attached_turn(&data, "third", Some("second"), "run-3");
        // A folder no saved input names is not this chat's to remove.
        let unattributed = attachments.join("run-unknown");
        fs::create_dir_all(&unattributed).unwrap();
        // A folder name that would leave attachment storage is not followed.
        write_attached_turn(&data, "escape", None, "../outside");
        let outside = data.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep"), "keep").unwrap();

        change(&data, "third", Lifecycle::Deleted).unwrap();
        assert!(!first.exists(), "the first turn's attachments must go");
        assert!(!third.exists(), "the newest turn's attachments must go");
        assert!(unattributed.exists());
        change(&data, "escape", Lifecycle::Deleted).unwrap();
        assert!(outside.join("keep").exists());
        fs::remove_dir_all(data).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn delete_never_follows_a_symlinked_attachment_folder() {
        let data = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(data.join("coven-transcripts")).unwrap();
        fs::create_dir_all(data.join("coven-attachments")).unwrap();
        let outside = data.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep"), "keep").unwrap();
        write_attached_turn(&data, "linked", None, "run-link");
        let link = data.join("coven-attachments").join("run-link");
        fs::remove_dir_all(&link).unwrap();
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        change(&data, "linked", Lifecycle::Deleted).unwrap();
        assert!(outside.join("keep").exists());
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn delete_removes_the_oldest_transcripts_first_so_a_retry_can_finish() {
        let data = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let transcripts = data.join("coven-transcripts");
        fs::create_dir_all(&transcripts).unwrap();
        write_turn(&transcripts, "first", None);
        write_turn(&transcripts, "second", Some("first"));
        write_turn(&transcripts, "third", Some("second"));
        assert_eq!(
            removal_order(&data, "third").unwrap(),
            ["first", "second", "third"]
        );
        // After a removal fails part way, the rest is still reachable.
        fs::remove_file(transcripts.join("first.jsonl")).unwrap();
        assert_eq!(removal_order(&data, "third").unwrap(), ["second", "third"]);
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn delete_keeps_transcripts_the_chat_does_not_own() {
        let data = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let transcripts = data.join("coven-transcripts");
        fs::create_dir_all(&transcripts).unwrap();
        // A session Chat did not create is never touched, even as an ancestor.
        let external = transcripts.join("external.jsonl");
        fs::write(
            &external,
            json!({"type":"user","source":"cli","session_id":"external"}).to_string(),
        )
        .unwrap();
        write_turn(&transcripts, "continued", Some("external"));
        write_turn(&transcripts, "mine", Some("continued"));
        // A turn another familiar's current chat continues stays with that chat.
        write_turn(&transcripts, "shared", None);
        write_turn(&transcripts, "ours", Some("shared"));
        write_turn(&transcripts, "theirs", Some("shared"));
        fs::write(
            data.join("chat-canonical-v1.json"),
            json!({"f1":"ours","f2":"theirs"}).to_string(),
        )
        .unwrap();
        // A parent identifier that would leave the directory is not followed.
        write_turn(&transcripts, "escape", Some("../outside"));
        let outside = data.join("outside.jsonl");
        fs::write(&outside, "keep").unwrap();
        // A lineage cycle ends the walk instead of looping.
        write_turn(&transcripts, "loop-a", Some("loop-b"));
        write_turn(&transcripts, "loop-b", Some("loop-a"));

        change(&data, "mine", Lifecycle::Deleted).unwrap();
        assert!(!transcripts.join("mine.jsonl").exists());
        assert!(!transcripts.join("continued.jsonl").exists());
        assert!(
            external.exists(),
            "Chat never deletes history it did not create"
        );

        change(&data, "ours", Lifecycle::Deleted).unwrap();
        assert!(!transcripts.join("ours.jsonl").exists());
        assert!(transcripts.join("shared.jsonl").exists());
        assert!(transcripts.join("theirs.jsonl").exists());

        change(&data, "escape", Lifecycle::Deleted).unwrap();
        assert!(!transcripts.join("escape.jsonl").exists());
        assert_eq!(fs::read_to_string(&outside).unwrap(), "keep");

        change(&data, "loop-a", Lifecycle::Deleted).unwrap();
        assert!(!transcripts.join("loop-a.jsonl").exists());
        assert!(!transcripts.join("loop-b.jsonl").exists());
        fs::remove_dir_all(data).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn delete_never_follows_a_symlinked_transcript_directory() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let data = root.join("data");
        let outside = root.join("outside");
        fs::create_dir_all(&data).unwrap();
        fs::create_dir_all(&outside).unwrap();
        let victim = outside.join("owned.jsonl");
        fs::write(
            &victim,
            json!({"type":"user","source":"chat-input","session_id":"owned"}).to_string(),
        )
        .unwrap();
        std::os::unix::fs::symlink(&outside, data.join("coven-transcripts")).unwrap();
        let error = change(&data, "owned", Lifecycle::Deleted).unwrap_err();
        assert!(error.contains("transcript"), "{error}");
        assert!(
            victim.exists(),
            "delete must not reach through the symlinked directory"
        );
        assert!(
            load(&data).unwrap().is_empty(),
            "no tombstone without a real directory"
        );
        fs::remove_dir_all(root).unwrap();
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
