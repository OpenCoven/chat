export const PHASE1_SCHEMA_V2_HARNESS_VERSION: '2.0.0';

export const CANONICAL_PLATFORM_ENVIRONMENTS: Readonly<
  Record<
    'darwin-arm64' | 'linux-x64' | 'win32-x64',
    Readonly<{
      os: 'darwin' | 'linux' | 'win32';
      arch: 'arm64' | 'x64';
      nativeCustody: 'macos-keychain' | 'linux-keyring' | 'windows-credential-manager';
      covenIdentity: 'unix-peer-credentials' | 'windows-named-pipe-client-identity';
    }>
  >
>;

export function createObservedAssertionRecorder(
  expectedIds: string[],
  subject: string,
): {
  pass(id: string): void;
  complete(): Array<{
    id: string;
    result: 'pass';
    diagnosticId: 'phase1.assertion.passed';
  }>;
};

export function readConsistentEvidenceFile(
  root: string,
  relativePath: string,
  label: string,
): {
  bytes: Buffer;
  path: string;
  metadata: {
    path: string;
    size: number;
    sha256: string;
  };
};

export function createVerifiedValidatorModuleSnapshot(options: {
  validatorRoot: string;
  validatorIdentity: {
    repository: 'OpenCoven/sdk';
    commit: string;
    tree: string;
  };
}): Readonly<{
  identity: Readonly<{
    repository: 'OpenCoven/sdk';
    commit: string;
    tree: string;
  }>;
  graphSha256: string;
  metadata(path: string): Readonly<{
    path: string;
    size: number;
    sha256: string;
  }>;
  importModule(path: string): Promise<Record<string, unknown>>;
}>;

export function loadSdkEvidenceContract(options: {
  validatorRoot: string;
  validatorIdentity: {
    repository: 'OpenCoven/sdk';
    commit: string;
    tree?: string;
  };
}): Promise<{
  contract: {
    assertEvidenceProducerCompatibility(lock: unknown): unknown;
    parseFrozenConformanceLock(text: string, source?: string): Record<string, unknown>;
    validateFrozenConformanceBindings(
      lock: unknown,
      schemaText: string,
      registryText: string,
    ): {
      lock: Record<string, unknown>;
      schema: Record<string, unknown>;
      registry: Record<string, unknown>;
    };
    parsePlatformEvidence(text: string, source?: string, schema?: Record<string, unknown>): unknown;
    serializeCanonicalJson(value: unknown): string;
    scanConformanceEvidence(value: unknown): void;
  };
  frozenLock: Record<string, unknown>;
  frozenLockText: string;
  registry: Record<string, unknown>;
  registryText: string;
  schema: Record<string, unknown>;
  schemaText: string;
  validator: {
    repository: 'OpenCoven/sdk';
    commit: string;
    tree: string;
    contract: { path: string; size: number; sha256: string };
    schema: { path: string; size: number; sha256: string };
  };
  validatorIdentity: Record<string, unknown>;
  validatorRoot: string;
}>;

export function assertSdkContractMatchesPhase1Lock(
  sdkContract: Record<string, unknown>,
  phase1Lock: Record<string, unknown>,
): Record<string, unknown>;

export function collectFrozenEvidenceArtifacts(options: {
  roots: {
    chatRoot: string;
    sdkRoot: string;
    caveRoot: string;
  };
  sdkContract: Record<string, unknown>;
}): Record<string, unknown>;

export function verifySchemaV2ProducerCheckout(options: {
  producerRoot: string;
  producerIdentity: { revision: string; tree: string };
  sdkContract: Record<string, unknown>;
}): Promise<{
  identity: { repository: 'OpenCoven/chat'; commit: string; tree: string };
  harness: {
    name: 'scripts/phase1-conformance.mjs';
    version: string;
    repository: 'OpenCoven/chat';
    commit: string;
    tree: string;
  };
}>;

export function buildSchemaV2PlatformEvidence(input: Record<string, unknown>): {
  schemaVersion: 2;
  issue: 'OpenCoven/sdk#38';
  platform: 'darwin-arm64' | 'linux-x64' | 'win32-x64';
  caveRecord: {
    assertions: Array<{ id: string; result: string; detail: string }>;
    [key: string]: unknown;
  };
  sdkAssertions: Array<{
    id: string;
    result: 'pass';
    diagnosticId: string;
  }>;
  chatAssertions: Array<{
    id: string;
    result: 'pass';
    diagnosticId: string;
  }>;
  [key: string]: unknown;
};

export function serializeValidatedSchemaV2PlatformEvidence(
  evidence: Record<string, unknown>,
  options: {
    contract: {
      serializeCanonicalJson(value: unknown): string;
      parsePlatformEvidence(
        text: string,
        source?: string,
        schema?: Record<string, unknown>,
      ): unknown;
      scanConformanceEvidence(value: unknown): void;
    };
    schema: Record<string, unknown>;
  },
): string;
