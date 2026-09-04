import type { CaveConversation, CaveConversationMessage } from '@opencoven/cave-client/managed';

import { type ChatStore, ChatStoreError } from './chat-store';

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

export type ChatWriter = Readonly<{
  canWrite: () => boolean;
  createConversation: (title?: string) => Promise<WriteResult<CaveConversation>>;
  sendMessage: (
    conversationId: string,
    text: string,
  ) => Promise<WriteResult<CaveConversationMessage>>;
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
  return Object.freeze({
    canWrite: () => true,

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
        return toError(error);
      }
    },
  });
}
