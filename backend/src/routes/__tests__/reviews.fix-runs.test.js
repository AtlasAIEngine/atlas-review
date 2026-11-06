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

vi.mock('../../services/reviewService.js', () => ({ default: {} }));
vi.mock('../../services/reviewQualityHarness.js', () => ({ default: {} }));
vi.mock('../../services/changesetService.js', () => ({ default: { getChangeSet: vi.fn() } }));
vi.mock('../../services/branchReviewService.js', () => ({ default: { getById: vi.fn() } }));
vi.mock('../../services/prReviewService.js', () => ({ default: { getById: vi.fn() } }));
vi.mock('../../services/workspaceReviewService.js', () => ({ default: { getById: vi.fn() } }));
vi.mock('../../services/gitService.js', () => ({
  default: {
    getStatus: vi.fn(),
    getCurrentSHA: vi.fn(),
    commitChanges: vi.fn(),
  },
}));
vi.mock('../../services/reviewOutcomeService.js', () => ({ default: {} }));
vi.mock('../../services/review/reviewFixRunStore.js', () => ({
  default: {
    listRuns: vi.fn(),
    getLatestRun: vi.fn(),
    getRunById: vi.fn(),
  },
}));
vi.mock('../../services/trustAnalyticsFactService.js', () => ({ default: {} }));
vi.mock('../../services/reviewSyncService.js', () => ({ default: {} }));
vi.mock('../../../../shared/reviewPrecisionStats.js', () => ({
  normalizePrecisionIssueCounters: vi.fn((stats) => stats),
}));

import { getProjectById } from '../../db/queries.js';
import changesetService from '../../services/changesetService.js';
import branchReviewService from '../../services/branchReviewService.js';
import gitService from '../../services/gitService.js';
import workspaceReviewService from '../../services/workspaceReviewService.js';
import reviewFixRunStore from '../../services/review/reviewFixRunStore.js';
import reviewsRouter from '../reviews.js';

function createMockReqRes(params = {}, query = {}) {
  const req = {
    params,
    query,
    body: {},
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
      await new Promise((resolve, reject) => {
        const next = (err) => (err ? reject(err) : resolve());
        const result = entry.handle(req, res, next);
        if (result instanceof Promise) result.then(resolve).catch(reject);
      });
    }
    return;
  }

  throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
}

describe('review fix run routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getProjectById.mockResolvedValue({
      id: 'proj-1',
      path: '/tmp/repo',
      user_id: '00000000-0000-0000-0000-000000000000',
    });
    changesetService.getChangeSet.mockResolvedValue({
      id: 'cs-1',
      reviewData: { recommendations: [] },
    });
    branchReviewService.getById.mockResolvedValue({
      id: 'br-1',
      projectId: 'proj-1',
      reviewJson: { recommendations: [] },
    });
    workspaceReviewService.getById.mockResolvedValue({
      id: 'ws-1',
      projectId: 'proj-1',
      reviewJson: { recommendations: [] },
    });
    gitService.getStatus.mockResolvedValue({
      modified: [],
      created: [],
      deleted: [],
      staged: [],
      notAdded: [],
      renamed: [],
    });
    gitService.getCurrentSHA.mockResolvedValue('head-sha-1');
    gitService.commitChanges.mockResolvedValue({
      commit: 'commit-sha-1',
      branch: 'feature/test',
    });
  });

  it('lists persisted fix runs for a changeset scope', async () => {
    reviewFixRunStore.listRuns.mockResolvedValue({
      scope: {
        projectId: 'proj-1',
        reviewType: 'changeset',
        reviewId: 'cs-1',
      },
      runs: [{ id: 'run-1', status: 'verification_pending' }],
    });
    const { req, res } = createMockReqRes({ projectId: 'proj-1', changesetId: 'cs-1' }, { limit: '5' });

    await callRouteHandler(
      reviewsRouter,
      'get',
      '/projects/proj-1/changesets/cs-1/review/fix-runs',
      req,
      res
    );

    expect(reviewFixRunStore.listRuns).toHaveBeenCalledWith(
      {
        projectId: 'proj-1',
        reviewType: 'changeset',
        reviewId: 'cs-1',
      },
      { limit: '5' }
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      runs: [{ id: 'run-1', status: 'verification_pending' }],
    }));
  });

  it('returns the latest fix run for a workspace review scope', async () => {
    reviewFixRunStore.getLatestRun.mockResolvedValue({
      id: 'run-2',
      projectId: 'proj-1',
      reviewType: 'workspace_review',
      reviewId: 'ws-1',
      status: 'running',
    });
    const { req, res } = createMockReqRes({ projectId: 'proj-1', workspaceReviewId: 'ws-1' });

    await callRouteHandler(
      reviewsRouter,
      'get',
      '/projects/proj-1/workspace-reviews/ws-1/review/fix-runs/latest',
      req,
      res
    );

    expect(workspaceReviewService.getById).toHaveBeenCalledWith('/tmp/repo', 'ws-1', {
      projectId: 'proj-1',
      includeContent: false,
    });
    expect(reviewFixRunStore.getLatestRun).toHaveBeenCalledWith({
      projectId: 'proj-1',
      reviewType: 'workspace_review',
      reviewId: 'ws-1',
    });
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      scope: {
        projectId: 'proj-1',
        reviewType: 'workspace_review',
        reviewId: 'ws-1',
      },
      run: {
        id: 'run-2',
        projectId: 'proj-1',
        reviewType: 'workspace_review',
        reviewId: 'ws-1',
        status: 'running',
      },
    });
  });

  it('creates a verification snapshot commit for changed fix-run files on branch reviews', async () => {
    reviewFixRunStore.getRunById.mockResolvedValue({
      id: 'run-verify-1',
      projectId: 'proj-1',
      reviewType: 'branch_review',
      reviewId: 'br-1',
      status: 'verification_pending',
      buildSummary: {
        filePaths: ['src/PlayerLook.cs', 'src/CameraRig.cs'],
      },
    });
    gitService.getStatus.mockResolvedValue({
      modified: ['src/PlayerLook.cs'],
      created: [],
      deleted: [],
      staged: [],
      notAdded: [],
      renamed: [],
    });
    const { req, res } = createMockReqRes({
      projectId: 'proj-1',
      branchReviewId: 'br-1',
      runId: 'run-verify-1',
    });
    req.body = { message: 'chore(review): verification snapshot for issue fixer' };

    await callRouteHandler(
      reviewsRouter,
      'post',
      '/projects/proj-1/branch-reviews/br-1/review/fix-runs/run-verify-1/verification-snapshot',
      req,
      res
    );

    expect(reviewFixRunStore.getRunById).toHaveBeenCalledWith('run-verify-1');
    expect(gitService.commitChanges).toHaveBeenCalledWith(
      '/tmp/repo',
      'chore(review): verification snapshot for issue fixer',
      ['src/PlayerLook.cs']
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      commitCreated: true,
      commitSha: 'commit-sha-1',
      filesCommitted: ['src/PlayerLook.cs'],
      targetFilePaths: ['src/PlayerLook.cs', 'src/CameraRig.cs'],
    }));
  });

  it('rejects verification snapshot when run status is not eligible', async () => {
    reviewFixRunStore.getRunById.mockResolvedValue({
      id: 'run-bad-status',
      projectId: 'proj-1',
      reviewType: 'branch_review',
      reviewId: 'br-1',
      status: 'running',
      buildSummary: { filePaths: ['src/Foo.cs'] },
    });
    const { req, res } = createMockReqRes({
      projectId: 'proj-1',
      branchReviewId: 'br-1',
      runId: 'run-bad-status',
    });

    await callRouteHandler(
      reviewsRouter,
      'post',
      '/projects/proj-1/branch-reviews/br-1/review/fix-runs/run-bad-status/verification-snapshot',
      req,
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringContaining('not eligible'),
    }));
    expect(gitService.commitChanges).not.toHaveBeenCalled();
  });

  it('rejects verification snapshot for failed run status', async () => {
    reviewFixRunStore.getRunById.mockResolvedValue({
      id: 'run-failed',
      projectId: 'proj-1',
      reviewType: 'branch_review',
      reviewId: 'br-1',
      status: 'failed',
      buildSummary: { filePaths: ['src/Foo.cs'] },
    });
    const { req, res } = createMockReqRes({
      projectId: 'proj-1',
      branchReviewId: 'br-1',
      runId: 'run-failed',
    });

    await callRouteHandler(
      reviewsRouter,
      'post',
      '/projects/proj-1/branch-reviews/br-1/review/fix-runs/run-failed/verification-snapshot',
      req,
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringContaining('not eligible'),
    }));
  });

  it('matches files with leading ./ prefix from git status via normalization', async () => {
    reviewFixRunStore.getRunById.mockResolvedValue({
      id: 'run-norm-1',
      projectId: 'proj-1',
      reviewType: 'branch_review',
      reviewId: 'br-1',
      status: 'patch_applied',
      buildSummary: {
        filePaths: ['src/PlayerLook.cs'],
      },
    });
    gitService.getStatus.mockResolvedValue({
      modified: ['./src/PlayerLook.cs'],
      created: [],
      deleted: [],
      staged: [],
      notAdded: [],
      renamed: [],
    });
    const { req, res } = createMockReqRes({
      projectId: 'proj-1',
      branchReviewId: 'br-1',
      runId: 'run-norm-1',
    });
    req.body = { message: 'test normalization' };

    await callRouteHandler(
      reviewsRouter,
      'post',
      '/projects/proj-1/branch-reviews/br-1/review/fix-runs/run-norm-1/verification-snapshot',
      req,
      res
    );

    expect(gitService.commitChanges).toHaveBeenCalledWith(
      '/tmp/repo',
      'test normalization',
      ['src/PlayerLook.cs']
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      commitCreated: true,
      filesCommitted: ['src/PlayerLook.cs'],
    }));
  });

  it('matches files with backslash separators from git status via normalization', async () => {
    reviewFixRunStore.getRunById.mockResolvedValue({
      id: 'run-norm-2',
      projectId: 'proj-1',
      reviewType: 'branch_review',
      reviewId: 'br-1',
      status: 'verification_pending',
      buildSummary: {
        filePaths: ['src\\PlayerLook.cs'],
      },
    });
    gitService.getStatus.mockResolvedValue({
      modified: ['src/PlayerLook.cs'],
      created: [],
      deleted: [],
      staged: [],
      notAdded: [],
      renamed: [],
    });
    const { req, res } = createMockReqRes({
      projectId: 'proj-1',
      branchReviewId: 'br-1',
      runId: 'run-norm-2',
    });

    await callRouteHandler(
      reviewsRouter,
      'post',
      '/projects/proj-1/branch-reviews/br-1/review/fix-runs/run-norm-2/verification-snapshot',
      req,
      res
    );

    expect(gitService.commitChanges).toHaveBeenCalledWith(
      '/tmp/repo',
      'chore(review): verification snapshot for issue fixer',
      ['src/PlayerLook.cs']
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      commitCreated: true,
    }));
  });

  it('reuses HEAD when the verification file set is already committed', async () => {
    reviewFixRunStore.getRunById.mockResolvedValue({
      id: 'run-verify-2',
      projectId: 'proj-1',
      reviewType: 'branch_review',
      reviewId: 'br-1',
      status: 'verification_pending',
      buildSummary: {
        filePaths: ['src/PlayerLook.cs'],
      },
    });
    const { req, res } = createMockReqRes({
      projectId: 'proj-1',
      branchReviewId: 'br-1',
      runId: 'run-verify-2',
    });

    await callRouteHandler(
      reviewsRouter,
      'post',
      '/projects/proj-1/branch-reviews/br-1/review/fix-runs/run-verify-2/verification-snapshot',
      req,
      res
    );

    expect(gitService.commitChanges).not.toHaveBeenCalled();
    expect(gitService.getCurrentSHA).toHaveBeenCalledWith('/tmp/repo');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      alreadyCommitted: true,
      commitCreated: false,
      commitSha: 'head-sha-1',
      filesCommitted: [],
      targetFilePaths: ['src/PlayerLook.cs'],
    }));
  });
});
