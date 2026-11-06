import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { createPrepareFixPlanFromFindingsPrompt } from '../dist/src/prompts/prepareFixPlanFromFindings.js';
import { createTriageHighRiskFindingsPrompt } from '../dist/src/prompts/triageHighRiskFindings.js';
import { createReviewCurrentFindingsResource } from '../dist/src/resources/reviewCurrentFindings.js';
import { runFileTool } from '../dist/src/tools/file.js';
import { runLatestTool } from '../dist/src/tools/latest.js';
import { runOutcomeClearTool } from '../dist/src/tools/outcomeClear.js';
import { runOutcomeGetTool } from '../dist/src/tools/outcomeGet.js';
import { runOutcomeSetTool } from '../dist/src/tools/outcomeSet.js';

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
  return {
    getProjects: async () => [{
      id: 'p1',
      name: 'AtlasEngineMVP',
      path: repoRoot,
      sessionId: 'session-heavy',
      description: 'heavy project payload',
      memorySize: 12345,
    }],
    listBranchReviews: async () => [{
      id: 'br1',
      projectId: 'p1',
      displayId: 'BR-001',
      branchName: currentBranch,
      status: 'active',
      isCurrent: true,
      reviewStatus: 'reviewed',
      reviewJson: {
        summary: 'Summary',
        riskLevel: 'medium',
        recommendations: [],
      },
    }],
    getBranchReview: async () => null,
    listWorkspaceReviews: async () => [],
    getWorkspaceReview: async () => null,
    getPrReview: async () => null,
    listPrReviews: async () => [],
    getChangeset: async () => null,
    listReviewOutcomes: async () => ({
      success: true,
      scope: {
        projectId: 'p1',
        reviewType: 'branch_review',
        reviewId: 'br1',
      },
      outcomes: [],
      byRecommendationKey: {},
      telemetry: null,
    }),
    upsertReviewOutcome: async () => {
      throw new Error('upsertReviewOutcome should not be called');
    },
    deleteReviewOutcome: async () => {
      throw new Error('deleteReviewOutcome should not be called');
    },
    ...overrides,
  };
}

test('outcome_set rejects writes without a canonical recommendation key', async () => {
  await assert.rejects(
    () => runOutcomeSetTool(
      createClient(),
      config,
      repoRoot,
      {
        projectId: 'p1',
        status: 'addressed',
      }
    ),
    /Provide findingId or recommendationKey/u
  );
});

test('outcome_set resolves short finding IDs to recommendation keys', async () => {
  const calls = [];
  const result = await runOutcomeSetTool(
    createClient({
      getBranchReview: async () => ({
        id: 'br1',
        projectId: 'p1',
        displayId: 'BR-001',
        reviewJson: {
          recommendations: [{
            findingId: 'F1',
            recommendationKey: 'rec-1',
            type: 'issue',
            severity: 'medium',
            title: 'Fix this',
          }],
        },
      }),
      upsertReviewOutcome: async (projectId, reviewType, reviewId, payload) => {
        calls.push({ projectId, reviewType, reviewId, payload });
        return {
          success: true,
          outcome: {
            projectId,
            reviewType,
            reviewId,
            recommendationKey: payload.recommendationKey,
            status: payload.status,
            note: null,
            dimensions: {},
          },
          outcomes: [],
          telemetry: null,
        };
      },
    }),
    config,
    repoRoot,
    {
      projectId: 'p1',
      status: 'addressed',
      findingId: 'F1',
    }
  );

  assert.deepEqual(calls[0].payload, {
    status: 'addressed',
    note: undefined,
    recommendationKey: 'rec-1',
    filePath: undefined,
  });
  assert.equal(result.data.recommendationKey, 'rec-1');
});

test('outcome_set resolves short finding IDs from carried previous findings', async () => {
  const calls = [];
  const result = await runOutcomeSetTool(
    createClient({
      getBranchReview: async () => ({
        id: 'br1',
        projectId: 'p1',
        displayId: 'BR-001',
        reviewJson: {
          recommendations: [],
          previousFindings: [{
            findingId: 'F3',
            recommendationKey: 'prior-rec-1',
            previousFinding: true,
            type: 'issue',
            severity: 'medium',
            title: 'Still needs a fix',
          }],
        },
      }),
      upsertReviewOutcome: async (projectId, reviewType, reviewId, payload) => {
        calls.push({ projectId, reviewType, reviewId, payload });
        return {
          success: true,
          outcome: {
            projectId,
            reviewType,
            reviewId,
            recommendationKey: payload.recommendationKey,
            status: payload.status,
            note: null,
            dimensions: {},
          },
          outcomes: [],
          telemetry: null,
        };
      },
    }),
    config,
    repoRoot,
    {
      projectId: 'p1',
      status: 'addressed',
      findingId: 'F3',
    }
  );

  assert.equal(calls[0].payload.recommendationKey, 'prior-rec-1');
  assert.equal(result.data.recommendationKey, 'prior-rec-1');
});

test('outcome_get routes PR review scopes through the MCP client', async () => {
  const calls = [];
  const result = await runOutcomeGetTool(
    createClient({
      listPrReviews: async () => [{
        id: 'pr1',
        projectId: 'p1',
        githubPrNumber: 64,
        title: 'Add feature',
      }],
      getPrReview: async () => ({
        id: 'pr1',
        projectId: 'p1',
        githubPrNumber: 64,
        title: 'Add feature',
      }),
      listReviewOutcomes: async (projectId, reviewType, reviewId) => {
        calls.push({ projectId, reviewType, reviewId });
        return {
          success: true,
          scope: {
            projectId,
            reviewType,
            reviewId,
          },
          outcomes: [],
          byRecommendationKey: {},
          telemetry: null,
        };
      },
    }),
    config,
    repoRoot,
    {
      projectId: 'p1',
      reviewType: 'pr_review',
      prReviewId: 'pr1',
    }
  );

  assert.deepEqual(calls, [{
    projectId: 'p1',
    reviewType: 'pr_review',
    reviewId: 'pr1',
  }]);
  assert.equal(result.data.review.type, 'pr_review');
  assert.equal(result.data.review.label, 'PR #64');
});

test('outcome_clear routes changeset scopes and deletes by recommendation key', async () => {
  const calls = [];
  const result = await runOutcomeClearTool(
    createClient({
      getChangeset: async () => ({
        id: 'cs1',
        projectId: 'p1',
        displayId: 'CS-001',
      }),
      deleteReviewOutcome: async (projectId, reviewType, reviewId, payload) => {
        calls.push({ projectId, reviewType, reviewId, payload });
        return {
          success: true,
          deletedOutcome: {
            projectId,
            reviewType,
            reviewId,
            recommendationKey: payload.recommendationKey,
            status: 'dismissed',
            note: null,
            dimensions: {
              providerType: 'unknown',
              providerModel: 'unknown',
              language: 'typescript',
              pathPattern: 'src/**',
            },
          },
          outcomes: [],
          telemetry: null,
        };
      },
    }),
    config,
    repoRoot,
    {
      projectId: 'p1',
      reviewType: 'changeset',
      changesetId: 'cs1',
      recommendationKey: 'rec-1',
    }
  );

  assert.deepEqual(calls, [{
    projectId: 'p1',
    reviewType: 'changeset',
    reviewId: 'cs1',
    payload: {
      recommendationKey: 'rec-1',
    },
  }]);
  assert.equal(result.data.review.label, 'CS-001');
  assert.equal(result.data.deletedOutcome?.status, 'dismissed');
});

test('latest includes recommendation keys and current outcome state for findings', async () => {
  const result = await runLatestTool(
    createClient({
      getBranchReview: async () => ({
        id: 'br1',
        projectId: 'p1',
        displayId: 'BR-001',
        reviewJson: {
          summary: 'Summary',
          riskLevel: 'high',
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
      }),
      listReviewOutcomes: async () => ({
        success: true,
        scope: {
          projectId: 'p1',
          reviewType: 'branch_review',
          reviewId: 'br1',
        },
        outcomes: [{
          projectId: 'p1',
          reviewType: 'branch_review',
          reviewId: 'br1',
          recommendationKey: 'issue|high|escape output|user content is rendered unsafely|src/app.ts|42|escape user content before rendering',
          status: 'addressed',
          note: 'Fixed',
          dimensions: {
            providerType: 'unknown',
            providerModel: 'unknown',
            language: 'typescript',
            pathPattern: 'src/**',
          },
        }],
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
    }),
    config,
    repoRoot,
    { projectId: 'p1' }
  );

  assert.equal(result.data.findings.length, 1);
  assert.equal(result.data.findings[0].findingId, 'F1');
  assert.equal(
    result.data.findings[0].recommendationKey,
    'issue|high|escape output|user content is rendered unsafely|src/app.ts|42|escape user content before rendering'
  );
  assert.equal(result.data.findings[0].outcome?.status, 'addressed');
  assert.deepEqual(Object.keys(result.data.project).sort(), ['id', 'name', 'path']);
  assert.equal('reviewJson' in (result.data.branchReview || {}), false);
});

test('current findings resource exposes recommendation keys and persisted outcomes', async () => {
  const resource = createReviewCurrentFindingsResource({
    client: createClient({
      getProjects: async () => [{
        id: 'p1',
        name: 'AtlasEngineMVP',
        path: repoRoot,
      }],
      getBranchReview: async () => ({
        id: 'br1',
        projectId: 'p1',
        displayId: 'BR-001',
        branchName: currentBranch,
        reviewJson: {
          recommendations: [{
            type: 'issue',
            severity: 'medium',
            title: 'Handle null response',
            description: 'Null responses are not checked',
            file: 'src/service.ts',
            line: 10,
            suggestedFix: 'Guard the null response',
          }],
        },
      }),
      listReviewOutcomes: async () => ({
        success: true,
        scope: {
          projectId: 'p1',
          reviewType: 'branch_review',
          reviewId: 'br1',
        },
        outcomes: [],
        byRecommendationKey: {
          'issue|medium|handle null response|null responses are not checked|src/service.ts|10|guard the null response': {
            recommendationKey: 'issue|medium|handle null response|null responses are not checked|src/service.ts|10|guard the null response',
            status: 'dismissed',
            note: 'Intentional',
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
    }),
    config,
    cwd: repoRoot,
  });

  const result = await resource.handler();
  assert.equal(result.data.findings.length, 1);
  assert.equal(result.data.findings[0].findingId, 'F1');
  assert.equal(
    result.data.findings[0].recommendationKey,
    'issue|medium|handle null response|null responses are not checked|src/service.ts|10|guard the null response'
  );
  assert.equal(result.data.findings[0].outcome?.status, 'dismissed');
});

test('file tool fallback finding IDs skip praise entries consistently', async () => {
  const result = await runFileTool(
    createClient({
      getBranchReview: async () => ({
        id: 'br1',
        projectId: 'p1',
        displayId: 'BR-001',
        branchName: currentBranch,
        reviewJson: {
          recommendations: [
            {
              type: 'praise',
              severity: 'low',
              title: 'Good structure',
              description: 'The structure is clear',
              file: 'src/app.ts',
              line: 1,
            },
            {
              type: 'issue',
              severity: 'medium',
              title: 'Handle null response',
              description: 'Null responses are not checked',
              file: 'src/service.ts',
              line: 10,
              suggestedFix: 'Guard the null response',
            },
          ],
        },
      }),
      getBranchReviewFileContent: async () => ({
        files: [{
          path: 'src/service.ts',
          status: 'modified',
          content: '',
          oldContent: '',
          diff: '',
        }],
        missingPaths: [],
      }),
    }),
    config,
    repoRoot,
    {
      projectId: 'p1',
      path: 'src/service.ts',
    }
  );

  assert.equal(result.data.findings.length, 1);
  assert.equal(result.data.findings[0].findingId, 'F1');
  assert.equal(
    result.data.findings[0].recommendationKey,
    'issue|medium|handle null response|null responses are not checked|src/service.ts|10|guard the null response'
  );
});

test('fix-plan and triage prompts include carried previous findings', async () => {
  const client = createClient({
    getBranchReview: async () => ({
      id: 'br1',
      projectId: 'p1',
      displayId: 'BR-001',
      branchName: currentBranch,
      reviewStatus: 'reviewed',
      reviewJson: {
        summary: 'Summary',
        riskLevel: 'medium',
        recommendations: [{
          findingId: 'F1',
          type: 'issue',
          severity: 'low',
          title: 'Current finding',
          description: 'Current issue',
          file: 'src/current.ts',
          line: 4,
        }],
        previousFindings: [{
          findingId: 'F2',
          previousFinding: true,
          type: 'issue',
          severity: 'high',
          title: 'Carried finding',
          description: 'Prior issue still unresolved',
          file: 'src/prior.ts',
          line: 12,
        }],
      },
    }),
  });
  const deps = { client, config, cwd: repoRoot };

  const fixPlan = await createPrepareFixPlanFromFindingsPrompt(deps).handler({ projectId: 'p1' });
  assert.match(fixPlan.messages[0].text, /"findingId": "F2"/u);
  assert.match(fixPlan.messages[0].text, /"previousFinding": true/u);
  assert.match(fixPlan.messages[0].text, /Carried finding/u);

  const triage = await createTriageHighRiskFindingsPrompt(deps).handler({ projectId: 'p1' });
  assert.match(triage.messages[0].text, /"findingId": "F2"/u);
  assert.match(triage.messages[0].text, /"previousFinding": true/u);
  assert.match(triage.messages[0].text, /Carried finding/u);
});
