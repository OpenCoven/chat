import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app';
import { DemoShell } from './demo/chat-demo';
import './demo/chat-demo.css';
import { FamiliarsShell } from './demo/familiars-shell';
import './demo/familiars-shell.css';
import { MinimalMacOS } from './demo/minimal-macos';
import './demo/minimal-macos.css';
import './styles.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('OpenCoven Chat root element was not found.');
}

/**
 * `?demo=chat`, `?demo=messages`, and `?demo=minimal` render a
 * proof-of-concept surface instead of the Phase 1 read-only production app.
 *
 * A query flag rather than a replacement: the read-only production app is
 * still what ships, and what the default browser and desktop checks assert.
 * Each demo is a preview of later phases driven entirely by local mock data,
 * and all of them are meant to be deleted when the real richer surfaces land.
 *
 * `chat` is the current direction: the "Familiars Redesign v2" design, which
 * puts the ward — what a familiar may do alone and what it must ask about —
 * at the centre of the chat. `messages` is the earlier Messages-shaped
 * surface it replaced, kept reachable so the two can be compared side by
 * side rather than from memory; `minimal` implements the approved "Coven Cave
 * Minimal (macOS)" design.
 */
/**
 * A demo build opens on a demo surface without a query flag.
 *
 * `VITE_DEFAULT_DEMO` is set at build time (see src-tauri/tauri.demo.conf.json
 * and the release notes); the production build leaves it unset, so the
 * read-only app stays the default there.
 */
const defaultDemo = import.meta.env.VITE_DEFAULT_DEMO ?? null;
const demo = new URLSearchParams(window.location.search).get('demo') ?? defaultDemo;

function surfaceFor(name: string | null) {
  if (name === 'chat') {
    return <FamiliarsShell />;
  }

  if (name === 'messages') {
    return <DemoShell />;
  }

  return name === 'minimal' ? <MinimalMacOS /> : <App />;
}

createRoot(rootElement).render(<StrictMode>{surfaceFor(demo)}</StrictMode>);
