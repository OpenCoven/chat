#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolvePublishedInstaller } from './release-smoke.mjs';

try {
  const [file, version, suffix, ...extra] = process.argv.slice(2);
  if (!file || !version || !suffix || extra.length)
    throw new Error('Usage: release-installer.mjs <SHA256SUMS> <version> <platform suffix>');
  process.stdout.write(
    `${resolvePublishedInstaller(readFileSync(file, 'utf8'), version, suffix)}\n`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
