import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeAgentConfig } from '../configWriter.js';

async function readText(filePath: string): Promise<string> {
  return fs.readFile(filePath, 'utf8');
}

test('writeAgentConfig preserves unrelated JSON entries and becomes idempotent after first write', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-json-idempotent-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const configPath = path.join(tempRoot, '.claude.json');
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
        editorTheme: 'dark',
      },
      null,
      2
    ),
    'utf8'
  );

  const first = await writeAgentConfig({
    agentId: 'claude-code',
    configPath,
    homeDir: tempRoot,
    cwd: tempRoot,
    platform: 'linux',
    backendUrl: '127.0.0.1:6111',
    serverBinaryPath: path.join(tempRoot, 'atlas-review-mcp.js'),
  });
  const second = await writeAgentConfig({
    agentId: 'claude-code',
    configPath,
    homeDir: tempRoot,
    cwd: tempRoot,
    platform: 'linux',
    backendUrl: '127.0.0.1:6111',
    serverBinaryPath: path.join(tempRoot, 'atlas-review-mcp.js'),
  });

  const written = JSON.parse(await readText(configPath));
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(written.editorTheme, 'dark');
  assert.ok(written.mcpServers.existing);
  assert.ok(written.mcpServers['atlas-review']);
});

test('writeAgentConfig writes the documented OpenCode local MCP shape and remains idempotent', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-opencode-json-idempotent-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const configPath = path.join(tempRoot, '.config', 'opencode', 'opencode.json');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    JSON.stringify(
      {
        mcp: {
          existing: {
            type: 'local',
            command: ['node', 'existing.js'],
          },
        },
        autoupdate: false,
      },
      null,
      2
    ),
    'utf8'
  );

  const first = await writeAgentConfig({
    agentId: 'opencode',
    configPath,
    homeDir: tempRoot,
    cwd: tempRoot,
    platform: 'linux',
    backendUrl: '127.0.0.1:6111',
    serverBinaryPath: path.join(tempRoot, 'atlas-review-mcp.js'),
  });
  const second = await writeAgentConfig({
    agentId: 'opencode',
    configPath,
    homeDir: tempRoot,
    cwd: tempRoot,
    platform: 'linux',
    backendUrl: '127.0.0.1:6111',
    serverBinaryPath: path.join(tempRoot, 'atlas-review-mcp.js'),
  });

  const written = JSON.parse(await readText(configPath));
  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.equal(written.autoupdate, false);
  assert.ok(written.mcp.existing);
  assert.deepEqual(written.mcp['atlas-review'], {
    type: 'local',
    command: ['node', path.join(tempRoot, 'atlas-review-mcp.js')],
    environment: {
      ATLAS_BACKEND_URL: 'http://127.0.0.1:6111/api',
    },
    enabled: true,
  });
});

test('writeAgentConfig preserves unrelated TOML entries and becomes idempotent after first write', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-toml-idempotent-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const configPath = path.join(tempRoot, '.codex', 'config.toml');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(
    configPath,
    [
      '[general]',
      'model = "gpt-5-codex"',
      '',
      '[mcp_servers.other]',
      'command = "node"',
      'args = ["other.js"]',
      '',
    ].join('\n'),
    'utf8'
  );

  const first = await writeAgentConfig({
    agentId: 'codex',
    configPath,
    homeDir: tempRoot,
    cwd: tempRoot,
    platform: 'linux',
    backendUrl: 'http://127.0.0.1:7222/api',
    serverBinaryPath: path.join(tempRoot, 'atlas-review-mcp.js'),
  });
  const snapshot = await readText(configPath);
  const second = await writeAgentConfig({
    agentId: 'codex',
    configPath,
    homeDir: tempRoot,
    cwd: tempRoot,
    platform: 'linux',
    backendUrl: 'http://127.0.0.1:7222/api',
    serverBinaryPath: path.join(tempRoot, 'atlas-review-mcp.js'),
  });
  const rewritten = await readText(configPath);

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.match(rewritten, /\[general\]/u);
  assert.match(rewritten, /\[mcp_servers\.other\]/u);
  assert.equal(rewritten, snapshot);
});

test('writeAgentConfig fails closed on malformed JSON and leaves the file untouched', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-invalid-json-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const configPath = path.join(tempRoot, '.claude.json');
  const original = '{ invalid json';
  await fs.writeFile(configPath, original, 'utf8');

  await assert.rejects(
    () => writeAgentConfig({
      agentId: 'claude-code',
      configPath,
      homeDir: tempRoot,
      cwd: tempRoot,
      platform: 'linux',
      backendUrl: '127.0.0.1:6333',
      serverBinaryPath: path.join(tempRoot, 'atlas-review-mcp.js'),
    }),
    /contains invalid JSON/u
  );

  assert.equal(await readText(configPath), original);
});

test('writeAgentConfig fails closed on malformed TOML headers and leaves the file untouched', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-invalid-toml-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const configPath = path.join(tempRoot, '.codex', 'config.toml');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const original = ['[general', 'theme = "dark"', ''].join('\n');
  await fs.writeFile(configPath, original, 'utf8');

  await assert.rejects(
    () => writeAgentConfig({
      agentId: 'codex',
      configPath,
      homeDir: tempRoot,
      cwd: tempRoot,
      platform: 'linux',
      backendUrl: '127.0.0.1:6444',
      serverBinaryPath: path.join(tempRoot, 'atlas-review-mcp.js'),
    }),
    /contains malformed TOML/u
  );

  assert.equal(await readText(configPath), original);
});
