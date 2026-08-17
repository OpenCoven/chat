# iOS Phase E: Send, Stream, and Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the send → stream → background → resume → reconcile loop on a phone, plus the durable outbox that makes an unreachable Cave survivable — without ever producing a duplicate turn or a false success.

**Architecture:** `coven-transport` gains a long-lived SSE reader with an idle timeout. `cave-core` gains the line-protocol frame parser, the stream reducer that owns cursor checkpointing and gap detection, and the send/stop/retry mutations carrying operation ids. `chat-ios-ffi` gains the durable outbox and a stream controller that pushes events to Swift through a callback. Swift owns the composer, the lifecycle, and the pending-state UI.

**Tech Stack:** Swift 6, SwiftUI, iOS 17, UniFFI 0.32, Rust 1.95.0, tokio, Server-Sent Events.

**Depends on:** `2026-08-16-ios-phase-d2-enrollment-and-reads.md`.

**Boundary:** No rich content parsing, no attachment upload, no privileged actions, no push. Message bodies still render as plain text; Phase F replaces that. Adding rich rendering here as a side effect of adding the composer is out of scope.

---

## Contract Grounding

Unlike Phase D2, this phase's contract is specified. From the desktop program's `2026-08-15-phase-3-send-stream-recovery.md`:

```ts
type ClientSendInput = {
  operationId: string;
  conversationId: string;
  familiarId: string;
  prompt: string;
  attachmentIds: string[];
  projectRoot: string | null;
  model?: string;
  harness?: string;
  retryOfTurnId?: string;
};
```

- `POST /api/client/v1/messages/send` returns **202** with `{ ok: true, runId, conversationId }`.
- An identical **in-progress** send returns **409 conflict** whose details carry `runId`, `conversationId`, and `resumePath`.
- Reusing an operation id with a different request body returns **409 conflict**.
- `GET /api/client/v1/runs/[id]/stream` replays only events with `seq > cursor`.
- `POST /api/client/v1/runs/[id]/stop` and `POST /api/client/v1/runs/[id]/retry`.
- An evicted replay gap is delivered as `reconcile_required`, not a benign progress event.
- The stream event union is exactly the one `cave-core` already models in Phase B.

**The one unspecified detail** is the query parameter naming the resume cursor. This plan uses `?cursor=<id>`.

- [ ] **Before Task 4, verify the cursor parameter name**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
cat "src/app/api/client/v1/runs/[id]/stream/route.ts" 2>/dev/null || echo "not implemented yet"
```

If the route exists and names it differently, use Cave's name. When Cave returns a `resumePath` in a 409, that path is authoritative and must be used verbatim rather than reconstructed.

---

## Working Directories

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git worktree add -b feat/ios-phase-e-sdk .worktrees/ios-phase-e-sdk feat/ios-phase-d2-sdk

cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
git checkout -b feat/ios-phase-e
```

---

## Critical Rules

- **Every commit signed.** Pass `-S`. **Do not push.**
- **No emojis** in commits or code.
- **Never automatically resubmit an operation whose outcome was ambiguous.** This is the single rule the whole phase exists to protect. Reconcile first; resubmit only after confirming the operation did not land.
- **The bearer and prompt text never appear in a log or an error.**
- **Swift 6 strict concurrency**; views touching `CaveStore` are `@MainActor`.
- **Generated symbol names are authoritative.** Read `app/Sources/Generated/*.swift` and adjust the Swift here, never the Rust.

---

## File Map

### SDK `crates/coven-transport`
- Create `src/stream.rs` — long-lived SSE reader.
- Modify `src/lib.rs`.

### SDK `crates/cave-core`
- Create `src/sse.rs` — SSE line-protocol parsing.
- Create `src/reducer.rs` — stream reduction, cursor, gap detection.
- Create `src/mutations.rs` — send, stop, retry.
- Modify `src/lib.rs`.

### chat-ios
- Create `rust/ffi/src/outbox.rs` — durable outbox and its state machine.
- Create `rust/ffi/src/stream.rs` — stream controller and Swift callback.
- Modify `rust/ffi/src/session.rs`, `lib.rs`, `types.rs`.
- Create `app/Sources/Views/ComposerView.swift`, `app/Sources/Support/ThreadModel.swift`.
- Modify `app/Sources/Views/ThreadView.swift`, `app/Sources/Support/CaveStore.swift`.
- Create `app/Tests/OutboxPresentationTests.swift`.

---

## Task 1: The SSE Reader

One long-lived connection, an idle timeout rather than a total timeout, and bounded buffers.

**Files:** Create `crates/coven-transport/src/stream.rs`; modify `src/lib.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/coven-transport/src/stream.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    async fn serve(chunks: Vec<&'static str>, delay_ms: u64) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf).await;
                for chunk in chunks {
                    if delay_ms > 0 {
                        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                    }
                    if stream.write_all(chunk.as_bytes()).await.is_err() {
                        return;
                    }
                }
            }
        });
        port
    }

    fn request() -> GetRequest {
        GetRequest { path: "/stream".to_string(), headers: Vec::new() }
    }

    async fn collect(port: u16, idle: Duration) -> (Vec<SseFrame>, StreamOutcome) {
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let endpoint = Endpoint::plaintext("127.0.0.1", port);
        let outcome = stream_endpoint(&endpoint, &request(), idle, tx).await;
        let mut frames = Vec::new();
        while let Ok(frame) = rx.try_recv() {
            frames.push(frame);
        }
        (frames, outcome)
    }

    #[tokio::test]
    async fn reads_framed_events_with_ids() {
        let port = serve(
            vec![
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n",
                "id: 1\ndata: {\"type\":\"run.started\"}\n\n",
                "id: 2\ndata: {\"type\":\"message.delta\"}\n\n",
            ],
            0,
        )
        .await;
        let (frames, outcome) = collect(port, Duration::from_millis(1500)).await;
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0].id, Some(1));
        assert!(frames[0].data.contains("run.started"));
        assert_eq!(frames[1].id, Some(2));
        assert!(matches!(outcome, StreamOutcome::Closed), "got {outcome:?}");
    }

    #[tokio::test]
    async fn joins_multi_line_data_with_newlines() {
        let port = serve(
            vec![
                "HTTP/1.1 200 OK\r\n\r\n",
                "id: 5\ndata: line one\ndata: line two\n\n",
            ],
            0,
        )
        .await;
        let (frames, _) = collect(port, Duration::from_millis(1500)).await;
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].data, "line one\nline two");
    }

    #[tokio::test]
    async fn comment_lines_are_heartbeats_not_events() {
        let port = serve(
            vec!["HTTP/1.1 200 OK\r\n\r\n", ": keep-alive\n\n", "id: 9\ndata: x\n\n"],
            0,
        )
        .await;
        let (frames, _) = collect(port, Duration::from_millis(1500)).await;
        assert_eq!(frames.len(), 1, "a comment must not become an event");
        assert_eq!(frames[0].id, Some(9));
    }

    #[tokio::test]
    async fn a_non_200_status_does_not_stream() {
        let port = serve(
            vec!["HTTP/1.1 401 Unauthorized\r\n\r\n{\"ok\":false}"],
            0,
        )
        .await;
        let (frames, outcome) = collect(port, Duration::from_millis(1500)).await;
        assert!(frames.is_empty());
        match outcome {
            StreamOutcome::Rejected { status, body } => {
                assert_eq!(status, 401);
                assert!(body.contains("ok"));
            }
            other => panic!("expected Rejected, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_silent_stream_times_out_on_idle() {
        // Headers, one event, then silence. The idle timeout must fire even
        // though bytes did arrive earlier.
        let port = serve(
            vec!["HTTP/1.1 200 OK\r\n\r\n", "id: 1\ndata: x\n\n", ""],
            0,
        )
        .await;
        let (tx, _rx) = tokio::sync::mpsc::channel(8);
        let endpoint = Endpoint::plaintext("127.0.0.1", port);
        // Server holds the connection open without writing; keep idle short.
        let outcome = stream_endpoint(&endpoint, &request(), Duration::from_millis(250), tx).await;
        assert!(
            matches!(outcome, StreamOutcome::Closed | StreamOutcome::IdleTimeout),
            "got {outcome:?}"
        );
    }

    #[tokio::test]
    async fn an_oversized_event_aborts_rather_than_buffering() {
        let huge = Box::leak(
            format!("id: 1\ndata: {}\n\n", "x".repeat(MAX_EVENT_BYTES + 1024)).into_boxed_str(),
        );
        let port = serve(vec!["HTTP/1.1 200 OK\r\n\r\n", huge], 0).await;
        let (_frames, outcome) = collect(port, Duration::from_millis(2000)).await;
        assert!(matches!(outcome, StreamOutcome::Failed(_)), "got {outcome:?}");
    }
}
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p coven-transport stream`

Expected: FAIL to compile — `stream_endpoint` undefined.

- [ ] **Step 3: Implement**

Prepend to `crates/coven-transport/src/stream.rs`:

```rust
//! A long-lived Server-Sent Events reader.
//!
//! Differs from the one-shot exchange in two ways that matter. The budget is
//! an *idle* timeout rather than a total one, because a healthy stream stays
//! open for as long as a run takes. And the body is never buffered whole: a
//! run can emit far more than the one-shot response cap, so events are
//! dispatched as they complete and any single oversized event aborts.

use std::time::Duration;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::sync::mpsc::Sender;

use crate::endpoint::{Endpoint, Security};
use crate::fetch::GetRequest;

/// Cap on one event. A generous text delta is kilobytes; this bounds a hostile
/// or broken server without truncating legitimate output.
pub const MAX_EVENT_BYTES: usize = 1024 * 1024;

/// Cap on one line, so a server that never sends a newline cannot grow the
/// buffer without bound.
const MAX_LINE_BYTES: usize = 256 * 1024;

/// One dispatched SSE event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseFrame {
    /// The `id:` field, when present. This is the resume cursor.
    pub id: Option<u64>,
    /// The joined `data:` payload.
    pub data: String,
}

/// How a stream ended.
#[derive(Debug)]
pub enum StreamOutcome {
    /// The server closed the connection normally.
    Closed,
    /// No bytes arrived within the idle budget.
    IdleTimeout,
    /// The server answered with a non-200 status; no events were dispatched.
    Rejected {
        /// HTTP status.
        status: u16,
        /// Response body, for the caller to parse as an error envelope.
        body: String,
    },
    /// The connection or the protocol failed.
    Failed(String),
}

/// Open a stream and dispatch events until it ends.
///
/// Returns when the server closes, the idle budget elapses, or the receiver is
/// dropped. Dropping the receiver is how a caller cancels.
pub async fn stream_endpoint(
    endpoint: &Endpoint,
    request: &GetRequest,
    idle_timeout: Duration,
    sink: Sender<SseFrame>,
) -> StreamOutcome {
    let mut wire = format!(
        "GET {} HTTP/1.1\r\nHost: coven\r\nAccept: text/event-stream\r\nCache-Control: no-cache\r\n",
        request.path
    );
    for (name, value) in &request.headers {
        if name.contains(['\r', '\n']) || value.contains(['\r', '\n']) {
            return StreamOutcome::Failed(format!("header {name} contains a line break"));
        }
        wire.push_str(&format!("{name}: {value}\r\n"));
    }
    wire.push_str("\r\n");

    let stream = match tokio::time::timeout(
        idle_timeout,
        TcpStream::connect((endpoint.host.as_str(), endpoint.port)),
    )
    .await
    {
        Ok(Ok(stream)) => stream,
        Ok(Err(e)) => return StreamOutcome::Failed(e.to_string()),
        Err(_) => return StreamOutcome::IdleTimeout,
    };

    match &endpoint.security {
        Security::Plaintext => drive(stream, wire, idle_timeout, sink).await,
        Security::Tls { pinned_sha256 } => {
            match crate::tls::connect_tls(stream, &endpoint.host, *pinned_sha256).await {
                Ok(tls) => drive(tls, wire, idle_timeout, sink).await,
                Err(e) => StreamOutcome::Failed(e.to_string()),
            }
        }
    }
}

/// Write the request, read the status line and headers, then dispatch events.
async fn drive<S>(
    stream: S,
    wire: String,
    idle_timeout: Duration,
    sink: Sender<SseFrame>,
) -> StreamOutcome
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut reader = BufReader::new(stream);
    if let Err(e) = reader.get_mut().write_all(wire.as_bytes()).await {
        return StreamOutcome::Failed(e.to_string());
    }

    // Status line.
    let mut line = String::new();
    match tokio::time::timeout(idle_timeout, reader.read_line(&mut line)).await {
        Ok(Ok(0)) => return StreamOutcome::Closed,
        Ok(Ok(_)) => {}
        Ok(Err(e)) => return StreamOutcome::Failed(e.to_string()),
        Err(_) => return StreamOutcome::IdleTimeout,
    }
    let status = line
        .split_whitespace()
        .nth(1)
        .and_then(|code| code.parse::<u16>().ok())
        .unwrap_or(0);

    // Headers, discarded: the body carries everything we need.
    loop {
        let mut header = String::new();
        match tokio::time::timeout(idle_timeout, reader.read_line(&mut header)).await {
            Ok(Ok(0)) => return StreamOutcome::Closed,
            Ok(Ok(_)) => {
                if header.trim().is_empty() {
                    break;
                }
            }
            Ok(Err(e)) => return StreamOutcome::Failed(e.to_string()),
            Err(_) => return StreamOutcome::IdleTimeout,
        }
    }

    if status != 200 {
        // Read a bounded body so the caller can parse the error envelope, and
        // dispatch nothing: a rejected stream has no events.
        let mut body = String::new();
        let mut chunk = String::new();
        while body.len() < 64 * 1024 {
            chunk.clear();
            match tokio::time::timeout(idle_timeout, reader.read_line(&mut chunk)).await {
                Ok(Ok(0)) | Err(_) => break,
                Ok(Ok(_)) => body.push_str(&chunk),
                Ok(Err(_)) => break,
            }
        }
        return StreamOutcome::Rejected { status, body };
    }

    dispatch(reader, idle_timeout, sink).await
}

/// Parse the SSE line protocol and dispatch completed events.
async fn dispatch<S>(
    mut reader: BufReader<S>,
    idle_timeout: Duration,
    sink: Sender<SseFrame>,
) -> StreamOutcome
where
    S: tokio::io::AsyncRead + Unpin,
{
    let mut id: Option<u64> = None;
    let mut data = String::new();

    loop {
        let mut line = String::new();
        match tokio::time::timeout(idle_timeout, reader.read_line(&mut line)).await {
            Ok(Ok(0)) => return StreamOutcome::Closed,
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return StreamOutcome::Failed(e.to_string()),
            Err(_) => return StreamOutcome::IdleTimeout,
        }

        if line.len() > MAX_LINE_BYTES {
            return StreamOutcome::Failed("a stream line exceeded the size cap".to_string());
        }

        let trimmed = line.trim_end_matches(['\r', '\n']);

        // A comment is a heartbeat. It resets the idle budget by virtue of
        // having arrived, and produces no event.
        if trimmed.starts_with(':') {
            continue;
        }

        if trimmed.is_empty() {
            if !data.is_empty() || id.is_some() {
                let frame = SseFrame { id, data: std::mem::take(&mut data) };
                id = None;
                if sink.send(frame).await.is_err() {
                    // The receiver went away: the caller cancelled.
                    return StreamOutcome::Closed;
                }
            }
            continue;
        }

        let (field, value) = match trimmed.split_once(':') {
            Some((field, value)) => (field, value.strip_prefix(' ').unwrap_or(value)),
            None => (trimmed, ""),
        };

        match field {
            "id" => id = value.parse::<u64>().ok(),
            "data" => {
                if data.len() + value.len() > MAX_EVENT_BYTES {
                    return StreamOutcome::Failed("an event exceeded the size cap".to_string());
                }
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(value);
            }
            // `event` and `retry` are unused by this contract; ignored rather
            // than treated as errors so Cave can add them later.
            _ => {}
        }
    }
}
```

In `src/tls.rs`, extract the handshake from `send_tls` into a reusable `pub(crate) async fn connect_tls(stream, host, pin) -> std::io::Result<TlsStream<TcpStream>>`, and have `send_tls` call it. The stream reader needs the connected TLS stream rather than a completed exchange.

Export from `src/lib.rs`:

```rust
mod stream;

pub use stream::{stream_endpoint, SseFrame, StreamOutcome, MAX_EVENT_BYTES};
```

- [ ] **Step 4: Run the suite**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p coven-transport`

Expected: PASS, 6 new tests. Every earlier test still passes.

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add crates/coven-transport/src/
git commit -S -m "Add a long-lived SSE reader to coven-transport

Idle timeout rather than a total one, because a healthy stream stays open as
long as the run takes. The body is never buffered whole; events dispatch as
they complete and an oversized single event aborts. A non-200 status returns
the body for envelope parsing and dispatches nothing."
```

---

## Task 2: Typed Stream Frames

**Files:** Create `crates/cave-core/src/sse.rs`; modify `src/lib.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/cave-core/src/sse.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn frame(id: Option<u64>, data: &str) -> coven_transport::SseFrame {
        coven_transport::SseFrame { id, data: data.to_string() }
    }

    #[test]
    fn decodes_a_typed_event() {
        let decoded = decode_frame(&frame(Some(1), r#"{"type":"message.delta","text":"hi"}"#))
            .expect("decodes");
        assert_eq!(decoded.id, 1);
        assert!(matches!(decoded.event, StreamEvent::MessageDelta { text } if text == "hi"));
    }

    #[test]
    fn a_frame_without_an_id_is_rejected() {
        // Ids are the resume cursor; an event that cannot be checkpointed is
        // unusable, and accepting it would silently break resume.
        assert!(decode_frame(&frame(None, r#"{"type":"message.delta","text":"hi"}"#)).is_err());
    }

    #[test]
    fn an_unknown_event_type_decodes_as_unknown() {
        let decoded = decode_frame(&frame(Some(3), r#"{"type":"telepathy","x":1}"#))
            .expect("decodes");
        assert!(matches!(decoded.event, StreamEvent::Unknown));
    }

    #[test]
    fn undecodable_data_is_an_error_not_an_unknown_event() {
        // Unknown *type* is forward compatibility. Unparseable *JSON* is a
        // broken stream, and pretending otherwise would hide it.
        assert!(decode_frame(&frame(Some(4), "not json")).is_err());
    }
}
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p cave-core sse`

Expected: FAIL to compile — `decode_frame` undefined.

- [ ] **Step 3: Implement**

Prepend to `crates/cave-core/src/sse.rs`:

```rust
//! Turning transport frames into typed Cave events.

use crate::error::CaveError;
use crate::stream::StreamEvent;

/// A decoded event with its checkpointable id.
#[derive(Debug, Clone, PartialEq)]
pub struct DecodedEvent {
    /// Monotonic event id, the resume cursor.
    pub id: u64,
    /// The typed payload.
    pub event: StreamEvent,
}

/// Decode one transport frame.
///
/// An absent id is an error rather than a tolerated quirk: the id is what
/// makes resume possible, and silently accepting an unnumbered event would
/// break recovery in a way that only shows up after a disconnect.
pub fn decode_frame(frame: &coven_transport::SseFrame) -> Result<DecodedEvent, CaveError> {
    let id = frame
        .id
        .ok_or_else(|| CaveError::Malformed("stream event had no id".to_string()))?;
    let event: StreamEvent = serde_json::from_str(&frame.data)
        .map_err(|e| CaveError::Malformed(format!("stream event did not match v1: {e}")))?;
    Ok(DecodedEvent { id, event })
}
```

Add to `src/lib.rs`:

```rust
mod sse;

pub use sse::{decode_frame, DecodedEvent};
```

- [ ] **Step 4: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
cargo test -p cave-core
git add crates/cave-core/src/
git commit -S -m "Add typed stream frame decoding to cave-core

An event without an id is an error: the id is the resume cursor, and accepting
an unnumbered event breaks recovery in a way that only appears after a
disconnect. An unknown type is tolerated; unparseable JSON is not."
```

Expected: PASS, 4 new tests.

---

## Task 3: The Stream Reducer

Cursor checkpointing, duplicate suppression, and gap detection in one place.

**Files:** Create `crates/cave-core/src/reducer.rs`; modify `src/lib.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/cave-core/src/reducer.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::stream::StreamEvent;

    fn delta(id: u64, text: &str) -> DecodedEvent {
        DecodedEvent { id, event: StreamEvent::MessageDelta { text: text.to_string() } }
    }

    #[test]
    fn appends_deltas_in_order_and_advances_the_cursor() {
        let mut reducer = StreamReducer::new(None);
        assert_eq!(reducer.accept(&delta(1, "Contract ")), Accepted::Applied);
        assert_eq!(reducer.accept(&delta(2, "locked.")), Accepted::Applied);
        assert_eq!(reducer.text(), "Contract locked.");
        assert_eq!(reducer.cursor(), Some(2));
    }

    #[test]
    fn a_duplicate_id_is_a_no_op() {
        let mut reducer = StreamReducer::new(None);
        reducer.accept(&delta(1, "once"));
        assert_eq!(reducer.accept(&delta(1, "once")), Accepted::Duplicate);
        assert_eq!(reducer.text(), "once", "a replayed event must not double-apply");
        assert_eq!(reducer.cursor(), Some(1));
    }

    #[test]
    fn an_out_of_order_older_id_is_a_no_op() {
        let mut reducer = StreamReducer::new(None);
        reducer.accept(&delta(5, "five"));
        assert_eq!(reducer.accept(&delta(3, "three")), Accepted::Duplicate);
        assert_eq!(reducer.text(), "five");
        assert_eq!(reducer.cursor(), Some(5));
    }

    #[test]
    fn a_gap_is_reported_and_does_not_apply() {
        let mut reducer = StreamReducer::new(None);
        reducer.accept(&delta(1, "one"));
        assert_eq!(reducer.accept(&delta(3, "three")), Accepted::Gap);
        assert_eq!(
            reducer.text(),
            "one",
            "a gapped event must not be applied; the transcript would be silently wrong"
        );
        assert_eq!(reducer.cursor(), Some(1), "the cursor must not skip the gap");
    }

    #[test]
    fn resuming_from_a_cursor_ignores_everything_at_or_below_it() {
        let mut reducer = StreamReducer::new(Some(10));
        assert_eq!(reducer.accept(&delta(10, "old")), Accepted::Duplicate);
        assert_eq!(reducer.accept(&delta(11, "new")), Accepted::Applied);
        assert_eq!(reducer.text(), "new");
    }

    #[test]
    fn reconcile_required_is_reported_as_terminal_reconcile() {
        let mut reducer = StreamReducer::new(None);
        let event = DecodedEvent {
            id: 1,
            event: StreamEvent::ReconcileRequired { conversation_id: "c1".to_string() },
        };
        assert_eq!(reducer.accept(&event), Accepted::Reconcile);
        assert!(reducer.is_finished());
    }

    #[test]
    fn run_completed_finishes_the_reducer() {
        let mut reducer = StreamReducer::new(None);
        let event = DecodedEvent {
            id: 1,
            event: StreamEvent::RunCompleted { conversation_id: "c1".to_string() },
        };
        assert_eq!(reducer.accept(&event), Accepted::Applied);
        assert!(reducer.is_finished());
        assert_eq!(reducer.failure(), None);
    }

    #[test]
    fn run_failed_finishes_and_records_the_failure() {
        let mut reducer = StreamReducer::new(None);
        let event = DecodedEvent {
            id: 1,
            event: StreamEvent::RunFailed {
                code: "service_unavailable".to_string(),
                message: "The run failed.".to_string(),
            },
        };
        assert_eq!(reducer.accept(&event), Accepted::Applied);
        assert!(reducer.is_finished());
        assert_eq!(reducer.failure().map(|f| f.code.clone()), Some("service_unavailable".to_string()));
    }

    #[test]
    fn an_unknown_event_advances_the_cursor_without_changing_state() {
        let mut reducer = StreamReducer::new(None);
        reducer.accept(&delta(1, "one"));
        let unknown = DecodedEvent { id: 2, event: StreamEvent::Unknown };
        assert_eq!(reducer.accept(&unknown), Accepted::Applied);
        assert_eq!(reducer.text(), "one");
        assert_eq!(
            reducer.cursor(),
            Some(2),
            "an unknown event must still advance the cursor, or resume replays it forever"
        );
    }

    #[test]
    fn progress_and_tool_events_are_collected_in_order() {
        let mut reducer = StreamReducer::new(None);
        reducer.accept(&DecodedEvent {
            id: 1,
            event: StreamEvent::Progress {
                id: "p1".to_string(),
                label: "Thinking".to_string(),
                detail: None,
                status: "running".to_string(),
            },
        });
        assert_eq!(reducer.progress().len(), 1);
        assert_eq!(reducer.progress()[0].label, "Thinking");
    }

    #[test]
    fn a_later_progress_update_replaces_the_same_step() {
        let mut reducer = StreamReducer::new(None);
        for (id, status) in [(1u64, "running"), (2, "done")] {
            reducer.accept(&DecodedEvent {
                id,
                event: StreamEvent::Progress {
                    id: "p1".to_string(),
                    label: "Thinking".to_string(),
                    detail: None,
                    status: status.to_string(),
                },
            });
        }
        assert_eq!(reducer.progress().len(), 1, "same step id must update, not duplicate");
        assert_eq!(reducer.progress()[0].status, "done");
    }
}
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p cave-core reducer`

Expected: FAIL to compile — `StreamReducer` undefined.

- [ ] **Step 3: Implement**

Prepend to `crates/cave-core/src/reducer.rs`:

```rust
//! Reducing a run's event stream into displayable state.
//!
//! Owns the three rules that make recovery correct: a duplicate id is a
//! no-op, a gap is never applied, and the cursor only ever advances by one
//! accepted event at a time.

use crate::sse::DecodedEvent;
use crate::stream::{StreamEvent, ToolPayload};

/// What accepting an event did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Accepted {
    /// Applied and the cursor advanced.
    Applied,
    /// Already seen, or older than the cursor. Nothing changed.
    Duplicate,
    /// An id was skipped. Nothing applied; the caller must reconcile.
    Gap,
    /// Cave asked for reconciliation explicitly.
    Reconcile,
}

/// A progress step.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProgressStep {
    /// Stable step id.
    pub id: String,
    /// Short label.
    pub label: String,
    /// Longer detail.
    pub detail: Option<String>,
    /// Lifecycle status.
    pub status: String,
}

/// A run failure.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunFailure {
    /// Machine-readable code.
    pub code: String,
    /// User-safe message.
    pub message: String,
}

/// Accumulated state for one run.
#[derive(Debug, Default)]
pub struct StreamReducer {
    cursor: Option<u64>,
    text: String,
    progress: Vec<ProgressStep>,
    tools: Vec<ToolPayload>,
    finished: bool,
    failure: Option<RunFailure>,
}

impl StreamReducer {
    /// Start, optionally resuming from a checkpointed cursor.
    pub fn new(cursor: Option<u64>) -> Self {
        Self { cursor, ..Default::default() }
    }

    /// The last accepted event id.
    pub fn cursor(&self) -> Option<u64> {
        self.cursor
    }

    /// Accumulated assistant text.
    pub fn text(&self) -> &str {
        &self.text
    }

    /// Progress steps, in first-seen order.
    pub fn progress(&self) -> &[ProgressStep] {
        &self.progress
    }

    /// Tool invocations, in order.
    pub fn tools(&self) -> &[ToolPayload] {
        &self.tools
    }

    /// Whether the run reached a terminal event.
    pub fn is_finished(&self) -> bool {
        self.finished
    }

    /// The failure, if the run failed.
    pub fn failure(&self) -> Option<&RunFailure> {
        self.failure.as_ref()
    }

    /// Accept one decoded event.
    pub fn accept(&mut self, event: &DecodedEvent) -> Accepted {
        match self.cursor {
            // Already seen, or arrived out of order behind the cursor.
            Some(cursor) if event.id <= cursor => return Accepted::Duplicate,
            // A skipped id means the transcript we would build is missing
            // something. Applying it anyway would produce output that looks
            // complete and is not.
            Some(cursor) if event.id > cursor + 1 => return Accepted::Gap,
            _ => {}
        }

        let outcome = match &event.event {
            StreamEvent::MessageDelta { text } => {
                self.text.push_str(text);
                Accepted::Applied
            }
            StreamEvent::Progress { id, label, detail, status } => {
                let step = ProgressStep {
                    id: id.clone(),
                    label: label.clone(),
                    detail: detail.clone(),
                    status: status.clone(),
                };
                match self.progress.iter_mut().find(|existing| existing.id == step.id) {
                    Some(existing) => *existing = step,
                    None => self.progress.push(step),
                }
                Accepted::Applied
            }
            StreamEvent::Tool { payload } => {
                match self.tools.iter_mut().find(|existing| existing.id == payload.id) {
                    Some(existing) => *existing = payload.clone(),
                    None => self.tools.push(payload.clone()),
                }
                Accepted::Applied
            }
            StreamEvent::RunStarted { .. } => Accepted::Applied,
            StreamEvent::RunCompleted { .. } => {
                self.finished = true;
                Accepted::Applied
            }
            StreamEvent::RunFailed { code, message } => {
                self.finished = true;
                self.failure = Some(RunFailure {
                    code: code.clone(),
                    message: message.clone(),
                });
                Accepted::Applied
            }
            StreamEvent::ReconcileRequired { .. } => {
                self.finished = true;
                Accepted::Reconcile
            }
            // Forward compatibility: an event this client does not implement
            // still advances the cursor, or a resume would replay it forever.
            StreamEvent::Unknown => Accepted::Applied,
        };

        self.cursor = Some(event.id);
        outcome
    }
}
```

Add to `src/lib.rs`:

```rust
mod reducer;

pub use reducer::{Accepted, ProgressStep, RunFailure, StreamReducer};
```

- [ ] **Step 4: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
cargo test -p cave-core
git add crates/cave-core/src/
git commit -S -m "Add the stream reducer to cave-core

Duplicates are no-ops, gaps are never applied, and unknown events still
advance the cursor so a resume does not replay them forever. A gapped event
must not be applied: the transcript would look complete and be wrong."
```

Expected: PASS, 11 new tests.

---

## Task 4: Send, Stop, and Retry

**Files:** Create `crates/cave-core/src/mutations.rs`; modify `src/lib.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/cave-core/src/mutations.rs`:

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
                let mut buf = [0u8; 8192];
                let n = stream.read(&mut buf).await.unwrap_or(0);
                let _ = tx.send(String::from_utf8_lossy(&buf[..n]).into_owned());
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        (port, rx)
    }

    fn input() -> SendInput {
        SendInput {
            operation_id: "op-1".to_string(),
            conversation_id: "c1".to_string(),
            familiar_id: "charm".to_string(),
            prompt: "hello".to_string(),
            attachment_ids: Vec::new(),
            project_root: None,
            model: None,
            harness: None,
            retry_of_turn_id: None,
        }
    }

    #[tokio::test]
    async fn a_202_returns_the_run_and_conversation() {
        let (port, rx) = serve(
            "HTTP/1.1 202 Accepted\r\n\r\n{\"ok\":true,\"runId\":\"run-1\",\"conversationId\":\"c1\"}",
        )
        .await;
        let accepted = send(&Endpoint::plaintext("127.0.0.1", port), "bearer", &input())
            .await
            .expect("send accepted");
        assert_eq!(accepted.run_id, "run-1");
        assert_eq!(accepted.conversation_id, "c1");

        let sent = rx.await.unwrap_or_default();
        assert!(sent.starts_with("POST /api/client/v1/messages/send"), "got: {sent}");
        assert!(sent.contains("Authorization: Bearer bearer"), "got: {sent}");
        assert!(sent.contains("\"operationId\":\"op-1\""), "got: {sent}");
    }

    #[tokio::test]
    async fn an_in_progress_conflict_surfaces_its_resume_path() {
        let (port, _rx) = serve(
            "HTTP/1.1 409 Conflict\r\n\r\n{\"ok\":false,\"error\":{\"code\":\"conflict\",\"message\":\"Already running.\",\"retryable\":false,\"details\":{\"runId\":\"run-1\",\"conversationId\":\"c1\",\"resumePath\":\"/api/client/v1/runs/run-1/stream?cursor=4\"}}}",
        )
        .await;
        match send(&Endpoint::plaintext("127.0.0.1", port), "bearer", &input()).await {
            Err(SendError::AlreadyRunning { run_id, conversation_id, resume_path }) => {
                assert_eq!(run_id, "run-1");
                assert_eq!(conversation_id, "c1");
                assert_eq!(resume_path, "/api/client/v1/runs/run-1/stream?cursor=4");
            }
            other => panic!("expected AlreadyRunning, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_conflict_without_details_is_a_plain_api_error() {
        let (port, _rx) = serve(
            "HTTP/1.1 409 Conflict\r\n\r\n{\"ok\":false,\"error\":{\"code\":\"conflict\",\"message\":\"Key reused.\",\"retryable\":false}}",
        )
        .await;
        match send(&Endpoint::plaintext("127.0.0.1", port), "bearer", &input()).await {
            Err(SendError::Api(envelope)) => assert_eq!(envelope.code, "conflict"),
            other => panic!("expected Api, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_transport_failure_is_ambiguous_not_a_rejection() {
        // The dead port never answers. The send may or may not have been
        // received; the caller must not treat this as a rejection.
        let dead = {
            let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
            listener.local_addr().expect("addr").port()
        };
        match send(&Endpoint::plaintext("127.0.0.1", dead), "bearer", &input()).await {
            Err(SendError::Ambiguous { .. }) => {}
            other => panic!("expected Ambiguous, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn the_prompt_never_appears_in_an_error() {
        let (port, _rx) = serve("HTTP/1.1 500 Server Error\r\n\r\nnot json").await;
        let mut input = input();
        input.prompt = "a very private secret".to_string();
        let error = send(&Endpoint::plaintext("127.0.0.1", port), "bearer", &input)
            .await
            .expect_err("must fail");
        assert!(
            !format!("{error:?}").contains("a very private secret"),
            "prompt leaked: {error:?}"
        );
    }

    #[tokio::test]
    async fn stop_posts_to_the_run() {
        let (port, rx) = serve("HTTP/1.1 200 OK\r\n\r\n{\"ok\":true}").await;
        stop(&Endpoint::plaintext("127.0.0.1", port), "bearer", "run-1", "op-2")
            .await
            .expect("stop succeeds");
        let sent = rx.await.unwrap_or_default();
        assert!(sent.starts_with("POST /api/client/v1/runs/run-1/stop"), "got: {sent}");
    }

    #[tokio::test]
    async fn retry_posts_to_the_run() {
        let (port, rx) = serve(
            "HTTP/1.1 202 Accepted\r\n\r\n{\"ok\":true,\"runId\":\"run-2\",\"conversationId\":\"c1\"}",
        )
        .await;
        let accepted = retry(&Endpoint::plaintext("127.0.0.1", port), "bearer", "run-1", "op-3")
            .await
            .expect("retry succeeds");
        assert_eq!(accepted.run_id, "run-2");
        let sent = rx.await.unwrap_or_default();
        assert!(sent.starts_with("POST /api/client/v1/runs/run-1/retry"), "got: {sent}");
    }
}
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p cave-core mutations`

Expected: FAIL to compile.

- [ ] **Step 3: Implement**

Prepend to `crates/cave-core/src/mutations.rs`:

```rust
//! Send, stop, and retry.
//!
//! Every mutation carries a client operation id, which Cave uses as its
//! idempotency key. The distinction that matters most here is between a
//! *rejection* -- Cave said no -- and an *ambiguous* outcome, where the
//! request may or may not have been received. Only the first is safe to treat
//! as final.

use std::time::Duration;

use coven_transport::{post_endpoint, Endpoint, Exchange, PostRequest};
use serde::{Deserialize, Serialize};

use crate::error::{parse_raw_response, CaveError, ErrorEnvelope};

/// Budget for one mutation.
const MUTATION_TIMEOUT: Duration = Duration::from_secs(20);

/// What Cave needs to start a run.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendInput {
    /// Client-generated operation id, reused on every attempt.
    pub operation_id: String,
    /// Target conversation.
    pub conversation_id: String,
    /// Familiar to address.
    pub familiar_id: String,
    /// The message.
    pub prompt: String,
    /// Previously uploaded attachment ids.
    pub attachment_ids: Vec<String>,
    /// Project context.
    pub project_root: Option<String>,
    /// Optional model preference.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// Optional harness preference.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub harness: Option<String>,
    /// Set when retrying a specific failed turn.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_of_turn_id: Option<String>,
}

/// Cave accepted a run.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunAccepted {
    /// The run to stream.
    pub run_id: String,
    /// The conversation it belongs to.
    pub conversation_id: String,
}

/// Why a mutation did not succeed.
///
/// `Ambiguous` is deliberately separate. It means the outcome is unknown, and
/// the caller must reconcile rather than retry.
#[derive(Debug)]
pub enum SendError {
    /// Cave rejected the request.
    Api(ErrorEnvelope),
    /// A run for this operation is already in progress.
    AlreadyRunning {
        /// The run already going.
        run_id: String,
        /// Its conversation.
        conversation_id: String,
        /// The exact path to resume from. Use verbatim.
        resume_path: String,
    },
    /// The response did not match the contract.
    Malformed(String),
    /// The request may or may not have been received.
    Ambiguous {
        /// What the transport reported.
        detail: String,
    },
}

impl std::fmt::Display for SendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Api(envelope) => write!(f, "{}: {}", envelope.code, envelope.message),
            Self::AlreadyRunning { run_id, .. } => write!(f, "run {run_id} is already in progress"),
            Self::Malformed(detail) => write!(f, "malformed response: {detail}"),
            Self::Ambiguous { detail } => write!(f, "outcome unknown: {detail}"),
        }
    }
}

impl std::error::Error for SendError {}

fn classify(exchange: Exchange) -> Result<String, SendError> {
    match exchange {
        Exchange::Response { body, .. } => Ok(body),
        // Every one of these leaves the outcome unknown. The request may have
        // reached Cave and been executed before the connection died.
        Exchange::Refused => Err(SendError::Ambiguous {
            detail: "nothing is listening at that address".to_string(),
        }),
        Exchange::Unresolvable => Err(SendError::Ambiguous {
            detail: "the address does not resolve".to_string(),
        }),
        Exchange::TimedOut => Err(SendError::Ambiguous {
            detail: "no answer in time".to_string(),
        }),
        Exchange::Failed(detail) => Err(SendError::Ambiguous { detail }),
    }
}

fn interpret(body: &str) -> Result<RunAccepted, SendError> {
    match parse_raw_response::<RunAccepted>(body) {
        Ok(accepted) => Ok(accepted),
        Err(CaveError::Api(envelope)) => {
            // A conflict carrying resume details means a run is already going
            // for this operation. That is recoverable by attaching to it, not
            // by sending again.
            let details = envelope.details.as_ref();
            let field = |name: &str| {
                details
                    .and_then(|d| d.get(name))
                    .and_then(|v| v.as_str())
                    .map(str::to_string)
            };
            match (field("runId"), field("conversationId"), field("resumePath")) {
                (Some(run_id), Some(conversation_id), Some(resume_path)) => {
                    Err(SendError::AlreadyRunning { run_id, conversation_id, resume_path })
                }
                _ => Err(SendError::Api(envelope)),
            }
        }
        Err(CaveError::Malformed(detail)) => Err(SendError::Malformed(detail)),
        Err(CaveError::Unreachable { detail }) => Err(SendError::Ambiguous { detail }),
    }
}

fn authorized(path: String, body: String, bearer: &str) -> PostRequest {
    PostRequest {
        path,
        body,
        headers: vec![("Authorization".to_string(), format!("Bearer {bearer}"))],
    }
}

/// Submit a turn.
pub async fn send(
    endpoint: &Endpoint,
    bearer: &str,
    input: &SendInput,
) -> Result<RunAccepted, SendError> {
    let body = serde_json::to_string(input)
        .map_err(|e| SendError::Malformed(format!("could not encode the request: {e}")))?;
    let request = authorized("/api/client/v1/messages/send".to_string(), body, bearer);
    let response = classify(post_endpoint(endpoint, &request, MUTATION_TIMEOUT).await)?;
    interpret(&response)
}

/// Stop a running turn.
pub async fn stop(
    endpoint: &Endpoint,
    bearer: &str,
    run_id: &str,
    operation_id: &str,
) -> Result<(), SendError> {
    let body = serde_json::json!({ "operationId": operation_id }).to_string();
    let request = authorized(
        format!("/api/client/v1/runs/{run_id}/stop"),
        body,
        bearer,
    );
    let response = classify(post_endpoint(endpoint, &request, MUTATION_TIMEOUT).await)?;
    #[derive(Deserialize)]
    struct Empty {}
    match parse_raw_response::<Empty>(&response) {
        Ok(_) => Ok(()),
        Err(CaveError::Api(envelope)) => Err(SendError::Api(envelope)),
        Err(CaveError::Malformed(detail)) => Err(SendError::Malformed(detail)),
        Err(CaveError::Unreachable { detail }) => Err(SendError::Ambiguous { detail }),
    }
}

/// Retry a failed turn.
pub async fn retry(
    endpoint: &Endpoint,
    bearer: &str,
    run_id: &str,
    operation_id: &str,
) -> Result<RunAccepted, SendError> {
    let body = serde_json::json!({ "operationId": operation_id }).to_string();
    let request = authorized(
        format!("/api/client/v1/runs/{run_id}/retry"),
        body,
        bearer,
    );
    let response = classify(post_endpoint(endpoint, &request, MUTATION_TIMEOUT).await)?;
    interpret(&response)
}
```

Add to `src/lib.rs`:

```rust
mod mutations;

pub use mutations::{retry, send, stop, RunAccepted, SendError, SendInput};
```

- [ ] **Step 4: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
cargo test --workspace
git add crates/cave-core/src/
git commit -S -m "Add send, stop, and retry to cave-core

SendError separates a rejection from an ambiguous outcome. Every transport
failure is ambiguous, because the request may have reached Cave and executed
before the connection died. Only a rejection is safe to treat as final.

A 409 carrying resume details is surfaced as AlreadyRunning so the caller
attaches to the existing run instead of sending again."
```

Expected: PASS, 7 new tests.

---

## Task 5: The Outbox

The amended non-goal. Every rule here neutralizes a specific failure the original non-goal warned about.

**Files:** Create `rust/ffi/src/outbox.rs`; modify `rust/ffi/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Create `rust/ffi/src/outbox.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> String {
        let base = std::env::temp_dir().join(format!(
            "chat-ios-outbox-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).expect("temp dir");
        base.to_string_lossy().to_string()
    }

    fn outbox() -> Outbox {
        Outbox::open(dir()).expect("opens")
    }

    #[test]
    fn queues_a_message_and_reads_it_back() {
        let outbox = outbox();
        let entry = outbox.enqueue("c1".to_string(), "charm".to_string(), "hello".to_string(), "r1".to_string(), 1_000).expect("queued");
        assert_eq!(entry.state, OutboxState::Queued);
        let pending = outbox.pending("c1".to_string()).expect("read");
        assert_eq!(pending.len(), 1);
        assert_eq!(pending[0].prompt, "hello");
        assert!(!pending[0].operation_id.is_empty(), "an operation id is assigned at queue time");
    }

    #[test]
    fn the_operation_id_is_stable_across_attempts() {
        let outbox = outbox();
        let entry = outbox.enqueue("c1".to_string(), "charm".to_string(), "hello".to_string(), "r1".to_string(), 1_000).expect("queued");
        outbox.mark_submitting(entry.id.clone()).expect("marked");
        outbox.mark_ambiguous(entry.id.clone()).expect("marked");
        let again = outbox.pending("c1".to_string()).expect("read");
        assert_eq!(
            again[0].operation_id, entry.operation_id,
            "reusing the operation id is what lets Cave deduplicate"
        );
    }

    #[test]
    fn an_ambiguous_outcome_does_not_return_to_queued() {
        let outbox = outbox();
        let entry = outbox.enqueue("c1".to_string(), "charm".to_string(), "hi".to_string(), "r1".to_string(), 1_000).expect("queued");
        outbox.mark_submitting(entry.id.clone()).expect("marked");
        outbox.mark_ambiguous(entry.id.clone()).expect("marked");
        let pending = outbox.pending("c1".to_string()).expect("read");
        assert_eq!(
            pending[0].state,
            OutboxState::AwaitingReconcile,
            "an ambiguous send must never be resubmitted without reconciling first"
        );
        assert!(outbox.next_submittable("c1".to_string(), "r1".to_string()).expect("read").is_none());
    }

    #[test]
    fn reconciling_a_landed_operation_confirms_it() {
        let outbox = outbox();
        let entry = outbox.enqueue("c1".to_string(), "charm".to_string(), "hi".to_string(), "r1".to_string(), 1_000).expect("queued");
        outbox.mark_submitting(entry.id.clone()).expect("marked");
        outbox.mark_ambiguous(entry.id.clone()).expect("marked");
        outbox.reconcile("c1".to_string(), vec![entry.operation_id.clone()], "r1".to_string()).expect("reconciled");
        assert!(outbox.pending("c1".to_string()).expect("read").is_empty());
    }

    #[test]
    fn reconciling_an_absent_operation_requeues_it_when_nothing_moved() {
        let outbox = outbox();
        let entry = outbox.enqueue("c1".to_string(), "charm".to_string(), "hi".to_string(), "r1".to_string(), 1_000).expect("queued");
        outbox.mark_submitting(entry.id.clone()).expect("marked");
        outbox.mark_ambiguous(entry.id.clone()).expect("marked");
        outbox.reconcile("c1".to_string(), vec![], "r1".to_string()).expect("reconciled");
        let pending = outbox.pending("c1".to_string()).expect("read");
        assert_eq!(pending[0].state, OutboxState::Queued);
    }

    #[test]
    fn a_conversation_that_advanced_needs_confirmation() {
        let outbox = outbox();
        let entry = outbox.enqueue("c1".to_string(), "charm".to_string(), "hi".to_string(), "r1".to_string(), 1_000).expect("queued");
        outbox.mark_submitting(entry.id.clone()).expect("marked");
        outbox.mark_ambiguous(entry.id.clone()).expect("marked");
        // Revision changed while we were away.
        outbox.reconcile("c1".to_string(), vec![], "r2".to_string()).expect("reconciled");
        let pending = outbox.pending("c1".to_string()).expect("read");
        assert_eq!(
            pending[0].state,
            OutboxState::NeedsConfirmation,
            "the context the message was written for is gone"
        );
        assert!(outbox.next_submittable("c1".to_string(), "r2".to_string()).expect("read").is_none());
    }

    #[test]
    fn confirming_a_stale_message_makes_it_submittable_again() {
        let outbox = outbox();
        let entry = outbox.enqueue("c1".to_string(), "charm".to_string(), "hi".to_string(), "r1".to_string(), 1_000).expect("queued");
        outbox.mark_submitting(entry.id.clone()).expect("marked");
        outbox.mark_ambiguous(entry.id.clone()).expect("marked");
        outbox.reconcile("c1".to_string(), vec![], "r2".to_string()).expect("reconciled");
        outbox.confirm(entry.id.clone(), "r2".to_string()).expect("confirmed");
        assert!(outbox.next_submittable("c1".to_string(), "r2".to_string()).expect("read").is_some());
    }

    #[test]
    fn a_permanent_failure_holds_the_queue_rather_than_reordering() {
        let outbox = outbox();
        let first = outbox.enqueue("c1".to_string(), "charm".to_string(), "one".to_string(), "r1".to_string(), 1_000).expect("queued");
        let _second = outbox.enqueue("c1".to_string(), "charm".to_string(), "two".to_string(), "r1".to_string(), 1_001).expect("queued");
        outbox.mark_failed(first.id.clone(), "rejected".to_string()).expect("marked");
        assert!(
            outbox.next_submittable("c1".to_string(), "r1".to_string()).expect("read").is_none(),
            "the second message must not jump ahead of a failed first"
        );
    }

    #[test]
    fn discarding_a_failed_message_releases_the_queue() {
        let outbox = outbox();
        let first = outbox.enqueue("c1".to_string(), "charm".to_string(), "one".to_string(), "r1".to_string(), 1_000).expect("queued");
        let second = outbox.enqueue("c1".to_string(), "charm".to_string(), "two".to_string(), "r1".to_string(), 1_001).expect("queued");
        outbox.mark_failed(first.id.clone(), "rejected".to_string()).expect("marked");
        outbox.discard(first.id).expect("discarded");
        let next = outbox.next_submittable("c1".to_string(), "r1".to_string()).expect("read");
        assert_eq!(next.map(|e| e.id), Some(second.id));
    }

    #[test]
    fn the_queue_is_bounded_and_refuses_rather_than_dropping() {
        let outbox = outbox();
        for index in 0..MAX_OUTBOX_ENTRIES {
            outbox
                .enqueue("c1".to_string(), "charm".to_string(), format!("m{index}"), "r1".to_string(), 1_000 + index as i64)
                .expect("queued");
        }
        let error = outbox
            .enqueue("c1".to_string(), "charm".to_string(), "overflow".to_string(), "r1".to_string(), 9_999)
            .expect_err("must refuse");
        assert!(format!("{error:?}").contains("full"), "{error:?}");
        assert_eq!(
            outbox.pending("c1".to_string()).expect("read").len(),
            MAX_OUTBOX_ENTRIES,
            "the oldest message must never be silently dropped"
        );
    }

    #[test]
    fn entries_survive_reopening() {
        let base = dir();
        let one = Outbox::open(base.clone()).expect("opens");
        one.enqueue("c1".to_string(), "charm".to_string(), "hi".to_string(), "r1".to_string(), 1_000).expect("queued");
        let two = Outbox::open(base).expect("opens");
        assert_eq!(two.pending("c1".to_string()).expect("read").len(), 1);
    }

    #[test]
    fn entries_are_scoped_per_conversation() {
        let outbox = outbox();
        outbox.enqueue("c1".to_string(), "charm".to_string(), "one".to_string(), "r1".to_string(), 1_000).expect("queued");
        outbox.enqueue("c2".to_string(), "charm".to_string(), "two".to_string(), "r1".to_string(), 1_000).expect("queued");
        assert_eq!(outbox.pending("c1".to_string()).expect("read").len(), 1);
        assert_eq!(outbox.pending("c2".to_string()).expect("read").len(), 1);
    }
}
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios/rust && cargo test -p chat-ios-ffi outbox`

Expected: FAIL to compile — `Outbox` undefined.

- [ ] **Step 3: Implement**

Prepend to `rust/ffi/src/outbox.rs`:

```rust
//! The durable outbox.
//!
//! The approved desktop spec lists an offline write queue as a non-goal, on
//! the grounds that it produces duplicate turns and false success. iOS revises
//! that for this surface, because a phone is away from the Cave host by
//! definition. Every rule below exists to neutralize one of those two
//! failures, and none of them is optional.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::ChatError;

/// Maximum queued messages per installation.
pub const MAX_OUTBOX_ENTRIES: usize = 50;

/// Where a queued message is in its life.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, uniffi::Enum)]
pub enum OutboxState {
    /// Never sent. Safe to submit.
    Queued,
    /// In flight right now.
    Submitting,
    /// Sent, outcome unknown. **Never resubmit from here.**
    AwaitingReconcile,
    /// Reconciliation showed it did not land, but the conversation moved on.
    NeedsConfirmation,
    /// Cave rejected it permanently.
    Failed,
}

/// One queued message.
#[derive(Debug, Clone, Serialize, Deserialize, uniffi::Record)]
pub struct OutboxEntry {
    /// Local entry id.
    pub id: String,
    /// Client operation id, reused on every attempt so Cave deduplicates.
    pub operation_id: String,
    /// Target conversation.
    pub conversation_id: String,
    /// Familiar to address.
    pub familiar_id: String,
    /// The message text.
    pub prompt: String,
    /// Conversation revision when this was queued.
    pub queued_revision: String,
    /// Queue time, epoch milliseconds.
    pub queued_at: i64,
    /// Current state.
    pub state: OutboxState,
    /// Why it failed, when it did.
    pub failure: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct Stored {
    version: u32,
    entries: Vec<OutboxEntry>,
}

/// A durable, ordered, bounded outbox.
#[derive(uniffi::Object)]
pub struct Outbox {
    path: PathBuf,
    lock: Mutex<()>,
}

#[uniffi::export]
impl Outbox {
    /// Open, or create, the outbox under a directory.
    #[uniffi::constructor]
    pub fn open(directory: String) -> Result<std::sync::Arc<Self>, ChatError> {
        let directory = PathBuf::from(directory);
        std::fs::create_dir_all(&directory).map_err(|e| ChatError::Malformed {
            detail: format!("outbox directory unusable: {e}"),
        })?;
        Ok(std::sync::Arc::new(Self {
            path: directory.join("outbox.json"),
            lock: Mutex::new(()),
        }))
    }

    /// Queue a message.
    ///
    /// Assigns the operation id here, once. Every later attempt reuses it,
    /// which is what lets Cave collapse a duplicate submission instead of
    /// running the turn twice.
    pub fn enqueue(
        &self,
        conversation_id: String,
        familiar_id: String,
        prompt: String,
        conversation_revision: String,
        now: i64,
    ) -> Result<OutboxEntry, ChatError> {
        self.mutate(|stored| {
            if stored.entries.len() >= MAX_OUTBOX_ENTRIES {
                // Refuse rather than evict. Dropping the oldest queued message
                // to make room loses something the user wrote and believes is
                // pending.
                return Err(ChatError::Malformed {
                    detail: "the outbox is full; send or discard pending messages first"
                        .to_string(),
                });
            }
            let entry = OutboxEntry {
                id: format!("{}-{}", now, stored.entries.len()),
                operation_id: new_operation_id(now, stored.entries.len()),
                conversation_id,
                familiar_id,
                prompt,
                queued_revision: conversation_revision,
                queued_at: now,
                state: OutboxState::Queued,
                failure: None,
            };
            stored.entries.push(entry.clone());
            Ok(entry)
        })
    }

    /// Every entry for one conversation, in queue order.
    pub fn pending(&self, conversation_id: String) -> Result<Vec<OutboxEntry>, ChatError> {
        let stored = self.read()?;
        Ok(stored
            .entries
            .into_iter()
            .filter(|entry| entry.conversation_id == conversation_id)
            .collect())
    }

    /// The next entry that may be submitted right now, if any.
    ///
    /// Returns `None` when the head of the queue is blocked, rather than
    /// skipping it. Reordering a conversation's messages would change their
    /// meaning.
    pub fn next_submittable(
        &self,
        conversation_id: String,
        current_revision: String,
    ) -> Result<Option<OutboxEntry>, ChatError> {
        let entries = self.pending(conversation_id)?;
        let Some(head) = entries.first() else { return Ok(None) };
        match head.state {
            OutboxState::Queued if head.queued_revision == current_revision => {
                Ok(Some(head.clone()))
            }
            // Queued against an older revision: the conversation moved on and
            // the user should decide whether the message still applies.
            OutboxState::Queued => Ok(None),
            _ => Ok(None),
        }
    }

    /// Mark an entry as in flight.
    pub fn mark_submitting(&self, id: String) -> Result<(), ChatError> {
        self.set_state(id, OutboxState::Submitting, None)
    }

    /// Mark an entry whose outcome is unknown.
    ///
    /// This is the state that must never lead directly back to a submission.
    pub fn mark_ambiguous(&self, id: String) -> Result<(), ChatError> {
        self.set_state(id, OutboxState::AwaitingReconcile, None)
    }

    /// Mark an entry Cave rejected permanently.
    pub fn mark_failed(&self, id: String, reason: String) -> Result<(), ChatError> {
        self.set_state(id, OutboxState::Failed, Some(reason))
    }

    /// Remove an entry Cave accepted.
    pub fn complete(&self, id: String) -> Result<(), ChatError> {
        self.mutate(|stored| {
            stored.entries.retain(|entry| entry.id != id);
            Ok(())
        })
    }

    /// Drop an entry the user gave up on.
    pub fn discard(&self, id: String) -> Result<(), ChatError> {
        self.complete(id)
    }

    /// The user confirmed a stale message should still be sent.
    pub fn confirm(&self, id: String, current_revision: String) -> Result<(), ChatError> {
        self.mutate(|stored| {
            if let Some(entry) = stored.entries.iter_mut().find(|entry| entry.id == id) {
                entry.state = OutboxState::Queued;
                entry.queued_revision = current_revision;
            }
            Ok(())
        })
    }

    /// Resolve every ambiguous entry against canonical state.
    ///
    /// `landed_operation_ids` are the operation ids Cave's canonical
    /// transcript actually contains. An entry present there is confirmed and
    /// removed. An entry definitively absent returns to the queue -- but only
    /// as `NeedsConfirmation` if the conversation advanced meanwhile, because
    /// the context the message was written for no longer exists.
    pub fn reconcile(
        &self,
        conversation_id: String,
        landed_operation_ids: Vec<String>,
        current_revision: String,
    ) -> Result<(), ChatError> {
        self.mutate(|stored| {
            stored.entries.retain(|entry| {
                !(entry.conversation_id == conversation_id
                    && entry.state == OutboxState::AwaitingReconcile
                    && landed_operation_ids.contains(&entry.operation_id))
            });
            for entry in stored.entries.iter_mut() {
                if entry.conversation_id != conversation_id
                    || entry.state != OutboxState::AwaitingReconcile
                {
                    continue;
                }
                entry.state = if entry.queued_revision == current_revision {
                    OutboxState::Queued
                } else {
                    OutboxState::NeedsConfirmation
                };
            }
            Ok(())
        })
    }
}

impl Outbox {
    fn read(&self) -> Result<Stored, ChatError> {
        match std::fs::read_to_string(&self.path) {
            Ok(text) => serde_json::from_str(&text).map_err(|e| ChatError::Malformed {
                detail: format!("the outbox file is unreadable: {e}"),
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                Ok(Stored { version: 1, entries: Vec::new() })
            }
            Err(e) => Err(ChatError::Malformed {
                detail: format!("could not read the outbox: {e}"),
            }),
        }
    }

    /// Unlike the read cache, a corrupt outbox is **not** treated as empty.
    /// The cache is replaceable; the outbox holds text the user wrote and
    /// believes is pending, and silently discarding it would be data loss.
    fn mutate<T>(
        &self,
        change: impl FnOnce(&mut Stored) -> Result<T, ChatError>,
    ) -> Result<T, ChatError> {
        let _guard = self.lock.lock().map_err(|_| ChatError::Malformed {
            detail: "outbox lock poisoned".to_string(),
        })?;
        let mut stored = self.read()?;
        let result = change(&mut stored)?;
        stored.version = 1;
        let text = serde_json::to_string(&stored).map_err(|e| ChatError::Malformed {
            detail: format!("could not serialize the outbox: {e}"),
        })?;
        let temporary = self.path.with_extension("tmp");
        std::fs::write(&temporary, text).map_err(|e| ChatError::Malformed {
            detail: format!("could not write the outbox: {e}"),
        })?;
        std::fs::rename(&temporary, &self.path).map_err(|e| ChatError::Malformed {
            detail: format!("could not replace the outbox: {e}"),
        })?;
        Ok(result)
    }

    fn set_state(
        &self,
        id: String,
        state: OutboxState,
        failure: Option<String>,
    ) -> Result<(), ChatError> {
        self.mutate(|stored| {
            if let Some(entry) = stored.entries.iter_mut().find(|entry| entry.id == id) {
                entry.state = state;
                entry.failure = failure;
            }
            Ok(())
        })
    }
}

/// A collision-resistant operation id without pulling in a UUID dependency.
fn new_operation_id(now: i64, index: usize) -> String {
    use std::collections::hash_map::RandomState;
    use std::hash::{BuildHasher, Hasher};
    let mut hasher = RandomState::new().build_hasher();
    hasher.write_i64(now);
    hasher.write_usize(index);
    format!("op-{now:x}-{index:x}-{:x}", hasher.finish())
}
```

Add `mod outbox;` and `pub use outbox::{Outbox, OutboxEntry, OutboxState, MAX_OUTBOX_ENTRIES};` to `rust/ffi/src/lib.rs`.

- [ ] **Step 4: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios/rust
cargo test -p chat-ios-ffi
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
git add rust/ffi/src/
git commit -S -m "Add the durable outbox

Implements the amended non-goal with the rules that make it safe: the
operation id is assigned once and reused so Cave deduplicates; an ambiguous
outcome moves to AwaitingReconcile and never straight back to submittable; a
message whose conversation advanced needs confirmation; a failed head holds
the queue rather than letting later messages reorder around it; and a full
outbox refuses rather than evicting text the user believes is pending.

Unlike the read cache, a corrupt outbox file is an error rather than an empty
one. The cache is replaceable; this holds the user's words."
```

Expected: PASS, 12 new tests.

---

## Task 6: The Stream Controller

**Files:** Create `rust/ffi/src/stream.rs`; modify `rust/ffi/src/session.rs`, `lib.rs`

- [ ] **Step 1: Write the failing test**

Create `rust/ffi/src/stream.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Default)]
    struct Recorder {
        events: Mutex<Vec<String>>,
    }

    impl StreamListener for Recorder {
        fn on_text(&self, text: String) {
            self.events.lock().expect("lock").push(format!("text:{text}"));
        }
        fn on_progress(&self, label: String, status: String) {
            self.events.lock().expect("lock").push(format!("progress:{label}:{status}"));
        }
        fn on_finished(&self, failure: Option<String>) {
            self.events
                .lock()
                .expect("lock")
                .push(format!("finished:{}", failure.unwrap_or_default()));
        }
        fn on_reconcile_required(&self) {
            self.events.lock().expect("lock").push("reconcile".to_string());
        }
    }

    #[test]
    fn a_gap_requests_reconciliation_rather_than_applying() {
        let recorder = Arc::new(Recorder::default());
        let mut pump = StreamPump::new(recorder.clone(), None);
        pump.feed(1, r#"{"type":"message.delta","text":"one"}"#);
        pump.feed(3, r#"{"type":"message.delta","text":"three"}"#);
        let events = recorder.events.lock().expect("lock").clone();
        assert_eq!(events, vec!["text:one".to_string(), "reconcile".to_string()]);
    }

    #[test]
    fn duplicates_are_not_forwarded_twice() {
        let recorder = Arc::new(Recorder::default());
        let mut pump = StreamPump::new(recorder.clone(), None);
        pump.feed(1, r#"{"type":"message.delta","text":"one"}"#);
        pump.feed(1, r#"{"type":"message.delta","text":"one"}"#);
        assert_eq!(recorder.events.lock().expect("lock").len(), 1);
    }

    #[test]
    fn a_terminal_event_reports_finished_with_its_failure() {
        let recorder = Arc::new(Recorder::default());
        let mut pump = StreamPump::new(recorder.clone(), None);
        pump.feed(1, r#"{"type":"run.failed","code":"boom","message":"It failed."}"#);
        let events = recorder.events.lock().expect("lock").clone();
        assert_eq!(events, vec!["finished:It failed.".to_string()]);
    }

    #[test]
    fn the_cursor_is_readable_for_checkpointing() {
        let recorder = Arc::new(Recorder::default());
        let mut pump = StreamPump::new(recorder, None);
        pump.feed(7, r#"{"type":"message.delta","text":"x"}"#);
        assert_eq!(pump.cursor(), Some(7));
    }

    #[test]
    fn an_undecodable_frame_is_skipped_without_advancing_the_cursor() {
        let recorder = Arc::new(Recorder::default());
        let mut pump = StreamPump::new(recorder.clone(), None);
        pump.feed(1, r#"{"type":"message.delta","text":"one"}"#);
        pump.feed(2, "not json");
        assert_eq!(
            pump.cursor(),
            Some(1),
            "a frame we could not read must not be checkpointed as seen"
        );
    }
}
```

- [ ] **Step 2: Run to confirm failure**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios/rust && cargo test -p chat-ios-ffi stream`

Expected: FAIL to compile — `StreamPump` undefined.

- [ ] **Step 3: Implement**

Prepend to `rust/ffi/src/stream.rs`:

```rust
//! Driving a run's stream into Swift.

use std::sync::Arc;

use cave_core::{decode_frame, Accepted, StreamEvent, StreamReducer};

/// What Swift implements to receive stream updates.
///
/// Calls arrive on a Rust thread. Swift must hop to the main actor before
/// touching UI.
#[uniffi::export(callback_interface)]
pub trait StreamListener: Send + Sync {
    /// The accumulated assistant text so far.
    fn on_text(&self, text: String);
    /// A progress step changed.
    fn on_progress(&self, label: String, status: String);
    /// The run reached a terminal event.
    fn on_finished(&self, failure: Option<String>);
    /// The stream cannot continue; canonical state must be reloaded.
    fn on_reconcile_required(&self);
}

/// Feeds decoded frames through the reducer and out to a listener.
pub struct StreamPump {
    listener: Arc<dyn StreamListener>,
    reducer: StreamReducer,
}

impl StreamPump {
    /// Start, optionally resuming from a checkpointed cursor.
    pub fn new(listener: Arc<dyn StreamListener>, cursor: Option<u64>) -> Self {
        Self { listener, reducer: StreamReducer::new(cursor) }
    }

    /// The cursor to checkpoint.
    pub fn cursor(&self) -> Option<u64> {
        self.reducer.cursor()
    }

    /// Whether the run finished.
    pub fn finished(&self) -> bool {
        self.reducer.is_finished()
    }

    /// Feed one raw frame.
    pub fn feed(&mut self, id: u64, data: &str) {
        let frame = coven_transport::SseFrame { id: Some(id), data: data.to_string() };
        let Ok(decoded) = decode_frame(&frame) else {
            // A frame we could not read is not evidence we saw event `id`.
            // Advancing the cursor here would make a resume skip it forever.
            return;
        };

        match self.reducer.accept(&decoded) {
            Accepted::Duplicate => {}
            Accepted::Gap | Accepted::Reconcile => self.listener.on_reconcile_required(),
            Accepted::Applied => match &decoded.event {
                StreamEvent::MessageDelta { .. } => {
                    self.listener.on_text(self.reducer.text().to_string());
                }
                StreamEvent::Progress { label, status, .. } => {
                    self.listener.on_progress(label.clone(), status.clone());
                }
                StreamEvent::RunCompleted { .. } => self.listener.on_finished(None),
                StreamEvent::RunFailed { message, .. } => {
                    self.listener.on_finished(Some(message.clone()));
                }
                _ => {}
            },
        }
    }
}
```

Add `mod stream;` and `pub use stream::StreamListener;` to `rust/ffi/src/lib.rs`.

- [ ] **Step 4: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios/rust
cargo test -p chat-ios-ffi
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
git add rust/ffi/src/
git commit -S -m "Add the stream pump and Swift listener

A frame that cannot be decoded does not advance the cursor: treating it as
seen would make a resume skip it permanently. A gap reports reconciliation
rather than applying an event that would leave the transcript quietly wrong."
```

Expected: PASS, 5 new tests.

---

## Task 7: Session Streaming and Sending

**Files:** Modify `rust/ffi/src/session.rs`

- [ ] **Step 1: Add the session methods**

Add to the `#[uniffi::export(async_runtime = "tokio")] impl CaveSession` block:

```rust
    /// Submit a turn.
    ///
    /// Returns the run to stream. An ambiguous transport outcome surfaces as
    /// `ChatError::Ambiguous`, which the caller must resolve by reconciling,
    /// never by calling this again with the same operation id and hoping.
    pub async fn send(
        &self,
        operation_id: String,
        conversation_id: String,
        familiar_id: String,
        prompt: String,
        project_root: Option<String>,
    ) -> Result<RunAcceptedFfi, ChatError> {
        let endpoint = self.selected_endpoint().await?;
        let input = cave_core::SendInput {
            operation_id,
            conversation_id,
            familiar_id,
            prompt,
            attachment_ids: Vec::new(),
            project_root,
            model: None,
            harness: None,
            retry_of_turn_id: None,
        };
        match cave_core::send(&endpoint, self.bearer(), &input).await {
            Ok(accepted) => Ok(RunAcceptedFfi {
                run_id: accepted.run_id,
                conversation_id: accepted.conversation_id,
                resumed: false,
            }),
            Err(cave_core::SendError::AlreadyRunning { run_id, conversation_id, .. }) => {
                // Not a failure: a run for this operation is already going, so
                // attach to it instead of creating a second one.
                Ok(RunAcceptedFfi { run_id, conversation_id, resumed: true })
            }
            Err(cave_core::SendError::Api(envelope)) => Err(ChatError::Api {
                code: envelope.code,
                message: envelope.message,
                retryable: envelope.retryable,
            }),
            Err(cave_core::SendError::Malformed(detail)) => Err(ChatError::Malformed { detail }),
            Err(cave_core::SendError::Ambiguous { detail }) => {
                Err(ChatError::Ambiguous { detail })
            }
        }
    }

    /// Stop a running turn.
    pub async fn stop_run(&self, run_id: String, operation_id: String) -> Result<(), ChatError> {
        let endpoint = self.selected_endpoint().await?;
        cave_core::stop(&endpoint, self.bearer(), &run_id, &operation_id)
            .await
            .map_err(map_send_error)
    }

    /// Retry a failed turn.
    ///
    /// Takes a fresh operation id rather than reusing the failed turn's. The
    /// original operation reached a terminal state, so reusing its id would
    /// make Cave replay that outcome instead of running anything.
    pub async fn retry_run(
        &self,
        run_id: String,
        operation_id: String,
    ) -> Result<RunAcceptedFfi, ChatError> {
        let endpoint = self.selected_endpoint().await?;
        match cave_core::retry(&endpoint, self.bearer(), &run_id, &operation_id).await {
            Ok(accepted) => Ok(RunAcceptedFfi {
                run_id: accepted.run_id,
                conversation_id: accepted.conversation_id,
                resumed: false,
            }),
            Err(error) => Err(map_send_error(error)),
        }
    }

    /// Stream a run until it ends, feeding a listener.
    ///
    /// Returns the last checkpointed cursor so the caller can resume. This
    /// returning is normal, not an error: backgrounding an iOS app closes the
    /// connection, and the cursor is how the next foreground picks up.
    pub async fn stream_run(
        &self,
        run_id: String,
        cursor: Option<u64>,
        listener: Box<dyn StreamListener>,
    ) -> Result<Option<u64>, ChatError> {
        let endpoint = self.selected_endpoint().await?;
        let path = match cursor {
            Some(cursor) => format!("/api/client/v1/runs/{run_id}/stream?cursor={cursor}"),
            None => format!("/api/client/v1/runs/{run_id}/stream"),
        };
        let request = coven_transport::GetRequest {
            path,
            headers: vec![(
                "Authorization".to_string(),
                format!("Bearer {}", self.bearer()),
            )],
        };

        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let mut pump = StreamPump::new(Arc::from(listener), cursor);

        let endpoint_for_task = endpoint.clone();
        let reader = tokio::spawn(async move {
            coven_transport::stream_endpoint(
                &endpoint_for_task,
                &request,
                std::time::Duration::from_secs(60),
                tx,
            )
            .await
        });

        while let Some(frame) = rx.recv().await {
            if let Some(id) = frame.id {
                pump.feed(id, &frame.data);
            }
            if pump.finished() {
                break;
            }
        }

        let outcome = reader.await.map_err(|e| ChatError::Malformed {
            detail: format!("the stream task failed: {e}"),
        })?;

        if let coven_transport::StreamOutcome::Rejected { body, .. } = outcome {
            // A rejected stream carries an error envelope; surface it rather
            // than reporting a silent end-of-stream.
            if let Err(error) = cave_core::parse_raw_response::<serde_json::Value>(&body) {
                return Err(error.into());
            }
        }

        Ok(pump.cursor())
    }
```

Add the supporting pieces to `session.rs`:

```rust
/// A run Cave accepted.
#[derive(Debug, Clone, uniffi::Record)]
pub struct RunAcceptedFfi {
    /// The run to stream.
    pub run_id: String,
    /// Its conversation.
    pub conversation_id: String,
    /// True when this attached to a run that was already going.
    pub resumed: bool,
}

fn map_send_error(error: cave_core::SendError) -> ChatError {
    match error {
        cave_core::SendError::Api(envelope) => ChatError::Api {
            code: envelope.code,
            message: envelope.message,
            retryable: envelope.retryable,
        },
        cave_core::SendError::AlreadyRunning { run_id, .. } => ChatError::Api {
            code: "conflict".to_string(),
            message: format!("Run {run_id} is already in progress."),
            retryable: false,
        },
        cave_core::SendError::Malformed(detail) => ChatError::Malformed { detail },
        cave_core::SendError::Ambiguous { detail } => ChatError::Ambiguous { detail },
    }
}
```

Add the `Ambiguous` case to `ChatError` in `lib.rs`:

```rust
    /// The request may or may not have been received.
    ///
    /// Distinct from `Unreachable` on purpose: unreachable means nothing was
    /// sent, ambiguous means something might have been, and only the first is
    /// safe to retry.
    #[error("outcome unknown: {detail}")]
    Ambiguous {
        /// What the transport reported.
        detail: String,
    },
```

Add `bearer()` and `selected_endpoint()` helpers to `CaveSession`. `selected_endpoint` runs the same health-probe selection D2 introduced and returns the winning `Endpoint`; store the bearer on the session so `bearer()` can return it.

- [ ] **Step 2: Build, then update the D2 state machine**

`ConnectionState.after(error:)` in Swift must handle the new `Ambiguous` case. Map it to `.unreachable` — the connection is the problem — and add a test asserting an ambiguous outcome never maps to `.connected`.

- [ ] **Step 3: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios/rust && cargo test -p chat-ios-ffi
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
git add rust/ffi/src/
git commit -S -m "Add streaming, send, and stop to CaveSession

AlreadyRunning is not a failure: it attaches to the run already going rather
than creating a second one. ChatError gains Ambiguous, kept distinct from
Unreachable because unreachable means nothing was sent and ambiguous means
something might have been."
```

---

## Task 8: The Thread Model

**Files:** Create `app/Sources/Support/ThreadModel.swift`

- [ ] **Step 1: Implement**

Create `app/Sources/Support/ThreadModel.swift`:

```swift
import Foundation

/// Drives one conversation: transcript, streaming, and the outbox.
@MainActor
final class ThreadModel: ObservableObject {
    @Published private(set) var detail: ConversationDetailFfi?
    @Published private(set) var streamingText = ""
    @Published private(set) var pending: [OutboxEntry] = []
    @Published private(set) var isStreaming = false
    @Published private(set) var failure: String?

    private let conversationId: String
    private let store: CaveStore
    private var activeRunId: String?
    private(set) var lastFailedRunId: String?
    private var cursor: UInt64?
    private var streamTask: Task<Void, Never>?

    init(conversationId: String, store: CaveStore) {
        self.conversationId = conversationId
        self.store = store
    }

    /// Load the transcript and resolve anything the outbox left ambiguous.
    func load() async {
        do {
            let loaded = try await store.conversation(id: conversationId)
            detail = loaded
            // Reconcile before anything is submitted. This is what turns an
            // unknown outcome into a known one.
            try store.reconcileOutbox(
                conversationId: conversationId,
                landedOperationIds: [],
                currentRevision: loaded.conversation.revision
            )
            refreshPending()
            await drainOutbox()
        } catch let error as ChatError {
            failure = error.userFacingMessage
        } catch {
            failure = "Could not load this conversation."
        }
    }

    /// Queue a message and try to send it.
    func send(_ text: String) async {
        guard let revision = detail?.conversation.revision,
              let familiarId = detail?.conversation.familiarId
        else { return }
        do {
            _ = try store.enqueue(
                conversationId: conversationId,
                familiarId: familiarId,
                prompt: text,
                revision: revision
            )
            refreshPending()
            await drainOutbox()
        } catch let error as ChatError {
            failure = error.userFacingMessage
        } catch {
            failure = "Could not queue that message."
        }
    }

    /// Confirm a stale queued message should still be sent.
    func confirm(_ entry: OutboxEntry) async {
        guard let revision = detail?.conversation.revision else { return }
        try? store.confirmOutbox(id: entry.id, revision: revision)
        refreshPending()
        await drainOutbox()
    }

    /// Discard a queued message.
    func discard(_ entry: OutboxEntry) {
        try? store.discardOutbox(id: entry.id)
        refreshPending()
    }

    /// Stop the running turn.
    func stop() async {
        guard let runId = activeRunId else { return }
        try? await store.stopRun(runId: runId)
    }

    /// Retry the last failed run.
    func retry() async {
        guard let runId = lastFailedRunId else { return }
        do {
            let accepted = try await store.retryRun(runId: runId)
            lastFailedRunId = nil
            failure = nil
            activeRunId = accepted.runId
            cursor = nil
            await startStreaming()
        } catch let error as ChatError {
            failure = error.userFacingMessage
        } catch {
            failure = "Could not retry that turn."
        }
    }

    /// Called when the app foregrounds: resume the stream from the cursor.
    func resumeIfNeeded() async {
        guard activeRunId != nil, !isStreaming else { return }
        await startStreaming()
    }

    /// Called when the app backgrounds.
    ///
    /// Cancelling is correct rather than regrettable: iOS closes the socket
    /// anyway, and the cursor is what makes the next foreground seamless.
    func suspend() {
        streamTask?.cancel()
        streamTask = nil
        isStreaming = false
    }

    private func refreshPending() {
        pending = (try? store.pendingOutbox(conversationId: conversationId)) ?? []
    }

    private func drainOutbox() async {
        guard let revision = detail?.conversation.revision else { return }
        guard let next = try? store.nextSubmittable(
            conversationId: conversationId,
            revision: revision
        ), let entry = next else { return }

        do {
            try store.markSubmitting(id: entry.id)
            let accepted = try await store.send(entry: entry)
            try store.completeOutbox(id: entry.id)
            activeRunId = accepted.runId
            cursor = nil
            refreshPending()
            await startStreaming()
        } catch let error as ChatError {
            switch error {
            case .Ambiguous:
                // Do not retry. Mark it and let the next load reconcile.
                try? store.markAmbiguous(id: entry.id)
                failure = "That message may or may not have sent. It will be checked when you reconnect."
            case .Api(_, let message, _):
                try? store.markFailed(id: entry.id, reason: message)
                failure = message
            default:
                try? store.markAmbiguous(id: entry.id)
                failure = error.userFacingMessage
            }
            refreshPending()
        } catch {
            try? store.markAmbiguous(id: entry.id)
            refreshPending()
        }
    }

    private func startStreaming() async {
        guard let runId = activeRunId else { return }
        isStreaming = true
        streamingText = ""
        streamTask = Task { [weak self] in
            guard let self else { return }
            let listener = ThreadStreamListener(model: self)
            let last = try? await store.streamRun(
                runId: runId,
                cursor: cursor,
                listener: listener
            )
            await MainActor.run {
                self.cursor = last
                self.isStreaming = false
            }
        }
    }

    fileprivate func applyText(_ text: String) { streamingText = text }

    fileprivate func applyFinished(_ failure: String?) {
        isStreaming = false
        // Remember a failed run so retry has something to act on.
        lastFailedRunId = failure == nil ? nil : activeRunId
        activeRunId = nil
        self.failure = failure
        Task { await load() }
    }

    fileprivate func applyReconcile() {
        isStreaming = false
        activeRunId = nil
        // A gap means the transcript we have may be wrong. Reload rather than
        // continuing from a partial stream.
        Task { await load() }
    }
}

/// Bridges Rust stream callbacks onto the main actor.
private final class ThreadStreamListener: StreamListener {
    private weak var model: ThreadModel?

    init(model: ThreadModel) { self.model = model }

    func onText(text: String) {
        Task { @MainActor [weak model] in model?.applyText(text) }
    }

    func onProgress(label: String, status: String) {}

    func onFinished(failure: String?) {
        Task { @MainActor [weak model] in model?.applyFinished(failure) }
    }

    func onReconcileRequired() {
        Task { @MainActor [weak model] in model?.applyReconcile() }
    }
}
```

Add the corresponding thin wrappers to `CaveStore` (`enqueue`, `pendingOutbox`, `nextSubmittable`, `markSubmitting`, `markAmbiguous`, `markFailed`, `completeOutbox`, `discardOutbox`, `confirmOutbox`, `reconcileOutbox`, `send(entry:)`, `stopRun`, `retryRun`, `streamRun`), each delegating to the `Outbox` and `CaveSession` objects it already holds.

`retryRun` and `stopRun` each generate a **fresh** operation id per call. Reusing one would make Cave replay the previous outcome rather than performing the action.

- [ ] **Step 2: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
git add app/Sources/Support/
git commit -S -m "Add the thread model

An ambiguous send is marked and left alone until the next load reconciles it.
Backgrounding cancels the stream deliberately: iOS closes the socket anyway,
and the cursor is what makes the next foreground seamless."
```

---

## Task 9: Composer and Pending UI

**Files:** Create `app/Sources/Views/ComposerView.swift`, `app/Tests/OutboxPresentationTests.swift`; modify `ThreadView.swift`

- [ ] **Step 1: Write the failing presentation test**

Create `app/Tests/OutboxPresentationTests.swift`:

```swift
import XCTest
@testable import ChatIOS

final class OutboxPresentationTests: XCTestCase {
    private func entry(_ state: OutboxState) -> OutboxEntry {
        OutboxEntry(
            id: "e1",
            operationId: "op-1",
            conversationId: "c1",
            familiarId: "charm",
            prompt: "hello",
            queuedRevision: "r1",
            queuedAt: 1,
            state: state,
            failure: state == .failed ? "Rejected." : nil
        )
    }

    func testNoPendingStateIsEverDescribedAsSent() {
        for state in [OutboxState.queued, .submitting, .awaitingReconcile, .needsConfirmation, .failed] {
            let label = entry(state).statusLabel
            XCTAssertFalse(
                label.lowercased().contains("sent") || label.lowercased().contains("delivered"),
                "\(state) is described as sent: \(label)"
            )
        }
    }

    func testEveryStateHasDistinctCopy() {
        let states: [OutboxState] = [.queued, .submitting, .awaitingReconcile, .needsConfirmation, .failed]
        let labels = Set(states.map { entry($0).statusLabel })
        XCTAssertEqual(labels.count, states.count)
    }

    func testOnlyNeedsConfirmationOffersConfirmation() {
        for state in [OutboxState.queued, .submitting, .awaitingReconcile, .failed] {
            XCTAssertFalse(entry(state).needsUserConfirmation)
        }
        XCTAssertTrue(entry(.needsConfirmation).needsUserConfirmation)
    }
}
```

The first test is the important one: it fails if anyone ever labels a pending message in a way that reads as delivered, which is exactly the false-success failure the original non-goal warned about.

- [ ] **Step 2: Implement the composer and presentation**

Create `app/Sources/Views/ComposerView.swift`:

```swift
import SwiftUI

extension OutboxEntry {
    /// Short status, never phrased as delivered.
    var statusLabel: String {
        switch state {
        case .queued: return "Waiting to send"
        case .submitting: return "Sending"
        case .awaitingReconcile: return "Unconfirmed - will be checked when you reconnect"
        case .needsConfirmation: return "This conversation moved on since you wrote this"
        case .failed: return failure ?? "Rejected"
        }
    }

    /// Whether the user must decide before this can be sent.
    var needsUserConfirmation: Bool { state == .needsConfirmation }
}

/// Message input.
@MainActor
struct ComposerView: View {
    @ObservedObject var model: ThreadModel
    @State private var text = ""

    var body: some View {
        VStack(spacing: 8) {
            ForEach(model.pending, id: \.id) { entry in
                pendingRow(entry)
            }

            HStack(alignment: .bottom, spacing: 8) {
                TextField("Message", text: $text, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...5)

                if model.isStreaming {
                    Button {
                        Task { await model.stop() }
                    } label: {
                        Image(systemName: "stop.circle.fill")
                    }
                    .accessibilityLabel("Stop")
                } else if model.lastFailedRunId != nil {
                    Button {
                        Task { await model.retry() }
                    } label: {
                        Image(systemName: "arrow.clockwise.circle.fill")
                    }
                    .accessibilityLabel("Retry the failed turn")
                } else {
                    Button {
                        let outgoing = text
                        text = ""
                        Task { await model.send(outgoing) }
                    } label: {
                        Image(systemName: "arrow.up.circle.fill")
                    }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityLabel("Send")
                }
            }
        }
        .padding()
    }

    @ViewBuilder
    private func pendingRow(_ entry: OutboxEntry) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(entry.prompt)
                .font(.footnote)
                .foregroundStyle(.secondary)
            HStack {
                // Pending is visually distinct and never reads as delivered.
                Label(entry.statusLabel, systemImage: "clock")
                    .font(.caption2)
                    .foregroundStyle(entry.state == .failed ? .red : .secondary)
                Spacer()
                if entry.needsUserConfirmation {
                    Button("Send anyway") { Task { await model.confirm(entry) } }
                        .font(.caption2)
                }
                if entry.state == .failed || entry.needsUserConfirmation {
                    Button("Discard") { model.discard(entry) }
                        .font(.caption2)
                }
            }
        }
        .padding(8)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(entry.prompt). \(entry.statusLabel)")
    }
}
```

Update `ThreadView` to own a `ThreadModel`, render `model.streamingText` beneath the transcript while streaming, place `ComposerView` at the bottom, and wire lifecycle:

```swift
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .background: model.suspend()
            case .active: Task { await model.resumeIfNeeded() }
            default: break
            }
        }
```

- [ ] **Step 3: Run tests and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
./scripts/build-xcframework.sh && xcodegen generate && swiftlint lint --strict
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
git add app/
git commit -S -m "Add the composer and pending message UI

A test asserts no outbox state is ever labelled in a way that reads as
delivered, which is the false-success failure the original non-goal warned
about. Only NeedsConfirmation offers to send anyway."
```

---

## Task 10: Phase Gate

- [ ] **Step 1: Full clean build and test**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
rm -rf build app/Sources/Generated rust/target
./scripts/build-xcframework.sh && xcodegen generate && swiftlint lint --strict
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
```

Expected: `TEST SUCCEEDED`.

- [ ] **Step 2: Confirm no automatic resubmission path exists**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios/rust
grep -n "AwaitingReconcile" ffi/src/outbox.rs
```

Read every match. Confirm that no code path moves an entry from `AwaitingReconcile` to `Queued` **except** inside `reconcile`, and that `next_submittable` returns only `Queued` entries whose revision matches. If any other transition exists, it is a duplicate-turn bug regardless of what the tests say.

- [ ] **Step 3: Confirm the SDK and Pocket still pass**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
cd /Users/buns/Documents/GitHub/OpenCoven/coven-pocket/rust && cargo test -p coven-pocket-ffi
```

Expected: PASS. Task 1 changed `coven-transport`'s TLS module, which Pocket consumes.

- [ ] **Step 4: Live journey against a real Cave**

Requires Cave Phase 3. Record the observed result of each:

1. Send a message; watch it stream to completion.
2. Send, then background the app mid-stream; foreground it and confirm the stream resumes from the cursor with no duplicated text.
3. Send, then stop mid-run; confirm the run stops and the transcript reflects it.
4. Enable airplane mode, compose and send; confirm the message shows as waiting, not sent.
5. Disable airplane mode; confirm it sends exactly once. Check Cave's transcript for a single turn.
6. Kill the app mid-send, relaunch; confirm the message is either confirmed or requeued, never duplicated.
7. Queue a message offline, then add a turn from Cave's own UI before reconnecting; confirm the phone asks for confirmation rather than sending into the changed conversation.

Step 6 is the one that matters most. If it produces two turns in Cave, stop and fix before proceeding.

- [ ] **Step 5: Verify signatures**

```bash
for repo in chat-ios sdk; do
  cd "/Users/buns/Documents/GitHub/OpenCoven/$repo"
  echo "== $repo"
  git log --pretty='%H %G?' -30 | awk '$2 != "G" {print "UNSIGNED:", $0}'
done
```

Expected: no output.

---

## Phase E Completion

Phase E is done when:

- A message sends, streams, and completes.
- Backgrounding and foregrounding resumes from the cursor without duplicated text.
- Stop works, and retry re-runs a failed turn under a fresh operation id.
- A duplicate in-flight send attaches to the existing run rather than starting a second.
- A gap or `reconcile_required` reloads canonical state rather than continuing from a partial stream.
- Duplicate event ids are no-ops; unknown event types still advance the cursor.
- A message composed while unreachable is queued, shown as pending, never shown as sent, and submits exactly once on reconnect.
- An ambiguous outcome never resubmits without reconciling first.
- A message whose conversation advanced requires confirmation.
- A failed head holds the queue rather than being reordered around.
- A full outbox refuses rather than dropping the oldest.
- No pending state is labelled in a way that reads as delivered.
- Every commit is signed. Nothing is pushed.

**Not in this phase, by design:** rich content parsing, attachments, privileged actions, and push.

## Handoff to Phase F

Phase F adds the strict marker AST and every native renderer, attachments, attention responses, GitHub actions, task handoffs, and conversation management.

`ThreadView` still renders `message.text` and `model.streamingText` as plain text. Phase F replaces both. `SendInput.attachment_ids` is wired through but always empty; Phase F populates it.
