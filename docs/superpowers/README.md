# Plans and specs

This folder holds dated design specs and implementation plans. They're a record of how Chat got
here, not a list of current work. Only one doc is current: the iPhone companion design.

- For how Chat behaves today, read [`README.md`](../../README.md). It's the product contract.
- For current work, use [GitHub issues](https://github.com/OpenCoven/chat/issues).
- For how the iPhone companion works, read [`docs/iphone-companion.md`](../iphone-companion.md).

Each doc carries a dated `**Status (YYYY-MM-DD):**` line under its title that says what happened
to it and cites the evidence. A doc marked anything other than current says _do not execute_ or
_historical record_: don't hand it to an agent as a work order.

When you add a plan or spec, put a status line under its title and add a row below. When its
status changes, update both.

## Specs

| Spec | Status (2026-10-18) |
| --- | --- |
| [iPhone companion](specs/2026-10-07-iphone-companion-design.md) | Implemented, current |
| [WorkOS onboarding](specs/2026-09-16-workos-onboarding-design.md) | Paused, decision pending |
| [Familiars surface integration](specs/2026-09-02-familiars-integration-design.md) | Superseded |
| [Grok-inspired agent inspector](specs/2026-08-30-grok-inspired-agent-inspector-design.md) | Abandoned |
| [Contextual inspector](specs/2026-08-21-chat-contextual-inspector-design.md) | Delivered, later removed |
| [Phase 1 discovery and pairing](specs/2026-08-20-phase-1-discovery-pairing-design.md) | Delivered |
| [Phase 1-3 execution](specs/2026-08-17-chat-phase-1-3-execution-design.md) | Abandoned |
| [Chat for iOS](specs/2026-08-16-opencoven-chat-ios-design.md) | Superseded, never implemented |
| [Chat design](specs/2026-08-10-opencoven-chat-design.md) | Superseded |

## Plans

| Plan | Status (2026-10-18) |
| --- | --- |
| [iPhone companion](plans/2026-10-07-iphone-companion.md) | Delivered |
| [WorkOS onboarding](plans/2026-09-16-workos-onboarding.md) | Paused, decision pending |
| [Frozen GLib native validation](plans/2026-09-10-frozen-glib-native-validation.md) | Delivered |
| [Familiars surface integration](plans/2026-09-02-familiars-integration.md) | Superseded |
| [Grok-inspired agent inspector](plans/2026-08-30-grok-inspired-agent-inspector.md) | Abandoned |
| [Packed SDK consumer and conformance](plans/2026-08-22-sdk-0.1-packed-consumer-conformance.md) | Delivered |
| [Contextual inspector](plans/2026-08-21-chat-contextual-inspector.md) | Delivered, later removed |
| [Phase 1d real-authority conformance](plans/2026-08-20-phase-1d-real-authority-conformance.md) | Delivered |
| [Phase 1c native connection](plans/2026-08-20-phase-1c-chat-native-connection.md) | Superseded |
| [Phase 1b SDK discovery and pairing](plans/2026-08-20-phase-1b-sdk-discovery-pairing.md) | Delivered in `sdk` |
| [Phase 1a Cave pairing authority](plans/2026-08-20-phase-1a-cave-pairing-authority.md) | Delivered in `coven-cave` |
| [iOS phase H: release](plans/2026-08-17-ios-phase-h-release.md) | Superseded, never implemented |
| [iOS phase G2: lifecycle and hardening](plans/2026-08-17-ios-phase-g2-lifecycle-and-hardening.md) | Superseded, never implemented |
| [iOS phase G1: doorbell relay](plans/2026-08-17-ios-phase-g1-doorbell-relay-and-delivery.md) | Superseded, never implemented |
| [iOS phase F: rich content and actions](plans/2026-08-17-ios-phase-f-rich-content-and-actions.md) | Superseded, never implemented |
| [Phase 1-3 Beads execution](plans/2026-08-17-chat-phase-1-3-beads-execution.md) | Abandoned |
| [iOS phase E: send, stream, recovery](plans/2026-08-16-ios-phase-e-send-stream-recovery.md) | Superseded, never implemented |
| [iOS phase D2: enrollment and reads](plans/2026-08-16-ios-phase-d2-enrollment-and-reads.md) | Superseded, never implemented |
| [iOS phase D1: foundation](plans/2026-08-16-ios-phase-d1-ios-foundation.md) | Superseded, never implemented |
| [iOS phase C: enrollment authority](plans/2026-08-16-ios-phase-c-enrollment-authority.md) | Superseded, never implemented |
| [iOS phase B: cave-core foundation](plans/2026-08-16-ios-phase-b-cave-core-foundation.md) | Superseded, never implemented |
| [iOS phase A: transport extraction](plans/2026-08-16-ios-phase-a-transport-extraction.md) | Superseded, never implemented |
| [Phase 7 release rollout](plans/2026-08-15-phase-7-release-rollout.md) | Superseded by `docs/releasing.md` |
| [Phase 6 production hardening](plans/2026-08-15-phase-6-production-hardening.md) | Abandoned |
| [Phase 5 lifecycle, offline, tooling](plans/2026-08-15-phase-5-native-lifecycle-offline-sdk-tooling.md) | Abandoned |
| [Phase 4 rich content and attachments](plans/2026-08-15-phase-4-rich-content-attachments-actions.md) | Superseded |
| [Phase 3 send, stream, recovery](plans/2026-08-15-phase-3-send-stream-recovery.md) | Superseded |
| [Phase 2 canonical reads](plans/2026-08-15-phase-2-canonical-reads.md) | Partially delivered |
| [Phase 1 discovery and pairing](plans/2026-08-15-phase-1-discovery-pairing.md) | Superseded by phases 1a-1d |
| [Phase 0 baseline contracts](plans/2026-08-15-phase-0-baseline-contracts.md) | Delivered |
| [Parallel execution prompts](plans/2026-08-15-parallel-execution-prompts.md) | Abandoned |
| [Program tracking](plans/2026-08-15-opencoven-chat-program-tracking.md) | Superseded |
| [Rich desktop](plans/2026-08-10-opencoven-chat-rich-desktop.md) | Superseded |
| [Chat core](plans/2026-08-10-opencoven-chat-core.md) | Superseded |
| [Cave client v1 API](plans/2026-08-10-cave-client-v1-api.md) | Superseded |
