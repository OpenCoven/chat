import type {
  CaveManagedCredentialTransport,
  CaveManagedDiscoverySource,
  CavePairingRequest,
} from '@opencoven/cave-client/managed';
import type { OperationContext, PageOptions } from '@opencoven/sdk-core/browser';

import { nativeUnavailable, snapshotNativeDiagnostic, snapshotNativeResult } from './diagnostics';

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
  } catch (error) {
    throw snapshotNativeDiagnostic(error);
  }
  try {
    return snapshotNativeResult(result);
  } catch {
    throw Object.freeze({
      code: 'invalid_response',
      retryable: false,
      message: 'Cave response was invalid.',
    });
  }
}

function invalidNativeInput(): never {
  throw Object.freeze({
    code: 'invalid_response',
    retryable: false,
    message: 'Cave request was invalid.',
  });
}

function canonicalCursor(value: unknown): value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/u.test(value)) {
    return false;
  }
  const remainder = value.length % 4;
  if (remainder === 1) {
    return false;
  }
  if (remainder === 0) {
    return true;
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const trailing = alphabet.indexOf(value.at(-1) ?? '');
  return trailing >= 0 && trailing % (remainder === 2 ? 16 : 4) === 0;
}

function pageArgs(page: PageOptions): Record<string, unknown> {
  if (typeof page !== 'object' || page === null || Array.isArray(page)) {
    return invalidNativeInput();
  }
  let descriptors: PropertyDescriptorMap;
  try {
    if (Object.getPrototypeOf(page) !== Object.prototype) {
      return invalidNativeInput();
    }
    descriptors = Object.getOwnPropertyDescriptors(page);
  } catch {
    return invalidNativeInput();
  }
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some(
      (key) =>
        typeof key !== 'string' ||
        (key !== 'limit' && key !== 'cursor') ||
        descriptors[key] === undefined ||
        !Object.hasOwn(descriptors[key], 'value'),
    )
  ) {
    return invalidNativeInput();
  }
  const limit = descriptors.limit?.value;
  const cursor = descriptors.cursor?.value;
  if (
    typeof limit !== 'number' ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    (cursor !== undefined && !canonicalCursor(cursor))
  ) {
    return invalidNativeInput();
  }
  return {
    limit,
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function opaqueAuthorityHandle(value: unknown): NativeAuthorityHandle {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 256 ||
    !/^[A-Za-z0-9._~-]+$/u.test(value)
  ) {
    return invalidNativeInput();
  }
  return value;
}

function canonicalPairingRequestId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value)
  ) {
    return invalidNativeInput();
  }
  return value;
}

function canonicalConversationId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.trim().length === 0 ||
    value === '.' ||
    value === '..' ||
    value.length > 2_048 ||
    !/^[A-Za-z0-9._~-]+$/u.test(value)
  ) {
    return invalidNativeInput();
  }
  return value;
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) {
      return true;
    }
  }
  return false;
}

function canonicalPairingRequest(request: CavePairingRequest): CavePairingRequest {
  const snapshot = snapshotNativeResult(request);
  if (
    typeof snapshot !== 'object' ||
    snapshot === null ||
    Array.isArray(snapshot) ||
    Object.keys(snapshot).length !== 3
  ) {
    return invalidNativeInput();
  }
  const candidate = snapshot as Record<string, unknown>;
  if (
    !Object.hasOwn(candidate, 'appName') ||
    !Object.hasOwn(candidate, 'installationId') ||
    !Object.hasOwn(candidate, 'scopes') ||
    typeof candidate.appName !== 'string' ||
    candidate.appName.length < 1 ||
    candidate.appName.length > 128 ||
    candidate.appName !== candidate.appName.trim() ||
    containsControlCharacter(candidate.appName) ||
    typeof candidate.installationId !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(candidate.installationId) ||
    !Array.isArray(candidate.scopes) ||
    candidate.scopes.length !== 1 ||
    candidate.scopes[0] !== 'chat:read'
  ) {
    return invalidNativeInput();
  }
  return snapshot as CavePairingRequest;
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
        typeof candidate.handle !== 'string'
      ) {
        throw nativeUnavailable();
      }
      const managedSnapshot: NativeDiscoverySnapshot = {
        handle: opaqueAuthorityHandle(candidate.handle),
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
  const authorityHandle = opaqueAuthorityHandle(handle);
  const invokeBound = (command: string, args?: Record<string, unknown>) =>
    invokeNative(invoke, command, { ...args, handle: authorityHandle });

  return Object.freeze({
    health(_context?: OperationContext): ReturnType<CaveManagedCredentialTransport['health']> {
      return invokeBound('cave_health') as ReturnType<CaveManagedCredentialTransport['health']>;
    },
    async managedPairingCreate(
      request: CavePairingRequest,
      _context?: OperationContext,
    ): Promise<unknown> {
      return await invokeBound('cave_pairing_create', {
        request: canonicalPairingRequest(request),
      });
    },
    async managedPairingPoll(requestId: string, _context?: OperationContext): Promise<unknown> {
      return await invokeBound('cave_pairing_poll', {
        requestId: canonicalPairingRequestId(requestId),
      });
    },
    async managedPairingExchange(requestId: string, _context?: OperationContext): Promise<unknown> {
      return await invokeBound('cave_pairing_exchange', {
        requestId: canonicalPairingRequestId(requestId),
      });
    },
    managedCredentialStatus(_context?: OperationContext): Promise<unknown> {
      return invokeBound('cave_credential_status');
    },
    managedForgetCredential(_context?: OperationContext): Promise<unknown> {
      return invokeBound('cave_forget_credential');
    },
    async listFamiliars(page: PageOptions, _context?: OperationContext): Promise<unknown> {
      return await invokeBound('cave_list_familiars', { page: pageArgs(page) });
    },
    async listProjects(page: PageOptions, _context?: OperationContext): Promise<unknown> {
      return await invokeBound('cave_list_projects', { page: pageArgs(page) });
    },
    async listConversations(page: PageOptions, _context?: OperationContext): Promise<unknown> {
      return await invokeBound('cave_list_conversations', { page: pageArgs(page) });
    },
    async getConversation(conversationId: string, _context?: OperationContext): Promise<unknown> {
      return await invokeBound('cave_get_conversation', {
        conversationId: canonicalConversationId(conversationId),
      });
    },
    async listConversationMessages(
      conversationId: string,
      page: PageOptions,
      _context?: OperationContext,
    ): Promise<unknown> {
      return await invokeBound('cave_list_conversation_messages', {
        conversationId: canonicalConversationId(conversationId),
        page: pageArgs(page),
      });
    },
  });
}
