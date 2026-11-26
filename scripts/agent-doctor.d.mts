type Assessment = { status: string; detail: string };
type RecordRow = Record<string, unknown>;
export function assessRuntime(input: {
  chatSha: string;
  installerPin: string | null;
  engineSetupPin?: string | null;
  required?: string[];
  releases: RecordRow[] | null;
  receipts?: RecordRow[];
}): {
  installer: Assessment;
  published: Assessment;
  candidates: Assessment[];
  publishedReceipts: Assessment[];
};
export function assessChecks(
  required: string[] | null,
  runs: RecordRow[] | null,
  statuses: RecordRow[] | null,
  labels: string[],
  rules: RecordRow[] | null,
): Assessment & { checks: Array<{ name: string; status: string }> };
export function assessDeployment(paths: string[], workflow: string): Assessment;
export function assessIssue(
  issue: RecordRow,
  comments: RecordRow[] | null,
  prs: RecordRow[],
  now?: number,
): { owner?: string; warnings: string[]; claim: string | null; nextAction: string };
export function collectDoctor(options?: {
  root?: string;
  offline?: boolean;
  prNumber?: number;
  required?: string[];
  receipts?: RecordRow[];
  run?: (program: string, args: string[], cwd: string) => { ok: boolean; value: string | null };
}): {
  checkout: { dirty: boolean | null };
  tracking: { status: string };
  ci: { status: string; head: string | null };
  deployment: Assessment;
  runtime: { installer: Assessment };
};
export function formatDoctor(report: RecordRow): string;
