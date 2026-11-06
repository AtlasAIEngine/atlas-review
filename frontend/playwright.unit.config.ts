import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: /src\/.*\.test\.(ts|tsx)$/,
  fullyParallel: true,
  reporter: 'line',
  use: {},
});
