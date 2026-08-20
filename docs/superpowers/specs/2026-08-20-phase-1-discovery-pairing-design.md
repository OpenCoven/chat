# OpenCoven Chat Phase 1 Discovery and Pairing Design

**Status:** Approved design  
**Date:** 2026-08-20  
**Repositories:** `OpenCoven/coven-cave`, `OpenCoven/sdk`, `OpenCoven/chat`, `OpenCoven/coven`  
**Depends on:** Phase 0 gate `cave-bt9wx`  
**Plan of record to update:** `docs/superpowers/plans/2026-08-15-phase-1-discovery-pairing.md`

## Summary

Phase 1 turns the production desktop route from a scaffold into a secure local
client bootstrap. A fresh Chat installation discovers or starts Cave, verifies
compatibility, requests explicit approval, exchanges a single-use grant into
native keychain storage, reconnects after restart, and returns to pairing after
revocation.

Cave remains the authority. Chat's Rust host owns discovery, process launch,
credential storage, authenticated transport, and secret-bearing operations. The
webview owns only non-secret connection state and presentation.

The implementation uses dependency waves:

1. Cave authority and independent SDK Coven IPC work.
2. SDK Cave pairing and Chat native host work against a reviewed Cave contract.
3. Chat connection UI and real-authority conformance.

The user-approved desktop behavior is:

- a dedicated blocking connection gate before the production chat shell
- automatic launch of an installed Cave binary only after exact-path validation
- visible progress and explicit, retryable failure states
- no bearer or keychain value in JavaScript

## Goals

- Discover a running Cave through a validated owner-local discovery record.
- Start Cave automatically from an approved installed-binary candidate when it
  is not running.
- Negotiate health, API major compatibility, minimum client version, and
  capabilities before rendering the production chat shell.
- Require explicit Cave-side approval for a six-scope pairing request.
- Persist only credential hashes in Cave and only the bearer in the native OS
  keychain.
- Reconnect after Chat restart without pairing again.
- Detect revocation and return to pairing without exposing or silently deleting
  credentials after a single ambiguous failure.
- Provide transport-neutral Cave and Coven clients plus secret-free diagnostic
  CLI output.
- Prove the full flow against packaged SDK artifacts and a real isolated Cave.

## Non-Goals

- Canonical conversation reads, sends, streaming, or recovery; those begin after
  the Phase 1 gate.
- Remote Cave access, LAN binding, mDNS, relay, or overlay networking.
- Browser-owned credentials, localStorage persistence, or a plaintext fallback.
- Arbitrary URL, header, bearer, or generic fetch APIs in Chat or the SDK.
- Direct SDK reads of Cave or Coven internal databases and private files.
- Pairing to Coven. Coven health remains an independent same-user IPC concern.
- Replacing the query-only `?demo=chat` or `?demo=minimal` previews in this
  phase. The production route changes; demos remain fixture-driven until their
  later replacement.

## Approved Product Behavior

### Production route

The production route renders `ConnectionGate` until authenticated Cave health
succeeds. The chat shell is not mounted behind a translucent overlay and is not
available in a read-only mode during Phase 1.

The gate presents these states:

- locating Cave
- starting the verified installed Cave
- waiting for readiness with attempt and elapsed-time feedback
- awaiting approval in Cave
- pairing denied
- pairing expired
- incompatible Cave or client version
- revoked credential, returning to pairing
- unavailable with explicit diagnostics and retry
- connected, followed by entry into the production shell

Browser preview tests may inject a non-secret fake host. Browser preview must
never pretend to exercise the native credential path.

### Cave launch

Chat launches Cave automatically when discovery cannot find a valid live
instance. Launch uses an exact executable path from OS-specific installed
candidates. It never invokes a shell, searches arbitrary `PATH` entries, or
executes a path supplied by the discovery record.

If no approved candidate exists, Chat reports an actionable unavailable state.
It does not download, install, or modify Cave.

### Approval

Chat requests exactly:

- `chat:read`
- `chat:write`
- `conversations:write`
- `attachments:write`
- `tasks:write`
- `github:write`

Cave settings displays app identity, installation identity, scopes, creation
time, and expiry. Approval and denial remain authenticated Cave admin actions.
The Chat gate polls only the public pairing status endpoint while the request is
pending.

## Architecture

### Cave authority

Cave owns four server-side units:

1. **Pairing store** — process-local, bounded, five-minute records with
   SHA-256 secret hashes and single-use approved consumption.
2. **Credential store** — atomic owner-only persistence under Cave home with
   bearer hashes, app metadata, scopes, timestamps, and revocation state.
3. **Client auth and rate limits** — loopback-stamp validation, constant-time
   bearer verification, scope checks, bounded request buckets, and explicit
   revocation.
4. **Discovery publisher** — atomic mode-0600 discovery record written only
   after the listener is ready and removed only when its nonce still matches.

The public `/api/client/v1` surface contains health, pairing create/poll/exchange,
and later authenticated client methods. Admin pairing and credential routes stay
behind Cave's existing UI authentication and CSRF boundary.

Caller-supplied loopback markers are stripped. Only the direct local listener
may stamp a request as trusted loopback ingress. No `/api/chat/*` route becomes
public.

### SDK

`@opencoven/cave-client` provides:

- validated discovery profiles
- health and compatibility negotiation
- pairing create, poll, and exchange operations
- credential metadata and revocation-aware status
- a pluggable `SecretStore` contract
- constrained transport methods rather than `fetch(url)`

`@opencoven/coven-client` provides:

- `COVEN_HOME` and `coven config paths --json` discovery
- validated same-user Unix-socket and Windows named-pipe endpoints
- `coven.daemon.v1` health negotiation
- structured daemon error preservation

`@opencoven/dev-cli` provides stable secret-free forms of:

- `opencoven doctor [--json]`
- `opencoven discover [--json]`
- `opencoven cave pair|status|forget [--json]`
- `opencoven coven health [--json]`

Supported OS keychains are explicit adapters. Missing secure storage fails
closed. There is no plaintext file fallback.

### Chat native host

The Tauri host is split into focused modules:

- `discovery` validates the discovery file, ownership, permissions, version,
  endpoint, PID, freshness, and symlink behavior.
- `cave_process` selects and launches exact approved binaries without a shell.
- `keychain` owns installation ID and bearer read/write/delete operations.
- `transport` permits only reviewed `/api/client/v1` operations, disables
  redirects, enforces body/frame limits, and adds the bearer internally.
- `commands` exposes narrow typed non-secret commands to the webview.

The webview may receive:

- validated endpoint metadata
- health, compatibility, and capability metadata
- pairing request ID, status, and expiry
- non-secret credential presence and metadata
- normalized error codes and retryability

The webview may not receive:

- the Cave bearer
- raw keychain values
- credential hashes
- arbitrary headers
- generic request or fetch primitives

### Chat connection controller

The controller is an effectful orchestration layer over a pure reducer. Its
sequence is:

1. Discover Cave.
2. If absent, launch an approved installed candidate automatically.
3. Wait for the discovery record and health readiness.
4. Check API major and minimum client version.
5. Check native credential status.
6. Probe authenticated health when a credential exists.
7. On repeated `401`, delete the revoked credential and begin pairing.
8. Create and poll a pairing request.
9. Exchange approval; native code writes the bearer before returning metadata.
10. Confirm authenticated health and enter `connected`.

Readiness backoff is 250 ms, 500 ms, 1 s, 2 s, and 4 s, capped at 5 s, with a
30-second startup deadline. Jitter is deterministic under test.

Each run carries an attempt identity. Results from stale attempts are ignored.
Cancellation on unmount or retry prevents old asynchronous work from mutating
the current state.

## State Model

The reducer uses explicit discriminated states:

```ts
type ConnectionState =
  | { kind: "locating"; attemptId: number }
  | { kind: "starting"; attemptId: number; candidate: string }
  | { kind: "waiting"; attemptId: number; attempt: number; elapsedMs: number }
  | {
      kind: "pairing";
      attemptId: number;
      requestId: string;
      expiresAt: number;
      status: "pending" | "denied" | "expired";
    }
  | {
      kind: "connected";
      endpoint: string;
      health: Health;
      credential: CredentialMetadata;
    }
  | {
      kind: "incompatible";
      endpoint: string;
      minimumClientVersion: string;
      apiVersion: string;
    }
  | {
      kind: "unavailable";
      reason: string;
      retryable: boolean;
      diagnosticCode: string;
    };
```

Revocation is represented as an authenticated transition back into pairing,
not as a persistent terminal state. The gate announces the reason before the
new pairing request begins.

## Data and Secret Flow

### Fresh pairing

1. Chat Rust validates Cave discovery and health.
2. The webview asks Rust to create pairing through a named command.
3. Rust/SDK transport sends app identity, installation ID, and six scopes.
4. Cave returns request ID, pairing secret, and expiry.
5. Rust retains secret-bearing request metadata only for the active operation.
   JavaScript receives request ID, expiry, and non-secret status.
6. The user approves in Cave settings.
7. Rust exchanges the single-use approval.
8. Cave returns the bearer exactly once.
9. Rust writes the bearer to keychain before reporting success.
10. JavaScript receives only credential metadata and authenticated health.

### Restart

1. Chat validates discovery and health.
2. Rust finds credential metadata and reads the bearer internally.
3. Authenticated health succeeds.
4. The gate enters `connected` without creating a pairing request.

### Revocation

1. Cave revokes the persisted credential.
2. Chat receives authenticated `401` responses.
3. A single ambiguous `401` does not delete the credential.
4. Repeated confirmed `401` deletes the keychain entry.
5. Chat announces revocation and begins a new pairing request.

## Error Handling

Errors are normalized into stable, secret-free categories:

- discovery missing, malformed, stale, unsafe, wrong-owner, or wrong-mode
- launch candidate absent, rejected, exited, or timed out
- health unavailable, invalid, incompatible, or upgrade-required
- pairing pending, denied, expired, replayed, or rate-limited
- credential missing, revoked, secure-store-unavailable, or keychain failure
- transport timeout, abort, body limit, frame limit, redirect, or invalid origin

Error objects and JSON output contain no pairing secret, bearer, raw environment,
arbitrary filesystem contents, or keychain payload. Logs redact request headers
and secret-bearing response fields by construction rather than after capture.

No broad catch converts a failure into an unavailable success shape. Retriable
states expose retry; terminal incompatibility states expose required versions.

## Security Requirements

- Pairing secrets expire after five minutes and are single-use.
- Pairing and credential stores retain hashes, never raw issued secrets.
- Bearer verification is constant-time.
- Credential persistence and discovery files are atomic and owner-only.
- Discovery rejects symlinks, remote hosts, userinfo, path, query, fragment,
  encoded slash, stale PID, unsafe permissions, and unsupported versions.
- Native transport accepts only validated loopback origins and reviewed methods.
- Redirects are disabled.
- JSON responses are capped at 4 MiB; SSE frames are capped at 1 MiB.
- Invalid tokens do not consume a valid credential's rate bucket.
- Pairing creation is limited to 10 per minute; authenticated requests are
  limited to 120 per minute with bounded pruning.
- Windows named-pipe validation remains connected-handle and same-owner.
- Secret scans cover JavaScript logs, Rust logs, CLI JSON, Playwright traces,
  screenshots, and retained test artifacts.

## Testing Strategy

### Unit and contract tests

Cave tests cover pairing lifecycle, atomic credential persistence, constant-time
verification, loopback stamping, scope enforcement, rate limiting, health,
pairing routes, discovery lifecycle, settings approval, and contract export.

SDK tests cover discovery, compatibility, pairing, secret-store equivalence,
secure-backend absence, Unix and Windows IPC transports, public exports, packed
tarballs, offline installs, and CLI golden output.

Chat Rust tests cover discovery attacks, process candidates, installation ID,
keychain lifecycle, constrained transport, size limits, redirect rejection, and
non-secret command results.

Chat TypeScript tests cover reducer transitions, stale attempt rejection,
backoff, repeated-401 revocation, approval/denial/expiry, blocking shell
behavior, diagnostics, retry, and cancellation.

### Real-authority conformance

An isolated harness uses process-created state directories and exact child PIDs.
It runs packaged Chat and packed SDK/CLI artifacts against a real Cave and
proves:

- missing Cave and verified automatic launch
- fresh approval and exchange
- denial and expiry
- restart reconnect without pairing
- revocation, credential deletion, and re-pairing
- replay rejection
- wrong API major and minimum-version handling
- SDK in-memory pairing
- CLI secure-store pairing
- secret-free `doctor --json`
- clean logs, traces, screenshots, and retained artifacts

The harness never deletes caller-selected paths and cleans only owned temporary
roots.

## Execution and Review

### Wave 1

- Cave pairing/credential stores, auth boundary, routes, discovery, and settings
- SDK Coven IPC discovery and health

These may proceed in parallel because the Coven IPC lane does not depend on the
Cave pairing schema.

### Wave 2

- SDK Cave discovery, pairing, secret-store, and CLI support
- Chat native discovery, launch, keychain, and constrained transport

Wave 2 begins after the Cave public contract is reviewed. SDK and Chat consume
the reviewed artifact rather than importing Cave source.

### Wave 3

- Chat reducer, controller, and blocking connection gate
- packaged real-authority conformance
- Phase 1 gate and documentation closure

Every implementation checkpoint receives:

1. spec-compliance review
2. code-quality and security review
3. focused tests
4. repository-wide validation
5. PR checks before merge

The approved integration policy is to push repository-local branches, open PRs,
and merge only after required checks are green. Each merge updates counterpart
revision locks used by the conformance harness. No package publication, release,
or production rollout is part of Phase 1.

## Beads and Tracking

The existing Phase 1 program beads remain the durable top-level records:

- `cave-9pifu` — Cave authority
- `cave-lf7bu` — SDK Cave discovery and pairing
- `cave-p8qkk` — SDK Coven IPC discovery and health
- `cave-tsvfj` — Chat native connection flow
- `cave-0prpu` — real-authority conformance
- `cave-23nmv` — Phase 1 gate
- `cave-fz01p` — Phase 1 epic

The implementation plan may add child or related beads only where a top-level
record spans independently reviewable PRs. Dependency edges must preserve this
design's waves and remain cycle-free. Every closure note records repository,
branch, merged commit, tests, CI links, secret scan, and known limitations.

## Documentation Updates

Completion updates:

- this specification and the 2026-08-15 Phase 1 implementation plan
- Chat README and developer toolchains
- SDK package READMEs, CLI command documentation, and security boundaries
- Cave client-v1 contract and settings documentation
- Coven client integration documentation when discovery behavior changes
- program tracking bead evidence and Phase 1 gate notes

Documentation must distinguish shipped production behavior from fixture-driven
demo surfaces and must not publish example secrets.

## Exit Criteria

Phase 1 is complete only when:

- all six Phase 1 implementation/conformance/gate beads are closed with evidence
- Chat production startup blocks on authenticated Cave health
- verified automatic Cave launch works or fails explicitly
- pairing approval, denial, expiry, replay, restart, revocation, and re-pairing
  pass against real Cave
- wrong API major produces an upgrade-required state
- SDK and CLI packaged artifacts pass their public-boundary tests
- no bearer or pairing secret appears in retained outputs
- no raw private route, arbitrary HTTP client, or plaintext credential fallback
  exists
- repository-local suites and required GitHub checks pass on merged revisions

