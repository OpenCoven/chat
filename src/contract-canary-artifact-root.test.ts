import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
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
  type assertContractCanaryCheckoutHeads,
  assertPackedFixtureMatchesCaveCheckout,
  assertPackedPackageContentsMatch,
  createContractCanaryVerifier,
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
    expect(lock.sdk.revision).toBe('163961f4e59cfdef51d2271fa98e7c514977203f');
    expect(Object.keys(lock.sdk.artifacts)).toEqual(['core', 'cave', 'coven', 'sdk']);
    expect(lock.sdk.artifacts.core).toEqual({
      packageName: '@opencoven/sdk-core',
      sha256: '9a574e8bd5178ce2aa20db97e8a741c7c9569515546a2d3089406f41a9d040fe',
    });

    expect(lock.sdk.artifacts.cave).toEqual({
      packageName: '@opencoven/cave-client',
      sha256: '79b3c276af384c3e380b5a259dec83870cef309c5284823fb6cf685c968b1e35',
    });
    expect(lock.cave.repository).toBe('OpenCoven/coven-cave');
    expect(lock.cave.revision).toBe('2a0ff9237e94e652e477b22f60fd6d721b9e6451');
    expect(lock.cave.artifacts).toEqual({
      contractFixture: {
        path: 'src/lib/server/client-v1/contract-fixture.json',
        digestPath: 'src/lib/server/client-v1/contract-fixture.sha256',
        sha256: '1b78125dab5b77414efd2d34e13315f542b197715ed26c6521f588e299abe61d',
      },
      hpkeVectors: {
        path: 'src/lib/server/client-v1/hpke-bound-v1-vectors.json',
        digestPath: 'src/lib/server/client-v1/hpke-bound-v1-vectors.sha256',
        sha256: 'f806967291de12175277b6b24ac3c7bba912ae760fd8227fb21b1a4d5f5e6797',
      },
    });
    expect(() => parseArgs(['--artifact-name', 'local-run'])).toThrow(/Unknown argument/);
  });

  test('compares packed package contents independently of gzip metadata', () => {
    const scratchRoot = createRepoLocalScratchRoot('package-content-equivalence');
    const sourceRoot = resolve(scratchRoot, 'source');
    const packageRoot = resolve(sourceRoot, 'package');
    const reviewed = resolve(scratchRoot, 'reviewed.tgz');
    const frozen = resolve(scratchRoot, 'frozen.tgz');
    const changed = resolve(scratchRoot, 'changed.tgz');

    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(resolve(packageRoot, 'package.json'), '{"name":"fixture"}\n');
    writeFileSync(resolve(packageRoot, 'index.js'), 'export const value = 1;\n');
    execFileSync('tar', ['-czf', reviewed, '-C', sourceRoot, 'package']);
    copyFileSync(reviewed, frozen);
    const frozenBytes = readFileSync(frozen);
    frozenBytes.writeUInt32LE(1, 4);
    writeFileSync(frozen, frozenBytes);
    expect(readFileSync(reviewed).equals(readFileSync(frozen))).toBe(false);

    const reviewedTarballs = {
      core: reviewed,
      cave: reviewed,
      coven: reviewed,
      sdk: reviewed,
    };
    const frozenTarballs = {
      core: frozen,
      cave: frozen,
      coven: frozen,
      sdk: frozen,
    };
    expect(() =>
      assertPackedPackageContentsMatch(
        reviewedTarballs,
        frozenTarballs,
        resolve(scratchRoot, 'matching'),
      ),
    ).not.toThrow();

    writeFileSync(resolve(packageRoot, 'index.js'), 'export const value = 2;\n');
    execFileSync('tar', ['-czf', changed, '-C', sourceRoot, 'package']);
    expect(() =>
      assertPackedPackageContentsMatch(
        reviewedTarballs,
        {
          ...frozenTarballs,
          core: changed,
        },
        resolve(scratchRoot, 'changed'),
      ),
    ).toThrow(/contents did not match/);
  });

  test('declares canary helper inputs at their consumed shapes', () => {
    type CheckoutHeadsInput = Parameters<typeof assertContractCanaryCheckoutHeads>[0];
    type PackedFixtureInput = Parameters<typeof assertPackedFixtureMatchesCaveCheckout>[0];

    const checkoutHeadsInput = {
      sdk: {
        repository: 'OpenCoven/sdk',
        revision: '163961f4e59cfdef51d2271fa98e7c514977203f',
      },
      cave: {
        repository: 'OpenCoven/coven-cave',
        revision: '2a0ff9237e94e652e477b22f60fd6d721b9e6451',
      },
    } satisfies CheckoutHeadsInput;
    const packedFixtureInput = {
      cave: {
        revision: '2a0ff9237e94e652e477b22f60fd6d721b9e6451',
        artifacts: {
          contractFixture: {
            path: 'src/lib/server/client-v1/contract-fixture.json',
            digestPath: 'src/lib/server/client-v1/contract-fixture.sha256',
            sha256: '1b78125dab5b77414efd2d34e13315f542b197715ed26c6521f588e299abe61d',
          },
          hpkeVectors: {
            path: 'src/lib/server/client-v1/hpke-bound-v1-vectors.json',
            digestPath: 'src/lib/server/client-v1/hpke-bound-v1-vectors.sha256',
            sha256: 'f806967291de12175277b6b24ac3c7bba912ae760fd8227fb21b1a4d5f5e6797',
          },
        },
      },
    } satisfies PackedFixtureInput;

    const missingCheckoutRevision: CheckoutHeadsInput = {
      sdk: {
        repository: 'OpenCoven/sdk',
        revision: '163961f4e59cfdef51d2271fa98e7c514977203f',
      },
      // @ts-expect-error Checkout validation consumes cave.revision.
      cave: {
        repository: 'OpenCoven/coven-cave',
      },
    };
    // @ts-expect-error Packed fixture validation consumes cave.revision.
    const missingFixtureRevision: PackedFixtureInput = { cave: {} };

    expect(checkoutHeadsInput.sdk.repository).toBe('OpenCoven/sdk');
    expect(packedFixtureInput.cave.revision).toBe('2a0ff9237e94e652e477b22f60fd6d721b9e6451');
    expect(missingCheckoutRevision).toBeDefined();
    expect(missingFixtureRevision).toBeDefined();
  });

  test.each([
    {
      name: 'missing artifact',
      mutate(artifacts: Record<string, unknown>) {
        delete artifacts.coven;
      },
    },
    {
      name: 'unexpected artifact',
      mutate(artifacts: Record<string, unknown>) {
        artifacts.extra = {
          packageName: '@opencoven/extra',
          sha256: 'a'.repeat(64),
        };
      },
    },
    {
      name: 'unsafe package name',
      mutate(artifacts: Record<string, unknown>) {
        artifacts.core = {
          packageName: '../sdk-core',
          sha256: 'a'.repeat(64),
        };
      },
    },
    {
      name: 'malformed digest',
      mutate(artifacts: Record<string, unknown>) {
        artifacts.core = {
          packageName: '@opencoven/sdk-core',
          sha256: 'not-a-sha256',
        };
      },
    },
    {
      name: 'extra artifact property',
      mutate(artifacts: Record<string, unknown>) {
        artifacts.core = {
          packageName: '@opencoven/sdk-core',
          sha256: 'a'.repeat(64),
          extra: true,
        };
      },
    },
  ])(
    'rejects a $name in the SDK artifact lock map',
    ({ mutate }) => {
      const scratchRoot = createRepoLocalScratchRoot('invalid-sdk-artifacts');
      const lockPath = resolve(scratchRoot, 'contract-canary.lock.json');
      const lock = JSON.parse(
        readFileSync(resolve(process.cwd(), 'contract-canary.lock.json'), 'utf8'),
      );

      mutate(lock.sdk.artifacts);
      writeFileSync(lockPath, JSON.stringify(lock));

      expect(() => readContractCanaryLock(lockPath)).toThrow(/sdk\.artifacts/);
    },
    15_000,
  );
});

describe('contract canary checkout cleanliness', () => {
  test('accepts a clean git worktree checkout', () => {
    const { worktreeRoot } = createGitWorktreeFixture('clean');

    expect(assertCleanGitCheckout(worktreeRoot, 'SDK checkout')).toEqual({
      staged: 0,
      unstaged: 0,
      untracked: 0,
    });
  }, 15_000);

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
  ])(
    '$name',
    ({ prefix, mutate, expectedMessage }) => {
      const { worktreeRoot } = createGitWorktreeFixture(prefix);

      mutate(worktreeRoot);

      expect(() => assertCleanGitCheckout(worktreeRoot, 'SDK checkout')).toThrow(
        expectedMessage.replace('PLACEHOLDER', worktreeRoot),
      );
    },
    15_000,
  );

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

    test('generates and executes a verifier for every shipped public entrypoint', () => {
      const scratchRoot = createRepoLocalScratchRoot('verify-entrypoints');
      const harnessRoot = resolve(scratchRoot, 'harness');
      const verifierPath = resolve(harnessRoot, 'verify.mjs');
      const verifier = createContractCanaryVerifier();

      mkdirSync(harnessRoot, { recursive: true });
      writeFileSync(verifierPath, verifier);
      symlinkSync(
        resolve(process.cwd(), 'node_modules'),
        resolve(harnessRoot, 'node_modules'),
        'dir',
      );

      for (const entrypoint of [
        '@opencoven/sdk-core/browser',
        '@opencoven/cave-client',
        '@opencoven/cave-client/managed',
        '@opencoven/coven-client',
        '@opencoven/sdk',
      ]) {
        expect(verifier).toContain(`from '${entrypoint}'`);
      }

      expect(
        execFileSync(process.execPath, [verifierPath], {
          encoding: 'utf8',
        }),
      ).toBe('Chat contract canary passed.\n');
    }, 30_000);
  });
});
