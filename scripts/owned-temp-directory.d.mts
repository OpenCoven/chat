export type OwnedTempDirectoryContext = {
  parentPath: string;
  rootPath: string;
  rootRealPath: string;
  rootDevice: number;
  rootInode: number;
  /**
   * Unguessable value written into the root at creation and verified before
   * cleanup. Device and inode cannot distinguish a recreated directory that
   * reused the freed inode number, which Linux does routinely.
   */
  rootStamp: string;
  path: string;
};

export function createOwnedTempDirectory(options: {
  prefix: string;
  childSegments?: string[];
}): OwnedTempDirectoryContext;
export function cleanupOwnedTempRoot(context: OwnedTempDirectoryContext): void;
