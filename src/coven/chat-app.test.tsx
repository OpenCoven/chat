import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  CovenRunEvent,
  CovenRunResult,
  CovenRuntime,
  CovenSession,
  CovenSessionRead,
} from '../lib/coven-runtime';
import { ChatApp } from './chat-app';
import type { ChatLayoutProps } from './chat-layout';

const counters = vi.hoisted(() => ({ layoutRenders: 0 }));

// Exercise the controller contract independently of the parent's evolving visual layout.
vi.mock('./chat-layout', () => ({
  ChatLayout: (props: ChatLayoutProps) => {
    counters.layoutRenders += 1;
    return <MockLayout {...props} />;
  },
}));

function MockLayout(props: ChatLayoutProps) {
  return (
    <div>
      {props.familiars
        .filter(
          (familiar) =>
            !props.sessions.find((session) => session.familiarId === familiar.id)?.archived,
        )
        .map((familiar) => (
          <button type="button" key={familiar.id} onClick={() => props.onFamiliar(familiar.id)}>
            {familiar.name}
          </button>
        ))}
      <output data-testid="head">{props.sessionId}</output>
      <output data-testid="familiar">{props.familiarId}</output>
      <output data-testid="run-familiar">{props.busy ? props.runFamiliarId : 'idle'}</output>
      <output data-testid="drafts">{JSON.stringify(props.drafts ?? {})}</output>
      <output data-testid="connected">{String(props.connected)}</output>
      <output data-testid="ready">{String(props.ready)}</output>
      <output>{props.status}</output>
      <textarea
        aria-label="Draft"
        value={props.draft}
        disabled={!props.ready || props.loading}
        onChange={(event) => props.onDraft(event.target.value)}
      />
      <button
        type="button"
        onClick={props.onSend}
        disabled={!props.ready || props.busy || props.loading}
      >
        Send
      </button>
      {props.busy && (
        <button type="button" onClick={props.onCancel} disabled={props.cancelling}>
          Stop
        </button>
      )}
      <button type="button" onClick={props.onRefresh} disabled={props.busy || props.lifecycleBusy}>
        Refresh
      </button>
      <button
        type="button"
        disabled={
          props.busy ||
          props.loading ||
          props.lifecycleBusy ||
          props.lifecycleLocked ||
          !props.sessionId
        }
        onClick={() => props.onLifecycle?.(props.selectedArchived ? 'active' : 'archived')}
      >
        {props.selectedArchived ? 'Restore' : 'Archive'}
      </button>
      <button
        type="button"
        disabled={
          props.busy ||
          props.loading ||
          props.lifecycleBusy ||
          props.lifecycleLocked ||
          !props.sessionId
        }
        onClick={() => props.onLifecycle?.('deleted')}
      >
        Confirmed delete
      </button>
      <input
        type="file"
        aria-label="Attach"
        onChange={(event) => props.onAttach?.(Array.from(event.target.files ?? []))}
      />
      {props.attachments?.map((file) => (
        <button type="button" key={file.id} onClick={() => props.onRemoveAttachment?.(file.id)}>
          {file.name}
        </button>
      ))}
      <div role="log">
        {props.messages.map((message) => (
          <p key={message.id}>{message.text}</p>
        ))}
      </div>
      {props.error && <div role="alert">{props.error}</div>}
    </div>
  );
}

const STORAGE = 'opencoven.chat.navigation.v1';
const first: CovenSession = {
  id: 'one',
  title: 'First head',
  harness: 'coven-code',
  status: 'completed',
  familiarId: 'f',
  updatedAt: '2026-09-14',
  projectRoot: '/work',
};
const second: CovenSession = { ...first, id: 'two', familiarId: 'g', title: 'Other head' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function runtime(): CovenRuntime {
  return {
    status: vi.fn().mockResolvedValue({ available: true, version: 'fixture' }),
    listFamiliars: vi.fn().mockResolvedValue([
      { id: 'f', name: 'first', displayName: 'First familiar' },
      { id: 'g', name: 'other', displayName: 'Other familiar' },
    ]),
    listSessions: vi.fn().mockResolvedValue([first, second]),
    readSession: vi.fn().mockImplementation(async (id: string) => ({
      session: id === 'two' ? second : { ...first, id },
      events: [],
    })),
    send: vi.fn().mockResolvedValue({ runId: 'run', events: [] }),
    cancel: vi.fn().mockResolvedValue(undefined),
    changeChatLifecycle: vi.fn().mockResolvedValue(undefined),
  };
}

async function ready(api: CovenRuntime) {
  let view!: ReturnType<typeof render>;
  // Flush initialization and the canonical-head read effect before observing readiness.
  await act(async () => {
    view = render(<ChatApp runtime={api} />);
  });
  await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
  return view;
}

function draft(value: string) {
  fireEvent.change(screen.getByRole('textbox'), { target: { value } });
}

function click(name: string) {
  fireEvent.click(screen.getByRole('button', { name }));
}

async function attachNote() {
  const file = new File([], 'note.txt');
  Object.defineProperties(file, {
    size: { value: 3 },
    arrayBuffer: { value: async () => new Uint8Array([97, 98, 99]).buffer },
  });
  fireEvent.change(screen.getByLabelText('Attach'), { target: { files: [file] } });
  await screen.findByRole('button', { name: 'note.txt' });
}

describe('canonical familiar controller', () => {
  beforeEach(() => localStorage.clear());

  it('opens only the canonical head, replacing stale navigation without reading the older thread', async () => {
    localStorage.setItem(STORAGE, JSON.stringify({ familiarId: 'f', sessionId: 'older' }));
    const api = runtime();
    await ready(api);
    expect(api.readSession).toHaveBeenCalledExactlyOnceWith('one');
    expect(screen.getByTestId('head')).toHaveTextContent('one');
    expect(screen.getByRole('textbox')).toHaveValue('');
    click('Other familiar');
    await waitFor(() => expect(api.readSession).toHaveBeenLastCalledWith('two'));
    expect(screen.getByTestId('familiar')).toHaveTextContent('g');
  });

  it('opens the persisted head even when old navigation explicitly selected an empty chat', async () => {
    localStorage.setItem(STORAGE, JSON.stringify({ familiarId: 'f', sessionId: '' }));
    const api = runtime();
    await ready(api);
    await waitFor(() => {
      expect(api.readSession).toHaveBeenCalledWith('one');
      expect(screen.getByTestId('head')).toHaveTextContent('one');
    });
  });

  it('keeps unsent drafts out of browser storage', async () => {
    await ready(runtime());
    draft('never persisted');
    const stored = localStorage.getItem(STORAGE) ?? '';
    expect(stored).not.toContain('never persisted');
    expect(JSON.parse(stored)).toEqual({ familiarId: 'f', sessionId: 'one' });
  });

  it('purges legacy plaintext drafts from browser storage without restoring them', async () => {
    localStorage.setItem(
      STORAGE,
      JSON.stringify({
        familiarId: 'f',
        sessionId: 'one',
        drafts: { '["f",""]': 'Old secret draft', '["f","one"]': 'Older secret' },
      }),
    );
    await ready(runtime());
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(localStorage.getItem(STORAGE)).not.toContain('secret');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps a draft per familiar in memory while switching', async () => {
    const api = runtime();
    await ready(api);
    draft('first familiar draft');
    click('Other familiar');
    await waitFor(() => expect(screen.getByTestId('familiar')).toHaveTextContent('g'));
    expect(screen.getByRole('textbox')).toHaveValue('');
    click('First familiar');
    await waitFor(() => expect(screen.getByTestId('familiar')).toHaveTextContent('f'));
    expect(screen.getByRole('textbox')).toHaveValue('first familiar draft');
  });

  it("reports each familiar's unsent draft so the sidebar can remind the reader", async () => {
    const api = runtime();
    await ready(api);
    expect(screen.getByTestId('drafts')).toHaveTextContent('{}');
    draft('ask first');
    click('Other familiar');
    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
    expect(JSON.parse(screen.getByTestId('drafts').textContent ?? '{}')).toEqual({
      f: 'ask first',
    });
    draft('   ');
    expect(JSON.parse(screen.getByTestId('drafts').textContent ?? '{}')).toEqual({
      f: 'ask first',
    });
  });

  it('continues the durable sibling head and preserves a newer familiar draft', async () => {
    const api = runtime();
    const run = deferred<CovenRunResult>();
    vi.mocked(api.send).mockReturnValueOnce(run.promise);
    const next = { ...first, id: 'one-next' };
    vi.mocked(api.listSessions)
      .mockResolvedValueOnce([first, second])
      .mockResolvedValue([next, second]);
    await ready(api);
    draft('submitted');
    click('Send');
    expect(screen.getByRole('textbox')).toHaveValue('');
    draft('newer unsent');
    await act(async () =>
      run.resolve({
        runId: 'run',
        events: [{ type: 'system', subtype: 'init', session_id: next.id }],
      }),
    );
    await waitFor(() => expect(screen.getByTestId('head')).toHaveTextContent('one-next'));
    await waitFor(() => expect(screen.getByRole('textbox')).toBeEnabled());
    expect(screen.getByRole('textbox')).toHaveValue('newer unsent');
    click('Send');
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.send).mock.calls[1]?.[0]).toMatchObject({
      familiarId: 'f',
      sessionId: 'one-next',
      prompt: 'newer unsent',
    });
  });

  it('does not clear a newly retyped identical message when the previous send finishes', async () => {
    const api = runtime();
    const run = deferred<CovenRunResult>();
    vi.mocked(api.send).mockReturnValueOnce(run.promise);
    await ready(api);
    draft('same message');
    click('Send');
    expect(screen.getByRole('textbox')).toHaveValue('');
    draft('same message');
    await act(async () => run.resolve({ runId: 'run', events: [] }));
    await waitFor(() => expect(screen.queryByText('Stop')).not.toBeInTheDocument());
    expect(screen.getByRole('textbox')).toHaveValue('same message');
  });

  it('does not restore a failed message over a draft the user deliberately cleared', async () => {
    const api = runtime();
    const run = deferred<CovenRunResult>();
    vi.mocked(api.send).mockReturnValueOnce(run.promise);
    await ready(api);
    draft('submitted');
    click('Send');
    draft('replacement');
    draft('');
    await act(async () => run.reject(new Error('Provider failed')));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Provider failed'));
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('creates a fresh thread for an empty familiar with no standalone or session override', async () => {
    const api = runtime();
    vi.mocked(api.listSessions).mockResolvedValue([]);
    await ready(api);
    expect(api.readSession).not.toHaveBeenCalled();
    draft('hello');
    click('Send');
    await waitFor(() => expect(api.send).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.send).mock.calls[0]?.[0]).toMatchObject({
      familiarId: 'f',
      prompt: 'hello',
    });
    expect(vi.mocked(api.send).mock.calls[0]?.[0]).not.toHaveProperty('sessionId');
  });

  it('reconciles initialized heads on failure and never duplicates captured history', async () => {
    const api = runtime();
    const next = { ...first, id: 'failed-sibling' };
    const events: CovenRunEvent[] = [
      { type: 'system', subtype: 'init', session_id: next.id },
      { type: 'text_delta', session_id: next.id, text: 'Partial response' },
    ];
    vi.mocked(api.listSessions)
      .mockResolvedValueOnce([first, second])
      .mockResolvedValue([next, second]);
    vi.mocked(api.send).mockImplementation(async (_input, onEvent) => {
      for (const event of events) onEvent?.(event);
      throw new Error('Provider failed');
    });
    vi.mocked(api.readSession).mockImplementation(async (id) => ({
      session: id === next.id ? next : first,
      events: id === next.id ? events : [],
    }));
    await ready(api);
    draft('keep this');
    click('Send');
    await waitFor(() => expect(screen.getByTestId('head')).toHaveTextContent(next.id));
    await waitFor(() => expect(screen.getAllByText('Partial response')).toHaveLength(1));
    expect(screen.getByRole('textbox')).toHaveValue('keep this');
    expect(screen.getByRole('alert')).toHaveTextContent('Provider failed');
  });

  it('blocks lifecycle changes until cancelled native work and head refresh both settle', async () => {
    const api = runtime();
    const run = deferred<CovenRunResult>();
    const refreshed = deferred<CovenSession[]>();
    vi.mocked(api.send).mockReturnValue(run.promise);
    vi.mocked(api.listSessions)
      .mockResolvedValueOnce([first, second])
      .mockReturnValue(refreshed.promise);
    await ready(api);
    draft('work');
    click('Send');
    click('Stop');
    await waitFor(() => expect(api.cancel).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Confirmed delete' })).toBeDisabled();
    await act(async () => run.reject(new Error('Cancelled')));
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled();
    await act(async () => refreshed.resolve([{ ...first, id: 'cancelled-sibling' }, second]));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Archive' })).toBeEnabled());
    expect(screen.getByTestId('head')).toHaveTextContent('cancelled-sibling');
    expect(screen.getByRole('textbox')).toHaveValue('work');
    expect(api.changeChatLifecycle).not.toHaveBeenCalled();
  });

  it('does not pull selection back when another familiar is selected during a run', async () => {
    const api = runtime();
    const run = deferred<CovenRunResult>();
    vi.mocked(api.send).mockReturnValue(run.promise);
    await ready(api);
    draft('work');
    click('Send');
    click('Other familiar');
    // The run stays attributed to the familiar it was sent to, not the one now shown.
    expect(screen.getByTestId('familiar')).toHaveTextContent('g');
    expect(screen.getByTestId('run-familiar')).toHaveTextContent('f');
    await act(async () => run.resolve({ runId: 'run', events: [] }));
    expect(screen.getByTestId('familiar')).toHaveTextContent('g');
    expect(screen.getByTestId('head')).toHaveTextContent('two');
    expect(screen.getByRole('textbox')).toHaveValue('');
    expect(screen.getByTestId('run-familiar')).toHaveTextContent('idle');
  });

  it('archives a familiar and keeps it hidden after refresh without changing its history', async () => {
    const api = runtime();
    let stored = [first, second];
    vi.mocked(api.listSessions).mockImplementation(async () => stored);
    vi.mocked(api.changeChatLifecycle).mockImplementation(async (id, state) => {
      stored = stored.map((session) =>
        session.id === id ? { ...session, archived: state === 'archived' } : session,
      );
    });
    await ready(api);
    draft('archived draft');
    click('Archive');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'First familiar' })).not.toBeInTheDocument(),
    );
    click('Refresh');
    await waitFor(() => expect(api.listSessions).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'First familiar' })).not.toBeInTheDocument();
    expect(api.changeChatLifecycle).toHaveBeenCalledExactlyOnceWith('one', 'archived');
    expect(stored.find((session) => session.id === 'one')).toEqual({ ...first, archived: true });
  });

  it('deletes the app thread but retains the familiar and starts fresh after reload', async () => {
    const api = runtime();
    let stored = [first, second];
    vi.mocked(api.listSessions).mockImplementation(async () => stored);
    vi.mocked(api.changeChatLifecycle).mockImplementation(async (id) => {
      stored = stored.filter((session) => session.id !== id);
    });
    const view = await ready(api);
    draft('delete this draft');
    click('Confirmed delete');
    await waitFor(() => expect(screen.getByTestId('head')).toHaveTextContent(''));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Confirmed delete' })).toBeDisabled(),
    );
    expect(screen.getByRole('button', { name: 'First familiar' })).toBeInTheDocument();
    expect(localStorage.getItem(STORAGE)).not.toContain('delete this draft');
    expect(api.cancel).not.toHaveBeenCalled();
    view.unmount();
    await ready(api);
    draft('fresh message');
    click('Send');
    await waitFor(() => expect(api.send).toHaveBeenCalledOnce());
    expect(vi.mocked(api.send).mock.calls[0]?.[0]).not.toHaveProperty('sessionId');
    expect(vi.mocked(api.send).mock.calls[0]?.[0]).toMatchObject({ familiarId: 'f' });
  });

  it('retains state on lifecycle failure and prevents duplicate or competing mutations', async () => {
    const api = runtime();
    const pending = deferred<void>();
    vi.mocked(api.changeChatLifecycle).mockReturnValue(pending.promise);
    await ready(api);
    draft('retained');
    click('Archive');
    click('Archive');
    click('Other familiar');
    expect(screen.getByTestId('familiar')).toHaveTextContent('f');
    expect(screen.getByRole('textbox')).toBeDisabled();
    await act(async () => pending.reject(new Error('Storage full')));
    expect(api.changeChatLifecycle).toHaveBeenCalledOnce();
    expect(screen.getByRole('textbox')).toHaveValue('retained');
    expect(screen.getByRole('alert')).toHaveTextContent('Storage full');
  });

  it('fails closed when canonical refresh fails instead of resuming a stale head', async () => {
    const api = runtime();
    vi.mocked(api.listSessions)
      .mockResolvedValueOnce([first, second])
      .mockRejectedValue(new Error('Missing canonical metadata'));
    await ready(api);
    draft('work');
    click('Send');
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Reopen the familiar before sending again',
      ),
    );
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(api.send).toHaveBeenCalledOnce();
    // The stale thread must not stay mutable while the runtime is unavailable.
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Confirmed delete' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await act(async () => {});
    expect(api.changeChatLifecycle).not.toHaveBeenCalled();
  });

  it('disables lifecycle controls when a manual refresh fails after a successful load', async () => {
    const api = runtime();
    vi.mocked(api.listFamiliars)
      .mockResolvedValueOnce([{ id: 'f', name: 'first', displayName: 'First familiar' }])
      .mockRejectedValue(new Error('Discovery failed'));
    await ready(api);
    expect(screen.getByRole('button', { name: 'Archive' })).toBeEnabled();
    click('Refresh');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Discovery failed'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Archive' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Confirmed delete' })).toBeDisabled();
  });

  it('ignores stale reads after switching familiars', async () => {
    const api = runtime();
    const pending = deferred<CovenSessionRead>();
    vi.mocked(api.readSession)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ session: second, events: [] });
    render(<ChatApp runtime={api} />);
    await screen.findByRole('button', { name: 'Other familiar' });
    click('Other familiar');
    await act(async () =>
      pending.resolve({ session: first, events: [{ type: 'text_delta', text: 'Stale response' }] }),
    );
    expect(screen.queryByText('Stale response')).not.toBeInTheDocument();
  });

  it('retains file bytes after a failed send and clears them only after success', async () => {
    const api = runtime();
    vi.mocked(api.send)
      .mockRejectedValueOnce(new Error('Failed'))
      .mockResolvedValue({ runId: 'run', events: [] });
    await ready(api);
    await attachNote();
    click('Send');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Failed'));
    expect(screen.getByRole('button', { name: 'note.txt' })).toBeInTheDocument();
    expect(vi.mocked(api.send).mock.calls[0]?.[0].attachments).toEqual([
      { name: 'note.txt', bytes: [97, 98, 99] },
    ]);
    click('Send');
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'note.txt' })).not.toBeInTheDocument(),
    );
  });

  it('reports a live runtime as connected even while nothing is selected', async () => {
    // `ready` folds selection and lifecycle into runtime health, so the empty
    // transcript cannot use it to decide whether the CLI is reachable: with a
    // healthy CLI and no familiar chosen it would claim the CLI was down.
    const api = runtime();
    vi.mocked(api.listSessions).mockResolvedValue([]);
    vi.mocked(api.listFamiliars).mockResolvedValue([]);
    render(<ChatApp runtime={api} />);
    await waitFor(() => expect(screen.getByTestId('connected')).toHaveTextContent('true'));
    expect(screen.getByTestId('familiar')).toBeEmptyDOMElement();
    expect(screen.getByTestId('ready')).toHaveTextContent('false');
  });

  it('reports a missing runtime as not connected', async () => {
    const api = runtime();
    vi.mocked(api.status).mockResolvedValue({ available: false, error: 'Open desktop app' });
    render(<ChatApp runtime={api} />);
    await screen.findByText('Open desktop app');
    expect(screen.getByTestId('connected')).toHaveTextContent('false');
  });

  it('disables sending without a familiar and never requests CLI history in browser mode', async () => {
    const api = runtime();
    vi.mocked(api.status).mockResolvedValue({ available: false, error: 'Open desktop app' });
    render(<ChatApp runtime={api} />);
    await screen.findByText('Open desktop app');
    expect(screen.getByRole('textbox')).toBeDisabled();
    expect(api.listSessions).not.toHaveBeenCalled();
    expect(api.send).not.toHaveBeenCalled();
  });

  it('preserves corrupt saved state rather than overwriting it', async () => {
    localStorage.setItem(STORAGE, '{broken');
    await ready(runtime());
    draft('memory draft');
    expect(localStorage.getItem(STORAGE)).toBe('{broken');
    expect(screen.getByRole('alert')).toHaveTextContent('Cannot restore saved navigation');
  });

  it('coalesces streamed events arriving on separate ticks into bounded renders without dropping any', async () => {
    const api = runtime();
    const run = deferred<CovenRunResult>();
    let deliver: ((event: CovenRunEvent) => void) | undefined;
    vi.mocked(api.send).mockImplementation((_input, onEvent) => {
      deliver = onEvent;
      return run.promise;
    });
    await ready(api);
    draft('stream');
    click('Send');
    await waitFor(() => expect(deliver).toBeDefined());
    const before = counters.layoutRenders;
    // Native IPC hands over one event per task; render work must not scale with count.
    for (let index = 0; index < 200; index += 1) {
      deliver?.({ type: 'text_delta', text: `chunk-${index} ` });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await waitFor(() => expect(screen.getByRole('log')).toHaveTextContent('chunk-199'));
    expect(screen.getByRole('log').textContent).toContain('chunk-0 chunk-1 chunk-2 ');
    expect(counters.layoutRenders - before).toBeLessThan(60);
    await act(async () => run.resolve({ runId: 'run', events: [] }));
    expect(screen.getByRole('log')).toHaveTextContent('chunk-199');
  });

  it('cancels once on unmount and ignores the old run completion', async () => {
    const api = runtime();
    const run = deferred<CovenRunResult>();
    vi.mocked(api.send).mockReturnValue(run.promise);
    const view = await ready(api);
    draft('work');
    click('Send');
    view.unmount();
    await waitFor(() => expect(api.cancel).toHaveBeenCalledOnce());
    await act(async () => run.resolve({ runId: 'run', events: [] }));
    expect(api.listSessions).toHaveBeenCalledOnce();
  });
});
