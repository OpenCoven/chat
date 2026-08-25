import type {
  CaveManagedCredentialTransport,
  CaveManagedDiscoverySource,
  CavePairingRequest,
} from '@opencoven/cave-client/managed';
import type { OperationContext, PageOptions } from '@opencoven/sdk-core/browser';

import { nativeUnavailable, snapshotNativeResult } from './diagnostics';

export type NativeSdkInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
export type NativeAuthorityHandle = string;

type NativeDiscoverySnapshot = Readonly<{
  handle: NativeAuthorityHandle;
  bytes: unknown;
  record: unknown;
}>;
export type CaveManagedDiscoveryBinding = Readonly<{
  source: CaveManagedDiscoverySource;
  takeHandle: () => NativeAuthorityHandle;
}>;

export async function invokeNative(
  invoke: NativeSdkInvoke,
  command: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  let result: unknown;
  try {
    result = await (args === undefined ? invoke(command) : invoke(command, args));
  } catch {
    throw nativeUnavailable();
  }
  return snapshotNativeResult(result);
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
  return createCaveManagedDiscoveryBinding(invoke).source;
}

export function createCaveManagedDiscoveryBinding(
  invoke: NativeSdkInvoke,
): CaveManagedDiscoveryBinding {
  let handle: NativeAuthorityHandle | undefined;
  const source: CaveManagedDiscoverySource = Object.freeze({
    async read(_context?: OperationContext): Promise<unknown> {
      const snapshot = await invokeNative(invoke, 'cave_read_discovery');

      if (typeof snapshot !== 'object' || snapshot === null || Array.isArray(snapshot)) {
        throw nativeUnavailable();
      }

      const candidate = snapshot as Record<string, unknown>;
      if (
        Object.keys(candidate).length !== 3 ||
        !Object.hasOwn(candidate, 'handle') ||
        !Object.hasOwn(candidate, 'bytes') ||
        !Object.hasOwn(candidate, 'record') ||
        typeof candidate.handle !== 'string' ||
        candidate.handle.length === 0 ||
        candidate.handle.length > 256
      ) {
        throw nativeUnavailable();
      }
      const managedSnapshot: NativeDiscoverySnapshot = {
        handle: candidate.handle as NativeAuthorityHandle,
        bytes: candidate.bytes,
        record: candidate.record,
      };
      handle = managedSnapshot.handle;
      return Object.freeze({
        bytes: managedSnapshot.bytes,
        record: managedSnapshot.record,
      });
    },
  });

  return Object.freeze({
    source,
    takeHandle: () => {
      const selected = handle;
      handle = undefined;
      if (selected === undefined) {
        throw nativeUnavailable();
      }
      return selected;
    },
  });
}

export function createCaveManagedCredentialTransport(
  invoke: NativeSdkInvoke,
  handle: NativeAuthorityHandle,
): CaveManagedCredentialTransport {
  const invokeBound = (command: string, args?: Record<string, unknown>) =>
    invokeNative(invoke, command, { handle, ...args });

  return Object.freeze({
    health(_context?: OperationContext): ReturnType<CaveManagedCredentialTransport['health']> {
      return invokeBound('cave_health') as ReturnType<CaveManagedCredentialTransport['health']>;
    },
    managedPairingCreate(
      request: CavePairingRequest,
      _context?: OperationContext,
    ): Promise<unknown> {
      return invokeBound('cave_pairing_create', { request });
    },
    managedPairingPoll(requestId: string, _context?: OperationContext): Promise<unknown> {
      return invokeBound('cave_pairing_poll', { requestId });
    },
    managedPairingExchange(requestId: string, _context?: OperationContext): Promise<unknown> {
      return invokeBound('cave_pairing_exchange', { requestId });
    },
    managedCredentialStatus(_context?: OperationContext): Promise<unknown> {
      return invokeBound('cave_credential_status');
    },
    managedForgetCredential(_context?: OperationContext): Promise<unknown> {
      return invokeBound('cave_forget_credential');
    },
    listFamiliars(page: PageOptions, _context?: OperationContext): Promise<unknown> {
      return invokeBound('cave_list_familiars', { page: pageArgs(page) });
    },
    listProjects(page: PageOptions, _context?: OperationContext): Promise<unknown> {
      return invokeBound('cave_list_projects', { page: pageArgs(page) });
    },
    listConversations(page: PageOptions, _context?: OperationContext): Promise<unknown> {
      return invokeBound('cave_list_conversations', { page: pageArgs(page) });
    },
    getConversation(conversationId: string, _context?: OperationContext): Promise<unknown> {
      return invokeBound('cave_get_conversation', { conversationId });
    },
    listConversationMessages(
      conversationId: string,
      page: PageOptions,
      _context?: OperationContext,
    ): Promise<unknown> {
      return invokeBound('cave_list_conversation_messages', {
        conversationId,
        page: pageArgs(page),
      });
    },
  });
}
