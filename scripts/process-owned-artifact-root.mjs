import { cleanupOwnedTempRoot, createOwnedTempDirectory } from './owned-temp-directory.mjs';

/**
 * Process-owned artifact root.
 *
 * Composes the inode/stamp-checked owned-temp helper with exact child-PID
 * tracking: the harness starts children, records their exact PIDs through
 * `trackChild`, and cleanup terminates ONLY those PIDs before removing the
 * owned root. Callers cannot supply a cleanup path — the root always comes
 * from `createOwnedTempDirectory`, beneath the real OS temp directory.
 */

export function createProcessOwnedArtifactRoot({ prefix }) {
  const owned = createOwnedTempDirectory({ prefix: `${prefix}-${process.pid}` });
  const trackedChildren = new Set();
  const cleanedChildren = [];

  return {
    rootPath: owned.rootPath,
    ownerPid: process.pid,
    cleanedChildren,
    trackChild(pid) {
      if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error(`trackChild requires a positive integer PID, got: ${pid}`);
      }
      trackedChildren.add(pid);
    },
    async cleanup() {
      for (const pid of trackedChildren) {
        process.kill(pid, 'SIGTERM');
        cleanedChildren.push(pid);
      }
      trackedChildren.clear();
      cleanupOwnedTempRoot(owned);
    },
  };
}
