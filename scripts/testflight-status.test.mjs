import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { appleClient, inspectBuild, signRequest, waitForBuild } from './testflight-status.mjs';

const now = Date.parse('2026-11-14T10:00:00Z');
const target = { build: '1910', version: '0.3.0' };
const bundleId = 'ai.opencoven.chat.companion';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const credentials = { keyId: 'KEY123', issuer: 'issuer-id', privateKey };
const app = { type: 'apps', id: '123', attributes: { bundleId } };
const ref = (type, id) => ({ data: { type, id } });
function builds() {
  return {
    data: [
      {
        type: 'builds',
        id: 'build-1',
        attributes: {
          version: '1910',
          processingState: 'VALID',
          expired: false,
          expirationDate: '2027-01-01T00:00:00Z',
        },
        relationships: {
          app: ref('apps', '123'),
          preReleaseVersion: ref('preReleaseVersions', 'v1'),
          buildBetaDetail: ref('buildBetaDetails', 'beta1'),
        },
      },
    ],
    included: [
      structuredClone(app),
      { type: 'preReleaseVersions', id: 'v1', attributes: { platform: 'IOS', version: '0.3.0' } },
      {
        type: 'buildBetaDetails',
        id: 'beta1',
        attributes: {
          internalBuildState: 'IN_BETA_TESTING',
          externalBuildState: 'READY_FOR_BETA_SUBMISSION',
        },
      },
    ],
  };
}
const inspect = (doc) => inspectBuild(doc, '123', target, now);

test('JWT is valid ES256 P1363, short lived, and scoped to exactly one GET', () => {
  const path = '/v1/builds?filter%5Bapp%5D=123&limit=2';
  const token = signRequest(credentials, path, now);
  const [head, body, signature] = token.split('.');
  assert.deepEqual(JSON.parse(Buffer.from(head, 'base64url')), {
    alg: 'ES256',
    kid: 'KEY123',
    typ: 'JWT',
  });
  assert.deepEqual(JSON.parse(Buffer.from(body, 'base64url')), {
    iss: 'issuer-id',
    iat: now / 1000,
    exp: now / 1000 + 120,
    aud: 'appstoreconnect-v1',
    scope: [`GET ${path}`],
  });
  assert.equal(Buffer.from(signature, 'base64url').length, 64);
  assert.ok(
    verify(
      'sha256',
      Buffer.from(`${head}.${body}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      Buffer.from(signature, 'base64url'),
    ),
  );
});

test('missing credentials and non-P256 signing keys are refused', () => {
  const other = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).privateKey;
  for (const invalid of [
    { ...credentials, keyId: undefined },
    { ...credentials, issuer: undefined },
    { ...credentials, privateKey: other },
  ]) {
    assert.throws(() => signRequest(invalid, '/v1/apps', now), /invalid_credentials/);
  }
});

test('only exact, unexpired Apple metadata establishes testing availability', () => {
  assert.deepEqual(inspect(builds()), {
    status: 'testing_available',
    processingState: 'VALID',
    internalBuildState: 'IN_BETA_TESTING',
    externalBuildState: 'READY_FOR_BETA_SUBMISSION',
    internalTesting: true,
    externalTesting: false,
  });
  const doc = builds();
  doc.included[2].attributes.internalBuildState = 'READY_FOR_BETA_TESTING';
  assert.equal(inspect(doc).status, 'action_required');
  doc.included[2].attributes.externalBuildState = 'IN_BETA_TESTING';
  assert.equal(inspect(doc).externalTesting, true);
});

test('identity, relationship, missing or duplicate matches fail closed', () => {
  const changes = [
    (d) => {
      d.data.push(d.data[0]);
    },
    (d) => {
      d.links = { next: 'https://foreign.invalid' };
    },
    (d) => {
      d.data[0].attributes.version = '1909';
    },
    (d) => {
      d.data[0].relationships.app.data.id = 'other';
    },
    (d) => {
      d.included[0].attributes.bundleId = 'foreign.app';
    },
    (d) => {
      d.included[1].attributes.platform = 'MAC_OS';
    },
    (d) => {
      d.included[1].attributes.version = '0.2.0';
    },
    (d) => {
      d.included.splice(1, 1);
    },
    (d) => {
      d.included.push(d.included[1]);
    },
  ];
  for (const change of changes) {
    const doc = builds();
    change(doc);
    assert.throws(() => inspect(doc), /metadata_mismatch/);
  }
  assert.equal(inspect({ data: [] }).status, 'not_visible');
});

test('invalid, expired, absent and future unknown states cannot pass', () => {
  for (const state of ['FAILED', 'INVALID']) {
    const doc = builds();
    doc.data[0].attributes.processingState = state;
    assert.equal(inspect(doc).status, 'rejected');
  }
  for (const change of [
    (d) => {
      d.data[0].attributes.expired = true;
    },
    (d) => {
      d.data[0].attributes.expirationDate = '2026-01-01T00:00:00Z';
    },
    (d) => {
      d.data[0].attributes.expirationDate = 'bad';
    },
    (d) => {
      delete d.data[0].attributes.expired;
    },
    (d) => {
      d.data[0].attributes.processingState = 'NEW_STATE';
    },
    (d) => {
      d.included[2].attributes.internalBuildState = 'NEW_STATE';
    },
    (d) => {
      d.included[2].attributes.externalBuildState = 'NEW_STATE';
    },
  ]) {
    const doc = builds();
    change(doc);
    assert.notEqual(inspect(doc).status, 'testing_available');
  }
});

test('client uses fixed origin, GET, no redirects, exact filters, and no tester data', async () => {
  const requests = [];
  const client = appleClient(credentials, {
    now: () => now,
    fetch: async (url, options) => {
      requests.push({ url, options });
      return Response.json(requests.length === 1 ? { data: [app] } : builds());
    },
  });
  const result = await waitForBuild(client, target, { now: () => now });
  assert.equal(result.status, 'testing_available');
  assert.equal(result.physicalInstallationVerified, false);
  assert.equal(requests.length, 2);
  for (const { url, options } of requests) {
    assert.equal(new URL(url).origin, 'https://api.appstoreconnect.apple.com');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'manual');
    assert.ok(options.signal);
    const claims = JSON.parse(
      Buffer.from(options.headers.Authorization.split('.')[1], 'base64url'),
    );
    assert.deepEqual(claims.scope, [`GET ${new URL(url).pathname}${new URL(url).search}`]);
  }
  const query = new URL(requests[1].url).searchParams;
  assert.equal(query.get('filter[app]'), '123');
  assert.equal(query.get('filter[version]'), '1910');
  assert.equal(query.get('filter[preReleaseVersion.version]'), '0.3.0');
  assert.equal(query.get('filter[preReleaseVersion.platform]'), 'IOS');
  assert.ok(!query.get('include').includes('Tester'));
});

test('client refuses arbitrary destinations before generating credentials or fetching', async () => {
  let calls = 0;
  const client = appleClient(credentials, {
    fetch: async () => {
      calls++;
    },
  });
  for (const path of [
    'https://evil.invalid/v1/apps',
    '//evil.invalid',
    '/v1/../evil',
    '/v1/apps#fragment',
    '/v1/apps?x=\nsecret',
  ]) {
    await assert.rejects(client(path), /invalid_path/);
  }
  assert.equal(calls, 0);
});

test('redirects, HTTP errors, response overflow, bad JSON and network errors are sanitized', async () => {
  for (const [response, code] of [
    [
      () => new Response('SECRET', { status: 302, headers: { Location: 'https://evil.invalid' } }),
      'http_302',
    ],
    [() => new Response('SECRET', { status: 403 }), 'http_403'],
    [() => new Response('SECRET'), 'invalid_json'],
    [() => new Response('x'.repeat(1024 * 1024 + 1)), 'response_too_large'],
    [
      () => {
        throw Error('SECRET token');
      },
      'request_failed',
    ],
  ]) {
    const client = appleClient(credentials, { fetch: async () => response() });
    await assert.rejects(
      client('/v1/apps'),
      (error) => error.message === code && !error.stack.includes('SECRET'),
    );
  }
});

test('request timeout covers a stalled response body', async () => {
  const client = appleClient(credentials, {
    timeoutMs: 15,
    fetch: async (_url, { signal }) =>
      new Response(
        new ReadableStream({
          start(controller) {
            signal.addEventListener('abort', () => controller.error(Error('SECRET')), {
              once: true,
            });
          },
        }),
      ),
  });
  await assert.rejects(client('/v1/apps'), /request_failed/);
});

test('polling permits processing transitions but never resends or modifies anything', async () => {
  let clock = now;
  let polls = 0;
  let sleeps = 0;
  const client = async (path) => {
    if (path.startsWith('/v1/apps')) return { data: [app] };
    const doc = builds();
    if (++polls < 3) doc.data[0].attributes.processingState = 'PROCESSING';
    return doc;
  };
  const result = await waitForBuild(client, target, {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      sleeps++;
    },
  });
  assert.equal(result.status, 'testing_available');
  assert.equal(polls, 3);
  assert.equal(sleeps, 2);
});

test('polling is bounded for rate limits, absent builds and a clock that stalls', async () => {
  for (const mode of ['absent', 'rate_limit']) {
    let calls = 0;
    const result = await waitForBuild(
      async (path) => {
        calls++;
        if (path.startsWith('/v1/apps')) return { data: [app] };
        if (mode === 'rate_limit') throw Error('http_429');
        return { data: [] };
      },
      target,
      { now: () => now, sleep: async () => {} },
    );
    assert.equal(result.status, 'timed_out');
    assert.equal(result.physicalInstallationVerified, false);
    assert.ok(calls <= 61);
  }
});

test('initial app rate limits share the bounded retry window', async () => {
  let appCalls = 0;
  let sleeps = 0;
  const result = await waitForBuild(
    async (path) => {
      if (path.startsWith('/v1/apps')) {
        if (++appCalls === 1) throw Error('http_429');
        return { data: [app] };
      }
      return builds();
    },
    target,
    {
      now: () => now,
      sleep: async () => {
        sleeps++;
      },
    },
  );
  assert.equal(result.status, 'testing_available');
  assert.equal(appCalls, 2);
  assert.equal(sleeps, 1);
  let attempts = 0;
  const throttled = await waitForBuild(
    async () => {
      attempts++;
      throw Error('http_429');
    },
    target,
    { now: () => now, sleep: async () => {} },
  );
  assert.equal(throttled.status, 'timed_out');
  assert.equal(throttled.lastStatus, 'rate_limited');
  assert.equal(attempts, 60);
});

test('app identity ambiguity, pagination and bad CLI targets fail before build lookup', async () => {
  for (const data of [
    { data: [] },
    { data: [app, app] },
    { data: [{ ...app, attributes: { bundleId: 'foreign' } }] },
    { data: [app], links: { next: 'https://foreign.invalid' } },
  ]) {
    await assert.rejects(
      waitForBuild(async () => data, target),
      /app_mismatch/,
    );
  }
  for (const invalid of [
    { build: '1910; echo secret', version: '0.3.0' },
    { build: '1910', version: '0.3.0\n' },
  ]) {
    await assert.rejects(
      waitForBuild(async () => {
        throw Error('must not query');
      }, invalid),
      /invalid_target/,
    );
  }
});

test('workflow protects signing credentials and does not trigger binary upload', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/testflight-status.yml', import.meta.url),
    'utf8',
  );
  assert.match(
    workflow,
    /github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'/,
  );
  assert.match(workflow, /environment: release-signing/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /node --test scripts\/testflight-status.test.mjs/);
  assert.match(workflow, /trap .* EXIT/);
  assert.match(workflow, /umask 077/);
  assert.doesNotMatch(workflow, /testflight\.sh|pull_request_target|actions: write/);
});

test('actual CLI configuration failure exits nonzero with a sanitized receipt', () => {
  const directory = mkdtempSync(join(tmpdir(), 'testflight-status-test-'));
  try {
    const path = join(directory, 'receipt.json');
    const result = spawnSync(
      process.execPath,
      [new URL('./testflight-status.mjs', import.meta.url).pathname, '1910', '0.3.0', path],
      {
        encoding: 'utf8',
        timeout: 5000,
        env: {
          ...process.env,
          APPLE_API_KEY: 'SECRET',
          APPLE_API_ISSUER: 'SECRET',
          APPLE_API_KEY_PATH: join(directory, 'SECRET-missing-key.p8'),
        },
      },
    );
    assert.equal(result.status, 2);
    assert.doesNotMatch(result.stdout + result.stderr, /SECRET|ENOENT|Bearer/);
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {
      status: 'verification_failed',
      error: 'configuration_failed',
      physicalInstallationVerified: false,
    });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
