import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

  return {
    repository: entry.repository,
    revision: entry.revision,
  };
}

export function readContractCanaryLock(lockPath = defaultLockPath) {
  requirePath(lockPath, 'Contract canary lock');

  const lockData = JSON.parse(readFileSync(lockPath, 'utf8'));

  if (lockData.version !== 1) {
    throw new Error('contract-canary.lock.json version must be 1.');
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

function isolatedInstallArgs() {
  return [
    '--ignore-workspace',
    '--config.inject-workspace-packages=false',
    '--config.link-workspace-packages=false',
    '--config.prefer-workspace-packages=false',
    'install',
    '--offline',
    '--ignore-scripts',
  ];
}

function createPublicPackageOverrides(tarballs) {
  return {
    '@opencoven/sdk-core': `file:${tarballs.core}`,
    '@opencoven/cave-client': `file:${tarballs.cave}`,
    '@opencoven/coven-client': `file:${tarballs.coven}`,
    '@opencoven/sdk': `file:${tarballs.sdk}`,
    '@opencoven/dev-cli': `file:${tarballs.cli}`,
  };
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

function createHarness(harnessRoot, tarballs, fixturePath, digestPath) {
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
        dependencies: {
          '@opencoven/cave-client': `file:${tarballs.cave}`,
        },
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
} from '@opencoven/cave-client';

export function loadAuthorityFixture(
  fixtureContents: string,
  digestContents: string,
): CaveContractFixture {
  return parseVerifiedCaveContractFixture(fixtureContents, digestContents);
}
`,
  );

  writeFileSync(
    resolve(harnessRoot, 'verify.mjs'),
    `import { readFileSync } from 'node:fs';

import { parseVerifiedCaveContractFixture } from '@opencoven/cave-client';

const fixture = readFileSync(${JSON.stringify(fixturePath)}, 'utf8');
const digest = readFileSync(${JSON.stringify(digestPath)}, 'utf8');
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
`,
  );
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const lock = readContractCanaryLock();
  const caveFixturePath = resolve(
    options.caveRoot,
    'src',
    'lib',
    'server',
    'client-v1',
    'contract-fixture.json',
  );
  const caveDigestPath = resolve(
    options.caveRoot,
    'src',
    'lib',
    'server',
    'client-v1',
    'contract-fixture.sha256',
  );
  const sdkVerifyContracts = resolve(options.sdkRoot, 'scripts', 'verify-contracts.mjs');

  requirePath(options.sdkRoot, 'SDK root');
  requirePath(options.caveRoot, 'Cave root');
  requirePath(caveFixturePath, 'Cave authority fixture');
  requirePath(caveDigestPath, 'Cave authority fixture digest');
  requirePath(sdkVerifyContracts, 'SDK verify-contracts script');
  assertContractCanaryCheckoutHeads(lock, options);

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

    createHarness(harnessRoot, tarballs, caveFixturePath, caveDigestPath);
    runPnpm(isolatedInstallArgs(), harnessRoot);

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
