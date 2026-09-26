import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';

const safeChildSegmentPattern = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const safePrefixPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Name of the ownership stamp written into every owned root.
 *
 * Device and inode alone cannot establish that a directory is still the one we
 * created. Linux readily hands the just-freed inode number to the next
 * directory made at the same path, so a root that was deleted and recreated
 * between creation and cleanup can present identical dev/ino. macOS usually
 * allocates a fresh inode, which is why this only ever failed in CI.
 *
 * The stamp closes that gap: an attacker or a stray process can reproduce a
 * path and even an inode number, but not an unguessable value it never saw.
 */
const ownershipStampName = '.opencoven-owned-temp';

function lstatIfExists(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
}

function assertSafePrefix(prefix) {
  if (!safePrefixPattern.test(prefix)) {
    throw new Error(
      `Owned temp prefix "${prefix}" must use only letters, digits, ".", "_" or "-".`,
    );
  }
}

function assertSafeChildSegment(segment, label = 'Owned temp path segment') {
  if (!safeChildSegmentPattern.test(segment)) {
    throw new Error(
      `${label} "${segment}" must be a safe child name using only letters, digits, ".", "_" or "-".`,
    );
  }
}

function ensureOwnedChildDirectories(rootPath, childSegments) {
  let currentPath = rootPath;

  for (const segment of childSegments) {
    assertSafeChildSegment(segment);
    currentPath = resolve(currentPath, segment);
    mkdirSync(currentPath, { mode: 0o700 });
    chmodSync(currentPath, 0o700);

    const stats = lstatSync(currentPath);

    if (stats.isSymbolicLink()) {
      throw new Error(`Owned temp child directory must not be a symlink: ${currentPath}`);
    }

    if (!stats.isDirectory()) {
      throw new Error(`Owned temp child directory must be a directory: ${currentPath}`);
    }
  }

  return currentPath;
}

function createOwnedTempDirectoryIn(parentPath, { prefix, childSegments = [] }) {
  assertSafePrefix(prefix);

  const rootPath = mkdtempSync(resolve(parentPath, `${prefix}-`));
  chmodSync(rootPath, 0o700);

  const rootStats = lstatSync(rootPath);

  if (rootStats.isSymbolicLink()) {
    throw new Error(`Owned temp root must not be a symlink: ${rootPath}`);
  }

  if (!rootStats.isDirectory()) {
    throw new Error(`Owned temp root must be a directory: ${rootPath}`);
  }

  const rootStamp = randomUUID();
  writeFileSync(resolve(rootPath, ownershipStampName), rootStamp, { mode: 0o600 });

  return {
    parentPath,
    rootPath,
    rootRealPath: realpathSync(rootPath),
    rootDevice: rootStats.dev,
    rootInode: rootStats.ino,
    rootStamp,
    path: ensureOwnedChildDirectories(rootPath, childSegments),
  };
}

/**
 * Read the ownership stamp out of a directory.
 *
 * Returns undefined when it is absent or is not a plain file, so a symlink
 * planted where the stamp belongs can never be followed and read.
 */
function readOwnershipStamp(directoryPath) {
  const stampPath = resolve(directoryPath, ownershipStampName);
  const stats = lstatIfExists(stampPath);

  if (stats === undefined || stats.isSymbolicLink() || !stats.isFile()) {
    return undefined;
  }

  return readFileSync(stampPath, 'utf8');
}

/** Fail unless the directory carries the stamp this context wrote. */
function assertOwnershipStamp(directoryPath, context, whenLabel) {
  if (readOwnershipStamp(directoryPath) !== context.rootStamp) {
    throw new Error(`Owned temp root changed identity ${whenLabel}: ${directoryPath}`);
  }
}

function assertOwnedRootStillMatches(context) {
  const stats = lstatIfExists(context.rootPath);

  if (stats === undefined) {
    throw new Error(`Owned temp root no longer exists: ${context.rootPath}`);
  }

  if (stats.isSymbolicLink()) {
    throw new Error(`Owned temp root must not be a symlink: ${context.rootPath}`);
  }

  if (!stats.isDirectory()) {
    throw new Error(`Owned temp root must be a directory: ${context.rootPath}`);
  }

  if (stats.dev !== context.rootDevice || stats.ino !== context.rootInode) {
    throw new Error(`Owned temp root changed identity before cleanup: ${context.rootPath}`);
  }

  // Checked after dev/ino rather than instead of it: the cheap check rejects
  // the common case, and this one rejects the case dev/ino cannot see.
  assertOwnershipStamp(context.rootPath, context, 'before cleanup');

  const rootRealPath = realpathSync(context.rootPath);

  if (rootRealPath !== context.rootRealPath) {
    throw new Error(`Owned temp root changed real path before cleanup: ${context.rootPath}`);
  }
}

const cleanupFailureCategories = new WeakMap();

export function ownedTempCleanupFailureCategory(error) {
  return cleanupFailureCategories.get(error) ?? 'unknown';
}

function cleanupOperation(category, operation) {
  try {
    return operation();
  } catch (error) {
    if ((typeof error === 'object' && error !== null) || typeof error === 'function') {
      cleanupFailureCategories.set(error, category);
    }
    throw error;
  }
}

function removePathWithoutFollowingSymlinks(path) {
  const stats = cleanupOperation('entry-stat', () => lstatIfExists(path));

  if (stats === undefined) {
    return;
  }

  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    cleanupOperation('leaf-remove', () => unlinkSync(path));
    return;
  }

  const entries = cleanupOperation('directory-enumerate', () => readdirSync(path));
  for (const entry of entries) {
    removePathWithoutFollowingSymlinks(resolve(path, entry));
  }

  cleanupOperation('directory-remove', () => rmdirSync(path));
}

export function createOwnedTempDirectory({ prefix, childSegments = [] } = {}) {
  const parentPath = realpathSync(tmpdir());
  return createOwnedTempDirectoryIn(parentPath, { prefix, childSegments });
}

export function createOwnedShortTempDirectory({ prefix, childSegments = [] } = {}) {
  const parentPath = process.platform === 'win32' ? realpathSync(tmpdir()) : realpathSync('/tmp');
  return createOwnedTempDirectoryIn(parentPath, { prefix, childSegments });
}

/**
 * Windows briefly denies renaming a directory right after the processes that
 * worked in it exit: a handle held by process teardown or a file scanner
 * outlives them. The protected Windows lane caught this as `root-rename` with
 * `0x80070005` at 0 s, the same rename succeeding 3 s later with no process
 * left in the root and no file still open. Retry only those transient codes,
 * only on Windows, for a bounded time; every other failure is immediate.
 * The identity and ownership checks after the rename are unchanged.
 */
const transientRenameCodes = new Set(['EPERM', 'EACCES', 'EBUSY']);
const renameRetryBudgetMs = 30_000;
const renameRetryMaxDelayMs = 2_000;

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function renameWithTransientRetry(
  from,
  to,
  { platform = process.platform, sleep = sleepSync, budgetMs = renameRetryBudgetMs } = {},
) {
  let waited = 0;
  let delay = 100;
  for (;;) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const transient =
        platform === 'win32' &&
        error instanceof Error &&
        'code' in error &&
        transientRenameCodes.has(error.code);
      if (!transient || waited + delay > budgetMs) {
        throw error;
      }
      sleep(delay);
      waited += delay;
      delay = Math.min(delay * 2, renameRetryMaxDelayMs);
    }
  }
}

export function cleanupOwnedTempRoot(context) {
  cleanupOperation('root-precondition', () => assertOwnedRootStillMatches(context));

  const deletingRoot = resolve(
    context.parentPath,
    `${basename(context.rootPath)}.deleting-${process.pid}-${randomUUID()}`,
  );

  cleanupOperation('root-rename', () => renameWithTransientRetry(context.rootPath, deletingRoot));

  cleanupOperation('root-postrename', () => {
    const renamedStats = lstatSync(deletingRoot);

    if (renamedStats.isSymbolicLink()) {
      throw new Error(`Owned temp cleanup root must not be a symlink: ${deletingRoot}`);
    }

    if (!renamedStats.isDirectory()) {
      throw new Error(`Owned temp cleanup root must be a directory: ${deletingRoot}`);
    }

    if (renamedStats.dev !== context.rootDevice || renamedStats.ino !== context.rootInode) {
      throw new Error(`Owned temp cleanup root changed identity after rename: ${deletingRoot}`);
    }

    // The rename moved a directory; confirm it is still ours before the
    // recursive delete, which is the only irreversible step in this file.
    assertOwnershipStamp(deletingRoot, context, 'after rename');
  });

  removePathWithoutFollowingSymlinks(deletingRoot);
}
