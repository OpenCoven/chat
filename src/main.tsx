import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app';
import { ChatDemo } from './demo/chat-demo';
import './demo/chat-demo.css';
import './styles.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('OpenCoven Chat root element was not found.');
}

/**
 * `?demo=chat` renders the proof-of-concept chat surface instead of the Phase 0
 * scaffold.
 *
 * A query flag rather than a replacement: the scaffold is still what the app
 * is, and what its tests and the desktop smoke check assert. The demo is a
 * preview of Phases 1 through 3 driven entirely by local mock data, and it is
 * meant to be deleted when the real read and send paths land.
 */
const isChatDemo = new URLSearchParams(window.location.search).get('demo') === 'chat';

createRoot(rootElement).render(<StrictMode>{isChatDemo ? <ChatDemo /> : <App />}</StrictMode>);
