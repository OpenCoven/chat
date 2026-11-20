import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import {
  checkCiFull,
  ciFullJobs,
  governedPaths,
  pathsNeedingCiFull,
} from '../scripts/ci-full-check.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = resolve(projectRoot, 'scripts', 'ci-full-check.mjs');
const ci = readFileSync(resolve(projectRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
const governed = governedPaths(
  readFileSync(resolve(projectRoot, 'phase1-conformance.lock.json'), 'utf8'),
);

// Each top-level job in ci.yml, keyed by its id, without comment lines.
function ciJobs() {
  const jobs = new Map<string, string>();
  let current: string | undefined;
  let inJobs = false;
  for (const line of ci.split('\n')) {
    if (line === 'jobs:') {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;
    const id = /^ {2}([a-z0-9-]+):$/u.exec(line)?.[1];
    if (id) {
      current = id;
      jobs.set(id, '');
    } else if (current && !/^\s*#/u.test(line)) {
      jobs.set(current, `${jobs.get(current)}${line}\n`);
    }
  }
  return jobs;
}

describe('ci-full-check', () => {
  test('knows exactly the ci.yml jobs that run on a pull request only under ci:full', () => {
    const gated = [...ciJobs()]
      .filter(([, body]) =>
        body.includes("contains(github.event.pull_request.labels.*.name, 'ci:full')"),
      )
      .map(([id]) => id);
    expect(gated.sort()).toEqual([...ciFullJobs].sort());
  });

  test('flags every repository path those jobs name', () => {
    const jobs = ciJobs();
    const named = new Set<string>();
    for (const id of ciFullJobs) {
      const body = jobs.get(id) ?? '';
      for (const match of body.matchAll(
        /(?:^|[\s'"=.(/])((?:tools|scripts|src-tauri|src|\.github\/workflows)\/[A-Za-z0-9_./-]*[A-Za-z0-9_])/gmu,
      )) {
        if (match[1]) named.add(match[1]);
      }
    }
    expect(named).toContain('tools/phase1-process-supervisor');
    expect(checkCiFull(['vitest.heavy.config.ts', 'rust-toolchain.toml'], []).message).toContain(
      'rust-toolchain.toml',
    );
    expect(checkCiFull(['vitest.heavy.config.ts'], []).status).toBe(1);
    expect(named.size).toBeGreaterThan(5);
    const flagged = new Set(pathsNeedingCiFull([...named], governed).map(({ path }) => path));
    expect([...named].filter((path) => !flagged.has(path))).toEqual([]);
  });

  test('flags every file the conformance lock governs, and the lock', () => {
    expect(governed).toContain('phase1-conformance.lock.json');
    expect(governed).toContain('scripts/contract-canary.mjs');
    expect(pathsNeedingCiFull(governed, governed)).toHaveLength(governed.length);
  });

  test.each([
    'src-tauri/src/coven_runtime.rs',
    'src-tauri/Cargo.lock',
    'scripts/unix-producer-supervisor.sh',
    'scripts/windows-profile-residual-policy.test.ps1',
    'scripts/phase1-windows-supervisor-build.sh',
    'scripts/supervised-exec.mjs',
    'scripts/packaged-acceptance/run.mjs',
    '.github/workflows/packaged-acceptance.yml',
    '.github/workflows/ci.yml',
    'src/phase1-windows-supervisor.test.ts',
  ])('needs ci:full for %s', (path) => {
    expect(pathsNeedingCiFull([path], governed)).toHaveLength(1);
  });

  test('gives every reason a path needs ci:full', () => {
    expect(pathsNeedingCiFull(['src-tauri/src/lib.rs'], governed)).toEqual([
      {
        path: 'src-tauri/src/lib.rs',
        why: 'Rust, Windows supervisor behavior and Packaged acceptance (Windows) build it; Phase 1 real-authority conformance runs it',
      },
    ]);
  });

  test.each([
    'src/coven/chat-app.tsx',
    'src/lib/coven-runtime.ts',
    'docs/agents/working-here.md',
    'apps/ios/ChatCompanion/UITests/CompanionFlowTests.swift',
    'scripts/native-acceptance/run.mjs',
    'scripts/ci-full-check.mjs',
    '.github/workflows/ci-full-label.yml',
  ])("doesn't need ci:full for %s", (path) => {
    expect(pathsNeedingCiFull([path], governed)).toEqual([]);
  });

  test('passes with the label, fails without it, and names the paths', () => {
    const paths = ['docs/README.md', 'src-tauri/src/lib.rs'];
    const missing = checkCiFull(paths, ['bug'], governed);
    expect(missing.status).toBe(1);
    expect(missing.message).toContain('only under the ci:full label');
    expect(missing.message).toContain('src-tauri/src/lib.rs');
    expect(missing.message).not.toContain('docs/README.md');
    expect(checkCiFull(paths, ['bug', 'ci:full'], governed).status).toBe(0);
    expect(checkCiFull(['docs/README.md'], [], governed)).toEqual({
      status: 0,
      message: 'No changed path needs ci:full.',
    });
  });

  test('reads changed paths from stdin and labels from --labels', () => {
    const run = (input: string, labels: string) =>
      spawnSync(process.execPath, [script, '--labels', labels], { input, encoding: 'utf8' });
    const missing = run('src/coven/chat-app.tsx\nsrc-tauri/src/lib.rs\n', 'bug,area:design');
    expect(missing.status).toBe(1);
    expect(missing.stdout).toMatch(/^::error title=ci:full label missing::/u);
    expect(missing.stdout).toContain('%0A  src-tauri/src/lib.rs (');
    const labelled = run('src-tauri/src/lib.rs\n', 'ci:full');
    expect(labelled.status).toBe(0);
    expect(labelled.stdout).toContain('ci:full is set');
    expect(run('README.md\n', '').status).toBe(0);
    const usage = spawnSync(process.execPath, [script], { input: '', encoding: 'utf8' });
    expect(usage.status).toBe(2);
  });
});
