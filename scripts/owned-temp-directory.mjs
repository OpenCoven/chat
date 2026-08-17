import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, resolve } from 'node:path';

const safeChildSegmentPattern = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const safePrefixPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

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

  const rootRealPath = realpathSync(context.rootPath);

  if (rootRealPath !== context.rootRealPath) {
    throw new Error(`Owned temp root changed real path before cleanup: ${context.rootPath}`);
  }
}

function removePathWithoutFollowingSymlinks(path) {
  const stats = lstatIfExists(path);

  if (stats === undefined) {
    return;
  }

  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    unlinkSync(path);
    return;
  }

  for (const entry of readdirSync(path)) {
    removePathWithoutFollowingSymlinks(resolve(path, entry));
  }

  rmdirSync(path);
}

export function createOwnedTempDirectory({ prefix, childSegments = [] } = {}) {
  assertSafePrefix(prefix);

  const parentPath = realpathSync(tmpdir());
  const rootPath = mkdtempSync(resolve(parentPath, `${prefix}-`));
  chmodSync(rootPath, 0o700);

  const rootStats = lstatSync(rootPath);

  if (rootStats.isSymbolicLink()) {
    throw new Error(`Owned temp root must not be a symlink: ${rootPath}`);
  }

  if (!rootStats.isDirectory()) {
    throw new Error(`Owned temp root must be a directory: ${rootPath}`);
  }

  return {
    parentPath,
    rootPath,
    rootRealPath: realpathSync(rootPath),
    rootDevice: rootStats.dev,
    rootInode: rootStats.ino,
    path: ensureOwnedChildDirectories(rootPath, childSegments),
  };
}

export function cleanupOwnedTempRoot(context) {
  assertOwnedRootStillMatches(context);

  const deletingRoot = resolve(
    context.parentPath,
    `${basename(context.rootPath)}.deleting-${process.pid}-${randomUUID()}`,
  );

  renameSync(context.rootPath, deletingRoot);

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

  removePathWithoutFollowingSymlinks(deletingRoot);
}
