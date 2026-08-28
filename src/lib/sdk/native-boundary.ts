import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const AUTHORITY_HANDLE_PATTERN =
  /^authority:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PAIRING_HANDLE_PATTERN =
  /^pairing:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COMMIT_HANDLE_PATTERN =
  /^commit:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/u;
const DECLARATION_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const SECRET_FIELD_PATTERN = new RegExp(`(?:${'bear'}${'er'}|secret)`, 'iu');
const SECRET_VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CURRENT_CLIENT_VERSION = [0, 1, 0] as const;

export const NATIVE_COMMANDS = Object.freeze({
  discover: 'sdk_authority_discover',
  close: 'sdk_authority_close',
  installationIdentity: 'sdk_installation_identity',
  health: 'cave_health',
  pairingCreate: 'cave_pairing_create',
  pairingPoll: 'cave_pairing_poll',
  pairingExchange: 'cave_pairing_exchange',
  pairingCommit: 'cave_pairing_commit',
  pairingDiscard: 'cave_pairing_discard',
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

export type PageOptions = Readonly<{
  limit: number;
  cursor?: string;
}>;

export type PageCursor = Readonly<{
  current?: string;
  next?: string;
  previous?: string;
  hasMore: boolean;
}>;

export type Page<T> = Readonly<{
  data: readonly T[];
  cursor?: PageCursor;
}>;

export type CaveCanonicalFamiliar = Readonly<{
  id: string;
  displayName: string;
  role: string;
  description?: string;
  pronouns?: string;
  status?: string;
  lastSeenAt?: string;
  activeSessions?: number;
}>;

export type CaveProject = Readonly<{
  id: string;
  name: string;
  root: string;
  color?: string;
  repoUrl?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type CaveConversation = Readonly<{
  id: string;
  familiarId: string;
  harness?: string;
  model?: string;
  runtime?: string;
  title?: string;
  origin?: string;
  status?: string;
  exitCode?: number | null;
  pending?: boolean;
  createdAt?: string;
  updatedAt: string;
}>;

export type CaveConversationMessage = Readonly<{
  id: string;
  conversationId: string;
  parentId: string | null;
  role: string;
  text: string;
  createdAt: string;
  attachmentCount: number;
  toolCount: number;
  isError?: boolean;
  cancelled?: boolean;
}>;

export type CaveHealth = Readonly<{
  status: 'ok';
  apiVersion: string;
  minimumClientVersion: string;
  capabilities: readonly string[];
  operations: readonly string[];
  instanceId: string;
  pairingRequired: boolean;
  releaseVersion: string;
}>;

export type PairingStatus = Readonly<{
  id: string;
  status: 'pending' | 'approved' | 'denied' | 'expired';
  expiresAt: number;
}>;

export type CredentialMetadata = Readonly<{
  id: string;
  appName: string;
  installationId: string;
  scopes: readonly string[];
  createdAt: number;
  lastUsedAt: number | null;
  revokedAt: number | null;
  revocationReason: string | null;
}>;

export type CredentialState = 'missing' | 'present' | 'update_in_progress' | 'invalid';
export type PairingDiscardResult = 'absent' | 'changed' | 'deleted';

export type NativeDiagnosticCode =
  | 'body_limit'
  | 'conflict'
  | 'credential_update_in_progress'
  | 'incompatible_version'
  | 'internal_error'
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

const NATIVE_ERROR_CODES = new Set<NativeDiagnosticCode>([
  'body_limit',
  'conflict',
  'credential_update_in_progress',
  'incompatible_version',
  'internal_error',
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

export class NativeBoundaryError extends Error {
  readonly code: NativeDiagnosticCode;
  readonly retryable: boolean;
  readonly diagnosticId: string;

  constructor(code: NativeDiagnosticCode, retryable: boolean, diagnosticId: string) {
    super('The native OpenCoven operation failed.');
    this.name = 'NativeBoundaryError';
    this.code = code;
    this.retryable = retryable;
    this.diagnosticId = diagnosticId;
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
    request: Readonly<{
      appName: 'OpenCoven Chat';
      installationId: string;
      scopes: readonly ['chat:read'];
    }>,
  ): Promise<Readonly<{ handle: string; requestId: string; expiresAt: number }>>;
  pairingPoll(
    authority: AuthorityReference,
    requestId: string,
    pairingHandle: string,
  ): Promise<PairingStatus>;
  pairingExchange(
    authority: AuthorityReference,
    requestId: string,
    pairingHandle: string,
  ): Promise<Readonly<{ commitHandle: string; credential: CredentialMetadata }>>;
  pairingCommit(
    authority: AuthorityReference,
    requestId: string,
    commitHandle: string,
  ): Promise<void>;
  pairingDiscard(
    authority: AuthorityReference,
    requestId: string,
    commitHandle: string,
  ): Promise<PairingDiscardResult>;
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

function exactArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw invalidResponse();
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(value)) {
    if (
      typeof key !== 'string' ||
      (key !== 'length' && !/^(0|[1-9]\d*)$/u.test(key)) ||
      descriptors[key] === undefined ||
      !Object.hasOwn(descriptors[key], 'value')
    ) {
      throw invalidResponse();
    }
  }
  return value;
}

function assertSecretFree(value: unknown): void {
  const stack: { value: unknown; key?: string }[] = [{ value }];
  const seen = new Set<object>();
  let nodes = 0;
  let characters = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) {
      continue;
    }
    nodes += 1;
    if (nodes > 4_096) {
      throw invalidResponse();
    }
    const candidate = current.value;
    if (typeof candidate === 'string') {
      characters += candidate.length;
      if (
        characters > 64 * 1024 ||
        new RegExp(`^${'Bear'}${'er'}\\s`, 'iu').test(candidate) ||
        (SECRET_VALUE_PATTERN.test(candidate) &&
          !['current', 'next', 'previous', 'nonce', 'keyId', 'publicKey'].includes(
            current.key ?? '',
          ))
      ) {
        throw invalidResponse();
      }
      continue;
    }
    if (candidate === null || typeof candidate === 'boolean') {
      continue;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        throw invalidResponse();
      }
      continue;
    }
    if (typeof candidate !== 'object' || seen.has(candidate)) {
      throw invalidResponse();
    }
    seen.add(candidate);
    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    for (const key of Reflect.ownKeys(candidate)) {
      if (typeof key !== 'string') {
        throw invalidResponse();
      }
      const descriptor = descriptors[key];
      if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) {
        throw invalidResponse();
      }
      if (SECRET_FIELD_PATTERN.test(key)) {
        throw invalidResponse();
      }
      if (key !== 'length') {
        stack.push({ value: descriptor.value, key });
      }
    }
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

function optionalString(value: unknown, maximum = 4_096): string | undefined {
  return value === undefined ? undefined : requiredString(value, undefined, maximum);
}

function safeInteger(value: unknown, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw invalidResponse();
  }
  return value as number;
}

function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw invalidResponse();
  }
  return value;
}

function optionalNullableInteger(value: unknown): number | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }
  return safeInteger(value);
}

function authorityReference(value: unknown): AuthorityReference {
  const record = exactRecord(value, ['handle', 'generation']);
  return {
    handle: requiredString(record.handle, AUTHORITY_HANDLE_PATTERN, 128),
    generation: safeInteger(record.generation, 1),
  };
}

function assertSameAuthority(actual: AuthorityReference, expected: AuthorityReference): void {
  if (actual.handle !== expected.handle || actual.generation !== expected.generation) {
    throw new NativeBoundaryError('reconcile_required', false, 'authority-changed');
  }
}

function requestId(value: unknown): string {
  const parsed = requiredString(value, REQUEST_ID_PATTERN, 128);
  if (SECRET_VALUE_PATTERN.test(parsed) || SECRET_FIELD_PATTERN.test(parsed)) {
    throw invalidResponse();
  }
  return parsed;
}

function assertSameRequest(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new NativeBoundaryError('reconcile_required', false, 'request-changed');
  }
}

function declarations(value: unknown): readonly string[] {
  const entries = exactArray(value);
  if (
    entries.length === 0 ||
    entries.length > 32 ||
    entries.some(
      (entry) => typeof entry !== 'string' || entry.length > 64 || !DECLARATION_PATTERN.test(entry),
    ) ||
    new Set(entries).size !== entries.length
  ) {
    throw invalidResponse();
  }
  return value as readonly string[];
}

function errorDetails(value: unknown): void {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw invalidResponse();
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > 16 || keys.some((key) => typeof key !== 'string')) {
      throw invalidResponse();
    }
    const record = exactRecord(value, [], keys as string[]);
    for (const [key, entry] of Object.entries(record)) {
      requiredString(key, undefined, 64);
      requiredString(entry, undefined, 256);
    }
  } catch (error) {
    if (error instanceof NativeBoundaryError) {
      throw error;
    }
    throw invalidResponse();
  }
}

function semver(value: unknown): string {
  return requiredString(value, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u, 32);
}

function assertCompatible(minimumClientVersion: string): void {
  const parts = minimumClientVersion.split('.').map(Number);
  for (const [index, current] of CURRENT_CLIENT_VERSION.entries()) {
    const minimum = parts[index] ?? 0;
    if (minimum < current) {
      return;
    }
    if (minimum > current) {
      throw new NativeBoundaryError('incompatible_version', false, 'version-incompatible');
    }
  }
}

type ParsedEnvelope = Readonly<{
  apiVersion: string;
  minimumClientVersion: string;
  capabilities: readonly string[];
  operations: readonly string[];
  data: unknown;
  cursor?: PageCursor;
}>;

function pageCursor(value: unknown): PageCursor | undefined {
  if (value === undefined) {
    return undefined;
  }
  const cursor = exactRecord(value, ['hasMore'], ['current', 'next', 'previous']);
  if (typeof cursor.hasMore !== 'boolean') {
    throw invalidResponse();
  }
  const parsed: {
    current?: string;
    next?: string;
    previous?: string;
    hasMore: boolean;
  } = { hasMore: cursor.hasMore };
  for (const key of ['current', 'next', 'previous'] as const) {
    const candidate = cursor[key];
    if (candidate !== undefined) {
      parsed[key] = requiredString(candidate, CURSOR_PATTERN, 512);
    }
  }
  if (parsed.hasMore && parsed.next === undefined) {
    throw invalidResponse();
  }
  return parsed;
}

function nativeError(value: unknown): NativeBoundaryError | undefined {
  try {
    const error = exactRecord(value, ['code', 'retryable', 'diagnosticId']);
    if (
      typeof error.code !== 'string' ||
      !NATIVE_ERROR_CODES.has(error.code as NativeDiagnosticCode) ||
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

function parseEnvelope(
  value: unknown,
  requiredCapabilities: readonly string[],
  requiredOperation: string,
): ParsedEnvelope {
  const envelope = exactRecord(
    value,
    ['apiVersion', 'minimumClientVersion', 'capabilities', 'operations'],
    ['requestId', 'data', 'error', 'cursor'],
  );
  const apiVersion = requiredString(envelope.apiVersion, /^1\.(0|[1-9]\d*)$/u, 16);
  const minimumClientVersion = semver(envelope.minimumClientVersion);
  assertCompatible(minimumClientVersion);
  const capabilities = declarations(envelope.capabilities);
  const operations = declarations(envelope.operations);
  if (
    !operations.includes(requiredOperation) ||
    requiredCapabilities.some((capability) => !capabilities.includes(capability))
  ) {
    throw invalidResponse();
  }
  if (envelope.requestId !== undefined) {
    requestId(envelope.requestId);
  }
  const hasData = envelope.data !== undefined;
  const hasError = envelope.error !== undefined;
  if (hasData === hasError) {
    throw invalidResponse();
  }
  if (hasError) {
    const error = exactRecord(envelope.error, ['code', 'message', 'retryable'], ['details']);
    const code = requiredString(error.code, DECLARATION_PATTERN, 64);
    if (
      !NATIVE_ERROR_CODES.has(code as NativeDiagnosticCode) ||
      typeof error.retryable !== 'boolean'
    ) {
      throw invalidResponse();
    }
    requiredString(error.message, undefined, 256);
    if (error.details !== undefined) {
      errorDetails(error.details);
    }
    throw new NativeBoundaryError(
      code as NativeDiagnosticCode,
      error.retryable,
      typeof envelope.requestId === 'string' ? envelope.requestId : 'remote-diagnostic',
    );
  }
  const cursor = envelope.cursor === undefined ? undefined : pageCursor(envelope.cursor);
  return {
    apiVersion,
    minimumClientVersion,
    capabilities,
    operations,
    data: envelope.data,
    ...(cursor === undefined ? {} : { cursor }),
  };
}

function nativeResponse(
  value: unknown,
  statusCode: number,
  capabilities: readonly string[],
  operation: string,
): ParsedEnvelope {
  const response = exactRecord(value, ['statusCode', 'payload']);
  if (safeInteger(response.statusCode) !== statusCode) {
    if ((response.statusCode as number) < 400 || (response.statusCode as number) > 599) {
      throw invalidResponse();
    }
  }
  return parseEnvelope(response.payload, capabilities, operation);
}

function operationResult(
  value: unknown,
  authority: AuthorityReference,
  expectedRequestId: string,
): unknown {
  assertSecretFree(value);
  const operation = exactRecord(value, ['authority', 'requestId', 'result']);
  assertSameAuthority(authorityReference(operation.authority), authority);
  assertSameRequest(requestId(operation.requestId), expectedRequestId);
  return operation.result;
}

function validatePageOptions(options: PageOptions): PageOptions {
  const record = exactRecord(options, ['limit'], ['cursor']);
  const limit = safeInteger(record.limit, 1);
  if (limit > 100) {
    throw new NativeBoundaryError('invalid_request', false, 'invalid-page-options');
  }
  if (record.cursor === undefined) {
    return { limit };
  }
  return { limit, cursor: requiredString(record.cursor, CURSOR_PATTERN, 512) };
}

function validateCanonicalId(value: string): string {
  if (value.trim().length === 0 || value === '.' || value === '..' || value.length > 512) {
    throw new NativeBoundaryError('invalid_request', false, 'invalid-conversation-id');
  }
  return value;
}

function familiar(value: unknown): asserts value is CaveCanonicalFamiliar {
  const record = exactRecord(
    value,
    ['id', 'displayName', 'role'],
    ['description', 'pronouns', 'status', 'lastSeenAt', 'activeSessions'],
  );
  requiredString(record.id);
  requiredString(record.displayName);
  requiredString(record.role);
  for (const key of ['description', 'pronouns', 'status', 'lastSeenAt'] as const) {
    optionalString(record[key]);
  }
  if (record.activeSessions !== undefined) {
    safeInteger(record.activeSessions);
  }
}

function project(value: unknown): asserts value is CaveProject {
  const record = exactRecord(
    value,
    ['id', 'name', 'root', 'createdAt', 'updatedAt'],
    ['color', 'repoUrl'],
  );
  for (const key of ['id', 'name', 'root', 'createdAt', 'updatedAt'] as const) {
    requiredString(record[key]);
  }
  optionalString(record.color);
  optionalString(record.repoUrl);
}

function conversation(value: unknown): asserts value is CaveConversation {
  const record = exactRecord(
    value,
    ['id', 'familiarId', 'updatedAt'],
    [
      'harness',
      'model',
      'runtime',
      'title',
      'origin',
      'status',
      'exitCode',
      'pending',
      'createdAt',
    ],
  );
  requiredString(record.id);
  requiredString(record.familiarId);
  requiredString(record.updatedAt);
  for (const key of [
    'harness',
    'model',
    'runtime',
    'title',
    'origin',
    'status',
    'createdAt',
  ] as const) {
    optionalString(record[key]);
  }
  optionalNullableInteger(record.exitCode);
  optionalBoolean(record.pending);
}

function message(value: unknown): asserts value is CaveConversationMessage {
  const record = exactRecord(
    value,
    [
      'id',
      'conversationId',
      'parentId',
      'role',
      'text',
      'createdAt',
      'attachmentCount',
      'toolCount',
    ],
    ['isError', 'cancelled'],
  );
  for (const key of ['id', 'conversationId', 'role', 'text', 'createdAt'] as const) {
    requiredString(record[key]);
  }
  if (record.parentId !== null) {
    requiredString(record.parentId);
  }
  safeInteger(record.attachmentCount);
  safeInteger(record.toolCount);
  optionalBoolean(record.isError);
  optionalBoolean(record.cancelled);
}

function canonicalPage<T>(
  value: unknown,
  collection: string,
  validateEntry: (entry: unknown) => asserts entry is T,
  capabilities: readonly string[],
  operation: string,
): Page<T> {
  const envelope = nativeResponse(value, 200, capabilities, operation);
  const data = exactRecord(envelope.data, [collection]);
  const entries = exactArray(data[collection]);
  for (const entry of entries) {
    validateEntry(entry);
  }
  return {
    data: entries as readonly T[],
    ...(envelope.cursor === undefined ? {} : { cursor: envelope.cursor }),
  };
}

function credentialMetadata(value: unknown): CredentialMetadata {
  const record = exactRecord(value, [
    'id',
    'appName',
    'installationId',
    'scopes',
    'createdAt',
    'lastUsedAt',
    'revokedAt',
    'revocationReason',
  ]);
  const scopes = exactArray(record.scopes);
  if (
    requiredString(record.appName) !== 'OpenCoven Chat' ||
    scopes.length !== 1 ||
    scopes[0] !== 'chat:read'
  ) {
    throw invalidResponse();
  }
  if (record.revokedAt !== null || record.revocationReason !== null) {
    throw invalidResponse();
  }
  return {
    id: requiredString(record.id, UUID_PATTERN, 36),
    appName: 'OpenCoven Chat',
    installationId: requiredString(record.installationId, UUID_PATTERN, 36),
    scopes: record.scopes as readonly string[],
    createdAt: safeInteger(record.createdAt),
    lastUsedAt: optionalNullableInteger(record.lastUsedAt) ?? null,
    revokedAt: null,
    revocationReason: null,
  };
}

function authorityBinding(value: unknown): void {
  const binding = exactRecord(value, ['version', 'instanceId', 'endpoint', 'record', 'freshness']);
  if (binding.version !== 1) {
    throw invalidResponse();
  }
  requiredString(binding.instanceId, UUID_PATTERN, 36);
  const endpoint = exactRecord(binding.endpoint, ['kind', 'url']);
  const endpointUrl = requiredString(endpoint.url, undefined, 128);
  let parsedEndpoint: URL;
  try {
    parsedEndpoint = new URL(endpointUrl);
  } catch {
    throw invalidResponse();
  }
  const port = Number(parsedEndpoint.port);
  if (
    endpoint.kind !== 'http' ||
    parsedEndpoint.protocol !== 'http:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(parsedEndpoint.hostname) ||
    !Number.isSafeInteger(port) ||
    port <= 0 ||
    port > 65_535 ||
    parsedEndpoint.username !== '' ||
    parsedEndpoint.password !== '' ||
    parsedEndpoint.pathname !== '/' ||
    parsedEndpoint.search !== '' ||
    parsedEndpoint.hash !== ''
  ) {
    throw invalidResponse();
  }
  const record = exactRecord(binding.record, ['identity', 'device', 'inode']);
  requiredString(record.identity, /^sha256:[0-9a-f]{64}$/u, 71);
  safeInteger(record.device);
  safeInteger(record.inode);
  const freshness = exactRecord(binding.freshness, ['pid', 'nonce', 'startedAt']);
  safeInteger(freshness.pid, 1);
  requiredString(freshness.nonce, SECRET_VALUE_PATTERN, 43);
  requiredString(
    freshness.startedAt,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u,
    35,
  );
}

function platformAvailable(): boolean {
  const scope = globalThis as typeof globalThis & {
    __TAURI__?: unknown;
    __TAURI_INTERNALS__?: unknown;
  };
  return scope.__TAURI__ !== undefined || scope.__TAURI_INTERNALS__ !== undefined;
}

function mapInvokeFailure(error: unknown): never {
  throw nativeError(error) ?? invalidResponse();
}

export function createNativeBoundary(
  dependencies: { invoke?: InvokeCommand; listen?: ListenCommand; available?: () => boolean } = {},
): NativeBoundary {
  const invokeCommand = dependencies.invoke ?? (invoke as InvokeCommand);
  const listenCommand = dependencies.listen ?? (listen as ListenCommand);
  const available = dependencies.available ?? platformAvailable;

  async function call(command: string, args?: Record<string, unknown>): Promise<unknown> {
    try {
      return await invokeCommand(command, args);
    } catch (error) {
      mapInvokeFailure(error);
    }
  }

  async function callOperation(
    command: string,
    authority: AuthorityReference,
    expectedRequestId: string,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    return operationResult(
      await call(command, { input: { authority, requestId: expectedRequestId, ...input } }),
      authority,
      expectedRequestId,
    );
  }

  const boundary: NativeBoundary = {
    isAvailable: available,
    async discover() {
      const value = await call(NATIVE_COMMANDS.discover);
      assertSecretFree(value);
      return authorityReference(value);
    },
    async close(authority) {
      const result = exactRecord(await call(NATIVE_COMMANDS.close, { input: { authority } }), [
        'closed',
      ]);
      if (typeof result.closed !== 'boolean') {
        throw invalidResponse();
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
    async health(authority, expectedRequestId) {
      const result = await callOperation(NATIVE_COMMANDS.health, authority, expectedRequestId, {});
      const envelope = nativeResponse(result, 200, ['health'], 'health.read');
      const data = exactRecord(envelope.data, ['instanceId', 'pairingRequired', 'releaseVersion']);
      if (typeof data.pairingRequired !== 'boolean') {
        throw invalidResponse();
      }
      return {
        status: 'ok',
        apiVersion: envelope.apiVersion,
        minimumClientVersion: envelope.minimumClientVersion,
        capabilities: envelope.capabilities,
        operations: envelope.operations,
        instanceId: requiredString(data.instanceId, UUID_PATTERN, 36),
        pairingRequired: data.pairingRequired,
        releaseVersion: semver(data.releaseVersion),
      };
    },
    async pairingCreate(authority, expectedRequestId, request) {
      const result = exactRecord(
        await callOperation(NATIVE_COMMANDS.pairingCreate, authority, expectedRequestId, {
          request,
        }),
        ['handle', 'response'],
      );
      const envelope = nativeResponse(result.response, 201, ['pairing'], 'pairing.create');
      const data = exactRecord(envelope.data, ['requestId', 'expiresAt']);
      return {
        handle: requiredString(result.handle, PAIRING_HANDLE_PATTERN, 128),
        requestId: requiredString(data.requestId, UUID_PATTERN, 36),
        expiresAt: safeInteger(data.expiresAt),
      };
    },
    async pairingPoll(authority, expectedRequestId, pairingHandle) {
      const result = await callOperation(
        NATIVE_COMMANDS.pairingPoll,
        authority,
        expectedRequestId,
        { pairingHandle },
      );
      const envelope = nativeResponse(result, 200, ['pairing'], 'pairing.poll');
      const data = exactRecord(envelope.data, ['id', 'status', 'expiresAt']);
      if (
        data.status !== 'pending' &&
        data.status !== 'approved' &&
        data.status !== 'denied' &&
        data.status !== 'expired'
      ) {
        throw invalidResponse();
      }
      return {
        id: requiredString(data.id, UUID_PATTERN, 36),
        status: data.status,
        expiresAt: safeInteger(data.expiresAt),
      };
    },
    async pairingExchange(authority, expectedRequestId, pairingHandle) {
      const result = exactRecord(
        await callOperation(NATIVE_COMMANDS.pairingExchange, authority, expectedRequestId, {
          pairingHandle,
        }),
        ['authorityBinding', 'commitHandle', 'response'],
      );
      authorityBinding(result.authorityBinding);
      const envelope = nativeResponse(result.response, 200, ['pairing'], 'pairing.exchange');
      const data = exactRecord(envelope.data, ['credential']);
      return {
        commitHandle: requiredString(result.commitHandle, COMMIT_HANDLE_PATTERN, 128),
        credential: credentialMetadata(data.credential),
      };
    },
    async pairingCommit(authority, expectedRequestId, commitHandle) {
      const result = await callOperation(
        NATIVE_COMMANDS.pairingCommit,
        authority,
        expectedRequestId,
        { commitHandle },
      );
      if (result !== null) {
        throw invalidResponse();
      }
    },
    async pairingDiscard(authority, expectedRequestId, commitHandle) {
      const result = await callOperation(
        NATIVE_COMMANDS.pairingDiscard,
        authority,
        expectedRequestId,
        { commitHandle },
      );
      if (result !== 'absent' && result !== 'changed' && result !== 'deleted') {
        throw invalidResponse();
      }
      return result;
    },
    async credentialState(authority, expectedRequestId) {
      const result = exactRecord(
        await callOperation(NATIVE_COMMANDS.credentialState, authority, expectedRequestId, {}),
        ['status'],
      );
      if (
        result.status !== 'missing' &&
        result.status !== 'present' &&
        result.status !== 'update_in_progress' &&
        result.status !== 'invalid'
      ) {
        throw invalidResponse();
      }
      return result.status;
    },
    async forgetCredential(authority, expectedRequestId) {
      const result = await callOperation(
        NATIVE_COMMANDS.forgetCredential,
        authority,
        expectedRequestId,
        {},
      );
      if (typeof result !== 'boolean') {
        throw invalidResponse();
      }
      return result;
    },
    async listFamiliars(authority, expectedRequestId, options) {
      return canonicalPage(
        await callOperation(NATIVE_COMMANDS.listFamiliars, authority, expectedRequestId, {
          options: validatePageOptions(options),
        }),
        'familiars',
        familiar,
        ['familiars', 'cursors'],
        'familiars.list',
      );
    },
    async listProjects(authority, expectedRequestId, options) {
      return canonicalPage(
        await callOperation(NATIVE_COMMANDS.listProjects, authority, expectedRequestId, {
          options: validatePageOptions(options),
        }),
        'projects',
        project,
        ['projects', 'cursors'],
        'projects.list',
      );
    },
    async listConversations(authority, expectedRequestId, options) {
      return canonicalPage(
        await callOperation(NATIVE_COMMANDS.listConversations, authority, expectedRequestId, {
          options: validatePageOptions(options),
        }),
        'conversations',
        conversation,
        ['conversations', 'cursors'],
        'conversations.list',
      );
    },
    async getConversation(authority, expectedRequestId, conversationId) {
      const envelope = nativeResponse(
        await callOperation(NATIVE_COMMANDS.getConversation, authority, expectedRequestId, {
          conversationId: validateCanonicalId(conversationId),
        }),
        200,
        ['conversations'],
        'conversations.read',
      );
      const data = exactRecord(envelope.data, ['conversation']);
      conversation(data.conversation);
      return data.conversation;
    },
    async listConversationMessages(authority, expectedRequestId, conversationId, options) {
      return canonicalPage(
        await callOperation(
          NATIVE_COMMANDS.listConversationMessages,
          authority,
          expectedRequestId,
          {
            conversationId: validateCanonicalId(conversationId),
            options: validatePageOptions(options),
          },
        ),
        'messages',
        message,
        ['conversation-messages', 'cursors'],
        'messages.list',
      );
    },
    async diagnostics() {
      const raw = await call(NATIVE_COMMANDS.diagnostics);
      assertSecretFree(raw);
      const result = exactRecord(raw, ['version', 'platform', 'architecture', 'checks']);
      if (
        result.version !== 1 ||
        (result.platform !== 'linux' &&
          result.platform !== 'darwin' &&
          result.platform !== 'win32' &&
          result.platform !== 'unsupported')
      ) {
        throw invalidResponse();
      }
      const architecture = requiredString(result.architecture, /^[A-Za-z0-9_-]+$/u, 32);
      const checks = exactArray(result.checks).map((value) => {
        const check = exactRecord(value, ['component', 'status'], ['code']);
        if (
          (check.component !== 'cave_credential_custody' &&
            check.component !== 'cave_protected_authority' &&
            check.component !== 'coven_unix_peer_identity' &&
            check.component !== 'coven_windows_pipe_identity') ||
          (check.status !== 'available' && check.status !== 'unavailable') ||
          (check.code !== undefined &&
            (typeof check.code !== 'string' ||
              !NATIVE_ERROR_CODES.has(check.code as NativeDiagnosticCode)))
        ) {
          throw invalidResponse();
        }
        const component = check.component as NativeDiagnostics['checks'][number]['component'];
        const status = check.status as NativeDiagnostics['checks'][number]['status'];
        return {
          component,
          status,
          ...(check.code === undefined ? {} : { code: check.code as NativeDiagnosticCode }),
        };
      });
      return { version: 1, platform: result.platform, architecture, checks };
    },
    async listenConnectionEvents(listener) {
      return listenCommand(CONNECTION_EVENT, (event) => {
        try {
          assertSecretFree(event.payload);
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
