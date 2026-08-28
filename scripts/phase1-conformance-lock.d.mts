export type Phase1LockEntry = {
  repository: string;
  revision: string;
};

export function createGitEnvironment(
  inheritedEnvironment?: NodeJS.ProcessEnv,
): Record<string, string>;
export function readPhase1ConformanceLock(lockPath?: string): {
  path: string;
  version: 1;
  chat: Phase1LockEntry;
  sdk: Phase1LockEntry;
  cave: Phase1LockEntry;
  coven: Phase1LockEntry;
};
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
export const phase1ConformanceTestOnly: {
  assertCleanPhase1Checkouts(
    options: {
      chatRoot: string;
      sdkRoot: string;
      caveRoot: string;
      covenRoot: string;
    },
    testOptions?: {
      limits?: {
        repositoryDeadlineMs?: number;
        trackedEntryLimit?: number;
        trackedPathByteLimit?: number;
      };
    },
  ): {
    chat: { staged: number; unstaged: number; untracked: number };
    sdk: { staged: number; unstaged: number; untracked: number };
    cave: { staged: number; unstaged: number; untracked: number };
    coven: { staged: number; unstaged: number; untracked: number };
  };
  assertPhase1CheckoutHeads(
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
    testOptions?: {
      limits?: {
        repositoryDeadlineMs?: number;
        trackedEntryLimit?: number;
        trackedPathByteLimit?: number;
      };
    },
  ): { chat: string; sdk: string; cave: string; coven: string };
};
