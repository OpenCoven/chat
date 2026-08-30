import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, test } from 'vitest';

import {
  REQUIRED_PHASE1_ASSERTION_IDS,
  validatePhase1SanitizedReport,
} from '../scripts/phase1-artifact-secret-scan.mjs';
import { buildObservedSchemaV2Assertions } from '../scripts/phase1-conformance.mjs';
import {
  buildSchemaV2PlatformEvidence,
  createObservedAssertionRecorder,
  loadSdkEvidenceContract,
  serializeValidatedSchemaV2PlatformEvidence,
} from '../scripts/phase1-schema-v2-evidence.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const validatorRoot =
  process.env.OPENCOVEN_SDK_VALIDATOR_ROOT ??
  resolve(projectRoot, '..', 'build-conformance-contract');
const validatorAvailable = existsSync(
  resolve(validatorRoot, 'scripts', 'conformance-contract.mjs'),
);
const validatorCommit = validatorAvailable
  ? execFileSync('git', ['-C', validatorRoot, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
  : '';
const validatorTree = validatorAvailable
  ? execFileSync('git', ['-C', validatorRoot, 'rev-parse', 'HEAD^{tree}'], {
      encoding: 'utf8',
    }).trim()
  : '';

type JsonRecord = Record<string, unknown>;

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function metadata(path: string, bytes: string | Buffer) {
  const value = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
  return {
    path,
    size: value.byteLength,
    sha256: sha256(value),
  };
}

function passingPrimaryReport() {
  return validatePhase1SanitizedReport({
    schemaVersion: 1,
    completed: true,
    status: 'passed',
    platform: { os: 'darwin', arch: 'arm64' },
    versions: {
      harness: '2.0.0',
      node: '24.18.1',
      rust: '1.95.0',
      tauri: '2.11.4',
    },
    revisions: {
      chat: 'f'.repeat(40),
      sdk: 'a'.repeat(40),
      cave: 'b'.repeat(40),
      coven: 'c'.repeat(40),
    },
    artifactDigests: {
      'sdk-core': '1'.repeat(64),
      'sdk-cave': '2'.repeat(64),
      'sdk-coven': '3'.repeat(64),
      'sdk-root': '4'.repeat(64),
    },
    assertions: REQUIRED_PHASE1_ASSERTION_IDS.map((id) => ({
      id,
      status: 'passed',
      diagnosticIds: ['phase1.assertion.passed'],
    })),
    summary: {
      required: REQUIRED_PHASE1_ASSERTION_IDS.length,
      passed: REQUIRED_PHASE1_ASSERTION_IDS.length,
      failed: 0,
      blocked: 0,
      skipped: 0,
    },
    diagnosticIds: ['phase1.conformance.passed'],
  });
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reverseObjectKeys);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, nested]) => [key, reverseObjectKeys(nested)]),
  );
}

function validatorModuleFixture() {
  const scratchParent = resolve(projectRoot, '.artifacts');
  mkdirSync(scratchParent, { recursive: true });
  const root = mkdtempSync(resolve(scratchParent, 'schema-v2-validator-modules-'));
  const producerRoot = resolve(root, 'producer');
  const contractPath = resolve(root, 'scripts', 'conformance-contract.mjs');
  const githubContractPath = resolve(root, 'scripts', 'github-conformance-evidence.mjs');
  const contractBytes = Buffer.from(`
export const marker = 'committed-contract';
export function parseFrozenConformanceLock(text) {
  return JSON.parse(text);
}
export function validateFrozenConformanceBindings(lock, schemaText, registryText) {
  return {
    lock,
    schema: JSON.parse(schemaText),
    registry: JSON.parse(registryText),
  };
}
export function assertEvidenceProducerCompatibility(lock) {
  return lock.evidenceProducer;
}
`);
  const githubContractBytes = Buffer.from(`
import { marker } from './github-conformance-helper.mjs';
export function verifyProtectedWorkflow() {
  if (marker !== 'committed-helper') {
    throw new Error('mutable GitHub contract dependency executed');
  }
}
`);
  const packageBytes = Buffer.from('{"name":"validator-module-fixture"}\n');
  const harnessBytes = Buffer.from('export {};\n');
  const workflowBytes = Buffer.from('name: validator module fixture\n');
  const producer = {
    status: 'compatible',
    repository: 'OpenCoven/chat',
    commit: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    packageManifest: metadata('package.json', packageBytes),
    harness: {
      ...metadata('scripts/phase1-conformance.mjs', harnessBytes),
      version: '2.0.0',
    },
    workflow: metadata('.github/workflows/client-v1-conformance.yml', workflowBytes),
  };
  const files = new Map<string, string | Buffer>([
    ['scripts/conformance-contract.mjs', contractBytes],
    ['scripts/github-conformance-evidence.mjs', githubContractBytes],
    ['scripts/github-conformance-helper.mjs', "export const marker = 'committed-helper';\n"],
    [
      'conformance/client-v1-cross-repository-lock.json',
      `${JSON.stringify({ evidenceProducer: producer, toolchain: {} })}\n`,
    ],
    ['conformance/client-v1-cross-repository-evidence.schema.json', '{}\n'],
    ['conformance/client-v1-cross-repository-assertions.json', '{}\n'],
    ['producer/package.json', packageBytes],
    ['producer/scripts/phase1-conformance.mjs', harnessBytes],
    ['producer/.github/workflows/client-v1-conformance.yml', workflowBytes],
  ]);
  for (const [relativePath, bytes] of files) {
    const path = resolve(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
  }
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync(
    'git',
    [
      '-c',
      'user.name=OpenCoven Tests',
      '-c',
      'user.email=tests@opencoven.invalid',
      'commit',
      '--quiet',
      '-m',
      'validator module fixture',
    ],
    { cwd: root },
  );

  return {
    root,
    producerRoot,
    producer,
    contractPath,
    githubContractPath,
    contractBytes,
    commit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
  };
}

async function fixture() {
  const contract = await import(
    pathToFileURL(resolve(validatorRoot, 'scripts', 'conformance-contract.mjs')).href
  );
  const schemaText = readFileSync(
    resolve(validatorRoot, 'conformance', 'client-v1-cross-repository-evidence.schema.json'),
    'utf8',
  );
  const registryText = readFileSync(
    resolve(validatorRoot, 'conformance', 'client-v1-cross-repository-assertions.json'),
    'utf8',
  );
  const frozenLock = JSON.parse(
    readFileSync(
      resolve(validatorRoot, 'conformance', 'client-v1-cross-repository-lock.json'),
      'utf8',
    ),
  ) as JsonRecord;
  const registry = contract.parseAssertionRegistry(
    registryText,
    'test assertion registry',
  ) as JsonRecord;
  const chat = {
    repository: 'OpenCoven/chat',
    commit: 'f'.repeat(40),
    tree: 'e'.repeat(40),
  };
  const producer = {
    status: 'compatible',
    repository: 'OpenCoven/chat',
    commit: chat.commit,
    tree: chat.tree,
    packageManifest: {
      path: 'package.json',
      size: 3_500,
      sha256: '9'.repeat(64),
    },
    harness: {
      path: 'scripts/phase1-conformance.mjs',
      version: '2.0.0',
      size: 120_000,
      sha256: '8'.repeat(64),
    },
    command: 'test:phase1-conformance',
    recordSchemaVersion: 2,
    workflow: {
      name: 'client-v1 conformance',
      path: '.github/workflows/client-v1-conformance.yml',
      size: 4_000,
      sha256: '7'.repeat(64),
      job: 'platform-conformance',
      jobNameTemplate: 'platform-conformance ({platform})',
      aggregationJob: 'aggregate-conformance',
      aggregationJobName: 'aggregate-conformance',
      aggregationRunnerLabels: ['ubuntu-24.04'],
      environment: 'client-v1-conformance',
      environmentId: '1',
      artifactNameTemplate: 'client-v1-conformance-{platform}',
      recordPathTemplate: '.artifacts/client-v1-conformance-{platform}.json',
      sourceRef: 'refs/heads/main',
      runnerLabels: {
        'darwin-arm64': ['macos-14'],
        'linux-x64': ['ubuntu-24.04'],
        'win32-x64': ['windows-2025'],
      },
      signerWorkflow: 'OpenCoven/chat/.github/workflows/client-v1-conformance.yml',
      signerDigest: chat.commit,
      sourceDigest: chat.commit,
      predicateType: 'https://slsa.dev/provenance/v1',
      denySelfHostedRunners: true,
    },
  };
  const compatibleLock = {
    ...frozenLock,
    sources: {
      ...(frozenLock.sources as JsonRecord),
      chat: {
        ...((frozenLock.sources as JsonRecord).chat as JsonRecord),
        ...chat,
      },
    },
    evidenceProducer: producer,
  };
  const lockText = contract.serializeCanonicalJson(compatibleLock);
  const parsedLock = contract.parseFrozenConformanceLock(
    lockText,
    'test compatible lock',
  ) as JsonRecord;
  const candidate = parsedLock.candidate as JsonRecord;
  const sources = parsedLock.sources as {
    cave: JsonRecord;
    coven: JsonRecord;
    chat: JsonRecord;
  };
  const assertions = registry.assertions as {
    cave: string[];
    sdk: string[];
    chat: {
      common: string[];
      platforms: Record<string, string[]>;
    };
  };
  const startedAt = '2026-08-29T04:00:00.000Z';
  const completedAt = '2026-08-29T04:00:01.000Z';
  const caveRecord = {
    harness: 'scripts/client-v1-conformance.mjs',
    issues: ['OpenCoven/coven-cave#4832', 'OpenCoven/coven-cave#4838'],
    scope: 'cave-only',
    ranAt: startedAt,
    caveVersion: sources.cave.releaseVersion,
    commit: sources.cave.commit,
    platform: 'darwin-arm64',
    nodeVersion: 'v24.18.1',
    includeTtl: true,
    authorityTakeover: {
      authorityMode: 'enforce',
      discoveryVersion: 2,
      mechanism: 'hpke-bound-v1',
    },
    notCovered: [
      'The SDK and Chat halves of #4838. Both live in other repositories; this run is the Cave half only.',
      'The production Coven daemon. /familiars is served from a loopback fixture daemon in hub mode.',
      'A genuinely remote peer. Off-machine ingress is exercised by making the listener classify a loopback request as forwarded.',
      'The write scopes. Nothing enforces them yet — there are no write routes on this surface.',
      'OAuth-backed flows and the desktop consent UI. Approval is driven through the admin HTTP route.',
      'Cross-process pairing state. The pairing store is in-memory and process-local by contract.',
    ],
    findings: [
      {
        id: 'backslash-refusal-is-unreachable',
        where: 'docs/api/client-v1.md — Reaching the API at all',
        says: 'a malformed/noncanonical escaped target, backslash target, or escaped non-conversation target is answered 400 {"ok":false,"error":"invalid client v1 path"}',
        measured:
          'the "%" half holds; a "\\" is normalised to "/" by Next and answered 308 to the normalised target before proxy.ts runs, and that target is then refused 401 by the ordinary gate',
        severity: 'documentation',
        why: 'no handler is reached and nothing is served, so the gate still holds; the doc describes an answer no client will observe',
      },
      {
        id: 'admin-unauthorized-envelope-is-unreachable',
        where: 'docs/api/client-v1.md — Administrator routes, Authentication',
        says: 'a mismatched or absent x-coven-cave-token is 401 unauthorized from requireClientV1Admin',
        measured:
          'the proxy\'s sidecar-token gate answers first, so the wire carries 401 {"ok":false,"error":"unauthorized"} and requireClientV1Admin\'s envelope is never produced on a Cave with a token configured',
        severity: 'documentation',
        why: 'the refusal is correct and same-status; only its body differs from the documented one, which a handler-level test cannot see',
      },
    ],
    summary: {
      total: assertions.cave.length,
      passed: assertions.cave.length,
      failed: 0,
      skipped: 0,
      status: 'passed',
    },
    assertions: assertions.cave.map((id) => ({
      id,
      result: 'pass',
      detail: id === 'harness.assertion-coverage' ? 'complete' : '',
    })),
  };
  const primaryReport = passingPrimaryReport();
  primaryReport.revisions = {
    chat: String(sources.chat.commit),
    sdk: String(candidate.commit),
    cave: String(sources.cave.commit),
    coven: String(sources.coven.commit),
  };
  primaryReport.artifactDigests = {
    'sdk-core': String((candidate.sdkPackages as Array<JsonRecord>)[0]?.sha256),
    'sdk-cave': String((candidate.sdkPackages as Array<JsonRecord>)[1]?.sha256),
    'sdk-coven': String((candidate.sdkPackages as Array<JsonRecord>)[2]?.sha256),
    'sdk-root': String((candidate.sdkPackages as Array<JsonRecord>)[3]?.sha256),
  };

  const evidenceSchema = parsedLock.evidenceSchema as JsonRecord;
  const contractBytes = readFileSync(resolve(validatorRoot, 'scripts', 'conformance-contract.mjs'));
  const validator = {
    repository: 'OpenCoven/sdk',
    commit: 'd'.repeat(40),
    tree: 'c'.repeat(40),
    contract: metadata('scripts/conformance-contract.mjs', contractBytes),
    schema: {
      path: evidenceSchema.path,
      size: evidenceSchema.size,
      sha256: evidenceSchema.sha256,
    },
  };
  const artifacts = {
    frozenLock: metadata('conformance/client-v1-cross-repository-lock.json', lockText),
    assertionRegistry: metadata(
      'conformance/client-v1-cross-repository-assertions.json',
      registryText,
    ),
    releaseManifest: candidate.releaseManifest,
    sdkPackages: candidate.sdkPackages,
    candidateCaveFiles: candidate.cavePackageFiles,
    caveAuthorityFiles: sources.cave.files,
    consumerLock: sources.chat.consumerLock,
    chatVendorFiles: sources.chat.vendorFiles,
  };
  const input = {
    primaryReport,
    caveRecord,
    platform: 'darwin-arm64',
    timing: { startedAt, completedAt },
    sdkContract: {
      frozenLock: parsedLock,
      frozenLockText: lockText,
      registry,
      registryText,
      schema: JSON.parse(schemaText),
      contract,
      validatorIdentity: {
        repository: validator.repository,
        commit: validator.commit,
        tree: validator.tree,
      },
    },
    observedAssertions: {
      sdk: assertions.sdk.map((id) => ({
        id,
        result: 'pass',
        diagnosticId: 'phase1.assertion.passed',
      })),
      chat: [...assertions.chat.common, ...(assertions.chat.platforms['darwin-arm64'] ?? [])].map(
        (id) => ({
          id,
          result: 'pass',
          diagnosticId: 'phase1.assertion.passed',
        }),
      ),
    },
    verified: {
      validator,
      candidate: {
        repository: candidate.repository,
        commit: candidate.commit,
        tree: candidate.tree,
      },
      cave: {
        repository: sources.cave.repository,
        commit: sources.cave.commit,
        tree: sources.cave.tree,
      },
      coven: {
        repository: sources.coven.repository,
        commit: sources.coven.commit,
        tree: sources.coven.tree,
      },
      chat: {
        repository: sources.chat.repository,
        commit: sources.chat.commit,
        tree: sources.chat.tree,
      },
      harness: {
        name: 'scripts/phase1-conformance.mjs',
        version: '2.0.0',
        repository: 'OpenCoven/chat',
        commit: producer.commit,
        tree: producer.tree,
        invocationId: '123e4567-e89b-42d3-a456-426614174000',
      },
      artifacts,
      environment: {
        os: 'darwin',
        arch: 'arm64',
        nodeVersion: 'v24.18.1',
        pnpmVersion: 'pnpm@10.34.0',
        rustVersion: '1.95.0',
        tauriVersion: '2.11.4',
        nativeCustody: {
          backend: 'macos-keychain',
          available: true,
        },
        covenIdentity: {
          backend: 'unix-peer-credentials',
          available: true,
        },
      },
      isolation: {
        strategy: 'process-owned-temporary-roots',
        network: 'loopback-only',
        sourceCheckoutDependency: false,
        workspaceLinkDependency: false,
        retainedPrivatePaths: false,
        retainedSocketHandles: false,
        roots: ['cave-home', 'coven-home', 'consumer-home', 'native-credential-store'].map(
          (id, index) => ({
            id,
            opaqueId: `${index + 1}`.repeat(32),
            ownershipVerified: true,
            removedAfterRun: true,
          }),
        ),
        operatorState: ['cave-home', 'coven-home', 'native-credential-store', 'projects'].map(
          (id, index) => ({
            id,
            beforeSha256: `${index + 5}`.repeat(64),
            afterSha256: `${index + 5}`.repeat(64),
          }),
        ),
      },
    },
  };

  return { contract, input, registry };
}

describe.skipIf(!validatorAvailable)('Phase 1 SDK schema-v2 evidence adapter', () => {
  test('records each observed assertion exactly once without filling omissions', () => {
    const recorder = createObservedAssertionRecorder(['sdk.one', 'sdk.two'], 'SDK');
    recorder.pass('sdk.two');
    recorder.pass('sdk.one');

    expect(recorder.complete()).toEqual([
      {
        id: 'sdk.one',
        result: 'pass',
        diagnosticId: 'phase1.assertion.passed',
      },
      {
        id: 'sdk.two',
        result: 'pass',
        diagnosticId: 'phase1.assertion.passed',
      },
    ]);
    expect(() => recorder.pass('sdk.one')).toThrow(/duplicate/u);
    expect(() => createObservedAssertionRecorder(['sdk.one'], 'SDK').pass('sdk.unknown')).toThrow(
      /unexpected/u,
    );
    expect(() => createObservedAssertionRecorder(['sdk.one'], 'SDK').complete()).toThrow(
      /missing/u,
    );
  });

  test('derives the complete registry only from named checks observed during the run', async () => {
    const { input, registry } = await fixture();
    const sdkTests = new Set([
      'canonicalizes routes and validates strict discovery v2',
      'rejects stale or malformed discovery records',
      'invalidates an instance-replaced credential before bearer attachment',
      'accepts Cave health responses when the minimum client version is compatible',
      'creates, polls, exchanges, validates, and forgets a paired credential',
      "surfaces pairing exchange errors: 'pairing_pending'",
      "surfaces pairing exchange errors: 'pairing_denied'",
      "surfaces pairing exchange errors: 'pairing_expired'",
      'allows only one transport exchange across concurrent exchange attempts',
      'allows retry after a pre-send authority mismatch without replaying the secret',
      'preserves the managed contract error code and retry semantics for rate_limited',
      'never parses a proxy rejection as a Client v1 health envelope',
      'uses exact canonical routes, deterministic queries, encoded ids',
      'validates page options and conversation ids before transport I/O',
      'parses the optional top-level cursor with core canonical validation',
      'propagates reconcile_required from messages without retrying and forwards the id',
      'preserves revoked bearer rejection without fallback or retry',
      'prefers non-empty COVEN_HOME without invoking the CLI',
      'sends only the reviewed health request and parses a valid response',
      'preserves structured daemon error fields without flattening them',
      'reports connect timeout and honors cancellation',
      'rejects a Unix response received at its 1ms absolute deadline',
      "rejects 'oversized body declaration'",
      'rejects invalid HTTP health framing',
      'rejects missing Entry constructors as secure_store_unavailable',
      'fails closed before discovery when transport security is missing at runtime',
    ]);
    const chatTests = new Set([
      'never places secret canaries in managed command arguments or results',
      'surfaces reconcile_required separately from generic errors',
      'only revokes after a confirmed packed managed credential status',
      'propagates a managed SDK deadline to native cancellation and caps native duration',
    ]);
    const chatRust = new Set([
      'transport::tests::pairing_exchange_empty_post_declares_zero_content_length',
      'coven::tests::maps_client_failures_to_bounded_diagnostics_without_leaking_details',
    ]);
    const covenRust = new Set([
      'transport::unix::tests::platform_peer_credentials_report_the_connected_process_uid',
      'transport::unix::tests::connected_peer_uid_must_match_discovered_and_current_owner',
      'discovers_only_an_owner_local_unix_socket',
      'a_mutation_is_not_sent_to_a_replacement_before_that_peer_is_negotiated',
    ]);
    const native = {
      backend: 'macos-keychain',
      compatibilityBeforePairing: true,
      releaseDiscovery: true,
      compatibleHealth: true,
      pairingCreate: true,
      pairingPending: true,
      pairingExchange: true,
      pairingDenied: true,
      pairingSecretNative: true,
      bearerNative: true,
      bearerNeverCrossedBoundary: true,
      nativeStoreRoundtrip: true,
      restartCredentialReused: true,
      noAutomaticRepairing: true,
      staleStateRefused: true,
      reads: {
        familiars: true,
        projects: true,
        conversations: true,
        conversation: true,
        messages: true,
      },
      reconcileRequired: true,
      reconcileDidNotPair: true,
      revocationTransition: true,
      revokedReads: {
        familiars: true,
        projects: true,
        conversations: true,
        conversation: true,
        messages: true,
      },
      allRevokedReadsRefused: true,
      keychainUnavailable: true,
    };
    const options = {
      registry,
      platform: 'darwin-arm64',
      packageObservations: {
        sdk: input.observedAssertions.sdk.slice(0, 6).map(({ id }) => id),
        chat: input.observedAssertions.chat.slice(0, 4).map(({ id }) => id),
      },
      primaryReport: input.primaryReport,
      caveRecord: input.caveRecord,
      native,
      coven: {
        ownerLocal: true,
        health: true,
        connectedIdentity: true,
        executableTrusted: true,
        executableTrustFailure: true,
        trustProviderUnavailable: true,
      },
      tests: { sdk: sdkTests, chat: chatTests, chatRust, covenRust },
      scansPassed: true,
    };

    const observed = buildObservedSchemaV2Assertions(options);
    expect(observed.sdk.map(({ id }) => id)).toEqual(
      (registry.assertions as { sdk: string[] }).sdk,
    );
    expect(observed.chat).toHaveLength(input.observedAssertions.chat.length);

    sdkTests.delete('reports connect timeout and honors cancellation');
    expect(() => buildObservedSchemaV2Assertions(options)).toThrow(/missing/u);
  });

  test('loads the exact validator-owned lock, registry, schema, and executable contract', async () => {
    const loaded = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '--eval',
          `
            const {
              loadSdkEvidenceContract,
            } = await import(process.argv[1]);
            const loaded = await loadSdkEvidenceContract({
              validatorRoot: process.argv[2],
              validatorIdentity: {
                repository: 'OpenCoven/sdk',
                commit: process.argv[3],
                tree: process.argv[4],
              },
            });
            process.stdout.write(JSON.stringify({
              validator: loaded.validator,
              frozenLockSchemaVersion: loaded.frozenLock.schemaVersion,
              registrySchemaVersion: loaded.registry.schemaVersion,
              schemaId: loaded.schema.$id,
              producer: loaded.contract.assertEvidenceProducerCompatibility(
                loaded.frozenLock,
              ),
            }));
          `,
          pathToFileURL(resolve(projectRoot, 'scripts', 'phase1-schema-v2-evidence.mjs')).href,
          validatorRoot,
          validatorCommit,
          validatorTree,
        ],
        { encoding: 'utf8' },
      ),
    ) as {
      validator: JsonRecord;
      frozenLockSchemaVersion: number;
      registrySchemaVersion: number;
      schemaId: string;
      producer: JsonRecord;
    };

    expect(loaded.validator.commit).toBe(validatorCommit);
    expect(loaded.frozenLockSchemaVersion).toBe(2);
    expect(loaded.registrySchemaVersion).toBe(2);
    expect(loaded.schemaId).toBe(
      'urn:opencoven:schema:client-v1-cross-repository-platform-evidence:2',
    );
    expect((loaded.validator.contract as JsonRecord).path).toBe('scripts/conformance-contract.mjs');
    expect(loaded.producer).toMatchObject({
      status: 'compatible',
      repository: 'OpenCoven/chat',
      workflow: {
        environmentId: '20863036831',
      },
    });
  });

  test('executes the committed contract bytes after its checkout path mutates', async () => {
    const validator = validatorModuleFixture();
    try {
      const result = JSON.parse(
        execFileSync(
          process.execPath,
          [
            '--input-type=module',
            '--eval',
            `
              import { writeFileSync } from 'node:fs';
              const {
                createVerifiedValidatorModuleSnapshot,
              } = await import(process.argv[1]);
              const snapshot = createVerifiedValidatorModuleSnapshot({
                validatorRoot: process.argv[2],
                validatorIdentity: {
                  repository: 'OpenCoven/sdk',
                  commit: process.argv[3],
                  tree: process.argv[4],
                },
              });
              writeFileSync(
                process.argv[5],
                "export const marker = 'mutated-contract';\\n",
              );
              const contract = await snapshot.importModule(
                'scripts/conformance-contract.mjs',
              );
              process.stdout.write(JSON.stringify({
                marker: contract.marker,
                metadata: snapshot.metadata(
                  'scripts/conformance-contract.mjs',
                ),
              }));
            `,
            pathToFileURL(resolve(projectRoot, 'scripts', 'phase1-schema-v2-evidence.mjs')).href,
            validator.root,
            validator.commit,
            validator.tree,
            validator.contractPath,
          ],
          { encoding: 'utf8' },
        ),
      ) as JsonRecord;

      expect(result.marker).toBe('committed-contract');
      expect(result.metadata).toEqual(
        metadata('scripts/conformance-contract.mjs', validator.contractBytes),
      );
    } finally {
      rmSync(validator.root, { recursive: true, force: true });
    }
  });

  test('executes the snapshotted GitHub contract after its checkout path mutates', async () => {
    const validator = validatorModuleFixture();
    try {
      const result = JSON.parse(
        execFileSync(
          process.execPath,
          [
            '--input-type=module',
            '--eval',
            `
              import { writeFileSync } from 'node:fs';
              const {
                loadSdkEvidenceContract,
                verifySchemaV2ProducerCheckout,
              } = await import(process.argv[1]);
              const sdkContract = await loadSdkEvidenceContract({
                validatorRoot: process.argv[2],
                validatorIdentity: {
                  repository: 'OpenCoven/sdk',
                  commit: process.argv[3],
                  tree: process.argv[4],
                },
              });
              writeFileSync(
                process.argv[5],
                [
                  'export function verifyProtectedWorkflow() {',
                  "  throw new Error('mutable GitHub contract executed');",
                  '}',
                  '',
                ].join('\\n'),
              );
              const result = await verifySchemaV2ProducerCheckout({
                producerRoot: process.argv[6],
                producerIdentity: JSON.parse(process.argv[7]),
                sdkContract,
              });
              process.stdout.write(JSON.stringify(result));
            `,
            pathToFileURL(resolve(projectRoot, 'scripts', 'phase1-schema-v2-evidence.mjs')).href,
            validator.root,
            validator.commit,
            validator.tree,
            validator.githubContractPath,
            validator.producerRoot,
            JSON.stringify({
              revision: validator.producer.commit,
              tree: validator.producer.tree,
            }),
          ],
          { encoding: 'utf8' },
        ),
      ) as JsonRecord;

      expect(result).toMatchObject({
        identity: {
          repository: 'OpenCoven/chat',
          commit: validator.producer.commit,
          tree: validator.producer.tree,
        },
      });
    } finally {
      rmSync(validator.root, { recursive: true, force: true });
    }
  });

  test('rejects a file that mutates during its evidence snapshot', async () => {
    const module = await import('../scripts/phase1-schema-v2-evidence.mjs');
    const readSnapshot = Reflect.get(module, 'readConsistentEvidenceFile');
    expect(readSnapshot).toBeTypeOf('function');
    if (typeof readSnapshot !== 'function') {
      return;
    }

    const scratchParent = resolve(projectRoot, '.artifacts');
    mkdirSync(scratchParent, { recursive: true });
    const scratchRoot = mkdtempSync(resolve(scratchParent, 'schema-v2-snapshot-'));
    const mutatingPath = resolve(scratchRoot, 'mutating.bin');
    writeFileSync(mutatingPath, Buffer.alloc(16 * 1024 * 1024, 0x61));

    const worker = spawn(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
          import { closeSync, ftruncateSync, openSync } from 'node:fs';
          const descriptor = openSync(process.argv[1], 'r+');
          process.stdout.write('ready\\n');
          let large = false;
          try {
            while (true) {
              ftruncateSync(descriptor, large ? 16 * 1024 * 1024 : 4 * 1024 * 1024);
              large = !large;
            }
          } finally {
            closeSync(descriptor);
          }
        `,
        mutatingPath,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    try {
      const ready = Promise.race([
        once(worker.stdout, 'data').then(([chunk]) => String(chunk)),
        once(worker, 'exit').then(([code, signal]) => {
          throw new Error(`Snapshot mutation worker exited early: ${code ?? signal}.`);
        }),
      ]);
      await expect(ready).resolves.toContain('ready');

      let rejectedRace = false;
      for (let attempt = 0; attempt < 50 && !rejectedRace; attempt += 1) {
        try {
          readSnapshot(scratchRoot, 'mutating.bin', 'Mutating evidence file');
        } catch (error) {
          rejectedRace =
            error instanceof Error && /changed while it was being read/u.test(error.message);
        }
      }
      expect(rejectedRace).toBe(true);
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill('SIGKILL');
        await once(worker, 'exit');
      }
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  test('rejects a validator checkout at the wrong commit or tree', async () => {
    await expect(
      loadSdkEvidenceContract({
        validatorRoot,
        validatorIdentity: {
          repository: 'OpenCoven/sdk',
          commit: '0'.repeat(40),
          tree: validatorTree,
        },
      }),
    ).rejects.toThrow(/validator commit/u);
    await expect(
      loadSdkEvidenceContract({
        validatorRoot,
        validatorIdentity: {
          repository: 'OpenCoven/sdk',
          commit: validatorCommit,
          tree: '0'.repeat(40),
        },
      }),
    ).rejects.toThrow(/validator tree/u);
  });

  test('adapts a complete passing schema-v1 result into SDK-accepted canonical bytes', async () => {
    const { contract, input, registry } = await fixture();
    const evidence = buildSchemaV2PlatformEvidence(input);
    const bytes = serializeValidatedSchemaV2PlatformEvidence(evidence, {
      contract,
      schema: input.sdkContract.schema,
    });

    expect(
      contract.parsePlatformEvidence(bytes, 'chat platform evidence', input.sdkContract.schema),
    ).toEqual(evidence);
    expect(evidence.sdkAssertions.map(({ id }: { id: string }) => id)).toEqual(
      (registry.assertions as { sdk: string[] }).sdk,
    );
    expect(evidence.chatAssertions.map(({ id }: { id: string }) => id)).toEqual([
      ...(registry.assertions as { chat: { common: string[] } }).chat.common,
      ...((registry.assertions as { chat: { platforms: Record<string, string[]> } }).chat.platforms[
        'darwin-arm64'
      ] ?? []),
    ]);
    expect(
      [...evidence.sdkAssertions, ...evidence.chatAssertions].every(
        ({ result }: { result: string }) => result === 'pass',
      ),
    ).toBe(true);
    expect(bytes.endsWith('\n')).toBe(true);
  });

  test.each(['missing', 'duplicate', 'unexpected', 'skip', 'fail'])(
    'rejects %s primary assertion outcomes',
    async (kind) => {
      const { input } = await fixture();
      const assertions = input.primaryReport.assertions.map((entry) => ({
        ...entry,
        diagnosticIds: [...entry.diagnosticIds],
      }));
      const first = assertions[0];
      if (first === undefined) {
        throw new Error('primary assertion fixture is empty');
      }
      if (kind === 'missing') {
        assertions.pop();
      } else if (kind === 'duplicate') {
        assertions.push({ ...first, diagnosticIds: [...first.diagnosticIds] });
      } else if (kind === 'unexpected') {
        assertions[0] = {
          id: 'phase1.unexpected',
          status: 'passed',
          diagnosticIds: ['phase1.assertion.passed'],
        };
      } else if (kind === 'skip') {
        assertions[0] = { ...first, status: 'skipped' as never };
      } else {
        assertions[0] = {
          ...first,
          status: 'failed',
          diagnosticIds: ['phase1.assertion.failed'],
        };
      }

      expect(() =>
        buildSchemaV2PlatformEvidence({
          ...input,
          primaryReport: {
            ...input.primaryReport,
            assertions,
            status: kind === 'fail' ? 'failed' : input.primaryReport.status,
          },
        }),
      ).toThrow();
    },
  );

  test.each(['missing', 'duplicate', 'unexpected', 'skip', 'fail'])(
    'rejects %s observed SDK assertion results',
    async (kind) => {
      const { input } = await fixture();
      const sdk = input.observedAssertions.sdk.map((entry) => ({ ...entry }));
      const first = sdk[0];
      if (first === undefined) {
        throw new Error('SDK observation fixture is empty');
      }
      if (kind === 'missing') {
        sdk.pop();
      } else if (kind === 'duplicate') {
        sdk.push({ ...first });
      } else if (kind === 'unexpected') {
        sdk[0] = { ...first, id: 'sdk.unexpected' };
      } else if (kind === 'skip') {
        sdk[0] = { ...first, result: 'skip' };
      } else {
        sdk[0] = { ...first, result: 'fail' };
      }

      expect(() =>
        buildSchemaV2PlatformEvidence({
          ...input,
          observedAssertions: {
            ...input.observedAssertions,
            sdk,
          },
        }),
      ).toThrow(/observed SDK assertion/iu);
    },
  );

  test.each(['missing', 'duplicate', 'unexpected', 'skip', 'fail'])(
    'rejects %s observed Chat assertion results',
    async (kind) => {
      const { input } = await fixture();
      const chat = input.observedAssertions.chat.map((entry) => ({ ...entry }));
      const first = chat[0];
      if (first === undefined) {
        throw new Error('Chat observation fixture is empty');
      }
      if (kind === 'missing') {
        chat.pop();
      } else if (kind === 'duplicate') {
        chat.push({ ...first });
      } else if (kind === 'unexpected') {
        chat[0] = { ...first, id: 'chat.unexpected' };
      } else if (kind === 'skip') {
        chat[0] = { ...first, result: 'skip' };
      } else {
        chat[0] = { ...first, result: 'fail' };
      }

      expect(() =>
        buildSchemaV2PlatformEvidence({
          ...input,
          observedAssertions: {
            ...input.observedAssertions,
            chat,
          },
        }),
      ).toThrow(/observed Chat assertion/iu);
    },
  );

  test.each([
    ['candidate commit', ['candidate', 'commit']],
    ['candidate tree', ['candidate', 'tree']],
    ['validator commit', ['validator', 'commit']],
    ['validator tree', ['validator', 'tree']],
    ['Cave commit', ['cave', 'commit']],
    ['Coven tree', ['coven', 'tree']],
    ['Chat commit', ['chat', 'commit']],
    ['harness tree', ['harness', 'tree']],
  ])('rejects wrong %s provenance', async (_label, path) => {
    const { input } = await fixture();
    const verified = structuredClone(input.verified) as JsonRecord;
    const [section, field] = path;
    if (typeof section !== 'string' || typeof field !== 'string') {
      throw new Error('invalid provenance mutation fixture');
    }
    (verified[section] as JsonRecord)[field] = '0'.repeat(40);

    expect(() =>
      buildSchemaV2PlatformEvidence({
        ...input,
        verified,
      } as never),
    ).toThrow();
  });

  test.each([
    ['release manifest', ['releaseManifest']],
    ['SDK tarball', ['sdkPackages', 0]],
    ['candidate fixture', ['candidateCaveFiles', 0]],
    ['Cave vector', ['caveAuthorityFiles', 4]],
    ['consumer lock', ['consumerLock']],
    ['Chat vendor tarball', ['chatVendorFiles', 3]],
  ])('rejects %s drift', async (_label, path) => {
    const { input } = await fixture();
    const artifacts = structuredClone(input.verified.artifacts) as JsonRecord;
    const [section, index] = path;
    if (typeof section !== 'string') {
      throw new Error('invalid artifact mutation fixture');
    }
    const target =
      path.length === 1
        ? (artifacts[section] as JsonRecord)
        : ((artifacts[section] as JsonRecord[])[Number(index)] as JsonRecord);
    target.sha256 = '0'.repeat(64);

    expect(() =>
      buildSchemaV2PlatformEvidence({
        ...input,
        verified: {
          ...input.verified,
          artifacts,
        },
      } as never),
    ).toThrow();
  });

  test('rejects platform, backend, availability, and isolation mismatches', async () => {
    const { input } = await fixture();
    expect(() =>
      buildSchemaV2PlatformEvidence({
        ...input,
        verified: {
          ...input.verified,
          environment: {
            ...input.verified.environment,
            arch: 'x64',
          },
        },
      } as never),
    ).toThrow(/platform|environment/u);
    expect(() =>
      buildSchemaV2PlatformEvidence({
        ...input,
        verified: {
          ...input.verified,
          environment: {
            ...input.verified.environment,
            nativeCustody: {
              backend: 'linux-keyring',
              available: true,
            },
          },
        },
      } as never),
    ).toThrow(/backend|environment/u);
    expect(() =>
      buildSchemaV2PlatformEvidence({
        ...input,
        verified: {
          ...input.verified,
          environment: {
            ...input.verified.environment,
            covenIdentity: {
              ...input.verified.environment.covenIdentity,
              available: false,
            },
          },
        },
      } as never),
    ).toThrow(/available|environment/u);
    const isolation = structuredClone(input.verified.isolation);
    const firstState = isolation.operatorState[0];
    if (firstState === undefined) {
      throw new Error('operator state fixture is empty');
    }
    firstState.afterSha256 = '0'.repeat(64);
    expect(() =>
      buildSchemaV2PlatformEvidence({
        ...input,
        verified: {
          ...input.verified,
          isolation,
        },
      }),
    ).toThrow(/operator state|isolation/u);
  });

  test('rejects retained private values through the SDK scanner', async () => {
    const { contract, input } = await fixture();
    const evidence = buildSchemaV2PlatformEvidence(input);
    const firstAssertion = evidence.caveRecord.assertions[0];
    if (firstAssertion === undefined) {
      throw new Error('Cave assertion fixture is empty');
    }
    firstAssertion.detail = '/Users/operator/private.json';

    expect(() =>
      serializeValidatedSchemaV2PlatformEvidence(evidence, {
        contract,
        schema: input.sdkContract.schema,
      }),
    ).toThrow(/private path|private/u);
  });

  test('is canonical and reproducible across input and object key ordering', async () => {
    const { contract, input } = await fixture();
    const first = serializeValidatedSchemaV2PlatformEvidence(buildSchemaV2PlatformEvidence(input), {
      contract,
      schema: input.sdkContract.schema,
    });
    const reordered = reverseObjectKeys(input) as typeof input;
    reordered.observedAssertions.sdk.reverse();
    reordered.observedAssertions.chat.reverse();
    const second = serializeValidatedSchemaV2PlatformEvidence(
      buildSchemaV2PlatformEvidence(reordered),
      {
        contract,
        schema: input.sdkContract.schema,
      },
    );

    expect(second).toBe(first);
  });
});
