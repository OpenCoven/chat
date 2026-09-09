import type { Page } from '@opencoven/sdk-core/browser';

import type { QueryAdapter } from '../lib/sdk/query-adapter';
import {
  mapConversationSummary,
  mapFamiliarActivity,
  mapFamiliarDetail,
  mapFamiliarSummary,
  mapThreadMessage,
} from './mappers';
import type {
  ActivityWindow,
  Capability,
  ConversationSummary,
  FamiliarActivity,
  FamiliarDetail,
  FamiliarSummary,
  FamiliarsSource,
  QueryResult,
  ThreadMessage,
} from './source';

/**
 * `FamiliarsSource` over `QueryAdapter` and the managed `CaveClient`.
 *
 * Every method is a thin fetch-then-map: `QueryAdapter` owns the TTL / LRU /
 * abort / epoch semantics the rest of the production shell already uses,
 * and `./mappers.ts` owns the SDK-wire-type -> view-type translation. This
 * module adds no caching, retry, or formatting logic of its own.
 */

const DEFAULT_ACTIVITY_WINDOW: ActivityWindow = '7d';

export type CaveFamiliarsSourceOptions = Readonly<{
  queryAdapter: QueryAdapter;
  /**
   * The set of capability names the connected Cave instance advertises
   * (`CaveHealth.capabilities`). A snapshot rather than a live subscription:
   * the shell re-creates the source when connection state changes.
   */
  capabilities: ReadonlySet<Capability>;
}>;

function mapResult<T, U>(result: QueryResult<T>, map: (value: T) => U): QueryResult<U> {
  return result.status === 'ok' ? { status: 'ok', data: map(result.data) } : result;
}

function mapPageResult<T, U>(
  result: QueryResult<Page<T>>,
  map: (value: T) => U,
): QueryResult<Page<U>> {
  return result.status === 'ok'
    ? { status: 'ok', data: { ...result.data, data: result.data.data.map(map) } }
    : result;
}

export function createCaveFamiliarsSource(options: CaveFamiliarsSourceOptions): FamiliarsSource {
  const { queryAdapter, capabilities } = options;

  return Object.freeze({
    async familiars(): Promise<QueryResult<Page<FamiliarSummary>>> {
      return mapPageResult(await queryAdapter.listFamiliars(), mapFamiliarSummary);
    },
    async familiar(id: string): Promise<QueryResult<FamiliarDetail>> {
      return mapResult(await queryAdapter.familiarContract(id), mapFamiliarDetail);
    },
    async activity(
      id: string,
      window: ActivityWindow = DEFAULT_ACTIVITY_WINDOW,
    ): Promise<QueryResult<FamiliarActivity>> {
      const result = await queryAdapter.familiarAnalytics(id, { window });
      if (result.status !== 'ok') {
        return result;
      }
      const activity = mapFamiliarActivity(result.data, window);
      // Cave omitted the requested window (e.g. an instance with a shorter
      // retained history than `window` implies) rather than the read
      // failing outright.
      return activity === undefined
        ? { status: 'error', code: 'not_found' }
        : { status: 'ok', data: activity };
    },
    async conversations(): Promise<QueryResult<Page<ConversationSummary>>> {
      return mapPageResult(await queryAdapter.listConversations(), mapConversationSummary);
    },
    async messages(conversationId: string): Promise<QueryResult<Page<ThreadMessage>>> {
      return mapPageResult(await queryAdapter.listMessages(conversationId), mapThreadMessage);
    },
    capabilities(): ReadonlySet<Capability> {
      return capabilities;
    },
  });
}
