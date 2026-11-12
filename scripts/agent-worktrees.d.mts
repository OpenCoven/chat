export type WorktreeEntry = {
  path: string;
  head: string;
  branch: string | null;
  locked: boolean;
  prunable: boolean;
};

export type WorktreeFacts = {
  primary: boolean;
  missing: boolean;
  locked: boolean;
  inUse: boolean;
  dirty: number;
  unpushed: number;
  merged: boolean;
  prState: 'open' | 'closed' | 'merged' | 'none' | 'unknown';
  idleDays: number;
  retained: boolean;
};

export type WorktreeVerdict = 'removable' | 'check' | 'keep' | 'prunable' | 'primary';

export type WorktreeClassification = { verdict: WorktreeVerdict; reasons: string[] };

export function parseWorktreeList(porcelain: string): WorktreeEntry[];
export function parseCwdList(lsofOutput: string): string[];
export function coordinationNames(path: string, primaryPath: string, home?: string): string[];
export function classifyWorktree(
  facts: WorktreeFacts,
  options?: { idleDays?: number },
): WorktreeClassification;
export function auditWorktrees(options?: {
  root?: string;
  offline?: boolean;
  idleDays?: number;
}): Array<WorktreeEntry & WorktreeClassification & { facts: WorktreeFacts }>;
