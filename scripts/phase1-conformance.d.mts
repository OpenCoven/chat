export type Phase1Assertion = {
  id: string;
  status: 'passed' | 'failed' | 'blocked';
  diagnosticIds: string[];
};

export function parseArgs(argv: string[]): {
  lockPath: string;
  scenario: 'all';
  retainSanitizedReport: string;
  chatSourceRoot: string;
  sdkSourceRoot: string;
  caveSourceRoot: string;
  covenSourceRoot: string;
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
export function parseCaveConformanceOutput(output: string): Map<string, string>;
export function runPhase1Conformance(options?: ReturnType<typeof parseArgs>): Promise<unknown>;
