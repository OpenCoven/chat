import {
  type CaveClient,
  type CaveCredentialStatus,
  type CaveHealth,
  type CavePairingSession,
  isCaveClientError,
} from '@opencoven/cave-client/managed';
import type { OperationOptions } from '@opencoven/sdk-core/browser';

import type { CaveConnectionHost } from './connection-host';

export type PairingRequiredReason = 'cancelled' | 'expired';

export type SdkConnectionState =
  | Readonly<{ state: 'idle' }>
  | Readonly<{ state: 'discovering' }>
  | Readonly<{ state: 'incompatible'; diagnosticId: string }>
  | Readonly<{
      state: 'pairing_required';
      caveInstanceId: string;
      reason?: PairingRequiredReason;
    }>
  | Readonly<{ state: 'pairing'; requestId: string; expiresAt: number }>
  | Readonly<{ state: 'ready'; caveInstanceId: string; covenAvailable: boolean }>
  | Readonly<{ state: 'revoked'; diagnosticId: string }>
  | Readonly<{ state: 'offline'; lastHealthyAt: number | null; diagnosticId: string }>
  | Readonly<{ state: 'error'; code: string; diagnosticId: string }>;

type CavePairingSessionPort = Pick<
  CavePairingSession,
  'exchange' | 'expiresAt' | 'poll' | 'requestId'
>;

export type CaveReadClient = Pick<
  CaveClient,
  | 'listFamiliars'
  | 'listProjects'
  | 'listConversations'
  | 'getConversation'
  | 'listConversationMessages'
>;

type CaveConnectionClient = CaveReadClient &
  Pick<CaveClient, 'createPairing' | 'credentialStatus' | 'forgetCredential' | 'health'>;

export type CaveConnectionHostPort = Pick<
  CaveConnectionHost,
  'covenHealth' | 'discover' | 'launch' | 'resetPairing'
>;

export type CavePairingIdentity = Readonly<{
  appName: string;
  installationId: string;
}>;

export type CaveConnectionControllerOptions = Readonly<{
  host: CaveConnectionHostPort;
  pairingIdentity: CavePairingIdentity;
  now: () => number;
  sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  pollIntervalMs: number;
  maxPairingPolls?: number;
  operationTimeoutMs?: number;
}>;

export type SdkConnectionListener = (state: SdkConnectionState) => void;

export type CaveConnectionController = Readonly<{
  getState: () => SdkConnectionState;
  getReadyClient: () => CaveReadClient | null;
  subscribe: (listener: SdkConnectionListener) => () => void;
  start: () => Promise<void>;
  retry: () => Promise<void>;
  launch: () => Promise<void>;
  beginPairing: () => Promise<void>;
  cancelPairing: () => Promise<void>;
  forgetCredential: () => Promise<void>;
  dispose: () => void;
}>;

type ActiveOperation = 'none' | 'discovering' | 'pairing' | 'forgetting' | 'launching';
type ClientAssociation = Readonly<{
  client: CaveConnectionClient;
  caveInstanceId: string;
}>;
type ConnectionAttempt = Readonly<{
  generation: number;
  signal: AbortSignal;
}>;

type ConnectionMachine = Readonly<{
  generation: number;
  active: ActiveOperation;
  state: SdkConnectionState;
  caveInstanceId: string | null;
  lastHealthyAt: number | null;
}>;

type ConnectionEvent =
  | Readonly<{
      type: 'activate';
      generation: number;
      active: Exclude<ActiveOperation, 'none'>;
      state?: SdkConnectionState;
    }>
  | Readonly<{
      type: 'healthy';
      generation: number;
      caveInstanceId: string;
      lastHealthyAt: number;
    }>
  | Readonly<{
      type: 'state';
      generation: number;
      active: ActiveOperation;
      state: SdkConnectionState;
    }>
  | Readonly<{
      type: 'dispose';
      generation: number;
    }>;

type DiagnosticCode =
  | 'aborted'
  | 'body_limit'
  | 'conflict'
  | 'credential_unavailable'
  | 'credential_update_in_progress'
  | 'incompatible_version'
  | 'invalid_response'
  | 'not_found'
  | 'pairing_denied'
  | 'pairing_expired'
  | 'poll_limit'
  | 'rate_limited'
  | 'reconcile_required'
  | 'scope_denied'
  | 'service_unavailable'
  | 'timeout'
  | 'unauthorized'
  | 'unsupported_operation';

type DiagnosticCategory =
  | 'coven'
  | 'credential'
  | 'credential_management'
  | 'discovery'
  | 'health'
  | 'launch'
  | 'pairing';

type SafeFailure = Readonly<{
  code: DiagnosticCode;
  retryable: boolean;
  incompatible: boolean;
}>;

type DiagnosticRecord = Readonly<{
  id: string;
  code: DiagnosticCode;
  retryable: boolean;
  category: DiagnosticCategory;
}>;

const MAX_DIAGNOSTICS = 32;
const DEFAULT_MAX_PAIRING_POLLS = 60;
const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
const ABORTED_ATTEMPT = Symbol('aborted-attempt');
const OPERATION_DEADLINE_EXCEEDED = Symbol('operation-deadline-exceeded');

function freezeState(state: SdkConnectionState): SdkConnectionState {
  return Object.freeze(state);
}

function initialMachine(): ConnectionMachine {
  return Object.freeze({
    generation: 0,
    active: 'none',
    state: freezeState({ state: 'idle' }),
    caveInstanceId: null,
    lastHealthyAt: null,
  });
}

function reduceConnection(machine: ConnectionMachine, event: ConnectionEvent): ConnectionMachine {
  switch (event.type) {
    case 'activate':
      if (event.generation !== machine.generation + 1) {
        return machine;
      }
      return Object.freeze({
        ...machine,
        generation: event.generation,
        active: event.active,
        ...(event.state === undefined ? {} : { state: event.state }),
      });
    case 'healthy':
      if (event.generation !== machine.generation) {
        return machine;
      }
      return Object.freeze({
        ...machine,
        caveInstanceId: event.caveInstanceId,
        lastHealthyAt: event.lastHealthyAt,
      });
    case 'state':
      if (event.generation !== machine.generation) {
        return machine;
      }
      return Object.freeze({
        ...machine,
        active: event.active,
        state: event.state,
      });
    case 'dispose':
      if (event.generation !== machine.generation + 1) {
        return machine;
      }
      return Object.freeze({
        generation: event.generation,
        active: 'none',
        state: freezeState({ state: 'idle' }),
        caveInstanceId: null,
        lastHealthyAt: null,
      });
  }
}

function diagnosticCode(value: string): DiagnosticCode {
  switch (value) {
    case 'aborted':
    case 'body_limit':
    case 'conflict':
    case 'credential_update_in_progress':
    case 'incompatible_version':
    case 'invalid_response':
    case 'not_found':
    case 'pairing_denied':
    case 'pairing_expired':
    case 'rate_limited':
    case 'reconcile_required':
    case 'scope_denied':
    case 'service_unavailable':
    case 'timeout':
    case 'unauthorized':
    case 'unsupported_operation':
      return value;
    default:
      return 'invalid_response';
  }
}

function failureFrom(error: unknown): SafeFailure {
  if (error === OPERATION_DEADLINE_EXCEEDED) {
    return Object.freeze({
      code: 'timeout',
      retryable: true,
      incompatible: false,
    });
  }

  if (!isCaveClientError(error)) {
    return Object.freeze({
      code: 'service_unavailable',
      retryable: true,
      incompatible: false,
    });
  }

  const code = diagnosticCode(error.code);
  return Object.freeze({
    code,
    retryable: error.retryable,
    incompatible: code === 'incompatible_version' || error.compatibility?.compatible === false,
  });
}

function nativeFailureFrom(error: unknown): SafeFailure {
  try {
    if (typeof error !== 'object' || error === null || Array.isArray(error)) {
      return failureFrom(error);
    }
    const descriptors = Object.getOwnPropertyDescriptors(error);
    const code = descriptors.code;
    const retryable = descriptors.retryable;
    if (
      code === undefined ||
      retryable === undefined ||
      !Object.hasOwn(code, 'value') ||
      !Object.hasOwn(retryable, 'value') ||
      typeof code.value !== 'string' ||
      typeof retryable.value !== 'boolean'
    ) {
      return failureFrom(error);
    }
    const boundedCode = diagnosticCode(code.value);
    return Object.freeze({
      code: boundedCode,
      retryable: retryable.value,
      incompatible: boundedCode === 'incompatible_version',
    });
  } catch {
    return failureFrom(error);
  }
}

function isPairingTimeout(error: unknown): boolean {
  return (
    error === OPERATION_DEADLINE_EXCEEDED || (isCaveClientError(error) && error.code === 'timeout')
  );
}

function isPairingExpired(error: unknown): boolean {
  return isCaveClientError(error) && error.code === 'pairing_expired';
}

function isOfflineFailure(failure: SafeFailure): boolean {
  return (
    failure.code === 'not_found' ||
    failure.code === 'service_unavailable' ||
    failure.code === 'timeout' ||
    (failure.retryable &&
      failure.code !== 'pairing_denied' &&
      failure.code !== 'pairing_expired' &&
      failure.code !== 'rate_limited')
  );
}

function validPollInterval(pollIntervalMs: number): boolean {
  return Number.isSafeInteger(pollIntervalMs) && pollIntervalMs > 0;
}

function validPollLimit(maxPairingPolls: number): boolean {
  return Number.isSafeInteger(maxPairingPolls) && maxPairingPolls > 0;
}

function validOperationTimeout(operationTimeoutMs: number): boolean {
  return Number.isSafeInteger(operationTimeoutMs) && operationTimeoutMs > 0;
}

function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(ABORTED_ATTEMPT);
  }

  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(ABORTED_ATTEMPT);
    };
    signal.addEventListener('abort', abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}

export function createCaveConnectionController(
  options: CaveConnectionControllerOptions,
): CaveConnectionController {
  if (!validPollInterval(options.pollIntervalMs)) {
    throw new RangeError('pollIntervalMs must be a positive safe integer.');
  }

  const maxPairingPolls = options.maxPairingPolls ?? DEFAULT_MAX_PAIRING_POLLS;
  if (!validPollLimit(maxPairingPolls)) {
    throw new RangeError('maxPairingPolls must be a positive safe integer.');
  }
  const operationTimeoutMs = options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
  if (!validOperationTimeout(operationTimeoutMs)) {
    throw new RangeError('operationTimeoutMs must be a positive safe integer.');
  }

  let machine = initialMachine();
  let association: ClientAssociation | undefined;
  let activePromise: Promise<void> | undefined;
  let pairingResetPromise: Promise<void> | undefined;
  let disposeCleanupPromise: Promise<void> | undefined;
  let activeAbortController: AbortController | undefined;
  let disposed = false;
  let diagnosticSequence = 0;
  const diagnostics: DiagnosticRecord[] = [];
  const listeners = new Set<SdkConnectionListener>();

  function publish(event: ConnectionEvent): void {
    const previous = machine;
    const next = reduceConnection(previous, event);
    if (next === previous) {
      return;
    }
    machine = next;
    if (next.state === previous.state || disposed) {
      return;
    }
    for (const listener of [...listeners]) {
      try {
        listener(next.state);
      } catch {
        // Subscribers are outside the controller's trust boundary.
      }
    }
  }

  function current(generation: number): boolean {
    return !disposed && machine.generation === generation;
  }

  function operationOptions(signal: AbortSignal, timeoutMs = operationTimeoutMs): OperationOptions {
    return Object.freeze({
      signal,
      timeoutMs,
    });
  }

  function clearAssociation(): void {
    association = undefined;
  }

  function deadlineBounded<T>(
    operation: Promise<T>,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<T> {
    const deadline = new AbortController();
    const timeout = options.sleep(timeoutMs, deadline.signal).then(() => {
      throw OPERATION_DEADLINE_EXCEEDED;
    });
    return Promise.race([abortable(operation, signal), timeout]).finally(() => {
      deadline.abort();
    });
  }

  function commitAssociation(
    generation: number,
    selectedClient: CaveConnectionClient,
    caveInstanceId: string,
  ): boolean {
    if (!current(generation)) {
      return false;
    }
    association = Object.freeze({
      client: selectedClient,
      caveInstanceId,
    });
    return true;
  }

  function recordDiagnostic(
    code: DiagnosticCode,
    retryable: boolean,
    category: DiagnosticCategory,
  ): string {
    diagnosticSequence += 1;
    const id = `sdk-${diagnosticSequence}`;
    diagnostics.push(
      Object.freeze({
        id,
        code,
        retryable,
        category,
      }),
    );
    if (diagnostics.length > MAX_DIAGNOSTICS) {
      diagnostics.splice(0, diagnostics.length - MAX_DIAGNOSTICS);
    }
    return id;
  }

  function setHealthy(generation: number, caveHealth: CaveHealth): void {
    if (!current(generation)) {
      return;
    }
    publish({
      type: 'healthy',
      generation,
      caveInstanceId: caveHealth.instanceId,
      lastHealthyAt: options.now(),
    });
  }

  function setState(
    generation: number,
    state: SdkConnectionState,
    active: ActiveOperation = 'none',
  ): void {
    if (!current(generation)) {
      return;
    }
    publish({
      type: 'state',
      generation,
      active,
      state: freezeState(state),
    });
  }

  function setFailure(
    generation: number,
    failure: SafeFailure,
    category: DiagnosticCategory,
  ): void {
    if (!current(generation)) {
      return;
    }

    if (category !== 'launch') {
      clearAssociation();
    }
    const diagnosticId = recordDiagnostic(failure.code, failure.retryable, category);
    if (failure.incompatible) {
      setState(generation, { state: 'incompatible', diagnosticId });
      return;
    }
    if (isOfflineFailure(failure)) {
      setState(generation, {
        state: 'offline',
        lastHealthyAt: machine.lastHealthyAt,
        diagnosticId,
      });
      return;
    }
    setState(generation, {
      state: 'error',
      code: failure.code,
      diagnosticId,
    });
  }

  async function setCredentialStatus(
    generation: number,
    selectedClient: CaveConnectionClient,
    caveHealth: CaveHealth,
    credentialStatus: CaveCredentialStatus,
    signal: AbortSignal,
    pairingRequiredReason?: PairingRequiredReason,
  ): Promise<void> {
    if (!current(generation)) {
      return;
    }

    if (
      credentialStatus.status !== 'missing' &&
      credentialStatus.status !== 'disconnected' &&
      credentialStatus.health.instanceId !== caveHealth.instanceId
    ) {
      setFailure(
        generation,
        Object.freeze({
          code: 'invalid_response',
          retryable: false,
          incompatible: false,
        }),
        'credential',
      );
      return;
    }

    switch (credentialStatus.status) {
      case 'missing':
        if (commitAssociation(generation, selectedClient, caveHealth.instanceId)) {
          setState(generation, {
            state: 'pairing_required',
            caveInstanceId: caveHealth.instanceId,
            ...(pairingRequiredReason === undefined ? {} : { reason: pairingRequiredReason }),
          });
        }
        return;
      case 'disconnected':
        setFailure(
          generation,
          Object.freeze({
            code:
              credentialStatus.reason === 'credential_update_in_progress'
                ? 'credential_update_in_progress'
                : 'credential_unavailable',
            retryable: credentialStatus.reason === 'credential_update_in_progress',
            incompatible: false,
          }),
          'credential',
        );
        return;
      case 'revoked':
        setHealthy(generation, credentialStatus.health);
        if (!commitAssociation(generation, selectedClient, credentialStatus.health.instanceId)) {
          return;
        }
        setState(generation, {
          state: 'revoked',
          diagnosticId: recordDiagnostic('unauthorized', false, 'credential'),
        });
        return;
      case 'valid':
        setHealthy(generation, credentialStatus.health);
        switch (credentialStatus.access) {
          case 'chat:read':
            if (
              !commitAssociation(generation, selectedClient, credentialStatus.health.instanceId)
            ) {
              return;
            }
            try {
              await deadlineBounded(
                options.host.covenHealth(operationOptions(signal)),
                operationTimeoutMs,
                signal,
              );
            } catch (error) {
              if (!current(generation)) {
                return;
              }
              const failure = nativeFailureFrom(error);
              recordDiagnostic(failure.code, failure.retryable, 'coven');
              setState(generation, {
                state: 'ready',
                caveInstanceId: credentialStatus.health.instanceId,
                covenAvailable: false,
              });
              return;
            }
            if (!current(generation)) {
              return;
            }
            setState(generation, {
              state: 'ready',
              caveInstanceId: credentialStatus.health.instanceId,
              covenAvailable: true,
            });
            return;
          case 'scope_denied':
            if (
              !commitAssociation(generation, selectedClient, credentialStatus.health.instanceId)
            ) {
              return;
            }
            setState(generation, {
              state: 'error',
              code: 'scope_denied',
              diagnosticId: recordDiagnostic('scope_denied', false, 'credential'),
            });
            return;
          case 'rate_limited':
            setFailure(
              generation,
              Object.freeze({
                code: credentialStatus.access,
                retryable: credentialStatus.access === 'rate_limited',
                incompatible: false,
              }),
              'credential',
            );
            return;
          case 'service_unavailable':
            setFailure(
              generation,
              Object.freeze({
                code: 'service_unavailable',
                retryable: true,
                incompatible: false,
              }),
              'credential',
            );
            return;
        }
    }
  }

  async function confirmConnection(
    generation: number,
    selectedClient: CaveConnectionClient,
    signal: AbortSignal,
    pairingRequiredReason?: PairingRequiredReason,
  ): Promise<void> {
    let caveHealth: CaveHealth;
    try {
      caveHealth = await abortable(selectedClient.health(operationOptions(signal)), signal);
    } catch (error) {
      setFailure(generation, failureFrom(error), 'health');
      return;
    }
    setHealthy(generation, caveHealth);
    if (!current(generation)) {
      return;
    }

    let credentialStatus: CaveCredentialStatus;
    try {
      credentialStatus = await abortable(
        selectedClient.credentialStatus(operationOptions(signal)),
        signal,
      );
    } catch (error) {
      setFailure(generation, failureFrom(error), 'credential');
      return;
    }
    await setCredentialStatus(
      generation,
      selectedClient,
      caveHealth,
      credentialStatus,
      signal,
      pairingRequiredReason,
    );
  }

  async function discover(
    generation: number,
    signal: AbortSignal,
    pairingRequiredReason?: PairingRequiredReason,
  ): Promise<void> {
    let discovered: Readonly<{ client: CaveClient }>;
    try {
      discovered = await deadlineBounded(
        options.host.discover(operationOptions(signal)),
        operationTimeoutMs,
        signal,
      );
    } catch (error) {
      setFailure(generation, failureFrom(error), 'discovery');
      return;
    }
    if (!current(generation)) {
      return;
    }

    await confirmConnection(generation, discovered.client, signal, pairingRequiredReason);
  }

  async function completePairing(
    generation: number,
    pairing: CavePairingSessionPort,
    selectedClient: CaveConnectionClient,
    signal: AbortSignal,
  ): Promise<void> {
    let polls = 0;
    while (current(generation)) {
      if (options.now() >= pairing.expiresAt) {
        await resetPairingAndReconcile('expired');
        return;
      }
      if (polls >= maxPairingPolls) {
        setFailure(
          generation,
          Object.freeze({
            code: 'poll_limit',
            retryable: true,
            incompatible: false,
          }),
          'pairing',
        );
        return;
      }

      let pairingStatus: Awaited<ReturnType<CavePairingSessionPort['poll']>>;
      const pollTimeoutMs = Math.min(operationTimeoutMs, pairing.expiresAt - options.now());
      try {
        pairingStatus = await deadlineBounded(
          pairing.poll(operationOptions(signal, pollTimeoutMs)),
          pollTimeoutMs,
          signal,
        );
      } catch (error) {
        if (current(generation) && isPairingExpired(error)) {
          await resetPairingAndReconcile('expired');
          return;
        }
        if (
          current(generation) &&
          (isPairingTimeout(error) || options.now() >= pairing.expiresAt)
        ) {
          await resetPairingAndReconcile(
            options.now() >= pairing.expiresAt ? 'expired' : undefined,
          );
          return;
        }
        setFailure(generation, failureFrom(error), 'pairing');
        return;
      }
      polls += 1;
      if (!current(generation)) {
        return;
      }

      switch (pairingStatus.status) {
        case 'approved': {
          if (options.now() >= pairing.expiresAt) {
            await resetPairingAndReconcile('expired');
            return;
          }
          const exchangeTimeoutMs = Math.min(operationTimeoutMs, pairing.expiresAt - options.now());
          try {
            await deadlineBounded(
              pairing.exchange(operationOptions(signal, exchangeTimeoutMs)),
              exchangeTimeoutMs,
              signal,
            );
          } catch (error) {
            if (current(generation) && isPairingExpired(error)) {
              await resetPairingAndReconcile('expired');
              return;
            }
            if (
              current(generation) &&
              (isPairingTimeout(error) || options.now() >= pairing.expiresAt)
            ) {
              await resetPairingAndReconcile(
                options.now() >= pairing.expiresAt ? 'expired' : undefined,
              );
              return;
            }
            setFailure(generation, failureFrom(error), 'pairing');
            return;
          }
          if (!current(generation)) {
            return;
          }
          await confirmConnection(generation, selectedClient, signal);
          return;
        }
        case 'denied':
          setFailure(
            generation,
            Object.freeze({
              code: 'pairing_denied',
              retryable: false,
              incompatible: false,
            }),
            'pairing',
          );
          return;
        case 'expired':
          await resetPairingAndReconcile('expired');
          return;
        case 'pending': {
          const remaining = pairing.expiresAt - options.now();
          if (remaining <= 0) {
            await resetPairingAndReconcile('expired');
            return;
          }
          try {
            await abortable(
              options.sleep(
                Math.min(options.pollIntervalMs, operationTimeoutMs, remaining),
                signal,
              ),
              signal,
            );
          } catch (error) {
            if (current(generation) && options.now() >= pairing.expiresAt) {
              await resetPairingAndReconcile('expired');
              return;
            }
            setFailure(generation, failureFrom(error), 'pairing');
            return;
          }
          break;
        }
      }
    }
  }

  function activate(
    operation: Exclude<ActiveOperation, 'none'>,
    state?: SdkConnectionState,
  ): ConnectionAttempt {
    activeAbortController?.abort();
    const controller = new AbortController();
    activeAbortController = controller;
    const generation = machine.generation + 1;
    publish({
      type: 'activate',
      generation,
      active: operation,
      ...(state === undefined ? {} : { state: freezeState(state) }),
    });
    return Object.freeze({
      generation,
      signal: controller.signal,
    });
  }

  function holdActivePromise(generation: number, task: Promise<void>): Promise<void> {
    activePromise = task.finally(() => {
      if (machine.generation === generation) {
        activePromise = undefined;
        activeAbortController = undefined;
      }
    });
    return activePromise;
  }

  function resetPairingAndReconcile(reason?: PairingRequiredReason): Promise<void> {
    if (pairingResetPromise !== undefined) {
      return pairingResetPromise;
    }
    if (disposed || machine.active !== 'pairing') {
      return Promise.resolve();
    }

    activeAbortController?.abort();
    clearAssociation();
    const attempt = activate('pairing', { state: 'discovering' });
    const task = (async () => {
      try {
        await deadlineBounded(options.host.resetPairing(), operationTimeoutMs, attempt.signal);
      } catch {
        // A fresh owner-checked discovery is authoritative after a reset failure.
      }
      if (!current(attempt.generation)) {
        return;
      }
      await discover(attempt.generation, attempt.signal, reason);
    })();
    const reset = holdActivePromise(attempt.generation, task);
    pairingResetPromise = reset;
    void reset.then(
      () => {
        if (pairingResetPromise === reset) {
          pairingResetPromise = undefined;
        }
      },
      () => {
        if (pairingResetPromise === reset) {
          pairingResetPromise = undefined;
        }
      },
    );
    return reset;
  }

  function resetPairingAfterDispose(): Promise<void> {
    if (disposeCleanupPromise !== undefined) {
      return disposeCleanupPromise;
    }
    const existingReset = pairingResetPromise;
    const signal = new AbortController().signal;
    disposeCleanupPromise = (async () => {
      if (existingReset !== undefined) {
        await existingReset;
      } else {
        try {
          await deadlineBounded(options.host.resetPairing(), operationTimeoutMs, signal);
        } catch {
          // The owner-checked discovery below invalidates any still-live authority.
        }
      }
      try {
        await deadlineBounded(
          options.host.discover(operationOptions(signal)),
          operationTimeoutMs,
          signal,
        );
      } catch {
        // Disposal intentionally has no public failure state.
      }
    })();
    return disposeCleanupPromise;
  }

  function startDiscovery(force: boolean): Promise<void> {
    if (disposed) {
      return Promise.resolve();
    }
    if (!force && machine.active !== 'none') {
      return activePromise ?? Promise.resolve();
    }
    if (
      !force &&
      machine.state.state !== 'idle' &&
      machine.state.state !== 'offline' &&
      machine.state.state !== 'error' &&
      machine.state.state !== 'incompatible' &&
      machine.state.state !== 'revoked'
    ) {
      return Promise.resolve();
    }

    clearAssociation();
    const attempt = activate('discovering', { state: 'discovering' });
    return holdActivePromise(attempt.generation, discover(attempt.generation, attempt.signal));
  }

  function start(): Promise<void> {
    return startDiscovery(false);
  }

  function retry(): Promise<void> {
    if (machine.active === 'pairing') {
      return activePromise ?? Promise.resolve();
    }
    return startDiscovery(true);
  }

  function launch(): Promise<void> {
    if (disposed) {
      return Promise.resolve();
    }
    if (machine.active !== 'none') {
      return activePromise ?? Promise.resolve();
    }

    const attempt = activate('launching');
    const task = (async () => {
      try {
        await deadlineBounded(options.host.launch(), operationTimeoutMs, attempt.signal);
      } catch (error) {
        setFailure(attempt.generation, failureFrom(error), 'launch');
        return;
      }
      if (!current(attempt.generation)) {
        return;
      }
      setState(attempt.generation, machine.state);
    })();
    return holdActivePromise(attempt.generation, task);
  }

  function beginPairing(): Promise<void> {
    if (disposed) {
      return Promise.resolve();
    }
    if (machine.active === 'pairing') {
      return activePromise ?? Promise.resolve();
    }
    if (
      machine.active !== 'none' ||
      machine.state.state !== 'pairing_required' ||
      association === undefined ||
      association.caveInstanceId !== machine.state.caveInstanceId
    ) {
      return Promise.resolve();
    }

    const selectedClient = association.client;
    const attempt = activate('pairing');
    const task = (async () => {
      let pairing: CavePairingSessionPort;
      try {
        pairing = await deadlineBounded(
          selectedClient.createPairing(
            {
              appName: options.pairingIdentity.appName,
              installationId: options.pairingIdentity.installationId,
              scopes: ['chat:read'],
            },
            operationOptions(attempt.signal),
          ),
          operationTimeoutMs,
          attempt.signal,
        );
      } catch (error) {
        if (isPairingTimeout(error)) {
          await resetPairingAndReconcile();
          return;
        }
        setFailure(attempt.generation, failureFrom(error), 'pairing');
        return;
      }
      if (!current(attempt.generation)) {
        return;
      }

      setState(
        attempt.generation,
        {
          state: 'pairing',
          requestId: pairing.requestId,
          expiresAt: pairing.expiresAt,
        },
        'pairing',
      );
      await completePairing(attempt.generation, pairing, selectedClient, attempt.signal);
    })();
    return holdActivePromise(attempt.generation, task);
  }

  function cancelPairing(): Promise<void> {
    return resetPairingAndReconcile('cancelled');
  }

  function forgetCredential(): Promise<void> {
    if (
      disposed ||
      machine.active !== 'none' ||
      !(
        machine.state.state === 'ready' ||
        machine.state.state === 'revoked' ||
        (machine.state.state === 'error' && machine.state.code === 'scope_denied')
      ) ||
      association === undefined ||
      (machine.state.state === 'ready' &&
        association.caveInstanceId !== machine.state.caveInstanceId)
    ) {
      return Promise.resolve();
    }

    const selectedClient = association.client;
    const caveInstanceId = association.caveInstanceId;
    const attempt = activate('forgetting', { state: 'discovering' });
    const task = (async () => {
      try {
        await deadlineBounded(
          selectedClient.forgetCredential(operationOptions(attempt.signal)),
          operationTimeoutMs,
          attempt.signal,
        );
      } catch (error) {
        setFailure(attempt.generation, failureFrom(error), 'credential_management');
        return;
      }
      if (!current(attempt.generation)) {
        return;
      }
      setState(attempt.generation, {
        state: 'pairing_required',
        caveInstanceId,
      });
    })();
    return holdActivePromise(attempt.generation, task);
  }

  function getState(): SdkConnectionState {
    return machine.state;
  }

  function getReadyClient(): CaveReadClient | null {
    if (machine.active !== 'none' || machine.state.state !== 'ready' || association === undefined) {
      return null;
    }
    return association.client;
  }

  function subscribe(listener: SdkConnectionListener): () => void {
    if (disposed) {
      return () => undefined;
    }
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function dispose(): void {
    if (disposed) {
      return;
    }
    if (machine.active === 'pairing' || pairingResetPromise !== undefined) {
      if (pairingResetPromise === undefined) {
        activeAbortController?.abort();
      }
      void resetPairingAfterDispose();
    } else {
      activeAbortController?.abort();
    }
    activeAbortController = undefined;
    disposed = true;
    clearAssociation();
    publish({
      type: 'dispose',
      generation: machine.generation + 1,
    });
    listeners.clear();
  }

  return Object.freeze({
    getState,
    getReadyClient,
    subscribe,
    start,
    retry,
    launch,
    beginPairing,
    cancelPairing,
    forgetCredential,
    dispose,
  });
}
