export const AGENT_DOCS: readonly string[];

export type AgentDocReference = Readonly<{
  kind: 'code' | 'link';
  line: number;
  path: string;
}>;

export type AgentDocProblem = Readonly<{
  doc: string;
  line: number;
  path: string;
  reason: string;
}>;

export function codeSpanPath(span: string): string | null;
export function extractReferences(markdown: string): AgentDocReference[];
export function checkAgentDocPaths(root?: string): AgentDocProblem[];
