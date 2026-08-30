import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vitest';

import {
  assertExactAssertionResults,
  buildPlatformEvidence,
  canonicalPlatformId,
  createAssertionRecorder,
  parseLockedAssertionRegistry,
  validateMetadataAssertionBindings,
  validateObservedToolVersions,
  windowsSupervisorDiagnosticId,
} from '../scripts/phase1-evidence-contract.mjs';

const registryValue = {
  schemaVersion: 1,
  cave: {
    engine: 'scripts/client-v1-conformance.mjs',
    requireIncludeTtl: true,
    requireAuthorityTakeover: true,
  },
  sdk: ['sdk.install.packed-tarballs', 'sdk.provenance.fixture-bytes-match', 'sdk.coven.health'],
  chat: {
    common: [
      'chat.install.exact-sdk-tarballs',
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
} as const;

function registryText() {
  return `${JSON.stringify(registryValue, null, 2)}\n`;
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex');
}

function passing(ids: readonly string[]) {
  return ids.map((id) => ({
    id,
    result: 'pass' as const,
    diagnosticId: 'phase1.assertion.passed',
  }));
}

const metadata = {
  sdkCandidateRevision: 'a'.repeat(40),
  sdkManifestSha256: 'b'.repeat(64),
  chatHarnessRevision: 'c'.repeat(40),
  windowsSupervisorSha256: 'd'.repeat(64),
  mingwPackageVersion: 'mingw-w64 14.0.0_3',
  mingwHomebrewCoreRevision: 'cd168d1fdc26f12e4ad64f358ff2dbec61ab7a57',
  mingwBottleLayerSha256: '0d68ab737a8bbc8c63ac6ac7acc0695e2887c1169df9a4423f1180090079b1d5',
  mingwLinkerVersion: '2.47.20260726',
  rustVersion: '1.95.0',
} as const;

function passingWithMetadata(ids: readonly string[]) {
  return passing(ids).map((assertion) => ({
    ...assertion,
    diagnosticId:
      assertion.id === 'sdk.install.packed-tarballs'
        ? `phase1.sdk-candidate.${metadata.sdkCandidateRevision}`
        : assertion.id === 'sdk.provenance.fixture-bytes-match'
          ? `phase1.sdk-manifest.${metadata.sdkManifestSha256}`
          : assertion.id === 'chat.install.consumer-lock-matches'
            ? `phase1.chat-harness.${metadata.chatHarnessRevision}`
            : assertion.id === 'chat.native.keychain-unavailable-fails-closed'
              ? `phase1.toolchain.rust.${metadata.rustVersion}`
              : assertion.id === 'chat.deadline.total-bounded'
                ? windowsSupervisorDiagnosticId(metadata)
                : assertion.diagnosticId,
  }));
}

function assertionAt(assertions: ReturnType<typeof passing>, index: number) {
  const assertion = assertions[index];
  if (assertion === undefined) {
    throw new Error(`missing assertion at index ${index}`);
  }
  return assertion;
}

function caveRecord() {
  return {
    harness: 'scripts/client-v1-conformance.mjs',
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
  };
}

function isolationObservation(removedAfterRun = true) {
  return {
    roots: [
      { id: 'cave-home', ownershipVerified: true, removedAfterRun },
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
  };
}

describe('SDK cross-repository evidence compatibility', () => {
  test('accepts only the three frozen platform identifiers', () => {
    expect(canonicalPlatformId('darwin', 'arm64')).toBe('darwin-arm64');
    expect(canonicalPlatformId('linux', 'x64')).toBe('linux-x64');
    expect(canonicalPlatformId('win32', 'x64')).toBe('win32-x64');
    expect(() => canonicalPlatformId('darwin', 'x64')).toThrow(/unsupported platform/);
  });

  test('requires the exact observed release toolchain versions', () => {
    expect(
      validateObservedToolVersions({
        nodeVersion: 'v24.18.1',
        pnpmVersion: '10.34.0',
        rustcVersion: 'rustc 1.95.0 (abc123 2026-08-01)',
      }),
    ).toEqual({
      nodeVersion: 'v24.18.1',
      packageManagerVersion: 'pnpm@10.34.0',
      rustVersion: '1.95.0',
    });
    expect(() =>
      validateObservedToolVersions({
        nodeVersion: 'v24.19.0',
        pnpmVersion: '10.34.0',
        rustcVersion: 'rustc 1.95.0 (abc123 2026-08-01)',
      }),
    ).toThrow(/Node 24.18.1/);
  });

  test('loads the exact locked SDK assertion registry bytes', () => {
    const text = registryText();
    const registry = parseLockedAssertionRegistry(text, sha256(text), 'SDK assertion registry');

    expect(registry).toEqual(registryValue);
    expect(() =>
      parseLockedAssertionRegistry(text, '0'.repeat(64), 'SDK assertion registry'),
    ).toThrow(/digest does not match/);
  });

  test('requires complete ordered assertions and rejects skipped results', () => {
    const expected = registryValue.sdk;
    expect(assertExactAssertionResults(passing(expected), expected, 'SDK')).toEqual(
      passing(expected),
    );
    expect(() => assertExactAssertionResults(passing(expected).slice(1), expected, 'SDK')).toThrow(
      /missing assertion/,
    );
    expect(() => {
      const assertions = passing(expected);
      return assertExactAssertionResults(
        [...assertions, assertionAt(assertions, 0)],
        expected,
        'SDK',
      );
    }).toThrow(/duplicate assertion/);
    expect(() =>
      assertExactAssertionResults(
        [
          { ...assertionAt(passing(expected), 0), result: 'skip' as never },
          assertionAt(passing(expected), 1),
        ],
        expected,
        'SDK',
      ),
    ).toThrow(/skipped assertion/);
    expect(() =>
      assertExactAssertionResults([...passing(expected)].reverse(), expected, 'SDK'),
    ).toThrow(/order/);
  });

  test('records only observed registry assertions and fails when evidence is incomplete', () => {
    const registry = parseLockedAssertionRegistry(
      registryText(),
      sha256(registryText()),
      'SDK assertion registry',
    );
    const incomplete = createAssertionRecorder(registry, 'darwin-arm64');
    incomplete.pass('sdk', 'sdk.install.packed-tarballs');
    expect(() => incomplete.results()).toThrow(/missing assertion/);

    const complete = createAssertionRecorder(registry, 'darwin-arm64');
    complete.passMany('sdk', registry.sdk);
    complete.passMany('chat', [
      ...registry.chat.common,
      ...registry.chat.platforms['darwin-arm64'],
    ]);
    expect(complete.results().sdk.map(({ id }) => id)).toEqual(registry.sdk);
    expect(() => complete.pass('sdk', 'sdk.install.packed-tarballs')).toThrow(
      /duplicate assertion/,
    );
  });

  test('enforces exact semantic metadata bindings and rejects mutations', () => {
    const sdkAssertions = passingWithMetadata(registryValue.sdk);
    const chatAssertions = passingWithMetadata(registryValue.chat.common);
    expect(
      validateMetadataAssertionBindings({
        sdkAssertions,
        chatAssertions,
        metadata,
      }),
    ).toBeUndefined();

    const mutation = (scope: 'sdk' | 'chat', id: string, diagnosticId: string) => ({
      sdkAssertions: sdkAssertions.map((entry) =>
        scope === 'sdk' && entry.id === id ? { ...entry, diagnosticId } : entry,
      ),
      chatAssertions: chatAssertions.map((entry) =>
        scope === 'chat' && entry.id === id ? { ...entry, diagnosticId } : entry,
      ),
      metadata,
    });
    expect(() =>
      validateMetadataAssertionBindings(
        mutation(
          'sdk',
          'sdk.install.packed-tarballs',
          `phase1.sdk-manifest.${metadata.sdkManifestSha256}`,
        ),
      ),
    ).toThrow(/metadata binding/);
    expect(() =>
      validateMetadataAssertionBindings({
        sdkAssertions,
        chatAssertions,
        metadata: { ...metadata, mingwLinkerVersion: '2.47' },
      }),
    ).toThrow(/metadata binding values/);
    expect(() =>
      validateMetadataAssertionBindings(
        mutation('sdk', 'sdk.install.packed-tarballs', 'phase1.sdk-candidate.wrong'),
      ),
    ).toThrow(/metadata binding/);
    expect(() =>
      validateMetadataAssertionBindings(
        mutation('sdk', 'sdk.install.packed-tarballs', 'phase1.assertion.passed'),
      ),
    ).toThrow(/metadata binding/);
    expect(() =>
      validateMetadataAssertionBindings(
        mutation(
          'chat',
          'chat.deadline.total-bounded',
          `phase1.windows-supervisor.${'e'.repeat(64)}`,
        ),
      ),
    ).toThrow(/metadata binding/);
    expect(() =>
      validateMetadataAssertionBindings(
        mutation(
          'sdk',
          'sdk.coven.health',
          `phase1.sdk-candidate.${metadata.sdkCandidateRevision}`,
        ),
      ),
    ).toThrow(/unrelated assertion/);
    const duplicated = mutation(
      'chat',
      'chat.coven.health',
      `phase1.chat-harness.${metadata.chatHarnessRevision}`,
    );
    expect(() => validateMetadataAssertionBindings(duplicated)).toThrow(/unrelated assertion/);
  });

  test('builds the exact SDK platform envelope with structured coverage and scope IDs', () => {
    const registry = parseLockedAssertionRegistry(
      registryText(),
      sha256(registryText()),
      'SDK assertion registry',
    );
    const chatIds = [...registry.chat.common, ...registry.chat.platforms['darwin-arm64']];
    const record = buildPlatformEvidence({
      registry,
      platform: 'darwin-arm64',
      caveRecord: caveRecord(),
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
      sdkAssertions: passingWithMetadata(registry.sdk),
      chatAssertions: passingWithMetadata(chatIds),
      metadata,
      environment: {
        nodeVersion: 'v24.18.1',
        packageManagerVersion: 'pnpm@10.34.0',
      },
      isolation: isolationObservation(),
    });

    expect(record.platform).toBe('darwin-arm64');
    expect(record.commits.sdk).toBe('4'.repeat(40));
    expect(record.coverage).toEqual({ cave: true, coven: true, sdk: true, chat: true });
    expect(record.notCovered.map(({ scopeId }) => scopeId)).toEqual([
      'cross-process-pairing',
      'oauth-ui',
      'remote-peer',
      'write-apis',
    ]);
    expect(record.chatAssertions.map(({ id }) => id)).toEqual(chatIds);
    expect(record.isolation.roots.map(({ id }) => id)).toEqual([
      'cave-home',
      'coven-home',
      'consumer-home',
      'native-credential-store',
    ]);
    expect(
      record.isolation.operatorState.every((state) => state.beforeSha256 === state.afterSha256),
    ).toBe(true);
  });

  test('rejects unverified or incomplete cleanup observations', () => {
    const registry = parseLockedAssertionRegistry(
      registryText(),
      sha256(registryText()),
      'SDK assertion registry',
    );
    const chatIds = [...registry.chat.common, ...registry.chat.platforms['darwin-arm64']];

    expect(() =>
      buildPlatformEvidence({
        registry,
        platform: 'darwin-arm64',
        caveRecord: caveRecord(),
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
        sdkAssertions: passingWithMetadata(registry.sdk),
        chatAssertions: passingWithMetadata(chatIds),
        metadata,
        environment: {
          nodeVersion: 'v24.18.1',
          packageManagerVersion: 'pnpm@10.34.0',
        },
        isolation: isolationObservation(false),
      }),
    ).toThrow(/isolation root/);
  });
});
