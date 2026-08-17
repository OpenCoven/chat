# iOS Phase C: Cave Enrollment Authority Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Cave own phone enrollment end to end — detect whether a usable overlay exists, guide the user through setting one up, prove its own address actually reaches this instance, and only then hand out a QR code that carries everything a phone needs to pair.

**Architecture:** Enrollment extends the desktop program's existing `/api/client/v1` pairing flow rather than reimplementing it: the QR carries a single-use pairing grant minted by the same pairing store, plus an ordered candidate list and Cave's instance identity. Reachability verification is Cave making one bounded outbound request to the candidate address and checking that the `instanceId` it gets back is its own — which is the only way to distinguish "reachable" from "reaches something else". Push device registration stores an opaque topic and a signing secret; nothing sends a ping until Phase G.

**Tech Stack:** Cave — Next.js, TypeScript 6.0.3, React, Node 24, colocated `.test.ts` files run via `scripts/run-tests.mjs`.

**Depends on:**
- `2026-08-16-ios-phase-b-cave-core-foundation.md` for the `Endpoint` and `Security` shapes the QR payload encodes.
- **`2026-08-15-phase-1-discovery-pairing.md` (bead `cave-9pifu`) must be implemented first.** This phase extends `src/lib/server/client-v1/{pairing-store,credential-store,auth,rate-limit}.ts`, the health route, and the pairing routes it creates.

**Boundary:** No relay service, no push emission, no Swift, no client-side enrollment UI. Cave-side only.

---

## On Code Completeness

Tasks 1 through 5 contain complete, literal code, because they are self-contained modules with no dependency on unwritten interfaces.

Tasks 6 through 8 specify **behavior and assertions precisely, but not literal handler code.** This is deliberate. Those tasks must match the route handler shape, the `auth.ts` verification helper, the rate-limit helper, and the credential-store API that the desktop phase-1 plan creates — none of which exist yet, and none of which I have read as code rather than as a plan. Inventing handler bodies against imagined signatures would produce code that does not compile and would send an implementer down a path of reconciling my guesses with reality.

The implementer of those three tasks should read the phase-1 route handlers first and follow their established shape. Every assertion, refusal, status code, and boundary those tasks must satisfy **is** stated literally, and the tests are what pin the behavior down.

If phase 1 has landed by the time you execute this plan, consider rewriting Tasks 6 through 8 with literal code against the real signatures before starting them.

---

## Blocking Precondition

As of 2026-08-16, Cave's `main` has **no** `/api/client/v1` surface: `src/app/api/client/` and `src/lib/server/client-v1/` do not exist.

- [ ] **Verify the precondition before writing any code**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
ls src/lib/server/client-v1/ && ls src/app/api/client/v1/
```

Expected: both directories exist and contain the pairing store, credential store, auth, rate limiting, health route, and pairing routes described in the phase-1 plan.

**If either is missing, STOP.** This phase cannot be implemented. Report that iOS Phase C is blocked on desktop Phase 1 (`cave-9pifu`), and do not create a parallel pairing implementation — a second credential path in the same authority is exactly the kind of thing that produces an auth bypass nobody notices.

---

## Working Directory

Cave's `main` is a live, busy checkout. Work in a dedicated worktree:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
git worktree add -b feat/ios-phase-c-enrollment .worktrees/ios-phase-c-enrollment origin/main
```

Confirm no other session holds Cave checkouts first:

```bash
ps -ef | grep ' claude' | grep -v grep | awk '{print $2}' | while read pid; do
  lsof -p $pid 2>/dev/null | awk '$4=="cwd"{print $9}'
done | grep coven-cave || echo "clear"
```

As of 2026-08-16 there was a live session in `coven-cave/.worktrees/cave-j80ph-bui-badge-contrast`. A different worktree is fine; the same one is not.

---

## Critical Rules

- **Every commit signed.** Pass `-S`. Verify `git config --get user.signingkey` first.
- **Do not push.**
- **No emojis** in commits or code.
- **Design tokens only in components.** Cave enforces this with `pnpm codemod:design:check`. Raw hex colors and ad-hoc spacing will fail the build.
- **Colocated tests are `.test.ts`**, even for components, matching Cave's existing convention.
- **Every new test file must be wired.** `pnpm check:tests-wired` fails otherwise.

---

## File Map

- Create `src/lib/server/client-v1/overlay-probe.ts` and `overlay-probe.test.ts` — detect Tailscale, report state.
- Create `src/lib/server/client-v1/reachability.ts` and `reachability.test.ts` — bounded self-verification.
- Create `src/lib/server/client-v1/enrollment-payload.ts` and `enrollment-payload.test.ts` — build and encode the QR payload.
- Create `src/lib/server/client-v1/device-store.ts` and `device-store.test.ts` — push device registrations.
- Create `src/app/api/client/v1/admin/enrollment/overlay/route.ts` and test.
- Create `src/app/api/client/v1/admin/enrollment/verify/route.ts` and test.
- Create `src/app/api/client/v1/admin/enrollment/qr/route.ts` and test.
- Create `src/app/api/client/v1/push/devices/route.ts` and test.
- Create `src/app/api/client/v1/push/devices/[id]/route.ts` and test.
- Create `src/components/settings-phone-enrollment.tsx` and test.
- Modify `src/components/settings-sections.ts` — register the new section.
- Modify `src/lib/server/client-v1/credential-store.ts` — cascade device removal on revocation.
- Modify `scripts/run-tests.mjs` — wire the new test files.

---

## Task 1: Overlay Probe

Cave answers one question: is there an overlay on this host that a phone could reach us through, and if not, what is missing?

**Files:**
- Create: `src/lib/server/client-v1/overlay-probe.ts`
- Create: `src/lib/server/client-v1/overlay-probe.test.ts`
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Write the failing test**

Create `src/lib/server/client-v1/overlay-probe.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyTailscaleStatus, type OverlayState } from "./overlay-probe.ts";

test("a running, logged-in tailnet reports its DNS name", () => {
  const status = {
    BackendState: "Running",
    Self: { DNSName: "cave-host.tailnet-abc.ts.net.", Online: true },
  };
  const state: OverlayState = classifyTailscaleStatus(JSON.stringify(status));
  assert.equal(state.kind, "ready");
  assert.equal(state.kind === "ready" ? state.hostname : null, "cave-host.tailnet-abc.ts.net");
});

test("a stopped backend reports needs-start rather than absent", () => {
  const status = { BackendState: "Stopped", Self: { DNSName: "x.ts.net.", Online: false } };
  assert.equal(classifyTailscaleStatus(JSON.stringify(status)).kind, "needs-start");
});

test("a logged-out backend reports needs-login", () => {
  const status = { BackendState: "NeedsLogin", Self: {} };
  assert.equal(classifyTailscaleStatus(JSON.stringify(status)).kind, "needs-login");
});

test("running without a DNS name is not ready", () => {
  const status = { BackendState: "Running", Self: { Online: true } };
  const state = classifyTailscaleStatus(JSON.stringify(status));
  assert.notEqual(state.kind, "ready");
});

test("unparseable output reports absent instead of throwing", () => {
  assert.equal(classifyTailscaleStatus("command not found").kind, "absent");
  assert.equal(classifyTailscaleStatus("").kind, "absent");
});

test("a hostile status payload cannot inject a non-string hostname", () => {
  const status = { BackendState: "Running", Self: { DNSName: { evil: true }, Online: true } };
  assert.notEqual(classifyTailscaleStatus(JSON.stringify(status)).kind, "ready");
});
```

- [ ] **Step 2: Wire the test file**

In `scripts/run-tests.mjs`, add `src/lib/server/client-v1/overlay-probe.test.ts` to the `api` suite's file list, alongside the other `client-v1` tests added by phase 1.

- [ ] **Step 3: Run the test to confirm it fails**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test src/lib/server/client-v1/overlay-probe.test.ts
```

Expected: FAIL — cannot resolve `./overlay-probe.ts`.

- [ ] **Step 4: Implement the probe**

Create `src/lib/server/client-v1/overlay-probe.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** How long the probe waits for the overlay CLI before giving up. */
const PROBE_TIMEOUT_MS = 3_000;

/** Bound on CLI output; a status payload is a few KiB at most. */
const PROBE_MAX_BUFFER = 256 * 1024;

/**
 * What the host's overlay looks like right now.
 *
 * The distinctions matter because each one is a different instruction to the
 * user. "Install it", "start it", and "log in" are not interchangeable.
 */
export type OverlayState =
  | { kind: "ready"; hostname: string }
  | { kind: "needs-start" }
  | { kind: "needs-login" }
  | { kind: "absent" };

/**
 * Classify `tailscale status --json` output.
 *
 * Separated from process execution so the interesting logic is testable
 * without a Tailscale installation.
 */
export function classifyTailscaleStatus(raw: string): OverlayState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "absent" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "absent" };
  }

  const status = parsed as { BackendState?: unknown; Self?: unknown };
  const backendState =
    typeof status.BackendState === "string" ? status.BackendState : "";

  if (backendState === "NeedsLogin" || backendState === "NoState") {
    return { kind: "needs-login" };
  }
  if (backendState !== "Running") {
    return { kind: "needs-start" };
  }

  const self = (typeof status.Self === "object" && status.Self !== null
    ? status.Self
    : {}) as { DNSName?: unknown };

  // Reject anything that is not a plain string: this value ends up in an
  // enrollment payload, and a non-string here means the input is not what we
  // think it is.
  if (typeof self.DNSName !== "string" || self.DNSName.length === 0) {
    return { kind: "needs-start" };
  }

  // Tailscale reports a fully-qualified name with a trailing dot.
  const hostname = self.DNSName.replace(/\.$/, "");
  if (hostname.length === 0) {
    return { kind: "needs-start" };
  }
  return { kind: "ready", hostname };
}

/**
 * Ask the host whether a usable overlay exists.
 *
 * Never throws: an absent binary, a non-zero exit, and a timeout are all
 * legitimate answers meaning "no overlay we can use", and the caller turns
 * them into user-facing guidance.
 */
export async function probeOverlay(): Promise<OverlayState> {
  try {
    const { stdout } = await execFileAsync("tailscale", ["status", "--json"], {
      timeout: PROBE_TIMEOUT_MS,
      maxBuffer: PROBE_MAX_BUFFER,
    });
    return classifyTailscaleStatus(stdout);
  } catch {
    return { kind: "absent" };
  }
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Repeat the command from Step 3.

Expected: PASS, 6 tests.

- [ ] **Step 6: Confirm test wiring**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave && pnpm check:tests-wired
```

Expected: pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
git add src/lib/server/client-v1/overlay-probe.ts src/lib/server/client-v1/overlay-probe.test.ts scripts/run-tests.mjs
git commit -S -m "Add overlay probe to Cave client v1

Distinguishes absent, needs-start, needs-login, and ready, because each is a
different instruction to the user. Classification is separated from process
execution so it is testable without a Tailscale installation."
```

---

## Task 2: Reachability Self-Verification

The point of this phase. Cave must not hand out a QR code for an address it has not proven reaches *itself*.

**Files:**
- Create: `src/lib/server/client-v1/reachability.ts`
- Create: `src/lib/server/client-v1/reachability.test.ts`
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Write the failing test**

Create `src/lib/server/client-v1/reachability.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyReachability, isCandidateHostnameAllowed } from "./reachability.ts";

const OURS = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

test("a health response from this instance verifies", () => {
  const body = JSON.stringify({ ok: true, service: "coven-cave", instanceId: OURS });
  assert.equal(classifyReachability(200, body, OURS).kind, "verified");
});

test("a different Cave instance is reported as the wrong instance", () => {
  const body = JSON.stringify({ ok: true, service: "coven-cave", instanceId: "other" });
  const result = classifyReachability(200, body, OURS);
  assert.equal(result.kind, "wrong-instance");
});

test("a non-Cave service is reported as such", () => {
  assert.equal(classifyReachability(200, "welcome to nginx", OURS).kind, "not-cave");
  assert.equal(classifyReachability(200, JSON.stringify({ hello: 1 }), OURS).kind, "not-cave");
});

test("a non-200 status is unreachable, not verified", () => {
  const body = JSON.stringify({ ok: true, service: "coven-cave", instanceId: OURS });
  assert.equal(classifyReachability(502, body, OURS).kind, "unreachable");
});

test("an empty instance id never verifies", () => {
  const body = JSON.stringify({ ok: true, service: "coven-cave", instanceId: "" });
  assert.equal(classifyReachability(200, body, "").kind, "not-cave");
});

test("candidate hostnames must be plausible hostnames", () => {
  assert.equal(isCandidateHostnameAllowed("cave.tailnet-abc.ts.net"), true);
  assert.equal(isCandidateHostnameAllowed("cave.example.com"), true);
  assert.equal(isCandidateHostnameAllowed("100.64.0.1"), true);
  assert.equal(isCandidateHostnameAllowed(""), false);
  assert.equal(isCandidateHostnameAllowed("has space"), false);
  assert.equal(isCandidateHostnameAllowed("http://embedded-scheme"), false);
  assert.equal(isCandidateHostnameAllowed("host/with/path"), false);
  assert.equal(isCandidateHostnameAllowed("host:1234"), false);
  assert.equal(isCandidateHostnameAllowed("a".repeat(300)), false);
});
```

- [ ] **Step 2: Wire the test file**

Add `src/lib/server/client-v1/reachability.test.ts` to the `api` suite in `scripts/run-tests.mjs`.

- [ ] **Step 3: Run the test to confirm it fails**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test src/lib/server/client-v1/reachability.test.ts
```

Expected: FAIL — cannot resolve `./reachability.ts`.

- [ ] **Step 4: Implement verification**

Create `src/lib/server/client-v1/reachability.ts`:

```ts
/**
 * Prove that a candidate address actually reaches this Cave instance.
 *
 * Cave makes one bounded outbound request to a user-supplied address. That is
 * a request-forgery shape, so it is constrained deliberately: no redirects,
 * a short timeout, a capped body, and a result that is only ever a
 * classification. The response body is never surfaced to the caller, so this
 * cannot be used to read internal endpoints.
 */

/** Overall budget for one verification attempt. */
const VERIFY_TIMEOUT_MS = 5_000;

/** Cap on the body we will read. A health payload is a few hundred bytes. */
const VERIFY_MAX_BYTES = 64 * 1024;

/** Longest hostname we will attempt. */
const MAX_HOSTNAME_LENGTH = 253;

/** What a verification attempt concluded. */
export type Reachability =
  | { kind: "verified" }
  | { kind: "wrong-instance" }
  | { kind: "not-cave" }
  | { kind: "unreachable"; detail: string };

/**
 * Whether a candidate hostname is shaped like a hostname.
 *
 * Rejects schemes, paths, ports, and whitespace so the value cannot smuggle a
 * different target into the URL we build. This is a syntax gate, not an
 * allowlist: reaching a private address is the entire point, so filtering
 * private ranges would defeat the feature.
 */
export function isCandidateHostnameAllowed(hostname: string): boolean {
  if (hostname.length === 0 || hostname.length > MAX_HOSTNAME_LENGTH) {
    return false;
  }
  return /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/.test(
    hostname,
  );
}

/**
 * Decide what a health response means, given our own instance id.
 *
 * Separated from the network call so every branch is testable without a
 * server.
 */
export function classifyReachability(
  status: number,
  body: string,
  ownInstanceId: string,
): Reachability {
  if (status !== 200) {
    return { kind: "unreachable", detail: `responded with status ${status}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { kind: "not-cave" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "not-cave" };
  }

  const health = parsed as { service?: unknown; instanceId?: unknown };
  if (health.service !== "coven-cave") {
    return { kind: "not-cave" };
  }
  if (typeof health.instanceId !== "string" || health.instanceId.length === 0) {
    return { kind: "not-cave" };
  }
  if (ownInstanceId.length === 0) {
    return { kind: "not-cave" };
  }
  if (health.instanceId !== ownInstanceId) {
    // Reachable, but it is a different Cave. Enrolling against this address
    // would pair the phone to somebody else's instance.
    return { kind: "wrong-instance" };
  }
  return { kind: "verified" };
}

/**
 * Attempt to reach ourselves at a candidate address.
 */
export async function verifyReachable(
  hostname: string,
  port: number,
  useTls: boolean,
  ownInstanceId: string,
): Promise<Reachability> {
  if (!isCandidateHostnameAllowed(hostname)) {
    return { kind: "unreachable", detail: "the address is not a valid hostname" };
  }
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return { kind: "unreachable", detail: "the port is out of range" };
  }

  const scheme = useTls ? "https" : "http";
  const url = `${scheme}://${hostname}:${port}/api/client/v1/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      // A redirect would take us somewhere we did not choose.
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });

    const reader = response.body?.getReader();
    let body = "";
    if (reader) {
      const decoder = new TextDecoder();
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > VERIFY_MAX_BYTES) {
          await reader.cancel();
          return { kind: "not-cave" };
        }
        body += decoder.decode(value, { stream: true });
      }
    }
    return classifyReachability(response.status, body, ownInstanceId);
  } catch (error) {
    // The detail is generic on purpose: a precise network error from a
    // user-supplied address is a probing oracle.
    return { kind: "unreachable", detail: "no response from that address" };
  } finally {
    clearTimeout(timer);
  }
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Repeat the command from Step 3.

Expected: PASS, 6 tests.

- [ ] **Step 6: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
git add src/lib/server/client-v1/reachability.ts src/lib/server/client-v1/reachability.test.ts scripts/run-tests.mjs
git commit -S -m "Add reachability self-verification to Cave client v1

Cave proves a candidate address reaches this instance by comparing the returned
instanceId to its own, so a reachable-but-different Cave is caught rather than
enrolled against. The outbound request is bounded, refuses redirects, and never
surfaces the response body."
```

---

## Task 3: The Enrollment Payload

Everything a phone needs, in one scan.

**Files:**
- Create: `src/lib/server/client-v1/enrollment-payload.ts`
- Create: `src/lib/server/client-v1/enrollment-payload.test.ts`
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Write the failing test**

Create `src/lib/server/client-v1/enrollment-payload.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildEnrollmentPayload,
  decodeEnrollmentUri,
  encodeEnrollmentUri,
  type EnrollmentPayload,
} from "./enrollment-payload.ts";

const BASE = {
  instanceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  pairingRequestId: "pair-1",
  pairingSecret: "s3cret",
  expiresAt: 1_786_406_405_000,
  candidates: [
    { host: "cave.tailnet-abc.ts.net", port: 7777, tls: false as const },
    { host: "cave.example.com", port: 8443, tls: true as const, pinSha256: "aa".repeat(32) },
  ],
};

test("builds a versioned payload preserving candidate order", () => {
  const payload = buildEnrollmentPayload(BASE);
  assert.equal(payload.v, 1);
  assert.equal(payload.candidates.length, 2);
  assert.equal(payload.candidates[0].host, "cave.tailnet-abc.ts.net");
  assert.equal(payload.candidates[1].pinSha256, "aa".repeat(32));
});

test("round-trips through the enrollment URI", () => {
  const payload = buildEnrollmentPayload(BASE);
  const decoded = decodeEnrollmentUri(encodeEnrollmentUri(payload));
  assert.deepEqual(decoded, payload);
});

test("the URI uses the app scheme so iOS can route the scan", () => {
  const uri = encodeEnrollmentUri(buildEnrollmentPayload(BASE));
  assert.ok(uri.startsWith("opencoven-chat://enroll?v=1&d="), uri);
});

test("the encoded payload is base64url with no padding", () => {
  const uri = encodeEnrollmentUri(buildEnrollmentPayload(BASE));
  const data = new URL(uri).searchParams.get("d") ?? "";
  assert.ok(/^[A-Za-z0-9_-]+$/.test(data), data.slice(0, 40));
});

test("refuses to build a payload with no candidates", () => {
  assert.throws(() => buildEnrollmentPayload({ ...BASE, candidates: [] }), /candidate/i);
});

test("refuses a TLS candidate without a pin", () => {
  assert.throws(
    () =>
      buildEnrollmentPayload({
        ...BASE,
        candidates: [{ host: "h", port: 443, tls: true }],
      }),
    /pin/i,
  );
});

test("refuses a malformed pin", () => {
  assert.throws(
    () =>
      buildEnrollmentPayload({
        ...BASE,
        candidates: [{ host: "h", port: 443, tls: true, pinSha256: "nothex" }],
      }),
    /pin/i,
  );
});

test("decoding rejects a payload of the wrong version", () => {
  const payload = { ...buildEnrollmentPayload(BASE), v: 2 } as unknown as EnrollmentPayload;
  const uri = encodeEnrollmentUri(payload);
  assert.throws(() => decodeEnrollmentUri(uri), /version/i);
});

test("decoding rejects garbage rather than returning a partial payload", () => {
  assert.throws(() => decodeEnrollmentUri("opencoven-chat://enroll?v=1&d=!!!!"), /payload/i);
  assert.throws(() => decodeEnrollmentUri("https://example.com"), /scheme/i);
});
```

- [ ] **Step 2: Wire the test file and run it**

Add the file to `scripts/run-tests.mjs`, then:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test src/lib/server/client-v1/enrollment-payload.test.ts
```

Expected: FAIL — cannot resolve `./enrollment-payload.ts`.

- [ ] **Step 3: Implement the payload**

Create `src/lib/server/client-v1/enrollment-payload.ts`:

```ts
/**
 * The contents of an enrollment QR code.
 *
 * One scan replaces both "type the address" and the approval round trip: the
 * payload carries every address worth trying, this instance's identity, the
 * certificate pin for any TLS candidate, and a single-use pairing grant.
 */

/** Scheme the iOS app registers so a scanned code routes to it. */
const ENROLLMENT_SCHEME = "opencoven-chat:";

/** Current payload version. Bumped only on a breaking shape change. */
const ENROLLMENT_VERSION = 1;

/** One address a phone may try, in priority order. */
export type EnrollmentCandidate = {
  /** Hostname or IP literal. */
  host: string;
  /** TCP port. */
  port: number;
  /** Whether the phone should speak TLS to this candidate. */
  tls: boolean;
  /** Lowercase hex SHA-256 of the DER certificate. Required when `tls`. */
  pinSha256?: string;
};

/** Everything a phone needs from one scan. */
export type EnrollmentPayload = {
  /** Payload version. */
  v: number;
  /** Cave instance identity, so the phone can detect a swapped instance. */
  instanceId: string;
  /** Pairing request to exchange. */
  pairingRequestId: string;
  /** Single-use pairing secret. */
  pairingSecret: string;
  /** Expiry, epoch milliseconds. */
  expiresAt: number;
  /** Addresses to try, in priority order. */
  candidates: EnrollmentCandidate[];
};

type BuildInput = Omit<EnrollmentPayload, "v">;

const HEX_SHA256 = /^[0-9a-f]{64}$/;

/**
 * Build a payload, rejecting anything a phone could not act on.
 *
 * Validation is here rather than at the route because a payload that is
 * malformed in these ways produces an enrollment that fails after the user has
 * already scanned, which is the worst possible time to discover it.
 */
export function buildEnrollmentPayload(input: BuildInput): EnrollmentPayload {
  if (input.candidates.length === 0) {
    throw new Error("an enrollment payload needs at least one candidate address");
  }
  for (const candidate of input.candidates) {
    if (!candidate.tls) continue;
    const pin = candidate.pinSha256;
    if (typeof pin !== "string" || !HEX_SHA256.test(pin)) {
      throw new Error(
        `TLS candidate ${candidate.host} needs a 64-character hex SHA-256 pin`,
      );
    }
  }
  return { v: ENROLLMENT_VERSION, ...input };
}

/** Encode a payload as a scannable URI. */
export function encodeEnrollmentUri(payload: EnrollmentPayload): string {
  const json = JSON.stringify(payload);
  const data = Buffer.from(json, "utf8").toString("base64url");
  return `${ENROLLMENT_SCHEME}//enroll?v=${payload.v}&d=${data}`;
}

/**
 * Decode a scanned URI.
 *
 * Throws rather than returning a partial payload: a half-understood
 * enrollment is not something to proceed with.
 */
export function decodeEnrollmentUri(uri: string): EnrollmentPayload {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new Error("enrollment payload is not a valid URI");
  }
  if (parsed.protocol !== ENROLLMENT_SCHEME) {
    throw new Error(`unexpected enrollment scheme ${parsed.protocol}`);
  }

  const data = parsed.searchParams.get("d");
  if (!data || !/^[A-Za-z0-9_-]+$/.test(data)) {
    throw new Error("enrollment payload is missing or not base64url");
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
  } catch {
    throw new Error("enrollment payload did not decode to JSON");
  }
  if (typeof decoded !== "object" || decoded === null) {
    throw new Error("enrollment payload was not an object");
  }

  const payload = decoded as EnrollmentPayload;
  if (payload.v !== ENROLLMENT_VERSION) {
    throw new Error(`unsupported enrollment payload version ${String(payload.v)}`);
  }
  if (!Array.isArray(payload.candidates) || payload.candidates.length === 0) {
    throw new Error("enrollment payload had no candidates");
  }
  return payload;
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Repeat the command from Step 2.

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
git add src/lib/server/client-v1/enrollment-payload.ts src/lib/server/client-v1/enrollment-payload.test.ts scripts/run-tests.mjs
git commit -S -m "Add enrollment payload encoding to Cave client v1

One scan carries every candidate address, the instance identity, TLS pins, and
a single-use grant. Validation rejects a TLS candidate without a pin at build
time rather than after the user has already scanned."
```

---

## Task 4: Push Device Registration Store

Cave records where to send a doorbell. Nothing sends one until Phase G.

**Files:**
- Create: `src/lib/server/client-v1/device-store.ts`
- Create: `src/lib/server/client-v1/device-store.test.ts`
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Write the failing test**

Create `src/lib/server/client-v1/device-store.test.ts`:

```ts
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDeviceStore } from "./device-store.ts";

function store() {
  const dir = mkdtempSync(join(tmpdir(), "cave-device-store-"));
  return { dir, store: createDeviceStore(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("registers a device and reads it back", () => {
  const { store: s, cleanup } = store();
  try {
    s.register({ credentialId: "cred-1", topicId: "topic-1", pushSecret: "secret-1" }, 1_000);
    const devices = s.listForCredential("cred-1");
    assert.equal(devices.length, 1);
    assert.equal(devices[0].topicId, "topic-1");
    assert.equal(devices[0].registeredAt, 1_000);
  } finally {
    cleanup();
  }
});

test("re-registering the same topic replaces rather than duplicates", () => {
  const { store: s, cleanup } = store();
  try {
    s.register({ credentialId: "cred-1", topicId: "topic-1", pushSecret: "old" }, 1_000);
    s.register({ credentialId: "cred-1", topicId: "topic-1", pushSecret: "new" }, 2_000);
    const devices = s.listForCredential("cred-1");
    assert.equal(devices.length, 1);
    assert.equal(devices[0].pushSecret, "new");
    assert.equal(devices[0].registeredAt, 2_000);
  } finally {
    cleanup();
  }
});

test("devices are scoped to their credential", () => {
  const { store: s, cleanup } = store();
  try {
    s.register({ credentialId: "cred-1", topicId: "t1", pushSecret: "x" }, 1);
    s.register({ credentialId: "cred-2", topicId: "t2", pushSecret: "y" }, 1);
    assert.equal(s.listForCredential("cred-1").length, 1);
    assert.equal(s.listForCredential("cred-1")[0].topicId, "t1");
  } finally {
    cleanup();
  }
});

test("revoking a credential removes its devices", () => {
  const { store: s, cleanup } = store();
  try {
    s.register({ credentialId: "cred-1", topicId: "t1", pushSecret: "x" }, 1);
    s.register({ credentialId: "cred-2", topicId: "t2", pushSecret: "y" }, 1);
    s.removeForCredential("cred-1");
    assert.equal(s.listForCredential("cred-1").length, 0);
    assert.equal(s.listForCredential("cred-2").length, 1);
  } finally {
    cleanup();
  }
});

test("registrations survive a restart", () => {
  const { dir, store: s, cleanup } = store();
  try {
    s.register({ credentialId: "cred-1", topicId: "t1", pushSecret: "x" }, 1);
    const reopened = createDeviceStore(dir);
    assert.equal(reopened.listForCredential("cred-1").length, 1);
  } finally {
    cleanup();
  }
});

test("a specific device can be removed by topic", () => {
  const { store: s, cleanup } = store();
  try {
    s.register({ credentialId: "cred-1", topicId: "t1", pushSecret: "x" }, 1);
    s.register({ credentialId: "cred-1", topicId: "t2", pushSecret: "y" }, 1);
    assert.equal(s.remove("cred-1", "t1"), true);
    assert.equal(s.remove("cred-1", "t1"), false);
    const remaining = s.listForCredential("cred-1");
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].topicId, "t2");
  } finally {
    cleanup();
  }
});

test("a device cannot be removed through another credential", () => {
  const { store: s, cleanup } = store();
  try {
    s.register({ credentialId: "cred-1", topicId: "t1", pushSecret: "x" }, 1);
    assert.equal(s.remove("cred-2", "t1"), false);
    assert.equal(s.listForCredential("cred-1").length, 1);
  } finally {
    cleanup();
  }
});
```

- [ ] **Step 2: Wire the test file and run it**

Add the file to `scripts/run-tests.mjs`, then:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test src/lib/server/client-v1/device-store.test.ts
```

Expected: FAIL — cannot resolve `./device-store.ts`.

- [ ] **Step 3: Implement the store**

Create `src/lib/server/client-v1/device-store.ts`:

```ts
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Where to send a doorbell for a paired phone.
 *
 * Unlike bearer tokens, which the credential store keeps only as hashes, the
 * push secret is stored recoverably: Cave is the party that signs pings with
 * it, so a hash would be useless. The file is written 0600 under Cave home,
 * the same posture as the credential store.
 */
export type DeviceRegistration = {
  /** The credential this device belongs to. */
  credentialId: string;
  /** Opaque topic the relay maps to an APNs token. Cave never sees the token. */
  topicId: string;
  /** Secret used to sign pings to the relay for this topic. */
  pushSecret: string;
  /** Registration time, epoch milliseconds. */
  registeredAt: number;
};

type StoredShape = { version: 1; devices: DeviceRegistration[] };

const FILE_NAME = "client-v1-devices.json";
const FILE_MODE = 0o600;

/** A device store rooted at a directory, typically Cave home. */
export type DeviceStore = {
  register(
    input: Omit<DeviceRegistration, "registeredAt">,
    now: number,
  ): DeviceRegistration;
  listForCredential(credentialId: string): DeviceRegistration[];
  remove(credentialId: string, topicId: string): boolean;
  removeForCredential(credentialId: string): void;
};

function read(path: string): StoredShape {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as StoredShape).devices)
    ) {
      return parsed as StoredShape;
    }
  } catch {
    // A missing or unreadable file means no registrations yet. A corrupt file
    // is replaced on next write rather than crashing Cave's startup.
  }
  return { version: 1, devices: [] };
}

function write(path: string, value: StoredShape): void {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: FILE_MODE });
  chmodSync(temporary, FILE_MODE);
  // Atomic replacement, so a crash mid-write cannot leave a truncated file.
  renameSync(temporary, path);
}

/** Open, or create, the device store under a directory. */
export function createDeviceStore(directory: string): DeviceStore {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, FILE_NAME);

  return {
    register(input, now) {
      const stored = read(path);
      const registration: DeviceRegistration = { ...input, registeredAt: now };
      const devices = stored.devices.filter(
        (device) =>
          !(
            device.credentialId === input.credentialId &&
            device.topicId === input.topicId
          ),
      );
      devices.push(registration);
      write(path, { version: 1, devices });
      return registration;
    },

    listForCredential(credentialId) {
      return read(path).devices.filter(
        (device) => device.credentialId === credentialId,
      );
    },

    remove(credentialId, topicId) {
      const stored = read(path);
      const devices = stored.devices.filter(
        (device) =>
          !(device.credentialId === credentialId && device.topicId === topicId),
      );
      if (devices.length === stored.devices.length) {
        return false;
      }
      write(path, { version: 1, devices });
      return true;
    },

    removeForCredential(credentialId) {
      const stored = read(path);
      const devices = stored.devices.filter(
        (device) => device.credentialId !== credentialId,
      );
      if (devices.length !== stored.devices.length) {
        write(path, { version: 1, devices });
      }
    },
  };
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Repeat the command from Step 2.

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
git add src/lib/server/client-v1/device-store.ts src/lib/server/client-v1/device-store.test.ts scripts/run-tests.mjs
git commit -S -m "Add push device registration store to Cave client v1

Stores the push secret recoverably because Cave signs pings with it, unlike
bearer tokens which stay hashed. Written 0600 with atomic replacement, scoped
per credential, and removable in bulk when a credential is revoked."
```

---

## Task 5: Cascade Device Removal on Revocation

A revoked credential that still receives doorbells is a leak.

**Files:**
- Modify: `src/lib/server/client-v1/credential-store.ts`
- Modify: `src/lib/server/client-v1/credential-store.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/server/client-v1/credential-store.test.ts`:

```ts
test("revoking a credential also removes its push devices", () => {
  const { credentials, devices, cleanup } = createStoresForTest();
  try {
    const credential = credentials.create(
      { appName: "OpenCoven Chat", installationId: "i1", scopes: ["chat:read"] },
      1_000,
    );
    devices.register(
      { credentialId: credential.id, topicId: "t1", pushSecret: "x" },
      1_000,
    );
    assert.equal(devices.listForCredential(credential.id).length, 1);

    credentials.revoke(credential.id, 2_000);

    assert.equal(
      devices.listForCredential(credential.id).length,
      0,
      "a revoked credential must not keep receiving doorbells",
    );
  } finally {
    cleanup();
  }
});
```

Add a `createStoresForTest` helper to that file that builds a credential store and a device store over the same temporary directory, matching how the phase-1 tests construct the credential store.

- [ ] **Step 2: Run the test to confirm it fails**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test src/lib/server/client-v1/credential-store.test.ts
```

Expected: FAIL — the device survives revocation.

- [ ] **Step 3: Wire the cascade**

In `src/lib/server/client-v1/credential-store.ts`, accept an optional revocation listener when the store is created, and call it inside `revoke` after the credential is persisted:

```ts
/**
 * Called after a credential is revoked, so dependent state can be dropped.
 *
 * Push devices register against a credential; leaving them behind would mean
 * a revoked client still gets woken up.
 */
export type RevocationListener = (credentialId: string) => void;
```

Register the device store's `removeForCredential` as that listener wherever Cave constructs the credential store, so the cascade is wired once rather than at each call site.

- [ ] **Step 4: Run the test to confirm it passes**

Repeat the command from Step 2.

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
git add src/lib/server/client-v1/credential-store.ts src/lib/server/client-v1/credential-store.test.ts
git commit -S -m "Drop push devices when a credential is revoked

A revoked client that still receives doorbells is a leak. The cascade is wired
where the stores are constructed so it cannot be forgotten at a call site."
```

---

## Task 6: Enrollment Admin Routes

Three admin endpoints backing the wizard. These are admin routes, so per the phase-1 boundary they do **not** use the client bearer bypass.

**Files:**
- Create: `src/app/api/client/v1/admin/enrollment/overlay/route.ts` and `route.test.ts`
- Create: `src/app/api/client/v1/admin/enrollment/verify/route.ts` and `route.test.ts`
- Create: `src/app/api/client/v1/admin/enrollment/qr/route.ts` and `route.test.ts`
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Write the failing route tests**

Each test file asserts, following the structure the phase-1 route tests already use in this repository:

`overlay/route.test.ts`:
- `GET` returns `{ ok: true, overlay: { kind: "absent" } }` when the probe reports absent.
- `GET` returns the hostname when the probe reports ready.
- A non-loopback request is rejected, matching the admin boundary.

`verify/route.test.ts`:
- `POST` with `{ host, port, tls }` returns `{ ok: true, reachability: { kind: "verified" } }` when verification succeeds.
- `POST` returns `wrong-instance` unchanged when another Cave answers.
- `POST` with a malformed hostname returns a 400 with the stable error envelope and never performs an outbound request.
- `POST` is rate limited to 10 attempts per minute, so the endpoint is not a scanner.

`qr/route.test.ts`:
- `POST` with verified candidates returns `{ ok: true, uri, expiresAt }` and the URI decodes back to a payload containing this instance's id.
- `POST` mints exactly one pairing request through the existing pairing store, and the returned secret matches it.
- `POST` **refuses** when no candidate has been verified in this session, returning a 409 with code `enrollment_unverified`.
- `POST` refuses a TLS candidate with no pin, returning a 400.

- [ ] **Step 2: Wire the test files and run them**

Add all three to `scripts/run-tests.mjs`, then:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test \
  src/app/api/client/v1/admin/enrollment/overlay/route.test.ts \
  src/app/api/client/v1/admin/enrollment/verify/route.test.ts \
  src/app/api/client/v1/admin/enrollment/qr/route.test.ts
```

Expected: FAIL — the route modules do not exist.

- [ ] **Step 3: Implement the routes**

Each route follows the handler shape phase 1 established for `/api/client/v1` routes, including the stable error envelope from the contract:

```ts
{ ok: false, error: { code: string, message: string, retryable: boolean } }
```

- `GET /api/client/v1/admin/enrollment/overlay` calls `probeOverlay()` and returns the state verbatim.
- `POST /api/client/v1/admin/enrollment/verify` validates the body, calls `verifyReachable(host, port, tls, ownInstanceId)`, records a successful `(host, port, tls)` triple as verified for this Cave process, and returns the classification.
- `POST /api/client/v1/admin/enrollment/qr` accepts the ordered candidate list, checks every candidate against the verified set, mints a pairing request through the phase-1 pairing store, builds the payload with `buildEnrollmentPayload`, and returns `encodeEnrollmentUri(payload)`.

The verified set is process-local and expires with the pairing request. **The refusal in the third bullet is the point of the whole phase** — without it, Cave hands out QR codes for addresses it never confirmed, which is exactly the failure mode the design set out to remove.

- [ ] **Step 4: Run the tests to confirm they pass**

Repeat the command from Step 2.

Expected: PASS.

- [ ] **Step 5: Run the API suite**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave && pnpm test:api
```

Expected: pass, with no regression in the phase-1 pairing tests.

- [ ] **Step 6: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
git add src/app/api/client/v1/admin/enrollment/ scripts/run-tests.mjs
git commit -S -m "Add enrollment admin routes to Cave client v1

Cave refuses to mint an enrollment QR for an address it has not verified
reaches this instance, which is what turns a failed connection into a
diagnosis instead of a timeout."
```

---

## Task 7: Push Device Routes

**Files:**
- Create: `src/app/api/client/v1/push/devices/route.ts` and `route.test.ts`
- Create: `src/app/api/client/v1/push/devices/[id]/route.ts` and `route.test.ts`
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Write the failing tests**

`devices/route.test.ts`:
- `POST` with a valid bearer and `{ topicId, pushSecret }` registers a device against that credential and returns `{ ok: true }`.
- `POST` without a bearer returns 401 with the stable envelope.
- `POST` from a credential lacking the required scope returns 403.
- `POST` with a topic id over the length bound returns 400.
- Re-`POST`ing the same topic id replaces rather than duplicating.
- The response **never** echoes `pushSecret`.

`devices/[id]/route.test.ts`:
- `DELETE` removes only the caller's own device and returns `{ ok: true }`.
- `DELETE` of a topic belonging to another credential returns 404, not 403 — an existence oracle across credentials is itself a leak.

- [ ] **Step 2: Wire the tests and run them**

Add both to `scripts/run-tests.mjs`, then run them the same way as Task 6 Step 2.

Expected: FAIL — the route modules do not exist.

- [ ] **Step 3: Implement the routes**

Both routes authenticate through the phase-1 `auth.ts` and are subject to its rate limiting. `POST` bounds `topicId` and `pushSecret` lengths, stores through `createDeviceStore`, and returns only `{ ok: true }`.

- [ ] **Step 4: Run the tests and the API suite**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave && pnpm test:api
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
git add src/app/api/client/v1/push/ scripts/run-tests.mjs
git commit -S -m "Add push device registration routes to Cave client v1

Scoped to the calling credential. Deleting another credential's topic returns
404 rather than 403, because a cross-credential existence oracle is a leak."
```

---

## Task 8: The Enrollment Settings Surface

The wizard the user actually sees: probe, guide, verify, then a QR.

**Files:**
- Create: `src/components/settings-phone-enrollment.tsx`
- Create: `src/components/settings-phone-enrollment.test.ts`
- Modify: `src/components/settings-sections.ts`
- Modify: `scripts/run-tests.mjs`

- [ ] **Step 1: Write the failing component test**

Create `src/components/settings-phone-enrollment.test.ts`, following the structure of the existing `settings-*.test.ts` files in this repository. Assert:

- With overlay state `absent`, the component shows install guidance and a link, and **no QR is offered**.
- With `needs-start`, guidance says to start it — distinct copy from `absent`.
- With `needs-login`, guidance says to log in — distinct copy from both.
- With `ready`, the detected hostname is shown and a verify action is available.
- Before verification succeeds, the QR action is disabled.
- After verification returns `verified`, the QR action is enabled.
- After verification returns `wrong-instance`, the QR action stays disabled and the copy says the address reaches a different Cave.
- The rendered QR is described for assistive technology and the enrollment URI is also available as selectable text, so enrollment is possible without a working camera.

- [ ] **Step 2: Wire the test and run it**

Add the file to the `app` suite in `scripts/run-tests.mjs`, then:

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test src/components/settings-phone-enrollment.test.ts
```

Expected: FAIL — the component does not exist.

- [ ] **Step 3: Implement the component**

Create `src/components/settings-phone-enrollment.tsx` as a four-state wizard driven by the three admin routes. Requirements:

- Design tokens only. `pnpm codemod:design:check` rejects raw hex and ad-hoc spacing.
- Each overlay state gets its own copy and its own action. Do not collapse them into one "something is wrong" message; the whole reason the probe distinguishes them is so the user is told the specific next step.
- The QR action is disabled until verification succeeds for at least one candidate.
- Render the QR client-side from the returned URI so the single-use grant is not written to a server-rendered cache. Add a QR rendering dependency only if Cave does not already have one — check first:

  ```bash
  cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
  node -e "const p=require('./package.json');console.log(Object.keys({...p.dependencies,...p.devDependencies}).filter(d=>/qr/i.test(d)))"
  ```

- Show the enrollment URI as selectable text alongside the QR.
- Show expiry, and re-mint rather than reusing an expired grant.

- [ ] **Step 4: Register the section**

Add the section to `src/components/settings-sections.ts` next to the paired-clients surface phase 1 created, so phones and desktops are managed in one place.

- [ ] **Step 5: Run the component test, the app suite, and the design gates**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
pnpm test:app
pnpm codemod:design:check
pnpm check:ui-consistency
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
git add src/components/settings-phone-enrollment.tsx src/components/settings-phone-enrollment.test.ts src/components/settings-sections.ts scripts/run-tests.mjs
git commit -S -m "Add phone enrollment settings surface to Cave

Each overlay state gets its own copy and next step rather than a generic
failure. The QR stays disabled until Cave has verified an address reaches this
instance, and the URI is available as text so enrollment does not require a
working camera."
```

---

## Task 9: Phase Gate

- [ ] **Step 1: Run the full Cave gates**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
pnpm lint
pnpm typecheck
pnpm test:api
pnpm test:app
pnpm check:tests-wired
```

Expected: all pass.

- [ ] **Step 2: Confirm the enrollment refusal by hand**

With Cave running locally, request a QR for an address that was never verified:

```bash
curl -si -X POST http://127.0.0.1:<port>/api/client/v1/admin/enrollment/qr \
  -H 'content-type: application/json' \
  -d '{"candidates":[{"host":"never-verified.invalid","port":7777,"tls":false}]}'
```

Expected: HTTP 409 with `"code":"enrollment_unverified"`. If a URI comes back instead, the central guarantee of this phase is not in place — stop and fix it.

- [ ] **Step 3: Confirm the wrong-instance path by hand**

Point verification at any reachable non-Cave HTTP service:

```bash
curl -si -X POST http://127.0.0.1:<port>/api/client/v1/admin/enrollment/verify \
  -H 'content-type: application/json' \
  -d '{"host":"example.com","port":80,"tls":false}'
```

Expected: `{"ok":true,"reachability":{"kind":"not-cave"}}`. The response must not contain any part of the remote body.

- [ ] **Step 4: Verify every commit is signed**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
git log origin/main..HEAD --pretty='%H %G?' | awk '$2 != "G" {print "UNSIGNED:", $0}'
```

Expected: no output.

---

## Phase C Completion

Phase C is done when:

- Cave distinguishes absent, needs-start, needs-login, and ready overlay states, each with its own guidance.
- Cave verifies a candidate address reaches **this** instance by instance id, and reports a different Cave as `wrong-instance` rather than success.
- The verification request is bounded, refuses redirects, caps the body, and never surfaces remote content.
- Cave refuses to mint an enrollment QR for an unverified address.
- The QR carries ordered candidates, instance identity, TLS pins, and a single-use grant, and round-trips through encode and decode.
- Push devices register per credential, replace on re-registration, and are dropped when the credential is revoked.
- Enrollment is possible without a camera, via the URI as text.
- `pnpm lint`, `typecheck`, `test:api`, `test:app`, and `check:tests-wired` all pass.
- Every commit is signed. Nothing is pushed.

**Not in this phase, by design:** the relay service, doorbell emission, any Swift, and any client-side enrollment UI.

## Handoff to Phase D

Phase D creates `OpenCoven/chat-ios` and consumes this phase's output: it scans the URI, decodes the payload with the same shape `enrollment-payload.ts` defines, races the candidates through `coven-transport`, exchanges the grant, and stores the bearer in the Keychain.

The enrollment payload shape is now a contract between two repositories. Phase D should assert against the same round-trip vectors this phase's tests use, so a change on either side fails loudly rather than at a user's first scan.
