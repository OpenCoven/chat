import { lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { extname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ownershipStampName = '.opencoven-owned-temp';
const maxFileBytes = 1024 * 1024;
const maxTotalBytes = 4 * 1024 * 1024;
const maxFiles = 32;
const maxDepth = 8;
const shaPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;
const identifierPattern = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u;
const supportedPlatforms = new Set(['darwin-arm64', 'linux-x64', 'win32-x64']);
const sdkTarballNames = [
  '@opencoven/sdk-core',
  '@opencoven/cave-client',
  '@opencoven/coven-client',
  '@opencoven/sdk',
];
const notCoveredScopeIds = ['cross-process-pairing', 'oauth-ui', 'remote-peer', 'write-apis'];
const isolationRootIds = ['cave-home', 'coven-home', 'consumer-home', 'native-credential-store'];
const operatorStateIds = ['cave-home', 'coven-home', 'native-credential-store', 'projects'];
const prohibitedContentPatterns = [
  /"(?:pairingSecret|pairing_secret|pairing-secret)"\s*:/iu,
  /\bpairing[ _-]secret\s*[:=]/iu,
  /"(?:bearer|accessToken|access_token)"\s*:/iu,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/u,
  /"Authorization"\s*:/iu,
  /"(?:rawKeychainValue|keychainValue|credentialValue)"\s*:/iu,
  /"(?:protectedRequestPlaintext|protectedResponsePlaintext)"\s*:/iu,
  /"(?:prompt|userPrompt|messageBody|attachment|attachmentBody)"\s*:/iu,
  /"(?:body|commandOutput|content|message|stderr|stdout)"\s*:/iu,
  /"(?:privatePath|socketPath|socketHandle)"\s*:/iu,
  /\/Users\/[^/"\\\s]+\/(?:Library|\.config|\.ssh|Documents)\//u,
  /\/home\/[^/"\\\s]+\/(?:\.config|\.ssh|Documents)\//u,
  /\/private\/var\/folders\/[^"\\\s]+/u,
  /\\\\Users\\\\[^"\\\s]+\\\\(?:AppData|Documents)\\\\/u,
];

function requireRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must use the approved report schema.`);
  }
  return value;
}

function requireExactKeys(record, keys, label) {
  const actualKeys = Object.keys(record);
  if (actualKeys.length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) {
    throw new Error(`${label} must use the approved report schema.`);
  }
}

function validateAssertions(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  const seen = new Set();
  for (const rawAssertion of value) {
    const assertion = requireRecord(rawAssertion, `${label} assertion`);
    requireExactKeys(assertion, ['id', 'result', 'diagnosticId'], `${label} assertion`);
    if (typeof assertion.id !== 'string' || !identifierPattern.test(assertion.id)) {
      throw new Error(`${label} contains a noncanonical assertion ID.`);
    }
    if (seen.has(assertion.id)) {
      throw new Error(`${label} contains a duplicate assertion ID.`);
    }
    seen.add(assertion.id);
    if (assertion.result === 'skip') {
      throw new Error(`${label} must not skip assertions.`);
    }
    if (!['pass', 'fail'].includes(assertion.result)) {
      throw new Error(`${label} contains an invalid assertion result.`);
    }
    if (
      typeof assertion.diagnosticId !== 'string' ||
      !identifierPattern.test(assertion.diagnosticId)
    ) {
      throw new Error(`${label} contains a noncanonical diagnostic ID.`);
    }
  }
}

function validateDigests(value) {
  const digests = requireRecord(value, 'Phase 1 report digests');
  requireExactKeys(
    digests,
    [
      'caveAssertionEngine',
      'caveContractFixture',
      'hpkeVectors',
      'consumerLock',
      'assertionRegistry',
      'sdkTarballs',
    ],
    'Phase 1 report digests',
  );
  for (const key of [
    'caveAssertionEngine',
    'caveContractFixture',
    'hpkeVectors',
    'consumerLock',
    'assertionRegistry',
  ]) {
    if (typeof digests[key] !== 'string' || !digestPattern.test(digests[key])) {
      throw new Error('Phase 1 report digests must contain SHA-256 values.');
    }
  }
  if (!Array.isArray(digests.sdkTarballs) || digests.sdkTarballs.length !== 4) {
    throw new Error('Phase 1 report must contain four SDK tarball digests.');
  }
  digests.sdkTarballs.forEach((rawArtifact, index) => {
    const artifact = requireRecord(rawArtifact, 'SDK tarball digest');
    requireExactKeys(artifact, ['packageName', 'sha256'], 'SDK tarball digest');
    if (
      artifact.packageName !== sdkTarballNames[index] ||
      typeof artifact.sha256 !== 'string' ||
      !digestPattern.test(artifact.sha256)
    ) {
      throw new Error('Phase 1 report SDK tarballs must use canonical order and digests.');
    }
  });
}

function validateIsolation(value) {
  const isolation = requireRecord(value, 'Phase 1 report isolation');
  requireExactKeys(
    isolation,
    [
      'strategy',
      'network',
      'sourceCheckoutDependency',
      'workspaceLinkDependency',
      'retainedPrivatePaths',
      'retainedSocketHandles',
      'roots',
      'operatorState',
    ],
    'Phase 1 report isolation',
  );
  if (
    isolation.strategy !== 'process-owned-temporary-roots' ||
    isolation.network !== 'loopback-only' ||
    isolation.sourceCheckoutDependency !== false ||
    isolation.workspaceLinkDependency !== false ||
    isolation.retainedPrivatePaths !== false ||
    isolation.retainedSocketHandles !== false
  ) {
    throw new Error('Phase 1 report isolation metadata is invalid.');
  }
  if (!Array.isArray(isolation.roots) || isolation.roots.length !== isolationRootIds.length) {
    throw new Error('Phase 1 report isolation roots are invalid.');
  }
  isolation.roots.forEach((rawRoot, index) => {
    const root = requireRecord(rawRoot, 'Phase 1 report isolation root');
    requireExactKeys(
      root,
      ['id', 'ownershipVerified', 'removedAfterRun'],
      'Phase 1 report isolation root',
    );
    if (
      root.id !== isolationRootIds[index] ||
      root.ownershipVerified !== true ||
      root.removedAfterRun !== true
    ) {
      throw new Error('Phase 1 report isolation roots are invalid.');
    }
  });
  if (
    !Array.isArray(isolation.operatorState) ||
    isolation.operatorState.length !== operatorStateIds.length
  ) {
    throw new Error('Phase 1 report operator state is invalid.');
  }
  isolation.operatorState.forEach((rawState, index) => {
    const state = requireRecord(rawState, 'Phase 1 report operator state');
    requireExactKeys(state, ['id', 'beforeSha256', 'afterSha256'], 'Phase 1 report operator state');
    if (
      state.id !== operatorStateIds[index] ||
      !digestPattern.test(state.beforeSha256) ||
      state.beforeSha256 !== state.afterSha256
    ) {
      throw new Error('Phase 1 report operator state is invalid.');
    }
  });
}

export function validatePhase1SanitizedReport(value) {
  const report = requireRecord(value, 'Phase 1 report');
  requireExactKeys(
    report,
    [
      'schemaVersion',
      'issue',
      'platform',
      'ranAt',
      'environment',
      'releases',
      'commits',
      'digests',
      'caveRecord',
      'sdkAssertions',
      'chatAssertions',
      'coverage',
      'notCovered',
      'isolation',
    ],
    'Phase 1 report',
  );

  if (report.schemaVersion !== 1 || report.issue !== 'OpenCoven/sdk#38') {
    throw new Error('Phase 1 report must be an SDK #38 version-1 record.');
  }
  if (typeof report.platform !== 'string' || !supportedPlatforms.has(report.platform)) {
    throw new Error('Phase 1 report must use a supported platform ID.');
  }
  const environment = requireRecord(report.environment, 'Phase 1 report environment');
  requireExactKeys(
    environment,
    ['os', 'arch', 'nodeVersion', 'packageManagerVersion'],
    'Phase 1 report environment',
  );
  if (
    `${environment.os}-${environment.arch}` !== report.platform ||
    environment.nodeVersion !== 'v24.18.1' ||
    environment.packageManagerVersion !== 'pnpm@10.34.0'
  ) {
    throw new Error('Phase 1 report environment is invalid.');
  }
  const releases = requireRecord(report.releases, 'Phase 1 report releases');
  requireExactKeys(releases, ['cave', 'coven'], 'Phase 1 report releases');
  const commits = requireRecord(report.commits, 'Phase 1 report commits');
  requireExactKeys(commits, ['cave', 'coven', 'sdk', 'chat'], 'Phase 1 report commits');
  if (Object.values(commits).some((revision) => !shaPattern.test(revision))) {
    throw new Error('Phase 1 report commits must contain immutable revisions.');
  }
  validateDigests(report.digests);
  requireRecord(report.caveRecord, 'Phase 1 report Cave record');
  validateAssertions(report.sdkAssertions, 'Phase 1 report SDK assertions');
  validateAssertions(report.chatAssertions, 'Phase 1 report Chat assertions');
  const coverage = requireRecord(report.coverage, 'Phase 1 report coverage');
  requireExactKeys(coverage, ['cave', 'coven', 'sdk', 'chat'], 'Phase 1 report coverage');
  if (Object.values(coverage).some((covered) => covered !== true)) {
    throw new Error('Phase 1 report coverage must be complete.');
  }
  if (!Array.isArray(report.notCovered) || report.notCovered.length !== 4) {
    throw new Error('Phase 1 report notCovered scopes are invalid.');
  }
  report.notCovered.forEach((rawScope, index) => {
    const scope = requireRecord(rawScope, 'Phase 1 report notCovered scope');
    requireExactKeys(scope, ['scopeId', 'diagnosticId'], 'Phase 1 report notCovered scope');
    if (
      scope.scopeId !== notCoveredScopeIds[index] ||
      typeof scope.diagnosticId !== 'string' ||
      !identifierPattern.test(scope.diagnosticId)
    ) {
      throw new Error('Phase 1 report notCovered scopes are invalid.');
    }
  });
  validateIsolation(report.isolation);
  return report;
}

function assertNoProhibitedContent(contents) {
  if (prohibitedContentPatterns.some((pattern) => pattern.test(contents))) {
    throw new Error('Phase 1 artifact contains prohibited secret or private content.');
  }
}

function scanJsonFile(path) {
  const contents = readFileSync(path, 'utf8');
  assertNoProhibitedContent(contents);

  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error('Phase 1 artifact must contain valid JSON.');
  }

  validatePhase1SanitizedReport(value);
}

function scanDirectory(directoryPath, rootRealPath, state, depth) {
  if (depth > maxDepth) {
    throw new Error('Phase 1 artifact tree exceeds scan size limits.');
  }

  for (const entry of readdirSync(directoryPath, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (depth === 0 && entry.name === ownershipStampName) {
      continue;
    }

    const entryPath = resolve(directoryPath, entry.name);
    const stats = lstatSync(entryPath);

    if (stats.isSymbolicLink()) {
      throw new Error('Phase 1 artifacts must not contain symlinks.');
    }

    const entryRealPath = realpathSync(entryPath);
    const rootOffset = relative(rootRealPath, entryRealPath);
    if (rootOffset === '..' || rootOffset.startsWith(`..${sep}`)) {
      throw new Error('Phase 1 artifact escaped its owned root.');
    }

    if (stats.isDirectory()) {
      scanDirectory(entryPath, rootRealPath, state, depth + 1);
      continue;
    }

    if (!stats.isFile()) {
      throw new Error('Phase 1 artifacts must contain only regular JSON files.');
    }

    state.filesScanned += 1;
    state.bytesScanned += stats.size;
    if (
      state.filesScanned > maxFiles ||
      stats.size > maxFileBytes ||
      state.bytesScanned > maxTotalBytes
    ) {
      throw new Error('Phase 1 artifact tree exceeds scan size limits.');
    }

    if (extname(entry.name) !== '.json') {
      throw new Error('Phase 1 artifacts may contain only JSON artifacts.');
    }

    scanJsonFile(entryPath);
    state.reportCount += 1;
  }
}

export async function scanPhase1Artifacts(options) {
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).length !== 1 ||
    typeof options.artifactRoot !== 'string' ||
    options.artifactRoot.length === 0
  ) {
    throw new Error('scanPhase1Artifacts requires exactly one artifactRoot path.');
  }

  const artifactRoot = resolve(options.artifactRoot);
  const rootStats = lstatSync(artifactRoot);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error('Phase 1 artifact root must be a non-symlink directory.');
  }

  const state = {
    filesScanned: 0,
    bytesScanned: 0,
    reportCount: 0,
  };
  scanDirectory(artifactRoot, realpathSync(artifactRoot), state, 0);

  if (state.reportCount === 0) {
    throw new Error('Phase 1 artifact root contains no sanitized JSON report.');
  }

  return Object.freeze({ ...state });
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 2 || argv[0] !== '--artifact-root') {
    throw new Error('usage: phase1-artifact-secret-scan.mjs --artifact-root <directory>');
  }
  const result = await scanPhase1Artifacts({ artifactRoot: resolve(argv[1]) });
  process.stdout.write(
    `phase1-artifact-secret-scan: passed (${result.reportCount} report, ${result.filesScanned} JSON file)\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => {
    process.stderr.write('phase1-artifact-secret-scan: failed\n');
    process.exitCode = 1;
  });
}
