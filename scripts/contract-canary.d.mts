export interface ContractCanaryPackage {
  name: string;
  version: string;
  file: string;
  size: number;
  sha256: string;
}

export interface ContractCanaryLock {
  version: 2;
  path: string;
  sdk: {
    repository: 'OpenCoven/sdk';
    revision: string;
    releaseManifest: {
      file: 'release-manifest.json';
      version: string;
      sha256: string;
    };
    packages: ContractCanaryPackage[];
  };
  cave: {
    repository: 'OpenCoven/coven-cave';
    revision: string;
    contractFixture: {
      packageFile: string;
      digestPackageFile: string;
      provenancePackageFile: string;
      sha256: string;
      digestFileSha256: string;
      provenanceFileSha256: string;
      provenance: {
        repository: 'https://github.com/OpenCoven/coven-cave';
        commit: string;
        fixturePath: string;
        digestPath: string;
        sha256: string;
      };
    };
    hpkeVector: {
      packageFile: string;
      digestPackageFile: string;
      authorityFile: string;
      authorityDigestFile: string;
      sha256: string;
      digestFileSha256: string;
    };
  };
}

export function readContractCanaryLock(lockPath?: string): ContractCanaryLock;
export function verifySdkReleaseArtifacts(
  lock: ContractCanaryLock,
  artifactRoot: string,
): Record<'core' | 'cave' | 'coven' | 'sdk', string>;
export function verifyPackedCaveAuthorityArtifacts(
  lock: ContractCanaryLock,
  options: { caveRoot: string; installedCaveRoot: string },
): { contractFixtureSha256: string; hpkeVectorSha256: string };
export function createPackedConsumerPackageManifest(
  tarballs: Record<'core' | 'cave' | 'coven' | 'sdk', string>,
): {
  name: string;
  private: true;
  type: 'module';
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  pnpm: { overrides: Record<string, string> };
};
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
export function parseArgs(argv: string[]): {
  sdkRoot: string;
  caveRoot: string;
};
export function main(argv?: string[]): void;
