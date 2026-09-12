# Bounded Windows supervisor source

Status: preparatory implementation; not yet adopted by the protected workflow.
Windows profile-root alignment and protected three-platform acceptance remain open.

The protected workflow currently embeds 329,556 bytes of readable C# and occupies
511,638 bytes of GitHub's 512,000-byte workflow allowance. The source renderer in
`scripts/windows-supervisor-source.mjs` prepares a compressed literal to recover
space for the profile lifecycle and shared quota repair. The canonical C# remains
`scripts/windows-job-supervisor.cs`; compression does not change its behavior.

The renderer uses level-9 gzip with a zero timestamp and a platform-neutral OS
header byte. Generate and verify with the reviewed Node 24.18.1 toolchain and its
matching zlib implementation. Exact canonical verification intentionally rejects
alternate compressor output. Cross-platform CI must verify this property before
workflow adoption; normalizing the header alone is not that proof.

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

## Adoption requirements

- Extract exactly one block from the trusted workflow and bind its source identity
  to the independently reviewed frozen C# blob.
- Preserve all existing supervisor assertions over verified decoded plaintext.
- Verify the complete execution path, including the subsequent compilation call;
  reject later source reassignment or alternate compilation.
- Update Chat and SDK verification and exact workflow fixtures together before
  dispatching the changed workflow. Retain negative mutation tests for the decoder
  and its execution path.
- Obtain native Windows validation of the full supervisor. Local PowerShell
  compilation proves decoding and C# syntax, not Windows runtime behavior.
- Then implement actual profile-root alignment and shared aggregate accounting,
  with existing quotas and fail-closed behavior unchanged, followed by fresh
  protected validation of all three platforms.
