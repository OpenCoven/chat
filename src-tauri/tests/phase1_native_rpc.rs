#![cfg(feature = "phase1-conformance")]

use std::{
    io::{BufRead, BufReader, Write},
    process::{ChildStdin, ChildStdout, Command, Stdio},
};

use serde_json::{json, Value};

const INSTALLATION_ID: &str = "4e1d02ca-833b-4d9d-8e9f-31bb8f44f9b5";
const MAX_LINE_BYTES: usize = 64 * 1024;

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
                    "attemptId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
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
                    "attemptId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
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
                "attemptId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
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
                "attemptId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
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
                    "attemptId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
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
