import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('express', () => ({
  default: {
    Router: () => {
      const stack = [];
      const router = {
        stack,
        post(path, ...handlers) {
          stack.push({
            route: {
              path,
              methods: { post: true },
              stack: handlers.map((handle) => ({ handle })),
            },
          });
          return router;
        },
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
  findUserByEmail: vi.fn(),
  findUserById: vi.fn(),
  updateUserLastLogin: vi.fn(),
}));

vi.mock('../../db/connection.js', () => ({
  query: vi.fn(),
  getDbType: () => 'sqlite',
}));

vi.mock('../../middleware/auth.js', () => ({
  authenticateJWT: (_req, _res, next) => next(),
  requireAuth: (_req, _res, next) => next(),
}));

import { query } from '../../db/connection.js';
import { updateUserLastLogin } from '../../db/queries.js';
import authRouter from '../auth.js';

function createMockReqRes({ body = {} } = {}) {
  return {
    req: { body },
    res: {
      json: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
    },
  };
}

async function callRouteHandler(router, method, path, req, res) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const routeMethod = Object.keys(layer.route.methods)[0];
    if (routeMethod !== method || layer.route.path !== path) continue;
    for (const entry of layer.route.stack) {
      const result = entry.handle(req, res, () => {});
      if (result instanceof Promise) await result;
    }
    return;
  }
  throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
}

function mockGitHubProfile(profile = {}) {
  global.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      id: 4242,
      login: 'octocat',
      avatar_url: 'https://example.com/octocat.png',
      ...profile,
    }),
  }));
}

describe('POST /api/auth/github', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = 'test-secret';
    mockGitHubProfile();
  });

  it('matches users by durable numeric GitHub id before login', async () => {
    query.mockResolvedValueOnce({
      rows: [{
        id: 'user-by-id',
        email: 'id@example.com',
        name: 'By Id',
        plan: 'free',
        is_admin: false,
        github_user_id: 4242,
        github_login: 'renamed-octocat',
        github_avatar_url: null,
      }],
    });

    const { req, res } = createMockReqRes({ body: { access_token: 'gh-token' } });
    await callRouteHandler(authRouter, 'post', '/github', req, res);

    expect(query).toHaveBeenCalledWith(
      'SELECT * FROM users WHERE github_user_id = $1 AND is_active = TRUE LIMIT 1',
      [4242]
    );
    expect(updateUserLastLogin).toHaveBeenCalledWith('user-by-id');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      user: expect.objectContaining({ id: 'user-by-id', github_login: 'octocat' }),
    }));
  });

  it('falls back to login and backfills github_user_id when safe', async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'legacy-user',
          email: 'legacy@example.com',
          name: 'Legacy',
          plan: 'free',
          is_admin: false,
          github_user_id: null,
          github_login: 'octocat',
          github_avatar_url: null,
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const { req, res } = createMockReqRes({ body: { access_token: 'gh-token' } });
    await callRouteHandler(authRouter, 'post', '/github', req, res);

    expect(query).toHaveBeenNthCalledWith(
      2,
      'SELECT * FROM users WHERE github_login = $1 AND is_active = TRUE LIMIT 1',
      ['octocat']
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('SET github_user_id = $1'),
      [4242, 'octocat', 'https://example.com/octocat.png', 'legacy-user']
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      user: expect.objectContaining({ id: 'legacy-user', github_login: 'octocat' }),
    }));
  });
});
