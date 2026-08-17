# Phase 0 Baseline and Contract Governance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish clean implementation branches, reproducible toolchains, deterministic Cave and Coven contract artifacts, public TypeScript package boundaries, and stale-contract CI before any supported client route ships.

**Architecture:** Coven Cave and Coven Core remain the contract authorities. Cave exports a deterministic `/api/client/v1` fixture; Coven exposes `coven.daemon.v1` through an owner-adjacent `coven-client` Rust crate. The new SDK repository consumes authority fixtures into transport-neutral TypeScript packages, and Chat consumes `@opencoven/cave-client` through a constrained Tauri adapter rather than copying schemas or issuing arbitrary HTTP requests.

**Tech Stack:** Cave: Next.js 16.2.12, React 19.2.8, TypeScript 6.0.3, Node 24, pnpm 10.34.0. Chat: React 19.2.8, TypeScript 6.0.3, Vite, Vitest, Playwright, Tauri 2.11.x, Rust. SDK: TypeScript 6.0.3, Zod 4, pnpm workspaces, tsup, Vitest. Coven: Rust 2021, Cargo.

**Repositories:**
- Cave: `/Users/buns/Documents/GitHub/OpenCoven/coven-cave`
- Coven: `/Users/buns/Documents/GitHub/OpenCoven/coven`
- SDK: `/Users/buns/Documents/GitHub/OpenCoven/sdk`
- Chat: `/Users/buns/Documents/GitHub/OpenCoven/chat`

---

## File Map

### Cave

- Create `src/lib/server/client-v1/contract.ts` — v1 constants, scopes, DTOs, parsers, fixture builder.
- Create `src/lib/server/client-v1/responses.ts` — stable success/error envelopes.
- Create `src/lib/server/client-v1/contract.test.ts` — parser, compatibility, and envelope tests.
- Create `src/lib/server/client-v1/contract-fixture.json` — generated public fixture.
- Create `src/lib/server/client-v1/contract-fixture.sha256` — generated fixture digest.
- Create `scripts/export-client-v1-contract.mjs` — deterministic exporter and `--check`.
- Create `scripts/export-client-v1-contract.test.mjs` — determinism and stale-output tests.
- Modify `scripts/run-tests.mjs` — register new tests.
- Modify `scripts/ci-paths.mjs` and `scripts/ci-paths.test.mjs` — classify client-v1 changes.
- Modify `src/app/api/api-contracts.test.ts` — reserve the supported route family.

### Coven

- Create `crates/coven-client/Cargo.toml` with version `0.1.0`.
- Create `crates/coven-client/src/{lib,error,models,discovery,http}.rs`.
- Create `crates/coven-client/src/transport/{mod,unix,windows}.rs`.
- Create `crates/coven-client/tests/health.rs`.
- Create `crates/coven-client/fixtures/{health,error}.json`.
- Modify workspace `Cargo.toml`.
- Modify `crates/coven-cli/Cargo.toml`.
- Modify `crates/coven-cli/src/tui/chat/client.rs` to compose the crate.
- Modify `docs/API-CONTRACT.md` and `docs/CLIENT-INTEGRATION.md` only for the reusable-client extraction.

### SDK

- Create root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.workspace.ts`.
- Create packages named exactly:
  - `@opencoven/sdk-core`
  - `@opencoven/cave-client`
  - `@opencoven/coven-client`
  - `@opencoven/sdk`
  - `@opencoven/dev-cli`
- Create `packages/core/src/{errors,compatibility,secret-store}.ts`.
- Create `packages/cave/src/{client,schemas,transport}.ts` and `packages/cave/fixtures/*`.
- Create `packages/coven/src/{client,schemas,transport}.ts` and `packages/coven/fixtures/*`.
- Create `packages/sdk/src/client.ts`.
- Create `packages/cli/src/{main,output}.ts`.
- Create `scripts/{verify-contracts,verify-package}.mjs`.
- Create package export, digest, CLI help/JSON, and packed-example tests.

### Chat

- Create React/Vite/Vitest/Playwright files: `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `index.html`, `src/main.tsx`, `src/app.tsx`, `src/app.test.tsx`, `src/test/setup.ts`.
- Create Tauri files: `src-tauri/Cargo.toml`, `src-tauri/build.rs`, `src-tauri/tauri.conf.json`, `src-tauri/capabilities/default.json`, `src-tauri/src/{main,lib}.rs`.
- Create `src/lib/cave-api/{transport,client}.ts` and `client.test.ts`.
- Modify `README.md`.
- Create `.github/workflows/ci.yml`.

## Task 1: Prepare Isolated Repository Worktrees

**Files:** None.

- [ ] **Step 1: Record the clean base SHA for each existing repository**

Run:

```bash
git -C /Users/buns/Documents/GitHub/OpenCoven/coven-cave rev-parse origin/main
git -C /Users/buns/Documents/GitHub/OpenCoven/coven rev-parse origin/main
git -C /Users/buns/Documents/GitHub/OpenCoven/chat rev-parse origin/main
```

Expected: three full commit SHAs.

- [ ] **Step 2: Create dedicated worktrees from those SHAs**

Use repository-specific branch names such as `feat/client-v1-contract`,
`feat/coven-client`, and `feat/chat-phase-0`. Do not include Cave's existing
`.beads/interactions.jsonl` or sweep file, Coven's staged brainstorm/review
artifacts, or Chat's untracked hand-authored fixture.

- [ ] **Step 3: Create the SDK repository**

Create `OpenCoven/sdk` as its own repository with `main`, the approved license,
and a Phase 0 implementation branch. Do not place the SDK inside another
repository or use cross-repository relative imports.

- [ ] **Step 4: Verify all implementation worktrees are clean**

Run `git status --short --branch` in each worktree.

Expected: no modified, staged, or untracked implementation files before work starts.

## Task 2: Define and Export the Cave v1 Contract

**Files:**
- Create all Cave contract/export files from the File Map.
- Modify Cave test and CI wiring files from the File Map.

- [ ] **Step 1: Write failing contract tests**

Tests must assert:

```ts
expect(CLIENT_V1_API_VERSION).toBe("1.0");
expect(CLIENT_V1_MIN_CLIENT_VERSION).toBe("0.1.0");
expect(CLIENT_V1_SCOPES).toEqual([
  "chat:read",
  "chat:write",
  "conversations:write",
  "attachments:write",
  "tasks:write",
  "github:write",
]);
expect(parseIdempotencyKey(crypto.randomUUID())).toMatch(UUID_RE);
expect(() => parsePairingRequest({ appName: "x", installationId: "x", scopes: ["admin"] }))
  .toThrow();
```

The stable error union must include `reconcile_required` and must not introduce
an unapproved `operation_already_started` code. In-progress operations use
`conflict` with structured string details.

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```bash
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test src/lib/server/client-v1/contract.test.ts
```

Expected: failure because the modules do not exist.

- [ ] **Step 3: Implement strict types, parsers, and envelopes**

Use:

```ts
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
  | "reconcile_required"
  | "internal_error";
```

Fixture construction must be a pure exported function returning health, error,
credential, familiar, project, conversation-list, conversation-detail, and
stream-event examples. Unknown additive response fields remain acceptable;
missing required fields do not.

- [ ] **Step 4: Write the exporter and determinism test**

`scripts/export-client-v1-contract.mjs` serializes with two-space indentation
and a final newline, then writes the SHA-256 as lowercase hexadecimal plus a
newline. `--check` compares generated bytes without rewriting files.

- [ ] **Step 5: Register tests and CI path behavior**

Client-v1 contract, exporter, fixture, route, or documentation changes must
enable Cave API, E2E, and documentation jobs.

- [ ] **Step 6: Run the Cave Phase 0 gates**

```bash
pnpm lint
pnpm typecheck
pnpm test:api
pnpm check:tests-wired
node scripts/export-client-v1-contract.mjs --check
node scripts/export-client-v1-contract.mjs --check
```

Expected: all pass and both exporter checks leave the worktree unchanged.

## Task 3: Extract the Owner-Adjacent Coven Rust Client

**Files:** Coven files listed in the File Map.

- [ ] **Step 1: Write failing health, mismatch, and structured-error tests**

The tests exercise `coven.daemon.v1`, `capabilities.structuredErrors`,
owner-local Unix socket discovery, owner-only Windows named-pipe discovery, and
preservation of `error.code`, `message`, and `details`.

- [ ] **Step 2: Run the crate test and confirm failure**

```bash
cargo test -p coven-client --locked
```

Expected: failure because `coven-client` is not yet a workspace member.

- [ ] **Step 3: Implement a constrained transport**

The public client accepts a discovered `DaemonEndpoint`, not a URL. It permits
only `/api/v1/*`, uses Unix sockets or owner-only Windows named pipes, caps
response bodies, and performs health negotiation before dependent calls. It
must not expose a raw `request(method, arbitrary_url)` API.

- [ ] **Step 4: Replace CLI-local health transport composition**

`crates/coven-cli/src/tui/chat/client.rs` retains CLI policy and ledger-only
operations but delegates daemon HTTP framing, health negotiation, and error
parsing to `coven-client`.

- [ ] **Step 5: Run Coven gates**

```bash
cargo test -p coven-client --locked
cargo test -p coven-cli --locked
cargo fmt --all -- --check
```

Expected: all pass without CLI output or behavior changes.

## Task 4: Scaffold the Public TypeScript SDK

**Files:** SDK files listed in the File Map.

- [ ] **Step 1: Create the workspace manifest**

Pin Node `>=24.18.0 <25`, pnpm `10.34.0`, and TypeScript `6.0.3`. Package
versions begin at `0.1.0`; Rust crates are not published from this repository.

- [ ] **Step 2: Write failing export and normalized-error tests**

Tests must import only declared package entry points and assert:

```ts
expect(error).toMatchObject({
  system: "cave",
  code: "unauthorized",
  retryable: false,
  operation: "health",
});
```

- [ ] **Step 3: Write failing fixture-digest tests**

Copy Cave's generated fixture and digest exactly into
`packages/cave/fixtures/`. Copy the reviewed Coven fixture set into
`packages/coven/fixtures/`. Tests compare bytes and expected digests; they do
not import authority source code.

- [ ] **Step 4: Implement package boundaries**

`@opencoven/cave-client` and `@opencoven/coven-client` receive constrained
transport interfaces. `@opencoven/sdk` coordinates optional clients but never
collapses their discovery or authentication. `@opencoven/dev-cli` owns the
`opencoven` binary and returns stable human or JSON output.

- [ ] **Step 5: Write failing packed-package tests**

Pack each package, install tarballs into fixture examples, compile them, and
verify no undeclared source file is required.

- [ ] **Step 6: Run SDK gates**

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm --recursive build
node scripts/verify-contracts.mjs
node scripts/verify-package.mjs
```

Expected: all pass against packed artifacts.

## Task 5: Scaffold Chat Against the Public Package

**Files:** Chat files listed in the File Map.

- [ ] **Step 1: Create the approved package manifest**

Pin Node `>=24.18.0 <25`, pnpm `10.34.0`, TypeScript `6.0.3`, React `19.2.8`,
Tauri `2.11.x`, and the approved `0.1.x` `@opencoven/cave-client` release.

- [ ] **Step 2: Write failing React and Rust smoke tests**

React asserts an `OpenCoven Chat` heading and unavailable connection state.
Rust asserts the Tauri builder registers the initial command table.

- [ ] **Step 3: Implement the minimal shells**

The webview receives only typed non-secret command results. `CaveTransport`
adapts package operations to Tauri commands and exposes no arbitrary URL,
headers, bearer, or generic fetch method.

- [ ] **Step 4: Write package-fixture adapter tests**

Test successful additive parsing, missing required fields, wrong major version,
structured errors, non-JSON responses, aborts, and timeouts through
`@opencoven/cave-client`.

- [ ] **Step 5: Run Chat gates**

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
pnpm build
```

Expected: all pass.

## Task 6: Add the Cross-Repository Contract Canary

**Files:**
- SDK: contract and package verification scripts/tests.
- Chat: `.github/workflows/ci.yml`.
- Cave: exporter and CI classification tests already created.

- [ ] **Step 1: Add a failing stale-fixture test**

Mutate one required fixture field in test memory without updating the digest.
SDK and Chat verification must reject it.

- [ ] **Step 2: Add packed-tarball canary execution**

The canary installs the packed SDK packages and builds Chat/examples without
source-relative links.

- [ ] **Step 3: Run all Phase 0 commands**

Run every repository command listed in the Phase 0 Validation Matrix below.

- [ ] **Step 4: Confirm clean worktrees**

`git status --short` must be empty after generated files are committed.

## Validation Matrix

```bash
# Cave
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test:api
pnpm check:tests-wired
node scripts/export-client-v1-contract.mjs --check

# Coven
cargo test -p coven-client --locked
cargo test -p coven-cli --locked
cargo fmt --all -- --check

# SDK
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm --recursive build
node scripts/verify-contracts.mjs
node scripts/verify-package.mjs

# Chat
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
cargo test --manifest-path src-tauri/Cargo.toml
pnpm build
```

## Cross-Repository Merge Order

1. Cave contract, deterministic export, and CI wiring.
2. Coven `coven-client` `0.1.x` extraction.
3. SDK workspace, fixture ingestion, and package verification.
4. Publish or otherwise make the reviewed `0.1.x` TypeScript packages available.
5. Chat scaffold pinned to `@opencoven/cave-client`.
6. Cross-repository packed-package canary.

## Commit Checkpoints

After each task passes its focused validation, create one repository-local
checkpoint:

1. Cave: `feat(client-v1): define deterministic public contract`
2. Coven: `feat(client): extract daemon health client`
3. SDK: `feat: scaffold OpenCoven client packages`
4. Chat: `feat: scaffold OpenCoven Chat desktop app`
5. Cross-repository CI owners: `test: enforce client contract digests`

Do not combine authority, SDK, and Chat changes in one commit or repository.

## Exit Gates

- Every implementation branch started from a recorded clean base.
- Contract export is byte-identical across consecutive runs.
- Chat and SDK reject deliberately stale fixture digests.
- Chat parses the authority fixture only through `@opencoven/cave-client`.
- Packed SDK packages expose only declared entry points and examples compile.
- `coven-client` passes existing CLI API behavior through the extracted crate.
- No raw private Cave route, arbitrary HTTP URL, bearer header, or server
  implementation import appears in Chat or the SDK public surface.

## Bead Mapping

| Symbolic bead | Title | Depends on |
|---|---|---|
| `chat-v1-p0` | Phase 0: establish OpenCoven client contract baseline | — |
| `chat-v1-p0-cave-contract` | Export deterministic Cave client-v1 contract | — |
| `chat-v1-p0-coven-client` | Extract Coven daemon health client | — |
| `chat-v1-p0-sdk-workspace` | Scaffold public OpenCoven SDK workspace | Cave contract, Coven client |
| `chat-v1-p0-chat-scaffold` | Scaffold Chat with packaged Cave client | SDK workspace |
| `chat-v1-p0-contract-canary` | Enforce cross-repository fixture digests | All Phase 0 implementation beads |

Use `surface:shared` for Cave/Coven/SDK and `surface:desktop` for Chat. Relate
task beads to the phase epic; do not create sibling parent-child blocking edges.
