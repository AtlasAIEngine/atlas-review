import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { testTimeout: 20000, hookTimeout: 20000, env: { ATLAS_DISABLE_CLI_PROVIDER_DETECTION: 'true' } } });
