# OpenCoven Chat goals

- Phase 0 contract and package foundations are complete.
- The Phase 1 read-only native client is merged at
  `0021d30d0cddc5d3f00a41c55d025cf3ce4611c5`.
- Phase 1 closes only when `pnpm test:phase1-conformance` produces a fully
  passing, secret-scanned report for the exact revisions in
  `phase1-conformance.lock.json`.
- Do not treat the resolved HPKE authority-binding work as an open dependency.
  Remaining conformance blockers must be reported by assertion and diagnostic
  ID rather than replaced with mock evidence.
