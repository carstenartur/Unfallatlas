import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['html'],
    ['list'],
    ['junit', { outputFile: 'test-results/junit.xml' }]
  ],
  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:8000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    ignoreHTTPSErrors: true,
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      // The context-data browser contract has its own project because its
      // runner first creates a fresh, isolated Bonn dataset from real sources.
      testIgnore: [/demo\.spec/, /context-data-render\.spec/],
    },
    {
      name: 'context-data-e2e',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /context-data-render\.spec/,
    },
    {
      name: 'demo',
      use: {
        ...devices['Desktop Chrome'],
        video: 'on',
        viewport: { width: 1280, height: 720 },
      },
      testMatch: /demo\.spec/,
    },
    // Cross-Browser Smoke-Tests (Firefox + WebKit)
    {
      name: 'firefox-smoke',
      use: { ...devices['Desktop Firefox'] },
      testMatch: /smoke\.spec/,
    },
    {
      name: 'webkit-smoke',
      use: { ...devices['Desktop Safari'] },
      testMatch: /smoke\.spec/,
    },
  ],

  // Only start a local web server when not targeting a live/remote BASE_URL.
  // The generated-context runner supplies BASE_URL and owns its isolated server.
  webServer: process.env.BASE_URL ? undefined : {
    command: 'npm run serve:site',
    url: 'http://localhost:8000',
    // A foreign/stale server on port 8000 must never satisfy screenshot or
    // E2E checks for the current checkout.
    reuseExistingServer: false,
    timeout: 120 * 1000,
  },
});
