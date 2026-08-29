import type { ChildProcess } from 'node:child_process';

export type ProcessOwnedArtifactRoot = {
  rootPath: string;
  rootDevice: number;
  rootInode: number;
  rootStamp: string;
  ownerPid: number;
  cleanedChildren: number[];
  reapedChildren: number[];
  trackChild(child: ChildProcess, options?: { processGroup?: boolean }): ChildProcess;
  retainSanitizedJsonReport(options: {
    reportPath: string;
    destinationPath: string;
    secretScan(options: { artifactRoot: string; reportPath: string }): Promise<void>;
  }): Promise<string>;
  cleanup(): Promise<void>;
};

export function createProcessOwnedArtifactRoot(options: {
  prefix: string;
  terminationGraceMs?: number;
  shortPath?: boolean;
}): ProcessOwnedArtifactRoot;
