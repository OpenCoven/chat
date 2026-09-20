import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { checkAuthorityFreshness } from '../scripts/phase1-authority-freshness.mjs';

let root: string;
const guard = 'scripts/phase1-authority-freshness.mjs';
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const commit = (message: string) => {
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '-qm',
    message,
  );
  return git('rev-parse', 'HEAD');
};
let authority: string;
function pin(revision = authority) {
  writeFileSync(
    resolve(root, 'phase1-conformance.lock.json'),
    JSON.stringify({
      harnessAuthority: {
        revision,
        files: [{ path: 'governed.txt' }],
        productionDeltas: [{ path: 'production.txt' }],
      },
    }),
  );
  commit('pin');
}

beforeEach(() => {
  root = mkdtempSync(resolve(tmpdir(), 'chat-authority-'));
  git('init', '-q', '-b', 'main');
  mkdirSync(resolve(root, 'scripts'));
  for (const name of [
    'phase1-authority-freshness',
    'phase1-conformance-lock',
    'supervised-exec',
    'executable-resolution',
    'owned-temp-directory',
    'supervisor-status',
  ]) {
    copyFileSync(
      resolve(process.cwd(), `scripts/${name}.mjs`),
      resolve(root, `scripts/${name}.mjs`),
    );
  }
  writeFileSync(resolve(root, 'governed.txt'), 'harness');
  writeFileSync(resolve(root, 'production.txt'), 'production');
  commit('initial');
  git('checkout', '-qb', 'content');
  writeFileSync(resolve(root, 'content.txt'), 'content');
  commit('content');
  git('checkout', '-q', 'main');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    '-c',
    'commit.gpgsign=false',
    'merge',
    '--no-ff',
    '-qm',
    'merge content',
    'content',
  );
  authority = git('rev-parse', 'HEAD');
  pin();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
const check = () => checkAuthorityFreshness('HEAD', root);

describe('phase 1 authority freshness', () => {
  test('accepts a repin to an unchanged merged authority', () => {
    expect(check().failures).toEqual([]);
  });
  test.each(['governed.txt', 'production.txt', guard])('rejects drift in %s', (path) => {
    writeFileSync(resolve(root, path), 'changed');
    commit('drift');
    expect(check().adrift.map((entry) => entry.path)).toContain(path);
  });
  test('rejects a missing guard in the pinned authority', () => {
    git('rm', guard);
    commit('delete guard');
    pin(git('rev-parse', 'HEAD'));
    expect(check().failures.join(' ')).toMatch(/freshness guard.*missing/u);
  });
  test('rejects a branch tip pin', () => {
    pin(git('rev-parse', 'HEAD'));
    expect(check().failures.join(' ')).toMatch(/merge commit/u);
  });
  test('rejects a merge reachable only through a feature branch', () => {
    git('checkout', '-qb', 'feature');
    writeFileSync(resolve(root, 'feature.txt'), 'feature');
    commit('feature');
    git('checkout', '-qb', 'nested');
    writeFileSync(resolve(root, 'nested.txt'), 'nested');
    commit('nested');
    git('checkout', '-q', 'feature');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'commit.gpgsign=false',
      'merge',
      '--no-ff',
      '-qm',
      'nested merge',
      'nested',
    );
    const nested = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'commit.gpgsign=false',
      'merge',
      '--no-ff',
      '-qm',
      'feature merge',
      'feature',
    );
    pin(nested);
    expect(check().failures.join(' ')).toMatch(/first-parent/u);
  });
  test('rejects an unreachable pin', () => {
    git('checkout', '-qb', 'other');
    writeFileSync(resolve(root, 'other.txt'), 'other');
    const other = commit('other');
    git('checkout', '-q', 'main');
    pin(other);
    expect(check().reachable).toBe(false);
  });
  test('ignores inherited Git repository and configuration overrides', () => {
    vi.stubEnv('GIT_DIR', resolve(root, 'nonexistent'));
    vi.stubEnv('GIT_CONFIG_COUNT', '1');
    vi.stubEnv('GIT_CONFIG_KEY_0', 'core.bare');
    vi.stubEnv('GIT_CONFIG_VALUE_0', 'true');
    expect(check().failures).toEqual([]);
  });
  test('does not let replacement objects conceal drift', () => {
    const clean = git('rev-parse', 'HEAD');
    writeFileSync(resolve(root, 'governed.txt'), 'changed');
    const changed = commit('drift');
    git('replace', changed, clean);
    expect(check().adrift.map((entry) => entry.path)).toContain('governed.txt');
  });
  test('the CI shell executes the pinned guard even when the current guard exits successfully', () => {
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    const section = workflow.split('      - name: Phase 1 authority is current\n')[1];
    if (!section) throw new Error('Missing freshness step');
    const body = section.split('\n  e2e:')[0]?.split('        run: |\n')[1];
    if (!body) throw new Error('Missing freshness shell body');
    const script = body
      .split('\n')
      .map((line) => line.slice(10))
      .join('\n');
    const run = () =>
      spawnSync('bash', ['-c', script], {
        cwd: root,
        encoding: 'utf8',
        env: { ...process.env, RUNNER_TEMP: root, GITHUB_WORKSPACE: root, GIT_DIR: '/invalid' },
      });
    expect(run().status).toBe(0);
    writeFileSync(resolve(root, guard), 'process.exit(0);');
    commit('neuter current guard');
    const failed = run();
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain(guard);
  });
  test('runs the main-only gate from the pinned scripts', () => {
    const workflow = readFileSync(resolve(process.cwd(), '.github/workflows/ci.yml'), 'utf8');
    expect(workflow).toContain(
      "if: github.event_name == 'push' && github.ref == 'refs/heads/main'",
    );
    expect(workflow).toContain('archive "$authority" scripts/');
    expect(workflow).toContain(
      'node "$pinned/scripts/phase1-authority-freshness.mjs" HEAD "$GITHUB_WORKSPACE"',
    );
    expect(workflow).toContain('GIT_CONFIG_NOSYSTEM=1');
  });
});
