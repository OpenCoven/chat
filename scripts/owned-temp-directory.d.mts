export type OwnedTempDirectoryContext = {
  parentPath: string;
  rootPath: string;
  rootRealPath: string;
  rootDevice: number;
  rootInode: number;
  path: string;
};

export function createOwnedTempDirectory(options: {
  prefix: string;
  childSegments?: string[];
}): OwnedTempDirectoryContext;
export function cleanupOwnedTempRoot(context: OwnedTempDirectoryContext): void;
