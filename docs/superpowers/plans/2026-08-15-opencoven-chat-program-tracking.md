# OpenCoven Chat v1 Program Tracking

Use GitHub issues for current delivery tracking. The Beads IDs, counts, and
phase register below preserve the original 2026-08-15 plan; they are not a
current execution queue. Cave retired Beads in
[#5399](https://github.com/OpenCoven/coven-cave/issues/5399). Do not run `bd`,
claim Beads, or sync Dolt for this work.

## Current delivery audit

The [delivery roadmap](../../roadmap.md) records verified Chat #285 and SDK
#274 landings and fresh protected run `34935323170`. Follow
[Chat #219](https://github.com/OpenCoven/chat/issues/219) and
[SDK #38](https://github.com/OpenCoven/sdk/issues/38) for current protected
validation evidence. Run `34935323170` failed at Windows native preflight;
Linux and macOS records passed independent inspection. Windows and aggregate
acceptance remain required.
Chat #86 remains parked for candidate/artifact reconciliation; #154/#155
sequence production delegation after conformance and SDK dependency work.

For Cave ownership and Project status, follow its
[GitHub work tracking guide](https://github.com/OpenCoven/coven-cave/blob/main/docs/workflows/github-work-tracking.md).
Preserve historical IDs, owners, dependencies, and citations. Do not bulk-import
legacy rows or infer current readiness from the baseline below.

## Historical program baseline

The eight phase plans dated 2026-08-15 remain the detailed specification.
The following register describes the original Beads graph and its counts.

## Tracker Summary

| Item | Value |
|---|---|
| Root epic | `cave-k0aqq` |
| Total beads | 57 |
| Phase epics | 8 |
| Implementation/conformance beads | 40 |
| Phase gates | 8 |
| Shared-surface beads | 47 |
| Desktop-surface beads | 10 |
| Dependency cycles | 0 |
| Tracker checkout | `/Users/buns/Documents/GitHub/OpenCoven/coven-cave` or another clean checkout containing the canonical `.beads` database |

All program beads carry `program:chat-v1`, one `repo:*`, one `phase:*`, one
`area:*`, one `surface:shared|desktop`, and `verification-required`. Gates also
carry `gate` and `release-blocker`. Human-controlled signing, publishing, or
rollout work carries `needs-human`.

## Phase Index

| Phase | Epic | Gate | Detailed plan |
|---|---|---|---|
| 0 | `cave-t7zzu` | `cave-bt9wx` | `2026-08-15-phase-0-baseline-contracts.md` |
| 1 | `cave-fz01p` | `cave-23nmv` | `2026-08-15-phase-1-discovery-pairing.md` |
| 2 | `cave-0orvs` | `cave-8ywi2` | `2026-08-15-phase-2-canonical-reads.md` |
| 3 | `cave-uxlxg` | `cave-e1kfa` | `2026-08-15-phase-3-send-stream-recovery.md` |
| 4 | `cave-zcsl9` | `cave-gylsl` | `2026-08-15-phase-4-rich-content-attachments-actions.md` |
| 5 | `cave-0567z` | `cave-rbikx` | `2026-08-15-phase-5-native-lifecycle-offline-sdk-tooling.md` |
| 6 | `cave-z2af3` | `cave-b6wsl` | `2026-08-15-phase-6-production-hardening.md` |
| 7 | `cave-j65ie` | `cave-ilh1h` | `2026-08-15-phase-7-release-rollout.md` |

Phase epics and implementation beads use `relates-to`, not parent-child
dependencies. A phase gate is blocked by its implementation and conformance
beads. The next phase's implementation beads are blocked by the preceding gate.
This preserves a cycle-free graph and allows safe parallel lanes inside each
phase.

## Initial Ready Work

Phase 0 begins with four independent repository lanes:

| Bead | Repository | Work |
|---|---|---|
| `cave-g6x6k` | Cave | Client v1 contract and deterministic fixture |
| `cave-48uuf` | Coven | Reusable Rust daemon client extraction |
| `cave-o2bqs` | SDK | Workspace and package boundaries |
| `cave-5n20h` | Chat | React, Tauri, tests, and CI scaffold |

After all four close, `cave-u0oli` runs the cross-repository fixture/package
canary. Phase 0 closes through `cave-bt9wx`.

## Full Bead Register

### Phase 0 — Baseline Contracts and Repository Hygiene

| Bead | Owner | Surface | Work |
|---|---|---|---|
| `cave-g6x6k` | Cave | shared | Client v1 contract and deterministic fixture |
| `cave-48uuf` | Coven | shared | Reusable Rust daemon client extraction |
| `cave-o2bqs` | SDK | shared | SDK workspace and package boundaries |
| `cave-5n20h` | Chat | desktop | Chat React/Tauri/test/CI scaffold |
| `cave-u0oli` | Cross-repo | shared | Fixture and package conformance canary |
| `cave-bt9wx` | Cross-repo | shared | Phase 0 gate |

### Phase 1 — Discovery, Pairing, Health, and Revocation

| Bead | Owner | Surface | Work |
|---|---|---|---|
| `cave-9pifu` | Cave | shared | Discovery, pairing, auth, and revocation authority |
| `cave-tsvfj` | Chat | desktop | Native discovery, launch, keychain, and connection state |
| `cave-lf7bu` | SDK | shared | Cave discovery, health, pairing, and credentials |
| `cave-p8qkk` | SDK | shared | Coven IPC discovery and health |
| `cave-0prpu` | Cross-repo | shared | Real-authority pairing/revocation conformance |
| `cave-23nmv` | Cross-repo | shared | Phase 1 gate |

### Phase 2 — Canonical Reads and Messaging Shell

| Bead | Owner | Surface | Work |
|---|---|---|---|
| `cave-mfcsz` | Cave | shared | Canonical read projections and routes |
| `cave-g9d49` | Coven | shared | Rust session and event read APIs |
| `cave-3yax4` | SDK | shared | Read clients, pagination, and CLI output |
| `cave-ff3j6` | Chat | desktop | Shell, filters, search, and canonical transcript |
| `cave-hjy2f` | Cross-repo | shared | Real-authority canonical-read conformance |
| `cave-8ywi2` | Cross-repo | shared | Phase 2 gate |

### Phase 3 — Create, Send, Stream, Stop, Retry, and Recovery

| Bead | Owner | Surface | Work |
|---|---|---|---|
| `cave-nz54o` | Cave | shared | Idempotent conversation and send mutations |
| `cave-inpy5` | Cave | shared | Typed SSE resume and reconciliation |
| `cave-jmav9` | SDK | shared | TypeScript/Rust stream clients and CLI tail |
| `cave-p4ilm` | Chat | desktop | Complete chat and recovery loop |
| `cave-ixa2o` | Cross-repo | shared | Send/idempotency/resume/restart conformance |
| `cave-e1kfa` | Cross-repo | shared | Phase 3 gate |

### Phase 4 — Rich Content, Attachments, and Privileged Actions

| Bead | Owner | Surface | Work |
|---|---|---|---|
| `cave-5jcgw` | Cave | shared | Attachment and privileged-action authority |
| `cave-hvnv8` | SDK | shared | Attachment and confirmed-action methods |
| `cave-tma63` | Chat | desktop | Strict rich-content AST and safe renderers |
| `cave-zrc51` | Chat | desktop | Attachment workflow and action confirmation |
| `cave-e3ji9` | Cross-repo | shared | Hostile-content/attachment/action conformance |
| `cave-gylsl` | Cross-repo | shared | Phase 4 gate |

### Phase 5 — Native Lifecycle, Offline Reads, Settings, and Tooling

| Bead | Owner | Surface | Work |
|---|---|---|---|
| `cave-f1k8n` | Chat | desktop | Encrypted replaceable offline read cache |
| `cave-x8mcl` | Chat | desktop | Native lifecycle, preferences, links, and diagnostics |
| `cave-x8ikk` | SDK | shared | Secure profiles and additive config migration |
| `cave-2m6q0` | SDK | shared | Diagnostics, completions, and TypeScript scaffolds |
| `cave-wcpm6` | Cross-repo | shared | Offline/native lifecycle conformance |
| `cave-rbikx` | Cross-repo | shared | Phase 5 gate |

### Phase 6 — Production Hardening

| Bead | Owner | Surface | Work |
|---|---|---|---|
| `cave-37pyk` | Cross-repo | shared | Security boundary and hostile-input matrix |
| `cave-fuahq` | Chat | desktop | Accessibility and keyboard matrix |
| `cave-o8gc4` | Cross-repo | shared | Performance budgets |
| `cave-v1vz0` | Cross-repo | shared | Production fault-injection journeys |
| `cave-90esv` | Cross-repo | shared | Package/provenance/completion/secret gates |
| `cave-b6wsl` | Cross-repo | shared | Phase 6 gate |

### Phase 7 — Packaging, Publishing, Compatibility, and Rollout

| Bead | Owner | Surface | Work |
|---|---|---|---|
| `cave-mbekl` | Cave/Coven | shared | Authority compatibility releases |
| `cave-gcb0i` | Chat | desktop | Signed packages and updater |
| `cave-563z7` | SDK | shared | npm packages, Rust crates, CLI, and docs |
| `cave-as76u` | Cross-repo | shared | Authority-main and compatibility canaries |
| `cave-udcn7` | Cross-repo | shared | OS acceptance, staged rollout, and rollback |
| `cave-ilh1h` | Cross-repo | shared | Production v1 gate |

## Operating rules

1. Read the owning GitHub issue and linked phase plan before starting work.
   Record the acting agent, scope, branch/worktree, evidence, blocker, and next
   step there. Preserve existing ownership and dependencies.
2. Keep implementation in its owning repository and preserve active or dirty
   worktrees. Cross-repository E2E follows its implementation blockers.
3. Generate authority fixtures through their exporter; do not hand-edit copies.
4. Record exact verification commands, counterpart revisions, and artifact
   evidence in the owning issue before requesting closure.
5. Require the live-authority or packaged acceptance stated in the phase plan.
   Unit tests alone cannot close those gates.
6. Preserve authority boundaries, approved non-goals, and operator approval
   requirements for Git branch pushes, publishing, and rollout.

## Verification evidence

The historical baseline had 57 Beads, no dependency cycles, 47 shared-surface
items, 10 desktop items, and four initially ready lanes. Those counts do not
establish current ownership, readiness, or completion. Verify current GitHub
issues, PR heads, workflow results, and the phase-specific artifacts instead.

Phase 1 gate evidence is the completed, secret-scanned
`test-results/phase1-conformance/report.json` produced through
`/bin/sh scripts/phase1-conformance-launcher.sh "$(command -v node)"` at the revisions in
`phase1-conformance.lock.json`. It is a complete SDK #38 platform record; a
failed or incomplete run publishes no evidence and leaves the gate open.

## Issue evidence template

Append this information before requesting closure:

```text
Repository:
Branch/worktree:
Counterpart SHA or release:
Files changed:
Tests added first:
Verification commands and results:
Live-authority or packaged evidence:
Security/secret review:
Known follow-up or blocker:
Commit/push state:
```
