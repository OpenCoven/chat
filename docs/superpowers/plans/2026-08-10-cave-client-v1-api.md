# Cave Client v1 API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a stable, loopback-only, paired and scoped `/api/client/v1` Cave API that exposes canonical familiar chat without duplicating Cave state or authority.

**Architecture:** New route handlers delegate to focused `src/lib/server/client-v1/*` services and existing Cave domain services. Native clients bypass the private sidecar token only at a narrowly marked loopback boundary; route-level bearer authentication enforces per-client scopes. Pairing requests are short-lived and single-use, credentials persist only token hashes, and all mutations use a persistent idempotency ledger.

**Tech Stack:** Next.js 16 route handlers, TypeScript 6, Node 24 crypto/filesystem APIs, React 19 settings UI, existing Cave conversation/stream/action services, Node test runner, Playwright.

**Depends on:** `docs/superpowers/specs/2026-08-10-opencoven-chat-design.md`

**Repository:** `/Users/buns/Documents/GitHub/OpenCoven/coven-cave`

**Commit policy:** Every commit step is a proposed checkpoint. Do not execute it without Val's explicit approval.

---

## File Structure

### Contract and security

- Create `src/lib/server/client-v1/contract.ts` for public v1 types, constants, parsers, and scope definitions.
- Create `src/lib/server/client-v1/responses.ts` for the stable success/error response envelope.
- Create `src/lib/server/client-v1/rate-limit.ts` for bounded in-process pairing and authenticated request limits.
- Create `src/lib/server/client-v1/pairing-store.ts` for expiring, single-use in-memory pairing requests.
- Create `src/lib/server/client-v1/credential-store.ts` for hash-only persistent credentials and revocation.
- Create `src/lib/server/client-v1/auth.ts` for loopback marker and scoped bearer authorization.
- Create `src/lib/server/client-v1/idempotency-store.ts` for persistent mutation claims and completed results.
- Modify `src/proxy.ts` and `src/proxy-helpers.ts` to admit only loopback
  non-admin client-v1 traffic and stamp an unforgeable internal marker. Client
  admin routes continue through Cave's existing sidecar-token and CSRF gates.

### Domain adapters

- Create `src/lib/server/client-v1/read-model.ts` for familiar, project, session, conversation, and search projections.
- Create `src/lib/server/chat-send-service.ts` to expose the existing send pipeline as a callable service.
- Create `src/lib/server/client-v1/chat-service.ts` for create/mutate/send/retry/stop delegation and idempotency.
- Create `src/lib/server/client-v1/attachment-service.ts` for bounded multipart upload and canonical attachment reads.
- Create `src/lib/server/client-v1/action-service.ts` for attention, task, and GitHub action delegation.
- Create `src/lib/server/client-v1/sse.ts` for the versioned stream wrapper over `chat-stream-buffer`.

### Routes and UI

- Create route handlers under `src/app/api/client/v1/**/route.ts`.
- Create `src/components/settings-client-access.tsx` for pending approvals and paired-client revocation.
- Create `src/styles/settings-client-access.css` using the existing Cave token contract.
- Modify `src/components/settings-shell.tsx` to register the Client Access settings section.
- Modify `src/app/api/api-contracts.test.ts` and `scripts/run-tests.mjs` to wire every new route and test.

## Public Contract

The implementation must use these route groups:

| Method | Path | Authentication | Scope |
| --- | --- | --- | --- |
| GET | `/api/client/v1/health` | loopback marker | none |
| POST | `/api/client/v1/pairing/requests` | loopback marker + rate limit | none |
| GET | `/api/client/v1/pairing/requests/[id]` | request secret | none |
| POST | `/api/client/v1/pairing/requests/[id]/exchange` | request secret | none |
| GET | `/api/client/v1/admin/pairing-requests` | Cave local UI | admin |
| POST | `/api/client/v1/admin/pairing-requests/[id]/decision` | Cave local UI | admin |
| GET | `/api/client/v1/admin/credentials` | Cave local UI | admin |
| DELETE | `/api/client/v1/admin/credentials/[id]` | Cave local UI | admin |
| GET | `/api/client/v1/familiars` | bearer | `chat:read` |
| GET | `/api/client/v1/projects` | bearer | `chat:read` |
| GET | `/api/client/v1/commands` | bearer | `chat:read` |
| GET/POST | `/api/client/v1/conversations` | bearer | `chat:read` / `conversations:write` |
| GET/PATCH/DELETE | `/api/client/v1/conversations/[id]` | bearer | `chat:read` / `conversations:write` |
| GET | `/api/client/v1/conversations/search` | bearer | `chat:read` |
| POST | `/api/client/v1/messages/send` | bearer | `chat:write` |
| GET | `/api/client/v1/runs/[id]/stream` | bearer | `chat:read` |
| POST | `/api/client/v1/runs/[id]/stop` | bearer | `chat:write` |
| POST | `/api/client/v1/runs/[id]/retry` | bearer | `chat:write` |
| POST | `/api/client/v1/attachments` | bearer | `attachments:write` |
| GET | `/api/client/v1/attachments/[id]` | bearer | `chat:read` |
| POST | `/api/client/v1/attention/[id]/respond` | bearer | `tasks:write` |
| POST | `/api/client/v1/tasks/handoff` | bearer | `tasks:write` |
| POST | `/api/client/v1/github/actions` | bearer | `github:write` |

All mutation routes require an `Idempotency-Key` header containing a UUID.
Pairing poll and exchange routes receive the one-time request secret in
`X-Coven-Pairing-Secret`, never in a URL or loggable query string.

Focused server tests below use Cave's CSS source hook and alias loader. Add each
new server test to `ALIAS_LOADER`, each rendered TSX test to `VITEST_TESTS`, and
every test to the appropriate `SUITES` list in `scripts/run-tests.mjs`.

### Task 1: Define and lock the v1 contract

**Files:**
- Create: `src/lib/server/client-v1/contract.ts`
- Create: `src/lib/server/client-v1/contract.test.ts`
- Create: `src/lib/server/client-v1/responses.ts`
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Write failing parser and envelope tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  CLIENT_V1_SCOPES,
  parseIdempotencyKey,
  parsePairingRequest,
} from "./contract.ts";
import { clientV1Error } from "./responses.ts";

test("pairing requests accept only known least-privilege scopes", () => {
  assert.deepEqual(
    parsePairingRequest({
      appName: "OpenCoven Chat",
      installationId: "9f4145de-9b43-4abc-876d-81ef63de60e0",
      scopes: ["chat:read", "chat:write"],
    }),
    {
      appName: "OpenCoven Chat",
      installationId: "9f4145de-9b43-4abc-876d-81ef63de60e0",
      scopes: ["chat:read", "chat:write"],
    },
  );
  assert.throws(() => parsePairingRequest({ appName: "x", installationId: "x", scopes: ["admin"] }));
  assert.equal(CLIENT_V1_SCOPES.includes("admin" as never), false);
});

test("idempotency keys must be UUIDs", () => {
  assert.equal(parseIdempotencyKey("9f4145de-9b43-4abc-876d-81ef63de60e0"), "9f4145de-9b43-4abc-876d-81ef63de60e0");
  assert.throws(() => parseIdempotencyKey("retry-me"));
});

test("errors use the stable client envelope", async () => {
  const response = clientV1Error(403, "scope_denied", "Missing required scope.", false);
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: { code: "scope_denied", message: "Missing required scope.", retryable: false },
  });
});
```

- [ ] **Step 2: Run the test and confirm the missing modules fail**

Run: `node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types --import ./scripts/test-alias-register.mjs --test src/lib/server/client-v1/contract.test.ts`

Expected: FAIL with `ERR_MODULE_NOT_FOUND`.

- [ ] **Step 3: Implement the public types and strict parsers**

```ts
export const CLIENT_V1_API_VERSION = "1.0";
export const CLIENT_V1_MIN_CLIENT_VERSION = "0.1.0";
export const CLIENT_V1_SCOPES = [
  "chat:read",
  "chat:write",
  "conversations:write",
  "attachments:write",
  "tasks:write",
  "github:write",
] as const;

export type ClientV1Scope = (typeof CLIENT_V1_SCOPES)[number];
export type ClientV1ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "scope_denied"
  | "not_found"
  | "conflict"
  | "rate_limited"
  | "pairing_pending"
  | "pairing_denied"
  | "pairing_expired"
  | "incompatible_version"
  | "service_unavailable"
  | "internal_error";

export type ClientV1ErrorBody = {
  ok: false;
  error: {
    code: ClientV1ErrorCode;
    message: string;
    retryable: boolean;
    details?: Record<string, string>;
    diagnosticId?: string;
  };
};

export type PairingRequestInput = {
  appName: string;
  installationId: string;
  scopes: ClientV1Scope[];
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseIdempotencyKey(value: string | null): string {
  const key = value?.trim() ?? "";
  if (!UUID_RE.test(key)) throw new Error("invalid idempotency key");
  return key;
}

export function parsePairingRequest(value: unknown): PairingRequestInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid body");
  const body = value as Record<string, unknown>;
  const appName = typeof body.appName === "string" ? body.appName.trim() : "";
  const installationId = typeof body.installationId === "string" ? body.installationId.trim() : "";
  const scopes = Array.isArray(body.scopes) ? [...new Set(body.scopes)] : [];
  if (appName.length < 2 || appName.length > 80 || !UUID_RE.test(installationId)) throw new Error("invalid identity");
  if (!scopes.length || !scopes.every((scope): scope is ClientV1Scope =>
    typeof scope === "string" && CLIENT_V1_SCOPES.includes(scope as ClientV1Scope))) {
    throw new Error("invalid scopes");
  }
  return { appName, installationId, scopes };
}
```

Implement `clientV1Error` and `clientV1Ok` in `responses.ts`; never expose raw thrown messages for 5xx responses.

- [ ] **Step 4: Wire and run the focused test**

Add `"src/lib/server/client-v1/contract.test.ts"` to `SUITES.api`.

Run: `node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types --import ./scripts/test-alias-register.mjs --test src/lib/server/client-v1/contract.test.ts && pnpm check:tests-wired`

Expected: PASS.

- [ ] **Step 5: Commit the contract checkpoint**

```bash
git add src/lib/server/client-v1/contract.ts src/lib/server/client-v1/contract.test.ts \
  src/lib/server/client-v1/responses.ts scripts/run-tests.mjs
git commit -m "feat(client-v1): define public API contract"
```

### Task 2: Add pairing and hash-only credential stores

**Files:**
- Create: `src/lib/server/client-v1/pairing-store.ts`
- Create: `src/lib/server/client-v1/pairing-store.test.ts`
- Create: `src/lib/server/client-v1/credential-store.ts`
- Create: `src/lib/server/client-v1/credential-store.test.ts`
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Write failing lifecycle tests**

Test these exact behaviors:

```ts
test("a pairing exchange is approved, single-use, and expires", () => {
  const created = createPairingRequest(input, 1_000);
  assert.equal(readPairingRequest(created.id, created.secret, 1_001)?.status, "pending");
  assert.equal(decidePairingRequest(created.id, "approved", 1_002), true);
  assert.equal(consumeApprovedPairing(created.id, created.secret, 1_003)?.status, "approved");
  assert.equal(consumeApprovedPairing(created.id, created.secret, 1_004), null);
});

test("credential files contain a hash and never the bearer token", async () => {
  const issued = await issueCredential(approvedPairing, 2_000);
  const disk = await readFile(clientCredentialStorePath(), "utf8");
  assert.equal(disk.includes(issued.token), false);
  assert.equal((await verifyCredential(issued.token, 2_001))?.id, issued.credential.id);
  await revokeCredential(issued.credential.id, 2_002);
  assert.equal(await verifyCredential(issued.token, 2_003), null);
});
```

Use environment-variable store path overrides and test-local temporary directories, following `passkey-store.ts`.

- [ ] **Step 2: Run both tests and verify failure**

Run: `node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types --import ./scripts/test-alias-register.mjs --test src/lib/server/client-v1/pairing-store.test.ts src/lib/server/client-v1/credential-store.test.ts`

Expected: FAIL with missing exports.

- [ ] **Step 3: Implement atomic pairing and credential lifecycles**

`pairing-store.ts` must use:

```ts
export const PAIRING_TTL_MS = 5 * 60_000;
const MAX_PAIRING_REQUESTS = 64;

type PairingRecord = PairingRequestInput & {
  id: string;
  secretHash: string;
  status: "pending" | "approved" | "denied";
  createdAt: number;
  expiresAt: number;
  consumedAt: number | null;
};
```

Generate 32 random bytes for request secrets, store only SHA-256 hashes, compare with `timingSafeEqualString`, delete before returning from `consumeApprovedPairing`, and bound/prune the map.

`credential-store.ts` must persist this schema using `writeJsonAtomic`:

```ts
export type ClientCredential = {
  id: string;
  appName: string;
  installationId: string;
  tokenHash: string;
  scopes: ClientV1Scope[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
};

type ClientCredentialStore = { version: 1; credentials: ClientCredential[] };
```

Use `COVEN_CAVE_CLIENT_CREDENTIAL_STORE_PATH` as a test seam and
`path.join(caveHome(), "client-v1-credentials.json")` as the default.

- [ ] **Step 4: Run lifecycle and wiring checks**

Run: `node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types --import ./scripts/test-alias-register.mjs --test src/lib/server/client-v1/pairing-store.test.ts src/lib/server/client-v1/credential-store.test.ts && pnpm check:tests-wired`

Expected: PASS.

- [ ] **Step 5: Commit the secure-store checkpoint**

```bash
git add src/lib/server/client-v1/pairing-store* src/lib/server/client-v1/credential-store* scripts/run-tests.mjs
git commit -m "feat(client-v1): add paired credential lifecycle"
```

### Task 3: Gate the client surface at loopback and bearer boundaries

**Files:**
- Create: `src/lib/server/client-v1/auth.ts`
- Create: `src/lib/server/client-v1/auth.test.ts`
- Create: `src/lib/server/client-v1/rate-limit.ts`
- Create: `src/lib/server/client-v1/rate-limit.test.ts`
- Modify: `src/proxy-helpers.ts`
- Modify: `src/proxy.ts:162-381`
- Modify: `src/middleware.test.ts`
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Write failing authorization tests**

```ts
test("requireClientPrincipal rejects absent and under-scoped tokens", async () => {
  const missing = await requireClientPrincipal(new Request("http://127.0.0.1/api/client/v1/familiars"), "chat:read");
  assert.equal(missing.ok, false);
  const request = new Request("http://127.0.0.1/api/client/v1/familiars", {
    headers: { authorization: `Bearer ${writeOnlyToken}`, "x-coven-client-v1-local": internalMarker },
  });
  const denied = await requireClientPrincipal(request, "chat:read");
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.response.status, 403);
});
```

Add middleware source assertions that `/api/client/v1`:

- requires `trustedLocalPeer`
- rejects `remoteIngress`
- strips any caller-supplied internal marker
- stamps the marker only after loopback verification
- bypasses sidecar-token auth only for that prefix
- still applies safe content-type checks

- [ ] **Step 2: Run tests and verify the missing gate fails**

Run: `node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types --import ./scripts/test-alias-register.mjs --test src/lib/server/client-v1/auth.test.ts src/lib/server/client-v1/rate-limit.test.ts src/middleware.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement the narrow proxy branch and route auth**

Add constants and predicates to `proxy-helpers.ts`:

```ts
export const CLIENT_V1_LOCAL_HEADER = "x-coven-client-v1-local";
export const CLIENT_V1_PREFIX = "/api/client/v1/";
export function isClientV1Path(pathname: string): boolean {
  return pathname === "/api/client/v1" || pathname.startsWith(CLIENT_V1_PREFIX);
}
export function isClientV1AdminPath(pathname: string): boolean {
  return pathname === "/api/client/v1/admin" || pathname.startsWith("/api/client/v1/admin/");
}
```

In `proxy.ts`, delete any incoming `CLIENT_V1_LOCAL_HEADER`, then before the
sidecar-token gate:

```ts
if (isClientV1Path(req.nextUrl.pathname) && !isClientV1AdminPath(req.nextUrl.pathname)) {
  if (!trustedLocalPeer || remoteIngress) return jsonError(403, "client api requires loopback");
  if (!hasSafeContentType(req)) return jsonError(415, "unsupported content-type");
  const headers = new Headers(req.headers);
  headers.set(CLIENT_V1_LOCAL_HEADER, process.env.COVEN_CAVE_LOCAL_PEER_SECRET ?? "");
  return NextResponse.next({ request: { headers } });
}
```

`auth.ts` verifies the marker using constant-time comparison against the
per-boot local-peer secret, parses `Authorization: Bearer`, calls
`verifyCredential`, updates `lastUsedAt` no more than once per minute, and checks
the requested scope. It consumes the authenticated request bucket only after a
credential verifies, so invalid tokens cannot exhaust a valid client's quota.

`rate-limit.ts` implements a bounded token bucket keyed by request category and
loopback peer: 10 pairing creates/minute and 120 authenticated requests/minute.

- [ ] **Step 4: Run security-focused tests**

Run: `node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types --import ./scripts/test-alias-register.mjs --test src/lib/server/client-v1/auth.test.ts src/lib/server/client-v1/rate-limit.test.ts src/middleware.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the boundary checkpoint**

```bash
git add src/proxy.ts src/proxy-helpers.ts src/middleware.test.ts \
  src/lib/server/client-v1/auth* src/lib/server/client-v1/rate-limit* scripts/run-tests.mjs
git commit -m "feat(client-v1): enforce loopback scoped authentication"
```

### Task 4: Add health, pairing, administration routes, and Cave approval UI

**Files:**
- Create: `src/app/api/client/v1/health/route.ts`
- Create: `src/app/api/client/v1/pairing/requests/route.ts`
- Create: `src/app/api/client/v1/pairing/requests/[id]/route.ts`
- Create: `src/app/api/client/v1/pairing/requests/[id]/exchange/route.ts`
- Create: `src/app/api/client/v1/admin/pairing-requests/route.ts`
- Create: `src/app/api/client/v1/admin/pairing-requests/[id]/decision/route.ts`
- Create: `src/app/api/client/v1/admin/credentials/route.ts`
- Create: `src/app/api/client/v1/admin/credentials/[id]/route.ts`
- Create: colocated `route.test.ts` files
- Create: `src/components/settings-client-access.tsx`
- Create: `src/components/settings-client-access.test.tsx`
- Create: `src/styles/settings-client-access.css`
- Create: `src/client-v1-discovery.test.ts`
- Modify: `server.ts`
- Modify: `src/components/settings-shell.tsx`
- Modify: `src/app/api/api-contracts.test.ts`
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Write health and pairing route tests**

Assert:

```ts
assert.deepEqual(await health.json(), {
  ok: true,
  service: "coven-cave",
  apiVersion: "1.0",
  minimumClientVersion: "0.1.0",
  instanceId,
  pairingRequired: true,
  capabilities: [
    "canonical-conversations",
    "resumable-sse",
    "attachments",
    "attention",
    "task-handoff",
    "github-actions",
  ],
});
```

Pairing tests must cover create, pending poll, approval, denial, expiry, exchange,
exchange replay rejection, unknown scopes, and rate limiting.

- [ ] **Step 2: Run route tests and verify failure**

Run: `node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types --import ./scripts/test-alias-register.mjs --test src/app/api/client/v1/health/route.test.ts src/app/api/client/v1/pairing/requests/route.test.ts src/client-v1-discovery.test.ts`

Expected: FAIL with missing route modules.

- [ ] **Step 3: Implement routes and settings UI**

Health reads a persisted Cave instance ID from
`path.join(caveHome(), "instance-id")`, creating a UUID atomically if absent.

Add a source-contract test and bounded inline helper in `server.ts` that writes
`~/.coven/cave/client-v1-discovery.json` with mode `0600` after `server.listen`
succeeds:

```ts
type ClientV1Discovery = {
  version: 1;
  endpoint: string;
  pid: number;
  nonce: string;
  startedAt: string;
};
```

The server writes through a same-directory temporary file plus rename, and
removes the record on shutdown only when the on-disk nonce still belongs to
that process. Add `src/client-v1-discovery.test.ts` to pin the path, loopback
endpoint, permissions, atomic write, and ownership-safe cleanup. This record is
the primary installed-service discovery contract consumed by Chat.

The pairing create response is:

```ts
{
  ok: true,
  pairing: {
    id: string,
    secret: string,
    status: "pending",
    expiresAt: number,
  },
}
```

The exchange returns the raw token exactly once. Admin routes stay behind the existing sidecar-token and same-origin CSRF path in
`proxy.ts`; they never accept the client bearer scheme and are not included in
the client-v1 bypass branch.

`SettingsClientAccess` polls pending requests every two seconds while visible,
shows app name, installation ID suffix, scopes, and expiration, announces
approve/deny/revoke results with `useAnnouncer`, and uses existing `Button`,
`EmptyState`, and `.focus-ring` primitives.

- [ ] **Step 4: Run API, component, design, and contract checks**

Run:

```bash
node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types --import ./scripts/test-alias-register.mjs --test \
  src/app/api/client/v1/health/route.test.ts \
  src/app/api/client/v1/pairing/requests/route.test.ts \
  src/client-v1-discovery.test.ts
pnpm exec vitest run src/components/settings-client-access.test.tsx
pnpm lint
pnpm check:tests-wired
```

Expected: PASS.

- [ ] **Step 5: Commit the pairing surface checkpoint**

```bash
git add src/app/api/client/v1 src/components/settings-client-access* server.ts \
  src/client-v1-discovery.test.ts \
  src/components/settings-shell.tsx src/styles/settings-client-access.css \
  src/app/api/api-contracts.test.ts scripts/run-tests.mjs
git commit -m "feat(client-v1): add pairing approval surface"
```

### Task 5: Add canonical read projections

**Files:**
- Create: `src/lib/server/client-v1/read-model.ts`
- Create: `src/lib/server/client-v1/read-model.test.ts`
- Create: `src/app/api/client/v1/familiars/route.ts`
- Create: `src/app/api/client/v1/projects/route.ts`
- Create: `src/app/api/client/v1/commands/route.ts`
- Create: `src/app/api/client/v1/conversations/route.ts`
- Create: `src/app/api/client/v1/conversations/[id]/route.ts`
- Create: `src/app/api/client/v1/conversations/search/route.ts`
- Create: colocated route tests
- Modify: `src/app/api/sessions/list/route.ts`
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Extract the side-effect-free session projection under test**

Move `computeSessionsList` from `src/app/api/sessions/list/route.ts` into an
exported `computeCanonicalSessionList` in `read-model.ts`, preserving existing
route behavior. Test that daemon and local conversations merge once, familiar
project grants filter rows, and degraded mode retains local canonical chats.

- [ ] **Step 2: Run existing session tests plus the new read-model test**

Run: `node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types --import ./scripts/test-alias-register.mjs --test src/lib/server/client-v1/read-model.test.ts src/app/api/sessions/list/route.test.ts`

Expected: the new test FAILS before extraction; existing tests remain PASSING.

- [ ] **Step 3: Implement stable client projections**

Define:

```ts
export type ClientConversationSummary = {
  id: string;
  familiarId: string;
  title: string;
  preview: string;
  projectId: string | null;
  projectRoot: string | null;
  status: "idle" | "running" | "failed" | "attention";
  pinned: boolean;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  revision: string;
  revisionTime: number;
};
```

Compute `revision` as a stable SHA-256 digest over canonical identifying and
updated fields, expose `Date.parse(updatedAt)` as `revisionTime`, and return
`revision` as the `ETag`. Chat combines `revisionTime` with its request
generation so an older request cannot overwrite a later response when timestamp
resolution collides. Support cursor pagination with `{ items, nextCursor }`;
encode the last `(updatedAt,id)` pair as base64url. Never expose filesystem-only
familiar configuration or secrets.

The conversation detail route calls `loadConversation`; search calls
`searchConversations`; familiar and project projections call
`loadVisibleFamiliarRoster`, `filterFamiliarsForProject`, `loadProjects`, and
`listAccessibleProjects`. The commands projection uses the existing
`src/lib/slash-commands.ts` registry and advertised harness/model capabilities,
returning only commands the standalone chat client can safely submit.

- [ ] **Step 4: Run all focused projection tests**

Run:

```bash
node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types --import ./scripts/test-alias-register.mjs --test \
  src/lib/server/client-v1/read-model.test.ts \
  src/app/api/client/v1/familiars/route.test.ts \
  src/app/api/client/v1/projects/route.test.ts \
  src/app/api/client/v1/commands/route.test.ts \
  src/app/api/client/v1/conversations/route.test.ts \
  src/app/api/client/v1/conversations/[id]/route.test.ts \
  src/app/api/client/v1/conversations/search/route.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit the canonical-read checkpoint**

```bash
git add src/lib/server/client-v1/read-model* src/app/api/client/v1/familiars \
  src/app/api/client/v1/projects src/app/api/client/v1/commands \
  src/app/api/client/v1/conversations \
  src/app/api/sessions/list/route.ts scripts/run-tests.mjs
git commit -m "feat(client-v1): expose canonical chat reads"
```

### Task 6: Add persistent mutation idempotency

**Files:**
- Create: `src/lib/server/client-v1/idempotency-store.ts`
- Create: `src/lib/server/client-v1/idempotency-store.test.ts`
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Write claim/replay/conflict/restart tests**

```ts
const first = await claimOperation({ key, credentialId: "client-a", route: "conversations", requestHash: "aaa" });
assert.equal(first.kind, "claimed");
await completeOperation(key, { status: 201, body: { ok: true, id: "session-1" } });
assert.deepEqual((await claimOperation(sameInput)).kind, "replay");
assert.equal((await claimOperation({ ...sameInput, requestHash: "bbb" })).kind, "conflict");
```

Recreate the module/store from disk in the test to prove completed responses
survive restart. Pending claims older than ten minutes become retryable;
completed entries expire after 24 hours.

- [ ] **Step 2: Run and verify failure**

Run: `node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types --import ./scripts/test-alias-register.mjs --test src/lib/server/client-v1/idempotency-store.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement the atomic ledger**

Persist `{ version: 1, operations: ClientOperation[] }` under
`caveHome()/client-v1-operations.json`, store no prompt or attachment content,
serialize writers through a module-local promise queue, and hash the normalized
request body before claim.

- [ ] **Step 4: Run the focused test**

Run: `node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types --import ./scripts/test-alias-register.mjs --test src/lib/server/client-v1/idempotency-store.test.ts && pnpm check:tests-wired`

Expected: PASS.

- [ ] **Step 5: Commit the idempotency checkpoint**

```bash
git add src/lib/server/client-v1/idempotency-store* scripts/run-tests.mjs
git commit -m "feat(client-v1): persist mutation idempotency"
```

### Task 7: Expose create and conversation mutations

**Files:**
- Create: `src/lib/server/client-v1/chat-service.ts`
- Create: `src/lib/server/client-v1/chat-service.test.ts`
- Modify: `src/app/api/client/v1/conversations/route.ts`
- Modify: `src/app/api/client/v1/conversations/[id]/route.ts`
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Write authorization and idempotency tests**

Cover familiar-not-found, project-grant denial, successful empty conversation,
rename, pin, archive/unarchive, delete, replay of identical mutation, and 409 for
the same key with a different body.

- [ ] **Step 2: Run and verify failure**

Run: `node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types --import ./scripts/test-alias-register.mjs --test src/lib/server/client-v1/chat-service.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement domain delegation**

Create accepts:

```ts
type CreateConversationInput = {
  familiarId: string;
  projectRoot: string | null;
};
```

Use the same `authorizeChatProjectLaunch` and `createVoiceChatSession` dependency
shape as `src/app/api/chat/conversation/route.ts`.

Patch accepts only:

```ts
type PatchConversationInput = {
  title?: string;
  pinned?: boolean;
  archived?: boolean;
};
```

Load and mutate through `withConversationLock`/`saveConversation`; use existing
title ownership and session invalidation helpers from
`src/app/api/chat/conversation/[id]/route.ts`. Delete through
`deleteConversation` and the same daemon/session cleanup path as the internal
route. Do not copy metadata sanitizers into the facade.

- [ ] **Step 4: Run service and route tests**

Run: `node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types --import ./scripts/test-alias-register.mjs --test src/lib/server/client-v1/chat-service.test.ts src/app/api/client/v1/conversations/route.test.ts src/app/api/client/v1/conversations/[id]/route.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the conversation-mutation checkpoint**

```bash
git add src/lib/server/client-v1/chat-service* src/app/api/client/v1/conversations scripts/run-tests.mjs
git commit -m "feat(client-v1): add canonical conversation mutations"
```

### Task 8: Extract and wrap send, stop, retry, and resumable SSE

**Files:**
- Create: `src/lib/server/chat-send-service.ts`
- Create: `src/lib/server/chat-send-service.test.ts`
- Modify: `src/app/api/chat/send/route.ts`
- Create: `src/lib/server/client-v1/sse.ts`
- Create: `src/lib/server/client-v1/sse.test.ts`
- Create: `src/app/api/client/v1/messages/send/route.ts`
- Create: `src/app/api/client/v1/runs/[id]/stream/route.ts`
- Create: `src/app/api/client/v1/runs/[id]/stop/route.ts`
- Create: `src/app/api/client/v1/runs/[id]/retry/route.ts`
- Create: colocated route tests
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Add characterization tests before moving the send pipeline**

Import the current route `POST`, send a representative Codex-direct request with
mocked dependencies, and lock response headers plus emitted start/progress/text/
done event ordering. Keep all existing `chat/send` tests green.

- [ ] **Step 2: Extract without changing behavior**

Move the existing `POST` body to:

```ts
export async function executeChatSend(req: Request): Promise<Response> {
  // Existing send route implementation, unchanged.
}
```

Then leave:

```ts
export async function POST(req: Request): Promise<Response> {
  return executeChatSend(req);
}
```

Run: `node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types --import ./scripts/test-alias-register.mjs --test src/lib/server/chat-send-service.test.ts src/app/api/chat/send/route-body-validation.test.ts`

Expected: PASS with no changed snapshots or event order.

- [ ] **Step 3: Write failing v1 send/resume/retry tests**

Assert that:

- `operationId` is used as the canonical `runId`
- the operation is claimed before execution
- duplicate sends replay run metadata rather than launch twice
- both the initial POST stream and resumed GET stream use the same v1 event
  translation
- stream `id` values are strictly increasing
- duplicate cursors replay only events with `seq > cursor`
- an evicted cursor emits typed `reconcile_required`
- stop delegates to `requestChatStop`
- retry is allowed only for a persisted failed/aborted assistant turn
- retry creates a new operation/run and includes `retryOfTurnId`; it does not
  edit or delete the failed turn

- [ ] **Step 4: Implement v1 mapping and SSE wrapper**

Map:

```ts
type ClientSendInput = {
  operationId: string;
  conversationId: string;
  familiarId: string;
  prompt: string;
  attachmentIds: string[];
  projectRoot: string | null;
  model?: string;
  harness?: string;
  retryOfTurnId?: string;
};
```

to the existing send body, then call `executeChatSend`. The v1 SSE wrapper uses
`translateStreamEvent` for both the initial `executeChatSend` response and
events read through `subscribeRunStream`. It emits:

```ts
type ClientStreamEvent =
  | { type: "run.started"; runId: string; conversationId: string }
  | { type: "message.delta"; text: string }
  | { type: "progress"; id: string; label: string; detail?: string; status: string }
  | { type: "tool"; payload: Record<string, unknown> }
  | { type: "reconcile_required"; conversationId: string }
  | { type: "run.completed"; conversationId: string }
  | { type: "run.failed"; code: string; message: string };
```

Do not create a second stream buffer.
When an identical completed/in-flight idempotency claim is replayed, return
`409 operation_already_started` with `{ runId, conversationId, resumePath }`;
the client treats that specific conflict as attach-only and never launches a
second run.

- [ ] **Step 5: Run all send and stream tests**

Run:

```bash
node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types --import ./scripts/test-alias-register.mjs --test \
  src/lib/server/chat-send-service.test.ts \
  src/lib/server/client-v1/sse.test.ts \
  src/app/api/client/v1/messages/send/route.test.ts \
  src/app/api/client/v1/runs/[id]/stream/route.test.ts \
  src/app/api/client/v1/runs/[id]/stop/route.test.ts \
  src/app/api/client/v1/runs/[id]/retry/route.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the execution checkpoint**

```bash
git add src/lib/server/chat-send-service* src/app/api/chat/send/route.ts \
  src/lib/server/client-v1/sse* src/app/api/client/v1/messages \
  src/app/api/client/v1/runs scripts/run-tests.mjs
git commit -m "feat(client-v1): expose resumable chat execution"
```

### Task 9: Add validated attachment upload and download

**Files:**
- Create: `src/lib/server/client-v1/attachment-service.ts`
- Create: `src/lib/server/client-v1/attachment-service.test.ts`
- Create: `src/app/api/client/v1/attachments/route.ts`
- Create: `src/app/api/client/v1/attachments/[id]/route.ts`
- Create: colocated route tests
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Write MIME, count, size, and ownership tests**

Accept PNG, JPEG, WebP, GIF, PDF, plain text, MP3, WAV, and M4A. Reject more than
four files, any file above 10 MiB, a request above 25 MiB, extension/MIME
mismatch, executable signatures, path-like names, and attachment reads by a
different credential before the attachment is bound to a conversation.

- [ ] **Step 2: Run and verify failure**

Run: `node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types --import ./scripts/test-alias-register.mjs --test src/lib/server/client-v1/attachment-service.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement multipart upload over the canonical store**

Use `Request.formData()`, content signatures, `sharp` metadata for images, and
the existing `saveChatImageAttachment`/`saveChatMediaAttachment` functions.
Persist a small ownership index `{ attachmentId, credentialId, createdAt,
conversationId: null }`. The send service atomically binds accepted attachment
IDs to the canonical conversation before launch.

- [ ] **Step 4: Run upload/download tests**

Run: `node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types --import ./scripts/test-alias-register.mjs --test src/lib/server/client-v1/attachment-service.test.ts src/app/api/client/v1/attachments/route.test.ts src/app/api/client/v1/attachments/[id]/route.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the attachment checkpoint**

```bash
git add src/lib/server/client-v1/attachment-service* src/app/api/client/v1/attachments scripts/run-tests.mjs
git commit -m "feat(client-v1): add bounded chat attachments"
```

### Task 10: Add attention, task, and GitHub action delegation

**Files:**
- Create: `src/lib/server/client-v1/action-service.ts`
- Create: `src/lib/server/client-v1/action-service.test.ts`
- Create: `src/app/api/client/v1/attention/[id]/respond/route.ts`
- Create: `src/app/api/client/v1/tasks/handoff/route.ts`
- Create: `src/app/api/client/v1/github/actions/route.ts`
- Create: colocated route tests
- Create: `src/app/api/github/comment/route.test.ts`
- Modify: GitHub route modules only as needed to export existing service functions
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Write discriminated-union and scope tests**

Use:

```ts
type GitHubActionInput =
  | { kind: "comment"; repo: string; number: number; body: string }
  | { kind: "review"; repo: string; number: number; event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"; body?: string }
  | { kind: "merge"; repo: string; number: number; method: "squash" | "merge" | "rebase" }
  | { kind: "rerun"; repo: string; runId: string }
  | { kind: "dispatch"; repo: string; workflow: string; ref: string };
```

Test malformed repositories, unsupported kinds, absent user-confirmation flag,
missing scopes, duplicate idempotency keys, and that no action runs on
validation failure.

- [ ] **Step 2: Run and verify failure**

Run: `node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types --import ./scripts/test-alias-register.mjs --test src/lib/server/client-v1/action-service.test.ts`

Expected: FAIL.

- [ ] **Step 3: Extract reusable action functions and delegate**

Move network mutation bodies from the existing narrow GitHub route files into
exported server functions; keep the old routes calling them and add the missing
comment-route characterization test before extraction. Require
`confirmed: true` from Chat, but still perform all Cave-side authorization,
token resolution, and validation.

Attention response loads the canonical conversation, verifies the current
`attentionEvidence.requestId` matches `[id]`, and delegates the user's response
through the same `executeClientChatSend` path with a fresh operation ID. It does
not mutate attention projection directly. Task handoff calls
`createTaskFromChat` from `src/lib/chat-task-handoff.ts` and never writes files
or launches a harness directly.

- [ ] **Step 4: Run new and existing action tests**

Run: `node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types --import ./scripts/test-alias-register.mjs --test src/lib/server/client-v1/action-service.test.ts src/app/api/client/v1/github/actions/route.test.ts src/app/api/github/comment/route.test.ts src/app/api/github/review/route.test.ts src/app/api/github/merge/route.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit the rich-action checkpoint**

```bash
git add src/lib/server/client-v1/action-service* src/app/api/client/v1/attention \
  src/app/api/client/v1/tasks src/app/api/client/v1/github \
  src/app/api/github scripts/run-tests.mjs
git commit -m "feat(client-v1): delegate authorized rich actions"
```

### Task 11: Lock route contracts and run the Cave release gates

**Files:**
- Modify: `src/app/api/api-contracts.test.ts`
- Modify: `scripts/run-tests.mjs`
- Create: `src/app/api/client/v1/client-v1-contract.snapshot.test.ts`
- Create: `tests/client-v1-pairing.spec.ts`

- [ ] **Step 1: Register every route and test**

Add each route in the public contract table to `api-contracts.test.ts` with the
correct methods, JSON/stream kind, JSON-body behavior, and path guards. Add
every new test to `SUITES.api` or `SUITES.app`.

- [ ] **Step 2: Add a contract snapshot**

The snapshot test imports representative handlers with fixed dependencies and
asserts exact health, error, credential-list, familiar, project, summary,
conversation, and stream-event shapes. It must ignore additive fields only
where the v1 contract explicitly permits them.

- [ ] **Step 3: Add the browser approval flow**

Playwright opens Cave settings, submits a pairing request through the API,
approves it in Client Access, exchanges the token, verifies a scoped read,
revokes the credential, and verifies the same token receives 401.

- [ ] **Step 4: Run targeted and full gates**

Run:

```bash
pnpm check:tests-wired
pnpm typecheck
pnpm lint
pnpm test:api
pnpm test:app
pnpm test:e2e -- tests/client-v1-pairing.spec.ts
pnpm build
```

Expected: all commands PASS.

- [ ] **Step 5: Commit the completed Cave client API**

```bash
git add src/app/api/client/v1 src/lib/server/client-v1 src/lib/server/chat-send-service.ts \
  src/components/settings-client-access.tsx src/styles/settings-client-access.css \
  src/app/api/api-contracts.test.ts scripts/run-tests.mjs tests/client-v1-pairing.spec.ts
git commit -m "feat: ship Cave client v1 API"
```

## Handoff to the Chat plans

Before starting the client, publish the generated contract fixture from the
passing snapshot test into the Chat worktree as
`src/lib/cave-api/contract-fixture.json`. Do not create a shared runtime package
in v1; the HTTP contract is the boundary and the Chat parser must reject
incompatible shapes independently.
