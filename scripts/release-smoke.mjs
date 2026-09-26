#!/usr/bin/env node
// Smoke-test the assembled release directory in the publish job, after the
// per-platform builds and SHA256SUMS. Each build job already checks its own
// installers; this checks the set as a whole before anything is published:
// every installer is present exactly once, SHA256SUMS covers every asset and
// matches its bytes, the version and product identity agree with the tagged
// tree, and the updater and signing state is stated rather than implied.
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PRODUCT_NAME = 'OpenCoven Chat';
export const IDENTIFIER = 'ai.opencoven.chat';
const CHECKSUMS = 'SHA256SUMS';
const UPDATER_MANIFEST = 'latest.json';
const MAC_TARGETS = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];

/** Installer names exactly as the six release build targets emit them. */
export function expectedInstallers(version, product = PRODUCT_NAME) {
  const prefix = `${product}_${version}`;
  return [
    `${prefix}_aarch64.dmg`,
    `${prefix}_x64.dmg`,
    `${prefix}_x64_en-US.msi`,
    `${prefix}_x64-setup.exe`,
    `${prefix}_amd64.AppImage`,
    `${prefix}_amd64.deb`,
  ];
}

/**
 * Updater archives mapped to their Tauri updater platform key. The macOS
 * archive carries no arch, so the build job prefixes it with its target.
 */
export function expectedUpdaterArchives(version, product = PRODUCT_NAME) {
  const prefix = `${product}_${version}`;
  return new Map([
    [`${MAC_TARGETS[0]}-${product}.app.tar.gz`, 'darwin-aarch64'],
    [`${MAC_TARGETS[1]}-${product}.app.tar.gz`, 'darwin-x86_64'],
    [`${prefix}_x64_en-US.msi.zip`, 'windows-x86_64'],
    [`${prefix}_x64-setup.nsis.zip`, 'windows-x86_64'],
    [`${prefix}_amd64.AppImage.tar.gz`, 'linux-x86_64'],
  ]);
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function cargoPackageVersion(text) {
  let inPackage = false;
  for (const line of text.split('\n')) {
    const section = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (section) {
      inPackage = section[1] === 'package';
      continue;
    }
    const version = inPackage ? /^version\s*=\s*"([^"]*)"/.exec(line) : null;
    if (version) return version[1];
  }
  return undefined;
}

/** Parse `shasum -a 256` output, text or binary mode, one entry per line. */
export function parseChecksums(text) {
  const entries = new Map();
  const problems = [];
  for (const [index, line] of text.split('\n').entries()) {
    if (line === '') continue;
    const match = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (!match) {
      problems.push(`${CHECKSUMS} line ${index + 1} is not a SHA-256 entry.`);
      continue;
    }
    if (entries.has(match[2])) {
      problems.push(`${CHECKSUMS} lists ${match[2]} more than once.`);
      continue;
    }
    entries.set(match[2], match[1]);
  }
  return { entries, problems };
}

export function smokeTestRelease({ releaseDir, root, version, tag, allowUnsigned = false }) {
  const failures = [];
  const fail = (message) => failures.push(message);

  // Identity and version agreement with the tagged tree.
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const tauriConf = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const cargoVersion = cargoPackageVersion(
    readFileSync(join(root, 'src-tauri/Cargo.toml'), 'utf8'),
  );
  const versions = {
    expected: version,
    'package.json': packageJson.version,
    'tauri.conf.json': tauriConf.version,
    'Cargo.toml': cargoVersion,
    ...(tag === undefined ? {} : { tag: tag.replace(/^v/, '') }),
  };
  for (const [source, value] of Object.entries(versions)) {
    if (value !== version)
      fail(`Version ${JSON.stringify(value)} from ${source} does not match ${version}.`);
  }
  if (tauriConf.productName !== PRODUCT_NAME)
    fail(`productName is ${JSON.stringify(tauriConf.productName)}, not ${PRODUCT_NAME}.`);
  if (tauriConf.identifier !== IDENTIFIER)
    fail(`identifier is ${JSON.stringify(tauriConf.identifier)}, not ${IDENTIFIER}.`);

  // Inventory: regular, non-empty files only, and nothing unaccounted for.
  const files = new Map();
  for (const name of readdirSync(releaseDir)) {
    const stats = lstatSync(join(releaseDir, name));
    if (!stats.isFile()) {
      fail(`${name} is not a regular file.`);
      continue;
    }
    files.set(name, stats.size);
  }
  const installers = expectedInstallers(version);
  for (const name of installers) {
    if (!files.has(name)) fail(`Missing installer: ${name}.`);
    else if (files.get(name) === 0) fail(`Installer is empty: ${name}.`);
  }

  // Updater state follows the configuration, and the assets must agree with it.
  const updaterConfigured = tauriConf.bundle?.createUpdaterArtifacts === true;
  const archives = expectedUpdaterArchives(version);
  const presentArchives = [...archives.keys()].filter((name) => files.has(name));
  const signatures = [...files.keys()].filter((name) => name.endsWith('.sig'));
  const hasManifest = files.has(UPDATER_MANIFEST);
  if (!updaterConfigured) {
    for (const name of [...presentArchives, ...signatures])
      fail(`Updater asset ${name} is present but createUpdaterArtifacts is off.`);
    if (hasManifest) fail(`${UPDATER_MANIFEST} is present but createUpdaterArtifacts is off.`);
  } else {
    if (presentArchives.length === 0)
      fail('createUpdaterArtifacts is on but no updater archive was produced.');
    // latest.json carries one entry per platform, and the manifest step
    // refuses two archives for one platform, so neither may this check.
    const byPlatform = new Map();
    for (const name of presentArchives) {
      const key = archives.get(name);
      if (byPlatform.has(key)) {
        fail(`Updater archives ${byPlatform.get(key)} and ${name} both map to ${key}.`);
      }
      byPlatform.set(key, name);
    }
    for (const name of presentArchives) {
      if (!files.has(`${name}.sig`)) fail(`Updater archive ${name} has no signature.`);
      else if (files.get(`${name}.sig`) === 0) fail(`Updater signature ${name}.sig is empty.`);
    }
    for (const sig of signatures) {
      if (!archives.has(sig.slice(0, -'.sig'.length)))
        fail(`Signature ${sig} matches no updater archive.`);
    }
    if (!hasManifest) {
      fail(`Updater archives are present but ${UPDATER_MANIFEST} is missing.`);
    } else {
      const manifest = JSON.parse(readFileSync(join(releaseDir, UPDATER_MANIFEST), 'utf8'));
      if (manifest.version !== version)
        fail(
          `${UPDATER_MANIFEST} version ${JSON.stringify(manifest.version)} does not match ${version}.`,
        );
      const expectedPlatforms = new Set(presentArchives.map((name) => archives.get(name)));
      const platforms = Object.keys(manifest.platforms ?? {});
      for (const key of expectedPlatforms)
        if (!platforms.includes(key)) fail(`${UPDATER_MANIFEST} has no ${key} entry.`);
      for (const key of platforms)
        if (!expectedPlatforms.has(key))
          fail(`${UPDATER_MANIFEST} names ${key} without a matching archive.`);
    }
  }

  const known = new Set([
    ...installers,
    ...archives.keys(),
    ...[...archives.keys()].map((name) => `${name}.sig`),
    CHECKSUMS,
    UPDATER_MANIFEST,
  ]);
  for (const name of files.keys()) if (!known.has(name)) fail(`Unexpected release asset: ${name}.`);

  // SHA256SUMS covers every other asset exactly once and matches its bytes.
  if (!files.has(CHECKSUMS)) {
    fail(`${CHECKSUMS} is missing.`);
  } else {
    const { entries, problems } = parseChecksums(readFileSync(join(releaseDir, CHECKSUMS), 'utf8'));
    problems.forEach(fail);
    for (const name of files.keys()) {
      if (name === CHECKSUMS) continue;
      if (!entries.has(name)) fail(`${CHECKSUMS} does not cover ${name}.`);
      else if (entries.get(name) !== sha256(join(releaseDir, name)))
        fail(`${CHECKSUMS} digest for ${name} does not match its bytes.`);
    }
    for (const name of entries.keys())
      if (!files.has(name)) fail(`${CHECKSUMS} lists ${name}, which is not a release asset.`);
  }

  return {
    ok: failures.length === 0,
    failures,
    version,
    installers: installers.filter((name) => files.has(name)),
    updater: updaterConfigured
      ? { state: 'enabled', archives: presentArchives, manifest: hasManifest }
      : {
          state: 'disabled',
          reason: 'bundle.createUpdaterArtifacts is false; no updater archives or latest.json',
        },
    // Code signatures are verified in the build jobs; this records what the
    // run declared so the summary cannot read as signed when it was not.
    signing: allowUnsigned
      ? {
          state: 'unsigned',
          reason: 'allow_unsigned rehearsal; these artifacts must not be handed to users',
        }
      : {
          state: 'required',
          reason: 'signing material was required by verify-tag and checked in the build jobs',
        },
  };
}

function parseArguments(argv) {
  const options = { allowUnsigned: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--allow-unsigned') {
      options.allowUnsigned = true;
      continue;
    }
    const key = { '--dir': 'releaseDir', '--version': 'version', '--tag': 'tag', '--root': 'root' }[
      flag
    ];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || value.startsWith('--')) {
      throw new Error(
        `Usage: release-smoke.mjs --dir <release> --version <x.y.z> [--tag <vX.Y.Z>] [--root <repo>] [--allow-unsigned] (bad argument ${flag})`,
      );
    }
    options[key] = value;
    index += 1;
  }
  if (options.releaseDir === undefined || options.version === undefined) {
    throw new Error('release-smoke.mjs requires --dir and --version.');
  }
  return options;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const report = smokeTestRelease({ ...options, root: options.root ?? process.cwd() });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    for (const failure of report.failures) process.stderr.write(`::error::${failure}\n`);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
