export type Phase1LockEntry = {
  repository: string;
  revision: string;
};

export function readPhase1ConformanceLock(lockPath?: string): {
  path: string;
  chat: Phase1LockEntry;
  sdk: Phase1LockEntry;
  cave: Phase1LockEntry;
  coven: Phase1LockEntry;
};
export function assertCleanGitCheckout(
  repositoryRoot: string,
  label: string,
): { staged: number; unstaged: number; untracked: number };
export function assertCleanPhase1Checkouts(options: {
  chatRoot: string;
  sdkRoot: string;
  caveRoot: string;
  covenRoot: string;
}): {
  chat: { staged: number; unstaged: number; untracked: number };
  sdk: { staged: number; unstaged: number; untracked: number };
  cave: { staged: number; unstaged: number; untracked: number };
  coven: { staged: number; unstaged: number; untracked: number };
};
export function assertPhase1CheckoutHeads(
  lock: {
    chat: Phase1LockEntry;
    sdk: Phase1LockEntry;
    cave: Phase1LockEntry;
    coven: Phase1LockEntry;
  },
  options: {
    chatRoot: string;
    sdkRoot: string;
    caveRoot: string;
    covenRoot: string;
  },
): { chat: string; sdk: string; cave: string; coven: string };
export function parseArgs(argv: string[]): {
  chatRoot: string;
  sdkRoot: string;
  caveRoot: string;
  covenRoot: string;
  lockPath: string;
};
export function main(argv?: string[]): void;
