import test from 'node:test';
import assert from 'node:assert/strict';

import { createToolRegistry } from '../dist/src/tools/index.js';
import { TOOL_NAMES } from '../dist/src/toolNames.js';
import { runStatusTool } from '../dist/src/tools/status.js';
import { runWaitForTerminalTool } from '../dist/src/tools/waitForTerminal.js';

const config = {
  backendUrl: 'http://127.0.0.1:3000/api',
  apiToken: null,
  autoImport: false,
  requestTimeoutMs: 120_000,
  enableWatcherSync: false,
};

test('tool registry exposes wait_for_terminal with the canonical and legacy names', () => {
  const registry = createToolRegistry({
    client: createClient(),
    config,
    cwd: '/repo',
  });

  assert.ok(registry.has(TOOL_NAMES.waitForTerminal));
  assert.ok(registry.has('atlas_review.wait_for_terminal'));
});

test('status reports fresh long-running agentic execution without suggesting cancel', async () => {
  const now = Date.now();
  const activeAt = new Date(now - 20_000).toISOString();
  const startedAt = new Date(now - 240_000).toISOString();
  const result = await runStatusTool(
    createClient({
      getBranchReview: async () => makeBranchReview({
        reviewStatus: 'reviewing',
        reviewLifecycle: {
          status: 'running',
          isActive: true,
          phase: 'agentic_tool_use',
          updatedAt: activeAt,
        },
        updatedAt: activeAt,
        createdAt: startedAt,
      }),
      getReviewQueue: async () => [makeQueueEntry({
        queuedAt: startedAt,
        updatedAt: activeAt,
        status: 'reviewing',
        progress: {
          phase: 'agentic_tool_use',
          elapsedSeconds: 240,
          filesCompleted: 9,
          totalFiles: 42,
          currentChunk: 2,
          totalChunks: 6,
          updatedAt: activeAt,
        },
        lifecycle: {
          status: 'running',
          isActive: true,
          isTerminal: false,
          phase: 'agentic_tool_use',
          updatedAt: activeAt,
          sourceStatus: 'reviewing',
        },
      })],
    }),
    config,
    '/repo',
    { projectId: 'p1' }
  );

  assert.equal(result.data.activeExecution?.phase, 'agentic_tool_use');
  assert.equal(result.data.activeExecution?.isStale, false);
  assert.equal(result.data.activeExecution?.filesCompleted, 9);
  assert.equal(result.data.activeExecution?.totalFiles, 42);
  assert.deepEqual(Object.keys(result.data.project).sort(), ['id', 'name', 'path']);
  assert.match(result.summary, /Freshness: active\/fresh/u);
  assert.match(result.summary, /Do not cancel based on elapsed time alone/u);
  assert.deepEqual(result.nextActions, [
    `Run ${TOOL_NAMES.waitForTerminal} to wait for a terminal review outcome.`,
    `Run ${TOOL_NAMES.latest} after the review completes to inspect findings.`,
  ]);
});

test('status marks inactive progress as stale before suggesting cancel', async () => {
  const now = Date.now();
  const activeAt = new Date(now - 11 * 60_000).toISOString();
  const startedAt = new Date(now - 18 * 60_000).toISOString();
  const result = await runStatusTool(
    createClient({
      getBranchReview: async () => makeBranchReview({
        reviewStatus: 'reviewing',
        reviewLifecycle: {
          status: 'running',
          isActive: true,
          phase: 'agentic_tool_use',
          updatedAt: activeAt,
        },
        updatedAt: activeAt,
        createdAt: startedAt,
      }),
      getReviewQueue: async () => [makeQueueEntry({
        queuedAt: startedAt,
        updatedAt: activeAt,
        status: 'reviewing',
        progress: {
          phase: 'agentic_tool_use',
          elapsedSeconds: 1080,
          filesCompleted: 3,
          totalFiles: 42,
          updatedAt: activeAt,
        },
        lifecycle: {
          status: 'running',
          isActive: true,
          isTerminal: false,
          phase: 'agentic_tool_use',
          updatedAt: activeAt,
          sourceStatus: 'reviewing',
        },
      })],
    }),
    config,
    '/repo',
    { projectId: 'p1' }
  );

  assert.equal(result.data.activeExecution?.isStale, true);
  assert.match(result.summary, /Freshness: stale/u);
  assert.match(result.summary, /No new review activity observed/u);
  assert.deepEqual(result.nextActions, [
    `Run ${TOOL_NAMES.waitForTerminal} with a longer timeout before assuming the review is hung.`,
    `Run ${TOOL_NAMES.queueCancel} only if no new activity appears and the user wants to stop the review.`,
  ]);
});

test('status surfaces review queue fetch failures instead of pretending the queue is empty', async () => {
  await assert.rejects(
    () => runStatusTool(
      createClient({
        getReviewQueue: async () => {
          throw new Error('queue unavailable');
        },
      }),
      config,
      '/repo',
      { projectId: 'p1' }
    ),
    /queue unavailable/u
  );
});

test('wait_for_terminal polls until terminal state and returns the latest summary', async () => {
  let queueCalls = 0;
  let detailCalls = 0;
  const result = await runWaitForTerminalTool(
    createClient({
      getBranchReview: async () => {
        detailCalls += 1;
        if (detailCalls < 2) {
          return makeBranchReview({
            reviewStatus: 'reviewing',
            reviewLifecycle: {
              status: 'running',
              isActive: true,
              phase: 'agentic_tool_use',
              updatedAt: new Date().toISOString(),
            },
          });
        }
        return makeBranchReview({
          reviewStatus: 'reviewed',
          reviewSummary: 'Final review summary',
          reviewRiskLevel: 'medium',
          reviewJson: {
            summary: 'Final review summary',
            riskLevel: 'medium',
            recommendations: [
              {
                type: 'issue',
                severity: 'medium',
                title: 'Example finding',
                file: 'src/example.ts',
                line: 12,
              },
            ],
          },
          reviewLifecycle: {
            status: 'completed',
            isActive: false,
            isTerminal: true,
            phase: 'complete',
            updatedAt: new Date().toISOString(),
          },
        });
      },
      getReviewQueue: async () => {
        queueCalls += 1;
        if (queueCalls < 2) {
          return [makeQueueEntry({
            status: 'reviewing',
            progress: {
              phase: 'agentic_tool_use',
              elapsedSeconds: 90,
              filesCompleted: 4,
              totalFiles: 10,
              updatedAt: new Date().toISOString(),
            },
            lifecycle: {
              status: 'running',
              isActive: true,
              isTerminal: false,
              phase: 'agentic_tool_use',
              updatedAt: new Date().toISOString(),
              sourceStatus: 'reviewing',
            },
          })];
        }
        return [];
      },
    }),
    config,
    '/repo',
    { projectId: 'p1', timeoutMs: 500, pollIntervalMs: 10 }
  );

  assert.equal(result.data.terminal, true);
  assert.equal(result.data.timedOut, false);
  assert.deepEqual(Object.keys(result.data.project).sort(), ['id', 'name', 'path']);
  assert.deepEqual(Object.keys(result.data.latest?.project || {}).sort(), ['id', 'name', 'path']);
  assert.equal(result.data.latest?.summary, 'Final review summary');
  assert.equal(result.data.latest?.riskLevel, 'medium');
  assert.match(result.summary, /reached terminal state/u);
  assert.deepEqual(result.nextActions, [`Run ${TOOL_NAMES.latest} to inspect findings.`]);
});

test('wait_for_terminal tolerates one transient status polling failure and still returns terminal findings', async () => {
  let queueCalls = 0;
  let detailCalls = 0;
  const result = await runWaitForTerminalTool(
    createClient({
      getBranchReview: async () => {
        detailCalls += 1;
        if (detailCalls < 3) {
          return makeBranchReview({
            reviewStatus: 'reviewing',
            reviewLifecycle: {
              status: 'running',
              isActive: true,
              phase: 'agentic_tool_use',
              updatedAt: new Date().toISOString(),
            },
          });
        }
        return makeBranchReview({
          reviewStatus: 'reviewed',
          reviewSummary: 'Recovered after transient poll failure',
          reviewRiskLevel: 'low',
          reviewJson: {
            summary: 'Recovered after transient poll failure',
            riskLevel: 'low',
            recommendations: [],
          },
          reviewLifecycle: {
            status: 'completed',
            isActive: false,
            isTerminal: true,
            phase: 'complete',
            updatedAt: new Date().toISOString(),
          },
        });
      },
      getReviewQueue: async () => {
        queueCalls += 1;
        if (queueCalls === 1) {
          return [makeQueueEntry()];
        }
        if (queueCalls === 2) {
          throw new Error('transient queue fetch failure');
        }
        return [];
      },
    }),
    config,
    '/repo',
    { projectId: 'p1', timeoutMs: 500, pollIntervalMs: 10 }
  );

  assert.equal(result.data.terminal, true);
  assert.equal(result.data.timedOut, false);
  assert.equal(result.data.latest?.summary, 'Recovered after transient poll failure');
});

test('wait_for_terminal preserves terminal result when latest summary fetch fails transiently', async () => {
  const result = await runWaitForTerminalTool(
    createClient({
      getBranchReview: async () => makeBranchReview({
        reviewStatus: 'reviewed',
        reviewSummary: 'Terminal review available',
        reviewRiskLevel: 'medium',
        reviewJson: {
          summary: 'Terminal review available',
          riskLevel: 'medium',
          recommendations: [],
        },
        reviewLifecycle: {
          status: 'completed',
          isActive: false,
          isTerminal: true,
          phase: 'complete',
          updatedAt: new Date().toISOString(),
        },
      }),
      getReviewQueue: async () => [],
      listReviewOutcomes: async () => {
        throw new Error('transient outcomes failure');
      },
    }),
    config,
    '/repo',
    { projectId: 'p1', timeoutMs: 500, pollIntervalMs: 10 }
  );

  assert.equal(result.data.terminal, true);
  assert.equal(result.data.timedOut, false);
  assert.equal(result.data.latest, null);
  assert.match(result.summary, /reached terminal state/u);
});

test('wait_for_terminal returns a continuation hint before exceeding the client request window', async () => {
  const result = await runWaitForTerminalTool(
    createClient({
      getBranchReview: async () => makeBranchReview({
        reviewStatus: 'reviewing',
        reviewLifecycle: {
          status: 'running',
          isActive: true,
          isTerminal: false,
          phase: 'agentic_tool_use',
          updatedAt: new Date().toISOString(),
        },
      }),
      getReviewQueue: async () => [makeQueueEntry()],
    }),
    {
      ...config,
      requestTimeoutMs: 400,
      toolCallTimeoutMs: 400,
    },
    '/repo',
    { projectId: 'p1', timeoutMs: 5_000, pollIntervalMs: 25 }
  );

  assert.equal(result.data.terminal, false);
  assert.equal(result.data.timedOut, true);
  assert.equal(result.data.continuationRecommended, true);
  assert.equal(result.data.hostWindowLimited, true);
  assert.ok(result.data.effectiveWaitWindowMs < result.data.timeoutMs);
  assert.match(result.summary, /Call wait_for_terminal again to continue waiting/u);
  assert.deepEqual(result.nextActions, [
    `Run ${TOOL_NAMES.waitForTerminal} again to continue waiting for a terminal review outcome.`,
    `Run ${TOOL_NAMES.latest} after the review completes to inspect findings.`,
  ]);
});

test('wait_for_terminal derives the local wait window from tool call timeout instead of HTTP timeout', async () => {
  const localConfig = {
    ...config,
    requestTimeoutMs: 400,
    toolCallTimeoutMs: 1_000,
  };
  const result = await runWaitForTerminalTool(
    createClient({
      getBranchReview: async () => makeBranchReview({
        reviewStatus: 'reviewing',
        reviewLifecycle: {
          status: 'running',
          isActive: true,
          isTerminal: false,
          phase: 'agentic_tool_use',
          updatedAt: new Date().toISOString(),
        },
      }),
      getReviewQueue: async () => [makeQueueEntry()],
    }),
    localConfig,
    '/repo',
    { projectId: 'p1', timeoutMs: 900, pollIntervalMs: 25 }
  );

  assert.equal(result.data.terminal, false);
  assert.equal(result.data.timedOut, true);
  assert.equal(result.data.hostToolTimeoutMs, 1_000);
  assert.equal(result.data.effectiveWaitWindowMs, 750);
  assert.ok(result.data.effectiveWaitWindowMs > localConfig.requestTimeoutMs);
  assert.match(result.summary, /Reached the local wait window \(750ms\)/u);
});

test('status treats backend timestamps without timezone as local wall-clock time', async () => {
  const now = new Date();
  const activeAt = new Date(now.getTime() - 20_000);
  const startedAt = new Date(now.getTime() - 240_000);
  const result = await runStatusTool(
    createClient({
      getBranchReview: async () => makeBranchReview({
        reviewStatus: 'reviewing',
        reviewLifecycle: {
          status: 'running',
          isActive: true,
          phase: 'agentic_tool_use',
          updatedAt: formatNaiveTimestamp(activeAt),
        },
        updatedAt: formatNaiveTimestamp(activeAt),
        createdAt: formatNaiveTimestamp(startedAt),
      }),
      getReviewQueue: async () => [makeQueueEntry({
        queuedAt: formatNaiveTimestamp(startedAt),
        updatedAt: formatNaiveTimestamp(activeAt),
        progress: {
          phase: 'agentic_tool_use',
          elapsedSeconds: 240,
          filesCompleted: 2,
          totalFiles: 8,
          updatedAt: formatNaiveTimestamp(activeAt),
        },
        lifecycle: {
          status: 'running',
          isActive: true,
          isTerminal: false,
          phase: 'agentic_tool_use',
          updatedAt: formatNaiveTimestamp(activeAt),
          sourceStatus: 'reviewing',
        },
      })],
    }),
    config,
    '/repo',
    { projectId: 'p1' }
  );

  assert.equal(result.data.activeExecution?.isStale, false);
  assert.ok((result.data.activeExecution?.secondsSinceLastActivity ?? 999) < 120);
});

test('status reports no active queue when only terminal queue entries remain', async () => {
  const completedAt = new Date().toISOString();
  const result = await runStatusTool(
    createClient({
      getBranchReview: async () => makeBranchReview({
        reviewStatus: 'reviewed',
        reviewSummary: 'Complete',
        reviewLifecycle: {
          status: 'completed',
          isActive: false,
          isTerminal: true,
          phase: 'complete',
          updatedAt: completedAt,
          reviewedAt: completedAt,
          sourceStatus: 'reviewed',
        },
        updatedAt: completedAt,
      }),
      getReviewQueue: async () => [makeQueueEntry({
        status: 'completed',
        updatedAt: completedAt,
        lifecycle: {
          status: 'completed',
          isActive: false,
          isTerminal: true,
          phase: 'complete',
          updatedAt: completedAt,
          reviewedAt: completedAt,
          sourceStatus: 'completed',
        },
      })],
    }),
    config,
    '/repo',
    { projectId: 'p1' }
  );

  assert.equal(result.data.activeExecution?.isTerminal, true);
  assert.equal(result.data.queueState, 'no_active_queue');
  assert.deepEqual(result.nextActions, [
    `Run ${TOOL_NAMES.latest} to inspect the terminal review findings.`,
    `Run ${TOOL_NAMES.runCurrent} to trigger a new review if the branch or PR changed.`,
  ]);
});

test('status treats stale queued lifecycle without queue entries as inactive so review can be retried', async () => {
  const queuedAt = new Date(Date.now() - 11 * 60_000).toISOString();
  const result = await runStatusTool(
    createClient({
      getBranchReview: async () => makeBranchReview({
        reviewStatus: 'queued',
        reviewLifecycle: {
          status: 'queued',
          isActive: true,
          isTerminal: false,
          phase: 'queued',
          updatedAt: queuedAt,
          sourceStatus: 'queued',
        },
        updatedAt: queuedAt,
      }),
      getReviewQueue: async () => [],
    }),
    config,
    '/repo',
    { projectId: 'p1' }
  );

  assert.equal(result.data.lifecycleStatus, 'queued');
  assert.equal(result.data.activeExecution?.isActive, false);
  assert.equal(result.data.activeExecution?.isStale, true);
  assert.equal(result.data.queueState, 'no_active_queue');
  assert.match(result.summary, /Execution active: no/u);
  assert.match(result.summary, /Freshness: stale/u);
  assert.match(result.summary, /no active queue entry has existed/u);
  assert.deepEqual(result.nextActions, [
    `Run ${TOOL_NAMES.runCurrent} to start a review run.`,
    `Run ${TOOL_NAMES.latest} to inspect the latest completed findings.`,
  ]);
});

test('status treats queued lifecycle without timestamps or queue entries as stale and inactive', async () => {
  const result = await runStatusTool(
    createClient({
      getBranchReview: async () => makeBranchReview({
        reviewStatus: 'queued',
        reviewLifecycle: {
          status: 'queued',
          isActive: true,
          isTerminal: false,
          phase: 'queued',
          updatedAt: null,
          sourceStatus: 'queued',
        },
        updatedAt: null,
      }),
      getReviewQueue: async () => [],
    }),
    config,
    '/repo',
    { projectId: 'p1' }
  );

  assert.equal(result.data.activeExecution?.isActive, false);
  assert.equal(result.data.activeExecution?.isStale, true);
  assert.equal(result.data.queueState, 'no_active_queue');
  assert.match(result.summary, /Execution active: no/u);
  assert.match(result.summary, /Freshness: stale/u);
  assert.match(result.summary, /no active queue entry exists/u);
});

function createClient(overrides = {}) {
  return {
    getProjects: async () => [{
      id: 'p1',
      name: 'AtlasEngineMVP',
      path: '/repo',
      sessionId: 'session-heavy',
      description: 'heavy project payload',
      memorySize: 999,
    }],
    listBranchReviews: async () => [makeBranchReview()],
    getBranchReview: async () => makeBranchReview(),
    getReviewQueue: async () => [],
    listReviewOutcomes: async () => ({
      byRecommendationKey: {},
      outcomes: [],
      telemetry: null,
    }),
    ...overrides,
  };
}

function makeBranchReview(overrides = {}) {
  return {
    id: 'br1',
    projectId: 'p1',
    displayId: 'BR-001',
    branchName: 'feature/test',
    isCurrent: true,
    reviewStatus: 'reviewing',
    reviewSummary: null,
    reviewRiskLevel: null,
    reviewJson: null,
    reviewLifecycle: {
      status: 'running',
      isActive: true,
      isTerminal: false,
      phase: 'agentic_tool_use',
      updatedAt: new Date().toISOString(),
      sourceStatus: 'reviewing',
    },
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeQueueEntry(overrides = {}) {
  return {
    id: 'queue-1',
    type: 'branch_review',
    projectId: 'p1',
    branchReviewId: 'br1',
    status: 'reviewing',
    queuedAt: new Date(Date.now() - 60_000).toISOString(),
    updatedAt: new Date().toISOString(),
    reviewError: null,
    progress: {
      phase: 'agentic_tool_use',
      elapsedSeconds: 60,
      filesCompleted: 1,
      totalFiles: 10,
      updatedAt: new Date().toISOString(),
    },
    lifecycle: {
      status: 'running',
      isActive: true,
      isTerminal: false,
      phase: 'agentic_tool_use',
      updatedAt: new Date().toISOString(),
      sourceStatus: 'reviewing',
    },
    ...overrides,
  };
}

function formatNaiveTimestamp(value) {
  const pad = (input, width = 2) => String(input).padStart(width, '0');
  return [
    `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`,
    `${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`,
  ].join(' ');
}
