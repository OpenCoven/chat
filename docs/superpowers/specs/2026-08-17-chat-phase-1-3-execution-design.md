# Chat Phase 1-3 Execution Design

**Status:** Approved
**Date:** 2026-08-17
**Scope:** `OpenCoven/chat` desktop beads only

## Purpose

Implement the Chat-owned portions of Phases 1 through 3 without bypassing the
cross-repository gates in the central Coven Cave Beads tracker.

The approved product architecture remains defined by
`2026-08-10-opencoven-chat-design.md`. The detailed implementation contracts
remain the Phase 1, Phase 2, and Phase 3 plans dated 2026-08-15.

## Beads and Git Workflow

Use the central Beads database in `OpenCoven/coven-cave`. The Chat work is:

| Phase | Bead | Deliverable |
| --- | --- | --- |
| 1 | `cave-tsvfj` | Native discovery, launch, keychain, transport, and connection state |
| 2 | `cave-ff3j6` | Accessible shell, canonical reads, search, and transcript |
| 3 | `cave-p4ilm` | Create, send, stream, stop, retry, and recovery |

Before each phase:

1. Confirm the bead appears in `bd ready --json`.
2. Read the bead and its phase plan.
3. Claim it atomically with `bd update <id> --claim`.
4. Create a dedicated Chat worktree and branch named with the bead ID.
5. Rebase that branch on the current `origin/main`.

Do not start a phase while its Beads dependency is open. Phase 1 waits for the
Phase 0 gate, Phase 2 waits for the Phase 1 gate, and Phase 3 waits for the
Phase 2 gate.

## Phase Boundaries

### Phase 1

Keep Cave bearer credentials inside the Rust host and OS keychain. JavaScript
receives only non-secret connection metadata. Validate discovery records,
launch only known installed Cave binaries without a shell, constrain transport
to the approved client-v1 operations, and render the complete connection and
pairing state machine.

### Phase 2

Use the public Cave client DTOs and TanStack Query as replaceable in-memory
server state. Prevent stale revisions from winning, persist no canonical
messages or conversations in browser storage, and provide an accessible
two-pane shell, filters, bounded search, keyboard navigation, and safe
transcript rendering.

### Phase 3

Generate one operation ID per explicit mutation. Reduce only monotonic stream
events, suppress duplicates, checkpoint resume cursors, preserve partial
output, and reconcile from canonical history after replay gaps. Never
automatically resend an ambiguously completed mutation; retry is a new explicit
user action.

## Error Handling

Surface unsafe discovery, unavailable secure storage, incompatible API
versions, revocation, degraded reads, disconnects, replay gaps, and ambiguous
send outcomes as explicit typed states. Do not silently fall back to plaintext
credentials, arbitrary HTTP, browser persistence, mock data, or automatic
mutation replay.

## Verification and Evidence

Follow each phase plan test-first and run its focused unit, Rust, typecheck,
build, and Playwright gates. Before requesting bead closure, append:

- repository, branch, and worktree;
- counterpart commit or release;
- files changed;
- tests added first;
- exact verification commands and results;
- live-authority evidence when required;
- secret-safety review;
- known blockers;
- commit and push state.

Stop after each Chat bead until the central cross-repository gate authorizes the
next phase.
