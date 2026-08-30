import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

function workflowJobs(workflow: string) {
  const jobsBlock = workflow.slice(workflow.indexOf('\njobs:'));
  const headers = [...jobsBlock.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)];

  return new Map(
    headers.map((header, index) => {
      const start = header.index ?? 0;
      const end = headers[index + 1]?.index ?? jobsBlock.length;

      return [header[1], jobsBlock.slice(start, end)];
    }),
  );
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
    expect(lock.cave.revision).toBe('6325fc4c1154c7d7398074a9760a2e2dc323b424');
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
        sha256: 'c0b1af2442409f8b26bbf0cf2a5fac467d23e5f56d2c966a9428c4b3e830a186',
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
    const controls = [
      'conformance_native_custody_state',
      'conformance_issue_native_custody_cleanup',
      'conformance_cleanup_native_custody',
      'conformance_reset_native_state',
      'conformance_shutdown',
    ];

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

    const conformance = readText('src-tauri/src/conformance.rs');
    const producer = readText('scripts/phase1-schema-v2-producer.mjs');
    expect(conformance).toContain('"conformance_issue_native_custody_cleanup"');
    expect(conformance).toMatch(
      /"conformance_cleanup_native_custody"[\s\S]*?expect_exact_args\(object, &\["grant"\]\)/,
    );
    expect(producer).toContain("rpc.ok('conformance_issue_native_custody_cleanup'");
    expect(producer).toContain("rpc.ok('conformance_cleanup_native_custody', { grant })");
    expect(producer).toContain('const cleanupInstanceIds = [...nativeInstanceIds].sort();');
    expect(producer).toContain('issued.grant = undefined;');
    expect(producer).toContain('grant = undefined;');
    expect(producer).not.toContain(
      "rpc.ok('conformance_cleanup_native_custody', {\n                instanceIds:",
    );
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

  it('checks every Rust target for the Windows GNU target in package scripts and CI', () => {
    const packageManifest = readJson<PackageManifest>('package.json');
    const workflow = readText('.github/workflows/ci.yml');
    const rustJob = workflow.match(/\n {2}rust:\n(?<job>[\s\S]*?)(?=\n {2}[a-z][\w-]*:\n|$)/)
      ?.groups?.job;
    if (rustJob === undefined) {
      throw new Error('Rust CI job is missing.');
    }

    expect(packageManifest.scripts?.['cargo:check:windows-gnu']).toBe(
      'cargo check --manifest-path src-tauri/Cargo.toml --target x86_64-pc-windows-gnu --all-targets',
    );
    expect(rustJob).toContain(
      '- run: cargo check --manifest-path src-tauri/Cargo.toml --all-targets',
    );
    expect(rustJob).toContain('- run: rustup target add x86_64-pc-windows-gnu');
    expect(rustJob).toContain('name: Install pinned Windows GNU toolchain');
    expect(rustJob).toContain('HOMEBREW_BOTTLE_DOMAIN: https://ghcr.io/v2/homebrew/core');
    expect(rustJob).toContain('HOMEBREW_NO_INSTALL_FROM_API: "1"');
    expect(rustJob).toContain('cd168d1fdc26f12e4ad64f358ff2dbec61ab7a57');
    expect(rustJob).toContain('mingw-w64 14.0.0_3');
    expect(rustJob).toContain('0d68ab737a8bbc8c63ac6ac7acc0695e2887c1169df9a4423f1180090079b1d5');
    expect(rustJob).toContain("grep -F '2.47.20260726'");
    expect(rustJob).toContain(`formula="\${RUNNER_TEMP}/mingw-w64.rb"`);
    expect(rustJob).toContain(
      `https://raw.githubusercontent.com/Homebrew/homebrew-core/\${core_revision}/Formula/m/mingw-w64.rb`,
    );
    expect(rustJob).toContain('798631311a841e0639469f3f95a5287c8747f7a354e79a47ac39d6bf20eefe34');
    expect(rustJob).toContain(
      `bottle="\${RUNNER_TEMP}/mingw-w64--14.0.0_3.arm64_tahoe.bottle.tar.gz"`,
    );
    expect(rustJob).toContain(
      'https://ghcr.io/v2/homebrew/core/mingw-w64/blobs/sha256:0d68ab737a8bbc8c63ac6ac7acc0695e2887c1169df9a4423f1180090079b1d5',
    );
    expect(rustJob).toContain(`HOMEBREW_DEVELOPER=1 brew install --force-bottle "\${bottle}"`);
    expect(rustJob).not.toMatch(/\bgit\b[^\n]*(?:checkout|reset|switch)\b/u);
    expect(rustJob).not.toMatch(/\bbrew tap\b/u);
    expect(rustJob).not.toContain('brew --repo homebrew/core');
    expect(rustJob).not.toContain('HOMEBREW_INTERNAL_ALLOW_PACKAGES_FROM_PATHS');
    expect(rustJob).not.toContain(`brew install --force-bottle "\${formula}"`);
    expect(rustJob).not.toContain('brew install --force-bottle opencoven/frozen/mingw-w64');
    expect(rustJob).not.toMatch(/run:\s*brew install mingw-w64\s*$/mu);
    expect(rustJob).toContain('existing mingw-w64 installation was not removed');
    expect(rustJob.indexOf('brew uninstall --force mingw-w64')).toBeLessThan(
      rustJob.indexOf('HOMEBREW_DEVELOPER=1 brew install'),
    );
    expect(rustJob).toContain('name: Verify Windows GNU resource compiler');
    expect(rustJob).toContain('run: command -v x86_64-w64-mingw32-windres');
    expect(rustJob).toContain('- run: corepack pnpm cargo:check:windows-gnu');
    expect(rustJob?.indexOf('command -v x86_64-w64-mingw32-windres')).toBeLessThan(
      rustJob?.indexOf('corepack pnpm cargo:check:windows-gnu') ?? -1,
    );
  });

  it('fetches full history for Rust locked-source verification', () => {
    const workflow = readText('.github/workflows/ci.yml');
    const rustJob = workflow.match(/\n {2}rust:\n(?<job>[\s\S]*?)(?=\n {2}[a-z][\w-]*:\n|$)/)
      ?.groups?.job;

    expect(rustJob).toMatch(
      /actions\/checkout@[0-9a-f]{40}[^\n]*\n {8}with:\n {10}fetch-depth: 0/u,
    );
    expect(rustJob).toContain('Windows supervisor source does not match the immutable lock.');
  });

  it('fetches full history for Web locked-harness verification', () => {
    const workflow = readText('.github/workflows/ci.yml');
    const webJob = workflow.match(/\n {2}web:\n(?<job>[\s\S]*?)(?=\n {2}[a-z][\w-]*:\n|$)/)?.groups
      ?.job;

    expect(webJob).toMatch(/actions\/checkout@[0-9a-f]{40}[^\n]*\n {8}with:\n {10}fetch-depth: 0/u);
    expect(webJob).toContain('- run: pnpm test:unit');
  });

  it('uses a POSIX shell fixture without exposing Node internal descriptors to status forgery', () => {
    const testSource = readText('src/phase1-conformance.test.ts');
    const start = testSource.indexOf(
      'supervisor status cannot be forged through the legacy environment or target fd3',
    );
    const end = testSource.indexOf(
      'rejects a forged success frame when supervisor group kill fails',
      start,
    );
    const fixture = testSource.slice(start, end);

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(fixture).toContain("runSupervisedCommandForTest(root, '/bin/sh'");
    expect(fixture).toContain('OPENCOVEN_PHASE1_SUPERVISOR_STATUS_PATH');
    expect(fixture).toContain('>&3');
    expect(fixture).toContain('result: expect.objectContaining({ code: 7 })');
    expect(fixture).toContain('expect(existsSync(legacyStatusPath)).toBe(false)');
    expect(fixture).not.toContain('process.execPath');
    expect(fixture).not.toContain("readlinkSync('/proc/self/fd/3')");
    expect(fixture).not.toContain('writeSync(3');
  });

  it('checks out both authority launchers with immutable LF bytes', () => {
    const launcherPaths = [
      'scripts/phase1-conformance-launcher.sh',
      'scripts/phase1-conformance-launcher.ps1',
    ];
    const attributes = execFileSync('git', ['check-attr', 'text', 'eol', '--', ...launcherPaths], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    const lock = readJson<{
      harnessAuthority: { files: Array<{ path: string; sha256: string }> };
    }>('phase1-conformance.lock.json');

    for (const path of launcherPaths) {
      expect(attributes).toContain(`${path}: text: set`);
      expect(attributes).toContain(`${path}: eol: lf`);
      const authority = lock.harnessAuthority.files.find((file) => file.path === path);
      expect(authority, `${path} must be bound by harness authority.`).toBeDefined();
      expect(
        createHash('sha256')
          .update(readFileSync(resolve(projectRoot, path)))
          .digest('hex'),
      ).toBe(authority?.sha256);
    }
  });

  it('keeps the frozen Windows supervisor in an isolated bin-only Cargo graph', () => {
    const crateRoot = resolve(projectRoot, 'tools/phase1-process-supervisor');
    const manifest = readText('tools/phase1-process-supervisor/Cargo.toml');
    const metadata = JSON.parse(
      execFileSync('cargo', ['metadata', '--locked', '--no-deps', '--format-version', '1'], {
        cwd: crateRoot,
        encoding: 'utf8',
      }),
    ) as { workspace_root: string; packages: Array<{ name: string }> };
    const workflow = readText('.github/workflows/ci.yml');
    const docs = readText('docs/phase1-conformance.md');
    const lock = readJson<{
      tools: { windowsSupervisor: { artifact: { buildInvocation: string } } };
    }>('phase1-conformance.lock.json');

    expect(manifest).not.toContain('[lib]');
    expect(manifest).not.toContain('opencoven-chat');
    expect(metadata.workspace_root).toBe(crateRoot);
    expect(metadata.packages.map(({ name }) => name)).toEqual(['phase1-process-supervisor']);
    expect(workflow.match(/working-directory: tools\/phase1-process-supervisor/gu)).toHaveLength(3);
    expect(workflow).toContain(
      'SOURCE_DATE_EPOCH=0 cargo build \\\n            --target x86_64-pc-windows-gnu',
    );
    expect(workflow).toContain('cargo metadata \\\n            --locked');
    expect(workflow).toContain('cargo check --locked');
    expect(workflow).toContain('cargo test --locked');
    expect(workflow).toContain('cargo clippy --locked -- -D warnings');
    expect(lock.tools.windowsSupervisor.artifact.buildInvocation).toBe(
      'cd tools/phase1-process-supervisor && SOURCE_DATE_EPOCH=0 cargo build --target x86_64-pc-windows-gnu --release --locked',
    );
    for (const source of [workflow, docs, lock.tools.windowsSupervisor.artifact.buildInvocation]) {
      expect(source).not.toMatch(
        /--manifest-path\s+(?:tools\/phase1-process-supervisor\/)?Cargo\.toml/u,
      );
    }
  }, 60_000);

  it('runs the frozen supervisor behavioral gate on windows-2025', () => {
    const workflow = readText('.github/workflows/ci.yml');
    const testSource = readText('src/phase1-windows-supervisor.test.ts');
    const harnessSource = readText('scripts/phase1-conformance.mjs');
    const job = workflow.match(
      /\n {2}windows-supervisor-behavior:\n(?<job>[\s\S]*?)(?=\n {2}[a-z][\w-]*:\n|$)/,
    )?.groups?.job;

    expect(job).toContain('runs-on: windows-2025');
    expect(job).toContain('needs: [changes, rust]');
    expect(job).toContain('actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093');
    expect(job).toContain('dtolnay/rust-toolchain@4360b52568e2003a75bf9bc1d59f33a8e3fc893c');
    expect(job).toContain('C:\\OpenCoven\\conformance\\phase1-process-supervisor.exe');
    expect(job).toContain('372b3e8b5b860e0759da8fa10ddfb6ec338e26d83616254c816a456ae2e1b7c5');
    expect(job).toContain(
      'corepack pnpm@10.34.0 --ignore-workspace exec vitest run --config vitest.heavy.config.ts src/phase1-windows-supervisor.test.ts',
    );
    expect(testSource).toContain("describe.skipIf(process.platform !== 'win32')");
    expect(testSource).toContain(
      'bootstrapWindowsSupervisor({ windowsSupervisorPath: helperPath })',
    );
    expect(testSource).toContain('function safeRunnerEnvironment()');
    expect(testSource).toContain('normalizeWindowsRealPathForProcess(realpathSync(orderedCom))');
    expect(testSource).toContain("'missing', 'wrong-file', 'wrong-size', 'wrong-digest'");
    expect(testSource).toContain('await settleAbsent(marker)');
    expect(testSource).toContain('expect(liveSeparate.signalCode).toBeNull()');
    expect(testSource).toContain('expect(processIsOpenable(liveSeparate.pid)).toBe(true)');
    expect(testSource).toContain('assertFleetHelperUnchanged()');
    expect(testSource).toContain('expect(readdirSync(owned.path)).toEqual([])');
    expect(testSource).toContain('const helperDirectory = dirname(helperPath)');
    expect(testSource).toContain('linkSync(helperPath, backup)');
    expect(testSource).toContain('expect(dirname(backup)).toBe(helperDirectory)');
    expect(testSource).toContain('expect(existsSync(backup)).toBe(false)');
    expect(testSource).toContain("['rustup', 'git', 'cargo', 'corepack']");
    expect(testSource).toContain("['ambiguous', 'missing', 'path-injection']");
    expect(testSource).toContain(
      "['&', '|', '<', '>', '(', ')', '^', '%', '!', '\"', '\\r', '\\n', '\\0']",
    );
    expect(testSource).toContain("'valid spaced arg'");
    expect(testSource).toContain("['exe', 'com', 'cmd', 'bat']");
    expect(testSource).toContain('ignores malicious PATH-precedence corepack.%s');
    expect(testSource).toContain('Explicit Windows Corepack shim requests are forbidden.');
    expect(workflow).toContain('OPENCOVEN_PHASE1_TEST_KEYCHAIN_ISOLATED: "1"');
    expect(harnessSource).toMatch(
      /export function bootstrapWindowsSupervisor\(options\)[\s\S]*configureWindowsSupervisor\(options, lock\)[\s\S]*export async function runPhase1Conformance[\s\S]*phase1\.stage\.lock\.failed[\s\S]*bootstrapWindowsSupervisor\(options\)/,
    );
  });

  it('runs the real reservation broken-pipe probe only with the isolated macOS keychain', () => {
    const workflow = readText('.github/workflows/ci.yml');
    const nativeRpcTest = readText('src-tauri/tests/phase1_native_rpc.rs');

    expect(workflow).toContain(
      'security default-keychain -d user | sed \'s/^[[:space:]]*"//; s/"$//\'',
    );
    expect(workflow).toContain('OPENCOVEN_PHASE1_TEST_KEYCHAIN_ISOLATED: "1"');
    expect(nativeRpcTest).toContain('#[cfg(target_os = "macos")]');
    expect(nativeRpcTest).toContain(
      'subprocess_prepare_broken_pipe_removes_real_isolated_keychain_marker',
    );
    expect(nativeRpcTest).toContain('ai.opencoven.chat.conformance-cleanup');
    expect(nativeRpcTest).toContain('conformance_delete_native_credential');
  });

  it('allows external execution only through platform supervisor bootstraps', () => {
    const workflow = readText('.github/workflows/ci.yml');
    for (const path of [
      'scripts/phase1-conformance.mjs',
      'scripts/phase1-conformance-lock.mjs',
      'scripts/process-owned-artifact-root.mjs',
    ]) {
      const source = readText(path);
      expect(source).not.toMatch(/\bexecFile(?:Sync)?\b|\bspawnSync\b|\bsystem\b/);
    }
    const harness = readText('scripts/phase1-conformance.mjs');
    expect(harness.match(/\bspawn\(/g)).toHaveLength(2);
    const bootstrap = readText('scripts/supervised-exec.mjs');
    expect(bootstrap).toContain('spawnSync(');
    expect(bootstrap).toContain('phase1-process-supervisor.mjs');
    expect(harness).toContain("from './executable-resolution.mjs'");
    expect(bootstrap).toContain("from './executable-resolution.mjs'");
    const resolution = readText('scripts/executable-resolution.mjs');
    expect(resolution).toContain('quoteWindowsBatchCommand(resolved.path, args)');
    expect(resolution).toContain(
      "throw new Error('Canonical Windows Corepack installation is unavailable.')",
    );
    expect(resolution).toContain('Explicit Windows Corepack shim requests are forbidden.');
    expect(resolution.indexOf("if (requestedBase === 'corepack')")).toBeLessThan(
      resolution.indexOf('const resolved = resolveWindowsCommand(command, environment)'),
    );
    expect(resolution).not.toMatch(/\bexecFile|\bspawn|\bsystem\b/);
    const supervisor = readText('scripts/phase1-process-supervisor.mjs');
    expect(supervisor).toContain('writeSync(3, frame)');
    expect(supervisor).toContain("stdio: ['inherit', 'inherit', 'inherit', 'ignore']");
    expect(harness).not.toContain('OPENCOVEN_PHASE1_SUPERVISOR_STATUS_PATH');
    expect(bootstrap).not.toContain('OPENCOVEN_PHASE1_SUPERVISOR_STATUS_PATH');
    expect(harness).toContain('bootstrapVerifiedRunner(options)');
    expect(harness).toContain('assertExecutingHarnessAuthority(lock)');
    const posixLauncher = readText('scripts/phase1-conformance-launcher.sh');
    const windowsLauncher = readText('scripts/phase1-conformance-launcher.ps1');
    expect(posixLauncher).toContain('exec /usr/bin/env -i');
    expect(posixLauncher).not.toContain('NODE_OPTIONS=');
    expect(windowsLauncher).toContain('$start.Environment.Clear()');
    expect(windowsLauncher).not.toContain("'NODE_OPTIONS'");
    expect(windowsLauncher).toContain('C:\\Program Files\\PowerShell\\7\\pwsh.exe');
    expect(windowsLauncher.indexOf('IsPathFullyQualified($rawHelper)')).toBeLessThan(
      windowsLauncher.indexOf('GetFullPath($rawHelper)'),
    );
    expect(workflow).toContain('88e184d465eaf7bd6ce828dcc81ecadb11b6222f01576c56090060085820e7b2');
    expect(workflow).toContain('99eea6108e59db9a0ac12368787fb6e6456e6af4f8cce09ee96ce117ca3f475e');
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
    expect(packageManifest.scripts?.test).toBe(
      'corepack pnpm@10.34.0 --ignore-workspace test:unit',
    );
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

  it('executes the phase1 native cleanup grant integration suite on Windows', () => {
    const workflow = readText('.github/workflows/ci.yml');
    const windowsRust = workflow.slice(workflow.indexOf('  windows-supervisor-behavior:'));

    expect(windowsRust).toContain(
      'cargo check --manifest-path src-tauri/Cargo.toml --all-targets --all-features',
    );
    expect(windowsRust).toContain('corepack pnpm test:native-e2e');
  });

  it('treats FILE_DELETE_CHILD as an unsafe Windows directory mutation right', () => {
    const cave = readText('src-tauri/src/cave.rs');
    const rights = cave.slice(
      cave.indexOf('    fn writable_file_rights() -> u32 {'),
      cave.indexOf(
        '\n    fn trusted_writer(',
        cave.indexOf('    fn writable_file_rights() -> u32 {'),
      ),
    );

    expect(rights).toContain('| FILE_DELETE_CHILD');
  });

  it('skips the expensive jobs for a branch that changed only prose', () => {
    // A documentation branch spent two twenty-minute E2E timeouts proving
    // nothing about documentation.
    const workflow = readText('.github/workflows/ci.yml');

    expect(workflow).toMatch(/^ {2}changes:$/m);
    expect(workflow).toContain('docs_only: $' + '{{ steps.classify.outputs.docs_only }}');

    const gatedJobs = [...workflowJobs(workflow)]
      .filter(([, job]) => /^ {4}if: needs\.changes\.outputs\.docs_only != 'true'$/m.test(job))
      .map(([name]) => name);

    expect(gatedJobs).toEqual([
      'e2e',
      'phase1-conformance',
      'desktop',
      'rust',
      'unix-supervisor',
    ]);

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

    expect(tokenLines, 'all cross-repository checkouts need the token').toHaveLength(6);
  });

  it('does not persist checkout credentials into CI worktrees', () => {
    const workflow = readText('.github/workflows/ci.yml');
    const lines = workflow.split('\n');
    const checkoutSteps: string[] = [];

    for (const [index, line] of lines.entries()) {
      if (!line.includes('- uses: actions/checkout@')) {
        continue;
      }

      const stepIndent = line.indexOf('-');
      let end = index + 1;
      while (end < lines.length) {
        const candidate = lines[end] ?? '';
        const trimmed = candidate.trimStart();
        const indent = candidate.length - trimmed.length;

        if (
          trimmed.length > 0 &&
          (indent < stepIndent || (indent === stepIndent && trimmed.startsWith('- ')))
        ) {
          break;
        }
        end += 1;
      }

      checkoutSteps.push(lines.slice(index, end).join('\n'));
    }

    expect(checkoutSteps.length, 'CI must retain checkout steps').toBeGreaterThan(0);
    for (const checkout of checkoutSteps) {
      expect(checkout.match(/persist-credentials/g)).toHaveLength(1);
      expect(checkout).toMatch(/^\s+persist-credentials:\s*false\s*$/m);
    }
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
    const phase1Job = workflow.match(
      /\n {2}phase1-conformance:\n(?<job>[\s\S]*?)(?=\n {2}[a-z][\w-]*:\n|$)/,
    )?.groups?.job;

    expect(packageManifest.scripts?.['test:phase1-conformance']).toBe(
      'node ./scripts/phase1-conformance.mjs --lock ./phase1-conformance.lock.json --scenario all',
    );
    expect(workflow).toMatch(/^ {2}phase1-conformance:$/m);
    expect(workflow).toMatch(/name:\s*Phase 1 real-authority conformance/);
    expect(workflow).toContain('runs-on: macos-15');
    expect(phase1Job).toMatch(
      /dtolnay\/rust-toolchain@[0-9a-f]{40}[\s\S]*?toolchain: 1\.95\.0[\s\S]*?components: clippy,rustfmt/u,
    );
    expect(readText('scripts/phase1-conformance.mjs')).toContain(
      `resolve(rustupHome, 'toolchains', \`1.95.0-\${triple}\`, 'bin')`,
    );
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
    expect(workflow).toContain(
      'repository: $' + '{{ steps.phase1-revisions.outputs.evidence_repository }}',
    );
    expect(workflow).toContain('ref: $' + '{{ steps.phase1-revisions.outputs.evidence_revision }}');
    expect(workflow).toContain('path: .phase1-counterparts/sdk-evidence');
    expect(workflow).toContain(
      'OPENCOVEN_SDK_EVIDENCE_ROOT: $' + '{{ github.workspace }}/.phase1-counterparts/sdk-evidence',
    );
    expect(workflow).toContain('security create-keychain');
    expect(workflow).toContain('security unlock-keychain');
    expect(workflow).toMatch(/name:\s*Remove isolated Phase 1 keychain[\s\S]*?if:\s*always\(\)/);
    expect(workflow).toContain('id: phase1-keychain-cleanup');
    expect(workflow.indexOf('name: Remove isolated Phase 1 keychain')).toBeLessThan(
      workflow.indexOf('name: Upload sanitized Phase 1 report'),
    );
    expect(workflow).toContain('/bin/sh scripts/phase1-conformance-launcher.sh');
    expect(workflow).toContain('node_path="$(command -v node)"');
    expect(workflow).not.toContain('pnpm test:phase1-conformance');
    expect(workflow).toContain(
      'node ./scripts/phase1-artifact-secret-scan.mjs --artifact-root ./test-results/phase1-conformance',
    );
    expect(readText('scripts/phase1-conformance.mjs')).toContain(
      "['pnpm@10.34.0', '--ignore-workspace', 'build']",
    );
    expect(readText('scripts/phase1-conformance.mjs')).toContain(
      'NODE_OPTIONS: caveBuildNodeOptions',
    );
    expect(readText('scripts/phase1-conformance.mjs')).toContain(
      'CIRCLE_NODE_TOTAL: caveBuildReportedCpuTotal',
    );
    expect(readText('scripts/phase1-conformance.mjs')).toContain(
      'TMPDIR: dirname(artifactRoot.rootPath)',
    );
    expect(workflow).toContain(
      'uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02',
    );
    expect(workflow).toContain('path: test-results/phase1-conformance/report.json');
  });

  it('runs Git-heavy Phase 1 Vitest files once in a serial one-worker project', () => {
    const packageManifest = readJson<PackageManifest>('package.json');
    const defaultConfig = readText('vitest.config.ts');
    const heavyConfig = readText('vitest.heavy.config.ts');
    const workflow = readText('.github/workflows/ci.yml');
    expect(packageManifest.scripts?.test).toBe(
      'corepack pnpm@10.34.0 --ignore-workspace test:unit',
    );
    expect(packageManifest.scripts?.['test:unit']).toBe(
      'corepack pnpm@10.34.0 --ignore-workspace test:unit:normal && corepack pnpm@10.34.0 --ignore-workspace test:unit:heavy',
    );
    expect(packageManifest.scripts?.['test:unit:heavy']).toBe(
      'vitest run --config vitest.heavy.config.ts',
    );
    for (const file of [
      'src/phase1-conformance.test.ts',
      'src/phase1-conformance-lock.test.ts',
      'src/phase1-conformance-artifact-root.test.ts',
      'src/phase1-windows-supervisor.test.ts',
    ]) {
      expect(defaultConfig).toContain(`'${file}'`);
      expect(heavyConfig).toContain(`'${file}'`);
    }
    expect(heavyConfig).toContain('fileParallelism: false');
    expect(heavyConfig).toContain('maxWorkers: 1');
    expect(workflow.match(/pnpm test:unit/g)).toHaveLength(1);
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
      expect(document).toContain('phase1-conformance-launcher');
    }
    expect(guide).toContain('phase1-native-rpc');
    expect(guide).toContain('coven_health');
    expect(guide).toContain('coven daemon status');
    expect(guide).toContain('secret scan');
    expect(guide).toContain('darwin-arm64');
    expect(guide).toContain('win32-x64');
    expect(guide).toContain('completed');
    expect(guide).toMatch(/VC\.Tools\.x86\.x64` component version\s+`17\.14\.36510\.44/u);
    expect(guide).toContain('debug runtime version `14.44.35211');
    expect(guide).toMatch(/compiler toolset directory version is\s+`14\.44\.35207/u);
    expect(guide).not.toContain('VC\\Tools\\MSVC\\14.50.35717');
    expect(guide).not.toContain('VC\\Tools\\MSVC\\14.44.35211');
    expect(tracker).not.toContain(
      '/Users/buns/Documents/GitHub/OpenCoven/coven-cave/.worktrees/opencoven-chat-v1-tracking',
    );
    expect(tracker).toContain('/Users/buns/Documents/GitHub/OpenCoven/coven-cave');
  });
});
