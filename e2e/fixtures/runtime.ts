import type { Page } from '@playwright/test';

declare global {
  interface Window {
    __covenFixture: {
      calls: string[];
      inputs?: unknown[];
      finish?: (nextSessionId?: string) => void;
    };
    /** Overrides the first familiar's name, for layout tests with long names. */
    __fixtureFamiliarName?: string;
    /** Addresses the window asked the host to open, in order. */
    __openedLinks?: unknown[];
  }
}

export async function installRuntimeFixture(
  page: Page,
  available = true,
  reply = 'Streamed through the Coven boundary.',
  population = 1,
  // When set, these frames replace the single assistant reply so a test can
  // stream the structured tool shapes the runtime documents.
  stream?: Record<string, unknown>[],
  observerFailure = false,
  // First-run setup's own answer. It normally follows `available`; a test of
  // the chat's disconnected state sets it so Coven goes missing after setup.
  setupComplete = available,
) {
  await page.addInitScript(
    ({ ready, reply, population, stream, observerFailure, setupComplete }) => {
      const portrait = document.createElement('canvas');
      portrait.width = 2;
      portrait.height = 2;
      const paint = portrait.getContext('2d');
      if (!paint) throw new Error('Cannot create the PNG avatar fixture.');
      paint.fillStyle = '#9386d0';
      paint.fillRect(0, 0, 2, 2);
      const avatarUrl = portrait.toDataURL('image/png');
      const callbacks = new Map<number, (data: unknown) => void>();
      let callbackId = 0;
      // What first-run setup has installed during this page's life.
      const installed = { coven: false, engine: false };
      let rejectRun: ((error: Error) => void) | undefined;
      type FixtureHead = {
        session: {
          id: string;
          title: string;
          harness: string;
          status: string;
          familiarId: string;
          updatedAt: string;
          projectRoot: string;
        };
        events: Record<string, unknown>[];
      };
      const saved = localStorage.getItem('coven-browser-fixture');
      const state: {
        heads: Record<string, FixtureHead>;
        calls: string[];
        inputs: unknown[];
      } = saved ? JSON.parse(saved) : { heads: {}, calls: [], inputs: [] };
      const persist = () => localStorage.setItem('coven-browser-fixture', JSON.stringify(state));
      window.__covenFixture = { calls: state.calls, inputs: state.inputs };
      Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
        value: { unregisterListener() {} },
      });
      Object.defineProperty(window, '__TAURI_INTERNALS__', {
        value: {
          // What the host describes about the window; setTitle needs its label.
          metadata: { currentWindow: { label: 'main' } },
          transformCallback(callback: (data: unknown) => void) {
            callbacks.set(++callbackId, callback);
            return callbackId;
          },
          unregisterCallback(id: number) {
            callbacks.delete(id);
          },
          async invoke(command: string, args: Record<string, unknown> = {}) {
            window.__covenFixture.calls.push(command);
            persist();
            switch (command) {
              case 'plugin:event|listen':
                if (observerFailure) throw new Error('Fixture observer unavailable');
                return 1;
              case 'plugin:event|unlisten':
              case 'companion_active_run':
                return null;
              case 'setup_check':
                return {
                  platform: { ok: true, os: 'macos' },
                  coven:
                    setupComplete || installed.coven
                      ? { ok: true, version: 'fixture' }
                      : { ok: false },
                  engine: { ok: setupComplete || installed.engine },
                  signIn: {
                    ok: setupComplete,
                    engine: setupComplete ? 'signed-in' : 'missing',
                    claude: 'missing',
                    chatgpt: 'missing',
                    claudeInstaller: 'curl -fsSL https://claude.ai/install.sh | bash',
                  },
                  familiar: { ok: setupComplete, count: setupComplete ? 1 : 0 },
                };
              case 'coven_runtime_status':
                return ready
                  ? {
                      available: true,
                      version: 'fixture',
                      transport: 'cli',
                      sdkHealth: 'unavailable',
                    }
                  : {
                      available: false,
                      error: 'Coven CLI is not installed. Install Coven CLI, then retry.',
                      setup: 'install-cli',
                    };
              case 'coven_runtime_familiars':
                return Array.from({ length: population }, (_, index) => ({
                  id: index ? `fixture-familiar-${index}` : 'fixture-familiar',
                  name: index
                    ? `Familiar ${index}`
                    : (window.__fixtureFamiliarName ?? 'Local familiar'),
                  displayName: index
                    ? `Familiar ${index}`
                    : (window.__fixtureFamiliarName ?? 'Local familiar'),
                  workspace: `/fixture/familiars/${index}/workspace`,
                  projectAccess: index
                    ? [{ name: 'private', path: `/fixture/private/${index}`, access: 'read' }]
                    : [
                        {
                          name: 'workspace',
                          path: '/fixture/familiars/0/workspace',
                          access: 'write',
                        },
                        {
                          name: 'workspace',
                          path: '/fixture/projects/library/workspace',
                          access: 'read',
                        },
                        { name: 'workspace', path: '/fixture/workspace', access: 'write' },
                      ],
                  description:
                    population > 1
                      ? 'A detailed familiar purpose. '.repeat(100)
                      : 'Native-boundary browser fixture',
                  avatarUrl,
                }));
              case 'coven_runtime_sessions':
                return Object.values(state.heads).map((head) => head.session);
              case 'coven_runtime_read': {
                const selected = Object.values(state.heads).find(
                  (head) => head.session.id === args.id,
                );
                if (!selected) throw new Error('Unexpected session read.');
                return selected;
              }
              case 'setup_run': {
                const channel = args.onEvent;
                const step = args.step;
                if (
                  typeof args.runId !== 'string' ||
                  (step !== 'install_coven' && step !== 'install_engine') ||
                  typeof channel !== 'object' ||
                  !channel ||
                  !('id' in channel) ||
                  typeof channel.id !== 'number'
                )
                  throw new Error('Invalid setup boundary.');
                const callback = callbacks.get(channel.id);
                if (!callback) throw new Error('Setup callback not registered.');
                const events =
                  step === 'install_coven'
                    ? [
                        { type: 'progress', stage: 'download', received: 0, total: 100 },
                        { type: 'progress', stage: 'download', received: 50, total: 100 },
                        { type: 'progress', stage: 'download', received: 100, total: 100 },
                        { type: 'progress', stage: 'install' },
                      ]
                    : [
                        { type: 'line', text: 'Downloading coven-code 0.8.0' },
                        { type: 'line', text: 'Engine ready' },
                      ];
                events.forEach((message, index) => {
                  callback({ index, message });
                });
                callback({ index: events.length, end: true });
                if (step === 'install_coven') installed.coven = true;
                else installed.engine = true;
                return step === 'install_coven' ? { version: 'fixture' } : { installed: true };
              }
              case 'coven_runtime_send': {
                const input = args.input;
                window.__covenFixture.inputs?.push(input);
                const channel = args.onEvent;
                if (
                  typeof input !== 'object' ||
                  !input ||
                  !('prompt' in input) ||
                  !('runId' in input) ||
                  !('familiarId' in input) ||
                  typeof input.familiarId !== 'string' ||
                  typeof input.prompt !== 'string' ||
                  typeof channel !== 'object' ||
                  !channel ||
                  !('id' in channel) ||
                  typeof channel.id !== 'number'
                )
                  throw new Error('Invalid send boundary.');
                const callback = callbacks.get(channel.id);
                if (!callback) throw new Error('Stream callback not registered.');
                const familiarId = input.familiarId;
                const current = state.heads[familiarId];
                if (
                  (current &&
                    (!('sessionId' in input) || input.sessionId !== current.session.id)) ||
                  (!current && 'sessionId' in input && input.sessionId)
                )
                  throw new Error('Send must resume this familiar canonical head.');
                const session = current?.session ?? {
                  id: `head-${input.familiarId}`,
                  title: 'A real runtime boundary fixture',
                  harness: 'coven-code',
                  status: 'completed',
                  familiarId: input.familiarId,
                  updatedAt: '2026-09-15T00:00:00Z',
                  projectRoot: '/fixture/workspace',
                };
                const events: Record<string, unknown>[] = [
                  { type: 'system', subtype: 'init', session_id: session.id },
                  {
                    type: 'user',
                    session_id: session.id,
                    attachments:
                      'attachments' in input && Array.isArray(input.attachments)
                        ? input.attachments.map((file: { name: string; bytes: number[] }) => ({
                            name: file.name,
                            size: file.bytes.length,
                          }))
                        : [],
                    message: { content: [{ type: 'text', text: input.prompt }] },
                  },
                  ...(stream
                    ? stream.map((frame) => ({ ...frame, session_id: session.id }))
                    : [
                        {
                          type: 'assistant',
                          session_id: session.id,
                          message: {
                            content: [{ type: 'text', text: reply }],
                          },
                        },
                      ]),
                ];
                state.heads[familiarId] = {
                  session,
                  events: [...(current?.events ?? []), ...events],
                };
                persist();
                events.forEach((message, index) => {
                  callback({ index, message });
                });
                return new Promise((resolve, reject) => {
                  rejectRun = reject;
                  window.__covenFixture.finish = (nextSessionId) => {
                    events.push({ type: 'result', session_id: session.id, is_error: false });
                    const completedSession = nextSessionId
                      ? { ...session, id: nextSessionId }
                      : session;
                    const completedEvents = nextSessionId
                      ? events.map((event) => ({ ...event, session_id: nextSessionId }))
                      : events;
                    state.heads[familiarId] = {
                      session: completedSession,
                      // A persisted transcript can contain non-rendered metadata absent
                      // from live output; its index-based message IDs then change.
                      events: [
                        ...(nextSessionId
                          ? [{ type: 'system', subtype: 'persisted-metadata' }]
                          : []),
                        ...(current?.events ?? []),
                        ...completedEvents,
                      ],
                    };
                    persist();
                    callback({
                      index: completedEvents.length - 1,
                      message: completedEvents[completedEvents.length - 1],
                    });
                    callback({ index: completedEvents.length, end: true });
                    resolve({ runId: input.runId, events: completedEvents });
                  };
                });
              }
              case 'coven_runtime_cancel':
                rejectRun?.(new Error('Coven run was cancelled.'));
                return null;
              // The host would hand the address to the system; the fixture records it.
              case 'open_reviewed_link':
                window.__openedLinks = [...(window.__openedLinks ?? []), args.address];
                return null;
              // The one Tauri core permission the window holds: its own title.
              case 'plugin:window|set_title':
                document.documentElement.dataset.nativeTitle = String(args.value);
                return null;
              default:
                throw new Error(`Unexpected native command: ${command}`);
            }
          },
        },
      });
    },
    { ready: available, reply, population, stream, observerFailure, setupComplete },
  );
}
