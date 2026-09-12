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

## Frozen GLib source adoption

The production binding and prior diagnostic harness below retain the reviewed
GLib iterator backport. The current executable harness commit and tree are
recorded in `phase1-conformance.lock.json` under `harnessAuthority`; the isolated
quota-reader repair advances that binding through the two-commit process below.

| Source | Revision | Tree |
| --- | --- | --- |
| Production Chat | `0da8c4749f57e63601b29d66032f80c9bbac1cb5` | `7be1737c4aae02493660d39a2d6f6fdf4dd9e696` |
| Prior diagnostic harness | `e8fe64b4d2b9bd38a03d8c23a28432518b41c187` | `b8934b32dc6a1352df55bab36af6e261d0aa9e86` |

The production snapshot changes only two Cargo files and 123 reviewed
vendor/provenance files from its prior frozen revision. The executable harness
retains those adoption bytes and additionally updates the Windows supervisor
and its byte-for-byte workflow copy for owner-only status staging files and
bounded quota diagnostics that preserve the first failure. The schema-v2
producer retains the validated staging path and supervisor SID through its
restricted child environment. Staging validators reject missing identity, and
the ACL probe checks exact inherited ACEs on direct temporary files. The
existing whole-checkout checks cover vendor files; no authority file list or
cleanliness check is relaxed. Only the two Cargo-file bindings change within
the production authority and native delta tables; 22 of the 25 pinned harness
files retain their bytes from staging harness
`14775ce396f73112ff95205e4e97303740748e13`.

[Native validation run 34498480972](https://github.com/OpenCoven/chat/actions/runs/34498480972)
validated the exact production tree and the earlier GLib-adoption harness at
`e0fca804e46d1a30eedcdae505c33e70d06035fb`: production passed 128 native
tests and that harness passed 158. Both passed the optimized desktop build, 11
patched iterator tests, Linux dependency-graph checks and final source
consistency. That run predates the status staging and quota diagnostic changes and does not
validate the current executable harness. The source commits have verified
signatures and are retained as parents of the adoption branch. This adoption
must land with an actual merge commit to preserve their ancestry.

Native candidate validation does not establish protected acceptance. Full
packaged CI, an updated SDK validator binding, both protected scopes and fresh
platform/aggregate validation remain required. Issue #188 remains open until
those gates and advisory reconciliation are complete.

## Fresh protected status-staging result

[Run 34603676876](https://github.com/OpenCoven/chat/actions/runs/34603676876)
used merged Chat `3d5af5b3441991e0314c4f2dfa91bfe9b450e9a7` and SDK validator
`2e14473b1c0ee888411f769484616332e68514ea`. Linux and Darwin passed, and
both retained records passed the matching SDK parser/scanner, exact source
identities, Cave timing and ordered assertion sets: 110 Cave, 46 SDK and 41 Chat.
Windows failed with `resource quota monitor failed closed: access-denied`, then
a separate ephemeral identity-cleanup failure. Artifact validation, attestation
and aggregation were skipped. The earlier status-writer assertion was not
reported; that does not prove the protected status-staging repair complete.

Issue #217 narrows the remaining quota diagnostic to fixed root and filesystem
operation identifiers. Issue #215's merged cleanup diagnostics identify the
separate cleanup subphase. Neither changes limits, authority checks, dependency
settings or first-failure precedence. The new combined diagnostic requires a
reviewed frozen harness, matching SDK binding and fresh protected execution
before any ACL repair or aggregate acceptance can be established.

## Protected validation before status staging

[Run 34594407090](https://github.com/OpenCoven/chat/actions/runs/34594407090)
used producer `4a5002011322de824f4d15676eab7769ce7975ba` and validator
`c43b21cbeb5dfe218430345fc71eff2822810f33`. Linux and Darwin passed; each
retained record contains 110 Cave, 46 SDK and 41 Chat passing assertions with
unique identities, consistent Cave timing and both scans passed. Windows
failed at
`phase1.runtime-observations.coven-rust-tests.status-replacement.assertion.writer-error.apply-owner-only-security.access-denied`.
The prior quota-monitor and identity-cleanup errors were not reported in this
execution; their absence does not establish that they cannot recur.

That run predates this combined staging harness and the merged Coven status
writer. Artifact validation, attestation and aggregate acceptance were skipped.
The result identifies the status-writer security operation as the next repair
boundary; it does not validate this integration or justify changing quotas.

## Earlier protected diagnostic result

[Run 34435223248](https://github.com/OpenCoven/chat/actions/runs/34435223248),
attempt 1, used Chat #199 at `724690e64c4be820bdf4e0e1f8c568db516ba490` and SDK
#196 validator `a5c7e38ecc905a6fdb9c9a3e704c6395ec2df02a`. Linux artifact
`10136315804` and Darwin artifact `10136396539` passed identity, digest, timing,
scan, and all 197 assertion checks. Windows failed at
`phase1.runtime-observations.coven-rust-tests.status-replacement.assertion.writer-error.access-denied`.
This establishes OS code 5 from the writer, but does not identify the failing
operation. Final validation, attestation, and aggregation were skipped. No
aggregate is accepted.

[Coven #984](https://github.com/OpenCoven/coven/issues/984) tracks fixed operation
labels; [#985](https://github.com/OpenCoven/coven/pull/985) is the diagnostic
implementation. The Chat classifier recognizes nine fixed operation labels and
six fixed OS codes only within an attributed, structurally valid writer panic.
Old operation strings retain their previous categories; unknown labels, codes,
or malformed records retain the generic category. Raw messages are never emitted.
Source adoption, harness authority, workflow digests, a matching SDK binding,
and fresh protected validation remain required. This diagnostic work does not
change writer security, retry limits, or observation selection.

Coven #985 head `367e670a01379799d89b6802e1a00bea7a0e20ef` passed native
Windows CI, including the new failure-path tests. Its Linux retry passed in
[run 34437695364, attempt 2](https://github.com/OpenCoven/coven/actions/runs/34437695364/attempts/2).
The initial Linux failure was SQLite exit-persistence contention, tracked in
[Coven #986](https://github.com/OpenCoven/coven/issues/986); a passing retry does
not establish a persistence fix. Val merged #985 as
`c0c979cdee96327bf24218bc7c7ecb90d719cb27`; its tree matches the reviewed head.
These CI results do not replace protected conformance validation.

The proposed Coven update also includes merged
[#983](https://github.com/OpenCoven/coven/pull/983), which changes CLI authority
refusal receipts and store initialization. Source adoption therefore includes
production CLI changes as well as diagnostic metadata. The frozen Chat native
client remains separately pinned; do not describe the complete adoption as a
diagnostic-only change.

## Exact inputs

`phase1-conformance.lock.json` pins:

- Chat production `0da8c4749f57e63601b29d66032f80c9bbac1cb5`, tree
  `7be1737c4aae02493660d39a2d6f6fdf4dd9e696`, the reviewed GLib
  backport source retained by the current SDK contract;
- SDK package candidate `1597835325cf3762b51408ff0a565037eeb25f64`;
- Cave authority `82bf6831b4afbe82709a5fe78949d1b16c4d61e1`, tree
  `06ffdd4320b7e05fbe68e2168f6efdb77c585756`, release `0.4.2`;
- Coven daemon and observation-test source `8c3735f374d6bc95e5b6fd107f7e7308fa26a2f8`;
- Chat native client remains at `721437b84026c042e431b0882dcd14fdb29ac07d`
  in its frozen Cargo manifest and lock;
- Chat conformance driver `b0c4f976c4ceadd9bcebab21c40d733e155e48d2`,
  tree `f677ecff0d7a5793257ca11c7922ffc0fd033b35`, retained in the
  producer ancestry;
- SDK evidence contract and registry
  `4736bf2e0d5b16272d79ecf7784c75f376b39b94`;
- manifest digest
  `a0f4bffb4619856997668371d0cf471d35c085b884ff5b3082510d0006ebb2d5`;
- canonical package order, release/vendor paths, sizes, and SHA-256 digests.

SDK PR #189 froze the replacement candidate and Chat source contract.
The protected validator last used by run 34647484742 is SDK #206 merge
`c774ba4ba473dae99ea8fe712989ae33ef5d5184`, which binds Chat producer
`e7dfc135bb7341d4cfc5b7f0fcf4004843868809` and the preceding Coven source.
Adopting Coven #1015 requires a new SDK source/producer binding before another
protected dispatch. The frozen
Chat source preserves all ten native file differences required by
`harnessAuthority.productionDeltas`. Pinning the
producer-derived `8a63ff1` source would remove those differences and fail the
existing authority check.

Chat #191 merged the source-fetch repair at
`3f2302da7dc2b39adb8042853b64aa58c406de08`. SDK #191 binds that producer at
`0d480eb72e00d5e0f915dbe0cb289ef12cbb9ebd`. Both validator variable scopes were
verified at that SDK revision before protected run `34406621503`, attempt 1.
Linux and macOS passed all 110 Cave, 46 SDK, and 41 Chat assertions. Windows
completed the SDK, Chat, and Chat Rust observations, then failed at
`phase1.runtime-observations.coven-rust-tests.failed`. The label does not
identify which Coven test failed or distinguish compilation from execution.
Final validation, attestation, and aggregation were skipped. Publishing remains
disabled and no three-platform aggregate is accepted.

Protected run `34395004109` used the previous `6526b56b30c9a9c1c072caf2f0022d3427ae18db` SDK candidate: Linux
and Darwin passed, while Windows failed at
`phase1.runtime-observations.sdk-tests.failed`. The failing assertion is not
identified by that stage label. The replacement candidate requires a fresh
protected attempt with the complete observation suite and existing resource
ceilings.

Protected run `34401360323` validates merged Chat `4f5cbf8` against SDK
validator `9dd5890`, with both validator variable scopes rotated to that revision.
Windows passed the image bootstrap but failed at
`phase1.stage.checkouts.chat.failed`, before SDK observations. Fetching only the
producer and harness revisions omits frozen Chat `841a88f`, which is outside
their ancestry. A cold fetch reproduced the missing commit; an explicit fetch
of the locked Chat SHA restored it. The Windows bootstrap therefore validates
and fetches that exact source and retains a tag for nested local clones.
The later #191 binding and run `34406621503` exercised this repair and reached
Coven Rust observations. Local Git regression tests alone do not establish
Windows platform conformance.
Linux and macOS completed this run successfully with all 46 SDK and 41 Chat
assertions. Windows failed before those observations, so final validation,
attestation, and aggregation were skipped. No three-platform aggregate is accepted.

The evidence record names the SDK evidence-authority commit because the SDK
aggregator binds its committed registry to that commit. The package candidate
remains independently pinned by revision, manifest digest, and tarball bytes.
The runner verifies both exact revisions and clean checkouts independently,
checks the locked evidence registry, schema, and contract digests, and requires
all four candidate source package identities to match the frozen manifest.
The evidence authority and package candidate do not require shared ancestry. It never rebuilds replacement per-platform SDK tarballs.

After reading the lock and configuring the frozen Windows supervisor, the
verified entrypoint authenticates its own Chat revision, tree, and every
`harnessAuthority.files` blob and SHA-256 before schema-v2 dispatch. The
schema-v2 producer accepts only that in-process verification receipt. After
cloning its producer checkout, it independently verifies the same harness
authority and the exact ten `productionDeltas` paths, blobs, and SHA-256
digests before loading SDK authority, packaging dependencies, or invoking
Cargo.

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
timed-out release checkouts. Each repository's complete verification command
sequence shares a finite 30-second deadline, which accommodates the frozen
Cave tree without permitting an unbounded Git child.
The protected Cave authority checkout retains its full commit history because
the packed fixture provenance names an older reviewed ancestor. The canary
must prove that ancestry and read the historical fixture bytes rather than
trusting the package's provenance claim alone.
Every clone, fetch, and checkout subprocess receives the checkout-specific
environment directly. Git attribute sources and other ambient Git overrides
removed by that projection cannot be reintroduced by the caller environment.

## Native Coven identity

The runner starts the real locked Coven daemon and calls
`phase1-native-rpc` command `coven_health`. This crosses Chat's production
`coven.rs` self-process boundary and the producer-owned Rust `coven-client`,
the same trust boundary used by the desktop application.
Before building the conformance driver, the runner requires the production
adapter, RPC entrypoint, Cargo manifest, and Cargo lock bytes to match the
locked Chat production commit. The conformance-only Rust support is built from
the separate immutable harness revision in the lock. Before packaging, the
runner verifies the exact production revision and tree, clean source, selected
adapter/custody Git blobs and SHA-256 values, and the harness authority with its
allowlisted native changes. The production adapter bytes must agree; ancestry
between the independently frozen revisions is not required.

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

A schema-v2 platform run is accepted only inside the protected native
producer supervisor. The supervisor supplies and owns the exact private source
record path; it is not derived from whichever immutable harness checkout is
currently executing:

```bash
node scripts/phase1-conformance.mjs \
  --validator-revision <full-sdk-validator-commit> \
  --platform darwin-arm64 \
  --output "$OPENCOVEN_UNIX_SOURCE_RECORD"
```

Replace the platform with `linux-x64` or `win32-x64` on the matching native
host. This inner command is documentation for the restricted producer, not a
supported broker-identity invocation. A direct macOS/Linux schema-v2 launch
without the supervisor UID and native cgroup/UID binding fails before authority
work. Platform and host OS/architecture mismatches also fail before authority
work. The outer launcher validates the supervisor workspace, private artifact
directory, canonical platform filename, owner/mode, containment, and process
identity once, then projects only those exact values into the relocated
verified runner. That runner and the schema-v2 producer independently
revalidate the same binding. An arbitrary caller path, substituted binding, or
preexisting record is rejected.

The producer records only assertions that its package, native, Cave, Coven,
and exact observation suites actually passed; missing, duplicate, skipped, or
failed results block publication. The selected validator parses the final
canonical bytes before retention and the local redaction scan runs before the
validator callback, so no OIDC/GitHub token, keyring material, private path,
command output, prompt, message, or socket handle is retained.

Linux schema-v2 execution receives only a fresh Secret Service D-Bus session
inside a runtime root owned by the ephemeral producer UID and its curated
environment. macOS uses an owned disposable keychain below the producer
user's isolated home. All lanes use the production native adapter with an
isolated conformance namespace. The producer proves that namespace is empty, performs
the real installation ID and credential round trip, then asks native code to
issue a cryptographically random 256-bit cleanup grant for the exact sorted,
deduplicated set of observed Cave instance accounts plus the installation
account. Native code atomically persists a one-shot, MAC-bound marker beneath
the process-owned isolated home. The marker binds the grant identity, isolated
service, canonical account set, storage identity, and issuing process under a
native-only per-process MAC key without storing the raw grant.

The producer immediately redeems and drops the grant. The Unix supervisor
projects its dedicated absolute, producer-owned mode-`0700` credential lock
root through the schema-v2 environment allowlist. Redemption first acquires
that lock, verifies that the in-process grant is still issued, opens and
validates the exact marker without removing it, and holds its file identity
for the transaction. Linux initializes the native store. macOS opens the exact
`HOME/Library/Keychains/phase1.keychain-db` file created for the
isolated producer identity only when the isolation marker is present, every
parent is private, owned, and not a symlink, and the file identity remains
stable and single-linked while opening it. One retained native keychain handle
serves every exact service/account deletion in the transaction without reading
secrets. Both paths invoke exact idempotent deletion for every authenticated
scoped account, so an already-absent item succeeds without a separate metadata
presence query. They confirm every scoped entry is absent, atomically move the
same held marker out of the redeemable name, and finally remove the in-process
grant.
Replay, concurrent use, marker tampering,
service/account substitution, links, and path swaps therefore fail closed. A
lock, backend, or partial-delete failure leaves the marker and issued grant
available for an authenticated retry with the same immutable service/account
scope; already-absent entries make that retry idempotent. The run requires the
same empty-state digest afterward and preserves unrelated entries. A missing,
malformed, or production keyring service is rejected before native custody
access or grant issuance; missing or locked native services also fail the run.
The separate reservation/adoption protocol for production-keyring credential
cleanup remains capability-bound, recoverable, and fail-closed.

On Unix, cleanup marker creation, publication, holding, and consumption use
private owner-checked directories, no-follow directory-relative operations,
exact `0700`/`0600` modes, regular-file identity and link-count checks, and
file plus directory synchronization. On Windows, every private component from
the isolated home through the marker directory is identity-checked and pinned
with a non-delete-sharing handle while path-based operations run. New
directories and files are created with Win32 security attributes that set the
exact current TokenUser SID as owner and a protected user-only DACL before the
object becomes visible, including under an elevated administrator token. The
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
The main-only `windows-supervisor` job uploads those exact bytes and exposes
only the artifact ID. The first Windows platform step creates the native Job
Object before using a trusted inline .NET client to download that artifact by
ID. It accepts one HTTPS redirect to the Azure artifact host, requires one
bounded ZIP entry, verifies the frozen size and SHA-256, installs it at
`C:\OpenCoven\conformance\phase1-process-supervisor.exe`, and grants the
isolated SID read/execute without write access. The GitHub artifact token is
removed before the Job or any repository checkout receives an environment.
The installed file is rechecked by the restricted child and removed during
broker cleanup.

### Unix producer supervisor and descriptor handoff

The `darwin-arm64` and `linux-x64` matrix expansions may use the pinned
checkout, Node, and pnpm setup actions before restricted execution. That
trusted setup does not run repository hooks, package lifecycle scripts,
candidate code, validators, authorities, builds, or dependency installation.
The Linux-only system package step is inline reviewed workflow shell. The
workflow verifies exact byte counts and SHA-256 digests for the entrypoint,
`phase1-schema-v2-producer.mjs`, Secret Service wrapper, Unix supervisor,
restricted command, and C handoff helper, then compiles the helper with the
native system C compiler.

The trusted root supervisor creates a random local account and primary group
whose numeric UID and GID differ from the original GitHub runner. The account
has no administrator membership or usable password. Its `HOME`, artifact
workspace, temporary directory, XDG roots, writable `node_modules`,
pnpm caches, Cargo home, rustup home, and package store are fresh mode-`0700`
directories below one ephemeral root. The supervisor resolves the exact Node,
pnpm, and rustup executables while still running as the broker and validates
their ownership and mode. The pnpm launcher identifies its exact
content-addressed `pnpm.cjs` package root; the supervisor validates that
complete regular-file tree, copies it into a root-owned, non-writable trusted
directory, and installs a fixed wrapper that invokes it through the trusted
Node copy. This preserves the self-updated pnpm runtime without depending on
its private installation path after the UID transition. The broker-owned source
runtime may contain action-setup hardlinks, but it must contain no symlink,
special file, unsafe owner, or writable component. The root-owned copy is then
validated again after ownership and mode sealing; every copied regular file
must have link count one before restricted execution begins. The copied checkout
and its tracked harness/validator launch sources are root-owned and recursively
non-writable; local Git clones resolve the source's exact Git metadata directory
for `safe.directory`, use `--local --no-hardlinks`, and retain no shared-object
alternate. This supports both ordinary checkouts and Git worktrees without
trusting the broader source path. The trusted command is a root-owned,
non-writable sibling of that producer root. It receives an allowlisted
environment with no GitHub token, OIDC request value, credential helper,
operator home, ambient package cache, or proxy setting.

The restricted harness and its transitive packed-consumer canary invoke the
reviewed copied `pnpm` executable directly. `corepack` is not exposed after the
identity transition.

Dependency installation, the isolated Rust toolchain installation, all
candidate/validator/Chat/Cave/Coven checkouts and builds, native RPC work,
authority execution, schema-v2 construction, scanning, and the producer-side
canonical check run as that one restricted UID. The schema-v2 producer module
independently requires `OPENCOVEN_UNIX_PRODUCER_REQUIRED=1`, the exact native
platform, `getuid()` equal to the bound producer UID, a different broker UID,
and the native containment kind before its first subprocess. Linux
additionally requires its own `/proc/self/cgroup` membership to equal the
nonce-bound cgroup-v2 path.

On Darwin and Linux, pinned official actions fetch the exact SDK candidate,
SDK evidence authority, selected validator, Cave, and Coven revisions beneath
the workflow checkout before restricted execution. The root supervisor copies
that complete checkout into its immutable source tree, and the restricted
command passes those exact `.phase1-counterparts` roots explicitly. On Windows,
the trusted child reads only lowercase commit IDs and repository allowlist
entries from the verified lock, fetches the historical harness commit, retains
it under `refs/tags/opencoven-phase1-harness`, and explicitly selects that tag
when creating the verified-runner shallow clone. The selected authority ref
must resolve to the locked revision and cannot have a same-named branch, so it
crosses both isolated local-clone generations without an ambiguous short ref.
The child then fetches all five counterpart checkouts with pinned Git inside
the Job and passes those roots to the relocated runner. Producer identity is
always recomputed from the supplied workflow Chat checkout rather than the
runner module path.

On Linux, the trusted supervisor requires a writable unified cgroup v2 mount.
It creates a dedicated child cgroup, starts only a trusted UID-dropping wrapper
in a stopped state, moves that PID into `cgroup.procs`, verifies membership,
and then resumes it. Every later `setsid`, fork, and double-fork descendant
inherits that cgroup. On root exit, failure, or timeout, the supervisor writes
`1` to `cgroup.kill`, repeatedly reads `cgroup.events` until it observes
`populated 0`, and removes the cgroup. Missing or unwritable controls, failed
assignment, failed kill, a nonempty cgroup, or failed removal produces no
handoff.

On macOS, the supervisor creates the local user and groups with the
preinstalled Directory Services tools and launches the entire command tree as
that exact UID. Before `sudo` changes identity, its exec-preserving launch
subshell changes to `/`, so the target shell never tries to resolve an
inaccessible inherited runner workspace; the restricted shell then changes
only to the copied isolated workspace. The account is disabled from creation.
After the restricted root exits, the supervisor reapplies the disabled
authentication authority and non-login shell, repeatedly enumerates `ps` by
exact numeric UID, sends `SIGKILL` only to those PIDs, and requires three
consecutive zero-process observations. It then deletes the user and primary
group and proves both that the UID has no processes and that Directory
Services no longer maps it. Any lock, kill, zero-process, account, group, or
UID cleanup failure fails closed.

The restricted Unix dependency install keeps the source copy read-only and
passes `--config.store-dir="$PNPM_STORE_DIR"` directly to pnpm alongside
`--frozen-lockfile --ignore-scripts`. Store discovery and package imports
therefore use the producer-owned isolated store rather than probing the
read-only source root.

Only after the Linux cgroup or macOS UID is proved empty does the trusted
supervisor begin handoff. A root-only preparation pass opens the producer
root, workspace, artifact directory, and record with directory-relative
`openat`, `O_DIRECTORY`, and `O_NOFOLLOW`; checks the pre-execution device and
inode of every producer-owned parent. The trusted outer shell has retained
open descriptors for those three directories since before restricted
execution, preventing a removed parent inode from being recycled into a false
identity match. The preparation pass requires a regular, bounded,
mode-`0600`, single-link record owned by the exact deleted producer UID with no
extended ACL. It changes only those pinned descriptors to a temporary private
handoff group and exact `0750`/`0640` modes.

The broker root is created directly below `/tmp`, then verified as a private
runner-owned directory before the supervisor temporarily grants traverse-only
access. This keeps every sandbox ancestor traversable by the restricted UID
without granting it write access. The launcher also supports an empty command
argument list on the Bash 3.2 runtime shipped by macOS.

A fresh process running as the original GitHub runner UID, with only that
temporary group added, repeats the no-follow descriptor walk and all identity,
owner, link, mode, ACL, and size checks. It reads the source descriptor once,
rejects any device, inode, size, link, ownership, mode, mtime, or ctime change,
and creates the final runner-owned artifact with `O_CREAT|O_EXCL` at mode
`0600`. It writes the same in-memory bytes, fsyncs the file and destination
directory, reopens no-follow, and verifies byte equality and stable identity.
Symlinks, hardlinks, parent replacement, destination overwrite, and in-place
rewrite therefore fail without path-copying attacker-controlled bytes. The
workflow then applies the committed scanner and canonical schema-v2/platform
check to the stable broker-owned file before the one official upload action.

`scripts/unix-producer-supervisor.test.sh` compiles and exercises the real
handoff implementation on both native CI operating systems. Its privileged
cases launch a restricted C fixture that calls `setsid`, double-forks, and
tries to replace the record after its root exits. Ubuntu proves cgroup-v2
drain and macOS proves exact-UID process/account cleanup; both verify that the
escaped PID is dead and the original bytes were handed off. Native cases also
reject a record symlink, second hardlink, replaced artifact parent, and a
synchronized in-place rewrite. The macOS success case invokes the root
supervisor from a broker-owned mode-`0700` directory that the ephemeral UID
cannot traverse, then requires the restricted fixture to start in the copied
workspace and read its tracked source file. Local runs without passwordless
`sudo` still compile and run the descriptor handoff/rewrite cases but
explicitly skip, and must not claim, the privileged UID/cgroup runtime results.

### Windows pre-bootstrap trust boundary

The `win32-x64` matrix expansion does not begin with checkout or a setup
action. Its first step is inline `pwsh` reviewed as part of the workflow
itself. Before network access or repository mutation, that step requires the
GitHub `windows-2025-vs2026` x64 image with one of two reviewed image and
Visual Studio Enterprise 2026 pairs:

| Image version | Visual Studio version |
| --- | --- |
| `20260824.214.3` | `18.9.12112.369` |
| `20260907.229.1` | `18.9.12120.119` |

The image selects its exact Visual Studio version. Unknown images and crossed
pairs are rejected. This accommodates GitHub's gradual image deployment without
accepting version ranges or changing the other trust checks.

Both profiles require Windows build `26100.33296`, `kernel32.dll` file version
`10.0.26100.33296`, PowerShell `7.6.5` at
`C:\Program Files\PowerShell\7\pwsh.exe` with its bundled .NET runtime
`10.0.11`, and Visual Studio Enterprise 2026 at
`C:\Program Files\Microsoft Visual Studio\18\Enterprise`, and its legacy v143
`Microsoft.VisualStudio.Component.VC.14.44.17.14.x86.x64` component version
`18.9.12009.81`. The v143 compiler toolset directory version remains
`14.44.35207` at
`C:\Program Files\Microsoft Visual Studio\18\Enterprise\VC\Tools\MSVC\14.44.35207`.
The compiler and linker are pinned respectively to that toolset's
`bin\Hostx64\x64\cl.exe` and `bin\Hostx64\x64\link.exe`. Windows SDK
`10.0.26100.0` provides `rc.exe` at
`C:\Program Files (x86)\Windows Kits\10\bin\10.0.26100.0\x64\rc.exe`.
These values come from the authoritative `actions/runner-images` inventory for
release tags `win25-vs2026/20260824.214` at commit
`8c3c8c0bf0068534d87e970a58b590522f1dc1a5` and
`win25-vs2026/20260907.229` at commit
`c240f76fa0dd523af7376dbe8480964a3cb0af47`.
The workflow also requires valid Microsoft Authenticode signatures for the
trusted PowerShell, kernel, command processor, Visual Studio executable,
compiler, linker, and resource compiler, plus non-reparse runner temporary and
workspace roots. These pins are step-level workflow metadata; accepting a
runner image update therefore requires an explicit protected-workflow metadata
and digest update.

Before any Windows network access or repository mutation, the trusted outer
PowerShell process uses only the signed `advapi32.dll`, `netapi32.dll`,
`userenv.dll`, and `kernel32.dll` facilities from the exact pinned image to
create a cryptographically random ephemeral local account. `NetUserAdd` creates
it with the ordinary-user request and the broker then explicitly normalizes
the enabled `UF_SCRIPT | UF_NORMAL_ACCOUNT | UF_DONT_EXPIRE_PASSWD` flag set,
rejecting trust-account, passwordless, disabled, locked, delegation, smartcard,
reversible-password, expired-password, and DES/preauthentication exceptions.
The legacy `usri1_priv` value is recorded for diagnosis but is not treated as
an authorization source on Windows Server 2025. Instead,
`NetUserGetLocalGroups` must resolve exactly the built-in Users SID, and a real
interactive logon token must have the exact account SID, no Administrators
membership, no elevation, default elevation type, medium integrity, and none
of the dangerous token privileges such as debug, impersonate, backup,
restore, TCB, driver-load, take-ownership, or primary-token assignment. Any
API, SID translation, group enumeration, token-information, or privilege-name
ambiguity fails closed. Its random password remains a private field in the
trusted supervisor process and is never written to disk, placed in the child
environment, or exposed to the checkout.

The outer process creates a fresh bootstrap root, profile, temporary directory,
and checkout workspace owned by that account. Each directory has a protected,
exact DACL: the ephemeral owner receives file/directory modify access without
`WRITE_DAC` or `WRITE_OWNER`; Owner Rights suppresses implicit owner DACL
rewrites; SYSTEM, Administrators, and the original supervisor retain full
cleanup access; broad Users, Everyone, and Authenticated Users grants are
absent. The original GitHub artifact workspace is separately protected for
SYSTEM, Administrators, and the supervisor. `HOME`, `USERPROFILE`, `APPDATA`,
`LOCALAPPDATA`, `TEMP`, `TMP`, the checkout, and all package/tool caches point
inside the isolated bootstrap root. The child receives no runner GitHub token,
OIDC request value, Git/Cargo credential, proxy, or operator home path.

The supervisor protects its own process DACL. SYSTEM, Administrators, and the
original runner identity retain full access, while the ephemeral identity
receives only `PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE`. Before any
download, the child proves that it is non-admin; that
`OpenProcess(PROCESS_DUP_HANDLE)`, `WRITE_DAC`, and `WRITE_OWNER` against the
supervisor fail; that `DuplicateHandle` cannot copy the authoritative Job
handle even when its numeric value is known; and that attempts to replace the
supervisor process DACL or owner fail. This distinct owner-SID boundary closes
the same-user owner-rights escape that a Job Object DACL alone cannot close.

The named, nonce-bound Job Object has only
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`. Its protected DACL contains one
non-inherited ACE granting the ephemeral SID only
`JOB_OBJECT_QUERY | SYNCHRONIZE`; the Job owner remains the trusted runner
identity, which retains the original full-access handle. Set/assign/terminate
reopens and silent-breakaway mutation are denied. The supervisor launches the
bootstrap with `CreateProcessWithLogonW(LOGON_WITH_PROFILE)` and
`CREATE_SUSPENDED`, assigns it with `AssignProcessToJobObject`, confirms
membership with `IsProcessInJob`, and only then calls `ResumeThread`. Breakaway
flags are not enabled. The outer process retains non-delete-sharing handles for
the bootstrap, checkout, and artifact workspaces, captures stdout and stderr
independently with 16 MiB bounds, applies a 55-minute timeout, terminates and
reaps the complete Job on every exit path, and requires zero active Job
processes before beginning artifact handoff.

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

The privileged handoff never reopens the record through managed path APIs.
With the Job explicitly terminated and empty, the supervisor retains
non-delete-sharing, no-follow handles for every directory from the isolated
workspace root to the record. Each directory must remain on the same volume,
must not be a reparse point, must be owned by the isolated SID, and must retain
the exact restrictive isolated-user, supervisor, SYSTEM, Administrators, and
Owner Rights DACL. The final record is opened read-only with
`FILE_FLAG_OPEN_REPARSE_POINT` and no write/delete sharing. It must be one
bounded disk file, not a directory or reparse point, have exactly one hard
link, and retain the expected isolated owner and restrictive DACL. Volume
serial, file ID, attributes, link count, and size are rechecked on the same
handle after the bounded read.

Those handle-captured bytes and their SHA-256 are passed over an inherited
anonymous stdin pipe to a fresh restricted-user PowerShell process. That
process receives no source path and revalidates the exact digest, strict UTF-8,
schema-v2 platform binding, and recursively sorted canonical JSON. Only after
that validation process is also terminated and the Job again reports zero
active processes does the supervisor create the destination with `CREATE_NEW`
and an owner-private protected DACL. It writes and flushes the same in-memory
bytes through the new handle, rereads them through that handle, and verifies
their digest, size, attributes, single-link state, volume, and file ID.
`File.Copy` and post-validation path reads are not used.

After the root exits, the trusted outer process terminates and reaps the Job,
closes every pinned handle, removes any Windows profile with `DeleteProfileW`,
safely deletes the non-reparse bootstrap tree, calls `NetUserDel`, and verifies
that the account, profile registry entry/directory, and bootstrap root are
gone. A profile deletion blocked by Windows error 32 is retried for at most 10
seconds to allow the terminated logon profile to unload; every other deletion
error fails immediately, and the existing bounded disappearance proof remains
mandatory. Cleanup attempts are aggregated so one failure cannot skip later
cleanup, and any account/profile/root cleanup failure fails the workflow.

The supervisor continuously measures reviewed roots and terminates the entire
Job if any limit is exceeded. The bounds are 128 MiB for direct archives,
384 MiB for extracted PortableGit, 192 MiB for Node, 96 MiB for pnpm, 1 GiB
for rustup toolchains, 2 GiB/1 GiB for each Cargo registry/git cache, 3 GiB
for each pnpm store, 256 MiB for the bootstrap npm cache, 512 MiB for the
protected checkout's Git objects, 768 MiB for each SDK/Chat/Coven/
validator/producer checkout, 4 GiB for the Cave working tree including its
dependencies and Next output, 4 GiB for harness build roots, 2 GiB for the
workspace, 10 GiB for the harness execution root, and 12 GiB for the complete
bootstrap root. Quotas are rechecked after the root process exits and again
after exact-SID quarantine so a last-moment or out-of-Job excess cannot escape
the watchdog. After preserving the built Chat RPC executable, schema-v2 removes
the no-longer-needed Chat Cargo target before building Coven so peak disk usage
stays within those unchanged bounds. Each scan materializes only a bounded
number of entries through
bounded enumeration and ignores only file/directory disappearance races caused
by concurrent producer cleanup; permission failures, malformed paths, bound
exhaustion, overflow, and other monitor errors still terminate the Job fail
closed. After preserving the built Coven executable, schema-v2 also removes the
Coven Cargo target before starting the observation suite, so neither packaging
target remains at the next peak. Observation failures expose only the fixed SDK
install, Chat install, SDK tests, Chat tests, Chat Rust tests, or Coven Rust
tests substage, plus a distinct temporary-root cleanup substage on Unix;
command output and private paths remain suppressed. Failures report either the
fixed reviewed quota label or a path-free quota-monitor error.

The Cave allowance accounts for a measured frozen `d20d83c` build with
3,405,969,113 bytes in `node_modules` and `.next` alone; the former source-sized
768 MiB allowance could not fit that working tree. The execution and bootstrap
aggregate limits remain unchanged. Windows schema-v2 native builds use
`CARGO_PROFILE_DEV_DEBUG=0` and `CARGO_INCREMENTAL=0` for Chat and Coven packaging
and the shared native observation-test target.
They retain the existing dev profile's runtime checks, optimization level, and
features, but omit debugger and incremental-rebuild data for these one-shot
builds. Unix and schema-v1 native build settings are unchanged. A local native
RPC comparison reduced the build tree from 1,980,684,162 to 1,004,039,629 bytes;
that measurement is not a substitute for the protected Windows quota result.

Before throwing for a supervised production failure, the parent writes its
existing bounded quota or exit-code diagnostic to stderr. A subsequent trusted
cleanup exception therefore cannot erase that first diagnostic. Cleanup errors
still fail the job and prevent evidence acceptance.

The child receives a constructed environment rather than the runner
environment. It contains no GitHub token, OIDC request value, Git credential,
Cargo credential, or proxy setting. Git disables system/global configuration,
credential helpers, prompts, replacement objects, and non-HTTPS fetch
protocols, uses the native `NUL` device spelling for disabled configuration and
prompt helpers, and enables fetched-object verification. Downloads use a
proxy-free .NET `HttpClient`, allow only HTTPS, permit at most the reviewed per-asset
redirect chain (`github.com` to `release-assets.githubusercontent.com` for
PortableGit; no redirects for Node, pnpm, or rustup), cap time, require an
exact byte count, and verify SHA-256 before execution or extraction. Every
child launched through `Invoke-Checked` receives the current absolute
FileSystem provider path as `ProcessStartInfo.WorkingDirectory` only after the
existing isolated-directory ownership and reparse checks pass. Consequently,
the Chat Git sequence inside `Push-Location $workspace` initializes and
mutates that exact workspace rather than inheriting the bootstrap root.

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

When the ordinary Windows test suite reports a non-system null WTS SID, its
failure reporter makes one bounded observation without changing the failure.
The test-only `scripts/windows-process-sid-diagnostics.cs` opens one
query/synchronize handle, performs at most two zero-time waits and one token
query, and closes the handle. Fixed labels and numeric OS codes distinguish
open-not-found, open failure, exited, live readable/unreadable token, invalid
token, and wait failure without emitting a SID. The observation describes the
newly opened handle; it cannot establish continuity or reuse relative to the
original WTS row. Chat #206 remains open until native evidence explains the
ambiguity. Standalone `scripts/windows-process-sid-diagnostics.test.ps1` tests
exercise states and call/cleanup bounds and also run in the native suite.
The native suite additionally checks one real self-process observation through a
nested failure report; terminal-attempt wrapping preserves the inner exception
chain so a real WTS failure reaches the same reporter. The reporter traverses
aggregate children within a twelve-exception total bound and shares one probe
budget across all branches, including producer-plus-quarantine failures.

`scripts/windows-job-supervisor.test.ps1` is also run by the ordinary elevated
`windows-2025` supervisor behavior CI job. It creates a real ephemeral standard
user and scoped profile/temp/workspace ACLs, launches every supervised probe as
that user, proves the supervisor process and authoritative Job handle cannot be
opened or mutated through the former same-user path. It checks the official
11-parameter
`CreateProcessWithLogonW` declaration at runtime, protects each suspended root
process before resume with a trusted owner and an exact protected DACL, and has
a same-isolated-SID descendant attempt terminate, duplicate-handle, ACL/owner,
thread, VM, quota, information, suspend, and delete access. The descendant also
tries ordinary one-link in-place and replacement artifact forgeries while the
root is alive; the trusted root-handle exit and later handle snapshot must still
yield only the root's final bytes. The suite proves the account, Windows
profile, and root are removed and preserves the query-only Job reopen,
set/assign/terminate denial, silent-breakaway denial, child/grandchild timeout,
high-churn below-quota directory scanning,
descendant-retained-handle, kill-on-close, quota, positive membership,
wrong-Job membership, and native binding cases. The protected lane executes the
same process/ACL/membership preflight directly from the exact inline production
source before its first download. macOS development can parse and compile the
source but cannot claim those native Windows runtime results; native Windows
runtime evidence is CI-only. The native suite
also provisions a same-volume `status-staging` directory with an exact
protected DACL. The isolated user retains modify-only access to the directory
itself, while an object-inherit-only ACE grants created files the ACL-management
rights needed to secure an empty Coven status temporary before moving it into
the stricter `COVEN_HOME`; the protected child validates the directory and
receives it through
`COVEN_WINDOWS_STATUS_STAGING_DIR`. A 1 MiB directory quota bounds this staging
surface independently. Quota accounting consumes metadata returned by bounded
directory enumeration instead of reopening owner-only staging children, and
bootstrap cleanup first deletes files through the supervisor-controlled parent
before attempting a read-only-attribute fallback. The native timeout case
leaves an owner-only staging file in place while quota monitoring runs and
proves terminal cleanup still removes the complete bootstrap root.
The native suite
also has a background supervised process replace an already validated record
with a file symlink to a supervisor-only canary before exiting, and proves the
handoff fails without reading or publishing the canary. Separate cases reject
a second hard link, a parent junction, wrong record ownership, a permissive
DACL, and an active replacement race; the success case exercises stdin
revalidation plus create-new, owner-private publication.
The same job retains the frozen Rust supervisor artifact behavior tests.
The suite also runs a service-broker quarantine case that creates a hidden
interactive-token task inside a unique nested Task Scheduler folder and
explicitly attempts `IRegisteredTask.Run`. A hosted ephemeral account does not
necessarily have a Task Scheduler-recognized interactive session, so action
execution is not treated as a prerequisite for the cleanup proof. If the action
does start, any started, PID, or SID marker, or a live `EnginePID`, is treated
as execution evidence. Because the protected Job grants query-only reopen
access to the isolated SID, the action can perform a bounded live proof using
`OpenJobObjectW`, `OpenProcess`, `IsProcessInJob`, and primary-token SID
queries. It must be outside the supervised Job, use the exact isolated SID, and
be gone after quarantine. Partial marker publication and a process that exits
before this proof fail closed. The same requirement applies to the post-disable
and nonzero scheduler attempts. The case also creates a genuinely
principal-only
`TASK_LOGON_INTERACTIVE_TOKEN` task: its folder, path, name, description,
source, signed system `ping.exe` action, arguments, and working directory are
runtime-rejected if they contain the run identity, user name, isolated root, or
supervised workspace. The neutral, hidden, and cross-folder variants are
registration-only fixtures, so quarantine can find them only by exact
`Principal.UserId`/SID matching rather than run markers. Before the supervisor
captures its scheduler snapshot, the broker also creates a unique shared parent
and one empty child folder. Restricted production then registers exact-SID
tasks both directly in that pre-existing child and in a new sibling child.
Quarantine must remove both registrations and the run-created child while
preserving the complete pre-existing folder chain.

Independently of scheduler session availability, the trusted test broker uses
`CreateProcessWithLogonW` and the retained ephemeral credentials to launch a
long-lived process with the isolated user's primary token outside the
supervised Job. That process writes a readiness marker, is proven alive,
outside the Job through `IsProcessInJob` against the supervisor's still-live
authoritative handle, and bound to the exact isolated SID. The protected named
Job DACL intentionally grants reopen access only to the isolated SID, so the
broker does not reopen it by name. Readiness markers are checked for exact
content with a bounded retry for the Windows writer-close sharing race. The
process waits for verified account disablement, then registers and attempts to
start a second task. The SID-wide quarantine must terminate this deterministic
service-equivalent escape and remove both task registrations, any action
process that actually started, all owned nested folders, and the BITS job
before capture without deleting shared Task Scheduler folders. A separate
nonzero scenario stages another live
outside-Job exact-SID process, registers and attempts a scheduler action, and
creates a BITS job. Scheduler action execution remains conditional, while the
process drain, terminal quarantine, complete account/profile/root cleanup, and
artifact-capture rejection are mandatory. Each BITS registration uses the
exact system `bitsadmin.exe` through a no-shell native process with a
10-second timeout, bounded captured output, explicit exit-code verification,
and forced tree cleanup on timeout.

Four additional native cases stage an exact-SID principal-only task
registration and run attempt, a deterministic out-of-Job exact-SID process,
and a BITS job, then invoke
`RunProducerAsUserAndQuarantine` through stdout overflow, stderr overflow,
directory-quota failure, and a `CreateProcessWithLogonW` launch exception.
Scheduler action execution is conditional in these cases as well. Each
requires verified account disablement, completed quarantine, external zero
counts for exact-SID processes/tasks/BITS, rejected artifact capture, and
successful identity/profile/root deletion. Each invokes
`QuarantineIsolatedIdentity` again after completion and requires an unchanged
successful state. A timeout producer verifies the same terminal quarantine
path. A deterministic native decision-seam regression also injects the exact
race where WTS reported an isolated-SID PID but `OpenProcess` observes that it
has disappeared. The stale failure is accepted only after a second WTS
enumeration proves the PID absent or reused by another SID; a still-matching PID
and access denial remain fatal.

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
by exact path, blob, and digest. The verified runner keeps executing from that
detached harness, while its Tauri toolchain probe runs from the supervisor-bound
source workspace where the frozen dependency installation already completed.
This avoids consulting an uninstalled `node_modules` tree in the fresh harness
clone without widening the allowed workspace boundary.

The dedicated workflow is manually dispatchable and uses the protected
environment `client-v1-conformance`, GitHub environment ID `20863036831`.
Every producer, validation, attestation, and aggregation job independently
requires the exact job-level condition
`if: github.ref == 'refs/heads/main'`. A dispatch from a feature branch, tag,
or any other ref therefore skips the complete evidence graph before a runner
or protected environment is selected. This workflow main-only control and the
environment policy below are both required; neither substitutes for the other.

That environment must have:

- required reviewer user ID `68980965`;
- wait timer `0`;
- `prevent_self_review` enabled;
- administrator bypass disabled;
- deployment branch rules restricted to protected branches only; and
- nonsecret environment variable
  `CLIENT_V1_CONFORMANCE_VALIDATOR_REVISION`, set to the exact reviewed
  lowercase 40-hex SDK validator commit for that run.

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

Repository `main` currently has no external branch-protection rule, so the
environment's `protected_branches` deployment policy alone does not constrain
workflow origin. That external policy gap no longer weakens the workflow's
origin guarantee because the exact `refs/heads/main` job conditions fail closed
independently. Branch protection must still be enabled and maintained so the
environment policy provides its required second control.

Self-review is prevented and administrators cannot bypass the protection. The
exact SDK workflow contract requires no application credential secret because
all counterpart repositories are public. The manual dispatch requires one
input, `validator_revision`, containing the same full lowercase 40-character
SDK validator commit as the protected environment variable. Trusted workflow
code rejects a missing, malformed, or unequal pair before validator execution
and again before attestation. The workflow has three unprivileged production
matrix expansions, one fresh unprivileged `ubuntu-24.04` validation job, one
fresh OIDC attestation job, and one permissionless aggregation-confirmation
job. macOS and Linux use the pinned official checkout, Node, and pnpm setup
actions only for trusted pre-bootstrap work, then run all dependency,
candidate, validator, and authority work under the native restricted producer
supervisor. Windows routes around those actions through the pre-bootstrap Job
root. Production preserves the existing native behavior and uses the pinned
official artifact upload exactly once per matrix expansion.

The verified-runner environment is an explicit projection, not an ambient
inheritance. Unix carries only the validated UID/name, broker UID, native
containment and cgroup membership, source workspace, private artifact
directory, and source-record path, plus the isolated Secret Service values
where applicable. Windows carries only the nonce-bound Job identity, trusted
system PowerShell path, exact bootstrap/workspace/artifact paths, the
deterministic Node distribution path derived by the outer bootstrap, required
system directories and command processor, isolated temporary directories,
`PATH`/`PATHEXT`, and the reviewed `LIB`/`INCLUDE` toolchain paths. GitHub and
OIDC bearer variables are never projected. The restricted bootstrap constructs
each `PATH` directory as a distinct array entry so pnpm-generated command shims
can resolve the pinned Node executable without consulting ambient runner paths.

The Windows Job membership probe uses pinned PowerShell 7.6.5
`-CommandWithArgs`, so the nonce-bound Job name and decimal process ID arrive
as exactly two literal arguments. It does not use `-Command` positional
parsing, a shell command line, or caller-controlled interpolation.

Every Windows producer invocation uses a broker-only terminal transition.
The trusted `finally` path enters idempotent identity quarantine after success,
nonzero exit, timeout, output overflow, resource-quota failure, or exception.
The broker first terminates and reaps the Job Object and verifies zero active
Job processes. It then disables the ephemeral local account with
`NetUserSetInfo` and independently re-reads the account with `NetUserGetInfo`;
an absent or ambiguous `UF_ACCOUNTDISABLE` bit is fatal. The trusted broker
snapshots the complete Task Scheduler folder path set before restricted
production begins. During quarantine it recursively enumerates folders and
hidden registrations through `Schedule.Service`, matches exact SID and
local-account principals plus run-root identities, and stops and deletes all
matching instances and registrations. Folder cleanup considers only paths
absent from the pre-production snapshot, never the root or a pre-existing
ancestor, rechecks that each candidate is empty, and deletes run-created
descendants deepest-first. Pre-existing folders remain even when empty. It also
enumerates all-user BITS jobs, cancels every job whose owner SID is the isolated
SID, and verifies absence.

System-wide process proof uses `WTSEnumerateProcessesExW` level 1, whose
`WTS_PROCESS_INFO_EXW.pUserSid` is the primary-token user SID. It does not
infer absence from Job membership. Every exact-SID process must normally be
opened, rechecked by primary token, terminated, waited, and reaped. If
`OpenProcess` reports only a reviewed stale/nonexistent PID error, the broker
immediately repeats the WTS enumeration and accepts the race only when the PID
is absent or no longer has the exact isolated SID. A still-matching PID, access
denial, WTS/SID-query ambiguity, termination failure, or wait failure is fatal.
Scheduler cleanup, BITS cleanup, and SID-wide drain repeat until three bounded
consecutive rounds observe no attributable registration, running task,
run-created empty folder, BITS job, or process, over a bounded observation
window. The final proof independently rechecks the disabled account, Job count,
scheduler state, BITS state, and SID-wide process count. Cleanup delegates,
final proof, Job close, profile/root deletion, and account deletion are all
attempted even when another cleanup action fails; failures are aggregated
rather than swallowed. Job and identity `Dispose` retry quarantine if the
terminal attempt did not complete it.

Artifact ACL sealing and capture are unavailable after an unsuccessful
producer result and unavailable until quarantine completes. Only after a
successful result and terminal zero proof does the broker retain
no-delete-sharing handles, replace the
workspace, artifact-directory, and record owner/DACL with protected
broker/SYSTEM/Administrators-only ACLs, verify those ACLs through the handles,
and read the record. It checks scheduler, BITS, account-disable, and SID-wide
process state before and after the read and before and after publication. Any
reappearance aborts handoff. A fresh broker process validates the captured
bytes before the no-overwrite broker-private publication.

The restricted standard-user token cannot create a Windows service because
creating an SCM service requires service-control-manager create-service access,
which the token does not have. The native regression requires both
`OpenSCManagerW(SC_MANAGER_CREATE_SERVICE)` and `CreateServiceW` through a
connect-only SCM handle to fail with exactly `ERROR_ACCESS_DENIED`, rejects
every other error, and requires `OpenServiceW` to prove
`ERROR_SERVICE_DOES_NOT_EXIST`. It likewise cannot create permanent WMI
subscriptions because writing `__EventFilter`/consumer/binding instances in
`root/subscription` requires namespace write/provider rights absent from the
token. The `windows-2025` runtime test executes both denied operations and
fails if either succeeds or fails ambiguously. Account disablement plus exact
task/BITS/process drain also closes per-user Run keys and Startup-folder
persistence: those mechanisms require a future logon, and no new logon is
possible before the account, profile, and isolated root are deleted.

The producer and fresh-validation jobs have only `contents: read`; they have no
`id-token` or `attestations` permission. The harness and all candidate
subprocesses receive a curated environment under a UID distinct from the
runner/broker that does not forward GitHub tokens, OIDC request variables, Git
credentials, operator Cargo credentials, or ambient proxy configuration. After
upload, the fresh validation runner downloads each immutable artifact by its
exact static name, checks out the SDK at the protected validator revision,
validates the exact SDK frozen schema binding, executable parser, canonical
serializer, and retained-evidence scanner over one in-memory byte snapshot,
then exports only the three SHA-256 digests.

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

The destination must not exist. Windows publishes only handle-captured bytes;
macOS and Linux publish only after native zero-process proof and a no-follow
descriptor read whose identity and timestamps remain stable. Publication
occurs only after SDK validation and the local secret scan. CI restores and
deletes its isolated keychain before uploading the record, and cleanup failure
blocks upload and the gate. The record contains no operator paths, credentials,
bearers, pairing secrets, prompts, message bodies, attachments, command output,
socket handles, or private causes.

Re-scan retained evidence with:

```bash
node ./scripts/phase1-artifact-secret-scan.mjs \
  --artifact-root ./test-results/phase1-conformance
```

A producer failure, timeout, incomplete assertion set, or isolation/redaction
mismatch fails without publishing partial evidence.

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

After upload, a fresh unprivileged runner repeats the complete exact SDK
schema/parser/canonicalizer/scanner validation over one in-memory snapshot of
the downloaded bytes. Attestation is authorized only when a second fresh
download has the same SHA-256 as that validated snapshot.

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
- The output path is no-overwrite. Windows publishes only handle-captured
  bytes after a successful producer result, completed terminal quarantine,
  verified account disablement, recursive scheduler/BITS cleanup, stable
  SID-wide zero-process proof, and handle-verified ACL sealing; macOS/Linux
  publish only after native zero-process proof and a no-follow descriptor read
  whose identity and timestamps remain stable.

Packaging failures publish only the bounded failing substage: frozen consumer
verification, Cave install/build, Chat install/web/native build, Coven build,
or final output verification. Cave build failures are further classified to
the bounded release-build phase, including resource exhaustion, compilation,
page-data, static-page, server-bundle, and postbuild boundaries. A recognized
bounded command-failure reason remains authoritative even when the captured
output lacks a phase banner. Pnpm lifecycle banners are recognized with or
without their workspace path, and a failure before the wrapped lifecycle starts
is identified at the conformance-wrapper boundary. Verified-runner and
owned-artifact cleanup retain an earlier execution failure instead of replacing
it. Captured command output, filesystem paths, and the underlying error remain
private in-memory causes and are not serialized into the public failure result.

Checkout failures identify the Chat, SDK, Cave, Coven, integrity, validator, or
producer boundary. Evidence finalization failures identify report construction,
operator-state capture, isolation, assertions, evidence construction, serialization,
scanning, or retention. These allowlisted diagnostics survive nested stage wrappers;
underlying command output and private paths remain excluded from public errors.

Frozen consumer failures are further bounded to authority verification,
artifact loading, harness creation, offline installation, isolation checks,
Cave fixture matching, packed build, packed verification, or cleanup. The
cross-process diagnostic file contains only that allowlisted stage.

Schema-v2 native failures publish only an allowlisted scenario substage, such
as fixture setup, RPC startup, native custody preflight, launch, pairing,
restart, reads, reconciliation, revocation, stale discovery, cleanup,
missing-keychain trust, or final isolation proof. The first failed native
assertion is retained while later scenarios and mandatory cleanup complete,
and cleanup further identifies grant issuance, native-custody cleanup, RPC
shutdown, or fixture-daemon shutdown. Nested wrappers preserve that bounded
identifier. Private RPC responses, credential identifiers, native-store
values, paths, and underlying errors remain in-memory only.
- Windows account-disable ambiguity, scheduler or BITS enumeration/access
  failure, WTS enumeration or SID-query failure, matching-process access or
  termination failure, unstable drain, ACL-seal failure, or post-seal
  reappearance produces no artifact.
- Windows producer success, nonzero exit, timeout, quota/output failure, and
  exception all enter the same terminal quarantine path before identity
  deletion. Native stdout-overflow, stderr-overflow, directory-quota, and
  launch-exception cases each prove account disablement, zero exact-SID
  process/task/BITS state, capture rejection, repeat-quarantine idempotence,
  and final identity cleanup. Cleanup failures are aggregated after every
  cleanup action has been attempted.
- Uploaded bytes that fail fresh SDK validation, differ from the validation
  digest when downloaded for attestation, or use a validator input unequal to
  the protected environment variable are never attested.
- Partial subprocess output and skipped controls are never accepted as passes.

No platform evidence is claimed until an SDK validator commit contains a
compatible producer entry naming the reviewed Chat producer commit, harness
bytes, workflow bytes, protected environment, and artifact conventions. A
missing, malformed, stale, or otherwise incompatible `validator_revision`
fails before evidence publication. The SDK metadata update must also record
the `validate-conformance-artifacts` and `attest-conformance-artifacts` job
names, the three static download names and record paths, the pinned download
and attestation action SHAs, and the environment variable prerequisite.

Cave record validation reports fixed diagnostic suffixes beneath
`phase1.stage.evidence-authority.build.cave-record`: `identity.platform`,
`identity.commit`, `identity.cave-version`, `identity.node-version`,
`timing.invalid`, `timing.before-run`, `timing.after-run`, and `assertions.shape`, `count`,
`unexpected`, `duplicate`, `result`, or `detail`. Both producer wrappers
preserve only the exact allowlisted IDs. Record values, assertion IDs,
private details, and exception causes are never included in these diagnostics.
Identity, inclusive timing bounds, and assertion requirements still control
acceptance. Cave timestamps must be canonical UTC millisecond strings before
range comparisons; malformed values are rejected without coercion.

### SDK verification metadata for this producer

The ordinary contract canary imports the SDK's `createConformanceArtifacts` API
instead of invoking its publication CLI. It builds the already-checked, exact SDK
checkout with the locked version and `requireConformanceEvidence: false`: these
private artifacts are inputs to conformance, so they cannot require an accepted
conformance aggregate first. Checkout, manifest, package-content, and isolated
consumer checks remain mandatory. This does not enable publication or qualify a
release.

Both harness schemas prepend the resolved Rust toolchain directory after applying
the supervisor's PATH. The supervisor PATH must not replace that directory with
Rustup shims: isolated builds intentionally do not inherit `RUSTUP_HOME` or a
global default toolchain, and Coven does not have a local toolchain override.
Cargo credentials remain isolated; no global Rust default is configured.

The later SDK validator repin must use these exact final producer-checkout
bytes. The workflow row describes the producer workflow, including its updated
executable integrity tables. The workflow entry in `harnessAuthority.files`
separately identifies the workflow at the frozen harness revision; those two
revision authorities can therefore have different workflow hashes:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `.github/workflows/client-v1-conformance.yml` | 511,601 | `695e66ad899e8d2817b8cb3a406d1c625aa4c38b38b863f68948ffa5a0b1fa33` |
| `scripts/contract-canary.mjs` | 40,116 | `1683e2484a228b89ee241b9b434f277895bb6113fa1c2f7051267563b2582380` |
| `scripts/executable-resolution.mjs` | 9,154 | `31e3c412ff8c835f14522f36a59e91f4a4ba82913210ae8e3b4455217503f430` |
| `scripts/owned-temp-directory.mjs` | 6,965 | `a9c55c85cf2b7d70310d278bafd2c8e7695d66f4ae38b9c3f1f12fce0b442095` |
| `scripts/phase1-artifact-secret-scan.mjs` | 21,183 | `be0ec302b9c4372f232d6bd1efcba873fd3380cc5de7f756cd0b9eeeec07222a` |
| `scripts/phase1-conformance-lock.mjs` | 48,960 | `8cfcd89aca252a9c4c6f23932012e8b443341030963dae2d2a5a57650492b3b6` |
| `scripts/phase1-conformance.mjs` | 209,340 | `e02a95e70cf343f66b8faf498856ea4927cdf7fa6d234a69bb234fe53a50201b` |
| `scripts/phase1-evidence-contract.mjs` | 15,088 | `24180ae03835fa6aac45559682adb3c1e626bab76466eddc55b9e2300f0a2b7f` |
| `scripts/phase1-evidence-runtime.mjs` | 6,078 | `3d227c354e6d908c5912d2b8244336e3b79c3bbd4dec79b0ad219ed65b8cb159` |
| `scripts/phase1-linux-secret-service.mjs` | 4,270 | `ddf834c6f57853c5116b4b1f345952a218ff0687c5d741737c68e20bc2ecda92` |
| `scripts/phase1-macos-keychain.mjs` | 5,091 | `ab0c2dd08cf606d9502f5da206175707d471d99f484e8c8c79b5b08a5772b9a4` |
| `scripts/phase1-process-supervisor.mjs` | 3,820 | `16b51fb1a33b4bfef98daca549aacf5dc2d2c098cfbd664753b69c940d1e6f6c` |
| `scripts/phase1-schema-v2-evidence.mjs` | 52,505 | `0aede2ab3abd76fabf5ac61d64d2dbaaffa497c8647b82236403de16a47751c8` |
| `scripts/phase1-schema-v2-producer.mjs` | 200,758 | `3e98a7881d53703e38a043a1d28c4c2a06467adabb8c2fc7b5835431803c3d25` |
| `scripts/process-owned-artifact-root.mjs` | 11,788 | `426c2c8e36dc3bffddb35a565c07a60998b010660f6248ebc4264d9c4b502624` |
| `scripts/supervised-exec.mjs` | 2,875 | `a5edfd985b934d3b46247a0da3141682c411d30bb582edf87ae7b29791dad65b` |
| `scripts/supervisor-status.mjs` | 854 | `ac332ca7b6b040ecc846088bb3a6ad5e7112a0454eb3ea71d2a819d55e64254e` |
| `scripts/phase1-linux-secret-service.sh` | 5,650 | `83ce19c0dd6da5002f6853fa37addb4fc2d39f3d17beee1b1c39e1fce232b476` |
| `scripts/unix-artifact-handoff.c` | 18,704 | `2a003f9aa1d1886b9a593371a73cb65fe3a4a8b703f1c59fec8a27694367b7fc` |
| `scripts/unix-producer-command.sh` | 3,223 | `ce9ec2ff00947f3ec0db53f144c99d34bc27de6085062d00dccff7c934c2e3c8` |
| `scripts/unix-producer-supervisor.sh` | 29,424 | `b73036415744c80ed27d5667f255ceea149096ca517b47c93a154299802206ff` |
| `scripts/unix-producer-supervisor-attack.c` | 6,211 | `e485ebebb6570b06f179c03a3849224d59d96400b7cadd5547067cce35239642` |
| `scripts/unix-producer-supervisor.test.sh` | 13,348 | `a8c6f48915b0c86a704a7ddc28eaa7f808ae0a3ddfcdb38c0c23ac0d83738f6d` |
| `scripts/phase1-windows-supervisor-build.sh` | 4,646 | `713a9e0282887ade3e243b5ba175794d74cdb02c28c38dcd41491c9505812770` |
| `scripts/phase1-windows-supervisor-install.ps1` | 1,743 | `2baab275f0bb6789884cded5f6185d00bfa5348b9e7c3ad1e5575353639101d5` |
| `scripts/windows-job-supervisor.cs` | 330,220 | `8d5e68f9d44049bd00bcdb8291d4e7c542dcdeaf1e15685b619962a12e0f30ca` |
| `scripts/windows-job-supervisor.test.ps1` | 178,124 | `b22a424e2cf90ea6c06c184cf7bf0ca737f6e0a55e656ecc2ff614b5969b4b64` |
| `scripts/windows-quota-diagnostics.test.ps1` | 21,401 | `b98a2c18ecf3ca7ee749bfa278cb1132250c1db5fc7cc28920e3384a38066c9c` |
| `scripts/windows-owner-directory-quota.test.ps1` | 11,186 | `41a028dae853502af7f06463983e74d0a798070a538852b7d8bb2773cb3e7fe3` |
| `scripts/windows-quota-isolated-reader.test.ps1` | 18,928 | `247778f13c4238d8b7a9f1e004571d91709790654e246896357fc497514476a6` |
| `scripts/windows-quota-lifetime.test.ps1` | 2,513 | `dd10741c19cd97cc1b9ee29ebe18b8381503d589680acd0eddaabda08b5e7aec` |
| `scripts/windows-identity-cleanup-diagnostics.test.ps1` | 5,596 | `fa738d8e93a8132a26e34fbbb58e89f7ac12c13e7298cf923f8db6b31e7097c5` |
| `scripts/windows-cleanup-delete-diagnostics.test.ps1` | 7,433 | `e9d30285a1fe0ad035637621c6a3840eb8a6194b2f23e1a4aa188c5884cd0c64` |
| `scripts/windows-process-sid-diagnostics.cs` | 4,054 | `cd4b1c16a759ce4e63b87c82c4be0dbee9c0b48e9bfd3851eb966c303918e1a2` |
| `scripts/windows-process-sid-diagnostics.test.ps1` | 7,316 | `c83e2d63355fb95c8220045115a3b8106b7507b7132d235ad74eb0283f6c481f` |
| `scripts/windows-staging-binding.test.ps1` | 885 | `56514e709e34b68e0692bd5c3bd91c8bea0a01fd281ded33920f83c2ab653182` |
| `scripts/windows-status-acl-probe.test.ps1` | 3,980 | `8ef6032dd38921238d2d860bfa76ba79a53ff549c1e6b1cb8901698e0ca08e3c` |
| `scripts/windows-status-acl-probe.cs` | 10,118 | `93fe7fd44286f8cb9b3944a7e66257181d0153ed81eec94cd56b79662e620638` |

The table above is the SDK-facing subset; `phase1-conformance.lock.json`'s
`harnessAuthority.files` also tracks `.github/workflows/ci.yml`, which does
not appear here. Editing ordinary CI config still dirties that entry and
requires the same file-hash repin as touching the harness itself — this is
not discoverable until a test fails on it.

A PR that repins `harnessAuthority.revision`/`.tree` to a commit within its
own branch (rather than to something already merged) must be merged with an
actual merge commit, never squash or rebase. Squashing silently breaks the
invariant: the pinned revision stops being an ancestor of `main`, and the
authority checkout keeps resolving only for as long as the now-orphaned
source branch survives. A follow-up repin to the real merge commit is the
only fix once that happens.

The two-step converges in exactly two commits only when every digest update —
the harness digest, both workflow pin tables, every affected row in the table
above, and every affected `harnessAuthority.files` entry (the workflow's own
self-referential one included) — lands in the code commit itself. The repin
commit that follows must touch nothing but `harness.revision`,
`harnessAuthority.revision`/`.tree`, and the test's literal copy of them. Move
any digest into the repin commit instead and it invalidates the digests
recorded against the commit `harness.revision` still names, forcing a third
commit to advance the pin again — the exact shape of #102's first attempt and
#110's first attempt.

Before parsing or executing SDK authority, the harness queries the verified
checkout with `git rev-parse --show-object-format`, accepts only `sha1` or
`sha256`, and independently recomputes each committed blob ID over the exact
`blob <byte-length>\0<raw-bytes>` Git object representation. This covers the
complete executable `.mjs` snapshot, evidence schema, assertion registry, and
frozen lock. Any mismatch fails with a fixed diagnostic before substituted
bytes are parsed or executed.

The workflow embeds `windows-job-supervisor.cs` byte-for-byte. Before any local
harness module executes, Windows verifies the complete 16-module static and
runtime `.mjs` graph with trusted inline PowerShell, including
`phase1-process-supervisor.mjs` and `contract-canary.mjs`. Unix verifies the
same graph plus the four production shell/C helper sources before compiling or
executing them.
Its production job remains `platform-conformance`; the fresh validation, OIDC
attestation, and terminal confirmation jobs remain
`validate-conformance-artifacts`, `attest-conformance-artifacts`, and
`aggregate-conformance`. The Chat producer commit and tree are recorded only
after this commit is created; no SDK validator SHA is committed into Chat.

## Non-cyclic SDK handoff

The governed loader behavior is committed first. A separate Chat authority
commit then pins that prior behavior commit, its tree, and every changed
governed blob and SHA-256. After a Chat fix merges, a later SDK validator must freeze the
final reachable Chat authority commit/tree, package manifest, harness,
workflow, environment ID, and source/signer digests in a later validator
commit. Operators dispatch the already-committed Chat workflow with that full
SDK commit as `validator_revision`.

The workflow producer and executable harness are intentionally distinct
authorities. The workflow checkout remains at the final producer commit that
the SDK will pin. It supplies source identity and is cloned separately for the
SDK producer-contract check. The runner itself is fetched and executed from
the historical `harnessAuthority.revision/tree`; those exact harness modules
and native production deltas are verified before contract loading. Applying
historical harness checks to the workflow checkout, or producer-contract checks
to the historical harness checkout, is rejected rather than accepted as an
alternate SHA.

The pre-rebind SDK validator remains authoritative for its old producer and is
not evidence that a changed producer is compatible. Chat's always-on frozen
fixture proves only that the local Phase 1 lock matches the committed SDK
source contract, while the optional real-checkout integration continues to
exercise the exact SDK loader. The later SDK change must replace the producer
workflow size/SHA-256 and producer commit/tree metadata and retain the
validation and attestation job names, static artifact names and record paths,
pinned download and attestation actions, and protected environment variable
prerequisite. Chat's runtime `validator_revision` model remains unchanged, and
no SDK validator SHA is added to Chat.

The selected validator commit and tree, plus its contract and schema digests,
are recomputed from the exact clean checkout and embedded in the platform
record. The SDK aggregator still requires those values to equal the validator
checkout performing aggregation. No SDK validator revision is committed back
into Chat, so the two repositories do not form a commit-hash cycle.

The Unix supervisor reports a nonzero restricted producer exit status on stderr
before containment drain, retaining it even when cleanup subsequently fails.
This numeric status complements the bounded producer stage diagnostic; it does
not identify the failed authority check or establish successful containment.

Cave plugin-evaluation failures may report a fixed `.syntax`, `.type`,
`.reference`, or `.range` suffix when one recognized exception class follows
the Node evaluation marker. Unknown or conflicting classes retain the generic
plugin category. These IDs expose neither the exception message nor a source
path, and identify the exception class rather than the underlying plugin cause.

Windows harness directory quotas use the same isolated temp directory as the
producer (`TEMP` and `TMP`), below the bootstrap root. Checkout, Cargo, pnpm,
build, and execution quotas therefore cover the actual `phase1-conformance-run-*`
directories. This path correction preserves every reviewed byte limit. It does
not by itself identify the subtree responsible for an aggregate quota failure.

Windows Coven Rust observation failures report only a fixed test category and
failure category. The five test categories are `legacy-case`, `pipe-shapes`,
`profile-pipe`, `inspection-wait`, and `status-replacement`. Cargo compilation,
linking, resource, and process failures retain their existing bounded categories.
`tracking` identifies a child-ownership registration failure. Launch failures
report `spawn.enoent`, `spawn.eacces`, `spawn.eperm`, `spawn.einval`,
`spawn.e2big`, or `spawn.enomem` only when Node supplies that exact error code;
other launch errors retain `spawn` without disclosing their text.
`test-failed` requires a failed result for the exact selected test;
`not-observed` means a successful command did not report that test as passed.
Unknown command labels retain the generic stage. Raw stdout, stderr, assertion
messages, and private paths are never included. The selected tests, command
arguments, deadlines, and production limits are unchanged. These diagnostics
need a subsequent producer binding and protected run before the Windows cause
can be identified.

Child ownership accepts a recycled PID only after its former child has exited
or been signaled. A live PID collision remains an error. Termination removes
only the child instance it reaped, so an overlapping registration cannot lose
ownership. Cleanup retains the root and fails if children registered during
cleanup remain; an explicit cleanup retry handles those children.

Protected run `34413820955` passed Linux and Darwin, including all 110 Cave,
46 SDK, and 41 Chat assertions per platform. Windows stopped at
`phase1.runtime-observations.coven-rust-tests.legacy-case.spawn`; that producer
used the same category for launch and tracking failures. Local tests reproduce
stale PID registration and cover its repair, but do not prove it caused this
Windows failure. Fresh bound protected evidence is still required.

Protected run `34422000259`, attempt 1, used producer `6cf479d` and validator
`7ed9b19`. Linux and Darwin records passed provenance, scan, and exact assertion
checks: 110 Cave, 46 SDK, and 41 Chat assertions per platform. Windows passed the
first four selected Coven Rust tests, then reported `status-replacement.test-failed`.
Validation, attestation, and aggregation were skipped; no aggregate was accepted.

The status replacement diagnostic now recognizes fixed panic messages from the
selected test and reports only an `assertion` category: setup, reader open, early
result, result timeout or disconnection, writer error or join, readback, content,
or cleanup. The matcher requires the selected test failure and its panic header
in `discovery.rs`; unknown or unattributed output remains `test-failed`. An
`early-result` category means the test received a result before its 20 ms wait
expired. It does not distinguish writer success from writer failure. These
categories require a refreshed producer binding and new protected evidence;
they do not establish the cause of run `34422000259` retroactively.

## Windows quota monitor diagnostics

Native run `34627213499` isolated the reader failure above the isolated root:
ancestor index 3 denied attributes, while direct target reads returned one
1,024-byte file. The isolated root was at index 6. This distinguishes ancestor
metadata access from owner-directory enumeration and actual byte overflow.

Production accounting validates each fixed prefix through the isolated root as
the supervisor, preserving directory and reparse checks. It then expands and
measures only patterns constrained to that root under the validated isolated
user token. Outside-root and ambiguous path components fail closed; denied
subtree reads are never retried as the supervisor. Token duplicates remain
noninheritable and valid across account disablement, and admitted reads retain
their handle through disposal. These attribute checks preserve the existing
check/use behavior; they do not establish immunity to ancestor replacement.
Native run `34632027669` subsequently confirmed that only the implicitly
created `profile\AppData` directory denied enumeration; its parent and both
explicitly initialized children were readable. That intermediate directory is
now included in the existing security initialization and validation loop, using
the same trustees and access contract as its parent and children. Native reader
success and refreshed protected acceptance remain required.

Protected run `34580621067` passed Linux and Darwin, while Windows reported a
quota-monitor error followed by identity-cleanup failure. That does not prove
a byte quota was exceeded. The supervisor now retains only fixed categories:
`entry-bound`, `access-denied`, `arithmetic-overflow`, `io`, or `unexpected`.
The first monitor failure retains its category, normalized quota-root identifier
and filesystem operation through background monitoring and terminal rechecks.
Operation codes distinguish pattern attributes/enumeration, directory
attributes/enumeration, entry attributes and file length. Quota roots come from
an exact label allowlist; unknown labels and operations become `unknown`.
Original exception messages and paths are not retained in this context.
The workflow prints these bounded fields before cleanup can mask the primary
failure. Limits, failure exit status and cleanup requirements remain unchanged.
Fresh SDK workflow binding and protected validation are required before this
diagnostic change is adopted.

The initial category-only diagnostic was introduced at `220e9aa1e2a83ccd9ed32279fda26fe09ac98894`, tree
`ec79cb1416b2e443d0a413a309383099e18ce889`. It changes only the supervisor source
from the adopted GLib harness and is retained in the diagnostic branch ancestry.

## Windows identity cleanup diagnostics

The same run `34580621067` reported `Trusted Windows identity cleanup failed`
wrapping `Ephemeral Windows identity cleanup failed.` with no visible cause.
`WindowsIsolatedUser.Dispose` collects independent failures from up to eight
steps into one `AggregateException`, and PowerShell surfaces only the outer
message. The supervisor now names each failed step with a fixed category in
the message: `quarantine-check`, `quarantine`, `profile-delete`, `root-delete`,
`user-delete`, `user-survived`, `profile-survived`, or `root-survived`, each
paired with `win32-<status>`, `access-denied`, `not-found`, `io`,
`invalid-operation`, `timeout`, or `unexpected`. Categories are recorded in
step order and pair one-to-one with the retained inner exceptions. No exception
text, account name or path is recorded. The local user survival query now runs
even when deletion failed, so a refused deletion and a surviving account are
reported separately. Fail-closed behaviour, cleanup order and the disposed
state are unchanged. Whether cleanup failure is downstream of the preceding
quota termination cannot be established until both categories are disclosed in
one protected run.

`scripts/windows-identity-cleanup-diagnostics.test.ps1` checks the classifier,
drives the real `Dispose` path on an identity that was never provisioned with
compiled quarantine callbacks, and verifies category order, pairing, bounded
grammar, idempotent disposal and absence of leaked text.

The cleanup diagnostic was introduced at `85bc89b1b6d8ef5c099566b827146e0e75608beb`, tree
`b4d0e7445cafbdc33ff329d2d03c321ce2a9c2d9`. It changes only the supervisor source from the
status staging harness and is retained in the diagnostic branch ancestry.


The combined quota-context harness was introduced at `e8fe64b4d2b9bd38a03d8c23a28432518b41c187`, tree
`b8934b32dc6a1352df55bab36af6e261d0aa9e86`. It retains the merged staging and cleanup diagnostics.
Only the supervisor and its embedded workflow authority bytes change from
the cleanup harness; all production inputs, native deltas and limits remain
unchanged. Native Windows validation and a fresh SDK/protected binding remain
required.

Local validation of the combined quota-context diagnostic passed eight
PowerShell regression groups, including real denied enumeration, wildcard
enumeration, long-path failure, unknown-value sanitization and first-failure
propagation. The workflow regression confirms the primary diagnostic survives
a later cleanup failure. Final lock tests passed 92 cases with one platform
skip; workflow/specification tests passed 128 cases with 19 platform skips.
Independent specification, quality and final binding reviews passed. These
local results do not replace native Windows CI or protected execution.


## Isolated-user quota accounting

The scoped reader retains the validated standard-user token and duplicates a
noninheritable handle for each synchronous quota scan. It covers background,
final process and post-quarantine terminal accounting without extending the
account lifetime or changing directory ACLs. Active reads own their handles
across identity disposal; surviving monitors retain their state until the task
finishes. See [the native regression contract](windows-quota-reproduction.md).

The earlier owner-directory reproduction landed in #220 with full native CI.
This accounting implementation requires its own native Windows run, reviewed
SDK rebinding and fresh protected validation. The denied protected descendant
and separate cleanup `win32-3` remain open under #219.

## Windows cleanup delete diagnostics

Protected run `34611963297` disclosed the first cleanup categories:
`root-delete:win32-3,root-survived:invalid-operation`. Win32 status 3 is
`ERROR_PATH_NOT_FOUND` and, inside `DeleteDirectoryTree`, only the raw
`DeleteFileW`/`RemoveDirectoryW` calls raise it as a `Win32Exception`; the
managed enumerator had just returned the entry. The native calls now receive
the extended-length (`\\?\`) form of the managed full path so both layers
resolve the same entry regardless of `MAX_PATH` or trailing dot/space
normalization. A not-found status (2 or 3) is accepted only when the managed
layer confirms the entry is gone; every other disagreement still fails closed.
The retained `Win32Exception` carries fixed, path-free context appended to the
category as `win32-<status>[op=<operation>;kind=<entry>;depth=<bucket>;len=<bucket>;entry=present|gone;parent=present|gone]`.
Operations are `delete-file`, `delete-read-only-file`, `remove-reparse-file`
or `remove-reparse-directory`; depth buckets are `le4`, `le16`, `le64`, `gt64`;
length buckets are `lt260`, `lt1024`, `ge1024`. No names, paths or exception
text are recorded. Cleanup order, reparse rejection, read-only handling and the
`root-survived` invariant are unchanged.

`scripts/windows-cleanup-delete-diagnostics.test.ps1` checks the extended-path
forms, the bounded context grammar, the classifier suffix, the fail-closed
boundary for present and missing entries, and, on Windows, removes a real
tree containing a path longer than 260 characters, a trailing-dot component,
a read-only file and a directory junction whose target must survive.

The cleanup delete harness is pinned at `2a594dc5e6643a318fd9f1f660845646899a413d`, tree
`e21006a194ad73dda94c7f248dca32e91733f392`. It retains the quota-context harness ancestry;
only the supervisor, its embedded workflow authority bytes and the new regression change.
Native Windows CI removed the long-path/trailing-dot/junction tree through the
production walker; a fresh SDK/protected binding remains required.

## Bounded schema-v2 Cave authority failures

Protected retry `34667436672` used Chat #228 producer `f77b249` and SDK #211
validator `5730979`. Linux and macOS passed, with independently verified
identities, Cave timing and all 197 ordered assertions per platform. Windows
completed the observation suites and reported `phase1.cave-authority.startup`.
Validation, attestation and aggregation were skipped. The preceding exact-
authority run `34666399779` encountered an isolated fail-closed Windows quota
monitor read before the Cave harness; its retry did not reproduce that monitor
failure.

The schema-v2 diagnostic boundary now distinguishes command timeout, output
limit, spawn/tracking, supervisor termination, signaled exit, and nonzero exit.
Failed assertion markers yield only fixed Cave category names; unknown names
remain `assertion.unknown`, and duplicate markers yield `output.invalid`.
Record read failures and invalid JSON have separate fixed identifiers. Raw
child output, private paths and assertion text are not copied into public
diagnostics. Signal values are not disclosed. Unknown errors retain the generic
stage.

Marker-free nonzero exits now classify only allowlisted pre-assertion evidence:
Cave startup/readiness, filesystem cleanup syscalls, pairing
setup, bounded paging, request transport, or the last emitted phase marker
(setup, unconfigured, or configured). The classifier never publishes the
captured error message, endpoint, path, status body, token, or child output.

The startup category is now split into fixed timeout, early-exit, health,
missing-discovery, endpoint-mismatch and pid-mismatch identifiers. These values
correspond only to already fixed Cave harness messages and reveal no endpoint,
path, process identifier, response body or child output.

Protected run `34675842331` used Chat #231 (`395a5c9`) and SDK validator
`d5fcd88`. Linux and macOS passed; Windows reached a healthy Cave listener but
reported `phase1.cave-authority.startup.discovery.missing`. Cave #5374 fixes
the failing boundary at authority `82bf6831b4afbe82709a5fe78949d1b16c4d61e1`:
an already-owned Windows discovery directory can now have its inherited DACL
restricted without an unnecessary `WRITE_OWNER` operation. A genuinely foreign
owner still requires the existing takeover path, and the repaired owner and
DACL are still re-read and refused unless they are exclusive.

These diagnostics preserve existing commands, deadlines, resource limits,
record validation and assertion acceptance. They require a frozen harness and
SDK binding followed by fresh protected execution before applying a behavioral
Windows fix.

## Bounded Windows quota traversal depth

Protected run `34666399779` used Chat #228 (`f77b249`) and SDK #211
(`5730979`). Linux and macOS passed independently verified identities,
Cave timing and all 197 ordered assertions. Windows failed earlier, at
`access-denied; root=harness-execution-aggregate; operation=directory-enumeration`.
The run did not reach the new Cave diagnostic path. It does not establish a
Cave identity, timing or assertion mismatch, or a recurrence of the earlier
quota-reader token defect. Validation, attestation and aggregation were skipped.

Quota traversal now distinguishes `directory-enumeration-root`,
`directory-enumeration-depth-1`, `directory-enumeration-depth-2` and
`directory-enumeration-depth-3-plus`. Depth starts at each matched quota root,
including wildcard matches, and saturates at three. Pattern discovery retains
`pattern-enumeration`. Only these fixed operation labels cross the failure
boundary; directory names and original exception text remain discarded.
The first failure, isolated-user reader, accounting, reparse handling, limits
and fail-closed behavior are unchanged.

The native diagnostic regression denies enumeration at depths 0, 1, 2, 3 and 5
under direct and wildcard roots, exercises terminal and background monitoring,
and checks that later failures cannot replace the first depth classification.

Protected run `34670074847` used the merged quota-depth producer
`5f4572c45e19bc17fa8963fb8147b47bc8d0c31c` and SDK validator
`33240b9ff5212b1aec0f7f34173cdf899174769e`. Linux and macOS again passed
independently verified identities, Cave timing and all 197 assertions. Windows
failed closed at `access-denied; root=bootstrap-aggregate;
operation=directory-enumeration-depth-3-plus`. Validation, attestation and
aggregation were skipped. The failure is inside the isolated bootstrap root,
but the aggregate quota still masks which fixed subtree was being measured.

The next bounded diagnostic adds `scope` and `repeat` fields without changing
the failure decision. For the bootstrap aggregate only, `scope` is selected
from fixed names for the root, profile, temp, status staging, workspace,
downloads, reviewed tool extractions, rustup, Cargo stores, pnpm/npm stores,
counterpart checkouts, or `other`. Exact path components outside that closed
set are never retained or emitted. The scope is attached to directory
attributes, enumeration, entry attributes and file-length failures for the
current bounded traversal node.

After an initial metadata failure, the same validated isolated-user token
performs one immediate bounded repeat. `transient` means that repeat returned
or the target disappeared; `persistent` means it threw again. Enumeration
creates a fresh enumerator, entry attributes use a fresh static metadata read,
and file length uses a fresh metadata object, so each repeat reaches the
filesystem again. The original failure still terminates production in either
case. Synthetic or unattributed failures use `none`. Initial enumeration metadata and byte accounting are unchanged; fresh metadata
is requested only by the diagnostic repeat. Supervisor prefix validation and
non-isolated reads remain single-pass. The repeat never uses the
supervisor identity, changes an ACL, accepts a partial measurement, or retries
production. Existing quotas, traversal bounds, reparse handling, first-failure
state, cleanup and acceptance remain unchanged. Supervisor-identity validation
performs only the original read and reports `repeat=none`. Native regression
coverage verifies the closed scope vocabulary, repeat propagation, unknown
fallback and absence of private nonce or exception text.
