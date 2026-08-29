import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, test } from 'vitest';

import { REQUIRED_PHASE1_ASSERTION_IDS } from '../scripts/phase1-artifact-secret-scan.mjs';
import {
  assertCompatibilityFailure,
  assertExactAssertionResults,
  assertNativeMissingKeychainResponses,
  assertPairingStatus,
  buildPhase1Report,
  CommandExecutionError,
  cargoBuildTimeoutMs,
  NativeRpcClient,
  parseArgs,
  parseCaveConformanceOutput,
  recordCaveMatrixFailure,
  safeEnvironment,
  withFixtureDaemon,
  withOwnedArtifactRoot,
  wrapInfrastructureFailure,
} from '../scripts/phase1-conformance.mjs';

class SynchronousCloseChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stdin = {
    write: (line: string) => {
      const request = JSON.parse(line) as { id: string };
      this.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result: {} })}\n`);
      this.exitCode = 0;
      this.emit('close', 0, null);
      return true;
    },
  };
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
}

class SynchronousNonZeroCloseChild extends SynchronousCloseChild {
  override readonly stdin = {
    write: (line: string) => {
      const request = JSON.parse(line) as { id: string };
      this.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result: {} })}\n`);
      this.exitCode = 7;
      this.emit('close', 7, null);
      return true;
    },
  };
}

class NeverCloseChild extends SynchronousCloseChild {
  override readonly stdin = {
    write: (line: string) => {
      const request = JSON.parse(line) as { id: string };
      this.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result: {} })}\n`);
      return true;
    },
  };
}

function passingAssertions(): Array<{
  id: string;
  status: 'passed' | 'failed' | 'blocked';
  diagnosticIds: string[];
}> {
  return REQUIRED_PHASE1_ASSERTION_IDS.map((id) => ({
    id,
    status: 'passed' as const,
    diagnosticIds: ['phase1.assertion.passed'],
  }));
}

function assertionAt(assertions: ReturnType<typeof passingAssertions>, index: number) {
  const assertion = assertions[index];
  if (assertion === undefined) {
    throw new Error(`missing test assertion at index ${index}`);
  }
  return assertion;
}

describe('Phase 1 real-authority conformance harness', () => {
  test('requires every assertion ID exactly once with no skipped result', () => {
    const assertions = passingAssertions();
    expect(assertExactAssertionResults(assertions)).toEqual(assertions);

    expect(() => assertExactAssertionResults(assertions.slice(1))).toThrow(
      /missing required assertion ID/,
    );
    expect(() => assertExactAssertionResults([...assertions, assertionAt(assertions, 0)])).toThrow(
      /duplicate assertion ID/,
    );
    expect(() =>
      assertExactAssertionResults([
        ...assertions.slice(1),
        {
          id: 'phase1.unexpected',
          status: 'passed',
          diagnosticIds: ['phase1.assertion.passed'],
        },
      ]),
    ).toThrow(/unexpected assertion ID/);
    expect(() =>
      assertExactAssertionResults([
        { ...assertionAt(assertions, 0), status: 'skipped' as never },
        ...assertions.slice(1),
      ]),
    ).toThrow(/skipped assertion/);
  });

  test('builds the approved sanitized report and derives a blocked summary', () => {
    const assertions = passingAssertions();
    assertions[8] = {
      ...assertionAt(assertions, 8),
      status: 'blocked',
      diagnosticIds: ['phase1.producer.compatibility-control-unavailable'],
    };

    const report = buildPhase1Report({
      assertions,
      revisions: {
        chat: '0'.repeat(40),
        sdk: '1'.repeat(40),
        cave: '2'.repeat(40),
        coven: '3'.repeat(40),
      },
      artifactDigests: {
        'chat-native-rpc': 'a'.repeat(64),
      },
      versions: {
        harness: '1.0.0',
        node: process.versions.node,
      },
    });

    expect(report.status).toBe('blocked');
    expect(report.completed).toBe(true);
    expect(report.summary).toEqual({
      required: REQUIRED_PHASE1_ASSERTION_IDS.length,
      passed: REQUIRED_PHASE1_ASSERTION_IDS.length - 1,
      failed: 0,
      blocked: 1,
      skipped: 0,
    });
    expect(report.diagnosticIds).toEqual(['phase1.conformance.blocked']);
  });

  test('parses only the complete all-scenario command line', () => {
    expect(
      parseArgs([
        '--lock',
        './phase1-conformance.lock.json',
        '--scenario',
        'all',
        '--retain-sanitized-report',
        './test-results/phase1-conformance/report.json',
      ]),
    ).toMatchObject({
      scenario: 'all',
      lockPath: expect.stringContaining('phase1-conformance.lock.json'),
      retainSanitizedReport: expect.stringContaining('report.json'),
    });

    expect(() => parseArgs(['--scenario', 'pairing-only'])).toThrow(
      /only --scenario all is supported/,
    );
    expect(() => parseArgs(['--unknown'])).toThrow(/unknown option/);
  });

  test('parses Cave assertion output without retaining diagnostic prose', () => {
    const parsed = parseCaveConformanceOutput(
      [
        'client-v1-conformance: phase B on http://127.0.0.1:54321',
        'ok pairing.poll-pending — private detail omitted by the caller',
        'ok pairing.admin-approve',
        'FAIL pairing.exchange — response included sensitive prose',
        'skip reads.messages-canonical-conversation-id — platform condition',
      ].join('\n'),
    );

    expect(parsed.get('pairing.poll-pending')).toBe('passed');
    expect(parsed.get('pairing.admin-approve')).toBe('passed');
    expect(parsed.get('pairing.exchange')).toBe('failed');
    expect(parsed.get('reads.messages-canonical-conversation-id')).toBe('skipped');
    expect([...parsed.keys()].join(' ')).not.toContain('private detail');
  });

  test('accepts pairing denial as a successful status envelope', () => {
    expect(assertPairingStatus({ status: 'denied' }, 'denied')).toEqual({ status: 'denied' });
    expect(() => assertPairingStatus({ status: 'pending' }, 'denied')).toThrow(
      /pairing status was pending instead of denied/,
    );
  });

  test('accepts only the SDK incompatible-version failure from compatibility presets', () => {
    expect(assertCompatibilityFailure({ code: 'incompatible_version' }, 'api-major')).toEqual({
      code: 'incompatible_version',
    });
    expect(() =>
      assertCompatibilityFailure({ code: 'invalid_response' }, 'minimum-client'),
    ).toThrow(/minimum-client preset did not produce incompatible_version/);
    expect(() => assertCompatibilityFailure(undefined, 'api-major')).toThrow(
      /api-major preset did not produce incompatible_version/,
    );
  });

  test('compares native missing-keychain responses structurally instead of by key order', () => {
    expect(
      assertNativeMissingKeychainResponses([
        {
          error: { retryable: true, code: 'secure_store_unavailable' },
          ok: false,
          id: 'installation',
        },
        {
          result: { status: 'shutting_down' },
          ok: true,
          id: 'shutdown',
        },
      ]),
    ).toHaveLength(2);
  });

  test('observes a native RPC child that closes synchronously during shutdown', async () => {
    const client = new NativeRpcClient(new SynchronousCloseChild());

    const outcome = await Promise.race([
      client.close().then(() => 'closed'),
      new Promise<'timed-out'>((resolveTimeout) =>
        setTimeout(() => resolveTimeout('timed-out'), 50),
      ),
    ]);

    expect(outcome).toBe('closed');
  });

  test('rejects a native RPC child that exits unsuccessfully during shutdown', async () => {
    const client = new NativeRpcClient(new SynchronousNonZeroCloseChild());

    await expect(client.close()).rejects.toThrow(/exit code 7/);
  });

  test('rejects a native RPC child that crashed before shutdown began', async () => {
    const child = new SynchronousCloseChild();
    child.exitCode = 7;
    const client = new NativeRpcClient(child);

    await expect(client.close()).rejects.toThrow(/exit code 7/);
  });

  test('bounds native RPC shutdown when the child never closes', async () => {
    const client = new NativeRpcClient(new NeverCloseChild(), { shutdownTimeoutMs: 10 });

    await expect(client.close()).rejects.toThrow(/shutdown timed out/);
  });

  test('closes the fixture daemon when native scenario setup fails', async () => {
    let closed = false;
    const fixtureDaemon = {
      close: async () => {
        closed = true;
      },
    };

    await expect(
      withFixtureDaemon(fixtureDaemon, async () => {
        throw new Error('native setup failed');
      }),
    ).rejects.toThrow(/native setup failed/);
    expect(closed).toBe(true);
  });

  test('preserves a failed Cave subprocess as an infrastructure failure', () => {
    const results = new Map();
    const failure = new CommandExecutionError('Cave Client v1 conformance', {
      stdout: ['ok pairing.ttl-poll-expired', 'ok pairing.ttl-exchange-expired'].join('\n'),
    });

    expect(recordCaveMatrixFailure(results, failure)).toBe(failure);
    expect(results.get('phase1.pairing.expiry')).toMatchObject({ status: 'failed' });
  });

  test('classifies subprocess failures without exposing captured output', () => {
    const timeout = new CommandExecutionError('Chat native RPC package', {
      reason: 'timeout',
      stderr: 'private compiler output',
    });

    expect(timeout.message).toBe('Chat native RPC package failed (timeout).');
    expect(timeout.message).not.toContain('private compiler output');
  });

  test('preserves safe subprocess classification when attaching the final report', () => {
    const report = { status: 'failed' };
    const original = new CommandExecutionError('Cave real-authority conformance', {
      reason: 'timeout',
      stdout: 'private output',
      stderr: 'private error',
    });

    const wrapped = wrapInfrastructureFailure(original, report);

    expect(wrapped.message).toBe('Cave real-authority conformance failed (timeout).');
    expect(wrapped.result).toEqual({ reason: 'timeout', report });
  });

  test('cleans an owned root when setup fails before its child starts', async () => {
    let cleaned = false;
    const ownedRoot = {
      cleanup: async () => {
        cleaned = true;
      },
    };

    await expect(
      withOwnedArtifactRoot(ownedRoot, async () => {
        throw new Error('spawn failed');
      }),
    ).rejects.toThrow(/spawn failed/);
    expect(cleaned).toBe(true);
  });

  test('isolates Cargo credentials while using the resolved Rust toolchain', () => {
    const root = mkdtempSync(join(tmpdir(), 'phase1-safe-environment-'));
    try {
      const environment = safeEnvironment(root);

      expect(environment.CARGO_HOME).toBe(resolve(root, 'cargo-home'));
      expect(environment.RUSTUP_HOME).toBeUndefined();
      expect(environment.HOME).toBe(resolve(root, 'home'));
    } finally {
      rmSync(root, { recursive: true });
    }
  });

  test('allows cold isolated Cargo builds to exceed the general command deadline', () => {
    expect(cargoBuildTimeoutMs).toBeGreaterThan(20 * 60_000);
  });
});
