import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs';
import { devNull } from 'node:os';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultLockPath = resolve(projectRoot, 'phase1-conformance.lock.json');
const revisionPattern = /^[0-9a-f]{40}$/;
const legacyRepositoryKeys = ['chat', 'sdk', 'cave', 'coven'];
const repositoryKeys = ['validator', ...legacyRepositoryKeys];
const expectedRepositories = Object.freeze({
  validator: 'OpenCoven/sdk',
  chat: 'OpenCoven/chat',
  sdk: 'OpenCoven/sdk',
  cave: 'OpenCoven/coven-cave',
  coven: 'OpenCoven/coven',
});
const gitConfigurationOverrides = [
  '-c',
  'core.excludesFile=',
  '-c',
  `core.attributesFile=${devNull}`,
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.untrackedCache=false',
  '-c',
  'credential.helper=',
  '-c',
  `core.askPass=${devNull}`,
  '-c',
  `core.sshCommand=${devNull}`,
  '-c',
  'http.proxy=',
  '-c',
  'protocol.ext.allow=never',
  '-c',
  'core.checkStat=default',
  '-c',
  'core.trustctime=true',
  '-c',
  'core.symlinks=true',
  '-c',
  `core.fileMode=${process.platform === 'win32' ? 'false' : 'true'}`,
];
const defaultVerificationLimits = Object.freeze({
  repositoryDeadlineMs: 15_000,
  trackedEntryLimit: 100_000,
  trackedPathByteLimit: 16 * 1024 * 1024,
});
const gitChildMaxBuffer = 32 * 1024 * 1024;
const localMetadataMaxBytes = 64 * 1024;
const trackedAttributeBatchSize = 256;

export function createGitEnvironment(inheritedEnvironment = process.env) {
  const environment = {};

  for (const [key, value] of Object.entries(inheritedEnvironment)) {
    if (!key.toUpperCase().startsWith('GIT_') && value !== undefined) {
      environment[key] = value;
    }
  }

  environment.GIT_ATTR_NOSYSTEM = '1';
  environment.GIT_ATTR_SOURCE = 'HEAD';
  environment.GIT_ALLOW_PROTOCOL = '';
  environment.GIT_ASKPASS = devNull;
  environment.GIT_CONFIG_GLOBAL = devNull;
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_NO_LAZY_FETCH = '1';
  environment.GIT_NO_REPLACE_OBJECTS = '1';
  environment.GIT_OPTIONAL_LOCKS = '0';
  environment.GIT_SSH = devNull;
  environment.GIT_SSH_COMMAND = devNull;
  environment.GIT_TERMINAL_PROMPT = '0';
  environment.SSH_ASKPASS = devNull;
  return environment;
}

export function createGitCheckoutEnvironment(inheritedEnvironment = process.env) {
  const environment = createGitEnvironment(inheritedEnvironment);
  delete environment.GIT_ATTR_SOURCE;
  return environment;
}

function requireRecord(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }

  return value;
}

function requireExactKeys(value, expectedKeys, message) {
  const actualKeys = Object.keys(value);

  if (
    actualKeys.length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new Error(message);
  }
}

function requirePathString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty path string.`);
  }

  return resolve(value);
}

function requireExistingFile(value, label) {
  const path = requirePathString(value, `${label} path`);

  if (!existsSync(path)) {
    throw new Error(`${label} does not exist.`);
  }

  if (!statSync(path).isFile()) {
    throw new Error(`${label} must be a file.`);
  }

  return path;
}

function normalizeLockEntry(lockData, key, includeTree) {
  const entry = requireRecord(lockData[key], `phase1-conformance.lock.json ${key} entry`);
  const expectedKeys = includeTree
    ? ['repository', 'revision', 'tree']
    : ['repository', 'revision'];
  requireExactKeys(
    entry,
    expectedKeys,
    includeTree
      ? `phase1-conformance.lock.json ${key} entry must contain exactly repository, revision, and tree.`
      : `phase1-conformance.lock.json ${key} entry must contain exactly repository and revision.`,
  );

  const expectedRepository = expectedRepositories[key];
  if (entry.repository !== expectedRepository) {
    throw new Error(
      `phase1-conformance.lock.json ${key}.repository must be ${expectedRepository}.`,
    );
  }

  if (typeof entry.revision !== 'string' || !revisionPattern.test(entry.revision)) {
    throw new Error(
      `phase1-conformance.lock.json ${key}.revision must be a lowercase immutable 40-character commit SHA.`,
    );
  }
  if (includeTree && (typeof entry.tree !== 'string' || !revisionPattern.test(entry.tree))) {
    throw new Error(
      `phase1-conformance.lock.json ${key}.tree must be a lowercase immutable 40-character tree SHA.`,
    );
  }

  return Object.freeze({
    repository: expectedRepository,
    revision: entry.revision,
    ...(includeTree ? { tree: entry.tree } : {}),
  });
}

export function readPhase1ConformanceLock(lockPath = defaultLockPath) {
  const path = requireExistingFile(lockPath, 'Phase 1 conformance lock');
  let lockData;

  try {
    lockData = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error('phase1-conformance.lock.json must contain valid JSON.');
  }

  requireRecord(lockData, 'phase1-conformance.lock.json');
  if (lockData.version !== 1 && lockData.version !== 2) {
    throw new Error('phase1-conformance.lock.json version must be 1 or 2.');
  }
  const keys = lockData.version === 2 ? repositoryKeys : legacyRepositoryKeys;
  requireExactKeys(
    lockData,
    ['version', ...keys],
    lockData.version === 2
      ? 'phase1-conformance.lock.json must contain exactly version, validator, chat, sdk, cave, and coven.'
      : 'phase1-conformance.lock.json must contain exactly version, chat, sdk, cave, and coven.',
  );
  return Object.freeze({
    path,
    version: lockData.version,
    ...Object.fromEntries(
      keys.map((key) => [
        key,
        normalizeLockEntry(lockData, key, lockData.version === 2 && key !== 'validator'),
      ]),
    ),
  });
}

function normalizeCheckoutRoots(checkoutRoots) {
  const roots = requireRecord(checkoutRoots, 'Phase 1 checkout roots');
  const normalizedRoots = {};
  const keys = Object.hasOwn(roots, 'validatorRoot') ? repositoryKeys : legacyRepositoryKeys;

  for (const key of keys) {
    const label = `${key} checkout root`;
    const path = requirePathString(roots[`${key}Root`], label);

    if (!existsSync(path)) {
      throw new Error(`${label} does not exist.`);
    }

    if (!statSync(path).isDirectory()) {
      throw new Error(`${label} must be a directory.`);
    }

    normalizedRoots[key] = path;
  }

  return normalizedRoots;
}

function throwUnreadableGitCheckout(label) {
  throw new Error(`${label} is not a readable Git checkout.`);
}

function throwUnsafeVerificationEnvironment(label) {
  throw new Error(`${label} verification environment is unsafe.`);
}

function throwVerificationTimedOut(label) {
  throw new Error(`${label} verification timed out.`);
}

function throwTrackedPathLimits(label) {
  throw new Error(`${label} exceeds tracked path limits.`);
}

function createRepositoryVerificationContext(label, limits) {
  return {
    deadline: performance.now() + limits.repositoryDeadlineMs,
    label,
    limits,
  };
}

function remainingGitTimeout(context) {
  const remainingMilliseconds = Math.floor(context.deadline - performance.now());

  if (remainingMilliseconds <= 0) {
    throwVerificationTimedOut(context.label);
  }

  return remainingMilliseconds;
}

function createInertHooksDirectory(label) {
  let hooksPath;

  try {
    hooksPath = mkdtempSync(resolve(projectRoot, '.phase1-conformance-hooks-'));
    chmodSync(hooksPath, 0o700);
    const hooksStats = lstatSync(hooksPath);
    const ownedByProcess =
      typeof process.getuid !== 'function' || hooksStats.uid === process.getuid();

    if (
      !hooksStats.isDirectory() ||
      hooksStats.isSymbolicLink() ||
      (hooksStats.mode & 0o077) !== 0 ||
      !ownedByProcess ||
      readdirSync(hooksPath).length !== 0
    ) {
      throwUnsafeVerificationEnvironment(label);
    }
  } catch {
    if (hooksPath !== undefined) {
      rmSync(hooksPath, { force: true, recursive: true });
    }

    throwUnsafeVerificationEnvironment(label);
  }

  return hooksPath;
}

function runGit(repositoryRoot, args, context, input, trackedPathOutput = false) {
  const { label } = context;
  const hooksPath = createInertHooksDirectory(label);

  try {
    const timeout = remainingGitTimeout(context);
    return execFileSync(
      'git',
      [
        ...gitConfigurationOverrides,
        '-c',
        `core.hooksPath=${hooksPath}`,
        '-C',
        repositoryRoot,
        `--work-tree=${repositoryRoot}`,
        ...args,
      ],
      {
        encoding: 'utf8',
        env: createGitEnvironment(),
        input,
        maxBuffer: gitChildMaxBuffer,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        timeout,
        killSignal: 'SIGKILL',
      },
    );
  } catch (error) {
    if (error?.code === 'ETIMEDOUT' || performance.now() >= context.deadline) {
      throwVerificationTimedOut(label);
    }

    if (trackedPathOutput && error?.code === 'ENOBUFS') {
      throwTrackedPathLimits(label);
    }

    throwUnreadableGitCheckout(label);
  } finally {
    try {
      rmSync(hooksPath, { force: true, recursive: true });

      if (existsSync(hooksPath)) {
        throwUnsafeVerificationEnvironment(label);
      }
    } catch {
      throwUnsafeVerificationEnvironment(label);
    }
  }
}

function readGitStatus(repositoryRoot, context) {
  return runGit(
    repositoryRoot,
    [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=all',
      '--ignored=matching',
      '--ignore-submodules=none',
    ],
    context,
  );
}

function summarizeGitStatus(statusOutput) {
  const summary = {
    staged: 0,
    unstaged: 0,
    untracked: 0,
    ignored: 0,
  };
  const records = statusOutput.split('\0');

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 3) {
      continue;
    }

    const indexStatus = record[0];
    const worktreeStatus = record[1];

    if (indexStatus === '?' && worktreeStatus === '?') {
      summary.untracked += 1;
      continue;
    }
    if (indexStatus === '!' && worktreeStatus === '!') {
      summary.ignored += 1;
      continue;
    }

    if (indexStatus !== ' ' && indexStatus !== '?') {
      summary.staged += 1;
    }

    if (worktreeStatus !== ' ' && worktreeStatus !== '?') {
      summary.unstaged += 1;
    }

    if (
      indexStatus === 'R' ||
      indexStatus === 'C' ||
      worktreeStatus === 'R' ||
      worktreeStatus === 'C'
    ) {
      index += 1;
    }
  }

  return summary;
}

function formatBoundedCount(count, singular, plural) {
  const displayCount = count > 100 ? '100+' : String(count);
  return `${displayCount} ${count === 1 ? singular : plural}`;
}

function formatDirtySummary(summary) {
  const parts = [];

  if (summary.staged > 0) {
    parts.push(formatBoundedCount(summary.staged, 'staged change', 'staged changes'));
  }
  if (summary.unstaged > 0) {
    parts.push(formatBoundedCount(summary.unstaged, 'unstaged change', 'unstaged changes'));
  }
  if (summary.untracked > 0) {
    parts.push(formatBoundedCount(summary.untracked, 'untracked item', 'untracked items'));
  }
  if (summary.ignored > 0) {
    parts.push(formatBoundedCount(summary.ignored, 'ignored item', 'ignored items'));
  }

  return parts.join(', ');
}

function countReplacementRefs(repositoryRoot, context) {
  const output = runGit(
    repositoryRoot,
    ['for-each-ref', '--count=101', '--format=1', 'refs/replace'],
    context,
  ).trim();

  return output.length === 0 ? 0 : output.split('\n').length;
}

function assertNoReplacementRefs(repositoryRoot, context) {
  const count = countReplacementRefs(repositoryRoot, context);

  if (count > 0) {
    throw new Error(
      `${context.label} has ${formatBoundedCount(count, 'replacement ref', 'replacement refs')}.`,
    );
  }
}

function countHiddenIndexEntries(repositoryRoot, context) {
  const output = runGit(repositoryRoot, ['ls-files', '--cached', '-v', '-z'], context);
  let count = 0;

  for (const record of output.split('\0')) {
    const tag = record[0];

    if (tag === 'h' || tag === 'S' || tag === 's') {
      count += 1;

      if (count > 100) {
        return count;
      }
    }
  }

  return count;
}

function assertNoHiddenIndexEntries(repositoryRoot, context) {
  const count = countHiddenIndexEntries(repositoryRoot, context);

  if (count > 0) {
    throw new Error(
      `${context.label} has ${formatBoundedCount(
        count,
        'hidden index entry',
        'hidden index entries',
      )}.`,
    );
  }
}

function throwUnsafeLocalMetadata(label, metadataKind) {
  throw new Error(`${label} has unsafe local ${metadataKind} metadata.`);
}

function readLocalMetadata(repositoryRoot, context, gitPathName, metadataKind) {
  const { label } = context;
  const gitPathOutput = runGit(repositoryRoot, ['rev-parse', '--git-path', gitPathName], context);
  let gitPath = gitPathOutput.endsWith('\n') ? gitPathOutput.slice(0, -1) : gitPathOutput;

  if (gitPath.endsWith('\r')) {
    gitPath = gitPath.slice(0, -1);
  }

  if (gitPath.length === 0 || /[\0\r\n]/.test(gitPath)) {
    throwUnsafeLocalMetadata(label, metadataKind);
  }

  const metadataPath = resolve(repositoryRoot, gitPath);
  let pathStats;

  try {
    pathStats = lstatSync(metadataPath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return '';
    }

    throwUnsafeLocalMetadata(label, metadataKind);
  }

  if (pathStats.isSymbolicLink() || !pathStats.isFile() || (pathStats.mode & 0o444) === 0) {
    throwUnsafeLocalMetadata(label, metadataKind);
  }

  let descriptor;
  let contents;
  let unsafe = false;

  try {
    descriptor = openSync(metadataPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const openedStats = fstatSync(descriptor);

    if (
      !openedStats.isFile() ||
      openedStats.dev !== pathStats.dev ||
      openedStats.ino !== pathStats.ino ||
      openedStats.size > localMetadataMaxBytes
    ) {
      unsafe = true;
    } else {
      const buffer = Buffer.alloc(localMetadataMaxBytes + 1);
      let totalBytesRead = 0;

      while (totalBytesRead < buffer.length) {
        const bytesRead = readSync(
          descriptor,
          buffer,
          totalBytesRead,
          buffer.length - totalBytesRead,
          null,
        );

        if (bytesRead === 0) {
          break;
        }

        totalBytesRead += bytesRead;
      }

      if (totalBytesRead > localMetadataMaxBytes) {
        unsafe = true;
      } else {
        contents = buffer.subarray(0, totalBytesRead).toString('utf8');
      }
    }
  } catch {
    unsafe = true;
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        unsafe = true;
      }
    }
  }

  if (unsafe || contents === undefined) {
    throwUnsafeLocalMetadata(label, metadataKind);
  }

  return contents;
}

function countLocalRules(repositoryRoot, context, gitPathName, metadataKind) {
  const contents = readLocalMetadata(repositoryRoot, context, gitPathName, metadataKind);
  let count = 0;

  for (const rawLine of contents.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    if (line.startsWith('#') || /^[ \t]*$/.test(line)) {
      continue;
    }

    count += 1;

    if (count > 100) {
      return count;
    }
  }

  return count;
}

function assertNoLocalExcludeRules(repositoryRoot, context) {
  const count = countLocalRules(repositoryRoot, context, 'info/exclude', 'exclude');

  if (count > 0) {
    throw new Error(
      `${context.label} has ${formatBoundedCount(
        count,
        'local exclude rule',
        'local exclude rules',
      )}.`,
    );
  }
}

function assertNoLocalAttributeRules(repositoryRoot, context) {
  const count = countLocalRules(repositoryRoot, context, 'info/attributes', 'attribute');

  if (count > 0) {
    throw new Error(
      `${context.label} has ${formatBoundedCount(
        count,
        'local attribute rule',
        'local attribute rules',
      )}.`,
    );
  }
}

function collectTrackedFilterAttributes(
  repositoryRoot,
  context,
  trackedPaths,
  checkAttributeArgs,
  activePaths,
) {
  for (let offset = 0; offset < trackedPaths.length; offset += trackedAttributeBatchSize) {
    const pathBatch = trackedPaths.slice(offset, offset + trackedAttributeBatchSize);
    const output = runGit(repositoryRoot, checkAttributeArgs, context, `${pathBatch.join('\0')}\0`);
    const fields = output.split('\0');

    if (fields.at(-1) === '') {
      fields.pop();
    }

    if (fields.length !== pathBatch.length * 3) {
      throwUnreadableGitCheckout(context.label);
    }

    for (let index = 0; index < fields.length; index += 3) {
      if (fields[index + 1] !== 'filter') {
        throwUnreadableGitCheckout(context.label);
      }

      const value = fields[index + 2];
      if (value !== 'unspecified' && value !== 'unset') {
        activePaths.add(fields[index]);

        if (activePaths.size > 100) {
          return;
        }
      }
    }
  }
}

function splitNullDelimitedPaths(output) {
  return output.split('\0').filter((path) => path.length > 0);
}

function parseIndexEntries(output, label) {
  return splitNullDelimitedPaths(output).map((record) => {
    const tabOffset = record.indexOf('\t');
    const metadata = tabOffset === -1 ? [] : record.slice(0, tabOffset).split(' ');
    const path = tabOffset === -1 ? '' : record.slice(tabOffset + 1);

    if (
      metadata.length !== 3 ||
      !/^[0-7]{6}$/.test(metadata[0]) ||
      !/^[0-9a-f]{40,64}$/.test(metadata[1]) ||
      !/^[0-3]$/.test(metadata[2]) ||
      path.length === 0
    ) {
      throwUnreadableGitCheckout(label);
    }

    return {
      mode: metadata[0],
      objectId: metadata[1],
      path,
    };
  });
}

function parseHeadEntries(output, label) {
  return splitNullDelimitedPaths(output).map((record) => {
    const tabOffset = record.indexOf('\t');
    const metadata = tabOffset === -1 ? [] : record.slice(0, tabOffset).split(' ');
    const path = tabOffset === -1 ? '' : record.slice(tabOffset + 1);

    if (
      metadata.length !== 3 ||
      !/^[0-7]{6}$/.test(metadata[0]) ||
      metadata[1] !== 'blob' ||
      !/^[0-9a-f]{40,64}$/.test(metadata[2]) ||
      path.length === 0
    ) {
      throwUnreadableGitCheckout(label);
    }

    return {
      mode: metadata[0],
      objectId: metadata[2],
      path,
    };
  });
}

function assertTrackedPathLimits(entries, context) {
  if (entries.length > context.limits.trackedEntryLimit) {
    throwTrackedPathLimits(context.label);
  }

  let totalPathBytes = 0;

  for (const entry of entries) {
    totalPathBytes += Buffer.byteLength(entry.path);

    if (totalPathBytes > context.limits.trackedPathByteLimit) {
      throwTrackedPathLimits(context.label);
    }
  }
}

function readTrackedEntries(repositoryRoot, context) {
  const { label } = context;
  const indexEntries = parseIndexEntries(
    runGit(repositoryRoot, ['ls-files', '--cached', '--stage', '-z'], context, undefined, true),
    label,
  );
  assertTrackedPathLimits(indexEntries, context);
  let submoduleCount = 0;

  for (const entry of indexEntries) {
    if (entry.mode === '160000') {
      submoduleCount += 1;

      if (submoduleCount > 100) {
        break;
      }
    }
  }

  if (submoduleCount > 0) {
    throw new Error(
      `${label} has ${formatBoundedCount(submoduleCount, 'submodule entry', 'submodule entries')}.`,
    );
  }

  const headEntries = parseHeadEntries(
    runGit(repositoryRoot, ['ls-tree', '-r', '-z', 'HEAD'], context, undefined, true),
    label,
  );
  assertTrackedPathLimits(headEntries, context);
  const objectIds = [...new Set([...indexEntries, ...headEntries].map((entry) => entry.objectId))];

  if (objectIds.length > 0) {
    const output = runGit(
      repositoryRoot,
      ['cat-file', '--batch-check=%(objectname) %(objecttype)'],
      context,
      `${objectIds.join('\n')}\n`,
    );
    const records = output.trimEnd().split('\n');

    if (
      records.length !== objectIds.length ||
      records.some((record, index) => record !== `${objectIds[index]} blob`)
    ) {
      throwUnreadableGitCheckout(label);
    }
  }

  return {
    indexPaths: indexEntries.map((entry) => entry.path),
    headPaths: headEntries.map((entry) => entry.path),
  };
}

function countTrackedFilterAttributes(repositoryRoot, context, trackedEntries) {
  const activePaths = new Set();
  collectTrackedFilterAttributes(
    repositoryRoot,
    context,
    trackedEntries.indexPaths,
    ['check-attr', '--cached', '-z', 'filter', '--stdin'],
    activePaths,
  );

  if (activePaths.size <= 100) {
    collectTrackedFilterAttributes(
      repositoryRoot,
      context,
      trackedEntries.headPaths,
      ['check-attr', '-z', 'filter', '--stdin'],
      activePaths,
    );
  }

  return activePaths.size;
}

function assertNoTrackedFilterAttributes(repositoryRoot, context, trackedEntries) {
  const count = countTrackedFilterAttributes(repositoryRoot, context, trackedEntries);

  if (count > 0) {
    throw new Error(
      `${context.label} has ${formatBoundedCount(
        count,
        'tracked entry with an active filter attribute',
        'tracked entries with active filter attributes',
      )}.`,
    );
  }
}

function assertCleanCheckout(repositoryRoot, context) {
  const summary = summarizeGitStatus(readGitStatus(repositoryRoot, context));

  if (
    summary.staged !== 0 ||
    summary.unstaged !== 0 ||
    summary.untracked !== 0 ||
    summary.ignored !== 0
  ) {
    throw new Error(`${context.label} is dirty (${formatDirtySummary(summary)}).`);
  }

  return summary;
}

function assertCleanPhase1CheckoutsWithLimits(checkoutRoots, limits) {
  const roots = normalizeCheckoutRoots(checkoutRoots);
  const summaries = {};

  for (const key of Object.keys(roots)) {
    const label = `${key} checkout`;
    const context = createRepositoryVerificationContext(label, limits);
    assertNoLocalExcludeRules(roots[key], context);
    assertNoLocalAttributeRules(roots[key], context);
    assertNoReplacementRefs(roots[key], context);
    assertNoHiddenIndexEntries(roots[key], context);
    const trackedEntries = readTrackedEntries(roots[key], context);
    assertNoTrackedFilterAttributes(roots[key], context, trackedEntries);
    summaries[key] = assertCleanCheckout(roots[key], context);
  }

  return summaries;
}

export function assertCleanPhase1Checkouts(checkoutRoots) {
  return assertCleanPhase1CheckoutsWithLimits(checkoutRoots, defaultVerificationLimits);
}

export function assertCleanPhase1Checkout(repositoryRoot, label = 'checkout') {
  const root = requirePathString(repositoryRoot, `${label} root`);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error(`${label} root must be a directory.`);
  }
  const context = createRepositoryVerificationContext(label, defaultVerificationLimits);
  assertNoLocalExcludeRules(root, context);
  assertNoLocalAttributeRules(root, context);
  assertNoReplacementRefs(root, context);
  assertNoHiddenIndexEntries(root, context);
  const trackedEntries = readTrackedEntries(root, context);
  assertNoTrackedFilterAttributes(root, context, trackedEntries);
  return assertCleanCheckout(root, context);
}

export function readPhase1CheckoutIdentity(repositoryRoot, label = 'checkout') {
  const root = requirePathString(repositoryRoot, `${label} root`);
  const context = createRepositoryVerificationContext(label, defaultVerificationLimits);
  const revision = runGit(root, ['rev-parse', 'HEAD'], context).trim();
  const tree = runGit(root, ['rev-parse', 'HEAD^{tree}'], context).trim();
  if (!revisionPattern.test(revision) || !revisionPattern.test(tree)) {
    throw new Error(`${label} does not have a canonical commit and tree identity.`);
  }
  return Object.freeze({ revision, tree });
}

function requireLockedRevision(lock, key) {
  const lockData = requireRecord(lock, 'Phase 1 conformance lock');
  const entry = requireRecord(lockData[key], `Phase 1 conformance lock ${key} entry`);

  if (typeof entry.revision !== 'string' || !revisionPattern.test(entry.revision)) {
    throw new Error(`Phase 1 conformance lock ${key} revision is invalid.`);
  }

  if (
    lockData.version === 2 &&
    key !== 'validator' &&
    (typeof entry.tree !== 'string' || !revisionPattern.test(entry.tree))
  ) {
    throw new Error(`Phase 1 conformance lock ${key} tree is invalid.`);
  }

  return {
    revision: entry.revision,
    tree: entry.tree,
  };
}

function assertPhase1CheckoutHeadsWithLimits(lock, checkoutRoots, limits) {
  const roots = normalizeCheckoutRoots(checkoutRoots);
  const revisions = {};
  const lockData = requireRecord(lock, 'Phase 1 conformance lock');
  const keys = lockData.version === 2 ? repositoryKeys : legacyRepositoryKeys;

  for (const key of keys) {
    const expected = requireLockedRevision(lockData, key);
    const label = `${key} checkout`;
    const context = createRepositoryVerificationContext(label, limits);
    assertNoLocalExcludeRules(roots[key], context);
    assertNoLocalAttributeRules(roots[key], context);
    assertNoReplacementRefs(roots[key], context);
    assertNoHiddenIndexEntries(roots[key], context);
    const trackedEntries = readTrackedEntries(roots[key], context);
    assertNoTrackedFilterAttributes(roots[key], context, trackedEntries);
    assertCleanCheckout(roots[key], context);
    const actualRevision = runGit(roots[key], ['rev-parse', 'HEAD'], context).trim();

    if (actualRevision !== expected.revision) {
      throw new Error(
        `${key} checkout HEAD ${actualRevision} does not match expected ${expected.revision}.`,
      );
    }
    if (expected.tree !== undefined) {
      const actualTree = runGit(roots[key], ['rev-parse', 'HEAD^{tree}'], context).trim();
      if (actualTree !== expected.tree) {
        throw new Error(
          `${key} checkout tree ${actualTree} does not match expected ${expected.tree}.`,
        );
      }
    }

    revisions[key] = actualRevision;
  }

  return revisions;
}

export function assertPhase1CheckoutHeads(lock, checkoutRoots) {
  return assertPhase1CheckoutHeadsWithLimits(lock, checkoutRoots, defaultVerificationLimits);
}

function createTestVerificationLimits(options) {
  const overrides =
    options !== null && typeof options === 'object' && !Array.isArray(options)
      ? options.limits
      : undefined;
  const limits = {
    ...defaultVerificationLimits,
    ...(overrides ?? {}),
  };

  if (
    !Number.isSafeInteger(limits.repositoryDeadlineMs) ||
    limits.repositoryDeadlineMs <= 0 ||
    !Number.isSafeInteger(limits.trackedEntryLimit) ||
    limits.trackedEntryLimit < 0 ||
    !Number.isSafeInteger(limits.trackedPathByteLimit) ||
    limits.trackedPathByteLimit < 0
  ) {
    throw new Error('Phase 1 conformance test limits are invalid.');
  }

  return Object.freeze(limits);
}

export const phase1ConformanceTestOnly = Object.freeze({
  assertCleanPhase1Checkouts(checkoutRoots, options) {
    return assertCleanPhase1CheckoutsWithLimits(
      checkoutRoots,
      createTestVerificationLimits(options),
    );
  },
  assertPhase1CheckoutHeads(lock, checkoutRoots, options) {
    return assertPhase1CheckoutHeadsWithLimits(
      lock,
      checkoutRoots,
      createTestVerificationLimits(options),
    );
  },
});
