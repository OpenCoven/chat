# Phase 1 real-authority conformance

`pnpm test:phase1-conformance` is the release gate for the Phase 1 read-only
desktop client. It packages exact reviewed Chat and SDK artifacts, builds the
locked Cave and Coven authorities, drives the headless native RPC against a
real isolated Cave, and retains one sanitized JSON report.

This gate is separate from `pnpm test:contract-canary`. The Phase 0 canary
checks the frozen SDK package and contract boundary. The Phase 1 harness checks
runtime discovery, pairing, credential handling, canonical reads, authority
binding, daemon identity, and cleanup.

## Prerequisites

- Node.js `24.18.1`
- pnpm `10.34.0` through Corepack
- Rust `1.95.0`
- clean local source repositories containing the revisions in
  `phase1-conformance.lock.json`
- macOS for the CI keychain lane

Run:

```bash
pnpm test:phase1-conformance
```

Override source repositories without moving them:

```bash
pnpm test:phase1-conformance -- \
  --chat-root /path/to/chat \
  --sdk-root /path/to/sdk \
  --cave-root /path/to/coven-cave \
  --coven-root /path/to/coven
```

The harness makes isolated detached clones at the exact locked revisions. It
rejects dirty, substituted, hidden-index, filtered, replacement-ref,
submodule, oversized, or timed-out checkouts before building anything.

## Owned execution and evidence

Execution uses process-created mode-`0700` roots under the real OS temporary
directory. Cleanup verifies device, inode, real path, and an unpredictable
ownership stamp; it never follows symlinks. Only direct `ChildProcess`
instances started by the harness are terminated and reaped.

`HOME`, XDG directories, temporary directories, the pnpm store, Cargo home,
Cave home, and Coven home all point inside process-owned roots. The harness
resolves the locked Rust toolchain binaries before isolation, places those
binaries first on `PATH`, and does not expose the operator's `RUSTUP_HOME` or
Cargo credentials to producer builds.

Caller-selected paths are never recursively deleted or overwritten. The only
retained file is:

```text
test-results/phase1-conformance/report.json
```

The destination must not already exist. The report is copied atomically only
after it is complete, unchanged across the scan, and the whole evidence root
passes the secret scan.

## Required assertions

Every ID must occur exactly once. Missing, duplicate, unexpected, or skipped
IDs fail the run.

1. `phase1.missing-cave.validated-launch`
2. `phase1.pairing.create-pending-approve-exchange`
3. `phase1.pairing.denial`
4. `phase1.pairing.expiry`
5. `phase1.pairing.wrong-secret-replay`
6. `phase1.pairing.failure-budget-retry-after`
7. `phase1.credential.restart-reuse`
8. `phase1.credential.revocation-repair`
9. `phase1.compat.api-major-min-client`
10. `phase1.hpke.endpoint-takeover`
11. `phase1.reads.bounded-canonical`
12. `phase1.reads.stale-generation-cursor-reconciliation`
13. `phase1.coven.same-user-identity`
14. `phase1.native.missing-keychain-trust`
15. `phase1.operator.homes-credentials-untouched`

The runner uses Cave's packaged socket conformance for expiry, wrong-secret,
shared-budget, `Retry-After`, replay, and HPKE listener-takeover evidence. The
locked Chat `phase1-native-rpc` drives discovery, validated launch, pairing,
credential reuse, revocation, and bounded reads. The locked Coven CLI runs a
real foreground daemon and authenticates its same-user Unix-socket or Windows
named-pipe status probe.

The native trust assertion launches a separate `phase1-native-rpc` subprocess
with `OPENCOVEN_PHASE1_CONFORMANCE_NATIVE_PROVIDER_PRESET=missing-keychain-trust`.
This finite, feature-gated preset selects the production `NativeKeyring`
credential-custody boundary and rejects provider access as
`secure_store_unavailable`; omitting the variable preserves the shared-memory
conformance custody used by all other Phase 1 scenarios.

## Secret scan and report schema

The scanner rejects pairing secrets, bearers, authorization headers, raw
keychain values, protected request or response plaintext, user prompts,
message bodies, attachments, private paths, and socket handles. Symlinks,
non-JSON files, oversized trees, unknown fields, and unapproved identifiers
also fail.

The retained schema allows only:

- `schemaVersion`, `completed`, and pass/fail/block status;
- OS, architecture, and tool versions;
- exact Chat, SDK, Cave, and Coven revisions;
- packaged artifact SHA-256 digests;
- required assertion IDs and approved diagnostic IDs;
- numeric pass/fail/block totals.

Re-scan an existing evidence directory with:

```bash
node ./scripts/phase1-artifact-secret-scan.mjs \
  --artifact-root ./test-results/phase1-conformance
```

## Failure interpretation

- `failed` means a supported real path ran and did not satisfy its assertion.
- `blocked` means the exact locked producer has no safe external control for
  the required scenario. The harness does not replace that absence with a mock.
- `passed` means the packaged path ran against the locked authority and the
  retained evidence scanned clean.
- A failed or timed-out producer subprocess is an infrastructure failure.
  Partial stdout is never accepted as passing assertion evidence.

At this revision the exact locked native RPC has no mode that uses the real OS
keychain and Cave has no release-mode override for API-major or
minimum-client incompatibility. Those assertions therefore block with
`phase1.producer.native-trust-fixture-unavailable` and
`phase1.producer.compatibility-control-unavailable` until producer support is
reviewed and locked.

The production surface remains read-only. Demo-only write interactions are not
part of this gate and are not evidence for a production mutation path.
