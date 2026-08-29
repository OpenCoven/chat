#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { devNull } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  APPROVED_PHASE1_DIAGNOSTIC_IDS,
  REQUIRED_PHASE1_ASSERTION_IDS,
  scanPhase1Artifacts,
  validatePhase1SanitizedReport,
} from './phase1-artifact-secret-scan.mjs';
import {
  assertCleanPhase1Checkouts,
  assertPhase1CheckoutHeads,
  createGitEnvironment,
  readPhase1ConformanceLock,
} from './phase1-conformance-lock.mjs';
import { createProcessOwnedArtifactRoot } from './process-owned-artifact-root.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gitCommonDirectory = resolve(
  projectRoot,
  execFileSync('git', ['rev-parse', '--git-common-dir'], {
    cwd: projectRoot,
    encoding: 'utf8',
  }).trim(),
);
const chatRepositoryRoot = dirname(gitCommonDirectory);
const repositoriesParent = dirname(chatRepositoryRoot);
const defaultRetainedReport = resolve(
  projectRoot,
  'test-results',
  'phase1-conformance',
  'report.json',
);
const commandOutputLimit = 16 * 1024 * 1024;
const revocationConfirmationDelayMs = 550;
const commandTimeoutMs = 20 * 60_000;
const rpcTimeoutMs = 10_000;
const caveConformanceTimeoutMs = 15 * 60_000;
const approvedDiagnosticSet = new Set(APPROVED_PHASE1_DIAGNOSTIC_IDS);
const requiredAssertionSet = new Set(REQUIRED_PHASE1_ASSERTION_IDS);

function defaultSourceRoot(environmentName, repositoryName) {
  return process.env[environmentName] === undefined
    ? resolve(repositoriesParent, repositoryName)
    : resolve(process.env[environmentName]);
}

class CommandExecutionError extends Error {
  constructor(label, result) {
    super(`${label} failed.`);
    this.label = label;
    this.result = result;
  }
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

export function parseArgs(argv) {
  const options = {
    lockPath: resolve(projectRoot, 'phase1-conformance.lock.json'),
    scenario: 'all',
    retainSanitizedReport: defaultRetainedReport,
    chatSourceRoot: resolve(process.env.OPENCOVEN_CHAT_ROOT ?? chatRepositoryRoot),
    sdkSourceRoot: defaultSourceRoot('OPENCOVEN_SDK_ROOT', 'sdk'),
    caveSourceRoot: defaultSourceRoot('OPENCOVEN_CAVE_ROOT', 'coven-cave'),
    covenSourceRoot: defaultSourceRoot('OPENCOVEN_COVEN_ROOT', 'coven'),
  };

  const pathFlags = new Map([
    ['--lock', 'lockPath'],
    ['--retain-sanitized-report', 'retainSanitizedReport'],
    ['--chat-root', 'chatSourceRoot'],
    ['--sdk-root', 'sdkSourceRoot'],
    ['--cave-root', 'caveSourceRoot'],
    ['--coven-root', 'covenSourceRoot'],
  ]);

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--') {
      continue;
    }
    if (argument === '--scenario') {
      const scenario = requireString(argv[index + 1], '--scenario');
      if (scenario !== 'all') {
        throw new Error('only --scenario all is supported by Phase 1 conformance.');
      }
      options.scenario = scenario;
      index += 1;
      continue;
    }
    const optionName = pathFlags.get(argument);
    if (optionName !== undefined) {
      options[optionName] = resolve(requireString(argv[index + 1], argument));
      index += 1;
      continue;
    }
    throw new Error(`phase1-conformance: unknown option: ${argument}`);
  }

  return options;
}

export function assertExactAssertionResults(assertions) {
  if (!Array.isArray(assertions)) {
    throw new Error('Phase 1 conformance assertions must be an array.');
  }

  const seen = new Set();
  for (const assertion of assertions) {
    if (assertion === null || typeof assertion !== 'object' || typeof assertion.id !== 'string') {
      throw new Error('Phase 1 conformance contains an invalid assertion result.');
    }
    if (!requiredAssertionSet.has(assertion.id)) {
      throw new Error(`Phase 1 conformance contains unexpected assertion ID ${assertion.id}.`);
    }
    if (seen.has(assertion.id)) {
      throw new Error(`Phase 1 conformance contains duplicate assertion ID ${assertion.id}.`);
    }
    if (assertion.status === 'skipped') {
      throw new Error(`Phase 1 conformance contains skipped assertion ${assertion.id}.`);
    }
    if (!['passed', 'failed', 'blocked'].includes(assertion.status)) {
      throw new Error(`Phase 1 conformance assertion ${assertion.id} has an invalid status.`);
    }
    if (
      !Array.isArray(assertion.diagnosticIds) ||
      assertion.diagnosticIds.some((id) => !approvedDiagnosticSet.has(id))
    ) {
      throw new Error(`Phase 1 conformance assertion ${assertion.id} has an invalid diagnostic.`);
    }
    seen.add(assertion.id);
  }

  for (const id of REQUIRED_PHASE1_ASSERTION_IDS) {
    if (!seen.has(id)) {
      throw new Error(`Phase 1 conformance is missing required assertion ID ${id}.`);
    }
  }

  return assertions;
}

export function buildPhase1Report({ assertions, revisions, artifactDigests, versions }) {
  assertExactAssertionResults(assertions);
  const orderedAssertions = REQUIRED_PHASE1_ASSERTION_IDS.map((id) =>
    assertions.find((assertion) => assertion.id === id),
  );
  const summary = {
    required: REQUIRED_PHASE1_ASSERTION_IDS.length,
    passed: orderedAssertions.filter((assertion) => assertion.status === 'passed').length,
    failed: orderedAssertions.filter((assertion) => assertion.status === 'failed').length,
    blocked: orderedAssertions.filter((assertion) => assertion.status === 'blocked').length,
    skipped: 0,
  };
  const status = summary.failed > 0 ? 'failed' : summary.blocked > 0 ? 'blocked' : 'passed';
  const report = {
    schemaVersion: 1,
    completed: true,
    status,
    platform: {
      os: process.platform,
      arch: process.arch,
    },
    versions,
    revisions,
    artifactDigests,
    assertions: orderedAssertions,
    summary,
    diagnosticIds: [`phase1.conformance.${status}`],
  };
  validatePhase1SanitizedReport(report);
  return report;
}

export function parseCaveConformanceOutput(output) {
  const assertions = new Map();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^(ok|FAIL|skip) ([a-z0-9./:-]+)(?:\s|$)/u.exec(line);
    if (match === null) {
      continue;
    }
    const [, marker, id] = match;
    if (assertions.has(id)) {
      throw new Error(`Cave conformance emitted duplicate assertion ID ${id}.`);
    }
    assertions.set(id, marker === 'ok' ? 'passed' : marker === 'FAIL' ? 'failed' : 'skipped');
  }
  return assertions;
}

export function assertPairingStatus(value, expectedStatus) {
  const status = value?.status;
  if (status !== expectedStatus) {
    throw new Error(`pairing status was ${status ?? 'missing'} instead of ${expectedStatus}`);
  }
  return value;
}

function makeAssertion(id, status, diagnosticId) {
  return {
    id,
    status,
    diagnosticIds: [diagnosticId],
  };
}

function addAssertion(results, id, status, diagnosticId) {
  if (results.has(id)) {
    throw new Error(`Phase 1 conformance attempted to record ${id} more than once.`);
  }
  results.set(id, makeAssertion(id, status, diagnosticId));
}

function requirePassedAssertions(assertions, ids) {
  return ids.every((id) => assertions.get(id) === 'passed');
}

function safeEnvironment(rootPath, extra = {}) {
  const operatorHome = process.env.HOME;
  const home = resolve(rootPath, 'home');
  const temp = resolve(rootPath, 'tmp');
  const cache = resolve(rootPath, 'cache');
  const config = resolve(home, '.config');
  const data = resolve(rootPath, 'data');
  const pnpmStore = resolve(rootPath, 'pnpm-store');
  for (const path of [home, temp, cache, config, data, pnpmStore]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }

  const environment = {
    PATH: process.env.PATH ?? '',
    LANG: process.env.LANG ?? 'C.UTF-8',
    LC_ALL: process.env.LC_ALL ?? '',
    HOME: home,
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
    XDG_CACHE_HOME: cache,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    NPM_CONFIG_USERCONFIG: devNull,
    NPM_CONFIG_PROXY: '',
    NPM_CONFIG_HTTPS_PROXY: '',
    PNPM_STORE_DIR: pnpmStore,
    CI: '1',
    NO_COLOR: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    all_proxy: '',
    ...extra,
  };
  if (operatorHome !== undefined) {
    environment.RUSTUP_HOME = process.env.RUSTUP_HOME ?? resolve(operatorHome, '.rustup');
    environment.CARGO_HOME = process.env.CARGO_HOME ?? resolve(operatorHome, '.cargo');
  }
  for (const name of ['SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT']) {
    if (process.env[name] !== undefined) {
      environment[name] = process.env[name];
    }
  }
  return environment;
}

function runCommand(
  artifactRoot,
  label,
  command,
  args,
  { cwd, env, timeoutMs = commandTimeoutMs } = {},
) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timer;

    const fail = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      rejectRun(new CommandExecutionError(label, result));
    };

    child.once('spawn', () => {
      try {
        artifactRoot.trackChild(child);
      } catch {
        child.kill('SIGKILL');
        fail({ code: null, signal: 'SIGKILL', stdout: '', stderr: '', reason: 'tracking' });
      }
    });
    child.once('error', () => {
      fail({ code: null, signal: null, stdout: '', stderr: '', reason: 'spawn' });
    });
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > commandOutputLimit) {
        child.kill('SIGKILL');
        fail({ code: null, signal: 'SIGKILL', stdout: '', stderr: '', reason: 'stdout-limit' });
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > commandOutputLimit) {
        child.kill('SIGKILL');
        fail({ code: null, signal: 'SIGKILL', stdout: '', stderr: '', reason: 'stderr-limit' });
        return;
      }
      stderr.push(chunk);
    });
    child.once('close', (code, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      const result = {
        code,
        signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (code === 0) {
        resolveRun(result);
      } else {
        rejectRun(new CommandExecutionError(label, result));
      }
    });
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      fail({ code: null, signal: 'SIGKILL', stdout: '', stderr: '', reason: 'timeout' });
    }, timeoutMs);
  });
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function sha256Tree(rootPath) {
  const digest = createHash('sha256');
  const visit = (directoryPath, relativeRoot = '') => {
    for (const entry of readdirSync(directoryPath, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const relativePath = relativeRoot.length === 0 ? entry.name : `${relativeRoot}/${entry.name}`;
      const entryPath = resolve(directoryPath, entry.name);
      const stats = lstatSync(entryPath);
      if (stats.isSymbolicLink()) {
        throw new Error('Packaged artifact tree contains a symlink.');
      }
      if (stats.isDirectory()) {
        visit(entryPath, relativePath);
      } else if (stats.isFile()) {
        digest.update(relativePath);
        digest.update('\0');
        digest.update(readFileSync(entryPath));
        digest.update('\0');
      } else {
        throw new Error('Packaged artifact tree contains a non-regular entry.');
      }
    }
  };
  visit(rootPath);
  return digest.digest('hex');
}

async function cloneExactCheckout({
  artifactRoot,
  sourceRoot,
  destinationRoot,
  revision,
  environment,
  label,
}) {
  if (!statSync(sourceRoot).isDirectory()) {
    throw new Error(`${label} source root is unavailable.`);
  }
  await runCommand(
    artifactRoot,
    `${label} clone`,
    'git',
    [
      '-c',
      'credential.helper=',
      '-c',
      `core.hooksPath=${devNull}`,
      '-c',
      'protocol.file.allow=always',
      'clone',
      '--shared',
      '--no-checkout',
      '--quiet',
      sourceRoot,
      destinationRoot,
    ],
    {
      cwd: projectRoot,
      env: {
        ...environment,
        ...createGitEnvironment(environment),
        GIT_ALLOW_PROTOCOL: 'file',
      },
    },
  );
  await runCommand(
    artifactRoot,
    `${label} checkout`,
    'git',
    ['-c', `core.hooksPath=${devNull}`, 'checkout', '--detach', '--force', revision],
    { cwd: destinationRoot, env: { ...environment, ...createGitEnvironment(environment) } },
  );
}

async function createExactCheckouts(artifactRoot, options, lock, environment) {
  const checkoutsRoot = resolve(artifactRoot.rootPath, 'checkouts');
  mkdirSync(checkoutsRoot, { mode: 0o700 });
  const roots = {
    chatRoot: resolve(checkoutsRoot, 'chat'),
    sdkRoot: resolve(checkoutsRoot, 'sdk'),
    caveRoot: resolve(checkoutsRoot, 'cave'),
    covenRoot: resolve(checkoutsRoot, 'coven'),
  };
  await cloneExactCheckout({
    artifactRoot,
    sourceRoot: options.chatSourceRoot,
    destinationRoot: roots.chatRoot,
    revision: lock.chat.revision,
    environment,
    label: 'Chat',
  });
  await cloneExactCheckout({
    artifactRoot,
    sourceRoot: options.sdkSourceRoot,
    destinationRoot: roots.sdkRoot,
    revision: lock.sdk.revision,
    environment,
    label: 'SDK',
  });
  await cloneExactCheckout({
    artifactRoot,
    sourceRoot: options.caveSourceRoot,
    destinationRoot: roots.caveRoot,
    revision: lock.cave.revision,
    environment,
    label: 'Cave',
  });
  await cloneExactCheckout({
    artifactRoot,
    sourceRoot: options.covenSourceRoot,
    destinationRoot: roots.covenRoot,
    revision: lock.coven.revision,
    environment,
    label: 'Coven',
  });
  assertCleanPhase1Checkouts(roots);
  assertPhase1CheckoutHeads(lock, roots);
  return roots;
}

async function installPnpm(artifactRoot, rootPath, environment, label) {
  await runCommand(
    artifactRoot,
    `${label} dependency install`,
    'corepack',
    [
      'pnpm@10.34.0',
      'install',
      '--frozen-lockfile',
      `--config.store-dir=${environment.PNPM_STORE_DIR}`,
    ],
    { cwd: rootPath, env: environment },
  );
}

async function packageLockedArtifacts(artifactRoot, roots, environment) {
  await installPnpm(artifactRoot, roots.chatRoot, environment, 'Chat');
  await runCommand(artifactRoot, 'Chat web package', 'corepack', ['pnpm@10.34.0', 'build'], {
    cwd: roots.chatRoot,
    env: environment,
  });
  const chatTarget = resolve(artifactRoot.rootPath, 'build', 'chat-target');
  mkdirSync(chatTarget, { recursive: true, mode: 0o700 });
  await runCommand(
    artifactRoot,
    'Chat native RPC package',
    'cargo',
    [
      'build',
      '--locked',
      '--manifest-path',
      resolve(roots.chatRoot, 'src-tauri', 'Cargo.toml'),
      '--features',
      'phase1-conformance',
      '--bin',
      'phase1-native-rpc',
    ],
    {
      cwd: roots.chatRoot,
      env: { ...environment, CARGO_TARGET_DIR: chatTarget },
    },
  );

  await installPnpm(artifactRoot, roots.sdkRoot, environment, 'SDK');
  const sdkTarballsRoot = resolve(artifactRoot.rootPath, 'packages', 'sdk');
  mkdirSync(sdkTarballsRoot, { recursive: true, mode: 0o700 });
  const sdkPackResult = resolve(artifactRoot.rootPath, 'sdk-pack-result.json');
  const sdkPackWrapper = resolve(artifactRoot.rootPath, 'pack-sdk.mjs');
  writeFileSync(
    sdkPackWrapper,
    [
      `import { writeFileSync } from 'node:fs';`,
      `import { packPublicPackages } from ${JSON.stringify(
        pathToFileURL(resolve(roots.sdkRoot, 'scripts', 'package-artifacts.mjs')).href,
      )};`,
      `const tarballs = packPublicPackages({ root: ${JSON.stringify(
        roots.sdkRoot,
      )}, destinationRoot: ${JSON.stringify(sdkTarballsRoot)}, build: true });`,
      `writeFileSync(${JSON.stringify(sdkPackResult)}, JSON.stringify(tarballs));`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  await runCommand(artifactRoot, 'SDK package build', process.execPath, [sdkPackWrapper], {
    cwd: roots.sdkRoot,
    env: environment,
  });
  const packedTarballs = JSON.parse(readFileSync(sdkPackResult, 'utf8'));

  const packageNames = {
    core: 'sdk-core-0.1.0.tgz',
    cave: 'cave-client-0.1.0.tgz',
    coven: 'coven-client-0.1.0.tgz',
    sdk: 'sdk-0.1.0.tgz',
  };
  const frozenTarballs = Object.fromEntries(
    Object.entries(packageNames).map(([key, name]) => [
      key,
      resolve(roots.chatRoot, 'vendor', 'opencoven-sdk', name),
    ]),
  );
  const compareWrapper = resolve(artifactRoot.rootPath, 'compare-sdk.mjs');
  writeFileSync(
    compareWrapper,
    [
      `import { assertPackedPackageContentsMatch } from ${JSON.stringify(
        pathToFileURL(resolve(roots.chatRoot, 'scripts', 'contract-canary.mjs')).href,
      )};`,
      `assertPackedPackageContentsMatch(${JSON.stringify(
        packedTarballs,
      )}, ${JSON.stringify(frozenTarballs)}, ${JSON.stringify(
        resolve(artifactRoot.rootPath, 'sdk-compare'),
      )});`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  await runCommand(
    artifactRoot,
    'SDK packed artifact comparison',
    process.execPath,
    [compareWrapper],
    {
      cwd: roots.chatRoot,
      env: environment,
    },
  );

  await installPnpm(artifactRoot, roots.caveRoot, environment, 'Cave');
  await runCommand(artifactRoot, 'Cave release package', 'corepack', ['pnpm@10.34.0', 'build'], {
    cwd: roots.caveRoot,
    env: environment,
  });

  const covenTarget = resolve(artifactRoot.rootPath, 'build', 'coven-target');
  mkdirSync(covenTarget, { recursive: true, mode: 0o700 });
  await runCommand(
    artifactRoot,
    'Coven CLI package',
    'cargo',
    ['build', '--locked', '--package', 'coven-cli', '--bin', 'coven'],
    {
      cwd: roots.covenRoot,
      env: { ...environment, CARGO_TARGET_DIR: covenTarget },
    },
  );

  const executableSuffix = process.platform === 'win32' ? '.exe' : '';
  const nativeRpcPath = resolve(chatTarget, 'debug', `phase1-native-rpc${executableSuffix}`);
  const covenBinaryPath = resolve(covenTarget, 'debug', `coven${executableSuffix}`);
  for (const [label, path] of [
    ['Chat native RPC', nativeRpcPath],
    ['Coven CLI', covenBinaryPath],
  ]) {
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`${label} package is not a regular file.`);
    }
  }

  return {
    nativeRpcPath,
    covenBinaryPath,
    artifactDigests: {
      'chat-web-bundle': sha256Tree(resolve(roots.chatRoot, 'dist')),
      'chat-native-rpc': sha256File(nativeRpcPath),
      'sdk-core': sha256File(frozenTarballs.core),
      'sdk-cave': sha256File(frozenTarballs.cave),
      'sdk-coven': sha256File(frozenTarballs.coven),
      'sdk-root': sha256File(frozenTarballs.sdk),
      'cave-server': sha256File(resolve(roots.caveRoot, 'server.mjs')),
      'coven-cli': sha256File(covenBinaryPath),
    },
  };
}

async function runCaveAuthorityMatrix(artifactRoot, caveRoot, environment) {
  const result = await runCommand(
    artifactRoot,
    'Cave real-authority conformance',
    process.execPath,
    [
      resolve(caveRoot, 'scripts', 'client-v1-conformance.mjs'),
      '--include-ttl',
      '--include-authority-takeover',
    ],
    {
      cwd: caveRoot,
      env: environment,
      timeoutMs: caveConformanceTimeoutMs,
    },
  );
  return parseCaveConformanceOutput(result.stdout);
}

function requestJson(origin, { method = 'GET', path, headers = {}, body }) {
  return new Promise((resolveRequest, rejectRequest) => {
    const endpoint = new URL(path, origin);
    const request = httpRequest(
      {
        hostname: endpoint.hostname,
        port: endpoint.port,
        method,
        path: `${endpoint.pathname}${endpoint.search}`,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }),
        },
      },
      (response) => {
        const chunks = [];
        let total = 0;
        response.on('data', (chunk) => {
          total += chunk.length;
          if (total > 4 * 1024 * 1024) {
            response.destroy(new Error('response-size-limit'));
            return;
          }
          chunks.push(chunk);
        });
        response.once('error', rejectRequest);
        response.once('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json;
          try {
            json = JSON.parse(text);
          } catch {
            rejectRequest(new Error('invalid-json-response'));
            return;
          }
          resolveRequest({
            status: response.statusCode ?? 0,
            headers: response.headers,
            json,
          });
        });
      },
    );
    request.once('error', rejectRequest);
    request.setTimeout(rpcTimeoutMs, () => request.destroy(new Error('request-timeout')));
    if (body !== undefined) {
      request.write(body);
    }
    request.end();
  });
}

function startFixtureDaemon(roster) {
  const server = createServer((request, response) => {
    if (request.url === '/api/v1/familiars') {
      const body = JSON.stringify(roster);
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      response.end(body);
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end('{"error":"not_found"}');
  });
  return new Promise((resolveServer, rejectServer) => {
    server.once('error', rejectServer);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolveServer({
        url: `http://127.0.0.1:${address.port}`,
        async close() {
          await new Promise((resolveClose, rejectClose) =>
            server.close((error) => (error ? rejectClose(error) : resolveClose())),
          );
        },
      });
    });
  });
}

function writeNativeFixture(caveHome, covenHome, daemonUrl) {
  mkdirSync(caveHome, { recursive: true, mode: 0o700 });
  mkdirSync(covenHome, { recursive: true, mode: 0o700 });
  writeFileSync(
    resolve(caveHome, 'config.json'),
    `${JSON.stringify({
      version: 1,
      multiHost: { mode: 'hub', hubUrl: daemonUrl, executorUrls: [] },
    })}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    resolve(caveHome, 'projects.json'),
    `${JSON.stringify({
      version: 1,
      projects: [
        {
          id: 'project-01',
          name: 'Fixture 01',
          root: '/phase1/project-01',
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-02-01T00:00:00.000Z',
        },
        {
          id: 'project-02',
          name: 'Fixture 02',
          root: '/phase1/project-02',
          createdAt: '2026-01-02T00:00:00.000Z',
          updatedAt: '2026-02-02T00:00:00.000Z',
        },
        {
          id: 'project-03',
          name: 'Fixture 03',
          root: '/phase1/project-03',
          createdAt: '2026-01-03T00:00:00.000Z',
          updatedAt: '2026-02-03T00:00:00.000Z',
        },
      ],
    })}\n`,
    { mode: 0o600 },
  );
  const conversations = resolve(caveHome, 'conversations');
  mkdirSync(conversations, { mode: 0o700 });
  for (const conversation of [
    {
      sessionId: 'conversation-01',
      familiarId: 'archivist',
      createdAt: '2026-03-01T00:00:00.000Z',
      updatedAt: '2026-04-01T00:00:00.000Z',
      turns: [
        {
          id: 'c1-root',
          parentId: null,
          role: 'user',
          text: 'synthetic prompt',
          createdAt: '2026-03-01T00:00:00.000Z',
        },
      ],
      activeLeafId: 'c1-root',
    },
    {
      sessionId: 'branched',
      familiarId: 'archivist',
      createdAt: '2026-03-02T00:00:00.000Z',
      updatedAt: '2026-04-02T00:00:00.000Z',
      turns: [
        {
          id: 'b-root',
          parentId: null,
          role: 'user',
          text: 'synthetic root',
          createdAt: '2026-03-02T00:00:00.000Z',
        },
        {
          id: 'b-active',
          parentId: 'b-root',
          role: 'assistant',
          text: 'synthetic active',
          createdAt: '2026-03-02T00:01:00.000Z',
        },
        {
          id: 'b-other',
          parentId: 'b-root',
          role: 'assistant',
          text: 'synthetic alternate',
          createdAt: '2026-03-02T00:02:00.000Z',
        },
        {
          id: 'b-active-tail',
          parentId: 'b-active',
          role: 'user',
          text: 'synthetic active continuation',
          createdAt: '2026-03-02T00:03:00.000Z',
        },
      ],
      activeLeafId: 'b-active-tail',
    },
  ]) {
    writeFileSync(
      resolve(conversations, `${conversation.sessionId}.json`),
      `${JSON.stringify(conversation)}\n`,
      { mode: 0o600 },
    );
  }
}

async function triggerAndWaitForChildClose(child, trigger) {
  const closed = once(child, 'close');
  await trigger();
  await closed;
}

export class NativeRpcClient {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.sequence = 0;
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      this.buffer += chunk;
      while (true) {
        const newline = this.buffer.indexOf('\n');
        if (newline === -1) {
          break;
        }
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        let response;
        try {
          response = JSON.parse(line);
        } catch {
          continue;
        }
        const pending = this.pending.get(response.id);
        if (pending !== undefined) {
          this.pending.delete(response.id);
          clearTimeout(pending.timer);
          pending.resolve(response);
        }
      }
    });
    child.once('close', () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('native RPC closed before responding'));
      }
      this.pending.clear();
    });
  }

  operation() {
    this.sequence += 1;
    return {
      attemptId: `op1-1787900000000-${this.sequence}-${String(this.sequence).padStart(32, '0')}`,
      timeoutMs: 5_000,
    };
  }

  request(command, args) {
    this.sequence += 1;
    const id = `request-${this.sequence}`;
    const request = { id, command, ...(args === undefined ? {} : { args }) };
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectRequest(new Error(`native RPC timed out for ${command}`));
      }, rpcTimeoutMs);
      this.pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
      this.child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  async ok(command, args) {
    const response = await this.request(command, args);
    if (response.ok !== true) {
      throw new Error(`native RPC ${command} failed with ${response.error?.code ?? 'unknown'}`);
    }
    return response.result;
  }

  async error(command, args, expectedCode) {
    const response = await this.request(command, args);
    if (response.ok !== false || response.error?.code !== expectedCode) {
      throw new Error(`native RPC ${command} did not return ${expectedCode}`);
    }
    return response.error;
  }

  async close() {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      await triggerAndWaitForChildClose(this.child, () => this.ok('conformance_shutdown'));
    }
  }
}

async function startNativeRpc(artifactRoot, binaryPath, environment, cwd) {
  const child = spawn(binaryPath, [], {
    cwd,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  await once(child, 'spawn');
  artifactRoot.trackChild(child);
  child.stderr.resume();
  return new NativeRpcClient(child);
}

async function waitForDiscovery(rpc) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const response = await rpc.request('cave_read_discovery', {
      operation: rpc.operation(),
    });
    if (response.ok === true) {
      return response.result;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error('native RPC did not discover the launched Cave');
}

async function adminMutation(origin, adminToken, method, path, body) {
  const response = await requestJson(origin, {
    method,
    path: `/api/client/v1${path}`,
    headers: {
      'x-coven-cave-token': adminToken,
      origin,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!(response.status >= 200 && response.status < 300)) {
    throw new Error(`Cave admin mutation failed with HTTP ${response.status}`);
  }
  return response.json;
}

async function pairNative(rpc, handle, origin, adminToken, installationId) {
  const created = await rpc.ok('cave_pairing_create', {
    handle,
    request: {
      appName: 'OpenCoven Chat',
      installationId,
      scopes: ['chat:read'],
    },
    operation: rpc.operation(),
  });
  const requestId = created.requestId;
  if (typeof requestId !== 'string') {
    throw new Error('native pairing creation omitted its request ID');
  }
  const pending = await rpc.ok('cave_pairing_poll', {
    handle,
    requestId,
    operation: rpc.operation(),
  });
  if (pending.status !== 'pending') {
    throw new Error('native pairing did not begin pending');
  }
  await adminMutation(origin, adminToken, 'POST', `/admin/pairing-requests/${requestId}/decision`, {
    decision: 'approved',
  });
  const approved = await rpc.ok('cave_pairing_poll', {
    handle,
    requestId,
    operation: rpc.operation(),
  });
  if (approved.status !== 'approved') {
    throw new Error('native pairing was not approved');
  }
  const exchanged = await rpc.ok('cave_pairing_exchange', {
    handle,
    requestId,
    operation: rpc.operation(),
  });
  const credentialId = exchanged.credential?.id;
  if (typeof credentialId !== 'string' || JSON.stringify(exchanged).includes('bearer')) {
    throw new Error('native pairing exchange returned an unsafe result');
  }
  return { requestId, credentialId };
}

function collection(result, name) {
  const items = result?.data?.[name];
  if (!Array.isArray(items)) {
    throw new Error(`native canonical read omitted ${name}`);
  }
  return items;
}

async function runNativeScenarios({ artifactRoot, roots, nativeRpcPath, environment, results }) {
  const isolatedHome = resolve(artifactRoot.rootPath, 'native-authority-home');
  const covenHome = resolve(isolatedHome, 'coven');
  const caveHome = resolve(covenHome, 'cave');
  const fixtureDaemon = await startFixtureDaemon([
    {
      id: 'archivist',
      display_name: 'Archivist',
      role: 'Keeper',
      description: 'Synthetic roster entry.',
    },
  ]);
  writeNativeFixture(caveHome, covenHome, fixtureDaemon.url);
  const portServer = createServer();
  portServer.listen(0, '127.0.0.1');
  await once(portServer, 'listening');
  const port = portServer.address().port;
  await new Promise((resolveClose, rejectClose) =>
    portServer.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  const origin = `http://127.0.0.1:${port}`;
  const adminToken = `phase1-${randomUUID()}`;
  const rpcEnvironment = {
    ...environment,
    COVEN_HOME: covenHome,
    COVEN_CAVE_HOME: caveHome,
    COVEN_CAVE_PORT: String(port),
    COVEN_CAVE_AUTH_TOKEN: adminToken,
    COVEN_CAVE_CLIENT_V1_AUTHORITY_MODE: 'enforce',
    COVEN_CAVE_HEAP_MONITOR: '0',
    OPENCOVEN_PHASE1_CONFORMANCE_NODE_PATH: realpathSync(process.execPath),
    OPENCOVEN_PHASE1_CONFORMANCE_CAVE_SERVER_PATH: resolve(roots.caveRoot, 'server.mjs'),
    NODE_ENV: 'production',
  };
  const rpc = await startNativeRpc(artifactRoot, nativeRpcPath, rpcEnvironment, roots.caveRoot);

  let handle;
  let credentialId;
  try {
    try {
      await rpc.error(
        'cave_read_discovery',
        { operation: rpc.operation() },
        'cave_discovery_not_found',
      );
      await rpc.ok('cave_launch');
      const discovery = await waitForDiscovery(rpc);
      handle = discovery.handle;
      const health = await rpc.ok('cave_health', {
        handle,
        operation: rpc.operation(),
      });
      if (health.apiVersion !== '1.0' || health.data?.pairingRequired !== true) {
        throw new Error('launched Cave returned an invalid health envelope');
      }
      addAssertion(
        results,
        'phase1.missing-cave.validated-launch',
        'passed',
        'phase1.assertion.passed',
      );
    } catch (error) {
      process.stderr.write(
        `phase1-conformance: phase1.missing-cave.validated-launch failed: ${error instanceof Error ? error.message : 'unknown'}\n`,
      );
      addAssertion(
        results,
        'phase1.missing-cave.validated-launch',
        'failed',
        'phase1.assertion.failed',
      );
    }

    try {
      if (typeof handle !== 'string') {
        throw new Error('no native authority handle');
      }
      const paired = await pairNative(rpc, handle, origin, adminToken, 'phase1-installation-1');
      credentialId = paired.credentialId;
      addAssertion(
        results,
        'phase1.pairing.create-pending-approve-exchange',
        'passed',
        'phase1.assertion.passed',
      );
    } catch (error) {
      process.stderr.write(
        `phase1-conformance: phase1.pairing.create-pending-approve-exchange failed: ${error instanceof Error ? error.message : 'unknown'}\n`,
      );
      addAssertion(
        results,
        'phase1.pairing.create-pending-approve-exchange',
        'failed',
        'phase1.integration.native-pairing-exchange-failed',
      );
      try {
        if (typeof handle === 'string') {
          await rpc.ok('cave_reset_pairing', { handle });
          const discovery = await waitForDiscovery(rpc);
          handle = discovery.handle;
          await rpc.ok('cave_health', { handle, operation: rpc.operation() });
        }
      } catch {
        // The denial leg below will record an independent failure if recovery
        // from the failed exchange did not restore a usable authority handle.
      }
    }

    try {
      const created = await rpc.ok('cave_pairing_create', {
        handle,
        request: {
          appName: 'OpenCoven Chat',
          installationId: 'phase1-installation-denied',
          scopes: ['chat:read'],
        },
        operation: rpc.operation(),
      });
      await adminMutation(
        origin,
        adminToken,
        'POST',
        `/admin/pairing-requests/${created.requestId}/decision`,
        { decision: 'denied' },
      );
      const denied = await rpc.ok('cave_pairing_poll', {
        handle,
        requestId: created.requestId,
        operation: rpc.operation(),
      });
      assertPairingStatus(denied, 'denied');
      addAssertion(results, 'phase1.pairing.denial', 'passed', 'phase1.assertion.passed');
    } catch (error) {
      process.stderr.write(
        `phase1-conformance: phase1.pairing.denial failed: ${error instanceof Error ? error.message : 'unknown'}\n`,
      );
      addAssertion(results, 'phase1.pairing.denial', 'failed', 'phase1.assertion.failed');
    }

    if (typeof credentialId !== 'string') {
      addAssertion(
        results,
        'phase1.credential.restart-reuse',
        'blocked',
        'phase1.integration.native-credential-unavailable',
      );
    } else {
      try {
        await rpc.ok('cave_reset_pairing', { handle });
        const discovery = await waitForDiscovery(rpc);
        handle = discovery.handle;
        await rpc.ok('cave_health', { handle, operation: rpc.operation() });
        const status = await rpc.ok('cave_credential_status', {
          handle,
          operation: rpc.operation(),
        });
        if (status.status !== 'valid') {
          throw new Error('credential was not reused after native state restart');
        }
        addAssertion(
          results,
          'phase1.credential.restart-reuse',
          'passed',
          'phase1.assertion.passed',
        );
      } catch (error) {
        process.stderr.write(
          `phase1-conformance: phase1.credential.restart-reuse failed: ${error instanceof Error ? error.message : 'unknown'}\n`,
        );
        addAssertion(
          results,
          'phase1.credential.restart-reuse',
          'failed',
          'phase1.assertion.failed',
        );
      }
    }

    if (typeof credentialId !== 'string') {
      addAssertion(
        results,
        'phase1.reads.bounded-canonical',
        'blocked',
        'phase1.integration.native-credential-unavailable',
      );
    } else {
      try {
        const familiars = collection(
          await rpc.ok('cave_list_familiars', {
            handle,
            page: { limit: 1 },
            operation: rpc.operation(),
          }),
          'familiars',
        );
        const projects = collection(
          await rpc.ok('cave_list_projects', {
            handle,
            page: { limit: 2 },
            operation: rpc.operation(),
          }),
          'projects',
        );
        const conversations = collection(
          await rpc.ok('cave_list_conversations', {
            handle,
            page: { limit: 2 },
            operation: rpc.operation(),
          }),
          'conversations',
        );
        const conversation = await rpc.ok('cave_get_conversation', {
          handle,
          conversationId: 'branched',
          operation: rpc.operation(),
        });
        const messages = collection(
          await rpc.ok('cave_list_conversation_messages', {
            handle,
            conversationId: 'branched',
            page: { limit: 1 },
            operation: rpc.operation(),
          }),
          'messages',
        );
        if (
          familiars.length !== 1 ||
          projects.length > 2 ||
          conversations.length > 2 ||
          conversation.data?.conversation?.id !== 'branched' ||
          messages.length !== 1
        ) {
          throw new Error('bounded canonical reads returned unexpected shapes');
        }
        addAssertion(
          results,
          'phase1.reads.bounded-canonical',
          'passed',
          'phase1.assertion.passed',
        );
      } catch (error) {
        process.stderr.write(
          `phase1-conformance: phase1.reads.bounded-canonical failed: ${error instanceof Error ? error.message : 'unknown'}\n`,
        );
        addAssertion(
          results,
          'phase1.reads.bounded-canonical',
          'failed',
          'phase1.assertion.failed',
        );
      }
    }

    if (typeof credentialId !== 'string') {
      addAssertion(
        results,
        'phase1.reads.stale-generation-cursor-reconciliation',
        'blocked',
        'phase1.integration.native-credential-unavailable',
      );
    } else {
      try {
        const firstPage = await rpc.ok('cave_list_conversation_messages', {
          handle,
          conversationId: 'branched',
          page: { limit: 2 },
          operation: rpc.operation(),
        });
        const cursor = firstPage.cursor?.next;
        if (typeof cursor !== 'string') {
          throw new Error('message read did not return a cursor');
        }
        const conversationPath = resolve(caveHome, 'conversations', 'branched.json');
        const conversation = JSON.parse(readFileSync(conversationPath, 'utf8'));
        conversation.activeLeafId = 'b-other';
        writeFileSync(conversationPath, `${JSON.stringify(conversation)}\n`, { mode: 0o600 });
        await rpc.error(
          'cave_list_conversation_messages',
          {
            handle,
            conversationId: 'branched',
            page: { limit: 1, cursor },
            operation: rpc.operation(),
          },
          'reconcile_required',
        );
        const staleHandle = handle;
        await rpc.ok('cave_reset_pairing', { handle });
        const discovery = await waitForDiscovery(rpc);
        handle = discovery.handle;
        await rpc.error(
          'cave_health',
          { handle: staleHandle, operation: rpc.operation() },
          'invalid_discovery_handle',
        );
        await rpc.ok('cave_health', { handle, operation: rpc.operation() });
        addAssertion(
          results,
          'phase1.reads.stale-generation-cursor-reconciliation',
          'passed',
          'phase1.assertion.passed',
        );
      } catch (error) {
        process.stderr.write(
          `phase1-conformance: phase1.reads.stale-generation-cursor-reconciliation failed: ${error instanceof Error ? error.message : 'unknown'}\n`,
        );
        addAssertion(
          results,
          'phase1.reads.stale-generation-cursor-reconciliation',
          'failed',
          'phase1.assertion.failed',
        );
      }
    }

    if (typeof credentialId !== 'string') {
      addAssertion(
        results,
        'phase1.credential.revocation-repair',
        'blocked',
        'phase1.integration.native-credential-unavailable',
      );
    } else {
      try {
        await adminMutation(origin, adminToken, 'DELETE', `/admin/credentials/${credentialId}`, {
          reason: 'phase1-conformance',
        });
        const initialStatus = await rpc.ok('cave_credential_status', {
          handle,
          operation: rpc.operation(),
        });
        if (
          initialStatus.status !== 'disconnected' ||
          initialStatus.reason !== 'reconcile_required'
        ) {
          throw new Error('native credential did not request revocation reconciliation');
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, revocationConfirmationDelayMs));
        const rediscovery = await waitForDiscovery(rpc);
        handle = rediscovery.handle;
        await rpc.ok('cave_health', { handle, operation: rpc.operation() });
        const status = await rpc.ok('cave_credential_status', {
          handle,
          operation: rpc.operation(),
        });
        if (!['revoked', 'missing'].includes(status.status)) {
          throw new Error('native credential did not converge to revoked');
        }
        const repaired = await pairNative(
          rpc,
          handle,
          origin,
          adminToken,
          'phase1-installation-repaired',
        );
        if (typeof repaired.credentialId !== 'string') {
          throw new Error('native re-pairing did not issue a credential');
        }
        addAssertion(
          results,
          'phase1.credential.revocation-repair',
          'passed',
          'phase1.assertion.passed',
        );
      } catch (error) {
        process.stderr.write(
          `phase1-conformance: phase1.credential.revocation-repair failed: ${error instanceof Error ? error.message : 'unknown'}\n`,
        );
        addAssertion(
          results,
          'phase1.credential.revocation-repair',
          'failed',
          'phase1.assertion.failed',
        );
      }
    }

    try {
      const discoveryPath = resolve(caveHome, 'client-v1-discovery.json');
      const discovery = JSON.parse(readFileSync(discoveryPath, 'utf8'));
      discovery.endpoint = 'http://127.0.0.1:1';
      writeFileSync(discoveryPath, `${JSON.stringify(discovery)}\n`, { mode: 0o600 });
      await rpc.error(
        'cave_health',
        { handle, operation: rpc.operation() },
        'stale_discovery_handle',
      );
    } catch {
      // The native trust half is real, but the locked RPC exposes only memory
      // custody and therefore cannot exercise a missing OS keychain.
    }
  } finally {
    await rpc.close().catch(() => undefined);
    await fixtureDaemon.close();
  }
}

async function runCovenIdentityScenario(artifactRoot, covenBinaryPath, environment, results) {
  const covenRoot = createProcessOwnedArtifactRoot({ prefix: 'p1cv', shortPath: true });
  const covenHome = resolve(covenRoot.rootPath, 'cv');
  mkdirSync(covenHome, { recursive: true, mode: 0o700 });
  const child = spawn(covenBinaryPath, ['daemon', 'serve'], {
    env: { ...environment, COVEN_HOME: covenHome },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  await once(child, 'spawn');
  covenRoot.trackChild(child);
  try {
    let running = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const status = await runCommand(
          artifactRoot,
          'Coven daemon authenticated status',
          covenBinaryPath,
          ['daemon', 'status', '--json'],
          {
            env: { ...environment, COVEN_HOME: covenHome },
            timeoutMs: 5_000,
          },
        );
        const parsed = JSON.parse(status.stdout);
        if (parsed.status === 'running' && parsed.ok === true) {
          running = true;
          break;
        }
      } catch (error) {
        process.stderr.write(
          `phase1-conformance: phase1.coven.same-user-identity failed: ${error instanceof Error ? error.message : 'unknown'}\n`,
        );
        // The foreground server may not have published its socket yet.
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (!running) {
      throw new Error('Coven daemon did not authenticate its same-user transport');
    }
    await triggerAndWaitForChildClose(child, () =>
      runCommand(
        artifactRoot,
        'Coven daemon authenticated stop',
        covenBinaryPath,
        ['daemon', 'stop'],
        {
          env: { ...environment, COVEN_HOME: covenHome },
          timeoutMs: 10_000,
        },
      ),
    );
    addAssertion(results, 'phase1.coven.same-user-identity', 'passed', 'phase1.assertion.passed');
  } catch (error) {
    process.stderr.write(
      `phase1-conformance: phase1.coven.same-user-identity failed: ${error instanceof Error ? error.message : 'unknown'}\n`,
    );
    addAssertion(
      results,
      'phase1.coven.same-user-identity',
      'failed',
      'phase1.integration.coven-identity-failed',
    );
  } finally {
    await covenRoot.cleanup();
  }
}

function recordCaveBackedAssertions(results, caveAssertions) {
  const mappings = [
    ['phase1.pairing.expiry', ['pairing.ttl-poll-expired', 'pairing.ttl-exchange-expired']],
    [
      'phase1.pairing.wrong-secret-replay',
      ['pairing.wrong-secret', 'pairing.replay-refused', 'pairing.poll-after-exchange'],
    ],
    [
      'phase1.pairing.failure-budget-retry-after',
      [
        'pairing.budget-charges-wrong-secret-on-poll',
        'pairing.budget-locks-out-the-holder',
        'pairing.budget-is-shared-across-routes',
        'pairing.budget-is-per-pairing',
      ],
    ],
    [
      'phase1.hpke.endpoint-takeover',
      [
        'takeover.legacy.exposes-pairing-secret',
        'takeover.bound.exposes-ciphertext-only',
        'takeover.bound.replacement-cannot-open',
        'takeover.bound.plaintext-response-rejected',
        'takeover.bound.forged-auth-response-rejected',
      ],
    ],
  ];
  for (const [id, caveIds] of mappings) {
    addAssertion(
      results,
      id,
      requirePassedAssertions(caveAssertions, caveIds) ? 'passed' : 'failed',
      requirePassedAssertions(caveAssertions, caveIds)
        ? 'phase1.assertion.passed'
        : 'phase1.assertion.failed',
    );
  }
}

function fillMissingAssertions(results, status, diagnosticId) {
  for (const id of REQUIRED_PHASE1_ASSERTION_IDS) {
    if (!results.has(id)) {
      addAssertion(results, id, status, diagnosticId);
    }
  }
}

export async function runPhase1Conformance(options = parseArgs([])) {
  const lock = readPhase1ConformanceLock(options.lockPath);
  const executionRoot = createProcessOwnedArtifactRoot({ prefix: 'phase1-conformance-run' });
  const reportRoot = createProcessOwnedArtifactRoot({ prefix: 'phase1-conformance-report' });
  const environment = safeEnvironment(executionRoot.rootPath);
  const results = new Map();
  let artifactDigests = {};
  let infrastructureFailure;

  try {
    const roots = await createExactCheckouts(executionRoot, options, lock, environment);
    const packaged = await packageLockedArtifacts(executionRoot, roots, environment);
    artifactDigests = packaged.artifactDigests;

    try {
      const caveAssertions = await runCaveAuthorityMatrix(
        executionRoot,
        roots.caveRoot,
        environment,
      );
      recordCaveBackedAssertions(results, caveAssertions);
    } catch (error) {
      const output = error instanceof CommandExecutionError ? (error.result?.stdout ?? '') : '';
      recordCaveBackedAssertions(results, parseCaveConformanceOutput(output));
    }

    await runNativeScenarios({
      artifactRoot: executionRoot,
      roots,
      nativeRpcPath: packaged.nativeRpcPath,
      environment,
      results,
    });
    await runCovenIdentityScenario(executionRoot, packaged.covenBinaryPath, environment, results);

    addAssertion(
      results,
      'phase1.compat.api-major-min-client',
      'blocked',
      'phase1.producer.compatibility-control-unavailable',
    );
    addAssertion(
      results,
      'phase1.native.missing-keychain-trust',
      'blocked',
      'phase1.producer.native-trust-fixture-unavailable',
    );

    addAssertion(
      results,
      'phase1.operator.homes-credentials-untouched',
      environment.HOME !== process.env.HOME &&
        environment.XDG_CONFIG_HOME.startsWith(executionRoot.rootPath) &&
        environment.TMPDIR.startsWith(executionRoot.rootPath)
        ? 'passed'
        : 'failed',
      environment.HOME !== process.env.HOME &&
        environment.XDG_CONFIG_HOME.startsWith(executionRoot.rootPath) &&
        environment.TMPDIR.startsWith(executionRoot.rootPath)
        ? 'phase1.assertion.passed'
        : 'phase1.assertion.failed',
    );
  } catch (error) {
    infrastructureFailure = error;
    fillMissingAssertions(results, 'failed', 'phase1.assertion.failed');
  }

  if (!results.has('phase1.native.missing-keychain-trust')) {
    addAssertion(
      results,
      'phase1.native.missing-keychain-trust',
      'blocked',
      'phase1.producer.native-trust-fixture-unavailable',
    );
  }
  if (!results.has('phase1.compat.api-major-min-client')) {
    addAssertion(
      results,
      'phase1.compat.api-major-min-client',
      'blocked',
      'phase1.producer.compatibility-control-unavailable',
    );
  }
  fillMissingAssertions(results, 'blocked', 'phase1.assertion.blocked');

  try {
    await executionRoot.cleanup();
  } catch (error) {
    infrastructureFailure ??= error;
    for (const [id, assertion] of results) {
      if (assertion.status === 'passed') {
        results.set(id, makeAssertion(id, 'failed', 'phase1.assertion.failed'));
      }
    }
  }

  const report = buildPhase1Report({
    assertions: [...results.values()],
    revisions: {
      chat: lock.chat.revision,
      sdk: lock.sdk.revision,
      cave: lock.cave.revision,
      coven: lock.coven.revision,
    },
    artifactDigests,
    versions: {
      harness: '1.0.0',
      node: process.versions.node,
    },
  });
  const reportPath = resolve(reportRoot.rootPath, 'report.json');
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await reportRoot.retainSanitizedJsonReport({
    reportPath,
    destinationPath: options.retainSanitizedReport,
    secretScan: ({ artifactRoot }) => scanPhase1Artifacts({ artifactRoot }),
  });
  await reportRoot.cleanup();

  if (infrastructureFailure !== undefined) {
    throw new CommandExecutionError(
      infrastructureFailure instanceof CommandExecutionError
        ? infrastructureFailure.label
        : 'Phase 1 conformance infrastructure',
      { report },
    );
  }
  return report;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const report = await runPhase1Conformance(options);
  process.stdout.write(
    `phase1-conformance: ${report.status} (${report.summary.passed} passed, ${report.summary.failed} failed, ${report.summary.blocked} blocked)\n`,
  );
  for (const assertion of report.assertions) {
    if (assertion.status !== 'passed') {
      process.stdout.write(
        `${assertion.status.toUpperCase()} ${assertion.id} ${assertion.diagnosticIds.join(',')}\n`,
      );
    }
  }
  process.exitCode = report.status === 'passed' ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const label = error instanceof CommandExecutionError ? error.label : 'Phase 1 conformance';
    process.stderr.write(`phase1-conformance: ${label} failed\n`);
    process.exitCode = 1;
  });
}
