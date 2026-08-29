import {
  type AuthorityReference,
  type NativeBoundary,
  NativeBoundaryError,
  type NativeConnectionEvent,
} from './native-boundary';

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

export interface ConnectionController {
  getState(): SdkConnectionState;
  subscribe(listener: () => void): () => void;
  activate(): () => void;
  bootstrap(): Promise<void>;
  connect(): Promise<void>;
  beginPairing(): Promise<void>;
  pollApproval(): Promise<void>;
  canCompletePairing(): boolean;
  completePairing(): Promise<void>;
  canRetry(): boolean;
  retry(): Promise<void>;
  forgetCredential(): Promise<void>;
  reconnect(): Promise<void>;
  getAuthority(): AuthorityReference | null;
  markAuthorityFailure(error: unknown): void;
  destroy(): Promise<void>;
}

type ControllerOptions = Readonly<{
  now?: () => number;
  requestId?: () => string;
}>;

type PairingContext = {
  handle: string;
  requestId: string;
  expiresAt: number;
  approved: boolean;
};

const BROWSER_UNAVAILABLE_DIAGNOSTIC = 'browser-unavailable';
const PAIRING_STATUS_DIAGNOSTIC = 'pairing-status';
const INSTANCE_CHANGED_DIAGNOSTIC = 'instance-changed';

function defaultRequestId(): string {
  return `webview:${crypto.randomUUID()}`;
}

function sameAuthority(left: AuthorityReference, right: AuthorityReference): boolean {
  return left.handle === right.handle && left.generation === right.generation;
}

function diagnostic(error: unknown): string {
  return error instanceof NativeBoundaryError ? error.diagnosticId : 'local-diagnostic';
}

function code(error: unknown): string {
  return error instanceof NativeBoundaryError ? error.code : 'service_unavailable';
}

function terminalPairingError(error: unknown): boolean {
  return (
    error instanceof NativeBoundaryError &&
    (error.code === 'pairing_denied' ||
      error.code === 'pairing_expired' ||
      error.code === 'conflict' ||
      error.code === 'reconcile_required')
  );
}

class DefaultConnectionController implements ConnectionController {
  readonly #boundary: NativeBoundary;
  readonly #now: () => number;
  readonly #requestId: () => string;
  readonly #listeners = new Set<() => void>();
  readonly #mutationOperations = new Map<string, Promise<void>>();
  #state: SdkConnectionState = Object.freeze({ state: 'idle' });
  #authority: AuthorityReference | null = null;
  #pairing: PairingContext | null = null;
  #instanceId: string | null = null;
  #lastHealthyAt: number | null = null;
  #generation = 0;
  #inFlightConnect: Promise<void> | null = null;
  #retryOperation: (() => Promise<void>) | null = null;
  #activationCount = 0;
  #eventSubscription: Promise<() => void> | null = null;

  constructor(boundary: NativeBoundary, options: ControllerOptions) {
    this.#boundary = boundary;
    this.#now = options.now ?? Date.now;
    this.#requestId = options.requestId ?? defaultRequestId;
  }

  getState(): SdkConnectionState {
    return this.#state;
  }

  getAuthority(): AuthorityReference | null {
    return this.#authority;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  activate(): () => void {
    this.#activationCount += 1;
    if (this.#eventSubscription === null && this.#boundary.isAvailable()) {
      this.#eventSubscription = this.#boundary.listenConnectionEvents((event) => {
        if (this.#activationCount > 0) {
          this.#handleEvent(event);
        }
      });
    }
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.#activationCount -= 1;
      queueMicrotask(() => {
        if (this.#activationCount === 0 && this.#eventSubscription !== null) {
          const subscription = this.#eventSubscription;
          this.#eventSubscription = null;
          void subscription.then((unlisten) => unlisten()).catch(() => undefined);
        }
      });
    };
  }

  bootstrap(): Promise<void> {
    return this.connect();
  }

  connect(): Promise<void> {
    if (this.#inFlightConnect !== null) {
      return this.#inFlightConnect;
    }
    const operation = this.#connect(false).finally(() => {
      if (this.#inFlightConnect === operation) {
        this.#inFlightConnect = null;
      }
    });
    this.#inFlightConnect = operation;
    return operation;
  }

  async #connect(reconnecting: boolean): Promise<void> {
    if (!this.#boundary.isAvailable()) {
      this.#setState({
        state: 'offline',
        lastHealthyAt: this.#lastHealthyAt,
        diagnosticId: BROWSER_UNAVAILABLE_DIAGNOSTIC,
      });
      return;
    }
    const generation = ++this.#generation;
    this.#retryOperation = null;
    this.#pairing = null;
    this.#setState({ state: 'discovering' });
    try {
      const authority = await this.#boundary.discover();
      if (!this.#isCurrent(generation)) {
        return;
      }
      this.#authority = authority;
      const health = await this.#boundary.health(authority, this.#requestId());
      if (!this.#isCurrent(generation) || !this.#authorityIsCurrent(authority)) {
        return;
      }
      if (reconnecting && this.#instanceId !== null && health.instanceId !== this.#instanceId) {
        this.#instanceId = health.instanceId;
        this.#setState({
          state: 'error',
          code: 'wrong_instance',
          diagnosticId: INSTANCE_CHANGED_DIAGNOSTIC,
        });
        return;
      }
      this.#instanceId = health.instanceId;
      this.#lastHealthyAt = this.#now();
      const credentialState = await this.#boundary.credentialState(authority, this.#requestId());
      if (!this.#isCurrent(generation) || !this.#authorityIsCurrent(authority)) {
        return;
      }
      if (health.pairingRequired || credentialState === 'missing') {
        this.#setState({ state: 'pairing_required', caveInstanceId: health.instanceId });
        return;
      }
      if (credentialState === 'invalid') {
        this.#setState({
          state: 'error',
          code: 'wrong_instance',
          diagnosticId: INSTANCE_CHANGED_DIAGNOSTIC,
        });
        return;
      }
      if (credentialState === 'update_in_progress') {
        const retry = () => this.#confirmReady(authority, generation);
        this.#retryOperation = retry;
        this.#setState({
          state: 'error',
          code: 'credential_update_in_progress',
          diagnosticId: 'credential-update',
        });
        return;
      }
      this.#setState({
        state: 'ready',
        caveInstanceId: health.instanceId,
        covenAvailable: false,
      });
    } catch (error) {
      if (this.#isCurrent(generation)) {
        this.#setFailure(error);
      }
    }
  }

  beginPairing(): Promise<void> {
    return this.#runMutation('pairing-create', () => this.#beginPairing());
  }

  async #beginPairing(): Promise<void> {
    const authority = this.#requireAuthority();
    if (this.#state.state !== 'pairing_required') {
      return;
    }
    const generation = this.#generation;
    this.#retryOperation = null;
    try {
      const identity = await this.#boundary.installationIdentity();
      if (!this.#isCurrent(generation) || !this.#authorityIsCurrent(authority)) {
        return;
      }
      const pairing = await this.#boundary.pairingCreate(authority, this.#requestId(), {
        appName: 'OpenCoven Chat',
        installationId: identity.installationId,
        scopes: ['chat:read'],
      });
      if (!this.#isCurrent(generation) || !this.#authorityIsCurrent(authority)) {
        return;
      }
      this.#pairing = {
        handle: pairing.handle,
        requestId: pairing.requestId,
        expiresAt: pairing.expiresAt,
        approved: false,
      };
      this.#setState({
        state: 'pairing',
        requestId: pairing.requestId,
        expiresAt: pairing.expiresAt,
      });
    } catch (error) {
      if (this.#isCurrent(generation)) {
        this.#setFailure(error);
      }
    }
  }

  pollApproval(): Promise<void> {
    return this.#runMutation('pairing-poll', () => this.#pollApproval());
  }

  async #pollApproval(): Promise<void> {
    const authority = this.#requireAuthority();
    const pairing = this.#pairing;
    if (this.#state.state !== 'pairing' || pairing === null) {
      return;
    }
    const generation = this.#generation;
    if (pairing.expiresAt <= this.#now()) {
      this.#pairing = null;
      this.#retryOperation = null;
      this.#setState({
        state: 'error',
        code: 'pairing_expired',
        diagnosticId: PAIRING_STATUS_DIAGNOSTIC,
      });
      return;
    }
    try {
      const status = await this.#boundary.pairingPoll(authority, this.#requestId(), pairing.handle);
      if (
        !this.#isCurrent(generation) ||
        !this.#authorityIsCurrent(authority) ||
        this.#pairing !== pairing
      ) {
        return;
      }
      if (status.id !== pairing.requestId) {
        this.#pairing = null;
        this.#retryOperation = null;
        this.#setState({
          state: 'error',
          code: 'reconcile_required',
          diagnosticId: 'pairing-request-mismatch',
        });
        return;
      }
      pairing.expiresAt = status.expiresAt;
      if (status.status === 'approved') {
        pairing.approved = true;
        this.#setState({
          state: 'pairing',
          requestId: pairing.requestId,
          expiresAt: pairing.expiresAt,
        });
        return;
      }
      if (status.status === 'denied' || status.status === 'expired') {
        this.#pairing = null;
        this.#retryOperation = null;
        this.#setState({
          state: 'error',
          code: status.status === 'denied' ? 'pairing_denied' : 'pairing_expired',
          diagnosticId: PAIRING_STATUS_DIAGNOSTIC,
        });
      }
    } catch (error) {
      if (this.#isCurrent(generation)) {
        if (
          terminalPairingError(error) &&
          this.#authorityIsCurrent(authority) &&
          this.#pairing === pairing
        ) {
          this.#pairing = null;
          this.#retryOperation = null;
        }
        this.#setFailure(error);
      }
    }
  }

  canCompletePairing(): boolean {
    return this.#state.state === 'pairing' && this.#pairing?.approved === true;
  }

  completePairing(): Promise<void> {
    return this.#runMutation('pairing-complete', () => this.#completePairing());
  }

  async #completePairing(): Promise<void> {
    const authority = this.#requireAuthority();
    const pairing = this.#pairing;
    if (pairing === null || !pairing.approved) {
      return;
    }
    const generation = this.#generation;
    this.#retryOperation = null;
    const confirm = async () => {
      try {
        await this.#confirmReady(authority, generation);
        if (!this.#isCurrent(generation) || !this.#authorityIsCurrent(authority)) {
          return;
        }
        this.#retryOperation = null;
      } catch (error) {
        if (!this.#isCurrent(generation)) {
          return;
        }
        this.#retryOperation = confirm;
        this.#setFailure(error);
      }
    };
    try {
      await this.#boundary.pairingExchange(authority, this.#requestId(), pairing.handle);
      if (
        !this.#isCurrent(generation) ||
        !this.#authorityIsCurrent(authority) ||
        this.#pairing !== pairing
      ) {
        return;
      }
    } catch (error) {
      if (this.#isCurrent(generation)) {
        this.#setFailure(error);
        if (
          error instanceof NativeBoundaryError &&
          error.code === 'operation_in_progress' &&
          this.#authorityIsCurrent(authority) &&
          this.#pairing === pairing
        ) {
          this.#retryOperation = () => this.#completePairing();
        } else {
          this.#pairing = null;
          this.#retryOperation =
            error instanceof NativeBoundaryError && error.code === 'credential_update_in_progress'
              ? confirm
              : null;
        }
      }
      return;
    }

    this.#pairing = null;
    await confirm();
  }

  canRetry(): boolean {
    return this.#retryOperation !== null;
  }

  retry(): Promise<void> {
    return this.#runMutation('retry', () => this.#retry());
  }

  async #retry(): Promise<void> {
    const retry = this.#retryOperation;
    if (retry === null) {
      return;
    }
    this.#retryOperation = null;
    await retry();
  }

  forgetCredential(): Promise<void> {
    return this.#runMutation('forget', () => this.#forgetCredential());
  }

  async #forgetCredential(): Promise<void> {
    const authority = this.#requireAuthority();
    const instanceId = this.#instanceId;
    if (instanceId === null) {
      return;
    }
    const generation = this.#generation;
    try {
      await this.#boundary.forgetCredential(authority, this.#requestId());
      if (!this.#isCurrent(generation) || !this.#authorityIsCurrent(authority)) {
        return;
      }
      this.#pairing = null;
      this.#retryOperation = null;
      this.#setState({ state: 'pairing_required', caveInstanceId: instanceId });
    } catch (error) {
      if (this.#isCurrent(generation)) {
        this.#setFailure(error);
      }
    }
  }

  reconnect(): Promise<void> {
    return this.#runMutation('reconnect', () => this.#reconnect());
  }

  async #reconnect(): Promise<void> {
    const previous = this.#authority;
    this.#inFlightConnect = null;
    if (previous !== null) {
      await this.#boundary.close(previous).catch(() => false);
    }
    this.#authority = null;
    await this.#connect(true);
  }

  markAuthorityFailure(error: unknown): void {
    if (!(error instanceof NativeBoundaryError)) {
      return;
    }
    if (error.code === 'incompatible_version') {
      this.#setState({ state: 'incompatible', diagnosticId: error.diagnosticId });
      return;
    }
    if (error.code === 'unauthorized') {
      this.#setState({ state: 'revoked', diagnosticId: error.diagnosticId });
      return;
    }
    if (error.code === 'service_unavailable' || error.code === 'timeout') {
      this.#setState({
        state: 'offline',
        lastHealthyAt: this.#lastHealthyAt,
        diagnosticId: error.diagnosticId,
      });
      return;
    }
    if (
      error.code === 'owner_mismatch' ||
      error.code === 'stale_record' ||
      error.code === 'unsafe_endpoint'
    ) {
      this.#setState({
        state: 'error',
        code: 'wrong_instance',
        diagnosticId: error.diagnosticId,
      });
    }
  }

  async destroy(): Promise<void> {
    this.#generation += 1;
    this.#activationCount = 0;
    const subscription = this.#eventSubscription;
    this.#eventSubscription = null;
    if (subscription !== null) {
      await subscription.then((unlisten) => unlisten()).catch(() => undefined);
    }
    const authority = this.#authority;
    this.#authority = null;
    if (authority !== null) {
      await this.#boundary.close(authority).catch(() => false);
    }
  }

  #runMutation(key: string, operation: () => Promise<void>): Promise<void> {
    const current = this.#mutationOperations.get(key);
    if (current !== undefined) {
      return current;
    }
    const pending = operation().finally(() => {
      if (this.#mutationOperations.get(key) === pending) {
        this.#mutationOperations.delete(key);
      }
    });
    this.#mutationOperations.set(key, pending);
    return pending;
  }

  async #confirmReady(authority: AuthorityReference, generation: number): Promise<void> {
    const health = await this.#boundary.health(authority, this.#requestId());
    const credential = await this.#boundary.credentialState(authority, this.#requestId());
    if (!this.#isCurrent(generation) || !this.#authorityIsCurrent(authority)) {
      return;
    }
    this.#instanceId = health.instanceId;
    this.#lastHealthyAt = this.#now();
    if (credential === 'update_in_progress') {
      throw new NativeBoundaryError('credential_update_in_progress', true, 'credential-update');
    }
    if (credential !== 'present') {
      this.#setState({ state: 'pairing_required', caveInstanceId: health.instanceId });
      return;
    }
    this.#setState({
      state: 'ready',
      caveInstanceId: health.instanceId,
      covenAvailable: false,
    });
  }

  #handleEvent(event: NativeConnectionEvent): void {
    const authority = this.#authority;
    if (authority === null || !sameAuthority(authority, event.authority)) {
      return;
    }
    if (event.kind === 'credential_revoked') {
      this.#setState({ state: 'revoked', diagnosticId: event.diagnosticId });
      return;
    }
    if (event.kind === 'transport_offline') {
      this.#setState({
        state: 'offline',
        lastHealthyAt: this.#lastHealthyAt,
        diagnosticId: event.diagnosticId,
      });
      return;
    }
    this.#setState({
      state: 'error',
      code: 'wrong_instance',
      diagnosticId: event.diagnosticId,
    });
  }

  #setFailure(error: unknown): void {
    const errorCode = code(error);
    const diagnosticId = diagnostic(error);
    if (errorCode === 'incompatible_version') {
      this.#setState({ state: 'incompatible', diagnosticId });
      return;
    }
    if (errorCode === 'unauthorized') {
      this.#setState({ state: 'revoked', diagnosticId });
      return;
    }
    if (errorCode === 'service_unavailable' || errorCode === 'timeout') {
      this.#setState({
        state: 'offline',
        lastHealthyAt: this.#lastHealthyAt,
        diagnosticId,
      });
      return;
    }
    this.#setState({ state: 'error', code: errorCode, diagnosticId });
  }

  #requireAuthority(): AuthorityReference {
    if (this.#authority === null) {
      throw new NativeBoundaryError('reconcile_required', false, 'authority-missing');
    }
    return this.#authority;
  }

  #authorityIsCurrent(authority: AuthorityReference): boolean {
    return this.#authority !== null && sameAuthority(this.#authority, authority);
  }

  #isCurrent(generation: number): boolean {
    return this.#generation === generation;
  }

  #setState(state: SdkConnectionState): void {
    this.#state = Object.freeze(state);
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

export function createConnectionController(
  boundary: NativeBoundary,
  options: ControllerOptions = {},
): ConnectionController {
  return new DefaultConnectionController(boundary, options);
}
