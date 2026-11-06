import { defineConfig, devices } from '@playwright/test';

// Only for the rendered-screen pass in capture.review.ts; see that file.
const url = 'http://127.0.0.1:4187';

export default defineConfig({
  testDir: '.',
  testMatch: 'capture.review.ts',
  fullyParallel: true,
  reporter: 'list',
  workers: 4,
  timeout: 240_000,
  use: { baseURL: url },
  projects: [
    // The macOS window is WKWebView, so WebKit is the reference.
    { name: 'webkit', use: { ...devices['Desktop Safari'], deviceScaleFactor: 1 } },
    // Safari-style Tab skips buttons by default; the focus walk also runs here.
    {
      name: 'chromium',
      grep: /mention portal and focus/,
      use: { ...devices['Desktop Chrome'], deviceScaleFactor: 1 },
    },
  ],
  webServer: {
    command: `corepack pnpm build && corepack pnpm exec vite preview --host 127.0.0.1 --port 4187 --strictPort`,
    cwd: '../..',
    url,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
