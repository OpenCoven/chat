export type Phase1LockEntry = {
  repository: string;
  revision: string;
};

export function createGitEnvironment(
  inheritedEnvironment?: NodeJS.ProcessEnv,
): Record<string, string>;
export function readPhase1ConformanceLock(lockPath?: string): {
  path: string;
  version: 5;
  chat: Phase1LockEntry;
  sdk: Phase1LockEntry;
  cave: Phase1LockEntry;
  coven: Phase1LockEntry;
  harness: Phase1LockEntry;
  chatAuthority: {
    tree: string;
    files: Array<{ path: string; blob: string; sha256: string }>;
  };
  tools: {
    windowsSupervisor: {
      source: {
        repository: string;
        revision: string;
        path: string;
        blob: string;
        sha256: string;
        manifestSha256: string;
        lockSha256: string;
        configSha256: string;
      };
      toolchain: {
        homebrewCoreRevision: string;
        packageVersion: string;
        bottleLayerSha256: string;
        linkerVersion: string;
      };
      artifact: {
        target: string;
        buildInvocation: string;
        fileName: string;
        fleetPath: string;
        size: number;
        sha256: string;
      };
    };
  };
  release: {
    sdkManifest: { version: string; sha256: string };
    sdkArtifacts: Array<{
      packageName: string;
      releaseFile: string;
      vendorFile: string;
      size: number;
      sha256: string;
    }>;
    caveVersion: string;
    covenVersion: string;
    consumerLock: { path: string; size: number; sha256: string };
    caveArtifacts: Record<string, { path: string; size: number; sha256: string }>;
  };
  evidence: {
    repository: string;
    revision: string;
    contract: { path: string; sha256: string };
    schema: { path: string; sha256: string };
    assertionRegistry: { path: string; sha256: string };
  };
};
export function assertCleanPhase1Checkouts(options: {
  chatRoot: string;
  chatHarnessRoot?: string;
  sdkRoot: string;
  caveRoot: string;
  covenRoot: string;
}): {
  chat: { staged: number; unstaged: number; untracked: number };
  sdk: { staged: number; unstaged: number; untracked: number };
  cave: { staged: number; unstaged: number; untracked: number };
  coven: { staged: number; unstaged: number; untracked: number };
  harness?: { staged: number; unstaged: number; untracked: number };
};
export function assertPhase1CheckoutHeads(
  lock: unknown,
  options: {
    chatRoot: string;
    chatHarnessRoot?: string;
    sdkRoot: string;
    caveRoot: string;
    covenRoot: string;
  },
): { chat: string; sdk: string; cave: string; coven: string; harness?: string };
export const phase1ConformanceTestOnly: {
  assertCleanPhase1Checkouts(
    options: {
      chatRoot: string;
      chatHarnessRoot?: string;
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
    harness?: { staged: number; unstaged: number; untracked: number };
  };
  assertPhase1CheckoutHeads(
    lock: unknown,
    options: {
      chatRoot: string;
      chatHarnessRoot?: string;
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
  ): { chat: string; sdk: string; cave: string; coven: string; harness?: string };
};
