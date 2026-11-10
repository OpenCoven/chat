import { describe, expect, test, vi } from 'vitest';

const modulePath = '../scripts/native-acceptance/rows.mjs';
const { Lane } = await import(modulePath);

describe('native link completion boundary', () => {
  test('ordinary send waits after the reply is visible before returning a clickable link', async () => {
    let finish: () => void = () => {};
    const completion = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const app = {
      click: vi.fn(),
      type: vi.fn(),
      one: vi.fn(async () => ({ value: 'request' })),
      all: vi.fn(async () => []),
      count: vi.fn(async () => 1),
    };
    const lane = new Lane({ app });
    let calls = 0;
    lane.idle = vi.fn(async () => {
      if (++calls === 2) await completion;
    });
    let returned = false;
    const sending = lane.send('Astra', 'request', 'link', 'Handoff check').then(() => {
      returned = true;
    });
    await vi.waitFor(() => expect(app.count).toHaveBeenCalled());
    expect(returned).toBe(false);
    expect(lane.idle).toHaveBeenCalledTimes(2);
    finish();
    await sending;
    expect(returned).toBe(true);
  });

  test('explicit streaming send returns while completion is still held', async () => {
    const app = {
      click: vi.fn(),
      type: vi.fn(),
      one: vi.fn(async () => ({ value: 'request' })),
      all: vi.fn(async () => []),
      count: vi.fn(async () => 1),
    };
    const lane = new Lane({ app });
    lane.idle = vi.fn();
    await lane.send('Astra', 'request', 'link', 'Completion boundary', { complete: false });
    expect(lane.idle).toHaveBeenCalledTimes(1);
  });
});

test('idle waits for the transcript reload to enable the composer, without a settling delay', async () => {
  vi.useFakeTimers();
  try {
    let ready = false;
    const app = {
      count: vi.fn(async () => 0),
      snapshot: vi.fn(async () => ({
        role: 'document',
        children: [{ role: 'textbox', name: 'Message Astra', enabled: ready, children: [] }],
      })),
    };
    const lane = new Lane({ app });
    let returned = false;
    const idle = lane.idle().then(() => {
      returned = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(returned).toBe(false);
    ready = true;
    await vi.advanceTimersByTimeAsync(500);
    await idle;
    expect(returned).toBe(true);
    expect(app.snapshot).toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

test('the model completion gate holds a streamed link until the lane releases it', async () => {
  const fixturePath = '../scripts/native-acceptance/fixture.mjs';
  const { startModelFixture } = await import(fixturePath);
  const fixture = await startModelFixture();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(`http://127.0.0.1:${fixture.port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'fixture',
        stream: true,
        messages: [{ role: 'user', content: '[[reviewrace]]' }],
      }),
    });
    reader = response.body?.getReader();
    const first = await reader?.read();
    const text = new TextDecoder().decode(first?.value);
    expect(text).toContain('Completion boundary');
    expect(text).not.toContain('message_stop');
    expect(fixture.finishReview()).toBe(1);
    let rest = '';
    for (;;) {
      const chunk = await reader?.read();
      if (chunk?.done) break;
      rest += new TextDecoder().decode(chunk?.value);
    }
    expect(rest).toContain('message_stop');
    expect(fixture.finishReview()).toBe(0);
  } finally {
    await reader?.cancel();
    await fixture.close();
  }
});
