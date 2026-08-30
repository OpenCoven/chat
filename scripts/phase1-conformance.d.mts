export type Phase1Assertion = {
  id: string;
  status: 'passed' | 'failed' | 'blocked';
  diagnosticIds: string[];
};

export const cargoBuildTimeoutMs: number;
export function scrubEvidenceAuthorizationEnvironment<T extends NodeJS.ProcessEnv>(
  environment?: T,
): T;
export function parseArgs(argv: string[]): {
  lockPath: string;
  scenario: 'all';
  retainSanitizedReport: string;
  platform?: 'darwin-arm64' | 'linux-x64' | 'win32-x64';
  outputPath?: string;
  validatorRevision?: string;
  chatSourceRoot: string;
  sdkSourceRoot?: string;
  sdkValidatorSourceRoot?: string;
  caveSourceRoot?: string;
  covenSourceRoot?: string;
};
export function assertExactAssertionResults(assertions: Phase1Assertion[]): Phase1Assertion[];
export function buildPhase1Report(options: {
  assertions: Phase1Assertion[];
  revisions: {
    chat: string;
    sdk: string;
    cave: string;
    coven: string;
  };
  artifactDigests: Record<string, string>;
  versions: Record<string, string>;
}): {
  schemaVersion: 1;
  completed: true;
  status: 'passed' | 'failed' | 'blocked';
  platform: { os: string; arch: string };
  versions: Record<string, string>;
  revisions: Record<string, string>;
  artifactDigests: Record<string, string>;
  assertions: Phase1Assertion[];
  summary: {
    required: number;
    passed: number;
    failed: number;
    blocked: number;
    skipped: 0;
  };
  diagnosticIds: string[];
};
export function buildObservedSchemaV2Assertions(options: Record<string, unknown>): {
  sdk: Array<{ id: string; result: 'pass'; diagnosticId: string }>;
  chat: Array<{ id: string; result: 'pass'; diagnosticId: string }>;
};
export function runSchemaV2ObservationSuites(
  artifactRoot: unknown,
  roots: Record<string, string>,
  environment: NodeJS.ProcessEnv,
  platform: 'darwin-arm64' | 'linux-x64' | 'win32-x64',
): Promise<{
  sdk: Set<string>;
  chat: Set<string>;
  chatRust: Set<string>;
  covenRust: Set<string>;
}>;

export function normalizeSchemaV2ObservationTests(value: {
  sdk: Set<string>;
  chat: Set<string>;
  chatRust: Set<string>;
  covenRust: Set<string>;
}): Readonly<{
  sdk: Set<string>;
  chat: Set<string>;
  chatRust: Set<string>;
  covenRust: Set<string>;
}>;
export function parseCaveConformanceOutput(output: string): Map<string, string>;
export function assertPairingStatus(
  value: { status?: string } | null | undefined,
  expectedStatus: string,
): { status?: string };
export function assertCompatibilityFailure(
  error: { code?: string } | null | undefined,
  preset: string,
): { code: 'incompatible_version' };
export function assertNativeMissingKeychainResponses(responses: unknown[]): unknown[];
export class CommandExecutionError extends Error {
  label: string;
  result: unknown;
  constructor(label: string, result: unknown, cause?: unknown);
}
export function classifyCavePackageFailure(result: {
  stdout?: string;
  stderr?: string;
}): string | undefined;
export function cloneExactCheckout(options: {
  artifactRoot: {
    rootPath: string;
    trackChild(child: unknown, options?: { processGroup?: boolean }): unknown;
    terminateChild(child: unknown): Promise<void>;
  };
  sourceRoot?: string;
  destinationRoot: string;
  repository: string;
  revision: string;
  environment: NodeJS.ProcessEnv;
  label: string;
}): Promise<void>;
export class NativeRpcClient {
  constructor(child: unknown, options?: { shutdownTimeoutMs?: number });
  commandCount(command: string): number;
  responsesContainNoSecrets(): boolean;
  close(): Promise<void>;
}
export function safeEnvironment(
  rootPath: string,
  extra?: Record<string, string>,
  resolvedCargoPath?: string,
): Record<string, string>;
export function withFixtureDaemon<T>(
  fixtureDaemon: { close(): Promise<void> },
  action: () => Promise<T>,
): Promise<T>;
export function withOwnedArtifactRoot<T>(
  ownedRoot: { cleanup(): Promise<void> },
  action: () => Promise<T>,
): Promise<T>;
export function recordCaveMatrixFailure(results: Map<string, unknown>, error: unknown): unknown;
export function wrapInfrastructureFailure(error: unknown, report: unknown): CommandExecutionError;
export function runPhase1Conformance(options?: ReturnType<typeof parseArgs>): Promise<unknown>;
