#!/usr/bin/env node
// `corepack pnpm app:dev`: runs `tauri dev`, after checking that the dev
// server's port is free. Without the check a taken port surfaced as a Vite
// stack trace followed by Tauri's "beforeDevCommand terminated", which said
// nothing about what to do. See scripts/dev-port.mjs for OPENCOVEN_CHAT_DEV_PORT.
import { spawn } from 'node:child_process';
import { devPort, portInUseMessage, portIsFree, tauriDevArgs } from './dev-port.mjs';

let port;
try {
  port = devPort();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
}

if (!(await portIsFree(port))) {
  console.error(portInUseMessage(port));
  process.exit(1);
}

const child = spawn('tauri', tauriDevArgs(port, process.argv.slice(2)), {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});
