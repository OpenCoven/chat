// @vitest-environment node
import { ChildProcess } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { afterEach, expect, test, vi } from 'vitest';
import {
  extractVerifiedRunnerDiagnostic,
  publicPhase1FailureDiagnostic,
  runPublicPhase1StageAsync,
} from '../scripts/phase1-conformance.mjs';
// @ts-expect-error The executable script intentionally has no declaration file.
import * as producer from '../scripts/phase1-schema-v2-producer.mjs';
import * as artifactRoot from '../scripts/process-owned-artifact-root.mjs';

const roots: artifactRoot.ProcessOwnedArtifactRoot[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root.rootPath, { recursive: true, force: true });
});

function root() {
  const value = artifactRoot.createProcessOwnedArtifactRoot({
    prefix: 'process-cleanup-diagnostic',
    terminationGraceMs: 1,
  });
  roots.push(value);
  return value;
}

function child(pid = 987654) {
  const value = new ChildProcess();
  Object.defineProperty(value, 'pid', { value: pid });
  value.kill = vi.fn(() => true);
  return value;
}

function classify(error: unknown) {
  const classifier = Reflect.get(artifactRoot, 'processCleanupFailureCategory');
  return typeof classifier === 'function' ? classifier(error) : undefined;
}

test.each(['child-terminate', 'supervisor-wait', 'child-kill', 'child-reap'])(
  'classifies %s and retains the root while the child remains live',
  async (category) => {
    const owned = root();
    const process = child();
    if (category === 'child-terminate') process.kill = vi.fn(() => false);
    if (category === 'supervisor-wait') {
      Object.assign(process, { __phase1SupervisorOwnsTree: true });
    }
    if (category === 'child-kill') process.kill = vi.fn((signal) => signal !== 'SIGKILL');
    owned.trackChild(process);
    const failure = await owned.cleanup().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect(classify(failure)).toBe(category);
    const diagnostic = producer.schemaV2FailureDiagnostic(
      failure,
      'phase1.stage.execution-root-cleanup.failed',
    );
    expect(diagnostic).toBe(`phase1.stage.execution-root-cleanup.${category}`);
    expect(publicPhase1FailureDiagnostic(new Error(diagnostic, { cause: failure }))).toBe(
      diagnostic,
    );
    expect(extractVerifiedRunnerDiagnostic(`phase1-conformance: ${diagnostic}`)).toBe(diagnostic);
    const wrapped = producer.wrapInfrastructureFailure(new Error(diagnostic, { cause: failure }), {
      status: 'failed',
    });
    const outer = await runPublicPhase1StageAsync(
      'phase1.stage.schema-v2-production.failed',
      async () => {
        throw wrapped;
      },
    ).catch((error: unknown) => error);
    expect(outer).toBe(wrapped);
    expect(publicPhase1FailureDiagnostic(outer)).toBe(diagnostic);

    expect(classify(failure)).not.toContain('987654');
    expect(existsSync(owned.rootPath)).toBe(true);
    if (category === 'supervisor-wait')
      expect(process.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    Object.defineProperty(process, 'exitCode', { value: 0 });
    await owned.cleanup();
    await owned.cleanup();
    expect(existsSync(owned.rootPath)).toBe(false);
  },
);

test('reports multiple failures while preserving reverse child cleanup order', async () => {
  const owned = root();
  const order: number[] = [];
  for (const pid of [987651, 987652]) {
    const process = child(pid);
    process.kill = vi.fn(() => {
      order.push(pid);
      return false;
    });
    owned.trackChild(process);
  }
  const failure = await owned.cleanup().catch((error: unknown) => error);
  expect(order).toEqual([987652, 987651]);
  expect(classify(failure)).toBe('multiple');
  expect((failure as AggregateError).errors).toHaveLength(2);
});

test('preserves the original private native cause without accepting forged aggregates', async () => {
  const owned = root();
  const process = child();
  const native = new Error('private-path-canary native-message');
  process.kill = vi.fn(() => {
    throw native;
  });
  owned.trackChild(process);
  const failure = await owned.cleanup().catch((error: unknown) => error);
  expect((failure as AggregateError).errors[0]).toBe(native);
  expect(classify(failure)).toBe('child-terminate');
  expect(classify(new AggregateError([native]))).toBe('unknown');
  expect(
    classify(Object.assign(new Error('child-terminate'), { category: 'child-terminate' })),
  ).toBe('unknown');
});

test('carries an actual owned-root precondition failure through cleanup aggregation', async () => {
  const owned = root();
  rmSync(owned.rootPath, { recursive: true });
  const failure = await owned.cleanup().catch((error: unknown) => error);
  expect(classify(failure)).toBe('root-precondition');
});

test('classifies a replaced tracked child and leaves its root for a later cleanup', async () => {
  const owned = root();
  const original = child();
  const replacement = child();
  original.kill = vi.fn(() => {
    Object.defineProperty(original, 'exitCode', { value: 0 });
    owned.trackChild(replacement);
    return true;
  });
  owned.trackChild(original);
  const failure = await owned.cleanup().catch((error: unknown) => error);
  expect(classify(failure)).toBe('tracked-set-changed');
  expect(existsSync(owned.rootPath)).toBe(true);
  Object.defineProperty(replacement, 'exitCode', { value: 0 });
  await owned.cleanup();
  expect(existsSync(owned.rootPath)).toBe(false);
});

test('does not infer a cleanup category from messages, properties, or cause chains', () => {
  const diagnostic = 'phase1.stage.execution-root-cleanup.root-rename';
  const forged = Object.assign(new Error(diagnostic), { category: 'root-rename' });
  for (const error of [forged, { cause: forged }, new AggregateError([forged]), diagnostic, null]) {
    expect(
      producer.schemaV2FailureDiagnostic(error, 'phase1.stage.execution-root-cleanup.failed'),
    ).toBe('phase1.stage.execution-root-cleanup.unknown');
  }
  expect(
    extractVerifiedRunnerDiagnostic(
      'phase1-conformance: phase1.stage.execution-root-cleanup.private-path-canary',
    ),
  ).toBeUndefined();
});
