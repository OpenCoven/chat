import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { gzipSync } from 'node:zlib';

import { afterEach, describe, expect, test } from 'vitest';

import {
  assertCleanGitCheckout,
  type assertContractCanaryCheckoutHeads,
  assertGeneratedReleaseManifestMatchesLock,
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
  runGit(['config', 'commit.gpgsign', 'false'], repoRoot);
  writeFileSync(resolve(repoRoot, 'tracked.txt'), 'baseline\n');
  runGit(['add', 'tracked.txt'], repoRoot);
  runGit(['commit', '-m', 'baseline'], repoRoot);
  runGit(['worktree', 'add', '--detach', worktreeRoot, 'HEAD'], repoRoot);

  return {
    repoRoot,
    worktreeRoot,
  };
}

function sha256(bytes: Buffer | string) {
  return createHash('sha256').update(bytes).digest('hex');
}

function createCaveAuthorityFixture() {
  const scratchRoot = createRepoLocalScratchRoot('cave-authority');
  const caveRoot = resolve(scratchRoot, 'cave');
  const harnessRoot = resolve(scratchRoot, 'harness');
  const authorityDirectory = resolve(caveRoot, 'src/lib/server/client-v1');
  const installedFixtureDirectory = resolve(
    harnessRoot,
    'node_modules',
    '@opencoven',
    'cave-client',
    'fixtures',
  );
  const fixtureBytes = Buffer.from('historical Cave contract fixture\n', 'utf8');
  const fixtureDigest = sha256(fixtureBytes);
  const vectorBytes = Buffer.from('current Cave HPKE vector\n', 'utf8');
  const vectorDigest = sha256(vectorBytes);

  mkdirSync(authorityDirectory, { recursive: true });
  mkdirSync(installedFixtureDirectory, { recursive: true });
  runGit(['init', '--object-format=sha1', '--initial-branch=main'], caveRoot);
  runGit(['config', 'user.name', 'OpenCoven Test'], caveRoot);
  runGit(['config', 'user.email', 'opencoven-test@example.com'], caveRoot);
  runGit(['config', 'commit.gpgsign', 'false'], caveRoot);
  writeFileSync(resolve(authorityDirectory, 'contract-fixture.json'), fixtureBytes);
  writeFileSync(resolve(authorityDirectory, 'contract-fixture.sha256'), `${fixtureDigest}\n`);
  runGit(['add', '.'], caveRoot);
  runGit(['commit', '-m', 'contract fixture authority'], caveRoot);
  const provenanceCommit = runGit(['rev-parse', 'HEAD'], caveRoot);

  runGit(['checkout', '-b', 'non-ancestor'], caveRoot);
  writeFileSync(resolve(caveRoot, 'side.txt'), 'side branch\n');
  runGit(['add', 'side.txt'], caveRoot);
  runGit(['commit', '-m', 'non-ancestor authority'], caveRoot);
  const nonAncestorCommit = runGit(['rev-parse', 'HEAD'], caveRoot);
  runGit(['checkout', 'main'], caveRoot);

  writeFileSync(resolve(authorityDirectory, 'hpke-bound-v1-vectors.json'), vectorBytes);
  writeFileSync(resolve(authorityDirectory, 'hpke-bound-v1-vectors.sha256'), `${vectorDigest}\n`);
  runGit(['add', '.'], caveRoot);
  runGit(['commit', '-m', 'HPKE vector authority'], caveRoot);
  const caveRevision = runGit(['rev-parse', 'HEAD'], caveRoot);

  const provenance = {
    repository: 'https://github.com/OpenCoven/coven-cave',
    commit: provenanceCommit,
    fixturePath: 'src/lib/server/client-v1/contract-fixture.json',
    digestPath: 'src/lib/server/client-v1/contract-fixture.sha256',
    sha256: fixtureDigest,
  };
  const installedFixturePath = resolve(installedFixtureDirectory, 'contract-fixture.json');
  const installedDigestPath = resolve(installedFixtureDirectory, 'contract-fixture.sha256');
  const installedProvenancePath = resolve(
    installedFixtureDirectory,
    'contract-fixture.provenance.json',
  );
  const installedVectorPath = resolve(installedFixtureDirectory, 'hpke-bound-v1-vectors.json');

  writeFileSync(installedFixturePath, fixtureBytes);
  writeFileSync(installedDigestPath, `${fixtureDigest}\n`);
  writeFileSync(installedProvenancePath, `${JSON.stringify(provenance, null, 2)}\n`);
  writeFileSync(installedVectorPath, vectorBytes);
  writeFileSync(
    resolve(installedFixtureDirectory, 'hpke-bound-v1-vectors.sha256'),
    `${vectorDigest}\n`,
  );

  const lock: Parameters<typeof assertPackedFixtureMatchesCaveCheckout>[0] = {
    cave: {
      revision: caveRevision,
      artifacts: {
        contractFixture: {
          path: 'src/lib/server/client-v1/contract-fixture.json',
          digestPath: 'src/lib/server/client-v1/contract-fixture.sha256',
          sha256: fixtureDigest,
        },
        hpkeVectors: {
          path: 'src/lib/server/client-v1/hpke-bound-v1-vectors.json',
          digestPath: 'src/lib/server/client-v1/hpke-bound-v1-vectors.sha256',
          sha256: vectorDigest,
        },
      },
    },
  };

  return {
    caveRoot,
    harnessRoot,
    lock,
    nonAncestorCommit,
    provenance,
    installedFixturePath,
    installedDigestPath,
    installedProvenancePath,
    installedVectorPath,
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
    expect(lock.sdk.revision).toBe('acc38488f00860d246c3c553375634d64806eabb');
    expect(lock.sdk.releaseManifest).toEqual({
      file: 'release-manifest.json',
      version: '0.1.0',
      sha256: 'b8bfb62236fc8add4a9baad9f00e5401db15074a2d21fe2847a9158104cefb3c',
    });
    expect(Object.keys(lock.sdk.artifacts)).toEqual(['core', 'cave', 'coven', 'sdk']);
    expect(lock.sdk.artifacts.core).toEqual({
      packageName: '@opencoven/sdk-core',
      version: '0.1.0',
      releaseFile: 'tarballs/core/opencoven-sdk-core-0.1.0.tgz',
      vendorFile: 'sdk-core-0.1.0.tgz',
      size: 33284,
      sha256: '9a574e8bd5178ce2aa20db97e8a741c7c9569515546a2d3089406f41a9d040fe',
    });

    expect(lock.sdk.artifacts.cave).toEqual({
      packageName: '@opencoven/cave-client',
      version: '0.1.0',
      releaseFile: 'tarballs/cave/opencoven-cave-client-0.1.0.tgz',
      vendorFile: 'cave-client-0.1.0.tgz',
      size: 81543,
      sha256: 'c44544adf8e712d6be1e8686788e63aa0133eb318274d1fb1926138a7da148c0',
    });
    expect(lock.cave.repository).toBe('OpenCoven/coven-cave');
    expect(lock.cave.revision).toBe('6325fc4c1154c7d7398074a9760a2e2dc323b424');
    expect(lock.cave.artifacts).toEqual({
      contractFixture: {
        path: 'src/lib/server/client-v1/contract-fixture.json',
        digestPath: 'src/lib/server/client-v1/contract-fixture.sha256',
        sha256: 'c0b1af2442409f8b26bbf0cf2a5fac467d23e5f56d2c966a9428c4b3e830a186',
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
    const trailed = resolve(scratchRoot, 'trailed.tgz');
    const zeroPadded = resolve(scratchRoot, 'zero-padded.tgz');
    const concatenated = resolve(scratchRoot, 'concatenated.tgz');

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
    ).toThrow(/(?:tar payload|contents) did not match/);

    copyFileSync(reviewed, trailed);
    appendFileSync(trailed, 'UNREVIEWED-TRAILER');
    expect(() =>
      assertPackedPackageContentsMatch(
        reviewedTarballs,
        {
          ...frozenTarballs,
          core: trailed,
        },
        resolve(scratchRoot, 'trailed'),
      ),
    ).toThrow(/complete gzip archive/);

    copyFileSync(reviewed, zeroPadded);
    appendFileSync(zeroPadded, Buffer.alloc(4));
    copyFileSync(reviewed, concatenated);
    appendFileSync(concatenated, gzipSync(Buffer.alloc(0)));
    for (const invalid of [zeroPadded, concatenated]) {
      expect(() =>
        assertPackedPackageContentsMatch(
          reviewedTarballs,
          {
            ...frozenTarballs,
            core: invalid,
          },
          resolve(scratchRoot, `invalid-${invalid === zeroPadded ? 'padding' : 'member'}`),
        ),
      ).toThrow(/complete gzip archive/);
    }
  }, 30_000);

  test('declares canary helper inputs at their consumed shapes', () => {
    type CheckoutHeadsInput = Parameters<typeof assertContractCanaryCheckoutHeads>[0];
    type PackedFixtureInput = Parameters<typeof assertPackedFixtureMatchesCaveCheckout>[0];

    const checkoutHeadsInput = {
      sdk: {
        repository: 'OpenCoven/sdk',
        revision: 'acc38488f00860d246c3c553375634d64806eabb',
      },
      cave: {
        repository: 'OpenCoven/coven-cave',
        revision: '6325fc4c1154c7d7398074a9760a2e2dc323b424',
      },
    } satisfies CheckoutHeadsInput;
    const packedFixtureInput = {
      cave: {
        revision: '6325fc4c1154c7d7398074a9760a2e2dc323b424',
        artifacts: {
          contractFixture: {
            path: 'src/lib/server/client-v1/contract-fixture.json',
            digestPath: 'src/lib/server/client-v1/contract-fixture.sha256',
            sha256: 'c0b1af2442409f8b26bbf0cf2a5fac467d23e5f56d2c966a9428c4b3e830a186',
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
        revision: 'acc38488f00860d246c3c553375634d64806eabb',
      },
      // @ts-expect-error Checkout validation consumes cave.revision.
      cave: {
        repository: 'OpenCoven/coven-cave',
      },
    };
    // @ts-expect-error Packed fixture validation consumes cave.revision.
    const missingFixtureRevision: PackedFixtureInput = { cave: {} };

    expect(checkoutHeadsInput.sdk.repository).toBe('OpenCoven/sdk');
    expect(packedFixtureInput.cave.revision).toBe('6325fc4c1154c7d7398074a9760a2e2dc323b424');
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

describe('packed Cave authority artifact validation', () => {
  test('accepts exact historical fixture provenance and reviewed HPKE vector bytes', () => {
    const fixture = createCaveAuthorityFixture();

    expect(() =>
      assertPackedFixtureMatchesCaveCheckout(fixture.lock, fixture.harnessRoot, fixture.caveRoot),
    ).not.toThrow();
  }, 30_000);

  test('rejects mutated installed Cave fixture bytes', () => {
    const fixture = createCaveAuthorityFixture();
    const mutatedFixture = Buffer.from('mutated installed Cave contract fixture\n', 'utf8');
    const mutatedDigest = sha256(mutatedFixture);

    writeFileSync(fixture.installedFixturePath, mutatedFixture);
    writeFileSync(fixture.installedDigestPath, `${mutatedDigest}\n`);
    writeFileSync(
      fixture.installedProvenancePath,
      `${JSON.stringify({ ...fixture.provenance, sha256: mutatedDigest }, null, 2)}\n`,
    );

    expect(() =>
      assertPackedFixtureMatchesCaveCheckout(fixture.lock, fixture.harnessRoot, fixture.caveRoot),
    ).toThrow('Packed Cave fixture bytes did not match their pinned historical producer.');
  }, 30_000);

  test('rejects mutated installed HPKE vector bytes', () => {
    const fixture = createCaveAuthorityFixture();

    writeFileSync(fixture.installedVectorPath, 'mutated installed Cave HPKE vector\n');

    expect(() =>
      assertPackedFixtureMatchesCaveCheckout(fixture.lock, fixture.harnessRoot, fixture.caveRoot),
    ).toThrow('Packed Cave HPKE vectors did not match the reviewed producer revision.');
  }, 30_000);

  test('rejects invalid Cave provenance JSON', () => {
    const fixture = createCaveAuthorityFixture();

    writeFileSync(fixture.installedProvenancePath, '{');

    expect(() =>
      assertPackedFixtureMatchesCaveCheckout(fixture.lock, fixture.harnessRoot, fixture.caveRoot),
    ).toThrow(SyntaxError);
  }, 30_000);

  test('rejects a Cave provenance digest mismatch', () => {
    const fixture = createCaveAuthorityFixture();

    writeFileSync(
      fixture.installedProvenancePath,
      `${JSON.stringify({ ...fixture.provenance, sha256: '0'.repeat(64) }, null, 2)}\n`,
    );

    expect(() =>
      assertPackedFixtureMatchesCaveCheckout(fixture.lock, fixture.harnessRoot, fixture.caveRoot),
    ).toThrow('Packed Cave fixture provenance was invalid.');
  }, 30_000);

  test('rejects an unavailable Cave provenance commit', () => {
    const fixture = createCaveAuthorityFixture();

    writeFileSync(
      fixture.installedProvenancePath,
      `${JSON.stringify({ ...fixture.provenance, commit: '0'.repeat(40) }, null, 2)}\n`,
    );

    expect(() =>
      assertPackedFixtureMatchesCaveCheckout(fixture.lock, fixture.harnessRoot, fixture.caveRoot),
    ).toThrow(
      'Packed Cave fixture provenance is not an ancestor of the reviewed producer revision.',
    );
  }, 30_000);

  test('rejects a valid but non-ancestor Cave provenance commit', () => {
    const fixture = createCaveAuthorityFixture();

    writeFileSync(
      fixture.installedProvenancePath,
      `${JSON.stringify({ ...fixture.provenance, commit: fixture.nonAncestorCommit }, null, 2)}\n`,
    );

    expect(() =>
      assertPackedFixtureMatchesCaveCheckout(fixture.lock, fixture.harnessRoot, fixture.caveRoot),
    ).toThrow(
      'Packed Cave fixture provenance is not an ancestor of the reviewed producer revision.',
    );
  }, 90_000);
});

describe('generated SDK release manifest validation', () => {
  test('accepts platform-specific archive bytes when package identity and manifest integrity hold', () => {
    const lock = readContractCanaryLock();
    const scratchRoot = createRepoLocalScratchRoot('generated-manifest');
    const tarballs = {} as Record<'core' | 'cave' | 'coven' | 'sdk', string>;
    const packages = Object.entries(lock.sdk.artifacts).map(([key, artifact]) => {
      const tarball = resolve(scratchRoot, `${key}.tgz`);
      const bytes = Buffer.from(`platform-specific-${key}`);
      writeFileSync(tarball, bytes);
      tarballs[key as keyof typeof tarballs] = tarball;
      return {
        name: artifact.packageName,
        version: artifact.version,
        file: artifact.releaseFile,
        size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      };
    });
    const manifest = {
      schemaVersion: 1,
      version: lock.sdk.releaseManifest.version,
      packages,
    };

    expect(() => assertGeneratedReleaseManifestMatchesLock(lock, manifest, tarballs)).not.toThrow();

    const invalidManifest = {
      ...manifest,
      packages: manifest.packages.map((entry, index) => ({
        ...entry,
        name: index === 0 ? '@opencoven/not-reviewed' : entry.name,
      })),
    };
    expect(() =>
      assertGeneratedReleaseManifestMatchesLock(lock, invalidManifest, tarballs),
    ).toThrow(/contents did not match/);

    const extraTopLevel = { ...manifest, unreviewed: true };
    expect(() => assertGeneratedReleaseManifestMatchesLock(lock, extraTopLevel, tarballs)).toThrow(
      /contents did not match/,
    );

    const extraPackageField = {
      ...manifest,
      packages: manifest.packages.map((entry, index) =>
        index === 0 ? { ...entry, unreviewed: true } : entry,
      ),
    };
    expect(() =>
      assertGeneratedReleaseManifestMatchesLock(lock, extraPackageField, tarballs),
    ).toThrow(/contents did not match/);
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
