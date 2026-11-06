import test from 'node:test';
import assert from 'node:assert/strict';

import { runRunCurrentTool } from '../dist/src/tools/runCurrent.js';

function createClient(overrides = {}) {
  return {
    getProjects: async () => [{
      id: 'p1',
      name: 'AtlasEngineMVP',
      path: '/repo',
      sessionId: 'session-heavy',
      description: 'heavy project payload',
      deploymentStatus: 'never',
    }],
    listBranchReviews: async () => [{
      id: 'br1',
      projectId: 'p1',
      displayId: 'BR-001',
      status: 'active',
      isCurrent: true,
      reviewStatus: 'reviewing',
      reviewLifecycle: {
        status: 'running',
        isActive: true,
      },
    }],
    getReviewQueue: async () => [],
    queueBranchReview: async () => {
      throw new Error('queueBranchReview should not be called for active reviews');
    },
    runBranchReview: async () => {
      throw new Error('runBranchReview should not be called for active reviews');
    },
    ...overrides,
  };
}

const config = {
  backendUrl: 'http://127.0.0.1:3000/api',
  apiToken: null,
  autoImport: false,
  requestTimeoutMs: 120_000,
  enableWatcherSync: false,
};

test('run_current returns alreadyRunning without queueing when current review lifecycle is active', async () => {
  const result = await runRunCurrentTool(
    createClient(),
    config,
    '/repo',
    { projectId: 'p1' }
  );

  assert.equal(result.data.alreadyRunning, true);
  assert.equal(result.data.reviewStatus, 'reviewing');
  assert.equal(result.data.lifecycleStatus, 'running');
  assert.equal(result.data.queueId, null);
  assert.equal(result.data.queuePosition, null);
  assert.deepEqual(Object.keys(result.data.project).sort(), ['id', 'name', 'path']);
  assert.match(result.summary, /already active/u);
});

test('run_current surfaces active queue metadata when current review is already queued', async () => {
  const result = await runRunCurrentTool(
    createClient({
      listBranchReviews: async () => [{
        id: 'br1',
        projectId: 'p1',
        displayId: 'BR-001',
        status: 'active',
        isCurrent: true,
        reviewStatus: 'queued',
        reviewLifecycle: {
          status: 'queued',
          isActive: true,
        },
      }],
      getReviewQueue: async () => [{
        id: 'queue-1',
        type: 'branch_review',
        projectId: 'p1',
        branchReviewId: 'br1',
        status: 'queued',
      }],
    }),
    config,
    '/repo',
    { projectId: 'p1' }
  );

  assert.equal(result.data.alreadyRunning, true);
  assert.equal(result.data.queueId, 'queue-1');
  assert.equal(result.data.queuePosition, 1);
  assert.equal(result.data.lifecycleStatus, 'queued');
  assert.match(result.summary, /already active at position 1/u);
});

test('run_current requeues stale queued lifecycle when no queue entry exists anymore', async () => {
  let queueCalls = 0;
  const result = await runRunCurrentTool(
    createClient({
      listBranchReviews: async () => [{
        id: 'br1',
        projectId: 'p1',
        displayId: 'BR-001',
        status: 'active',
        isCurrent: true,
        reviewStatus: 'queued',
        reviewLifecycle: {
          status: 'queued',
          isActive: true,
          updatedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
        },
        updatedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
      }],
      getReviewQueue: async () => {
        queueCalls += 1;
        return [];
      },
      queueBranchReview: async () => ({
        id: 'queue-2',
        position: 1,
      }),
    }),
    config,
    '/repo',
    { projectId: 'p1' }
  );

  assert.equal(queueCalls, 1);
  assert.equal(result.data.alreadyRunning, undefined);
  assert.equal(result.data.queueId, 'queue-2');
  assert.equal(result.data.queuePosition, 1);
  assert.match(result.summary, /Queued review for BR-001 at position 1/u);
});

test('run_current requeues queued lifecycle without timestamps when no queue entry exists', async () => {
  const result = await runRunCurrentTool(
    createClient({
      listBranchReviews: async () => [{
        id: 'br1',
        projectId: 'p1',
        displayId: 'BR-001',
        status: 'active',
        isCurrent: true,
        reviewStatus: 'queued',
        reviewLifecycle: {
          status: 'queued',
          isActive: true,
          updatedAt: null,
        },
        updatedAt: null,
      }],
      getReviewQueue: async () => [],
      queueBranchReview: async () => ({
        id: 'queue-3',
        position: 1,
      }),
    }),
    config,
    '/repo',
    { projectId: 'p1' }
  );

  assert.equal(result.data.alreadyRunning, undefined);
  assert.equal(result.data.queueId, 'queue-3');
  assert.equal(result.data.queuePosition, 1);
  assert.match(result.summary, /Queued review for BR-001 at position 1/u);
});

test('run_current reports queued lifecycle when a new queue request succeeds without branchReview payload', async () => {
  const result = await runRunCurrentTool(
    createClient({
      listBranchReviews: async () => [{
        id: 'br1',
        projectId: 'p1',
        displayId: 'BR-001',
        status: 'active',
        isCurrent: true,
        reviewStatus: 'none',
        reviewLifecycle: {
          status: 'completed',
          isActive: false,
        },
      }],
      queueBranchReview: async () => ({
        id: 'queue-2',
        position: 1,
      }),
    }),
    config,
    '/repo',
    { projectId: 'p1' }
  );

  assert.equal(result.data.alreadyRunning, undefined);
  assert.equal(result.data.queueId, 'queue-2');
  assert.equal(result.data.queuePosition, 1);
  assert.equal(result.data.reviewStatus, 'queued');
  assert.equal(result.data.lifecycleStatus, 'queued');
  assert.equal(result.data.branchReview?.reviewStatus, 'queued');
  assert.equal(result.data.branchReview?.lifecycleStatus, 'queued');
  assert.match(result.summary, /Queued review for BR-001 at position 1/u);
});

test('run_current forwards branch reviewMode to the queue API', async () => {
  let receivedOptions = null;
  const result = await runRunCurrentTool(
    createClient({
      listBranchReviews: async () => [{
        id: 'br1',
        projectId: 'p1',
        displayId: 'BR-001',
        status: 'active',
        isCurrent: true,
        reviewStatus: 'none',
        reviewLifecycle: {
          status: 'completed',
          isActive: false,
        },
      }],
      queueBranchReview: async (_projectId, _branchReviewId, options) => {
        receivedOptions = options;
        return {
          id: 'queue-3',
          position: 1,
        };
      },
    }),
    config,
    '/repo',
    { projectId: 'p1', reviewMode: 'full' }
  );

  assert.deepEqual(receivedOptions, { reviewMode: 'full', scope: undefined });
  assert.equal(result.data.queueId, 'queue-3');
  assert.equal(result.data.queuePosition, 1);
});
