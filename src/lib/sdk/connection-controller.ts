import {
  type CaveClient,
  type CaveCredentialStatus,
  type CaveHealth,
  type CavePairingSession,
  isCaveClientError,
} from '@opencoven/cave-client/managed';

import type { CaveConnectionHost } from './connection-host';

export type SdkConnectionState =
  | Readonly<{ state: 'idle' }>
  | Readonly<{ state: 'discovering' }>
  | Readonly<{ state: 'incompatible'; diagnosticId: string }>
  | Readonly<{ state: 'pairing_required'; caveInstanceId: string }>
  | Readonly<{ state: 'pairing'; requestId: string; expiresAt: number }>
  | Readonly<{ state: 'ready'; caveInstanceId: string; covenAvailable: boolean }>
  | Readonly<{ state: 'revoked'; diagnosticId: string }>
  | Readonly<{ state: 'offline'; lastHealthyAt: number | null; diagnosticId: string }>
  | Readonly<{ state: 'error'; code: string; diagnosticId: string }>;

type CavePairingSessionPort = Pick<
  CavePairingSession,
  'exchange' | 'expiresAt' | 'poll' | 'requestId'
>;

type CaveConnectionClient = Pick<
  CaveClient,
  'createPairing' | 'credentialStatus' | 'forgetCredential' | 'health'
>;

export type CaveConnectionHostPort = Pick<CaveConnectionHost, 'discover' | 'launch'>;

export type CavePairingIdentity = Readonly<{
  appName: string;
  installationId: string;
}>;

export type CaveConnectionControllerOptions = Readonly<{
  host: CaveConnectionHostPort;
  pairingIdentity: CavePairingIdentity;
  now: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  pollIntervalMs: number;
  maxPairingPolls?: number;
}>;

export type SdkConnectionListener = (state: SdkConnectionState) => void;

export type CaveConnectionController = Readonly<{
  getState: () => SdkConnectionState;
  subscribe: (listener: SdkConnectionListener) => () => void;
  start: () => Promise<void>;
  retry: () => Promise<void>;
  launch: () => Promise<void>;
  beginPairing: () => Promise<void>;
  cancelPairing: () => void;
  forgetCredential: () => Promise<void>;
  dispose: () => void;
}>;

type ActiveOperation = 'none' | 'discovering' | 'pairing' | 'forgetting' | 'launching';

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
  | 'scope_denied'
  | 'service_unavailable'
  | 'timeout'
  | 'unauthorized'
  | 'unsupported_operation';

type DiagnosticCategory =
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
    case 'conflict':
    case 'credential_update_in_progress':
    case 'incompatible_version':
    case 'invalid_response':
    case 'not_found':
    case 'pairing_denied':
    case 'pairing_expired':
    case 'rate_limited':
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

function isOfflineFailure(failure: SafeFailure, category: DiagnosticCategory): boolean {
  return (
    failure.code === 'not_found' ||
    (failure.code === 'rate_limited' && category !== 'pairing') ||
    failure.code === 'service_unavailable' ||
    failure.code === 'timeout' ||
    (failure.retryable &&
      failure.code !== 'rate_limited' &&
      failure.code !== 'pairing_denied' &&
      failure.code !== 'pairing_expired')
  );
}

function validPollInterval(pollIntervalMs: number): boolean {
  return Number.isSafeInteger(pollIntervalMs) && pollIntervalMs > 0;
}

function validPollLimit(maxPairingPolls: number): boolean {
  return Number.isSafeInteger(maxPairingPolls) && maxPairingPolls > 0;
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

  let machine = initialMachine();
  let client: CaveConnectionClient | undefined;
  let activePromise: Promise<void> | undefined;
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
    for (const listener of listeners) {
      listener(next.state);
    }
  }

  function current(generation: number): boolean {
    return !disposed && machine.generation === generation;
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

    const diagnosticId = recordDiagnostic(failure.code, failure.retryable, category);
    if (failure.incompatible) {
      setState(generation, { state: 'incompatible', diagnosticId });
      return;
    }
    if (isOfflineFailure(failure, category)) {
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

  function setCredentialStatus(generation: number, credentialStatus: CaveCredentialStatus): void {
    if (!current(generation)) {
      return;
    }

    switch (credentialStatus.status) {
      case 'missing':
        if (machine.caveInstanceId !== null) {
          setState(generation, {
            state: 'pairing_required',
            caveInstanceId: machine.caveInstanceId,
          });
        } else {
          setFailure(
            generation,
            Object.freeze({
              code: 'credential_unavailable',
              retryable: false,
              incompatible: false,
            }),
            'credential',
          );
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
        setState(generation, {
          state: 'revoked',
          diagnosticId: recordDiagnostic('unauthorized', false, 'credential'),
        });
        return;
      case 'valid':
        setHealthy(generation, credentialStatus.health);
        switch (credentialStatus.access) {
          case 'chat:read':
            setState(generation, {
              state: 'ready',
              caveInstanceId: credentialStatus.health.instanceId,
              covenAvailable: false,
            });
            return;
          case 'scope_denied':
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
  ): Promise<void> {
    let caveHealth: CaveHealth;
    try {
      caveHealth = await selectedClient.health();
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
      credentialStatus = await selectedClient.credentialStatus();
    } catch (error) {
      setFailure(generation, failureFrom(error), 'credential');
      return;
    }
    setCredentialStatus(generation, credentialStatus);
  }

  async function discover(generation: number): Promise<void> {
    let discovered: Readonly<{ client: CaveConnectionClient }>;
    try {
      discovered = await options.host.discover();
    } catch (error) {
      setFailure(generation, failureFrom(error), 'discovery');
      return;
    }
    if (!current(generation)) {
      return;
    }

    client = discovered.client;
    await confirmConnection(generation, discovered.client);
  }

  async function completePairing(
    generation: number,
    pairing: CavePairingSessionPort,
    selectedClient: CaveConnectionClient,
  ): Promise<void> {
    let polls = 0;
    while (current(generation)) {
      if (options.now() >= pairing.expiresAt) {
        setFailure(
          generation,
          Object.freeze({
            code: 'pairing_expired',
            retryable: false,
            incompatible: false,
          }),
          'pairing',
        );
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
      try {
        pairingStatus = await pairing.poll();
      } catch (error) {
        setFailure(generation, failureFrom(error), 'pairing');
        return;
      }
      polls += 1;
      if (!current(generation)) {
        return;
      }

      switch (pairingStatus.status) {
        case 'approved':
          if (options.now() >= pairing.expiresAt) {
            setFailure(
              generation,
              Object.freeze({
                code: 'pairing_expired',
                retryable: false,
                incompatible: false,
              }),
              'pairing',
            );
            return;
          }
          try {
            await pairing.exchange();
          } catch (error) {
            setFailure(generation, failureFrom(error), 'pairing');
            return;
          }
          if (!current(generation)) {
            return;
          }
          await confirmConnection(generation, selectedClient);
          return;
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
          setFailure(
            generation,
            Object.freeze({
              code: 'pairing_expired',
              retryable: false,
              incompatible: false,
            }),
            'pairing',
          );
          return;
        case 'pending': {
          const remaining = pairing.expiresAt - options.now();
          if (remaining <= 0) {
            setFailure(
              generation,
              Object.freeze({
                code: 'pairing_expired',
                retryable: false,
                incompatible: false,
              }),
              'pairing',
            );
            return;
          }
          try {
            await options.sleep(Math.min(options.pollIntervalMs, remaining));
          } catch (error) {
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
  ): number {
    const generation = machine.generation + 1;
    publish({
      type: 'activate',
      generation,
      active: operation,
      ...(state === undefined ? {} : { state: freezeState(state) }),
    });
    return generation;
  }

  function holdActivePromise(generation: number, task: Promise<void>): Promise<void> {
    activePromise = task.finally(() => {
      if (machine.generation === generation) {
        activePromise = undefined;
      }
    });
    return activePromise;
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

    client = undefined;
    const generation = activate('discovering', { state: 'discovering' });
    return holdActivePromise(generation, discover(generation));
  }

  function start(): Promise<void> {
    return startDiscovery(false);
  }

  function retry(): Promise<void> {
    return startDiscovery(true);
  }

  function launch(): Promise<void> {
    if (disposed) {
      return Promise.resolve();
    }
    if (machine.active !== 'none') {
      return activePromise ?? Promise.resolve();
    }

    const generation = activate('launching');
    const task = (async () => {
      try {
        await options.host.launch();
      } catch (error) {
        setFailure(generation, failureFrom(error), 'launch');
        return;
      }
      if (!current(generation)) {
        return;
      }
      setState(generation, machine.state);
    })();
    return holdActivePromise(generation, task);
  }

  function beginPairing(): Promise<void> {
    if (disposed) {
      return Promise.resolve();
    }
    if (machine.active === 'pairing') {
      return activePromise ?? Promise.resolve();
    }
    if (machine.active !== 'none' || client === undefined || machine.caveInstanceId === null) {
      return Promise.resolve();
    }

    const selectedClient = client;
    const generation = activate('pairing');
    const task = (async () => {
      let pairing: CavePairingSessionPort;
      try {
        pairing = await selectedClient.createPairing({
          appName: options.pairingIdentity.appName,
          installationId: options.pairingIdentity.installationId,
          scopes: ['chat:read'],
        });
      } catch (error) {
        setFailure(generation, failureFrom(error), 'pairing');
        return;
      }
      if (!current(generation)) {
        return;
      }

      setState(
        generation,
        {
          state: 'pairing',
          requestId: pairing.requestId,
          expiresAt: pairing.expiresAt,
        },
        'pairing',
      );
      await completePairing(generation, pairing, selectedClient);
    })();
    return holdActivePromise(generation, task);
  }

  function cancelPairing(): void {
    if (disposed || machine.active !== 'pairing' || machine.caveInstanceId === null) {
      return;
    }
    const generation = activate('pairing', {
      state: 'pairing_required',
      caveInstanceId: machine.caveInstanceId,
    });
    setState(generation, machine.state);
  }

  function forgetCredential(): Promise<void> {
    if (
      disposed ||
      machine.active !== 'none' ||
      client === undefined ||
      machine.caveInstanceId === null
    ) {
      return Promise.resolve();
    }

    const selectedClient = client;
    const caveInstanceId = machine.caveInstanceId;
    const generation = activate('forgetting');
    const task = (async () => {
      try {
        await selectedClient.forgetCredential();
      } catch (error) {
        setFailure(generation, failureFrom(error), 'credential_management');
        return;
      }
      if (!current(generation)) {
        return;
      }
      setState(generation, {
        state: 'pairing_required',
        caveInstanceId,
      });
    })();
    return holdActivePromise(generation, task);
  }

  function getState(): SdkConnectionState {
    return machine.state;
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
    disposed = true;
    client = undefined;
    publish({
      type: 'dispose',
      generation: machine.generation + 1,
    });
    listeners.clear();
  }

  return Object.freeze({
    getState,
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
