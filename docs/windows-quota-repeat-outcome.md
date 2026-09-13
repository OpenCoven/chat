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

`missing` and `persistent` repeats remain terminal, as do every initial failure
other than `UnauthorizedAccessException`. Attribute and file-length reads keep
their existing fail-closed diagnostic-only repeats. The terminal check performs
the same bounded recovery and still rejects any path that cannot produce a
complete readable snapshot.

Managed regression coverage exercises both missing exception types, a successful
metadata follow-up, repeated access denial, and a different second error. A
separate snapshot regression requires exactly two calls and verifies that the
accepted result contains the complete fresh directory contents. Native Windows
coverage first holds a real owner-only ACL denial across both reads and requires
the bounded `persistent` failure. The isolated-reader fixture then denies the
validated isolated identity, restores only that fixture ACL between attempts,
and requires two identity-checked reads to return the complete fresh snapshot.
A subsequent 512-byte limit check proves the production accounting path still
enforces the byte quota.

Status: local diagnostic tests pass after a demonstrated failing regression.
Native Windows validation, reviewed frozen-source binding, SDK rebinding and
fresh protected evidence are still required before claiming deployed coverage.
Tracks Chat #219 and `cave-k0aqq.2`. Preserve chat and active worktrees.
