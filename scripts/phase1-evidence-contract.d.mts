export type CrossAssertion = {
  id: string;
  result: 'pass' | 'fail';
  diagnosticId: string;
};

export type AssertionRegistry = {
  schemaVersion: 1;
  cave: {
    engine: 'scripts/client-v1-conformance.mjs';
    requireIncludeTtl: true;
    requireAuthorityTakeover: true;
  };
  sdk: string[];
  chat: {
    common: string[];
    platforms: Record<'darwin-arm64' | 'linux-x64' | 'win32-x64', string[]>;
  };
};

export function canonicalPlatformId(os?: string, arch?: string): string;
export function validateObservedToolVersions(options: {
  nodeVersion: string;
  pnpmVersion: string;
  rustcVersion: string;
}): {
  nodeVersion: 'v24.18.1';
  packageManagerVersion: 'pnpm@10.34.0';
  rustVersion: '1.95.0';
};
export function parseLockedAssertionRegistry(
  text: string,
  expectedDigest: string,
  label: string,
): AssertionRegistry;
export function assertExactAssertionResults(
  assertions: CrossAssertion[],
  expectedIds: readonly string[],
  label: string,
): CrossAssertion[];
export function createAssertionRecorder(
  registry: AssertionRegistry,
  platform: 'darwin-arm64' | 'linux-x64' | 'win32-x64',
): {
  pass(scope: 'sdk' | 'chat', id: string, diagnosticId?: string): void;
  passMany(scope: 'sdk' | 'chat', ids: readonly string[], diagnosticId?: string): void;
  results(): { sdk: CrossAssertion[]; chat: CrossAssertion[] };
};
export function validateMetadataAssertionBindings(options: {
  sdkAssertions: CrossAssertion[];
  chatAssertions: CrossAssertion[];
  metadata: {
    sdkCandidateRevision: string;
    sdkManifestSha256: string;
    chatHarnessRevision: string;
    windowsSupervisorSha256: string;
    mingwPackageVersion: string;
    mingwHomebrewCoreRevision: string;
    mingwBottleLayerSha256: string;
    mingwLinkerVersion: string;
    rustVersion: '1.95.0';
  };
}): void;
export function buildPlatformEvidence(options: {
  registry: AssertionRegistry;
  platform: 'darwin-arm64' | 'linux-x64' | 'win32-x64';
  caveRecord: Record<string, unknown> & { ranAt: string };
  releases: { cave: string; coven: string };
  commits: { cave: string; coven: string; sdk: string; chat: string };
  digests: {
    caveAssertionEngine: string;
    caveContractFixture: string;
    hpkeVectors: string;
    consumerLock: string;
    assertionRegistry: string;
    sdkTarballs: Array<{ packageName: string; sha256: string }>;
  };
  sdkAssertions: CrossAssertion[];
  chatAssertions: CrossAssertion[];
  environment: {
    nodeVersion: 'v24.18.1';
    packageManagerVersion: 'pnpm@10.34.0';
  };
  metadata: {
    sdkCandidateRevision: string;
    sdkManifestSha256: string;
    chatHarnessRevision: string;
    windowsSupervisorSha256: string;
    mingwPackageVersion: string;
    mingwHomebrewCoreRevision: string;
    mingwBottleLayerSha256: string;
    mingwLinkerVersion: string;
    rustVersion: '1.95.0';
  };
  isolation: {
    roots: Array<{
      id: string;
      ownershipVerified: boolean;
      removedAfterRun: boolean;
    }>;
    operatorState: Array<{
      id: string;
      beforeSha256: string;
      afterSha256: string;
    }>;
  };
}): Record<string, unknown> & {
  platform: string;
  commits: { sdk: string };
  coverage: Record<string, boolean>;
  environment: {
    nodeVersion: 'v24.18.1';
    packageManagerVersion: 'pnpm@10.34.0';
  };
  notCovered: Array<{ scopeId: string; diagnosticId: string }>;
  chatAssertions: CrossAssertion[];
  isolation: {
    roots: Array<{ id: string }>;
    operatorState: Array<{ beforeSha256: string; afterSha256: string }>;
  };
};
export function windowsSupervisorDiagnosticId(metadata: {
  windowsSupervisorSha256: string;
  mingwPackageVersion: string;
  mingwHomebrewCoreRevision: string;
  mingwBottleLayerSha256: string;
  mingwLinkerVersion: string;
}): string;
