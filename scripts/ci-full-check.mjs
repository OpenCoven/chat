#!/usr/bin/env node
// Does this pull request need the `ci:full` label?
//
//   <changed paths, one per line> | node scripts/ci-full-check.mjs --labels "<label>,<label>"
//
// On a pull request, ci.yml runs Rust, Phase 1 real-authority conformance,
// Windows supervisor behavior, Packaged acceptance (Windows), Windows profile
// residual cleanup and the macOS leg of Unix producer supervisor only under
// `ci:full`. Without the label they report
// `skipped`, branch protection accepts that, and the PR looks green with that
// code never built. This check fails instead, naming the paths, when a PR
// changes what those jobs test and doesn't carry the label.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ciFullLabel = 'ci:full';

// The jobs in ci.yml that run on a pull request only under `ci:full`.
// src/ci-full-check.test.ts fails if ci.yml gates a different set.
export const ciFullJobs = [
  'phase1-conformance',
  'packaged-acceptance-windows',
  'rust',
  'windows-profile-residual',
  'unix-supervisor',
  'windows-supervisor-behavior',
];

// What those jobs build or run. src/ci-full-check.test.ts checks that every
// path they name in ci.yml matches one of these.
export const ciFullRules = [
  {
    pattern: /^tools\/phase1-process-supervisor(?:\/|$)/u,
    why: 'Rust builds the Windows supervisor',
  },
  {
    pattern:
      /^(?:\.node-version|vite\.config\.ts|vitest\.heavy\.config\.ts|src\/test\/setup\.ts|rust-toolchain\.toml)$/u,
    why: 'the gated jobs use this toolchain or test configuration',
  },
  {
    pattern: /^src-tauri\//u,
    why: 'Rust, Windows supervisor behavior and Packaged acceptance (Windows) build it',
  },
  {
    pattern: /^scripts\/(?:unix-|windows-|phase1-windows-)/u,
    why: 'the Unix and Windows supervisor and Windows profile jobs run it',
  },
  { pattern: /^scripts\/[^/]*supervis/u, why: 'the supervisor jobs run it' },
  {
    pattern: /^(?:scripts\/packaged-acceptance\/|\.github\/workflows\/packaged-acceptance\.yml$)/u,
    why: 'Packaged acceptance (Windows) runs it',
  },
  {
    pattern:
      /^src\/(?:windows-supervisor-source|phase1-windows-supervisor|phase1-conformance)\.test\.ts$/u,
    why: 'Windows supervisor behavior runs it',
  },
  { pattern: /^\.github\/workflows\/ci\.yml$/u, why: 'it defines the jobs that need the label' },
];

/**
 * The files Phase 1 real-authority conformance runs: the lock itself and every
 * file it governs, read from a phase1-conformance.lock.json's text.
 */
export function governedPaths(lockText) {
  const authority = JSON.parse(lockText).harnessAuthority;
  return [
    'phase1-conformance.lock.json',
    ...[...authority.files, ...authority.productionDeltas].map((entry) => entry.path),
  ];
}

/** The changed paths that need `ci:full`, each with the reason. */
export function pathsNeedingCiFull(paths, governed = []) {
  const found = [];
  for (const path of paths) {
    const reasons = ciFullRules.filter((rule) => rule.pattern.test(path)).map((rule) => rule.why);
    if (governed.includes(path)) reasons.push('Phase 1 real-authority conformance runs it');
    if (reasons.length > 0) found.push({ path, why: reasons.join('; ') });
  }
  return found;
}

/** The message and exit status for a PR with these changed paths and labels. */
export function checkCiFull(paths, labels, governed = []) {
  const needing = pathsNeedingCiFull(paths, governed);
  if (needing.length === 0) {
    return { status: 0, message: 'No changed path needs ci:full.' };
  }
  const list = needing.map(({ path, why }) => `  ${path} (${why})`).join('\n');
  if (labels.includes(ciFullLabel)) {
    return { status: 0, message: `ci:full is set, and these paths need it:\n${list}` };
  }
  return {
    status: 1,
    message:
      'This pull request changes code that some CI jobs (Rust, Phase 1 conformance, the ' +
      'Windows and Unix supervisor jobs) test only under the ci:full label. Without the label ' +
      "they report skipped, and that isn't a pass. Add ci:full (it starts a new CI run):" +
      `\n${list}`,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const labelsAt = args.indexOf('--labels');
  if (labelsAt === -1 || args.length !== 2) {
    console.error(
      'usage: <changed paths> | node scripts/ci-full-check.mjs --labels "<label>,<label>"',
    );
    process.exit(2);
  }
  const labels = args[labelsAt + 1]
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean);
  const paths = readFileSync(0, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const lockPath = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'phase1-conformance.lock.json',
  );
  const { status, message } = checkCiFull(
    paths,
    labels,
    governedPaths(readFileSync(lockPath, 'utf8')),
  );
  if (status === 0) console.log(message);
  else console.log(`::error title=ci:full label missing::${message.replaceAll('\n', '%0A')}`);
  process.exit(status);
}
