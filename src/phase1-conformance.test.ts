import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, test } from 'vitest';
import { verifyFrozenPackedConsumer } from '../scripts/contract-canary.mjs';
import { REQUIRED_PHASE1_ASSERTION_IDS } from '../scripts/phase1-artifact-secret-scan.mjs';
import {
  assertCompatibilityFailure,
  assertExactAssertionResults,
  assertNativeMissingKeychainResponses,
  assertPairingStatus,
  buildPhase1Report,
  CommandExecutionError,
  cargoBuildTimeoutMs,
  classifyCavePackageFailure,
  cloneExactCheckout,
  NativeRpcClient,
  parseArgs,
  parseCaveConformanceOutput,
  recordCaveMatrixFailure,
  safeEnvironment,
  scrubEvidenceAuthorizationEnvironment,
  withFixtureDaemon,
  withOwnedArtifactRoot,
  wrapInfrastructureFailure,
} from '../scripts/phase1-conformance.mjs';
import { createProcessOwnedArtifactRoot } from '../scripts/process-owned-artifact-root.mjs';

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
  test.skipIf(process.platform === 'win32')(
    'clones local sources without invoking their upload-pack hook',
    async () => {
      const source = mkdtempSync(join(tmpdir(), 'phase1-local-source-'));
      const owned = createProcessOwnedArtifactRoot({ prefix: 'phase1-local-clone-test' });
      const marker = join(source, 'upload-pack-hook-ran');
      const hook = join(source, 'upload-pack-hook.sh');
      try {
        execFileSync('git', ['init', '--initial-branch=main'], { cwd: source });
        execFileSync('git', ['config', 'user.name', 'OpenCoven Test'], { cwd: source });
        execFileSync('git', ['config', 'user.email', 'opencoven-test@example.com'], {
          cwd: source,
        });
        writeFileSync(join(source, 'tracked.txt'), 'committed\n');
        execFileSync('git', ['add', 'tracked.txt'], { cwd: source });
        execFileSync('git', ['commit', '-m', 'fixture'], { cwd: source });
        writeFileSync(
          hook,
          `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\nexec git pack-objects "$@"\n`,
        );
        chmodSync(hook, 0o755);
        execFileSync('git', ['config', 'uploadpack.packObjectsHook', hook], {
          cwd: source,
        });
        const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: source,
          encoding: 'utf8',
        }).trim();
        const destination = join(owned.rootPath, 'checkout');

        await cloneExactCheckout({
          artifactRoot: owned,
          sourceRoot: source,
          destinationRoot: destination,
          repository: 'OpenCoven/chat',
          revision,
          environment: process.env,
          label: 'local source fixture',
        });

        expect(existsSync(marker)).toBe(false);
        expect(
          execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: destination,
            encoding: 'utf8',
          }).trim(),
        ).toBe(revision);
      } finally {
        await owned.cleanup();
        rmSync(source, { recursive: true, force: true });
      }
    },
  );

  test('scrubs OIDC and GitHub bearer variables before evidence work begins', () => {
    const environment = {
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-token',
      ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.invalid',
      GH_TOKEN: 'gh-token',
      GITHUB_TOKEN: 'github-token',
      PATH: '/trusted/bin',
    };

    expect(scrubEvidenceAuthorizationEnvironment(environment)).toEqual({
      PATH: '/trusted/bin',
    });
  });

  test('reuses the frozen packed-consumer verifier without rebuilding SDK tarballs', () => {
    expect(verifyFrozenPackedConsumer).toBeTypeOf('function');
  });

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

  test('parses the protected schema-v2 platform invocation without legacy output flags', () => {
    expect(
      parseArgs([
        '--validator-revision',
        'd'.repeat(40),
        '--platform',
        'darwin-arm64',
        '--output',
        './.artifacts/client-v1-conformance-darwin-arm64.json',
      ]),
    ).toMatchObject({
      platform: 'darwin-arm64',
      validatorRevision: 'd'.repeat(40),
      outputPath: expect.stringContaining('.artifacts/client-v1-conformance-darwin-arm64.json'),
    });
    expect(() =>
      parseArgs(['--validator-revision', 'd'.repeat(40), '--platform', 'linux-x64']),
    ).toThrow(/requires --output/u);
    expect(() =>
      parseArgs([
        '--platform',
        'linux-x64',
        '--output',
        './.artifacts/client-v1-conformance-linux-x64.json',
      ]),
    ).toThrow(/requires --validator-revision/u);
    expect(() =>
      parseArgs([
        '--validator-revision',
        'D'.repeat(40),
        '--platform',
        'darwin-arm64',
        '--output',
        './.artifacts/client-v1-conformance-darwin-arm64.json',
      ]),
    ).toThrow(/lowercase immutable 40-character commit SHA/u);
    expect(() =>
      parseArgs([
        '--platform',
        'darwin-arm64',
        '--validator-revision',
        'd'.repeat(40),
        '--output',
        './.artifacts/client-v1-conformance-linux-x64.json',
      ]),
    ).toThrow(/must match the platform/u);
    expect(() =>
      parseArgs([
        '--platform',
        'darwin-arm64',
        '--validator-revision',
        'd'.repeat(40),
        '--output',
        './.artifacts/client-v1-conformance-darwin-arm64.json',
        '--retain-sanitized-report',
        './legacy.json',
      ]),
    ).toThrow(/cannot combine/u);
    expect(() => parseArgs(['--validator-revision', 'd'.repeat(40), '--scenario', 'all'])).toThrow(
      /only valid with schema-v2/u,
    );
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
    const toolchainBin = join(root, 'toolchain', 'bin');
    const cargoPath = join(toolchainBin, 'cargo');
    const originalPath = process.env.PATH;
    try {
      mkdirSync(toolchainBin, { recursive: true });
      writeFileSync(cargoPath, '');
      process.env.PATH = '';

      const environment = safeEnvironment(root, {}, cargoPath);
      const resolvedToolchainBin = dirname(realpathSync(cargoPath));

      expect(environment.CARGO_HOME).toBe(resolve(root, 'cargo-home'));
      expect(environment.RUSTUP_HOME).toBeUndefined();
      expect(environment.HOME).toBe(resolve(root, 'home'));
      expect(environment.PATH).toBe(resolvedToolchainBin);
      expect(environment.RUSTC).toBe(join(resolvedToolchainBin, 'rustc'));
      expect(environment.RUSTDOC).toBe(join(resolvedToolchainBin, 'rustdoc'));
    } finally {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true });
    }
  });

  test('allows cold isolated Cargo builds to exceed the general command deadline', () => {
    expect(cargoBuildTimeoutMs).toBeGreaterThan(20 * 60_000);
  });

  test.each([
    ['timeout while receiving message from process', 'turbopack-plugin-timeout'],
    [
      'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
      'memory-exhausted',
    ],
    ['write failed: ENOSPC', 'disk-exhausted'],
    ['command terminated by SIGKILL', 'process-killed'],
    ['TurbopackInternalError: worker panicked', 'compiler-crash'],
    ['Build worker exited unexpectedly', 'worker-exited'],
    ['Failed to collect page data for /api/client/v1/health', 'page-data-failed'],
    ['Failed to compile.', 'compile-failed'],
  ])('classifies Cave package failures without retaining output', (stderr, expected) => {
    expect(classifyCavePackageFailure({ stdout: '', stderr })).toBe(expected);
  });

  test('does not classify unknown Cave package output', () => {
    expect(
      classifyCavePackageFailure({ stdout: 'arbitrary private output', stderr: '' }),
    ).toBeUndefined();
  });
});
