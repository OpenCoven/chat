# OpenCoven Chat Design

**Status:** Approved design  
**Date:** 2026-08-10  
**Repositories:** `OpenCoven/chat`, `OpenCoven/coven-cave`

## Summary

OpenCoven Chat is a focused, cross-platform desktop client for talking with
OpenCoven familiars. It preserves the immediacy of the AI Message reference
experience while replacing its generic assistant backend and local-only history
with Cave's canonical familiar, conversation, execution, and action authority.

The app is built with React, TypeScript, and Tauri. It uses a supported,
versioned, authenticated Cave client API rather than importing Cave internals or
calling its current private UI routes. Chat manages presentation, desktop
lifecycle, connection state, credentials, and replaceable caches. Cave remains
the sole owner of canonical history and all privileged mutations.

## Goals

- Deliver a standalone, messaging-first OpenCoven desktop app.
- Support macOS, Windows, and Linux through Tauri.
- Preserve the reference app's fast two-pane chat experience.
- Use one canonical conversation history shared with Coven Cave.
- Present both a unified conversation list and familiar-specific views.
- Render Cave's rich chat semantics, not only plain text.
- Discover and manage the installed Cave service without routine manual setup.
- Establish trust through one-time, explicit pairing approval.
- Give Chat a stable, versioned API with compatibility negotiation.
- Preserve the Familiar Contract by selecting and displaying the canonical
  familiar attached to every conversation and turn.

## Non-Goals

Version 1 does not include:

- voice calling or dictation
- group chat
- canvas or artifact workspaces
- embedded terminals
- code inspectors
- Cave's board, Gantt, calendar, marketplace, or administration surfaces
- a second conversation database
- direct harness, shell, filesystem, GitHub, or task-system authority
- an offline write queue
- a general replacement for Coven Cave

## Product Decisions

| Area | Decision |
| --- | --- |
| Product | Standalone OpenCoven familiar chat client |
| Runtime | React + TypeScript + Tauri |
| Platforms | macOS, Windows, Linux |
| Authority | Cave owns canonical history and execution |
| Connection | Chat discovers and, when possible, launches Cave |
| API | Versioned `/api/client/v1` Cave facade |
| Authentication | One-time approval with scoped, revocable token |
| Organization | Unified All Chats plus familiar filters/sections |
| Scope | Rich Cave message semantics |
| Visual direction | Full Coven atmosphere |
| Offline behavior | Read cached history; disable writes |

## Architecture

### OpenCoven Chat

The `OpenCoven/chat` repository owns:

- the Tauri desktop host
- the React application and routing
- the conversation list and thread presentation
- rich message component rendering
- the composer and attachment preparation
- Cave discovery, startup, health, and reconnect behavior
- one-time pairing initiation
- OS keychain credential storage
- short-lived query and offline read caches
- local-only preferences such as theme, window state, shortcuts, and defaults

Chat must not persist canonical messages, execute harnesses, mutate projects, or
perform GitHub/task actions directly.

### Coven Cave

The `OpenCoven/coven-cave` repository adds a `/api/client/v1` facade. These
routes call existing Cave services and stores so the facade does not create a
parallel implementation of chat behavior.

The facade owns:

- pairing requests, approval, credential exchange, listing, and revocation
- capability and version negotiation
- familiar roster projection
- project availability projection
- session and conversation projections
- canonical conversation creation and mutations
- message submission and run control
- resumable typed SSE streams
- attachment acceptance and validation
- rich action execution through existing Cave authorities

Existing Cave UI routes may continue to exist. The client facade is a new,
supported compatibility boundary and should not merely redirect external
clients to undocumented route shapes.

### Authority Boundary

Cave is the single authority for:

- familiar identity and project grants
- conversation and session persistence
- titles, archive state, and deletion
- message and attachment persistence
- harness selection, launch, resume, and stop
- task handoffs and attention responses
- GitHub action execution
- action authorization, validation, idempotency, and audit data

Chat is authoritative only for local presentation preferences and ephemeral
view state.

## Cave Client API

### Compatibility

`GET /api/client/v1/health` returns:

- service identity
- API major and minor version
- minimum supported client version
- feature capabilities
- Cave instance identifier
- pairing requirement

The major version is encoded in the route. Additive response fields and
capabilities may evolve within v1. Removing or changing required fields needs a
new major version.

Chat gates optional UI by advertised capabilities. An unsupported major version
produces an explicit upgrade-required state rather than best-effort parsing.

### Pairing

The pairing flow uses short-lived requests:

1. Chat discovers Cave and calls the unauthenticated pairing-request endpoint
   with its app identity, installation identity, public challenge material, and
   requested scopes.
2. Cave displays a local approval surface containing app identity, requested
   permissions, creation time, and expiration.
3. Val approves or denies the request.
4. Chat polls or receives approval state and exchanges the one-time grant for a
   bearer token.
5. Chat stores the token in the OS keychain.
6. Cave stores only a cryptographic token hash and credential metadata.

Pairing requests expire quickly and are single-use. Tokens are app-scoped,
revocable, and least-privilege. V1 scopes should separate read access, chat
submission, conversation mutation, attachments, task actions, and GitHub
actions.

The Cave settings surface lists paired clients, scopes, last use, creation
time, and revoke controls.

### Resource Groups

The v1 facade provides:

- `health` and `capabilities`
- `pairing` and `credentials`
- `familiars`
- `projects`
- `conversations`
- `conversation search`
- `messages/send`
- `runs/stream`, `runs/resume`, `runs/stop`, and `runs/retry`
- `attachments`
- `attention`
- `tasks`
- `github-actions`

Exact request and response schemas belong in the implementation plan and
contract types. Every mutation accepts a client-generated idempotency key.
Errors use a stable envelope with a machine-readable code, user-safe message,
retryability, and optional field details.

## Desktop Connection Lifecycle

### Discovery

The Tauri host checks, in order:

1. an explicitly configured development endpoint
2. Cave's platform-specific local discovery record
3. the installed Cave application's known service launcher

Discovery records must be local-user scoped and validated before use. Chat does
not scan arbitrary ports or trust an endpoint supplied by untrusted page
content.

### Managed Startup

If Cave is installed but its service is unavailable, Chat asks the Tauri host to
start the supported Cave server entry point. Chat does not bundle a second Cave
backend.

Startup has a bounded readiness deadline and reports useful stages:

- locating Cave
- starting Cave
- waiting for readiness
- pairing required
- connected

If Cave is not installed or cannot start, Chat presents a diagnostic state with
install/open/retry actions. It never silently falls back to a separate local
chat backend.

### Reconnection

Transient failures use bounded exponential backoff with jitter. The app
distinguishes:

- service unavailable
- authentication expired or revoked
- pairing pending
- incompatible API
- network interruption during a run
- rejected or invalid request

Repeated auth failures clear the unusable keychain credential and return to the
pairing flow. Other failures retain credentials.

## Data Model and Flow

### Canonical Reads

Chat loads:

1. familiar roster and capabilities
2. paginated conversation summaries
3. the selected conversation on demand

Conversation summaries include stable identity, familiar identity, title,
preview, timestamps, status, project context, archive/pin state, and unread or
attention indicators.

Responses carry a server revision or ETag. Chat may display cached data
immediately, but a stale response cannot overwrite a newer known revision.

### New Conversation

The new-chat flow selects:

1. familiar
2. optional permitted project

Cave validates the familiar, project existence, and project grant before
creating the canonical conversation. The resulting session identifier is used
by both Cave and Chat.

### Message Send

Chat submits:

- client operation ID
- conversation/session ID, if continuing
- familiar ID
- prompt
- prepared attachments
- selected project/context
- supported model/runtime preferences exposed by Cave

Cave validates authentication, scope, familiar ownership, project grants,
payload bounds, attachments, and idempotency before execution. Cave persists
the canonical turn according to its existing chat rules.

### Streaming

Streaming uses Server-Sent Events with:

- monotonic event IDs
- typed event payloads
- heartbeats
- an explicit terminal event
- bounded server-side replay

Chat checkpoints the last accepted event ID. After a disconnect it resumes from
that cursor. If replay is unavailable or has a gap, Chat reloads the canonical
conversation and reconciles instead of guessing what completed.

The stream reducer treats duplicate event IDs as no-ops. A submitted operation
is never automatically replayed merely because transport outcome is ambiguous.

### Mutations and Rich Actions

Rename, archive, delete, attention responses, task handoffs, and GitHub actions
use scoped v1 endpoints and idempotency keys. The client renders proposed
actions separately from completed actions. Only a successful Cave response may
transition an action to completed.

## Experience

### Layout

The primary desktop window retains a two-pane messaging layout:

- left: navigation, search, familiar filters, and conversation list
- right: thread header, message timeline, and composer

The window has a practical minimum size and a collapsible sidebar for narrow
widths.

### Conversation Organization

The sidebar supports:

- All Chats as the default unified chronology
- familiar filters and familiar sections
- full-text conversation search through Cave
- pinned and recent groupings
- archived view
- running, unread, and attention indicators

Every row shows familiar identity, title, preview, timestamp, and relevant
project/status context. A chat never appears as a generic assistant thread when
its familiar is known.

### Thread Header

The header shows:

- familiar avatar, name, lane, and color
- conversation title
- project context
- runtime/model state where useful
- Cave connection/run status
- rename, pin, archive, and delete actions

### Message Timeline

V1 renders:

- user and familiar text
- streaming text and typing/progress states
- Markdown and fenced code
- image and file attachments
- generated images
- citations and source previews
- specification documents
- GitHub item cards
- GitHub action proposals and results
- skill status
- auto-mode status
- attention prompts
- task handoffs
- tool/progress events
- error, retry, stop, copy, and external-open actions

Marker parsing is strict. Unknown or malformed rich markers render as safe text
or a non-interactive unsupported card, never executable UI.

### Composer

The composer supports:

- multiline text
- Enter to send and Shift+Enter for newline
- attachment picker
- paste and drag/drop
- project and context chips
- slash-command discovery for supported Cave commands
- send and stop states
- validation and upload progress

Attachments are prepared locally only as needed for preview and upload. Chat
does not store large base64 payloads in web storage.

### Settings

Settings include:

- appearance and reduced motion
- notifications
- startup behavior
- global quick-chat shortcut
- default familiar and project
- Cave endpoint and connection diagnostics
- paired credential state and re-pair action
- application and API version information

## Visual Direction

The approved direction is full Coven atmosphere:

- near-black ritual-tech surfaces
- cyan circuitry and focus accents
- violet depth and selection states
- familiar-specific color glows
- restrained sacred geometry in empty and ambient surfaces
- clear, human-readable message bubbles and cards

The design must avoid terminal cosplay. Dense monospace text, decorative scan
lines, and constant animation are not default UI treatments. Native-feeling
controls, readable typography, strong hierarchy, and accessible contrast take
priority.

Motion is subtle and deterministic: connection pulses, streaming indicators,
card arrival, and restrained background atmosphere. Reduced-motion mode removes
nonessential movement.

## Offline and Cache Behavior

Chat maintains an encrypted, replaceable read cache for recently accessed
rosters, summaries, and conversations. The cache exists only to make startup
and temporary outages readable.

While Cave is unavailable:

- cached history may be read
- local view preferences remain editable
- canonical mutations and sends are disabled
- the composer preserves an unsent local draft
- no message is queued for automatic later submission

This avoids duplicate turns and misleading success states. Once reconnected,
Chat refreshes canonical revisions before enabling writes.

## Error Handling

Errors are explicit and state-specific:

- pairing denied or expired
- credential revoked
- Cave unavailable
- incompatible API
- familiar unavailable
- project access denied
- invalid attachment
- send rejected
- stream interrupted and resumed
- stream reconciliation required
- action rejected or failed

The client does not use success-shaped fallbacks. Unknown server errors remain
errors and include a copyable diagnostic identifier without exposing secrets.

## Security

- Bind the client API to loopback/local transport by default.
- Require bearer authentication after the pairing bootstrap.
- Store tokens in platform keychains, never localStorage.
- Store token hashes, scopes, timestamps, and revocation state in Cave.
- Use constant-time token verification.
- Expire and single-use pairing grants.
- Rate-limit pairing and authenticated endpoints.
- Validate Origin where applicable and do not rely on CORS as authentication.
- Enforce content type, frame, request, attachment count, and attachment size
  limits.
- Allowlist attachment MIME types and verify content rather than trusting file
  extensions.
- Sanitize Markdown and prohibit arbitrary HTML/script execution.
- Treat rich action markers as data requiring a user gesture and server
  authorization.
- Redact credentials, attachment bodies, and sensitive prompt data from logs.
- Keep Chat free of direct shell, GitHub credential, and filesystem authority.

## Testing

### Cave Contract Tests

Cover:

- pairing create, approve, deny, expire, exchange, revoke, and replay rejection
- scope enforcement and constant-time token validation behavior
- health/capability negotiation and incompatible versions
- familiar, project, summary, conversation, and search projections
- conversation creation and mutation idempotency
- upload validation and bounds
- send validation and familiar/project ownership
- SSE ordering, duplicate handling, resume, replay gap, heartbeat, and terminal
  events
- rich action authorization and idempotency
- contract schema snapshots for v1

### Chat Unit and Component Tests

Cover:

- API schema parsing and stable error envelopes
- connection and pairing state machines
- stream reduction and cursor checkpointing
- canonical reconciliation
- cache revision ordering
- sidebar sorting, search, and familiar filters
- composer keyboard, draft, paste, drop, attachment, send, and stop behavior
- every rich message renderer
- malformed and unknown marker safety
- keyboard navigation, focus management, and screen-reader semantics

### Tauri Tests

Cover:

- platform discovery records
- managed Cave launch
- readiness deadlines and process errors
- keychain write/read/delete
- global shortcut registration
- deep links and single-instance behavior
- window state and lifecycle

### Integration and End-to-End Tests

Exercise:

1. discover and pair
2. list familiars and canonical chats
3. create and open a conversation
4. send and stream a turn
5. interrupt and resume the stream
6. stop and retry
7. rename, pin, archive, and delete
8. execute approved rich actions
9. confirm Cave and Chat show the same canonical transcript
10. revoke the token and require pairing again

Visual coverage includes high-contrast states, reduced motion, long messages,
long code blocks, all rich cards, attachment failures, empty states, narrow
windows, and disconnected states.

## Delivery Sequence

### Phase 1: Cave Client Contract

- Define v1 schemas and stable errors.
- Add health and capabilities.
- Add pairing, scoped credential storage, and Cave approval UI.
- Add authenticated roster, project, conversation, and search projections.

### Phase 2: Chat Foundation

- Scaffold React/TypeScript/Tauri.
- Implement desktop discovery, managed startup, keychain, and pairing.
- Implement full Coven design tokens and application shell.
- Add canonical sidebar and conversation reads.

### Phase 3: Send and Recovery

- Add composer and attachments.
- Add send, stop, retry, and typed SSE.
- Add cursor resume, transcript reconciliation, and encrypted read cache.

### Phase 4: Rich Semantics

- Add Markdown/code, citations, images, specs, GitHub cards/actions, skill and
  auto status, attention prompts, progress/tool states, and task handoffs.
- Add strict marker parsing and safe unsupported states.

### Phase 5: Desktop Polish and Packaging

- Add global shortcut, notifications, settings, diagnostics, and accessibility.
- Complete platform packaging and release validation for macOS, Windows, and
  Linux.

Each phase must remain additive and independently testable. Cave's current UI
continues to work throughout the rollout.

## Success Criteria

The work is complete when:

- Chat pairs with Cave through an explicit, revocable approval.
- Chat can manage the Cave service lifecycle on all supported platforms.
- All visible conversations and turns are canonical Cave records.
- A conversation created or changed in either app appears correctly in the
  other after refresh/revalidation.
- Familiar identity remains explicit and contract-correct.
- A streamed turn survives a client disconnect without duplicate submission.
- V1 rich message types render safely and actions execute only through Cave.
- Offline mode is clearly read-only and preserves unsent drafts.
- Accessibility, contract, integration, and packaging gates pass on macOS,
  Windows, and Linux.

