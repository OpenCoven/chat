# OpenCoven Chat WorkOS Onboarding Design

Status: approved in design review, 2026-09-16. Implementation plan to follow.

Related: `docs/superpowers/specs/2026-08-20-phase-1-discovery-pairing-design.md`
(the dormant Cave pairing stack this design deliberately does not touch),
`docs/releasing.md`, `SECURITY.md`.

## Summary

The next release gates the desktop app behind a WorkOS sign-in and replaces
today's dead-end empty states with a guided, assisted setup. A person who opens
the app for the first time signs in with WorkOS AuthKit, sees which
prerequisites are missing, runs the exact commands the app shows them, and
lands in a working conversation with their own familiars.

Three facts found during design shape everything below:

1. **Real-data chat already works.** `src/main.tsx` renders `ChatApp`, which
   drives the local `coven` CLI through `src-tauri/src/coven_runtime.rs`.
   Nothing is mocked on the shipped path. What stops a new user is
   prerequisites, not missing code.
2. **The app has no user identity, on purpose.** Its stated posture is a client
   for a server the user runs themselves, with no hosted service and nothing to
   sign in to. The Cave pairing stack in Rust is complete but unreachable from
   `main.tsx`, and a guard test keeps it that way.
3. **The repository is public.** A sign-in gate on a local-only app is
   therefore a product gate — deterrence and identity capture — not a security
   boundary. This design is honest about that and does not build anti-tamper
   machinery that cannot hold.

## Goals

- Require a valid WorkOS session before the chat surface renders.
- Keep the app usable offline for a bounded window after a successful check.
- Turn every prerequisite failure into a visible, actionable step with the
  exact command shown before it runs.
- Keep every token, verifier and state value in native code. Nothing secret
  crosses IPC.
- Leave `coven_runtime.rs`, the Cave stack and the CSP untouched. `ChatApp`
  gains one optional `account` prop for sign-out and is otherwise unchanged.

## Non-Goals

- A hosted OpenCoven service, sync, billing, or server-side familiars.
- Tamper resistance. A fork can remove the gate; that is accepted.
- Installing Node or npm. The wizard stops at Node and hands off.
- Team or enterprise SSO, organization membership, or role enforcement.
  The JWT's `entitlements` and `org_id` claims are surfaced, not enforced.
- Claiming the `oauth-ui` conformance scope. It stays `not-covered` until the
  flow is exercised under the harness.
- Windows chat. The runtime already refuses it; onboarding says so plainly.

## Decisions Log

Recorded so the reasoning survives the people who made it.

| Decision | Choice | Why |
| --- | --- | --- |
| What WorkOS authorizes | Entitlement to use the app; data stays local | Smallest coherent option; no backend required |
| Re-verification | Cache + periodic re-check, 14-day grace | Local-first tool; must survive airgaps; still revocable |
| Onboarding scope | Sign-in + one-click assisted install | Automated from the user's seat, every command auditable |
| Install depth | Coven via npm, user-space; stop at Node | Bounded, no elevation, official registry |
| Architecture | Native identity layer (A) over Cave reuse (B) or JS PKCE (C) | Fits "no secrets in JavaScript"; Cave is the wrong shape; custom schemes are hijackable |
| Native conventions | Follow shipped `coven_runtime_*` (string errors, `run_id`, `Channel`) | Not the dormant Cave lease pattern; consistency with the live path |
| Redirect | `http://127.0.0.1:<port>/callback` | WorkOS's only production exception for native clients; RFC 8252 |

## Approved Product Behavior

### First launch

The app opens on an onboarding surface, not the chat. It offers **Sign in with
WorkOS**. Outside the desktop shell (browser preview) it shows the existing
"requires the desktop app" notice and no sign-in button.

### Sign-in

The system browser opens on AuthKit. When the person finishes, the browser shows
a small "You can close this tab" page, the app window comes to the front, and
onboarding moves to prerequisites. Sign-in times out after ten minutes, matching
WorkOS's authorization-code validity.

### Prerequisites

A checklist with one row per requirement: supported platform, Node, npm, Coven
CLI, Coven engine, a familiar with a valid workspace. Each row is green or shows
a one-line reason. For Coven CLI and engine, a failed row shows the exact
command and a **Run** button. Output streams into the row as it happens. On
success the row re-checks and turns green. Node or npm missing shows a link and
a copyable command, never a Run button.

On Windows the surface states that chat is not yet available there and offers
nothing to install.

### Ready

When the session is valid and every row is green, `ChatApp` renders exactly as
it does today.

### Later launches

Silent when the cached session verifies. Inside the grace window with no
network, the app opens with a quiet caption: "Couldn't re-verify — N days
remaining." Past the window, or on revocation, it returns to sign-in.

### Sign-out

Reachable in two places: on the onboarding surface before `ready`, and, once
the chat is showing, inside the sidebar's existing **User settings**
disclosure as a "Signed in as <email> · Sign out" row. Clears the local session
and returns to sign-in. Drafts and navigation follow their existing rules and
are not touched by sign-out.

This is the one place `ChatApp` changes: it accepts an optional `account`
prop (`{ email, onSignOut }`) and passes it to the disclosure. Absent the prop,
it renders exactly as today.

## Architecture

```
src/main.tsx
  └─ <Onboarding>                                src/onboarding/onboarding.tsx
       ├─ identity_status / identity_sign_in …  src-tauri/src/identity.rs
       │     └─ OS keyring, account workos-session-v1
       ├─ setup_check / setup_run / setup_cancel src-tauri/src/setup.rs
       │     └─ reuses coven_runtime::resolve_cli and process containment
       └─ when entitled && ready → <ChatApp>    + optional account prop
```

### `identity.rs`

Owns the WorkOS lifecycle: PKCE, the loopback callback listener, opening the
browser, the code-for-token exchange, refresh, verification and storage. The
webview receives only a non-secret status.

Dependencies added: `reqwest` gains the `rustls-tls` feature (the crate is
built with `default-features = false` and has never spoken TLS — the app only
ever reached loopback HTTP); `jsonwebtoken = "=11.1.0"` (MSRV 1.88, below the
pinned 1.95) for JWT and JWKS verification. No Tauri plugin is added; the
browser is opened with `std::process::Command` (`open`, `xdg-open`,
`cmd /c start`).

### `setup.rs`

Owns prerequisite detection and assisted install. Detection of `coven` calls
`resolve_cli()` verbatim so "detected" means what "runnable" means today.
Execution goes through the runtime's existing bounded, cancellable process
helper so the installer inherits its containment.

### Webview

`src/lib/identity.ts` and `src/lib/setup.ts` mirror `src/lib/coven-runtime.ts`:
the same `record` / `optionalText` / `oneOf` guards, the same `checked()`
choke point, the same `UNAVAILABLE` message outside Tauri, and the same
`create*({ available, invoke })` injection for tests.

`src/onboarding/onboarding.tsx` is a state machine that renders `<ChatApp>`
only in its terminal state.

### Configuration

`WORKOS_CLIENT_ID` is public by construction (PKCE has no secret) and ships in
`src-tauri/tauri.conf.json`. The WorkOS dashboard needs a non-wildcard default
redirect and the wildcard-port loopback entry `http://127.0.0.1:*/callback`.
No secret enters the repository, the binary, or the webview.

## Command Contracts

All commands return `Result<Value, String>` and are registered in
`src-tauri/src/lib.rs` and `src-tauri/capabilities/default.json` alongside the
existing `coven_runtime_*` commands.

### Identity

| Command | Kind | Contract |
| --- | --- | --- |
| `identity_status` | read | `{ state, email?, checkedAt?, graceUntil? }`, `state ∈ signed_out \| entitled \| expired \| revoked` |
| `identity_sign_in(runId, onEvent: Channel)` | mutation, cancellable | streams `{ type: waiting \| received \| exchanged \| done \| error, text? }` |
| `identity_cancel_sign_in(runId)` | | tears down the listener; mirrors `coven_runtime_cancel` |
| `identity_sign_out` | mutation | deletes the record; best-effort revoke; local deletion succeeds regardless |

### Setup

| Command | Contract |
| --- | --- |
| `setup_check` | `{ platform, node, npm, coven, engine, familiar }`, each `{ ok, detail?, path? }` |
| `setup_run({ runId, step }, onEvent: Channel)` | `step ∈ install_cli \| install_engine`; streams `{ type: stdout \| stderr, text }` then `{ type: exit, code, cancelled }` |
| `setup_cancel(runId)` | kills the process tree |

`step` selects one of exactly two fixed argument vectors:

```
install_cli    → npm install -g --prefix ~/.local @opencoven/cli
install_engine → coven engine install
```

No string from the webview reaches `Command::new` or any argument. The UI shows
the same vector it will run.

### Capabilities

Seven permissions are added: `allow-identity-status`,
`allow-identity-sign-in`, `allow-identity-cancel-sign-in`,
`allow-identity-sign-out`, `allow-setup-check`, `allow-setup-run`,
`allow-setup-cancel`.

## State Model

### Native session record

Keyring service `ai.opencoven.chat`, account `workos-session-v1`:

```
{ accessToken, refreshToken, expiresAt, checkedAt, subject, email }
```

At most 4 KiB. Token fields are zeroized on drop. Writes use the existing
compare-and-swap helpers so a concurrent writer loses rather than clobbers.

The JWKS is public and cached as JSON in the app data directory with a
`fetchedAt`. It is fetched at sign-in and refreshed opportunistically.

### Status derivation

A pure function of `(record, now, jwks)`:

| Condition | State |
| --- | --- |
| no record | `signed_out` |
| record unparseable | `signed_out`, record retained, reported |
| JWKS absent | `expired` — an unverifiable token is not trusted |
| JWT verifies and `now < exp` | `entitled` |
| JWT expired, `checkedAt + 14d > now` | attempt refresh; success → `entitled`; network failure → `entitled` with caption; `invalid_grant` → `revoked`, record deleted |
| `checkedAt + 14d ≤ now` | `expired` |

Verification checks signature, `iss = https://api.workos.com`, `client_id`,
and `exp`. `alg=none` is rejected.

### Onboarding surface

`checking → sign_in → prerequisites → ready`, plus an `unavailable` branch for
browser preview and an `unsupported` branch for Windows. Every §Error Handling
row maps to a rendered state with a next action.

## Data and Secret Flow

### Launch

1. `Onboarding` mounts. If `!canUseTauriCommands()`, render `unavailable`.
2. `identity_status`. `entitled` continues; anything else renders `sign_in`.
3. `setup_check`. All `ok` → `ready`, render `ChatApp`. `platform.ok` false →
   `unsupported`. Otherwise `prerequisites`.

### Sign-in

1. Webview calls `identity_sign_in(runId, channel)`.
2. Native: 43–128 character verifier from `getrandom`, S256 challenge, random
   `state`; bind `127.0.0.1:0`; build
   `https://api.workos.com/user_management/authorize?client_id=…&redirect_uri=http://127.0.0.1:<port>/callback&response_type=code&provider=authkit&code_challenge=…&code_challenge_method=S256&state=…`;
   open the browser; emit `waiting`.
3. The listener accepts one connection. On `state` mismatch or missing `code`
   it answers `400`, emits `error`, and closes. On match it answers the close-tab
   page, emits `received`, and closes.
4. `POST https://api.workos.com/user_management/authenticate` with
   `{ client_id, grant_type: "authorization_code", code, code_verifier }`. The
   returned JWT is verified before anything is trusted. Emit `exchanged`.
5. Write the record with `checkedAt = now`. Fetch the JWKS if absent. Focus the
   main window. Emit `done`.
6. Webview re-runs `identity_status` and proceeds.

### Re-check

A refresh grant: `grant_type: "refresh_token"` with the stored token and
`client_id`. Refresh tokens rotate and are single-use; the returned pair
replaces the record atomically. Attempted at launch when the access token has
expired and opportunistically thereafter.

### Assisted install

1. `prerequisites` renders each row with its `detail`; a failed `coven` or
   `engine` row shows its command and **Run**.
2. `setup_run` spawns the fixed vector under the runtime's cancellation and
   containment, streaming lines as they arrive, then `exit`.
3. On exit code 0 the webview re-runs `setup_check`.

### Never crosses IPC

Access token, refresh token, code verifier, `state`.

## Error Handling

Every error reaches the webview as a bounded string (≤ 2048 characters). No
failure bypasses the gate; each falls closed to a state with a next action.

### Identity

| Failure | State | User sees |
| --- | --- | --- |
| Outside Tauri | `unavailable` | Existing desktop-app notice; no sign-in button |
| Keyring unreadable | error | "Can't read the system keychain" + Retry |
| Record unparseable | `signed_out` | Not deleted; "Saved sign-in is unreadable — sign out to clear it" |
| JWKS cache missing offline | `expired` | "Connect once to verify your sign-in" |
| Port bind fails | error | Retry; fresh `127.0.0.1:0` each attempt |
| Browser fails to open | error | The authorize URL shown for manual copy |
| No callback in 10 min | error | "Sign-in timed out"; listener torn down |
| `state` mismatch / no `code` | error | Browser `400`; "Sign-in response was invalid — try again" |
| Exchange 4xx | error | WorkOS `error_description`, bounded; not auto-retried |
| Exchange 5xx / network | error | Retryable |
| JWT fails verification | error | Nothing stored; "Couldn't verify the sign-in" |
| Refresh `invalid_grant` | `revoked` | Record deleted; "Access was revoked — sign in again" |
| Refresh network error, inside grace | `entitled` | "Couldn't re-verify — N days remaining" |
| Grace elapsed offline | `expired` | Sign in again |
| Sign-out revoke fails | `signed_out` | Local deletion succeeds; revoke is best-effort |

### Setup

| Failure | User sees |
| --- | --- |
| Node or npm absent | Copyable command and link; no Run button |
| Non-zero exit | Exit code and the last 40 lines; Run again |
| Cancelled | Process tree killed; `exit` carries `cancelled: true` |
| Windows | "Chat isn't available on Windows yet"; nothing offered |
| Post-install check still fails | `detail` names what was sought and where |

## Security Requirements

- No bearer, refresh token, verifier or `state` in JavaScript, in
  `localStorage`, or in any Tauri event payload. Enforced by a test that greps
  `src/**` for `access_token`, `refresh_token`, `accessToken`, `refreshToken`
  and `code_verifier` and expects **zero** matches. The webview never has a
  legitimate reason to name these; the only place they exist is
  `src-tauri/src/identity.rs`.
- The loopback listener binds `127.0.0.1` only, accepts exactly one request,
  and is torn down on success, failure, cancel or timeout.
- The browser opener accepts only a URL it constructed with the
  `api.workos.com` authorize base. A foreign URL is rejected before any
  `Command` exists.
- `setup_run` has no path from webview input to an argument.
- The CSP is unchanged: the webview still cannot reach the network.
- The keyring record is bounded, zeroized and CAS-written, matching the
  existing credential store.
- `WORKOS_CLIENT_ID` is the only WorkOS value in the repository, and it is not
  a secret.

## Testing Strategy

### Rust

- PKCE verifier length and charset; S256 against a known vector.
- JWT verification against a test JWKS generated in-test: valid accepted; wrong
  `iss`, wrong `client_id`, expired, bad signature, `alg=none` rejected.
- Status derivation, table-driven over every row of the state model.
- Listener against a real `127.0.0.1:0` socket: one accepted request; `state`
  mismatch → 400 and no exchange; missing `code` → 400; second connection
  refused; timeout tears down.
- Record round-trip, 4 KiB bound, zeroize on drop, CAS loses on stale current.
- Opener rejects a foreign URL before constructing a `Command`.
- `setup.rs`: the two `step → argv` mappings asserted as exact fixtures;
  detection as a pure function over an injected probe; cancellation reuses the
  runtime's reap test pattern.

### JavaScript

- `createIdentity({ invoke })` and `createSetup({ invoke })` with a mocked
  `invoke`: guards reject every malformed shape; nothing token-shaped is ever
  accepted into a status object.
- `onboarding.tsx` with Testing Library: each state and every error row renders
  the specified text and next action.

### Guard tests

- `single-entrypoint.test.ts`: the existing assertion that `main.tsx` imports
  `./coven/chat-app` **moves**, not weakens — `main.tsx` must import
  `./onboarding`, and `onboarding.tsx` must import `./coven/chat-app`. The
  no-demo-mode assertions are unchanged.
- `capabilities/default.json` lists exactly the seven new permissions.
- The IPC-boundary grep described under Security Requirements.

### Manual

The live WorkOS round-trip and the real `npm install` cannot be automated
honestly. Each gets a short checklist in `docs/`.

### Conformance

The `oauth-ui` scope continues to emit `phase1.scope.oauth-ui.not-covered`.
The evidence contract stays truthful; claiming the scope is a follow-up.

## Execution and Review

Ordered so each wave is shippable and reviewable alone.

1. **Native identity.** `identity.rs`, dependencies, keyring record, status
   derivation, listener, opener. Rust tests. No UI.
2. **Native setup.** `setup.rs`, fixed vectors, detection, streaming,
   cancellation. Rust tests.
3. **Webview clients.** `identity.ts`, `setup.ts`, guards, tests.
4. **Onboarding surface.** State machine, prerequisites UI, error states,
   Testing Library coverage, guard-test updates, capabilities.
5. **Release.** `WORKOS_CLIENT_ID` in `tauri.conf.json`, dashboard redirect
   entries, manual checklists in `docs/`, release notes.

Waves 1 and 2 are independent and may proceed in parallel. Wave 4 depends on 3.
Wave 5 is the last thing to land before the tag.
