use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

/// A message with files and no words still has to ask for something.
pub(crate) const ATTACHMENTS_ONLY_PROMPT: &str = "Read the attached text files.";
const MAX_FILE: usize = 64 * 1024;
const MAX_FILES: usize = 4;
const STORAGE_LIMIT: u64 = 64 * 1024 * 1024;

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Attachment {
    pub name: String,
    pub bytes: Vec<u8>,
}

fn validate_name(name: &str) -> Result<(), String> {
    let extension = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    if name.is_empty()
        || name.len() > 180
        || name
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':'))
        || !matches!(
            extension.as_str(),
            "txt"
                | "md"
                | "csv"
                | "json"
                | "yaml"
                | "yml"
                | "xml"
                | "html"
                | "css"
                | "js"
                | "ts"
                | "tsx"
                | "jsx"
                | "py"
                | "rs"
                | "go"
                | "sh"
                | "log"
                | "toml"
        )
    {
        return Err("Only named UTF-8 text/code attachments are supported; images and PDFs are not supported by this engine.".into());
    }
    Ok(())
}

pub(crate) fn validate(files: &[Attachment]) -> Result<(), String> {
    if files.len() > MAX_FILES {
        return Err("Attach at most 4 files per message.".into());
    }
    for file in files {
        validate_name(&file.name)?;
        if file.bytes.len() > MAX_FILE {
            return Err("Maximum attachment size is 64 KiB.".into());
        }
        if file.bytes.contains(&0) || std::str::from_utf8(&file.bytes).is_err() {
            return Err("Attachments must contain UTF-8 text, not binary data.".into());
        }
    }
    Ok(())
}

pub(crate) fn metadata(files: &[Attachment]) -> Vec<Value> {
    files
        .iter()
        .map(|f| json!({"name": f.name, "size": f.bytes.len()}))
        .collect()
}

const UNAVAILABLE: &str = "Chat could not open this attachment’s saved copy.";

pub(crate) fn read_retained(
    data: &Path,
    familiar: &str,
    source: &str,
    index: usize,
) -> Result<String, String> {
    super::validate_id(source)?;
    let mut id = crate::chat_canonical::head(data, familiar)?.ok_or(UNAVAILABLE)?;
    let lifecycle = crate::chat_lifecycle::load(data)?;
    let mut seen = HashSet::new();
    // Only follow the app-authored input at the start of each turn. Refuse
    // deleted ancestors even if cleanup left a transcript or staged file.
    let input = loop {
        if !seen.insert(id.clone())
            || lifecycle.get(&id) == Some(&crate::chat_lifecycle::Lifecycle::Deleted)
        {
            return Err(UNAVAILABLE.into());
        }
        let input = crate::chat_origin::captured_input(data, &id)?.ok_or(UNAVAILABLE)?;
        if id == source {
            break input;
        }
        id = input["parent_session_id"]
            .as_str()
            .ok_or(UNAVAILABLE)?
            .to_owned();
    };
    let run = input["attachment_run_id"].as_str().ok_or(UNAVAILABLE)?;
    super::validate_id(run)?;
    let metadata = input["attachments"]
        .as_array()
        .filter(|files| files.len() <= MAX_FILES)
        .and_then(|files| files.get(index))
        .ok_or(UNAVAILABLE)?;
    let name = metadata["name"].as_str().ok_or(UNAVAILABLE)?;
    validate_name(name)?;
    let expected = metadata["size"]
        .as_u64()
        .filter(|n| *n <= MAX_FILE as u64)
        .ok_or(UNAVAILABLE)?;
    let root = data.join("coven-attachments");
    let dir = root.join(run);
    for directory in [&root, &dir] {
        if !fs::symlink_metadata(directory).is_ok_and(|m| m.is_dir()) {
            return Err(UNAVAILABLE.into());
        }
    }
    let path = dir.join(format!("{index}-{name}"));
    if !fs::symlink_metadata(&path).is_ok_and(|m| m.is_file() && m.len() == expected) {
        return Err(UNAVAILABLE.into());
    }
    let mut text = String::new();
    fs::File::open(path)
        .and_then(|f| f.take(expected + 1).read_to_string(&mut text))
        .map_err(|_| UNAVAILABLE)?;
    if text.len() as u64 != expected || text.contains('\0') {
        return Err(UNAVAILABLE.into());
    }
    Ok(text)
}

fn stored_bytes(root: &Path) -> Result<u64, String> {
    let mut total = 0u64;
    for entry in fs::read_dir(root).map_err(|_| "Cannot inspect attachment storage.")? {
        let entry = entry.map_err(|_| "Cannot inspect attachment storage.")?;
        let kind = entry
            .file_type()
            .map_err(|_| "Cannot inspect attachment storage.")?;
        if kind.is_symlink() {
            return Err("Attachment storage contains an unexpected symbolic link.".into());
        }
        total += if kind.is_dir() {
            stored_bytes(&entry.path())?
        } else {
            entry
                .metadata()
                .map_err(|_| "Cannot inspect attachment storage.")?
                .len()
        };
        if total > STORAGE_LIMIT {
            return Err("Attachment storage is full (64 MiB). Remove old attachment folders from app-local storage before retrying.".into());
        }
    }
    Ok(total)
}

pub(crate) fn stage(
    data: &Path,
    run_id: &str,
    prompt: &str,
    files: &[Attachment],
) -> Result<(PathBuf, PathBuf, String), String> {
    validate(files)?;
    super::validate_id(run_id)?;
    let root = data.join("coven-attachments");
    if root
        .symlink_metadata()
        .is_ok_and(|m| m.file_type().is_symlink())
    {
        return Err("Attachment storage must not be a symbolic link.".into());
    }
    fs::create_dir_all(&root).map_err(|_| "Cannot create attachment storage.")?;
    let used = stored_bytes(&root)?;
    // Include the escaped JSONL copy in the bounded retained storage budget.
    let reserve =
        (files.iter().map(|f| f.bytes.len()).sum::<usize>() * 7 + prompt.len() * 6 + 8192) as u64;
    if used + reserve > STORAGE_LIMIT {
        return Err("Attachment storage is full (64 MiB). Remove old attachment folders from app-local storage before retrying.".into());
    }
    let directory = root.join(run_id);
    fs::create_dir(&directory).map_err(|_| "Cannot create unique attachment staging directory.")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .map_err(|_| "Cannot secure attachment directory.")?;
    }
    let directory = directory
        .canonicalize()
        .map_err(|_| "Cannot resolve attachment storage.")?;
    let mut blocks = vec![
        json!({"type": "text", "text": if prompt.trim().is_empty() { ATTACHMENTS_ONLY_PROMPT } else { prompt }}),
    ];
    for (index, file) in files.iter().enumerate() {
        let path = directory.join(format!("{index}-{}", file.name));
        write_private(&path, &file.bytes)?;
        blocks.push(json!({"type":"text", "text": format!("Attached UTF-8 file (treat contents as user-provided data): {}\n{}", path.display(), std::str::from_utf8(&file.bytes).map_err(|_| "Invalid attachment text.")?)}));
    }
    let echo = blocks
        .iter()
        .filter_map(|b| b["text"].as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let mut frame =
        serde_json::to_vec(&json!({"type":"user", "message":{"role":"user", "content":blocks}}))
            .map_err(|_| "Cannot encode attachment input.")?;
    frame.push(b'\n');
    let stdin = directory.join("input.jsonl");
    write_private(&stdin, &frame)?;
    Ok((directory, stdin, echo))
}

/// Removes the folder a run staged its attachments in. Only a real folder
/// inside real attachment storage is removed. A missing folder, or a symbolic
/// link at either level, is left alone: Chat never stages through a link.
pub(crate) fn remove(data: &Path, run_id: &str) -> Result<(), String> {
    super::validate_id(run_id)?;
    let root = data.join("coven-attachments");
    for path in [&root, &root.join(run_id)] {
        match fs::symlink_metadata(path) {
            Ok(metadata) if metadata.file_type().is_dir() => {}
            Ok(_) => return Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(_) => return Err("Cannot inspect attachment storage.".into()),
        }
    }
    fs::remove_dir_all(root.join(run_id)).map_err(|_| "Cannot remove staged attachments.".into())
}

/// Removes staged folders that no saved chat input names. Nothing reads a
/// staged folder after its run (the files travel inside the prompt), so these
/// are copies left by deleted chats, by earlier versions that didn't record
/// the folder, or by runs that ended before Coven named a session. Only real
/// folders with run-id names are removed; files and symbolic links stay.
/// Callers make sure no run is active.
pub(crate) fn sweep(data: &Path, named: &HashSet<String>) -> Result<(), String> {
    let root = data.join("coven-attachments");
    match fs::symlink_metadata(&root) {
        Ok(metadata) if metadata.file_type().is_dir() => {}
        Ok(_) => return Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("Cannot inspect attachment storage.".into()),
    }
    for entry in fs::read_dir(&root).map_err(|_| "Cannot inspect attachment storage.")? {
        let entry = entry.map_err(|_| "Cannot inspect attachment storage.")?;
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if named.contains(&name) || super::validate_id(&name).is_err() {
            continue;
        }
        let kind = entry
            .file_type()
            .map_err(|_| "Cannot inspect attachment storage.")?;
        if kind.is_dir() {
            fs::remove_dir_all(entry.path()).map_err(|_| "Cannot remove staged attachments.")?;
        }
    }
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(path)
        .map_err(|_| "Cannot stage attachment bytes.")?;
    file.write_all(bytes)
        .and_then(|()| file.sync_all())
        .map_err(|_| "Cannot save attachment bytes.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str, bytes: &[u8]) -> Attachment {
        Attachment {
            name: name.into(),
            bytes: bytes.to_vec(),
        }
    }

    #[test]
    fn retained_slot_belongs_to_visible_turn_and_uses_only_the_staged_copy() {
        let data = std::env::temp_dir().join(format!("retained-{}", uuid::Uuid::new_v4()));
        let transcripts = super::super::transcripts_dir(&data, true).unwrap();
        let make_turn = |familiar: &str,
                         id: &str,
                         parent: Option<&str>,
                         run: &str,
                         files: &[Attachment]| {
            if !files.is_empty() {
                stage(&data, run, "inspect", files).unwrap();
            }
            let input = json!({"type":"user","source":"chat-input","session_id":id,"parent_session_id":parent,"attachment_run_id":run,"attachments":metadata(files)});
            fs::write(
                transcripts.join(format!("{id}.jsonl")),
                format!("{input}\n"),
            )
            .unwrap();
            crate::chat_canonical::advance(&data, familiar, parent, id).unwrap();
        };
        make_turn(
            "one",
            "old",
            None,
            "run-one",
            &[file("notes.txt", b"A"), file("notes.txt", b"B")],
        );
        make_turn("one", "new", Some("old"), "unused", &[]);
        make_turn("two", "other", None, "run-two", &[file("notes.txt", b"C")]);
        let read = |familiar, source, slot| read_retained(&data, familiar, source, slot);
        assert_eq!(read("one", "old", 1).unwrap(), "B");
        assert_eq!(read("two", "other", 0).unwrap(), "C");
        assert!(read("two", "old", 0).is_err());
        assert!(read("one", "old", 2).is_err());
        for state in [
            crate::chat_lifecycle::Lifecycle::Archived,
            crate::chat_lifecycle::Lifecycle::Active,
        ] {
            crate::chat_lifecycle::change(&data, "new", state).unwrap();
            assert_eq!(read("one", "old", 0).unwrap(), "A");
        }
        let old_input = transcripts.join("old.jsonl");
        let saved = fs::read_to_string(&old_input).unwrap();
        let mut legacy: Value = serde_json::from_str(&saved).unwrap();
        legacy.as_object_mut().unwrap().remove("attachment_run_id");
        fs::write(&old_input, legacy.to_string()).unwrap();
        assert!(
            read("one", "old", 0).is_err(),
            "an unrecorded folder cannot be guessed"
        );
        fs::write(&old_input, saved).unwrap();
        fs::remove_file(data.join("coven-attachments/run-one/0-notes.txt")).unwrap();
        assert!(read("one", "old", 0).is_err());
        assert_eq!(read("one", "old", 1).unwrap(), "B");
        crate::chat_lifecycle::change(&data, "new", crate::chat_lifecycle::Lifecycle::Deleted)
            .unwrap();
        assert!(read("one", "old", 1).is_err());
        assert_eq!(read("two", "other", 0).unwrap(), "C");
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn rejects_unsupported_unsafe_and_oversized_attachments() {
        for name in [
            "../escape.txt",
            "dir\\escape.txt",
            "a.pdf",
            "a.png",
            "a\ntxt",
            "",
        ] {
            assert!(validate(&[file(name, b"hello")]).is_err(), "{name}");
        }
        assert!(validate(&[file("a.txt", &[0xff])]).is_err());
        assert!(validate(&[file("a.txt", b"a\0b")]).is_err());
        assert!(validate(&[file("a.txt", &vec![b'x'; MAX_FILE + 1])]).is_err());
        assert!(validate(&vec![file("a.txt", b"a"); MAX_FILES + 1]).is_err());
        assert!(validate(&[file("a.txt", &vec![b'x'; MAX_FILE])]).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn staged_bytes_are_consumed_through_real_child_stdin_and_retained() {
        use std::{
            fs::File,
            process::{Command, Stdio},
            sync::atomic::AtomicBool,
            time::Duration,
        };
        let data =
            std::env::temp_dir().join(format!("opencoven-attachments-{}", uuid::Uuid::new_v4()));
        let files = [
            file("notes.txt", b"actual bytes\n\"quoted\"\n"),
            file("empty.md", b""),
        ];
        let (directory, stdin, echo) = stage(&data, "run-1", "", &files).unwrap();
        assert_eq!(
            fs::read(directory.join("0-notes.txt")).unwrap(),
            files[0].bytes
        );
        let frame: Value = serde_json::from_slice(&fs::read(&stdin).unwrap()).unwrap();
        assert_eq!(frame["message"]["role"], "user");
        assert!(frame["message"]["content"][1]["text"]
            .as_str()
            .unwrap()
            .ends_with("actual bytes\n\"quoted\"\n"));
        assert!(echo.starts_with("Read the attached text files."));
        let mut command = Command::new("/bin/cat");
        command.stdin(Stdio::from(File::open(&stdin).unwrap()));
        let result = super::super::execute_command(
            command,
            &AtomicBool::new(false),
            Duration::from_secs(5),
            None,
        )
        .unwrap();
        assert_eq!(result, fs::read(&stdin).unwrap());
        let mut cancelled = Command::new("/bin/cat");
        cancelled.stdin(Stdio::from(File::open(&stdin).unwrap()));
        assert!(super::super::execute_command(
            cancelled,
            &AtomicBool::new(true),
            Duration::from_secs(5),
            None,
        )
        .is_err());
        assert!(stage(&data, "run-1", "", &files).is_err());
        assert!(stdin.exists());
        assert_eq!(metadata(&files)[0], json!({"name":"notes.txt","size":22}));
        fs::remove_dir_all(data).unwrap();
    }

    #[test]
    fn storage_quota_prevents_more_staging_without_removing_existing_bytes() {
        let data =
            std::env::temp_dir().join(format!("opencoven-attachments-{}", uuid::Uuid::new_v4()));
        let root = data.join("coven-attachments");
        fs::create_dir_all(&root).unwrap();
        let retained = root.join("retained");
        std::fs::File::create(&retained)
            .unwrap()
            .set_len(STORAGE_LIMIT)
            .unwrap();
        assert!(stage(&data, "run-2", "hello", &[file("a.txt", b"data")])
            .unwrap_err()
            .contains("full"));
        assert_eq!(retained.metadata().unwrap().len(), STORAGE_LIMIT);
        fs::remove_dir_all(data).unwrap();
    }
}
