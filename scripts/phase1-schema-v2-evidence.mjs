import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { registerHooks } from 'node:module';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { validatePhase1SanitizedReport } from './phase1-artifact-secret-scan.mjs';
import { createGitEnvironment } from './phase1-conformance-lock.mjs';

export const PHASE1_SCHEMA_V2_HARNESS_VERSION = '2.0.0';

export const CANONICAL_PLATFORM_ENVIRONMENTS = Object.freeze({
  'darwin-arm64': Object.freeze({
    os: 'darwin',
    arch: 'arm64',
    nativeCustody: 'macos-keychain',
    covenIdentity: 'unix-peer-credentials',
  }),
  'linux-x64': Object.freeze({
    os: 'linux',
    arch: 'x64',
    nativeCustody: 'linux-keyring',
    covenIdentity: 'unix-peer-credentials',
  }),
  'win32-x64': Object.freeze({
    os: 'win32',
    arch: 'x64',
    nativeCustody: 'windows-credential-manager',
    covenIdentity: 'windows-named-pipe-client-identity',
  }),
});

const SDK_PACKAGE_DIGEST_KEYS = Object.freeze(['sdk-core', 'sdk-cave', 'sdk-coven', 'sdk-root']);
const ISOLATION_ROOT_IDS = Object.freeze([
  'cave-home',
  'coven-home',
  'consumer-home',
  'native-credential-store',
]);
const OPERATOR_STATE_IDS = Object.freeze([
  'cave-home',
  'coven-home',
  'native-credential-store',
  'projects',
]);
const gitOidPattern = /^[0-9a-f]{40}$/u;
const sha256Pattern = /^[0-9a-f]{64}$/u;
const uuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const opaqueIdPattern = /^[0-9a-f]{32}$/u;
const MAXIMUM_EVIDENCE_FILE_BYTES = 64 * 1024 * 1024;
const EVIDENCE_READ_CHUNK_BYTES = 64 * 1024;
const MAXIMUM_VALIDATOR_MODULE_GRAPH_BYTES = 64 * 1024 * 1024;
const MAXIMUM_VALIDATOR_MODULE_LIST_BYTES = 4 * 1024 * 1024;
const validatorModulePathPattern = /^scripts\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.mjs$/u;
const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
const validatorModuleSnapshots = new WeakMap();

function requireRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function equalJson(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sameFileState(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function readBoundedDescriptor(descriptor, openedStats, label) {
  if (openedStats.size > BigInt(MAXIMUM_EVIDENCE_FILE_BYTES)) {
    throw new Error(`${label} exceeds the evidence file size limit.`);
  }
  const expectedSize = Number(openedStats.size);
  const buffer = Buffer.allocUnsafe(expectedSize + 1);
  let total = 0;
  while (total < buffer.length) {
    const bytesRead = readSync(
      descriptor,
      buffer,
      total,
      Math.min(EVIDENCE_READ_CHUNK_BYTES, buffer.length - total),
      null,
    );
    if (bytesRead === 0) {
      break;
    }
    total += bytesRead;
  }
  if (total !== expectedSize) {
    throw new Error(`${label} changed while it was being read.`);
  }
  return buffer.subarray(0, total);
}

export function readConsistentEvidenceFile(root, relativePath, label) {
  const path = resolve(root, relativePath);
  const rootPath = realpathSync(root);
  const pathStats = lstatSync(path, { bigint: true });
  const realPath = realpathSync(path);
  const offset = relative(rootPath, realPath);
  if (
    pathStats.isSymbolicLink() ||
    !pathStats.isFile() ||
    offset === '..' ||
    offset.startsWith(`..${sep}`) ||
    isAbsolute(offset)
  ) {
    throw new Error(`${label} must be a regular file inside the validator checkout.`);
  }

  let descriptor;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const openedStats = fstatSync(descriptor, { bigint: true });
    if (!openedStats.isFile()) {
      throw new Error(`${label} must be a regular file inside the validator checkout.`);
    }
    if (openedStats.dev !== pathStats.dev || openedStats.ino !== pathStats.ino) {
      throw new Error(`${label} changed while it was being read.`);
    }

    const bytes = readBoundedDescriptor(descriptor, openedStats, label);
    const completedStats = fstatSync(descriptor, { bigint: true });
    let completedPathStats;
    let completedRealPath;
    try {
      completedPathStats = lstatSync(path, { bigint: true });
      completedRealPath = realpathSync(path);
    } catch {
      throw new Error(`${label} changed while it was being read.`);
    }
    if (
      !sameFileState(openedStats, completedStats) ||
      completedPathStats.isSymbolicLink() ||
      !completedPathStats.isFile() ||
      completedPathStats.dev !== completedStats.dev ||
      completedPathStats.ino !== completedStats.ino ||
      completedRealPath !== realPath
    ) {
      throw new Error(`${label} changed while it was being read.`);
    }

    return {
      bytes,
      path,
      metadata: {
        path: relativePath,
        size: bytes.byteLength,
        sha256: sha256(bytes),
      },
    };
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function readCommittedValidatorModules(validatorRoot, identity) {
  const treeEntries = execFileSync(
    'git',
    ['-C', validatorRoot, 'ls-tree', '-r', '-z', '-l', identity.commit, '--', 'scripts'],
    {
      env: createGitEnvironment(process.env),
      maxBuffer: MAXIMUM_VALIDATOR_MODULE_LIST_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      killSignal: 'SIGKILL',
    },
  )
    .toString('utf8')
    .split('\0')
    .filter((entry) => entry.length > 0);
  const modules = new Map();
  let totalSize = 0;

  for (const treeEntry of treeEntries) {
    const match = /^(100644|100755) blob ([0-9a-f]{40}) +([0-9]+)\t(.+)$/u.exec(treeEntry);
    if (match === null) {
      continue;
    }
    const [, , objectId, sizeText, path] = match;
    if (!path.endsWith('.mjs')) {
      continue;
    }
    if (!validatorModulePathPattern.test(path)) {
      throw new Error(`SDK validator module path is unsafe: ${path}`);
    }
    const size = Number(sizeText);
    if (
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > MAXIMUM_EVIDENCE_FILE_BYTES ||
      totalSize + size > MAXIMUM_VALIDATOR_MODULE_GRAPH_BYTES
    ) {
      throw new Error('SDK validator module graph exceeds the evidence size limit.');
    }
    const bytes = execFileSync('git', ['-C', validatorRoot, 'cat-file', 'blob', objectId], {
      env: createGitEnvironment(process.env),
      maxBuffer: size + 1,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      killSignal: 'SIGKILL',
    });
    if (bytes.byteLength !== size) {
      throw new Error(`Committed SDK validator module ${path} changed while it was read.`);
    }
    totalSize += size;
    modules.set(path, {
      bytes: Buffer.from(bytes),
      metadata: Object.freeze({
        path,
        size,
        sha256: sha256(bytes),
      }),
    });
  }

  for (const path of [
    'scripts/conformance-contract.mjs',
    'scripts/github-conformance-evidence.mjs',
  ]) {
    if (!modules.has(path)) {
      throw new Error(`Committed SDK validator module is missing: ${path}`);
    }
  }

  return modules;
}

export function createVerifiedValidatorModuleSnapshot(optionsValue) {
  const options = requireRecord(optionsValue, 'SDK validator module snapshot options');
  if (typeof options.validatorRoot !== 'string' || options.validatorRoot.length === 0) {
    throw new Error('SDK validator root must be a non-empty path.');
  }
  const expectedValue = requireRecord(options.validatorIdentity, 'Frozen SDK validator');
  if (
    expectedValue.repository !== 'OpenCoven/sdk' ||
    !gitOidPattern.test(expectedValue.commit ?? '') ||
    !gitOidPattern.test(expectedValue.tree ?? '')
  ) {
    throw new Error('Frozen SDK validator identity is invalid.');
  }

  const validatorRoot = realpathSync(resolve(options.validatorRoot));
  const identity = Object.freeze({
    repository: 'OpenCoven/sdk',
    commit: expectedValue.commit,
    tree: expectedValue.tree,
  });
  const actual = readGitIdentity(validatorRoot);
  if (actual.commit !== identity.commit) {
    throw new Error(`SDK validator commit ${actual.commit} does not match ${identity.commit}.`);
  }
  if (actual.tree !== identity.tree) {
    throw new Error(`SDK validator tree ${actual.tree} does not match ${identity.tree}.`);
  }

  const modules = readCommittedValidatorModules(validatorRoot, identity);
  const graphHash = createHash('sha256');
  for (const [path, module] of [...modules.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    graphHash.update(path, 'utf8');
    graphHash.update('\0');
    graphHash.update(module.bytes);
    graphHash.update('\0');
  }
  const graphSha256 = graphHash.digest('hex');
  const virtualRoot = new URL(
    `${
      pathToFileURL(
        resolve(
          validatorRoot,
          '.opencoven-verified-validator-modules',
          `${process.pid}-${identity.commit}-${identity.tree}-${graphSha256}`,
        ),
      ).href
    }/`,
  );
  const modulesByUrl = new Map(
    [...modules.entries()].map(([path, module]) => [new URL(path, virtualRoot).href, module]),
  );

  return Object.freeze({
    identity,
    graphSha256,
    metadata(path) {
      const module = modules.get(path);
      if (module === undefined) {
        throw new Error(`SDK validator module is not in the verified snapshot: ${path}`);
      }
      return module.metadata;
    },
    async importModule(path) {
      const module = modules.get(path);
      if (module === undefined) {
        throw new Error(`SDK validator module is not in the verified snapshot: ${path}`);
      }
      if (
        module.bytes.byteLength !== module.metadata.size ||
        sha256(module.bytes) !== module.metadata.sha256
      ) {
        throw new Error(`Verified SDK validator module bytes changed: ${path}`);
      }
      const entryUrl = new URL(path, virtualRoot).href;
      const hooks = registerHooks({
        resolve(specifier, context, nextResolve) {
          if (modulesByUrl.has(specifier)) {
            return { shortCircuit: true, url: specifier };
          }
          if (context.parentURL !== undefined && modulesByUrl.has(context.parentURL)) {
            if (specifier.startsWith('./') || specifier.startsWith('../')) {
              const resolvedUrl = new URL(specifier, context.parentURL).href;
              if (!modulesByUrl.has(resolvedUrl)) {
                throw new Error(
                  `SDK validator relative module is outside the verified snapshot: ${specifier}`,
                );
              }
              return { shortCircuit: true, url: resolvedUrl };
            }
            if (!specifier.startsWith('node:')) {
              throw new Error(`SDK validator module import is not allowed: ${specifier}`);
            }
          }
          return nextResolve(specifier, context);
        },
        load(url, context, nextLoad) {
          const verifiedModule = modulesByUrl.get(url);
          if (verifiedModule !== undefined) {
            if (
              verifiedModule.bytes.byteLength !== verifiedModule.metadata.size ||
              sha256(verifiedModule.bytes) !== verifiedModule.metadata.sha256
            ) {
              throw new Error(`Verified SDK validator module bytes changed: ${url}`);
            }
            return {
              format: 'module',
              shortCircuit: true,
              source: Buffer.from(verifiedModule.bytes),
            };
          }
          return nextLoad(url, context);
        },
      });
      try {
        return await import(entryUrl);
      } finally {
        hooks.deregister();
      }
    },
  });
}

function metadataForExpectedFile(root, expected, label) {
  const file = readConsistentEvidenceFile(root, expected.path, label);
  assertMetadataMatches(
    file.metadata,
    {
      path: expected.path,
      size: expected.size,
      sha256: expected.sha256,
    },
    label,
  );
  return file.metadata;
}

export function assertSdkContractMatchesPhase1Lock(sdkContractValue, phase1LockValue) {
  const sdkContract = requireRecord(sdkContractValue, 'SDK evidence contract');
  const phase1Lock = requireRecord(phase1LockValue, 'Phase 1 conformance lock');
  const frozenLock = requireRecord(sdkContract.frozenLock, 'Frozen SDK lock');
  if (phase1Lock.version !== 3 && phase1Lock.version !== 5) {
    throw new Error('Schema-v2 evidence requires Phase 1 lock version 3 or 5.');
  }
  const expected = {
    sdk: {
      repository: frozenLock.candidate.repository,
      revision: frozenLock.candidate.commit,
      tree: frozenLock.candidate.tree,
    },
    cave: {
      repository: frozenLock.sources.cave.repository,
      revision: frozenLock.sources.cave.commit,
      tree: frozenLock.sources.cave.tree,
    },
    coven: {
      repository: frozenLock.sources.coven.repository,
      revision: frozenLock.sources.coven.commit,
      tree: frozenLock.sources.coven.tree,
    },
    chat: {
      repository: frozenLock.sources.chat.repository,
      revision: frozenLock.sources.chat.commit,
      tree: frozenLock.sources.chat.tree,
    },
  };
  for (const key of ['sdk', 'cave', 'coven', 'chat']) {
    const source = requireRecord(phase1Lock[key], `Phase 1 ${key} pin`);
    if (
      source.repository !== expected[key].repository ||
      source.revision !== expected[key].revision ||
      (source.tree !== undefined && source.tree !== expected[key].tree)
    ) {
      throw new Error(`Phase 1 ${key} pin does not match the SDK frozen contract.`);
    }
  }
  return phase1Lock;
}

export function collectFrozenEvidenceArtifacts({ roots, sdkContract }) {
  const lock = requireRecord(sdkContract.frozenLock, 'Frozen SDK lock');
  const candidate = requireRecord(lock.candidate, 'Frozen SDK candidate');
  const sources = requireRecord(lock.sources, 'Frozen sources');
  const chat = requireRecord(sources.chat, 'Frozen Chat source');
  const cave = requireRecord(sources.cave, 'Frozen Cave source');
  const releaseManifest = candidate.releaseManifest;
  const sdkPackages = candidate.sdkPackages.map((entry) => {
    const metadata = metadataForExpectedFile(
      roots.chatRoot,
      {
        path: entry.vendorPath,
        size: entry.size,
        sha256: entry.sha256,
      },
      `Frozen ${entry.packageName} tarball`,
    );
    return {
      packageName: entry.packageName,
      version: entry.version,
      releaseFile: entry.releaseFile,
      vendorPath: entry.vendorPath,
      size: metadata.size,
      sha256: metadata.sha256,
    };
  });
  const manifestBytes = `${JSON.stringify(
    {
      schemaVersion: 1,
      version: releaseManifest.version,
      packages: sdkPackages.map((entry) => ({
        name: entry.packageName,
        version: entry.version,
        file: entry.releaseFile,
        size: entry.size,
        sha256: entry.sha256,
      })),
    },
    null,
    2,
  )}\n`;
  assertMetadataMatches(
    {
      file: 'release-manifest.json',
      version: releaseManifest.version,
      size: Buffer.byteLength(manifestBytes, 'utf8'),
      sha256: sha256(manifestBytes),
    },
    releaseManifest,
    'SDK release manifest',
  );

  return {
    frozenLock: {
      path: 'conformance/client-v1-cross-repository-lock.json',
      size: Buffer.byteLength(sdkContract.frozenLockText, 'utf8'),
      sha256: sha256(sdkContract.frozenLockText),
    },
    assertionRegistry: {
      path: lock.assertionRegistry.path,
      size: Buffer.byteLength(sdkContract.registryText, 'utf8'),
      sha256: sha256(sdkContract.registryText),
    },
    releaseManifest: structuredClone(releaseManifest),
    sdkPackages,
    candidateCaveFiles: candidate.cavePackageFiles.map((entry) =>
      metadataForExpectedFile(roots.sdkRoot, entry, `Candidate SDK file ${entry.path}`),
    ),
    caveAuthorityFiles: cave.files.map((entry) =>
      metadataForExpectedFile(roots.caveRoot, entry, `Cave authority file ${entry.path}`),
    ),
    consumerLock: metadataForExpectedFile(roots.chatRoot, chat.consumerLock, 'Chat consumer lock'),
    chatVendorFiles: chat.vendorFiles.map((entry) => {
      const metadata = metadataForExpectedFile(
        roots.chatRoot,
        entry,
        `Chat vendor file ${entry.path}`,
      );
      return {
        packageName: entry.packageName,
        ...metadata,
      };
    }),
  };
}

export async function verifySchemaV2ProducerCheckout({
  producerRoot,
  producerIdentity,
  sdkContract,
}) {
  const producer = sdkContract.contract.assertEvidenceProducerCompatibility(sdkContract.frozenLock);
  const identity = {
    repository: 'OpenCoven/chat',
    commit: producerIdentity.revision,
    tree: producerIdentity.tree,
  };
  assertIdentityMatches(identity, producer, 'Schema-v2 producer');
  const packageManifest = readConsistentEvidenceFile(
    producerRoot,
    'package.json',
    'Schema-v2 producer package manifest',
  ).metadata;
  const harness = readConsistentEvidenceFile(
    producerRoot,
    producer.harness.path,
    'Schema-v2 producer harness',
  ).metadata;
  const workflow = readConsistentEvidenceFile(
    producerRoot,
    producer.workflow.path,
    'Schema-v2 protected workflow',
  );
  assertMetadataMatches(packageManifest, producer.packageManifest, 'Producer package manifest');
  assertMetadataMatches(
    { ...harness, version: producer.harness.version },
    producer.harness,
    'Producer harness',
  );
  assertMetadataMatches(
    workflow.metadata,
    {
      path: producer.workflow.path,
      size: producer.workflow.size,
      sha256: producer.workflow.sha256,
    },
    'Producer workflow',
  );
  const validatorModules = validatorModuleSnapshots.get(sdkContract);
  if (validatorModules === undefined) {
    throw new Error('SDK validator module snapshot is unavailable.');
  }
  const githubContract = await validatorModules.importModule(
    'scripts/github-conformance-evidence.mjs',
  );
  githubContract.verifyProtectedWorkflow(
    workflow.bytes.toString('utf8'),
    producer,
    sdkContract.frozenLock.toolchain,
  );
  return {
    identity,
    harness: {
      name: producer.harness.path,
      version: producer.harness.version,
      repository: producer.repository,
      commit: identity.commit,
      tree: identity.tree,
    },
  };
}

function readGitIdentity(root) {
  const run = (revision) =>
    execFileSync('git', ['-C', root, 'rev-parse', revision], {
      encoding: 'utf8',
      env: createGitEnvironment(process.env),
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      killSignal: 'SIGKILL',
    }).trim();
  return {
    repository: 'OpenCoven/sdk',
    commit: run('HEAD'),
    tree: run('HEAD^{tree}'),
  };
}

export async function loadSdkEvidenceContract(optionsValue) {
  const options = requireRecord(optionsValue, 'SDK validator options');
  if (typeof options.validatorRoot !== 'string' || options.validatorRoot.length === 0) {
    throw new Error('SDK validator root must be a non-empty path.');
  }
  const expectedValue = requireRecord(options.validatorIdentity, 'Frozen SDK validator');
  if (
    expectedValue.repository !== 'OpenCoven/sdk' ||
    !gitOidPattern.test(expectedValue.commit ?? '') ||
    (expectedValue.tree !== undefined && !gitOidPattern.test(expectedValue.tree))
  ) {
    throw new Error('Frozen SDK validator identity is invalid.');
  }
  const expected = {
    repository: 'OpenCoven/sdk',
    commit: expectedValue.commit,
    tree: expectedValue.tree,
  };
  const validatorRoot = realpathSync(resolve(options.validatorRoot));
  const actual = readGitIdentity(validatorRoot);
  if (actual.commit !== expected.commit) {
    throw new Error(`SDK validator commit ${actual.commit} does not match ${expected.commit}.`);
  }
  if (expected.tree !== undefined && actual.tree !== expected.tree) {
    throw new Error(`SDK validator tree ${actual.tree} does not match ${expected.tree}.`);
  }

  const validatorModules = createVerifiedValidatorModuleSnapshot({
    validatorRoot,
    validatorIdentity: actual,
  });
  const schemaFile = readConsistentEvidenceFile(
    validatorRoot,
    'conformance/client-v1-cross-repository-evidence.schema.json',
    'SDK evidence schema',
  );
  const registryFile = readConsistentEvidenceFile(
    validatorRoot,
    'conformance/client-v1-cross-repository-assertions.json',
    'SDK assertion registry',
  );
  const lockFile = readConsistentEvidenceFile(
    validatorRoot,
    'conformance/client-v1-cross-repository-lock.json',
    'SDK frozen conformance lock',
  );
  const contract = await validatorModules.importModule('scripts/conformance-contract.mjs');
  const frozenLockText = lockFile.bytes.toString('utf8');
  const schemaText = schemaFile.bytes.toString('utf8');
  const registryText = registryFile.bytes.toString('utf8');
  const frozenLock = contract.parseFrozenConformanceLock(
    frozenLockText,
    'SDK frozen conformance lock',
  );
  const bindings = contract.validateFrozenConformanceBindings(frozenLock, schemaText, registryText);

  const sdkContract = Object.freeze({
    validatorRoot,
    contract,
    frozenLock: bindings.lock,
    frozenLockText,
    registry: bindings.registry,
    registryText,
    schema: bindings.schema,
    schemaText,
    validator: {
      ...actual,
      contract: validatorModules.metadata('scripts/conformance-contract.mjs'),
      schema: schemaFile.metadata,
    },
    validatorIdentity: actual,
  });
  validatorModuleSnapshots.set(sdkContract, validatorModules);
  return sdkContract;
}

function requireIdentity(value, label, repository) {
  const identity = requireRecord(value, label);
  if (
    identity.repository !== repository ||
    !gitOidPattern.test(identity.commit ?? '') ||
    !gitOidPattern.test(identity.tree ?? '')
  ) {
    throw new Error(`${label} does not match the required repository identity.`);
  }
  return {
    repository: identity.repository,
    commit: identity.commit,
    tree: identity.tree,
  };
}

function assertIdentityMatches(value, expected, label) {
  if (
    !equalJson(value, {
      repository: expected.repository,
      commit: expected.commit,
      tree: expected.tree,
    })
  ) {
    throw new Error(`${label} provenance does not match the frozen contract.`);
  }
}

function assertMetadataMatches(value, expected, label) {
  if (!equalJson(value, expected)) {
    throw new Error(`${label} metadata does not match the frozen contract.`);
  }
}

function validateTiming(value) {
  const timing = requireRecord(value, 'Schema-v2 timing');
  const startedAt = new Date(timing.startedAt);
  const completedAt = new Date(timing.completedAt);
  if (
    Number.isNaN(startedAt.valueOf()) ||
    Number.isNaN(completedAt.valueOf()) ||
    startedAt.toISOString() !== timing.startedAt ||
    completedAt.toISOString() !== timing.completedAt
  ) {
    throw new Error('Schema-v2 timing must use canonical UTC millisecond timestamps.');
  }
  const durationMs = completedAt.valueOf() - startedAt.valueOf();
  if (durationMs < 0 || durationMs > 86_400_000) {
    throw new Error('Schema-v2 timing is outside the allowed interval.');
  }
  return {
    startedAt: timing.startedAt,
    completedAt: timing.completedAt,
    durationMs,
  };
}

function validatePrimaryReport(report, platform) {
  validatePhase1SanitizedReport(report);
  if (
    report.status !== 'passed' ||
    report.summary.failed !== 0 ||
    report.summary.blocked !== 0 ||
    report.summary.skipped !== 0 ||
    report.assertions.some((entry) => entry.status !== 'passed')
  ) {
    throw new Error('Schema-v2 evidence requires every primary Phase 1 assertion to pass.');
  }
  const expected = CANONICAL_PLATFORM_ENVIRONMENTS[platform];
  if (expected === undefined) {
    throw new Error(`Unsupported schema-v2 platform ${String(platform)}.`);
  }
  if (report.platform.os !== expected.os || report.platform.arch !== expected.arch) {
    throw new Error('Primary Phase 1 platform does not match the requested schema-v2 platform.');
  }
  return report;
}

function validateEnvironment(environmentValue, platform, toolchain) {
  const environment = requireRecord(environmentValue, 'Verified environment');
  const expected = CANONICAL_PLATFORM_ENVIRONMENTS[platform];
  const nativeCustody = requireRecord(environment.nativeCustody, 'Verified native custody');
  const covenIdentity = requireRecord(environment.covenIdentity, 'Verified Coven identity');
  if (
    environment.os !== expected.os ||
    environment.arch !== expected.arch ||
    environment.nodeVersion !== toolchain.nodeVersion ||
    environment.pnpmVersion !== toolchain.pnpmVersion ||
    environment.rustVersion !== toolchain.rustVersion ||
    environment.tauriVersion !== toolchain.tauriVersion ||
    nativeCustody.backend !== expected.nativeCustody ||
    nativeCustody.available !== true ||
    covenIdentity.backend !== expected.covenIdentity ||
    covenIdentity.available !== true
  ) {
    throw new Error(`Verified environment does not match ${platform}.`);
  }
  return structuredClone(environment);
}

function validateIsolation(value) {
  const isolation = requireRecord(value, 'Verified isolation');
  if (
    isolation.strategy !== 'process-owned-temporary-roots' ||
    isolation.network !== 'loopback-only' ||
    isolation.sourceCheckoutDependency !== false ||
    isolation.workspaceLinkDependency !== false ||
    isolation.retainedPrivatePaths !== false ||
    isolation.retainedSocketHandles !== false
  ) {
    throw new Error('Verified isolation metadata is incomplete.');
  }
  if (!Array.isArray(isolation.roots) || isolation.roots.length !== ISOLATION_ROOT_IDS.length) {
    throw new Error('Verified isolation roots are incomplete.');
  }
  const opaqueIds = new Set();
  const roots = isolation.roots.map((entry, index) => {
    const root = requireRecord(entry, `Verified isolation root ${index}`);
    if (
      root.id !== ISOLATION_ROOT_IDS[index] ||
      !opaqueIdPattern.test(root.opaqueId ?? '') ||
      root.ownershipVerified !== true ||
      root.removedAfterRun !== true ||
      opaqueIds.has(root.opaqueId)
    ) {
      throw new Error('Verified isolation roots are invalid.');
    }
    opaqueIds.add(root.opaqueId);
    return structuredClone(root);
  });
  if (
    !Array.isArray(isolation.operatorState) ||
    isolation.operatorState.length !== OPERATOR_STATE_IDS.length
  ) {
    throw new Error('Verified operator state is incomplete.');
  }
  const operatorState = isolation.operatorState.map((entry, index) => {
    const state = requireRecord(entry, `Verified operator state ${index}`);
    if (
      state.id !== OPERATOR_STATE_IDS[index] ||
      !sha256Pattern.test(state.beforeSha256 ?? '') ||
      !sha256Pattern.test(state.afterSha256 ?? '') ||
      state.beforeSha256 !== state.afterSha256
    ) {
      throw new Error('Verified operator state changed or is invalid.');
    }
    return structuredClone(state);
  });
  return {
    strategy: isolation.strategy,
    network: isolation.network,
    sourceCheckoutDependency: false,
    workspaceLinkDependency: false,
    retainedPrivatePaths: false,
    retainedSocketHandles: false,
    roots,
    operatorState,
  };
}

function validateCaveRecord(caveRecordValue, registry, expected) {
  const caveRecord = requireRecord(caveRecordValue, 'Cave evidence record');
  const expectedIds = registry.assertions.cave;
  if (
    caveRecord.platform !== expected.platform ||
    caveRecord.commit !== expected.commit ||
    caveRecord.caveVersion !== expected.releaseVersion ||
    caveRecord.nodeVersion !== expected.nodeVersion ||
    caveRecord.ranAt < expected.startedAt ||
    caveRecord.ranAt > expected.completedAt ||
    !Array.isArray(caveRecord.assertions) ||
    caveRecord.assertions.length !== expectedIds.length
  ) {
    throw new Error('Cave evidence record does not match the verified run.');
  }
  for (let index = 0; index < expectedIds.length; index += 1) {
    const assertion = requireRecord(caveRecord.assertions[index], `Cave assertion ${index}`);
    if (assertion.id !== expectedIds[index] || assertion.result !== 'pass') {
      throw new Error('Cave evidence record does not contain the complete passing registry.');
    }
  }
  return structuredClone(caveRecord);
}

function validateObservedAssertions(value, expectedIds, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  const expected = new Set(expectedIds);
  const observed = new Map();
  for (const entryValue of value) {
    const entry = requireRecord(entryValue, `${label} entry`);
    if (
      Object.keys(entry).length !== 3 ||
      !Object.hasOwn(entry, 'id') ||
      !Object.hasOwn(entry, 'result') ||
      !Object.hasOwn(entry, 'diagnosticId') ||
      typeof entry.id !== 'string' ||
      !expected.has(entry.id)
    ) {
      throw new Error(`${label} contains an unexpected result.`);
    }
    if (observed.has(entry.id)) {
      throw new Error(`${label} contains duplicate result ${entry.id}.`);
    }
    if (entry.result !== 'pass' || entry.diagnosticId !== 'phase1.assertion.passed') {
      throw new Error(`${label} ${entry.id} is not passing.`);
    }
    observed.set(entry.id, {
      id: entry.id,
      result: 'pass',
      diagnosticId: 'phase1.assertion.passed',
    });
  }
  const missing = expectedIds.filter((id) => !observed.has(id));
  if (missing.length > 0 || observed.size !== expectedIds.length) {
    throw new Error(`${label} is missing required results.`);
  }
  return expectedIds.map((id) => observed.get(id));
}

export function createObservedAssertionRecorder(expectedIdsValue, subject) {
  if (
    !Array.isArray(expectedIdsValue) ||
    expectedIdsValue.length === 0 ||
    expectedIdsValue.some((id) => typeof id !== 'string' || id.length === 0) ||
    new Set(expectedIdsValue).size !== expectedIdsValue.length ||
    typeof subject !== 'string' ||
    subject.length === 0
  ) {
    throw new Error('Observed assertion recorder requires exact expected IDs and a subject.');
  }
  const expectedIds = [...expectedIdsValue];
  const expected = new Set(expectedIds);
  const observed = new Map();
  return Object.freeze({
    pass(id) {
      if (!expected.has(id)) {
        throw new Error(`Observed ${subject} assertion ${id} is unexpected.`);
      }
      if (observed.has(id)) {
        throw new Error(`Observed ${subject} assertion ${id} is duplicate.`);
      }
      observed.set(id, {
        id,
        result: 'pass',
        diagnosticId: 'phase1.assertion.passed',
      });
    },
    complete() {
      const missing = expectedIds.filter((id) => !observed.has(id));
      if (missing.length > 0) {
        throw new Error(
          `Observed ${subject} assertions are missing required results: ${missing.join(',')}.`,
        );
      }
      return expectedIds.map((id) => observed.get(id));
    },
  });
}

function validateContractInput(value) {
  const sdkContract = requireRecord(value, 'SDK evidence contract');
  const contract = requireRecord(sdkContract.contract, 'SDK contract module');
  for (const name of [
    'assertEvidenceProducerCompatibility',
    'parsePlatformEvidence',
    'serializeCanonicalJson',
    'scanConformanceEvidence',
  ]) {
    if (typeof contract[name] !== 'function') {
      throw new Error(`SDK contract module is missing ${name}.`);
    }
  }
  if (
    typeof sdkContract.frozenLockText !== 'string' ||
    typeof sdkContract.registryText !== 'string'
  ) {
    throw new Error('SDK contract bytes are missing.');
  }
  return sdkContract;
}

export function buildSchemaV2PlatformEvidence(inputValue) {
  const input = requireRecord(inputValue, 'Schema-v2 adapter input');
  const sdkContract = validateContractInput(input.sdkContract);
  const lock = requireRecord(sdkContract.frozenLock, 'Frozen SDK lock');
  const registry = requireRecord(sdkContract.registry, 'Frozen assertion registry');
  const verified = requireRecord(input.verified, 'Verified evidence metadata');
  const platform = input.platform;
  const primaryReport = validatePrimaryReport(input.primaryReport, platform);
  const timing = validateTiming(input.timing);
  const producer = sdkContract.contract.assertEvidenceProducerCompatibility(lock);
  const candidate = requireIdentity(verified.candidate, 'Candidate SDK', 'OpenCoven/sdk');
  const cave = requireIdentity(verified.cave, 'Cave source', 'OpenCoven/coven-cave');
  const coven = requireIdentity(verified.coven, 'Coven source', 'OpenCoven/coven');
  const chat = requireIdentity(verified.chat, 'Chat source', 'OpenCoven/chat');
  const harness = requireRecord(verified.harness, 'Verified harness');
  const validator = requireRecord(verified.validator, 'Verified SDK validator');
  const expectedValidator = requireIdentity(
    sdkContract.validatorIdentity,
    'Frozen SDK validator',
    'OpenCoven/sdk',
  );
  const validatorIdentity = requireIdentity(validator, 'Verified SDK validator', 'OpenCoven/sdk');

  assertIdentityMatches(candidate, lock.candidate, 'Candidate SDK');
  assertIdentityMatches(cave, lock.sources.cave, 'Cave');
  assertIdentityMatches(coven, lock.sources.coven, 'Coven');
  assertIdentityMatches(chat, lock.sources.chat, 'Chat');
  assertIdentityMatches(validatorIdentity, expectedValidator, 'SDK validator');
  if (validatorIdentity.commit === candidate.commit || validatorIdentity.tree === candidate.tree) {
    throw new Error('SDK validator provenance must be distinct from the candidate.');
  }
  if (
    harness.name !== producer.harness.path ||
    harness.version !== producer.harness.version ||
    harness.repository !== producer.repository ||
    harness.commit !== producer.commit ||
    harness.tree !== producer.tree ||
    !uuidV4Pattern.test(harness.invocationId ?? '')
  ) {
    throw new Error('Verified harness provenance does not match the frozen producer.');
  }
  const expectedRevisions = {
    chat: chat.commit,
    sdk: candidate.commit,
    cave: cave.commit,
    coven: coven.commit,
  };
  if (!equalJson(primaryReport.revisions, expectedRevisions)) {
    throw new Error('Primary Phase 1 revisions do not match verified provenance.');
  }

  const expectedPackageDigests = Object.fromEntries(
    lock.candidate.sdkPackages.map((entry, index) => [
      SDK_PACKAGE_DIGEST_KEYS[index],
      entry.sha256,
    ]),
  );
  for (const [key, digest] of Object.entries(expectedPackageDigests)) {
    if (primaryReport.artifactDigests[key] !== digest) {
      throw new Error(`Primary Phase 1 artifact ${key} drifted from the frozen SDK package.`);
    }
  }

  const artifacts = requireRecord(verified.artifacts, 'Verified artifacts');
  const expectedLockMetadata = {
    path: 'conformance/client-v1-cross-repository-lock.json',
    size: Buffer.byteLength(sdkContract.frozenLockText, 'utf8'),
    sha256: sha256(sdkContract.frozenLockText),
  };
  const expectedRegistryMetadata = {
    path: lock.assertionRegistry.path,
    size: Buffer.byteLength(sdkContract.registryText, 'utf8'),
    sha256: sha256(sdkContract.registryText),
  };
  const expectedArtifacts = {
    frozenLock: expectedLockMetadata,
    assertionRegistry: expectedRegistryMetadata,
    releaseManifest: lock.candidate.releaseManifest,
    sdkPackages: lock.candidate.sdkPackages,
    candidateCaveFiles: lock.candidate.cavePackageFiles,
    caveAuthorityFiles: lock.sources.cave.files,
    consumerLock: lock.sources.chat.consumerLock,
    chatVendorFiles: lock.sources.chat.vendorFiles,
  };
  for (const [name, expected] of Object.entries(expectedArtifacts)) {
    assertMetadataMatches(artifacts[name], expected, name);
  }
  assertMetadataMatches(
    validator.schema,
    {
      path: lock.evidenceSchema.path,
      size: lock.evidenceSchema.size,
      sha256: lock.evidenceSchema.sha256,
    },
    'Validator schema',
  );
  const validatorContract = requireRecord(
    validator.contract,
    'Verified validator contract metadata',
  );
  if (
    validatorContract.path !== 'scripts/conformance-contract.mjs' ||
    !Number.isSafeInteger(validatorContract.size) ||
    validatorContract.size <= 0 ||
    !sha256Pattern.test(validatorContract.sha256 ?? '')
  ) {
    throw new Error('Verified validator contract metadata is invalid.');
  }

  const environment = validateEnvironment(verified.environment, platform, lock.toolchain);
  const isolation = validateIsolation(verified.isolation);
  const caveRecord = validateCaveRecord(input.caveRecord, registry, {
    platform,
    commit: cave.commit,
    releaseVersion: lock.sources.cave.releaseVersion,
    nodeVersion: environment.nodeVersion,
    startedAt: timing.startedAt,
    completedAt: timing.completedAt,
  });
  const chatIds = [
    ...registry.assertions.chat.common,
    ...registry.assertions.chat.platforms[platform],
  ];
  const observedAssertions = requireRecord(
    input.observedAssertions,
    'Observed schema-v2 assertions',
  );
  const sdkAssertions = validateObservedAssertions(
    observedAssertions.sdk,
    registry.assertions.sdk,
    'Observed SDK assertions',
  );
  const chatAssertions = validateObservedAssertions(
    observedAssertions.chat,
    chatIds,
    'Observed Chat assertions',
  );

  return {
    schemaVersion: 2,
    issue: 'OpenCoven/sdk#38',
    platform,
    timing,
    environment,
    releases: {
      cave: lock.sources.cave.releaseVersion,
      coven: lock.sources.coven.releaseVersion,
    },
    provenance: {
      candidate,
      validator: {
        ...validatorIdentity,
        contract: structuredClone(validatorContract),
        schema: structuredClone(validator.schema),
      },
      cave,
      coven,
      chat,
    },
    harness: structuredClone(harness),
    artifacts: structuredClone(artifacts),
    caveRecord,
    sdkAssertions,
    chatAssertions,
    coverage: {
      cave: true,
      coven: true,
      sdk: true,
      chat: true,
    },
    notCovered: structuredClone(registry.notCovered),
    isolation,
    scans: {
      redaction: {
        status: 'passed',
        scanner: lock.scanners.redaction.name,
        version: lock.scanners.redaction.version,
      },
      retainedEvidence: {
        status: 'passed',
        scanner: lock.scanners.retainedEvidence.name,
        version: lock.scanners.retainedEvidence.version,
      },
    },
  };
}

export function serializeValidatedSchemaV2PlatformEvidence(evidence, optionsValue) {
  const options = requireRecord(optionsValue, 'Schema-v2 serialization options');
  const contract = requireRecord(options.contract, 'SDK contract module');
  if (
    typeof contract.serializeCanonicalJson !== 'function' ||
    typeof contract.parsePlatformEvidence !== 'function' ||
    typeof contract.scanConformanceEvidence !== 'function'
  ) {
    throw new Error('SDK contract module does not expose the required validators.');
  }
  contract.scanConformanceEvidence(evidence);
  const text = contract.serializeCanonicalJson(evidence);
  const parsed = contract.parsePlatformEvidence(
    text,
    'Chat schema-v2 platform evidence',
    options.schema,
  );
  const reparsed = contract.serializeCanonicalJson(parsed);
  if (reparsed !== text) {
    throw new Error('SDK validator did not preserve canonical platform evidence bytes.');
  }
  return text;
}
