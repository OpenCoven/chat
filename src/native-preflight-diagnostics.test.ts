import { expect, test, vi } from 'vitest';

const producerPath = '../scripts/phase1-schema-v2-producer.mjs';
const { runNativePreflight, schemaV2NativeFailureDiagnostic } = await import(producerPath);

const proof = {
  backend: 'windows-credential-manager',
  available: true,
  empty: true,
  stateSha256: 'a'.repeat(64),
};
const installationId = '12345678-1234-4123-8123-123456789abc';

test.each([
  ['custody-rpc', 'native-preflight-custody-rpc'],
  ['custody-proof', 'native-preflight-custody-proof'],
  ['installation-rpc', 'native-preflight-installation-rpc'],
  ['installation-id', 'native-preflight-installation-id'],
])('retains the bounded native preflight boundary for %s', async (failure, expected) => {
  const privateError = new Error('private account and credential detail');
  const rpc = {
    ok: vi.fn(async (command: string) => {
      if (command === 'conformance_native_custody_state') {
        if (failure === 'custody-rpc') throw privateError;
        return failure === 'custody-proof' ? { ...proof, empty: false } : proof;
      }
      if (failure === 'installation-rpc') throw privateError;
      return failure === 'installation-id' ? 'private-invalid-id' : installationId;
    }),
  };
  let stage = '';
  let error: unknown;
  try {
    await runNativePreflight(rpc, proof.backend, (value: string) => {
      stage = value;
    });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect(stage).toBe(expected);
  expect(schemaV2NativeFailureDiagnostic(stage, error)).toBe(`phase1.native-scenarios.${expected}`);
  if (failure.endsWith('rpc')) expect(error).toBe(privateError);
  expect(rpc.ok).toHaveBeenCalledTimes(failure.startsWith('custody') ? 1 : 2);
});

test('preserves successful native preflight values and request order', async () => {
  const rpc = { ok: vi.fn().mockResolvedValueOnce(proof).mockResolvedValueOnce(installationId) };
  expect(await runNativePreflight(rpc, proof.backend, () => {})).toEqual({
    nativeStateBefore: proof,
    installationId,
  });
  expect(rpc.ok.mock.calls).toEqual([
    ['conformance_native_custody_state', { instanceIds: [] }],
    ['app_installation_id'],
  ]);
});

test.each(['custody-rpc', 'custody-proof', 'installation-rpc', 'installation-id'])(
  'preserves native preflight %s through the outer public boundary',
  async (operation) => {
    const producerPath = '../scripts/phase1-schema-v2-producer.mjs';
    const harnessPath = '../scripts/phase1-conformance.mjs';
    const producer = await import(producerPath);
    const harness = await import(harnessPath);
    const diagnostic = `phase1.native-scenarios.native-preflight-${operation}`;
    const privateCause = new Error('private native custody value');
    const failure = await producer
      .runSchemaV2StageAsync(diagnostic, async () => {
        throw privateCause;
      })
      .catch((error: Error) => error);
    const wrapped = producer.wrapInfrastructureFailure(failure, {});
    const caught = await harness
      .runPublicPhase1StageAsync('phase1.stage.schema-v2-production.failed', async () => {
        throw wrapped;
      })
      .catch((error: Error) => error);
    expect(caught).toBe(wrapped);
    expect(harness.publicPhase1FailureDiagnostic(caught)).toBe(diagnostic);
    expect(failure.cause).toBe(privateCause);
    expect(caught.message).not.toContain('private');
  },
);
