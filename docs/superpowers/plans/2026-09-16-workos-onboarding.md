# WorkOS Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate OpenCoven Chat behind a WorkOS AuthKit sign-in and replace the dead-end empty states with an assisted, auditable prerequisite setup, per `docs/superpowers/specs/2026-09-16-workos-onboarding-design.md`.

**Architecture:** Two new native Rust modules — `identity.rs` (PKCE, loopback callback, token exchange/refresh, offline JWT verification, keyring storage) and `setup.rs` (prerequisite detection, fixed-argv assisted install with streamed output) — exposed as seven Tauri commands that follow the shipped `coven_runtime_*` conventions (`Result<_, String>`, `run_id` cancellation, `Channel` streaming). A new `Onboarding` React surface wraps the unchanged `ChatApp` and never sees a token.

**Tech Stack:** Tauri 2.11 (Rust 1.95, pinned deps with `=`), React 19 + TypeScript, Vitest + Testing Library, Biome. New crates: `jsonwebtoken =11.1.0`; `reqwest` gains `rustls-tls`.

---

## Conventions you must follow

- **Every commit is signed:** `git commit -S …`. Verify with `git log -1 --show-signature` (must print `Good "git" signature`). Never push an unsigned commit.
- **Native errors are `String`s**, not `NativeDiagnostic`. That is the shipped `coven_runtime_*` convention; the Cave lease pattern in `operation.rs` is dormant and must not be used here.
- **No token, verifier or `state` value ever crosses IPC.** Task 22 adds a test that greps `src/**` and fails on any match.
- **`cargo` commands:** always `--manifest-path src-tauri/Cargo.toml`. CI runs `cargo test --locked --release --features phase1-conformance --lib`; run at least `cargo test --manifest-path src-tauri/Cargo.toml --lib` locally before each Rust commit, and `corepack pnpm cargo:fmt` + `corepack pnpm cargo:clippy`.
- **JS commands:** `corepack pnpm lint`, `corepack pnpm typecheck`, `corepack pnpm exec vitest run <file>`.
- Work in the worktree you were given. Do not `cd` to the primary checkout.

## File structure

| File | Responsibility | Status |
| --- | --- | --- |
| `src-tauri/Cargo.toml` | add `jsonwebtoken`, enable TLS on `reqwest` | modify |
| `src-tauri/Cargo.lock` | lockfile for the above | modify |
| `src-tauri/tauri.conf.json` | `plugins.workos.clientId` (public) | modify |
| `src-tauri/src/keyring.rs` | `workos-session-v1` record: read / write (CAS) / delete | modify (append) |
| `src-tauri/src/coven_runtime.rs` | make `register_run`, `resolve_cli`, `home`, `run_process`, `cli_json` `pub(crate)`; add `execute_command_lines` | modify |
| `src-tauri/src/identity.rs` | PKCE, listener, browser open, exchange, refresh, JWT verify, status derivation, 4 commands | create |
| `src-tauri/src/setup.rs` | detection, fixed argv, streamed install, 3 commands | create |
| `src-tauri/src/lib.rs` | `mod identity; mod setup;` + register 7 commands | modify |
| `src-tauri/capabilities/default.json` | 7 new permissions | modify |
| `src-tauri/tests/fixtures/workos-test-key.pem` `.n` `.e` | test-only RSA key for JWT tests | create |
| `src/lib/identity.ts` | JS client mirroring `coven-runtime.ts` | create |
| `src/lib/identity.test.ts` | guards + contract tests | create |
| `src/lib/setup.ts` | JS client | create |
| `src/lib/setup.test.ts` | guards + contract tests | create |
| `src/onboarding/onboarding.tsx` | state machine + UI | create |
| `src/onboarding/onboarding.css` | layout only; tokens only | create |
| `src/onboarding/onboarding.test.tsx` | every state and error row | create |
| `src/coven/chat-layout.tsx` | optional `account` in User settings | modify |
| `src/coven/chat-app.tsx` | pass `account` through | modify |
| `src/main.tsx` | render `<Onboarding>` | modify |
| `src/single-entrypoint.test.ts` | move the chat-app import assertion | modify |
| `src/ipc-boundary.test.ts` | zero token identifiers in `src/**` | create |
| `src/capabilities.test.ts` | exactly the 7 new permissions | create |
| `docs/onboarding-manual-checks.md` | live WorkOS + real `npm` checklist | create |

Tasks 1–9 are native identity, 10–13 native setup, 14–17 JS clients, 18–23 onboarding surface and guards, 24–25 config and docs. Tasks 1–9 and 10–13 are independent of each other and may be executed in parallel by two workers.

---

### Task 1: Dependencies and TLS

**Files:**
- Modify: `src-tauri/Cargo.toml:38`
- Modify: `src-tauri/Cargo.lock`

- [ ] **Step 1: Enable TLS on reqwest and add jsonwebtoken**

Change line 38 and add one line after it:

```toml
reqwest = { version = "=0.13.4", default-features = false, features = ["json", "rustls-tls"] }
jsonwebtoken = "=11.1.0"
```

- [ ] **Step 2: Update the lockfile (this is the only time `--locked` is omitted)**

Run: `cargo fetch --manifest-path src-tauri/Cargo.toml`
Expected: resolves `jsonwebtoken v11.1.0` plus rustls crates; no errors.

- [ ] **Step 3: Verify the pinned build still compiles under CI's flags**

Run: `cargo check --manifest-path src-tauri/Cargo.toml --locked --all-targets`
Expected: `Finished` with no errors.

- [ ] **Step 4: Commit**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -S -m "build(native): enable TLS on reqwest and add jsonwebtoken for WorkOS"
```

---

### Task 2: Session record in the keyring

**Files:**
- Modify: `src-tauri/src/keyring.rs` (append after line 2064, inside the `impl NativeKeyring` that starts at line 2037; constants near line 34)
- Test: same file, `mod tests` (append)

- [ ] **Step 1: Write the failing tests**

Append inside the existing `#[cfg(test)] mod tests { … }` at the end of `keyring.rs`:

```rust
    #[test]
    fn session_record_round_trips_and_is_bounded() {
        let record = StoredSession {
            access_token: "a".repeat(100),
            refresh_token: "r".repeat(100),
            expires_at: 1_800_000_000,
            checked_at: 1_799_990_000,
            subject: "user_01H".to_owned(),
            email: "val@example.com".to_owned(),
        };
        let bytes = serialize_session(&record).unwrap();
        assert!(bytes.len() <= MAX_SESSION_RECORD_BYTES);
        let parsed = parse_stored_session(&bytes).unwrap();
        assert_eq!(parsed.subject, "user_01H");
        assert_eq!(parsed.expires_at, 1_800_000_000);

        let huge = StoredSession {
            access_token: "a".repeat(5000),
            ..record
        };
        assert!(matches!(serialize_session(&huge), Err(KeyringError::Failure)));
        assert!(matches!(
            parse_stored_session(b"{not json"),
            Err(KeyringError::Failure)
        ));
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib session_record_round_trips -- --nocapture`
Expected: compile error — `StoredSession`, `serialize_session`, `parse_stored_session`, `MAX_SESSION_RECORD_BYTES` not found.

- [ ] **Step 3: Add the record type, bounds and (de)serialization**

Near line 34, after `INSTALLATION_ID_ACCOUNT`:

```rust
pub(crate) const SESSION_ACCOUNT: &str = "workos-session-v1";
const MAX_SESSION_RECORD_BYTES: usize = 4 * 1024;
```

After the `impl Drop for Credential` block (around line 240), add:

```rust
/// The WorkOS session the app holds for the signed-in person. Tokens never
/// leave native code; the webview only ever receives a derived status.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct StoredSession {
    pub(crate) access_token: String,
    pub(crate) refresh_token: String,
    /// Unix seconds; copied from the access token's `exp`.
    pub(crate) expires_at: u64,
    /// Unix seconds of the last successful exchange or refresh.
    pub(crate) checked_at: u64,
    pub(crate) subject: String,
    pub(crate) email: String,
}

impl Drop for StoredSession {
    fn drop(&mut self) {
        self.access_token.zeroize();
        self.refresh_token.zeroize();
    }
}

fn serialize_session(session: &StoredSession) -> Result<Vec<u8>, KeyringError> {
    let bytes = serde_json::to_vec(session).map_err(|_| KeyringError::Failure)?;
    if bytes.len() > MAX_SESSION_RECORD_BYTES {
        return Err(KeyringError::Failure);
    }
    Ok(bytes)
}

fn parse_stored_session(raw: &[u8]) -> Result<StoredSession, KeyringError> {
    if raw.len() > MAX_SESSION_RECORD_BYTES {
        return Err(KeyringError::Failure);
    }
    serde_json::from_slice(raw).map_err(|_| KeyringError::Failure)
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib session_record_round_trips`
Expected: `test result: ok. 1 passed`

- [ ] **Step 5: Add the keyring accessors (read / CAS write / delete)**

Inside the `impl NativeKeyring` block that begins at line 2037 (after `credential_entry_for_service`), add:

```rust
    fn session_entry(&self) -> Result<Entry, KeyringError> {
        #[cfg(feature = "phase1-conformance")]
        let service = self.service_name();
        #[cfg(not(feature = "phase1-conformance"))]
        let service = SERVICE;
        Self::entry_for(service, SESSION_ACCOUNT)
    }

    /// `Ok(None)` when no session is stored. An unreadable record is an
    /// error and is left in place so the person can decide what to do.
    pub(crate) fn read_session(&self) -> Result<Option<StoredSession>, KeyringError> {
        let entry = self.session_entry()?;
        match entry.get_secret() {
            Ok(bytes) => {
                let bytes = Zeroizing::new(bytes);
                parse_stored_session(bytes.as_slice()).map(Some)
            }
            Err(KeyringBackendError::NoEntry) => Ok(None),
            Err(error) => Err(map_keyring_error(error)),
        }
    }

    /// Compare-and-swap. `expected` is the session the caller read; if the
    /// stored bytes differ, another writer won and this call fails with
    /// `KeyringError::Failure` without writing.
    pub(crate) fn write_session(
        &self,
        expected: Option<&StoredSession>,
        next: &StoredSession,
    ) -> Result<(), KeyringError> {
        let _guard = acquire_mutation_lock()?;
        let entry = self.session_entry()?;
        let current = match entry.get_secret() {
            Ok(bytes) => Some(Zeroizing::new(bytes)),
            Err(KeyringBackendError::NoEntry) => None,
            Err(error) => return Err(map_keyring_error(error)),
        };
        let expected_bytes = expected.map(serialize_session).transpose()?;
        if current.as_deref().map(|b| b.as_slice()) != expected_bytes.as_deref() {
            return Err(KeyringError::Failure);
        }
        let bytes = Zeroizing::new(serialize_session(next)?);
        entry.set_secret(&bytes).map_err(map_keyring_error)?;
        ensure_windows_local_persistence(&entry, &bytes)
    }

    pub(crate) fn delete_session(&self) -> Result<(), KeyringError> {
        let _guard = acquire_mutation_lock()?;
        let entry = self.session_entry()?;
        match entry.delete_credential() {
            Ok(()) | Err(KeyringBackendError::NoEntry) => Ok(()),
            Err(error) => Err(map_keyring_error(error)),
        }
    }
```

- [ ] **Step 6: Build, format, lint**

Run: `corepack pnpm cargo:fmt && corepack pnpm cargo:clippy && cargo test --manifest-path src-tauri/Cargo.toml --lib keyring::`
Expected: fmt clean, clippy `Finished` with no warnings, keyring tests pass.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/keyring.rs
git commit -S -m "feat(native): store the WorkOS session as a bounded keyring record"
```

---

### Task 3: Expose runtime helpers and add a line streamer

**Files:**
- Modify: `src-tauri/src/coven_runtime.rs:43,167,201,291,352` and the `cli_json` fn after line 460
- Test: same file, `mod tests` (append)

- [ ] **Step 1: Write the failing test**

Append inside `mod tests` at the end of `coven_runtime.rs`:

```rust
    #[cfg(unix)]
    #[test]
    fn execute_command_lines_streams_stdout_and_stderr_then_exit_code() {
        let mut command = Command::new("sh");
        command.args(["-c", "echo one; echo two >&2; printf 'no-newline'; exit 3"]);
        let cancel = AtomicBool::new(false);
        let mut seen: Vec<(bool, String)> = Vec::new();
        let code = execute_command_lines(command, &cancel, Duration::from_secs(5), &mut |stderr, line| {
            seen.push((stderr, line.to_owned()));
            Ok(())
        })
        .unwrap();
        assert_eq!(code, 3);
        assert!(seen.contains(&(false, "one".to_owned())));
        assert!(seen.contains(&(true, "two".to_owned())));
        assert!(seen.contains(&(false, "no-newline".to_owned())), "trailing partial line must flush");
    }

    #[cfg(unix)]
    #[test]
    fn execute_command_lines_honours_cancel() {
        let mut command = Command::new("sh");
        command.args(["-c", "sleep 30"]);
        let cancel = AtomicBool::new(true);
        let error = execute_command_lines(command, &cancel, Duration::from_secs(5), &mut |_, _| Ok(()))
            .unwrap_err();
        assert_eq!(error, "Coven run cancelled.");
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib execute_command_lines`
Expected: compile error — `execute_command_lines` not found.

- [ ] **Step 3: Widen visibility of the helpers the new modules call**

Change these signatures (visibility only):

```rust
// line 43
    pub(crate) fn register_run(&self, id: &str) -> Result<(Arc<AtomicBool>, RunRegistration), String> {
// line 167
pub(crate) fn home() -> Result<PathBuf, String> {
// line 201
pub(crate) fn resolve_cli() -> Result<PathBuf, String> {
// line 291
pub(crate) fn run_process(
// the fn after execute_command_bounded
pub(crate) fn cli_json(args: &[&str]) -> Result<Value, String> {
// line 1102
pub(crate) struct RunRegistration {
```

- [ ] **Step 4: Add the line streamer next to `execute_command_bounded`**

Insert immediately after the closing brace of `execute_command_bounded` (before `fn cli_json`):

```rust
/// Like `execute_command_bounded`, but for tools whose output is plain text
/// rather than stream JSON: every complete line (and a trailing partial line)
/// reaches `on_line(is_stderr, text)`. Returns the exit code; a non-zero code
/// is not an error here because the caller shows it to the person.
pub(crate) fn execute_command_lines(
    mut command: Command,
    cancel: &AtomicBool,
    timeout: Duration,
    on_line: &mut dyn FnMut(bool, &str) -> Result<(), String>,
) -> Result<i32, String> {
    if cancel.load(Ordering::SeqCst) {
        return Err("Coven run cancelled.".into());
    }
    command.stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = OwnedChild(
        command.spawn().map_err(|error| format!("Could not start the command: {error}"))?,
        false,
    );
    let (sender, receiver) = mpsc::sync_channel(16);
    let stdout = child.0.stdout.take().ok_or("Command stdout is unavailable.")?;
    let stderr = child.0.stderr.take().ok_or("Command stderr is unavailable.")?;
    let _stdout = pipe_reader(stdout, false, sender.clone()).map_err(|_| "Cannot read command output.")?;
    let _stderr = pipe_reader(stderr, true, sender).map_err(|_| "Cannot read command diagnostics.")?;
    let deadline = Instant::now() + timeout;
    let mut pending: [Vec<u8>; 2] = [Vec::new(), Vec::new()];
    let mut total = 0usize;
    let mut ended = 0;
    let mut status = None;
    let mut flush = |is_stderr: bool, buffer: &mut Vec<u8>, on_line: &mut dyn FnMut(bool, &str) -> Result<(), String>| -> Result<(), String> {
        while let Some(end) = buffer.iter().position(|b| *b == b'\n') {
            let line: Vec<u8> = buffer.drain(..=end).collect();
            let text = String::from_utf8_lossy(&line[..line.len() - 1]);
            let text: String = text.chars().filter(|c| !c.is_control()).take(2048).collect();
            on_line(is_stderr, &text)?;
        }
        Ok(())
    };
    while ended < 2 || status.is_none() {
        if cancel.load(Ordering::SeqCst) {
            return Err("Coven run cancelled.".into());
        }
        if Instant::now() >= deadline {
            return Err("The command timed out.".into());
        }
        status = child.0.try_wait().map_err(|_| "Could not inspect the command process.")?;
        child.1 = status.is_some();
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(PipeData::End) => ended += 1,
            Ok(PipeData::Error) => return Err("Could not read command output.".into()),
            Ok(PipeData::Bytes(is_stderr, bytes)) => {
                total += bytes.len();
                if total > OUTPUT_LIMIT {
                    return Err("Command output exceeded the local safety limit.".into());
                }
                let buffer = &mut pending[usize::from(is_stderr)];
                buffer.extend_from_slice(&bytes);
                flush(is_stderr, buffer, on_line)?;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) if ended == 2 => {
                thread::sleep(Duration::from_millis(20));
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err("Command output closed unexpectedly.".into())
            }
        }
    }
    for (index, buffer) in pending.iter_mut().enumerate() {
        if !buffer.is_empty() {
            buffer.push(b'\n');
            flush(index == 1, buffer, on_line)?;
        }
    }
    Ok(status.and_then(|s| s.code()).unwrap_or(-1))
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib execute_command_lines`
Expected: `test result: ok. 2 passed`

- [ ] **Step 6: Format, lint, full native suite**

Run: `corepack pnpm cargo:fmt && corepack pnpm cargo:clippy && cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: all clean; every existing test still passes.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/src/coven_runtime.rs
git commit -S -m "feat(native): expose runtime helpers and stream plain-text command output"
```

---

### Task 4: PKCE and the authorize URL

**Files:**
- Create: `src-tauri/src/identity.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod identity;` next to the other `mod` lines)

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/identity.rs` with only a tests module for now:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_verifier_is_rfc7636_shaped() {
        let pkce = Pkce::generate().unwrap();
        assert!(pkce.verifier.len() >= 43 && pkce.verifier.len() <= 128);
        assert!(pkce
            .verifier
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'));
        let second = Pkce::generate().unwrap();
        assert_ne!(pkce.verifier, second.verifier);
    }

    #[test]
    fn pkce_challenge_matches_the_rfc7636_appendix_b_vector() {
        let pkce = Pkce::from_verifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk".to_owned());
        assert_eq!(pkce.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    }

    #[test]
    fn authorize_url_is_built_only_against_workos() {
        let url = authorize_url("client_123", 4321, "chal", "st8").unwrap();
        assert!(url.starts_with("https://api.workos.com/user_management/authorize?"));
        assert!(url.contains("client_id=client_123"));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A4321%2Fcallback"));
        assert!(url.contains("response_type=code"));
        assert!(url.contains("provider=authkit"));
        assert!(url.contains("code_challenge=chal"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=st8"));
        assert!(authorize_url("", 1, "c", "s").is_err(), "empty client id refused");
    }
}
```

Add `mod identity;` to `src-tauri/src/lib.rs` beside the existing `mod coven_runtime;` line.

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib identity::`
Expected: compile errors — `Pkce`, `authorize_url` not found.

- [ ] **Step 3: Implement**

Add above the tests module in `identity.rs`:

```rust
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use sha2::{Digest, Sha256};
use url::Url;

pub(crate) const WORKOS_API: &str = "https://api.workos.com";
const AUTHORIZE_PATH: &str = "/user_management/authorize";

pub(crate) struct Pkce {
    pub(crate) verifier: String,
    pub(crate) challenge: String,
}

impl Pkce {
    pub(crate) fn generate() -> Result<Self, String> {
        let mut bytes = [0u8; 64];
        getrandom::fill(&mut bytes).map_err(|_| "Secure randomness is unavailable.")?;
        Ok(Self::from_verifier(URL_SAFE_NO_PAD.encode(bytes)))
    }

    pub(crate) fn from_verifier(verifier: String) -> Self {
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        Self { verifier, challenge }
    }
}

pub(crate) fn random_state() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "Secure randomness is unavailable.")?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}

pub(crate) fn authorize_url(
    client_id: &str,
    port: u16,
    challenge: &str,
    state: &str,
) -> Result<String, String> {
    if client_id.is_empty() || !client_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
        return Err("WorkOS client id is not configured.".into());
    }
    let mut url = Url::parse(WORKOS_API).map_err(|_| "Invalid WorkOS API base.")?;
    url.set_path(AUTHORIZE_PATH);
    url.query_pairs_mut()
        .append_pair("client_id", client_id)
        .append_pair("redirect_uri", &format!("http://127.0.0.1:{port}/callback"))
        .append_pair("response_type", "code")
        .append_pair("provider", "authkit")
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state);
    Ok(url.into())
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib identity::`
Expected: `test result: ok. 3 passed`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/identity.rs src-tauri/src/lib.rs
git commit -S -m "feat(native): PKCE and WorkOS authorize URL"
```

---

### Task 5: Loopback callback listener

**Files:**
- Modify: `src-tauri/src/identity.rs`

- [ ] **Step 1: Write the failing tests**

Append inside `mod tests`:

```rust
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::sync::atomic::AtomicBool;
    use std::time::Duration;

    fn hit(port: u16, path: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).unwrap();
        write!(stream, "GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    #[test]
    fn listener_accepts_one_matching_callback() {
        let listener = CallbackListener::bind().unwrap();
        let port = listener.port();
        let handle = std::thread::spawn(move || hit(port, "/callback?code=abc&state=xyz"));
        let cancel = AtomicBool::new(false);
        let code = listener.wait_for_code("xyz", &cancel, Duration::from_secs(5)).unwrap();
        assert_eq!(code, "abc");
        let response = handle.join().unwrap();
        assert!(response.starts_with("HTTP/1.1 200"));
        assert!(response.contains("You can close this tab"));
    }

    #[test]
    fn listener_rejects_state_mismatch_and_missing_code() {
        for path in ["/callback?code=abc&state=WRONG", "/callback?state=xyz", "/other?code=a&state=xyz"] {
            let listener = CallbackListener::bind().unwrap();
            let port = listener.port();
            let handle = std::thread::spawn(move || hit(port, path));
            let cancel = AtomicBool::new(false);
            let error = listener.wait_for_code("xyz", &cancel, Duration::from_secs(5)).unwrap_err();
            assert_eq!(error, "Sign-in response was invalid. Try again.");
            assert!(handle.join().unwrap().starts_with("HTTP/1.1 400"));
        }
    }

    #[test]
    fn listener_honours_cancel_and_timeout() {
        let listener = CallbackListener::bind().unwrap();
        let cancel = AtomicBool::new(true);
        assert_eq!(
            listener.wait_for_code("x", &cancel, Duration::from_secs(5)).unwrap_err(),
            "Sign-in cancelled."
        );
        let listener = CallbackListener::bind().unwrap();
        let cancel = AtomicBool::new(false);
        assert_eq!(
            listener.wait_for_code("x", &cancel, Duration::from_millis(50)).unwrap_err(),
            "Sign-in timed out."
        );
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib identity::listener`
Expected: compile error — `CallbackListener` not found.

- [ ] **Step 3: Implement**

Add to `identity.rs` (above the tests module):

```rust
use std::io::{Read as _, Write as _};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const CALLBACK_BODY: &str = "<!doctype html><meta charset=\"utf-8\"><title>OpenCoven Chat</title><p>Signed in. You can close this tab and return to OpenCoven Chat.</p>";
const INVALID_BODY: &str = "<!doctype html><meta charset=\"utf-8\"><title>OpenCoven Chat</title><p>Sign-in response was invalid. Return to OpenCoven Chat and try again.</p>";

/// One-shot loopback listener for the OAuth redirect. Bound to 127.0.0.1 only;
/// accepts exactly one request; torn down on every exit path by drop.
pub(crate) struct CallbackListener {
    listener: TcpListener,
    port: u16,
}

impl CallbackListener {
    pub(crate) fn bind() -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|_| "Could not open a local port for sign-in. Try again.")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "Could not configure the local sign-in port.")?;
        let port = listener
            .local_addr()
            .map_err(|_| "Could not read the local sign-in port.")?
            .port();
        Ok(Self { listener, port })
    }

    pub(crate) fn port(&self) -> u16 {
        self.port
    }

    /// Blocks (polling) until one request arrives, the flag is set, or the
    /// deadline passes. Returns the authorization code.
    pub(crate) fn wait_for_code(
        self,
        expected_state: &str,
        cancel: &AtomicBool,
        timeout: Duration,
    ) -> Result<String, String> {
        let deadline = Instant::now() + timeout;
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err("Sign-in cancelled.".into());
            }
            if Instant::now() >= deadline {
                return Err("Sign-in timed out.".into());
            }
            match self.listener.accept() {
                Ok((stream, _)) => return Self::handle(stream, expected_state),
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(_) => return Err("The local sign-in port failed.".into()),
            }
        }
    }

    fn handle(mut stream: TcpStream, expected_state: &str) -> Result<String, String> {
        let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
        let mut buffer = [0u8; 4096];
        let read = stream.read(&mut buffer).unwrap_or(0);
        let request = String::from_utf8_lossy(&buffer[..read]);
        let target = request
            .lines()
            .next()
            .and_then(|line| line.split_whitespace().nth(1))
            .unwrap_or("");
        let parsed = Url::parse(&format!("http://127.0.0.1{target}")).ok();
        let code = parsed.as_ref().filter(|u| u.path() == "/callback").and_then(|u| {
            let mut code = None;
            let mut state_ok = false;
            for (key, value) in u.query_pairs() {
                match &*key {
                    "code" if !value.is_empty() => code = Some(value.into_owned()),
                    "state" if value == expected_state => state_ok = true,
                    _ => {}
                }
            }
            code.filter(|_| state_ok)
        });
        let (status, body) = match &code {
            Some(_) => ("200 OK", CALLBACK_BODY),
            None => ("400 Bad Request", INVALID_BODY),
        };
        let _ = write!(
            stream,
            "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let _ = stream.flush();
        code.ok_or_else(|| "Sign-in response was invalid. Try again.".into())
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib identity::listener`
Expected: `test result: ok. 3 passed`

- [ ] **Step 5: Format, lint, commit**

Run: `corepack pnpm cargo:fmt && corepack pnpm cargo:clippy`

```bash
git add src-tauri/src/identity.rs
git commit -S -m "feat(native): one-shot 127.0.0.1 callback listener for sign-in"
```

---

### Task 6: Test RSA fixture and JWT verification

**Files:**
- Create: `src-tauri/tests/fixtures/workos-test-key.pem`, `workos-test-key.n`, `workos-test-key.e`
- Modify: `src-tauri/src/identity.rs`

- [ ] **Step 1: Generate the test-only keypair (never used outside tests)**

```bash
mkdir -p src-tauri/tests/fixtures
openssl genrsa -out src-tauri/tests/fixtures/workos-test-key.pem 2048 2>/dev/null
openssl rsa -in src-tauri/tests/fixtures/workos-test-key.pem -noout -modulus | sed 's/^Modulus=//' \
  | xxd -r -p | base64 | tr '+/' '-_' | tr -d '=\n' > src-tauri/tests/fixtures/workos-test-key.n
printf 'AQAB' > src-tauri/tests/fixtures/workos-test-key.e
wc -c src-tauri/tests/fixtures/workos-test-key.*
```

Expected: three files; `.e` is 4 bytes (`AQAB` is 65537), `.n` is ~342 bytes.

- [ ] **Step 2: Write the failing tests**

Append inside `mod tests`:

```rust
    use jsonwebtoken::{encode, EncodingKey, Header, Algorithm};

    fn test_jwks() -> Jwks {
        let n = include_str!("../tests/fixtures/workos-test-key.n").trim().to_owned();
        let e = include_str!("../tests/fixtures/workos-test-key.e").trim().to_owned();
        Jwks::from_json(&serde_json::json!({
            "keys": [{ "kty": "RSA", "kid": "test-kid", "use": "sig", "alg": "RS256", "n": n, "e": e }]
        }).to_string()).unwrap()
    }

    fn sign(claims: &serde_json::Value, kid: Option<&str>) -> String {
        let pem = include_bytes!("../tests/fixtures/workos-test-key.pem");
        let key = EncodingKey::from_rsa_pem(pem).unwrap();
        let mut header = Header::new(Algorithm::RS256);
        header.kid = kid.map(str::to_owned);
        encode(&header, claims, &key).unwrap()
    }

    fn good_claims(now: u64) -> serde_json::Value {
        serde_json::json!({
            "iss": "https://api.workos.com", "sub": "user_01H", "sid": "session_01H",
            "client_id": "client_123", "exp": now + 300, "iat": now, "email": "val@example.com"
        })
    }

    #[test]
    fn verify_accepts_a_valid_token_and_reads_claims() {
        let now = 1_800_000_000;
        let token = sign(&good_claims(now), Some("test-kid"));
        let claims = verify_access_token(&token, &test_jwks(), "client_123", now).unwrap();
        assert_eq!(claims.sub, "user_01H");
        assert_eq!(claims.exp, now + 300);
    }

    #[test]
    fn verify_rejects_bad_issuer_client_expiry_signature_and_kid() {
        let now = 1_800_000_000;
        let jwks = test_jwks();
        let mut wrong_iss = good_claims(now); wrong_iss["iss"] = "https://evil.example".into();
        assert!(verify_access_token(&sign(&wrong_iss, Some("test-kid")), &jwks, "client_123", now).is_err());
        assert!(verify_access_token(&sign(&good_claims(now), Some("test-kid")), &jwks, "client_OTHER", now).is_err());
        let mut expired = good_claims(now); expired["exp"] = (now - 1).into();
        assert!(verify_access_token(&sign(&expired, Some("test-kid")), &jwks, "client_123", now).is_err());
        assert!(verify_access_token(&sign(&good_claims(now), Some("unknown-kid")), &jwks, "client_123", now).is_err());
        let token = sign(&good_claims(now), Some("test-kid"));
        let mut tampered = token.clone(); tampered.replace_range(token.len() - 4.., "AAAA");
        assert!(verify_access_token(&tampered, &jwks, "client_123", now).is_err());
        assert!(verify_access_token("eyJhbGciOiJub25lIn0.e30.", &jwks, "client_123", now).is_err(), "alg=none");
    }
```

- [ ] **Step 3: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib identity::verify`
Expected: compile errors — `Jwks`, `verify_access_token`, `Claims` not found.

- [ ] **Step 4: Implement**

Add to `identity.rs`:

```rust
use jsonwebtoken::{decode, decode_header, jwk::JwkSet, Algorithm, DecodingKey, Validation};
use serde::Deserialize;

pub(crate) const WORKOS_ISSUER: &str = "https://api.workos.com";

#[derive(Clone, Deserialize)]
pub(crate) struct Claims {
    pub(crate) sub: String,
    pub(crate) exp: u64,
    #[serde(default)]
    pub(crate) email: Option<String>,
    #[serde(default)]
    pub(crate) client_id: Option<String>,
}

pub(crate) struct Jwks(JwkSet);

impl Jwks {
    pub(crate) fn from_json(json: &str) -> Result<Self, String> {
        serde_json::from_str(json).map(Self).map_err(|_| "Key set is invalid.".into())
    }
}

/// Offline verification: RS256 only, pinned issuer, pinned client id, exp
/// checked against the supplied clock so tests are deterministic.
pub(crate) fn verify_access_token(
    token: &str,
    jwks: &Jwks,
    client_id: &str,
    now: u64,
) -> Result<Claims, String> {
    let header = decode_header(token).map_err(|_| "Token header is invalid.")?;
    if header.alg != Algorithm::RS256 {
        return Err("Token algorithm is not allowed.".into());
    }
    let kid = header.kid.ok_or("Token has no key id.")?;
    let jwk = jwks.0.find(&kid).ok_or("Token key id is unknown.")?;
    let key = DecodingKey::from_jwk(jwk).map_err(|_| "Key set entry is invalid.")?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.set_issuer(&[WORKOS_ISSUER]);
    validation.validate_aud = false;
    validation.validate_exp = false; // checked below against `now`
    validation.set_required_spec_claims(&["iss", "sub", "exp"]);
    let data = decode::<Claims>(token, &key, &validation).map_err(|_| "Token signature or issuer is invalid.")?;
    let claims = data.claims;
    if claims.client_id.as_deref() != Some(client_id) {
        return Err("Token was issued for a different client.".into());
    }
    if claims.exp <= now {
        return Err("Token has expired.".into());
    }
    Ok(claims)
}
```

- [ ] **Step 5: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib identity::verify`
Expected: `test result: ok. 2 passed`

- [ ] **Step 6: Format, lint, commit**

Run: `corepack pnpm cargo:fmt && corepack pnpm cargo:clippy`

```bash
git add src-tauri/tests/fixtures src-tauri/src/identity.rs
git commit -S -m "feat(native): offline RS256 verification of WorkOS access tokens"
```

---

### Task 7: Status derivation (pure)

**Files:**
- Modify: `src-tauri/src/identity.rs`

- [ ] **Step 1: Write the failing tests**

Append inside `mod tests`:

```rust
    use crate::keyring::StoredSession;

    fn session(exp: u64, checked: u64, now: u64) -> StoredSession {
        StoredSession {
            access_token: sign(&{ let mut c = good_claims(now); c["exp"] = exp.into(); c }, Some("test-kid")),
            refresh_token: "rt".into(), expires_at: exp, checked_at: checked,
            subject: "user_01H".into(), email: "val@example.com".into(),
        }
    }

    #[test]
    fn status_is_derived_from_record_clock_and_keys() {
        let now = 1_800_000_000;
        let jwks = test_jwks();
        assert!(matches!(derive_status(None, Some(&jwks), "client_123", now), Status::SignedOut));
        assert!(matches!(derive_status(Some(&session(now + 60, now, now)), None, "client_123", now), Status::Expired));
        assert!(matches!(derive_status(Some(&session(now + 60, now, now)), Some(&jwks), "client_123", now), Status::Entitled { .. }));
        // token expired, inside the 14-day grace: needs a refresh attempt
        assert!(matches!(derive_status(Some(&session(now - 1, now - 60, now)), Some(&jwks), "client_123", now), Status::NeedsRefresh));
        // grace elapsed
        assert!(matches!(derive_status(Some(&session(now - 1, now - GRACE_SECONDS - 1, now)), Some(&jwks), "client_123", now), Status::Expired));
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib identity::status`
Expected: compile error — `derive_status`, `Status`, `GRACE_SECONDS` not found.

- [ ] **Step 3: Implement**

Add to `identity.rs`:

```rust
pub(crate) const GRACE_SECONDS: u64 = 14 * 24 * 60 * 60;

pub(crate) enum Status {
    SignedOut,
    Entitled { email: String, checked_at: u64, grace_until: u64 },
    /// Access token expired but the grace window is open; try a refresh grant.
    NeedsRefresh,
    Expired,
    Revoked,
}

impl Status {
    pub(crate) fn to_value(&self) -> serde_json::Value {
        match self {
            Status::SignedOut => serde_json::json!({ "state": "signed_out" }),
            Status::Entitled { email, checked_at, grace_until } => serde_json::json!({
                "state": "entitled", "email": email, "checkedAt": checked_at, "graceUntil": grace_until
            }),
            Status::NeedsRefresh => serde_json::json!({ "state": "expired" }),
            Status::Expired => serde_json::json!({ "state": "expired" }),
            Status::Revoked => serde_json::json!({ "state": "revoked" }),
        }
    }
}

pub(crate) fn derive_status(
    record: Option<&crate::keyring::StoredSession>,
    jwks: Option<&Jwks>,
    client_id: &str,
    now: u64,
) -> Status {
    let Some(record) = record else { return Status::SignedOut };
    let Some(jwks) = jwks else { return Status::Expired };
    let grace_until = record.checked_at.saturating_add(GRACE_SECONDS);
    match verify_access_token(&record.access_token, jwks, client_id, now) {
        Ok(_) => Status::Entitled { email: record.email.clone(), checked_at: record.checked_at, grace_until },
        Err(_) if now < grace_until => Status::NeedsRefresh,
        Err(_) => Status::Expired,
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib identity::status`
Expected: `test result: ok. 1 passed`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/identity.rs
git commit -S -m "feat(native): derive sign-in status from record, clock and key set"
```

---

### Task 8: WorkOS HTTP (exchange, refresh, JWKS) and browser opener

**Files:**
- Modify: `src-tauri/src/identity.rs`

- [ ] **Step 1: Write the failing tests (opener guard and request shapes only — no network)**

Append inside `mod tests`:

```rust
    #[test]
    fn opener_refuses_any_url_it_did_not_build() {
        assert!(open_browser("https://evil.example/").is_err());
        assert!(open_browser("http://127.0.0.1:1/callback").is_err());
        assert!(open_browser("file:///etc/passwd").is_err());
    }

    #[test]
    fn exchange_and_refresh_bodies_carry_no_client_secret() {
        let body = exchange_body("client_123", "code9", "verifier9");
        assert_eq!(body["grant_type"], "authorization_code");
        assert_eq!(body["client_id"], "client_123");
        assert_eq!(body["code"], "code9");
        assert_eq!(body["code_verifier"], "verifier9");
        assert!(body.get("client_secret").is_none());
        let body = refresh_body("client_123", "rt");
        assert_eq!(body["grant_type"], "refresh_token");
        assert_eq!(body["refresh_token"], "rt");
        assert!(body.get("client_secret").is_none());
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib identity::opener identity::exchange`
Expected: compile errors — `open_browser`, `exchange_body`, `refresh_body` not found.

- [ ] **Step 3: Implement**

Add to `identity.rs`:

```rust
use std::process::{Command, Stdio};

const AUTHENTICATE_URL: &str = "https://api.workos.com/user_management/authenticate";
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);

pub(crate) fn exchange_body(client_id: &str, code: &str, verifier: &str) -> serde_json::Value {
    serde_json::json!({
        "client_id": client_id, "grant_type": "authorization_code",
        "code": code, "code_verifier": verifier
    })
}

pub(crate) fn refresh_body(client_id: &str, refresh_token: &str) -> serde_json::Value {
    serde_json::json!({
        "client_id": client_id, "grant_type": "refresh_token", "refresh_token": refresh_token
    })
}

pub(crate) struct TokenResponse {
    pub(crate) access_token: String,
    pub(crate) refresh_token: String,
    pub(crate) email: String,
}

/// `Err(Refused(_))` is a 4xx the person must act on (revoked, invalid grant);
/// `Err(Transient(_))` is network / 5xx and may be retried or tolerated.
pub(crate) enum HttpFailure {
    Refused(String),
    Transient(String),
}

fn client() -> Result<reqwest::Client, HttpFailure> {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| HttpFailure::Transient("HTTP client is unavailable.".into()))
}

pub(crate) async fn authenticate(body: serde_json::Value) -> Result<TokenResponse, HttpFailure> {
    let response = client()?
        .post(AUTHENTICATE_URL)
        .json(&body)
        .send()
        .await
        .map_err(|_| HttpFailure::Transient("Could not reach WorkOS. Check your connection and retry.".into()))?;
    let status = response.status();
    let value: serde_json::Value = response
        .json()
        .await
        .map_err(|_| HttpFailure::Transient("WorkOS returned an unreadable response.".into()))?;
    if status.is_server_error() {
        return Err(HttpFailure::Transient("WorkOS is unavailable right now. Retry shortly.".into()));
    }
    if !status.is_success() {
        let detail: String = value
            .get("error_description")
            .or_else(|| value.get("error"))
            .and_then(serde_json::Value::as_str)
            .unwrap_or("Sign-in was refused.")
            .chars()
            .filter(|c| !c.is_control())
            .take(2048)
            .collect();
        return Err(HttpFailure::Refused(detail));
    }
    let field = |name: &str| value.get(name).and_then(serde_json::Value::as_str).map(str::to_owned);
    Ok(TokenResponse {
        access_token: field("access_token").ok_or_else(|| HttpFailure::Refused("WorkOS returned no access token.".into()))?,
        refresh_token: field("refresh_token").ok_or_else(|| HttpFailure::Refused("WorkOS returned no refresh token.".into()))?,
        email: value.pointer("/user/email").and_then(serde_json::Value::as_str).unwrap_or("").to_owned(),
    })
}

pub(crate) async fn fetch_jwks(client_id: &str) -> Result<String, HttpFailure> {
    let url = format!("{WORKOS_API}/sso/jwks/{client_id}");
    let response = client()?
        .get(&url)
        .send()
        .await
        .map_err(|_| HttpFailure::Transient("Could not fetch the WorkOS key set.".into()))?;
    if !response.status().is_success() {
        return Err(HttpFailure::Transient("WorkOS key set is unavailable.".into()));
    }
    response
        .text()
        .await
        .map_err(|_| HttpFailure::Transient("WorkOS key set was unreadable.".into()))
}

/// Opens the system browser on a URL this module built. Anything else is
/// refused before a `Command` exists, so this is not a general opener.
pub(crate) fn open_browser(url: &str) -> Result<(), String> {
    let prefix = format!("{WORKOS_API}{AUTHORIZE_PATH}?");
    if !url.starts_with(&prefix) {
        return Err("Refusing to open a URL that is not the WorkOS sign-in page.".into());
    }
    #[cfg(target_os = "macos")]
    let mut command = { let mut c = Command::new("open"); c.arg(url); c };
    #[cfg(target_os = "linux")]
    let mut command = { let mut c = Command::new("xdg-open"); c.arg(url); c };
    #[cfg(target_os = "windows")]
    let mut command = { let mut c = Command::new("cmd"); c.args(["/c", "start", "", url]); c };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map(|_| ())
        .map_err(|_| "Could not open your browser. Copy the sign-in link instead.".into())
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib identity::`
Expected: all identity tests pass (opener test passes because the URL prefix check fails before spawning).

- [ ] **Step 5: Format, lint, commit**

Run: `corepack pnpm cargo:fmt && corepack pnpm cargo:clippy`

```bash
git add src-tauri/src/identity.rs
git commit -S -m "feat(native): WorkOS token exchange, refresh, key set fetch and guarded opener"
```

---

### Task 9: Identity Tauri commands

**Files:**
- Modify: `src-tauri/src/identity.rs`
- Modify: `src-tauri/src/lib.rs:262-290`
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Write the failing test (config reader is pure; commands are exercised in Task 24's manual checklist)**

Append inside `mod tests`:

```rust
    #[test]
    fn client_id_comes_from_plugins_workos_and_is_validated() {
        let mut plugins = std::collections::HashMap::new();
        assert!(client_id_from(&plugins).is_err());
        plugins.insert("workos".to_owned(), serde_json::json!({ "clientId": "client_abc" }));
        assert_eq!(client_id_from(&plugins).unwrap(), "client_abc");
        plugins.insert("workos".to_owned(), serde_json::json!({ "clientId": "client abc" }));
        assert!(client_id_from(&plugins).is_err());
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib identity::client_id`
Expected: compile error — `client_id_from` not found.

- [ ] **Step 3: Implement the config reader, JWKS cache, and the four commands**

Add to `identity.rs`:

```rust
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tauri::{ipc::Channel, AppHandle, Manager, State};

use crate::coven_runtime::CovenRuntimeState;
use crate::keyring::{KeyringError, NativeKeyring, StoredSession};

const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(600);
const JWKS_FILE: &str = "workos-jwks.json";

pub(crate) fn client_id_from(
    plugins: &std::collections::HashMap<String, serde_json::Value>,
) -> Result<String, String> {
    let id = plugins
        .get("workos")
        .and_then(|v| v.get("clientId"))
        .and_then(serde_json::Value::as_str)
        .ok_or("WorkOS client id is not configured (plugins.workos.clientId).")?;
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_') {
        return Err("WorkOS client id is malformed.".into());
    }
    Ok(id.to_owned())
}

fn client_id(app: &AppHandle) -> Result<String, String> {
    client_id_from(&app.config().plugins.0)
}

fn jwks_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "Cannot locate local app storage.")?;
    std::fs::create_dir_all(&dir).map_err(|_| "Cannot create local app storage.")?;
    Ok(dir.join(JWKS_FILE))
}

fn read_jwks(path: &Path) -> Option<Jwks> {
    std::fs::read_to_string(path).ok().and_then(|s| Jwks::from_json(&s).ok())
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn keyring_text(error: KeyringError) -> String {
    match error {
        KeyringError::NotFound => "No sign-in is stored.".into(),
        KeyringError::Unavailable => "Can't read the system keychain. Unlock it and retry.".into(),
        _ => "Saved sign-in is unreadable. Sign out to clear it.".into(),
    }
}

fn keyring_for(app: &AppHandle) -> Arc<NativeKeyring> {
    app.state::<crate::NativeConnectionState>().keyring.clone()
}

async fn refresh_and_store(
    app: &AppHandle,
    keyring: &NativeKeyring,
    current: &StoredSession,
    jwks: &Jwks,
) -> Result<Status, String> {
    let id = client_id(app)?;
    match authenticate(refresh_body(&id, &current.refresh_token)).await {
        Ok(tokens) => {
            let claims = verify_access_token(&tokens.access_token, jwks, &id, now())?;
            let next = StoredSession {
                access_token: tokens.access_token,
                refresh_token: tokens.refresh_token,
                expires_at: claims.exp,
                checked_at: now(),
                subject: claims.sub,
                email: if tokens.email.is_empty() { current.email.clone() } else { tokens.email },
            };
            keyring.write_session(Some(current), &next).map_err(keyring_text)?;
            Ok(Status::Entitled { email: next.email.clone(), checked_at: next.checked_at, grace_until: next.checked_at + GRACE_SECONDS })
        }
        Err(HttpFailure::Refused(_)) => {
            keyring.delete_session().map_err(keyring_text)?;
            Ok(Status::Revoked)
        }
        Err(HttpFailure::Transient(_)) => Ok(Status::Entitled {
            email: current.email.clone(),
            checked_at: current.checked_at,
            grace_until: current.checked_at + GRACE_SECONDS,
        }),
    }
}

#[tauri::command]
pub(crate) async fn identity_status(app: AppHandle) -> Result<serde_json::Value, String> {
    let keyring = keyring_for(&app);
    let id = client_id(&app)?;
    let record = keyring.read_session().map_err(keyring_text)?;
    let jwks = read_jwks(&jwks_path(&app)?);
    let status = derive_status(record.as_ref(), jwks.as_ref(), &id, now());
    let status = match (status, record, jwks) {
        (Status::NeedsRefresh, Some(record), Some(jwks)) => refresh_and_store(&app, &keyring, &record, &jwks).await?,
        (status, _, _) => status,
    };
    Ok(status.to_value())
}

#[tauri::command]
pub(crate) async fn identity_sign_in(
    app: AppHandle,
    state: State<'_, CovenRuntimeState>,
    run_id: String,
    on_event: Channel<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    let id = client_id(&app)?;
    let (cancel, _registration) = state.register_run(&run_id)?;
    let pkce = Pkce::generate()?;
    let state_value = random_state()?;
    let listener = CallbackListener::bind()?;
    let url = authorize_url(&id, listener.port(), &pkce.challenge, &state_value)?;
    open_browser(&url)?;
    let _ = on_event.send(serde_json::json!({ "type": "waiting" }));
    let expected = state_value.clone();
    let code = tauri::async_runtime::spawn_blocking(move || {
        listener.wait_for_code(&expected, &cancel, SIGN_IN_TIMEOUT)
    })
    .await
    .map_err(|_| "Sign-in worker failed.".to_string())??;
    let _ = on_event.send(serde_json::json!({ "type": "received" }));
    let tokens = authenticate(exchange_body(&id, &code, &pkce.verifier)).await.map_err(|e| match e {
        HttpFailure::Refused(m) | HttpFailure::Transient(m) => m,
    })?;
    let path = jwks_path(&app)?;
    let jwks = match read_jwks(&path) {
        Some(j) => j,
        None => {
            let text = fetch_jwks(&id).await.map_err(|e| match e { HttpFailure::Refused(m) | HttpFailure::Transient(m) => m })?;
            let jwks = Jwks::from_json(&text)?;
            std::fs::write(&path, text).map_err(|_| "Could not cache the WorkOS key set.")?;
            jwks
        }
    };
    let claims = verify_access_token(&tokens.access_token, &jwks, &id, now())
        .map_err(|_| "Couldn't verify the sign-in. Nothing was stored.".to_string())?;
    let _ = on_event.send(serde_json::json!({ "type": "exchanged" }));
    let keyring = keyring_for(&app);
    let current = keyring.read_session().map_err(keyring_text)?;
    let next = StoredSession {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: claims.exp,
        checked_at: now(),
        subject: claims.sub,
        email: tokens.email,
    };
    keyring.write_session(current.as_ref(), &next).map_err(keyring_text)?;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_focus();
    }
    let _ = on_event.send(serde_json::json!({ "type": "done" }));
    Ok(serde_json::json!({ "runId": run_id }))
}

#[tauri::command]
pub(crate) fn identity_cancel_sign_in(
    state: State<'_, CovenRuntimeState>,
    run_id: String,
) -> Result<(), String> {
    crate::coven_runtime::coven_runtime_cancel(state, run_id)
}

#[tauri::command]
pub(crate) async fn identity_sign_out(app: AppHandle) -> Result<(), String> {
    keyring_for(&app).delete_session().map_err(keyring_text)
}
```

`NativeConnectionState.keyring` must be reachable: in `src-tauri/src/lib.rs`, find the `keyring:` field of `struct NativeConnectionState` and make it `pub(crate) keyring: Arc<NativeKeyring>` (it is already an `Arc`; only the visibility changes).

- [ ] **Step 4: Register the commands**

In `src-tauri/src/lib.rs` `generate_handler![ … ]`, after `coven_runtime::coven_runtime_cancel,` add:

```rust
            identity::identity_status,
            identity::identity_sign_in,
            identity::identity_cancel_sign_in,
            identity::identity_sign_out,
```

Do **not** add them to `REGISTERED_COMMANDS` in `commands.rs`; that list is asserted to contain only the Cave adapter commands, and the shipped `coven_runtime_*` commands are likewise outside it.

In `src-tauri/capabilities/default.json`, after `"allow-coven-runtime-cancel",` add:

```json
    "allow-identity-status",
    "allow-identity-sign-in",
    "allow-identity-cancel-sign-in",
    "allow-identity-sign-out",
```

- [ ] **Step 5: Build, test, lint**

Run: `corepack pnpm cargo:fmt && corepack pnpm cargo:clippy && cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: clean; all tests pass, including `registers_only_the_managed_sdk_adapter_commands` (unchanged).

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/identity.rs src-tauri/src/lib.rs src-tauri/capabilities/default.json
git commit -S -m "feat(native): identity commands for WorkOS sign-in, status and sign-out"
```

---

### Task 10: Setup detection (pure)

**Files:**
- Create: `src-tauri/src/setup.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod setup;`)

- [ ] **Step 1: Write the failing tests**

Create `src-tauri/src/setup.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn probe(node: bool, npm: bool, coven: bool, engine: bool, familiar: bool) -> Probe {
        Probe {
            node: node.then(|| "/usr/local/bin/node".into()),
            npm: npm.then(|| "/usr/local/bin/npm".into()),
            coven: coven.then(|| "/Users/me/.local/bin/coven".into()),
            engine_installed: engine,
            familiar_with_workspace: familiar,
        }
    }

    #[test]
    fn check_reports_each_row_with_a_detail_and_path() {
        let report = report_from(&probe(true, true, true, true, true), true);
        for key in ["platform", "node", "npm", "coven", "engine", "familiar"] {
            assert_eq!(report[key]["ok"], true, "{key}");
        }
        assert_eq!(report["coven"]["path"], "/Users/me/.local/bin/coven");

        let report = report_from(&probe(false, false, false, false, false), false);
        assert_eq!(report["platform"]["ok"], false);
        assert_eq!(report["platform"]["detail"], "Chat isn't available on Windows yet.");
        assert_eq!(report["node"]["detail"], "Node.js was not found on this machine.");
        assert_eq!(report["coven"]["detail"], "Coven CLI was not found in ~/.local/bin, ~/.cargo/bin, Homebrew, /usr/local or PATH.");
        assert_eq!(report["engine"]["detail"], "The Coven engine is not installed.");
        assert_eq!(report["familiar"]["detail"], "No familiar has a dedicated project workspace yet.");
    }

    #[test]
    fn install_steps_are_exactly_two_fixed_argv_vectors() {
        assert_eq!(
            argv_for(Step::InstallCli, Path::new("/usr/local/bin/npm"), Path::new("/Users/me")),
            ("/usr/local/bin/npm".to_owned(), vec!["install".to_owned(), "-g".to_owned(), "--prefix".to_owned(), "/Users/me/.local".to_owned(), "@opencoven/cli".to_owned()])
        );
        assert_eq!(
            argv_for(Step::InstallEngine, Path::new("/Users/me/.local/bin/coven"), Path::new("/Users/me")),
            ("/Users/me/.local/bin/coven".to_owned(), vec!["engine".to_owned(), "install".to_owned()])
        );
        assert_eq!(display_command(Step::InstallCli), "npm install -g --prefix ~/.local @opencoven/cli");
        assert_eq!(display_command(Step::InstallEngine), "coven engine install");
    }
}
```

Add `mod setup;` to `lib.rs`.

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib setup::`
Expected: compile errors — `Probe`, `report_from`, `Step`, `argv_for`, `display_command` not found.

- [ ] **Step 3: Implement the pure parts**

Add above the tests module:

```rust
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{json, Value};

/// What detection found. Kept as data so `report_from` is a pure function.
pub(crate) struct Probe {
    pub(crate) node: Option<PathBuf>,
    pub(crate) npm: Option<PathBuf>,
    pub(crate) coven: Option<PathBuf>,
    pub(crate) engine_installed: bool,
    pub(crate) familiar_with_workspace: bool,
}

#[derive(Clone, Copy, Deserialize, PartialEq, Eq, Debug)]
#[serde(rename_all = "snake_case")]
pub(crate) enum Step {
    InstallCli,
    InstallEngine,
}

fn row(ok: bool, detail: &str, path: Option<&Path>) -> Value {
    let mut value = json!({ "ok": ok });
    if !ok {
        value["detail"] = json!(detail);
    }
    if let Some(path) = path {
        value["path"] = json!(path.display().to_string());
    }
    value
}

pub(crate) fn report_from(probe: &Probe, unix: bool) -> Value {
    json!({
        "platform": row(unix, "Chat isn't available on Windows yet.", None),
        "node": row(probe.node.is_some(), "Node.js was not found on this machine.", probe.node.as_deref()),
        "npm": row(probe.npm.is_some(), "npm was not found on this machine.", probe.npm.as_deref()),
        "coven": row(
            probe.coven.is_some(),
            "Coven CLI was not found in ~/.local/bin, ~/.cargo/bin, Homebrew, /usr/local or PATH.",
            probe.coven.as_deref(),
        ),
        "engine": row(probe.engine_installed, "The Coven engine is not installed.", None),
        "familiar": row(probe.familiar_with_workspace, "No familiar has a dedicated project workspace yet.", None),
    })
}

/// The only two commands this module will ever run. `tool` is the resolved
/// absolute executable; nothing from the webview participates.
pub(crate) fn argv_for(step: Step, tool: &Path, home: &Path) -> (String, Vec<String>) {
    let program = tool.display().to_string();
    let args = match step {
        Step::InstallCli => vec![
            "install".to_owned(),
            "-g".to_owned(),
            "--prefix".to_owned(),
            home.join(".local").display().to_string(),
            "@opencoven/cli".to_owned(),
        ],
        Step::InstallEngine => vec!["engine".to_owned(), "install".to_owned()],
    };
    (program, args)
}

pub(crate) fn display_command(step: Step) -> &'static str {
    match step {
        Step::InstallCli => "npm install -g --prefix ~/.local @opencoven/cli",
        Step::InstallEngine => "coven engine install",
    }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib setup::`
Expected: `test result: ok. 2 passed`

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/setup.rs src-tauri/src/lib.rs
git commit -S -m "feat(native): prerequisite report and the two fixed install commands"
```

---

### Task 11: Setup probing (real detection)

**Files:**
- Modify: `src-tauri/src/setup.rs`

- [ ] **Step 1: Write the failing test**

Append inside `mod tests`:

```rust
    #[cfg(unix)]
    #[test]
    fn find_tool_searches_the_same_directories_as_the_runtime() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        let bin = root.join(".local/bin");
        std::fs::create_dir_all(&bin).unwrap();
        let tool = bin.join("fake-tool");
        std::fs::write(&tool, "#!/bin/sh\nexit 0\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(find_tool("fake-tool", &root), Some(tool));
        assert_eq!(find_tool("definitely-missing-tool-xyz", &root), None);
    }

    #[test]
    fn familiar_needs_an_absolute_non_root_non_home_workspace() {
        let home = Path::new("/Users/me");
        let ok = |ws: &str| any_familiar_has_workspace(&json!([{ "id": "f", "workspace": ws }]), home);
        assert!(ok("/Users/me/projects/app"));
        assert!(!ok("/Users/me"));
        assert!(!ok("/"));
        assert!(!ok("relative/path"));
        assert!(!any_familiar_has_workspace(&json!([{ "id": "f" }]), home));
        assert!(!any_familiar_has_workspace(&json!("not an array"), home));
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib setup::find_tool setup::familiar`
Expected: compile errors — `find_tool`, `any_familiar_has_workspace` not found.

- [ ] **Step 3: Implement**

Add to `setup.rs`:

```rust
use crate::coven_runtime::{cli_json, home, resolve_cli, run_process};
use std::sync::atomic::AtomicBool;
use std::time::Duration;

fn executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// Same directories `coven_runtime::run_process` puts on PATH, in the same
/// order, so a tool the app can find here is a tool a run can find later.
pub(crate) fn find_tool(name: &str, home: &Path) -> Option<PathBuf> {
    let mut candidates = vec![
        home.join(".local/bin"),
        home.join(".cargo/bin"),
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).filter(|p| p.is_absolute()));
    }
    candidates.into_iter().map(|dir| dir.join(name)).find(|p| executable(p))
}

pub(crate) fn any_familiar_has_workspace(familiars: &Value, home: &Path) -> bool {
    familiars.as_array().is_some_and(|list| {
        list.iter().any(|f| {
            f.get("workspace")
                .and_then(Value::as_str)
                .map(Path::new)
                .is_some_and(|ws| ws.is_absolute() && ws != home && ws.parent().is_some())
        })
    })
}

fn engine_installed(cancel: &AtomicBool) -> bool {
    run_process(
        &["engine".into(), "status".into(), "--json".into()],
        None,
        cancel,
        Duration::from_secs(20),
        None,
    )
    .ok()
    .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    .and_then(|v| v.get("installed").and_then(Value::as_bool))
    .unwrap_or(false)
}

pub(crate) fn probe() -> Result<Probe, String> {
    let home_dir = home()?;
    let coven = resolve_cli().ok();
    let cancel = AtomicBool::new(false);
    let (engine, familiar) = if coven.is_some() {
        (
            engine_installed(&cancel),
            cli_json(&["familiars", "--json"])
                .map(|v| any_familiar_has_workspace(&v, &home_dir))
                .unwrap_or(false),
        )
    } else {
        (false, false)
    };
    Ok(Probe {
        node: find_tool(if cfg!(windows) { "node.exe" } else { "node" }, &home_dir),
        npm: find_tool(if cfg!(windows) { "npm.cmd" } else { "npm" }, &home_dir),
        coven,
        engine_installed: engine,
        familiar_with_workspace: familiar,
    })
}
```

Check the engine status field name against the existing status code at `coven_runtime.rs:572-604` (it parses `coven engine status --json`); if that code reads a key other than `installed`, use the same key here.

- [ ] **Step 4: Run to verify it passes**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib setup::`
Expected: `test result: ok. 4 passed`

- [ ] **Step 5: Format, lint, commit**

Run: `corepack pnpm cargo:fmt && corepack pnpm cargo:clippy`

```bash
git add src-tauri/src/setup.rs
git commit -S -m "feat(native): detect Node, npm, Coven, engine and a usable familiar"
```

---

### Task 12: Setup commands with streamed install

**Files:**
- Modify: `src-tauri/src/setup.rs`
- Modify: `src-tauri/src/lib.rs` `generate_handler!`
- Modify: `src-tauri/capabilities/default.json`

- [ ] **Step 1: Write the failing test (streaming through the real helper with a fake tool)**

Append inside `mod tests`:

```rust
    #[cfg(unix)]
    #[test]
    fn run_step_streams_lines_and_reports_exit() {
        let root = std::env::temp_dir().join(uuid::Uuid::new_v4().to_string());
        std::fs::create_dir_all(&root).unwrap();
        let fake = root.join("npm");
        std::fs::write(&fake, "#!/bin/sh\necho installing \"$@\"\necho warn >&2\nexit 7\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let cancel = AtomicBool::new(false);
        let mut events = Vec::new();
        let code = run_step_with(Step::InstallCli, &fake, &root, &cancel, &mut |v| { events.push(v); Ok(()) }).unwrap();
        assert_eq!(code, 7);
        assert!(events.iter().any(|e| e["type"] == "stdout" && e["text"].as_str().unwrap().starts_with("installing install -g --prefix")));
        assert!(events.iter().any(|e| e["type"] == "stderr" && e["text"] == "warn"));
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --lib setup::run_step`
Expected: compile error — `run_step_with` not found.

- [ ] **Step 3: Implement**

Add to `setup.rs`:

```rust
use std::process::Command;
use tauri::{ipc::Channel, State};

use crate::coven_runtime::{execute_command_lines, CovenRuntimeState};

const INSTALL_TIMEOUT: Duration = Duration::from_secs(900);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RunInput {
    run_id: String,
    step: Step,
}

pub(crate) fn run_step_with(
    step: Step,
    tool: &Path,
    home: &Path,
    cancel: &AtomicBool,
    on_event: &mut dyn FnMut(Value) -> Result<(), String>,
) -> Result<i32, String> {
    let (program, args) = argv_for(step, tool, home);
    let mut command = Command::new(program);
    command.args(args).current_dir(home).env("NO_COLOR", "1");
    execute_command_lines(command, cancel, INSTALL_TIMEOUT, &mut |is_stderr, text| {
        on_event(json!({ "type": if is_stderr { "stderr" } else { "stdout" }, "text": text }))
    })
}

#[tauri::command]
pub(crate) async fn setup_check() -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(|| probe().map(|p| report_from(&p, cfg!(unix))))
        .await
        .map_err(|_| "Setup check worker failed.".to_string())?
}

#[tauri::command]
pub(crate) async fn setup_run(
    state: State<'_, CovenRuntimeState>,
    input: RunInput,
    on_event: Channel<Value>,
) -> Result<Value, String> {
    if !cfg!(unix) {
        return Err("Chat isn't available on Windows yet.".into());
    }
    let (cancel, registration) = state.register_run(&input.run_id)?;
    let home_dir = home()?;
    let tool = match input.step {
        Step::InstallCli => find_tool("npm", &home_dir).ok_or("npm was not found on this machine.")?,
        Step::InstallEngine => resolve_cli()?,
    };
    let step = input.step;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _registration = registration;
        let mut emit = |value: Value| on_event.send(value).map_err(|_| "Setup output channel closed.".to_string());
        run_step_with(step, &tool, &home_dir, &cancel, &mut emit)
    })
    .await
    .map_err(|_| "Setup worker failed.".to_string())?;
    match result {
        Ok(code) => Ok(json!({ "type": "exit", "code": code, "cancelled": false })),
        Err(message) if message == "Coven run cancelled." => Ok(json!({ "type": "exit", "code": -1, "cancelled": true })),
        Err(message) => Err(message),
    }
}

#[tauri::command]
pub(crate) fn setup_cancel(state: State<'_, CovenRuntimeState>, run_id: String) -> Result<(), String> {
    crate::coven_runtime::coven_runtime_cancel(state, run_id)
}
```

The `exit` payload is returned as the command result rather than sent on the channel so the webview gets it exactly once, after every streamed line.

- [ ] **Step 4: Register**

In `lib.rs` `generate_handler![ … ]` after the identity commands add:

```rust
            setup::setup_check,
            setup::setup_run,
            setup::setup_cancel,
```

In `capabilities/default.json` after `"allow-identity-sign-out",` add:

```json
    "allow-setup-check",
    "allow-setup-run",
    "allow-setup-cancel",
```

- [ ] **Step 5: Build, test, lint**

Run: `corepack pnpm cargo:fmt && corepack pnpm cargo:clippy && cargo test --manifest-path src-tauri/Cargo.toml --lib`
Expected: clean; all pass.

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/setup.rs src-tauri/src/lib.rs src-tauri/capabilities/default.json
git commit -S -m "feat(native): setup commands with streamed, cancellable assisted install"
```

---

### Task 13: Native gate under CI's exact flags

**Files:** none new.

- [ ] **Step 1: Run the CI command**

Run: `cargo test --manifest-path src-tauri/Cargo.toml --locked --release --features phase1-conformance --lib`
Expected: `test result: ok.` with every test passing (previously 215; now more).

- [ ] **Step 2: Run the Windows cross-check the `Rust` CI job performs**

Run: `corepack pnpm cargo:check:windows-gnu` (requires `rustup target add x86_64-pc-windows-gnu`; if the target is absent, note it in the PR and let the `ci:full` job cover it).
Expected: `Finished` with no errors — the `cfg!(unix)` branches must still compile on Windows.

No commit; this is a checkpoint.

---

### Task 14: JS identity client

**Files:**
- Create: `src/lib/identity.ts`
- Create: `src/lib/identity.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/lib/identity.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createIdentity } from './identity';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (event: unknown) => void = () => {};
  },
}));

describe('identity client', () => {
  it('reports unavailable outside the desktop shell without invoking', async () => {
    const invoke = vi.fn();
    const identity = createIdentity({ available: () => false, invoke });
    await expect(identity.status()).rejects.toThrow('requires the desktop app');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('accepts every documented status shape and nothing token-shaped', async () => {
    const invoke = vi.fn();
    const identity = createIdentity({ available: () => true, invoke });
    invoke.mockResolvedValue({ state: 'signed_out' });
    expect(await identity.status()).toEqual({ state: 'signed_out' });
    invoke.mockResolvedValue({ state: 'entitled', email: 'v@x', checkedAt: 1, graceUntil: 2 });
    expect((await identity.status()).state).toBe('entitled');
    for (const bad of [
      { state: 'nope' },
      { state: 'entitled', email: 5 },
      { state: 'entitled', email: 'v@x', checkedAt: 'soon' },
      { state: 'entitled', accessToken: 'leak' },
      'entitled',
      null,
    ]) {
      invoke.mockResolvedValue(bad);
      await expect(identity.status()).rejects.toThrow('invalid');
    }
  });

  it('streams sign-in events through a channel and returns the run id', async () => {
    const invoke = vi.fn().mockResolvedValue({ runId: 'r1' });
    const identity = createIdentity({ available: () => true, invoke });
    const seen: string[] = [];
    const result = await identity.signIn('r1', (event) => seen.push(event.type));
    expect(result).toEqual({ runId: 'r1' });
    const [command, args] = invoke.mock.calls[0];
    expect(command).toBe('identity_sign_in');
    expect(args.runId).toBe('r1');
    args.onEvent.onmessage({ type: 'waiting' });
    args.onEvent.onmessage({ type: 'done' });
    expect(seen).toEqual(['waiting', 'done']);
    expect(() => args.onEvent.onmessage({ nope: true })).toThrow('invalid');
  });

  it('bounds native error text and maps cancel and sign-out', async () => {
    const invoke = vi.fn().mockRejectedValue('x'.repeat(5000));
    const identity = createIdentity({ available: () => true, invoke });
    await expect(identity.status()).rejects.toThrow(/^x{2048}$/);
    invoke.mockResolvedValue(null);
    await identity.cancelSignIn('r1');
    expect(invoke).toHaveBeenLastCalledWith('identity_cancel_sign_in', { runId: 'r1' });
    await identity.signOut();
    expect(invoke).toHaveBeenLastCalledWith('identity_sign_out');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `corepack pnpm exec vitest run src/lib/identity.test.ts`
Expected: FAIL — cannot resolve `./identity`.

- [ ] **Step 3: Implement**

`src/lib/identity.ts`:

```ts
import { Channel, invoke } from '@tauri-apps/api/core';
import { canUseTauriCommands, type InvokeCommand } from './desktop-host';

export type IdentityState = 'signed_out' | 'entitled' | 'expired' | 'revoked';
export type IdentityStatus = {
  state: IdentityState;
  email?: string;
  checkedAt?: number;
  graceUntil?: number;
};
export type SignInEvent = { type: 'waiting' | 'received' | 'exchanged' | 'done' | 'error'; text?: string };
export interface Identity {
  status(): Promise<IdentityStatus>;
  signIn(runId: string, onEvent?: (event: SignInEvent) => void): Promise<{ runId: string }>;
  cancelSignIn(runId: string): Promise<void>;
  signOut(): Promise<void>;
}

const UNAVAILABLE =
  'Local Coven requires the desktop app. Install Coven CLI and open OpenCoven Chat.';
const STATES: readonly IdentityState[] = ['signed_out', 'entitled', 'expired', 'revoked'];
const SIGN_IN_EVENTS = ['waiting', 'received', 'exchanged', 'done', 'error'] as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function optionalText(value: unknown, limit = 4096): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= limit);
}
function optionalNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value));
}
/** Only the documented keys may appear; anything token-shaped is refused. */
function onlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function status(value: unknown): value is IdentityStatus {
  return (
    record(value) &&
    onlyKeys(value, ['state', 'email', 'checkedAt', 'graceUntil']) &&
    typeof value.state === 'string' &&
    STATES.includes(value.state as IdentityState) &&
    optionalText(value.email, 320) &&
    optionalNumber(value.checkedAt) &&
    optionalNumber(value.graceUntil)
  );
}
function signInEvent(value: unknown): value is SignInEvent {
  return (
    record(value) &&
    onlyKeys(value, ['type', 'text']) &&
    typeof value.type === 'string' &&
    (SIGN_IN_EVENTS as readonly string[]).includes(value.type) &&
    optionalText(value.text, 2048)
  );
}
function checked<T>(value: unknown, guard: (value: unknown) => value is T): T {
  if (!guard(value)) throw new Error('Coven returned an invalid native result.');
  return value;
}

export function createIdentity(
  options: { available?: () => boolean; invoke?: InvokeCommand } = {},
): Identity {
  const available = options.available ?? canUseTauriCommands;
  const invokeCommand = options.invoke ?? invoke;
  async function call(command: string, args?: Record<string, unknown>): Promise<unknown> {
    if (!available()) throw new Error(UNAVAILABLE);
    try {
      return args ? await invokeCommand(command, args) : await invokeCommand(command);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : typeof error === 'string' ? error : '';
      throw new Error(message.slice(0, 2048) || 'Sign-in operation failed.');
    }
  }
  return {
    async status() {
      return checked(await call('identity_status'), status);
    },
    async signIn(runId, onEvent) {
      if (!available()) throw new Error(UNAVAILABLE);
      const channel = new Channel<SignInEvent>();
      channel.onmessage = (value) => onEvent?.(checked(value, signInEvent));
      return checked(
        await call('identity_sign_in', { runId, onEvent: channel }),
        (v): v is { runId: string } => record(v) && v.runId === runId,
      );
    },
    async cancelSignIn(runId) {
      await call('identity_cancel_sign_in', { runId });
    },
    async signOut() {
      await call('identity_sign_out');
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `corepack pnpm exec vitest run src/lib/identity.test.ts`
Expected: `4 passed`

- [ ] **Step 5: Lint, typecheck, commit**

Run: `corepack pnpm lint && corepack pnpm typecheck`

```bash
git add src/lib/identity.ts src/lib/identity.test.ts
git commit -S -m "feat(web): identity client with strict status guards"
```

---

### Task 15: JS setup client

**Files:**
- Create: `src/lib/setup.ts`
- Create: `src/lib/setup.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/lib/setup.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createSetup } from './setup';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (event: unknown) => void = () => {};
  },
}));

const ok = { ok: true };
const full = { platform: ok, node: ok, npm: ok, coven: { ok: true, path: '/x/coven' }, engine: ok, familiar: ok };

describe('setup client', () => {
  it('validates the six-row report and rejects extra or malformed rows', async () => {
    const invoke = vi.fn().mockResolvedValue(full);
    const setup = createSetup({ available: () => true, invoke });
    expect(await setup.check()).toEqual(full);
    for (const bad of [
      { ...full, node: { ok: 'yes' } },
      { ...full, extra: ok },
      { ...full, coven: { ok: false } },
      { ...full, coven: { ok: false, detail: 7 } },
      { platform: ok },
    ]) {
      invoke.mockResolvedValue(bad);
      await expect(setup.check()).rejects.toThrow('invalid');
    }
  });

  it('runs a step, streams lines, and returns the exit event', async () => {
    const invoke = vi.fn().mockResolvedValue({ type: 'exit', code: 0, cancelled: false });
    const setup = createSetup({ available: () => true, invoke });
    const lines: string[] = [];
    const exit = await setup.run('r2', 'install_cli', (e) => lines.push(`${e.type}:${e.text}`));
    expect(exit).toEqual({ type: 'exit', code: 0, cancelled: false });
    const [command, args] = invoke.mock.calls[0];
    expect(command).toBe('setup_run');
    expect(args.input).toEqual({ runId: 'r2', step: 'install_cli' });
    args.onEvent.onmessage({ type: 'stdout', text: 'added 1 package' });
    args.onEvent.onmessage({ type: 'stderr', text: 'warn' });
    expect(lines).toEqual(['stdout:added 1 package', 'stderr:warn']);
    expect(() => args.onEvent.onmessage({ type: 'exit', code: 1 })).toThrow('invalid');
    invoke.mockResolvedValue({ type: 'exit', code: 'zero' });
    await expect(setup.run('r3', 'install_engine')).rejects.toThrow('invalid');
  });

  it('exposes the exact display commands and maps cancel', async () => {
    const invoke = vi.fn().mockResolvedValue(null);
    const setup = createSetup({ available: () => true, invoke });
    expect(setup.displayCommand('install_cli')).toBe('npm install -g --prefix ~/.local @opencoven/cli');
    expect(setup.displayCommand('install_engine')).toBe('coven engine install');
    await setup.cancel('r2');
    expect(invoke).toHaveBeenLastCalledWith('setup_cancel', { runId: 'r2' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `corepack pnpm exec vitest run src/lib/setup.test.ts`
Expected: FAIL — cannot resolve `./setup`.

- [ ] **Step 3: Implement**

`src/lib/setup.ts`:

```ts
import { Channel, invoke } from '@tauri-apps/api/core';
import { canUseTauriCommands, type InvokeCommand } from './desktop-host';

export type SetupRow = { ok: boolean; detail?: string; path?: string };
export type SetupRowKey = 'platform' | 'node' | 'npm' | 'coven' | 'engine' | 'familiar';
export type SetupReport = Record<SetupRowKey, SetupRow>;
export type SetupStep = 'install_cli' | 'install_engine';
export type SetupLine = { type: 'stdout' | 'stderr'; text: string };
export type SetupExit = { type: 'exit'; code: number; cancelled: boolean };
export interface Setup {
  check(): Promise<SetupReport>;
  run(runId: string, step: SetupStep, onLine?: (line: SetupLine) => void): Promise<SetupExit>;
  cancel(runId: string): Promise<void>;
  displayCommand(step: SetupStep): string;
}

const UNAVAILABLE =
  'Local Coven requires the desktop app. Install Coven CLI and open OpenCoven Chat.';
export const ROW_KEYS: readonly SetupRowKey[] = ['platform', 'node', 'npm', 'coven', 'engine', 'familiar'];
const DISPLAY: Record<SetupStep, string> = {
  install_cli: 'npm install -g --prefix ~/.local @opencoven/cli',
  install_engine: 'coven engine install',
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function optionalText(value: unknown, limit = 2048): boolean {
  return value === undefined || (typeof value === 'string' && value.length <= limit);
}
function row(value: unknown): value is SetupRow {
  return (
    record(value) &&
    Object.keys(value).every((k) => ['ok', 'detail', 'path'].includes(k)) &&
    typeof value.ok === 'boolean' &&
    (value.ok || typeof value.detail === 'string') &&
    optionalText(value.detail) &&
    optionalText(value.path, 4096)
  );
}
function report(value: unknown): value is SetupReport {
  return (
    record(value) &&
    Object.keys(value).length === ROW_KEYS.length &&
    ROW_KEYS.every((key) => row(value[key]))
  );
}
function line(value: unknown): value is SetupLine {
  return (
    record(value) &&
    Object.keys(value).every((k) => ['type', 'text'].includes(k)) &&
    (value.type === 'stdout' || value.type === 'stderr') &&
    typeof value.text === 'string' &&
    value.text.length <= 2048
  );
}
function exit(value: unknown): value is SetupExit {
  return (
    record(value) &&
    value.type === 'exit' &&
    typeof value.code === 'number' &&
    Number.isInteger(value.code) &&
    typeof value.cancelled === 'boolean'
  );
}
function checked<T>(value: unknown, guard: (value: unknown) => value is T): T {
  if (!guard(value)) throw new Error('Coven returned an invalid native result.');
  return value;
}

export function createSetup(
  options: { available?: () => boolean; invoke?: InvokeCommand } = {},
): Setup {
  const available = options.available ?? canUseTauriCommands;
  const invokeCommand = options.invoke ?? invoke;
  async function call(command: string, args?: Record<string, unknown>): Promise<unknown> {
    if (!available()) throw new Error(UNAVAILABLE);
    try {
      return args ? await invokeCommand(command, args) : await invokeCommand(command);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : typeof error === 'string' ? error : '';
      throw new Error(message.slice(0, 2048) || 'Setup operation failed.');
    }
  }
  return {
    async check() {
      return checked(await call('setup_check'), report);
    },
    async run(runId, step, onLine) {
      if (!available()) throw new Error(UNAVAILABLE);
      const channel = new Channel<SetupLine>();
      channel.onmessage = (value) => onLine?.(checked(value, line));
      return checked(await call('setup_run', { input: { runId, step }, onEvent: channel }), exit);
    },
    async cancel(runId) {
      await call('setup_cancel', { runId });
    },
    displayCommand(step) {
      return DISPLAY[step];
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `corepack pnpm exec vitest run src/lib/setup.test.ts`
Expected: `3 passed`

- [ ] **Step 5: Lint, typecheck, commit**

Run: `corepack pnpm lint && corepack pnpm typecheck`

```bash
git add src/lib/setup.ts src/lib/setup.test.ts
git commit -S -m "feat(web): setup client with report, streamed run and display commands"
```

---

### Task 16: Account row in the sidebar

**Files:**
- Modify: `src/coven/chat-layout.tsx:53-60` (props) and `:271-288` (User settings)
- Modify: `src/coven/chat-app.tsx:96` (props) and `:472` (pass-through)
- Test: `src/coven/chat-layout.test.tsx` (append)

- [ ] **Step 1: Write the failing test**

Append to `src/coven/chat-layout.test.tsx` (use the file's existing `render` helper / base props; if it exposes a `baseProps` constant, spread it):

```tsx
  it('shows the signed-in account and sign-out inside User settings when provided', () => {
    const onSignOut = vi.fn();
    render(
      <ChatLayout
        {...baseProps}
        onArchivedFilter={() => {}}
        account={{ email: 'val@example.com', onSignOut }}
      />,
    );
    fireEvent.click(screen.getByText('User settings'));
    expect(screen.getByText('Signed in as val@example.com')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
  });

  it('renders the account row even when archive filtering is unavailable', () => {
    render(<ChatLayout {...baseProps} account={{ email: 'v@x', onSignOut: () => {} }} />);
    fireEvent.click(screen.getByText('User settings'));
    expect(screen.getByText('Signed in as v@x')).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `corepack pnpm exec vitest run src/coven/chat-layout.test.tsx`
Expected: FAIL — type error on `account` / text not found.

- [ ] **Step 3: Implement**

In `ChatLayoutProps` (after `onLifecycle?`):

```ts
  /** Signed-in person; absent when the surface is not gated. */
  account?: { email: string; onSignOut: () => void };
```

Replace the User settings block (lines 271–288) with:

```tsx
          <div className="fr-sidebar-foot coven-user-settings">
            {props.onArchivedFilter || props.account ? (
              <details>
                <summary>User settings</summary>
                {props.onArchivedFilter ? (
                  <label>
                    <input
                      type="checkbox"
                      checked={Boolean(props.archivedFilter)}
                      disabled={props.lifecycleBusy}
                      onChange={(event) => props.onArchivedFilter?.(event.target.checked)}
                    />
                    Show archived chats
                  </label>
                ) : null}
                {props.account ? (
                  <div className="coven-account-row">
                    <span>Signed in as {props.account.email}</span>
                    <button type="button" onClick={props.account.onSignOut}>
                      Sign out
                    </button>
                  </div>
                ) : null}
              </details>
            ) : (
              'Coven CLI'
            )}
          </div>
```

In `src/coven/chat-app.tsx` line 96:

```tsx
export function ChatApp({
  runtime = defaultRuntime,
  account,
}: {
  runtime?: CovenRuntime;
  account?: { email: string; onSignOut: () => void };
}) {
```

and where `<ChatLayout` is rendered (near line 472) add `account={account}`.

In `src/coven/chat-app.css` after the `.coven-user-settings label` rule (line 210) add:

```css
.coven-account-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 6px;
  color: var(--text-secondary);
  font-size: 12px;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `corepack pnpm exec vitest run src/coven/chat-layout.test.tsx src/coven/chat-app.test.tsx`
Expected: all pass.

- [ ] **Step 5: Lint, typecheck, commit**

Run: `corepack pnpm lint && corepack pnpm typecheck`

```bash
git add src/coven/chat-layout.tsx src/coven/chat-app.tsx src/coven/chat-app.css src/coven/chat-layout.test.tsx
git commit -S -m "feat(web): optional account row with sign-out in User settings"
```

---

### Task 17: Onboarding state machine (logic only)

**Files:**
- Create: `src/onboarding/machine.ts`
- Create: `src/onboarding/machine.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/onboarding/machine.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { next, type Phase } from './machine';

const ok = { ok: true };
const green = { platform: ok, node: ok, npm: ok, coven: ok, engine: ok, familiar: ok };

describe('onboarding machine', () => {
  it('maps status and report to a phase', () => {
    expect(next({ kind: 'unavailable' })).toEqual<Phase>({ phase: 'unavailable' });
    expect(next({ kind: 'status', status: { state: 'signed_out' } })).toEqual<Phase>({ phase: 'sign_in', reason: '' });
    expect(next({ kind: 'status', status: { state: 'expired' } })).toEqual<Phase>({ phase: 'sign_in', reason: 'Your sign-in has expired. Sign in again.' });
    expect(next({ kind: 'status', status: { state: 'revoked' } })).toEqual<Phase>({ phase: 'sign_in', reason: 'Access was revoked. Sign in again.' });
    expect(next({ kind: 'status', status: { state: 'entitled', email: 'v@x' } })).toEqual<Phase>({ phase: 'checking_setup', email: 'v@x' });
    expect(next({ kind: 'report', email: 'v@x', report: green })).toEqual<Phase>({ phase: 'ready', email: 'v@x' });
    expect(next({ kind: 'report', email: 'v@x', report: { ...green, platform: { ok: false, detail: 'win' } } })).toEqual<Phase>({ phase: 'unsupported', email: 'v@x' });
    expect(next({ kind: 'report', email: 'v@x', report: { ...green, coven: { ok: false, detail: 'missing' } } })).toEqual<Phase>({ phase: 'prerequisites', email: 'v@x', report: { ...green, coven: { ok: false, detail: 'missing' } } });
    expect(next({ kind: 'error', text: 'boom' })).toEqual<Phase>({ phase: 'error', text: 'boom' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `corepack pnpm exec vitest run src/onboarding/machine.test.ts`
Expected: FAIL — cannot resolve `./machine`.

- [ ] **Step 3: Implement**

`src/onboarding/machine.ts`:

```ts
import type { IdentityStatus } from '../lib/identity';
import type { SetupReport } from '../lib/setup';

export type Phase =
  | { phase: 'checking' }
  | { phase: 'unavailable' }
  | { phase: 'sign_in'; reason: string }
  | { phase: 'checking_setup'; email: string }
  | { phase: 'prerequisites'; email: string; report: SetupReport }
  | { phase: 'unsupported'; email: string }
  | { phase: 'ready'; email: string }
  | { phase: 'error'; text: string };

export type Input =
  | { kind: 'unavailable' }
  | { kind: 'status'; status: IdentityStatus }
  | { kind: 'report'; email: string; report: SetupReport }
  | { kind: 'error'; text: string };

const REASONS: Record<IdentityStatus['state'], string> = {
  signed_out: '',
  expired: 'Your sign-in has expired. Sign in again.',
  revoked: 'Access was revoked. Sign in again.',
  entitled: '',
};

/** Pure: the next phase for an input. Rendering lives in onboarding.tsx. */
export function next(input: Input): Phase {
  switch (input.kind) {
    case 'unavailable':
      return { phase: 'unavailable' };
    case 'error':
      return { phase: 'error', text: input.text };
    case 'status':
      return input.status.state === 'entitled'
        ? { phase: 'checking_setup', email: input.status.email ?? '' }
        : { phase: 'sign_in', reason: REASONS[input.status.state] };
    case 'report': {
      const { email, report } = input;
      if (!report.platform.ok) return { phase: 'unsupported', email };
      const allOk = (Object.keys(report) as (keyof SetupReport)[]).every((k) => report[k].ok);
      return allOk ? { phase: 'ready', email } : { phase: 'prerequisites', email, report };
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `corepack pnpm exec vitest run src/onboarding/machine.test.ts`
Expected: `1 passed`

- [ ] **Step 5: Commit**

```bash
git add src/onboarding/machine.ts src/onboarding/machine.test.ts
git commit -S -m "feat(web): pure onboarding phase transitions"
```

---

### Task 18: Onboarding surface

**Files:**
- Create: `src/onboarding/onboarding.tsx`
- Create: `src/onboarding/onboarding.css`
- Create: `src/onboarding/onboarding.test.tsx`

- [ ] **Step 1: Write the failing tests**

`src/onboarding/onboarding.test.tsx`:

```tsx
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Identity } from '../lib/identity';
import type { Setup } from '../lib/setup';
import { Onboarding } from './onboarding';

vi.mock('../coven/chat-app', () => ({
  ChatApp: ({ account }: { account?: { email: string } }) => (
    <div data-testid="chat-app">chat for {account?.email}</div>
  ),
}));

const ok = { ok: true };
const green = { platform: ok, node: ok, npm: ok, coven: ok, engine: ok, familiar: ok };

function fakes(overrides: { identity?: Partial<Identity>; setup?: Partial<Setup> } = {}) {
  const identity: Identity = {
    status: vi.fn().mockResolvedValue({ state: 'signed_out' }),
    signIn: vi.fn().mockResolvedValue({ runId: 'r' }),
    cancelSignIn: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    ...overrides.identity,
  };
  const setup: Setup = {
    check: vi.fn().mockResolvedValue(green),
    run: vi.fn().mockResolvedValue({ type: 'exit', code: 0, cancelled: false }),
    cancel: vi.fn().mockResolvedValue(undefined),
    displayCommand: (s) => (s === 'install_cli' ? 'npm install -g --prefix ~/.local @opencoven/cli' : 'coven engine install'),
    ...overrides.setup,
  };
  return { identity, setup };
}

describe('Onboarding', () => {
  it('shows the desktop notice outside Tauri and never calls native', async () => {
    const { identity, setup } = fakes();
    render(<Onboarding identity={identity} setup={setup} available={() => false} />);
    expect(await screen.findByText(/requires the desktop app/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sign in/ })).toBeNull();
    expect(identity.status).not.toHaveBeenCalled();
  });

  it('offers sign-in when signed out and streams progress', async () => {
    const { identity, setup } = fakes();
    render(<Onboarding identity={identity} setup={setup} available={() => true} />);
    const button = await screen.findByRole('button', { name: 'Sign in with WorkOS' });
    (identity.status as ReturnType<typeof vi.fn>).mockResolvedValue({ state: 'entitled', email: 'v@x' });
    fireEvent.click(button);
    await waitFor(() => expect(identity.signIn).toHaveBeenCalled());
    const onEvent = (identity.signIn as ReturnType<typeof vi.fn>).mock.calls[0][1];
    act(() => onEvent({ type: 'waiting' }));
    expect(screen.getByText('Waiting for your browser…')).toBeInTheDocument();
    expect(await screen.findByTestId('chat-app')).toHaveTextContent('chat for v@x');
  });

  it('explains expiry and revocation on the sign-in screen', async () => {
    for (const [state, text] of [
      ['expired', 'Your sign-in has expired. Sign in again.'],
      ['revoked', 'Access was revoked. Sign in again.'],
    ] as const) {
      const { identity, setup } = fakes({ identity: { status: vi.fn().mockResolvedValue({ state }) } });
      const { unmount } = render(<Onboarding identity={identity} setup={setup} available={() => true} />);
      expect(await screen.findByText(text)).toBeInTheDocument();
      unmount();
    }
  });

  it('renders prerequisites with a Run button only for coven and engine', async () => {
    const report = {
      ...green,
      node: { ok: false, detail: 'Node.js was not found on this machine.' },
      coven: { ok: false, detail: 'Coven CLI was not found.' },
    };
    const { identity, setup } = fakes({
      identity: { status: vi.fn().mockResolvedValue({ state: 'entitled', email: 'v@x' }) },
      setup: { check: vi.fn().mockResolvedValueOnce(report).mockResolvedValue(green) },
    });
    render(<Onboarding identity={identity} setup={setup} available={() => true} />);
    expect(await screen.findByText('Node.js was not found on this machine.')).toBeInTheDocument();
    expect(screen.getByText('npm install -g --prefix ~/.local @opencoven/cli')).toBeInTheDocument();
    const runs = screen.getAllByRole('button', { name: 'Run' });
    expect(runs).toHaveLength(1);
    fireEvent.click(runs[0]);
    await waitFor(() => expect(setup.run).toHaveBeenCalledWith(expect.any(String), 'install_cli', expect.any(Function)));
    const onLine = (setup.run as ReturnType<typeof vi.fn>).mock.calls[0][2];
    act(() => onLine({ type: 'stdout', text: 'added 12 packages' }));
    expect(screen.getByText('added 12 packages')).toBeInTheDocument();
    expect(await screen.findByTestId('chat-app')).toBeInTheDocument();
  });

  it('shows exit code and last lines on a failed install', async () => {
    const report = { ...green, engine: { ok: false, detail: 'The Coven engine is not installed.' } };
    const { identity, setup } = fakes({
      identity: { status: vi.fn().mockResolvedValue({ state: 'entitled', email: 'v@x' }) },
      setup: { check: vi.fn().mockResolvedValue(report), run: vi.fn().mockResolvedValue({ type: 'exit', code: 2, cancelled: false }) },
    });
    render(<Onboarding identity={identity} setup={setup} available={() => true} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run' }));
    expect(await screen.findByText('Exited with code 2.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run again' })).toBeInTheDocument();
  });

  it('shows the Windows state without any install control', async () => {
    const { identity, setup } = fakes({
      identity: { status: vi.fn().mockResolvedValue({ state: 'entitled', email: 'v@x' }) },
      setup: { check: vi.fn().mockResolvedValue({ ...green, platform: { ok: false, detail: "Chat isn't available on Windows yet." } }) },
    });
    render(<Onboarding identity={identity} setup={setup} available={() => true} />);
    expect(await screen.findByText("Chat isn't available on Windows yet.")).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run' })).toBeNull();
  });

  it('surfaces keychain errors with retry and never bypasses the gate', async () => {
    const { identity, setup } = fakes({
      identity: { status: vi.fn().mockRejectedValueOnce(new Error("Can't read the system keychain. Unlock it and retry.")).mockResolvedValue({ state: 'signed_out' }) },
    });
    render(<Onboarding identity={identity} setup={setup} available={() => true} />);
    expect(await screen.findByText("Can't read the system keychain. Unlock it and retry.")).toBeInTheDocument();
    expect(screen.queryByTestId('chat-app')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('button', { name: 'Sign in with WorkOS' })).toBeInTheDocument();
  });

  it('passes a working sign-out to the chat and returns to sign-in', async () => {
    const { identity, setup } = fakes({
      identity: { status: vi.fn().mockResolvedValueOnce({ state: 'entitled', email: 'v@x' }).mockResolvedValue({ state: 'signed_out' }) },
    });
    render(<Onboarding identity={identity} setup={setup} available={() => true} />);
    await screen.findByTestId('chat-app');
    fireEvent.click(screen.getByRole('button', { name: 'mock-sign-out' }));
    await waitFor(() => expect(identity.signOut).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('button', { name: 'Sign in with WorkOS' })).toBeInTheDocument();
  });
});
```

For that last test to drive sign-out, make the `ChatApp` mock at the top of the file render the callback it receives:

```tsx
vi.mock('../coven/chat-app', () => ({
  ChatApp: ({ account }: { account?: { email: string; onSignOut: () => void } }) => (
    <div data-testid="chat-app">
      chat for {account?.email}
      <button type="button" onClick={account?.onSignOut}>mock-sign-out</button>
    </div>
  ),
}));
```

Eight tests in total.

- [ ] **Step 2: Run to verify it fails**

Run: `corepack pnpm exec vitest run src/onboarding/onboarding.test.tsx`
Expected: FAIL — cannot resolve `./onboarding`.

- [ ] **Step 3: Implement the surface**

`src/onboarding/onboarding.css` (tokens only; no hex literals):

```css
.ob-shell {
  display: grid;
  place-items: center;
  height: 100%;
  padding: 24px;
}
.ob-card {
  width: min(560px, 100%);
  display: grid;
  gap: 16px;
  padding: 24px;
  border: 1px solid var(--border-hairline);
  border-radius: var(--radius-control, 8px);
  background: var(--surface-raised);
}
.ob-card h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
.ob-muted {
  color: var(--text-muted);
  font-size: 13px;
}
.ob-rows {
  display: grid;
  gap: 10px;
}
.ob-row {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--border-hairline);
  border-radius: 6px;
}
.ob-row[data-ok='true'] {
  border-color: var(--color-success);
}
.ob-row-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ob-cmd {
  font-family: var(--font-jetbrains-mono, ui-monospace, monospace);
  font-size: 12px;
  padding: 6px 8px;
  border-radius: 4px;
  background: var(--surface-base);
  overflow-x: auto;
}
.ob-log {
  max-height: 160px;
  overflow: auto;
  margin: 0;
  font-family: var(--font-jetbrains-mono, ui-monospace, monospace);
  font-size: 11px;
  color: var(--text-secondary);
  white-space: pre-wrap;
}
.ob-error {
  color: var(--color-danger);
  font-size: 13px;
}
```

`src/onboarding/onboarding.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChatApp } from '../coven/chat-app';
import { canUseTauriCommands } from '../lib/desktop-host';
import { createIdentity, type Identity, type SignInEvent } from '../lib/identity';
import { createSetup, ROW_KEYS, type Setup, type SetupLine, type SetupReport, type SetupRowKey, type SetupStep } from '../lib/setup';
import { next, type Phase } from './machine';
import './onboarding.css';

const UNAVAILABLE =
  'Local Coven requires the desktop app. Install Coven CLI and open OpenCoven Chat.';
const LABELS: Record<SetupRowKey, string> = {
  platform: 'Supported platform',
  node: 'Node.js',
  npm: 'npm',
  coven: 'Coven CLI',
  engine: 'Coven engine',
  familiar: 'A familiar with a workspace',
};
const STEP_FOR: Partial<Record<SetupRowKey, SetupStep>> = { coven: 'install_cli', engine: 'install_engine' };
const PROGRESS: Record<SignInEvent['type'], string> = {
  waiting: 'Waiting for your browser…',
  received: 'Finishing sign-in…',
  exchanged: 'Saving your session…',
  done: 'Signed in.',
  error: '',
};
const LAST_LINES = 40;

function runId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

type RunState = { runId: string; lines: string[]; exit?: { code: number; cancelled: boolean }; error?: string };

export function Onboarding({
  identity: identityOverride,
  setup: setupOverride,
  available = canUseTauriCommands,
}: {
  identity?: Identity;
  setup?: Setup;
  available?: () => boolean;
}) {
  const identity = useRef(identityOverride ?? createIdentity()).current;
  const setup = useRef(setupOverride ?? createSetup()).current;
  const [phase, setPhase] = useState<Phase>({ phase: 'checking' });
  const [progress, setProgress] = useState('');
  const [runs, setRuns] = useState<Partial<Record<SetupRowKey, RunState>>>({});

  const check = useCallback(async () => {
    if (!available()) {
      setPhase(next({ kind: 'unavailable' }));
      return;
    }
    try {
      const status = await identity.status();
      const after = next({ kind: 'status', status });
      setPhase(after);
      if (after.phase === 'checking_setup') {
        const report = await setup.check();
        setPhase(next({ kind: 'report', email: after.email, report }));
      }
    } catch (error) {
      setPhase(next({ kind: 'error', text: error instanceof Error ? error.message : String(error) }));
    }
  }, [available, identity, setup]);

  useEffect(() => {
    void check();
  }, [check]);

  async function signIn() {
    setProgress('');
    try {
      await identity.signIn(runId('signin'), (event) => setProgress(PROGRESS[event.type] || event.text || ''));
      await check();
    } catch (error) {
      setProgress('');
      setPhase({ phase: 'sign_in', reason: error instanceof Error ? error.message : String(error) });
    }
  }

  async function signOut() {
    await identity.signOut();
    setRuns({});
    await check();
  }

  async function run(key: SetupRowKey, step: SetupStep) {
    const id = runId(step);
    setRuns((r) => ({ ...r, [key]: { runId: id, lines: [] } }));
    try {
      const exit = await setup.run(id, step, (line: SetupLine) =>
        setRuns((r) => {
          const current = r[key] ?? { runId: id, lines: [] };
          return { ...r, [key]: { ...current, lines: [...current.lines, line.text].slice(-LAST_LINES) } };
        }),
      );
      setRuns((r) => ({ ...r, [key]: { ...(r[key] ?? { runId: id, lines: [] }), exit } }));
      if (exit.code === 0 && phase.phase === 'prerequisites') {
        const report = await setup.check();
        setPhase(next({ kind: 'report', email: phase.email, report }));
      }
    } catch (error) {
      setRuns((r) => ({ ...r, [key]: { ...(r[key] ?? { runId: id, lines: [] }), error: error instanceof Error ? error.message : String(error) } }));
    }
  }

  if (phase.phase === 'ready') {
    return <ChatApp account={{ email: phase.email, onSignOut: () => void signOut() }} />;
  }

  return (
    <div className="ob-shell">
      <div className="ob-card" role="region" aria-label="Onboarding">
        {phase.phase === 'checking' || phase.phase === 'checking_setup' ? (
          <p className="ob-muted">Checking your sign-in…</p>
        ) : null}

        {phase.phase === 'unavailable' ? <p className="ob-muted">{UNAVAILABLE}</p> : null}

        {phase.phase === 'error' ? (
          <>
            <p className="ob-error">{phase.text}</p>
            <button type="button" onClick={() => void check()}>Retry</button>
          </>
        ) : null}

        {phase.phase === 'sign_in' ? (
          <>
            <h1>Sign in to OpenCoven Chat</h1>
            {phase.reason ? <p className="ob-error">{phase.reason}</p> : null}
            <p className="ob-muted">Your familiars and conversations stay on this machine. Signing in confirms your OpenCoven account.</p>
            <button type="button" onClick={() => void signIn()}>Sign in with WorkOS</button>
            {progress ? <p className="ob-muted">{progress}</p> : null}
          </>
        ) : null}

        {phase.phase === 'unsupported' ? (
          <>
            <h1>Chat isn't available on Windows yet.</h1>
            <p className="ob-muted">OpenCoven Chat runs on macOS and Linux today. Signed in as {phase.email}.</p>
            <button type="button" onClick={() => void signOut()}>Sign out</button>
          </>
        ) : null}

        {phase.phase === 'prerequisites' ? (
          <>
            <h1>Almost there</h1>
            <p className="ob-muted">Signed in as {phase.email}. A few things need setting up before you can chat.</p>
            <div className="ob-rows">
              {ROW_KEYS.map((key) => {
                const row = phase.report[key];
                const step = STEP_FOR[key];
                const state = runs[key];
                const canRun = !row.ok && step !== undefined && phase.report.npm.ok && phase.report.node.ok;
                return (
                  <div key={key} className="ob-row" data-ok={row.ok}>
                    <div className="ob-row-head">
                      <strong>{LABELS[key]}</strong>
                      <span className="ob-muted">{row.ok ? 'Ready' : 'Needed'}</span>
                    </div>
                    {!row.ok && row.detail ? <span className="ob-muted">{row.detail}</span> : null}
                    {!row.ok && step ? (
                      <>
                        <code className="ob-cmd">{setup.displayCommand(step)}</code>
                        {canRun ? (
                          <button type="button" disabled={Boolean(state && !state.exit && !state.error)} onClick={() => void run(key, step)}>
                            {state?.exit && state.exit.code !== 0 ? 'Run again' : 'Run'}
                          </button>
                        ) : null}
                        {state?.lines.length ? <pre className="ob-log">{state.lines.join('\n')}</pre> : null}
                        {state?.exit && state.exit.code !== 0 && !state.exit.cancelled ? (
                          <span className="ob-error">Exited with code {state.exit.code}.</span>
                        ) : null}
                        {state?.exit?.cancelled ? <span className="ob-muted">Cancelled.</span> : null}
                        {state?.error ? <span className="ob-error">{state.error}</span> : null}
                      </>
                    ) : null}
                    {!row.ok && (key === 'node' || key === 'npm') ? (
                      <a href="https://nodejs.org/en/download" target="_blank" rel="noopener noreferrer">
                        Install Node.js
                      </a>
                    ) : null}
                  </div>
                );
              })}
            </div>
            <button type="button" onClick={() => void check()}>Check again</button>
          </>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `corepack pnpm exec vitest run src/onboarding/onboarding.test.tsx`
Expected: `7 passed`

- [ ] **Step 5: Lint, typecheck, commit**

Run: `corepack pnpm lint && corepack pnpm typecheck`

```bash
git add src/onboarding
git commit -S -m "feat(web): onboarding surface with sign-in and assisted prerequisites"
```

---

### Task 19: Entrypoint and the moved guard assertion

**Files:**
- Modify: `src/main.tsx:6,17-21`
- Modify: `src/single-entrypoint.test.ts:8-10`

- [ ] **Step 1: Update the guard first (it must fail, then pass)**

Replace lines 8–10 of `src/single-entrypoint.test.ts` with:

```ts
  expect(entrypoint).toContain("from './onboarding/onboarding'");
  expect(entrypoint).not.toContain("from './coven/chat-app'");
  expect(entrypoint).not.toMatch(/VITE_DEFAULT_DEMO|URLSearchParams|surfaceFor/);
  expect(entrypoint).not.toMatch(/import\(['"]\.\/demo\/|from ['"]\.\/app['"]/);
  const onboarding = readFileSync('src/onboarding/onboarding.tsx', 'utf8');
  expect(onboarding).toContain("from '../coven/chat-app'");
```

Run: `corepack pnpm exec vitest run src/single-entrypoint.test.ts`
Expected: FAIL — `main.tsx` still imports `./coven/chat-app`.

- [ ] **Step 2: Switch the entrypoint**

In `src/main.tsx` replace the `ChatApp` import and render:

```tsx
import { Onboarding } from './onboarding/onboarding';
```

```tsx
createRoot(rootElement).render(
  <StrictMode>
    <Onboarding />
  </StrictMode>,
);
```

- [ ] **Step 3: Run to verify it passes, then the whole suite**

Run: `corepack pnpm exec vitest run src/single-entrypoint.test.ts && corepack pnpm test:unit:normal`
Expected: all pass.

- [ ] **Step 4: Build**

Run: `corepack pnpm build`
Expected: `✓ built`; the bundle now includes `onboarding`.

- [ ] **Step 5: Commit**

```bash
git add src/main.tsx src/single-entrypoint.test.ts
git commit -S -m "feat(web): gate the entrypoint behind onboarding"
```

---

### Task 20: IPC-boundary guard test

**Files:**
- Create: `src/ipc-boundary.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';

const FORBIDDEN = ['access_token', 'refresh_token', 'accessToken', 'refreshToken', 'code_verifier'];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx|css)$/.test(name) && !name.endsWith('ipc-boundary.test.ts')) out.push(path);
  }
  return out;
}

test('no token identifier appears anywhere in the webview source', () => {
  const offenders = walk('src').flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    return FORBIDDEN.filter((word) => text.includes(word)).map((word) => `${file}: ${word}`);
  });
  expect(offenders).toEqual([]);
});
```

- [ ] **Step 2: Run**

Run: `corepack pnpm exec vitest run src/ipc-boundary.test.ts`
Expected: `1 passed`. If it lists offenders, remove the identifier from the webview — it has no legitimate use there.

- [ ] **Step 3: Commit**

```bash
git add src/ipc-boundary.test.ts
git commit -S -m "test(web): forbid token identifiers in the webview source"
```

---

### Task 21: Capabilities guard test

**Files:**
- Create: `src/capabilities.test.ts`

- [ ] **Step 1: Write the test**

```ts
import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

test('capabilities grant exactly the seven onboarding permissions', () => {
  const capability = JSON.parse(readFileSync('src-tauri/capabilities/default.json', 'utf8'));
  const granted: string[] = capability.permissions;
  const expected = [
    'allow-identity-status',
    'allow-identity-sign-in',
    'allow-identity-cancel-sign-in',
    'allow-identity-sign-out',
    'allow-setup-check',
    'allow-setup-run',
    'allow-setup-cancel',
  ];
  for (const permission of expected) expect(granted).toContain(permission);
  const onboarding = granted.filter((p) => p.startsWith('allow-identity-') || p.startsWith('allow-setup-'));
  expect(onboarding.sort()).toEqual([...expected].sort());
});
```

- [ ] **Step 2: Run, commit**

Run: `corepack pnpm exec vitest run src/capabilities.test.ts`
Expected: `1 passed`

```bash
git add src/capabilities.test.ts
git commit -S -m "test(web): pin the onboarding capability grants"
```

---

### Task 22: Client id configuration

**Files:**
- Modify: `src-tauri/tauri.conf.json`

- [ ] **Step 1: Add the public client id under `plugins`**

Add a top-level `"plugins"` object (or extend it if present):

```json
  "plugins": {
    "workos": {
      "clientId": "client_REPLACE_WITH_THE_ENVIRONMENT_CLIENT_ID"
    }
  }
```

The real value comes from the WorkOS dashboard (Environment → API keys → Client ID). It is public; it is not a secret.

- [ ] **Step 2: Verify the config still validates and the app boots**

Run: `corepack pnpm exec tauri build --debug --no-bundle 2>&1 | tail -3`
Expected: builds; `Finished`.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/tauri.conf.json
git commit -S -m "config: WorkOS client id under plugins.workos"
```

---

### Task 23: Manual checklist and README

**Files:**
- Create: `docs/onboarding-manual-checks.md`
- Modify: `README.md` (the intro paragraph that says "You don't need Cave, pairing, or a separate demo build")

- [ ] **Step 1: Write the checklist**

```markdown
# Onboarding manual checks

These two paths cannot be automated honestly and must be run by a person
before a release that touches sign-in or setup.

## WorkOS dashboard prerequisites (once per environment)

- Redirect URIs: add the non-wildcard default `http://127.0.0.1:1/callback`
  **and** the wildcard-port entry `http://127.0.0.1:*/callback`.
- Copy the environment Client ID into `src-tauri/tauri.conf.json` →
  `plugins.workos.clientId`.
- Ensure AuthKit is enabled with at least one authentication method.

## Live sign-in round-trip

1. `corepack pnpm app:dev`. The app opens on **Sign in to OpenCoven Chat**.
2. Click **Sign in with WorkOS**. The system browser opens on AuthKit.
3. Complete sign-in. The tab shows "Signed in. You can close this tab" and
   the app window comes to the front.
4. Quit and relaunch: the app skips sign-in (cached session verifies offline).
5. Disconnect the network and relaunch: still opens; no error.
6. In the WorkOS dashboard, revoke the session or deactivate the user, then
   reconnect and relaunch: the app returns to sign-in with
   "Access was revoked. Sign in again."
7. Sidebar → **User settings** → **Sign out** returns to sign-in.

## Real assisted install (fresh macOS or Linux user account)

1. With Node installed but no Coven: rows **Coven CLI** and **Coven engine**
   show **Needed**, each with its exact command and a **Run** button.
2. Run **Coven CLI**. Output streams into the row; on success it turns Ready
   and the engine row's Run button is enabled.
3. Run **Coven engine**. On success the app proceeds to chat.
4. With Node absent: no Run buttons; each row shows the copyable command and
   the Node.js download link.
```

- [ ] **Step 2: Update the README intro**

Replace the sentence "You don't need Cave, pairing, or a separate demo build." with:

```markdown
The app asks for a WorkOS sign-in on first launch, then checks for the Coven
CLI, engine and a familiar with a workspace, offering to run the exact install
commands it shows you. You don't need Cave, pairing, or a separate demo build.
```

- [ ] **Step 3: Lint (README is linted), commit**

Run: `corepack pnpm lint`

```bash
git add docs/onboarding-manual-checks.md README.md
git commit -S -m "docs: onboarding manual checklist and README intro"
```

---

### Task 24: Full verification and PR

- [ ] **Step 1: Everything green, in the order CI runs it**

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test:unit:normal
corepack pnpm test:unit:heavy
corepack pnpm build
corepack pnpm cargo:fmt
corepack pnpm cargo:clippy
cargo test --manifest-path src-tauri/Cargo.toml --locked --release --features phase1-conformance --lib
```

Expected: every command exits 0.

- [ ] **Step 2: Signature sanity before push**

```bash
git log origin/main..HEAD --pretty='%H %G?' | awk '$2 != "G" {print "UNSIGNED:", $0}'
```

Expected: no output.

- [ ] **Step 3: Push and open the PR with the `ci:full` label**

The diff touches `src-tauri`, so the `Rust` job must run; it is gated on the `ci:full` label.

```bash
git push -u origin HEAD
gh pr create --base main --label ci:full \
  --title "feat: WorkOS sign-in and assisted onboarding" \
  --body "Implements docs/superpowers/specs/2026-09-16-workos-onboarding-design.md per docs/superpowers/plans/2026-09-16-workos-onboarding.md. Manual checks: docs/onboarding-manual-checks.md."
```

Expected: PR opened; all eleven CI jobs run (label present), all green.

---

## Self-review

**Spec coverage.** Command contracts → Tasks 9, 12, 14, 15. Keyring record, bound, zeroize, CAS → Task 2. Status derivation table and 14-day grace → Task 7 (`NeedsRefresh` is the "attempt refresh" row; Task 9 performs it). Listener one-request / 127.0.0.1 / teardown → Task 5 (drop tears down). Opener refuses foreign URLs → Task 8. Fixed argv, no webview text in a `Command` → Tasks 10, 12 (`RunInput.step` is an enum; `deny_unknown_fields`). Stream lines then exit → Tasks 3, 12. Node missing → no Run → Task 18 (`canRun` requires `node.ok && npm.ok`). Windows → `unsupported` → Tasks 10, 12, 17, 18. Every error row in the spec → Tasks 8, 9, 18 messages match the spec text. Sign-out in User settings + `account` prop → Task 16. Guard tests: entrypoint move → 19; IPC grep → 20; capabilities → 21. JWKS cache in app-local data → Task 9. `oauth-ui` scope untouched → no task touches `scripts/phase1-*`. Manual checks → Task 23. `ci:full` → Task 24.

**Placeholder scan.** Task 22's `client_REPLACE_WITH_THE_ENVIRONMENT_CLIENT_ID` is a deliberate value the operator must supply and is validated at runtime by `client_id_from` (it passes the charset check, so the app will start and sign-in will fail at WorkOS with a clear dashboard error rather than a crash); Task 23 says where the real value comes from. Task 18's eighth test drives sign-out through a `mock-sign-out` button rendered by the `ChatApp` mock, so the `account.onSignOut` path is exercised without the real chat. No other TBD/TODO.

**Type consistency.** `StoredSession` fields (`access_token`, `refresh_token`, `expires_at`, `checked_at`, `subject`, `email`) used identically in Tasks 2, 7, 9. `Status::{SignedOut, Entitled{email,checked_at,grace_until}, NeedsRefresh, Expired, Revoked}` and `to_value` keys (`state`, `email`, `checkedAt`, `graceUntil`) match the JS `IdentityStatus` guard in Task 14. `Step::{InstallCli, InstallEngine}` serializes `snake_case` → JS `'install_cli' | 'install_engine'` in Task 15. `setup_run` takes `input: RunInput { runId, step }` → JS sends `{ input: { runId, step }, onEvent }`. Exit shape `{ type: 'exit', code, cancelled }` returned from the command (not the channel) → JS `exit` guard in Task 15 checks the command result. `execute_command_lines(command, cancel, timeout, on_line) -> Result<i32, String>` used with the same signature in Tasks 3 and 12. `register_run` returns `(Arc<AtomicBool>, RunRegistration)` in Tasks 9 and 12. `coven_runtime_cancel(state, run_id)` reused by both cancel commands.
