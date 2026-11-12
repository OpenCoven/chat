import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { CovenRunEvent } from './coven-runtime';
import { canUseTauriCommands, type InvokeCommand } from './desktop-host';

export type CompanionRunEvent = {
  runId: string;
  familiarId: string;
  status: 'running' | 'completed' | 'failed' | 'stopped';
  event?: CovenRunEvent | null;
  error?: string;
};
export type ObserveCompanionRuns = (
  receive: (value: CompanionRunEvent) => void,
) => Promise<() => void>;
function valid(value: unknown): value is CompanionRunEvent {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.runId === 'string' &&
    typeof v.familiarId === 'string' &&
    ['running', 'completed', 'failed', 'stopped'].includes(String(v.status)) &&
    (v.event == null ||
      (typeof v.event === 'object' &&
        v.event !== null &&
        'type' in v.event &&
        typeof v.event.type === 'string')) &&
    (v.error === undefined || typeof v.error === 'string')
  );
}
export async function observeCompanionRuns(
  receive: (value: CompanionRunEvent) => void,
  options: {
    available?: () => boolean;
    invoke?: InvokeCommand;
    listen?: (name: string, callback: (event: { payload: unknown }) => void) => Promise<() => void>;
  } = {},
): Promise<() => void> {
  if (!(options.available ?? canUseTauriCommands)()) return () => {};
  let revision = 0;
  const dispose = await (options.listen ?? listen)('companion-run', ({ payload }) => {
    if (valid(payload)) {
      revision += 1;
      receive(payload);
    }
  });
  try {
    const initial = await (options.invoke ?? invoke)('companion_active_run');
    if (revision === 0 && valid(initial)) receive(initial);
  } catch (error) {
    dispose();
    throw error;
  }
  return dispose;
}
