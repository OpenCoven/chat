# Phase 1 real-authority conformance

The trusted non-Node platform launcher is the runner for the Phase 1 read-only
desktop release gate. It packages the reviewed Chat production commit,
consumes the four frozen SDK tarballs, builds the locked Cave and Coven
authorities, drives Chat's headless native RPC, and retains one SDK #38
platform-evidence record.

This is separate from `pnpm test:contract-canary`. The canary checks the packed
SDK boundary; the Phase 1 runner checks runtime discovery, pairing, credential
handling, canonical reads, Coven identity, cleanup, and evidence compatibility.

## Exact inputs

`phase1-conformance.lock.json` pins:

- Chat production `20633346c444ded9e05ca5a3db45d74c28918d69`, the
  expected missing-keychain trust-control successor to `dbbcf3a`;
- SDK package candidate `acc38488f00860d246c3c553375634d64806eabb`;
- Cave authority `e74078a147c084bd761d929654f0990df66ef99f`;
- Coven producer/client `721437b84026c042e431b0882dcd14fdb29ac07d`;
- Chat conformance driver support
  `da8b57ea96d6b88197d8fa3ce3c633595a07aa5b`;
- SDK evidence contract and registry
  `4736bf2e0d5b16272d79ecf7784c75f376b39b94`;
- manifest digest
  `b8bfb62236fc8add4a9baad9f00e5401db15074a2d21fe2847a9158104cefb3c`;
- canonical package order, release/vendor paths, sizes, and SHA-256 digests.

The evidence record names the SDK evidence-authority commit because the SDK
aggregator binds its committed registry to that commit. The package candidate
remains independently pinned by revision, manifest digest, and tarball bytes.
The runner verifies that the evidence-authority commit descends from the
candidate and that all four candidate source package identities match the
frozen manifest. It never rebuilds replacement per-platform SDK tarballs.

Supported records are exactly `darwin-arm64`, `linux-x64`, and `win32-x64`.

## Running

Prerequisites are Node.js `24.18.1`, pnpm `10.34.0` through Corepack, Rust
`1.95.0`, an isolated native credential-store provider, and local repositories
containing the locked commits. The runner observes and rejects any Node, pnpm,
or Rust version drift before creating evidence.

The locked Cave release build receives a fixed 6 GiB V8 old-space allowance
and a two-worker Next.js CPU profile. Inherited Node runtime options are still
rejected; these build-only limits keep the exact production build reproducible
on the release runner without changing the artifact contract.

```bash
/bin/sh scripts/phase1-conformance-launcher.sh "$(command -v node)"
```

Source repositories can be overridden without moving them:

```bash
/bin/sh scripts/phase1-conformance-launcher.sh "$(command -v node)" \
  --chat-root /path/to/chat \
  --sdk-root /path/to/sdk-candidate \
  --sdk-evidence-root /path/to/current-sdk \
  --cave-root /path/to/coven-cave \
  --coven-root /path/to/coven
```

Windows fleet execution uses the reviewed PowerShell launcher with the frozen
supervisor and absolute Node path. It requires the canonical PowerShell 7
interpreter at `C:\Program Files\PowerShell\7\pwsh.exe` and rejects Windows
PowerShell 5.1:

```powershell
.\scripts\phase1-conformance-launcher.ps1 `
  C:\OpenCoven\conformance\phase1-process-supervisor.exe `
  C:\reviewed-node\node.exe
```

The non-Node launchers clear preload, loader, npm/pnpm hook, and Node module
injection variables before Node starts. Direct Node or pnpm invocation is not
accepted for release evidence. CI verifies the POSIX launcher SHA-256
`88e184d465eaf7bd6ce828dcc81ecadb11b6222f01576c56090060085820e7b2`;
the Windows launcher SHA-256 is
`99eea6108e59db9a0ac12368787fb6e6456e6af4f8cce09ee96ce117ca3f475e`.
Repository attributes require LF checkout bytes for both launchers on every
platform, including Windows; runtime digest checks never normalize line endings.

The harness creates clean detached clones at exact revisions and rejects dirty,
substituted, hidden-index, filtered, replacement-ref, submodule, oversized, or
timed-out release checkouts.

## Native Coven identity

The runner starts the real locked Coven daemon and calls
`phase1-native-rpc` command `coven_health`. This crosses Chat's production
`coven.rs` self-process boundary and the producer-owned Rust `coven-client`,
the same trust boundary used by the desktop application.
Before building the conformance driver, the runner requires the production
adapter, RPC entrypoint, Cargo manifest, and Cargo lock bytes to match the
locked Chat production commit. The conformance-only Rust support is built from
the separate immutable descendant harness revision in the lock. The production
tree plus selected adapter/custody Git blobs and SHA-256 values are checked
before packaging.

The runner never calls `coven daemon status`, duplicates Unix peer or Windows
pipe identity logic, or adds a pathname/shell fallback. Missing authority and
Unix malicious-home, symlink-socket, and wrong-mode cases also use
`coven_health` and must return only bounded `{ code, retryable }` diagnostics.

## Assertions and SDK aggregation

The runner reads the committed registry from the exact SDK evidence checkout
and verifies its digest. It emits every SDK assertion and every common plus
platform-specific Chat assertion in registry order. Missing, duplicate,
unexpected, reordered, failed, or skipped assertions prevent publication.

Top-level `coverage` explicitly sets `cave`, `coven`, `sdk`, and `chat` to
`true`. `notCovered` contains only structured non-release scope IDs:
`cross-process-pairing`, `oauth-ui`, `remote-peer`, and `write-apis`.

The retained record is validated by the exact locked SDK
`scripts/conformance-contract.mjs`. Aggregation runs on Darwin or Linux but
requires one record for all three platforms, including Windows.

## Isolation and retained evidence

Execution uses mode-`0700` process-owned roots under the real OS temporary
directory. Cleanup verifies root identity, does not follow symlinks, and
terminates and reaps only tracked child processes. Native RPCs own a dedicated
POSIX supervisor/process group or Windows Job Object. The live supervisor owns
the group identity until descendants are gone; Windows creates Cave suspended,
assigns the kill-on-close job, then resumes it. Forced cleanup therefore removes
Cave descendants without probing or signaling reused/unrelated process IDs.
All Darwin/Linux build, install, checkout, compiler, and tool commands use the
same supervisor and bounded status channel. Windows uses the standalone,
bin-only crate at `tools/phase1-process-supervisor`, whose Cargo graph excludes
Chat and its `cdylib`. Its canonical build is:

```text
cd tools/phase1-process-supervisor && SOURCE_DATE_EPOCH=0 cargo build --target x86_64-pc-windows-gnu --release --locked
```

The frozen `phase1-process-supervisor.exe` is 333,824 bytes with SHA-256
`372b3e8b5b860e0759da8fa10ddfb6ec338e26d83616254c816a456ae2e1b7c5`.
Its Darwin arm64 cross-toolchain is pinned to Homebrew core revision
`cd168d1fdc26f12e4ad64f358ff2dbec61ab7a57`, `mingw-w64 14.0.0_3`,
OCI bottle layer SHA-256
`0d68ab737a8bbc8c63ac6ac7acc0695e2887c1169df9a4423f1180090079b1d5`,
and GNU ld `2.47.20260726`. CI verifies the exact OCI manifest annotation,
installed package version, and linker version before building.
Fleet provisioning installs it at
`C:\OpenCoven\conformance\phase1-process-supervisor.exe`. The harness requires
that exact absolute path and digest before its first Git, pnpm, Cargo, build, or
tool command. The local frozen artifact is retained outside Git at
`files/phase1-process-supervisor-ff415b6/win32-x64/phase1-process-supervisor.exe`
in this implementation session's artifact area.

Windows command lookup accepts only regular `.exe`, `.cmd`, `.bat`, or `.com`
files, follows case-insensitive `PATHEXT` order, rejects ambiguous or relative
search paths, and handles explicit extensions without fallback. Batch shims run
only through the fixed absolute `%ComSpec% /d /s /c` boundary inside the
verified Job Object supervisor. Paths and arguments containing command
metacharacters, expansion markers, quotes, CR/LF, or NUL are rejected before
launch, and accepted tokens use one canonical quoted command line. Corepack is
resolved instead to the exact sibling `node.exe` and
`node_modules/corepack/dist/corepack.js`, avoiding batch interpretation for all
pnpm operations.
The logical Windows command name `corepack` is intercepted before generic
`PATH`/`PATHEXT` search; `corepack.exe`, `.com`, `.cmd`, and `.bat` requests are
forbidden, so PATH-precedence shims are never considered.

The caller-side script performs bootstrap only: it checks out the exact locked
harness revision and re-executes that detached runner. Before authority work,
the verified runner checks its own realpath, HEAD, tree, and the locked
blob/SHA-256 set for every executable harness module. Intentional native
conformance deltas from the production Chat commit are separately allowlisted
by exact path, blob, and digest.

On POSIX the supervisor reports through a private fd 3 pipe that is not inherited
by the target; no status path or capability enters the target environment.
Timeout and output-limit cancellation signal the live supervisor, which remains
the process-group leader through bounded TERM-to-KILL descendant cleanup and is
then reaped.

`HOME`, XDG directories, temporary directories, pnpm store, Cargo home, Cave
home, and Coven home are isolated. Cave pairing uses the production native
keyring, restarts the RPC process, reuses the credential, then deletes it and
proves the exact `ai.opencoven.chat` / `cave-client-v1:<Cave UUID>` account is
missing again. A separate conformance-only command addresses that exact account
through a native-issued one-shot reservation handle and capability. Its marker
lives in a dedicated conformance cleanup keyring service, binds the native
observed UUID, target account, schema, run identity, harness identity, and
capability verifier, and is removed only after both target and marker verify
`NoEntry`. The cleanup command accepts no caller-selected UUID or account and
requires no discovery handle. Pairing cannot begin until the native response is
fully validated; command failure, malformed output, or a lost response invokes
the same-process prepared-marker cancellation command before failing closed.
The native RPC keeps the newly created marker behind an RAII output transaction:
serialization, framing, write, flush, or closed-output failure synchronously
deletes and verifies the marker before the process exits.
The macOS CI run repeats this through the real native-RPC subprocess and an
isolated disposable production keychain, then probes both services and verifies
that replay cleanup returns the bounded missing-credential diagnostic.
macOS additionally verifies the active disposable keychain.

Restart reuse transfers cleanup ownership through a recoverable two-phase
protocol under the production keyring mutation lock. `begin_adopt` records a
pending caller-generated successor token while the predecessor remains active.
After the begin response is validated, idempotent `commit_adopt` promotes that
token; lost begin responses are aborted and lost commit responses are retried
with the retained token. Only then may the predecessor exit. Stale-owner cleanup
returns an explicit failure and cannot report deletion; the successor remains
armed until final one-time cleanup.
Linux and Windows bind evidence to the process-owned random Cave identity and
the exact production-keyring account rather than trusting an environment
assertion. The runner fingerprints bounded operator Cave and Coven authority
state. The `cave-home` evidence ID covers bounded top-level
metadata plus the separately reported, content-hashed `projects.json` control.
The `coven-home` evidence ID covers a bounded shallow manifest of top-level
Coven-home metadata plus content or metadata for the reviewed daemon authority
controls (`daemon.json`, lifecycle and state locks, the reset transaction
marker, and `coven.sock`). Neither fingerprint reads personal memory, journal,
research, conversation, diagnostic, or session trees. Any covered change fails
evidence creation.

The SDK schema records observed Node and pnpm values directly. Its closed shape
has no Rust, package-candidate, manifest, or harness fields, so the runner
binds those exact validated values through a fixed assertion-ID to
diagnostic-ID mapping. Chat pre-validation rejects missing, duplicated,
swapped, unrelated, or incorrect bindings before the unmodified SDK parser
accepts the compatible record; the SDK parser does not interpret those values
itself.

The only retained file is:

```text
test-results/phase1-conformance/report.json
```

The destination must not exist. Publication occurs only after SDK validation
and the local secret scan. CI restores and deletes its isolated keychain before
uploading the record, and cleanup failure blocks upload and the gate. The
record contains no operator paths, credentials, bearers, pairing secrets,
prompts, message bodies, attachments, command output, socket handles, or
private causes.

Re-scan retained evidence with:

```bash
node ./scripts/phase1-artifact-secret-scan.mjs \
  --artifact-root ./test-results/phase1-conformance
```

A producer failure, timeout, incomplete assertion set, or isolation/redaction
mismatch fails without publishing partial evidence.
