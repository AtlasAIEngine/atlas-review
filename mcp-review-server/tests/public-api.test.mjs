import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  applyAutoSetup,
  getAgentConfigSnippet,
  getSetupRuntimeStatus,
  installWorkflowGuidance,
  listAgentDetection,
  listSupportedAgentMetadata,
  removeManagedIntegrations,
  removeWorkflowGuidance,
  syncAgentSetup,
} from '../dist/src/setup/publicApi.js';

test('applyAutoSetup skips experimental agents in the shipped auto-write path', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-auto-setup-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const cursorConfigPath = path.join(tempRoot, '.cursor', 'mcp.json');
  await fs.mkdir(path.dirname(cursorConfigPath), { recursive: true });
  await fs.writeFile(cursorConfigPath, JSON.stringify({ mcpServers: {} }, null, 2), 'utf8');

  const result = await applyAutoSetup({
    dryRun: true,
    homeDir: tempRoot,
    cwd: tempRoot,
    platform: 'linux',
  });

  assert.deepEqual(result.targetAgentIds, ['codex']);
});

test('applyAutoSetup falls back to codex when no agent config is detected', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-auto-fallback-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const result = await applyAutoSetup({
    dryRun: true,
    homeDir: tempRoot,
    cwd: tempRoot,
    platform: 'linux',
  });

  assert.deepEqual(result.targetAgentIds, ['codex']);
});

test('applyAutoSetup installs managed workflow guidance for the selected fallback agent', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-auto-guidance-bundle-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const result = await applyAutoSetup({
    homeDir: tempRoot,
    cwd: tempRoot,
    platform: 'linux',
  });

  assert.deepEqual(result.targetAgentIds, ['codex']);
  const skillContent = await fs.readFile(
    path.join(tempRoot, '.codex', 'skills', 'atlas-review-global', 'SKILL.md'),
    'utf8'
  );
  assert.match(skillContent, /Atlas Review Global Guidance/u);
});

test('syncAgentSetup refuses removeUnselected when selectedAgentIds is empty', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-sync-guard-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  await assert.rejects(
    () => syncAgentSetup({
      dryRun: true,
      homeDir: tempRoot,
      cwd: tempRoot,
      platform: 'linux',
      selectedAgentIds: [],
      removeUnselected: true,
    }),
    /requires at least one shipped auto-write selectedAgentId/u
  );
});

test('syncAgentSetup blocks manual-only agents from Atlas-managed writes', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-sync-manual-only-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const result = await syncAgentSetup({
    dryRun: true,
    homeDir: tempRoot,
    cwd: tempRoot,
    platform: 'linux',
    selectedAgentIds: ['cursor'],
    removeUnselected: false,
  });

  assert.deepEqual(result.selectedAgentIds, []);
  assert.equal(result.appliedResults.length, 0);
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].agentId, 'cursor');
  assert.match(result.failures[0].message, /manual-snippet-only/u);
});

test('syncAgentSetup refuses removeUnselected when only manual-only agents are selected', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-sync-remove-guard-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  await assert.rejects(
    () => syncAgentSetup({
      dryRun: true,
      homeDir: tempRoot,
      cwd: tempRoot,
      platform: 'linux',
      selectedAgentIds: ['cursor'],
      removeUnselected: true,
    }),
    /requires at least one shipped auto-write selectedAgentId/u
  );
});

test('removeManagedIntegrations clears Claude MCP config from every supported config path', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-remove-managed-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const claudeJsonPath = path.join(tempRoot, '.claude.json');
  const claudeMcpPath = path.join(tempRoot, '.claude', 'mcp.json');
  await fs.mkdir(path.dirname(claudeMcpPath), { recursive: true });
  await fs.writeFile(
    claudeJsonPath,
    JSON.stringify({
      mcpServers: {
        'atlas-review': { command: 'node', args: ['atlas-review-mcp.js'], env: { ATLAS_BACKEND_URL: 'http://127.0.0.1:3000/api' } },
        other: { command: 'node', args: ['other.js'], env: {} },
      },
    }, null, 2),
    'utf8'
  );
  await fs.writeFile(
    claudeMcpPath,
    JSON.stringify({
      mcpServers: {
        'atlas-review': { command: 'node', args: ['atlas-review-mcp.js'], env: { ATLAS_BACKEND_URL: 'http://127.0.0.1:3000/api' } },
      },
    }, null, 2),
    'utf8'
  );

  const result = await removeManagedIntegrations({
    homeDir: tempRoot,
    cwd: tempRoot,
    platform: 'darwin',
  });

  assert.equal(result.failures.length, 0);
  const claudeJson = JSON.parse(await fs.readFile(claudeJsonPath, 'utf8'));
  const claudeMcp = JSON.parse(await fs.readFile(claudeMcpPath, 'utf8'));
  assert.equal(Object.prototype.hasOwnProperty.call(claudeJson.mcpServers, 'atlas-review'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(claudeJson.mcpServers, 'other'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(claudeMcp, 'mcpServers'), false);
});

test('listSupportedAgentMetadata exposes shared guidance for shipped and manual-only agents', () => {
  const supportedAgents = listSupportedAgentMetadata({
    backendUrl: 'http://127.0.0.1:3000/api',
  });

  const codex = supportedAgents.find((agent) => agent.id === 'codex');
  assert.ok(codex);
  assert.equal(codex.docsUrl, 'https://developers.openai.com/resources/docs-mcp');
  assert.equal(codex.supportLabel, 'Shipped auto-write');
  assert.match(codex.restartHint, /Restart Codex session/u);
  assert.match(codex.recommendedCommands.preferred, /setup --agent=codex/u);
  assert.equal(codex.workflowGuidance.strategyId, 'codex_global_skill');
  assert.match(codex.workflowGuidance.snippet, /Atlas Review Global Guidance/u);
  assert.equal(codex.workflowGuidanceState.status, 'not_installed');

  const gemini = supportedAgents.find((agent) => agent.id === 'gemini');
  assert.ok(gemini);
  assert.equal(gemini.docsUrl, 'https://github.com/google-gemini/gemini-cli');
  assert.equal(gemini.supportLabel, 'Shipped auto-write');
  assert.equal(gemini.autoWriteSupported, true);
  assert.match(gemini.restartHint, /Restart Gemini CLI session/u);
  assert.match(gemini.recommendedCommands.preferred, /setup --agent=gemini/u);
  assert.equal(gemini.workflowGuidance, null);
  assert.equal(gemini.workflowGuidanceState.status, 'not_supported');

  const opencode = supportedAgents.find((agent) => agent.id === 'opencode');
  assert.ok(opencode);
  assert.equal(opencode.docsUrl, 'https://opencode.ai/docs/mcp-servers/');
  assert.equal(opencode.supportLabel, 'Shipped auto-write');
  assert.equal(opencode.autoWriteSupported, true);
  assert.match(opencode.restartHint, /Restart the active OpenCode session/u);
  assert.match(opencode.recommendedCommands.preferred, /setup --agent=opencode/u);
  assert.equal(opencode.workflowGuidance.strategyId, 'opencode_global_skill');
  assert.match(opencode.workflowGuidance.snippet, /Atlas Review Global Guidance for OpenCode/u);
  assert.equal(opencode.workflowGuidanceState.status, 'not_installed');

  const cursor = supportedAgents.find((agent) => agent.id === 'cursor');
  assert.ok(cursor);
  assert.equal(cursor.docsUrl, 'https://docs.cursor.com/context/model-context-protocol');
  assert.equal(cursor.supportLabel, 'Manual snippet only');
  assert.equal(cursor.autoWriteSupported, false);
  assert.match(cursor.recommendedCommands.preferred, /setup --agent=cursor --json/u);
  assert.equal(cursor.workflowGuidance, null);
});

test('getAgentConfigSnippet includes shared guidance alongside snippet output', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-public-guidance-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const result = await getAgentConfigSnippet('claude-code', {
    backendUrl: 'http://127.0.0.1:3100/api',
    homeDir: tempRoot,
    cwd: tempRoot,
    platform: 'linux',
  });

  assert.equal(result.agent.docsUrl, 'https://code.claude.com/docs/en/mcp');
  assert.equal(result.agent.supportLabel, 'Shipped auto-write');
  assert.match(result.agent.restartHint, /Restart Claude Code session/u);
  assert.match(result.agent.recommendedCommands.preferred, /--agent=claude-code/u);
  assert.match(result.agent.recommendedCommands.dryRun, /--dry-run/u);
  assert.match(result.agent.recommendedCommands.snippet, /--json/u);
  assert.equal(result.agent.workflowGuidance.strategyId, 'claude_global_guidance');
  assert.match(result.agent.workflowGuidance.snippet, /atlas-review-global:start/u);
  assert.equal(result.agent.workflowGuidanceState.status, 'not_installed');
  assert.equal(result.configPath, path.join(tempRoot, '.claude.json'));
  assert.match(result.snippet, /ATLAS_BACKEND_URL/u);
  assert.equal(result.agent.workflowGuidanceState.detectedPath, path.join(tempRoot, '.claude', 'CLAUDE.md'));
});

test('listAgentDetection reports codex workflow guidance as not installed when the canonical skill is missing', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-guidance-missing-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const detected = await listAgentDetection({
    homeDir: tempRoot,
    cwd: tempRoot,
    platform: 'linux',
  });

  const codex = detected.find((agent) => agent.id === 'codex');
  assert.ok(codex);
  assert.equal(codex.workflowGuidanceState.status, 'not_installed');
  assert.match(codex.workflowGuidanceState.summary, /atlas-review-global\/SKILL\.md/u);
  assert.equal(
    codex.workflowGuidanceState.detectedPath,
    path.join(tempRoot, '.codex', 'skills', 'atlas-review-global', 'SKILL.md')
  );

  const claude = detected.find((agent) => agent.id === 'claude-code');
  assert.ok(claude);
  assert.equal(claude.workflowGuidanceState.status, 'not_installed');
  assert.equal(
    claude.workflowGuidanceState.detectedPath,
    path.join(tempRoot, '.claude', 'CLAUDE.md')
  );

  const opencode = detected.find((agent) => agent.id === 'opencode');
  assert.ok(opencode);
  assert.equal(opencode.workflowGuidanceState.status, 'not_installed');
  assert.equal(
    opencode.workflowGuidanceState.detectedPath,
    path.join(tempRoot, '.config', 'opencode', 'skills', 'atlas-review-global', 'SKILL.md')
  );
});

test('getAgentConfigSnippet reports codex workflow guidance as installed when the canonical skill is present', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-guidance-installed-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const skillPath = path.join(tempRoot, '.codex', 'skills', 'atlas-review-global', 'SKILL.md');
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(
    skillPath,
    `---
name: atlas-review-global
description: Use Atlas MCP for Atlas-named review requests and persist findings outcomes before concluding.
---

# Atlas Review Global Guidance

Use Atlas MCP when the user explicitly asks for Atlas review.
`,
    'utf8'
  );

  const result = await getAgentConfigSnippet('codex', {
    backendUrl: 'http://127.0.0.1:3100/api',
    homeDir: tempRoot,
    cwd: tempRoot,
    platform: 'linux',
  });

  assert.equal(result.agent.workflowGuidanceState.status, 'installed');
  assert.equal(result.agent.workflowGuidanceState.label, 'Installed');
  assert.equal(result.agent.workflowGuidanceState.detectedPath, skillPath);
  assert.match(result.agent.workflowGuidanceState.summary, /Detected the global Codex Atlas skill/u);
});

test('installWorkflowGuidance writes the canonical codex global skill and becomes detectable', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-guidance-install-api-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const result = await installWorkflowGuidance('codex', {
    homeDir: tempRoot,
    cwd: tempRoot,
  });

  const skillPath = path.join(tempRoot, '.codex', 'skills', 'atlas-review-global', 'SKILL.md');
  const content = await fs.readFile(skillPath, 'utf8');

  assert.equal(result.agentId, 'codex');
  assert.equal(result.changed, true);
  assert.equal(result.targetPath, skillPath);
  assert.equal(result.statusAfter.status, 'installed');
  assert.match(content, /name: atlas-review-global/u);
  assert.match(content, /Atlas Review Global Guidance/u);
});

test('installWorkflowGuidance writes the canonical opencode global skill and becomes detectable', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-opencode-guidance-install-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const result = await installWorkflowGuidance('opencode', {
    homeDir: tempRoot,
    cwd: tempRoot,
    platform: 'linux',
  });

  const skillPath = path.join(tempRoot, '.config', 'opencode', 'skills', 'atlas-review-global', 'SKILL.md');
  const skillContent = await fs.readFile(skillPath, 'utf8');
  assert.equal(result.targetPath, skillPath);
  assert.equal(result.statusAfter.status, 'installed');
  assert.match(skillContent, /compatibility: opencode/u);
  assert.match(skillContent, /Atlas Review Global Guidance for OpenCode/u);
});

test('installWorkflowGuidance honors CODEX_HOME in normal runtime resolution', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-guidance-codex-home-'));
  const codexHome = path.join(tempRoot, 'codex-home');
  const originalCodexHome = process.env.CODEX_HOME;
  const originalHome = process.env.HOME;
  process.env.CODEX_HOME = codexHome;
  process.env.HOME = tempRoot;
  t.after(async () => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const result = await installWorkflowGuidance('codex', {
    homeDir: tempRoot,
    cwd: tempRoot,
  });

  const skillPath = path.join(codexHome, 'skills', 'atlas-review-global', 'SKILL.md');
  assert.equal(result.targetPath, skillPath);
  assert.equal(await fs.readFile(skillPath, 'utf8').then((content) => /Atlas Review Global Guidance/u.test(content)), true);
});

test('installWorkflowGuidance still honors explicit homeDir overrides over CODEX_HOME', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-guidance-codex-home-override-'));
  const explicitHome = path.join(tempRoot, 'override-home');
  const codexHome = path.join(tempRoot, 'codex-home');
  const originalCodexHome = process.env.CODEX_HOME;
  const originalHome = process.env.HOME;
  process.env.CODEX_HOME = codexHome;
  process.env.HOME = tempRoot;
  t.after(async () => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const result = await installWorkflowGuidance('codex', {
    homeDir: explicitHome,
    cwd: explicitHome,
  });

  const overrideSkillPath = path.join(explicitHome, '.codex', 'skills', 'atlas-review-global', 'SKILL.md');
  assert.equal(result.targetPath, overrideSkillPath);
  assert.equal(await fs.readFile(overrideSkillPath, 'utf8').then((content) => /Atlas Review Global Guidance/u.test(content)), true);
});

test('installWorkflowGuidance still treats equivalent homeDir strings as the runtime home when CODEX_HOME is set', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-guidance-codex-home-equivalent-'));
  const codexHome = path.join(tempRoot, 'codex-home');
  const originalCodexHome = process.env.CODEX_HOME;
  const originalHome = process.env.HOME;
  process.env.CODEX_HOME = codexHome;
  process.env.HOME = tempRoot;
  t.after(async () => {
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const result = await installWorkflowGuidance('codex', {
    homeDir: `${tempRoot}/`,
    cwd: tempRoot,
  });

  const skillPath = path.join(codexHome, 'skills', 'atlas-review-global', 'SKILL.md');
  assert.equal(result.targetPath, skillPath);
  assert.equal(await fs.readFile(skillPath, 'utf8').then((content) => /Atlas Review Global Guidance/u.test(content)), true);
});

test('installWorkflowGuidance writes the managed claude guidance block and becomes detectable', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-guidance-install-claude-api-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const result = await installWorkflowGuidance('claude-code', {
    homeDir: tempRoot,
    cwd: tempRoot,
  });

  const guidancePath = path.join(tempRoot, '.claude', 'CLAUDE.md');
  const content = await fs.readFile(guidancePath, 'utf8');

  assert.equal(result.agentId, 'claude-code');
  assert.equal(result.changed, true);
  assert.equal(result.targetPath, guidancePath);
  assert.equal(result.statusAfter.status, 'installed');
  assert.match(content, /atlas-review-global:start/u);
  assert.match(content, /## Atlas Review \(Global\)/u);
});

test('removeWorkflowGuidance removes only the Atlas-managed claude block', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-guidance-remove-claude-api-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const guidancePath = path.join(tempRoot, '.claude', 'CLAUDE.md');
  await fs.mkdir(path.dirname(guidancePath), { recursive: true });
  await fs.writeFile(guidancePath, '# Personal note\n', 'utf8');
  await installWorkflowGuidance('claude-code', {
    homeDir: tempRoot,
    cwd: tempRoot,
  });

  const result = await removeWorkflowGuidance('claude-code', {
    homeDir: tempRoot,
    cwd: tempRoot,
  });

  const content = await fs.readFile(guidancePath, 'utf8');
  assert.equal(result.agentId, 'claude-code');
  assert.equal(result.changed, true);
  assert.equal(result.statusBefore.status, 'installed');
  assert.equal(result.statusAfter.status, 'not_installed');
  assert.equal(result.statusAfter.detectedPath, guidancePath);
  assert.equal(content, '# Personal note\n');
});

test('syncAgentSetup installs managed workflow guidance for selected shipped agents', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-sync-guidance-bundle-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const result = await syncAgentSetup({
    homeDir: tempRoot,
    cwd: tempRoot,
    platform: 'linux',
    selectedAgentIds: ['codex', 'claude-code'],
    removeUnselected: false,
  });

  assert.equal(result.failures.length, 0);
  assert.equal(
    await fs.readFile(path.join(tempRoot, '.codex', 'skills', 'atlas-review-global', 'SKILL.md'), 'utf8')
      .then((content) => /Atlas Review Global Guidance/u.test(content)),
    true
  );
  assert.equal(
    await fs.readFile(path.join(tempRoot, '.claude', 'CLAUDE.md'), 'utf8')
      .then((content) => /atlas-review-global:start/u.test(content)),
    true
  );
});

test('syncAgentSetup does not fail shipped MCP-only agents that lack a managed workflow path', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-sync-mcp-only-agents-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const result = await syncAgentSetup({
    homeDir: tempRoot,
    cwd: tempRoot,
    platform: 'linux',
    selectedAgentIds: ['codex', 'claude-code', 'gemini', 'claude-desktop', 'vscode'],
    removeUnselected: true,
  });

  assert.equal(result.failures.length, 0);
  assert.deepEqual(result.selectedAgentIds, ['codex', 'claude-code', 'gemini', 'claude-desktop', 'vscode']);
  assert.equal(
    await fs.readFile(path.join(tempRoot, '.codex', 'skills', 'atlas-review-global', 'SKILL.md'), 'utf8')
      .then((content) => /Atlas Review Global Guidance/u.test(content)),
    true
  );
  assert.equal(
    await fs.readFile(path.join(tempRoot, '.claude', 'CLAUDE.md'), 'utf8')
      .then((content) => /atlas-review-global:start/u.test(content)),
    true
  );
});

test('syncAgentSetup removes managed workflow guidance when a shipped agent is deselected', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-sync-guidance-remove-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  await syncAgentSetup({
    homeDir: tempRoot,
    cwd: tempRoot,
    platform: 'linux',
    selectedAgentIds: ['codex', 'claude-code'],
    removeUnselected: false,
  });

  const result = await syncAgentSetup({
    homeDir: tempRoot,
    cwd: tempRoot,
    platform: 'linux',
    selectedAgentIds: ['claude-code'],
    removeUnselected: true,
  });

  assert.equal(result.failures.length, 0);
  await assert.rejects(
    () => fs.access(path.join(tempRoot, '.codex', 'skills', 'atlas-review-global', 'SKILL.md'))
  );
  const claudeContent = await fs.readFile(path.join(tempRoot, '.claude', 'CLAUDE.md'), 'utf8');
  assert.match(claudeContent, /atlas-review-global:start/u);
});

test('installWorkflowGuidance refuses to overwrite a non-Atlas skill at the canonical path', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-mcp-guidance-conflict-api-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const skillPath = path.join(tempRoot, '.codex', 'skills', 'atlas-review-global', 'SKILL.md');
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(skillPath, '# unrelated skill\n', 'utf8');

  await assert.rejects(
    () => installWorkflowGuidance('codex', {
      homeDir: tempRoot,
      cwd: tempRoot,
    }),
    /Refusing to overwrite a non-Atlas skill/u
  );
});

test('getSetupRuntimeStatus exposes shared CLI guidance for shipped auto-write and manual-only surfaces', () => {
  const runtimeStatus = getSetupRuntimeStatus({
    backendUrl: 'http://127.0.0.1:3111/api',
  });

  assert.equal(runtimeStatus.serverNameDefault, 'atlas-review');
  assert.match(runtimeStatus.recommendedCommands.list, /setup --list/u);
  assert.match(runtimeStatus.recommendedCommands.auto, /--backend-url=http:\/\/127\.0\.0\.1:3111\/api/u);
  assert.match(runtimeStatus.recommendedCommands.autoDryRun, /--dry-run/u);
  assert.match(runtimeStatus.setupSeparationSummary, /full Atlas-managed global bundle when supported/u);
  assert.match(runtimeStatus.workflowPolicySummary, /Atlas-named review prompts/u);
  assert.match(runtimeStatus.remediation, /auto-setup for shipped agents/u);
});

test('getSetupRuntimeStatus preserves non-http backend URLs without throwing so degraded guidance stays renderable', () => {
  const runtimeStatus = getSetupRuntimeStatus({
    backendUrl: 'ftp://127.0.0.1:3000/api',
  });

  assert.match(runtimeStatus.recommendedCommands.auto, /--backend-url=ftp:\/\/127\.0\.0\.1:3000\/api/u);
});

test('getAgentConfigSnippet rejects unsupported agent ids', async () => {
  await assert.rejects(
    () => getAgentConfigSnippet('unsupported-agent', {
      backendUrl: 'http://127.0.0.1:3000/api',
    }),
    /Unsupported agent/u
  );
});

test('setup-docs verification entrypoint stays aligned with the phase 3 test slice', async () => {
  const packageJson = JSON.parse(
    await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')
  );

  assert.equal(
    packageJson.scripts['verify:setup-docs'],
    'node --test --test-name-pattern="setup-docs|public-api|runSetupCli|configGenerator|configWriter" tests/setup-docs.test.mjs tests/public-api.test.mjs dist/src/setup/__tests__/cli.test.js dist/src/setup/__tests__/configGenerator.test.js dist/src/setup/__tests__/configWriter.test.js'
  );
});
