import { defineConfig, devices } from '@playwright/test';

const chromiumExecutablePath = process.env.PW_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: './tests',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: true,
  retries: 0,
  reporter: 'html',
  globalSetup: './tests/global-setup.ts',
  outputDir: './test-results',
  use: {
    baseURL: process.env.PW_BASE_URL || 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'on',
    video: 'retain-on-failure',
    launchOptions: chromiumExecutablePath
      ? { executablePath: chromiumExecutablePath }
      : undefined,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
