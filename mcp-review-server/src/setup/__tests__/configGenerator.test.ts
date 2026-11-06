import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getAgentById } from '../agentRegistry.js';
import { generateAgentConfigOutput, normalizeSetupBackendUrl, resolveServerBinaryPath } from '../configGenerator.js';
import { resolveAgentConfigPaths } from '../pathResolver.js';

test('resolveServerBinaryPath returns an absolute compiled CLI path', () => {
  const serverBinaryPath = resolveServerBinaryPath();

  assert.equal(path.isAbsolute(serverBinaryPath), true);
  assert.match(serverBinaryPath, /dist[\\/]+bin[\\/]atlas-review-mcp\.js$/u);
});

test('generateAgentConfigOutput uses verified config paths and canonical MCP entry shape', async () => {
  const homeDir = path.join(os.tmpdir(), 'atlas-mcp-generator-home');
  const cwd = path.join(os.tmpdir(), 'atlas-mcp-generator-cwd');
  const output = await generateAgentConfigOutput('claude-code', {
    homeDir,
    cwd,
    platform: 'linux',
    backendUrl: 'localhost:4312',
  });

  assert.equal(output.configPath, path.join(homeDir, '.claude.json'));
  assert.deepEqual(output.jsonObject, {
    mcpServers: {
      'atlas-review': {
        command: 'node',
        args: [resolveServerBinaryPath()],
        env: {
          ATLAS_BACKEND_URL: 'http://localhost:4312/api',
        },
      },
    },
  });
});

test('generateAgentConfigOutput renders the documented OpenCode MCP entry shape', async () => {
  const homeDir = path.join(os.tmpdir(), 'atlas-mcp-opencode-home');
  const cwd = path.join(os.tmpdir(), 'atlas-mcp-opencode-cwd');
  const output = await generateAgentConfigOutput('opencode', {
    homeDir,
    cwd,
    platform: 'linux',
    backendUrl: 'localhost:4312',
  });

  assert.equal(output.configPath, path.join(homeDir, '.config', 'opencode', 'opencode.json'));
  assert.deepEqual(output.jsonObject, {
    mcp: {
      'atlas-review': {
        type: 'local',
        command: ['node', resolveServerBinaryPath()],
        environment: {
          ATLAS_BACKEND_URL: 'http://localhost:4312/api',
        },
        enabled: true,
      },
    },
  });
});

test('resolveAgentConfigPaths exposes only documented v1 write targets', () => {
  const homeDir = '/tmp/atlas-home';
  const cwd = '/tmp/atlas-cwd';
  const claudePaths = resolveAgentConfigPaths('claude-code', {
    homeDir,
    cwd,
    platform: 'darwin',
  });

  assert.deepEqual(claudePaths, [
    path.join(homeDir, '.claude.json'),
    path.join(homeDir, '.claude', 'mcp.json'),
    path.join(cwd, '.mcp.json'),
  ]);

  const cursorPaths = resolveAgentConfigPaths('cursor', {
    homeDir,
    cwd,
    platform: 'darwin',
  });

  assert.deepEqual(cursorPaths, [
    path.join(homeDir, '.cursor', 'mcp.json'),
    path.join(cwd, '.cursor', 'mcp.json'),
  ]);

  const geminiPaths = resolveAgentConfigPaths('gemini', {
    homeDir,
    cwd,
    platform: 'darwin',
  });

  assert.deepEqual(geminiPaths, [
    path.join(homeDir, '.gemini', 'settings.json'),
  ]);
  assert.equal(getAgentById('gemini')?.wrapperKey, 'mcpServers');

  const opencodePaths = resolveAgentConfigPaths('opencode', {
    homeDir,
    cwd,
    platform: 'darwin',
  });

  assert.deepEqual(opencodePaths, [
    path.join(homeDir, '.config', 'opencode', 'opencode.json'),
    path.join(homeDir, '.config', 'opencode', 'opencode.jsonc'),
  ]);
  assert.equal(getAgentById('opencode')?.wrapperKey, 'mcp');
});

test('normalizeSetupBackendUrl preserves explicit API paths while filling missing ones', () => {
  assert.equal(normalizeSetupBackendUrl('atlas.internal:7777'), 'http://atlas.internal:7777/api');
  assert.equal(normalizeSetupBackendUrl('https://atlas.internal/custom/api'), 'https://atlas.internal/custom/api');
});
