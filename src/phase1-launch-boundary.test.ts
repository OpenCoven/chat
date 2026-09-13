import { expect, test } from 'vitest';
import {
  extractVerifiedRunnerDiagnostic,
  publicPhase1FailureDiagnostic,
} from '../scripts/phase1-conformance.mjs';
// @ts-expect-error Executable scripts have no declarations.
import * as producer from '../scripts/phase1-schema-v2-producer.mjs';

test.each(['initial-discovery', 'launch-rpc', 'discovery', 'health'])(
  'retains a bounded unknown launch failure at %s',
  (boundary) => {
    const cause = new Error('private response token/path');
    const failure = producer.retainSchemaV2NativeFailure(null, 'launch', cause, boundary);
    const diagnostic = `phase1.native-scenarios.launch.${boundary}-unknown`;
    expect(failure.message).toBe(diagnostic);
    expect(failure.cause).toBe(cause);
    expect(
      producer.schemaV2FailureDiagnostic(failure, 'phase1.stage.native-scenarios.failed'),
    ).toBe(diagnostic);
    expect(publicPhase1FailureDiagnostic(failure)).toBe(diagnostic);
    expect(extractVerifiedRunnerDiagnostic(`phase1-conformance: ${diagnostic}`)).toBe(diagnostic);
    expect(producer.retainSchemaV2NativeFailure(failure, 'pairing', new Error('later'))).toBe(
      failure,
    );
  },
);

test.each([
  ['initial-discovery', 'initial-discovery-timeout'],
  ['discovery', 'discovery-rpc-timeout'],
])('classifies read-discovery RPC timeout at %s', (boundary, category) => {
  const diagnostic = `phase1.native-scenarios.launch.${category}`;
  const failure = producer.retainSchemaV2NativeFailure(
    null,
    'launch',
    new Error('native RPC timed out for cave_read_discovery'),
    boundary,
  );
  expect(failure.message).toBe(diagnostic);
  expect(producer.schemaV2FailureDiagnostic(failure, 'phase1.stage.native-scenarios.failed')).toBe(
    diagnostic,
  );
  expect(publicPhase1FailureDiagnostic(failure)).toBe(diagnostic);
  expect(extractVerifiedRunnerDiagnostic(`phase1-conformance: ${diagnostic}`)).toBe(diagnostic);
});

test.each(['private-token', '__proto__', undefined, null, 7])(
  'rejects an unrecognized boundary %s',
  (boundary) => {
    expect(producer.schemaV2NativeFailureDiagnostic('launch', new Error('private'), boundary)).toBe(
      'phase1.native-scenarios.launch.unknown',
    );
  },
);

test('preserves an existing specific classification', () => {
  expect(
    producer.schemaV2NativeFailureDiagnostic(
      'launch',
      new Error('native RPC timed out for cave_launch'),
      'launch-rpc',
    ),
  ).toBe('phase1.native-scenarios.launch.timeout');
});
