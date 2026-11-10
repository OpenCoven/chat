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

const OFF = 'const ASKING_ENABLED: bool = false;';
const ON = 'const ASKING_ENABLED: bool = true;';
const DECLINE = '      onDeclineApproval={(approval) => void declineApproval(approval)}\n';
const LOG = '      onPermissionLog={() => runtime.permissionLog()}\n';

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
} else if (count(windowSource, DECLINE) === 1) {
  plan.push([window, windowSource.replace(DECLINE, DECLINE + LOG), "the window's log is back"]);
} else {
  console.error(`Expected exactly one onDeclineApproval line in ${window}; nothing was changed.`);
  process.exit(1);
}
// Both files are checked before either is written, so a refusal changes nothing.
for (const [path, text, said] of plan) {
  writeFileSync(path, text);
  console.log(`${said}, in this checkout, for this candidate only.`);
}
