import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
        delete(path, ...handlers) {
          stack.push({
            route: {
              path,
              methods: { delete: true },
              stack: handlers.map((handle) => ({ handle })),
            },
          });
          return router;
        },
        patch(path, ...handlers) {
          stack.push({
            route: {
              path,
              methods: { patch: true },
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

vi.mock('../../db/connection.js', () => ({
  default: { query: vi.fn() },
}));

vi.mock('../../db/queries.js', () => ({
  createProject: vi.fn(),
  updateProjectGeneratedReviewPolicy: vi.fn(),
  updateProjectLastAccessed: vi.fn(),
}));

vi.mock('../../middleware/quotas.js', () => ({
  enforceQuotas: (_req, _res, next) => next(),
}));

vi.mock('../../services/githubService.js', () => ({
  default: {
    getInstallation: vi.fn(),
    getInstallationById: vi.fn(),
    getRepositoryDetails: vi.fn(),
    resolveUserInstallationSyncAuth: vi.fn(),
    getUserRepositories: vi.fn(),
  },
}));

vi.mock('../../services/reviewSyncService.js', () => ({
  default: {
    getGuestSessionByAuthToken: vi.fn(),
  },
}));

vi.mock('../../services/githubAccountConnectionService.js', () => ({
  default: {
    connectGitHubAccount: connectGitHubAccountMock,
  },
  connectGitHubAccount: connectGitHubAccountMock,
}));

const { connectGitHubAccountMock } = vi.hoisted(() => ({
  connectGitHubAccountMock: vi.fn(),
}));

import db from '../../db/connection.js';
import * as queries from '../../db/queries.js';
import githubService from '../../services/githubService.js';
import githubAccountConnectionService from '../../services/githubAccountConnectionService.js';
import githubRouter, { __testing as githubRouteTesting } from '../github.js';

function createMockReqRes({ headers = {}, user = null } = {}) {
  const req = {
    headers,
    params: {},
    query: {},
    user,
    app: { get: vi.fn(() => null) },
  };
  const res = {
    json: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
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
        if (result instanceof Promise) {
          result.then(resolve).catch(reject);
        }
      });
    }
    return;
  }

  throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
}

describe('github connect route', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    githubService.getInstallation.mockResolvedValue(null);
    githubService.getInstallationById.mockResolvedValue(null);
    githubService.getRepositoryDetails.mockReset();
    githubService.resolveUserInstallationSyncAuth.mockResolvedValue(null);
    githubService.getUserRepositories.mockResolvedValue([]);
    queries.updateProjectLastAccessed.mockResolvedValue(null);
    githubRouteTesting.resetDeviceFlows();
    githubAccountConnectionService.connectGitHubAccount.mockResolvedValue({
      userId: '00000000-0000-0000-0000-000000000000',
      merged: false,
      profile: { id: 42, login: 'octocat' },
      primaryInstallationId: -1,
      installations: [],
    });
    db.query.mockResolvedValue({ rows: [] });
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/login/device/code')) {
        return {
          ok: true,
          json: async () => ({
            device_code: 'device-code-1',
            user_code: 'USER-CODE',
            verification_uri: 'https://github.com/login/device',
            verification_uri_complete: 'https://github.com/login/device?user_code=USER-CODE',
            interval: 5,
            expires_in: 900,
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    process.env.GITHUB_APP_CLIENT_ID = process.env.GITHUB_APP_CLIENT_ID || 'test-client-id';
  });

  it('uses the requested installation when re-linking an existing imported org repository', async () => {
    vi.useRealTimers();
    const existingProject = {
      id: 'project-1',
      session_id: 'session-1',
      user_id: 'user-1',
      name: 'AtlasEngineMVPClaude',
      description: null,
      framework: null,
      language: null,
      path: '/tmp/project-1',
      github_repo_full_name: 'AtlasAIEngine/AtlasEngineMVPClaude',
      github_repo_owner: 'AtlasAIEngine',
      github_repo_name: 'AtlasEngineMVPClaude',
      github_installation_id: 113423831,
      has_memory: true,
      status: 'active',
      source: 'github',
      created_at: '2026-05-01T00:00:00.000Z',
      updated_at: '2026-05-01T00:00:00.000Z',
      last_accessed: '2026-05-01T00:00:00.000Z',
    };
    githubService.getInstallationById.mockResolvedValue({
      user_id: 'user-1',
      installation_id: 113436148,
    });
    githubService.getRepositoryDetails.mockResolvedValue({
      id: 4242,
      fullName: 'AtlasAIEngine/AtlasEngineMVPClaude',
      cloneUrl: 'https://github.com/AtlasAIEngine/AtlasEngineMVPClaude.git',
      defaultBranch: 'main',
      description: null,
    });
    db.query
      .mockResolvedValueOnce({ rows: [existingProject] })
      .mockResolvedValueOnce({ rows: [] });

    const { req, res } = createMockReqRes({ user: { id: 'user-1' } });
    req.body = {
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVPClaude',
      installationId: 113436148,
    };

    await callRouteHandler(githubRouter, 'post', '/clone', req, res);

    expect(githubService.getInstallationById).toHaveBeenCalledWith(113436148);
    expect(githubService.getInstallation).not.toHaveBeenCalled();
    expect(db.query.mock.calls[1][1]).toEqual([
      4242,
      'AtlasAIEngine/AtlasEngineMVPClaude',
      113436148,
      'main',
      'https://github.com/AtlasAIEngine/AtlasEngineMVPClaude.git',
      'AtlasAIEngine',
      'AtlasEngineMVPClaude',
      'project-1',
    ]);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      alreadyExists: true,
      project: expect.objectContaining({
        github: expect.objectContaining({
          installationId: 113436148,
          repoFullName: 'AtlasAIEngine/AtlasEngineMVPClaude',
        }),
      }),
    }));
  });

  it('rejects clone when the requested installation belongs to another user', async () => {
    githubService.getInstallationById.mockResolvedValue({
      user_id: 'other-user',
      installation_id: 113436148,
    });

    const { req, res } = createMockReqRes({ user: { id: 'user-1' } });
    req.body = {
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVPClaude',
      installationId: 113436148,
    };

    await callRouteHandler(githubRouter, 'post', '/clone', req, res);

    expect(githubService.getInstallationById).toHaveBeenCalledWith(113436148);
    expect(githubService.getRepositoryDetails).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'You do not have access to this GitHub installation',
    });
  });

  it('returns not found when the requested clone installation does not exist', async () => {
    githubService.getInstallationById.mockResolvedValue(null);

    const { req, res } = createMockReqRes({ user: { id: 'user-1' } });
    req.body = {
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVPClaude',
      installationId: 113436148,
    };

    await callRouteHandler(githubRouter, 'post', '/clone', req, res);

    expect(githubService.getInstallationById).toHaveBeenCalledWith(113436148);
    expect(githubService.getRepositoryDetails).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({
      error: 'GitHub installation not found',
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    global.fetch = originalFetch;
  });

  it('uses device flow for localhost browser requests', async () => {
    const { req, res } = createMockReqRes({
      headers: {
        host: 'localhost:3000',
        origin: 'http://localhost:5173',
      },
    });

    await callRouteHandler(githubRouter, 'get', '/connect', req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      step: 'device',
      url: 'https://github.com/login/device?user_code=USER-CODE',
      userCode: 'USER-CODE',
    }));
    expect(db.query).not.toHaveBeenCalled();
  });

  it('keeps non-local browser requests on install flow when no installation exists', async () => {
    const { req, res } = createMockReqRes({
      headers: {
        host: 'localhost:3000',
        origin: 'https://atlasengine.dev',
      },
    });

    await callRouteHandler(githubRouter, 'get', '/connect', req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      step: 'install',
    }));
    expect(db.query).toHaveBeenCalled();
  });

  it('returns a fresh device flow for add-account requests instead of reusing a cancelled flow', async () => {
    let deviceCodeRequestCount = 0;
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/login/device/code')) {
        deviceCodeRequestCount += 1;
        return {
          ok: true,
          json: async () => ({
            device_code: `device-code-${deviceCodeRequestCount}`,
            user_code: `USER-CODE-${deviceCodeRequestCount}`,
            verification_uri: 'https://github.com/login/device',
            verification_uri_complete: `https://github.com/login/device?user_code=USER-CODE-${deviceCodeRequestCount}`,
            interval: 5,
            expires_in: 900,
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const first = createMockReqRes({
      headers: {
        host: 'localhost:3000',
        origin: 'http://localhost:5173',
      },
    });
    first.req.query.force = 'new-account';

    await callRouteHandler(githubRouter, 'get', '/connect', first.req, first.res);

    const second = createMockReqRes({
      headers: {
        host: 'localhost:3000',
        origin: 'http://localhost:5173',
      },
    });
    second.req.query.force = 'new-account';

    await callRouteHandler(githubRouter, 'get', '/connect', second.req, second.res);

    expect(deviceCodeRequestCount).toBe(2);
    expect(second.res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      step: 'device',
      url: 'https://github.com/login/device?user_code=USER-CODE-2',
      userCode: 'USER-CODE-2',
    }));
  });

  it('connects the account through the shared service when repo device flow completes', async () => {
    global.fetch = vi.fn(async (url) => {
      const raw = String(url);
      if (raw.includes('/login/device/code')) {
        return {
          ok: true,
          json: async () => ({
            device_code: 'device-code-1',
            user_code: 'USER-CODE',
            verification_uri: 'https://github.com/login/device',
            verification_uri_complete: 'https://github.com/login/device?user_code=USER-CODE',
            interval: 5,
            expires_in: 900,
          }),
        };
      }
      if (raw.includes('/login/oauth/access_token')) {
        return {
          ok: true,
          json: async () => ({
            access_token: 'gh-user-token',
            refresh_token: 'gh-refresh-token',
            expires_in: 28800,
            refresh_token_expires_in: 15811200,
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const { req, res } = createMockReqRes({
      headers: {
        host: 'localhost:3000',
        origin: 'http://localhost:5173',
      },
    });

    await callRouteHandler(githubRouter, 'get', '/connect', req, res);
    await vi.advanceTimersByTimeAsync(5000);

    expect(githubAccountConnectionService.connectGitHubAccount).toHaveBeenCalledWith({
      userId: '00000000-0000-0000-0000-000000000000',
      accessToken: 'gh-user-token',
      tokenMeta: {
        refreshToken: 'gh-refresh-token',
        expiresIn: 28800,
        refreshTokenExpiresIn: 15811200,
      },
      source: 'github_connect_device',
    });
  });

  it('routes OAuth callback user tokens through the shared connection service', async () => {
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/login/oauth/access_token')) {
        return {
          ok: true,
          json: async () => ({
            access_token: 'oauth-user-token',
            refresh_token: 'oauth-refresh-token',
            expires_in: 28800,
            refresh_token_expires_in: 15811200,
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    const state = Buffer.from(JSON.stringify({
      userId: 'user-123',
      timestamp: Date.now(),
    })).toString('base64');
    db.query.mockResolvedValueOnce({ rows: [{ installation_id: 123 }] });

    const { req, res } = createMockReqRes();
    req.query = { code: 'oauth-code', state };

    await callRouteHandler(githubRouter, 'get', '/oauth/callback', req, res);

    expect(githubAccountConnectionService.connectGitHubAccount).toHaveBeenCalledWith({
      userId: 'user-123',
      accessToken: 'oauth-user-token',
      tokenMeta: expect.objectContaining({
        refresh_token: 'oauth-refresh-token',
        expires_in: 28800,
        refresh_token_expires_in: 15811200,
      }),
      source: 'github_oauth_callback',
    });
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining('GitHub Authorized'));
  });

  it('syncs discoverable installations with a refresh-aware user token source', async () => {
    githubService.resolveUserInstallationSyncAuth.mockResolvedValue({
      integration: {
        user_access_token_encrypted: 'encrypted:user-token',
        access_token_encrypted: 'encrypted:user-token',
        token_expires_at: '2026-03-10T00:00:00.000Z',
        refresh_token_encrypted: 'encrypted:refresh-token',
        refresh_token_expires_at: '2026-09-10T00:00:00.000Z',
      },
      token: 'live-user-token',
    });
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/user/installations')) {
        return {
          ok: true,
          json: async () => ({
            installations: [
              {
                id: 999,
                account: {
                  login: 'AtlasAIEngine',
                  type: 'Organization',
                  avatar_url: 'https://example.com/avatar.png',
                },
              },
            ],
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    db.query
      .mockResolvedValueOnce({ rows: [{ installation_id: 123 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'integration-1',
          installation_id: 999,
          account_login: 'AtlasAIEngine',
          account_type: 'Organization',
          account_avatar_url: 'https://example.com/avatar.png',
          is_active: true,
          token_expires_at: '2026-03-10T00:00:00.000Z',
          repositories_accessible: [],
          permissions: null,
          created_at: '2026-03-09T00:00:00.000Z',
          updated_at: '2026-03-09T00:00:00.000Z',
        }],
      });

    const { req, res } = createMockReqRes();

    await callRouteHandler(githubRouter, 'get', '/installations', req, res);

    expect(githubService.resolveUserInstallationSyncAuth).toHaveBeenCalled();
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.github.com/user/installations',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'token live-user-token',
        }),
      })
    );
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO github_integrations'),
      expect.arrayContaining([
        expect.any(String),
        999,
        'AtlasAIEngine',
        'Organization',
        'https://example.com/avatar.png',
        'encrypted:user-token',
        'encrypted:user-token',
        '2026-03-10T00:00:00.000Z',
        'encrypted:refresh-token',
        '2026-09-10T00:00:00.000Z',
      ])
    );
    expect(db.query.mock.calls[1][0]).toContain(
      'token_expires_at = COALESCE(EXCLUDED.token_expires_at, github_integrations.token_expires_at)'
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      total: 1,
    }));
  });

  it('does not recreate manually disconnected installations during auto sync', async () => {
    githubService.resolveUserInstallationSyncAuth.mockResolvedValue({
      integration: {
        user_access_token_encrypted: 'encrypted:user-token',
        access_token_encrypted: 'encrypted:user-token',
        token_expires_at: '2026-03-10T00:00:00.000Z',
        refresh_token_encrypted: 'encrypted:refresh-token',
        refresh_token_expires_at: '2026-09-10T00:00:00.000Z',
      },
      token: 'live-user-token',
    });
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/user/installations')) {
        return {
          ok: true,
          json: async () => ({
            installations: [
              {
                id: 999,
                account: {
                  login: 'AtlasAIEngine',
                  type: 'Organization',
                  avatar_url: 'https://example.com/avatar.png',
                },
              },
            ],
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    db.query
      .mockResolvedValueOnce({
        rows: [{
          installation_id: 999,
          is_active: false,
          suspended_at: '2026-03-09T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const { req, res } = createMockReqRes();

    await callRouteHandler(githubRouter, 'get', '/installations', req, res);

    expect(db.query).not.toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO github_integrations'),
      expect.anything()
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      total: 0,
      installations: [],
    }));
  });

  it('reactivates a manually disconnected installation when explicitly reconnecting that account', async () => {
    githubService.resolveUserInstallationSyncAuth.mockResolvedValue({
      integration: {
        user_access_token_encrypted: 'encrypted:user-token',
        access_token_encrypted: 'encrypted:user-token',
        token_expires_at: '2026-03-10T00:00:00.000Z',
        refresh_token_encrypted: 'encrypted:refresh-token',
        refresh_token_expires_at: '2026-09-10T00:00:00.000Z',
      },
      token: 'live-user-token',
    });
    global.fetch = vi.fn(async (url) => {
      if (String(url).includes('/user/installations')) {
        return {
          ok: true,
          json: async () => ({
            installations: [
              {
                id: 999,
                account: {
                  login: 'AtlasAIEngine',
                  type: 'Organization',
                  avatar_url: 'https://example.com/avatar.png',
                },
              },
            ],
          }),
        };
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    db.query
      .mockResolvedValueOnce({
        rows: [{
          installation_id: 999,
          is_active: false,
          suspended_at: '2026-03-09T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          id: 'integration-1',
          installation_id: 999,
          account_login: 'AtlasAIEngine',
          account_type: 'Organization',
          account_avatar_url: 'https://example.com/avatar.png',
          is_active: true,
          token_expires_at: '2026-03-10T00:00:00.000Z',
          repositories_accessible: [],
          permissions: null,
          created_at: '2026-03-09T00:00:00.000Z',
          updated_at: '2026-03-09T00:00:00.000Z',
        }],
      });

    const { req, res } = createMockReqRes();
    req.query = { reactivateAccount: 'AtlasAIEngine' };

    await callRouteHandler(githubRouter, 'get', '/installations', req, res);

    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO github_integrations'),
      expect.arrayContaining([
        expect.any(String),
        999,
        'AtlasAIEngine',
      ])
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      total: 1,
      installations: [
        expect.objectContaining({
          installationId: 999,
          accountLogin: 'AtlasAIEngine',
          isActive: true,
        }),
      ],
    }));
  });

  it('refreshes accessible repositories and returns a real repos count when available', async () => {
    githubService.getUserRepositories.mockResolvedValue([
      { fullName: 'AtlasAIEngine/AtlasEngineMVPClaude' },
      { fullName: 'AtlasAIEngine/AnotherRepo' },
    ]);

    db.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'integration-1',
          installation_id: 999,
          account_login: 'AtlasAIEngine',
          account_type: 'Organization',
          account_avatar_url: 'https://example.com/avatar.png',
          is_active: true,
          token_expires_at: '2026-03-10T00:00:00.000Z',
          repositories_accessible: null,
          permissions: null,
          created_at: '2026-03-09T00:00:00.000Z',
          updated_at: '2026-03-09T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const { req, res } = createMockReqRes();

    await callRouteHandler(githubRouter, 'get', '/installations', req, res);

    expect(githubService.getUserRepositories).toHaveBeenCalledWith(999, { page: 1, per_page: 100 });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE github_integrations'),
      ['integration-1', JSON.stringify(['AtlasAIEngine/AtlasEngineMVPClaude', 'AtlasAIEngine/AnotherRepo'])]
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      total: 1,
      installations: [
        expect.objectContaining({
          accountLogin: 'AtlasAIEngine',
          reposCount: 2,
          reposKnown: true,
          repoAccessState: 'loaded',
        }),
      ],
    }));
  });

  it('refreshes repository cache across multiple pages so large installations stay connected', async () => {
    for (let page = 0; page < 11; page += 1) {
      githubService.getUserRepositories.mockResolvedValueOnce(
        Array.from({ length: 100 }, (_, index) => ({
          fullName: `AtlasAIEngine/Repo-${(page * 100) + index + 1}`,
        }))
      );
    }
    githubService.getUserRepositories.mockResolvedValueOnce([
      { fullName: 'AtlasAIEngine/Repo-1101' },
    ]);

    db.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'integration-1',
          installation_id: 999,
          account_login: 'AtlasAIEngine',
          account_type: 'Organization',
          account_avatar_url: 'https://example.com/avatar.png',
          is_active: true,
          token_expires_at: '2026-03-10T00:00:00.000Z',
          repositories_accessible: null,
          permissions: null,
          created_at: '2026-03-09T00:00:00.000Z',
          updated_at: '2026-03-09T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const { req, res } = createMockReqRes();

    await callRouteHandler(githubRouter, 'get', '/installations', req, res);

    expect(githubService.getUserRepositories).toHaveBeenCalledTimes(12);
    expect(githubService.getUserRepositories).toHaveBeenNthCalledWith(1, 999, { page: 1, per_page: 100 });
    expect(githubService.getUserRepositories).toHaveBeenNthCalledWith(11, 999, { page: 11, per_page: 100 });
    expect(githubService.getUserRepositories).toHaveBeenNthCalledWith(12, 999, { page: 12, per_page: 100 });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE github_integrations'),
      ['integration-1', JSON.stringify([
        ...Array.from({ length: 1100 }, (_, index) => `AtlasAIEngine/Repo-${index + 1}`),
        'AtlasAIEngine/Repo-1101',
      ])]
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      total: 1,
      installations: [
        expect.objectContaining({
          accountLogin: 'AtlasAIEngine',
          reposCount: 1101,
          reposKnown: true,
          repoAccessState: 'loaded',
        }),
      ],
    }));
  });

  it('stops pagination when GitHub repeats the same full page of repositories', async () => {
    const repeatedPage = Array.from({ length: 100 }, (_, index) => ({
      fullName: `AtlasAIEngine/Repo-${index + 1}`,
    }));
    githubService.getUserRepositories
      .mockResolvedValueOnce(repeatedPage)
      .mockResolvedValueOnce(repeatedPage);

    db.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'integration-1',
          installation_id: 999,
          account_login: 'AtlasAIEngine',
          account_type: 'Organization',
          account_avatar_url: 'https://example.com/avatar.png',
          is_active: true,
          token_expires_at: '2026-03-10T00:00:00.000Z',
          repositories_accessible: null,
          permissions: null,
          created_at: '2026-03-09T00:00:00.000Z',
          updated_at: '2026-03-09T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const { req, res } = createMockReqRes();

    await callRouteHandler(githubRouter, 'get', '/installations', req, res);

    expect(githubService.getUserRepositories).toHaveBeenCalledTimes(2);
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE github_integrations'),
      ['integration-1', JSON.stringify(
        Array.from({ length: 100 }, (_, index) => `AtlasAIEngine/Repo-${index + 1}`)
      )]
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      total: 1,
      installations: [
        expect.objectContaining({
          accountLogin: 'AtlasAIEngine',
          reposCount: 100,
          reposKnown: true,
          repoAccessState: 'loaded',
        }),
      ],
    }));
  });

  it('returns reconnect required when repo access refresh fails with auth errors and no cached repos exist', async () => {
    const authError = new Error('Bad credentials');
    authError.status = 401;
    githubService.getUserRepositories.mockRejectedValue(authError);

    db.query
      .mockResolvedValueOnce({
        rows: [{
          id: 'integration-1',
          installation_id: 999,
          account_login: 'AvinashP',
          account_type: 'User',
          account_avatar_url: 'https://example.com/avatar.png',
          is_active: true,
          token_expires_at: '2026-03-10T00:00:00.000Z',
          repositories_accessible: null,
          permissions: null,
          created_at: '2026-03-09T00:00:00.000Z',
          updated_at: '2026-03-09T00:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({ rows: [] });

    const { req, res } = createMockReqRes();

    await callRouteHandler(githubRouter, 'get', '/installations', req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      total: 1,
      installations: [
        expect.objectContaining({
          accountLogin: 'AvinashP',
          reposCount: null,
          reposKnown: false,
          repoAccessState: 'reauth_required',
          repoAccessMessage: 'Reconnect GitHub to load repo access',
        }),
      ],
    }));
  });

  it('keeps integrations connected when repo access refresh fails with a generic 403 response', async () => {
    const forbiddenError = new Error('API rate limit exceeded');
    forbiddenError.status = 403;
    forbiddenError.response = {
      status: 403,
      data: {
        message: 'API rate limit exceeded',
        documentation_url: 'https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting',
      },
    };
    githubService.getUserRepositories.mockRejectedValue(forbiddenError);

    db.query.mockReset();
    db.query.mockResolvedValue({
      rows: [{
        id: 'integration-1',
        installation_id: 999,
        account_login: 'AvinashP',
        account_type: 'User',
        account_avatar_url: 'https://example.com/avatar.png',
        is_active: true,
        token_expires_at: '2026-03-10T00:00:00.000Z',
        repositories_accessible: null,
        permissions: null,
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-09T00:00:00.000Z',
      }],
    });

    const { req, res } = createMockReqRes();

    await callRouteHandler(githubRouter, 'get', '/installations', req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      total: 1,
      installations: [
        expect.objectContaining({
          accountLogin: 'AvinashP',
          repoAccessState: 'refresh_failed',
          repoAccessMessage: 'Could not load repo access',
        }),
      ],
    }));
  });

  it('returns cached installation summaries without syncing repo access when summary=1', async () => {
    db.query.mockReset();
    db.query.mockResolvedValue({
      rows: [{
        id: 'integration-1',
        installation_id: 999,
        account_login: 'AtlasAIEngine',
        account_type: 'Organization',
        account_avatar_url: 'https://example.com/avatar.png',
        is_active: true,
        token_expires_at: '2026-03-10T00:00:00.000Z',
        repositories_accessible: JSON.stringify(['AtlasAIEngine/AtlasEngineMVPClaude']),
        permissions: null,
        created_at: '2026-03-09T00:00:00.000Z',
        updated_at: '2026-03-09T00:00:00.000Z',
      }],
    });
    githubService.resolveUserInstallationSyncAuth.mockReset();
    githubService.getUserRepositories.mockReset();

    const { req, res } = createMockReqRes();
    req.query.summary = '1';

    await callRouteHandler(githubRouter, 'get', '/installations', req, res);

    expect(githubService.resolveUserInstallationSyncAuth).not.toHaveBeenCalled();
    expect(githubService.getUserRepositories).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      total: 1,
      installations: [
        expect.objectContaining({
          accountLogin: 'AtlasAIEngine',
          reposCount: 1,
          reposKnown: true,
        }),
      ],
    }));
  });

});
