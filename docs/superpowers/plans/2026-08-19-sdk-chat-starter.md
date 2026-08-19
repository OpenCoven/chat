# SDK Chat Starter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a packed-package-verified React starter and layered SDK documentation showing how to build a new Chat interface without copying OpenCoven Chat internals.

**Architecture:** The starter imports only public SDK package surfaces, keeps native discovery and credentials behind ports, and renders an example-local adapter contract copied from the checked Chat manifest. Released health APIs run for real; Phase 1–3 interaction states use deterministic preview data and are labeled as previews in code, UI, and documentation.

**Tech Stack:** TypeScript 6.0.3, React 19.2.8, Vite 8.2.1, Vitest 4.1.10, pnpm 10.34.0, packed npm tarballs.

---

## File Map

- Create `examples/chat-starter/package.json`: isolated starter package.
- Create `examples/chat-starter/tsconfig.json`: strict React build.
- Create `examples/chat-starter/vite.config.ts`: browser build.
- Create `examples/chat-starter/index.html`: Vite entry.
- Create `examples/chat-starter/src/reference-contract.ts`: checked Chat contract copy.
- Create `examples/chat-starter/src/ports.ts`: discovery, transport, and credential boundaries.
- Create `examples/chat-starter/src/open-coven-adapter.ts`: current SDK orchestration plus preview state.
- Create `examples/chat-starter/src/open-coven-adapter.test.ts`: current/preview/security tests.
- Create `examples/chat-starter/src/App.tsx`: replaceable React presentation.
- Create `examples/chat-starter/src/App.test.tsx`: UI contract tests.
- Create `examples/chat-starter/src/main.tsx`: browser entry.
- Create `examples/chat-starter/src/styles.css`: intentionally small starter styling.
- Create `examples/chat-starter/README.md`: five-minute quickstart.
- Create `docs/build-a-chat-interface.md`: layered integration reference.
- Modify `examples/README.md`: index the starter and capability status.
- Modify `README.md`: add the builder journey.
- Modify `pnpm-workspace.yaml`: include the starter.
- Modify `vitest.workspace.js`: include starter tests.
- Modify `scripts/verify-package.mjs`: prove the starter against packed tarballs.

## Task 1: Scaffold an Isolated, Strict Starter

**Files:**
- Create: `examples/chat-starter/package.json`
- Create: `examples/chat-starter/tsconfig.json`
- Create: `examples/chat-starter/vite.config.ts`
- Create: `examples/chat-starter/index.html`
- Modify: `pnpm-workspace.yaml`
- Modify: `vitest.workspace.js`

- [ ] **Step 1: Add a failing workspace assertion**

In the existing root workspace/config test, assert:

```ts
expect(workspacePackages).toContain('examples/chat-starter');
expect(vitestProjects).toContain('examples/chat-starter');
```

- [ ] **Step 2: Run the assertion and verify RED**

```bash
corepack pnpm@10.34.0 test -- tests/workspace.spec.ts
```

Expected: the starter is absent.

- [ ] **Step 3: Create the starter package**

```json
{
  "name": "@opencoven/example-chat-starter",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "dev": "vite",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@opencoven/sdk": "workspace:*",
    "@opencoven/sdk-core": "workspace:*",
    "react": "19.2.8",
    "react-dom": "19.2.8"
  },
  "devDependencies": {
    "@testing-library/react": "16.3.2",
    "@types/react": "19.2.14",
    "@types/react-dom": "19.2.3",
    "@vitejs/plugin-react": "6.0.1",
    "jsdom": "29.0.1",
    "typescript": "6.0.3",
    "vite": "8.2.1",
    "vitest": "4.1.10"
  }
}
```

- [ ] **Step 4: Add strict TypeScript and Vite configuration**

Extend `../../tsconfig.base.json`; set `jsx` to `react-jsx`, `lib` to
`["ES2024", "DOM", "DOM.Iterable"]`, and `types` to `["vitest/globals"]`.
Configure Vite with `react()` and Vitest with `environment: "jsdom"`.

- [ ] **Step 5: Install, verify, and commit**

```bash
corepack pnpm@10.34.0 install --frozen-lockfile=false
corepack pnpm@10.34.0 --filter @opencoven/example-chat-starter typecheck
git add examples/chat-starter pnpm-workspace.yaml vitest.workspace.js pnpm-lock.yaml
git commit -m "chore: scaffold the SDK Chat starter" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 2: Define Native Ports and the Example Adapter

**Files:**
- Create: `examples/chat-starter/src/reference-contract.ts`
- Create: `examples/chat-starter/src/ports.ts`
- Create: `examples/chat-starter/src/open-coven-adapter.ts`
- Test: `examples/chat-starter/src/open-coven-adapter.test.ts`

- [ ] **Step 1: Write failing security-boundary tests**

```ts
it('passes the bearer only to the caller-supplied transport', async () => {
  const transport = vi.fn().mockResolvedValue(healthyResponse);
  const adapter = createOpenCovenChatAdapter({
    ports: { authority, credentials, transport },
    preview,
  });

  await adapter.refreshHealth();

  expect(transport).toHaveBeenCalledOnce();
  expect(JSON.stringify(adapter.snapshot())).not.toContain('Bearer ');
});

it('rejects arbitrary presentation-supplied authorities', () => {
  expect(() => adapter.actions.setAuthority('https://attacker.invalid')).toThrow(
    'authority changes belong to the native port',
  );
});
```

Also assert that current health data comes from `OpenCovenSdk.healthReport()`,
while pairing, canonical reads, send, and streaming are explicitly represented
as preview states. Add table-driven cases for unavailable, pairing required,
incompatible, revoked, degraded reads, interrupted stream, reconciliation
required, ambiguous send completion, and unknown failure. Each expected
snapshot must contain a user-safe message and must not contain bearer values,
raw headers, unrestricted paths, or arbitrary environment values.

- [ ] **Step 2: Verify RED**

```bash
corepack pnpm@10.34.0 --filter @opencoven/example-chat-starter test -- \
  src/open-coven-adapter.test.ts
```

- [ ] **Step 3: Implement the native ports**

```ts
export type AuthorityPort = {
  current(): Promise<URL>;
};

export type CredentialPort = {
  readBearer(authority: URL): Promise<string | null>;
  replaceBearer(authority: URL, bearer: string): Promise<void>;
  clearBearer(authority: URL): Promise<void>;
};

export type NativePorts = {
  authority: AuthorityPort;
  credentials: CredentialPort;
  transport: CaveTransport;
};
```

Document in code that the browser UI receives neither the bearer nor authority
mutation methods.

- [ ] **Step 4: Implement the adapter**

The adapter exposes:

```ts
export type ChatStarterAdapter = {
  subscribe(listener: (viewModel: ChatViewModel) => void): () => void;
  snapshot(): ChatViewModel;
  refreshHealth(): Promise<void>;
  actions: ChatActions;
};
```

`refreshHealth()` obtains the authority and bearer through ports, constructs a
public `CaveClient` with `createCaveClient({ transport: ports.transport })`,
passes it to `OpenCovenSdk`, calls `healthReport()`, and maps errors to
`locating`, `pairing`, `incompatible`, or `unavailable`. Preview actions operate
only on deterministic local fixtures and include `source: "phase-preview"` in
their internal events.

- [ ] **Step 5: Run tests and commit**

```bash
corepack pnpm@10.34.0 --filter @opencoven/example-chat-starter test -- \
  src/open-coven-adapter.test.ts
corepack pnpm@10.34.0 --filter @opencoven/example-chat-starter typecheck
git add examples/chat-starter/src
git commit -m "feat: add the SDK Chat starter adapter" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 3: Build the Replaceable React Interface

**Files:**
- Create: `examples/chat-starter/src/App.tsx`
- Create: `examples/chat-starter/src/App.test.tsx`
- Create: `examples/chat-starter/src/main.tsx`
- Create: `examples/chat-starter/src/styles.css`

- [ ] **Step 1: Write failing UI boundary tests**

```tsx
it('renders only adapter view-model data', () => {
  render(<App adapter={fixtureAdapter} />);
  expect(screen.getByText('SDK starter')).toBeVisible();
  expect(screen.queryByText(/Bearer /)).not.toBeInTheDocument();
});

it('labels unreleased interaction paths as previews', () => {
  render(<App adapter={fixtureAdapter} />);
  expect(screen.getByText('Phase 1–3 preview data')).toBeVisible();
});

it('dispatches selection and send through adapter actions');
```

- [ ] **Step 2: Verify RED**

```bash
corepack pnpm@10.34.0 --filter @opencoven/example-chat-starter test -- src/App.test.tsx
```

- [ ] **Step 3: Implement the React shell**

Use:

```ts
useSyncExternalStore(
  (notify) => adapter.subscribe(() => notify()),
  adapter.snapshot,
  adapter.snapshot,
);
```

Render connection status, familiar list, conversation list, transcript,
composer modes, composer input, and send action. The UI may own only focus,
expanded/collapsed sections, and unsent local input. Put a visible but quiet
`Phase 1–3 preview data` badge beside the preview transcript.

- [ ] **Step 4: Add the runnable entry**

Construct deterministic in-memory native ports. The authority port returns a
local example URL; the credential port returns `null`; the transport returns a
valid deterministic health response. Do not contact the network by default.

- [ ] **Step 5: Verify and commit**

```bash
corepack pnpm@10.34.0 --filter @opencoven/example-chat-starter test
corepack pnpm@10.34.0 --filter @opencoven/example-chat-starter typecheck
corepack pnpm@10.34.0 --filter @opencoven/example-chat-starter build
git add examples/chat-starter/src examples/chat-starter/index.html
git commit -m "feat: add the replaceable Chat starter interface" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 4: Verify the Starter Against Packed Packages

**Files:**
- Modify: `scripts/verify-package.mjs`
- Modify: `tests/verify-package-script.spec.ts`

- [ ] **Step 1: Write failing verifier tests**

Assert the script:

```ts
expect(source).toContain('examples/chat-starter');
expect(source).toContain('pnpm install --offline');
expect(source).toContain('pnpm typecheck');
expect(source).toContain('pnpm test');
expect(source).toContain('pnpm build');
expect(source).toContain('file:');
```

Also assert it rejects any packed starter manifest containing `workspace:*`.

- [ ] **Step 2: Verify RED**

```bash
corepack pnpm@10.34.0 test -- tests/verify-package-script.spec.ts
```

- [ ] **Step 3: Extend the package verifier**

Copy the starter to a fresh temporary directory, replace workspace ranges with
the freshly packed `file:` tarballs, run an offline install with an isolated
store, then run typecheck, tests, and build. Check stdout/stderr for bearer
values and fail if any appear.

- [ ] **Step 4: Run focused and complete verification**

```bash
corepack pnpm@10.34.0 test -- tests/verify-package-script.spec.ts
corepack pnpm@10.34.0 verify:package
```

Expected: the fresh packed starter installs and all gates pass.

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-package.mjs tests/verify-package-script.spec.ts
git commit -m "test: verify the Chat starter from packed SDK packages" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

## Task 5: Write the Five-Minute and Layered Integration Guides

**Files:**
- Create: `examples/chat-starter/README.md`
- Create: `docs/build-a-chat-interface.md`
- Modify: `examples/README.md`
- Modify: `README.md`
- Test: `tests/documentation.spec.ts`

- [ ] **Step 1: Write failing documentation tests**

Assert all four documents contain or link to:

```text
Available now: health and compatibility reporting
Phase 1 preview: discovery and pairing
Phase 2 preview: canonical reads
Phase 3 preview: send and resumable streaming
```

Assert every command references an existing package script and every Markdown
link resolves inside the repository.

- [ ] **Step 2: Verify RED**

```bash
corepack pnpm@10.34.0 test -- tests/documentation.spec.ts
```

- [ ] **Step 3: Write the five-minute starter README**

The exact path is:

```bash
corepack pnpm@10.34.0 install
corepack pnpm@10.34.0 --filter @opencoven/example-chat-starter dev
```

Explain which three files to replace for a new interface:
`src/App.tsx`, `src/styles.css`, and the native-port construction in
`src/main.tsx`. State explicitly that `open-coven-adapter.ts` is example-level,
not a stable exported SDK API.

- [ ] **Step 4: Write the low-level reference**

Document:

1. package selection;
2. caller-supplied transport;
3. authority ownership;
4. credential ownership;
5. health compatibility mapping;
6. adapter snapshots and actions;
7. normalized errors;
8. current/preview capability table;
9. React and framework-neutral subscription examples;
10. package and contract verification.

- [ ] **Step 5: Update indexes and run all gates**

```bash
corepack pnpm@10.34.0 test -- tests/documentation.spec.ts
corepack pnpm@10.34.0 lint
corepack pnpm@10.34.0 typecheck
corepack pnpm@10.34.0 test
corepack pnpm@10.34.0 build
corepack pnpm@10.34.0 verify:package
```

- [ ] **Step 6: Commit**

```bash
git add README.md docs/build-a-chat-interface.md examples/README.md \
  examples/chat-starter/README.md tests/documentation.spec.ts
git commit -m "docs: add the SDK Chat builder journey" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```
