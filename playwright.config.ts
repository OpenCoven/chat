import { defineConfig } from '@playwright/test';

const previewUrl = 'http://127.0.0.1:4174';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: 'list',
  ...(process.env.CI ? { workers: 1 } : {}),
  use: {
    baseURL: previewUrl,
    trace: 'on-first-retry',
  },
  webServer: {
    command: 'corepack pnpm build && corepack pnpm preview',
    url: previewUrl,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
