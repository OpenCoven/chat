import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { prepareMacosKeychainSession } from '../scripts/phase1-macos-keychain.mjs';

const scratchRoots: string[] = [];

function scratchRoot() {
  const root = mkdtempSync(resolve(tmpdir(), 'phase1-macos-keychain-'));
  scratchRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of scratchRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('macOS schema-v2 Keychain runner', () => {
  test('creates, verifies, probes, and deletes a keychain inside the isolated home', () => {
    const root = scratchRoot();
    const home = resolve(root, 'home');
    mkdirSync(home, { mode: 0o700 });
    const keychainPath = resolve(home, 'Library', 'Keychains', 'phase1.keychain-db');
    const execute = vi.fn((_command: string, args: string[]) => {
      if (args[0] === 'create-keychain') {
        writeFileSync(keychainPath, '', { mode: 0o600 });
      }
      if (args[0] === 'delete-keychain') {
        unlinkSync(keychainPath);
      }
      if (args[0] === 'default-keychain' || args[0] === 'list-keychains') {
        return `    "${keychainPath}"\n`;
      }
      return args[0] === 'find-generic-password' ? `${'1'.repeat(64)}\n` : '';
    });

    const session = prepareMacosKeychainSession({
      home,
      platform: 'darwin',
      execute,
      randomHex: () => '1'.repeat(64),
    });

    expect(session).toEqual({
      backend: 'macos-keychain',
      home,
      keychainPath,
      close: expect.any(Function),
    });
    expect(execute.mock.calls).toEqual([
      ['/usr/bin/security', ['create-keychain', '-p', '1'.repeat(64), keychainPath], home],
      ['/usr/bin/security', ['set-keychain-settings', '-lut', '7200', keychainPath], home],
      ['/usr/bin/security', ['unlock-keychain', '-p', '1'.repeat(64), keychainPath], home],
      ['/usr/bin/security', ['default-keychain', '-d', 'user', '-s', keychainPath], home],
      ['/usr/bin/security', ['list-keychains', '-d', 'user', '-s', keychainPath], home],
      ['/usr/bin/security', ['default-keychain', '-d', 'user'], home],
      ['/usr/bin/security', ['list-keychains', '-d', 'user'], home],
      [
        '/usr/bin/security',
        [
          'add-generic-password',
          '-a',
          'phase1-probe',
          '-s',
          'ai.opencoven.chat.phase1.probe',
          '-w',
          '1'.repeat(64),
          keychainPath,
        ],
        home,
      ],
      [
        '/usr/bin/security',
        [
          'find-generic-password',
          '-a',
          'phase1-probe',
          '-s',
          'ai.opencoven.chat.phase1.probe',
          '-w',
          keychainPath,
        ],
        home,
      ],
      [
        '/usr/bin/security',
        [
          'delete-generic-password',
          '-a',
          'phase1-probe',
          '-s',
          'ai.opencoven.chat.phase1.probe',
          keychainPath,
        ],
        home,
      ],
    ]);

    session.close();
    expect(execute).toHaveBeenLastCalledWith(
      '/usr/bin/security',
      ['delete-keychain', keychainPath],
      home,
    );
  });

  test('rejects unsupported platforms and keychain verification drift', () => {
    const root = scratchRoot();
    const home = resolve(root, 'home');
    mkdirSync(home, { mode: 0o700 });

    expect(() =>
      prepareMacosKeychainSession({
        home,
        platform: 'linux',
        execute: vi.fn(),
        randomHex: () => '1'.repeat(64),
      }),
    ).toThrow(/only on macOS/u);

    expect(() =>
      prepareMacosKeychainSession({
        home,
        platform: 'darwin',
        execute: vi.fn((_command: string, args: string[]) =>
          args[0] === 'find-generic-password'
            ? 'probe-secret\n'
            : args[0] === 'default-keychain' || args[0] === 'list-keychains'
              ? '"/operator/login.keychain-db"\n'
              : '',
        ),
        randomHex: () => '1'.repeat(64),
      }),
    ).toThrow(/isolated default Keychain/u);
  });
});
