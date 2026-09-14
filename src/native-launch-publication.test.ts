import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, test } from 'vitest';
import { publicPhase1FailureDiagnostic } from '../scripts/phase1-conformance.mjs';
// @ts-expect-error The executable script intentionally has no declaration file.
import * as producer from '../scripts/phase1-schema-v2-producer.mjs';

const { NativeRpcClient, retainSchemaV2NativeFailure, schemaV2FailureDiagnostic } = producer;

const prefix = '[cave] client-v1 discovery publication refused: ';
const categories = [
  'disabled-other',
  'root-owner-unverified',
  'root-owner-shared',
  'target-owner-unverified',
  'target-owner-shared',
  'root-not-directory',
  'root-symlink',
  'target-not-file',
  'endpoint-invalid',
  'authority-init',
];

class LaunchChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  chunks: Buffer[] = [];
  code = 'cave_launch_discovery_not_found';
  readonly stdin = {
    write: (line: string) => {
      const request = JSON.parse(line) as { id: string };
      for (const chunk of this.chunks) this.stderr.write(chunk);
      this.stdout.write(
        `${JSON.stringify({ id: request.id, ok: false, error: { code: this.code } })}\n`,
      );
      return true;
    },
  };
}

async function launchFailure(client: { ok(command: string): Promise<unknown> }) {
  return client.ok('cave_launch').then(
    () => {
      throw new Error('Expected launch failure');
    },
    (error: unknown) => retainSchemaV2NativeFailure(undefined, 'launch', error, 'launch-rpc'),
  );
}

describe('native launch publication observation', () => {
  test.each(categories)(
    'retains only the finite %s refusal through both public gates',
    async (category) => {
      const child = new LaunchChild();
      child.chunks = [Buffer.from(`${prefix}${category}\r`), Buffer.from('\n')];
      const failure = await launchFailure(new NativeRpcClient(child));
      const expected = `phase1.native-scenarios.launch.discovery-not-found.publication.${category}`;
      expect(failure.message).toBe(expected);
      expect(schemaV2FailureDiagnostic(failure)).toBe(expected);
      expect(publicPhase1FailureDiagnostic(failure)).toBe(expected);
    },
  );

  test.each([
    '',
    `${prefix}root-owner-shared`,
    `noise ${prefix}root-owner-shared\n`,
    `${prefix}root-owner-shared private-secret\n`,
    `${prefix}private-secret\n`,
    `${prefix}not-observed\n`,
    `${prefix}output-limit\n`,
    `${prefix}root-owner-shared\nprivate-secret`,
  ])('never forwards private stderr or accepts a malformed line: %j', async (text) => {
    const child = new LaunchChild();
    child.chunks = [Buffer.from(text)];
    const failure = await launchFailure(new NativeRpcClient(child));
    const category =
      text === `${prefix}root-owner-shared\nprivate-secret` ? 'root-owner-shared' : 'not-observed';
    expect(failure.message).toBe(
      `phase1.native-scenarios.launch.discovery-not-found.publication.${category}`,
    );
    expect(failure.message).not.toContain('private-secret');
  });

  test('retains the first complete refusal across every byte boundary and later output overflow', async () => {
    const child = new LaunchChild();
    child.chunks = [
      ...[...Buffer.from(`${prefix}authority-init\r\n`)].map((byte) => Buffer.from([byte])),
      Buffer.alloc(32769, 120),
      Buffer.from(`\n${prefix}root-owner-shared\n`),
    ];
    expect((await launchFailure(new NativeRpcClient(child))).message).toBe(
      'phase1.native-scenarios.launch.discovery-not-found.publication.authority-init',
    );
  });

  test('does not accept a refusal completed beyond the observation cap', async () => {
    const child = new LaunchChild();
    child.chunks = [Buffer.alloc(32768, 120), Buffer.from(`\n${prefix}authority-init\n`)];
    expect((await launchFailure(new NativeRpcClient(child))).message).toBe(
      'phase1.native-scenarios.launch.discovery-not-found.publication.output-limit',
    );
  });

  test('resets the bounded observation for each launch attempt', async () => {
    const child = new LaunchChild();
    const client = new NativeRpcClient(child);
    child.chunks = [Buffer.from(`${prefix}authority-init\n`)];
    expect((await launchFailure(client)).message).toContain('.publication.authority-init');
    child.chunks = [];
    expect((await launchFailure(client)).message).toContain('.publication.not-observed');
  });

  test('does not replace other native failures or the first retained failure', async () => {
    const child = new LaunchChild();
    child.chunks = [Buffer.from(`${prefix}authority-init\n`)];
    child.code = 'cave_launch_health_unavailable';
    const failure = await launchFailure(new NativeRpcClient(child));
    expect(failure.message).toBe('phase1.native-scenarios.launch.health-unavailable');
    const first = new Error('phase1.native-scenarios.fixture');
    expect(retainSchemaV2NativeFailure(first, 'launch', failure)).toBe(first);
  });
});
