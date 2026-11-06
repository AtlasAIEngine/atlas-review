import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { createReviewCurrentBranchPrompt } from '../dist/src/prompts/reviewCurrentBranch.js';
import { createReviewCurrentResource } from '../dist/src/resources/reviewCurrent.js';
import { createReviewCurrentStatusResource } from '../dist/src/resources/reviewCurrentStatus.js';
import { resolveCurrentReviewContext } from '../dist/src/tools/projectContext.js';
import { runStatusTool } from '../dist/src/tools/status.js';
import { runLatestTool } from '../dist/src/tools/latest.js';
import { runFileTool } from '../dist/src/tools/file.js';
import { runRunCurrentTool } from '../dist/src/tools/runCurrent.js';
import { runQueueCancelTool } from '../dist/src/tools/queueCancel.js';

const config = {
  backendUrl: 'http://127.0.0.1:3000/api',
  apiToken: null,
  autoImport: false,
  requestTimeoutMs: 120_000,
  enableWatcherSync: false,
};

const repoRoot = path.resolve(process.cwd(), '..');
const currentBranch = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim();

function createClient(overrides = {}) {
  const prReview = {
    id: 'pr1',
    projectId: 'p1',
    githubPrNumber: 65,
    headBranch: currentBranch,
    baseBranch: 'main',
    reviewStatus: 'reviewed',
    reviewLifecycle: {
      status: 'completed',
      isActive: false,
    },
    reviewJson: {
      summary: 'PR summary',
      riskLevel: 'medium',
      recommendations: [{
        type: 'issue',
        severity: 'high',
        title: 'Escape output',
        description: 'User content is rendered unsafely',
        file: 'src/app.ts',
        line: 42,
        suggestedFix: 'Escape user content before rendering',
      }],
    },
  };

  return {
    getProjects: async () => [{
      id: 'p1',
      name: 'AtlasEngineMVP',
      path: repoRoot,
      sessionId: 'session-heavy',
      description: 'heavy project payload',
      deploymentStatus: 'never',
    }],
    listBranchReviews: async () => [],
    getBranchReview: async () => null,
    listPrReviews: async () => [prReview],
    getPrReview: async () => prReview,
    getReviewQueue: async () => [],
    queuePrReview: async () => ({
      id: 'pr-queue-1',
      position: 1,
    }),
    cancelPrReviewQueue: async () => ({
      success: true,
      stopped: true,
      was: 'queued',
    }),
    listReviewOutcomes: async () => ({
      success: true,
      scope: {
        projectId: 'p1',
        reviewType: 'pr_review',
        reviewId: 'pr1',
      },
      outcomes: [],
      byRecommendationKey: {
        'issue|high|escape output|user content is rendered unsafely|src/app.ts|42|escape user content before rendering': {
          recommendationKey: 'issue|high|escape output|user content is rendered unsafely|src/app.ts|42|escape user content before rendering',
          status: 'addressed',
          note: 'Fixed',
          dimensions: {
            providerType: 'unknown',
            providerModel: 'unknown',
            language: 'typescript',
            pathPattern: 'src/**',
          },
          updatedAt: '2026-03-09T12:00:00.000Z',
        },
      },
      telemetry: null,
    }),
    getPrReviewFileContent: async () => ({
      success: true,
      files: [{
        path: 'src/app.ts',
        oldPath: null,
        status: 'modified',
        patch: '@@ -1 +1 @@',
        before: 'before',
        after: 'after',
      }],
      missingPaths: [],
    }),
    ...overrides,
  };
}

test('current review resolver falls back to PR review when current branch maps to one PR', async () => {
  const context = await resolveCurrentReviewContext(createClient(), config, {}, repoRoot);

  assert.equal(context.review?.type, 'pr_review');
  assert.equal(context.review?.label, 'PR #65');
  assert.equal(context.prReview?.id, 'pr1');
});

test('current review resolver ignores unrelated branch review before falling back to current-branch PR review', async () => {
  const context = await resolveCurrentReviewContext(
    createClient({
      listBranchReviews: async () => ([{
        id: 'br-other',
        projectId: 'p1',
        displayId: 'BR-999',
        branchName: 'feature/unrelated',
        baseBranch: 'main',
        status: 'active',
        isCurrent: true,
        reviewStatus: 'reviewed',
        reviewLifecycle: {
          status: 'completed',
          isActive: false,
        },
      }]),
      getBranchReview: async () => ({
        id: 'br-other',
        projectId: 'p1',
        displayId: 'BR-999',
        branchName: 'feature/unrelated',
        baseBranch: 'main',
        status: 'active',
        isCurrent: true,
        reviewStatus: 'reviewed',
        reviewLifecycle: {
          status: 'completed',
          isActive: false,
        },
      }),
    }),
    config,
    {},
    repoRoot
  );

  assert.equal(context.review?.type, 'pr_review');
  assert.equal(context.prReview?.id, 'pr1');
  assert.equal(context.branchReview, null);
});

test('current review resolver rejects ambiguous PR fallback from current branch', async () => {
  await assert.rejects(
    () => resolveCurrentReviewContext(
      createClient({
        listPrReviews: async () => ([
          { id: 'pr1', projectId: 'p1', githubPrNumber: 65, headBranch: currentBranch },
          { id: 'pr2', projectId: 'p1', githubPrNumber: 66, headBranch: currentBranch },
        ]),
      }),
      config,
      {},
      repoRoot
    ),
    /Multiple PR reviews match current branch/u
  );
});

test('latest resolves PR review scope by githubPrNumber', async () => {
  const result = await runLatestTool(
    createClient(),
    config,
    repoRoot,
    {
      projectId: 'p1',
      reviewType: 'pr_review',
      githubPrNumber: 65,
    }
  );

  assert.equal(result.data.review?.type, 'pr_review');
  assert.equal(result.data.prReview?.githubPrNumber, 65);
  assert.equal(result.data.findings.length, 1);
});

test('latest falls back to current PR review when no explicit target is provided', async () => {
  const result = await runLatestTool(
    createClient(),
    config,
    repoRoot,
    {}
  );

  assert.equal(result.data.review?.type, 'pr_review');
  assert.equal(result.data.prReview?.githubPrNumber, 65);
  assert.equal(result.data.findings.length, 1);
});

test('status reports queue and lifecycle state for PR review scope', async () => {
  const result = await runStatusTool(
    createClient({
      listPrReviews: async () => [{
        id: 'pr1',
        projectId: 'p1',
        githubPrNumber: 65,
        headBranch: currentBranch,
        reviewStatus: 'queued',
        reviewLifecycle: {
          status: 'queued',
          isActive: true,
        },
      }],
      getPrReview: async () => ({
        id: 'pr1',
        projectId: 'p1',
        githubPrNumber: 65,
        headBranch: currentBranch,
        reviewStatus: 'queued',
        reviewLifecycle: {
          status: 'queued',
          isActive: true,
        },
      }),
      getReviewQueue: async () => [{
        id: 'queue-pr-1',
        type: 'pr_review',
        projectId: 'p1',
        prReviewId: 'pr1',
        status: 'queued',
      }],
    }),
    config,
    repoRoot,
    {
      projectId: 'p1',
      reviewType: 'pr_review',
      prReviewId: 'pr1',
    }
  );

  assert.equal(result.data.review?.type, 'pr_review');
  assert.equal(result.data.queueForCurrentReview.length, 1);
  assert.equal(result.data.lifecycleStatus, 'queued');
});

test('latest returns PR review findings and outcome state', async () => {
  const result = await runLatestTool(
    createClient(),
    config,
    repoRoot,
    {
      projectId: 'p1',
      reviewType: 'pr_review',
      prReviewId: 'pr1',
    }
  );

  assert.equal(result.data.review?.type, 'pr_review');
  assert.equal(result.data.findings.length, 1);
  assert.deepEqual(Object.keys(result.data.project).sort(), ['id', 'name', 'path']);
  assert.equal(result.data.findings[0].outcome?.status, 'addressed');
});

test('file returns PR review file content and matching findings', async () => {
  const result = await runFileTool(
    createClient(),
    config,
    repoRoot,
    {
      projectId: 'p1',
      reviewType: 'pr_review',
      prReviewId: 'pr1',
      path: 'src/app.ts',
    }
  );

  assert.equal(result.data.review?.type, 'pr_review');
  assert.equal(result.data.fileInScope, true);
  assert.equal(result.data.file?.path, 'src/app.ts');
  assert.equal(result.data.findings.length, 1);
  assert.deepEqual(Object.keys(result.data.project).sort(), ['id', 'name', 'path']);
  assert.equal('reviewJson' in (result.data.prReview || {}), false);
});

test('run_current queues PR review in queue mode', async () => {
  const result = await runRunCurrentTool(
    createClient({
      getPrReview: async () => ({
        id: 'pr1',
        projectId: 'p1',
        githubPrNumber: 65,
        headBranch: currentBranch,
        reviewStatus: 'none',
        reviewLifecycle: {
          status: 'completed',
          isActive: false,
        },
      }),
    }),
    config,
    repoRoot,
    {
      projectId: 'p1',
      reviewType: 'pr_review',
      prReviewId: 'pr1',
    }
  );

  assert.equal(result.data.review?.type, 'pr_review');
  assert.equal(result.data.queueId, 'pr-queue-1');
  assert.equal(result.data.lifecycleStatus, 'queued');
  assert.match(result.summary, /Queued review for PR #65/u);
});

test('run_current falls back to current PR review when no explicit target is provided', async () => {
  const result = await runRunCurrentTool(
    createClient({
      getPrReview: async () => ({
        id: 'pr1',
        projectId: 'p1',
        githubPrNumber: 65,
        headBranch: currentBranch,
        reviewStatus: 'none',
        reviewLifecycle: {
          status: 'completed',
          isActive: false,
        },
      }),
    }),
    config,
    repoRoot,
    {}
  );

  assert.equal(result.data.review?.type, 'pr_review');
  assert.equal(result.data.queueId, 'pr-queue-1');
  assert.equal(result.data.lifecycleStatus, 'queued');
});

test('run_current rejects immediate mode for PR review scope', async () => {
  await assert.rejects(
    () => runRunCurrentTool(
      createClient(),
      config,
      repoRoot,
      {
        projectId: 'p1',
        reviewType: 'pr_review',
        prReviewId: 'pr1',
        mode: 'immediate',
      }
    ),
    /mode "immediate" is not supported for PR review scope/u
  );
});

test('run_current rejects scope filters for PR review scope', async () => {
  await assert.rejects(
    () => runRunCurrentTool(
      createClient(),
      config,
      repoRoot,
      {
        projectId: 'p1',
        reviewType: 'pr_review',
        prReviewId: 'pr1',
        scope: {
          includePatterns: ['src/**/*.ts'],
        },
      }
    ),
    /scope is not supported for PR review scope/u
  );
});

test('queue_cancel cancels PR review queue entries', async () => {
  const result = await runQueueCancelTool(
    createClient(),
    config,
    repoRoot,
    {
      projectId: 'p1',
      reviewType: 'pr_review',
      prReviewId: 'pr1',
    }
  );

  assert.equal(result.data.review?.type, 'pr_review');
  assert.equal(result.data.stopped, true);
  assert.equal(result.data.was, 'queued');
  assert.deepEqual(Object.keys(result.data.project).sort(), ['id', 'name', 'path']);
  assert.equal('reviewJson' in (result.data.prReview || {}), false);
  assert.match(result.summary, /Stopped queued\/running review for PR #65/u);
});

test('current review resource falls back to PR context when branch review is absent', async () => {
  const resource = createReviewCurrentResource({
    client: createClient(),
    config,
    cwd: repoRoot,
  });

  const result = await resource.handler();

  assert.equal(result.data.review?.type, 'pr_review');
  assert.equal(result.data.prReview?.githubPrNumber, 65);
  assert.equal(result.data.status.lifecycleStatus, 'completed');
  assert.equal(result.data.latest.findings.length, 1);
});

test('current review status resource preserves compact review fields from status data', async () => {
  const resource = createReviewCurrentStatusResource({
    client: createClient({
      listPrReviews: async () => [{
        id: 'pr1',
        projectId: 'p1',
        githubPrNumber: 65,
        headBranch: currentBranch,
        reviewStatus: 'queued',
        reviewLifecycle: {
          status: 'queued',
          isActive: true,
        },
        updatedAt: '2026-03-11T12:00:00.000Z',
      }],
      getPrReview: async () => ({
        id: 'pr1',
        projectId: 'p1',
        githubPrNumber: 65,
        headBranch: currentBranch,
        reviewStatus: 'queued',
        reviewLifecycle: {
          status: 'queued',
          isActive: true,
        },
        updatedAt: '2026-03-11T12:00:00.000Z',
      }),
      getReviewQueue: async () => [],
    }),
    config,
    cwd: repoRoot,
  });

  const result = await resource.handler();

  assert.deepEqual(result.data.prReview, {
    id: 'pr1',
    githubPrNumber: 65,
    headBranch: currentBranch,
    reviewStatus: 'queued',
    lifecycleStatus: 'queued',
    updatedAt: '2026-03-11T12:00:00.000Z',
    baseBranch: null,
    displayId: null,
  });
});

test('current review resource returns no-review payload when neither branch nor PR review exists', async () => {
  const resource = createReviewCurrentResource({
    client: createClient({
      listPrReviews: async () => [],
    }),
    config,
    cwd: repoRoot,
  });

  const result = await resource.handler();

  assert.equal(result.data.review, null);
  assert.equal(result.data.latest, null);
  assert.match(result.summary, /has no resolved review yet/u);
});

test('review_current_branch prompt accepts explicit PR targeting inputs', async () => {
  const prompt = createReviewCurrentBranchPrompt({
    client: createClient(),
    config,
    cwd: repoRoot,
  });

  const result = await prompt.handler({
    reviewType: 'pr_review',
    githubPrNumber: '65',
  });

  assert.match(result.description, /PR #65/u);
  assert.match(result.messages[0].text, /"type": "pr_review"/u);
  assert.match(result.messages[0].text, /"label": "PR #65"/u);
});
