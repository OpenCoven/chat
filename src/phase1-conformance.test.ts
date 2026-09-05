import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  appendFileSync,
  chmodSync,
  cpSync,
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
import { delimiter, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';

import { describe, expect, test } from 'vitest';

import { verifyFrozenPackedConsumer } from '../scripts/contract-canary.mjs';
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
  cloneExactCheckout,
  covenIdentityFailureDiagnostic,
  createCleanupAdoptionRecovery,
  createVerifiedRunnerEnvironment,
  diagnoseCovenLifecycleFailure,
  evidenceValidationFailureDiagnostic,
  extractVerifiedRunnerDiagnostic,
  finalizeOperatorSafety,
  NativeRpcClient,
  nativeAdapterTestEnvironment,
  nativeMissingKeychainFailureDiagnostic,
  nativeMissingKeychainResponsesValid,
  normalizeSchemaV2ObservationTests,
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
  runnerCheckoutFailureDiagnostic,
  runOwnedProcessStatusForTest,
  runPowerShellCommandWithArgs,
  runReservedNativePairing,
  runSupervisedCommandForTest,
  runtimeScenarioFailureDiagnostic,
  safeEnvironment,
  scrubEvidenceAuthorizationEnvironment,
  snapshotOperatorState,
  throwNativeScenarioFailures,
  unixProducerBindingEnvironment,
  validateSchemaV2AuthorityCheckouts,
  validateSupervisorArtifactFile,
  windowsJobBindingEnvironment,
  withFixtureDaemon,
  withOwnedArtifactRoot,
  wrapInfrastructureFailure,
} from '../scripts/phase1-conformance.mjs';
import {
  assertPhase1ProducerAuthority,
  readPhase1ConformanceLock,
} from '../scripts/phase1-conformance-lock.mjs';
// @ts-expect-error The executable script intentionally has no declaration file.
import { cloneExactCheckout as cloneSchemaV2ExactCheckout } from '../scripts/phase1-schema-v2-producer.mjs';
import { createProcessOwnedArtifactRoot } from '../scripts/process-owned-artifact-root.mjs';

const projectRoot = resolve(import.meta.dirname, '..');

function resolvePowerShellPath() {
  try {
    return execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', ['pwsh'], {
      encoding: 'utf8',
    })
      .split(/\r?\n/u)
      .find(Boolean);
  } catch {
    return undefined;
  }
}

const powerShellPath = resolvePowerShellPath();

function createSupervisorArtifactFixture(platform: string) {
  const root = realpathSync(mkdtempSync(resolve(tmpdir(), 'phase1-supervisor-artifact-')));
  const workspace = resolve(root, 'source');
  const artifactWorkspace = resolve(root, 'producer', 'workspace');
  const artifactDirectory = resolve(artifactWorkspace, '.artifacts');
  const sourceRecord = resolve(artifactDirectory, `client-v1-conformance-${platform}.json`);
  mkdirSync(workspace, { recursive: true, mode: 0o555 });
  mkdirSync(artifactDirectory, { recursive: true, mode: 0o700 });
  chmodSync(workspace, 0o555);
  chmodSync(artifactWorkspace, 0o700);
  chmodSync(artifactDirectory, 0o700);
  return { root, workspace, artifactDirectory, sourceRecord };
}

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
  test('normalizes the exact observation result map consumed by schema-v2 adaptation', () => {
    const sdk = new Set(['sdk observation']);
    const chat = new Set(['chat observation']);
    const chatRust = new Set(['chat rust observation']);
    const covenRust = new Set(['coven rust observation']);

    expect(normalizeSchemaV2ObservationTests({ sdk, chat, chatRust, covenRust })).toEqual({
      sdk,
      chat,
      chatRust,
      covenRust,
    });
    expect(() =>
      normalizeSchemaV2ObservationTests({
        sdkTests: sdk,
        chatTests: chat,
        chatRustTests: chatRust,
        covenRustTests: covenRust,
      } as never),
    ).toThrow(/incomplete or malformed/u);
  });

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
        expect(existsSync(join(destination, '.git', 'objects', 'info', 'alternates'))).toBe(false);
      } finally {
        await owned.cleanup();
        rmSync(source, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test.skipIf(process.platform === 'win32')(
    'scrubs the checkout-only Git attribute source before cloning',
    async () => {
      const source = mkdtempSync(join(tmpdir(), 'phase1-local-source-'));
      const bin = mkdtempSync(join(tmpdir(), 'phase1-git-wrapper-'));
      const owned = createProcessOwnedArtifactRoot({ prefix: 'phase1-local-clone-env-test' });
      try {
        execFileSync('git', ['init', '--initial-branch=main'], { cwd: source });
        execFileSync('git', ['config', 'user.name', 'OpenCoven Test'], { cwd: source });
        execFileSync('git', ['config', 'user.email', 'opencoven-test@example.com'], {
          cwd: source,
        });
        writeFileSync(join(source, 'tracked.txt'), 'committed\n');
        execFileSync('git', ['add', 'tracked.txt'], { cwd: source });
        execFileSync('git', ['commit', '-m', 'fixture'], { cwd: source });
        const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: source,
          encoding: 'utf8',
        }).trim();
        const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
        const gitWrapper = join(bin, 'git');
        writeFileSync(
          gitWrapper,
          [
            '#!/bin/sh',
            `if [ "\${GIT_ATTR_SOURCE+x}" = x ]; then`,
            '  exit 42',
            'fi',
            `exec ${JSON.stringify(realGit)} "$@"`,
            '',
          ].join('\n'),
        );
        chmodSync(gitWrapper, 0o755);

        for (const [label, clone] of [
          ['verified runner', cloneExactCheckout],
          ['schema-v2', cloneSchemaV2ExactCheckout],
        ] as const) {
          await clone({
            artifactRoot: owned,
            sourceRoot: source,
            destinationRoot: join(owned.rootPath, label),
            repository: 'OpenCoven/chat',
            revision,
            environment: {
              ...process.env,
              GIT_ATTR_SOURCE: 'HEAD',
              PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
            },
            label: `${label} checkout environment fixture`,
          });
        }
      } finally {
        await owned.cleanup();
        rmSync(source, { recursive: true, force: true });
        rmSync(bin, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test.skipIf(process.platform === 'win32')(
    'trusts the exact local Git directory when the immutable source owner differs',
    async () => {
      const source = mkdtempSync(join(tmpdir(), 'phase1-different-owner-source-'));
      const linkedSource = join(tmpdir(), `phase1-different-owner-worktree-${randomUUID()}`);
      const bin = mkdtempSync(join(tmpdir(), 'phase1-different-owner-git-'));
      const owned = createProcessOwnedArtifactRoot({
        prefix: 'phase1-different-owner-clone-test',
      });
      try {
        execFileSync('git', ['init', '--initial-branch=main'], { cwd: source });
        execFileSync('git', ['config', 'user.name', 'OpenCoven Test'], { cwd: source });
        execFileSync('git', ['config', 'user.email', 'opencoven-test@example.com'], {
          cwd: source,
        });
        writeFileSync(join(source, 'tracked.txt'), 'committed\n');
        execFileSync('git', ['add', 'tracked.txt'], { cwd: source });
        execFileSync('git', ['commit', '-m', 'fixture'], { cwd: source });
        const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: source,
          encoding: 'utf8',
        }).trim();
        execFileSync('git', ['worktree', 'add', '--detach', linkedSource, revision], {
          cwd: source,
        });
        const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
        const gitWrapper = join(bin, 'git');
        writeFileSync(
          gitWrapper,
          [
            '#!/bin/sh',
            'for argument in "$@"; do',
            '  if [ "$argument" = clone ]; then',
            '    export GIT_TEST_ASSUME_DIFFERENT_OWNER=1',
            '    break',
            '  fi',
            'done',
            `exec ${JSON.stringify(realGit)} "$@"`,
            '',
          ].join('\n'),
        );
        chmodSync(gitWrapper, 0o755);

        for (const [sourceLabel, sourceRoot] of [
          ['repository', source],
          ['worktree', linkedSource],
        ] as const) {
          for (const [cloneLabel, clone] of [
            ['verified-runner', cloneExactCheckout],
            ['schema-v2', cloneSchemaV2ExactCheckout],
          ] as const) {
            const label = `${sourceLabel}-${cloneLabel}`;
            await clone({
              artifactRoot: owned,
              sourceRoot,
              destinationRoot: join(owned.rootPath, label),
              repository: 'OpenCoven/chat',
              revision,
              environment: {
                ...process.env,
                PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`,
              },
              label: `${label} different-owner fixture`,
            });
          }
        }
      } finally {
        if (existsSync(linkedSource)) {
          execFileSync('git', ['worktree', 'remove', '--force', linkedSource], {
            cwd: source,
          });
        }
        await owned.cleanup();
        rmSync(source, { recursive: true, force: true });
        rmSync(bin, { recursive: true, force: true });
      }
    },
    30_000,
  );

  test('keeps workflow producer HEAD distinct from the historical executable harness', () => {
    const lock = readPhase1ConformanceLock();
    const workflowRevision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
    const workflowTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
    expect(workflowRevision).not.toBe(lock.harness.revision);
    const root = resolve(projectRoot, 'test-results', 'phase1-distinct-authorities', randomUUID());
    const harnessRoot = resolve(root, 'harness');
    const producerRoot = resolve(root, 'producer');
    try {
      mkdirSync(root, { recursive: true });
      const checkouts: Array<readonly [string, string]> = [
        [harnessRoot, lock.harness.revision],
        [producerRoot, workflowRevision],
      ];
      for (const [destination, revision] of checkouts) {
        execFileSync('git', ['clone', '--quiet', '--no-checkout', projectRoot, destination]);
        execFileSync('git', ['checkout', '--quiet', '--detach', revision], {
          cwd: destination,
        });
      }
      const result = validateSchemaV2AuthorityCheckouts({
        lock,
        harnessRoot,
        producerRoot,
        producerIdentity: { revision: workflowRevision, tree: workflowTree },
      });
      expect(result).toEqual({
        harness: {
          revision: lock.harnessAuthority.revision,
          tree: lock.harnessAuthority.tree,
        },
        producer: { revision: workflowRevision, tree: workflowTree },
      });
      expect(() =>
        validateSchemaV2AuthorityCheckouts({
          lock,
          harnessRoot: producerRoot,
          producerRoot: harnessRoot,
          producerIdentity: { revision: workflowRevision, tree: workflowTree },
        }),
      ).toThrow(/harness|producer/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

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

  test('requires an exact nonce-bound Windows Job Object environment for Windows evidence', () => {
    const nonce = '0123456789abcdef0123456789abcdef';
    const bootstrapRoot = `C:\\OpenCoven\\opencoven-win32-${nonce}`;
    const workspace = `${bootstrapRoot}\\workspace`;
    const artifactDirectory = `${workspace}\\.artifacts`;
    const binding = {
      OPENCOVEN_WINDOWS_JOB_REQUIRED: '1',
      OPENCOVEN_WINDOWS_JOB_NONCE: nonce,
      OPENCOVEN_WINDOWS_JOB_NAME: `Local\\OpenCoven.Chat.Conformance.${nonce}`,
      OPENCOVEN_WINDOWS_SYSTEM_PWSH: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      OPENCOVEN_WINDOWS_BOOTSTRAP_ROOT: bootstrapRoot,
      OPENCOVEN_WINDOWS_WORKSPACE: workspace,
      OPENCOVEN_WINDOWS_ARTIFACT_DIRECTORY: artifactDirectory,
      OPENCOVEN_WINDOWS_SOURCE_RECORD: `${artifactDirectory}\\client-v1-conformance-win32-x64.json`,
      SYSTEMROOT: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
      TEMP: `${bootstrapRoot}\\temp`,
      TMP: `${bootstrapRoot}\\temp`,
      PATH: 'C:\\trusted\\node;C:\\trusted\\cargo',
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      LIB: [
        'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Tools\\MSVC\\14.44.35207\\lib\\x64',
        'C:\\Program Files (x86)\\Windows Kits\\10\\Lib\\10.0.26100.0\\um\\x64',
        'C:\\Program Files (x86)\\Windows Kits\\10\\Lib\\10.0.26100.0\\ucrt\\x64',
      ].join(';'),
      INCLUDE: [
        'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Tools\\MSVC\\14.44.35207\\include',
        'C:\\Program Files (x86)\\Windows Kits\\10\\Include\\10.0.26100.0\\ucrt',
      ].join(';'),
    };

    expect(windowsJobBindingEnvironment(binding, 'win32')).toEqual(binding);
    expect(windowsJobBindingEnvironment(binding, 'linux')).toEqual({});
    expect(() =>
      windowsJobBindingEnvironment({ ...binding, OPENCOVEN_WINDOWS_JOB_REQUIRED: '0' }, 'win32'),
    ).toThrow(/required/u);
    expect(() =>
      windowsJobBindingEnvironment(
        { ...binding, OPENCOVEN_WINDOWS_JOB_NAME: 'Local\\OpenCoven.Chat.Conformance.other' },
        'win32',
      ),
    ).toThrow(/nonce-bound/u);
    expect(() =>
      windowsJobBindingEnvironment(
        {
          ...binding,
          OPENCOVEN_WINDOWS_SYSTEM_PWSH: 'C:\\untrusted\\pwsh.exe',
        },
        'win32',
      ),
    ).toThrow(/system PowerShell/u);
    expect(() =>
      windowsJobBindingEnvironment(
        {
          ...binding,
          OPENCOVEN_WINDOWS_SOURCE_RECORD: `${artifactDirectory}\\replacement.json`,
        },
        'win32',
      ),
    ).toThrow(/artifact/u);
    expect(() =>
      windowsJobBindingEnvironment({ ...binding, TEMP: 'C:\\ambient\\temp' }, 'win32'),
    ).toThrow(/temporary/u);
  });

  test('requires a distinct Unix producer UID and native containment binding', () => {
    const fixture = createSupervisorArtifactFixture('linux-x64');
    const currentUid = process.getuid?.() ?? 1977;
    const brokerUid = currentUid === 1 ? 2 : currentUid - 1;
    const common = {
      OPENCOVEN_UNIX_PRODUCER_REQUIRED: '1',
      OPENCOVEN_UNIX_PRODUCER_PLATFORM: 'linux-x64',
      OPENCOVEN_UNIX_PRODUCER_UID: String(currentUid),
      OPENCOVEN_UNIX_PRODUCER_NAME: 'ocv0123456789abcdef',
      OPENCOVEN_UNIX_BROKER_UID: String(brokerUid),
      OPENCOVEN_UNIX_CONTAINMENT: 'linux-cgroup-v2',
      OPENCOVEN_UNIX_CGROUP_PATH: '/opencoven-chat-0123456789abcdef',
      OPENCOVEN_UNIX_WORKSPACE: fixture.workspace,
      OPENCOVEN_UNIX_ARTIFACT_DIRECTORY: fixture.artifactDirectory,
      OPENCOVEN_UNIX_SOURCE_RECORD: fixture.sourceRecord,
    };

    try {
      expect(
        unixProducerBindingEnvironment(
          common,
          'linux',
          'x64',
          currentUid,
          '0::/opencoven-chat-0123456789abcdef\n',
        ),
      ).toEqual(common);
      const darwinFixture = createSupervisorArtifactFixture('darwin-arm64');
      try {
        const darwin = {
          ...common,
          OPENCOVEN_UNIX_PRODUCER_PLATFORM: 'darwin-arm64',
          OPENCOVEN_UNIX_CONTAINMENT: 'macos-uid',
          OPENCOVEN_UNIX_CGROUP_PATH: undefined,
          OPENCOVEN_UNIX_WORKSPACE: darwinFixture.workspace,
          OPENCOVEN_UNIX_ARTIFACT_DIRECTORY: darwinFixture.artifactDirectory,
          OPENCOVEN_UNIX_SOURCE_RECORD: darwinFixture.sourceRecord,
        };
        expect(unixProducerBindingEnvironment(darwin, 'darwin', 'arm64', currentUid, '')).toEqual(
          darwin,
        );
      } finally {
        rmSync(darwinFixture.root, { recursive: true, force: true });
      }
      expect(unixProducerBindingEnvironment(common, 'win32', 'x64', undefined, '')).toEqual({});

      for (const invalid of [
        { ...common, OPENCOVEN_UNIX_PRODUCER_REQUIRED: '0' },
        { ...common, OPENCOVEN_UNIX_PRODUCER_UID: String(brokerUid) },
        { ...common, OPENCOVEN_UNIX_BROKER_UID: String(currentUid) },
        { ...common, OPENCOVEN_UNIX_BROKER_UID: '0' },
        { ...common, OPENCOVEN_UNIX_PRODUCER_PLATFORM: 'linux-arm64' },
        { ...common, OPENCOVEN_UNIX_CONTAINMENT: 'process-group' },
        { ...common, OPENCOVEN_UNIX_CGROUP_PATH: '/other' },
        {
          ...common,
          OPENCOVEN_UNIX_SOURCE_RECORD: resolve(fixture.artifactDirectory, 'replacement.json'),
        },
      ]) {
        expect(() =>
          unixProducerBindingEnvironment(
            invalid,
            'linux',
            'x64',
            currentUid,
            '0::/opencoven-chat-0123456789abcdef\n',
          ),
        ).toThrow(/Unix schema-v2 evidence/u);
      }
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('projects only validated Unix supervision into the relocated verified runner', () => {
    const platform = process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64';
    const fixture = createSupervisorArtifactFixture(platform);
    const currentUid = process.getuid?.() ?? 1977;
    const brokerUid = currentUid === 1 ? 2 : currentUid - 1;
    const environment = {
      ...process.env,
      OPENCOVEN_UNIX_PRODUCER_REQUIRED: '1',
      OPENCOVEN_UNIX_PRODUCER_PLATFORM: platform,
      OPENCOVEN_UNIX_PRODUCER_UID: String(currentUid),
      OPENCOVEN_UNIX_PRODUCER_NAME: 'ocv0123456789abcdef',
      OPENCOVEN_UNIX_BROKER_UID: String(brokerUid),
      OPENCOVEN_UNIX_CONTAINMENT: process.platform === 'darwin' ? 'macos-uid' : 'linux-cgroup-v2',
      OPENCOVEN_UNIX_CGROUP_PATH:
        process.platform === 'darwin' ? undefined : '/opencoven-chat-0123456789abcdef',
      OPENCOVEN_UNIX_WORKSPACE: fixture.workspace,
      OPENCOVEN_UNIX_ARTIFACT_DIRECTORY: fixture.artifactDirectory,
      OPENCOVEN_UNIX_SOURCE_RECORD: fixture.sourceRecord,
      GITHUB_TOKEN: 'must-not-propagate',
    };
    const runtime = {
      platform: process.platform,
      architecture: process.arch,
      currentUid,
      cgroupMembership:
        process.platform === 'darwin' ? '' : '0::/opencoven-chat-0123456789abcdef\n',
    };

    try {
      const options = parseArgs(
        [
          '--validator-revision',
          'd'.repeat(40),
          '--platform',
          platform,
          '--output',
          fixture.sourceRecord,
        ],
        { environment, ...runtime },
      );
      const projected = createVerifiedRunnerEnvironment(
        options,
        resolve(fixture.root, 'relocated-harness'),
        environment,
        runtime,
      );
      expect(projected).toMatchObject({
        OPENCOVEN_UNIX_PRODUCER_REQUIRED: '1',
        OPENCOVEN_UNIX_PRODUCER_PLATFORM: platform,
        OPENCOVEN_UNIX_PRODUCER_UID: String(currentUid),
        OPENCOVEN_UNIX_PRODUCER_NAME: 'ocv0123456789abcdef',
        OPENCOVEN_UNIX_BROKER_UID: String(brokerUid),
        OPENCOVEN_UNIX_CONTAINMENT: process.platform === 'darwin' ? 'macos-uid' : 'linux-cgroup-v2',
        OPENCOVEN_UNIX_WORKSPACE: fixture.workspace,
        OPENCOVEN_UNIX_ARTIFACT_DIRECTORY: fixture.artifactDirectory,
        OPENCOVEN_UNIX_SOURCE_RECORD: fixture.sourceRecord,
        OPENCOVEN_PHASE1_VERIFIED_RUNNER: '1',
        OPENCOVEN_PHASE1_VERIFIED_RUNNER_ROOT: resolve(fixture.root, 'relocated-harness'),
      });
      expect(projected).not.toHaveProperty('GITHUB_TOKEN');
      expect(() =>
        createVerifiedRunnerEnvironment(
          options,
          resolve(fixture.root, 'relocated-harness'),
          { ...environment, OPENCOVEN_UNIX_SOURCE_RECORD: undefined },
          runtime,
        ),
      ).toThrow(/Unix schema-v2 evidence/u);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('projects only validated Windows Job and toolchain proof into the verified runner', () => {
    const nonce = '0123456789abcdef0123456789abcdef';
    const bootstrapRoot = `C:\\OpenCoven\\opencoven-win32-${nonce}`;
    const workspace = `${bootstrapRoot}\\workspace`;
    const artifactDirectory = `${workspace}\\.artifacts`;
    const environment = {
      PATH: 'C:\\trusted\\node;C:\\trusted\\cargo',
      HOME: 'C:\\OpenCoven\\isolated\\profile',
      OPENCOVEN_WINDOWS_JOB_REQUIRED: '1',
      OPENCOVEN_WINDOWS_JOB_NONCE: nonce,
      OPENCOVEN_WINDOWS_JOB_NAME: `Local\\OpenCoven.Chat.Conformance.${nonce}`,
      OPENCOVEN_WINDOWS_SYSTEM_PWSH: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      OPENCOVEN_WINDOWS_BOOTSTRAP_ROOT: bootstrapRoot,
      OPENCOVEN_WINDOWS_WORKSPACE: workspace,
      OPENCOVEN_WINDOWS_ARTIFACT_DIRECTORY: artifactDirectory,
      OPENCOVEN_WINDOWS_SOURCE_RECORD: `${artifactDirectory}\\client-v1-conformance-win32-x64.json`,
      SYSTEMROOT: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
      TEMP: `${bootstrapRoot}\\temp`,
      TMP: `${bootstrapRoot}\\temp`,
      PATHEXT: '.COM;.EXE;.BAT;.CMD',
      LIB: [
        'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Tools\\MSVC\\14.44.35207\\lib\\x64',
        'C:\\Program Files (x86)\\Windows Kits\\10\\Lib\\10.0.26100.0\\um\\x64',
      ].join(';'),
      INCLUDE: [
        'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Tools\\MSVC\\14.44.35207\\include',
        'C:\\Program Files (x86)\\Windows Kits\\10\\Include\\10.0.26100.0\\ucrt',
      ].join(';'),
      GITHUB_TOKEN: 'must-not-propagate',
    };
    const runtime = {
      platform: 'win32' as const,
      architecture: 'x64',
      cgroupMembership: '',
    };
    const options = parseArgs(
      [
        '--validator-revision',
        'd'.repeat(40),
        '--platform',
        'win32-x64',
        '--output',
        environment.OPENCOVEN_WINDOWS_SOURCE_RECORD,
      ],
      { environment, ...runtime },
    );
    const projected = createVerifiedRunnerEnvironment(
      options,
      'C:\\OpenCoven\\bootstrap\\harness',
      environment,
      runtime,
    );

    expect(projected).toMatchObject({
      OPENCOVEN_WINDOWS_JOB_REQUIRED: '1',
      OPENCOVEN_WINDOWS_JOB_NONCE: nonce,
      OPENCOVEN_WINDOWS_JOB_NAME: `Local\\OpenCoven.Chat.Conformance.${nonce}`,
      OPENCOVEN_WINDOWS_SYSTEM_PWSH: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      OPENCOVEN_WINDOWS_WORKSPACE: workspace,
      OPENCOVEN_WINDOWS_ARTIFACT_DIRECTORY: artifactDirectory,
      OPENCOVEN_WINDOWS_SOURCE_RECORD: `${artifactDirectory}\\client-v1-conformance-win32-x64.json`,
      SYSTEMROOT: 'C:\\Windows',
      WINDIR: 'C:\\Windows',
      COMSPEC: 'C:\\Windows\\System32\\cmd.exe',
      TEMP: `${bootstrapRoot}\\temp`,
      TMP: `${bootstrapRoot}\\temp`,
      LIB: environment.LIB,
      INCLUDE: environment.INCLUDE,
      OPENCOVEN_PHASE1_VERIFIED_RUNNER: '1',
      OPENCOVEN_PHASE1_VERIFIED_RUNNER_ROOT: 'C:\\OpenCoven\\bootstrap\\harness',
    });
    expect(projected).not.toHaveProperty('GITHUB_TOKEN');
    expect(() =>
      createVerifiedRunnerEnvironment(
        options,
        'C:\\OpenCoven\\bootstrap\\harness',
        { ...environment, OPENCOVEN_WINDOWS_JOB_NONCE: '0'.repeat(32) },
        runtime,
      ),
    ).toThrow(/nonce-bound/u);
  });

  test.skipIf(process.platform !== 'darwin')(
    'accepts the real Unix supervisor record path after verified-runner relocation',
    () => {
      const fixture = createSupervisorArtifactFixture('darwin-arm64');
      const relocatedRoot = resolve(fixture.root, 'relocated-harness');
      cpSync(resolve(projectRoot, 'scripts'), resolve(relocatedRoot, 'scripts'), {
        recursive: true,
      });
      const currentUid = process.getuid?.();
      if (currentUid === undefined) {
        throw new Error('Darwin supervisor test requires a native UID.');
      }
      const brokerUid = currentUid === 1 ? 2 : currentUid - 1;
      const result = spawnSync(
        process.execPath,
        [
          resolve(relocatedRoot, 'scripts', 'phase1-conformance.mjs'),
          '--lock',
          resolve(fixture.root, 'missing.lock.json'),
          '--validator-revision',
          'd'.repeat(40),
          '--platform',
          'darwin-arm64',
          '--output',
          fixture.sourceRecord,
        ],
        {
          cwd: relocatedRoot,
          encoding: 'utf8',
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            TMPDIR: process.env.TMPDIR,
            OPENCOVEN_PHASE1_VERIFIED_RUNNER: '1',
            OPENCOVEN_PHASE1_VERIFIED_RUNNER_ROOT: relocatedRoot,
            OPENCOVEN_UNIX_PRODUCER_REQUIRED: '1',
            OPENCOVEN_UNIX_PRODUCER_PLATFORM: 'darwin-arm64',
            OPENCOVEN_UNIX_PRODUCER_UID: String(currentUid),
            OPENCOVEN_UNIX_PRODUCER_NAME: 'ocv0123456789abcdef',
            OPENCOVEN_UNIX_BROKER_UID: String(brokerUid),
            OPENCOVEN_UNIX_CONTAINMENT: 'macos-uid',
            OPENCOVEN_UNIX_WORKSPACE: fixture.workspace,
            OPENCOVEN_UNIX_ARTIFACT_DIRECTORY: fixture.artifactDirectory,
            OPENCOVEN_UNIX_SOURCE_RECORD: fixture.sourceRecord,
          },
        },
      );
      try {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('phase1.stage.lock.failed');
        expect(result.stderr).not.toContain('schema-v2 --output must match');
      } finally {
        rmSync(fixture.root, { recursive: true, force: true });
      }
    },
  );

  test.skipIf(powerShellPath === undefined)(
    'passes Windows Job name and PID as exactly two PowerShell arguments',
    () => {
      const jobName = 'Local\\OpenCoven.Chat.Conformance.0123456789abcdef0123456789abcdef';
      const pid = '4242';
      const output = runPowerShellCommandWithArgs(
        powerShellPath as string,
        '[Console]::Out.Write((ConvertTo-Json -Compress -InputObject @($args)))',
        [jobName, pid],
        {
          cwd: projectRoot,
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
          },
          timeout: 15_000,
        },
      );
      expect(JSON.parse(output)).toEqual([jobName, pid]);
    },
    20_000,
  );

  test('has no module-scope subprocess and makes Windows membership the first schema-v2 subprocess', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'scripts', 'phase1-schema-v2-producer.mjs'),
      'utf8',
    );
    const firstExport = source.indexOf('export function scrubEvidenceAuthorizationEnvironment');
    const runStart = source.indexOf('export async function runSchemaV2Conformance');
    const runSource = source.slice(runStart);

    expect(source.slice(0, firstExport)).not.toContain('execFileSync(');
    expect(runSource.indexOf('scrubEvidenceAuthorizationEnvironment()')).toBeLessThan(
      runSource.indexOf('schemaV2SupervisorEnvironment(process.env)'),
    );
    expect(runSource.indexOf('schemaV2SupervisorEnvironment(process.env)')).toBeLessThan(
      runSource.indexOf('assertWindowsJobMembership(windowsJobBinding)'),
    );
    expect(runSource.indexOf('assertWindowsJobMembership(windowsJobBinding)')).toBeLessThan(
      runSource.indexOf('resolveRepositoryLayout()'),
    );
    expect(runSource.indexOf('resolveRepositoryLayout()')).toBeLessThan(
      runSource.indexOf('createExactCheckouts('),
    );
    expect(runSource).toContain("OPENCOVEN_PHASE1_SCHEMA_V2_EVIDENCE: '1'");
  });

  test('authenticates the executing harness before schema-v2 dispatch', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'scripts', 'phase1-conformance.mjs'),
      'utf8',
    );
    const runStart = source.indexOf('export async function runPhase1Conformance');
    const runSource = source.slice(runStart, source.indexOf('\nasync function main(', runStart));
    const lockBootstrap = runSource.indexOf('bootstrapWindowsSupervisor(options)');
    const authorityCheck = runSource.indexOf('assertExecutingHarnessAuthority(lock)');
    const schemaDispatch = runSource.indexOf('runSchemaV2Conformance(options,');
    const legacyCredentialCheck = runSource.indexOf('assertNativeCredentialProviderIsolated()');

    expect(lockBootstrap).toBeGreaterThan(-1);
    expect(authorityCheck).toBeGreaterThan(lockBootstrap);
    expect(schemaDispatch).toBeGreaterThan(authorityCheck);
    expect(legacyCredentialCheck).toBeGreaterThan(schemaDispatch);
    expect(runSource.slice(schemaDispatch, schemaDispatch + 160)).toContain('lock');
    expect(runSource.slice(schemaDispatch, schemaDispatch + 160)).toContain(
      'harnessAuthorityVerification',
    );
  });

  test('validates the cloned schema-v2 producer authority before SDK authority, package, or Cargo work', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'scripts', 'phase1-schema-v2-producer.mjs'),
      'utf8',
    );
    const runStart = source.indexOf('export async function runSchemaV2Conformance');
    const runSource = source.slice(runStart, source.indexOf('\nasync function main(', runStart));
    const checkout = runSource.indexOf('createExactCheckouts(');
    const producerAuthority = runSource.indexOf('validateSchemaV2AuthorityCheckouts(');
    const sdkAuthority = runSource.indexOf('loadSdkEvidenceContract(');
    const packageWork = runSource.indexOf('packageLockedArtifacts(');
    const cargoObservations = runSource.indexOf('runSchemaV2ObservationSuites(');

    expect(checkout).toBeGreaterThan(-1);
    expect(producerAuthority).toBeGreaterThan(checkout);
    expect(sdkAuthority).toBeGreaterThan(producerAuthority);
    expect(packageWork).toBeGreaterThan(producerAuthority);
    expect(cargoObservations).toBeGreaterThan(producerAuthority);
    expect(runSource.indexOf('requirePhase1HarnessAuthorityVerification(')).toBeLessThan(
      runSource.indexOf('assertWindowsJobMembership('),
    );
    expect(runSource).toContain('harnessRoot: projectRoot');
    expect(runSource).toContain('producerRoot: roots.producerRoot');
    expect(source).not.toContain('const report = await runSchemaV2Conformance(options);');
  });

  test('runs the Tauri metadata probe from the dependency-installed producer workspace', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'scripts', 'phase1-schema-v2-producer.mjs'),
      'utf8',
    );
    const collectorStart = source.indexOf('async function collectToolchainMetadata');
    const collectorEnd = source.indexOf('\nfunction sha256Tree', collectorStart);
    const runStart = source.indexOf('export async function runSchemaV2Conformance');

    expect(collectorStart).toBeGreaterThan(-1);
    expect(collectorEnd).toBeGreaterThan(collectorStart);
    expect(runStart).toBeGreaterThan(-1);
    const collectorSource = source.slice(collectorStart, collectorEnd);
    const runSource = source.slice(runStart);
    expect(collectorSource).toContain(
      'collectToolchainMetadata(artifactRoot, environment, expected, toolchainRoot)',
    );
    expect(collectorSource).toContain("['--ignore-workspace', 'exec', 'tauri', '--version']");
    expect(collectorSource).toContain('cwd: toolchainRoot');
    expect(runSource).toContain(
      'const toolchainRoot =\n        supervisorEnvironment.OPENCOVEN_WINDOWS_WORKSPACE ??\n        supervisorEnvironment.OPENCOVEN_UNIX_WORKSPACE;',
    );
    expect(runSource).toContain(
      'collectToolchainMetadata(\n        executionRoot,\n        environment,\n        sdkContract.frozenLock.toolchain,\n        toolchainRoot,\n      )',
    );
  });

  test('reuses the frozen packed-consumer verifier without rebuilding SDK tarballs', () => {
    expect(verifyFrozenPackedConsumer).toBeTypeOf('function');
    const source = readFileSync(
      resolve(process.cwd(), 'scripts', 'phase1-schema-v2-producer.mjs'),
      'utf8',
    );
    expect(source).toContain('chatRoot: roots.producerRoot');
  });

  test('routes schema-v2 Cargo observations into the supervised build quota root', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'scripts', 'phase1-schema-v2-producer.mjs'),
      'utf8',
    );
    expect(source).toContain(
      "CARGO_TARGET_DIR: resolve(artifactRoot.rootPath, 'build', 'observation-target')",
    );
  });

  test('binds schema-v2 producer identity to the supplied workflow checkout', async () => {
    const producerModulePath = '../scripts/phase1-schema-v2-producer.mjs';
    const { readSchemaV2ProducerIdentity } = await import(producerModulePath);
    const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();
    const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: projectRoot,
      encoding: 'utf8',
    }).trim();

    expect(readSchemaV2ProducerIdentity(projectRoot)).toEqual({ revision, tree });
    const source = readFileSync(
      resolve(projectRoot, 'scripts', 'phase1-schema-v2-producer.mjs'),
      'utf8',
    );
    expect(source).toContain(
      'cloneProducerCheckout(artifactRoot, options.chatSourceRoot, environment)',
    );
  });

  test('preserves a private infrastructure cause only on the in-memory error object', () => {
    const cause = new Error('/private/operator/path should not be retained');
    const wrapped = wrapInfrastructureFailure(cause, { status: 'failed' });

    expect(wrapped.message).toBe('Phase 1 conformance infrastructure failed.');
    expect(wrapped.cause).toBe(cause);
    expect(JSON.stringify(wrapped.result)).not.toContain('/private/operator/path');
  });

  test('preserves a safe schema-v2 stage while retaining its private cause only in memory', () => {
    const diagnostic = 'phase1.stage.checkouts.failed';
    const cause = new Error('/private/operator/path should not be retained');
    const staged = new Error(diagnostic, { cause });
    const wrapped = wrapInfrastructureFailure(staged, { status: 'failed' });

    expect(wrapped.message).toBe(diagnostic);
    expect(publicPhase1FailureDiagnostic(wrapped)).toBe(diagnostic);
    expect(wrapped.cause).toBe(staged);
    expect(JSON.stringify(wrapped.result)).not.toContain('/private/operator/path');
  });

  test.each([
    'phase1.packaging.frozen-consumer.failed',
    'phase1.packaging.cave-install.failed',
    'phase1.packaging.cave-build.failed',
    'phase1.packaging.chat-install.failed',
    'phase1.packaging.chat-web-build.failed',
    'phase1.packaging.chat-native-build.failed',
    'phase1.packaging.coven-build.failed',
    'phase1.packaging.outputs.failed',
  ])('publishes bounded schema-v2 packaging diagnostic %s', (diagnostic) => {
    const wrapped = wrapInfrastructureFailure(
      new Error(diagnostic, { cause: new Error('/private/operator/path') }),
      { status: 'failed' },
    );

    expect(wrapped.message).toBe(diagnostic);
    expect(publicPhase1FailureDiagnostic(wrapped)).toBe(diagnostic);
    expect(JSON.stringify(wrapped.result)).not.toContain('/private/operator/path');
  });

  test.each([
    'phase1.packaging.frozen-consumer.authority.failed',
    'phase1.packaging.frozen-consumer.artifacts.failed',
    'phase1.packaging.frozen-consumer.harness.failed',
    'phase1.packaging.frozen-consumer.install.failed',
    'phase1.packaging.frozen-consumer.isolation.failed',
    'phase1.packaging.frozen-consumer.fixture.failed',
    'phase1.packaging.frozen-consumer.build.failed',
    'phase1.packaging.frozen-consumer.verify.failed',
    'phase1.packaging.frozen-consumer.cleanup.failed',
  ])('publishes bounded frozen-consumer diagnostic %s', (diagnostic) => {
    const wrapped = wrapInfrastructureFailure(
      new Error(diagnostic, { cause: new Error('/private/operator/path') }),
      { status: 'failed' },
    );

    expect(wrapped.message).toBe(diagnostic);
    expect(publicPhase1FailureDiagnostic(wrapped)).toBe(diagnostic);
    expect(JSON.stringify(wrapped.result)).not.toContain('/private/operator/path');
  });

  test('persists only a bounded frozen-consumer substage across the verifier process', () => {
    const source = readFileSync(
      resolve(projectRoot, 'scripts', 'phase1-schema-v2-producer.mjs'),
      'utf8',
    );

    expect(source).toContain('verify-frozen-consumer-failure.json');
    expect(source).toContain('onStage(stage)');
    expect(source).toContain('JSON.stringify({ stage: activeStage })');
    expect(source).toContain('`phase1.packaging.frozen-consumer.$' + '{failure.stage}.failed`');
    expect(source).not.toContain('JSON.stringify({ stage: activeStage, error');
  });

  test('tracks the active schema-v2 packaging substage before each bounded operation', () => {
    const source = readFileSync(
      resolve(projectRoot, 'scripts', 'phase1-schema-v2-producer.mjs'),
      'utf8',
    );

    for (const diagnostic of [
      'phase1.packaging.frozen-consumer.failed',
      'phase1.packaging.cave-install.failed',
      'phase1.packaging.cave-build.failed',
      'phase1.packaging.chat-install.failed',
      'phase1.packaging.chat-web-build.failed',
      'phase1.packaging.chat-native-build.failed',
      'phase1.packaging.coven-build.failed',
      'phase1.packaging.outputs.failed',
    ]) {
      expect(source).toContain(`onStage('${diagnostic}')`);
    }
    expect(source).toContain(
      ['      onStage(stage) {', '        activeStage = stage;', '      },'].join('\n'),
    );
    expect(source.indexOf("onStage('phase1.packaging.chat-native-build.failed')")).toBeLessThan(
      source.indexOf('mkdirSync(chatTarget'),
    );
    expect(source.indexOf("onStage('phase1.packaging.coven-build.failed')")).toBeLessThan(
      source.indexOf('mkdirSync(covenTarget'),
    );
  });

  test('tracks bounded schema-v2 native substages through scenario and cleanup failures', () => {
    const source = readFileSync(
      resolve(projectRoot, 'scripts', 'phase1-schema-v2-producer.mjs'),
      'utf8',
    );
    const nativeScenarios = source.slice(
      source.indexOf('async function runNativeScenarios({'),
      source.indexOf('async function runCovenIdentityScenario('),
    );

    for (const stage of [
      'fixture-daemon',
      'fixture',
      'rpc-start',
      'native-preflight',
      'launch',
      'pairing',
      'restart-health',
      'reads',
      'reconciliation',
      'revocation-status',
      'stale-discovery',
      'cleanup',
      'cleanup-grant',
      'cleanup-custody',
      'cleanup-rpc',
      'cleanup-fixture-daemon',
      'missing-keychain',
      'isolation-proof',
    ]) {
      expect(nativeScenarios).toContain(`'${stage}'`);
    }
    expect(nativeScenarios).toContain(
      'throw new Error(schemaV2NativeFailureDiagnostic(activeNativeStage), { cause: error });',
    );
    expect(nativeScenarios.match(/scenarioFailure = retainSchemaV2NativeFailure\(/gu)).toHaveLength(
      8,
    );
    expect(nativeScenarios.match(/cleanupFailure = retainSchemaV2NativeFailure\(/gu)).toHaveLength(
      4,
    );
    expect(nativeScenarios).not.toContain('cause.message');
  });

  test('retains the first schema-v2 infrastructure failure when a later stage also fails', () => {
    const source = readFileSync(
      resolve(projectRoot, 'scripts', 'phase1-schema-v2-producer.mjs'),
      'utf8',
    );

    expect(source).toContain(
      [
        '  } catch (error) {',
        '    infrastructureFailure ??= schemaV2',
        '      ? new Error(schemaV2FailureDiagnostic(error, activeStage), { cause: error })',
        '      : error;',
        "    fillMissingAssertions(results, 'failed', 'phase1.assertion.failed');",
      ].join('\n'),
    );
  });

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

  test('runs the shared-home Coven health integration suite serially', () => {
    const source = readFileSync(
      resolve(import.meta.dirname, '..', 'scripts', 'phase1-conformance.mjs'),
      'utf8',
    );

    expect(source).toMatch(
      /\[\s*'health',\s*\[\s*'test',\s*'--locked',\s*'--package',\s*'coven-client',\s*'--test',\s*'health',\s*'--',\s*'--test-threads=1',\s*\],\s*\]/u,
    );
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
    expect(source).toContain('assertPhase1ProducerAuthority(lock, harnessRoot)');
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
        expect(assertPhase1ProducerAuthority).toBeTypeOf('function');
        expect(() => assertPhase1ProducerAuthority(lock, harnessRoot)).not.toThrow();
        expect(() => assertProductionAdapterAtRevision(harnessRoot, lock)).not.toThrow();

        const runner = resolve(harnessRoot, 'scripts', 'phase1-conformance.mjs');
        appendFileSync(runner, '\n// substituted\n');
        expect(() =>
          assertExecutingHarnessAuthority(lock, harnessRoot, verifiedEnvironment),
        ).toThrow('Executing Phase 1 harness module does not match its immutable authority.');
        expect(() => assertPhase1ProducerAuthority(lock, harnessRoot)).toThrow(
          'Executing Phase 1 harness module does not match its immutable authority.',
        );
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
        expect(() => assertPhase1ProducerAuthority(lock, harnessRoot)).toThrow(
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
      'activeNativeStage = `revocation-repair-$' + '{stage}`',
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

  test('parses the protected schema-v2 platform invocation without legacy output flags', () => {
    const platform = process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64';
    const fixture = createSupervisorArtifactFixture(platform);
    const currentUid = process.getuid?.() ?? 1977;
    const brokerUid = currentUid === 1 ? 2 : currentUid - 1;
    const environment = {
      ...process.env,
      OPENCOVEN_UNIX_PRODUCER_REQUIRED: '1',
      OPENCOVEN_UNIX_PRODUCER_PLATFORM: platform,
      OPENCOVEN_UNIX_PRODUCER_UID: String(currentUid),
      OPENCOVEN_UNIX_PRODUCER_NAME: 'ocv0123456789abcdef',
      OPENCOVEN_UNIX_BROKER_UID: String(brokerUid),
      OPENCOVEN_UNIX_CONTAINMENT: process.platform === 'darwin' ? 'macos-uid' : 'linux-cgroup-v2',
      OPENCOVEN_UNIX_CGROUP_PATH:
        process.platform === 'darwin' ? undefined : '/opencoven-chat-0123456789abcdef',
      OPENCOVEN_UNIX_WORKSPACE: fixture.workspace,
      OPENCOVEN_UNIX_ARTIFACT_DIRECTORY: fixture.artifactDirectory,
      OPENCOVEN_UNIX_SOURCE_RECORD: fixture.sourceRecord,
    };
    const runtime = {
      environment,
      platform: process.platform,
      architecture: process.arch,
      currentUid,
      cgroupMembership:
        process.platform === 'darwin' ? '' : '0::/opencoven-chat-0123456789abcdef\n',
    };
    try {
      expect(
        parseArgs(
          [
            '--validator-revision',
            'd'.repeat(40),
            '--platform',
            platform,
            '--output',
            fixture.sourceRecord,
          ],
          runtime,
        ),
      ).toMatchObject({
        platform,
        validatorRevision: 'd'.repeat(40),
        outputPath: fixture.sourceRecord,
      });
      expect(() =>
        parseArgs(['--validator-revision', 'd'.repeat(40), '--platform', 'linux-x64'], runtime),
      ).toThrow(/requires --output/u);
      expect(() =>
        parseArgs(['--platform', 'linux-x64', '--output', fixture.sourceRecord], runtime),
      ).toThrow(/requires --validator-revision/u);
      expect(() =>
        parseArgs(
          [
            '--validator-revision',
            'D'.repeat(40),
            '--platform',
            platform,
            '--output',
            fixture.sourceRecord,
          ],
          runtime,
        ),
      ).toThrow(/lowercase immutable 40-character commit SHA/u);
      expect(() =>
        parseArgs(
          [
            '--platform',
            platform,
            '--validator-revision',
            'd'.repeat(40),
            '--output',
            resolve(fixture.artifactDirectory, 'client-v1-conformance-other.json'),
          ],
          runtime,
        ),
      ).toThrow(/artifact/u);
      expect(() =>
        parseArgs(
          [
            '--platform',
            platform,
            '--validator-revision',
            'd'.repeat(40),
            '--output',
            fixture.sourceRecord,
            '--retain-sanitized-report',
            './legacy.json',
          ],
          runtime,
        ),
      ).toThrow(/cannot combine/u);
      expect(() =>
        parseArgs(['--validator-revision', 'd'.repeat(40), '--scenario', 'all'], runtime),
      ).toThrow(/only valid with schema-v2/u);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test('binds schema output to the supervisor path while retaining the supplied Chat source', () => {
    const platform = process.platform === 'darwin' ? 'darwin-arm64' : 'linux-x64';
    const fixture = createSupervisorArtifactFixture(platform);
    const currentUid = process.getuid?.() ?? 1977;
    const brokerUid = currentUid === 1 ? 2 : currentUid - 1;
    const chatSourceRoot = resolve(fixture.root, 'workflow-chat-source');
    mkdirSync(chatSourceRoot, { mode: 0o555 });
    const environment = {
      ...process.env,
      OPENCOVEN_UNIX_PRODUCER_REQUIRED: '1',
      OPENCOVEN_UNIX_PRODUCER_PLATFORM: platform,
      OPENCOVEN_UNIX_PRODUCER_UID: String(currentUid),
      OPENCOVEN_UNIX_PRODUCER_NAME: 'ocv0123456789abcdef',
      OPENCOVEN_UNIX_BROKER_UID: String(brokerUid),
      OPENCOVEN_UNIX_CONTAINMENT: process.platform === 'darwin' ? 'macos-uid' : 'linux-cgroup-v2',
      OPENCOVEN_UNIX_CGROUP_PATH:
        process.platform === 'darwin' ? undefined : '/opencoven-chat-0123456789abcdef',
      OPENCOVEN_UNIX_WORKSPACE: fixture.workspace,
      OPENCOVEN_UNIX_ARTIFACT_DIRECTORY: fixture.artifactDirectory,
      OPENCOVEN_UNIX_SOURCE_RECORD: fixture.sourceRecord,
    };
    try {
      const parsed = parseArgs(
        [
          '--chat-root',
          chatSourceRoot,
          '--validator-revision',
          'd'.repeat(40),
          '--platform',
          platform,
          '--output',
          fixture.sourceRecord,
        ],
        {
          environment,
          platform: process.platform,
          architecture: process.arch,
          currentUid,
          cgroupMembership:
            process.platform === 'darwin' ? '' : '0::/opencoven-chat-0123456789abcdef\n',
        },
      );
      expect(parsed.chatSourceRoot).toBe(chatSourceRoot);
      expect(parsed.outputPath).toBe(fixture.sourceRecord);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
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
    const root = mkdtempSync(join(tmpdir(), 'phase1-pnpm-version-'));
    const command = resolve(root, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm');
    const originalPath = process.env.PATH;
    try {
      writeFileSync(
        command,
        process.platform === 'win32'
          ? '@echo off\r\necho 10.34.0\r\n'
          : '#!/bin/sh\nprintf "10.34.0\\n"\n',
      );
      if (process.platform !== 'win32') {
        chmodSync(command, 0o700);
      }
      process.env.PATH = `${root}${delimiter}${originalPath ?? ''}`;
      expect(observeReleaseToolVersions()).toEqual({
        nodeVersion: 'v24.18.1',
        packageManagerVersion: 'pnpm@10.34.0',
        rustVersion: '1.95.0',
      });
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

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

  test('extracts only one allowlisted verified-runner diagnostic from captured stderr', () => {
    expect(
      extractVerifiedRunnerDiagnostic(
        [
          'private compiler output',
          'phase1-conformance: phase1.coven-identity.socket-mode',
          'private operator path',
        ].join('\n'),
      ),
    ).toBe('phase1.coven-identity.socket-mode');
    expect(
      extractVerifiedRunnerDiagnostic('phase1-conformance: private operator path'),
    ).toBeUndefined();
    expect(
      extractVerifiedRunnerDiagnostic(
        [
          'phase1-conformance: phase1.coven-identity.socket-mode',
          'phase1-conformance: phase1.stage.isolation.failed',
        ].join('\n'),
      ),
    ).toBeUndefined();
  });

  test('classifies the failed Cave release build phase without exposing output', () => {
    const failure = new CommandExecutionError('private command', {
      code: 1,
      stdout: [
        '> coven-cave@0.3.11 prebuild /private/coven-cave',
        '> coven-cave@0.3.11 build /private/coven-cave',
        'Creating an optimized production build',
        '> coven-cave@0.3.11 build:server /private/coven-cave',
        '> coven-cave@0.3.11 postbuild /private/coven-cave',
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

  test('preserves a bounded Cave build diagnostic through schema-v2 stage wrapping', async () => {
    // @ts-expect-error The executable script intentionally has no declaration file.
    const producer = (await import('../scripts/phase1-schema-v2-producer.mjs')) as Record<
      string,
      unknown
    >;
    const diagnose = producer.schemaV2FailureDiagnostic;
    expect(diagnose).toBeTypeOf('function');
    if (typeof diagnose !== 'function') {
      return;
    }
    const SchemaV2CommandExecutionError = producer.CommandExecutionError as new (
      label: string,
      result: {
        code: number;
        signal: null;
        stdout: string;
        stderr: string;
      },
    ) => Error;
    const failure = new SchemaV2CommandExecutionError('private command', {
      code: 1,
      signal: null,
      stdout: 'Creating an optimized production build\nuncaughtException: spawn EAGAIN',
      stderr: 'private operator path',
    });

    const diagnostic = diagnose(failure, 'phase1.packaging.cave-build.failed');

    expect(diagnostic).toBe('phase1.packaging.cave-build.phase.next-build.resource.spawn');
    expect(diagnostic).not.toContain('private');
  });

  test('classifies an actual pnpm Cave prebuild header with its workspace path', async () => {
    // @ts-expect-error The executable script intentionally has no declaration file.
    const producer = (await import('../scripts/phase1-schema-v2-producer.mjs')) as Record<
      string,
      unknown
    >;
    const diagnose = producer.schemaV2FailureDiagnostic;
    const SchemaV2CommandExecutionError = producer.CommandExecutionError as new (
      label: string,
      result: {
        code: number;
        signal: null;
        stdout: string;
        stderr: string;
      },
    ) => Error;
    expect(diagnose).toBeTypeOf('function');
    if (typeof diagnose !== 'function') {
      return;
    }
    const failure = new SchemaV2CommandExecutionError('private command', {
      code: 1,
      signal: null,
      stdout: '> coven-cave@0.3.12 prebuild /private/coven-cave\nprivate generator failure',
      stderr: 'private operator path',
    });

    const diagnostic = diagnose(failure, 'phase1.packaging.cave-build.failed');

    expect(diagnostic).toBe('phase1.packaging.cave-build.phase.prebuild');
    expect(diagnostic).not.toContain('private');
  });

  test.each([
    ['memory-exhausted', 'phase1.packaging.cave-build.phase.next-build.resource.memory'],
    ['process-killed', 'phase1.packaging.cave-build.phase.next-build.resource.killed'],
    ['page-data-failed', 'phase1.packaging.cave-build.phase.next-build.page-data'],
    ['compile-failed', 'phase1.packaging.cave-build.phase.next-build.compile'],
    ['compiler-crash', 'phase1.packaging.cave-build.phase.next-build.compile'],
    ['worker-exited', 'phase1.packaging.cave-build.phase.next-build.compile'],
    ['turbopack-plugin-timeout', 'phase1.packaging.cave-build.timeout'],
    ['disk-exhausted', 'phase1.packaging.cave-build.phase.next-build.resource'],
  ])(
    'preserves the classified Cave build %s reason without raw output',
    async (reason, expected) => {
      // @ts-expect-error The executable script intentionally has no declaration file.
      const producer = (await import('../scripts/phase1-schema-v2-producer.mjs')) as Record<
        string,
        unknown
      >;
      const diagnose = producer.schemaV2FailureDiagnostic;
      const SchemaV2CommandExecutionError = producer.CommandExecutionError as new (
        label: string,
        result: {
          code: number;
          reason: string;
          stdout: string;
          stderr: string;
        },
      ) => Error;
      expect(diagnose).toBeTypeOf('function');
      if (typeof diagnose !== 'function') {
        return;
      }
      const failure = new SchemaV2CommandExecutionError('private command', {
        code: 1,
        reason,
        stdout: 'private output without a phase banner',
        stderr: 'private operator path',
      });

      const diagnostic = diagnose(failure, 'phase1.packaging.cave-build.failed');

      expect(diagnostic).toBe(expected);
      expect(diagnostic).not.toContain('private');
    },
  );

  test('publishes only an allowlisted schema-v2 native failure stage', async () => {
    // @ts-expect-error The executable script intentionally has no declaration file.
    const producer = (await import('../scripts/phase1-schema-v2-producer.mjs')) as Record<
      string,
      unknown
    >;
    const diagnose = producer.schemaV2NativeFailureDiagnostic;
    expect(diagnose).toBeTypeOf('function');
    if (typeof diagnose !== 'function') {
      return;
    }

    expect(diagnose('restart-health')).toBe('phase1.native-scenarios.restart-health');
    expect(diagnose('private operator path')).toBe('phase1.stage.native-scenarios.failed');
  });

  test.each(['cleanup-grant', 'cleanup-custody', 'cleanup-rpc', 'cleanup-fixture-daemon'])(
    'publishes the bounded schema-v2 native %s stage',
    async (stage) => {
      // @ts-expect-error The executable script intentionally has no declaration file.
      const producer = (await import('../scripts/phase1-schema-v2-producer.mjs')) as Record<
        string,
        unknown
      >;
      const diagnose = producer.schemaV2NativeFailureDiagnostic;
      expect(diagnose).toBeTypeOf('function');
      if (typeof diagnose !== 'function') {
        return;
      }
      expect(diagnose(stage)).toBe(`phase1.native-scenarios.${stage}`);
    },
  );

  test('retains the first caught schema-v2 native assertion failure', async () => {
    // @ts-expect-error The executable script intentionally has no declaration file.
    const producer = (await import('../scripts/phase1-schema-v2-producer.mjs')) as Record<
      string,
      unknown
    >;
    const retain = producer.retainSchemaV2NativeFailure;
    expect(retain).toBeTypeOf('function');
    if (typeof retain !== 'function') {
      return;
    }
    const first = retain(undefined, 'launch', new Error('private launch failure')) as Error;
    const retained = retain(first, 'reads', new Error('private read failure')) as Error;

    expect(first.message).toBe('phase1.native-scenarios.launch');
    expect(first.cause).toEqual(new Error('private launch failure'));
    expect(retained).toBe(first);
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
    'supervises a validated POSIX multicall symlink through its invocation path',
    async () => {
      const root = createProcessOwnedArtifactRoot({
        prefix: 'phase1-multicall-supervisor',
      });
      try {
        const target = realpathSync(process.execPath);
        const command = resolve(root.rootPath, 'rustc');
        symlinkSync(target, command);
        const args = [
          '--input-type=module',
          '--eval',
          "import { basename } from 'node:path'; process.stdout.write(basename(process.argv0));",
        ];

        const result = await runSupervisedCommandForTest(root, command, args, {
          cwd: root.rootPath,
          env: { ...process.env, PATH: root.rootPath },
          timeoutMs: 5_000,
          outputLimitBytes: 4_096,
        });

        expect(result).toMatchObject({ stdout: 'rustc' });
      } finally {
        await root.cleanup();
      }
    },
    30_000,
  );

  test.skipIf(process.platform === 'win32')(
    'supervises a validated target with a separate multicall invocation name',
    async () => {
      const root = createProcessOwnedArtifactRoot({
        prefix: 'phase1-validated-supervisor-target',
      });
      try {
        const target = realpathSync(process.execPath);
        const command = resolve(root.rootPath, 'rustc');
        const supervisor = resolve(projectRoot, 'scripts', 'phase1-process-supervisor.mjs');
        symlinkSync(target, command);
        const child = spawn(
          process.execPath,
          [
            supervisor,
            '--timeout-ms',
            '5000',
            '--invocation-path',
            command,
            '--',
            target,
            '--input-type=module',
            '--eval',
            "import { basename } from 'node:path'; process.stdout.write(basename(process.argv0));",
          ],
          {
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
          },
        );
        const stdout: Buffer[] = [];
        const statusFrames: Buffer[] = [];
        const stdoutStream = child.stdout;
        const statusStream = child.stdio[3];
        if (stdoutStream === null || statusStream === null || statusStream === undefined) {
          throw new Error('Supervisor output stream was unavailable.');
        }
        stdoutStream.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
        statusStream.on('data', (chunk) => statusFrames.push(Buffer.from(chunk)));
        await new Promise<void>((resolveClose, rejectClose) => {
          child.once('error', rejectClose);
          child.once('close', () => resolveClose());
        });

        expect(Buffer.concat(stdout).toString('utf8')).toBe('rustc');
        expect(parseSupervisorStatusFrame(Buffer.concat(statusFrames))).toEqual({
          code: 0,
          signal: null,
          reason: 'exit',
        });
      } finally {
        await root.cleanup();
      }
    },
    30_000,
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
    expect(
      publicPhase1FailureDiagnostic(new Error('phase1.stage.runner-checkout.unsafe-source-owner')),
    ).toBe('phase1.stage.runner-checkout.unsafe-source-owner');
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
    expect(
      publicPhase1FailureDiagnostic(
        new Error('private outer wrapper', {
          cause: new Error('phase1.native-scenarios.restart-discovery'),
        }),
      ),
    ).toBe('phase1.native-scenarios.restart-discovery');
    expect(publicPhase1FailureDiagnostic(new Error('private operator path'))).toBeUndefined();
  });

  test('preserves a verified-runner failure when bootstrap cleanup also fails', async () => {
    const harness = (await import('../scripts/phase1-conformance.mjs')) as Record<string, unknown>;
    const throwCombined = harness.throwCombinedPhase1Failures;
    expect(throwCombined).toBeTypeOf('function');
    if (typeof throwCombined !== 'function') {
      return;
    }
    const primary = new Error('phase1.packaging.cave-build.phase.prebuild');
    const cleanup = new Error('private bootstrap cleanup path');

    let failure: unknown;
    try {
      throwCombined(primary, cleanup, 'Verified runner execution and cleanup both failed.');
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(publicPhase1FailureDiagnostic(failure)).toBe(
      'phase1.packaging.cave-build.phase.prebuild',
    );
  });

  test('classifies unsafe local checkout ownership without exposing the repository path', () => {
    const diagnostic = runnerCheckoutFailureDiagnostic(
      new CommandExecutionError('Verified runner clone', {
        code: 128,
        signal: null,
        stdout: '',
        stderr:
          "fatal: detected dubious ownership in repository at '/private/operator/repository/.git'",
      }),
    );

    expect(diagnostic).toBe('phase1.stage.runner-checkout.unsafe-source-owner');
    expect(diagnostic).not.toContain('/private/operator/repository');
  });

  test.each([
    'phase1.stage.isolation-proof.failed',
    'phase1.stage.assertion-recording.failed',
    'phase1.stage.evidence-build.failed',
    'phase1.stage.evidence-validation.failed',
    'phase1.stage.evidence-retention.failed',
  ])('publishes the bounded post-runtime diagnostic %s', (diagnosticId) => {
    expect(publicPhase1FailureDiagnostic(new Error(diagnosticId))).toBe(diagnosticId);
  });

  test.each([
    ['evidence exceeds the 1-byte evidence limit', 'size'],
    ['Evidence exceeds the 50000-node limit', 'size'],
    ['Evidence exceeds the 32-level depth limit', 'size'],
    ['Chat Phase 1 platform evidence is not valid JSON: private parser detail', 'json'],
    ['duplicate JSON object key at private.path', 'duplicate-key'],
    ['evidence.private contains a possible secret', 'possible-secret'],
    ['evidence.private contains a private filesystem path', 'private-path'],
    ['forbidden evidence field "private"', 'forbidden-field'],
    ['evidence.private contains a non-JSON value', 'non-json'],
    ['Chat Phase 1 platform evidence.private has unexpected field "detail"', 'shape'],
    ['private validator failure', 'unknown'],
  ])('classifies evidence validation %s without exposing details', (message, category) => {
    const diagnosticId = `phase1.stage.evidence-validation.${category}`;
    expect(evidenceValidationFailureDiagnostic(new Error(message))).toBe(diagnosticId);
    expect(publicPhase1FailureDiagnostic(new Error(diagnosticId))).toBe(diagnosticId);
  });

  test('wraps operator-state comparison in the bounded isolation-proof stage', () => {
    const source = readFileSync(resolve(projectRoot, 'scripts', 'phase1-conformance.mjs'), 'utf8');
    const postRuntime = source.slice(
      source.indexOf('const { operatorStateAfter, isolationRoots }'),
      source.indexOf("const assertionResults = runPublicPhase1Stage('phase1.stage.assertion"),
    );

    expect(postRuntime).toContain("'phase1.stage.isolation-proof.failed'");
    expect(postRuntime).toContain('operatorStateAfter: finalizeOperatorSafety({');
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

  test('classifies the first failed runtime scenario without exposing private output', () => {
    const classifications = [
      [
        'phase1.missing-cave.validated-launch',
        'phase1.runtime-assertions.missing-cave-validated-launch',
      ],
      [
        'phase1.pairing.create-pending-approve-exchange',
        'phase1.runtime-assertions.pairing-create-pending-approve-exchange',
      ],
      ['phase1.pairing.denial', 'phase1.runtime-assertions.pairing-denial'],
      ['phase1.pairing.expiry', 'phase1.runtime-assertions.pairing-expiry'],
      [
        'phase1.pairing.wrong-secret-replay',
        'phase1.runtime-assertions.pairing-wrong-secret-replay',
      ],
      [
        'phase1.pairing.failure-budget-retry-after',
        'phase1.runtime-assertions.pairing-failure-budget-retry-after',
      ],
      ['phase1.credential.restart-reuse', 'phase1.runtime-assertions.credential-restart-reuse'],
      [
        'phase1.credential.revocation-repair',
        'phase1.runtime-assertions.credential-revocation-repair',
      ],
      ['phase1.hpke.endpoint-takeover', 'phase1.runtime-assertions.hpke-endpoint-takeover'],
      ['phase1.reads.bounded-canonical', 'phase1.runtime-assertions.reads-bounded-canonical'],
      [
        'phase1.reads.stale-generation-cursor-reconciliation',
        'phase1.runtime-assertions.reads-stale-generation-cursor-reconciliation',
      ],
      ['phase1.coven.same-user-identity', 'phase1.runtime-assertions.coven-same-user-identity'],
      [
        'phase1.native.missing-keychain-trust',
        'phase1.runtime-assertions.native-missing-keychain-trust',
      ],
    ] as const;
    const results = new Map<string, { status: string }>();

    for (const [id, diagnosticId] of classifications) {
      const diagnostic = runtimeScenarioFailureDiagnostic(results);
      expect(diagnostic).toBe(diagnosticId);
      expect(publicPhase1FailureDiagnostic(new Error(diagnostic))).toBe(diagnosticId);
      results.set(id, { status: 'passed' });
    }
    expect(runtimeScenarioFailureDiagnostic(results)).toBeUndefined();
  });

  test.each([
    'rpc-start',
    'unavailable-health',
    'daemon-spawn',
    'daemon-ready',
    'malicious-home',
    'wrong-mode-home',
    'symlink-socket-home',
    'socket-mode',
    'result',
  ])('classifies the fixed Coven identity %s stage', (stage) => {
    const diagnosticId = covenIdentityFailureDiagnostic(stage);
    expect(diagnosticId).toBe(`phase1.coven-identity.${stage}`);
    expect(publicPhase1FailureDiagnostic(new Error(diagnosticId))).toBe(diagnosticId);
    expect(
      runtimeScenarioFailureDiagnostic(
        new Map([
          ['phase1.missing-cave.validated-launch', { status: 'passed' }],
          ['phase1.pairing.create-pending-approve-exchange', { status: 'passed' }],
          ['phase1.pairing.denial', { status: 'passed' }],
          ['phase1.pairing.expiry', { status: 'passed' }],
          ['phase1.pairing.wrong-secret-replay', { status: 'passed' }],
          ['phase1.pairing.failure-budget-retry-after', { status: 'passed' }],
          ['phase1.credential.restart-reuse', { status: 'passed' }],
          ['phase1.credential.revocation-repair', { status: 'passed' }],
          ['phase1.hpke.endpoint-takeover', { status: 'passed' }],
          ['phase1.reads.bounded-canonical', { status: 'passed' }],
          ['phase1.reads.stale-generation-cursor-reconciliation', { status: 'passed' }],
          ['phase1.coven.same-user-identity', { status: 'failed', diagnosticIds: [diagnosticId] }],
        ]),
      ),
    ).toBe(diagnosticId);
  });

  test('bounds unknown Coven identity failure stages', () => {
    const diagnosticId = covenIdentityFailureDiagnostic('private stage detail');
    expect(diagnosticId).toBe('phase1.coven-identity.unknown');
    expect(publicPhase1FailureDiagnostic(new Error(diagnosticId))).toBe(diagnosticId);
  });

  test('records the active fixed Coven identity stage on failure', () => {
    const source = readFileSync(resolve(projectRoot, 'scripts', 'phase1-conformance.mjs'), 'utf8');
    const scenario = source.slice(
      source.indexOf('async function runCovenIdentityScenario'),
      source.indexOf('function recordCaveBackedAssertions'),
    );

    for (const stage of [
      'rpc-start',
      'unavailable-health',
      'daemon-spawn',
      'daemon-ready',
      'malicious-home',
      'wrong-mode-home',
      'symlink-socket-home',
      'socket-mode',
      'result',
    ]) {
      expect(scenario).toContain(`activeCovenIdentityStage = '${stage}'`);
    }
    expect(scenario).toContain(
      'const diagnosticId = covenIdentityFailureDiagnostic(activeCovenIdentityStage)',
    );
    expect(scenario).toContain(
      "addAssertion(results, 'phase1.coven.same-user-identity', 'failed', diagnosticId)",
    );
  });

  test('expects the bounded production diagnostic from rejected Coven child probes', () => {
    const source = readFileSync(resolve(projectRoot, 'scripts', 'phase1-conformance.mjs'), 'utf8');
    const scenario = source.slice(
      source.indexOf('async function runCovenIdentityScenario'),
      source.indexOf('function recordCaveBackedAssertions'),
    );

    expect(scenario.match(/'service_unavailable'/gu)).toHaveLength(5);
    expect(scenario).not.toContain("'reconcile_required'");
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
      const owned = createProcessOwnedArtifactRoot({
        prefix: 'fp',
        shortPath: true,
      });
      const home = owned.rootPath;
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
        await owned.cleanup();
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
        expect(stderr).toMatch(
          /phase1\.stage\.(?:native-provider|harness-authority|checkouts)\.failed/u,
        );
        expect(stderr).not.toContain('phase1.environment.rust-toolchain.failed');
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
    30_000,
  );

  test('allows cold isolated Cargo builds to exceed the general command deadline', () => {
    expect(cargoBuildTimeoutMs).toBeGreaterThan(20 * 60_000);
  });
});
