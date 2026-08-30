#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SECURITY_PATH = '/usr/bin/security';
const KEYCHAIN_NAME = 'phase1.keychain-db';
const PROBE_ACCOUNT = 'phase1-probe';
const PROBE_SERVICE = 'ai.opencoven.chat.phase1.probe';
const secretPattern = /^[0-9a-f]{64}$/u;

function runSecurity(command, args, home) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    env: {
      HOME: home,
      LANG: 'C',
      PATH: '/usr/bin:/bin',
    },
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    killSignal: 'SIGKILL',
  });
}

function listedKeychains(output) {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim().replace(/^"|"$/gu, ''))
    .filter(Boolean);
}

function canonicalExistingPath(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function prepareMacosKeychainSession({
  home,
  platform = process.platform,
  execute = runSecurity,
  randomHex = () => randomBytes(32).toString('hex'),
}) {
  if (platform !== 'darwin') {
    throw new Error('The isolated macOS Keychain session is available only on macOS.');
  }
  if (typeof home !== 'string' || home.length === 0) {
    throw new Error('The isolated macOS Keychain home is required.');
  }
  const isolatedHome = resolve(home);
  const preferencesRoot = resolve(isolatedHome, 'Library', 'Preferences');
  const keychainsRoot = resolve(isolatedHome, 'Library', 'Keychains');
  for (const path of [isolatedHome, dirname(preferencesRoot), preferencesRoot, keychainsRoot]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }
  const keychainPath = resolve(keychainsRoot, KEYCHAIN_NAME);
  const password = randomHex();
  const probeSecret = randomHex();
  if (!secretPattern.test(password) || !secretPattern.test(probeSecret)) {
    throw new Error('The isolated macOS Keychain secrets were not generated canonically.');
  }

  let created = false;
  try {
    execute(SECURITY_PATH, ['create-keychain', '-p', password, keychainPath], isolatedHome);
    created = true;
    execute(SECURITY_PATH, ['set-keychain-settings', '-lut', '7200', keychainPath], isolatedHome);
    execute(SECURITY_PATH, ['unlock-keychain', '-p', password, keychainPath], isolatedHome);
    execute(SECURITY_PATH, ['default-keychain', '-d', 'user', '-s', keychainPath], isolatedHome);
    execute(SECURITY_PATH, ['list-keychains', '-d', 'user', '-s', keychainPath], isolatedHome);

    const expectedPath = canonicalExistingPath(keychainPath);
    const defaults = listedKeychains(
      execute(SECURITY_PATH, ['default-keychain', '-d', 'user'], isolatedHome),
    );
    const searchList = listedKeychains(
      execute(SECURITY_PATH, ['list-keychains', '-d', 'user'], isolatedHome),
    );
    if (
      defaults.length !== 1 ||
      searchList.length !== 1 ||
      canonicalExistingPath(defaults[0]) !== expectedPath ||
      canonicalExistingPath(searchList[0]) !== expectedPath
    ) {
      throw new Error('macOS did not select the isolated default Keychain.');
    }

    const stats = lstatSync(keychainPath);
    if (
      stats.isSymbolicLink() ||
      !stats.isFile() ||
      (stats.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && stats.uid !== process.getuid())
    ) {
      throw new Error('The isolated macOS Keychain is not a private owned regular file.');
    }
    execute(
      SECURITY_PATH,
      [
        'add-generic-password',
        '-a',
        PROBE_ACCOUNT,
        '-s',
        PROBE_SERVICE,
        '-w',
        probeSecret,
        keychainPath,
      ],
      isolatedHome,
    );
    const observedProbe = execute(
      SECURITY_PATH,
      ['find-generic-password', '-a', PROBE_ACCOUNT, '-s', PROBE_SERVICE, '-w', keychainPath],
      isolatedHome,
    ).trim();
    if (observedProbe !== probeSecret) {
      throw new Error('The isolated macOS Keychain probe did not round trip.');
    }
    execute(
      SECURITY_PATH,
      ['delete-generic-password', '-a', PROBE_ACCOUNT, '-s', PROBE_SERVICE, keychainPath],
      isolatedHome,
    );
  } catch (error) {
    if (created) {
      try {
        execute(SECURITY_PATH, ['delete-keychain', keychainPath], isolatedHome);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'The isolated macOS Keychain setup and cleanup both failed.',
        );
      }
    }
    throw error;
  }

  let closed = false;
  return {
    backend: 'macos-keychain',
    home: isolatedHome,
    keychainPath,
    close() {
      if (closed) {
        return;
      }
      execute(SECURITY_PATH, ['delete-keychain', keychainPath], isolatedHome);
      if (existsSync(keychainPath)) {
        throw new Error('The isolated macOS Keychain was not deleted.');
      }
      closed = true;
    },
  };
}
