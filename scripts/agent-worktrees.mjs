#!/usr/bin/env node
// Reports every worktree of this repo and whether it looks safe to remove.
//
// Several agent sessions share this checkout, each in its own worktree, and
// nothing removes a worktree when its work lands. This report is read-only: it
// removes nothing. It marks a worktree "removable" only when its work is
// merged or its PR is closed, it has no uncommitted or unpushed changes, it
// isn't locked, no process is running inside it, and it has been idle for at
// least --idle-days days (default 3). Before removing one, check that
// docs/project-coordination.md doesn't retain it and that no peer session owns
// it (AGENTS.md -> Working alongside other agents).
//
// Run `git fetch origin` first: merge state is read from origin/main. Fetching
// only moves origin/* refs, so it can't disturb another session's work.
//
//   node scripts/agent-worktrees.mjs              # table, with PR state from GitHub
//   node scripts/agent-worktrees.mjs --json       # machine-readable
//   node scripts/agent-worktrees.mjs --offline    # skip GitHub; merge state from git only
//   node scripts/agent-worktrees.mjs --idle-days 7

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Parses `git worktree list --porcelain` into one record per worktree. */
export function parseWorktreeList(porcelain) {
  const worktrees = [];
  for (const block of porcelain.split(/\n\s*\n/)) {
    const entry = { path: '', head: '', branch: null, locked: false, prunable: false };
    for (const line of block.split('\n')) {
      const [key, ...rest] = line.split(' ');
      const value = rest.join(' ');
      if (key === 'worktree') entry.path = value;
      else if (key === 'HEAD') entry.head = value;
      else if (key === 'branch') entry.branch = value.replace(/^refs\/heads\//, '');
      else if (key === 'locked') entry.locked = true;
      else if (key === 'prunable') entry.prunable = true;
    }
    if (entry.path) worktrees.push(entry);
  }
  return worktrees;
}

/** Parses `lsof -a -d cwd -F n` output into the set of working directories. */
export function parseCwdList(lsofOutput) {
  return lsofOutput
    .split('\n')
    .filter((line) => line.startsWith('n'))
    .map((line) => line.slice(1));
}

/**
 * Decides what a worktree is, from facts gathered about it. Returns a verdict
 * and the reasons behind it. Only "removable" means safe to remove, and even
 * then only after the checks in the header comment.
 */
export function classifyWorktree(facts, { idleDays = 3 } = {}) {
  const reasons = [];
  if (facts.primary) return { verdict: 'primary', reasons: ['the primary checkout; never remove'] };
  if (facts.missing) {
    return { verdict: 'prunable', reasons: ['directory is gone; `git worktree prune` cleans it'] };
  }
  if (facts.inUse) reasons.push('a running process has its working directory here');
  if (facts.locked) reasons.push('locked');
  if (facts.dirty > 0) reasons.push(`${facts.dirty} uncommitted path(s)`);
  if (facts.unpushed > 0) reasons.push(`${facts.unpushed} commit(s) on no remote`);
  if (facts.retained) reasons.push('named in docs/project-coordination.md');
  const landed = facts.merged || facts.prState === 'merged' || facts.prState === 'closed';
  if (landed) {
    reasons.unshift(
      facts.merged ? 'landed (head is in origin/main)' : `landed (PR ${facts.prState})`,
    );
  } else {
    reasons.push(facts.prState === 'open' ? 'PR open' : 'work not merged and no closed PR');
  }
  if (facts.idleDays < idleDays) reasons.push(`active ${facts.idleDays.toFixed(1)} day(s) ago`);
  if (reasons.length === 1 && landed) {
    return { verdict: 'removable', reasons: [...reasons, 'clean and idle'] };
  }
  const blocking = facts.inUse || facts.locked || facts.dirty > 0 || facts.unpushed > 0;
  return { verdict: blocking || !landed ? 'keep' : 'check', reasons };
}

// GIT_OPTIONAL_LOCKS=0 stops `git status` from refreshing other worktrees'
// index files: the audit stays read-only and can't reset the idle clock it reads.
const READ_ONLY_GIT = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };

function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: READ_ONLY_GIT,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function tryGit(cwd, args) {
  try {
    return git(cwd, args).trim();
  } catch {
    return null;
  }
}

function prStateFor(repo, owner, branch) {
  if (!branch) return 'none';
  try {
    const out = execFileSync(
      'gh',
      [
        'api',
        `repos/${repo}/pulls?head=${owner}:${branch}&state=all&per_page=1`,
        '--jq',
        '.[0] | if . == null then "none" elif .merged_at then "merged" else .state end',
      ],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return out || 'none';
  } catch {
    return 'unknown';
  }
}

function runningCwds() {
  try {
    return parseCwdList(
      execFileSync('lsof', ['-a', '-d', 'cwd', '-F', 'n'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch {
    return [];
  }
}

/**
 * The names docs/project-coordination.md would use for a worktree: the
 * `.worktrees/<name>` path and a backticked `<name>` for worktrees under the
 * primary checkout, and the `~/...` path for any other. A bare folder name is
 * not enough: every external Codex checkout is called `chat`.
 */
export function coordinationNames(path, primaryPath, home = '') {
  const under = `${primaryPath}/.worktrees/`;
  if (path.startsWith(under)) {
    const name = path.slice(under.length);
    return [`.worktrees/${name}`, `\`${name}\``];
  }
  return home && path.startsWith(`${home}/`) ? [`~${path.slice(home.length)}`, path] : [path];
}

/** Gathers facts for every worktree and classifies each one. */
export function auditWorktrees({ root = process.cwd(), offline = false, idleDays = 3 } = {}) {
  const common = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim();
  const primaryPath = join(common, '..');
  const remote = tryGit(root, ['remote', 'get-url', 'origin']) ?? '';
  const repo = /github\.com[:/](.+?)(?:\.git)?$/.exec(remote)?.[1] ?? '';
  const owner = repo.split('/')[0] ?? '';
  // Read the coordination index as merged, not from the primary checkout,
  // which may be behind origin/main or mid-merge.
  const local = join(root, 'docs/project-coordination.md');
  const coordinationText =
    tryGit(root, ['show', 'origin/main:docs/project-coordination.md']) ??
    (existsSync(local) ? readFileSync(local, 'utf8') : '');
  const cwds = runningCwds();
  const now = Date.now();

  return parseWorktreeList(git(root, ['worktree', 'list', '--porcelain'])).map((worktree) => {
    const primary = worktree.path === primaryPath;
    const missing = worktree.prunable || !existsSync(worktree.path);
    const facts = {
      primary,
      missing,
      locked: worktree.locked,
      inUse: cwds.some((cwd) => cwd === worktree.path || cwd.startsWith(`${worktree.path}/`)),
      dirty: 0,
      unpushed: 0,
      merged: false,
      prState: 'none',
      idleDays: Number.POSITIVE_INFINITY,
      retained:
        !primary &&
        coordinationNames(worktree.path, primaryPath, process.env.HOME).some((name) =>
          coordinationText.includes(name),
        ),
    };
    if (!primary && !missing) {
      // Read the index timestamp before anything else runs git in this worktree.
      const adminDir = tryGit(worktree.path, ['rev-parse', '--path-format=absolute', '--git-dir']);
      const index = adminDir ? join(adminDir, 'index') : '';
      const touched = index && existsSync(index) ? statSync(index).mtimeMs : 0;
      const status = tryGit(worktree.path, ['status', '--porcelain']) ?? '';
      facts.dirty = status ? status.split('\n').length : 0;
      facts.unpushed = Number(
        tryGit(worktree.path, ['rev-list', '--count', 'HEAD', '--not', '--remotes']) ?? '0',
      );
      facts.merged =
        tryGit(root, ['merge-base', '--is-ancestor', worktree.head, 'origin/main']) !== null;
      const committed = Date.parse(tryGit(worktree.path, ['log', '-1', '--format=%cI']) ?? '');
      const last = Math.max(Number.isNaN(committed) ? 0 : committed, touched);
      facts.idleDays = last > 0 ? Math.max(0, now - last) / DAY_MS : Number.POSITIVE_INFINITY;
      facts.prState = offline ? 'unknown' : prStateFor(repo, owner, worktree.branch);
    }
    return { ...worktree, facts, ...classifyWorktree(facts, { idleDays }) };
  });
}

function table(rows) {
  const order = { removable: 0, check: 1, prunable: 2, keep: 3, primary: 4 };
  const sorted = [...rows].sort((a, b) => order[a.verdict] - order[b.verdict]);
  const lines = ['| Verdict | Worktree | Branch | PR | Why |', '| --- | --- | --- | --- | --- |'];
  for (const row of sorted) {
    const where = row.path.replace(process.env.HOME ?? '\0', '~');
    const why = row.reasons.filter(Boolean).join('; ');
    lines.push(
      `| ${row.verdict} | \`${where}\` | ${row.branch ?? '(detached)'} | ${row.facts.prState} | ${why} |`,
    );
  }
  return lines.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const idleAt = args.indexOf('--idle-days');
  const idleDays = idleAt >= 0 ? Number(args[idleAt + 1]) : 3;
  const rows = auditWorktrees({ offline: args.includes('--offline'), idleDays });
  if (args.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2));
  } else {
    console.log(table(rows));
    const count = (verdict) => rows.filter((row) => row.verdict === verdict).length;
    console.log(
      `\n${rows.length} worktrees: ${count('removable')} removable, ${count('check')} to check, ` +
        `${count('prunable')} prunable, ${count('keep')} kept. Nothing was removed.`,
    );
  }
}
