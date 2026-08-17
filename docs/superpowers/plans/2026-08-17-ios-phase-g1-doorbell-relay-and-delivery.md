# iOS Phase G1: The Doorbell Relay, Emission, and Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A phone that buzzes when a run finishes, a run fails, or a familiar needs a person — through a relay that never learns which Cave called it, never sees a word of content, and whose full compromise reveals only that some phone was pinged.

**Architecture:** A Cloudflare Worker with one Durable Object per topic. The phone registers its APNs token with the relay and gets back an opaque `topic_id` and `push_secret`, which it hands to Cave through the device route Phase C already built. Cave signs a content-free ping to the topic; the relay verifies, rate-limits, and fires an APNs push whose payload bytes are **identical for every ping ever sent**. The phone's notification service extension then fetches the real content from Cave directly over the overlay and rewrites the notification before it is shown.

**Tech Stack:** Cloudflare Workers, Durable Objects with SQLite storage, TypeScript 5.9, Wrangler 4, Vitest with `@cloudflare/vitest-pool-workers`, Swift 6, `UNNotificationServiceExtension`, Node 24 (Cave).

**Depends on:** `2026-08-16-ios-phase-c-enrollment-authority.md` for the device store and routes, and `2026-08-17-ios-phase-f-rich-content-and-actions.md` for the client this notifies into.

**Boundary:** No background refresh, no accessibility audit, no device matrix, no security review. Those are G2. This phase ends when a phone buzzes and shows the right words.

---

## The Hosting Decision

The spec left the relay's platform open, to be decided at the start of this phase. **Decided: Cloudflare Workers with Durable Objects.**

The reasoning, recorded because a future reader will want it:

- The relay's whole job is a keyed lookup and an outbound HTTPS request. There is no long-running work, no large state, and no reason to pay for an idle machine.
- One Durable Object per topic is a natural fit: the coordination atom is a topic, rate-limit state and replay-nonce state both belong beside the registration, and there is no global instance to become a bottleneck.
- Durable Object SQLite gives durable per-topic state without provisioning a database.
- APNs requires an HTTP/2 request to `api.push.apple.com` and an ES256 JWT. Workers' `fetch` speaks HTTP/2 to origins, and WebCrypto signs ES256. No Node runtime is needed.

The cost of the choice: the APNs `.p8` auth key lives in Workers Secrets, and JWT signing runs in WebCrypto rather than a battle-worn Node library. Task 5 covers both.

---

## What the Relay Is Allowed to Know

This list is the phase's real specification. Every task below either implements it or tests it.

| The relay knows | The relay never knows |
|---|---|
| An opaque `topic_id` it generated | Which Cave instance pinged, or its address |
| An APNs device token | Any conversation, turn, familiar, or project |
| A `push_secret` it generated, to verify pings | Any user identity, account, or email |
| That a ping arrived, and when | What the ping was about |
| Per-topic ping counts, for rate limiting | The content of the notification the user sees |

Two consequences that constrain the design:

1. **The APNs payload is a constant.** Not "content-free by convention" — byte-identical for every ping, for every topic, forever. Task 6 asserts it.
2. **The ping body is empty.** Cave sends headers and nothing else. There is no field for a preview to leak into later, because there is no body.

The worst outcome of a total relay compromise is an attacker learning that a device buzzed, and being able to make it buzz again. That is the bar, and it is the reason the relay exists at all rather than the app going without notifications.

---

## Why the Push Is an Alert and Not a Background Wake

The obvious reading of "content-free push" is `content-available: 1` — a silent background wake. That is the wrong mechanism here, and it is worth being explicit about why, because it is the one place this design departs from the naive version of the spec's sentence.

iOS throttles background pushes aggressively and makes no delivery guarantee. A doorbell that arrives an hour late, or not at all, is not a doorbell. Meanwhile the mechanism that *is* reliable — an alert push — normally carries its text in the payload, which is exactly what must not happen.

The resolution is `mutable-content: 1`. The relay sends an alert whose visible text is a localization key, not a sentence. Before iOS shows it, the app's `UNNotificationServiceExtension` runs, fetches canonical content from Cave over the overlay, and rewrites the title and body. If Cave is unreachable, or the fetch runs out of time, the localized placeholder is shown instead and the user gets a buzz that says only that something happened.

So the relay still never sees content, the notification still says something useful, and delivery is as reliable as iOS makes any alert. The cost is a second target that links the Rust core, which Task 9 handles.

---

## Working Directories

```bash
mkdir -p /Users/buns/Documents/GitHub/OpenCoven/chat-relay
cd /Users/buns/Documents/GitHub/OpenCoven/chat-relay
git init

cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
git checkout -b feat/ios-phase-g1-doorbell

cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
git checkout -b feat/ios-phase-g1
```

---

## Critical Rules

- **The APNs payload is a constant.** No value from a ping request may reach it. Task 6's test is the enforcement.
- **The relay logs nothing that identifies a device or a caller.** No device tokens, no secrets, no IP addresses, no request bodies. Counters and error classes only.
- **A ping body is empty.** The route reads headers; it does not parse a body, and it rejects a request that carries one.
- **Signature comparison is constant-time.** A byte-by-byte early return leaks the secret.
- **Emission never blocks a run.** A doorbell that delays a familiar's reply has made the product worse to add a convenience.
- **Doorbells are opt-out, per Cave.** The relay is the only OpenCoven-operated component in the entire design; running without it must remain a supported configuration, not a broken one.
- **Every commit signed.** Pass `-S`. **Do not push.**
- **No emojis** in commits or code.
- **Swift 6 strict concurrency**; the extension is its own actor context and shares no mutable state with the app.

---

## File Map

### chat-relay (new)
- Create `wrangler.jsonc`, `package.json`, `tsconfig.json`, `vitest.config.ts`, `LICENSE`, `README.md`, `PRIVACY.md`.
- Create `src/index.ts` — the Worker: routing and nothing else.
- Create `src/topic.ts` — the `Topic` Durable Object.
- Create `src/signature.ts` — HMAC verification and replay rejection.
- Create `src/apns.ts` — JWT minting and delivery.
- Create `src/limits.ts` — rate-limit policy constants.
- Create `test/topic.test.ts`, `test/worker.test.ts`, `test/privacy.test.ts`, `test/apns.test.ts`.
- Create `.github/workflows/ci.yml`.

### coven-cave
- Create `src/lib/server/client-v1/doorbell.ts` and `doorbell.test.ts`.
- Create `src/lib/server/client-v1/doorbell-emitter.ts` and test.
- Modify `src/lib/server/client-v1/device-store.ts` — failure counters and suspension.
- Modify the run lifecycle and attention emission points.
- Modify `src/app/api/client/v1/push/devices/route.ts`.
- Modify the paired-clients settings surface.

### chat-ios
- Create `app/Sources/Support/PushRegistrar.swift`, `NotificationRouter.swift`.
- Create `extension/NotificationService.swift`, `extension/Info.plist`.
- Modify `app/Sources/ChatApp.swift`, `Support/CaveStore.swift`, `project.yml`, `scripts/build-xcframework.sh`.
- Create `app/Tests/PushRegistrarTests.swift`, `extension/Tests/NotificationServiceTests.swift`.

---

## Task 1: The Relay Repository

**Files:** Create the `chat-relay` scaffold

- [ ] **Step 1: Scaffold**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-relay
npm init -y
npm i -D wrangler@^4 typescript@^5.9 vitest@~3.2.0 @cloudflare/vitest-pool-workers @cloudflare/workers-types
```

Create `wrangler.jsonc`:

```jsonc
{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "chat-relay",
  "main": "src/index.ts",
  "compatibility_date": "2026-08-01",
  "compatibility_flags": ["nodejs_compat"],
  "observability": {
    // Logs are on, but the code writes nothing identifying. See PRIVACY.md.
    "enabled": true,
    "head_sampling_rate": 0.1
  },
  "durable_objects": {
    "bindings": [{ "name": "TOPIC", "class_name": "Topic" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Topic"] }],
  "vars": {
    "APNS_HOST_PRODUCTION": "https://api.push.apple.com",
    "APNS_HOST_SANDBOX": "https://api.sandbox.push.apple.com",
    "APNS_BUNDLE_ID": "ai.opencoven.chat"
  }
}
```

Secrets, set with `wrangler secret put` and never committed: `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY` (the `.p8` contents).

Create `vitest.config.ts`:

```typescript
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: { wrangler: { configPath: "./wrangler.jsonc" } },
    },
  },
});
```

- [ ] **Step 2: Write `PRIVACY.md` before writing any code**

This file is the contract the tests enforce. Writing it first means the implementation is measured against it rather than described by it afterward.

```markdown
# What this service stores and sends

`chat-relay` exists for one reason: Apple accepts pushes only from a provider
holding an auth key tied to a team ID, and that key cannot be handed to
self-hosters without letting anyone push to anyone's installation.

So this service is scoped to the smallest thing that can work.

## Stored, per topic

- A random `topic_id` this service generated.
- An APNs device token, supplied by a device at registration.
- A `push_secret` this service generated, used to verify pings.
- Whether the token is sandbox or production.
- Ping counters and timestamps, for rate limiting.
- Recently seen nonces, for replay rejection, expiring after five minutes.

## Never stored, never received

- The address, hostname, or identity of any Cave instance.
- Any conversation, message, familiar, project, or file.
- Any user identity, account, or email address.
- The text of any notification a user sees.
- Caller IP addresses.

## Sent to Apple

A payload that is byte-identical for every ping this service has ever sent:

    {"aps":{"alert":{"loc-key":"doorbell.placeholder"},"mutable-content":1,"sound":"default","thread-id":"cave"}}

The words a user reads are produced on their own device, by fetching from
their own Cave, after the push arrives. This service does not know them.

## Logs

Counters and error classes. No device tokens, no secrets, no topic ids, no
request bodies, no IP addresses.

## If this service were fully compromised

An attacker would learn that some device was pinged, and could cause devices
to buzz. They would learn nothing about who, what, or from where.
```

- [ ] **Step 3: Commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-relay
git add -A
git commit -S -m "Scaffold the doorbell relay

PRIVACY.md is written before any code, because it is the specification
the tests enforce rather than a description written afterward."
```

---

## Task 2: The Topic Durable Object

One DO per topic. The topic id is a random UUID, so `getByName(topicId)` distributes across the fleet with no global instance and no hot object.

**Files:** Create `src/topic.ts`, `test/topic.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/topic.test.ts`:

```typescript
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const TOKEN = "a".repeat(64);

describe("Topic", () => {
  it("registers a device and returns a secret", async () => {
    const stub = env.TOPIC.getByName(crypto.randomUUID());
    const registration = await stub.register(TOKEN, "production");
    expect(registration.pushSecret).toHaveLength(64);
    expect(await stub.isRegistered()).toBe(true);
  });

  it("refuses a second registration on an existing topic", async () => {
    // A topic is minted per device. Re-registering into one would let anyone
    // who learned a topic id redirect its pushes to their own device.
    const stub = env.TOPIC.getByName(crypto.randomUUID());
    await stub.register(TOKEN, "production");
    await expect(stub.register("b".repeat(64), "production")).rejects.toThrow(/already registered/);
  });

  it("refuses a malformed device token", async () => {
    const stub = env.TOPIC.getByName(crypto.randomUUID());
    await expect(stub.register("not-hex", "production")).rejects.toThrow(/device token/);
  });

  it("an unregistered topic accepts no pings", async () => {
    const stub = env.TOPIC.getByName(crypto.randomUUID());
    const outcome = await stub.ping({ signature: "x", timestamp: Date.now(), nonce: "n" });
    expect(outcome.kind).toBe("unknown-topic");
  });

  it("rejects a ping whose signature does not verify", async () => {
    const stub = env.TOPIC.getByName(crypto.randomUUID());
    await stub.register(TOKEN, "production");
    const outcome = await stub.ping({ signature: "00".repeat(32), timestamp: Date.now(), nonce: "n1" });
    expect(outcome.kind).toBe("bad-signature");
  });

  it("rejects a replayed nonce", async () => {
    const topicId = crypto.randomUUID();
    const stub = env.TOPIC.getByName(topicId);
    const { pushSecret } = await stub.register(TOKEN, "production");
    const first = await signedPing(topicId, pushSecret, "n1");
    expect((await stub.ping(first)).kind).toBe("accepted");
    expect((await stub.ping(first)).kind).toBe("replay");
  });

  it("rejects a ping outside the timestamp window", async () => {
    const topicId = crypto.randomUUID();
    const stub = env.TOPIC.getByName(topicId);
    const { pushSecret } = await stub.register(TOKEN, "production");
    const stale = await signedPing(topicId, pushSecret, "n2", Date.now() - 10 * 60_000);
    expect((await stub.ping(stale)).kind).toBe("stale");
  });

  it("rate-limits a burst", async () => {
    const topicId = crypto.randomUUID();
    const stub = env.TOPIC.getByName(topicId);
    const { pushSecret } = await stub.register(TOKEN, "production");
    const outcomes = [];
    for (let index = 0; index < 10; index += 1) {
      outcomes.push(await stub.ping(await signedPing(topicId, pushSecret, `burst-${index}`)));
    }
    expect(outcomes.filter((o) => o.kind === "accepted").length).toBeLessThanOrEqual(BURST);
    expect(outcomes.at(-1)?.kind).toBe("rate-limited");
  });

  it("forgets a device when Apple reports it unregistered", async () => {
    const topicId = crypto.randomUUID();
    const stub = env.TOPIC.getByName(topicId);
    await stub.register(TOKEN, "production");
    await stub.forget("unregistered");
    expect(await stub.isRegistered()).toBe(false);
  });

  it("isolates topics from each other", async () => {
    const a = env.TOPIC.getByName(crypto.randomUUID());
    const b = env.TOPIC.getByName(crypto.randomUUID());
    await a.register(TOKEN, "production");
    expect(await b.isRegistered()).toBe(false);
  });
});
```

with a `signedPing` helper that computes the same HMAC the relay expects, and `BURST` imported from `src/limits.ts`.

- [ ] **Step 2: Verify the tests fail**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-relay
npx vitest run test/topic.test.ts
```

Expected: FAIL — no `Topic` class.

- [ ] **Step 3: Implement the limits**

Create `src/limits.ts`:

```typescript
/**
 * Rate limits, per topic.
 *
 * A doorbell is an interruption. These numbers are set by what a person can
 * tolerate, not by what the platform can serve: a Cave that wants to ping
 * forty times an hour is misconfigured, and the relay refusing is the correct
 * outcome rather than a limitation.
 */

/** Pings allowed in an immediate burst. */
export const BURST = 5;

/** Seconds to earn back one burst slot. */
export const REFILL_SECONDS = 10;

/** Hard ceiling per topic per rolling day, regardless of refill. */
export const DAILY_CEILING = 200;

/** How far a ping's timestamp may be from ours, in seconds, either way. */
export const CLOCK_SKEW_SECONDS = 300;

/** How long a nonce is remembered, in seconds. Matches the skew window. */
export const NONCE_TTL_SECONDS = 300;
```

- [ ] **Step 4: Implement the Durable Object**

Create `src/topic.ts`:

```typescript
import { DurableObject } from "cloudflare:workers";
import { BURST, CLOCK_SKEW_SECONDS, DAILY_CEILING, NONCE_TTL_SECONDS, REFILL_SECONDS } from "./limits";
import { verifySignature } from "./signature";
import { deliver } from "./apns";

export interface Env {
  TOPIC: DurableObjectNamespace<Topic>;
  APNS_HOST_PRODUCTION: string;
  APNS_HOST_SANDBOX: string;
  APNS_BUNDLE_ID: string;
  APNS_KEY_ID: string;
  APNS_TEAM_ID: string;
  APNS_PRIVATE_KEY: string;
}

/** What a registration hands back to the device. */
export type Registration = { topicId: string; pushSecret: string };

/** Everything that can happen to a ping. */
export type PingOutcome =
  | { kind: "accepted" }
  | { kind: "unknown-topic" }
  | { kind: "bad-signature" }
  | { kind: "stale" }
  | { kind: "replay" }
  | { kind: "rate-limited"; retryAfterSeconds: number }
  | { kind: "delivery-failed"; reason: string };

/** A signed ping, as it arrives from headers. */
export type PingInput = { signature: string; timestamp: number; nonce: string };

/**
 * One device's doorbell.
 *
 * The coordination atom here is a topic, and a topic is one device. That makes
 * every piece of per-device state — the token, the secret, the rate-limit
 * bucket, the replay nonces — live in one place with no cross-topic locking
 * and no global instance to serialise on.
 */
export class Topic extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate(): void {
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
        id INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    const version = this.ctx.storage.sql
      .exec<{ version: number }>(
        "SELECT COALESCE(MAX(id), 0) as version FROM _sql_schema_migrations",
      )
      .one().version;

    if (version < 1) {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS registration (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          device_token TEXT NOT NULL,
          push_secret TEXT NOT NULL,
          environment TEXT NOT NULL,
          registered_at INTEGER NOT NULL,
          tokens_available REAL NOT NULL,
          refilled_at INTEGER NOT NULL,
          day_started_at INTEGER NOT NULL,
          day_count INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS nonces (
          nonce TEXT PRIMARY KEY,
          seen_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_nonces_seen ON nonces(seen_at);
        INSERT INTO _sql_schema_migrations (id) VALUES (1);
      `);
    }
  }

  /** Bind a device token to this topic. Once. */
  async register(deviceToken: string, environment: "production" | "sandbox"): Promise<Registration> {
    if (!/^[0-9a-fA-F]{64,200}$/.test(deviceToken)) {
      throw new Error("device token is not a hexadecimal APNs token");
    }
    if (environment !== "production" && environment !== "sandbox") {
      throw new Error("environment must be production or sandbox");
    }
    const existing = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) as count FROM registration")
      .one().count;
    if (existing > 0) {
      // Topics are minted per device and never reused. Allowing a second
      // registration would let anyone holding a topic id point its pushes at
      // a device of their choosing.
      throw new Error("this topic is already registered");
    }

    const pushSecret = [...crypto.getRandomValues(new Uint8Array(32))]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO registration
         (id, device_token, push_secret, environment, registered_at,
          tokens_available, refilled_at, day_started_at, day_count)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, 0)`,
      deviceToken,
      pushSecret,
      environment,
      now,
      BURST,
      now,
      now,
    );
    return { topicId: this.ctx.id.toString(), pushSecret };
  }

  /** Whether a device is bound. */
  async isRegistered(): Promise<boolean> {
    return (
      this.ctx.storage.sql
        .exec<{ count: number }>("SELECT COUNT(*) as count FROM registration")
        .one().count > 0
    );
  }

  /** Drop the registration. Called on unregister and on APNs 410. */
  async forget(reason: string): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM registration");
    this.ctx.storage.sql.exec("DELETE FROM nonces");
    // The reason is counted, not stored. Which device it was is not
    // interesting once it is gone.
    console.log(JSON.stringify({ event: "forget", reason }));
  }

  /** Verify a ping and, if it holds up, deliver a push. */
  async ping(input: PingInput, topicId?: string): Promise<PingOutcome> {
    const rows = this.ctx.storage.sql
      .exec<{
        device_token: string;
        push_secret: string;
        environment: string;
        tokens_available: number;
        refilled_at: number;
        day_started_at: number;
        day_count: number;
      }>("SELECT * FROM registration WHERE id = 1")
      .toArray();
    const registration = rows[0];
    if (!registration) {
      return { kind: "unknown-topic" };
    }

    const now = Date.now();
    if (Math.abs(now - input.timestamp) > CLOCK_SKEW_SECONDS * 1000) {
      return { kind: "stale" };
    }

    const expectedTopic = topicId ?? this.ctx.id.toString();
    const valid = await verifySignature({
      secret: registration.push_secret,
      topicId: expectedTopic,
      timestamp: input.timestamp,
      nonce: input.nonce,
      signature: input.signature,
    });
    if (!valid) {
      return { kind: "bad-signature" };
    }

    // Nonce check happens after signature verification on purpose: an
    // unauthenticated caller must not be able to fill this table.
    this.ctx.storage.sql.exec(
      "DELETE FROM nonces WHERE seen_at < ?",
      now - NONCE_TTL_SECONDS * 1000,
    );
    const seen = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) as count FROM nonces WHERE nonce = ?", input.nonce)
      .one().count;
    if (seen > 0) {
      return { kind: "replay" };
    }

    const limit = this.consumeToken(registration, now);
    if (limit) {
      return limit;
    }

    this.ctx.storage.sql.exec("INSERT INTO nonces (nonce, seen_at) VALUES (?, ?)", input.nonce, now);

    const outcome = await deliver(this.env, {
      deviceToken: registration.device_token,
      environment: registration.environment === "sandbox" ? "sandbox" : "production",
    });

    if (outcome.kind === "unregistered") {
      await this.forget("apns-unregistered");
      return { kind: "delivery-failed", reason: "unregistered" };
    }
    if (outcome.kind === "failed") {
      return { kind: "delivery-failed", reason: outcome.reason };
    }
    return { kind: "accepted" };
  }

  /**
   * Token bucket plus a daily ceiling.
   *
   * The bucket smooths bursts; the ceiling catches a Cave stuck in a loop that
   * would otherwise trickle a ping every ten seconds indefinitely.
   */
  private consumeToken(
    registration: {
      tokens_available: number;
      refilled_at: number;
      day_started_at: number;
      day_count: number;
    },
    now: number,
  ): PingOutcome | null {
    const elapsedSeconds = (now - registration.refilled_at) / 1000;
    const refilled = Math.min(BURST, registration.tokens_available + elapsedSeconds / REFILL_SECONDS);

    let dayStartedAt = registration.day_started_at;
    let dayCount = registration.day_count;
    if (now - dayStartedAt > 24 * 60 * 60 * 1000) {
      dayStartedAt = now;
      dayCount = 0;
    }

    if (dayCount >= DAILY_CEILING) {
      return { kind: "rate-limited", retryAfterSeconds: Math.ceil((dayStartedAt + 86_400_000 - now) / 1000) };
    }
    if (refilled < 1) {
      return { kind: "rate-limited", retryAfterSeconds: Math.ceil((1 - refilled) * REFILL_SECONDS) };
    }

    this.ctx.storage.sql.exec(
      `UPDATE registration
         SET tokens_available = ?, refilled_at = ?, day_started_at = ?, day_count = ?
       WHERE id = 1`,
      refilled - 1,
      now,
      dayStartedAt,
      dayCount + 1,
    );
    return null;
  }
}
```

- [ ] **Step 5: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-relay
npx vitest run test/topic.test.ts
git add -A
git commit -S -m "Add the Topic durable object

One topic is one device, so the token, the secret, the rate-limit
bucket, and the replay nonces all live together with no global instance
to serialise on. A topic accepts exactly one registration, ever."
```

---

## Task 3: Signature Verification

**Files:** Create `src/signature.ts`, add to `test/topic.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, it } from "vitest";
import { canonicalString, sign, verifySignature } from "../src/signature";

const SECRET = "ab".repeat(32);

describe("signature", () => {
  it("verifies what it signs", async () => {
    const signature = await sign(SECRET, canonicalString("t1", 1000, "n1"));
    expect(await verifySignature({ secret: SECRET, topicId: "t1", timestamp: 1000, nonce: "n1", signature }))
      .toBe(true);
  });

  it("binds the signature to the topic", async () => {
    // Without the topic in the signed string, a ping captured for one topic
    // could be replayed against another.
    const signature = await sign(SECRET, canonicalString("t1", 1000, "n1"));
    expect(await verifySignature({ secret: SECRET, topicId: "t2", timestamp: 1000, nonce: "n1", signature }))
      .toBe(false);
  });

  it("binds the signature to the timestamp and nonce", async () => {
    const signature = await sign(SECRET, canonicalString("t1", 1000, "n1"));
    expect(await verifySignature({ secret: SECRET, topicId: "t1", timestamp: 1001, nonce: "n1", signature }))
      .toBe(false);
    expect(await verifySignature({ secret: SECRET, topicId: "t1", timestamp: 1000, nonce: "n2", signature }))
      .toBe(false);
  });

  it("rejects a wrong-length signature without throwing", async () => {
    expect(await verifySignature({ secret: SECRET, topicId: "t1", timestamp: 1000, nonce: "n", signature: "aa" }))
      .toBe(false);
  });

  it("rejects a non-hex signature without throwing", async () => {
    expect(await verifySignature({ secret: SECRET, topicId: "t1", timestamp: 1000, nonce: "n", signature: "z".repeat(64) }))
      .toBe(false);
  });

  it("uses a delimiter that cannot be forged by field content", async () => {
    // Without a delimiter no field may contain, "t1" + "23n" and "t12" + "3n"
    // would sign identically.
    const a = canonicalString("t1", 23, "n");
    const b = canonicalString("t12", 3, "n");
    expect(a).not.toEqual(b);
  });
});
```

- [ ] **Step 2: Implement**

Create `src/signature.ts`:

```typescript
/**
 * Ping authentication.
 *
 * HMAC-SHA256 over a canonical string that binds the topic, the timestamp, and
 * the nonce. Every field is in the signed string; a signature that omitted the
 * topic would be replayable against a different device, and one that omitted
 * the nonce would be replayable against the same one.
 */

/** Scheme version, so a future change is distinguishable rather than silent. */
const VERSION = "v1";

/** The exact bytes that get signed. */
export function canonicalString(topicId: string, timestamp: number, nonce: string): string {
  // Newline is the delimiter and is rejected in every field by the caller, so
  // no combination of field values can produce another combination's string.
  return [VERSION, topicId, String(timestamp), nonce].join("\n");
}

/** Hex HMAC-SHA256. */
export async function sign(secretHex: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    hexToBytes(secretHex),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Verify a ping signature in constant time. */
export async function verifySignature(input: {
  secret: string;
  topicId: string;
  timestamp: number;
  nonce: string;
  signature: string;
}): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/i.test(input.signature)) {
    return false;
  }
  if ([input.topicId, input.nonce].some((field) => field.includes("\n"))) {
    return false;
  }
  const expected = await sign(input.secret, canonicalString(input.topicId, input.timestamp, input.nonce));
  return timingSafeEqual(expected, input.signature.toLowerCase());
}

/**
 * Compare without an early return.
 *
 * A byte-by-byte comparison that stops at the first difference tells an
 * attacker how much of a guess was right, which is enough to recover a
 * signature one byte at a time.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}
```

- [ ] **Step 3: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-relay
npx vitest run
git add -A
git commit -S -m "Add constant-time ping signature verification

The topic, timestamp, and nonce are all in the signed string, so a
captured ping cannot be replayed against another device or another
moment."
```

---

## Task 4: The Worker Routes

The Worker does routing and nothing else. Every decision lives in the Durable Object, where the state is.

**Files:** Create `src/index.ts`, `test/worker.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/worker.test.ts`:

```typescript
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const TOKEN = "a".repeat(64);

async function register(): Promise<{ topicId: string; pushSecret: string }> {
  const response = await SELF.fetch("https://relay.test/v1/devices", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ deviceToken: TOKEN, environment: "sandbox" }),
  });
  return response.json();
}

describe("worker", () => {
  it("health reports without touching storage", async () => {
    const response = await SELF.fetch("https://relay.test/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "chat-relay", version: 1 });
  });

  it("registers a device and returns an opaque topic", async () => {
    const { topicId, pushSecret } = await register();
    expect(topicId).toMatch(/^[0-9a-f]{64}$/);
    expect(pushSecret).toHaveLength(64);
  });

  it("refuses a registration with no device token", async () => {
    const response = await SELF.fetch("https://relay.test/v1/devices", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ environment: "sandbox" }),
    });
    expect(response.status).toBe(400);
  });

  it("accepts a signed ping with an empty body", async () => {
    const { topicId, pushSecret } = await register();
    const response = await ping(topicId, pushSecret, "n1");
    expect([202, 502]).toContain(response.status);
  });

  it("refuses a ping that carries a body", async () => {
    // There is no field for a preview to leak into later, because there is no
    // body at all. Enforcing that now is what keeps it true.
    const { topicId, pushSecret } = await register();
    const response = await ping(topicId, pushSecret, "n2", "{\"preview\":\"hello\"}");
    expect(response.status).toBe(400);
  });

  it("returns 401 for a bad signature and reveals nothing else", async () => {
    const { topicId } = await register();
    const response = await ping(topicId, "00".repeat(32), "n3");
    expect(response.status).toBe(401);
    expect(await response.text()).toBe("");
  });

  it("returns 401 rather than 404 for an unknown topic", async () => {
    // A distinguishable 404 would turn the relay into an oracle for which
    // topic ids exist.
    const response = await ping(crypto.randomUUID().replace(/-/g, "").padEnd(64, "0"), "00".repeat(32), "n4");
    expect(response.status).toBe(401);
  });

  it("returns 429 with Retry-After once the burst is spent", async () => {
    const { topicId, pushSecret } = await register();
    let last: Response | undefined;
    for (let index = 0; index < 12; index += 1) {
      last = await ping(topicId, pushSecret, `b${index}`);
    }
    expect(last?.status).toBe(429);
    expect(last?.headers.get("retry-after")).toBeTruthy();
  });

  it("rejects an unknown route", async () => {
    expect((await SELF.fetch("https://relay.test/v1/whatever")).status).toBe(404);
  });
});
```

- [ ] **Step 2: Implement**

Create `src/index.ts`:

```typescript
import { Topic, type Env } from "./topic";

export { Topic };

/**
 * Routing only.
 *
 * The Worker parses a request into three strings and hands them to the topic's
 * Durable Object. It makes no decisions about validity, because every input to
 * that decision is state that lives in the object.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "chat-relay", version: 1 });
    }

    if (url.pathname === "/v1/devices" && request.method === "POST") {
      return registerDevice(request, env);
    }

    const pingMatch = url.pathname.match(/^\/v1\/ping\/([0-9a-f]{64})$/);
    if (pingMatch && request.method === "POST") {
      return handlePing(request, env, pingMatch[1]);
    }

    const forgetMatch = url.pathname.match(/^\/v1\/devices\/([0-9a-f]{64})$/);
    if (forgetMatch && request.method === "DELETE") {
      return forgetDevice(request, env, forgetMatch[1]);
    }

    return new Response(null, { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function registerDevice(request: Request, env: Env): Promise<Response> {
  let body: { deviceToken?: unknown; environment?: unknown };
  try {
    body = await request.json();
  } catch {
    return new Response(null, { status: 400 });
  }
  const deviceToken = typeof body.deviceToken === "string" ? body.deviceToken : "";
  const environment = body.environment === "sandbox" ? "sandbox" : "production";
  if (!deviceToken) {
    return new Response(null, { status: 400 });
  }

  // The topic id is random and unguessable. It is also the DO name, so there
  // is no lookup table anywhere mapping devices to topics.
  const topicId = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const stub = env.TOPIC.getByName(topicId);
  try {
    const registration = await stub.register(deviceToken, environment);
    return Response.json({ topicId, pushSecret: registration.pushSecret });
  } catch {
    return new Response(null, { status: 400 });
  }
}

async function handlePing(request: Request, env: Env, topicId: string): Promise<Response> {
  // A ping is headers and nothing else. A body is a protocol violation and is
  // refused rather than ignored, so it cannot quietly become a feature.
  const declared = request.headers.get("content-length");
  if ((declared && declared !== "0") || request.body !== null) {
    return new Response(null, { status: 400 });
  }

  const signature = request.headers.get("x-coven-signature") ?? "";
  const nonce = request.headers.get("x-coven-nonce") ?? "";
  const timestamp = Number(request.headers.get("x-coven-timestamp") ?? "");
  if (!signature || !nonce || !Number.isFinite(timestamp)) {
    return new Response(null, { status: 400 });
  }

  const stub = env.TOPIC.getByName(topicId);
  const outcome = await stub.ping({ signature, timestamp, nonce }, topicId);

  switch (outcome.kind) {
    case "accepted":
      return new Response(null, { status: 202 });
    case "rate-limited":
      return new Response(null, {
        status: 429,
        headers: { "retry-after": String(outcome.retryAfterSeconds) },
      });
    case "delivery-failed":
      return new Response(null, { status: 502 });
    // Unknown topic, bad signature, stale, and replay all answer identically.
    // Distinguishing them would let a caller enumerate topics or probe the
    // clock window.
    default:
      return new Response(null, { status: 401 });
  }
}

async function forgetDevice(request: Request, env: Env, topicId: string): Promise<Response> {
  const signature = request.headers.get("x-coven-signature") ?? "";
  const nonce = request.headers.get("x-coven-nonce") ?? "";
  const timestamp = Number(request.headers.get("x-coven-timestamp") ?? "");
  const stub = env.TOPIC.getByName(topicId);
  const outcome = await stub.ping({ signature, timestamp, nonce }, topicId);
  if (outcome.kind !== "accepted" && outcome.kind !== "delivery-failed") {
    return new Response(null, { status: 401 });
  }
  await stub.forget("client-request");
  return new Response(null, { status: 204 });
}
```

- [ ] **Step 3: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-relay
npx vitest run
git add -A
git commit -S -m "Add the relay routes

Unknown topic, bad signature, stale, and replay all answer 401 with an
empty body, so the relay is not an oracle for which topics exist. A ping
carrying a body is refused rather than ignored."
```

---

## Task 5: APNs Delivery

**Files:** Create `src/apns.ts`, `test/apns.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/apns.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { DOORBELL_PAYLOAD, deliver, mintProviderToken } from "../src/apns";

const ENV = {
  APNS_HOST_PRODUCTION: "https://api.push.apple.com",
  APNS_HOST_SANDBOX: "https://api.sandbox.push.apple.com",
  APNS_BUNDLE_ID: "ai.opencoven.chat",
  APNS_KEY_ID: "ABCD123456",
  APNS_TEAM_ID: "TEAM123456",
  APNS_PRIVATE_KEY: TEST_P8,
} as never;

describe("apns", () => {
  it("the payload is a frozen constant", () => {
    expect(Object.isFrozen(DOORBELL_PAYLOAD)).toBe(true);
    expect(JSON.parse(DOORBELL_PAYLOAD)).toEqual({
      aps: {
        alert: { "loc-key": "doorbell.placeholder" },
        "mutable-content": 1,
        sound: "default",
        "thread-id": "cave",
      },
    });
  });

  it("sends identical bytes for different devices", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      return new Response(null, { status: 200 });
    });
    await deliver(ENV, { deviceToken: "a".repeat(64), environment: "production" });
    await deliver(ENV, { deviceToken: "b".repeat(64), environment: "sandbox" });
    expect(bodies[0]).toEqual(bodies[1]);
    vi.unstubAllGlobals();
  });

  it("sets the headers a background-capable alert needs", async () => {
    let captured: Record<string, string> = {};
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      captured = Object.fromEntries(new Headers(init.headers).entries());
      return new Response(null, { status: 200 });
    });
    await deliver(ENV, { deviceToken: "a".repeat(64), environment: "production" });
    expect(captured["apns-topic"]).toBe("ai.opencoven.chat");
    expect(captured["apns-push-type"]).toBe("alert");
    expect(captured["apns-priority"]).toBe("10");
    expect(captured.authorization).toMatch(/^bearer /);
    vi.unstubAllGlobals();
  });

  it("routes sandbox tokens to the sandbox host", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      urls.push(url);
      return new Response(null, { status: 200 });
    });
    await deliver(ENV, { deviceToken: "a".repeat(64), environment: "sandbox" });
    expect(urls[0]).toContain("api.sandbox.push.apple.com");
    vi.unstubAllGlobals();
  });

  it("reports 410 as unregistered so the caller can forget the device", async () => {
    vi.stubGlobal("fetch", async () => new Response("{\"reason\":\"Unregistered\"}", { status: 410 }));
    const outcome = await deliver(ENV, { deviceToken: "a".repeat(64), environment: "production" });
    expect(outcome.kind).toBe("unregistered");
    vi.unstubAllGlobals();
  });

  it("reports 400 BadDeviceToken as unregistered too", async () => {
    vi.stubGlobal("fetch", async () => new Response("{\"reason\":\"BadDeviceToken\"}", { status: 400 }));
    expect((await deliver(ENV, { deviceToken: "a".repeat(64), environment: "production" })).kind)
      .toBe("unregistered");
    vi.unstubAllGlobals();
  });

  it("reuses a provider token rather than minting one per push", async () => {
    // Apple rejects providers that regenerate tokens too often with
    // TooManyProviderTokenUpdates. Reuse is required, not an optimisation.
    const first = await mintProviderToken(ENV, 0);
    const second = await mintProviderToken(ENV, 60_000);
    expect(second).toBe(first);
    const third = await mintProviderToken(ENV, 60 * 60_000);
    expect(third).not.toBe(first);
  });
});
```

- [ ] **Step 2: Implement**

Create `src/apns.ts`:

```typescript
import type { Env } from "./topic";

/**
 * The entire notification this service sends.
 *
 * Frozen, module-level, and referenced rather than constructed, so there is no
 * code path where a value from a request could be interpolated into it. The
 * words the user reads come from their own device after it fetches from their
 * own Cave; `loc-key` is resolved by the app's own string catalogue.
 */
export const DOORBELL_PAYLOAD = Object.freeze(
  JSON.stringify({
    aps: {
      alert: { "loc-key": "doorbell.placeholder" },
      "mutable-content": 1,
      sound: "default",
      "thread-id": "cave",
    },
  }),
);

/** What delivery did. */
export type DeliveryOutcome =
  | { kind: "delivered" }
  | { kind: "unregistered" }
  | { kind: "failed"; reason: string };

let cachedToken: { value: string; mintedAt: number } | null = null;

/**
 * A provider token, reused for up to 50 minutes.
 *
 * Apple invalidates tokens older than an hour and rejects providers that mint
 * them too frequently, so both ends of this window are requirements rather
 * than tuning.
 */
export async function mintProviderToken(env: Env, now = Date.now()): Promise<string> {
  if (cachedToken && now - cachedToken.mintedAt < 50 * 60_000) {
    return cachedToken.value;
  }
  const header = base64url(JSON.stringify({ alg: "ES256", kid: env.APNS_KEY_ID }));
  const claims = base64url(JSON.stringify({ iss: env.APNS_TEAM_ID, iat: Math.floor(now / 1000) }));
  const signingInput = `${header}.${claims}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToBytes(env.APNS_PRIVATE_KEY),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(signingInput),
  );

  const value = `${signingInput}.${base64urlBytes(new Uint8Array(signature))}`;
  cachedToken = { value, mintedAt: now };
  return value;
}

/** Send the doorbell. */
export async function deliver(
  env: Env,
  target: { deviceToken: string; environment: "production" | "sandbox" },
): Promise<DeliveryOutcome> {
  const host = target.environment === "sandbox" ? env.APNS_HOST_SANDBOX : env.APNS_HOST_PRODUCTION;
  const token = await mintProviderToken(env);

  let response: Response;
  try {
    response = await fetch(`${host}/3/device/${target.deviceToken}`, {
      method: "POST",
      headers: {
        authorization: `bearer ${token}`,
        "apns-topic": env.APNS_BUNDLE_ID,
        "apns-push-type": "alert",
        // Priority 10 is correct for an alert the user should see now. A
        // background push would be throttled by iOS and is why this is an
        // alert with mutable-content rather than content-available.
        "apns-priority": "10",
        "apns-expiration": String(Math.floor(Date.now() / 1000) + 3600),
        "apns-id": crypto.randomUUID(),
      },
      body: DOORBELL_PAYLOAD,
    });
  } catch {
    return { kind: "failed", reason: "network" };
  }

  if (response.status === 200) {
    return { kind: "delivered" };
  }

  let reason = "unknown";
  try {
    const body = (await response.json()) as { reason?: string };
    reason = typeof body.reason === "string" ? body.reason : "unknown";
  } catch {
    // A body that will not parse changes nothing; the status is what matters.
  }

  // Apple says this device is gone. Keeping the token would mean pinging a
  // reinstalled app forever.
  if (response.status === 410 || reason === "BadDeviceToken" || reason === "Unregistered") {
    return { kind: "unregistered" };
  }
  if (response.status === 403 || reason === "ExpiredProviderToken") {
    // Force a fresh mint on the next attempt.
    cachedToken = null;
  }
  return { kind: "failed", reason };
}

function base64url(text: string): string {
  return base64urlBytes(new TextEncoder().encode(text));
}

function base64urlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToBytes(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
```

- [ ] **Step 3: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-relay
npx vitest run
git add -A
git commit -S -m "Add APNs delivery with a frozen payload

The payload is a module-level frozen constant referenced rather than
constructed, so no request value has a path into it. Provider tokens are
reused for fifty minutes because Apple rejects providers that mint them
more often than that."
```

---

## Task 6: The Privacy Gate

Every claim in `PRIVACY.md` becomes a test. A promise a test does not check is a promise that will be broken by an unrelated change six months from now.

**Files:** Create `test/privacy.test.ts`

- [ ] **Step 1: Write the tests**

```typescript
import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

describe("privacy", () => {
  it("no source file references a Cave instance, host, or conversation", () => {
    const sources = ["src/index.ts", "src/topic.ts", "src/apns.ts", "src/signature.ts", "src/limits.ts"]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    for (const forbidden of ["instanceId", "conversation", "familiar", "preview", "message", "title", "body:"]) {
      expect(sources.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it("the outbound payload never varies", async () => {
    const bodies = new Set<string>();
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.add(String(init.body));
      return new Response(null, { status: 200 });
    });
    for (let index = 0; index < 5; index += 1) {
      const stub = env.TOPIC.getByName(crypto.randomUUID());
      await stub.register("a".repeat(64), "production");
      // Sign and ping through the helper used elsewhere in the suite.
    }
    expect(bodies.size).toBe(1);
    vi.unstubAllGlobals();
  });

  it("logs contain no device token, secret, or topic id", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args) => lines.push(args.join(" "));
    try {
      const stub = env.TOPIC.getByName(crypto.randomUUID());
      const { pushSecret } = await stub.register("f".repeat(64), "production");
      await stub.forget("test");
      const joined = lines.join("\n");
      expect(joined).not.toContain("f".repeat(64));
      expect(joined).not.toContain(pushSecret);
    } finally {
      console.log = original;
    }
  });

  it("an error response body is always empty", async () => {
    for (const path of ["/v1/ping/" + "0".repeat(64), "/v1/nope"]) {
      const response = await SELF.fetch(`https://relay.test${path}`, { method: "POST" });
      expect(await response.text()).toBe("");
    }
  });

  it("PRIVACY.md still names the payload this service actually sends", async () => {
    const { DOORBELL_PAYLOAD } = await import("../src/apns");
    expect(readFileSync("PRIVACY.md", "utf8")).toContain(DOORBELL_PAYLOAD);
  });
});
```

The last test is the important one. It means a change to the payload fails the build until someone updates the document that describes it to users.

- [ ] **Step 2: Run, add CI, and commit**

Create `.github/workflows/ci.yml` running `npx tsc --noEmit`, `npx vitest run`, and `npx wrangler deploy --dry-run`.

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-relay
npx vitest run
npx tsc --noEmit
git add -A
git commit -S -m "Add the privacy gate

Changing the push payload now fails the build until PRIVACY.md is
updated to match, so the document users read cannot drift from the bytes
the service sends."
```

---

## Task 7: Deploy

**Files:** Modify `README.md`

- [ ] **Step 1: Create the Cloudflare resources and set secrets**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-relay
npx wrangler secret put APNS_KEY_ID
npx wrangler secret put APNS_TEAM_ID
npx wrangler secret put APNS_PRIVATE_KEY   # paste the .p8 contents, including the PEM headers
```

The `.p8` file itself must never enter the repository. Confirm:

```bash
git check-ignore -v *.p8 || echo "add *.p8 to .gitignore before continuing"
```

- [ ] **Step 2: Deploy to a staging name first**

```bash
npx wrangler deploy --name chat-relay-staging
curl -s https://chat-relay-staging.<account>.workers.dev/health
```

Expected: `{"ok":true,"service":"chat-relay","version":1}`.

- [ ] **Step 3: Verify a real push end to end**

Register a real sandbox device token from a development build, ping it with a correctly signed request, and confirm the phone shows the placeholder notification. Record the observed result. Until this works, nothing downstream in this phase can be tested honestly.

- [ ] **Step 4: Deploy production and record the URL**

```bash
npx wrangler deploy
```

Note the production URL in `README.md`. Cave's default relay URL in Task 8 must match it exactly.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -S -m "Document relay deployment and the production URL"
```

---

## Task 8: Doorbell Emission From Cave

**Files:** Create `src/lib/server/client-v1/doorbell.ts`, `doorbell-emitter.ts`, and tests; modify `device-store.ts`, the run lifecycle, and the settings surface

- [ ] **Step 1: Write the failing tests**

Create `src/lib/server/client-v1/doorbell.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { buildPingRequest, shouldEmit } from "./doorbell.ts";

test("a ping carries headers and no body", () => {
  const request = buildPingRequest({
    relayUrl: "https://relay.test",
    topicId: "a".repeat(64),
    pushSecret: "b".repeat(64),
    now: 1_000_000,
    nonce: "n1",
  });
  assert.equal(request.body, undefined);
  assert.equal(request.headers["x-coven-timestamp"], "1000000");
  assert.match(request.headers["x-coven-signature"], /^[0-9a-f]{64}$/);
});

test("the signature is over the topic, timestamp, and nonce", () => {
  const base = { relayUrl: "https://relay.test", topicId: "a".repeat(64), pushSecret: "b".repeat(64), now: 1, nonce: "n" };
  const changed = buildPingRequest({ ...base, topicId: "c".repeat(64) });
  assert.notEqual(buildPingRequest(base).headers["x-coven-signature"], changed.headers["x-coven-signature"]);
});

test("nothing about the run appears in the request", () => {
  const request = buildPingRequest({
    relayUrl: "https://relay.test",
    topicId: "a".repeat(64),
    pushSecret: "b".repeat(64),
    now: 1,
    nonce: "n",
  });
  const serialized = JSON.stringify(request);
  for (const leak of ["conversation", "familiar", "prompt", "title"]) {
    assert.equal(serialized.includes(leak), false);
  }
});

test("emission is skipped when doorbells are disabled", () => {
  assert.equal(shouldEmit({ enabled: false, devices: [{ suspended: false }] }), false);
});

test("emission is skipped when a device is suspended", () => {
  assert.equal(shouldEmit({ enabled: true, devices: [{ suspended: true }] }), false);
});

test("emission is skipped when there are no devices", () => {
  assert.equal(shouldEmit({ enabled: true, devices: [] }), false);
});
```

Create `doorbell-emitter.test.ts` covering: emission never throws into the caller, a 429 is recorded without suspension, five consecutive failures suspend a device, a 401 suspends immediately because the secret is wrong and retrying cannot fix it, and a successful ping clears the failure count.

- [ ] **Step 2: Verify the tests fail, then implement**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
node --require ./scripts/css-source-contract-hook.cjs \
  --experimental-strip-types \
  --import ./scripts/test-alias-register.mjs \
  --test src/lib/server/client-v1/doorbell.test.ts
```

Create `src/lib/server/client-v1/doorbell.ts` building the signed request with the same canonical string the relay verifies — `v1\n<topicId>\n<timestamp>\n<nonce>` — using `node:crypto` HMAC-SHA256.

Create `doorbell-emitter.ts` with the emission policy:

```ts
/**
 * Emission is fire-and-forget with a short budget.
 *
 * A doorbell is a convenience. A doorbell that delays a familiar's reply, or
 * that fails a run because a relay is down, has made the product worse in
 * order to add a nicety. So this never throws into its caller, never retries
 * inline, and gives up quickly.
 */
export const EMISSION_TIMEOUT_MS = 4_000;

/** Consecutive failures before a device stops being pinged. */
export const SUSPEND_AFTER_FAILURES = 5;
```

Wire emission at three points, each already existing in Cave's run lifecycle: run completion, run failure, and attention-prompt creation. Each call is `void emitDoorbell(...)` with its own timeout, never awaited by the path that produces the user's result.

- [ ] **Step 3: Add failure counters to the device store**

Extend `DeviceRegistration` with `consecutiveFailures: number` and `suspendedAt: number | null`. A suspended device is listed in paired-clients with a plain-language reason and a re-enable control; it is not silently forgotten, because a user who wonders why their phone stopped buzzing deserves an answer.

- [ ] **Step 4: Add the opt-out**

Add a Cave setting, default **on for instances that have a registered device and otherwise irrelevant**, that disables doorbell emission entirely. Surface it beside the relay URL in settings, with a sentence naming what the relay is and what it can see, linking to the relay's `PRIVACY.md`.

The relay URL is configurable. A self-hoster who runs their own relay with their own Apple team and their own build points Cave at it and never touches OpenCoven's.

- [ ] **Step 5: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
pnpm lint && pnpm typecheck && pnpm test:api && pnpm check:tests-wired
git add src/
git commit -S -m "Emit doorbells from Cave on completion, failure, and attention

Emission is fire-and-forget with a four-second budget and never throws
into the run that triggered it. A wrong secret suspends the device
immediately, because retrying a 401 cannot fix it."
```

---

## Task 9: Registration on the Phone

**Files:** Create `app/Sources/Support/PushRegistrar.swift`, `app/Tests/PushRegistrarTests.swift`; modify `ChatApp.swift`, `CaveStore.swift`

- [ ] **Step 1: Write the failing tests**

```swift
import XCTest
@testable import ChatIOS

@MainActor
final class PushRegistrarTests: XCTestCase {
    func testRegistrationGoesToTheRelayBeforeCave() async throws {
        let recorder = RecordingRelay()
        let registrar = PushRegistrar(relay: recorder, store: CaveStore.preview)
        try await registrar.register(deviceToken: Data(repeating: 0xAB, count: 32))
        XCTAssertEqual(recorder.calls, ["register"])
        XCTAssertEqual(CaveStore.preview.registeredTopics.count, 1)
    }

    func testTheDeviceTokenNeverReachesCave() async throws {
        let recorder = RecordingRelay()
        let store = RecordingCaveStore()
        let registrar = PushRegistrar(relay: recorder, store: store)
        try await registrar.register(deviceToken: Data(repeating: 0xAB, count: 32))
        // Cave gets a topic and a secret. It has no business knowing which
        // device, and the relay has no business knowing which Cave.
        XCTAssertFalse(store.lastDeviceRegistration!.debugDescription.contains("abab"))
    }

    func testAChangedTokenReplacesTheRegistration() async throws {
        let registrar = PushRegistrar(relay: RecordingRelay(), store: RecordingCaveStore())
        try await registrar.register(deviceToken: Data(repeating: 0x01, count: 32))
        let first = registrar.currentTopicId
        try await registrar.register(deviceToken: Data(repeating: 0x02, count: 32))
        XCTAssertNotEqual(registrar.currentTopicId, first)
    }

    func testTheSameTokenDoesNotReregister() async throws {
        let recorder = RecordingRelay()
        let registrar = PushRegistrar(relay: recorder, store: RecordingCaveStore())
        let token = Data(repeating: 0x01, count: 32)
        try await registrar.register(deviceToken: token)
        try await registrar.register(deviceToken: token)
        XCTAssertEqual(recorder.calls.filter { $0 == "register" }.count, 1)
    }

    func testSignOutUnregistersFromBothSides() async throws {
        let recorder = RecordingRelay()
        let store = RecordingCaveStore()
        let registrar = PushRegistrar(relay: recorder, store: store)
        try await registrar.register(deviceToken: Data(repeating: 0x01, count: 32))
        try await registrar.unregister()
        XCTAssertTrue(recorder.calls.contains("forget"))
        XCTAssertTrue(store.didRemoveDevice)
    }

    func testTheSecretIsStoredInTheKeychainNotUserDefaults() async throws {
        let registrar = PushRegistrar(relay: RecordingRelay(), store: RecordingCaveStore())
        try await registrar.register(deviceToken: Data(repeating: 0x01, count: 32))
        XCTAssertNil(UserDefaults.standard.string(forKey: "pushSecret"))
        XCTAssertNotNil(try Keychain.shared.read(.pushSecret))
    }
}
```

- [ ] **Step 2: Implement**

`PushRegistrar` owns the two-step handshake:

1. `POST <relay>/v1/devices` with the hex device token and the build's APNs environment. Returns `topicId` and `pushSecret`.
2. `POST /api/client/v1/push/devices` on Cave with `{ topicId, pushSecret }` — the route Phase C built.

Store `topicId` and `pushSecret` in the Keychain access group shared with the notification extension, using the same `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` posture Phase D1 set for the bearer. The extension needs the bearer, not the secret; the secret is stored in the shared group only so unregistration works from either side.

Request authorization at a considered moment, not at first launch: after the first successful enrollment, with a sentence explaining what a doorbell is and what the relay can see. A permission prompt with no context is a permission denied.

- [ ] **Step 3: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
git add app/
git commit -S -m "Register for doorbells with the relay and with Cave

The relay learns a device token and never which Cave. Cave learns a
topic and a secret and never which device. Neither side can join the
two."
```

---

## Task 10: The Notification Service Extension

This is where a content-free push becomes a useful notification.

**Files:** Create `extension/NotificationService.swift`, `extension/Info.plist`, `extension/Tests/NotificationServiceTests.swift`; modify `project.yml`, `scripts/build-xcframework.sh`

- [ ] **Step 1: Add the target**

Add a `ChatIOSNotificationService` app-extension target to `project.yml` with:

- the same Keychain access group as the app
- the XCFramework embedded (the extension links the Rust core to reuse `CaveSession`; reimplementing the fetch in Swift would mean two implementations of candidate selection and pinning)
- `NSExtensionPointIdentifier` of `com.apple.usernotifications.service`

Update `scripts/build-xcframework.sh` so the framework is embedded in both targets, and confirm the extension's binary size stays within the extension memory budget.

- [ ] **Step 2: Write the failing tests**

```swift
import XCTest
@testable import ChatIOSNotificationService

final class NotificationServiceTests: XCTestCase {
    func testAPlaceholderIsDeliveredWhenCaveIsUnreachable() async {
        let service = NotificationService(fetcher: FailingFetcher())
        let content = await service.rewrite(placeholder: .placeholder)
        XCTAssertEqual(content.title, "Cave")
        XCTAssertFalse(content.body.isEmpty)
    }

    func testTheRewrittenBodyComesFromCave() async {
        let service = NotificationService(fetcher: StubFetcher(summary: .init(
            title: "Athena", body: "Finished the migration", conversationId: "c1"
        )))
        let content = await service.rewrite(placeholder: .placeholder)
        XCTAssertEqual(content.title, "Athena")
        XCTAssertEqual(content.body, "Finished the migration")
        XCTAssertEqual(content.userInfo["conversationId"] as? String, "c1")
    }

    func testExpiryDeliversWhateverExistsRatherThanNothing() async {
        // iOS kills the extension at thirty seconds. Delivering nothing means
        // the user sees the raw placeholder anyway, so there is no reason to
        // lose the buzz.
        let service = NotificationService(fetcher: HangingFetcher())
        let content = await service.deliverOnExpiry()
        XCTAssertNotNil(content)
    }

    func testTheFetchBudgetIsWellUnderTheSystemLimit() {
        XCTAssertLessThan(NotificationService.fetchBudget, 15.0)
    }

    func testNothingIsLogged() async {
        let service = NotificationService(fetcher: StubFetcher(summary: .init(
            title: "Athena", body: "Secret content", conversationId: "c1"
        )))
        let log = CapturingLog()
        _ = await service.rewrite(placeholder: .placeholder, log: log)
        XCTAssertFalse(log.everything.contains("Secret content"))
    }
}
```

- [ ] **Step 3: Implement**

```swift
import UserNotifications

/// Turns a content-free doorbell into a notification worth reading.
///
/// The push that arrives says nothing. This extension reads the bearer from
/// the shared Keychain group, asks Cave what just happened, and rewrites the
/// notification before iOS shows it. If any of that fails, the localized
/// placeholder stands: a buzz that says "something happened" is worth more
/// than no buzz, and far more than an invented one.
final class NotificationService: UNNotificationServiceExtension {
    /// Well under the system's thirty seconds, leaving room to deliver.
    static let fetchBudget: TimeInterval = 10

    private var handler: ((UNNotificationContent) -> Void)?
    private var pending: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        handler = contentHandler
        let placeholder = (request.content.mutableCopy() as? UNMutableNotificationContent)
        pending = placeholder

        Task {
            let content = await rewrite(placeholder: placeholder ?? .placeholder)
            contentHandler(content)
        }
    }

    override func serviceExtensionTimeWillExpire() {
        // Deliver what exists. The alternative is the system delivering the
        // unmodified placeholder anyway, having wasted the attempt.
        if let pending, let handler {
            handler(pending)
        }
    }
}
```

The fetch itself asks Cave for the newest notable event on this credential — a small, dedicated read rather than a full conversation load, because the extension has ten seconds and a tight memory budget. If Cave's Phase 4 does not expose one, use the existing conversation list read and take the most recently updated entry, and record that as a follow-up rather than inventing a route this plan cannot verify.

- [ ] **Step 4: Add the placeholder strings**

`doorbell.placeholder` in the app's string catalogue, localized: title "Cave", body "Something needs you." The relay sends the key; the device holds the words.

- [ ] **Step 5: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
./scripts/build-xcframework.sh && xcodegen generate
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
git add app/ extension/ project.yml scripts/
git commit -S -m "Add the notification service extension

The relay sends a localization key; the device produces the words by
fetching from its own Cave. An unreachable Cave leaves the placeholder
standing rather than losing the notification."
```

---

## Task 11: Tapping the Notification

**Files:** Create `app/Sources/Support/NotificationRouter.swift`; modify `ChatApp.swift`, `RootView.swift`

- [ ] **Step 1: Implement and test**

- Tapping a doorbell opens the conversation named in `userInfo`, loading it canonically rather than trusting the payload. The `conversationId` came from the extension, which got it from Cave, but the route still goes through the same read path as everything else.
- A doorbell arriving in the foreground does not interrupt. It refreshes the conversation list quietly and, if the user is already in that conversation, does nothing visible at all.
- Badge count reflects conversations with unacknowledged attention, cleared when the conversation is opened.
- A doorbell for a conversation the user cannot see — revoked credential, deleted conversation — opens the list with an explanation rather than a blank thread.

- [ ] **Step 2: Run and commit**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios
xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS \
  -destination 'platform=iOS Simulator,name=iPhone 16' test
swiftlint lint --strict
git add app/
git commit -S -m "Route a tapped doorbell to its conversation

The conversation is loaded canonically rather than from the payload, so
a notification cannot put content on screen that Cave would not."
```

---

## Task 12: Phase Gate

- [ ] **Step 1: Full test run across all three repositories**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-relay && npx vitest run && npx tsc --noEmit
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave && pnpm lint && pnpm typecheck && pnpm test:api && pnpm test:app && pnpm check:tests-wired
cd /Users/buns/Documents/GitHub/OpenCoven/chat-ios && ./scripts/build-xcframework.sh && xcodegen generate && swiftlint lint --strict && xcodebuild -project ChatIOS.xcodeproj -scheme ChatIOS -destination 'platform=iOS Simulator,name=iPhone 16' test
```

- [ ] **Step 2: Confirm the payload is unreachable from request data**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/chat-relay
grep -n "DOORBELL_PAYLOAD" src/*.ts
```

Read every match. `DOORBELL_PAYLOAD` must be referenced and never templated, concatenated, spread, or parsed-and-rebuilt. If any call site constructs a payload rather than passing the constant, that is the leak this whole design exists to prevent.

- [ ] **Step 3: Confirm emission cannot block a run**

```bash
cd /Users/buns/Documents/GitHub/OpenCoven/coven-cave
grep -n "emitDoorbell" src/
```

Every call site must be `void`-prefixed or otherwise unawaited on the path that produces the user's result.

- [ ] **Step 4: Live journey**

Record the observed result of each:

1. Run a familiar to completion with the phone locked. The phone buzzes; the notification names the familiar and what it did.
2. Turn off Wi-Fi on the phone, keeping cellular, so the overlay is reachable but slow. The notification still resolves, or shows the placeholder rather than nothing.
3. Put the phone in airplane mode and complete a run. Nothing arrives; on reconnection nothing arrives late and wrong.
4. Trigger an attention prompt. The phone buzzes and tapping it opens the right conversation.
5. Complete twenty runs in two minutes. The phone stops buzzing after the burst, and Cave records rate limiting without failing a run.
6. Revoke the credential in Cave. The device disappears from paired-clients and stops receiving doorbells.
7. Delete the app and reinstall. The old topic receives a 410 from Apple on its next ping and the relay forgets it.
8. Disable doorbells in Cave settings. Runs complete normally and nothing is sent.
9. Point Cave at a relay URL that does not exist. Runs complete normally; the device is suspended after five failures and says so in settings.

Item 9 is the one that decides whether the relay is genuinely optional. If a dead relay degrades Cave, fix it before proceeding.

- [ ] **Step 5: Confirm no content reached the relay**

With the staging relay deployed and `wrangler tail` running, complete a run that produces a long, distinctive reply. Confirm no fragment of it appears in any log line, and that the only fields present are counters and error classes.

- [ ] **Step 6: Verify signatures**

```bash
for repo in chat-relay coven-cave chat-ios; do
  cd "/Users/buns/Documents/GitHub/OpenCoven/$repo"
  echo "== $repo"
  git log --pretty='%H %G?' -40 | awk '$2 != "G" {print "UNSIGNED:", $0}'
done
```

Expected: no output.

---

## Phase G1 Completion

Phase G1 is done when:

- A run completing, failing, or asking for attention buzzes a paired phone.
- The notification names the familiar and what happened, produced on the device by fetching from its own Cave.
- An unreachable Cave leaves a localized placeholder rather than losing the notification or inventing content.
- The relay's outbound payload is byte-identical for every ping, and a test fails if that changes.
- The relay's logs contain no device token, no secret, no topic id, and no caller address.
- Unknown topic, bad signature, stale timestamp, and replay are indistinguishable to a caller.
- Pings are rate-limited per topic with a burst, a refill, and a daily ceiling.
- An APNs 410 forgets the device without human intervention.
- Cave's emission never blocks, delays, or fails a run.
- Doorbells can be disabled entirely, and the relay URL can be pointed elsewhere.
- A dead relay degrades nothing except notifications.
- `PRIVACY.md` still describes what the service actually does, enforced by a test.
- Every commit is signed. Nothing is pushed.

**Not in this phase, by design:** background refresh, the accessibility audit, the device matrix, and the security review.

## Handoff to Phase G2

Phase G2 covers background refresh, accessibility, the device matrix, and the security review.

Three things G1 leaves for it:

- The notification extension fetches on every doorbell. G2's background refresh should share that read path rather than adding a third one.
- `ActionJournal.ambiguous()` from Phase F is still unused. A doorbell is a natural moment to reconcile, and G2 should wire it.
- The relay is the first OpenCoven-operated component in the design. G2's security review should treat it as its own trust boundary, not as an extension of Cave's.
