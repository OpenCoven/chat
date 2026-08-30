# Phase 1 real-authority conformance

Chat has one real-authority journey with two evidence surfaces:

- `pnpm test:phase1-conformance` keeps the strict schema-v1 report used by the
  original Phase 1 gate.
- `.github/workflows/client-v1-conformance.yml` invokes the same harness with
  `--validator-revision`, `--platform`, and `--output`, adapts only a complete passing primary run, and
  retains one canonical SDK schema-v2 platform record.

The schema-v2 path does not convert failures, blocks, skips, missing backends,
or missing authorities into passes. It writes no public record unless every
primary assertion is completed and passes, the primary secret scan succeeds,
and the exact SDK validator accepts the final bytes.

## Frozen inputs

`phase1-conformance.lock.json` version 3 pins only the non-cyclic source side:

- SDK package candidate
  `acc38488f00860d246c3c553375634d64806eabb` and tree;
- Cave authority
  `2a0ff9237e94e652e477b22f60fd6d721b9e6451` and tree;
- Coven producer
  `721437b84026c042e431b0882dcd14fdb29ac07d` and tree; and
- Chat production source
  `edd4728792321771496df58bfc0e6122908a96ec` and tree.

The validator is separate from the packed SDK candidate and is selected by a
required protected-run `validator_revision` input. The harness clones every
exact revision into process-owned roots, rejects staged, unstaged,
untracked, ignored, hidden-index, filtered, replacement-ref, submodule, tree,
or HEAD drift, and executes only committed authority and harness bytes.

The validator checkout supplies these authoritative files at runtime:

```text
conformance/client-v1-cross-repository-lock.json
conformance/client-v1-cross-repository-assertions.json
conformance/client-v1-cross-repository-evidence.schema.json
scripts/conformance-contract.mjs
scripts/github-conformance-evidence.mjs
```

Chat does not copy or relax their validators.

## Local commands

The legacy internal report remains:

```bash
corepack pnpm@10.34.0 --ignore-workspace test:phase1-conformance
```

A schema-v2 platform run must use its exact output path:

```bash
node scripts/phase1-conformance.mjs \
  --validator-revision <full-sdk-validator-commit> \
  --platform darwin-arm64 \
  --output .artifacts/client-v1-conformance-darwin-arm64.json
```

Replace the platform with `linux-x64` or `win32-x64` on the matching native
host. Platform and host OS/architecture mismatches fail before authority work.

Public counterpart repositories are fetched from GitHub when local roots are
not supplied. Operators may instead provide exact local repositories:

```text
OPENCOVEN_CHAT_ROOT
OPENCOVEN_SDK_ROOT
OPENCOVEN_SDK_VALIDATOR_ROOT
OPENCOVEN_CAVE_ROOT
OPENCOVEN_COVEN_ROOT
```

The corresponding source-path overrides are `--chat-root`, `--sdk-root`,
`--validator-root`, `--cave-root`, and `--coven-root`. The validator path is
only an object source: `--validator-revision` remains the immutable selector.
Overrides select a Git
object source only; the harness still creates and verifies detached clean
checkouts at the lock revisions.

## Platform prerequisites

Every lane requires:

- Node.js `24.18.1`;
- pnpm `10.34.0`;
- Rust `1.95.0`;
- Tauri CLI `2.11.4`;
- outbound HTTPS access to the four public OpenCoven repositories when local
  roots are absent; and
- enough time and resources for the real five-minute Cave TTL leg plus Cave,
  Chat native RPC, and Coven builds.

Native custody must be genuinely available:

| Platform | Runner | Custody backend | Coven identity backend |
| --- | --- | --- | --- |
| `darwin-arm64` | `macos-14` | macOS Keychain | Unix peer credentials |
| `linux-x64` | `ubuntu-24.04` | Secret Service-backed Linux keyring | Unix peer credentials |
| `win32-x64` | `windows-2025` | Windows Credential Manager | connected named-pipe client identity |

The schema-v2 run gives the native RPC a random, bounded keyring service
namespace. It proves that namespace is empty, performs the real installation
ID and credential round trip, deletes the installation and credential
entries, and requires the same empty-state digest afterward. Missing or locked
native services fail the run.

The Linux workflow installs exact Ubuntu 24.04 versions of `dbus-daemon`,
`gnome-keyring`, and `libsecret-tools`. It then creates a private mode-`0700`
runtime root, starts a fresh `dbus-run-session` and foreground Secret Service,
performs an independent `secret-tool` store/lookup/delete probe, runs the
harness, terminates the exact daemon PID, and verifies the owned root before
deleting it. Only its validated `DBUS_SESSION_BUS_ADDRESS` and
`XDG_RUNTIME_DIR` enter the curated harness subprocess environment.

Windows runners must permit local-persistence Credential Manager entries.
macOS runners must permit generic-password operations. No fallback to
shared-memory custody is allowed in a schema-v2 run.

## Protected workflow

The dedicated workflow is manually dispatchable and uses the protected
environment `client-v1-conformance`, GitHub environment ID `20863036831`.
That environment must have:

- required reviewers; and
- deployment branch rules restricted to protected branches.

Self-review is prevented and administrators cannot bypass the protection. The
exact SDK workflow contract requires no application credential secret because
all counterpart repositories are public. The manual dispatch requires one
input, `validator_revision`, containing the full lowercase 40-character SDK
validator commit. The workflow has only
the three protected matrix jobs and one permissionless aggregation-confirmation
job. It uses only the pinned official checkout, Node, pnpm, artifact upload,
and build-provenance attestation actions required by the SDK validator.

The harness and all candidate subprocesses receive a curated environment that
does not forward GitHub tokens, OIDC request variables, Git credentials,
operator Cargo credentials, or ambient proxy configuration. The official
attestation action is the only step that consumes the job's OIDC capability.

Each successful matrix expansion creates exactly one artifact:

| Platform | Artifact | Record path |
| --- | --- | --- |
| `darwin-arm64` | `client-v1-conformance-darwin-arm64` | `.artifacts/client-v1-conformance-darwin-arm64.json` |
| `linux-x64` | `client-v1-conformance-linux-x64` | `.artifacts/client-v1-conformance-linux-x64.json` |
| `win32-x64` | `client-v1-conformance-win32-x64` | `.artifacts/client-v1-conformance-win32-x64.json` |

Artifacts are retained for 30 days and attested with GitHub build provenance.
The aggregation job cannot download, rewrite, upload, attest, or substitute
records.

## Evidence construction

The schema-v1 report remains the primary outcome authority. It still requires
these 15 IDs exactly once:

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

For schema v2, all 15 must be `passed`. The adapter then:

1. retains Cave's exact `renderConformanceRecord` output from the locked Cave
   engine, including every frozen Cave assertion in order;
2. records each frozen SDK and common/platform Chat assertion only after its
   named packed-consumer, SDK test, native RPC, Cave, Coven, platform-trust, or
   evidence-scan check succeeds during that run;
3. rejects incomplete, duplicate, unexpected, skipped, failed, or blocked
   observed-result maps rather than filling omissions with passing entries;
4. recomputes validator, candidate, Cave, Coven, Chat, harness, manifest,
   tarball, fixture, vector, lockfile, registry, consumer-lock, and vendor
   identities from exact checkout or artifact bytes;
5. records exact toolchain and native backend metadata;
6. records opaque process-owned root IDs and before/after operator-state
   digests; and
7. uses the SDK recursive canonical serializer: sorted object keys, preserved
   array order, two-space JSON, LF endings, and one trailing newline.

The schema-v2 path consumes Chat's frozen vendored SDK tarballs on every
platform. It does not rebuild SDK tarballs per platform. The existing packed
consumer verifier installs those exact tarballs in a workspace-independent
consumer, verifies public exports, source/workspace exclusion, fixture
ancestry, and HPKE vector bytes, then the real-authority journey proceeds.

## Isolation and redaction

Execution and report staging use process-created mode-`0700` roots under the
real OS temporary directory. Cleanup verifies device, inode, real path, and an
unpredictable ownership stamp, terminates only tracked child processes, and
does not follow symlinks.

Before execution and after cleanup, the harness hashes the operator's real
Cave home, Coven home, and Cave project index with bounded traversal. Any
change fails the run. Retained evidence contains only the resulting SHA-256
values, never the paths or contents.

Before writing or retaining schema-v2 bytes:

1. Chat's `phase1-artifact-secret-scan` rejects secret/private content; and
2. the exact validator checkout runs the SDK schema, executable parser,
   canonicalizer, and retained-evidence scanner.

The record cannot contain a pairing secret, bearer, authorization header,
prompt, message or attachment body, command output, private cause, raw path,
URL, socket or pipe handle, operator identifier, or credential metadata.
Diagnostics are stable IDs only.

## Failure behavior

- Missing, duplicate, unexpected, skipped, failed, or blocked primary
  assertions produce no schema-v2 record.
- A platform mismatch, unavailable native keyring, failed peer/pipe proof,
  changed operator state, dirty checkout, artifact drift, scanner rejection,
  timeout, or cleanup failure produces no schema-v2 record.
- The output path is no-overwrite and is published only after a second
  byte/inode snapshot confirms it did not change after scanning.
- Partial subprocess output and skipped controls are never accepted as passes.

No platform evidence is claimed until an SDK validator commit contains a
compatible producer entry naming the reviewed Chat producer commit, harness
bytes, workflow bytes, protected environment, and artifact conventions. A
missing, malformed, stale, or otherwise incompatible `validator_revision`
fails before evidence publication.

## SDK aggregation handoff

After one protected run attempt successfully produces all three artifacts, the
SDK-side reviewer records the run, job, deployment, artifact, and attestation
identities in the reviewed evidence index. SDK release readiness downloads the
artifacts itself, verifies the exact protected workflow and environment,
verifies each attestation, re-renders the Cave record, and aggregates only the
downloaded canonical bytes. Chat does not create or commit a synthetic
aggregate.

## Non-cyclic SDK handoff

The Chat producer commit is created first. SDK #74 then freezes that exact
producer commit/tree, package manifest, harness, workflow, environment ID, and
source/signer digests in a later validator commit. Operators dispatch the
already-committed Chat workflow with that full SDK commit as
`validator_revision`.

The selected validator commit and tree, plus its contract and schema digests,
are recomputed from the exact clean checkout and embedded in the platform
record. The SDK aggregator still requires those values to equal the validator
checkout performing aggregation. No SDK validator revision is committed back
into Chat, so the two repositories do not form a commit-hash cycle.
