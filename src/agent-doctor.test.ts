import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  assessChecks,
  assessDeployment,
  assessIssue,
  assessRuntime,
  collectDoctor,
} from '../scripts/agent-doctor.mjs';

describe('agent doctor delivery gates', () => {
  test('collector keeps denied evidence unknown and only requests read-only commands', () => {
    const root = mkdtempSync(join(tmpdir(), 'chat-doctor-test-'));
    const commands: Array<{ program: string; args: string[] }> = [];
    try {
      mkdirSync(join(root, '.git'));
      mkdirSync(join(root, 'src-tauri/src'), { recursive: true });
      mkdirSync(join(root, '.github/workflows'), { recursive: true });
      writeFileSync(join(root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.34.0' }));
      writeFileSync(join(root, '.node-version'), '24.18.1');
      writeFileSync(join(root, 'rust-toolchain.toml'), 'channel = "1.95.0"');
      writeFileSync(
        join(root, 'src-tauri/src/coven_install.rs'),
        'const COVEN_VERSION: &str = "0.4.10";',
      );
      writeFileSync(join(root, '.github/workflows/ios.yml'), 'unknown policy');
      const run = (program: string, args: string[]) => {
        commands.push({ program, args });
        if (program === 'gh') return { ok: false, value: null };
        if (program !== 'git') return { ok: true, value: 'unavailable fixture version' };
        if (args.includes('--show-toplevel') || args.includes('--git-common-dir'))
          return { ok: true, value: args.includes('--git-common-dir') ? join(root, '.git') : root };
        if (args[0] === 'status') return { ok: false, value: null };
        if (args[0] === 'config') return { ok: false, value: null };
        if (args[0] === 'rev-parse' || args[0] === 'merge-base')
          return { ok: true, value: 'a'.repeat(40) };
        return { ok: true, value: '' };
      };
      const report = collectDoctor({ root, run });
      expect(report.checkout.dirty).toBeNull();
      expect(report.tracking.status).toBe('unknown');
      expect(report.ci.status).toBe('unknown');
      expect(report.runtime.installer.status).toBe('unknown');
      expect(commands.some((c) => c.program === 'gh')).toBe(true);
      expect(
        commands
          .filter((c) => c.program === 'gh')
          .every(
            (c) =>
              c.args.join(' ') === '--version' ||
              c.args.slice(0, 3).join(' ') === 'api --method GET',
          ),
      ).toBe(true);
      expect(
        commands
          .filter((c) => c.program === 'git')
          .every((c) =>
            [
              'rev-parse',
              'branch',
              'status',
              'worktree',
              'merge-base',
              'diff',
              'ls-files',
              'config',
            ].includes(c.args[0] ?? ''),
          ),
      ).toBe(true);
      expect(commands.some((c) => c.program === 'coven' || c.program === 'coven-code')).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test('green source candidates cannot certify an unsupported installer runtime', () => {
    const report = assessRuntime({
      chatSha: 'a'.repeat(40),
      installerPin: '0.4.10',
      required: ['run_budget_v1'],
      releases: [{ tag_name: 'v0.4.10', draft: false, prerelease: false }],
      receipts: [
        {
          scope: 'candidate',
          chatSha: 'a'.repeat(40),
          covenVersion: '0.5.1',
          capabilities: ['run_budget_v1'],
          outcome: 'passed',
          evidence: 'local candidate test',
          engineVersion: '0.9.3',
          covenSha: 'c'.repeat(40),
          engineSha: 'e'.repeat(40),
        },
        {
          scope: 'installer',
          chatSha: 'a'.repeat(40),
          covenVersion: '0.4.10',
          capabilities: [],
          outcome: 'passed',
          evidence: 'installer fixture',
          engineVersion: '0.8.0',
        },
      ],
    });
    expect(report.installer.status).toBe('blocked');
    expect(report.candidates[0]?.status).toBe('attested');
    expect(report.installer.detail).toContain('run_budget_v1');
  });

  test('missing releases and mismatched receipts stay unknown', () => {
    const report = assessRuntime({
      chatSha: 'a'.repeat(40),
      installerPin: '0.4.10',
      required: [],
      releases: null,
      receipts: [
        {
          scope: 'installer',
          chatSha: 'b'.repeat(40),
          covenVersion: '0.4.10',
          engineVersion: '0.9.2',
          capabilities: [],
          outcome: 'passed',
          evidence: 'old test',
        },
      ],
    });
    expect(report.installer.status).toBe('unknown');
    expect(report.published.status).toBe('unknown');
  });

  test('skipped required checks are untested and denied rules are unknown', () => {
    expect(assessChecks(null, [], [], [], null).status).toBe('unknown');
    const report = assessChecks(
      ['Rust', 'Web checks'],
      [
        {
          name: 'Rust',
          conclusion: 'skipped',
          status: 'completed',
          started_at: '2026-11-19T00:00:00Z',
          head_sha: 'abc',
        },
        {
          name: 'Web checks',
          conclusion: 'success',
          status: 'completed',
          started_at: '2026-11-19T00:00:00Z',
          head_sha: 'abc',
        },
      ],
      [],
      [],
      [],
    );
    expect(report.status).toBe('blocked');
    expect(report.checks.find((c: { name: string }) => c.name === 'Rust')?.status).toBe('untested');
  });

  test('uses the newest check attempt rather than a superseded success', () => {
    const report = assessChecks(
      ['Rust'],
      [
        { id: 1, name: 'Rust', conclusion: 'success', started_at: '2026-11-18T00:00:00Z' },
        { id: 2, name: 'Rust', conclusion: 'failure', started_at: '2026-11-19T00:00:00Z' },
      ],
      [],
      [],
      [],
    );
    expect(report.status).toBe('blocked');
  });

  test('does not mask an in-progress check with a successful commit status', () => {
    expect(
      assessChecks(
        ['Rust'],
        [{ name: 'Rust', conclusion: null, status: 'in_progress' }],
        [{ context: 'Rust', state: 'success' }],
        [],
        [],
      ).status,
    ).toBe('blocked');
  });

  test('does not hide a failing commit status behind a successful check with the same name', () => {
    expect(
      assessChecks(
        ['Rust'],
        [{ name: 'Rust', conclusion: 'success', status: 'completed' }],
        [{ context: 'Rust', state: 'failure' }],
        [],
        [],
      ).status,
    ).toBe('blocked');
  });

  test('requires exact source identities for candidate receipts and publication for published receipts', () => {
    const report = assessRuntime({
      chatSha: 'a'.repeat(40),
      installerPin: '0.4.10',
      releases: [],
      receipts: [
        {
          scope: 'candidate',
          chatSha: 'a'.repeat(40),
          covenVersion: '0.5.1',
          engineVersion: '0.9.3',
          capabilities: [],
          outcome: 'passed',
          evidence: 'version only',
        },
        {
          scope: 'published',
          chatSha: 'a'.repeat(40),
          covenVersion: '99.0.0',
          engineVersion: '99.0.0',
          capabilities: [],
          outcome: 'passed',
          evidence: 'source build',
        },
      ],
    });
    expect(report.candidates[0]?.status).toBe('unknown');
    expect(report.publishedReceipts[0]?.status).toBe('blocked');
  });

  test('warns about TestFlight only for the current upload path, unknown on unrecognized workflow', () => {
    const workflow =
      "branches: [main]\npaths:\n - 'apps/ios/**'\n - 'src-tauri/**'\nif: github.event_name == 'push'\ngit diff --quiet \"$BEFORE\" \"$SHA\" -- apps/ios\nmode=upload";
    expect(assessDeployment(['apps/ios/Foo.swift'], workflow).status).toBe('blocked');
    expect(assessDeployment(['src-tauri/src/foo.rs'], workflow).detail).toContain(
      'no iOS app change',
    );
    expect(assessDeployment(['apps/ios/Foo.swift'], 'new workflow').status).toBe('unknown');
  });

  test('flags reverted completion and preserves an active claim', () => {
    const row = assessIssue(
      {
        number: 652,
        state: 'open',
        body: '> **State (2026-11-18):** Done: complete. Next: none. Who: previous session.',
        labels: [{ name: 'in-progress' }],
        updated_at: '2026-11-19T00:00:00Z',
      },
      [
        {
          body: '**Claimed** by release-owner (Codex). Next: wait for published runtime.',
          created_at: '2026-11-19T00:00:00Z',
        },
        {
          body: 'Reopened after revert #658. Reland only after published runtime support.',
          created_at: '2026-11-19T01:00:00Z',
        },
      ],
      [],
    );
    expect(row.warnings.join(' ')).toContain('contradict');
    expect(row.claim).toContain('release-owner');
    expect(row.nextAction).toContain('latest comment');
  });
});
