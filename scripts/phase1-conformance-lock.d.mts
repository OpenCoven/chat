export type Phase1LockEntry = {
  repository: string;
  revision: string;
  tree?: string;
};

export function createGitEnvironment(
  inheritedEnvironment?: NodeJS.ProcessEnv,
): Record<string, string>;
export function createGitCheckoutEnvironment(
  inheritedEnvironment?: NodeJS.ProcessEnv,
): Record<string, string>;
export function readPhase1ConformanceLock(lockPath?: string): {
  path: string;
  version: 1 | 2 | 3;
  validator?: Phase1LockEntry;
  chat: Phase1LockEntry;
  sdk: Phase1LockEntry;
  cave: Phase1LockEntry;
  coven: Phase1LockEntry;
};
export function assertCleanPhase1Checkouts(options: {
  validatorRoot?: string;
  chatRoot: string;
  sdkRoot: string;
  caveRoot: string;
  covenRoot: string;
}): {
  validator?: { staged: number; unstaged: number; untracked: number; ignored: number };
  chat: { staged: number; unstaged: number; untracked: number; ignored: number };
  sdk: { staged: number; unstaged: number; untracked: number; ignored: number };
  cave: { staged: number; unstaged: number; untracked: number; ignored: number };
  coven: { staged: number; unstaged: number; untracked: number; ignored: number };
};
export function assertCleanPhase1Checkout(
  repositoryRoot: string,
  label?: string,
): { staged: number; unstaged: number; untracked: number; ignored: number };
export function readPhase1CheckoutIdentity(
  repositoryRoot: string,
  label?: string,
): { revision: string; tree: string };
export function assertPhase1CheckoutHeads(
  lock: unknown,
  options: {
    validatorRoot?: string;
    chatRoot: string;
    sdkRoot: string;
    caveRoot: string;
    covenRoot: string;
  },
): {
  validator?: string;
  chat: string;
  sdk: string;
  cave: string;
  coven: string;
};
export const phase1ConformanceTestOnly: {
  assertCleanPhase1Checkouts(
    options: {
      validatorRoot?: string;
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
    validator?: { staged: number; unstaged: number; untracked: number; ignored: number };
    chat: { staged: number; unstaged: number; untracked: number; ignored: number };
    sdk: { staged: number; unstaged: number; untracked: number; ignored: number };
    cave: { staged: number; unstaged: number; untracked: number; ignored: number };
    coven: { staged: number; unstaged: number; untracked: number; ignored: number };
  };
  assertPhase1CheckoutHeads(
    lock: unknown,
    options: {
      validatorRoot?: string;
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
    validator?: string;
    chat: string;
    sdk: string;
    cave: string;
    coven: string;
  };
};
