export function readContractCanaryLock(lockPath?: string): {
  path: string;
  sdk: { repository: string; revision: string };
  cave: { repository: string; revision: string };
};
export function assertContractCanaryCheckoutHeads(
  lock: {
    sdk: { repository: string; revision: string };
    cave: { repository: string; revision: string };
  },
  options: { sdkRoot: string; caveRoot: string },
): { sdkHead: string; caveHead: string };
export function assertCleanGitCheckout(
  repositoryRoot: string,
  label: string,
): { staged: number; unstaged: number; untracked: number };
export function assertCleanContractCanaryCheckouts(options: {
  sdkRoot: string;
  caveRoot: string;
}): {
  sdk: { staged: number; unstaged: number; untracked: number };
  cave: { staged: number; unstaged: number; untracked: number };
};
export function createContractCanaryVerifier(): string;
export function assertPackedFixtureMatchesCaveCheckout(
  lock: { cave: { revision: string } },
  harnessRoot: string,
  caveRoot: string,
): void;
export function parseArgs(argv: string[]): {
  sdkRoot: string;
  caveRoot: string;
};
export function main(argv?: string[]): void;
