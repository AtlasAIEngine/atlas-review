import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';

import { AtlasApiClient } from '../dist/src/client.js';

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { server, port };
}

async function writeDiscoveryFile(dir, port, overrides = {}) {
  const entry = {
    schemaVersion: 1,
    host: '127.0.0.1',
    port,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    appVersion: '0.0.0-test',
    ...overrides,
  };
  fs.writeFileSync(path.join(dir, 'backend-port.json'), JSON.stringify(entry), 'utf8');
}

const baseConfig = (backendUrl) => ({
  backendUrl,
  apiToken: null,
  autoImport: false,
  requestTimeoutMs: 2000,
  enableWatcherSync: false,
});

test('client prefers the discovery URL over a stale configured URL', async (t) => {
  const discoveryDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atlas-disc-'));
  process.env.ATLAS_DESKTOP_DATA_DIR = discoveryDir;
  t.after(async () => {
    delete process.env.ATLAS_DESKTOP_DATA_DIR;
    await fsp.rm(discoveryDir, { recursive: true, force: true });
  });

  const liveHits = [];
  const { server: liveServer, port: livePort } = await startServer((req, res) => {
    liveHits.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, projects: [{ id: 'live' }] }));
  });
  t.after(() => liveServer.close());

  await writeDiscoveryFile(discoveryDir, livePort);

  // Configured URL points at a closed port (1 is guaranteed refused for non-root).
  const client = new AtlasApiClient(baseConfig('http://127.0.0.1:1/api'));
  const projects = await client.getProjects();

  assert.equal(projects[0]?.id, 'live');
  assert.ok(liveHits.length > 0, 'discovery URL must have been used');
});

test('client falls back to configured URL when discovery points at a dead port', async (t) => {
  const discoveryDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atlas-disc-'));
  process.env.ATLAS_DESKTOP_DATA_DIR = discoveryDir;
  t.after(async () => {
    delete process.env.ATLAS_DESKTOP_DATA_DIR;
    await fsp.rm(discoveryDir, { recursive: true, force: true });
  });

  const fallbackHits = [];
  const { server: fallbackServer, port: fallbackPort } = await startServer((req, res) => {
    fallbackHits.push(req.url);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, projects: [{ id: 'fallback' }] }));
  });
  t.after(() => fallbackServer.close());

  // Discovery file points at a port that is not listening.
  // Start a server on another port, close it, use that dead port.
  const { server: deadServer, port: deadPort } = await startServer(() => {});
  await new Promise((resolve) => deadServer.close(resolve));
  await writeDiscoveryFile(discoveryDir, deadPort);

  const client = new AtlasApiClient(baseConfig(`http://127.0.0.1:${fallbackPort}/api`));
  const projects = await client.getProjects();

  assert.equal(projects[0]?.id, 'fallback');
  assert.ok(fallbackHits.length > 0, 'configured URL must have been used as fallback');
});

test('client ignores malformed discovery files and uses configured URL', async (t) => {
  const discoveryDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atlas-disc-'));
  process.env.ATLAS_DESKTOP_DATA_DIR = discoveryDir;
  t.after(async () => {
    delete process.env.ATLAS_DESKTOP_DATA_DIR;
    await fsp.rm(discoveryDir, { recursive: true, force: true });
  });

  fs.writeFileSync(path.join(discoveryDir, 'backend-port.json'), 'not-json-at-all', 'utf8');

  const { server, port } = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, projects: [{ id: 'configured' }] }));
  });
  t.after(() => server.close());

  const client = new AtlasApiClient(baseConfig(`http://127.0.0.1:${port}/api`));
  const projects = await client.getProjects();
  assert.equal(projects[0]?.id, 'configured');
});

test('client ignores discovery whose pid is no longer alive', async (t) => {
  const discoveryDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'atlas-disc-'));
  process.env.ATLAS_DESKTOP_DATA_DIR = discoveryDir;
  t.after(async () => {
    delete process.env.ATLAS_DESKTOP_DATA_DIR;
    await fsp.rm(discoveryDir, { recursive: true, force: true });
  });

  // Use a pid that is almost certainly not alive. The platform will return
  // ESRCH for `process.kill(pid, 0)` and our check will treat it as dead.
  await writeDiscoveryFile(discoveryDir, 12_345, { pid: 999_999_999 });

  const { server, port } = await startServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, projects: [{ id: 'configured' }] }));
  });
  t.after(() => server.close());

  const client = new AtlasApiClient(baseConfig(`http://127.0.0.1:${port}/api`));
  const projects = await client.getProjects();
  assert.equal(projects[0]?.id, 'configured', 'should have skipped dead-pid discovery');
});
