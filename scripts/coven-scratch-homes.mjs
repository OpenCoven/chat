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
// Ctrl-C and SIGTERM don't skip that check: while the command runs, the
// wrapper waits for it to finish and then checks and cleans up. A terminal
// sends Ctrl-C to the command as well, so the wrapper doesn't pass SIGINT on
// (a second one could make the command quit without finishing). A SIGTERM is
// usually meant for the wrapper alone, so it passes that one on.
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
import { homedir, tmpdir } from 'node:os';
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

// Start the command and wait for it. From here on SIGINT and SIGTERM don't
// stop this script, so the check and cleanup after the command still run.
function runCommand(command, commandArgs, env) {
  return new Promise((resolveRun) => {
    const received = [];
    const onSigint = () => received.push('SIGINT');
    const onSigterm = () => {
      received.push('SIGTERM');
      child.kill('SIGTERM');
    };
    process.on('SIGINT', onSigint);
    process.on('SIGTERM', onSigterm);
    const child = spawn(command, commandArgs, { stdio: 'inherit', env });
    let error = null;
    child.on('error', (spawnError) => {
      error = spawnError;
    });
    child.on('close', (status, signal) => {
      resolveRun({ status, signal, error, received });
    });
  });
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
for (const signal of new Set(result.received))
  console.error(`coven-scratch-homes: got ${signal} while ${command} ran; checking before exiting`);

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
  process.exit(engineChangedExitCode);
}

if (result.error) {
  console.error(`coven-scratch-homes: couldn't run ${command}: ${result.error.message}`);
  process.exit(127);
}
if (result.signal) {
  console.error(`coven-scratch-homes: ${command} was stopped by ${result.signal}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
