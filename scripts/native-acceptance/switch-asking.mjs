#!/usr/bin/env node
// For a candidate run only (#573). Switches asking for permission on in this
// checkout before it is built, so the asking rows can be driven while the
// shipping setting stays off. The build it makes is driven on the runner and
// thrown away: the lanes stage installers outside the uploaded results, and
// run.mjs refuses this mode for a published release.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// A path argument is for tests; the workflow passes none.
const path = process.argv[2] ?? join(repo, 'src-tauri', 'src', 'chat_approvals.rs');
const off = 'const ASKING_ENABLED: bool = false;';
const on = 'const ASKING_ENABLED: bool = true;';
const source = readFileSync(path, 'utf8');
if (source.split(on).length === 2 && !source.includes(off)) {
  console.log('Asking for permission is already on in this checkout.');
} else if (source.split(off).length === 2) {
  writeFileSync(path, source.replace(off, on));
  console.log('Asking for permission is switched on in this checkout, for this candidate only.');
} else {
  console.error(`Expected exactly one "${off}" in ${path}; nothing was changed.`);
  process.exit(1);
}
