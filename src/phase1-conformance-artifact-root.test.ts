import { type ChildProcess, spawn } from 'node:child_process';
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

  test('retains one completed JSON report only after the owned root scans clean', async () => {
    const root = createRoot();
    const scratchRoot = createScratchRoot('retain');
    const reportPath = resolve(root.rootPath, 'report.json');
    const destinationPath = resolve(scratchRoot, 'nested', 'sanitized.json');
    const report = { schemaVersion: 1, status: 'passed', completed: true };
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
    ['non-completed report', '{"schemaVersion":1,"completed":false}'],
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
    ).rejects.toThrow(/completed JSON report/);
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
    writeFileSync(reportLink, '{"completed":true}\n');
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
    writeFileSync(reportPath, '{"completed":true}\n');

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
    writeFileSync(reportPath, '{"completed":true}\n');
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
    writeFileSync(reportPath, '{"completed":true}\n');

    await expect(
      root.retainSanitizedJsonReport({
        reportPath,
        destinationPath,
        secretScan: async () => {
          chmodSync(reportPath, 0o600);
          writeFileSync(reportPath, '{"completed":true,"changed":true}\n');
        },
      }),
    ).rejects.toThrow(/changed after the secret scan/);
    expect(existsSync(destinationPath)).toBe(false);
  });
});
