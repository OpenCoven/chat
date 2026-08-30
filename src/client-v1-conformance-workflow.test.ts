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
    const sources = [
      embeddedWindowsSupervisorSource(workflow),
      readFileSync(resolve(projectRoot, 'scripts', 'windows-job-supervisor.cs'), 'utf8'),
    ];

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

    expect(windowsJob).toContain('name: Test Windows Job Object supervision');
    expect(windowsJob).toContain(
      'pwsh -NoLogo -NoProfile -NonInteractive -File scripts/windows-job-supervisor.test.ps1',
    );
  });

  test('pins and verifies the complete supervised Windows bootstrap and evidence tree', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const bootstrap = workflowStep(workflow, 'Bootstrap supervised Windows conformance');

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
    ]) {
      expect(bootstrap).toContain(required);
    }
    expect(bootstrap).not.toMatch(/\b(?:curl|wget|Invoke-WebRequest)\b/u);
    expect(bootstrap).not.toContain('http://');
    expect(bootstrap).toMatch(/[0-9a-f]{64}/u);
  });
});
