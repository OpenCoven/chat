# Windows quota repeat outcomes

Protected run [34720763619](https://github.com/OpenCoven/chat/actions/runs/34720763619)
failed Windows before native launch with access denial at `bootstrap-npm-cache`,
`directory-enumeration-depth-3-plus`, and `repeat=transient`. That historical
label combines a successful follow-up read with a missing file or directory.
Neither outcome identifies the cause of the original denial.

The proposed diagnostic separates the result of the existing single immediate
follow-up read:

- `readable`: the follow-up callback returned successfully.
- `missing`: it threw `FileNotFoundException` or `DirectoryNotFoundException`.
- `persistent`: it threw another exception; this need not match the first error.
  This label has since been split by the second exception's category; see below.
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

`missing` and every `persistent` repeat remain terminal, as do every initial
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

Managed regression coverage exercises both missing exception types, a successful
metadata follow-up, repeated access denial, and a different second error. Both
production seams are then driven through one injected second failure at a time:
a second denial, an entry-bound exception, generic and HRESULT-classified I/O
errors, both missing types, and an unexpected exception, each of which must keep
its own label after exactly two calls. A real directory read over a spent entry
budget must report `entry-bound` with `repeat=persistent-entry-bound` through
the production enumeration path without any injection. A
separate snapshot regression requires exactly two calls and verifies that the
accepted result contains the complete fresh directory contents. Native Windows
coverage first holds a real owner-only ACL denial across both reads and requires
the bounded `persistent-access-denied` failure. The isolated-reader fixture then denies the
validated isolated identity, temporarily reverts only for the fixture ACL
restoration, verifies impersonation is restored before the second enumeration,
and requires two identity-checked reads to return the complete fresh snapshot.
A subsequent 512-byte limit check proves the production accounting path still
enforces the byte quota.

Status: the `readable`/`missing` split passed local diagnostic tests after a
demonstrated failing regression. The `persistent-<category>` split is in the
frozen supervisor source; the per-seam repeat-outcome matrix and the spent-budget
check were added without an execution on the authoring host, and the
`windows-supervisor-behavior` job is their first run. Native Windows validation,
reviewed frozen-source binding, SDK rebinding and fresh protected evidence are
still required before claiming deployed coverage. Tracks Chat #219 and
`cave-k0aqq.2`. Preserve chat and active worktrees.
