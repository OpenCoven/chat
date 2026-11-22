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
// `<home>/.coven/engine`; if either changed, it says so and exits 3.
// Otherwise it exits with the command's status. The scratch folder is removed
// afterwards unless you pass --keep.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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

function snapshotEngine(realHome) {
  const engineDir = join(realHome, '.coven', 'engine');
  const currentPath = join(engineDir, 'current');
  return {
    engineDir,
    current: existsSync(currentPath) ? readFileSync(currentPath, 'utf8') : null,
    entries: existsSync(engineDir) ? readdirSync(engineDir).sort() : null,
  };
}

function describe(snapshot) {
  const current =
    snapshot.current === null ? '(no current file)' : JSON.stringify(snapshot.current);
  const entries =
    snapshot.entries === null ? '(no engine folder)' : snapshot.entries.join(', ') || '(empty)';
  return `current ${current}; entries ${entries}`;
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
const result = spawnSync(command, commandArgs, {
  stdio: 'inherit',
  env: { ...process.env, ...scratch, ...xdg },
});

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
