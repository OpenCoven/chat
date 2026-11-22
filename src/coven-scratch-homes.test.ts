import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
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
// Scratch folders a test kept or saw, and process groups it started; all are
// removed or killed even when an assertion fails or the test times out.
let kept: string[] = [];
let groups: ChildProcess[] = [];

beforeEach(() => {
  realHome = mkdtempSync(join(tmpdir(), 'scratch-homes-test-'));
  mkdirSync(join(realHome, '.coven', 'engine', '0.9.1'), { recursive: true });
  currentPath = join(realHome, '.coven', 'engine', 'current');
  writeFileSync(currentPath, '0.9.1');
});

afterEach(() => {
  for (const child of groups) {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
    } catch {
      // Already gone.
    }
  }
  groups = [];
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
  // wrapper and the command both get it. Each wrapper here starts in its own
  // group, and signals go to that group.
  describe.skipIf(process.platform === 'win32')(
    'when a signal arrives while the command runs',
    () => {
      const signalTimeout = 60_000;

      // Starts the wrapper (or a shell that calls it) in its own process group.
      // afterEach kills the group and removes the scratch folder, even when a
      // test times out.
      function start(argv: string[], env: Record<string, string> = {}) {
        const child = spawn(argv[0] as string, argv.slice(1), {
          detached: true,
          env: { ...process.env, HOME: realHome, REAL_CURRENT: currentPath, ...env },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        groups.push(child);
        const output = { stdout: '', stderr: '' };
        const waiters: Array<() => void> = [];
        const notify = () => {
          for (const waiter of [...waiters]) waiter();
        };
        child.stdout?.on('data', (chunk) => {
          output.stdout += chunk;
          notify();
        });
        child.stderr?.on('data', (chunk) => {
          output.stderr += chunk;
          for (const match of output.stderr.matchAll(/HOME=(\S+)\/home\n/gu))
            if (match[1] && !kept.includes(match[1])) kept.push(match[1]);
          notify();
        });
        const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolveClose) => child.on('close', (code, signal) => resolveClose({ code, signal })),
        );
        // Resolves once `stream` contains `text`; fails if the process ends first.
        const waitFor = (stream: 'stdout' | 'stderr', text: string) =>
          new Promise<void>((resolveWait, rejectWait) => {
            const check = () => {
              if (output[stream].includes(text)) {
                waiters.splice(waiters.indexOf(check), 1);
                resolveWait();
              }
            };
            waiters.push(check);
            check();
            closed.then(() =>
              rejectWait(new Error(`exited before ${stream} showed ${text}: ${output.stderr}`)),
            );
          });
        const signalGroup = (signal: NodeJS.Signals) => {
          if (!child.pid) throw new Error('no pid');
          process.kill(-child.pid, signal);
        };
        return { child, output, closed, waitFor, signalGroup };
      }

      const wrapper = (code: string) => [
        process.execPath,
        script,
        '--',
        process.execPath,
        '-e',
        code,
      ];

      // The command counts the signals it gets into COUNT_FILE. On the first it
      // waits a while (so a second delivery would be counted), then changes the
      // real engine selection and exits 0, as an install that finishes its
      // write after Ctrl-C would.
      const finishesAfter = (signal: string) =>
        `const fs = require('node:fs');
         let count = 0;
         process.on('${signal}', () => {
           count += 1;
           fs.writeFileSync(process.env.COUNT_FILE, String(count));
           if (count > 1) return;
           setTimeout(() => { fs.writeFileSync(process.env.REAL_CURRENT, '0.9.2'); process.exit(0); }, 500);
         });
         console.log('ready');
         setInterval(() => {}, 1000);`;

      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        test(
          `still checks the engine and cleans up after ${signal}, then ends by ${signal}`,
          async () => {
            const countFile = join(realHome, 'signal-count');
            const run = start(wrapper(finishesAfter(signal)), { COUNT_FILE: countFile });
            await run.waitFor('stdout', 'ready\n');
            run.signalGroup(signal);
            const exit = await run.closed;
            expect(readFileSync(currentPath, 'utf8')).toBe('0.9.2');
            expect(readFileSync(countFile, 'utf8')).toBe('1');
            expect(exit.signal).toBe(signal);
            expect(run.output.stderr).toContain(
              'ERROR: the command changed the real engine selection.',
            );
            expect(run.output.stderr).toContain('after:  current "0.9.2"');
            expect(kept).toHaveLength(1);
            expect(existsSync(kept[0] as string)).toBe(false);
          },
          signalTimeout,
        );
      }

      test(
        'Ctrl-C stops a shell loop that calls the wrapper',
        async () => {
          const loop = `for i in 1 2 3; do "$NODE" "$SCRIPT" -- "$NODE" -e "$CODE"; echo "iteration $i done"; done`;
          const run = start(['/bin/bash', '-c', loop], {
            NODE: process.execPath,
            SCRIPT: script,
            CODE: `process.on('SIGINT', () => setTimeout(() => process.exit(0), 200));
                   console.log('ready');
                   setInterval(() => {}, 1000);`,
          });
          await run.waitFor('stdout', 'ready\n');
          run.signalGroup('SIGINT');
          const exit = await run.closed;
          expect(run.output.stdout).not.toContain('iteration 1 done');
          expect(exit.signal).toBe('SIGINT');
          expect(run.output.stderr).toContain('the real engine selection is unchanged');
          expect(kept).toHaveLength(1);
          expect(existsSync(kept[0] as string)).toBe(false);
        },
        signalTimeout,
      );

      test(
        'a second Ctrl-C stops a stuck command and still checks and cleans up',
        async () => {
          const run = start(
            wrapper(`process.on('SIGINT', () => {});
                     console.log('pid ' + process.pid);
                     setInterval(() => {}, 1000);`),
          );
          await run.waitFor('stdout', '\n');
          const commandPid = Number(/pid (\d+)/u.exec(run.output.stdout)?.[1]);
          run.signalGroup('SIGINT');
          await run.waitFor('stderr', 'Press Ctrl-C again');
          run.signalGroup('SIGINT');
          const exit = await run.closed;
          expect(exit.signal).toBe('SIGINT');
          expect(run.output.stderr).toContain('was stopped by SIGKILL');
          expect(run.output.stderr).toContain('the real engine selection is unchanged');
          expect(() => process.kill(commandPid, 0)).toThrow();
          expect(kept).toHaveLength(1);
          expect(existsSync(kept[0] as string)).toBe(false);
        },
        signalTimeout,
      );
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
