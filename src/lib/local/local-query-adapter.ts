import type { CaveFamiliarAnalytics, CaveFamiliarContract } from '@opencoven/cave-client';
import type {
  CaveCanonicalFamiliar,
  CaveConversation,
  CaveConversationMessage,
  CaveProject,
} from '@opencoven/cave-client/managed';
import { normalizePageOptions, type Page, type PageOptions } from '@opencoven/sdk-core/browser';

import type { QueryAdapter, QueryResult } from '../sdk/query-adapter';
import type { StoredConversation, StoredMessage } from './chat-records';
import { type ChatStore, ChatStoreError } from './chat-store';

export const LOCAL_FAMILIAR_ID = 'local';

/**
 * The chat shell filters conversations by familiar, so local conversations need
 * a familiar to belong to. One synthetic entry keeps that filter meaningful
 * without inventing a roster the app cannot back up.
 */
export const LOCAL_FAMILIAR: CaveCanonicalFamiliar = Object.freeze({
  id: LOCAL_FAMILIAR_ID,
  displayName: 'This device',
  role: 'Local notes',
  description: 'Conversations stored on this device. No familiar is connected.',
  status: 'local',
});

const DEFAULT_PAGE_LIMIT = 50;
const NOT_READY_RESULT = Object.freeze({ status: 'not_ready' } as const);
const INVALID_REQUEST_RESULT = Object.freeze({
  status: 'error',
  code: 'invalid_request',
} as const);

/**
 * A familiar's contract and its execution analytics are Cave's to report. They
 * describe what a familiar has been granted and what it has since done, and a
 * device holding only local conversations has neither record. Standalone mode
 * answers `service_unavailable` rather than inventing an empty contract, which
 * would read as "this familiar is permitted nothing" instead of "nobody asked
 * Cave".
 */
const CAVE_ONLY_RESULT = Object.freeze({
  status: 'error',
  code: 'service_unavailable',
} as const);

const EMPTY_PAGE = Object.freeze({
  data: Object.freeze([]),
  cursor: Object.freeze({ hasMore: false }),
});

type NormalizedPage =
  | Readonly<{ status: 'ok'; limit: number; cursor?: string }>
  | Readonly<{ status: 'error' }>;

function normalize(options?: PageOptions): NormalizedPage {
  try {
    const normalized = normalizePageOptions({
      limit: options?.limit === undefined ? DEFAULT_PAGE_LIMIT : options.limit,
      ...(options?.cursor === undefined ? {} : { cursor: options.cursor }),
    });

    return Object.freeze({
      status: 'ok',
      limit: normalized.limit ?? DEFAULT_PAGE_LIMIT,
      ...(normalized.cursor === undefined ? {} : { cursor: normalized.cursor }),
    });
  } catch {
    return Object.freeze({ status: 'error' });
  }
}

export function toCaveConversation(entry: StoredConversation): CaveConversation {
  return Object.freeze({
    id: entry.id,
    familiarId: entry.familiarId,
    title: entry.title,
    origin: 'local',
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  });
}

export function toCaveMessage(entry: StoredMessage): CaveConversationMessage {
  return Object.freeze({
    id: entry.id,
    conversationId: entry.conversationId,
    parentId: entry.parentId,
    role: entry.role,
    text: entry.text,
    createdAt: entry.createdAt,
    attachmentCount: 0,
    toolCount: 0,
  });
}

function mapPage<From, To>(page: Page<From>, map: (entry: From) => To): Page<To> {
  return Object.freeze({
    data: Object.freeze(page.data.map(map)),
    cursor: page.cursor,
  }) as Page<To>;
}

function toErrorResult(error: unknown): QueryResult<never> {
  if (error instanceof ChatStoreError) {
    return Object.freeze({ status: 'error', code: error.code });
  }
  return Object.freeze({ status: 'error', code: 'service_unavailable' });
}

/**
 * A `QueryAdapter` over local storage.
 *
 * It reimplements the interface rather than wrapping `createQueryAdapter`
 * because every reason that adapter exists — network latency, request
 * deduplication, abort handling, TTL caching over a remote socket — is absent
 * here. Reads are synchronous map lookups; a cache in front of them would only
 * add a window in which the UI shows data the store has already replaced.
 */
export function createLocalQueryAdapter(store: ChatStore): QueryAdapter {
  let disposed = false;

  function guard<T>(read: () => QueryResult<T>): Promise<QueryResult<T>> {
    if (disposed) {
      return Promise.resolve(NOT_READY_RESULT);
    }
    try {
      return Promise.resolve(read());
    } catch (error: unknown) {
      return Promise.resolve(toErrorResult(error));
    }
  }

  return Object.freeze({
    listFamiliars(options) {
      return guard<Page<CaveCanonicalFamiliar>>(() => {
        const normalized = normalize(options);
        if (normalized.status === 'error') {
          return INVALID_REQUEST_RESULT;
        }
        return Object.freeze({
          status: 'ok',
          data: Object.freeze({
            data: Object.freeze([LOCAL_FAMILIAR]),
            cursor: Object.freeze(
              normalized.cursor === undefined
                ? { hasMore: false }
                : { current: normalized.cursor, hasMore: false },
            ),
          }) as Page<CaveCanonicalFamiliar>,
        });
      });
    },

    listProjects(options) {
      return guard<Page<CaveProject>>(() => {
        const normalized = normalize(options);
        if (normalized.status === 'error') {
          return INVALID_REQUEST_RESULT;
        }
        // Projects are a Cave concept. Local chat has none, and an empty page
        // is the honest answer rather than an error.
        return Object.freeze({
          status: 'ok',
          data:
            normalized.cursor === undefined
              ? (EMPTY_PAGE as Page<CaveProject>)
              : (Object.freeze({
                  data: Object.freeze([]),
                  cursor: Object.freeze({ current: normalized.cursor, hasMore: false }),
                }) as Page<CaveProject>),
        });
      });
    },

    listConversations(options) {
      return guard<Page<CaveConversation>>(() => {
        const normalized = normalize(options);
        if (normalized.status === 'error') {
          return INVALID_REQUEST_RESULT;
        }
        const page = store.listConversations(normalized.limit, normalized.cursor);
        return Object.freeze({ status: 'ok', data: mapPage(page, toCaveConversation) });
      });
    },

    getConversation(conversationId) {
      return guard<CaveConversation>(() => {
        const conversation = store.getConversation(conversationId);
        if (conversation === undefined) {
          return Object.freeze({ status: 'error', code: 'not_found' });
        }
        return Object.freeze({ status: 'ok', data: toCaveConversation(conversation) });
      });
    },

    listMessages(conversationId, options) {
      return guard<Page<CaveConversationMessage>>(() => {
        const normalized = normalize(options);
        if (normalized.status === 'error') {
          return INVALID_REQUEST_RESULT;
        }
        if (store.getConversation(conversationId) === undefined) {
          return Object.freeze({ status: 'error', code: 'not_found' });
        }
        const page = store.listMessages(conversationId, normalized.limit, normalized.cursor);
        return Object.freeze({ status: 'ok', data: mapPage(page, toCaveMessage) });
      });
    },

    familiarContract() {
      return guard<CaveFamiliarContract>(() => CAVE_ONLY_RESULT);
    },

    familiarAnalytics() {
      return guard<CaveFamiliarAnalytics>(() => CAVE_ONLY_RESULT);
    },

    invalidate() {
      // Reads go straight to the in-memory index, so there is nothing stale to
      // drop. Kept to satisfy the interface the shell calls on refresh.
    },

    dispose() {
      disposed = true;
    },
  });
}
