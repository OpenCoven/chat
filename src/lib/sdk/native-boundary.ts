import {
  type CaveCanonicalFamiliar,
  type CaveClient,
  type CaveConversation,
  type CaveConversationMessage,
  type CaveCredentialMetadata,
  type CaveHealth,
  type CaveManagedCredentialTransport,
  type CavePairingRequest,
  type CavePairingSession,
  type CavePairingStatus,
  type CaveProject,
  createManagedCaveClient,
  discoverManagedCaveEndpoint,
  isCaveClientError,
} from '@opencoven/cave-client/managed';
import caveClientPackage from '@opencoven/cave-client/package.json';
import { assessCompatibility, type Page, type PageOptions } from '@opencoven/sdk-core/browser';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const AUTHORITY_HANDLE_PATTERN =
  /^authority:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DISCOVERY_HANDLE_PATTERN =
  /^discovery:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const API_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const DECLARATION_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;

export const NATIVE_COMMANDS = Object.freeze({
  discoveryRead: 'sdk_discovery_read',
  authorityEstablish: 'sdk_authority_establish',
  close: 'sdk_authority_close',
  installationIdentity: 'sdk_installation_identity',
  health: 'cave_health',
  pairingCreate: 'cave_managed_pairing_create',
  pairingPoll: 'cave_managed_pairing_poll',
  pairingExchange: 'cave_managed_pairing_exchange',
  credentialState: 'cave_credential_state',
  forgetCredential: 'cave_forget_credential',
  listFamiliars: 'cave_list_familiars',
  listProjects: 'cave_list_projects',
  listConversations: 'cave_list_conversations',
  getConversation: 'cave_get_conversation',
  listConversationMessages: 'cave_list_conversation_messages',
  diagnostics: 'sdk_native_diagnostics',
});

export const CONNECTION_EVENT = 'sdk://connection';

export type {
  CaveCanonicalFamiliar,
  CaveConversation,
  CaveConversationMessage,
  CaveCredentialMetadata as CredentialMetadata,
  CaveHealth,
  CaveProject,
  Page,
  PageOptions,
};

export type InvokeCommand = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
export type NativeEvent = Readonly<{ payload: unknown }>;
export type ListenCommand = (
  event: string,
  handler: (event: NativeEvent) => void,
) => Promise<() => void>;

export type AuthorityReference = Readonly<{
  handle: string;
  generation: number;
}>;

export type CredentialState = 'missing' | 'present' | 'update_in_progress' | 'invalid';

export type NativeDiagnosticCode =
  | 'aborted'
  | 'body_limit'
  | 'conflict'
  | 'credential_update_in_progress'
  | 'incompatible_version'
  | 'internal_error'
  | 'invalid_options'
  | 'invalid_request'
  | 'invalid_response'
  | 'not_found'
  | 'operation_in_progress'
  | 'owner_mismatch'
  | 'pairing_denied'
  | 'pairing_expired'
  | 'pairing_pending'
  | 'platform_security_unavailable'
  | 'rate_limited'
  | 'reconcile_required'
  | 'scope_denied'
  | 'secret_store_delete_failed'
  | 'secret_store_read_failed'
  | 'secret_store_rollback_failed'
  | 'secret_store_write_failed'
  | 'secure_store_unavailable'
  | 'service_unavailable'
  | 'stale_record'
  | 'timeout'
  | 'unauthorized'
  | 'unsafe_endpoint'
  | 'unsupported_operation';

const ERROR_CODES = new Set<NativeDiagnosticCode>([
  'aborted',
  'body_limit',
  'conflict',
  'credential_update_in_progress',
  'incompatible_version',
  'internal_error',
  'invalid_options',
  'invalid_request',
  'invalid_response',
  'not_found',
  'operation_in_progress',
  'owner_mismatch',
  'pairing_denied',
  'pairing_expired',
  'pairing_pending',
  'platform_security_unavailable',
  'rate_limited',
  'reconcile_required',
  'scope_denied',
  'secret_store_delete_failed',
  'secret_store_read_failed',
  'secret_store_rollback_failed',
  'secret_store_write_failed',
  'secure_store_unavailable',
  'service_unavailable',
  'stale_record',
  'timeout',
  'unauthorized',
  'unsafe_endpoint',
  'unsupported_operation',
]);

const CAVE_PROTOCOL_ERROR_CODES = new Set<NativeDiagnosticCode>([
  'invalid_request',
  'unauthorized',
  'scope_denied',
  'not_found',
  'conflict',
  'rate_limited',
  'pairing_pending',
  'pairing_denied',
  'pairing_expired',
  'incompatible_version',
  'service_unavailable',
  'reconcile_required',
  'internal_error',
]);

type CanonicalResponseRequirements = Readonly<{
  capabilities: readonly string[];
  operation: string;
}>;

const CANONICAL_RESPONSE_REQUIREMENTS = Object.freeze({
  listFamiliars: {
    capabilities: ['familiars', 'cursors'],
    operation: 'familiars.list',
  },
  listProjects: {
    capabilities: ['projects', 'cursors'],
    operation: 'projects.list',
  },
  listConversations: {
    capabilities: ['conversations', 'cursors'],
    operation: 'conversations.list',
  },
  getConversation: {
    capabilities: ['conversations'],
    operation: 'conversations.read',
  },
  listConversationMessages: {
    capabilities: ['conversation-messages', 'cursors'],
    operation: 'messages.list',
  },
} satisfies Readonly<Record<string, CanonicalResponseRequirements>>);

export class NativeBoundaryError extends Error {
  readonly code: NativeDiagnosticCode;
  readonly retryable: boolean;
  readonly diagnosticId: string;
  readonly statusCode: number | undefined;

  constructor(
    code: NativeDiagnosticCode,
    retryable: boolean,
    diagnosticId: string,
    statusCode?: number,
  ) {
    super('The native OpenCoven operation failed.');
    this.name = 'NativeBoundaryError';
    this.code = code;
    this.retryable = retryable;
    this.diagnosticId = diagnosticId;
    this.statusCode = statusCode;
  }
}

export type NativeConnectionEvent = Readonly<{
  version: 1;
  authority: AuthorityReference;
  kind: 'credential_revoked' | 'transport_offline' | 'authority_replaced';
  diagnosticId: string;
}>;

export type NativeDiagnostics = Readonly<{
  version: 1;
  platform: 'darwin' | 'linux' | 'win32' | 'unsupported';
  architecture: string;
  checks: readonly Readonly<{
    component:
      | 'cave_credential_custody'
      | 'cave_protected_authority'
      | 'coven_unix_peer_identity'
      | 'coven_windows_pipe_identity';
    status: 'available' | 'unavailable';
    code?: NativeDiagnosticCode;
  }>[];
}>;

export interface NativeBoundary {
  isAvailable(): boolean;
  discover(): Promise<AuthorityReference>;
  close(authority: AuthorityReference): Promise<boolean>;
  installationIdentity(): Promise<Readonly<{ installationId: string }>>;
  health(authority: AuthorityReference, requestId: string): Promise<CaveHealth>;
  pairingCreate(
    authority: AuthorityReference,
    requestId: string,
    request: CavePairingRequest,
  ): Promise<Readonly<{ handle: string; requestId: string; expiresAt: number }>>;
  pairingPoll(
    authority: AuthorityReference,
    requestId: string,
    pairingHandle: string,
  ): Promise<CavePairingStatus>;
  pairingExchange(
    authority: AuthorityReference,
    requestId: string,
    pairingHandle: string,
  ): Promise<Readonly<{ credential: CaveCredentialMetadata }>>;
  credentialState(authority: AuthorityReference, requestId: string): Promise<CredentialState>;
  forgetCredential(authority: AuthorityReference, requestId: string): Promise<boolean>;
  listFamiliars(
    authority: AuthorityReference,
    requestId: string,
    options: PageOptions,
  ): Promise<Page<CaveCanonicalFamiliar>>;
  listProjects(
    authority: AuthorityReference,
    requestId: string,
    options: PageOptions,
  ): Promise<Page<CaveProject>>;
  listConversations(
    authority: AuthorityReference,
    requestId: string,
    options: PageOptions,
  ): Promise<Page<CaveConversation>>;
  getConversation(
    authority: AuthorityReference,
    requestId: string,
    conversationId: string,
  ): Promise<CaveConversation>;
  listConversationMessages(
    authority: AuthorityReference,
    requestId: string,
    conversationId: string,
    options: PageOptions,
  ): Promise<Page<CaveConversationMessage>>;
  diagnostics(): Promise<NativeDiagnostics>;
  listenConnectionEvents(listener: (event: NativeConnectionEvent) => void): Promise<() => void>;
}

type ExactRecord = Readonly<Record<string, unknown>>;
type ActiveClient = Readonly<{
  authority: AuthorityReference;
  client: CaveClient;
}>;
type RetainedPairingSession = Readonly<{
  sequence: number;
  session: CavePairingSession;
}>;

const MAX_RETAINED_PAIRING_SESSIONS = 64;

function invalidResponse(): NativeBoundaryError {
  return new NativeBoundaryError('invalid_response', false, 'local-diagnostic');
}

function exactRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): ExactRecord {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    ) {
      throw invalidResponse();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    const allowed = new Set([...required, ...optional]);
    if (
      keys.some(
        (key) =>
          typeof key !== 'string' ||
          !allowed.has(key) ||
          descriptors[key] === undefined ||
          !Object.hasOwn(descriptors[key], 'value') ||
          descriptors[key].enumerable !== true,
      ) ||
      required.some((key) => !Object.hasOwn(descriptors, key))
    ) {
      throw invalidResponse();
    }
    return Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
    );
  } catch (error) {
    if (error instanceof NativeBoundaryError) {
      throw error;
    }
    throw invalidResponse();
  }
}

function dataRecord(value: unknown): ExactRecord {
  try {
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    ) {
      throw invalidResponse();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(value);
    if (
      keys.some(
        (key) =>
          typeof key !== 'string' ||
          descriptors[key] === undefined ||
          !Object.hasOwn(descriptors[key], 'value') ||
          descriptors[key].enumerable !== true,
      )
    ) {
      throw invalidResponse();
    }
    return Object.fromEntries(
      Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
    );
  } catch (error) {
    if (error instanceof NativeBoundaryError) {
      throw error;
    }
    throw invalidResponse();
  }
}

function dataArray(value: unknown): readonly unknown[] | undefined {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
      return undefined;
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (lengthDescriptor === undefined || !Object.hasOwn(lengthDescriptor, 'value')) {
      return undefined;
    }
    const length = lengthDescriptor.value;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) {
      return undefined;
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== length + 1 ||
      keys.some(
        (key) =>
          key !== 'length' &&
          (typeof key !== 'string' ||
            !/^(?:0|[1-9]\d*)$/u.test(key) ||
            Number(key) >= length ||
            descriptors[key] === undefined ||
            !Object.hasOwn(descriptors[key], 'value')),
      )
    ) {
      return undefined;
    }
    const values: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        return undefined;
      }
      values.push(descriptor.value);
    }
    return values;
  } catch {
    return undefined;
  }
}

function requiredString(value: unknown, pattern?: RegExp, maximum = 4_096): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes('\0') ||
    (pattern !== undefined && !pattern.test(value))
  ) {
    throw invalidResponse();
  }
  return value;
}

function safeInteger(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw invalidResponse();
  }
  return value as number;
}

function authorityReference(value: unknown): AuthorityReference {
  const record = exactRecord(value, ['handle', 'generation']);
  return {
    handle: requiredString(record.handle, AUTHORITY_HANDLE_PATTERN, 128),
    generation: safeInteger(record.generation, 1),
  };
}

function sameAuthority(left: AuthorityReference, right: AuthorityReference): boolean {
  return left.handle === right.handle && left.generation === right.generation;
}

function requestId(value: unknown): string {
  return requiredString(value, REQUEST_ID_PATTERN, 128);
}

function nativeError(value: unknown): NativeBoundaryError | undefined {
  try {
    const error = exactRecord(value, ['code', 'retryable', 'diagnosticId']);
    if (
      typeof error.code !== 'string' ||
      !ERROR_CODES.has(error.code as NativeDiagnosticCode) ||
      typeof error.retryable !== 'boolean'
    ) {
      return undefined;
    }
    return new NativeBoundaryError(
      error.code as NativeDiagnosticCode,
      error.retryable,
      requiredString(error.diagnosticId, UUID_PATTERN, 36),
    );
  } catch {
    return undefined;
  }
}

function statusCode(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 100 && value <= 599
    ? value
    : undefined;
}

function sdkError(value: unknown): NativeBoundaryError {
  if (isCaveClientError(value) && ERROR_CODES.has(value.code as NativeDiagnosticCode)) {
    return new NativeBoundaryError(
      value.code as NativeDiagnosticCode,
      value.retryable,
      value.requestId ?? 'sdk-diagnostic',
      statusCode(value.statusCode),
    );
  }
  try {
    const descriptors =
      typeof value === 'object' && value !== null
        ? Object.getOwnPropertyDescriptors(value)
        : undefined;
    const code = descriptors?.code?.value;
    const retryable = descriptors?.retryable?.value;
    const responseStatus = statusCode(descriptors?.statusCode?.value);
    if (
      typeof code === 'string' &&
      ERROR_CODES.has(code as NativeDiagnosticCode) &&
      typeof retryable === 'boolean'
    ) {
      return new NativeBoundaryError(
        code as NativeDiagnosticCode,
        retryable,
        'sdk-diagnostic',
        responseStatus,
      );
    }
  } catch {
    // Fall through to a fixed local error.
  }
  return invalidResponse();
}

function operationResult(
  value: unknown,
  authority: AuthorityReference,
  expectedRequestId: string,
): unknown {
  const operation = exactRecord(value, ['authority', 'requestId', 'result']);
  if (
    !sameAuthority(authorityReference(operation.authority), authority) ||
    requestId(operation.requestId) !== expectedRequestId
  ) {
    throw new NativeBoundaryError('reconcile_required', false, 'native-generation-changed');
  }
  return operation.result;
}

function nativeResponse(
  value: unknown,
  successStatus: number,
  requirements?: CanonicalResponseRequirements,
): Readonly<{ statusCode: number; payload: unknown }> {
  const response = exactRecord(value, ['statusCode', 'payload']);
  const responseStatus = safeInteger(response.statusCode, 100);
  if (
    responseStatus > 599 ||
    (responseStatus !== successStatus && (responseStatus < 400 || responseStatus > 599))
  ) {
    throw invalidResponse();
  }
  if (responseStatus !== successStatus) {
    throw canonicalStatusError(response.payload, responseStatus, requirements);
  }
  return { statusCode: responseStatus, payload: response.payload };
}

function declarationIds(value: unknown): readonly string[] | undefined {
  const values = dataArray(value);
  if (values === undefined || values.length === 0) {
    return undefined;
  }
  const declarations: string[] = [];
  for (const entry of values) {
    if (
      typeof entry !== 'string' ||
      entry.length > 64 ||
      !DECLARATION_ID_PATTERN.test(entry) ||
      declarations.includes(entry)
    ) {
      return undefined;
    }
    declarations.push(entry);
  }
  return declarations;
}

function protocolStatusFailure(
  code: NativeDiagnosticCode,
  retryable: boolean,
  responseStatus: number,
  protocolRequestId?: string,
): Readonly<{
  code: NativeDiagnosticCode;
  retryable: boolean;
  statusCode: number;
  requestId?: string;
}> {
  return Object.freeze({
    code,
    retryable,
    statusCode: responseStatus,
    ...(protocolRequestId === undefined ? {} : { requestId: protocolRequestId }),
  });
}

function canonicalStatusError(
  payload: unknown,
  responseStatus: number,
  requirements?: CanonicalResponseRequirements,
): Readonly<{
  code: NativeDiagnosticCode;
  retryable: boolean;
  statusCode: number;
  requestId?: string;
}> {
  try {
    const envelope = dataRecord(payload);
    const protocolRequestId =
      typeof envelope.requestId === 'string' &&
      envelope.requestId.length <= 64 &&
      REQUEST_ID_PATTERN.test(envelope.requestId)
        ? envelope.requestId
        : undefined;
    if (
      (envelope.requestId !== undefined &&
        (typeof envelope.requestId !== 'string' ||
          envelope.requestId.length === 0 ||
          envelope.requestId.length > 64)) ||
      typeof envelope.apiVersion !== 'string' ||
      !API_VERSION_PATTERN.test(envelope.apiVersion) ||
      typeof envelope.minimumClientVersion !== 'string' ||
      !SEMVER_PATTERN.test(envelope.minimumClientVersion)
    ) {
      return protocolStatusFailure('invalid_response', false, responseStatus, protocolRequestId);
    }
    if (requirements === undefined) {
      if (envelope.apiVersion.split('.')[0] !== '1') {
        return protocolStatusFailure(
          'incompatible_version',
          false,
          responseStatus,
          protocolRequestId,
        );
      }
    } else if (envelope.apiVersion !== '1.0') {
      return protocolStatusFailure('invalid_response', false, responseStatus, protocolRequestId);
    }
    let compatible: boolean;
    try {
      compatible = assessCompatibility(
        envelope.minimumClientVersion,
        caveClientPackage.version,
      ).compatible;
    } catch {
      return protocolStatusFailure('invalid_response', false, responseStatus, protocolRequestId);
    }
    if (!compatible) {
      return protocolStatusFailure(
        'incompatible_version',
        false,
        responseStatus,
        protocolRequestId,
      );
    }
    const capabilities = declarationIds(envelope.capabilities);
    const operations = declarationIds(envelope.operations);
    if (
      capabilities === undefined ||
      operations === undefined ||
      (requirements !== undefined &&
        (!operations.includes(requirements.operation) ||
          requirements.capabilities.some((capability) => !capabilities.includes(capability)))) ||
      (envelope.data !== undefined && envelope.error !== undefined)
    ) {
      return protocolStatusFailure('invalid_response', false, responseStatus, protocolRequestId);
    }
    const error = dataRecord(envelope.error);
    if (
      typeof error.code !== 'string' ||
      !CAVE_PROTOCOL_ERROR_CODES.has(error.code as NativeDiagnosticCode) ||
      typeof error.message !== 'string' ||
      error.message.length === 0 ||
      error.message.length > 256 ||
      typeof error.retryable !== 'boolean'
    ) {
      return protocolStatusFailure('invalid_response', false, responseStatus, protocolRequestId);
    }
    if (error.details !== undefined) {
      const details = dataRecord(error.details);
      const entries = Object.entries(details);
      if (
        entries.length > 16 ||
        entries.some(([, entry]) => typeof entry !== 'string' || entry.length > 256)
      ) {
        return protocolStatusFailure('invalid_response', false, responseStatus, protocolRequestId);
      }
    }
    return protocolStatusFailure(
      error.code as NativeDiagnosticCode,
      error.retryable,
      responseStatus,
      protocolRequestId,
    );
  } catch {
    return protocolStatusFailure('invalid_response', false, responseStatus);
  }
}

function credentialState(value: unknown): CredentialState {
  const state = exactRecord(value, ['status']);
  if (
    state.status !== 'missing' &&
    state.status !== 'present' &&
    state.status !== 'update_in_progress' &&
    state.status !== 'invalid'
  ) {
    throw invalidResponse();
  }
  return state.status;
}

function platformAvailable(): boolean {
  const scope = globalThis as typeof globalThis & {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };
  return scope.__TAURI__ !== undefined || scope.__TAURI_INTERNALS__ !== undefined;
}

export function createNativeBoundary(
  dependencies: {
    invoke?: InvokeCommand;
    listen?: ListenCommand;
    available?: () => boolean;
    requestId?: () => string;
  } = {},
): NativeBoundary {
  const invokeCommand = dependencies.invoke ?? (invoke as InvokeCommand);
  const listenCommand = dependencies.listen ?? (listen as ListenCommand);
  const available = dependencies.available ?? platformAvailable;
  const nextRequestId = dependencies.requestId ?? (() => `native:${crypto.randomUUID()}`);
  const pairingSessions = new Map<string, RetainedPairingSession>();
  let nextPairingSequence = 0;
  let active: ActiveClient | null = null;

  function prunePairingSessions(now = Date.now()): void {
    for (const [handle, retained] of pairingSessions) {
      if (retained.session.expiresAt <= now) {
        pairingSessions.delete(handle);
      }
    }
    while (pairingSessions.size > MAX_RETAINED_PAIRING_SESSIONS) {
      let oldest: Readonly<{ handle: string; sequence: number }> | undefined;
      for (const [handle, retained] of pairingSessions) {
        if (oldest === undefined || retained.sequence < oldest.sequence) {
          oldest = { handle, sequence: retained.sequence };
        }
      }
      if (oldest === undefined) {
        break;
      }
      pairingSessions.delete(oldest.handle);
    }
  }

  function retainedPairing(pairingHandle: string): RetainedPairingSession | undefined {
    prunePairingSessions();
    return pairingSessions.get(pairingHandle);
  }

  function terminalPairingError(error: NativeBoundaryError): boolean {
    return (
      error.code === 'pairing_denied' ||
      error.code === 'pairing_expired' ||
      error.code === 'conflict' ||
      error.code === 'reconcile_required'
    );
  }

  async function call(command: string, args?: Record<string, unknown>): Promise<unknown> {
    try {
      return await invokeCommand(command, args);
    } catch (error) {
      throw nativeError(error) ?? invalidResponse();
    }
  }

  async function callOperation(
    command: string,
    authority: AuthorityReference,
    input: Record<string, unknown> = {},
  ): Promise<unknown> {
    const nativeRequestId = nextRequestId();
    return operationResult(
      await call(command, {
        input: { authority, requestId: nativeRequestId, ...input },
      }),
      authority,
      nativeRequestId,
    );
  }

  function requireClient(authority: AuthorityReference): CaveClient {
    if (active === null || !sameAuthority(active.authority, authority)) {
      throw new NativeBoundaryError('reconcile_required', false, 'native-generation-changed');
    }
    return active.client;
  }

  function createTransport(authority: AuthorityReference): CaveManagedCredentialTransport {
    const rawHealth = async () =>
      nativeResponse(await callOperation(NATIVE_COMMANDS.health, authority), 200)
        .payload as Awaited<ReturnType<CaveManagedCredentialTransport['health']>>;

    return {
      health: rawHealth,
      async managedPairingCreate(request) {
        return await callOperation(NATIVE_COMMANDS.pairingCreate, authority, { request });
      },
      async managedPairingPoll(pairingRequestId) {
        return await callOperation(NATIVE_COMMANDS.pairingPoll, authority, {
          pairingRequestId,
        });
      },
      async managedPairingExchange(pairingRequestId) {
        return await callOperation(NATIVE_COMMANDS.pairingExchange, authority, {
          pairingRequestId,
        });
      },
      async managedCredentialStatus() {
        const state = credentialState(
          await callOperation(NATIVE_COMMANDS.credentialState, authority),
        );
        if (state === 'missing') {
          return { status: 'missing' };
        }
        if (state === 'update_in_progress') {
          return {
            status: 'disconnected',
            reason: 'credential_update_in_progress',
          };
        }
        if (state === 'invalid') {
          return { status: 'disconnected', reason: 'reconcile_required' };
        }
        const health = await rawHealth();
        return {
          status: 'valid',
          access: 'chat:read',
          health,
        };
      },
      async managedForgetCredential() {
        const deleted = await callOperation(NATIVE_COMMANDS.forgetCredential, authority);
        if (typeof deleted !== 'boolean') {
          throw invalidResponse();
        }
        return { status: deleted ? 'deleted' : 'missing' };
      },
      async listFamiliars(options) {
        return nativeResponse(
          await callOperation(NATIVE_COMMANDS.listFamiliars, authority, { options }),
          200,
          CANONICAL_RESPONSE_REQUIREMENTS.listFamiliars,
        ).payload;
      },
      async listProjects(options) {
        return nativeResponse(
          await callOperation(NATIVE_COMMANDS.listProjects, authority, { options }),
          200,
          CANONICAL_RESPONSE_REQUIREMENTS.listProjects,
        ).payload;
      },
      async listConversations(options) {
        return nativeResponse(
          await callOperation(NATIVE_COMMANDS.listConversations, authority, { options }),
          200,
          CANONICAL_RESPONSE_REQUIREMENTS.listConversations,
        ).payload;
      },
      async getConversation(conversationId) {
        return nativeResponse(
          await callOperation(NATIVE_COMMANDS.getConversation, authority, { conversationId }),
          200,
          CANONICAL_RESPONSE_REQUIREMENTS.getConversation,
        ).payload;
      },
      async listConversationMessages(conversationId, options) {
        return nativeResponse(
          await callOperation(NATIVE_COMMANDS.listConversationMessages, authority, {
            conversationId,
            options,
          }),
          200,
          CANONICAL_RESPONSE_REQUIREMENTS.listConversationMessages,
        ).payload;
      },
    };
  }

  const boundary: NativeBoundary = {
    isAvailable: available,
    async discover() {
      try {
        const output = exactRecord(await call(NATIVE_COMMANDS.discoveryRead), [
          'handle',
          'snapshot',
        ]);
        const discoveryHandle = requiredString(output.handle, DISCOVERY_HANDLE_PATTERN, 128);
        await discoverManagedCaveEndpoint({
          read: async () => output.snapshot,
        });
        const authority = authorityReference(
          await call(NATIVE_COMMANDS.authorityEstablish, {
            input: { discoveryHandle },
          }),
        );
        pairingSessions.clear();
        active = {
          authority,
          client: createManagedCaveClient({
            transport: createTransport(authority),
          }),
        };
        return authority;
      } catch (error) {
        throw error instanceof NativeBoundaryError ? error : sdkError(error);
      }
    },
    async close(authority) {
      const result = exactRecord(await call(NATIVE_COMMANDS.close, { input: { authority } }), [
        'closed',
      ]);
      if (typeof result.closed !== 'boolean') {
        throw invalidResponse();
      }
      if (active !== null && sameAuthority(active.authority, authority)) {
        active = null;
        pairingSessions.clear();
      }
      return result.closed;
    },
    async installationIdentity() {
      const result = exactRecord(await call(NATIVE_COMMANDS.installationIdentity), [
        'installationId',
      ]);
      return {
        installationId: requiredString(result.installationId, UUID_PATTERN, 36),
      };
    },
    async health(authority) {
      try {
        return await requireClient(authority).health();
      } catch (error) {
        throw sdkError(error);
      }
    },
    async pairingCreate(authority, _requestId, request) {
      try {
        const session = await requireClient(authority).createPairing(request);
        const handle = `session:${crypto.randomUUID()}`;
        nextPairingSequence += 1;
        pairingSessions.set(handle, {
          sequence: nextPairingSequence,
          session,
        });
        prunePairingSessions();
        return {
          handle,
          requestId: session.requestId,
          expiresAt: session.expiresAt,
        };
      } catch (error) {
        throw sdkError(error);
      }
    },
    async pairingPoll(authority, _requestId, pairingHandle) {
      const retained = retainedPairing(pairingHandle);
      if (
        retained === undefined ||
        active === null ||
        !sameAuthority(active.authority, authority)
      ) {
        throw new NativeBoundaryError('reconcile_required', false, 'pairing-session-missing');
      }
      try {
        const status = await retained.session.poll();
        if (
          (status.status === 'denied' || status.status === 'expired') &&
          pairingSessions.get(pairingHandle) === retained
        ) {
          pairingSessions.delete(pairingHandle);
        }
        return status;
      } catch (error) {
        const mapped = sdkError(error);
        if (terminalPairingError(mapped) && pairingSessions.get(pairingHandle) === retained) {
          pairingSessions.delete(pairingHandle);
        }
        throw mapped;
      }
    },
    async pairingExchange(authority, _requestId, pairingHandle) {
      const retained = retainedPairing(pairingHandle);
      if (
        retained === undefined ||
        active === null ||
        !sameAuthority(active.authority, authority)
      ) {
        throw new NativeBoundaryError('reconcile_required', false, 'pairing-session-missing');
      }
      pairingSessions.delete(pairingHandle);
      try {
        return { credential: await retained.session.exchange() };
      } catch (error) {
        throw sdkError(error);
      }
    },
    async credentialState(authority) {
      try {
        const status = await requireClient(authority).credentialStatus();
        if (status.status === 'missing') {
          return 'missing';
        }
        if (status.status === 'disconnected') {
          return status.reason === 'credential_update_in_progress'
            ? 'update_in_progress'
            : 'invalid';
        }
        if (status.status === 'revoked') {
          throw new NativeBoundaryError('unauthorized', false, 'credential-revoked');
        }
        if (status.access !== 'chat:read') {
          throw new NativeBoundaryError(status.access, status.access === 'rate_limited', 'access');
        }
        return 'present';
      } catch (error) {
        throw error instanceof NativeBoundaryError ? error : sdkError(error);
      }
    },
    async forgetCredential(authority) {
      try {
        return await requireClient(authority).forgetCredential();
      } catch (error) {
        throw sdkError(error);
      }
    },
    async listFamiliars(authority, _requestId, options) {
      try {
        return await requireClient(authority).listFamiliars(options);
      } catch (error) {
        throw sdkError(error);
      }
    },
    async listProjects(authority, _requestId, options) {
      try {
        return await requireClient(authority).listProjects(options);
      } catch (error) {
        throw sdkError(error);
      }
    },
    async listConversations(authority, _requestId, options) {
      try {
        return await requireClient(authority).listConversations(options);
      } catch (error) {
        throw sdkError(error);
      }
    },
    async getConversation(authority, _requestId, conversationId) {
      try {
        return await requireClient(authority).getConversation(conversationId);
      } catch (error) {
        throw sdkError(error);
      }
    },
    async listConversationMessages(authority, _requestId, conversationId, options) {
      try {
        return await requireClient(authority).listConversationMessages(conversationId, options);
      } catch (error) {
        throw sdkError(error);
      }
    },
    async diagnostics() {
      const result = exactRecord(await call(NATIVE_COMMANDS.diagnostics), [
        'version',
        'platform',
        'architecture',
        'checks',
      ]);
      if (
        result.version !== 1 ||
        (result.platform !== 'linux' &&
          result.platform !== 'darwin' &&
          result.platform !== 'win32' &&
          result.platform !== 'unsupported') ||
        typeof result.architecture !== 'string' ||
        !Array.isArray(result.checks)
      ) {
        throw invalidResponse();
      }
      const checks = result.checks.map((value) => {
        const check = exactRecord(value, ['component', 'status'], ['code']);
        if (
          (check.component !== 'cave_credential_custody' &&
            check.component !== 'cave_protected_authority' &&
            check.component !== 'coven_unix_peer_identity' &&
            check.component !== 'coven_windows_pipe_identity') ||
          (check.status !== 'available' && check.status !== 'unavailable') ||
          (check.code !== undefined &&
            (typeof check.code !== 'string' ||
              !ERROR_CODES.has(check.code as NativeDiagnosticCode)))
        ) {
          throw invalidResponse();
        }
        return {
          component: check.component,
          status: check.status,
          ...(check.code === undefined ? {} : { code: check.code as NativeDiagnosticCode }),
        } as NativeDiagnostics['checks'][number];
      });
      return {
        version: 1,
        platform: result.platform,
        architecture: requiredString(result.architecture, /^[A-Za-z0-9_-]+$/u, 32),
        checks,
      };
    },
    async listenConnectionEvents(listener) {
      return listenCommand(CONNECTION_EVENT, (event) => {
        try {
          const result = exactRecord(event.payload, [
            'version',
            'authority',
            'kind',
            'diagnosticId',
          ]);
          if (
            result.version !== 1 ||
            (result.kind !== 'credential_revoked' &&
              result.kind !== 'transport_offline' &&
              result.kind !== 'authority_replaced')
          ) {
            return;
          }
          listener({
            version: 1,
            authority: authorityReference(result.authority),
            kind: result.kind,
            diagnosticId: requiredString(result.diagnosticId, UUID_PATTERN, 36),
          });
        } catch {
          // Hostile or outdated events are ignored at the trust boundary.
        }
      });
    },
  };

  return Object.freeze(boundary);
}

export const nativeBoundary = createNativeBoundary();
