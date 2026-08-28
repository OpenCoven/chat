import { spawn } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, test } from 'vitest';

import { createProcessOwnedArtifactRoot } from '../scripts/process-owned-artifact-root.mjs';

const activeChildren = new Set<number>();
const activeRoots: Array<ReturnType<typeof createProcessOwnedArtifactRoot>> = [];

afterEach(async () => {
  for (const pid of activeChildren) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  activeChildren.clear();

  for (const root of activeRoots.splice(0)) {
    try {
      await root.cleanup();
    } catch {
      // scratch cleanup is best-effort between tests
    }
  }
});

function spawnTrackedChild(): Promise<{
  root: ReturnType<typeof createProcessOwnedArtifactRoot>;
  pid: number;
}> {
  return new Promise((resolveTrack, reject) => {
    const root = createProcessOwnedArtifactRoot({ prefix: 'phase1-conformance' });
    activeRoots.push(root);
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    activeChildren.add(child.pid!);
    child.once('spawn', () => {
      resolveTrack({ root, pid: child.pid! });
    });
    child.once('error', reject);
  });
}

describe('process-owned artifact root', () => {
  test('creates mode-0700 process-owned roots below the real OS temp directory', () => {
    const root = createProcessOwnedArtifactRoot({ prefix: 'phase1-conformance' });
    activeRoots.push(root);
    expect(root.rootPath.startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(lstatSync(root.rootPath).mode & 0o777).toBe(0o700);
    expect(root.ownerPid).toBe(process.pid);
  });

  test('kills only tracked child pids during cleanup', async () => {
    const { root, pid } = await spawnTrackedChild();
    await root.trackChild(pid);
    await root.cleanup();
    expect(root.cleanedChildren).toContain(pid);
    expect(lstatSync(root.rootPath, { throwIfNoEntry: false })).toBeUndefined();
  });

  test('refuses to track a non-integer pid', () => {
    const root = createProcessOwnedArtifactRoot({ prefix: 'phase1-conformance' });
    activeRoots.push(root);
    expect(() => root.trackChild(Number.NaN)).toThrow(/positive integer PID/);
  });
});
