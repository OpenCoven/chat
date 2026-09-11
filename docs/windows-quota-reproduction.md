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
