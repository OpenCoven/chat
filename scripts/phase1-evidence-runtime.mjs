import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readdirSync, readlinkSync, readSync } from 'node:fs';
import { resolve } from 'node:path';

const operatorStateIds = Object.freeze(['cave-home', 'coven-home', 'projects']);
const isolationRootIds = Object.freeze([
  'cave-home',
  'coven-home',
  'consumer-home',
  'native-credential-store',
]);
const digestPattern = /^[0-9a-f]{64}$/u;
const opaqueIdPattern = /^[0-9a-f]{32}$/u;
const defaultLimits = Object.freeze({
  maxDepth: 64,
  maxEntries: 1_000_000,
  maxLogicalBytes: 1024 * 1024 * 1024 * 1024,
  maxContentBytes: 64 * 1024 * 1024,
});

function missingPath(error) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function snapshotPath(path, limits = defaultLimits) {
  const root = resolve(path);
  const digest = createHash('sha256');
  const state = { entries: 0, logicalBytes: 0, contentBytes: 0 };
  const buffer = Buffer.allocUnsafe(1024 * 1024);

  const hashFile = (entryPath) => {
    const descriptor = openSync(entryPath, 'r');
    try {
      while (true) {
        const bytesRead = readSync(descriptor, buffer, 0, buffer.length, null);
        if (bytesRead === 0) {
          return;
        }
        digest.update(buffer.subarray(0, bytesRead));
      }
    } finally {
      closeSync(descriptor);
    }
  };

  const visit = (entryPath, relativePath, depth) => {
    if (depth > limits.maxDepth) {
      throw new Error('Operator state exceeds the snapshot depth limit.');
    }
    let stats;
    try {
      stats = lstatSync(entryPath);
    } catch (error) {
      if (depth === 0 && missingPath(error)) {
        digest.update('missing\0');
        return;
      }
      throw error;
    }
    state.entries += 1;
    if (state.entries > limits.maxEntries) {
      throw new Error('Operator state exceeds the snapshot entry limit.');
    }
    const normalized = relativePath.replaceAll('\\', '/');
    if (stats.isSymbolicLink()) {
      digest.update(
        `symlink:${normalized}:${stats.dev}:${stats.ino}:${stats.mode & 0o777}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}:${readlinkSync(entryPath, 'utf8')}\0`,
      );
      return;
    }
    if (stats.isDirectory()) {
      digest.update(
        `directory:${normalized}:${stats.dev}:${stats.ino}:${stats.mode & 0o777}:${stats.mtimeMs}:${stats.ctimeMs}\0`,
      );
      for (const entry of readdirSync(entryPath, { withFileTypes: true }).sort((left, right) =>
        left.name.localeCompare(right.name),
      )) {
        visit(
          resolve(entryPath, entry.name),
          normalized.length === 0 ? entry.name : `${normalized}/${entry.name}`,
          depth + 1,
        );
      }
      return;
    }
    if (!stats.isFile()) {
      digest.update(
        `special:${normalized}:${stats.dev}:${stats.ino}:${stats.mode}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}\0`,
      );
      return;
    }
    state.logicalBytes += stats.size;
    if (state.logicalBytes > limits.maxLogicalBytes) {
      throw new Error('Operator state exceeds the bounded logical-size limit.');
    }
    digest.update(
      `file:${normalized}:${stats.dev}:${stats.ino}:${stats.mode & 0o777}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}\0`,
    );
    if (state.contentBytes + stats.size <= limits.maxContentBytes) {
      hashFile(entryPath);
      state.contentBytes += stats.size;
    } else {
      digest.update('metadata-only\0');
    }
    digest.update('\0');
  };

  visit(root, '', 0);
  return digest.digest('hex');
}

export function captureOperatorFilesystemState({ caveHome, covenHome }) {
  if (
    typeof caveHome !== 'string' ||
    caveHome.length === 0 ||
    typeof covenHome !== 'string' ||
    covenHome.length === 0
  ) {
    throw new Error('Operator Cave and Coven home paths are required.');
  }
  const paths = {
    'cave-home': resolve(caveHome),
    'coven-home': resolve(covenHome),
    projects: resolve(caveHome, 'projects.json'),
  };
  return Object.fromEntries(
    operatorStateIds.map((id) => [
      id,
      Object.freeze({
        path: paths[id],
        sha256: snapshotPath(paths[id]),
      }),
    ]),
  );
}

export function buildIsolationEvidence({
  operatorBefore,
  operatorAfter,
  nativeBeforeSha256,
  nativeAfterSha256,
  opaqueIds,
}) {
  if (
    !Array.isArray(opaqueIds) ||
    opaqueIds.length !== isolationRootIds.length ||
    opaqueIds.some((value) => typeof value !== 'string' || !opaqueIdPattern.test(value)) ||
    new Set(opaqueIds).size !== opaqueIds.length
  ) {
    throw new Error('Isolation roots require four unique opaque identifiers.');
  }
  if (
    !digestPattern.test(nativeBeforeSha256 ?? '') ||
    !digestPattern.test(nativeAfterSha256 ?? '') ||
    nativeBeforeSha256 !== nativeAfterSha256
  ) {
    throw new Error('Native credential state changed or is invalid.');
  }
  const filesystemState = operatorStateIds.map((id) => {
    const before = operatorBefore?.[id];
    const after = operatorAfter?.[id];
    if (
      before === undefined ||
      after === undefined ||
      before.path !== after.path ||
      !digestPattern.test(before.sha256 ?? '') ||
      !digestPattern.test(after.sha256 ?? '') ||
      before.sha256 !== after.sha256
    ) {
      throw new Error(`Operator state ${id} changed or is invalid.`);
    }
    return {
      id,
      beforeSha256: before.sha256,
      afterSha256: after.sha256,
    };
  });

  return {
    strategy: 'process-owned-temporary-roots',
    network: 'loopback-only',
    sourceCheckoutDependency: false,
    workspaceLinkDependency: false,
    retainedPrivatePaths: false,
    retainedSocketHandles: false,
    roots: isolationRootIds.map((id, index) => ({
      id,
      opaqueId: opaqueIds[index],
      ownershipVerified: true,
      removedAfterRun: true,
    })),
    operatorState: [
      filesystemState[0],
      filesystemState[1],
      {
        id: 'native-credential-store',
        beforeSha256: nativeBeforeSha256,
        afterSha256: nativeAfterSha256,
      },
      filesystemState[2],
    ],
  };
}
