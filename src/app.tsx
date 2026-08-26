import { invoke } from '@tauri-apps/api/core';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { BROWSER_PREVIEW_STATE, ConnectionGate } from './connection-gate';
import './connection-gate.css';
import { ChatShell } from './chat-shell';
import './chat-shell.css';
import { APP_METADATA } from './lib/app-metadata';
import { type DesktopHost, desktopHost, isInstallationId } from './lib/desktop-host';
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
type InstallationIdReader = DesktopHost['readInstallationId'];
type InstallationBootstrapState =
  | Readonly<{ state: 'installation_initializing' }>
  | Readonly<{ state: 'installation_unavailable' }>
  | Readonly<{ state: 'ready'; installationId: string }>;

type AppProps = Readonly<{
  desktopIdentityHost?: Pick<DesktopHost, 'canUseTauriCommands' | 'readInstallationId'>;
  controllerFactory?: ControllerFactory;
  queryAdapterFactory?: QueryAdapterFactory;
}>;

type InstallationRead = Readonly<{
  attempt: number;
  promise: Promise<string>;
}>;

const installationReads = new WeakMap<InstallationIdReader, InstallationRead>();
const installationInitializingState = Object.freeze({
  state: 'installation_initializing',
} as const);
const installationUnavailableState = Object.freeze({
  state: 'installation_unavailable',
} as const);

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
    .then(readInstallationId)
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

function ConnectedProductionApp({
  controllerFactory,
  queryAdapterFactory,
  installationId,
}: Readonly<{
  controllerFactory: ControllerFactory;
  queryAdapterFactory: QueryAdapterFactory;
  installationId: string;
}>) {
  const [controller] = useState(() => controllerFactory(installationId));
  const [queryAdapter] = useState(() => queryAdapterFactory(() => controller.getReadyClient()));
  const connectionState = useSyncExternalStore(controller.subscribe, controller.getState);
  const startedRef = useRef(false);
  const deferredDisposeRef = useRef<ReturnType<typeof globalThis.setTimeout> | undefined>(
    undefined,
  );
  const wasReadyRef = useRef(connectionState.state === 'ready');

  useEffect(() => {
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

  return (
    <ConnectionGate controller={controller} state={connectionState}>
      <ChatShell
        queryAdapter={queryAdapter}
        onForgetCredential={() => {
          void controller.forgetCredential();
        }}
        onReconcile={() => {
          void controller.retry();
        }}
      />
    </ConnectionGate>
  );
}

function ProductionApp({
  controllerFactory,
  queryAdapterFactory,
  readInstallationId,
}: Readonly<{
  controllerFactory: ControllerFactory;
  queryAdapterFactory: QueryAdapterFactory;
  readInstallationId: InstallationIdReader;
}>) {
  const [bootstrapState, retryInstallationBootstrap] = useInstallationBootstrap(readInstallationId);

  if (bootstrapState.state !== 'ready') {
    return (
      <ConnectionGate state={bootstrapState} onInstallationRetry={retryInstallationBootstrap} />
    );
  }

  return (
    <ConnectedProductionApp
      controllerFactory={controllerFactory}
      installationId={bootstrapState.installationId}
      queryAdapterFactory={queryAdapterFactory}
    />
  );
}

export function App({
  desktopIdentityHost = desktopHost,
  controllerFactory = defaultControllerFactory,
  queryAdapterFactory = createQueryAdapter,
}: AppProps) {
  if (!desktopIdentityHost.canUseTauriCommands()) {
    return <ConnectionGate state={BROWSER_PREVIEW_STATE} />;
  }

  return (
    <ProductionApp
      controllerFactory={controllerFactory}
      queryAdapterFactory={queryAdapterFactory}
      readInstallationId={desktopIdentityHost.readInstallationId}
    />
  );
}
