import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
// @ts-expect-error The production harness is a JavaScript module without declarations.
import * as producer from '../scripts/phase1-schema-v2-producer.mjs';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sdk-diagnostic-'));
  roots.push(root);
  return { root, report: join(root, 'report.json') };
}
test('command timeout preserves primary category without reading a report', () => {
  const { root, report } = fixture();
  const error = new producer.CommandExecutionError('SDK schema-v2 observation tests', {
    reason: 'timeout',
  });
  expect(producer.classifySdkObservationFailure(error, report, root)).toBe('command.timeout');
});
test('nonzero with a passing report remains a command failure', () => {
  const { root, report } = fixture();
  writeFileSync(report, JSON.stringify({ success: true, testResults: [] }));
  const error = new producer.CommandExecutionError('SDK schema-v2 observation tests', { code: 1 });
  expect(producer.classifySdkObservationFailure(error, report, root)).toBe(
    'command.nonzero.report.empty',
  );
});
test('failed known file emits only a fixed identifier', () => {
  const { root, report } = fixture();
  writeFileSync(
    report,
    JSON.stringify({
      success: false,
      testResults: [
        {
          name: join(root, 'tests/coven-discovery.spec.ts'),
          status: 'failed',
          assertionResults: [],
        },
      ],
    }),
  );
  expect(producer.classifySdkObservationFailure(new Error('private'), report, root)).toBe(
    'report.failed.coven-discovery',
  );
});
test('unknown report paths never become public diagnostics', () => {
  const { root, report } = fixture();
  writeFileSync(
    report,
    JSON.stringify({
      success: false,
      testResults: [
        {
          name: '/private/token/tests/coven-discovery.spec.ts',
          status: 'failed',
          assertionResults: [],
        },
      ],
    }),
  );
  expect(producer.classifySdkObservationFailure(new Error('private'), report, root)).toBe(
    'report.not-successful',
  );
});

test.each([
  ['tracking', 'command.tracking'],
  ['stdout-limit', 'command.output-limit'],
  ['stderr-limit', 'command.output-limit'],
  ['spawn', 'command.spawn'],
  ['untrusted-private-reason', 'unknown'],
])('bounds command reason %s', (reason, expected) => {
  const { root, report } = fixture();
  expect(
    producer.classifySdkObservationFailure(
      new producer.CommandExecutionError('SDK schema-v2 observation tests', { reason }),
      report,
      root,
    ),
  ).toBe(expected);
});
test.each([
  ['{', 'invalid-json'],
  ['null', 'malformed'],
  ['{"success":false,"testResults":[]}', 'empty'],
])('bounds report failures %s', (text, category) => {
  const { root, report } = fixture();
  writeFileSync(report, text);
  const result = producer.classifySdkObservationFailure(new Error('private'), report, root);
  expect(result).toBe(`report.${category}`);
  expect(
    producer.schemaV2FailureDiagnostic(
      new Error(`phase1.runtime-observations.sdk-tests.${result}`),
      'phase1.runtime-observations.sdk-tests.failed',
    ),
  ).toBe(`phase1.runtime-observations.sdk-tests.${result}`);
});

test('rejects unsafe and oversized diagnostic reports', () => {
  const { root, report } = fixture();
  const classify = () => producer.classifySdkObservationFailure(new Error('private'), report, root);
  expect(classify()).toBe('report.missing');
  mkdirSync(report);
  expect(classify()).toBe('report.unsafe-file');
  rmSync(report, { recursive: true });
  writeFileSync(report, Buffer.alloc(4 * 1024 * 1024 + 1));
  expect(classify()).toBe('report.oversize');
  rmSync(report);
  symlinkSync(join(root, 'missing-private-target'), report);
  expect(classify()).toBe('report.unsafe-file');
});
test('selects failed files in fixed order with separator normalization', () => {
  const { root, report } = fixture();
  const files = ['coven-discovery', 'cave-canonical-reads'].map((id) => ({
    name: join(root, `tests/${id}.spec.ts`).replaceAll('/', String.fromCharCode(92)),
    status: 'failed',
    assertionResults: [{ status: 'failed', title: 'private token' }],
  }));
  for (const testResults of [files, [...files].reverse()]) {
    writeFileSync(report, JSON.stringify({ success: false, testResults }));
    expect(producer.classifySdkObservationFailure(new Error('private'), report, root)).toBe(
      'report.failed.cave-canonical-reads',
    );
  }
});
test('a successful report cannot mask nonzero command exit', () => {
  const { root, report } = fixture();
  writeFileSync(
    report,
    JSON.stringify({
      success: true,
      testResults: [
        {
          name: join(root, 'tests/client-contract.spec.ts'),
          status: 'passed',
          assertionResults: [],
        },
      ],
    }),
  );
  expect(
    producer.classifySdkObservationFailure(
      new producer.CommandExecutionError('SDK schema-v2 observation tests', { code: 1 }),
      report,
      root,
    ),
  ).toBe('command.nonzero.report.claims-success');
});

test('observation wrapper preserves successful assertion sets and rejects nonzero', async () => {
  const { root, report } = fixture();
  writeFileSync(
    report,
    JSON.stringify({
      success: true,
      testResults: [
        {
          name: join(root, 'tests/client-contract.spec.ts'),
          status: 'passed',
          assertionResults: [{ status: 'passed', ancestorTitles: ['contract'], title: 'read' }],
        },
      ],
    }),
  );
  const options = {
    artifactRoot: { rootPath: root },
    rootPath: root,
    environment: {},
    label: 'SDK schema-v2 observation tests',
    files: ['tests/client-contract.spec.ts'],
    outputName: 'report.json',
  };
  await expect(producer.runVitestObservationSuite(options, async () => {})).resolves.toEqual(
    new Set(['contract > read']),
  );
  await expect(
    producer.runVitestObservationSuite(options, async () => {
      throw new producer.CommandExecutionError(options.label, { code: 1 });
    }),
  ).rejects.toThrow('phase1.runtime-observations.sdk-tests.command.nonzero.report.claims-success');
});
test.each(['ENOENT', 'EACCES', 'EPERM', 'EINVAL', 'E2BIG', 'ENOMEM', 'PRIVATE'])(
  'bounds spawn code %s',
  (spawnCode) => {
    const { root, report } = fixture();
    const result = producer.classifySdkObservationFailure(
      new producer.CommandExecutionError('SDK schema-v2 observation tests', {
        reason: 'spawn',
        spawnCode,
      }),
      report,
      root,
    );
    expect(result).toBe(
      spawnCode === 'PRIVATE' ? 'command.spawn' : `command.spawn.${spawnCode.toLowerCase()}`,
    );
  },
);
test('every registered SDK diagnostic survives both public allowlists', async () => {
  const parent = await import('../scripts/phase1-conformance.mjs');
  const ids = [
    'command.spawn',
    'command.tracking',
    'command.timeout',
    'command.output-limit',
    'command.signal',
    'unknown',
    ...['enoent', 'eacces', 'eperm', 'einval', 'e2big', 'enomem'].map((x) => `command.spawn.${x}`),
  ];
  const categories = [
    'missing',
    'unreadable',
    'unsafe-file',
    'oversize',
    'invalid-json',
    'malformed',
    'empty',
    'not-successful',
    'claims-success',
    ...[
      'cave-discovery-pairing',
      'cave-canonical-reads',
      'cave-hpke-bound-v1',
      'cave-managed-native',
      'cave-managed-native-staged',
      'coven-discovery',
      'health-validation',
      'client-contract',
      'native-secret-store',
    ].map((x) => `failed.${x}`),
  ];
  for (const suffix of [
    ...ids,
    ...['report', 'command.nonzero.report'].flatMap((prefix) =>
      categories.map((x) => `${prefix}.${x}`),
    ),
  ]) {
    const id = `phase1.runtime-observations.sdk-tests.${suffix}`;
    expect(
      producer.schemaV2FailureDiagnostic(
        new Error(id),
        'phase1.runtime-observations.sdk-tests.failed',
      ),
    ).toBe(id);
    expect(parent.extractVerifiedRunnerDiagnostic(`phase1-conformance: ${id}`)).toBe(id);
  }
});
