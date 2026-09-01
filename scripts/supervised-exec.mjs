import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveExecutableInvocation } from './executable-resolution.mjs';
import { cleanupOwnedTempRoot, createOwnedTempDirectory } from './owned-temp-directory.mjs';
import { parseSupervisorStatusFrame } from './supervisor-status.mjs';

const scriptsRoot = dirname(fileURLToPath(import.meta.url));
const nodeSupervisor = resolve(scriptsRoot, 'phase1-process-supervisor.mjs');
let windowsSupervisor;

export function configureSupervisedExecution(options = {}) {
  windowsSupervisor = options.windowsSupervisor;
}

export function runSupervisedSync(command, args, options = {}) {
  const owned = createOwnedTempDirectory({ prefix: `phase1-sync-${randomUUID()}` });
  const windows = process.platform === 'win32';
  if (windows && typeof windowsSupervisor !== 'string') {
    cleanupOwnedTempRoot(owned);
    throw new Error('Windows supervised execution is not configured.');
  }
  try {
    const invocation = resolveExecutableInvocation(
      command,
      options.env === undefined ? process.env : options.env,
      process.platform,
      args,
    );
    const result = spawnSync(
      windows ? windowsSupervisor : process.execPath,
      windows
        ? ['--', invocation.executable, ...invocation.args]
        : [
            nodeSupervisor,
            '--timeout-ms',
            String(options.timeout ?? 30_000),
            '--invocation-path',
            invocation.executable,
            '--',
            invocation.resolvedCommand,
            ...invocation.args,
          ],
      {
        ...options,
        detached: !windows,
        env: options.env === undefined ? process.env : options.env,
        encoding: options.encoding,
        input: options.input,
        killSignal: 'SIGTERM',
        maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
        stdio: windows ? options.stdio : ['pipe', 'pipe', 'pipe', 'pipe'],
        timeout: windows ? (options.timeout ?? 30_000) : (options.timeout ?? 30_000) + 5_000,
      },
    );
    if (result.error !== undefined) {
      throw result.error;
    }
    if (windows) {
      if (result.status !== 0) {
        throw new Error('Supervised command failed.');
      }
    } else {
      const status = parseSupervisorStatusFrame(result.output?.[3] ?? '');
      if (
        result.status !== null ||
        result.signal !== 'SIGKILL' ||
        status.reason !== 'exit' ||
        status.code !== 0 ||
        status.signal !== null
      ) {
        const error = new Error('Supervised command failed.');
        if (status.reason === 'timeout') {
          error.code = 'ETIMEDOUT';
        }
        throw error;
      }
    }
    return result.stdout;
  } finally {
    cleanupOwnedTempRoot(owned);
  }
}
