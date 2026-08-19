# SDK Showcase Reference App Design

**Status:** Approved
**Date:** 2026-08-19
**Repositories:** `OpenCoven/chat`, `OpenCoven/sdk`

## Purpose

Make OpenCoven Chat a polished product and a trustworthy reference
implementation for teams that want to replace the interface while keeping the
OpenCoven SDK, authority boundaries, and native security model.

The product remains product-first. Builders discover a discreet
`Built with OpenCoven SDK · Build your own` path in About, Settings, the
repository README, and the documentation. The primary chat surface does not
become a developer dashboard.

## Audience

The material serves three audiences in layers:

1. React and Tauri teams building a desktop client.
2. Web developers using another presentation framework.
3. SDK and library authors composing lower-level transports and errors.

A builder should be able to stop after the five-minute starter or continue
through the framework-neutral and low-level references without switching to a
different documentation system.

## Product and SDK Boundary

Chat components consume a framework-neutral application contract rather than
calling Cave, Coven, Tauri, keychain, or transport APIs directly:

```ts
export type ChatViewModel = {
  connection: ConnectionViewModel;
  navigation: NavigationViewModel;
  conversation: ConversationViewModel;
  composer: ComposerViewModel;
};

export type ChatActions = {
  connect(): Promise<void>;
  selectConversation(id: string): void;
  createConversation(input: CreateConversationInput): Promise<void>;
  send(input: SendMessageInput): Promise<void>;
  stop(runId: string): Promise<void>;
  retry(turnId: string): Promise<void>;
};

export type OpenCovenChatAdapter = {
  subscribe(listener: (viewModel: ChatViewModel) => void): () => void;
  snapshot(): ChatViewModel;
  actions: ChatActions;
};
```

The exact fields evolve with the approved Phase 1–3 contracts, but the
separation is fixed:

- SDK clients own typed Cave and Coven operations and normalized errors.
- injected native ports own discovery, launch, keychain, and constrained
  credential use;
- the adapter owns orchestration, state reduction, stale-response handling,
  stream recovery, and presentation-safe view models;
- React owns rendering and ephemeral interaction state;
- Cave remains authoritative for canonical conversations, messages, familiar
  identity, execution, and privileged actions.

The UI must not import raw transport implementations, receive bearer tokens,
construct arbitrary URLs, or persist canonical records.

## Demo and Real Adapters

The polished demo and the production client implement the same adapter
contract:

- `DemoChatAdapter` supplies deterministic fixtures and simulated timing.
- `SdkChatAdapter` composes `@opencoven/cave-client`,
  `@opencoven/coven-client`, and injected native ports.

This makes the demo a real presentation reference instead of a disposable
mock. Switching from demo to production changes adapter construction, not
component props or screen structure.

Demo data remains visibly identified as demonstration data in documentation
and diagnostics. The normal product surface does not display developer
instrumentation.

## Packaging Strategy

During Phases 1–3, the adapter remains example-level code while the public
client operations stabilize. Chat and the SDK starter share a checked contract,
not a prematurely supported package.

After the complete pair → read → create → send → resume journey passes the
production gates, a compatibility review may promote the adapter into a
supported headless SDK package. Promotion requires:

- stable operations and error envelopes;
- no Chat-private imports;
- framework-neutral tests;
- packed-package verification;
- semantic-versioning and migration documentation.

## Standalone Starter

The SDK repository ships a deterministic starter that:

- imports only packed public packages;
- injects narrow Cave and Coven transports;
- constructs the example-level chat adapter;
- renders a minimal replaceable interface;
- demonstrates healthy, unavailable, incompatible, degraded, and failed states;
- performs no discovery, credential lookup, network access, or filesystem I/O
  unless the builder explicitly supplies those ports.

The starter includes:

- a React implementation for the fastest path;
- a framework-neutral adapter and view-model walkthrough;
- a small “replace this component” exercise;
- commands that build, run, and verify the packed example.

## Documentation Structure

### 1. Five-Minute Quickstart

Install or pack the SDK, run the deterministic starter, replace one
presentational component, and verify the result.

### 2. Architecture Map

Explain the authority, SDK client, native port, adapter, and UI layers. Show
which repository owns each responsibility and which boundaries are safe to
replace.

### 3. Remake the Interface

Walk through:

1. preserving the adapter contract;
2. replacing React components or the whole framework;
3. mapping design-system tokens;
4. rendering every explicit connection/error state;
5. keeping canonical and secret data out of browser storage;
6. verifying the replacement against shared fixtures.

### 4. Transport and Security Reference

Document caller-supplied transports, authentication ownership, timeouts,
retries, aborts, error normalization, version negotiation, redaction, and the
prohibition on arbitrary HTTP/private Cave routes.

### 5. Current and Preview Capabilities

Every snippet carries one of:

- **Available:** compiles and runs against current packed packages.
- **Phase 1 preview:** discovery, pairing, health, credentials.
- **Phase 2 preview:** canonical reads, search, transcript.
- **Phase 3 preview:** create, send, stream, stop, retry, recovery.

Preview snippets are typechecked against explicit preview contracts and cannot
be presented as released package APIs.

## Product Discoverability

The SDK story is intentionally discreet:

- About and Settings include `Built with OpenCoven SDK` and `Build your own`.
- README and repository metadata lead with the product, then identify it as the
  reference implementation.
- Empty states and normal chat chrome do not advertise developer tooling.
- No persistent Builder Mode, schema inspector, or debug rail ships in the
  product UI.

## Errors and Safe Presentation

The adapter maps typed SDK/native failures into explicit presentation states:

- unavailable;
- pairing required;
- incompatible;
- revoked;
- degraded reads;
- interrupted stream;
- reconciliation required;
- ambiguous send completion.

User-safe messages never include bearers, pairing secrets, raw headers,
arbitrary environment data, or unrestricted filesystem paths. Unknown errors
remain explicit and observable rather than becoming successful-looking empty
states.

## Verification

CI verifies:

- current quickstart snippets compile against packed SDK packages;
- preview snippets typecheck separately against versioned preview contracts;
- Chat and the starter conform to the same adapter/view-model fixture;
- demo and production adapters drive the same component tests;
- the deterministic starter runs without network access;
- no raw SDK transport, bearer, private route, or canonical browser persistence
  crosses the UI boundary;
- documentation links and commands remain valid;
- keyboard, screen-reader, reduced-motion, and screenshot checks cover the
  showcase surface.

## Acceptance Criteria

- A fresh builder can run the starter and replace one UI component in under ten
  minutes.
- React/Tauri and framework-neutral integration paths are both complete.
- The polished product is fully usable without opening developer material.
- Current examples are executable; preview examples are unmistakably gated.
- The demo is a faithful adapter implementation, not a second product model.
- The starter and Chat cannot drift silently from the public SDK contract.
- Security and canonical authority boundaries remain unchanged.
