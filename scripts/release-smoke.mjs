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

/**
 * The name GitHub gives an uploaded asset: it replaces each space with a dot,
 * so `OpenCoven Chat_0.0.3_x64.dmg` is served as `OpenCoven.Chat_0.0.3_x64.dmg`.
 * The publish job renames the files the same way before writing SHA256SUMS and
 * latest.json, so both name what people actually download (v0.0.2 and v0.0.3
 * listed the spaced names, and `shasum -c` reported every download missing).
 */
export function assetName(name) {
  return name.replaceAll(' ', '.');
}

/**
 * Installer names as published: the build targets' names, under assetName.
 * The Windows installers ship unsigned by decision (2026-10-14; #411 tracks
 * a signing route); the report's `signing.windows` says which it was.
 */
export function expectedInstallers(version, product = PRODUCT_NAME) {
  const prefix = `${assetName(product)}_${version}`;
  return [
    `${prefix}_aarch64.dmg`,
    `${prefix}_x64.dmg`,
    `${prefix}_x64_en-US.msi`,
    `${prefix}_x64-setup.exe`,
    `${prefix}_amd64.AppImage`,
    `${prefix}_amd64.deb`,
  ];
}

const WINDOWS_SIGNING_STATES = ['signed', 'unsigned'];

/**
 * The files the updater downloads, mapped to the latest.json platform keys
 * that point at them. With `bundle.createUpdaterArtifacts: true`, Tauri v2
 * signs the Windows and Linux installers themselves (tauri-cli 2.11.4
 * `sign_updaters`) and archives only the macOS app, which carries no arch, so
 * the build job prefixes it with its target. tauri-plugin-updater 2.12 looks
 * up `{os}-{arch}-{installer}` first and then `{os}-{arch}`, so every
 * installer type has its own key and each platform also has a default: the
 * per-user NSIS installer on Windows and the AppImage on Linux.
 */
export function expectedUpdaterArtifacts(version, product = PRODUCT_NAME) {
  const stem = assetName(product);
  const prefix = `${stem}_${version}`;
  return new Map([
    [`${MAC_TARGETS[0]}-${stem}.app.tar.gz`, ['darwin-aarch64-app', 'darwin-aarch64']],
    [`${MAC_TARGETS[1]}-${stem}.app.tar.gz`, ['darwin-x86_64-app', 'darwin-x86_64']],
    [`${prefix}_x64_en-US.msi`, ['windows-x86_64-msi']],
    [`${prefix}_x64-setup.exe`, ['windows-x86_64-nsis', 'windows-x86_64']],
    [`${prefix}_amd64.AppImage`, ['linux-x86_64-appimage', 'linux-x86_64']],
    [`${prefix}_amd64.deb`, ['linux-x86_64-deb']],
  ]);
}

const UPDATER_STATES = ['on', 'off'];

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

export function smokeTestRelease({
  releaseDir,
  root,
  version,
  tag,
  allowUnsigned = false,
  windowsSigning = 'unsigned',
  updater = 'off',
}) {
  if (!WINDOWS_SIGNING_STATES.includes(windowsSigning)) {
    throw new Error(
      `windowsSigning must be one of ${WINDOWS_SIGNING_STATES.join(', ')}, not ${JSON.stringify(windowsSigning)}.`,
    );
  }
  if (!UPDATER_STATES.includes(updater)) {
    throw new Error(
      `updater must be one of ${UPDATER_STATES.join(', ')}, not ${JSON.stringify(updater)}.`,
    );
  }
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

  // Updater state. The tree configures the updater with `plugins.updater`;
  // the base config keeps `createUpdaterArtifacts` false so plain builds need
  // no key, and the release build turns it on through an overlay when the
  // signing key is present. The build job reports which happened (`updater`).
  const updaterConfigured = Boolean(tauriConf.plugins?.updater);
  const artifacts = expectedUpdaterArtifacts(version);
  const signatures = [...files.keys()].filter((name) => name.endsWith('.sig'));
  const macArchives = [...artifacts.keys()].filter(
    (name) => name.endsWith('.app.tar.gz') && files.has(name),
  );
  const hasManifest = files.has(UPDATER_MANIFEST);
  let updaterReport;
  if (updater === 'on' && updaterConfigured) {
    for (const [name] of artifacts) {
      if (!files.has(name)) fail(`Updater artifact ${name} is missing.`);
      if (!files.has(`${name}.sig`)) fail(`Updater artifact ${name} has no signature.`);
      else if (files.get(`${name}.sig`) === 0) fail(`Updater signature ${name}.sig is empty.`);
    }
    for (const sig of signatures) {
      if (!artifacts.has(sig.slice(0, -'.sig'.length)))
        fail(`Signature ${sig} matches no updater artifact.`);
    }
    const platforms = [...artifacts.values()].flat();
    if (!hasManifest) {
      fail(`The updater is on but ${UPDATER_MANIFEST} is missing.`);
    } else {
      const manifest = JSON.parse(readFileSync(join(releaseDir, UPDATER_MANIFEST), 'utf8'));
      if (manifest.version !== version)
        fail(
          `${UPDATER_MANIFEST} version ${JSON.stringify(manifest.version)} does not match ${version}.`,
        );
      const entries = manifest.platforms ?? {};
      for (const key of Object.keys(entries))
        if (!platforms.includes(key)) fail(`${UPDATER_MANIFEST} names unexpected platform ${key}.`);
      for (const [name, keys] of artifacts) {
        const signature = files.has(`${name}.sig`)
          ? readFileSync(join(releaseDir, `${name}.sig`), 'utf8').trim()
          : undefined;
        for (const key of keys) {
          const entry = entries[key];
          if (entry === undefined) {
            fail(`${UPDATER_MANIFEST} has no ${key} entry.`);
            continue;
          }
          const path = `/${tag ?? `v${version}`}/${encodeURIComponent(name)}`;
          if (typeof entry.url !== 'string' || !entry.url.endsWith(`/releases/download${path}`))
            fail(`${UPDATER_MANIFEST} ${key} does not point at ${name} in this release.`);
          if (signature !== undefined && entry.signature !== signature)
            fail(`${UPDATER_MANIFEST} ${key} signature differs from ${name}.sig.`);
        }
      }
    }
    updaterReport = {
      state: 'enabled',
      artifacts: [...artifacts.keys()].filter((name) => files.has(name)),
      manifest: hasManifest,
      platforms,
    };
  } else {
    if (updater === 'on')
      fail(
        'The build reported the updater on, but src-tauri/tauri.conf.json has no plugins.updater.',
      );
    else if (updaterConfigured && !allowUnsigned)
      fail(
        'src-tauri/tauri.conf.json configures the updater, but this run produced no updater artifacts. TAURI_SIGNING_PRIVATE_KEY and its password are required on the production path.',
      );
    for (const name of [...macArchives, ...signatures])
      fail(`Updater asset ${name} is present but the updater is off for this run.`);
    if (hasManifest) fail(`${UPDATER_MANIFEST} is present but the updater is off for this run.`);
    updaterReport = {
      state: 'disabled',
      reason: updaterConfigured
        ? 'allow_unsigned rehearsal without the updater signing key; no updater artifacts or latest.json'
        : 'src-tauri/tauri.conf.json configures no updater (plugins.updater); no updater artifacts or latest.json',
    };
  }

  const known = new Set([
    ...installers,
    ...artifacts.keys(),
    ...[...artifacts.keys()].map((name) => `${name}.sig`),
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
    updater: updaterReport,
    // Code signatures are verified in the build jobs; this records what the
    // run declared so the summary cannot read as signed when it was not.
    // `state` covers the platforms whose signing is required (macOS);
    // `windows` records the Windows build job's decision separately, because
    // Windows may ship unsigned on the production path.
    signing: {
      ...(allowUnsigned
        ? {
            state: 'unsigned',
            reason: 'allow_unsigned rehearsal; these artifacts must not be handed to users',
          }
        : {
            state: 'required',
            reason: 'signing material was required by verify-tag and checked in the build jobs',
          }),
      windows:
        windowsSigning === 'signed' && !allowUnsigned
          ? {
              state: 'signed',
              reason:
                'WINDOWS_CERTIFICATE was configured; Authenticode verified in the Windows build job',
            }
          : {
              state: 'unsigned',
              reason:
                'no Windows code-signing certificate is configured (#411); SmartScreen warns before the installer runs',
            },
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
    const key = {
      '--dir': 'releaseDir',
      '--version': 'version',
      '--tag': 'tag',
      '--root': 'root',
      '--windows-signing': 'windowsSigning',
      '--updater': 'updater',
    }[flag];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || value.startsWith('--')) {
      throw new Error(
        `Usage: release-smoke.mjs --dir <release> --version <x.y.z> [--tag <vX.Y.Z>] [--root <repo>] [--allow-unsigned] [--windows-signing signed|unsigned] [--updater on|off] (bad argument ${flag})`,
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
