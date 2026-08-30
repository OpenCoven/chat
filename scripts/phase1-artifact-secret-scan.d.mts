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

export function validatePhase1SanitizedReport(value: unknown): Phase1PlatformEvidence;
export function scanPhase1Artifacts(options: { artifactRoot: string }): Promise<{
  filesScanned: number;
  bytesScanned: number;
  reportCount: number;
}>;
