import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('express', () => ({
  default: {
    Router: () => {
      const stack = [];
      const router = { stack };
      for (const method of ['get', 'post', 'patch', 'delete']) {
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

vi.mock('../../services/review/reviewAgentStore.js', () => ({
  default: {
    getOrCreateSession: vi.fn(),
  },
}));

import { getProjectById } from '../../db/queries.js';
import reviewAgentStore from '../../services/review/reviewAgentStore.js';
import reviewAgentRouter from '../reviewAgent.js';

const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

function createMockReqRes({ params = {}, query = {}, body = {}, user = null } = {}) {
  const req = { params, query, body, user };
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
    const handlers = layer.route.stack.map((entry) => entry.handle);
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

describe('review agent routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reviewAgentStore.getOrCreateSession.mockResolvedValue({
      id: 'session-1',
      projectId: 'project-1',
      userId: 'owner-user',
      status: 'active',
    });
  });

  it('does not accept body userId as proof of project ownership', async () => {
    getProjectById.mockResolvedValue({
      id: 'project-1',
      user_id: 'owner-user',
    });
    const { req, res } = createMockReqRes({
      body: {
        userId: 'owner-user',
        reviewType: 'pr_review',
        reviewId: 'pr-1',
      },
    });

    await callRouteHandler(reviewAgentRouter, 'post', '/project-1/review-agent/sessions', req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Forbidden' });
    expect(reviewAgentStore.getOrCreateSession).not.toHaveBeenCalled();
  });

  it('creates a session for the authenticated project owner', async () => {
    getProjectById.mockResolvedValue({
      id: 'project-1',
      user_id: 'owner-user',
    });
    const { req, res } = createMockReqRes({
      body: {
        userId: 'spoofed-user',
        reviewType: 'pr_review',
        reviewId: 'pr-1',
      },
      user: { id: 'owner-user' },
    });

    await callRouteHandler(reviewAgentRouter, 'post', '/project-1/review-agent/sessions', req, res);

    expect(reviewAgentStore.getOrCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      reviewType: 'pr_review',
      reviewId: 'pr-1',
      userId: 'owner-user',
    }));
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      session: expect.objectContaining({ id: 'session-1' }),
    });
  });

  it('keeps anonymous project access using the anonymous user id', async () => {
    getProjectById.mockResolvedValue({
      id: 'project-1',
      user_id: ANONYMOUS_USER_ID,
    });
    const { req, res } = createMockReqRes({
      body: {
        userId: 'spoofed-user',
        reviewType: 'branch_review',
        reviewId: 'br-1',
      },
    });

    await callRouteHandler(reviewAgentRouter, 'post', '/project-1/review-agent/sessions', req, res);

    expect(reviewAgentStore.getOrCreateSession).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-1',
      reviewType: 'branch_review',
      reviewId: 'br-1',
      userId: ANONYMOUS_USER_ID,
    }));
    expect(res.status).not.toHaveBeenCalled();
  });
});
