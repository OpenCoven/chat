# OpenCoven Chat v1 Program Tracking

> **Program tracker:** Coven Cave Beads database  
> **Root epic:** `cave-k0aqq`  
> **Plan of record:** the eight phase plans dated 2026-08-15 in this directory

## Purpose

This document is the durable index for delivering OpenCoven Chat, the local-first
TypeScript/Rust clients, and the `opencoven` developer CLI. Detailed implementation
steps stay in the phase plans; Beads records ownership, readiness, blocking
dependencies, verification evidence, and release gates.

The central Beads graph lives in `OpenCoven/coven-cave` because that repository
owns the established Beads/Dolt workflow. A bead's `repo:*` label and repository
metadata identify where implementation occurs. Cross-repository ownership is not
represented through experimental cross-database dependencies.

## Current delivery audit

See the [2026-09-07 delivery roadmap](../../roadmap.md) for the latest audited
Chat PR and conformance state. The counts and initial readiness below are the
program-creation baseline; refresh Beads before claiming work or closing gates.

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

## Operating Rules

1. Run `bd show <id>` and read the linked phase plan before claiming work.
2. Confirm readiness with `bd ready --json`; do not bypass active blockers.
3. Claim atomically with `bd update <id> --claim`.
4. Use a dedicated worktree named with the bead ID. Never implement on a
   repository's dirty main checkout.
5. Keep each lane within its owning repository. Cross-repository E2E beads begin
   only after their same-phase implementation blockers close.
6. Generate authority fixtures only through their exporter. Consumers must not
   hand-edit copied fixtures.
7. Record the exact commands, counterpart commit/release, and relevant artifact
   paths in bead notes.
8. Do not close a gate from unit-test proxies alone. Gates require the exact
   live-authority or packaged acceptance stated in the phase plan.
9. Do not push Git branches, Dolt state, packages, crates, installers, or rollout
   metadata without explicit operator authorization.
10. Preserve the authority boundaries and approved v1 non-goals in the master
    plan.

## Verification Commands

Run from `/Users/buns/Documents/GitHub/OpenCoven/coven-cave` or another clean
checkout containing the canonical `.beads` database:

```bash
bd list --label program:chat-v1 --json --limit 0 --flat
bd dep cycles
bd ready --json --limit 0
bd list --label program:chat-v1 --label surface:shared --json --limit 0 --flat
bd list --label program:chat-v1 --label surface:desktop --json --limit 0 --flat
```

Expected program-specific results:

- 57 total beads
- 0 dependency cycles
- 47 `surface:shared`
- 10 `surface:desktop`
- Four initial ready implementation lanes

The repository-wide `pnpm beads:surfaces` audit currently reports older,
unrelated beads without surface labels. Program-specific counts above isolate
this graph from those pre-existing warnings.

Phase 1 gate evidence is the completed, secret-scanned
`test-results/phase1-conformance/report.json` produced through
`/bin/sh scripts/phase1-conformance-launcher.sh "$(command -v node)"` at the revisions in
`phase1-conformance.lock.json`. It is a complete SDK #38 platform record; a
failed or incomplete run publishes no evidence and leaves the gate open.

## Bead Evidence Template

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
