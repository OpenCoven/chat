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

Every outcome preserves the original failure and rejects the quota measurement.
There is no additional read, wait, measurement acceptance, identity switch,
permission change, or change to any resource ceiling. These are observations
at follow-up time, not proof of the original filesystem state.

Managed regression coverage exercises both missing exception types, a successful
follow-up, repeated access denial, and a different second error. It requires
exactly two callback calls, the original access-denied category, and suppression
of private exception text. Existing single-pass, first-failure, terminal and
background diagnostic checks remain in place.

Status: local diagnostic tests pass after a demonstrated failing regression.
Native Windows validation, reviewed frozen-source binding, SDK rebinding and
fresh protected evidence are still required before claiming deployed coverage.
Tracks Chat #219 and `cave-k0aqq.2`. Preserve chat and active worktrees.
