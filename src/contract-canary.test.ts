import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import * as contractCanary from '../scripts/contract-canary.mjs';

const projectRoot = resolve(import.meta.dirname, '..');
const scratchRoots: string[] = [];

function sha256(bytes: Buffer | string) {
  return createHash('sha256').update(bytes).digest('hex');
}

function createScratchRoot(prefix: string) {
  const parent = resolve(projectRoot, 'test-results', 'vitest', 'contract-canary');

  mkdirSync(parent, { recursive: true });
  const scratchRoot = mkdtempSync(resolve(parent, `${prefix}-`));
  scratchRoots.push(scratchRoot);
  return scratchRoot;
}

function readTrackedLockData() {
  return JSON.parse(readFileSync(resolve(projectRoot, 'contract-canary.lock.json'), 'utf8')) as {
    version: number;
    sdk: {
      repository: string;
      revision: string;
      releaseManifest: { file: string; version: string; sha256: string };
      packages: Array<{
        name: string;
        version: string;
        file: string;
        size: number;
        sha256: string;
      }>;
    };
    cave: Record<string, unknown>;
  };
}

function writeLock(scratchRoot: string, lockData: ReturnType<typeof readTrackedLockData>) {
  const lockPath = resolve(scratchRoot, 'contract-canary.lock.json');

  writeFileSync(lockPath, `${JSON.stringify(lockData, null, 2)}\n`);
  return contractCanary.readContractCanaryLock(lockPath);
}

function createReleaseArtifactFixture() {
  const scratchRoot = createScratchRoot('release-artifacts');
  const artifactRoot = resolve(scratchRoot, 'artifacts');
  const lockData = readTrackedLockData();

  for (const entry of lockData.sdk.packages) {
    const bytes = Buffer.from(`packed bytes for ${entry.name}\n`, 'utf8');
    const artifactPath = resolve(artifactRoot, entry.file);

    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, bytes);
    entry.size = bytes.byteLength;
    entry.sha256 = sha256(bytes);
  }

  const manifest = {
    schemaVersion: 1,
    version: lockData.sdk.releaseManifest.version,
    packages: lockData.sdk.packages,
  };
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestPath = resolve(artifactRoot, lockData.sdk.releaseManifest.file);

  writeFileSync(manifestPath, manifestBytes);
  lockData.sdk.releaseManifest.sha256 = sha256(manifestBytes);

  return {
    scratchRoot,
    artifactRoot,
    lock: writeLock(scratchRoot, lockData),
    lockData,
    manifest,
    manifestPath,
  };
}

function runGit(args: string[], cwd: string) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: 'pipe',
  }).trim();
}

function createCaveAuthorityFixture() {
  const scratchRoot = createScratchRoot('cave-authority');
  const caveRoot = resolve(scratchRoot, 'cave');
  const installedCaveRoot = resolve(scratchRoot, 'installed-cave-client');
  const authorityDirectory = resolve(caveRoot, 'src/lib/server/client-v1');
  const installedFixtureDirectory = resolve(installedCaveRoot, 'fixtures');
  const fixtureBytes = Buffer.from('historical Cave contract fixture\n', 'utf8');
  const fixtureDigestBytes = Buffer.from(`${sha256(fixtureBytes)}\n`, 'utf8');
  const vectorBytes = Buffer.from('current Cave HPKE vector\n', 'utf8');
  const vectorDigestBytes = Buffer.from(`${sha256(vectorBytes)}\n`, 'utf8');

  mkdirSync(authorityDirectory, { recursive: true });
  mkdirSync(installedFixtureDirectory, { recursive: true });
  runGit(['init', '--initial-branch=main'], caveRoot);
  runGit(['config', 'user.name', 'OpenCoven Test'], caveRoot);
  runGit(['config', 'user.email', 'opencoven-test@example.com'], caveRoot);
  runGit(['config', 'commit.gpgsign', 'false'], caveRoot);
  writeFileSync(resolve(authorityDirectory, 'contract-fixture.json'), fixtureBytes);
  writeFileSync(resolve(authorityDirectory, 'contract-fixture.sha256'), fixtureDigestBytes);
  runGit(['add', '.'], caveRoot);
  runGit(['commit', '-m', 'contract fixture authority'], caveRoot);
  const provenanceCommit = runGit(['rev-parse', 'HEAD'], caveRoot);

  writeFileSync(resolve(authorityDirectory, 'hpke-bound-v1-vectors.json'), vectorBytes);
  writeFileSync(resolve(authorityDirectory, 'hpke-bound-v1-vectors.sha256'), vectorDigestBytes);
  runGit(['add', '.'], caveRoot);
  runGit(['commit', '-m', 'HPKE vector authority'], caveRoot);
  const caveRevision = runGit(['rev-parse', 'HEAD'], caveRoot);

  const provenance = {
    repository: 'https://github.com/OpenCoven/coven-cave',
    commit: provenanceCommit,
    fixturePath: 'src/lib/server/client-v1/contract-fixture.json',
    digestPath: 'src/lib/server/client-v1/contract-fixture.sha256',
    sha256: sha256(fixtureBytes),
  };
  const provenanceBytes = Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`, 'utf8');

  writeFileSync(resolve(installedFixtureDirectory, 'contract-fixture.json'), fixtureBytes);
  writeFileSync(resolve(installedFixtureDirectory, 'contract-fixture.sha256'), fixtureDigestBytes);
  writeFileSync(
    resolve(installedFixtureDirectory, 'contract-fixture.provenance.json'),
    provenanceBytes,
  );
  writeFileSync(resolve(installedFixtureDirectory, 'hpke-bound-v1-vectors.json'), vectorBytes);
  writeFileSync(
    resolve(installedFixtureDirectory, 'hpke-bound-v1-vectors.sha256'),
    vectorDigestBytes,
  );

  const lockData = readTrackedLockData();
  const cave = lockData.cave as {
    revision: string;
    contractFixture: {
      sha256: string;
      digestFileSha256: string;
      provenanceFileSha256: string;
      provenance: typeof provenance;
    };
    hpkeVector: {
      sha256: string;
      digestFileSha256: string;
    };
  };
  cave.revision = caveRevision;
  cave.contractFixture.sha256 = sha256(fixtureBytes);
  cave.contractFixture.digestFileSha256 = sha256(fixtureDigestBytes);
  cave.contractFixture.provenanceFileSha256 = sha256(provenanceBytes);
  cave.contractFixture.provenance = provenance;
  cave.hpkeVector.sha256 = sha256(vectorBytes);
  cave.hpkeVector.digestFileSha256 = sha256(vectorDigestBytes);

  return {
    caveRoot,
    installedCaveRoot,
    lock: writeLock(scratchRoot, lockData),
  };
}

afterEach(() => {
  for (const scratchRoot of scratchRoots.splice(0)) {
    rmSync(scratchRoot, { force: true, recursive: true });
  }
});

describe('contract canary lock', () => {
  test('parses the exact packed SDK and Cave authority inputs', () => {
    const lock = contractCanary.readContractCanaryLock();
    const trackedBytes = readFileSync(resolve(projectRoot, 'contract-canary.lock.json'), 'utf8');

    expect(trackedBytes.endsWith('\n')).toBe(true);
    expect(lock.version).toBe(2);
    expect(lock.sdk).toMatchObject({
      repository: 'OpenCoven/sdk',
      revision: 'acc38488f00860d246c3c553375634d64806eabb',
      releaseManifest: {
        file: 'release-manifest.json',
        sha256: 'b8bfb62236fc8add4a9baad9f00e5401db15074a2d21fe2847a9158104cefb3c',
      },
    });
    expect(lock.sdk.packages.map(({ name }) => name)).toEqual([
      '@opencoven/sdk-core',
      '@opencoven/cave-client',
      '@opencoven/coven-client',
      '@opencoven/sdk',
    ]);
    expect(lock.cave).toMatchObject({
      repository: 'OpenCoven/coven-cave',
      revision: '2a0ff9237e94e652e477b22f60fd6d721b9e6451',
      contractFixture: {
        sha256: 'b2694cd1a70a2ddd81b54ee43ade1ff5aa1ecd661fa6e41e5b7acedd8db400bd',
        provenance: {
          commit: '4adc97b1bdafd1012ce4c66de598e82f49329f79',
        },
      },
      hpkeVector: {
        sha256: 'f806967291de12175277b6b24ac3c7bba912ae760fd8227fb21b1a4d5f5e6797',
      },
    });
  });

  test.each([
    {
      name: 'missing',
      mutate(packages: ReturnType<typeof readTrackedLockData>['sdk']['packages']) {
        packages.pop();
      },
    },
    {
      name: 'extra',
      mutate(packages: ReturnType<typeof readTrackedLockData>['sdk']['packages']) {
        const first = packages[0];
        if (first !== undefined) {
          packages.push({ ...first });
        }
      },
    },
    {
      name: 'reordered',
      mutate(packages: ReturnType<typeof readTrackedLockData>['sdk']['packages']) {
        packages.reverse();
      },
    },
  ])('rejects a $name locked package set', ({ mutate }) => {
    const scratchRoot = createScratchRoot('invalid-lock');
    const lockData = readTrackedLockData();

    mutate(lockData.sdk.packages);

    expect(() => writeLock(scratchRoot, lockData)).toThrow(/sdk\.packages/u);
  });
});

describe('SDK release artifact lock', () => {
  test('accepts the exact manifest and four packed package artifacts', () => {
    const fixture = createReleaseArtifactFixture();
    const verifySdkReleaseArtifacts = Reflect.get(contractCanary, 'verifySdkReleaseArtifacts') as (
      lock: typeof fixture.lock,
      artifactRoot: string,
    ) => unknown;

    expect(verifySdkReleaseArtifacts(fixture.lock, fixture.artifactRoot)).toEqual({
      core: resolve(fixture.artifactRoot, fixture.lock.sdk.packages[0]?.file ?? ''),
      cave: resolve(fixture.artifactRoot, fixture.lock.sdk.packages[1]?.file ?? ''),
      coven: resolve(fixture.artifactRoot, fixture.lock.sdk.packages[2]?.file ?? ''),
      sdk: resolve(fixture.artifactRoot, fixture.lock.sdk.packages[3]?.file ?? ''),
    });
  });

  test('creates a consumer manifest that resolves all public packages only from tarballs', () => {
    const createPackedConsumerPackageManifest = Reflect.get(
      contractCanary,
      'createPackedConsumerPackageManifest',
    ) as (tarballs: Record<string, string>) => {
      dependencies: Record<string, string>;
      pnpm: { overrides: Record<string, string> };
    };
    const tarballs = {
      core: '/artifacts/core.tgz',
      cave: '/artifacts/cave.tgz',
      coven: '/artifacts/coven.tgz',
      sdk: '/artifacts/sdk.tgz',
    };
    const manifest = createPackedConsumerPackageManifest(tarballs);
    const expectedPackages = [
      '@opencoven/sdk-core',
      '@opencoven/cave-client',
      '@opencoven/coven-client',
      '@opencoven/sdk',
    ];

    expect(Object.keys(manifest.dependencies)).toEqual(expectedPackages);
    expect(Object.keys(manifest.pnpm.overrides)).toEqual(expectedPackages);
    expect(manifest.dependencies).not.toHaveProperty('@opencoven/dev-cli');
    expect(manifest.pnpm.overrides).not.toHaveProperty('@opencoven/dev-cli');
    expect(Object.values(manifest.dependencies)).toEqual(
      Object.values(tarballs).map((tarball) => `file:${tarball}`),
    );
    expect(JSON.stringify(manifest)).not.toMatch(/workspace:|link:|https?:|registry/u);
  });

  describe('packed Cave authority artifacts', () => {
    test('accepts exact historical fixture provenance and current HPKE vector bytes', () => {
      const fixture = createCaveAuthorityFixture();
      const verifyPackedCaveAuthorityArtifacts = Reflect.get(
        contractCanary,
        'verifyPackedCaveAuthorityArtifacts',
      ) as (
        lock: typeof fixture.lock,
        options: { caveRoot: string; installedCaveRoot: string },
      ) => unknown;

      expect(
        verifyPackedCaveAuthorityArtifacts(fixture.lock, {
          caveRoot: fixture.caveRoot,
          installedCaveRoot: fixture.installedCaveRoot,
        }),
      ).toEqual({
        contractFixtureSha256: fixture.lock.cave.contractFixture.sha256,
        hpkeVectorSha256: fixture.lock.cave.hpkeVector.sha256,
      });
    }, 10_000);

    test('rejects packed contract fixture bytes that differ from Cave authority', () => {
      const fixture = createCaveAuthorityFixture();
      const verifyPackedCaveAuthorityArtifacts = Reflect.get(
        contractCanary,
        'verifyPackedCaveAuthorityArtifacts',
      ) as (
        lock: typeof fixture.lock,
        options: { caveRoot: string; installedCaveRoot: string },
      ) => unknown;

      writeFileSync(
        resolve(fixture.installedCaveRoot, 'fixtures/contract-fixture.json'),
        'mutated fixture\n',
      );

      expect(() =>
        verifyPackedCaveAuthorityArtifacts(fixture.lock, {
          caveRoot: fixture.caveRoot,
          installedCaveRoot: fixture.installedCaveRoot,
        }),
      ).toThrow(/packed Cave contract fixture bytes/u);
    }, 10_000);

    test('rejects packed HPKE vector bytes that differ from Cave authority', () => {
      const fixture = createCaveAuthorityFixture();
      const verifyPackedCaveAuthorityArtifacts = Reflect.get(
        contractCanary,
        'verifyPackedCaveAuthorityArtifacts',
      ) as (
        lock: typeof fixture.lock,
        options: { caveRoot: string; installedCaveRoot: string },
      ) => unknown;

      writeFileSync(
        resolve(fixture.installedCaveRoot, 'fixtures/hpke-bound-v1-vectors.json'),
        'mutated vector\n',
      );

      expect(() =>
        verifyPackedCaveAuthorityArtifacts(fixture.lock, {
          caveRoot: fixture.caveRoot,
          installedCaveRoot: fixture.installedCaveRoot,
        }),
      ).toThrow(/packed Cave HPKE vector bytes/u);
    }, 10_000);

    test('rejects packed Cave provenance bytes that differ from the lock', () => {
      const fixture = createCaveAuthorityFixture();
      const verifyPackedCaveAuthorityArtifacts = Reflect.get(
        contractCanary,
        'verifyPackedCaveAuthorityArtifacts',
      ) as (
        lock: typeof fixture.lock,
        options: { caveRoot: string; installedCaveRoot: string },
      ) => unknown;

      writeFileSync(
        resolve(fixture.installedCaveRoot, 'fixtures/contract-fixture.provenance.json'),
        '{}\n',
      );

      expect(() =>
        verifyPackedCaveAuthorityArtifacts(fixture.lock, {
          caveRoot: fixture.caveRoot,
          installedCaveRoot: fixture.installedCaveRoot,
        }),
      ).toThrow(/provenance digest/u);
    }, 10_000);

    test('rejects an unavailable locked Cave provenance commit', () => {
      const fixture = createCaveAuthorityFixture();
      const verifyPackedCaveAuthorityArtifacts = Reflect.get(
        contractCanary,
        'verifyPackedCaveAuthorityArtifacts',
      ) as (
        lock: typeof fixture.lock,
        options: { caveRoot: string; installedCaveRoot: string },
      ) => unknown;

      fixture.lock.cave.contractFixture.provenance.commit =
        '0000000000000000000000000000000000000000';

      expect(() =>
        verifyPackedCaveAuthorityArtifacts(fixture.lock, {
          caveRoot: fixture.caveRoot,
          installedCaveRoot: fixture.installedCaveRoot,
        }),
      ).toThrow(/commit .* is unavailable/u);
    }, 10_000);
  });

  test('rejects a release manifest digest mismatch', () => {
    const fixture = createReleaseArtifactFixture();
    const verifySdkReleaseArtifacts = Reflect.get(contractCanary, 'verifySdkReleaseArtifacts') as (
      lock: typeof fixture.lock,
      artifactRoot: string,
    ) => unknown;

    writeFileSync(fixture.manifestPath, `${JSON.stringify(fixture.manifest)}\n`);

    expect(() => verifySdkReleaseArtifacts(fixture.lock, fixture.artifactRoot)).toThrow(
      /release-manifest\.json digest/u,
    );
  });

  test('rejects a packed package digest mismatch', () => {
    const fixture = createReleaseArtifactFixture();
    const verifySdkReleaseArtifacts = Reflect.get(contractCanary, 'verifySdkReleaseArtifacts') as (
      lock: typeof fixture.lock,
      artifactRoot: string,
    ) => unknown;
    const cavePackage = fixture.lock.sdk.packages[1];

    if (cavePackage === undefined) {
      throw new Error('Expected the Cave package lock entry.');
    }

    writeFileSync(resolve(fixture.artifactRoot, cavePackage.file), 'mutated package\n');

    expect(() => verifySdkReleaseArtifacts(fixture.lock, fixture.artifactRoot)).toThrow(
      /@opencoven\/cave-client (size|digest)/u,
    );
  });

  test.each([
    {
      name: 'missing',
      mutate(packages: ReturnType<typeof createReleaseArtifactFixture>['manifest']['packages']) {
        packages.pop();
      },
    },
    {
      name: 'extra',
      mutate(packages: ReturnType<typeof createReleaseArtifactFixture>['manifest']['packages']) {
        const first = packages[0];
        if (first !== undefined) {
          packages.push({ ...first });
        }
      },
    },
    {
      name: 'reordered',
      mutate(packages: ReturnType<typeof createReleaseArtifactFixture>['manifest']['packages']) {
        packages.reverse();
      },
    },
  ])('rejects a $name generated release package set', ({ mutate }) => {
    const fixture = createReleaseArtifactFixture();
    const verifySdkReleaseArtifacts = Reflect.get(contractCanary, 'verifySdkReleaseArtifacts') as (
      lock: typeof fixture.lock,
      artifactRoot: string,
    ) => unknown;
    const manifest = structuredClone(fixture.manifest);

    mutate(manifest.packages);
    const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(fixture.manifestPath, manifestBytes);
    fixture.lockData.sdk.releaseManifest.sha256 = sha256(manifestBytes);
    const lock = writeLock(fixture.scratchRoot, fixture.lockData);

    expect(() => verifySdkReleaseArtifacts(lock, fixture.artifactRoot)).toThrow(
      /exactly 4 packages|metadata/u,
    );
  });
});
