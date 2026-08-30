#![cfg(feature = "phase1-conformance")]

use std::{
    io::Write,
    process::{Command, Stdio},
};
#[cfg(unix)]
use std::{
    io::{BufRead, BufReader},
    process::{ChildStdin, ChildStdout},
};

use serde_json::{json, Value};

const INSTALLATION_ID: &str = "4e1d02ca-833b-4d9d-8e9f-31bb8f44f9b5";
const MAX_LINE_BYTES: usize = 64 * 1024;
const CONFORMANCE_SOURCE: &str = include_str!("../src/conformance.rs");

#[cfg(target_os = "macos")]
fn rpc_request(
    stdin: &mut ChildStdin,
    stdout: &mut BufReader<ChildStdout>,
    request: Value,
) -> Value {
    serde_json::to_writer(&mut *stdin, &request).expect("request must serialize");
    stdin.write_all(b"\n").expect("request newline must write");
    stdin.flush().expect("request must flush");
    let mut line = String::new();
    stdout
        .read_line(&mut line)
        .expect("response line must read");
    serde_json::from_str(&line).expect("response must be JSON")
}

#[cfg(target_os = "macos")]
fn keychain_contains(keychain: &str, service: &str, account: Option<&str>) -> bool {
    let mut probe = Command::new("/usr/bin/security");
    probe.args(["find-generic-password", "-s", service]);
    if let Some(account) = account {
        probe.args(["-a", account]);
    }
    probe
        .arg(keychain)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .expect("keychain probe must run")
        .success()
}

#[cfg(target_os = "macos")]
fn cleanup_reservation_account(handle: &str) -> String {
    format!("cleanup-reservation-v1:{handle}")
}

#[test]
fn windows_launched_cave_is_bound_to_a_kill_on_close_job() {
    for required in [
        "CreateJobObjectW",
        "SetInformationJobObject",
        "AssignProcessToJobObject",
        "JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE",
        "CREATE_SUSPENDED",
        "ResumeThread",
    ] {
        assert!(
            CONFORMANCE_SOURCE.contains(required),
            "missing Windows Cave job-object guarantee: {required}"
        );
    }
}
const NATIVE_PROVIDER_PRESET_ENV: &str = "OPENCOVEN_PHASE1_CONFORMANCE_NATIVE_PROVIDER_PRESET";
const CONFORMANCE_SERVICE_ENV: &str = "OPENCOVEN_PHASE1_CONFORMANCE_KEYRING_SERVICE";

#[test]
fn subprocess_native_missing_keychain_trust_fails_closed_without_leaking_or_mutating_home() {
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::{
        fs, io,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    let canary = "native-keychain-canary-must-not-escape";
    let manifest_root =
        fs::canonicalize(env!("CARGO_MANIFEST_DIR")).expect("manifest root must be canonical");
    let temp_root = fs::canonicalize(std::env::temp_dir()).expect("OS temp root must be canonical");
    assert!(
        !temp_root.starts_with(&manifest_root),
        "OS temp root must be outside the repository"
    );
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock must follow Unix epoch")
        .as_nanos();
    let home_name = format!(
        "opencoven-phase1-native-trust-home-{}-{nonce}",
        std::process::id()
    );
    let home = temp_root.join(&home_name);
    fs::create_dir(&home).expect("isolated home must be created");
    #[cfg(unix)]
    fs::set_permissions(&home, fs::Permissions::from_mode(0o700))
        .expect("isolated home must be private");
    let home = fs::canonicalize(home).expect("isolated home must be canonical");
    assert_eq!(
        home.parent(),
        Some(temp_root.as_path()),
        "isolated home must be a direct child of the OS temp root"
    );

    struct HomeCleanup {
        path: PathBuf,
        temp_root: PathBuf,
        expected_name: String,
        cleaned: bool,
    }

    impl HomeCleanup {
        fn verify_owned_directory(&self) -> io::Result<()> {
            let metadata = fs::symlink_metadata(&self.path)?;
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(io::Error::other(
                    "isolated home is no longer an owned directory",
                ));
            }
            let canonical = fs::canonicalize(&self.path)?;
            if canonical != self.path
                || canonical.parent() != Some(self.temp_root.as_path())
                || canonical.file_name() != Some(std::ffi::OsStr::new(&self.expected_name))
            {
                return Err(io::Error::other(
                    "isolated home is outside the owned OS temp-directory scope",
                ));
            }
            Ok(())
        }

        fn cleanup(&mut self) -> io::Result<()> {
            self.verify_owned_directory()?;
            fs::remove_dir_all(&self.path)?;
            self.cleaned = true;
            Ok(())
        }
    }

    impl Drop for HomeCleanup {
        fn drop(&mut self) {
            if !self.cleaned && std::thread::panicking() && self.verify_owned_directory().is_ok() {
                let _ = fs::remove_dir_all(&self.path);
            }
        }
    }

    let mut home_cleanup = HomeCleanup {
        path: home.clone(),
        temp_root,
        expected_name: home_name,
        cleaned: false,
    };
    let before = fs::read_dir(&home)
        .expect("isolated home must be readable")
        .count();

    let mut child = Command::new(env!("CARGO_BIN_EXE_phase1-native-rpc"))
        .env(NATIVE_PROVIDER_PRESET_ENV, "missing-keychain-trust")
        .env(
            CONFORMANCE_SERVICE_ENV,
            "ai.opencoven.chat.phase1.0123456789abcdef0123456789abcdef",
        )
        .env("HOME", &home)
        .env("COVEN_CAVE_AUTH_TOKEN", canary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("phase1-native-rpc must start");
    {
        let mut stdin = child.stdin.take().expect("child stdin must be piped");
        writeln!(
            stdin,
            r#"{{"id":"installation","command":"app_installation_id"}}"#
        )
        .expect("installation request must be written");
        writeln!(
            stdin,
            r#"{{"id":"shutdown","command":"conformance_shutdown"}}"#
        )
        .expect("shutdown request must be written");
    }

    let output = child
        .wait_with_output()
        .expect("phase1-native-rpc must exit after shutdown");
    let stdout = String::from_utf8(output.stdout).expect("stdout must be UTF-8");
    let stderr = String::from_utf8(output.stderr).expect("stderr must be UTF-8");
    assert!(output.status.success());
    let responses = stdout
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("response must be JSON"))
        .collect::<Vec<_>>();
    assert_eq!(
        responses,
        vec![
            json!({
                "id": "installation",
                "ok": false,
                "error": {"code": "secure_store_unavailable", "retryable": true}
            }),
            json!({
                "id": "shutdown",
                "ok": true,
                "result": {"status": "shutting_down"}
            }),
        ]
    );
    assert!(!stdout.contains(canary));
    assert!(!stderr.contains(canary));
    assert_eq!(
        fs::read_dir(&home)
            .expect("isolated home must remain readable")
            .count(),
        before
    );
    home_cleanup
        .cleanup()
        .expect("isolated home cleanup must succeed");
}

#[test]
fn subprocess_rejects_missing_malformed_and_production_keyring_services_before_custody_access() {
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    for (label, service) in [
        ("missing", None),
        (
            "malformed",
            Some("ai.opencoven.chat.phase1.not-a-valid-namespace"),
        ),
        ("production", Some("ai.opencoven.chat")),
    ] {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock must follow Unix epoch")
            .as_nanos();
        let home = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!(
                "phase1-cleanup-service-{label}-{}-{nonce}",
                std::process::id()
            ));
        fs::create_dir_all(&home).expect("isolated home must be created");
        #[cfg(unix)]
        fs::set_permissions(&home, fs::Permissions::from_mode(0o700))
            .expect("isolated home must be private");

        let mut command = Command::new(env!("CARGO_BIN_EXE_phase1-native-rpc"));
        command
            .env(NATIVE_PROVIDER_PRESET_ENV, "system-native")
            .env("HOME", &home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(service) = service {
            command.env(CONFORMANCE_SERVICE_ENV, service);
        } else {
            command.env_remove(CONFORMANCE_SERVICE_ENV);
        }
        let mut child = command.spawn().expect("phase1-native-rpc must start");
        {
            let mut stdin = child.stdin.take().expect("child stdin must be piped");
            writeln!(
                stdin,
                r#"{{"id":"installation","command":"app_installation_id"}}"#
            )
            .expect("installation request must be written");
        }
        let output = child
            .wait_with_output()
            .expect("phase1-native-rpc must reject its configuration");
        assert!(output.status.success());
        assert_eq!(
            String::from_utf8(output.stdout)
                .expect("stdout must be UTF-8")
                .lines()
                .map(|line| serde_json::from_str::<Value>(line).expect("response must be JSON"))
                .collect::<Vec<_>>(),
            vec![json!({
                "id": "invalid-request",
                "ok": false,
                "error": {"code": "invalid_native_input", "retryable": false}
            })],
            "{label} service must fail before RPC startup",
        );
        assert!(
            fs::read_dir(&home)
                .expect("isolated home must remain readable")
                .next()
                .is_none(),
            "{label} service must not touch custody or create grant state",
        );
        fs::remove_dir(&home).expect("isolated home must be removable");
    }
}

#[cfg(target_os = "macos")]
#[test]
fn subprocess_cleanup_grants_are_exact_scoped_single_use_and_tamper_evident() {
    use std::{
        collections::BTreeSet,
        fs,
        io::BufReader,
        os::unix::fs::PermissionsExt,
        path::{Path, PathBuf},
        time::{SystemTime, UNIX_EPOCH},
    };

    const INSTALLATION_ACCOUNT: &str = "installation-id-v1";
    const TARGET_A: &str = "00000000-0000-4000-8000-000000000001";
    const TARGET_B: &str = "00000000-0000-4000-8000-000000000002";
    const UNRELATED: &str = "00000000-0000-4000-8000-000000000003";

    fn credential_account(instance_id: &str) -> String {
        format!("cave-client-v1:{instance_id}")
    }

    fn run_security(home: &Path, arguments: &[&str]) -> std::process::Output {
        Command::new("/usr/bin/security")
            .args(arguments)
            .env("HOME", home)
            .output()
            .expect("security command must run")
    }

    fn set_entry(home: &Path, keychain: &Path, service: &str, account: &str, value: &str) {
        let output = run_security(
            home,
            &[
                "add-generic-password",
                "-U",
                "-A",
                "-a",
                account,
                "-s",
                service,
                "-w",
                value,
                keychain.to_str().expect("keychain path must be UTF-8"),
            ],
        );
        assert!(
            output.status.success(),
            "test keyring entry must be stored: {}",
            String::from_utf8_lossy(&output.stderr),
        );
    }

    fn entry_present(home: &Path, keychain: &Path, service: &str, account: &str) -> bool {
        run_security(
            home,
            &[
                "find-generic-password",
                "-a",
                account,
                "-s",
                service,
                keychain.to_str().expect("keychain path must be UTF-8"),
            ],
        )
        .status
        .success()
    }

    struct KeychainCleanup {
        home: PathBuf,
        path: PathBuf,
    }

    impl Drop for KeychainCleanup {
        fn drop(&mut self) {
            let _ = run_security(
                &self.home,
                &["delete-keychain", self.path.to_str().unwrap_or_default()],
            );
        }
    }

    struct HomeCleanup(PathBuf);

    impl Drop for HomeCleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    struct RpcProcess {
        child: std::process::Child,
        stdin: ChildStdin,
        stdout: BufReader<ChildStdout>,
    }

    impl RpcProcess {
        fn request(&mut self, value: Value) -> Value {
            serde_json::to_writer(&mut self.stdin, &value).expect("request must serialize");
            self.stdin
                .write_all(b"\n")
                .expect("request delimiter must write");
            self.stdin.flush().expect("request must flush");
            let mut line = String::new();
            self.stdout
                .read_line(&mut line)
                .expect("response must be readable");
            serde_json::from_str(&line).expect("response must be JSON")
        }

        fn issue(&mut self, instance_ids: &[&str]) -> String {
            let response = self.request(json!({
                "id": "issue",
                "command": "conformance_issue_native_custody_cleanup",
                "args": {"instanceIds": instance_ids},
            }));
            assert_eq!(
                response["ok"], true,
                "cleanup grant issuance must succeed: {response}"
            );
            let grant = response["result"]["grant"]
                .as_str()
                .expect("cleanup grant must be returned")
                .to_owned();
            assert_eq!(grant.len(), 43, "grant must encode exactly 256 random bits");
            assert!(
                grant
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')),
                "grant must be opaque base64url without padding",
            );
            grant
        }

        fn cleanup(&mut self, grant: &str) -> Value {
            self.request(json!({
                "id": "cleanup",
                "command": "conformance_cleanup_native_custody",
                "args": {"grant": grant},
            }))
        }

        fn reject_cleanup(&mut self, grant: &str) {
            assert_eq!(
                self.cleanup(grant),
                json!({
                    "id": "cleanup",
                    "ok": false,
                    "error": {"code": "cleanup_grant_rejected", "retryable": false},
                }),
            );
        }
    }

    fn marker_files(home: &Path) -> BTreeSet<PathBuf> {
        let directory = home
            .join(".coven")
            .join("chat")
            .join("phase1-cleanup-grants-v1");
        match fs::read_dir(directory) {
            Ok(entries) => entries
                .map(|entry| {
                    entry
                        .expect("marker directory entry must be readable")
                        .path()
                })
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with("grant-") && name.ends_with(".json"))
                })
                .collect(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeSet::new(),
            Err(error) => panic!("marker directory must be readable: {error}"),
        }
    }

    fn issue_with_marker(rpc: &mut RpcProcess, home: &Path, ids: &[&str]) -> (String, PathBuf) {
        let before = marker_files(home);
        let grant = rpc.issue(ids);
        let after = marker_files(home);
        let created = after.difference(&before).cloned().collect::<Vec<_>>();
        assert_eq!(
            created.len(),
            1,
            "issuance must atomically publish one marker"
        );
        (grant, created[0].clone())
    }

    fn rewrite_marker(path: &Path, mutate: impl FnOnce(&mut Value)) {
        let mut marker: Value =
            serde_json::from_slice(&fs::read(path).expect("marker must be readable"))
                .expect("marker must be JSON");
        mutate(&mut marker);
        let file = fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(path)
            .expect("marker must remain writable by its owner");
        serde_json::to_writer(&file, &marker).expect("mutated marker must serialize");
        file.sync_all().expect("mutated marker must sync");
    }

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock must follow Unix epoch")
        .as_nanos();
    let service = format!(
        "ai.opencoven.chat.phase1.{:032x}",
        nonce ^ u128::from(std::process::id())
    );
    let home = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("target")
        .join(format!(
            "phase1-cleanup-grant-home-{}-{nonce}",
            std::process::id()
        ));
    fs::create_dir_all(&home).expect("isolated home must be created");
    fs::set_permissions(&home, fs::Permissions::from_mode(0o700))
        .expect("isolated home must be private");
    let _home_cleanup = HomeCleanup(home.clone());
    let preferences = home.join("Library").join("Preferences");
    let keychains = home.join("Library").join("Keychains");
    for directory in [home.join("Library"), preferences, keychains.clone()] {
        fs::create_dir_all(&directory).expect("isolated keychain directory must be created");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
            .expect("isolated keychain directory must be private");
    }
    let keychain = keychains.join("phase1-test.keychain-db");
    let password = format!("{:064x}", nonce ^ u128::from(std::process::id()));
    for arguments in [
        vec![
            "create-keychain",
            "-p",
            password.as_str(),
            keychain.to_str().expect("keychain path must be UTF-8"),
        ],
        vec![
            "set-keychain-settings",
            "-lut",
            "7200",
            keychain.to_str().expect("keychain path must be UTF-8"),
        ],
        vec![
            "unlock-keychain",
            "-p",
            password.as_str(),
            keychain.to_str().expect("keychain path must be UTF-8"),
        ],
        vec![
            "default-keychain",
            "-d",
            "user",
            "-s",
            keychain.to_str().expect("keychain path must be UTF-8"),
        ],
        vec![
            "list-keychains",
            "-d",
            "user",
            "-s",
            keychain.to_str().expect("keychain path must be UTF-8"),
        ],
    ] {
        let output = run_security(&home, &arguments);
        assert!(
            output.status.success(),
            "isolated keychain setup must succeed: {}",
            String::from_utf8_lossy(&output.stderr),
        );
    }
    fs::set_permissions(&keychain, fs::Permissions::from_mode(0o600))
        .expect("isolated keychain must be private");
    let _keychain_cleanup = KeychainCleanup {
        home: home.clone(),
        path: keychain.clone(),
    };

    let mut child = Command::new(env!("CARGO_BIN_EXE_phase1-native-rpc"))
        .env(NATIVE_PROVIDER_PRESET_ENV, "system-native")
        .env(CONFORMANCE_SERVICE_ENV, &service)
        .env("HOME", &home)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("phase1-native-rpc must start");
    let stdin = child.stdin.take().expect("child stdin must be piped");
    let stdout = BufReader::new(child.stdout.take().expect("child stdout must be piped"));
    let mut rpc = RpcProcess {
        child,
        stdin,
        stdout,
    };

    let before = rpc.request(json!({
        "id": "state",
        "command": "conformance_native_custody_state",
        "args": {"instanceIds": [TARGET_A, TARGET_B]},
    }));
    assert_eq!(
        before["ok"], true,
        "native custody preflight failed: {before}"
    );
    assert_eq!(before["result"]["empty"], true);

    set_entry(
        &home,
        &keychain,
        &service,
        INSTALLATION_ACCOUNT,
        INSTALLATION_ID,
    );
    let credential =
        r#"{"bearer":"secret","credential_id":"credential","origin":"http://127.0.0.1:4310/"}"#;
    set_entry(
        &home,
        &keychain,
        &service,
        &credential_account(TARGET_A),
        credential,
    );
    set_entry(
        &home,
        &keychain,
        &service,
        &credential_account(TARGET_B),
        credential,
    );
    set_entry(
        &home,
        &keychain,
        &service,
        &credential_account(UNRELATED),
        credential,
    );

    let (grant, marker) = issue_with_marker(&mut rpc, &home, &[TARGET_B, TARGET_A, TARGET_B]);
    let marker_text = fs::read_to_string(&marker).expect("marker must be readable");
    assert!(
        !marker_text.contains(&grant),
        "marker must not persist the raw grant"
    );
    let marker_json: Value = serde_json::from_str(&marker_text).expect("marker must be JSON");
    assert_eq!(
        marker_json["payload"]["accounts"],
        json!([
            INSTALLATION_ACCOUNT,
            credential_account(TARGET_A),
            credential_account(TARGET_B),
        ]),
        "marker must bind the canonical sorted and deduplicated account set",
    );

    rpc.reject_cleanup("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
    assert!(entry_present(
        &home,
        &keychain,
        &service,
        INSTALLATION_ACCOUNT
    ));
    assert!(entry_present(
        &home,
        &keychain,
        &service,
        &credential_account(TARGET_A)
    ));
    assert!(entry_present(
        &home,
        &keychain,
        &service,
        &credential_account(TARGET_B)
    ));
    assert!(entry_present(
        &home,
        &keychain,
        &service,
        &credential_account(UNRELATED)
    ));
    assert_eq!(
        rpc.request(json!({
            "id": "cleanup",
            "command": "conformance_cleanup_native_custody",
            "args": {"grant": grant, "instanceIds": [UNRELATED]},
        }))["error"],
        json!({"code": "invalid_native_input", "retryable": false}),
        "cleanup must reject caller-selected account scope",
    );
    assert_eq!(
        rpc.request(json!({
            "id": "cleanup",
            "command": "conformance_cleanup_native_custody",
            "args": {"grant": grant, "service": "ai.opencoven.chat"},
        }))["error"],
        json!({"code": "invalid_native_input", "retryable": false}),
        "cleanup must reject caller-selected service scope",
    );

    for id in ["cleanup-race-one", "cleanup-race-two"] {
        serde_json::to_writer(
            &mut rpc.stdin,
            &json!({
                "id": id,
                "command": "conformance_cleanup_native_custody",
                "args": {"grant": grant},
            }),
        )
        .expect("concurrent cleanup request must serialize");
        rpc.stdin
            .write_all(b"\n")
            .expect("concurrent cleanup delimiter must write");
    }
    rpc.stdin
        .flush()
        .expect("concurrent cleanup requests must flush");
    let concurrent = [0, 1].map(|_| {
        let mut line = String::new();
        rpc.stdout
            .read_line(&mut line)
            .expect("concurrent cleanup response must be readable");
        serde_json::from_str::<Value>(&line).expect("concurrent cleanup response must be JSON")
    });
    let cleaned = concurrent
        .iter()
        .find(|response| response["ok"] == true)
        .expect("one concurrent cleanup redemption must succeed");
    let rejected = concurrent
        .iter()
        .find(|response| response["ok"] == false)
        .expect("one concurrent cleanup redemption must be rejected");
    assert_eq!(
        rejected["error"],
        json!({"code": "cleanup_grant_rejected", "retryable": false}),
    );
    assert_eq!(cleaned["result"]["empty"], true);
    assert_eq!(
        cleaned["result"]["stateSha256"],
        before["result"]["stateSha256"]
    );
    assert!(!entry_present(
        &home,
        &keychain,
        &service,
        INSTALLATION_ACCOUNT
    ));
    assert!(!entry_present(
        &home,
        &keychain,
        &service,
        &credential_account(TARGET_A)
    ));
    assert!(!entry_present(
        &home,
        &keychain,
        &service,
        &credential_account(TARGET_B)
    ));
    assert!(
        entry_present(&home, &keychain, &service, &credential_account(UNRELATED)),
        "cleanup must preserve unrelated entries in the isolated namespace",
    );
    rpc.reject_cleanup(&grant);

    set_entry(
        &home,
        &keychain,
        &service,
        INSTALLATION_ACCOUNT,
        INSTALLATION_ID,
    );
    set_entry(
        &home,
        &keychain,
        &service,
        &credential_account(TARGET_A),
        credential,
    );
    let (account_grant, account_marker) = issue_with_marker(&mut rpc, &home, &[TARGET_A]);
    rewrite_marker(&account_marker, |marker| {
        marker["payload"]["accounts"][1] = Value::String(credential_account(UNRELATED));
    });
    rpc.reject_cleanup(&account_grant);
    assert!(entry_present(
        &home,
        &keychain,
        &service,
        INSTALLATION_ACCOUNT
    ));
    assert!(entry_present(
        &home,
        &keychain,
        &service,
        &credential_account(TARGET_A)
    ));
    rpc.reject_cleanup(&account_grant);

    let (service_grant, service_marker) = issue_with_marker(&mut rpc, &home, &[TARGET_A]);
    rewrite_marker(&service_marker, |marker| {
        marker["payload"]["service"] =
            Value::String("ai.opencoven.chat.phase1.ffffffffffffffffffffffffffffffff".to_owned());
    });
    rpc.reject_cleanup(&service_grant);
    assert!(entry_present(
        &home,
        &keychain,
        &service,
        INSTALLATION_ACCOUNT
    ));
    assert!(entry_present(
        &home,
        &keychain,
        &service,
        &credential_account(TARGET_A)
    ));

    let (symlink_grant, symlink_marker) = issue_with_marker(&mut rpc, &home, &[TARGET_A]);
    let saved_marker = symlink_marker.with_extension("saved");
    fs::rename(&symlink_marker, &saved_marker).expect("marker must move aside");
    std::os::unix::fs::symlink(
        saved_marker
            .file_name()
            .expect("saved marker must have a file name"),
        &symlink_marker,
    )
    .expect("marker symlink must be created");
    rpc.reject_cleanup(&symlink_grant);
    assert!(entry_present(
        &home,
        &keychain,
        &service,
        INSTALLATION_ACCOUNT
    ));
    assert!(entry_present(
        &home,
        &keychain,
        &service,
        &credential_account(TARGET_A)
    ));

    let (hardlink_grant, hardlink_marker) = issue_with_marker(&mut rpc, &home, &[TARGET_A]);
    let hardlink_alias = hardlink_marker.with_extension("alias");
    fs::hard_link(&hardlink_marker, &hardlink_alias).expect("marker hard link must be created");
    rpc.reject_cleanup(&hardlink_grant);
    assert!(entry_present(
        &home,
        &keychain,
        &service,
        INSTALLATION_ACCOUNT
    ));
    assert!(entry_present(
        &home,
        &keychain,
        &service,
        &credential_account(TARGET_A)
    ));

    let (replaced_grant, replaced_marker) = issue_with_marker(&mut rpc, &home, &[TARGET_A]);
    let (_substitute_grant, substitute_marker) = issue_with_marker(&mut rpc, &home, &[UNRELATED]);
    fs::remove_file(&replaced_marker).expect("original marker must be removed");
    fs::rename(&substitute_marker, &replaced_marker).expect("substitute marker must be installed");
    rpc.reject_cleanup(&replaced_grant);
    assert!(entry_present(
        &home,
        &keychain,
        &service,
        INSTALLATION_ACCOUNT
    ));
    assert!(entry_present(
        &home,
        &keychain,
        &service,
        &credential_account(TARGET_A)
    ));

    let (directory_grant, directory_marker) = issue_with_marker(&mut rpc, &home, &[TARGET_A]);
    let marker_directory = directory_marker
        .parent()
        .expect("marker must have a parent")
        .to_owned();
    let saved_directory = marker_directory.with_extension("saved");
    fs::rename(&marker_directory, &saved_directory).expect("marker directory must move aside");
    fs::create_dir(&marker_directory).expect("substitute marker directory must be created");
    fs::set_permissions(&marker_directory, fs::Permissions::from_mode(0o700))
        .expect("substitute marker directory must be private");
    let substituted_marker = marker_directory.join(
        directory_marker
            .file_name()
            .expect("marker must have a file name"),
    );
    fs::copy(
        saved_directory.join(
            directory_marker
                .file_name()
                .expect("marker must have a file name"),
        ),
        &substituted_marker,
    )
    .expect("signed marker must be copied into the substitute directory");
    fs::set_permissions(&substituted_marker, fs::Permissions::from_mode(0o600))
        .expect("substituted marker must retain a private mode");
    rpc.reject_cleanup(&directory_grant);
    assert!(entry_present(
        &home,
        &keychain,
        &service,
        INSTALLATION_ACCOUNT
    ));
    assert!(entry_present(
        &home,
        &keychain,
        &service,
        &credential_account(TARGET_A)
    ));
    fs::remove_dir_all(&marker_directory).expect("substitute marker directory must be removed");
    fs::rename(&saved_directory, &marker_directory)
        .expect("original marker directory must be restored");

    let final_grant = rpc.issue(&[TARGET_A]);
    assert_eq!(rpc.cleanup(&final_grant)["ok"], true);
    assert!(!entry_present(
        &home,
        &keychain,
        &service,
        INSTALLATION_ACCOUNT
    ));
    assert!(!entry_present(
        &home,
        &keychain,
        &service,
        &credential_account(TARGET_A)
    ));
    assert!(entry_present(
        &home,
        &keychain,
        &service,
        &credential_account(UNRELATED)
    ));

    assert_eq!(
        rpc.request(json!({"id":"shutdown","command":"conformance_shutdown"})),
        json!({
            "id": "shutdown",
            "ok": true,
            "result": {"status": "shutting_down"},
        }),
    );
    drop(rpc.stdin);
    let output = rpc
        .child
        .wait_with_output()
        .expect("phase1-native-rpc must exit");
    assert!(
        output.status.success(),
        "native RPC stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(windows)]
mod windows_cleanup {
    use std::{
        collections::{BTreeSet, HashMap},
        fs,
        io::{BufRead, BufReader},
        path::{Path, PathBuf},
        process::{Child, ChildStdin, ChildStdout},
        sync::atomic::{AtomicU64, Ordering},
        thread,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    use keyring_core::{api::CredentialStoreApi, Entry, Error as KeyringError};
    use windows_native_keyring_store::Store;

    use super::*;

    const INSTALLATION_ACCOUNT: &str = "installation-id-v1";
    const TARGET_A: &str = "00000000-0000-4000-8000-000000000001";
    const TARGET_B: &str = "00000000-0000-4000-8000-000000000002";
    const UNRELATED: &str = "00000000-0000-4000-8000-000000000003";
    const CLEANUP_HOOK_ENV: &str = "OPENCOVEN_PHASE1_CONFORMANCE_CLEANUP_TEST_HOOK";
    const CLEANUP_HOOK_DIRECTORY_ENV: &str =
        "OPENCOVEN_PHASE1_CONFORMANCE_CLEANUP_TEST_HOOK_DIRECTORY";

    fn credential_account(instance_id: &str) -> String {
        format!("cave-client-v1:{instance_id}")
    }

    fn nonce() -> u128 {
        static COUNTER: AtomicU64 = AtomicU64::new(0);

        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock must follow Unix epoch")
            .as_nanos()
            ^ u128::from(std::process::id())
            ^ u128::from(COUNTER.fetch_add(1, Ordering::Relaxed))
    }

    fn service_name() -> String {
        format!("ai.opencoven.chat.phase1.{:032x}", nonce())
    }

    fn credential_entry(service: &str, account: &str) -> Entry {
        let store = Store::new().expect("Windows Credential Manager store must initialize");
        store
            .build(
                service,
                account,
                Some(&HashMap::from([("persistence", "Local")])),
            )
            .expect("Windows credential entry must build")
    }

    struct CredentialCleanup(Vec<(String, String)>);

    impl CredentialCleanup {
        fn set(&mut self, service: &str, account: &str, value: &[u8]) {
            let entry = credential_entry(service, account);
            entry
                .set_secret(value)
                .expect("Windows credential must be stored");
            self.0.push((service.to_owned(), account.to_owned()));
        }
    }

    impl Drop for CredentialCleanup {
        fn drop(&mut self) {
            for (service, account) in self.0.iter().rev() {
                let _ = credential_entry(service, account).delete_credential();
            }
        }
    }

    fn entry_present(service: &str, account: &str) -> bool {
        match credential_entry(service, account).get_secret() {
            Ok(_) => true,
            Err(KeyringError::NoEntry) => false,
            Err(error) => panic!("Windows credential lookup failed: {error:?}"),
        }
    }

    struct HomeCleanup {
        profile: PathBuf,
        path: PathBuf,
    }

    impl Drop for HomeCleanup {
        fn drop(&mut self) {
            if self.path.parent() == Some(self.profile.as_path())
                && self
                    .path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("opencoven-phase1-cleanup-"))
            {
                let _ = fs::remove_dir_all(&self.path);
            }
        }
    }

    fn isolated_home() -> (PathBuf, HomeCleanup) {
        let profile =
            PathBuf::from(std::env::var_os("USERPROFILE").expect("USERPROFILE must be set"));
        let path = profile.join(format!("opencoven-phase1-cleanup-{:032x}", nonce()));
        fs::create_dir(&path).expect("isolated Windows home must be created");
        (path.clone(), HomeCleanup { profile, path })
    }

    struct RpcProcess {
        child: Child,
        stdin: ChildStdin,
        stdout: BufReader<ChildStdout>,
        finished: bool,
    }

    impl RpcProcess {
        fn spawn(home: &Path, service: &str, hook: Option<(&str, &Path)>) -> Self {
            let mut command = Command::new(env!("CARGO_BIN_EXE_phase1-native-rpc"));
            command
                .env(NATIVE_PROVIDER_PRESET_ENV, "system-native")
                .env(CONFORMANCE_SERVICE_ENV, service)
                .env("HOME", home)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());
            if let Some((name, directory)) = hook {
                command
                    .env(CLEANUP_HOOK_ENV, name)
                    .env(CLEANUP_HOOK_DIRECTORY_ENV, directory);
            }
            let mut child = command.spawn().expect("phase1-native-rpc must start");
            let stdin = child.stdin.take().expect("child stdin must be piped");
            let stdout = BufReader::new(child.stdout.take().expect("child stdout must be piped"));
            Self {
                child,
                stdin,
                stdout,
                finished: false,
            }
        }

        fn send(&mut self, value: Value) {
            serde_json::to_writer(&mut self.stdin, &value).expect("request must serialize");
            self.stdin
                .write_all(b"\n")
                .expect("request delimiter must write");
            self.stdin.flush().expect("request must flush");
        }

        fn receive(&mut self) -> Value {
            let mut line = String::new();
            self.stdout
                .read_line(&mut line)
                .expect("response must be readable");
            serde_json::from_str(&line).expect("response must be JSON")
        }

        fn request(&mut self, value: Value) -> Value {
            self.send(value);
            self.receive()
        }

        fn issue_response(&mut self, instance_ids: &[&str]) -> Value {
            self.request(json!({
                "id": "issue",
                "command": "conformance_issue_native_custody_cleanup",
                "args": {"instanceIds": instance_ids},
            }))
        }

        fn issue(&mut self, instance_ids: &[&str]) -> String {
            let response = self.issue_response(instance_ids);
            assert_eq!(
                response["ok"], true,
                "cleanup grant issuance must succeed: {response}"
            );
            response["result"]["grant"]
                .as_str()
                .expect("cleanup grant must be returned")
                .to_owned()
        }

        fn cleanup(&mut self, grant: &str) -> Value {
            self.request(json!({
                "id": "cleanup",
                "command": "conformance_cleanup_native_custody",
                "args": {"grant": grant},
            }))
        }

        fn reject_cleanup(&mut self, grant: &str) {
            assert_eq!(
                self.cleanup(grant),
                json!({
                    "id": "cleanup",
                    "ok": false,
                    "error": {"code": "cleanup_grant_rejected", "retryable": false},
                }),
            );
        }

        fn shutdown(&mut self) {
            assert_eq!(
                self.request(json!({"id":"shutdown","command":"conformance_shutdown"})),
                json!({
                    "id": "shutdown",
                    "ok": true,
                    "result": {"status": "shutting_down"},
                }),
            );
            let status = self.child.wait().expect("phase1-native-rpc must exit");
            assert!(status.success());
            self.finished = true;
        }
    }

    impl Drop for RpcProcess {
        fn drop(&mut self) {
            if !self.finished {
                let _ = self.child.kill();
                let _ = self.child.wait();
            }
        }
    }

    fn marker_directory(home: &Path) -> PathBuf {
        home.join(".coven")
            .join("chat")
            .join("phase1-cleanup-grants-v1")
    }

    fn marker_files(home: &Path) -> BTreeSet<PathBuf> {
        match fs::read_dir(marker_directory(home)) {
            Ok(entries) => entries
                .map(|entry| entry.expect("marker entry must be readable").path())
                .filter(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with("grant-") && name.ends_with(".json"))
                })
                .collect(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => BTreeSet::new(),
            Err(error) => panic!("marker directory must be readable: {error}"),
        }
    }

    fn issue_with_marker(
        rpc: &mut RpcProcess,
        home: &Path,
        instance_ids: &[&str],
    ) -> (String, PathBuf) {
        let before = marker_files(home);
        let grant = rpc.issue(instance_ids);
        let after = marker_files(home);
        let created = after.difference(&before).cloned().collect::<Vec<_>>();
        assert_eq!(created.len(), 1, "issuance must publish one marker");
        (grant, created[0].clone())
    }

    fn rewrite_marker(path: &Path, mutate: impl FnOnce(&mut Value)) {
        let mut marker: Value =
            serde_json::from_slice(&fs::read(path).expect("marker must be readable"))
                .expect("marker must be JSON");
        mutate(&mut marker);
        let file = fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(path)
            .expect("marker must be writable");
        serde_json::to_writer(&file, &marker).expect("marker must serialize");
        file.sync_all().expect("marker must sync");
    }

    fn set_cleanup_entries(cleanup: &mut CredentialCleanup, service: &str, instance_ids: &[&str]) {
        cleanup.set(service, INSTALLATION_ACCOUNT, INSTALLATION_ID.as_bytes());
        for instance_id in instance_ids {
            cleanup.set(
                service,
                &credential_account(instance_id),
                br#"{"bearer":"secret","credential_id":"credential","origin":"http://127.0.0.1:4310/"}"#,
            );
        }
    }

    fn wait_for_hook(directory: &Path, name: &str) {
        let ready = directory.join(format!("{name}.ready"));
        let deadline = Instant::now() + Duration::from_secs(10);
        while !ready.is_file() {
            assert!(
                Instant::now() < deadline,
                "cleanup hook {name} must become ready"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn release_hook(directory: &Path, name: &str) {
        fs::write(directory.join(format!("{name}.release")), b"release")
            .expect("cleanup hook must be released");
    }

    #[test]
    fn native_cleanup_is_exact_single_use_bound_and_preserves_unrelated_credentials() {
        let (home, _home_cleanup) = isolated_home();
        let service = service_name();
        let unrelated_service = format!("opencoven.phase1.unrelated.{:032x}", nonce());
        let unrelated_account = format!("unrelated-{:032x}", nonce());
        let mut credential_cleanup = CredentialCleanup(Vec::new());
        set_cleanup_entries(
            &mut credential_cleanup,
            &service,
            &[TARGET_A, TARGET_B, UNRELATED],
        );
        credential_cleanup.set(&unrelated_service, &unrelated_account, b"preserve");
        let mut rpc = RpcProcess::spawn(&home, &service, None);

        let (grant, _) = issue_with_marker(&mut rpc, &home, &[TARGET_B, TARGET_A, TARGET_B]);
        rpc.reject_cleanup("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB");
        assert_eq!(
            rpc.request(json!({
                "id": "cleanup",
                "command": "conformance_cleanup_native_custody",
                "args": {"grant": grant, "instanceIds": [UNRELATED]},
            }))["error"],
            json!({"code": "invalid_native_input", "retryable": false}),
        );
        assert_eq!(
            rpc.request(json!({
                "id": "cleanup",
                "command": "conformance_cleanup_native_custody",
                "args": {"grant": grant, "service": "ai.opencoven.chat"},
            }))["error"],
            json!({"code": "invalid_native_input", "retryable": false}),
        );
        assert_eq!(rpc.cleanup(&grant)["ok"], true);
        rpc.reject_cleanup(&grant);
        for account in [
            INSTALLATION_ACCOUNT.to_owned(),
            credential_account(TARGET_A),
            credential_account(TARGET_B),
        ] {
            assert!(!entry_present(&service, &account));
        }
        assert!(entry_present(&service, &credential_account(UNRELATED)));
        assert!(entry_present(&unrelated_service, &unrelated_account));

        set_cleanup_entries(&mut credential_cleanup, &service, &[TARGET_A]);
        let (account_grant, account_marker) = issue_with_marker(&mut rpc, &home, &[TARGET_A]);
        rewrite_marker(&account_marker, |marker| {
            marker["payload"]["accounts"][1] = Value::String(credential_account(UNRELATED));
        });
        rpc.reject_cleanup(&account_grant);
        assert!(entry_present(&service, INSTALLATION_ACCOUNT));
        assert!(entry_present(&service, &credential_account(TARGET_A)));

        let (service_grant, service_marker) = issue_with_marker(&mut rpc, &home, &[TARGET_A]);
        rewrite_marker(&service_marker, |marker| {
            marker["payload"]["service"] = Value::String(
                "ai.opencoven.chat.phase1.ffffffffffffffffffffffffffffffff".to_owned(),
            );
        });
        rpc.reject_cleanup(&service_grant);
        assert!(entry_present(&service, INSTALLATION_ACCOUNT));
        assert!(entry_present(&service, &credential_account(TARGET_A)));

        let (link_grant, link_marker) = issue_with_marker(&mut rpc, &home, &[TARGET_A]);
        let link_alias = link_marker.with_extension("alias");
        fs::hard_link(&link_marker, &link_alias).expect("marker hard link must be created");
        rpc.reject_cleanup(&link_grant);
        assert!(entry_present(&service, INSTALLATION_ACCOUNT));
        assert!(entry_present(&service, &credential_account(TARGET_A)));

        let (identity_grant, identity_marker) = issue_with_marker(&mut rpc, &home, &[TARGET_A]);
        let (_substitute_grant, substitute_marker) =
            issue_with_marker(&mut rpc, &home, &[UNRELATED]);
        fs::remove_file(&identity_marker).expect("original marker must be removed");
        fs::rename(&substitute_marker, &identity_marker)
            .expect("substitute marker must be installed");
        rpc.reject_cleanup(&identity_grant);
        assert!(entry_present(&service, INSTALLATION_ACCOUNT));
        assert!(entry_present(&service, &credential_account(TARGET_A)));

        let final_grant = rpc.issue(&[TARGET_A]);
        assert_eq!(rpc.cleanup(&final_grant)["ok"], true);
        assert!(!entry_present(&service, INSTALLATION_ACCOUNT));
        assert!(!entry_present(&service, &credential_account(TARGET_A)));
        assert!(entry_present(&service, &credential_account(UNRELATED)));
        assert!(entry_present(&unrelated_service, &unrelated_account));
        rpc.shutdown();
    }

    #[test]
    fn native_cleanup_rejects_delete_child_acl_and_reparse_directory_substitution() {
        let (home, _home_cleanup) = isolated_home();
        let service = service_name();
        let mut credential_cleanup = CredentialCleanup(Vec::new());
        set_cleanup_entries(&mut credential_cleanup, &service, &[TARGET_A]);
        let mut rpc = RpcProcess::spawn(&home, &service, None);

        let (acl_grant, _) = issue_with_marker(&mut rpc, &home, &[TARGET_A]);
        let marker_root = marker_directory(&home);
        let grant_acl = Command::new("icacls")
            .arg(&marker_root)
            .args(["/grant", "*S-1-1-0:(DC)"])
            .output()
            .expect("icacls must run");
        assert!(
            grant_acl.status.success(),
            "FILE_DELETE_CHILD ACE must be installed: {}",
            String::from_utf8_lossy(&grant_acl.stderr)
        );
        rpc.reject_cleanup(&acl_grant);
        assert!(entry_present(&service, INSTALLATION_ACCOUNT));
        assert!(entry_present(&service, &credential_account(TARGET_A)));
        let remove_acl = Command::new("icacls")
            .arg(&marker_root)
            .args(["/remove:g", "*S-1-1-0"])
            .output()
            .expect("icacls must run");
        assert!(
            remove_acl.status.success(),
            "test ACE must be removed: {}",
            String::from_utf8_lossy(&remove_acl.stderr)
        );

        let (reparse_grant, reparse_marker) = issue_with_marker(&mut rpc, &home, &[TARGET_A]);
        let marker_root = reparse_marker
            .parent()
            .expect("marker must have a parent")
            .to_owned();
        let saved_root = marker_root.with_extension("saved");
        fs::rename(&marker_root, &saved_root).expect("marker directory must move aside");
        let junction = Command::new("cmd")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(&marker_root)
            .arg(&saved_root)
            .output()
            .expect("mklink must run");
        assert!(
            junction.status.success(),
            "marker junction must be created: {}",
            String::from_utf8_lossy(&junction.stderr)
        );
        rpc.reject_cleanup(&reparse_grant);
        assert!(entry_present(&service, INSTALLATION_ACCOUNT));
        assert!(entry_present(&service, &credential_account(TARGET_A)));
        fs::remove_dir(&marker_root).expect("marker junction must be removed");
        fs::rename(&saved_root, &marker_root).expect("marker directory must be restored");

        let final_grant = rpc.issue(&[TARGET_A]);
        assert_eq!(rpc.cleanup(&final_grant)["ok"], true);
        rpc.shutdown();
    }

    #[test]
    fn native_cleanup_rejects_parent_chain_substitution_between_identity_and_publication() {
        let (home, _home_cleanup) = isolated_home();
        let service = service_name();
        let hook_directory = home.join("cleanup-hooks");
        fs::create_dir(&hook_directory).expect("cleanup hook directory must be created");
        let mut rpc = RpcProcess::spawn(
            &home,
            &service,
            Some(("issue-storage-identity", &hook_directory)),
        );

        rpc.send(json!({
            "id": "issue",
            "command": "conformance_issue_native_custody_cleanup",
            "args": {"instanceIds": [TARGET_A]},
        }));
        wait_for_hook(&hook_directory, "issue-storage-identity");
        let coven = home.join(".coven");
        let saved_coven = home.join(".coven-parent-substitute");
        fs::rename(&coven, &saved_coven).expect("original .coven directory must move aside");
        fs::create_dir(&coven).expect("substitute .coven directory must be created");
        fs::create_dir(coven.join("chat")).expect("substitute chat directory must be created");
        fs::rename(
            saved_coven.join("chat").join("phase1-cleanup-grants-v1"),
            coven.join("chat").join("phase1-cleanup-grants-v1"),
        )
        .expect("original marker directory identity must move under substitute parents");
        release_hook(&hook_directory, "issue-storage-identity");
        assert_eq!(
            rpc.receive()["error"],
            json!({"code": "secure_store_unavailable", "retryable": true}),
            "publication must reject a replaced parent chain even when the marker directory identity is retained",
        );
        rpc.shutdown();
    }

    #[test]
    fn native_cleanup_pins_parent_chain_during_publication_and_claim() {
        for (hook, operation) in [("publish-pinned", "issue"), ("claim-pinned", "cleanup")] {
            let (home, _home_cleanup) = isolated_home();
            let service = service_name();
            let hook_directory = home.join("cleanup-hooks");
            fs::create_dir(&hook_directory).expect("cleanup hook directory must be created");
            let mut rpc = RpcProcess::spawn(&home, &service, Some((hook, &hook_directory)));
            let grant = if operation == "cleanup" {
                Some(rpc.issue(&[TARGET_A]))
            } else {
                None
            };

            if let Some(grant) = grant.as_deref() {
                rpc.send(json!({
                    "id": "cleanup",
                    "command": "conformance_cleanup_native_custody",
                    "args": {"grant": grant},
                }));
            } else {
                rpc.send(json!({
                    "id": "issue",
                    "command": "conformance_issue_native_custody_cleanup",
                    "args": {"instanceIds": [TARGET_A]},
                }));
            }
            wait_for_hook(&hook_directory, hook);
            let coven = home.join(".coven");
            let saved_coven = home.join(format!(".coven-{hook}-substitute"));
            let rename = fs::rename(&coven, &saved_coven);
            if rename.is_ok() {
                fs::rename(&saved_coven, &coven)
                    .expect("unexpectedly movable parent must be restored");
            }
            assert!(
                rename.is_err(),
                "{hook} must retain non-delete-sharing handles for every parent"
            );
            release_hook(&hook_directory, hook);
            assert_eq!(
                rpc.receive()["ok"],
                true,
                "{hook} operation must complete under the pinned chain"
            );
            rpc.shutdown();
        }
    }
}

#[test]
fn subprocess_rejects_unknown_native_provider_preset_without_falling_back() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_phase1-native-rpc"))
        .env(NATIVE_PROVIDER_PRESET_ENV, "not-a-supported-preset")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("phase1-native-rpc must start");
    drop(child.stdin.take().expect("child stdin must be piped"));

    let output = child
        .wait_with_output()
        .expect("phase1-native-rpc must exit on invalid configuration");
    assert!(output.status.success());
    let stdout = String::from_utf8(output.stdout).expect("stdout must be UTF-8");
    assert_eq!(
        stdout
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).expect("response must be JSON"))
            .collect::<Vec<_>>(),
        vec![json!({
            "id": "invalid-request",
            "ok": false,
            "error": {"code": "invalid_native_input", "retryable": false}
        })]
    );
    assert!(String::from_utf8(output.stderr)
        .expect("stderr must be UTF-8")
        .is_empty());
}

#[test]
fn internal_coven_probe_failure_exits_silently_before_rpc_startup() {
    let output = Command::new(env!("CARGO_BIN_EXE_phase1-native-rpc"))
        .arg("--opencoven-internal-coven-health-probe-v1")
        .env("COVEN_HOME", "")
        .output()
        .expect("phase1-native-rpc probe child must exit");

    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(output.stderr.is_empty());
}

#[test]
fn subprocess_exits_nonzero_when_its_response_stream_is_closed() {
    let mut child = Command::new(env!("CARGO_BIN_EXE_phase1-native-rpc"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("phase1-native-rpc must start");
    drop(child.stdout.take().expect("child stdout must be piped"));
    {
        let mut stdin = child.stdin.take().expect("child stdin must be piped");
        writeln!(
            stdin,
            r#"{{"id":"installation","command":"app_installation_id"}}"#
        )
        .expect("installation request must be written");
    }

    let output = child
        .wait_with_output()
        .expect("phase1-native-rpc must exit after its response stream closes");
    assert!(!output.status.success());
    assert_eq!(
        String::from_utf8(output.stderr).expect("stderr must be UTF-8"),
        "phase1-native-rpc failed\n"
    );
}

#[cfg(target_os = "macos")]
#[test]
fn subprocess_prepare_broken_pipe_removes_real_isolated_keychain_marker() {
    use std::fs;

    if std::env::var("OPENCOVEN_PHASE1_TEST_KEYCHAIN_ISOLATED").as_deref() != Ok("1") {
        eprintln!("skipped: isolated Phase 1 keychain is not configured");
        return;
    }
    let keychain =
        std::env::var("PHASE1_TEST_KEYCHAIN").expect("isolated keychain path must be configured");
    let root = std::path::PathBuf::from(
        std::env::var_os("CARGO_TARGET_DIR")
            .expect("isolated Cargo target root must be configured"),
    )
    .join("phase1-native-rpc-tests")
    .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&root).expect("test root must be created");
    struct RootCleanup(std::path::PathBuf);
    impl Drop for RootCleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _root_cleanup = RootCleanup(root.clone());
    let lock_root = root.join("credential-lock");
    let result_path = root.join("reservation.json");

    {
        let mut child = Command::new(env!("CARGO_BIN_EXE_phase1-native-rpc"))
            .arg("--opencoven-internal-test-reservation-output-v1")
            .env(NATIVE_PROVIDER_PRESET_ENV, "production-keyring")
            .env("OPENCOVEN_PHASE1_TEST_KEYCHAIN_ISOLATED", "1")
            .env("OPENCOVEN_PHASE1_CONFORMANCE_LOCK_ROOT", &lock_root)
            .env(
                "OPENCOVEN_PHASE1_TEST_RESERVATION_RESULT_PATH",
                &result_path,
            )
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("phase1-native-rpc test mode must start");
        drop(child.stdout.take().expect("child stdout must be piped"));
        let output = child
            .wait_with_output()
            .expect("broken-output native RPC must exit");
        assert!(!output.status.success());
        assert_eq!(
            String::from_utf8(output.stderr).expect("stderr must be UTF-8"),
            "phase1-native-rpc failed\n"
        );

        let reservation: Value = serde_json::from_slice(
            &fs::read(&result_path).expect("reservation control record must exist"),
        )
        .expect("reservation control record must be JSON");
        let handle = reservation["reservationHandle"]
            .as_str()
            .expect("reservation handle must be recorded");
        let capability = reservation["capability"]
            .as_str()
            .expect("reservation capability must be recorded");
        let owner_token = reservation["ownerToken"]
            .as_str()
            .expect("reservation owner token must be recorded");
        let instance_id = reservation["instanceId"]
            .as_str()
            .expect("instance ID must be recorded");

        let marker_account = cleanup_reservation_account(handle);
        assert!(!keychain_contains(
            &keychain,
            "ai.opencoven.chat.conformance-cleanup",
            Some(&marker_account)
        ));
        let target_account = format!("cave-client-v1:{instance_id}");
        let target_status = Command::new("/usr/bin/security")
            .args([
                "find-generic-password",
                "-s",
                "ai.opencoven.chat",
                "-a",
                &target_account,
                &keychain,
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("target status probe must run");
        assert!(!target_status.success(), "target credential must be absent");

        let mut replay = Command::new(env!("CARGO_BIN_EXE_phase1-native-rpc"))
            .env(NATIVE_PROVIDER_PRESET_ENV, "production-keyring")
            .env("OPENCOVEN_PHASE1_CONFORMANCE_LOCK_ROOT", &lock_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("fresh cleanup RPC must start");
        let mut replay_stdin = replay.stdin.take().expect("cleanup stdin must be piped");
        writeln!(
            replay_stdin,
            "{}",
            json!({
                "id":"replay",
                "command":"conformance_delete_native_credential",
                "args":{"reservationHandle":handle,"capability":capability,"ownerToken":owner_token}
            })
        )
        .expect("replay cleanup request must be written");
        writeln!(
            replay_stdin,
            "{}",
            json!({"id":"shutdown","command":"conformance_shutdown"})
        )
        .expect("shutdown request must be written");
        drop(replay_stdin);
        let replay_output = replay.wait_with_output().expect("cleanup RPC must exit");
        assert!(replay_output.status.success());
        let responses = String::from_utf8(replay_output.stdout)
            .expect("cleanup stdout must be UTF-8")
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).expect("response must be JSON"))
            .collect::<Vec<_>>();
        assert_eq!(responses[0]["error"]["code"], "credential_missing");
        assert_eq!(responses[1]["result"]["status"], "shutting_down");
    }
}

#[cfg(target_os = "macos")]
#[test]
fn subprocess_stdin_eof_removes_real_isolated_keychain_credential_and_marker() {
    use std::fs;

    if std::env::var("OPENCOVEN_PHASE1_TEST_KEYCHAIN_ISOLATED").as_deref() != Ok("1") {
        eprintln!("skipped: isolated Phase 1 keychain is not configured");
        return;
    }
    let keychain =
        std::env::var("PHASE1_TEST_KEYCHAIN").expect("isolated keychain path must be configured");
    let root = std::path::PathBuf::from(
        std::env::var_os("CARGO_TARGET_DIR")
            .expect("isolated Cargo target root must be configured"),
    )
    .join("phase1-native-rpc-tests")
    .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&root).expect("test root must be created");
    struct RootCleanup(std::path::PathBuf);
    impl Drop for RootCleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _root_cleanup = RootCleanup(root.clone());
    let lock_root = root.join("credential-lock");
    let result_path = root.join("reservation.json");

    let mut child = Command::new(env!("CARGO_BIN_EXE_phase1-native-rpc"))
        .arg("--opencoven-internal-test-reservation-eof-v1")
        .env(NATIVE_PROVIDER_PRESET_ENV, "production-keyring")
        .env("OPENCOVEN_PHASE1_TEST_KEYCHAIN_ISOLATED", "1")
        .env("OPENCOVEN_PHASE1_CONFORMANCE_LOCK_ROOT", &lock_root)
        .env(
            "OPENCOVEN_PHASE1_TEST_RESERVATION_RESULT_PATH",
            &result_path,
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("phase1-native-rpc EOF test mode must start");
    let stdin = child.stdin.take().expect("child stdin must be piped");
    let mut stdout = BufReader::new(child.stdout.take().expect("child stdout must be piped"));
    let mut response = String::new();
    stdout
        .read_line(&mut response)
        .expect("reservation response must be delivered");
    assert_eq!(
        serde_json::from_str::<Value>(&response).expect("reservation response must be JSON")["ok"],
        true
    );
    drop(stdin);
    let output = child
        .wait_with_output()
        .expect("native RPC must exit after stdin EOF");
    assert!(output.status.success());
    assert!(String::from_utf8(output.stderr)
        .expect("stderr must be UTF-8")
        .is_empty());

    let reservation: Value = serde_json::from_slice(
        &fs::read(&result_path).expect("reservation control record must exist"),
    )
    .expect("reservation control record must be JSON");
    let handle = reservation["reservationHandle"]
        .as_str()
        .expect("reservation handle must be recorded");
    let capability = reservation["capability"]
        .as_str()
        .expect("reservation capability must be recorded");
    let owner_token = reservation["ownerToken"]
        .as_str()
        .expect("reservation owner token must be recorded");
    let instance_id = reservation["instanceId"]
        .as_str()
        .expect("instance ID must be recorded");

    let marker_account = cleanup_reservation_account(handle);
    for (service, account) in [
        (
            "ai.opencoven.chat.conformance-cleanup",
            Some(marker_account),
        ),
        (
            "ai.opencoven.chat",
            Some(format!("cave-client-v1:{instance_id}")),
        ),
    ] {
        let mut probe = Command::new("/usr/bin/security");
        probe.args(["find-generic-password", "-s", service]);
        if let Some(account) = account.as_deref() {
            probe.args(["-a", account]);
        }
        let status = probe
            .arg(&keychain)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("keychain status probe must run");
        assert!(!status.success(), "credential namespace must be empty");
    }

    let mut replay = Command::new(env!("CARGO_BIN_EXE_phase1-native-rpc"))
        .env(NATIVE_PROVIDER_PRESET_ENV, "production-keyring")
        .env("OPENCOVEN_PHASE1_CONFORMANCE_LOCK_ROOT", &lock_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("fresh cleanup RPC must start");
    {
        let mut replay_stdin = replay.stdin.take().expect("cleanup stdin must be piped");
        writeln!(
            replay_stdin,
            "{}",
            json!({
                "id":"replay",
                "command":"conformance_delete_native_credential",
                "args":{"reservationHandle":handle,"capability":capability,"ownerToken":owner_token}
            })
        )
        .expect("replay cleanup request must be written");
        writeln!(
            replay_stdin,
            "{}",
            json!({"id":"shutdown","command":"conformance_shutdown"})
        )
        .expect("shutdown request must be written");
    }
    let replay_output = replay.wait_with_output().expect("cleanup RPC must exit");
    assert!(replay_output.status.success());
    let replay_response = String::from_utf8(replay_output.stdout)
        .expect("cleanup stdout must be UTF-8")
        .lines()
        .next()
        .map(|line| serde_json::from_str::<Value>(line).expect("response must be JSON"))
        .expect("cleanup response must exist");
    assert_eq!(replay_response["error"]["code"], "credential_missing");
}

#[cfg(target_os = "macos")]
#[test]
fn subprocess_reservation_handoff_preserves_then_deletes_exact_credential() {
    use std::{
        fs,
        sync::{Arc, Barrier},
        thread,
        time::Duration,
    };

    if std::env::var("OPENCOVEN_PHASE1_TEST_KEYCHAIN_ISOLATED").as_deref() != Ok("1") {
        eprintln!("skipped: isolated Phase 1 keychain is not configured");
        return;
    }
    let keychain =
        std::env::var("PHASE1_TEST_KEYCHAIN").expect("isolated keychain path must be configured");
    let root = std::path::PathBuf::from(
        std::env::var_os("CARGO_TARGET_DIR")
            .expect("isolated Cargo target root must be configured"),
    )
    .join("phase1-native-rpc-tests")
    .join(uuid::Uuid::new_v4().to_string());
    fs::create_dir_all(&root).expect("test root must be created");
    struct RootCleanup(std::path::PathBuf);
    impl Drop for RootCleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _root_cleanup = RootCleanup(root.clone());
    let lock_root = root.join("credential-lock");
    let result_path = root.join("reservation.json");

    let mut predecessor = Command::new(env!("CARGO_BIN_EXE_phase1-native-rpc"))
        .arg("--opencoven-internal-test-reservation-eof-v1")
        .env(NATIVE_PROVIDER_PRESET_ENV, "production-keyring")
        .env("OPENCOVEN_PHASE1_TEST_KEYCHAIN_ISOLATED", "1")
        .env("OPENCOVEN_PHASE1_CONFORMANCE_LOCK_ROOT", &lock_root)
        .env(
            "OPENCOVEN_PHASE1_TEST_RESERVATION_RESULT_PATH",
            &result_path,
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("predecessor RPC must start");
    let predecessor_stdin = predecessor.stdin.take().expect("predecessor stdin");
    let mut predecessor_stdout =
        BufReader::new(predecessor.stdout.take().expect("predecessor stdout"));
    let mut prepared_line = String::new();
    predecessor_stdout
        .read_line(&mut prepared_line)
        .expect("prepare response must read");
    assert_eq!(
        serde_json::from_str::<Value>(&prepared_line).expect("prepare response JSON")["ok"],
        true
    );
    let reservation: Value = serde_json::from_slice(
        &fs::read(&result_path).expect("reservation control record must exist"),
    )
    .expect("reservation control record must be JSON");
    let handle = reservation["reservationHandle"].as_str().unwrap();
    let capability = reservation["capability"].as_str().unwrap();
    let predecessor_owner = reservation["ownerToken"].as_str().unwrap();
    let account = format!(
        "cave-client-v1:{}",
        reservation["instanceId"].as_str().unwrap()
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while !keychain_contains(&keychain, "ai.opencoven.chat", Some(&account)) {
        assert!(
            std::time::Instant::now() < deadline,
            "predecessor credential must be stored"
        );
        thread::sleep(Duration::from_millis(10));
    }

    let mut successor = Command::new(env!("CARGO_BIN_EXE_phase1-native-rpc"))
        .env(NATIVE_PROVIDER_PRESET_ENV, "production-keyring")
        .env("OPENCOVEN_PHASE1_CONFORMANCE_LOCK_ROOT", &lock_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("successor RPC must start");
    let mut successor_stdin = successor.stdin.take().expect("successor stdin");
    let mut successor_stdout = BufReader::new(successor.stdout.take().expect("successor stdout"));
    let mut contender = Command::new(env!("CARGO_BIN_EXE_phase1-native-rpc"))
        .env(NATIVE_PROVIDER_PRESET_ENV, "production-keyring")
        .env("OPENCOVEN_PHASE1_CONFORMANCE_LOCK_ROOT", &lock_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("contender RPC must start");
    let mut contender_stdin = contender.stdin.take().expect("contender stdin");
    let mut contender_stdout = BufReader::new(contender.stdout.take().expect("contender stdout"));
    let barrier = Arc::new(Barrier::new(3));
    let first_successor_owner = uuid::Uuid::new_v4().to_string();
    let second_successor_owner = uuid::Uuid::new_v4().to_string();
    let first_request = json!({
      "id":"adopt",
      "command":"conformance_begin_adopt_native_cleanup",
      "args":{
          "reservationHandle":handle,
          "capability":capability,
          "ownerToken":predecessor_owner,
          "successorOwnerToken":first_successor_owner
      }
    });
    let second_request = json!({
    "id":"adopt",
    "command":"conformance_begin_adopt_native_cleanup",
    "args":{
        "reservationHandle":handle,
        "capability":capability,
        "ownerToken":predecessor_owner,
        "successorOwnerToken":second_successor_owner
    }
    });
    let (mut adopted, mut stale_adoption) = thread::scope(|scope| {
        let first_barrier = Arc::clone(&barrier);
        let first_stdin = &mut successor_stdin;
        let first_stdout = &mut successor_stdout;
        let first = scope.spawn(move || {
            first_barrier.wait();
            rpc_request(first_stdin, first_stdout, first_request)
        });
        let second_barrier = Arc::clone(&barrier);
        let second_stdin = &mut contender_stdin;
        let second_stdout = &mut contender_stdout;
        let second = scope.spawn(move || {
            second_barrier.wait();
            rpc_request(second_stdin, second_stdout, second_request)
        });
        barrier.wait();
        (first.join().unwrap(), second.join().unwrap())
    });
    if adopted["ok"] != true {
        std::mem::swap(&mut successor, &mut contender);
        std::mem::swap(&mut successor_stdin, &mut contender_stdin);
        std::mem::swap(&mut successor_stdout, &mut contender_stdout);
        std::mem::swap(&mut adopted, &mut stale_adoption);
    }
    assert_eq!(adopted["ok"], true);
    assert_eq!(stale_adoption["error"]["code"], "keychain_failure");
    let successor_owner = adopted["result"]["ownerToken"]
        .as_str()
        .expect("successor owner token")
        .to_owned();
    assert_ne!(successor_owner, predecessor_owner);
    let commit_request = json!({
        "id":"commit",
        "command":"conformance_commit_adopt_native_cleanup",
        "args":{
            "reservationHandle":handle,
            "capability":capability,
            "ownerToken":predecessor_owner,
            "successorOwnerToken":successor_owner
        }
    });
    for _ in 0..2 {
        let committed = rpc_request(
            &mut successor_stdin,
            &mut successor_stdout,
            commit_request.clone(),
        );
        assert_eq!(committed["result"]["status"], "committed");
        assert_eq!(committed["result"]["ownerToken"], successor_owner);
    }
    let stale_cleanup = rpc_request(
        &mut contender_stdin,
        &mut contender_stdout,
        json!({
            "id":"stale-cleanup",
            "command":"conformance_delete_native_credential",
            "args":{
                "reservationHandle":handle,
                "capability":capability,
                "ownerToken":predecessor_owner
            }
        }),
    );
    assert_eq!(stale_cleanup["error"]["code"], "stale_cleanup_owner");
    let _ = rpc_request(
        &mut contender_stdin,
        &mut contender_stdout,
        json!({"id":"shutdown","command":"conformance_shutdown"}),
    );
    drop(contender_stdin);
    assert!(contender.wait().expect("contender exit").success());

    drop(predecessor_stdin);
    assert!(predecessor.wait().expect("predecessor exit").success());
    assert!(
        keychain_contains(&keychain, "ai.opencoven.chat", Some(&account)),
        "credential must survive stale predecessor cleanup"
    );

    drop(successor_stdin);
    assert!(successor.wait().expect("successor exit").success());
    assert!(!keychain_contains(
        &keychain,
        "ai.opencoven.chat",
        Some(&account)
    ));
    assert!(!keychain_contains(
        &keychain,
        "ai.opencoven.chat.conformance-cleanup",
        Some(&cleanup_reservation_account(handle))
    ));

    let mut replay = Command::new(env!("CARGO_BIN_EXE_phase1-native-rpc"))
        .env(NATIVE_PROVIDER_PRESET_ENV, "production-keyring")
        .env("OPENCOVEN_PHASE1_CONFORMANCE_LOCK_ROOT", &lock_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("replay RPC must start");
    let mut replay_stdin = replay.stdin.take().expect("replay stdin");
    let mut replay_stdout = BufReader::new(replay.stdout.take().expect("replay stdout"));
    let replay_result = rpc_request(
        &mut replay_stdin,
        &mut replay_stdout,
        json!({
            "id":"replay",
            "command":"conformance_delete_native_credential",
            "args":{
                "reservationHandle":handle,
                "capability":capability,
                "ownerToken":successor_owner
            }
        }),
    );
    assert_eq!(replay_result["error"]["code"], "credential_missing");
    let _ = rpc_request(
        &mut replay_stdin,
        &mut replay_stdout,
        json!({"id":"shutdown","command":"conformance_shutdown"}),
    );
    drop(replay_stdin);
    assert!(replay.wait().expect("replay exit").success());
}

#[cfg(target_os = "macos")]
#[test]
fn subprocess_recovers_both_adoption_commit_crash_windows() {
    use std::{ffi::CString, fs, io::Read, sync::mpsc, thread, time::Duration};

    if std::env::var("OPENCOVEN_PHASE1_TEST_KEYCHAIN_ISOLATED").as_deref() != Ok("1") {
        eprintln!("skipped: isolated Phase 1 keychain is not configured");
        return;
    }
    let keychain =
        std::env::var("PHASE1_TEST_KEYCHAIN").expect("isolated keychain path must be configured");
    let cargo_target = std::path::PathBuf::from(
        std::env::var_os("CARGO_TARGET_DIR")
            .expect("isolated Cargo target root must be configured"),
    );
    let target_root = cargo_target.join("phase1-native-rpc-tests");

    for phase in ["before-commit", "after-commit"] {
        let root = target_root.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let result_path = root.join("reservation.json");
        let lock_root = root.join("credential-lock");
        let mut predecessor = Command::new(env!("CARGO_BIN_EXE_phase1-native-rpc"))
            .arg("--opencoven-internal-test-reservation-eof-v1")
            .env(NATIVE_PROVIDER_PRESET_ENV, "production-keyring")
            .env("OPENCOVEN_PHASE1_TEST_KEYCHAIN_ISOLATED", "1")
            .env(
                "OPENCOVEN_PHASE1_TEST_RESERVATION_RESULT_PATH",
                &result_path,
            )
            .env("OPENCOVEN_PHASE1_CONFORMANCE_LOCK_ROOT", &lock_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let predecessor_stdin = predecessor.stdin.take().unwrap();
        let mut predecessor_stdout = BufReader::new(predecessor.stdout.take().unwrap());
        let mut line = String::new();
        predecessor_stdout.read_line(&mut line).unwrap();
        let reservation: Value = serde_json::from_slice(&fs::read(&result_path).unwrap()).unwrap();
        let handle = reservation["reservationHandle"]
            .as_str()
            .unwrap()
            .to_owned();
        let capability = reservation["capability"].as_str().unwrap().to_owned();
        let predecessor_owner = reservation["ownerToken"].as_str().unwrap().to_owned();
        let successor_owner = uuid::Uuid::new_v4().to_string();
        let account = format!(
            "cave-client-v1:{}",
            reservation["instanceId"].as_str().unwrap()
        );

        let ready = root.join(format!("{phase}.ready"));
        let gate = root.join(format!("{phase}.gate"));
        for fifo in [&ready, &gate] {
            let path = CString::new(fifo.to_str().unwrap()).unwrap();
            assert_eq!(unsafe { libc::mkfifo(path.as_ptr(), 0o600) }, 0);
        }
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let ready_thread = thread::spawn(move || {
            let mut file = fs::File::open(ready).unwrap();
            let mut bytes = [0_u8; 6];
            file.read_exact(&mut bytes).unwrap();
            ready_tx.send(()).unwrap();
        });

        let mut successor = Command::new(env!("CARGO_BIN_EXE_phase1-native-rpc"))
            .env(NATIVE_PROVIDER_PRESET_ENV, "production-keyring")
            .env("OPENCOVEN_PHASE1_TEST_KEYCHAIN_ISOLATED", "1")
            .env("OPENCOVEN_PHASE1_TEST_ADOPTION_BARRIER", phase)
            .env("OPENCOVEN_PHASE1_TEST_ADOPTION_BARRIER_ROOT", &root)
            .env("OPENCOVEN_PHASE1_CONFORMANCE_LOCK_ROOT", &lock_root)
            .env("CARGO_TARGET_DIR", &cargo_target)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut successor_stdin = successor.stdin.take().unwrap();
        let mut successor_stdout = BufReader::new(successor.stdout.take().unwrap());
        let args = json!({
            "reservationHandle":handle,
            "capability":capability,
            "ownerToken":predecessor_owner,
            "successorOwnerToken":successor_owner
        });
        assert_eq!(
            rpc_request(
                &mut successor_stdin,
                &mut successor_stdout,
                json!({"id":"begin","command":"conformance_begin_adopt_native_cleanup","args":args.clone()})
            )["ok"],
            true
        );
        serde_json::to_writer(
            &mut successor_stdin,
            &json!({"id":"commit","command":"conformance_commit_adopt_native_cleanup","args":args}),
        )
        .unwrap();
        successor_stdin.write_all(b"\n").unwrap();
        successor_stdin.flush().unwrap();
        ready_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        ready_thread.join().unwrap();
        successor.kill().unwrap();
        successor.wait().unwrap();

        let mut recovery = Command::new(env!("CARGO_BIN_EXE_phase1-native-rpc"))
            .env(NATIVE_PROVIDER_PRESET_ENV, "production-keyring")
            .env("OPENCOVEN_PHASE1_CONFORMANCE_LOCK_ROOT", &lock_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut recovery_stdin = recovery.stdin.take().unwrap();
        let mut recovery_stdout = BufReader::new(recovery.stdout.take().unwrap());
        let mut deleted = false;
        for owner in [&successor_owner, &predecessor_owner] {
            let response = rpc_request(
                &mut recovery_stdin,
                &mut recovery_stdout,
                json!({
                    "id":"cleanup",
                    "command":"conformance_delete_native_credential",
                    "args":{
                        "reservationHandle":handle,
                        "capability":capability,
                        "ownerToken":owner
                    }
                }),
            );
            if response["ok"] == true {
                deleted = true;
                break;
            }
        }
        assert!(deleted, "one retained owner token must delete");
        let _ = rpc_request(
            &mut recovery_stdin,
            &mut recovery_stdout,
            json!({"id":"shutdown","command":"conformance_shutdown"}),
        );
        drop(recovery_stdin);
        assert!(recovery.wait().unwrap().success());
        drop(predecessor_stdin);
        let _ = predecessor.wait();
        assert!(!keychain_contains(
            &keychain,
            "ai.opencoven.chat",
            Some(&account)
        ));
        assert!(!keychain_contains(
            &keychain,
            "ai.opencoven.chat.conformance-cleanup",
            Some(&cleanup_reservation_account(&handle))
        ));
        fs::remove_dir_all(root).unwrap();
    }
}

#[test]
fn subprocess_protocol_drains_oversized_input_redacts_it_and_shuts_down_cleanly() {
    let canary = "subprocess-input-canary-must-not-escape";
    let mut child = Command::new(env!("CARGO_BIN_EXE_phase1-native-rpc"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("phase1-native-rpc must start");

    let mut oversized = canary.repeat((MAX_LINE_BYTES / canary.len()) + 1);
    oversized.truncate(MAX_LINE_BYTES + 1);
    {
        let mut stdin = child.stdin.take().expect("child stdin must be piped");
        writeln!(stdin, "{oversized}").expect("oversized request must be written");
        writeln!(
            stdin,
            r#"{{"id":"installation","command":"app_installation_id"}}"#
        )
        .expect("installation request must be written");
        writeln!(
            stdin,
            r#"{{"id":"shutdown","command":"conformance_shutdown"}}"#
        )
        .expect("shutdown request must be written");
    }

    let output = child
        .wait_with_output()
        .expect("phase1-native-rpc must exit after shutdown");
    assert!(output.status.success());

    let stdout = String::from_utf8(output.stdout).expect("stdout must be UTF-8 JSON");
    let stderr = String::from_utf8(output.stderr).expect("stderr must be UTF-8");
    assert!(!stdout.contains(canary));
    assert!(!stderr.contains(canary));

    let responses = stdout
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("each line must be JSON"))
        .collect::<Vec<_>>();
    assert_eq!(
        responses,
        vec![
            json!({
                "id": "invalid-request",
                "ok": false,
                "error": {"code": "invalid_request", "retryable": false}
            }),
            json!({
                "id": "installation",
                "ok": true,
                "result": INSTALLATION_ID
            }),
            json!({
                "id": "shutdown",
                "ok": true,
                "result": {"status": "shutting_down"}
            }),
        ]
    );
}

#[cfg(unix)]
#[test]
fn subprocess_reset_and_shutdown_terminate_each_launched_cave_child() {
    use std::{
        fs,
        os::unix::fs::PermissionsExt,
        path::PathBuf,
        thread,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    struct ExactProcessCleanup(Vec<i32>);

    impl ExactProcessCleanup {
        fn forget_exited(&mut self, pid: i32) {
            self.0.retain(|tracked| *tracked != pid);
        }
    }

    impl Drop for ExactProcessCleanup {
        fn drop(&mut self) {
            for pid in self.0.iter().copied() {
                unsafe {
                    libc::kill(pid, libc::SIGKILL);
                }
            }
        }
    }

    struct ExactRootCleanup(PathBuf);

    impl Drop for ExactRootCleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn process_is_alive(pid: i32) -> bool {
        let result = unsafe { libc::kill(pid, 0) };
        result == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    fn wait_for_pid(path: &std::path::Path, previous: Option<i32>) -> i32 {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if let Ok(pid) = fs::read_to_string(path)
                .and_then(|value| value.trim().parse::<i32>().map_err(std::io::Error::other))
            {
                if Some(pid) != previous && process_is_alive(pid) {
                    return pid;
                }
            }
            assert!(
                Instant::now() < deadline,
                "launched Cave fixture must publish its live pid"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn wait_for_exit(pid: i32) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while process_is_alive(pid) {
            assert!(
                Instant::now() < deadline,
                "managed Cave child {pid} must be terminated and reaped"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn request(stdin: &mut ChildStdin, stdout: &mut BufReader<ChildStdout>, value: Value) -> Value {
        serde_json::to_writer(&mut *stdin, &value).expect("request must serialize");
        stdin
            .write_all(b"\n")
            .expect("request delimiter must write");
        stdin.flush().expect("request must flush");
        let mut line = String::new();
        stdout
            .read_line(&mut line)
            .expect("response line must be readable");
        serde_json::from_str(&line).expect("response must be JSON")
    }

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock must follow Unix epoch")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "opencoven-phase1-native-rpc-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir(&root).expect("isolated Cave root must be created");
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
        .expect("isolated Cave root must be private");
    let root = fs::canonicalize(root).expect("isolated Cave root must be canonical");
    let _root_cleanup = ExactRootCleanup(root.clone());
    let server_path = root.join("fixture-server.mjs");
    let pid_path = root.join("fixture.pid");
    fs::write(
        &server_path,
        r#"
import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:http';

const root = process.env.COVEN_CAVE_HOME;
const server = createServer((request, response) => {
  if (request.url === '/api/client/v1/health') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      apiVersion: '1.0',
      minimumClientVersion: '0.1.0',
      capabilities: ['health', 'pairing', 'credentials', 'familiars', 'projects', 'conversations', 'conversation-messages', 'cursors'],
      operations: ['health.read', 'pairing.create', 'pairing.poll', 'pairing.exchange', 'pairing.admin.list', 'pairing.admin.decide', 'credentials.admin.list', 'credentials.admin.revoke', 'familiars.list', 'projects.list', 'conversations.list', 'conversations.read', 'messages.list'],
      data: {
        instanceId: '00000000-0000-4000-8000-000000000000',
        pairingRequired: true,
        releaseVersion: '0.1.0',
      },
    }));
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end('{"error":"not_found"}');
});
server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const discovery = join(root, 'client-v1-discovery.json');
  writeFileSync(discovery, JSON.stringify({
    version: 2,
    endpoint: `http://127.0.0.1:${address.port}`,
    pid: process.pid,
    nonce: 'gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp8',
    startedAt: new Date().toISOString(),
    authority: {
      mechanism: 'hpke-bound-v1',
      mode: 'enforce',
      keyId: 'Tq04GMSX5BPPPijzO9pHfQ1lAnna_RQKzL1ncDGl-4g',
      publicKey: 'sfG4QN56MkGwJ0jPmwW3TcjF6EUSmHOIF712qo6-jCs',
      suite: {
        kemId: 32,
        kdfId: 1,
        aeadId: 2,
      },
    },
  }), { mode: 0o600 });
  chmodSync(discovery, 0o600);
  writeFileSync(join(root, 'fixture.pid'), String(process.pid), { mode: 0o600 });
});
"#,
    )
    .expect("fixture server must be written");
    let node_output = Command::new("node")
        .args(["-p", "process.execPath"])
        .output()
        .expect("Node must be available for the native conformance test");
    assert!(node_output.status.success());
    let node_path = fs::canonicalize(
        String::from_utf8(node_output.stdout)
            .expect("Node path must be UTF-8")
            .trim(),
    )
    .expect("Node path must be canonical");

    let mut child = Command::new(env!("CARGO_BIN_EXE_phase1-native-rpc"))
        .env("COVEN_CAVE_HOME", &root)
        .env("OPENCOVEN_PHASE1_CONFORMANCE_NODE_PATH", node_path)
        .env(
            "OPENCOVEN_PHASE1_CONFORMANCE_CAVE_SERVER_PATH",
            &server_path,
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("phase1-native-rpc must start");
    let mut stdin = child.stdin.take().expect("child stdin must be piped");
    let mut stdout = BufReader::new(child.stdout.take().expect("child stdout must be piped"));
    let mut cleanup = ExactProcessCleanup(Vec::new());

    assert_eq!(
        request(
            &mut stdin,
            &mut stdout,
            json!({"id":"launch-one","command":"cave_launch"})
        ),
        json!({"id":"launch-one","ok":true,"result":null})
    );
    let first_pid = wait_for_pid(&pid_path, None);
    cleanup.0.push(first_pid);

    assert_eq!(
        request(
            &mut stdin,
            &mut stdout,
            json!({"id":"reset","command":"conformance_reset_native_state"})
        ),
        json!({"id":"reset","ok":true,"result":{"status":"reset"}})
    );
    wait_for_exit(first_pid);
    cleanup.forget_exited(first_pid);

    assert_eq!(
        request(
            &mut stdin,
            &mut stdout,
            json!({"id":"launch-two","command":"cave_launch"})
        ),
        json!({"id":"launch-two","ok":true,"result":null})
    );
    let second_pid = wait_for_pid(&pid_path, Some(first_pid));
    cleanup.0.push(second_pid);

    assert_eq!(
        request(
            &mut stdin,
            &mut stdout,
            json!({"id":"shutdown","command":"conformance_shutdown"})
        ),
        json!({
            "id":"shutdown",
            "ok":true,
            "result":{"status":"shutting_down"}
        })
    );
    drop(stdin);
    let output = child
        .wait_with_output()
        .expect("phase1-native-rpc must exit after shutdown");
    assert!(
        output.status.success(),
        "native RPC stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    wait_for_exit(second_pid);
    cleanup.forget_exited(second_pid);
}

#[cfg(unix)]
#[test]
fn subprocess_cancels_inflight_health_by_opaque_attempt_id() {
    use std::{
        collections::HashMap,
        fs,
        net::TcpListener,
        os::unix::fs::PermissionsExt,
        path::PathBuf,
        sync::mpsc,
        thread,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    struct ExactRootCleanup(PathBuf);

    impl Drop for ExactRootCleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn send(stdin: &mut ChildStdin, value: Value) {
        serde_json::to_writer(&mut *stdin, &value).expect("request must serialize");
        stdin
            .write_all(b"\n")
            .expect("request delimiter must write");
        stdin.flush().expect("request must flush");
    }

    fn receive(stdout: &mut BufReader<ChildStdout>) -> Value {
        let mut line = String::new();
        stdout
            .read_line(&mut line)
            .expect("response line must be readable");
        serde_json::from_str(&line).expect("response must be JSON")
    }

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("clock must follow Unix epoch")
        .as_nanos();
    let root = std::env::temp_dir().join(format!(
        "opencoven-phase1-native-rpc-cancel-{}-{nonce}",
        std::process::id()
    ));
    fs::create_dir(&root).expect("isolated Cave root must be created");
    fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
        .expect("isolated Cave root must be private");
    let root = fs::canonicalize(root).expect("isolated Cave root must be canonical");
    let _root_cleanup = ExactRootCleanup(root.clone());

    let listener = TcpListener::bind("127.0.0.1:0").expect("health listener must bind");
    let endpoint = format!(
        "http://{}",
        listener.local_addr().expect("listener address")
    );
    let discovery = root.join("client-v1-discovery.json");
    fs::write(
        &discovery,
        serde_json::to_vec(&json!({
            "version": 2,
            "endpoint": endpoint,
            "pid": std::process::id(),
            "nonce": "gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp8",
            "startedAt": "2026-08-28T04:00:00.000Z",
            "authority": {
                "mechanism": "hpke-bound-v1",
                "mode": "enforce",
                "keyId": "Tq04GMSX5BPPPijzO9pHfQ1lAnna_RQKzL1ncDGl-4g",
                "publicKey": "sfG4QN56MkGwJ0jPmwW3TcjF6EUSmHOIF712qo6-jCs",
                "suite": {
                    "kemId": 32,
                    "kdfId": 1,
                    "aeadId": 2,
                },
            },
        }))
        .expect("discovery record must serialize"),
    )
    .expect("discovery record must write");
    fs::set_permissions(&discovery, fs::Permissions::from_mode(0o600))
        .expect("discovery record must be private");

    let (accepted_tx, accepted_rx) = mpsc::sync_channel(2);
    let server = thread::spawn(move || {
        use std::io::Read as _;

        for _ in 0..2 {
            let (mut stream, _) = listener.accept().expect("health request must arrive");
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("read timeout must apply");
            let mut request = [0_u8; 16 * 1024];
            let length = stream.read(&mut request).expect("request must be readable");
            assert!(String::from_utf8_lossy(&request[..length])
                .starts_with("GET /api/client/v1/health "));
            accepted_tx.send(()).expect("acceptance must publish");
            let closed = loop {
                match stream.read(&mut request) {
                    Ok(0) => break true,
                    Ok(_) => continue,
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) =>
                    {
                        break false;
                    }
                    Err(_) => break true,
                }
            };
            assert!(closed, "bounded health request must close its socket");
        }
    });

    let mut child = Command::new(env!("CARGO_BIN_EXE_phase1-native-rpc"))
        .env("COVEN_CAVE_HOME", &root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("phase1-native-rpc must start");
    let mut stdin = child.stdin.take().expect("child stdin must be piped");
    let mut stdout = BufReader::new(child.stdout.take().expect("child stdout must be piped"));
    send(
        &mut stdin,
        json!({
            "id": "discovery",
            "command": "cave_read_discovery",
            "args": {
                "operation": {
                    "attemptId": "op1-1787900000000-1-00000000000000000000000000000000",
                    "timeoutMs": 1_000,
                },
            },
        }),
    );
    let discovery_response = receive(&mut stdout);
    let handle = discovery_response["result"]["handle"]
        .as_str()
        .expect("discovery handle must be returned")
        .to_owned();

    send(
        &mut stdin,
        json!({
            "id": "health",
            "command": "cave_health",
            "args": {
                "handle": handle,
                "operation": {
                    "attemptId": "op1-1787900000000-2-11111111111111111111111111111111",
                    "timeoutMs": 2_000,
                },
            },
        }),
    );
    accepted_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("health request must start");
    send(
        &mut stdin,
        json!({
            "id": "cancel",
            "command": "cave_cancel_operation",
            "args": {
                "attemptId": "op1-1787900000000-2-11111111111111111111111111111111",
                "reason": "aborted",
            },
        }),
    );

    let responses = [receive(&mut stdout), receive(&mut stdout)]
        .into_iter()
        .map(|response| {
            (
                response["id"].as_str().expect("response id").to_owned(),
                response,
            )
        })
        .collect::<HashMap<_, _>>();
    assert_eq!(
        responses["health"]["error"],
        json!({ "code": "aborted", "retryable": false })
    );
    assert_eq!(
        responses["cancel"]["result"],
        json!({ "status": "cancelled" })
    );
    send(
        &mut stdin,
        json!({
            "id": "stale",
            "command": "cave_cancel_operation",
            "args": {
                "attemptId": "op1-1787900000000-2-11111111111111111111111111111111",
                "reason": "timeout",
            },
        }),
    );
    assert_eq!(
        receive(&mut stdout)["result"],
        json!({ "status": "unknown" })
    );
    send(
        &mut stdin,
        json!({
            "id": "timeout",
            "command": "cave_health",
            "args": {
                "handle": discovery_response["result"]["handle"],
                "operation": {
                    "attemptId": "op1-1787900000000-3-22222222222222222222222222222222",
                    "timeoutMs": 25,
                },
            },
        }),
    );
    accepted_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("timed health request must start");
    assert_eq!(
        receive(&mut stdout)["error"],
        json!({ "code": "timeout", "retryable": true })
    );
    server.join().expect("health server must exit");
    send(
        &mut stdin,
        json!({"id":"shutdown","command":"conformance_shutdown"}),
    );
    assert_eq!(
        receive(&mut stdout)["result"],
        json!({ "status": "shutting_down" })
    );
    drop(stdin);
    let output = child
        .wait_with_output()
        .expect("phase1-native-rpc must exit after shutdown");
    assert!(
        output.status.success(),
        "native RPC stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}
