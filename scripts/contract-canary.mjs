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
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanupOwnedTempRoot, createOwnedTempDirectory } from './owned-temp-directory.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultSdkRoot = resolve(root, '.cross-repo', 'sdk');
const defaultCaveRoot = resolve(root, '.cross-repo', 'coven-cave');
const defaultLockPath = resolve(root, 'contract-canary.lock.json');
const reviewedRevisionPattern = /^[0-9a-f]{40}$/i;
const sha256Pattern = /^[0-9a-f]{64}$/;
const packageVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const publicPackages = [
  {
    name: '@opencoven/sdk-core',
    workspaceDirectory: 'core',
    file: 'tarballs/core/opencoven-sdk-core-0.1.0.tgz',
  },
  {
    name: '@opencoven/cave-client',
    workspaceDirectory: 'cave',
    file: 'tarballs/cave/opencoven-cave-client-0.1.0.tgz',
  },
  {
    name: '@opencoven/coven-client',
    workspaceDirectory: 'coven',
    file: 'tarballs/coven/opencoven-coven-client-0.1.0.tgz',
  },
  {
    name: '@opencoven/sdk',
    workspaceDirectory: 'sdk',
    file: 'tarballs/sdk/opencoven-sdk-0.1.0.tgz',
  },
];
const contractFixturePackageFiles = {
  packageFile: 'fixtures/contract-fixture.json',
  digestPackageFile: 'fixtures/contract-fixture.sha256',
  provenancePackageFile: 'fixtures/contract-fixture.provenance.json',
};
const hpkeVectorFiles = {
  packageFile: 'fixtures/hpke-bound-v1-vectors.json',
  digestPackageFile: 'fixtures/hpke-bound-v1-vectors.sha256',
  authorityFile: 'src/lib/server/client-v1/hpke-bound-v1-vectors.json',
  authorityDigestFile: 'src/lib/server/client-v1/hpke-bound-v1-vectors.sha256',
};

function printUsage() {
  process.stdout.write(
    [
      'usage: contract-canary.mjs [--sdk-root <path>] [--cave-root <path>]',
      '',
      'Builds the reviewed SDK release artifacts once, verifies the generated',
      'manifest and all four public tarballs against the tracked lock, then',
      'installs only those tarballs into an isolated cold Chat harness. The',
      'harness validates the locked Cave fixture provenance and HPKE vectors.',
      '',
    ].join('\n'),
  );
}

function assertRecord(value, context) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object.`);
  }
}

function assertExactFields(value, expectedFields, context) {
  assertRecord(value, context);

  const actualFields = Object.keys(value);
  const missingFields = expectedFields.filter((field) => !Object.hasOwn(value, field));
  const extraFields = actualFields.filter((field) => !expectedFields.includes(field));

  if (missingFields.length > 0) {
    throw new Error(`${context} is missing field ${missingFields[0]}.`);
  }

  if (extraFields.length > 0) {
    throw new Error(`${context} contains unexpected field ${extraFields[0]}.`);
  }
}

function validateSha256(value, context) {
  if (typeof value !== 'string' || !sha256Pattern.test(value)) {
    throw new Error(`${context} must be 64 lowercase hexadecimal characters.`);
  }

  return value;
}

function validateRevision(value, context) {
  if (typeof value !== 'string' || !reviewedRevisionPattern.test(value)) {
    throw new Error(`${context} must be an immutable 40-character commit SHA.`);
  }

  return value;
}

function validateExactString(value, expected, context) {
  if (value !== expected) {
    throw new Error(`${context} must be ${expected}.`);
  }

  return value;
}

function validateLockEntry(lockData, key, expectedRepository, expectedFields) {
  const entry = lockData[key];

  assertExactFields(
    entry,
    ['repository', 'revision', ...expectedFields],
    `contract-canary.lock.json ${key} entry`,
  );

  if (entry.repository !== expectedRepository) {
    throw new Error(`contract-canary.lock.json ${key}.repository must be ${expectedRepository}.`);
  }

  return {
    repository: entry.repository,
    revision: validateRevision(entry.revision, `contract-canary.lock.json ${key}.revision`),
  };
}

export function readContractCanaryLock(lockPath = defaultLockPath) {
  requirePath(lockPath, 'Contract canary lock');

  const lockData = JSON.parse(readFileSync(lockPath, 'utf8'));

  assertExactFields(lockData, ['version', 'sdk', 'cave'], 'contract-canary.lock.json');

  if (lockData.version !== 2) {
    throw new Error('contract-canary.lock.json version must be 2.');
  }

  const sdk = validateLockEntry(lockData, 'sdk', 'OpenCoven/sdk', ['releaseManifest', 'packages']);
  assertExactFields(
    lockData.sdk.releaseManifest,
    ['file', 'version', 'sha256'],
    'contract-canary.lock.json sdk.releaseManifest',
  );
  validateExactString(
    lockData.sdk.releaseManifest.file,
    'release-manifest.json',
    'contract-canary.lock.json sdk.releaseManifest.file',
  );
  if (
    typeof lockData.sdk.releaseManifest.version !== 'string' ||
    !packageVersionPattern.test(lockData.sdk.releaseManifest.version)
  ) {
    throw new Error(
      'contract-canary.lock.json sdk.releaseManifest.version must be an exact semantic version.',
    );
  }

  if (!Array.isArray(lockData.sdk.packages)) {
    throw new Error('contract-canary.lock.json sdk.packages must be an array.');
  }
  if (lockData.sdk.packages.length !== publicPackages.length) {
    throw new Error(
      `contract-canary.lock.json sdk.packages must contain exactly ${publicPackages.length} entries.`,
    );
  }

  const packages = publicPackages.map((expectedPackage, index) => {
    const entry = lockData.sdk.packages[index];
    const context = `contract-canary.lock.json sdk.packages[${index}]`;

    assertExactFields(entry, ['name', 'version', 'file', 'size', 'sha256'], context);
    validateExactString(entry.name, expectedPackage.name, `${context}.name`);
    validateExactString(entry.file, expectedPackage.file, `${context}.file`);
    validateExactString(entry.version, lockData.sdk.releaseManifest.version, `${context}.version`);
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0) {
      throw new Error(`${context}.size must be a positive safe integer.`);
    }

    return {
      name: entry.name,
      version: entry.version,
      file: entry.file,
      size: entry.size,
      sha256: validateSha256(entry.sha256, `${context}.sha256`),
    };
  });

  const cave = validateLockEntry(lockData, 'cave', 'OpenCoven/coven-cave', [
    'contractFixture',
    'hpkeVector',
  ]);
  const contractFixture = lockData.cave.contractFixture;
  assertExactFields(
    contractFixture,
    [
      'packageFile',
      'digestPackageFile',
      'provenancePackageFile',
      'sha256',
      'digestFileSha256',
      'provenanceFileSha256',
      'provenance',
    ],
    'contract-canary.lock.json cave.contractFixture',
  );
  for (const [field, expected] of Object.entries(contractFixturePackageFiles)) {
    validateExactString(
      contractFixture[field],
      expected,
      `contract-canary.lock.json cave.contractFixture.${field}`,
    );
  }
  assertExactFields(
    contractFixture.provenance,
    ['repository', 'commit', 'fixturePath', 'digestPath', 'sha256'],
    'contract-canary.lock.json cave.contractFixture.provenance',
  );
  validateExactString(
    contractFixture.provenance.repository,
    'https://github.com/OpenCoven/coven-cave',
    'contract-canary.lock.json cave.contractFixture.provenance.repository',
  );
  validateExactString(
    contractFixture.provenance.fixturePath,
    'src/lib/server/client-v1/contract-fixture.json',
    'contract-canary.lock.json cave.contractFixture.provenance.fixturePath',
  );
  validateExactString(
    contractFixture.provenance.digestPath,
    'src/lib/server/client-v1/contract-fixture.sha256',
    'contract-canary.lock.json cave.contractFixture.provenance.digestPath',
  );
  validateRevision(
    contractFixture.provenance.commit,
    'contract-canary.lock.json cave.contractFixture.provenance.commit',
  );
  validateSha256(
    contractFixture.provenanceFileSha256,
    'contract-canary.lock.json cave.contractFixture.provenanceFileSha256',
  );
  validateSha256(
    contractFixture.digestFileSha256,
    'contract-canary.lock.json cave.contractFixture.digestFileSha256',
  );
  const contractFixtureSha256 = validateSha256(
    contractFixture.sha256,
    'contract-canary.lock.json cave.contractFixture.sha256',
  );
  validateExactString(
    contractFixture.provenance.sha256,
    contractFixtureSha256,
    'contract-canary.lock.json cave.contractFixture.provenance.sha256',
  );

  const hpkeVector = lockData.cave.hpkeVector;
  assertExactFields(
    hpkeVector,
    [
      'packageFile',
      'digestPackageFile',
      'authorityFile',
      'authorityDigestFile',
      'sha256',
      'digestFileSha256',
    ],
    'contract-canary.lock.json cave.hpkeVector',
  );
  for (const [field, expected] of Object.entries(hpkeVectorFiles)) {
    validateExactString(
      hpkeVector[field],
      expected,
      `contract-canary.lock.json cave.hpkeVector.${field}`,
    );
  }

  return {
    version: lockData.version,
    path: lockPath,
    sdk: {
      ...sdk,
      releaseManifest: {
        file: lockData.sdk.releaseManifest.file,
        version: lockData.sdk.releaseManifest.version,
        sha256: validateSha256(
          lockData.sdk.releaseManifest.sha256,
          'contract-canary.lock.json sdk.releaseManifest.sha256',
        ),
      },
      packages,
    },
    cave: {
      ...cave,
      contractFixture: {
        packageFile: contractFixture.packageFile,
        digestPackageFile: contractFixture.digestPackageFile,
        provenancePackageFile: contractFixture.provenancePackageFile,
        sha256: contractFixtureSha256,
        digestFileSha256: contractFixture.digestFileSha256,
        provenanceFileSha256: contractFixture.provenanceFileSha256,
        provenance: {
          repository: contractFixture.provenance.repository,
          commit: contractFixture.provenance.commit,
          fixturePath: contractFixture.provenance.fixturePath,
          digestPath: contractFixture.provenance.digestPath,
          sha256: contractFixture.provenance.sha256,
        },
      },
      hpkeVector: {
        packageFile: hpkeVector.packageFile,
        digestPackageFile: hpkeVector.digestPackageFile,
        authorityFile: hpkeVector.authorityFile,
        authorityDigestFile: hpkeVector.authorityDigestFile,
        sha256: validateSha256(
          hpkeVector.sha256,
          'contract-canary.lock.json cave.hpkeVector.sha256',
        ),
        digestFileSha256: validateSha256(
          hpkeVector.digestFileSha256,
          'contract-canary.lock.json cave.hpkeVector.digestFileSha256',
        ),
      },
    },
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

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function listTarballFiles(directory, rootDirectory = directory) {
  const files = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...listTarballFiles(entryPath, rootDirectory));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.tgz')) {
      files.push(relative(rootDirectory, entryPath).split(sep).join('/'));
    }
  }

  return files.sort();
}

export function verifySdkReleaseArtifacts(lock, artifactRoot) {
  const manifestPath = resolve(artifactRoot, lock.sdk.releaseManifest.file);

  requirePath(manifestPath, 'Generated SDK release manifest');
  const manifestBytes = readFileSync(manifestPath);
  const manifestDigest = sha256(manifestBytes);

  if (manifestDigest !== lock.sdk.releaseManifest.sha256) {
    throw new Error(
      `Generated release-manifest.json digest ${manifestDigest} does not match locked digest ${lock.sdk.releaseManifest.sha256}.`,
    );
  }

  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  assertExactFields(
    manifest,
    ['schemaVersion', 'version', 'packages'],
    'Generated release-manifest.json',
  );
  if (manifest.schemaVersion !== 1) {
    throw new Error('Generated release-manifest.json schemaVersion must be 1.');
  }
  if (manifest.version !== lock.sdk.releaseManifest.version) {
    throw new Error(
      `Generated release-manifest.json version ${manifest.version} does not match locked version ${lock.sdk.releaseManifest.version}.`,
    );
  }
  if (!Array.isArray(manifest.packages)) {
    throw new Error('Generated release-manifest.json packages must be an array.');
  }
  if (manifest.packages.length !== lock.sdk.packages.length) {
    throw new Error(
      `Generated release-manifest.json must contain exactly ${lock.sdk.packages.length} packages.`,
    );
  }

  const tarballs = {};

  for (const [index, expectedPackage] of lock.sdk.packages.entries()) {
    const actualPackage = manifest.packages[index];
    const context = `Generated release-manifest.json package ${index}`;

    assertExactFields(actualPackage, ['name', 'version', 'file', 'size', 'sha256'], context);

    for (const field of ['name', 'version', 'file', 'size', 'sha256']) {
      if (actualPackage[field] !== expectedPackage[field]) {
        throw new Error(
          `${context} ${field} does not match locked ${expectedPackage.name} metadata.`,
        );
      }
    }

    const tarballPath = resolve(artifactRoot, expectedPackage.file);

    requirePath(tarballPath, `${expectedPackage.name} packed artifact`);
    const stats = lstatSync(tarballPath);

    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`${expectedPackage.name} packed artifact must be a regular file.`);
    }

    const tarballBytes = readFileSync(tarballPath);

    if (tarballBytes.byteLength !== expectedPackage.size) {
      throw new Error(
        `${expectedPackage.name} size ${tarballBytes.byteLength} does not match locked size ${expectedPackage.size}.`,
      );
    }

    const tarballDigest = sha256(tarballBytes);

    if (tarballDigest !== expectedPackage.sha256) {
      throw new Error(
        `${expectedPackage.name} digest ${tarballDigest} does not match locked digest ${expectedPackage.sha256}.`,
      );
    }

    tarballs[publicPackages[index].workspaceDirectory] = tarballPath;
  }

  const actualTarballs = listTarballFiles(resolve(artifactRoot, 'tarballs'));
  const expectedTarballs = lock.sdk.packages
    .map(({ file }) => file.replace(/^tarballs\//u, ''))
    .sort();

  if (JSON.stringify(actualTarballs) !== JSON.stringify(expectedTarballs)) {
    throw new Error(
      'Generated SDK artifact root contains a missing or unexpected packed package tarball.',
    );
  }

  return tarballs;
}

function readRegularFile(path, label) {
  requirePath(path, label);
  const stats = lstatSync(path);

  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`${label} must be a regular file.`);
  }

  return readFileSync(path);
}

function readGitFileAtRevision(repositoryRoot, revision, file, label) {
  try {
    run('git', ['-C', repositoryRoot, 'cat-file', '-e', `${revision}^{commit}`], root, {
      stdio: 'pipe',
    });
  } catch {
    throw new Error(
      `${label} commit ${revision} is unavailable in the clean Cave checkout at ${repositoryRoot}.`,
    );
  }

  try {
    return run('git', ['-C', repositoryRoot, 'show', `${revision}:${file}`], root, {
      stdio: 'pipe',
    });
  } catch {
    throw new Error(`${label} file ${file} is unavailable at Cave commit ${revision}.`);
  }
}

function assertDigestFile(bytes, expectedDigest, expectedFileDigest, label) {
  const expectedContents = `${expectedDigest}\n`;

  if (bytes.toString('utf8') !== expectedContents) {
    throw new Error(`${label} does not contain the locked artifact digest.`);
  }

  const actualFileDigest = sha256(bytes);

  if (actualFileDigest !== expectedFileDigest) {
    throw new Error(
      `${label} byte digest ${actualFileDigest} does not match locked digest ${expectedFileDigest}.`,
    );
  }
}

function assertMatchingBytes(actual, expected, label) {
  if (!actual.equals(expected)) {
    throw new Error(`${label} differ from the locked Cave authority bytes.`);
  }
}

export function verifyPackedCaveAuthorityArtifacts(lock, { caveRoot, installedCaveRoot }) {
  const caveHead = readGitHead(caveRoot, 'Cave root');

  if (caveHead !== lock.cave.revision) {
    throw new Error(
      `Cave checkout HEAD ${caveHead} does not match locked reviewed revision ${lock.cave.revision}.`,
    );
  }

  const fixtureLock = lock.cave.contractFixture;
  const authorityFixture = readGitFileAtRevision(
    caveRoot,
    fixtureLock.provenance.commit,
    fixtureLock.provenance.fixturePath,
    'Cave contract fixture provenance',
  );
  const authorityFixtureDigest = sha256(authorityFixture);

  if (authorityFixtureDigest !== fixtureLock.sha256) {
    throw new Error(
      `Cave contract fixture digest ${authorityFixtureDigest} does not match locked digest ${fixtureLock.sha256}.`,
    );
  }

  const authorityFixtureDigestFile = readGitFileAtRevision(
    caveRoot,
    fixtureLock.provenance.commit,
    fixtureLock.provenance.digestPath,
    'Cave contract fixture provenance',
  );
  assertDigestFile(
    authorityFixtureDigestFile,
    fixtureLock.sha256,
    fixtureLock.digestFileSha256,
    'Cave contract fixture digest file',
  );

  const packedFixture = readRegularFile(
    resolve(installedCaveRoot, fixtureLock.packageFile),
    'Packed Cave contract fixture',
  );
  const packedFixtureDigestFile = readRegularFile(
    resolve(installedCaveRoot, fixtureLock.digestPackageFile),
    'Packed Cave contract fixture digest',
  );
  const packedProvenance = readRegularFile(
    resolve(installedCaveRoot, fixtureLock.provenancePackageFile),
    'Packed Cave contract fixture provenance',
  );

  assertMatchingBytes(packedFixture, authorityFixture, 'The packed Cave contract fixture bytes');
  assertMatchingBytes(
    packedFixtureDigestFile,
    authorityFixtureDigestFile,
    'The packed Cave contract fixture digest bytes',
  );

  const packedProvenanceDigest = sha256(packedProvenance);

  if (packedProvenanceDigest !== fixtureLock.provenanceFileSha256) {
    throw new Error(
      `Packed Cave contract fixture provenance digest ${packedProvenanceDigest} does not match locked digest ${fixtureLock.provenanceFileSha256}.`,
    );
  }

  const parsedProvenance = JSON.parse(packedProvenance.toString('utf8'));
  assertExactFields(
    parsedProvenance,
    ['repository', 'commit', 'fixturePath', 'digestPath', 'sha256'],
    'Packed Cave contract fixture provenance',
  );

  if (JSON.stringify(parsedProvenance) !== JSON.stringify(fixtureLock.provenance)) {
    throw new Error(
      'Packed Cave contract fixture provenance does not match the locked authority provenance.',
    );
  }

  const vectorLock = lock.cave.hpkeVector;
  const authorityVector = readRegularFile(
    resolve(caveRoot, vectorLock.authorityFile),
    'Cave HPKE vector',
  );
  const authorityVectorDigest = sha256(authorityVector);

  if (authorityVectorDigest !== vectorLock.sha256) {
    throw new Error(
      `Cave HPKE vector digest ${authorityVectorDigest} does not match locked digest ${vectorLock.sha256}.`,
    );
  }

  const authorityVectorDigestFile = readRegularFile(
    resolve(caveRoot, vectorLock.authorityDigestFile),
    'Cave HPKE vector digest',
  );
  assertDigestFile(
    authorityVectorDigestFile,
    vectorLock.sha256,
    vectorLock.digestFileSha256,
    'Cave HPKE vector digest file',
  );

  const packedVector = readRegularFile(
    resolve(installedCaveRoot, vectorLock.packageFile),
    'Packed Cave HPKE vector',
  );
  const packedVectorDigestFile = readRegularFile(
    resolve(installedCaveRoot, vectorLock.digestPackageFile),
    'Packed Cave HPKE vector digest',
  );

  assertMatchingBytes(packedVector, authorityVector, 'The packed Cave HPKE vector bytes');
  assertMatchingBytes(
    packedVectorDigestFile,
    authorityVectorDigestFile,
    'The packed Cave HPKE vector digest bytes',
  );

  return {
    contractFixtureSha256: fixtureLock.sha256,
    hpkeVectorSha256: vectorLock.sha256,
  };
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
    '--config.node-linker=isolated',
    '--no-hoist',
    '--config.public-hoist-pattern=[]',
    '--config.shamefully-hoist=false',
    'install',
    offline ? '--offline' : '--prefer-offline',
    ...(offline ? ['--frozen-lockfile'] : []),
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
 * what it is missing. Its installed tree is then removed while the lockfile and
 * package-store entries remain, so the asserting pass is a cold install with
 * no network at all. Keeping the warm node_modules would turn the offline pass
 * into a no-op and remove the guarantee this canary exists to provide.
 */
function installHarnessOfflineAfterWarming(harnessRoot) {
  runPnpm(isolatedInstallArgs({ offline: false }), harnessRoot);
  rmSync(resolve(harnessRoot, 'node_modules'), { force: true, recursive: true });
  runPnpm(isolatedInstallArgs({ offline: true }), harnessRoot);
}

function createPackedPackageSpecifiers(tarballs) {
  return Object.fromEntries(
    publicPackages.map(({ name, workspaceDirectory }) => {
      const tarball = tarballs[workspaceDirectory];

      if (typeof tarball !== 'string' || tarball.length === 0) {
        throw new Error(`Missing packed tarball for ${name}.`);
      }

      return [name, `file:${tarball}`];
    }),
  );
}

export function createPackedConsumerPackageManifest(tarballs) {
  const packedPackageSpecifiers = createPackedPackageSpecifiers(tarballs);

  return {
    name: 'opencoven-chat-contract-canary',
    private: true,
    type: 'module',
    scripts: {
      build: 'tsc --pretty false --noEmit',
      verify: 'node verify.mjs',
    },
    dependencies: packedPackageSpecifiers,
    devDependencies: {
      '@types/node': '24.13.3',
      typescript: '6.0.3',
    },
    pnpm: {
      overrides: packedPackageSpecifiers,
    },
  };
}

function createReviewedSdkReleaseArtifacts(sdkRoot, artifactRoot) {
  const createReleaseArtifactsScript = resolve(sdkRoot, 'scripts', 'create-release-artifacts.mjs');

  requirePath(createReleaseArtifactsScript, 'SDK create-release-artifacts script');
  run(process.execPath, [createReleaseArtifactsScript, '--output', artifactRoot], sdkRoot);
}

function createHarness(harnessRoot, tarballs) {
  mkdirSync(resolve(harnessRoot, 'src'), { recursive: true });

  writeFileSync(
    resolve(harnessRoot, 'package.json'),
    `${JSON.stringify(createPackedConsumerPackageManifest(tarballs), null, 2)}\n`,
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

const cavePackageRoot = dirname(
  fileURLToPath(import.meta.resolve('@opencoven/cave-client/package.json')),
);
const fixture = readFileSync(resolve(cavePackageRoot, 'fixtures/contract-fixture.json'), 'utf8');
const digest = readFileSync(resolve(cavePackageRoot, 'fixtures/contract-fixture.sha256'), 'utf8');
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

function findUnexpectedSourceFile(directory, relativeDirectory = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = resolve(directory, entry.name);
    const relativePath =
      relativeDirectory.length === 0 ? entry.name : `${relativeDirectory}/${entry.name}`;

    if (entry.isDirectory()) {
      if (entry.name === 'src') {
        return relativePath;
      }

      const nestedSource = findUnexpectedSourceFile(entryPath, relativePath);

      if (nestedSource !== undefined) {
        return nestedSource;
      }
      continue;
    }

    if (
      entry.isFile() &&
      /\.(?:cts|mts|ts|tsx)$/u.test(entry.name) &&
      !/\.d\.(?:cts|mts|ts)$/u.test(entry.name)
    ) {
      return relativePath;
    }
  }

  return undefined;
}

function assertInstalledPackedPackages(harnessRoot, lock) {
  const realHarnessRoot = realpathSync(harnessRoot);
  const installedPackages = {};

  for (const [index, expectedPackage] of lock.sdk.packages.entries()) {
    const packageName = expectedPackage.name.split('/')[1];
    const installedPackageRoot = resolve(harnessRoot, 'node_modules', '@opencoven', packageName);
    const manifestPath = resolve(installedPackageRoot, 'package.json');

    requirePath(manifestPath, `${expectedPackage.name} installed manifest`);
    const realInstalledPackageRoot = realpathSync(installedPackageRoot);

    if (
      realInstalledPackageRoot !== realHarnessRoot &&
      !realInstalledPackageRoot.startsWith(`${realHarnessRoot}${sep}`)
    ) {
      throw new Error(`${expectedPackage.name} resolved outside the isolated packed consumer.`);
    }

    const installedManifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

    if (
      installedManifest.name !== expectedPackage.name ||
      installedManifest.version !== expectedPackage.version
    ) {
      throw new Error(
        `${expectedPackage.name} installed manifest does not match the locked package identity.`,
      );
    }

    const unexpectedSource = findUnexpectedSourceFile(installedPackageRoot);

    if (unexpectedSource !== undefined) {
      throw new Error(
        `Packed ${expectedPackage.name} unexpectedly installed source file ${unexpectedSource}.`,
      );
    }

    installedPackages[publicPackages[index].workspaceDirectory] = installedPackageRoot;
  }

  return installedPackages;
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

  let artifactContext;

  try {
    artifactContext = createOwnedTempDirectory({
      prefix: 'opencoven-chat-contract-canary',
    });

    const artifactRoot = artifactContext.rootPath;
    const sdkArtifactRoot = resolve(artifactRoot, 'sdk-release');
    const harnessRoot = resolve(artifactRoot, 'chat-harness');

    run(process.execPath, [sdkVerifyContracts], options.sdkRoot);
    createReviewedSdkReleaseArtifacts(options.sdkRoot, sdkArtifactRoot);

    const tarballs = verifySdkReleaseArtifacts(lock, sdkArtifactRoot);

    createHarness(harnessRoot, tarballs);
    installHarnessOfflineAfterWarming(harnessRoot);

    const installedPackages = assertInstalledPackedPackages(harnessRoot, lock);
    verifyPackedCaveAuthorityArtifacts(lock, {
      caveRoot: options.caveRoot,
      installedCaveRoot: installedPackages.cave,
    });

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
