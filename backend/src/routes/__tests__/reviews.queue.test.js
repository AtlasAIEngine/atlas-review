import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('express', () => ({
  default: {
    Router: () => {
      const stack = [];
      const router = { stack };
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
  default: {
    getQueueEntryStatus: vi.fn(),
    cancelQueuedReviewEntry: vi.fn(),
  },
}));
vi.mock('../../services/reviewQualityHarness.js', () => ({ default: {} }));
vi.mock('../../services/changesetService.js', () => ({ default: {} }));
vi.mock('../../services/branchReviewService.js', () => ({ default: { getById: vi.fn() } }));
vi.mock('../../services/prReviewService.js', () => ({ default: {} }));
vi.mock('../../services/workspaceReviewService.js', () => ({ default: {} }));
vi.mock('../../services/gitService.js', () => ({ default: {} }));
vi.mock('../../services/reviewOutcomeService.js', () => ({ default: {} }));
vi.mock('../../services/review/reviewFixRunStore.js', () => ({ default: {} }));
vi.mock('../../services/trustAnalyticsFactService.js', () => ({ default: {} }));
vi.mock('../../services/reviewSyncService.js', () => ({ default: {} }));
vi.mock('../../services/review/branchAutoReviewSuppression.js', () => ({
  suppressBranchAutoReviewForSnapshot: vi.fn(),
}));
vi.mock('../../../../shared/reviewPrecisionStats.js', () => ({
  normalizePrecisionIssueCounters: vi.fn((stats) => stats),
}));

import reviewService from '../../services/reviewService.js';
import reviewsRouter from '../reviews.js';

function createMockReqRes(user = null) {
  const req = {
    params: {},
    user,
    app: { get: vi.fn() },
  };
  const res = {
    json: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
  };
  return { req, res };
}

async function callRouteHandler(router, method, path, req, res) {
  const pathParts = path.split('/').filter(Boolean);
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const routeMethod = Object.keys(layer.route.methods)[0];
    if (routeMethod !== method) continue;
    const routeParts = layer.route.path.split('/').filter(Boolean);
    if (routeParts.length !== pathParts.length) continue;

    const params = {};
    let matched = true;
    for (let index = 0; index < routeParts.length; index += 1) {
      const routePart = routeParts[index];
      const pathPart = pathParts[index];
      if (routePart.startsWith(':')) {
        params[routePart.slice(1)] = pathPart;
        continue;
      }
      if (routePart !== pathPart) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;

    req.params = { ...req.params, ...params };
    for (const entry of layer.route.stack) {
      await entry.handle(req, res, () => {});
    }
    return;
  }

  throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
}

describe('review queue routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('rejects authenticated cancellation for queue entries without project context', async () => {
    reviewService.getQueueEntryStatus.mockReturnValue({
      id: 'queue-1',
      projectId: null,
      status: 'queued',
      type: 'workspace_review',
    });

    const { req, res } = createMockReqRes({ id: 'user-1' });
    await callRouteHandler(reviewsRouter, 'delete', '/review-queue/queue-1', req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' });
    expect(reviewService.cancelQueuedReviewEntry).not.toHaveBeenCalled();
  });

  it('allows anonymous cancellation for projectless queue entries', async () => {
    reviewService.getQueueEntryStatus.mockReturnValue({
      id: 'queue-1',
      projectId: null,
      status: 'queued',
      type: 'workspace_review',
    });
    reviewService.cancelQueuedReviewEntry.mockResolvedValue({ stopped: true, was: 'queued' });

    const { req, res } = createMockReqRes();
    await callRouteHandler(reviewsRouter, 'delete', '/review-queue/queue-1', req, res);

    expect(reviewService.cancelQueuedReviewEntry).toHaveBeenCalledWith('queue-1');
    expect(res.json).toHaveBeenCalledWith({ success: true, stopped: true, was: 'queued' });
  });
});
