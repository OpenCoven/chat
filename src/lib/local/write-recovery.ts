import type { StoredConversation, StoredMessage } from './chat-records';

export type RootWriteReceipt =
  | (StoredConversation & { kind: 'conversation' })
  | (StoredMessage & { kind: 'message'; familiarId: string });

export type RootWriteRecovery = Readonly<{
  receipt: RootWriteReceipt;
  commit: 'confirmed' | 'unconfirmed';
  code: 'refresh_failed' | 'commit_unconfirmed';
}>;

export type RootWriteReconciliation = Readonly<{
  receipt: RootWriteReceipt;
  outcome: 'committed' | 'not_committed';
}>;

export class ChatWriteRecoveryError extends Error {
  constructor(
    readonly recovery: RootWriteRecovery,
    cause?: unknown,
  ) {
    super('The exact local save must be reconciled before another attempt.', { cause });
    this.name = 'ChatWriteRecoveryError';
  }
}

export function writeRecoveryNotice(recovery: RootWriteRecovery): string {
  const subject = recovery.receipt.kind === 'message' ? 'message' : 'conversation';
  return recovery.commit === 'confirmed'
    ? `The ${subject} was saved, but local history could not be refreshed. Reconcile this save without writing it again.`
    : `The ${subject} save could not be confirmed. Reconcile its exact record before retrying; it may already be saved.`;
}
