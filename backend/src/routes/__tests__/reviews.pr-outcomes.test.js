import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('express', () => ({
  default: {
    Router: () => {
      const stack = [];
      const router = {
        stack,
      };
      for (const method of ['get', 'put', 'delete', 'post']) {
        router[method] = (path, ...handlers) => {
          stack.push({
            route: {
              path,
              methods: { [method]: true },
              stack: handlers.map((handle) => ({ handle })),
            },
          });
          return router;
        };
      }
      return router;
    },
  },
}));

vi.mock('../../db/queries.js', () => ({
  getProjectById: vi.fn(),
}));

vi.mock('../../services/reviewService.js', () => ({
  default: {},
}));

vi.mock('../../services/reviewQualityHarness.js', () => ({
  default: {},
}));

vi.mock('../../services/changesetService.js', () => ({
  default: {},
}));

vi.mock('../../services/branchReviewService.js', () => ({
  default: {},
}));

vi.mock('../../services/prReviewService.js', () => ({
  default: {
    getById: vi.fn(),
  },
}));

vi.mock('../../services/reviewOutcomeService.js', () => ({
  default: {
    getRecommendationIdentityKey: vi.fn(),
    getRecommendationOutcomeDimensions: vi.fn(),
    upsertOutcome: vi.fn(),
    deleteOutcome: vi.fn(),
    listOutcomes: vi.fn(),
  },
}));

vi.mock('../../services/trustAnalyticsFactService.js', () => ({
  default: {
    syncReviewFacts: vi.fn(),
  },
}));

vi.mock('../../services/reviewSyncService.js', () => ({
  default: {
    queueEvent: vi.fn(),
    buildFindingOutcomeEvent: vi.fn((payload) => ({ ...payload, eventType: 'finding_addressed' })),
    buildFindingClearedEvent: vi.fn((payload) => ({ ...payload, eventType: 'finding_cleared' })),
  },
}));

vi.mock('../../../../shared/reviewPrecisionStats.js', () => ({
  normalizePrecisionIssueCounters: vi.fn((stats) => stats),
}));

import { getProjectById } from '../../db/queries.js';
import prReviewService from '../../services/prReviewService.js';
import reviewOutcomeService from '../../services/reviewOutcomeService.js';
import trustAnalyticsFactService from '../../services/trustAnalyticsFactService.js';
import reviewSyncService from '../../services/reviewSyncService.js';
import reviewsRouter from '../reviews.js';

function createMockReqRes(params = {}, body = {}, user = null) {
  const emit = vi.fn();
  const req = {
    params,
    body,
    user,
    app: {
      get: vi.fn((key) => {
        if (key === 'io') {
          return {
            to: vi.fn(() => ({
              emit,
            })),
          };
        }
        return undefined;
      }),
    },
  };
  const res = {
    json: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
  };
  return { req, res, emit };
}

async function callRouteHandler(router, method, path, req, res) {
  const stack = router.stack;
  const pathParts = path.split('/').filter(Boolean);

  for (const layer of stack) {
    if (!layer.route) continue;
    const routePath = layer.route.path;
    const routeMethod = Object.keys(layer.route.methods)[0];
    if (routeMethod !== method) continue;

    const routeParts = routePath.split('/').filter(Boolean);
    if (routeParts.length !== pathParts.length) continue;

    let matches = true;
    const params = {};
    for (let i = 0; i < routeParts.length; i += 1) {
      const routePart = routeParts[i];
      const pathPart = pathParts[i];
      if (routePart.startsWith(':')) {
        params[routePart.slice(1)] = pathPart;
      } else if (routePart !== pathPart) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;

    req.params = { ...req.params, ...params };
    const handlers = layer.route.stack.map((item) => item.handle);
    for (const handler of handlers) {
      await new Promise((resolve, reject) => {
        const next = (err) => (err ? reject(err) : resolve());
        const result = handler(req, res, next);
        if (result instanceof Promise) result.then(resolve).catch(reject);
      });
    }
    return;
  }

  throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
}

describe('PR review outcome routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProjectById.mockResolvedValue({
      id: 'proj-1',
      path: '/tmp/repo',
      user_id: '00000000-0000-0000-0000-000000000000',
    });
    prReviewService.getById.mockResolvedValue({
      id: 'pr-1',
      projectId: 'proj-1',
      reviewJson: {
        provider: { type: 'openai', model: 'gpt-5' },
        recommendations: [
          { fingerprint: 'rec-1', title: 'Fix the bug' },
        ],
      },
    });
    reviewOutcomeService.getRecommendationIdentityKey.mockReturnValue('rec-1');
    reviewOutcomeService.getRecommendationOutcomeDimensions.mockReturnValue({
      providerType: 'openai',
      providerModel: 'gpt-5',
      filePath: 'src/example.ts',
    });
    reviewOutcomeService.upsertOutcome.mockResolvedValue({
      id: 'outcome-1',
      status: 'addressed',
    });
    reviewOutcomeService.listOutcomes.mockResolvedValue({
      outcomes: [{ id: 'outcome-1', status: 'addressed' }],
    });
    trustAnalyticsFactService.syncReviewFacts.mockResolvedValue();
  });

  it('upserts PR review outcomes through the dedicated route', async () => {
    const { req, res, emit } = createMockReqRes(
      { projectId: 'proj-1', prReviewId: 'pr-1' },
      {
        recommendationKey: 'rec-1',
        status: 'addressed',
        filePath: 'src/example.ts',
      }
    );

    await callRouteHandler(
      reviewsRouter,
      'put',
      '/projects/proj-1/pr-reviews/pr-1/review/outcomes',
      req,
      res
    );

    expect(prReviewService.getById).toHaveBeenCalledWith('pr-1');
    expect(reviewOutcomeService.upsertOutcome).toHaveBeenCalledWith(
      {
        projectId: 'proj-1',
        reviewType: 'pr_review',
        reviewId: 'pr-1',
      },
      expect.objectContaining({
        recommendationKey: 'rec-1',
        status: 'addressed',
        dimensions: {
          providerType: 'openai',
          providerModel: 'gpt-5',
          filePath: 'src/example.ts',
        },
      })
    );
    expect(trustAnalyticsFactService.syncReviewFacts).toHaveBeenCalledWith({
      projectId: 'proj-1',
      reviewType: 'pr_review',
      reviewId: 'pr-1',
    });
    expect(reviewSyncService.buildFindingOutcomeEvent).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1',
      projectName: null,
      projectPath: '/tmp/repo',
      reviewType: 'pr_review',
      reviewId: 'pr-1',
      recommendationKey: 'rec-1',
      status: 'addressed',
    }));
    expect(reviewSyncService.queueEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'finding_addressed',
      recommendationKey: 'rec-1',
    }));
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      outcome: { id: 'outcome-1', status: 'addressed' },
      outcomes: [{ id: 'outcome-1', status: 'addressed' }],
    });
    expect(emit).toHaveBeenCalledWith('review-outcomes-updated', {
      projectId: 'proj-1',
      reviewType: 'pr_review',
      reviewId: 'pr-1',
      action: 'upsert',
      recommendationKey: 'rec-1',
    });
  });

  it('lists PR review outcomes through the dedicated route', async () => {
    const { req, res } = createMockReqRes(
      { projectId: 'proj-1', prReviewId: 'pr-1' }
    );

    await callRouteHandler(
      reviewsRouter,
      'get',
      '/projects/proj-1/pr-reviews/pr-1/review/outcomes',
      req,
      res
    );

    expect(prReviewService.getById).toHaveBeenCalledWith('pr-1');
    expect(reviewOutcomeService.listOutcomes).toHaveBeenCalledWith(
      {
        projectId: 'proj-1',
        reviewType: 'pr_review',
        reviewId: 'pr-1',
      },
      expect.objectContaining({
        reviewRecommendations: expect.any(Array),
      })
    );
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      outcomes: [{ id: 'outcome-1', status: 'addressed' }],
    });
  });

  it('deletes PR review outcomes through the dedicated route', async () => {
    reviewOutcomeService.deleteOutcome.mockResolvedValue({ id: 'outcome-1', status: 'addressed' });
    const { req, res, emit } = createMockReqRes(
      { projectId: 'proj-1', prReviewId: 'pr-1' },
      { recommendationKey: 'rec-1' }
    );

    await callRouteHandler(
      reviewsRouter,
      'delete',
      '/projects/proj-1/pr-reviews/pr-1/review/outcomes',
      req,
      res
    );

    expect(prReviewService.getById).toHaveBeenCalledWith('pr-1');
    expect(reviewOutcomeService.deleteOutcome).toHaveBeenCalledWith(
      {
        projectId: 'proj-1',
        reviewType: 'pr_review',
        reviewId: 'pr-1',
      },
      { recommendationKey: 'rec-1' }
    );
    expect(trustAnalyticsFactService.syncReviewFacts).toHaveBeenCalledWith({
      projectId: 'proj-1',
      reviewType: 'pr_review',
      reviewId: 'pr-1',
    });
    expect(reviewSyncService.buildFindingClearedEvent).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1',
      projectName: null,
      projectPath: '/tmp/repo',
      reviewType: 'pr_review',
      reviewId: 'pr-1',
      recommendationKey: 'rec-1',
    }));
    expect(reviewSyncService.queueEvent).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'finding_cleared',
      recommendationKey: 'rec-1',
    }));
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      deletedOutcome: { id: 'outcome-1', status: 'addressed' },
      outcomes: [{ id: 'outcome-1', status: 'addressed' }],
    });
    expect(emit).toHaveBeenCalledWith('review-outcomes-updated', {
      projectId: 'proj-1',
      reviewType: 'pr_review',
      reviewId: 'pr-1',
      action: 'delete',
      recommendationKey: 'rec-1',
    });
  });
});
