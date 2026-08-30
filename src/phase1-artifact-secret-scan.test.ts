import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  scanPhase1Artifacts,
  scanPhase1ArtifactText,
} from '../scripts/phase1-artifact-secret-scan.mjs';
import {
  buildPlatformEvidence,
  windowsSupervisorDiagnosticId,
} from '../scripts/phase1-evidence-contract.mjs';
import {
  createProcessOwnedArtifactRoot,
  type ProcessOwnedArtifactRoot,
} from '../scripts/process-owned-artifact-root.mjs';

const activeRoots = new Set<ProcessOwnedArtifactRoot>();

afterEach(async () => {
  for (const root of activeRoots) {
    await root.cleanup().catch(() => undefined);
  }
  activeRoots.clear();
});

function createRoot() {
  const root = createProcessOwnedArtifactRoot({ prefix: 'phase1-secret-scan' });
  activeRoots.add(root);
  return root;
}

function validReport() {
  const registry = {
    schemaVersion: 1 as const,
    cave: {
      engine: 'scripts/client-v1-conformance.mjs' as const,
      requireIncludeTtl: true as const,
      requireAuthorityTakeover: true as const,
    },
    sdk: ['sdk.install.packed-tarballs', 'sdk.provenance.fixture-bytes-match', 'sdk.coven.health'],
    chat: {
      common: [
        'chat.install.consumer-lock-matches',
        'chat.native.keychain-unavailable-fails-closed',
        'chat.deadline.total-bounded',
        'chat.coven.health',
      ],
      platforms: {
        'darwin-arm64': ['chat.coven.unix.connected-peer-identity'],
        'linux-x64': ['chat.coven.unix.connected-peer-identity'],
        'win32-x64': ['chat.coven.windows.connected-pipe-identity'],
      },
    },
  };
  const passing = (ids: string[]) =>
    ids.map((id) => ({
      id,
      result: 'pass' as const,
      diagnosticId:
        id === 'sdk.install.packed-tarballs'
          ? `phase1.sdk-candidate.${'a'.repeat(40)}`
          : id === 'sdk.provenance.fixture-bytes-match'
            ? `phase1.sdk-manifest.${'b'.repeat(64)}`
            : id === 'chat.install.consumer-lock-matches'
              ? `phase1.chat-harness.${'c'.repeat(40)}`
              : id === 'chat.native.keychain-unavailable-fails-closed'
                ? 'phase1.toolchain.rust.1.95.0'
                : id === 'chat.deadline.total-bounded'
                  ? windowsSupervisorDiagnosticId({
                      windowsSupervisorSha256: 'd'.repeat(64),
                      mingwPackageVersion: 'mingw-w64 14.0.0_3',
                      mingwHomebrewCoreRevision: 'cd168d1fdc26f12e4ad64f358ff2dbec61ab7a57',
                      mingwBottleLayerSha256:
                        '0d68ab737a8bbc8c63ac6ac7acc0695e2887c1169df9a4423f1180090079b1d5',
                      mingwLinkerVersion: '2.47.20260726',
                    })
                  : 'phase1.assertion.passed',
    }));
  return buildPlatformEvidence({
    registry,
    platform: 'darwin-arm64',
    caveRecord: {
      ranAt: '2026-08-29T04:00:00.000Z',
      caveVersion: '0.3.11',
      commit: '2'.repeat(40),
      platform: 'darwin-arm64',
      nodeVersion: 'v24.18.1',
      includeTtl: true,
      authorityTakeover: {
        authorityMode: 'enforce',
        discoveryVersion: 2,
        mechanism: 'hpke-bound-v1',
      },
      assertions: [],
    },
    releases: { cave: '0.3.11', coven: '0.1.0' },
    commits: {
      cave: '2'.repeat(40),
      coven: '3'.repeat(40),
      sdk: '4'.repeat(40),
      chat: '5'.repeat(40),
    },
    digests: {
      caveAssertionEngine: 'a'.repeat(64),
      caveContractFixture: 'b'.repeat(64),
      hpkeVectors: 'c'.repeat(64),
      consumerLock: 'd'.repeat(64),
      assertionRegistry: 'e'.repeat(64),
      sdkTarballs: [
        { packageName: '@opencoven/sdk-core', sha256: '1'.repeat(64) },
        { packageName: '@opencoven/cave-client', sha256: '2'.repeat(64) },
        { packageName: '@opencoven/coven-client', sha256: '3'.repeat(64) },
        { packageName: '@opencoven/sdk', sha256: '4'.repeat(64) },
      ],
    },
    sdkAssertions: passing(registry.sdk),
    chatAssertions: passing([...registry.chat.common, ...registry.chat.platforms['darwin-arm64']]),
    environment: {
      nodeVersion: 'v24.18.1',
      packageManagerVersion: 'pnpm@10.34.0',
    },
    metadata: {
      sdkCandidateRevision: 'a'.repeat(40),
      sdkManifestSha256: 'b'.repeat(64),
      chatHarnessRevision: 'c'.repeat(40),
      windowsSupervisorSha256: 'd'.repeat(64),
      mingwPackageVersion: 'mingw-w64 14.0.0_3',
      mingwHomebrewCoreRevision: 'cd168d1fdc26f12e4ad64f358ff2dbec61ab7a57',
      mingwBottleLayerSha256: '0d68ab737a8bbc8c63ac6ac7acc0695e2887c1169df9a4423f1180090079b1d5',
      mingwLinkerVersion: '2.47.20260726',
      rustVersion: '1.95.0',
    },
    isolation: {
      roots: [
        { id: 'cave-home', ownershipVerified: true, removedAfterRun: true },
        { id: 'coven-home', ownershipVerified: true, removedAfterRun: true },
        { id: 'consumer-home', ownershipVerified: true, removedAfterRun: true },
        { id: 'native-credential-store', ownershipVerified: true, removedAfterRun: true },
      ],
      operatorState: [
        { id: 'cave-home', beforeSha256: '6'.repeat(64), afterSha256: '6'.repeat(64) },
        { id: 'coven-home', beforeSha256: '7'.repeat(64), afterSha256: '7'.repeat(64) },
        {
          id: 'native-credential-store',
          beforeSha256: '8'.repeat(64),
          afterSha256: '8'.repeat(64),
        },
        { id: 'projects', beforeSha256: '9'.repeat(64), afterSha256: '9'.repeat(64) },
      ],
    },
  });
}

function assertionAt(report: ReturnType<typeof validReport>, index: number) {
  const assertion = report.chatAssertions[index];
  if (assertion === undefined) {
    throw new Error(`missing test assertion at index ${index}`);
  }
  return assertion;
}

async function scanReport(report: unknown) {
  const root = createRoot();
  writeFileSync(resolve(root.rootPath, 'report.json'), `${JSON.stringify(report)}\n`);
  return scanPhase1Artifacts({ artifactRoot: root.rootPath });
}

describe('Phase 1 retained-artifact secret scan', () => {
  test('applies the primary redaction scan to a caller-validated schema-v2 record', () => {
    const record = {
      schemaVersion: 2,
      issue: 'OpenCoven/sdk#38',
      platform: 'darwin-arm64',
    };
    expect(
      scanPhase1ArtifactText(`${JSON.stringify(record)}\n`, {
        validateReport(value) {
          expect(value).toEqual(record);
        },
      }),
    ).toEqual(record);
    expect(() =>
      scanPhase1ArtifactText(`${JSON.stringify({ ...record, prompt: 'private user content' })}\n`, {
        validateReport() {
          throw new Error('the redaction scan must run first');
        },
      }),
    ).toThrow(/prohibited secret or private content/u);
  });

  test('accepts the exact secret-free SDK platform record schema', async () => {
    const result = await scanReport(validReport());

    expect(result).toEqual({
      filesScanned: 1,
      bytesScanned: expect.any(Number),
      reportCount: 1,
    });
  });

  test('rejects evidence produced by a different Node 24 release', async () => {
    const valid = validReport();
    const report = {
      ...valid,
      environment: {
        ...valid.environment,
        nodeVersion: 'v24.19.0',
      },
    };

    await expect(scanReport(report)).rejects.toThrow(/environment is invalid/);
  });

  test.each([
    ['pairing secret', { pairingSecret: 'pairing-secret-value' }],
    ['bearer', { bearer: 'Bearer eyJhbGciOiJIUzI1NiJ9.secret-value' }],
    ['authorization header', { Authorization: 'Bearer secret-value' }],
    ['raw keychain value', { rawKeychainValue: 'keychain-secret-value' }],
    ['protected request plaintext', { protectedRequestPlaintext: '{"secret":true}' }],
    ['protected response plaintext', { protectedResponsePlaintext: '{"message":"private"}' }],
    ['user prompt', { prompt: 'private user prompt' }],
    ['message body', { messageBody: 'private conversation content' }],
    ['generic content field', { content: 'private conversation content' }],
    ['command output', { commandOutput: 'private subprocess output' }],
    ['attachment', { attachment: 'private-document.pdf' }],
    ['private macOS path', { diagnostic: '/Users/private-user/Library/Keychains/login.keychain' }],
    ['private Linux path', { diagnostic: '/home/private-user/.config/opencoven' }],
    ['socket handle', { socketPath: '/private/var/folders/secret/cave.sock' }],
  ])('rejects %s content', async (_label, leak) => {
    await expect(scanReport({ ...validReport(), leak })).rejects.toThrow(
      /prohibited secret or private content/,
    );
  });

  test('rejects unknown fields even when their values do not look secret', async () => {
    await expect(scanReport({ ...validReport(), note: 'ordinary-looking text' })).rejects.toThrow(
      /approved report schema/,
    );
  });

  test('rejects noncanonical assertion and diagnostic identifiers', async () => {
    const unknownAssertion = validReport();
    unknownAssertion.chatAssertions[0] = {
      ...assertionAt(unknownAssertion, 0),
      id: 'UPPERCASE',
    };
    await expect(scanReport(unknownAssertion)).rejects.toThrow(/canonical assertion ID/);

    const unknownDiagnostic = validReport();
    unknownDiagnostic.chatAssertions[0] = {
      ...assertionAt(unknownDiagnostic, 0),
      diagnosticId: 'contains spaces',
    };
    await expect(scanReport(unknownDiagnostic)).rejects.toThrow(/canonical diagnostic ID/);
  });

  test('rejects duplicate assertion identifiers', async () => {
    const duplicate = validReport();
    duplicate.chatAssertions[1] = {
      ...assertionAt(duplicate, 1),
      id: assertionAt(duplicate, 0).id,
    };
    await expect(scanReport(duplicate)).rejects.toThrow(/duplicate assertion ID/);
  });

  test('rejects skipped assertions and unsupported platform IDs', async () => {
    const skipped = validReport();
    skipped.chatAssertions[0] = {
      ...assertionAt(skipped, 0),
      result: 'skip' as never,
    };
    await expect(scanReport(skipped)).rejects.toThrow(/must not skip/);

    const unsupported = validReport();
    unsupported.platform = 'darwin-x64';
    await expect(scanReport(unsupported)).rejects.toThrow(/supported platform/);
  });

  test('rejects non-JSON artifacts and artifact symlinks without following them', async () => {
    const nonJsonRoot = createRoot();
    writeFileSync(resolve(nonJsonRoot.rootPath, 'debug.log'), 'secret-free but unapproved\n');
    await expect(scanPhase1Artifacts({ artifactRoot: nonJsonRoot.rootPath })).rejects.toThrow(
      /only JSON artifacts/,
    );

    const symlinkRoot = createRoot();
    const outsideDirectory = resolve(symlinkRoot.rootPath, 'outside');
    mkdirSync(outsideDirectory);
    writeFileSync(resolve(outsideDirectory, 'report.json'), `${JSON.stringify(validReport())}\n`);
    symlinkSync(outsideDirectory, resolve(symlinkRoot.rootPath, 'report-link'));
    await expect(scanPhase1Artifacts({ artifactRoot: symlinkRoot.rootPath })).rejects.toThrow(
      /must not contain symlinks/,
    );
  });

  test('rejects oversized artifacts before parsing them', async () => {
    const root = createRoot();
    writeFileSync(resolve(root.rootPath, 'report.json'), 'x'.repeat(1_048_577));
    await expect(scanPhase1Artifacts({ artifactRoot: root.rootPath })).rejects.toThrow(
      /size limits/,
    );
  });
});
