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
| [Agent preflight](agents/preflight.md) | Inspect local readiness, issue ownership, PR coverage and shipping evidence |
| [agent-notes.md](agent-notes.md) | Why long, tool-heavy turns drop when an agent works through the Chat UI |
| [canary-token.md](canary-token.md) | The `CANARY_TOKEN` cross-repository checkouts in CI |
| [design-authority.md](design-authority.md) | Which design tokens rule each visual role in the window |
| [developer-toolchains.md](developer-toolchains.md) | Pinned tool versions, dev ports, CI image credentials |
| [iphone-companion.md](iphone-companion.md) | How the iPhone companion pairs and works |
| [mission-storage-design.md](mission-storage-design.md) | How Chat stores mission records (approved 2026-10-19, #155) |
| [packaged-acceptance.md](packaged-acceptance.md) | The installed-app acceptance workflow and its rows |
| [phase1-conformance.md](phase1-conformance.md) | The protected Phase 1 conformance lane and lock (long; read its status block first) |
| [releasing.md](releasing.md) | How to cut, verify and roll back a release: the whole path from prep PR to verification record |
| [v0.1.3 operator plan](verification/v0.1.3-operator-plan.md) | Hand-run installer, link review and updater checks on each desktop |
| [roadmap.md](roadmap.md) | The plan: the next release and what each open issue waits on |

## Dated snapshots and history

These are true as of their date. Refresh anything they say before you act on it.

| Page | Date | What it records |
| --- | --- | --- |
| [project-coordination.md](project-coordination.md) | 2026-11-20 | Inventory of worktrees, branches, PRs and issue gates, with ownership |
| [mission-m0-integration-checkpoint.md](mission-m0-integration-checkpoint.md) | 2026-10-22 | Mission producer and release prerequisites for #155 |
| [archive/2026-09-conformance-log.md](archive/2026-09-conformance-log.md) | 2026-09-07 to 2026-09-16 | Conformance and consolidation checkpoints (was `roadmap.md`) |
| [windows-supervisor-source.md](windows-supervisor-source.md) | 2026-10-18 | The bounded Windows supervisor and the gates it met |
| [windows-quota-repeat-outcome.md](windows-quota-repeat-outcome.md) | 2026-09 | A Windows quota failure diagnostic |
| [windows-quota-reproduction.md](windows-quota-reproduction.md) | 2026-09-11 to 2026-09-14 | Windows quota reproduction work (#219) |
| [windows-profile-lifecycle.md](windows-profile-lifecycle.md) | 2026-09-12 | Windows profile lifecycle investigation |
| [standalone-query-adapter-design.md](standalone-query-adapter-design.md) | 2026-09-04 | A design whose code was removed in 2026-09 |
| [coven-0.3.0-testing-guide.md](coven-0.3.0-testing-guide.md) | 2026-08-14 | Coven 0.3.0 testing, from before the Chat app existed |

## Verification records

Dated evidence, one page per release or fix. Each is true as of its date; the release's
row in [release-notes/README.md](release-notes/README.md) links its record.

| Page | Date | What it records |
| --- | --- | --- |
| [2026-11-22-release-v0.1.3.md](verification/2026-11-22-release-v0.1.3.md) | 2026-11-22 | v0.1.3: published installers, signatures, native and packaged acceptance |
| [2026-11-14-release-v0.1.2.md](verification/2026-11-14-release-v0.1.2.md) | 2026-11-14 | v0.1.2: source, candidate and published-installer evidence |
| [2026-11-10-548-linux-settings.md](verification/2026-11-10-548-linux-settings.md) | 2026-11-10 | #548: Linux Settings accessibility on the published v0.0.9 deb |
| [2026-11-09-release-v0.0.9.md](verification/2026-11-09-release-v0.0.9.md) | 2026-11-09 | v0.0.9 release evidence |
| [2026-11-09-567-link-review-race.md](verification/2026-11-09-567-link-review-race.md) | 2026-11-09 | #567: the link review race fix (#570) |
| [2026-11-04-release-v0.0.8.md](verification/2026-11-04-release-v0.0.8.md) | 2026-11-04 | v0.0.8 release evidence |
| [2026-10-25-release-v0.0.7.md](verification/2026-10-25-release-v0.0.7.md) | 2026-10-25 | v0.0.7 and TestFlight build 1595 |
| [2026-10-24-packaged-acceptance.md](verification/2026-10-24-packaged-acceptance.md) | 2026-10-24 | The first automated packaged-acceptance results |
| [2026-10-22-updater-356.md](verification/2026-10-22-updater-356.md) | 2026-10-22 | The updater's state before #476 merged; superseded |
| [2026-10-20-release-v0.0.6.md](verification/2026-10-20-release-v0.0.6.md) | 2026-10-20 | v0.0.6 release evidence |
| [2026-10-18-rakazo-chat-ux.md](verification/2026-10-18-rakazo-chat-ux.md) | 2026-10-18 | #485: the Rakazo-inspired chat UX slice |

The [v0.1.3 operator plan](verification/v0.1.3-operator-plan.md) is listed under Current reference.

## Design audits

Dated design reviews and the records of design changes. Open design decisions live in #533.

| Page | Date | What it records |
| --- | --- | --- |
| [2026-11-12-main-conflict-resolution.md](design-audits/2026-11-12-main-conflict-resolution.md) | 2026-11-12 | How the Coven Chat refinement was merged into a conflicted working tree |
| [2026-11-11-coven-chat-polish.md](design-audits/2026-11-11-coven-chat-polish.md) | 2026-11-11 | The Coven Chat rename and desktop refinement, shipped in v0.1.2 |
| [2026-11-10-unpublished-v0.0.10-draft.md](design-audits/2026-11-10-unpublished-v0.0.10-draft.md) | 2026-11-10 | A v0.0.10 notes draft, never published (renumbered to v0.1.0) |
| [2026-11-05-rendered-pass.md](design-audits/2026-11-05-rendered-pass.md) | 2026-11-05 | Rendered measurements for the 2026-10-24 audit's findings 2, 4 and 5 (#541) |
| [2026-10-24-lucian-chat-design-language-audit.md](design-audits/2026-10-24-lucian-chat-design-language-audit.md) | 2026-10-24 | The design language audit: five findings; 1 and 3 delivered in #534, the rest on #533 |

## Folders

| Folder | What it holds |
| --- | --- |
| [agents/](agents/working-here.md) | What agents working here need to know: GitHub habits, CI gaps, flaky rows, local test quirks |
| [superpowers/](superpowers/README.md) | Plans and specs, old and current, each with a dated status. Don't follow one as a work order unless it says current. |
| [design-audits/](design-audits/) | Design reviews, listed above |
| [release-notes/](release-notes/) | One page per published release; [its index](release-notes/README.md) lists them and has the template |
| [verification/](verification/) | Dated verification records, listed above |
