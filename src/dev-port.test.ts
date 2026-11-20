import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:net';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_DEV_PORT,
  devPort,
  portInUseMessage,
  portIsFree,
  tauriDevArgs,
} from '../scripts/dev-port.mjs';

const projectRoot = resolve(import.meta.dirname, '..');
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
});

// Holds a free 127.0.0.1 port for the rest of the test.
async function holdPort(): Promise<number> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((done) => server.listen({ port: 0, host: '127.0.0.1' }, () => done()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

describe('dev server port', () => {
  it('stays 4173, the port tauri.conf.json and the docs name, unless overridden', () => {
    const config = JSON.parse(
      readFileSync(resolve(projectRoot, 'src-tauri/tauri.conf.json'), 'utf8'),
    );
    expect(DEFAULT_DEV_PORT).toBe(4173);
    expect(config.build.devUrl).toBe(`http://127.0.0.1:${DEFAULT_DEV_PORT}/`);
    expect(config.build.beforeDevCommand).toContain(`--port ${DEFAULT_DEV_PORT} --strictPort`);
    expect(devPort({})).toBe(4173);
    expect(devPort({ OPENCOVEN_CHAT_DEV_PORT: '' })).toBe(4173);
    expect(devPort({ OPENCOVEN_CHAT_DEV_PORT: ' 4180 ' })).toBe(4180);
  });

  it.each(['abc', '41.5', '-1', '80', '65536', '4180x'])('refuses %j as a port', (value) => {
    expect(() => devPort({ OPENCOVEN_CHAT_DEV_PORT: value })).toThrow(
      'OPENCOVEN_CHAT_DEV_PORT must be a port number from 1024 to 65535',
    );
  });

  it('runs plain `tauri dev` on the default port', () => {
    expect(tauriDevArgs(4173)).toEqual(['dev']);
    expect(tauriDevArgs(4173, ['--release'])).toEqual(['dev', '--release']);
  });

  it('points devUrl and the dev server at another port together', () => {
    const args = tauriDevArgs(4180, ['--verbose']);
    expect(args[0]).toBe('dev');
    expect(args[1]).toBe('--config');
    expect(JSON.parse(args[2] ?? '{}')).toEqual({
      build: {
        beforeDevCommand: 'corepack pnpm dev -- --host 127.0.0.1 --port 4180 --strictPort',
        devUrl: 'http://127.0.0.1:4180/',
      },
    });
    expect(args.slice(3)).toEqual(['--verbose']);
  });

  it('sees a held port as taken and a released one as free', async () => {
    const port = await holdPort();
    expect(await portIsFree(port)).toBe(false);
    await new Promise<void>((done) => servers.pop()?.close(() => done()));
    expect(await portIsFree(port)).toBe(true);
  });

  it('app:dev stops before Tauri starts when the port is taken, and says how to move', async () => {
    // Before this, a taken port printed a Vite stack trace and then Tauri's
    // "beforeDevCommand terminated with a non-zero status code".
    const port = await holdPort();
    const result = spawnSync(process.execPath, [resolve(projectRoot, 'scripts/app-dev.mjs')], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, OPENCOVEN_CHAT_DEV_PORT: String(port), PATH: '' },
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe(`${portInUseMessage(port)}\n`);
    expect(result.stderr).toContain(`OPENCOVEN_CHAT_DEV_PORT=${port + 1} corepack pnpm app:dev`);
  });

  it('app:dev refuses an unusable OPENCOVEN_CHAT_DEV_PORT before starting anything', () => {
    const result = spawnSync(process.execPath, [resolve(projectRoot, 'scripts/app-dev.mjs')], {
      cwd: projectRoot,
      encoding: 'utf8',
      env: { ...process.env, OPENCOVEN_CHAT_DEV_PORT: 'nope', PATH: '' },
      timeout: 10_000,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('OPENCOVEN_CHAT_DEV_PORT must be a port number');
  });

  it('wires app:dev and the Vite server through the same port', () => {
    const pkg = JSON.parse(readFileSync(resolve(projectRoot, 'package.json'), 'utf8'));
    expect(pkg.scripts['app:dev']).toBe('node scripts/app-dev.mjs');
    const vite = readFileSync(resolve(projectRoot, 'vite.config.ts'), 'utf8');
    expect(vite).toContain("import { devPort } from './scripts/dev-port.mjs';");
    expect(vite).toContain('port: devPort(),');
  });
});
