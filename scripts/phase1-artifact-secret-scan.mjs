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
const identifierPattern = /^[a-z0-9][a-z0-9.-]{0,127}$/;
const versionPattern = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const passFailStatuses = new Set(['passed', 'failed', 'blocked']);
const platformValues = Object.freeze({
  os: new Set(['darwin', 'linux', 'win32']),
  arch: new Set(['arm64', 'x64']),
});
const approvedVersionKeys = new Set(['harness', 'node', 'rust', 'tauri']);
const prohibitedContentPatterns = [
  /"(?:pairingSecret|pairing_secret|pairing-secret)"\s*:/iu,
  /\bpairing[ _-]secret\s*[:=]/iu,
  /"(?:bearer|accessToken|access_token)"\s*:/iu,
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}/u,
  /"Authorization"\s*:/iu,
  /"(?:rawKeychainValue|keychainValue|credentialValue)"\s*:/iu,
  /"(?:protectedRequestPlaintext|protectedResponsePlaintext)"\s*:/iu,
  /"(?:prompt|userPrompt|messageBody|attachment|attachmentBody)"\s*:/iu,
  /"(?:privatePath|socketPath|socketHandle)"\s*:/iu,
  /\/Users\/[^/"\\\s]+\/(?:Library|\.config|\.ssh|Documents)\//u,
  /\/home\/[^/"\\\s]+\/(?:\.config|\.ssh|Documents)\//u,
  /\/private\/var\/folders\/[^"\\\s]+/u,
  /\\\\Users\\\\[^"\\\s]+\\\\(?:AppData|Documents)\\\\/u,
];

export const REQUIRED_PHASE1_ASSERTION_IDS = Object.freeze([
  'phase1.missing-cave.validated-launch',
  'phase1.pairing.create-pending-approve-exchange',
  'phase1.pairing.denial',
  'phase1.pairing.expiry',
  'phase1.pairing.wrong-secret-replay',
  'phase1.pairing.failure-budget-retry-after',
  'phase1.credential.restart-reuse',
  'phase1.credential.revocation-repair',
  'phase1.compat.api-major-min-client',
  'phase1.hpke.endpoint-takeover',
  'phase1.reads.bounded-canonical',
  'phase1.reads.stale-generation-cursor-reconciliation',
  'phase1.coven.same-user-identity',
  'phase1.native.missing-keychain-trust',
  'phase1.operator.homes-credentials-untouched',
]);

export const APPROVED_PHASE1_DIAGNOSTIC_IDS = Object.freeze([
  'phase1.conformance.passed',
  'phase1.conformance.failed',
  'phase1.conformance.blocked',
  'phase1.assertion.passed',
  'phase1.assertion.failed',
  'phase1.assertion.blocked',
  'phase1.integration.native-pairing-exchange-failed',
  'phase1.integration.native-credential-unavailable',
  'phase1.integration.coven-identity-failed',
  'phase1.producer.cave-launch-fixture-unavailable',
  'phase1.producer.pairing-control-unavailable',
  'phase1.producer.pairing-expiry-control-unavailable',
  'phase1.producer.failure-budget-control-unavailable',
  'phase1.producer.revocation-control-unavailable',
  'phase1.producer.compatibility-control-unavailable',
  'phase1.producer.hpke-takeover-control-unavailable',
  'phase1.producer.canonical-read-fixture-unavailable',
  'phase1.producer.stale-reconciliation-fixture-unavailable',
  'phase1.producer.coven-identity-fixture-unavailable',
  'phase1.producer.native-trust-fixture-unavailable',
]);

const requiredAssertionSet = new Set(REQUIRED_PHASE1_ASSERTION_IDS);
const approvedDiagnosticSet = new Set(APPROVED_PHASE1_DIAGNOSTIC_IDS);

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

function requireApprovedDiagnosticIds(value, label) {
  if (
    !Array.isArray(value) ||
    value.some((id) => typeof id !== 'string' || !approvedDiagnosticSet.has(id))
  ) {
    throw new Error(`${label} contains an unapproved diagnostic ID.`);
  }
}

function validatePlatform(value) {
  const platform = requireRecord(value, 'Phase 1 report platform');
  requireExactKeys(platform, ['os', 'arch'], 'Phase 1 report platform');

  if (!platformValues.os.has(platform.os) || !platformValues.arch.has(platform.arch)) {
    throw new Error('Phase 1 report platform must use approved platform metadata.');
  }
}

function validateVersions(value) {
  const versions = requireRecord(value, 'Phase 1 report versions');
  const keys = Object.keys(versions);

  if (
    keys.length === 0 ||
    keys.some(
      (key) =>
        !approvedVersionKeys.has(key) ||
        typeof versions[key] !== 'string' ||
        !versionPattern.test(versions[key]),
    )
  ) {
    throw new Error('Phase 1 report versions must use approved version metadata.');
  }
}

function validateRevisions(value) {
  const revisions = requireRecord(value, 'Phase 1 report revisions');
  requireExactKeys(revisions, ['chat', 'sdk', 'cave', 'coven'], 'Phase 1 report revisions');

  if (Object.values(revisions).some((revision) => !shaPattern.test(revision))) {
    throw new Error('Phase 1 report revisions must contain immutable commit SHAs.');
  }
}

function validateArtifactDigests(value) {
  const digests = requireRecord(value, 'Phase 1 report artifact digests');

  for (const [name, digest] of Object.entries(digests)) {
    if (!identifierPattern.test(name) || !digestPattern.test(digest)) {
      throw new Error(
        'Phase 1 report artifact digests must use approved names and SHA-256 values.',
      );
    }
  }
}

function validateAssertions(value) {
  if (!Array.isArray(value) || value.length !== REQUIRED_PHASE1_ASSERTION_IDS.length) {
    throw new Error('Phase 1 report must contain the exact required assertion set.');
  }

  const observedIds = new Set();
  const statusCounts = {
    passed: 0,
    failed: 0,
    blocked: 0,
  };

  for (const rawAssertion of value) {
    const assertion = requireRecord(rawAssertion, 'Phase 1 report assertion');
    requireExactKeys(assertion, ['id', 'status', 'diagnosticIds'], 'Phase 1 report assertion');

    if (typeof assertion.id !== 'string' || !requiredAssertionSet.has(assertion.id)) {
      throw new Error('Phase 1 report contains an unapproved assertion ID.');
    }
    if (observedIds.has(assertion.id)) {
      throw new Error('Phase 1 report must contain the exact required assertion set.');
    }
    observedIds.add(assertion.id);

    if (!passFailStatuses.has(assertion.status)) {
      throw new Error('Phase 1 report assertion must use an approved pass-fail status.');
    }
    statusCounts[assertion.status] += 1;
    requireApprovedDiagnosticIds(assertion.diagnosticIds, 'Phase 1 report assertion');
  }

  if (
    observedIds.size !== requiredAssertionSet.size ||
    REQUIRED_PHASE1_ASSERTION_IDS.some((id) => !observedIds.has(id))
  ) {
    throw new Error('Phase 1 report must contain the exact required assertion set.');
  }

  return statusCounts;
}

function validateSummary(value, statusCounts) {
  const summary = requireRecord(value, 'Phase 1 report summary');
  requireExactKeys(
    summary,
    ['required', 'passed', 'failed', 'blocked', 'skipped'],
    'Phase 1 report summary',
  );

  if (
    Object.values(summary).some((count) => !Number.isSafeInteger(count) || count < 0) ||
    summary.required !== REQUIRED_PHASE1_ASSERTION_IDS.length ||
    summary.passed !== statusCounts.passed ||
    summary.failed !== statusCounts.failed ||
    summary.blocked !== statusCounts.blocked ||
    summary.skipped !== 0
  ) {
    throw new Error('Phase 1 report summary does not match its assertion results.');
  }
}

function validateReportStatus(report, statusCounts) {
  if (!passFailStatuses.has(report.status)) {
    throw new Error('Phase 1 report must use an approved pass-fail status.');
  }

  const expectedStatus =
    statusCounts.failed > 0 ? 'failed' : statusCounts.blocked > 0 ? 'blocked' : 'passed';
  if (report.status !== expectedStatus) {
    throw new Error('Phase 1 report status does not match its assertion results.');
  }
}

export function validatePhase1SanitizedReport(value) {
  const report = requireRecord(value, 'Phase 1 report');
  requireExactKeys(
    report,
    [
      'schemaVersion',
      'completed',
      'status',
      'platform',
      'versions',
      'revisions',
      'artifactDigests',
      'assertions',
      'summary',
      'diagnosticIds',
    ],
    'Phase 1 report',
  );

  if (report.schemaVersion !== 1 || report.completed !== true) {
    throw new Error('Phase 1 report must be a completed version-1 report.');
  }

  validatePlatform(report.platform);
  validateVersions(report.versions);
  validateRevisions(report.revisions);
  validateArtifactDigests(report.artifactDigests);
  const statusCounts = validateAssertions(report.assertions);
  validateSummary(report.summary, statusCounts);
  validateReportStatus(report, statusCounts);
  requireApprovedDiagnosticIds(report.diagnosticIds, 'Phase 1 report');
  return report;
}

function assertNoProhibitedContent(contents) {
  if (prohibitedContentPatterns.some((pattern) => pattern.test(contents))) {
    throw new Error('Phase 1 artifact contains prohibited secret or private content.');
  }
}

export function scanPhase1ArtifactText(contents, options = {}) {
  if (typeof contents !== 'string') {
    throw new Error('Phase 1 artifact must contain UTF-8 JSON text.');
  }
  if (
    options === null ||
    typeof options !== 'object' ||
    Array.isArray(options) ||
    Object.keys(options).some((key) => key !== 'validateReport') ||
    (options.validateReport !== undefined && typeof options.validateReport !== 'function')
  ) {
    throw new Error('Phase 1 artifact scan options may contain only validateReport.');
  }
  if (Buffer.byteLength(contents, 'utf8') > maxFileBytes) {
    throw new Error('Phase 1 artifact tree exceeds scan size limits.');
  }
  assertNoProhibitedContent(contents);

  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error('Phase 1 artifact must contain valid JSON.');
  }

  (options.validateReport ?? validatePhase1SanitizedReport)(value, contents);
  return value;
}

function scanJsonFile(path) {
  scanPhase1ArtifactText(readFileSync(path, 'utf8'));
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
