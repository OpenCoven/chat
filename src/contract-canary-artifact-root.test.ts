import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
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
  assertCleanGitCheckout,
  assertPackedFixtureMatchesCaveCheckout,
  parseArgs,
  readContractCanaryLock,
} from '../scripts/contract-canary.mjs';
import {
  cleanupOwnedTempRoot,
  createOwnedTempDirectory,
} from '../scripts/owned-temp-directory.mjs';

const createdTempDirectories: Array<ReturnType<typeof createOwnedTempDirectory>> = [];
const scratchRoots: string[] = [];

afterEach(() => {
  while (createdTempDirectories.length > 0) {
    const context = createdTempDirectories.pop();

    if (context === undefined) {
      continue;
    }

    try {
      cleanupOwnedTempRoot(context);
    } catch {
      rmSync(context.rootPath, { force: true, recursive: true });
    }
  }

  while (scratchRoots.length > 0) {
    const scratchRoot = scratchRoots.pop();

    if (scratchRoot !== undefined) {
      rmSync(scratchRoot, { force: true, recursive: true });
    }
  }
});

function runGit(args: string[], cwd: string) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}

function createRepoLocalScratchRoot(prefix: string) {
  const scratchParent = resolve(process.cwd(), 'test-results', 'vitest', 'contract-canary');

  mkdirSync(scratchParent, { recursive: true });

  const scratchRoot = mkdtempSync(resolve(scratchParent, `${prefix}-`));
  scratchRoots.push(scratchRoot);
  return scratchRoot;
}

function createGitWorktreeFixture(prefix: string) {
  const scratchRoot = createRepoLocalScratchRoot(prefix);
  const repoRoot = resolve(scratchRoot, 'repo');
  const worktreeRoot = resolve(scratchRoot, 'worktree');

  mkdirSync(repoRoot, { recursive: true });
  runGit(['init', '--initial-branch=main'], repoRoot);
  runGit(['config', 'user.name', 'OpenCoven Test'], repoRoot);
  runGit(['config', 'user.email', 'opencoven-test@example.com'], repoRoot);
  writeFileSync(resolve(repoRoot, 'tracked.txt'), 'baseline\n');
  runGit(['add', 'tracked.txt'], repoRoot);
  runGit(['commit', '-m', 'baseline'], repoRoot);
  runGit(['worktree', 'add', '--detach', worktreeRoot, 'HEAD'], repoRoot);

  return {
    repoRoot,
    worktreeRoot,
  };
}

describe('contract canary temp directory safety', () => {
  test.each(['.', '..', '../escape', '/Users/buns', '/'])(
    'rejects unsafe temp child path segment %s',
    (name) => {
      expect(() =>
        createOwnedTempDirectory({
          prefix: 'opencoven-chat-contract-canary-test',
          childSegments: [name],
        }),
      ).toThrow(/safe child name/);
    },
  );

  test('creates mode-0700 temp directories under the real OS temp directory', () => {
    const artifactDirectory = createOwnedTempDirectory({
      prefix: 'opencoven-chat-contract-canary-test',
      childSegments: ['harness'],
    });
    createdTempDirectories.push(artifactDirectory);

    expect(realpathSync(artifactDirectory.rootPath).startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(artifactDirectory.path).toBe(resolve(artifactDirectory.rootPath, 'harness'));
    expect(lstatSync(artifactDirectory.rootPath).mode & 0o777).toBe(0o700);
    expect(lstatSync(artifactDirectory.path).mode & 0o777).toBe(0o700);
  });

  test('rejects cleanup after the owned root identity changes', () => {
    const artifactDirectory = createOwnedTempDirectory({
      prefix: 'opencoven-chat-contract-canary-test',
    });
    createdTempDirectories.push(artifactDirectory);

    rmSync(artifactDirectory.rootPath, { force: true, recursive: true });
    mkdirSync(artifactDirectory.rootPath, { recursive: true, mode: 0o700 });

    expect(() => cleanupOwnedTempRoot(artifactDirectory)).toThrow(/changed identity/);
  });

  test('rejects cleanup when a recreated root reuses the freed inode number', () => {
    // The test above depends on the platform allocating a fresh inode for the
    // recreated directory. macOS does; Linux hands back the inode it just
    // freed, so dev/ino match and an inode-only guard waves the impostor
    // through. That divergence is why this passed locally and failed in CI.
    //
    // This one removes the platform from the equation: it recreates the root
    // and then rewrites the recorded dev/ino to whatever the new directory
    // actually has, which is exactly what inode reuse produces. Anything that
    // still refuses is refusing on evidence other than the inode.
    const artifactDirectory = createOwnedTempDirectory({
      prefix: 'opencoven-chat-contract-canary-test',
    });
    createdTempDirectories.push(artifactDirectory);

    rmSync(artifactDirectory.rootPath, { force: true, recursive: true });
    mkdirSync(artifactDirectory.rootPath, { recursive: true, mode: 0o700 });

    const impostorStats = lstatSync(artifactDirectory.rootPath);
    const withReusedInode = {
      ...artifactDirectory,
      rootDevice: impostorStats.dev,
      rootInode: impostorStats.ino,
    };

    expect(() => cleanupOwnedTempRoot(withReusedInode)).toThrow(/changed identity/);
  });

  test('rejects cleanup when the ownership stamp is a symlink to a matching value', () => {
    // A stamp that is read through a symlink could be satisfied by a file the
    // attacker controls elsewhere. The stamp must be a plain file in the root.
    const artifactDirectory = createOwnedTempDirectory({
      prefix: 'opencoven-chat-contract-canary-test',
    });
    createdTempDirectories.push(artifactDirectory);

    const scratchRoot = mkdtempSync(resolve(tmpdir(), 'opencoven-chat-contract-canary-spec-'));
    scratchRoots.push(scratchRoot);

    const forgedStamp = resolve(scratchRoot, 'forged-stamp');
    writeFileSync(forgedStamp, artifactDirectory.rootStamp);

    const stampPath = resolve(artifactDirectory.rootPath, '.opencoven-owned-temp');
    rmSync(stampPath, { force: true });
    symlinkSync(forgedStamp, stampPath);

    expect(() => cleanupOwnedTempRoot(artifactDirectory)).toThrow(/changed identity/);
  });

  test('removes nested symlinks without following them during cleanup', () => {
    const artifactDirectory = createOwnedTempDirectory({
      prefix: 'opencoven-chat-contract-canary-test',
      childSegments: ['harness'],
    });
    const scratchRoot = mkdtempSync(resolve(tmpdir(), 'opencoven-chat-contract-canary-spec-'));
    const externalRoot = resolve(scratchRoot, 'external');

    createdTempDirectories.push(artifactDirectory);
    scratchRoots.push(scratchRoot);

    mkdirSync(externalRoot, { recursive: true });
    mkdirSync(resolve(artifactDirectory.path, 'nested'), { recursive: true });
    writeFileSync(resolve(artifactDirectory.path, 'nested', 'local.txt'), 'local\n');
    writeFileSync(resolve(externalRoot, 'outside.txt'), 'outside\n');
    symlinkSync(externalRoot, resolve(artifactDirectory.path, 'nested', 'escape'));

    cleanupOwnedTempRoot(artifactDirectory);
    createdTempDirectories.pop();

    expect(() => lstatSync(artifactDirectory.rootPath)).toThrow();
    expect(readFileSync(resolve(externalRoot, 'outside.txt'), 'utf8')).toBe('outside\n');
  });

  test('reads the tracked reviewed lock and rejects the removed artifact option', () => {
    const lock = readContractCanaryLock();

    expect(lock.sdk.repository).toBe('OpenCoven/sdk');
    expect(lock.sdk.revision).toBe('a86773cb6ba45084495c00ca364f8646865f1606');
    expect(
      Object.keys((lock.sdk as unknown as { artifacts: Record<string, unknown> }).artifacts),
    ).toEqual(['core', 'cave', 'coven', 'sdk']);
    expect(lock.cave.repository).toBe('OpenCoven/coven-cave');
    expect(lock.cave.revision).toBe('4adc97b1bdafd1012ce4c66de598e82f49329f79');
    expect(() => parseArgs(['--artifact-name', 'local-run'])).toThrow(/Unknown argument/);
  });
});

describe('contract canary checkout cleanliness', () => {
  test('accepts a clean git worktree checkout', () => {
    const { worktreeRoot } = createGitWorktreeFixture('clean');

    expect(assertCleanGitCheckout(worktreeRoot, 'SDK checkout')).toEqual({
      staged: 0,
      unstaged: 0,
      untracked: 0,
    });
  });

  test.each([
    {
      name: 'rejects unstaged changes',
      prefix: 'unstaged',
      mutate(worktreeRoot: string) {
        appendFileSync(resolve(worktreeRoot, 'tracked.txt'), 'dirty\n');
      },
      expectedMessage:
        'SDK checkout at PLACEHOLDER is dirty (1 unstaged change). Contract canary requires a clean checkout with no staged, unstaged, or untracked files.',
    },
    {
      name: 'rejects staged changes',
      prefix: 'staged',
      mutate(worktreeRoot: string) {
        appendFileSync(resolve(worktreeRoot, 'tracked.txt'), 'dirty\n');
        runGit(['add', 'tracked.txt'], worktreeRoot);
      },
      expectedMessage:
        'SDK checkout at PLACEHOLDER is dirty (1 staged change). Contract canary requires a clean checkout with no staged, unstaged, or untracked files.',
    },
    {
      name: 'rejects untracked changes',
      prefix: 'untracked',
      mutate(worktreeRoot: string) {
        writeFileSync(resolve(worktreeRoot, 'secret.txt'), 'dirty\n');
      },
      expectedMessage:
        'SDK checkout at PLACEHOLDER is dirty (1 untracked item). Contract canary requires a clean checkout with no staged, unstaged, or untracked files.',
    },
  ])('$name', ({ prefix, mutate, expectedMessage }) => {
    const { worktreeRoot } = createGitWorktreeFixture(prefix);

    mutate(worktreeRoot);

    expect(() => assertCleanGitCheckout(worktreeRoot, 'SDK checkout')).toThrow(
      expectedMessage.replace('PLACEHOLDER', worktreeRoot),
    );
  });

  describe('contract canary packed consumer isolation', () => {
    test('removes the warm consumer install before its offline assertion', () => {
      const canary = readFileSync(resolve(process.cwd(), 'scripts', 'contract-canary.mjs'), 'utf8');
      const warm = canary.indexOf('isolatedInstallArgs({ offline: false })');
      const removal = canary.indexOf("rmSync(resolve(harnessRoot, 'node_modules')");
      const offline = canary.indexOf('isolatedInstallArgs({ offline: true })');

      expect(warm).toBeGreaterThan(-1);
      expect(removal).toBeGreaterThan(warm);
      expect(offline).toBeGreaterThan(removal);
    });

    test('uses the installed packed Cave fixture as the harness authority', () => {
      const canary = readFileSync(resolve(process.cwd(), 'scripts', 'contract-canary.mjs'), 'utf8');

      expect(assertPackedFixtureMatchesCaveCheckout).toBeTypeOf('function');
      expect(canary).toMatch(
        /resolve\(\s*harnessRoot,\s*'node_modules',\s*'@opencoven',\s*'cave-client',\s*'fixtures'/,
      );
      expect(canary).toContain('assertPackedFixtureMatchesCaveCheckout');
    });
  });
});
