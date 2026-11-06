import { defineConfig, devices } from '@playwright/test';
import net from 'node:net';

async function isPortAvailable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();

    server.on('error', () => {
      resolve(false);
    });

    server.listen({ host, port }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function reserveEphemeralPort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();

    server.on('error', (error) => {
      reject(error);
    });

    server.listen({ host, port: 0 }, () => {
      const address = server.address();
      const resolvedPort =
        typeof address === 'object' && address && typeof address.port === 'number'
          ? address.port
          : null;

      if (!resolvedPort) {
        server.close(() => reject(new Error('Failed to reserve ephemeral port')));
        return;
      }

      server.close(() => resolve(resolvedPort));
    });
  });
}

async function findAvailablePort(startPort: number, range = 250): Promise<number> {
  for (let port = startPort; port < startPort + range; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  return reserveEphemeralPort();
}

function parsePreferredPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`Invalid ${name}: "${raw}"`);
  }
  return parsed;
}

const backendPort = await findAvailablePort(parsePreferredPort('PW_BACKEND_PORT', 3217));
const frontendPort = await findAvailablePort(parsePreferredPort('PW_FRONTEND_PORT', 5176));
const apiBaseUrl = process.env.PW_API_BASE_URL || `http://127.0.0.1:${backendPort}/api`;
const uiBaseUrl = process.env.PW_BASE_URL || `http://127.0.0.1:${frontendPort}`;
const backendDbPath = `/tmp/atlas-branch-review-playwright-${backendPort}.sqlite`;
const backendDataDir = `/tmp/atlas-branch-review-playwright-data-${backendPort}`;
const reviewTestProviderDelayMs = process.env.ATLAS_REVIEW_TEST_PROVIDER_DELAY_MS || '1200';

// Ensure worker processes and test files consume the same dynamically-selected endpoints.
process.env.PW_BACKEND_PORT = String(backendPort);
process.env.PW_FRONTEND_PORT = String(frontendPort);
process.env.PW_API_BASE_URL = apiBaseUrl;
process.env.PW_BASE_URL = uiBaseUrl;
process.env.ATLAS_REVIEW_TEST_PROVIDER_DELAY_MS = reviewTestProviderDelayMs;

export default defineConfig({
  testDir: './tests',
  testMatch: 'branch-review-workflow.spec.ts',
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 10 * 60 * 1000,
  reporter: 'html',
  use: {
    baseURL: uiBaseUrl,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: [
    {
      command: [
        `rm -f ${backendDbPath}`,
        '&&',
        `rm -rf ${backendDataDir}`,
        '&&',
        `PORT=${backendPort}`,
        'NODE_ENV=test',
        'ATLAS_BIND_HOST=127.0.0.1',
        'ATLAS_DESKTOP_MODE=true',
        'ATLAS_DISABLE_CLI_PROVIDER_DETECTION=1',
        'ATLAS_REVIEW_TEST_PROVIDER=1',
        `ATLAS_REVIEW_TEST_PROVIDER_DELAY_MS=${reviewTestProviderDelayMs}`,
        'ATLAS_DB_TYPE=sqlite',
        `ATLAS_DB_PATH=${backendDbPath}`,
        `ATLAS_DATA_DIR=${backendDataDir}`,
        'node backend/server.js',
      ].join(' '),
      cwd: '..',
      url: `http://127.0.0.1:${backendPort}/health`,
      reuseExistingServer: false,
      timeout: 120 * 1000,
    },
    {
      command: `VITE_API_BASE_URL=${apiBaseUrl} npm run dev -- --host 127.0.0.1 --port ${frontendPort}`,
      url: uiBaseUrl,
      reuseExistingServer: false,
      timeout: 120 * 1000,
    },
  ],
});
