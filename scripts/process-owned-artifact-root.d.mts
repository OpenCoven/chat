export type ProcessOwnedArtifactRoot = {
  rootPath: string;
  ownerPid: number;
  cleanedChildren: number[];
  trackChild(pid: number): void;
  cleanup(): Promise<void>;
};

export function createProcessOwnedArtifactRoot(options: {
  prefix: string;
}): ProcessOwnedArtifactRoot;
