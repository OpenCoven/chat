import type {
  CaveManagedCredentialTransport,
  CaveManagedDiscoverySource,
  CavePairingRequest,
} from '@opencoven/cave-client/managed';
import type { OperationContext, PageOptions } from '@opencoven/sdk-core/browser';

import { nativeUnavailable, snapshotNativeDiagnostic, snapshotNativeResult } from './diagnostics';

export type NativeSdkInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
export type NativeAuthorityHandle = string;
type NativeCancellationReason = 'aborted' | 'timeout';

type NativeDiscoverySnapshot = Readonly<{
  handle: NativeAuthorityHandle;
  bytes: unknown;
  record: unknown;
}>;
export type CaveManagedDiscoveryBinding = Readonly<{
  source: CaveManagedDiscoverySource;
  takeHandle: () => NativeAuthorityHandle;
}>;

const NATIVE_OPERATION_TIMEOUT_MS = 5_000;
const NATIVE_CANCEL_COMMAND = 'cave_cancel_operation';
const ATTEMPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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

function cancellationDiagnostic(reason: NativeCancellationReason): never {
  throw Object.freeze({
    code: reason,
    retryable: reason === 'timeout',
    message: reason === 'timeout' ? 'Cave request timed out.' : 'Cave request was aborted.',
  });
}

function safeSignalReason(signal: AbortSignal): unknown {
  try {
    return Reflect.get(signal, 'reason');
  } catch {
    return undefined;
  }
}

function cancellationReason(signal: AbortSignal): NativeCancellationReason {
  const reason = safeSignalReason(signal);
  if (typeof reason === 'object' && reason !== null) {
    try {
      if (Reflect.get(reason, 'code') === 'timeout') {
        return 'timeout';
      }
    } catch {
      return 'aborted';
    }
  }
  return 'aborted';
}

function validateOperationContext(context: OperationContext | undefined): {
  deadline: number | undefined;
  signal: AbortSignal | undefined;
} {
  if (context === undefined) {
    return { deadline: undefined, signal: undefined };
  }
  let signal: unknown;
  let deadline: unknown;
  try {
    if (
      typeof context !== 'object' ||
      context === null ||
      Array.isArray(context) ||
      (Object.getPrototypeOf(context) !== Object.prototype &&
        Object.getPrototypeOf(context) !== null)
    ) {
      return invalidNativeInput();
    }
    const descriptors = Object.getOwnPropertyDescriptors(context);
    if (
      Reflect.ownKeys(descriptors).length !== 2 ||
      descriptors.signal === undefined ||
      descriptors.deadline === undefined ||
      !Object.hasOwn(descriptors.signal, 'value') ||
      !Object.hasOwn(descriptors.deadline, 'value')
    ) {
      return invalidNativeInput();
    }
    signal = descriptors.signal.value;
    deadline = descriptors.deadline.value;
  } catch {
    return invalidNativeInput();
  }
  if (
    !(signal instanceof AbortSignal) ||
    (deadline !== undefined &&
      (typeof deadline !== 'number' || !Number.isFinite(deadline) || deadline < 0))
  ) {
    return invalidNativeInput();
  }
  return { deadline: deadline as number | undefined, signal };
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function createAttemptId(): string {
  let attemptId: unknown;
  try {
    attemptId = globalThis.crypto.randomUUID();
  } catch {
    return invalidNativeInput();
  }
  if (typeof attemptId !== 'string' || !ATTEMPT_ID_PATTERN.test(attemptId)) {
    return invalidNativeInput();
  }
  return attemptId;
}

function requestNativeCancellation(
  invoke: NativeSdkInvoke,
  attemptId: string,
  reason: NativeCancellationReason,
): void {
  void invokeNative(invoke, NATIVE_CANCEL_COMMAND, { attemptId, reason }).catch(() => {
    // The local SDK cancellation remains authoritative and secret-free.
  });
}

async function invokeNativeOperation(
  invoke: NativeSdkInvoke,
  command: string,
  args: Record<string, unknown> | undefined,
  context: OperationContext | undefined,
): Promise<unknown> {
  const attemptId = createAttemptId();
  const { deadline, signal } = validateOperationContext(context);
  if (signalIsAborted(signal)) {
    const reason = signal === undefined ? 'aborted' : cancellationReason(signal);
    requestNativeCancellation(invoke, attemptId, reason);
    return cancellationDiagnostic(reason);
  }
  const remaining =
    deadline === undefined ? NATIVE_OPERATION_TIMEOUT_MS : Math.floor(deadline - performance.now());
  if (remaining <= 0) {
    requestNativeCancellation(invoke, attemptId, 'timeout');
    return cancellationDiagnostic('timeout');
  }
  const timeoutMs = Math.min(remaining, NATIVE_OPERATION_TIMEOUT_MS);
  let rejectCancellation: ((error: unknown) => void) | undefined;
  const cancellation = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  let cancellationRequested = false;
  const onAbort = (): void => {
    if (cancellationRequested) {
      return;
    }
    cancellationRequested = true;
    const reason = signal === undefined ? 'aborted' : cancellationReason(signal);
    requestNativeCancellation(invoke, attemptId, reason);
    try {
      cancellationDiagnostic(reason);
    } catch (error) {
      rejectCancellation?.(error);
    }
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signalIsAborted(signal)) {
    onAbort();
  }

  try {
    if (signalIsAborted(signal)) {
      return await cancellation;
    }
    return await Promise.race([
      invokeNative(invoke, command, {
        ...args,
        operation: {
          attemptId,
          timeoutMs,
        },
      }),
      cancellation,
    ]);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
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
    async read(context?: OperationContext): Promise<unknown> {
      const snapshot = await invokeNativeOperation(
        invoke,
        'cave_read_discovery',
        undefined,
        context,
      );

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
  const invokeBoundOperation = (
    command: string,
    args: Record<string, unknown> | undefined,
    context: OperationContext | undefined,
  ) => invokeNativeOperation(invoke, command, { ...args, handle: authorityHandle }, context);

  return Object.freeze({
    health(context?: OperationContext): ReturnType<CaveManagedCredentialTransport['health']> {
      return invokeBoundOperation('cave_health', undefined, context) as ReturnType<
        CaveManagedCredentialTransport['health']
      >;
    },
    async managedPairingCreate(
      request: CavePairingRequest,
      context?: OperationContext,
    ): Promise<unknown> {
      return await invokeBoundOperation(
        'cave_pairing_create',
        {
          request: canonicalPairingRequest(request),
        },
        context,
      );
    },
    async managedPairingPoll(requestId: string, context?: OperationContext): Promise<unknown> {
      return await invokeBoundOperation(
        'cave_pairing_poll',
        {
          requestId: canonicalPairingRequestId(requestId),
        },
        context,
      );
    },
    async managedPairingExchange(requestId: string, context?: OperationContext): Promise<unknown> {
      return await invokeBoundOperation(
        'cave_pairing_exchange',
        {
          requestId: canonicalPairingRequestId(requestId),
        },
        context,
      );
    },
    managedCredentialStatus(context?: OperationContext): Promise<unknown> {
      return invokeBoundOperation('cave_credential_status', undefined, context);
    },
    managedForgetCredential(context?: OperationContext): Promise<unknown> {
      return invokeBoundOperation('cave_forget_credential', undefined, context);
    },
    async listFamiliars(page: PageOptions, context?: OperationContext): Promise<unknown> {
      return await invokeBoundOperation('cave_list_familiars', { page: pageArgs(page) }, context);
    },
    async listProjects(page: PageOptions, context?: OperationContext): Promise<unknown> {
      return await invokeBoundOperation('cave_list_projects', { page: pageArgs(page) }, context);
    },
    async listConversations(page: PageOptions, context?: OperationContext): Promise<unknown> {
      return await invokeBoundOperation(
        'cave_list_conversations',
        { page: pageArgs(page) },
        context,
      );
    },
    async getConversation(conversationId: string, context?: OperationContext): Promise<unknown> {
      return await invokeBoundOperation(
        'cave_get_conversation',
        {
          conversationId: canonicalConversationId(conversationId),
        },
        context,
      );
    },
    async listConversationMessages(
      conversationId: string,
      page: PageOptions,
      context?: OperationContext,
    ): Promise<unknown> {
      return await invokeBoundOperation(
        'cave_list_conversation_messages',
        {
          conversationId: canonicalConversationId(conversationId),
          page: pageArgs(page),
        },
        context,
      );
    },
  });
}
