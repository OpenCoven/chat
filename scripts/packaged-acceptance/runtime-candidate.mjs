// Test-only unpublished producer builds. Product installers and governed pins
// are independent; candidate qualification creates a new isolated profile.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { prepareLinuxBuildDependencies } from './linux-build-deps.mjs';

export { readVerifiedPackage } from './linux-build-deps.mjs';

const definitionFile = join(dirname(fileURLToPath(import.meta.url)), 'runtime-candidate.json');
const fail = (message) => {
  throw new Error(message);
};
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const inside = (root, path) => {
  const suffix = relative(realpathSync(root), realpathSync(path));
  return (
    suffix !== '' &&
    suffix !== '..' &&
    !suffix.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(suffix)
  );
};

export function readDefinition(path = definitionFile) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value.schema !== 1 || value.purpose !== 'unmerged-run-budget-qualification')
    fail('Invalid candidate qualification definition');
  for (const [key, repository, toolchain] of [
    ['coven', 'OpenCoven/coven', '1.99.1'],
    ['engine', 'OpenCoven/coven-code', '1.100.0'],
  ]) {
    const producer = value[key];
    if (
      producer?.repository !== repository ||
      producer.toolchain !== toolchain ||
      !/^[a-f0-9]{40}$/.test(producer.commit)
    )
      fail(`Invalid ${key} candidate identity`);
  }
  return value;
}

export function runtimeEnvironment(runtime, inherited = process.env, platform = process.platform) {
  if (!runtime) return { ...inherited };
  const env = {
    ...inherited,
    HOME: runtime.home,
    COVEN_HOME: runtime.covenHome,
    COVEN_ENGINE_BIN: runtime.engine.path,
    COVEN_CODE_DISABLE_MODELS_FETCH: '1',
    XDG_DATA_HOME: join(runtime.home, '.local', 'share'),
    XDG_CONFIG_HOME: join(runtime.home, '.config'),
    XDG_CACHE_HOME: join(runtime.home, '.cache'),
    XDG_STATE_HOME: join(runtime.home, '.local', 'state'),
  };
  if (platform === 'win32') {
    // Keep the fresh hosted account's native Known Folder environment intact.
    // A synthetic USERPROFILE can make app_local_data_dir unavailable.
    const path = windowsEnv(inherited, 'PATH') ?? '';
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
    const candidate = runtime.coven?.path
      ? win32.dirname(runtime.coven.path)
      : win32.join(runtime.home, '.local', 'bin');
    env.PATH = `${candidate};${path}`;
  }
  for (const key of [
    'OPENAI_API_KEY',
    'ANTHROPIC_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GH_TOKEN',
    'GITHUB_TOKEN',
  ])
    delete env[key];
  return env;
}

function windowsEnv(env, name) {
  const key = Object.keys(env)
    .filter((key) => key.toUpperCase() === name)
    .sort()[0];
  return key === undefined ? undefined : env[key];
}

export function verifyWindowsCandidateSelection(
  runtime,
  env,
  platform = process.platform,
  exists = existsSync,
) {
  if (platform !== 'win32') return null;
  const profile = windowsEnv(env, 'USERPROFILE');
  const roaming = windowsEnv(env, 'APPDATA');
  const local = windowsEnv(env, 'LOCALAPPDATA');
  if (
    ![profile, roaming, local, runtime.coven.path].every(
      (path) => typeof path === 'string' && win32.isAbsolute(path),
    )
  )
    fail('Windows candidate requires the native hosted account profile');
  const directory = win32.dirname(runtime.coven.path);
  if ((windowsEnv(env, 'PATH') ?? '').split(';')[0].toLowerCase() !== directory.toLowerCase())
    fail('Windows candidate must be first on PATH');
  const npm = (root) =>
    win32.join(
      root,
      '@opencoven',
      'cli',
      'node_modules',
      '@opencoven',
      'cli-windows',
      'bin',
      'coven.exe',
    );
  // Keep this list aligned with coven_runtime.rs::cli_candidates. These are
  // searched before the candidate directory's direct coven.exe PATH entry.
  const checkedAbsent = [
    npm(win32.join(profile, '.local', 'lib', 'node_modules')),
    win32.join(local, 'Programs', 'OpenCoven', 'Coven', 'coven.exe'),
    npm(win32.join(roaming, 'npm', 'node_modules')),
    win32.join(profile, '.local', 'bin', 'coven.exe'),
    win32.join(profile, '.cargo', 'bin', 'coven.exe'),
    npm(win32.join(directory, 'node_modules')),
  ];
  for (const path of checkedAbsent)
    if (exists(path)) fail(`Existing Windows CLI shadows candidate: ${path}`);
  return {
    candidate: runtime.coven.path,
    checkedAbsent,
    pathPrefix: directory,
    nativeProfilePreserved: true,
  };
}

export function assertCandidateHost(platform = process.platform, env = process.env) {
  // Windows Tauri/WebView storage follows Known Folders, not HOME overrides.
  // Only the workflow's fresh GitHub-hosted account is disposable there.
  if (
    platform === 'win32' &&
    (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted')
  )
    fail('Candidate app qualification requires a disposable hosted Windows account');
}

export function readRuntime(path, definition = readDefinition()) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  const root = realpathSync(dirname(path));
  if (
    value.schema !== 1 ||
    value.purpose !== definition.purpose ||
    value.root !== root ||
    value.home !== join(root, 'home') ||
    value.covenHome !== join(root, 'state')
  )
    fail('Candidate profile identity mismatch');
  for (const key of ['coven', 'engine']) {
    const binary = value[key];
    if (
      binary?.commit !== definition[key].commit ||
      binary.repository !== definition[key].repository ||
      binary.signatureVerified !== true ||
      !inside(root, binary.path) ||
      digest(binary.path) !== binary.sha256
    )
      fail(`Candidate ${key} identity or executable changed`);
  }
  if (!inside(root, value.home) || !inside(root, value.covenHome))
    fail('Candidate profile escaped qualification output');
  return value;
}

function run(command, args, cwd, env, log) {
  writeFileSync(log, `${command} ${JSON.stringify(args)}\n`, { flag: 'a' });
  console.log(`Candidate qualification: ${command} ${args[0] ?? ''}`);
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 20 * 60_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  writeFileSync(log, `${result.stdout ?? ''}${result.stderr ?? ''}`, { flag: 'a' });
  if (result.error || result.status !== 0) {
    console.error(`${result.stdout ?? ''}${result.stderr ?? ''}`.slice(-16 * 1024));
    fail(`Candidate command failed (${result.status ?? result.error?.code}); retained log: ${log}`);
  }
  return result.stdout;
}

async function verifiedCommit(producer) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  const response = await fetch(
    `https://api.github.com/repos/${producer.repository}/commits/${producer.commit}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) fail(`Candidate commit verification returned HTTP ${response.status}`);
  const value = await response.json();
  if (value.sha !== producer.commit || value.commit?.verification?.verified !== true)
    fail('Candidate commit signature is unverified');
  return { sha: value.sha, verification: value.commit.verification };
}

export async function prepareRuntime(output, definition = readDefinition()) {
  const root = resolve(output);
  if (existsSync(root)) fail('Candidate output already exists; retain it and choose a new output');
  assertCandidateHost();
  mkdirSync(root, { recursive: true });
  const metadata = {
    schema: 1,
    purpose: definition.purpose,
    root: realpathSync(root),
    home: join(realpathSync(root), 'home'),
    covenHome: join(realpathSync(root), 'state'),
  };
  mkdirSync(metadata.home);
  mkdirSync(metadata.covenHome);
  const env = runtimeEnvironment({ ...metadata, engine: { path: '' } });
  // Rustup/Cargo use the existing build account, never the disposable app home.
  const buildEnv = { ...process.env };
  delete buildEnv.GITHUB_TOKEN;
  delete buildEnv.GH_TOKEN;
  const linuxBuild = await prepareLinuxBuildDependencies(root, buildEnv, run);
  if (linuxBuild) {
    Object.assign(buildEnv, linuxBuild.environment);
    metadata.linuxBuildDependencies = linuxBuild.receipt;
  }
  for (const key of ['coven', 'engine']) {
    const producer = definition[key];
    const log = join(root, `${key}-build.log`);
    const verification = await verifiedCommit(producer);
    writeFileSync(join(root, `${key}-commit.json`), `${JSON.stringify(verification, null, 2)}\n`);
    const source = join(root, `${key}-source`);
    mkdirSync(source);
    for (const args of [
      ['init'],
      ['remote', 'add', 'origin', `https://github.com/${producer.repository}.git`],
      ['fetch', '--depth', '1', 'origin', producer.commit],
      ['checkout', '--detach', 'FETCH_HEAD'],
    ])
      run('git', args, source, buildEnv, log);
    if (run('git', ['rev-parse', 'HEAD'], source, buildEnv, log).trim() !== producer.commit)
      fail('Fetched candidate commit changed');
    const pin = readFileSync(
      join(source, key === 'engine' ? '.github/workflows/rust-ci.yml' : 'rust-toolchain.toml'),
      'utf8',
    );
    if (
      !(key === 'engine'
        ? pin.includes(`rust-toolchain@${producer.toolchain}`)
        : pin.includes(`channel = "${producer.toolchain}"`))
    )
      fail('Candidate toolchain differs from source');
    run(
      'rustup',
      ['toolchain', 'install', producer.toolchain, '--profile', 'minimal', '--no-self-update'],
      source,
      buildEnv,
      log,
    );
    const target = join(root, `${key}-target`);
    const cwd = key === 'engine' ? join(source, 'src-rust') : source;
    run(
      'rustup',
      [
        'run',
        producer.toolchain,
        'cargo',
        'build',
        '--locked',
        '-p',
        key === 'engine' ? 'claurst' : 'coven-cli',
        '--target-dir',
        target,
      ],
      cwd,
      { ...buildEnv, ...(key === 'coven' ? { COVEN_BUILD_COMMIT: producer.commit } : {}) },
      log,
    );
    if (run('git', ['status', '--porcelain'], source, buildEnv, log).trim())
      fail('Candidate build changed its source checkout');
    let binary = join(
      target,
      'debug',
      `${key === 'engine' ? 'coven-code' : 'coven'}${process.platform === 'win32' ? '.exe' : ''}`,
    );
    if (key === 'coven') {
      const directory = join(metadata.home, '.local', 'bin');
      mkdirSync(directory, { recursive: true });
      const installed = join(directory, process.platform === 'win32' ? 'coven.exe' : 'coven');
      copyFileSync(binary, installed, constants.COPYFILE_EXCL);
      binary = installed;
    }
    metadata[key] = {
      ...producer,
      path: realpathSync(binary),
      sha256: digest(binary),
      signatureVerified: true,
      build: 'debug, unpublished qualification only',
    };
  }
  Object.assign(env, runtimeEnvironment(metadata));
  metadata.windowsSelection = verifyWindowsCandidateSelection(metadata, env);
  const caps = JSON.parse(
    run(metadata.engine.path, ['--run-budget-capabilities'], root, env, join(root, 'probes.log')),
  );
  if (
    caps.engine_contract_version !== 1 ||
    caps.run_budget_version !== 1 ||
    caps.flag !== '--max-turns' ||
    caps.minimum !== 1 ||
    caps.maximum !== 4294967295
  )
    fail('Candidate engine lacks required finite run-budget v1');
  const adapters = JSON.parse(
    run(metadata.coven.path, ['adapter', 'list', '--json'], root, env, join(root, 'probes.log')),
  );
  if (
    !adapters.some(
      (adapter) =>
        adapter.id === 'coven-code' &&
        adapter.run_budget?.version === 1 &&
        adapter.run_budget?.flag === '--max-turns',
    )
  )
    fail('Candidate Coven lacks declared budget adapter');
  metadata.capabilities = caps;
  metadata.coven.version = run(
    metadata.coven.path,
    ['--version'],
    root,
    env,
    join(root, 'probes.log'),
  ).trim();
  metadata.engine.version = run(
    metadata.engine.path,
    ['--version'],
    root,
    env,
    join(root, 'probes.log'),
  ).trim();
  writeFileSync(join(root, 'runtime.json'), `${JSON.stringify(metadata, null, 2)}\n`, {
    flag: 'wx',
  });
  return readRuntime(join(root, 'runtime.json'), definition);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) fail('Usage: runtime-candidate.mjs --out <new isolated directory>');
  await prepareRuntime(values.out);
  console.log(
    `Candidate runtime prepared at ${join(resolve(values.out), 'runtime.json')}; no product pins or existing installations changed.`,
  );
}
