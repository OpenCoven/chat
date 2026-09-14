import { Channel, invoke } from '@tauri-apps/api/core';
import { canUseTauriCommands, type InvokeCommand } from './desktop-host';

export type CovenStatus = {
  available: boolean;
  version?: string;
  error?: string;
  sdkHealth?: 'ok' | 'unavailable';
  transport?: 'cli';
};
export type CovenFamiliar = {
  id: string;
  name: string;
  displayName: string;
  description?: string;
  emoji?: string;
  workspace?: string;
  avatarUrl?: string;
};
export type CovenSession = {
  archived?: boolean;
  id: string;
  title: string;
  harness: string;
  status: string;
  familiarId?: string;
  conversationId?: string;
  updatedAt: string;
  projectRoot: string;
};
export type CovenRunEvent = { type: string; [key: string]: unknown };
export type CovenSessionRead = {
  session: CovenSession;
  events: CovenRunEvent[];
  hasMore?: boolean;
};
export type CovenSendInput = {
  runId: string;
  prompt: string;
  sessionId?: string;
  familiarId?: string;
  harness?: 'coven-code' | 'codex' | 'claude';
  attachments?: readonly { name: string; bytes: readonly number[] }[];
};
export type CovenRunResult = { runId: string; sessionId?: string; events: CovenRunEvent[] };
export type ChatLifecycle = 'active' | 'archived' | 'deleted';
export interface CovenRuntime {
  status(): Promise<CovenStatus>;
  listFamiliars(): Promise<CovenFamiliar[]>;
  listSessions(): Promise<CovenSession[]>;
  readSession(id: string): Promise<CovenSessionRead>;
  send(input: CovenSendInput, onEvent?: (event: CovenRunEvent) => void): Promise<CovenRunResult>;
  cancel(runId: string): Promise<void>;
  changeChatLifecycle(id: string, lifecycle: ChatLifecycle): Promise<void>;
}

const UNAVAILABLE =
  'Local Coven requires the desktop app. Install Coven CLI and open OpenCoven Chat.';
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function session(value: unknown): value is CovenSession {
  return (
    record(value) &&
    (value.archived === undefined || typeof value.archived === 'boolean') &&
    ['id', 'title', 'harness', 'status', 'updatedAt', 'projectRoot'].every(
      (key) => typeof value[key] === 'string',
    )
  );
}
function event(value: unknown): value is CovenRunEvent {
  return record(value) && typeof value.type === 'string';
}
function familiar(value: unknown): value is CovenFamiliar {
  return (
    record(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.displayName === 'string' &&
    (value.avatarUrl === undefined ||
      (typeof value.avatarUrl === 'string' &&
        value.avatarUrl.length <= 256 * 1024 &&
        /^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.avatarUrl)))
  );
}
function checked<T>(value: unknown, guard: (value: unknown) => value is T): T {
  if (!guard(value)) throw new Error('Coven returned an invalid native result.');
  return value;
}
function events(value: unknown): value is CovenRunEvent[] {
  return Array.isArray(value) && value.every(event);
}

export function createCovenRuntime(
  options: { available?: () => boolean; invoke?: InvokeCommand } = {},
): CovenRuntime {
  const available = options.available ?? canUseTauriCommands;
  const invokeCommand = options.invoke ?? invoke;
  async function call(command: string, args?: Record<string, unknown>): Promise<unknown> {
    if (!available()) throw new Error(UNAVAILABLE);
    try {
      return args ? await invokeCommand(command, args) : await invokeCommand(command);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : typeof error === 'string' ? error : '';
      throw new Error(message.slice(0, 2048) || 'Local Coven operation failed.');
    }
  }
  return {
    async status() {
      if (!available()) return { available: false, error: UNAVAILABLE };
      return checked(
        await call('coven_runtime_status'),
        (v): v is CovenStatus => record(v) && typeof v.available === 'boolean',
      );
    },
    async listFamiliars() {
      return checked(
        await call('coven_runtime_familiars'),
        (v): v is CovenFamiliar[] => Array.isArray(v) && v.every(familiar),
      );
    },
    async listSessions() {
      return checked(
        await call('coven_runtime_sessions'),
        (v): v is CovenSession[] =>
          Array.isArray(v) &&
          v.every(
            (item) =>
              session(item) && typeof item.familiarId === 'string' && item.familiarId.length > 0,
          ) &&
          new Set(v.map((item) => item.familiarId)).size === v.length,
      );
    },
    async readSession(id) {
      return checked(
        await call('coven_runtime_read', { id }),
        (v): v is CovenSessionRead =>
          record(v) && session(v.session) && v.session.id === id && events(v.events),
      );
    },
    async send(input, onEvent) {
      if (!available()) throw new Error(UNAVAILABLE);
      const channel = new Channel<CovenRunEvent>();
      channel.onmessage = (value) => onEvent?.(checked(value, event));
      const result = checked(
        await call('coven_runtime_send', { input, onEvent: channel }),
        (v): v is CovenRunResult => record(v) && typeof v.runId === 'string' && events(v.events),
      );
      const initialization = result.events.find(
        (event) => event.type === 'system' && event.subtype === 'init',
      );
      const sessionId = initialization?.session_id;
      return typeof sessionId === 'string' && sessionId.length > 0
        ? { ...result, sessionId }
        : result;
    },
    async cancel(runId) {
      await call('coven_runtime_cancel', { runId });
    },
    async changeChatLifecycle(id, lifecycle) {
      const result = await call('coven_runtime_chat_lifecycle', { id, lifecycle });
      if (result !== null && result !== undefined)
        throw new Error('Coven returned an invalid native result.');
    },
  };
}
