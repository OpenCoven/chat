import { Channel } from '@tauri-apps/api/core';
import { describe, expect, it, vi } from 'vitest';
import { createCovenRuntime } from './coven-runtime';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (event: unknown) => void = () => {};
  },
}));

describe('Coven runtime', () => {
  it.each(['active', 'archived', 'deleted'] as const)(
    'uses the narrow %s lifecycle boundary',
    async (lifecycle) => {
      const invoke = vi.fn().mockResolvedValue(null);
      const runtime = createCovenRuntime({ available: () => true, invoke });
      await runtime.changeChatLifecycle('owned', lifecycle);
      expect(invoke).toHaveBeenCalledWith('coven_runtime_chat_lifecycle', {
        id: 'owned',
        lifecycle,
      });
    },
  );

  it('surfaces lifecycle persistence failures and rejects malformed acknowledgements', async () => {
    const invoke = vi.fn().mockRejectedValue('Lifecycle storage is full');
    const runtime = createCovenRuntime({ available: () => true, invoke });
    await expect(runtime.changeChatLifecycle('owned', 'deleted')).rejects.toThrow(
      'storage is full',
    );
    invoke.mockResolvedValue({ success: false });
    await expect(runtime.changeChatLifecycle('owned', 'archived')).rejects.toThrow(
      'invalid native result',
    );
  });

  it('rejects non-boolean archive flags from native discovery', async () => {
    const runtime = createCovenRuntime({
      available: () => true,
      invoke: vi.fn().mockResolvedValue([
        {
          id: 'one',
          title: 'One',
          harness: 'codex',
          status: 'completed',
          updatedAt: '',
          projectRoot: '',
          archived: 'false',
        },
      ]),
    });
    await expect(runtime.listSessions()).rejects.toThrow('invalid native result');
  });
  it('passes attachment bytes unchanged to the narrow native send boundary', async () => {
    const invoke = vi.fn().mockResolvedValue({ runId: 'r', events: [] });
    const runtime = createCovenRuntime({ available: () => true, invoke });
    const input = {
      runId: 'r',
      prompt: '',
      attachments: [{ name: 'note.txt', bytes: [97, 98, 99] }],
    };
    await runtime.send(input);
    expect(invoke).toHaveBeenCalledWith('coven_runtime_send', {
      input,
      onEvent: expect.any(Channel),
    });
  });
  it.each([42, 'https://example.test/avatar.png', 'data:image/svg+xml;base64,AAAA'])(
    'rejects invalid native avatar URLs: %s',
    async (avatarUrl) => {
      const runtime = createCovenRuntime({
        available: () => true,
        invoke: vi
          .fn()
          .mockResolvedValue([{ id: 'sage', name: 'sage', displayName: 'Sage', avatarUrl }]),
      });
      await expect(runtime.listFamiliars()).rejects.toThrow('invalid');
    },
  );

  it('preserves optional native PNG thumbnails', async () => {
    const familiars = [
      {
        id: 'sage',
        name: 'sage',
        displayName: 'Sage',
        avatarUrl: 'data:image/png;base64,iVBORw0KGgo=',
      },
      { id: 'nova', name: 'nova', displayName: 'Nova' },
    ];
    const runtime = createCovenRuntime({
      available: () => true,
      invoke: vi.fn().mockResolvedValue(familiars),
    });
    expect(await runtime.listFamiliars()).toEqual(familiars);
  });

  it('reports browser unavailability without calling native commands', async () => {
    const invoke = vi.fn();
    const runtime = createCovenRuntime({ available: () => false, invoke });
    expect(await runtime.status()).toEqual({
      available: false,
      error: 'Local Coven requires the desktop app. Install Coven CLI and open OpenCoven Chat.',
    });
    await expect(runtime.listSessions()).rejects.toThrow('desktop app');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('uses only narrow Coven commands, never Cave', async () => {
    const invoke = vi.fn().mockResolvedValue([]);
    const runtime = createCovenRuntime({ available: () => true, invoke });
    await runtime.listFamiliars();
    await runtime.listSessions();
    await runtime.cancel('run-1');
    expect(invoke.mock.calls).toEqual([
      ['coven_runtime_familiars'],
      ['coven_runtime_sessions'],
      ['coven_runtime_cancel', { runId: 'run-1' }],
    ]);
  });

  it('rejects malformed native output', async () => {
    const runtime = createCovenRuntime({
      available: () => true,
      invoke: vi.fn().mockResolvedValue({ sessions: 'wrong' }),
    });
    await expect(runtime.listSessions()).rejects.toThrow('invalid');
  });

  it('streams genuine events and returns the native terminal result', async () => {
    const event = {
      type: 'assistant',
      session_id: 'session-1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Native fixture' }] },
    };
    const result = { runId: 'run-1', events: [event] };
    const invoke = vi.fn(async (_command: string, args?: Record<string, unknown>) => {
      if (!(args?.onEvent instanceof Channel)) throw new Error('Missing event channel');
      args.onEvent.onmessage(event);
      return result;
    });
    const runtime = createCovenRuntime({ available: () => true, invoke });
    const observe = vi.fn();
    const input = { runId: 'run-1', prompt: 'hello', familiarId: 'sage' };
    expect(await runtime.send(input, observe)).toEqual(result);
    expect(observe).toHaveBeenCalledExactlyOnceWith(event);
    expect(invoke).toHaveBeenCalledWith('coven_runtime_send', {
      input,
      onEvent: expect.any(Channel),
    });
  });

  it('preserves session identity when reading', async () => {
    const session = {
      id: 'session-1',
      title: 'Chat',
      harness: 'coven-code',
      status: 'completed',
      updatedAt: '2026-09-14',
      projectRoot: '/workspace',
    };
    const invoke = vi.fn().mockResolvedValue({ session, events: [], hasMore: false });
    const runtime = createCovenRuntime({ available: () => true, invoke });
    expect(await runtime.readSession('session-1')).toEqual({
      session,
      events: [],
      hasMore: false,
    });

    expect(invoke).toHaveBeenCalledWith('coven_runtime_read', { id: 'session-1' });
  });

  it('exposes the actual new ledger identity from stream initialization', async () => {
    const events = [
      { type: 'system', subtype: 'init', session_id: 'new-ledger-session' },
      { type: 'result', session_id: 'new-ledger-session', is_error: false },
    ];
    const runtime = createCovenRuntime({
      available: () => true,
      invoke: vi.fn().mockResolvedValue({ runId: 'run-1', events }),
    });
    expect(await runtime.send({ runId: 'run-1', prompt: 'hello' })).toEqual({
      runId: 'run-1',
      sessionId: 'new-ledger-session',
      events,
    });
  });

  it('bounds native error messages', async () => {
    const runtime = createCovenRuntime({
      available: () => true,
      invoke: vi.fn().mockRejectedValue('x'.repeat(10_000)),
    });
    await expect(runtime.listFamiliars()).rejects.toThrow('x'.repeat(2048));
    try {
      await runtime.listFamiliars();
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error instanceof Error && error.message.length).toBe(2048);
    }
  });
});
