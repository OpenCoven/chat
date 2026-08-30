import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  createProcessOwnedArtifactRoot,
  type ProcessOwnedArtifactRoot,
} from '../scripts/process-owned-artifact-root.mjs';

const activeChildren = new Set<ChildProcess>();
const activeRoots = new Set<ProcessOwnedArtifactRoot>();
const scratchRoots: string[] = [];

afterEach(async () => {
  for (const child of activeChildren) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  }
  await Promise.allSettled(
    [...activeChildren].map(
      (child) =>
        new Promise<void>((resolveClose) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolveClose();
            return;
          }
          child.once('close', () => resolveClose());
        }),
    ),
  );
  activeChildren.clear();

  for (const root of activeRoots) {
    await root.cleanup().catch(() => undefined);
  }
  activeRoots.clear();

  for (const scratchRoot of scratchRoots.splice(0)) {
    rmSync(scratchRoot, { force: true, recursive: true });
  }
});

function createRoot(options: { terminationGraceMs?: number } = {}) {
  const root = createProcessOwnedArtifactRoot({
    prefix: 'phase1-conformance',
    ...options,
  });
  activeRoots.add(root);
  return root;
}

function createScratchRoot(prefix: string) {
  const parent = resolve(process.cwd(), 'test-results', 'vitest', 'phase1-artifact-root');
  mkdirSync(parent, { recursive: true });
  const scratchRoot = mkdtempSync(resolve(parent, `${prefix}-`));
  scratchRoots.push(scratchRoot);
  return scratchRoot;
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

function writeSupervisorWorker(root: ProcessOwnedArtifactRoot, name: string, source: string) {
  const workerPath = resolve(root.rootPath, name);
  writeFileSync(workerPath, `#!/usr/bin/env node\n${source}\n`);
  chmodSync(workerPath, 0o700);
  return workerPath;
}

async function spawnSupervisor(workerPath: string, stderr: 'ignore' | 'pipe' = 'ignore') {
  const supervisorPath = resolve(
    import.meta.dirname,
    '..',
    'scripts',
    'phase1-process-supervisor.mjs',
  );
  const supervisor = spawn(process.execPath, [supervisorPath, workerPath], {
    detached: true,
    stdio: ['ignore', 'ignore', stderr, 'pipe'],
  });
  const status = supervisor.stdio[3];
  if (status !== undefined && status !== null && 'resume' in status) status.resume();
  activeChildren.add(supervisor);
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    supervisor.once('spawn', resolveSpawn);
    supervisor.once('error', rejectSpawn);
  });
  return supervisor;
}

function minimalEvidence(overrides: Record<string, unknown> = {}) {
  return `${JSON.stringify({
    schemaVersion: 1,
    issue: 'OpenCoven/sdk#38',
    platform: 'darwin-arm64',
    ...overrides,
  })}\n`;
}

async function spawnChild(source: string) {
  const child = spawn(process.execPath, ['-e', source], {
    stdio: 'ignore',
  });
  activeChildren.add(child);
  await new Promise<void>((resolveSpawn, rejectSpawn) => {
    child.once('spawn', () => resolveSpawn());
    child.once('error', rejectSpawn);
  });
  return child;
}

describe('process-owned artifact root', () => {
  test('creates a stamped mode-0700 root below the real OS temp directory', () => {
    const root = createRoot();
    const stats = lstatSync(root.rootPath);

    expect(root.rootPath.startsWith(`${realpathSync(tmpdir())}/`)).toBe(true);
    expect(stats.mode & 0o777).toBe(0o700);
    expect(root.ownerPid).toBe(process.pid);
    expect(root.rootDevice).toBe(stats.dev);
    expect(root.rootInode).toBe(stats.ino);
    expect(root.rootStamp).toMatch(/^[0-9a-f-]{36}$/);
  });

  test.skipIf(process.platform === 'win32')(
    'can create an owned short root for Unix socket authorities',
    () => {
      const root = createProcessOwnedArtifactRoot({
        prefix: 'p1',
        shortPath: true,
      });
      activeRoots.add(root);

      expect(resolve(root.rootPath, 'cv', 'coven.sock').length).toBeLessThan(104);
      expect(lstatSync(root.rootPath).mode & 0o777).toBe(0o700);
    },
  );

  test('rejects caller-selected cleanup roots and unsafe prefixes', () => {
    expect(() =>
      createProcessOwnedArtifactRoot({
        prefix: 'phase1-conformance',
        rootPath: process.cwd(),
      } as never),
    ).toThrow(/exactly prefix and optional terminationGraceMs/);
    expect(() => createProcessOwnedArtifactRoot({ prefix: '../escape' })).toThrow(
      /Owned temp prefix/,
    );
  });

  test('terminates and reaps only tracked child processes', async () => {
    const root = createRoot();
    const tracked = await spawnChild('setInterval(() => {}, 1_000)');
    const untracked = await spawnChild('setInterval(() => {}, 1_000)');

    root.trackChild(tracked);
    await root.cleanup();
    activeRoots.delete(root);

    expect(root.cleanedChildren).toEqual([tracked.pid]);
    expect(root.reapedChildren).toEqual([tracked.pid]);
    expect(tracked.signalCode).toBe('SIGTERM');
    expect(untracked.exitCode).toBeNull();
    expect(untracked.signalCode).toBeNull();
    expect(existsSync(root.rootPath)).toBe(false);
  });

  test('continues reverse-order child cleanup after failure and retains root until retry succeeds', async () => {
    const root = createRoot({ terminationGraceMs: 50 });
    const first = await spawnChild('setInterval(() => {}, 1_000)');
    const later = await spawnChild('setInterval(() => {}, 1_000)');
    const failing = await spawnChild('setInterval(() => {}, 1_000)');
    const originalKill = failing.kill.bind(failing);
    failing.kill = (() => false) as typeof failing.kill;
    root.trackChild(first);
    root.trackChild(later);
    root.trackChild(failing);

    await expect(root.cleanup()).rejects.toMatchObject({
      errors: [expect.any(Error)],
    });
    expect(root.reapedChildren).toEqual([later.pid, first.pid]);
    expect(existsSync(root.rootPath)).toBe(true);
    expect(later.exitCode ?? later.signalCode).not.toBeNull();
    expect(first.exitCode ?? first.signalCode).not.toBeNull();
    expect(failing.exitCode).toBeNull();

    failing.kill = originalKill;
    await root.cleanup();
    activeRoots.delete(root);
    expect(root.reapedChildren).toEqual([later.pid, first.pid, failing.pid]);
    expect(existsSync(root.rootPath)).toBe(false);
  });

  test.skipIf(process.platform === 'win32')(
    'supervisor terminates its owned descendant tree without touching an unrelated process',
    async () => {
      const root = createRoot({ terminationGraceMs: 100 });
      const descendantPath = resolve(root.rootPath, 'descendant.pid');
      const workerPath = writeSupervisorWorker(
        root,
        'supervised-worker.cjs',
        [
          "const { spawn } = require('node:child_process');",
          "const { writeFileSync } = require('node:fs');",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', process.stderr] });",
          `writeFileSync(${JSON.stringify(descendantPath)}, String(child.pid));`,
          'setInterval(() => {}, 1000);',
        ].join(''),
      );
      const supervisor = await spawnSupervisor(workerPath, 'pipe');
      const unrelated = await spawnChild('setInterval(() => {}, 1_000)');
      await new Promise<void>((resolveReady, rejectReady) => {
        const deadline = Date.now() + 5_000;
        const poll = () => {
          if (existsSync(descendantPath)) {
            resolveReady();
          } else if (Date.now() >= deadline) {
            rejectReady(new Error('descendant PID was not published'));
          } else {
            setTimeout(poll, 10);
          }
        };
        poll();
      });
      const descendantPid = Number(readFileSync(descendantPath, 'utf8'));

      root.trackChild(supervisor);
      await root.cleanup();
      activeRoots.delete(root);

      expect(() => process.kill(descendantPid, 0)).toThrow();
      expect(unrelated.exitCode).toBeNull();
      expect(unrelated.signalCode).toBeNull();
    },
  );

  test.skipIf(process.platform === 'win32')(
    'supervisor cleans descendants when its RPC exits while a pipe remains inherited',
    async () => {
      const root = createRoot({ terminationGraceMs: 100 });
      const descendantPath = resolve(root.rootPath, 'exited-root-descendant.pid');
      const workerPath = writeSupervisorWorker(
        root,
        'crashing-supervised-worker.cjs',
        [
          "const { spawn } = require('node:child_process');",
          "const { writeFileSync } = require('node:fs');",
          "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', process.stderr] });",
          `writeFileSync(${JSON.stringify(descendantPath)}, String(child.pid));`,
          'child.unref();',
          'process.exitCode = 7;',
        ].join(''),
      );
      const supervisor = await spawnSupervisor(workerPath, 'pipe');
      root.trackChild(supervisor);
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        await new Promise<void>((resolveExit) => supervisor.once('exit', () => resolveExit()));
      }
      const descendantPid = Number(readFileSync(descendantPath, 'utf8'));
      const unrelated = await spawnChild('setInterval(() => {}, 1_000)');
      const deadline = Date.now() + 5_000;
      while (processIsLive(descendantPid)) {
        if (Date.now() >= deadline) {
          throw new Error('descendant survived its exited process-group root');
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }

      await root.cleanup();
      activeRoots.delete(root);
      expect(unrelated.exitCode).toBeNull();
      expect(unrelated.signalCode).toBeNull();
    },
  );

  test.skipIf(process.platform === 'win32')(
    'supervisor kills a detached-stdio descendant that ignores graceful termination',
    async () => {
      const root = createRoot({ terminationGraceMs: 100 });
      const descendantPath = resolve(root.rootPath, 'ignoring-descendant.pid');
      const workerPath = writeSupervisorWorker(
        root,
        'ignoring-supervised-worker.cjs',
        [
          "const { spawn } = require('node:child_process');",
          "const { writeFileSync } = require('node:fs');",
          "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"], { stdio: 'ignore' });",
          `writeFileSync(${JSON.stringify(descendantPath)}, String(child.pid));`,
          'child.unref();',
          'process.exitCode = 7;',
        ].join(''),
      );
      const supervisor = await spawnSupervisor(workerPath);
      root.trackChild(supervisor);
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        await new Promise<void>((resolveExit) => supervisor.once('exit', () => resolveExit()));
      }
      const descendantPid = Number(readFileSync(descendantPath, 'utf8'));
      const deadline = Date.now() + 5_000;
      while (processIsLive(descendantPid)) {
        if (Date.now() >= deadline) {
          throw new Error('SIGTERM-ignoring descendant survived supervisor escalation');
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      await root.cleanup();
      activeRoots.delete(root);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'supervisor kills detached descendants after a successful RPC exit',
    async () => {
      const root = createRoot({ terminationGraceMs: 100 });
      const descendantPath = resolve(root.rootPath, 'successful-descendant.pid');
      const workerPath = writeSupervisorWorker(
        root,
        'successful-supervised-worker.cjs',
        [
          "const { spawn } = require('node:child_process');",
          "const { writeFileSync } = require('node:fs');",
          "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"], { stdio: 'ignore' });",
          `writeFileSync(${JSON.stringify(descendantPath)}, String(child.pid));`,
          'child.unref();',
        ].join(''),
      );
      const supervisor = await spawnSupervisor(workerPath);
      root.trackChild(supervisor);
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        await new Promise<void>((resolveExit) => supervisor.once('exit', () => resolveExit()));
      }
      expect(supervisor.signalCode).toBe('SIGKILL');
      const descendantPid = Number(readFileSync(descendantPath, 'utf8'));
      const deadline = Date.now() + 5_000;
      while (processIsLive(descendantPid)) {
        if (Date.now() >= deadline) {
          throw new Error('descendant survived successful supervised RPC exit');
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      await root.cleanup();
      activeRoots.delete(root);
    },
  );

  test.skipIf(process.platform === 'win32')(
    'escalates an uncooperative tracked child to SIGKILL and reaps it',
    async () => {
      const root = createRoot({ terminationGraceMs: 50 });
      const child = spawn(
        process.execPath,
        [
          '-e',
          "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1_000)",
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      activeChildren.add(child);
      await new Promise<void>((resolveReady, rejectReady) => {
        if (child.stdout === null) {
          rejectReady(new Error('tracked child stdout was not piped'));
          return;
        }
        child.stdout.once('data', () => resolveReady());
        child.once('error', rejectReady);
      });

      root.trackChild(child);
      await root.cleanup();
      activeRoots.delete(root);

      expect(child.signalCode).toBe('SIGKILL');
      expect(root.reapedChildren).toEqual([child.pid]);
    },
  );

  test('requires a direct ChildProcess object instead of accepting an arbitrary PID', () => {
    const root = createRoot();
    expect(() => root.trackChild(999_999_999 as never)).toThrow(/spawned ChildProcess/);
  });

  test('does not follow nested symlinks while removing its owned root', async () => {
    const root = createRoot();
    const externalRoot = createScratchRoot('external');
    const sentinelPath = resolve(externalRoot, 'sentinel.txt');
    writeFileSync(sentinelPath, 'untouched\n');
    symlinkSync(externalRoot, resolve(root.rootPath, 'external-link'));

    await root.cleanup();
    activeRoots.delete(root);

    expect(readFileSync(sentinelPath, 'utf8')).toBe('untouched\n');
  });

  test('retains one SDK platform evidence record only after the owned root scans clean', async () => {
    const root = createRoot();
    const scratchRoot = createScratchRoot('retain');
    const reportPath = resolve(root.rootPath, 'report.json');
    const destinationPath = resolve(scratchRoot, 'nested', 'sanitized.json');
    const report = {
      schemaVersion: 1,
      issue: 'OpenCoven/sdk#38',
      platform: 'darwin-arm64',
    };
    writeFileSync(reportPath, `${JSON.stringify(report)}\n`, { mode: 0o600 });
    const scans: string[] = [];

    const retainedPath = await root.retainSanitizedJsonReport({
      reportPath,
      destinationPath,
      secretScan: async ({ artifactRoot }) => {
        scans.push(artifactRoot);
      },
    });

    expect(retainedPath).toBe(destinationPath);
    expect(scans).toEqual([root.rootPath]);
    expect(JSON.parse(readFileSync(destinationPath, 'utf8'))).toEqual(report);
    expect(lstatSync(destinationPath).mode & 0o777).toBe(0o600);
  });

  test.each([
    ['incomplete JSON', '{"completed":'],
    ['wrong evidence issue', '{"schemaVersion":1,"issue":"other","platform":"darwin-arm64"}'],
  ])('refuses to retain %s', async (_label, contents) => {
    const root = createRoot();
    const scratchRoot = createScratchRoot('incomplete');
    const reportPath = resolve(root.rootPath, 'report.json');
    const destinationPath = resolve(scratchRoot, 'report.json');
    writeFileSync(reportPath, contents);

    await expect(
      root.retainSanitizedJsonReport({
        reportPath,
        destinationPath,
        secretScan: async () => undefined,
      }),
    ).rejects.toThrow(/SDK platform evidence record/);
    expect(existsSync(destinationPath)).toBe(false);
  });

  test('refuses report symlinks, files outside the owned root, and failed scans', async () => {
    const root = createRoot();
    const scratchRoot = createScratchRoot('unsafe-source');
    const outsidePath = resolve(scratchRoot, 'outside.json');
    const reportLink = resolve(root.rootPath, 'report.json');
    const destinationPath = resolve(scratchRoot, 'retained.json');
    writeFileSync(outsidePath, '{"completed":true}\n');
    symlinkSync(outsidePath, reportLink);

    for (const reportPath of [reportLink, outsidePath]) {
      await expect(
        root.retainSanitizedJsonReport({
          reportPath,
          destinationPath,
          secretScan: async () => undefined,
        }),
      ).rejects.toThrow(/regular file inside the owned artifact root/);
    }

    rmSync(reportLink);
    writeFileSync(reportLink, minimalEvidence());
    await expect(
      root.retainSanitizedJsonReport({
        reportPath: reportLink,
        destinationPath,
        secretScan: async () => {
          throw new Error('secret scan failed');
        },
      }),
    ).rejects.toThrow('secret scan failed');
    expect(existsSync(destinationPath)).toBe(false);
  });

  test('never overwrites or recursively deletes a caller-selected retained path', async () => {
    const root = createRoot();
    const scratchRoot = createScratchRoot('caller-path');
    const destinationPath = resolve(scratchRoot, 'report.json');
    const sentinelPath = resolve(scratchRoot, 'sentinel.txt');
    const reportPath = resolve(root.rootPath, 'report.json');
    writeFileSync(destinationPath, 'existing\n');
    writeFileSync(sentinelPath, 'untouched\n');
    writeFileSync(reportPath, minimalEvidence());

    await expect(
      root.retainSanitizedJsonReport({
        reportPath,
        destinationPath,
        secretScan: async () => undefined,
      }),
    ).rejects.toThrow(/already exists/);
    await root.cleanup();
    activeRoots.delete(root);

    expect(readFileSync(destinationPath, 'utf8')).toBe('existing\n');
    expect(readFileSync(sentinelPath, 'utf8')).toBe('untouched\n');
  });

  test('rejects symlinked retained destinations and parent directories', async () => {
    const root = createRoot();
    const scratchRoot = createScratchRoot('destination-symlink');
    const outsideRoot = createScratchRoot('destination-outside');
    const reportPath = resolve(root.rootPath, 'report.json');
    const destinationLink = resolve(scratchRoot, 'report.json');
    const parentLink = resolve(scratchRoot, 'linked-parent');
    writeFileSync(reportPath, minimalEvidence());
    writeFileSync(resolve(outsideRoot, 'existing.json'), 'outside\n');
    symlinkSync(resolve(outsideRoot, 'existing.json'), destinationLink);
    symlinkSync(outsideRoot, parentLink);

    for (const destinationPath of [destinationLink, resolve(parentLink, 'retained.json')]) {
      await expect(
        root.retainSanitizedJsonReport({
          reportPath,
          destinationPath,
          secretScan: async () => undefined,
        }),
      ).rejects.toThrow(/symlink|already exists/);
    }
  });

  test('does not copy a report that changes after its secret scan', async () => {
    const root = createRoot();
    const scratchRoot = createScratchRoot('scan-race');
    const reportPath = resolve(root.rootPath, 'report.json');
    const destinationPath = resolve(scratchRoot, 'retained.json');
    writeFileSync(reportPath, minimalEvidence());

    await expect(
      root.retainSanitizedJsonReport({
        reportPath,
        destinationPath,
        secretScan: async () => {
          chmodSync(reportPath, 0o600);
          writeFileSync(reportPath, minimalEvidence({ changed: true }));
        },
      }),
    ).rejects.toThrow(/changed after the secret scan/);
    expect(existsSync(destinationPath)).toBe(false);
  });
});
