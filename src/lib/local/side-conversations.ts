import {
  isBringBackPreconditions,
  type StoredConversation,
  type StoredMessage,
} from './chat-records';
import { ChatStoreError, MAX_MESSAGE_TEXT_LENGTH } from './chat-store';

export type SideConversation = StoredConversation & {
  side: NonNullable<StoredConversation['side']>;
};

export type CreateSideInput = Readonly<{
  parentConversationId: string;
  operationKey: string;
}>;

export type SideTarget = Readonly<{
  parentConversationId: string;
  sideConversationId: string;
}>;

export type BringBackPreconditions = Readonly<{
  parentRevision: number;
  parentLeafId: string | null;
  sideRevision: number;
  sideLeafId: string | null;
}>;

export type BringBackSelectionInput = SideTarget &
  Readonly<{
    operationKey: string;
    sourceMessageIds: readonly string[];
    excerpt: string;
  }>;

export type BringBackInput = BringBackSelectionInput &
  Readonly<{
    preconditions: BringBackPreconditions;
  }>;

export function operationKey(value: string): string {
  if (!value || value.length > 200 || value.trim() !== value) {
    throw new ChatStoreError('invalid_request', 'A bounded operation key is required.');
  }
  return value;
}

export function reviewedExcerpt(input: BringBackInput): string {
  operationKey(input.operationKey);
  if (
    !input.excerpt.trim() ||
    !isBringBackPreconditions(input.preconditions) ||
    input.excerpt.length > MAX_MESSAGE_TEXT_LENGTH ||
    input.sourceMessageIds.length === 0 ||
    input.sourceMessageIds.length > 50 ||
    new Set(input.sourceMessageIds).size !== input.sourceMessageIds.length
  ) {
    throw new ChatStoreError('invalid_request', 'Select messages and review a bounded excerpt.');
  }
  // Preserve exactly what was reviewed, including whitespace.
  return input.excerpt;
}

export function sameImport(message: StoredMessage, input: BringBackInput): boolean {
  const left = message.broughtBack?.preconditions;
  const right = input.preconditions;
  const sameBranch =
    left === right ||
    (left !== undefined &&
      right !== undefined &&
      left.parentRevision === right.parentRevision &&
      left.parentLeafId === right.parentLeafId &&
      left.sideRevision === right.sideRevision &&
      left.sideLeafId === right.sideLeafId);
  return (
    message.conversationId === input.parentConversationId &&
    message.text === input.excerpt &&
    message.broughtBack?.sideConversationId === input.sideConversationId &&
    sameBranch &&
    JSON.stringify(message.broughtBack.sourceMessageIds) === JSON.stringify(input.sourceMessageIds)
  );
}
