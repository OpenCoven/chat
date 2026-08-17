export function resolveContractCanaryArtifactRoot(
  artifactName?: string,
  options?: { repositoryRoot?: string },
): string;
export function prepareContractCanaryArtifactRoot(
  artifactName?: string,
  options?: { repositoryRoot?: string },
): string;
export function removeContractCanaryArtifactRoot(
  artifactRoot: string,
  options?: { repositoryRoot?: string },
): void;
export function parseArgs(argv: string[]): {
  sdkRoot: string;
  caveRoot: string;
  artifactName: string;
  artifactRoot: string;
};
export function main(argv?: string[]): void;
