import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('express', () => ({
  default: {
    Router: () => {
      const stack = [];
      const router = {
        stack,
        get(path, ...handlers) {
          stack.push({
            route: {
              path,
              methods: { get: true },
              stack: handlers.map((handle) => ({ handle })),
            },
          });
          return router;
        },
      };
      return router;
    },
  },
}));

vi.mock('../../db/queries.js', () => ({
  getProjectById: vi.fn(),
}));

vi.mock('../../middleware/quotas.js', () => ({
  enforceQuotas: (req, _res, next) => next(),
}));

vi.mock('../../services/trustAnalyticsService.js', () => ({
  default: {
    getProjectTrustAnalyticsSummary: vi.fn(),
    getProjectTrustAnalyticsTimeseries: vi.fn(),
  },
}));

vi.mock('../../services/trustAnalyticsBreakdownService.js', () => ({
  default: {
    getProjectTrustAnalyticsBreakdown: vi.fn(),
  },
}));

import { getProjectById } from '../../db/queries.js';
import trustAnalyticsService from '../../services/trustAnalyticsService.js';
import trustAnalyticsBreakdownService from '../../services/trustAnalyticsBreakdownService.js';
import trustAnalyticsRouter from '../trustAnalytics.js';

function createMockReqRes(params = {}, query = {}, user = null) {
  const req = { params, query, user };
  const res = {
    json: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
  };
  return { req, res };
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

describe('trust analytics routes', () => {
  const project = {
    id: 'proj-1',
    path: '/tmp/repo',
    user_id: '00000000-0000-0000-0000-000000000000',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getProjectById.mockResolvedValue(project);
  });

  it('returns the project summary payload', async () => {
    trustAnalyticsService.getProjectTrustAnalyticsSummary.mockResolvedValue({
      reviewCount: 2,
      comparison: { dominantScope: 'balanced' },
      heroCards: [{ key: 'median_ttfs', label: 'Median TTFS' }],
    });

    const { req, res } = createMockReqRes(
      { projectId: 'proj-1' },
      { window: '7d', scope: 'prs' }
    );
    await callRouteHandler(trustAnalyticsRouter, 'get', '/proj-1/trust-analytics/summary', req, res);

    expect(trustAnalyticsService.getProjectTrustAnalyticsSummary).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1',
      projectPath: '/tmp/repo',
      window: '7d',
      scope: 'prs',
    }));
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      summary: {
        reviewCount: 2,
        comparison: { dominantScope: 'balanced' },
        heroCards: [{ key: 'median_ttfs', label: 'Median TTFS' }],
      },
    });
  });

  it('returns the project timeseries payload', async () => {
    trustAnalyticsService.getProjectTrustAnalyticsTimeseries.mockResolvedValue({
      points: [],
      metricLabel: 'Review start',
      metricDescription: 'Time to first signal across completed reviews.',
    });

    const { req, res } = createMockReqRes(
      { projectId: 'proj-1' },
      { metric: 'ttfs_ms', window: '30d', interval: 'day' }
    );
    await callRouteHandler(trustAnalyticsRouter, 'get', '/proj-1/trust-analytics/timeseries', req, res);

    expect(trustAnalyticsService.getProjectTrustAnalyticsTimeseries).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1',
      projectPath: '/tmp/repo',
      metric: 'ttfs_ms',
      window: '30d',
      interval: 'day',
      scope: undefined,
    }));
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      timeseries: {
        points: [],
        metricLabel: 'Review start',
        metricDescription: 'Time to first signal across completed reviews.',
      },
    });
  });

  it('returns the project breakdown payload', async () => {
    trustAnalyticsBreakdownService.getProjectTrustAnalyticsBreakdown.mockResolvedValue({ groups: [] });

    const { req, res } = createMockReqRes(
      { projectId: 'proj-1' },
      { metric: 'grounded_issue_rate', by: 'provider_model', window: '30d', limit: '5' }
    );
    await callRouteHandler(trustAnalyticsRouter, 'get', '/proj-1/trust-analytics/breakdown', req, res);

    expect(trustAnalyticsBreakdownService.getProjectTrustAnalyticsBreakdown).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1',
      projectPath: '/tmp/repo',
      metric: 'grounded_issue_rate',
      by: 'provider_model',
      window: '30d',
      limit: '5',
      scope: undefined,
    }));
    expect(res.json).toHaveBeenCalledWith({ success: true, breakdown: { groups: [] } });
  });

  it('passes PR scope through to the breakdown route', async () => {
    trustAnalyticsBreakdownService.getProjectTrustAnalyticsBreakdown.mockResolvedValue({
      scope: 'prs',
      reviewType: 'pr_review',
      groups: [{ key: 'typescript', label: 'typescript', reviewCount: 2 }],
    });

    const { req, res } = createMockReqRes(
      { projectId: 'proj-1' },
      { metric: 'issues_found', by: 'language', window: '30d', scope: 'prs' }
    );
    await callRouteHandler(trustAnalyticsRouter, 'get', '/proj-1/trust-analytics/breakdown', req, res);

    expect(trustAnalyticsBreakdownService.getProjectTrustAnalyticsBreakdown).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1',
      projectPath: '/tmp/repo',
      metric: 'issues_found',
      by: 'language',
      window: '30d',
      scope: 'prs',
    }));
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      breakdown: {
        scope: 'prs',
        reviewType: 'pr_review',
        groups: [{ key: 'typescript', label: 'typescript', reviewCount: 2 }],
      },
    });
  });

  it('returns 404 when project is missing', async () => {
    getProjectById.mockResolvedValue(null);

    const { req, res } = createMockReqRes({ projectId: 'proj-404' });
    await callRouteHandler(trustAnalyticsRouter, 'get', '/proj-404/trust-analytics/summary', req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: 'Project not found' });
    expect(trustAnalyticsService.getProjectTrustAnalyticsSummary).not.toHaveBeenCalled();
  });

  it('propagates validation errors as 400 responses', async () => {
    trustAnalyticsService.getProjectTrustAnalyticsTimeseries.mockRejectedValue(Object.assign(new Error('metric must be one of: ttfs_ms'), { status: 400 }));

    const { req, res } = createMockReqRes(
      { projectId: 'proj-1' },
      { metric: 'bogus', window: '7d' }
    );
    await callRouteHandler(trustAnalyticsRouter, 'get', '/proj-1/trust-analytics/timeseries', req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'metric must be one of: ttfs_ms' });
  });
});
