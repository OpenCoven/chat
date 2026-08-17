# iOS Phase D2: Enrollment and Canonical Reads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scan a Cave enrollment code, exchange the grant for a scoped bearer, remember which address works on which network, and read your canonical familiars and conversations — cached, revision-ordered, and honest about every failure.

**Architecture:** `cave-core` gains an authenticated `CaveClient` that owns candidate selection and envelope handling, so Swift never assembles a request or decides which address to use. `chat-ios-ffi` exposes one `CaveSession` object plus a file-backed cache. Swift owns the camera, the Keychain, the connection state machine, and the views — and receives the raw bearer exactly once, at exchange, which it immediately stores.

**Tech Stack:** Swift 6, SwiftUI, AVFoundation, iOS 17, UniFFI 0.32, Rust 1.95.0, tokio.

**Depends on:** `2026-08-16-ios-phase-d1-ios-foundation.md`. Cave's Phase 1 pairing routes and iOS Phase C enrollment routes must exist to test against a live instance; Tasks 1 through 8 are testable without them.

**Boundary:** No sending, no streaming, no outbox, no rich content parsing, no attachments, no push. Reads only. The composer arrives in Phase E.

---

## Contract Assumption To Verify

The desktop phase-1 plan states that "the bearer appears exactly once in the successful exchange response" but does not give the response's field names. This plan assumes:

```json
{ "ok": true, "token": "<bearer>", "credential": { "id": "...", "scopes": ["chat:read"] } }
```

- [ ] **Before starting Task 4, verify this against Cave's implemented route**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
cat src/app/api/client/v1/pairing/requests/\[id\]/exchange/route.ts
```

If the shape differs, update `ExchangeResponse` in Task 4 to match Cave. Cave is the authority; this plan is not. Do not change Cave to match this plan.

If the route does not exist yet, implement Tasks 1 through 8 against the assumed shape, and treat Task 9 onward as blocked on Cave Phase 1.

---

## Working Directories

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git worktree add -b feat/ios-phase-d2-sdk .worktrees/ios-phase-d2-sdk feat/ios-phase-d1-sdk

cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
git checkout -b feat/ios-phase-d2
```

---

## Critical Rules

- **Every commit signed.** Pass `-S`.
- **Do not push.**
- **No emojis** in commits or code.
- **The bearer is never logged, never printed, never included in an error message.** Task 13 checks this.
- **Swift 6 strict concurrency.** UniFFI callbacks arrive on Rust threads; hop to `@MainActor` before touching UI. `CaveStore` is `@MainActor`, so every view that constructs or reads it must be `@MainActor` too. Under `SWIFT_STRICT_CONCURRENCY: complete`, a `@StateObject` of a `@MainActor` type in a non-isolated view is a compile error — annotate `RootView`, `ConversationListView`, `ThreadView`, and `EnrollmentView` with `@MainActor`.
- **No `.unwrap()` / `.expect()` on fallible paths outside tests.**

## Generated Symbol Names Are Authoritative

Swift code in this plan is written against the names UniFFI is *expected* to generate: `ChatError.Api`, `ChatError.Unreachable(detail:)`, `CaveSession(candidates:bearer:)`, `ChatIOS.enroll(uri:installationId:)`, and so on.

UniFFI's casing has varied across versions — error cases commonly generate lowercased (`.api`, `.unreachable`), and free functions land at module scope rather than under a namespace. **Read `app/Sources/Generated/*.swift` after the first `./scripts/build-xcframework.sh` and adjust the Swift in this plan to match what is actually there.**

Adjust the Swift, never the Rust. Renaming Rust to satisfy a guess in this document would change the FFI contract to match a document instead of the other way round.

---

## File Map

### SDK `crates/coven-transport`
- Modify `src/fetch.rs`, `src/lib.rs` — GET with headers.

### SDK `crates/cave-core`
- Modify `src/error.rs` — `parse_envelope_value`, `CaveError::Unreachable`.
- Create `src/client.rs` — authenticated `CaveClient`.
- Create `src/pairing.rs` — grant exchange.
- Modify `src/lib.rs`.

### chat-ios
- Create `rust/ffi/src/session.rs`, `rust/ffi/src/cache.rs`, `rust/ffi/src/types.rs`.
- Modify `rust/ffi/src/lib.rs`.
- Create `app/Sources/Support/ConnectionState.swift`, `app/Sources/Support/CaveStore.swift`.
- Create `app/Sources/Views/EnrollmentView.swift`, `ScannerView.swift`, `ConversationListView.swift`, `ThreadView.swift`, `RootView.swift`.
- Modify `app/Sources/ChatApp.swift`, `project.yml`.
- Create `app/Tests/ConnectionStateTests.swift`, `app/Tests/CaveStoreTests.swift`.

---

## Task 1: GET With Headers

Authenticated reads need an `Authorization` header. D1 added headers for POST only.

**Files:** Modify `crates/coven-transport/src/fetch.rs`, `src/lib.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `crates/coven-transport/src/fetch.rs`:

```rust
    #[tokio::test]
    async fn sends_headers_on_a_get() {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buf = [0u8; 2048];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).into_owned());
                let _ = stream.write_all(b"HTTP/1.1 200 OK\r\n\r\n{\"ok\":true}").await;
            }
        });

        let endpoint = Endpoint::plaintext("127.0.0.1", port);
        let request = GetRequest {
            path: "/api/client/v1/familiars".to_string(),
            headers: vec![("Authorization".to_string(), "Bearer abc".to_string())],
        };
        assert!(matches!(
            get_endpoint(&endpoint, &request, TIMEOUT).await,
            Exchange::Response { .. }
        ));

        let sent = rx.await.unwrap_or_default();
        assert!(sent.starts_with("GET /api/client/v1/familiars HTTP/1.1"), "got: {sent}");
        assert!(sent.contains("Authorization: Bearer abc"), "got: {sent}");
    }

    #[tokio::test]
    async fn a_get_rejects_a_header_containing_crlf() {
        let endpoint = Endpoint::plaintext("127.0.0.1", 1);
        let request = GetRequest {
            path: "/x".to_string(),
            headers: vec![("X-Evil".to_string(), "a\r\nInjected: yes".to_string())],
        };
        match get_endpoint(&endpoint, &request, TIMEOUT).await {
            Exchange::Failed(detail) => assert!(detail.contains("header"), "got: {detail}"),
            other => panic!("expected Failed, got {other:?}"),
        }
    }
```

Export from `src/lib.rs`:

```rust
pub use fetch::{
    fetch, fetch_endpoint, get_endpoint, post_endpoint, Exchange, GetRequest, PostRequest,
    MAX_RESPONSE_BYTES,
};
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p coven-transport`

Expected: FAIL to compile — `GetRequest` undefined.

- [ ] **Step 3: Implement**

Add to `crates/coven-transport/src/fetch.rs`:

```rust
/// A GET to perform against an endpoint.
#[derive(Debug, Clone)]
pub struct GetRequest {
    /// Request path, including any query string.
    pub path: String,
    /// Extra headers as name/value pairs.
    pub headers: Vec<(String, String)>,
}

/// Perform one GET with headers, under a single timeout budget.
pub async fn get_endpoint(
    endpoint: &Endpoint,
    request: &GetRequest,
    timeout: Duration,
) -> Exchange {
    if !is_header_safe(&request.path) {
        return Exchange::Failed("request path contains a line break".to_string());
    }
    for (name, value) in &request.headers {
        if !is_header_safe(name) || !is_header_safe(value) {
            return Exchange::Failed(format!("header {name} contains a line break"));
        }
    }

    let mut wire = format!("GET {} HTTP/1.1\r\nHost: coven\r\nConnection: close\r\n", request.path);
    for (name, value) in &request.headers {
        wire.push_str(&format!("{name}: {value}\r\n"));
    }
    wire.push_str("\r\n");

    exchange_raw(endpoint, wire, timeout).await
}
```

Rewrite `fetch_endpoint` to delegate:

```rust
pub async fn fetch_endpoint(endpoint: &Endpoint, path: &str, timeout: Duration) -> Exchange {
    get_endpoint(
        endpoint,
        &GetRequest { path: path.to_string(), headers: Vec::new() },
        timeout,
    )
    .await
}
```

- [ ] **Step 4: Run the suite**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p coven-transport`

Expected: PASS, 28 tests. Every earlier test still passes.

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add crates/coven-transport/src/
git commit -S -m "Add GET with headers to coven-transport

Authenticated reads need an Authorization header. fetch_endpoint now delegates
so GET has exactly one implementation."
```

---

## Task 2: Envelope Parsing From a Raw Response

Real responses arrive as raw HTTP with headers. Phase B's `parse_envelope` takes bare JSON.

**Files:** Modify `crates/cave-core/src/error.rs`, `src/lib.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `crates/cave-core/src/error.rs`:

```rust
    #[test]
    fn parses_an_envelope_out_of_a_raw_http_response() {
        let raw = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"ok\":true,\"value\":42}";
        let parsed: Payload = parse_raw_response(raw).expect("parses");
        assert_eq!(parsed, Payload { value: 42 });
    }

    #[test]
    fn parses_an_error_envelope_out_of_a_raw_error_response() {
        let raw = "HTTP/1.1 401 Unauthorized\r\n\r\n{\"ok\":false,\"error\":{\"code\":\"unauthorized\",\"message\":\"Not authorized.\",\"retryable\":false}}";
        match parse_raw_response::<Payload>(raw) {
            Err(CaveError::Api(envelope)) => assert_eq!(envelope.code, "unauthorized"),
            other => panic!("expected an API error, got {other:?}"),
        }
    }

    #[test]
    fn a_response_with_no_json_is_malformed_not_empty() {
        match parse_raw_response::<Payload>("HTTP/1.1 502 Bad Gateway\r\n\r\nnginx") {
            Err(CaveError::Malformed(_)) => {}
            other => panic!("expected Malformed, got {other:?}"),
        }
    }

    #[test]
    fn an_unreachable_error_displays_its_detail() {
        let error = CaveError::Unreachable { detail: "nothing answered".to_string() };
        assert!(format!("{error}").contains("nothing answered"));
    }
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p cave-core error`

Expected: FAIL — `parse_raw_response` and `CaveError::Unreachable` undefined.

- [ ] **Step 3: Implement**

In `crates/cave-core/src/error.rs`, add the variant to `CaveError`:

```rust
    /// No candidate address produced a usable response.
    Unreachable {
        /// The most informative transport failure observed.
        detail: String,
    },
```

Add its `Display` arm:

```rust
            Self::Unreachable { detail } => write!(f, "unreachable: {detail}"),
```

Refactor `parse_envelope` onto a value-based core and add the raw-response entry point:

```rust
/// Split an already-parsed JSON value into a typed payload or a typed error.
pub fn parse_envelope_value<T: DeserializeOwned>(
    value: serde_json::Value,
) -> Result<T, CaveError> {
    let ok = value
        .get("ok")
        .and_then(serde_json::Value::as_bool)
        .ok_or_else(|| CaveError::Malformed("response had no boolean 'ok' field".to_string()))?;

    if !ok {
        let error = value.get("error").ok_or_else(|| {
            CaveError::Malformed("response reported failure without an error object".to_string())
        })?;
        let envelope: ErrorEnvelope = serde_json::from_value(error.clone())
            .map_err(|e| CaveError::Malformed(format!("error object did not match v1: {e}")))?;
        return Err(CaveError::Api(envelope));
    }

    serde_json::from_value(value)
        .map_err(|e| CaveError::Malformed(format!("payload did not match v1: {e}")))
}

/// Parse a Cave response body.
pub fn parse_envelope<T: DeserializeOwned>(body: &str) -> Result<T, CaveError> {
    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| CaveError::Malformed(format!("response was not JSON: {e}")))?;
    parse_envelope_value(value)
}

/// Parse a raw HTTP response, headers included.
///
/// Uses the transport's tolerant JSON extraction rather than parsing headers,
/// because the responder may be anything the user pointed us at.
pub fn parse_raw_response<T: DeserializeOwned>(raw: &str) -> Result<T, CaveError> {
    let value = coven_transport::extract_json(raw)
        .ok_or_else(|| CaveError::Malformed("response contained no JSON object".to_string()))?;
    parse_envelope_value(value)
}
```

Export from `src/lib.rs`:

```rust
pub use error::{parse_envelope, parse_envelope_value, parse_raw_response, CaveError, ErrorEnvelope};
```

- [ ] **Step 4: Run the workspace suite**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test --workspace`

Expected: PASS. The conformance tests still pass unchanged.

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add crates/cave-core/src/
git commit -S -m "Parse Cave envelopes from raw HTTP responses

A response with no JSON at all is Malformed rather than an empty success, so a
proxy error page cannot present as an empty conversation list."
```

---

## Task 3: The Authenticated Client

Swift must never assemble a request or choose an address.

**Files:** Create `crates/cave-core/src/client.rs`; modify `src/lib.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/cave-core/src/client.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use coven_transport::InMemorySelectionStore;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn serve(response: &'static str) -> (u16, tokio::sync::oneshot::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buf = [0u8; 2048];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).into_owned());
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        (port, rx)
    }

    fn client(port: u16) -> CaveClient {
        CaveClient::new(
            vec![Endpoint::plaintext("127.0.0.1", port)],
            "bearer-abc".to_string(),
        )
    }

    #[tokio::test]
    async fn reads_the_familiar_roster_with_a_bearer() {
        let (port, rx) = serve(
            "HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"familiars\":[{\"id\":\"charm\",\"displayName\":\"Charm\",\"status\":\"online\"}]}",
        )
        .await;
        let store = InMemorySelectionStore::default();
        let roster = client(port)
            .familiars(None, &store)
            .await
            .expect("roster reads");
        assert_eq!(roster.familiars[0].id, "charm");

        let sent = rx.await.unwrap_or_default();
        assert!(sent.contains("Authorization: Bearer bearer-abc"), "got: {sent}");
        assert!(sent.starts_with("GET /api/client/v1/familiars"), "got: {sent}");
    }

    #[tokio::test]
    async fn a_401_becomes_a_typed_api_error() {
        let (port, _rx) = serve(
            "HTTP/1.1 401 Unauthorized\r\n\r\n{\"ok\":false,\"error\":{\"code\":\"unauthorized\",\"message\":\"Not authorized.\",\"retryable\":false}}",
        )
        .await;
        let store = InMemorySelectionStore::default();
        match client(port).familiars(None, &store).await {
            Err(CaveError::Api(envelope)) => assert_eq!(envelope.code, "unauthorized"),
            other => panic!("expected an API error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn no_reachable_candidate_is_unreachable_not_malformed() {
        let dead = {
            let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
            listener.local_addr().expect("addr").port()
        };
        let store = InMemorySelectionStore::default();
        match client(dead).familiars(None, &store).await {
            Err(CaveError::Unreachable { .. }) => {}
            other => panic!("expected Unreachable, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_conversation_page_passes_its_cursor() {
        let (port, rx) = serve(
            "HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"items\":[],\"nextCursor\":null,\"degraded\":false}",
        )
        .await;
        let store = InMemorySelectionStore::default();
        let _ = client(port)
            .conversations(Some("cur-1".to_string()), None, &store)
            .await
            .expect("page reads");
        let sent = rx.await.unwrap_or_default();
        assert!(sent.contains("cursor=cur-1"), "got: {sent}");
    }

    #[tokio::test]
    async fn a_conversation_id_is_percent_encoded_into_the_path() {
        let (port, rx) = serve(
            "HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"conversation\":{\"id\":\"c 1\",\"familiarId\":\"f\",\"title\":\"t\",\"preview\":\"p\",\"status\":\"idle\",\"createdAt\":\"x\",\"updatedAt\":\"x\",\"revision\":\"r\",\"revisionTime\":1},\"messages\":[]}",
        )
        .await;
        let store = InMemorySelectionStore::default();
        let _ = client(port).conversation("c 1", None, &store).await.expect("reads");
        let sent = rx.await.unwrap_or_default();
        assert!(sent.contains("/conversations/c%201"), "got: {sent}");
        assert!(!sent.contains("/conversations/c 1"), "unencoded space reached the wire");
    }

    #[tokio::test]
    async fn the_bearer_never_appears_in_an_error() {
        let (port, _rx) = serve("HTTP/1.1 500 Server Error\r\n\r\nnot json").await;
        let store = InMemorySelectionStore::default();
        let error = client(port).familiars(None, &store).await.expect_err("must fail");
        assert!(!format!("{error:?}").contains("bearer-abc"), "bearer leaked: {error:?}");
    }
}
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p cave-core client`

Expected: FAIL to compile — `CaveClient` undefined.

- [ ] **Step 3: Implement**

Prepend to `crates/cave-core/src/client.rs`:

```rust
//! Authenticated reads against a Cave instance.
//!
//! Owns candidate selection and envelope handling so callers never assemble a
//! request or decide which address to use. The bearer lives here and is never
//! placed in an error, a log, or a returned value.

use std::time::Duration;

use coven_transport::{
    connect, Endpoint, Exchange, GetRequest, RaceConfig, SelectionStore,
};

use crate::conversations::{ConversationDetail, ConversationSummary, Page};
use crate::error::{parse_raw_response, CaveError};
use crate::health::Health;
use crate::roster::{FamiliarRoster, ProjectList};

/// Per-request budget.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);

/// An authenticated Cave client over an ordered candidate list.
pub struct CaveClient {
    endpoints: Vec<Endpoint>,
    bearer: String,
}

impl std::fmt::Debug for CaveClient {
    /// Redacts the bearer. A derived `Debug` would print it into any log that
    /// formats a client.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CaveClient")
            .field("endpoints", &self.endpoints)
            .field("bearer", &"<redacted>")
            .finish()
    }
}

/// Percent-encode a path segment.
///
/// Conversation ids come from Cave, but they reach the wire inside a request
/// line, so they are encoded rather than trusted to be URL-safe.
fn encode_segment(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char);
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

impl CaveClient {
    /// Build a client over an ordered candidate list.
    pub fn new(endpoints: Vec<Endpoint>, bearer: String) -> Self {
        Self { endpoints, bearer }
    }

    /// The candidate addresses this client may use.
    pub fn endpoints(&self) -> &[Endpoint] {
        &self.endpoints
    }

    async fn get<T: serde::de::DeserializeOwned>(
        &self,
        path: String,
        network: Option<&str>,
        store: &dyn SelectionStore,
    ) -> Result<T, CaveError> {
        let request = GetRequest {
            path,
            headers: vec![("Authorization".to_string(), format!("Bearer {}", self.bearer))],
        };

        let config = RaceConfig {
            stagger: Duration::from_millis(250),
            timeout: REQUEST_TIMEOUT,
        };

        let outcome = connect_with(&self.endpoints, &request, config, network, store).await;

        match outcome {
            Exchange::Response { body, .. } => parse_raw_response(&body),
            Exchange::Refused => Err(CaveError::Unreachable {
                detail: "nothing is listening at that address".to_string(),
            }),
            Exchange::Unresolvable => Err(CaveError::Unreachable {
                detail: "the address does not resolve".to_string(),
            }),
            Exchange::TimedOut => Err(CaveError::Unreachable {
                detail: "no answer in time".to_string(),
            }),
            Exchange::Failed(detail) => Err(CaveError::Unreachable { detail }),
        }
    }

    /// Cave's identity and capabilities.
    pub async fn health(
        &self,
        network: Option<&str>,
        store: &dyn SelectionStore,
    ) -> Result<Health, CaveError> {
        self.get("/api/client/v1/health".to_string(), network, store).await
    }

    /// The familiar roster.
    pub async fn familiars(
        &self,
        network: Option<&str>,
        store: &dyn SelectionStore,
    ) -> Result<FamiliarRoster, CaveError> {
        self.get("/api/client/v1/familiars".to_string(), network, store).await
    }

    /// Available projects.
    pub async fn projects(
        &self,
        network: Option<&str>,
        store: &dyn SelectionStore,
    ) -> Result<ProjectList, CaveError> {
        self.get("/api/client/v1/projects".to_string(), network, store).await
    }

    /// One page of conversation summaries.
    pub async fn conversations(
        &self,
        cursor: Option<String>,
        network: Option<&str>,
        store: &dyn SelectionStore,
    ) -> Result<Page<ConversationSummary>, CaveError> {
        let path = match cursor {
            Some(cursor) => format!(
                "/api/client/v1/conversations?cursor={}",
                encode_segment(&cursor)
            ),
            None => "/api/client/v1/conversations".to_string(),
        };
        self.get(path, network, store).await
    }

    /// One conversation with its transcript.
    pub async fn conversation(
        &self,
        id: &str,
        network: Option<&str>,
        store: &dyn SelectionStore,
    ) -> Result<ConversationDetail, CaveError> {
        let path = format!("/api/client/v1/conversations/{}", encode_segment(id));
        self.get(path, network, store).await
    }
}

/// Run a request against the best candidate, preferring what worked last.
///
/// Wraps `coven_transport::connect`, which races on a path; this repeats the
/// same selection logic for a request carrying headers.
async fn connect_with(
    endpoints: &[Endpoint],
    request: &GetRequest,
    config: RaceConfig,
    network: Option<&str>,
    store: &dyn SelectionStore,
) -> Exchange {
    // Selection is decided by a cheap health probe, then the real request runs
    // against the chosen endpoint. Racing the authenticated request itself
    // would send the bearer to every candidate, including ones that turn out
    // to be the wrong service.
    let outcome = connect(endpoints, "/api/client/v1/health", config.clone(), network, store).await;
    let Some(index) = outcome.winner else {
        return outcome.exchange;
    };
    let Some(endpoint) = endpoints.get(index) else {
        return outcome.exchange;
    };
    coven_transport::get_endpoint(endpoint, request, config.timeout).await
}
```

The comment on `connect_with` is the load-bearing decision here: **never race an authenticated request.** Racing would deliver the bearer to every candidate address, including any that is not actually Cave.

Add to `src/lib.rs`:

```rust
mod client;

pub use client::CaveClient;
```

Add `#[derive(Clone)]` to `RaceConfig` in `coven-transport` if it is not already derived — `connect_with` clones it.

- [ ] **Step 4: Run the suite**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test --workspace`

Expected: PASS, `cave-core` gains 6 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add crates/cave-core/src/ crates/coven-transport/src/
git commit -S -m "Add the authenticated CaveClient

Selection is decided by a health probe and the authenticated request then runs
against the winner. Racing the real request would hand the bearer to every
candidate, including one that is not Cave.

Debug is hand-written to redact the bearer, and conversation ids are
percent-encoded rather than trusted to be URL-safe."
```

---

## Task 4: Grant Exchange

**Files:** Create `crates/cave-core/src/pairing.rs`; modify `src/lib.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/cave-core/src/pairing.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use coven_transport::Endpoint;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn serve(response: &'static str) -> (u16, tokio::sync::oneshot::Receiver<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let (tx, rx) = tokio::sync::oneshot::channel::<String>();
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).into_owned());
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        (port, rx)
    }

    #[tokio::test]
    async fn exchanges_a_grant_for_a_bearer() {
        let (port, rx) = serve(
            "HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"token\":\"bearer-xyz\",\"credential\":{\"id\":\"cred-1\",\"scopes\":[\"chat:read\"]}}",
        )
        .await;
        let endpoint = Endpoint::plaintext("127.0.0.1", port);
        let result = exchange_grant(&endpoint, "pair-1", "s3cret", "install-1")
            .await
            .expect("exchange succeeds");
        assert_eq!(result.token, "bearer-xyz");
        assert_eq!(result.credential.id, "cred-1");

        let sent = rx.await.unwrap_or_default();
        assert!(
            sent.starts_with("POST /api/client/v1/pairing/requests/pair-1/exchange"),
            "got: {sent}"
        );
        assert!(sent.contains("X-Coven-Pairing-Secret: s3cret"), "got: {sent}");
        assert!(sent.contains("install-1"), "installation id must be sent");
    }

    #[tokio::test]
    async fn a_replayed_grant_becomes_a_typed_api_error() {
        let (port, _rx) = serve(
            "HTTP/1.1 409 Conflict\r\n\r\n{\"ok\":false,\"error\":{\"code\":\"pairing_consumed\",\"message\":\"Already used.\",\"retryable\":false}}",
        )
        .await;
        let endpoint = Endpoint::plaintext("127.0.0.1", port);
        match exchange_grant(&endpoint, "pair-1", "s3cret", "install-1").await {
            Err(CaveError::Api(envelope)) => assert_eq!(envelope.code, "pairing_consumed"),
            other => panic!("expected an API error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn the_pairing_secret_never_appears_in_an_error() {
        let (port, _rx) = serve("HTTP/1.1 500 Server Error\r\n\r\nnot json").await;
        let endpoint = Endpoint::plaintext("127.0.0.1", port);
        let error = exchange_grant(&endpoint, "pair-1", "s3cret", "install-1")
            .await
            .expect_err("must fail");
        assert!(!format!("{error:?}").contains("s3cret"), "secret leaked: {error:?}");
    }

    #[tokio::test]
    async fn a_response_without_a_token_is_malformed() {
        let (port, _rx) = serve("HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"credential\":{\"id\":\"c\",\"scopes\":[]}}").await;
        let endpoint = Endpoint::plaintext("127.0.0.1", port);
        assert!(matches!(
            exchange_grant(&endpoint, "pair-1", "s3cret", "install-1").await,
            Err(CaveError::Malformed(_))
        ));
    }
}
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p cave-core pairing`

Expected: FAIL to compile — `exchange_grant` undefined.

- [ ] **Step 3: Implement**

Prepend to `crates/cave-core/src/pairing.rs`:

```rust
//! Exchanging a single-use enrollment grant for a scoped bearer.

use std::time::Duration;

use coven_transport::{post_endpoint, Endpoint, Exchange, PostRequest};
use serde::Deserialize;

use crate::error::{parse_raw_response, CaveError};

/// Budget for one exchange.
const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(15);

/// The credential Cave minted.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ExchangedCredential {
    /// Credential identifier, used to revoke.
    pub id: String,
    /// Granted scopes.
    #[serde(default)]
    pub scopes: Vec<String>,
}

/// A successful exchange.
///
/// The bearer appears exactly once, here. Callers must store it immediately
/// and must never log or re-return it.
#[derive(Debug, Clone, Deserialize)]
pub struct ExchangeResponse {
    /// The scoped bearer token.
    pub token: String,
    /// Metadata about the credential it belongs to.
    pub credential: ExchangedCredential,
}

/// Exchange an approved pairing grant for a bearer.
///
/// The secret travels only in `X-Coven-Pairing-Secret`, never in the path or
/// the body, so it cannot land in a server access log.
pub async fn exchange_grant(
    endpoint: &Endpoint,
    pairing_request_id: &str,
    pairing_secret: &str,
    installation_id: &str,
) -> Result<ExchangeResponse, CaveError> {
    let body = serde_json::json!({ "installationId": installation_id }).to_string();
    let request = PostRequest {
        path: format!("/api/client/v1/pairing/requests/{pairing_request_id}/exchange"),
        body,
        headers: vec![(
            "X-Coven-Pairing-Secret".to_string(),
            pairing_secret.to_string(),
        )],
    };

    match post_endpoint(endpoint, &request, EXCHANGE_TIMEOUT).await {
        Exchange::Response { body, .. } => parse_raw_response(&body),
        Exchange::Refused => Err(CaveError::Unreachable {
            detail: "nothing is listening at that address".to_string(),
        }),
        Exchange::Unresolvable => Err(CaveError::Unreachable {
            detail: "the address does not resolve".to_string(),
        }),
        Exchange::TimedOut => Err(CaveError::Unreachable {
            detail: "no answer in time".to_string(),
        }),
        Exchange::Failed(detail) => Err(CaveError::Unreachable { detail }),
    }
}
```

Add to `src/lib.rs`:

```rust
mod pairing;

pub use pairing::{exchange_grant, ExchangeResponse, ExchangedCredential};
```

- [ ] **Step 4: Run the suite**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test --workspace`

Expected: PASS, `cave-core` gains 4 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add crates/cave-core/src/
git commit -S -m "Add pairing grant exchange to cave-core

The secret travels only in X-Coven-Pairing-Secret, never in the path or body,
so it cannot land in a server access log. A response without a token is
Malformed rather than an empty success."
```

---

## Task 5: The Enrollment Flow in Rust

Decode, verify the instance, exchange, and report the working endpoint — one call.

**Files:** Create `rust/ffi/src/session.rs`; modify `rust/ffi/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Create `rust/ffi/src/session.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    /// Serve health, then the exchange, on one port.
    async fn serve_enrollment(instance_id: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            for _ in 0..8 {
                let Ok((mut stream, _)) = listener.accept().await else { return };
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let request = String::from_utf8_lossy(&buf[..n]).to_string();
                let response = if request.contains("/exchange") {
                    "HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"token\":\"bearer-xyz\",\"credential\":{\"id\":\"cred-1\",\"scopes\":[\"chat:read\"]}}".to_string()
                } else {
                    format!(
                        "HTTP/1.1 200 OK\r\n\r\n{{\"ok\":true,\"service\":\"coven-cave\",\"apiVersion\":\"1.0\",\"minimumClientVersion\":\"0.1.0\",\"instanceId\":\"{instance_id}\",\"pairingRequired\":true,\"capabilities\":[]}}"
                    )
                };
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        port
    }

    fn uri_for(port: u16, instance_id: &str) -> String {
        let json = format!(
            r#"{{"v":1,"instanceId":"{instance_id}","pairingRequestId":"p1","pairingSecret":"s1","expiresAt":9999999999999,"candidates":[{{"host":"127.0.0.1","port":{port},"tls":false}}]}}"#
        );
        let data = base64url(json.as_bytes());
        format!("opencoven-chat://enroll?v=1&d={data}")
    }

    fn base64url(input: &[u8]) -> String {
        const A: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        let mut out = String::new();
        for chunk in input.chunks(3) {
            let b0 = chunk[0] as u32;
            let b1 = *chunk.get(1).unwrap_or(&0) as u32;
            let b2 = *chunk.get(2).unwrap_or(&0) as u32;
            let t = (b0 << 16) | (b1 << 8) | b2;
            out.push(A[(t >> 18) as usize & 63] as char);
            out.push(A[(t >> 12) as usize & 63] as char);
            if chunk.len() > 1 { out.push(A[(t >> 6) as usize & 63] as char); }
            if chunk.len() > 2 { out.push(A[t as usize & 63] as char); }
        }
        out
    }

    #[test]
    fn enrolls_against_a_matching_instance() {
        let result = crate::runtime().block_on(async {
            let port = serve_enrollment("i1").await;
            enroll(uri_for(port, "i1"), "install-1".to_string()).await
        });
        let enrolled = result.expect("enrollment succeeds");
        assert_eq!(enrolled.bearer, "bearer-xyz");
        assert_eq!(enrolled.instance_id, "i1");
        assert_eq!(enrolled.credential_id, "cred-1");
        assert_eq!(enrolled.endpoint_key, format!("127.0.0.1:{}", enrolled.port));
    }

    #[test]
    fn refuses_when_the_instance_id_does_not_match_the_code() {
        let result = crate::runtime().block_on(async {
            // The code claims i1; the server says i2.
            let port = serve_enrollment("i2").await;
            enroll(uri_for(port, "i1"), "install-1".to_string()).await
        });
        match result {
            Err(ChatError::Enrollment { message }) => {
                assert!(message.contains("different"), "{message}");
            }
            other => panic!("expected an Enrollment error, got {other:?}"),
        }
    }

    #[test]
    fn refuses_an_expired_code() {
        let json = r#"{"v":1,"instanceId":"i1","pairingRequestId":"p1","pairingSecret":"s1","expiresAt":1,"candidates":[{"host":"127.0.0.1","port":1,"tls":false}]}"#;
        let uri = format!("opencoven-chat://enroll?v=1&d={}", base64url(json.as_bytes()));
        let result = crate::runtime().block_on(enroll(uri, "install-1".to_string()));
        match result {
            Err(ChatError::Enrollment { message }) => {
                assert!(message.contains("expired"), "{message}");
            }
            other => panic!("expected an Enrollment error, got {other:?}"),
        }
    }

    #[test]
    fn an_unreachable_code_reports_unreachable_not_enrollment_failure() {
        let dead = crate::runtime().block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
            listener.local_addr().expect("addr").port()
        });
        let result = crate::runtime().block_on(enroll(uri_for(dead, "i1"), "install-1".to_string()));
        assert!(
            matches!(result, Err(ChatError::Unreachable { .. })),
            "got {result:?}"
        );
    }
}
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios/rust && cargo test -p chat-ios-ffi`

Expected: FAIL to compile — `enroll` undefined.

- [ ] **Step 3: Implement**

Prepend to `rust/ffi/src/session.rs`:

```rust
//! Enrollment and the authenticated session Swift drives.

use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use cave_core::{exchange_grant, CaveClient, CaveError};
use coven_transport::{connect, InMemorySelectionStore, RaceConfig};

use crate::ChatError;

/// What a successful enrollment produced.
///
/// The bearer appears here exactly once. Swift must store it in the Keychain
/// immediately and must not log it.
#[derive(Debug, Clone, uniffi::Record)]
pub struct EnrollmentResult {
    /// The scoped bearer token.
    pub bearer: String,
    /// Cave instance identity, confirmed against the scanned code.
    pub instance_id: String,
    /// Credential identifier, for later revocation display.
    pub credential_id: String,
    /// Host that answered.
    pub host: String,
    /// Port that answered.
    pub port: u16,
    /// Stable key for the endpoint that answered.
    pub endpoint_key: String,
    /// The full candidate list, to persist for later reconnection.
    pub candidates: Vec<crate::EnrollmentCandidateFfi>,
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}

impl From<CaveError> for ChatError {
    fn from(error: CaveError) -> Self {
        match error {
            CaveError::Api(envelope) => Self::Api {
                code: envelope.code,
                message: envelope.message,
                retryable: envelope.retryable,
            },
            CaveError::Malformed(detail) => Self::Malformed { detail },
            CaveError::Unreachable { detail } => Self::Unreachable { detail },
        }
    }
}

/// Enroll from a scanned code.
///
/// Decodes, confirms the code has not expired, races the candidates for a
/// health response, checks the answering instance is the one the code names,
/// and only then exchanges the grant.
///
/// The instance check is not ceremony. A code names a specific Cave; an
/// address that answers with a different one means the address is wrong or
/// something else is listening, and exchanging a grant there would hand a
/// single-use secret to the wrong party.
#[uniffi::export(async_runtime = "tokio")]
pub async fn enroll(uri: String, installation_id: String) -> Result<EnrollmentResult, ChatError> {
    let payload = cave_core::decode_enrollment_uri(&uri).map_err(|error| ChatError::Enrollment {
        message: match error {
            cave_core::EnrollmentError::Scheme(_) => {
                "the scanned code is not an OpenCoven Chat enrollment code".to_string()
            }
            cave_core::EnrollmentError::Version(version) => {
                format!("this app does not support enrollment payload version {version}")
            }
            cave_core::EnrollmentError::Malformed(_) => {
                "the scanned code was damaged or incomplete".to_string()
            }
        },
    })?;

    if payload.is_expired(now_millis()) {
        return Err(ChatError::Enrollment {
            message: "this enrollment code has expired; generate a new one in Cave".to_string(),
        });
    }

    let endpoints = payload.endpoints().map_err(|error| ChatError::Enrollment {
        message: format!("the scanned code is unusable: {error}"),
    })?;

    let store = InMemorySelectionStore::default();
    let config = RaceConfig {
        stagger: Duration::from_millis(250),
        timeout: Duration::from_secs(10),
    };
    let outcome = connect(&endpoints, "/api/client/v1/health", config, None, &store).await;

    let (index, body) = match (outcome.winner, outcome.exchange) {
        (Some(index), coven_transport::Exchange::Response { body, .. }) => (index, body),
        (_, coven_transport::Exchange::Failed(detail)) => {
            return Err(ChatError::Unreachable { detail })
        }
        (_, coven_transport::Exchange::Refused) => {
            return Err(ChatError::Unreachable {
                detail: "nothing is listening at that address".to_string(),
            })
        }
        (_, coven_transport::Exchange::Unresolvable) => {
            return Err(ChatError::Unreachable {
                detail: "the address does not resolve".to_string(),
            })
        }
        (_, coven_transport::Exchange::TimedOut) => {
            return Err(ChatError::Unreachable {
                detail: "no answer in time".to_string(),
            })
        }
        (None, _) => {
            return Err(ChatError::Unreachable {
                detail: "no candidate address answered".to_string(),
            })
        }
    };

    let health: cave_core::Health = cave_core::parse_raw_response(&body)?;
    if health.instance_id != payload.instance_id {
        return Err(ChatError::Enrollment {
            message: "that address answers with a different Cave than the code names".to_string(),
        });
    }

    let endpoint = endpoints
        .get(index)
        .ok_or_else(|| ChatError::Unreachable {
            detail: "the winning candidate disappeared".to_string(),
        })?;

    let exchanged = exchange_grant(
        endpoint,
        &payload.pairing_request_id,
        &payload.pairing_secret,
        &installation_id,
    )
    .await?;

    let candidate = &payload.candidates[index];
    Ok(EnrollmentResult {
        bearer: exchanged.token,
        instance_id: health.instance_id,
        credential_id: exchanged.credential.id,
        host: candidate.host.clone(),
        port: candidate.port,
        endpoint_key: format!("{}:{}", candidate.host, candidate.port),
        candidates: payload
            .candidates
            .iter()
            .map(|c| crate::EnrollmentCandidateFfi {
                host: c.host.clone(),
                port: c.port,
                tls: c.tls,
                pin_sha256: c.pin_sha256.clone(),
            })
            .collect(),
    })
}
```

Add `mod session;` and `pub use session::EnrollmentResult;` to `rust/ffi/src/lib.rs`.

- [ ] **Step 4: Run the tests**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios/rust && cargo test -p chat-ios-ffi`

Expected: PASS, 4 new tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
git add rust/ffi/src/
git commit -S -m "Add the enrollment flow to chat-ios-ffi

Confirms the answering instance is the one the code names before exchanging.
A code names a specific Cave; exchanging at an address that answers with a
different one would hand a single-use secret to the wrong party."
```

---

## Task 6: The Session Object

**Files:** Modify `rust/ffi/src/session.rs`, `rust/ffi/src/types.rs` (new)

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `rust/ffi/src/session.rs`:

```rust
    #[test]
    fn a_session_reads_the_roster() {
        let roster = crate::runtime().block_on(async {
            let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
            let port = listener.local_addr().expect("addr").port();
            tokio::spawn(async move {
                for _ in 0..4 {
                    let Ok((mut stream, _)) = listener.accept().await else { return };
                    let mut buf = [0u8; 2048];
                    let n = stream.read(&mut buf).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&buf[..n]).to_string();
                    let response = if request.contains("/familiars") {
                        "HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"familiars\":[{\"id\":\"charm\",\"displayName\":\"Charm\",\"status\":\"online\"}]}"
                    } else {
                        "HTTP/1.1 200 OK\r\n\r\n{\"ok\":true,\"service\":\"coven-cave\",\"apiVersion\":\"1.0\",\"minimumClientVersion\":\"0.1.0\",\"instanceId\":\"i1\",\"pairingRequired\":true,\"capabilities\":[]}"
                    };
                    let _ = stream.write_all(response.as_bytes()).await;
                }
            });

            let session = CaveSession::new(
                vec![crate::EnrollmentCandidateFfi {
                    host: "127.0.0.1".to_string(),
                    port,
                    tls: false,
                    pin_sha256: None,
                }],
                "bearer-abc".to_string(),
            )
            .expect("session builds");
            session.familiars(None).await
        });
        let roster = roster.expect("roster reads");
        assert_eq!(roster.len(), 1);
        assert_eq!(roster[0].id, "charm");
        assert_eq!(roster[0].display_name, "Charm");
    }

    #[test]
    fn a_session_refuses_an_empty_candidate_list() {
        assert!(CaveSession::new(vec![], "bearer".to_string()).is_err());
    }

    #[test]
    fn a_session_refuses_a_tls_candidate_without_a_pin() {
        let result = CaveSession::new(
            vec![crate::EnrollmentCandidateFfi {
                host: "h".to_string(),
                port: 443,
                tls: true,
                pin_sha256: None,
            }],
            "bearer".to_string(),
        );
        assert!(result.is_err(), "an unpinned TLS session must not be constructible");
    }
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios/rust && cargo test -p chat-ios-ffi`

Expected: FAIL to compile — `CaveSession` undefined.

- [ ] **Step 3: Create the boundary types**

Create `rust/ffi/src/types.rs`:

```rust
//! Contract types as Swift sees them.
//!
//! Mirrors `cave-core`'s types with UniFFI derives. The duplication is the
//! price of keeping `cave-core` free of FFI scaffolding, and the `From`
//! implementations are the only place the two shapes have to agree.

/// One familiar.
#[derive(Debug, Clone, uniffi::Record)]
pub struct FamiliarFfi {
    /// Stable identifier.
    pub id: String,
    /// Name shown to the user.
    pub display_name: String,
    /// Short persona label.
    pub role: Option<String>,
    /// Longer description.
    pub description: Option<String>,
    /// Declared pronouns.
    pub pronouns: Option<String>,
    /// Availability.
    pub status: String,
    /// Compact visual marker.
    pub emoji: Option<String>,
}

impl From<cave_core::Familiar> for FamiliarFfi {
    fn from(f: cave_core::Familiar) -> Self {
        Self {
            id: f.id,
            display_name: f.display_name,
            role: f.role,
            description: f.description,
            pronouns: f.pronouns,
            status: f.status,
            emoji: f.emoji,
        }
    }
}

/// One conversation summary.
#[derive(Debug, Clone, uniffi::Record)]
pub struct ConversationSummaryFfi {
    /// Stable identifier.
    pub id: String,
    /// Owning familiar. Never empty.
    pub familiar_id: String,
    /// Display title.
    pub title: String,
    /// Preview of the latest turn.
    pub preview: String,
    /// Run status.
    pub status: String,
    /// Whether pinned.
    pub pinned: bool,
    /// Whether archived.
    pub archived: bool,
    /// Last update, ISO 8601.
    pub updated_at: String,
    /// Opaque server revision.
    pub revision: String,
    /// Revision time, epoch milliseconds.
    pub revision_time: i64,
}

impl From<cave_core::ConversationSummary> for ConversationSummaryFfi {
    fn from(c: cave_core::ConversationSummary) -> Self {
        Self {
            id: c.id,
            familiar_id: c.familiar_id,
            title: c.title,
            preview: c.preview,
            status: c.status,
            pinned: c.pinned,
            archived: c.archived_at.is_some(),
            updated_at: c.updated_at,
            revision: c.revision,
            revision_time: c.revision_time,
        }
    }
}

/// A page of conversation summaries.
#[derive(Debug, Clone, uniffi::Record)]
pub struct ConversationPageFfi {
    /// This page's rows.
    pub items: Vec<ConversationSummaryFfi>,
    /// Cursor for the next page.
    pub next_cursor: Option<String>,
    /// Whether Cave served this from a degraded path.
    pub degraded: bool,
}

/// One attachment.
#[derive(Debug, Clone, uniffi::Record)]
pub struct AttachmentFfi {
    /// Stable identifier.
    pub id: String,
    /// Original filename.
    pub name: String,
    /// MIME type as Cave validated it.
    pub mime_type: String,
    /// Size in bytes.
    pub size_bytes: u64,
}

/// One canonical turn.
#[derive(Debug, Clone, uniffi::Record)]
pub struct MessageFfi {
    /// Stable identifier.
    pub id: String,
    /// Author role.
    pub role: String,
    /// Message body.
    pub text: String,
    /// Creation timestamp, ISO 8601.
    pub created_at: String,
    /// Attachments on this turn.
    pub attachments: Vec<AttachmentFfi>,
}

/// A conversation with its transcript.
#[derive(Debug, Clone, uniffi::Record)]
pub struct ConversationDetailFfi {
    /// The conversation.
    pub conversation: ConversationSummaryFfi,
    /// Its turns, oldest first.
    pub messages: Vec<MessageFfi>,
}

impl From<cave_core::ConversationDetail> for ConversationDetailFfi {
    fn from(d: cave_core::ConversationDetail) -> Self {
        Self {
            conversation: d.conversation.into(),
            messages: d
                .messages
                .into_iter()
                .map(|m| MessageFfi {
                    id: m.id,
                    role: m.role,
                    text: m.text,
                    created_at: m.created_at,
                    attachments: m
                        .attachments
                        .into_iter()
                        .map(|a| AttachmentFfi {
                            id: a.id,
                            name: a.name,
                            mime_type: a.mime_type,
                            size_bytes: a.size_bytes,
                        })
                        .collect(),
                })
                .collect(),
        }
    }
}
```

- [ ] **Step 4: Implement the session**

Add to `rust/ffi/src/session.rs`:

```rust
use crate::types::{ConversationDetailFfi, ConversationPageFfi, FamiliarFfi};

/// An authenticated Cave session.
///
/// Holds the bearer and the candidate list. Swift drives it and never sees a
/// request, an address decision, or the bearer again after enrollment.
#[derive(uniffi::Object)]
pub struct CaveSession {
    client: CaveClient,
    store: InMemorySelectionStore,
}

#[uniffi::export(async_runtime = "tokio")]
impl CaveSession {
    /// Build a session from stored candidates and a stored bearer.
    ///
    /// Fails on an empty candidate list or a TLS candidate without a usable
    /// pin. An unpinned TLS session must not be constructible at all.
    #[uniffi::constructor]
    pub fn new(
        candidates: Vec<crate::EnrollmentCandidateFfi>,
        bearer: String,
    ) -> Result<Arc<Self>, ChatError> {
        if candidates.is_empty() {
            return Err(ChatError::Enrollment {
                message: "no stored addresses for this Cave".to_string(),
            });
        }
        let payload = cave_core::EnrollmentPayload {
            v: 1,
            instance_id: String::new(),
            pairing_request_id: String::new(),
            pairing_secret: String::new(),
            expires_at: i64::MAX,
            candidates: candidates
                .into_iter()
                .map(|c| cave_core::EnrollmentCandidate {
                    host: c.host,
                    port: c.port,
                    tls: c.tls,
                    pin_sha256: c.pin_sha256,
                })
                .collect(),
        };
        let endpoints = payload.endpoints().map_err(|error| ChatError::Enrollment {
            message: format!("stored addresses are unusable: {error}"),
        })?;

        Ok(Arc::new(Self {
            client: CaveClient::new(endpoints, bearer),
            store: InMemorySelectionStore::default(),
        }))
    }

    /// The familiar roster.
    pub async fn familiars(&self, network: Option<String>) -> Result<Vec<FamiliarFfi>, ChatError> {
        let roster = self
            .client
            .familiars(network.as_deref(), &self.store)
            .await?;
        Ok(roster.familiars.into_iter().map(Into::into).collect())
    }

    /// One page of conversation summaries.
    pub async fn conversations(
        &self,
        cursor: Option<String>,
        network: Option<String>,
    ) -> Result<ConversationPageFfi, ChatError> {
        let page = self
            .client
            .conversations(cursor, network.as_deref(), &self.store)
            .await?;
        Ok(ConversationPageFfi {
            items: page.items.into_iter().map(Into::into).collect(),
            next_cursor: page.next_cursor,
            degraded: page.degraded,
        })
    }

    /// One conversation with its transcript.
    pub async fn conversation(
        &self,
        id: String,
        network: Option<String>,
    ) -> Result<ConversationDetailFfi, ChatError> {
        Ok(self
            .client
            .conversation(&id, network.as_deref(), &self.store)
            .await?
            .into())
    }
}
```

Add `mod types;` and re-export the types from `rust/ffi/src/lib.rs`.

- [ ] **Step 5: Run the tests**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios/rust && cargo test -p chat-ios-ffi`

Expected: PASS, 3 new tests.

- [ ] **Step 6: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
git add rust/ffi/src/
git commit -S -m "Add the CaveSession object

An unpinned TLS session is not constructible: the constructor rejects a TLS
candidate with no usable pin rather than silently downgrading."
```

---

## Task 7: The Revision-Ordered Cache

**Files:** Create `rust/ffi/src/cache.rs`; modify `rust/ffi/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Create `rust/ffi/src/cache.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> std::path::PathBuf {
        let base = std::env::temp_dir().join(format!("chat-ios-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("temp dir");
        base
    }

    fn summary(id: &str, revision: &str, time: i64) -> crate::ConversationSummaryFfi {
        crate::ConversationSummaryFfi {
            id: id.to_string(),
            familiar_id: "charm".to_string(),
            title: "T".to_string(),
            preview: "P".to_string(),
            status: "idle".to_string(),
            pinned: false,
            archived: false,
            updated_at: "x".to_string(),
            revision: revision.to_string(),
            revision_time: time,
        }
    }

    #[test]
    fn stores_and_reads_back_conversations() {
        let cache = ReadCache::open(dir().to_string_lossy().to_string(), "i1".to_string())
            .expect("cache opens");
        cache.put_conversations(vec![summary("c1", "r1", 100)]).expect("stored");
        let read = cache.conversations().expect("read");
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].revision, "r1");
    }

    #[test]
    fn a_newer_revision_replaces_an_older_one() {
        let cache = ReadCache::open(dir().to_string_lossy().to_string(), "i1".to_string())
            .expect("cache opens");
        cache.put_conversations(vec![summary("c1", "r1", 100)]).expect("stored");
        cache.put_conversations(vec![summary("c1", "r2", 200)]).expect("stored");
        assert_eq!(cache.conversations().expect("read")[0].revision, "r2");
    }

    #[test]
    fn a_stale_revision_does_not_overwrite_a_newer_one() {
        let cache = ReadCache::open(dir().to_string_lossy().to_string(), "i1".to_string())
            .expect("cache opens");
        cache.put_conversations(vec![summary("c1", "r2", 200)]).expect("stored");
        cache.put_conversations(vec![summary("c1", "r1", 100)]).expect("stored");
        assert_eq!(
            cache.conversations().expect("read")[0].revision,
            "r2",
            "a slow response must not overwrite fresher state"
        );
    }

    #[test]
    fn a_different_instance_does_not_see_another_instances_cache() {
        let base = dir().to_string_lossy().to_string();
        let one = ReadCache::open(base.clone(), "i1".to_string()).expect("opens");
        one.put_conversations(vec![summary("c1", "r1", 100)]).expect("stored");
        let two = ReadCache::open(base, "i2".to_string()).expect("opens");
        assert!(two.conversations().expect("read").is_empty());
    }

    #[test]
    fn cached_data_survives_reopening() {
        let base = dir().to_string_lossy().to_string();
        let one = ReadCache::open(base.clone(), "i1".to_string()).expect("opens");
        one.put_conversations(vec![summary("c1", "r1", 100)]).expect("stored");
        let two = ReadCache::open(base, "i1".to_string()).expect("opens");
        assert_eq!(two.conversations().expect("read").len(), 1);
    }

    #[test]
    fn a_corrupt_cache_file_reads_as_empty_rather_than_failing() {
        let base = dir();
        let cache = ReadCache::open(base.to_string_lossy().to_string(), "i1".to_string())
            .expect("opens");
        cache.put_conversations(vec![summary("c1", "r1", 100)]).expect("stored");
        std::fs::write(base.join("i1-conversations.json"), b"{ truncated").expect("corrupt it");
        assert!(cache.conversations().expect("read").is_empty());
    }

    #[test]
    fn clearing_removes_everything_for_the_instance() {
        let cache = ReadCache::open(dir().to_string_lossy().to_string(), "i1".to_string())
            .expect("opens");
        cache.put_conversations(vec![summary("c1", "r1", 100)]).expect("stored");
        cache.clear().expect("cleared");
        assert!(cache.conversations().expect("read").is_empty());
    }
}
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios/rust && cargo test -p chat-ios-ffi cache`

Expected: FAIL to compile — `ReadCache` undefined.

- [ ] **Step 3: Implement**

Prepend to `rust/ffi/src/cache.rs`:

```rust
//! A replaceable read cache, scoped per Cave instance.
//!
//! Exists only to make startup and brief outages readable. Nothing here is
//! canonical: on any doubt the cache is discarded and Cave is asked again.
//!
//! Not encrypted at the application layer. The file lives in the app's
//! container with iOS Data Protection, which is hardware-backed and stronger
//! than a key this process would have to hold anyway. Swift sets the
//! protection class when it creates the directory.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use cave_core::{compare_revision, RevisionOrder};
use serde::{Deserialize, Serialize};

use crate::types::ConversationSummaryFfi;
use crate::ChatError;

#[derive(Debug, Serialize, Deserialize)]
struct CachedConversations {
    version: u32,
    items: Vec<CachedSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CachedSummary {
    id: String,
    familiar_id: String,
    title: String,
    preview: String,
    status: String,
    pinned: bool,
    archived: bool,
    updated_at: String,
    revision: String,
    revision_time: i64,
}

impl From<&ConversationSummaryFfi> for CachedSummary {
    fn from(s: &ConversationSummaryFfi) -> Self {
        Self {
            id: s.id.clone(),
            familiar_id: s.familiar_id.clone(),
            title: s.title.clone(),
            preview: s.preview.clone(),
            status: s.status.clone(),
            pinned: s.pinned,
            archived: s.archived,
            updated_at: s.updated_at.clone(),
            revision: s.revision.clone(),
            revision_time: s.revision_time,
        }
    }
}

impl From<CachedSummary> for ConversationSummaryFfi {
    fn from(s: CachedSummary) -> Self {
        Self {
            id: s.id,
            familiar_id: s.familiar_id,
            title: s.title,
            preview: s.preview,
            status: s.status,
            pinned: s.pinned,
            archived: s.archived,
            updated_at: s.updated_at,
            revision: s.revision,
            revision_time: s.revision_time,
        }
    }
}

/// A per-instance read cache on disk.
#[derive(uniffi::Object)]
pub struct ReadCache {
    directory: PathBuf,
    instance_id: String,
    lock: Mutex<()>,
}

#[uniffi::export]
impl ReadCache {
    /// Open, or create, the cache for one Cave instance.
    #[uniffi::constructor]
    pub fn open(directory: String, instance_id: String) -> Result<std::sync::Arc<Self>, ChatError> {
        let directory = PathBuf::from(directory);
        std::fs::create_dir_all(&directory).map_err(|e| ChatError::Malformed {
            detail: format!("cache directory unusable: {e}"),
        })?;
        Ok(std::sync::Arc::new(Self {
            directory,
            instance_id,
            lock: Mutex::new(()),
        }))
    }

    /// Cached conversation summaries, or empty.
    pub fn conversations(&self) -> Result<Vec<ConversationSummaryFfi>, ChatError> {
        let _guard = self.lock.lock().map_err(|_| ChatError::Malformed {
            detail: "cache lock poisoned".to_string(),
        })?;
        Ok(self
            .read()
            .items
            .into_iter()
            .map(Into::into)
            .collect())
    }

    /// Merge fresh summaries in, keeping whichever revision is newer.
    ///
    /// This is where the ordering rule earns its place: a slow response that
    /// arrives after a fresher one must not overwrite it.
    pub fn put_conversations(
        &self,
        items: Vec<ConversationSummaryFfi>,
    ) -> Result<(), ChatError> {
        let _guard = self.lock.lock().map_err(|_| ChatError::Malformed {
            detail: "cache lock poisoned".to_string(),
        })?;

        let mut existing: HashMap<String, CachedSummary> = self
            .read()
            .items
            .into_iter()
            .map(|item| (item.id.clone(), item))
            .collect();

        for candidate in items.iter().map(CachedSummary::from) {
            match existing.get(&candidate.id) {
                Some(known)
                    if compare_revision(
                        &candidate.revision,
                        candidate.revision_time,
                        &known.revision,
                        known.revision_time,
                    ) != RevisionOrder::Newer =>
                {
                    // Same or older: keep what is known.
                }
                _ => {
                    existing.insert(candidate.id.clone(), candidate);
                }
            }
        }

        let mut merged: Vec<CachedSummary> = existing.into_values().collect();
        merged.sort_by(|a, b| b.revision_time.cmp(&a.revision_time).then(a.id.cmp(&b.id)));
        self.write(&CachedConversations { version: 1, items: merged })
    }

    /// Discard everything cached for this instance.
    pub fn clear(&self) -> Result<(), ChatError> {
        let _guard = self.lock.lock().map_err(|_| ChatError::Malformed {
            detail: "cache lock poisoned".to_string(),
        })?;
        match std::fs::remove_file(self.path()) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(ChatError::Malformed {
                detail: format!("could not clear the cache: {e}"),
            }),
        }
    }
}

impl ReadCache {
    fn path(&self) -> PathBuf {
        self.directory
            .join(format!("{}-conversations.json", self.instance_id))
    }

    /// Read, treating any problem as an empty cache.
    ///
    /// A cache is replaceable by definition, so a corrupt file is a reason to
    /// refetch rather than to fail.
    fn read(&self) -> CachedConversations {
        std::fs::read_to_string(self.path())
            .ok()
            .and_then(|text| serde_json::from_str::<CachedConversations>(&text).ok())
            .filter(|cached| cached.version == 1)
            .unwrap_or(CachedConversations { version: 1, items: Vec::new() })
    }

    fn write(&self, value: &CachedConversations) -> Result<(), ChatError> {
        let path = self.path();
        let temporary = path.with_extension("tmp");
        let text = serde_json::to_string(value).map_err(|e| ChatError::Malformed {
            detail: format!("could not serialize the cache: {e}"),
        })?;
        std::fs::write(&temporary, text).map_err(|e| ChatError::Malformed {
            detail: format!("could not write the cache: {e}"),
        })?;
        std::fs::rename(&temporary, &path).map_err(|e| ChatError::Malformed {
            detail: format!("could not replace the cache: {e}"),
        })
    }
}
```

Add `mod cache;` and `pub use cache::ReadCache;` to `rust/ffi/src/lib.rs`.

- [ ] **Step 4: Run the tests**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios/rust && cargo test -p chat-ios-ffi`

Expected: PASS, 7 new tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
git add rust/ffi/src/
git commit -S -m "Add the revision-ordered read cache

A stale response cannot overwrite a newer known revision, enforced in the
merge rather than at each call site. A corrupt file reads as empty, because a
cache is replaceable and refetching beats failing.

Not encrypted at the application layer: the container's Data Protection is
hardware-backed and stronger than a key this process would have to hold."
```

---

## Task 8: The Connection State Machine

**Files:** Create `app/Sources/Support/ConnectionState.swift`, `app/Tests/ConnectionStateTests.swift`

- [ ] **Step 1: Write the failing test**

Create `app/Tests/ConnectionStateTests.swift`:

```swift
import XCTest
@testable import ChatIOS

final class ConnectionStateTests: XCTestCase {
    func testAnUnenrolledAppIsUnpaired() {
        XCTAssertEqual(ConnectionState.initial(hasCredential: false), .unpaired)
    }

    func testAnEnrolledAppStartsLocating() {
        XCTAssertEqual(ConnectionState.initial(hasCredential: true), .locating)
    }

    func testAnApiErrorForRevocationClearsToUnpaired() {
        let state = ConnectionState.after(
            error: .Api(code: "unauthorized", message: "Not authorized.", retryable: false)
        )
        XCTAssertEqual(state, .authenticationLost)
    }

    func testAnUnresolvableAddressReadsAsOverlayUnavailable() {
        // The phone cannot see the user's overlay. Nothing resolving is the
        // strongest available signal that the overlay itself is down.
        let state = ConnectionState.after(error: .Unreachable(detail: "the address does not resolve"))
        XCTAssertEqual(state, .overlayUnavailable)
    }

    func testARefusedConnectionReadsAsCaveUnreachable() {
        let state = ConnectionState.after(
            error: .Unreachable(detail: "nothing is listening at that address")
        )
        XCTAssertEqual(state, .unreachable)
    }

    func testOverlayUnavailableAndUnreachableAreDistinct() {
        // Different instructions to the user: "start your VPN" versus "wake
        // your Cave host". Collapsing them serves neither.
        XCTAssertNotEqual(ConnectionState.overlayUnavailable, ConnectionState.unreachable)
    }

    func testAMalformedResponseIsIncompatibleNotUnreachable() {
        let state = ConnectionState.after(error: .Malformed(detail: "payload did not match v1"))
        XCTAssertEqual(state, .incompatible)
    }

    func testEveryStateHasDistinctGuidance() {
        let states: [ConnectionState] = [
            .unpaired, .overlayUnavailable, .locating, .unreachable,
            .connected, .authenticationLost, .incompatible
        ]
        let guidance = Set(states.map(\.guidance))
        XCTAssertEqual(guidance.count, states.count, "two states share guidance text")
    }
}
```

That last test is the one that keeps this honest: it fails the moment two states get the same copy, which is how a state machine quietly degenerates into "something went wrong".

- [ ] **Step 2: Run to confirm failure**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
xcodegen generate
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
```

Expected: FAIL to compile — `ConnectionState` undefined.

- [ ] **Step 3: Implement**

Create `app/Sources/Support/ConnectionState.swift`:

```swift
import Foundation

/// What the app currently knows about reaching Cave.
///
/// Each case exists because it implies a different action by the user.
/// `overlayUnavailable` and `unreachable` in particular must never be merged:
/// "start your VPN" and "wake the machine running Cave" are unrelated
/// instructions, and a single "could not connect" serves neither.
enum ConnectionState: Equatable, Sendable {
    /// No credential stored; enrollment is required.
    case unpaired
    /// Nothing resolves, which usually means the overlay is not running.
    case overlayUnavailable
    /// Trying the known addresses.
    case locating
    /// Addresses resolve but Cave is not answering.
    case unreachable
    /// Reads are working.
    case connected
    /// The credential was rejected; re-enrollment is required.
    case authenticationLost
    /// Cave answered with something this client cannot use.
    case incompatible

    /// The state to start in.
    static func initial(hasCredential: Bool) -> ConnectionState {
        hasCredential ? .locating : .unpaired
    }

    /// Classify a failure from the Rust core.
    static func after(error: ChatError) -> ConnectionState {
        switch error {
        case .Api(let code, _, _):
            // A rejected bearer is not a network problem; it means the
            // credential is gone and the user must enroll again.
            return code == "unauthorized" || code == "credential_revoked"
                ? .authenticationLost
                : .unreachable
        case .Unreachable(let detail):
            return detail.contains("does not resolve") ? .overlayUnavailable : .unreachable
        case .Malformed:
            return .incompatible
        case .Enrollment:
            return .unpaired
        }
    }

    /// What to tell the user, and what to tell them to do about it.
    var guidance: String {
        switch self {
        case .unpaired:
            return "Scan the enrollment code from Cave's settings to get started."
        case .overlayUnavailable:
            return "Your Cave address isn't resolving. Check that Tailscale, or whatever carries your connection, is running on this phone."
        case .locating:
            return "Looking for your Cave."
        case .unreachable:
            return "Your Cave address resolves, but nothing is answering. The machine running Cave may be asleep."
        case .connected:
            return "Connected."
        case .authenticationLost:
            return "This device's access was revoked or expired. Enroll again from Cave's settings."
        case .incompatible:
            return "This Cave is running a version this app doesn't understand. Update one of them."
        }
    }
}
```

Adjust the `ChatError` case names to whatever UniFFI actually generated, per the note at the top of this plan. Update the **test and implementation together** to the generated spelling.

- [ ] **Step 4: Run the tests**

Repeat the command from Step 2.

Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
git add app/Sources/Support/ConnectionState.swift app/Tests/ConnectionStateTests.swift
git commit -S -m "Add the connection state machine

Distinct guidance per state, asserted by a test that fails if two states share
copy. That is how a state machine quietly degenerates into 'something went
wrong', and the whole point of distinguishing them is the next step each
implies."
```

---

## Task 9: The Store

Owns the credential, the session, the cache, and the state.

**Files:** Create `app/Sources/Support/CaveStore.swift`, `app/Tests/CaveStoreTests.swift`

- [ ] **Step 1: Write the failing test**

Create `app/Tests/CaveStoreTests.swift`:

```swift
import XCTest
@testable import ChatIOS

@MainActor
final class CaveStoreTests: XCTestCase {
    override func setUp() async throws {
        try? Keychain.delete(CaveStore.bearerKey)
        UserDefaults.standard.removeObject(forKey: CaveStore.candidatesKey)
        UserDefaults.standard.removeObject(forKey: CaveStore.instanceKey)
    }

    func testAFreshInstallIsUnpaired() {
        let store = CaveStore()
        XCTAssertEqual(store.state, .unpaired)
        XCTAssertFalse(store.hasCredential)
    }

    func testStoringAnEnrollmentPersistsTheCredentialAndCandidates() throws {
        let store = CaveStore()
        try store.persist(
            bearer: "bearer-abc",
            instanceId: "i1",
            candidates: [.init(host: "h", port: 7777, tls: false, pinSha256: nil)]
        )
        XCTAssertTrue(store.hasCredential)
        XCTAssertEqual(try Keychain.get(CaveStore.bearerKey), "bearer-abc")
        XCTAssertEqual(CaveStore().storedInstanceId, "i1")
        XCTAssertEqual(CaveStore().storedCandidates.count, 1)
    }

    func testSigningOutRemovesTheCredentialAndTheCache() throws {
        let store = CaveStore()
        try store.persist(
            bearer: "bearer-abc",
            instanceId: "i1",
            candidates: [.init(host: "h", port: 7777, tls: false, pinSha256: nil)]
        )
        try store.signOut()
        XCTAssertNil(try Keychain.get(CaveStore.bearerKey))
        XCTAssertNil(CaveStore().storedInstanceId)
        XCTAssertEqual(store.state, .unpaired)
    }

    func testTheBearerIsNotStoredInUserDefaults() throws {
        let store = CaveStore()
        try store.persist(
            bearer: "bearer-abc",
            instanceId: "i1",
            candidates: [.init(host: "h", port: 7777, tls: false, pinSha256: nil)]
        )
        let dump = UserDefaults.standard.dictionaryRepresentation()
        for (key, value) in dump {
            XCTAssertFalse(
                "\(value)".contains("bearer-abc"),
                "the bearer leaked into UserDefaults under \(key)"
            )
        }
    }
}
```

The last test is worth its cost: `UserDefaults` is unencrypted, world-readable within the container, and included in backups. It is exactly where a bearer accidentally ends up when someone persists "the session" as one blob.

- [ ] **Step 2: Run to confirm failure**

Repeat the build-and-test command from Task 8 Step 2.

Expected: FAIL to compile — `CaveStore` undefined.

- [ ] **Step 3: Implement**

Create `app/Sources/Support/CaveStore.swift`:

```swift
import Foundation

/// Owns the credential, the session, the cache, and the connection state.
///
/// The bearer lives only in the Keychain and in the Rust session. Everything
/// non-secret -- candidate addresses, the instance id -- lives in
/// `UserDefaults`, which is unencrypted and backed up.
@MainActor
final class CaveStore: ObservableObject {
    static let bearerKey = "cave-bearer"
    static let candidatesKey = "cave-candidates"
    static let instanceKey = "cave-instance-id"

    @Published private(set) var state: ConnectionState = .unpaired
    @Published private(set) var familiars: [FamiliarFfi] = []
    @Published private(set) var conversations: [ConversationSummaryFfi] = []

    private var session: CaveSession?
    private var cache: ReadCache?

    init() {
        state = .initial(hasCredential: hasCredential)
    }

    var hasCredential: Bool {
        ((try? Keychain.get(Self.bearerKey)) ?? nil) != nil
    }

    var storedInstanceId: String? {
        UserDefaults.standard.string(forKey: Self.instanceKey)
    }

    var storedCandidates: [EnrollmentCandidateFfi] {
        guard let data = UserDefaults.standard.data(forKey: Self.candidatesKey),
              let stored = try? JSONDecoder().decode([StoredCandidate].self, from: data)
        else { return [] }
        return stored.map {
            EnrollmentCandidateFfi(host: $0.host, port: $0.port, tls: $0.tls, pinSha256: $0.pinSha256)
        }
    }

    /// Persist a completed enrollment.
    func persist(bearer: String, instanceId: String, candidates: [EnrollmentCandidateFfi]) throws {
        try Keychain.set(bearer, for: Self.bearerKey)
        let stored = candidates.map {
            StoredCandidate(host: $0.host, port: $0.port, tls: $0.tls, pinSha256: $0.pinSha256)
        }
        UserDefaults.standard.set(try JSONEncoder().encode(stored), forKey: Self.candidatesKey)
        UserDefaults.standard.set(instanceId, forKey: Self.instanceKey)
        session = nil
        state = .locating
    }

    /// Drop the credential and every cached record.
    func signOut() throws {
        try Keychain.delete(Self.bearerKey)
        UserDefaults.standard.removeObject(forKey: Self.candidatesKey)
        UserDefaults.standard.removeObject(forKey: Self.instanceKey)
        try? cache?.clear()
        session = nil
        cache = nil
        familiars = []
        conversations = []
        state = .unpaired
    }

    /// Load cached conversations immediately, then refresh from Cave.
    func refresh() async {
        guard let session = try? currentSession() else {
            state = .initial(hasCredential: hasCredential)
            return
        }

        if let cached = try? cache?.conversations(), !cached.isEmpty {
            conversations = cached
        }

        state = .locating
        do {
            let roster = try await session.familiars(network: nil)
            let page = try await session.conversations(cursor: nil, network: nil)
            familiars = roster
            try? cache?.putConversations(items: page.items)
            conversations = (try? cache?.conversations()) ?? page.items
            state = .connected
        } catch let error as ChatError {
            state = .after(error: error)
            if state == .authenticationLost {
                try? signOut()
            }
        } catch {
            state = .unreachable
        }
    }

    /// Load one conversation's transcript.
    func conversation(id: String) async throws -> ConversationDetailFfi {
        try await currentSession().conversation(id: id, network: nil)
    }

    private func currentSession() throws -> CaveSession {
        if let session { return session }
        guard let bearer = try Keychain.get(Self.bearerKey) else {
            throw ChatError.Enrollment(message: "no stored credential")
        }
        let built = try CaveSession(candidates: storedCandidates, bearer: bearer)
        session = built
        if cache == nil, let instanceId = storedInstanceId {
            let directory = FileManager.default
                .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("cave-cache", isDirectory: true)
            cache = try? ReadCache(directory: directory.path, instanceId: instanceId)
        }
        return built
    }

    private struct StoredCandidate: Codable {
        let host: String
        let port: UInt16
        let tls: Bool
        let pinSha256: String?
    }
}
```

- [ ] **Step 4: Run the tests**

Repeat the command from Task 8 Step 2.

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
git add app/Sources/Support/CaveStore.swift app/Tests/CaveStoreTests.swift
git commit -S -m "Add the Cave store

The bearer lives only in the Keychain and the Rust session; only non-secret
metadata goes to UserDefaults, asserted by a test that scans the whole
defaults dictionary for the token. Authentication loss signs out rather than
retrying against a credential Cave has already rejected."
```

---

## Task 10: Enrollment UI

**Files:** Create `app/Sources/Views/ScannerView.swift`, `app/Sources/Views/EnrollmentView.swift`; modify `project.yml`

- [ ] **Step 1: Declare the camera usage string**

In `project.yml`, add under the `ChatIOS` target's `settings.base`:

```yaml
        INFOPLIST_KEY_NSCameraUsageDescription: "Scanning the enrollment code from Cave's settings pairs this phone with your Cave."
```

An app that reaches for the camera without a specific reason string is rejected at review, and a vague one is worse than none for the user.

- [ ] **Step 2: Implement the scanner**

Create `app/Sources/Views/ScannerView.swift`:

```swift
import AVFoundation
import SwiftUI

/// Camera QR scanner.
///
/// Reports the first payload it reads and then stops, so a code cannot be
/// submitted twice while the user is still looking at the screen.
struct ScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }

    func makeUIViewController(context: Context) -> ScannerViewController {
        let controller = ScannerViewController()
        controller.delegate = context.coordinator
        return controller
    }

    func updateUIViewController(_ controller: ScannerViewController, context: Context) {}

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        private let onCode: (String) -> Void
        private var handled = false

        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }

        func metadataOutput(
            _ output: AVCaptureMetadataOutput,
            didOutput objects: [AVMetadataObject],
            from connection: AVCaptureConnection
        ) {
            guard !handled,
                  let object = objects.first as? AVMetadataMachineReadableCodeObject,
                  let value = object.stringValue
            else { return }
            handled = true
            Task { @MainActor in self.onCode(value) }
        }
    }
}

/// Hosts the capture session.
final class ScannerViewController: UIViewController {
    weak var delegate: AVCaptureMetadataOutputObjectsDelegate?
    private let session = AVCaptureSession()

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input)
        else { return }
        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(delegate, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.frame = view.layer.bounds
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)

        Task.detached { [session] in session.startRunning() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        session.stopRunning()
    }
}
```

- [ ] **Step 3: Implement the enrollment screen**

Create `app/Sources/Views/EnrollmentView.swift`:

```swift
import SwiftUI

/// First-run enrollment.
///
/// Offers pasting the enrollment URI alongside scanning, because the code is
/// also shown as text in Cave and a phone with a broken or denied camera must
/// still be able to enroll.
@MainActor
struct EnrollmentView: View {
    @EnvironmentObject private var store: CaveStore
    @State private var scanning = false
    @State private var pasted = ""
    @State private var failure: String?
    @State private var working = false

    var body: some View {
        VStack(spacing: 20) {
            Text("Pair with your Cave")
                .font(.title2)

            Text("Open Cave's settings, choose Add a phone, and scan the code it shows.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Button("Scan the code") { scanning = true }
                .buttonStyle(.borderedProminent)
                .disabled(working)

            VStack(alignment: .leading, spacing: 6) {
                Text("Or paste the enrollment link")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                TextField("opencoven-chat://enroll?...", text: $pasted)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                Button("Pair") { enroll(with: pasted) }
                    .disabled(pasted.isEmpty || working)
            }

            if let failure {
                Text(failure)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
                    .accessibilityLabel("Pairing failed. \(failure)")
            }

            if working { ProgressView() }
        }
        .padding()
        .sheet(isPresented: $scanning) {
            ScannerView { code in
                scanning = false
                enroll(with: code)
            }
            .ignoresSafeArea()
        }
    }

    private func enroll(with code: String) {
        guard !working else { return }
        working = true
        failure = nil
        Task {
            defer { working = false }
            do {
                let result = try await ChatIOS.enroll(
                    uri: code.trimmingCharacters(in: .whitespacesAndNewlines),
                    installationId: InstallationIdentity.current
                )
                try store.persist(
                    bearer: result.bearer,
                    instanceId: result.instanceId,
                    candidates: result.candidates
                )
                await store.refresh()
            } catch let error as ChatError {
                failure = error.userFacingMessage
            } catch {
                failure = "Pairing failed. Try generating a fresh code in Cave."
            }
        }
    }
}

/// A stable per-installation identifier.
///
/// Not the device identifier: Cave scopes credentials per installation, and
/// reinstalling should produce a new one so a reinstalled app does not inherit
/// a credential the user may have revoked.
enum InstallationIdentity {
    private static let key = "installation-id"

    static var current: String {
        if let existing = UserDefaults.standard.string(forKey: key) { return existing }
        let fresh = UUID().uuidString
        UserDefaults.standard.set(fresh, forKey: key)
        return fresh
    }
}

extension ChatError {
    /// A message safe to show a user.
    var userFacingMessage: String {
        switch self {
        case .Enrollment(let message): return message
        case .Api(_, let message, _): return message
        case .Unreachable(let detail): return "Could not reach that Cave: \(detail)."
        case .Malformed: return "That Cave answered with something this app doesn't understand."
        }
    }
}
```

- [ ] **Step 4: Build**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
./scripts/build-xcframework.sh
xcodegen generate
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS \
  -destination 'platform=iOS Simulator,name=iPhone 16' \
  CODE_SIGNING_ALLOWED=NO build
```

Expected: `BUILD SUCCEEDED`. Adjust the generated symbol names (`ChatIOS.enroll`, `ChatError` cases) to match `app/Sources/Generated/`.

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
git add app/Sources/Views/ScannerView.swift app/Sources/Views/EnrollmentView.swift project.yml
git commit -S -m "Add enrollment by scan or pasted link

Pasting is offered alongside scanning because Cave shows the code as text too,
and a denied or broken camera must not make the app unusable.

The installation id is regenerated on reinstall rather than derived from the
device, so a reinstalled app does not inherit a revoked credential."
```

---

## Task 11: The Reading Shell

**Files:** Create `app/Sources/Views/RootView.swift`, `ConversationListView.swift`, `ThreadView.swift`; modify `app/Sources/ChatApp.swift`

- [ ] **Step 1: Implement the root**

Create `app/Sources/Views/RootView.swift`. Note the `@MainActor` annotation — `CaveStore` is main-actor isolated, and under complete strict concurrency a `@StateObject` of an isolated type in a non-isolated view will not compile. The same annotation is required on `ConversationListView`, `ThreadView`, and `EnrollmentView`.

```swift
import SwiftUI

/// Chooses between enrollment and the reading shell.
@MainActor
struct RootView: View {
    @StateObject private var store = CaveStore()

    var body: some View {
        Group {
            if store.state == .unpaired {
                EnrollmentView()
            } else {
                ConversationListView()
            }
        }
        .environmentObject(store)
        .task { await store.refresh() }
    }
}
```

- [ ] **Step 2: Implement the conversation list**

Create `app/Sources/Views/ConversationListView.swift`:

```swift
import SwiftUI

/// The unified conversation list.
@MainActor
struct ConversationListView: View {
    @EnvironmentObject private var store: CaveStore

    var body: some View {
        NavigationStack {
            List {
                if store.state != .connected {
                    Section {
                        Text(store.state.guidance)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                }

                ForEach(store.conversations, id: \.id) { conversation in
                    NavigationLink {
                        ThreadView(conversationId: conversation.id, title: conversation.title)
                    } label: {
                        row(for: conversation)
                    }
                }
            }
            .navigationTitle("Chats")
            .refreshable { await store.refresh() }
            .overlay {
                if store.conversations.isEmpty && store.state == .connected {
                    ContentUnavailableView(
                        "No conversations yet",
                        systemImage: "bubble.left.and.bubble.right",
                        description: Text("Conversations you start in Cave will appear here.")
                    )
                }
            }
        }
    }

    @ViewBuilder
    private func row(for conversation: ConversationSummaryFfi) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                // Familiar identity is contract-bearing: a conversation must
                // never render as a generic assistant thread.
                Text(familiarName(for: conversation.familiarId))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if conversation.status != "idle" {
                    Text(conversation.status)
                        .font(.caption2)
                        .foregroundStyle(.tint)
                }
            }
            Text(conversation.title)
                .font(.body)
            Text(conversation.preview)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            "\(familiarName(for: conversation.familiarId)). \(conversation.title). \(conversation.preview)"
        )
    }

    private func familiarName(for id: String) -> String {
        store.familiars.first { $0.id == id }?.displayName ?? id
    }
}
```

- [ ] **Step 3: Implement the thread view**

Create `app/Sources/Views/ThreadView.swift`:

```swift
import SwiftUI

/// One conversation's canonical transcript. Read-only in this phase.
@MainActor
struct ThreadView: View {
    let conversationId: String
    let title: String

    @EnvironmentObject private var store: CaveStore
    @State private var detail: ConversationDetailFfi?
    @State private var failure: String?

    var body: some View {
        Group {
            if let detail {
                List(detail.messages, id: \.id) { message in
                    VStack(alignment: .leading, spacing: 6) {
                        Text(message.role == "user" ? "You" : "Familiar")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        // Rendered as plain text in this phase. Rich content
                        // parsing arrives in Phase F, and rendering markers
                        // before they are parsed would be exactly the unsafe
                        // shortcut the spec forbids.
                        Text(message.text)
                        if !message.attachments.isEmpty {
                            ForEach(message.attachments, id: \.id) { attachment in
                                Label(attachment.name, systemImage: "paperclip")
                                    .font(.footnote)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .padding(.vertical, 4)
                }
            } else if let failure {
                ContentUnavailableView(
                    "Could not load this conversation",
                    systemImage: "exclamationmark.triangle",
                    description: Text(failure)
                )
            } else {
                ProgressView()
            }
        }
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func load() async {
        do {
            detail = try await store.conversation(id: conversationId)
        } catch let error as ChatError {
            failure = error.userFacingMessage
        } catch {
            failure = "Something went wrong loading this conversation."
        }
    }
}
```

- [ ] **Step 4: Replace the foundation placeholder**

Rewrite `app/Sources/ChatApp.swift`:

```swift
import SwiftUI

@main
struct ChatApp: App {
    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}
```

Delete `FoundationCheckView`. It existed only to prove the Swift-to-Rust chain worked in D1 and should not survive into a phase with real UI.

- [ ] **Step 5: Build and test**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
./scripts/build-xcframework.sh
xcodegen generate
swiftlint lint --strict
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
```

Expected: `TEST SUCCEEDED` and SwiftLint clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
git add app/Sources/
git commit -S -m "Add the reading shell

Conversation rows lead with familiar identity, which is contract-bearing and
must never render as a generic assistant thread. Message bodies render as
plain text: rich markers are parsed in Phase F, and rendering them before
they are parsed is the unsafe shortcut the spec forbids.

Removes FoundationCheckView, which existed only to prove the D1 bridge."
```

---

## Task 12: Phase Gate

- [ ] **Step 1: Clean build and test**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
rm -rf build app/Sources/Generated rust/target
./scripts/build-xcframework.sh
xcodegen generate
swiftlint lint --strict
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
```

Expected: `TEST SUCCEEDED`.

- [ ] **Step 2: Confirm no secret reaches a log**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
grep -rn "print(\|NSLog\|os_log\|debugPrint" app/Sources --include=*.swift | grep -v Generated || echo "no logging calls"
cd rust && grep -rn "println!\|eprintln!\|dbg!" ffi/src --include=*.rs | grep -v "#\[cfg(test)\]" || echo "no logging calls"
```

Expected: `no logging calls` from both, or, if any exist, manual confirmation that none can receive a bearer, a pairing secret, or a payload.

- [ ] **Step 3: Confirm the SDK and Pocket still pass**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
cd /Users/buns/Documents/GitHub/OpenCoven/coven-pocket/rust && cargo test -p coven-pocket-ffi
```

Expected: PASS. Tasks 1 through 4 changed shared crates Pocket consumes.

- [ ] **Step 4: Live enrollment against a real Cave**

Requires Cave Phase 1 and iOS Phase C. With Cave running and an overlay in place:

1. Open Cave settings, Add a phone, verify an address, generate a QR.
2. Scan it in the app on a device.
3. Confirm the conversation list populates with the same conversations Cave shows.
4. Force-quit and relaunch; confirm cached conversations appear before the network returns.
5. Enable airplane mode and relaunch; confirm the state reads `overlayUnavailable` or `unreachable` with the matching guidance, and that cached conversations are still readable.
6. Revoke the credential in Cave settings; confirm the app returns to enrollment rather than retrying.

Record the observed result of each step. If Cave Phase 1 or Phase C is unavailable, record this step as blocked rather than passed.

- [ ] **Step 5: Verify signatures**

```bash
for repo in chat-ios sdk; do
  cd "/Users/buns/Documents/GitHub/OpenCoven/$repo"
  echo "== $repo"
  git log --pretty='%H %G?' -25 | awk '$2 != "G" {print "UNSIGNED:", $0}'
done
```

Expected: no output.

---

## Phase D2 Completion

Phase D2 is done when:

- Scanning or pasting an enrollment code pairs the phone, and the bearer lands in the Keychain.
- Enrollment refuses a code whose named instance does not match what answers, and refuses an expired code.
- An unpinned TLS session cannot be constructed.
- Authenticated requests never race: selection is decided by a health probe first.
- Conversations and familiars load, render with familiar identity, and cache.
- A stale revision cannot overwrite a newer cached one.
- `overlayUnavailable` and `unreachable` are distinct, with distinct guidance, asserted by test.
- Authentication loss signs out rather than retrying.
- No bearer or pairing secret appears in `UserDefaults`, a log, or an error.
- SwiftLint is clean and the test suite passes from a clean tree.
- Every commit is signed. Nothing is pushed.

**Not in this phase, by design:** sending, streaming, the outbox, rich content parsing, attachments upload, and push.

## Handoff to Phase E

Phase E adds the composer, send, stop, retry, typed SSE with cursor checkpointing, background and foreground resume, reconciliation, and the durable outbox.

`ThreadView` currently renders `message.text` as plain text. Phase F replaces that with the parsed marker AST. Phase E should not add rich rendering as a side effect of adding the composer.
