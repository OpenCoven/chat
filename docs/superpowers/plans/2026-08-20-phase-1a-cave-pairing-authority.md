# Cave Pairing Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Cave as the Phase 1 pairing authority with hashed pairing/credential storage, authenticated public `/api/client/v1` routes, validated discovery publication, and approval management in Settings.

**Architecture:** Build the new authority surface on top of the existing `src/lib/server/client-v1` contract/exporter instead of inventing a parallel protocol. Keep all secret-bearing logic server-side: the public surface gets health, pairing, and later client operations; approval and revocation stay behind the authenticated Settings/admin boundary.

**Tech Stack:** Next.js 16.2.12, React 19.2.8, TypeScript 6.0.3, Node 24.18.x, pnpm 10.34.0, existing Cave `node:test`/Vitest split, existing client-v1 exporter and CI path classifier.

---

## File Map

**Repository root:** `/Users/buns/Documents/GitHub/OpenCoven/coven-cave`
**Implementation worktree:** `/Users/buns/Documents/GitHub/OpenCoven/coven-cave/.worktrees/phase1a-cave-pairing-authority`
**Branch:** `phase1a/cave-pairing-authority`
**Primary bead:** `cave-9pifu`
**Do not carry forward from the dirty main worktree:** `.beads/interactions.jsonl`, `src/lib/surface-warm-cache.test.ts`

### Create
- `src/lib/server/client-v1/pairing-store.ts` — five-minute, single-use pairing authority with hash-only secret storage.
- `src/lib/server/client-v1/pairing-store.test.ts` — lifecycle, expiry, replay, pruning, and single-use coverage.
- `src/lib/server/client-v1/credential-store.ts` — atomic owner-only persisted credential metadata and bearer-hash verification.
- `src/lib/server/client-v1/credential-store.test.ts` — persistence, restart, revocation, and constant-time verification coverage.
- `src/lib/server/client-v1/auth.ts` — bearer verification, scope checks, revocation handling, and loopback trust helpers.
- `src/lib/server/client-v1/auth.test.ts` — missing/invalid/revoked scope coverage.
- `src/lib/server/client-v1/rate-limit.ts` — separate pairing and authenticated request buckets.
- `src/lib/server/client-v1/rate-limit.test.ts` — bucket isolation, pruning, and invalid-token behavior.
- `src/lib/server/client-v1/discovery.ts` — owner-local discovery publisher/remover with nonce protection.
- `src/lib/server/client-v1/discovery.test.ts` — readiness, mode, nonce, and stale-pid coverage.
- `src/app/api/client/v1/health/route.ts` and `route.test.ts` — public health, version, and capability response.
- `src/app/api/client/v1/pairing/requests/route.ts` and `route.test.ts` — create pairing requests.
- `src/app/api/client/v1/pairing/requests/[id]/route.ts` and `route.test.ts` — poll pairing status.
- `src/app/api/client/v1/pairing/requests/[id]/exchange/route.ts` and `route.test.ts` — single-use approval exchange.
- `src/app/api/client/v1/admin/pairing-requests/route.ts` and `route.test.ts` — authenticated admin list surface.
- `src/app/api/client/v1/admin/pairing-requests/[id]/decision/route.ts` and `route.test.ts` — authenticated approval/denial action.
- `src/app/api/client/v1/admin/credentials/route.ts` and `route.test.ts` — authenticated credential list/revocation surface.
- `src/components/settings-client-access.tsx` — Settings section for pending approvals and issued credentials.
- `src/components/settings-client-access.test.tsx` — UI state, approval, denial, revoke, and copy coverage.
- `src/styles/settings-client-access.css` — scoped styling for the new Settings section.
- `docs/api/client-v1.md` — authoritative public route and envelope documentation.
- `docs/client-v1-settings.md` — approval, scopes, revocation, and operational notes for the Cave UI.

### Modify
- `server.ts` — stamp trusted loopback ingress, publish discovery only after readiness, and remove it only when the nonce still matches.
- `src/proxy.ts` and `src/proxy-helpers.ts` — extend the reviewed local-ingress/auth boundary for `/api/client/v1` without weakening `/api/chat/*`.
- `src/lib/server/client-v1/contract.ts`, `contract-fixture.json`, `contract-fixture.sha256`, and `responses.ts` — add the approved Phase 1 pairing/credential/discovery shapes.
- `src/app/api/api-contracts.test.ts` — intentionally flip the current Phase 0 ratchet that forbids `/api/client/v1`.
- `scripts/export-client-v1-contract.mjs` and `scripts/export-client-v1-contract.test.mjs` — keep deterministic fixture export current.
- `scripts/ci-paths.mjs` and `scripts/ci-paths.test.mjs` — keep client-v1 changes path-classified for CI.
- `scripts/run-tests.mjs` — register new test files in the right suites.
- `src/components/settings-shell.tsx`, `src/components/settings-sections.ts`, and `src/components/settings-shell-polish.test.ts` — mount the new section without regressing shell polish.
- `README.md` — add the public client-v1 and approval-management entrypoints.

### Task 1: Create the clean Cave worktree and authority stores

**Files:**
- Create: `src/lib/server/client-v1/pairing-store.ts`
- Create: `src/lib/server/client-v1/pairing-store.test.ts`
- Create: `src/lib/server/client-v1/credential-store.ts`
- Create: `src/lib/server/client-v1/credential-store.test.ts`
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Create a clean implementation worktree instead of using dirty main**

Run:

```bash
git -C /Users/buns/Documents/GitHub/OpenCoven/coven-cave fetch origin main
git -C /Users/buns/Documents/GitHub/OpenCoven/coven-cave worktree add /Users/buns/Documents/GitHub/OpenCoven/coven-cave/.worktrees/phase1a-cave-pairing-authority -b phase1a/cave-pairing-authority origin/main
git -C /Users/buns/Documents/GitHub/OpenCoven/coven-cave/.worktrees/phase1a-cave-pairing-authority status --short --branch
```

Expected: the new worktree is clean, and it does not include the unrelated dirty files from the main checkout.

- [ ] **Step 2: Write the failing store tests**

```ts
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createPairingStore } from './pairing-store.ts';
import { createCredentialStore } from './credential-store.ts';

test('approved pairings are secret-hash only, five-minute, and single-use', () => {
  const store = createPairingStore({ ttlMs: 300_000, maxEntries: 128, now: () => 1_000 });
  const created = store.create({ appName: 'OpenCoven Chat', installationId: 'chat-install-1', scopes: ['chat:read'] });

  assert.equal(store.inspect(created.id)?.secretHash === created.secret, false);
  assert.equal(store.poll(created.id, created.secret)?.status, 'pending');
  store.decide(created.id, 'approved', 1_100);
  assert.equal(store.consume(created.id, created.secret)?.status, 'approved');
  assert.equal(store.consume(created.id, created.secret), null);
});

test('credential persistence stores only bearer hashes and keeps revocation across reloads', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cave-client-v1-credentials-'));
  try {
    const store = await createCredentialStore({ root });
    const issued = await store.issue({ appName: 'OpenCoven Chat', installationId: 'chat-install-1', scopes: ['chat:read', 'chat:write'] });

    assert.match(issued.bearer, /^[A-Za-z0-9_-]{32,}$/);
    assert.equal((await store.readPersistedFile()).includes(issued.bearer), false);
    assert.equal(await store.verify(issued.id, issued.bearer), true);
    await store.revoke(issued.id, 'operator revoked credential');
    assert.equal((await store.reload()).get(issued.id)?.revokedAt !== undefined, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run the focused tests and confirm failure**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave/.worktrees/phase1a-cave-pairing-authority
node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types src/lib/server/client-v1/pairing-store.test.ts
node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types src/lib/server/client-v1/credential-store.test.ts
```

Expected: both commands fail because the new store modules do not exist yet.

- [ ] **Step 4: Implement the minimal authority stores and wire the tests**

```ts
export interface PairingStore {
  create(input: ClientV1PairingCreateInput): ClientV1PairingIssued;
  poll(id: string, secret: string): ClientV1PairingStatus | null;
  decide(id: string, decision: 'approved' | 'denied', now: number): boolean;
  consume(id: string, secret: string): ClientV1PairingApproved | null;
  inspect(id: string): { secretHash: string } | null;
}

export interface CredentialStore {
  issue(input: ClientV1CredentialIssueInput): Promise<ClientV1IssuedCredential>;
  verify(id: string, bearer: string): Promise<boolean>;
  findByBearer(bearer: string): Promise<ClientV1CredentialRecord | null>;
  revoke(id: string, reason: string): Promise<void>;
  reload(): Promise<Map<string, ClientV1CredentialRecord>>;
  readPersistedFile(): Promise<string>;
}
```

Implementation requirements:
- pairing records stay process-local, prune to `maxEntries`, expire after five minutes, and store SHA-256 hashes only;
- credentials persist atomically under the Cave home with mode `0600` semantics and never write raw bearers;
- bearer verification and bearer-only lookup use the existing constant-time string comparison helper pattern; `findByBearer` returns at most one active record and does not leak hash-prefix timing;
- `lastUsedAt` updates are persisted, but writes are coalesced to at most once per minute per credential;
- `scripts/run-tests.mjs` registers the four new files in the `api` suite.

- [ ] **Step 5: Run the focused tests again and confirm they pass**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave/.worktrees/phase1a-cave-pairing-authority
node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types src/lib/server/client-v1/pairing-store.test.ts
node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types src/lib/server/client-v1/credential-store.test.ts
pnpm check:tests-wired
```

Expected: all three commands pass.

- [ ] **Step 6: Commit the store foundation**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave/.worktrees/phase1a-cave-pairing-authority
git add src/lib/server/client-v1/pairing-store.* src/lib/server/client-v1/credential-store.* scripts/run-tests.mjs
git commit -m "feat: add Cave pairing authority stores" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Enforce client-v1 auth, loopback trust, and rate limits

**Files:**
- Create: `src/lib/server/client-v1/auth.ts`
- Create: `src/lib/server/client-v1/auth.test.ts`
- Create: `src/lib/server/client-v1/rate-limit.ts`
- Create: `src/lib/server/client-v1/rate-limit.test.ts`
- Modify: `src/proxy.ts`
- Modify: `src/proxy-helpers.ts`
- Modify: `server.ts`

- [ ] **Step 1: Write the failing auth and rate-limit tests**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { createClientV1Authenticator } from './auth.ts';
import { createClientV1RateLimiter } from './rate-limit.ts';

test('client-v1 auth rejects missing, revoked, and under-scoped bearers', async () => {
  const auth = createClientV1Authenticator({ credentialStore, loopbackSecret: 'loopback-secret' });

  await assert.rejects(() => auth.requireScope({ bearer: null, scope: 'chat:read' }), /unauthorized/);
  await assert.rejects(() => auth.requireScope({ bearer: 'revoked', scope: 'chat:read' }), /revoked/);
  await assert.rejects(() => auth.requireScope({ bearer: 'read-only', scope: 'github:write' }), /scope_denied/);
});

test('invalid tokens do not spend a valid credential bucket', () => {
  const limiter = createClientV1RateLimiter({ now: () => 1_000 });

  assert.equal(limiter.consumePairing('127.0.0.1').ok, true);
  assert.equal(limiter.consumeAuthenticated('credential-1', 'invalid').bucketKey, 'invalid');
  assert.equal(limiter.consumeAuthenticated('credential-1', 'valid').bucketKey, 'credential-1');
});
```

- [ ] **Step 2: Run the focused auth tests and confirm failure**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave/.worktrees/phase1a-cave-pairing-authority
node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types src/lib/server/client-v1/auth.test.ts
node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types src/lib/server/client-v1/rate-limit.test.ts
```

Expected: both commands fail because the new auth and limiter modules are missing.

- [ ] **Step 3: Implement the minimal auth boundary in the reviewed Cave ingress path**

```ts
export function createClientV1Authenticator(options: {
  credentialStore: CredentialStore;
  loopbackSecret: string;
}) {
  return {
    isTrustedLoopback(headerValue: string | null) {
      return headerValue !== null && timingSafeEqualString(headerValue, options.loopbackSecret);
    },
    async requireScope(input: { bearer: string | null; scope: ClientV1Scope }) {
      const credential = await options.credentialStore.findByBearer(input.bearer);
      if (!credential) throw clientV1Error('unauthorized');
      if (credential.revokedAt) throw clientV1Error('unauthorized', 'revoked credential');
      if (!credential.scopes.includes(input.scope)) throw clientV1Error('scope_denied');
      return credential;
    },
  };
}
```

Implementation requirements:
- `server.ts` removes any caller-supplied loopback marker before stamping its own;
- `src/proxy.ts` allows the reviewed `/api/client/v1` routes, but still never makes `/api/chat/*` public;
- pairing creation is limited to 10 requests/minute and authenticated client-v1 requests to 120/minute with bounded pruning;
- redirects stay disabled and safe content-type checks remain intact.

- [ ] **Step 4: Run the focused auth tests again and confirm they pass**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave/.worktrees/phase1a-cave-pairing-authority
node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types src/lib/server/client-v1/auth.test.ts
node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types src/lib/server/client-v1/rate-limit.test.ts
node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types src/middleware.test.ts
```

Expected: all three commands pass.

- [ ] **Step 5: Commit the auth boundary**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave/.worktrees/phase1a-cave-pairing-authority
git add src/lib/server/client-v1/auth.* src/lib/server/client-v1/rate-limit.* src/proxy.ts src/proxy-helpers.ts server.ts
git commit -m "feat: secure Cave client-v1 auth boundary" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 3: Expose the public client-v1 routes, discovery record, and contract ratchets

**Files:**
- Create: `src/lib/server/client-v1/discovery.ts`
- Create: `src/lib/server/client-v1/discovery.test.ts`
- Create: `src/app/api/client/v1/health/route.ts`
- Create: `src/app/api/client/v1/health/route.test.ts`
- Create: `src/app/api/client/v1/pairing/requests/route.ts`
- Create: `src/app/api/client/v1/pairing/requests/route.test.ts`
- Create: `src/app/api/client/v1/pairing/requests/[id]/route.ts`
- Create: `src/app/api/client/v1/pairing/requests/[id]/route.test.ts`
- Create: `src/app/api/client/v1/pairing/requests/[id]/exchange/route.ts`
- Create: `src/app/api/client/v1/pairing/requests/[id]/exchange/route.test.ts`
- Create: `src/app/api/client/v1/admin/pairing-requests/route.ts`
- Create: `src/app/api/client/v1/admin/pairing-requests/route.test.ts`
- Create: `src/app/api/client/v1/admin/pairing-requests/[id]/decision/route.ts`
- Create: `src/app/api/client/v1/admin/pairing-requests/[id]/decision/route.test.ts`
- Create: `src/app/api/client/v1/admin/credentials/route.ts`
- Create: `src/app/api/client/v1/admin/credentials/route.test.ts`
- Create: `src/app/api/client/v1/admin/credentials/[id]/route.ts`
- Create: `src/app/api/client/v1/admin/credentials/[id]/route.test.ts`
- Modify: `src/lib/server/client-v1/contract.ts`
- Modify: `src/lib/server/client-v1/responses.ts`
- Modify: `src/lib/server/client-v1/contract-fixture.json`
- Modify: `src/lib/server/client-v1/contract-fixture.sha256`
- Modify: `src/app/api/api-contracts.test.ts`
- Modify: `scripts/export-client-v1-contract.mjs`
- Modify: `scripts/export-client-v1-contract.test.mjs`
- Modify: `scripts/ci-paths.mjs`
- Modify: `scripts/ci-paths.test.mjs`

- [ ] **Step 1: Write the failing route, discovery, and ratchet tests**

```ts
test('health exposes version, minimum client version, capabilities, and discovery freshness', async () => {
  const response = await GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    apiVersion: '1.0',
    minimumClientVersion: '0.1.0',
    capabilities: ['pairing', 'credentials'],
    data: { status: 'ok' },
  });
});

test('Phase 1 flips the route ratchet intentionally', () => {
  assert.equal(actualRoutes.some((route) => route.startsWith('/client/v1')), true);
});

test('discovery publish writes owner-local mode-0600 content and removes only a matching nonce', async () => {
  const published = await publishClientV1DiscoveryRecord({ endpoint: 'http://127.0.0.1:3020', pid: 4321, nonce: 'nonce-1' });
  assert.equal(published.mode, 0o600);
  assert.equal(await removeClientV1DiscoveryRecord({ nonce: 'nonce-2' }), false);
  assert.equal(await removeClientV1DiscoveryRecord({ nonce: 'nonce-1' }), true);
});
```

- [ ] **Step 2: Run the focused route/discovery checks and confirm failure**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave/.worktrees/phase1a-cave-pairing-authority
node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types src/lib/server/client-v1/discovery.test.ts
node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types src/app/api/client/v1/health/route.test.ts
node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types src/app/api/client/v1/pairing/requests/route.test.ts
node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types src/app/api/client/v1/admin/credentials/[id]/route.test.ts
node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types src/app/api/api-contracts.test.ts
```

Expected: the new files are missing and the existing API contract test still rejects `/api/client/v1`.

- [ ] **Step 3: Implement the minimal public surface, discovery publisher, and contract updates**

```ts
export async function GET() {
  return clientV1SuccessResponse({
    apiVersion: CLIENT_V1_API_VERSION,
    minimumClientVersion: CLIENT_V1_MIN_CLIENT_VERSION,
    capabilities: ['pairing', 'credentials'],
    data: { status: 'ok' },
  });
}

export async function POST(request: NextRequest) {
  const body = await request.json();
  const created = pairingStore.create(parseClientV1PairingCreateRequest(body));
  return clientV1SuccessResponse({ data: { requestId: created.id, secret: created.secret, expiresAt: created.expiresAt } }, { status: 201 });
}
```

Implementation requirements:
- public routes are exactly `/api/client/v1/health`, `/api/client/v1/pairing/requests`, `/api/client/v1/pairing/requests/[id]`, and `/api/client/v1/pairing/requests/[id]/exchange`;
- authenticated admin routes cover pending pairing review plus credential revocation at `/api/client/v1/admin/pairing-requests/*` and `/api/client/v1/admin/credentials/*`;
- `scripts/export-client-v1-contract.mjs` and fixture files stay deterministic and additive;
- `scripts/ci-paths.mjs` continues to treat client-v1 and docs changes as CI-significant.

- [ ] **Step 4: Run the focused route/discovery checks again and confirm they pass**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave/.worktrees/phase1a-cave-pairing-authority
node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types src/lib/server/client-v1/discovery.test.ts
node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types src/app/api/client/v1/health/route.test.ts
node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types src/app/api/client/v1/pairing/requests/route.test.ts
node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types src/app/api/client/v1/admin/credentials/[id]/route.test.ts
node scripts/export-client-v1-contract.mjs --check
node --test scripts/export-client-v1-contract.test.mjs
node --test scripts/ci-paths.test.mjs
```

Expected: all commands pass.

- [ ] **Step 5: Commit the public route wave**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave/.worktrees/phase1a-cave-pairing-authority
git add src/lib/server/client-v1/discovery.* src/app/api/client/v1 src/lib/server/client-v1/contract.* src/lib/server/client-v1/responses.ts src/app/api/api-contracts.test.ts scripts/export-client-v1-contract.mjs scripts/export-client-v1-contract.test.mjs scripts/ci-paths.mjs scripts/ci-paths.test.mjs
git commit -m "feat: expose Cave client-v1 pairing routes" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Add approval management to Settings without regressing shell polish

**Files:**
- Create: `src/components/settings-client-access.tsx`
- Create: `src/components/settings-client-access.test.tsx`
- Create: `src/styles/settings-client-access.css`
- Modify: `src/components/settings-shell.tsx`
- Modify: `src/components/settings-sections.ts`
- Modify: `src/components/settings-shell-polish.test.ts`

- [ ] **Step 1: Write the failing Settings tests**

```ts
it('renders pending approvals with exact app identity, scopes, created time, and expiry', async () => {
  render(
    <SettingsClientAccess
      pendingRequests={[samplePending]}
      credentials={[]}
      onApprove={async () => {}}
      onDeny={async () => {}}
      onRevoke={async () => {}}
    />,
  );

  expect(screen.getByText('OpenCoven Chat')).toBeVisible();
  expect(screen.getByText('chat-install-1')).toBeVisible();
  expect(screen.getByText('chat:read')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Approve OpenCoven Chat request' })).toBeVisible();
});

it('keeps Settings shell polish intact when Client access is present', () => {
  expect(source).toMatch(/Client access/);
  expect(source).toMatch(/Esc back · ↑↓ navigate sections/);
});
```

- [ ] **Step 2: Run the focused Settings tests and confirm failure**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave/.worktrees/phase1a-cave-pairing-authority
pnpm exec vitest run src/components/settings-client-access.test.tsx
node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types src/components/settings-shell-polish.test.ts
```

Expected: the new component test fails because the file does not exist, and the shell polish test fails until the new section is wired correctly.

- [ ] **Step 3: Implement the minimal Settings approval surface**

```tsx
export function SettingsClientAccess(props: {
  pendingRequests: ClientV1PendingPairingRequest[];
  credentials: ClientV1CredentialSummary[];
  onApprove(id: string): Promise<void>;
  onDeny(id: string): Promise<void>;
  onRevoke(id: string): Promise<void>;
}) {
  return (
    <SettingsGroup label="Client access" variant="ruled" panel meta={`${props.pendingRequests.length} pending`}>
      <ul className="settings-client-access__requests">
        {props.pendingRequests.map((request) => (
          <li key={request.id}>{request.appName} · {request.installationId} · {request.scopes.join(', ')}</li>
        ))}
      </ul>
    </SettingsGroup>
  );
}
```

Implementation requirements:
- show app identity, installation identity, scopes, creation time, expiry, and revocation state;
- keep approval/denial/revocation as authenticated Cave admin actions;
- add the section through `src/components/settings-shell.tsx` and `src/components/settings-sections.ts` instead of creating a second settings shell;
- keep `src/components/settings-shell-polish.test.ts` green.

- [ ] **Step 4: Run the focused Settings tests again and confirm they pass**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave/.worktrees/phase1a-cave-pairing-authority
pnpm exec vitest run src/components/settings-client-access.test.tsx
node --require ./scripts/css-source-contract-hook.cjs --experimental-strip-types src/components/settings-shell-polish.test.ts
pnpm test:app
```

Expected: all three commands pass.

- [ ] **Step 5: Commit the Settings UI**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave/.worktrees/phase1a-cave-pairing-authority
git add src/components/settings-client-access.* src/styles/settings-client-access.css src/components/settings-shell.tsx src/components/settings-sections.ts src/components/settings-shell-polish.test.ts
git commit -m "feat: manage client approvals in Cave settings" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 5: Finish docs, validation, PR, merge, and bead evidence

**Files:**
- Create: `docs/api/client-v1.md`
- Create: `docs/client-v1-settings.md`
- Modify: `README.md`

- [ ] **Step 1: Write the operator and API documentation**

```md
# Client v1 API

- Public routes: `/api/client/v1/health`, `/api/client/v1/pairing/requests`, `/api/client/v1/pairing/requests/{id}`, `/api/client/v1/pairing/requests/{id}/exchange`
- Pairing scopes: `chat:read`, `chat:write`, `conversations:write`, `attachments:write`, `tasks:write`, `github:write`
- Cave persists only bearer hashes; Chat stores the bearer only in native secure storage.
```

- [ ] **Step 2: Run the full Cave validation matrix**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave/.worktrees/phase1a-cave-pairing-authority
pnpm lint
pnpm typecheck
pnpm check:tests-wired
node scripts/export-client-v1-contract.mjs --check
pnpm test:api
pnpm test:app
pnpm test:mobile
pnpm test:conformance
```

Expected: every command passes. Do not run release or publish scripts.

- [ ] **Step 3: Commit the documentation and validation sweep**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave/.worktrees/phase1a-cave-pairing-authority
git add docs/api/client-v1.md docs/client-v1-settings.md README.md
git commit -m "docs: describe Cave client pairing authority" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

- [ ] **Step 4: Push the branch and open the pull request**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave/.worktrees/phase1a-cave-pairing-authority
git push -u origin phase1a/cave-pairing-authority
gh -R OpenCoven/coven-cave pr create --base main --head phase1a/cave-pairing-authority --title "feat: add Cave client pairing authority" --body "## Summary
- add hashed pairing and credential authority stores
- expose approved public client-v1 routes and discovery
- add Settings approval and revocation management

## Testing
- pnpm lint
- pnpm typecheck
- pnpm check:tests-wired
- node scripts/export-client-v1-contract.mjs --check
- pnpm test:api
- pnpm test:app
- pnpm test:mobile
- pnpm test:conformance"
```

- [ ] **Step 5: Wait for required checks, merge, and sync the worktree**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave/.worktrees/phase1a-cave-pairing-authority
gh -R OpenCoven/coven-cave pr checks --watch
gh -R OpenCoven/coven-cave pr merge --squash --delete-branch=false
git fetch origin main
git rebase origin/main
```

Expected: the PR merges only after the required checks are green.

- [ ] **Step 6: Record Beads closure evidence**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
bd ready --json --limit 0
bd show cave-9pifu
bd close cave-9pifu --reason "Merged phase1a/cave-pairing-authority after pnpm lint, pnpm typecheck, pnpm check:tests-wired, node scripts/export-client-v1-contract.mjs --check, pnpm test:api, pnpm test:app, pnpm test:mobile, and pnpm test:conformance."
```

Expected: the bead closure note captures the merged branch, validation, and no-release policy.
