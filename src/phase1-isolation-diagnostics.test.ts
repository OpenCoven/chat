import { describe, expect, test } from 'vitest';
import {
  extractVerifiedRunnerDiagnostic,
  publicPhase1FailureDiagnostic,
  runPublicPhase1StageAsync,
} from '../scripts/phase1-conformance.mjs';
import { buildIsolationEvidence } from '../scripts/phase1-evidence-runtime.mjs';
// @ts-expect-error The executable script intentionally has no declaration file.
import * as producer from '../scripts/phase1-schema-v2-producer.mjs';

type Input = Parameters<typeof buildIsolationEvidence>[0];
const prefix = 'phase1.stage.evidence-authority.isolation';
const ids = ['cave-home', 'coven-home', 'projects'] as const;
function input(): Input {
  const state = {
    'cave-home': { path: '/private/cave', sha256: 'a'.repeat(64) },
    'coven-home': { path: '/private/coven', sha256: 'b'.repeat(64) },
    projects: { path: '/private/projects', sha256: 'c'.repeat(64) },
  };
  return {
    operatorBefore: structuredClone(state),
    operatorAfter: structuredClone(state),
    nativeBeforeSha256: 'd'.repeat(64),
    nativeAfterSha256: 'd'.repeat(64),
    opaqueIds: ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32), '4'.repeat(32)],
  };
}
const cases: Array<{ name: string; category: string; mutate: (value: Input) => void }> = [
  {
    name: 'missing opaque root',
    category: 'opaque-ids.invalid',
    mutate: (v) => {
      v.opaqueIds.pop();
    },
  },
  {
    name: 'private opaque root',
    category: 'opaque-ids.invalid',
    mutate: (v) => {
      v.opaqueIds[0] = '/private/root';
    },
  },
  {
    name: 'duplicate opaque roots',
    category: 'opaque-ids.duplicate',
    mutate: (v) => {
      v.opaqueIds[0] = '2'.repeat(32);
    },
  },
  {
    name: 'invalid native before digest',
    category: 'native-credential-store.invalid',
    mutate: (v) => {
      v.nativeBeforeSha256 = '/private/credential';
    },
  },
  {
    name: 'invalid native after digest',
    category: 'native-credential-store.invalid',
    mutate: (v) => {
      v.nativeAfterSha256 = '/private/credential';
    },
  },
  {
    name: 'changed native digest',
    category: 'native-credential-store.changed',
    mutate: (v) => {
      v.nativeAfterSha256 = 'e'.repeat(64);
    },
  },
];
for (const id of ids) {
  for (const side of ['operatorBefore', 'operatorAfter'] as const) {
    cases.push({
      name: `${id} missing ${side}`,
      category: `operator.${id}.invalid`,
      mutate: (v) => {
        Reflect.deleteProperty(v[side], id);
      },
    });
    cases.push({
      name: `${id} invalid ${side} digest`,
      category: `operator.${id}.invalid`,
      mutate: (v) => {
        v[side][id].sha256 = '/private/digest';
      },
    });
  }
  cases.push({
    name: `${id} path mismatch`,
    category: `operator.${id}.path`,
    mutate: (v) => {
      v.operatorAfter[id].path = '/private/replacement';
    },
  });
  cases.push({
    name: `${id} digest mismatch`,
    category: `operator.${id}.changed`,
    mutate: (v) => {
      v.operatorAfter[id].sha256 = 'f'.repeat(64);
    },
  });
}

describe('bounded evidence isolation diagnostics', () => {
  test.each(cases)('preserves $name through the public runner', async ({ category, mutate }) => {
    const value = input();
    mutate(value);
    let failure: unknown;
    try {
      producer.runSchemaV2PreflightStage(`${prefix}.failed`, () => buildIsolationEvidence(value));
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    const diagnostic = `${prefix}.${category}`;
    const wrapped = producer.wrapInfrastructureFailure(failure, {});
    const caught = await runPublicPhase1StageAsync(
      'phase1.stage.schema-v2-production.failed',
      async () => {
        throw wrapped;
      },
    ).catch((error: unknown) => error);
    expect(publicPhase1FailureDiagnostic(caught)).toBe(diagnostic);
    expect(extractVerifiedRunnerDiagnostic(`phase1-conformance: ${diagnostic}`)).toBe(diagnostic);
    expect((caught as Error).message).toBe(diagnostic);
    expect((failure as Error).cause).toBeInstanceOf(Error);
    expect(((failure as Error).cause as Error).message).toBe(diagnostic);
  });

  test.each([
    'operator.private.changed',
    'operator.cave-home.changed.private',
    'native-credential-store.changed.private',
  ])('rejects arbitrary category %s', (suffix) => {
    const diagnostic = `${prefix}.${suffix}`;
    expect(publicPhase1FailureDiagnostic(new Error(diagnostic))).toBeUndefined();
    expect(extractVerifiedRunnerDiagnostic(`phase1-conformance: ${diagnostic}`)).toBeUndefined();
    expect(producer.schemaV2FailureDiagnostic(new Error(diagnostic), `${prefix}.failed`)).toBe(
      `${prefix}.failed`,
    );
  });
});
