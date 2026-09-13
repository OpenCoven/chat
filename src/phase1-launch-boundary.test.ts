import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
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

// Execute the production launch block with controlled RPC failures so boundary
// assignments, their order, and the catch path are covered without native state.
const producerSource = readFileSync(
  resolve(import.meta.dirname, '../scripts/phase1-schema-v2-producer.mjs'),
  'utf8',
);
const launchStart = producerSource.indexOf("    activeNativeStage = 'launch';");
const launchEnd = producerSource.indexOf("    activeNativeStage = 'pairing';", launchStart);
const launchScenario = producerSource.slice(launchStart, launchEnd);

test.each(['initial-discovery', 'launch-rpc', 'discovery', 'health'])(
  'runtime launch block reports a failure injected at %s',
  async (boundary) => {
    expect(launchStart).toBeGreaterThan(0);
    expect(launchEnd).toBeGreaterThan(launchStart);
    const cause = new Error('injected private failure');
    const calls: string[] = [];
    const visit = (operation: string) => {
      calls.push(operation);
      if (operation === boundary) throw cause;
    };
    const outcome = await runInNewContext(
      `(async () => {
        let activeNativeStage, handle, scenarioFailure = null;
        const observations = {}, nativeInstanceIds = new Set(), results = [];
        ${launchScenario}
        return { scenarioFailure, results };
      })()`,
      {
        classifyInitialDiscoveryOutcome: producer.classifyInitialDiscoveryOutcome,
        retainSchemaV2NativeFailure: producer.retainSchemaV2NativeFailure,
        observeInitialDiscoverySafety: async () => null,
        waitForDiscovery: async () => {
          visit('discovery');
          return { handle: 'test-handle' };
        },
        rpc: {
          operation: () => 'test-operation',
          request: async (command: string) => {
            expect(command).toBe('cave_read_discovery');
            visit('initial-discovery');
            return { ok: false, error: { code: 'cave_discovery_not_found' } };
          },
          ok: async (command: string) => {
            expect(['cave_launch', 'cave_health']).toContain(command);
            visit(command === 'cave_launch' ? 'launch-rpc' : 'health');
            return { apiVersion: '1.0', data: { pairingRequired: true } };
          },
        },
        process: { platform: 'win32', stderr: { write: () => {} } },
        addAssertion: (results: string[], _id: string, status: string) => results.push(status),
      },
    );
    const ordered = ['initial-discovery', 'launch-rpc', 'discovery', 'health'];
    expect(calls).toEqual(ordered.slice(0, ordered.indexOf(boundary) + 1));
    expect(outcome.results).toEqual(['failed']);
    expect(outcome.scenarioFailure.cause).toBe(cause);
    expect(publicPhase1FailureDiagnostic(outcome.scenarioFailure)).toBe(
      `phase1.native-scenarios.launch.${boundary}-unknown`,
    );
  },
);
