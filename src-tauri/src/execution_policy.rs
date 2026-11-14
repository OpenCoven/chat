//! Host-owned defaults and per-run authority. Never infer grants from a session cwd.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    fs,
    io::Read,
    path::{Path, PathBuf},
};

const FILE: &str = "chat-execution-policy-v1.json";
const LIMIT: u64 = 65_536;
const FAILED: &str = "Chat could not load or save workspace access. Check the app's storage permissions and available disk space, then retry.";
pub(crate) const UNVERIFIED: &str = "Workspace write access could not be verified. Update Coven and the selected engine to a version supporting Chat workspace access, then retry. Nothing will continue with read-only or unrestricted access.";

pub(crate) const UNSUPPORTED: &str = "This engine cannot verify workspace write access on this computer. Update the engine before continuing this chat, or start a new chat with a supported engine.";
pub(crate) const DIRECT_ANTHROPIC_REQUIRED: &str = "This Coven Code build needs a direct Anthropic API key for workspace write access. Configure Anthropic in Coven before retrying.";

pub(super) fn admission_error(stderr: &str) -> &'static str {
    if stderr.contains("requires direct Anthropic credentials") {
        DIRECT_ANTHROPIC_REQUIRED
    } else if stderr.contains("cannot verify workspace write access on this host") {
        UNSUPPORTED
    } else {
        UNVERIFIED
    }
}

#[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExecutionPolicy {
    version: u32,
    default_access: String,
}

impl ExecutionPolicy {
    /// Absence is the migration from old installations. Existing chat metadata
    /// never carries authority and is deliberately not rewritten.
    pub(crate) fn load_or_migrate(data: &Path) -> Result<Self, String> {
        let _storage = crate::chat_lifecycle::STORAGE_LOCK
            .lock()
            .map_err(|_| FAILED)?;
        let path = data.join(FILE);
        match fs::symlink_metadata(&path) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                let policy = Self {
                    version: 1,
                    default_access: "workspace-write".into(),
                };
                crate::chat_lifecycle::persist(
                    data,
                    FILE,
                    &serde_json::to_vec(&policy).map_err(|_| FAILED)?,
                )
                .map_err(|_| FAILED)?;
                Ok(policy)
            }
            Ok(metadata) if metadata.is_file() && metadata.len() <= LIMIT => {
                let mut bytes = Vec::new();
                fs::File::open(path)
                    .map_err(|_| FAILED)?
                    .take(LIMIT + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|_| FAILED)?;
                let policy: Self = serde_json::from_slice(&bytes).map_err(|_| FAILED)?;
                if policy.version != 1
                    || policy.default_access != "workspace-write"
                    || bytes.len() as u64 > LIMIT
                {
                    return Err(FAILED.into());
                }
                Ok(policy)
            }
            _ => Err(FAILED.into()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RunPolicy {
    pub version: u32,
    pub run_id: String,
    pub access: String,
    pub primary_root: String,
    pub writable_roots: Vec<String>,
    pub read_only_roots: Vec<String>,
}

fn root(path: &Path, home: &Path) -> Result<String, String> {
    if !path.is_absolute() {
        return Err("Workspace access requires absolute folder paths.".into());
    }
    let path = path.canonicalize().map_err(|_| {
        "An authorized folder is unavailable. Restore it or update its project grant, then retry."
    })?;
    if !path.is_dir() || path.parent().is_none() || path == home {
        return Err(
            "Workspace access requires a dedicated folder, not your home or the filesystem root."
                .into(),
        );
    }
    let path = path
        .to_str()
        .ok_or_else(|| "An authorized folder path is not UTF-8.".to_owned())?;
    validate_phone_path(path)?;
    Ok(path.to_owned())
}

fn validate_phone_path(path: &str) -> Result<(), String> {
    if path.len() > 4096 || path.chars().any(char::is_control) {
        return Err(
            "An authorized folder path cannot be shown safely on the paired iPhone.".into(),
        );
    }
    Ok(())
}

impl RunPolicy {
    pub(crate) fn resolve(
        run_id: &str,
        workspace: &Path,
        cwd: &Path,
        projects: &Value,
        home: &Path,
    ) -> Result<Self, String> {
        crate::coven_runtime::validate_id(run_id)?;
        let home = home
            .canonicalize()
            .map_err(|_| "Cannot resolve the local user home. Check the home folder and retry.")?;
        let workspace = root(workspace, &home)?;
        let primary_root = root(cwd, &home)?;
        let mut writes = BTreeSet::from([workspace]);
        let mut reads = BTreeSet::new();
        for project in projects
            .as_array()
            .ok_or("Project access could not be read. Refresh Coven and retry.")?
        {
            let path = project["path"]
                .as_str()
                .ok_or("Project access is missing a folder path.")?;
            let path = root(Path::new(path), &home)?;
            match project["access"].as_str() {
                Some("write") => {
                    writes.insert(path);
                }
                Some("read") => {
                    reads.insert(path);
                }
                _ => {
                    return Err(
                        "Project access contains an unknown grant. Refresh Coven and retry.".into(),
                    )
                }
            }
        }
        // A continued session's project_root is observed context, never a grant.
        if !writes
            .iter()
            .any(|write| Path::new(&primary_root).starts_with(write))
        {
            return Err("This chat's working folder is outside its saved write access. Restore its project write grant or start a new chat in the familiar workspace.".into());
        }
        // Native backends disagree about overlapping read/write grants. Refuse
        // ambiguous layouts rather than accidentally turning a read grant into write.
        if reads.iter().any(|read| {
            writes.iter().any(|write| {
                Path::new(read).starts_with(write) || Path::new(write).starts_with(read)
            })
        }) {
            return Err("A read-only and writable project overlap. Separate the folders or correct the project grants before sending.".into());
        }
        Ok(Self {
            version: 1,
            run_id: run_id.into(),
            access: "workspace-write".into(),
            primary_root,
            writable_roots: writes.into_iter().collect(),
            read_only_roots: reads.into_iter().collect(),
        })
    }

    pub(crate) fn extend_approved(
        &mut self,
        extra: &[crate::chat_approvals::ApprovedRoot],
        home: &Path,
    ) -> Result<(), String> {
        let home = home
            .canonicalize()
            .map_err(|_| "Cannot resolve the local user home. Check the home folder and retry.")?;
        for requested in extra {
            requested.verify()?;
            let approved = root(Path::new(requested.path()), &home)?;
            let path = Path::new(&approved);
            if approved != requested.path()
                || home.starts_with(path)
                || self
                    .read_only_roots
                    .iter()
                    .any(|read| path.starts_with(read) || Path::new(read).starts_with(path))
            {
                return Err("That folder conflicts with saved read-only access or a protected folder. Correct the saved grants and ask again.".into());
            }
            requested.verify()?;
            self.writable_roots.push(approved);
        }
        self.writable_roots.sort();
        self.writable_roots.dedup();
        Ok(())
    }

    pub(crate) fn verify_approved_roots(
        &self,
        roots: &[crate::chat_approvals::ApprovedRoot],
    ) -> Result<(), String> {
        for root in roots {
            root.verify()?;
        }
        Ok(())
    }

    /// The familiar must never be able to rewrite Chat's authority records,
    /// including by creating a hard link through a writable root on the same filesystem.
    pub(crate) fn protect_host_storage(&self, data: &Path) -> Result<(), String> {
        let data = data.canonicalize().map_err(|_| FAILED)?;
        if self
            .writable_roots
            .iter()
            .any(|write| data.starts_with(write) || Path::new(write).starts_with(&data))
        {
            return Err("A writable folder overlaps Chat's private storage. Choose a separate familiar workspace or narrow the project grant before sending.".into());
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let storage_device = fs::metadata(&data).map_err(|_| FAILED)?.dev();
            for write in &self.writable_roots {
                let metadata = fs::metadata(write).map_err(|_| {
                    "An authorized folder is unavailable. Restore it or update its project grant, then retry."
                })?;
                if metadata.dev() == storage_device {
                    return Err("A writable folder shares a filesystem with Chat's private storage. Choose a separate volume for the workspace and project grants before sending.".into());
                }
            }
        }
        Ok(())
    }

    pub(super) fn protect_authority_file(&self, path: &Path) -> Result<(), String> {
        // Guard the directory entry as well as the symlink target, if any.
        let mut locations = Vec::new();
        match path.canonicalize() {
            Ok(target) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::MetadataExt;
                    let metadata = fs::metadata(&target).map_err(|_| FAILED)?;
                    if metadata.nlink() != 1 {
                        return Err("A Coven project registry or grant file has multiple filesystem names. Remove its hard links before sending.".into());
                    }
                }
                locations.push(target);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(FAILED.into()),
        }
        let mut ancestor = path.parent();
        while let Some(directory) = ancestor {
            match directory.canonicalize() {
                Ok(canonical) => {
                    locations
                        .push(canonical.join(path.strip_prefix(directory).map_err(|_| FAILED)?));
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    ancestor = directory.parent();
                }
                Err(_) => return Err(FAILED.into()),
            }
        }
        if locations.is_empty()
            || locations.iter().any(|location| {
                self.writable_roots
                    .iter()
                    .any(|write| location.starts_with(write))
            })
        {
            return Err("A writable folder overlaps Coven's project registry or grants. Narrow the folder grant before sending.".into());
        }
        Ok(())
    }

    /// A receipt is accepted only for this exact run and exact authority. The
    /// producer must report native enforcement, not merely echo requested flags.
    pub(crate) fn verify(&self, event: &Value) -> Result<(), String> {
        let receipt = event.get("effectiveAccess").ok_or(UNVERIFIED)?;
        if receipt.get("enforced").and_then(Value::as_bool) != Some(true) {
            return Err(UNVERIFIED.into());
        }
        let mut receipt = receipt.clone();
        receipt
            .as_object_mut()
            .ok_or(UNVERIFIED)?
            .remove("enforced");
        let actual: Self = serde_json::from_value(receipt).map_err(|_| UNVERIFIED)?;
        if actual != *self {
            return Err(UNVERIFIED.into());
        }
        Ok(())
    }

    pub(crate) fn stage(&self, data: &Path) -> Result<PolicyFile, String> {
        let directory = data.join("chat-run-policies");
        fs::create_dir_all(&directory).map_err(|_| FAILED)?;
        if fs::symlink_metadata(&directory)
            .map_err(|_| FAILED)?
            .file_type()
            .is_symlink()
        {
            return Err(FAILED.into());
        }
        let path = directory.join(format!("{}.json", self.run_id));
        let bytes = serde_json::to_vec(self).map_err(|_| FAILED)?;
        use std::io::Write;
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&path).map_err(|_| FAILED)?;
        let staged = PolicyFile(path);
        file.write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| FAILED)?;
        Ok(staged)
    }
}
pub(crate) struct PolicyFile(pub PathBuf);
impl Drop for PolicyFile {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
        fn folder(&self, name: &str) -> PathBuf {
            let path = self.0.join(name);
            fs::create_dir_all(&path).unwrap();
            path.canonicalize().unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn existing_install_migrates_without_changing_chat_and_survives_restart() {
        let f = Fixture::new();
        let chat = f.0.join("chat-canonical-v1.json");
        fs::write(&chat, b"old chat").unwrap();
        let initial = ExecutionPolicy::load_or_migrate(&f.0).unwrap();
        let bytes = fs::read(f.0.join(FILE)).unwrap();
        assert_eq!(initial, ExecutionPolicy::load_or_migrate(&f.0).unwrap());
        assert_eq!(bytes, fs::read(f.0.join(FILE)).unwrap());
        assert_eq!(fs::read(chat).unwrap(), b"old chat");
    }
    #[test]
    fn corrupt_or_future_policy_is_not_overwritten() {
        let f = Fixture::new();
        for bytes in [
            "{",
            r#"{"version":2,"defaultAccess":"workspace-write"}"#,
            r#"{"version":1,"defaultAccess":"full"}"#,
        ] {
            fs::write(f.0.join(FILE), bytes).unwrap();
            assert!(ExecutionPolicy::load_or_migrate(&f.0).is_err());
            assert_eq!(fs::read_to_string(f.0.join(FILE)).unwrap(), bytes);
        }
    }
    #[test]
    fn continued_working_directory_cannot_grant_access_and_read_grants_do_not_write() {
        let f = Fixture::new();
        let workspace = f.folder("familiar");
        let project = f.folder("project");
        let outside = f.folder("outside");
        let grants = json!([{"path":project,"access":"read"}]);
        assert!(RunPolicy::resolve("r", &workspace, &project, &grants, &f.0).is_err());
        let grants = json!([{"path":project,"access":"write"}]);
        let policy = RunPolicy::resolve("r", &workspace, &project, &grants, &f.0).unwrap();
        assert_eq!(policy.writable_roots.len(), 2);
        assert!(RunPolicy::resolve("r", &workspace, &outside, &grants, &f.0).is_err());
    }
    #[test]
    fn canonical_home_and_phone_path_limits_are_enforced() {
        let f = Fixture::new();
        let home = f.folder("home");
        let workspace = f.folder("familiar");
        #[cfg(unix)]
        {
            let alias = f.0.join("home-alias");
            std::os::unix::fs::symlink(&home, &alias).unwrap();
            assert!(RunPolicy::resolve("r", &home, &workspace, &json!([]), &alias).is_err());
            let approval =
                crate::chat_approvals::ApprovedRoot::capture(f.0.to_str().unwrap()).unwrap();
            let mut policy =
                RunPolicy::resolve("r", &workspace, &workspace, &json!([]), &home).unwrap();
            assert!(policy
                .extend_approved(&[approval], &alias)
                .unwrap_err()
                .contains("protected folder"));
        }
        assert!(validate_phone_path(&"x".repeat(4097)).is_err());
        assert!(validate_phone_path("/project\nfolder").is_err());
        assert!(validate_phone_path("/project-folder").is_ok());
    }

    #[test]
    fn read_only_and_writable_projects_may_not_overlap_in_either_direction() {
        let f = Fixture::new();
        let workspace = f.folder("familiar");
        let read_only = f.folder("read-only");
        let writable = read_only.join("nested-write");
        fs::create_dir(&writable).unwrap();
        let grants = json!([
            {"path":read_only, "access":"read"},
            {"path":writable, "access":"write"},
        ]);
        assert!(
            RunPolicy::resolve("r", &workspace, &workspace, &grants, &f.0)
                .unwrap_err()
                .contains("overlap")
        );
    }
    #[test]
    fn receipts_reject_downgrade_full_access_other_run_and_extra_roots() {
        let f = Fixture::new();
        let workspace = f.folder("familiar");
        let policy = RunPolicy::resolve("r", &workspace, &workspace, &json!([]), &f.0).unwrap();
        let mut receipt = serde_json::to_value(&policy).unwrap();
        receipt["enforced"] = json!(true);
        assert!(policy.verify(&json!({"effectiveAccess":receipt})).is_ok());
        for (field, value) in [
            ("access", json!("read-only")),
            ("access", json!("full")),
            ("runId", json!("stale")),
            ("enforced", json!(false)),
            ("writableRoots", json!([workspace, f.0])),
        ] {
            let mut altered = receipt.clone();
            altered[field] = value;
            assert!(policy.verify(&json!({"effectiveAccess":altered})).is_err());
        }
        assert!(policy
            .verify(&json!({"permission":"workspace-write"}))
            .is_err());
    }
    #[test]
    fn policy_file_is_single_run_and_removed_on_cancellation_or_return() {
        let f = Fixture::new();
        let workspace = f.folder("familiar");
        let policy = RunPolicy::resolve("r", &workspace, &workspace, &json!([]), &f.0).unwrap();
        let staged = policy.stage(&f.0).unwrap();
        let path = staged.0.clone();
        assert!(policy.stage(&f.0).is_err());
        drop(staged);
        assert!(!path.exists());
    }
    #[cfg(unix)]
    #[test]
    fn symlink_policy_is_rejected_and_workspace_symlinks_are_canonicalized() {
        let f = Fixture::new();
        let target = f.0.join("target");
        fs::write(&target, b"{}").unwrap();
        std::os::unix::fs::symlink(&target, f.0.join(FILE)).unwrap();
        assert!(ExecutionPolicy::load_or_migrate(&f.0).is_err());
        let workspace = f.folder("familiar");
        let alias = f.0.join("alias");
        std::os::unix::fs::symlink(&workspace, &alias).unwrap();
        let policy = RunPolicy::resolve("r", &alias, &workspace, &json!([]), &f.0).unwrap();
        assert_eq!(policy.primary_root, workspace.to_str().unwrap());
    }
    #[test]
    fn project_grants_cannot_rewrite_host_authority_records() {
        let f = Fixture::new();
        let broad = f.folder("broad");
        let data = f.folder("broad/chat-private");
        let workspace = f.folder("familiar");
        let policy = RunPolicy::resolve("r", &workspace, &workspace, &json!([]), &f.0).unwrap();
        assert!(policy
            .protect_host_storage(&data)
            .unwrap_err()
            .contains("shares a filesystem"));
        let policy = RunPolicy::resolve(
            "r",
            &workspace,
            &workspace,
            &json!([{"path":broad,"access":"write"}]),
            &f.0,
        )
        .unwrap();
        assert!(policy
            .protect_host_storage(&data)
            .unwrap_err()
            .contains("overlaps"));
    }

    #[cfg(unix)]
    #[test]
    fn approved_folder_identity_is_rechecked_before_launch() {
        let f = Fixture::new();
        let workspace = f.folder("familiar");
        let approved = f.folder("approved");
        let approval =
            crate::chat_approvals::ApprovedRoot::capture(approved.to_str().unwrap()).unwrap();
        let mut policy = RunPolicy::resolve("r", &workspace, &workspace, &json!([]), &f.0).unwrap();
        policy
            .extend_approved(std::slice::from_ref(&approval), &f.0)
            .unwrap();
        fs::rename(&approved, f.0.join("approved-original")).unwrap();
        fs::create_dir(&approved).unwrap();
        assert!(policy
            .verify_approved_roots(&[approval])
            .unwrap_err()
            .contains("changed after review"));
    }

    #[cfg(unix)]
    #[test]
    fn a_writable_alias_cannot_modify_coven_project_authority() {
        let f = Fixture::new();
        let workspace = f.folder("familiar");
        let registry = f.folder("cave").join("project-permissions.json");
        fs::write(&registry, b"fixture grant store").unwrap();
        let policy = RunPolicy::resolve("r", &workspace, &workspace, &json!([]), &f.0).unwrap();
        assert!(policy.protect_authority_file(&registry).is_ok());

        fs::hard_link(&registry, workspace.join("alias")).unwrap();
        let error = policy.protect_authority_file(&registry).unwrap_err();
        assert!(error.contains("multiple filesystem names"));
        assert_eq!(fs::read(&registry).unwrap(), b"fixture grant store");
    }
    #[test]
    fn admission_errors_give_a_specific_next_step_without_exposing_stderr() {
        assert_eq!(
            admission_error("requires direct Anthropic credentials"),
            DIRECT_ANTHROPIC_REQUIRED
        );
        assert_eq!(
            admission_error("cannot verify workspace write access on this host"),
            UNSUPPORTED
        );
        assert_eq!(admission_error("opaque engine failure"), UNVERIFIED);
    }
}
