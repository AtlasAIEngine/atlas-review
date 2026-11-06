import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { AtlasApiClient } from '../dist/src/client.js';

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { server, port };
}

test('runBranchReview respects per-request timeout override', async (t) => {
  const { server, port } = await startServer((req, res) => {
    if (
      req.method === 'POST'
      && req.url === '/api/projects/p1/branch-reviews/br1/review'
    ) {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ success: true, branchReview: { id: 'br1', reviewStatus: 'reviewing' } }));
      }, 120);
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Not found' }));
  });
  t.after(() => {
    server.close();
  });

  const client = new AtlasApiClient({
    backendUrl: `http://127.0.0.1:${port}/api`,
    apiToken: null,
    autoImport: false,
    requestTimeoutMs: 60,
    enableWatcherSync: false,
  });

  await assert.rejects(
    () => client.runBranchReview('p1', 'br1'),
    (error) => error && error.code === 'REQUEST_TIMEOUT'
  );

  const result = await client.runBranchReview('p1', 'br1', { timeoutMs: 400 });
  assert.equal(result.branchReview?.reviewStatus, 'reviewing');
});
