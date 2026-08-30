import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  curateLinuxSecretServiceEnvironment,
  linuxSecretServicePackageCommands,
} from '../scripts/phase1-linux-secret-service.mjs';

const scratchRoots: string[] = [];

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Linux schema-v2 Secret Service runner', () => {
  test('pins and verifies the exact Ubuntu 24.04 provider packages', () => {
    expect(linuxSecretServicePackageCommands()).toEqual([
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
          'dbus-daemon=1.14.10-4ubuntu4.1',
          'gnome-keyring=46.1-2ubuntu0.2',
          'libsecret-tools=0.21.4-1build3',
        ],
      },
    ]);
  });

  test('forwards only a validated private runtime directory and Unix session bus', () => {
    const runtimeRoot = mkdtempSync(resolve(tmpdir(), 'phase1-dbus-env-'));
    scratchRoots.push(runtimeRoot);
    const environment = curateLinuxSecretServiceEnvironment(
      {
        PATH: '/trusted/bin',
        HOME: '/operator/home',
        DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/private-bus',
        XDG_RUNTIME_DIR: runtimeRoot,
        GNOME_KEYRING_CONTROL: '/private/control',
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'token',
      },
      runtimeRoot,
    );

    expect(environment).toEqual({
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/private-bus',
      XDG_RUNTIME_DIR: runtimeRoot,
    });
  });

  test('rejects missing, non-Unix, or non-private session metadata', () => {
    const runtimeRoot = mkdtempSync(resolve(tmpdir(), 'phase1-dbus-env-'));
    scratchRoots.push(runtimeRoot);
    expect(() =>
      curateLinuxSecretServiceEnvironment(
        { DBUS_SESSION_BUS_ADDRESS: '', XDG_RUNTIME_DIR: runtimeRoot },
        runtimeRoot,
      ),
    ).toThrow(/session bus/u);
    expect(() =>
      curateLinuxSecretServiceEnvironment(
        {
          DBUS_SESSION_BUS_ADDRESS: 'tcp:host=127.0.0.1',
          XDG_RUNTIME_DIR: runtimeRoot,
        },
        runtimeRoot,
      ),
    ).toThrow(/session bus/u);
    expect(() =>
      curateLinuxSecretServiceEnvironment(
        {
          DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/private-bus',
          XDG_RUNTIME_DIR: '/tmp/not-the-owned-root',
        },
        runtimeRoot,
      ),
    ).toThrow(/runtime directory/u);
  });
});
