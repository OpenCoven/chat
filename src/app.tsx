import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { ConnectionGate, type ConnectionGateState } from './connection-gate';
import './connection-gate.css';
import { ChatShell } from './chat-shell';
import './chat-shell.css';
import './chat-composer.css';
import { APP_METADATA } from './lib/app-metadata';
import { type DesktopHost, desktopHost, isInstallationId } from './lib/desktop-host';
import {
  type ChatSource,
  createCaveChatSource,
  createLocalChatSource,
  type LocalChatSource,
} from './lib/local/chat-source';
import { LOCAL_FAMILIAR_ID } from './lib/local/local-query-adapter';
import {
  type CaveConnectionController,
  type CaveReadClient,
  createCaveConnectionController,
} from './lib/sdk/connection-controller';
import { createCaveConnectionHost } from './lib/sdk/connection-host';
import type { NativeSdkInvoke } from './lib/sdk/native-boundary';
import { createQueryAdapter, type QueryAdapter } from './lib/sdk/query-adapter';

type ControllerFactory = (installationId: string) => CaveConnectionController;
type QueryAdapterFactory = (getClient: () => CaveReadClient | null) => QueryAdapter;
type LocalSourceFactory = () => Promise<LocalChatSource>;
type InstallationIdReader = DesktopHost['readInstallationId'];
type InstallationBootstrapState =
  | Readonly<{ state: 'installation_initializing' }>
  | Readonly<{ state: 'installation_unavailable' }>
  | Readonly<{ state: 'ready'; installationId: string }>;

type AppProps = Readonly<{
  desktopIdentityHost?: Pick<DesktopHost, 'canUseTauriCommands' | 'readInstallationId'>;
  controllerFactory?: ControllerFactory;
  queryAdapterFactory?: QueryAdapterFactory;
  localSourceFactory?: LocalSourceFactory;
}>;

type InstallationRead = Readonly<{
  attempt: number;
  promise: Promise<string>;
}>;

export type CaveStatus = Readonly<{
  gateState: ConnectionGateState;
  controller: CaveConnectionController | null;
  source: ChatSource | null;
  onInstallationRetry: (() => void) | undefined;
}>;

const installationReads = new WeakMap<InstallationIdReader, InstallationRead>();
const installationInitializingState = Object.freeze({
  state: 'installation_initializing',
} as const);
const installationUnavailableState = Object.freeze({
  state: 'installation_unavailable',
} as const);
const LOCAL_PREPARING = 'Preparing local chat storage…';

function sleepWithAbort(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(Object.freeze({ code: 'aborted' }));
  }

  return new Promise<void>((resolve, reject) => {
    const timeout = globalThis.setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, milliseconds);

    const abort = () => {
      globalThis.clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      reject(Object.freeze({ code: 'aborted' }));
    };

    signal.addEventListener('abort', abort, { once: true });
  });
}

function defaultControllerFactory(installationId: string): CaveConnectionController {
  return createCaveConnectionController({
    host: createCaveConnectionHost(invoke as NativeSdkInvoke),
    pairingIdentity: {
      appName: APP_METADATA.name,
      installationId,
    },
    now: () => Date.now(),
    sleep: sleepWithAbort,
    pollIntervalMs: 2_000,
  });
}

function defaultLocalSourceFactory(): Promise<LocalChatSource> {
  return createLocalChatSource({ familiarId: LOCAL_FAMILIAR_ID });
}

function readInstallationIdForAttempt(
  readInstallationId: InstallationIdReader,
  attempt: number,
): Promise<string> {
  const existing = installationReads.get(readInstallationId);
  if (existing?.attempt === attempt) {
    return existing.promise;
  }

  let pendingRead: Promise<string>;
  pendingRead = Promise.resolve()
    .then(() => readInstallationId())
    .then((installationId) => {
      if (!isInstallationId(installationId)) {
        throw new Error('The app_installation_id command returned an invalid result.');
      }
      return installationId;
    })
    .catch((error: unknown) => {
      if (installationReads.get(readInstallationId)?.promise === pendingRead) {
        installationReads.delete(readInstallationId);
      }
      throw error;
    });
  installationReads.set(readInstallationId, Object.freeze({ attempt, promise: pendingRead }));
  return pendingRead;
}

function useInstallationBootstrap(readInstallationId: InstallationIdReader) {
  const [bootstrapState, setBootstrapState] = useState<InstallationBootstrapState>(
    installationInitializingState,
  );
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    setBootstrapState(installationInitializingState);
    setAttempt((currentAttempt) => currentAttempt + 1);
  }, []);

  useEffect(() => {
    let mounted = true;
    setBootstrapState(installationInitializingState);
    void readInstallationIdForAttempt(readInstallationId, attempt).then(
      (installationId) => {
        if (mounted) {
          setBootstrapState(Object.freeze({ state: 'ready', installationId }));
        }
      },
      () => {
        if (mounted) {
          setBootstrapState(installationUnavailableState);
        }
      },
    );

    return () => {
      mounted = false;
    };
  }, [attempt, readInstallationId]);

  return [bootstrapState, retry] as const;
}

function CaveBootstrapReporter({
  gateState,
  onInstallationRetry,
  onStatus,
}: Readonly<{
  gateState: ConnectionGateState;
  onInstallationRetry: () => void;
  onStatus: (status: CaveStatus) => void;
}>) {
  useEffect(() => {
    onStatus({ gateState, controller: null, source: null, onInstallationRetry });
  }, [gateState, onInstallationRetry, onStatus]);

  return null;
}

function CaveConnection({
  controllerFactory,
  queryAdapterFactory,
  installationId,
  onStatus,
}: Readonly<{
  controllerFactory: ControllerFactory;
  queryAdapterFactory: QueryAdapterFactory;
  installationId: string;
  onStatus: (status: CaveStatus) => void;
}>) {
  const [controller] = useState(() => controllerFactory(installationId));
  const [queryAdapter] = useState(() => queryAdapterFactory(() => controller.getReadyClient()));
  const connectionState = useSyncExternalStore(controller.subscribe, controller.getState);
  const startedRef = useRef(false);
  const wasReadyRef = useRef(connectionState.state === 'ready');
  const deferredDisposeRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(
    undefined,
  );
  const source = useMemo(() => createCaveChatSource(queryAdapter), [queryAdapter]);

  useEffect(() => {
    // Deferred so a StrictMode remount reclaims the controller instead of
    // tearing down a connection that is about to be used again.
    if (deferredDisposeRef.current !== undefined) {
      globalThis.clearTimeout(deferredDisposeRef.current);
      deferredDisposeRef.current = undefined;
    }

    if (!startedRef.current) {
      startedRef.current = true;
      void controller.start();
    }

    return () => {
      deferredDisposeRef.current = globalThis.setTimeout(() => {
        deferredDisposeRef.current = undefined;
        queryAdapter.dispose();
        controller.dispose();
      }, 0);
    };
  }, [controller, queryAdapter]);

  useEffect(() => {
    const isReady = connectionState.state === 'ready';

    if (wasReadyRef.current && !isReady) {
      queryAdapter.invalidate();
    }

    wasReadyRef.current = isReady;
  }, [connectionState.state, queryAdapter]);

  useEffect(() => {
    onStatus({
      gateState: connectionState,
      controller,
      source: connectionState.state === 'ready' ? source : null,
      onInstallationRetry: undefined,
    });
  }, [connectionState, controller, onStatus, source]);

  return null;
}

/**
 * Owns the Cave connection and reports it upward.
 *
 * It renders nothing. Cave is no longer an entry gate, so its state has to be
 * observable by the shell without standing between the user and their chat.
 */
function CaveHost({
  controllerFactory,
  queryAdapterFactory,
  readInstallationId,
  onStatus,
}: Readonly<{
  controllerFactory: ControllerFactory;
  queryAdapterFactory: QueryAdapterFactory;
  readInstallationId: InstallationIdReader;
  onStatus: (status: CaveStatus) => void;
}>) {
  const [bootstrapState, retryInstallationBootstrap] = useInstallationBootstrap(readInstallationId);

  if (bootstrapState.state !== 'ready') {
    return (
      <CaveBootstrapReporter
        gateState={bootstrapState}
        onInstallationRetry={retryInstallationBootstrap}
        onStatus={onStatus}
      />
    );
  }

  return (
    <CaveConnection
      controllerFactory={controllerFactory}
      installationId={bootstrapState.installationId}
      onStatus={onStatus}
      queryAdapterFactory={queryAdapterFactory}
    />
  );
}

function LocalStartup() {
  return (
    <section className="connection-gate" data-state="local_initializing">
      <div className="connection-gate__panel">
        <p className="connection-gate__eyebrow">OpenCoven desktop chat</p>
        <h1 className="connection-gate__title">OpenCoven Chat</h1>
        <div className="connection-gate__summary">
          <span className="connection-gate__spinner" aria-hidden="true" />
          <output
            className="connection-gate__status connection-gate__status--info"
            aria-label="Startup state"
            aria-live="polite"
          >
            {LOCAL_PREPARING}
          </output>
        </div>
      </div>
    </section>
  );
}

export function App({
  desktopIdentityHost = desktopHost,
  controllerFactory = defaultControllerFactory,
  queryAdapterFactory = createQueryAdapter,
  localSourceFactory = defaultLocalSourceFactory,
}: AppProps) {
  const [localSource, setLocalSource] = useState<LocalChatSource | null>(null);
  const [caveEnabled, setCaveEnabled] = useState(false);
  const [caveSurfaceOpen, setCaveSurfaceOpen] = useState(false);
  const [caveStatus, setCaveStatus] = useState<CaveStatus | null>(null);
  const [activeKind, setActiveKind] = useState<'local' | 'cave'>('local');
  const [revision, setRevision] = useState(0);

  const readInstallationId = useCallback(
    () => desktopIdentityHost.readInstallationId(),
    [desktopIdentityHost],
  );
  const canUseCave = desktopIdentityHost.canUseTauriCommands();
  const onStatus = useCallback((status: CaveStatus) => {
    setCaveStatus(status);
  }, []);

  useEffect(() => {
    let mounted = true;
    let created: LocalChatSource | null = null;

    void localSourceFactory().then((source) => {
      if (!mounted) {
        source.store.dispose();
        return;
      }
      created = source;
      setLocalSource(source);
    });

    return () => {
      mounted = false;
      created?.store.dispose();
    };
  }, [localSourceFactory]);

  const caveSource = caveStatus?.source ?? null;
  // Falling back to local rather than showing an empty Cave view: a dropped
  // connection should not look like deleted history.
  const activeSource: ChatSource | null =
    activeKind === 'cave' && caveSource !== null ? caveSource : localSource;

  useEffect(() => {
    if (activeKind === 'cave' && caveSource === null) {
      setActiveKind('local');
    }
  }, [activeKind, caveSource]);

  if (activeSource === null) {
    return <LocalStartup />;
  }

  return (
    <>
      {caveEnabled ? (
        <CaveHost
          controllerFactory={controllerFactory}
          onStatus={onStatus}
          queryAdapterFactory={queryAdapterFactory}
          readInstallationId={readInstallationId}
        />
      ) : null}

      <div className="app-source-bar">
        <span className="app-source-bar__label">Source</span>
        <button
          className="app-source-bar__choice"
          type="button"
          aria-pressed={activeKind === 'local'}
          onClick={() => {
            setActiveKind('local');
          }}
        >
          This device
        </button>
        <button
          className="app-source-bar__choice"
          type="button"
          aria-pressed={activeKind === 'cave'}
          disabled={caveSource === null}
          onClick={() => {
            setActiveKind('cave');
          }}
        >
          Coven Cave
        </button>
        {canUseCave ? (
          <button
            className="app-source-bar__connect"
            type="button"
            onClick={() => {
              setCaveEnabled(true);
              setCaveSurfaceOpen(true);
            }}
          >
            {caveSource === null ? 'Connect to Cave' : 'Cave connection'}
          </button>
        ) : (
          <span className="app-source-bar__note">
            Coven Cave needs the desktop app. Local chat works here.
          </span>
        )}
      </div>

      {caveSurfaceOpen && caveStatus !== null && caveStatus.gateState.state !== 'ready' ? (
        <div className="app-cave-surface">
          <ConnectionGate
            state={caveStatus.gateState}
            {...(caveStatus.controller === null ? {} : { controller: caveStatus.controller })}
            {...(caveStatus.onInstallationRetry === undefined
              ? {}
              : { onInstallationRetry: caveStatus.onInstallationRetry })}
          />
          <button
            className="app-cave-surface__dismiss"
            type="button"
            onClick={() => {
              setCaveSurfaceOpen(false);
            }}
          >
            Keep using local chat
          </button>
        </div>
      ) : null}

      <ChatShell
        key={activeSource.kind}
        isDurable={activeSource.isDurable}
        queryAdapter={activeSource.adapter}
        revision={revision}
        writer={activeSource.writer}
        onCreateConversation={() => {
          void activeSource.writer.createConversation().then((result) => {
            if (result.status === 'ok') {
              setRevision((current) => current + 1);
            }
          });
        }}
        onForgetCredential={() => {
          void caveStatus?.controller?.forgetCredential();
        }}
        onReconcile={() => {
          void caveStatus?.controller?.retry();
        }}
      />
    </>
  );
}
