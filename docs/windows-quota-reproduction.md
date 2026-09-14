# Windows quota directory reproduction

[Issue #219](https://github.com/OpenCoven/chat/issues/219) tracks the protected
Windows failure from run
[34611963297](https://github.com/OpenCoven/chat/actions/runs/34611963297):

```text
access-denied; root=harness-execution-aggregate; operation=directory-enumeration
```

The bounded diagnostic identifies the selected quota and filesystem operation.
It does not identify the denied descendant or establish a byte-quota breach.

## Native fixture

The existing Windows supervisor CI job invokes
`scripts/windows-owner-directory-quota.test.ps1` through the full supervisor
test suite. The fixture requires native Windows and the same account-provisioning
privileges as that suite. It can also run directly from the repository root:

```powershell
pwsh -NoLogo -NoProfile -NonInteractive -File scripts/windows-owner-directory-quota.test.ps1
```

The fixture creates a temporary isolated account and a directory containing a
known-size file. It checks readable-directory accounting, assigns the isolated
account as owner with Coven's protected owner-only directory DACL, and calls the
real terminal and background quota paths. The expected characterization is the
same bounded access-denial signature above. After restoring the fixture ACL, a
smaller quota must report an actual byte breach. A noninheritable directory handle
opened before ACL restriction retains restoration access and the original owner,
DACL and inheritance protection. Teardown restores fixture access
and removes the account and root, retaining any failures.

A matching result proves that this ACL shape can cause the observed monitor
failure. It does not prove that Coven, or any specific descendant, caused the
protected-run failure. A different result rejects this reproduction hypothesis
and must be investigated before selecting a repair.

## Separate cleanup result

The same protected job reported:

```text
root-delete:win32-3,root-survived:invalid-operation
```

This is a separate cleanup failure. The directory fixture does not reproduce it.
Investigate the native removal path, including path handling and missing or
replaced descendants, while preserving reparse safeguards and the requirement
that the owned root is actually removed.

The reproduction changes no production quota limits, private ACL rules, frozen
source bindings or validator scopes. A repair still requires native regression
proof, reviewed source and SDK binding updates, and fresh protected acceptance.

## Isolated quota reader

The accounting repair retains the standard-user token after its existing SID,
account, group, integrity and privilege validation. Each synchronous filesystem
scan duplicates that private token into a noninheritable handle, impersonates
only for the scan, then disposes the duplicate. Background, final process and
post-quarantine terminal scans use the same bounded directory walker.

The retained token supports terminal accounting after account disablement; no
new logon or delayed quarantine is needed. Identity disposal closes admission to
new reads, while an already admitted read owns its handle through completion.
If a monitor survives its existing bounded teardown wait, its cancellation and
failure state are disposed only when that task finishes.

`scripts/windows-quota-isolated-reader.test.ps1` checks owner-only directories
below and above quota, the actual terminal producer path, post-disable reads,
exception restoration, an unreadable supervisor-private directory, and a read
held across identity disposal. `scripts/windows-quota-lifetime.test.ps1` checks
state lifetime with an incomplete monitor and an already completed monitor.
The unimpersonated characterization still requires supervisor access denial;
private directory permissions are not expanded.

Native Windows results and a fresh protected run are required before treating
this repair as accepted. The separate protected cleanup `win32-3` failure and
the exact denied descendant remain unresolved by this change.

## Delete-pending attribute characterization

Protected run [34714716267](https://github.com/OpenCoven/chat/actions/runs/34714716267)
failed Windows bootstrap accounting with `access-denied`, root
`bootstrap-aggregate`, scope `temp`, operation `directory-attributes`, and
repeat `persistent`. The repeat label means a second non-missing-path exception;
it does not prove the second error was another permission denial.

The test-only `scripts/windows-quota-delete-pending.test.ps1` runs immediately
after the owner-directory fixture in the Windows supervisor suite. It uses a
retained, noninheritable handle and `RemoveDirectoryW`, then verifies the
handle's `FILE_STANDARD_INFO.DeletePending` and directory flags. It observes
`File.GetAttributes` and the real `MeasureDirectoryBytes` traversal while that
handle remains open. Readable baselines and an explicit directory-listing and attribute-read denial
with handle-based ACL restoration provide separate controls. No raw paths,
SIDs, ACLs, or exception text are printed; I/O observations retain numeric
HRESULTs. Closing the retained handle must make the path missing, verified
with `GetAttributes` rather than `Directory.Exists`.

A matching managed error demonstrates that a known deletion lifecycle can
produce that signature; it does not identify the protected run's descendant.
Missing, readable, or different I/O outcomes are explicitly inconclusive for
this reproduction. Native Windows results are required. This fixture changes
no production reads, retries, accounting limits, access rules, or source pins.

Windows documents deletion-on-last-handle-close in the
[RemoveDirectoryW contract](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-removedirectoryw).

The first native experiment in [CI34715434276](https://github.com/OpenCoven/chat/actions/runs/34715434276)
verified the pending-deletion state, then observed `attributes=missing` and
`quota=readable`. It did not reproduce the protected failure. Its initial
attribute-only deny control also observed readable attributes and traversal,
so that control was invalid and the test failed. The corrected control denies
both `FILE_LIST_DIRECTORY` and `FILE_READ_ATTRIBUTES`, requires quota rejection,
and records the attribute observation independently. Native verification of
this corrected control remains required; neither fixture identifies the
protected descendant's cause.

## Complete readable snapshot recovery

Protected run
[34773356378](https://github.com/OpenCoven/chat/actions/runs/34773356378)
failed during the Cave build with `access-denied`, `root=cave-checkout`,
`directory-enumeration-depth-3-plus`, and `repeat=readable`. This establishes
that the same isolated identity could complete a fresh enumeration immediately
after the first attempt failed. It does not identify the private descendant or
prove whether build-directory replacement, deletion completion, or another
filesystem transition caused the first denial.

The accounting defect was that the monitor discarded that complete fresh
snapshot and terminated the producer. The repaired enumeration path accepts a
second result only when the first failure is `UnauthorizedAccessException` and
the second invocation of the same bounded snapshot core completes. A missing
or failing repeat still throws at the snapshot boundary. The later whole-pass
recovery described below can restart a qualifying isolated measurement.
Non-access-denied failures and non-directory metadata reads preserve the
diagnostic-only repeat behavior at the individual-read boundary.

The native fixtures supply deterministic controls without changing production
ACLs. The owner-directory fixture keeps a real owner-only denial in place for
both enumerations and requires `repeat=persistent`. The isolated-reader fixture
then applies a real enumeration denial to the validated isolated identity,
checks both recovery callbacks run under that identity, temporarily reverts
only to restore the fixture ACL, verifies the retry is back under the isolated
identity before enumerating, and requires the fresh complete snapshot.
Independent terminal checks below and above the byte limit exercise the
production accounting path. It retains the existing path, entry, byte,
reparse, process, output, and time bounds.

## Denied enumeration followed by a missing path

Attempt 2 of protected run
[34796638173](https://github.com/OpenCoven/chat/actions/runs/34796638173/attempts/2),
at producer `7ec15b20b5526ef809c8f237a4dab1f640cb8a4d`, reported
`access-denied; root=cave-checkout; scope=none;
operation=directory-enumeration-depth-3-plus; repeat=missing`.
It also reported the separate cleanup failure
`profile-delete:invalid-operation,profile-survived:invalid-operation`.
This is not the original `io`/`persistent` result, nor the
`discovery-not-found` failure recorded for attempt 1.

The missing follow-up does not supply a complete readable snapshot. The
snapshot reader therefore retains the original access denial and throws.
It does not establish whether the directory was deleted, renamed, or became
unreachable through a changed ancestor.

The portable quota diagnostic fixture now follows an injected initial denial
with a real enumeration of a removed fixture directory. It requires the
`missing` label, exactly two reads, no private exception text, and preservation
of the first failure in the monitor state. The native isolated-reader fixture
also stages a real listing denial, then restores and deletes only its own
fixture before the repeat. Both reads must run as the isolated identity, and
the supervisor identity must be restored after the failure.

The native fixture requires Windows execution before its outcome can be
claimed. Even a matching result would establish only that this controlled
transition can produce the signature, not the cause of the protected-run
failure. These reproduction changes do not alter production traversal,
missing-path acceptance, retries, ACLs, quota limits, frozen authority
bindings, or cleanup policy.

## Whole-pass recovery and the subsequent protected result

PR #267, merged at `92c4c453b57b2f9365627f01ec883f98aa8b7ba3`,
added `MeasureDirectoryQuotaWithRemovalRaceRecovery`. For an isolated
measurement that fails with exactly `access-denied` and `repeat=missing`,
it restarts the entire selected quota measurement once, including prefix
validation, pattern expansion, and isolated-token accounting. It does not
accept the failed snapshot or reuse its partial byte total. A fresh byte
breach still fails production; any second-pass exception is terminal.
Other failure categories and repeat classifications do not trigger this
whole-pass retry.

The portable reproduction passes its real missing-snapshot error through
that recovery boundary. It checks both below-limit and over-limit replacement
results, rejection of nonqualifying failures, and termination after a second
removal race. This complements the snapshot-level and native-identity cases;
it does not establish the cause of the historical checkout race.

Protected run
[34833377609](https://github.com/OpenCoven/chat/actions/runs/34833377609),
using that merged producer, reached `phase1.cave-authority.startup.exit`
instead of reporting a quota-monitor failure. This diagnostic means the Cave
authority reported an exit before readiness; it does not identify the exit's
underlying cause or establish a permanent quota repair.

Its separate cleanup result was
`profile-delete:profile-remained[delete=accepted;registry=0;expected=1;actual=1]`,
followed by `profile-survived:invalid-operation`. The deletion API accepted
the request and the profile registration was absent, but both directory
existence observations remained true. Those flags need not refer to different
directories. Startup failure and residual profile cleanup remain unresolved;
neither is evidence of a directory-depth quota.
