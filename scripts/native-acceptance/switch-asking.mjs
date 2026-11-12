#!/usr/bin/env node
// For a candidate run only (#573). Switches asking for permission on in this
// checkout before it is built, so the asking rows can be driven while the
// shipping setting stays off. It undoes #562's two switches and nothing else:
// `ASKING_ENABLED` in the host, and the window's permission log in Settings ›
// Access, which #562 hid by no longer passing `onPermissionLog`. The build it
// makes is driven on the runner and thrown away: the lanes stage installers
// outside the uploaded results, and run.mjs refuses this mode for a release.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Path arguments are for tests; the workflow passes none.
const host = process.argv[2] ?? join(repo, 'src-tauri', 'src', 'chat_approvals.rs');
const window = process.argv[3] ?? join(repo, 'src', 'coven', 'chat-app.tsx');
const runtime = process.argv[4] ?? join(repo, 'src-tauri', 'src', 'coven_runtime.rs');

// Full-access chats cannot be qualified by turning legacy approval prompts back on.
// Refuse before either source file is changed or a misleading candidate is built.
if (/"--permission"\.into\(\),\s*"full"\.into\(\)/.test(readFileSync(runtime, 'utf8'))) {
  console.error('This is a full-access candidate. Use asking=as-built; nothing was changed.');
  process.exit(1);
}

const OFF = 'const ASKING_ENABLED: bool = false;';
const ON = 'const ASKING_ENABLED: bool = true;';
// Windows runners check out with CRLF line endings, so the line's own ending is kept.
const DECLINE =
  /^( *)onDeclineApproval=\{\(approval\) => void declineApproval\(approval\)\}(\r?\n)/gm;
const LOG = 'onPermissionLog={() => runtime.permissionLog()}';

const count = (text, part) => text.split(part).length - 1;
const plan = [];
const hostSource = readFileSync(host, 'utf8');
if (count(hostSource, ON) === 1 && !hostSource.includes(OFF)) {
  console.log('ASKING_ENABLED is already on in this checkout.');
} else if (count(hostSource, OFF) === 1) {
  plan.push([host, hostSource.replace(OFF, ON), 'ASKING_ENABLED is switched on']);
} else {
  console.error(`Expected exactly one "${OFF}" in ${host}; nothing was changed.`);
  process.exit(1);
}
const windowSource = readFileSync(window, 'utf8');
if (windowSource.includes(LOG)) {
  console.log("The window's permission log is already passed in this checkout.");
} else if ([...windowSource.matchAll(DECLINE)].length === 1) {
  const restored = windowSource.replace(
    DECLINE,
    (line, indent, end) => `${line}${indent}${LOG}${end}`,
  );
  plan.push([window, restored, "the window's log is back"]);
} else {
  console.error(`Expected exactly one onDeclineApproval line in ${window}; nothing was changed.`);
  process.exit(1);
}
// Both files are checked before either is written, so a refusal changes nothing.
for (const [path, text, said] of plan) {
  writeFileSync(path, text);
  console.log(`${said}, in this checkout, for this candidate only.`);
}
