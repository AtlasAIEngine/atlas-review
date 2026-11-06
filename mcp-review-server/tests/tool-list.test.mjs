import test from 'node:test';
import assert from 'node:assert/strict';

import { createToolRegistry, listAdvertisedTools } from '../dist/src/tools/index.js';

const config = {
  backendUrl: 'http://127.0.0.1:3000/api',
  apiToken: null,
  autoImport: false,
  requestTimeoutMs: 120_000,
  enableWatcherSync: false,
};

test('advertised tools exclude legacy dotted aliases', () => {
  const registry = createToolRegistry({
    client: createClient(),
    config,
    cwd: '/repo',
  });

  const advertisedNames = listAdvertisedTools(registry).map((tool) => tool.name);

  assert.ok(advertisedNames.length > 0);
  assert.ok(advertisedNames.every((name) => /^[a-zA-Z0-9_-]{1,64}$/u.test(name)));
  assert.ok(!advertisedNames.includes('atlas_review.status'));
  assert.ok(!advertisedNames.includes('atlas_review.run_current'));
  assert.ok(advertisedNames.includes('atlas_review_status'));
  assert.ok(advertisedNames.includes('atlas_review_run_current'));
});

test('advertised tool schemas stay Codex-compatible recursively', () => {
  const registry = createToolRegistry({
    client: createClient(),
    config,
    cwd: '/repo',
  });

  const advertisedTools = listAdvertisedTools(registry);
  assert.ok(advertisedTools.length > 0);

  for (const tool of advertisedTools) {
    assert.equal(tool.inputSchema.type, 'object');
    assertNoUnsupportedSchemaKeywords(tool.inputSchema, tool.name);
  }
});

function assertNoUnsupportedSchemaKeywords(node, toolName, path = 'inputSchema') {
  if (Array.isArray(node)) {
    node.forEach((entry, index) => assertNoUnsupportedSchemaKeywords(entry, toolName, `${path}[${index}]`));
    return;
  }

  if (!node || typeof node !== 'object') {
    return;
  }

  for (const key of ['anyOf', 'oneOf', 'allOf', 'not']) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(node, key),
      false,
      `${toolName} contains unsupported keyword ${key} at ${path}`
    );
  }

  for (const [key, value] of Object.entries(node)) {
    assertNoUnsupportedSchemaKeywords(value, toolName, `${path}.${key}`);
  }
}

function createClient(overrides = {}) {
  return {
    getBranchReview: async () => ({
      id: 'br-1',
      projectId: 'p1',
      project: { id: 'p1', name: 'AtlasEngineMVP', path: '/repo' },
      branchName: 'feature/test',
      baseBranch: 'main',
      status: 'active',
      reviewStatus: 'none',
      reviewLifecycle: {
        status: 'completed',
        phase: 'idle',
        isActive: false,
        isTerminal: true,
        canRetry: true,
        error: null,
        updatedAt: new Date().toISOString(),
        reviewedAt: null,
        hasProgress: false,
        sourceStatus: 'none',
      },
      reviewActionEligibility: {
        canApprove: false,
        canRequestChanges: false,
        blockedReason: 'No completed review is available for this branch snapshot. Run review before actioning.',
        staleReason: null,
      },
    }),
    getReviewQueue: async () => [],
    getPrReview: async () => null,
    ...overrides,
  };
}
