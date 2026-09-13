# Bounded Windows supervisor source

The workflow uses the bounded source block. SDK producer rebinding and fresh
protected validation remain deployment gates. Windows profile-root alignment and
protected three-platform acceptance remain open.

The previous inline form occupied 511,778 bytes of GitHub's 512,000-byte workflow
allowance. The bounded form occupies 161,836 bytes and retains the same 329,668
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
- Then implement actual profile-root alignment and shared aggregate accounting,
  with existing quotas and fail-closed behavior unchanged, followed by fresh
  protected validation of all three platforms.

Concurrent Chat #249 moves fixtures beneath a predicted profile path without
adding that subtree to the shared aggregates. Its production profile ownership
and accounting gaps must be repaired before this producer is dispatched.
