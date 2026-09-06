import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
} from 'node:fs';
import { devNull } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { runSupervisedSync } from './supervised-exec.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultLockPath = resolve(projectRoot, 'phase1-conformance.lock.json');
const revisionPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const repositoryKeys = ['chat', 'sdk', 'cave', 'coven'];
const canonicalSdkArtifacts = Object.freeze([
  {
    packageName: '@opencoven/sdk-core',
    releaseFile: 'tarballs/core/opencoven-sdk-core-0.1.0.tgz',
    vendorFile: 'sdk-core-0.1.0.tgz',
  },
  {
    packageName: '@opencoven/cave-client',
    releaseFile: 'tarballs/cave/opencoven-cave-client-0.1.0.tgz',
    vendorFile: 'cave-client-0.1.0.tgz',
  },
  {
    packageName: '@opencoven/coven-client',
    releaseFile: 'tarballs/coven/opencoven-coven-client-0.1.0.tgz',
    vendorFile: 'coven-client-0.1.0.tgz',
  },
  {
    packageName: '@opencoven/sdk',
    releaseFile: 'tarballs/sdk/opencoven-sdk-0.1.0.tgz',
    vendorFile: 'sdk-0.1.0.tgz',
  },
]);
const productionChatAuthorityPaths = Object.freeze([
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/src/bin/phase1-native-rpc.rs',
  'src-tauri/src/conformance.rs',
  'src-tauri/src/coven.rs',
  'src-tauri/src/keyring.rs',
  'src-tauri/src/lib.rs',
]);
const harnessAuthorityPaths = Object.freeze([
  'scripts/phase1-conformance.mjs',
  'scripts/phase1-conformance-launcher.sh',
  'scripts/phase1-conformance-launcher.ps1',
  'scripts/phase1-process-supervisor.mjs',
  'scripts/executable-resolution.mjs',
  'scripts/process-owned-artifact-root.mjs',
  'scripts/owned-temp-directory.mjs',
  'scripts/phase1-conformance-lock.mjs',
  'scripts/phase1-evidence-contract.mjs',
  'scripts/phase1-evidence-runtime.mjs',
  'scripts/phase1-schema-v2-evidence.mjs',
  'scripts/phase1-schema-v2-producer.mjs',
  'scripts/phase1-linux-secret-service.mjs',
  'scripts/phase1-linux-secret-service.sh',
  'scripts/phase1-macos-keychain.mjs',
  'scripts/unix-artifact-handoff.c',
  'scripts/unix-producer-command.sh',
  'scripts/unix-producer-supervisor.sh',
  'scripts/windows-job-supervisor.cs',
  'scripts/contract-canary.mjs',
  'scripts/supervised-exec.mjs',
  'scripts/supervisor-status.mjs',
  'scripts/phase1-artifact-secret-scan.mjs',
  '.github/workflows/ci.yml',
  '.github/workflows/client-v1-conformance.yml',
]);
const productionDeltaPaths = Object.freeze([
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
  'src-tauri/src/bin/phase1-native-rpc.rs',
  'src-tauri/src/cave.rs',
  'src-tauri/src/cleanup_grant.rs',
  'src-tauri/src/conformance.rs',
  'src-tauri/src/connection.rs',
  'src-tauri/src/coven.rs',
  'src-tauri/src/keyring.rs',
  'src-tauri/src/lib.rs',
]);
const expectedRepositories = Object.freeze({
  chat: 'OpenCoven/chat',
  sdk: 'OpenCoven/sdk',
  cave: 'OpenCoven/coven-cave',
  coven: 'OpenCoven/coven',
  harness: 'OpenCoven/chat',
});
export const gitNullDevice = process.platform === 'win32' ? 'NUL' : devNull;
const gitConfigurationOverrides = [
  '-c',
  'core.excludesFile=',
  '-c',
  `core.attributesFile=${gitNullDevice}`,
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'credential.helper=',
  '-c',
  `core.askPass=${gitNullDevice}`,
  '-c',
  `core.sshCommand=${gitNullDevice}`,
  '-c',
  'http.proxy=',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'core.checkStat=default',
  '-c',
  'core.trustctime=true',
  '-c',
  'core.symlinks=true',
  '-c',
  `core.fileMode=${process.platform === 'win32' ? 'false' : 'true'}`,
];
const defaultVerificationLimits = Object.freeze({
  repositoryDeadlineMs: 30_000,
  trackedEntryLimit: 100_000,
  trackedPathByteLimit: 16 * 1024 * 1024,
});
const gitChildMaxBuffer = 32 * 1024 * 1024;
const localMetadataMaxBytes = 64 * 1024;
const trackedAttributeBatchSize = 256;
const harnessAuthorityVerifications = new WeakMap();

export function createGitEnvironment(inheritedEnvironment = process.env) {
  const environment = {};

  for (const [key, value] of Object.entries(inheritedEnvironment)) {
    if (!key.toUpperCase().startsWith('GIT_') && value !== undefined) {
      environment[key] = value;
    }
  }

  environment.GIT_ATTR_NOSYSTEM = '1';
  environment.GIT_ATTR_SOURCE = 'HEAD';
  environment.GIT_ALLOW_PROTOCOL = '';
  environment.GIT_ASKPASS = gitNullDevice;
  environment.GIT_CONFIG_GLOBAL = gitNullDevice;
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_NO_LAZY_FETCH = '1';
  environment.GIT_NO_REPLACE_OBJECTS = '1';
  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.GIT_SSH = gitNullDevice;
  environment.GIT_SSH_COMMAND = gitNullDevice;
  environment.GIT_TERMINAL_PROMPT = '0';
  environment.SSH_ASKPASS = gitNullDevice;
  return environment;
}

export function createGitCheckoutEnvironment(inheritedEnvironment = process.env) {
  const environment = createGitEnvironment(inheritedEnvironment);
  delete environment.GIT_ATTR_SOURCE;
  return environment;
}

export function resolveLocalGitDirectory(repositoryRoot) {
  const metadataPath = resolve(repositoryRoot, '.git');
  const metadataStats = lstatSync(metadataPath);

  if (metadataStats.isSymbolicLink()) {
    throw new Error('Local Git metadata must not be a symbolic link.');
  }
  if (metadataStats.isDirectory()) {
    return realpathSync(metadataPath);
  }
  if (!metadataStats.isFile() || metadataStats.size < 1 || metadataStats.size > 4096) {
    throw new Error('Local Git metadata is not a supported directory or gitfile.');
  }

  const match = /^gitdir: ([^\0\r\n]+)\r?\n?$/u.exec(readFileSync(metadataPath, 'utf8'));
  if (match === null) {
    throw new Error('Local Git metadata gitfile is malformed.');
  }
  const gitDirectory = realpathSync(resolve(dirname(metadataPath), match[1]));
  if (!statSync(gitDirectory).isDirectory()) {
    throw new Error('Local Git metadata gitfile does not identify a directory.');
  }
  return gitDirectory;
}

function requireRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value;
}

function requireExactKeys(value, expectedKeys, message) {
  const actualKeys = Object.keys(value);

  if (
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(message);
  }
}

function requirePathString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty path string.`);
  }

  return resolve(value);
}

function requireExistingFile(value, label) {
  const path = requirePathString(value, `${label} path`);

  if (!existsSync(path)) {
    throw new Error(`${label} does not exist.`);
  }

  if (!statSync(path).isFile()) {
    throw new Error(`${label} must be a file.`);
  }

  return path;
}

function normalizeLockEntry(lockData, key) {
  const entry = requireRecord(lockData[key], `phase1-conformance.lock.json ${key} entry`);
  requireExactKeys(
    entry,
    ['repository', 'revision'],
    `phase1-conformance.lock.json ${key} entry must contain exactly repository and revision.`,
  );

  const expectedRepository = expectedRepositories[key];
  if (entry.repository !== expectedRepository) {
    throw new Error(
      `phase1-conformance.lock.json ${key}.repository must be ${expectedRepository}.`,
    );
  }

  if (typeof entry.revision !== 'string' || !revisionPattern.test(entry.revision)) {
    throw new Error(
      `phase1-conformance.lock.json ${key}.revision must be a lowercase immutable 40-character commit SHA.`,
    );
  }

  return Object.freeze({
    repository: expectedRepository,
    revision: entry.revision,
  });
}

function normalizeArtifact(value, expected, label) {
  const artifact = requireRecord(value, label);
  requireExactKeys(
    artifact,
    ['packageName', 'releaseFile', 'vendorFile', 'size', 'sha256'],
    `${label} must contain exact package metadata.`,
  );
  if (
    artifact.packageName !== expected.packageName ||
    artifact.releaseFile !== expected.releaseFile ||
    artifact.vendorFile !== expected.vendorFile ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size <= 0 ||
    typeof artifact.sha256 !== 'string' ||
    !digestPattern.test(artifact.sha256)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return Object.freeze({ ...artifact });
}

function normalizeFileArtifact(value, expectedPath, label) {
  const artifact = requireRecord(value, label);
  requireExactKeys(
    artifact,
    ['path', 'size', 'sha256'],
    `${label} must contain exactly path, size, and sha256.`,
  );
  if (
    artifact.path !== expectedPath ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size <= 0 ||
    typeof artifact.sha256 !== 'string' ||
    !digestPattern.test(artifact.sha256)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return Object.freeze({ ...artifact });
}

function normalizeDigestFile(value, expectedPath, label) {
  const artifact = requireRecord(value, label);
  requireExactKeys(artifact, ['path', 'sha256'], `${label} must contain exactly path and sha256.`);
  if (
    artifact.path !== expectedPath ||
    typeof artifact.sha256 !== 'string' ||
    !digestPattern.test(artifact.sha256)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return Object.freeze({ ...artifact });
}

function normalizeRelease(value) {
  const release = requireRecord(value, 'phase1-conformance.lock.json release');
  requireExactKeys(
    release,
    ['sdkManifest', 'sdkArtifacts', 'caveVersion', 'covenVersion', 'consumerLock', 'caveArtifacts'],
    'phase1-conformance.lock.json release entry is invalid.',
  );
  const manifest = requireRecord(release.sdkManifest, 'release.sdkManifest');
  requireExactKeys(
    manifest,
    ['version', 'sha256'],
    'release.sdkManifest must contain exactly version and sha256.',
  );
  if (
    manifest.version !== '0.1.0' ||
    typeof manifest.sha256 !== 'string' ||
    !digestPattern.test(manifest.sha256)
  ) {
    throw new Error('release.sdkManifest is invalid.');
  }
  if (
    !Array.isArray(release.sdkArtifacts) ||
    release.sdkArtifacts.length !== canonicalSdkArtifacts.length
  ) {
    throw new Error('release.sdkArtifacts must contain four packages in canonical package order.');
  }
  const sdkArtifacts = release.sdkArtifacts.map((artifact, index) => {
    const expected = canonicalSdkArtifacts[index];
    if (artifact?.packageName !== expected.packageName) {
      throw new Error('release.sdkArtifacts must use canonical package order.');
    }
    return normalizeArtifact(artifact, expected, `release.sdkArtifacts[${index}]`);
  });
  const canonicalManifest = `${JSON.stringify(
    {
      schemaVersion: 1,
      version: manifest.version,
      packages: sdkArtifacts.map((artifact) => ({
        name: artifact.packageName,
        version: manifest.version,
        file: artifact.releaseFile,
        size: artifact.size,
        sha256: artifact.sha256,
      })),
    },
    null,
    2,
  )}\n`;
  if (createHash('sha256').update(canonicalManifest).digest('hex') !== manifest.sha256) {
    throw new Error('release SDK manifest digest does not match canonical package metadata.');
  }
  if (release.caveVersion !== '0.3.12' || release.covenVersion !== '0.1.0') {
    throw new Error('release authority versions are invalid.');
  }
  const consumerLock = normalizeFileArtifact(
    release.consumerLock,
    'pnpm-lock.yaml',
    'release.consumerLock',
  );
  const caveArtifacts = requireRecord(release.caveArtifacts, 'release.caveArtifacts');
  requireExactKeys(
    caveArtifacts,
    ['assertionEngine', 'contractFixture', 'hpkeVectors'],
    'release.caveArtifacts is invalid.',
  );
  return Object.freeze({
    sdkManifest: Object.freeze({ ...manifest }),
    sdkArtifacts: Object.freeze(sdkArtifacts),
    caveVersion: release.caveVersion,
    covenVersion: release.covenVersion,
    consumerLock,
    caveArtifacts: Object.freeze({
      assertionEngine: normalizeFileArtifact(
        caveArtifacts.assertionEngine,
        'scripts/client-v1-conformance.mjs',
        'release.caveArtifacts.assertionEngine',
      ),
      contractFixture: normalizeFileArtifact(
        caveArtifacts.contractFixture,
        'src/lib/server/client-v1/contract-fixture.json',
        'release.caveArtifacts.contractFixture',
      ),
      hpkeVectors: normalizeFileArtifact(
        caveArtifacts.hpkeVectors,
        'src/lib/server/client-v1/hpke-bound-v1-vectors.json',
        'release.caveArtifacts.hpkeVectors',
      ),
    }),
  });
}

function normalizeEvidence(value) {
  const evidence = requireRecord(value, 'phase1-conformance.lock.json evidence');
  requireExactKeys(
    evidence,
    ['repository', 'revision', 'contract', 'schema', 'assertionRegistry'],
    'phase1-conformance.lock.json evidence entry is invalid.',
  );
  if (evidence.repository !== 'OpenCoven/sdk') {
    throw new Error('evidence.repository must be OpenCoven/sdk.');
  }
  if (typeof evidence.revision !== 'string' || !revisionPattern.test(evidence.revision)) {
    throw new Error('evidence.revision must be a lowercase immutable 40-character commit SHA.');
  }
  return Object.freeze({
    repository: evidence.repository,
    revision: evidence.revision,
    contract: normalizeDigestFile(
      evidence.contract,
      'scripts/conformance-contract.mjs',
      'evidence.contract',
    ),
    schema: normalizeDigestFile(
      evidence.schema,
      'conformance/client-v1-cross-repository-evidence.schema.json',
      'evidence.schema',
    ),
    assertionRegistry: normalizeDigestFile(
      evidence.assertionRegistry,
      'conformance/client-v1-cross-repository-assertions.json',
      'evidence.assertionRegistry',
    ),
  });
}

function normalizeChatAuthority(value) {
  const authority = requireRecord(value, 'phase1-conformance.lock.json chatAuthority');
  requireExactKeys(
    authority,
    ['tree', 'files'],
    'phase1-conformance.lock.json chatAuthority entry is invalid.',
  );
  if (typeof authority.tree !== 'string' || !revisionPattern.test(authority.tree)) {
    throw new Error('chatAuthority.tree must be an immutable Git tree ID.');
  }

  if (
    !Array.isArray(authority.files) ||
    authority.files.length !== productionChatAuthorityPaths.length
  ) {
    throw new Error('chatAuthority files must use canonical Chat authority file order.');
  }
  const files = authority.files.map((rawFile, index) => {
    const file = requireRecord(rawFile, `chatAuthority.files[${index}]`);
    requireExactKeys(file, ['path', 'blob', 'sha256'], `chatAuthority.files[${index}] is invalid.`);
    if (
      file.path !== productionChatAuthorityPaths[index] ||
      typeof file.blob !== 'string' ||
      !revisionPattern.test(file.blob) ||
      typeof file.sha256 !== 'string' ||
      !digestPattern.test(file.sha256)
    ) {
      throw new Error('chatAuthority files must use canonical Chat authority file order.');
    }
    return Object.freeze({ ...file });
  });
  return Object.freeze({
    tree: authority.tree,
    files: Object.freeze(files),
  });
}

function normalizeAuthorityFiles(value, expectedPaths, label) {
  if (!Array.isArray(value) || value.length !== expectedPaths.length) {
    throw new Error(`${label} must use canonical file order.`);
  }
  return Object.freeze(
    value.map((rawFile, index) => {
      const file = requireRecord(rawFile, `${label}[${index}]`);
      requireExactKeys(file, ['path', 'blob', 'sha256'], `${label}[${index}] is invalid.`);
      if (
        file.path !== expectedPaths[index] ||
        typeof file.blob !== 'string' ||
        !revisionPattern.test(file.blob) ||
        typeof file.sha256 !== 'string' ||
        !digestPattern.test(file.sha256)
      ) {
        throw new Error(`${label} must use canonical file order.`);
      }
      return Object.freeze({ ...file });
    }),
  );
}

function normalizeHarnessAuthority(value) {
  const authority = requireRecord(value, 'phase1-conformance.lock.json harnessAuthority');
  requireExactKeys(
    authority,
    ['revision', 'tree', 'files', 'productionDeltas'],
    'phase1-conformance.lock.json harnessAuthority entry is invalid.',
  );
  if (
    typeof authority.revision !== 'string' ||
    !revisionPattern.test(authority.revision) ||
    typeof authority.tree !== 'string' ||
    !revisionPattern.test(authority.tree)
  ) {
    throw new Error('harnessAuthority revision and tree must be immutable Git IDs.');
  }
  return Object.freeze({
    revision: authority.revision,
    tree: authority.tree,
    files: normalizeAuthorityFiles(
      authority.files,
      harnessAuthorityPaths,
      'harnessAuthority.files',
    ),
    productionDeltas: normalizeAuthorityFiles(
      authority.productionDeltas,
      productionDeltaPaths,
      'harnessAuthority.productionDeltas',
    ),
  });
}

function normalizeTools(value) {
  const tools = requireRecord(value, 'phase1-conformance.lock.json tools');
  requireExactKeys(tools, ['windowsSupervisor'], 'phase1-conformance.lock.json tools is invalid.');
  const supervisor = requireRecord(tools.windowsSupervisor, 'tools.windowsSupervisor');
  requireExactKeys(
    supervisor,
    ['source', 'toolchain', 'artifact'],
    'tools.windowsSupervisor is invalid.',
  );
  const source = requireRecord(supervisor.source, 'tools.windowsSupervisor.source');
  requireExactKeys(
    source,
    [
      'repository',
      'revision',
      'path',
      'blob',
      'sha256',
      'manifestSha256',
      'lockSha256',
      'configSha256',
    ],
    'tools.windowsSupervisor.source is invalid.',
  );
  const toolchain = requireRecord(supervisor.toolchain, 'tools.windowsSupervisor.toolchain');
  requireExactKeys(
    toolchain,
    ['homebrewCoreRevision', 'packageVersion', 'bottleLayerSha256', 'linkerVersion'],
    'tools.windowsSupervisor.toolchain is invalid.',
  );
  const artifact = requireRecord(supervisor.artifact, 'tools.windowsSupervisor.artifact');
  requireExactKeys(
    artifact,
    ['target', 'buildInvocation', 'fileName', 'fleetPath', 'size', 'sha256'],
    'tools.windowsSupervisor.artifact is invalid.',
  );
  if (
    source.repository !== 'OpenCoven/chat' ||
    !revisionPattern.test(source.revision) ||
    source.path !== 'tools/phase1-process-supervisor/src/main.rs' ||
    !revisionPattern.test(source.blob) ||
    !digestPattern.test(source.sha256) ||
    !digestPattern.test(source.manifestSha256) ||
    !digestPattern.test(source.lockSha256) ||
    !digestPattern.test(source.configSha256) ||
    toolchain.homebrewCoreRevision !== 'cd168d1fdc26f12e4ad64f358ff2dbec61ab7a57' ||
    toolchain.packageVersion !== 'mingw-w64 14.0.0_3' ||
    toolchain.bottleLayerSha256 !==
      '0d68ab737a8bbc8c63ac6ac7acc0695e2887c1169df9a4423f1180090079b1d5' ||
    toolchain.linkerVersion !== '2.47.20260726' ||
    artifact.target !== 'x86_64-pc-windows-gnu' ||
    artifact.buildInvocation !==
      'cd tools/phase1-process-supervisor && SOURCE_DATE_EPOCH=0 cargo build --target x86_64-pc-windows-gnu --release --locked' ||
    artifact.fileName !== 'phase1-process-supervisor.exe' ||
    artifact.fleetPath !== 'C:\\OpenCoven\\conformance\\phase1-process-supervisor.exe' ||
    !Number.isSafeInteger(artifact.size) ||
    artifact.size <= 0 ||
    !digestPattern.test(artifact.sha256)
  ) {
    throw new Error('tools.windowsSupervisor metadata is invalid.');
  }
  return Object.freeze({
    windowsSupervisor: Object.freeze({
      source: Object.freeze({ ...source }),
      toolchain: Object.freeze({ ...toolchain }),
      artifact: Object.freeze({ ...artifact }),
    }),
  });
}

export function readPhase1ConformanceLock(lockPath = defaultLockPath) {
  const path = requireExistingFile(lockPath, 'Phase 1 conformance lock');
  let lockData;

  try {
    lockData = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('phase1-conformance.lock.json must contain valid JSON.');
  }

  requireRecord(lockData, 'phase1-conformance.lock.json');
  requireExactKeys(
    lockData,
    [
      'version',
      ...repositoryKeys,
      'harness',
      'chatAuthority',
      'harnessAuthority',
      'tools',
      'release',
      'evidence',
    ],
    'phase1-conformance.lock.json must contain exactly version, chat, sdk, cave, coven, harness, chatAuthority, harnessAuthority, tools, release, and evidence.',
  );

  if (lockData.version !== 5) {
    throw new Error('phase1-conformance.lock.json version must be 5.');
  }

  return Object.freeze({
    path,
    version: 5,
    chat: normalizeLockEntry(lockData, 'chat'),
    sdk: normalizeLockEntry(lockData, 'sdk'),
    cave: normalizeLockEntry(lockData, 'cave'),
    coven: normalizeLockEntry(lockData, 'coven'),
    harness: normalizeLockEntry(lockData, 'harness'),
    chatAuthority: normalizeChatAuthority(lockData.chatAuthority),
    harnessAuthority: normalizeHarnessAuthority(lockData.harnessAuthority),
    tools: normalizeTools(lockData.tools),
    release: normalizeRelease(lockData.release),
    evidence: normalizeEvidence(lockData.evidence),
  });
}

function runAuthorityGit(repositoryRoot, args) {
  return runSupervisedSync(
    'git',
    [
      ...gitConfigurationOverrides,
      '-c',
      `safe.directory=${repositoryRoot}`,
      '-C',
      repositoryRoot,
      ...args,
    ],
    {
      encoding: 'utf8',
      env: createGitEnvironment(),
      maxBuffer: gitChildMaxBuffer,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: defaultVerificationLimits.repositoryDeadlineMs,
      killSignal: 'SIGKILL',
    },
  ).trim();
}

function readAuthorityBlobs(repositoryRoot, paths) {
  const output = runAuthorityGit(repositoryRoot, [
    'ls-tree',
    '-z',
    '--full-tree',
    'HEAD',
    '--',
    ...paths,
  ]);
  const blobs = new Map();

  for (const entry of output.split('\0')) {
    if (entry.length === 0) {
      continue;
    }
    const match = /^100(?:644|755) blob ([0-9a-f]{40})\t(.+)$/u.exec(entry);
    if (match === null) {
      throw new Error('Phase 1 authority contains a non-file Git entry.');
    }
    blobs.set(match[2], match[1]);
  }
  return blobs;
}

function authorityFileMatches(repositoryRoot, file, blob) {
  const path = resolve(repositoryRoot, file.path);
  let descriptor;
  let matches = false;

  try {
    const before = lstatSync(path, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) {
      return false;
    }
    descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      opened.size !== before.size
    ) {
      return false;
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    const pathAfter = lstatSync(path, { bigint: true });
    matches =
      opened.dev === after.dev &&
      opened.ino === after.ino &&
      opened.size === after.size &&
      opened.mtimeNs === after.mtimeNs &&
      opened.ctimeNs === after.ctimeNs &&
      after.dev === pathAfter.dev &&
      after.ino === pathAfter.ino &&
      after.size === pathAfter.size &&
      after.mtimeNs === pathAfter.mtimeNs &&
      after.ctimeNs === pathAfter.ctimeNs &&
      blob === file.blob &&
      createHash('sha256').update(bytes).digest('hex') === file.sha256;
  } catch {
    matches = false;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        matches = false;
      }
    }
  }
  return matches;
}

export function assertPhase1HarnessAuthorityCheckout(lock, repositoryRoot) {
  const root = realpathSync(requirePathString(repositoryRoot, 'Phase 1 harness checkout root'));
  const authority = requireRecord(
    requireRecord(lock, 'Phase 1 conformance lock').harnessAuthority,
    'Phase 1 harness authority',
  );
  const harness = requireRecord(lock.harness, 'Phase 1 harness lock entry');
  const [revision, tree] = runAuthorityGit(root, ['rev-parse', 'HEAD', 'HEAD^{tree}']).split('\n');

  if (
    authority.revision !== harness.revision ||
    revision !== authority.revision ||
    tree !== authority.tree
  ) {
    throw new Error('Executing Phase 1 harness revision does not match its immutable authority.');
  }
  if (!Array.isArray(authority.files) || authority.files.length !== harnessAuthorityPaths.length) {
    throw new Error('Executing Phase 1 harness module does not match its immutable authority.');
  }
  const blobs = readAuthorityBlobs(
    root,
    authority.files.map(({ path }) => path),
  );
  for (const file of authority.files) {
    if (!authorityFileMatches(root, file, blobs.get(file.path))) {
      throw new Error('Executing Phase 1 harness module does not match its immutable authority.');
    }
  }
  return Object.freeze({ revision, tree });
}

export function assertExecutingPhase1HarnessAuthority(
  lock,
  executingRoot = projectRoot,
  environment = process.env,
) {
  const configuredRoot = environment.OPENCOVEN_PHASE1_VERIFIED_RUNNER_ROOT;
  if (
    environment.OPENCOVEN_PHASE1_VERIFIED_RUNNER !== '1' ||
    typeof configuredRoot !== 'string' ||
    realpathSync(configuredRoot) !== realpathSync(executingRoot)
  ) {
    throw new Error('Phase 1 runner is not executing from its verified harness checkout.');
  }
  const root = realpathSync(executingRoot);
  const identity = assertPhase1HarnessAuthorityCheckout(lock, root);
  const verification = Object.freeze({});
  harnessAuthorityVerifications.set(
    verification,
    Object.freeze({ lock, root, revision: identity.revision, tree: identity.tree }),
  );
  return verification;
}

export function requirePhase1HarnessAuthorityVerification(
  verification,
  lock,
  executingRoot = projectRoot,
) {
  const verified = harnessAuthorityVerifications.get(verification);
  if (
    verified === undefined ||
    verified.lock !== lock ||
    verified.root !== realpathSync(executingRoot) ||
    verified.revision !== lock.harnessAuthority.revision ||
    verified.tree !== lock.harnessAuthority.tree
  ) {
    throw new Error('Schema-v2 execution requires verified Phase 1 harness authority.');
  }
}

export function assertPhase1ProducerAuthority(lock, producerRoot) {
  const root = realpathSync(requirePathString(producerRoot, 'Schema-v2 producer checkout root'));
  assertPhase1HarnessAuthorityCheckout(lock, root);
  const expectedDeltas = lock.harnessAuthority.productionDeltas;
  const changed = runAuthorityGit(root, [
    'diff',
    '--name-only',
    lock.chat.revision,
    'HEAD',
    '--',
    ...productionDeltaPaths,
  ])
    .split('\n')
    .filter(Boolean)
    .sort();

  if (
    !Array.isArray(expectedDeltas) ||
    expectedDeltas.length !== productionDeltaPaths.length ||
    JSON.stringify(changed) !== JSON.stringify(expectedDeltas.map(({ path }) => path).sort())
  ) {
    throw new Error('Chat conformance native delta set is not exactly allowlisted.');
  }
  const blobs = readAuthorityBlobs(
    root,
    expectedDeltas.map(({ path }) => path),
  );
  for (const delta of expectedDeltas) {
    if (!authorityFileMatches(root, delta, blobs.get(delta.path))) {
      throw new Error('Chat conformance native delta does not match its immutable allowlist.');
    }
  }
}

function normalizeCheckoutRoots(checkoutRoots) {
  const roots = requireRecord(checkoutRoots, 'Phase 1 checkout roots');
  const normalizedRoots = {};
  const keys = [...repositoryKeys, ...(Object.hasOwn(roots, 'chatHarnessRoot') ? ['harness'] : [])];

  for (const key of keys) {
    const label = `${key} checkout root`;
    const property = key === 'harness' ? 'chatHarnessRoot' : `${key}Root`;
    const path = requirePathString(roots[property], label);

    if (!existsSync(path)) {
      throw new Error(`${label} does not exist.`);
    }

    if (!statSync(path).isDirectory()) {
      throw new Error(`${label} must be a directory.`);
    }

    normalizedRoots[key] = path;
  }

  return { keys, roots: normalizedRoots };
}

function throwUnreadableGitCheckout(label) {
  throw new Error(`${label} is not a readable Git checkout.`);
}

function throwUnsafeVerificationEnvironment(label) {
  throw new Error(`${label} verification environment is unsafe.`);
}

function throwVerificationTimedOut(label) {
  throw new Error(`${label} verification timed out.`);
}

function throwTrackedPathLimits(label) {
  throw new Error(`${label} exceeds tracked path limits.`);
}

function createRepositoryVerificationContext(label, limits) {
  return {
    deadline: performance.now() + limits.repositoryDeadlineMs,
    label,
    limits,
  };
}

function remainingGitTimeout(context) {
  const remainingMilliseconds = Math.floor(context.deadline - performance.now());

  if (remainingMilliseconds <= 0) {
    throwVerificationTimedOut(context.label);
  }

  return remainingMilliseconds;
}

function createInertHooksDirectory(label) {
  let hooksPath;

  try {
    hooksPath = mkdtempSync(resolve(projectRoot, '.phase1-conformance-hooks-'));
    chmodSync(hooksPath, 0o700);
    const hooksStats = lstatSync(hooksPath);
    const ownedByProcess =
      typeof process.getuid !== 'function' || hooksStats.uid === process.getuid();

    if (
      !hooksStats.isDirectory() ||
      hooksStats.isSymbolicLink() ||
      (hooksStats.mode & 0o077) !== 0 ||
      !ownedByProcess ||
      readdirSync(hooksPath).length !== 0
    ) {
      throwUnsafeVerificationEnvironment(label);
    }
  } catch {
    if (hooksPath !== undefined) {
      rmSync(hooksPath, { force: true, recursive: true });
    }

    throwUnsafeVerificationEnvironment(label);
  }

  return hooksPath;
}

function runGit(repositoryRoot, args, context, input, trackedPathOutput = false) {
  const { label } = context;
  const hooksPath = createInertHooksDirectory(label);

  try {
    const timeout = remainingGitTimeout(context);
    return runSupervisedSync(
      'git',
      [
        ...gitConfigurationOverrides,
        '-c',
        `core.hooksPath=${hooksPath}`,
        '-C',
        repositoryRoot,
        `--work-tree=${repositoryRoot}`,
        ...args,
      ],
      {
        encoding: 'utf8',
        env: createGitEnvironment(),
        input,
        maxBuffer: gitChildMaxBuffer,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        timeout,
        killSignal: 'SIGKILL',
      },
    );
  } catch (error) {
    if (error?.code === 'ETIMEDOUT' || performance.now() >= context.deadline) {
      throwVerificationTimedOut(label);
    }

    if (trackedPathOutput && error?.code === 'ENOBUFS') {
      throwTrackedPathLimits(label);
    }

    throwUnreadableGitCheckout(label);
  } finally {
    try {
      rmSync(hooksPath, { force: true, recursive: true });

      if (existsSync(hooksPath)) {
        throwUnsafeVerificationEnvironment(label);
      }
    } catch {
      throwUnsafeVerificationEnvironment(label);
    }
  }
}

function readGitStatus(repositoryRoot, context) {
  return runGit(
    repositoryRoot,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'],
    context,
  );
}

function summarizeGitStatus(statusOutput) {
  const summary = {
    staged: 0,
    unstaged: 0,
    untracked: 0,
  };
  const records = statusOutput.split('\0');

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 3) {
      continue;
    }

    const indexStatus = record[0];
    const worktreeStatus = record[1];

    if (indexStatus === '?' && worktreeStatus === '?') {
      summary.untracked += 1;
      continue;
    }

    if (indexStatus !== ' ' && indexStatus !== '?') {
      summary.staged += 1;
    }

    if (worktreeStatus !== ' ' && worktreeStatus !== '?') {
      summary.unstaged += 1;
    }

    if (
      indexStatus === 'R' ||
      indexStatus === 'C' ||
      worktreeStatus === 'R' ||
      worktreeStatus === 'C'
    ) {
      index += 1;
    }
  }

  return summary;
}

function formatBoundedCount(count, singular, plural) {
  const displayCount = count > 100 ? '100+' : String(count);
  return `${displayCount} ${count === 1 ? singular : plural}`;
}

function formatDirtySummary(summary) {
  const parts = [];

  if (summary.staged > 0) {
    parts.push(formatBoundedCount(summary.staged, 'staged change', 'staged changes'));
  }
  if (summary.unstaged > 0) {
    parts.push(formatBoundedCount(summary.unstaged, 'unstaged change', 'unstaged changes'));
  }
  if (summary.untracked > 0) {
    parts.push(formatBoundedCount(summary.untracked, 'untracked item', 'untracked items'));
  }

  return parts.join(', ');
}

function countReplacementRefs(repositoryRoot, context) {
  const output = runGit(
    repositoryRoot,
    ['for-each-ref', '--count=101', '--format=1', 'refs/replace'],
    context,
  ).trim();

  return output.length === 0 ? 0 : output.split('\n').length;
}

function assertNoReplacementRefs(repositoryRoot, context) {
  const count = countReplacementRefs(repositoryRoot, context);

  if (count > 0) {
    throw new Error(
      `${context.label} has ${formatBoundedCount(count, 'replacement ref', 'replacement refs')}.`,
    );
  }
}

function countHiddenIndexEntries(repositoryRoot, context) {
  const output = runGit(repositoryRoot, ['ls-files', '--cached', '-v', '-z'], context);
  let count = 0;

  for (const record of output.split('\0')) {
    const tag = record[0];

    if (tag === 'h' || tag === 'S' || tag === 's') {
      count += 1;

      if (count > 100) {
        return count;
      }
    }
  }

  return count;
}

function assertNoHiddenIndexEntries(repositoryRoot, context) {
  const count = countHiddenIndexEntries(repositoryRoot, context);

  if (count > 0) {
    throw new Error(
      `${context.label} has ${formatBoundedCount(
        count,
        'hidden index entry',
        'hidden index entries',
      )}.`,
    );
  }
}

function throwUnsafeLocalMetadata(label, metadataKind) {
  throw new Error(`${label} has unsafe local ${metadataKind} metadata.`);
}

function readLocalMetadata(repositoryRoot, context, gitPathName, metadataKind) {
  const { label } = context;
  const gitPathOutput = runGit(repositoryRoot, ['rev-parse', '--git-path', gitPathName], context);
  let gitPath = gitPathOutput.endsWith('\n') ? gitPathOutput.slice(0, -1) : gitPathOutput;

  if (gitPath.endsWith('\r')) {
    gitPath = gitPath.slice(0, -1);
  }

  if (gitPath.length === 0 || /[\0\r\n]/.test(gitPath)) {
    throwUnsafeLocalMetadata(label, metadataKind);
  }

  const metadataPath = resolve(repositoryRoot, gitPath);
  let pathStats;

  try {
    pathStats = lstatSync(metadataPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return '';
    }

    throwUnsafeLocalMetadata(label, metadataKind);
  }

  if (pathStats.isSymbolicLink() || !pathStats.isFile() || (pathStats.mode & 0o444) === 0) {
    throwUnsafeLocalMetadata(label, metadataKind);
  }

  let descriptor;
  let contents;
  let unsafe = false;

  try {
    descriptor = openSync(metadataPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedStats = fstatSync(descriptor);

    if (
      !openedStats.isFile() ||
      openedStats.dev !== pathStats.dev ||
      openedStats.ino !== pathStats.ino ||
      openedStats.size > localMetadataMaxBytes
    ) {
      unsafe = true;
    } else {
      const buffer = Buffer.alloc(localMetadataMaxBytes + 1);
      let totalBytesRead = 0;

      while (totalBytesRead < buffer.length) {
        const bytesRead = readSync(
          descriptor,
          buffer,
          totalBytesRead,
          buffer.length - totalBytesRead,
          null,
        );

        if (bytesRead === 0) {
          break;
        }

        totalBytesRead += bytesRead;
      }

      if (totalBytesRead > localMetadataMaxBytes) {
        unsafe = true;
      } else {
        contents = buffer.subarray(0, totalBytesRead).toString('utf8');
      }
    }
  } catch {
    unsafe = true;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        unsafe = true;
      }
    }
  }

  if (unsafe || contents === undefined) {
    throwUnsafeLocalMetadata(label, metadataKind);
  }

  return contents;
}

function countLocalRules(repositoryRoot, context, gitPathName, metadataKind) {
  const contents = readLocalMetadata(repositoryRoot, context, gitPathName, metadataKind);
  let count = 0;

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (line.startsWith('#') || /^[ \t]*$/.test(line)) {
      continue;
    }

    count += 1;

    if (count > 100) {
      return count;
    }
  }

  return count;
}

function assertNoLocalExcludeRules(repositoryRoot, context) {
  const count = countLocalRules(repositoryRoot, context, 'info/exclude', 'exclude');

  if (count > 0) {
    throw new Error(
      `${context.label} has ${formatBoundedCount(
        count,
        'local exclude rule',
        'local exclude rules',
      )}.`,
    );
  }
}

function assertNoLocalAttributeRules(repositoryRoot, context) {
  const count = countLocalRules(repositoryRoot, context, 'info/attributes', 'attribute');

  if (count > 0) {
    throw new Error(
      `${context.label} has ${formatBoundedCount(
        count,
        'local attribute rule',
        'local attribute rules',
      )}.`,
    );
  }
}

function collectTrackedFilterAttributes(
  repositoryRoot,
  context,
  trackedPaths,
  checkAttributeArgs,
  activePaths,
) {
  for (let offset = 0; offset < trackedPaths.length; offset += trackedAttributeBatchSize) {
    const pathBatch = trackedPaths.slice(offset, offset + trackedAttributeBatchSize);
    const output = runGit(repositoryRoot, checkAttributeArgs, context, `${pathBatch.join('\0')}\0`);
    const fields = output.split('\0');

    if (fields.at(-1) === '') {
      fields.pop();
    }

    if (fields.length !== pathBatch.length * 3) {
      throwUnreadableGitCheckout(context.label);
    }

    for (let index = 0; index < fields.length; index += 3) {
      if (fields[index + 1] !== 'filter') {
        throwUnreadableGitCheckout(context.label);
      }

      const value = fields[index + 2];
      if (value !== 'unspecified' && value !== 'unset') {
        activePaths.add(fields[index]);

        if (activePaths.size > 100) {
          return;
        }
      }
    }
  }
}

function splitNullDelimitedPaths(output) {
  return output.split('\0').filter((path) => path.length > 0);
}

function parseIndexEntries(output, label) {
  return splitNullDelimitedPaths(output).map((record) => {
    const tabOffset = record.indexOf('\t');
    const metadata = tabOffset === -1 ? [] : record.slice(0, tabOffset).split(' ');
    const path = tabOffset === -1 ? '' : record.slice(tabOffset + 1);

    if (
      metadata.length !== 3 ||
      !/^[0-7]{6}$/.test(metadata[0]) ||
      !/^[0-9a-f]{40,64}$/.test(metadata[1]) ||
      !/^[0-3]$/.test(metadata[2]) ||
      path.length === 0
    ) {
      throwUnreadableGitCheckout(label);
    }

    return {
      mode: metadata[0],
      objectId: metadata[1],
      path,
    };
  });
}

function parseHeadEntries(output, label) {
  return splitNullDelimitedPaths(output).map((record) => {
    const tabOffset = record.indexOf('\t');
    const metadata = tabOffset === -1 ? [] : record.slice(0, tabOffset).split(' ');
    const path = tabOffset === -1 ? '' : record.slice(tabOffset + 1);

    if (
      metadata.length !== 3 ||
      !/^[0-7]{6}$/.test(metadata[0]) ||
      metadata[1] !== 'blob' ||
      !/^[0-9a-f]{40,64}$/.test(metadata[2]) ||
      path.length === 0
    ) {
      throwUnreadableGitCheckout(label);
    }

    return {
      mode: metadata[0],
      objectId: metadata[2],
      path,
    };
  });
}

function assertTrackedPathLimits(entries, context) {
  if (entries.length > context.limits.trackedEntryLimit) {
    throwTrackedPathLimits(context.label);
  }

  let totalPathBytes = 0;

  for (const entry of entries) {
    totalPathBytes += Buffer.byteLength(entry.path);

    if (totalPathBytes > context.limits.trackedPathByteLimit) {
      throwTrackedPathLimits(context.label);
    }
  }
}

function readTrackedEntries(repositoryRoot, context) {
  const { label } = context;
  const indexEntries = parseIndexEntries(
    runGit(repositoryRoot, ['ls-files', '--cached', '--stage', '-z'], context, undefined, true),
    label,
  );
  assertTrackedPathLimits(indexEntries, context);
  let submoduleCount = 0;

  for (const entry of indexEntries) {
    if (entry.mode === '160000') {
      submoduleCount += 1;

      if (submoduleCount > 100) {
        break;
      }
    }
  }

  if (submoduleCount > 0) {
    throw new Error(
      `${label} has ${formatBoundedCount(submoduleCount, 'submodule entry', 'submodule entries')}.`,
    );
  }

  const headEntries = parseHeadEntries(
    runGit(repositoryRoot, ['ls-tree', '-r', '-z', 'HEAD'], context, undefined, true),
    label,
  );
  assertTrackedPathLimits(headEntries, context);
  const objectIds = [...new Set([...indexEntries, ...headEntries].map((entry) => entry.objectId))];

  if (objectIds.length > 0) {
    const output = runGit(
      repositoryRoot,
      ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
      context,
      `${objectIds.join('\n')}\n`,
    );
    const records = output.trimEnd().split('\n');

    if (
      records.length !== objectIds.length ||
      records.some((record, index) => record !== `${objectIds[index]} blob`)
    ) {
      throwUnreadableGitCheckout(label);
    }
  }

  return {
    indexPaths: indexEntries.map((entry) => entry.path),
    headPaths: headEntries.map((entry) => entry.path),
  };
}

function countTrackedFilterAttributes(repositoryRoot, context, trackedEntries) {
  const activePaths = new Set();
  collectTrackedFilterAttributes(
    repositoryRoot,
    context,
    trackedEntries.indexPaths,
    ['check-attr', '--cached', '-z', 'filter', '--stdin'],
    activePaths,
  );

  if (activePaths.size <= 100) {
    collectTrackedFilterAttributes(
      repositoryRoot,
      context,
      trackedEntries.headPaths,
      ['check-attr', '-z', 'filter', '--stdin'],
      activePaths,
    );
  }

  return activePaths.size;
}

function assertNoTrackedFilterAttributes(repositoryRoot, context, trackedEntries) {
  const count = countTrackedFilterAttributes(repositoryRoot, context, trackedEntries);

  if (count > 0) {
    throw new Error(
      `${context.label} has ${formatBoundedCount(
        count,
        'tracked entry with an active filter attribute',
        'tracked entries with active filter attributes',
      )}.`,
    );
  }
}

function assertCleanCheckout(repositoryRoot, context) {
  const summary = summarizeGitStatus(readGitStatus(repositoryRoot, context));

  if (summary.staged !== 0 || summary.unstaged !== 0 || summary.untracked !== 0) {
    throw new Error(`${context.label} is dirty (${formatDirtySummary(summary)}).`);
  }

  return summary;
}

function assertCleanPhase1CheckoutsWithLimits(checkoutRoots, limits) {
  const normalized = normalizeCheckoutRoots(checkoutRoots);
  const { keys, roots } = normalized;
  const summaries = {};

  for (const key of keys) {
    const label = `${key} checkout`;
    const context = createRepositoryVerificationContext(label, limits);
    assertNoLocalExcludeRules(roots[key], context);
    assertNoLocalAttributeRules(roots[key], context);
    assertNoReplacementRefs(roots[key], context);
    assertNoHiddenIndexEntries(roots[key], context);
    const trackedEntries = readTrackedEntries(roots[key], context);
    assertNoTrackedFilterAttributes(roots[key], context, trackedEntries);
    summaries[key] = assertCleanCheckout(roots[key], context);
  }

  return summaries;
}

export function assertCleanPhase1Checkouts(checkoutRoots) {
  return assertCleanPhase1CheckoutsWithLimits(checkoutRoots, defaultVerificationLimits);
}

export function assertCleanPhase1Checkout(repositoryRoot, label = 'checkout') {
  const root = requirePathString(repositoryRoot, `${label} root`);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`${label} root must be a directory.`);
  }
  const context = createRepositoryVerificationContext(label, defaultVerificationLimits);
  assertNoLocalExcludeRules(root, context);
  assertNoLocalAttributeRules(root, context);
  assertNoReplacementRefs(root, context);
  assertNoHiddenIndexEntries(root, context);
  const trackedEntries = readTrackedEntries(root, context);
  assertNoTrackedFilterAttributes(root, context, trackedEntries);
  return assertCleanCheckout(root, context);
}

export function readPhase1CheckoutIdentity(repositoryRoot, label = 'checkout') {
  const root = requirePathString(repositoryRoot, `${label} root`);
  const context = createRepositoryVerificationContext(label, defaultVerificationLimits);
  const revision = runGit(root, ['rev-parse', 'HEAD'], context).trim();
  const tree = runGit(root, ['rev-parse', 'HEAD^{tree}'], context).trim();
  if (!revisionPattern.test(revision) || !revisionPattern.test(tree)) {
    throw new Error(`${label} does not have a canonical commit and tree identity.`);
  }
  return Object.freeze({ revision, tree });
}

function requireLockedRevision(lock, key) {
  const lockData = requireRecord(lock, 'Phase 1 conformance lock');
  const entry = requireRecord(lockData[key], `Phase 1 conformance lock ${key} entry`);

  if (typeof entry.revision !== 'string' || !revisionPattern.test(entry.revision)) {
    throw new Error(`Phase 1 conformance lock ${key} revision is invalid.`);
  }

  return entry.revision;
}

function assertPhase1CheckoutHeadsWithLimits(lock, checkoutRoots, limits) {
  const normalized = normalizeCheckoutRoots(checkoutRoots);
  const { keys, roots } = normalized;
  const revisions = {};

  for (const key of keys) {
    const expectedRevision = requireLockedRevision(lock, key);
    const label = `${key} checkout`;
    const context = createRepositoryVerificationContext(label, limits);
    assertNoLocalExcludeRules(roots[key], context);
    assertNoLocalAttributeRules(roots[key], context);
    assertNoReplacementRefs(roots[key], context);
    assertNoHiddenIndexEntries(roots[key], context);
    const trackedEntries = readTrackedEntries(roots[key], context);
    assertNoTrackedFilterAttributes(roots[key], context, trackedEntries);
    assertCleanCheckout(roots[key], context);
    const actualRevision = runGit(roots[key], ['rev-parse', 'HEAD'], context).trim();

    if (actualRevision !== expectedRevision) {
      throw new Error(
        `${key} checkout HEAD ${actualRevision} does not match expected ${expectedRevision}.`,
      );
    }

    revisions[key] = actualRevision;
  }

  return revisions;
}

export function assertPhase1CheckoutHeads(lock, checkoutRoots) {
  return assertPhase1CheckoutHeadsWithLimits(lock, checkoutRoots, defaultVerificationLimits);
}

function createTestVerificationLimits(options) {
  const overrides =
    options !== null && typeof options === 'object' && !Array.isArray(options)
      ? options.limits
      : undefined;
  const limits = {
    ...defaultVerificationLimits,
    ...(overrides ?? {}),
  };

  if (
    !Number.isSafeInteger(limits.repositoryDeadlineMs) ||
    limits.repositoryDeadlineMs <= 0 ||
    !Number.isSafeInteger(limits.trackedEntryLimit) ||
    limits.trackedEntryLimit < 0 ||
    !Number.isSafeInteger(limits.trackedPathByteLimit) ||
    limits.trackedPathByteLimit < 0
  ) {
    throw new Error('Phase 1 conformance test limits are invalid.');
  }

  return Object.freeze(limits);
}

export const phase1ConformanceTestOnly = Object.freeze({
  verificationLimits: defaultVerificationLimits,
  assertCleanPhase1Checkouts(checkoutRoots, options) {
    return assertCleanPhase1CheckoutsWithLimits(
      checkoutRoots,
      createTestVerificationLimits(options),
    );
  },
  assertPhase1CheckoutHeads(lock, checkoutRoots, options) {
    return assertPhase1CheckoutHeadsWithLimits(
      lock,
      checkoutRoots,
      createTestVerificationLimits(options),
    );
  },
});
