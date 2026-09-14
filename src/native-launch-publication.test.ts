import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, test, vi } from 'vitest';
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
  checkpoint = true;
  readonly stdin = {
    write: (line: string) => {
      const request = JSON.parse(line) as { id: string };
      for (const chunk of this.chunks) this.stderr.write(chunk);
      if (this.checkpoint) {
        this.stderr.write(
          `[chat] native launch stderr checkpoint: ${createHash('sha256').update(request.id).digest('hex')}\n`,
        );
      }
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
  test('waits for earlier refusal bytes when stdout wins the real cross-pipe delivery race', async () => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { createHash } from 'node:crypto';
      import { createInterface } from 'node:readline';
      for await (const line of createInterface({ input: process.stdin })) {
        const request = JSON.parse(line);
        const checkpoint = createHash('sha256').update(request.id).digest('hex');
        process.stderr.write('[cave] client-v1 discovery publication refused: authority-init\\n');
        process.stderr.write('[chat] native launch stderr checkpoint: ' + checkpoint + '\\n');
        process.stdout.write(JSON.stringify({
          id: request.id, ok: false, error: { code: 'cave_launch_discovery_not_found' },
        }) + '\\n');
      }
    `,
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const closed = once(child, 'close');
    try {
      const client = new NativeRpcClient(child, { caveLaunchTimeoutMs: 2_000 });
      child.stderr.pause();
      const response = once(child.stdout, 'data');
      let settled = false;
      const failure = launchFailure(client).then((result) => {
        settled = true;
        return result;
      });
      await response;
      await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
      const settledBeforeStderr = settled;
      child.stderr.resume();
      expect((await failure).message).toBe(
        'phase1.native-scenarios.launch.discovery-not-found.publication.authority-init',
      );
      expect(settledBeforeStderr).toBe(false);
    } finally {
      child.stderr.resume();
      child.stdin.end();
      await closed;
    }
  });

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
      Buffer.alloc(8193, 120),
      Buffer.from(`\n${prefix}root-owner-shared\n`),
    ];
    expect((await launchFailure(new NativeRpcClient(child))).message).toBe(
      'phase1.native-scenarios.launch.discovery-not-found.publication.authority-init',
    );
  });

  test('does not accept a refusal completed beyond the observation cap', async () => {
    const child = new LaunchChild();
    child.chunks = [Buffer.alloc(8192, 120), Buffer.from(`\n${prefix}authority-init\n`)];
    expect((await launchFailure(new NativeRpcClient(child))).message).toBe(
      'phase1.native-scenarios.launch.discovery-not-found.publication.output-limit',
    );
  });

  test.each([true, false])(
    'keeps checkpoint precedence over later overflow with coalesced delivery=%s',
    async (coalesced) => {
      const child = new LaunchChild();
      child.checkpoint = false;
      const write = child.stdin.write;
      child.stdin.write = (line) => {
        const { id } = JSON.parse(line) as { id: string };
        const checkpoint = Buffer.from(
          `[chat] native launch stderr checkpoint: ${createHash('sha256').update(id).digest('hex')}\n`,
        );
        const noise = Buffer.alloc(8193, 120);
        child.chunks = coalesced ? [Buffer.concat([checkpoint, noise])] : [checkpoint, noise];
        return write(line);
      };
      expect((await launchFailure(new NativeRpcClient(child))).message).toBe(
        'phase1.native-scenarios.launch.discovery-not-found.publication.not-observed',
      );
    },
  );

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

  test('uses the original RPC deadline when a persistent stderr pipe never reaches its checkpoint', async () => {
    vi.useFakeTimers();
    try {
      const child = new LaunchChild();
      child.checkpoint = false;
      const write = child.stdin.write;
      child.stdin.write = (line) => {
        setTimeout(() => write(line), 90);
        return true;
      };
      const client = new NativeRpcClient(child, { caveLaunchTimeoutMs: 100 });
      let settled = false;
      const failure = launchFailure(client).then((result) => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(90);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(10);
      const result = await failure;
      expect(result.message).toBe(
        'phase1.native-scenarios.launch.discovery-not-found.publication.drain-timeout',
      );
      expect(publicPhase1FailureDiagnostic(result)).toBe(result.message);
      child.stderr.write(`${prefix}authority-init\n`);
      expect(result.message).toContain('.publication.drain-timeout');
    } finally {
      vi.useRealTimers();
    }
  });

  test('accepts complete stderr EOF without waiting for the persistent RPC process to exit', async () => {
    const child = new LaunchChild();
    child.checkpoint = false;
    const failure = launchFailure(new NativeRpcClient(child));
    child.stderr.end();
    expect((await failure).message).toBe(
      'phase1.native-scenarios.launch.discovery-not-found.publication.not-observed',
    );
  });

  test('waits for its fragmented checkpoint after a response with no refusal', async () => {
    const child = new LaunchChild();
    child.checkpoint = false;
    let id = '';
    const write = child.stdin.write;
    child.stdin.write = (line) => {
      id = (JSON.parse(line) as { id: string }).id;
      return write(line);
    };
    let settled = false;
    const failure = launchFailure(new NativeRpcClient(child)).then((result) => {
      settled = true;
      return result;
    });
    expect(id).toMatch(/^request-\d+-[a-f0-9]{32}$/u);
    await Promise.resolve();
    expect(settled).toBe(false);
    child.stderr.write(`[chat] native launch stderr checkpoint: ${'0'.repeat(64)}\n`);
    await Promise.resolve();
    expect(settled).toBe(false);
    const checkpoint = `[chat] native launch stderr checkpoint: ${createHash('sha256').update(id).digest('hex')}\r\n`;
    child.stderr.write(`private-fragment${checkpoint.slice(0, 40)}`);
    await Promise.resolve();
    expect(settled).toBe(false);
    child.stderr.write(checkpoint.slice(40));
    const result = await failure;
    expect(result.message).toBe(
      'phase1.native-scenarios.launch.discovery-not-found.publication.not-observed',
    );
    child.stderr.write(`${prefix}authority-init\n`);
    expect(result.message).toContain('.publication.not-observed');
  });

  test('recognizes a checkpoint after a bounded unterminated private line', async () => {
    const child = new LaunchChild();
    child.checkpoint = false;
    const write = child.stdin.write;
    child.stdin.write = (line) => {
      const { id } = JSON.parse(line) as { id: string };
      child.chunks = [
        Buffer.alloc(257, 120),
        Buffer.from(
          `[chat] native launch stderr checkpoint: ${createHash('sha256').update(id).digest('hex')}\n`,
        ),
      ];
      return write(line);
    };
    expect((await launchFailure(new NativeRpcClient(child))).message).toBe(
      'phase1.native-scenarios.launch.discovery-not-found.publication.not-observed',
    );
  });

  test('retains the native failure when stderr closes without a complete drain', async () => {
    const child = new LaunchChild();
    child.checkpoint = false;
    const failure = launchFailure(new NativeRpcClient(child));
    child.stderr.destroy();
    const result = await failure;
    expect(result.message).toBe(
      'phase1.native-scenarios.launch.discovery-not-found.publication.drain-unavailable',
    );
    expect(publicPhase1FailureDiagnostic(result)).toBe(result.message);
  });

  test('keeps overlapping requests separate and ignores duplicate responses and wrong checkpoints', async () => {
    const child = new LaunchChild();
    const requests: { id: string }[] = [];
    child.stdin.write = (line) => {
      requests.push(JSON.parse(line));
      return true;
    };
    const client = new NativeRpcClient(child);
    let settled = false;
    const first = launchFailure(client).then((result) => {
      settled = true;
      return result;
    });
    const firstId = requests[0]?.id;
    if (firstId === undefined) throw new Error('First launch request was not sent');
    child.stdout.write(
      `${JSON.stringify({ id: firstId, ok: false, error: { code: child.code } })}\n`,
    );
    child.stdout.write(`${JSON.stringify({ id: firstId, ok: true, result: {} })}\n`);
    const second = launchFailure(client);
    const secondId = requests[1]?.id;
    if (secondId === undefined) throw new Error('Second launch request was not sent');
    expect(firstId).not.toBe(secondId);
    child.stdout.write(
      `${JSON.stringify({
        id: secondId,
        ok: false,
        error: { code: 'cave_launch_in_progress' },
      })}\n`,
    );
    expect((await second).message).toBe(
      'phase1.native-scenarios.launch.rpc-cave-launch-in-progress',
    );
    child.stderr.write(
      `[chat] native launch stderr checkpoint: ${createHash('sha256').update(secondId).digest('hex')}\n`,
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    child.stderr.write(`${prefix}authority-init\n`);
    expect((await first).message).toContain('.publication.authority-init');
  });

  test('does not attribute one launch refusal to a later overlapping request', async () => {
    const child = new LaunchChild();
    const requests: { id: string }[] = [];
    child.stdin.write = (line) => {
      requests.push(JSON.parse(line));
      return true;
    };
    const client = new NativeRpcClient(child);
    const first = launchFailure(client);
    const second = launchFailure(client);
    const [firstId, secondId] = requests.map((request) => request.id);
    if (firstId === undefined || secondId === undefined) {
      throw new Error('Overlapping launch requests were not sent');
    }
    child.stdout.write(
      `${JSON.stringify({ id: firstId, ok: false, error: { code: child.code } })}\n`,
    );
    child.stdout.write(
      `${JSON.stringify({ id: secondId, ok: false, error: { code: child.code } })}\n`,
    );
    child.stderr.write(`${prefix}authority-init\n`);
    child.stderr.write(
      `[chat] native launch stderr checkpoint: ${createHash('sha256').update(firstId).digest('hex')}\n`,
    );
    child.stderr.write(
      `[chat] native launch stderr checkpoint: ${createHash('sha256').update(secondId).digest('hex')}\n`,
    );

    expect((await first).message).toBe(
      'phase1.native-scenarios.launch.discovery-not-found.publication.authority-init',
    );
    expect((await second).message).toBe(
      'phase1.native-scenarios.launch.discovery-not-found.publication.not-observed',
    );
  });
});
