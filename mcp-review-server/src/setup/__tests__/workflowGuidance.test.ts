import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildAgentWorkflowGuidance,
  resolveAgentWorkflowGuidanceState,
} from '../workflowGuidance.js';

test('codex guidance describes the managed global default and repo-local override', () => {
  const guidance = buildAgentWorkflowGuidance('codex');
  assert.ok(guidance);
  assert.match(guidance.defaultSummary, /default path for Codex/u);
  assert.match(guidance.overrideSummary, /project-level override/u);
  assert.match(guidance.fallbackSummary, /temporary manual fallback/u);
  assert.match(guidance.snippet, /explicitly asks for Atlas review/u);
  assert.match(guidance.snippet, /Do not trigger Atlas by default/u);
  assert.doesNotMatch(guidance.snippet, /code changes are ready for review/u);
});

test('claude guidance describes the managed global default and repo-local override', () => {
  const guidance = buildAgentWorkflowGuidance('claude-code');
  assert.ok(guidance);
  assert.match(guidance.defaultSummary, /default path for Claude Code/u);
  assert.match(guidance.overrideSummary, /project-level override/u);
  assert.match(guidance.fallbackSummary, /temporary manual fallback/u);
});

test('opencode guidance describes the managed global default and repo-local override', () => {
  const guidance = buildAgentWorkflowGuidance('opencode');
  assert.ok(guidance);
  assert.match(guidance.defaultSummary, /default path for OpenCode/u);
  assert.match(guidance.overrideSummary, /project-level override/u);
  assert.match(guidance.fallbackSummary, /temporary manual fallback/u);
});

test('resolveAgentWorkflowGuidanceState reports managed default availability when codex skill is absent', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-workflow-guidance-codex-missing-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const state = await resolveAgentWorkflowGuidanceState('codex', { homeDir: tempRoot });
  assert.equal(state.status, 'not_installed');
  assert.equal(state.label, 'Managed global default available');
  assert.match(state.summary, /override only/u);
});

test('resolveAgentWorkflowGuidanceState flags conflicting codex skills for manual cleanup', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-workflow-guidance-codex-conflict-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const skillPath = path.join(tempRoot, '.codex', 'skills', 'atlas-review-global', 'SKILL.md');
  await fs.mkdir(path.dirname(skillPath), { recursive: true });
  await fs.writeFile(skillPath, '# not an atlas skill\n', 'utf8');

  const state = await resolveAgentWorkflowGuidanceState('codex', { homeDir: tempRoot });
  assert.equal(state.status, 'manual_install_required');
  assert.equal(state.label, 'Manual cleanup required');
  assert.match(state.summary, /conflicting skill/u);
});

test('resolveAgentWorkflowGuidanceState reports managed default availability when opencode skill is absent', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-workflow-guidance-opencode-missing-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const state = await resolveAgentWorkflowGuidanceState('opencode', { homeDir: tempRoot });
  assert.equal(state.status, 'not_installed');
  assert.equal(state.label, 'Managed global default available');
  assert.match(state.summary, /override only/u);
});

test('resolveAgentWorkflowGuidanceState flags incomplete claude managed blocks for manual cleanup', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-workflow-guidance-claude-conflict-'));
  t.after(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  const guidancePath = path.join(tempRoot, '.claude', 'CLAUDE.md');
  await fs.mkdir(path.dirname(guidancePath), { recursive: true });
  await fs.writeFile(guidancePath, '<!-- atlas-review-global:start -->\n## Atlas Review (Global)\n', 'utf8');

  const state = await resolveAgentWorkflowGuidanceState('claude-code', { homeDir: tempRoot });
  assert.equal(state.status, 'manual_install_required');
  assert.equal(state.label, 'Manual cleanup required');
  assert.match(state.summary, /incomplete Atlas-managed Claude guidance block/u);
});
