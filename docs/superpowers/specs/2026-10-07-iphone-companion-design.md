# Chat iPhone companion

Authorized by Val's request to complete a Modex-style mobile companion on 2026-10-07.
This supersedes the August Cave-dependent iOS design for the current Chat product.

The native SwiftUI iPhone app pairs with the running Mac Chat application. The Mac
continues to own Coven execution, app-owned history, familiar identity, permissions,
run exclusion and cancellation. The phone never executes a CLI or talks to Cave.

## User flow

Desktop settings offer iPhone companion, off by default. Enabling starts a local
HTTPS listener and displays a QR and private pairing link. The phone scans or
pastes the link; it validates a private IPv4 HTTPS address and pins the exact
certificate SHA-256 before sending the bearer. Pairing persists in device-only
Keychain. Desktop Turn off closes connections; Forget phones rotates credentials.
The phone's Forget Mac clears credentials and in-memory conversation state.

A paired phone lists real familiars, reads their Chat history, sends text, shows
incrementally arriving replies, and stops a run. Archived chats remain readable
but cannot send. Offline state is explicit, drafts remain in memory, retrying a
read never resubmits a send. The Mac must be awake and running. Conversations are
not written to phone storage. No fabricated production messages or demo runtimes.

Same-network access is the initial supported transport. Bonjour can offer candidate
addresses for the saved Mac; only the pinned certificate authenticates a candidate.
No public relay, push notifications, Android client, attachments, approvals or
remote shell are part of this first companion (Chat currently runs read-only).

## Protocol v1

Pairing link: `coven-chat://pair?endpoint=<https private-ip:port>&token=<64 hex>&fingerprint=<64 hex>`.
No redirects, browser Origin requests, or plaintext listeners. Auth header:
`Authorization: Bearer <token>`. JSON errors: `{ "error": "bounded safe message" }`.
Reject oversized requests and unknown request fields. Responses use Cache-Control: no-store.

- `GET /v1/snapshot`: `{version:1, familiars:[{id,name,displayName,description?,emoji?}], sessions:[{id,familiarId,title,archived}], activeRun: Run|null}`.
- `GET /v1/history?familiarId=...`: `{sessionId:string|null,messages:Message[],hasMore:boolean,activeRunId:string|null}`.
  History excludes the current turn when activeRunId is set; append only that run's messages. A null activeRunId means history is self-contained.
- `POST /v1/send`: `{requestId:string,familiarId:string,sessionId:string|null,prompt:string}` -> Run. The request ID is the run ID and retries of an identical accepted request cannot spawn a second run. Changed content under the same ID is rejected.
- `GET /v1/run?id=...`: Run, including incremental message state. Polling is recoverable after network interruption and foregrounding.
- `POST /v1/stop`: `{runId:string}` -> `{ok:true}`. Uses the shared runtime cancellation guard.
- Message: `{id:string,role:"user"|"assistant"|"status",text:string}`. Project paths, backend session handles and tool arguments are excluded from the wire projection.
- Run: `{id:string,familiarId:string,status:"running"|"completed"|"failed"|"stopped",messages:Message[],error?:string}`.

Desktop IPC: `companion_status`, `companion_enable`, `companion_disable`,
`companion_forget`, plus `companion_active_run` and the `companion-run` event for
shared desktop status. The controls return `{enabled:boolean,pairingLink?:string,error?:string}`.
Pairing secrets stay in memory in the webview only while the companion panel is open.
Host credentials persist privately under the app's local data directory.

## Acceptance

Rust tests cover auth, bounds, projection, pairing lifetime, revocation, stop and
idempotency. Native tests cover malformed pairing, certificate pin rejection,
Keychain lifecycle, stale responses and send recovery. Desktop tests exercise
controls. A native simulator flow must pair to the real Rust HTTPS transport,
read a fixture familiar, send, observe a reply and stop; fixture execution is
explicitly test-only. Build the iOS Release device target and verify CI wiring.
Physical-device acceptance and TestFlight distribution must be reported separately
from simulator/source evidence; never infer them from an Xcode build.
