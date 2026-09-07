import { defineConfig } from '@playwright/test';

const port = process.env.PORT ?? '4318';
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: 'list',
  use: { baseURL, browserName: 'chromium', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: 'node server.mjs',
    url: baseURL,
    timeout: 15_000,
    // App-managed demo servers can be reused. Mutation checks must force a fresh server.
    reuseExistingServer: !process.env.CI && process.env.JOURNEYPROOF_FRESH_SERVER !== '1'
      && process.env.JOURNEYPROOF_BROKEN_DISCOUNT !== '1',
    env: { PORT: port },
  },
});
