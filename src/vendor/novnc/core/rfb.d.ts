/**
 * The slice of noVNC's RFB class the screen viewer uses. This declaration is
 * an addition alongside the vendored, unmodified `rfb.js`; see `../README.md`.
 */

/** What `Websock.attach` requires of a WebSocket-like object. */
export type RawChannel = {
  binaryType: string;
  protocol: string;
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: { data: ArrayBuffer }) => void) | null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
};

export type RfbOptions = {
  shared?: boolean;
  credentials?: { username?: string; password?: string; target?: string };
  repeaterID?: string;
  wsProtocols?: string[];
};

export type RfbCredentialsRequiredEvent = CustomEvent<{ types: string[] }>;
export type RfbDisconnectEvent = CustomEvent<{ clean: boolean }>;
export type RfbSecurityFailureEvent = CustomEvent<{ status: number; reason?: string }>;
export type RfbDesktopNameEvent = CustomEvent<{ name: string }>;

export default class RFB extends EventTarget {
  constructor(target: HTMLElement, urlOrChannel: string | RawChannel, options?: RfbOptions);
  viewOnly: boolean;
  scaleViewport: boolean;
  clipViewport: boolean;
  resizeSession: boolean;
  focusOnClick: boolean;
  showDotCursor: boolean;
  background: string;
  qualityLevel: number;
  compressionLevel: number;
  readonly capabilities: { power: boolean };
  disconnect(): void;
  sendCredentials(credentials: { username?: string; password?: string; target?: string }): void;
  sendCtrlAltDel(): void;
  sendKey(keysym: number, code: string | null, down?: boolean): void;
  clipboardPasteFrom(text: string): void;
  focus(options?: FocusOptions): void;
  blur(): void;
  machineShutdown(): void;
  machineReboot(): void;
  machineReset(): void;
  toDataURL(type?: string, encoderOptions?: number): string;
}
