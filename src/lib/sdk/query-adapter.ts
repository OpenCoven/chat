import type {
  CaveAnalyticsWindowKey,
  CaveFamiliarAnalytics,
  CaveFamiliarContract,
} from '@opencoven/cave-client';
import {
  type CaveCanonicalFamiliar,
  type CaveConversation,
  type CaveConversationMessage,
  type CaveProject,
  isCaveClientError,
} from '@opencoven/cave-client/managed';
import { normalizePageOptions, type Page, type PageOptions } from '@opencoven/sdk-core/browser';

import type { CaveReadClient } from './connection-controller';

export type QueryResult<T> =
  | { status: 'not_ready' }
  | { status: 'loading' }
  | { status: 'stale' }
  | { status: 'reconcile_required' }
  | { status: 'error'; code: string }
  | { status: 'ok'; data: T };

export type FamiliarAnalyticsQuery = Readonly<{
  window?: CaveAnalyticsWindowKey;
  recentLimit?: number;
}>;

export type QueryAdapter = {
  listFamiliars(options?: PageOptions): Promise<QueryResult<Page<CaveCanonicalFamiliar>>>;
  listProjects(options?: PageOptions): Promise<QueryResult<Page<CaveProject>>>;
  listConversations(options?: PageOptions): Promise<QueryResult<Page<CaveConversation>>>;
  getConversation(conversationId: string): Promise<QueryResult<CaveConversation>>;
  listMessages(
    conversationId: string,
    options?: PageOptions,
  ): Promise<QueryResult<Page<CaveConversationMessage>>>;
  familiarContract(familiarId: string): Promise<QueryResult<CaveFamiliarContract>>;
  familiarAnalytics(
    familiarId: string,
    options?: FamiliarAnalyticsQuery,
  ): Promise<QueryResult<CaveFamiliarAnalytics>>;
  invalidate(): void;
  dispose(): void;
};

export type QueryAdapterOptions = Readonly<{
  now?: () => number;
  listTtlMs?: number;
  detailTtlMs?: number;
  maxCacheEntries?: number;
}>;

type QueryChannel =
  | 'familiars'
  | 'projects'
  | 'conversations'
  | 'conversation-detail'
  | 'messages'
  | 'familiar-contract'
  | 'familiar-analytics';

type InflightEntry<T> = Readonly<{
  channelGeneration: number;
  channel: QueryChannel;
  client: CaveReadClient;
  controller: AbortController;
  epoch: number;
  promise: Promise<QueryResult<T>>;
}>;

type CacheEntry<T> = Readonly<{
  expiresAt: number;
  result: QueryResult<T>;
}>;

type Availability = 'ready' | 'stale' | 'not_ready';
type NormalizedPageOptionsResult =
  | Readonly<{ status: 'ok'; options: Readonly<PageOptions> }>
  | Readonly<{ status: 'error'; result: QueryResult<never> }>;

const DEFAULT_PAGE_LIMIT = 50;
const DEFAULT_LIST_TTL_MS = 5_000;
const DEFAULT_DETAIL_TTL_MS = 2_000;
const DEFAULT_MAX_CACHE_ENTRIES = 32;
const NOT_READY_RESULT = Object.freeze({ status: 'not_ready' } as const);
const STALE_RESULT = Object.freeze({ status: 'stale' } as const);
const RECONCILE_REQUIRED_RESULT = Object.freeze({ status: 'reconcile_required' } as const);
const INVALID_REQUEST_RESULT = Object.freeze({
  status: 'error',
  code: 'invalid_request',
} as const);

function immutableCopy<T>(value: T, seen = new Map<object, unknown>()): T {
  if (typeof value !== 'object' || value === null) {
    return value;
  }

  const existing = seen.get(value);
  if (existing !== undefined) {
    return existing as T;
  }

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    copy.push(...value.map((entry) => immutableCopy(entry, seen)));
    return Object.freeze(copy) as T;
  }

  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, entry] of Object.entries(value)) {
    copy[key] = immutableCopy(entry, seen);
  }
  return Object.freeze(copy) as T;
}

function freezeResult<T>(result: QueryResult<T>): QueryResult<T> {
  if (result.status === 'ok') {
    return Object.freeze({
      status: 'ok',
      data: immutableCopy(result.data),
    });
  }

  return Object.freeze(result);
}

function extractCode(error: unknown): string {
  return isCaveClientError(error) ? error.code : 'service_unavailable';
}

function isReconcileRequired(error: unknown): boolean {
  return isCaveClientError(error) && error.code === 'reconcile_required';
}

function normalizeBoundedPageOptions(options?: PageOptions): NormalizedPageOptionsResult {
  const requestedLimit = options?.limit;

  try {
    const normalized = normalizePageOptions({
      limit: requestedLimit === undefined ? DEFAULT_PAGE_LIMIT : requestedLimit,
      ...(options?.cursor === undefined ? {} : { cursor: options.cursor }),
    });

    return Object.freeze({
      status: 'ok',
      options: Object.freeze(normalized),
    });
  } catch {
    return Object.freeze({ status: 'error', result: INVALID_REQUEST_RESULT });
  }
}

function pageIdentity(options: Readonly<PageOptions>): string {
  return options.cursor === undefined
    ? `limit:${options.limit}`
    : `limit:${options.limit}:cursor:${options.cursor}`;
}

export function createQueryAdapter(
  getClient: () => CaveReadClient | null,
  options: QueryAdapterOptions = {},
): QueryAdapter {
  const now = options.now ?? (() => Date.now());
  const listTtlMs = options.listTtlMs ?? DEFAULT_LIST_TTL_MS;
  const detailTtlMs = options.detailTtlMs ?? DEFAULT_DETAIL_TTL_MS;
  const maxCacheEntries =
    typeof options.maxCacheEntries === 'number' &&
    Number.isSafeInteger(options.maxCacheEntries) &&
    options.maxCacheEntries > 0
      ? options.maxCacheEntries
      : DEFAULT_MAX_CACHE_ENTRIES;

  let epoch = 0;
  let disposed = false;
  let nextClientId = 0;
  const clientIds = new WeakMap<CaveReadClient, number>();
  const inflight = new Map<string, InflightEntry<unknown>>();
  const cache = new Map<string, CacheEntry<unknown>>();
  const channelGenerations = new Map<QueryChannel, number>();

  function clientId(client: CaveReadClient): number {
    const existing = clientIds.get(client);
    if (existing !== undefined) {
      return existing;
    }

    nextClientId += 1;
    clientIds.set(client, nextClientId);
    return nextClientId;
  }

  function requestKey(channel: QueryChannel, identity: string): string {
    return `${channel}:${identity}`;
  }

  function cacheKey(client: CaveReadClient, key: string): string {
    return `${clientId(client)}:${key}`;
  }

  function nextChannelGeneration(channel: QueryChannel): number {
    const generation = (channelGenerations.get(channel) ?? 0) + 1;
    channelGenerations.set(channel, generation);
    return generation;
  }

  function availabilityFor(
    startedEpoch: number,
    channel: QueryChannel,
    startedChannelGeneration: number,
    client: CaveReadClient,
  ): Availability {
    if (disposed) {
      return 'not_ready';
    }
    if (epoch !== startedEpoch || channelGenerations.get(channel) !== startedChannelGeneration) {
      return 'stale';
    }
    return getClient() === client ? 'ready' : 'stale';
  }

  function clearCache(): void {
    cache.clear();
  }

  function abortInflight(): void {
    for (const entry of inflight.values()) {
      entry.controller.abort();
    }
    inflight.clear();
  }

  function abortSupersededChannelReads(
    channel: QueryChannel,
    client: CaveReadClient,
    startedEpoch: number,
  ): void {
    for (const [key, entry] of inflight) {
      if (entry.channel === channel && entry.client === client && entry.epoch === startedEpoch) {
        entry.controller.abort();
        inflight.delete(key);
      }
    }
  }

  function remember<T>(
    client: CaveReadClient,
    key: string,
    ttlMs: number,
    result: QueryResult<T>,
  ): QueryResult<T> {
    const frozen = freezeResult(result);
    const selectedKey = cacheKey(client, key);

    cache.delete(selectedKey);
    cache.set(
      selectedKey,
      Object.freeze({
        expiresAt: now() + ttlMs,
        result: frozen,
      }),
    );

    while (cache.size > maxCacheEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      cache.delete(oldest);
    }

    return frozen;
  }

  function cached<T>(client: CaveReadClient, key: string): QueryResult<T> | undefined {
    const selectedKey = cacheKey(client, key);
    const hit = cache.get(selectedKey) as CacheEntry<T> | undefined;

    if (hit === undefined) {
      return undefined;
    }
    if (hit.expiresAt <= now()) {
      cache.delete(selectedKey);
      return undefined;
    }

    cache.delete(selectedKey);
    cache.set(selectedKey, hit);
    return hit.result;
  }

  function invalidate(): void {
    if (disposed) {
      return;
    }

    epoch += 1;
    abortInflight();
    clearCache();
  }

  function dispose(): void {
    if (disposed) {
      return;
    }

    disposed = true;
    epoch += 1;
    abortInflight();
    clearCache();
  }

  async function runRead<T>(
    channel: QueryChannel,
    identity: string,
    ttlMs: number,
    exec: (client: CaveReadClient, signal: AbortSignal) => Promise<T>,
  ): Promise<QueryResult<T>> {
    if (disposed) {
      return NOT_READY_RESULT;
    }

    const client = getClient();
    if (client === null) {
      return NOT_READY_RESULT;
    }

    const key = requestKey(channel, identity);
    const startedEpoch = epoch;
    const inflightKey = `${startedEpoch}:${cacheKey(client, key)}`;
    const existing = inflight.get(inflightKey) as InflightEntry<T> | undefined;
    const currentChannelGeneration = channelGenerations.get(channel) ?? 0;
    if (existing !== undefined && existing.channelGeneration === currentChannelGeneration) {
      return existing.promise;
    }
    abortSupersededChannelReads(channel, client, startedEpoch);

    const startedChannelGeneration = nextChannelGeneration(channel);
    const cachedResult = cached<T>(client, key);
    if (cachedResult !== undefined) {
      return cachedResult;
    }

    const controller = new AbortController();

    let promise!: Promise<QueryResult<T>>;
    promise = (async (): Promise<QueryResult<T>> => {
      try {
        const data = await exec(client, controller.signal);
        const availability = availabilityFor(
          startedEpoch,
          channel,
          startedChannelGeneration,
          client,
        );
        if (availability !== 'ready') {
          return availability === 'not_ready' ? NOT_READY_RESULT : STALE_RESULT;
        }

        return remember(client, key, ttlMs, {
          status: 'ok',
          data,
        });
      } catch (error: unknown) {
        const availability = availabilityFor(
          startedEpoch,
          channel,
          startedChannelGeneration,
          client,
        );
        if (controller.signal.aborted || availability !== 'ready') {
          return availability === 'not_ready' ? NOT_READY_RESULT : STALE_RESULT;
        }
        if (isReconcileRequired(error)) {
          return remember(client, key, ttlMs, RECONCILE_REQUIRED_RESULT);
        }

        return remember(client, key, ttlMs, {
          status: 'error',
          code: extractCode(error),
        });
      } finally {
        const active = inflight.get(inflightKey);
        if (active?.promise === promise) {
          inflight.delete(inflightKey);
        }
      }
    })();

    inflight.set(
      inflightKey,
      Object.freeze({
        channelGeneration: startedChannelGeneration,
        channel,
        client,
        controller,
        epoch: startedEpoch,
        promise,
      }),
    );

    return promise;
  }

  return Object.freeze({
    listFamiliars(readOptions) {
      const normalized = normalizeBoundedPageOptions(readOptions);
      if (normalized.status === 'error') {
        return Promise.resolve(normalized.result);
      }
      const page = normalized.options;
      return runRead('familiars', pageIdentity(page), listTtlMs, (client, signal) =>
        client.listFamiliars({ ...page, signal }),
      );
    },
    listProjects(readOptions) {
      const normalized = normalizeBoundedPageOptions(readOptions);
      if (normalized.status === 'error') {
        return Promise.resolve(normalized.result);
      }
      const page = normalized.options;
      return runRead('projects', pageIdentity(page), listTtlMs, (client, signal) =>
        client.listProjects({ ...page, signal }),
      );
    },
    listConversations(readOptions) {
      const normalized = normalizeBoundedPageOptions(readOptions);
      if (normalized.status === 'error') {
        return Promise.resolve(normalized.result);
      }
      const page = normalized.options;
      return runRead('conversations', pageIdentity(page), listTtlMs, (client, signal) =>
        client.listConversations({ ...page, signal }),
      );
    },
    getConversation(conversationId) {
      return runRead('conversation-detail', conversationId, detailTtlMs, (client, signal) =>
        client.getConversation(conversationId, { signal }),
      );
    },
    listMessages(conversationId, readOptions) {
      const normalized = normalizeBoundedPageOptions(readOptions);
      if (normalized.status === 'error') {
        return Promise.resolve(normalized.result);
      }
      const page = normalized.options;
      return runRead(
        'messages',
        `${conversationId}:${pageIdentity(page)}`,
        detailTtlMs,
        (client, signal) => client.listConversationMessages(conversationId, { ...page, signal }),
      );
    },
    familiarContract(familiarId) {
      return runRead('familiar-contract', familiarId, detailTtlMs, (client, signal) =>
        client.familiarContract(familiarId, { signal }),
      );
    },
    familiarAnalytics(familiarId, query) {
      const window = query?.window;
      const recentLimit = query?.recentLimit;
      return runRead(
        'familiar-analytics',
        `${familiarId}:${window ?? 'all-windows'}:${recentLimit ?? 'default-recent'}`,
        detailTtlMs,
        (client, signal) =>
          client.familiarAnalytics(familiarId, {
            ...(window === undefined ? {} : { window }),
            ...(recentLimit === undefined ? {} : { recentLimit }),
            signal,
          }),
      );
    },
    invalidate,
    dispose,
  });
}
