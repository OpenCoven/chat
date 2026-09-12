# Windows profile lifecycle prerequisite

The native discovery reader uses the current token profile, while the scenario
fixture currently publishes under the artifact root. The root-alignment repair
must resolve actual profile identity, account for new application state under
the existing aggregate ceiling, and remove the owned profile on every exit.

`scripts/windows-profile-lifecycle.test.ps1` tests the profile lifecycle
prerequisite in the Windows supervisor suite. It uses a fresh isolated account,
explicit `CreateProfile`, and `GetUserProfileDirectoryW` on the retained validated
token. A bounded child independently queries its token profile while `HOME` and
`USERPROFILE` still point at the redirected artifact profile. All three paths
must agree. Duplicate creation must return the documented already-exists HRESULT.

A separate fresh account injects failure immediately after successful creation.
The fixture retains the returned path before verification, disposes any child
Job, calls the real profile deletion helper with the actual path, disposes the
account context, and verifies that profile and workspace paths are missing.
Errors retain fixed stage categories and numeric HRESULTs; paths and child
output are not printed.

Local parsing and compilation cannot establish Windows API behavior. Native CI
must prove this prerequisite before the production root-alignment repair uses
it. This fixture changes no production profile creation, quota roots, accounting
limits, native identity checks, source pins, or validator scopes. It does not
establish publisher/reader alignment or protected Windows acceptance.

API references: [CreateProfile](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-createprofile)
and [GetUserProfileDirectoryW](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-getuserprofiledirectoryw).

Tracks `cave-k0aqq.3`. Preserve the chat and active worktrees.

The first native attempt, [CI34718542782](https://github.com/OpenCoven/chat/actions/runs/34718542782),
failed at `profile-create` with HRESULT `800706F7` before token or child checks.
That HRESULT wraps `RPC_X_BAD_STUB_DATA`; it does not indicate resource exhaustion.
The corrected fixture uses a 260-character creation output buffer and explicit
output marshalling, while retaining dynamic token-query buffer sizing. This is
a bounded interop hypothesis requiring fresh native validation; the published
CreateProfile contract does not state an internal RPC capacity range.
