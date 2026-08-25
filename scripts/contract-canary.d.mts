export type ContractCanaryArtifact = {
  packageName: string;
  sha256: string;
};
export type ContractCanarySdkArtifacts = {
  core: ContractCanaryArtifact;
  cave: ContractCanaryArtifact;
  coven: ContractCanaryArtifact;
  sdk: ContractCanaryArtifact;
};
export type ContractCanarySdkLockEntry = {
  repository: string;
  revision: string;
  artifacts: ContractCanarySdkArtifacts;
};
export type ContractCanaryCaveLockEntry = {
  repository: string;
  revision: string;
};
export type ContractCanaryLock = {
  path: string;
  sdk: ContractCanarySdkLockEntry;
  cave: ContractCanaryCaveLockEntry;
};
export function readContractCanaryLock(lockPath?: string): ContractCanaryLock;
export function assertContractCanaryCheckoutHeads(
  lock: ContractCanaryLock,
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
  lock: Pick<ContractCanaryLock, 'cave'>,
  harnessRoot: string,
  caveRoot: string,
): void;
export function parseArgs(argv: string[]): {
  sdkRoot: string;
  caveRoot: string;
};
export function main(argv?: string[]): void;
