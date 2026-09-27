#!/usr/bin/env node
// Verifies the packaged app's declared contract before a release build.
//
// It enforces what tauri.conf.json, the capability, Cargo.toml and README.md
// declare, and the v0.0.1 decisions recorded on issue #356 (2026-09-26):
// the 480x520 minimum window, no updater, and no deep-link protocol. When a
// later release enables the updater or a protocol, change the decision here
// in the same change that configures it.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PRODUCT_NAME = 'OpenCoven Chat';
export const IDENTIFIER = 'ai.opencoven.chat';
export const DEFAULT_WINDOW = { width: 1180, height: 780 };
// The implemented and documented minimum (README, responsive tiers). The
// Phase 7 plan's 820x600 predates the responsive work; see issue #356.
export const MINIMUM_WINDOW = { width: 480, height: 520 };
export const INSTALLER_TARGETS = ['app', 'dmg', 'msi', 'nsis', 'appimage', 'deb'];
export const ICONS = [
  'icons/32x32.png',
  'icons/128x128.png',
  'icons/128x128@2x.png',
  'icons/icon.icns',
  'icons/icon.ico',
];
// The main window may reach only these: the app's own commands and setting
// its own title. Mirrors the specification guard on the capability.
export const ALLOWED_PERMISSIONS = [
  'allow-coven-runtime-status',
  'allow-coven-runtime-familiars',
  'allow-coven-runtime-sessions',
  'allow-coven-runtime-chat-lifecycle',
  'allow-coven-runtime-read',
  'allow-coven-runtime-send',
  'allow-coven-runtime-cancel',
  'allow-coven-screen-connect',
  'allow-coven-screen-send',
  'allow-coven-screen-disconnect',
  'core:window:allow-set-title',
];
const FORBIDDEN_PERMISSION =
  /^(shell|fs|filesystem|opener|http|https|network|process|os|dialog)(:|-)/;
const FORBIDDEN_PLUGIN = /tauri-plugin-(shell|fs|http|opener|process)\b/;

function directives(csp) {
  const map = new Map();
  const duplicates = [];
  for (const part of csp.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (!name) continue;
    // A repeated directive is not replaced by the later one; the first stays
    // in force, so checking only one copy could pass a permissive policy.
    if (map.has(name)) duplicates.push(name);
    else map.set(name, sources);
  }
  return { map, duplicates };
}

/**
 * @param {{ conf: any, capabilities: Record<string, any>, cargo: string, exists: (path: string) => boolean }} input
 * @returns {{ failures: string[] }}
 */
export function verifyPackage({ conf, capabilities, cargo, exists }) {
  const failures = [];
  const fail = (message) => failures.push(message);

  if (conf.productName !== PRODUCT_NAME)
    fail(`productName is ${conf.productName}, not ${PRODUCT_NAME}.`);
  if (conf.identifier !== IDENTIFIER) fail(`identifier is ${conf.identifier}, not ${IDENTIFIER}.`);

  const windows = conf.app?.windows ?? [];
  const main = windows.find((window) => window.label === 'main');
  if (windows.length !== 1 || !main)
    fail('The package must declare exactly one window, labelled main.');
  else {
    if (main.width !== DEFAULT_WINDOW.width || main.height !== DEFAULT_WINDOW.height)
      fail(
        `The default window is ${main.width}x${main.height}, not ${DEFAULT_WINDOW.width}x${DEFAULT_WINDOW.height}.`,
      );
    if (main.minWidth !== MINIMUM_WINDOW.width || main.minHeight !== MINIMUM_WINDOW.height)
      fail(
        `The minimum window is ${main.minWidth}x${main.minHeight}, not ${MINIMUM_WINDOW.width}x${MINIMUM_WINDOW.height}.`,
      );
  }
  if (conf.app?.withGlobalTauri !== false) fail('withGlobalTauri must be false.');

  const csp = conf.app?.security?.csp;
  if (typeof csp !== 'string') fail('A content security policy must be declared.');
  else {
    const { map: policy, duplicates } = directives(csp);
    for (const name of duplicates)
      fail(`CSP repeats ${name}; only one copy is checked, the first applies.`);
    const expect = (name, sources) => {
      const actual = policy.get(name);
      if (!actual || actual.join(' ') !== sources.join(' '))
        fail(`CSP ${name} is "${actual?.join(' ') ?? 'missing'}", not "${sources.join(' ')}".`);
    };
    expect('default-src', ["'self'"]);
    expect('script-src', ["'self'"]);
    expect('object-src', ["'none'"]);
    expect('base-uri', ["'none'"]);
    expect('form-action', ["'none'"]);
    expect('frame-ancestors', ["'none'"]);
    for (const [name, sources] of policy) {
      if (
        sources.some(
          (source) =>
            source === "'unsafe-eval'" ||
            source === '*' ||
            source === 'https:' ||
            source === 'http:',
        )
      )
        fail(`CSP ${name} allows ${sources.join(' ')}.`);
    }
    const connect = policy.get('connect-src');
    // Without it, default-src 'self' leaves the webview unable to reach the
    // host over IPC, so the built app could not run its own commands.
    if (!connect) fail('CSP must declare connect-src with the IPC origins.');
    else if (!connect.includes('ipc:') || !connect.includes('http://ipc.localhost'))
      fail('CSP connect-src must allow ipc: and http://ipc.localhost.');
    for (const source of connect ?? [])
      if (!["'self'", 'ipc:', 'http://ipc.localhost'].includes(source))
        fail(
          `CSP connect-src allows ${source}; the webview reaches the network only through the host.`,
        );
  }

  const bundle = conf.bundle ?? {};
  if (bundle.active !== true)
    fail('bundle.active must be true, or a release produces no installers.');
  const targets = Array.isArray(bundle.targets) ? bundle.targets : [];
  for (const target of INSTALLER_TARGETS)
    if (!targets.includes(target)) fail(`Installer target ${target} is missing.`);
  const icons = Array.isArray(bundle.icon) ? bundle.icon : [];
  for (const icon of ICONS) {
    if (!icons.includes(icon)) fail(`Icon ${icon} is not declared.`);
    else if (!exists(icon)) fail(`Icon ${icon} is declared but missing.`);
  }

  // Tauri loads every capability file in the directory, so an extra file
  // could grant the window anything; only the reviewed one may exist.
  const files = Object.keys(capabilities);
  for (const file of files)
    if (file !== 'default.json')
      fail(`Unexpected capability file ${file}; only default.json is reviewed.`);
  const capability = capabilities['default.json'] ?? {};
  if (!capabilities['default.json']) fail('Capability default.json is missing.');
  if (JSON.stringify(capability.windows) !== JSON.stringify(['main']))
    fail('The capability must apply to the main window only.');
  const permissions = Array.isArray(capability.permissions) ? capability.permissions : [];
  for (const permission of permissions) {
    if (typeof permission !== 'string') fail('Capability permissions must be plain identifiers.');
    else if (FORBIDDEN_PERMISSION.test(permission)) fail(`Capability grants ${permission}.`);
    else if (!ALLOWED_PERMISSIONS.includes(permission))
      fail(`Capability grants unreviewed ${permission}.`);
  }
  for (const permission of ALLOWED_PERMISSIONS)
    if (!permissions.includes(permission))
      fail(`Capability lacks ${permission}, which the window needs.`);
  if (capability.remote) fail('The capability must not grant remote origins.');

  const plugin = cargo.match(FORBIDDEN_PLUGIN);
  if (plugin) fail(`Cargo.toml depends on ${plugin[0]}.`);

  // Issue #356, decision 3: no updater for v0.0.1 (docs/releasing.md section 4).
  if (bundle.createUpdaterArtifacts !== false || conf.plugins?.updater)
    fail(
      'v0.0.1 ships without the updater: createUpdaterArtifacts must be false, with no updater plugin config (issue #356).',
    );
  if (/tauri-plugin-updater\b/.test(cargo))
    fail('Cargo.toml depends on tauri-plugin-updater; v0.0.1 has no updater (issue #356).');
  // Issue #356, decision 2: no deep-link protocol for v0.0.1; nothing handles links yet.
  if (conf.plugins?.['deep-link'] || /tauri-plugin-deep-link\b/.test(cargo))
    fail('v0.0.1 registers no deep-link protocol (issue #356).');

  return { failures };
}

export function readPackage(root) {
  const read = (path) => readFileSync(resolve(root, path), 'utf8');
  return {
    conf: JSON.parse(read('src-tauri/tauri.conf.json')),
    capabilities: Object.fromEntries(
      readdirSync(resolve(root, 'src-tauri/capabilities'))
        .filter((file) => file.endsWith('.json') || file.endsWith('.toml'))
        .map((file) => [
          file,
          file.endsWith('.json') ? JSON.parse(read(`src-tauri/capabilities/${file}`)) : {},
        ]),
    ),
    cargo: read('src-tauri/Cargo.toml'),
    exists: (path) => existsSync(resolve(root, 'src-tauri', path)),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { failures } = verifyPackage(readPackage(process.cwd()));
  for (const failure of failures) console.error(`FAIL  ${failure}`);
  console.log(failures.length ? 'Package verification failed.' : 'Package verified.');
  process.exitCode = failures.length ? 1 : 0;
}
