export type Phase1PlatformEvidence = {
  schemaVersion: 1;
  issue: 'OpenCoven/sdk#38';
  platform: 'darwin-arm64' | 'linux-x64' | 'win32-x64';
  environment: {
    os: 'darwin' | 'linux' | 'win32';
    arch: 'arm64' | 'x64';
    nodeVersion: string;
    packageManagerVersion: 'pnpm@10.34.0';
  };
  sdkAssertions: Array<{
    id: string;
    result: 'pass' | 'fail';
    diagnosticId: string;
  }>;
  chatAssertions: Array<{
    id: string;
    result: 'pass' | 'fail';
    diagnosticId: string;
  }>;
  [key: string]: unknown;
};

export type Phase1PrimaryReport = {
  schemaVersion: 1;
  completed: true;
  status: 'passed' | 'failed' | 'blocked';
  platform: { os: 'darwin' | 'linux' | 'win32'; arch: 'arm64' | 'x64' };
  assertions: Array<{
    id: string;
    status: 'passed' | 'failed' | 'blocked';
    diagnosticIds: string[];
  }>;
  [key: string]: unknown;
};

export const REQUIRED_PHASE1_ASSERTION_IDS: readonly string[];
export const APPROVED_PHASE1_DIAGNOSTIC_IDS: readonly string[];
export function validatePhase1SanitizedReport(value: Phase1PrimaryReport): Phase1PrimaryReport;
export function validatePhase1SanitizedReport(
  value: Phase1PlatformEvidence,
): Phase1PlatformEvidence;
export function validatePhase1SanitizedReport(
  value: unknown,
): Phase1PlatformEvidence | Phase1PrimaryReport;
export function scanPhase1ArtifactText(
  contents: string,
  options?: {
    validateReport?(value: unknown, contents: string): unknown;
  },
): unknown;
export function scanPhase1Artifacts(options: { artifactRoot: string }): Promise<{
  filesScanned: number;
  bytesScanned: number;
  reportCount: number;
}>;
