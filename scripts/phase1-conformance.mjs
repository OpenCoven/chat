import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { devNull } from 'node:os';
import { delimiter, dirname, isAbsolute, resolve, win32 as windowsPath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual, stripVTControlCharacters } from 'node:util';
import { FROZEN_PACKED_CONSUMER_STAGES } from './contract-canary.mjs';
import { resolveExecutableInvocation } from './executable-resolution.mjs';
import { scanPhase1Artifacts } from './phase1-artifact-secret-scan.mjs';
import {
  assertCleanPhase1Checkouts,
  assertExecutingPhase1HarnessAuthority,
  assertPhase1CheckoutHeads,
  assertPhase1ProducerAuthority,
  createGitCheckoutEnvironment,
  createGitEnvironment,
  gitNullDevice,
  readPhase1ConformanceLock,
  resolveLocalGitDirectory,
} from './phase1-conformance-lock.mjs';
import {
  buildPlatformEvidence,
  canonicalPlatformId,
  createAssertionRecorder,
  parseLockedAssertionRegistry,
  validateObservedToolVersions,
  windowsSupervisorDiagnosticId,
} from './phase1-evidence-contract.mjs';
import {
  CANONICAL_PLATFORM_ENVIRONMENTS,
  createObservedAssertionRecorder,
} from './phase1-schema-v2-evidence.mjs';
import {
  runSchemaV2Conformance,
  schemaV2SupervisorEnvironment,
  supervisorArtifactOutputPath,
} from './phase1-schema-v2-producer.mjs';
import { createProcessOwnedArtifactRoot } from './process-owned-artifact-root.mjs';
import { configureSupervisedExecution, runSupervisedSync } from './supervised-exec.mjs';
import { parseSupervisorStatusFrame } from './supervisor-status.mjs';

export {
  runPowerShellCommandWithArgs,
  schemaV2SupervisorEnvironment,
  supervisorArtifactOutputPath,
  unixProducerBindingEnvironment,
  validateSchemaV2AuthorityCheckouts,
  windowsJobBindingEnvironment,
} from './phase1-schema-v2-producer.mjs';
export { parseSupervisorStatusFrame } from './supervisor-status.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const chatRepositoryRoot = projectRoot;
const repositoriesParent = dirname(chatRepositoryRoot);
const defaultRetainedReport = resolve(
  projectRoot,
  'test-results',
  'phase1-conformance',
  'report.json',
);
const commandOutputLimit = 16 * 1024 * 1024;
const revocationConfirmationDelayMs = 550;
const commandTimeoutMs = 20 * 60_000;
export const cargoBuildTimeoutMs = 45 * 60_000;
const caveBuildNodeOptions = '--max-old-space-size=6144';
const caveBuildReportedCpuTotal = '3';
const rpcTimeoutMs = 10_000;
const caveConformanceTimeoutMs = 15 * 60_000;
const approvedCommandFailureReasons = new Set([
  'spawn',
  'tracking',
  'stdout-limit',
  'stderr-limit',
  'timeout',
  'supervisor-termination',
]);
const verifiedRunnerEnvironment = 'OPENCOVEN_PHASE1_VERIFIED_RUNNER';
const verifiedRunnerRootEnvironment = 'OPENCOVEN_PHASE1_VERIFIED_RUNNER_ROOT';
const protectedHarnessTagRef = 'refs/tags/opencoven-phase1-harness';
const evidenceAuthorizationVariables = new Set([
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'GH_TOKEN',
  'GITHUB_TOKEN',
]);
const forbiddenNodeEnvironment = [
  'NODE_OPTIONS',
  'NODE_PATH',
  'NODE_REPL_EXTERNAL_MODULE',
  'NODE_EXTRA_CA_CERTS',
  'NPM_CONFIG_NODE_OPTIONS',
  'npm_config_node_options',
  'NODE_CHANNEL_FD',
  'NODE_UNIQUE_ID',
];
let configuredWindowsSupervisorPath;
const packageSdkAssertionIds = Object.freeze([
  'sdk.install.packed-tarballs',
  'sdk.install.public-exports',
  'sdk.install.no-source-checkout',
  'sdk.install.no-workspace-link',
  'sdk.provenance.fixture-bytes-match',
  'sdk.provenance.hpke-vectors-match',
]);
const caveSdkAssertionIds = Object.freeze([
  'sdk.cave.discovery.release-mode',
  'sdk.cave.discovery.stale-record-refused',
  'sdk.cave.discovery.replaced-instance-refused',
  'sdk.cave.health.compatible',
  'sdk.cave.pairing.create',
  'sdk.cave.pairing.pending',
  'sdk.cave.pairing.exchange-once',
  'sdk.cave.pairing.denied',
  'sdk.cave.pairing.expired',
  'sdk.cave.pairing.wrong-secret-refused',
  'sdk.cave.pairing.replay-refused',
  'sdk.cave.pairing.shared-failure-budget',
  'sdk.cave.pairing.rate-limit',
  'sdk.cave.exchange.missing-content-length-refused',
  'sdk.cave.exchange.content-length-zero-accepted',
  'sdk.cave.proxy-rejection.distinct-envelope',
  'sdk.cave.credential.native-store-required',
  'sdk.cave.credential.restart-reused',
  'sdk.cave.read.familiars',
  'sdk.cave.read.projects',
  'sdk.cave.read.conversations',
  'sdk.cave.read.conversation',
  'sdk.cave.read.messages',
  'sdk.cave.cursor.malformed-refused',
  'sdk.cave.cursor.noncanonical-refused',
  'sdk.cave.cursor.reconcile-required',
  'sdk.cave.revocation.familiars-refused',
  'sdk.cave.revocation.projects-refused',
  'sdk.cave.revocation.conversations-refused',
  'sdk.cave.revocation.conversation-refused',
  'sdk.cave.revocation.messages-refused',
]);
const nativeSdkAssertionIds = Object.freeze([
  'sdk.native.keychain-missing-fails-closed',
  'sdk.native.trust-binding-missing-fails-closed',
]);
const packageChatAssertionIds = Object.freeze([
  'chat.install.exact-sdk-tarballs',
  'chat.install.consumer-lock-matches',
  'chat.install.no-source-checkout',
  'chat.install.no-workspace-link',
]);
const caveChatAssertionIds = Object.freeze([
  'chat.cave.compatibility-before-pairing',
  'chat.cave.pairing-secret-remains-native',
  'chat.cave.bearer-remains-native',
  'chat.cave.bearer-never-enters-webview',
  'chat.cave.native-store.roundtrip',
  'chat.cave.restart.credential-reused',
  'chat.cave.restart.no-automatic-repairing',
  'chat.cave.replacement.stale-state-refused',
  'chat.cave.read.familiars',
  'chat.cave.read.projects',
  'chat.cave.read.conversations',
  'chat.cave.read.conversation',
  'chat.cave.read.messages',
  'chat.cave.reconcile.reloads-query-only',
  'chat.cave.revocation.transitions-state',
  'chat.cave.revocation.all-reads-refused',
]);
const nativeChatAssertionIds = Object.freeze([
  'chat.native.keychain-unavailable-fails-closed',
  'chat.native.trust-provider-unavailable-fails-closed',
]);
const evidenceChatAssertionIds = Object.freeze([
  'chat.evidence.no-prompts',
  'chat.evidence.no-message-bodies',
  'chat.evidence.no-attachments',
  'chat.evidence.no-command-output',
]);

function defaultSourceRoot(environmentName, repositoryName) {
  return process.env[environmentName] === undefined
    ? resolve(repositoriesParent, repositoryName)
    : resolve(process.env[environmentName]);
}

export function scrubEvidenceAuthorizationEnvironment(environment = process.env) {
  for (const key of Object.keys(environment)) {
    if (evidenceAuthorizationVariables.has(key.toUpperCase())) {
      delete environment[key];
    }
  }
  return environment;
}

export class CommandExecutionError extends Error {
  constructor(label, result, cause) {
    const reason = approvedCommandFailureReasons.has(result?.reason) ? ` (${result.reason})` : '';
    super(`${label} failed${reason}.`, cause === undefined ? undefined : { cause });
    this.label = label;
    this.result = result;
  }
}

const runtimeScenarioDiagnosticIds = new Map([
  [
    'phase1.missing-cave.validated-launch',
    'phase1.runtime-assertions.missing-cave-validated-launch',
  ],
  [
    'phase1.pairing.create-pending-approve-exchange',
    'phase1.runtime-assertions.pairing-create-pending-approve-exchange',
  ],
  ['phase1.pairing.denial', 'phase1.runtime-assertions.pairing-denial'],
  ['phase1.pairing.expiry', 'phase1.runtime-assertions.pairing-expiry'],
  ['phase1.pairing.wrong-secret-replay', 'phase1.runtime-assertions.pairing-wrong-secret-replay'],
  [
    'phase1.pairing.failure-budget-retry-after',
    'phase1.runtime-assertions.pairing-failure-budget-retry-after',
  ],
  ['phase1.credential.restart-reuse', 'phase1.runtime-assertions.credential-restart-reuse'],
  ['phase1.credential.revocation-repair', 'phase1.runtime-assertions.credential-revocation-repair'],
  ['phase1.hpke.endpoint-takeover', 'phase1.runtime-assertions.hpke-endpoint-takeover'],
  ['phase1.reads.bounded-canonical', 'phase1.runtime-assertions.reads-bounded-canonical'],
  [
    'phase1.reads.stale-generation-cursor-reconciliation',
    'phase1.runtime-assertions.reads-stale-generation-cursor-reconciliation',
  ],
  ['phase1.coven.same-user-identity', 'phase1.runtime-assertions.coven-same-user-identity'],
  [
    'phase1.native.missing-keychain-trust',
    'phase1.runtime-assertions.native-missing-keychain-trust',
  ],
]);
const covenIdentityFailureStages = new Set([
  'rpc-start',
  'unavailable-health',
  'daemon-spawn',
  'daemon-ready',
  'malicious-home',
  'wrong-mode-home',
  'symlink-socket-home',
  'socket-mode',
  'result',
]);
const covenIdentityDiagnosticIds = new Set(
  [...covenIdentityFailureStages, 'unknown'].map((stage) => `phase1.coven-identity.${stage}`),
);

const publicPhase1DiagnosticIds = new Set([
  'phase1.operator-fingerprint.failed',
  'phase1.operator-fingerprint.unsafe-root',
  'phase1.operator-fingerprint.entry-limit',
  'phase1.operator-fingerprint.unsafe-control-resource',
  'phase1.operator-fingerprint.control-file-limit',
  'phase1.operator-fingerprint.changed-during-read',
  'phase1.stage.runner-bootstrap.failed',
  'phase1.stage.runner-lock.failed',
  'phase1.stage.runner-checkout.failed',
  'phase1.stage.runner-checkout.unsafe-source-owner',
  'phase1.stage.runner-checkout.source-reference',
  'phase1.stage.runner-checkout.source-revision',
  'phase1.stage.runner-checkout.source-tag',
  'phase1.stage.runner-checkout.clone',
  'phase1.stage.runner-checkout.checkout',
  'phase1.stage.runner-checkout-verification.failed',
  'phase1.stage.verified-runner.failed',
  'phase1.stage.verified-runner.timeout',
  'phase1.stage.verified-runner.output-limit',
  'phase1.stage.verified-runner.spawn',
  'phase1.stage.verified-runner.supervisor',
  'phase1.stage.verified-runner.exit-nonzero',
  'phase1.stage.runtime-integrity.failed',
  'phase1.stage.invocation.failed',
  'phase1.stage.invocation.windows-job-required',
  'phase1.stage.invocation.windows-job-identity',
  'phase1.stage.invocation.windows-powershell',
  'phase1.stage.invocation.windows-toolchain-path',
  'phase1.stage.invocation.windows-path',
  'phase1.stage.invocation.windows-artifact-binding',
  'phase1.stage.invocation.windows-os-environment',
  'phase1.stage.invocation.windows-executable-path',
  'phase1.stage.invocation.windows-path-extensions',
  'phase1.stage.invocation.windows-output-binding',
  'phase1.stage.invocation.unix-output-binding',
  'phase1.stage.invocation.platform-mismatch',
  'phase1.stage.lock.failed',
  'phase1.stage.harness-authority.failed',
  'phase1.stage.schema-v2-production.failed',
  'phase1.stage.native-provider.failed',
  'phase1.stage.execution-root.failed',
  'phase1.stage.environment.failed',
  'phase1.environment.rust-toolchain.failed',
  'phase1.environment.rustup-cargo.failed',
  'phase1.environment.rustup-rustc.failed',
  'phase1.environment.rustup-rustdoc.failed',
  'phase1.environment.rust-toolchain-mismatch',
  'phase1.environment.rustup-home.invalid',
  'phase1.environment.directories.failed',
  'phase1.stage.toolchain.failed',
  'phase1.stage.checkouts.failed',
  'phase1.stage.evidence-authority.failed',
  'phase1.stage.packaging.failed',
  'phase1.packaging.frozen-consumer.failed',
  ...FROZEN_PACKED_CONSUMER_STAGES.map(
    (stage) => `phase1.packaging.frozen-consumer.${stage}.failed`,
  ),
  'phase1.packaging.cave-install.failed',
  'phase1.packaging.cave-build.failed',
  'phase1.packaging.chat-install.failed',
  'phase1.packaging.chat-web-build.failed',
  'phase1.packaging.chat-native-build.failed',
  'phase1.packaging.chat-native-build.timeout',
  'phase1.packaging.chat-native-build.output-limit',
  'phase1.packaging.chat-native-build.spawn',
  'phase1.packaging.chat-native-build.supervisor',
  'phase1.packaging.chat-native-build.native-dependency',
  'phase1.packaging.chat-native-build.dependency-fetch',
  'phase1.packaging.chat-native-build.resource.memory',
  'phase1.packaging.chat-native-build.resource.disk',
  'phase1.packaging.chat-native-build.resource.killed',
  'phase1.packaging.chat-native-build.linker',
  'phase1.packaging.chat-native-build.build-script',
  'phase1.packaging.chat-native-build.compile',
  'phase1.packaging.chat-native-build.unknown',
  'phase1.packaging.coven-build.failed',
  'phase1.packaging.coven-build.timeout',
  'phase1.packaging.coven-build.output-limit',
  'phase1.packaging.coven-build.spawn',
  'phase1.packaging.coven-build.supervisor',
  'phase1.packaging.coven-build.native-dependency',
  'phase1.packaging.coven-build.dependency-fetch',
  'phase1.packaging.coven-build.resource.memory',
  'phase1.packaging.coven-build.resource.disk',
  'phase1.packaging.coven-build.resource.killed',
  'phase1.packaging.coven-build.linker',
  'phase1.packaging.coven-build.build-script',
  'phase1.packaging.coven-build.compile',
  'phase1.packaging.coven-build.unknown',
  'phase1.packaging.outputs.failed',
  'phase1.stage.packaging-proof.failed',
  'phase1.stage.cave-authority.failed',
  'phase1.stage.native-scenarios.failed',
  'phase1.native-scenarios.fixture-daemon',
  'phase1.native-scenarios.fixture',
  'phase1.native-scenarios.rpc-start',
  'phase1.native-scenarios.launch',
  'phase1.native-scenarios.pairing',
  'phase1.native-scenarios.pairing-reservation',
  'phase1.native-scenarios.pairing-reservation-request',
  'phase1.native-scenarios.pairing-reservation-keychain',
  'phase1.native-scenarios.pairing-reservation-store-unavailable',
  'phase1.native-scenarios.pairing-reservation-invalid-handle',
  'phase1.native-scenarios.pairing-reservation-discovery-required',
  'phase1.native-scenarios.pairing-reservation-health-required',
  'phase1.native-scenarios.pairing-reservation-rejected',
  'phase1.native-scenarios.pairing-reservation-response',
  'phase1.native-scenarios.pairing-reservation-cleanup',
  'phase1.native-scenarios.pairing-credential-status',
  'phase1.native-scenarios.pairing-create',
  'phase1.native-scenarios.pairing-pending',
  'phase1.native-scenarios.pairing-approve',
  'phase1.native-scenarios.pairing-approved',
  'phase1.native-scenarios.pairing-exchange',
  'phase1.native-scenarios.pairing-denial',
  'phase1.native-scenarios.restart',
  'phase1.native-scenarios.restart-rpc-start',
  'phase1.native-scenarios.restart-discovery',
  'phase1.native-scenarios.restart-health',
  'phase1.native-scenarios.restart-cleanup-adoption',
  'phase1.native-scenarios.restart-status',
  'phase1.native-scenarios.restart-handoff-close',
  'phase1.native-scenarios.restart-launch',
  'phase1.native-scenarios.restart-rediscovery',
  'phase1.native-scenarios.restart-restarted-health',
  'phase1.native-scenarios.restart-restarted-status',
  'phase1.native-scenarios.restart-result',
  'phase1.native-scenarios.reads',
  'phase1.native-scenarios.reconciliation',
  'phase1.native-scenarios.revocation',
  'phase1.native-scenarios.revocation-delete',
  'phase1.native-scenarios.revocation-initial-status',
  'phase1.native-scenarios.revocation-rediscovery',
  'phase1.native-scenarios.revocation-health',
  'phase1.native-scenarios.revocation-status',
  'phase1.native-scenarios.revocation-repair-create',
  'phase1.native-scenarios.revocation-repair-pending',
  'phase1.native-scenarios.revocation-repair-approve',
  'phase1.native-scenarios.revocation-repair-approved',
  'phase1.native-scenarios.revocation-repair-exchange',
  'phase1.native-scenarios.revocation-result',
  'phase1.native-scenarios.credential-cleanup',
  'phase1.native-scenarios.credential-cleanup-discovery',
  'phase1.native-scenarios.credential-cleanup-health',
  'phase1.native-scenarios.credential-cleanup-identity',
  'phase1.native-scenarios.credential-cleanup-forget',
  'phase1.native-scenarios.credential-cleanup-status',
  'phase1.native-scenarios.credential-cleanup-result',
  'phase1.native-scenarios.stale-discovery',
  'phase1.native-scenarios.cleanup',
  'phase1.native-scenarios.cleanup-grant',
  'phase1.native-scenarios.cleanup-grant.service-unavailable',
  'phase1.native-scenarios.cleanup-grant.process-secret-unavailable',
  'phase1.native-scenarios.cleanup-grant.random-unavailable',
  'phase1.native-scenarios.cleanup-grant.marker-home-unavailable',
  'phase1.native-scenarios.cleanup-grant.marker-directory-unavailable',
  'phase1.native-scenarios.cleanup-grant.marker-directory-create-unavailable',
  'phase1.native-scenarios.cleanup-grant.marker-directory-open-unavailable',
  'phase1.native-scenarios.cleanup-grant.marker-directory-metadata-unavailable',
  'phase1.native-scenarios.cleanup-grant.marker-directory-trust-unavailable',
  'phase1.native-scenarios.cleanup-grant.marker-sync-unavailable',
  'phase1.native-scenarios.cleanup-grant.marker-identity-unavailable',
  'phase1.native-scenarios.cleanup-grant.marker-publish-unavailable',
  'phase1.native-scenarios.cleanup-grant.collision-exhausted',
  'phase1.native-scenarios.cleanup-grant.secure-store-unavailable',
  'phase1.native-scenarios.cleanup-grant.keychain-failure',
  'phase1.native-scenarios.cleanup-grant.cleanup-grant-rejected',
  'phase1.native-scenarios.cleanup-grant.invalid-native-input',
  'phase1.native-scenarios.cleanup-grant.timeout',
  'phase1.native-scenarios.cleanup-grant.process',
  'phase1.native-scenarios.cleanup-grant.response',
  'phase1.native-scenarios.cleanup-grant.unknown',
  'phase1.native-scenarios.cleanup-custody',
  'phase1.native-scenarios.cleanup-custody.secure-store-unavailable',
  'phase1.native-scenarios.cleanup-custody.keychain-failure',
  'phase1.native-scenarios.cleanup-custody.cleanup-grant-rejected',
  'phase1.native-scenarios.cleanup-custody.backend-unavailable',
  'phase1.native-scenarios.cleanup-custody.lock-unavailable',
  'phase1.native-scenarios.cleanup-custody.lock-process-unavailable',
  'phase1.native-scenarios.cleanup-custody.lock-path-unavailable',
  'phase1.native-scenarios.cleanup-custody.lock-file-unavailable',
  'phase1.native-scenarios.cleanup-custody.lock-contended',
  'phase1.native-scenarios.cleanup-custody.installation-delete-unavailable',
  'phase1.native-scenarios.cleanup-custody.credential-delete-unavailable',
  'phase1.native-scenarios.cleanup-custody.invalid-native-input',
  'phase1.native-scenarios.cleanup-custody.timeout',
  'phase1.native-scenarios.cleanup-custody.process',
  'phase1.native-scenarios.cleanup-custody.proof',
  'phase1.native-scenarios.cleanup-custody.unknown',
  'phase1.native-scenarios.cleanup-rpc',
  'phase1.native-scenarios.cleanup-fixture-daemon',
  'phase1.native-scenarios.missing-keychain',
  'phase1.native-scenarios.missing-keychain-timeout',
  'phase1.native-scenarios.missing-keychain-output-limit',
  'phase1.native-scenarios.missing-keychain-process',
  'phase1.native-scenarios.missing-keychain-reap',
  'phase1.native-scenarios.missing-keychain-termination',
  'phase1.native-scenarios.missing-keychain-supervisor',
  'phase1.native-scenarios.missing-keychain-canary',
  'phase1.native-scenarios.missing-keychain-home',
  'phase1.native-scenarios.missing-keychain-response',
  'phase1.native-scenarios.isolation-proof',
  'phase1.stage.coven-identity.failed',
  ...covenIdentityDiagnosticIds,
  'phase1.stage.runtime-assertions.failed',
  ...runtimeScenarioDiagnosticIds.values(),
  'phase1.stage.isolation.failed',
  'phase1.stage.isolation-proof.failed',
  'phase1.stage.assertion-recording.failed',
  'phase1.stage.evidence-build.failed',
  'phase1.stage.evidence-validation.failed',
  'phase1.stage.evidence-validation.size',
  'phase1.stage.evidence-validation.json',
  'phase1.stage.evidence-validation.duplicate-key',
  'phase1.stage.evidence-validation.possible-secret',
  'phase1.stage.evidence-validation.private-path',
  'phase1.stage.evidence-validation.forbidden-field',
  'phase1.stage.evidence-validation.non-json',
  'phase1.stage.evidence-validation.shape',
  'phase1.stage.evidence-validation.unknown',
  'phase1.stage.evidence-retention.failed',
  'phase1.stage.execution-root-cleanup.failed',
  'phase1.cave-authority.timeout',
  'phase1.cave-authority.output-limit',
  'phase1.cave-authority.spawn',
  'phase1.cave-authority.supervisor',
  'phase1.cave-authority.exit-nonzero',
  'phase1.cave-authority.assertion.admin',
  'phase1.cave-authority.assertion.discovery',
  'phase1.cave-authority.assertion.health',
  'phase1.cave-authority.assertion.ingress',
  'phase1.cave-authority.assertion.pairing',
  'phase1.cave-authority.assertion.reads',
  'phase1.cave-authority.assertion.revocation',
  'phase1.cave-authority.assertion.takeover',
  'phase1.cave-authority.assertion.harness',
  'phase1.cave-authority.assertion.hpke',
  'phase1.cave-authority.assertion.multiple',
  'phase1.cave-authority.assertion.unknown',
  'phase1.cave-authority.record.invalid',
  'phase1.cave-authority.record.incomplete',
  'phase1.packaging.authority.failed',
  'phase1.packaging.production-adapter.failed',
  'phase1.packaging.chat-install.failed',
  'phase1.packaging.chat-web-build.failed',
  'phase1.packaging.chat-native-build.failed',
  'phase1.packaging.chat-native-tests.failed',
  'phase1.packaging.native-test-home.invalid',
  'phase1.packaging.artifact-verification.failed',
  'phase1.packaging.cave-install.failed',
  'phase1.packaging.cave-build.failed',
  'phase1.packaging.cave-build.exit-nonzero',
  'phase1.packaging.cave-build.timeout',
  'phase1.packaging.cave-build.output-limit',
  'phase1.packaging.cave-build.spawn',
  'phase1.packaging.cave-build.supervisor',
  'phase1.packaging.cave-build.phase.prebuild',
  'phase1.packaging.cave-build.phase.conformance-wrapper',
  'phase1.packaging.cave-build.phase.next-build',
  'phase1.packaging.cave-build.phase.next-build.resource',
  'phase1.packaging.cave-build.phase.next-build.resource.spawn',
  'phase1.packaging.cave-build.phase.next-build.resource.memory',
  'phase1.packaging.cave-build.phase.next-build.resource.memory.heap',
  'phase1.packaging.cave-build.phase.next-build.resource.memory.allocation',
  'phase1.packaging.cave-build.phase.next-build.resource.killed',
  'phase1.packaging.cave-build.phase.next-build.compile',
  'phase1.packaging.cave-build.phase.next-build.compile.permission',
  'phase1.packaging.cave-build.phase.next-build.compile.module-resolution',
  'phase1.packaging.cave-build.phase.next-build.compile.native-module',
  'phase1.packaging.cave-build.phase.next-build.compile.plugin',
  'phase1.packaging.cave-build.phase.next-build.typescript',
  'phase1.packaging.cave-build.phase.next-build.page-data',
  'phase1.packaging.cave-build.phase.next-build.static-pages',
  'phase1.packaging.cave-build.phase.next-build.finalization',
  'phase1.packaging.cave-build.phase.server-bundle',
  'phase1.packaging.cave-build.phase.postbuild',
  'phase1.packaging.cave-build.phase.unknown',
  'phase1.packaging.coven-build.failed',
  'phase1.packaging.coven-tests.failed',
  'phase1.packaging.outputs.failed',
  ...['lib', 'health', 'doc'].flatMap((group) =>
    [
      'failed',
      'exit-nonzero',
      'cargo-failure',
      'malformed-output',
      'timeout',
      'output-limit',
      'spawn',
      'supervisor',
    ].map((reason) => `phase1.packaging.coven-client-${group}-tests.${reason}`),
  ),
  ...[
    'discovery',
    'error',
    'http',
    'lifecycle',
    'models',
    'status',
    'transport',
    'transport-unix',
    'transport-windows',
    'multiple-modules',
  ].map((module) => `phase1.packaging.coven-client-lib-tests.libtest.${module}`),
]);
const covenClientLibModules = new Set([
  'discovery',
  'error',
  'http',
  'lifecycle',
  'models',
  'status',
  'transport',
]);
const covenClientLifecycleTests = Object.freeze([
  'lifecycle::tests::lifecycle_discovery_does_not_hide_a_replaced_profile_home',
  'lifecycle::tests::lifecycle_discovery_preserves_socket_permission_errors',
  'lifecycle::tests::lifecycle_discovery_returns_none_when_the_prechecked_socket_is_unlinked',
  'lifecycle::tests::linux_identity_substitution_never_reaches_the_bound_signal',
  'lifecycle::tests::macos_legacy_shutdown_fails_closed_with_upgrade_guidance',
  'lifecycle::tests::macos_tmp_spellings_have_the_same_canonical_filesystem_identity',
  'lifecycle::tests::rediscovery_classifies_an_exact_selected_socket_unlink_as_unavailable',
]);
const replacedProfileLifecycleTest =
  'lifecycle::tests::lifecycle_discovery_does_not_hide_a_replaced_profile_home';
const replacedProfileFailureCategories = Object.freeze([
  ['bind selected lifecycle socket', 'socket-setup'],
  ['make selected socket private', 'socket-setup'],
  ['unlink selected socket after lifecycle pre-check', 'unlink-selected-socket'],
  ['move selected profile out of the way', 'move-selected-profile'],
  ['create substituted profile home', 'create-substituted-home'],
  ['make substituted profile private', 'create-substituted-home'],
  [
    'profile replacement must not be classified as a stopped daemon',
    'identity-substitution-accepted',
  ],
  ['assertion failed: matches!(error, crate::ClientError::Discovery(_))', 'wrong-error-class'],
  ['clean moved lifecycle test home', 'cleanup-moved-home'],
]);
publicPhase1DiagnosticIds.add(
  'phase1.packaging.coven-client-lib-tests.lifecycle.concurrency-or-order-dependent',
);
for (const testName of covenClientLifecycleTests) {
  publicPhase1DiagnosticIds.add(
    `phase1.packaging.coven-client-lib-tests.lifecycle.${testName.split('::').at(-1)}`,
  );
}
for (const [, category] of replacedProfileFailureCategories) {
  publicPhase1DiagnosticIds.add(
    `phase1.packaging.coven-client-lib-tests.lifecycle.replaced-profile.${category}`,
  );
}
publicPhase1DiagnosticIds.add(
  'phase1.packaging.coven-client-lib-tests.lifecycle.replaced-profile.unknown',
);

export function extractVerifiedRunnerDiagnostic(stderr) {
  if (typeof stderr !== 'string') {
    return undefined;
  }
  const diagnostics = new Set();
  for (const line of stripVTControlCharacters(stderr).split(/\r?\n/u)) {
    const match = /^phase1-conformance: (phase1\.[a-z0-9.-]+)$/u.exec(line);
    if (match !== null && publicPhase1DiagnosticIds.has(match[1])) {
      diagnostics.add(match[1]);
    }
  }
  return diagnostics.size === 1 ? [...diagnostics][0] : undefined;
}

export function publicPhase1FailureDiagnostic(error) {
  const pending = [error];
  const visited = new Set();
  for (let inspected = 0; pending.length > 0 && inspected < 32; inspected += 1) {
    const current = pending.shift();
    if (current === null || typeof current !== 'object' || visited.has(current)) {
      continue;
    }
    visited.add(current);
    if (
      'message' in current &&
      typeof current.message === 'string' &&
      publicPhase1DiagnosticIds.has(current.message)
    ) {
      return current.message;
    }
    if ('errors' in current && Array.isArray(current.errors)) {
      pending.push(...current.errors.slice(0, 16));
    }
    if ('cause' in current) {
      pending.push(current.cause);
    }
    if (
      'result' in current &&
      current.result !== null &&
      typeof current.result === 'object' &&
      'stderr' in current.result &&
      typeof current.result.stderr === 'string'
    ) {
      const diagnostic = extractVerifiedRunnerDiagnostic(current.result.stderr);
      if (diagnostic !== undefined) {
        return diagnostic;
      }
    }
  }
  return undefined;
}

export function throwCombinedPhase1Failures(primaryFailure, cleanupFailure, message) {
  const failures = [primaryFailure, cleanupFailure].filter((failure) => failure !== undefined);
  if (failures.length === 1) {
    throw failures[0];
  }
  if (failures.length > 1) {
    throw new AggregateError(failures, message);
  }
}

export function runnerCheckoutFailureDiagnostic(error) {
  if (
    error instanceof CommandExecutionError &&
    typeof error.result?.stderr === 'string' &&
    stripVTControlCharacters(error.result.stderr).includes(
      'detected dubious ownership in repository',
    )
  ) {
    return 'phase1.stage.runner-checkout.unsafe-source-owner';
  }
  if (error instanceof CommandExecutionError) {
    const suffixDiagnostics = [
      [' source reference', 'phase1.stage.runner-checkout.source-reference'],
      [' source revision', 'phase1.stage.runner-checkout.source-revision'],
      [' clone', 'phase1.stage.runner-checkout.clone'],
      [' checkout', 'phase1.stage.runner-checkout.checkout'],
    ];
    for (const [suffix, diagnostic] of suffixDiagnostics) {
      if (error.label.endsWith(suffix)) {
        return diagnostic;
      }
    }
  }
  if (
    error instanceof Error &&
    (error.message.endsWith(' source tag is unavailable or ambiguous.') ||
      error.message.endsWith(' source tag does not match the immutable revision.'))
  ) {
    return 'phase1.stage.runner-checkout.source-tag';
  }
  return 'phase1.stage.runner-checkout.failed';
}

function runPublicPhase1Stage(id, action) {
  try {
    return action();
  } catch (cause) {
    if (publicPhase1FailureDiagnostic(cause) !== undefined) {
      throw cause;
    }
    throw new Error(id, { cause });
  }
}

async function runPublicPhase1StageAsync(id, action) {
  try {
    return await action();
  } catch (cause) {
    if (publicPhase1FailureDiagnostic(cause) !== undefined) {
      throw cause;
    }
    throw new Error(id, { cause });
  }
}

export function classifyPackagingCommandFailure(baseId, error) {
  if (!(error instanceof CommandExecutionError)) {
    return `${baseId}.failed`;
  }
  const reason = error.result?.reason;
  if (reason === 'timeout') {
    return `${baseId}.timeout`;
  }
  if (reason === 'stdout-limit' || reason === 'stderr-limit' || reason === 'status-limit') {
    return `${baseId}.output-limit`;
  }
  if (reason === 'spawn' || reason === 'tracking') {
    return `${baseId}.spawn`;
  }
  if (reason === 'supervisor-termination' || reason === 'termination') {
    return `${baseId}.supervisor`;
  }
  if (typeof error.result?.code === 'number' && error.result.code !== 0) {
    if (baseId === 'phase1.packaging.cave-build') {
      const output = stripVTControlCharacters(
        `${error.result.stdout ?? ''}\n${error.result.stderr ?? ''}`,
      ).replaceAll('\r\n', '\n');
      let phase = 'unknown';
      if (/^> coven-cave@\d+\.\d+\.\d+ postbuild(?:\s+.+)?$/mu.test(output)) {
        phase = 'postbuild';
      } else if (/^> coven-cave@\d+\.\d+\.\d+ build:server(?:\s+.+)?$/mu.test(output)) {
        phase = 'server-bundle';
      } else if (output.includes('Creating an optimized production build')) {
        phase = /\bEAGAIN\b/u.test(output)
          ? 'next-build.resource.spawn'
          : /\bheap out of memory\b/iu.test(output)
            ? 'next-build.resource.memory.heap'
            : /\bENOMEM\b/u.test(output)
              ? 'next-build.resource.memory.allocation'
              : /\b(?:Killed(?:: 9)?|SIGKILL)\b/u.test(output)
                ? 'next-build.resource.killed'
                : output.includes('Finalizing page optimization')
                  ? 'next-build.finalization'
                  : output.includes('Generating static pages')
                    ? 'next-build.static-pages'
                    : output.includes('Collecting page data')
                      ? 'next-build.page-data'
                      : output.includes('Compiled successfully')
                        ? 'next-build.typescript'
                        : /\b(?:EACCES|EPERM)\b|permission denied|operation not permitted/iu.test(
                              output,
                            )
                          ? 'next-build.compile.permission'
                          : /module not found|can't resolve|cannot find module/iu.test(output)
                            ? 'next-build.compile.module-resolution'
                            : /failed to load external module|\bdlopen\(|mach-o.*(?:incompatible|not found)|image not found/iu.test(
                                  output,
                                )
                              ? 'next-build.compile.native-module'
                              : /error evaluating node\.js code|turbopack.*plugin.*(?:failed|error)/iu.test(
                                    output,
                                  )
                                ? 'next-build.compile.plugin'
                                : 'next-build.compile';
      } else if (/^> coven-cave@\d+\.\d+\.\d+ prebuild(?:\s+.+)?$/mu.test(output)) {
        phase = 'prebuild';
      } else if (/^> coven-cave@\d+\.\d+\.\d+ build:conformance(?:\s+.+)?$/mu.test(output)) {
        phase = 'conformance-wrapper';
      }
      return `${baseId}.phase.${phase}`;
    }
    if (baseId === 'phase1.packaging.coven-client-lib-tests') {
      const output = stripVTControlCharacters(
        `${error.result.stdout ?? ''}\n${error.result.stderr ?? ''}`,
      ).replaceAll('\r\n', '\n');
      const hasLibtestFailure =
        /^test result: FAILED\./mu.test(output) || /^failures:\s*$/mu.test(output);
      if (!hasLibtestFailure) {
        return `${baseId}.cargo-failure`;
      }
      const failedTests = new Set(
        [...output.matchAll(/^---- ([A-Za-z0-9_]+(?:::[A-Za-z0-9_]+)+) stdout ----$/gmu)].map(
          (match) => match[1],
        ),
      );
      const modules = new Set();
      for (const testName of failedTests) {
        const parts = testName.split('::');
        const top = parts[0];
        const platformTransport =
          top === 'transport' && (parts[1] === 'unix' || parts[1] === 'windows');
        const marker = parts[platformTransport ? 2 : 1];
        const leaf = parts[platformTransport ? 3 : 2];
        if (
          parts.length !== (platformTransport ? 4 : 3) ||
          !covenClientLibModules.has(top) ||
          leaf === undefined ||
          !/^[a-z0-9_]+$/u.test(leaf) ||
          marker !== 'tests'
        ) {
          return `${baseId}.malformed-output`;
        }
        modules.add(platformTransport ? `transport-${parts[1]}` : top);
      }
      if (modules.size === 1) {
        return `${baseId}.libtest.${[...modules][0]}`;
      }
      if (modules.size > 1) {
        return `${baseId}.libtest.multiple-modules`;
      }
      return `${baseId}.malformed-output`;
    }
    return `${baseId}.exit-nonzero`;
  }
  return `${baseId}.failed`;
}

async function runPackagingCommand(baseId, action) {
  try {
    return await action();
  } catch (cause) {
    throw new Error(classifyPackagingCommandFailure(baseId, cause), { cause });
  }
}

export async function diagnoseCovenLifecycleFailure(original, rerun) {
  if (
    classifyPackagingCommandFailure('phase1.packaging.coven-client-lib-tests', original) !==
    'phase1.packaging.coven-client-lib-tests.libtest.lifecycle'
  ) {
    throw original;
  }
  for (const testName of covenClientLifecycleTests) {
    try {
      await rerun(testName);
    } catch (error) {
      if (testName === replacedProfileLifecycleTest) {
        const output = stripVTControlCharacters(
          `${error?.result?.stdout ?? ''}\n${error?.result?.stderr ?? ''}`,
        ).replaceAll('\r\n', '\n');
        const category =
          replacedProfileFailureCategories.find(([message]) => output.includes(message))?.[1] ??
          'unknown';
        throw new Error(
          `phase1.packaging.coven-client-lib-tests.lifecycle.replaced-profile.${category}`,
          { cause: original },
        );
      }
      throw new Error(
        `phase1.packaging.coven-client-lib-tests.lifecycle.${testName.split('::').at(-1)}`,
        { cause: original },
      );
    }
  }
  throw new Error(
    'phase1.packaging.coven-client-lib-tests.lifecycle.concurrency-or-order-dependent',
    { cause: original },
  );
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

export function parseArgs(argv, runtime = {}) {
  const runtimeEnvironment = runtime.environment ?? process.env;
  const runtimePlatform = runtime.platform ?? process.platform;
  const runtimeArchitecture = runtime.architecture ?? process.arch;
  const runtimeCurrentUid = Object.hasOwn(runtime, 'currentUid')
    ? runtime.currentUid
    : typeof process.getuid === 'function'
      ? process.getuid()
      : undefined;
  const runtimeCgroupMembership = Object.hasOwn(runtime, 'cgroupMembership')
    ? runtime.cgroupMembership
    : runtimePlatform === 'linux'
      ? readFileSync('/proc/self/cgroup', 'utf8')
      : '';
  const options = {
    lockPath: resolve(projectRoot, 'phase1-conformance.lock.json'),
    scenario: 'all',
    retainSanitizedReport: defaultRetainedReport,
    platform: undefined,
    outputPath: undefined,
    validatorRevision: undefined,
    chatSourceRoot: resolve(process.env.OPENCOVEN_CHAT_ROOT ?? chatRepositoryRoot),
    sdkSourceRoot: defaultSourceRoot('OPENCOVEN_SDK_ROOT', 'sdk'),
    sdkEvidenceSourceRoot: defaultSourceRoot('OPENCOVEN_SDK_EVIDENCE_ROOT', 'sdk'),
    sdkValidatorSourceRoot: defaultSourceRoot('OPENCOVEN_SDK_VALIDATOR_ROOT', 'sdk'),
    caveSourceRoot: defaultSourceRoot('OPENCOVEN_CAVE_ROOT', 'coven-cave'),
    covenSourceRoot: defaultSourceRoot('OPENCOVEN_COVEN_ROOT', 'coven'),
    windowsSupervisorPath:
      process.env.OPENCOVEN_PHASE1_WINDOWS_SUPERVISOR_PATH === undefined
        ? undefined
        : resolve(process.env.OPENCOVEN_PHASE1_WINDOWS_SUPERVISOR_PATH),
  };

  const pathFlags = new Map([
    ['--lock', 'lockPath'],
    ['--retain-sanitized-report', 'retainSanitizedReport'],
    ['--chat-root', 'chatSourceRoot'],
    ['--sdk-root', 'sdkSourceRoot'],
    ['--sdk-evidence-root', 'sdkEvidenceSourceRoot'],
    ['--validator-root', 'sdkValidatorSourceRoot'],
    ['--cave-root', 'caveSourceRoot'],
    ['--coven-root', 'covenSourceRoot'],
    ['--windows-supervisor', 'windowsSupervisorPath'],
  ]);

  let retainedReportWasSet = false;
  let validatorRevisionWasSet = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      continue;
    }
    if (argument === '--scenario') {
      const scenario = requireString(argv[index + 1], '--scenario');
      if (scenario !== 'all') {
        throw new Error('only --scenario all is supported by Phase 1 conformance.');
      }
      options.scenario = scenario;
      index += 1;
      continue;
    }
    if (argument === '--platform') {
      const platform = requireString(argv[index + 1], '--platform');
      if (!Object.hasOwn(CANONICAL_PLATFORM_ENVIRONMENTS, platform)) {
        throw new Error(`unsupported schema-v2 platform ${platform}.`);
      }
      options.platform = platform;
      index += 1;
      continue;
    }
    if (argument === '--validator-revision') {
      if (validatorRevisionWasSet) {
        throw new Error('schema-v2 --validator-revision may be supplied only once.');
      }
      const revision = requireString(argv[index + 1], '--validator-revision');
      if (!/^[0-9a-f]{40}$/u.test(revision)) {
        throw new Error(
          '--validator-revision must be a lowercase immutable 40-character commit SHA.',
        );
      }
      options.validatorRevision = revision;
      validatorRevisionWasSet = true;
      index += 1;
      continue;
    }
    if (argument === '--output') {
      const output = requireString(argv[index + 1], '--output');
      options.outputPath =
        runtimePlatform === 'win32' ? windowsPath.resolve(output) : resolve(output);
      index += 1;
      continue;
    }
    const optionName = pathFlags.get(argument);
    if (optionName !== undefined) {
      options[optionName] = resolve(requireString(argv[index + 1], argument));
      if (argument === '--retain-sanitized-report') {
        retainedReportWasSet = true;
      }
      index += 1;
      continue;
    }
    throw new Error(`phase1-conformance: unknown option: ${argument}`);
  }

  if ((options.platform === undefined) !== (options.outputPath === undefined)) {
    throw new Error('schema-v2 --platform requires --output and vice versa.');
  }
  if (options.platform !== undefined) {
    if (options.validatorRevision === undefined) {
      throw new Error('schema-v2 --platform requires --validator-revision.');
    }
    if (retainedReportWasSet) {
      throw new Error(
        'schema-v2 --platform/--output cannot combine with --retain-sanitized-report.',
      );
    }
    if (options.platform !== `${runtimePlatform}-${runtimeArchitecture}`) {
      throw new Error('phase1.stage.invocation.platform-mismatch');
    }
    const supervisorEnvironment = schemaV2SupervisorEnvironment(
      runtimeEnvironment,
      runtimePlatform,
      runtimeArchitecture,
      runtimeCurrentUid,
      runtimeCgroupMembership,
    );
    const expectedOutput = supervisorArtifactOutputPath(supervisorEnvironment, runtimePlatform);
    if (options.outputPath !== expectedOutput) {
      throw new Error(
        runtimePlatform === 'win32'
          ? 'phase1.stage.invocation.windows-output-binding'
          : 'phase1.stage.invocation.unix-output-binding',
      );
    }
  } else if (options.validatorRevision !== undefined) {
    throw new Error('--validator-revision is only valid with schema-v2 --platform/--output.');
  }

  return options;
}

export function observeReleaseToolVersions() {
  const toolchain = runPublicPhase1Stage('phase1.environment.rust-toolchain.failed', () =>
    resolveRustToolchain(),
  );
  return validateObservedToolVersions({
    nodeVersion: process.version,
    pnpmVersion: runSupervisedSync('pnpm', ['--version'], {
      encoding: 'utf8',
    }).trim(),
    rustcVersion: runSupervisedSync(toolchain.rustcPath, ['--version'], {
      encoding: 'utf8',
    }).trim(),
  });
}

export function parseCaveConformanceOutput(output) {
  const assertions = new Map();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^(ok|FAIL|skip) ([a-z0-9./:-]+)(?:\s|$)/u.exec(line);
    if (match === null) {
      continue;
    }
    const [, marker, id] = match;
    if (assertions.has(id)) {
      throw new Error(`Cave conformance emitted duplicate assertion ID ${id}.`);
    }
    assertions.set(id, marker === 'ok' ? 'passed' : marker === 'FAIL' ? 'failed' : 'skipped');
  }
  return assertions;
}

export function parsePassedRustTests(output) {
  const passed = new Set();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^test ([A-Za-z0-9_:]+) \.\.\. ok$/u.exec(line.trim());
    if (match !== null) {
      passed.add(match[1]);
    }
  }
  return passed;
}

export function assertPairingStatus(value, expectedStatus) {
  const status = value?.status;
  if (status !== expectedStatus) {
    throw new Error(`pairing status was ${status ?? 'missing'} instead of ${expectedStatus}`);
  }
  return value;
}

function makeAssertion(id, status, diagnosticId) {
  return {
    id,
    status,
    diagnosticIds: [diagnosticId],
  };
}

function addAssertion(results, id, status, diagnosticId) {
  if (results.has(id)) {
    throw new Error(`Phase 1 conformance attempted to record ${id} more than once.`);
  }
  results.set(id, makeAssertion(id, status, diagnosticId));
}

function requirePassedAssertions(assertions, ids) {
  return ids.every((id) => assertions.get(id) === 'passed');
}

export function resolveRustupHome(environment = process.env) {
  const explicit = environment.RUSTUP_HOME;
  if (typeof explicit === 'string' && explicit.length > 0) {
    if (explicit.includes('\0') || !isAbsolute(explicit) || resolve(explicit) !== explicit) {
      throw new Error('phase1.environment.rustup-home.invalid');
    }
    return explicit;
  }
  const operatorHome = environment.HOME;
  if (
    typeof operatorHome !== 'string' ||
    operatorHome.length === 0 ||
    operatorHome.includes('\0') ||
    !isAbsolute(operatorHome) ||
    resolve(operatorHome) !== operatorHome
  ) {
    throw new Error('phase1.environment.rustup-home.invalid');
  }
  return resolve(operatorHome, '.rustup');
}

function resolveRustToolchain() {
  const triples = {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'win32-x64': 'x86_64-pc-windows-msvc',
  };
  const triple = triples[`${process.platform}-${process.arch}`];
  const rustupHome = resolveRustupHome();
  if (triple === undefined) {
    throw new Error('phase1.environment.rust-toolchain-mismatch');
  }
  const bin = resolve(rustupHome, 'toolchains', `1.95.0-${triple}`, 'bin');
  const cargoPath = runPublicPhase1Stage('phase1.environment.rustup-cargo.failed', () =>
    realpathSync(resolve(bin, process.platform === 'win32' ? 'cargo.exe' : 'cargo')),
  );
  const rustcPath = runPublicPhase1Stage('phase1.environment.rustup-rustc.failed', () =>
    realpathSync(resolve(bin, process.platform === 'win32' ? 'rustc.exe' : 'rustc')),
  );
  const rustdocPath = runPublicPhase1Stage('phase1.environment.rustup-rustdoc.failed', () =>
    realpathSync(resolve(bin, process.platform === 'win32' ? 'rustdoc.exe' : 'rustdoc')),
  );
  for (const path of [cargoPath, rustcPath, rustdocPath]) {
    if (!statSync(path).isFile() || dirname(path) !== bin) {
      throw new Error('phase1.environment.rust-toolchain-mismatch');
    }
  }
  return { cargoPath, rustcPath, rustdocPath };
}

export function safeEnvironment(rootPath, extra = {}) {
  const home = resolve(rootPath, 'home');
  const temp = resolve(rootPath, 'tmp');
  const cache = resolve(rootPath, 'cache');
  const config = resolve(home, '.config');
  const data = resolve(rootPath, 'data');
  const pnpmStore = resolve(rootPath, 'pnpm-store');
  const cargoHome = resolve(rootPath, 'cargo-home');
  const nativeLockRoot = resolve(rootPath, 'native-credential-lock');
  const toolchain = runPublicPhase1Stage('phase1.environment.rust-toolchain.failed', () =>
    resolveRustToolchain(),
  );
  const rustToolchainBin = dirname(toolchain.cargoPath);
  runPublicPhase1Stage('phase1.environment.directories.failed', () => {
    for (const path of [home, temp, cache, config, data, pnpmStore, cargoHome, nativeLockRoot]) {
      mkdirSync(path, { recursive: true, mode: 0o700 });
      chmodSync(path, 0o700);
    }
  });

  const environment = {
    PATH: `${rustToolchainBin}${delimiter}${process.env.PATH ?? ''}`,
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? '',
    HOME: home,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    NPM_CONFIG_USERCONFIG: devNull,
    NPM_CONFIG_PROXY: '',
    NPM_CONFIG_HTTPS_PROXY: '',
    PNPM_STORE_DIR: pnpmStore,
    CARGO_HOME: cargoHome,
    OPENCOVEN_PHASE1_CONFORMANCE_LOCK_ROOT: nativeLockRoot,
    RUSTC: toolchain.rustcPath,
    RUSTDOC: toolchain.rustdocPath,
    CI: '1',
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_GLOBAL: gitNullDevice,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    all_proxy: '',
    ...extra,
  };
  for (const name of [
    'SYSTEMROOT',
    'WINDIR',
    'COMSPEC',
    'PATHEXT',
    'OPENCOVEN_PHASE1_TEST_KEYCHAIN_ISOLATED',
    'PHASE1_TEST_KEYCHAIN',
  ]) {
    if (process.env[name] !== undefined) {
      environment[name] = process.env[name];
    }
  }
  return environment;
}

export function caveBuildEnvironment(environment) {
  return {
    ...environment,
    NODE_OPTIONS: caveBuildNodeOptions,
    CIRCLE_NODE_TOTAL: caveBuildReportedCpuTotal,
  };
}

export function validateSupervisorArtifactFile(path, metadata) {
  if (typeof path !== 'string' || !isAbsolute(path)) {
    throw new Error('Windows supervisor path must be absolute.');
  }
  const stats = lstatSync(path);
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.size !== metadata.size ||
    sha256File(path) !== metadata.sha256
  ) {
    throw new Error('Windows supervisor artifact does not match the immutable lock.');
  }
  return realpathSync(path);
}

function configureWindowsSupervisor(options, lock) {
  configuredWindowsSupervisorPath = undefined;
  configureSupervisedExecution();
  if (process.platform !== 'win32') {
    return;
  }
  const configured = options.windowsSupervisorPath;
  const metadata = lock.tools.windowsSupervisor.artifact;
  if (
    typeof configured !== 'string' ||
    !windowsPath.isAbsolute(configured) ||
    windowsPath.normalize(configured).toLowerCase() !==
      windowsPath.normalize(metadata.fleetPath).toLowerCase()
  ) {
    throw new Error('Windows supervisor must use the locked absolute fleet path.');
  }
  configuredWindowsSupervisorPath = validateSupervisorArtifactFile(configured, metadata);
  configureSupervisedExecution({ windowsSupervisor: configuredWindowsSupervisorPath });
}

export function bootstrapWindowsSupervisor(options) {
  const lock = readPhase1ConformanceLock(options.lockPath);
  configureWindowsSupervisor(options, lock);
  return lock;
}

export function assertNoNodeRuntimeInjection(
  environment = process.env,
  execArgv = process.execArgv,
) {
  const separateInjectionOptions = new Set([
    '-r',
    '--require',
    '--import',
    '--loader',
    '--experimental-loader',
    '--experimental-policy',
    '--policy-integrity',
    '--conditions',
  ]);
  const forbiddenArgument = execArgv.some((argument, index) => {
    const normalized = argument.toLowerCase();
    return (
      separateInjectionOptions.has(normalized) ||
      (normalized.startsWith('-r') && !normalized.startsWith('--') && normalized.length > 2) ||
      normalized.startsWith('--require=') ||
      normalized.startsWith('--import=') ||
      normalized.startsWith('--loader=') ||
      normalized.startsWith('--experimental-loader=') ||
      normalized.startsWith('--experimental-policy=') ||
      normalized.startsWith('--policy-integrity=') ||
      normalized.startsWith('--conditions=') ||
      argument === '-C' ||
      argument.startsWith('-C=') ||
      (index > 0 && separateInjectionOptions.has(execArgv[index - 1]?.toLowerCase()))
    );
  });
  if (
    forbiddenArgument ||
    forbiddenNodeEnvironment.some((name) => {
      const value = environment[name];
      return typeof value === 'string' && value.length > 0;
    })
  ) {
    throw new Error('Node runtime injection is forbidden for Phase 1 conformance.');
  }
}

function compactEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(([, value]) => typeof value === 'string'),
  );
}

export function createVerifiedRunnerEnvironment(
  options,
  harnessRoot,
  environment = process.env,
  runtime = {},
) {
  const runtimePlatform = runtime.platform ?? process.platform;
  const runtimeArchitecture = runtime.architecture ?? process.arch;
  const runtimeCurrentUid = Object.hasOwn(runtime, 'currentUid')
    ? runtime.currentUid
    : typeof process.getuid === 'function'
      ? process.getuid()
      : undefined;
  const runtimeCgroupMembership = Object.hasOwn(runtime, 'cgroupMembership')
    ? runtime.cgroupMembership
    : runtimePlatform === 'linux'
      ? readFileSync('/proc/self/cgroup', 'utf8')
      : '';
  const supervisionEnvironment =
    options.platform === undefined
      ? {}
      : schemaV2SupervisorEnvironment(
          environment,
          runtimePlatform,
          runtimeArchitecture,
          runtimeCurrentUid,
          runtimeCgroupMembership,
        );
  if (
    options.platform !== undefined &&
    options.outputPath !== supervisorArtifactOutputPath(supervisionEnvironment, runtimePlatform)
  ) {
    throw new Error('Schema-v2 verified runner output does not match its supervisor binding.');
  }
  return compactEnvironment({
    PATH: environment.PATH,
    HOME: environment.HOME,
    TMPDIR: environment.TMPDIR,
    LANG: environment.LANG,
    LC_ALL: environment.LC_ALL,
    CI: environment.CI,
    RUSTUP_HOME: environment.RUSTUP_HOME,
    CARGO_HOME: environment.CARGO_HOME,
    OPENCOVEN_CHAT_ROOT: options.chatSourceRoot,
    OPENCOVEN_SDK_ROOT: options.sdkSourceRoot,
    OPENCOVEN_SDK_EVIDENCE_ROOT: options.sdkEvidenceSourceRoot,
    OPENCOVEN_SDK_VALIDATOR_ROOT: options.sdkValidatorSourceRoot,
    OPENCOVEN_CAVE_ROOT: options.caveSourceRoot,
    OPENCOVEN_COVEN_ROOT: options.covenSourceRoot,
    OPENCOVEN_PHASE1_WINDOWS_SUPERVISOR_PATH: options.windowsSupervisorPath,
    OPENCOVEN_PHASE1_SECRET_SERVICE_ROOT: environment.OPENCOVEN_PHASE1_SECRET_SERVICE_ROOT,
    OPENCOVEN_PHASE1_SECRET_SERVICE_ROOT_IDENTITY:
      environment.OPENCOVEN_PHASE1_SECRET_SERVICE_ROOT_IDENTITY,
    OPENCOVEN_PHASE1_SECRET_SERVICE_ROOT_STAMP:
      environment.OPENCOVEN_PHASE1_SECRET_SERVICE_ROOT_STAMP,
    OPENCOVEN_PHASE1_TEST_KEYCHAIN_ISOLATED: environment.OPENCOVEN_PHASE1_TEST_KEYCHAIN_ISOLATED,
    PHASE1_TEST_KEYCHAIN: environment.PHASE1_TEST_KEYCHAIN,
    DBUS_SESSION_BUS_ADDRESS: environment.DBUS_SESSION_BUS_ADDRESS,
    GNOME_KEYRING_CONTROL: environment.GNOME_KEYRING_CONTROL,
    XDG_RUNTIME_DIR: environment.XDG_RUNTIME_DIR,
    XDG_DATA_HOME: environment.XDG_DATA_HOME,
    XDG_CONFIG_HOME: environment.XDG_CONFIG_HOME,
    ...supervisionEnvironment,
    [verifiedRunnerEnvironment]: '1',
    [verifiedRunnerRootEnvironment]: harnessRoot,
  });
}

export function assertExecutingHarnessAuthority(
  lock,
  executingRoot = projectRoot,
  environment = process.env,
) {
  return assertExecutingPhase1HarnessAuthority(lock, executingRoot, environment);
}

async function bootstrapVerifiedRunner(options) {
  const lock = runPublicPhase1Stage('phase1.stage.runner-lock.failed', () => {
    const locked = readPhase1ConformanceLock(options.lockPath);
    configureWindowsSupervisor(options, locked);
    return locked;
  });
  const bootstrapRoot = createProcessOwnedArtifactRoot({ prefix: 'p1boot', shortPath: true });
  let primaryFailure;
  try {
    const harnessRoot = resolve(bootstrapRoot.rootPath, 'harness');
    const environment = {
      ...process.env,
      ...createGitEnvironment(process.env),
    };
    await runPublicPhase1StageAsync('phase1.stage.runner-checkout.failed', async () => {
      try {
        await cloneExactCheckout({
          artifactRoot: bootstrapRoot,
          sourceRoot: options.chatSourceRoot,
          destinationRoot: harnessRoot,
          revision: lock.harness.revision,
          sourceRef: process.platform === 'win32' ? protectedHarnessTagRef : undefined,
          environment,
          label: 'Verified Chat conformance harness',
        });
      } catch (cause) {
        throw new Error(runnerCheckoutFailureDiagnostic(cause), { cause });
      }
    });
    runPublicPhase1Stage('phase1.stage.runner-checkout-verification.failed', () => {
      if (
        runSupervisedSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
          cwd: harnessRoot,
          encoding: 'utf8',
          env: createGitEnvironment(environment),
        }).length !== 0
      ) {
        throw new Error('Verified Chat conformance harness checkout is not clean.');
      }
    });
    const runner = resolve(harnessRoot, 'scripts', 'phase1-conformance.mjs');
    const verifiedArgs = [
      '--lock',
      options.lockPath,
      '--scenario',
      options.scenario,
      ...(options.platform === undefined
        ? ['--retain-sanitized-report', options.retainSanitizedReport]
        : [
            '--validator-revision',
            options.validatorRevision,
            '--platform',
            options.platform,
            '--output',
            options.outputPath,
          ]),
      '--chat-root',
      options.chatSourceRoot,
      '--sdk-root',
      options.sdkSourceRoot,
      '--sdk-evidence-root',
      options.sdkEvidenceSourceRoot,
      '--validator-root',
      options.sdkValidatorSourceRoot,
      '--cave-root',
      options.caveSourceRoot,
      '--coven-root',
      options.covenSourceRoot,
      ...(options.windowsSupervisorPath === undefined
        ? []
        : ['--windows-supervisor', options.windowsSupervisorPath]),
    ];
    const result = await runPublicPhase1StageAsync(
      'phase1.stage.verified-runner.failed',
      async () => {
        try {
          return await runCommand(
            bootstrapRoot,
            'Verified Phase 1 harness',
            process.execPath,
            [runner, ...verifiedArgs],
            {
              cwd: harnessRoot,
              env: createVerifiedRunnerEnvironment(options, harnessRoot),
              timeoutMs: cargoBuildTimeoutMs * 3,
            },
          );
        } catch (error) {
          if (publicPhase1FailureDiagnostic(error) !== undefined) {
            throw error;
          }
          if (error instanceof CommandExecutionError) {
            const reason = error.result?.reason;
            if (reason === 'timeout') {
              throw new Error('phase1.stage.verified-runner.timeout', { cause: error });
            }
            if (reason === 'stdout-limit' || reason === 'stderr-limit') {
              throw new Error('phase1.stage.verified-runner.output-limit', { cause: error });
            }
            if (reason === 'spawn' || reason === 'tracking') {
              throw new Error('phase1.stage.verified-runner.spawn', { cause: error });
            }
            if (reason === 'supervisor-termination' || reason === 'termination') {
              throw new Error('phase1.stage.verified-runner.supervisor', { cause: error });
            }
            if (typeof error.result?.code === 'number' && error.result.code !== 0) {
              throw new Error('phase1.stage.verified-runner.exit-nonzero', { cause: error });
            }
          }
          throw error;
        }
      },
    );
    process.stdout.write(result.stdout);
  } catch (error) {
    primaryFailure = error;
  }
  let cleanupFailure;
  try {
    await bootstrapRoot.cleanup();
  } catch (error) {
    cleanupFailure = new Error('phase1.stage.runner-bootstrap.failed', { cause: error });
  }
  throwCombinedPhase1Failures(
    primaryFailure,
    cleanupFailure,
    'Verified runner execution and cleanup both failed.',
  );
}

function runCommand(
  artifactRoot,
  label,
  command,
  args,
  { cwd, env, timeoutMs = commandTimeoutMs, outputLimitBytes = commandOutputLimit } = {},
) {
  const windowsSupervised = process.platform === 'win32';
  const supervisorPath = resolve(projectRoot, 'scripts', 'phase1-process-supervisor.mjs');
  const invocation = resolveExecutableInvocation(
    command,
    env ?? process.env,
    process.platform,
    args,
  );
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(
      windowsSupervised ? configuredWindowsSupervisorPath : process.execPath,
      windowsSupervised
        ? ['--', invocation.executable, ...invocation.args]
        : [
            supervisorPath,
            '--timeout-ms',
            String(timeoutMs),
            '--invocation-path',
            invocation.executable,
            '--',
            invocation.resolvedCommand,
            ...invocation.args,
          ],
      {
        cwd,
        detached: !windowsSupervised,
        env,
        stdio: windowsSupervised ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', 'pipe'],
      },
    );
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const supervisorStatus = [];
    let supervisorStatusBytes = 0;
    let settled = false;
    let timer;
    let terminationReason;

    const fail = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      rejectRun(new CommandExecutionError(label, result));
    };

    child.once('spawn', () => {
      try {
        child.__phase1SupervisorOwnsTree = !windowsSupervised;
        artifactRoot.trackChild(child);
      } catch {
        child.kill('SIGTERM');
        fail({ code: null, signal: 'SIGKILL', stdout: '', stderr: '', reason: 'tracking' });
      }
    });
    child.once('error', () => {
      fail({ code: null, signal: null, stdout: '', stderr: '', reason: 'spawn' });
    });
    const requestTermination = (reason) => {
      if (terminationReason !== undefined) {
        return;
      }
      terminationReason = reason;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (!child.kill('SIGTERM') && child.exitCode === null && child.signalCode === null) {
        fail({ code: null, signal: null, stdout: '', stderr: '', reason: 'termination' });
      }
    };
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > outputLimitBytes) {
        requestTermination('stdout-limit');
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > outputLimitBytes) {
        requestTermination('stderr-limit');
        return;
      }
      stderr.push(chunk);
    });
    if (!windowsSupervised) {
      child.stdio[3].on('data', (chunk) => {
        supervisorStatusBytes += chunk.length;
        if (supervisorStatusBytes > 256) {
          requestTermination('status-limit');
          return;
        }
        supervisorStatus.push(chunk);
      });
    }
    child.once('close', (_code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (windowsSupervised) {
        const result = {
          code: _code,
          signal,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        };
        if (_code === 0) {
          resolveRun(result);
        } else {
          rejectRun(new CommandExecutionError(label, result));
        }
        return;
      }
      let supervisedStatus;
      try {
        supervisedStatus = parseSupervisorStatusFrame(Buffer.concat(supervisorStatus));
      } catch {
        rejectRun(
          new CommandExecutionError(label, {
            code: null,
            signal,
            stdout: '',
            stderr: '',
            reason: 'spawn',
          }),
        );
        return;
      }

      const result = {
        code: supervisedStatus.code,
        signal: supervisedStatus.signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        ...(supervisedStatus.reason === 'exit' ? {} : { reason: supervisedStatus.reason }),
      };
      if (_code !== null || signal !== 'SIGKILL') {
        rejectRun(
          new CommandExecutionError(label, {
            ...result,
            reason: 'supervisor-termination',
          }),
        );
        return;
      }
      if (terminationReason !== undefined) {
        rejectRun(
          new CommandExecutionError(label, {
            ...result,
            reason: terminationReason,
          }),
        );
        return;
      }
      if (supervisedStatus.reason === 'exit' && supervisedStatus.code === 0) {
        resolveRun(result);
      } else {
        rejectRun(new CommandExecutionError(label, result));
      }
    });
    if (windowsSupervised) {
      timer = setTimeout(() => {
        requestTermination('timeout');
      }, timeoutMs);
    }
  });
}

export function runSupervisedCommandForTest(artifactRoot, command, args, options) {
  return runCommand(artifactRoot, 'Supervised test command', command, args, options);
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha256Tree(rootPath) {
  const digest = createHash('sha256');
  const visit = (directoryPath, relativeRoot = '') => {
    for (const entry of readdirSync(directoryPath, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const relativePath = relativeRoot.length === 0 ? entry.name : `${relativeRoot}/${entry.name}`;
      const entryPath = resolve(directoryPath, entry.name);
      const stats = lstatSync(entryPath);
      if (stats.isSymbolicLink()) {
        throw new Error('Packaged artifact tree contains a symlink.');
      }
      if (stats.isDirectory()) {
        visit(entryPath, relativePath);
      } else if (stats.isFile()) {
        digest.update(relativePath);
        digest.update('\0');
        digest.update(readFileSync(entryPath));
        digest.update('\0');
      } else {
        throw new Error('Packaged artifact tree contains a non-regular entry.');
      }
    }
  };
  visit(rootPath);
  return digest.digest('hex');
}

function assertLockedRegularFile(rootPath, metadata, label) {
  const path = resolve(rootPath, metadata.path ?? metadata.vendorFile);
  const stats = lstatSync(path);
  if (
    stats.isSymbolicLink() ||
    !stats.isFile() ||
    stats.size !== metadata.size ||
    sha256File(path) !== metadata.sha256
  ) {
    throw new Error(`${label} does not match the immutable conformance lock.`);
  }
  return path;
}

export async function cloneExactCheckout({
  artifactRoot,
  sourceRoot,
  destinationRoot,
  revision,
  sourceRef,
  environment,
  label,
}) {
  if (!statSync(sourceRoot).isDirectory()) {
    throw new Error(`${label} source root is unavailable.`);
  }
  const sourceSafeDirectory = realpathSync(sourceRoot);
  const sourceGitDirectory = resolveLocalGitDirectory(sourceRoot);
  const checkoutEnvironment = createGitCheckoutEnvironment(environment);
  let cloneSourceArguments = [];
  let protectedSourceReference;
  if (sourceRef !== undefined) {
    if (sourceRef !== protectedHarnessTagRef) {
      throw new Error(`${label} source reference is not approved.`);
    }
    const tagName = sourceRef.slice('refs/tags/'.length);
    protectedSourceReference = {
      tagName,
      tagRef: sourceRef,
      localHeadRef: `refs/heads/${tagName}`,
      remoteHeadRef: `refs/remotes/origin/${tagName}`,
    };
    cloneSourceArguments = ['--branch', tagName];
  }
  await runCommand(
    artifactRoot,
    `${label} clone`,
    'git',
    [
      '-c',
      'credential.helper=',
      '-c',
      `core.hooksPath=${devNull}`,
      '-c',
      `safe.directory=${sourceSafeDirectory}`,
      '-c',
      `safe.directory=${sourceGitDirectory}`,
      'clone',
      '--local',
      '--no-hardlinks',
      '--no-checkout',
      '--quiet',
      ...cloneSourceArguments,
      sourceRoot,
      destinationRoot,
    ],
    {
      cwd: projectRoot,
      env: {
        ...checkoutEnvironment,
        GIT_ALLOW_PROTOCOL: 'file',
      },
    },
  );
  if (protectedSourceReference !== undefined) {
    const sourceRefs = (
      await runCommand(
        artifactRoot,
        `${label} source reference`,
        'git',
        [
          '-c',
          `core.hooksPath=${devNull}`,
          'for-each-ref',
          '--format=%(refname)',
          protectedSourceReference.tagRef,
          protectedSourceReference.localHeadRef,
          protectedSourceReference.remoteHeadRef,
        ],
        { cwd: destinationRoot, env: checkoutEnvironment },
      )
    ).stdout
      .split(/\r?\n/u)
      .filter(Boolean);
    if (
      !sourceRefs.includes(protectedSourceReference.tagRef) ||
      sourceRefs.includes(protectedSourceReference.localHeadRef) ||
      sourceRefs.includes(protectedSourceReference.remoteHeadRef)
    ) {
      throw new Error(`${label} source tag is unavailable or ambiguous.`);
    }
    const sourceCommit = (
      await runCommand(
        artifactRoot,
        `${label} source revision`,
        'git',
        [
          '-c',
          `core.hooksPath=${devNull}`,
          'rev-parse',
          '--verify',
          `${protectedSourceReference.tagRef}^{commit}`,
        ],
        { cwd: destinationRoot, env: checkoutEnvironment },
      )
    ).stdout.trim();
    if (sourceCommit !== revision) {
      throw new Error(`${label} source tag does not match the immutable revision.`);
    }
  }
  await runCommand(
    artifactRoot,
    `${label} checkout`,
    'git',
    ['-c', `core.hooksPath=${devNull}`, 'checkout', '--detach', '--force', revision],
    { cwd: destinationRoot, env: checkoutEnvironment },
  );
}

async function createExactCheckouts(artifactRoot, options, lock, environment) {
  const checkoutsRoot = resolve(artifactRoot.rootPath, 'checkouts');
  mkdirSync(checkoutsRoot, { mode: 0o700 });
  const roots = {
    chatRoot: resolve(checkoutsRoot, 'chat'),
    chatHarnessRoot: resolve(checkoutsRoot, 'chat-harness'),
    sdkRoot: resolve(checkoutsRoot, 'sdk'),
    sdkEvidenceRoot: resolve(checkoutsRoot, 'sdk-evidence'),
    caveRoot: resolve(checkoutsRoot, 'cave'),
    covenRoot: resolve(checkoutsRoot, 'coven'),
  };
  await cloneExactCheckout({
    artifactRoot,
    sourceRoot: options.chatSourceRoot,
    destinationRoot: roots.chatRoot,
    revision: lock.chat.revision,
    environment,
    label: 'Chat',
  });
  await cloneExactCheckout({
    artifactRoot,
    sourceRoot: options.chatSourceRoot,
    destinationRoot: roots.chatHarnessRoot,
    revision: lock.harness.revision,
    environment,
    label: 'Chat conformance harness',
  });
  await cloneExactCheckout({
    artifactRoot,
    sourceRoot: options.sdkSourceRoot,
    destinationRoot: roots.sdkRoot,
    revision: lock.sdk.revision,
    environment,
    label: 'SDK',
  });
  await cloneExactCheckout({
    artifactRoot,
    sourceRoot: options.sdkEvidenceSourceRoot,
    destinationRoot: roots.sdkEvidenceRoot,
    revision: lock.evidence.revision,
    environment,
    label: 'SDK evidence authority',
  });
  await cloneExactCheckout({
    artifactRoot,
    sourceRoot: options.caveSourceRoot,
    destinationRoot: roots.caveRoot,
    revision: lock.cave.revision,
    environment,
    label: 'Cave',
  });
  await cloneExactCheckout({
    artifactRoot,
    sourceRoot: options.covenSourceRoot,
    destinationRoot: roots.covenRoot,
    revision: lock.coven.revision,
    environment,
    label: 'Coven',
  });
  assertCleanPhase1Checkouts(roots);
  assertPhase1CheckoutHeads(lock, roots);
  return roots;
}

async function installPnpm(artifactRoot, rootPath, environment, label) {
  await runCommand(
    artifactRoot,
    `${label} dependency install`,
    'pnpm',
    [
      '--ignore-workspace',
      'install',
      '--frozen-lockfile',
      `--config.store-dir=${environment.PNPM_STORE_DIR}`,
    ],
    { cwd: rootPath, env: environment },
  );
}

export function nativeAdapterTestEnvironment(
  environment,
  platform = process.platform,
  operatorEnvironment = process.env,
) {
  if (platform !== 'darwin') {
    return environment;
  }
  const operatorHome = operatorEnvironment.HOME;
  if (
    typeof operatorHome !== 'string' ||
    operatorHome.length === 0 ||
    operatorHome.includes('\0') ||
    !isAbsolute(operatorHome) ||
    resolve(operatorHome) !== operatorHome
  ) {
    throw new Error('phase1.packaging.native-test-home.invalid');
  }
  return { ...environment, HOME: operatorHome };
}

export function assertProductionAdapterAtRevision(harnessRoot, lock) {
  assertPhase1ProducerAuthority(lock, harnessRoot);
  const covenPath = 'src-tauri/src/coven.rs';
  const releaseSource = runSupervisedSync('git', ['show', `${lock.chat.revision}:${covenPath}`], {
    cwd: harnessRoot,
    encoding: 'utf8',
    env: createGitEnvironment(),
  });
  const harnessSource = readFileSync(resolve(harnessRoot, covenPath), 'utf8');
  const productionPrefix = (source) => source.split('\n#[cfg(test)]\nmod tests {', 1)[0];
  if (productionPrefix(releaseSource) !== productionPrefix(harnessSource)) {
    throw new Error('Chat production Coven adapter differs from the locked release commit.');
  }
}

function assertProductionChatAuthority(roots, lock) {
  const tree = runSupervisedSync('git', ['rev-parse', 'HEAD^{tree}'], {
    cwd: roots.chatRoot,
    encoding: 'utf8',
    env: createGitEnvironment(),
  }).trim();
  if (tree !== lock.chatAuthority.tree) {
    throw new Error('Production Chat tree does not match the immutable authority lock.');
  }
  for (const file of lock.chatAuthority.files) {
    const path = resolve(roots.chatRoot, file.path);
    const stats = lstatSync(path);
    const blob = runSupervisedSync('git', ['rev-parse', `HEAD:${file.path}`], {
      cwd: roots.chatRoot,
      encoding: 'utf8',
      env: createGitEnvironment(),
    }).trim();
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      blob !== file.blob ||
      sha256File(path) !== file.sha256
    ) {
      throw new Error('Production Chat authority file does not match its locked blob.');
    }
  }
  try {
    runSupervisedSync(
      'git',
      ['merge-base', '--is-ancestor', lock.chat.revision, lock.harness.revision],
      {
        cwd: roots.chatHarnessRoot,
        env: createGitEnvironment(),
        stdio: 'ignore',
      },
    );
  } catch {
    throw new Error('Chat conformance harness must descend from the production revision.');
  }
}

function assertWindowsSupervisorSource(roots, lock) {
  const source = lock.tools.windowsSupervisor.source;
  const blob = runSupervisedSync('git', ['rev-parse', `${source.revision}:${source.path}`], {
    cwd: roots.chatHarnessRoot,
    encoding: 'utf8',
    env: createGitEnvironment(),
  }).trim();
  const bytes = runSupervisedSync('git', ['show', `${source.revision}:${source.path}`], {
    cwd: roots.chatHarnessRoot,
    encoding: 'buffer',
    env: createGitEnvironment(),
  });
  if (blob !== source.blob || createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
    throw new Error('Windows supervisor source does not match the immutable lock.');
  }
  for (const [path, expected] of [
    ['tools/phase1-process-supervisor/Cargo.toml', source.manifestSha256],
    ['tools/phase1-process-supervisor/Cargo.lock', source.lockSha256],
    ['tools/phase1-process-supervisor/.cargo/config.toml', source.configSha256],
  ]) {
    const input = runSupervisedSync('git', ['show', `${source.revision}:${path}`], {
      cwd: roots.chatHarnessRoot,
      encoding: 'buffer',
      env: createGitEnvironment(),
    });
    if (createHash('sha256').update(input).digest('hex') !== expected) {
      throw new Error('Windows supervisor build input does not match the immutable lock.');
    }
  }
}

function assertSdkCandidateProvenance(roots, lock) {
  try {
    runSupervisedSync(
      'git',
      [
        '-C',
        roots.sdkEvidenceRoot,
        'merge-base',
        '--is-ancestor',
        lock.sdk.revision,
        lock.evidence.revision,
      ],
      { env: createGitEnvironment(), stdio: 'ignore' },
    );
  } catch {
    throw new Error('SDK evidence authority does not descend from the package candidate.');
  }
  const sourcePackages = [
    ['packages/core/package.json', '@opencoven/sdk-core'],
    ['packages/cave/package.json', '@opencoven/cave-client'],
    ['packages/coven/package.json', '@opencoven/coven-client'],
    ['packages/sdk/package.json', '@opencoven/sdk'],
  ];
  for (let index = 0; index < sourcePackages.length; index += 1) {
    const [relativePath, packageName] = sourcePackages[index];
    const manifest = JSON.parse(readFileSync(resolve(roots.sdkRoot, relativePath), 'utf8'));
    const artifact = lock.release.sdkArtifacts[index];
    if (
      manifest.name !== packageName ||
      manifest.version !== lock.release.sdkManifest.version ||
      artifact.packageName !== packageName
    ) {
      throw new Error('SDK candidate package identity does not match frozen artifacts.');
    }
  }
}

async function packageLockedArtifacts(artifactRoot, roots, environment, lock) {
  runPublicPhase1Stage('phase1.packaging.authority.failed', () => {
    assertProductionChatAuthority(roots, lock);
    assertWindowsSupervisorSource(roots, lock);
    assertSdkCandidateProvenance(roots, lock);
  });
  await runPublicPhase1StageAsync('phase1.packaging.chat-install.failed', () =>
    installPnpm(artifactRoot, roots.chatRoot, environment, 'Chat'),
  );
  await runPublicPhase1StageAsync('phase1.packaging.chat-web-build.failed', () =>
    runCommand(artifactRoot, 'Chat web package', 'pnpm', ['--ignore-workspace', 'build'], {
      cwd: roots.chatRoot,
      env: environment,
    }),
  );
  const chatTarget = resolve(artifactRoot.rootPath, 'build', 'chat-target');
  mkdirSync(chatTarget, { recursive: true, mode: 0o700 });
  runPublicPhase1Stage('phase1.packaging.production-adapter.failed', () =>
    assertProductionAdapterAtRevision(roots.chatHarnessRoot, lock),
  );
  await runPublicPhase1StageAsync('phase1.packaging.chat-native-build.failed', () =>
    runCommand(
      artifactRoot,
      'Chat native RPC package',
      'cargo',
      [
        'build',
        '--locked',
        '--manifest-path',
        resolve(roots.chatHarnessRoot, 'src-tauri', 'Cargo.toml'),
        '--features',
        'phase1-conformance',
        '--bin',
        'phase1-native-rpc',
      ],
      {
        cwd: roots.chatHarnessRoot,
        env: { ...environment, CARGO_TARGET_DIR: chatTarget },
        timeoutMs: cargoBuildTimeoutMs,
      },
    ),
  );
  const chatTestResult = await runPublicPhase1StageAsync(
    'phase1.packaging.chat-native-tests.failed',
    () =>
      runCommand(
        artifactRoot,
        'Chat native adapter tests',
        'cargo',
        [
          'test',
          '--locked',
          '--manifest-path',
          resolve(roots.chatHarnessRoot, 'src-tauri', 'Cargo.toml'),
          '--features',
          'phase1-conformance',
          '--lib',
          '--test',
          'coven_health_process_boundary',
          '--test',
          'phase1_native_rpc',
        ],
        {
          cwd: roots.chatHarnessRoot,
          env: {
            ...nativeAdapterTestEnvironment(environment),
            CARGO_TARGET_DIR: chatTarget,
          },
          timeoutMs: cargoBuildTimeoutMs,
        },
      ),
  );

  const frozenTarballs = runPublicPhase1Stage('phase1.packaging.artifact-verification.failed', () =>
    lock.release.sdkArtifacts.map((sdkArtifact) =>
      assertLockedRegularFile(
        resolve(roots.chatRoot, 'vendor', 'opencoven-sdk'),
        sdkArtifact,
        sdkArtifact.packageName,
      ),
    ),
  );
  runPublicPhase1Stage('phase1.packaging.artifact-verification.failed', () => {
    assertLockedRegularFile(roots.chatRoot, lock.release.consumerLock, 'Chat consumer lock');
    for (const [name, metadata] of Object.entries(lock.release.caveArtifacts)) {
      assertLockedRegularFile(roots.caveRoot, metadata, `Cave ${name}`);
    }
  });

  await runPublicPhase1StageAsync('phase1.packaging.cave-install.failed', () =>
    installPnpm(artifactRoot, roots.caveRoot, environment, 'Cave'),
  );
  await runPackagingCommand('phase1.packaging.cave-build', () =>
    runCommand(
      artifactRoot,
      'Cave authority server package',
      'pnpm',
      ['--ignore-workspace', 'build'],
      {
        cwd: roots.caveRoot,
        env: caveBuildEnvironment(environment),
      },
    ),
  );

  const covenTarget = resolve(artifactRoot.rootPath, 'build', 'coven-target');
  mkdirSync(covenTarget, { recursive: true, mode: 0o700 });
  await runPublicPhase1StageAsync('phase1.packaging.coven-build.failed', () =>
    runCommand(
      artifactRoot,
      'Coven CLI package',
      'cargo',
      ['build', '--locked', '--package', 'coven-cli', '--bin', 'coven'],
      {
        cwd: roots.covenRoot,
        env: { ...environment, CARGO_TARGET_DIR: covenTarget },
        timeoutMs: cargoBuildTimeoutMs,
      },
    ),
  );
  const covenTestEnvironment = {
    ...environment,
    CARGO_TARGET_DIR: covenTarget,
    TMPDIR: dirname(artifactRoot.rootPath),
    TMP: dirname(artifactRoot.rootPath),
    TEMP: dirname(artifactRoot.rootPath),
  };
  const covenTestResults = [];
  try {
    covenTestResults.push(
      await runPackagingCommand('phase1.packaging.coven-client-lib-tests', () =>
        runCommand(
          artifactRoot,
          'Coven producer client lib tests',
          'cargo',
          ['test', '--locked', '--package', 'coven-client', '--lib'],
          {
            cwd: roots.covenRoot,
            env: covenTestEnvironment,
            timeoutMs: cargoBuildTimeoutMs,
          },
        ),
      ),
    );
  } catch (error) {
    if (
      publicPhase1FailureDiagnostic(error) !==
      'phase1.packaging.coven-client-lib-tests.libtest.lifecycle'
    ) {
      throw error;
    }
    await diagnoseCovenLifecycleFailure(error.cause ?? error, (testName) =>
      runCommand(
        artifactRoot,
        'Coven producer client lifecycle diagnostic',
        'cargo',
        ['test', '--locked', '--package', 'coven-client', '--lib', testName, '--', '--exact'],
        {
          cwd: roots.covenRoot,
          env: covenTestEnvironment,
          timeoutMs: cargoBuildTimeoutMs,
        },
      ),
    );
  }
  for (const [group, args] of [
    [
      'health',
      [
        'test',
        '--locked',
        '--package',
        'coven-client',
        '--test',
        'health',
        '--',
        '--test-threads=1',
      ],
    ],
    ['doc', ['test', '--locked', '--package', 'coven-client', '--doc']],
  ]) {
    covenTestResults.push(
      await runPackagingCommand(`phase1.packaging.coven-client-${group}-tests`, () =>
        runCommand(artifactRoot, `Coven producer client ${group} tests`, 'cargo', args, {
          cwd: roots.covenRoot,
          env: covenTestEnvironment,
          timeoutMs: cargoBuildTimeoutMs,
        }),
      ),
    );
  }

  const executableSuffix = process.platform === 'win32' ? '.exe' : '';
  const nativeRpcPath = resolve(chatTarget, 'debug', `phase1-native-rpc${executableSuffix}`);
  const covenBinaryPath = resolve(covenTarget, 'debug', `coven${executableSuffix}`);
  runPublicPhase1Stage('phase1.packaging.outputs.failed', () => {
    for (const [label, path] of [
      ['Chat native RPC', nativeRpcPath],
      ['Coven CLI', covenBinaryPath],
    ]) {
      const stats = lstatSync(path);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw new Error(`${label} package is not a regular file.`);
      }
    }
  });

  return {
    nativeRpcPath,
    covenBinaryPath,
    artifactDigests: {
      chatWebBundle: sha256Tree(resolve(roots.chatRoot, 'dist')),
      chatNativeRpc: sha256File(nativeRpcPath),
      caveServer: sha256File(resolve(roots.caveRoot, 'server.mjs')),
      covenCli: sha256File(covenBinaryPath),
      sdkTarballs: lock.release.sdkArtifacts.map((sdkArtifact, index) => ({
        packageName: sdkArtifact.packageName,
        sha256: sha256File(frozenTarballs[index]),
      })),
    },
    passedRustTests: new Set([
      ...parsePassedRustTests(`${chatTestResult.stdout}\n${chatTestResult.stderr}`),
      ...covenTestResults.flatMap((result) => [
        ...parsePassedRustTests(`${result.stdout}\n${result.stderr}`),
      ]),
    ]),
  };
}

async function runCaveAuthorityMatrix(artifactRoot, caveRoot, environment) {
  const recordPath = resolve(artifactRoot.rootPath, 'cave-record.json');
  let result;
  try {
    result = await runCommand(
      artifactRoot,
      'Cave real-authority conformance',
      process.execPath,
      [
        resolve(caveRoot, 'scripts', 'client-v1-conformance.mjs'),
        '--include-ttl',
        '--include-authority-takeover',
        '--out',
        recordPath,
      ],
      {
        cwd: caveRoot,
        env: environment,
        timeoutMs: caveConformanceTimeoutMs,
      },
    );
  } catch (error) {
    if (error instanceof CommandExecutionError) {
      const reason = error.result?.reason;
      if (reason === 'timeout') {
        throw new Error('phase1.cave-authority.timeout', { cause: error });
      }
      if (reason === 'stdout-limit' || reason === 'stderr-limit') {
        throw new Error('phase1.cave-authority.output-limit', { cause: error });
      }
      if (reason === 'spawn' || reason === 'tracking') {
        throw new Error('phase1.cave-authority.spawn', { cause: error });
      }
      if (reason === 'supervisor-termination' || reason === 'termination') {
        throw new Error('phase1.cave-authority.supervisor', { cause: error });
      }
      if (typeof error.result?.code === 'number' && error.result.code !== 0) {
        const assertions = parseCaveConformanceOutput(
          `${error.result.stdout ?? ''}\n${error.result.stderr ?? ''}`,
        );
        const categories = new Set(
          [...assertions.entries()]
            .filter(([, status]) => status === 'failed')
            .map(([id]) => id.split(/[./]/u, 1)[0])
            .filter((category) =>
              [
                'admin',
                'discovery',
                'health',
                'ingress',
                'pairing',
                'reads',
                'revocation',
                'takeover',
                'harness',
                'hpke',
              ].includes(category),
            ),
        );
        const diagnostic =
          categories.size > 1
            ? 'phase1.cave-authority.assertion.multiple'
            : categories.size === 1
              ? `phase1.cave-authority.assertion.${[...categories][0]}`
              : assertions.size > 0
                ? 'phase1.cave-authority.assertion.unknown'
                : 'phase1.cave-authority.exit-nonzero';
        throw new Error(diagnostic, { cause: error });
      }
    }
    throw error;
  }
  let record;
  try {
    record = JSON.parse(readFileSync(recordPath, 'utf8'));
  } catch (error) {
    throw new Error('phase1.cave-authority.record.invalid', { cause: error });
  }
  if (
    record?.summary?.failed !== 0 ||
    record?.summary?.skipped !== 0 ||
    !Array.isArray(record?.assertions) ||
    record.assertions.some((assertion) => assertion.result !== 'pass')
  ) {
    throw new Error('phase1.cave-authority.record.incomplete');
  }
  return {
    assertions: parseCaveConformanceOutput(result.stdout),
    record,
  };
}

function requestJson(origin, { method = 'GET', path, headers = {}, body }) {
  return new Promise((resolveRequest, rejectRequest) => {
    const endpoint = new URL(path, origin);
    const request = httpRequest(
      {
        hostname: endpoint.hostname,
        port: endpoint.port,
        method,
        path: `${endpoint.pathname}${endpoint.search}`,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }),
        },
      },
      (response) => {
        const chunks = [];
        let total = 0;
        response.on('data', (chunk) => {
          total += chunk.length;
          if (total > 4 * 1024 * 1024) {
            response.destroy(new Error('response-size-limit'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', rejectRequest);
        response.once('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            rejectRequest(new Error('invalid-json-response'));
            return;
          }
          resolveRequest({
            status: response.statusCode ?? 0,
            headers: response.headers,
            json,
          });
        });
      },
    );
    request.once('error', rejectRequest);
    request.setTimeout(rpcTimeoutMs, () => request.destroy(new Error('request-timeout')));
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

function startFixtureDaemon(roster) {
  const server = createServer((request, response) => {
    if (request.url === '/api/v1/familiars') {
      const body = JSON.stringify(roster);
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      response.end(body);
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"error":"not_found"}');
  });
  return new Promise((resolveServer, rejectServer) => {
    server.once('error', rejectServer);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolveServer({
        url: `http://127.0.0.1:${address.port}`,
        async close() {
          await new Promise((resolveClose, rejectClose) =>
            server.close((error) => (error ? rejectClose(error) : resolveClose())),
          );
        },
      });
    });
  });
}

function writeNativeFixture(caveHome, covenHome, daemonUrl) {
  mkdirSync(caveHome, { recursive: true, mode: 0o700 });
  mkdirSync(covenHome, { recursive: true, mode: 0o700 });
  writeFileSync(
    resolve(caveHome, 'config.json'),
    `${JSON.stringify({
      version: 1,
      multiHost: { mode: 'hub', hubUrl: daemonUrl, executorUrls: [] },
    })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    resolve(caveHome, 'projects.json'),
    `${JSON.stringify({
      version: 1,
      projects: [
        {
          id: 'project-01',
          name: 'Fixture 01',
          root: '/phase1/project-01',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-02-01T00:00:00.000Z',
        },
        {
          id: 'project-02',
          name: 'Fixture 02',
          root: '/phase1/project-02',
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-02-02T00:00:00.000Z',
        },
        {
          id: 'project-03',
          name: 'Fixture 03',
          root: '/phase1/project-03',
          createdAt: '2026-01-03T00:00:00.000Z',
          updatedAt: '2026-02-03T00:00:00.000Z',
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  const conversations = resolve(caveHome, 'conversations');
  mkdirSync(conversations, { mode: 0o700 });
  for (const conversation of [
    {
      sessionId: 'conversation-01',
      familiarId: 'archivist',
      createdAt: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
      turns: [
        {
          id: 'c1-root',
          parentId: null,
          role: 'user',
          text: 'synthetic prompt',
          createdAt: '2026-03-01T00:00:00.000Z',
        },
      ],
      activeLeafId: 'c1-root',
    },
    {
      sessionId: 'branched',
      familiarId: 'archivist',
      createdAt: '2026-03-02T00:00:00.000Z',
      updatedAt: '2026-04-02T00:00:00.000Z',
      turns: [
        {
          id: 'b-root',
          parentId: null,
          role: 'user',
          text: 'synthetic root',
          createdAt: '2026-03-02T00:00:00.000Z',
        },
        {
          id: 'b-active',
          parentId: 'b-root',
          role: 'assistant',
          text: 'synthetic active',
          createdAt: '2026-03-02T00:01:00.000Z',
        },
        {
          id: 'b-other',
          parentId: 'b-root',
          role: 'assistant',
          text: 'synthetic alternate',
          createdAt: '2026-03-02T00:02:00.000Z',
        },
        {
          id: 'b-active-tail',
          parentId: 'b-active',
          role: 'user',
          text: 'synthetic active continuation',
          createdAt: '2026-03-02T00:03:00.000Z',
        },
      ],
      activeLeafId: 'b-active-tail',
    },
  ]) {
    writeFileSync(
      resolve(conversations, `${conversation.sessionId}.json`),
      `${JSON.stringify(conversation)}\n`,
      { mode: 0o600 },
    );
  }
}

export async function triggerAndWaitForChildClose(
  child,
  trigger,
  timeoutMs = rpcTimeoutMs,
  supervised = false,
) {
  const closed = once(child, 'close');
  await trigger();
  let timer;
  try {
    const [code, signal] = await Promise.race([
      closed,
      new Promise((_, rejectTimeout) => {
        timer = setTimeout(() => rejectTimeout(new Error('child shutdown timed out')), timeoutMs);
      }),
    ]);
    await assertSuccessfulChildExit(child, code, signal, supervised);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function assertSuccessfulChildExit(child, code, signal, supervised = false) {
  if (supervised) {
    const status = await child.__phase1SupervisorStatus;
    if (
      code === null &&
      signal === 'SIGKILL' &&
      status?.reason === 'exit' &&
      status.code === 0 &&
      status.signal === null
    ) {
      return;
    }
    throw new Error('supervised child did not report a successful authenticated exit');
  }
  if (code !== 0 || signal !== null) {
    throw new Error(
      signal === null
        ? `child shutdown failed with exit code ${code}`
        : `child shutdown failed with signal ${signal}`,
    );
  }
}

export class NativeRpcClient {
  constructor(child, { shutdownTimeoutMs = rpcTimeoutMs, supervised = false } = {}) {
    this.child = child;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.supervised = supervised;
    this.pending = new Map();
    this.sequence = 0;
    this.buffer = '';
    this.closed = false;
    const rejectPending = () => {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('native RPC transport closed'));
      }
      this.pending.clear();
    };
    child.stdin.on?.('error', rejectPending);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      while (true) {
        const newline = this.buffer.indexOf('\n');
        if (newline === -1) {
          break;
        }
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        let response;
        try {
          response = JSON.parse(line);
        } catch {
          continue;
        }
        const pending = this.pending.get(response.id);
        if (pending !== undefined) {
          this.pending.delete(response.id);
          clearTimeout(pending.timer);
          pending.resolve(response);
        }
      }
    });
    child.once('close', () => {
      rejectPending();
    });
  }

  operation() {
    this.sequence += 1;
    return {
      attemptId: `op1-1787900000000-${this.sequence}-${String(this.sequence).padStart(32, '0')}`,
      timeoutMs: 5_000,
    };
  }

  request(command, args) {
    if (this.closed) {
      return Promise.reject(new Error('native RPC transport closed'));
    }
    this.sequence += 1;
    const id = `request-${this.sequence}`;
    const request = { id, command, ...(args === undefined ? {} : { args }) };
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`native RPC timed out for ${command}`));
      }, rpcTimeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      const failWrite = () => {
        const pending = this.pending.get(id);
        if (pending === undefined) {
          return;
        }
        this.pending.delete(id);
        clearTimeout(pending.timer);
        pending.reject(new Error('native RPC transport closed'));
      };
      try {
        this.child.stdin.write(`${JSON.stringify(request)}\n`, (error) => {
          if (error !== undefined && error !== null) {
            failWrite();
          }
        });
      } catch {
        failWrite();
      }
    });
  }

  async ok(command, args) {
    const response = await this.request(command, args);
    if (response.ok !== true) {
      throw new Error(`native RPC ${command} failed with ${response.error?.code ?? 'unknown'}`);
    }
    return response.result;
  }

  async error(command, args, expectedCode) {
    const response = await this.request(command, args);
    if (response.ok !== false || response.error?.code !== expectedCode) {
      throw new Error(`native RPC ${command} did not return ${expectedCode}`);
    }
    return response.error;
  }

  async close() {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      await assertSuccessfulChildExit(
        this.child,
        this.child.exitCode,
        this.child.signalCode,
        this.supervised,
      );
      return;
    }
    await triggerAndWaitForChildClose(
      this.child,
      () => this.ok('conformance_shutdown'),
      this.shutdownTimeoutMs,
      this.supervised,
    );
  }
}

function spawnOwnedProcess(command, args, { cwd, env, stdio }) {
  const windowsSupervised = process.platform === 'win32';
  const supervised = !windowsSupervised;
  const supervisorPath = resolve(projectRoot, 'scripts', 'phase1-process-supervisor.mjs');
  const invocation = resolveExecutableInvocation(
    command,
    env ?? process.env,
    process.platform,
    args,
  );
  const child = spawn(
    windowsSupervised ? configuredWindowsSupervisorPath : process.execPath,
    windowsSupervised
      ? ['--', invocation.executable, ...invocation.args]
      : [
          supervisorPath,
          '--timeout-ms',
          String(commandTimeoutMs),
          '--invocation-path',
          invocation.executable,
          '--',
          invocation.resolvedCommand,
          ...invocation.args,
        ],
    {
      cwd,
      detached: !windowsSupervised,
      env,
      stdio: windowsSupervised ? stdio : [...stdio, 'pipe'],
    },
  );
  child.__phase1SupervisorOwnsTree = supervised;
  if (!windowsSupervised) {
    const statusStream = child.stdio[3];
    child.__phase1SupervisorStatus = new Promise((resolveStatus, rejectStatus) => {
      const chunks = [];
      let bytes = 0;
      statusStream.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > 256) {
          rejectStatus(new Error('supervisor status frame exceeded its bound'));
          statusStream.destroy();
          return;
        }
        chunks.push(chunk);
      });
      statusStream.once('end', () => {
        try {
          resolveStatus(parseSupervisorStatusFrame(Buffer.concat(chunks)));
        } catch {
          rejectStatus(new Error('supervisor status frame was not canonical'));
        }
      });
      statusStream.once('error', () => {
        rejectStatus(new Error('supervisor status channel failed'));
      });
    });
    child.__phase1SupervisorStatus.catch(() => undefined);
  }
  return { child, supervised };
}

export async function runOwnedProcessStatusForTest(command, args, options) {
  const { child, supervised } = spawnOwnedProcess(command, args, {
    ...options,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const [code, signal] = await once(child, 'close');
  return {
    code,
    signal,
    supervised,
    status: supervised ? await child.__phase1SupervisorStatus : { code, signal, reason: 'exit' },
  };
}

export async function withFixtureDaemon(fixtureDaemon, action) {
  try {
    return await action();
  } finally {
    await fixtureDaemon.close();
  }
}

export async function withOwnedArtifactRoot(ownedRoot, action) {
  try {
    return await action();
  } finally {
    await ownedRoot.cleanup();
  }
}

async function startNativeRpc(artifactRoot, binaryPath, environment, cwd) {
  const { child, supervised } = spawnOwnedProcess(binaryPath, [], {
    cwd,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  await once(child, 'spawn');
  artifactRoot.trackChild(child);
  child.stderr.resume();
  return new NativeRpcClient(child, { supervised });
}

export function nativeMissingKeychainFailureDiagnostic({
  supervised,
  code,
  signal,
  supervisorStatusValid,
  terminationReason,
  killFailed,
  processFailed,
  canaryExposed,
  homeChanged,
  responseValid,
}) {
  if (terminationReason === 'timeout') {
    return 'phase1.native-scenarios.missing-keychain-timeout';
  }
  if (terminationReason?.endsWith('-limit')) {
    return 'phase1.native-scenarios.missing-keychain-output-limit';
  }
  if (terminationReason !== undefined || killFailed || processFailed) {
    return 'phase1.native-scenarios.missing-keychain-process';
  }
  if (
    (!supervised && (code !== 0 || signal !== null)) ||
    (supervised && (code !== null || signal !== 'SIGKILL'))
  ) {
    return 'phase1.native-scenarios.missing-keychain-termination';
  }
  if (!supervisorStatusValid) {
    return 'phase1.native-scenarios.missing-keychain-supervisor';
  }
  if (canaryExposed) {
    return 'phase1.native-scenarios.missing-keychain-canary';
  }
  if (homeChanged) {
    return 'phase1.native-scenarios.missing-keychain-home';
  }
  if (!responseValid) {
    return 'phase1.native-scenarios.missing-keychain-response';
  }
  return undefined;
}

export function nativeMissingKeychainResponsesValid(responses) {
  return isDeepStrictEqual(responses, [
    {
      id: 'installation',
      ok: false,
      error: { code: 'secure_store_unavailable', retryable: true },
    },
    {
      id: 'shutdown',
      ok: true,
      result: { status: 'shutting_down' },
    },
  ]);
}

async function runNativeMissingKeychainTrustScenario(
  artifactRoot,
  nativeRpcPath,
  environment,
  results,
) {
  const trustHome = resolve(artifactRoot.rootPath, 'native-missing-keychain-trust-home');
  mkdirSync(trustHome, { recursive: true, mode: 0o700 });
  const beforeEntries = readdirSync(trustHome);
  const canary = 'native-keychain-canary-must-not-escape';
  const { child, supervised } = spawnOwnedProcess(nativeRpcPath, [], {
    cwd: artifactRoot.rootPath,
    env: {
      ...environment,
      HOME: trustHome,
      COVEN_HOME: resolve(trustHome, 'coven'),
      COVEN_CAVE_HOME: resolve(trustHome, 'coven', 'cave'),
      COVEN_CAVE_AUTH_TOKEN: canary,
      OPENCOVEN_PHASE1_CONFORMANCE_NATIVE_PROVIDER_PRESET: 'missing-keychain-trust',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  await once(child, 'spawn');
  artifactRoot.trackChild(child);
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let terminationReason;
  let killError;
  let processError;
  let closed = false;
  const closePromise = new Promise((resolveClose) => {
    child.once('close', (code, signal) => {
      closed = true;
      resolveClose([code, signal]);
    });
  });
  const requestKill = (reason) => {
    terminationReason ??= reason;
    if (closed || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    const signal = process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM';
    if (!child.kill(signal) && child.exitCode === null && child.signalCode === null) {
      killError = new Error(`native missing-keychain-trust child could not be killed (${reason})`);
    }
  };
  child.once('error', (error) => {
    processError = error;
    requestKill('process-error');
  });
  const capture = (target, bytes, chunk, stream) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const nextBytes = bytes + buffer.length;
    if (nextBytes > commandOutputLimit) {
      requestKill(`${stream}-limit`);
      return bytes;
    }
    target.push(buffer);
    return nextBytes;
  };
  child.stdout.on('data', (chunk) => {
    stdoutBytes = capture(stdout, stdoutBytes, chunk, 'stdout');
  });
  child.stderr.on('data', (chunk) => {
    stderrBytes = capture(stderr, stderrBytes, chunk, 'stderr');
  });
  child.stdin.end(
    `${JSON.stringify({ id: 'installation', command: 'app_installation_id' })}\n` +
      `${JSON.stringify({ id: 'shutdown', command: 'conformance_shutdown' })}\n`,
  );
  let timeoutHandle;
  const timeout = new Promise((resolveTimeout) => {
    timeoutHandle = setTimeout(() => {
      requestKill('timeout');
      resolveTimeout();
    }, rpcTimeoutMs);
  });
  const firstResult = await Promise.race([
    closePromise.then((result) => ({ closed: true, result })),
    timeout.then(() => ({ closed: false })),
  ]);
  let closeResult;
  if (firstResult.closed) {
    closeResult = firstResult.result;
  } else {
    let reapTimeoutHandle;
    const reapTimeout = new Promise((resolveReapTimeout) => {
      reapTimeoutHandle = setTimeout(resolveReapTimeout, rpcTimeoutMs, null);
    });
    closeResult = await Promise.race([closePromise, reapTimeout]);
    clearTimeout(reapTimeoutHandle);
  }
  clearTimeout(timeoutHandle);
  if (closeResult === null) {
    throw new Error('phase1.native-scenarios.missing-keychain-reap');
  }
  const [code, signal] = closeResult;
  const stdoutText = Buffer.concat(stdout).toString('utf8');
  const stderrText = Buffer.concat(stderr).toString('utf8');
  let supervisedStatusValid = true;
  if (supervised) {
    try {
      const status = await child.__phase1SupervisorStatus;
      supervisedStatusValid =
        status.reason === 'exit' && status.code === 0 && status.signal === null;
    } catch {
      supervisedStatusValid = false;
    }
  }
  let responses;
  try {
    responses = stdoutText
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    responses = undefined;
  }
  const unchanged = JSON.stringify(readdirSync(trustHome)) === JSON.stringify(beforeEntries);
  const responseValid = nativeMissingKeychainResponsesValid(responses);
  const diagnostic = nativeMissingKeychainFailureDiagnostic({
    supervised,
    code,
    signal,
    supervisorStatusValid: supervisedStatusValid,
    terminationReason,
    killFailed: killError !== undefined,
    processFailed: processError !== undefined,
    canaryExposed: stderrText.includes(canary) || stdoutText.includes(canary),
    homeChanged: !unchanged,
    responseValid,
  });
  if (diagnostic !== undefined) {
    throw new Error(diagnostic);
  }
  addAssertion(
    results,
    'phase1.native.missing-keychain-trust',
    'passed',
    'phase1.assertion.passed',
  );
}

async function waitForDiscovery(rpc) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await rpc.request('cave_read_discovery', {
      operation: rpc.operation(),
    });
    if (response.ok === true) {
      return response.result;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error('native RPC did not discover the launched Cave');
}

async function adminMutation(origin, adminToken, method, path, body) {
  const response = await requestJson(origin, {
    method,
    path: `/api/client/v1${path}`,
    headers: {
      'x-coven-cave-token': adminToken,
      origin,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!(response.status >= 200 && response.status < 300)) {
    throw new Error(`Cave admin mutation failed with HTTP ${response.status}`);
  }
  return response.json;
}

async function pairNative(
  rpc,
  handle,
  origin,
  adminToken,
  installationId,
  approvePairing = adminMutation,
  onStage = () => {},
) {
  onStage('create');
  const created = await rpc.ok('cave_pairing_create', {
    handle,
    request: {
      appName: 'OpenCoven Chat',
      installationId,
      scopes: ['chat:read'],
    },
    operation: rpc.operation(),
  });
  const requestId = created.requestId;
  if (typeof requestId !== 'string') {
    throw new Error('native pairing creation omitted its request ID');
  }
  onStage('pending');
  const pending = await rpc.ok('cave_pairing_poll', {
    handle,
    requestId,
    operation: rpc.operation(),
  });
  if (pending.status !== 'pending') {
    throw new Error('native pairing did not begin pending');
  }
  onStage('approve');
  await approvePairing(
    origin,
    adminToken,
    'POST',
    `/admin/pairing-requests/${requestId}/decision`,
    {
      decision: 'approved',
    },
  );
  onStage('approved');
  const approved = await rpc.ok('cave_pairing_poll', {
    handle,
    requestId,
    operation: rpc.operation(),
  });
  if (approved.status !== 'approved') {
    throw new Error('native pairing was not approved');
  }
  onStage('exchange');
  const exchanged = await rpc.ok('cave_pairing_exchange', {
    handle,
    requestId,
    operation: rpc.operation(),
  });
  const credentialId = exchanged.credential?.id;
  if (typeof credentialId !== 'string' || JSON.stringify(exchanged).includes('bearer')) {
    throw new Error('native pairing exchange returned an unsafe result');
  }
  return { requestId, credentialId };
}

function collection(result, name) {
  const items = result?.data?.[name];
  if (!Array.isArray(items)) {
    throw new Error(`native canonical read omitted ${name}`);
  }
  return items;
}

async function runEmergencyNativeCredentialCleanup({
  artifactRoot,
  nativeRpcPath,
  environment,
  reservationHandle,
  capability,
  ownerToken,
}) {
  const rpc = await startNativeRpc(
    artifactRoot,
    nativeRpcPath,
    {
      ...nativeAdapterTestEnvironment(environment),
      OPENCOVEN_PHASE1_CONFORMANCE_NATIVE_PROVIDER_PRESET: 'production-keyring',
    },
    projectRoot,
  );
  try {
    const result = await rpc.ok('conformance_delete_native_credential', {
      reservationHandle,
      capability,
      ownerToken,
    });
    if (result.status !== 'missing') {
      throw new Error('Emergency native credential cleanup did not verify NoEntry.');
    }
  } finally {
    await rpc.close();
  }
}

const cleanupCapabilityPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export async function establishNativeCleanupReservation(rpc, handle, onStage = () => {}) {
  try {
    onStage('reservation-request');
    const response = await rpc.request('conformance_prepare_native_cleanup', { handle });
    if (response?.ok !== true) {
      const rejectionStage = {
        keychain_failure: 'reservation-keychain',
        secure_store_unavailable: 'reservation-store-unavailable',
        invalid_discovery_handle: 'reservation-invalid-handle',
        cave_discovery_required: 'reservation-discovery-required',
        cave_health_required: 'reservation-health-required',
      }[response?.error?.code];
      onStage(rejectionStage ?? 'reservation-rejected');
      throw new Error('native cleanup reservation request was rejected');
    }
    onStage('reservation-response');
    const reservation = response?.result;
    if (
      reservation === null ||
      typeof reservation !== 'object' ||
      Array.isArray(reservation) ||
      Object.keys(reservation).sort().join(',') !== 'capability,ownerToken,reservationHandle' ||
      typeof reservation.reservationHandle !== 'string' ||
      !cleanupCapabilityPattern.test(reservation.reservationHandle) ||
      typeof reservation.capability !== 'string' ||
      !cleanupCapabilityPattern.test(reservation.capability) ||
      typeof reservation.ownerToken !== 'string' ||
      !cleanupCapabilityPattern.test(reservation.ownerToken)
    ) {
      throw new Error('native cleanup reservation response was invalid');
    }

    return reservation;
  } catch {
    try {
      const canceled = await rpc.ok('conformance_cancel_prepared_native_cleanup');
      if (canceled?.status !== 'missing') {
        throw new Error('native cleanup reservation marker remained');
      }
    } catch {
      onStage('reservation-cleanup');
      throw new Error('Native cleanup reservation failed and marker cleanup did not complete.');
    }
    throw new Error('Native cleanup reservation could not be established.');
  }
}

export function createCleanupAdoptionRecovery(reservation) {
  return {
    predecessor: { ...reservation },
    successor: { ...reservation, ownerToken: randomUUID() },
    deleted: false,
  };
}

export async function adoptNativeCleanupReservation(rpc, recovery, openRecoveryRpc) {
  const reservation = recovery.predecessor;
  const successorOwnerToken = recovery.successor.ownerToken;
  const args = {
    reservationHandle: reservation.reservationHandle,
    capability: reservation.capability,
    ownerToken: reservation.ownerToken,
    successorOwnerToken,
  };
  let begun;
  try {
    const response = await rpc.request('conformance_begin_adopt_native_cleanup', args);
    begun = response?.result;
    if (
      response?.ok !== true ||
      begun?.reservationHandle !== reservation.reservationHandle ||
      begun?.capability !== reservation.capability ||
      begun?.ownerToken !== successorOwnerToken
    ) {
      throw new Error('invalid begin adoption response');
    }
  } catch {
    await rpc.ok('conformance_abort_adopt_native_cleanup', args).catch(() => undefined);
    throw new Error('Native cleanup reservation adoption was invalid.');
  }
  let committed;
  for (let attempt = 0; attempt < 2 && committed === undefined; attempt += 1) {
    try {
      const response = await rpc.request('conformance_commit_adopt_native_cleanup', args);
      if (
        response?.ok === true &&
        response.result?.status === 'committed' &&
        response.result?.ownerToken === successorOwnerToken
      ) {
        committed = response.result;
      }
    } catch {
      // The same token makes commit retries idempotent after a lost response.
    }
  }
  if (committed === undefined) {
    if (typeof openRecoveryRpc === 'function') {
      const recoveryRpc = await openRecoveryRpc();
      try {
        const response = await recoveryRpc.request('conformance_commit_adopt_native_cleanup', args);
        if (
          response?.ok === true &&
          response.result?.status === 'committed' &&
          response.result?.ownerToken === successorOwnerToken
        ) {
          const deleted = await recoveryRpc.ok('conformance_delete_native_credential', {
            reservationHandle: recovery.successor.reservationHandle,
            capability: recovery.successor.capability,
            ownerToken: recovery.successor.ownerToken,
          });
          if (deleted?.status === 'missing') {
            recovery.deleted = true;
          }
        }
      } finally {
        await recoveryRpc.close().catch(() => undefined);
      }
    }
    throw new Error('Native cleanup reservation commit could not be confirmed.');
  }
  return recovery.successor;
}

export async function runReservedNativePairing({
  rpc,
  handle,
  origin,
  adminToken,
  installationId,
  approvePairing = adminMutation,
  onReservation = () => {},
  onCredentialMayExist = () => {},
  onStage = () => {},
}) {
  const reservation = await establishNativeCleanupReservation(rpc, handle, onStage);
  onReservation(reservation);
  onStage('credential-status');
  const initialCredentialStatus = await rpc.ok('cave_credential_status', {
    handle,
    operation: rpc.operation(),
  });
  if (initialCredentialStatus.status !== 'missing') {
    throw new Error('isolated native credential store was not empty');
  }
  onCredentialMayExist();
  const paired = await pairNative(
    rpc,
    handle,
    origin,
    adminToken,
    installationId,
    approvePairing,
    onStage,
  );
  return { reservation, initialCredentialStatus, paired };
}

export async function runNativeScenarioOrchestrator({ runPairing, runLifecycle }) {
  const pairing = await runPairing();
  return runLifecycle(pairing);
}

export function throwNativeScenarioFailures({
  scenarioFailure,
  cleanupFailure,
  rpcCleanupFailure,
  daemonCloseFailure,
}) {
  const failures = [scenarioFailure, cleanupFailure, rpcCleanupFailure, daemonCloseFailure].filter(
    (failure) => failure !== undefined,
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Native conformance scenario teardown failed.');
  }
}

async function runNativeScenarios({ artifactRoot, roots, nativeRpcPath, environment, results }) {
  const isolatedHome = resolve(artifactRoot.rootPath, 'native-authority-home');
  const covenHome = resolve(isolatedHome, 'coven');
  const caveHome = resolve(covenHome, 'cave');
  let activeNativeStage = 'fixture-daemon';
  let fixtureDaemon;
  try {
    fixtureDaemon = await startFixtureDaemon([
      {
        id: 'archivist',
        display_name: 'Archivist',
        role: 'Keeper',
        description: 'Synthetic roster entry.',
      },
    ]);
  } catch (error) {
    throw new Error('phase1.native-scenarios.fixture-daemon', { cause: error });
  }
  let rpc;
  let nativeCredentialStoreBefore;
  let nativeCredentialStoreAfter;
  let nativeCredentialInstanceId;
  let finalNativeCredentialInstanceId;
  let nativeCredentialAccount;
  let cleanupReservation;
  let cleanupAdoptionRecovery;
  let rpcEnvironment;
  let handle;
  let credentialId;
  let credentialMayExist = false;
  let firstNativeAssertionFailureStage;
  let scenarioFailure;
  try {
    activeNativeStage = 'fixture';
    writeNativeFixture(caveHome, covenHome, fixtureDaemon.url);
    const portServer = createServer();
    portServer.listen(0, '127.0.0.1');
    await once(portServer, 'listening');
    const port = portServer.address().port;
    await new Promise((resolveClose, rejectClose) =>
      portServer.close((error) => (error ? rejectClose(error) : resolveClose())),
    );
    const origin = `http://127.0.0.1:${port}`;
    const adminToken = `phase1-${randomUUID()}`;
    rpcEnvironment = {
      ...nativeAdapterTestEnvironment(environment),
      OPENCOVEN_PHASE1_CONFORMANCE_CLEANUP_HOME: isolatedHome,
      COVEN_HOME: covenHome,
      COVEN_CAVE_HOME: caveHome,
      COVEN_CAVE_PORT: String(port),
      COVEN_CAVE_AUTH_TOKEN: adminToken,
      COVEN_CAVE_CLIENT_V1_AUTHORITY_MODE: 'enforce',
      COVEN_CAVE_HEAP_MONITOR: '0',
      OPENCOVEN_PHASE1_CONFORMANCE_NODE_PATH: realpathSync(process.execPath),
      OPENCOVEN_PHASE1_CONFORMANCE_CAVE_SERVER_PATH: resolve(roots.caveRoot, 'server.mjs'),
      OPENCOVEN_PHASE1_CONFORMANCE_NATIVE_PROVIDER_PRESET: 'production-keyring',
      NODE_ENV: 'production',
    };
    activeNativeStage = 'rpc-start';
    rpc = await startNativeRpc(artifactRoot, nativeRpcPath, rpcEnvironment, roots.caveRoot);

    activeNativeStage = 'launch';
    try {
      await rpc.error(
        'cave_read_discovery',
        { operation: rpc.operation() },
        'cave_discovery_not_found',
      );
      await rpc.ok('cave_launch');
      const discovery = await waitForDiscovery(rpc);
      handle = discovery.handle;
      const health = await rpc.ok('cave_health', {
        handle,
        operation: rpc.operation(),
      });
      if (health.apiVersion !== '1.0' || health.data?.pairingRequired !== true) {
        throw new Error('launched Cave returned an invalid health envelope');
      }
      if (
        typeof health.data?.instanceId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          health.data.instanceId,
        )
      ) {
        throw new Error('isolated Cave did not publish a canonical instance identity');
      }
      nativeCredentialInstanceId = health.data.instanceId;
      nativeCredentialAccount = `cave-client-v1:${nativeCredentialInstanceId}`;
      addAssertion(
        results,
        'phase1.missing-cave.validated-launch',
        'passed',
        'phase1.assertion.passed',
      );
    } catch {
      process.stderr.write('phase1-conformance: validated Cave launch assertion failed.\n');
      addAssertion(
        results,
        'phase1.missing-cave.validated-launch',
        'failed',
        'phase1.assertion.failed',
      );
      throw new Error('Validated Cave launch failed before cleanup reservation.');
    }

    activeNativeStage = 'pairing';
    await runNativeScenarioOrchestrator({
      runPairing: () =>
        runReservedNativePairing({
          rpc,
          handle,
          origin,
          adminToken,
          installationId: 'phase1-installation-1',
          onReservation(reservation) {
            cleanupReservation = reservation;
          },
          onCredentialMayExist() {
            credentialMayExist = true;
          },
          onStage(stage) {
            activeNativeStage = `pairing-${stage}`;
          },
        }),
      runLifecycle: async (reservedPairing) => {
        nativeCredentialStoreBefore = createHash('sha256')
          .update(
            JSON.stringify({
              service: 'ai.opencoven.chat',
              account: nativeCredentialAccount,
              status: reservedPairing.initialCredentialStatus.status,
            }),
          )
          .digest('hex');
        credentialId = reservedPairing.paired.credentialId;
        addAssertion(
          results,
          'phase1.pairing.create-pending-approve-exchange',
          'passed',
          'phase1.assertion.passed',
        );

        activeNativeStage = 'pairing-denial';
        try {
          const created = await rpc.ok('cave_pairing_create', {
            handle,
            request: {
              appName: 'OpenCoven Chat',
              installationId: 'phase1-installation-denied',
              scopes: ['chat:read'],
            },
            operation: rpc.operation(),
          });
          await adminMutation(
            origin,
            adminToken,
            'POST',
            `/admin/pairing-requests/${created.requestId}/decision`,
            { decision: 'denied' },
          );
          const denied = await rpc.ok('cave_pairing_poll', {
            handle,
            requestId: created.requestId,
            operation: rpc.operation(),
          });
          assertPairingStatus(denied, 'denied');
          addAssertion(results, 'phase1.pairing.denial', 'passed', 'phase1.assertion.passed');
        } catch {
          firstNativeAssertionFailureStage ??= activeNativeStage;
          process.stderr.write('phase1-conformance: pairing denial assertion failed.\n');
          addAssertion(results, 'phase1.pairing.denial', 'failed', 'phase1.assertion.failed');
        }

        activeNativeStage = 'restart';
        if (typeof credentialId !== 'string') {
          addAssertion(
            results,
            'phase1.credential.restart-reuse',
            'blocked',
            'phase1.integration.native-credential-unavailable',
          );
        } else {
          let replacementRpc;
          try {
            activeNativeStage = 'restart-rpc-start';
            replacementRpc = await startNativeRpc(
              artifactRoot,
              nativeRpcPath,
              rpcEnvironment,
              roots.caveRoot,
            );
            activeNativeStage = 'restart-discovery';
            const replacementDiscovery = await waitForDiscovery(replacementRpc);
            const replacementHandle = replacementDiscovery.handle;
            activeNativeStage = 'restart-health';
            const replacementHealth = await replacementRpc.ok('cave_health', {
              handle: replacementHandle,
              operation: replacementRpc.operation(),
            });
            if (replacementHealth.data?.instanceId !== nativeCredentialInstanceId) {
              throw new Error('Cave identity changed before native credential restart');
            }
            cleanupAdoptionRecovery = createCleanupAdoptionRecovery(cleanupReservation);
            activeNativeStage = 'restart-cleanup-adoption';
            cleanupReservation = await adoptNativeCleanupReservation(
              replacementRpc,
              cleanupAdoptionRecovery,
              () => startNativeRpc(artifactRoot, nativeRpcPath, rpcEnvironment, roots.caveRoot),
            );
            activeNativeStage = 'restart-status';
            const replacementStatus = await replacementRpc.ok('cave_credential_status', {
              handle: replacementHandle,
              operation: replacementRpc.operation(),
            });
            if (replacementStatus.status !== 'valid') {
              throw new Error('replacement RPC did not reuse the native credential');
            }
            const previousRpc = rpc;
            rpc = replacementRpc;
            handle = replacementHandle;
            activeNativeStage = 'restart-handoff-close';
            await previousRpc.close();
            activeNativeStage = 'restart-launch';
            await rpc.ok('cave_launch');
            activeNativeStage = 'restart-rediscovery';
            const discovery = await waitForDiscovery(rpc);
            handle = discovery.handle;
            activeNativeStage = 'restart-restarted-health';
            const restartedHealth = await rpc.ok('cave_health', {
              handle,
              operation: rpc.operation(),
            });
            if (restartedHealth.data?.instanceId !== nativeCredentialInstanceId) {
              throw new Error('Cave identity changed across native credential restart');
            }
            activeNativeStage = 'restart-restarted-status';
            const status = await rpc.ok('cave_credential_status', {
              handle,
              operation: rpc.operation(),
            });
            if (status.status !== 'valid') {
              throw new Error('credential was not reused after native state restart');
            }
            activeNativeStage = 'restart-result';
            addAssertion(
              results,
              'phase1.credential.restart-reuse',
              'passed',
              'phase1.assertion.passed',
            );
          } catch {
            firstNativeAssertionFailureStage ??= activeNativeStage;
            if (replacementRpc !== undefined && replacementRpc !== rpc) {
              await replacementRpc.close().catch(() => undefined);
            }
            process.stderr.write('phase1-conformance: credential restart assertion failed.\n');
            addAssertion(
              results,
              'phase1.credential.restart-reuse',
              'failed',
              'phase1.assertion.failed',
            );
          }
        }

        activeNativeStage = 'reads';
        if (typeof credentialId !== 'string') {
          addAssertion(
            results,
            'phase1.reads.bounded-canonical',
            'blocked',
            'phase1.integration.native-credential-unavailable',
          );
        } else {
          try {
            const familiars = collection(
              await rpc.ok('cave_list_familiars', {
                handle,
                page: { limit: 1 },
                operation: rpc.operation(),
              }),
              'familiars',
            );
            const projects = collection(
              await rpc.ok('cave_list_projects', {
                handle,
                page: { limit: 2 },
                operation: rpc.operation(),
              }),
              'projects',
            );
            const conversations = collection(
              await rpc.ok('cave_list_conversations', {
                handle,
                page: { limit: 2 },
                operation: rpc.operation(),
              }),
              'conversations',
            );
            const conversation = await rpc.ok('cave_get_conversation', {
              handle,
              conversationId: 'branched',
              operation: rpc.operation(),
            });
            const messages = collection(
              await rpc.ok('cave_list_conversation_messages', {
                handle,
                conversationId: 'branched',
                page: { limit: 1 },
                operation: rpc.operation(),
              }),
              'messages',
            );
            if (
              familiars.length !== 1 ||
              projects.length > 2 ||
              conversations.length > 2 ||
              conversation.data?.conversation?.id !== 'branched' ||
              messages.length !== 1
            ) {
              throw new Error('bounded canonical reads returned unexpected shapes');
            }
            addAssertion(
              results,
              'phase1.reads.bounded-canonical',
              'passed',
              'phase1.assertion.passed',
            );
          } catch {
            firstNativeAssertionFailureStage ??= activeNativeStage;
            process.stderr.write('phase1-conformance: bounded read assertion failed.\n');
            addAssertion(
              results,
              'phase1.reads.bounded-canonical',
              'failed',
              'phase1.assertion.failed',
            );
          }
        }

        activeNativeStage = 'reconciliation';
        if (typeof credentialId !== 'string') {
          addAssertion(
            results,
            'phase1.reads.stale-generation-cursor-reconciliation',
            'blocked',
            'phase1.integration.native-credential-unavailable',
          );
        } else {
          try {
            const firstPage = await rpc.ok('cave_list_conversation_messages', {
              handle,
              conversationId: 'branched',
              page: { limit: 2 },
              operation: rpc.operation(),
            });
            const cursor = firstPage.cursor?.next;
            if (typeof cursor !== 'string') {
              throw new Error('message read did not return a cursor');
            }
            const conversationPath = resolve(caveHome, 'conversations', 'branched.json');
            const conversation = JSON.parse(readFileSync(conversationPath, 'utf8'));
            conversation.activeLeafId = 'b-other';
            writeFileSync(conversationPath, `${JSON.stringify(conversation)}\n`, { mode: 0o600 });
            await rpc.error(
              'cave_list_conversation_messages',
              {
                handle,
                conversationId: 'branched',
                page: { limit: 1, cursor },
                operation: rpc.operation(),
              },
              'reconcile_required',
            );
            const staleHandle = handle;
            await rpc.ok('cave_reset_pairing', { handle });
            const discovery = await waitForDiscovery(rpc);
            handle = discovery.handle;
            await rpc.error(
              'cave_health',
              { handle: staleHandle, operation: rpc.operation() },
              'invalid_discovery_handle',
            );
            await rpc.ok('cave_health', { handle, operation: rpc.operation() });
            addAssertion(
              results,
              'phase1.reads.stale-generation-cursor-reconciliation',
              'passed',
              'phase1.assertion.passed',
            );
          } catch {
            firstNativeAssertionFailureStage ??= activeNativeStage;
            process.stderr.write('phase1-conformance: reconciliation assertion failed.\n');
            addAssertion(
              results,
              'phase1.reads.stale-generation-cursor-reconciliation',
              'failed',
              'phase1.assertion.failed',
            );
          }
        }

        activeNativeStage = 'revocation';
        if (typeof credentialId !== 'string') {
          addAssertion(
            results,
            'phase1.credential.revocation-repair',
            'blocked',
            'phase1.integration.native-credential-unavailable',
          );
        } else {
          try {
            activeNativeStage = 'revocation-delete';
            await adminMutation(
              origin,
              adminToken,
              'DELETE',
              `/admin/credentials/${credentialId}`,
              {
                reason: 'phase1-conformance',
              },
            );
            activeNativeStage = 'revocation-initial-status';
            const initialStatus = await rpc.ok('cave_credential_status', {
              handle,
              operation: rpc.operation(),
            });
            if (
              initialStatus.status !== 'disconnected' ||
              initialStatus.reason !== 'reconcile_required'
            ) {
              throw new Error('native credential did not request revocation reconciliation');
            }
            await new Promise((resolveWait) =>
              setTimeout(resolveWait, revocationConfirmationDelayMs),
            );
            activeNativeStage = 'revocation-rediscovery';
            const rediscovery = await waitForDiscovery(rpc);
            handle = rediscovery.handle;
            activeNativeStage = 'revocation-health';
            await rpc.ok('cave_health', { handle, operation: rpc.operation() });
            activeNativeStage = 'revocation-status';
            const status = await rpc.ok('cave_credential_status', {
              handle,
              operation: rpc.operation(),
            });
            if (!['revoked', 'missing'].includes(status.status)) {
              throw new Error('native credential did not converge to revoked');
            }
            const repaired = await pairNative(
              rpc,
              handle,
              origin,
              adminToken,
              'phase1-installation-repaired',
              adminMutation,
              (stage) => {
                activeNativeStage = `revocation-repair-${stage}`;
              },
            );
            activeNativeStage = 'revocation-result';
            if (typeof repaired.credentialId !== 'string') {
              throw new Error('native re-pairing did not issue a credential');
            }
            credentialId = repaired.credentialId;
            addAssertion(
              results,
              'phase1.credential.revocation-repair',
              'passed',
              'phase1.assertion.passed',
            );
          } catch {
            firstNativeAssertionFailureStage ??= activeNativeStage;
            process.stderr.write('phase1-conformance: credential revocation assertion failed.\n');
            addAssertion(
              results,
              'phase1.credential.revocation-repair',
              'failed',
              'phase1.assertion.failed',
            );
          }
        }

        if (firstNativeAssertionFailureStage !== undefined) {
          activeNativeStage = firstNativeAssertionFailureStage;
          throw new Error('Native assertion failed before final credential cleanup.');
        }

        activeNativeStage = 'credential-cleanup';
        if (typeof credentialId === 'string' && typeof handle === 'string') {
          activeNativeStage = 'credential-cleanup-discovery';
          const cleanupDiscovery = await waitForDiscovery(rpc);
          handle = cleanupDiscovery.handle;
          activeNativeStage = 'credential-cleanup-health';
          const cleanupHealth = await rpc.ok('cave_health', {
            handle,
            operation: rpc.operation(),
          });
          activeNativeStage = 'credential-cleanup-identity';
          if (cleanupHealth.data?.instanceId !== nativeCredentialInstanceId) {
            throw new Error('Cave identity changed before native credential cleanup');
          }
          finalNativeCredentialInstanceId = cleanupHealth.data.instanceId;
          activeNativeStage = 'credential-cleanup-forget';
          await rpc.ok('cave_forget_credential', {
            handle,
            operation: rpc.operation(),
          });
          activeNativeStage = 'credential-cleanup-status';
          const status = await rpc.ok('cave_credential_status', {
            handle,
            operation: rpc.operation(),
          });
          activeNativeStage = 'credential-cleanup-result';
          if (status.status !== 'missing') {
            throw new Error('native credential cleanup did not converge to missing');
          }
          credentialMayExist = false;
          nativeCredentialStoreAfter = createHash('sha256')
            .update(
              JSON.stringify({
                service: 'ai.opencoven.chat',
                account: `cave-client-v1:${finalNativeCredentialInstanceId}`,
                status: status.status,
              }),
            )
            .digest('hex');
        }

        activeNativeStage = 'stale-discovery';
        const discoveryPath = resolve(caveHome, 'client-v1-discovery.json');
        const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8'));
        discovery.endpoint = 'http://127.0.0.1:1';
        writeFileSync(discoveryPath, `${JSON.stringify(discovery)}\n`, { mode: 0o600 });
        await rpc.error(
          'cave_health',
          { handle, operation: rpc.operation() },
          'stale_discovery_handle',
        );
      },
    });
  } catch (error) {
    scenarioFailure = error;
  }

  let cleanupFailure;
  let cleanupCompleted = cleanupAdoptionRecovery?.deleted === true;
  const cleanupCandidates = cleanupAdoptionRecovery
    ? [cleanupAdoptionRecovery.successor, cleanupAdoptionRecovery.predecessor]
    : cleanupReservation === undefined
      ? []
      : [cleanupReservation];
  for (const candidate of cleanupCandidates) {
    if (cleanupCompleted) {
      break;
    }
    try {
      if (rpc !== undefined && rpc.child.exitCode === null && rpc.child.signalCode === null) {
        const result = await rpc.ok('conformance_delete_native_credential', {
          reservationHandle: candidate.reservationHandle,
          capability: candidate.capability,
          ownerToken: candidate.ownerToken,
        });
        cleanupCompleted = result.status === 'missing';
      }
    } catch {
      // The alternate retained owner token may be current.
    }
    if (!cleanupCompleted) {
      try {
        await runEmergencyNativeCredentialCleanup({
          artifactRoot,
          nativeRpcPath,
          environment,
          reservationHandle: candidate.reservationHandle,
          capability: candidate.capability,
          ownerToken: candidate.ownerToken,
        });
        cleanupCompleted = true;
      } catch {
        // Continue to the alternate retained owner.
      }
    }
  }
  if (cleanupCandidates.length > 0 && !cleanupCompleted) {
    cleanupFailure = new Error('Independent native credential cleanup did not complete.');
  }
  if (cleanupCompleted) {
    credentialMayExist = false;
    finalNativeCredentialInstanceId = nativeCredentialInstanceId;
    nativeCredentialStoreAfter = createHash('sha256')
      .update(
        JSON.stringify({
          service: 'ai.opencoven.chat',
          account: `cave-client-v1:${nativeCredentialInstanceId}`,
          status: 'missing',
        }),
      )
      .digest('hex');
  }
  let rpcCleanupFailure;
  if (rpc !== undefined) {
    try {
      await rpc.close();
    } catch {
      rpcCleanupFailure = new Error('Native RPC cleanup did not complete.');
    }
  }
  let daemonCloseFailure;
  try {
    await fixtureDaemon.close();
  } catch {
    daemonCloseFailure = new Error('Fixture daemon cleanup did not complete.');
  }
  if (credentialMayExist && cleanupFailure === undefined) {
    cleanupFailure = new Error('Native credential remained after failure cleanup.');
  }
  try {
    throwNativeScenarioFailures({
      scenarioFailure,
      cleanupFailure,
      rpcCleanupFailure,
      daemonCloseFailure,
    });
  } catch (error) {
    throw new Error(
      scenarioFailure === undefined
        ? 'phase1.native-scenarios.cleanup'
        : `phase1.native-scenarios.${activeNativeStage}`,
      { cause: error },
    );
  }
  try {
    await runNativeMissingKeychainTrustScenario(artifactRoot, nativeRpcPath, environment, results);
  } catch (error) {
    throw new Error(
      publicPhase1FailureDiagnostic(error) ?? 'phase1.native-scenarios.missing-keychain',
      { cause: error },
    );
  }
  if (
    nativeCredentialStoreBefore === undefined ||
    nativeCredentialStoreAfter === undefined ||
    nativeCredentialInstanceId === undefined ||
    finalNativeCredentialInstanceId === undefined ||
    nativeCredentialAccount === undefined
  ) {
    throw new Error('phase1.native-scenarios.isolation-proof');
  }
  return {
    beforeSha256: nativeCredentialStoreBefore,
    afterSha256: nativeCredentialStoreAfter,
    accountSha256: createHash('sha256')
      .update(JSON.stringify({ service: 'ai.opencoven.chat', account: nativeCredentialAccount }))
      .digest('hex'),
    ownershipVerified:
      nativeCredentialInstanceId === finalNativeCredentialInstanceId &&
      nativeCredentialStoreBefore === nativeCredentialStoreAfter,
    removedAfterRun: nativeCredentialStoreBefore === nativeCredentialStoreAfter,
  };
}

export function resolveLockedCovenDaemonCommand(
  artifactRoot,
  lockedCovenCheckoutRoot,
  expectedCovenRevision,
  covenBinaryPath,
) {
  if (
    artifactRoot === null ||
    typeof artifactRoot !== 'object' ||
    typeof artifactRoot.rootPath !== 'string'
  ) {
    throw new Error('Owned artifact root is required for Coven command resolution.');
  }
  if (typeof lockedCovenCheckoutRoot !== 'string' || lockedCovenCheckoutRoot.length === 0) {
    throw new Error('Locked Coven checkout root must be a non-empty path string.');
  }
  if (!/^[0-9a-f]{40}$/u.test(expectedCovenRevision)) {
    throw new Error('Locked Coven revision must be an exact commit SHA.');
  }
  const expectedRoot = resolve(artifactRoot.rootPath, 'checkouts', 'coven');
  let actualStats;
  try {
    actualStats = lstatSync(lockedCovenCheckoutRoot);
  } catch {
    throw new Error('Locked Coven checkout root is unavailable.');
  }
  if (
    actualStats.isSymbolicLink() ||
    !actualStats.isDirectory() ||
    !isAbsolute(lockedCovenCheckoutRoot) ||
    resolve(lockedCovenCheckoutRoot) !== expectedRoot ||
    realpathSync(lockedCovenCheckoutRoot) !== realpathSync(expectedRoot)
  ) {
    throw new Error('Coven command root is not the owned locked checkout.');
  }
  const observedRevision = runSupervisedSync('git', ['rev-parse', 'HEAD'], {
    cwd: lockedCovenCheckoutRoot,
    encoding: 'utf8',
    env: createGitEnvironment(),
  }).trim();
  if (observedRevision !== expectedCovenRevision) {
    throw new Error('Coven command root does not match the locked revision.');
  }
  return Object.freeze({
    executable: resolveExecutableInvocation(covenBinaryPath, process.env).executable,
    args: Object.freeze(['daemon', 'serve']),
    cwd: lockedCovenCheckoutRoot,
  });
}

async function expectCovenHealthFailure(
  artifactRoot,
  nativeRpcPath,
  environment,
  covenHome,
  expectedCode,
) {
  const rpc = await startNativeRpc(
    artifactRoot,
    nativeRpcPath,
    { ...environment, COVEN_HOME: covenHome },
    projectRoot,
  );
  try {
    const error = await rpc.error('coven_health', { operation: rpc.operation() }, expectedCode);
    if (
      Object.keys(error).sort().join(',') !== 'code,retryable' ||
      typeof error.retryable !== 'boolean'
    ) {
      throw new Error('Chat Coven adapter returned an unsafe diagnostic envelope.');
    }
  } finally {
    await rpc.close();
  }
}

/**
 * Run the production Chat Coven identity proof from the exact owned checkout.
 *
 * @param {{
 *   artifactRoot: {rootPath: string, trackChild(child: import('node:child_process').ChildProcess): void},
 *   lockedCovenCheckoutRoot: string,
 *   expectedCovenRevision: string,
 *   nativeRpcPath: string,
 *   covenBinaryPath: string,
 *   environment: NodeJS.ProcessEnv,
 *   results: Map<string, unknown>
 * }} options
 */
async function runCovenIdentityScenario({
  artifactRoot,
  lockedCovenCheckoutRoot,
  expectedCovenRevision,
  nativeRpcPath,
  covenBinaryPath,
  environment,
  results,
}) {
  const covenCommand = resolveLockedCovenDaemonCommand(
    artifactRoot,
    lockedCovenCheckoutRoot,
    expectedCovenRevision,
    covenBinaryPath,
  );
  const covenRoot = createProcessOwnedArtifactRoot({ prefix: 'p1cv', shortPath: true });
  const covenHome = resolve(covenRoot.rootPath, 'cv');
  let ownershipVerified = false;
  const verifiedSdkAssertions = [
    'sdk.coven.discovery.owner-local',
    'sdk.coven.health',
    'sdk.coven.structured-errors',
  ];
  const verifiedChatAssertions = [
    'chat.coven.discovery.owner-local',
    'chat.coven.executable.trusted',
    'chat.coven.health',
    'chat.coven.structured-errors-preserved',
  ];
  await withOwnedArtifactRoot(covenRoot, async () => {
    mkdirSync(covenHome, { recursive: true, mode: 0o700 });
    ownershipVerified = verifyOwnedDirectory(covenHome);
    let rpc;
    let activeCovenIdentityStage = 'rpc-start';
    try {
      activeCovenIdentityStage = 'rpc-start';
      rpc = await startNativeRpc(
        artifactRoot,
        nativeRpcPath,
        { ...environment, COVEN_HOME: covenHome },
        projectRoot,
      );
      activeCovenIdentityStage = 'unavailable-health';
      await rpc.error('coven_health', { operation: rpc.operation() }, 'service_unavailable');
      activeCovenIdentityStage = 'daemon-spawn';
      const { child } = spawnOwnedProcess(covenCommand.executable, covenCommand.args, {
        cwd: covenCommand.cwd,
        env: { ...environment, COVEN_HOME: covenHome },
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      await once(child, 'spawn');
      covenRoot.trackChild(child);

      activeCovenIdentityStage = 'daemon-ready';
      let health;
      for (let attempt = 0; attempt < 80 && health === undefined; attempt += 1) {
        try {
          health = await rpc.ok('coven_health', { operation: rpc.operation() });
        } catch {
          await new Promise((resolveWait) => setTimeout(resolveWait, 100));
        }
      }
      if (health?.status !== 'ok') {
        throw new Error('Chat Coven adapter did not authenticate the daemon.');
      }

      if (process.platform !== 'win32') {
        activeCovenIdentityStage = 'malicious-home';
        const maliciousHome = resolve(covenRoot.rootPath, 'malicious-home');
        symlinkSync(covenHome, maliciousHome, 'dir');
        await expectCovenHealthFailure(
          artifactRoot,
          nativeRpcPath,
          environment,
          maliciousHome,
          'service_unavailable',
        );

        activeCovenIdentityStage = 'wrong-mode-home';
        const wrongModeHome = resolve(covenRoot.rootPath, 'wrong-mode-home');
        mkdirSync(wrongModeHome, { mode: 0o700 });
        chmodSync(wrongModeHome, 0o755);
        await expectCovenHealthFailure(
          artifactRoot,
          nativeRpcPath,
          environment,
          wrongModeHome,
          'service_unavailable',
        );

        activeCovenIdentityStage = 'symlink-socket-home';
        const symlinkSocketHome = resolve(covenRoot.rootPath, 'symlink-socket-home');
        mkdirSync(symlinkSocketHome, { mode: 0o700 });
        symlinkSync(resolve(covenHome, 'coven.sock'), resolve(symlinkSocketHome, 'coven.sock'));
        await expectCovenHealthFailure(
          artifactRoot,
          nativeRpcPath,
          environment,
          symlinkSocketHome,
          'service_unavailable',
        );

        activeCovenIdentityStage = 'socket-mode';
        const socketPath = resolve(covenHome, 'coven.sock');
        chmodSync(socketPath, 0o666);
        try {
          await rpc.error('coven_health', { operation: rpc.operation() }, 'service_unavailable');
        } finally {
          chmodSync(socketPath, 0o600);
        }
        verifiedChatAssertions.push(
          'chat.coven.unix.connected-peer-identity',
          'chat.coven.unix.malicious-home-refused',
          'chat.coven.unix.symlink-socket-refused',
          'chat.coven.unix.wrong-mode-refused',
        );
      } else {
        verifiedChatAssertions.push(
          'chat.coven.windows.pipe-owner',
          'chat.coven.windows.connected-pipe-identity',
        );
      }

      activeCovenIdentityStage = 'result';
      addAssertion(results, 'phase1.coven.same-user-identity', 'passed', 'phase1.assertion.passed');
    } catch {
      const diagnosticId = covenIdentityFailureDiagnostic(activeCovenIdentityStage);
      process.stderr.write(`phase1-conformance: ${diagnosticId}\n`);
      addAssertion(results, 'phase1.coven.same-user-identity', 'failed', diagnosticId);
    } finally {
      if (rpc !== undefined) {
        await rpc.close();
      }
    }
  });
  return {
    id: 'coven-home',
    ownershipVerified,
    removedAfterRun: !existsSync(covenRoot.rootPath) && !existsSync(covenHome),
    verifiedSdkAssertions,
    verifiedChatAssertions,
  };
}

export function covenIdentityFailureDiagnostic(stage) {
  return covenIdentityFailureStages.has(stage)
    ? `phase1.coven-identity.${stage}`
    : 'phase1.coven-identity.unknown';
}

function recordCaveBackedAssertions(results, caveAssertions) {
  const mappings = [
    ['phase1.pairing.expiry', ['pairing.ttl-poll-expired', 'pairing.ttl-exchange-expired']],
    [
      'phase1.pairing.wrong-secret-replay',
      ['pairing.wrong-secret', 'pairing.replay-refused', 'pairing.poll-after-exchange'],
    ],
    [
      'phase1.pairing.failure-budget-retry-after',
      [
        'pairing.budget-charges-wrong-secret-on-poll',
        'pairing.budget-locks-out-the-holder',
        'pairing.budget-is-shared-across-routes',
        'pairing.budget-is-per-pairing',
      ],
    ],
    [
      'phase1.hpke.endpoint-takeover',
      [
        'takeover.legacy.exposes-pairing-secret',
        'takeover.bound.exposes-ciphertext-only',
        'takeover.bound.replacement-cannot-open',
        'takeover.bound.plaintext-response-rejected',
        'takeover.bound.forged-auth-response-rejected',
      ],
    ],
  ];
  for (const [id, caveIds] of mappings) {
    addAssertion(
      results,
      id,
      requirePassedAssertions(caveAssertions, caveIds) ? 'passed' : 'failed',
      requirePassedAssertions(caveAssertions, caveIds)
        ? 'phase1.assertion.passed'
        : 'phase1.assertion.failed',
    );
  }
}

export function recordCaveMatrixFailure(results, error) {
  recordCaveBackedAssertions(results, new Map());
  return error;
}

export function wrapInfrastructureFailure(error, report) {
  if (
    error !== null &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string' &&
    publicPhase1DiagnosticIds.has(error.message)
  ) {
    const wrapped = new Error(error.message, { cause: error });
    wrapped.result = { report };
    return wrapped;
  }
  if (error instanceof CommandExecutionError) {
    const reason = approvedCommandFailureReasons.has(error.result?.reason)
      ? error.result.reason
      : undefined;
    return new CommandExecutionError(
      error.label,
      {
        ...(reason === undefined ? {} : { reason }),
        report,
      },
      error,
    );
  }
  return new CommandExecutionError('Phase 1 conformance infrastructure', { report }, error);
}

function readLockedDigestFile(rootPath, metadata, label) {
  const path = resolve(rootPath, metadata.path);
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile() || sha256File(path) !== metadata.sha256) {
    throw new Error(`${label} does not match the immutable conformance lock.`);
  }
  return path;
}

async function loadEvidenceAuthorities(roots, lock) {
  const registryPath = readLockedDigestFile(
    roots.sdkEvidenceRoot,
    lock.evidence.assertionRegistry,
    'SDK assertion registry',
  );
  readLockedDigestFile(roots.sdkEvidenceRoot, lock.evidence.schema, 'SDK evidence schema');
  const contractPath = readLockedDigestFile(
    roots.sdkEvidenceRoot,
    lock.evidence.contract,
    'SDK evidence contract',
  );
  const registryText = readFileSync(registryPath, 'utf8');
  const registry = parseLockedAssertionRegistry(
    registryText,
    lock.evidence.assertionRegistry.sha256,
    'SDK assertion registry',
  );
  const contract = await import(
    `${pathToFileURL(contractPath).href}?sha256=${lock.evidence.contract.sha256}`
  );
  const parsedBySdk = contract.parseAssertionRegistry(registryText, 'Chat locked SDK registry');
  if (JSON.stringify(parsedBySdk) !== JSON.stringify(registry)) {
    throw new Error('Chat registry parser disagrees with the locked SDK contract.');
  }
  return { registry, parsePlatformEvidence: contract.parsePlatformEvidence };
}

const covenAuthorityControlResources = Object.freeze([
  { name: 'daemon.json', maxBytes: 64 * 1024 },
  { name: 'daemon.lock', maxBytes: 64 * 1024 },
  { name: 'daemon-serve.lock', maxBytes: 64 * 1024 },
  { name: 'state.lock', maxBytes: 64 * 1024 },
  { name: 'reset-transaction.json', maxBytes: 64 * 1024 },
  { name: 'coven.sock', maxBytes: 0, allowSocket: true },
]);
const caveAuthorityControlResources = Object.freeze([
  { name: 'projects.json', maxBytes: 8 * 1024 * 1024 },
]);
const operatorTopLevelEntryLimit = 4_096;

function fingerprintStat(stats, includeDirectoryMutationMetadata = true) {
  const type = stats.isDirectory()
    ? 'directory'
    : stats.isFile()
      ? 'file'
      : stats.isSymbolicLink()
        ? 'symlink'
        : stats.isSocket()
          ? 'socket'
          : 'other';
  const identity = [type, stats.mode & 0o7777n, stats.dev, stats.ino];
  if (!stats.isDirectory() || includeDirectoryMutationMetadata) {
    identity.push(stats.size, stats.mtimeNs, stats.ctimeNs, stats.birthtimeNs);
  }
  return identity.join('\0');
}

function lstatForOperatorFingerprint(path) {
  try {
    return lstatSync(path, { bigint: true });
  } catch {
    throw new Error('phase1.operator-fingerprint.failed');
  }
}

function tryLstatForOperatorFingerprint(path) {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw new Error('phase1.operator-fingerprint.failed');
  }
}

function updateAuthorityControlFingerprint(digest, root, resource) {
  const path = resolve(root, resource.name);
  digest.update(`control\0${resource.name}\0`);
  const before = tryLstatForOperatorFingerprint(path);
  if (before === undefined) {
    digest.update('missing\0');
    return;
  }
  if (before.isSymbolicLink()) {
    throw new Error('phase1.operator-fingerprint.unsafe-control-resource');
  }
  digest.update(`${fingerprintStat(before)}\0`);
  if (before.isSocket() && resource.allowSocket === true) {
    return;
  }
  if (!before.isFile()) {
    throw new Error('phase1.operator-fingerprint.unsafe-control-resource');
  }
  if (before.size > BigInt(resource.maxBytes)) {
    throw new Error('phase1.operator-fingerprint.control-file-limit');
  }
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new Error('phase1.operator-fingerprint.failed');
  }
  const after = lstatForOperatorFingerprint(path);
  if (fingerprintStat(before) !== fingerprintStat(after)) {
    throw new Error('phase1.operator-fingerprint.changed-during-read');
  }
  digest.update(bytes);
  digest.update('\0');
}

function fingerprintShallowAuthorityState(
  root,
  controlResources,
  includeDirectoryEntryMutationMetadata = true,
) {
  const digest = createHash('sha256');
  const rootStats = tryLstatForOperatorFingerprint(root);
  if (rootStats === undefined) {
    digest.update('missing');
    return digest.digest('hex');
  }

  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error('phase1.operator-fingerprint.unsafe-root');
  }
  digest.update(`root\0${fingerprintStat(rootStats)}\0`);

  let entries;
  try {
    entries = readdirSync(root).sort();
  } catch {
    throw new Error('phase1.operator-fingerprint.failed');
  }
  if (entries.length > operatorTopLevelEntryLimit) {
    throw new Error('phase1.operator-fingerprint.entry-limit');
  }
  for (const entry of entries) {
    const stats = lstatForOperatorFingerprint(resolve(root, entry));
    digest.update(
      `entry\0${entry}\0${fingerprintStat(stats, includeDirectoryEntryMutationMetadata)}\0`,
    );
  }

  for (const resource of controlResources) {
    updateAuthorityControlFingerprint(digest, root, resource);
  }
  return digest.digest('hex');
}

function fingerprintSingleAuthorityControl(root, resource) {
  const digest = createHash('sha256');
  updateAuthorityControlFingerprint(digest, root, resource);
  return digest.digest('hex');
}

export function snapshotOperatorState(operatorHome = process.env.HOME) {
  if (typeof operatorHome !== 'string' || operatorHome.length === 0) {
    throw new Error('Operator HOME is unavailable for isolation proof.');
  }
  const caveHome = resolve(operatorHome, '.coven', 'cave');
  const covenHome = resolve(operatorHome, '.coven');
  return {
    'cave-home': fingerprintShallowAuthorityState(caveHome, caveAuthorityControlResources, false),
    'coven-home': fingerprintShallowAuthorityState(covenHome, covenAuthorityControlResources),
    projects: fingerprintSingleAuthorityControl(caveHome, caveAuthorityControlResources[0]),
  };
}

function assertOperatorStateUnchanged(before, after) {
  for (const id of ['cave-home', 'coven-home', 'projects']) {
    if (before[id] !== after[id]) {
      throw new Error(`Operator resource ${id} changed during conformance.`);
    }
  }
}

function verifyOwnedDirectory(path) {
  const stats = lstatSync(path);
  return (
    stats.isDirectory() &&
    !stats.isSymbolicLink() &&
    (stats.mode & 0o077) === 0 &&
    (typeof process.getuid !== 'function' || stats.uid === process.getuid())
  );
}

function assertNativeCredentialProviderIsolated() {
  if (process.platform !== 'darwin') {
    return;
  }
  const keychainPath = process.env.PHASE1_TEST_KEYCHAIN;
  if (typeof keychainPath !== 'string' || keychainPath.length === 0) {
    throw new Error('Isolated macOS keychain path is required.');
  }
  const activeKeychain = runSupervisedSync('security', ['default-keychain', '-d', 'user'], {
    encoding: 'utf8',
  })
    .trim()
    .replace(/^"|"$/gu, '');
  const stats = lstatSync(keychainPath);
  if (
    !stats.isFile() ||
    stats.isSymbolicLink() ||
    realpathSync(activeKeychain) !== realpathSync(keychainPath)
  ) {
    throw new Error('Configured macOS keychain is not the isolated provider.');
  }
}

function recordVerifiedIds(recorder, scope, ids, diagnosticId) {
  for (const id of ids) {
    recorder.pass(scope, id, diagnosticId);
  }
}

function requireRustTestProof(passedTests, testName, assertionId) {
  if (
    ![...passedTests].some(
      (observed) => observed === testName || observed.endsWith(`::${testName}`),
    )
  ) {
    throw new Error(`Rust proof for ${assertionId} did not pass.`);
  }
  return assertionId;
}

function platformCovenTestProofs(platform, passedTests) {
  const executableTrustProofs = [
    'native_coven_health_uses_a_fixed_null_stdio_self_process_boundary',
    'child_probe_panic_is_redacted_and_bounded',
  ];
  if (platform === 'win32-x64') {
    const mappings = [
      [
        'chat.coven.windows.malicious-home-refused',
        'recorded_daemon_status_rejects_a_stable_pipe_for_another_profile',
      ],
      [
        'chat.coven.windows.constructed-pipe-refused',
        'recorded_windows_pipe_candidates_accept_only_coven_stable_or_legacy_shapes',
      ],
      [
        'chat.coven.windows.foreign-pipe-refused',
        'inherited_legacy_status_rejects_cross_profile_and_arbitrary_redirection_before_connecting',
      ],
      [
        'chat.coven.windows.ownership-provider-failure-refused',
        'windows_ownership_provider_failure_maps_to_fail_closed_diagnostic',
      ],
      [
        'chat.coven.windows.reparse-endpoint-refused',
        'legacy_v1_case_check_rejects_sensitive_or_unverifiable_ancestors',
      ],
    ];
    const ids = mappings.map(([id, testName]) => requireRustTestProof(passedTests, testName, id));
    for (const testName of executableTrustProofs) {
      requireRustTestProof(
        passedTests,
        testName,
        'chat.coven.windows.executable-trust-failure-refused',
      );
    }
    ids.push('chat.coven.windows.executable-trust-failure-refused');
    return ids;
  }

  const mappings = [
    [
      'chat.coven.unix.replaced-socket-refused',
      'a_mutation_is_not_sent_to_a_replacement_before_that_peer_is_negotiated',
    ],
    [
      'chat.coven.unix.wrong-owner-refused',
      'wrong_owner_discovery_failure_maps_to_fail_closed_diagnostic',
    ],
    [
      'chat.coven.unix.wrong-peer-uid-refused',
      'connected_peer_uid_must_match_discovered_and_current_owner',
    ],
    [
      'chat.coven.unix.peer-provider-failure-refused',
      'unix_peer_provider_failure_maps_to_fail_closed_diagnostic',
    ],
  ];
  const ids = mappings.map(([id, testName]) => requireRustTestProof(passedTests, testName, id));
  for (const testName of executableTrustProofs) {
    requireRustTestProof(passedTests, testName, 'chat.coven.unix.executable-trust-failure-refused');
  }
  ids.push('chat.coven.unix.executable-trust-failure-refused');
  return ids;
}

export function runtimeScenarioFailureDiagnostic(results) {
  for (const [id, diagnosticId] of runtimeScenarioDiagnosticIds) {
    const assertion = results.get(id);
    if (assertion?.status !== 'passed') {
      const recordedDiagnostic = assertion?.diagnosticIds?.[0];
      if (
        id === 'phase1.coven.same-user-identity' &&
        covenIdentityDiagnosticIds.has(recordedDiagnostic)
      ) {
        return recordedDiagnostic;
      }
      return diagnosticId;
    }
  }
  return undefined;
}

export function evidenceValidationFailureDiagnostic(error) {
  const message =
    error !== null &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
      ? error.message
      : '';
  if (
    message.includes('evidence limit') ||
    /^Evidence exceeds the \d+-(?:node|level depth) limit$/u.test(message)
  ) {
    return 'phase1.stage.evidence-validation.size';
  }
  if (message.includes('is not valid JSON')) {
    return 'phase1.stage.evidence-validation.json';
  }
  if (message.includes('duplicate JSON object key')) {
    return 'phase1.stage.evidence-validation.duplicate-key';
  }
  if (message.includes('contains a possible secret')) {
    return 'phase1.stage.evidence-validation.possible-secret';
  }
  if (message.includes('contains a private filesystem path')) {
    return 'phase1.stage.evidence-validation.private-path';
  }
  if (message.includes('forbidden evidence field')) {
    return 'phase1.stage.evidence-validation.forbidden-field';
  }
  if (message.includes('contains a non-JSON value')) {
    return 'phase1.stage.evidence-validation.non-json';
  }
  if (message.startsWith('Chat Phase 1 platform evidence')) {
    return 'phase1.stage.evidence-validation.shape';
  }
  return 'phase1.stage.evidence-validation.unknown';
}

function assertRuntimeScenariosPassed(results) {
  const diagnosticId = runtimeScenarioFailureDiagnostic(results);
  if (diagnosticId !== undefined) {
    throw new Error(diagnosticId);
  }
}

export function finalizeOperatorSafety({
  primaryFailure,
  cleanupFailure,
  operatorStateBefore,
  snapshotAfter = snapshotOperatorState,
  compare = assertOperatorStateUnchanged,
}) {
  let operatorStateAfter;
  let isolationFailure;
  if (operatorStateBefore !== undefined) {
    try {
      operatorStateAfter = snapshotAfter();
      compare(operatorStateBefore, operatorStateAfter);
    } catch (error) {
      isolationFailure = error;
    }
  }
  const failures = [primaryFailure, cleanupFailure, isolationFailure].flatMap((failure) =>
    failure instanceof AggregateError ? failure.errors : failure === undefined ? [] : [failure],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, 'Phase 1 conformance failed with safety diagnostics.');
  }
  return operatorStateAfter;
}

function parseVitestObservationReport(path, label) {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > 4 * 1024 * 1024) {
    throw new Error(`${label} report is not a bounded regular file.`);
  }
  const report = JSON.parse(readFileSync(path, 'utf8'));
  if (
    report?.success !== true ||
    !Array.isArray(report.testResults) ||
    report.testResults.length === 0
  ) {
    throw new Error(`${label} did not report a complete passing test run.`);
  }
  const passed = new Set();
  for (const file of report.testResults) {
    if (!Array.isArray(file.assertionResults)) {
      throw new Error(`${label} contained malformed test results.`);
    }
    for (const assertion of file.assertionResults) {
      if (
        assertion.status !== 'passed' ||
        !Array.isArray(assertion.ancestorTitles) ||
        typeof assertion.title !== 'string'
      ) {
        continue;
      }
      passed.add([...assertion.ancestorTitles, assertion.title].join(' > '));
    }
  }
  return passed;
}

async function runVitestObservationSuite({
  artifactRoot,
  rootPath,
  environment,
  label,
  files,
  outputName,
}) {
  const outputPath = resolve(artifactRoot.rootPath, outputName);
  await runCommand(
    artifactRoot,
    label,
    'pnpm',
    [
      '--ignore-workspace',
      'exec',
      'vitest',
      'run',
      ...files,
      '--reporter=json',
      `--outputFile=${outputPath}`,
    ],
    {
      cwd: rootPath,
      env: environment,
    },
  );
  return parseVitestObservationReport(outputPath, label);
}

function parseCargoPassedTests(output) {
  const passed = new Set();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^test ([A-Za-z0-9_:]+) \.\.\. ok$/u.exec(line.trim());
    if (match !== null) {
      passed.add(match[1]);
    }
  }
  return passed;
}

async function runExactCargoObservationTests({
  artifactRoot,
  rootPath,
  environment,
  label,
  tests,
}) {
  const passed = new Set();
  for (const test of tests) {
    const result = await runCommand(
      artifactRoot,
      `${label} ${test.name}`,
      'cargo',
      [...test.args, test.name, '--', '--exact'],
      {
        cwd: rootPath,
        env: environment,
        timeoutMs: cargoBuildTimeoutMs,
      },
    );
    const observed = parseCargoPassedTests(result.stdout);
    if (!observed.has(test.name)) {
      throw new Error(`${label} did not execute ${test.name}.`);
    }
    passed.add(test.name);
  }
  return passed;
}

export function normalizeSchemaV2ObservationTests(value) {
  const keys = ['chat', 'chatRust', 'covenRust', 'sdk'];
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !== keys.join('\0') ||
    keys.some((key) => !(value[key] instanceof Set))
  ) {
    throw new Error('Schema-v2 observation test results are incomplete or malformed.');
  }
  return Object.freeze({
    sdk: value.sdk,
    chat: value.chat,
    chatRust: value.chatRust,
    covenRust: value.covenRust,
  });
}

export async function runSchemaV2ObservationSuites(artifactRoot, roots, environment, platform) {
  const shortRoot =
    process.platform === 'win32'
      ? undefined
      : createProcessOwnedArtifactRoot({ prefix: 'p1ot', shortPath: true });
  const testEnvironment =
    shortRoot === undefined
      ? environment
      : {
          ...environment,
          TMPDIR: shortRoot.rootPath,
          TMP: shortRoot.rootPath,
          TEMP: shortRoot.rootPath,
        };
  try {
    await installPnpm(artifactRoot, roots.sdkRoot, environment, 'SDK observation');
    await installPnpm(artifactRoot, roots.producerRoot, environment, 'Chat observation');
    const sdkTests = await runVitestObservationSuite({
      artifactRoot,
      rootPath: roots.sdkRoot,
      environment: testEnvironment,
      label: 'SDK schema-v2 observation tests',
      files: [
        'tests/cave-discovery-pairing.spec.ts',
        'tests/cave-canonical-reads.spec.ts',
        'tests/cave-hpke-bound-v1.spec.ts',
        'tests/cave-managed-native.spec.ts',
        'tests/cave-managed-native-staged.spec.ts',
        'tests/coven-discovery.spec.ts',
        'tests/health-validation.spec.ts',
        'tests/client-contract.spec.ts',
        'tests/native-secret-store.spec.ts',
      ],
      outputName: 'sdk-observation-tests.json',
    });
    const chatTests = await runVitestObservationSuite({
      artifactRoot,
      rootPath: roots.producerRoot,
      environment: testEnvironment,
      label: 'Chat schema-v2 observation tests',
      files: [
        'src/lib/sdk/native-boundary.test.ts',
        'src/lib/sdk/connection-controller.test.ts',
        'src/lib/sdk/query-adapter.test.ts',
        'src/lib/sdk/managed-credential-status.e2e.test.ts',
      ],
      outputName: 'chat-observation-tests.json',
    });
    const chatCargoArgs = [
      'test',
      '--locked',
      '--manifest-path',
      resolve(roots.producerRoot, 'src-tauri', 'Cargo.toml'),
      '--features',
      'phase1-conformance',
      '--lib',
    ];
    const chatRustTests = await runExactCargoObservationTests({
      artifactRoot,
      rootPath: roots.producerRoot,
      environment: testEnvironment,
      label: 'Chat native schema-v2 observation tests',
      tests: [
        {
          args: chatCargoArgs,
          name: 'transport::tests::pairing_exchange_empty_post_declares_zero_content_length',
        },
        {
          args: chatCargoArgs,
          name: 'coven::tests::maps_client_failures_to_bounded_diagnostics_without_leaking_details',
        },
      ],
    });
    const covenLibraryTests =
      platform === 'win32-x64'
        ? [
            'discovery::tests::legacy_v1_case_check_rejects_sensitive_or_unverifiable_ancestors',
            'discovery::tests::recorded_windows_pipe_candidates_accept_only_coven_stable_or_legacy_shapes',
            'discovery::tests::recorded_daemon_status_rejects_a_stable_pipe_for_another_profile',
            'discovery::tests::windows_security_inspection_waits_are_finite_and_preserve_submillisecond_budget',
            'discovery::tests::status_file_reader_allows_an_atomic_status_replacement',
          ]
        : [
            'transport::unix::tests::platform_peer_credentials_report_the_connected_process_uid',
            'transport::unix::tests::connected_peer_uid_must_match_discovered_and_current_owner',
          ];
    const covenRustTests = await runExactCargoObservationTests({
      artifactRoot,
      rootPath: roots.covenRoot,
      environment: testEnvironment,
      label: 'Coven native trust observation tests',
      tests: [
        ...covenLibraryTests.map((name) => ({
          args: ['test', '--locked', '-p', 'coven-client', '--lib'],
          name,
        })),
        ...(platform === 'win32-x64'
          ? []
          : [
              {
                args: ['test', '--locked', '-p', 'coven-client', '--test', 'health'],
                name: 'discovers_only_an_owner_local_unix_socket',
              },
              {
                args: ['test', '--locked', '-p', 'coven-client', '--test', 'health'],
                name: 'a_mutation_is_not_sent_to_a_replacement_before_that_peer_is_negotiated',
              },
            ]),
      ],
    });
    return normalizeSchemaV2ObservationTests({
      sdk: sdkTests,
      chat: chatTests,
      chatRust: chatRustTests,
      covenRust: covenRustTests,
    });
  } finally {
    if (shortRoot !== undefined) {
      await shortRoot.cleanup();
    }
  }
}

function passedTest(tests, fragment) {
  return [...tests].some((name) => name.includes(fragment));
}

function primaryPassed(report, id) {
  return report.assertions.some(
    (assertion) => assertion.id === id && assertion.status === 'passed',
  );
}

function cavePassed(caveRecord, ...ids) {
  const results = new Map(
    caveRecord.assertions.map((assertion) => [assertion.id, assertion.result]),
  );
  return ids.every((id) => results.get(id) === 'pass');
}

function recordWhen(recorder, id, condition) {
  if (condition) {
    recorder.pass(id);
  }
}

export function buildObservedSchemaV2Assertions({
  registry,
  platform,
  packageObservations,
  primaryReport,
  caveRecord,
  native,
  coven,
  tests,
  scansPassed,
}) {
  const sdk = createObservedAssertionRecorder(registry.assertions.sdk, 'SDK');
  const chatIds = [
    ...registry.assertions.chat.common,
    ...registry.assertions.chat.platforms[platform],
  ];
  const chat = createObservedAssertionRecorder(chatIds, 'Chat');
  for (const id of packageObservations.sdk) {
    sdk.pass(id);
  }
  for (const id of packageObservations.chat) {
    chat.pass(id);
  }

  const sdkTest = (fragment) => passedTest(tests.sdk, fragment);
  const chatTest = (fragment) => passedTest(tests.chat, fragment);
  const chatRustTest = (fragment) => passedTest(tests.chatRust, fragment);
  const covenRustTest = (fragment) => passedTest(tests.covenRust, fragment);

  recordWhen(
    sdk,
    'sdk.cave.discovery.release-mode',
    native.releaseDiscovery &&
      cavePassed(caveRecord, 'health.discovery-record') &&
      sdkTest('canonicalizes routes and validates strict discovery v2'),
  );
  recordWhen(
    sdk,
    'sdk.cave.discovery.stale-record-refused',
    native.staleStateRefused && sdkTest('rejects stale or malformed discovery records'),
  );
  recordWhen(
    sdk,
    'sdk.cave.discovery.replaced-instance-refused',
    native.staleStateRefused &&
      sdkTest('invalidates an instance-replaced credential before bearer attachment'),
  );
  recordWhen(
    sdk,
    'sdk.cave.health.compatible',
    native.compatibleHealth &&
      primaryPassed(primaryReport, 'phase1.compat.api-major-min-client') &&
      sdkTest('accepts Cave health responses when the minimum client version is compatible'),
  );
  recordWhen(
    sdk,
    'sdk.cave.pairing.create',
    native.pairingCreate &&
      cavePassed(caveRecord, 'pairing.create') &&
      sdkTest('creates, polls, exchanges, validates, and forgets a paired credential'),
  );
  recordWhen(
    sdk,
    'sdk.cave.pairing.pending',
    native.pairingPending &&
      cavePassed(caveRecord, 'pairing.poll-pending') &&
      sdkTest("surfaces pairing exchange errors: 'pairing_pending'"),
  );
  recordWhen(
    sdk,
    'sdk.cave.pairing.exchange-once',
    native.pairingExchange &&
      cavePassed(caveRecord, 'pairing.exchange', 'pairing.replay-refused') &&
      sdkTest('allows only one transport exchange across concurrent exchange attempts'),
  );
  recordWhen(
    sdk,
    'sdk.cave.pairing.denied',
    native.pairingDenied &&
      cavePassed(caveRecord, 'pairing.poll-denied', 'pairing.exchange-denied') &&
      sdkTest("surfaces pairing exchange errors: 'pairing_denied'"),
  );
  recordWhen(
    sdk,
    'sdk.cave.pairing.expired',
    primaryPassed(primaryReport, 'phase1.pairing.expiry') &&
      cavePassed(caveRecord, 'pairing.ttl-poll-expired', 'pairing.ttl-exchange-expired') &&
      sdkTest("surfaces pairing exchange errors: 'pairing_expired'"),
  );
  recordWhen(
    sdk,
    'sdk.cave.pairing.wrong-secret-refused',
    cavePassed(caveRecord, 'pairing.wrong-secret'),
  );
  recordWhen(
    sdk,
    'sdk.cave.pairing.replay-refused',
    cavePassed(caveRecord, 'pairing.replay-refused') &&
      sdkTest('allows retry after a pre-send authority mismatch without replaying the secret'),
  );
  recordWhen(
    sdk,
    'sdk.cave.pairing.shared-failure-budget',
    cavePassed(
      caveRecord,
      'pairing.budget-charges-wrong-secret-on-poll',
      'pairing.budget-locks-out-the-holder',
      'pairing.budget-is-shared-across-routes',
    ),
  );
  recordWhen(
    sdk,
    'sdk.cave.pairing.rate-limit',
    cavePassed(caveRecord, 'pairing.budget-locks-out-the-holder') &&
      sdkTest('preserves the managed contract error code and retry semantics for rate_limited'),
  );
  recordWhen(
    sdk,
    'sdk.cave.exchange.missing-content-length-refused',
    cavePassed(caveRecord, 'ingress.exchange-requires-content-length'),
  );
  recordWhen(
    sdk,
    'sdk.cave.exchange.content-length-zero-accepted',
    cavePassed(caveRecord, 'pairing.exchange') &&
      chatRustTest('pairing_exchange_empty_post_declares_zero_content_length'),
  );
  recordWhen(
    sdk,
    'sdk.cave.proxy-rejection.distinct-envelope',
    sdkTest('never parses a proxy rejection as a Client v1 health envelope'),
  );
  recordWhen(sdk, 'sdk.cave.credential.native-store-required', native.nativeStoreRoundtrip);
  recordWhen(sdk, 'sdk.cave.credential.restart-reused', native.restartCredentialReused);
  for (const [id, key] of [
    ['sdk.cave.read.familiars', 'familiars'],
    ['sdk.cave.read.projects', 'projects'],
    ['sdk.cave.read.conversations', 'conversations'],
    ['sdk.cave.read.conversation', 'conversation'],
    ['sdk.cave.read.messages', 'messages'],
  ]) {
    recordWhen(
      sdk,
      id,
      native.reads[key] &&
        sdkTest('uses exact canonical routes, deterministic queries, encoded ids'),
    );
  }
  recordWhen(
    sdk,
    'sdk.cave.cursor.malformed-refused',
    sdkTest('validates page options and conversation ids before transport I/O'),
  );
  recordWhen(
    sdk,
    'sdk.cave.cursor.noncanonical-refused',
    sdkTest('parses the optional top-level cursor with core canonical validation'),
  );
  recordWhen(
    sdk,
    'sdk.cave.cursor.reconcile-required',
    native.reconcileRequired &&
      sdkTest('propagates reconcile_required from messages without retrying and forwards the id'),
  );
  for (const [id, key] of [
    ['sdk.cave.revocation.familiars-refused', 'familiars'],
    ['sdk.cave.revocation.projects-refused', 'projects'],
    ['sdk.cave.revocation.conversations-refused', 'conversations'],
    ['sdk.cave.revocation.conversation-refused', 'conversation'],
    ['sdk.cave.revocation.messages-refused', 'messages'],
  ]) {
    recordWhen(
      sdk,
      id,
      native.revokedReads[key] &&
        sdkTest('preserves revoked bearer rejection without fallback or retry'),
    );
  }
  recordWhen(
    sdk,
    'sdk.coven.discovery.owner-local',
    coven.ownerLocal && sdkTest('prefers non-empty COVEN_HOME without invoking the CLI'),
  );
  recordWhen(
    sdk,
    'sdk.coven.health',
    coven.health && sdkTest('sends only the reviewed health request and parses a valid response'),
  );
  recordWhen(
    sdk,
    'sdk.coven.structured-errors',
    sdkTest('preserves structured daemon error fields without flattening them'),
  );
  recordWhen(
    sdk,
    'sdk.deadline.connect-bounded',
    sdkTest('reports connect timeout and honors cancellation'),
  );
  recordWhen(
    sdk,
    'sdk.deadline.read-bounded',
    sdkTest('rejects a Unix response received at its 1ms absolute deadline') ||
      sdkTest('rejects a Windows response received at its 1ms absolute deadline'),
  );
  recordWhen(sdk, 'sdk.deadline.body-bounded', sdkTest("rejects 'oversized body declaration'"));
  recordWhen(
    sdk,
    'sdk.deadline.frame-bounded',
    sdkTest('rejects invalid HTTP health framing') ||
      sdkTest('shares frame limits and structured daemon errors with Unix'),
  );
  recordWhen(
    sdk,
    'sdk.native.keychain-missing-fails-closed',
    native.keychainUnavailable &&
      sdkTest('rejects missing Entry constructors as secure_store_unavailable'),
  );
  recordWhen(
    sdk,
    'sdk.native.trust-binding-missing-fails-closed',
    coven.trustProviderUnavailable &&
      sdkTest('fails closed before discovery when transport security is missing at runtime'),
  );

  recordWhen(chat, 'chat.cave.compatibility-before-pairing', native.compatibilityBeforePairing);
  recordWhen(chat, 'chat.cave.pairing-secret-remains-native', native.pairingSecretNative);
  recordWhen(chat, 'chat.cave.bearer-remains-native', native.bearerNative);
  recordWhen(
    chat,
    'chat.cave.bearer-never-enters-webview',
    native.bearerNeverCrossedBoundary &&
      chatTest('never places secret canaries in managed command arguments or results'),
  );
  recordWhen(chat, 'chat.cave.native-store.roundtrip', native.nativeStoreRoundtrip);
  recordWhen(chat, 'chat.cave.restart.credential-reused', native.restartCredentialReused);
  recordWhen(chat, 'chat.cave.restart.no-automatic-repairing', native.noAutomaticRepairing);
  recordWhen(chat, 'chat.cave.replacement.stale-state-refused', native.staleStateRefused);
  for (const [id, key] of [
    ['chat.cave.read.familiars', 'familiars'],
    ['chat.cave.read.projects', 'projects'],
    ['chat.cave.read.conversations', 'conversations'],
    ['chat.cave.read.conversation', 'conversation'],
    ['chat.cave.read.messages', 'messages'],
  ]) {
    recordWhen(chat, id, native.reads[key]);
  }
  recordWhen(
    chat,
    'chat.cave.reconcile.reloads-query-only',
    native.reconcileRequired &&
      native.reconcileDidNotPair &&
      chatTest('surfaces reconcile_required separately from generic errors'),
  );
  recordWhen(
    chat,
    'chat.cave.revocation.transitions-state',
    native.revocationTransition &&
      chatTest('only revokes after a confirmed packed managed credential status'),
  );
  recordWhen(chat, 'chat.cave.revocation.all-reads-refused', native.allRevokedReadsRefused);
  recordWhen(chat, 'chat.coven.discovery.owner-local', coven.ownerLocal);
  recordWhen(chat, 'chat.coven.executable.trusted', coven.executableTrusted);
  recordWhen(chat, 'chat.coven.health', coven.health);
  recordWhen(
    chat,
    'chat.coven.structured-errors-preserved',
    chatRustTest('maps_client_failures_to_bounded_diagnostics_without_leaking_details'),
  );
  recordWhen(
    chat,
    'chat.deadline.total-bounded',
    chatTest('propagates a managed SDK deadline to native cancellation and caps native duration'),
  );
  recordWhen(chat, 'chat.native.keychain-unavailable-fails-closed', native.keychainUnavailable);
  recordWhen(
    chat,
    'chat.native.trust-provider-unavailable-fails-closed',
    coven.trustProviderUnavailable,
  );
  for (const id of [
    'chat.evidence.no-prompts',
    'chat.evidence.no-message-bodies',
    'chat.evidence.no-attachments',
    'chat.evidence.no-command-output',
  ]) {
    recordWhen(chat, id, scansPassed);
  }

  if (platform === 'win32-x64') {
    recordWhen(chat, 'chat.coven.windows.pipe-owner', coven.ownerLocal);
    recordWhen(chat, 'chat.coven.windows.connected-pipe-identity', coven.connectedIdentity);
    recordWhen(
      chat,
      'chat.coven.windows.malicious-home-refused',
      covenRustTest('legacy_v1_case_check_rejects_sensitive_or_unverifiable_ancestors'),
    );
    recordWhen(
      chat,
      'chat.coven.windows.constructed-pipe-refused',
      covenRustTest('recorded_windows_pipe_candidates_accept_only_coven_stable_or_legacy_shapes'),
    );
    recordWhen(
      chat,
      'chat.coven.windows.foreign-pipe-refused',
      covenRustTest('recorded_daemon_status_rejects_a_stable_pipe_for_another_profile'),
    );
    recordWhen(
      chat,
      'chat.coven.windows.ownership-provider-failure-refused',
      covenRustTest('windows_security_inspection_waits_are_finite'),
    );
    recordWhen(
      chat,
      'chat.coven.windows.executable-trust-failure-refused',
      coven.executableTrustFailure,
    );
    recordWhen(
      chat,
      'chat.coven.windows.reparse-endpoint-refused',
      covenRustTest('status_file_reader_allows_an_atomic_status_replacement'),
    );
    recordWhen(
      chat,
      'chat.native.windows-credential-manager.isolated',
      native.nativeStoreRoundtrip && native.backend === 'windows-credential-manager',
    );
  } else {
    recordWhen(
      chat,
      'chat.coven.unix.connected-peer-identity',
      coven.connectedIdentity &&
        covenRustTest('platform_peer_credentials_report_the_connected_process_uid'),
    );
    for (const id of [
      'chat.coven.unix.malicious-home-refused',
      'chat.coven.unix.symlink-socket-refused',
      'chat.coven.unix.wrong-owner-refused',
      'chat.coven.unix.wrong-mode-refused',
    ]) {
      recordWhen(chat, id, covenRustTest('discovers_only_an_owner_local_unix_socket'));
    }
    recordWhen(
      chat,
      'chat.coven.unix.replaced-socket-refused',
      covenRustTest('a_mutation_is_not_sent_to_a_replacement_before_that_peer_is_negotiated'),
    );
    recordWhen(
      chat,
      'chat.coven.unix.wrong-peer-uid-refused',
      covenRustTest('connected_peer_uid_must_match_discovered_and_current_owner'),
    );
    recordWhen(
      chat,
      'chat.coven.unix.peer-provider-failure-refused',
      coven.trustProviderUnavailable,
    );
    recordWhen(
      chat,
      'chat.coven.unix.executable-trust-failure-refused',
      coven.executableTrustFailure,
    );
    recordWhen(
      chat,
      platform === 'darwin-arm64'
        ? 'chat.native.macos-keychain.isolated'
        : 'chat.native.linux-keyring.isolated',
      native.nativeStoreRoundtrip &&
        native.backend === CANONICAL_PLATFORM_ENVIRONMENTS[platform].nativeCustody,
    );
  }

  return {
    sdk: sdk.complete(),
    chat: chat.complete(),
  };
}

export async function runPhase1Conformance(
  options = runPublicPhase1Stage('phase1.stage.invocation.failed', () => parseArgs([])),
) {
  runPublicPhase1Stage('phase1.stage.runtime-integrity.failed', () =>
    assertNoNodeRuntimeInjection(),
  );
  const lock = runPublicPhase1Stage('phase1.stage.lock.failed', () =>
    bootstrapWindowsSupervisor(options),
  );
  const harnessAuthorityVerification = runPublicPhase1Stage(
    'phase1.stage.harness-authority.failed',
    () => assertExecutingHarnessAuthority(lock),
  );
  if (options.platform !== undefined) {
    return runPublicPhase1StageAsync('phase1.stage.schema-v2-production.failed', () =>
      runSchemaV2Conformance(options, lock, harnessAuthorityVerification),
    );
  }
  runPublicPhase1Stage('phase1.stage.native-provider.failed', () =>
    assertNativeCredentialProviderIsolated(),
  );
  const executionRoot = runPublicPhase1Stage('phase1.stage.execution-root.failed', () =>
    createProcessOwnedArtifactRoot({ prefix: 'p1run', shortPath: true }),
  );
  let environment;
  let results;
  let toolVersions;
  let operatorStateBefore;
  let platform;
  let artifactDigests;
  let caveRecord;
  let evidenceAuthorities;
  let assertionRecorder;
  let isolationRootObservations;
  let nativeCredentialStoreState;
  let primaryFailure;
  let cleanupFailure;
  let activeStage = 'phase1.stage.environment.failed';

  try {
    activeStage = 'phase1.stage.environment.failed';
    environment = runPublicPhase1Stage('phase1.stage.environment.failed', () =>
      safeEnvironment(executionRoot.rootPath),
    );
    results = new Map();
    activeStage = 'phase1.stage.toolchain.failed';
    toolVersions = runPublicPhase1Stage('phase1.stage.toolchain.failed', () =>
      observeReleaseToolVersions(),
    );
    operatorStateBefore = snapshotOperatorState();
    platform = canonicalPlatformId();
    activeStage = 'phase1.stage.checkouts.failed';
    const roots = await runPublicPhase1StageAsync('phase1.stage.checkouts.failed', () =>
      createExactCheckouts(executionRoot, options, lock, environment),
    );
    activeStage = 'phase1.stage.evidence-authority.failed';
    evidenceAuthorities = await runPublicPhase1StageAsync(
      'phase1.stage.evidence-authority.failed',
      () => loadEvidenceAuthorities(roots, lock),
    );
    assertionRecorder = createAssertionRecorder(evidenceAuthorities.registry, platform);
    activeStage = 'phase1.stage.packaging.failed';
    const packaged = await runPublicPhase1StageAsync('phase1.stage.packaging.failed', () =>
      packageLockedArtifacts(executionRoot, roots, environment, lock),
    );
    activeStage = 'phase1.stage.packaging-proof.failed';
    artifactDigests = packaged.artifactDigests;
    for (const id of packageSdkAssertionIds) {
      assertionRecorder.pass(
        'sdk',
        id,
        id === 'sdk.install.packed-tarballs'
          ? `phase1.sdk-candidate.${lock.sdk.revision}`
          : id === 'sdk.provenance.fixture-bytes-match'
            ? `phase1.sdk-manifest.${lock.release.sdkManifest.sha256}`
            : undefined,
      );
    }
    for (const id of packageChatAssertionIds) {
      assertionRecorder.pass(
        'chat',
        id,
        id === 'chat.install.consumer-lock-matches'
          ? `phase1.chat-harness.${lock.harness.revision}`
          : undefined,
      );
    }
    const deadlineProofs = [
      [
        'sdk.deadline.connect-bounded',
        platform === 'win32-x64'
          ? 'one_absolute_deadline_threads_only_remaining_budget_to_each_phase'
          : 'stalled_connect_receives_only_the_absolute_deadline_budget',
      ],
      [
        'sdk.deadline.read-bounded',
        platform === 'win32-x64'
          ? 'live_empty_named_pipe_waits_for_a_delayed_response'
          : 'lifecycle_probe_uses_one_absolute_deadline_for_a_stalled_response',
      ],
      [
        'sdk.deadline.body-bounded',
        platform === 'win32-x64'
          ? 'oversized_response_envelope_fails_closed_before_body_read'
          : 'oversized_request_bodies_are_rejected_before_any_connection_attempt',
      ],
      [
        'sdk.deadline.frame-bounded',
        platform === 'win32-x64'
          ? 'response_reader_rejects_coalesced_bytes_beyond_content_length'
          : 'rejects_bytes_buffered_after_an_ordinary_framed_response',
      ],
      [
        'chat.deadline.total-bounded',
        'synthetic_elapsed_time_stays_within_one_budget_across_launch_phases',
      ],
    ];
    for (const [id, testName] of deadlineProofs) {
      requireRustTestProof(packaged.passedRustTests, testName, id);
      assertionRecorder.pass(
        id.startsWith('sdk.') ? 'sdk' : 'chat',
        id,
        id === 'chat.deadline.total-bounded'
          ? windowsSupervisorDiagnosticId({
              windowsSupervisorSha256: lock.tools.windowsSupervisor.artifact.sha256,
              mingwPackageVersion: lock.tools.windowsSupervisor.toolchain.packageVersion,
              mingwHomebrewCoreRevision:
                lock.tools.windowsSupervisor.toolchain.homebrewCoreRevision,
              mingwBottleLayerSha256: lock.tools.windowsSupervisor.toolchain.bottleLayerSha256,
              mingwLinkerVersion: lock.tools.windowsSupervisor.toolchain.linkerVersion,
            })
          : undefined,
      );
    }

    activeStage = 'phase1.stage.cave-authority.failed';
    const cave = await runCaveAuthorityMatrix(executionRoot, roots.caveRoot, environment);
    caveRecord = cave.record;
    recordCaveBackedAssertions(results, cave.assertions);

    activeStage = 'phase1.stage.native-scenarios.failed';
    const nativeStoreProofRoot = resolve(executionRoot.rootPath, 'native-credential-store');
    mkdirSync(nativeStoreProofRoot, { mode: 0o700 });
    nativeCredentialStoreState = await runNativeScenarios({
      artifactRoot: executionRoot,
      roots,
      nativeRpcPath: packaged.nativeRpcPath,
      environment,
      results,
    });
    activeStage = 'phase1.stage.coven-identity.failed';
    const covenRootObservation = await runCovenIdentityScenario({
      artifactRoot: executionRoot,
      lockedCovenCheckoutRoot: roots.covenRoot,
      expectedCovenRevision: lock.coven.revision,
      nativeRpcPath: packaged.nativeRpcPath,
      covenBinaryPath: packaged.covenBinaryPath,
      environment,
      results,
    });
    activeStage = 'phase1.stage.runtime-assertions.failed';
    assertRuntimeScenariosPassed(results);
    recordVerifiedIds(assertionRecorder, 'sdk', caveSdkAssertionIds);
    recordVerifiedIds(assertionRecorder, 'sdk', nativeSdkAssertionIds);
    recordVerifiedIds(assertionRecorder, 'chat', caveChatAssertionIds);
    recordVerifiedIds(
      assertionRecorder,
      'chat',
      nativeChatAssertionIds.filter((id) => id !== 'chat.native.keychain-unavailable-fails-closed'),
    );
    assertionRecorder.pass(
      'chat',
      'chat.native.keychain-unavailable-fails-closed',
      `phase1.toolchain.rust.${toolVersions.rustVersion}`,
    );
    recordVerifiedIds(assertionRecorder, 'sdk', covenRootObservation.verifiedSdkAssertions);
    recordVerifiedIds(assertionRecorder, 'chat', covenRootObservation.verifiedChatAssertions);
    recordVerifiedIds(
      assertionRecorder,
      'chat',
      platformCovenTestProofs(platform, packaged.passedRustTests),
    );
    activeStage = 'phase1.stage.isolation.failed';
    const observedPaths = [
      {
        id: 'cave-home',
        path: resolve(executionRoot.rootPath, 'native-authority-home', 'coven', 'cave'),
      },
      {
        id: 'consumer-home',
        path: environment.HOME,
      },
      {
        id: 'native-credential-store',
        path: nativeStoreProofRoot,
      },
    ];
    isolationRootObservations = [
      {
        id: 'cave-home',
        path: observedPaths[0].path,
        ownershipVerified: verifyOwnedDirectory(observedPaths[0].path),
      },
      covenRootObservation,
      {
        id: 'consumer-home',
        path: observedPaths[1].path,
        ownershipVerified: verifyOwnedDirectory(observedPaths[1].path),
      },
      {
        id: 'native-credential-store',
        path: observedPaths[2].path,
        ownershipVerified:
          nativeCredentialStoreState.ownershipVerified &&
          verifyOwnedDirectory(observedPaths[2].path),
        removedAfterRun: nativeCredentialStoreState.removedAfterRun,
      },
    ];

    const operatorIsolationValid =
      environment.HOME !== process.env.HOME &&
      environment.XDG_CONFIG_HOME.startsWith(executionRoot.rootPath) &&
      environment.TMPDIR.startsWith(executionRoot.rootPath) &&
      environment.CARGO_HOME.startsWith(executionRoot.rootPath) &&
      environment.RUSTUP_HOME === undefined;
    if (!operatorIsolationValid) {
      throw new Error('Conformance environment did not isolate operator resources.');
    }
  } catch (error) {
    primaryFailure =
      publicPhase1FailureDiagnostic(error) === undefined
        ? new Error(activeStage, { cause: error })
        : error;
  } finally {
    try {
      await executionRoot.cleanup();
    } catch (error) {
      cleanupFailure = new Error('phase1.stage.execution-root-cleanup.failed', { cause: error });
    }
  }

  const { operatorStateAfter, isolationRoots } = runPublicPhase1Stage(
    'phase1.stage.isolation-proof.failed',
    () => ({
      operatorStateAfter: finalizeOperatorSafety({
        primaryFailure,
        cleanupFailure,
        operatorStateBefore,
      }),
      isolationRoots: isolationRootObservations.map((root) => ({
        id: root.id,
        ownershipVerified: root.ownershipVerified,
        removedAfterRun:
          typeof root.path === 'string'
            ? !existsSync(root.path) && root.removedAfterRun !== false
            : root.removedAfterRun === true,
      })),
    }),
  );
  const assertionResults = runPublicPhase1Stage('phase1.stage.assertion-recording.failed', () => {
    recordVerifiedIds(assertionRecorder, 'chat', evidenceChatAssertionIds);
    assertionRecorder.pass(
      'chat',
      platform === 'darwin-arm64'
        ? 'chat.native.macos-keychain.isolated'
        : platform === 'linux-x64'
          ? 'chat.native.linux-keyring.isolated'
          : 'chat.native.windows-credential-manager.isolated',
    );
    return assertionRecorder.results();
  });
  const report = runPublicPhase1Stage('phase1.stage.evidence-build.failed', () =>
    buildPlatformEvidence({
      registry: evidenceAuthorities.registry,
      platform,
      caveRecord,
      releases: {
        cave: lock.release.caveVersion,
        coven: lock.release.covenVersion,
      },
      commits: {
        cave: lock.cave.revision,
        coven: lock.coven.revision,
        sdk: lock.evidence.revision,
        chat: lock.chat.revision,
      },
      digests: {
        caveAssertionEngine: lock.release.caveArtifacts.assertionEngine.sha256,
        caveContractFixture: lock.release.caveArtifacts.contractFixture.sha256,
        hpkeVectors: lock.release.caveArtifacts.hpkeVectors.sha256,
        consumerLock: lock.release.consumerLock.sha256,
        assertionRegistry: lock.evidence.assertionRegistry.sha256,
        sdkTarballs: artifactDigests.sdkTarballs,
      },
      sdkAssertions: assertionResults.sdk,
      chatAssertions: assertionResults.chat,
      environment: {
        nodeVersion: toolVersions.nodeVersion,
        packageManagerVersion: toolVersions.packageManagerVersion,
      },
      metadata: {
        sdkCandidateRevision: lock.sdk.revision,
        sdkManifestSha256: lock.release.sdkManifest.sha256,
        chatHarnessRevision: lock.harness.revision,
        windowsSupervisorSha256: lock.tools.windowsSupervisor.artifact.sha256,
        mingwPackageVersion: lock.tools.windowsSupervisor.toolchain.packageVersion,
        mingwHomebrewCoreRevision: lock.tools.windowsSupervisor.toolchain.homebrewCoreRevision,
        mingwBottleLayerSha256: lock.tools.windowsSupervisor.toolchain.bottleLayerSha256,
        mingwLinkerVersion: lock.tools.windowsSupervisor.toolchain.linkerVersion,
        rustVersion: toolVersions.rustVersion,
      },
      isolation: {
        roots: isolationRoots,
        operatorState: [
          {
            id: 'cave-home',
            beforeSha256: operatorStateBefore['cave-home'],
            afterSha256: operatorStateAfter['cave-home'],
          },
          {
            id: 'coven-home',
            beforeSha256: operatorStateBefore['coven-home'],
            afterSha256: operatorStateAfter['coven-home'],
          },
          {
            id: 'native-credential-store',
            beforeSha256: nativeCredentialStoreState.beforeSha256,
            afterSha256: nativeCredentialStoreState.afterSha256,
          },
          {
            id: 'projects',
            beforeSha256: operatorStateBefore.projects,
            afterSha256: operatorStateAfter.projects,
          },
        ],
      },
    }),
  );
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  try {
    evidenceAuthorities.parsePlatformEvidence(serialized, 'Chat Phase 1 platform evidence');
  } catch (error) {
    throw new Error(evidenceValidationFailureDiagnostic(error), { cause: error });
  }

  return runPublicPhase1StageAsync('phase1.stage.evidence-retention.failed', () => {
    const reportRoot = createProcessOwnedArtifactRoot({ prefix: 'phase1-conformance-report' });
    return withOwnedArtifactRoot(reportRoot, async () => {
      const reportPath = resolve(reportRoot.rootPath, 'report.json');
      writeFileSync(reportPath, serialized, { mode: 0o600 });
      await reportRoot.retainSanitizedJsonReport({
        reportPath,
        destinationPath: options.retainSanitizedReport,
        secretScan: ({ artifactRoot }) => scanPhase1Artifacts({ artifactRoot }),
      });
      return report;
    });
  });
}

async function main(argv = process.argv.slice(2)) {
  runPublicPhase1Stage('phase1.stage.runtime-integrity.failed', () =>
    assertNoNodeRuntimeInjection(),
  );
  const options = runPublicPhase1Stage('phase1.stage.invocation.failed', () => parseArgs(argv));
  if (process.env[verifiedRunnerEnvironment] !== '1') {
    await runPublicPhase1StageAsync('phase1.stage.runner-bootstrap.failed', () =>
      bootstrapVerifiedRunner(options),
    );
    return;
  }
  const report = await runPhase1Conformance(options);
  process.stdout.write(
    `phase1-conformance: passed (${report.platform}, ${report.sdkAssertions.length} SDK assertions, ${report.chatAssertions.length} Chat assertions)\n`,
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const publicDiagnostic = publicPhase1FailureDiagnostic(error);
    const message =
      publicDiagnostic ??
      (error instanceof CommandExecutionError ? error.message : 'Phase 1 conformance failed.');
    process.stderr.write(`phase1-conformance: ${message}\n`);
    process.exitCode = 1;
  });
}
