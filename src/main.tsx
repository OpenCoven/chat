import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ChatApp } from './coven/chat-app';
import { Onboarding } from './onboarding/onboarding';
import './styles.css';
import './ui/ui.css';

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('OpenCoven Chat root element was not found.');
}

createRoot(rootElement).render(
  <StrictMode>
    <Onboarding>
      <ChatApp />
    </Onboarding>
  </StrictMode>,
);
