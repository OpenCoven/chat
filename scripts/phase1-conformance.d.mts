export const cargoBuildTimeoutMs: number;
export function parseArgs(argv: string[]): {
  lockPath: string;
  scenario: 'all';
  retainSanitizedReport: string;
  chatSourceRoot: string;
  sdkSourceRoot: string;
  sdkEvidenceSourceRoot: string;
  caveSourceRoot: string;
  covenSourceRoot: string;
  windowsSupervisorPath?: string;
};
export function observeReleaseToolVersions(): {
  nodeVersion: 'v24.18.1';
  packageManagerVersion: 'pnpm@10.34.0';
  rustVersion: '1.95.0';
};
export function parseCaveConformanceOutput(output: string): Map<string, string>;
export function parsePassedRustTests(output: string): Set<string>;
export function resolveLockedCovenDaemonCommand(
  artifactRoot: { rootPath: string },
  lockedCovenCheckoutRoot: string,
  expectedCovenRevision: string,
  covenBinaryPath: string,
): Readonly<{
  executable: string;
  args: readonly ['daemon', 'serve'];
  cwd: string;
}>;
export function establishNativeCleanupReservation(
  rpc: {
    request(command: string, args?: unknown): Promise<unknown>;
    ok(command: string, args?: unknown): Promise<unknown>;
  },
  handle: string,
  onStage?: (
    stage:
      | 'reservation-request'
      | 'reservation-keychain'
      | 'reservation-store-unavailable'
      | 'reservation-invalid-handle'
      | 'reservation-discovery-required'
      | 'reservation-health-required'
      | 'reservation-rejected'
      | 'reservation-response'
      | 'reservation-cleanup',
  ) => void,
): Promise<Readonly<{ reservationHandle: string; capability: string; ownerToken: string }>>;
export function createCleanupAdoptionRecovery(reservation: {
  reservationHandle: string;
  capability: string;
  ownerToken: string;
}): {
  predecessor: { reservationHandle: string; capability: string; ownerToken: string };
  successor: { reservationHandle: string; capability: string; ownerToken: string };
  deleted: boolean;
};
export function adoptNativeCleanupReservation(
  rpc: {
    request(command: string, args?: unknown): Promise<unknown>;
    ok(command: string, args?: unknown): Promise<unknown>;
  },
  recovery: {
    predecessor: { reservationHandle: string; capability: string; ownerToken: string };
    successor: { reservationHandle: string; capability: string; ownerToken: string };
    deleted: boolean;
  },
  openRecoveryRpc?: () => Promise<{
    request(command: string, args?: unknown): Promise<unknown>;
    ok(command: string, args?: unknown): Promise<unknown>;
    close(): Promise<void>;
  }>,
): Promise<Readonly<{ reservationHandle: string; capability: string; ownerToken: string }>>;
export function runReservedNativePairing(options: {
  rpc: {
    request(command: string, args?: unknown): Promise<unknown>;
    ok(command: string, args?: unknown): Promise<unknown>;
    operation(): unknown;
  };
  handle: string;
  origin: string;
  adminToken: string;
  installationId: string;
  approvePairing?: (...args: unknown[]) => Promise<unknown>;
  onReservation?: (reservation: {
    reservationHandle: string;
    capability: string;
    ownerToken: string;
  }) => void;
  onCredentialMayExist?: () => void;
  onStage?: (
    stage:
      | 'reservation-request'
      | 'reservation-keychain'
      | 'reservation-store-unavailable'
      | 'reservation-invalid-handle'
      | 'reservation-discovery-required'
      | 'reservation-health-required'
      | 'reservation-rejected'
      | 'reservation-response'
      | 'reservation-cleanup'
      | 'credential-status'
      | 'create'
      | 'pending'
      | 'approve'
      | 'approved'
      | 'exchange',
  ) => void;
}): Promise<unknown>;
export function runNativeScenarioOrchestrator<T>(options: {
  runPairing(): Promise<T>;
  runLifecycle(pairing: T): Promise<unknown>;
}): Promise<unknown>;
export function throwNativeScenarioFailures(options: {
  scenarioFailure?: unknown;
  cleanupFailure?: unknown;
  rpcCleanupFailure?: unknown;
  daemonCloseFailure?: unknown;
}): void;
export function bootstrapWindowsSupervisor(options: {
  lockPath?: string;
  windowsSupervisorPath?: string;
}): unknown;
export function assertNoNodeRuntimeInjection(
  environment?: NodeJS.ProcessEnv,
  execArgv?: string[],
): void;
export function assertExecutingHarnessAuthority(
  lock: unknown,
  executingRoot?: string,
  environment?: NodeJS.ProcessEnv,
): void;
export function assertProductionAdapterAtRevision(harnessRoot: string, lock: unknown): void;
export function finalizeOperatorSafety(options: {
  primaryFailure?: unknown;
  cleanupFailure?: unknown;
  operatorStateBefore?: unknown;
  snapshotAfter?: () => unknown;
  compare?: (before: unknown, after: unknown) => void;
}): unknown;
export function runSupervisedCommandForTest(
  artifactRoot: {
    rootPath: string;
    trackChild(child: import('node:child_process').ChildProcess): void;
  },
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
    outputLimitBytes?: number;
  },
): Promise<unknown>;
export function parseSupervisorStatusFrame(bytes: Buffer | string): {
  code: number | null;
  signal: string | null;
  reason: string;
};
export function runOwnedProcessStatusForTest(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<unknown>;
export function validateSupervisorArtifactFile(
  path: string,
  metadata: { size: number; sha256: string },
): string;
export function assertPairingStatus(
  value: { status?: string } | null | undefined,
  expectedStatus: string,
): { status?: string };
export class CommandExecutionError extends Error {
  label: string;
  result: unknown;
  constructor(label: string, result: unknown);
}
export function publicPhase1FailureDiagnostic(error: unknown): string | undefined;
export function extractVerifiedRunnerDiagnostic(stderr: unknown): string | undefined;
export function classifyPackagingCommandFailure(baseId: string, error: unknown): string;
export function diagnoseCovenLifecycleFailure(
  original: unknown,
  rerun: (testName: string) => Promise<unknown>,
): Promise<never>;
export class NativeRpcClient {
  constructor(child: unknown, options?: { shutdownTimeoutMs?: number; supervised?: boolean });
  request(command: string, args?: unknown): Promise<unknown>;
  close(): Promise<void>;
}
export function safeEnvironment(
  rootPath: string,
  extra?: Record<string, string>,
): Record<string, string>;
export function caveBuildEnvironment(environment: Record<string, string>): Record<string, string>;
export function snapshotOperatorState(operatorHome?: string): {
  'cave-home': string;
  'coven-home': string;
  projects: string;
};
export function resolveRustupHome(environment?: NodeJS.ProcessEnv): string;
export function nativeAdapterTestEnvironment(
  environment: Record<string, string>,
  platform?: NodeJS.Platform,
  operatorEnvironment?: NodeJS.ProcessEnv,
): Record<string, string>;
export function nativeMissingKeychainFailureDiagnostic(options: {
  supervised: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  supervisorStatusValid: boolean;
  terminationReason: string | undefined;
  killFailed: boolean;
  processFailed: boolean;
  canaryExposed: boolean;
  homeChanged: boolean;
  responseValid: boolean;
}): string | undefined;
export function nativeMissingKeychainResponsesValid(responses: unknown): boolean;
export function runtimeScenarioFailureDiagnostic(
  results: ReadonlyMap<string, { status?: unknown; diagnosticIds?: unknown }>,
): string | undefined;
export function covenIdentityFailureDiagnostic(stage: unknown): string;
export function evidenceValidationFailureDiagnostic(error: unknown): string;
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
