#!/usr/bin/env node
// Write the Tauri updater feed (latest.json) for a release from the signed
// updater artifacts the build jobs staged. The publish job runs this only when
// the build reported the updater on, then the release smoke test checks the
// result against the same table (expectedUpdaterArtifacts), and the publish
// job copies it to the `updater` pointer release that installed apps read.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expectedUpdaterArtifacts } from './release-smoke.mjs';

/**
 * Every artifact must be present with a non-empty signature: a feed missing a
 * platform would leave that platform's installs on the old version without a
 * word, so a gap fails the release instead.
 */
export function buildUpdaterManifest({ releaseDir, version, tag, repo, notes, pubDate }) {
  const base = `https://github.com/${repo}/releases/download/${tag}`;
  const platforms = {};
  for (const [name, keys] of expectedUpdaterArtifacts(version)) {
    if (!existsSync(join(releaseDir, name)))
      throw new Error(`Updater artifact ${name} is missing.`);
    const sigPath = join(releaseDir, `${name}.sig`);
    if (!existsSync(sigPath)) throw new Error(`Updater artifact ${name} has no signature.`);
    // The feed carries the signature's contents; a path or URL is not accepted.
    const signature = readFileSync(sigPath, 'utf8').trim();
    if (!signature) throw new Error(`Updater signature ${name}.sig is empty.`);
    for (const key of keys)
      platforms[key] = { signature, url: `${base}/${encodeURIComponent(name)}` };
  }
  return { version, notes, pub_date: pubDate, platforms };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = {
      '--dir': 'releaseDir',
      '--version': 'version',
      '--tag': 'tag',
      '--repo': 'repo',
      '--out': 'out',
    }[argv[index]];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || value.startsWith('--')) {
      throw new Error(
        `Usage: updater-manifest.mjs --dir <release> --version <x.y.z> --tag <vX.Y.Z> --repo <owner/name> --out <latest.json> (bad argument ${argv[index]})`,
      );
    }
    options[key] = value;
  }
  for (const required of ['releaseDir', 'version', 'tag', 'repo', 'out'])
    if (options[required] === undefined)
      throw new Error(
        `updater-manifest.mjs requires --${required === 'releaseDir' ? 'dir' : required}.`,
      );
  return options;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const manifest = buildUpdaterManifest({
      ...options,
      notes: `OpenCoven Chat ${options.version}: https://github.com/${options.repo}/releases/tag/${options.tag}`,
      pubDate: new Date().toISOString(),
    });
    writeFileSync(options.out, `${JSON.stringify(manifest, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
