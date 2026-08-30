export const REQUIRED_PHASE1_ASSERTION_IDS: readonly string[];
export const APPROVED_PHASE1_DIAGNOSTIC_IDS: readonly string[];

export type Phase1AssertionResult = {
  id: string;
  status: 'passed' | 'failed' | 'blocked';
  diagnosticIds: string[];
};

export type Phase1SanitizedReport = {
  schemaVersion: 1;
  completed: true;
  status: 'passed' | 'failed' | 'blocked';
  platform: {
    os: 'darwin' | 'linux' | 'win32';
    arch: 'arm64' | 'x64';
  };
  versions: Record<string, string>;
  revisions: {
    chat: string;
    sdk: string;
    cave: string;
    coven: string;
  };
  artifactDigests: Record<string, string>;
  assertions: Phase1AssertionResult[];
  summary: {
    required: number;
    passed: number;
    failed: number;
    blocked: number;
    skipped: 0;
  };
  diagnosticIds: string[];
};

export function validatePhase1SanitizedReport(value: unknown): Phase1SanitizedReport;
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
