# SDK Discovery and Pairing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the SDK workspace with transport-neutral Cave discovery/pairing, independent Coven IPC discovery, secret-free CLI commands, and packed-package verification without regressing existing familiars or analytics APIs.

**Architecture:** Keep the current public package split and additive exports: `@opencoven/sdk-core` owns handwritten guards and shared contracts, `@opencoven/coven-client` discovers/validates same-user IPC, `@opencoven/cave-client` adds reviewed discovery and pairing flows alongside the existing familiar APIs, and `@opencoven/dev-cli` stays a thin manual parser over those reviewed surfaces. Land the Coven IPC lane as an independent Wave 1 PR, then branch the Cave pairing/CLI lane from updated `main` after the Cave authority contract merges. Import-time I/O remains forbidden.

**Tech Stack:** TypeScript 6.0.3, pnpm workspaces, tsup, Vitest 4.1.10, existing packed/offline verification scripts, handwritten runtime guards, no Zod.

---

## File Map

**Repository root:** `/Users/buns/Documents/GitHub/OpenCoven/sdk`
**Implementation worktree:** `/Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/phase1b-sdk-discovery-pairing`
**Branches:** `phase1b/sdk-coven-ipc`, then `phase1b/sdk-cave-pairing`
**Primary beads:** `cave-p8qkk`, `cave-lf7bu`
**Current-state rules to preserve:** package exports stay `.` and `./package.json`; CLI parsing stays handwritten; imports perform no discovery or network I/O; existing familiars/analytics exports remain source-compatible.

### Create
- `packages/core/src/discovery.ts` — shared discovery profiles, guard helpers, and stable error codes.
- `tests/discovery-contract.spec.ts` — guard, compatibility, and import-purity coverage for shared discovery shapes.
- `packages/coven/src/discovery.ts` — `COVEN_HOME` and `coven config paths --json` discovery.
- `packages/coven/src/transport-unix.ts` — validated Unix socket transport.
- `packages/coven/src/transport-windows.ts` — validated Windows named-pipe transport.
- `tests/coven-discovery.spec.ts` — Coven discovery, same-user validation, and structured daemon error tests.
- `packages/cave/src/discovery.ts` — Cave discovery record parsing and candidate validation.
- `packages/cave/src/pairing.ts` — create/poll/exchange and credential status helpers.
- `tests/cave-discovery-pairing.spec.ts` — Cave discovery, health negotiation, pairing, and revocation tests.
- `packages/cli/src/commands/doctor.ts` — secret-free `opencoven doctor [--json]`.
- `packages/cli/src/commands/discover.ts` — secret-free `opencoven discover [--json]`.
- `packages/cli/src/commands/cave.ts` — `pair`, `status`, and `forget` subcommands.
- `packages/cli/src/commands/coven.ts` — `health` subcommand.
- `packages/cli/src/credentials.ts` — CLI credential serialization and redaction helpers.
- `packages/cli/src/native-secret-store.ts` — strict `@napi-rs/keyring` adapter with no file or shell fallback.
- `tests/native-secret-store.spec.ts` — native adapter success, missing-binding, and unavailable-keychain tests.

### Modify
- `packages/core/src/index.ts` and `packages/core/src/secret-store.ts` — export the new shared discovery/secret-store contracts additively.
- `packages/coven/src/client.ts`, `packages/coven/src/index.ts`, and `packages/coven/README.md` — expose discovery + health without changing import-time purity.
- `packages/cave/src/client.ts`, `packages/cave/src/index.ts`, `packages/cave/src/schemas.ts`, and `packages/cave/README.md` — add discovery/pairing APIs while preserving familiars and analytics methods.
- `packages/cli/src/main.ts`, `packages/cli/src/index.ts`, `packages/cli/src/output.ts`, and `packages/cli/package.json` — expand the manual CLI parser, add exact `@napi-rs/keyring` `1.3.0`, and keep JSON rendering secret-free.
- `tests/import-purity.spec.ts`, `tests/public-contract.spec.ts`, `tests/cli-contract.spec.ts`, `tests/cli-binary.spec.ts`, `tests/packed-package.spec.ts`, `tests/verify-package-contract.spec.ts`, `tests/package-manifests.spec.ts` — extend the existing verification surfaces instead of replacing them.
- `README.md`, `packages/cli/README.md`, and `packages/sdk/README.md` — document discovery/pairing usage and the no-release rule.

### Task 1: Add shared discovery contracts and secret-store extensions

**Files:**
- Create: `packages/core/src/discovery.ts`
- Create: `tests/discovery-contract.spec.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/secret-store.ts`
- Modify: `tests/import-purity.spec.ts`

- [ ] **Step 1: Create a clean SDK worktree**

Run:

```bash
git -C /Users/buns/Documents/GitHub/OpenCoven/sdk fetch origin main
git -C /Users/buns/Documents/GitHub/OpenCoven/sdk worktree add /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/phase1b-sdk-discovery-pairing -b phase1b/sdk-coven-ipc origin/main
git -C /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/phase1b-sdk-discovery-pairing status --short --branch
```

Expected: the worktree is clean at current SDK `origin/main`.

- [ ] **Step 2: Write the failing shared-contract tests**

```ts
import { describe, expect, test } from 'vitest';

import { parseDiscoveryEndpoint, parseDiscoveryRecord } from '@opencoven/sdk-core';

describe('shared discovery contracts', () => {
  test('accept accepted loopback and same-user IPC discovery profiles', () => {
    expect(parseDiscoveryEndpoint({ kind: 'http', url: 'http://127.0.0.1:3020' }).kind).toBe('http');
    expect(parseDiscoveryEndpoint({ kind: 'unix', path: '/Users/buns/.local/state/coven/daemon.sock' }).kind).toBe('unix');
  });

  test('rejects remote hosts, query-bearing URLs, and malformed records', () => {
    expect(() => parseDiscoveryEndpoint({ kind: 'http', url: 'https://example.com' })).toThrow(/loopback/);
    expect(() => parseDiscoveryRecord({ version: 1, endpoint: 'not-an-object' })).toThrow(/record/);
  });
});
```

- [ ] **Step 3: Run the focused tests and confirm failure**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/phase1b-sdk-discovery-pairing
pnpm vitest run tests/discovery-contract.spec.ts tests/import-purity.spec.ts
```

Expected: the new shared discovery module is missing, so the focused run fails.

- [ ] **Step 4: Implement the minimal shared discovery contract additively**

```ts
export type DiscoveryEndpoint =
  | { kind: 'http'; url: string }
  | { kind: 'unix'; path: string }
  | { kind: 'windowsNamedPipe'; path: string };

export function parseDiscoveryEndpoint(value: unknown): DiscoveryEndpoint {
  const record = expectObject(value, 'discovery endpoint');
  const kind = expectString(record.kind, 'discovery endpoint.kind');
  if (kind === 'http') return { kind, url: expectLoopbackHttpUrl(record.url) };
  if (kind === 'unix') return { kind, path: expectAbsolutePath(record.path, 'unix socket path') };
  if (kind === 'windowsNamedPipe') return { kind, path: expectWindowsPipePath(record.path) };
  throw new TypeError('discovery endpoint.kind must be one of http, unix, or windowsNamedPipe');
}
```

Implementation requirements:
- use the existing handwritten guard style (`expectString`, `expectObject`, literal checks), not Zod;
- keep `SecretStore` additive and backward-compatible with existing `get`/`set`/`delete` callers;
- keep `tests/import-purity.spec.ts` green by ensuring `packages/core` still performs no I/O at import time.

- [ ] **Step 5: Run the focused tests again and confirm they pass**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/phase1b-sdk-discovery-pairing
pnpm vitest run tests/discovery-contract.spec.ts tests/import-purity.spec.ts tests/secret-store.spec.ts
```

Expected: all focused tests pass.

- [ ] **Step 6: Commit the shared contracts**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/phase1b-sdk-discovery-pairing
git add packages/core/src/discovery.ts packages/core/src/index.ts packages/core/src/secret-store.ts tests/discovery-contract.spec.ts tests/import-purity.spec.ts
git commit -m "feat: add shared SDK discovery contracts" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 2: Implement Coven discovery and same-user transports

**Files:**
- Create: `packages/coven/src/discovery.ts`
- Create: `packages/coven/src/transport-unix.ts`
- Create: `packages/coven/src/transport-windows.ts`
- Create: `tests/coven-discovery.spec.ts`
- Modify: `packages/coven/src/client.ts`
- Modify: `packages/coven/src/index.ts`
- Modify: `packages/coven/README.md`

- [ ] **Step 1: Write the failing Coven discovery tests**

```ts
test('discovers Coven through COVEN_HOME or `coven config paths --json`', async () => {
  const endpoint = await discoverCovenEndpoint({ env: { COVEN_HOME: '/Users/buns/.local/state/coven' }, execFile });
  expect(endpoint.protocol).toBe('coven.daemon.v1');
});

test('rejects non-owner sockets and preserves structured daemon errors', async () => {
  await expect(discoverCovenEndpoint({ env: {}, execFile: failingExecFile })).rejects.toMatchObject({ code: 'discovery_failed' });
  await expect(createCovenClient({ transport }).health()).rejects.toMatchObject({ code: 'invalid_response' });
});
```

- [ ] **Step 2: Run the focused Coven tests and confirm failure**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/phase1b-sdk-discovery-pairing
pnpm vitest run tests/coven-discovery.spec.ts tests/public-contract.spec.ts
```

Expected: the new discovery/transport modules are missing and the public contract tests do not yet expose them.

- [ ] **Step 3: Implement minimal discovery and transports without import-time I/O**

```ts
export async function discoverCovenEndpoint(options: {
  env?: NodeJS.ProcessEnv;
  execFile?: typeof import('node:child_process').execFile;
}): Promise<CovenDiscoveredEndpoint> {
  const config = await readCovenConfigPaths(options);
  return parseCovenDiscoveredEndpoint({
    protocol: 'coven.daemon.v1',
    endpoint: config.state.daemon_ipc,
    owner: config.user.uid,
  });
}
```

Implementation requirements:
- read `COVEN_HOME` first, then fall back to `coven config paths --json`;
- validate same-user Unix sockets and same-owner Windows named pipes before connecting;
- preserve structured daemon error fields instead of flattening them into strings;
- export only through `packages/coven/src/index.ts` and keep `package.json` exports unchanged.

- [ ] **Step 4: Run the focused Coven tests again and confirm they pass**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/phase1b-sdk-discovery-pairing
pnpm vitest run tests/coven-discovery.spec.ts tests/public-contract.spec.ts tests/import-purity.spec.ts
```

Expected: all focused tests pass.

- [ ] **Step 5: Commit the Coven lane**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/phase1b-sdk-discovery-pairing
git add packages/coven/src/discovery.ts packages/coven/src/transport-unix.ts packages/coven/src/transport-windows.ts packages/coven/src/client.ts packages/coven/src/index.ts packages/coven/README.md tests/coven-discovery.spec.ts tests/public-contract.spec.ts
git commit -m "feat: discover Coven daemon endpoints" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

- [ ] **Step 6: Run the full SDK verification matrix for the independent Coven lane**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/phase1b-sdk-discovery-pairing
corepack pnpm@10.34.0 verify
```

Expected: the complete SDK verification passes without any Cave pairing dependency.

- [ ] **Step 7: Push, review, and merge the Coven IPC pull request**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/phase1b-sdk-discovery-pairing
git push -u origin phase1b/sdk-coven-ipc
gh -R OpenCoven/sdk pr create --base main --head phase1b/sdk-coven-ipc --title "feat: discover Coven daemon endpoints" --body "## Summary
- add shared transport-neutral discovery contracts
- discover and validate same-user Coven IPC endpoints
- preserve structured daemon errors and import-time purity

## Testing
- corepack pnpm@10.34.0 verify"
gh -R OpenCoven/sdk pr checks --watch
gh -R OpenCoven/sdk pr merge --squash --delete-branch=false
```

Expected: the Wave 1 SDK Coven IPC PR merges independently after required checks pass.

- [ ] **Step 8: Record the merged Coven evidence**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
bd show cave-p8qkk
bd close cave-p8qkk --reason "Merged phase1b/sdk-coven-ipc after corepack pnpm@10.34.0 verify."
```

Expected: `cave-p8qkk` records the independently reviewed and merged Wave 1 SDK evidence.

### Task 3: Add Cave discovery, pairing, and credential status without breaking familiar APIs

**Files:**
- Create: `packages/cave/src/discovery.ts`
- Create: `packages/cave/src/pairing.ts`
- Create: `tests/cave-discovery-pairing.spec.ts`
- Modify: `packages/cave/src/client.ts`
- Modify: `packages/cave/src/index.ts`
- Modify: `packages/cave/src/schemas.ts`
- Modify: `packages/cave/README.md`
- Modify: `tests/import-purity.spec.ts`
- Modify: `tests/public-contract.spec.ts`

- [ ] **Step 1: Start the Cave pairing lane only after the Phase 1a contract is merged**

Run:

```bash
git -C /Users/buns/Documents/GitHub/OpenCoven/sdk worktree remove /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/phase1b-sdk-discovery-pairing
git -C /Users/buns/Documents/GitHub/OpenCoven/sdk fetch origin main
git -C /Users/buns/Documents/GitHub/OpenCoven/sdk worktree add /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/phase1b-sdk-discovery-pairing -b phase1b/sdk-cave-pairing origin/main
git -C /Users/buns/Documents/GitHub/OpenCoven/coven-cave fetch origin main
git -C /Users/buns/Documents/GitHub/OpenCoven/coven-cave show origin/main:src/app/api/client/v1/health/route.ts
```

Expected: the Coven IPC PR is present on SDK `origin/main`, the new worktree is clean on `phase1b/sdk-cave-pairing`, and the Phase 1a Cave authority PR is merged with an exported reviewed `/api/client/v1` contract.

- [ ] **Step 2: Write the failing Cave discovery and pairing tests**

```ts
test('discovers a validated Cave record and negotiates health compatibility', async () => {
  const discovery = parseCaveDiscoveryRecord(sampleDiscoveryRecord);
  const client = createCaveClient({ transport: createDiscoveredCaveTransport(discovery) });

  await expect(client.health()).resolves.toEqual({ status: 'ok' });
});

test('creates, polls, exchanges, and forgets pairings through a SecretStore', async () => {
  const store = createManagedMemorySecretStore();
  const pairing = await createCavePairingSession(client, store, pairingRequest);

  expect(pairing.requestId).toBe('request-1');
  expect(await readCaveCredentialStatus(client, store)).toMatchObject({ connected: false });
});
```

- [ ] **Step 3: Run the focused Cave tests and confirm failure**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/phase1b-sdk-discovery-pairing
pnpm vitest run tests/cave-discovery-pairing.spec.ts tests/public-contract.spec.ts tests/import-purity.spec.ts
```

Expected: the discovery/pairing helpers are missing and the public contract tests fail.

- [ ] **Step 4: Implement the minimal Cave discovery and pairing layer additively**

```ts
export interface CavePairingClient {
  discover(options?: CaveDiscoveryOptions): Promise<CaveDiscoveryRecord>;
  createPairing(request: CavePairingRequest, options?: OperationOptions): Promise<CavePairingCreated>;
  pollPairing(requestId: string, secret: string, options?: OperationOptions): Promise<CavePairingStatus>;
  exchangePairing(
    requestId: string,
    secret: string,
    store: SecretStore,
    options?: OperationOptions,
  ): Promise<CaveCredentialMetadata>;
  readCredentialStatus(options?: OperationOptions): Promise<CaveCredentialStatus>;
}
```

Implementation requirements:
- parse Cave discovery records defensively: owner-local file, loopback endpoint, no userinfo/path/query/fragment, current nonce/pid freshness;
- add pairing/status helpers next to the existing familiar methods rather than replacing `CaveClient`;
- parse the one-time bearer only inside `exchangePairing`, write it through the injected `SecretStore`, clear the local reference, and return only credential metadata;
- preserve current familiar and analytics exports in `packages/cave/src/index.ts`;
- keep import-time purity and the existing packed-package boundary.

- [ ] **Step 5: Run the focused Cave tests again and confirm they pass**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/phase1b-sdk-discovery-pairing
pnpm vitest run tests/cave-discovery-pairing.spec.ts tests/public-contract.spec.ts tests/import-purity.spec.ts tests/health-validation.spec.ts tests/cave-familiars.spec.ts
```

Expected: all focused tests pass, including the pre-existing familiar and health suites.

- [ ] **Step 6: Commit the Cave lane**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/phase1b-sdk-discovery-pairing
git add packages/cave/src/discovery.ts packages/cave/src/pairing.ts packages/cave/src/client.ts packages/cave/src/index.ts packages/cave/src/schemas.ts packages/cave/README.md tests/cave-discovery-pairing.spec.ts tests/public-contract.spec.ts tests/import-purity.spec.ts
git commit -m "feat: add Cave discovery and pairing SDK APIs" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 4: Expand the CLI with discovery, pairing, and doctor commands

**Files:**
- Create: `packages/cli/src/commands/doctor.ts`
- Create: `packages/cli/src/commands/discover.ts`
- Create: `packages/cli/src/commands/cave.ts`
- Create: `packages/cli/src/commands/coven.ts`
- Create: `packages/cli/src/credentials.ts`
- Create: `packages/cli/src/native-secret-store.ts`
- Create: `tests/native-secret-store.spec.ts`
- Modify: `packages/cli/src/main.ts`
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/output.ts`
- Modify: `packages/cli/package.json`
- Modify: `tests/cli-contract.spec.ts`
- Modify: `tests/cli-binary.spec.ts`

- [ ] **Step 1: Write the failing CLI tests**

```ts
test('renders discover and doctor output without secrets', async () => {
  const result = await runCli(['discover', '--json']);
  expect(result.exitCode).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ command: 'discover', ok: true });
  expect(result.stdout).not.toContain('Bearer ');
});

test('supports cave pair|status|forget and coven health through the handwritten parser', async () => {
  await expect(runCli(['cave', 'status'])).resolves.toMatchObject({ exitCode: 0 });
  await expect(runCli(['coven', 'health', '--json'])).resolves.toMatchObject({ exitCode: 0 });
});

test('maps missing native bindings and keychain backend failures to secure_store_unavailable', async () => {
  await expect(createNativeCliSecretStore(async () => {
    throw new Error('native binding missing');
  })).rejects.toMatchObject({ code: 'secure_store_unavailable' });

  const store = await createNativeCliSecretStore(async () => ({
    Entry: class {
      async getPassword() {
        throw new Error('secret service unavailable');
      }
      async setPassword() {}
      async deletePassword() {}
    },
  }));
  await expect(store.get('cave-bearer')).rejects.toMatchObject({ code: 'secure_store_unavailable' });
});
```

- [ ] **Step 2: Run the focused CLI tests and confirm failure**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/phase1b-sdk-discovery-pairing
pnpm vitest run tests/native-secret-store.spec.ts tests/cli-contract.spec.ts tests/cli-binary.spec.ts
```

Expected: the native adapter is missing and the manual parser still returns `not_implemented`, so the tests fail.

- [ ] **Step 3: Implement the minimal command parser and secret-free renderers**

```ts
type KeyringEntry = {
  getPassword(): Promise<string | null>;
  setPassword(value: string): Promise<void>;
  deletePassword(): Promise<void>;
};

type KeyringModule = {
  Entry: new (service: string, account: string) => KeyringEntry;
};

function secureStoreUnavailable(cause: unknown): Error & { code: 'secure_store_unavailable' } {
  return Object.assign(new Error('Native secure storage is unavailable.', { cause }), {
    code: 'secure_store_unavailable' as const,
  });
}

export async function createNativeCliSecretStore(
  loadKeyring: () => Promise<KeyringModule> = () => import('@napi-rs/keyring'),
): Promise<SecretStore> {
  let Entry: KeyringModule['Entry'];
  try {
    ({ Entry } = await loadKeyring());
  } catch (cause) {
    throw secureStoreUnavailable(cause);
  }

  const invoke = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (cause) {
      throw secureStoreUnavailable(cause);
    }
  };

  return {
    async get(key) {
      return invoke(() => new Entry('ai.opencoven.cli', key).getPassword());
    },
    async set(key, value) {
      await invoke(() => new Entry('ai.opencoven.cli', key).setPassword(value));
    },
    async delete(key) {
      await invoke(() => new Entry('ai.opencoven.cli', key).deletePassword());
    },
  };
}

export async function runCli(argv: readonly string[]): Promise<CliRunResult> {
  const format = argv.includes('--json') ? 'json' : 'human';
  const positional = argv.filter((argument) => !argument.startsWith('--'));

  if (matches(positional, ['doctor'])) return render(await runDoctorCommand(), format);
  if (matches(positional, ['discover'])) return render(await runDiscoverCommand(), format);
  if (matches(positional, ['cave', 'pair'])) return render(await runCavePairCommand(), format);
  if (matches(positional, ['cave', 'status'])) return render(await runCaveStatusCommand(), format);
  if (matches(positional, ['cave', 'forget'])) return render(await runCaveForgetCommand(), format);
  if (matches(positional, ['coven', 'health'])) return render(await runCovenHealthCommand(), format);

  return notImplementedResult(positional, format);
}
```

Implementation requirements:
- keep the parser handwritten and deterministic; do not add commander/cac/yargs/minimist;
- add exact dependency `"@napi-rs/keyring": "1.3.0"` to `packages/cli/package.json`;
- wrap module-load, native-binding, and keychain-service failures as `secure_store_unavailable`; never use `cross-keychain`, keytar, a file backend, or shell-command fallback;
- `doctor` and `discover` emit endpoint, compatibility, and capability diagnostics but never secret values;
- `cave pair` supports in-memory and secure-store flows; missing secure storage fails closed and never falls back to plaintext files; `cave forget` deletes the stored credential through the configured `SecretStore`;
- `coven health` uses the new SDK discovery, not a bespoke child-process parser.

- [ ] **Step 4: Run the focused CLI tests again and confirm they pass**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/phase1b-sdk-discovery-pairing
pnpm vitest run tests/cli-contract.spec.ts tests/cli-binary.spec.ts tests/verify-package-contract.spec.ts tests/packed-package.spec.ts
```

Expected: the CLI tests and packed-package assertions pass.

- [ ] **Step 5: Commit the CLI expansion**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/phase1b-sdk-discovery-pairing
git add packages/cli/package.json packages/cli/src/main.ts packages/cli/src/index.ts packages/cli/src/output.ts packages/cli/src/credentials.ts packages/cli/src/native-secret-store.ts packages/cli/src/commands tests/native-secret-store.spec.ts tests/cli-contract.spec.ts tests/cli-binary.spec.ts tests/verify-package-contract.spec.ts tests/packed-package.spec.ts
git commit -m "feat: add SDK discovery and pairing CLI commands" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

### Task 5: Finish docs, packed verification, PR, merge, and bead evidence

**Files:**
- Modify: `README.md`
- Modify: `packages/cave/README.md`
- Modify: `packages/coven/README.md`
- Modify: `packages/cli/README.md`
- Modify: `packages/sdk/README.md`
- Modify: `tests/package-manifests.spec.ts`

- [ ] **Step 1: Document the new discovery and pairing surfaces**

```md
## New commands

- `opencoven doctor [--json]`
- `opencoven discover [--json]`
- `opencoven cave pair|status|forget [--json]`
- `opencoven coven health [--json]`

The SDK discovers Cave and Coven explicitly at runtime and still performs no I/O at import time.
```

- [ ] **Step 2: Run the full SDK verification matrix**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/phase1b-sdk-discovery-pairing
corepack pnpm@10.34.0 verify
```

Expected: typecheck, tests, recursive builds, contract verification, packed/offline verification, coverage, stress, and lint all pass. Do not run release or publish scripts.

- [ ] **Step 3: Commit the docs and verification sweep**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/phase1b-sdk-discovery-pairing
git add README.md packages/cave/README.md packages/coven/README.md packages/cli/README.md packages/sdk/README.md tests/package-manifests.spec.ts
git commit -m "docs: describe SDK discovery and pairing flows" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

- [ ] **Step 4: Push the branch and open the pull request**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/phase1b-sdk-discovery-pairing
git push -u origin phase1b/sdk-cave-pairing
gh -R OpenCoven/sdk pr create --base main --head phase1b/sdk-cave-pairing --title "feat: add SDK Cave discovery and pairing flows" --body "## Summary
- add Cave discovery, pairing, and credential status APIs
- add secret-free CLI doctor/discover/pair/status/forget commands

## Testing
- corepack pnpm@10.34.0 verify"
```

- [ ] **Step 5: Wait for checks, merge, and record Beads evidence**

Run:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/sdk/.worktrees/phase1b-sdk-discovery-pairing
gh -R OpenCoven/sdk pr checks --watch
gh -R OpenCoven/sdk pr merge --squash --delete-branch=false
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
bd ready --json --limit 0
bd show cave-lf7bu
bd close cave-lf7bu --reason "Merged phase1b/sdk-cave-pairing after corepack pnpm@10.34.0 verify."
```

Expected: the SDK Cave pairing PR merges only after required checks pass, and `cave-lf7bu` records the merged Wave 2 evidence.
