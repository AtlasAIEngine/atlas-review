import test from 'node:test';
import assert from 'node:assert/strict';

import { runGitHubPublicationsTool } from '../dist/src/tools/githubPublications.js';
import { runGitHubPublishTool } from '../dist/src/tools/githubPublish.js';

const config = {
  backendUrl: 'http://127.0.0.1:3000/api',
  apiToken: null,
  autoImport: false,
  requestTimeoutMs: 120_000,
  enableWatcherSync: false,
};

function createClient(overrides = {}) {
  return {
    getProjects: async () => [{
      id: 'p1',
      name: 'AtlasEngineMVP',
      path: '/repo',
    }],
    listBranchReviews: async () => [{
      id: 'br1',
      projectId: 'p1',
      displayId: 'BR-001',
      status: 'active',
      isCurrent: true,
      reviewStatus: 'reviewed',
      reviewJson: { summary: 'Summary', riskLevel: 'medium', recommendations: [] },
    }],
    getBranchReview: async () => null,
    listPrReviews: async () => [{
      id: 'pr1',
      projectId: 'p1',
      displayId: 'PR-001',
      githubPrNumber: 65,
      title: 'Add feature',
      reviewStatus: 'reviewed',
      reviewJson: { summary: 'Summary', riskLevel: 'medium', recommendations: [] },
    }],
    getPrReview: async () => ({
      id: 'pr1',
      projectId: 'p1',
      displayId: 'PR-001',
      githubPrNumber: 65,
      title: 'Add feature',
      reviewStatus: 'reviewed',
      reviewJson: { summary: 'Summary', riskLevel: 'medium', recommendations: [] },
    }),
    getChangeset: async () => null,
    getPrReviewPublications: async () => ({
      success: true,
      publication: {
        scope: {
          projectId: 'p1',
          reviewType: 'pr_review',
          reviewId: 'pr1',
        },
        publications: [],
        byRecommendationKey: {},
        totalPublished: 0,
        latestAction: null,
        latestPublishedAt: null,
      },
    }),
    publishPrReview: async () => ({
      success: true,
      publication: {
        scope: {
          projectId: 'p1',
          reviewType: 'pr_review',
          reviewId: 'pr1',
        },
        publications: [{
          recommendationKey: 'rec-1',
          channel: 'github_pr_review',
          action: 'request_changes',
          githubReviewId: '2001',
          path: 'src/app.ts',
          line: 42,
        }],
        byRecommendationKey: {
          'rec-1': {
            recommendationKey: 'rec-1',
            channel: 'github_pr_review',
            action: 'request_changes',
            githubReviewId: '2001',
            path: 'src/app.ts',
            line: 42,
          },
        },
        totalPublished: 1,
        latestAction: 'request_changes',
        latestPublishedAt: '2026-03-09T12:00:00.000Z',
      },
      reviewSubmission: {
        event: 'REQUEST_CHANGES',
        githubReviewId: '2001',
        commentCount: 1,
      },
      results: [{
        recommendationKey: 'rec-1',
        status: 'published',
        path: 'src/app.ts',
        line: 42,
        githubReviewId: '2001',
      }],
    }),
    ...overrides,
  };
}

test('github_publications returns persisted PR publication state', async () => {
  const result = await runGitHubPublicationsTool(
    createClient({
      getPrReviewPublications: async () => ({
        success: true,
        publication: {
          scope: {
            projectId: 'p1',
            reviewType: 'pr_review',
            reviewId: 'pr1',
          },
          publications: [{
            recommendationKey: 'rec-1',
            channel: 'github_pr_review',
            action: 'comment',
            githubReviewId: '2001',
            path: 'src/app.ts',
            line: 42,
          }],
          byRecommendationKey: {
            'rec-1': {
              recommendationKey: 'rec-1',
              channel: 'github_pr_review',
              action: 'comment',
              githubReviewId: '2001',
              path: 'src/app.ts',
              line: 42,
            },
          },
          totalPublished: 1,
          latestAction: 'comment',
          latestPublishedAt: '2026-03-09T12:00:00.000Z',
        },
      }),
    }),
    config,
    '/repo',
    {
      projectId: 'p1',
      reviewType: 'pr_review',
      prReviewId: 'pr1',
    }
  );

  assert.equal(result.data.review.type, 'pr_review');
  assert.equal(result.data.publication.totalPublished, 1);
  assert.match(result.summary, /Published findings: 1/u);
});

test('github_publish submits PR review publication through the MCP client', async () => {
  const calls = [];
  const result = await runGitHubPublishTool(
    createClient({
      publishPrReview: async (projectId, prReviewId, payload) => {
        calls.push({ projectId, prReviewId, payload });
        return {
          success: true,
          publication: {
            scope: {
              projectId,
              reviewType: 'pr_review',
              reviewId: prReviewId,
            },
            publications: [],
            byRecommendationKey: {},
            totalPublished: 1,
            latestAction: 'approve',
            latestPublishedAt: '2026-03-09T12:00:00.000Z',
          },
          reviewSubmission: {
            event: 'APPROVE',
            githubReviewId: '2002',
            commentCount: 1,
          },
          results: [{
            recommendationKey: 'rec-1',
            status: 'published',
            githubReviewId: '2002',
          }],
        };
      },
    }),
    config,
    '/repo',
    {
      projectId: 'p1',
      reviewType: 'pr_review',
      prReviewId: 'pr1',
      action: 'approve',
      recommendationKeys: ['rec-1'],
    }
  );

  assert.deepEqual(calls, [{
    projectId: 'p1',
    prReviewId: 'pr1',
    payload: {
      action: 'approve',
      recommendationKeys: ['rec-1'],
      body: null,
    },
  }]);
  assert.equal(result.data.action, 'approve');
  assert.equal(result.data.reviewSubmission?.event, 'APPROVE');
  assert.match(result.summary, /GitHub action: approve/u);
});
