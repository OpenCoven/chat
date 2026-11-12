# Docs index

What each page in `docs/` is for, and whether it describes the repo today or records how it got
here. Open work lives in [GitHub issues](https://github.com/OpenCoven/chat/issues), not in these
pages. Agents start at [`AGENTS.md`](../AGENTS.md).

When you add a page, add a row here. When a page stops describing the repo as it is, put a dated
`**Historical (YYYY-MM-DD):**` or `**Status (YYYY-MM-DD):**` line under its title and move its row
to the history table.

## Current reference

| Page | What it covers |
| --- | --- |
| [agent-notes.md](agent-notes.md) | Why long, tool-heavy turns drop when an agent works through the Chat UI |
| [canary-token.md](canary-token.md) | The `CANARY_TOKEN` cross-repository checkouts in CI |
| [design-authority.md](design-authority.md) | Which design tokens rule each visual role in the window |
| [developer-toolchains.md](developer-toolchains.md) | Pinned tool versions, dev ports, CI image credentials |
| [iphone-companion.md](iphone-companion.md) | How the iPhone companion pairs and works |
| [mission-storage-design.md](mission-storage-design.md) | How Chat stores mission records (approved 2026-10-19, #155) |
| [packaged-acceptance.md](packaged-acceptance.md) | The installed-app acceptance workflow and its rows |
| [phase1-conformance.md](phase1-conformance.md) | The protected Phase 1 conformance lane and lock (long; read its status block first) |
| [releasing.md](releasing.md) | How to cut, verify and roll back a release: the whole path from prep PR to verification record |

## Dated snapshots and history

These are true as of their date. Refresh anything they say before you act on it.

| Page | Date | What it records |
| --- | --- | --- |
| [project-coordination.md](project-coordination.md) | 2026-11-12 | Inventory of worktrees, branches, PRs and issue gates, with ownership |
| [mission-m0-integration-checkpoint.md](mission-m0-integration-checkpoint.md) | 2026-10-22 | Mission producer and release prerequisites for #155 |
| [roadmap.md](roadmap.md) | 2026-09-07 to 2026-09-16 | Conformance and consolidation checkpoints |
| [windows-supervisor-source.md](windows-supervisor-source.md) | 2026-10-18 | The bounded Windows supervisor and the gates it met |
| [windows-quota-repeat-outcome.md](windows-quota-repeat-outcome.md) | 2026-09 | A Windows quota failure diagnostic |
| [windows-quota-reproduction.md](windows-quota-reproduction.md) | 2026-09-11 to 2026-09-14 | Windows quota reproduction work (#219) |
| [windows-profile-lifecycle.md](windows-profile-lifecycle.md) | 2026-09-12 | Windows profile lifecycle investigation |
| [standalone-query-adapter-design.md](standalone-query-adapter-design.md) | 2026-09-04 | A design whose code was removed in 2026-09 |
| [coven-0.3.0-testing-guide.md](coven-0.3.0-testing-guide.md) | 2026-08-14 | Coven 0.3.0 testing, from before the Chat app existed |

## Folders

| Folder | What it holds |
| --- | --- |
| [agents/](agents/working-here.md) | What agents working here need to know: GitHub habits, CI gaps, flaky rows, local test quirks |
| [superpowers/](superpowers/README.md) | Old plans and specs, each with a status. Don't follow one as a work order unless it says current. |
| [design-audits/](design-audits/) | Design reviews; #533 tracks the 2026-10-24 audit's findings |
| [release-notes/](release-notes/) | One page per published release; [its index](release-notes/README.md) lists them and has the template |
| [verification/](verification/) | Dated verification records for releases and fixes |
