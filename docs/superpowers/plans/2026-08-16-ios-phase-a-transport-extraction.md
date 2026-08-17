# iOS Phase A: Transport Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract Coven Pocket's engine-independent reachability and HTTP transport primitive into a permissively licensed `coven-transport` crate in the SDK repository, and migrate Coven Pocket to consume it without changing its behavior.

**Architecture:** A new Cargo workspace in the `OpenCoven/sdk` repository hosts `crates/coven-transport`, a small async crate that performs one short-lived HTTP GET under a single timeout budget spanning DNS resolution, connect, and exchange, classifying failures precisely and capping response size. The crate carries no UniFFI derives and no knowledge of any specific authority, so Coven Pocket, `cave-core`, and a future desktop Tauri host can all consume it. Coven Pocket keeps its daemon-specific health parsing, classification, and UniFFI types; only the transport primitive moves.

**Tech Stack:** Rust 1.95.0, tokio 1.44, serde_json 1, cargo workspaces. Coven Pocket: UniFFI 0.32, Swift 6, XcodeGen.

**Depends on:** `docs/superpowers/specs/2026-08-16-opencoven-chat-ios-design.md`

**Repositories:**
- SDK: `/Users/buns/Documents/GitHub/OpenCoven/sdk`
- Coven Pocket: `/Users/buns/Documents/GitHub/OpenCoven/coven-pocket`

**Boundary:** This phase adds no TLS, no certificate pinning, no endpoint candidate model, no per-network selection memory, and no pairing. Those are Phase B and Phase C. This phase must not change any observable Coven Pocket behavior.

---

## Critical Rules

**Every commit must be signed.** Pass `-S` to every `git commit` in this plan. Before the first commit, verify:

```bash
git config --get user.signingkey   # must return a key
git config --get gpg.format        # must return ssh, openpgp, or x509
```

If `user.signingkey` is empty, stop and surface it. Do not modify git config.

**Do not push anything.** This plan produces local commits in two repositories. Pushing the SDK, publishing crates, or pushing Coven Pocket requires explicit operator authorization.

**No emojis** in commits or code. Coven Pocket's `AGENTS.md` requires technical prose only, and the SDK follows the same convention.

**No `.unwrap()` / `.expect()` on fallible paths outside tests.** Propagate `Result`. This is a Coven Pocket code-quality rule and applies to the extracted crate.

---

## File Map

### SDK repository (`OpenCoven/sdk`)

- Create `Cargo.toml` — Rust workspace root.
- Create `rust-toolchain.toml` — pins Rust 1.95.0.
- Create `crates/coven-transport/Cargo.toml`.
- Create `crates/coven-transport/NOTICE` — origin and relicensing grant.
- Create `crates/coven-transport/src/lib.rs` — public API and docs.
- Create `crates/coven-transport/src/json.rs` — tolerant JSON extraction.
- Create `crates/coven-transport/src/fetch.rs` — `Exchange`, `fetch`, `http_get`.
- Modify `.gitignore` — ignore `target/`.
- Create `.github/workflows/rust.yml` — fmt, clippy, test, cross-platform check.

### Coven Pocket repository (`OpenCoven/coven-pocket`)

- Modify `rust/Cargo.toml` — add the `coven-transport` dependency.
- Modify `rust/ffi/Cargo.toml` — consume it.
- Modify `rust/ffi/src/daemon.rs` — delete the moved code, import from the crate.
- Create `docs/PROVENANCE-coven-transport.md` — records what moved and why.

### Chat repository (this repo)

- No code changes. This plan document only.

---

## Task 1: Verify Provenance and Record the Relicensing Grant

Nothing moves until the licensing basis is verified and written down. Coven Pocket is GPL-3.0-only because it links `claurst-*`; the SDK is `AGPL-3.0-or-later OR MIT`. Moving code across that boundary is only sound if the moved code is (a) not derivative of the GPL engine and (b) solely owned by OpenCoven.

**Files:**
- Create: `/Users/buns/Documents/GitHub/OpenCoven/coven-pocket/docs/PROVENANCE-coven-transport.md`

- [ ] **Step 1: Verify the code imports no engine crates**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-pocket
grep -n "claurst" rust/ffi/src/daemon.rs
```

Expected: **no output**, exit status 1. If any line prints, STOP — the module is coupled to the GPL engine and cannot be relicensed. Report and end the task.

- [ ] **Step 2: Verify sole authorship**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-pocket
git log --format='%an <%ae>' -- rust/ffi/src/daemon.rs | sort -u
```

Expected: exactly one identity, `Val Alexander <bunsthedev@gmail.com>`. If more than one identity appears, STOP — a third party holds copyright and cannot be unilaterally relicensed. Report and end the task.

- [ ] **Step 3: Write the provenance record**

Create `docs/PROVENANCE-coven-transport.md`:

```markdown
# Provenance: coven-transport

Records the extraction of Coven Pocket's HTTP transport primitive into
`OpenCoven/sdk`, crate `coven-transport`.

## What moved

From `rust/ffi/src/daemon.rs`:

- the `Exchange` enum
- `fetch` — one HTTP GET under a single timeout budget
- `http_get` — minimal HTTP/1.1 request over a TCP stream
- `MAX_RESPONSE_BYTES` — the 64 KiB response cap
- `extract_json` — tolerant JSON extraction from a raw HTTP response

The crate's tests were written fresh against its public API rather than moved.
Coven Pocket keeps all sixteen of its `daemon.rs` tests unchanged, which is how
the extraction is shown to be behavior-preserving.

## What did not move

Daemon-specific logic stays in Coven Pocket: `REQUIRED_API_VERSION`,
`parse_health`, `classify_handshake`, `probe`, `handshake`, and the
`DaemonProbeState` / `DaemonIdentity` / `DaemonHandshake` UniFFI types.

## Licensing basis

- The moved code imports no `claurst-*` crate and is not a derivative work of
  coven-code or upstream Claurst. Verified by `grep -n "claurst"` returning no
  matches at extraction time.
- `git log` over the file shows a single author, Val Alexander, acting for
  OpenCoven. No third-party copyright attaches.
- OpenCoven, as sole copyright holder of this code, grants it under
  `AGPL-3.0-or-later OR MIT` in the SDK repository.

Coven Pocket remains GPL-3.0-only. Consuming a permissively licensed dependency
does not change that, and moving this code out slightly reduces Pocket's
GPL-covered surface.

This is an engineering record, not legal advice.
```

- [ ] **Step 4: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-pocket
git add docs/PROVENANCE-coven-transport.md
git commit -S -m "Record provenance for coven-transport extraction

Verifies the transport primitive in daemon.rs imports no claurst crates and is
solely OpenCoven-authored, establishing that it can be relicensed under the SDK
terms. Coven Pocket remains GPL-3.0-only."
```

- [ ] **Step 5: Verify the commit signed**

```bash
git log -1 --show-signature 2>&1 | grep -c "Good"
```

Expected: `1`. If `0`, signing failed — stop and surface it.

---

## Task 2: Add a Cargo Workspace to the SDK

The SDK is currently a pnpm-only workspace. This adds a Rust workspace beside it without disturbing the TypeScript packages.

**Files:**
- Create: `/Users/buns/Documents/GitHub/OpenCoven/sdk/Cargo.toml`
- Create: `/Users/buns/Documents/GitHub/OpenCoven/sdk/rust-toolchain.toml`
- Create: `/Users/buns/Documents/GitHub/OpenCoven/sdk/crates/coven-transport/Cargo.toml`
- Create: `/Users/buns/Documents/GitHub/OpenCoven/sdk/crates/coven-transport/src/lib.rs`
- Modify: `/Users/buns/Documents/GitHub/OpenCoven/sdk/.gitignore`

- [ ] **Step 1: Create the workspace root**

Create `Cargo.toml`:

```toml
[workspace]
resolver = "2"
members = ["crates/coven-transport"]

[workspace.package]
version = "0.1.0"
edition = "2021"
license = "AGPL-3.0-or-later OR MIT"
repository = "https://github.com/OpenCoven/sdk"

[workspace.dependencies]
tokio = { version = "1.44", features = ["rt-multi-thread", "net", "io-util", "time"] }
serde_json = "1"

[profile.release]
lto = "thin"
strip = "debuginfo"
```

- [ ] **Step 2: Pin the toolchain**

Create `rust-toolchain.toml`:

```toml
[toolchain]
channel = "1.95.0"
components = ["clippy", "rustfmt"]
```

This matches the pin the Chat desktop program uses. Coven Pocket tracks `stable`; a pinned channel here is deliberate, because this crate must build reproducibly on macOS, Linux, and Windows.

- [ ] **Step 3: Create the crate manifest**

Create `crates/coven-transport/Cargo.toml`:

```toml
[package]
name = "coven-transport"
description = "Short-lived HTTP transport with precise failure classification for reaching loopback-bound services over a user-managed overlay network."
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true

[dependencies]
tokio = { workspace = true }
serde_json = { workspace = true }

[dev-dependencies]
tokio = { version = "1.44", features = ["rt-multi-thread", "macros", "sync"] }
```

- [ ] **Step 4: Create a placeholder lib so the workspace builds**

Create `crates/coven-transport/src/lib.rs`:

```rust
//! Short-lived HTTP transport for reaching a loopback-bound service over a
//! user-managed overlay network (Tailscale, an SSH tunnel, or similar).
```

- [ ] **Step 5: Ignore build output**

Append to `.gitignore`:

```
target/
```

- [ ] **Step 6: Verify the workspace builds**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo build`

Expected: `Finished` with no errors. If `cargo` reports an unavailable toolchain, install it with `rustup toolchain install 1.95.0`.

- [ ] **Step 7: Verify the TypeScript workspace is undisturbed**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && corepack pnpm@10.34.0 test`

Expected: the existing vitest suite passes exactly as before. Adding a Cargo workspace must not affect it.

- [ ] **Step 8: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add Cargo.toml rust-toolchain.toml crates/coven-transport/Cargo.toml crates/coven-transport/src/lib.rs .gitignore
git commit -S -m "Add Rust workspace and coven-transport crate skeleton

Hosts shared Rust client crates beside the TypeScript packages. Pins Rust
1.95.0 to match the Chat desktop program."
```

---

## Task 3: Tolerant JSON Extraction

The first real behavior. A user-supplied address may point at anything, so pulling JSON out of a raw HTTP response must never panic on malformed framing. The original had a specific hazard: a closing brace appearing before an opening brace would produce a reversed slice range and panic.

**Files:**
- Create: `/Users/buns/Documents/GitHub/OpenCoven/sdk/crates/coven-transport/src/json.rs`
- Modify: `/Users/buns/Documents/GitHub/OpenCoven/sdk/crates/coven-transport/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/coven-transport/src/json.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_a_json_body_from_a_framed_response() {
        let response = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true}";
        let body = extract_json(response).expect("expected a JSON body");
        assert_eq!(body.get("ok").and_then(|v| v.as_bool()), Some(true));
    }

    #[test]
    fn survives_hostile_framing() {
        // A closing brace before the first opening brace must not slice-panic.
        assert!(extract_json("}{").is_none());
        assert!(extract_json("HTTP/1.1 200 OK\r\n\r\n} banner {").is_none());
        assert!(extract_json("no braces at all").is_none());
    }

    #[test]
    fn rejects_a_body_that_is_not_valid_json() {
        assert!(extract_json("HTTP/1.1 200 OK\r\n\r\n{not json}").is_none());
    }
}
```

Add to `src/lib.rs`:

```rust
mod json;

pub use json::extract_json;
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p coven-transport`

Expected: FAIL to compile with `cannot find function 'extract_json' in this scope`.

- [ ] **Step 3: Write the implementation**

Prepend to `crates/coven-transport/src/json.rs`, above the test module:

```rust
//! Tolerant JSON extraction from a raw HTTP response.

/// Pull the JSON object out of a raw HTTP response.
///
/// Deliberately tolerant of framing: scans for the outermost braces rather
/// than parsing headers strictly, because the responder may be any service
/// the user pointed us at. Returns `None` rather than panicking on malformed
/// input, including a closing brace that precedes the opening brace.
pub fn extract_json(response: &str) -> Option<serde_json::Value> {
    let start = response.find('{')?;
    let end = response.rfind('}')?;
    if end < start {
        return None;
    }
    serde_json::from_str(&response[start..=end]).ok()
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p coven-transport`

Expected: PASS, `3 passed`.

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add crates/coven-transport/src/json.rs crates/coven-transport/src/lib.rs
git commit -S -m "Add tolerant JSON extraction to coven-transport

Scans for outermost braces rather than parsing headers, and returns None on
reversed or absent braces instead of panicking on a hostile response."
```

---

## Task 4: One HTTP Exchange, Happy Path

**Files:**
- Create: `/Users/buns/Documents/GitHub/OpenCoven/sdk/crates/coven-transport/src/fetch.rs`
- Modify: `/Users/buns/Documents/GitHub/OpenCoven/sdk/crates/coven-transport/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/coven-transport/src/fetch.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    const TIMEOUT: Duration = Duration::from_millis(1500);

    /// Serve one canned response on an ephemeral loopback port.
    async fn serve_once(response: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind loopback");
        let port = listener.local_addr().expect("local addr").port();
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf).await;
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        port
    }

    #[tokio::test]
    async fn returns_the_response_body() {
        let port = serve_once("HTTP/1.1 200 OK\r\n\r\n{\"ok\":true}").await;
        match fetch("127.0.0.1", port, "/health", TIMEOUT).await {
            Exchange::Response { body, .. } => {
                assert!(body.contains("{\"ok\":true}"), "got: {body}");
            }
            other => panic!("expected Response, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn requests_the_path_it_was_given() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).into_owned());
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\n\r\n{}").await;
            }
        });
        let _ = fetch("127.0.0.1", port, "/api/v1/health", TIMEOUT).await;
        let request = rx.await.unwrap_or_default();
        assert!(
            request.starts_with("GET /api/v1/health HTTP/1.1"),
            "got: {request}"
        );
        assert!(request.contains("Connection: close"), "got: {request}");
    }
}
```

Add to `src/lib.rs`:

```rust
mod fetch;

pub use fetch::{fetch, Exchange};
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p coven-transport`

Expected: FAIL to compile with `cannot find function 'fetch'` and `cannot find type 'Exchange'`.

- [ ] **Step 3: Write the minimal implementation**

Prepend to `crates/coven-transport/src/fetch.rs`, above the test module:

```rust
//! One short-lived HTTP exchange against a host and port.

use std::time::{Duration, Instant};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

/// Transport-level result of one HTTP exchange.
///
/// Failure variants are deliberately specific so a caller can tell the user
/// what to check instead of reporting a generic error.
#[derive(Debug)]
pub enum Exchange {
    /// The service answered. `body` is the raw response including headers.
    Response { body: String, latency_ms: u32 },
    /// Connection refused — nothing listening (tunnel down, wrong port).
    Refused,
    /// No answer within the budget — wrong host, overlay down, or a firewall drop.
    TimedOut,
    /// The hostname did not resolve.
    Unresolvable,
    /// Anything else, with the underlying error text.
    Failed(String),
}

/// Perform one GET over a fresh TCP connection.
pub async fn fetch(host: &str, port: u16, path: &str, timeout: Duration) -> Exchange {
    let started = Instant::now();
    let stream = match TcpStream::connect((host, port)).await {
        Ok(stream) => stream,
        Err(e) => return Exchange::Failed(e.to_string()),
    };
    match http_get(stream, path).await {
        Ok(body) => Exchange::Response {
            body,
            latency_ms: elapsed_ms(started),
        },
        Err(e) => Exchange::Failed(e.to_string()),
    }
}

/// Send the minimal request and return the raw response.
async fn http_get(mut stream: TcpStream, path: &str) -> std::io::Result<String> {
    let request = format!("GET {path} HTTP/1.1\r\nHost: coven\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response).await?;
    Ok(String::from_utf8_lossy(&response).into_owned())
}

/// Saturating elapsed milliseconds, so a very long wait cannot overflow.
fn elapsed_ms(started: Instant) -> u32 {
    started.elapsed().as_millis().min(u128::from(u32::MAX)) as u32
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p coven-transport`

Expected: PASS, `5 passed` (3 from Task 3, 2 new).

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add crates/coven-transport/src/fetch.rs crates/coven-transport/src/lib.rs
git commit -S -m "Add one-shot HTTP GET to coven-transport

Short-lived connection with Connection: close, which suits a phone that polls
in the foreground and goes quiet in the background."
```

---

## Task 5: A Single Timeout Budget

A slow DNS resolver hangs just as effectively as a dead host. The budget must span resolution, connect, and exchange, not apply separately to each.

**Files:**
- Modify: `/Users/buns/Documents/GitHub/OpenCoven/sdk/crates/coven-transport/src/fetch.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `crates/coven-transport/src/fetch.rs`:

```rust
    #[tokio::test]
    async fn a_silent_server_times_out() {
        // Accepts the connection but never responds: the read must give up.
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            let _held = listener.accept().await;
            tokio::time::sleep(Duration::from_secs(30)).await;
        });
        assert!(matches!(
            fetch("127.0.0.1", port, "/health", Duration::from_millis(300)).await,
            Exchange::TimedOut
        ));
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && timeout 30 cargo test -p coven-transport a_silent_server_times_out`

Expected: the command **hangs and is killed by `timeout` after 30 seconds**, exiting with status 124. The current implementation has no timeout at all, so it waits on `read_to_end` forever. A killed run is the failure signal here; there is no assertion failure to read.

- [ ] **Step 3: Implement the timeout budget**

Replace the `fetch` function in `crates/coven-transport/src/fetch.rs` with:

```rust
/// Perform one GET over a fresh TCP connection, under a single timeout budget
/// spanning DNS resolution, connect, and the exchange.
///
/// Each phase gets only what earlier phases left over, so a slow resolver
/// cannot silently extend the total wait.
pub async fn fetch(host: &str, port: u16, path: &str, timeout: Duration) -> Exchange {
    let started = Instant::now();

    // Resolve explicitly so DNS problems stay distinguishable from dead hosts,
    // and inside the budget, since a slow resolver hangs too.
    let addrs = match tokio::time::timeout(timeout, tokio::net::lookup_host((host, port))).await {
        Ok(Ok(addrs)) => addrs.collect::<Vec<_>>(),
        Ok(Err(_)) => return Exchange::Unresolvable,
        Err(_) => return Exchange::TimedOut,
    };
    if addrs.is_empty() {
        return Exchange::Unresolvable;
    }

    let remaining = timeout.saturating_sub(started.elapsed());
    if remaining.is_zero() {
        return Exchange::TimedOut;
    }
    let stream = match tokio::time::timeout(remaining, TcpStream::connect(addrs.as_slice())).await {
        Ok(Ok(stream)) => stream,
        Ok(Err(e)) if e.kind() == std::io::ErrorKind::ConnectionRefused => {
            return Exchange::Refused;
        }
        Ok(Err(e)) => return Exchange::Failed(e.to_string()),
        Err(_) => return Exchange::TimedOut,
    };

    let remaining = timeout.saturating_sub(started.elapsed());
    if remaining.is_zero() {
        return Exchange::TimedOut;
    }
    match tokio::time::timeout(remaining, http_get(stream, path)).await {
        Ok(Ok(body)) => Exchange::Response {
            body,
            latency_ms: elapsed_ms(started),
        },
        Ok(Err(e)) => Exchange::Failed(e.to_string()),
        Err(_) => Exchange::TimedOut,
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p coven-transport`

Expected: PASS, `6 passed`. The run completes in well under 30 seconds.

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add crates/coven-transport/src/fetch.rs
git commit -S -m "Give coven-transport a single timeout budget

Resolution, connect, and exchange share one deadline, so a slow resolver
cannot extend the total wait past what the caller asked for."
```

---

## Task 6: Precise Failure Classification

"Cannot connect" is useless to a user. Refused, unresolvable, and timed out call for three different actions.

**Files:**
- Modify: `/Users/buns/Documents/GitHub/OpenCoven/sdk/crates/coven-transport/src/fetch.rs`

- [ ] **Step 1: Write the tests**

Add to the `tests` module in `crates/coven-transport/src/fetch.rs`:

```rust
    #[tokio::test]
    async fn a_closed_port_is_refused() {
        // Bind then drop, to name a port with certainly no listener.
        let port = {
            let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
            listener.local_addr().expect("addr").port()
        };
        assert!(matches!(
            fetch("127.0.0.1", port, "/health", TIMEOUT).await,
            Exchange::Refused
        ));
    }

    #[tokio::test]
    async fn a_bad_hostname_is_unresolvable() {
        assert!(matches!(
            fetch("definitely-not-a-real-host.invalid", 7777, "/health", TIMEOUT).await,
            Exchange::Unresolvable
        ));
    }
```

- [ ] **Step 2: Run the tests**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p coven-transport`

Expected: **PASS, `8 passed`.** These are characterization tests, not red-then-green ones — Task 5's implementation already classifies both cases, because the explicit `lookup_host` call and the `ConnectionRefused` arm came in together with the timeout budget. They are written now to lock that behavior against future edits. If either fails, Task 5 was applied incorrectly; re-read its Step 3.

- [ ] **Step 3: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add crates/coven-transport/src/fetch.rs
git commit -S -m "Lock coven-transport failure classification with tests

Refused, unresolvable, and timed out stay distinguishable so callers can tell
the user which one to act on."
```

---

## Task 7: Cap the Response Size

The address is user-supplied. An arbitrary service must not be able to balloon memory.

**Files:**
- Modify: `/Users/buns/Documents/GitHub/OpenCoven/sdk/crates/coven-transport/src/fetch.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `crates/coven-transport/src/fetch.rs`:

```rust
    #[tokio::test]
    async fn oversized_responses_are_capped() {
        // 1 MiB of garbage against a 64 KiB cap.
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf).await;
                let chunk = vec![b'x'; 1024 * 1024];
                let _ = stream.write_all(&chunk).await;
            }
        });
        match fetch("127.0.0.1", port, "/health", TIMEOUT).await {
            Exchange::Response { body, .. } => {
                assert!(
                    body.len() as u64 <= MAX_RESPONSE_BYTES,
                    "buffered {} bytes, cap is {MAX_RESPONSE_BYTES}",
                    body.len()
                );
            }
            other => panic!("expected a capped Response, got {other:?}"),
        }
    }
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p coven-transport oversized_responses_are_capped`

Expected: FAIL to compile with `cannot find value 'MAX_RESPONSE_BYTES' in this scope`.

- [ ] **Step 3: Implement the cap**

Add the constant above `http_get` in `crates/coven-transport/src/fetch.rs`:

```rust
/// Cap on any buffered response. A real health payload is a few hundred
/// bytes; the address is user-supplied, so an arbitrary service must not be
/// able to balloon memory.
pub const MAX_RESPONSE_BYTES: u64 = 64 * 1024;
```

Replace the body-reading lines in `http_get` with the capped form:

```rust
async fn http_get(mut stream: TcpStream, path: &str) -> std::io::Result<String> {
    let request = format!("GET {path} HTTP/1.1\r\nHost: coven\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await?;
    let mut response = Vec::new();
    let mut limited = stream.take(MAX_RESPONSE_BYTES);
    limited.read_to_end(&mut response).await?;
    Ok(String::from_utf8_lossy(&response).into_owned())
}
```

Export it from `src/lib.rs`:

```rust
pub use fetch::{fetch, Exchange, MAX_RESPONSE_BYTES};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p coven-transport`

Expected: PASS, `9 passed`.

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add crates/coven-transport/src/fetch.rs crates/coven-transport/src/lib.rs
git commit -S -m "Cap coven-transport responses at 64 KiB

The address is user-supplied, so an arbitrary service must not be able to
balloon memory by answering with an unbounded body."
```

---

## Task 8: Crate Documentation, NOTICE, and Lints

**Files:**
- Modify: `/Users/buns/Documents/GitHub/OpenCoven/sdk/crates/coven-transport/src/lib.rs`
- Create: `/Users/buns/Documents/GitHub/OpenCoven/sdk/crates/coven-transport/NOTICE`

- [ ] **Step 1: Write the crate documentation and public surface**

Replace `crates/coven-transport/src/lib.rs` with:

```rust
//! Short-lived HTTP transport for reaching a loopback-bound service over a
//! user-managed overlay network.
//!
//! The service being reached — a Coven daemon, a Cave instance — binds only to
//! loopback on its own host. The user carries traffic across with Tailscale, an
//! SSH tunnel, or similar. This crate knows how to perform one HTTP exchange
//! across that path and report precisely how it failed; it knows nothing about
//! any particular authority's payloads.
//!
//! One connection per call, with `Connection: close`. That suits a phone, which
//! polls while foregrounded and goes silent when backgrounded.
//!
//! Deliberately free of UniFFI derives, so callers that are not Swift apps —
//! a CLI, a Tauri host — can consume it. Each application's FFI layer defines
//! its own boundary types and converts.
//!
//! ```no_run
//! # async fn example() {
//! use std::time::Duration;
//! use coven_transport::{fetch, Exchange};
//!
//! match fetch("my-host.tailnet.ts.net", 7777, "/health", Duration::from_secs(2)).await {
//!     Exchange::Response { body, latency_ms } => println!("{latency_ms}ms: {body}"),
//!     Exchange::Refused => println!("nothing is listening on that port"),
//!     Exchange::Unresolvable => println!("that hostname does not resolve"),
//!     Exchange::TimedOut => println!("no answer in time"),
//!     Exchange::Failed(detail) => println!("failed: {detail}"),
//! }
//! # }
//! ```

#![deny(missing_docs)]

mod fetch;
mod json;

pub use fetch::{fetch, Exchange, MAX_RESPONSE_BYTES};
pub use json::extract_json;
```

- [ ] **Step 2: Run the tests to catch missing docs**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p coven-transport`

Expected: FAIL with `missing documentation for a struct field` on `Exchange::Response`'s fields, because `#![deny(missing_docs)]` is now active.

- [ ] **Step 3: Document the remaining public items**

In `crates/coven-transport/src/fetch.rs`, replace the `Response` variant with documented fields:

```rust
    /// The service answered. `body` is the raw response including headers.
    Response {
        /// The raw response text, headers included, truncated at
        /// [`MAX_RESPONSE_BYTES`].
        body: String,
        /// Wall-clock milliseconds from the start of the call to the end of
        /// the exchange, saturating at `u32::MAX`.
        latency_ms: u32,
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p coven-transport`

Expected: PASS, `9 passed`, plus `1 passed` for the doc test.

- [ ] **Step 5: Write the NOTICE**

Create `crates/coven-transport/NOTICE`:

```text
coven-transport

Portions of this crate were extracted from OpenCoven/coven-pocket, file
rust/ffi/src/daemon.rs, which is licensed GPL-3.0-only as a whole because that
application links GPL-licensed engine crates.

The extracted code imports no engine crate and is not a derivative work of
coven-code or of upstream Claurst. It was authored solely by OpenCoven, which
as sole copyright holder licenses it here under AGPL-3.0-or-later OR MIT.

See OpenCoven/coven-pocket docs/PROVENANCE-coven-transport.md for the record.
```

- [ ] **Step 6: Verify formatting and lints are clean**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
cargo fmt --all --check
cargo clippy -p coven-transport --all-targets -- -D warnings
```

Expected: both exit 0 with no output. If `cargo fmt --all --check` reports a diff, run `cargo fmt --all` and re-run.

- [ ] **Step 7: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add crates/coven-transport/src/lib.rs crates/coven-transport/src/fetch.rs crates/coven-transport/NOTICE
git commit -S -m "Document coven-transport and record extraction NOTICE

Denies missing docs on the public surface and records that the extracted code
carries no GPL obligation."
```

---

## Task 9: Migrate Coven Pocket onto the Crate

Coven Pocket keeps everything daemon-specific. Only the transport primitive is replaced.

**Files:**
- Modify: `/Users/buns/Documents/GitHub/OpenCoven/coven-pocket/rust/Cargo.toml`
- Modify: `/Users/buns/Documents/GitHub/OpenCoven/coven-pocket/rust/ffi/Cargo.toml`
- Modify: `/Users/buns/Documents/GitHub/OpenCoven/coven-pocket/rust/ffi/src/daemon.rs`

- [ ] **Step 1: Add the workspace dependency**

In `rust/Cargo.toml`, add to `[workspace.dependencies]`:

```toml
# Shared transport primitive, extracted from this repo into the SDK.
# Path dependency during development; see AGENTS.md before switching to a
# pinned git rev, which requires the SDK to be pushed first.
coven-transport = { path = "../../sdk/crates/coven-transport" }
```

- [ ] **Step 2: Consume it in the FFI crate**

In `rust/ffi/Cargo.toml`, add to `[dependencies]`:

```toml
coven-transport = { workspace = true }
```

- [ ] **Step 3: Delete the moved code from `daemon.rs`**

In `rust/ffi/src/daemon.rs`, delete these items entirely:

- the `enum Exchange` declaration and its doc comment
- `async fn fetch`
- `const MAX_RESPONSE_BYTES`
- `async fn http_get`
- `fn extract_json`

Then replace the `use` block at the top of the file with:

```rust
use std::time::Duration;

use coven_transport::{extract_json, fetch, Exchange};
```

Note that `Instant`, `AsyncReadExt`, `AsyncWriteExt`, and `TcpStream` are no longer needed by the non-test code; the test module imports what it needs itself.

- [ ] **Step 4: Delete no tests**

Leave the `tests` module in `rust/ffi/src/daemon.rs` **completely untouched.**

Every one of its sixteen tests exercises `probe`, `handshake`, or `parse_health` — all of which stay in Pocket. None call the moved functions directly. `parse_health_survives_hostile_framing` reaches the brace-scanning hazard through `parse_health`, and `oversized_responses_are_capped_not_buffered` and `bad_hostname_is_unresolvable` assert how `probe` maps a transport outcome to a `DaemonProbeState`. All three remain Pocket's own behavior and must keep passing.

This is what makes the phase gate meaningful: an unchanged suite passing against relocated code is evidence the extraction was faithful. Deleting tests would destroy exactly the signal this phase exists to produce.

- [ ] **Step 5: Run Pocket's Rust tests**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/coven-pocket/rust && cargo test -p coven-pocket-ffi`

Expected: PASS, with the `daemon` module reporting **all sixteen tests passing**, unchanged in name and count from before the migration. Every other module is unchanged.

If any daemon test fails, the extraction changed behavior — do not adjust the test. Re-read Task 9 Step 3 and find what differs.

If compilation fails with `unused import`, remove the offending import — Step 3 lists the ones that typically become dead.

- [ ] **Step 6: Verify formatting and lints**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-pocket/rust
cargo fmt --all --check
cargo clippy -p coven-pocket-ffi --all-targets -- -D warnings
```

Expected: both exit 0.

- [ ] **Step 7: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-pocket
git add rust/Cargo.toml rust/ffi/Cargo.toml rust/ffi/src/daemon.rs rust/Cargo.lock
git commit -S -m "Consume coven-transport instead of a local HTTP primitive

daemon.rs keeps the coven.daemon.v1 health parsing, classification, and UniFFI
types. The resolve/connect/exchange primitive, the response cap, and tolerant
JSON extraction now come from the shared crate."
```

---

## Task 10: Phase Gate — Coven Pocket Is Unchanged

The extraction is only faithful if Pocket behaves exactly as before. This task adds no code; it proves the claim.

- [ ] **Step 1: Run the full Rust suite**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/coven-pocket/rust && cargo test`

Expected: PASS, every crate, with the same total test count as before the migration. Capture the baseline first if it was not recorded:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-pocket
git stash && (cd rust && cargo test 2>&1 | tail -20) && git stash pop
```

A changed count means tests were added or lost during migration; both are failures of this phase.

- [ ] **Step 2: Verify the iOS targets still compile**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-pocket/rust
cargo check -p coven-pocket-ffi --target aarch64-apple-ios
cargo check -p coven-pocket-ffi --target aarch64-apple-ios-sim
```

Expected: both `Finished` with no errors. This is the check that would catch a dependency pulling in something that does not cross-compile to iOS. If a target is missing, install it with `rustup target add aarch64-apple-ios aarch64-apple-ios-sim`.

- [ ] **Step 3: Regenerate the UniFFI bindings and confirm no Swift-visible change**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-pocket
./scripts/build-xcframework.sh
git diff --stat app/Sources/Generated/
```

Expected: **empty diff.** The extraction moved only private, non-FFI items, so the generated Swift surface must be byte-identical. A non-empty diff means something FFI-visible moved — stop and investigate before proceeding.

- [ ] **Step 4: Confirm the GPL boundary is intact**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
cargo tree -p coven-transport | grep -i "claurst" || echo "clean: no engine crates"
```

Expected: `clean: no engine crates`. The shared crate must never acquire a GPL dependency, or Chat inherits Pocket's App Store block.

- [ ] **Step 5: Record the gate result**

Append the evidence to the provenance record in Coven Pocket, using the template from the program tracking document:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-pocket
cat >> docs/PROVENANCE-coven-transport.md <<'EOF'

## Extraction gate evidence

- `cargo test` across the Pocket workspace: PASS
- `cargo check` for aarch64-apple-ios and aarch64-apple-ios-sim: PASS
- `./scripts/build-xcframework.sh` then `git diff app/Sources/Generated/`: empty
- `cargo tree -p coven-transport | grep claurst`: no matches
EOF
git add docs/PROVENANCE-coven-transport.md
git commit -S -m "Record coven-transport extraction gate evidence"
```

Fill in the actual observed results rather than copying the expected ones. If any check failed, record the failure and stop.

---

## Task 11: SDK Continuous Integration

**Files:**
- Create: `/Users/buns/Documents/GitHub/OpenCoven/sdk/.github/workflows/rust.yml`

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/rust.yml`:

```yaml
name: Rust

on:
  push:
    branches: [main]
  pull_request:

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: true

jobs:
  test:
    name: ${{ matrix.os }}
    runs-on: ${{ matrix.os }}
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-24.04, macos-15, windows-2022]
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@1.95.0
        with:
          components: clippy, rustfmt
      - uses: Swatinem/rust-cache@v2
      - name: Format
        run: cargo fmt --all --check
      - name: Clippy
        run: cargo clippy --workspace --all-targets -- -D warnings
      - name: Test
        run: cargo test --workspace
```

The three-OS matrix is not incidental. The spec requires the shared crates to compile for macOS, Linux, and Windows so the desktop Tauri host can adopt them if the proof gate ever passes. Losing that portability silently would make the migration decision for us.

- [ ] **Step 2: Verify the workflow parses**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/rust.yml')); print('valid')"`

Expected: `valid`.

- [ ] **Step 3: Reproduce the CI checks locally**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Expected: all three exit 0. This is the same sequence CI runs; a local failure is a CI failure.

- [ ] **Step 4: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add .github/workflows/rust.yml
git commit -S -m "Add Rust CI across Linux, macOS, and Windows

The three-OS matrix enforces the portability the shared crates need to stay
adoptable by the desktop Tauri host."
```

- [ ] **Step 5: Verify every commit in this phase is signed**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git log origin/main..HEAD --pretty='%H %G?' | awk '$2 != "G" {print "UNSIGNED:", $0}'
cd /Users/buns/Documents/GitHub/OpenCoven/coven-pocket
git log origin/main..HEAD --pretty='%H %G?' | awk '$2 != "G" {print "UNSIGNED:", $0}'
```

Expected: no output from either. Anything printed must be signed before any push is considered.

---

## Phase A Completion

Phase A is done when:

- `coven-transport` exists in the SDK under `AGPL-3.0-or-later OR MIT`, with a NOTICE recording its origin and grant.
- The crate has no UniFFI derives and no GPL dependency.
- `cargo test --workspace` passes in the SDK on Linux, macOS, and Windows.
- Coven Pocket consumes the crate, its full test suite passes, both iOS targets compile, and `app/Sources/Generated/` is byte-identical.
- Provenance and gate evidence are recorded in Coven Pocket.
- Every commit in both repositories is signed. Nothing is pushed.

**Not in this phase, by design:** TLS and certificate pinning, the endpoint candidate model, per-network selection memory, any pairing or credential handling, and anything touching Cave. Those begin in Phase B.

## Handoff to Phase B

Phase B extends `coven-transport` additively with TLS, certificate pinning, the candidate model, and per-network selection memory, then builds `cave-core` over it. Phase B must not change the primitive's existing behavior; Coven Pocket's suite continues to be the regression check that it hasn't.
