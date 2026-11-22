#!/usr/bin/env node
// Run a command with scratch HOME, COVEN_HOME and COVEN_CODE_HOME, and fail
// loudly if it changed the real engine selection.
//
//   node scripts/coven-scratch-homes.mjs [--keep] [--] <command> [args...]
//
// COVEN_HOME moves Coven's state, but its managed engine lives under
// $HOME/.coven/engine no matter what: `coven engine install` writes there and
// rewrites `current`, which is what the installed Chat starts. So every Coven
// run that isn't meant to touch the real install needs all three moved.
//
// The real home is $HOME as this script sees it. Before and after the command
// it records `<home>/.coven/engine/current` and the names in
// `<home>/.coven/engine` (ignoring dotfiles such as .DS_Store); if either
// changed, it says so and exits 3. Otherwise it exits with the command's
// status. The scratch folder is removed afterwards unless you pass --keep.
//
// Ctrl-C and SIGTERM don't skip that check. The wrapper doesn't pass either
// signal on: a terminal sends Ctrl-C to the whole foreground group, and
// `timeout` or `kill -TERM -<pgid>` signal the group too, so the command gets
// it already and a second copy could make it quit without finishing. The
// wrapper waits for the command to stop, checks, cleans up, and then ends by
// the same signal, so a calling script stops as it would without it. A
// second Ctrl-C while the command is still running stops it (the direct
// child only) with SIGKILL. A repeated SIGTERM doesn't: `timeout` and similar
// supervisors send one to the wrapper and another to its group, and the
// command must be left to handle its own.
import { spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
} from 'node:fs';
import { constants, homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const engineChangedExitCode = 3;

// macOS limits a Unix socket path to 104 bytes, and Coven keeps its daemon
// socket in COVEN_HOME. On macOS os.tmpdir() is under /var/folders, which is
// short enough; a long TMPDIR is reported rather than silently used.
const socketPathBudget = 90;

function usage(message) {
  if (message) console.error(`coven-scratch-homes: ${message}`);
  console.error('usage: node scripts/coven-scratch-homes.mjs [--keep] [--] <command> [args...]');
  process.exit(2);
}

// `current` is a plain file today. A link, a folder or anything unreadable is
// still recorded, so a change to it is reported rather than thrown.
function readCurrent(currentPath) {
  let stat;
  try {
    stat = lstatSync(currentPath);
  } catch {
    return null;
  }
  if (stat.isSymbolicLink()) {
    let target;
    try {
      target = readlinkSync(currentPath);
    } catch (error) {
      target = `(unreadable: ${error.code ?? error.message})`;
    }
    return `(a link to ${JSON.stringify(target)})`;
  }
  if (stat.isDirectory()) return '(a folder)';
  try {
    return JSON.stringify(readFileSync(currentPath, 'utf8'));
  } catch (error) {
    return `(unreadable: ${error.code ?? error.message})`;
  }
}

function readEntries(engineDir) {
  if (!existsSync(engineDir)) return null;
  try {
    return readdirSync(engineDir)
      .filter((name) => !name.startsWith('.'))
      .sort();
  } catch (error) {
    return [`(unreadable: ${error.code ?? error.message})`];
  }
}

function snapshotEngine(realHome) {
  const engineDir = join(realHome, '.coven', 'engine');
  return {
    engineDir,
    current: readCurrent(join(engineDir, 'current')),
    entries: readEntries(engineDir),
  };
}

function describe(snapshot) {
  const current = snapshot.current ?? '(no current file)';
  const entries =
    snapshot.entries === null ? '(no engine folder)' : snapshot.entries.join(', ') || '(empty)';
  return `current ${current}; entries ${entries}`;
}

const handledSignals = ['SIGINT', 'SIGTERM'];
const received = [];
const signalHandlers = new Map();

// Start the command and wait for it. From here until the script ends, SIGINT
// and SIGTERM are recorded instead of stopping it, so the check and cleanup
// after the command still run.
function runCommand(command, commandArgs, env) {
  return new Promise((resolveRun) => {
    let running = true;
    let child;
    for (const signal of handledSignals) {
      const handler = () => {
        const seenBefore = received.includes(signal);
        received.push(signal);
        if (!running) return;
        if (received.length === 1) {
          console.error(
            `coven-scratch-homes: got ${signal}; waiting for ${command} to stop, then checking ` +
              'the real engine. Press Ctrl-C again to stop it now.',
          );
        } else if (signal === 'SIGINT' && seenBefore) {
          console.error(`coven-scratch-homes: got SIGINT again; stopping ${command}`);
          child.kill('SIGKILL');
        }
      };
      signalHandlers.set(signal, handler);
      process.on(signal, handler);
    }
    child = spawn(command, commandArgs, { stdio: 'inherit', env });
    let error = null;
    child.on('error', (spawnError) => {
      error = spawnError;
    });
    child.on('close', (status, signal) => {
      running = false;
      resolveRun({ status, signal, error });
    });
  });
}

// End by `signal`, as the script would have without its handlers, so a
// calling shell sees it. If that doesn't end it, exit with `fallbackCode`.
function endBySignal(signal, fallbackCode) {
  for (const [name, handler] of signalHandlers) process.off(name, handler);
  setTimeout(() => process.exit(fallbackCode), 1000);
  process.kill(process.pid, signal);
}

const args = process.argv.slice(2);
let keep = false;
while (args.length > 0 && args[0].startsWith('--')) {
  const flag = args.shift();
  if (flag === '--') break;
  if (flag === '--keep') keep = true;
  else usage(`unknown option ${flag}`);
}
if (args.length === 0) usage('no command given');

const realHome = process.env.HOME || homedir();
const before = snapshotEngine(realHome);

const root = mkdtempSync(join(tmpdir(), 'coven-scratch-'));
const scratch = {
  HOME: join(root, 'home'),
  COVEN_HOME: join(root, 'coven'),
  COVEN_CODE_HOME: join(root, 'coven-code'),
};
for (const dir of Object.values(scratch)) mkdirSync(dir);
// On Linux, keep XDG config, data, cache and state inside the scratch home too.
const xdg = {
  XDG_CONFIG_HOME: join(scratch.HOME, '.config'),
  XDG_DATA_HOME: join(scratch.HOME, '.local', 'share'),
  XDG_CACHE_HOME: join(scratch.HOME, '.cache'),
  XDG_STATE_HOME: join(scratch.HOME, '.local', 'state'),
};

console.error(`coven-scratch-homes: real home ${realHome}: ${describe(before)}`);
for (const [name, dir] of Object.entries(scratch))
  console.error(`coven-scratch-homes: ${name}=${dir}`);
if (scratch.COVEN_HOME.length > socketPathBudget) {
  console.error(
    `coven-scratch-homes: warning: COVEN_HOME is ${scratch.COVEN_HOME.length} bytes long, so a daemon ` +
      'socket inside it may not fit. Set TMPDIR to a short folder (on macOS, under /var/folders).',
  );
}

const [command, ...commandArgs] = args;
const result = await runCommand(command, commandArgs, { ...process.env, ...scratch, ...xdg });

const after = snapshotEngine(realHome);
const changed =
  before.current !== after.current ||
  JSON.stringify(before.entries) !== JSON.stringify(after.entries);

if (keep) console.error(`coven-scratch-homes: kept ${root}`);
else rmSync(root, { recursive: true, force: true });

if (changed) {
  console.error('coven-scratch-homes: ERROR: the command changed the real engine selection.');
  console.error(`coven-scratch-homes:   before: ${describe(before)}`);
  console.error(`coven-scratch-homes:   after:  ${describe(after)}`);
  console.error(
    `coven-scratch-homes: Put ${before.engineDir} back as it was before anything starts that engine.`,
  );
}

let exitCode;
if (changed) exitCode = engineChangedExitCode;
if (result.error) {
  console.error(`coven-scratch-homes: couldn't run ${command}: ${result.error.message}`);
  exitCode ??= 127;
} else if (result.signal) {
  console.error(`coven-scratch-homes: ${command} was stopped by ${result.signal}`);
  exitCode ??= 1;
}
exitCode ??= result.status ?? 1;

const [firstSignal] = received;
if (firstSignal) {
  if (!changed) console.error('coven-scratch-homes: the real engine selection is unchanged.');
  endBySignal(firstSignal, changed ? exitCode : 128 + constants.signals[firstSignal]);
} else {
  process.exit(exitCode);
}
