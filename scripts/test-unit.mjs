#!/usr/bin/env node
// `pnpm test:unit`: run the normal Vitest suite, then the heavy one, and fail
// if either failed. Chaining them with `&&` hid the heavy suite's results
// whenever the normal one failed. CI runs the two halves as separate steps.
import { spawnSync } from 'node:child_process';

const halves = ['test:unit:normal', 'test:unit:heavy'];
const failed = [];

for (const half of halves) {
  // One command string, so the shell finds corepack's .cmd shim on Windows.
  const result = spawnSync(`corepack pnpm@10.34.0 --ignore-workspace ${half}`, {
    shell: true,
    stdio: 'inherit',
  });
  if (result.error) {
    console.error(`test:unit: couldn't start ${half}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    failed.push(half);
  }
}

if (failed.length > 0) {
  console.error(`test:unit: ${failed.join(' and ')} failed.`);
  process.exit(1);
}
