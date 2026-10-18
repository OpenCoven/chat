# Windows quota repeat outcomes

Protected run [34720763619](https://github.com/OpenCoven/chat/actions/runs/34720763619)
failed Windows before native launch with access denial at `bootstrap-npm-cache`,
`directory-enumeration-depth-3-plus`, and `repeat=transient`. That historical
label combines a successful follow-up read with a missing file or directory.
Neither outcome identifies the cause of the original denial.

The supervisor separates the result of the existing single immediate
follow-up read:

- `readable`: the follow-up callback returned successfully.
- `missing`: it threw `FileNotFoundException` or `DirectoryNotFoundException`.
- `persistent`: it threw another exception, which need not match the first
  error. This label has since been split by the second exception's category
  (see below).
- `none`: no diagnostic follow-up was requested.

Protected run
[34773356378](https://github.com/OpenCoven/chat/actions/runs/34773356378)
later failed while Cave was being built with `access-denied`,
`root=cave-checkout`, `directory-enumeration-depth-3-plus`, and
`repeat=readable`. The monitor had discarded a fresh complete snapshot produced
by the same bounded traversal immediately after the first enumeration failure.

Directory enumeration now accepts only that `readable` result. The retry uses
the same validated isolated-user token, directory, search pattern, entry limit,
reparse rejection, and byte-accounting path as the first attempt. The first
attempt's partial list is discarded; only a fresh traversal that completes
under the existing bounds can become the measurement. There is no wait, third
read, identity switch, permission change, or resource-ceiling change.

`missing` and every `persistent` repeat remain terminal, as does every initial
failure other than `UnauthorizedAccessException`. Attribute and file-length reads keep
their existing fail-closed diagnostic-only repeats. The terminal check performs
the same bounded recovery and still rejects any path that cannot produce a
complete readable snapshot.

Protected run
[35146928092](https://github.com/OpenCoven/chat/actions/runs/35146928092)
then failed with `access-denied`, `root=harness-execution-aggregate`,
`scope=checkouts`, `directory-enumeration-depth-3-plus`, and
`repeat=persistent`. That label was as uninformative as `transient` had been.
Both repeat sites classified every non-missing second exception with a bare
`catch`, so `persistent` covered at least three different outcomes:

- a second `UnauthorizedAccessException`, the only case the label suggests;
- `QuotaEntryBoundException`, thrown when a snapshot reaches its entry limit.
  `MaximumQuotaEntries` is one budget for the whole traversal of a root, not a
  per-directory cap: `MeasureDirectoryBytes` counts entries once per root and
  passes the remainder into each enumeration, so once the budget is spent the
  bound fires on the first entry of every later directory, whatever its ACL;
- another `IOException`, for example from concurrent mutation of the checkout
  while the traversal runs.

The repeat label now carries the second exception's category, using only the
fixed categories the monitor already reports for a first failure:

- `readable`, `missing`, and `none` are unchanged.
- `persistent-access-denied`: the follow-up threw a second
  `UnauthorizedAccessException`.
- `persistent-entry-bound`: the follow-up threw `QuotaEntryBoundException`; the
  traversal-wide entry budget was already spent when this directory was read.
- `persistent-io`, `persistent-io-file-not-found`,
  `persistent-io-path-not-found`, `persistent-io-sharing-violation`,
  `persistent-io-lock-violation`, `persistent-io-name-too-long`,
  `persistent-io-invalid-directory`, `persistent-io-delete-pending`: the
  follow-up threw an `IOException`, classified by the same reviewed Win32
  HRESULT table as an initial I/O failure.
- `persistent-arithmetic-overflow` and `persistent-unexpected`: the remaining
  first-failure categories, applied to the follow-up.
- `persistent` is still accepted by the context normalizer for records
  produced before the split; the supervisor no longer emits it.

Both catch sites map through one helper, `ClassifyPersistentQuotaRepeat`, which
prefixes `ClassifyQuotaMonitorError` of the second exception. Any value outside
the fixed list normalizes to `none`, so no exception text or path can enter the
label. The first failure's category is preserved: a denial followed by an
entry-bound repeat still reports `access-denied` with
`repeat=persistent-entry-bound`. The change adds no read, wait, identity switch,
permission change, or change to `MaximumQuotaEntries` or any other ceiling.

Regression coverage:

- **Managed:** both missing exception types, a successful metadata follow-up,
  repeated access denial, and a different second error.
- **Per-seam matrix:** both production seams are driven through one injected
  second failure at a time, covering every normalized repeat label: a second
  denial, an entry-bound exception, generic I/O and each classified I/O
  HRESULT, arithmetic overflow, both missing types, and an unexpected
  exception. Each must keep its own label after exactly two calls.
- **Spent entry budget:** a real directory read over a spent entry budget must
  report `entry-bound` with `repeat=persistent-entry-bound` through the
  production enumeration path without any injection.
- **Snapshot:** a separate regression requires exactly two calls and verifies
  that the accepted result contains the complete fresh directory contents.
- **Native Windows:** coverage first holds a real owner-only ACL denial across
  both reads and requires the bounded `persistent-access-denied` failure. The
  isolated-reader fixture then denies the validated isolated identity,
  temporarily reverts only for the fixture ACL restoration, verifies
  impersonation is restored before the second enumeration, and requires two
  identity-checked reads to return the complete fresh snapshot. A subsequent
  512-byte limit check proves the production accounting path still enforces
  the byte quota.

Status (2026-10-18): the split labels ship in `scripts/windows-job-supervisor.cs`.
The split between `readable` and `missing` passed local diagnostic tests after
a demonstrated failing regression. The managed diagnostic file, including the
per-seam repeat-outcome matrix and the spent-budget check, passed on macOS under
PowerShell 7.6.6 on .NET 10, and the `windows-supervisor-behavior` job passed on
`windows-2025` for PR #338 in run
[35561671518](https://github.com/OpenCoven/chat/actions/runs/35561671518).
Which cause fired in protected run 35146928092 was never proven: that record
says only `persistent`, and this change did not repair the underlying denial.
The protected lane first passed on Windows in run 36033589858 on 2026-09-24, and
the latest protected run, 36222464391 on 2026-09-26, also passed. A later protected
failure here would report `persistent-entry-bound`, `persistent-access-denied`, or
a `persistent-io-*` label. This diagnostic did not change the reviewed frozen-source
binding or SDK rebinding. It tracked Chat #219, which closed on 2026-09-24, and
Beads `cave-k0aqq.2` (Beads was retired on 2026-09-14).
