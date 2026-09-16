import type { ChildProcess } from 'node:child_process';

export type ProcessOwnedArtifactRoot = {
  rootPath: string;
  rootDevice: number;
  rootInode: number;
  rootStamp: string;
  ownerPid: number;
  cleanedChildren: number[];
  reapedChildren: number[];
  trackChild(child: ChildProcess): ChildProcess;
  terminateChild(child: ChildProcess): Promise<void>;
  retainSanitizedJsonReport(options: {
    reportPath: string;
    destinationPath: string;
    secretScan(options: { artifactRoot: string; reportPath: string }): Promise<void>;
    validateReport?(value: unknown, bytes: Buffer): void;
  }): Promise<string>;
  cleanup(): Promise<void>;
};

export function createProcessOwnedArtifactRoot(options: {
  prefix: string;
  terminationGraceMs?: number;
  shortPath?: boolean;
}): ProcessOwnedArtifactRoot;

export function processCleanupFailureCategory(
  error: unknown,
):
  | ReturnType<typeof import('./owned-temp-directory.mjs').ownedTempCleanupFailureCategory>
  | 'child-terminate'
  | 'supervisor-wait'
  | 'child-kill'
  | 'child-reap'
  | 'tracked-set-changed'
  | 'multiple';

export const PROCESS_CLEANUP_FAILURE_CATEGORIES: readonly ReturnType<
  typeof processCleanupFailureCategory
>[];
