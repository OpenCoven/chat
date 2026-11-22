import { spawn, spawnSync } from 'node:child_process';
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
// Scratch folders a test asked the wrapper to keep, removed even when an
// assertion fails.
let kept: string[] = [];

beforeEach(() => {
  realHome = mkdtempSync(join(tmpdir(), 'scratch-homes-test-'));
  mkdirSync(join(realHome, '.coven', 'engine', '0.9.1'), { recursive: true });
  currentPath = join(realHome, '.coven', 'engine', 'current');
  writeFileSync(currentPath, '0.9.1');
});

afterEach(() => {
  rmSync(realHome, { recursive: true, force: true });
  for (const dir of kept) rmSync(dir, { recursive: true, force: true });
  kept = [];
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
    const homes = JSON.parse(result.stdout.trim());
    kept.push(dirname(homes.HOME));
    expect(result.status).toBe(0);
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

  test('reports a current that the command turns into a link to a folder', () => {
    const result = run(
      `const fs = require('node:fs');
       const engine = process.env.REAL_ENGINE;
       fs.mkdirSync(engine + '/0.9.2');
       fs.rmSync(engine + '/current');
       fs.symlinkSync(engine + '/0.9.2', engine + '/current');
       console.log(process.env.HOME);`,
      [],
      { REAL_ENGINE: dirname(currentPath) },
    );
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('after:  current (a link to');
    expect(result.stderr).not.toContain('    at ');
    expect(existsSync(result.stdout.trim())).toBe(false);
  });

  test('ignores dotfiles such as .DS_Store in the engine folder', () => {
    const result = run(
      `require('node:fs').writeFileSync(process.env.REAL_ENGINE + '/.DS_Store', '')`,
      [],
      { REAL_ENGINE: dirname(currentPath) },
    );
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain('ERROR');
  });

  test("passes a failing command's exit status through", () => {
    const result = run('process.exit(7)');
    expect(result.status).toBe(7);
    expect(result.stderr).not.toContain('ERROR');
  });

  // A terminal sends Ctrl-C to the whole foreground process group, so the
  // wrapper and the command both get it. The wrapper starts in its own group
  // here, and the signal goes to that group.
  describe.skipIf(process.platform === 'win32')(
    'when a signal arrives while the command runs',
    () => {
      // The command prints its scratch HOME, then, on the signal, changes the
      // real engine selection and exits 0, as an install that finishes its write
      // after Ctrl-C would.
      const ignoresSignal = (signal: string) =>
        `const fs = require('node:fs');
       let seen = false;
       process.on('${signal}', () => {
         if (seen) return;
         seen = true;
         setTimeout(() => { fs.writeFileSync(process.env.REAL_CURRENT, '0.9.2'); process.exit(0); }, 100);
       });
       console.log(process.env.HOME);
       setInterval(() => {}, 1000);`;

      async function runAndSignal(signal: NodeJS.Signals, target: 'group' | 'wrapper') {
        const child = spawn(
          process.execPath,
          [script, '--', process.execPath, '-e', ignoresSignal(signal)],
          {
            detached: true,
            env: { ...process.env, HOME: realHome, REAL_CURRENT: currentPath },
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let stdout = '';
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolveClose) => child.on('close', (code, signal) => resolveClose({ code, signal })),
        );
        try {
          const scratchHome = await new Promise<string>((resolveHome, rejectHome) => {
            child.stdout.on('data', (chunk) => {
              stdout += chunk;
              const [line] = stdout.split('\n');
              if (stdout.includes('\n') && line !== undefined) resolveHome(line.trim());
            });
            child.on('error', rejectHome);
            closed.then(() => rejectHome(new Error(`wrapper exited early: ${stderr}`)));
          });
          if (!child.pid) throw new Error('wrapper has no pid');
          process.kill(target === 'group' ? -child.pid : child.pid, signal);
          const exit = await closed;
          return { ...exit, stderr, scratchRoot: dirname(scratchHome) };
        } finally {
          try {
            if (child.pid) process.kill(-child.pid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
      }

      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        test(`still checks the engine and cleans up after ${signal}`, async () => {
          const result = await runAndSignal(signal, 'group');
          expect(readFileSync(currentPath, 'utf8')).toBe('0.9.2');
          expect(result.signal).toBeNull();
          expect(result.code).toBe(3);
          expect(result.stderr).toContain('ERROR: the command changed the real engine selection.');
          expect(result.stderr).toContain('after:  current "0.9.2"');
          expect(existsSync(result.scratchRoot)).toBe(false);
        });
      }

      test('passes a SIGTERM sent to the wrapper alone on to the command', async () => {
        const result = await runAndSignal('SIGTERM', 'wrapper');
        expect(result.code).toBe(3);
        expect(result.stderr).toContain('after:  current "0.9.2"');
        expect(existsSync(result.scratchRoot)).toBe(false);
      });
    },
  );

  test('refuses to run without a command', () => {
    const result = spawnSync(process.execPath, [script], {
      encoding: 'utf8',
      env: { ...process.env, HOME: realHome },
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('no command given');
  });
});
