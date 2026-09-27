import { Channel, invoke } from '@tauri-apps/api/core';
import type { RawChannel } from '../vendor/novnc/core/rfb.js';
import { canUseTauriCommands, type InvokeCommand } from './desktop-host';

/**
 * The webview side of the screen relay. The desktop host owns the network
 * connection (see `src-tauri/src/screen_relay.rs`); this file presents it to
 * noVNC as the WebSocket-shaped object its `Websock.attach` accepts, so the
 * VNC client runs unmodified without the window ever opening a socket.
 *
 * Every message down the channel starts with a tag byte; the rest is the
 * payload. The host sends `open` first, then any number of `data` messages,
 * and exactly one `close` last. An `error` may precede the close.
 */
export const TAG = { data: 0, open: 1, close: 2, error: 3 } as const;

export type RelayFrame =
  | Readonly<{ kind: 'data'; data: ArrayBuffer }>
  | Readonly<{ kind: 'open' }>
  | Readonly<{ kind: 'close'; code: number; reason: string }>
  | Readonly<{ kind: 'error'; message: string }>;

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

const decoder = new TextDecoder();

export function decodeFrame(buffer: ArrayBuffer): RelayFrame {
  const bytes = new Uint8Array(buffer);
  switch (bytes[0]) {
    case TAG.data:
      return { kind: 'data', data: buffer.slice(1) };
    case TAG.open:
      return { kind: 'open' };
    case TAG.close: {
      const code = bytes.length >= 3 ? ((bytes[1] ?? 0) << 8) | (bytes[2] ?? 0) : 1005;
      return { kind: 'close', code, reason: decoder.decode(bytes.subarray(3)) };
    }
    case TAG.error:
      return { kind: 'error', message: decoder.decode(bytes.subarray(1)) };
    default:
      return { kind: 'error', message: 'The desktop host sent an unreadable screen message.' };
  }
}

/** A relay channel also reports the host's own explanation of a failure. */
export type ScreenChannel = RawChannel & {
  /** The last host-reported problem, for the viewer to show verbatim. */
  readonly lastError: string;
};

export type ScreenRelay = Readonly<{
  /** Whether the desktop host is present. `open` throws when it is not. */
  available: boolean;
  open(url: string): ScreenChannel;
}>;

type FrameChannel = { onmessage: (buffer: ArrayBuffer) => void };

function toBytes(data: ArrayBuffer | ArrayBufferView): number[] {
  const view =
    data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return Array.from(view);
}

export function createScreenRelay(
  options: { invoke?: InvokeCommand; available?: () => boolean; channel?: () => FrameChannel } = {},
): ScreenRelay {
  const invokeCommand = options.invoke ?? (invoke as InvokeCommand);
  const available = (options.available ?? canUseTauriCommands)();
  const makeChannel = options.channel ?? (() => new Channel<ArrayBuffer>());
  return {
    available,
    open(url) {
      if (!available) throw new Error('Screen viewing needs the desktop app.');
      let state = CONNECTING;
      let id: string | undefined;
      let closeRequested = false;
      let lastError = '';
      const queued: number[][] = [];
      // Frames the host delivered before the client attached its handlers.
      // They are replayed, in order, on the microtask after a handler is set,
      // by which time noVNC's `attach` has assigned all four.
      const early: RelayFrame[] = [];
      let replayScheduled = false;
      const handlers: {
        onopen: ScreenChannel['onopen'];
        onmessage: ScreenChannel['onmessage'];
        onclose: ScreenChannel['onclose'];
        onerror: ScreenChannel['onerror'];
      } = { onopen: null, onmessage: null, onclose: null, onerror: null };
      function scheduleReplay() {
        if (replayScheduled) return;
        replayScheduled = true;
        queueMicrotask(() => {
          replayScheduled = false;
          for (const frame of early.splice(0)) dispatch(frame);
        });
      }
      const socket = {
        binaryType: 'arraybuffer',
        protocol: '',
        get onopen() {
          return handlers.onopen;
        },
        set onopen(value) {
          handlers.onopen = value;
          scheduleReplay();
        },
        get onmessage() {
          return handlers.onmessage;
        },
        set onmessage(value) {
          handlers.onmessage = value;
          scheduleReplay();
        },
        get onclose() {
          return handlers.onclose;
        },
        set onclose(value) {
          handlers.onclose = value;
          scheduleReplay();
        },
        get onerror() {
          return handlers.onerror;
        },
        set onerror(value) {
          handlers.onerror = value;
          scheduleReplay();
        },
        get readyState() {
          return state;
        },
        get lastError() {
          return lastError;
        },
        send(data) {
          if (state !== OPEN && state !== CONNECTING) return;
          const bytes = toBytes(data);
          if (id === undefined) {
            queued.push(bytes);
            return;
          }
          void invokeCommand('coven_screen_send', { id, bytes }).catch((failure: unknown) => {
            fail(failure instanceof Error ? failure.message : String(failure));
          });
        },
        close() {
          if (state === CLOSING || state === CLOSED) return;
          state = CLOSING;
          if (id === undefined) {
            closeRequested = true;
            return;
          }
          void invokeCommand('coven_screen_disconnect', { id }).catch(() => finish(1006, ''));
        },
      } as ScreenChannel;
      function finish(code: number, reason: string) {
        if (state === CLOSED) return;
        const wasClean = code === 1000;
        state = CLOSED;
        dispatch({ kind: 'close', code, reason });
        if (!wasClean && !lastError) lastError = reason;
      }
      function fail(message: string) {
        lastError = message;
        dispatch({ kind: 'error', message });
      }
      function dispatch(frame: RelayFrame) {
        // Nothing attached yet: hold the frame rather than lose it.
        const attached =
          handlers.onmessage !== null ||
          handlers.onopen !== null ||
          handlers.onclose !== null ||
          handlers.onerror !== null;
        if (!attached || early.length) {
          early.push(frame);
          return;
        }
        switch (frame.kind) {
          case 'open':
            handlers.onopen?.(new Event('open'));
            return;
          case 'data':
            handlers.onmessage?.({ data: frame.data });
            return;
          case 'error':
            handlers.onerror?.(new Event('error'));
            return;
          case 'close':
            handlers.onclose?.({
              code: frame.code,
              reason: frame.reason,
              wasClean: frame.code === 1000,
            });
            return;
        }
      }
      const channel = makeChannel();
      channel.onmessage = (buffer) => {
        const frame = decodeFrame(buffer);
        switch (frame.kind) {
          case 'open':
            if (state === CONNECTING) {
              state = OPEN;
              dispatch(frame);
            }
            return;
          case 'data':
            if (state === OPEN || state === CLOSING) dispatch(frame);
            return;
          case 'error':
            fail(frame.message);
            return;
          case 'close':
            finish(frame.code, frame.reason);
            return;
        }
      };
      void invokeCommand('coven_screen_connect', { url, onFrame: channel })
        .then((value) => {
          if (typeof value !== 'string' || !value) {
            throw new Error('The desktop host returned an invalid screen session.');
          }
          id = value;
          if (closeRequested) {
            void invokeCommand('coven_screen_disconnect', { id }).catch(() => finish(1006, ''));
            return;
          }
          for (const bytes of queued.splice(0)) {
            void invokeCommand('coven_screen_send', { id, bytes }).catch((failure: unknown) => {
              fail(failure instanceof Error ? failure.message : String(failure));
            });
          }
        })
        .catch((failure: unknown) => {
          fail(failure instanceof Error ? failure.message : String(failure));
          finish(1006, lastError);
        });
      return socket;
    },
  };
}

export const defaultScreenRelay: ScreenRelay = createScreenRelay();
