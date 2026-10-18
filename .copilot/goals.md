# OpenCoven Chat goals

> **Status as of 2026-10-18.** The goals below date from 2026-08-29 and are historical.
> Chat now ships as pre-releases (latest `v0.0.5`, 2026-10-14) that drive the Coven CLI.
> The protected client-v1 conformance workflow first passed on 2026-09-24 (run
> 36033589858), and its latest run (36222464391, 2026-09-26) passed too. See
> `docs/phase1-conformance.md` for conformance status and GitHub issues for open work.

- Phase 0 contract and package foundations are complete.
- The Phase 1 read-only native client is merged at
  `0021d30d0cddc5d3f00a41c55d025cf3ce4611c5`.
- Phase 1 closes only when `pnpm test:phase1-conformance` produces a fully
  passing, secret-scanned report for the exact revisions in
  `phase1-conformance.lock.json`.
- Do not treat the resolved HPKE authority-binding work as an open dependency.
  Remaining conformance blockers must be reported by assertion and diagnostic
  ID rather than replaced with mock evidence.
