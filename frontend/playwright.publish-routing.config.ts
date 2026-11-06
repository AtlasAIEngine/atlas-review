import { defineConfig, devices } from '@playwright/test';
import net from 'node:net';

async function isPortAvailable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();

    server.on('error', () => resolve(false));
    server.listen({ host, port }, () => {
      server.close(() => resolve(true));
    });
  });
}

async function reserveEphemeralPort(host = '127.0.0.1'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();

    server.on('error', reject);
    server.listen({ host, port: 0 }, () => {
      const address = server.address();
      const port =
        typeof address === 'object' && address && typeof address.port === 'number'
          ? address.port
          : null;

      if (!port) {
        server.close(() => reject(new Error('Failed to reserve ephemeral port')));
        return;
      }

      server.close(() => resolve(port));
    });
  });
}

async function findAvailablePort(startPort: number, range = 200): Promise<number> {
  for (let port = startPort; port < startPort + range; port += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortAvailable(port)) return port;
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

const backendPort = await findAvailablePort(parsePreferredPort('PW_BACKEND_PORT', 43367));
const frontendPort = await findAvailablePort(parsePreferredPort('PW_FRONTEND_PORT', 54246));
const apiBaseUrl = process.env.PW_API_BASE_URL || `http://127.0.0.1:${backendPort}/api`;
const uiBaseUrl = process.env.PW_BASE_URL || `http://127.0.0.1:${frontendPort}`;
const dbPath = `/tmp/atlas-publish-routing-${backendPort}.sqlite`;
const dataDir = `/tmp/atlas-publish-routing-${backendPort}-data`;

process.env.PW_BACKEND_PORT = String(backendPort);
process.env.PW_FRONTEND_PORT = String(frontendPort);
process.env.PW_API_BASE_URL = apiBaseUrl;
process.env.PW_BASE_URL = uiBaseUrl;

export default defineConfig({
  testDir: './tests',
  testMatch: 'publish-modal-routing.spec.ts',
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 5 * 60 * 1000,
  reporter: 'html',
  globalSetup: './tests/global-setup.ts',
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
        `rm -f ${dbPath}`,
        '&&',
        `rm -rf ${dataDir}`,
        '&&',
        `PORT=${backendPort}`,
        'ATLAS_BIND_HOST=127.0.0.1',
        'ATLAS_DESKTOP_MODE=true',
        'ATLAS_DISABLE_CLI_PROVIDER_DETECTION=1',
        'ATLAS_DB_TYPE=sqlite',
        `ATLAS_DB_PATH=${dbPath}`,
        `ATLAS_DATA_DIR=${dataDir}`,
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
