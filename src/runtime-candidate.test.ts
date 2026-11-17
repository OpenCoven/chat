import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import {
  assertCandidateHost,
  prepareRuntime,
  readDefinition,
  readRuntime,
  runtimeEnvironment,
  // @ts-expect-error Node qualification module has no renderer declarations.
} from '../scripts/packaged-acceptance/runtime-candidate.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'chat-runtime-candidate-')));
  roots.push(root);
  mkdirSync(join(root, 'home'));
  mkdirSync(join(root, 'state'));
  const definition = readDefinition();
  const metadata = {
    schema: 1,
    purpose: definition.purpose,
    root,
    home: join(root, 'home'),
    covenHome: join(root, 'state'),
    coven: {},
    engine: {},
  };
  for (const key of ['coven', 'engine'] as const) {
    const path = join(root, key);
    writeFileSync(path, `${key} fixture bytes`);
    metadata[key] = {
      ...definition[key],
      path,
      signatureVerified: true,
      sha256: createHash('sha256').update(readFileSync(path)).digest('hex'),
    };
  }
  const path = join(root, 'runtime.json');
  writeFileSync(path, JSON.stringify(metadata));
  return { root, path, metadata };
}
it('refuses an existing output before fetching, building or replacing any installation', async () => {
  const f = fixture();
  await expect(prepareRuntime(f.root)).rejects.toThrow('already exists');
  expect(readFileSync(join(f.root, 'coven'), 'utf8')).toBe('coven fixture bytes');
});
it('binds the executable bytes, producer commits, verification and disposable profile', () => {
  const f = fixture();
  expect(readRuntime(f.path).root).toBe(f.root);
  writeFileSync(join(f.root, 'engine'), 'changed executable');
  expect(() => readRuntime(f.path)).toThrow('executable changed');
});
it('rejects mismatched provenance and refuses a profile outside its qualification directory', () => {
  const f = fixture();
  writeFileSync(f.path, JSON.stringify({ ...f.metadata, home: tmpdir() }));
  expect(() => readRuntime(f.path)).toThrow('profile identity');
  writeFileSync(
    f.path,
    JSON.stringify({ ...f.metadata, coven: { ...f.metadata.coven, signatureVerified: false } }),
  );
  expect(() => readRuntime(f.path)).toThrow('identity or executable');
});
it('keeps runtime state and provider credentials separate from the build account', () => {
  const f = fixture();
  const runtime = readRuntime(f.path);
  const original = {
    HOME: '/existing-home',
    COVEN_HOME: '/existing-state',
    OPENAI_API_KEY: 'existing',
    PATH: '/tools',
    XDG_DATA_HOME: '/existing-data',
    XDG_CONFIG_HOME: '/existing-config',
  };
  const env = runtimeEnvironment(runtime, original);
  expect(env.HOME).toBe(runtime.home);
  expect(env.COVEN_HOME).toBe(runtime.covenHome);
  expect(env.OPENAI_API_KEY).toBeUndefined();
  expect(env.PATH).toBe('/tools');
  expect(env.XDG_DATA_HOME).toBe(join(runtime.home, '.local', 'share'));
  expect(env.XDG_CONFIG_HOME).toBe(join(runtime.home, '.config'));
  expect(original.HOME).toBe('/existing-home');
});

it('refuses Windows candidate launches outside a disposable hosted runner account', () => {
  expect(() => assertCandidateHost('win32', {})).toThrow('disposable hosted Windows');
  expect(() =>
    assertCandidateHost('win32', { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' }),
  ).toThrow('disposable hosted Windows');
  expect(() =>
    assertCandidateHost('win32', { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' }),
  ).not.toThrow();
});

it.skipIf(process.platform === 'win32')(
  'registers and probes the Linux opener in the app profile',
  () => {
    const f = fixture();
    const tools = join(f.root, 'tools');
    mkdirSync(tools);
    writeFileSync(
      join(tools, 'xdg-mime'),
      '#!/bin/sh\nprintf "%s\\n" chat-acceptance-browser.desktop\n',
      { mode: 0o755 },
    );
    writeFileSync(join(tools, 'xdg-open'), '#!/bin/sh\nexec "$TEST_RECORDER" "$1"\n', {
      mode: 0o755,
    });
    const env = runtimeEnvironment(readRuntime(f.path), {
      ...process.env,
      PATH: `${tools}:/usr/bin:/bin`,
    });
    env.TEST_RECORDER = join(f.root, 'chat-acceptance-browser');
    // A recorder regression must only write into disposable profiles. The
    // registration process and candidate app have distinct scratch homes.
    const parent = join(f.root, 'parent');
    mkdirSync(parent);
    const module = pathToFileURL(
      join(process.cwd(), 'scripts/packaged-acceptance/platform.mjs'),
    ).href;
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { registerRecorder } from ${JSON.stringify(module)}; console.log(JSON.stringify(registerRecorder(${JSON.stringify(join(f.root, 'opened.jsonl'))}, ${JSON.stringify(env)})));`,
      ],
      {
        env: {
          ...process.env,
          HOME: parent,
          XDG_DATA_HOME: join(parent, 'data'),
          XDG_CONFIG_HOME: join(parent, 'config'),
        },
        encoding: 'utf8',
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const recorder = JSON.parse(result.stdout);
    expect(readFileSync(join(env.XDG_CONFIG_HOME, 'mimeapps.list'), 'utf8')).toContain(
      'x-scheme-handler/https=chat-acceptance-browser.desktop',
    );
    expect(
      existsSync(join(env.XDG_DATA_HOME, 'applications', 'chat-acceptance-browser.desktop')),
    ).toBe(true);
    expect(recorder.handler).toBe(
      'xdg-open through chat-acceptance-browser.desktop (mimeapps.list)',
    );
    expect(existsSync(join(parent, 'config', 'mimeapps.list'))).toBe(false);
  },
);

it('refuses arbitrary source repositories and noncanonical candidate commits', () => {
  const f = fixture();
  for (const coven of [
    { ...readDefinition().coven, repository: 'another/source' },
    { ...readDefinition().coven, commit: 'main' },
  ]) {
    const path = join(f.root, 'definition.json');
    writeFileSync(path, JSON.stringify({ ...readDefinition(), coven }));
    expect(() => readDefinition(path)).toThrow('candidate identity');
  }
});
