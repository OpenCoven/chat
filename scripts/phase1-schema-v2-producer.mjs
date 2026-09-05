#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { devNull, homedir } from 'node:os';
import { delimiter, dirname, isAbsolute, resolve, win32 as windowsPath } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { stripVTControlCharacters } from 'node:util';

import { FROZEN_PACKED_CONSUMER_STAGES } from './contract-canary.mjs';
import {
  APPROVED_PHASE1_DIAGNOSTIC_IDS,
  REQUIRED_PHASE1_ASSERTION_IDS,
  scanPhase1Artifacts,
  scanPhase1ArtifactText,
  validatePhase1SanitizedReport,
} from './phase1-artifact-secret-scan.mjs';
import {
  assertCleanPhase1Checkout,
  assertCleanPhase1Checkouts,
  assertPhase1CheckoutHeads,
  assertPhase1ProducerAuthority,
  createGitCheckoutEnvironment,
  createGitEnvironment,
  readPhase1CheckoutIdentity,
  requirePhase1HarnessAuthorityVerification,
  resolveLocalGitDirectory,
} from './phase1-conformance-lock.mjs';
import {
  buildIsolationEvidence,
  captureOperatorFilesystemState,
} from './phase1-evidence-runtime.mjs';
import { curateLinuxSecretServiceEnvironment } from './phase1-linux-secret-service.mjs';
import { prepareMacosKeychainSession } from './phase1-macos-keychain.mjs';
import {
  assertSdkContractMatchesPhase1Lock,
  buildSchemaV2PlatformEvidence,
  CANONICAL_PLATFORM_ENVIRONMENTS,
  collectFrozenEvidenceArtifacts,
  createObservedAssertionRecorder,
  loadSdkEvidenceContract,
  PHASE1_SCHEMA_V2_HARNESS_VERSION,
  serializeValidatedSchemaV2PlatformEvidence,
  verifySchemaV2ProducerCheckout,
} from './phase1-schema-v2-evidence.mjs';
import { createProcessOwnedArtifactRoot } from './process-owned-artifact-root.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultRetainedReport = resolve(
  projectRoot,
  'test-results',
  'phase1-conformance',
  'report.json',
);
const commandOutputLimit = 16 * 1024 * 1024;
const revocationConfirmationDelayMs = 550;
const commandTimeoutMs = 20 * 60_000;
export const cargoBuildTimeoutMs = 45 * 60_000;
const rpcTimeoutMs = 10_000;
const caveConformanceTimeoutMs = 15 * 60_000;
const caveBuildNodeOptions = '--max-old-space-size=6144';
const caveBuildReportedCpuTotal = '3';
const ownedProcessGroupsSupported = process.platform !== 'win32';
const approvedDiagnosticSet = new Set(APPROVED_PHASE1_DIAGNOSTIC_IDS);
const schemaV2NativeFailureStages = new Set([
  'fixture-daemon',
  'fixture',
  'rpc-start',
  'native-preflight',
  'launch',
  'pairing',
  'pairing-recovery',
  'pairing-denial',
  'restart',
  'restart-launch',
  'restart-discovery',
  'restart-health',
  'restart-status',
  'reads',
  'reconciliation',
  'revocation',
  'revocation-delete',
  'revocation-initial-status',
  'revocation-rediscovery',
  'revocation-health',
  'revocation-status',
  'revocation-repair',
  'stale-discovery',
  'cleanup',
  'cleanup-grant',
  'cleanup-custody',
  'cleanup-rpc',
  'cleanup-fixture-daemon',
  'missing-keychain',
  'isolation-proof',
]);
const publicFailureDiagnosticSet = new Set([
  ...APPROVED_PHASE1_DIAGNOSTIC_IDS,
  'phase1.stage.checkouts.failed',
  'phase1.stage.evidence-authority.failed',
  'phase1.stage.toolchain.failed',
  'phase1.stage.packaging.failed',
  'phase1.packaging.frozen-consumer.failed',
  ...FROZEN_PACKED_CONSUMER_STAGES.map(
    (stage) => `phase1.packaging.frozen-consumer.${stage}.failed`,
  ),
  'phase1.packaging.cave-install.failed',
  'phase1.packaging.cave-build.failed',
  'phase1.packaging.cave-build.exit-nonzero',
  'phase1.packaging.cave-build.timeout',
  'phase1.packaging.cave-build.output-limit',
  'phase1.packaging.cave-build.spawn',
  'phase1.packaging.cave-build.supervisor',
  'phase1.packaging.cave-build.phase.prebuild',
  'phase1.packaging.cave-build.phase.conformance-wrapper',
  'phase1.packaging.cave-build.phase.next-build',
  'phase1.packaging.cave-build.phase.next-build.resource',
  'phase1.packaging.cave-build.phase.next-build.resource.spawn',
  'phase1.packaging.cave-build.phase.next-build.resource.memory',
  'phase1.packaging.cave-build.phase.next-build.resource.memory.heap',
  'phase1.packaging.cave-build.phase.next-build.resource.memory.allocation',
  'phase1.packaging.cave-build.phase.next-build.resource.killed',
  'phase1.packaging.cave-build.phase.next-build.compile',
  'phase1.packaging.cave-build.phase.next-build.typescript',
  'phase1.packaging.cave-build.phase.next-build.page-data',
  'phase1.packaging.cave-build.phase.next-build.static-pages',
  'phase1.packaging.cave-build.phase.next-build.finalization',
  'phase1.packaging.cave-build.phase.server-bundle',
  'phase1.packaging.cave-build.phase.postbuild',
  'phase1.packaging.cave-build.phase.unknown',
  'phase1.packaging.chat-install.failed',
  'phase1.packaging.chat-web-build.failed',
  'phase1.packaging.chat-native-build.failed',
  'phase1.packaging.coven-build.failed',
  'phase1.packaging.outputs.failed',
  'phase1.stage.runtime-assertions.failed',
  'phase1.stage.cave-authority.failed',
  'phase1.stage.native-scenarios.failed',
  ...[...schemaV2NativeFailureStages].map((stage) => `phase1.native-scenarios.${stage}`),
  'phase1.stage.coven-identity.failed',
  'phase1.stage.isolation.failed',
  'phase1.stage.execution-root-cleanup.failed',
]);
const requiredAssertionSet = new Set(REQUIRED_PHASE1_ASSERTION_IDS);
const approvedCommandFailureReasons = new Set([
  'compile-failed',
  'compiler-crash',
  'disk-exhausted',
  'memory-exhausted',
  'page-data-failed',
  'process-killed',
  'spawn',
  'tracking',
  'stdout-limit',
  'stderr-limit',
  'timeout',
  'turbopack-plugin-timeout',
  'worker-exited',
]);
const evidenceAuthorizationVariables = new Set([
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'GH_TOKEN',
  'GITHUB_TOKEN',
]);

export function scrubEvidenceAuthorizationEnvironment(environment = process.env) {
  for (const key of Object.keys(environment)) {
    if (evidenceAuthorizationVariables.has(key.toUpperCase())) {
      delete environment[key];
    }
  }
  return environment;
}

export function schemaV2CaveBuildEnvironment(environment = process.env) {
  return {
    ...environment,
    NODE_OPTIONS: caveBuildNodeOptions,
    CIRCLE_NODE_TOTAL: caveBuildReportedCpuTotal,
    COVEN_CAVE_CLIENT_V1_COMPATIBILITY_CONTROL: '1',
  };
}

export function windowsJobBindingEnvironment(
  environment = process.env,
  platform = process.platform,
) {
  if (platform !== 'win32') {
    return {};
  }
  const required = environment.OPENCOVEN_WINDOWS_JOB_REQUIRED;
  const nonce = environment.OPENCOVEN_WINDOWS_JOB_NONCE;
  const name = environment.OPENCOVEN_WINDOWS_JOB_NAME;
  const systemPwsh = environment.OPENCOVEN_WINDOWS_SYSTEM_PWSH;
  const bootstrapRoot = environment.OPENCOVEN_WINDOWS_BOOTSTRAP_ROOT;
  const workspace = environment.OPENCOVEN_WINDOWS_WORKSPACE;
  const artifactDirectory = environment.OPENCOVEN_WINDOWS_ARTIFACT_DIRECTORY;
  const sourceRecord = environment.OPENCOVEN_WINDOWS_SOURCE_RECORD;
  const systemRoot = environment.SYSTEMROOT;
  const windowsDirectory = environment.WINDIR;
  const commandProcessor = environment.COMSPEC;
  const temporaryDirectory = environment.TEMP;
  const secondaryTemporaryDirectory = environment.TMP;
  const executablePath = environment.PATH;
  const pathExtensions = environment.PATHEXT;
  const compilerLibraryPath = environment.LIB;
  const compilerIncludePath = environment.INCLUDE;
  if (required !== '1') {
    throw new Error('Windows schema-v2 evidence Job Object supervision is required.');
  }
  if (
    typeof nonce !== 'string' ||
    !/^[0-9a-f]{32}$/u.test(nonce) ||
    name !== `Local\\OpenCoven.Chat.Conformance.${nonce}`
  ) {
    throw new Error('Windows Job Object supervision is not nonce-bound.');
  }
  if (
    typeof systemPwsh !== 'string' ||
    systemPwsh.toLowerCase() !== 'c:\\program files\\powershell\\7\\pwsh.exe'
  ) {
    throw new Error('Windows Job Object membership requires trusted system PowerShell.');
  }
  for (const [label, value] of [
    ['library', compilerLibraryPath],
    ['include', compilerIncludePath],
  ]) {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.includes('\n') ||
      value.includes('\r') ||
      value.split(';').some((path) => {
        const lower = path.toLowerCase();
        return (
          !/^[a-z]:\\/u.test(lower) ||
          lower.includes('\\..\\') ||
          (!lower.startsWith(
            'c:\\program files\\microsoft visual studio\\2022\\enterprise\\vc\\tools\\msvc\\14.',
          ) &&
            !lower.startsWith('c:\\program files (x86)\\windows kits\\10\\'))
        );
      })
    ) {
      throw new Error(`Windows Job Object ${label} path is outside trusted toolchain roots.`);
    }
  }
  const requireCanonicalWindowsPath = (value, label) => {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.includes('\0') ||
      value.includes('\n') ||
      value.includes('\r') ||
      !windowsPath.isAbsolute(value) ||
      windowsPath.normalize(value) !== value
    ) {
      throw new Error(`Windows Job Object ${label} path is invalid.`);
    }
    return value;
  };
  const requireDescendant = (root, candidate, label) => {
    const relativePath = windowsPath.relative(root, candidate);
    if (
      relativePath.length === 0 ||
      relativePath === '..' ||
      relativePath.startsWith(`..${windowsPath.sep}`) ||
      windowsPath.isAbsolute(relativePath)
    ) {
      throw new Error(`Windows Job Object ${label} path is outside the bootstrap root.`);
    }
  };
  const canonicalBootstrapRoot = requireCanonicalWindowsPath(bootstrapRoot, 'bootstrap root');
  const canonicalWorkspace = requireCanonicalWindowsPath(workspace, 'workspace');
  const canonicalArtifactDirectory = requireCanonicalWindowsPath(
    artifactDirectory,
    'artifact directory',
  );
  const canonicalSourceRecord = requireCanonicalWindowsPath(sourceRecord, 'artifact record');
  const canonicalTemporaryDirectory = requireCanonicalWindowsPath(temporaryDirectory, 'temporary');
  const canonicalSecondaryTemporaryDirectory = requireCanonicalWindowsPath(
    secondaryTemporaryDirectory,
    'secondary temporary',
  );
  requireDescendant(canonicalBootstrapRoot, canonicalWorkspace, 'workspace');
  requireDescendant(canonicalBootstrapRoot, canonicalTemporaryDirectory, 'temporary');
  if (
    windowsPath.basename(canonicalBootstrapRoot).toLowerCase() !== `opencoven-win32-${nonce}` ||
    canonicalWorkspace.toLowerCase() !==
      windowsPath.join(canonicalBootstrapRoot, 'workspace').toLowerCase() ||
    canonicalTemporaryDirectory.toLowerCase() !==
      windowsPath.join(canonicalBootstrapRoot, 'temp').toLowerCase() ||
    canonicalSecondaryTemporaryDirectory.toLowerCase() !==
      canonicalTemporaryDirectory.toLowerCase() ||
    canonicalArtifactDirectory.toLowerCase() !==
      windowsPath.join(canonicalWorkspace, '.artifacts').toLowerCase() ||
    canonicalSourceRecord.toLowerCase() !==
      windowsPath
        .join(canonicalArtifactDirectory, 'client-v1-conformance-win32-x64.json')
        .toLowerCase() ||
    existsSync(canonicalSourceRecord)
  ) {
    throw new Error('Windows Job Object artifact or temporary binding is invalid.');
  }
  if (
    typeof systemRoot !== 'string' ||
    typeof windowsDirectory !== 'string' ||
    systemRoot.toLowerCase() !== 'c:\\windows' ||
    windowsDirectory.toLowerCase() !== 'c:\\windows' ||
    typeof commandProcessor !== 'string' ||
    commandProcessor.toLowerCase() !== 'c:\\windows\\system32\\cmd.exe'
  ) {
    throw new Error('Windows Job Object base system environment is invalid.');
  }
  if (
    typeof executablePath !== 'string' ||
    executablePath.length === 0 ||
    executablePath.includes('\0') ||
    executablePath.includes('\n') ||
    executablePath.includes('\r') ||
    pathExtensions !== '.COM;.EXE;.BAT;.CMD'
  ) {
    throw new Error('Windows Job Object executable environment is invalid.');
  }
  return {
    OPENCOVEN_WINDOWS_JOB_REQUIRED: required,
    OPENCOVEN_WINDOWS_JOB_NONCE: nonce,
    OPENCOVEN_WINDOWS_JOB_NAME: name,
    OPENCOVEN_WINDOWS_SYSTEM_PWSH: systemPwsh,
    OPENCOVEN_WINDOWS_BOOTSTRAP_ROOT: canonicalBootstrapRoot,
    OPENCOVEN_WINDOWS_WORKSPACE: canonicalWorkspace,
    OPENCOVEN_WINDOWS_ARTIFACT_DIRECTORY: canonicalArtifactDirectory,
    OPENCOVEN_WINDOWS_SOURCE_RECORD: canonicalSourceRecord,
    SYSTEMROOT: systemRoot,
    WINDIR: windowsDirectory,
    COMSPEC: commandProcessor,
    TEMP: canonicalTemporaryDirectory,
    TMP: canonicalSecondaryTemporaryDirectory,
    PATH: executablePath,
    PATHEXT: pathExtensions,
    LIB: compilerLibraryPath,
    INCLUDE: compilerIncludePath,
  };
}

export function unixProducerBindingEnvironment(
  environment = process.env,
  platform = process.platform,
  architecture = process.arch,
  currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined,
  cgroupMembership = platform === 'linux' ? readFileSync('/proc/self/cgroup', 'utf8') : '',
) {
  if (platform === 'win32') {
    return {};
  }
  const fail = () => {
    throw new Error('Unix schema-v2 evidence requires trusted distinct-UID containment.');
  };
  if ((platform !== 'linux' && platform !== 'darwin') || currentUid === undefined) {
    fail();
  }
  const required = environment.OPENCOVEN_UNIX_PRODUCER_REQUIRED;
  const evidencePlatform = environment.OPENCOVEN_UNIX_PRODUCER_PLATFORM;
  const producerUidText = environment.OPENCOVEN_UNIX_PRODUCER_UID;
  const producerName = environment.OPENCOVEN_UNIX_PRODUCER_NAME;
  const brokerUidText = environment.OPENCOVEN_UNIX_BROKER_UID;
  const containment = environment.OPENCOVEN_UNIX_CONTAINMENT;
  const cgroupPath = environment.OPENCOVEN_UNIX_CGROUP_PATH;
  const workspace = environment.OPENCOVEN_UNIX_WORKSPACE;
  const artifactDirectory = environment.OPENCOVEN_UNIX_ARTIFACT_DIRECTORY;
  const sourceRecord = environment.OPENCOVEN_UNIX_SOURCE_RECORD;
  const canonicalUid = /^(?:0|[1-9][0-9]{0,9})$/u;
  if (
    required !== '1' ||
    typeof producerUidText !== 'string' ||
    typeof brokerUidText !== 'string' ||
    !canonicalUid.test(producerUidText) ||
    !canonicalUid.test(brokerUidText) ||
    Number(producerUidText) !== currentUid ||
    producerUidText === brokerUidText ||
    Number(producerUidText) === 0 ||
    Number(brokerUidText) === 0 ||
    evidencePlatform !== `${platform}-${architecture}` ||
    typeof producerName !== 'string' ||
    !/^ocv[0-9a-f]{16}$/u.test(producerName)
  ) {
    fail();
  }
  const requireCanonicalDirectory = (path) => {
    if (
      typeof path !== 'string' ||
      path.length === 0 ||
      path.includes('\0') ||
      path.includes('\n') ||
      path.includes('\r') ||
      !isAbsolute(path) ||
      resolve(path) !== path
    ) {
      fail();
    }
    let stats;
    try {
      stats = lstatSync(path);
      if (stats.isSymbolicLink() || !stats.isDirectory() || realpathSync(path) !== path) {
        fail();
      }
    } catch {
      fail();
    }
    return stats;
  };
  requireCanonicalDirectory(workspace);
  const artifactStats = requireCanonicalDirectory(artifactDirectory);
  const expectedArtifactDirectory = resolve(
    dirname(workspace),
    'producer',
    'workspace',
    '.artifacts',
  );
  const expectedSourceRecord = resolve(
    artifactDirectory,
    `client-v1-conformance-${evidencePlatform}.json`,
  );
  if (
    artifactDirectory !== expectedArtifactDirectory ||
    sourceRecord !== expectedSourceRecord ||
    existsSync(sourceRecord) ||
    artifactStats.uid !== currentUid ||
    (artifactStats.mode & 0o077) !== 0
  ) {
    fail();
  }
  const binding = {
    OPENCOVEN_UNIX_PRODUCER_REQUIRED: required,
    OPENCOVEN_UNIX_PRODUCER_PLATFORM: evidencePlatform,
    OPENCOVEN_UNIX_PRODUCER_UID: producerUidText,
    OPENCOVEN_UNIX_PRODUCER_NAME: producerName,
    OPENCOVEN_UNIX_BROKER_UID: brokerUidText,
    OPENCOVEN_UNIX_CONTAINMENT: containment,
    OPENCOVEN_UNIX_WORKSPACE: workspace,
    OPENCOVEN_UNIX_ARTIFACT_DIRECTORY: artifactDirectory,
    OPENCOVEN_UNIX_SOURCE_RECORD: sourceRecord,
  };
  if (platform === 'linux') {
    const producerNonce = producerName.slice(3);
    if (
      containment !== 'linux-cgroup-v2' ||
      typeof cgroupPath !== 'string' ||
      !/^\/(?:[A-Za-z0-9_.-]+\/)*opencoven-chat-[0-9a-f]{16}$/u.test(cgroupPath) ||
      !cgroupPath.endsWith(`/opencoven-chat-${producerNonce}`) ||
      !cgroupMembership.split(/\r?\n/u).includes(`0::${cgroupPath}`)
    ) {
      fail();
    }
    return {
      ...binding,
      OPENCOVEN_UNIX_CGROUP_PATH: cgroupPath,
    };
  }
  if (containment !== 'macos-uid' || cgroupPath !== undefined) {
    fail();
  }
  return binding;
}

export function schemaV2SupervisorEnvironment(
  environment = process.env,
  platform = process.platform,
  architecture = process.arch,
  currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined,
  cgroupMembership = platform === 'linux' ? readFileSync('/proc/self/cgroup', 'utf8') : '',
) {
  return platform === 'win32'
    ? windowsJobBindingEnvironment(environment, platform)
    : unixProducerBindingEnvironment(
        environment,
        platform,
        architecture,
        currentUid,
        cgroupMembership,
      );
}

export function supervisorArtifactOutputPath(binding, platform = process.platform) {
  const path =
    platform === 'win32'
      ? binding.OPENCOVEN_WINDOWS_SOURCE_RECORD
      : binding.OPENCOVEN_UNIX_SOURCE_RECORD;
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('Schema-v2 evidence supervisor artifact path is unavailable.');
  }
  return path;
}

export function runPowerShellCommandWithArgs(
  executable,
  script,
  args,
  { cwd = projectRoot, env = {}, timeout = 15_000 } = {},
) {
  if (
    typeof executable !== 'string' ||
    executable.length === 0 ||
    typeof script !== 'string' ||
    script.length === 0 ||
    !Array.isArray(args) ||
    args.some((argument) => typeof argument !== 'string' || argument.includes('\0')) ||
    !Number.isSafeInteger(timeout) ||
    timeout <= 0
  ) {
    throw new Error('PowerShell command-with-arguments invocation is invalid.');
  }
  return execFileSync(
    executable,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-CommandWithArgs', script, ...args],
    {
      cwd,
      encoding: 'utf8',
      env,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout,
      windowsHide: true,
    },
  );
}

function assertWindowsJobMembership(binding) {
  if (Object.keys(binding).length === 0) {
    return;
  }
  const script = `
$ErrorActionPreference = 'Stop'
$source = @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class OpenCovenExpectedJobMembership {
    private const uint JOB_OBJECT_QUERY = 0x0004;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenJobObjectW(uint access, bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint access, bool inherit, uint processId);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsProcessInJob(
        IntPtr process,
        IntPtr job,
        [MarshalAs(UnmanagedType.Bool)] out bool result);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);
    public static void Require(string name, uint processId) {
        IntPtr job = OpenJobObjectW(JOB_OBJECT_QUERY, false, name);
        if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, processId);
        if (process == IntPtr.Zero) {
            CloseHandle(job);
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        try {
            bool member;
            if (!IsProcessInJob(process, job, out member) || !member) {
                throw new InvalidOperationException("Harness process is outside the expected Job Object.");
            }
        } finally {
            CloseHandle(process);
            CloseHandle(job);
        }
    }
}
'@
Add-Type -TypeDefinition $source -Language CSharp
[OpenCovenExpectedJobMembership]::Require($args[0], [uint32]$args[1])
`;
  const output = runPowerShellCommandWithArgs(
    binding.OPENCOVEN_WINDOWS_SYSTEM_PWSH,
    script,
    [binding.OPENCOVEN_WINDOWS_JOB_NAME, String(process.pid)],
    {
      cwd: projectRoot,
      env: {
        SYSTEMROOT: binding.SYSTEMROOT,
        WINDIR: binding.WINDIR,
        COMSPEC: binding.COMSPEC,
        PATH: binding.PATH,
        PATHEXT: binding.PATHEXT,
        TEMP: binding.TEMP,
        TMP: binding.TMP,
      },
      timeout: 15_000,
    },
  );
  if (output.trim() !== '') {
    throw new Error('Windows Job Object membership probe returned unexpected output.');
  }
}

function killUntrackedOwnedChild(child) {
  if (ownedProcessGroupsSupported && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // Fall through to the direct child handle if the group is already gone.
    }
  }
  child.kill('SIGKILL');
}

function configuredSourceRoot(environmentName) {
  if (process.env[environmentName] !== undefined) {
    return resolve(process.env[environmentName]);
  }
  return undefined;
}

function resolveRepositoryLayout() {
  const gitCommonDirectory = resolve(
    projectRoot,
    execFileSync('git', ['-c', `safe.directory=${projectRoot}`, 'rev-parse', '--git-common-dir'], {
      cwd: projectRoot,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 15_000,
      killSignal: 'SIGKILL',
    }).trim(),
  );
  const chatRepositoryRoot = dirname(gitCommonDirectory);
  return {
    chatRepositoryRoot,
    repositoriesParent: dirname(chatRepositoryRoot),
  };
}

function resolveDefaultSourceRoots(options, repositoryLayout) {
  const source = { ...options };
  for (const [optionName, repositoryName] of [
    ['sdkSourceRoot', 'sdk'],
    ['sdkValidatorSourceRoot', 'sdk'],
    ['caveSourceRoot', 'coven-cave'],
    ['covenSourceRoot', 'coven'],
  ]) {
    if (source[optionName] === undefined) {
      const candidate = resolve(repositoryLayout.repositoriesParent, repositoryName);
      source[optionName] = existsSync(candidate) ? candidate : undefined;
    }
  }
  return source;
}

export class CommandExecutionError extends Error {
  constructor(label, result, cause) {
    const reason = approvedCommandFailureReasons.has(result?.reason) ? ` (${result.reason})` : '';
    super(`${label} failed${reason}.`, cause === undefined ? undefined : { cause });
    this.label = label;
    this.result = result;
  }
}

export function classifyCavePackageFailure(result) {
  const output = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
  const classifications = [
    [/timeout while receiving message from process/iu, 'turbopack-plugin-timeout'],
    [
      /heap out of memory|allocation failed|javascript heap|fatal process out of memory/iu,
      'memory-exhausted',
    ],
    [/no space left on device|\bENOSPC\b/u, 'disk-exhausted'],
    [/\b(?:SIGKILL|Killed: 9|signal 9)\b/u, 'process-killed'],
    [/\b(?:TurbopackInternalError|panic|segmentation fault|bus error)\b/iu, 'compiler-crash'],
    [/\b(?:static|build) worker exited\b/iu, 'worker-exited'],
    [/failed to collect page data/iu, 'page-data-failed'],
    [/failed to compile/iu, 'compile-failed'],
  ];
  return classifications.find(([pattern]) => pattern.test(output))?.[1];
}

const caveBuildDiagnosticByFailureReason = new Map([
  ['memory-exhausted', 'phase1.packaging.cave-build.phase.next-build.resource.memory'],
  ['process-killed', 'phase1.packaging.cave-build.phase.next-build.resource.killed'],
  ['page-data-failed', 'phase1.packaging.cave-build.phase.next-build.page-data'],
  ['compile-failed', 'phase1.packaging.cave-build.phase.next-build.compile'],
  ['compiler-crash', 'phase1.packaging.cave-build.phase.next-build.compile'],
  ['worker-exited', 'phase1.packaging.cave-build.phase.next-build.compile'],
  ['turbopack-plugin-timeout', 'phase1.packaging.cave-build.timeout'],
  ['disk-exhausted', 'phase1.packaging.cave-build.phase.next-build.resource'],
]);

function classifyCaveBuildFailureDiagnostic(error) {
  if (!(error instanceof CommandExecutionError)) {
    return 'phase1.packaging.cave-build.failed';
  }
  const reason = error.result?.reason;
  if (reason === 'timeout') {
    return 'phase1.packaging.cave-build.timeout';
  }
  if (reason === 'stdout-limit' || reason === 'stderr-limit') {
    return 'phase1.packaging.cave-build.output-limit';
  }
  if (reason === 'spawn' || reason === 'tracking') {
    return 'phase1.packaging.cave-build.spawn';
  }
  const classifiedDiagnostic = caveBuildDiagnosticByFailureReason.get(reason);
  if (classifiedDiagnostic !== undefined) {
    return classifiedDiagnostic;
  }
  if (typeof error.result?.code !== 'number' || error.result.code === 0) {
    return 'phase1.packaging.cave-build.failed';
  }
  const output = stripVTControlCharacters(
    `${error.result.stdout ?? ''}\n${error.result.stderr ?? ''}`,
  ).replaceAll('\r\n', '\n');
  let phase = 'unknown';
  if (/^> coven-cave@\d+\.\d+\.\d+ postbuild(?:\s+.+)?$/mu.test(output)) {
    phase = 'postbuild';
  } else if (/^> coven-cave@\d+\.\d+\.\d+ build:server(?:\s+.+)?$/mu.test(output)) {
    phase = 'server-bundle';
  } else if (output.includes('Creating an optimized production build')) {
    phase = /\bEAGAIN\b/u.test(output)
      ? 'next-build.resource.spawn'
      : /\bheap out of memory\b/iu.test(output)
        ? 'next-build.resource.memory.heap'
        : /\bENOMEM\b/u.test(output)
          ? 'next-build.resource.memory.allocation'
          : /\b(?:Killed(?:: 9)?|SIGKILL)\b/u.test(output)
            ? 'next-build.resource.killed'
            : output.includes('Finalizing page optimization')
              ? 'next-build.finalization'
              : output.includes('Generating static pages')
                ? 'next-build.static-pages'
                : output.includes('Collecting page data')
                  ? 'next-build.page-data'
                  : output.includes('Compiled successfully')
                    ? 'next-build.typescript'
                    : 'next-build.compile';
  } else if (/^> coven-cave@\d+\.\d+\.\d+ prebuild(?:\s+.+)?$/mu.test(output)) {
    phase = 'prebuild';
  } else if (/^> coven-cave@\d+\.\d+\.\d+ build:conformance(?:\s+.+)?$/mu.test(output)) {
    phase = 'conformance-wrapper';
  }
  return `phase1.packaging.cave-build.phase.${phase}`;
}

export function schemaV2FailureDiagnostic(error, activeStage) {
  if (
    error !== null &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string' &&
    publicFailureDiagnosticSet.has(error.message)
  ) {
    return error.message;
  }
  if (activeStage === 'phase1.packaging.cave-build.failed') {
    return classifyCaveBuildFailureDiagnostic(error);
  }
  return activeStage;
}

export function schemaV2NativeFailureDiagnostic(stage) {
  return schemaV2NativeFailureStages.has(stage)
    ? `phase1.native-scenarios.${stage}`
    : 'phase1.stage.native-scenarios.failed';
}

export function retainSchemaV2NativeFailure(existingFailure, stage, error) {
  return (
    existingFailure ??
    new Error(schemaV2NativeFailureDiagnostic(stage), {
      cause: error,
    })
  );
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

export function parseArgs(argv, runtime = {}) {
  const runtimeEnvironment = runtime.environment ?? process.env;
  const runtimePlatform = runtime.platform ?? process.platform;
  const runtimeArchitecture = runtime.architecture ?? process.arch;
  const runtimeCurrentUid = Object.hasOwn(runtime, 'currentUid')
    ? runtime.currentUid
    : typeof process.getuid === 'function'
      ? process.getuid()
      : undefined;
  const runtimeCgroupMembership = Object.hasOwn(runtime, 'cgroupMembership')
    ? runtime.cgroupMembership
    : runtimePlatform === 'linux'
      ? readFileSync('/proc/self/cgroup', 'utf8')
      : '';
  const options = {
    lockPath: resolve(projectRoot, 'phase1-conformance.lock.json'),
    scenario: 'all',
    retainSanitizedReport: defaultRetainedReport,
    platform: undefined,
    outputPath: undefined,
    validatorRevision: undefined,
    chatSourceRoot: resolve(process.env.OPENCOVEN_CHAT_ROOT ?? projectRoot),
    sdkSourceRoot: configuredSourceRoot('OPENCOVEN_SDK_ROOT'),
    sdkValidatorSourceRoot: configuredSourceRoot('OPENCOVEN_SDK_VALIDATOR_ROOT'),
    caveSourceRoot: configuredSourceRoot('OPENCOVEN_CAVE_ROOT'),
    covenSourceRoot: configuredSourceRoot('OPENCOVEN_COVEN_ROOT'),
  };
  let retainedReportWasSet = false;
  let validatorRevisionWasSet = false;

  const pathFlags = new Map([
    ['--lock', 'lockPath'],
    ['--retain-sanitized-report', 'retainSanitizedReport'],
    ['--chat-root', 'chatSourceRoot'],
    ['--sdk-root', 'sdkSourceRoot'],
    ['--validator-root', 'sdkValidatorSourceRoot'],
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
    if (argument === '--platform') {
      const platform = requireString(argv[index + 1], '--platform');
      if (!Object.hasOwn(CANONICAL_PLATFORM_ENVIRONMENTS, platform)) {
        throw new Error(`unsupported schema-v2 platform ${platform}.`);
      }
      options.platform = platform;
      index += 1;
      continue;
    }
    if (argument === '--validator-revision') {
      if (validatorRevisionWasSet) {
        throw new Error('schema-v2 --validator-revision may be supplied only once.');
      }
      const revision = requireString(argv[index + 1], '--validator-revision');
      if (!/^[0-9a-f]{40}$/u.test(revision)) {
        throw new Error(
          '--validator-revision must be a lowercase immutable 40-character commit SHA.',
        );
      }
      options.validatorRevision = revision;
      validatorRevisionWasSet = true;
      index += 1;
      continue;
    }
    if (argument === '--output') {
      const output = requireString(argv[index + 1], '--output');
      options.outputPath =
        runtimePlatform === 'win32' ? windowsPath.resolve(output) : resolve(output);
      index += 1;
      continue;
    }
    const optionName = pathFlags.get(argument);
    if (optionName !== undefined) {
      options[optionName] = resolve(requireString(argv[index + 1], argument));
      if (argument === '--retain-sanitized-report') {
        retainedReportWasSet = true;
      }
      index += 1;
      continue;
    }
    throw new Error(`phase1-conformance: unknown option: ${argument}`);
  }

  if ((options.platform === undefined) !== (options.outputPath === undefined)) {
    throw new Error('schema-v2 --platform requires --output and vice versa.');
  }
  if (options.platform !== undefined) {
    if (options.validatorRevision === undefined) {
      throw new Error('schema-v2 --platform requires --validator-revision.');
    }
    if (retainedReportWasSet) {
      throw new Error(
        'schema-v2 --platform/--output cannot combine with --retain-sanitized-report.',
      );
    }
    if (options.platform !== `${runtimePlatform}-${runtimeArchitecture}`) {
      throw new Error('schema-v2 --platform must match the supervised native host.');
    }
    const supervisorEnvironment = schemaV2SupervisorEnvironment(
      runtimeEnvironment,
      runtimePlatform,
      runtimeArchitecture,
      runtimeCurrentUid,
      runtimeCgroupMembership,
    );
    const expectedOutput = supervisorArtifactOutputPath(supervisorEnvironment, runtimePlatform);
    if (options.outputPath !== expectedOutput) {
      throw new Error('schema-v2 --output must match the supervisor artifact path.');
    }
  } else if (options.validatorRevision !== undefined) {
    throw new Error('--validator-revision is only valid with schema-v2 --platform/--output.');
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

export function assertCompatibilityFailure(error, preset) {
  const code =
    error !== null && typeof error === 'object'
      ? Object.getOwnPropertyDescriptor(error, 'code')?.value
      : undefined;
  if (code !== 'incompatible_version') {
    throw new Error(`${preset} preset did not produce incompatible_version`);
  }
  return { code };
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalJson);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalJson(value[key])]),
    );
  }
  return value;
}

export function assertNativeMissingKeychainResponses(responses) {
  const expected = [
    {
      id: 'installation',
      ok: false,
      error: { code: 'secure_store_unavailable', retryable: true },
    },
    {
      id: 'shutdown',
      ok: true,
      result: { status: 'shutting_down' },
    },
  ];
  if (JSON.stringify(canonicalJson(responses)) !== JSON.stringify(canonicalJson(expected))) {
    throw new Error('native missing-keychain-trust preset returned an unsafe response');
  }
  return responses;
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

export function safeEnvironment(rootPath, extra = {}, resolvedCargoPath) {
  const home = resolve(rootPath, 'home');
  const temp = resolve(rootPath, 'tmp');
  const cache = resolve(rootPath, 'cache');
  const config = resolve(home, '.config');
  const data = resolve(rootPath, 'data');
  const pnpmStore = resolve(rootPath, 'pnpm-store');
  const cargoHome = resolve(rootPath, 'cargo-home');
  const cargoPath = realpathSync(
    resolvedCargoPath ??
      execFileSync('rustup', ['which', 'cargo'], {
        cwd: projectRoot,
        encoding: 'utf8',
      }).trim(),
  );
  const rustToolchainBin = dirname(cargoPath);
  for (const path of [home, temp, cache, config, data, pnpmStore, cargoHome]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
  }

  const inheritedPath = process.env.PATH ?? '';
  const environment = {
    PATH: inheritedPath ? `${rustToolchainBin}${delimiter}${inheritedPath}` : rustToolchainBin,
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
    CARGO_HOME: cargoHome,
    RUSTC: resolve(rustToolchainBin, 'rustc'),
    RUSTDOC: resolve(rustToolchainBin, 'rustdoc'),
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
      detached: ownedProcessGroupsSupported,
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

    const terminateAndFail = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      void artifactRoot.terminateChild(child).then(
        () => rejectRun(new CommandExecutionError(label, result)),
        () =>
          rejectRun(
            new CommandExecutionError(label, {
              code: null,
              signal: null,
              stdout: '',
              stderr: '',
              reason: 'tracking',
            }),
          ),
      );
    };

    child.once('spawn', () => {
      try {
        artifactRoot.trackChild(child, { processGroup: ownedProcessGroupsSupported });
      } catch {
        killUntrackedOwnedChild(child);
        fail({ code: null, signal: 'SIGKILL', stdout: '', stderr: '', reason: 'tracking' });
      }
    });
    child.once('error', () => {
      fail({ code: null, signal: null, stdout: '', stderr: '', reason: 'spawn' });
    });
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > commandOutputLimit) {
        terminateAndFail({
          code: null,
          signal: 'SIGKILL',
          stdout: '',
          stderr: '',
          reason: 'stdout-limit',
        });
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > commandOutputLimit) {
        terminateAndFail({
          code: null,
          signal: 'SIGKILL',
          stdout: '',
          stderr: '',
          reason: 'stderr-limit',
        });
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
        if (label === 'Cave conformance package') {
          result.reason = classifyCavePackageFailure(result);
        }
        rejectRun(new CommandExecutionError(label, result));
      }
    });
    timer = setTimeout(() => {
      terminateAndFail({
        code: null,
        signal: 'SIGKILL',
        stdout: '',
        stderr: '',
        reason: 'timeout',
      });
    }, timeoutMs);
  });
}

function parseVitestObservationReport(path, label) {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink() || !stats.isFile() || stats.size > 4 * 1024 * 1024) {
    throw new Error(`${label} report is not a bounded regular file.`);
  }
  const report = JSON.parse(readFileSync(path, 'utf8'));
  if (
    report?.success !== true ||
    !Array.isArray(report.testResults) ||
    report.testResults.length === 0
  ) {
    throw new Error(`${label} did not report a complete passing test run.`);
  }
  const passed = new Set();
  for (const file of report.testResults) {
    if (!Array.isArray(file.assertionResults)) {
      throw new Error(`${label} contained malformed test results.`);
    }
    for (const assertion of file.assertionResults) {
      if (
        assertion.status !== 'passed' ||
        !Array.isArray(assertion.ancestorTitles) ||
        typeof assertion.title !== 'string'
      ) {
        continue;
      }
      passed.add([...assertion.ancestorTitles, assertion.title].join(' > '));
    }
  }
  return passed;
}

async function runVitestObservationSuite({
  artifactRoot,
  rootPath,
  environment,
  label,
  files,
  outputName,
}) {
  const outputPath = resolve(artifactRoot.rootPath, outputName);
  await runCommand(
    artifactRoot,
    label,
    'pnpm',
    [
      '--ignore-workspace',
      'exec',
      'vitest',
      'run',
      ...files,
      '--reporter=json',
      `--outputFile=${outputPath}`,
    ],
    {
      cwd: rootPath,
      env: environment,
    },
  );
  return parseVitestObservationReport(outputPath, label);
}

function parseCargoPassedTests(output) {
  const passed = new Set();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^test ([A-Za-z0-9_:]+) \.\.\. ok$/u.exec(line.trim());
    if (match !== null) {
      passed.add(match[1]);
    }
  }
  return passed;
}

async function runExactCargoObservationTests({
  artifactRoot,
  rootPath,
  environment,
  label,
  tests,
}) {
  const passed = new Set();
  for (const test of tests) {
    const result = await runCommand(
      artifactRoot,
      `${label} ${test.name}`,
      'cargo',
      [...test.args, test.name, '--', '--exact'],
      {
        cwd: rootPath,
        env: environment,
        timeoutMs: cargoBuildTimeoutMs,
      },
    );
    const observed = parseCargoPassedTests(result.stdout);
    if (!observed.has(test.name)) {
      throw new Error(`${label} did not execute ${test.name}.`);
    }
    passed.add(test.name);
  }
  return passed;
}

export function normalizeSchemaV2ObservationTests(value) {
  const keys = ['chat', 'chatRust', 'covenRust', 'sdk'];
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !== keys.join('\0') ||
    keys.some((key) => !(value[key] instanceof Set))
  ) {
    throw new Error('Schema-v2 observation test results are incomplete or malformed.');
  }
  return Object.freeze({
    sdk: value.sdk,
    chat: value.chat,
    chatRust: value.chatRust,
    covenRust: value.covenRust,
  });
}

export async function runSchemaV2ObservationSuites(artifactRoot, roots, environment, platform) {
  const shortRoot =
    process.platform === 'win32'
      ? undefined
      : createProcessOwnedArtifactRoot({ prefix: 'p1ot', shortPath: true });
  const observationEnvironment = {
    ...environment,
    CARGO_TARGET_DIR: resolve(artifactRoot.rootPath, 'build', 'observation-target'),
  };
  const testEnvironment =
    shortRoot === undefined
      ? observationEnvironment
      : {
          ...observationEnvironment,
          TMPDIR: shortRoot.rootPath,
          TMP: shortRoot.rootPath,
          TEMP: shortRoot.rootPath,
        };
  try {
    await installPnpm(artifactRoot, roots.sdkRoot, environment, 'SDK observation');
    await installPnpm(artifactRoot, roots.producerRoot, environment, 'Chat observation');
    const sdkTests = await runVitestObservationSuite({
      artifactRoot,
      rootPath: roots.sdkRoot,
      environment: testEnvironment,
      label: 'SDK schema-v2 observation tests',
      files: [
        'tests/cave-discovery-pairing.spec.ts',
        'tests/cave-canonical-reads.spec.ts',
        'tests/cave-hpke-bound-v1.spec.ts',
        'tests/cave-managed-native.spec.ts',
        'tests/cave-managed-native-staged.spec.ts',
        'tests/coven-discovery.spec.ts',
        'tests/health-validation.spec.ts',
        'tests/client-contract.spec.ts',
        'tests/native-secret-store.spec.ts',
      ],
      outputName: 'sdk-observation-tests.json',
    });
    const chatTests = await runVitestObservationSuite({
      artifactRoot,
      rootPath: roots.producerRoot,
      environment: testEnvironment,
      label: 'Chat schema-v2 observation tests',
      files: [
        'src/lib/sdk/native-boundary.test.ts',
        'src/lib/sdk/connection-controller.test.ts',
        'src/lib/sdk/query-adapter.test.ts',
        'src/lib/sdk/managed-credential-status.e2e.test.ts',
      ],
      outputName: 'chat-observation-tests.json',
    });
    const chatCargoArgs = [
      'test',
      '--locked',
      '--manifest-path',
      resolve(roots.producerRoot, 'src-tauri', 'Cargo.toml'),
      '--features',
      'phase1-conformance',
      '--lib',
    ];
    const chatRustTests = await runExactCargoObservationTests({
      artifactRoot,
      rootPath: roots.producerRoot,
      environment: testEnvironment,
      label: 'Chat native schema-v2 observation tests',
      tests: [
        {
          args: chatCargoArgs,
          name: 'transport::tests::pairing_exchange_empty_post_declares_zero_content_length',
        },
        {
          args: chatCargoArgs,
          name: 'coven::tests::maps_client_failures_to_bounded_diagnostics_without_leaking_details',
        },
      ],
    });
    const covenLibraryTests =
      platform === 'win32-x64'
        ? [
            'discovery::tests::legacy_v1_case_check_rejects_sensitive_or_unverifiable_ancestors',
            'discovery::tests::recorded_windows_pipe_candidates_accept_only_coven_stable_or_legacy_shapes',
            'discovery::tests::recorded_daemon_status_rejects_a_stable_pipe_for_another_profile',
            'discovery::tests::windows_security_inspection_waits_are_finite_and_preserve_submillisecond_budget',
            'discovery::tests::status_file_reader_allows_an_atomic_status_replacement',
          ]
        : [
            'transport::unix::tests::platform_peer_credentials_report_the_connected_process_uid',
            'transport::unix::tests::connected_peer_uid_must_match_discovered_and_current_owner',
          ];
    const covenRustTests = await runExactCargoObservationTests({
      artifactRoot,
      rootPath: roots.covenRoot,
      environment: testEnvironment,
      label: 'Coven native trust observation tests',
      tests: [
        ...covenLibraryTests.map((name) => ({
          args: ['test', '--locked', '-p', 'coven-client', '--lib'],
          name,
        })),
        ...(platform === 'win32-x64'
          ? []
          : [
              {
                args: ['test', '--locked', '-p', 'coven-client', '--test', 'health'],
                name: 'discovers_only_an_owner_local_unix_socket',
              },
              {
                args: ['test', '--locked', '-p', 'coven-client', '--test', 'health'],
                name: 'a_mutation_is_not_sent_to_a_replacement_before_that_peer_is_negotiated',
              },
            ]),
      ],
    });
    return normalizeSchemaV2ObservationTests({
      sdk: sdkTests,
      chat: chatTests,
      chatRust: chatRustTests,
      covenRust: covenRustTests,
    });
  } finally {
    if (shortRoot !== undefined) {
      await shortRoot.cleanup();
    }
  }
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function verifiedCheckoutIdentity(lock, key, rootPath) {
  const identity = readPhase1CheckoutIdentity(rootPath, `${key} checkout`);
  return {
    repository: lock[key].repository,
    commit: identity.revision,
    tree: identity.tree,
  };
}

function resolveOperatorHomes() {
  const operatorHome = process.env.HOME ?? process.env.USERPROFILE ?? homedir();
  if (typeof operatorHome !== 'string' || operatorHome.length === 0 || !isAbsolute(operatorHome)) {
    throw new Error('Schema-v2 evidence requires an absolute operator home.');
  }
  const covenHome = process.env.COVEN_HOME ?? resolve(operatorHome, '.coven');
  const caveHome = process.env.COVEN_CAVE_HOME ?? resolve(covenHome, 'cave');
  if (!isAbsolute(covenHome) || !isAbsolute(caveHome)) {
    throw new Error('Schema-v2 evidence requires absolute operator Cave and Coven homes.');
  }
  return { caveHome, covenHome };
}

async function collectToolchainMetadata(artifactRoot, environment, expected, toolchainRoot) {
  const pnpm = await runCommand(artifactRoot, 'pnpm version verification', 'pnpm', ['--version'], {
    cwd: projectRoot,
    env: environment,
    timeoutMs: 30_000,
  });
  const rust = await runCommand(artifactRoot, 'Rust version verification', 'rustc', ['--version'], {
    cwd: projectRoot,
    env: environment,
    timeoutMs: 30_000,
  });
  const tauri = await runCommand(
    artifactRoot,
    'Tauri version verification',
    'pnpm',
    ['--ignore-workspace', 'exec', 'tauri', '--version'],
    {
      cwd: toolchainRoot,
      env: environment,
      timeoutMs: 30_000,
    },
  );
  const metadata = {
    nodeVersion: process.version,
    pnpmVersion: `pnpm@${pnpm.stdout.trim()}`,
    rustVersion: /^rustc (\d+\.\d+\.\d+) /u.exec(rust.stdout.trim())?.[1],
    tauriVersion: /^tauri-cli (\d+\.\d+\.\d+)$/u.exec(tauri.stdout.trim())?.[1],
  };
  if (JSON.stringify(metadata) !== JSON.stringify(expected)) {
    throw new Error('Observed toolchain does not match the SDK frozen contract.');
  }
  return metadata;
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

export async function cloneExactCheckout({
  artifactRoot,
  sourceRoot,
  destinationRoot,
  repository,
  revision,
  environment,
  label,
}) {
  const localSource =
    typeof sourceRoot === 'string' && existsSync(sourceRoot) && statSync(sourceRoot).isDirectory()
      ? sourceRoot
      : undefined;
  const localGitDirectory =
    localSource === undefined ? undefined : resolveLocalGitDirectory(localSource);
  const source = localSource ?? `https://github.com/${repository}.git`;
  const checkoutEnvironment = createGitCheckoutEnvironment(environment);
  if (localSource !== undefined) {
    await runCommand(
      artifactRoot,
      `${label} local clone`,
      'git',
      [
        '-c',
        `core.hooksPath=${devNull}`,
        '-c',
        `safe.directory=${localGitDirectory}`,
        'clone',
        '--local',
        '--no-hardlinks',
        '--no-checkout',
        '--quiet',
        localSource,
        destinationRoot,
      ],
      {
        cwd: projectRoot,
        env: {
          ...checkoutEnvironment,
          GIT_ALLOW_PROTOCOL: 'file',
        },
      },
    );
  } else {
    mkdirSync(destinationRoot, { mode: 0o700 });
    await runCommand(
      artifactRoot,
      `${label} repository initialization`,
      'git',
      ['-c', `core.hooksPath=${devNull}`, 'init', '--quiet'],
      {
        cwd: destinationRoot,
        env: checkoutEnvironment,
      },
    );
    await runCommand(
      artifactRoot,
      `${label} origin configuration`,
      'git',
      ['-c', `core.hooksPath=${devNull}`, 'remote', 'add', 'origin', source],
      {
        cwd: destinationRoot,
        env: checkoutEnvironment,
      },
    );
    await runCommand(
      artifactRoot,
      `${label} fetch`,
      'git',
      [
        '-c',
        'credential.helper=',
        '-c',
        `core.hooksPath=${devNull}`,
        '-c',
        'protocol.https.allow=always',
        'fetch',
        '--quiet',
        '--no-tags',
        '--depth=1',
        'origin',
        revision,
      ],
      {
        cwd: destinationRoot,
        env: {
          ...checkoutEnvironment,
          GIT_ALLOW_PROTOCOL: 'https',
        },
      },
    );
  }
  await runCommand(
    artifactRoot,
    `${label} checkout`,
    'git',
    [
      '-c',
      `core.hooksPath=${devNull}`,
      'checkout',
      '--detach',
      '--force',
      localSource === undefined ? 'FETCH_HEAD' : revision,
    ],
    { cwd: destinationRoot, env: checkoutEnvironment },
  );
}

export function readSchemaV2ProducerIdentity(sourceRoot) {
  const environment = createGitEnvironment(process.env);
  const run = (value) =>
    execFileSync(
      'git',
      ['-c', `safe.directory=${sourceRoot}`, '-C', sourceRoot, 'rev-parse', value],
      {
        encoding: 'utf8',
        env: environment,
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 15_000,
        killSignal: 'SIGKILL',
      },
    ).trim();
  return {
    revision: run('HEAD'),
    tree: run('HEAD^{tree}'),
  };
}

async function cloneProducerCheckout(artifactRoot, sourceRoot, environment) {
  const identity = readSchemaV2ProducerIdentity(sourceRoot);
  const producerRoot = resolve(artifactRoot.rootPath, 'checkouts', 'producer');
  await cloneExactCheckout({
    artifactRoot,
    sourceRoot,
    destinationRoot: producerRoot,
    repository: 'OpenCoven/chat',
    revision: identity.revision,
    environment,
    label: 'Chat evidence producer',
  });
  assertCleanPhase1Checkout(producerRoot, 'Chat evidence producer checkout');
  const cloned = readPhase1CheckoutIdentity(producerRoot, 'Chat evidence producer checkout');
  if (cloned.revision !== identity.revision || cloned.tree !== identity.tree) {
    throw new Error('Chat evidence producer checkout identity changed during cloning.');
  }
  return { producerRoot, producerIdentity: cloned };
}

export function validateSchemaV2AuthorityCheckouts({
  lock,
  harnessRoot,
  producerRoot,
  producerIdentity,
}) {
  assertPhase1ProducerAuthority(lock, harnessRoot);
  assertCleanPhase1Checkout(producerRoot, 'Chat evidence producer checkout');
  const harness = readPhase1CheckoutIdentity(harnessRoot, 'Historical Chat harness checkout');
  const producer = readPhase1CheckoutIdentity(producerRoot, 'Chat evidence producer checkout');
  if (
    producerIdentity === null ||
    typeof producerIdentity !== 'object' ||
    !/^[0-9a-f]{40}$/u.test(producerIdentity.revision ?? '') ||
    !/^[0-9a-f]{40}$/u.test(producerIdentity.tree ?? '') ||
    producer.revision !== producerIdentity.revision ||
    producer.tree !== producerIdentity.tree
  ) {
    throw new Error('Chat evidence producer checkout identity changed after cloning.');
  }
  if (
    realpathSync(harnessRoot) === realpathSync(producerRoot) ||
    harness.revision !== lock.harnessAuthority.revision ||
    harness.tree !== lock.harnessAuthority.tree ||
    producer.revision === harness.revision ||
    producer.tree === harness.tree
  ) {
    throw new Error('Schema-v2 producer and historical harness authorities are not distinct.');
  }
  return Object.freeze({
    harness: Object.freeze(harness),
    producer: Object.freeze(producer),
  });
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
    repository: lock.chat.repository,
    revision: lock.chat.revision,
    environment,
    label: 'Chat',
  });
  await cloneExactCheckout({
    artifactRoot,
    sourceRoot: options.sdkSourceRoot,
    destinationRoot: roots.sdkRoot,
    repository: lock.sdk.repository,
    revision: lock.sdk.revision,
    environment,
    label: 'SDK',
  });
  await cloneExactCheckout({
    artifactRoot,
    sourceRoot: options.caveSourceRoot,
    destinationRoot: roots.caveRoot,
    repository: lock.cave.repository,
    revision: lock.cave.revision,
    environment,
    label: 'Cave',
  });
  await cloneExactCheckout({
    artifactRoot,
    sourceRoot: options.covenSourceRoot,
    destinationRoot: roots.covenRoot,
    repository: lock.coven.repository,
    revision: lock.coven.revision,
    environment,
    label: 'Coven',
  });
  assertCleanPhase1Checkouts(roots);
  assertPhase1CheckoutHeads(lock, roots);
  if (options.platform !== undefined) {
    roots.validatorRoot = resolve(checkoutsRoot, 'validator');
    await cloneExactCheckout({
      artifactRoot,
      sourceRoot: options.sdkValidatorSourceRoot,
      destinationRoot: roots.validatorRoot,
      repository: 'OpenCoven/sdk',
      revision: options.validatorRevision,
      environment,
      label: 'SDK validator',
    });
    assertCleanPhase1Checkout(roots.validatorRoot, 'SDK validator checkout');
    const validatorIdentity = readPhase1CheckoutIdentity(
      roots.validatorRoot,
      'SDK validator checkout',
    );
    if (validatorIdentity.revision !== options.validatorRevision) {
      throw new Error('SDK validator checkout does not match the selected revision.');
    }
    roots.validatorIdentity = validatorIdentity;
    Object.assign(
      roots,
      await cloneProducerCheckout(artifactRoot, options.chatSourceRoot, environment),
    );
  }
  return roots;
}

async function installPnpm(artifactRoot, rootPath, environment, label) {
  await runCommand(
    artifactRoot,
    `${label} dependency install`,
    'pnpm',
    ['install', '--frozen-lockfile', `--config.store-dir=${environment.PNPM_STORE_DIR}`],
    { cwd: rootPath, env: environment },
  );
}

async function packageLockedArtifacts(
  artifactRoot,
  roots,
  environment,
  { schemaV2 = false, onStage = () => {} } = {},
) {
  let packedConsumerObservations;
  if (schemaV2) {
    onStage('phase1.packaging.frozen-consumer.failed');
    const verifierPath = resolve(artifactRoot.rootPath, 'verify-frozen-consumer.mjs');
    const verifierResultPath = resolve(artifactRoot.rootPath, 'verify-frozen-consumer-result.json');
    const verifierFailurePath = resolve(
      artifactRoot.rootPath,
      'verify-frozen-consumer-failure.json',
    );
    writeFileSync(
      verifierPath,
      [
        `import { writeFileSync } from 'node:fs';`,
        `import { FROZEN_PACKED_CONSUMER_STAGES, verifyFrozenPackedConsumer } from ${JSON.stringify(
          pathToFileURL(resolve(projectRoot, 'scripts', 'contract-canary.mjs')).href,
        )};`,
        `let activeStage = FROZEN_PACKED_CONSUMER_STAGES[0];`,
        `try {`,
        `  const result = verifyFrozenPackedConsumer({`,
        `    ...${JSON.stringify({
          chatRoot: roots.producerRoot,
          sdkRoot: roots.sdkRoot,
          caveRoot: roots.caveRoot,
        })},`,
        `    onStage(stage) {`,
        `      if (!FROZEN_PACKED_CONSUMER_STAGES.includes(stage)) {`,
        `        throw new Error('Frozen packed consumer reported an unknown stage.');`,
        `      }`,
        `      activeStage = stage;`,
        `    },`,
        `  });`,
        `  writeFileSync(${JSON.stringify(verifierResultPath)}, JSON.stringify(result));`,
        `} catch (error) {`,
        `  writeFileSync(${JSON.stringify(
          verifierFailurePath,
        )}, JSON.stringify({ stage: activeStage }));`,
        `  throw error;`,
        `}`,
        '',
      ].join('\n'),
      { mode: 0o600 },
    );
    try {
      await runCommand(
        artifactRoot,
        'Frozen packed SDK consumer verification',
        process.execPath,
        [verifierPath],
        {
          cwd: projectRoot,
          env: environment,
          timeoutMs: commandTimeoutMs,
        },
      );
    } catch (cause) {
      let failure;
      try {
        failure = JSON.parse(readFileSync(verifierFailurePath, 'utf8'));
      } catch {
        throw cause;
      }
      if (
        failure === null ||
        typeof failure !== 'object' ||
        Array.isArray(failure) ||
        Object.keys(failure).length !== 1 ||
        !FROZEN_PACKED_CONSUMER_STAGES.includes(failure.stage)
      ) {
        throw cause;
      }
      throw new Error(`phase1.packaging.frozen-consumer.${failure.stage}.failed`, { cause });
    }
    packedConsumerObservations = JSON.parse(
      readFileSync(verifierResultPath, 'utf8'),
    ).observedAssertions;
  }
  onStage('phase1.packaging.cave-install.failed');
  await installPnpm(artifactRoot, roots.caveRoot, environment, 'Cave');
  onStage('phase1.packaging.cave-build.failed');
  await runCommand(artifactRoot, 'Cave conformance package', 'pnpm', ['build'], {
    cwd: roots.caveRoot,
    env: schemaV2CaveBuildEnvironment(environment),
  });

  onStage('phase1.packaging.chat-install.failed');
  await installPnpm(artifactRoot, roots.chatRoot, environment, 'Chat');
  onStage('phase1.packaging.chat-web-build.failed');
  await runCommand(artifactRoot, 'Chat web package', 'pnpm', ['build'], {
    cwd: roots.chatRoot,
    env: environment,
  });

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
  if (!schemaV2) {
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
  }

  onStage('phase1.packaging.chat-native-build.failed');
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
      resolve(schemaV2 ? roots.producerRoot : roots.chatRoot, 'src-tauri', 'Cargo.toml'),
      '--features',
      'phase1-conformance',
      '--bin',
      'phase1-native-rpc',
    ],
    {
      cwd: schemaV2 ? roots.producerRoot : roots.chatRoot,
      env: { ...environment, CARGO_TARGET_DIR: chatTarget },
      timeoutMs: cargoBuildTimeoutMs,
    },
  );

  onStage('phase1.packaging.coven-build.failed');
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
      timeoutMs: cargoBuildTimeoutMs,
    },
  );

  const executableSuffix = process.platform === 'win32' ? '.exe' : '';
  const nativeRpcPath = resolve(chatTarget, 'debug', `phase1-native-rpc${executableSuffix}`);
  const covenBinaryPath = resolve(covenTarget, 'debug', `coven${executableSuffix}`);
  onStage('phase1.packaging.outputs.failed');
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
    packedConsumerObservations,
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
  const caveRecordPath = resolve(artifactRoot.rootPath, 'cave-authority-record.json');
  const result = await runCommand(
    artifactRoot,
    'Cave real-authority conformance',
    process.execPath,
    [
      resolve(caveRoot, 'scripts', 'client-v1-conformance.mjs'),
      '--out',
      caveRecordPath,
      '--include-ttl',
      '--include-authority-takeover',
    ],
    {
      cwd: caveRoot,
      env: environment,
      timeoutMs: caveConformanceTimeoutMs,
    },
  );
  const caveRecord = JSON.parse(readFileSync(caveRecordPath, 'utf8'));
  return {
    assertions: parseCaveConformanceOutput(result.stdout),
    caveRecord,
  };
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

async function reserveLoopbackPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const port = address.port;
  await new Promise((resolveClose, rejectClose) =>
    server.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  return port;
}

function drainBoundedChildOutput(artifactRoot, child) {
  const state = {
    terminationReason: undefined,
    terminationError: undefined,
    terminationPromise: undefined,
  };
  const terminate = (reason) => {
    state.terminationReason ??= reason;
    state.terminationPromise ??= artifactRoot.terminateChild(child).catch((error) => {
      state.terminationError = error;
    });
  };
  for (const stream of [child.stdout, child.stderr]) {
    let bytes = 0;
    stream.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > commandOutputLimit) {
        terminate('output-limit');
      }
    });
  }
  return state;
}

async function startCompatibilityCave({ artifactRoot, roots, environment, preset }) {
  const compatibilityRoot = resolve(artifactRoot.rootPath, `compatibility-${preset}`);
  const covenHome = resolve(compatibilityRoot, 'coven');
  const caveHome = resolve(covenHome, 'cave');
  mkdirSync(caveHome, { recursive: true, mode: 0o700 });
  const port = await reserveLoopbackPort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [resolve(roots.caveRoot, 'server.mjs')], {
    cwd: roots.caveRoot,
    env: {
      ...environment,
      COVEN_HOME: covenHome,
      COVEN_CAVE_HOME: caveHome,
      COVEN_CAVE_PORT: String(port),
      COVEN_CAVE_CLIENT_V1_AUTHORITY_MODE: 'off',
      COVEN_CAVE_CLIENT_V1_COMPATIBILITY_PRESET: preset,
      COVEN_CAVE_HEAP_MONITOR: '0',
      NODE_ENV: 'production',
    },
    detached: ownedProcessGroupsSupported,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    artifactRoot.trackChild(child, { processGroup: ownedProcessGroupsSupported });
  } catch (error) {
    killUntrackedOwnedChild(child);
    throw error;
  }
  const outputState = drainBoundedChildOutput(artifactRoot, child);
  await once(child, 'spawn');

  const deadline = Date.now() + rpcTimeoutMs;
  while (Date.now() < deadline) {
    if (outputState.terminationError !== undefined) {
      throw outputState.terminationError;
    }
    if (outputState.terminationReason !== undefined) {
      await outputState.terminationPromise;
      throw new Error(`${preset} compatibility Cave exceeded its output limit`);
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${preset} compatibility Cave exited before readiness`);
    }
    try {
      const response = await requestJson(origin, {
        path: '/api/client/v1/health',
      });
      if (response.status >= 200 && response.status < 300) {
        return origin;
      }
    } catch {
      // The packaged Cave may not have bound its loopback port yet.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`${preset} compatibility Cave did not become ready`);
}

async function runPackedSdkCompatibilityCheck({
  artifactRoot,
  roots,
  environment,
  origin,
  preset,
}) {
  const caveClientEntry = resolve(
    roots.chatRoot,
    'node_modules',
    '@opencoven',
    'cave-client',
    'dist',
    'index.js',
  );
  const wrapperPath = resolve(artifactRoot.rootPath, `compatibility-sdk-${preset}.mjs`);
  writeFileSync(
    wrapperPath,
    [
      `import { CaveClient } from ${JSON.stringify(pathToFileURL(caveClientEntry).href)};`,
      `const origin = ${JSON.stringify(origin)};`,
      `const client = new CaveClient({`,
      `  transport: {`,
      `    async health() {`,
      `      const response = await fetch(new URL('/api/client/v1/health', origin), {`,
      `        cache: 'no-store',`,
      `        credentials: 'omit',`,
      `        redirect: 'error',`,
      `      });`,
      `      if (!response.ok) throw new Error('compatibility health request failed');`,
      `      return response.json();`,
      `    },`,
      `  },`,
      `});`,
      `const failure = await client.health().then(() => undefined, (error) => error);`,
      `const code = failure && typeof failure === 'object'`,
      `  ? Object.getOwnPropertyDescriptor(failure, 'code')?.value`,
      `  : undefined;`,
      `if (code !== 'incompatible_version') {`,
      `  throw new Error(${JSON.stringify(
        `${preset} preset did not produce incompatible_version`,
      )});`,
      `}`,
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  await runCommand(
    artifactRoot,
    `Cave ${preset} packed SDK compatibility`,
    process.execPath,
    [wrapperPath],
    {
      cwd: roots.chatRoot,
      env: environment,
    },
  );
}

async function runCompatibilityScenarios({ artifactRoot, roots, environment, results }) {
  try {
    for (const preset of ['api-major', 'minimum-client']) {
      const origin = await startCompatibilityCave({
        artifactRoot,
        roots,
        environment,
        preset,
      });
      await runPackedSdkCompatibilityCheck({
        artifactRoot,
        roots,
        environment,
        origin,
        preset,
      });
    }
    addAssertion(
      results,
      'phase1.compat.api-major-min-client',
      'passed',
      'phase1.assertion.passed',
    );
  } catch {
    addAssertion(
      results,
      'phase1.compat.api-major-min-client',
      'failed',
      'phase1.assertion.failed',
    );
  }
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

export async function triggerAndWaitForChildClose(child, trigger, timeoutMs = rpcTimeoutMs) {
  const closed = once(child, 'close');
  await trigger();
  let timer;
  try {
    const [code, signal] = await Promise.race([
      closed,
      new Promise((_, rejectTimeout) => {
        timer = setTimeout(() => rejectTimeout(new Error('child shutdown timed out')), timeoutMs);
      }),
    ]);
    assertSuccessfulChildExit(code, signal);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function assertSuccessfulChildExit(code, signal) {
  if (code !== 0 || signal !== null) {
    throw new Error(
      signal === null
        ? `child shutdown failed with exit code ${code}`
        : `child shutdown failed with signal ${signal}`,
    );
  }
}

export class NativeRpcClient {
  constructor(child, { shutdownTimeoutMs = rpcTimeoutMs } = {}) {
    this.child = child;
    this.shutdownTimeoutMs = shutdownTimeoutMs;
    this.pending = new Map();
    this.commandCounts = new Map();
    this.secretFreeResponses = true;
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
        if (/"(?:bearer|pairingSecret|pairing_secret|pairing-secret)"\s*:/iu.test(line)) {
          this.secretFreeResponses = false;
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
    this.commandCounts.set(command, (this.commandCounts.get(command) ?? 0) + 1);
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

  commandCount(command) {
    return this.commandCounts.get(command) ?? 0;
  }

  responsesContainNoSecrets() {
    return this.secretFreeResponses;
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
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      assertSuccessfulChildExit(this.child.exitCode, this.child.signalCode);
      return;
    }
    await triggerAndWaitForChildClose(
      this.child,
      () => this.ok('conformance_shutdown'),
      this.shutdownTimeoutMs,
    );
  }
}

export async function withFixtureDaemon(fixtureDaemon, action) {
  try {
    return await action();
  } finally {
    await fixtureDaemon.close();
  }
}

export async function withOwnedArtifactRoot(ownedRoot, action) {
  let result;
  let actionFailure;
  let actionFailed = false;
  try {
    result = await action();
  } catch (error) {
    actionFailure = error;
    actionFailed = true;
  }
  let cleanupFailure;
  let cleanupFailed = false;
  try {
    await ownedRoot.cleanup();
  } catch (error) {
    cleanupFailure = error;
    cleanupFailed = true;
  }
  if (actionFailed && cleanupFailed) {
    throw new AggregateError(
      [actionFailure, cleanupFailure],
      'Owned artifact action and cleanup both failed.',
    );
  }
  if (actionFailed) {
    throw actionFailure;
  }
  if (cleanupFailed) {
    throw cleanupFailure;
  }
  return result;
}

async function startNativeRpc(artifactRoot, binaryPath, environment, cwd) {
  const child = spawn(binaryPath, [], {
    cwd,
    env: environment,
    detached: ownedProcessGroupsSupported,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  await once(child, 'spawn');
  artifactRoot.trackChild(child, { processGroup: ownedProcessGroupsSupported });
  child.stderr.resume();
  return new NativeRpcClient(child);
}

async function runNativeMissingKeychainTrustScenario(
  artifactRoot,
  nativeRpcPath,
  environment,
  results,
) {
  const trustHome = resolve(artifactRoot.rootPath, 'native-missing-keychain-trust-home');
  mkdirSync(trustHome, { recursive: true, mode: 0o700 });
  const beforeEntries = readdirSync(trustHome);
  const canary = 'native-keychain-canary-must-not-escape';
  const child = spawn(nativeRpcPath, [], {
    cwd: artifactRoot.rootPath,
    env: {
      ...environment,
      HOME: trustHome,
      COVEN_HOME: resolve(trustHome, 'coven'),
      COVEN_CAVE_HOME: resolve(trustHome, 'coven', 'cave'),
      COVEN_CAVE_AUTH_TOKEN: canary,
      OPENCOVEN_PHASE1_CONFORMANCE_NATIVE_PROVIDER_PRESET: 'missing-keychain-trust',
      OPENCOVEN_PHASE1_CONFORMANCE_KEYRING_SERVICE: `ai.opencoven.chat.phase1.${randomBytes(16).toString('hex')}`,
    },
    detached: ownedProcessGroupsSupported,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  await once(child, 'spawn');
  artifactRoot.trackChild(child, { processGroup: ownedProcessGroupsSupported });
  const stdout = [];
  const stderr = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let terminationReason;
  let terminationPromise;
  let killError;
  let processError;
  let closed = false;
  const closePromise = new Promise((resolveClose) => {
    child.once('close', (code, signal) => {
      closed = true;
      resolveClose([code, signal]);
    });
  });
  const requestKill = (reason) => {
    terminationReason ??= reason;
    if (closed || child.exitCode !== null || child.signalCode !== null) {
      return;
    }
    terminationPromise ??= artifactRoot.terminateChild(child).catch((error) => {
      killError =
        error instanceof Error
          ? error
          : new Error(`native missing-keychain-trust child could not be killed (${reason})`);
    });
  };
  child.once('error', (error) => {
    processError = error;
    requestKill('process-error');
  });
  const capture = (target, bytes, chunk, stream) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const nextBytes = bytes + buffer.length;
    if (nextBytes > commandOutputLimit) {
      requestKill(`${stream}-limit`);
      return bytes;
    }
    target.push(buffer);
    return nextBytes;
  };
  child.stdout.on('data', (chunk) => {
    stdoutBytes = capture(stdout, stdoutBytes, chunk, 'stdout');
  });
  child.stderr.on('data', (chunk) => {
    stderrBytes = capture(stderr, stderrBytes, chunk, 'stderr');
  });
  child.stdin.end(
    `${JSON.stringify({ id: 'installation', command: 'app_installation_id' })}\n` +
      `${JSON.stringify({ id: 'shutdown', command: 'conformance_shutdown' })}\n`,
  );
  let timeoutHandle;
  const timeout = new Promise((resolveTimeout) => {
    timeoutHandle = setTimeout(() => {
      requestKill('timeout');
      resolveTimeout();
    }, rpcTimeoutMs);
  });
  const firstResult = await Promise.race([
    closePromise.then((result) => ({ closed: true, result })),
    timeout.then(() => ({ closed: false })),
  ]);
  let closeResult;
  if (firstResult.closed) {
    closeResult = firstResult.result;
  } else {
    let reapTimeoutHandle;
    const reapTimeout = new Promise((resolveReapTimeout) => {
      reapTimeoutHandle = setTimeout(resolveReapTimeout, rpcTimeoutMs, null);
    });
    closeResult = await Promise.race([closePromise, reapTimeout]);
    clearTimeout(reapTimeoutHandle);
  }
  clearTimeout(timeoutHandle);
  if (terminationPromise !== undefined) {
    await terminationPromise;
  }
  if (closeResult === null) {
    throw new Error('native missing-keychain-trust child could not be reaped');
  }
  const [code, signal] = closeResult;
  const stdoutText = Buffer.concat(stdout).toString('utf8');
  const stderrText = Buffer.concat(stderr).toString('utf8');
  const responses = stdoutText
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const unchanged = JSON.stringify(readdirSync(trustHome)) === JSON.stringify(beforeEntries);
  let responsesValid = true;
  try {
    assertNativeMissingKeychainResponses(responses);
  } catch {
    responsesValid = false;
  }
  if (
    terminationReason !== undefined ||
    killError !== undefined ||
    processError !== undefined ||
    code !== 0 ||
    signal !== null ||
    stderrText.includes(canary) ||
    stdoutText.includes(canary) ||
    !unchanged ||
    !responsesValid
  ) {
    throw new Error(
      `native missing-keychain-trust preset returned an unsafe result${
        terminationReason === undefined ? '' : ` (${terminationReason})`
      }`,
    );
  }

  addAssertion(
    results,
    'phase1.native.missing-keychain-trust',
    'passed',
    'phase1.assertion.passed',
  );
}

async function runNativeMissingCovenTrustScenario(artifactRoot, nativeRpcPath, environment) {
  const trustRoot = resolve(artifactRoot.rootPath, 'native-missing-coven-trust-home');
  mkdirSync(trustRoot, { recursive: true, mode: 0o700 });
  const rpc = await startNativeRpc(
    artifactRoot,
    nativeRpcPath,
    {
      ...environment,
      HOME: trustRoot,
      COVEN_HOME: '',
    },
    trustRoot,
  );
  try {
    await rpc.error('coven_health', { operation: rpc.operation() }, 'service_unavailable');
    return true;
  } finally {
    await rpc.close();
  }
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
  if (typeof requestId !== 'string' || /"(?:secret|bearer)"\s*:/iu.test(JSON.stringify(created))) {
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
  return {
    requestId,
    credentialId,
    pairingSecretNative: true,
    bearerNative: true,
  };
}

function collection(result, name) {
  const items = result?.data?.[name];
  if (!Array.isArray(items)) {
    throw new Error(`native canonical read omitted ${name}`);
  }
  return items;
}

function validateNativeCustodyProof(value, expectedBackend, label) {
  if (
    value?.backend !== expectedBackend ||
    value?.available !== true ||
    value?.empty !== true ||
    typeof value?.stateSha256 !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.stateSha256)
  ) {
    throw new Error(`${label} did not prove an empty available ${expectedBackend} backend`);
  }
  return value;
}

async function runNativeScenarios({
  artifactRoot,
  roots,
  nativeRpcPath,
  environment,
  results,
  platform,
  compatibilityPassed,
}) {
  const isolatedHome = resolve(artifactRoot.rootPath, 'native-authority-home');
  const covenHome = resolve(isolatedHome, 'coven');
  const caveHome = resolve(covenHome, 'cave');
  let activeNativeStage = 'fixture-daemon';
  let fixtureDaemon;
  try {
    fixtureDaemon = await startFixtureDaemon([
      {
        id: 'archivist',
        display_name: 'Archivist',
        role: 'Keeper',
        description: 'Synthetic roster entry.',
      },
    ]);
  } catch (error) {
    throw new Error(schemaV2NativeFailureDiagnostic(activeNativeStage), { cause: error });
  }
  let rpc;
  let handle;
  let credentialId;
  const nativeInstanceIds = new Set();
  const platformEnvironment =
    platform === undefined ? undefined : CANONICAL_PLATFORM_ENVIRONMENTS[platform];
  const nativeServiceOpaqueId =
    platformEnvironment === undefined ? undefined : randomBytes(16).toString('hex');
  let nativeStateBefore;
  let nativeStateAfter;
  const observations = {
    backend: platformEnvironment?.nativeCustody,
    compatibilityBeforePairing: compatibilityPassed === true,
    releaseDiscovery: false,
    compatibleHealth: false,
    pairingCreate: false,
    pairingPending: false,
    pairingExchange: false,
    pairingDenied: false,
    pairingSecretNative: false,
    bearerNative: false,
    bearerNeverCrossedBoundary: false,
    nativeStoreRoundtrip: false,
    restartCredentialReused: false,
    noAutomaticRepairing: false,
    staleStateRefused: false,
    reads: {
      familiars: false,
      projects: false,
      conversations: false,
      conversation: false,
      messages: false,
    },
    reconcileRequired: false,
    reconcileDidNotPair: false,
    revocationTransition: false,
    revokedReads: {
      familiars: false,
      projects: false,
      conversations: false,
      conversation: false,
      messages: false,
    },
    allRevokedReadsRefused: false,
    keychainUnavailable: false,
  };
  let scenarioFailure;
  try {
    activeNativeStage = 'fixture';
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
      ...(platformEnvironment === undefined
        ? {}
        : {
            OPENCOVEN_PHASE1_CONFORMANCE_NATIVE_PROVIDER_PRESET: 'system-native',
            OPENCOVEN_PHASE1_CONFORMANCE_KEYRING_SERVICE: `ai.opencoven.chat.phase1.${nativeServiceOpaqueId}`,
          }),
    };
    activeNativeStage = 'rpc-start';
    rpc = await startNativeRpc(artifactRoot, nativeRpcPath, rpcEnvironment, roots.caveRoot);
    let installationId = 'phase1-installation-1';
    if (platformEnvironment !== undefined) {
      activeNativeStage = 'native-preflight';
      nativeStateBefore = validateNativeCustodyProof(
        await rpc.ok('conformance_native_custody_state', { instanceIds: [] }),
        platformEnvironment.nativeCustody,
        'Native custody preflight',
      );
      installationId = await rpc.ok('app_installation_id');
      if (
        typeof installationId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
          installationId,
        )
      ) {
        throw new Error('native custody returned a non-canonical installation ID');
      }
    }

    activeNativeStage = 'launch';
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
      observations.releaseDiscovery = true;
      observations.compatibleHealth = true;
      if (typeof health.data.instanceId === 'string') {
        nativeInstanceIds.add(health.data.instanceId);
      }
      addAssertion(
        results,
        'phase1.missing-cave.validated-launch',
        'passed',
        'phase1.assertion.passed',
      );
    } catch (error) {
      scenarioFailure = retainSchemaV2NativeFailure(scenarioFailure, activeNativeStage, error);
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

    activeNativeStage = 'pairing';
    try {
      if (typeof handle !== 'string') {
        throw new Error('no native authority handle');
      }
      const paired = await pairNative(rpc, handle, origin, adminToken, installationId);
      credentialId = paired.credentialId;
      observations.pairingCreate = true;
      observations.pairingPending = true;
      observations.pairingExchange = true;
      observations.pairingSecretNative = paired.pairingSecretNative;
      observations.bearerNative = paired.bearerNative;
      observations.bearerNeverCrossedBoundary = rpc.responsesContainNoSecrets();
      observations.nativeStoreRoundtrip = platformEnvironment !== undefined;
      addAssertion(
        results,
        'phase1.pairing.create-pending-approve-exchange',
        'passed',
        'phase1.assertion.passed',
      );
    } catch (error) {
      scenarioFailure = retainSchemaV2NativeFailure(scenarioFailure, activeNativeStage, error);
      process.stderr.write(
        `phase1-conformance: phase1.pairing.create-pending-approve-exchange failed: ${error instanceof Error ? error.message : 'unknown'}\n`,
      );
      addAssertion(
        results,
        'phase1.pairing.create-pending-approve-exchange',
        'failed',
        'phase1.integration.native-pairing-exchange-failed',
      );
      activeNativeStage = 'pairing-recovery';
      try {
        if (typeof handle === 'string') {
          await rpc.ok('cave_reset_pairing', { handle });
          const discovery = await waitForDiscovery(rpc);
          handle = discovery.handle;
          const health = await rpc.ok('cave_health', { handle, operation: rpc.operation() });
          if (typeof health.data?.instanceId === 'string') {
            nativeInstanceIds.add(health.data.instanceId);
          }
        }
      } catch {
        // The denial leg below will record an independent failure if recovery
        // from the failed exchange did not restore a usable authority handle.
      }
    }

    activeNativeStage = 'pairing-denial';
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
      observations.pairingDenied = true;
      addAssertion(results, 'phase1.pairing.denial', 'passed', 'phase1.assertion.passed');
    } catch (error) {
      scenarioFailure = retainSchemaV2NativeFailure(scenarioFailure, activeNativeStage, error);
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
      activeNativeStage = 'restart';
      try {
        const pairingCreatesBeforeRestart = rpc.commandCount('cave_pairing_create');
        activeNativeStage = 'restart-launch';
        await rpc.ok('conformance_reset_native_state');
        await rpc.ok('cave_launch');
        activeNativeStage = 'restart-discovery';
        const discovery = await waitForDiscovery(rpc);
        handle = discovery.handle;
        activeNativeStage = 'restart-health';
        const health = await rpc.ok('cave_health', { handle, operation: rpc.operation() });
        if (typeof health.data?.instanceId === 'string') {
          nativeInstanceIds.add(health.data.instanceId);
        }
        activeNativeStage = 'restart-status';
        const status = await rpc.ok('cave_credential_status', {
          handle,
          operation: rpc.operation(),
        });
        if (status.status !== 'valid') {
          throw new Error('credential was not reused after native state restart');
        }
        observations.restartCredentialReused = true;
        observations.noAutomaticRepairing =
          rpc.commandCount('cave_pairing_create') === pairingCreatesBeforeRestart;
        addAssertion(
          results,
          'phase1.credential.restart-reuse',
          'passed',
          'phase1.assertion.passed',
        );
      } catch (error) {
        scenarioFailure = retainSchemaV2NativeFailure(scenarioFailure, activeNativeStage, error);
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
      activeNativeStage = 'reads';
      try {
        const familiars = collection(
          await rpc.ok('cave_list_familiars', {
            handle,
            page: { limit: 1 },
            operation: rpc.operation(),
          }),
          'familiars',
        );
        observations.reads.familiars = familiars.length === 1;
        const projects = collection(
          await rpc.ok('cave_list_projects', {
            handle,
            page: { limit: 2 },
            operation: rpc.operation(),
          }),
          'projects',
        );
        observations.reads.projects = projects.length <= 2;
        const conversations = collection(
          await rpc.ok('cave_list_conversations', {
            handle,
            page: { limit: 2 },
            operation: rpc.operation(),
          }),
          'conversations',
        );
        observations.reads.conversations = conversations.length <= 2;
        const conversation = await rpc.ok('cave_get_conversation', {
          handle,
          conversationId: 'branched',
          operation: rpc.operation(),
        });
        observations.reads.conversation = conversation.data?.conversation?.id === 'branched';
        const messages = collection(
          await rpc.ok('cave_list_conversation_messages', {
            handle,
            conversationId: 'branched',
            page: { limit: 1 },
            operation: rpc.operation(),
          }),
          'messages',
        );
        observations.reads.messages = messages.length === 1;
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
        scenarioFailure = retainSchemaV2NativeFailure(scenarioFailure, activeNativeStage, error);
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
      activeNativeStage = 'reconciliation';
      try {
        const firstPage = await rpc.ok('cave_list_conversation_messages', {
          handle,
          conversationId: 'branched',
          page: { limit: 2 },
          operation: rpc.operation(),
        });
        const pairingCreatesBeforeReconcile = rpc.commandCount('cave_pairing_create');
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
        observations.reconcileRequired = true;
        observations.reconcileDidNotPair =
          rpc.commandCount('cave_pairing_create') === pairingCreatesBeforeReconcile;
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
        scenarioFailure = retainSchemaV2NativeFailure(scenarioFailure, activeNativeStage, error);
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
      activeNativeStage = 'revocation';
      try {
        activeNativeStage = 'revocation-delete';
        await adminMutation(origin, adminToken, 'DELETE', `/admin/credentials/${credentialId}`, {
          reason: 'phase1-conformance',
        });
        activeNativeStage = 'revocation-initial-status';
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
        activeNativeStage = 'revocation-rediscovery';
        const rediscovery = await waitForDiscovery(rpc);
        handle = rediscovery.handle;
        activeNativeStage = 'revocation-health';
        const health = await rpc.ok('cave_health', { handle, operation: rpc.operation() });
        if (typeof health.data?.instanceId === 'string') {
          nativeInstanceIds.add(health.data.instanceId);
        }
        activeNativeStage = 'revocation-status';
        const status = await rpc.ok('cave_credential_status', {
          handle,
          operation: rpc.operation(),
        });
        if (!['revoked', 'missing'].includes(status.status)) {
          throw new Error('native credential did not converge to revoked');
        }
        observations.revocationTransition = true;
        const revokedReadCases = [
          [
            'familiars',
            'cave_list_familiars',
            { handle, page: { limit: 1 }, operation: rpc.operation() },
          ],
          [
            'projects',
            'cave_list_projects',
            { handle, page: { limit: 1 }, operation: rpc.operation() },
          ],
          [
            'conversations',
            'cave_list_conversations',
            { handle, page: { limit: 1 }, operation: rpc.operation() },
          ],
          [
            'conversation',
            'cave_get_conversation',
            { handle, conversationId: 'branched', operation: rpc.operation() },
          ],
          [
            'messages',
            'cave_list_conversation_messages',
            {
              handle,
              conversationId: 'branched',
              page: { limit: 1 },
              operation: rpc.operation(),
            },
          ],
        ];
        for (const [key, command, args] of revokedReadCases) {
          const response = await rpc.request(command, args);
          if (
            response.ok !== false ||
            !['credential_missing', 'unauthorized'].includes(response.error?.code)
          ) {
            throw new Error(`revoked credential still reached ${key}`);
          }
          observations.revokedReads[key] = true;
        }
        observations.allRevokedReadsRefused = Object.values(observations.revokedReads).every(
          Boolean,
        );
        activeNativeStage = 'revocation-repair';
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
        scenarioFailure = retainSchemaV2NativeFailure(scenarioFailure, activeNativeStage, error);
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

    activeNativeStage = 'stale-discovery';
    const discoveryPath = resolve(caveHome, 'client-v1-discovery.json');
    const originalDiscovery = readFileSync(discoveryPath, 'utf8');
    const discovery = JSON.parse(originalDiscovery);
    discovery.endpoint = 'http://127.0.0.1:1';
    writeFileSync(discoveryPath, `${JSON.stringify(discovery)}\n`, { mode: 0o600 });
    await rpc.error(
      'cave_health',
      { handle, operation: rpc.operation() },
      'stale_discovery_handle',
    );
    observations.staleStateRefused = true;
    writeFileSync(discoveryPath, originalDiscovery, { mode: 0o600 });
    const restoredDiscovery = await waitForDiscovery(rpc);
    handle = restoredDiscovery.handle;
    const restoredHealth = await rpc.ok('cave_health', {
      handle,
      operation: rpc.operation(),
    });
    if (typeof restoredHealth.data?.instanceId === 'string') {
      nativeInstanceIds.add(restoredHealth.data.instanceId);
    }
    observations.bearerNeverCrossedBoundary = rpc.responsesContainNoSecrets();
  } catch (error) {
    scenarioFailure = retainSchemaV2NativeFailure(scenarioFailure, activeNativeStage, error);
  }
  activeNativeStage = 'cleanup';
  let cleanupFailure;
  if (rpc !== undefined && platformEnvironment !== undefined) {
    let grant;
    try {
      activeNativeStage = 'cleanup-grant';
      const cleanupInstanceIds = [...nativeInstanceIds].sort();
      const issued = await rpc.ok('conformance_issue_native_custody_cleanup', {
        instanceIds: cleanupInstanceIds,
      });
      if (
        issued === null ||
        typeof issued !== 'object' ||
        typeof issued.grant !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/u.test(issued.grant)
      ) {
        throw new Error('Native custody cleanup grant was not canonical.');
      }
      grant = issued.grant;
      issued.grant = undefined;
    } catch (error) {
      cleanupFailure = retainSchemaV2NativeFailure(cleanupFailure, activeNativeStage, error);
    }
    if (grant !== undefined) {
      try {
        activeNativeStage = 'cleanup-custody';
        nativeStateAfter = validateNativeCustodyProof(
          await rpc.ok('conformance_cleanup_native_custody', { grant }),
          platformEnvironment.nativeCustody,
          'Native custody cleanup',
        );
      } catch (error) {
        cleanupFailure = retainSchemaV2NativeFailure(cleanupFailure, activeNativeStage, error);
      } finally {
        grant = undefined;
      }
    }
  }
  if (rpc !== undefined) {
    try {
      activeNativeStage = 'cleanup-rpc';
      await rpc.close();
    } catch (error) {
      cleanupFailure = retainSchemaV2NativeFailure(cleanupFailure, activeNativeStage, error);
    }
  }
  try {
    activeNativeStage = 'cleanup-fixture-daemon';
    await fixtureDaemon.close();
  } catch (error) {
    cleanupFailure = retainSchemaV2NativeFailure(cleanupFailure, activeNativeStage, error);
  }
  if (scenarioFailure !== undefined || cleanupFailure !== undefined) {
    const failures = [scenarioFailure, cleanupFailure].filter((failure) => failure !== undefined);
    if (failures.length === 1) {
      throw failures[0];
    }
    throw new AggregateError(failures, scenarioFailure.message);
  }
  activeNativeStage = 'missing-keychain';
  try {
    await runNativeMissingKeychainTrustScenario(artifactRoot, nativeRpcPath, environment, results);
  } catch (error) {
    throw new Error(schemaV2NativeFailureDiagnostic(activeNativeStage), { cause: error });
  }
  observations.keychainUnavailable = true;
  if (platformEnvironment === undefined) {
    return undefined;
  }
  if (
    nativeStateBefore === undefined ||
    nativeStateAfter === undefined ||
    nativeStateBefore.stateSha256 !== nativeStateAfter.stateSha256
  ) {
    throw new Error(schemaV2NativeFailureDiagnostic('isolation-proof'));
  }
  return {
    ...observations,
    backend: platformEnvironment.nativeCustody,
    available: true,
    beforeSha256: nativeStateBefore.stateSha256,
    afterSha256: nativeStateAfter.stateSha256,
    opaqueId: nativeServiceOpaqueId,
  };
}

async function runCovenIdentityScenario(
  artifactRoot,
  covenBinaryPath,
  nativeRpcPath,
  environment,
  results,
) {
  const covenRoot = createProcessOwnedArtifactRoot({ prefix: 'p1cv', shortPath: true });
  return withOwnedArtifactRoot(covenRoot, async () => {
    const covenHome = resolve(covenRoot.rootPath, 'cv');
    mkdirSync(covenHome, { recursive: true, mode: 0o700 });
    const child = spawn(covenBinaryPath, ['daemon', 'serve'], {
      env: { ...environment, COVEN_HOME: covenHome },
      detached: ownedProcessGroupsSupported,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    await once(child, 'spawn');
    covenRoot.trackChild(child, { processGroup: ownedProcessGroupsSupported });
    let rpc;
    const observations = {
      ownerLocal: false,
      health: false,
      connectedIdentity: false,
      executableTrusted: false,
      executableTrustFailure: false,
      trustProviderUnavailable: false,
    };
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
      rpc = await startNativeRpc(
        artifactRoot,
        nativeRpcPath,
        {
          ...environment,
          COVEN_HOME: covenHome,
          OPENCOVEN_COVEN_EXECUTABLE: resolve(covenHome, 'untrusted-coven'),
        },
        covenHome,
      );
      const health = await rpc.ok('coven_health', {
        operation: rpc.operation(),
      });
      if (health.status !== 'ok') {
        throw new Error('Chat native Coven health did not return the canonical status');
      }
      observations.ownerLocal = true;
      observations.health = true;
      observations.connectedIdentity = true;
      observations.executableTrusted = true;
      observations.executableTrustFailure = true;
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
      if (rpc !== undefined) {
        await rpc.close();
      }
    }
    observations.trustProviderUnavailable = await runNativeMissingCovenTrustScenario(
      artifactRoot,
      nativeRpcPath,
      environment,
    );
    return observations;
  });
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

function passedTest(tests, fragment) {
  return [...tests].some((name) => name.includes(fragment));
}

function primaryPassed(report, id) {
  return report.assertions.some(
    (assertion) => assertion.id === id && assertion.status === 'passed',
  );
}

function cavePassed(caveRecord, ...ids) {
  const results = new Map(
    caveRecord.assertions.map((assertion) => [assertion.id, assertion.result]),
  );
  return ids.every((id) => results.get(id) === 'pass');
}

function recordWhen(recorder, id, condition) {
  if (condition) {
    recorder.pass(id);
  }
}

export function buildObservedSchemaV2Assertions({
  registry,
  platform,
  packageObservations,
  primaryReport,
  caveRecord,
  native,
  coven,
  tests,
  scansPassed,
}) {
  const sdk = createObservedAssertionRecorder(registry.assertions.sdk, 'SDK');
  const chatIds = [
    ...registry.assertions.chat.common,
    ...registry.assertions.chat.platforms[platform],
  ];
  const chat = createObservedAssertionRecorder(chatIds, 'Chat');
  for (const id of packageObservations.sdk) {
    sdk.pass(id);
  }
  for (const id of packageObservations.chat) {
    chat.pass(id);
  }

  const sdkTest = (fragment) => passedTest(tests.sdk, fragment);
  const chatTest = (fragment) => passedTest(tests.chat, fragment);
  const chatRustTest = (fragment) => passedTest(tests.chatRust, fragment);
  const covenRustTest = (fragment) => passedTest(tests.covenRust, fragment);

  recordWhen(
    sdk,
    'sdk.cave.discovery.release-mode',
    native.releaseDiscovery &&
      cavePassed(caveRecord, 'health.discovery-record') &&
      sdkTest('canonicalizes routes and validates strict discovery v2'),
  );
  recordWhen(
    sdk,
    'sdk.cave.discovery.stale-record-refused',
    native.staleStateRefused && sdkTest('rejects stale or malformed discovery records'),
  );
  recordWhen(
    sdk,
    'sdk.cave.discovery.replaced-instance-refused',
    native.staleStateRefused &&
      sdkTest('invalidates an instance-replaced credential before bearer attachment'),
  );
  recordWhen(
    sdk,
    'sdk.cave.health.compatible',
    native.compatibleHealth &&
      primaryPassed(primaryReport, 'phase1.compat.api-major-min-client') &&
      sdkTest('accepts Cave health responses when the minimum client version is compatible'),
  );
  recordWhen(
    sdk,
    'sdk.cave.pairing.create',
    native.pairingCreate &&
      cavePassed(caveRecord, 'pairing.create') &&
      sdkTest('creates, polls, exchanges, validates, and forgets a paired credential'),
  );
  recordWhen(
    sdk,
    'sdk.cave.pairing.pending',
    native.pairingPending &&
      cavePassed(caveRecord, 'pairing.poll-pending') &&
      sdkTest("surfaces pairing exchange errors: 'pairing_pending'"),
  );
  recordWhen(
    sdk,
    'sdk.cave.pairing.exchange-once',
    native.pairingExchange &&
      cavePassed(caveRecord, 'pairing.exchange', 'pairing.replay-refused') &&
      sdkTest('allows only one transport exchange across concurrent exchange attempts'),
  );
  recordWhen(
    sdk,
    'sdk.cave.pairing.denied',
    native.pairingDenied &&
      cavePassed(caveRecord, 'pairing.poll-denied', 'pairing.exchange-denied') &&
      sdkTest("surfaces pairing exchange errors: 'pairing_denied'"),
  );
  recordWhen(
    sdk,
    'sdk.cave.pairing.expired',
    primaryPassed(primaryReport, 'phase1.pairing.expiry') &&
      cavePassed(caveRecord, 'pairing.ttl-poll-expired', 'pairing.ttl-exchange-expired') &&
      sdkTest("surfaces pairing exchange errors: 'pairing_expired'"),
  );
  recordWhen(
    sdk,
    'sdk.cave.pairing.wrong-secret-refused',
    cavePassed(caveRecord, 'pairing.wrong-secret'),
  );
  recordWhen(
    sdk,
    'sdk.cave.pairing.replay-refused',
    cavePassed(caveRecord, 'pairing.replay-refused') &&
      sdkTest('allows retry after a pre-send authority mismatch without replaying the secret'),
  );
  recordWhen(
    sdk,
    'sdk.cave.pairing.shared-failure-budget',
    cavePassed(
      caveRecord,
      'pairing.budget-charges-wrong-secret-on-poll',
      'pairing.budget-locks-out-the-holder',
      'pairing.budget-is-shared-across-routes',
    ),
  );
  recordWhen(
    sdk,
    'sdk.cave.pairing.rate-limit',
    cavePassed(caveRecord, 'pairing.budget-locks-out-the-holder') &&
      sdkTest('preserves the managed contract error code and retry semantics for rate_limited'),
  );
  recordWhen(
    sdk,
    'sdk.cave.exchange.missing-content-length-refused',
    cavePassed(caveRecord, 'ingress.exchange-requires-content-length'),
  );
  recordWhen(
    sdk,
    'sdk.cave.exchange.content-length-zero-accepted',
    cavePassed(caveRecord, 'pairing.exchange') &&
      chatRustTest('pairing_exchange_empty_post_declares_zero_content_length'),
  );
  recordWhen(
    sdk,
    'sdk.cave.proxy-rejection.distinct-envelope',
    sdkTest('never parses a proxy rejection as a Client v1 health envelope'),
  );
  recordWhen(sdk, 'sdk.cave.credential.native-store-required', native.nativeStoreRoundtrip);
  recordWhen(sdk, 'sdk.cave.credential.restart-reused', native.restartCredentialReused);
  for (const [id, key] of [
    ['sdk.cave.read.familiars', 'familiars'],
    ['sdk.cave.read.projects', 'projects'],
    ['sdk.cave.read.conversations', 'conversations'],
    ['sdk.cave.read.conversation', 'conversation'],
    ['sdk.cave.read.messages', 'messages'],
  ]) {
    recordWhen(
      sdk,
      id,
      native.reads[key] &&
        sdkTest('uses exact canonical routes, deterministic queries, encoded ids'),
    );
  }
  recordWhen(
    sdk,
    'sdk.cave.cursor.malformed-refused',
    sdkTest('validates page options and conversation ids before transport I/O'),
  );
  recordWhen(
    sdk,
    'sdk.cave.cursor.noncanonical-refused',
    sdkTest('parses the optional top-level cursor with core canonical validation'),
  );
  recordWhen(
    sdk,
    'sdk.cave.cursor.reconcile-required',
    native.reconcileRequired &&
      sdkTest('propagates reconcile_required from messages without retrying and forwards the id'),
  );
  for (const [id, key] of [
    ['sdk.cave.revocation.familiars-refused', 'familiars'],
    ['sdk.cave.revocation.projects-refused', 'projects'],
    ['sdk.cave.revocation.conversations-refused', 'conversations'],
    ['sdk.cave.revocation.conversation-refused', 'conversation'],
    ['sdk.cave.revocation.messages-refused', 'messages'],
  ]) {
    recordWhen(
      sdk,
      id,
      native.revokedReads[key] &&
        sdkTest('preserves revoked bearer rejection without fallback or retry'),
    );
  }
  recordWhen(
    sdk,
    'sdk.coven.discovery.owner-local',
    coven.ownerLocal && sdkTest('prefers non-empty COVEN_HOME without invoking the CLI'),
  );
  recordWhen(
    sdk,
    'sdk.coven.health',
    coven.health && sdkTest('sends only the reviewed health request and parses a valid response'),
  );
  recordWhen(
    sdk,
    'sdk.coven.structured-errors',
    sdkTest('preserves structured daemon error fields without flattening them'),
  );
  recordWhen(
    sdk,
    'sdk.deadline.connect-bounded',
    sdkTest('reports connect timeout and honors cancellation'),
  );
  recordWhen(
    sdk,
    'sdk.deadline.read-bounded',
    sdkTest('rejects a Unix response received at its 1ms absolute deadline') ||
      sdkTest('rejects a Windows response received at its 1ms absolute deadline'),
  );
  recordWhen(sdk, 'sdk.deadline.body-bounded', sdkTest("rejects 'oversized body declaration'"));
  recordWhen(
    sdk,
    'sdk.deadline.frame-bounded',
    sdkTest('rejects invalid HTTP health framing') ||
      sdkTest('shares frame limits and structured daemon errors with Unix'),
  );
  recordWhen(
    sdk,
    'sdk.native.keychain-missing-fails-closed',
    native.keychainUnavailable &&
      sdkTest('rejects missing Entry constructors as secure_store_unavailable'),
  );
  recordWhen(
    sdk,
    'sdk.native.trust-binding-missing-fails-closed',
    coven.trustProviderUnavailable &&
      sdkTest('fails closed before discovery when transport security is missing at runtime'),
  );

  recordWhen(chat, 'chat.cave.compatibility-before-pairing', native.compatibilityBeforePairing);
  recordWhen(chat, 'chat.cave.pairing-secret-remains-native', native.pairingSecretNative);
  recordWhen(chat, 'chat.cave.bearer-remains-native', native.bearerNative);
  recordWhen(
    chat,
    'chat.cave.bearer-never-enters-webview',
    native.bearerNeverCrossedBoundary &&
      chatTest('never places secret canaries in managed command arguments or results'),
  );
  recordWhen(chat, 'chat.cave.native-store.roundtrip', native.nativeStoreRoundtrip);
  recordWhen(chat, 'chat.cave.restart.credential-reused', native.restartCredentialReused);
  recordWhen(chat, 'chat.cave.restart.no-automatic-repairing', native.noAutomaticRepairing);
  recordWhen(chat, 'chat.cave.replacement.stale-state-refused', native.staleStateRefused);
  for (const [id, key] of [
    ['chat.cave.read.familiars', 'familiars'],
    ['chat.cave.read.projects', 'projects'],
    ['chat.cave.read.conversations', 'conversations'],
    ['chat.cave.read.conversation', 'conversation'],
    ['chat.cave.read.messages', 'messages'],
  ]) {
    recordWhen(chat, id, native.reads[key]);
  }
  recordWhen(
    chat,
    'chat.cave.reconcile.reloads-query-only',
    native.reconcileRequired &&
      native.reconcileDidNotPair &&
      chatTest('surfaces reconcile_required separately from generic errors'),
  );
  recordWhen(
    chat,
    'chat.cave.revocation.transitions-state',
    native.revocationTransition &&
      chatTest('only revokes after a confirmed packed managed credential status'),
  );
  recordWhen(chat, 'chat.cave.revocation.all-reads-refused', native.allRevokedReadsRefused);
  recordWhen(chat, 'chat.coven.discovery.owner-local', coven.ownerLocal);
  recordWhen(chat, 'chat.coven.executable.trusted', coven.executableTrusted);
  recordWhen(chat, 'chat.coven.health', coven.health);
  recordWhen(
    chat,
    'chat.coven.structured-errors-preserved',
    chatRustTest('maps_client_failures_to_bounded_diagnostics_without_leaking_details'),
  );
  recordWhen(
    chat,
    'chat.deadline.total-bounded',
    chatTest('propagates a managed SDK deadline to native cancellation and caps native duration'),
  );
  recordWhen(chat, 'chat.native.keychain-unavailable-fails-closed', native.keychainUnavailable);
  recordWhen(
    chat,
    'chat.native.trust-provider-unavailable-fails-closed',
    coven.trustProviderUnavailable,
  );
  for (const id of [
    'chat.evidence.no-prompts',
    'chat.evidence.no-message-bodies',
    'chat.evidence.no-attachments',
    'chat.evidence.no-command-output',
  ]) {
    recordWhen(chat, id, scansPassed);
  }

  if (platform === 'win32-x64') {
    recordWhen(chat, 'chat.coven.windows.pipe-owner', coven.ownerLocal);
    recordWhen(chat, 'chat.coven.windows.connected-pipe-identity', coven.connectedIdentity);
    recordWhen(
      chat,
      'chat.coven.windows.malicious-home-refused',
      covenRustTest('legacy_v1_case_check_rejects_sensitive_or_unverifiable_ancestors'),
    );
    recordWhen(
      chat,
      'chat.coven.windows.constructed-pipe-refused',
      covenRustTest('recorded_windows_pipe_candidates_accept_only_coven_stable_or_legacy_shapes'),
    );
    recordWhen(
      chat,
      'chat.coven.windows.foreign-pipe-refused',
      covenRustTest('recorded_daemon_status_rejects_a_stable_pipe_for_another_profile'),
    );
    recordWhen(
      chat,
      'chat.coven.windows.ownership-provider-failure-refused',
      covenRustTest('windows_security_inspection_waits_are_finite'),
    );
    recordWhen(
      chat,
      'chat.coven.windows.executable-trust-failure-refused',
      coven.executableTrustFailure,
    );
    recordWhen(
      chat,
      'chat.coven.windows.reparse-endpoint-refused',
      covenRustTest('status_file_reader_allows_an_atomic_status_replacement'),
    );
    recordWhen(
      chat,
      'chat.native.windows-credential-manager.isolated',
      native.nativeStoreRoundtrip && native.backend === 'windows-credential-manager',
    );
  } else {
    recordWhen(
      chat,
      'chat.coven.unix.connected-peer-identity',
      coven.connectedIdentity &&
        covenRustTest('platform_peer_credentials_report_the_connected_process_uid'),
    );
    for (const id of [
      'chat.coven.unix.malicious-home-refused',
      'chat.coven.unix.symlink-socket-refused',
      'chat.coven.unix.wrong-owner-refused',
      'chat.coven.unix.wrong-mode-refused',
    ]) {
      recordWhen(chat, id, covenRustTest('discovers_only_an_owner_local_unix_socket'));
    }
    recordWhen(
      chat,
      'chat.coven.unix.replaced-socket-refused',
      covenRustTest('a_mutation_is_not_sent_to_a_replacement_before_that_peer_is_negotiated'),
    );
    recordWhen(
      chat,
      'chat.coven.unix.wrong-peer-uid-refused',
      covenRustTest('connected_peer_uid_must_match_discovered_and_current_owner'),
    );
    recordWhen(
      chat,
      'chat.coven.unix.peer-provider-failure-refused',
      coven.trustProviderUnavailable,
    );
    recordWhen(
      chat,
      'chat.coven.unix.executable-trust-failure-refused',
      coven.executableTrustFailure,
    );
    recordWhen(
      chat,
      platform === 'darwin-arm64'
        ? 'chat.native.macos-keychain.isolated'
        : 'chat.native.linux-keyring.isolated',
      native.nativeStoreRoundtrip &&
        native.backend === CANONICAL_PLATFORM_ENVIRONMENTS[platform].nativeCustody,
    );
  }

  return {
    sdk: sdk.complete(),
    chat: chat.complete(),
  };
}

export function recordCaveMatrixFailure(results, error) {
  recordCaveBackedAssertions(results, new Map());
  return error;
}

export function wrapInfrastructureFailure(error, report) {
  if (
    error !== null &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string' &&
    publicFailureDiagnosticSet.has(error.message)
  ) {
    const wrapped = new Error(error.message, { cause: error });
    wrapped.result = { report };
    return wrapped;
  }
  if (error instanceof CommandExecutionError) {
    const reason = approvedCommandFailureReasons.has(error.result?.reason)
      ? error.result.reason
      : undefined;
    return new CommandExecutionError(
      error.label,
      {
        ...(reason === undefined ? {} : { reason }),
        report,
      },
      error,
    );
  }
  return new CommandExecutionError('Phase 1 conformance infrastructure', { report }, error);
}

function fillMissingAssertions(results, status, diagnosticId) {
  for (const id of REQUIRED_PHASE1_ASSERTION_IDS) {
    if (!results.has(id)) {
      addAssertion(results, id, status, diagnosticId);
    }
  }
}

export async function runSchemaV2Conformance(options, lock, harnessAuthorityVerification) {
  scrubEvidenceAuthorizationEnvironment();
  requirePhase1HarnessAuthorityVerification(harnessAuthorityVerification, lock, projectRoot);
  const schemaV2 = options.platform !== undefined;
  if (schemaV2 && lock.version !== 3 && lock.version !== 5) {
    throw new Error('Schema-v2 evidence requires Phase 1 lock version 3 or 5.');
  }
  if (schemaV2 && options.platform !== `${process.platform}-${process.arch}`) {
    throw new Error(
      `Requested platform ${options.platform} does not match ${process.platform}-${process.arch}.`,
    );
  }
  const supervisorEnvironment = schemaV2 ? schemaV2SupervisorEnvironment(process.env) : {};
  if (
    schemaV2 &&
    options.outputPath !== supervisorArtifactOutputPath(supervisorEnvironment, process.platform)
  ) {
    throw new Error('Schema-v2 evidence output changed after supervisor validation.');
  }
  const windowsJobBinding = schemaV2 && process.platform === 'win32' ? supervisorEnvironment : {};
  const unixProducerBinding = schemaV2 && process.platform !== 'win32' ? supervisorEnvironment : {};
  assertWindowsJobMembership(windowsJobBinding);
  options = resolveDefaultSourceRoots(options, resolveRepositoryLayout());
  const startedAt = new Date().toISOString();
  const operatorHomes = schemaV2 ? resolveOperatorHomes() : undefined;
  const operatorBefore =
    operatorHomes === undefined ? undefined : captureOperatorFilesystemState(operatorHomes);
  const linuxSessionEnvironment =
    schemaV2 && process.platform === 'linux'
      ? curateLinuxSecretServiceEnvironment(
          process.env,
          process.env.OPENCOVEN_PHASE1_SECRET_SERVICE_ROOT,
        )
      : {};
  const executionRoot = createProcessOwnedArtifactRoot({ prefix: 'phase1-conformance-run' });
  const reportRoot = createProcessOwnedArtifactRoot({ prefix: 'phase1-conformance-report' });
  const environment = safeEnvironment(executionRoot.rootPath, {
    ...(schemaV2 ? { OPENCOVEN_PHASE1_SCHEMA_V2_EVIDENCE: '1' } : {}),
    ...linuxSessionEnvironment,
    ...unixProducerBinding,
    ...windowsJobBinding,
  });
  const results = new Map();
  let artifactDigests = {};
  let infrastructureFailure;
  let caveRecord;
  let nativeProof;
  let roots;
  let sdkContract;
  let producer;
  let evidenceArtifacts;
  let toolchain;
  let verifiedIdentities;
  let observationTests;
  let covenProof;
  let packageObservations;
  let macosKeychainSession;
  let activeStage = 'phase1.stage.checkouts.failed';

  try {
    roots = await createExactCheckouts(executionRoot, options, lock, environment);
    if (schemaV2) {
      activeStage = 'phase1.stage.evidence-authority.failed';
      validateSchemaV2AuthorityCheckouts({
        lock,
        harnessRoot: projectRoot,
        producerRoot: roots.producerRoot,
        producerIdentity: roots.producerIdentity,
      });
      sdkContract = await loadSdkEvidenceContract({
        validatorRoot: roots.validatorRoot,
        validatorIdentity: {
          repository: 'OpenCoven/sdk',
          commit: options.validatorRevision,
          tree: roots.validatorIdentity.tree,
        },
      });
      sdkContract.contract.assertEvidenceProducerCompatibility(sdkContract.frozenLock);
      assertSdkContractMatchesPhase1Lock(sdkContract, lock);
      producer = await verifySchemaV2ProducerCheckout({
        producerRoot: roots.producerRoot,
        producerIdentity: roots.producerIdentity,
        sdkContract,
      });
      evidenceArtifacts = collectFrozenEvidenceArtifacts({ roots, sdkContract });
      verifiedIdentities = {
        candidate: verifiedCheckoutIdentity(lock, 'sdk', roots.sdkRoot),
        cave: verifiedCheckoutIdentity(lock, 'cave', roots.caveRoot),
        coven: verifiedCheckoutIdentity(lock, 'coven', roots.covenRoot),
        chat: verifiedCheckoutIdentity(lock, 'chat', roots.chatRoot),
      };
      activeStage = 'phase1.stage.toolchain.failed';
      const toolchainRoot =
        supervisorEnvironment.OPENCOVEN_WINDOWS_WORKSPACE ??
        supervisorEnvironment.OPENCOVEN_UNIX_WORKSPACE;
      toolchain = await collectToolchainMetadata(
        executionRoot,
        environment,
        sdkContract.frozenLock.toolchain,
        toolchainRoot,
      );
    }
    activeStage = 'phase1.stage.packaging.failed';
    const packaged = await packageLockedArtifacts(executionRoot, roots, environment, {
      schemaV2,
      onStage(stage) {
        activeStage = stage;
      },
    });
    artifactDigests = packaged.artifactDigests;
    packageObservations = packaged.packedConsumerObservations;
    if (schemaV2) {
      activeStage = 'phase1.stage.runtime-assertions.failed';
      observationTests = await runSchemaV2ObservationSuites(
        executionRoot,
        roots,
        environment,
        options.platform,
      );
    }

    try {
      activeStage = 'phase1.stage.cave-authority.failed';
      const caveAuthority = await runCaveAuthorityMatrix(
        executionRoot,
        roots.caveRoot,
        environment,
      );
      caveRecord = caveAuthority.caveRecord;
      recordCaveBackedAssertions(results, caveAuthority.assertions);
    } catch (error) {
      const failure = schemaV2
        ? new Error(schemaV2FailureDiagnostic(error, activeStage), { cause: error })
        : error;
      infrastructureFailure ??= recordCaveMatrixFailure(results, failure);
    }

    activeStage = 'phase1.stage.runtime-assertions.failed';
    await runCompatibilityScenarios({
      artifactRoot: executionRoot,
      roots,
      environment,
      results,
    });
    if (schemaV2 && process.platform === 'darwin') {
      activeStage = 'phase1.stage.native-scenarios.failed';
      macosKeychainSession = prepareMacosKeychainSession({ home: environment.HOME });
    }
    activeStage = 'phase1.stage.native-scenarios.failed';
    nativeProof = await runNativeScenarios({
      artifactRoot: executionRoot,
      roots,
      nativeRpcPath: packaged.nativeRpcPath,
      environment,
      results,
      platform: options.platform,
      compatibilityPassed: results.get('phase1.compat.api-major-min-client')?.status === 'passed',
    });
    activeStage = 'phase1.stage.coven-identity.failed';
    covenProof = await runCovenIdentityScenario(
      executionRoot,
      packaged.covenBinaryPath,
      packaged.nativeRpcPath,
      environment,
      results,
    );
    activeStage = 'phase1.stage.isolation.failed';
    const operatorIsolationValid =
      environment.HOME !== process.env.HOME &&
      environment.XDG_CONFIG_HOME.startsWith(executionRoot.rootPath) &&
      environment.TMPDIR.startsWith(executionRoot.rootPath) &&
      environment.CARGO_HOME.startsWith(executionRoot.rootPath) &&
      environment.RUSTUP_HOME === undefined;
    addAssertion(
      results,
      'phase1.operator.homes-credentials-untouched',
      operatorIsolationValid ? 'passed' : 'failed',
      operatorIsolationValid ? 'phase1.assertion.passed' : 'phase1.assertion.failed',
    );
  } catch (error) {
    infrastructureFailure ??= schemaV2
      ? new Error(schemaV2FailureDiagnostic(error, activeStage), { cause: error })
      : error;
    fillMissingAssertions(results, 'failed', 'phase1.assertion.failed');
  }

  if (macosKeychainSession !== undefined) {
    try {
      macosKeychainSession.close();
    } catch (error) {
      infrastructureFailure ??= schemaV2
        ? new Error(schemaV2FailureDiagnostic(error, 'phase1.stage.native-scenarios.failed'), {
            cause: error,
          })
        : error;
      for (const [id, assertion] of results) {
        if (assertion.status === 'passed') {
          results.set(id, makeAssertion(id, 'failed', 'phase1.assertion.failed'));
        }
      }
    }
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
      'failed',
      'phase1.assertion.failed',
    );
  }
  fillMissingAssertions(results, 'blocked', 'phase1.assertion.blocked');

  try {
    await executionRoot.cleanup();
  } catch (error) {
    infrastructureFailure ??= schemaV2
      ? new Error(schemaV2FailureDiagnostic(error, 'phase1.stage.execution-root-cleanup.failed'), {
          cause: error,
        })
      : error;
    for (const [id, assertion] of results) {
      if (assertion.status === 'passed') {
        results.set(id, makeAssertion(id, 'failed', 'phase1.assertion.failed'));
      }
    }
  }

  const report = await withOwnedArtifactRoot(reportRoot, async () => {
    const completedReport = buildPhase1Report({
      assertions: [...results.values()],
      revisions: {
        chat: lock.chat.revision,
        sdk: lock.sdk.revision,
        cave: lock.cave.revision,
        coven: lock.coven.revision,
      },
      artifactDigests,
      versions: {
        harness: schemaV2 ? PHASE1_SCHEMA_V2_HARNESS_VERSION : '1.0.0',
        node: process.versions.node,
        ...(schemaV2 && toolchain !== undefined
          ? {
              rust: toolchain.rustVersion,
              tauri: toolchain.tauriVersion,
            }
          : {}),
      },
    });
    scanPhase1ArtifactText(`${JSON.stringify(completedReport)}\n`);

    if (schemaV2) {
      if (
        infrastructureFailure !== undefined ||
        sdkContract === undefined ||
        producer === undefined ||
        evidenceArtifacts === undefined ||
        toolchain === undefined ||
        observationTests === undefined ||
        covenProof === undefined ||
        packageObservations === undefined ||
        caveRecord === undefined ||
        nativeProof === undefined ||
        roots === undefined ||
        verifiedIdentities === undefined ||
        operatorBefore === undefined ||
        operatorHomes === undefined
      ) {
        throw wrapInfrastructureFailure(
          infrastructureFailure ?? new Error('Schema-v2 evidence prerequisites were incomplete.'),
          completedReport,
        );
      }
      const operatorAfter = captureOperatorFilesystemState(operatorHomes);
      const isolation = buildIsolationEvidence({
        operatorBefore,
        operatorAfter,
        nativeBeforeSha256: nativeProof.beforeSha256,
        nativeAfterSha256: nativeProof.afterSha256,
        opaqueIds: [
          randomBytes(16).toString('hex'),
          randomBytes(16).toString('hex'),
          randomBytes(16).toString('hex'),
          nativeProof.opaqueId,
        ],
      });
      const observedAssertions = buildObservedSchemaV2Assertions({
        registry: sdkContract.registry,
        platform: options.platform,
        packageObservations,
        primaryReport: completedReport,
        caveRecord,
        native: nativeProof,
        coven: covenProof,
        tests: observationTests,
        scansPassed: true,
      });
      const evidence = buildSchemaV2PlatformEvidence({
        primaryReport: completedReport,
        caveRecord,
        platform: options.platform,
        timing: {
          startedAt,
          completedAt: new Date().toISOString(),
        },
        sdkContract,
        observedAssertions,
        verified: {
          validator: sdkContract.validator,
          ...verifiedIdentities,
          harness: {
            ...producer.harness,
            invocationId: randomUUID(),
          },
          artifacts: evidenceArtifacts,
          environment: {
            os: process.platform,
            arch: process.arch,
            ...toolchain,
            nativeCustody: {
              backend: nativeProof.backend,
              available: true,
            },
            covenIdentity: {
              backend: CANONICAL_PLATFORM_ENVIRONMENTS[options.platform].covenIdentity,
              available: true,
            },
          },
          isolation,
        },
      });
      const canonical = serializeValidatedSchemaV2PlatformEvidence(evidence, {
        contract: sdkContract.contract,
        schema: sdkContract.schema,
      });
      scanPhase1ArtifactText(canonical, {
        validateReport(_value, contents) {
          sdkContract.contract.parsePlatformEvidence(
            contents,
            'Chat retained schema-v2 platform evidence',
            sdkContract.schema,
          );
        },
      });
      const reportPath = resolve(reportRoot.rootPath, 'record.json');
      writeFileSync(reportPath, canonical, { mode: 0o600 });
      await reportRoot.retainSanitizedJsonReport({
        reportPath,
        destinationPath: options.outputPath,
        validateReport(_value, bytes) {
          sdkContract.contract.parsePlatformEvidence(
            bytes.toString('utf8'),
            'Chat retained schema-v2 platform evidence',
            sdkContract.schema,
          );
        },
        secretScan: ({ reportPath: scannedPath }) => {
          const contents = readFileSync(scannedPath, 'utf8');
          scanPhase1ArtifactText(contents, {
            validateReport() {
              sdkContract.contract.parsePlatformEvidence(
                contents,
                'Chat retained schema-v2 platform evidence',
                sdkContract.schema,
              );
            },
          });
        },
      });
      return evidence;
    }

    const reportPath = resolve(reportRoot.rootPath, 'report.json');
    writeFileSync(reportPath, `${JSON.stringify(completedReport, null, 2)}\n`, { mode: 0o600 });
    await reportRoot.retainSanitizedJsonReport({
      reportPath,
      destinationPath: options.retainSanitizedReport,
      secretScan: ({ artifactRoot }) => scanPhase1Artifacts({ artifactRoot }),
    });
    return completedReport;
  });

  if (infrastructureFailure !== undefined) {
    throw wrapInfrastructureFailure(infrastructureFailure, report);
  }
  return report;
}
