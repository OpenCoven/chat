import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, test } from 'vitest';

import {
  normalizeWindowsRealPathForProcess,
  quoteWindowsBatchCommand,
} from '../scripts/executable-resolution.mjs';
import {
  adoptNativeCleanupReservation,
  assertExecutingHarnessAuthority,
  assertNoNodeRuntimeInjection,
  assertPairingStatus,
  assertProductionAdapterAtRevision,
  CommandExecutionError,
  cargoBuildTimeoutMs,
  caveBuildEnvironment,
  classifyPackagingCommandFailure,
  createCleanupAdoptionRecovery,
  diagnoseCovenLifecycleFailure,
  finalizeOperatorSafety,
  NativeRpcClient,
  nativeAdapterTestEnvironment,
  nativeMissingKeychainFailureDiagnostic,
  nativeMissingKeychainResponsesValid,
  observeReleaseToolVersions,
  parseArgs,
  parseCaveConformanceOutput,
  parsePassedRustTests,
  parseSupervisorStatusFrame,
  publicPhase1FailureDiagnostic,
  recordCaveMatrixFailure,
  resolveLockedCovenDaemonCommand,
  resolveRustupHome,
  runNativeScenarioOrchestrator,
  runOwnedProcessStatusForTest,
  runReservedNativePairing,
  runSupervisedCommandForTest,
  safeEnvironment,
  snapshotOperatorState,
  throwNativeScenarioFailures,
  validateSupervisorArtifactFile,
  withFixtureDaemon,
  withOwnedArtifactRoot,
  wrapInfrastructureFailure,
} from '../scripts/phase1-conformance.mjs';
import { readPhase1ConformanceLock } from '../scripts/phase1-conformance-lock.mjs';
import { createProcessOwnedArtifactRoot } from '../scripts/process-owned-artifact-root.mjs';

const projectRoot = resolve(import.meta.dirname, '..');

function processIsLive(pid: number) {
  try {
    const state = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
    }).trim();
    return state.length > 0 && !state.startsWith('Z');
  } catch {
    return false;
  }
}

async function waitForPidFile(path: string) {
  const deadline = Date.now() + 5_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) {
      throw new Error('descendant PID was not published');
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  return Number(readFileSync(path, 'utf8'));
}

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

class SynchronousSupervisorCloseChild extends SynchronousCloseChild {
  readonly __phase1SupervisorStatus = Promise.resolve({
    code: 0,
    signal: null,
    reason: 'exit',
  });
  override readonly stdin = {
    write: (line: string) => {
      const request = JSON.parse(line) as { id: string };
      this.stdout.write(`${JSON.stringify({ id: request.id, ok: true, result: {} })}\n`);
      this.signalCode = 'SIGKILL';
      this.emit('close', null, 'SIGKILL');
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

describe('Phase 1 real-authority conformance harness', () => {
  test('uses Chat native coven_health and never the Coven status CLI for identity proof', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '..', 'scripts', 'phase1-conformance.mjs'),
      'utf8',
    );

    expect(source).toContain("rpc.ok('coven_health'");
    expect(source).toContain("rpc.error('coven_health'");
    expect(source).not.toContain("['daemon', 'status'");
    expect(source).not.toContain('daemon authenticated status');
    expect(source).not.toContain('error instanceof Error ? error.message');
    expect(source).toContain('phase1-process-supervisor.mjs');
    expect(source).toContain('detached: !windowsSupervised');
    expect(source).toContain('trackChild(child)');
    expect(source).toContain('lockedCovenCheckoutRoot: roots.covenRoot');
    expect(source).toContain('cwd: covenCommand.cwd');
  });

  test.skipIf(process.platform === 'win32')(
    'resolves and runs the Coven daemon command from the explicit owned locked checkout',
    async () => {
      const root = resolve(
        process.cwd(),
        'test-results',
        'phase1-coven-command-root',
        randomUUID(),
      );
      const covenRoot = resolve(root, 'checkouts', 'coven');
      const marker = resolve(root, 'command.json');
      const tracked: import('node:child_process').ChildProcess[] = [];
      try {
        mkdirSync(covenRoot, { recursive: true });
        execFileSync('git', ['init', '--quiet'], { cwd: covenRoot });
        writeFileSync(
          resolve(covenRoot, 'daemon'),
          [
            "import{writeFileSync}from'node:fs';",
            'writeFileSync(process.env.MARKER,JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)}));',
          ].join(''),
        );
        execFileSync('git', ['add', 'daemon'], { cwd: covenRoot });
        execFileSync(
          'git',
          [
            '-c',
            'user.name=Phase1 Test',
            '-c',
            'user.email=phase1@example.invalid',
            '-c',
            'commit.gpgsign=false',
            'commit',
            '--quiet',
            '-m',
            'fixture',
          ],
          { cwd: covenRoot },
        );
        const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: covenRoot,
          encoding: 'utf8',
        }).trim();
        expect(() =>
          resolveLockedCovenDaemonCommand(
            { rootPath: root },
            covenRoot,
            'f'.repeat(40),
            process.execPath,
          ),
        ).toThrow('Coven command root does not match the locked revision.');
        const command = resolveLockedCovenDaemonCommand(
          { rootPath: root },
          covenRoot,
          revision,
          process.execPath,
        );

        expect(command).toEqual({
          executable: realpathSync(process.execPath),
          args: ['daemon', 'serve'],
          cwd: covenRoot,
        });
        await runSupervisedCommandForTest(
          {
            rootPath: root,
            trackChild(child) {
              tracked.push(child);
            },
          },
          command.executable,
          command.args,
          {
            cwd: command.cwd,
            env: { ...process.env, MARKER: marker },
            timeoutMs: 5_000,
            outputLimitBytes: 4_096,
          },
        );
        expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({
          cwd: realpathSync(covenRoot),
          args: ['serve'],
        });
        expect(tracked).toHaveLength(1);
        expect(tracked[0]?.exitCode ?? tracked[0]?.signalCode).not.toBeNull();
      } finally {
        for (const child of tracked) {
          if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await new Promise<void>((resolveClose) => child.once('close', () => resolveClose()));
          }
        }
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test('rejects missing and wrong explicit Coven checkout roots', () => {
    const root = resolve(process.cwd(), 'test-results', 'phase1-coven-command-root', randomUUID());
    const wrongRoot = resolve(root, 'checkouts', 'not-coven');
    try {
      mkdirSync(wrongRoot, { recursive: true });
      expect(() =>
        resolveLockedCovenDaemonCommand(
          { rootPath: root },
          undefined as never,
          '0'.repeat(40),
          process.execPath,
        ),
      ).toThrow('Locked Coven checkout root must be a non-empty path string.');
      expect(() =>
        resolveLockedCovenDaemonCommand(
          { rootPath: root },
          wrongRoot,
          '0'.repeat(40),
          process.execPath,
        ),
      ).toThrow('Coven command root is not the owned locked checkout.');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects every cmd metacharacter and quotes valid spaced batch tokens canonically', () => {
    for (const token of ['&', '|', '<', '>', '(', ')', '^', '%', '!', '"', '\r', '\n', '\0']) {
      expect(() => quoteWindowsBatchCommand('C:\\safe\\tool.cmd', [`payload${token}`])).toThrow(
        'Windows batch invocation contains an unsafe token.',
      );
      expect(() => quoteWindowsBatchCommand(`C:\\safe\\tool${token}.cmd`, ['safe'])).toThrow(
        'Windows batch invocation contains an unsafe token.',
      );
    }
    expect(quoteWindowsBatchCommand('C:\\safe spaced\\tool.cmd', ['valid spaced arg'])).toBe(
      'call "C:\\safe spaced\\tool.cmd" "valid spaced arg"',
    );
  });

  test('normalizes Windows drive namespace paths without accepting network namespaces', () => {
    expect(normalizeWindowsRealPathForProcess('\\\\?\\C:\\safe path\\tool.cmd')).toBe(
      'C:\\safe path\\tool.cmd',
    );
    expect(normalizeWindowsRealPathForProcess('\\\\?\\UNC\\server\\share\\tool.cmd')).toBe(
      '\\\\?\\UNC\\server\\share\\tool.cmd',
    );
  });

  test('consumes frozen SDK artifacts instead of rebuilding release tarballs', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '..', 'scripts', 'phase1-conformance.mjs'),
      'utf8',
    );

    expect(source).not.toContain('packPublicPackages');
    expect(source).not.toContain('package-artifacts.mjs');
    expect(source).toContain('sdkArtifacts');
    expect(source).toContain('assertSdkCandidateProvenance');
    expect(source).toContain("'--ignore-workspace'");
  });

  test('runs locked producer and Chat adapter tests before emitting platform assertions', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '..', 'scripts', 'phase1-conformance.mjs'),
      'utf8',
    );

    expect(source).toContain("'Chat native adapter tests'");
    expect(source).toContain(`\`Coven producer client \${group} tests\``);
    expect(source).toContain("'--package', 'coven-client'");
    expect(source).toContain('createAssertionRecorder');
    expect(source).not.toContain('passingAssertions');
    expect(source).toContain('phase1.sdk-candidate.');
    expect(source).toContain('phase1.sdk-manifest.');
    expect(source).toContain('phase1.toolchain.rust.');
    expect(source).not.toContain('spawn(command, args');
    expect(source.match(/\bspawn\(/gu)).toHaveLength(2);
    expect(source).toContain('configuredWindowsSupervisorPath');
  });

  test.skipIf(process.platform === 'win32')(
    'keeps locked Coven lifecycle sockets within the Darwin path limit',
    async () => {
      const source = readFileSync(
        resolve(import.meta.dirname, '..', 'scripts', 'phase1-conformance.mjs'),
        'utf8',
      );
      expect(source).toContain(
        "createProcessOwnedArtifactRoot({ prefix: 'p1run', shortPath: true })",
      );
      expect(source).toContain(
        "createProcessOwnedArtifactRoot({ prefix: 'p1boot', shortPath: true })",
      );

      const root = createProcessOwnedArtifactRoot({
        prefix: 'p1run',
        shortPath: true,
      });
      try {
        const socketPath = resolve(
          root.rootPath,
          'checkouts',
          'coven',
          'c',
          `r${'f'.repeat(32)}`,
          'coven.sock',
        );
        expect(Buffer.byteLength(socketPath)).toBeLessThan(104);
      } finally {
        await root.cleanup();
      }
    },
  );

  test('builds the conformance driver around production adapter bytes from the locked Chat commit', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '..', 'scripts', 'phase1-conformance.mjs'),
      'utf8',
    );

    expect(source).toContain('assertProductionAdapterAtRevision');
    expect(source).toContain('assertProductionChatAuthority');
    expect(source).toContain("'merge-base', '--is-ancestor'");
    expect(source).toContain('lock.chatAuthority.tree');
    expect(source).toContain("'src-tauri/src/coven.rs'");
    expect(source).toContain("'src-tauri/src/bin/phase1-native-rpc.rs'");
    expect(source).toContain("resolve(roots.chatHarnessRoot, 'src-tauri', 'Cargo.toml')");
    expect(source).not.toContain("resolve(projectRoot, 'src-tauri', 'Cargo.toml')");
  });

  test.skipIf(process.platform === 'win32')(
    'accepts the exact detached harness authority and rejects dirty executable or native delta bytes',
    () => {
      const lock = readPhase1ConformanceLock();
      const root = resolve(process.cwd(), 'test-results', 'phase1-harness-authority', randomUUID());
      const harnessRoot = resolve(root, 'harness');
      try {
        mkdirSync(root, { recursive: true });
        execFileSync('git', ['clone', '--quiet', '--no-checkout', projectRoot, harnessRoot]);
        execFileSync('git', ['checkout', '--quiet', '--detach', lock.harness.revision], {
          cwd: harnessRoot,
        });
        const verifiedEnvironment = {
          ...process.env,
          OPENCOVEN_PHASE1_VERIFIED_RUNNER: '1',
          OPENCOVEN_PHASE1_VERIFIED_RUNNER_ROOT: harnessRoot,
        };

        expect(() =>
          assertExecutingHarnessAuthority(lock, harnessRoot, verifiedEnvironment),
        ).not.toThrow();
        expect(() => assertProductionAdapterAtRevision(harnessRoot, lock)).not.toThrow();

        const runner = resolve(harnessRoot, 'scripts', 'phase1-conformance.mjs');
        appendFileSync(runner, '\n// substituted\n');
        expect(() =>
          assertExecutingHarnessAuthority(lock, harnessRoot, verifiedEnvironment),
        ).toThrow('Executing Phase 1 harness module does not match its immutable authority.');
        execFileSync('git', ['checkout', '--quiet', '--', 'scripts/phase1-conformance.mjs'], {
          cwd: harnessRoot,
        });

        const nativeEntrypoint = resolve(
          harnessRoot,
          'src-tauri',
          'src',
          'bin',
          'phase1-native-rpc.rs',
        );
        appendFileSync(nativeEntrypoint, '\n// substituted\n');
        expect(() => assertProductionAdapterAtRevision(harnessRoot, lock)).toThrow(
          'Chat conformance native delta does not match its immutable allowlist.',
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test('uses production keyring custody and a new RPC process for restart reuse', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '..', 'scripts', 'phase1-conformance.mjs'),
      'utf8',
    );

    expect(source).toContain(
      "OPENCOVEN_PHASE1_CONFORMANCE_NATIVE_PROVIDER_PRESET: 'production-keyring'",
    );
    const nativeScenario = source.slice(
      source.indexOf('async function runNativeScenarios'),
      source.indexOf('export function resolveLockedCovenDaemonCommand'),
    );
    expect(nativeScenario).toContain('...nativeAdapterTestEnvironment(environment)');
    const emergencyCleanupBoundary = source.slice(
      source.indexOf('async function runEmergencyNativeCredentialCleanup'),
      source.indexOf('const cleanupCapabilityPattern'),
    );
    expect(emergencyCleanupBoundary).toContain('...nativeAdapterTestEnvironment(environment)');
    const nativeStages = [
      "activeNativeStage = 'restart'",
      "activeNativeStage = 'restart-rpc-start'",
      "activeNativeStage = 'restart-discovery'",
      "activeNativeStage = 'restart-health'",
      "activeNativeStage = 'restart-cleanup-adoption'",
      "activeNativeStage = 'restart-status'",
      "activeNativeStage = 'restart-handoff-close'",
      "activeNativeStage = 'restart-launch'",
      "activeNativeStage = 'restart-rediscovery'",
      "activeNativeStage = 'restart-restarted-health'",
      "activeNativeStage = 'restart-restarted-status'",
      "activeNativeStage = 'restart-result'",
      "activeNativeStage = 'reads'",
      "activeNativeStage = 'reconciliation'",
      "activeNativeStage = 'revocation'",
      "activeNativeStage = 'revocation-delete'",
      "activeNativeStage = 'revocation-initial-status'",
      "activeNativeStage = 'revocation-rediscovery'",
      "activeNativeStage = 'revocation-health'",
      "activeNativeStage = 'revocation-status'",
      'activeNativeStage = `revocation-repair-${stage}`',
      "activeNativeStage = 'revocation-result'",
      "activeNativeStage = 'credential-cleanup'",
      "activeNativeStage = 'credential-cleanup-discovery'",
      "activeNativeStage = 'credential-cleanup-health'",
      "activeNativeStage = 'credential-cleanup-identity'",
      "activeNativeStage = 'credential-cleanup-forget'",
      "activeNativeStage = 'credential-cleanup-status'",
      "activeNativeStage = 'credential-cleanup-result'",
    ].map((stage) => nativeScenario.indexOf(stage));
    expect(nativeStages.every((stage) => stage >= 0)).toBe(true);
    expect(nativeStages).toEqual([...nativeStages].sort((left, right) => left - right));
    expect(source).toContain("'security', ['default-keychain', '-d', 'user']");
    expect(source).toContain('cave-client-v1:');
    expect(source).toContain("await rpc.ok('cave_forget_credential'");
    expect(source).toContain('credentialMayExist');
    expect(source).toContain("'conformance_delete_native_credential'");
    expect(source).toContain("'conformance_prepare_native_cleanup'");
    expect(source).toContain("'conformance_cancel_prepared_native_cleanup'");
    expect(source).toContain('runEmergencyNativeCredentialCleanup');
    const reservedBoundary = source.slice(
      source.indexOf('export async function runReservedNativePairing'),
      source.indexOf('async function runNativeScenarios'),
    );
    expect(reservedBoundary.indexOf('await establishNativeCleanupReservation')).toBeLessThan(
      reservedBoundary.indexOf("rpc.ok('cave_credential_status'"),
    );
    expect(reservedBoundary.indexOf("rpc.ok('cave_credential_status'")).toBeLessThan(
      reservedBoundary.indexOf('onCredentialMayExist()'),
    );
    expect(reservedBoundary.indexOf('onCredentialMayExist()')).toBeLessThan(
      reservedBoundary.indexOf('await pairNative('),
    );
    expect(source.indexOf('replacementRpc = await startNativeRpc')).toBeLessThan(
      source.indexOf('await previousRpc.close()'),
    );
    expect(source.indexOf('await adoptNativeCleanupReservation')).toBeLessThan(
      source.indexOf('await previousRpc.close()'),
    );
    const predecessorCloseIndex = nativeScenario.indexOf('await previousRpc.close()');
    const restartLaunchIndex = nativeScenario.indexOf(
      "await rpc.ok('cave_launch')",
      predecessorCloseIndex,
    );
    const closedPredecessorBoundary = nativeScenario.slice(
      predecessorCloseIndex,
      restartLaunchIndex,
    );
    expect(closedPredecessorBoundary).not.toContain("rpc.ok('cave_credential_status'");
    expect(source).not.toContain("await rpc.ok('conformance_reset_native_state')");
    expect(source).not.toContain('phase1-native-credential-store-not-addressed');
    expect(source).not.toContain('OPENCOVEN_PHASE1_NATIVE_CREDENTIAL_STORE_ISOLATED');
  });

  test.each(['command-failure', 'malformed-response', 'response-lost'] as const)(
    'reservation %s blocks the actual pairing and credential orchestration boundary',
    async (failureMode) => {
      let markerPresent = false;
      const rpcCalls: string[] = [];
      const approvals: string[] = [];
      const credentialMayExistTransitions: boolean[] = [];
      const pairingStages: string[] = [];
      let subsequentLifecycleCalls = 0;
      const rpc = {
        async request(command: string) {
          rpcCalls.push(command);
          expect(command).toBe('conformance_prepare_native_cleanup');
          if (failureMode === 'command-failure') {
            return { ok: false, error: { code: 'keychain_failure', retryable: false } };
          }
          markerPresent = true;
          if (failureMode === 'response-lost') {
            throw new Error('response lost');
          }
          return {
            ok: true,
            result: {
              reservationHandle: '00000000-0000-4000-8000-000000000001',
            },
          };
        },
        async ok(command: string) {
          rpcCalls.push(command);
          expect(command).toBe('conformance_cancel_prepared_native_cleanup');
          markerPresent = false;
          return { status: 'missing' };
        },
        operation() {
          throw new Error('pairing operation must remain unreachable');
        },
      };

      await expect(
        runNativeScenarioOrchestrator({
          runPairing: () =>
            runReservedNativePairing({
              rpc,
              handle: 'native-handle',
              origin: 'http://127.0.0.1:4310',
              adminToken: 'redacted-test-token',
              installationId: 'phase1-installation-test',
              approvePairing: async () => {
                approvals.push('approve');
              },
              onCredentialMayExist: () => {
                credentialMayExistTransitions.push(true);
              },
              onStage: (stage) => {
                pairingStages.push(stage);
              },
            }),
          runLifecycle: async () => {
            subsequentLifecycleCalls += 1;
          },
        }),
      ).rejects.toThrow('Native cleanup reservation could not be established.');
      expect(rpcCalls).toEqual([
        'conformance_prepare_native_cleanup',
        'conformance_cancel_prepared_native_cleanup',
      ]);
      expect(
        rpcCalls.filter((command) =>
          [
            'cave_credential_status',
            'cave_pairing_create',
            'cave_pairing_poll',
            'cave_pairing_exchange',
            'cave_forget_credential',
          ].includes(command),
        ),
      ).toEqual([]);
      expect(approvals).toEqual([]);
      expect(credentialMayExistTransitions).toEqual([]);
      expect(pairingStages).toEqual(
        failureMode === 'command-failure'
          ? ['reservation-request', 'reservation-keychain']
          : failureMode === 'malformed-response'
            ? ['reservation-request', 'reservation-response']
            : ['reservation-request'],
      );
      expect(subsequentLifecycleCalls).toBe(0);
      expect(markerPresent).toBe(false);
    },
  );

  test('validates cleanup ownership adoption and rejects stale owner acknowledgements', async () => {
    const reservation = {
      reservationHandle: '00000000-0000-4000-8000-000000000001',
      capability: '00000000-0000-4000-8000-000000000002',
      ownerToken: '00000000-0000-4000-8000-000000000003',
    };
    await expect(
      adoptNativeCleanupReservation(
        {
          request: async (command, args) => {
            const values = args as { successorOwnerToken: string };
            return command === 'conformance_begin_adopt_native_cleanup'
              ? {
                  ok: true,
                  result: { ...reservation, ownerToken: values.successorOwnerToken },
                }
              : {
                  ok: true,
                  result: { status: 'committed', ownerToken: values.successorOwnerToken },
                };
          },
          ok: async () => ({ status: 'aborted' }),
        },
        createCleanupAdoptionRecovery(reservation),
      ),
    ).resolves.toMatchObject({
      reservationHandle: reservation.reservationHandle,
      capability: reservation.capability,
      ownerToken: expect.not.stringMatching(reservation.ownerToken),
    });
    await expect(
      adoptNativeCleanupReservation(
        {
          request: async () => ({ ok: true, result: reservation }),
          ok: async () => ({ status: 'aborted' }),
        },
        createCleanupAdoptionRecovery(reservation),
      ),
    ).rejects.toThrow('Native cleanup reservation adoption was invalid.');
  });

  test('recovers an idempotent adoption commit after its first response is lost', async () => {
    const reservation = {
      reservationHandle: '00000000-0000-4000-8000-000000000001',
      capability: '00000000-0000-4000-8000-000000000002',
      ownerToken: '00000000-0000-4000-8000-000000000003',
    };
    let commitAttempts = 0;
    let successorOwnerToken = '';
    const adopted = await adoptNativeCleanupReservation(
      {
        request: async (command, args) => {
          const values = args as { successorOwnerToken: string };
          successorOwnerToken = values.successorOwnerToken;
          if (command === 'conformance_begin_adopt_native_cleanup') {
            return {
              ok: true,
              result: { ...reservation, ownerToken: successorOwnerToken },
            };
          }
          commitAttempts += 1;
          if (commitAttempts === 1) throw new Error('commit response lost');
          return {
            ok: true,
            result: { status: 'committed', ownerToken: successorOwnerToken },
          };
        },
        ok: async () => ({ status: 'aborted' }),
      },
      createCleanupAdoptionRecovery(reservation),
    );

    expect(commitAttempts).toBe(2);
    expect(adopted.ownerToken).toBe(successorOwnerToken);
  });

  test('aborts a pending adoption when the begin response is lost', async () => {
    const reservation = {
      reservationHandle: '00000000-0000-4000-8000-000000000001',
      capability: '00000000-0000-4000-8000-000000000002',
      ownerToken: '00000000-0000-4000-8000-000000000003',
    };
    const calls: string[] = [];
    await expect(
      adoptNativeCleanupReservation(
        {
          request: async (command) => {
            calls.push(command);
            throw new Error('begin response lost');
          },
          ok: async (command) => {
            calls.push(command);
            return { status: 'aborted' };
          },
        },
        createCleanupAdoptionRecovery(reservation),
      ),
    ).rejects.toThrow('Native cleanup reservation adoption was invalid.');
    expect(calls).toEqual([
      'conformance_begin_adopt_native_cleanup',
      'conformance_abort_adopt_native_cleanup',
    ]);
  });

  test('retains successor recovery material and deletes after an ambiguous applied commit', async () => {
    const recovery = createCleanupAdoptionRecovery({
      reservationHandle: '00000000-0000-4000-8000-000000000001',
      capability: '00000000-0000-4000-8000-000000000002',
      ownerToken: '00000000-0000-4000-8000-000000000003',
    });
    const freshCalls: string[] = [];
    await expect(
      adoptNativeCleanupReservation(
        {
          request: async (command, args) => {
            const values = args as { successorOwnerToken: string };
            if (command === 'conformance_begin_adopt_native_cleanup') {
              return {
                ok: true,
                result: { ...recovery.successor, ownerToken: values.successorOwnerToken },
              };
            }
            throw new Error('commit response lost');
          },
          ok: async () => ({ status: 'aborted' }),
        },
        recovery,
        async () => ({
          request: async (command: string, args: unknown) => {
            freshCalls.push(command);
            const values = args as { successorOwnerToken: string };
            return {
              ok: true,
              result: { status: 'committed', ownerToken: values.successorOwnerToken },
            };
          },
          ok: async (command: string) => {
            freshCalls.push(command);
            return { status: 'missing' };
          },
          close: async () => undefined,
        }),
      ),
    ).rejects.toThrow('Native cleanup reservation commit could not be confirmed.');
    expect(recovery.deleted).toBe(true);
    expect(freshCalls).toEqual([
      'conformance_commit_adopt_native_cleanup',
      'conformance_delete_native_credential',
    ]);
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
      sdkEvidenceSourceRoot: expect.stringContaining('sdk'),
    });
    expect(() => parseArgs(['--scenario', 'pairing-only'])).toThrow(
      /only --scenario all is supported/,
    );
    expect(() => parseArgs(['--unknown'])).toThrow(/unknown option/);
  });

  test('rejects Node preload and loader runtime injection indicators', () => {
    for (const argument of [
      '-r',
      '-rmodule.cjs',
      '--require',
      '--require=module.cjs',
      '--import',
      '--import=module.mjs',
      '--loader',
      '--loader=x',
      '--experimental-loader',
      '--experimental-loader=x',
      '--experimental-policy=policy.json',
      '--policy-integrity=sha256-test',
      '--conditions=custom',
      '-C=custom',
    ]) {
      expect(() => assertNoNodeRuntimeInjection({}, [argument])).toThrow(
        'Node runtime injection is forbidden for Phase 1 conformance.',
      );
    }
    expect(() =>
      assertNoNodeRuntimeInjection({ NODE_OPTIONS: '--require module.cjs' }, []),
    ).toThrow('Node runtime injection is forbidden for Phase 1 conformance.');
  });

  test.skipIf(process.platform === 'win32')(
    'trusted outer launcher strips preload injection before Node starts',
    () => {
      const root = resolve(
        process.cwd(),
        'test-results',
        'phase1-launcher-injection',
        randomUUID(),
      );
      const marker = resolve(root, 'preload.marker');
      const preload = resolve(root, 'preload.cjs');
      const missingSdk = resolve(root, 'missing-sdk');
      const launcher = resolve(projectRoot, 'scripts', 'phase1-conformance-launcher.sh');
      const runner = resolve(projectRoot, 'scripts', 'phase1-conformance.mjs');
      try {
        mkdirSync(root, { recursive: true });
        writeFileSync(
          preload,
          `require('node:fs').writeFileSync(${JSON.stringify(marker)},'loaded',{flag:'a'});`,
        );
        for (const nodeOptions of [`-r ${preload}`, `-r${preload}`]) {
          expect(() =>
            execFileSync('/bin/sh', [launcher, process.execPath, '--sdk-root', missingSdk], {
              cwd: projectRoot,
              env: { ...process.env, NODE_OPTIONS: nodeOptions },
              stdio: 'ignore',
              timeout: 30_000,
            }),
          ).toThrow();
          expect(existsSync(marker)).toBe(false);
        }

        expect(() =>
          execFileSync(process.execPath, ['-r', preload, runner, '--sdk-root', missingSdk], {
            cwd: projectRoot,
            env: process.env,
            stdio: 'ignore',
            timeout: 30_000,
          }),
        ).toThrow();
        expect(existsSync(marker)).toBe(true);
        expect(existsSync(resolve(root, 'report.json'))).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    70_000,
  );

  test('observes the exact Node, pnpm, and Rust release toolchain', () => {
    expect(observeReleaseToolVersions()).toEqual({
      nodeVersion: 'v24.18.1',
      packageManagerVersion: 'pnpm@10.34.0',
      rustVersion: '1.95.0',
    });
  });

  test('rejects missing or digest-mismatched frozen Windows supervisors', () => {
    const root = mkdtempSync(join(tmpdir(), 'phase1-supervisor-preflight-'));
    const path = resolve(root, 'phase1-process-supervisor.exe');
    try {
      expect(() =>
        validateSupervisorArtifactFile(path, { size: 4, sha256: '0'.repeat(64) }),
      ).toThrow();
      writeFileSync(path, 'tool');
      expect(() =>
        validateSupervisorArtifactFile(path, { size: 4, sha256: '0'.repeat(64) }),
      ).toThrow(/immutable lock/);
      const sha256 = createHash('sha256').update('tool').digest('hex');
      expect(validateSupervisorArtifactFile(path, { size: 4, sha256 })).toBe(realpathSync(path));
    } finally {
      rmSync(root, { recursive: true });
    }
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

  test('extracts only successful Rust test names for assertion proof binding', () => {
    const passed = parsePassedRustTests(
      [
        'test discovery::tests::owner_only_pipe_validation ... ok',
        'test health_failure ... FAILED',
        'test connected_peer_uid_must_match ... ok',
      ].join('\n'),
    );

    expect([...passed]).toEqual([
      'discovery::tests::owner_only_pipe_validation',
      'connected_peer_uid_must_match',
    ]);
  });

  test('accepts pairing denial as a successful status envelope', () => {
    expect(assertPairingStatus({ status: 'denied' }, 'denied')).toEqual({ status: 'denied' });
    expect(() => assertPairingStatus({ status: 'pending' }, 'denied')).toThrow(
      /pairing status was pending instead of denied/,
    );
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

  test('accepts the owned supervisor group kill after a successful shutdown response', async () => {
    const client = new NativeRpcClient(new SynchronousSupervisorCloseChild(), {
      supervised: true,
    });

    await expect(client.close()).resolves.toBeUndefined();
  });

  test.each([
    ['nonzero', Promise.resolve({ code: 1, signal: null, reason: 'exit' })],
    ['panic', Promise.resolve({ code: null, signal: 'SIGABRT', reason: 'exit' })],
    ['missing', undefined],
    ['malformed', Promise.resolve('malformed status')],
  ] as const)('rejects %s long-lived supervisor status', async (_kind, status) => {
    const child = new SynchronousSupervisorCloseChild() as SynchronousSupervisorCloseChild & {
      __phase1SupervisorStatus?: Promise<unknown>;
    };
    Object.defineProperty(child, '__phase1SupervisorStatus', {
      value: status,
      configurable: true,
    });

    const client = new NativeRpcClient(child, { supervised: true });

    await expect(client.close()).rejects.toThrow();
  });

  test('rejects missing malformed and duplicate private supervisor frames', () => {
    for (const frame of [
      '',
      '{}\n',
      '{"code":0,"signal":null,"reason":"exit"}\n{"code":0,"signal":null,"reason":"exit"}\n',
      '{"code":0,"signal":null,"reason":"forged"}\n',
      '{"code":0,"signal":"SIGTERM","reason":"exit"}\n',
    ]) {
      expect(() => parseSupervisorStatusFrame(frame)).toThrow(
        'supervisor status frame was not canonical',
      );
    }
  });

  test.skipIf(process.platform === 'win32')(
    'retains authenticated nonzero and panic status for long-lived owned targets',
    async () => {
      const exit = (await runOwnedProcessStatusForTest(
        process.execPath,
        ['-e', 'process.exit(1)'],
        {
          cwd: projectRoot,
          env: process.env,
        },
      )) as { status: { code: number | null; signal: string | null; reason: string } };
      expect(exit.status).toEqual({ code: 1, signal: null, reason: 'exit' });

      const panic = (await runOwnedProcessStatusForTest(
        process.execPath,
        ['-e', 'process.abort()'],
        {
          cwd: projectRoot,
          env: process.env,
        },
      )) as { status: { code: number | null; signal: string | null; reason: string } };
      expect(panic.status.reason).toBe('exit');
      expect(panic.status.code).toBeNull();
      expect(panic.status.signal).toMatch(/SIGABRT|SIGTRAP/u);
    },
  );

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

  test('rejects pending RPC requests when child stdin closes without an unhandled stream error', async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stdin: EventEmitter & { write(value: string, callback?: (error?: Error) => void): boolean };
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
    };
    child.stdout = new PassThrough();
    child.stdin = Object.assign(new EventEmitter(), {
      write(_value: string, callback?: (error?: Error) => void) {
        const error = new Error('broken pipe');
        callback?.(error);
        child.stdin.emit('error', error);
        return false;
      },
    });
    child.exitCode = null;
    child.signalCode = null;
    const rpc = new NativeRpcClient(child);

    await expect(rpc.request('app_installation_id')).rejects.toThrow('native RPC transport closed');
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

  test('classifies the failed Cave release build phase without exposing output', () => {
    const failure = new CommandExecutionError('private command', {
      code: 1,
      stdout: [
        '> coven-cave@0.3.11 prebuild',
        '> coven-cave@0.3.11 build',
        'Creating an optimized production build',
        '> coven-cave@0.3.11 build:server',
        '> coven-cave@0.3.11 postbuild',
        'private budget details',
      ].join('\n'),
      stderr: 'private stderr',
    });

    const diagnostic = classifyPackagingCommandFailure('phase1.packaging.cave-build', failure);
    expect(diagnostic).toBe('phase1.packaging.cave-build.phase.postbuild');
    expect(diagnostic).not.toContain('private');

    const resourceFailure = new CommandExecutionError('private command', {
      code: 1,
      stdout: 'Creating an optimized production build\nuncaughtException: spawn EAGAIN',
      stderr: 'private stderr',
    });
    expect(classifyPackagingCommandFailure('phase1.packaging.cave-build', resourceFailure)).toBe(
      'phase1.packaging.cave-build.phase.next-build.resource.spawn',
    );
    expect(
      classifyPackagingCommandFailure(
        'phase1.packaging.cave-build',
        new CommandExecutionError('private command', {
          code: 1,
          stdout: '\u001b[31mCreating an optimized production build\r\nheap out of memory\u001b[0m',
          stderr: 'private stderr',
        }),
      ),
    ).toBe('phase1.packaging.cave-build.phase.next-build.resource.memory.heap');
    expect(
      classifyPackagingCommandFailure(
        'phase1.packaging.cave-build',
        new CommandExecutionError('private command', {
          code: 1,
          stdout: 'Creating an optimized production build',
          stderr: 'private path: ENOMEM',
        }),
      ),
    ).toBe('phase1.packaging.cave-build.phase.next-build.resource.memory.allocation');
    expect(
      classifyPackagingCommandFailure(
        'phase1.packaging.cave-build',
        new CommandExecutionError('private command', {
          code: 1,
          stdout: 'Creating an optimized production build',
          stderr: 'private path: Killed: 9',
        }),
      ),
    ).toBe('phase1.packaging.cave-build.phase.next-build.resource.killed');
  });

  test('classifies Coven verification failures without exposing command output', () => {
    for (const [result, expected] of [
      [{ code: 101, signal: null }, 'phase1.packaging.coven-client-lib-tests.cargo-failure'],
      [{ reason: 'timeout' }, 'phase1.packaging.coven-client-lib-tests.timeout'],
      [{ reason: 'stdout-limit' }, 'phase1.packaging.coven-client-lib-tests.output-limit'],
      [{ reason: 'supervisor-termination' }, 'phase1.packaging.coven-client-lib-tests.supervisor'],
      [{ reason: 'spawn' }, 'phase1.packaging.coven-client-lib-tests.spawn'],
    ] as const) {
      const error = new CommandExecutionError('private command', {
        ...result,
        stdout: 'private stdout',
        stderr: 'private stderr',
      });

      const diagnostic = classifyPackagingCommandFailure(
        'phase1.packaging.coven-client-lib-tests',
        error,
      );
      expect(diagnostic).toBe(expected);
      expect(diagnostic).not.toContain('private');
    }
    const exactFailure = new CommandExecutionError('private command', {
      code: 101,
      stdout:
        '\u001b[31m---- lifecycle::tests::macos_tmp_spellings_have_the_same_canonical_filesystem_identity stdout ----\u001b[0m\r\nprivate\r\ntest result: FAILED. 0 passed; 1 failed\r\n',
      stderr: 'private stderr',
    });
    expect(
      classifyPackagingCommandFailure('phase1.packaging.coven-client-lib-tests', exactFailure),
    ).toBe('phase1.packaging.coven-client-lib-tests.libtest.lifecycle');
    const transportFailure = new CommandExecutionError('private command', {
      code: 101,
      stdout:
        '---- transport::unix::tests::response_reader_retries_interrupted_reads stdout ----\ntest result: FAILED. 0 passed; 1 failed\n',
      stderr: 'private stderr',
    });
    expect(
      classifyPackagingCommandFailure('phase1.packaging.coven-client-lib-tests', transportFailure),
    ).toBe('phase1.packaging.coven-client-lib-tests.libtest.transport-unix');
    const malformed = new CommandExecutionError('private command', {
      code: 101,
      stdout: '---- private::module::secret stdout ----\ntest result: FAILED.\n',
      stderr: 'private stderr',
    });
    expect(
      classifyPackagingCommandFailure('phase1.packaging.coven-client-lib-tests', malformed),
    ).toBe('phase1.packaging.coven-client-lib-tests.malformed-output');
  });

  test('reruns every lifecycle test diagnostically without clearing the original failure', async () => {
    const original = new CommandExecutionError('private command', {
      code: 101,
      stdout:
        '---- lifecycle::tests::macos_tmp_spellings_have_the_same_canonical_filesystem_identity stdout ----\ntest result: FAILED. 0 passed; 1 failed\n',
      stderr: 'private stderr',
    });
    const rerun: string[] = [];
    await expect(
      diagnoseCovenLifecycleFailure(original, async (testName) => {
        rerun.push(testName);
      }),
    ).rejects.toThrow(
      'phase1.packaging.coven-client-lib-tests.lifecycle.concurrency-or-order-dependent',
    );
    expect(rerun).toHaveLength(7);

    await expect(
      diagnoseCovenLifecycleFailure(original, async (testName) => {
        if (testName.endsWith('macos_legacy_shutdown_fails_closed_with_upgrade_guidance')) {
          throw new Error('private rerun output');
        }
      }),
    ).rejects.toThrow(
      'phase1.packaging.coven-client-lib-tests.lifecycle.macos_legacy_shutdown_fails_closed_with_upgrade_guidance',
    );

    for (const [message, category] of [
      ['bind selected lifecycle socket', 'socket-setup'],
      ['make selected socket private', 'socket-setup'],
      ['unlink selected socket after lifecycle pre-check', 'unlink-selected-socket'],
      ['move selected profile out of the way', 'move-selected-profile'],
      ['create substituted profile home', 'create-substituted-home'],
      ['make substituted profile private', 'create-substituted-home'],
      [
        'profile replacement must not be classified as a stopped daemon',
        'identity-substitution-accepted',
      ],
      ['assertion failed: matches!(error, crate::ClientError::Discovery(_))', 'wrong-error-class'],
      ['clean moved lifecycle test home', 'cleanup-moved-home'],
      ['private unrecognized panic', 'unknown'],
    ] as const) {
      await expect(
        diagnoseCovenLifecycleFailure(original, async (testName) => {
          if (testName.endsWith('lifecycle_discovery_does_not_hide_a_replaced_profile_home')) {
            throw new CommandExecutionError('private rerun', {
              code: 101,
              stdout: `\u001b[31m${message}\u001b[0m\r\n`,
              stderr: 'private path and error',
            });
          }
        }),
      ).rejects.toThrow(
        `phase1.packaging.coven-client-lib-tests.lifecycle.replaced-profile.${category}`,
      );
    }
  });

  test.skipIf(process.platform === 'win32')(
    'supervised output limits terminate compiler-shaped descendant trees',
    async () => {
      const root = createProcessOwnedArtifactRoot({ prefix: 'phase1-output-limit' });
      const pidPath = resolve(root.rootPath, 'compiler-descendant.pid');
      try {
        await expect(
          runSupervisedCommandForTest(
            root,
            process.execPath,
            [
              '-e',
              [
                "const {spawn}=require('node:child_process');",
                "const {writeFileSync}=require('node:fs');",
                "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
                `writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
                "process.stdout.write('x'.repeat(2048));",
                'setInterval(()=>{},1000);',
              ].join(''),
            ],
            {
              cwd: root.rootPath,
              env: process.env,
              outputLimitBytes: 1024,
              timeoutMs: 5_000,
            },
          ),
        ).rejects.toThrow(/stdout-limit/);
        const descendantPid = await waitForPidFile(pidPath);
        await root.cleanup();
        expect(processIsLive(descendantPid)).toBe(false);
      } finally {
        await root.cleanup().catch(() => undefined);
      }
    },
  );

  test.skipIf(process.platform === 'win32' || !existsSync('/bin/sh'))(
    'supervisor status cannot be forged through the legacy environment or target fd3 (requires POSIX /bin/sh)',
    async () => {
      const root = createProcessOwnedArtifactRoot({
        prefix: 'phase1-private-supervisor-status',
      });
      try {
        const legacyStatusPath = resolve(root.rootPath, 'legacy-status.json');
        const forgedFrame = '{"code":0,"signal":null,"reason":"exit"}';
        const source = [
          `if [ -n "\${OPENCOVEN_PHASE1_SUPERVISOR_STATUS_PATH:-}" ]; then`,
          `  printf '%s' '${forgedFrame}' > "$OPENCOVEN_PHASE1_SUPERVISOR_STATUS_PATH"`,
          'fi',
          `printf '%s' '${forgedFrame}' >&3 2>/dev/null || true`,
          'exit 7',
        ].join('\n');
        await expect(
          runSupervisedCommandForTest(root, '/bin/sh', ['-c', source], {
            cwd: root.rootPath,
            env: {
              ...process.env,
              OPENCOVEN_PHASE1_SUPERVISOR_STATUS_PATH: legacyStatusPath,
            },
            timeoutMs: 5_000,
            outputLimitBytes: 4_096,
          }),
        ).rejects.toMatchObject({
          result: expect.objectContaining({ code: 7 }),
        });
        expect(existsSync(legacyStatusPath)).toBe(false);
      } finally {
        await root.cleanup();
      }
    },
  );

  test.skipIf(process.platform === 'win32')(
    'rejects a forged success frame when supervisor group kill fails and a descendant survives',
    async () => {
      const root = createProcessOwnedArtifactRoot({ prefix: 'phase1-group-kill-failure' });
      const pidPath = resolve(root.rootPath, 'surviving-descendant.pid');
      let descendantPid: number | undefined;
      try {
        const source = [
          "const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');",
          "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
          'child.unref();',
          `writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
        ].join('');
        await expect(
          runSupervisedCommandForTest(root, process.execPath, ['-e', source], {
            cwd: root.rootPath,
            env: { ...process.env, OPENCOVEN_PHASE1_TEST_GROUP_KILL_FAILURE: '1' },
            timeoutMs: 5_000,
            outputLimitBytes: 4_096,
          }),
        ).rejects.toThrow(/supervisor-termination/);
        descendantPid = await waitForPidFile(pidPath);
        expect(processIsLive(descendantPid)).toBe(true);
      } finally {
        if (descendantPid !== undefined && processIsLive(descendantPid)) {
          process.kill(descendantPid, 'SIGKILL');
          const deadline = Date.now() + 2_000;
          while (processIsLive(descendantPid) && Date.now() < deadline) {
            await new Promise((resolveWait) => setTimeout(resolveWait, 10));
          }
        }
        await root.cleanup();
      }
    },
    10_000,
  );

  test.skipIf(process.platform === 'win32')(
    'supervised timeouts terminate package-manager-shaped descendant trees',
    async () => {
      const root = createProcessOwnedArtifactRoot({ prefix: 'phase1-command-timeout' });
      const pidPath = resolve(root.rootPath, 'package-descendant.pid');
      try {
        await expect(
          runSupervisedCommandForTest(
            root,
            process.execPath,
            [
              '-e',
              [
                "const {spawn}=require('node:child_process');",
                "const {writeFileSync}=require('node:fs');",
                "const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});",
                `writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
                'setInterval(()=>{},1000);',
              ].join(''),
            ],
            {
              cwd: root.rootPath,
              env: process.env,
              outputLimitBytes: 1024,
              timeoutMs: 500,
            },
          ),
        ).rejects.toThrow(/timeout/);
        const descendantPid = await waitForPidFile(pidPath);
        await root.cleanup();
        expect(processIsLive(descendantPid)).toBe(false);
      } finally {
        await root.cleanup().catch(() => undefined);
      }
    },
  );

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

  test('publishes only stable operator fingerprint diagnostic IDs', () => {
    expect(
      publicPhase1FailureDiagnostic(
        new AggregateError([
          new Error('private operator path'),
          new Error('phase1.operator-fingerprint.control-file-limit'),
        ]),
      ),
    ).toBe('phase1.operator-fingerprint.control-file-limit');
    expect(publicPhase1FailureDiagnostic(new Error('phase1.stage.native-provider.failed'))).toBe(
      'phase1.stage.native-provider.failed',
    );
    expect(publicPhase1FailureDiagnostic(new Error('phase1.stage.runner-bootstrap.failed'))).toBe(
      'phase1.stage.runner-bootstrap.failed',
    );
    expect(publicPhase1FailureDiagnostic(new Error('phase1.stage.runner-checkout.failed'))).toBe(
      'phase1.stage.runner-checkout.failed',
    );
    expect(publicPhase1FailureDiagnostic(new Error('phase1.stage.environment.failed'))).toBe(
      'phase1.stage.environment.failed',
    );
    expect(
      publicPhase1FailureDiagnostic(new Error('phase1.environment.rust-toolchain.failed')),
    ).toBe('phase1.environment.rust-toolchain.failed');
    expect(publicPhase1FailureDiagnostic(new Error('phase1.native-scenarios.restart'))).toBe(
      'phase1.native-scenarios.restart',
    );
    expect(
      publicPhase1FailureDiagnostic(new Error('phase1.native-scenarios.restart-discovery')),
    ).toBe('phase1.native-scenarios.restart-discovery');
    expect(publicPhase1FailureDiagnostic(new Error('private operator path'))).toBeUndefined();
  });

  test.each([
    [
      'timeout',
      { terminationReason: 'timeout' },
      'phase1.native-scenarios.missing-keychain-timeout',
    ],
    [
      'output limit',
      { terminationReason: 'stdout-limit' },
      'phase1.native-scenarios.missing-keychain-output-limit',
    ],
    ['process', { processFailed: true }, 'phase1.native-scenarios.missing-keychain-process'],
    [
      'termination',
      { supervised: true, signal: null },
      'phase1.native-scenarios.missing-keychain-termination',
    ],
    [
      'supervisor',
      { supervisorStatusValid: false },
      'phase1.native-scenarios.missing-keychain-supervisor',
    ],
    ['canary', { canaryExposed: true }, 'phase1.native-scenarios.missing-keychain-canary'],
    ['home', { homeChanged: true }, 'phase1.native-scenarios.missing-keychain-home'],
    ['response', { responseValid: false }, 'phase1.native-scenarios.missing-keychain-response'],
  ] as const)(
    'classifies missing-keychain %s failures without private output',
    (_name, change, id) => {
      const diagnostic = nativeMissingKeychainFailureDiagnostic({
        supervised: true,
        code: null,
        signal: 'SIGKILL',
        supervisorStatusValid: true,
        terminationReason: undefined,
        killFailed: false,
        processFailed: false,
        canaryExposed: false,
        homeChanged: false,
        responseValid: true,
        ...change,
      });

      expect(diagnostic).toBe(id);
      expect(publicPhase1FailureDiagnostic(new Error(diagnostic ?? 'missing'))).toBe(id);
    },
  );
  test('passes the observed supervisor status into missing-keychain diagnostics', () => {
    const source = readFileSync(resolve(projectRoot, 'scripts', 'phase1-conformance.mjs'), 'utf8');
    const scenario = source.slice(
      source.indexOf('async function runNativeMissingKeychainTrustScenario'),
      source.indexOf('async function runNativeScenarios'),
    );

    expect(scenario).toContain('supervisorStatusValid: supervisedStatusValid');
  });

  test('accepts exact missing-keychain responses regardless of object key order', () => {
    const responses = [
      JSON.parse(
        '{"error":{"code":"secure_store_unavailable","retryable":true},"id":"installation","ok":false}',
      ),
      JSON.parse('{"id":"shutdown","ok":true,"result":{"status":"shutting_down"}}'),
    ];

    expect(nativeMissingKeychainResponsesValid(responses)).toBe(true);
    expect(
      nativeMissingKeychainResponsesValid([{ ...responses[0], extra: true }, responses[1]]),
    ).toBe(false);
  });

  test('always performs the operator after-check and aggregates scenario cleanup and mutation failures', () => {
    const primary = new Error('scenario failed');
    const cleanup = new Error('cleanup failed');
    const mutation = new Error('operator state changed');
    const snapshots: string[] = [];
    const comparisons: unknown[][] = [];

    expect(() =>
      finalizeOperatorSafety({
        primaryFailure: primary,
        cleanupFailure: cleanup,
        operatorStateBefore: { digest: 'before' },
        snapshotAfter: () => {
          snapshots.push('after');
          return { digest: 'after' };
        },
        compare: (before, after) => {
          comparisons.push([before, after]);
          throw mutation;
        },
      }),
    ).toThrow(expect.objectContaining({ errors: [primary, cleanup, mutation] }));
    expect(snapshots).toEqual(['after']);
    expect(comparisons).toEqual([[{ digest: 'before' }, { digest: 'after' }]]);
  });

  test('fingerprints large Coven homes without reading unrelated journal content', () => {
    const scratchParent = resolve(projectRoot, 'test-results', 'vitest', 'operator-fingerprint');
    mkdirSync(scratchParent, { recursive: true });
    const home = mkdtempSync(resolve(scratchParent, 'large-home-'));
    try {
      const covenHome = resolve(home, '.coven');
      mkdirSync(resolve(covenHome, 'memory'), { recursive: true });
      const journalPath = resolve(covenHome, 'memory', 'journal.bin');
      writeFileSync(journalPath, '');
      truncateSync(journalPath, 65 * 1024 * 1024);
      const caveHome = resolve(covenHome, 'cave');
      mkdirSync(resolve(caveHome, 'conversations'), { recursive: true });
      const conversationPath = resolve(caveHome, 'conversations', 'history.json');
      writeFileSync(conversationPath, '');
      truncateSync(conversationPath, 65 * 1024 * 1024);

      const state = snapshotOperatorState(home);

      expect(state['coven-home']).toMatch(/^[0-9a-f]{64}$/u);
      expect(state['cave-home']).toMatch(/^[0-9a-f]{64}$/u);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('detects top-level and authority control mutations without exposing paths', () => {
    const scratchParent = resolve(projectRoot, 'test-results', 'vitest', 'operator-fingerprint');
    mkdirSync(scratchParent, { recursive: true });
    const home = mkdtempSync(resolve(scratchParent, 'mutation-home-'));
    try {
      const covenHome = resolve(home, '.coven');
      mkdirSync(resolve(covenHome, 'memory'), { recursive: true });
      const before = snapshotOperatorState(home);

      writeFileSync(resolve(covenHome, 'daemon.json'), '{"pid":1}\n');
      const controlMutation = snapshotOperatorState(home);
      expect(controlMutation['coven-home']).not.toBe(before['coven-home']);

      writeFileSync(resolve(covenHome, 'new-authority-entry'), 'created\n');
      const topLevelMutation = snapshotOperatorState(home);
      expect(topLevelMutation['coven-home']).not.toBe(controlMutation['coven-home']);
      expect(JSON.stringify(topLevelMutation)).not.toContain(home);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('ignores content churn inside unrelated Cave conversation trees', () => {
    const scratchParent = resolve(projectRoot, 'test-results', 'vitest', 'operator-fingerprint');
    mkdirSync(scratchParent, { recursive: true });
    const home = mkdtempSync(resolve(scratchParent, 'cave-conversation-home-'));
    try {
      const conversations = resolve(home, '.coven', 'cave', 'conversations');
      mkdirSync(conversations, { recursive: true });
      const before = snapshotOperatorState(home);

      writeFileSync(resolve(conversations, 'active.json'), '{"message":"private"}\n');
      const after = snapshotOperatorState(home);

      expect(after['cave-home']).toBe(before['cave-home']);
      expect(after.projects).toBe(before.projects);
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('rejects symlinked Coven control files without following them', () => {
    const scratchParent = resolve(projectRoot, 'test-results', 'vitest', 'operator-fingerprint');
    mkdirSync(scratchParent, { recursive: true });
    const home = mkdtempSync(resolve(scratchParent, 'symlink-home-'));
    try {
      const covenHome = resolve(home, '.coven');
      mkdirSync(covenHome, { recursive: true });
      const outside = resolve(home, 'outside.json');
      writeFileSync(outside, '{"private":"outside"}\n');
      symlinkSync(outside, resolve(covenHome, 'daemon.json'), 'file');

      expect(() => snapshotOperatorState(home)).toThrow(
        'phase1.operator-fingerprint.unsafe-control-resource',
      );
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('rejects broken symlinked Coven control files as unsafe', () => {
    const scratchParent = resolve(projectRoot, 'test-results', 'vitest', 'operator-fingerprint');
    mkdirSync(scratchParent, { recursive: true });
    const home = mkdtempSync(resolve(scratchParent, 'broken-symlink-home-'));
    try {
      const covenHome = resolve(home, '.coven');
      mkdirSync(covenHome, { recursive: true });
      symlinkSync(resolve(home, 'missing.json'), resolve(covenHome, 'daemon.json'), 'file');

      expect(() => snapshotOperatorState(home)).toThrow(
        'phase1.operator-fingerprint.unsafe-control-resource',
      );
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test('rejects oversized Coven authority control files without reading them', () => {
    const scratchParent = resolve(projectRoot, 'test-results', 'vitest', 'operator-fingerprint');
    mkdirSync(scratchParent, { recursive: true });
    const home = mkdtempSync(resolve(scratchParent, 'oversized-control-home-'));
    try {
      const covenHome = resolve(home, '.coven');
      mkdirSync(covenHome, { recursive: true });
      const statusPath = resolve(covenHome, 'daemon.json');
      writeFileSync(statusPath, '');
      truncateSync(statusPath, 64 * 1024 + 1);

      expect(() => snapshotOperatorState(home)).toThrow(
        'phase1.operator-fingerprint.control-file-limit',
      );
    } finally {
      rmSync(home, { force: true, recursive: true });
    }
  });

  test.skipIf(process.platform === 'win32')(
    'fingerprints the Coven Unix socket as metadata without reading it',
    async () => {
      const scratchParent = resolve(projectRoot, 'test-results');
      mkdirSync(scratchParent, { recursive: true });
      const home = mkdtempSync(resolve(scratchParent, 'fp-'));
      const covenHome = resolve(home, '.coven');
      const socketPath = resolve(covenHome, 'coven.sock');
      mkdirSync(covenHome, { recursive: true });
      const server = createServer();
      try {
        await new Promise<void>((resolveListen, rejectListen) => {
          server.once('error', rejectListen);
          server.listen(socketPath, resolveListen);
        });

        expect(snapshotOperatorState(home)['coven-home']).toMatch(/^[0-9a-f]{64}$/u);
      } finally {
        if (server.listening) {
          await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        }
        rmSync(home, { force: true, recursive: true });
      }
    },
  );

  test('aggregates native scenario cleanup RPC and daemon failures in deterministic order', () => {
    const [scenario, cleanup, rpc, daemon] = [
      new Error('scenario'),
      new Error('cleanup'),
      new Error('rpc'),
      new Error('daemon'),
    ];
    for (const [property, error] of [
      ['scenarioFailure', scenario],
      ['cleanupFailure', cleanup],
      ['rpcCleanupFailure', rpc],
      ['daemonCloseFailure', daemon],
    ] as const) {
      expect(() => throwNativeScenarioFailures({ [property]: error })).toThrow(
        expect.objectContaining({ errors: [error] }),
      );
    }
    expect(() =>
      throwNativeScenarioFailures({
        scenarioFailure: scenario,
        cleanupFailure: cleanup,
        rpcCleanupFailure: rpc,
        daemonCloseFailure: daemon,
      }),
    ).toThrow(expect.objectContaining({ errors: [scenario, cleanup, rpc, daemon] }));
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

    const source = readFileSync(
      resolve(import.meta.dirname, '..', 'scripts', 'phase1-conformance.mjs'),
      'utf8',
    );
    const rootCreation = source.indexOf(
      "const executionRoot = runPublicPhase1Stage('phase1.stage.execution-root.failed'",
    );
    const guardedSetup = source.indexOf('try {', rootCreation);
    expect(rootCreation).toBeGreaterThan(-1);
    expect(guardedSetup).toBeGreaterThan(rootCreation);
    expect(
      source.indexOf(
        "environment = runPublicPhase1Stage('phase1.stage.environment.failed'",
        guardedSetup,
      ),
    ).toBeGreaterThan(guardedSetup);
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

  test('uses fixed resource limits for the Cave release build', () => {
    expect(
      caveBuildEnvironment({
        PATH: '/safe/bin',
        NODE_OPTIONS: '--require=/private/injection.cjs',
        CIRCLE_NODE_TOTAL: '999',
      }),
    ).toEqual({
      PATH: '/safe/bin',
      NODE_OPTIONS: '--max-old-space-size=6144',
      CIRCLE_NODE_TOTAL: '3',
    });
  });

  test('uses the operator home only for isolated macOS keychain process tests', () => {
    const isolated = { HOME: '/isolated/home', CARGO_HOME: '/isolated/cargo' };
    expect(nativeAdapterTestEnvironment(isolated, 'darwin', { HOME: '/operator/home' })).toEqual({
      HOME: '/operator/home',
      CARGO_HOME: '/isolated/cargo',
    });
    expect(nativeAdapterTestEnvironment(isolated, 'linux', { HOME: '/operator/home' })).toBe(
      isolated,
    );
    expect(() => nativeAdapterTestEnvironment(isolated, 'darwin', { HOME: 'relative' })).toThrow(
      'phase1.packaging.native-test-home.invalid',
    );
  });

  test('resolves absent and empty RUSTUP_HOME through absolute HOME', () => {
    expect(resolveRustupHome({ HOME: '/reviewed/home' })).toBe('/reviewed/home/.rustup');
    expect(resolveRustupHome({ HOME: '/reviewed/home', RUSTUP_HOME: '' })).toBe(
      '/reviewed/home/.rustup',
    );
    expect(resolveRustupHome({ HOME: '/reviewed/home', RUSTUP_HOME: '/reviewed/rustup' })).toBe(
      '/reviewed/rustup',
    );
  });

  test('rejects relative or non-canonical Rustup homes', () => {
    for (const rustupHome of ['relative/rustup', '/reviewed/../rustup']) {
      expect(() => resolveRustupHome({ HOME: '/reviewed/home', RUSTUP_HOME: rustupHome })).toThrow(
        'phase1.environment.rustup-home.invalid',
      );
    }
  });

  test.skipIf(process.platform === 'win32')(
    'launcher with empty CI RUSTUP_HOME reaches a later reviewed failure',
    () => {
      const root = resolve(projectRoot, 'test-results', 'phase1-empty-rustup', randomUUID());
      const missingSdk = resolve(root, 'missing-sdk');
      const launcher = resolve(projectRoot, 'scripts', 'phase1-conformance-launcher.sh');
      try {
        mkdirSync(root, { recursive: true });
        let failure: unknown;
        try {
          execFileSync('/bin/sh', [launcher, process.execPath, '--sdk-root', missingSdk], {
            cwd: projectRoot,
            env: { ...process.env, RUSTUP_HOME: '' },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 30_000,
          });
        } catch (error) {
          failure = error;
        }
        expect(failure).toMatchObject({ stderr: expect.any(String) });
        const stderr = String((failure as { stderr: string }).stderr);
        expect(stderr).toMatch(/phase1\.stage\.(?:native-provider|checkouts)\.failed/u);
        expect(stderr).not.toContain('phase1.environment.rust-toolchain.failed');
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  test('allows cold isolated Cargo builds to exceed the general command deadline', () => {
    expect(cargoBuildTimeoutMs).toBeGreaterThan(20 * 60_000);
  });
});
