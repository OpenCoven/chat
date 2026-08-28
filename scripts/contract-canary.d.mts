export type ContractCanaryArtifact<PackageName extends string = string> = {
  packageName: PackageName;
  version: string;
  releaseFile: string;
  vendorFile: string;
  size: number;
  sha256: string;
};
export type ContractCanarySdkArtifacts = {
  core: ContractCanaryArtifact<'@opencoven/sdk-core'>;
  cave: ContractCanaryArtifact<'@opencoven/cave-client'>;
  coven: ContractCanaryArtifact<'@opencoven/coven-client'>;
  sdk: ContractCanaryArtifact<'@opencoven/sdk'>;
};
export type ContractCanarySdkLockEntry = {
  repository: string;
  revision: string;
  releaseManifest: {
    file: 'release-manifest.json';
    version: string;
    sha256: string;
  };
  artifacts: ContractCanarySdkArtifacts;
};
export type ContractCanaryCaveLockEntry = {
  repository: string;
  revision: string;
  artifacts: {
    contractFixture: {
      path: 'src/lib/server/client-v1/contract-fixture.json';
      digestPath: 'src/lib/server/client-v1/contract-fixture.sha256';
      sha256: string;
    };
    hpkeVectors: {
      path: 'src/lib/server/client-v1/hpke-bound-v1-vectors.json';
      digestPath: 'src/lib/server/client-v1/hpke-bound-v1-vectors.sha256';
      sha256: string;
    };
  };
};
export type ContractCanaryLock = {
  path: string;
  sdk: ContractCanarySdkLockEntry;
  cave: ContractCanaryCaveLockEntry;
};
export type ContractCanaryCheckoutHeadsLock = {
  sdk: Pick<ContractCanarySdkLockEntry, 'repository' | 'revision'>;
  cave: Pick<ContractCanaryCaveLockEntry, 'repository' | 'revision'>;
};
export type ContractCanaryPackedFixtureLock = {
  cave: Pick<ContractCanaryCaveLockEntry, 'revision' | 'artifacts'>;
};
export function readContractCanaryLock(lockPath?: string): ContractCanaryLock;
export function assertContractCanaryCheckoutHeads(
  lock: ContractCanaryCheckoutHeadsLock,
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
export function assertPackedPackageContentsMatch(
  reviewedTarballs: Record<'core' | 'cave' | 'coven' | 'sdk', string>,
  frozenTarballs: Record<'core' | 'cave' | 'coven' | 'sdk', string>,
  comparisonRoot: string,
): void;
export function assertPackedFixtureMatchesCaveCheckout(
  lock: ContractCanaryPackedFixtureLock,
  harnessRoot: string,
  caveRoot: string,
): void;
export function parseArgs(argv: string[]): {
  sdkRoot: string;
  caveRoot: string;
};
export function main(argv?: string[]): void;
