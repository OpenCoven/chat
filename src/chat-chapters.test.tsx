import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ChatChapters } from './chat-chapters';
import { ChatShell } from './chat-shell';
import {
  type ConversationChapterPage,
  hasValidChapterHeaders,
  loadedConversationChapters,
  utcChapterDay,
} from './lib/chat-chapters';
import type { CaveReadClient } from './lib/sdk/connection-controller';
import type { QueryAdapter, QueryResult } from './lib/sdk/query-adapter';
import { createQueryAdapter } from './lib/sdk/query-adapter';

const message = (id: string, createdAt: string, conversationId = 'one') => ({
  id,
  createdAt,
  conversationId,
  parentId: null,
  role: 'user',
  text: `text ${id}`,
  attachmentCount: 0,
  toolCount: 0,
});
const messages = [message('a', '2026-09-08T23:00:00Z'), message('b', '2026-09-09T01:00:00Z')];
const page = (sourceRevision = 'a'.repeat(64), hasMore = false): ConversationChapterPage => ({
  conversationId: 'one',
  rule: 'utc-day-v1',
  contextStatus: 'context-unverified',
  sourceRevision,
  status: 'complete',
  data: [...(loadedConversationChapters('one', messages) ?? [])],
  cursor: hasMore ? { hasMore: true, next: 'cursor-next' } : { hasMore: false },
});

const goldenPath = process.env.COVEN_CONTINUITY_GOLDEN_VECTORS;
test('a disconnected chapter source explains that its index is unavailable', async () => {
  render(
    <ChatChapters
      conversationId="one"
      messages={messages}
      hasMoreMessages={false}
      queryAdapter={
        { listChapters: vi.fn(async () => ({ status: 'not_ready' })) } as unknown as QueryAdapter
      }
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Ongoing/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Chapter index unavailable');
  expect(screen.queryByRole('navigation', { name: 'UTC chapters' })).not.toBeInTheDocument();
});

test('Escape invalidates a stale chapter index before keyboard reopening', async () => {
  let refreshed = false;
  const invalidate = vi.fn(() => {
    refreshed = true;
  });
  const listChapters = vi.fn(async () =>
    refreshed ? { status: 'ok', data: page() } : { status: 'stale' },
  );
  render(
    <ChatChapters
      conversationId="one"
      messages={messages}
      hasMoreMessages={false}
      queryAdapter={{ listChapters, invalidate } as unknown as QueryAdapter}
    />,
  );
  const toggle = screen.getByRole('button', { name: /Ongoing/ });
  fireEvent.click(toggle);
  await screen.findByRole('alert');
  fireEvent.keyDown(toggle, { key: 'Escape' });
  expect(invalidate).toHaveBeenCalledOnce();
  expect(toggle).toHaveFocus();
  fireEvent.click(toggle);
  expect(await screen.findByRole('navigation', { name: 'UTC chapters' })).toBeVisible();
});

test.skipIf(goldenPath === undefined)(
  'DEVELOPMENT builder matches Cave-owned canonical golden vectors',
  () => {
    if (!goldenPath)
      throw new Error('COVEN_CONTINUITY_GOLDEN_VECTORS must name the Cave-owned fixture');
    const golden = JSON.parse(readFileSync(goldenPath, 'utf8')) as {
      contract: string;
      algorithm: string;
      cases: {
        id: string;
        conversationId: string;
        turns: { id: string; createdAt: string }[];
        expected?: {
          id: string;
          date: string;
          firstTurnId: string;
          lastTurnId: string;
          turnCount: number;
        }[];
        expectedError?: string;
      }[];
    };
    expect(golden.contract).toBe('cave.familiar-continuity-v1');
    expect(golden.algorithm).toBe('utc-day-v1');
    expect(golden.cases.length).toBeGreaterThan(0);
    for (const vector of golden.cases) {
      const chapters = loadedConversationChapters(
        vector.conversationId,
        vector.turns.map((turn) => ({ ...turn, conversationId: vector.conversationId })),
      );
      if (vector.expectedError) {
        expect(chapters, vector.id).toBeNull();
        continue;
      }
      if (!vector.expected) throw new Error(`${vector.id} has no expected result`);
      expect(
        (chapters ?? []).map(({ id, day, firstTurnId, lastTurnId, turnCount }) => ({
          id,
          date: day,
          firstTurnId,
          lastTurnId,
          turnCount,
        })),
        vector.id,
      ).toEqual(vector.expected);
    }
  },
);

test('UTC-day-v1 matches stable producer anchors and preserves clock corrections', () => {
  const turns = [...messages, message('c', '2026-09-08T23:00:00Z')];
  const chapters = loadedConversationChapters('one', turns);
  expect(chapters?.map((chapter) => chapter.id)).toEqual(
    ['a', 'b', 'c'].map((id) => JSON.stringify(['utc-day-v1', 'one', id])),
  );
  expect(utcChapterDay('2026-09-09T00:30:00Z')).toBe('2026-09-09');
  expect(utcChapterDay('2026-09-09T00:30:00.123Z')).toBe('2026-09-09');
  for (const invalid of [
    null,
    4,
    '2026-02-30T00:00:00Z',
    '2026-09-09T01:00:00',
    'invalid',
    '2026-09-09T00:30:00+02:00',
    '2026-09-09T00:30:00+00:00',
    '2026-09-09T00:30:00.1Z',
    '2026-09-09T00:30:00.123456789Z',
  ]) {
    expect(utcChapterDay(invalid)).toBeNull();
  }
  expect(loadedConversationChapters('other', turns)).toBeNull();
  expect(
    loadedConversationChapters('one', [...turns, message('a', '2026-09-08T23:00:00Z')]),
  ).toBeNull();
});

test('old producers show loaded-only partial chapters without inventing a full index', async () => {
  render(
    <ChatChapters
      conversationId="one"
      messages={messages}
      hasMoreMessages
      queryAdapter={{} as QueryAdapter}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Ongoing/ }));
  expect(await screen.findByText(/Full chapter index unsupported/)).toHaveTextContent('(partial)');
  expect(screen.getByRole('button', { name: '2026-09-08 1 loaded turn' })).toBeVisible();
  expect(screen.getByText(/This conversation only/)).toHaveTextContent('Context unverified');
});

test('DEVELOPMENT header reads never prefetch transcript bodies and reject stale revision paging', async () => {
  const listChapters = vi
    .fn()
    .mockResolvedValueOnce({ status: 'ok', data: page('a'.repeat(64), true) })
    .mockResolvedValueOnce({ status: 'ok', data: page('b'.repeat(64)) })
    .mockResolvedValue({ status: 'ok', data: page('b'.repeat(64)) });
  const listMessages = vi.fn();
  const invalidate = vi.fn();
  render(
    <ChatChapters
      conversationId="one"
      messages={[]}
      hasMoreMessages
      queryAdapter={{ listChapters, listMessages, invalidate } as unknown as QueryAdapter}
    />,
  );
  expect(listChapters).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: /Ongoing/ }));
  fireEvent.click(await screen.findByRole('button', { name: '2026-09-08 1 turn' }));
  expect(screen.getByText(/This chapter is not loaded/)).toBeVisible();
  expect(listMessages).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Load more chapters' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('chapter index changed');
  expect(screen.queryByRole('navigation', { name: 'UTC chapters' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Ongoing/ }));
  expect(invalidate).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: /Ongoing/ }));
  expect(await screen.findByRole('navigation', { name: 'UTC chapters' })).toBeVisible();
});

test('a deleted anchor is explicit, and late source results stay quarantined', async () => {
  let resolve!: (value: QueryResult<ConversationChapterPage>) => void;
  const old = {
    listChapters: vi.fn(
      () =>
        new Promise<QueryResult<ConversationChapterPage>>((done) => {
          resolve = done;
        }),
    ),
  } as unknown as QueryAdapter;
  const current = {
    listChapters: vi.fn().mockResolvedValue({ status: 'ok', data: page() }),
  } as unknown as QueryAdapter;
  const view = render(
    <ChatChapters conversationId="one" messages={[]} hasMoreMessages={false} queryAdapter={old} />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Ongoing/ }));
  view.rerender(
    <ChatChapters
      conversationId="one"
      messages={[]}
      hasMoreMessages={false}
      queryAdapter={current}
    />,
  );
  fireEvent.click(await screen.findByRole('button', { name: '2026-09-08 1 turn' }));
  expect(screen.getByText(/anchor is no longer available/)).toBeVisible();
  await act(async () => resolve({ status: 'error', code: 'internal_error' }));
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test.each([
  ['another conversation', { conversationId: 'other' }],
  ['an impossible day', { day: '2026-02-30' }],
  ['an empty anchor', { firstTurnId: '' }],
  ['a nonpositive turn count', { turnCount: 0 }],
])('chapter headers reject %s instead of offering an unverified anchor', async (_, change) => {
  const valid = page();
  const listChapters = vi.fn(async () => ({
    status: 'ok' as const,
    data: {
      ...valid,
      data: valid.data.map((chapter, index) => (index === 0 ? { ...chapter, ...change } : chapter)),
    },
  }));
  const adapter = { listChapters } as unknown as QueryAdapter;
  render(
    <ChatChapters
      conversationId="one"
      messages={messages}
      hasMoreMessages={false}
      queryAdapter={adapter}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Ongoing/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Chapter index unavailable');
  expect(screen.queryByRole('navigation', { name: 'UTC chapters' })).not.toBeInTheDocument();
});

test('chapter paging rejects repeated headers despite a forward-moving cursor', async () => {
  const root = page('revision', true);
  const listChapters = vi
    .fn()
    .mockResolvedValueOnce({ status: 'ok', data: root })
    .mockResolvedValueOnce({
      status: 'ok',
      data: {
        ...root,
        cursor: { current: 'cursor-next', hasMore: false },
      },
    });
  render(
    <ChatChapters
      conversationId="one"
      messages={messages}
      hasMoreMessages={false}
      queryAdapter={{ listChapters } as unknown as QueryAdapter}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Ongoing/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Load more chapters' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('chapter index changed');
  expect(screen.queryByRole('navigation', { name: 'UTC chapters' })).not.toBeInTheDocument();
});

test('chapter header validation bounds pages and rejects duplicate anchors within a page', () => {
  const valid = page();
  const first = valid.data[0];
  if (!first) throw new Error('Missing first chapter fixture');
  expect(hasValidChapterHeaders(valid, 'one')).toBe(true);
  expect(
    hasValidChapterHeaders({ ...valid, data: [first, { ...first, id: 'another-id' }] }, 'one'),
  ).toBe(false);
  expect(hasValidChapterHeaders({ ...valid, sourceRevision: '' }, 'one')).toBe(false);
  const headers = Array.from({ length: 51 }, (_, index) => ({
    ...first,
    id: `chapter-${index}`,
    firstTurnId: `turn-${index}`,
    lastTurnId: `turn-${index}`,
    turnCount: 1,
  }));
  expect(hasValidChapterHeaders({ ...valid, data: headers.slice(0, 50) }, 'one')).toBe(true);
  expect(hasValidChapterHeaders({ ...valid, data: headers }, 'one')).toBe(false);
});

test('chapter header navigation retains the eight-page ceiling', async () => {
  const first = page().data[0];
  if (!first) throw new Error('Missing first chapter fixture');
  const listChapters = vi.fn(async (_id: string, options?: { cursor?: string }) => {
    const index = Number(options?.cursor ?? 0);
    return {
      status: 'ok' as const,
      data: {
        ...page('revision'),
        data: [
          {
            ...first,
            id: `chapter-${index}`,
            firstTurnId: `turn-${index}`,
            lastTurnId: `turn-${index}`,
            turnCount: 1,
          },
        ],
        cursor: {
          ...(options?.cursor ? { current: options.cursor } : {}),
          hasMore: true,
          next: String(index + 1),
        },
      },
    };
  });
  render(
    <ChatChapters
      conversationId="one"
      messages={[]}
      hasMoreMessages
      queryAdapter={{ listChapters } as unknown as QueryAdapter}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: /Ongoing/ }));
  for (let index = 1; index <= 8; index += 1) {
    fireEvent.click(await screen.findByRole('button', { name: 'Load more chapters' }));
  }
  expect(await screen.findByText(/Chapter page limit reached/)).toBeVisible();
  expect(listChapters).toHaveBeenCalledTimes(8);
});

test('chapter query caches remain source-bound, bounded and invalidatable', async () => {
  let finish!: (value: ConversationChapterPage) => void;
  const first = {
    listConversationChapters: vi.fn(
      () =>
        new Promise<ConversationChapterPage>((done) => {
          finish = done;
        }),
    ),
  } as unknown as CaveReadClient;
  const second = {
    listConversationChapters: vi.fn().mockResolvedValue(page()),
  } as unknown as CaveReadClient;
  let client = first;
  const adapter = createQueryAdapter(() => client, { maxCacheEntries: 1 });
  if (!adapter.listChapters) throw new Error('Chapter read port missing');
  const read = adapter.listChapters;
  const pending = read('one');
  client = second;
  finish(page());
  expect(await pending).toEqual({ status: 'stale' });
  expect((await read('one')).status).toBe('ok');
  adapter.invalidate();
  expect((await read('one')).status).toBe('ok');
  expect(second.listConversationChapters).toHaveBeenCalledTimes(2);
  adapter.dispose();
  expect(await read('one')).toEqual({ status: 'not_ready' });
});

test('same-name familiars keep separate exact conversations in the production shell', async () => {
  const conversations = [
    {
      id: 'one',
      familiarId: 'first',
      title: 'First exact thread',
      updatedAt: '2026-09-09T00:00:00Z',
    },
    {
      id: 'two',
      familiarId: 'second',
      title: 'Second exact thread',
      updatedAt: '2026-09-09T00:00:00Z',
    },
  ];
  const ok = <T,>(data: T) => ({ status: 'ok' as const, data });
  const adapter: QueryAdapter = {
    listFamiliars: vi.fn().mockResolvedValue(
      ok({
        data: [
          { id: 'first', displayName: 'Mara', role: 'Guide' },
          { id: 'second', displayName: 'Mara', role: 'Guide' },
        ],
      }),
    ),
    listProjects: vi.fn().mockResolvedValue(ok({ data: [] })),
    listConversations: vi.fn().mockResolvedValue(ok({ data: conversations })),
    getConversation: vi.fn(async (id) => {
      const record = conversations.find((conversation) => conversation.id === id);
      if (!record) throw new Error('Missing exact conversation');
      return ok(record);
    }),
    listMessages: vi.fn(async (id) => ok({ data: [message(id, '2026-09-09T00:00:00Z', id)] })),
    familiarContract: vi.fn(),
    familiarAnalytics: vi.fn(),
    invalidate: vi.fn(),
    dispose: vi.fn(),
  };
  render(<ChatShell queryAdapter={adapter} />);
  expect(await screen.findByText('text one')).toBeVisible();
  fireEvent.change(screen.getByRole('combobox', { name: 'Familiar' }), {
    target: { value: 'second' },
  });
  expect(await screen.findByText('text two')).toBeVisible();
  expect(screen.queryByText('text one')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Ongoing/ }));
  expect(await screen.findByText(/This conversation only/)).toBeVisible();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});
