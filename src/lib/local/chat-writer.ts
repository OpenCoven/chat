import type { CaveConversation, CaveConversationMessage } from '@opencoven/cave-client/managed';
import type { Page, PageOptions } from '@opencoven/sdk-core/browser';

import { type ChatStore, ChatStoreError } from './chat-store';
import { toCaveMessage } from './local-query-adapter';
import type {
  BringBackInput,
  BringBackPreconditions,
  CreateSideInput,
  SideConversation,
  SideTarget,
} from './side-conversations';
import {
  ChatWriteRecoveryError,
  type RootWriteReconciliation,
  type RootWriteRecovery,
} from './write-recovery';

export type SideConversationWriter = Readonly<{
  custody: 'local-only';
  get: (conversationId: string) => Promise<WriteResult<SideConversation | null>>;
  list: (
    parentConversationId: string,
    options?: PageOptions,
  ) => Promise<WriteResult<Page<SideConversation>>>;
  create: (input: CreateSideInput) => Promise<WriteResult<SideConversation>>;
  setState: (
    input: SideTarget,
    state: 'open' | 'closed' | 'discarded',
  ) => Promise<WriteResult<SideConversation>>;
  bringBack: (input: BringBackInput) => Promise<WriteResult<CaveConversationMessage>>;
  prepareBringBack: (input: SideTarget) => Promise<WriteResult<BringBackPreconditions>>;
}>;

/**
 * Write outcomes are a separate union from `QueryResult`.
 *
 * `unsupported` is first-class rather than an error code because it is the
 * normal, permanent answer for a Cave-backed source: Cave Client v1 exposes no
 * write operation at all, so a composer pointed at Cave must disable itself
 * rather than fail per keystroke.
 */
export type WriteResult<T> =
  | { status: 'ok'; data: T }
  | { status: 'unsupported'; reason: string }
  | { status: 'error'; code: string };

export type RootWriteResult<T> =
  | WriteResult<T>
  | { status: 'reconcile_required'; recovery: RootWriteRecovery };

export type ChatWriter = Readonly<{
  sideConversations?: SideConversationWriter;
  canWrite: () => boolean;
  createConversation: (title?: string) => Promise<RootWriteResult<CaveConversation>>;
  reconcileWrite?: (receiptId: string) => Promise<WriteResult<RootWriteReconciliation>>;
  sendMessage: (
    conversationId: string,
    text: string,
  ) => Promise<RootWriteResult<CaveConversationMessage>>;
}>;

const UNSUPPORTED_REASON =
  'Coven Cave conversations are read-only in this release. Cave Client v1 has no write operation.';

function toError(error: unknown): WriteResult<never> {
  if (error instanceof ChatStoreError) {
    return { status: 'error', code: error.code };
  }
  return { status: 'error', code: 'service_unavailable' };
}

/**
 * The writer used for the Cave source. Always refuses, and says why.
 */
export function createReadOnlyChatWriter(reason: string = UNSUPPORTED_REASON): ChatWriter {
  const refuse = <T>(): Promise<WriteResult<T>> =>
    Promise.resolve({ status: 'unsupported', reason });

  return Object.freeze({
    canWrite: () => false,
    createConversation: refuse<CaveConversation>,
    sendMessage: refuse<CaveConversationMessage>,
  });
}

export function createLocalChatWriter(store: ChatStore): ChatWriter {
  async function write<T>(operation: () => T | Promise<T>): Promise<WriteResult<T>> {
    try {
      return { status: 'ok', data: await operation() };
    } catch (error) {
      return toError(error);
    }
  }
  return Object.freeze({
    canWrite: () => true,
    reconcileWrite: (receiptId: string) => write(() => store.reconcileWrite(receiptId)),
    sideConversations: Object.freeze({
      custody: 'local-only' as const,
      get: (id: string) => write(() => store.getSideConversation(id) ?? null),
      list: (id: string, options?: PageOptions) =>
        write(() => {
          const limit = options?.limit ?? 20;
          if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
            throw new ChatStoreError('invalid_request', 'The side note page limit is invalid.');
          }
          return store.listSideConversations(id, limit, options?.cursor);
        }),
      create: (input: CreateSideInput) => write(() => store.createSideConversation(input)),
      setState: (input: SideTarget, state: 'open' | 'closed' | 'discarded') =>
        write(() => store.setSideState(input, state)),
      bringBack: (input: BringBackInput) =>
        write(async () => toCaveMessage(await store.bringBack(input))),
      prepareBringBack: (input: SideTarget) => write(() => store.prepareBringBack(input)),
    }),

    async createConversation(title) {
      try {
        const conversation = await store.createConversation(title);
        return {
          status: 'ok',
          data: {
            id: conversation.id,
            familiarId: conversation.familiarId,
            title: conversation.title,
            origin: 'local',
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt,
          },
        };
      } catch (error: unknown) {
        if (error instanceof ChatWriteRecoveryError)
          return { status: 'reconcile_required', recovery: error.recovery };
        return toError(error);
      }
    },

    async sendMessage(conversationId, text) {
      try {
        const message = await store.appendMessage(conversationId, 'user', text);
        return {
          status: 'ok',
          data: {
            id: message.id,
            conversationId: message.conversationId,
            parentId: message.parentId,
            role: message.role,
            text: message.text,
            createdAt: message.createdAt,
            // No local attachment or tool pipeline exists yet; reporting zero
            // is the truth, not a placeholder.
            attachmentCount: 0,
            toolCount: 0,
          },
        };
      } catch (error: unknown) {
        if (error instanceof ChatWriteRecoveryError)
          return { status: 'reconcile_required', recovery: error.recovery };
        return toError(error);
      }
    },
  });
}
