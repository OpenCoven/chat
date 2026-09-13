# Bounded Windows supervisor source

The workflow uses the bounded source block. SDK producer rebinding and fresh
protected validation remain deployment gates. Native Windows verification of profile-root alignment and protected
three-platform acceptance remain open.

At the compression checkpoint, the inline form occupied 511,778 bytes of GitHub's 512,000-byte workflow
allowance. The initial bounded form occupied 161,836 bytes and retained the same 329,668
bytes of C#. The source renderer in `scripts/windows-supervisor-source.mjs`
recovers space for the profile lifecycle and shared quota repair. The canonical C# remains
`scripts/windows-job-supervisor.cs`; compression does not change its behavior.

The renderer uses level-9 gzip with a zero timestamp and a platform-neutral OS
header byte. Generate and verify with the reviewed Node 24.18.1 toolchain and its
matching zlib implementation. Exact canonical verification intentionally rejects
alternate compressor output. Cross-platform CI must verify this property before
protected deployment; normalizing the header alone is not that proof.

The PowerShell block checks compressed length and SHA-256 before decompression,
then reads into an allocation bounded by the reviewed source size. It rejects a
short or oversized result and checks the plaintext digest and strict UTF-8 before
assigning `$jobSupervisorSource`. It disposes both streams. The existing C#
compilation call belongs after this block.

The Node decoder requires an independently supplied source size and digest. It
bounds decompression to that size, verifies the bytes and requires exact canonical
re-rendering of the entire block. That comparison rejects changed decoder code,
extra statements, alternate gzip encodings, trailing padding and concatenated
streams. Runtime hash literals are not an independent source of authority.

## Verification and remaining deployment gates

- Chat workflow tests extract exactly one block and bind its source identity to
  the unchanged canonical C# blob; existing frozen source checks remain in place.
- Existing supervisor assertions operate on verified decoded plaintext.
- Verify the complete execution path, including the subsequent compilation call;
  reject later source reassignment or alternate compilation.
- Update Chat and SDK verification and exact workflow fixtures together before
  dispatching the changed workflow. Retain negative mutation tests for the decoder
  and its execution path.
- Windows CI checks the committed payload with the pinned Node compressor and
  compiles the full decoded C# in PowerShell, alongside existing native supervisor
  behavior tests. Successful local compilation alone is not Windows runtime proof.
- Verify actual profile-root alignment and shared aggregate accounting natively,
  with existing quotas unchanged, followed by fresh protected validation of all
  three platforms.

Chat #249 moved fixtures beneath a predicted profile path without adding that
subtree to the shared aggregates. The lifecycle and accounting repairs below
require native verification before this producer is dispatched.

## Owned profile lifecycle repair

The follow-up source creates the fresh account profile with `CreateProfile`,
records ownership before any subsequent validation, and checks the returned path
against the retained token. Initialization failures delete the owned profile
before removing the account. The native fixture exercises that production catch
and verifies profile-directory, registry, account, and artifact-root removal.

The accounting follow-up atomically creates `.coven` with a strict application
ACL and retains handles for that directory and its profile ancestor. Profile
owner/writer validation matches native discovery; application ACL validation
requires the exact isolated-user, SYSTEM, Administrators and OWNER RIGHTS rules.
The supervisor checks current path identities, type and security before and
after each aggregate measurement under the retained isolated token.

Only the exact bootstrap and harness aggregates include application bytes, using
their existing 12 GiB and 10 GiB ceilings and one remaining-byte budget per
aggregate. Component quotas retain their existing behavior. The supervisor owns
cleanup: failed quarantine retains the token and pins for retry; successful
quarantine and terminal accounting precede pin release and profile deletion.
The producer no longer recursively removes the pinned application directory.

The prior 30-second native readiness and 40-second RPC deadlines are restored.
The previous unknown failure did not establish a need to increase them.

These changes require native Windows verification, actual-merge SDK rebinding,
and fresh protected validation. Local compilation and arithmetic tests alone do
not establish the filesystem, ACL, quarantine or three-platform guarantees.
