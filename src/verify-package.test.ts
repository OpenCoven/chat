import { describe, expect, it } from 'vitest';

// @ts-expect-error Executable scripts intentionally have no declaration files.
import { readPackage, verifyPackage } from '../scripts/verify-package.mjs';

// biome-ignore lint/suspicious/noExplicitAny: the fixture mutates arbitrary parts of real config JSON.
type Json = any;
type Input = { conf: Json; capability: Json; cargo: string; exists: (path: string) => boolean };

function actual(): Input {
  return readPackage(process.cwd());
}

function mutated(change: (input: Input) => void): Input {
  const input = actual();
  const copy: Input = {
    conf: structuredClone(input.conf),
    capability: structuredClone(input.capability),
    cargo: input.cargo,
    exists: input.exists,
  };
  change(copy);
  return copy;
}

describe('verify-package', () => {
  it('passes the package as declared, with the open decisions only pending', () => {
    const { failures, pending } = verifyPackage(actual());
    expect(failures).toEqual([]);
    expect(pending.join('\n')).toMatch(/Updater/);
    expect(pending.join('\n')).toMatch(/opencoven-chat/);
  });

  it.each([
    [
      'a renamed product',
      (i: Input) => {
        i.conf.productName = 'Chat';
      },
      /productName/,
    ],
    [
      'a changed identifier',
      (i: Input) => {
        i.conf.identifier = 'com.example.chat';
      },
      /identifier/,
    ],
    [
      'a smaller minimum window',
      (i: Input) => {
        i.conf.app.windows[0].minWidth = 320;
      },
      /minimum window/,
    ],
    [
      'a second window',
      (i: Input) => i.conf.app.windows.push({ label: 'extra' }),
      /exactly one window/,
    ],
    [
      'the global Tauri object',
      (i: Input) => {
        i.conf.app.withGlobalTauri = true;
      },
      /withGlobalTauri/,
    ],
    [
      'unsafe-eval in the CSP',
      (i: Input) => {
        i.conf.app.security.csp = i.conf.app.security.csp.replace(
          "script-src 'self'",
          "script-src 'self' 'unsafe-eval'",
        );
      },
      /script-src|unsafe-eval/,
    ],
    [
      'a network origin in connect-src',
      (i: Input) => {
        i.conf.app.security.csp = i.conf.app.security.csp.replace(
          'connect-src',
          'connect-src https://example.com',
        );
      },
      /connect-src allows https:\/\/example.com/,
    ],
    [
      'a dropped installer target',
      (i: Input) => {
        i.conf.bundle.targets = ['app'];
      },
      /Installer target dmg/,
    ],
    [
      'a missing icon file',
      (i: Input) => {
        i.exists = (path) => path !== 'icons/icon.ico';
      },
      /icon.ico is declared but missing/,
    ],
    [
      'a shell permission',
      (i: Input) => i.capability.permissions.push('shell:allow-execute'),
      /grants shell:allow-execute/,
    ],
    [
      'an unreviewed core permission',
      (i: Input) => i.capability.permissions.push('core:window:allow-close'),
      /unreviewed core:window:allow-close/,
    ],
    [
      'a remote origin',
      (i: Input) => {
        i.capability.remote = { urls: ['https://example.com'] };
      },
      /remote origins/,
    ],
    [
      'a filesystem plugin',
      (i: Input) => {
        i.cargo += '\ntauri-plugin-fs = "2"\n';
      },
      /tauri-plugin-fs/,
    ],
  ])('fails on %s', (_name, change, message) => {
    const { failures } = verifyPackage(mutated(change));
    expect(failures.join('\n')).toMatch(message);
  });

  it('treats a decided updater and protocol as no longer pending', () => {
    const { pending } = verifyPackage(
      mutated((i) => {
        i.conf.bundle.createUpdaterArtifacts = true;
        i.conf.plugins = {
          updater: { pubkey: 'dW50cnVzdGVkIGNvbW1lbnQ=', endpoints: [] },
          'deep-link': { desktop: { schemes: ['opencoven-chat'] } },
        };
      }),
    );
    expect(pending).toEqual([]);
  });
});
