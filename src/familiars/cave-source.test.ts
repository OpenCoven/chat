import { describe, expect, it, vi } from 'vitest';

import type { QueryAdapter } from '../lib/sdk/query-adapter';
import { createCaveFamiliarsSource } from './cave-source';
import type { Capability, QueryResult } from './source';

function ok<T>(data: T): QueryResult<T> {
  return { status: 'ok', data };
}

function makeQueryAdapter(overrides: Partial<QueryAdapter> = {}): QueryAdapter {
  return {
    listFamiliars: vi.fn().mockResolvedValue(ok({ data: [] })),
    listProjects: vi.fn().mockResolvedValue(ok({ data: [] })),
    listConversations: vi.fn().mockResolvedValue(ok({ data: [] })),
    getConversation: vi.fn().mockResolvedValue({ status: 'not_ready' }),
    listMessages: vi.fn().mockResolvedValue(ok({ data: [] })),
    familiarContract: vi.fn().mockResolvedValue({ status: 'not_ready' }),
    familiarAnalytics: vi.fn().mockResolvedValue({ status: 'not_ready' }),
    invalidate: vi.fn(),
    dispose: vi.fn(),
    ...overrides,
  };
}

const CAPABILITIES: ReadonlySet<Capability> = new Set(['familiars', 'familiar-contract']);

describe('createCaveFamiliarsSource', () => {
  it('maps a familiars page through mapFamiliarSummary', async () => {
    const queryAdapter = makeQueryAdapter({
      listFamiliars: vi
        .fn()
        .mockResolvedValue(ok({ data: [{ id: 'astra', displayName: 'Astra', role: 'Guide' }] })),
    });
    const source = createCaveFamiliarsSource({ queryAdapter, capabilities: CAPABILITIES });

    const result = await source.familiars();
    expect(result).toEqual(
      ok({ data: [{ id: 'astra', name: 'Astra', role: 'Guide', status: 'offline' }] }),
    );
  });

  it('passes a non-ok familiars result straight through unmapped', async () => {
    const queryAdapter = makeQueryAdapter({
      listFamiliars: vi.fn().mockResolvedValue({ status: 'error', code: 'service_unavailable' }),
    });
    const source = createCaveFamiliarsSource({ queryAdapter, capabilities: CAPABILITIES });

    expect(await source.familiars()).toEqual({ status: 'error', code: 'service_unavailable' });
  });

  it('fetches a familiar contract by id and maps it to a detail', async () => {
    const familiarContract = vi.fn().mockResolvedValue(
      ok({
        id: 'astra',
        present: { soul: true, identity: true, ward: true, memory: true },
        report: { specVersion: '0.1.0', pass: true, properties: [], violations: [], warnings: [] },
      }),
    );
    const queryAdapter = makeQueryAdapter({ familiarContract });
    const source = createCaveFamiliarsSource({ queryAdapter, capabilities: CAPABILITIES });

    const result = await source.familiar('astra');
    expect(familiarContract).toHaveBeenCalledWith('astra');
    expect(result.status).toBe('ok');
    expect(result).toMatchObject({ data: { id: 'astra' } });
  });

  it('requests the default 7d window when none is given, and maps the response', async () => {
    const familiarAnalytics = vi.fn().mockResolvedValue(
      ok({
        generatedAt: '2026-08-25T00:00:00.000Z',
        windows: {
          '7d': {
            attempts: 1,
            completed: 1,
            failed: 0,
            cancelled: 0,
            successRate: 1,
            toolCalls: 4,
            toolFailures: 0,
            models: [],
            harnesses: [],
            coverage: {},
          },
        },
        recentAttempts: [],
        backfill: { state: 'complete', imported: 1 },
      }),
    );
    const queryAdapter = makeQueryAdapter({ familiarAnalytics });
    const source = createCaveFamiliarsSource({ queryAdapter, capabilities: CAPABILITIES });

    const result = await source.activity('astra');
    expect(familiarAnalytics).toHaveBeenCalledWith('astra', { window: '7d' });
    expect(result).toMatchObject({ status: 'ok', data: { window: '7d', attempts: 1 } });
  });

  it('requests an explicit window and returns not_found when Cave omits it from the response', async () => {
    const familiarAnalytics = vi.fn().mockResolvedValue(
      ok({
        generatedAt: '2026-08-25T00:00:00.000Z',
        windows: {},
        recentAttempts: [],
        backfill: { state: 'not-started', imported: 0 },
      }),
    );
    const queryAdapter = makeQueryAdapter({ familiarAnalytics });
    const source = createCaveFamiliarsSource({ queryAdapter, capabilities: CAPABILITIES });

    const result = await source.activity('astra', '14d');
    expect(familiarAnalytics).toHaveBeenCalledWith('astra', { window: '14d' });
    expect(result).toEqual({ status: 'error', code: 'not_found' });
  });

  it('passes a non-ok analytics result straight through without mapping', async () => {
    const queryAdapter = makeQueryAdapter({
      familiarAnalytics: vi.fn().mockResolvedValue({ status: 'reconcile_required' }),
    });
    const source = createCaveFamiliarsSource({ queryAdapter, capabilities: CAPABILITIES });

    expect(await source.activity('astra')).toEqual({ status: 'reconcile_required' });
  });

  it('maps a conversations page and a messages page through their mappers', async () => {
    const queryAdapter = makeQueryAdapter({
      listConversations: vi
        .fn()
        .mockResolvedValue(
          ok({ data: [{ id: 'c1', familiarId: 'astra', updatedAt: '2026-08-25T00:00:00.000Z' }] }),
        ),
      listMessages: vi.fn().mockResolvedValue(
        ok({
          data: [
            {
              id: 'm1',
              conversationId: 'c1',
              parentId: null,
              role: 'user',
              text: 'Hi',
              createdAt: '2026-08-25T00:00:00.000Z',
              attachmentCount: 0,
              toolCount: 0,
            },
          ],
        }),
      ),
    });
    const source = createCaveFamiliarsSource({ queryAdapter, capabilities: CAPABILITIES });

    const conversations = await source.conversations();
    expect(conversations).toMatchObject({
      data: { data: [{ id: 'c1', failed: false, pending: false }] },
    });

    const messages = await source.messages('c1');
    expect(queryAdapter.listMessages).toHaveBeenCalledWith('c1');
    expect(messages).toMatchObject({
      data: { data: [{ id: 'm1', role: 'user', isError: false }] },
    });
  });

  it('returns the capabilities it was constructed with, unchanged', () => {
    const source = createCaveFamiliarsSource({
      queryAdapter: makeQueryAdapter(),
      capabilities: CAPABILITIES,
    });
    expect(source.capabilities()).toBe(CAPABILITIES);
  });
});
