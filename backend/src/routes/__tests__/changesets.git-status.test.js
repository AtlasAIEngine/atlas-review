import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/queries.js', () => ({
  getProjectById: vi.fn(),
}));

vi.mock('../../middleware/quotas.js', () => ({
  enforceQuotas: (req, _res, next) => next(),
}));

vi.mock('../../services/gitService.js', () => ({
  default: {
    isGitRepository: vi.fn(),
    getStatus: vi.fn(),
    getRemoteUrl: vi.fn(),
    getCurrentSHA: vi.fn(),
  },
}));

import { getProjectById } from '../../db/queries.js';
import gitService from '../../services/gitService.js';
import changesetsRouter from '../changesets.js';

function createMockReqRes(params = {}, user = null) {
  const req = { params, user };
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

describe('changesets git-status route', () => {
  const project = {
    id: 'proj-1',
    path: '/tmp/repo',
    user_id: '00000000-0000-0000-0000-000000000000',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getProjectById.mockResolvedValue(project);
  });

  it('returns GitHub metadata used by Open on GitHub button', async () => {
    gitService.isGitRepository.mockResolvedValue(true);
    gitService.getStatus.mockResolvedValue({
      branch: 'feature/foo',
      isClean: false,
      ahead: 1,
      behind: 2,
      modified: ['a.js'],
      created: ['b.js', 'c.js'],
      deleted: ['d.js'],
      staged: ['a.js'],
      conflicted: [],
    });
    gitService.getRemoteUrl.mockResolvedValue('https://github.com/acme/widget.git');
    gitService.getCurrentSHA.mockResolvedValue('abc1234567');

    const { req, res } = createMockReqRes({ projectId: 'proj-1' });
    await callRouteHandler(changesetsRouter, 'get', '/proj-1/git-status', req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      isGitRepo: true,
      branch: 'feature/foo',
      currentBranch: 'feature/foo',
      originUrl: 'https://github.com/acme/widget.git',
      isGitHub: true,
      owner: 'acme',
      repo: 'widget',
      dirty: true,
      ahead: 1,
      behind: 2,
      hasUpstream: true,
      modified: 1,
      created: 2,
      deleted: 1,
      staged: 1,
      conflicted: 0,
      headSha: 'abc1234567',
    }));
  });

  it('returns defaults when repository is not git-backed', async () => {
    gitService.isGitRepository.mockResolvedValue(false);

    const { req, res } = createMockReqRes({ projectId: 'proj-1' });
    await callRouteHandler(changesetsRouter, 'get', '/proj-1/git-status', req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      isGitRepo: false,
      currentBranch: null,
      branch: null,
      originUrl: null,
      isGitHub: false,
      owner: null,
      repo: null,
      dirty: false,
      ahead: 0,
      behind: 0,
      hasUpstream: false,
    }));
  });
});
