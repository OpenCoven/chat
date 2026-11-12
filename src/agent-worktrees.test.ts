import { describe, expect, test } from 'vitest';
import {
  classifyWorktree,
  coordinationNames,
  parseCwdList,
  parseWorktreeList,
  type WorktreeFacts,
} from '../scripts/agent-worktrees.mjs';

const landedAndIdle: WorktreeFacts = {
  primary: false,
  missing: false,
  locked: false,
  inUse: false,
  dirty: 0,
  unpushed: 0,
  merged: true,
  prState: 'merged',
  idleDays: 10,
  retained: false,
};

describe('worktree audit', () => {
  test('parses git worktree list --porcelain', () => {
    const porcelain = [
      'worktree /repo',
      'HEAD aaa',
      'branch refs/heads/main',
      '',
      'worktree /repo/.worktrees/one',
      'HEAD bbb',
      'detached',
      'locked held by a release',
      '',
      'worktree /gone',
      'HEAD ccc',
      'branch refs/heads/fix/1-gone',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\n');
    expect(parseWorktreeList(porcelain)).toEqual([
      { path: '/repo', head: 'aaa', branch: 'main', locked: false, prunable: false },
      { path: '/repo/.worktrees/one', head: 'bbb', branch: null, locked: true, prunable: false },
      { path: '/gone', head: 'ccc', branch: 'fix/1-gone', locked: false, prunable: true },
    ]);
  });

  test('reads working directories from lsof field output', () => {
    expect(parseCwdList('p12\nfcwd\nn/repo/.worktrees/one\np13\nfcwd\nn/tmp\n')).toEqual([
      '/repo/.worktrees/one',
      '/tmp',
    ]);
  });

  test('calls a landed, clean, idle worktree removable', () => {
    expect(classifyWorktree(landedAndIdle)).toEqual({
      verdict: 'removable',
      reasons: ['landed (head is in origin/main)', 'clean and idle'],
    });
    expect(classifyWorktree({ ...landedAndIdle, merged: false, prState: 'closed' }).verdict).toBe(
      'removable',
    );
  });

  test('never offers the primary checkout', () => {
    expect(classifyWorktree({ ...landedAndIdle, primary: true }).verdict).toBe('primary');
  });

  test('keeps anything that could lose work or is in use', () => {
    for (const change of [
      { dirty: 2 },
      { unpushed: 1 },
      { locked: true },
      { inUse: true },
      { merged: false, prState: 'open' as const },
      { merged: false, prState: 'none' as const },
    ]) {
      expect(
        classifyWorktree({ ...landedAndIdle, ...change }).verdict,
        JSON.stringify(change),
      ).toBe('keep');
    }
  });

  test('asks for a human check when landed work is recent or retained by the coordination index', () => {
    const recent = classifyWorktree({ ...landedAndIdle, idleDays: 1 });
    expect(recent.verdict).toBe('check');
    expect(recent.reasons.join()).toContain('active 1.0 day(s) ago');
    const retained = classifyWorktree({ ...landedAndIdle, retained: true });
    expect(retained.verdict).toBe('check');
    expect(retained.reasons).toEqual([
      'landed (head is in origin/main)',
      'named in docs/project-coordination.md',
    ]);
    expect(classifyWorktree({ ...landedAndIdle, idleDays: 5 }, { idleDays: 7 }).verdict).toBe(
      'check',
    );
  });

  test('names worktrees the way the coordination index does, never by a bare folder name', () => {
    expect(coordinationNames('/repo/.worktrees/533-rendered-pass', '/repo', '/home/me')).toEqual([
      '.worktrees/533-rendered-pass',
      '`533-rendered-pass`',
    ]);
    expect(coordinationNames('/home/me/.codex/worktrees/67d4/chat', '/repo', '/home/me')).toEqual([
      '~/.codex/worktrees/67d4/chat',
      '/home/me/.codex/worktrees/67d4/chat',
    ]);
    expect(coordinationNames('/elsewhere/chat', '/repo', '/home/me')).toEqual(['/elsewhere/chat']);
  });

  test('reports a vanished directory as prunable', () => {
    expect(classifyWorktree({ ...landedAndIdle, missing: true }).verdict).toBe('prunable');
  });
});
