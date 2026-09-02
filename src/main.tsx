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
 * `?demo=chat`, `?demo=minimal`, and `?demo=familiars` render a
 * proof-of-concept surface instead of the Phase 1 read-only production app.
 *
 * A query flag rather than a replacement: the read-only production app is
 * still what ships, and what the default browser and desktop checks assert.
 * Each demo is a preview of later phases driven entirely by local mock data,
 * and all of them are meant to be deleted when the real richer surfaces land.
 *
 * Three of them because they are directions, not revisions. `chat` is the
 * Messages-shaped surface; `minimal` implements the approved "Coven Cave
 * Minimal (macOS)" design; `familiars` implements the "Familiars Redesign v2"
 * design, which puts the ward — what a familiar may do alone and what it must
 * ask about — at the centre of the chat. Keeping them means the choice between
 * them can be made by looking at them side by side rather than from memory.
 */
const demo = new URLSearchParams(window.location.search).get('demo');

function surfaceFor(name: string | null) {
  if (name === 'chat') {
    return <DemoShell />;
  }

  if (name === 'familiars') {
    return <FamiliarsShell />;
  }

  return name === 'minimal' ? <MinimalMacOS /> : <App />;
}

createRoot(rootElement).render(<StrictMode>{surfaceFor(demo)}</StrictMode>);
