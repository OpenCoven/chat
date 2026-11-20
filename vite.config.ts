import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { devPort } from './scripts/dev-port.mjs';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    // 4173 unless OPENCOVEN_CHAT_DEV_PORT says otherwise (scripts/dev-port.mjs).
    port: devPort(),
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4174,
    strictPort: true,
  },
});
