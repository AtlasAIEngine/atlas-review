import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { removeAgentConfig, writeAgentConfig } from '../dist/src/setup/configWriter.js';

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listBackupFiles(configPath) {
  const dir = path.dirname(configPath);
  const base = path.basename(configPath);
  const entries = await fs.readdir(dir);
  return entries.filter((name) => name.startsWith(`${base}.`) && name.endsWith('.bak'));
}

test('writeAgentConfig + removeAgentConfig safely update JSON configs', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-json-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const configPath = path.join(tempRoot, 'claude', 'mcp.json');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        mcpServers: {
          existing: {
            command: 'node',
            args: ['existing.js'],
            env: {},
          },
        },
        untouchedRootKey: true,
      },
      null,
      2
    ),
    'utf8'
  );

  const writeResult = await writeAgentConfig({
    agentId: 'claude-code',
    configPath,
    backendUrl: '127.0.0.1:5999',
    serverBinaryPath: path.join(tempRoot, 'server.js'),
    homeDir: tempRoot,
    cwd: tempRoot,
    platform: 'linux',
  });

  assert.equal(writeResult.changed, true);
  assert.equal(writeResult.created, false);
  assert.ok(writeResult.backupPath);
  assert.equal(await pathExists(writeResult.backupPath), true);

  const written = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(written.untouchedRootKey, true);
  assert.ok(written.mcpServers.existing);
  assert.ok(written.mcpServers['atlas-review']);
  assert.equal(
    written.mcpServers['atlas-review'].env.ATLAS_BACKEND_URL,
    'http://127.0.0.1:5999/api'
  );

  const removeResult = await removeAgentConfig({
    agentId: 'claude-code',
    configPath,
    backendUrl: '127.0.0.1:5999',
    serverBinaryPath: path.join(tempRoot, 'server.js'),
    homeDir: tempRoot,
    cwd: tempRoot,
    platform: 'linux',
  });

  assert.equal(removeResult.changed, true);
  assert.equal(removeResult.removed, true);
  assert.ok(removeResult.backupPath);
  assert.equal(await pathExists(removeResult.backupPath), true);

  const removed = JSON.parse(await fs.readFile(configPath, 'utf8'));
  assert.equal(Boolean(removed.mcpServers['atlas-review']), false);
  assert.ok(removed.mcpServers.existing);
});

test('writeAgentConfig + removeAgentConfig safely update TOML configs', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-toml-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const configPath = path.join(tempRoot, '.codex', 'config.toml');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    [
      '[general]',
      'theme = "dark"',
      '',
      '[mcp_servers."atlas-review"]',
      'command = "node"',
      'args = ["old.js"]',
      '',
      '[mcp_servers."atlas-review".env]',
      'ATLAS_BACKEND_URL = "http://127.0.0.1:1111/api"',
      '',
    ].join('\n'),
    'utf8'
  );

  const serverBinaryPath = path.join(tempRoot, 'new-server.js');
  await writeAgentConfig({
    agentId: 'codex',
    configPath,
    backendUrl: 'http://127.0.0.1:6111/api',
    serverBinaryPath,
    homeDir: tempRoot,
    cwd: tempRoot,
    platform: 'linux',
  });

  const written = await fs.readFile(configPath, 'utf8');
  assert.equal((written.match(/\[mcp_servers\.(?:"atlas-review"|atlas-review)\]/g) || []).length, 1);
  assert.equal(
    written.includes(`args = ["${serverBinaryPath.replace(/\\/g, '\\\\')}"]`),
    true
  );
  assert.equal(
    written.includes('ATLAS_BACKEND_URL = "http://127.0.0.1:6111/api"'),
    true
  );

  await removeAgentConfig({
    agentId: 'codex',
    configPath,
    backendUrl: 'http://127.0.0.1:6111/api',
    serverBinaryPath,
    homeDir: tempRoot,
    cwd: tempRoot,
    platform: 'linux',
  });

  const removed = await fs.readFile(configPath, 'utf8');
  assert.equal(removed.includes('[mcp_servers."atlas-review"]') || removed.includes('[mcp_servers.atlas-review]'), false);
  assert.equal(removed.includes('[mcp_servers."atlas-review".env]') || removed.includes('[mcp_servers.atlas-review.env]'), false);
  assert.equal(removed.includes('[general]'), true);
});

test('writeAgentConfig prunes old backup files', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-backups-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const configPath = path.join(tempRoot, 'claude', 'mcp.json');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify({ mcpServers: {} }, null, 2),
    'utf8'
  );

  for (let index = 0; index < 8; index += 1) {
    await writeAgentConfig({
      agentId: 'claude-code',
      configPath,
      backendUrl: `127.0.0.1:${6100 + index}`,
      serverBinaryPath: path.join(tempRoot, 'server.js'),
      homeDir: tempRoot,
      cwd: tempRoot,
      platform: 'linux',
    });
  }

  const backups = await listBackupFiles(configPath);
  assert.equal(backups.length <= 5, true);
});

test('writeAgentConfig surfaces actionable error for invalid JSON', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-invalid-json-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const configPath = path.join(tempRoot, '.claude', 'mcp.json');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, '{ invalid json', 'utf8');

  await assert.rejects(
    () => writeAgentConfig({
      agentId: 'claude-code',
      configPath,
      backendUrl: '127.0.0.1:6333',
      serverBinaryPath: path.join(tempRoot, 'server.js'),
      homeDir: tempRoot,
      cwd: tempRoot,
      platform: 'linux',
    }),
    (error) => {
      assert.match(String(error?.message || error), /contains invalid JSON/);
      assert.match(String(error?.message || error), new RegExp(configPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    }
  );
});
