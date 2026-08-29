import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { devNull } from 'node:os';
import { delimiter, dirname, isAbsolute, relative, resolve } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import * as phase1ConformanceLock from '../scripts/phase1-conformance-lock.mjs';

const {
  assertCleanPhase1Checkouts,
  assertPhase1CheckoutHeads,
  createGitEnvironment,
  phase1ConformanceTestOnly,
  readPhase1ConformanceLock,
} = phase1ConformanceLock;

const projectRoot = resolve(import.meta.dirname, '..');
const scratchRoots: string[] = [];
const gitIntegrationTestTimeout = 60_000;
const gitTestCommandTimeout = 45_000;
const gitTestMaxBuffer = 16 * 1024 * 1024;
const repositoryKeys = ['chat', 'sdk', 'cave', 'coven'] as const;
const hiddenIndexStates = [
  ['assume-unchanged', '--assume-unchanged'],
  ['skip-worktree', '--skip-worktree'],
] as const;
type RepositoryKey = (typeof repositoryKeys)[number];
type CheckoutRoots = {
  chatRoot: string;
  sdkRoot: string;
  caveRoot: string;
  covenRoot: string;
};

function supportsFileSymlinks() {
  const scratchParent = resolve(projectRoot, 'test-results', 'vitest', 'phase1-conformance');
  mkdirSync(scratchParent, { recursive: true });
  const probeRoot = mkdtempSync(resolve(scratchParent, 'symlink-probe-'));

  try {
    const targetPath = resolve(probeRoot, 'target');
    writeFileSync(targetPath, 'target\n');
    symlinkSync(targetPath, resolve(probeRoot, 'link'), 'file');
    return true;
  } catch (error) {
    if (
      error !== null &&
      typeof error === 'object' &&
      'code' in error &&
      ['EACCES', 'ENOSYS', 'EPERM', 'UNKNOWN'].includes(String(error.code))
    ) {
      return false;
    }

    throw error;
  } finally {
    rmSync(probeRoot, { force: true, recursive: true });
  }
}

const fileSymlinksSupported = supportsFileSymlinks();

const expectedEntries = {
  chat: {
    repository: 'OpenCoven/chat',
    revision: '20633346c444ded9e05ca5a3db45d74c28918d69',
  },
  sdk: {
    repository: 'OpenCoven/sdk',
    revision: 'acc38488f00860d246c3c553375634d64806eabb',
  },
  cave: {
    repository: 'OpenCoven/coven-cave',
    revision: 'e74078a147c084bd761d929654f0990df66ef99f',
  },
  coven: {
    repository: 'OpenCoven/coven',
    revision: '721437b84026c042e431b0882dcd14fdb29ac07d',
  },
} as const;

function gitTest(name: string, operation: () => void) {
  test(name, operation, gitIntegrationTestTimeout);
}

afterEach(() => {
  while (scratchRoots.length > 0) {
    const scratchRoot = scratchRoots.pop();

    if (scratchRoot !== undefined) {
      rmSync(scratchRoot, { force: true, recursive: true });
    }
  }
});

function runGit(args: string[], cwd: string, input?: string) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: createTestGitEnvironment(),
    input,
    maxBuffer: gitTestMaxBuffer,
    stdio: 'pipe',
    timeout: gitTestCommandTimeout,
    killSignal: 'SIGKILL',
  }).trim();
}

function readLocalExcludePath(repositoryRoot: string) {
  return runGit(
    ['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'],
    repositoryRoot,
  );
}

function readLocalAttributesPath(repositoryRoot: string) {
  return runGit(
    ['rev-parse', '--path-format=absolute', '--git-path', 'info/attributes'],
    repositoryRoot,
  );
}

function runGitWithHostConfiguration(args: string[], cwd: string) {
  const environment: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith('GIT_') && value !== undefined) {
      environment[key] = value;
    }
  }

  environment.GIT_TERMINAL_PROMPT = '0';
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: environment,
    maxBuffer: gitTestMaxBuffer,
    stdio: 'pipe',
    timeout: gitTestCommandTimeout,
    killSignal: 'SIGKILL',
  }).trim();
}

function createTestGitEnvironment() {
  const environment: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith('GIT_') && value !== undefined) {
      environment[key] = value;
    }
  }

  environment.GIT_ATTR_NOSYSTEM = '1';
  environment.GIT_CONFIG_GLOBAL = devNull;
  environment.GIT_CONFIG_NOSYSTEM = '1';
  environment.GIT_NO_REPLACE_OBJECTS = '1';
  environment.GIT_TERMINAL_PROMPT = '0';
  return environment;
}

function createHostileGlobalGitConfig(source: 'HOME' | 'XDG_CONFIG_HOME', ignoredName: string) {
  const hostileRoot = createScratchRoot(`hostile-${source.toLowerCase()}`);
  const homeRoot = resolve(hostileRoot, 'home');
  const xdgRoot = resolve(hostileRoot, 'xdg');
  const excludesPath = resolve(hostileRoot, 'global-excludes');
  const configPath =
    source === 'HOME' ? resolve(homeRoot, '.gitconfig') : resolve(xdgRoot, 'git', 'config');

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(excludesPath, `${ignoredName}\n`);
  runGit(['config', '--file', configPath, 'core.excludesFile', excludesPath], projectRoot);

  return {
    configPath,
    environment: {
      HOME: homeRoot,
      XDG_CONFIG_HOME: xdgRoot,
    },
    excludesPath,
  };
}

function configureHostileCleanFilter(repositoryRoot: string, markerPath: string) {
  const filterPath = resolve(createScratchRoot('hostile-filter'), 'filter.mjs');
  writeFileSync(
    filterPath,
    `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(markerPath)}, 'executed\\n');
process.stdin.on('end', () => process.stdout.write('chat baseline\\n'));
process.stdin.resume();
`,
  );
  chmodSync(filterPath, 0o755);
  runGit(
    [
      'config',
      '--local',
      'filter.hostile.clean',
      `${JSON.stringify(process.execPath)} ${JSON.stringify(filterPath)}`,
    ],
    repositoryRoot,
  );
}

function lockChatAtHead(fixture: ReturnType<typeof createCheckoutFixture>, revision: string) {
  return {
    ...fixture.lock,
    chat: {
      repository: expectedEntries.chat.repository,
      revision,
    },
  };
}

function withTemporaryProcessEnv<T>(
  updates: Record<string, string | undefined>,
  operation: () => T,
) {
  const originalEntries = Object.entries(process.env);

  try {
    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }

    return operation();
  } finally {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    for (const [key, value] of originalEntries) {
      process.env[key] = value;
    }
  }
}

function createScratchRoot(prefix: string) {
  const scratchParent = resolve(projectRoot, 'test-results', 'vitest', 'phase1-conformance');
  mkdirSync(scratchParent, { recursive: true });
  const scratchRoot = mkdtempSync(resolve(scratchParent, `${prefix}-`));
  scratchRoots.push(scratchRoot);
  return scratchRoot;
}

function writeLock(lockData: unknown) {
  const lockPath = resolve(createScratchRoot('lock'), 'phase1-conformance.lock.json');
  writeFileSync(lockPath, `${JSON.stringify(lockData, null, 2)}\n`);
  return lockPath;
}

function createCheckoutFixture() {
  const root = createScratchRoot('checkouts');
  const roots = {} as CheckoutRoots;
  const revisions = {} as Record<RepositoryKey, string>;

  for (const key of repositoryKeys) {
    const repositoryRoot = resolve(root, key);
    mkdirSync(repositoryRoot, { recursive: true });
    runGit(['init', '--initial-branch=main'], repositoryRoot);
    const hooksPath = resolve(repositoryRoot, '.git', 'fixture-hooks');
    mkdirSync(hooksPath, { recursive: true });
    runGit(['config', '--local', 'commit.gpgSign', 'false'], repositoryRoot);
    runGit(['config', '--local', 'core.hooksPath', hooksPath], repositoryRoot);
    runGit(['config', 'user.name', 'OpenCoven Test'], repositoryRoot);
    runGit(['config', 'user.email', 'opencoven-test@example.com'], repositoryRoot);
    writeFileSync(resolve(repositoryRoot, 'tracked.txt'), `${key} baseline\n`);
    runGit(['add', 'tracked.txt'], repositoryRoot);
    runGit(['commit', '-m', `${key} baseline`], repositoryRoot);
    roots[`${key}Root`] = repositoryRoot;
    revisions[key] = runGit(['rev-parse', 'HEAD'], repositoryRoot);
  }

  return {
    roots,
    revisions,
    lock: {
      version: 1,
      ...Object.fromEntries(
        repositoryKeys.map((key) => [
          key,
          {
            repository: expectedEntries[key].repository,
            revision: revisions[key],
          },
        ]),
      ),
    },
  };
}

describe('Phase 1 conformance lock', () => {
  test('reads the immutable reviewed revisions into an exact normalized lock', () => {
    expect(readPhase1ConformanceLock()).toEqual({
      path: resolve(projectRoot, 'phase1-conformance.lock.json'),
      version: 1,
      ...expectedEntries,
    });
  });

  test('rejects an unexpected repository', () => {
    const lockPath = writeLock({
      version: 1,
      ...expectedEntries,
      sdk: {
        ...expectedEntries.sdk,
        repository: 'OpenCoven/not-sdk',
      },
    });

    expect(() => readPhase1ConformanceLock(lockPath)).toThrow(
      'phase1-conformance.lock.json sdk.repository must be OpenCoven/sdk.',
    );
  });

  test.each([
    [
      'missing top-level key',
      {
        version: 1,
        chat: expectedEntries.chat,
        sdk: expectedEntries.sdk,
        cave: expectedEntries.cave,
      },
      'must contain exactly version, chat, sdk, cave, and coven',
    ],
    [
      'extra top-level key',
      { version: 1, ...expectedEntries, extra: true },
      'must contain exactly version, chat, sdk, cave, and coven',
    ],
    [
      'missing entry key',
      {
        version: 1,
        ...expectedEntries,
        chat: { repository: expectedEntries.chat.repository },
      },
      'chat entry must contain exactly repository and revision',
    ],
    [
      'extra entry key',
      {
        version: 1,
        ...expectedEntries,
        chat: { ...expectedEntries.chat, branch: 'main' },
      },
      'chat entry must contain exactly repository and revision',
    ],
  ])('rejects a %s', (_label, lockData, expectedMessage) => {
    expect(() => readPhase1ConformanceLock(writeLock(lockData))).toThrow(expectedMessage);
  });

  test.each([
    ['uppercase', expectedEntries.chat.revision.toUpperCase()],
    ['short', expectedEntries.chat.revision.slice(0, -1)],
  ])('rejects a %s revision', (_label, revision) => {
    const lockPath = writeLock({
      version: 1,
      ...expectedEntries,
      chat: { ...expectedEntries.chat, revision },
    });

    expect(() => readPhase1ConformanceLock(lockPath)).toThrow(
      'chat.revision must be a lowercase immutable 40-character commit SHA.',
    );
  });

  test('rejects missing and non-path lock inputs explicitly', () => {
    expect(() => readPhase1ConformanceLock(null as never)).toThrow(
      'Phase 1 conformance lock path must be a non-empty path string.',
    );
    expect(() =>
      readPhase1ConformanceLock(resolve(projectRoot, 'missing-phase1-lock.json')),
    ).toThrow('Phase 1 conformance lock does not exist.');
  });
});

describe('Phase 1 checkout verification', () => {
  test('sanitizes inherited Git variables case-insensitively for verifier children', () => {
    const environment = createGitEnvironment({
      PATH: process.env.PATH,
      HOME: '/safe-home',
      GIT_DIR: '/hostile/git-dir',
      Git_Work_Tree: '/hostile/work-tree',
      git_index_file: '/hostile/index',
    });

    expect(environment.PATH).toBe(process.env.PATH);
    expect(environment.HOME).toBe('/safe-home');
    expect(environment).not.toHaveProperty('GIT_DIR');
    expect(environment).not.toHaveProperty('Git_Work_Tree');
    expect(environment).not.toHaveProperty('git_index_file');
    expect(environment.GIT_ALLOW_PROTOCOL).toBe('');
    expect(environment.GIT_ASKPASS).toBe(devNull);
    expect(environment.GIT_ATTR_NOSYSTEM).toBe('1');
    expect(environment.GIT_ATTR_SOURCE).toBe('HEAD');
    expect(environment.GIT_CONFIG_GLOBAL).toBe(devNull);
    expect(environment.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(environment.GIT_NO_LAZY_FETCH).toBe('1');
    expect(environment.GIT_NO_REPLACE_OBJECTS).toBe('1');
    expect(environment.GIT_OPTIONAL_LOCKS).toBe('0');
    expect(environment.GIT_SSH).toBe(devNull);
    expect(environment.GIT_SSH_COMMAND).toBe(devNull);
    expect(environment.GIT_TERMINAL_PROMPT).toBe('0');
    expect(environment.SSH_ASKPASS).toBe(devNull);
  });

  gitTest('accepts four clean checkouts at their locked revisions', () => {
    const fixture = createCheckoutFixture();

    expect(assertCleanPhase1Checkouts(fixture.roots)).toEqual({
      chat: { staged: 0, unstaged: 0, untracked: 0 },
      sdk: { staged: 0, unstaged: 0, untracked: 0 },
      cave: { staged: 0, unstaged: 0, untracked: 0 },
      coven: { staged: 0, unstaged: 0, untracked: 0 },
    });
    expect(assertPhase1CheckoutHeads(fixture.lock, fixture.roots)).toEqual(fixture.revisions);
  });

  gitTest('does not refresh the index or execute local hooks during verification', () => {
    const fixture = createCheckoutFixture();
    const repositoryRoot = fixture.roots.chatRoot;
    const hooksPath = runGit(['config', '--local', '--get', 'core.hooksPath'], repositoryRoot);
    const markerPath = resolve(createScratchRoot('post-index-change-canary'), 'hook-ran');
    const hookPath = resolve(hooksPath, 'post-index-change');
    writeFileSync(
      hookPath,
      `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(markerPath)}, 'executed\\n');
`,
    );
    chmodSync(hookPath, 0o755);

    const trackedPath = resolve(repositoryRoot, 'tracked.txt');
    const originalContent = readFileSync(trackedPath);
    writeFileSync(trackedPath, originalContent);
    const touchedTime = new Date(Date.now() + 2_000);
    utimesSync(trackedPath, touchedTime, touchedTime);

    expect(assertCleanPhase1Checkouts(fixture.roots).chat).toEqual({
      staged: 0,
      unstaged: 0,
      untracked: 0,
    });
    expect(existsSync(markerPath)).toBe(false);
    expect(assertPhase1CheckoutHeads(fixture.lock, fixture.roots).chat).toBe(
      fixture.revisions.chat,
    );
    expect(existsSync(markerPath)).toBe(false);
  });

  test.skipIf(process.platform === 'win32')(
    'fails safely instead of lazily fetching a missing promised attribute blob',
    () => {
      const fixture = createCheckoutFixture();
      const repositoryRoot = fixture.roots.chatRoot;
      writeFileSync(resolve(repositoryRoot, '.gitattributes'), 'tracked.txt text\n');
      runGit(['add', '.gitattributes'], repositoryRoot);
      runGit(['commit', '-m', 'add promised attribute fixture'], repositoryRoot);
      const lock = lockChatAtHead(fixture, runGit(['rev-parse', 'HEAD'], repositoryRoot));
      const missingBlob = runGit(['rev-parse', 'HEAD:.gitattributes'], repositoryRoot);
      const objectPath = resolve(
        repositoryRoot,
        '.git',
        'objects',
        missingBlob.slice(0, 2),
        missingBlob.slice(2),
      );
      expect(existsSync(objectPath)).toBe(true);

      const hostileRoot = createScratchRoot('promisor-upload-pack');
      const markerPath = resolve(hostileRoot, 'upload-pack-ran');
      const uploadPackPath = resolve(hostileRoot, 'upload-pack');
      writeFileSync(
        uploadPackPath,
        `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(markerPath)}, 'executed\\n');
process.exit(1);
`,
      );
      chmodSync(uploadPackPath, 0o755);
      runGit(['config', '--local', 'remote.origin.url', fixture.roots.sdkRoot], repositoryRoot);
      runGit(['config', '--local', 'remote.origin.promisor', 'true'], repositoryRoot);
      runGit(
        ['config', '--local', 'remote.origin.partialclonefilter', 'blob:none'],
        repositoryRoot,
      );
      runGit(['config', '--local', 'remote.origin.uploadpack', uploadPackPath], repositoryRoot);
      rmSync(objectPath);

      for (const verify of [
        () => assertCleanPhase1Checkouts(fixture.roots),
        () => assertPhase1CheckoutHeads(lock, fixture.roots),
      ]) {
        expect(verify).toThrow('chat checkout is not a readable Git checkout.');
        expect(existsSync(markerPath)).toBe(false);
      }
    },
    gitIntegrationTestTimeout,
  );

  test.skipIf(process.platform === 'win32')(
    'SIGKILLs and reaps a hung Git child that ignores SIGTERM',
    () => {
      const fixture = createCheckoutFixture();
      const fakeBin = createScratchRoot('hung-git');
      const fakeGitPath = resolve(fakeBin, 'git');
      const childPidPath = resolve(fakeBin, 'git.pid');
      const secretDiagnostic = 'do-not-leak-hung-git-details';
      writeFileSync(
        fakeGitPath,
        `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(childPidPath)}, String(process.pid));
process.on('SIGTERM', () => {});
process.stderr.write(${JSON.stringify(secretDiagnostic)});
setTimeout(() => process.exit(86), 30_000);
setInterval(() => {}, 1_000);
`,
      );
      chmodSync(fakeGitPath, 0o755);

      const startedAt = Date.now();
      let message = '';

      withTemporaryProcessEnv(
        {
          PATH: `${fakeBin}${delimiter}${process.env.PATH ?? ''}`,
        },
        () => {
          try {
            assertCleanPhase1Checkouts(fixture.roots);
          } catch (error) {
            message = error instanceof Error ? error.message : String(error);
          }
        },
      );

      const childPid = Number.parseInt(readFileSync(childPidPath, 'utf8'), 10);
      expect(Date.now() - startedAt).toBeLessThan(25_000);
      expect(Number.isSafeInteger(childPid)).toBe(true);
      expect(() => process.kill(childPid, 0)).toThrow(
        expect.objectContaining({
          code: 'ESRCH',
        }),
      );
      expect(message).toBe('chat checkout verification timed out.');
      expect(message).not.toContain(secretDiagnostic);
      expect(message).not.toContain(fakeGitPath);
      expect(message).not.toContain(fixture.roots.chatRoot);
    },
    40_000,
  );

  gitTest('isolates fixture commits from inherited signing and hooks', () => {
    const fixture = createCheckoutFixture();

    for (const key of repositoryKeys) {
      const repositoryRoot = fixture.roots[`${key}Root`];
      const hooksPath = runGit(['config', '--local', '--get', 'core.hooksPath'], repositoryRoot);

      expect(runGit(['config', '--local', '--get', 'commit.gpgSign'], repositoryRoot)).toBe(
        'false',
      );
      expect(isAbsolute(hooksPath)).toBe(true);
      expect(relative(repositoryRoot, hooksPath).startsWith('..')).toBe(false);
      expect(readdirSync(hooksPath)).toEqual([]);
    }
  });

  gitTest('creates isolated fixture commits despite hostile command-scope Git config', () => {
    const hostileRoot = createScratchRoot('hostile-git-config');
    const hostileHooksPath = resolve(hostileRoot, 'hooks');
    const hostileHookMarker = resolve(hostileRoot, 'hook-ran');
    mkdirSync(hostileHooksPath);
    const hostileHookPath = resolve(hostileHooksPath, 'pre-commit');
    writeFileSync(hostileHookPath, `#!/bin/sh\ntouch '${hostileHookMarker}'\nexit 1\n`);
    chmodSync(hostileHookPath, 0o755);

    const fixture = withTemporaryProcessEnv(
      {
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'commit.gpgSign',
        GIT_CONFIG_VALUE_0: 'true',
        GIT_CONFIG_KEY_1: 'core.hooksPath',
        GIT_CONFIG_VALUE_1: hostileHooksPath,
      },
      () => createCheckoutFixture(),
    );

    expect(existsSync(hostileHookMarker)).toBe(false);
    for (const key of repositoryKeys) {
      const repositoryRoot = fixture.roots[`${key}Root`];
      const hooksPath = runGit(['config', '--local', '--get', 'core.hooksPath'], repositoryRoot);

      expect(runGit(['config', '--local', '--get', 'commit.gpgSign'], repositoryRoot)).toBe(
        'false',
      );
      expect(isAbsolute(hooksPath)).toBe(true);
      expect(relative(repositoryRoot, hooksPath).startsWith('..')).toBe(false);
      expect(readdirSync(hooksPath)).toEqual([]);
    }
  });

  gitTest('does not let GIT_DIR and GIT_WORK_TREE redirect clean-checkout verification', () => {
    const fixture = createCheckoutFixture();
    appendFileSync(resolve(fixture.roots.chatRoot, 'tracked.txt'), 'private dirty content\n');

    withTemporaryProcessEnv(
      {
        GIT_DIR: resolve(fixture.roots.sdkRoot, '.git'),
        GIT_WORK_TREE: fixture.roots.sdkRoot,
      },
      () => {
        expect(() => assertCleanPhase1Checkouts(fixture.roots)).toThrow(
          'chat checkout is dirty (1 unstaged change).',
        );
      },
    );
  });

  gitTest('does not let GIT_DIR and GIT_WORK_TREE redirect HEAD verification', () => {
    const fixture = createCheckoutFixture();
    const redirectedLock = {
      ...fixture.lock,
      ...Object.fromEntries(
        repositoryKeys.map((key) => [
          key,
          {
            repository: expectedEntries[key].repository,
            revision: fixture.revisions.sdk,
          },
        ]),
      ),
    };

    withTemporaryProcessEnv(
      {
        GIT_DIR: resolve(fixture.roots.sdkRoot, '.git'),
        GIT_WORK_TREE: fixture.roots.sdkRoot,
      },
      () => {
        expect(() => assertPhase1CheckoutHeads(redirectedLock, fixture.roots)).toThrow(
          `chat checkout HEAD ${fixture.revisions.chat} does not match expected ${fixture.revisions.sdk}.`,
        );
      },
    );
  });

  test.each(['normal', 'linked'] as const)(
    'pins the supplied %s worktree despite a local core.worktree redirect',
    (checkoutKind) => {
      const fixture = createCheckoutFixture();
      let repositoryRoot = fixture.roots.chatRoot;

      if (checkoutKind === 'linked') {
        const linkedParent = createScratchRoot('linked-worktree');
        repositoryRoot = resolve(linkedParent, 'chat-linked');
        runGit(
          ['worktree', 'add', '--detach', repositoryRoot, fixture.revisions.chat],
          fixture.roots.chatRoot,
        );
      }

      const alternateRoot = resolve(createScratchRoot('alternate-worktree'), 'clean');
      mkdirSync(alternateRoot);
      writeFileSync(resolve(alternateRoot, 'tracked.txt'), 'chat baseline\n');

      if (checkoutKind === 'linked') {
        runGit(['config', '--local', 'extensions.worktreeConfig', 'true'], fixture.roots.chatRoot);
        runGit(['config', '--worktree', 'core.worktree', alternateRoot], repositoryRoot);
      } else {
        runGit(['config', '--local', 'core.worktree', alternateRoot], repositoryRoot);
      }

      appendFileSync(resolve(repositoryRoot, 'tracked.txt'), 'private supplied-root content\n');
      const roots = {
        ...fixture.roots,
        chatRoot: repositoryRoot,
      };

      expect(runGit(['status', '--porcelain=v1'], repositoryRoot)).toBe('');
      expect(runGit(['rev-parse', 'HEAD'], repositoryRoot)).toBe(fixture.revisions.chat);

      const messages = [
        () => assertCleanPhase1Checkouts(roots),
        () => assertPhase1CheckoutHeads(fixture.lock, roots),
      ].map((verify) => {
        try {
          verify();
          return '';
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      });

      expect(messages).toEqual([
        'chat checkout is dirty (1 unstaged change).',
        'chat checkout is dirty (1 unstaged change).',
      ]);
      expect(messages.join('\n')).not.toContain('tracked.txt');
      expect(messages.join('\n')).not.toContain('private supplied-root content');
      expect(messages.join('\n')).not.toContain(alternateRoot);
      expect(messages.join('\n')).not.toContain(repositoryRoot);
    },
    gitIntegrationTestTimeout,
  );

  gitTest('allows comment-only local exclude metadata', () => {
    const fixture = createCheckoutFixture();
    const excludePath = readLocalExcludePath(fixture.roots.chatRoot);
    writeFileSync(excludePath, '# local comments are allowed\n\n   \n# another comment\n');

    expect(assertCleanPhase1Checkouts(fixture.roots)).toEqual({
      chat: { staged: 0, unstaged: 0, untracked: 0 },
      sdk: { staged: 0, unstaged: 0, untracked: 0 },
      cave: { staged: 0, unstaged: 0, untracked: 0 },
      coven: { staged: 0, unstaged: 0, untracked: 0 },
    });
    expect(assertPhase1CheckoutHeads(fixture.lock, fixture.roots)).toEqual(fixture.revisions);
  });

  test.each(['normal', 'linked'] as const)(
    'rejects active local exclude rules in a %s worktree on both verification paths',
    (checkoutKind) => {
      const fixture = createCheckoutFixture();
      let repositoryRoot = fixture.roots.chatRoot;

      if (checkoutKind === 'linked') {
        const linkedParent = createScratchRoot('linked-exclude-worktree');
        repositoryRoot = resolve(linkedParent, 'chat-linked');
        runGit(
          ['worktree', 'add', '--detach', repositoryRoot, fixture.revisions.chat],
          fixture.roots.chatRoot,
        );
      }

      const roots = {
        ...fixture.roots,
        chatRoot: repositoryRoot,
      };
      const excludePath = readLocalExcludePath(repositoryRoot);
      const ignoredName = `do-not-leak-${checkoutKind}-exclude.txt`;
      writeFileSync(excludePath, `${ignoredName}\n`);
      writeFileSync(resolve(repositoryRoot, ignoredName), 'private excluded content\n');

      expect(runGit(['status', '--porcelain=v1', '--untracked-files=all'], repositoryRoot)).toBe(
        '',
      );

      const messages = [
        () => assertCleanPhase1Checkouts(roots),
        () => assertPhase1CheckoutHeads(fixture.lock, roots),
      ].map((verify) => {
        try {
          verify();
          return '';
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
      });

      expect(messages).toEqual([
        'chat checkout has 1 local exclude rule.',
        'chat checkout has 1 local exclude rule.',
      ]);
      expect(messages.join('\n')).not.toContain(ignoredName);
      expect(messages.join('\n')).not.toContain('private excluded content');
      expect(messages.join('\n')).not.toContain(excludePath);
      expect(messages.join('\n')).not.toContain(repositoryRoot);
    },
    gitIntegrationTestTimeout,
  );

  gitTest('counts escaped and leading-space comment markers as local exclude rules', () => {
    const fixture = createCheckoutFixture();
    const excludePath = readLocalExcludePath(fixture.roots.chatRoot);
    writeFileSync(
      excludePath,
      '# actual comment\n\\#escaped-secret-pattern\n #leading-space-secret-pattern\n\n',
    );

    for (const verify of [
      () => assertCleanPhase1Checkouts(fixture.roots),
      () => assertPhase1CheckoutHeads(fixture.lock, fixture.roots),
    ]) {
      let message = '';
      try {
        verify();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toBe('chat checkout has 2 local exclude rules.');
      expect(message).not.toContain('escaped-secret-pattern');
      expect(message).not.toContain('leading-space-secret-pattern');
      expect(message).not.toContain(excludePath);
    }
  });

  gitTest('bounds local exclude diagnostics without disclosing rules', () => {
    const fixture = createCheckoutFixture();
    const excludePath = readLocalExcludePath(fixture.roots.chatRoot);
    const secretRules = Array.from(
      { length: 101 },
      (_, index) => `do-not-leak-local-exclude-${index}`,
    );
    writeFileSync(excludePath, `${secretRules.join('\n')}\n`);

    for (const verify of [
      () => assertCleanPhase1Checkouts(fixture.roots),
      () => assertPhase1CheckoutHeads(fixture.lock, fixture.roots),
    ]) {
      let message = '';
      try {
        verify();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toBe('chat checkout has 100+ local exclude rules.');
      expect(message).not.toContain(secretRules[0]);
      expect(message).not.toContain(secretRules.at(-1));
      expect(message).not.toContain(excludePath);
    }
  });

  test.each(
    process.platform === 'win32'
      ? (['directory'] as const)
      : (['symlink', 'directory', 'unreadable'] as const),
  )(
    'rejects %s local exclude metadata with a fixed safe diagnostic',
    (metadataState) => {
      const fixture = createCheckoutFixture();
      const excludePath = readLocalExcludePath(fixture.roots.chatRoot);
      const secretTarget = resolve(createScratchRoot('unsafe-exclude'), 'secret-target');
      rmSync(excludePath, { force: true });

      if (metadataState === 'symlink') {
        writeFileSync(secretTarget, 'do-not-leak-symlink-rule\n');
        symlinkSync(secretTarget, excludePath);
      } else if (metadataState === 'directory') {
        mkdirSync(excludePath);
      } else {
        writeFileSync(excludePath, 'do-not-leak-unreadable-rule\n');
        chmodSync(excludePath, 0o000);
      }

      for (const verify of [
        () => assertCleanPhase1Checkouts(fixture.roots),
        () => assertPhase1CheckoutHeads(fixture.lock, fixture.roots),
      ]) {
        let message = '';
        try {
          verify();
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }

        expect(message).toBe('chat checkout has unsafe local exclude metadata.');
        expect(message).not.toContain('do-not-leak');
        expect(message).not.toContain(excludePath);
        expect(message).not.toContain(secretTarget);
      }
    },
    gitIntegrationTestTimeout,
  );

  test.each([
    ['exclude', readLocalExcludePath],
    ['attribute', readLocalAttributesPath],
  ] as const)(
    'rejects oversized local %s metadata on both verification paths',
    (metadataKind, readMetadataPath) => {
      const fixture = createCheckoutFixture();
      const metadataPath = readMetadataPath(fixture.roots.chatRoot);
      writeFileSync(metadataPath, `#${'x'.repeat(64 * 1024)}`);

      for (const verify of [
        () => assertCleanPhase1Checkouts(fixture.roots),
        () => assertPhase1CheckoutHeads(fixture.lock, fixture.roots),
      ]) {
        let message = '';
        try {
          verify();
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }

        expect(message).toBe(`chat checkout has unsafe local ${metadataKind} metadata.`);
        expect(message).not.toContain(metadataPath);
      }
    },
    gitIntegrationTestTimeout,
  );

  gitTest('allows comment-only local attribute metadata', () => {
    const fixture = createCheckoutFixture();
    const attributesPath = readLocalAttributesPath(fixture.roots.chatRoot);
    writeFileSync(attributesPath, '# local comments are allowed\n\n\t \n# another comment\n');

    expect(assertCleanPhase1Checkouts(fixture.roots)).toEqual({
      chat: { staged: 0, unstaged: 0, untracked: 0 },
      sdk: { staged: 0, unstaged: 0, untracked: 0 },
      cave: { staged: 0, unstaged: 0, untracked: 0 },
      coven: { staged: 0, unstaged: 0, untracked: 0 },
    });
    expect(assertPhase1CheckoutHeads(fixture.lock, fixture.roots)).toEqual(fixture.revisions);
  });

  test.each(['normal', 'linked'] as const)(
    'rejects active local attribute rules in a %s worktree on both verification paths',
    (checkoutKind) => {
      const fixture = createCheckoutFixture();
      let repositoryRoot = fixture.roots.chatRoot;

      if (checkoutKind === 'linked') {
        const linkedParent = createScratchRoot('linked-attributes-worktree');
        repositoryRoot = resolve(linkedParent, 'chat-linked');
        runGit(
          ['worktree', 'add', '--detach', repositoryRoot, fixture.revisions.chat],
          fixture.roots.chatRoot,
        );
      }

      const roots = {
        ...fixture.roots,
        chatRoot: repositoryRoot,
      };
      const attributesPath = readLocalAttributesPath(repositoryRoot);
      const markerPath = resolve(
        createScratchRoot(`local-${checkoutKind}-attribute-filter`),
        'filter-executed',
      );
      const secretRule = 'tracked.txt filter=hostile';
      writeFileSync(attributesPath, `${secretRule}\n`);
      configureHostileCleanFilter(repositoryRoot, markerPath);
      appendFileSync(resolve(repositoryRoot, 'tracked.txt'), 'private changed content\n');

      for (const verify of [
        () => assertCleanPhase1Checkouts(roots),
        () => assertPhase1CheckoutHeads(fixture.lock, roots),
      ]) {
        let message = '';
        try {
          verify();
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }

        expect(message).toBe('chat checkout has 1 local attribute rule.');
        expect(message).not.toContain(secretRule);
        expect(message).not.toContain(attributesPath);
        expect(message).not.toContain(repositoryRoot);
        expect(existsSync(markerPath)).toBe(false);
      }
    },
    gitIntegrationTestTimeout,
  );

  gitTest('bounds local attribute diagnostics without disclosing rules', () => {
    const fixture = createCheckoutFixture();
    const attributesPath = readLocalAttributesPath(fixture.roots.chatRoot);
    const secretRules = Array.from(
      { length: 101 },
      (_, index) => `tracked.txt do-not-leak-local-attribute-${index}=set`,
    );
    writeFileSync(attributesPath, `${secretRules.join('\n')}\n`);

    for (const verify of [
      () => assertCleanPhase1Checkouts(fixture.roots),
      () => assertPhase1CheckoutHeads(fixture.lock, fixture.roots),
    ]) {
      let message = '';
      try {
        verify();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toBe('chat checkout has 100+ local attribute rules.');
      expect(message).not.toContain(secretRules[0]);
      expect(message).not.toContain(secretRules.at(-1));
      expect(message).not.toContain(attributesPath);
    }
  });

  test.each(
    process.platform === 'win32'
      ? (['directory'] as const)
      : (['symlink', 'directory', 'unreadable'] as const),
  )(
    'rejects %s local attribute metadata with a fixed safe diagnostic',
    (metadataState) => {
      const fixture = createCheckoutFixture();
      const attributesPath = readLocalAttributesPath(fixture.roots.chatRoot);
      const secretTarget = resolve(createScratchRoot('unsafe-attributes'), 'secret-target');
      rmSync(attributesPath, { force: true });

      if (metadataState === 'symlink') {
        writeFileSync(secretTarget, 'tracked.txt do-not-leak-symlink=set\n');
        symlinkSync(secretTarget, attributesPath);
      } else if (metadataState === 'directory') {
        mkdirSync(attributesPath);
      } else {
        writeFileSync(attributesPath, 'tracked.txt do-not-leak-unreadable=set\n');
        chmodSync(attributesPath, 0o000);
      }

      for (const verify of [
        () => assertCleanPhase1Checkouts(fixture.roots),
        () => assertPhase1CheckoutHeads(fixture.lock, fixture.roots),
      ]) {
        let message = '';
        try {
          verify();
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }

        expect(message).toBe('chat checkout has unsafe local attribute metadata.');
        expect(message).not.toContain('do-not-leak');
        expect(message).not.toContain(attributesPath);
        expect(message).not.toContain(secretTarget);
      }
    },
    gitIntegrationTestTimeout,
  );

  gitTest('allows committed gitignore rules', () => {
    const fixture = createCheckoutFixture();
    const ignoredName = 'committed-ignore-canary.txt';
    writeFileSync(resolve(fixture.roots.chatRoot, '.gitignore'), `${ignoredName}\n`);
    runGit(['add', '.gitignore'], fixture.roots.chatRoot);
    runGit(['commit', '-m', 'add reviewed ignore rule'], fixture.roots.chatRoot);
    const lockedRevision = runGit(['rev-parse', 'HEAD'], fixture.roots.chatRoot);
    const lock = {
      ...fixture.lock,
      chat: {
        repository: expectedEntries.chat.repository,
        revision: lockedRevision,
      },
    };
    const revisions = {
      ...fixture.revisions,
      chat: lockedRevision,
    };
    writeFileSync(resolve(fixture.roots.chatRoot, ignoredName), 'reviewed ignored content\n');

    expect(assertCleanPhase1Checkouts(fixture.roots)).toEqual({
      chat: { staged: 0, unstaged: 0, untracked: 0 },
      sdk: { staged: 0, unstaged: 0, untracked: 0 },
      cave: { staged: 0, unstaged: 0, untracked: 0 },
      coven: { staged: 0, unstaged: 0, untracked: 0 },
    });
    expect(assertPhase1CheckoutHeads(lock, fixture.roots)).toEqual(revisions);
  });

  gitTest('does not let command-scope Git config hide untracked files', () => {
    const fixture = createCheckoutFixture();
    const ignoredName = 'hidden-by-hostile-config.txt';
    const excludesPath = resolve(createScratchRoot('hostile-excludes'), 'global-excludes');
    writeFileSync(excludesPath, `${ignoredName}\n`);
    writeFileSync(resolve(fixture.roots.chatRoot, ignoredName), 'private untracked content\n');

    withTemporaryProcessEnv(
      {
        GIT_CONFIG_COUNT: '1',
        GIT_CONFIG_KEY_0: 'core.excludesFile',
        GIT_CONFIG_VALUE_0: excludesPath,
      },
      () => {
        expect(() => assertCleanPhase1Checkouts(fixture.roots)).toThrow(
          'chat checkout is dirty (1 untracked item).',
        );
      },
    );
  });

  test.each(['HOME', 'XDG_CONFIG_HOME'] as const)(
    'does not let hostile %s global Git config hide untracked files',
    (source) => {
      const fixture = createCheckoutFixture();
      const ignoredName = `hidden-by-${source.toLowerCase()}.txt`;
      const hostileConfig = createHostileGlobalGitConfig(source, ignoredName);
      const repositoryRoot = fixture.roots.chatRoot;
      writeFileSync(resolve(repositoryRoot, ignoredName), 'private global-config content\n');

      withTemporaryProcessEnv(hostileConfig.environment, () => {
        expect(
          runGitWithHostConfiguration(
            ['status', '--porcelain=v1', '--untracked-files=all'],
            repositoryRoot,
          ),
        ).toBe('');

        let message = '';
        try {
          assertCleanPhase1Checkouts(fixture.roots);
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }

        expect(message).toBe('chat checkout is dirty (1 untracked item).');
        expect(message).not.toContain(ignoredName);
        expect(message).not.toContain('private global-config content');
        expect(message).not.toContain(hostileConfig.configPath);
        expect(message).not.toContain(hostileConfig.excludesPath);
        expect(message).not.toContain(repositoryRoot);
        expect(() => assertPhase1CheckoutHeads(fixture.lock, fixture.roots)).toThrow(
          'chat checkout is dirty (1 untracked item).',
        );
      });
    },
    gitIntegrationTestTimeout,
  );

  gitTest('does not let local Git config hide untracked files', () => {
    const fixture = createCheckoutFixture();
    const ignoredName = 'hidden-by-local-config.txt';
    const hostileRoot = createScratchRoot('hostile-local-config');
    const excludesPath = resolve(hostileRoot, 'local-excludes');
    const repositoryRoot = fixture.roots.chatRoot;
    writeFileSync(excludesPath, `${ignoredName}\n`);
    runGit(['config', '--local', 'core.excludesFile', excludesPath], repositoryRoot);
    writeFileSync(resolve(repositoryRoot, ignoredName), 'private local-config content\n');

    expect(
      runGitWithHostConfiguration(
        ['status', '--porcelain=v1', '--untracked-files=all'],
        repositoryRoot,
      ),
    ).toBe('');

    let message = '';
    try {
      assertCleanPhase1Checkouts(fixture.roots);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toBe('chat checkout is dirty (1 untracked item).');
    expect(message).not.toContain(ignoredName);
    expect(message).not.toContain('private local-config content');
    expect(message).not.toContain(excludesPath);
    expect(message).not.toContain(repositoryRoot);
  });

  gitTest('forces default stat checks despite local core.checkStat=minimal', () => {
    const fixture = createCheckoutFixture();
    const repositoryRoot = fixture.roots.chatRoot;
    const trackedPath = resolve(repositoryRoot, 'tracked.txt');
    const stableTime = new Date(Date.now() - 120_000);
    stableTime.setMilliseconds(0);
    utimesSync(trackedPath, stableTime, stableTime);
    runGit(['update-index', '--refresh'], repositoryRoot);

    const originalContent = readFileSync(trackedPath, 'utf8');
    const changedContent = originalContent.replace('chat', 'CHAT');
    const indexedMtime = statSync(trackedPath).mtime;
    expect(Buffer.byteLength(changedContent)).toBe(Buffer.byteLength(originalContent));

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_100);
    writeFileSync(trackedPath, changedContent);
    utimesSync(trackedPath, indexedMtime, indexedMtime);
    runGit(['config', '--local', 'core.checkStat', 'minimal'], repositoryRoot);
    runGit(['config', '--local', 'core.trustctime', 'false'], repositoryRoot);

    expect(runGitWithHostConfiguration(['status', '--porcelain=v1'], repositoryRoot)).toBe('');

    for (const verify of [
      () => assertCleanPhase1Checkouts(fixture.roots),
      () => assertPhase1CheckoutHeads(fixture.lock, fixture.roots),
    ]) {
      let message = '';
      try {
        verify();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toBe('chat checkout is dirty (1 unstaged change).');
      expect(message).not.toContain('tracked.txt');
      expect(message).not.toContain(changedContent);
      expect(message).not.toContain(repositoryRoot);
    }

    expect(runGit(['config', '--local', '--get', 'core.checkStat'], repositoryRoot)).toBe(
      'minimal',
    );
    expect(runGit(['config', '--local', '--get', 'core.trustctime'], repositoryRoot)).toBe('false');
  });

  test.skipIf(!fileSymlinksSupported)(
    'forces symlink checks despite local core.symlinks=false',
    () => {
      const fixture = createCheckoutFixture();
      const repositoryRoot = fixture.roots.chatRoot;
      const trackedPath = resolve(repositoryRoot, 'tracked.txt');
      const linkTarget = 'symlink-target.txt';
      rmSync(trackedPath);
      symlinkSync(linkTarget, trackedPath, 'file');
      runGit(['add', 'tracked.txt'], repositoryRoot);
      runGit(['commit', '-m', 'track symlink fixture'], repositoryRoot);
      const lock = lockChatAtHead(fixture, runGit(['rev-parse', 'HEAD'], repositoryRoot));

      rmSync(trackedPath);
      writeFileSync(trackedPath, linkTarget);
      runGit(['config', '--local', 'core.symlinks', 'false'], repositoryRoot);

      expect(runGitWithHostConfiguration(['status', '--porcelain=v1'], repositoryRoot)).toBe('');

      for (const verify of [
        () => assertCleanPhase1Checkouts(fixture.roots),
        () => assertPhase1CheckoutHeads(lock, fixture.roots),
      ]) {
        let message = '';
        try {
          verify();
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }

        expect(message).toBe('chat checkout is dirty (1 unstaged change).');
        expect(message).not.toContain('tracked.txt');
        expect(message).not.toContain(linkTarget);
        expect(message).not.toContain(repositoryRoot);
      }

      expect(runGit(['config', '--local', '--get', 'core.symlinks'], repositoryRoot)).toBe('false');
    },
    gitIntegrationTestTimeout,
  );

  gitTest('rejects an initialized submodule even when local ignore=all hides dirtiness', () => {
    const fixture = createCheckoutFixture();
    const repositoryRoot = fixture.roots.chatRoot;
    const submoduleName = 'dirty-fixture';
    const submodulePath = 'vendor/dirty-fixture';
    runGit(
      [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '--name',
        submoduleName,
        fixture.roots.sdkRoot,
        submodulePath,
      ],
      repositoryRoot,
    );
    runGit(['commit', '-m', 'add initialized submodule fixture'], repositoryRoot);
    const lock = lockChatAtHead(fixture, runGit(['rev-parse', 'HEAD'], repositoryRoot));
    const initializedSubmoduleRoot = resolve(repositoryRoot, submodulePath);
    appendFileSync(
      resolve(initializedSubmoduleRoot, 'tracked.txt'),
      'private dirty submodule content\n',
    );
    runGit(['config', '--local', `submodule.${submoduleName}.ignore`, 'all'], repositoryRoot);

    expect(runGitWithHostConfiguration(['status', '--porcelain=v1'], repositoryRoot)).toBe('');

    for (const verify of [
      () => assertCleanPhase1Checkouts(fixture.roots),
      () => assertPhase1CheckoutHeads(lock, fixture.roots),
    ]) {
      let message = '';
      try {
        verify();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toBe('chat checkout has 1 submodule entry.');
      expect(message).not.toContain(submoduleName);
      expect(message).not.toContain(submodulePath);
      expect(message).not.toContain('private dirty submodule content');
      expect(message).not.toContain(repositoryRoot);
    }

    expect(
      runGit(['config', '--local', '--get', `submodule.${submoduleName}.ignore`], repositoryRoot),
    ).toBe('all');
  });

  gitTest('rejects a clean committed submodule on both verification paths', () => {
    const fixture = createCheckoutFixture();
    const repositoryRoot = fixture.roots.chatRoot;
    const submodulePath = 'vendor/clean-fixture';
    runGit(
      [
        '-c',
        'protocol.file.allow=always',
        'submodule',
        'add',
        '--name',
        'clean-fixture',
        fixture.roots.sdkRoot,
        submodulePath,
      ],
      repositoryRoot,
    );
    runGit(['commit', '-m', 'add clean submodule fixture'], repositoryRoot);
    const lock = lockChatAtHead(fixture, runGit(['rev-parse', 'HEAD'], repositoryRoot));

    expect(runGit(['status', '--porcelain=v1'], repositoryRoot)).toBe('');

    for (const verify of [
      () => assertCleanPhase1Checkouts(fixture.roots),
      () => assertPhase1CheckoutHeads(lock, fixture.roots),
    ]) {
      let message = '';
      try {
        verify();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toBe('chat checkout has 1 submodule entry.');
      expect(message).not.toContain('clean-fixture');
      expect(message).not.toContain(submodulePath);
      expect(message).not.toContain(repositoryRoot);
    }
  });

  gitTest('bounds submodule diagnostics without disclosing index paths', () => {
    const fixture = createCheckoutFixture();
    const repositoryRoot = fixture.roots.chatRoot;
    const secretPaths = Array.from({ length: 101 }, (_, index) => `do-not-leak-submodule-${index}`);
    const indexInput = secretPaths
      .map((path) => `160000 ${fixture.revisions.sdk}\t${path}`)
      .join('\n');
    runGit(['update-index', '--index-info'], repositoryRoot, `${indexInput}\n`);

    for (const verify of [
      () => assertCleanPhase1Checkouts(fixture.roots),
      () => assertPhase1CheckoutHeads(fixture.lock, fixture.roots),
    ]) {
      let message = '';
      try {
        verify();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toBe('chat checkout has 100+ submodule entries.');
      expect(message).not.toContain(secretPaths[0]);
      expect(message).not.toContain(secretPaths.at(-1));
      expect(message).not.toContain(repositoryRoot);
    }
  });

  test.each([
    ['entry count', { trackedEntryLimit: 0 }],
    ['path bytes', { trackedPathByteLimit: 0 }],
  ] as const)(
    'rejects tracked %s over the configured internal test limit',
    (_limitKind, limits) => {
      expect(phase1ConformanceTestOnly).toBeDefined();
      const fixture = createCheckoutFixture();

      for (const verify of [
        () =>
          phase1ConformanceTestOnly.assertCleanPhase1Checkouts(fixture.roots, {
            limits,
          }),
        () =>
          phase1ConformanceTestOnly.assertPhase1CheckoutHeads(fixture.lock, fixture.roots, {
            limits,
          }),
      ]) {
        expect(verify).toThrow('chat checkout exceeds tracked path limits.');
      }
    },
    gitIntegrationTestTimeout,
  );

  test.skipIf(process.platform === 'win32')(
    'shares one shrinking deadline across all Git commands for a repository',
    () => {
      expect(phase1ConformanceTestOnly).toBeDefined();
      const fixture = createCheckoutFixture();
      const fakeBin = createScratchRoot('deadline-git');
      const fakeGitPath = resolve(fakeBin, 'git');
      const invocationMarker = resolve(fakeBin, 'invocations');
      const originalPath = process.env.PATH ?? '';
      writeFileSync(
        fakeGitPath,
        `#!/bin/sh
printf 'invoked\\n' >> ${JSON.stringify(invocationMarker)}
sleep 0.15
PATH=${JSON.stringify(originalPath)} exec git "$@"
`,
      );
      chmodSync(fakeGitPath, 0o755);
      const startedAt = Date.now();

      withTemporaryProcessEnv(
        {
          PATH: `${fakeBin}${delimiter}${originalPath}`,
        },
        () => {
          expect(() =>
            phase1ConformanceTestOnly.assertCleanPhase1Checkouts(fixture.roots, {
              limits: { repositoryDeadlineMs: 1_500 },
            }),
          ).toThrow('chat checkout verification timed out.');
        },
      );

      expect(Date.now() - startedAt).toBeLessThan(3_000);
      expect(
        readFileSync(invocationMarker, 'utf8').split('\n').filter(Boolean).length,
      ).toBeGreaterThan(1);
      expect(
        readdirSync(projectRoot).filter((entry) => entry.startsWith('.phase1-conformance-hooks-')),
      ).toEqual([]);
    },
    gitIntegrationTestTimeout,
  );

  gitTest('creates isolated fixture commits despite hostile HOME and XDG global config', () => {
    const ignoredName = 'tracked.txt';
    const hostileHome = createHostileGlobalGitConfig('HOME', ignoredName);
    const hostileXdg = createHostileGlobalGitConfig('XDG_CONFIG_HOME', ignoredName);

    const fixture = withTemporaryProcessEnv(
      {
        HOME: hostileHome.environment.HOME,
        XDG_CONFIG_HOME: hostileXdg.environment.XDG_CONFIG_HOME,
      },
      () => createCheckoutFixture(),
    );

    for (const key of repositoryKeys) {
      const repositoryRoot = fixture.roots[`${key}Root`];
      expect(runGit(['status', '--porcelain=v1'], repositoryRoot)).toBe('');
      expect(runGit(['rev-parse', 'HEAD'], repositoryRoot)).toBe(fixture.revisions[key]);
    }
  });

  gitTest('ignores hostile global attributes without executing a local filter command', () => {
    const fixture = createCheckoutFixture();
    const repositoryRoot = fixture.roots.chatRoot;
    const hostileRoot = createScratchRoot('hostile-global-attributes');
    const homeRoot = resolve(hostileRoot, 'home');
    const configPath = resolve(homeRoot, '.gitconfig');
    const attributesPath = resolve(hostileRoot, 'global-attributes');
    const markerPath = resolve(hostileRoot, 'filter-executed');
    mkdirSync(homeRoot);
    writeFileSync(attributesPath, 'tracked.txt filter=hostile\n');
    runGit(['config', '--file', configPath, 'core.attributesFile', attributesPath], projectRoot);
    configureHostileCleanFilter(repositoryRoot, markerPath);
    appendFileSync(resolve(repositoryRoot, 'tracked.txt'), 'private changed content\n');

    withTemporaryProcessEnv(
      {
        HOME: homeRoot,
        XDG_CONFIG_HOME: resolve(hostileRoot, 'xdg'),
      },
      () => {
        expect(
          runGitWithHostConfiguration(['diff', '--quiet', '--', 'tracked.txt'], repositoryRoot),
        ).toBe('');
        expect(existsSync(markerPath)).toBe(true);
        rmSync(markerPath);

        for (const verify of [
          () => assertCleanPhase1Checkouts(fixture.roots),
          () => assertPhase1CheckoutHeads(fixture.lock, fixture.roots),
        ]) {
          expect(verify).toThrow('chat checkout is dirty (1 unstaged change).');
          expect(existsSync(markerPath)).toBe(false);
        }
      },
    );
  });

  test.each(['committed', 'staged'] as const)(
    'rejects a %s filter attribute before its clean command can spoof status',
    (attributeState) => {
      const fixture = createCheckoutFixture();
      const repositoryRoot = fixture.roots.chatRoot;
      const markerPath = resolve(
        createScratchRoot(`${attributeState}-filter-canary`),
        'filter-executed',
      );
      const secretPath = resolve(repositoryRoot, 'tracked.txt');
      writeFileSync(resolve(repositoryRoot, '.gitattributes'), 'tracked.txt filter=hostile\n');
      runGit(['add', '.gitattributes'], repositoryRoot);

      let lock = fixture.lock;
      if (attributeState === 'committed') {
        runGit(['commit', '-m', 'add hostile filter attribute'], repositoryRoot);
        lock = lockChatAtHead(fixture, runGit(['rev-parse', 'HEAD'], repositoryRoot));
      }

      configureHostileCleanFilter(repositoryRoot, markerPath);
      appendFileSync(secretPath, 'private changed content\n');

      if (attributeState === 'committed') {
        expect(
          runGitWithHostConfiguration(['diff', '--quiet', '--', 'tracked.txt'], repositoryRoot),
        ).toBe('');
        expect(existsSync(markerPath)).toBe(true);
        rmSync(markerPath);
      }

      for (const verify of [
        () => assertCleanPhase1Checkouts(fixture.roots),
        () => assertPhase1CheckoutHeads(lock, fixture.roots),
      ]) {
        let message = '';
        try {
          verify();
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }

        expect(message).toBe('chat checkout has 1 tracked entry with an active filter attribute.');
        expect(message).not.toContain('tracked.txt');
        expect(message).not.toContain('hostile');
        expect(message).not.toContain(secretPath);
        expect(message).not.toContain(repositoryRoot);
        expect(existsSync(markerPath)).toBe(false);
      }
    },
    gitIntegrationTestTimeout,
  );

  gitTest('ignores an uncommitted worktree filter attribute while reporting dirty files', () => {
    const fixture = createCheckoutFixture();
    const repositoryRoot = fixture.roots.chatRoot;
    const markerPath = resolve(createScratchRoot('worktree-filter-canary'), 'filter-executed');
    configureHostileCleanFilter(repositoryRoot, markerPath);
    writeFileSync(resolve(repositoryRoot, '.gitattributes'), 'tracked.txt filter=hostile\n');
    appendFileSync(resolve(repositoryRoot, 'tracked.txt'), 'private changed content\n');

    for (const verify of [
      () => assertCleanPhase1Checkouts(fixture.roots),
      () => assertPhase1CheckoutHeads(fixture.lock, fixture.roots),
    ]) {
      let message = '';
      try {
        verify();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toBe('chat checkout is dirty (1 unstaged change, 1 untracked item).');
      expect(message).not.toContain('tracked.txt');
      expect(message).not.toContain('.gitattributes');
      expect(message).not.toContain('hostile');
      expect(message).not.toContain(repositoryRoot);
      expect(existsSync(markerPath)).toBe(false);
    }
  });

  gitTest('bounds active tracked-filter diagnostics without executing filter commands', () => {
    const fixture = createCheckoutFixture();
    const repositoryRoot = fixture.roots.chatRoot;
    const markerPath = resolve(createScratchRoot('bounded-filter-canary'), 'filter-executed');
    const secretNames = Array.from(
      { length: 101 },
      (_, index) => `do-not-leak-filtered-${index}.txt`,
    );

    for (const secretName of secretNames) {
      writeFileSync(resolve(repositoryRoot, secretName), 'tracked filtered content\n');
    }
    writeFileSync(
      resolve(repositoryRoot, '.gitattributes'),
      'do-not-leak-filtered-*.txt filter=hostile\n',
    );
    runGit(['add', '.gitattributes', ...secretNames], repositoryRoot);
    runGit(['commit', '-m', 'add bounded filter fixtures'], repositoryRoot);
    const lockedRevision = runGit(['rev-parse', 'HEAD'], repositoryRoot);
    const lock = lockChatAtHead(fixture, lockedRevision);
    configureHostileCleanFilter(repositoryRoot, markerPath);

    for (const verify of [
      () => assertCleanPhase1Checkouts(fixture.roots),
      () => assertPhase1CheckoutHeads(lock, fixture.roots),
    ]) {
      let message = '';
      try {
        verify();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toBe('chat checkout has 100+ tracked entries with active filter attributes.');
      expect(message).not.toContain(secretNames[0]);
      expect(message).not.toContain(secretNames.at(-1));
      expect(message).not.toContain('hostile');
      expect(message).not.toContain(repositoryRoot);
      expect(existsSync(markerPath)).toBe(false);
    }
  });

  test.skipIf(process.platform === 'win32')(
    'forces file mode checks despite local core.fileMode=false',
    () => {
      const fixture = createCheckoutFixture();
      const repositoryRoot = fixture.roots.chatRoot;
      const trackedPath = resolve(repositoryRoot, 'tracked.txt');
      runGit(['config', '--local', 'core.fileMode', 'false'], repositoryRoot);
      chmodSync(trackedPath, 0o755);

      expect(runGitWithHostConfiguration(['status', '--porcelain=v1'], repositoryRoot)).toBe('');

      for (const verify of [
        () => assertCleanPhase1Checkouts(fixture.roots),
        () => assertPhase1CheckoutHeads(fixture.lock, fixture.roots),
      ]) {
        let message = '';
        try {
          verify();
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }

        expect(message).toBe('chat checkout is dirty (1 unstaged change).');
        expect(message).not.toContain('tracked.txt');
        expect(message).not.toContain(trackedPath);
        expect(message).not.toContain(repositoryRoot);
      }
    },
    gitIntegrationTestTimeout,
  );

  test.runIf(process.platform === 'win32')(
    'does not treat POSIX executable mode as an enforceable worktree property on Windows',
    () => {
      const fixture = createCheckoutFixture();
      chmodSync(resolve(fixture.roots.chatRoot, 'tracked.txt'), 0o755);

      expect(assertCleanPhase1Checkouts(fixture.roots).chat).toEqual({
        staged: 0,
        unstaged: 0,
        untracked: 0,
      });
      expect(assertPhase1CheckoutHeads(fixture.lock, fixture.roots).chat).toBe(
        fixture.revisions.chat,
      );
    },
    gitIntegrationTestTimeout,
  );

  gitTest('rejects an index executable-mode change on every platform', () => {
    const fixture = createCheckoutFixture();
    const repositoryRoot = fixture.roots.chatRoot;
    runGit(['update-index', '--chmod=+x', 'tracked.txt'], repositoryRoot);

    for (const verify of [
      () => assertCleanPhase1Checkouts(fixture.roots),
      () => assertPhase1CheckoutHeads(fixture.lock, fixture.roots),
    ]) {
      let message = '';
      try {
        verify();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain('chat checkout is dirty (1 staged change');
      expect(message).not.toContain('tracked.txt');
      expect(message).not.toContain(repositoryRoot);
    }
  });

  test.each(repositoryKeys)(
    'rejects replacement refs in a clean locked %s checkout on both verification paths',
    (key) => {
      const fixture = createCheckoutFixture();
      const repositoryRoot = fixture.roots[`${key}Root`];
      const originalBlob = runGit(['rev-parse', 'HEAD:tracked.txt'], repositoryRoot);
      const replacementBlob = runGit(
        ['hash-object', '-w', '--stdin'],
        repositoryRoot,
        'unreviewed replacement content\n',
      );
      runGit(['replace', originalBlob, replacementBlob], repositoryRoot);

      expect(runGit(['rev-parse', 'HEAD'], repositoryRoot)).toBe(fixture.revisions[key]);
      expect(runGit(['status', '--porcelain=v1'], repositoryRoot)).toBe('');

      for (const verify of [
        () => assertCleanPhase1Checkouts(fixture.roots),
        () => assertPhase1CheckoutHeads(fixture.lock, fixture.roots),
      ]) {
        let message = '';
        try {
          verify();
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }

        expect(message).toBe(`${key} checkout has 1 replacement ref.`);
        expect(message).not.toContain(originalBlob);
        expect(message).not.toContain(replacementBlob);
        expect(message).not.toContain('unreviewed replacement content');
        expect(message).not.toContain(repositoryRoot);
      }
    },
    gitIntegrationTestTimeout,
  );

  gitTest('bounds replacement-ref diagnostics without disclosing ref names', () => {
    const fixture = createCheckoutFixture();
    const repositoryRoot = fixture.roots.chatRoot;
    const replacementBlob = runGit(
      ['hash-object', '-w', '--stdin'],
      repositoryRoot,
      'replacement object\n',
    );
    const updates = Array.from(
      { length: 101 },
      (_, index) =>
        `update refs/replace/${(index + 1).toString(16).padStart(40, '0')} ${replacementBlob}`,
    ).join('\n');
    runGit(['update-ref', '--stdin'], repositoryRoot, `${updates}\n`);

    for (const verify of [
      () => assertCleanPhase1Checkouts(fixture.roots),
      () => assertPhase1CheckoutHeads(fixture.lock, fixture.roots),
    ]) {
      expect(verify).toThrow('chat checkout has 100+ replacement refs.');
    }
  });

  test.each(
    repositoryKeys.flatMap((key) =>
      hiddenIndexStates.map(([state, updateFlag]) => [key, state, updateFlag] as const),
    ),
  )(
    'rejects a modified %s checkout with clean status and locked HEAD when tracked state is %s',
    (key, _state, updateFlag) => {
      const fixture = createCheckoutFixture();
      const repositoryRoot = fixture.roots[`${key}Root`];
      runGit(['update-index', updateFlag, 'tracked.txt'], repositoryRoot);
      appendFileSync(resolve(repositoryRoot, 'tracked.txt'), 'private hidden content\n');

      expect(runGit(['status', '--porcelain=v1'], repositoryRoot)).toBe('');
      expect(runGit(['rev-parse', 'HEAD'], repositoryRoot)).toBe(fixture.revisions[key]);

      for (const verify of [
        () => assertCleanPhase1Checkouts(fixture.roots),
        () => assertPhase1CheckoutHeads(fixture.lock, fixture.roots),
      ]) {
        let message = '';
        try {
          verify();
        } catch (error) {
          message = error instanceof Error ? error.message : String(error);
        }

        expect(message).toBe(`${key} checkout has 1 hidden index entry.`);
        expect(message).not.toContain('tracked.txt');
        expect(message).not.toContain('private hidden content');
        expect(message).not.toContain(repositoryRoot);
      }
    },
    gitIntegrationTestTimeout,
  );

  gitTest('counts an unmodified path carrying both hidden index flags once', () => {
    const fixture = createCheckoutFixture();
    const repositoryRoot = fixture.roots.chatRoot;
    runGit(['update-index', '--assume-unchanged', 'tracked.txt'], repositoryRoot);
    runGit(['update-index', '--skip-worktree', 'tracked.txt'], repositoryRoot);

    expect(runGit(['status', '--porcelain=v1'], repositoryRoot)).toBe('');
    expect(runGit(['rev-parse', 'HEAD'], repositoryRoot)).toBe(fixture.revisions.chat);

    for (const verify of [
      () => assertCleanPhase1Checkouts(fixture.roots),
      () => assertPhase1CheckoutHeads(fixture.lock, fixture.roots),
    ]) {
      expect(verify).toThrow('chat checkout has 1 hidden index entry.');
    }
  });

  gitTest('bounds hidden-index diagnostics without disclosing paths', () => {
    const fixture = createCheckoutFixture();
    const repositoryRoot = fixture.roots.chatRoot;
    const secretNames = Array.from(
      { length: 101 },
      (_, index) => `do-not-leak-hidden-index-${index}.txt`,
    );

    for (const secretName of secretNames) {
      writeFileSync(resolve(repositoryRoot, secretName), 'private tracked content\n');
    }
    runGit(['add', ...secretNames], repositoryRoot);
    runGit(['commit', '-m', 'add hidden index fixtures'], repositoryRoot);
    const lockedRevision = runGit(['rev-parse', 'HEAD'], repositoryRoot);
    const lock = {
      ...fixture.lock,
      chat: {
        repository: expectedEntries.chat.repository,
        revision: lockedRevision,
      },
    };

    const hiddenPathsInput = `${secretNames.join('\0')}\0`;
    runGit(
      ['update-index', '--assume-unchanged', '-z', '--stdin'],
      repositoryRoot,
      hiddenPathsInput,
    );
    runGit(['update-index', '--skip-worktree', '-z', '--stdin'], repositoryRoot, hiddenPathsInput);

    expect(runGit(['status', '--porcelain=v1'], repositoryRoot)).toBe('');

    for (const verify of [
      () => assertCleanPhase1Checkouts(fixture.roots),
      () => assertPhase1CheckoutHeads(lock, fixture.roots),
    ]) {
      let message = '';
      try {
        verify();
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toBe('chat checkout has 100+ hidden index entries.');
      expect(message).not.toContain(secretNames[0]);
      expect(message).not.toContain(secretNames.at(-1));
      expect(message).not.toContain('private tracked content');
      expect(message).not.toContain(repositoryRoot);
    }
  });

  test.each([
    ['chat', 'staged', '1 staged change'],
    ['sdk', 'unstaged', '1 unstaged change'],
    ['cave', 'untracked', '1 untracked item'],
    ['coven', 'staged', '1 staged change'],
  ] as const)(
    'rejects a dirty %s checkout with a bounded %s count',
    (key, state, summary) => {
      const fixture = createCheckoutFixture();
      const repositoryRoot = fixture.roots[`${key}Root`];
      const secretName = `do-not-leak-${key}-${state}.txt`;

      if (state === 'untracked') {
        writeFileSync(resolve(repositoryRoot, secretName), 'private fixture content\n');
      } else {
        appendFileSync(resolve(repositoryRoot, 'tracked.txt'), 'private fixture content\n');

        if (state === 'staged') {
          runGit(['add', 'tracked.txt'], repositoryRoot);
        }
      }

      let message = '';
      try {
        assertCleanPhase1Checkouts(fixture.roots);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }

      expect(message).toContain(`${key} checkout is dirty (${summary})`);
      expect(message).not.toContain(secretName);
      expect(message).not.toContain('private fixture content');
      expect(message).not.toContain(repositoryRoot);
    },
    gitIntegrationTestTimeout,
  );

  test.each(repositoryKeys)(
    'rejects a %s HEAD mismatch with only label and SHAs',
    (key) => {
      const fixture = createCheckoutFixture();
      const repositoryRoot = fixture.roots[`${key}Root`];
      writeFileSync(resolve(repositoryRoot, 'second.txt'), `${key} second commit\n`);
      runGit(['add', 'second.txt'], repositoryRoot);
      runGit(['commit', '-m', `${key} second`], repositoryRoot);
      const actualRevision = runGit(['rev-parse', 'HEAD'], repositoryRoot);

      expect(() => assertPhase1CheckoutHeads(fixture.lock, fixture.roots)).toThrow(
        `${key} checkout HEAD ${actualRevision} does not match expected ${fixture.revisions[key]}.`,
      );
    },
    gitIntegrationTestTimeout,
  );

  gitTest('rejects missing and non-path checkout roots explicitly', () => {
    const fixture = createCheckoutFixture();
    const missingRoot = { ...fixture.roots, covenRoot: undefined };
    const nonPathRoot = { ...fixture.roots, sdkRoot: 42 };

    expect(() => assertCleanPhase1Checkouts(missingRoot as never)).toThrow(
      'coven checkout root must be a non-empty path string.',
    );
    expect(() => assertPhase1CheckoutHeads(fixture.lock, nonPathRoot as never)).toThrow(
      'sdk checkout root must be a non-empty path string.',
    );
  });
});
