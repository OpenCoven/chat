import { createServer } from 'node:net';

// The dev server's port. Tauri's devUrl, README and docs/developer-toolchains.md
// name 4173, and it stays the default. Several worktrees, or an unrelated local
// server, can hold 4173 at once on one machine; `OPENCOVEN_CHAT_DEV_PORT` picks
// another port for `pnpm dev` and `pnpm app:dev` without editing tracked files.
export const DEFAULT_DEV_PORT = 4173;
export const DEV_PORT_ENV = 'OPENCOVEN_CHAT_DEV_PORT';

export function devPort(env = process.env) {
  const raw = env[DEV_PORT_ENV];
  if (raw === undefined || raw.trim() === '') return DEFAULT_DEV_PORT;
  const value = raw.trim();
  const port = Number(value);
  if (!/^\d+$/u.test(value) || !Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(
      `${DEV_PORT_ENV} must be a port number from 1024 to 65535; it is ${JSON.stringify(raw)}.`,
    );
  }
  return port;
}

// The arguments for `tauri dev`. On the default port they are exactly what
// `tauri dev` used before, so tauri.conf.json stays the one source; another
// port overrides devUrl and the dev server command for this run only.
export function tauriDevArgs(port, extra = []) {
  if (port === DEFAULT_DEV_PORT) return ['dev', ...extra];
  const config = {
    build: {
      beforeDevCommand: `corepack pnpm dev -- --host 127.0.0.1 --port ${port} --strictPort`,
      devUrl: `http://127.0.0.1:${port}/`,
    },
  };
  return ['dev', '--config', JSON.stringify(config), ...extra];
}

// Resolves to true when 127.0.0.1:<port> can be bound right now.
export function portIsFree(port, host = '127.0.0.1') {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.once('error', () => resolvePromise(false));
    server.listen({ port, host, exclusive: true }, () => {
      server.close(() => resolvePromise(true));
    });
  });
}

export function portInUseMessage(port) {
  const next = port === DEFAULT_DEV_PORT ? DEFAULT_DEV_PORT + 7 : port + 1;
  return [
    `Port ${port} on 127.0.0.1 is already in use, so the dev server cannot start.`,
    'Another `pnpm dev` or `pnpm app:dev` (perhaps in another worktree) or an unrelated local server holds it;',
    `\`lsof -nP -iTCP:${port} -sTCP:LISTEN\` shows which. To use another port for this run:`,
    `  ${DEV_PORT_ENV}=${next} corepack pnpm app:dev`,
  ].join('\n');
}
