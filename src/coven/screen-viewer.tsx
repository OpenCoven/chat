import { type FormEvent, useEffect, useId, useRef, useState } from 'react';
import { FamButton, FamIconButton } from '../design/familiars-ui';
import type { ScreenChannel, ScreenRelay } from '../lib/screen-relay';
import type RFB from '../vendor/novnc/core/rfb.js';
import type {
  RfbCredentialsRequiredEvent,
  RfbDesktopNameEvent,
  RfbDisconnectEvent,
  RfbSecurityFailureEvent,
} from '../vendor/novnc/core/rfb.js';
import './screen-viewer.css';

export type RfbClass = typeof RFB;
/** Loads the VNC client class; tests substitute a fake. */
export type LoadRfb = () => Promise<RfbClass>;

const loadRfbClass: LoadRfb = async () => (await import('../vendor/novnc/core/rfb.js')).default;

type Phase =
  | Readonly<{ kind: 'idle' }>
  | Readonly<{ kind: 'connecting' }>
  | Readonly<{ kind: 'connected'; name: string }>
  | Readonly<{ kind: 'ended'; reason: string }>;

export type ScreenViewerProps = Readonly<{
  relay?: ScreenRelay | undefined;
  familiarName?: string | undefined;
  onClose: () => void;
  loadRfb?: LoadRfb;
}>;

/** What the reader is told when a connection ends. */
export function endedText(code: number, reason: string, hostError: string): string {
  if (hostError) return hostError;
  if (reason) return reason;
  if (code === 1000) return 'Disconnected.';
  return 'The screen connection ended.';
}

function describe(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure);
}

/**
 * A VNC screen inside the chat window. The connection itself belongs to the
 * desktop host; this component decides what the reader sees about it and
 * keeps the address and password in component state only (never storage).
 *
 * The client class is loaded before the channel opens, and the client is
 * built in the same tick as the channel, so no byte the server sends can
 * arrive before the client is listening.
 */
export function ScreenViewer({
  relay,
  familiarName,
  onClose,
  loadRfb = loadRfbClass,
}: ScreenViewerProps) {
  const id = useId();
  const [address, setAddress] = useState('');
  const [password, setPassword] = useState('');
  const [viewOnly, setViewOnly] = useState(true);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [needsPassword, setNeedsPassword] = useState(false);
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const channelRef = useRef<ScreenChannel | null>(null);
  const generation = useRef(0);

  function teardown() {
    generation.current += 1;
    rfbRef.current?.disconnect();
    rfbRef.current = null;
    channelRef.current?.close();
    channelRef.current = null;
    setNeedsPassword(false);
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: the host connection must not outlive the pane.
  useEffect(() => () => teardown(), []);

  useEffect(() => {
    if (rfbRef.current) rfbRef.current.viewOnly = viewOnly;
  }, [viewOnly]);

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (!relay?.available || phase.kind === 'connecting' || phase.kind === 'connected') return;
    const target = screenRef.current;
    if (!target) return;
    teardown();
    const attempt = generation.current;
    const live = () => attempt === generation.current;
    setPhase({ kind: 'connecting' });
    let Rfb: RfbClass;
    try {
      Rfb = await loadRfb();
    } catch (failure) {
      if (live()) setPhase({ kind: 'ended', reason: describe(failure) });
      return;
    }
    if (!live()) return;
    let channel: ScreenChannel;
    let rfb: RFB;
    try {
      channel = relay.open(address);
    } catch (failure) {
      setPhase({ kind: 'ended', reason: describe(failure) });
      return;
    }
    try {
      rfb = new Rfb(target, channel, {
        shared: true,
        ...(password ? { credentials: { password } } : {}),
      });
    } catch (failure) {
      channel.close();
      setPhase({ kind: 'ended', reason: describe(failure) });
      return;
    }
    channelRef.current = channel;
    rfbRef.current = rfb;
    rfb.viewOnly = viewOnly;
    rfb.scaleViewport = true;
    rfb.background = 'transparent';
    rfb.addEventListener('connect', () => {
      if (live()) setPhase({ kind: 'connected', name: familiarName ?? 'screen' });
    });
    rfb.addEventListener('desktopname', (event) => {
      const { name } = (event as RfbDesktopNameEvent).detail;
      if (live())
        setPhase((current) => (current.kind === 'connected' ? { ...current, name } : current));
    });
    rfb.addEventListener('credentialsrequired', (event) => {
      const { types } = (event as RfbCredentialsRequiredEvent).detail;
      if (!live()) return;
      if (password && types.includes('password') && types.length === 1) {
        rfb.sendCredentials({ password });
        return;
      }
      setNeedsPassword(true);
    });
    rfb.addEventListener('securityfailure', (event) => {
      const { reason } = (event as RfbSecurityFailureEvent).detail;
      if (live())
        setPhase({ kind: 'ended', reason: reason || 'The screen server refused the connection.' });
    });
    rfb.addEventListener('disconnect', (event) => {
      const { clean } = (event as RfbDisconnectEvent).detail;
      if (!live()) return;
      rfbRef.current = null;
      setNeedsPassword(false);
      setPhase((current) =>
        current.kind === 'ended'
          ? current
          : {
              kind: 'ended',
              reason: clean ? 'Disconnected.' : channel.lastError || 'The screen connection ended.',
            },
      );
    });
  }

  function submitPassword(event: FormEvent) {
    event.preventDefault();
    rfbRef.current?.sendCredentials({ password });
    setNeedsPassword(false);
  }

  function disconnect() {
    teardown();
    setPhase({ kind: 'ended', reason: 'Disconnected.' });
  }

  const busy = phase.kind === 'connecting' || phase.kind === 'connected';
  const status =
    phase.kind === 'idle'
      ? relay?.available
        ? 'Not connected.'
        : 'Screen viewing needs the desktop app.'
      : phase.kind === 'connecting'
        ? 'Connecting…'
        : phase.kind === 'connected'
          ? `Connected to ${phase.name}${viewOnly ? ' · view only' : ''}`
          : phase.reason;

  return (
    <section className="coven-screen" aria-label="Screen viewer" data-phase={phase.kind}>
      <div className="coven-screen-bar">
        <form className="coven-screen-form" onSubmit={connect}>
          <label htmlFor={`${id}-address`} className="coven-screen-label">
            Screen address
          </label>
          <input
            id={`${id}-address`}
            className="coven-screen-input"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder="wss://host/websockify?token=…"
            value={address}
            disabled={busy || !relay?.available}
            onChange={(event) => setAddress(event.target.value)}
          />
          <label htmlFor={`${id}-password`} className="coven-screen-label">
            Password
          </label>
          <input
            id={`${id}-password`}
            className="coven-screen-input coven-screen-input--password"
            type="password"
            autoComplete="off"
            placeholder="if required"
            value={password}
            disabled={phase.kind === 'connecting' || !relay?.available}
            onChange={(event) => setPassword(event.target.value)}
          />
          {busy ? (
            // Distinct keys: the browser decides a click's default action
            // after React has re-rendered, so a Disconnect button that turned
            // into the submit button in place would submit this form.
            <FamButton key="disconnect" size="sm" onClick={disconnect}>
              Disconnect
            </FamButton>
          ) : (
            <FamButton
              key="connect"
              size="sm"
              variant="primary"
              type="submit"
              disabled={!relay?.available || !address.trim()}
            >
              Connect
            </FamButton>
          )}
        </form>
        <label className="coven-screen-toggle">
          <input
            type="checkbox"
            checked={viewOnly}
            onChange={(event) => setViewOnly(event.target.checked)}
          />
          View only
        </label>
        <FamIconButton icon="x" label="Close screen" size="sm" onClick={onClose} />
      </div>
      <output className="coven-screen-status" aria-live="polite">
        {status}
      </output>
      {needsPassword ? (
        <form className="coven-screen-password" onSubmit={submitPassword}>
          <label htmlFor={`${id}-prompt`}>The screen server asks for a password.</label>
          <input
            id={`${id}-prompt`}
            className="coven-screen-input"
            type="password"
            autoComplete="off"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <FamButton size="sm" variant="primary" type="submit">
            Send password
          </FamButton>
        </form>
      ) : null}
      <div
        ref={screenRef}
        className="coven-screen-surface"
        data-testid="screen-surface"
        hidden={phase.kind !== 'connected' && phase.kind !== 'connecting'}
      />
    </section>
  );
}
