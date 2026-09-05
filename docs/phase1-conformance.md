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

- Chat production `edd4728792321771496df58bfc0e6122908a96ec`, tree
  `c373902b48b06520450f520e669a34f72b64a35d`, the frozen SDK source
  authority;
- SDK package candidate `acc38488f00860d246c3c553375634d64806eabb`;
- Cave authority `6325fc4c1154c7d7398074a9760a2e2dc323b424`, tree
  `9144939792d3dbdd91c208d7e2abc5ecc0eac089`, release `0.3.12`;
- Coven producer/client `721437b84026c042e431b0882dcd14fdb29ac07d`;
- Chat conformance driver support at the exact `harness.revision` and
  `harnessAuthority.tree` generated from the preceding code/integration
  commit;
- SDK evidence contract and registry
  `4736bf2e0d5b16272d79ecf7784c75f376b39b94`;
- manifest digest
  `b8bfb62236fc8add4a9baad9f00e5401db15074a2d21fe2847a9158104cefb3c`;
- canonical package order, release/vendor paths, sizes, and SHA-256 digests.

Chat's Phase 1 source lock now agrees with the frozen Cave and Chat source
contract committed in SDK validator
`933a9523ccbee071417eca01b8a7a37e54d6cbc0`. This is source-authority
compatibility only. SDK 933 still names Chat producer
`4dc8f64bb71634a01ee647542dcdafdd0888b4f9`, while SDK #100 currently binds
Chat `95de47f7aa2bf8233f71a601ad16011a82905e41`; neither is the final producer
identity for this fix. Full producer compatibility and provenance remain
blocked until this Chat change merges, a reachable authority commit pins the
final behavior commit, and the SDK validator is rebound to that final
post-merge Chat authority commit.

The evidence record names the SDK evidence-authority commit because the SDK
aggregator binds its committed registry to that commit. The package candidate
remains independently pinned by revision, manifest digest, and tarball bytes.
The runner verifies that the evidence-authority commit descends from the
candidate and that all four candidate source package identities match the
frozen manifest. It never rebuilds replacement per-platform SDK tarballs.

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
entries from the verified lock, fetches the historical harness commit plus all
five counterpart checkouts with pinned Git inside the Job, and then passes
those roots to the relocated runner. Producer identity is always recomputed
from the supplied workflow Chat checkout rather than the runner module path.

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
GitHub `windows-2025-vs2026` x64 image at exact image version
`20260824.214.3`,
Windows build `26100.33296`, `kernel32.dll` file version
`10.0.26100.33296`, PowerShell `7.6.5` at
`C:\Program Files\PowerShell\7\pwsh.exe` with its bundled .NET runtime
`10.0.11`, Visual Studio Enterprise 2026 `18.9.12112.369` at
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
release tag `win25-vs2026/20260824.214` at commit
`8c3c8c0bf0068534d87e970a58b590522f1dc1a5`.
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
protected checkout's Git objects, 768 MiB for each SDK/Chat/Cave/Coven/
validator/producer checkout, 4 GiB for harness build roots, 2 GiB for the
workspace, 10 GiB for the harness execution root, and 12 GiB for the complete
bootstrap root. Quotas are rechecked after the root process exits and again
after exact-SID quarantine so a last-moment or out-of-Job excess cannot escape
the watchdog. Each scan materializes only a bounded number of entries through
bounded enumeration and ignores only file/directory disappearance races caused
by concurrent producer cleanup; permission failures, malformed paths, bound
exhaustion, overflow, and other monitor errors still terminate the Job fail
closed. Failures report either the fixed reviewed quota label or a path-free
quota-monitor error.

The child receives a constructed environment rather than the runner
environment. It contains no GitHub token, OIDC request value, Git credential,
Cargo credential, or proxy setting. Git disables system/global configuration,
credential helpers, prompts, replacement objects, and non-HTTPS fetch
protocols, and enables fetched-object verification. Downloads use a proxy-free
.NET `HttpClient`, allow only HTTPS, permit at most the reviewed per-asset
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

### SDK verification metadata for this producer

The later SDK validator repin must use these exact committed file bytes:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `.github/workflows/client-v1-conformance.yml` | 462,200 | `a9a6a60745a7e97b879642c245a452977b54c1daac2c1fef0740c577aaac3ff8` |
| `scripts/contract-canary.mjs` | 38,854 | `34660590c56949ce5f211bbe7c683fabb052817f356ac09c192ede945025e4a5` |
| `scripts/executable-resolution.mjs` | 9,154 | `31e3c412ff8c835f14522f36a59e91f4a4ba82913210ae8e3b4455217503f430` |
| `scripts/owned-temp-directory.mjs` | 6,965 | `a9c55c85cf2b7d70310d278bafd2c8e7695d66f4ae38b9c3f1f12fce0b442095` |
| `scripts/phase1-artifact-secret-scan.mjs` | 21,183 | `be0ec302b9c4372f232d6bd1efcba873fd3380cc5de7f756cd0b9eeeec07222a` |
| `scripts/phase1-conformance-lock.mjs` | 48,419 | `dc0efc1a8f7a5434451271ad2bdbd5ec2b2a7eeb77d3fcd27bf19752bf2b5ebd` |
| `scripts/phase1-conformance.mjs` | 188,291 | `0684a3622804ab664336145837a75d98bc6bfef1eee6b533a9fdcbab73e6b110` |
| `scripts/phase1-evidence-contract.mjs` | 15,088 | `24180ae03835fa6aac45559682adb3c1e626bab76466eddc55b9e2300f0a2b7f` |
| `scripts/phase1-evidence-runtime.mjs` | 6,078 | `3d227c354e6d908c5912d2b8244336e3b79c3bbd4dec79b0ad219ed65b8cb159` |
| `scripts/phase1-linux-secret-service.mjs` | 4,270 | `ddf834c6f57853c5116b4b1f345952a218ff0687c5d741737c68e20bc2ecda92` |
| `scripts/phase1-macos-keychain.mjs` | 5,091 | `ab0c2dd08cf606d9502f5da206175707d471d99f484e8c8c79b5b08a5772b9a4` |
| `scripts/phase1-process-supervisor.mjs` | 3,820 | `16b51fb1a33b4bfef98daca549aacf5dc2d2c098cfbd664753b69c940d1e6f6c` |
| `scripts/phase1-schema-v2-evidence.mjs` | 51,642 | `a7cab994aa0ee97baceb4b2c475ec1ff253ae5681f39e2c3d15fb1035b2d2387` |
| `scripts/phase1-schema-v2-producer.mjs` | 141,610 | `275cef71387f9a7b725ef5eda5b0ecb7e47208777ff2b59972d50bd1edd75d10` |
| `scripts/process-owned-artifact-root.mjs` | 11,205 | `9ee158453044cd57b91c77c50262092a91993c6b1533b6584c61e1cbadfd794a` |
| `scripts/supervised-exec.mjs` | 2,875 | `a5edfd985b934d3b46247a0da3141682c411d30bb582edf87ae7b29791dad65b` |
| `scripts/supervisor-status.mjs` | 854 | `ac332ca7b6b040ecc846088bb3a6ad5e7112a0454eb3ea71d2a819d55e64254e` |
| `scripts/phase1-linux-secret-service.sh` | 5,650 | `83ce19c0dd6da5002f6853fa37addb4fc2d39f3d17beee1b1c39e1fce232b476` |
| `scripts/unix-artifact-handoff.c` | 18,704 | `2a003f9aa1d1886b9a593371a73cb65fe3a4a8b703f1c59fec8a27694367b7fc` |
| `scripts/unix-producer-command.sh` | 3,223 | `ce9ec2ff00947f3ec0db53f144c99d34bc27de6085062d00dccff7c934c2e3c8` |
| `scripts/unix-producer-supervisor.sh` | 29,087 | `d14f65fa32c82b33ecee6224dc79c86857c2d8d28965e3fb259578baf41d7a0d` |
| `scripts/unix-producer-supervisor-attack.c` | 6,211 | `e485ebebb6570b06f179c03a3849224d59d96400b7cadd5547067cce35239642` |
| `scripts/unix-producer-supervisor.test.sh` | 13,348 | `a8c6f48915b0c86a704a7ddc28eaa7f808ae0a3ddfcdb38c0c23ac0d83738f6d` |
| `scripts/phase1-windows-supervisor-build.sh` | 4,646 | `713a9e0282887ade3e243b5ba175794d74cdb02c28c38dcd41491c9505812770` |
| `scripts/phase1-windows-supervisor-install.ps1` | 1,743 | `2baab275f0bb6789884cded5f6185d00bfa5348b9e7c3ad1e5575353639101d5` |
| `scripts/windows-job-supervisor.cs` | 291,329 | `08c18fa81b16f922b3fac32abec3a2f6369e5f2b9f4caa19a0b48df6302bb110` |
| `scripts/windows-job-supervisor.test.ps1` | 171,179 | `55e9cf065e2dc7cc656c6aa8cc9ea53542259d3d7eee55c368c6cf0fc6356ab9` |

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
governed blob and SHA-256. After the Chat fix merges, SDK #100 must freeze the
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
not evidence that this PR head is producer-compatible. Chat's always-on frozen
fixture proves only that the local Phase 1 lock matches SDK 933's committed
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
