import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('express', () => ({
  default: {
    Router: () => {
      const stack = [];
      const router = {
        stack,
        get(path, ...handlers) {
          stack.push({ route: { path, methods: { get: true }, stack: handlers.map((handle) => ({ handle })) } });
          return router;
        },
        post(path, ...handlers) {
          stack.push({ route: { path, methods: { post: true }, stack: handlers.map((handle) => ({ handle })) } });
          return router;
        },
        delete(path, ...handlers) {
          stack.push({ route: { path, methods: { delete: true }, stack: handlers.map((handle) => ({ handle })) } });
          return router;
        },
        patch(path, ...handlers) {
          stack.push({ route: { path, methods: { patch: true }, stack: handlers.map((handle) => ({ handle })) } });
          return router;
        },
      };
      return router;
    },
  },
}));

vi.mock('fs/promises', () => ({
  default: {
    access: vi.fn(),
  },
}));

vi.mock('../../db/connection.js', () => ({
  default: { query: vi.fn() },
  getDbType: vi.fn(() => 'sqlite'),
}));

vi.mock('../../middleware/quotas.js', () => ({
  enforceQuotas: (_req, _res, next) => next(),
}));

vi.mock('../../db/queries.js', () => ({
  createProject: vi.fn(),
  updateProjectLastAccessed: vi.fn(),
  updateProjectGeneratedReviewPolicy: vi.fn(),
}));

vi.mock('../../services/githubService.js', () => ({
  default: {
    getInstallation: vi.fn(),
    getRepositoryDetails: vi.fn(),
  },
}));

vi.mock('../../services/gitService.js', () => ({
  default: {
    cloneRepository: vi.fn(),
    getRemoteUrl: vi.fn(),
  },
}));

vi.mock('../../services/memoryService.js', () => ({
  default: {
    initializeMemory: vi.fn(),
  },
}));

vi.mock('../../services/changesetService.js', () => ({
  default: {
    createBaselineChangeset: vi.fn(),
  },
}));

vi.mock('../../services/integrationsService.js', () => ({
  default: {
    checkProjectIntegrations: vi.fn(),
  },
}));

vi.mock('../../services/supabaseService.js', () => ({
  default: {
    autoLinkIfSingleProject: vi.fn(),
  },
}));

vi.mock('../../services/projectInitService.js', () => ({
  default: {
    ensureAtlasIgnored: vi.fn(),
  },
}));

import fs from 'fs/promises';
import db from '../../db/connection.js';
import * as queries from '../../db/queries.js';
import githubService from '../../services/githubService.js';
import gitService from '../../services/gitService.js';
import githubRouter from '../github.js';

function createMockReqRes({ body = {}, user = null } = {}) {
  const req = {
    body,
    headers: {},
    params: {},
    query: {},
    user,
    app: { get: vi.fn(() => null) },
  };
  const res = {
    json: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
  };
  return { req, res };
}

async function callRouteHandler(router, method, path, req, res) {
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const routeMethod = Object.keys(layer.route.methods)[0];
    if (routeMethod !== method || layer.route.path !== path) continue;

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

describe('github clone route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    githubService.getInstallation.mockResolvedValue({ installation_id: 99 });
    githubService.getRepositoryDetails.mockResolvedValue({
      id: 123,
      cloneUrl: 'https://github.com/AtlasAIEngine/AtlasEngineMVPClaude.git',
      defaultBranch: 'main',
      fullName: 'AtlasAIEngine/AtlasEngineMVPClaude',
      description: 'Test repo',
    });
    fs.access.mockResolvedValue(undefined);
    gitService.getRemoteUrl.mockResolvedValue('git@github.com:AtlasAIEngine/AtlasEngineMVPClaude.git');
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'proj-existing',
            session_id: 'sess-1',
            name: 'AtlasEngine',
            description: 'Imported from local folder',
            framework: null,
            language: null,
            path: '/tmp/existing-project',
            github_repo_full_name: null,
            github_repo_owner: null,
            github_repo_name: null,
            github_repo_id: null,
            github_installation_id: null,
            github_clone_url: null,
            github_default_branch: null,
            github_last_sync_sha: null,
            github_last_sync_at: null,
            github_webhook_id: null,
            github_sync_enabled: false,
            github_sync_status: null,
            has_memory: false,
            status: 'active',
            source: 'local',
            created_at: '2026-03-01T00:00:00.000Z',
            updated_at: '2026-03-02T00:00:00.000Z',
            last_accessed: '2026-03-03T00:00:00.000Z',
          },
        ],
      });
  });

  it('returns an existing local project when the same GitHub repo is already open', async () => {
    const { req, res } = createMockReqRes({
      body: {
        owner: 'AtlasAIEngine',
        repo: 'AtlasEngineMVPClaude',
      },
    });

    await callRouteHandler(githubRouter, 'post', '/clone', req, res);

    expect(queries.updateProjectLastAccessed).toHaveBeenCalledWith('proj-existing');
    expect(gitService.cloneRepository).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      alreadyExists: true,
      project: expect.objectContaining({
        id: 'proj-existing',
        name: 'AtlasEngine',
        source: 'local',
        status: 'active',
      }),
      integrations: [],
      autoLinkedIntegrations: [],
    }));
  });
});
