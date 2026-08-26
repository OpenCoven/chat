import type { ReactNode } from 'react';

import type { CaveConnectionController, SdkConnectionState } from './lib/sdk/connection-controller';

type InstallationBootstrapGateState =
  | Readonly<{ state: 'installation_initializing' }>
  | Readonly<{ state: 'installation_unavailable' }>;

export type ConnectionGateState =
  | SdkConnectionState
  | Readonly<{ state: 'browser_preview' }>
  | InstallationBootstrapGateState;
type NonReadyConnectionGateState = Exclude<ConnectionGateState, { state: 'ready' }>;

type GateController = Pick<
  CaveConnectionController,
  'beginPairing' | 'cancelPairing' | 'forgetCredential' | 'launch' | 'retry' | 'start'
>;

type ConnectionGateProps = Readonly<{
  state: ConnectionGateState;
  controller?: GateController;
  onInstallationRetry?: () => void;
  children?: ReactNode;
}>;

type GateView = Readonly<{
  tone: 'info' | 'warn' | 'error';
  message: string;
  role: 'alert' | 'status';
  showSpinner?: boolean;
  action?: Readonly<{
    label: string;
    onClick: () => void;
    variant?: 'secondary';
  }>;
  secondaryAction?: Readonly<{
    label: string;
    onClick: () => void;
    variant?: 'secondary';
  }>;
}>;

const browserPreviewState = Object.freeze({ state: 'browser_preview' } as const);

export function ConnectionGate({
  state,
  controller,
  onInstallationRetry,
  children,
}: ConnectionGateProps) {
  if (state.state === 'ready') {
    return <>{children}</>;
  }

  const view = gateView(state, controller, onInstallationRetry);

  return (
    <section className="connection-gate" data-state={state.state}>
      <div className="connection-gate__panel">
        <p className="connection-gate__eyebrow">OpenCoven desktop chat</p>
        <h1 className="connection-gate__title">OpenCoven Chat</h1>
        <div className="connection-gate__summary">
          {view.showSpinner ? (
            <span className="connection-gate__spinner" aria-hidden="true" />
          ) : null}
          <output
            className={`connection-gate__status connection-gate__status--${view.tone}`}
            aria-label="Connection state"
            aria-live="polite"
            role={view.role}
          >
            {view.message}
          </output>
        </div>
        {view.action !== undefined || view.secondaryAction !== undefined ? (
          <div className="connection-gate__actions">
            {view.action !== undefined ? (
              <button
                className={`connection-gate__button${view.action.variant === 'secondary' ? ' connection-gate__button--secondary' : ''}`}
                type="button"
                onClick={view.action.onClick}
              >
                {view.action.label}
              </button>
            ) : null}
            {view.secondaryAction !== undefined ? (
              <button
                className={`connection-gate__button${view.secondaryAction.variant === 'secondary' ? ' connection-gate__button--secondary' : ''}`}
                type="button"
                onClick={view.secondaryAction.onClick}
              >
                {view.secondaryAction.label}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function gateView(
  state: NonReadyConnectionGateState,
  controller?: GateController,
  onInstallationRetry?: () => void,
): GateView {
  switch (state.state) {
    case 'installation_initializing':
      return {
        tone: 'info',
        message: 'Preparing secure installation identity...',
        role: 'status',
        showSpinner: true,
      };
    case 'installation_unavailable':
      return {
        tone: 'error',
        message: 'Secure installation identity unavailable. Retry setup to continue.',
        role: 'alert',
        ...(onInstallationRetry === undefined
          ? {}
          : {
              action: {
                label: 'Retry setup',
                onClick: onInstallationRetry,
              },
            }),
      };
    case 'idle':
      return {
        tone: 'info',
        message: 'Connection idle. Start the Cave handshake to continue.',
        role: 'status',
        showSpinner: true,
        ...(controller === undefined
          ? {}
          : {
              action: {
                label: 'Start connection',
                onClick: () => {
                  void controller.start();
                },
              },
            }),
      };
    case 'discovering':
      return {
        tone: 'info',
        message: 'Connecting to Cave...',
        role: 'status',
        showSpinner: true,
      };
    case 'browser_preview':
      return {
        tone: 'warn',
        message: 'Cave connection requires the desktop app. Open in the OpenCoven app to connect.',
        role: 'status',
      };
    case 'incompatible':
      return {
        tone: 'error',
        message: 'Cave version incompatible. Update or restart Cave, then retry the connection.',
        role: 'alert',
        ...(controller === undefined
          ? {}
          : {
              action: {
                label: 'Retry after update/restart',
                onClick: () => {
                  void controller.retry();
                },
              },
            }),
      };
    case 'pairing_required':
      return {
        tone: 'warn',
        message: 'Cave is ready to pair. Grant read-only chat access to continue.',
        role: 'status',
        ...(controller === undefined
          ? {}
          : {
              action: {
                label: 'Pair with Cave',
                onClick: () => {
                  void controller.beginPairing();
                },
              },
            }),
      };
    case 'pairing':
      return {
        tone: 'info',
        message: 'Approve in Cave...',
        role: 'status',
        showSpinner: true,
        ...(controller === undefined
          ? {}
          : {
              action: {
                label: 'Cancel',
                onClick: () => {
                  void controller.cancelPairing();
                },
                variant: 'secondary',
              },
            }),
      };
    case 'revoked':
      return {
        tone: 'error',
        message: 'Access revoked. Forget access?',
        role: 'alert',
        ...(controller === undefined
          ? {}
          : {
              action: {
                label: 'Forget access',
                onClick: () => {
                  void controller.forgetCredential();
                },
              },
            }),
      };
    case 'offline':
      return {
        tone: 'warn',
        message: 'Cave offline. Retry the connection or start Cave.',
        role: 'alert',
        ...(controller === undefined
          ? {}
          : {
              action: {
                label: 'Retry connection',
                onClick: () => {
                  void controller.retry();
                },
              },
              secondaryAction: {
                label: 'Start Cave',
                onClick: () => {
                  void controller.launch();
                },
                variant: 'secondary',
              },
            }),
      };
    case 'error':
      if (state.code === 'scope_denied') {
        return {
          tone: 'error',
          message: 'Access denied. Forget access?',
          role: 'alert',
          ...(controller === undefined
            ? {}
            : {
                action: {
                  label: 'Forget access',
                  onClick: () => {
                    void controller.forgetCredential();
                  },
                },
              }),
        };
      }
      return {
        tone: 'error',
        message: `Unable to connect to Cave (${state.code}).`,
        role: 'alert',
        ...(controller === undefined
          ? {}
          : {
              action: {
                label: 'Retry connection',
                onClick: () => {
                  void controller.retry();
                },
              },
            }),
      };
  }
  const unhandledState: never = state;
  throw new Error(`Unhandled connection gate state: ${String(unhandledState)}`);
}

export const BROWSER_PREVIEW_STATE: ConnectionGateState = browserPreviewState;
