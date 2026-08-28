import { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, parse, relative, resolve, sep } from 'node:path';

import { cleanupOwnedTempRoot, createOwnedTempDirectory } from './owned-temp-directory.mjs';

const defaultTerminationGraceMs = 5_000;
const noFollow = constants.O_NOFOLLOW ?? 0;

function requireExactOptions(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new Error(
      'Process-owned artifact root options must contain exactly prefix and optional terminationGraceMs.',
    );
  }

  const keys = Object.keys(options);
  if (
    !keys.includes('prefix') ||
    keys.some((key) => key !== 'prefix' && key !== 'terminationGraceMs')
  ) {
    throw new Error(
      'Process-owned artifact root options must contain exactly prefix and optional terminationGraceMs.',
    );
  }

  const terminationGraceMs = options.terminationGraceMs ?? defaultTerminationGraceMs;
  if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs <= 0) {
    throw new Error('Process-owned artifact root terminationGraceMs must be a positive integer.');
  }

  return {
    prefix: options.prefix,
    terminationGraceMs,
  };
}

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

function isInsideRoot(rootPath, candidatePath) {
  const offset = relative(rootPath, candidatePath);
  return offset.length > 0 && offset !== '..' && !offset.startsWith(`..${sep}`);
}

function readReportSnapshot(reportPath, rootRealPath) {
  const absolutePath = resolve(reportPath);
  const pathStats = lstatIfExists(absolutePath);

  if (
    pathStats === undefined ||
    pathStats.isSymbolicLink() ||
    !pathStats.isFile() ||
    !isInsideRoot(rootRealPath, realpathSync(absolutePath))
  ) {
    throw new Error('Sanitized report must be a regular file inside the owned artifact root.');
  }

  let descriptor;
  try {
    descriptor = openSync(absolutePath, constants.O_RDONLY | noFollow);
    const openedStats = fstatSync(descriptor);

    if (
      !openedStats.isFile() ||
      openedStats.dev !== pathStats.dev ||
      openedStats.ino !== pathStats.ino
    ) {
      throw new Error('Sanitized report must be a regular file inside the owned artifact root.');
    }

    return {
      bytes: readFileSync(descriptor),
      device: openedStats.dev,
      inode: openedStats.ino,
      path: absolutePath,
    };
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
  }
}

function requireCompletedJsonReport(snapshot) {
  let report;

  try {
    report = JSON.parse(snapshot.bytes.toString('utf8'));
  } catch {
    throw new Error('Sanitized report must be a completed JSON report.');
  }

  if (
    report === null ||
    typeof report !== 'object' ||
    Array.isArray(report) ||
    report.completed !== true
  ) {
    throw new Error('Sanitized report must be a completed JSON report.');
  }
}

function ensureSafeDirectoryPath(directoryPath) {
  const absolutePath = resolve(directoryPath);
  const rootPath = parse(absolutePath).root;
  let currentPath = rootPath;
  const childSegments = relative(rootPath, absolutePath).split(sep).filter(Boolean);

  for (const segment of childSegments) {
    currentPath = resolve(currentPath, segment);
    const stats = lstatIfExists(currentPath);

    if (stats === undefined) {
      mkdirSync(currentPath, { mode: 0o700 });
      chmodSync(currentPath, 0o700);
      continue;
    }

    if (stats.isSymbolicLink()) {
      throw new Error(`Retained report parent must not be a symlink: ${currentPath}`);
    }

    if (!stats.isDirectory()) {
      throw new Error(`Retained report parent must be a directory: ${currentPath}`);
    }
  }

  return absolutePath;
}

function copyCompletedFileWithoutOverwrite(bytes, destinationPath) {
  const absoluteDestination = isAbsolute(destinationPath)
    ? destinationPath
    : resolve(destinationPath);
  const existingDestination = lstatIfExists(absoluteDestination);

  if (existingDestination !== undefined) {
    throw new Error(`Retained report destination already exists: ${absoluteDestination}`);
  }

  const destinationParent = ensureSafeDirectoryPath(dirname(absoluteDestination));
  const stagingPath = resolve(destinationParent, `.phase1-report-${randomUUID()}`);
  let descriptor;

  try {
    descriptor = openSync(
      stagingPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow,
      0o600,
    );
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    chmodSync(stagingPath, 0o600);
    linkSync(stagingPath, absoluteDestination);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(`Retained report destination already exists: ${absoluteDestination}`);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
    }
    if (existsSync(stagingPath)) {
      unlinkSync(stagingPath);
    }
  }

  return absoluteDestination;
}

function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve(true);
  }

  return new Promise((resolveWait) => {
    let settled = false;
    const finish = (closed) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.off('close', onClose);
      resolveWait(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);

    child.once('close', onClose);
    if (child.exitCode !== null || child.signalCode !== null) {
      finish(true);
    }
  });
}

async function terminateAndReapChild(child, terminationGraceMs) {
  const pid = child.pid;

  if (child.exitCode === null && child.signalCode === null) {
    const signaled = child.kill('SIGTERM');
    if (!signaled && child.exitCode === null && child.signalCode === null) {
      throw new Error(`Tracked child ${pid} could not be terminated.`);
    }
  }

  if (await waitForChildClose(child, terminationGraceMs)) {
    return;
  }

  const killed = child.kill('SIGKILL');
  if (!killed && child.exitCode === null && child.signalCode === null) {
    throw new Error(`Tracked child ${pid} could not be killed.`);
  }

  if (!(await waitForChildClose(child, terminationGraceMs))) {
    throw new Error(`Tracked child ${pid} could not be reaped.`);
  }
}

export function createProcessOwnedArtifactRoot(options) {
  const { prefix, terminationGraceMs } = requireExactOptions(options);
  const owned = createOwnedTempDirectory({ prefix: `${prefix}-${process.pid}` });
  const trackedChildren = new Map();
  const cleanedChildren = [];
  const reapedChildren = [];
  let cleaned = false;

  return {
    rootPath: owned.rootPath,
    rootDevice: owned.rootDevice,
    rootInode: owned.rootInode,
    rootStamp: owned.rootStamp,
    ownerPid: process.pid,
    cleanedChildren,
    reapedChildren,
    trackChild(child) {
      if (!(child instanceof ChildProcess) || !Number.isInteger(child.pid) || child.pid <= 0) {
        throw new Error('trackChild requires a spawned ChildProcess with a positive PID.');
      }

      const existing = trackedChildren.get(child.pid);
      if (existing !== undefined && existing !== child) {
        throw new Error(`A different child is already tracked for PID ${child.pid}.`);
      }
      trackedChildren.set(child.pid, child);
      return child;
    },
    async retainSanitizedJsonReport({ reportPath, destinationPath, secretScan }) {
      if (cleaned) {
        throw new Error('Cannot retain a report after the owned artifact root is cleaned.');
      }
      if (typeof secretScan !== 'function') {
        throw new Error('Retaining a report requires a secretScan function.');
      }

      const firstSnapshot = readReportSnapshot(reportPath, owned.rootRealPath);
      requireCompletedJsonReport(firstSnapshot);

      await secretScan({
        artifactRoot: owned.rootPath,
        reportPath: firstSnapshot.path,
      });

      const scannedSnapshot = readReportSnapshot(reportPath, owned.rootRealPath);
      if (
        scannedSnapshot.device !== firstSnapshot.device ||
        scannedSnapshot.inode !== firstSnapshot.inode ||
        !scannedSnapshot.bytes.equals(firstSnapshot.bytes)
      ) {
        throw new Error('Sanitized report changed after the secret scan.');
      }

      const absoluteDestination = resolve(destinationPath);
      if (isInsideRoot(owned.rootRealPath, absoluteDestination)) {
        throw new Error('Retained report destination must be outside the owned artifact root.');
      }

      return copyCompletedFileWithoutOverwrite(scannedSnapshot.bytes, absoluteDestination);
    },
    async cleanup() {
      if (cleaned) {
        return;
      }

      for (const [pid, child] of trackedChildren) {
        await terminateAndReapChild(child, terminationGraceMs);
        cleanedChildren.push(pid);
        reapedChildren.push(pid);
      }

      trackedChildren.clear();
      cleanupOwnedTempRoot(owned);
      cleaned = true;
    },
  };
}
