import { createHash } from 'node:crypto';

const canonicalPlatforms = Object.freeze(['darwin-arm64', 'linux-x64', 'win32-x64']);
const canonicalTarballs = Object.freeze([
  '@opencoven/sdk-core',
  '@opencoven/cave-client',
  '@opencoven/coven-client',
  '@opencoven/sdk',
]);
const isolationRoots = Object.freeze([
  'cave-home',
  'coven-home',
  'consumer-home',
  'native-credential-store',
]);
const operatorStateIds = Object.freeze([
  'cave-home',
  'coven-home',
  'native-credential-store',
  'projects',
]);
const notCovered = Object.freeze([
  {
    scopeId: 'cross-process-pairing',
    diagnosticId: 'phase1.scope.cross-process-pairing.not-covered',
  },
  { scopeId: 'oauth-ui', diagnosticId: 'phase1.scope.oauth-ui.not-covered' },
  { scopeId: 'remote-peer', diagnosticId: 'phase1.scope.remote-peer.not-covered' },
  { scopeId: 'write-apis', diagnosticId: 'phase1.scope.write-apis.not-covered' },
]);
const identifierPattern = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u;
const digestPattern = /^[0-9a-f]{64}$/u;

function requireRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function requireExactKeys(value, expectedKeys, label) {
  const keys = Object.keys(value);
  if (
    keys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} must contain exactly ${expectedKeys.join(', ')}.`);
  }
}

function validateIds(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  const seen = new Set();
  return value.map((id) => {
    if (typeof id !== 'string' || !identifierPattern.test(id)) {
      throw new Error(`${label} contains an invalid assertion ID.`);
    }
    if (seen.has(id)) {
      throw new Error(`${label} contains duplicate assertion ID ${id}.`);
    }
    seen.add(id);
    return id;
  });
}

export function canonicalPlatformId(os = process.platform, arch = process.arch) {
  const platform = `${os}-${arch}`;
  if (!canonicalPlatforms.includes(platform)) {
    throw new Error(`unsupported platform ${platform}`);
  }
  return platform;
}

export function validateObservedToolVersions({ nodeVersion, pnpmVersion, rustcVersion }) {
  if (nodeVersion !== 'v24.18.1') {
    throw new Error('Phase 1 conformance requires Node 24.18.1.');
  }
  if (pnpmVersion !== '10.34.0') {
    throw new Error('Phase 1 conformance requires pnpm 10.34.0.');
  }
  const rustMatch = /^rustc (1\.95\.0)(?:\s|$)/u.exec(rustcVersion);
  if (rustMatch === null) {
    throw new Error('Phase 1 conformance requires Rust 1.95.0.');
  }
  return Object.freeze({
    nodeVersion,
    packageManagerVersion: `pnpm@${pnpmVersion}`,
    rustVersion: rustMatch[1],
  });
}

export function parseLockedAssertionRegistry(text, expectedDigest, label) {
  const actualDigest = createHash('sha256').update(text).digest('hex');
  if (actualDigest !== expectedDigest) {
    throw new Error(`${label} digest does not match the locked SDK registry.`);
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label} must contain valid JSON.`);
  }
  const registry = requireRecord(value, label);
  requireExactKeys(registry, ['schemaVersion', 'cave', 'sdk', 'chat'], label);
  if (registry.schemaVersion !== 1) {
    throw new Error(`${label} schemaVersion must be 1.`);
  }
  const cave = requireRecord(registry.cave, `${label} cave`);
  requireExactKeys(
    cave,
    ['engine', 'requireIncludeTtl', 'requireAuthorityTakeover'],
    `${label} cave`,
  );
  if (
    cave.engine !== 'scripts/client-v1-conformance.mjs' ||
    cave.requireIncludeTtl !== true ||
    cave.requireAuthorityTakeover !== true
  ) {
    throw new Error(`${label} Cave authority configuration is invalid.`);
  }
  const chat = requireRecord(registry.chat, `${label} chat`);
  requireExactKeys(chat, ['common', 'platforms'], `${label} chat`);
  const platforms = requireRecord(chat.platforms, `${label} chat platforms`);
  requireExactKeys(platforms, canonicalPlatforms, `${label} chat platforms`);
  const common = validateIds(chat.common, `${label} chat common`);
  const commonSet = new Set(common);
  const parsedPlatforms = {};
  for (const platform of canonicalPlatforms) {
    const ids = validateIds(platforms[platform], `${label} chat ${platform}`);
    if (ids.some((id) => commonSet.has(id))) {
      throw new Error(`${label} repeats a common Chat assertion.`);
    }
    parsedPlatforms[platform] = ids;
  }
  return {
    schemaVersion: 1,
    cave: {
      engine: cave.engine,
      requireIncludeTtl: true,
      requireAuthorityTakeover: true,
    },
    sdk: validateIds(registry.sdk, `${label} sdk`),
    chat: {
      common,
      platforms: parsedPlatforms,
    },
  };
}

export function assertExactAssertionResults(assertions, expectedIds, label) {
  if (!Array.isArray(assertions)) {
    throw new Error(`${label} assertions must be an array.`);
  }
  const expected = new Set(expectedIds);
  const seen = new Set();
  for (const assertion of assertions) {
    const entry = requireRecord(assertion, `${label} assertion`);
    requireExactKeys(entry, ['id', 'result', 'diagnosticId'], `${label} assertion`);
    if (typeof entry.id !== 'string' || !expected.has(entry.id)) {
      throw new Error(`${label} contains unexpected assertion ${String(entry.id)}.`);
    }
    if (seen.has(entry.id)) {
      throw new Error(`${label} contains duplicate assertion ${entry.id}.`);
    }
    if (entry.result === 'skip') {
      throw new Error(`${label} contains skipped assertion ${entry.id}.`);
    }
    if (
      !['pass', 'fail'].includes(entry.result) ||
      typeof entry.diagnosticId !== 'string' ||
      !identifierPattern.test(entry.diagnosticId)
    ) {
      throw new Error(`${label} assertion ${entry.id} is invalid.`);
    }
    seen.add(entry.id);
  }
  for (const id of expectedIds) {
    if (!seen.has(id)) {
      throw new Error(`${label} is missing assertion ${id}.`);
    }
  }
  if (assertions.some((assertion, index) => assertion.id !== expectedIds[index])) {
    throw new Error(`${label} assertion order does not match the SDK registry.`);
  }
  return assertions;
}

export function createAssertionRecorder(registry, platform) {
  if (!canonicalPlatforms.includes(platform)) {
    throw new Error(`unsupported platform ${platform}`);
  }
  const expected = {
    sdk: registry.sdk,
    chat: [...registry.chat.common, ...registry.chat.platforms[platform]],
  };
  const recorded = {
    sdk: new Map(),
    chat: new Map(),
  };
  const pass = (scope, id, diagnosticId = 'phase1.assertion.passed') => {
    if (!Object.hasOwn(expected, scope) || !expected[scope].includes(id)) {
      throw new Error(`${scope} contains unexpected assertion ${id}.`);
    }
    if (recorded[scope].has(id)) {
      throw new Error(`${scope} contains duplicate assertion ${id}.`);
    }
    recorded[scope].set(id, { id, result: 'pass', diagnosticId });
  };
  return Object.freeze({
    pass,
    passMany(scope, ids, diagnosticId) {
      for (const id of ids) {
        pass(scope, id, diagnosticId);
      }
    },
    results() {
      const result = {};
      for (const scope of ['sdk', 'chat']) {
        const assertions = expected[scope]
          .filter((id) => recorded[scope].has(id))
          .map((id) => recorded[scope].get(id));
        result[scope] = assertExactAssertionResults(
          assertions,
          expected[scope],
          `${platform} ${scope}`,
        );
      }
      return Object.freeze(result);
    },
  });
}

export function validateMetadataAssertionBindings({ sdkAssertions, chatAssertions, metadata }) {
  if (
    !/^[0-9a-f]{40}$/u.test(metadata?.sdkCandidateRevision) ||
    !/^[0-9a-f]{64}$/u.test(metadata?.sdkManifestSha256) ||
    !/^[0-9a-f]{40}$/u.test(metadata?.chatHarnessRevision) ||
    !/^[0-9a-f]{64}$/u.test(metadata?.windowsSupervisorSha256) ||
    metadata?.mingwPackageVersion !== 'mingw-w64 14.0.0_3' ||
    metadata?.mingwHomebrewCoreRevision !== 'cd168d1fdc26f12e4ad64f358ff2dbec61ab7a57' ||
    metadata?.mingwBottleLayerSha256 !==
      '0d68ab737a8bbc8c63ac6ac7acc0695e2887c1169df9a4423f1180090079b1d5' ||
    metadata?.mingwLinkerVersion !== '2.47.20260726' ||
    metadata?.rustVersion !== '1.95.0'
  ) {
    throw new Error('Release metadata binding values are invalid.');
  }
  const definitions = [
    {
      scope: 'sdk',
      id: 'sdk.install.packed-tarballs',
      diagnosticId: `phase1.sdk-candidate.${metadata.sdkCandidateRevision}`,
      prefix: 'phase1.sdk-candidate.',
    },
    {
      scope: 'sdk',
      id: 'sdk.provenance.fixture-bytes-match',
      diagnosticId: `phase1.sdk-manifest.${metadata.sdkManifestSha256}`,
      prefix: 'phase1.sdk-manifest.',
    },
    {
      scope: 'chat',
      id: 'chat.install.consumer-lock-matches',
      diagnosticId: `phase1.chat-harness.${metadata.chatHarnessRevision}`,
      prefix: 'phase1.chat-harness.',
    },
    {
      scope: 'chat',
      id: 'chat.native.keychain-unavailable-fails-closed',
      diagnosticId: `phase1.toolchain.rust.${metadata.rustVersion}`,
      prefix: 'phase1.toolchain.rust.',
    },
    {
      scope: 'chat',
      id: 'chat.deadline.total-bounded',
      diagnosticId: windowsSupervisorDiagnosticId(metadata),
      prefix: 'phase1.windows-supervisor.',
    },
  ];
  const groups = { sdk: sdkAssertions, chat: chatAssertions };
  for (const definition of definitions) {
    const entries = groups[definition.scope].filter((entry) => entry.id === definition.id);
    if (entries.length !== 1 || entries[0].diagnosticId !== definition.diagnosticId) {
      throw new Error(`Release metadata binding for ${definition.id} is invalid.`);
    }
  }
  for (const [scope, assertions] of Object.entries(groups)) {
    for (const assertion of assertions) {
      const reserved = definitions.find((definition) =>
        assertion.diagnosticId.startsWith(definition.prefix),
      );
      if (
        reserved !== undefined &&
        (reserved.scope !== scope ||
          reserved.id !== assertion.id ||
          reserved.diagnosticId !== assertion.diagnosticId)
      ) {
        throw new Error('Release metadata was attached to an unrelated assertion.');
      }
    }
  }
}

export function windowsSupervisorDiagnosticId(metadata) {
  const binding = createHash('sha256')
    .update(
      JSON.stringify([
        metadata.windowsSupervisorSha256,
        metadata.mingwPackageVersion,
        metadata.mingwHomebrewCoreRevision,
        metadata.mingwBottleLayerSha256,
        metadata.mingwLinkerVersion,
      ]),
    )
    .digest('hex');
  return `phase1.windows-supervisor.v1.${binding}`;
}

function requireDigest(value, label) {
  if (typeof value !== 'string' || !digestPattern.test(value)) {
    throw new Error(`${label} must be a SHA-256 digest.`);
  }
  return value;
}

export function buildPlatformEvidence({
  registry,
  platform,
  caveRecord,
  releases,
  commits,
  digests,
  sdkAssertions,
  chatAssertions,
  environment,
  metadata,
  isolation,
}) {
  if (!canonicalPlatforms.includes(platform)) {
    throw new Error(`unsupported platform ${platform}`);
  }
  if (
    environment?.nodeVersion !== 'v24.18.1' ||
    environment?.packageManagerVersion !== 'pnpm@10.34.0'
  ) {
    throw new Error('Platform evidence must use the exact observed release toolchain.');
  }
  const [os, arch] = platform.split('-');
  const expectedChatIds = [...registry.chat.common, ...registry.chat.platforms[platform]];
  assertExactAssertionResults(sdkAssertions, registry.sdk, `${platform} SDK`);
  assertExactAssertionResults(chatAssertions, expectedChatIds, `${platform} Chat`);
  validateMetadataAssertionBindings({ sdkAssertions, chatAssertions, metadata });
  if (
    !Array.isArray(digests.sdkTarballs) ||
    digests.sdkTarballs.length !== canonicalTarballs.length
  ) {
    throw new Error('SDK tarball evidence must contain four canonical packages.');
  }
  const sdkTarballs = digests.sdkTarballs.map((artifact, index) => {
    if (artifact.packageName !== canonicalTarballs[index]) {
      throw new Error('SDK tarball evidence must use canonical package order.');
    }
    return {
      packageName: artifact.packageName,
      sha256: requireDigest(artifact.sha256, `${artifact.packageName} digest`),
    };
  });
  if (!Array.isArray(isolation?.roots) || isolation.roots.length !== isolationRoots.length) {
    throw new Error('Observed isolation roots are incomplete.');
  }
  const observedRoots = isolationRoots.map((id, index) => {
    const root = requireRecord(isolation.roots[index], `isolation root ${id}`);
    if (root.id !== id || root.ownershipVerified !== true || root.removedAfterRun !== true) {
      throw new Error(`isolation root ${id} was not verified and removed.`);
    }
    return {
      id,
      ownershipVerified: true,
      removedAfterRun: true,
    };
  });
  if (
    !Array.isArray(isolation.operatorState) ||
    isolation.operatorState.length !== operatorStateIds.length
  ) {
    throw new Error('Observed operator state is incomplete.');
  }
  const operatorStateRecords = operatorStateIds.map((id, index) => {
    const state = requireRecord(isolation.operatorState[index], `operator state ${id}`);
    if (state.id !== id) {
      throw new Error(`operator state ${id} is out of order.`);
    }
    const beforeSha256 = requireDigest(state.beforeSha256, `${id} before state`);
    const afterSha256 = requireDigest(state.afterSha256, `${id} after state`);
    if (beforeSha256 !== afterSha256) {
      throw new Error(`operator state ${id} changed.`);
    }
    return { id, beforeSha256, afterSha256 };
  });
  return {
    schemaVersion: 1,
    issue: 'OpenCoven/sdk#38',
    platform,
    ranAt: caveRecord.ranAt,
    environment: {
      os,
      arch,
      nodeVersion: environment.nodeVersion,
      packageManagerVersion: environment.packageManagerVersion,
    },
    releases,
    commits,
    digests: {
      caveAssertionEngine: requireDigest(
        digests.caveAssertionEngine,
        'Cave assertion engine digest',
      ),
      caveContractFixture: requireDigest(
        digests.caveContractFixture,
        'Cave contract fixture digest',
      ),
      hpkeVectors: requireDigest(digests.hpkeVectors, 'HPKE vectors digest'),
      consumerLock: requireDigest(digests.consumerLock, 'consumer lock digest'),
      assertionRegistry: requireDigest(digests.assertionRegistry, 'assertion registry digest'),
      sdkTarballs,
    },
    caveRecord,
    sdkAssertions,
    chatAssertions,
    coverage: { cave: true, coven: true, sdk: true, chat: true },
    notCovered: notCovered.map((entry) => ({ ...entry })),
    isolation: {
      strategy: 'process-owned-temporary-roots',
      network: 'loopback-only',
      sourceCheckoutDependency: false,
      workspaceLinkDependency: false,
      retainedPrivatePaths: false,
      retainedSocketHandles: false,
      roots: observedRoots,
      operatorState: operatorStateRecords,
    },
  };
}
