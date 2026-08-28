import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultChatRoot = root;
const defaultSdkRoot = resolve(root, '.cross-repo', 'sdk');
const defaultCaveRoot = resolve(root, '.cross-repo', 'coven-cave');
const defaultCovenRoot = resolve(root, '.cross-repo', 'coven');
const defaultLockPath = resolve(root, 'phase1-conformance.lock.json');
const reviewedRevisionPattern = /^[0-9a-f]{40}$/i;

function printUsage() {
  process.stdout.write(
    [
      'usage: phase1-conformance-lock.mjs [--sdk-root <path>] [--cave-root <path>]',
      '       [--coven-root <path>] [--chat-root <path>] [--lock <path>]',
      '',
      'Reads the immutable Phase 1 conformance lock, verifies the Chat, SDK,',
      'Cave, and Coven checkouts are clean, and proves each checkout HEAD is',
      'exactly the locked reviewed revision.',
      '',
    ].join('\n'),
  );
}

function requirePath(path, label) {
  if (typeof path !== 'string' || path.length === 0 || !existsSync(path)) {
    throw new Error(`${label} does not exist: ${path}`);
  }

  return path;
}

function validateLockEntry(lockData, key, expectedRepository) {
  const entry = lockData[key];

  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`phase1-conformance.lock.json ${key} entry must be an object.`);
  }

  if (entry.repository !== expectedRepository) {
    throw new Error(
      `phase1-conformance.lock.json ${key}.repository must be ${expectedRepository}.`,
    );
  }

  if (!reviewedRevisionPattern.test(entry.revision ?? '')) {
    throw new Error(
      `phase1-conformance.lock.json ${key}.revision must be an immutable 40-character commit SHA.`,
    );
  }

  return {
    repository: entry.repository,
    revision: entry.revision,
  };
}

export function readPhase1ConformanceLock(lockPath = defaultLockPath) {
  requirePath(lockPath, 'Phase 1 conformance lock');

  const lockData = JSON.parse(readFileSync(lockPath, 'utf8'));

  if (lockData.version !== 1) {
    throw new Error('phase1-conformance.lock.json version must be 1.');
  }

  return {
    path: lockPath,
    chat: validateLockEntry(lockData, 'chat', 'OpenCoven/chat'),
    sdk: validateLockEntry(lockData, 'sdk', 'OpenCoven/sdk'),
    cave: validateLockEntry(lockData, 'cave', 'OpenCoven/coven-cave'),
    coven: validateLockEntry(lockData, 'coven', 'OpenCoven/coven'),
  };
}

function run(command, args, cwd, options = {}) {
  return execFileSync(command, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).toString();
}

function readGitHead(repositoryRoot, label) {
  requirePath(repositoryRoot, label);

  return run('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD'], root, {
    encoding: 'utf8',
  }).trim();
}

function readGitStatusPorcelain(repositoryRoot, label) {
  requirePath(repositoryRoot, label);

  return run(
    'git',
    ['-C', repositoryRoot, 'status', '--porcelain=v1', '--untracked-files=all'],
    root,
    {
      encoding: 'utf8',
    },
  );
}

function summarizeGitStatus(statusOutput) {
  const summary = {
    staged: 0,
    unstaged: 0,
    untracked: 0,
  };

  for (const line of statusOutput.split('\n')) {
    if (line.length === 0) {
      continue;
    }

    const [indexStatus = ' ', worktreeStatus = ' '] = line;

    if (indexStatus === '?' && worktreeStatus === '?') {
      summary.untracked += 1;
      continue;
    }

    if (indexStatus !== ' ') {
      summary.staged += 1;
    }

    if (worktreeStatus !== ' ') {
      summary.unstaged += 1;
    }
  }

  return summary;
}

function formatDirtySummary(summary) {
  const parts = [];

  if (summary.staged > 0) {
    parts.push(`${summary.staged} staged change${summary.staged === 1 ? '' : 's'}`);
  }

  if (summary.unstaged > 0) {
    parts.push(`${summary.unstaged} unstaged change${summary.unstaged === 1 ? '' : 's'}`);
  }

  if (summary.untracked > 0) {
    parts.push(`${summary.untracked} untracked item${summary.untracked === 1 ? '' : 's'}`);
  }

  return parts.join(', ');
}

export function assertCleanGitCheckout(repositoryRoot, label) {
  const summary = summarizeGitStatus(readGitStatusPorcelain(repositoryRoot, label));

  if (summary.staged === 0 && summary.unstaged === 0 && summary.untracked === 0) {
    return summary;
  }

  throw new Error(
    `${label} at ${repositoryRoot} is dirty (${formatDirtySummary(summary)}). ` +
      'Phase 1 conformance requires a clean checkout with no staged, unstaged, or untracked files.',
  );
}

export function assertCleanPhase1Checkouts({ chatRoot, sdkRoot, caveRoot, covenRoot }) {
  return {
    chat: assertCleanGitCheckout(chatRoot, 'Chat checkout'),
    sdk: assertCleanGitCheckout(sdkRoot, 'SDK checkout'),
    cave: assertCleanGitCheckout(caveRoot, 'Cave checkout'),
    coven: assertCleanGitCheckout(covenRoot, 'Coven checkout'),
  };
}

export function assertPhase1CheckoutHeads(lock, { chatRoot, sdkRoot, caveRoot, covenRoot }) {
  const heads = {
    chat: readGitHead(chatRoot, 'Chat root'),
    sdk: readGitHead(sdkRoot, 'SDK root'),
    cave: readGitHead(caveRoot, 'Cave root'),
    coven: readGitHead(covenRoot, 'Coven root'),
  };

  for (const [key, label] of [
    ['chat', 'Chat'],
    ['sdk', 'SDK'],
    ['cave', 'Cave'],
    ['coven', 'Coven'],
  ]) {
    if (heads[key] !== lock[key].revision) {
      throw new Error(
        `${label} checkout HEAD ${heads[key]} does not match locked reviewed revision ${lock[key].revision}.`,
      );
    }
  }

  return heads;
}

export function parseArgs(argv) {
  const options = {
    chatRoot: resolve(process.env.OPENCOVEN_CHAT_ROOT ?? defaultChatRoot),
    sdkRoot: resolve(process.env.OPENCOVEN_SDK_ROOT ?? defaultSdkRoot),
    caveRoot: resolve(process.env.OPENCOVEN_CAVE_ROOT ?? defaultCaveRoot),
    covenRoot: resolve(process.env.OPENCOVEN_COVEN_ROOT ?? defaultCovenRoot),
    lockPath: resolve(process.env.PHASE1_CONFORMANCE_LOCK ?? defaultLockPath),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === '--help') {
      printUsage();
      process.exit(0);
    }

    if (argument === '--') {
      continue;
    }

    if (
      argument === '--chat-root' ||
      argument === '--sdk-root' ||
      argument === '--cave-root' ||
      argument === '--coven-root' ||
      argument === '--lock'
    ) {
      const value = argv[index + 1];

      if (value === undefined || value.length === 0) {
        throw new Error(`${argument} requires a value.`);
      }

      if (argument === '--chat-root') {
        options.chatRoot = resolve(value);
      } else if (argument === '--sdk-root') {
        options.sdkRoot = resolve(value);
      } else if (argument === '--cave-root') {
        options.caveRoot = resolve(value);
      } else if (argument === '--coven-root') {
        options.covenRoot = resolve(value);
      } else {
        options.lockPath = resolve(value);
      }

      index += 1;
      continue;
    }

    throw new Error(`phase1-conformance-lock: unknown option: ${argument}`);
  }

  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const lock = readPhase1ConformanceLock(options.lockPath);

  assertCleanPhase1Checkouts(options);
  assertPhase1CheckoutHeads(lock, options);

  process.stdout.write(
    [
      `phase1-conformance lock: ok`,
      `  chat  ${lock.chat.revision}`,
      `  sdk   ${lock.sdk.revision}`,
      `  cave  ${lock.cave.revision}`,
      `  coven ${lock.coven.revision}`,
      '',
    ].join('\n'),
  );
}
