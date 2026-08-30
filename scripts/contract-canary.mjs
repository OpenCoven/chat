import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, inflateRawSync } from 'node:zlib';

import { cleanupOwnedTempRoot, createOwnedTempDirectory } from './owned-temp-directory.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultSdkRoot = resolve(root, '.cross-repo', 'sdk');
const defaultCaveRoot = resolve(root, '.cross-repo', 'coven-cave');
const defaultLockPath = resolve(root, 'contract-canary.lock.json');
const reviewedRevisionPattern = /^[0-9a-f]{40}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/i;
const packageVersionPattern = /^\d+\.\d+\.\d+$/;
const SDK_ARTIFACTS = Object.freeze({
  core: {
    packageName: '@opencoven/sdk-core',
    fileName: 'sdk-core-0.1.0.tgz',
    releaseFile: 'tarballs/core/opencoven-sdk-core-0.1.0.tgz',
  },
  cave: {
    packageName: '@opencoven/cave-client',
    fileName: 'cave-client-0.1.0.tgz',
    releaseFile: 'tarballs/cave/opencoven-cave-client-0.1.0.tgz',
  },
  coven: {
    packageName: '@opencoven/coven-client',
    fileName: 'coven-client-0.1.0.tgz',
    releaseFile: 'tarballs/coven/opencoven-coven-client-0.1.0.tgz',
  },
  sdk: {
    packageName: '@opencoven/sdk',
    fileName: 'sdk-0.1.0.tgz',
    releaseFile: 'tarballs/sdk/opencoven-sdk-0.1.0.tgz',
  },
});
const CAVE_PRODUCER_ARTIFACTS = Object.freeze({
  contractFixture: {
    path: 'src/lib/server/client-v1/contract-fixture.json',
    digestPath: 'src/lib/server/client-v1/contract-fixture.sha256',
  },
  hpkeVectors: {
    path: 'src/lib/server/client-v1/hpke-bound-v1-vectors.json',
    digestPath: 'src/lib/server/client-v1/hpke-bound-v1-vectors.sha256',
  },
});

function printUsage() {
  process.stdout.write(
    [
      'usage: contract-canary.mjs [--sdk-root <path>] [--cave-root <path>]',
      '',
      'Packs the reviewed SDK packages, installs their tarballs into an isolated',
      'Chat canary harness, compiles Chat-owned code against the public',
      '@opencoven/cave-client entry point, validates reviewed Cave fixture',
      'ancestry and HPKE vector bytes, and proves a stale-digest mutation is rejected.',
      '',
    ].join('\n'),
  );
}

function validateLockEntry(lockData, key, expectedRepository) {
  const entry = lockData[key];

  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`contract-canary.lock.json ${key} entry must be an object.`);
  }

  if (entry.repository !== expectedRepository) {
    throw new Error(`contract-canary.lock.json ${key}.repository must be ${expectedRepository}.`);
  }

  if (!reviewedRevisionPattern.test(entry.revision ?? '')) {
    throw new Error(
      `contract-canary.lock.json ${key}.revision must be an immutable 40-character commit SHA.`,
    );
  }
  const expectedKeys =
    key === 'sdk'
      ? ['repository', 'revision', 'releaseManifest', 'artifacts']
      : ['repository', 'revision', 'artifacts'];
  if (
    Object.keys(entry).length !== expectedKeys.length ||
    expectedKeys.some((expectedKey) => !Object.hasOwn(entry, expectedKey))
  ) {
    throw new Error(`contract-canary.lock.json ${key} entry contained unexpected fields.`);
  }

  return {
    repository: entry.repository,
    revision: entry.revision,
    ...(key === 'sdk'
      ? {
          releaseManifest: validateReleaseManifest(entry.releaseManifest),
          artifacts: validateSdkArtifacts(entry.artifacts),
        }
      : { artifacts: validateCaveProducerArtifacts(entry.artifacts) }),
  };
}

function validateReleaseManifest(manifest) {
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    Object.keys(manifest).length !== 3 ||
    manifest.file !== 'release-manifest.json' ||
    typeof manifest.version !== 'string' ||
    !packageVersionPattern.test(manifest.version) ||
    typeof manifest.sha256 !== 'string' ||
    !sha256Pattern.test(manifest.sha256)
  ) {
    throw new Error('contract-canary.lock.json sdk.releaseManifest is invalid.');
  }
  return manifest;
}

function validateSdkArtifacts(artifacts) {
  if (artifacts === null || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    throw new Error('contract-canary.lock.json sdk.artifacts must be an object.');
  }
  const expectedKeys = Object.keys(SDK_ARTIFACTS);
  const artifactKeys = Object.keys(artifacts);
  if (
    artifactKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(artifacts, key))
  ) {
    throw new Error(
      'contract-canary.lock.json sdk.artifacts must contain exactly core, cave, coven, and sdk.',
    );
  }
  for (const [key, expected] of Object.entries(SDK_ARTIFACTS)) {
    const artifact = artifacts[key];
    if (
      artifact === null ||
      typeof artifact !== 'object' ||
      Array.isArray(artifact) ||
      Object.keys(artifact).length !== 6 ||
      !Object.hasOwn(artifact, 'packageName') ||
      !Object.hasOwn(artifact, 'version') ||
      !Object.hasOwn(artifact, 'releaseFile') ||
      !Object.hasOwn(artifact, 'vendorFile') ||
      !Object.hasOwn(artifact, 'size') ||
      !Object.hasOwn(artifact, 'sha256') ||
      artifact.packageName !== expected.packageName ||
      artifact.version !== '0.1.0' ||
      artifact.releaseFile !== expected.releaseFile ||
      artifact.vendorFile !== expected.fileName ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size <= 0 ||
      typeof artifact.sha256 !== 'string' ||
      !sha256Pattern.test(artifact.sha256)
    ) {
      throw new Error(`contract-canary.lock.json sdk.artifacts.${key} is invalid.`);
    }
  }
  return artifacts;
}

function validateCaveProducerArtifacts(artifacts) {
  if (artifacts === null || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    throw new Error('contract-canary.lock.json cave.artifacts must be an object.');
  }
  const expectedKeys = Object.keys(CAVE_PRODUCER_ARTIFACTS);
  if (
    Object.keys(artifacts).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(artifacts, key))
  ) {
    throw new Error(
      'contract-canary.lock.json cave.artifacts must contain exactly contractFixture and hpkeVectors.',
    );
  }
  for (const [key, expected] of Object.entries(CAVE_PRODUCER_ARTIFACTS)) {
    const artifact = artifacts[key];
    if (
      artifact === null ||
      typeof artifact !== 'object' ||
      Array.isArray(artifact) ||
      Object.keys(artifact).length !== 3 ||
      artifact.path !== expected.path ||
      artifact.digestPath !== expected.digestPath ||
      typeof artifact.sha256 !== 'string' ||
      !sha256Pattern.test(artifact.sha256)
    ) {
      throw new Error(`contract-canary.lock.json cave.artifacts.${key} is invalid.`);
    }
  }
  return artifacts;
}

export function readContractCanaryLock(lockPath = defaultLockPath) {
  requirePath(lockPath, 'Contract canary lock');

  const lockData = JSON.parse(readFileSync(lockPath, 'utf8'));

  if (lockData.version !== 4) {
    throw new Error('contract-canary.lock.json version must be 4.');
  }

  return {
    path: lockPath,
    sdk: validateLockEntry(lockData, 'sdk', 'OpenCoven/sdk'),
    cave: validateLockEntry(lockData, 'cave', 'OpenCoven/coven-cave'),
  };
}

function readGitHead(repositoryRoot, label) {
  requirePath(repositoryRoot, label);

  return run('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], root, {
    stdio: 'pipe',
    encoding: 'utf8',
  }).trim();
}

function readGitStatusPorcelain(repositoryRoot, label) {
  requirePath(repositoryRoot, label);

  return run(
    'git',
    ['-C', repositoryRoot, 'status', '--porcelain=v1', '--untracked-files=all'],
    root,
    {
      stdio: 'pipe',
      encoding: 'utf8',
    },
  );
}

function summarizeGitStatus(statusOutput) {
  const summary = {
    staged: 0,
    unstaged: 0,
    untracked: 0,
  };

  for (const line of statusOutput.split('\n')) {
    if (line.length === 0) {
      continue;
    }

    const [indexStatus = ' ', worktreeStatus = ' '] = line;

    if (indexStatus === '?' && worktreeStatus === '?') {
      summary.untracked += 1;
      continue;
    }

    if (indexStatus !== ' ') {
      summary.staged += 1;
    }

    if (worktreeStatus !== ' ') {
      summary.unstaged += 1;
    }
  }

  return summary;
}

function formatDirtySummary(summary) {
  const parts = [];

  if (summary.staged > 0) {
    parts.push(`${summary.staged} staged change${summary.staged === 1 ? '' : 's'}`);
  }

  if (summary.unstaged > 0) {
    parts.push(`${summary.unstaged} unstaged change${summary.unstaged === 1 ? '' : 's'}`);
  }

  if (summary.untracked > 0) {
    parts.push(`${summary.untracked} untracked item${summary.untracked === 1 ? '' : 's'}`);
  }

  return parts.join(', ');
}

export function assertCleanGitCheckout(repositoryRoot, label) {
  const summary = summarizeGitStatus(readGitStatusPorcelain(repositoryRoot, label));

  if (summary.staged === 0 && summary.unstaged === 0 && summary.untracked === 0) {
    return summary;
  }

  throw new Error(
    `${label} at ${repositoryRoot} is dirty (${formatDirtySummary(summary)}). ` +
      'Contract canary requires a clean checkout with no staged, unstaged, or untracked files.',
  );
}

export function assertCleanContractCanaryCheckouts({ sdkRoot, caveRoot }) {
  return {
    sdk: assertCleanGitCheckout(sdkRoot, 'SDK checkout'),
    cave: assertCleanGitCheckout(caveRoot, 'Cave checkout'),
  };
}

export function assertContractCanaryCheckoutHeads(lock, { sdkRoot, caveRoot }) {
  const sdkHead = readGitHead(sdkRoot, 'SDK root');
  const caveHead = readGitHead(caveRoot, 'Cave root');

  if (sdkHead !== lock.sdk.revision) {
    throw new Error(
      `SDK checkout HEAD ${sdkHead} does not match locked reviewed revision ${lock.sdk.revision}.`,
    );
  }

  if (caveHead !== lock.cave.revision) {
    throw new Error(
      `Cave checkout HEAD ${caveHead} does not match locked reviewed revision ${lock.cave.revision}.`,
    );
  }

  return {
    sdkHead,
    caveHead,
  };
}

export function parseArgs(argv) {
  const options = {
    sdkRoot: resolve(process.env.OPENCOVEN_SDK_ROOT ?? defaultSdkRoot),
    caveRoot: resolve(process.env.OPENCOVEN_CAVE_ROOT ?? defaultCaveRoot),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--help') {
      printUsage();
      process.exit(0);
    }

    if (argument === '--') {
      continue;
    }

    if (argument === '--sdk-root' || argument === '--cave-root') {
      const value = argv[index + 1];

      if (value === undefined) {
        throw new Error(`Missing value for ${argument}.`);
      }

      if (argument === '--sdk-root') {
        options.sdkRoot = resolve(value);
      } else {
        options.caveRoot = resolve(value);
      }

      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${argument}`);
  }

  return options;
}

function requirePath(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} does not exist at ${path}.`);
  }
}

function run(command, args, cwd, options = {}) {
  return execFileSync(command, args, {
    cwd,
    stdio: options.stdio ?? 'inherit',
    encoding: options.encoding,
  });
}

function runPnpm(args, cwd, options = {}) {
  return run('corepack', ['pnpm@10.34.0', ...args], cwd, options);
}

function isolatedInstallArgs({ offline }) {
  return [
    '--ignore-workspace',
    '--config.inject-workspace-packages=false',
    '--config.link-workspace-packages=false',
    '--config.prefer-workspace-packages=false',
    'install',
    // The warm pass may reach the registry for metadata the store lacks; the
    // asserting pass may not reach it at all.
    offline ? '--offline' : '--prefer-offline',
    '--ignore-scripts',
  ];
}

/**
 * Install the harness twice: once warm, once offline.
 *
 * The offline install is the assertion. It proves every dependency the packed
 * tarballs pull in is genuinely present in the store, so nothing is being
 * resolved from the network behind the canary's back.
 *
 * But an offline install can only assert that once the store actually holds
 * those dependencies, and a fresh CI runner's store does not. That is what
 * failed here: a transitive @types/node had no metadata in the runner's
 * mirror, so the offline install failed on an absence that says nothing about
 * the tarballs.
 *
 * Warming first separates the two questions. The warm pass is allowed to fetch
 * what it is missing; the offline pass then has to succeed with no network at
 * all, which is the property worth checking. Dropping --offline entirely would
 * have made the failure go away and taken the guarantee with it.
 */
function installHarnessOfflineAfterWarming(harnessRoot) {
  runPnpm(isolatedInstallArgs({ offline: false }), harnessRoot);
  rmSync(resolve(harnessRoot, 'node_modules'), { force: true, recursive: true });
  runPnpm(isolatedInstallArgs({ offline: true }), harnessRoot);
}

function createPublicPackageOverrides(tarballs) {
  return {
    '@opencoven/sdk-core': `file:${tarballs.core}`,
    '@opencoven/cave-client': `file:${tarballs.cave}`,
    '@opencoven/coven-client': `file:${tarballs.coven}`,
    '@opencoven/sdk': `file:${tarballs.sdk}`,
  };
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertFrozenArtifactDigests(lock, tarballs) {
  for (const [key, artifact] of Object.entries(SDK_ARTIFACTS)) {
    const locked = lock.sdk.artifacts[key];
    const tarball = tarballs[key];
    const stats = typeof tarball === 'string' ? lstatSync(tarball) : undefined;
    if (
      locked?.packageName !== artifact.packageName ||
      locked.version !== lock.sdk.releaseManifest.version ||
      locked.releaseFile !== artifact.releaseFile ||
      locked.vendorFile !== artifact.fileName ||
      !Number.isSafeInteger(locked.size) ||
      typeof locked.sha256 !== 'string' ||
      !sha256Pattern.test(locked.sha256) ||
      typeof tarball !== 'string' ||
      !stats?.isFile() ||
      stats.size !== locked.size ||
      sha256(tarball) !== locked.sha256
    ) {
      throw new Error(
        `Packed SDK ${artifact.packageName} does not match its locked artifact digest.`,
      );
    }
  }
}

function frozenTarballs(lock, chatRoot = root) {
  const tarballs = {};
  for (const [key, artifact] of Object.entries(SDK_ARTIFACTS)) {
    const path = resolve(chatRoot, 'vendor', 'opencoven-sdk', lock.sdk.artifacts[key].vendorFile);
    requirePath(path, `Frozen ${artifact.packageName} artifact`);
    tarballs[key] = path;
  }
  assertFrozenArtifactDigests(lock, tarballs);
  return tarballs;
}

export function verifyFrozenPackedConsumer({ chatRoot = root, sdkRoot, caveRoot }) {
  requirePath(chatRoot, 'Chat root');
  requirePath(sdkRoot, 'SDK root');
  requirePath(caveRoot, 'Cave root');
  const lock = readContractCanaryLock(resolve(chatRoot, 'contract-canary.lock.json'));
  assertCleanContractCanaryCheckouts({ sdkRoot, caveRoot });
  assertContractCanaryCheckoutHeads(lock, { sdkRoot, caveRoot });

  let artifactContext;
  try {
    artifactContext = createOwnedTempDirectory({
      prefix: 'opencoven-chat-frozen-consumer',
    });
    const harnessRoot = resolve(artifactContext.rootPath, 'chat-harness');
    const frozen = frozenTarballs(lock, chatRoot);
    createHarness(harnessRoot, frozen);
    installHarnessOfflineAfterWarming(harnessRoot);
    assertIsolatedPackedInstall(harnessRoot);
    assertPackedFixtureMatchesCaveCheckout(lock, harnessRoot, caveRoot);
    runPnpm(['--ignore-workspace', 'run', 'build'], harnessRoot);
    runPnpm(['--ignore-workspace', 'run', 'verify'], harnessRoot);
    return Object.freeze({
      releaseManifest: lock.sdk.releaseManifest,
      sdkArtifacts: lock.sdk.artifacts,
      caveArtifacts: lock.cave.artifacts,
      observedAssertions: Object.freeze({
        sdk: Object.freeze([
          'sdk.install.packed-tarballs',
          'sdk.install.public-exports',
          'sdk.install.no-source-checkout',
          'sdk.install.no-workspace-link',
          'sdk.provenance.fixture-bytes-match',
          'sdk.provenance.hpke-vectors-match',
        ]),
        chat: Object.freeze([
          'chat.install.exact-sdk-tarballs',
          'chat.install.consumer-lock-matches',
          'chat.install.no-source-checkout',
          'chat.install.no-workspace-link',
        ]),
      }),
    });
  } finally {
    if (artifactContext !== undefined) {
      cleanupOwnedTempRoot(artifactContext);
    }
  }
}

function safeTarEntries(tarball) {
  const output = run('tar', ['-tzf', tarball], root, {
    stdio: 'pipe',
    encoding: 'utf8',
  });
  const entries = output
    .split(/\r?\n/u)
    .filter((entry) => entry.length > 0)
    .sort();
  if (
    entries.length === 0 ||
    new Set(entries).size !== entries.length ||
    entries.some((entry) => {
      const segments = entry.split('/');
      return (
        !entry.startsWith('package/') ||
        entry.includes('\\') ||
        segments.some((segment) => segment === '.' || segment === '..')
      );
    })
  ) {
    throw new Error('Packed SDK archive contained an unsafe or duplicate path.');
  }
  return entries;
}

function packageTree(rootPath, currentPath = rootPath) {
  const entries = [];
  for (const entry of readdirSync(currentPath, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const path = resolve(currentPath, entry.name);
    const relativePath = relative(rootPath, path).split(sep).join('/');
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) {
      throw new Error('Packed SDK archive contained an unsupported filesystem entry.');
    }
    if (stats.isDirectory()) {
      entries.push(`directory:${relativePath}`);
      entries.push(...packageTree(rootPath, path));
      continue;
    }
    entries.push(
      `file:${relativePath}:${stats.mode & 0o111}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`,
    );
  }
  return entries;
}

function gzipHeaderLength(bytes) {
  if (
    bytes.length < 18 ||
    bytes[0] !== 0x1f ||
    bytes[1] !== 0x8b ||
    bytes[2] !== 8 ||
    (bytes[3] & 0xe0) !== 0
  ) {
    throw new Error('invalid gzip header');
  }
  const flags = bytes[3];
  let offset = 10;
  if ((flags & 0x04) !== 0) {
    if (offset + 2 > bytes.length) {
      throw new Error('truncated gzip extra length');
    }
    const extraLength = bytes.readUInt16LE(offset);
    offset += 2 + extraLength;
  }
  for (const flag of [0x08, 0x10]) {
    if ((flags & flag) === 0) {
      continue;
    }
    const terminator = bytes.indexOf(0, offset);
    if (terminator === -1) {
      throw new Error('unterminated gzip header field');
    }
    offset = terminator + 1;
  }
  if ((flags & 0x02) !== 0) {
    offset += 2;
  }
  if (offset + 8 > bytes.length) {
    throw new Error('truncated gzip member');
  }
  return offset;
}

function gunzipSingleMember(tarball) {
  const bytes = readFileSync(tarball);
  const headerLength = gzipHeaderLength(bytes);
  const inflated = inflateRawSync(bytes.subarray(headerLength), { info: true });
  if (headerLength + inflated.engine.bytesWritten + 8 !== bytes.length) {
    throw new Error('gzip archive contained trailing data or additional members');
  }
  return gunzipSync(bytes);
}

export function assertPackedPackageContentsMatch(
  reviewedTarballs,
  frozenTarballsByPackage,
  comparisonRoot,
) {
  mkdirSync(comparisonRoot, { recursive: true });
  for (const [key, artifact] of Object.entries(SDK_ARTIFACTS)) {
    const reviewed = reviewedTarballs[key];
    const frozen = frozenTarballsByPackage[key];
    if (typeof reviewed !== 'string' || typeof frozen !== 'string') {
      throw new Error(`Packed SDK ${artifact.packageName} artifact was missing.`);
    }
    let reviewedTar;
    let frozenTar;
    try {
      reviewedTar = gunzipSingleMember(reviewed);
      frozenTar = gunzipSingleMember(frozen);
    } catch {
      throw new Error(`Packed SDK ${artifact.packageName} was not a complete gzip archive.`);
    }
    if (!reviewedTar.equals(frozenTar)) {
      throw new Error(`Packed SDK ${artifact.packageName} tar payload did not match.`);
    }
    const reviewedEntries = safeTarEntries(reviewed);
    const frozenEntries = safeTarEntries(frozen);
    if (JSON.stringify(reviewedEntries) !== JSON.stringify(frozenEntries)) {
      throw new Error(`Packed SDK ${artifact.packageName} file list did not match.`);
    }
    const packageRoot = resolve(comparisonRoot, key);
    const reviewedRoot = resolve(packageRoot, 'reviewed');
    const frozenRoot = resolve(packageRoot, 'frozen');
    mkdirSync(reviewedRoot, { recursive: true });
    mkdirSync(frozenRoot, { recursive: true });
    run('tar', ['-xzf', reviewed, '-C', reviewedRoot], root);
    run('tar', ['-xzf', frozen, '-C', frozenRoot], root);
    if (JSON.stringify(packageTree(reviewedRoot)) !== JSON.stringify(packageTree(frozenRoot))) {
      throw new Error(`Packed SDK ${artifact.packageName} contents did not match.`);
    }
  }
}

function reviewedReleaseManifest(lock) {
  return {
    schemaVersion: 1,
    version: lock.sdk.releaseManifest.version,
    packages: Object.values(lock.sdk.artifacts).map(
      ({ packageName: name, version, releaseFile: file, size, sha256: digest }) => ({
        name,
        version,
        file,
        size,
        sha256: digest,
      }),
    ),
  };
}

export function assertGeneratedReleaseManifestMatchesLock(lock, manifest, tarballs) {
  const reviewedManifest = reviewedReleaseManifest(lock);
  const reviewedBytes = `${JSON.stringify(reviewedManifest, null, 2)}\n`;
  const reviewedDigest = createHash('sha256').update(reviewedBytes).digest('hex');
  if (reviewedDigest !== lock.sdk.releaseManifest.sha256) {
    throw new Error('Reviewed SDK release manifest lock was internally inconsistent.');
  }

  const expectedPackages = reviewedManifest.packages.map(({ name, version, file }) => ({
    name,
    version,
    file,
  }));
  const generatedPackages = Array.isArray(manifest?.packages)
    ? manifest.packages.map(({ name, version, file }) => ({ name, version, file }))
    : undefined;
  const exactTopLevelKeys =
    manifest !== null &&
    typeof manifest === 'object' &&
    !Array.isArray(manifest) &&
    JSON.stringify(Object.keys(manifest).sort()) ===
      JSON.stringify(['packages', 'schemaVersion', 'version']);
  const exactPackageKeys =
    Array.isArray(manifest?.packages) &&
    manifest.packages.every(
      (entry) =>
        entry !== null &&
        typeof entry === 'object' &&
        !Array.isArray(entry) &&
        JSON.stringify(Object.keys(entry).sort()) ===
          JSON.stringify(['file', 'name', 'sha256', 'size', 'version']),
    );
  if (
    !exactTopLevelKeys ||
    !exactPackageKeys ||
    manifest?.schemaVersion !== 1 ||
    manifest?.version !== lock.sdk.releaseManifest.version ||
    JSON.stringify(generatedPackages) !== JSON.stringify(expectedPackages)
  ) {
    throw new Error('Generated SDK release manifest contents did not match the reviewed lock.');
  }

  for (const [index, [key, artifact]] of Object.entries(SDK_ARTIFACTS).entries()) {
    const generated = manifest.packages[index];
    const tarball = tarballs[key];
    const stats = typeof tarball === 'string' ? lstatSync(tarball) : undefined;
    if (
      generated?.name !== artifact.packageName ||
      !Number.isSafeInteger(generated.size) ||
      generated.size <= 0 ||
      typeof generated.sha256 !== 'string' ||
      !sha256Pattern.test(generated.sha256) ||
      !stats?.isFile() ||
      stats.size !== generated.size ||
      sha256(tarball) !== generated.sha256
    ) {
      throw new Error(`Generated SDK ${artifact.packageName} manifest entry was inconsistent.`);
    }
  }
}

function createReviewedSdkReleaseArtifacts(lock, sdkRoot, artifactRoot) {
  const createReleaseArtifacts = resolve(sdkRoot, 'scripts', 'create-release-artifacts.mjs');
  requirePath(createReleaseArtifacts, 'SDK create-release-artifacts script');
  run(process.execPath, [createReleaseArtifacts, '--output', artifactRoot], sdkRoot);

  const manifestPath = resolve(artifactRoot, lock.sdk.releaseManifest.file);
  requirePath(manifestPath, 'SDK release manifest');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const tarballs = Object.fromEntries(
    Object.entries(lock.sdk.artifacts).map(([key, artifact]) => [
      key,
      resolve(artifactRoot, artifact.releaseFile),
    ]),
  );
  assertGeneratedReleaseManifestMatchesLock(lock, manifest, tarballs);
  return tarballs;
}

export function createContractCanaryVerifier() {
  return `import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemorySecretStore } from '@opencoven/sdk-core/browser';
import { parseVerifiedCaveContractFixture } from '@opencoven/cave-client';
import { createManagedCaveClient } from '@opencoven/cave-client/managed';
import { createCovenClient } from '@opencoven/coven-client';
import { createOpenCovenSdk } from '@opencoven/sdk';

const inertAdapter = async () => {
  throw new Error('Contract canary verifier must not perform I/O.');
};

const memoryStore = createMemorySecretStore();
await memoryStore.set('contract-canary', 'inert');

if ((await memoryStore.get('contract-canary')) !== 'inert') {
  throw new Error('SDK core browser memory store did not preserve its inert value.');
}

await memoryStore.delete('contract-canary');

const managedCaveClient = createManagedCaveClient({
  transport: {
    health: inertAdapter,
    managedPairingCreate: inertAdapter,
    managedPairingPoll: inertAdapter,
    managedPairingExchange: inertAdapter,
    managedCredentialStatus: inertAdapter,
    managedForgetCredential: inertAdapter,
  },
});
const covenClient = createCovenClient({
  transport: {
    health: inertAdapter,
  },
});
const sdk = createOpenCovenSdk({
  cave: managedCaveClient,
  coven: covenClient,
});
const availability = sdk.availability();

if (!availability.cave || !availability.coven) {
  throw new Error('OpenCoven SDK did not retain inert Cave and Coven clients.');
}

const fixtureDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  'node_modules',
  '@opencoven',
  'cave-client',
  'fixtures',
);
const fixture = readFileSync(resolve(fixtureDirectory, 'contract-fixture.json'), 'utf8');
const digest = readFileSync(resolve(fixtureDirectory, 'contract-fixture.sha256'), 'utf8');
const parsed = parseVerifiedCaveContractFixture(fixture, digest);

if (parsed.contract.apiVersion !== '1.0') {
  throw new Error(\`Unexpected apiVersion: \${parsed.contract.apiVersion}\`);
}

if (parsed.examples.status.status !== 'ok') {
  throw new Error(\`Unexpected status example: \${parsed.examples.status.status}\`);
}

const staleFixture = JSON.parse(fixture);
delete staleFixture.contract.minimumClientVersion;

let rejected = false;

try {
  parseVerifiedCaveContractFixture(\`\${JSON.stringify(staleFixture, null, 2)}\\n\`, digest);
} catch (error) {
  rejected = error instanceof Error && error.message.includes('digest mismatch');
}

if (!rejected) {
  throw new Error(
    'Chat contract canary accepted a required-field mutation without a digest update.',
  );
}

process.stdout.write('Chat contract canary passed.\\n');
`;
}

function createHarness(harnessRoot, tarballs) {
  mkdirSync(resolve(harnessRoot, 'src'), { recursive: true });

  writeFileSync(
    resolve(harnessRoot, 'package.json'),
    `${JSON.stringify(
      {
        name: 'opencoven-chat-contract-canary',
        private: true,
        type: 'module',
        scripts: {
          build: 'tsc --pretty false --noEmit',
          verify: 'node verify.mjs',
        },
        dependencies: Object.fromEntries(
          Object.entries(SDK_ARTIFACTS).map(([key, artifact]) => [
            artifact.packageName,
            `file:${tarballs[key]}`,
          ]),
        ),
        devDependencies: {
          '@types/node': '24.13.3',
          typescript: '6.0.3',
        },
        pnpm: {
          overrides: createPublicPackageOverrides(tarballs),
        },
      },
      null,
      2,
    )}\n`,
  );

  writeFileSync(
    resolve(harnessRoot, 'tsconfig.json'),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2024',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ['src/**/*.ts'],
      },
      null,
      2,
    )}\n`,
  );

  writeFileSync(
    resolve(harnessRoot, 'src', 'index.ts'),
    `import {
  parseVerifiedCaveContractFixture,
  type CaveContractFixture,
  type CaveContractReport,
  type CaveFamiliar,
  type CaveFamiliarAnalytics,
} from '@opencoven/cave-client';
import { createManagedCaveClient } from '@opencoven/cave-client/managed';
import type { OperationContext } from '@opencoven/sdk-core/browser';
import { createCovenClient } from '@opencoven/coven-client';
import { createOpenCovenSdk } from '@opencoven/sdk';

void createManagedCaveClient;
void (undefined as unknown as OperationContext);
void createCovenClient;
void createOpenCovenSdk;

export function loadAuthorityFixture(
  fixtureContents: string,
  digestContents: string,
): CaveContractFixture {
  return parseVerifiedCaveContractFixture(fixtureContents, digestContents);
}

/**
 * The familiar surface this repository reads.
 *
 * Chat holds no dependency on @opencoven/cave-client, so nothing else would
 * notice if these types were renamed, narrowed, or dropped -- the app would
 * simply carry its own copy of a shape the SDK no longer serves, and the
 * mismatch would surface at integration rather than here.
 *
 * Compiling against the packed package is what makes "mirrors the SDK" a
 * checkable claim. Every field read below is one the familiar surface renders.
 */
export function readFamiliarSurface(
  familiar: CaveFamiliar,
  report: CaveContractReport,
  analytics: CaveFamiliarAnalytics,
): string {
  const properties = report.properties.filter((property) => property.pass).length;
  const window = analytics.windows['7d'];
  // Null is meaningful and must stay distinguishable from zero.
  const rate = window === undefined || window.successRate === null ? 'unknown' : String(window.successRate);

  return [
    familiar.displayName,
    familiar.role,
    familiar.status ?? 'unknown',
    familiar.memoryFreshness ?? 'unknown',
    String(familiar.activeSessions ?? 0),
    report.specVersion,
    String(report.pass),
    String(properties),
    String(report.warnings.length),
    analytics.generatedAt,
    rate,
    String(window?.attempts ?? 0),
    String(window?.toolFailures ?? 0),
    analytics.backfill.state,
    String(analytics.recentAttempts.length),
  ].join(' ');
}
`,
  );

  writeFileSync(resolve(harnessRoot, 'verify.mjs'), createContractCanaryVerifier());
}

function assertIsolatedPackedInstall(harnessRoot) {
  const installedRoot = realpathSync(resolve(harnessRoot, 'node_modules'));
  for (const artifact of Object.values(SDK_ARTIFACTS)) {
    const packageRoot = resolve(harnessRoot, 'node_modules', ...artifact.packageName.split('/'));
    const realPackageRoot = realpathSync(packageRoot);
    const relativePackageRoot = relative(installedRoot, realPackageRoot);
    if (
      relativePackageRoot === '..' ||
      relativePackageRoot.startsWith(`..${sep}`) ||
      isAbsolute(relativePackageRoot)
    ) {
      throw new Error(`Packed ${artifact.packageName} resolved outside the isolated harness.`);
    }
    if (existsSync(resolve(realPackageRoot, 'src'))) {
      throw new Error(`Packed ${artifact.packageName} unexpectedly installed source files.`);
    }
    const manifest = JSON.parse(readFileSync(resolve(realPackageRoot, 'package.json'), 'utf8'));
    for (const dependency of Object.values(manifest.dependencies ?? {})) {
      if (
        typeof dependency !== 'string' ||
        /^(?:file|link|portal|workspace):/u.test(dependency) ||
        dependency.startsWith('/') ||
        /^[A-Za-z]:[\\/]/u.test(dependency)
      ) {
        throw new Error(
          `Packed ${artifact.packageName} retained a workspace or source dependency.`,
        );
      }
    }
  }
}

export function assertPackedFixtureMatchesCaveCheckout(lock, harnessRoot, caveRoot) {
  const fixtureDirectory = resolve(
    harnessRoot,
    'node_modules',
    '@opencoven',
    'cave-client',
    'fixtures',
  );
  const installedFixturePath = resolve(fixtureDirectory, 'contract-fixture.json');
  const installedDigestPath = resolve(fixtureDirectory, 'contract-fixture.sha256');
  const installedProvenancePath = resolve(fixtureDirectory, 'contract-fixture.provenance.json');
  const installedVectorPath = resolve(fixtureDirectory, 'hpke-bound-v1-vectors.json');
  const installedVectorDigestPath = resolve(fixtureDirectory, 'hpke-bound-v1-vectors.sha256');

  for (const [path, label] of [
    [installedFixturePath, 'Packed Cave fixture'],
    [installedDigestPath, 'Packed Cave fixture digest'],
    [installedProvenancePath, 'Packed Cave fixture provenance'],
    [installedVectorPath, 'Packed Cave HPKE vectors'],
    [installedVectorDigestPath, 'Packed Cave HPKE vector digest'],
  ]) {
    requirePath(path, label);
  }

  const provenance = JSON.parse(readFileSync(installedProvenancePath, 'utf8'));
  const installedFixture = readFileSync(installedFixturePath);
  const installedDigest = readFileSync(installedDigestPath, 'utf8').trim().toLowerCase();
  if (
    provenance?.repository !== 'https://github.com/OpenCoven/coven-cave' ||
    provenance?.fixturePath !== 'src/lib/server/client-v1/contract-fixture.json' ||
    provenance?.digestPath !== 'src/lib/server/client-v1/contract-fixture.sha256' ||
    !reviewedRevisionPattern.test(provenance?.commit ?? '') ||
    provenance?.sha256 !== installedDigest ||
    !/^[0-9a-f]{64}$/iu.test(installedDigest) ||
    sha256(installedFixturePath) !== installedDigest
  ) {
    throw new Error('Packed Cave fixture provenance was invalid.');
  }

  try {
    run(
      'git',
      ['-C', caveRoot, 'merge-base', '--is-ancestor', provenance.commit, lock.cave.revision],
      root,
      { stdio: 'pipe' },
    );
  } catch {
    throw new Error(
      'Packed Cave fixture provenance is not an ancestor of the reviewed producer revision.',
    );
  }

  const historicalFixture = run(
    'git',
    ['-C', caveRoot, 'show', `${provenance.commit}:${provenance.fixturePath}`],
    root,
    { stdio: 'pipe' },
  );
  const historicalDigest = run(
    'git',
    ['-C', caveRoot, 'show', `${provenance.commit}:${provenance.digestPath}`],
    root,
    { stdio: 'pipe', encoding: 'utf8' },
  )
    .trim()
    .toLowerCase();
  if (
    historicalDigest !== installedDigest ||
    !Buffer.from(historicalFixture).equals(installedFixture)
  ) {
    throw new Error('Packed Cave fixture bytes did not match their pinned historical producer.');
  }

  for (const [key, artifact] of Object.entries(lock.cave.artifacts)) {
    const checkoutPath = resolve(caveRoot, artifact.path);
    const checkoutDigestPath = resolve(caveRoot, artifact.digestPath);
    requirePath(checkoutPath, `Cave producer ${key}`);
    requirePath(checkoutDigestPath, `Cave producer ${key} digest`);
    const checkoutDigest = readFileSync(checkoutDigestPath, 'utf8').trim().toLowerCase();
    if (checkoutDigest !== artifact.sha256 || sha256(checkoutPath) !== artifact.sha256) {
      throw new Error(`Reviewed Cave producer ${key} did not match its locked digest.`);
    }
  }

  const packedVectorDigest = readFileSync(installedVectorDigestPath, 'utf8').trim().toLowerCase();
  const reviewedVector = lock.cave.artifacts.hpkeVectors;
  if (
    packedVectorDigest !== reviewedVector.sha256 ||
    sha256(installedVectorPath) !== reviewedVector.sha256 ||
    !readFileSync(installedVectorPath).equals(readFileSync(resolve(caveRoot, reviewedVector.path)))
  ) {
    throw new Error('Packed Cave HPKE vectors did not match the reviewed producer revision.');
  }
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const lock = readContractCanaryLock();
  const sdkVerifyContracts = resolve(options.sdkRoot, 'scripts', 'verify-contracts.mjs');

  requirePath(options.sdkRoot, 'SDK root');
  requirePath(options.caveRoot, 'Cave root');
  assertCleanContractCanaryCheckouts(options);
  assertContractCanaryCheckoutHeads(lock, options);
  requirePath(sdkVerifyContracts, 'SDK verify-contracts script');
  runPnpm(['install', '--frozen-lockfile'], options.sdkRoot);

  let artifactContext;

  try {
    artifactContext = createOwnedTempDirectory({
      prefix: 'opencoven-chat-contract-canary',
    });

    const artifactRoot = artifactContext.rootPath;
    const sdkArtifactRoot = resolve(artifactRoot, 'sdk-release');
    const comparisonRoot = resolve(artifactRoot, 'sdk-package-comparison');
    const harnessRoot = resolve(artifactRoot, 'chat-harness');

    run(process.execPath, [sdkVerifyContracts], options.sdkRoot);

    const tarballs = createReviewedSdkReleaseArtifacts(lock, options.sdkRoot, sdkArtifactRoot);
    const frozen = frozenTarballs(lock);
    assertPackedPackageContentsMatch(tarballs, frozen, comparisonRoot);

    createHarness(harnessRoot, frozen);
    installHarnessOfflineAfterWarming(harnessRoot);
    assertIsolatedPackedInstall(harnessRoot);
    assertPackedFixtureMatchesCaveCheckout(lock, harnessRoot, options.caveRoot);

    runPnpm(['--ignore-workspace', 'run', 'build'], harnessRoot);
    runPnpm(['--ignore-workspace', 'run', 'verify'], harnessRoot);
  } finally {
    if (artifactContext !== undefined) {
      cleanupOwnedTempRoot(artifactContext);
    }
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
