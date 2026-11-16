//! Real Windows filesystem regressions for #587; no fake opener substitutes for NtCreateFile.
use super::*;
use serde_json::json;
use std::{fs, os::windows::fs::OpenOptionsExt, process::Command};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("chat-projects-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn sources(&self) -> Sources {
        Sources {
            projects: self.0.join("projects.json"),
            permissions: self.0.join("project-permissions.json"),
            legacy_projects: None,
            legacy_permissions: None,
        }
    }
    fn eight_projects(&self) {
        let projects: Vec<_> = (1..=8)
            .map(|n| {
                let root = self.0.join(format!("project-{n}"));
                fs::create_dir_all(&root).unwrap();
                json!({"id":format!("p{n}"),"name":format!("Access project {n}"),"root":root,
                "createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:00:00Z"})
            })
            .collect();
        let grants: Vec<_> = (1..=8).map(|n| json!({"familiarId":"sage","projectId":format!("p{n}"),"access":if n == 1 {"write"} else {"read"}})).collect();
        fs::write(
            self.sources().projects,
            json!({"version":1,"projects":projects}).to_string(),
        )
        .unwrap();
        fs::write(
            self.sources().permissions,
            json!({"version":1,"projectGrants":grants}).to_string(),
        )
        .unwrap();
    }
    fn load(&self) -> Result<Value, String> {
        ProjectAccess::from_sources(&self.sources(), &self.0)?.for_familiar("sage")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn windows_loads_all_eight_granted_projects_without_modifying_stores() {
    let f = Fixture::new();
    f.eight_projects();
    let before = fs::read(f.sources().permissions).unwrap();
    let result = f
        .load()
        .expect("valid Windows metadata must be readable, not Unsupported");
    assert_eq!(result.as_array().unwrap().len(), 8);
    assert_eq!(result[0]["name"], "Access project 1");
    assert_eq!(result[0]["access"], "write");
    assert_eq!(result[7]["access"], "read");
    assert_eq!(fs::read(f.sources().permissions).unwrap(), before);
    let access = ProjectAccess::from_sources(&f.sources(), &f.0).unwrap();
    assert_eq!(access.for_familiar("other").unwrap(), json!([]));
}

#[test]
fn windows_missing_only_fallback_and_malformed_or_oversized_errors() {
    let f = Fixture::new();
    assert_eq!(f.load().unwrap(), json!([]));
    let legacy = f.0.join("legacy.json");
    fs::write(&legacy, r#"{"legacy":true}"#).unwrap();
    let current = f.sources().projects;
    assert_eq!(
        read_store::<Value>(&current, Some(&legacy)).unwrap(),
        Some(json!({"legacy":true}))
    );
    fs::write(&current, "{").unwrap();
    assert!(read_store::<Value>(&current, Some(&legacy))
        .unwrap_err()
        .contains("Invalid Cave metadata"));
    File::create(&current)
        .unwrap()
        .set_len(MAX_METADATA_BYTES + 1)
        .unwrap();
    assert!(read_store::<Value>(&current, Some(&legacy))
        .unwrap_err()
        .contains("8 MiB"));
    fs::remove_file(&current).unwrap();
    fs::create_dir(&current).unwrap();
    assert!(read_store::<Value>(&current, Some(&legacy)).is_err());
}

#[test]
fn windows_sharing_denial_is_visible_and_does_not_use_legacy() {
    let f = Fixture::new();
    let current = f.sources().projects;
    let legacy = f.0.join("legacy.json");
    fs::write(&current, "{}").unwrap();
    fs::write(&legacy, "{}").unwrap();
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        .open(&current)
        .unwrap();
    let error = read_store::<Value>(&current, Some(&legacy)).unwrap_err();
    assert!(error.starts_with("Cannot open Cave metadata"), "{error}");
    drop(held);
    assert_eq!(
        read_store::<Value>(&current, Some(&legacy)).unwrap(),
        Some(json!({}))
    );
}

#[test]
fn windows_acl_denial_remains_an_error_until_permissions_are_restored() {
    let f = Fixture::new();
    let current = f.sources().projects;
    fs::write(&current, "{}").unwrap();
    // icacls works for the runner's own file without weakening machine security.
    let user = std::env::var("USERNAME").unwrap();
    let denied = Command::new("icacls")
        .arg(&current)
        .args(["/deny", &format!("{user}:(R)")])
        .output()
        .unwrap();
    assert!(denied.status.success(), "{denied:?}");
    let error = open_metadata(&current).err();
    let restored = Command::new("icacls")
        .arg(&current)
        .args(["/remove:d", &user])
        .output()
        .unwrap();
    assert!(restored.status.success(), "{restored:?}");
    assert_eq!(
        error.expect("denied file must fail").kind(),
        io::ErrorKind::PermissionDenied
    );
    assert!(read_store::<Value>(&current, None).is_ok());
}

fn junction(link: &Path, target: &Path) {
    let result = Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:CHAT_TEST_LINK -Target $env:CHAT_TEST_TARGET | Out-Null"])
        .env("CHAT_TEST_LINK", link).env("CHAT_TEST_TARGET", target).output().unwrap();
    assert!(
        result.status.success(),
        "junction fixture failed: {result:?}"
    );
}

#[test]
fn windows_refuses_intermediate_and_final_reparse_points() {
    let f = Fixture::new();
    let target = f.0.join("target");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("projects.json"), "{}").unwrap();
    let intermediate = f.0.join("alias");
    junction(&intermediate, &target);
    assert!(open_metadata(&intermediate.join("projects.json")).is_err());
    fs::remove_dir(&intermediate).unwrap();
    let final_link = f.sources().projects;
    // This must run on a Windows runner with symlink privilege; fixture failure is not a skip.
    std::os::windows::fs::symlink_file(target.join("projects.json"), &final_link).unwrap();
    assert!(open_metadata(&final_link).is_err());
    fs::remove_file(&final_link).unwrap();
    junction(&final_link, &target);
    assert!(open_metadata(&final_link).is_err());
    fs::remove_dir(final_link).unwrap();
}

#[test]
fn windows_final_open_prevents_replacement_until_read_is_finished() {
    let f = Fixture::new();
    let current = f.sources().projects;
    fs::write(&current, r#"{"original":true}"#).unwrap();
    let mut held = open_metadata(&current).unwrap();
    assert!(fs::rename(&current, f.0.join("moved.json")).is_err());
    assert!(fs::OpenOptions::new().write(true).open(&current).is_err());
    let mut text = String::new();
    held.read_to_string(&mut text).unwrap();
    assert_eq!(text, r#"{"original":true}"#);
    drop(held);
    fs::rename(current, f.0.join("moved.json")).unwrap();
}

#[test]
fn windows_extended_drive_paths_read_and_device_or_stream_names_refuse() {
    let f = Fixture::new();
    let current = f.sources().projects;
    fs::write(&current, "{}").unwrap();
    let extended = current.canonicalize().unwrap();
    assert_eq!(
        read_store::<Value>(&extended, None).unwrap(),
        Some(json!({}))
    );
    for invalid in [
        PathBuf::from(r"C:projects.json"),
        PathBuf::from(r"\\.\NUL"),
        PathBuf::from(format!("{}:hidden", current.display())),
    ] {
        assert!(
            open_metadata(&invalid).is_err(),
            "unsafe path accepted: {}",
            invalid.display()
        );
    }
}

#[test]
fn windows_verbatim_overrides_and_registry_roots_load_through_production_resolution() {
    let f = Fixture::new();
    f.eight_projects();
    let mut registry: Value =
        serde_json::from_slice(&fs::read(f.sources().projects).unwrap()).unwrap();
    for project in registry["projects"].as_array_mut().unwrap() {
        let root = PathBuf::from(project["root"].as_str().unwrap())
            .canonicalize()
            .unwrap();
        project["root"] = json!(root);
    }
    fs::write(f.sources().projects, registry.to_string()).unwrap();
    let projects = f.sources().projects.canonicalize().unwrap();
    let permissions = f.sources().permissions.canonicalize().unwrap();
    let sources = Sources::resolve(&f.0, |key| match key {
        "CAVE_PROJECTS_PATH_OVERRIDE" => Some(projects.to_str().unwrap().to_owned()),
        "CAVE_PROJECT_PERMISSIONS_PATH_OVERRIDE" => Some(permissions.to_str().unwrap().to_owned()),
        _ => None,
    })
    .unwrap();
    assert_eq!(
        sources.projects, projects,
        "production source resolution must preserve verbatim drive prefixes"
    );
    let result = ProjectAccess::from_sources(&sources, &f.0)
        .unwrap()
        .for_familiar("sage")
        .unwrap();
    assert_eq!(
        result.as_array().unwrap().len(),
        8,
        "verbatim registry roots must not be silently dropped"
    );
}

#[test]
fn windows_normalization_preserves_extended_unc_prefixes_and_tilde_paths() {
    let home = Path::new(r"C:\Users\test");
    let projects = r"\\?\UNC\server\share\cave\projects.json";
    let sources = Sources::resolve(home, |key| {
        (key == "CAVE_PROJECTS_PATH_OVERRIDE").then(|| projects.to_owned())
    })
    .unwrap();
    assert_eq!(sources.projects, Path::new(projects));
    assert_eq!(
        normalize_path(r"~\cave\projects.json", home),
        Some(home.join(r"cave\projects.json"))
    );
    assert_eq!(
        normalize_path("~/cave/projects.json", home),
        Some(home.join(r"cave\projects.json"))
    );
    assert_eq!(
        normalize_path(r"C:\..\..\projects.json", home),
        Some(PathBuf::from(r"C:\projects.json"))
    );
}
