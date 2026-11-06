/**
 * Playwright global setup — waits for the backend to be healthy before tests run.
 * Polls the /health endpoint (default http://127.0.0.1:3101/health) for up to 60 seconds.
 */

const HEALTH_URL =
  (process.env.PW_API_BASE_URL || 'http://127.0.0.1:3101/api').replace(/\/api$/, '') + '/health';
const TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;

async function globalSetup() {
  const deadline = Date.now() + TIMEOUT_MS;
  console.log(`[global-setup] Waiting for backend at ${HEALTH_URL} ...`);

  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL);
      if (res.ok) {
        console.log('[global-setup] Backend is ready.');
        return;
      }
    } catch {
      // backend not up yet
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  throw new Error(
    `[global-setup] Backend did not become healthy within ${TIMEOUT_MS / 1000}s at ${HEALTH_URL}`
  );
}

export default globalSetup;
