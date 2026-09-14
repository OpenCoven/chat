import { existsSync, readFileSync } from 'node:fs';
import { expect, test } from 'vitest';

test('ships one operational Coven surface without URL or build-time demo modes', () => {
  const entrypoint = readFileSync('src/main.tsx', 'utf8');

  expect(entrypoint).toContain("from './coven/chat-app'");
  expect(entrypoint).not.toMatch(/VITE_DEFAULT_DEMO|URLSearchParams|surfaceFor/);
  expect(entrypoint).not.toMatch(/import\(['"]\.\/demo\/|from ['"]\.\/app['"]/);
});

test('has one desktop build identity rather than an alternate demo build', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));

  expect(manifest.scripts).not.toHaveProperty('app:build:demo');
  expect(existsSync('src-tauri/tauri.demo.conf.json')).toBe(false);
  expect(readFileSync('src/vite-env.d.ts', 'utf8')).not.toContain('VITE_DEFAULT_DEMO');
});

test('describes the packaged app as a Coven CLI client, not an optional Cave mode', () => {
  const config = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));

  expect(config.bundle.longDescription).toContain('Coven CLI');
  expect(config.bundle.longDescription).not.toMatch(/pair|Cave/);
});
