import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CovenRunEvent,
  CovenRuntime,
  CovenSession,
  CovenSessionRead,
} from '../lib/coven-runtime';
import { ChatApp } from './chat-app';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const first: CovenSession = {
  id: 'one',
  title: 'First conversation',
  harness: 'codex',
  status: 'completed',
  updatedAt: '2026-09-14',
  projectRoot: '/workspace',
  familiarId: 'f',
};
const second: CovenSession = { ...first, id: 'two', title: 'Second conversation' };
function runtime(): CovenRuntime {
  return {
    status: vi.fn().mockResolvedValue({ available: true, version: '0.4.2' }),
    listFamiliars: vi
      .fn()
      .mockResolvedValue([{ id: 'f', name: 'local', displayName: 'Local familiar' }]),
    listSessions: vi.fn().mockResolvedValue([first, second]),
    readSession: vi.fn().mockImplementation(async (id: string) => ({
      session: id === 'one' ? first : second,
      events: [],
    })),
    send: vi.fn().mockResolvedValue({ runId: 'run', events: [] }),
    cancel: vi.fn().mockResolvedValue(undefined),
    changeChatLifecycle: vi.fn().mockResolvedValue(undefined),
  };
}

async function ready(api: CovenRuntime) {
  await act(async () => render(<ChatApp runtime={api} />));
  await screen.findByRole('button', { name: 'First conversation' });
  await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
}

describe('Coven ChatApp lifecycle', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
      },
    });
    Object.defineProperty(HTMLDialogElement.prototype, 'close', {
      configurable: true,
      value: function (this: HTMLDialogElement) {
        this.removeAttribute('open');
      },
    });
  });

  it('archives durably, filters archived chats, blocks sends, and restores', async () => {
    const api = runtime();
    let stored = [first, second];
    vi.mocked(api.listSessions).mockImplementation(async () => stored);
    vi.mocked(api.changeChatLifecycle).mockImplementation(async (id, state) => {
      stored = stored.map((item) =>
        item.id === id ? { ...item, archived: state === 'archived' } : item,
      );
    });
    await ready(api);
    fireEvent.click(screen.getByRole('button', { name: 'Archive chat' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: first.title })).not.toBeInTheDocument(),
    );
    expect(api.changeChatLifecycle).toHaveBeenCalledWith('one', 'archived');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Coven' }));
    await waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'Archived chats' }));
    fireEvent.click(await screen.findByRole('button', { name: first.title }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore chat' })).toBeEnabled());
    expect(screen.getByRole('textbox')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Restore chat' }));
    await waitFor(() => expect(api.changeChatLifecycle).toHaveBeenLastCalledWith('one', 'active'));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: first.title })).not.toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Active chats' }));
    expect(screen.getByRole('button', { name: first.title })).toBeInTheDocument();
    expect(api.send).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation, clears the deleted draft, and preserves other drafts', async () => {
    const api = runtime();
    localStorage.setItem(
      'opencoven.chat.navigation.v1',
      JSON.stringify({
        familiarId: 'f',
        sessionId: 'one',
        drafts: { [JSON.stringify(['removed-familiar', 'one'])]: 'orphan draft' },
      }),
    );
    await ready(api);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'private draft' } });
    fireEvent.click(screen.getByRole('button', { name: second.title }));
    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'retain this draft' } });
    fireEvent.click(screen.getByRole('button', { name: first.title }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete chat' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Delete chat' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Original CLI/Cave history is untouched');
    expect(api.changeChatLifecycle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep chat' }));
    expect(api.changeChatLifecycle).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete from Chat' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: first.title })).not.toBeInTheDocument(),
    );
    expect(api.changeChatLifecycle).toHaveBeenCalledExactlyOnceWith('one', 'deleted');
    const saved = localStorage.getItem('opencoven.chat.navigation.v1');
    expect(saved).not.toContain('private draft');
    expect(saved).not.toContain('orphan draft');
    expect(saved).toContain('retain this draft');
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it.each(['Archive chat', 'Delete chat'])(
    'does not replay a new-chat run from its old blank key after %s',
    async (action) => {
      const api = runtime();
      const events: CovenRunEvent[] = [
        { type: 'system', subtype: 'init', session_id: 'one' },
        { type: 'text_delta', text: 'Newly captured response.', session_id: 'one' },
      ];
      vi.mocked(api.listSessions).mockResolvedValueOnce([]).mockResolvedValue([first]);
      vi.mocked(api.send).mockResolvedValue({ runId: 'run', events });
      vi.mocked(api.readSession).mockResolvedValue({ session: first, events });
      await act(async () => render(<ChatApp runtime={api} />));
      await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
      fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new message' } });
      fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      await screen.findByText('Newly captured response.');
      await waitFor(() => expect(screen.getByRole('button', { name: action })).toBeEnabled());
      fireEvent.click(screen.getByRole('button', { name: action }));
      if (action === 'Delete chat')
        fireEvent.click(screen.getByRole('button', { name: 'Delete from Chat' }));
      await waitFor(() =>
        expect(screen.queryByRole('button', { name: first.title })).not.toBeInTheDocument(),
      );
      expect(screen.queryByText('Newly captured response.')).not.toBeInTheDocument();
    },
  );

  it('retains the selected chat and draft on persistence failure and prevents duplicate changes', async () => {
    const api = runtime();
    const pending = deferred<void>();
    vi.mocked(api.changeChatLifecycle).mockReturnValue(pending.promise);
    await ready(api);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'retain' } });
    fireEvent.click(screen.getByRole('button', { name: 'Archive chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Archive chat' }));
    fireEvent.click(screen.getByRole('button', { name: second.title }));
    expect(screen.getByRole('button', { name: first.title })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('textbox')).toBeDisabled();
    await act(async () => pending.reject(new Error('Cannot persist Chat lifecycle.')));
    expect(api.changeChatLifecycle).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('textbox')).toHaveValue('retain');
    expect(screen.getByRole('alert')).toHaveTextContent('Cannot persist Chat lifecycle.');
  });

  it('ignores an old lifecycle completion after switching runtime and unlocks the new controller', async () => {
    const api = runtime();
    const pending = deferred<void>();
    vi.mocked(api.changeChatLifecycle).mockReturnValue(pending.promise);
    const view = render(<ChatApp runtime={api} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Archive chat' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Archive chat' }));
    const replacement = runtime();
    view.rerender(<ChatApp runtime={replacement} />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Archive chat' })).toBeEnabled());
    await act(async () => pending.resolve());
    expect(screen.getByRole('button', { name: first.title })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(screen.getByRole('textbox')).toBeEnabled();
    expect(replacement.changeChatLifecycle).not.toHaveBeenCalled();
  });

  it('disables archive and delete until a cancelled run has actually settled', async () => {
    const api = runtime();
    const pending = deferred<{ runId: string; events: CovenRunEvent[] }>();
    vi.mocked(api.send).mockReturnValue(pending.promise);
    await ready(api);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'work' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByRole('button', { name: 'Archive chat' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete chat' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Stop/ }));
    await waitFor(() => expect(api.cancel).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Delete chat' })).toBeDisabled();
    await act(async () => pending.resolve({ runId: 'run', events: [] }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Delete chat' })).toBeEnabled());
    expect(api.changeChatLifecycle).not.toHaveBeenCalled();
  });

  it('provides archive, restore and confirmed deletion for read-only imports', async () => {
    const api = runtime();
    vi.mocked(api.listSessions).mockResolvedValue([
      { ...first, status: 'imported', harness: 'cave-import', archived: true },
    ]);
    await act(async () => render(<ChatApp runtime={api} />));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Refresh Coven' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Archived chats' }));
    fireEvent.click(await screen.findByRole('button', { name: first.title }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore chat' })).toBeEnabled());
    expect(screen.getByRole('textbox')).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete chat' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete from Chat' }));
    await waitFor(() => expect(api.changeChatLifecycle).toHaveBeenCalledWith('one', 'deleted'));
    expect(api.send).not.toHaveBeenCalled();
  });

  it('sends attachment-only bytes, retains on failure, and allows removal', async () => {
    const api = runtime();
    vi.mocked(api.send).mockRejectedValue(new Error('provider unavailable'));
    await ready(api);
    const file = new File([], 'actual.txt');
    Object.defineProperties(file, {
      size: { value: 3 },
      arrayBuffer: { value: async () => new Uint8Array([97, 98, 99]).buffer },
    });
    await act(async () =>
      fireEvent.change(screen.getByLabelText('Select text attachments'), {
        target: { files: [file] },
      }),
    );
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
    expect(api.send).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: '',
        attachments: [{ name: 'actual.txt', bytes: [97, 98, 99] }],
      }),
      expect.any(Function),
    );
    expect(screen.getByText('actual.txt')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('provider unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Remove actual.txt' }));
    expect(screen.queryByText('actual.txt')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('clears attachments only on success and restores sent metadata from native history', async () => {
    const api = runtime();
    await ready(api);
    const file = new File([], 'history.md');
    Object.defineProperties(file, {
      size: { value: 1 },
      arrayBuffer: { value: async () => new Uint8Array([120]).buffer },
    });
    vi.mocked(api.send).mockResolvedValue({
      runId: 'r',
      events: [
        {
          type: 'user',
          source: 'chat-input',
          message: { content: [{ type: 'text', text: '' }] },
          attachments: [{ name: 'history.md', size: 1 }],
        },
        { type: 'result', is_error: false },
      ],
    });
    await act(async () =>
      fireEvent.change(screen.getByLabelText('Select text attachments'), {
        target: { files: [file] },
      }),
    );
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Send' })));
    expect(screen.queryByRole('button', { name: 'Remove history.md' })).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Message attachments' })).toHaveTextContent(
      'history.md',
    );
  });

  it('retains attachments after cancellation and isolates them by conversation', async () => {
    const api = runtime();
    const send = deferred<{ runId: string; events: CovenRunEvent[] }>();
    vi.mocked(api.send).mockReturnValue(send.promise);
    await ready(api);
    const file = new File([], 'retained.txt');
    Object.defineProperties(file, {
      size: { value: 1 },
      arrayBuffer: { value: async () => new Uint8Array([120]).buffer },
    });
    await act(async () =>
      fireEvent.change(screen.getByLabelText('Select text attachments'), {
        target: { files: [file] },
      }),
    );
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Second conversation' })),
    );
    expect(screen.queryByText('retained.txt')).not.toBeInTheDocument();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'First conversation' })),
    );
    expect(screen.getByText('retained.txt')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Stop run' })));
    await act(async () => send.reject(new Error('Coven run cancelled.')));
    expect(screen.getByText('retained.txt')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('renders actual coven-code deltas live and does not duplicate the terminal transcript', async () => {
    const api = runtime();
    let emit: ((event: CovenRunEvent) => void) | undefined;
    const send = deferred<{ runId: string; events: CovenRunEvent[] }>();
    vi.mocked(api.send).mockImplementation((_input, callback) => {
      emit = callback;
      return send.promise;
    });
    await ready(api);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    const firstDelta = { type: 'text_delta', text: 'Actual ' };
    const secondDelta = { type: 'text_delta', text: 'engine output' };
    await act(async () => emit?.(firstDelta));
    expect(screen.getByText('Actual')).toBeInTheDocument();
    await act(async () => emit?.(secondDelta));
    expect(screen.getByText('Actual engine output')).toBeInTheDocument();
    await act(async () =>
      send.resolve({
        runId: 'r',
        events: [firstDelta, secondDelta, { type: 'result', is_error: false }],
      }),
    );
    expect(screen.getAllByText('Actual engine output')).toHaveLength(1);
  });

  it('allows a CLI-only installation to send without a familiar or session', async () => {
    const api = runtime();
    vi.mocked(api.listFamiliars).mockResolvedValue([]);
    vi.mocked(api.listSessions).mockResolvedValue([]);
    await act(async () => render(<ChatApp runtime={api} />));
    expect(screen.getByRole('textbox', { name: 'Message Coven' })).toBeEnabled();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Hello CLI' } });
    await act(async () => fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' }));
    expect(api.send).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Hello CLI' }),
      expect.any(Function),
    );
    expect(vi.mocked(api.send).mock.calls[0]?.[0]).not.toHaveProperty('familiarId');
    expect(screen.queryByText(/Create a familiar/)).not.toBeInTheDocument();
  });

  it('streams genuine output alongside prior history and retains failed partial output without duplicates', async () => {
    const api = runtime();
    const prior = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Prior answer' }] },
    };
    const partial = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Partial answer' }] },
    };
    vi.mocked(api.readSession).mockResolvedValue({ session: first, events: [prior] });
    let emit: ((event: CovenRunEvent) => void) | undefined;
    const send = deferred<{ runId: string; events: CovenRunEvent[] }>();
    vi.mocked(api.send).mockImplementation((_input, callback) => {
      emit = callback;
      return send.promise;
    });
    await ready(api);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Continue' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await act(async () => emit?.(partial));
    expect(screen.getByText('Prior answer')).toBeInTheDocument();
    expect(screen.getByText('Partial answer')).toBeInTheDocument();
    await act(async () =>
      send.resolve({
        runId: 'r',
        events: [partial, { type: 'result', is_error: true, error: 'Provider disconnected' }],
      }),
    );
    expect(screen.getAllByText('Partial answer')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Provider disconnected');
    expect(screen.getByRole('textbox')).toHaveValue('Continue');
  });

  it('isolates live output by session and ignores callbacks after unmount', async () => {
    const api = runtime();
    let emit: ((event: CovenRunEvent) => void) | undefined;
    const send = deferred<{ runId: string; events: CovenRunEvent[] }>();
    vi.mocked(api.send).mockImplementation((_input, callback) => {
      emit = callback;
      return send.promise;
    });
    const view = await act(async () => render(<ChatApp runtime={api} />));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Run' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'Second conversation' })),
    );
    const event = {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Origin only' }] },
    };
    await act(async () => emit?.(event));
    expect(screen.queryByText('Origin only')).not.toBeInTheDocument();
    await act(async () => send.reject(new Error('Origin failed')));
    expect(screen.queryByText('Origin failed')).not.toBeInTheDocument();
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'First conversation' })),
    );
    expect(screen.getByText('Origin only')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Origin failed');
    view.unmount();
    await act(async () => emit?.(event));
    expect(screen.queryByText('Origin only')).not.toBeInTheDocument();
  });

  it('preserves invalid saved navigation and discloses memory-only drafts', async () => {
    localStorage.setItem('opencoven.chat.navigation.v1', '{broken');
    await ready(runtime());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Memory only' } });
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    expect(localStorage.getItem('opencoven.chat.navigation.v1')).toBe('{broken');
    expect(screen.getByText(/memory-only/i)).toBeInTheDocument();
  });

  it('shows actionable browser state without requesting CLI data', async () => {
    const api = runtime();
    vi.mocked(api.status).mockResolvedValue({
      available: false,
      error: 'Open the desktop app to use the Coven CLI.',
    });
    await act(async () => render(<ChatApp runtime={api} />));
    expect(await screen.findByText(/Open the desktop app/)).toBeInTheDocument();
    expect(api.listSessions).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('prevents duplicate sends and keeps failed drafts recoverable', async () => {
    const api = runtime();
    const send = deferred<{ runId: string; events: [] }>();
    vi.mocked(api.send).mockReturnValue(send.promise);
    await ready(api);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Keep this draft' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    expect(api.send).toHaveBeenCalledOnce();
    await act(async () => send.reject(new Error('CLI failed')));
    expect(await screen.findByRole('alert')).toHaveTextContent('CLI failed');
    expect(screen.getByRole('textbox')).toHaveValue('Keep this draft');
  });

  it('ignores stale session reads after navigation', async () => {
    const api = runtime();
    const read = deferred<CovenSessionRead>();
    vi.mocked(api.readSession).mockImplementation((id) =>
      id === 'one' ? read.promise : Promise.resolve({ session: second, events: [] }),
    );
    await act(async () => render(<ChatApp runtime={api} />));
    fireEvent.click(await screen.findByRole('button', { name: 'Second conversation' }));
    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
    await act(async () => read.reject(new Error('Stale failure')));
    expect(screen.queryByText('Stale failure')).not.toBeInTheDocument();
    expect(document.querySelector('.fr-thread-title')).toHaveTextContent('Second conversation');
  });

  it('does not clear a newer draft or change session when a send settles', async () => {
    const api = runtime();
    const send = deferred<{ runId: string; events: [] }>();
    vi.mocked(api.send).mockReturnValue(send.promise);
    await ready(api);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Submitted' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Second conversation' }));
    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Other session draft' } });
    await act(async () => send.resolve({ runId: 'run', events: [] }));
    expect(screen.getByRole('textbox')).toHaveValue('Other session draft');
    expect(document.querySelector('.fr-thread-title')).toHaveTextContent('Second conversation');
  });

  it('waits for the run to settle after cancellation and surfaces cancellation errors', async () => {
    const api = runtime();
    const send = deferred<{ runId: string; events: [] }>();
    vi.mocked(api.send).mockReturnValue(send.promise);
    vi.mocked(api.cancel).mockRejectedValueOnce(new Error('Stop failed'));
    await ready(api);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Run me' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Stop failed');
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' }));
    await waitFor(() => expect(screen.getByText(/Cancellation requested/)).toBeInTheDocument());
    expect(screen.getByRole('textbox')).toBeDisabled();
    await act(async () => send.reject(new Error('Run cancelled')));
    expect(screen.getByRole('textbox')).toHaveValue('Run me');
  });

  it('requests cancellation on unmount and ignores late completion', async () => {
    const api = runtime();
    const send = deferred<{ runId: string; events: [] }>();
    vi.mocked(api.send).mockReturnValue(send.promise);
    const view = await act(async () => render(<ChatApp runtime={api} />));
    await screen.findByRole('button', { name: 'First conversation' });
    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Persist this' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    view.unmount();
    expect(api.cancel).toHaveBeenCalledOnce();
    await act(async () => send.resolve({ runId: 'run', events: [] }));
    expect(localStorage.getItem('opencoven.chat.navigation.v1')).toContain('Persist this');
  });

  it('starts a fresh lifecycle when the injected runtime changes', async () => {
    const api = runtime();
    const next = runtime();
    const send = deferred<{ runId: string; events: [] }>();
    vi.mocked(api.send).mockReturnValue(send.promise);
    const view = await act(async () => render(<ChatApp runtime={api} />));
    await screen.findByRole('button', { name: 'First conversation' });
    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Recoverable' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await act(async () => view.rerender(<ChatApp runtime={next} />));
    await waitFor(() => expect(next.listSessions).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Stop run' })).not.toBeInTheDocument(),
    );
    await act(async () => send.reject(new Error('Old runtime error')));
    expect(screen.queryByText('Old runtime error')).not.toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('Recoverable');
  });

  it('continues the new sibling session returned by Coven rather than the old session', async () => {
    const api = runtime();
    const sibling = { ...first, id: 'sibling', title: 'Continued conversation' };
    vi.mocked(api.send).mockResolvedValue({
      runId: 'run',
      events: [
        { type: 'system', subtype: 'init', session_id: sibling.id },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Actual answer' }] } },
      ],
    });
    await ready(api);
    vi.mocked(api.listSessions).mockResolvedValue([sibling, first, second]);
    vi.mocked(api.readSession).mockResolvedValue({
      session: sibling,
      events: [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'Actual answer' }] } },
      ],
    });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'First request' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    await screen.findByText('Actual answer');
    await waitFor(() =>
      expect(document.querySelector('.fr-thread-title')).toHaveTextContent(
        'Continued conversation',
      ),
    );
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Follow up' } });
    await act(async () => fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' }));
    expect(api.send).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: 'sibling', prompt: 'Follow up' }),
      expect.any(Function),
    );
  });

  it('keeps an explicitly selected new chat on refresh and reload', async () => {
    const api = runtime();
    const view = await act(async () => render(<ChatApp runtime={api} />));
    await screen.findByRole('button', { name: 'First conversation' });
    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'New chat draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh Coven' }));
    await waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(2));
    expect(document.querySelector('.fr-thread-title')).toHaveTextContent('New chat');
    view.unmount();
    await act(async () => render(<ChatApp runtime={api} />));
    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
    expect(screen.getByRole('textbox')).toHaveValue('New chat draft');
  });

  it('preserves drafts when a result event reports an error', async () => {
    const api = runtime();
    vi.mocked(api.send).mockResolvedValue({
      runId: 'r',
      events: [{ type: 'result', is_error: true, error: 'Authentication required' }],
    });
    await ready(api);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Retry this' } });
    await act(async () => fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Authentication required');
    expect(screen.getByRole('textbox')).toHaveValue('Retry this');
  });

  it('carries a newer unsent draft into the returned sibling session', async () => {
    const api = runtime();
    const send = deferred<{
      runId: string;
      events: { type: string; subtype: string; session_id: string }[];
    }>();
    vi.mocked(api.send).mockReturnValue(send.promise);
    await ready(api);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Submitted' } });
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Still composing' } });
    await act(async () =>
      send.resolve({
        runId: 'r',
        events: [{ type: 'system', subtype: 'init', session_id: 'sibling' }],
      }),
    );
    expect(screen.getByRole('textbox')).toHaveValue('Still composing');
  });
});
