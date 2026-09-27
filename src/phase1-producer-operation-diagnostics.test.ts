import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, test } from 'vitest';
import {
  extractVerifiedRunnerDiagnostic,
  publicPhase1FailureDiagnostic,
  runPublicPhase1StageAsync,
} from '../scripts/phase1-conformance.mjs';
// @ts-expect-error The executable script intentionally has no declaration file.
import * as producer from '../scripts/phase1-schema-v2-producer.mjs';

const operations = [
  'failure-assertions',
  'native-cleanup-assertions',
  'required-assertions',
  'execution-cleanup-assertions',
];
const modulePath = '../scripts/phase1-schema-v2-producer.mjs';

// Execute the actual orchestration body with external work replaced at its
// dependency boundaries. No authority checkout, credentials or native process
// is needed to exercise failures during unwinding.
function injectedProducer(overrides: Record<string, unknown>) {
  const source = readFileSync(resolve('scripts/phase1-schema-v2-producer.mjs'), 'utf8');
  const declaration = source.slice(source.indexOf('export async function runSchemaV2Conformance'));
  const noop = () => undefined;
  return runInNewContext(`(${declaration.replace(/^export /u, '')})`, {
    Error,
    AggregateError,
    Map,
    Date,
    process: { platform: 'win32', arch: 'x64', env: {} },
    projectRoot: '/fixture',
    resolve,
    ...producer,
    scrubEvidenceAuthorizationEnvironment: noop,
    requirePhase1HarnessAuthorityVerification: noop,
    schemaV2SupervisorEnvironment: () => ({}),
    supervisorArtifactOutputPath: () => '/fixture/record.json',
    assertWindowsJobMembership: noop,
    resolveDefaultSourceRoots: (options: unknown) => options,
    resolveRepositoryLayout: noop,
    resolveOperatorHomes: () => ({}),
    captureOperatorFilesystemState: () => ({}),
    createProcessOwnedArtifactRoot: () => ({ rootPath: '/fixture', cleanup: async () => {} }),
    safeEnvironment: () => ({}),
    createExactCheckouts: async () => {
      throw new Error('private checkout detail');
    },
    fillMissingAssertions: noop,
    addAssertion: noop,
    makeAssertion: () => ({}),
    ...overrides,
  }) as (options: object, lock: object) => Promise<unknown>;
}

const options = { platform: 'win32-x64', outputPath: '/fixture/record.json' };
const lock = { version: 5 };
const outerStage = 'phase1.stage.schema-v2-production.failed';

describe('schema-v2 operation diagnostics', () => {
  test('accepts every fixed producer native-stage diagnostic without admitting arbitrary suffixes', () => {
    for (const diagnostic of producer.SCHEMA_V2_NATIVE_FAILURE_DIAGNOSTICS) {
      expect(publicPhase1FailureDiagnostic(new Error(diagnostic))).toBe(diagnostic);
      expect(extractVerifiedRunnerDiagnostic(`phase1-conformance: ${diagnostic}`)).toBe(diagnostic);
    }
    expect(Object.isFrozen(producer.SCHEMA_V2_NATIVE_FAILURE_DIAGNOSTICS)).toBe(true);
    expect(
      publicPhase1FailureDiagnostic(new Error('phase1.native-scenarios.private-value')),
    ).toBeUndefined();
  });

  test.each(['native-preflight', 'pairing-recovery', 'revocation-repair'])(
    'preserves the actual producer native %s classification through the outer runner',
    async (stage) => {
      const cause = new Error('/private/native-operation');
      const diagnostic = producer.schemaV2NativeFailureDiagnostic(stage, cause);
      expect(diagnostic).toBe(`phase1.native-scenarios.${stage}`);
      const nativeFailure = new Error(diagnostic, { cause });
      const wrapped = producer.wrapInfrastructureFailure(nativeFailure, { status: 'failed' });
      const caught = await runPublicPhase1StageAsync(outerStage, async () => {
        throw wrapped;
      }).catch((error: unknown) => error);
      expect(publicPhase1FailureDiagnostic(caught)).toBe(diagnostic);
      expect(extractVerifiedRunnerDiagnostic(`phase1-conformance: ${diagnostic}`)).toBe(diagnostic);
      expect(caught).toBe(wrapped);
    },
  );

  test('retains the classified checkout failure when failure bookkeeping throws', async () => {
    const secondary = new Error('/private/bookkeeping');
    const run = injectedProducer({
      fillMissingAssertions: () => {
        throw secondary;
      },
    });
    const caught = await runPublicPhase1StageAsync(outerStage, () => run(options, lock)).catch(
      (error: unknown) => error,
    );
    expect(publicPhase1FailureDiagnostic(caught)).toBe('phase1.stage.checkouts.failed');
    expect(caught).toBeInstanceOf(AggregateError);
    const errors = (caught as AggregateError).errors;
    expect(errors[1].message).toBe(
      'phase1.stage.schema-v2-production.operation.failure-assertions',
    );
    expect(errors[1].cause).toBe(secondary);
  });

  test.each(['required-assertions', 'execution-cleanup-assertions'])(
    'retains the primary failure when actual %s bookkeeping fails',
    async (operation) => {
      const secondary = new Error('/private/finalization');
      const overrides: Record<string, unknown> =
        operation === 'required-assertions'
          ? {
              addAssertion: () => {
                throw secondary;
              },
            }
          : {
              Map: class extends Map {
                constructor() {
                  super();
                  this.set('fixture', { status: 'passed' });
                }
              },
              createProcessOwnedArtifactRoot: () => ({
                rootPath: '/fixture',
                cleanup: async () => {
                  throw new Error('private cleanup');
                },
              }),
              makeAssertion: () => {
                throw secondary;
              },
            };
      const run = injectedProducer(overrides);
      const caught = await runPublicPhase1StageAsync(outerStage, () => run(options, lock)).catch(
        (error: unknown) => error,
      );
      expect(publicPhase1FailureDiagnostic(caught)).toBe('phase1.stage.checkouts.failed');
      expect(caught).toBeInstanceOf(AggregateError);
      expect((caught as AggregateError).errors[1].message).toBe(
        `phase1.stage.schema-v2-production.operation.${operation}`,
      );
      expect((caught as AggregateError).errors[1].cause).toBe(secondary);
    },
  );

  test('preserves the first failure when native cleanup bookkeeping throws', async () => {
    const secondary = new Error('/private/native-cleanup');
    const noop = () => ({});
    const run = injectedProducer({
      process: { platform: 'darwin', arch: 'arm64', env: {} },
      createExactCheckouts: async () => ({ validatorIdentity: { tree: 'fixture' } }),
      validateSchemaV2AuthorityCheckouts: noop,
      loadSdkEvidenceContract: async () => ({
        frozenLock: { toolchain: {} },
        contract: { assertEvidenceProducerCompatibility: noop },
      }),
      assertSdkContractMatchesPhase1Lock: noop,
      verifySchemaV2ProducerCheckout: noop,
      collectFrozenEvidenceArtifacts: noop,
      verifiedCheckoutIdentity: noop,
      collectToolchainMetadata: noop,
      packageLockedArtifacts: noop,
      runSchemaV2ObservationSuites: noop,
      runCaveAuthorityMatrix: noop,
      recordCaveBackedAssertions: (results: Map<string, unknown>) => {
        results.set('fixture', { status: 'passed' });
      },
      runCompatibilityScenarios: noop,
      prepareMacosKeychainSession: () => ({
        close: () => {
          throw new Error('private native cleanup');
        },
      }),
      bindMacosKeychainSessionEnvironment: noop,
      runNativeScenarios: noop,
      runCovenIdentityScenario: () => {
        throw new Error('private coven failure');
      },
      makeAssertion: () => {
        throw secondary;
      },
    });
    const caught = await runPublicPhase1StageAsync(outerStage, () =>
      run({ ...options, platform: 'darwin-arm64' }, lock),
    ).catch((error: unknown) => error);
    expect(publicPhase1FailureDiagnostic(caught)).toBe('phase1.stage.coven-identity.failed');
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors[1].message).toBe(
      'phase1.stage.schema-v2-production.operation.native-cleanup-assertions',
    );
    expect((caught as AggregateError).errors[1].cause).toBe(secondary);
  });

  test.each(operations)(
    'bounds %s failures and retains private causes in memory',
    async (operation) => {
      const { runSchemaV2FinalizationOperation } = await import(modulePath);
      const failure = new Error('/private/credentials');
      const diagnostic = `phase1.stage.schema-v2-production.operation.${operation}`;
      const caught = await runPublicPhase1StageAsync(outerStage, async () =>
        runSchemaV2FinalizationOperation(operation, () => {
          throw failure;
        }),
      ).catch((error: unknown) => error);
      expect(publicPhase1FailureDiagnostic(caught)).toBe(diagnostic);
      expect(extractVerifiedRunnerDiagnostic(`phase1-conformance: ${diagnostic}`)).toBe(diagnostic);
      expect((caught as Error).cause).toBe(failure);
      expect((caught as Error).message).not.toContain('private');
    },
  );

  test('does not accept a caller-supplied private operation name', async () => {
    const { runSchemaV2FinalizationOperation } = await import(modulePath);
    let called = false;
    expect(() =>
      runSchemaV2FinalizationOperation('/private/name', () => {
        called = true;
      }),
    ).toThrow('phase1.stage.schema-v2-production.operation.invalid');
    expect(called).toBe(false);
  });

  test('returns successful bookkeeping without replacing an existing primary failure', async () => {
    const { runSchemaV2FinalizationOperation } = await import(modulePath);
    expect(
      runSchemaV2FinalizationOperation('required-assertions', () => 42, new Error('primary')),
    ).toBe(42);
  });
});
