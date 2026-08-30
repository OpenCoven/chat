import { spawn } from 'node:child_process';
import { closeSync, lstatSync, writeSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const terminationGraceMs = 250;
const legacyStatusPathEnvironment = 'OPENCOVEN_PHASE1_SUPERVISOR_STATUS_PATH';
const groupKillFailureEnvironment = 'OPENCOVEN_PHASE1_TEST_GROUP_KILL_FAILURE';

function fail() {
  process.stderr.write('phase1-process-supervisor: failed\n');
  process.exitCode = 1;
}

function main(argv) {
  let timeoutMs;
  if (argv[0] === '--timeout-ms') {
    timeoutMs = Number(argv[1]);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || argv[2] !== '--') {
      fail();
      return;
    }
    argv = argv.slice(3);
  }
  if (process.platform === 'win32' || argv.length < 1 || !isAbsolute(argv[0])) {
    fail();
    return;
  }
  const executable = resolve(argv[0]);
  const stats = lstatSync(executable);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    fail();
    return;
  }
  const child = spawn(executable, argv.slice(1), {
    env: Object.fromEntries(
      Object.entries(process.env).filter(
        ([name]) => ![legacyStatusPathEnvironment, groupKillFailureEnvironment].includes(name),
      ),
    ),
    stdio: ['inherit', 'inherit', 'inherit', 'ignore'],
  });
  let cleanupStarted = false;
  let statusRecorded = false;
  let timeoutHandle;
  const recordStatus = (code, signal, reason) => {
    if (statusRecorded) {
      return;
    }
    statusRecorded = true;
    const frame = `${JSON.stringify({ code, signal, reason })}\n`;
    if (Buffer.byteLength(frame) > 256) {
      throw new Error('supervisor status frame exceeded its bound');
    }
    writeSync(3, frame);
    closeSync(3);
  };
  const killOwnedGroupNow = () => {
    if (cleanupStarted) {
      return;
    }
    cleanupStarted = true;
    if (process.env[groupKillFailureEnvironment] === '1') {
      fail();
      process.exit(1);
    }
    try {
      process.kill(-process.pid, 'SIGKILL');
    } catch {
      fail();
      process.exit(1);
    }
  };
  const cleanupOwnedGroup = (reason = 'terminated') => {
    if (cleanupStarted) {
      return;
    }
    cleanupStarted = true;
    try {
      recordStatus(null, 'SIGTERM', reason);
    } catch {
      fail();
    }
    try {
      process.kill(-process.pid, 'SIGTERM');
    } catch {
      fail();
      return;
    }
    setTimeout(() => {
      try {
        process.kill(-process.pid, 'SIGKILL');
      } catch {
        fail();
      }
    }, terminationGraceMs);
  };
  child.once('error', () => {
    try {
      recordStatus(null, null, 'spawn');
    } finally {
      killOwnedGroupNow();
    }
  });
  child.once('exit', (code, signal) => {
    if (timeoutHandle !== undefined) {
      clearTimeout(timeoutHandle);
    }
    try {
      recordStatus(code, signal, 'exit');
    } finally {
      killOwnedGroupNow();
    }
  });
  process.on('SIGTERM', () => cleanupOwnedGroup());
  process.on('SIGINT', () => cleanupOwnedGroup());
  if (timeoutMs !== undefined) {
    timeoutHandle = setTimeout(() => cleanupOwnedGroup('timeout'), timeoutMs);
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch {
    fail();
  }
}
