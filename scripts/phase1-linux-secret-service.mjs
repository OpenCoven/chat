#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';

const PACKAGE_VERSIONS = Object.freeze({
  'dbus-daemon': '1.14.10-4ubuntu4.1',
  'gnome-keyring': '46.1-2ubuntu0.2',
  'libsecret-tools': '0.21.4-1build3',
});

export function linuxSecretServicePackageCommands() {
  return [
    {
      command: 'sudo',
      args: [
        'apt-get',
        'update',
        '-o',
        'Acquire::Retries=2',
        '-o',
        'Acquire::http::Timeout=20',
        '-o',
        'Acquire::https::Timeout=20',
      ],
    },
    {
      command: 'sudo',
      args: [
        'apt-get',
        'install',
        '--yes',
        '--no-install-recommends',
        ...Object.entries(PACKAGE_VERSIONS).map(([name, version]) => `${name}=${version}`),
      ],
    },
  ];
}

export function curateLinuxSecretServiceEnvironment(environment, expectedRuntimeRoot) {
  if (typeof expectedRuntimeRoot !== 'string' || expectedRuntimeRoot.length === 0) {
    throw new Error('Linux Secret Service runtime directory is required.');
  }
  const bus = environment?.DBUS_SESSION_BUS_ADDRESS;
  if (typeof bus !== 'string' || !bus.startsWith('unix:') || bus.length > 4096) {
    throw new Error('Linux Secret Service requires a bounded Unix session bus address.');
  }
  const runtimeRoot = environment?.XDG_RUNTIME_DIR;
  let expectedRoot;
  let actualRoot;
  let stats;
  try {
    expectedRoot = realpathSync(resolve(expectedRuntimeRoot));
    actualRoot = typeof runtimeRoot === 'string' ? realpathSync(resolve(runtimeRoot)) : undefined;
    stats = lstatSync(expectedRoot);
  } catch {
    throw new Error('Linux Secret Service runtime directory is not the owned private root.');
  }
  if (
    actualRoot !== expectedRoot ||
    stats.isSymbolicLink() ||
    !stats.isDirectory() ||
    (stats.mode & 0o777) !== 0o700
  ) {
    throw new Error('Linux Secret Service runtime directory is not the owned private root.');
  }
  return {
    DBUS_SESSION_BUS_ADDRESS: bus,
    XDG_RUNTIME_DIR: runtimeRoot,
  };
}

function runChecked(command, args) {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      ![
        'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
        'ACTIONS_ID_TOKEN_REQUEST_URL',
        'GH_TOKEN',
        'GITHUB_TOKEN',
      ].includes(key.toUpperCase())
    ) {
      environment[key] = value;
    }
  }
  return execFileSync(command, args, {
    encoding: 'utf8',
    env: environment,
    maxBuffer: 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 180_000,
    killSignal: 'SIGKILL',
  });
}

export function installLinuxSecretService() {
  if (process.platform !== 'linux') {
    throw new Error('Linux Secret Service packages may be installed only on Linux.');
  }
  const [update, install] = linuxSecretServicePackageCommands();
  runChecked(update.command, update.args);
  for (const [name, expected] of Object.entries(PACKAGE_VERSIONS)) {
    const policy = runChecked('apt-cache', ['policy', name]);
    const candidate = /^\s*Candidate:\s*(\S+)\s*$/mu.exec(policy)?.[1];
    if (candidate !== expected) {
      throw new Error(`Linux Secret Service package ${name} does not match its frozen version.`);
    }
  }
  runChecked(install.command, install.args);
  for (const [name, expected] of Object.entries(PACKAGE_VERSIONS)) {
    const installed = runChecked('dpkg-query', ['-W', '-f=$' + '{Version}', name]).trim();
    if (installed !== expected) {
      throw new Error(`Linux Secret Service package ${name} was not installed exactly.`);
    }
  }
  for (const command of ['dbus-run-session', 'dbus-send', 'gnome-keyring-daemon', 'secret-tool']) {
    runChecked('/usr/bin/which', [command]);
  }
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && argv[0] === '--install') {
    installLinuxSecretService();
    return;
  }
  throw new Error('usage: phase1-linux-secret-service.mjs --install');
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    main();
  } catch {
    process.stderr.write('phase1-linux-secret-service: failed\n');
    process.exitCode = 1;
  }
}
