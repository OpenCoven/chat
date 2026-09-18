use serde::{de::DeserializeOwned, Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::File,
    io::{self, Read},
    path::{Component, Path, PathBuf},
};

const MAX_METADATA_BYTES: u64 = 8 * 1024 * 1024;
const MAX_PROJECTS: usize = 1024;

#[derive(Clone, Copy, Default, Deserialize, Serialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
enum Access {
    Read,
    #[default]
    Write,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Project {
    id: String,
    name: String,
    root: String,
    created_at: String,
    updated_at: String,
}

#[derive(Deserialize)]
struct Registry {
    version: u32,
    projects: Vec<Project>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Grant {
    project_id: String,
    #[serde(default)]
    access: Access,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DirectGrant {
    familiar_id: String,
    #[serde(flatten)]
    grant: Grant,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Group {
    id: String,
    name: String,
    member_familiar_ids: Vec<String>,
    project_grants: Vec<Grant>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Permissions {
    version: u32,
    project_grants: Vec<DirectGrant>,
    #[serde(default)]
    access_groups: Vec<Group>,
}

#[derive(Serialize)]
struct Entry<'a> {
    name: &'a str,
    path: &'a str,
    access: Access,
}

struct Sources {
    projects: PathBuf,
    permissions: PathBuf,
    legacy_projects: Option<PathBuf>,
    legacy_permissions: Option<PathBuf>,
}

impl Sources {
    fn resolve(home: &Path, env: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let configured = |key: &str| -> Result<Option<PathBuf>, String> {
            env(key)
                .map(|value| {
                    normalize_path(&value, home)
                        .ok_or_else(|| format!("{key} must be a nonempty absolute local path."))
                })
                .transpose()
        };
        let coven = configured("COVEN_HOME")?.unwrap_or_else(|| home.join(".coven"));
        let cave = configured("COVEN_CAVE_HOME")?.unwrap_or_else(|| coven.join("cave"));
        let projects = configured("CAVE_PROJECTS_PATH_OVERRIDE")?;
        let permissions = configured("CAVE_PROJECT_PERMISSIONS_PATH_OVERRIDE")?;
        Ok(Self {
            legacy_projects: projects.is_none().then(|| coven.join("cave-projects.json")),
            legacy_permissions: permissions
                .is_none()
                .then(|| coven.join("cave-project-permissions.json")),
            projects: projects.unwrap_or_else(|| cave.join("projects.json")),
            permissions: permissions.unwrap_or_else(|| cave.join("project-permissions.json")),
        })
    }
}

pub(super) struct ProjectAccess {
    projects: BTreeMap<String, Project>,
    permissions: Permissions,
}

impl ProjectAccess {
    pub(super) fn load() -> Result<Self, String> {
        // coven::resolve_coven_home is private. Use the runtime's existing home
        // resolver without extending the native command or filesystem API.
        let home = super::home()?;
        let sources = Self::environment_sources(&home)?;
        Self::from_sources(&sources, &home)
    }

    fn environment_sources(home: &Path) -> Result<Sources, String> {
        let mut environment = HashMap::new();
        for key in [
            "COVEN_HOME",
            "COVEN_CAVE_HOME",
            "CAVE_PROJECTS_PATH_OVERRIDE",
            "CAVE_PROJECT_PERMISSIONS_PATH_OVERRIDE",
        ] {
            if let Some(value) = std::env::var_os(key) {
                let value = value
                    .into_string()
                    .map_err(|_| format!("{key} is not valid UTF-8."))?;
                environment.insert(key, value);
            }
        }
        Sources::resolve(home, |key| environment.get(key).cloned())
    }

    fn from_sources(sources: &Sources, home: &Path) -> Result<Self, String> {
        let registry: Option<Registry> =
            read_store(&sources.projects, sources.legacy_projects.as_deref())?;
        let permissions: Option<Permissions> =
            read_store(&sources.permissions, sources.legacy_permissions.as_deref())?;
        if registry.as_ref().is_some_and(|r| r.version != 1)
            || permissions
                .as_ref()
                .is_some_and(|p| !matches!(p.version, 1 | 2))
        {
            return Err("Unsupported Cave project metadata version.".into());
        }
        let permissions = permissions.unwrap_or_default();
        for grant in &permissions.project_grants {
            require_id(&grant.familiar_id)?;
            require_id(&grant.grant.project_id)?;
        }
        for group in &permissions.access_groups {
            require_id(&group.id)?;
            if group.name.trim().is_empty() {
                return Err("Cave access group has an empty name.".into());
            }
            for id in &group.member_familiar_ids {
                require_id(id)?;
            }
            for grant in &group.project_grants {
                require_id(&grant.project_id)?;
            }
        }
        let mut projects: BTreeMap<String, Project> = BTreeMap::new();
        let mut ids = HashMap::new();
        for project in registry.into_iter().flat_map(|r| r.projects) {
            require_id(&project.id)?;
            if project.name.trim().is_empty() || project.name.len() > 4096 {
                return Err("Cave project names must contain 1-4096 bytes.".into());
            }
            if project.root.len() > 4096 {
                return Err("Cave project paths must not exceed 4096 bytes.".into());
            }
            let Some(root) = normalize_path(&project.root, home) else {
                continue;
            };
            let root = root
                .to_str()
                .ok_or("Cave project path is not valid UTF-8.")?
                .to_owned();
            if let Some(previous) = ids.insert(project.id.clone(), root.clone()) {
                if previous != root {
                    return Err("Cave registry reuses a project ID for different roots.".into());
                }
            }
            let replace = projects
                .get(&root)
                .is_none_or(|old| timestamp(&project) > timestamp(old));
            if replace {
                projects.insert(root, project);
            }
        }
        // Dedupe before matching grants: never transfer a stale ID's grant to
        // the newer registry record at the same root.
        let mut existing = BTreeMap::new();
        for (root, project) in projects {
            match std::fs::metadata(&root) {
                Ok(metadata) if metadata.is_dir() => {
                    existing.insert(root, project);
                }
                Ok(_) => {}
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
                    ) => {}
                Err(error) => {
                    return Err(format!("Cannot inspect Cave project directory: {error}"))
                }
            }
        }
        Ok(Self {
            projects: existing,
            permissions,
        })
    }

    pub(super) fn for_familiar(&self, id: &str) -> Result<Value, String> {
        let mut grants: HashMap<&str, Access> = HashMap::new();
        for direct in self
            .permissions
            .project_grants
            .iter()
            .filter(|grant| grant.familiar_id == id)
        {
            grants
                .entry(&direct.grant.project_id)
                .or_insert(direct.grant.access);
        }
        for group in self
            .permissions
            .access_groups
            .iter()
            .filter(|group| group.member_familiar_ids.iter().any(|member| member == id))
        {
            // Cave uses the first grant within each scope, then union-max across scopes.
            let mut seen = HashSet::new();
            for grant in &group.project_grants {
                if seen.insert(&grant.project_id) {
                    grants
                        .entry(&grant.project_id)
                        .and_modify(|access| *access = (*access).max(grant.access))
                        .or_insert(grant.access);
                }
            }
        }
        let mut entries = Vec::new();
        for (path, project) in &self.projects {
            if let Some(&access) = grants.get(project.id.as_str()) {
                if entries.len() == MAX_PROJECTS {
                    return Err("Familiar project access exceeds the 1024-project limit.".into());
                }
                entries.push(Entry {
                    name: &project.name,
                    path,
                    access,
                });
            }
        }
        serde_json::to_value(entries)
            .map_err(|error| format!("Cannot serialize familiar project access: {error}"))
    }
}

fn require_id(id: &str) -> Result<(), String> {
    if id.trim().is_empty() {
        return Err("Cave project metadata contains an empty identifier.".into());
    }
    Ok(())
}

fn normalize_path(value: &str, home: &Path) -> Option<PathBuf> {
    let value = value.trim().replace('\\', "/");
    let path = if value == "~" {
        home.to_path_buf()
    } else if let Some(suffix) = value.strip_prefix("~/") {
        home.join(suffix)
    } else {
        PathBuf::from(value)
    };
    if !path.is_absolute() || path.to_str()?.contains('\0') {
        return None;
    }
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                normalized.pop();
            }
            Component::CurDir => {}
            component => normalized.push(component),
        }
    }
    Some(normalized)
}

fn timestamp(project: &Project) -> Option<i64> {
    parse_timestamp(&project.updated_at).or_else(|| parse_timestamp(&project.created_at))
}

// Cave writes ISO timestamps. Normalize offsets before comparing duplicate rows.
fn parse_timestamp(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return None;
    }
    let number = |start, end| {
        let digits = value.get(start..end)?;
        digits.bytes().all(|b| b.is_ascii_digit()).then_some(())?;
        digits.parse::<i64>().ok()
    };
    let (mut year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    if !(1..=12).contains(&month)
        || !(1..=days[(month - 1) as usize]).contains(&day)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }
    let mut index = 19;
    let mut millis = 0;
    if bytes.get(index) == Some(&b'.') {
        index += 1;
        let start = index;
        while bytes.get(index).is_some_and(u8::is_ascii_digit) {
            if index - start < 3 {
                millis += i64::from(bytes[index] - b'0') * 10_i64.pow(2 - (index - start) as u32);
            }
            index += 1;
        }
        if index == start {
            return None;
        }
    }
    let offset = match value.get(index..)? {
        "Z" => 0,
        zone if zone.len() == 6
            && matches!(zone.as_bytes()[0], b'+' | b'-')
            && zone.as_bytes()[3] == b':' =>
        {
            let hours = number(index + 1, index + 3)?;
            let minutes = number(index + 4, index + 6)?;
            if hours > 23 || minutes > 59 {
                return None;
            }
            (hours * 60 + minutes) * if zone.starts_with('-') { -1 } else { 1 }
        }
        _ => return None,
    };
    year -= i64::from(month <= 2);
    let era = year.div_euclid(400);
    let y = year - era * 400;
    let m = month + if month > 2 { -3 } else { 9 };
    let days = era * 146097 + y * 365 + y / 4 - y / 100 + (153 * m + 2) / 5 + day - 1;
    Some(((days * 24 + hour) * 3600 + minute * 60 + second - offset * 60) * 1000 + millis)
}

fn read_store<T: DeserializeOwned>(
    path: &Path,
    legacy: Option<&Path>,
) -> Result<Option<T>, String> {
    let file = match open_metadata(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return match legacy {
                Some(legacy) => read_store(legacy, None),
                None => Ok(None),
            };
        }
        Err(error) => {
            return Err(format!(
                "Cannot open Cave metadata {}: {error}",
                path.display()
            ))
        }
    };
    let metadata = file
        .metadata()
        .map_err(|error| format!("Cannot inspect Cave metadata: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_METADATA_BYTES {
        return Err("Cave metadata must be a regular file no larger than 8 MiB.".into());
    }
    let mut bytes = Vec::new();
    file.take(MAX_METADATA_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| format!("Cannot read Cave metadata: {error}"))?;
    if bytes.len() as u64 > MAX_METADATA_BYTES {
        return Err("Cave metadata exceeds 8 MiB.".into());
    }
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|error| format!("Invalid Cave metadata {}: {error}", path.display()))
}

#[cfg(unix)]
fn open_metadata(path: &Path) -> io::Result<File> {
    use std::{
        ffi::CString,
        os::{
            fd::{AsRawFd, FromRawFd},
            unix::ffi::OsStrExt,
        },
    };
    if !path.is_absolute() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "Metadata path must be absolute.",
        ));
    }
    let mut directory = File::open("/")?;
    let components: Vec<_> = path.components().skip(1).collect();
    for (index, component) in components.iter().enumerate() {
        let Component::Normal(name) = component else {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "Invalid metadata path component.",
            ));
        };
        let name = CString::new(name.as_bytes()).map_err(|_| {
            io::Error::new(io::ErrorKind::InvalidInput, "Invalid metadata filename.")
        })?;
        let flags = libc::O_RDONLY
            | libc::O_CLOEXEC
            | libc::O_NOFOLLOW
            | libc::O_NONBLOCK
            | if index + 1 < components.len() {
                libc::O_DIRECTORY
            } else {
                0
            };
        // Every component is anchored to its already-open parent.
        let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        directory = unsafe { File::from_raw_fd(fd) };
    }
    Ok(directory)
}

#[cfg(not(unix))]
fn open_metadata(_path: &Path) -> io::Result<File> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Safe Cave metadata loading is unavailable on this platform.",
    ))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{collections::HashSet, fs, os::unix::fs::PermissionsExt};

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .canonicalize()
                .unwrap()
                .join(format!("chat-projects-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn sources(&self) -> Sources {
            Sources {
                projects: self.0.join("projects.json"),
                permissions: self.0.join("project-permissions.json"),
                legacy_projects: None,
                legacy_permissions: None,
            }
        }
        fn project(&self, id: &str) -> Value {
            let root = self.0.join(id);
            fs::create_dir_all(&root).unwrap();
            json!({"id":id,"name":format!("Project {id}"),"root":root,
                "createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"})
        }
        fn write(&self, projects: Value, permissions: Value) {
            fs::write(
                self.sources().projects,
                json!({"version":1,"projects":projects}).to_string(),
            )
            .unwrap();
            fs::write(self.sources().permissions, permissions.to_string()).unwrap();
        }
        fn load(&self) -> Result<ProjectAccess, String> {
            ProjectAccess::from_sources(&self.sources(), &self.0)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            fs::set_permissions(&self.0, fs::Permissions::from_mode(0o700)).unwrap();
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn direct_groups_union_max_v1_and_no_implicit_grants() {
        let f = Fixture::new();
        f.write(json!([f.project("a"), f.project("b"), f.project("c"), f.project("workspace")]),
            json!({"version":2,"projectGrants":[
                {"familiarId":"sage","projectId":"a","access":"read"},
                {"familiarId":"other","projectId":"workspace","access":"write"}],
                "accessGroups":[
                    {"id":"one","name":"One","memberFamiliarIds":["sage"],"projectGrants":[{"projectId":"a"},{"projectId":"b","access":"read"}]},
                    {"id":"two","name":"Two","memberFamiliarIds":["sage"],"projectGrants":[{"projectId":"a","access":"read"}]},
                    {"id":"inactive","name":"Inactive","memberFamiliarIds":["other"],"projectGrants":[{"projectId":"c"}]}],
                "grantProposals":[{"familiarId":"sage","projectId":"workspace","status":"accepting"}]}));
        let loaded = f.load().unwrap();
        let result = loaded.for_familiar("sage").unwrap();
        assert_eq!(
            result,
            json!([
                {"name":"Project a","path":f.0.join("a"),"access":"write"},
                {"name":"Project b","path":f.0.join("b"),"access":"read"}
            ])
        );
        assert_eq!(loaded.for_familiar("ungranted").unwrap(), json!([]));
        f.write(
            json!([f.project("a")]),
            json!({"version":1,"projectGrants":[{"familiarId":"sage","projectId":"a"}]}),
        );
        assert_eq!(
            f.load().unwrap().for_familiar("sage").unwrap()[0]["access"],
            "write"
        );
    }

    #[test]
    fn duplicate_grants_use_first_match_within_each_scope() {
        let f = Fixture::new();
        f.write(
            json!([f.project("a"), f.project("b")]),
            json!({
                "version":2,
                "projectGrants":[
                    {"familiarId":"sage","projectId":"a","access":"read"},
                    {"familiarId":"sage","projectId":"a","access":"write"}],
                "accessGroups":[{
                    "id":"one","name":"One","memberFamiliarIds":["sage"],"projectGrants":[
                        {"projectId":"b","access":"read"},
                        {"projectId":"b","access":"write"}]
                }]
            }),
        );
        let result = f.load().unwrap().for_familiar("sage").unwrap();
        assert_eq!(result.as_array().unwrap().len(), 2);
        assert_eq!(result[0]["access"], "read");
        assert_eq!(result[1]["access"], "read");
    }

    #[test]
    fn latest_root_record_does_not_inherit_stale_id_grants() {
        let f = Fixture::new();
        let old = f.project("old");
        let mut new = old.clone();
        new["id"] = json!("new");
        new["root"] = json!("~/old/./");
        new["updatedAt"] = json!("2026-01-02T00:00:00.000Z");
        f.write(
            json!([old, new]),
            json!({"version":2,"projectGrants":[{"familiarId":"sage","projectId":"old"}]}),
        );
        assert_eq!(f.load().unwrap().for_familiar("sage").unwrap(), json!([]));
        assert_eq!(
            parse_timestamp("2026-01-01T01:00:00+01:00"),
            parse_timestamp("2026-01-01T00:00:00Z")
        );
        assert!(parse_timestamp("2026-02-30T00:00:00Z").is_none());
    }

    #[test]
    fn missing_optional_files_and_invalid_project_directories() {
        let f = Fixture::new();
        assert_eq!(f.load().unwrap().for_familiar("sage").unwrap(), json!([]));
        let mut missing = f.project("missing");
        fs::remove_dir(f.0.join("missing")).unwrap();
        missing["root"] = json!(f.0.join("missing"));
        let mut relative = missing.clone();
        relative["id"] = json!("relative");
        relative["root"] = json!("relative/path");
        f.write(
            json!([missing, relative]),
            json!({"version":2,"projectGrants":[{"familiarId":"sage","projectId":"missing"}]}),
        );
        assert_eq!(f.load().unwrap().for_familiar("sage").unwrap(), json!([]));
    }

    #[test]
    fn malformed_invalid_access_versions_and_ambiguous_ids_fail() {
        let f = Fixture::new();
        for key in ["name", "root"] {
            let mut project = f.project("a");
            project[key] = json!("x".repeat(4097));
            f.write(json!([project]), json!({"version":2,"projectGrants":[]}));
            assert!(f.load().is_err());
        }
        for access in [json!("admin"), Value::Null, json!(4)] {
            f.write(json!([f.project("a")]), json!({"version":2,"projectGrants":[{"familiarId":"sage","projectId":"a","access":access}]}));
            assert!(f.load().is_err());
        }
        for contents in [
            "{",
            "{}",
            r#"{"version":3,"projectGrants":[]}"#,
            r#"{"version":2,"projectGrants":null}"#,
        ] {
            fs::write(f.sources().permissions, contents).unwrap();
            assert!(f.load().is_err());
        }
        let mut duplicate = f.project("b");
        duplicate["id"] = json!("a");
        f.write(
            json!([f.project("a"), duplicate]),
            json!({"version":2,"projectGrants":[]}),
        );
        assert!(f.load().is_err());
    }

    #[test]
    fn read_only_stores_are_unchanged_and_unreadable_store_fails() {
        let f = Fixture::new();
        f.write(
            json!([f.project("a")]),
            json!({"version":2,"projectGrants":[]}),
        );
        let before = fs::read(f.sources().permissions).unwrap();
        for path in [f.sources().projects, f.sources().permissions] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o400)).unwrap();
        }
        fs::set_permissions(&f.0, fs::Permissions::from_mode(0o500)).unwrap();
        f.load().unwrap();
        assert_eq!(fs::read(f.sources().permissions).unwrap(), before);
        fs::set_permissions(f.sources().permissions, fs::Permissions::from_mode(0)).unwrap();
        if unsafe { libc::geteuid() } != 0 {
            assert!(f.load().is_err());
        }
    }

    #[test]
    fn refuses_symlinks_nonregular_and_oversized_files() {
        let f = Fixture::new();
        f.write(json!([]), json!({"version":2,"projectGrants":[]}));
        let original = f.0.join("original.json");
        fs::rename(f.sources().projects, &original).unwrap();
        std::os::unix::fs::symlink(&original, f.sources().projects).unwrap();
        assert!(f.load().is_err());
        fs::remove_file(f.sources().projects).unwrap();
        fs::create_dir(f.sources().projects).unwrap();
        assert!(f.load().is_err());
        fs::remove_dir(f.sources().projects).unwrap();
        File::create(f.sources().projects)
            .unwrap()
            .set_len(MAX_METADATA_BYTES + 1)
            .unwrap();
        assert!(f.load().is_err());
        let alias = f.0.join("alias");
        std::os::unix::fs::symlink(&f.0, &alias).unwrap();
        assert!(read_store::<Registry>(&alias.join("original.json"), None).is_err());
    }

    #[test]
    fn output_limit_is_per_familiar_and_never_silently_truncates() {
        let f = Fixture::new();
        let projects: Vec<_> = (0..=MAX_PROJECTS)
            .map(|i| f.project(&format!("p{i}")))
            .collect();
        let grants: Vec<_> = (0..=MAX_PROJECTS)
            .map(|i| json!({"familiarId":"sage","projectId":format!("p{i}")}))
            .collect();
        f.write(json!(projects), json!({"version":2,"projectGrants":grants}));
        let mut loaded = f.load().unwrap();
        assert!(loaded.for_familiar("sage").is_err());
        assert_eq!(loaded.for_familiar("other").unwrap(), json!([]));
        loaded.permissions.project_grants.pop();
        assert_eq!(
            loaded
                .for_familiar("sage")
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            MAX_PROJECTS
        );
    }

    #[test]
    fn overrides_and_read_only_legacy_fallback() {
        let f = Fixture::new();
        let env = HashMap::from([
            ("COVEN_HOME", f.0.to_str().unwrap()),
            ("COVEN_CAVE_HOME", "/custom/cave"),
            ("CAVE_PROJECTS_PATH_OVERRIDE", "/custom/projects.json"),
            (
                "CAVE_PROJECT_PERMISSIONS_PATH_OVERRIDE",
                "/custom/permissions.json",
            ),
        ]);
        let resolved = Sources::resolve(&f.0, |key| env.get(key).map(|v| v.to_string())).unwrap();
        assert_eq!(resolved.projects, Path::new("/custom/projects.json"));
        assert_eq!(resolved.permissions, Path::new("/custom/permissions.json"));
        assert!(resolved.legacy_projects.is_none());
        let resolved = Sources::resolve(&f.0, |key| {
            (key == "COVEN_HOME").then(|| f.0.to_str().unwrap().to_string())
        })
        .unwrap();
        fs::write(
            resolved.legacy_projects.as_ref().unwrap(),
            json!({"version":1,"projects":[]}).to_string(),
        )
        .unwrap();
        ProjectAccess::from_sources(&resolved, &f.0).unwrap();
        assert!(!resolved.projects.exists());
        fs::create_dir(f.0.join("cave")).unwrap();
        fs::write(&resolved.projects, "{").unwrap();
        assert!(ProjectAccess::from_sources(&resolved, &f.0).is_err());
    }

    #[test]
    #[ignore = "authorized local metadata read; prints counts only"]
    fn installed_project_metadata_counts() {
        let home = super::super::home().unwrap();
        let sources = ProjectAccess::environment_sources(&home).unwrap();
        let loaded = ProjectAccess::from_sources(&sources, &home).unwrap();
        eprintln!(
            "Cave metadata sources: projects={}, permissions={}",
            sources.projects.display(),
            sources.permissions.display()
        );
        let members: HashSet<_> = loaded
            .permissions
            .project_grants
            .iter()
            .map(|g| g.familiar_id.as_str())
            .chain(
                loaded
                    .permissions
                    .access_groups
                    .iter()
                    .flat_map(|g| g.member_familiar_ids.iter().map(String::as_str)),
            )
            .collect();
        let mut total = 0;
        for member in &members {
            total += loaded
                .for_familiar(member)
                .unwrap()
                .as_array()
                .unwrap()
                .len();
        }
        eprintln!("Cave metadata counts: projects={}, direct_grants={}, groups={}, familiar_ids={}, effective_entries={total}",
            loaded.projects.len(), loaded.permissions.project_grants.len(), loaded.permissions.access_groups.len(), members.len());
    }
}
