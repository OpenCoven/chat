import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = resolve(projectRoot, 'scripts', 'coven-scratch-homes.mjs');

// Each test gets a stand-in "real" home with an engine selection in it, so
// nothing here reads or writes the machine's own ~/.coven.
let realHome: string;
let currentPath: string;

beforeEach(() => {
  realHome = mkdtempSync(join(tmpdir(), 'scratch-homes-test-'));
  mkdirSync(join(realHome, '.coven', 'engine', '0.9.1'), { recursive: true });
  currentPath = join(realHome, '.coven', 'engine', 'current');
  writeFileSync(currentPath, '0.9.1');
});

afterEach(() => {
  rmSync(realHome, { recursive: true, force: true });
});

function run(code: string, options: string[] = [], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script, ...options, '--', process.execPath, '-e', code], {
    encoding: 'utf8',
    env: { ...process.env, HOME: realHome, ...env },
  });
}

describe('coven-scratch-homes', () => {
  test('runs the command under scratch homes and leaves the real engine selection alone', () => {
    const result = run(
      `const fs = require('node:fs');
       const env = process.env;
       const out = { HOME: env.HOME, COVEN_HOME: env.COVEN_HOME, COVEN_CODE_HOME: env.COVEN_CODE_HOME, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME };
       // What an engine install does to whichever HOME it is given.
       fs.mkdirSync(env.HOME + '/.coven/engine/0.9.2', { recursive: true });
       fs.writeFileSync(env.HOME + '/.coven/engine/current', '0.9.2');
       console.log(JSON.stringify(out));`,
      ['--keep'],
    );
    expect(result.status).toBe(0);
    const homes = JSON.parse(result.stdout.trim());
    for (const name of ['HOME', 'COVEN_HOME', 'COVEN_CODE_HOME', 'XDG_CONFIG_HOME']) {
      expect(homes[name]).toBeTruthy();
      expect(homes[name].startsWith(realHome)).toBe(false);
    }
    expect(homes.XDG_CONFIG_HOME.startsWith(homes.HOME)).toBe(true);
    expect(readFileSync(currentPath, 'utf8')).toBe('0.9.1');
    expect(readFileSync(join(homes.HOME, '.coven', 'engine', 'current'), 'utf8')).toBe('0.9.2');
    expect(result.stderr).toContain(
      `real home ${realHome}: current "0.9.1"; entries 0.9.1, current`,
    );
    rmSync(dirname(homes.HOME), { recursive: true, force: true });
  });

  test('removes the scratch folder afterwards unless asked to keep it', () => {
    const result = run('console.log(process.env.HOME)');
    expect(result.status).toBe(0);
    expect(existsSync(result.stdout.trim())).toBe(false);
  });

  test('fails loudly when the command changes the real engine selection', () => {
    const result = run(`require('node:fs').writeFileSync(process.env.REAL_CURRENT, '0.9.2')`, [], {
      REAL_CURRENT: currentPath,
    });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('ERROR: the command changed the real engine selection.');
    expect(result.stderr).toContain('before: current "0.9.1"');
    expect(result.stderr).toContain('after:  current "0.9.2"');
  });

  test('fails when the command adds an engine to the real home', () => {
    const result = run(`require('node:fs').mkdirSync(process.env.REAL_ENGINE + '/0.9.2')`, [], {
      REAL_ENGINE: dirname(currentPath),
    });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('after:  current "0.9.1"; entries 0.9.1, 0.9.2, current');
  });

  test("passes a failing command's exit status through", () => {
    const result = run('process.exit(7)');
    expect(result.status).toBe(7);
    expect(result.stderr).not.toContain('ERROR');
  });

  test('refuses to run without a command', () => {
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...process.env, HOME: realHome },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no command given');
  });
});
