import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './app';
import type { ChatRecords } from './lib/local/chat-records';
import { createLocalChatSource, type LocalChatSource } from './lib/local/chat-source';
import { createMemoryChatBackend } from './lib/local/memory-backend';

const history: ChatRecords = {
  conversations: [
    {
      id: 'existing',
      familiarId: 'local',
      title: 'Existing local history',
      createdAt: '2026-09-11T00:00:00.000Z',
      updatedAt: '2026-09-11T00:00:00.000Z',
    },
  ],
  messages: [
    {
      id: 'saved',
      conversationId: 'existing',
      parentId: null,
      role: 'user',
      text: 'Previously saved content',
      createdAt: '2026-09-11T00:00:00.000Z',
    },
  ],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function appProps() {
  return {
    desktopIdentityHost: { canUseTauriCommands: () => true, readInstallationId: vi.fn() },
    controllerFactory: vi.fn(),
    queryAdapterFactory: vi.fn(),
  };
}

test.each(['revision', 'snapshot'] as const)(
  'an actual initial %s failure reaches a local retry gate and retry loads unchanged history',
  async (stage) => {
    const memory = createMemoryChatBackend(history);
    const close = vi.fn(memory.close);
    let fail = true;
    const backend = {
      ...memory,
      close,
      getMutationRevision: async () => {
        if (fail && stage === 'revision') throw new Error('Initial revision unavailable');
        return memory.getMutationRevision?.() ?? 0;
      },
      loadAll: async () => {
        if (fail && stage === 'snapshot') throw new Error('Initial snapshot unavailable');
        return memory.loadAll();
      },
    };
    const factory = vi.fn(() => createLocalChatSource({ backend, familiarId: 'local' }));
    const props = appProps();
    const view = render(<App {...props} localSourceFactory={factory} />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Local chat storage could not be opened',
    );
    expect(view.container.querySelector('.connection-gate__spinner')).toBeNull();
    expect(screen.queryByRole('button', { name: 'New' })).toBeNull();
    expect(close).not.toHaveBeenCalled();
    expect(await memory.loadAll()).toEqual(history);
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry local storage' }));
    await screen.findByRole('heading', { name: 'Existing local history' });
    await screen.findByText('Previously saved content');
    expect(factory).toHaveBeenCalledTimes(2);
    expect(close).not.toHaveBeenCalled();
    expect(await memory.loadAll()).toEqual(history);
    expect(props.desktopIdentityHost.readInstallationId).not.toHaveBeenCalled();
    expect(props.controllerFactory).not.toHaveBeenCalled();
    expect(props.queryAdapterFactory).not.toHaveBeenCalled();
    view.unmount();
    expect(close).toHaveBeenCalledOnce();
  },
);

test('a synchronous factory failure also becomes a local startup error', async () => {
  const props = appProps();
  render(
    <App
      {...props}
      localSourceFactory={() => {
        throw new Error('Synchronous factory failure');
      }}
    />,
  );
  await screen.findByRole('button', { name: 'Retry local storage' });
  expect(props.controllerFactory).not.toHaveBeenCalled();
});

test('present IndexedDB opening failures reach App without empty memory success or Cave calls', async () => {
  const open = vi.fn(() => {
    throw new DOMException('Storage denied', 'SecurityError');
  });
  vi.stubGlobal('indexedDB', { open });
  const props = appProps();
  const view = render(<App {...props} localSourceFactory={() => createLocalChatSource()} />);
  try {
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'New' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Retry local storage' }));
    await waitFor(() => expect(open).toHaveBeenCalledTimes(2));
    await screen.findByRole('alert');
    expect(props.desktopIdentityHost.readInstallationId).not.toHaveBeenCalled();
    expect(props.controllerFactory).not.toHaveBeenCalled();
    expect(props.queryAdapterFactory).not.toHaveBeenCalled();
  } finally {
    view.unmount();
    vi.unstubAllGlobals();
  }
});

test.each(['resolve', 'reject'] as const)(
  'an obsolete factory %s cannot replace or fail the current local source',
  async (outcome) => {
    const stale = deferred<LocalChatSource>();
    const next = deferred<LocalChatSource>();
    const oldFactory = vi.fn(() => stale.promise);
    const newFactory = vi.fn(() => next.promise);
    const oldBackend = createMemoryChatBackend();
    const closeOld = vi.fn(oldBackend.close);
    const oldSource = await createLocalChatSource({
      backend: { ...oldBackend, close: closeOld },
      familiarId: 'local',
    });
    const currentBackend = createMemoryChatBackend(history);
    const closeCurrent = vi.fn(currentBackend.close);
    const current = await createLocalChatSource({
      backend: { ...currentBackend, close: closeCurrent },
      familiarId: 'local',
    });
    const props = appProps();
    const view = render(<App {...props} localSourceFactory={oldFactory} />);
    await waitFor(() => expect(oldFactory).toHaveBeenCalledOnce());
    view.rerender(<App {...props} localSourceFactory={newFactory} />);
    await waitFor(() => expect(newFactory).toHaveBeenCalledOnce());
    await act(async () => {
      if (outcome === 'resolve') stale.resolve(oldSource);
      else stale.reject(new Error('Obsolete rejection'));
    });
    expect(screen.getByLabelText('Startup state')).toHaveTextContent(
      'Preparing local chat storage',
    );
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => next.resolve(current));
    await screen.findByRole('heading', { name: 'Existing local history' });
    expect(closeCurrent).not.toHaveBeenCalled();
    if (outcome === 'resolve') expect(closeOld).toHaveBeenCalledOnce();
    else oldSource.store.dispose();
    view.unmount();
    expect(closeCurrent).toHaveBeenCalledOnce();
  },
);

test.each(['resolve', 'reject'] as const)(
  'an unmounted factory %s is handled without leaking a completed source',
  async (outcome) => {
    const opening = deferred<LocalChatSource>();
    const factory = vi.fn(() => opening.promise);
    const backend = createMemoryChatBackend();
    const close = vi.fn(backend.close);
    const source = await createLocalChatSource({
      backend: { ...backend, close },
      familiarId: 'local',
    });
    const props = appProps();
    const view = render(<App {...props} localSourceFactory={factory} />);
    await waitFor(() => expect(factory).toHaveBeenCalledOnce());
    view.unmount();
    await act(async () => {
      if (outcome === 'resolve') opening.resolve(source);
      else opening.reject(new Error('Unmounted rejection'));
    });
    if (outcome === 'resolve') expect(close).toHaveBeenCalledOnce();
    else source.store.dispose();
    expect(props.controllerFactory).not.toHaveBeenCalled();
  },
);
