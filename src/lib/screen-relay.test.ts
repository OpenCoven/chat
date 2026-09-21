import { describe, expect, it, vi } from 'vitest';
import { createScreenRelay, decodeFrame, TAG } from './screen-relay';

function frame(tag: number, payload: number[] = []): ArrayBuffer {
  return new Uint8Array([tag, ...payload]).buffer;
}

function closeFrame(code: number, reason = ''): ArrayBuffer {
  return frame(TAG.close, [code >> 8, code & 0xff, ...new TextEncoder().encode(reason)]);
}

/** Lets the relay's promise chain settle, including the mocked command's own tick. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A connect command whose outcome the test decides later. */
function deferredConnect() {
  let resolve!: (id: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { connect: () => promise, resolve };
}

function harness(connect: (args: Record<string, unknown>) => Promise<unknown>) {
  const channels: { onmessage: (buffer: ArrayBuffer) => void }[] = [];
  const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
    if (command === 'coven_screen_connect') return connect(args ?? {});
    return undefined;
  });
  const relay = createScreenRelay({
    invoke,
    available: () => true,
    channel: () => {
      const channel = { onmessage: (_: ArrayBuffer) => {} };
      channels.push(channel);
      return channel;
    },
  });
  return {
    relay,
    invoke,
    host: () => {
      const channel = channels[channels.length - 1];
      if (!channel) throw new Error('The relay opened no channel.');
      return channel;
    },
  };
}

describe('decodeFrame', () => {
  it('reads every tag the host sends', () => {
    expect(decodeFrame(frame(TAG.open))).toEqual({ kind: 'open' });
    const data = decodeFrame(frame(TAG.data, [1, 2, 3]));
    expect(data.kind).toBe('data');
    if (data.kind === 'data') expect(Array.from(new Uint8Array(data.data))).toEqual([1, 2, 3]);
    expect(decodeFrame(closeFrame(1001, 'bye'))).toEqual({
      kind: 'close',
      code: 1001,
      reason: 'bye',
    });
    expect(decodeFrame(frame(TAG.close))).toEqual({ kind: 'close', code: 1005, reason: '' });
    expect(decodeFrame(frame(TAG.error, [...new TextEncoder().encode('nope')]))).toEqual({
      kind: 'error',
      message: 'nope',
    });
    expect(decodeFrame(frame(9)).kind).toBe('error');
  });
});

describe('createScreenRelay', () => {
  it('refuses to open outside the desktop app', () => {
    const relay = createScreenRelay({ invoke: vi.fn(), available: () => false });
    expect(relay.available).toBe(false);
    expect(() => relay.open('wss://x/')).toThrow('Screen viewing needs the desktop app.');
  });

  it('presents the host connection as a WebSocket, queuing sends until the session id arrives', async () => {
    const deferred = deferredConnect();
    const { relay, invoke, host } = harness(deferred.connect);
    const socket = relay.open('wss://sandbox/websockify?token=t');
    const onopen = vi.fn();
    const onmessage = vi.fn();
    const onclose = vi.fn();
    socket.onopen = onopen;
    socket.onmessage = onmessage;
    socket.onclose = onclose;
    expect(socket.readyState).toBe(0);
    expect(socket.binaryType).toBe('arraybuffer');
    expect(invoke).toHaveBeenCalledWith('coven_screen_connect', {
      url: 'wss://sandbox/websockify?token=t',
      onFrame: expect.anything(),
    });

    // The host announces open before the command's promise settles; the
    // client's first bytes must wait for the id and then go out in order.
    host().onmessage(frame(TAG.open));
    expect(socket.readyState).toBe(1);
    expect(onopen).toHaveBeenCalledOnce();
    socket.send(new Uint8Array([82, 70, 66]));
    socket.send(new Uint8Array([1]).buffer);
    expect(invoke).not.toHaveBeenCalledWith('coven_screen_send', expect.anything());
    deferred.resolve('session-1');
    await settle();
    expect(invoke.mock.calls.filter(([command]) => command === 'coven_screen_send')).toEqual([
      ['coven_screen_send', { id: 'session-1', bytes: [82, 70, 66] }],
      ['coven_screen_send', { id: 'session-1', bytes: [1] }],
    ]);
    socket.send(new Uint8Array([2]));
    expect(invoke).toHaveBeenLastCalledWith('coven_screen_send', { id: 'session-1', bytes: [2] });

    host().onmessage(frame(TAG.data, [7, 8]));
    expect(onmessage).toHaveBeenCalledOnce();
    expect(Array.from(new Uint8Array(onmessage.mock.calls[0]?.[0].data))).toEqual([7, 8]);

    socket.close();
    expect(socket.readyState).toBe(2);
    expect(invoke).toHaveBeenLastCalledWith('coven_screen_disconnect', { id: 'session-1' });
    host().onmessage(closeFrame(1000));
    expect(socket.readyState).toBe(3);
    expect(onclose).toHaveBeenCalledWith({ code: 1000, reason: '', wasClean: true });
    socket.send(new Uint8Array([3]));
    expect(invoke).not.toHaveBeenLastCalledWith('coven_screen_send', {
      id: 'session-1',
      bytes: [3],
    });
  });

  it('reports a refused connection as an error and an unclean close, keeping the host message', async () => {
    const { relay } = harness(() => Promise.reject(new Error('The screen server answered 403.')));
    const socket = relay.open('wss://sandbox/');
    const onerror = vi.fn();
    const onclose = vi.fn();
    socket.onerror = onerror;
    socket.onclose = onclose;
    await settle();
    expect(onerror).toHaveBeenCalledOnce();
    expect(socket.lastError).toBe('The screen server answered 403.');
    expect(onclose).toHaveBeenCalledWith({
      code: 1006,
      reason: 'The screen server answered 403.',
      wasClean: false,
    });
    expect(socket.readyState).toBe(3);
  });

  it('closes a session the reader abandoned before the host finished opening it', async () => {
    const deferred = deferredConnect();
    const { relay, invoke } = harness(deferred.connect);
    const socket = relay.open('wss://sandbox/');
    socket.close();
    expect(invoke).not.toHaveBeenCalledWith('coven_screen_disconnect', expect.anything());
    deferred.resolve('late');
    await settle();
    expect(invoke).toHaveBeenLastCalledWith('coven_screen_disconnect', { id: 'late' });
  });

  it('holds frames that arrive before the client attaches and replays them in order', async () => {
    const { relay, host } = harness(async () => 'session-3');
    const socket = relay.open('wss://sandbox/');
    host().onmessage(frame(TAG.open));
    host().onmessage(frame(TAG.data, [1]));
    host().onmessage(frame(TAG.data, [2]));
    expect(socket.readyState).toBe(1);
    const order: string[] = [];
    // noVNC's attach assigns all four handlers in one tick.
    socket.onmessage = (event) => order.push(`data:${new Uint8Array(event.data)[0]}`);
    socket.onopen = () => order.push('open');
    socket.onclose = (event) => order.push(`close:${event.code}`);
    socket.onerror = () => order.push('error');
    expect(order).toEqual([]);
    await Promise.resolve();
    expect(order).toEqual(['open', 'data:1', 'data:2']);
    host().onmessage(frame(TAG.data, [3]));
    expect(order).toEqual(['open', 'data:1', 'data:2', 'data:3']);
  });

  it('surfaces host errors that arrive mid-session before the close', () => {
    const { relay, host } = harness(async () => 'session-2');
    const socket = relay.open('wss://sandbox/');
    const onerror = vi.fn();
    socket.onerror = onerror;
    host().onmessage(frame(TAG.open));
    host().onmessage(frame(TAG.error, [...new TextEncoder().encode('too big')]));
    expect(onerror).toHaveBeenCalledOnce();
    expect(socket.lastError).toBe('too big');
    host().onmessage(closeFrame(1009, 'too big'));
    expect(socket.readyState).toBe(3);
  });
});
