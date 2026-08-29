import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

type CapabilityFile = {
  $schema?: string;
  permissions: unknown[];
  windows: string[];
};

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

type ContractCanaryLock = {
  version: number;
  sdk: {
    repository: string;
    revision: string;
    releaseManifest: {
      file: string;
      version: string;
      sha256: string;
    };
    artifacts: Record<
      string,
      {
        packageName: string;
        version: string;
        releaseFile: string;
        vendorFile: string;
        size: number;
        sha256: string;
      }
    >;
  };
  cave: {
    repository: string;
    revision: string;
    artifacts: Record<
      string,
      {
        path: string;
        digestPath: string;
        sha256: string;
      }
    >;
  };
};

const projectRoot = process.cwd();

function readText(relativePath: string) {
  return readFileSync(resolve(projectRoot, relativePath), 'utf8');
}

function readJson<T>(relativePath: string) {
  return JSON.parse(readText(relativePath)) as T;
}

function listRuntimeSourceFiles(relativePath: string): string[] {
  const absolutePath = resolve(projectRoot, relativePath);
  const entries = readdirSync(absolutePath);
  const files: string[] = [];

  for (const entry of entries) {
    const childRelativePath = `${relativePath}/${entry}`;
    const childAbsolutePath = resolve(projectRoot, childRelativePath);
    const stats = statSync(childAbsolutePath);

    if (stats.isDirectory()) {
      files.push(...listRuntimeSourceFiles(childRelativePath));
      continue;
    }

    if (
      !/\.(ts|tsx)$/.test(entry) ||
      /\.test\.(ts|tsx)$/.test(entry) ||
      childRelativePath.endsWith('vite-env.d.ts')
    ) {
      continue;
    }

    files.push(childRelativePath);
  }

  return files.sort();
}

function registeredCommandNames(source: string): string[] {
  const declaration = source.match(
    /pub const REGISTERED_COMMANDS: &\[&str\] = &\[(?<commands>[\s\S]*?)\];/,
  );

  if (!declaration?.groups?.commands) {
    throw new Error('REGISTERED_COMMANDS must remain an explicit command table.');
  }

  return [...declaration.groups.commands.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? '');
}

function invokeHandlerCommandNames(source: string): string[] {
  const invocation = source.match(/tauri::generate_handler!\[(?<commands>[\s\S]*?)\]/);

  if (!invocation?.groups?.commands) {
    throw new Error('Tauri commands must remain an explicit invoke handler list.');
  }

  return invocation.groups.commands
    .split(',')
    .map((command) => command.trim())
    .filter((command) => command.length > 0);
}

describe('Phase 1 specification guards', () => {
  it('ignores sibling worktrees from the repository root', () => {
    const output = execFileSync(
      'git',
      ['-C', projectRoot, 'check-ignore', '-v', '.worktrees/spec-gap-probe'],
      { encoding: 'utf8' },
    );

    expect(output).toContain('.gitignore');
    expect(output).toContain('/.worktrees');
  });

  it('tracks reviewed counterpart revisions in repository content', () => {
    const lock = readJson<ContractCanaryLock>('contract-canary.lock.json');

    expect(lock.version).toBe(4);
    expect(lock.sdk.repository).toBe('OpenCoven/sdk');
    expect(lock.cave.repository).toBe('OpenCoven/coven-cave');
    expect(lock.sdk.revision).toBe('acc38488f00860d246c3c553375634d64806eabb');
    expect(lock.cave.revision).toBe('2a0ff9237e94e652e477b22f60fd6d721b9e6451');
    expect(lock.sdk.releaseManifest).toEqual({
      file: 'release-manifest.json',
      version: '0.1.0',
      sha256: 'b8bfb62236fc8add4a9baad9f00e5401db15074a2d21fe2847a9158104cefb3c',
    });
    expect(lock.sdk.artifacts).toEqual({
      core: {
        packageName: '@opencoven/sdk-core',
        version: '0.1.0',
        releaseFile: 'tarballs/core/opencoven-sdk-core-0.1.0.tgz',
        vendorFile: 'sdk-core-0.1.0.tgz',
        size: 33284,
        sha256: '9a574e8bd5178ce2aa20db97e8a741c7c9569515546a2d3089406f41a9d040fe',
      },
      cave: {
        packageName: '@opencoven/cave-client',
        version: '0.1.0',
        releaseFile: 'tarballs/cave/opencoven-cave-client-0.1.0.tgz',
        vendorFile: 'cave-client-0.1.0.tgz',
        size: 81543,
        sha256: 'c44544adf8e712d6be1e8686788e63aa0133eb318274d1fb1926138a7da148c0',
      },
      coven: {
        packageName: '@opencoven/coven-client',
        version: '0.1.0',
        releaseFile: 'tarballs/coven/opencoven-coven-client-0.1.0.tgz',
        vendorFile: 'coven-client-0.1.0.tgz',
        size: 33009,
        sha256: 'cba09410aeae9670173a1f7bfe3174b5dd610873358944ed0955c86ac56a3aa1',
      },
      sdk: {
        packageName: '@opencoven/sdk',
        version: '0.1.0',
        releaseFile: 'tarballs/sdk/opencoven-sdk-0.1.0.tgz',
        vendorFile: 'sdk-0.1.0.tgz',
        size: 15833,
        sha256: 'eee7557feeaf4719d0cb990a66fdddf62270dbbeb05cfe7e35efbfe22827d04f',
      },
    });
    expect(lock.cave.artifacts).toEqual({
      contractFixture: {
        path: 'src/lib/server/client-v1/contract-fixture.json',
        digestPath: 'src/lib/server/client-v1/contract-fixture.sha256',
        sha256: '1b78125dab5b77414efd2d34e13315f542b197715ed26c6521f588e299abe61d',
      },
      hpkeVectors: {
        path: 'src/lib/server/client-v1/hpke-bound-v1-vectors.json',
        digestPath: 'src/lib/server/client-v1/hpke-bound-v1-vectors.sha256',
        sha256: 'f806967291de12175277b6b24ac3c7bba912ae760fd8227fb21b1a4d5f5e6797',
      },
    });
  });

  it('keeps the default Tauri capability least-privileged for native connection commands', () => {
    const capability = JSON.parse(
      readText('src-tauri/capabilities/default.json'),
    ) as CapabilityFile;

    expect(capability.windows).toEqual(['main']);
    expect(capability.permissions).toEqual([
      'allow-app-identity',
      'allow-app-installation-id',
      'allow-cave-read-discovery',
      'allow-cave-cancel-operation',
      'allow-cave-launch',
      'allow-cave-health',
      'allow-coven-health',
      'allow-cave-pairing-create',
      'allow-cave-pairing-poll',
      'allow-cave-pairing-exchange',
      'allow-cave-reset-pairing',
      'allow-cave-credential-status',
      'allow-cave-forget-credential',
      'allow-cave-list-familiars',
      'allow-cave-list-projects',
      'allow-cave-list-conversations',
      'allow-cave-get-conversation',
      'allow-cave-list-conversation-messages',
    ]);

    for (const permission of capability.permissions) {
      expect(typeof permission).toBe('string');

      if (typeof permission !== 'string') {
        continue;
      }

      expect(permission).not.toMatch(/:default$/);
      expect(permission).not.toMatch(/^(shell|fs|filesystem|opener|http|https|network):/);
    }
  });

  it('feature-gates the headless Phase 1 conformance bridge outside Tauri', () => {
    const manifest = readText('src-tauri/Cargo.toml');
    const library = readText('src-tauri/src/lib.rs');
    const commands = readText('src-tauri/src/commands.rs');
    const capability = readText('src-tauri/capabilities/default.json');
    const controls = ['conformance_reset_native_state', 'conformance_shutdown'];

    expect(manifest).toMatch(/\[features\]\s+phase1-conformance = \[\]/);
    const features = manifest.match(/\[features\]\r?\n([\s\S]*?)(?=\r?\n\[|$)/)?.[1];
    expect(features?.trim()).toBe('phase1-conformance = []');
    expect(manifest).toMatch(/\[package\][\s\S]*?default-run = "opencoven-chat"/);
    expect(manifest).toMatch(
      /\[\[bin\]\]\s+name = "phase1-native-rpc"\s+path = "src\/bin\/phase1-native-rpc\.rs"\s+required-features = \["phase1-conformance"\]/,
    );
    expect(library).toContain('#[cfg(feature = "phase1-conformance")]\npub mod conformance;');

    for (const control of controls) {
      expect(commands).not.toContain(control);
      expect(capability).not.toContain(control);
      expect(readText('src-tauri/build.rs')).not.toContain(control);
    }
  });

  it('pins Coven health to an isolated producer-client self probe without fallback trust', () => {
    const manifest = readText('src-tauri/Cargo.toml');
    const covenSource =
      readText('src-tauri/src/coven.rs').split('\n#[cfg(test)]\nmod tests')[0] ?? '';
    const nativeSource = [
      covenSource,
      readText('src-tauri/src/commands.rs'),
      readText('src-tauri/src/lib.rs'),
    ].join('\n');

    expect(manifest).toContain(
      'coven-client = { git = "https://github.com/OpenCoven/coven.git", rev = "721437b84026c042e431b0882dcd14fdb29ac07d" }',
    );
    expect(nativeSource).toContain('DaemonEndpoint::discover');
    expect(nativeSource).toContain('.health()');
    expect(nativeSource).toContain('std::env::current_exe()');
    expect(nativeSource).toContain('COVEN_HEALTH_PROBE_ARGUMENT');
    expect(nativeSource).toContain('Command::new(&request.executable)');
    expect(nativeSource).toContain('.stdin(Stdio::null())');
    expect(nativeSource).toContain('.stdout(Stdio::null())');
    expect(nativeSource).toContain('.stderr(Stdio::null())');
    expect(nativeSource).not.toMatch(
      /\b(?:powershell|pwsh|lsof|netstat|Get-NamedPipe|coven\.sock|\\\\\.\\pipe\\)\b/iu,
    );
    expect(nativeSource).not.toContain('set_hook');
    expect(nativeSource).not.toContain('take_hook');
  });

  it('checks every Rust target on a native Windows runner', () => {
    const workflow = readText('.github/workflows/ci.yml');
    const windowsRustJob = workflow.match(
      /\n {2}windows-rust:\n(?<job>[\s\S]*?)(?=\n {2}[a-z][\w-]*:\n|$)/,
    )?.groups?.job;

    expect(windowsRustJob).toContain('name: Windows Rust');
    expect(windowsRustJob).toContain('runs-on: windows-latest');
    expect(windowsRustJob).toContain('toolchain: 1.95.0');
    expect(windowsRustJob).toContain(
      '- run: cargo check --manifest-path src-tauri/Cargo.toml --all-targets',
    );
    expect(windowsRustJob).not.toContain('rustup target add');
  });

  it('keeps the capability schema resolvable from a fresh checkout', () => {
    const capability = readJson<CapabilityFile>('src-tauri/capabilities/default.json');
    const schemaPath = resolve(projectRoot, 'src-tauri/capabilities', capability.$schema ?? '');

    expect(capability.$schema).toBe('../gen/schemas/desktop-schema.json');
    expect(existsSync(schemaPath)).toBe(true);
    expect(readText('.gitignore')).toContain('!src-tauri/gen/schemas/desktop-schema.json');
    expect(
      execFileSync(
        'git',
        [
          '-C',
          projectRoot,
          'check-ignore',
          '-v',
          '--no-index',
          'src-tauri/gen/schemas/desktop-schema.json',
        ],
        {
          encoding: 'utf8',
        },
      ),
    ).toContain('!src-tauri/gen/schemas/desktop-schema.json');
  });

  it('autogenerates permissions only for the reviewed native command boundary', () => {
    const buildScript = readText('src-tauri/build.rs');

    for (const command of [
      'app_identity',
      'app_installation_id',
      'cave_read_discovery',
      'cave_cancel_operation',
      'cave_launch',
      'cave_health',
      'coven_health',
      'cave_pairing_create',
      'cave_pairing_poll',
      'cave_pairing_exchange',
      'cave_reset_pairing',
      'cave_credential_status',
      'cave_forget_credential',
      'cave_list_familiars',
      'cave_list_projects',
      'cave_list_conversations',
      'cave_get_conversation',
      'cave_list_conversation_messages',
    ]) {
      expect(buildScript).toContain(`"${command}"`);
    }
  });

  it('keeps the generated desktop schema aligned with the reviewed command table', () => {
    const schema = readText('src-tauri/gen/schemas/desktop-schema.json');
    const expectedCommands = [
      'app_identity',
      'app_installation_id',
      'cave_read_discovery',
      'cave_cancel_operation',
      'cave_launch',
      'cave_health',
      'coven_health',
      'cave_pairing_create',
      'cave_pairing_poll',
      'cave_pairing_exchange',
      'cave_reset_pairing',
      'cave_credential_status',
      'cave_forget_credential',
      'cave_list_familiars',
      'cave_list_projects',
      'cave_list_conversations',
      'cave_get_conversation',
      'cave_list_conversation_messages',
    ];
    const schemaCommands = [...schema.matchAll(/"const": "(?:allow|deny)-([^"]+)"/g)]
      .map((match) => match[1]?.replaceAll('-', '_') ?? '')
      .filter((command) => !command.startsWith('core_'))
      .sort();

    expect(schemaCommands).toEqual([...expectedCommands, ...expectedCommands].sort());
  });

  it('points Tauri devUrl at the production route instead of a demo query', () => {
    const config = readJson<{ build: { devUrl: string } }>('src-tauri/tauri.conf.json');

    expect(config.build.devUrl).toBe('http://127.0.0.1:4173/');
  });

  it('registers only narrow non-secret native connection commands', () => {
    const commands = readText('src-tauri/src/commands.rs');
    const lib = readText('src-tauri/src/lib.rs');
    const expected = [
      'app_identity',
      'app_installation_id',
      'cave_read_discovery',
      'cave_cancel_operation',
      'cave_launch',
      'cave_health',
      'coven_health',
      'cave_pairing_create',
      'cave_pairing_poll',
      'cave_pairing_exchange',
      'cave_reset_pairing',
      'cave_credential_status',
      'cave_forget_credential',
      'cave_list_familiars',
      'cave_list_projects',
      'cave_list_conversations',
      'cave_get_conversation',
      'cave_list_conversation_messages',
    ];

    expect(registeredCommandNames(commands)).toEqual(expected);
    expect(invokeHandlerCommandNames(lib)).toEqual(expected);

    for (const command of expected) {
      expect(lib).toContain(command);
    }

    expect(commands).not.toMatch(
      /pub\s+(?:async\s+)?fn\s+(?:generic_request|request|fetch|network)/,
    );
    expect(commands).not.toMatch(/(?:token|bearer|authorization|header)/i);
    for (const command of expected.filter(
      (command) =>
        command !== 'app_identity' &&
        command !== 'app_installation_id' &&
        command !== 'cave_read_discovery' &&
        command !== 'cave_cancel_operation' &&
        command !== 'cave_launch' &&
        command !== 'coven_health',
    )) {
      expect(commands).toMatch(
        new RegExp(`pub\\s+(?:async\\s+)?fn\\s+${command}\\s*\\(\\s*handle:\\s*String`),
      );
    }
    expect(commands).toMatch(
      /pub\s+fn\s+cave_cancel_operation\s*\(\s*attempt_id:\s*String,\s*reason:\s*NativeCancelReason/,
    );
    for (const command of expected.filter(
      (command) =>
        command !== 'app_identity' &&
        command !== 'app_installation_id' &&
        command !== 'cave_cancel_operation' &&
        command !== 'cave_launch' &&
        command !== 'cave_reset_pairing',
    )) {
      expect(commands).toMatch(
        new RegExp(
          `pub\\s+(?:async\\s+)?fn\\s+${command}\\s*\\([\\s\\S]{0,240}?operation:\\s*NativeOperationInput`,
        ),
      );
    }
    expect(commands).not.toMatch(/\b(?:origin|endpoint|url):\s*String/);
  });

  it('derives native identity name and identifier from tauri.conf.json', () => {
    const buildScript = readText('src-tauri/build.rs');
    const metadata = readText('src-tauri/src/metadata.rs');

    expect(buildScript).toContain('cargo:rerun-if-changed=tauri.conf.json');
    expect(buildScript).toContain('OPENCOVEN_PRODUCT_NAME');
    expect(buildScript).toContain('OPENCOVEN_APP_IDENTIFIER');
    expect(metadata).toContain('env!("OPENCOVEN_PRODUCT_NAME")');
    expect(metadata).toContain('env!("OPENCOVEN_APP_IDENTIFIER")');
  });

  it('pins Playwright to a dedicated fresh preview server', () => {
    const playwrightConfig = readText('playwright.config.ts');
    const packageManifest = readJson<PackageManifest>('package.json');

    expect(playwrightConfig).toContain("const previewUrl = 'http://127.0.0.1:4174';");
    expect(playwrightConfig).toMatch(/reuseExistingServer:\s*false/);
    expect(playwrightConfig).toMatch(/command:\s*'corepack pnpm build && corepack pnpm preview'/);
    expect(packageManifest.scripts?.['install:clean']).toBe(
      'corepack pnpm install --frozen-lockfile',
    );
    expect(packageManifest.scripts?.test).toBe('vitest run');
    expect(packageManifest.scripts?.preview).toContain('--port 4174');
  });

  it('keeps runtime source free from ad hoc Cave networking primitives', () => {
    const disallowedPatterns = [
      /\bfetch\s*\(/,
      /\bHeaders\b/,
      /\bAuthorization\b/,
      /\bBearer\b/,
      /https?:\/\//,
    ];

    const violations: string[] = [];

    for (const file of listRuntimeSourceFiles('src')) {
      const source = readText(file);

      for (const pattern of disallowedPatterns) {
        if (pattern.test(source)) {
          violations.push(`${file}: ${pattern}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });

  it('keeps native credential custody zeroizing, bounded, and cross-session safe', () => {
    const keyring = readText('src-tauri/src/keyring.rs');

    expect(keyring).toContain('Zeroizing');
    expect(keyring).toContain('get_secret');
    expect(keyring).toContain('set_secret');
    expect(keyring).not.toContain('.get_password()');
    expect(keyring).not.toContain('.set_password(');
    expect(keyring).toContain('CREDENTIAL_LOCK_TIMEOUT');
    expect(keyring).toContain('try_lock_exclusive');
    expect(keyring).not.toContain('.lock_exclusive()');
    expect(keyring).toContain('Global\\\\OpenCoven.Chat.');
    expect(keyring).toContain('Local\\\\');
    expect(keyring).toContain('LegacyWindowsMutexApi');
    expect(keyring).toContain('"persistence", "Local"');
    expect(keyring).toContain('SetEntriesInAclW');
    expect(keyring).toContain('GetSecurityInfo');
    expect(keyring).toContain('EqualSid');
    expect(keyring).not.toContain('entry.Trustee.TrusteeType');
    expect(keyring).toContain('STORE_INITIALIZED.get().is_none()');
    expect(keyring).not.toContain('STORE_AVAILABILITY');

    const transport = readText('src-tauri/src/transport.rs');
    const connection = readText('src-tauri/src/connection.rs');
    const hpke = readText('src-tauri/src/hpke_bound.rs');
    expect(transport).toContain('impl Drop for NativePairingCreated');
    expect(transport).toContain('impl Drop for NativePairingExchange');
    expect(transport).toContain('take_secret_string(&mut data, "secret")');
    expect(transport).toContain('take_secret_string(&mut data, "bearer")');
    expect(transport).toContain('let mut body = Zeroizing::new(Vec::new())');
    expect(connection).toContain('impl Drop for PendingPairing');
    expect(hpke).toContain('pub(crate) body: Zeroizing<Vec<u8>>');
    expect(hpke).toContain('let plaintext = Zeroizing::new(');
    expect(hpke).toContain('impl Drop for ResponsePlaintext');
    expect(hpke).toContain('base64url_decode_secret');
    expect(hpke).toContain('OneShotKeyMaterialRng');
    expect(hpke).toContain('response_ikm.zeroize()');
  });

  it('uses only frozen packed SDK artifacts at the browser boundary', () => {
    const packageManifest = readJson<PackageManifest>('package.json');
    const boundary = readText('src/lib/sdk/native-boundary.ts');

    expect(packageManifest.dependencies?.['@opencoven/cave-client']).toMatch(
      /^file:vendor\/opencoven-sdk\/cave-client-0\.1\.0\.tgz$/,
    );
    expect(packageManifest.dependencies?.['@opencoven/sdk-core']).toMatch(
      /^file:vendor\/opencoven-sdk\/sdk-core-0\.1\.0\.tgz$/,
    );
    expect(boundary).toContain("from '@opencoven/cave-client/managed'");
    expect(boundary).toContain("from '@opencoven/sdk-core/browser'");
    expect(boundary).not.toMatch(/(?:workspace:|\.cross-repo|packages\/|src\/)/);
  });

  it('runs the desktop entrypoint in CI with Linux Tauri dependencies', () => {
    // These dependencies moved out of an apt-get in this job and into the
    // image the job runs in. What has to stay true is that they are present
    // before `pnpm app:build` -- not where they came from -- so the guard
    // follows them rather than pinning the mechanism that used to supply them.
    const workflow = readText('.github/workflows/ci.yml');
    const dockerfile = readText('.github/ci-image/Dockerfile');

    expect(workflow).toMatch(/name:\s*Desktop build/);
    expect(workflow).toMatch(/- run: pnpm app:build/);

    for (const dependency of [
      'build-essential',
      'libayatana-appindicator3-dev',
      'libgtk-3-dev',
      'librsvg2-dev',
      'libwebkit2gtk-4.1-dev',
      'libxdo-dev',
      'patchelf',
      'pkg-config',
    ]) {
      expect(dockerfile, `${dependency} must be baked into the CI image`).toContain(dependency);
    }
  });

  it('installs no system packages while a pull request is waiting on it', () => {
    // Six runs hung on an apt-get that never returned, in two jobs whose only
    // shared property was calling it. Installing the packages ahead of time
    // does not make apt reliable; it moves the unreliability to a workflow
    // where hanging costs nobody a merge.
    //
    // Comments are stripped first: describing the history is the point of
    // those comments, and only what CI executes is under test here.
    const executable = readText('.github/workflows/ci.yml')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

    expect(executable, 'CI must not install system packages at job time').not.toContain('apt-get');
  });

  it('pins the CI image by digest so a rebuild cannot change what CI runs', () => {
    const workflow = readText('.github/workflows/ci.yml');
    const images = [...workflow.matchAll(/image: (\S+)/g)].map((match) => match[1]);

    expect(images.length, 'the containerised jobs are missing').toBeGreaterThan(0);

    for (const image of images) {
      // A moving tag would let a weekly rebuild change the compiler, the
      // browser and the system libraries under a green branch, with no commit
      // recording that anything changed.
      expect(image, 'the CI image must be pinned by digest').toMatch(
        /^ghcr\.io\/opencoven\/chat-ci@sha256:[0-9a-f]{64}$/,
      );
    }
  });

  it('builds the CI image from the Playwright version the suite pins', () => {
    // The image carries the browsers, so a bump to @playwright/test that does
    // not rebuild the image leaves the two disagreeing. The suite still runs
    // when they disagree -- it downloads the browser it wants -- which is
    // precisely why the drift needs a guard to be visible at all.
    const dockerfile = readText('.github/ci-image/Dockerfile');
    const packageManifest = readJson<PackageManifest>('package.json');
    const pinned = packageManifest.devDependencies?.['@playwright/test'];

    expect(pinned, '@playwright/test must be pinned').toBeDefined();

    const version = String(pinned).replace(/^\D*/, '');

    expect(dockerfile).toContain(`FROM mcr.microsoft.com/playwright:v${version}-noble`);
  });

  it('bounds every CI job so one stuck step cannot hold a runner all day', () => {
    // GitHub's default is six hours, which is not a timeout but a limit on the
    // damage. Desktop build had no ceiling and sat on a single step for
    // forty-seven minutes before it was killed by hand.
    const workflow = readText('.github/workflows/ci.yml');
    const jobsBlock = workflow.slice(workflow.indexOf('\njobs:'));
    const jobNames = [...jobsBlock.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]);
    const timeouts = jobsBlock.match(/^ {4}timeout-minutes: \d+$/gm) ?? [];

    expect(jobNames.length, 'no jobs were found').toBeGreaterThan(0);
    expect(timeouts, `every job needs a ceiling: ${jobNames.join(', ')}`).toHaveLength(
      jobNames.length,
    );
  });

  it('allows the isolated Phase 1 build and secure cleanup to finish on a cold runner', () => {
    const workflow = readText('.github/workflows/ci.yml');
    const phase1Job = workflow.slice(
      workflow.indexOf('  phase1-conformance:'),
      workflow.indexOf('\n  desktop:'),
    );

    expect(phase1Job).toContain('timeout-minutes: 120');
  });

  it('skips the expensive jobs for a branch that changed only prose', () => {
    // A documentation branch spent two twenty-minute E2E timeouts proving
    // nothing about documentation.
    const workflow = readText('.github/workflows/ci.yml');

    expect(workflow).toMatch(/^ {2}changes:$/m);
    expect(workflow).toContain('docs_only: $' + '{{ steps.classify.outputs.docs_only }}');

    const gated = workflow.match(/if: needs\.changes\.outputs\.docs_only != 'true'/g) ?? [];

    expect(
      gated,
      'E2E, Desktop build, macOS Rust, Windows Rust, and Phase 1 conformance are the jobs worth skipping',
    ).toHaveLength(5);

    // The classification has to fail towards running everything. A wrong guess
    // that way wastes a few minutes; the other way merges untested code.
    expect(workflow).toContain('No usable base commit; treating this as a code change.');
    expect(workflow).toContain('No files changed; treating this as a code change.');
    expect(workflow).toMatch(/\*\) docs_only=false ;;/);
  });

  it('proposes an image bump only after running the suites inside the new image', () => {
    // The pull request this opens cannot run CI on itself: a GITHUB_TOKEN
    // cannot trigger a workflow, by design. Without the verify job in front of
    // it the bump would be an untested dependency upgrade wearing a green
    // tick, which is worse than no automation at all.
    const workflow = readText('.github/workflows/ci-image.yml');

    expect(workflow).toMatch(/^ {2}verify:$/m);
    expect(workflow).toMatch(/^ {2}propose:$/m);
    expect(workflow).toContain('needs: [build, verify]');
    expect(workflow).toContain(
      'image: ghcr.io/opencoven/chat-ci@$' + '{{ needs.build.outputs.digest }}',
    );
    expect(workflow, 'the new image must run the suites it exists to serve').toContain(
      '- run: pnpm test:e2e',
    );
    expect(workflow).toContain('- run: pnpm app:build');

    // Only from the default branch. A feature branch proposing a digest for a
    // Dockerfile main has never seen would be proposing a build of itself.
    expect(workflow).toContain("github.ref_name == 'main'");
  });

  it('decides the image bump on contents rather than on a layer digest', () => {
    // A layer digest hashes a tar stream carrying file timestamps, so an
    // otherwise identical rebuild produces a new one. Comparing digests would
    // open a pull request every week that changed nothing, until nobody read
    // them and the weekly rebuild stopped meaning anything.
    const workflow = readText('.github/workflows/ci-image.yml');

    expect(workflow).toContain('io.opencoven.base-digest');
    expect(workflow).toMatch(/dpkg-query/);
    expect(workflow).toContain('changed=false');
    expect(workflow).toContain('changed=true');
  });

  it('commits the bump through the API, which is the only way it gets signed', () => {
    // A runner has no signing key, so `git commit` there produces the one
    // unverified commit in the history -- arriving weekly, forever. Commits
    // written through the contents API are signed by GitHub.
    const workflow = readText('.github/workflows/ci-image.yml');
    const proposeBlock = workflow.slice(workflow.indexOf('\n  propose:'));

    expect(proposeBlock).toContain('/contents/.github/workflows/ci.yml');
    expect(proposeBlock).toMatch(/-X PUT/);

    // Comments stripped, because the comment explaining why `git commit` is
    // not used here necessarily contains the words `git commit`.
    const executable = proposeBlock
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

    expect(executable, 'a runner cannot sign a commit').not.toMatch(/\bgit commit\b/);
  });

  it('bounds every job in the image workflow too', () => {
    // The image build is where apt-get is still allowed to hang. That is only
    // survivable because the hang ends.
    const workflow = readText('.github/workflows/ci-image.yml');
    const jobsBlock = workflow.slice(workflow.indexOf('\njobs:'));
    const jobNames = [...jobsBlock.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]);
    const timeouts = jobsBlock.match(/^ {4}timeout-minutes: \d+$/gm) ?? [];

    expect(jobNames.length, 'no jobs were found').toBeGreaterThan(0);
    expect(timeouts, `every job needs a ceiling: ${jobNames.join(', ')}`).toHaveLength(
      jobNames.length,
    );
  });

  it('runs one workflow per branch rather than racing the push and pull request events', () => {
    // Both triggers fire for a branch with an open pull request. Without a
    // shared concurrency group the two runs raced for the preview server's
    // fixed port and the loser hung indefinitely.
    //
    // The group must key off head_ref with a ref_name fallback: github.ref
    // differs between the two events, so grouping on it would leave the race
    // in place while looking like it had been fixed.
    const workflow = readText('.github/workflows/ci.yml');

    expect(workflow).toContain('concurrency:');
    expect(workflow).toContain(
      '${' + '{ github.workflow }}-${' + '{ github.head_ref || github.ref_name }}',
    );
    // main still verifies every merge to completion.
    expect(workflow).toContain('cancel-in-progress: ${' + "{ github.ref_name != 'main' }}");
  });

  it('reads counterpart repositories with a token that does not depend on their visibility', () => {
    // The default GITHUB_TOKEN is scoped to this repository, so it can only
    // read a counterpart that happens to be public. Relying on that has taken
    // this job down repeatedly when a sibling was switched to private.
    //
    // The fallback matters as much as the token: `secrets.X || github.token`
    // keeps the job working exactly as before when the secret is absent, so
    // this can land ahead of the credential rather than in lockstep with it.
    const workflow = readText('.github/workflows/ci.yml');
    const tokenLines = workflow.match(
      /token: \$\{\{ secrets\.CANARY_TOKEN \|\| github\.token \}\}/g,
    );

    expect(tokenLines, 'all cross-repository checkouts need the token').toHaveLength(5);
  });

  it('proves the packed harness installs with no network access', () => {
    // The offline install is the assertion, and the warm pass exists only so
    // that assertion is about the tarballs rather than about whether a fresh
    // runner's store happened to be seeded.
    //
    // The tempting fix for the CI failure was to drop --offline, which would
    // have gone green and silently stopped checking that the packed packages
    // are self-contained. This guard makes that regression fail here.
    const canaryScript = readText('scripts/contract-canary.mjs');

    expect(canaryScript).toContain("offline ? '--offline' : '--prefer-offline'");
    expect(canaryScript).toContain('installHarnessOfflineAfterWarming');

    const warmIndex = canaryScript.indexOf('isolatedInstallArgs({ offline: false })');
    const offlineIndex = canaryScript.indexOf('isolatedInstallArgs({ offline: true })');

    expect(warmIndex, 'the warm pass is missing').toBeGreaterThan(-1);
    expect(offlineIndex, 'the offline assertion is missing').toBeGreaterThan(-1);
    expect(warmIndex, 'the offline assertion must run after the warm pass').toBeLessThan(
      offlineIndex,
    );
  });

  it('defines a reproducible cross-repository packed-package canary', () => {
    const workflow = readText('.github/workflows/ci.yml');
    const packageManifest = readJson<PackageManifest>('package.json');
    const canaryScript = readText('scripts/contract-canary.mjs');

    expect(packageManifest.scripts?.['test:contract-canary']).toBe(
      'node ./scripts/contract-canary.mjs',
    );
    expect(workflow).toMatch(/name:\s*Contract canary/);
    expect(workflow).toContain(
      "import { readContractCanaryLock } from './scripts/contract-canary.mjs';",
    );
    expect(workflow).toContain('sdk_repository=$' + '{lock.sdk.repository}');
    expect(workflow).toContain(
      'repository: $' + '{{ steps.reviewed-revisions.outputs.sdk_repository }}',
    );
    expect(workflow).toContain('ref: $' + '{{ steps.reviewed-revisions.outputs.sdk_revision }}');
    expect(workflow).toContain('path: .cross-repo/sdk');
    expect(workflow).toContain('cave_repository=$' + '{lock.cave.repository}');
    expect(workflow).toContain(
      'repository: $' + '{{ steps.reviewed-revisions.outputs.cave_repository }}',
    );
    expect(workflow).toContain('ref: $' + '{{ steps.reviewed-revisions.outputs.cave_revision }}');
    expect(workflow).toContain('path: .cross-repo/coven-cave');
    expect(workflow).toMatch(
      /repository: \$\{\{ steps\.reviewed-revisions\.outputs\.cave_repository \}\}[\s\S]*?path: \.cross-repo\/coven-cave[\s\S]*?fetch-depth: 0/,
    );
    expect(workflow).not.toContain('OPENCOVEN_SDK_REVIEWED_REVISION');
    expect(workflow).not.toContain('OPENCOVEN_CAVE_REVIEWED_REVISION');
    expect(workflow).not.toContain('ref: main');
    expect(workflow).toContain('Read reviewed counterpart lock');
    expect(workflow).toContain('Assert checked-out reviewed revisions');
    expect(workflow).toContain('assertCleanContractCanaryCheckouts');
    expect(workflow).toContain('assertContractCanaryCheckoutHeads');
    expect(workflow).toContain('working-directory: .cross-repo/sdk');
    expect(workflow).toContain(
      'pnpm test:contract-canary -- --sdk-root .cross-repo/sdk --cave-root .cross-repo/coven-cave',
    );
    expect(canaryScript).toContain('contract-canary.lock.json');
    expect(canaryScript).toContain('create-release-artifacts.mjs');
    expect(canaryScript).toContain('Generated SDK release manifest');
    expect(canaryScript).toContain('verify-contracts.mjs');
    expect(canaryScript).toContain('parseVerifiedCaveContractFixture');
    expect(canaryScript).toContain('minimumClientVersion');
    expect(canaryScript).toContain('digest mismatch');
    expect(canaryScript).toContain('requires a clean checkout');
    expect(canaryScript).toContain('does not match locked reviewed revision');
  });

  it('pins third-party workflow actions to immutable SHAs', () => {
    const workflow = readText('.github/workflows/ci.yml');
    const uses = [...workflow.matchAll(/uses:\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([^\s#]+)/g)];

    expect(uses.length).toBeGreaterThan(0);

    for (const [, action, ref] of uses) {
      expect(ref, `${action} must be pinned to a full commit SHA.`).toMatch(/^[0-9a-f]{40}$/);
    }

    expect(workflow).toMatch(/actions\/checkout@[0-9a-f]{40}\s+# v4\.4\.0/);
    expect(workflow).toMatch(/pnpm\/action-setup@[0-9a-f]{40}\s+# v4\.4\.0/);
    expect(workflow).toMatch(/actions\/setup-node@[0-9a-f]{40}\s+# v4\.4\.0/);
    expect(workflow).toMatch(/dtolnay\/rust-toolchain@[0-9a-f]{40}\s+# stable/);
  });

  it('defines the packaged Phase 1 real-authority gate and sanitized evidence upload', () => {
    const workflow = readText('.github/workflows/ci.yml');
    const packageManifest = readJson<PackageManifest>('package.json');
    const phase1Job = workflow.slice(
      workflow.indexOf('  phase1-conformance:'),
      workflow.indexOf('\n  desktop:'),
    );

    expect(packageManifest.scripts?.['test:phase1-conformance']).toBe(
      'node ./scripts/phase1-conformance.mjs --lock ./phase1-conformance.lock.json --scenario all',
    );
    expect(workflow).toMatch(/^ {2}phase1-conformance:$/m);
    expect(workflow).toMatch(/name:\s*Phase 1 real-authority conformance/);
    expect(workflow).toContain('runs-on: macos-15');
    expect(workflow).toContain(
      "import { readPhase1ConformanceLock } from './scripts/phase1-conformance-lock.mjs';",
    );
    for (const repository of ['sdk', 'cave', 'coven']) {
      expect(workflow).toContain(
        `repository: \${{ steps.phase1-revisions.outputs.${repository}_repository }}`,
      );
      expect(workflow).toContain(
        `ref: \${{ steps.phase1-revisions.outputs.${repository}_revision }}`,
      );
      expect(workflow).toContain(
        `path: .phase1-counterparts/${repository === 'cave' ? 'coven-cave' : repository}`,
      );
    }
    expect(workflow).toContain('security create-keychain');
    expect(workflow).toContain('security unlock-keychain');
    expect(phase1Job).toMatch(/toolchain: 1\.95\.0\s+components: clippy,rustfmt/);
    expect(workflow).toMatch(/name:\s*Remove isolated Phase 1 keychain[\s\S]*?if:\s*always\(\)/);
    expect(workflow).toContain('pnpm test:phase1-conformance');
    expect(workflow).toContain(
      'node ./scripts/phase1-artifact-secret-scan.mjs --artifact-root ./test-results/phase1-conformance',
    );
    expect(workflow).toContain(
      'uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    );
    expect(workflow).toContain('path: test-results/phase1-conformance/report.json');
  });

  it('does not persist checkout credentials into the Phase 1 execution workspace', () => {
    const workflow = readText('.github/workflows/ci.yml');
    const phase1Job = workflow.slice(workflow.indexOf('  phase1-conformance:'));

    expect(phase1Job.match(/persist-credentials: false/g)).toHaveLength(4);
    expect(phase1Job).toContain('pnpm install --frozen-lockfile --ignore-scripts');
  });

  it('packages the Cave compatibility controls only for the Phase 1 harness', () => {
    const script = readText('scripts/phase1-conformance.mjs');

    expect(script).toContain("'build:conformance'");
    expect(script).not.toContain("'Cave release package', 'corepack', ['pnpm@10.34.0', 'build']");
  });

  it('documents immutable Phase 1 conformance separately from the Phase 0 canary', () => {
    const readme = readText('README.md');
    const toolchains = readText('docs/developer-toolchains.md');
    const guide = readText('docs/phase1-conformance.md');
    const tracker = readText(
      'docs/superpowers/plans/2026-08-15-opencoven-chat-program-tracking.md',
    );

    for (const document of [readme, toolchains, guide]) {
      expect(document).toContain('phase1-conformance.lock.json');
      expect(document).toContain('test:phase1-conformance');
    }
    expect(guide).toContain('phase1.operator.homes-credentials-untouched');
    expect(guide).toContain('secret scan');
    expect(guide).toContain('completed');
    expect(tracker).not.toContain(
      '/Users/buns/Documents/GitHub/OpenCoven/coven-cave/.worktrees/opencoven-chat-v1-tracking',
    );
    expect(tracker).toContain('/Users/buns/Documents/GitHub/OpenCoven/coven-cave');
  });
});
