# iOS Phase B: cave-core Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `coven-transport` with TLS, certificate pinning, candidate racing, and per-network selection memory, then build `cave-core` — the typed Cave `/api/client/v1` contract, compatibility negotiation, error envelope, revision ordering, and stream event types — validated against the exported contract fixture.

**Architecture:** `coven-transport` grows an `Endpoint` that carries its own security policy, so a caller races a heterogeneous candidate list without branching on scheme. TLS verification is pinning-only: a custom `rustls` verifier accepts exactly one certificate fingerprint, which is what makes a private-CA or self-signed tunnel endpoint safe to trust. `cave-core` sits on top as pure data and parsing with no I/O policy of its own, and carries no UniFFI derives — each application's FFI crate owns that boundary, as Coven Pocket already does.

**Tech Stack:** Rust 1.95.0, tokio 1.44, rustls 0.23, tokio-rustls 0.26, sha2 0.10, futures 0.3, semver 1, serde 1, serde_json 1.

**Depends on:** `2026-08-16-ios-phase-a-transport-extraction.md` — specifically `coven_transport::{fetch, Exchange, MAX_RESPONSE_BYTES, extract_json}`.

**Also depends on:** the exported Cave v1 contract fixture from bead `cave-g6x6k`. See Task 10 for how it is vendored and what to do if the exporter is not ready.

**Repositories:**
- SDK: `/Users/buns/Documents/GitHub/OpenCoven/sdk`

**Boundary:** This phase adds no stream reduction, no cursor checkpointing, no reconciliation, no outbox, no marker AST, no pairing, and no UniFFI. Those are Phases C through F. This phase produces types and transport, not behavior over time.

---

## Working Directories

Continue in the Phase A worktree, or create one from Phase A's merged result:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git worktree add -b feat/ios-phase-b-cave-core .worktrees/ios-phase-b-cave-core feat/ios-phase-a-transport
```

Every SDK path below means the corresponding path inside that worktree.

The SDK main checkout is on `feat/cave-o2bqs-sdk-foundation` with uncommitted Phase 0 work and a locked review worktree. Do not touch it. Before starting, confirm no other session holds these checkouts:

```bash
ps -ef | grep ' claude' | grep -v grep | awk '{print $2}' | while read pid; do
  lsof -p $pid 2>/dev/null | awk '$4=="cwd"{print $9}'
done
```

---

## Critical Rules

- **Every commit signed.** Pass `-S` to every `git commit`. Verify `git config --get user.signingkey` returns a key before the first one.
- **Do not push.** Local commits only. Pushing needs operator authorization.
- **No emojis** in commits or code.
- **No `.unwrap()` / `.expect()` on fallible paths outside tests.**
- **`cave-core` must not depend on `uniffi`.** A dependency check in Task 16 enforces this.

---

## File Map

### `crates/coven-transport` (extended)

- Create `src/endpoint.rs` — `Endpoint` and `Security`.
- Create `src/tls.rs` — pinned certificate verifier and the TLS exchange.
- Create `src/race.rs` — staggered candidate racing.
- Create `src/selection.rs` — `SelectionStore` and the remembered-first connect path.
- Modify `src/fetch.rs` — split the exchange so plaintext and TLS share framing.
- Modify `src/lib.rs` — export the new surface.
- Modify `Cargo.toml` — add rustls, tokio-rustls, sha2, futures.

### `crates/cave-core` (new)

- Create `Cargo.toml`.
- Create `src/lib.rs` — crate docs and public surface.
- Create `src/error.rs` — `ErrorEnvelope`, `CaveError`, envelope parsing.
- Create `src/health.rs` — `Health`, `Compatibility`, negotiation.
- Create `src/roster.rs` — `Familiar`, `Project`.
- Create `src/credentials.rs` — `Credential`.
- Create `src/conversations.rs` — `ConversationSummary`, `Page`, `Conversation`, `Message`, `Attachment`, revision ordering.
- Create `src/stream.rs` — `StreamFrame`, `StreamEvent`, `ToolPayload`.
- Create `tests/fixtures/contract-fixture.json` — vendored, never hand-edited.
- Create `tests/fixtures/contract-fixture.sha256`.
- Create `tests/conformance.rs` — parses every fixture section.

### Workspace

- Modify `Cargo.toml` — add `crates/cave-core` to members, add shared dependency versions.
- Modify `.github/workflows/rust.yml` — add the no-UniFFI dependency check.

---

## Task 1: Endpoint and Security Types

An endpoint carries its own security policy so a candidate list can mix a plaintext tunnel address and a pinned-TLS hostname without the caller branching.

**Files:**
- Create: `crates/coven-transport/src/endpoint.rs`
- Modify: `crates/coven-transport/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/coven-transport/src/endpoint.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plaintext_endpoints_key_on_host_and_port() {
        let endpoint = Endpoint::plaintext("cave.tailnet.ts.net", 7777);
        assert_eq!(endpoint.key(), "cave.tailnet.ts.net:7777");
        assert_eq!(endpoint.security, Security::Plaintext);
    }

    #[test]
    fn tls_endpoints_carry_their_pin() {
        let pin = [7u8; 32];
        let endpoint = Endpoint::tls("cave.tailnet.ts.net", 8443, pin);
        assert_eq!(endpoint.key(), "cave.tailnet.ts.net:8443");
        assert_eq!(endpoint.security, Security::Tls { pinned_sha256: pin });
    }

    #[test]
    fn keys_distinguish_ports_on_the_same_host() {
        let a = Endpoint::plaintext("host", 1);
        let b = Endpoint::plaintext("host", 2);
        assert_ne!(a.key(), b.key());
    }
}
```

Add to `src/lib.rs`, after the existing `mod` lines:

```rust
mod endpoint;

pub use endpoint::{Endpoint, Security};
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p coven-transport`

Expected: FAIL to compile with `cannot find type 'Endpoint' in this scope`.

- [ ] **Step 3: Write the implementation**

Prepend to `crates/coven-transport/src/endpoint.rs`:

```rust
//! Where to reach a service, and how to trust it.

/// How a connection to an endpoint is secured.
///
/// Plaintext is correct when the overlay itself provides confidentiality and
/// peer authentication, which is the case for a WireGuard-based tailnet. TLS
/// with a pin is for endpoints that terminate TLS themselves, including with a
/// private CA or a self-signed certificate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Security {
    /// No transport encryption; the overlay is trusted to provide it.
    Plaintext,
    /// TLS accepting exactly one certificate, by SHA-256 of its DER encoding.
    Tls {
        /// SHA-256 of the server's DER-encoded end-entity certificate.
        pinned_sha256: [u8; 32],
    },
}

/// A host, a port, and the policy for trusting what answers there.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    /// Hostname or IP literal.
    pub host: String,
    /// TCP port.
    pub port: u16,
    /// How to secure and trust the connection.
    pub security: Security,
}

impl Endpoint {
    /// An endpoint reached without transport encryption.
    pub fn plaintext(host: impl Into<String>, port: u16) -> Self {
        Self {
            host: host.into(),
            port,
            security: Security::Plaintext,
        }
    }

    /// An endpoint reached over TLS, trusting exactly one certificate.
    pub fn tls(host: impl Into<String>, port: u16, pinned_sha256: [u8; 32]) -> Self {
        Self {
            host: host.into(),
            port,
            security: Security::Tls { pinned_sha256 },
        }
    }

    /// Stable identity for remembering a working endpoint across launches.
    ///
    /// Deliberately excludes the security policy: the same host and port
    /// reached with a rotated pin is still the same endpoint.
    pub fn key(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p coven-transport`

Expected: PASS, `12 passed` (9 from Phase A, 3 new).

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add crates/coven-transport/src/endpoint.rs crates/coven-transport/src/lib.rs
git commit -S -m "Add Endpoint and Security to coven-transport

An endpoint carries its own trust policy so a candidate list can mix plaintext
tunnel addresses and pinned-TLS hostnames without the caller branching."
```

---

## Task 2: Route Plaintext Exchanges Through Endpoint

Before adding TLS, make the existing plaintext path go through `Endpoint`. Phase A's `fetch` stays as a wrapper so Coven Pocket is untouched.

**Files:**
- Modify: `crates/coven-transport/src/fetch.rs`
- Modify: `crates/coven-transport/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Add to the `tests` module in `crates/coven-transport/src/fetch.rs`:

```rust
    #[tokio::test]
    async fn fetch_endpoint_reaches_a_plaintext_endpoint() {
        let port = serve_once("HTTP/1.1 200 OK\r\n\r\n{\"ok\":true}").await;
        let endpoint = Endpoint::plaintext("127.0.0.1", port);
        match fetch_endpoint(&endpoint, "/health", TIMEOUT).await {
            Exchange::Response { body, .. } => assert!(body.contains("{\"ok\":true}")),
            other => panic!("expected Response, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn fetch_still_works_for_phase_a_callers() {
        let port = serve_once("HTTP/1.1 200 OK\r\n\r\n{\"ok\":true}").await;
        match fetch("127.0.0.1", port, "/health", TIMEOUT).await {
            Exchange::Response { body, .. } => assert!(body.contains("{\"ok\":true}")),
            other => panic!("expected Response, got {other:?}"),
        }
    }
```

Add `use crate::endpoint::Endpoint;` to the top of `src/fetch.rs`, and export from `src/lib.rs`:

```rust
pub use fetch::{fetch, fetch_endpoint, Exchange, MAX_RESPONSE_BYTES};
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p coven-transport`

Expected: FAIL to compile with `cannot find function 'fetch_endpoint' in this scope`.

- [ ] **Step 3: Restructure the exchange**

In `crates/coven-transport/src/fetch.rs`, replace the `fetch` function with this pair. The resolve-connect-budget logic is unchanged; it is only moved behind an endpoint-shaped entry point.

```rust
/// Perform one GET against an endpoint, under a single timeout budget
/// spanning DNS resolution, connect, and the exchange.
pub async fn fetch_endpoint(endpoint: &Endpoint, path: &str, timeout: Duration) -> Exchange {
    let started = Instant::now();

    let addrs = match tokio::time::timeout(
        timeout,
        tokio::net::lookup_host((endpoint.host.as_str(), endpoint.port)),
    )
    .await
    {
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

    let exchange = match &endpoint.security {
        Security::Plaintext => tokio::time::timeout(remaining, http_get(stream, path)).await,
        Security::Tls { pinned_sha256 } => {
            tokio::time::timeout(
                remaining,
                crate::tls::http_get_tls(stream, &endpoint.host, path, *pinned_sha256),
            )
            .await
        }
    };

    match exchange {
        Ok(Ok(body)) => Exchange::Response {
            body,
            latency_ms: elapsed_ms(started),
        },
        Ok(Err(e)) => Exchange::Failed(e.to_string()),
        Err(_) => Exchange::TimedOut,
    }
}

/// Plaintext convenience wrapper, kept for callers that predate [`Endpoint`].
pub async fn fetch(host: &str, port: u16, path: &str, timeout: Duration) -> Exchange {
    fetch_endpoint(&Endpoint::plaintext(host, port), path, timeout).await
}
```

Add `use crate::endpoint::{Endpoint, Security};` at the top of `src/fetch.rs`.

**This will not compile yet** — `crate::tls::http_get_tls` does not exist. Task 3 adds it. To keep this task independently verifiable, temporarily stub the TLS arm by replacing the `Security::Tls` match arm with:

```rust
        Security::Tls { .. } => {
            return Exchange::Failed("TLS support arrives in Task 3".to_string());
        }
```

Task 3 replaces that arm with the real call.

- [ ] **Step 4: Generalize the response reader**

`http_get` currently takes a `TcpStream`. Make it generic so the TLS stream can reuse the exact same framing, cap, and lossy decoding:

```rust
async fn http_get(stream: TcpStream, path: &str) -> std::io::Result<String> {
    http_get_over(stream, path).await
}

/// Send the minimal request and return the raw response, over any stream.
pub(crate) async fn http_get_over<S>(mut stream: S, path: &str) -> std::io::Result<String>
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let request = format!("GET {path} HTTP/1.1\r\nHost: coven\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await?;
    let mut response = Vec::new();
    let mut limited = tokio::io::AsyncReadExt::take(stream, MAX_RESPONSE_BYTES);
    limited.read_to_end(&mut response).await?;
    Ok(String::from_utf8_lossy(&response).into_owned())
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p coven-transport`

Expected: PASS, `14 passed`. Every Phase A test still passes, which confirms the restructure preserved behavior.

- [ ] **Step 6: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add crates/coven-transport/src/fetch.rs crates/coven-transport/src/lib.rs
git commit -S -m "Route exchanges through Endpoint and generalize the reader

fetch stays as a plaintext wrapper so Coven Pocket is unaffected. The response
reader is now stream-generic so TLS reuses identical framing and capping."
```

---

## Task 3: Pinned TLS

Verification is pinning-only. There is no CA path, no hostname check, and no fallback: exactly one certificate is acceptable, identified by SHA-256 of its DER encoding. That is what makes a self-signed or private-CA tunnel endpoint safe to trust, and it fails closed if the pin does not match.

**Files:**
- Create: `crates/coven-transport/src/tls.rs`
- Modify: `crates/coven-transport/src/fetch.rs`
- Modify: `crates/coven-transport/src/lib.rs`
- Modify: `crates/coven-transport/Cargo.toml`
- Modify: `Cargo.toml`

- [ ] **Step 1: Add the dependencies**

In the workspace `Cargo.toml`, add to `[workspace.dependencies]`:

```toml
rustls = { version = "0.23", default-features = false, features = ["ring", "std", "tls12", "logging"] }
tokio-rustls = { version = "0.26", default-features = false, features = ["ring", "tls12", "logging"] }
rustls-pki-types = "1"
sha2 = "0.10"
futures = "0.3"
```

In `crates/coven-transport/Cargo.toml`, add to `[dependencies]`:

```toml
rustls = { workspace = true }
tokio-rustls = { workspace = true }
rustls-pki-types = { workspace = true }
sha2 = { workspace = true }
futures = { workspace = true }
```

Add to `[dev-dependencies]`:

```toml
rcgen = "0.13"
```

`ring` rather than the default `aws-lc-rs` because it cross-compiles to iOS and Windows with less toolchain friction, which this crate needs.

- [ ] **Step 2: Write the failing test**

Create `crates/coven-transport/src/tls.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{fetch_endpoint, Endpoint, Exchange};
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::net::TcpListener;
    use tokio_rustls::TlsAcceptor;

    const TIMEOUT: Duration = Duration::from_millis(3000);

    /// A self-signed server, plus the SHA-256 pin of its certificate.
    struct TestServer {
        port: u16,
        pin: [u8; 32],
    }

    async fn serve_tls_once(response: &'static str) -> TestServer {
        let cert = rcgen::generate_simple_self_signed(vec!["localhost".to_string()])
            .expect("generate certificate");
        let cert_der = cert.cert.der().to_vec();
        // rcgen 0.13 names this field `key_pair`. It was renamed to
        // `signing_key` in 0.14 -- if the dependency resolves to 0.14 or
        // later, use `cert.signing_key.serialize_der()` instead.
        let key_der = cert.key_pair.serialize_der();
        let pin: [u8; 32] = Sha256::digest(&cert_der).into();

        let config = rustls::ServerConfig::builder()
            .with_no_client_auth()
            .with_single_cert(
                vec![rustls_pki_types::CertificateDer::from(cert_der)],
                rustls_pki_types::PrivateKeyDer::try_from(key_der).expect("key"),
            )
            .expect("server config");
        let acceptor = TlsAcceptor::from(Arc::new(config));

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await {
                if let Ok(mut tls) = acceptor.accept(stream).await {
                    use tokio::io::{AsyncReadExt, AsyncWriteExt};
                    let mut buf = [0u8; 1024];
                    let _ = tls.read(&mut buf).await;
                    let _ = tls.write_all(response.as_bytes()).await;
                    let _ = tls.shutdown().await;
                }
            }
        });
        TestServer { port, pin }
    }

    #[tokio::test]
    async fn a_matching_pin_is_accepted() {
        let server = serve_tls_once("HTTP/1.1 200 OK\r\n\r\n{\"ok\":true}").await;
        let endpoint = Endpoint::tls("localhost", server.port, server.pin);
        match fetch_endpoint(&endpoint, "/health", TIMEOUT).await {
            Exchange::Response { body, .. } => assert!(body.contains("{\"ok\":true}")),
            other => panic!("expected Response, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_mismatched_pin_is_rejected() {
        let server = serve_tls_once("HTTP/1.1 200 OK\r\n\r\n{\"ok\":true}").await;
        // Same server, wrong pin: this must fail closed.
        let endpoint = Endpoint::tls("localhost", server.port, [0u8; 32]);
        match fetch_endpoint(&endpoint, "/health", TIMEOUT).await {
            Exchange::Failed(detail) => {
                assert!(
                    detail.contains("fingerprint") || detail.contains("certificate"),
                    "expected a certificate error, got: {detail}"
                );
            }
            other => panic!("expected Failed, got {other:?}"),
        }
    }
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p coven-transport tls`

Expected: FAIL to compile — `Sha256` and `http_get_tls` are undefined.

- [ ] **Step 4: Write the implementation**

Prepend to `crates/coven-transport/src/tls.rs`:

```rust
//! TLS that trusts exactly one certificate.
//!
//! There is no CA path and no hostname verification here, by design. The
//! endpoint's certificate is delivered out of band — in Chat's case, inside
//! the enrollment QR — so the only question at connect time is whether the
//! certificate presented is byte-identical to the one that was enrolled.
//! Anything else fails closed.

use std::sync::Arc;

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};
use sha2::{Digest, Sha256};
use tokio::net::TcpStream;

/// Accepts exactly one end-entity certificate, by SHA-256 of its DER bytes.
#[derive(Debug)]
struct PinnedVerifier {
    pinned_sha256: [u8; 32],
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl ServerCertVerifier for PinnedVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let presented: [u8; 32] = Sha256::digest(end_entity.as_ref()).into();
        // Constant-time comparison is unnecessary here: the pin is not a
        // secret and the comparison result is already observable as a
        // connection failure.
        if presented == self.pinned_sha256 {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(
                "server certificate fingerprint does not match the pinned value".to_string(),
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// Perform one GET over TLS, trusting only the pinned certificate.
pub(crate) async fn http_get_tls(
    stream: TcpStream,
    host: &str,
    path: &str,
    pinned_sha256: [u8; 32],
) -> std::io::Result<String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let config = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .map_err(std::io::Error::other)?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(PinnedVerifier {
            pinned_sha256,
            provider,
        }))
        .with_no_client_auth();

    // The name is only used for SNI; trust comes entirely from the pin.
    let server_name = ServerName::try_from(host.to_string()).map_err(std::io::Error::other)?;
    let connector = tokio_rustls::TlsConnector::from(Arc::new(config));
    let tls = connector.connect(server_name, stream).await?;
    crate::fetch::http_get_over(tls, path).await
}
```

Replace the temporary `Security::Tls` arm in `src/fetch.rs` with the real call:

```rust
        Security::Tls { pinned_sha256 } => {
            tokio::time::timeout(
                remaining,
                crate::tls::http_get_tls(stream, &endpoint.host, path, *pinned_sha256),
            )
            .await
        }
```

Add to `src/lib.rs`:

```rust
mod tls;
```

- [ ] **Step 5: Verify the rustls API matches the installed version**

The verifier trait signatures above target rustls 0.23. If compilation fails with a trait-signature mismatch, check the exact shape:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
cargo doc -p rustls --no-deps --open
```

Adjust argument types to match `rustls::client::danger::ServerCertVerifier` in the resolved version, and record the version in the commit message. Do not weaken verification to make it compile — the pin comparison in `verify_server_cert` is the security property of this task.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p coven-transport`

Expected: PASS, `16 passed`.

- [ ] **Step 7: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add crates/coven-transport/src/tls.rs crates/coven-transport/src/fetch.rs crates/coven-transport/src/lib.rs crates/coven-transport/Cargo.toml Cargo.toml Cargo.lock
git commit -S -m "Add pinning-only TLS to coven-transport

Trusts exactly one certificate by SHA-256 of its DER encoding, with no CA path
and no hostname verification. The certificate is enrolled out of band, so a
mismatch fails closed rather than falling back to web PKI."
```

---

## Task 4: Candidate Racing

Enrollment delivers several addresses. The client should not ask the user which one applies to the current network.

**Files:**
- Create: `crates/coven-transport/src/race.rs`
- Modify: `crates/coven-transport/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/coven-transport/src/race.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn config() -> RaceConfig {
        RaceConfig {
            stagger: Duration::from_millis(0),
            timeout: Duration::from_millis(1500),
        }
    }

    async fn serve_once(response: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf).await;
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        port
    }

    async fn dead_port() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        listener.local_addr().expect("addr").port()
    }

    #[tokio::test]
    async fn the_answering_candidate_wins_regardless_of_position() {
        let live = serve_once("HTTP/1.1 200 OK\r\n\r\n{\"ok\":true}").await;
        let dead = dead_port().await;
        let candidates = vec![
            Endpoint::plaintext("127.0.0.1", dead),
            Endpoint::plaintext("127.0.0.1", live),
        ];
        let outcome = race(&candidates, "/health", config()).await;
        assert_eq!(outcome.winner, Some(1));
        assert!(matches!(outcome.exchange, Exchange::Response { .. }));
    }

    #[tokio::test]
    async fn all_dead_candidates_report_the_most_informative_failure() {
        let dead = dead_port().await;
        let candidates = vec![
            Endpoint::plaintext("definitely-not-a-real-host.invalid", 7777),
            Endpoint::plaintext("127.0.0.1", dead),
        ];
        let outcome = race(&candidates, "/health", config()).await;
        assert_eq!(outcome.winner, None);
        // Refused outranks Unresolvable: something is at that address.
        assert!(matches!(outcome.exchange, Exchange::Refused));
    }

    #[tokio::test]
    async fn an_empty_candidate_list_fails_rather_than_hanging() {
        let outcome = race(&[], "/health", config()).await;
        assert_eq!(outcome.winner, None);
        assert!(matches!(outcome.exchange, Exchange::Failed(_)));
    }
}
```

Add to `src/lib.rs`:

```rust
mod race;

pub use race::{race, RaceConfig, RaceOutcome};
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p coven-transport race`

Expected: FAIL to compile with `cannot find function 'race' in this scope`.

- [ ] **Step 3: Write the implementation**

Prepend to `crates/coven-transport/src/race.rs`:

```rust
//! Race a candidate list and keep the first endpoint that answers.

use std::time::Duration;

use futures::stream::{FuturesUnordered, StreamExt};

use crate::endpoint::Endpoint;
use crate::fetch::fetch_endpoint;
use crate::Exchange;

/// How to race a candidate list.
#[derive(Debug, Clone)]
pub struct RaceConfig {
    /// Delay added per candidate position, so earlier candidates get a head
    /// start instead of every address being dialed simultaneously.
    pub stagger: Duration,
    /// Per-candidate budget, applied independently to each attempt.
    pub timeout: Duration,
}

impl Default for RaceConfig {
    fn default() -> Self {
        Self {
            stagger: Duration::from_millis(250),
            timeout: Duration::from_secs(3),
        }
    }
}

/// What a race produced.
#[derive(Debug)]
pub struct RaceOutcome {
    /// Index of the candidate that answered, or `None` if none did.
    pub winner: Option<usize>,
    /// The winning response, or the most informative failure observed.
    pub exchange: Exchange,
}

/// How useful a failure is when reporting to a user.
///
/// `Refused` means we reached the host and nothing was listening, which is
/// actionable. `Unresolvable` means the name is wrong. `TimedOut` could be
/// anything. `Failed` is unclassified and least useful.
fn informativeness(exchange: &Exchange) -> u8 {
    match exchange {
        Exchange::Response { .. } => 4,
        Exchange::Refused => 3,
        Exchange::Unresolvable => 2,
        Exchange::TimedOut => 1,
        Exchange::Failed(_) => 0,
    }
}

/// Try every candidate, staggered, and return the first that answers.
///
/// If none answer, returns the most informative failure, breaking ties toward
/// the earlier candidate so the result is deterministic.
pub async fn race(candidates: &[Endpoint], path: &str, config: RaceConfig) -> RaceOutcome {
    if candidates.is_empty() {
        return RaceOutcome {
            winner: None,
            exchange: Exchange::Failed("no candidate endpoints".to_string()),
        };
    }

    let mut pending = FuturesUnordered::new();
    for (index, endpoint) in candidates.iter().enumerate() {
        let delay = config.stagger.saturating_mul(index as u32);
        let timeout = config.timeout;
        pending.push(async move {
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            (index, fetch_endpoint(endpoint, path, timeout).await)
        });
    }

    let mut best: Option<(usize, Exchange)> = None;
    while let Some((index, exchange)) = pending.next().await {
        if matches!(exchange, Exchange::Response { .. }) {
            return RaceOutcome {
                winner: Some(index),
                exchange,
            };
        }
        let replace = match &best {
            None => true,
            Some((best_index, best_exchange)) => {
                let rank = informativeness(&exchange);
                let best_rank = informativeness(best_exchange);
                rank > best_rank || (rank == best_rank && index < *best_index)
            }
        };
        if replace {
            best = Some((index, exchange));
        }
    }

    match best {
        Some((_, exchange)) => RaceOutcome {
            winner: None,
            exchange,
        },
        None => RaceOutcome {
            winner: None,
            exchange: Exchange::Failed("no candidate produced a result".to_string()),
        },
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p coven-transport`

Expected: PASS, `19 passed`.

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add crates/coven-transport/src/race.rs crates/coven-transport/src/lib.rs
git commit -S -m "Race candidate endpoints in coven-transport

Staggered start, first answer wins. When nothing answers, reports the most
informative failure with deterministic tie-breaking toward earlier candidates."
```

---

## Task 5: Per-Network Selection Memory

Racing every launch is wasteful and slow. Remembering which endpoint worked on this network is what makes reconnection feel instant.

**Files:**
- Create: `crates/coven-transport/src/selection.rs`
- Modify: `crates/coven-transport/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/coven-transport/src/selection.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::RaceConfig;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    fn config() -> RaceConfig {
        RaceConfig {
            stagger: Duration::from_millis(0),
            timeout: Duration::from_millis(1500),
        }
    }

    async fn serve_once(response: &'static str) -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("addr").port();
        tokio::spawn(async move {
            if let Ok((mut stream, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = stream.read(&mut buf).await;
                let _ = stream.write_all(response.as_bytes()).await;
            }
        });
        port
    }

    async fn dead_port() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        listener.local_addr().expect("addr").port()
    }

    #[tokio::test]
    async fn a_successful_connect_is_remembered() {
        let live = serve_once("HTTP/1.1 200 OK\r\n\r\n{\"ok\":true}").await;
        let candidates = vec![Endpoint::plaintext("127.0.0.1", live)];
        let store = InMemorySelectionStore::default();

        let outcome = connect(&candidates, "/health", config(), Some("wifi-home"), &store).await;
        assert_eq!(outcome.winner, Some(0));
        assert_eq!(
            store.remembered("wifi-home"),
            Some(format!("127.0.0.1:{live}"))
        );
    }

    #[tokio::test]
    async fn a_remembered_endpoint_is_tried_first() {
        let live = serve_once("HTTP/1.1 200 OK\r\n\r\n{\"ok\":true}").await;
        let dead = dead_port().await;
        // Remembered endpoint sits last in the list; it must still be used.
        let candidates = vec![
            Endpoint::plaintext("127.0.0.1", dead),
            Endpoint::plaintext("127.0.0.1", live),
        ];
        let store = InMemorySelectionStore::default();
        store.remember("wifi-home", &format!("127.0.0.1:{live}"));

        let outcome = connect(&candidates, "/health", config(), Some("wifi-home"), &store).await;
        assert_eq!(outcome.winner, Some(1));
        assert!(matches!(outcome.exchange, Exchange::Response { .. }));
    }

    #[tokio::test]
    async fn a_stale_memory_falls_back_to_racing() {
        let live = serve_once("HTTP/1.1 200 OK\r\n\r\n{\"ok\":true}").await;
        let dead = dead_port().await;
        let candidates = vec![
            Endpoint::plaintext("127.0.0.1", dead),
            Endpoint::plaintext("127.0.0.1", live),
        ];
        let store = InMemorySelectionStore::default();
        // Remember the dead one: connect must notice and race anyway.
        store.remember("wifi-cafe", &format!("127.0.0.1:{dead}"));

        let outcome = connect(&candidates, "/health", config(), Some("wifi-cafe"), &store).await;
        assert_eq!(outcome.winner, Some(1));
        assert_eq!(
            store.remembered("wifi-cafe"),
            Some(format!("127.0.0.1:{live}")),
            "a stale memory must be replaced by what actually worked"
        );
    }

    #[tokio::test]
    async fn an_unknown_network_just_races() {
        let live = serve_once("HTTP/1.1 200 OK\r\n\r\n{\"ok\":true}").await;
        let candidates = vec![Endpoint::plaintext("127.0.0.1", live)];
        let store = InMemorySelectionStore::default();
        let outcome = connect(&candidates, "/health", config(), None, &store).await;
        assert_eq!(outcome.winner, Some(0));
        // With no network identity there is nothing to key a memory on.
        assert_eq!(store.remembered("wifi-home"), None);
    }
}
```

Add to `src/lib.rs`:

```rust
mod selection;

pub use selection::{connect, InMemorySelectionStore, SelectionStore};
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p coven-transport selection`

Expected: FAIL to compile with `cannot find function 'connect' in this scope`.

- [ ] **Step 3: Write the implementation**

Prepend to `crates/coven-transport/src/selection.rs`:

```rust
//! Remember which endpoint answered on which network.

use std::collections::HashMap;
use std::sync::Mutex;

use crate::endpoint::Endpoint;
use crate::fetch::fetch_endpoint;
use crate::race::{race, RaceConfig, RaceOutcome};
use crate::Exchange;

/// Persistence for the endpoint that last worked on a given network.
///
/// The host supplies this. Keys are opaque network identities — an SSID hash,
/// a gateway MAC, whatever the platform can offer — and values are
/// [`Endpoint::key`] strings.
pub trait SelectionStore: Send + Sync {
    /// The endpoint key that last worked on this network, if any.
    fn remembered(&self, network: &str) -> Option<String>;
    /// Record the endpoint key that just worked on this network.
    fn remember(&self, network: &str, endpoint_key: &str);
    /// Drop any memory for this network.
    fn forget(&self, network: &str);
}

/// A non-persistent store, useful for tests and for hosts with nothing to
/// persist to.
#[derive(Debug, Default)]
pub struct InMemorySelectionStore {
    inner: Mutex<HashMap<String, String>>,
}

impl SelectionStore for InMemorySelectionStore {
    fn remembered(&self, network: &str) -> Option<String> {
        self.inner
            .lock()
            .ok()
            .and_then(|map| map.get(network).cloned())
    }

    fn remember(&self, network: &str, endpoint_key: &str) {
        if let Ok(mut map) = self.inner.lock() {
            map.insert(network.to_string(), endpoint_key.to_string());
        }
    }

    fn forget(&self, network: &str) {
        if let Ok(mut map) = self.inner.lock() {
            map.remove(network);
        }
    }
}

/// Connect to the best available candidate, preferring what worked last time
/// on this network.
///
/// Tries the remembered endpoint alone first, because the common case is that
/// it still works and racing the whole list would be wasted effort. Falls back
/// to a full race the moment it does not, and records whatever actually
/// answered.
pub async fn connect(
    candidates: &[Endpoint],
    path: &str,
    config: RaceConfig,
    network: Option<&str>,
    store: &dyn SelectionStore,
) -> RaceOutcome {
    if let Some(network) = network {
        if let Some(key) = store.remembered(network) {
            if let Some(index) = candidates.iter().position(|c| c.key() == key) {
                let exchange = fetch_endpoint(&candidates[index], path, config.timeout).await;
                if matches!(exchange, Exchange::Response { .. }) {
                    return RaceOutcome {
                        winner: Some(index),
                        exchange,
                    };
                }
            }
        }
    }

    let outcome = race(candidates, path, config).await;
    if let (Some(network), Some(index)) = (network, outcome.winner) {
        if let Some(endpoint) = candidates.get(index) {
            store.remember(network, &endpoint.key());
        }
    }
    outcome
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p coven-transport`

Expected: PASS, `23 passed`.

- [ ] **Step 5: Verify lints and formatting**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
cargo fmt --all --check
cargo clippy -p coven-transport --all-targets -- -D warnings
```

Expected: both exit 0.

- [ ] **Step 6: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add crates/coven-transport/src/selection.rs crates/coven-transport/src/lib.rs
git commit -S -m "Remember the working endpoint per network

Tries the remembered endpoint alone first and falls back to a full race the
moment it fails, replacing the stale memory with whatever answered."
```

---

## Task 6: cave-core Crate Skeleton

**Files:**
- Create: `crates/cave-core/Cargo.toml`
- Create: `crates/cave-core/src/lib.rs`
- Modify: `Cargo.toml`

- [ ] **Step 1: Add the crate to the workspace**

In the workspace `Cargo.toml`, change `members`:

```toml
members = ["crates/coven-transport", "crates/cave-core"]
```

And add to `[workspace.dependencies]`:

```toml
serde = { version = "1", features = ["derive"] }
semver = "1"
coven-transport = { path = "crates/coven-transport" }
```

- [ ] **Step 2: Create the manifest**

Create `crates/cave-core/Cargo.toml`:

```toml
[package]
name = "cave-core"
description = "Typed client contract for the Coven Cave /api/client/v1 surface."
version.workspace = true
edition.workspace = true
license.workspace = true
repository.workspace = true

[dependencies]
coven-transport = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
semver = { workspace = true }

[dev-dependencies]
tokio = { version = "1.44", features = ["rt-multi-thread", "macros"] }
```

There is deliberately no `uniffi` dependency. The UniFFI surface belongs to each application's own FFI crate, which is what keeps this crate consumable by a CLI or a Tauri host.

- [ ] **Step 3: Create the crate root**

Create `crates/cave-core/src/lib.rs`:

```rust
//! Typed contract for the Coven Cave `/api/client/v1` surface.
//!
//! Cave is the sole authority for canonical conversations, familiars, and
//! every privileged mutation. This crate models what Cave says, and nothing
//! about how a particular application chooses to display or store it.
//!
//! Deliberately free of UniFFI derives and platform types, so a Swift app, a
//! Tauri host, and a CLI can all consume it. Each application's FFI layer
//! converts at its own boundary.

#![deny(missing_docs)]
```

- [ ] **Step 4: Verify the workspace builds**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo build --workspace`

Expected: `Finished` with no errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add Cargo.toml Cargo.lock crates/cave-core/
git commit -S -m "Add cave-core crate skeleton

No uniffi dependency: the FFI surface belongs to each application's own crate,
which keeps cave-core consumable by non-Swift callers."
```

---

## Task 7: The Error Envelope

Every Cave response is either `{"ok": true, ...}` or `{"ok": false, "error": {...}}`. Getting this wrong means every other parser has to guess.

**Files:**
- Create: `crates/cave-core/src/error.rs`
- Modify: `crates/cave-core/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/cave-core/src/error.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize, PartialEq)]
    struct Payload {
        value: u32,
    }

    #[test]
    fn parses_a_successful_envelope() {
        let body = r#"{"ok":true,"value":42}"#;
        let parsed: Payload = parse_envelope(body).expect("expected success");
        assert_eq!(parsed, Payload { value: 42 });
    }

    #[test]
    fn parses_an_error_envelope() {
        let body = r#"{"ok":false,"error":{"code":"unauthorized","message":"Not authorized.","retryable":false}}"#;
        match parse_envelope::<Payload>(body) {
            Err(CaveError::Api(envelope)) => {
                assert_eq!(envelope.code, "unauthorized");
                assert_eq!(envelope.message, "Not authorized.");
                assert!(!envelope.retryable);
            }
            other => panic!("expected an API error, got {other:?}"),
        }
    }

    #[test]
    fn treats_a_missing_ok_flag_as_malformed() {
        match parse_envelope::<Payload>(r#"{"value":42}"#) {
            Err(CaveError::Malformed(_)) => {}
            other => panic!("expected Malformed, got {other:?}"),
        }
    }

    #[test]
    fn treats_unparseable_json_as_malformed() {
        match parse_envelope::<Payload>("not json at all") {
            Err(CaveError::Malformed(_)) => {}
            other => panic!("expected Malformed, got {other:?}"),
        }
    }

    #[test]
    fn does_not_invent_success_when_the_payload_is_wrong_shape() {
        // ok:true but the payload does not match: this is an error, never a
        // default-constructed value.
        match parse_envelope::<Payload>(r#"{"ok":true,"value":"not a number"}"#) {
            Err(CaveError::Malformed(_)) => {}
            other => panic!("expected Malformed, got {other:?}"),
        }
    }

    #[test]
    fn retains_optional_error_details() {
        let body = r#"{"ok":false,"error":{"code":"invalid","message":"Bad.","retryable":true,"details":{"field":"title"}}}"#;
        match parse_envelope::<Payload>(body) {
            Err(CaveError::Api(envelope)) => {
                assert!(envelope.retryable);
                let details = envelope.details.expect("expected details");
                assert_eq!(details.get("field").and_then(|v| v.as_str()), Some("title"));
            }
            other => panic!("expected an API error, got {other:?}"),
        }
    }
}
```

Add to `src/lib.rs`:

```rust
mod error;

pub use error::{parse_envelope, CaveError, ErrorEnvelope};
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p cave-core`

Expected: FAIL to compile with `cannot find function 'parse_envelope' in this scope`.

- [ ] **Step 3: Write the implementation**

Prepend to `crates/cave-core/src/error.rs`:

```rust
//! Cave's stable error envelope, and the success/failure discrimination that
//! every response goes through.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

/// A machine-readable error from Cave.
///
/// Note: `PartialEq` but not `Eq`, because `details` holds a
/// `serde_json::Value`, which does not implement `Eq`.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
pub struct ErrorEnvelope {
    /// Stable machine-readable code, safe to branch on.
    pub code: String,
    /// User-safe message. Never contains secrets.
    pub message: String,
    /// Whether retrying the same request could succeed.
    #[serde(default)]
    pub retryable: bool,
    /// Optional structured detail, typically field-level validation errors.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

/// Why a Cave response could not be turned into a value.
#[derive(Debug)]
pub enum CaveError {
    /// Cave answered with a well-formed error envelope.
    Api(ErrorEnvelope),
    /// The response did not match the v1 contract at all.
    ///
    /// This is never softened into a default value. A malformed response from
    /// an authority is a real failure, and presenting it as empty success
    /// would hide the problem behind a plausible-looking empty screen.
    Malformed(String),
}

impl std::fmt::Display for CaveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Api(envelope) => write!(f, "{}: {}", envelope.code, envelope.message),
            Self::Malformed(detail) => write!(f, "malformed response: {detail}"),
        }
    }
}

impl std::error::Error for CaveError {}

/// Split a Cave response body into a typed payload or a typed error.
pub fn parse_envelope<T: DeserializeOwned>(body: &str) -> Result<T, CaveError> {
    let value: serde_json::Value = serde_json::from_str(body)
        .map_err(|e| CaveError::Malformed(format!("response was not JSON: {e}")))?;

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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p cave-core`

Expected: PASS, `6 passed`.

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add crates/cave-core/src/error.rs crates/cave-core/src/lib.rs
git commit -S -m "Add Cave error envelope parsing to cave-core

A malformed authority response stays an error rather than being softened into
an empty success, which would hide the failure behind a plausible empty screen."
```

---

## Task 8: Health and Compatibility Negotiation

The client must refuse to guess at an API it does not understand.

**Files:**
- Create: `crates/cave-core/src/health.rs`
- Modify: `crates/cave-core/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/cave-core/src/health.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse_envelope;

    const HEALTH: &str = r#"{
      "ok": true,
      "service": "coven-cave",
      "apiVersion": "1.0",
      "minimumClientVersion": "0.1.0",
      "instanceId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      "pairingRequired": true,
      "capabilities": ["canonical-conversations","resumable-sse","attachments"]
    }"#;

    fn health() -> Health {
        parse_envelope::<Health>(HEALTH).expect("fixture health parses")
    }

    #[test]
    fn parses_the_health_payload() {
        let health = health();
        assert_eq!(health.service, "coven-cave");
        assert_eq!(health.api_version, "1.0");
        assert_eq!(health.instance_id, "dddddddd-dddd-4ddd-8ddd-dddddddddddd");
        assert!(health.pairing_required);
        assert!(health.supports("resumable-sse"));
        assert!(!health.supports("time-travel"));
    }

    #[test]
    fn a_matching_major_with_a_new_enough_client_is_compatible() {
        assert_eq!(negotiate(&health(), "1.0.0", 1), Compatibility::Compatible);
    }

    #[test]
    fn a_client_below_the_minimum_is_too_old() {
        match negotiate(&health(), "0.0.9", 1) {
            Compatibility::ClientTooOld { minimum } => assert_eq!(minimum, "0.1.0"),
            other => panic!("expected ClientTooOld, got {other:?}"),
        }
    }

    #[test]
    fn a_different_api_major_is_unsupported() {
        let mut health = health();
        health.api_version = "2.0".to_string();
        match negotiate(&health, "1.0.0", 1) {
            Compatibility::UnsupportedApiMajor { reported, supported } => {
                assert_eq!(reported, "2.0");
                assert_eq!(supported, 1);
            }
            other => panic!("expected UnsupportedApiMajor, got {other:?}"),
        }
    }

    #[test]
    fn an_unparseable_api_version_is_unsupported_not_assumed_compatible() {
        let mut health = health();
        health.api_version = "banana".to_string();
        assert!(matches!(
            negotiate(&health, "1.0.0", 1),
            Compatibility::UnsupportedApiMajor { .. }
        ));
    }

    #[test]
    fn a_newer_minor_on_the_same_major_stays_compatible() {
        let mut health = health();
        health.api_version = "1.7".to_string();
        assert_eq!(negotiate(&health, "1.0.0", 1), Compatibility::Compatible);
    }
}
```

Add to `src/lib.rs`:

```rust
mod health;

pub use health::{negotiate, Compatibility, Health};
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p cave-core health`

Expected: FAIL to compile with `cannot find type 'Health' in this scope`.

- [ ] **Step 3: Write the implementation**

Prepend to `crates/cave-core/src/health.rs`:

```rust
//! Cave's identity, capabilities, and version negotiation.

use serde::Deserialize;

/// What Cave reports about itself at `/api/client/v1/health`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    /// Service identity, expected to be `coven-cave`.
    pub service: String,
    /// API version as `major.minor`.
    pub api_version: String,
    /// Oldest client semver this instance will serve.
    pub minimum_client_version: String,
    /// Stable identifier for this Cave instance.
    pub instance_id: String,
    /// Whether a client must pair before authenticated calls.
    pub pairing_required: bool,
    /// Advertised optional capabilities.
    #[serde(default)]
    pub capabilities: Vec<String>,
}

impl Health {
    /// Whether Cave advertises a named capability.
    ///
    /// Optional UI gates on this rather than on version numbers, so a Cave
    /// that gains a feature within v1 is usable without a client release.
    pub fn supports(&self, capability: &str) -> bool {
        self.capabilities.iter().any(|c| c == capability)
    }
}

/// The outcome of comparing a client against a Cave instance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Compatibility {
    /// Same API major, and the client is new enough.
    Compatible,
    /// Cave requires a newer client than this one.
    ClientTooOld {
        /// The minimum semver Cave will serve.
        minimum: String,
    },
    /// Cave speaks an API major this client does not implement.
    UnsupportedApiMajor {
        /// What Cave reported.
        reported: String,
        /// What this client implements.
        supported: u32,
    },
}

/// Decide whether this client can talk to this Cave.
///
/// Fails closed: an API version that cannot be parsed is treated as
/// unsupported rather than optimistically accepted, because best-effort
/// parsing of an unknown contract is how clients corrupt canonical state.
pub fn negotiate(health: &Health, client_version: &str, supported_major: u32) -> Compatibility {
    let reported_major = health
        .api_version
        .split('.')
        .next()
        .and_then(|major| major.parse::<u32>().ok());

    match reported_major {
        Some(major) if major == supported_major => {}
        _ => {
            return Compatibility::UnsupportedApiMajor {
                reported: health.api_version.clone(),
                supported: supported_major,
            };
        }
    }

    let client = semver::Version::parse(client_version).ok();
    let minimum = semver::Version::parse(&health.minimum_client_version).ok();
    match (client, minimum) {
        (Some(client), Some(minimum)) if client < minimum => Compatibility::ClientTooOld {
            minimum: health.minimum_client_version.clone(),
        },
        // An unparseable version on either side is not a reason to refuse
        // service; the API major already matched, which is the load-bearing
        // check.
        _ => Compatibility::Compatible,
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p cave-core`

Expected: PASS, `12 passed`.

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add crates/cave-core/src/health.rs crates/cave-core/src/lib.rs
git commit -S -m "Add health parsing and compatibility negotiation to cave-core

An unparseable API version is treated as unsupported rather than optimistically
accepted. Optional features gate on advertised capabilities, not versions."
```

---

## Task 9: Roster, Projects, and Credentials

**Files:**
- Create: `crates/cave-core/src/roster.rs`
- Create: `crates/cave-core/src/credentials.rs`
- Modify: `crates/cave-core/src/lib.rs`

- [ ] **Step 1: Write the failing tests**

Create `crates/cave-core/src/roster.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse_envelope;

    #[test]
    fn parses_the_familiar_roster() {
        let body = r#"{"ok":true,"familiars":[{"id":"charm","displayName":"Charm","role":"Companion","description":"Keeps the contract honest.","pronouns":"she/her","status":"online","emoji":"x"}]}"#;
        let roster: FamiliarRoster = parse_envelope(body).expect("roster parses");
        let familiar = &roster.familiars[0];
        assert_eq!(familiar.id, "charm");
        assert_eq!(familiar.display_name, "Charm");
        assert_eq!(familiar.pronouns.as_deref(), Some("she/her"));
        assert_eq!(familiar.status, "online");
    }

    #[test]
    fn tolerates_a_familiar_without_optional_fields() {
        let body = r#"{"ok":true,"familiars":[{"id":"x","displayName":"X","status":"offline"}]}"#;
        let roster: FamiliarRoster = parse_envelope(body).expect("roster parses");
        assert_eq!(roster.familiars[0].pronouns, None);
        assert_eq!(roster.familiars[0].emoji, None);
    }

    #[test]
    fn parses_the_project_list() {
        let body = r#"{"ok":true,"projects":[{"id":"project-alpha","name":"Project Alpha","root":"/workspace/project-alpha","access":"write","repoUrl":"https://github.com/OpenCoven/example"}]}"#;
        let projects: ProjectList = parse_envelope(body).expect("projects parse");
        assert_eq!(projects.projects[0].id, "project-alpha");
        assert_eq!(projects.projects[0].access, "write");
    }
}
```

Create `crates/cave-core/src/credentials.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse_envelope;

    #[test]
    fn parses_paired_credentials() {
        let body = r#"{"ok":true,"credentials":[{"id":"b1","appName":"OpenCoven Chat","installationId":"a1","scopes":["chat:read","chat:write"],"createdAt":1723241600000,"lastUsedAt":null,"revokedAt":null}]}"#;
        let list: CredentialList = parse_envelope(body).expect("credentials parse");
        let credential = &list.credentials[0];
        assert_eq!(credential.app_name, "OpenCoven Chat");
        assert!(credential.scopes.iter().any(|s| s == "chat:write"));
        assert_eq!(credential.last_used_at, None);
        assert!(!credential.is_revoked());
    }

    #[test]
    fn a_revoked_credential_reports_itself_revoked() {
        let body = r#"{"ok":true,"credentials":[{"id":"b1","appName":"X","installationId":"a1","scopes":[],"createdAt":1,"lastUsedAt":2,"revokedAt":3}]}"#;
        let list: CredentialList = parse_envelope(body).expect("credentials parse");
        assert!(list.credentials[0].is_revoked());
    }
}
```

Add to `src/lib.rs`:

```rust
mod credentials;
mod roster;

pub use credentials::{Credential, CredentialList};
pub use roster::{Familiar, FamiliarRoster, Project, ProjectList};
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p cave-core`

Expected: FAIL to compile with `cannot find type 'FamiliarRoster'` and `cannot find type 'CredentialList'`.

- [ ] **Step 3: Write the roster implementation**

Prepend to `crates/cave-core/src/roster.rs`:

```rust
//! Familiars and the projects they may act in.

use serde::Deserialize;

/// One familiar as Cave projects it.
///
/// Identity is contract-bearing: a conversation always belongs to a specific
/// familiar, and a client must never render a turn as coming from a generic
/// assistant when Cave named one.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Familiar {
    /// Stable identifier.
    pub id: String,
    /// Name shown to the user.
    pub display_name: String,
    /// Short persona label, if Cave supplies one.
    #[serde(default)]
    pub role: Option<String>,
    /// Longer description for roster UI.
    #[serde(default)]
    pub description: Option<String>,
    /// The familiar's pronouns, if declared.
    #[serde(default)]
    pub pronouns: Option<String>,
    /// Availability as Cave reports it.
    pub status: String,
    /// Compact visual marker.
    #[serde(default)]
    pub emoji: Option<String>,
}

/// The `familiars` response body.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct FamiliarRoster {
    /// Every familiar this credential may address.
    pub familiars: Vec<Familiar>,
}

/// A project a familiar may be granted access to.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    /// Stable identifier.
    pub id: String,
    /// Name shown to the user.
    pub name: String,
    /// Filesystem root on the Cave host.
    pub root: String,
    /// Granted access level, as Cave decided it.
    pub access: String,
    /// Associated repository, if any.
    #[serde(default)]
    pub repo_url: Option<String>,
}

/// The `projects` response body.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ProjectList {
    /// Every project available to this credential.
    pub projects: Vec<Project>,
}
```

- [ ] **Step 4: Write the credentials implementation**

Prepend to `crates/cave-core/src/credentials.rs`:

```rust
//! Paired client credentials, as Cave reports them.

use serde::Deserialize;

/// One paired client. Cave never returns the bearer itself, only metadata.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Credential {
    /// Stable identifier, used to revoke.
    pub id: String,
    /// Application name shown on the approval and management surfaces.
    pub app_name: String,
    /// Per-installation identity, so two devices are distinguishable.
    pub installation_id: String,
    /// Granted scopes, least-privilege.
    #[serde(default)]
    pub scopes: Vec<String>,
    /// Creation time, epoch milliseconds.
    pub created_at: i64,
    /// Last authenticated use, epoch milliseconds.
    #[serde(default)]
    pub last_used_at: Option<i64>,
    /// Revocation time, epoch milliseconds.
    #[serde(default)]
    pub revoked_at: Option<i64>,
}

impl Credential {
    /// Whether this credential has been revoked.
    pub fn is_revoked(&self) -> bool {
        self.revoked_at.is_some()
    }

    /// Whether this credential carries a named scope.
    pub fn has_scope(&self, scope: &str) -> bool {
        self.scopes.iter().any(|s| s == scope)
    }
}

/// The `credentials` response body.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct CredentialList {
    /// Every credential paired with this Cave instance.
    pub credentials: Vec<Credential>,
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p cave-core`

Expected: PASS, `17 passed`.

- [ ] **Step 6: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add crates/cave-core/src/roster.rs crates/cave-core/src/credentials.rs crates/cave-core/src/lib.rs
git commit -S -m "Add familiar roster, projects, and credentials to cave-core

Optional familiar fields stay optional so a sparse roster row parses rather
than failing the whole response."
```

---

## Task 10: Conversations, Pagination, and Revision Ordering

Revision ordering is the rule that stops a slow response from overwriting fresher state. It belongs here, in one place, rather than in every view.

**Files:**
- Create: `crates/cave-core/src/conversations.rs`
- Modify: `crates/cave-core/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/cave-core/src/conversations.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse_envelope;

    const PAGE: &str = r#"{
      "ok": true,
      "items": [{
        "id":"fixture-conversation","familiarId":"charm","title":"Lock the client contract",
        "preview":"The Cave client contract is locked and documented.",
        "projectId":null,"projectRoot":null,"status":"idle","pinned":false,"archivedAt":null,
        "createdAt":"2026-08-11T00:00:00.000Z","updatedAt":"2026-08-11T00:00:05.000Z",
        "revision":"a7c115d3","revisionTime":1786406405000
      }],
      "nextCursor": null,
      "degraded": false
    }"#;

    #[test]
    fn parses_a_conversation_page() {
        let page: Page<ConversationSummary> = parse_envelope(PAGE).expect("page parses");
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].familiar_id, "charm");
        assert_eq!(page.items[0].revision_time, 1786406405000);
        assert_eq!(page.next_cursor, None);
        assert!(!page.degraded);
    }

    #[test]
    fn parses_a_conversation_with_messages_and_attachments() {
        let body = r#"{
          "ok": true,
          "conversation": {
            "id":"c1","familiarId":"charm","title":"T","preview":"P",
            "projectId":null,"projectRoot":null,"status":"idle","pinned":false,"archivedAt":null,
            "createdAt":"2026-08-11T00:00:00.000Z","updatedAt":"2026-08-11T00:00:05.000Z",
            "revision":"r1","revisionTime":1
          },
          "messages": [
            {"id":"turn-1","role":"user","text":"Hello.","createdAt":"2026-08-11T00:00:01.000Z",
             "attachments":[{"id":"a1","name":"brief.txt","mimeType":"text/plain","sizeBytes":27}]},
            {"id":"turn-2","role":"assistant","text":"Hi.","createdAt":"2026-08-11T00:00:02.000Z","attachments":[]}
          ]
        }"#;
        let detail: ConversationDetail = parse_envelope(body).expect("detail parses");
        assert_eq!(detail.messages.len(), 2);
        assert_eq!(detail.messages[0].attachments[0].size_bytes, 27);
        assert_eq!(detail.messages[1].role, "assistant");
        assert!(detail.messages[1].attachments.is_empty());
    }

    fn at(revision: &str, time: i64) -> (String, i64) {
        (revision.to_string(), time)
    }

    #[test]
    fn a_newer_revision_time_is_newer() {
        let (known_rev, known_time) = at("r1", 100);
        let (new_rev, new_time) = at("r2", 200);
        assert_eq!(
            compare_revision(&new_rev, new_time, &known_rev, known_time),
            RevisionOrder::Newer
        );
    }

    #[test]
    fn an_older_revision_time_is_older() {
        let (known_rev, known_time) = at("r2", 200);
        let (stale_rev, stale_time) = at("r1", 100);
        assert_eq!(
            compare_revision(&stale_rev, stale_time, &known_rev, known_time),
            RevisionOrder::Older
        );
    }

    #[test]
    fn an_identical_revision_is_same_even_at_a_different_time() {
        // Clock skew must not make an identical revision look newer.
        assert_eq!(
            compare_revision("r1", 500, "r1", 100),
            RevisionOrder::Same
        );
    }

    #[test]
    fn equal_times_with_different_revisions_are_not_silently_accepted() {
        // Cannot order these; treat as Same so the known value is kept rather
        // than overwritten by a coin flip.
        assert_eq!(
            compare_revision("r2", 100, "r1", 100),
            RevisionOrder::Same
        );
    }
}
```

Add to `src/lib.rs`:

```rust
mod conversations;

pub use conversations::{
    compare_revision, Attachment, ConversationDetail, ConversationSummary, Message, Page,
    RevisionOrder,
};
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p cave-core conversations`

Expected: FAIL to compile with `cannot find type 'Page' in this scope`.

- [ ] **Step 3: Write the implementation**

Prepend to `crates/cave-core/src/conversations.rs`:

```rust
//! Conversations, their transcripts, and the ordering rule that protects them.

use serde::Deserialize;

/// One page of results.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Page<T> {
    /// This page's rows.
    pub items: Vec<T>,
    /// Opaque cursor for the next page, or `None` at the end.
    #[serde(default)]
    pub next_cursor: Option<String>,
    /// Whether Cave served this page from a degraded path and it may be
    /// incomplete.
    #[serde(default)]
    pub degraded: bool,
}

/// A conversation as it appears in a list.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    /// Stable identifier.
    pub id: String,
    /// The familiar this conversation belongs to. Never absent.
    pub familiar_id: String,
    /// Display title.
    pub title: String,
    /// Short preview of the latest turn.
    pub preview: String,
    /// Project context, if any.
    #[serde(default)]
    pub project_id: Option<String>,
    /// Project root on the Cave host, if any.
    #[serde(default)]
    pub project_root: Option<String>,
    /// Run status as Cave reports it.
    pub status: String,
    /// Whether the user pinned this conversation.
    #[serde(default)]
    pub pinned: bool,
    /// Archive time, if archived.
    #[serde(default)]
    pub archived_at: Option<String>,
    /// Creation timestamp, ISO 8601.
    pub created_at: String,
    /// Last update timestamp, ISO 8601.
    pub updated_at: String,
    /// Opaque server revision for this row.
    pub revision: String,
    /// Revision time, epoch milliseconds, used for ordering.
    pub revision_time: i64,
}

/// One attachment on a message.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    /// Stable identifier.
    pub id: String,
    /// Original filename.
    pub name: String,
    /// MIME type as Cave validated it, not as the client guessed.
    pub mime_type: String,
    /// Size in bytes.
    pub size_bytes: u64,
}

/// One canonical turn.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Message {
    /// Stable identifier.
    pub id: String,
    /// Author role, typically `user` or `assistant`.
    pub role: String,
    /// Message body, which may carry rich markers parsed in a later phase.
    pub text: String,
    /// Creation timestamp, ISO 8601.
    pub created_at: String,
    /// Attachments on this turn.
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

/// A conversation together with its transcript.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct ConversationDetail {
    /// The conversation itself.
    pub conversation: ConversationSummary,
    /// Its canonical turns, oldest first.
    #[serde(default)]
    pub messages: Vec<Message>,
}

/// How one revision relates to another.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RevisionOrder {
    /// The candidate supersedes what is known.
    Newer,
    /// The candidate is the same, or cannot be ordered against what is known.
    Same,
    /// The candidate is stale and must not overwrite.
    Older,
}

/// Compare a candidate revision against a known one.
///
/// Identical revision strings are `Same` regardless of time, so clock skew
/// between Cave restarts cannot make a known value look stale. Equal times
/// with differing revisions are also `Same`: they cannot be ordered, and
/// keeping what is already known beats overwriting on a coin flip.
pub fn compare_revision(
    candidate_revision: &str,
    candidate_time: i64,
    known_revision: &str,
    known_time: i64,
) -> RevisionOrder {
    if candidate_revision == known_revision {
        return RevisionOrder::Same;
    }
    match candidate_time.cmp(&known_time) {
        std::cmp::Ordering::Greater => RevisionOrder::Newer,
        std::cmp::Ordering::Less => RevisionOrder::Older,
        std::cmp::Ordering::Equal => RevisionOrder::Same,
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p cave-core`

Expected: PASS, `23 passed`.

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add crates/cave-core/src/conversations.rs crates/cave-core/src/lib.rs
git commit -S -m "Add conversations, pagination, and revision ordering to cave-core

Identical revisions compare Same regardless of timestamp so clock skew cannot
make known state look stale, and unorderable pairs keep what is known."
```

---

## Task 11: Typed Stream Events

Unknown event types must be ignored safely rather than failing the stream, because Cave may gain event types within v1.

**Files:**
- Create: `crates/cave-core/src/stream.rs`
- Modify: `crates/cave-core/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/cave-core/src/stream.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    fn frame(json: &str) -> StreamFrame {
        serde_json::from_str(json).expect("frame parses")
    }

    #[test]
    fn parses_run_started() {
        let f = frame(r#"{"id":1,"data":{"type":"run.started","runId":"r1","conversationId":"c1"}}"#);
        assert_eq!(f.id, 1);
        match f.data {
            StreamEvent::RunStarted { run_id, conversation_id } => {
                assert_eq!(run_id, "r1");
                assert_eq!(conversation_id, "c1");
            }
            other => panic!("expected RunStarted, got {other:?}"),
        }
    }

    #[test]
    fn parses_message_delta() {
        let f = frame(r#"{"id":2,"data":{"type":"message.delta","text":"Contract "}}"#);
        assert!(matches!(f.data, StreamEvent::MessageDelta { text } if text == "Contract "));
    }

    #[test]
    fn parses_progress_with_optional_detail() {
        let f = frame(r#"{"id":4,"data":{"type":"progress","id":"p1","label":"Pairing approved","detail":"Waiting.","status":"running"}}"#);
        match f.data {
            StreamEvent::Progress { id, label, detail, status } => {
                assert_eq!(id, "p1");
                assert_eq!(label, "Pairing approved");
                assert_eq!(detail.as_deref(), Some("Waiting."));
                assert_eq!(status, "running");
            }
            other => panic!("expected Progress, got {other:?}"),
        }
    }

    #[test]
    fn parses_a_tool_event() {
        let f = frame(r#"{"id":5,"data":{"type":"tool","payload":{"id":"t1","name":"shell","input":{"command":"pnpm test:api"},"output":{"exitCode":0},"status":"completed","durationMs":1200}}}"#);
        match f.data {
            StreamEvent::Tool { payload } => {
                assert_eq!(payload.name, "shell");
                assert_eq!(payload.status, "completed");
                assert_eq!(payload.duration_ms, Some(1200));
            }
            other => panic!("expected Tool, got {other:?}"),
        }
    }

    #[test]
    fn parses_terminal_events() {
        let completed = frame(r#"{"id":6,"data":{"type":"run.completed","conversationId":"c1"}}"#);
        assert!(matches!(completed.data, StreamEvent::RunCompleted { .. }));

        let reconcile = frame(r#"{"id":7,"data":{"type":"reconcile_required","conversationId":"c1"}}"#);
        assert!(matches!(reconcile.data, StreamEvent::ReconcileRequired { .. }));

        let failed = frame(r#"{"id":8,"data":{"type":"run.failed","code":"service_unavailable","message":"The run failed."}}"#);
        match failed.data {
            StreamEvent::RunFailed { code, message } => {
                assert_eq!(code, "service_unavailable");
                assert_eq!(message, "The run failed.");
            }
            other => panic!("expected RunFailed, got {other:?}"),
        }
    }

    #[test]
    fn an_unknown_event_type_parses_as_unknown_rather_than_failing() {
        // Cave may add event types within v1. A client that errors here would
        // break on a server upgrade it should have tolerated.
        let f = frame(r#"{"id":9,"data":{"type":"telepathy.received","payload":{"whatever":true}}}"#);
        assert!(matches!(f.data, StreamEvent::Unknown));
    }

    #[test]
    fn a_frame_without_an_id_is_rejected() {
        // Event IDs are the resume cursor. A frame without one is unusable.
        let result: Result<StreamFrame, _> =
            serde_json::from_str(r#"{"data":{"type":"message.delta","text":"x"}}"#);
        assert!(result.is_err());
    }
}
```

Add to `src/lib.rs`:

```rust
mod stream;

pub use stream::{StreamEvent, StreamFrame, ToolPayload};
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p cave-core stream`

Expected: FAIL to compile with `cannot find type 'StreamFrame' in this scope`.

- [ ] **Step 3: Write the implementation**

Prepend to `crates/cave-core/src/stream.rs`:

```rust
//! Typed Server-Sent Events from a Cave run.
//!
//! Reduction, cursor checkpointing, and reconciliation are not here. This
//! module only turns bytes into typed events; behavior over time arrives in a
//! later phase.

use serde::Deserialize;

/// One SSE frame: a monotonic identifier and its payload.
///
/// The identifier is the resume cursor, so it is required. A frame without one
/// cannot participate in replay and is rejected rather than accepted blindly.
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct StreamFrame {
    /// Monotonic event identifier, used to resume after a disconnect.
    pub id: u64,
    /// The typed payload.
    pub data: StreamEvent,
}

/// Detail for a tool invocation.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolPayload {
    /// Stable identifier for this invocation.
    pub id: String,
    /// Tool name.
    pub name: String,
    /// Input as Cave recorded it.
    #[serde(default)]
    pub input: serde_json::Value,
    /// Output as Cave recorded it.
    #[serde(default)]
    pub output: serde_json::Value,
    /// Lifecycle status.
    pub status: String,
    /// Duration in milliseconds, when the invocation has finished.
    #[serde(default)]
    pub duration_ms: Option<u64>,
}

/// One typed event from a run.
///
/// The `Unknown` variant is load-bearing: Cave may add event types within v1,
/// and a client that failed the whole stream on an unrecognized type would
/// break on a server upgrade it was supposed to tolerate.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type")]
pub enum StreamEvent {
    /// A run began.
    #[serde(rename = "run.started", rename_all = "camelCase")]
    RunStarted {
        /// Identifier for this run.
        run_id: String,
        /// The conversation it belongs to.
        conversation_id: String,
    },
    /// Incremental assistant text.
    #[serde(rename = "message.delta")]
    MessageDelta {
        /// The text fragment to append.
        text: String,
    },
    /// A named progress step.
    #[serde(rename = "progress")]
    Progress {
        /// Stable identifier for the step.
        id: String,
        /// Short label.
        label: String,
        /// Optional longer detail.
        #[serde(default)]
        detail: Option<String>,
        /// Lifecycle status.
        status: String,
    },
    /// A tool invocation update.
    #[serde(rename = "tool")]
    Tool {
        /// Invocation detail.
        payload: ToolPayload,
    },
    /// The run finished normally.
    #[serde(rename = "run.completed", rename_all = "camelCase")]
    RunCompleted {
        /// The conversation that completed.
        conversation_id: String,
    },
    /// Replay is unavailable or gapped; the client must reload canonical state.
    #[serde(rename = "reconcile_required", rename_all = "camelCase")]
    ReconcileRequired {
        /// The conversation to reconcile.
        conversation_id: String,
    },
    /// The run failed.
    #[serde(rename = "run.failed")]
    RunFailed {
        /// Machine-readable code.
        code: String,
        /// User-safe message.
        message: String,
    },
    /// An event type this client does not implement. Ignored safely.
    #[serde(other)]
    Unknown,
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p cave-core`

Expected: PASS, `30 passed`.

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add crates/cave-core/src/stream.rs crates/cave-core/src/lib.rs
git commit -S -m "Add typed Cave stream events to cave-core

Unknown event types parse as Unknown rather than failing the stream, so a Cave
that gains events within v1 does not break existing clients."
```

---

## Task 12: Vendor the Contract Fixture

The fixture is generated by Cave's exporter under bead `cave-g6x6k`. Operating rule 6 forbids hand-editing a copied fixture, so the copy is checksummed and the refresh path is documented.

**Files:**
- Create: `crates/cave-core/tests/fixtures/contract-fixture.json`
- Create: `crates/cave-core/tests/fixtures/contract-fixture.sha256`
- Create: `crates/cave-core/tests/fixtures/README.md`

- [ ] **Step 1: Locate the canonical fixture**

```bash
find /Users/buns/Documents/GitHub/OpenCoven/coven-cave -name "contract-fixture.json" -not -path "*/node_modules/*" 2>/dev/null
find /Users/buns/Documents/GitHub/OpenCoven/chat -name "contract-fixture.json" -not -path "*/node_modules/*" 2>/dev/null
```

Expected: at least one path. As of 2026-08-16 a copy exists at `/Users/buns/Documents/GitHub/OpenCoven/chat/.worktrees/opencoven-chat/src/lib/cave-api/contract-fixture.json`.

**If Cave's exporter exists**, generate from it rather than copying a copy, and record the exact command in the README from Step 4.

**If no fixture is found at all**, stop. `cave-core`'s conformance gate cannot be met without it, and hand-authoring one would defeat its purpose. Report that Phase B is blocked on `cave-g6x6k`.

- [ ] **Step 2: Vendor it**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
mkdir -p crates/cave-core/tests/fixtures
cp <path-from-step-1> crates/cave-core/tests/fixtures/contract-fixture.json
```

- [ ] **Step 3: Record the checksum**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/crates/cave-core/tests/fixtures
shasum -a 256 contract-fixture.json | awk '{print $1}' > contract-fixture.sha256
cat contract-fixture.sha256
```

Expected: a 64-character hex digest.

- [ ] **Step 4: Document the refresh path**

Create `crates/cave-core/tests/fixtures/README.md`:

```markdown
# Vendored contract fixture

`contract-fixture.json` is a verbatim copy of the Cave client v1 contract
fixture produced by Cave's exporter under bead `cave-g6x6k`.

**Never hand-edit it.** Program operating rule 6: consumers must not edit
copied fixtures. If a test fails because the fixture disagrees with
`cave-core`, either the crate is wrong or the contract changed. Both are
resolved upstream, not by editing this file.

To refresh:

1. Regenerate from Cave's exporter.
2. Copy the output here, replacing the file wholesale.
3. Update `contract-fixture.sha256`:
   `shasum -a 256 contract-fixture.json | awk '{print $1}' > contract-fixture.sha256`
4. Run `cargo test -p cave-core` and fix `cave-core` to match the new contract.
5. Note the Cave commit the fixture came from in the commit message.
```

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add crates/cave-core/tests/fixtures/
git commit -S -m "Vendor the Cave v1 contract fixture with a checksum

Copied verbatim from the cave-g6x6k exporter output. Checksummed so drift is
detected rather than absorbed, and documented as never-hand-edit per program
operating rule 6."
```

---

## Task 13: Fixture Conformance

This is the phase gate for `cave-core`. Every fixture section must parse into the types built above.

**Files:**
- Create: `crates/cave-core/tests/conformance.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/cave-core/tests/conformance.rs`:

```rust
//! Conformance against the exported Cave v1 contract fixture.
//!
//! Every section of the fixture must parse into cave-core's types. A failure
//! here means the crate and the authority disagree, which is resolved by
//! changing the crate or the contract -- never by editing the fixture.

use cave_core::{
    negotiate, parse_envelope, Compatibility, ConversationDetail, ConversationSummary,
    CredentialList, FamiliarRoster, Health, Page, ProjectList, StreamEvent, StreamFrame,
};

const FIXTURE: &str = include_str!("fixtures/contract-fixture.json");
const EXPECTED_SHA256: &str = include_str!("fixtures/contract-fixture.sha256");

/// Pull one section's `body` out of the fixture and re-serialize it, so each
/// section is exercised through the same envelope parsing the client uses.
fn section(name: &str) -> String {
    let root: serde_json::Value = serde_json::from_str(FIXTURE).expect("fixture is valid JSON");
    let body = root
        .get(name)
        .and_then(|s| s.get("body"))
        .unwrap_or_else(|| panic!("fixture has no section '{name}' with a body"));
    serde_json::to_string(body).expect("section re-serializes")
}

#[test]
fn the_vendored_fixture_matches_its_recorded_checksum() {
    // Guards against a hand-edit, which operating rule 6 forbids.
    use std::process::Command;
    let output = Command::new("shasum")
        .args(["-a", "256", "tests/fixtures/contract-fixture.json"])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()
        .expect("shasum runs");
    let actual = String::from_utf8_lossy(&output.stdout);
    let actual = actual.split_whitespace().next().unwrap_or_default();
    assert_eq!(
        actual,
        EXPECTED_SHA256.trim(),
        "vendored fixture does not match its checksum; refresh it from the exporter rather than editing it"
    );
}

#[test]
fn health_conforms() {
    let health: Health = parse_envelope(&section("health")).expect("health parses");
    assert_eq!(health.service, "coven-cave");
    assert!(health.pairing_required);
    assert!(health.supports("canonical-conversations"));
    assert!(health.supports("resumable-sse"));
    assert_eq!(negotiate(&health, "1.0.0", 1), Compatibility::Compatible);
}

#[test]
fn the_error_envelope_conforms() {
    use cave_core::CaveError;
    match parse_envelope::<Health>(&section("error")) {
        Err(CaveError::Api(envelope)) => {
            assert_eq!(envelope.code, "unauthorized");
            assert!(!envelope.retryable);
        }
        other => panic!("expected an API error, got {other:?}"),
    }
}

#[test]
fn credentials_conform() {
    let list: CredentialList = parse_envelope(&section("credentials")).expect("credentials parse");
    assert!(!list.credentials.is_empty());
    assert!(list.credentials[0].has_scope("chat:write"));
    assert!(!list.credentials[0].is_revoked());
}

#[test]
fn the_familiar_roster_conforms() {
    let roster: FamiliarRoster = parse_envelope(&section("familiars")).expect("roster parses");
    assert!(!roster.familiars.is_empty());
    assert!(!roster.familiars[0].id.is_empty());
    assert!(!roster.familiars[0].display_name.is_empty());
}

#[test]
fn projects_conform() {
    let projects: ProjectList = parse_envelope(&section("projects")).expect("projects parse");
    assert!(!projects.projects.is_empty());
}

#[test]
fn the_conversation_page_conforms() {
    let page: Page<ConversationSummary> =
        parse_envelope(&section("conversations")).expect("page parses");
    assert!(!page.items.is_empty());
    // Familiar identity is contract-bearing and must never be blank.
    assert!(!page.items[0].familiar_id.is_empty());
    assert!(!page.items[0].revision.is_empty());
}

#[test]
fn the_conversation_detail_conforms() {
    let detail: ConversationDetail =
        parse_envelope(&section("conversation")).expect("detail parses");
    assert!(!detail.messages.is_empty());
    assert!(!detail.conversation.familiar_id.is_empty());
}

#[test]
fn every_fixture_stream_event_conforms() {
    let root: serde_json::Value = serde_json::from_str(FIXTURE).expect("fixture is valid JSON");
    let events = root
        .get("streamEvents")
        .expect("fixture has streamEvents");

    let success = events
        .get("success")
        .and_then(|v| v.as_array())
        .expect("streamEvents.success is an array");
    let parsed: Vec<StreamFrame> = success
        .iter()
        .map(|frame| serde_json::from_value(frame.clone()).expect("frame parses"))
        .collect();

    // Identifiers must be monotonic; they are the resume cursor.
    for pair in parsed.windows(2) {
        assert!(pair[1].id > pair[0].id, "stream ids must increase");
    }
    // No fixture event should land in Unknown -- that would mean cave-core is
    // missing a type the contract already ships.
    for frame in &parsed {
        assert!(
            !matches!(frame.data, StreamEvent::Unknown),
            "fixture event {} parsed as Unknown; cave-core is missing a type",
            frame.id
        );
    }

    for name in ["reconcileRequired", "runFailed"] {
        let frame = events.get(name).unwrap_or_else(|| panic!("missing {name}"));
        let frame: StreamFrame = serde_json::from_value(frame.clone()).expect("frame parses");
        assert!(!matches!(frame.data, StreamEvent::Unknown));
    }
}
```

- [ ] **Step 2: Run the conformance tests**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test -p cave-core --test conformance`

Expected: PASS, `9 passed`.

If a section fails, the crate and the contract disagree. Fix `cave-core` — do not edit the fixture and do not relax an assertion.

- [ ] **Step 3: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add crates/cave-core/tests/conformance.rs
git commit -S -m "Add cave-core conformance against the v1 contract fixture

Asserts every fixture section parses, stream ids are monotonic, and no shipped
event type lands in Unknown -- which would mean cave-core is missing a type."
```

---

## Task 14: Cross-Platform Compilation

The spec requires these crates to build for macOS, Linux, and Windows so a future desktop Tauri host can adopt them.

- [ ] **Step 1: Verify the host build**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
cargo build --workspace --all-targets
```

Expected: `Finished`.

- [ ] **Step 2: Verify the iOS targets**

```bash
rustup target add aarch64-apple-ios aarch64-apple-ios-sim
cargo check -p cave-core --target aarch64-apple-ios
cargo check -p coven-transport --target aarch64-apple-ios
cargo check -p cave-core --target aarch64-apple-ios-sim
cargo check -p coven-transport --target aarch64-apple-ios-sim
```

Expected: all four `Finished`. `ring` rather than `aws-lc-rs` was chosen in Task 3 precisely so this step does not require extra toolchain setup. If a `ring` build failure appears here, that is the tradeoff surfacing — record it and consult the rustls platform documentation before switching providers.

- [ ] **Step 3: Verify a non-Apple target compiles**

```bash
rustup target add x86_64-unknown-linux-gnu
cargo check --workspace --target x86_64-unknown-linux-gnu
```

Expected: `Finished`. On macOS this needs a cross-linker; if it is unavailable locally, note that CI covers Linux and Windows natively via the Task 16 matrix, and proceed.

- [ ] **Step 4: Commit if anything changed**

If Steps 1 through 3 required manifest adjustments:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add -A
git commit -S -m "Adjust dependencies for cross-platform builds"
```

If nothing changed, skip the commit.

---

## Task 15: Public Surface and Documentation

**Files:**
- Modify: `crates/cave-core/src/lib.rs`

- [ ] **Step 1: Write the crate documentation**

Replace the doc comment at the top of `crates/cave-core/src/lib.rs`, keeping the `mod` and `pub use` lines below it:

```rust
//! Typed contract for the Coven Cave `/api/client/v1` surface.
//!
//! Cave is the sole authority for canonical conversations, familiars, and
//! every privileged mutation. This crate models what Cave says and nothing
//! about how an application displays or stores it.
//!
//! # What lives here
//!
//! Contract types, envelope discrimination, compatibility negotiation,
//! revision ordering, and typed stream events.
//!
//! # What does not
//!
//! Stream reduction, cursor checkpointing, reconciliation, the outbox, and the
//! rich-content marker AST arrive in later phases. Storage, secrets, and UI
//! never live here.
//!
//! No UniFFI derives and no platform types, so a Swift app, a Tauri host, and
//! a CLI can all consume it. Each application's FFI layer converts at its own
//! boundary.
//!
//! # Failure posture
//!
//! Malformed authority responses stay errors. Nothing here substitutes a
//! default value for a response it could not understand, because an empty
//! screen that looks like success is worse than a visible failure.
//!
//! ```
//! use cave_core::{parse_envelope, Health, negotiate, Compatibility};
//!
//! let body = r#"{"ok":true,"service":"coven-cave","apiVersion":"1.0",
//!   "minimumClientVersion":"0.1.0","instanceId":"i1","pairingRequired":true,
//!   "capabilities":["resumable-sse"]}"#;
//! let health: Health = parse_envelope(body).expect("health parses");
//! assert!(health.supports("resumable-sse"));
//! assert_eq!(negotiate(&health, "1.0.0", 1), Compatibility::Compatible);
//! ```

#![deny(missing_docs)]
```

- [ ] **Step 2: Run the full suite including doc tests**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && cargo test --workspace`

Expected: PASS. `cave-core` reports `30 passed` for unit tests, `9 passed` for conformance, and `1 passed` for the doc test. `coven-transport` reports `23 passed`.

- [ ] **Step 3: Verify lints and formatting across the workspace**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
```

Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add crates/cave-core/src/lib.rs
git commit -S -m "Document cave-core's scope and failure posture"
```

---

## Task 16: CI Enforcement of the FFI and License Boundaries

Two invariants from the spec are review-proof only if CI checks them.

**Files:**
- Modify: `.github/workflows/rust.yml`

- [ ] **Step 1: Add the boundary job**

Append to `.github/workflows/rust.yml`, as a sibling of the existing `test` job:

```yaml
  boundaries:
    name: Dependency boundaries
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@1.95.0
      - uses: Swatinem/rust-cache@v2

      - name: Shared crates carry no UniFFI dependency
        run: |
          for crate in coven-transport cave-core; do
            if cargo tree -p "$crate" --edges normal | grep -qi '^\s*[|`-]*\s*uniffi'; then
              echo "FAIL: $crate depends on uniffi."
              echo "The FFI surface belongs to each application's own crate."
              exit 1
            fi
          done
          echo "OK: no uniffi dependency in the shared crates."

      - name: Shared crates carry no GPL dependency
        run: |
          cargo install cargo-deny --locked
          cargo deny check licenses
```

- [ ] **Step 2: Add the license policy**

Create `deny.toml` at the SDK root:

```toml
[licenses]
allow = [
  "MIT",
  "Apache-2.0",
  "Apache-2.0 WITH LLVM-exception",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "Unicode-3.0",
  "Zlib",
  "AGPL-3.0",
]
confidence-threshold = 0.9

# GPL is not listed above, deliberately. Chat for iOS targets the App Store,
# and Coven Pocket's licensing decision record shows GPL linkage blocks that
# channel. A GPL crate entering this graph is a release-blocking regression,
# not a style question.
```

- [ ] **Step 3: Run the checks locally**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
for crate in coven-transport cave-core; do
  cargo tree -p "$crate" --edges normal | grep -i uniffi && echo "FAIL: $crate" || echo "OK: $crate"
done
cargo install cargo-deny --locked
cargo deny check licenses
```

Expected: `OK: coven-transport`, `OK: cave-core`, and `cargo deny` reporting no license violations.

If `cargo deny` flags a transitive crate under a license that is genuinely fine but missing from the allow list, add it with a one-line comment explaining what pulled it in. Do not add GPL variants.

- [ ] **Step 4: Verify the workflow parses**

Run: `cd /Users/buns/Documents/GitHub/OpenCoven/sdk && python3 -c "import yaml; yaml.safe_load(open('.github/workflows/rust.yml')); print('valid')"`

Expected: `valid`.

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git add .github/workflows/rust.yml deny.toml
git commit -S -m "Enforce the FFI and license boundaries in CI

A uniffi dependency in a shared crate would quietly decide the desktop
migration question, and a GPL dependency would block App Store distribution.
Both are now build failures rather than review findings."
```

- [ ] **Step 6: Verify every Phase B commit is signed**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk
git log feat/ios-phase-a-transport..HEAD --pretty='%H %G?' | awk '$2 != "G" {print "UNSIGNED:", $0}'
```

Expected: no output.

---

## Phase B Completion

Phase B is done when:

- `coven-transport` reaches endpoints over plaintext or pinning-only TLS, races candidates deterministically, and remembers what worked per network.
- A mismatched certificate pin fails closed.
- `cave-core` types every v1 contract section, negotiates compatibility, orders revisions, and parses every stream event type.
- An unknown stream event parses as `Unknown` instead of failing the stream.
- The vendored fixture matches its checksum and every section conforms.
- Both crates build for the host, both iOS targets, and the CI matrix's Linux and Windows.
- CI fails on a UniFFI or GPL dependency in either shared crate.
- `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` are clean.
- Every commit is signed. Nothing is pushed.

**Not in this phase, by design:** stream reduction, cursor checkpointing, reconciliation, the outbox, the marker AST, pairing, credential storage, and any Swift. The differential harness is also absent, and stays absent until desktop Chat's TypeScript reducer exists.

## Handoff to Phase C

Phase C builds Cave's enrollment authority — the overlay probe, guided setup, reachability self-verification, QR payload generation, and push device registration — plus the doorbell relay. It consumes `Endpoint`, `Security`, and `Health` from this phase: the QR payload is precisely an ordered candidate list of `Endpoint` values plus the pin and a single-use grant.

Phase C is the first phase requiring changes in `coven-cave`, and the first to need an operator decision about deploying the relay.
