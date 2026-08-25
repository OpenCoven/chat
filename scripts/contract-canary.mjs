import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { cleanupOwnedTempRoot, createOwnedTempDirectory } from './owned-temp-directory.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultSdkRoot = resolve(root, '.cross-repo', 'sdk');
const defaultCaveRoot = resolve(root, '.cross-repo', 'coven-cave');
const defaultLockPath = resolve(root, 'contract-canary.lock.json');
const reviewedRevisionPattern = /^[0-9a-f]{40}$/i;

function printUsage() {
  process.stdout.write(
    [
      'usage: contract-canary.mjs [--sdk-root <path>] [--cave-root <path>]',
      '',
      'Packs the reviewed SDK packages, installs their tarballs into an isolated',
      'Chat canary harness, compiles Chat-owned code against the public',
      '@opencoven/cave-client entry point, validates the reviewed Cave authority',
      'fixture, and proves a stale-digest mutation is rejected.',
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

  const artifacts = entry.artifacts;
  if (
    key === 'sdk' &&
    (artifacts === null || typeof artifacts !== 'object' || Array.isArray(artifacts))
  ) {
    throw new Error('contract-canary.lock.json sdk.artifacts must be an object.');
  }

  return {
    repository: entry.repository,
    revision: entry.revision,
    ...(key === 'sdk' ? { artifacts } : {}),
  };
}

export function readContractCanaryLock(lockPath = defaultLockPath) {
  requirePath(lockPath, 'Contract canary lock');

  const lockData = JSON.parse(readFileSync(lockPath, 'utf8'));

  if (lockData.version !== 2) {
    throw new Error('contract-canary.lock.json version must be 2.');
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

const SDK_ARTIFACTS = Object.freeze({
  core: {
    packageName: '@opencoven/sdk-core',
    fileName: 'sdk-core-0.1.0.tgz',
  },
  cave: {
    packageName: '@opencoven/cave-client',
    fileName: 'cave-client-0.1.0.tgz',
  },
  coven: {
    packageName: '@opencoven/coven-client',
    fileName: 'coven-client-0.1.0.tgz',
  },
  sdk: {
    packageName: '@opencoven/sdk',
    fileName: 'sdk-0.1.0.tgz',
  },
});

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function assertArtifactDigests(lock, tarballs) {
  for (const [key, artifact] of Object.entries(SDK_ARTIFACTS)) {
    const locked = lock.sdk.artifacts[key];
    const tarball = tarballs[key];
    if (
      locked?.packageName !== artifact.packageName ||
      typeof locked.sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/iu.test(locked.sha256) ||
      typeof tarball !== 'string' ||
      sha256(tarball) !== locked.sha256
    ) {
      throw new Error(
        `Packed SDK ${artifact.packageName} does not match its locked artifact digest.`,
      );
    }
  }
}

function frozenTarballs(lock) {
  const tarballs = {};
  for (const [key, artifact] of Object.entries(SDK_ARTIFACTS)) {
    const path = resolve(root, 'vendor', 'opencoven-sdk', artifact.fileName);
    requirePath(path, `Frozen ${artifact.packageName} artifact`);
    tarballs[key] = path;
  }
  assertArtifactDigests(lock, tarballs);
  return tarballs;
}

function packReviewedSdkTarballs(sdkRoot, destinationRoot, manifestPath) {
  const packageArtifactsModule = resolve(sdkRoot, 'scripts', 'package-artifacts.mjs');

  requirePath(packageArtifactsModule, 'SDK package-artifacts script');
  mkdirSync(destinationRoot, { recursive: true });

  const evaluator = [
    "import { writeFileSync } from 'node:fs';",
    `import { packPublicPackages } from ${JSON.stringify(pathToFileURL(packageArtifactsModule).href)};`,
    `const tarballs = packPublicPackages({`,
    `  root: ${JSON.stringify(sdkRoot)},`,
    `  destinationRoot: ${JSON.stringify(destinationRoot)},`,
    `});`,
    `writeFileSync(${JSON.stringify(manifestPath)}, JSON.stringify(tarballs, null, 2) + '\\n');`,
  ].join('\n');

  run(process.execPath, ['--input-type=module', '--eval', evaluator], sdkRoot);

  return JSON.parse(readFileSync(manifestPath, 'utf8'));
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

  writeFileSync(
    resolve(harnessRoot, 'verify.mjs'),
    `import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseVerifiedCaveContractFixture } from '@opencoven/cave-client';

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
  const checkoutFixturePath = resolve(
    caveRoot,
    'src',
    'lib',
    'server',
    'client-v1',
    'contract-fixture.json',
  );
  const checkoutDigestPath = resolve(
    caveRoot,
    'src',
    'lib',
    'server',
    'client-v1',
    'contract-fixture.sha256',
  );

  for (const [path, label] of [
    [installedFixturePath, 'Packed Cave fixture'],
    [installedDigestPath, 'Packed Cave fixture digest'],
    [installedProvenancePath, 'Packed Cave fixture provenance'],
    [checkoutFixturePath, 'Cave checkout fixture'],
    [checkoutDigestPath, 'Cave checkout fixture digest'],
  ]) {
    requirePath(path, label);
  }

  const provenance = JSON.parse(readFileSync(installedProvenancePath, 'utf8'));
  const installedFixture = readFileSync(installedFixturePath);
  const installedDigest = readFileSync(installedDigestPath, 'utf8').trim().toLowerCase();
  const checkoutFixture = readFileSync(checkoutFixturePath);
  const checkoutDigest = readFileSync(checkoutDigestPath, 'utf8').trim().toLowerCase();

  if (
    provenance?.repository !== 'https://github.com/OpenCoven/coven-cave' ||
    provenance?.commit !== lock.cave.revision ||
    provenance?.fixturePath !== 'src/lib/server/client-v1/contract-fixture.json' ||
    provenance?.digestPath !== 'src/lib/server/client-v1/contract-fixture.sha256' ||
    provenance?.sha256 !== installedDigest ||
    !/^[0-9a-f]{64}$/iu.test(installedDigest) ||
    sha256(installedFixturePath) !== installedDigest ||
    checkoutDigest !== installedDigest ||
    !installedFixture.equals(checkoutFixture)
  ) {
    throw new Error('Packed Cave fixture provenance does not match the reviewed Cave checkout.');
  }
}

process.stdout.write('Chat contract canary passed.\\n');
`,
  );
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
    const tarballManifestPath = resolve(artifactRoot, 'sdk-tarballs.json');
    const tarballRoot = resolve(artifactRoot, 'sdk-tarballs');
    const harnessRoot = resolve(artifactRoot, 'chat-harness');

    run(process.execPath, [sdkVerifyContracts], options.sdkRoot);

    const tarballs = packReviewedSdkTarballs(options.sdkRoot, tarballRoot, tarballManifestPath);
    assertArtifactDigests(lock, tarballs);
    const frozen = frozenTarballs(lock);

    createHarness(harnessRoot, frozen);
    installHarnessOfflineAfterWarming(harnessRoot);
    assertPackedFixtureMatchesCaveCheckout(lock, harnessRoot, options.caveRoot);

    if (existsSync(resolve(harnessRoot, 'node_modules', '@opencoven', 'cave-client', 'src'))) {
      throw new Error('Packed @opencoven/cave-client unexpectedly installed source files.');
    }

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
