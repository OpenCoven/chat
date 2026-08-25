import type {
  CaveManagedCredentialTransport,
  CaveManagedDiscoverySource,
  CavePairingRequest,
} from '@opencoven/cave-client/managed';
import type { OperationContext, PageOptions } from '@opencoven/sdk-core/browser';

import { nativeUnavailable, snapshotNativeResult } from './diagnostics';

export type NativeSdkInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export async function invokeNative(
  invoke: NativeSdkInvoke,
  command: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  try {
    return snapshotNativeResult(
      await (args === undefined ? invoke(command) : invoke(command, args)),
    );
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      Object.hasOwn(error, 'code') &&
      Object.hasOwn(error, 'retryable')
    ) {
      throw error;
    }
    throw nativeUnavailable();
  }
}

function pageArgs(page: PageOptions): Record<string, unknown> {
  return {
    ...(page.limit === undefined ? {} : { limit: page.limit }),
    ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
  };
}

export function createCaveManagedDiscoverySource(
  invoke: NativeSdkInvoke,
): CaveManagedDiscoverySource {
  return Object.freeze({
    read(_context?: OperationContext): Promise<unknown> {
      return invokeNative(invoke, 'cave_read_discovery');
    },
  });
}

export function createCaveManagedCredentialTransport(
  invoke: NativeSdkInvoke,
): CaveManagedCredentialTransport {
  return Object.freeze({
    health(_context?: OperationContext): ReturnType<CaveManagedCredentialTransport['health']> {
      return invokeNative(invoke, 'cave_health') as ReturnType<
        CaveManagedCredentialTransport['health']
      >;
    },
    managedPairingCreate(
      request: CavePairingRequest,
      _context?: OperationContext,
    ): Promise<unknown> {
      return invokeNative(invoke, 'cave_pairing_create', { request });
    },
    managedPairingPoll(requestId: string, _context?: OperationContext): Promise<unknown> {
      return invokeNative(invoke, 'cave_pairing_poll', { requestId });
    },
    managedPairingExchange(requestId: string, _context?: OperationContext): Promise<unknown> {
      return invokeNative(invoke, 'cave_pairing_exchange', { requestId });
    },
    managedCredentialStatus(_context?: OperationContext): Promise<unknown> {
      return invokeNative(invoke, 'cave_credential_status');
    },
    managedForgetCredential(_context?: OperationContext): Promise<unknown> {
      return invokeNative(invoke, 'cave_forget_credential');
    },
    listFamiliars(page: PageOptions, _context?: OperationContext): Promise<unknown> {
      return invokeNative(invoke, 'cave_list_familiars', { page: pageArgs(page) });
    },
    listProjects(page: PageOptions, _context?: OperationContext): Promise<unknown> {
      return invokeNative(invoke, 'cave_list_projects', { page: pageArgs(page) });
    },
    listConversations(page: PageOptions, _context?: OperationContext): Promise<unknown> {
      return invokeNative(invoke, 'cave_list_conversations', { page: pageArgs(page) });
    },
    getConversation(conversationId: string, _context?: OperationContext): Promise<unknown> {
      return invokeNative(invoke, 'cave_get_conversation', { conversationId });
    },
    listConversationMessages(
      conversationId: string,
      page: PageOptions,
      _context?: OperationContext,
    ): Promise<unknown> {
      return invokeNative(invoke, 'cave_list_conversation_messages', {
        conversationId,
        page: pageArgs(page),
      });
    },
  });
}
