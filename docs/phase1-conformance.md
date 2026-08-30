# Phase 1 real-authority conformance

The trusted non-Node platform launcher is the runner for the Phase 1 read-only
desktop release gate. It packages the reviewed Chat production commit,
consumes the four frozen SDK tarballs, builds the locked Cave and Coven
authorities, drives Chat's headless native RPC, and retains one SDK #38
platform-evidence record.

This is separate from `pnpm test:contract-canary`. The canary checks the packed
SDK boundary; the Phase 1 runner checks runtime discovery, pairing, credential
handling, canonical reads, Coven identity, cleanup, and evidence compatibility.
No public record is written unless every primary assertion is completed and
passes, the primary secret scan succeeds, and the exact SDK validator accepts
the final bytes.

## Exact inputs

`phase1-conformance.lock.json` pins:

- Chat production `20633346c444ded9e05ca5a3db45d74c28918d69`, the
  expected missing-keychain trust-control successor to `dbbcf3a`;
- SDK package candidate `acc38488f00860d246c3c553375634d64806eabb`;
- Cave authority `e74078a147c084bd761d929654f0990df66ef99f`;
- Coven producer/client `721437b84026c042e431b0882dcd14fdb29ac07d`;
- Chat conformance driver support
  `b236604c3f7b51fdccec1ca6c7e2cebf45a600ca`;
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
The validator remains separate from the packed SDK candidate. The required
protected-run `validator_revision` input must exactly equal the lowercase
40-hex commit stored in the protected environment's nonsecret
`CLIENT_V1_CONFORMANCE_VALIDATOR_REVISION` variable. The harness clones that
exact revision into process-owned roots and rejects staged, unstaged,
untracked, ignored, hidden-index, filtered, replacement-ref, submodule, tree,
or HEAD drift before executing committed authority and harness bytes.

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

## Protected schema-v2 producer

The separate, manually dispatched
`.github/workflows/client-v1-conformance.yml` workflow produces the SDK
schema-v2 surface without replacing the hardened schema-v1 release gate. It
requires the immutable `validator_revision` input and runs in the protected
`client-v1-conformance` environment. The validator revision is deliberately
not committed into `phase1-conformance.lock.json`: the protected input avoids
a circular producer/validator pin while every cloned source, validator tree,
contract, registry, schema, and final canonical record is verified at runtime.

Run one platform only with its canonical output path:

```bash
node scripts/phase1-conformance.mjs \
  --validator-revision <full-sdk-validator-commit> \
  --platform darwin-arm64 \
  --output .artifacts/client-v1-conformance-darwin-arm64.json
```

The producer records only assertions that its package, native, Cave, Coven,
and exact observation suites actually passed; missing, duplicate, skipped, or
failed results block publication. The selected validator parses the final
canonical bytes before retention and the local redaction scan runs before the
validator callback, so no OIDC/GitHub token, keyring material, private path,
command output, prompt, message, or socket handle is retained.

Linux schema-v2 execution receives only a fresh, owned Secret Service D-Bus
session and its curated runtime environment. macOS uses an owned disposable
keychain. All lanes use the production native adapter with an isolated
conformance namespace. The producer proves that namespace is empty, performs
the real installation ID and credential round trip, then asks native code to
issue a cryptographically random 256-bit cleanup grant for the exact sorted,
deduplicated set of observed Cave instance accounts plus the installation
account. Native code atomically persists a one-shot, MAC-bound marker beneath
the process-owned isolated home. The marker binds the grant identity, isolated
service, canonical account set, storage identity, and issuing process under a
native-only per-process MAC key without storing the raw grant.

The producer immediately redeems and drops the grant. Redemption first
acquires the credential mutation lock, verifies that the in-process grant is
still issued, opens and validates the exact marker without removing it, and
holds its file identity for the transaction. It then deletes only the
marker-bound entries, confirms every scoped entry is absent, atomically moves
the same held marker out of the redeemable name, and finally removes the
in-process grant. Replay, concurrent use, marker tampering, service/account
substitution, links, and path swaps therefore fail closed. A lock, backend, or
partial-delete failure leaves the marker and issued grant available for an
authenticated retry with the same immutable service/account scope;
already-absent entries make that retry idempotent. The run requires the same
empty-state digest afterward and preserves unrelated entries. A missing,
malformed, or production keyring service is rejected before native custody
access or grant issuance; missing or locked native services also fail the run.
The separate reservation/adoption protocol for production-keyring credential
cleanup remains capability-bound, recoverable, and fail-closed.

On Unix, cleanup marker creation, publication, holding, and consumption use
private owner-checked directories, no-follow directory-relative operations,
exact `0700`/`0600` modes, regular-file identity and link-count checks, and
file plus directory synchronization. On Windows, every private component from
the isolated home through the marker directory is identity-checked and pinned
with a non-delete-sharing handle while path-based operations run. The
implementation revalidates the complete chain around publication, marker
holding, and final consumption, rejects reparse points and foreign or
writable-untrusted ACLs (including `FILE_DELETE_CHILD`), verifies file identity
and link count, and uses create-new files plus write-through atomic moves.
These RPC controls are compiled only into the `phase1-conformance` binary and
are not registered as production Tauri commands or capabilities.

The macOS and Windows Rust jobs execute the phase1 native RPC integration
binary. Windows coverage uses the native Credential Manager and Win32
filesystem/ACL behavior for exact cleanup, replay and scope rejection, marker
identity/link checks, DACL and reparse rejection, parent-chain substitution,
and preservation of unrelated credentials.

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

### Windows pre-bootstrap trust boundary

The `win32-x64` matrix expansion does not begin with checkout or a setup
action. Its first step is inline `pwsh` reviewed as part of the workflow
itself. Before network access or repository mutation, that step requires the
GitHub `windows-2025` x64 image at exact image version `20260824.239.3`,
Windows build `26100.33296`, `kernel32.dll` file version
`10.0.26100.33296`, PowerShell `7.6.5` at
`C:\Program Files\PowerShell\7\pwsh.exe` with its bundled .NET runtime
`10.0.11`, Visual Studio Enterprise 2022 `17.14.37614.0` at
`C:\Program Files\Microsoft Visual Studio\2022\Enterprise`, and its
`Microsoft.VisualStudio.Component.VC.Tools.x86.x64` component version
`17.14.36510.44`. The inventory's debug runtime version `14.44.35211` is not
the compiler directory version: the v143 compiler toolset directory version is
`14.44.35207` at
`C:\Program Files\Microsoft Visual Studio\2022\Enterprise\VC\Tools\MSVC\14.44.35207`.
The compiler and linker are pinned respectively to that toolset's
`bin\Hostx64\x64\cl.exe` and `bin\Hostx64\x64\link.exe`. Windows SDK
`10.0.26100.0` provides `rc.exe` at
`C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\rc.exe`.
These values come from the authoritative `actions/runner-images` inventory for
release tag `win25/20260824.239` at commit
`420ee0b3db1d89cc8745d939f2a72ff7bc426b97`.
The workflow also requires valid Microsoft Authenticode signatures for the
trusted PowerShell, kernel, command processor, Visual Studio executable,
compiler, linker, and resource compiler, plus non-reparse runner temporary and
workspace roots. These pins are step-level workflow metadata; accepting a
runner image update therefore requires an explicit protected-workflow metadata
and digest update.

The inline C# P/Invoke supervisor creates a named, nonce-bound Job Object with
only `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Creation uses a protected DACL with
exactly one non-inherited ACE: the current user may reopen only with
`JOB_OBJECT_QUERY | SYNCHRONIZE`. The creator retains its original full-access
handle, while same-user supervised code cannot reopen the name with
`JOB_OBJECT_SET_ATTRIBUTES`, `JOB_OBJECT_ASSIGN_PROCESS`, or
`JOB_OBJECT_TERMINATE`; attempting to enable silent breakaway through the
query-only handle is denied. The supervisor validates the exact owner,
protected-DACL control bit, one-ACE count, SID, flags, and access mask before
use. It calls `CreateProcessW` with `CREATE_SUSPENDED`, assigns the child with
`AssignProcessToJobObject`, confirms membership with `IsProcessInJob`, and only
then calls `ResumeThread`. Breakaway flags are not enabled. The parent retains
non-delete-sharing handles for the bootstrap and workspace directories,
captures stdout and stderr independently with 16 MiB bounds, applies a
55-minute total timeout, terminates the complete Job on timeout, overflow,
launch error, or non-zero child status, reaps the root, and closes every native
handle. Closing the final Job handle also kills any descendant that outlived
the supervised root.

The assigned child performs every Windows production operation: exact Chat
checkout, tool acquisition, dependency installation, tool and harness
verification, the Windows Job runtime test, all candidate/validator/Cave/Coven
checkouts and builds, native RPC execution, schema-v2 production, and final
canonical-record validation. The Node harness verifies that its own PID is in
the nonce-named Job through trusted system PowerShell. The phase-1 native RPC
receives a separate schema-v2 evidence-mode binding, opens the same named Job,
and fails before runtime initialization if the required flag, nonce, name,
existing Job, or membership is absent or malformed. Ordinary production builds
do not compile this evidence RPC path, and ordinary non-evidence RPC tests do
not set the schema-v2 mode. The four Job binding variables are explicitly
carried through the harness's curated environment; they cannot degrade to an
unnamed or ambient Job.

The supervisor continuously measures reviewed roots and terminates the entire
Job if any limit is exceeded. The bounds are 128 MiB for direct archives,
384 MiB for extracted PortableGit, 192 MiB for Node, 96 MiB for pnpm, 1 GiB
for rustup toolchains, 2 GiB/1 GiB for each Cargo registry/git cache, 3 GiB
for each pnpm store, 256 MiB for the bootstrap npm cache, 512 MiB for the
protected checkout's Git objects, 768 MiB for each SDK/Chat/Cave/Coven/
validator/producer checkout, 4 GiB for harness build roots, 2 GiB for the
workspace, 10 GiB for the harness execution root, and 12 GiB for the complete
bootstrap root. Quotas are rechecked after the root process exits so a
last-moment excess cannot escape the watchdog.

The child receives a constructed environment rather than the runner
environment. It contains no GitHub token, OIDC request value, Git credential,
Cargo credential, or proxy setting. Git disables system/global configuration,
credential helpers, prompts, replacement objects, and non-HTTPS fetch
protocols, and enables fetched-object verification. Downloads use a proxy-free
.NET `HttpClient`, allow only HTTPS, permit at most the reviewed per-asset
redirect chain (`github.com` to `release-assets.githubusercontent.com` for
PortableGit; no redirects for Node, pnpm, or rustup), cap time, require an
exact byte count, and verify SHA-256 before execution or extraction.

The directly downloaded Windows assets are:

| Facility | Exact asset | Bytes | SHA-256 |
| --- | --- | ---: | --- |
| Git for Windows | `PortableGit-2.55.0.5-64-bit.7z.exe` | 58,960,208 | `5aa8a20f6e9abb2c755f0e73c91c687701a46b309ad84a0ca6509380fa4ae290` |
| Node.js | `node-v24.18.1-win-x64.zip` | 37,177,316 | `ec56b84a7551893ab2324ebdfdc4ab974a63b4781162600b68a1293cc3e53765` |
| pnpm | `pnpm-10.34.0.tgz` | 4,582,819 | `58e143258871df51589b651c06205dabec48766a5dbba3c25999b69b50be598e` |
| rustup-init | `1.28.2/x86_64-pc-windows-msvc/rustup-init.exe` | 13,551,616 | `88d8258dcf6ae4f7a80c7d1088e1f36fa7025a1cfd1343731b4ee6f385121fc0` |

The pinned rustup executable installs only Rust `1.95.0` with the minimal
profile from `https://static.rust-lang.org`; rustup verifies the exact
toolchain component hashes from that release manifest. The workflow then
requires the exact Git, Node, pnpm, rustup, Rust, and Tauri versions before
conformance.

`scripts/windows-job-supervisor.test.ps1` is also run by the ordinary Windows
Rust CI job. On Windows it compiles the reviewed C# source, proves query-only
reopen succeeds while set/assign/terminate reopen and silent-breakaway
mutation are denied, creates a child/grandchild tree, proves timeout
termination reaches both processes, proves kill-on-close reaches a surviving
grandchild, and proves a mismatched named-Job membership check fails. The
protected lane runs the same test against the exact inline supervisor source
after checkout and while already inside the production Job. macOS development
can parse and compile the source but cannot claim those native runtime
results.

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

### Protected workflow graph

The dedicated workflow uses the protected `client-v1-conformance`
environment. It requires the reviewed deployment protection and the nonsecret
`CLIENT_V1_CONFORMANCE_VALIDATOR_REVISION` variable set to the exact reviewed
lowercase 40-hex SDK validator commit.

Self-review is prevented and administrators cannot bypass the protection. The
exact SDK workflow contract requires no application credential secret because
all counterpart repositories are public. The manual dispatch requires one
input, `validator_revision`, containing the same full lowercase 40-character
SDK validator commit as the protected environment variable. Trusted workflow
code rejects a missing, malformed, or unequal pair before validator execution
and again before attestation. The workflow has three unprivileged production
matrix expansions, one fresh unprivileged `ubuntu-24.04` validation job, one
fresh OIDC attestation job, and one permissionless aggregation-confirmation
job. macOS and Linux production use the pinned official checkout, Node, and
pnpm setup actions. Windows routes around those actions through the
pre-bootstrap Job root. Production preserves the existing native behavior and
uses the pinned official artifact upload exactly once per matrix expansion.

The producer and fresh-validation jobs have only `contents: read`; they have no
`id-token` or `attestations` permission. The harness and all candidate
subprocesses receive a curated environment that does not forward GitHub
tokens, OIDC request variables, Git credentials, operator Cargo credentials,
or ambient proxy configuration. After upload, the fresh validation runner
downloads each immutable artifact by its exact static name, checks out the SDK
at the protected validator revision, validates the exact SDK frozen schema
binding, executable parser, canonical serializer, and retained-evidence
scanner over one in-memory byte snapshot, then exports only the three SHA-256
digests.

The separate attestation job checks out no repository and runs no candidate,
validator, Node, pnpm, Rust, Cargo, harness, or downloaded artifact content. It
uses only pinned official download and attestation actions plus trusted inline
shell that downloads all three artifacts again and compares each fresh SHA-256
with the corresponding validation output. Only this job has `id-token: write`
and `attestations: write`, and each pinned attestation action names one exact
record path. There is no second record artifact, alternate upload path, or
caller-selected artifact name; the aggregation job cannot download, rewrite,
upload, attest, or substitute records.

`HOME`, XDG directories, temporary directories, pnpm store, Cargo home, Cave
home, and Coven home are isolated for the ordinary harness, checkout,
packaging, and non-native work. Darwin native-RPC subprocesses are the
intentional exception: both the main native scenario and emergency credential
cleanup receive the caller/operator `HOME`, so that the production macOS native
keychain adapter performs its native lookup in that context. The runner
therefore does not claim that the operator home is untouched. It continues to
isolate the authority homes used by the scenario, all execution artifact roots,
and the XDG, temporary, pnpm, Cargo, Git/config, proxy, terminal-prompt, and
process-control environment used by the harness; it also fingerprints the
bounded operator Cave and Coven authority state before and after the run.

Cave pairing uses the production native keyring, restarts the RPC process,
reuses the credential, then deletes it and proves the exact
`ai.opencoven.chat` / `cave-client-v1:<Cave UUID>` account is missing again.
Credential operations are constrained to that dedicated, labeled account: a
separate conformance-only command addresses it only through a native-issued
one-shot reservation handle and capability. Its marker lives in a dedicated
conformance cleanup keyring service, binds the native-observed UUID, target
account, schema, run identity, harness identity, and capability verifier, and
is removed only after both target and marker verify `NoEntry`. The cleanup
command accepts no caller-selected UUID or account and requires no discovery
handle. Pairing cannot begin until the native response is fully validated;
command failure, malformed output, or a lost response invokes the same-process
prepared-marker cancellation command before failing closed. The native RPC
keeps the newly created marker behind an RAII output transaction:
serialization, framing, write, flush, or closed-output failure synchronously
deletes and verifies the marker before the process exits. The macOS CI run
repeats this through the real native-RPC subprocess and an isolated disposable
production keychain, then probes both services, verifies that replay cleanup
returns the bounded missing-credential diagnostic, and verifies the active
disposable keychain.

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

## Non-cyclic SDK handoff

The Chat producer commit is created first. SDK #74 then freezes that exact
producer commit/tree, package manifest, harness, workflow, environment ID, and
source/signer digests in a later validator commit. Operators dispatch the
already-committed Chat workflow with that full SDK commit as
`validator_revision`.

The pre-repin SDK validator is expected to reject this new workflow
graph until that one-time metadata update is reviewed and merged. Chat-local
tests therefore require the old validator's rejection while independently
guarding the new graph and supervisor APIs. The later SDK change must replace
the producer workflow size/SHA-256 and producer commit/tree metadata and record
the validation and attestation job names, static artifact names and record
paths, pinned download and attestation actions, and protected environment
variable prerequisite. Chat's runtime `validator_revision` model remains
unchanged, and no SDK validator SHA is added to Chat.

The selected validator commit and tree, plus its contract and schema digests,
are recomputed from the exact clean checkout and embedded in the platform
record. The SDK aggregator still requires those values to equal the validator
checkout performing aggregation. No SDK validator revision is committed back
into Chat, so the two repositories do not form a commit-hash cycle.
