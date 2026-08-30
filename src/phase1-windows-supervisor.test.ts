import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, delimiter, dirname, resolve, win32 } from 'node:path';

import { afterEach, beforeAll, describe, expect, test } from 'vitest';

import {
  normalizeWindowsRealPathForProcess,
  resolveExecutableInvocation,
} from '../scripts/executable-resolution.mjs';
import {
  bootstrapWindowsSupervisor,
  runSupervisedCommandForTest,
  validateSupervisorArtifactFile,
} from '../scripts/phase1-conformance.mjs';

const helperPath = String(process.env.OPENCOVEN_PHASE1_WINDOWS_SUPERVISOR_PATH ?? '');
const expectedSha256 = '372b3e8b5b860e0759da8fa10ddfb6ec338e26d83616254c816a456ae2e1b7c5';
const expectedSize = 333824;
const settleMs = 300;
const waitTimeoutMs = 5_000;

interface OwnedRoot {
  path: string;
  children: ChildProcess[];
  pids: Set<number>;
}

const roots: OwnedRoot[] = [];
const unrelated = new Set<ChildProcess>();
let originalHelper: Buffer;

function root() {
  const path = resolve(process.cwd(), 'test-results', 'windows-supervisor', randomUUID());
  mkdirSync(path, { recursive: true });
  const owned = { path, children: [], pids: new Set<number>() };
  roots.push(owned);
  return owned;
}

function safeRunnerEnvironment() {
  const environment: NodeJS.ProcessEnv = { ...process.env };
  const configuredPath = Object.entries(environment).find(
    ([key, value]) => key.toLowerCase() === 'path' && typeof value === 'string',
  )?.[1];
  for (const key of Object.keys(environment)) {
    if (key.toLowerCase() === 'path') {
      delete environment[key];
    }
  }
  environment.PATH = String(configuredPath ?? '')
    .split(delimiter)
    .filter(
      (entry) =>
        entry.length > 0 &&
        entry === entry.trim() &&
        !entry.includes('"') &&
        win32.isAbsolute(entry),
    )
    .join(delimiter);
  return environment;
}

function artifactRoot(owned: OwnedRoot) {
  return {
    rootPath: owned.path,
    trackChild(child: ChildProcess) {
      owned.children.push(child);
      if (child.pid !== undefined) owned.pids.add(child.pid);
    },
  };
}

function processIsOpenable(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate: () => boolean, message: string, timeoutMs = waitTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

async function waitForFile(path: string) {
  await waitUntil(() => existsSync(path), 'fixture handshake timed out');
}

async function waitGone(pid: number) {
  await waitUntil(() => !processIsOpenable(pid), `process ${pid} remained openable`);
}

async function waitForChildClose(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise<void>((resolveClose) => child.once('close', () => resolveClose())),
    new Promise<never>((_, rejectWait) =>
      setTimeout(() => rejectWait(new Error(`process ${child.pid} was not reaped`)), waitTimeoutMs),
    ),
  ]);
}

async function terminateExactChild(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await waitForChildClose(child);
  if (child.pid !== undefined) await waitGone(child.pid);
}

function assertFleetHelperUnchanged() {
  const current = readFileSync(helperPath);
  expect(current.equals(originalHelper)).toBe(true);
  expect(statSync(helperPath).size).toBe(expectedSize);
  expect(createHash('sha256').update(current).digest('hex')).toBe(expectedSha256);
}

async function settleAbsent(path: string) {
  const deadline = Date.now() + settleMs;
  while (Date.now() < deadline) {
    expect(existsSync(path)).toBe(false);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
}

async function cleanupRoot(owned: OwnedRoot) {
  for (const child of owned.children) {
    await terminateExactChild(child);
  }
  for (const pid of owned.pids) {
    if (processIsOpenable(pid)) {
      process.kill(pid, 'SIGKILL');
      await waitGone(pid);
    }
    expect(processIsOpenable(pid)).toBe(false);
  }
  for (const entry of readdirSync(owned.path)) {
    rmSync(resolve(owned.path, entry), { recursive: true, force: true });
  }
  expect(readdirSync(owned.path)).toEqual([]);
  assertFleetHelperUnchanged();
  rmSync(owned.path, { recursive: true, force: true });
  roots.splice(roots.indexOf(owned), 1);
}

function runHelper(
  owned: OwnedRoot,
  args: string[],
  options: { timeoutMs?: number; outputLimit?: number } = {},
) {
  return new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stdout: string;
    stderr: string;
    reason: 'exit' | 'timeout' | 'output-limit';
    helperPid: number;
  }>((resolveRun, rejectRun) => {
    const child = spawn(helperPath, ['--', process.execPath, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    if (child.pid === undefined) {
      rejectRun(new Error('supervisor did not publish a PID'));
      return;
    }
    owned.children.push(child);
    owned.pids.add(child.pid);
    const helperPid = child.pid;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let reason: 'exit' | 'timeout' | 'output-limit' = 'exit';
    let timer: NodeJS.Timeout | undefined;
    const limit = options.outputLimit ?? 64 * 1024;
    const capture = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > limit && reason === 'exit') {
        reason = 'output-limit';
        child.kill('SIGKILL');
      } else {
        target.push(chunk);
      }
    };
    child.once('error', rejectRun);
    child.stdout.on('data', (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer) => capture(stderr, chunk));
    child.once('close', (code, signal) => {
      if (timer !== undefined) clearTimeout(timer);
      resolveRun({
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        reason,
        helperPid,
      });
    });
    if (options.timeoutMs !== undefined) {
      timer = setTimeout(() => {
        reason = 'timeout';
        child.kill('SIGKILL');
      }, options.timeoutMs);
    }
  });
}

afterEach(async () => {
  for (const child of unrelated) {
    await terminateExactChild(child);
    unrelated.delete(child);
  }
  for (const owned of [...roots]) await cleanupRoot(owned);
});

describe.skipIf(process.platform !== 'win32')('frozen Windows process supervisor', () => {
  beforeAll(() => {
    originalHelper = readFileSync(helperPath);
    expect(originalHelper.length).toBe(expectedSize);
    expect(createHash('sha256').update(originalHelper).digest('hex')).toBe(expectedSha256);
  });

  test('propagates stdout, stderr, and exact target exit', async () => {
    const owned = root();
    const targetPidPath = resolve(owned.path, 'target.pid');
    try {
      expect(
        validateSupervisorArtifactFile(helperPath, {
          size: expectedSize,
          sha256: expectedSha256,
        }),
      ).toBeTruthy();
      const result = await runHelper(owned, [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(
          targetPidPath,
        )},String(process.pid));process.stdout.write('out');process.stderr.write('err');process.exit(7)`,
      ]);
      const targetPid = Number(readFileSync(targetPidPath, 'utf8'));
      owned.pids.add(targetPid);
      await waitGone(result.helperPid);
      await waitGone(targetPid);
      expect(result).toMatchObject({ code: 7, signal: null, stdout: 'out', stderr: 'err' });
    } finally {
      await cleanupRoot(owned);
    }
  });

  test('PowerShell outer launcher strips Node preload injection before verified runner startup', async () => {
    const owned = root();
    const marker = resolve(owned.path, 'preload.marker');
    const preload = resolve(owned.path, 'preload.cjs');
    const launcher = resolve(process.cwd(), 'scripts', 'phase1-conformance-launcher.ps1');
    const missingSdk = resolve(owned.path, 'missing-sdk');
    writeFileSync(
      preload,
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'loaded',{flag:'a'});`,
    );
    const powershell = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
    try {
      const runLauncher = async (helper: string, node: string) => {
        const child = spawn(
          powershell,
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-File',
            launcher,
            helper,
            node,
            '--sdk-root',
            missingSdk,
          ],
          {
            cwd: process.cwd(),
            env: { ...process.env, NODE_OPTIONS: `--require=${preload}` },
            stdio: ['ignore', 'ignore', 'pipe'],
            windowsHide: true,
          },
        );
        const stderr: Buffer[] = [];
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
        artifactRoot(owned).trackChild(child);
        await waitForChildClose(child);
        expect(child.exitCode).not.toBe(0);
        return Buffer.concat(stderr).toString('utf8');
      };
      expect(await runLauncher('phase1-process-supervisor.exe', process.execPath)).toContain(
        'trusted inputs must be absolute',
      );
      expect(await runLauncher(helperPath, 'node.exe')).toContain(
        'trusted inputs must be absolute',
      );
      const validFailure = await runLauncher(helperPath, process.execPath);
      expect(validFailure).toContain('phase1-conformance:');
      expect(validFailure).not.toContain('ArgumentList');
      await settleAbsent(marker);
    } finally {
      await cleanupRoot(owned);
    }
  });

  test.each(['rustup', 'git', 'cargo', 'corepack'] as const)(
    'resolves and executes the real %s tool through the frozen helper',
    async (command) => {
      const owned = root();
      try {
        bootstrapWindowsSupervisor({ windowsSupervisorPath: helperPath });
        const environment = safeRunnerEnvironment();
        const invocation = resolveExecutableInvocation(command, environment);
        expect(invocation.resolvedCommand.toLowerCase()).toMatch(/\.(?:exe|cmd|bat|com|js)$/u);
        if (command === 'corepack') {
          expect(invocation.executable).toBe(realpathSync(process.execPath));
          expect(invocation.resolvedCommand.toLowerCase()).toMatch(/corepack\.js$/u);
        }
        const result = (await runSupervisedCommandForTest(
          artifactRoot(owned),
          command,
          ['--version'],
          {
            cwd: owned.path,
            env: environment,
            timeoutMs: 10_000,
            outputLimitBytes: 64 * 1024,
          },
        )) as { stdout: string; stderr: string };
        expect(`${result.stdout}${result.stderr}`.trim().length).toBeGreaterThan(0);
      } finally {
        await cleanupRoot(owned);
      }
    },
  );

  test('honors PATHEXT order and explicit executable and batch extensions', async () => {
    const owned = root();
    const orderedCom = resolve(owned.path, 'ordered.com');
    const orderedExe = resolve(owned.path, 'ordered.exe');
    const spacedDirectory = resolve(owned.path, 'valid-path');
    const batch = resolve(spacedDirectory, 'batch-tool.bat');
    try {
      copyFileSync(process.execPath, orderedCom);
      copyFileSync(process.execPath, orderedExe);
      mkdirSync(spacedDirectory);
      writeFileSync(batch, '@echo off\r\necho %~1\r\n');
      const environment: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(environment)) {
        if (key.toLowerCase() === 'path' || key.toLowerCase() === 'pathext') {
          delete environment[key];
        }
      }
      environment.PATH = owned.path;
      environment.PATHEXT = '.COM;.EXE;.BAT;.CMD';
      bootstrapWindowsSupervisor({ windowsSupervisorPath: helperPath });

      expect(resolveExecutableInvocation('ordered', environment).resolvedCommand).toBe(
        normalizeWindowsRealPathForProcess(realpathSync(orderedCom)),
      );
      expect(resolveExecutableInvocation('ordered.exe', environment).resolvedCommand).toBe(
        normalizeWindowsRealPathForProcess(realpathSync(orderedExe)),
      );
      for (const command of ['ordered', 'ordered.exe']) {
        const result = (await runSupervisedCommandForTest(
          artifactRoot(owned),
          command,
          ['-e', "process.stdout.write('pe-ok')"],
          {
            cwd: owned.path,
            env: environment,
            timeoutMs: 10_000,
            outputLimitBytes: 4_096,
          },
        )) as { stdout: string };
        expect(result.stdout).toBe('pe-ok');
      }
      const systemRoot = process.env.SystemRoot;
      expect(systemRoot).toBeDefined();
      expect(win32.isAbsolute(String(systemRoot))).toBe(true);
      const batchResult = (await runSupervisedCommandForTest(
        artifactRoot(owned),
        batch,
        ['valid spaced arg'],
        {
          cwd: String(systemRoot),
          env: environment,
          timeoutMs: 10_000,
          outputLimitBytes: 4_096,
        },
      )) as { stdout: string };
      expect(batchResult.stdout).toContain('valid spaced arg');
    } finally {
      await cleanupRoot(owned);
    }
  });

  test.each(['&', '|', '<', '>', '(', ')', '^', '%', '!', '"', '\r', '\n', '\0'])(
    'rejects batch argument metacharacter %j before the batch marker executes',
    async (metacharacter) => {
      const owned = root();
      const batch = resolve(owned.path, 'injection-tool.cmd');
      const marker = resolve(owned.path, `batch-injection-${randomUUID()}.marker`);
      try {
        writeFileSync(
          batch,
          [
            '@echo off',
            `"${process.execPath}" -e "require('node:fs').writeFileSync(process.argv[1],'ran',{flag:'wx'})" "${marker}"`,
          ].join('\r\n'),
        );
        bootstrapWindowsSupervisor({ windowsSupervisorPath: helperPath });
        await expect(
          (async () =>
            runSupervisedCommandForTest(
              artifactRoot(owned),
              batch,
              [`payload${metacharacter}injection`],
              {
                cwd: owned.path,
                env: process.env,
                timeoutMs: 5_000,
                outputLimitBytes: 4_096,
              },
            ))(),
        ).rejects.toThrow('Windows batch invocation contains an unsafe token.');
        await settleAbsent(marker);
      } finally {
        await cleanupRoot(owned);
      }
    },
  );

  test.each(['ambiguous', 'missing', 'path-injection'] as const)(
    'rejects %s Windows command resolution before a target marker executes',
    async (kind) => {
      const owned = root();
      const marker = resolve(owned.path, `resolution-${kind}.marker`);
      const tool = resolve(owned.path, 'marker-tool.exe');
      try {
        copyFileSync(process.execPath, tool);
        const markerSource = [
          "const{renameSync,writeFileSync}=require('node:fs');",
          `const p=${JSON.stringify(marker)};`,
          "writeFileSync(p+'.next','ran',{flag:'wx'});renameSync(p+'.next',p);",
        ].join('');
        const environment: NodeJS.ProcessEnv = { ...process.env };
        for (const key of Object.keys(environment)) {
          if (key.toLowerCase() === 'path' || key.toLowerCase() === 'pathext') {
            delete environment[key];
          }
        }
        environment.PATHEXT = '.EXE;.CMD;.BAT;.COM';
        if (kind === 'ambiguous') {
          environment.PATH = owned.path;
          environment.Path = `${owned.path}\\other`;
        } else if (kind === 'missing') {
          environment.PATH = owned.path;
        } else {
          environment.PATH = `.;${owned.path}`;
        }
        bootstrapWindowsSupervisor({ windowsSupervisorPath: helperPath });
        await expect(
          (async () =>
            runSupervisedCommandForTest(
              artifactRoot(owned),
              kind === 'missing' ? 'missing-tool' : 'marker-tool',
              ['-e', markerSource],
              {
                cwd: owned.path,
                env: environment,
                timeoutMs: 5_000,
                outputLimitBytes: 4_096,
              },
            ))(),
        ).rejects.toThrow();
        await settleAbsent(marker);
      } finally {
        await cleanupRoot(owned);
      }
    },
  );

  test.each(['exe', 'com', 'cmd', 'bat'] as const)(
    'ignores malicious PATH-precedence corepack.%s without executing its marker',
    async (extension) => {
      const owned = root();
      const fakeNodeRoot = resolve(owned.path, `fake-node-${extension}`);
      const malicious = resolve(fakeNodeRoot, `corepack.${extension}`);
      const marker = resolve(owned.path, `corepack-${extension}.marker`);
      try {
        mkdirSync(fakeNodeRoot, { recursive: true });
        let maliciousArgs: string[];
        if (extension === 'exe' || extension === 'com') {
          const comspec = process.env.ComSpec ?? process.env.COMSPEC;
          if (comspec === undefined) throw new Error('ComSpec is required for the fixture');
          copyFileSync(comspec, malicious);
          maliciousArgs = ['/d', '/s', '/c', `echo ran>"${marker}"`];
        } else {
          writeFileSync(malicious, `@echo off\r\necho ran>"${marker}"\r\n`);
          maliciousArgs = [];
        }
        const environment: NodeJS.ProcessEnv = { ...process.env };
        for (const key of Object.keys(environment)) {
          if (key.toLowerCase() === 'path' || key.toLowerCase() === 'pathext') {
            delete environment[key];
          }
        }
        environment.PATH = fakeNodeRoot;
        environment.PATHEXT = `.${extension.toUpperCase()}`;
        bootstrapWindowsSupervisor({ windowsSupervisorPath: helperPath });
        const invocation = resolveExecutableInvocation(
          'corepack',
          environment,
          'win32',
          maliciousArgs,
        );
        expect(invocation.executable).toBe(realpathSync(process.execPath));
        expect(invocation.resolvedCommand.toLowerCase()).toMatch(/corepack\.js$/u);
        await runSupervisedCommandForTest(artifactRoot(owned), 'corepack', maliciousArgs, {
          cwd: owned.path,
          env: environment,
          timeoutMs: 5_000,
          outputLimitBytes: 64 * 1024,
        }).catch(() => undefined);
        await settleAbsent(marker);
        await expect(
          (async () =>
            runSupervisedCommandForTest(
              artifactRoot(owned),
              `corepack.${extension}`,
              maliciousArgs,
              {
                cwd: owned.path,
                env: environment,
                timeoutMs: 5_000,
                outputLimitBytes: 64 * 1024,
              },
            ))(),
        ).rejects.toThrow('Explicit Windows Corepack shim requests are forbidden.');
        await settleAbsent(marker);
      } finally {
        await cleanupRoot(owned);
      }
    },
  );

  test.each([
    ['timeout', { timeoutMs: 500 }],
    ['output-limit', { outputLimit: 1024 }],
  ] as const)(
    '%s kills the target and descendant while unrelated survives',
    async (kind, limits) => {
      const owned = root();
      const targetPid = resolve(owned.path, 'target.pid');
      const descendantPid = resolve(owned.path, 'descendant.pid');
      const marker = resolve(owned.path, 'marker');
      const heartbeat = resolve(owned.path, 'unrelated.heartbeat');
      let liveSeparate: ChildProcess | undefined;
      const source = [
        "const{spawn}=require('node:child_process');const{writeFileSync}=require('node:fs');",
        `writeFileSync(${JSON.stringify(targetPid)},String(process.pid));`,
        "const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});",
        `writeFileSync(${JSON.stringify(descendantPid)},String(c.pid));`,
        `writeFileSync(${JSON.stringify(marker)},'ran');`,
        kind === 'output-limit' ? "process.stdout.write('x'.repeat(4096));" : '',
        'setInterval(()=>{},1000);',
      ].join('');
      try {
        const heartbeatSource = [
          "const{appendFileSync}=require('node:fs');",
          `const p=${JSON.stringify(heartbeat)};`,
          "appendFileSync(p,'x');setInterval(()=>appendFileSync(p,'x'),50);",
        ].join('');
        liveSeparate = spawn(process.execPath, ['-e', heartbeatSource], {
          stdio: 'ignore',
          windowsHide: true,
        });
        if (liveSeparate.pid === undefined) {
          throw new Error('unrelated heartbeat process did not publish a PID');
        }
        unrelated.add(liveSeparate);
        await waitForFile(heartbeat);
        const heartbeatSize = statSync(heartbeat).size;
        const result = await runHelper(owned, ['-e', source], limits);
        await waitForFile(marker);
        const target = Number(readFileSync(targetPid, 'utf8'));
        const descendant = Number(readFileSync(descendantPid, 'utf8'));
        owned.pids.add(target);
        owned.pids.add(descendant);
        await waitGone(result.helperPid);
        await waitGone(target);
        await waitGone(descendant);
        await waitUntil(
          () => statSync(heartbeat).size > heartbeatSize,
          'unrelated process heartbeat stopped',
        );
        expect(result.reason).toBe(kind);
        expect(liveSeparate.exitCode).toBeNull();
        expect(liveSeparate.signalCode).toBeNull();
        expect(processIsOpenable(liveSeparate.pid)).toBe(true);
      } finally {
        if (liveSeparate !== undefined) {
          await terminateExactChild(liveSeparate);
          unrelated.delete(liveSeparate);
        }
        await cleanupRoot(owned);
      }
    },
  );

  test.each(['missing', 'wrong-file', 'wrong-size', 'wrong-digest'] as const)(
    'actual bootstrap rejects a %s artifact before the target marker executes',
    async (kind) => {
      const owned = root();
      const marker = resolve(owned.path, `must-not-run-${kind}`);
      const staging = resolve(owned.path, `marker-staging-${kind}`);
      const helperDirectory = dirname(helperPath);
      const backup = resolve(
        helperDirectory,
        `.${basename(helperPath)}.backup-${kind}-${randomUUID()}`,
      );
      let backupCreated = false;
      try {
        expect(dirname(backup)).toBe(helperDirectory);
        linkSync(helperPath, backup);
        backupCreated = true;
        rmSync(helperPath);
        try {
          if (kind === 'wrong-file') mkdirSync(helperPath);
          if (kind === 'wrong-size') writeFileSync(helperPath, 'wrong');
          if (kind === 'wrong-digest') writeFileSync(helperPath, Buffer.alloc(expectedSize));
          const source = [
            "const{renameSync,writeFileSync}=require('node:fs');",
            `writeFileSync(${JSON.stringify(staging)},'ran',{flag:'wx'});`,
            `renameSync(${JSON.stringify(staging)},${JSON.stringify(marker)});`,
          ].join('');
          await expect(
            (async () => {
              bootstrapWindowsSupervisor({ windowsSupervisorPath: helperPath });
              return runSupervisedCommandForTest(
                artifactRoot(owned),
                process.execPath,
                ['-e', source],
                {
                  cwd: owned.path,
                  env: process.env,
                  timeoutMs: 1_000,
                  outputLimitBytes: 4_096,
                },
              );
            })(),
          ).rejects.toThrow();
          await settleAbsent(marker);
          expect(existsSync(staging)).toBe(false);
        } finally {
          rmSync(helperPath, { recursive: true, force: true });
          if (backupCreated) {
            renameSync(backup, helperPath);
            backupCreated = false;
          }
        }
        assertFleetHelperUnchanged();
        expect(existsSync(backup)).toBe(false);
      } finally {
        if (backupCreated) {
          rmSync(helperPath, { recursive: true, force: true });
          renameSync(backup, helperPath);
          backupCreated = false;
        }
        assertFleetHelperUnchanged();
        expect(existsSync(backup)).toBe(false);
        await cleanupRoot(owned);
      }
    },
  );
});
