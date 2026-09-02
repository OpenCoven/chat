# OpenCoven Chat Familiars Surface Integration Design

**Status:** Proposed design (for review)  
**Date:** 2026-09-02  
**Repositories:** `OpenCoven/coven-cave`, `OpenCoven/sdk`, `OpenCoven/chat`, `OpenCoven/coven`  
**Depends on:** Phase 2 gate `cave-8ywi2` (shipped reads); Phase 3 and Phase 4 plans of record  
**Plan of record:** `docs/superpowers/plans/2026-09-02-familiars-integration.md`  
**Reference build:** `v0.0.1-demo.1` (OpenCoven Chat Demo), source under `src/demo/familiars-*`

## Summary

The Familiars Redesign v2 surface ships today as `?demo=chat` and as the
signed demo build. It is driven entirely by local mock data
(`src/demo/familiars-data.ts`). This design moves that surface, feature by
feature, onto canonical Cave data and makes it the production chat shell.

The order is dictated by what Cave can serve, not by what the design shows
first:

1. **Reads.** The five shipped `chat:read` operations carry the conversation
   list and transcript today. Two more reads — the Familiar Contract and
   execution analytics — already have reviewed SDK types and only need
   promotion into `/api/client/v1`. With those, the sidebar, thread, and all
   three inspector tabs run on real data.
2. **Send.** Phase 3 delivers create → send → stream → stop → retry. The
   composer, streaming familiar bubbles, and `@`-mention addressing land on
   it.
3. **Holds.** Phase 4 delivers attention responses, the rich-content AST, and
   attachments. Held-action cards, approve/decline, "Needs you", reasoning
   cards, and image cards land on it.
4. **New protocol.** Summoning a familiar and watching its screen have no
   route, type, or plan anywhere in the stack. They are specified last, as
   their own contracts, and stay demo-only until then.

Every stage keeps the repository's boundaries: the webview never talks to
Cave directly, every new capability is one transport method, one Tauri
command, one capability permission, and one `specification-guards` entry,
and the vendored SDK is only ever replaced by re-cutting both lock files.

## Goals

- Run the Familiars surface on canonical data with no mock value on the
  production route, ever.
- Make the ward — what a familiar may do alone, what it must ask about, the
  only paths it may change — a first-class read served by Cave rather than a
  local fiction.
- Preserve the design's behaviour where the data supports it and show honest
  "not available yet" states where it does not, gated on Cave capabilities.
- Keep the demo build as a fixture-driven preview that never diverges from
  the production components; the two share code and differ only in data
  source.
- Retire `ChatShell` once the Familiars surface reaches read parity, so there
  is one production shell.

## Non-Goals

- No new networking primitive in the webview, no private Cave route, no
  bearer or secret in JavaScript.
- No local persistence of canonical data (Phase 5 owns the offline cache).
- No screen data of any kind until a screen contract exists (Stage 4).
- No template or ward editing in Chat; wards are authored in the workspace and
  read through Cave.
- No changes to the Minimal surface.

## Approved Product Behavior

The surface as shipped in `v0.0.1-demo.1` is the target behaviour:

- three columns — conversations, thread, familiar inspector — with the
  ultra-thin edge toggles and `[` / `]`;
- a "Needs you" section above Recent, holding every conversation waiting on a
  decision across familiars;
- held-action cards that stop in the thread with approve (`⌘⏎`) and decline
  (`⌘⌫`), and their approved / declined / expired afterlives;
- a composer that warns *Held for approval* before a draft crosses the
  familiar's must-ask tier;
- the inspector's Overview, Access (hero, may act / must ask / workspace
  reach / contract), and Activity (four sections, runs per day);
- reasoning cards, image cards with the lightbox, `⌘K` search, the familiar
  card, and the ward-file viewer;
- summoning from a template, `@`-mentions, and the screen view.

What changes per stage is only where the data comes from and which controls
are enabled. A control whose capability Cave does not advertise renders
disabled with a one-line reason, never as a working mock.

## Architecture

### The data-source seam

`FamiliarsShell` today reads module constants. It gains a single typed
dependency:

```ts
interface FamiliarsSource {
  familiars(): QueryResult<Page<FamiliarSummary>>;
  familiar(id): QueryResult<FamiliarDetail>;        // identity + ward + contract
  activity(id, window): QueryResult<FamiliarActivity>;
  conversations(): QueryResult<Page<ConversationSummary>>;
  messages(conversationId): QueryResult<Page<ThreadMessage>>;
  attention(): QueryResult<Page<AttentionItem>>;   // Stage 3
  capabilities(): ReadonlySet<Capability>;
  // Stage 2+
  send(conversationId, draft): Promise<SendReceipt>;
  respond(attentionId, decision): Promise<void>;
}
```

Two implementations:

- `CaveFamiliarsSource` — built on `QueryAdapter` and the managed
  `CaveClient`, one `QueryResult` channel per method, the same TTL / LRU /
  abort / epoch semantics the production shell uses today.
- `MockFamiliarsSource` — today's `familiars-data.ts`, wrapped. Used by the
  demo build, tests, and the design board states. It is the *only* place
  mock content lives.

The shell's reducer keeps its UI state (rails, dialogs, drafts, holds in
flight); everything canonical arrives through the source. The mapping from
SDK types to the shell's view types lives in one module
(`src/familiars/mappers.ts`) so a wire change is a type error there and
nowhere else.

### Capability gating

`CaveHealth.capabilities` already lists what an instance serves. The source
exposes it as a set; the shell derives per-control availability:

| Control | Requires |
|---|---|
| Sidebar, thread, Overview | `familiars`, `conversations`, `conversation-messages` (shipped) |
| Access tab, ward summary, popover counts | `familiar-contract` (Stage 1) |
| Activity tab | `familiar-analytics` (Stage 1) |
| Composer send, streaming, stop | `conversations-write`, `runs` (Stage 2) |
| `@`-mention | `conversation-participants` (Stage 2) |
| Held actions, "Needs you", approve/decline | `attention` (Stage 3) |
| Reasoning card steps | `rich-content` (Stage 3) |
| Image card, lightbox | `attachments` (Stage 3) |
| Summon | `familiars-write` (Stage 4) |
| Screen panel / watch | `screen` (Stage 4) |

Capability names that do not exist yet are proposals; the Cave contract
fixture is the authority once they are reviewed.

### Chat native host

Each read or mutation is one Tauri command taking `handle: String` and
`operation: NativeOperationInput`, one `CaveReadPath` / `CaveWritePath`
variant with validated parameters, and one `allow-*` permission. Mutations
carry a client-generated idempotency key (Phase 3 rules) and are the only
commands that may be `mutating`. Nothing about this design relaxes
`specification-guards.test.ts`; every addition edits the guarded arrays in
the same change.

## Data Model

The demo's types map onto the SDK as follows. "Ask" marks a contract change
that Cave and SDK must review before Chat can consume it.

| Demo | SDK today | Gap and ask |
|---|---|---|
| `MockFamiliar` identity (name, role, creature, pronouns, person) | `CaveCanonicalFamiliar { id, displayName, role, description?, pronouns?, status? }` | **Ask (Stage 1):** `familiars.read` detail operation returning IDENTITY.md-derived `creature` and the `person` binding, or fold both into the contract read below. |
| `ward` (version, protectedFiles, invariants, editablePaths, approvalTiers) | `CaveContractReport { specVersion, pass, properties[], violations[], warnings[] }` — files and pass/fail only | **Ask (Stage 1):** extend `CaveFamiliarContract` with a parsed `ward` block: `{ version, protectedFiles, invariants, editablePaths, approvalTiers: { auto, humanReview } }`. Promote `GET /api/familiars/:id/contract` to `/api/client/v1/familiars/:id/contract`, operation `familiars.contract.read`, scope `chat:read`. |
| `FamActivity` (completion, median, calls, failures, outcomes, spread, tools, days, recent) | `CaveExecutionWindow` (attempts, completed, failed, cancelled, successRate, median/p95, toolCalls, toolFailures, models[], harnesses[]) + `CaveExecutionAttempt[]` | Nearly field-for-field. **Ask (Stage 1):** promote `/execution-analytics` to `/api/client/v1/familiars/:id/analytics`, operation `familiars.analytics.read`; add a `days: { date, completed, failed }[]` series to the window (or Chat derives it from `recent` attempts when `recentLimit` covers the window). Tool-name breakdown maps from `harnesses`/`models` slices. |
| `FamConversation` (`held`, `failed`, `time`, `preview`) | `CaveConversation { status?, exitCode?, pending?, updatedAt }` | `failed` ← `exitCode`/`status`; `time` ← `updatedAt`; `held` ← Stage 3 attention items keyed by conversation; `preview` ← last message text (Stage 1 fetches page 1 of messages lazily) or **ask:** a `lastMessagePreview` on the conversation DTO. |
| `FamMessage` user / familiar text | `CaveConversationMessage { role, text, parentId, isError, cancelled }` | Direct. |
| `familiar` message with `author` (mentions) | none — `role` only | **Ask (Stage 2):** `authorFamiliarId?` on messages and `participants[]` on conversations; `messages.send` accepts `mentions: familiarId[]`. |
| `reasoning` card (steps: icon, title, text, tool, duration, status) | `toolCount: number` | **Phase 4** rich-content AST. Steps map from tool-call nodes; a step's `status` from tool failure; the fold rule (>7 routine steps) stays in Chat. |
| `image` message + plot | `attachmentCount: number` | **Phase 4** attachments (`attachments.read` bytes); the evidence-map plot is a demo-only rendering and is not carried forward. |
| `hold` (title, detail, facts, approvedText/declinedText, expired) | none — Phase 4 defines only `POST attention/[id]/respond` | **Ask (Stage 3):** `attention.list` read (`GET /api/client/v1/attention?status=open`) with `{ id, conversationId, familiarId, title, detail, facts[], openedAt, expiresAt?, state }`, plus SSE events `attention.opened` / `attention.resolved` on the Phase 3 stream; `respond` takes `decision: 'approved' \| 'declined'` and an idempotency key. |
| `FAM_COMMANDS` (`/image`, `/spec`, tiers) | Phase 2 `/commands` route (not shipped) | Stage 2: `commands.list` returning `{ name, hint, tier }`; tier derived by Cave from the familiar's ward. |
| `matchTrigger` (draft crosses must-ask tier) | none | Chat-side: match the draft against `ward.approvalTiers.humanReview` from the contract read. No ask. |
| `summonFamiliar` / `TEMPLATE_WARDS` | none | **Stage 4 ask:** `familiars.create` (scope `familiars:write`, new) taking `{ templateId, name }`, Cave scaffolding SOUL.md / IDENTITY.md / ward.toml / MEMORY.md from server-side templates; `familiars.templates.list`. |
| Screen panel / watch | none; `CovenHealthResponse.capabilities` advertises `sessions`/`events` but no client reads them | **Stage 4 ask:** a separate design. Candidate shape: Coven session screen frames over the Phase 3 event stream, capability `screen`, read-only, consent-gated per familiar. |

## State Model

Connection states are unchanged (`SdkConnectionState`). The shell adds, per
source channel, the existing `QueryResult` states — `not_ready`, `loading`,
`stale`, `reconcile_required`, `error`, `ok` — and renders them in place:

- `loading` → the surface's skeletons (sidebar rows, inspector cards);
- `stale` → last data with a quiet "updating" affordance;
- `reconcile_required` / `unauthorized` → the existing auth-repair
  affordances from `ChatShell`, moved into the inspector footer;
- `error` → the section's empty state with the diagnostic id.

Mutations (Stages 2–3) are optimistic only where the design already
promises it: a sent message appears immediately with a pending mark and is
reconciled against the canonical id; a decision on a hold disables the card
until the response is acknowledged, then the card becomes its afterlife row.
A conflict (`409`) reverts and explains.

## Security Requirements

- All Stage 1 additions are `chat:read`. Stages 2–3 request `chat:write` and
  `conversations:write` at pairing time only when the user opts in; the
  controller's single-scope rule becomes a reviewed scope list.
- Approve / decline is a user gesture, never automatic; the idempotency key is
  generated in Rust, and a replay returns the first result.
- Mentions resolve to familiar ids Cave already lists; the webview never sends
  free-text routing.
- Familiar creation (Stage 4) is a privileged action with the Phase 4
  `confirmed: true` shape and its own scope.
- Screen frames (Stage 4) are never persisted, never leave the loopback, and
  require an explicit start gesture with a visible recording state — the
  design's red frame and clock are the contract with the user.
- The guard suite stays exact: command tables, permission lists, `devUrl`,
  frozen SDK tarballs, lock files.

## Testing Strategy

### Unit and contract tests

- `MockFamiliarsSource` drives the existing 46 familiars tests unchanged;
  `CaveFamiliarsSource` gets mapper tests from SDK fixtures (contract,
  analytics, conversations, messages) so a wire change fails here first.
- Capability gating: every control has a test for "capability absent →
  disabled with reason".
- Reducer tests for optimistic send / decision / revert.

### Real-authority conformance

Each stage adds scenarios to `scripts/phase1-conformance.mjs` and the lock:
Stage 1 — contract and analytics reads for every listed familiar; Stage 2 —
send, mention, stop, retry, resume; Stage 3 — open attention item, approve,
decline, expiry; Stage 4 — create familiar, screen start/stop.

### End to end

Playwright against the preview for the demo (fixtures) and against the Tauri
mock boundary for the production route; the demo build stays a smoke target
so the shared components cannot drift.

## Execution and Review

### Stage 1 — Reads (Phase 2 extension)

Wave 1 (Cave, SDK in parallel): promote contract and analytics routes into
`/api/client/v1`, extend the contract with the ward block and identity
fields, cut SDK managed-transport methods, cut tarballs.  
Wave 2 (Chat): commands, permissions, guards, locks; `FamiliarsSource` seam;
mappers; shell on real reads; `ChatShell` parity check and retirement; the
production route renders `FamiliarsShell`.

### Stage 2 — Send and mentions (Phase 3)

Consumes the Phase 3 plan as written, plus the participants/mentions ask.
Chat work: composer send and stop, stream reduction into familiar bubbles,
`@`-mention addressing, commands list.

### Stage 3 — Holds and rich content (Phase 4)

Consumes the Phase 4 plan, plus the `attention.list` ask. Chat work: attention
channel, "Needs you", held-action cards and afterlives, keyboard decisions,
reasoning cards from the AST, image cards from attachments.

### Stage 4 — Summon and screen (new contracts)

Two separate design specs before any code: familiar creation from templates
(Cave + SDK), and screen viewing (Coven + Cave + SDK). Until they are approved
the demo keeps both features under `MockFamiliarsSource` only.

Every checkpoint receives spec-compliance review, code-quality and security
review, focused tests, repository-wide validation, and green PR checks before
merge, as in Phase 1.

## Beads and Tracking

Proposed beads, `program:chat-v1`, `surface:desktop` unless noted:

- `chat-v1-fam-contract-read` (Cave, shared) — promote contract + ward block
- `chat-v1-fam-analytics-read` (Cave, shared) — promote analytics + days series
- `chat-v1-fam-sdk-reads` (SDK, shared) — managed transport methods, tarballs
- `chat-v1-fam-native-reads` (Chat) — commands, permissions, guards, locks
- `chat-v1-fam-source` (Chat) — `FamiliarsSource`, mappers, capability gating
- `chat-v1-fam-shell-reads` (Chat) — shell on real reads, `ChatShell` retirement
- `chat-v1-fam-send` (Chat, blocked by `cave-e1kfa`) — Stage 2
- `chat-v1-fam-holds` (Chat, blocked by `cave-gylsl`) — Stage 3
- `chat-v1-fam-summon-design`, `chat-v1-fam-screen-design` (shared) — Stage 4 specs

## Documentation Updates

- This specification and the plan of record.
- README: the production route description once `FamiliarsShell` replaces
  `ChatShell`; the demo build section.
- SDK: contract and analytics client-v1 documentation.
- Cave: client-v1 contract fixture and route docs for every promoted or added
  operation.
- Program tracking: bead register entries and per-stage gate notes.

## Exit Criteria

The integration is complete when:

- the production route renders `FamiliarsShell` on canonical data with no
  import from `src/demo/` and no mock value reachable;
- every control is capability-gated and its disabled state is tested;
- Stage 1–3 conformance scenarios pass against real Cave and Coven;
- the demo build still passes its smoke test from the same components;
- both lock files, the command table, and the permission list match the
  shipped SDK and native surface;
- `ChatShell` is deleted.
