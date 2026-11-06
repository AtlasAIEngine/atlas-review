import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { detectInstalledAgents } from '../dist/src/setup/detector.js';

async function writeText(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

test('detectInstalledAgents reports installed/configured state and support metadata', async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-home-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-cwd-'));
  t.after(async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  });

  await writeText(
    path.join(homeDir, '.claude.json'),
    JSON.stringify(
      {
        mcpServers: {
          'atlas-review': { command: 'node', args: ['server.js'], env: {} },
        },
      },
      null,
      2
    )
  );
  await writeText(
    path.join(homeDir, '.codex', 'config.toml'),
    ['[mcp_servers."atlas-review"]', 'command = "node"', 'args = ["server.js"]', ''].join('\n')
  );
  await writeText(
    path.join(homeDir, '.gemini', 'settings.json'),
    JSON.stringify({ mcpServers: { 'atlas-review': { command: 'node', args: ['server.js'] } } }, null, 2)
  );
  await writeText(path.join(homeDir, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: {} }, null, 2));

  const agents = await detectInstalledAgents(
    {
      homeDir,
      cwd,
      platform: 'linux',
    },
    { serverName: 'atlas-review' }
  );

  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const claudeCode = byId.get('claude-code');
  const codex = byId.get('codex');
  const gemini = byId.get('gemini');
  const cursor = byId.get('cursor');
  const vscode = byId.get('vscode');

  assert.ok(claudeCode);
  assert.equal(claudeCode.isInstalled, true);
  assert.equal(claudeCode.alreadyConfigured, true);
  assert.equal(
    claudeCode.selectedConfigPath,
    path.join(homeDir, '.claude.json')
  );

  assert.ok(codex);
  assert.equal(codex.isInstalled, true);
  assert.equal(codex.alreadyConfigured, true);
  assert.equal(codex.parseError, null);

  assert.ok(gemini);
  assert.equal(gemini.isInstalled, true);
  assert.equal(gemini.alreadyConfigured, true);
  assert.equal(gemini.parseError, null);
  assert.equal(
    gemini.selectedConfigPath,
    path.join(homeDir, '.gemini', 'settings.json')
  );

  assert.ok(cursor);
  assert.equal(cursor.isInstalled, true);
  assert.equal(cursor.alreadyConfigured, false);
  assert.equal(cursor.supportStatus, 'experimental');
  assert.equal(cursor.autoWriteSupported, false);

  assert.ok(vscode);
  assert.equal(vscode.isInstalled, false);
  assert.equal(vscode.alreadyConfigured, false);
  assert.equal(
    vscode.selectedConfigPath,
    path.join(homeDir, '.config', 'Code', 'User', 'mcp.json')
  );
});

test('detectInstalledAgents prefers verified Claude Code config paths', async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-home-verified-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-cwd-verified-'));
  t.after(async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  });

  await writeText(
    path.join(cwd, '.mcp.json'),
    JSON.stringify(
      {
        mcpServers: {
          'atlas-review': { command: 'node', args: ['server.js'], env: {} },
        },
      },
      null,
      2
    )
  );

  const agents = await detectInstalledAgents(
    {
      homeDir,
      cwd,
      platform: 'linux',
    },
    { serverName: 'atlas-review' }
  );
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const claudeCode = byId.get('claude-code');

  assert.ok(claudeCode);
  assert.equal(claudeCode.isInstalled, true);
  assert.equal(claudeCode.alreadyConfigured, true);
  assert.equal(
    claudeCode.selectedConfigPath,
    path.join(cwd, '.mcp.json')
  );
});

test('detectInstalledAgents uses ~/.cursor/mcp.json on macOS, not the VS Code user data dir', async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-home-cursor-darwin-'));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-cwd-cursor-darwin-'));
  t.after(async () => {
    await fs.rm(homeDir, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  });

  // Cursor does not load MCP servers from this path — it should be ignored.
  await writeText(
    path.join(homeDir, 'Library', 'Application Support', 'Cursor', 'User', 'mcp.json'),
    JSON.stringify(
      { mcpServers: { 'atlas-review': { command: 'node', args: ['server.js'], env: {} } } },
      null,
      2
    )
  );
  const cursorPath = path.join(homeDir, '.cursor', 'mcp.json');
  await writeText(
    cursorPath,
    JSON.stringify(
      { mcpServers: { 'atlas-review': { command: 'node', args: ['server.js'], env: {} } } },
      null,
      2
    )
  );

  const agents = await detectInstalledAgents(
    {
      homeDir,
      cwd,
      platform: 'darwin',
    },
    { serverName: 'atlas-review' }
  );
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const cursor = byId.get('cursor');

  assert.ok(cursor);
  assert.equal(cursor.isInstalled, true);
  assert.equal(cursor.alreadyConfigured, true);
  assert.equal(cursor.selectedConfigPath, cursorPath);
});
