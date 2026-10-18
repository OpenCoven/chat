import { describe, expect, it } from 'vitest';

// @ts-expect-error Executable scripts intentionally have no declaration files.
import { isMinisignPublicKey, readPackage, verifyPackage } from '../scripts/verify-package.mjs';

// biome-ignore lint/suspicious/noExplicitAny: the fixture mutates arbitrary parts of real config JSON.
type Json = any;
type Input = {
  conf: Json;
  capabilities: Record<string, Json>;
  cargo: string;
  exists: (path: string) => boolean;
};

function actual(): Input {
  return readPackage(process.cwd());
}

function mutated(change: (input: Input) => void): Input {
  const input = actual();
  const copy: Input = {
    conf: structuredClone(input.conf),
    capabilities: structuredClone(input.capabilities),
    cargo: input.cargo,
    exists: input.exists,
  };
  change(copy);
  return copy;
}

describe('verify-package', () => {
  it('passes the package as declared', () => {
    expect(verifyPackage(actual()).failures).toEqual([]);
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
      'a repeated, permissive connect-src ahead of a strict one',
      (i: Input) => {
        i.conf.app.security.csp = `connect-src https://example.com; ${i.conf.app.security.csp}`;
      },
      /repeats connect-src/,
    ],
    [
      'no connect-src at all',
      (i: Input) => {
        i.conf.app.security.csp = i.conf.app.security.csp.replace(/connect-src[^;]*;\s*/, '');
      },
      /must declare connect-src/,
    ],
    [
      'an extra capability file',
      (i: Input) => {
        i.capabilities['extra.json'] = { windows: ['main'], permissions: ['shell:default'] };
      },
      /Unexpected capability file extra.json/,
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
      (i: Input) => i.capabilities['default.json'].permissions.push('shell:allow-execute'),
      /grants shell:allow-execute/,
    ],
    [
      'an unreviewed core permission',
      (i: Input) => i.capabilities['default.json'].permissions.push('core:window:allow-close'),
      /unreviewed core:window:allow-close/,
    ],
    [
      'a remote origin',
      (i: Input) => {
        i.capabilities['default.json'].remote = { urls: ['https://example.com'] };
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

  // A well-formed minisign public key that signs nothing: the shape the
  // verifier accepts, without being anyone's real key.
  const SHAPED_KEY = Buffer.from(
    `untrusted comment: minisign public key: 0123456789ABCDEF\nRW${'A'.repeat(54)}\n`,
  ).toString('base64');

  it('recognises a minisign public key and nothing else', () => {
    expect(isMinisignPublicKey(SHAPED_KEY)).toBe(true);
    expect(isMinisignPublicKey('key')).toBe(false);
    expect(
      isMinisignPublicKey(Buffer.from('untrusted comment: x\nRWshort').toString('base64')),
    ).toBe(false);
  });

  it.each([
    [
      'updater artifacts turned on in the base config',
      (i: Input) => {
        i.conf.bundle.createUpdaterArtifacts = true;
      },
      /createUpdaterArtifacts must stay false/,
    ],
    [
      'no updater config',
      (i: Input) => {
        delete i.conf.plugins.updater;
      },
      /plugins.updater is missing/,
    ],
    [
      'a key that is not a minisign key',
      (i: Input) => {
        i.conf.plugins.updater.pubkey = 'key';
      },
      /not a minisign public key/,
    ],
    [
      'another feed',
      (i: Input) => {
        i.conf.plugins.updater.endpoints = [
          'https://github.com/OpenCoven/chat/releases/latest/download/latest.json',
        ];
      },
      /endpoints must be exactly/,
    ],
    [
      'insecure transport',
      (i: Input) => {
        i.conf.plugins.updater.dangerousInsecureTransportProtocol = true;
      },
      /insecure transport/,
    ],
    [
      'an interactive Windows install',
      (i: Input) => {
        i.conf.plugins.updater.windows = { installMode: 'basicUi' };
      },
      /installMode must be passive/,
    ],
    [
      'a loose crate version',
      (i: Input) => {
        i.cargo = i.cargo.replace(/^tauri-plugin-updater = .*$/m, 'tauri-plugin-updater = "2"');
      },
      /pin tauri-plugin-updater/,
    ],
  ])('holds the amended updater decision against %s', (_name, change, message) => {
    const { failures } = verifyPackage(
      mutated((i) => {
        i.conf.plugins.updater.pubkey = SHAPED_KEY;
        change(i);
      }),
    );
    expect(failures.join('\n')).toMatch(message);
  });

  it('accepts the updater as configured once its key is a minisign key', () => {
    const { failures } = verifyPackage(
      mutated((i) => {
        i.conf.plugins.updater.pubkey = SHAPED_KEY;
      }),
    );
    expect(failures).toEqual([]);
  });

  it.each([
    [
      'a deep-link scheme',
      (i: Input) => {
        i.conf.plugins['deep-link'] = { desktop: { schemes: ['opencoven-chat'] } };
      },
    ],
    [
      'the deep-link crate',
      (i: Input) => {
        i.cargo += '\ntauri-plugin-deep-link = "2"\n';
      },
    ],
  ])('holds the v0.0.1 decision of no protocol against %s', (_name, change) => {
    expect(verifyPackage(mutated(change)).failures.join('\n')).toMatch(/no deep-link protocol/);
  });
});
