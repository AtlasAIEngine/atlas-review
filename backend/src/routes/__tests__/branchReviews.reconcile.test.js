import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/queries.js', () => ({
  getProjectById: vi.fn(),
  updateProject: vi.fn(),
}));

vi.mock('../../services/branchReviewService.js', () => ({
  default: {
    getByProject: vi.fn(),
    getById: vi.fn(),
    getByBranch: vi.fn(),
    create: vi.fn(),
    updateReview: vi.fn(),
    collapseDuplicateTrackedReviews: vi.fn(),
    setStatus: vi.fn(),
    setCurrentBranch: vi.fn(),
    deleteBranchReview: vi.fn(),
  },
}));

vi.mock('../../services/prReviewService.js', () => ({
  default: {
    getByProject: vi.fn(),
    findBaseBranchForHead: vi.fn(),
  },
}));

vi.mock('../../services/reviewService.js', () => ({
  default: {
    events: {
      emit: vi.fn(),
    },
    getQueueStatus: vi.fn(),
    reviewBranchReview: vi.fn(),
    enqueueBranchReview: vi.fn(),
    stopReview: vi.fn(),
    stopActiveBranchReviewRun: vi.fn(),
    markActiveBranchReviewRun: vi.fn(),
    touchActiveBranchReviewRun: vi.fn(),
    clearActiveBranchReviewRun: vi.fn(),
    getActiveBranchReviewRun: vi.fn(),
    refreshLatestBranchReviewHeadForRun: vi.fn(),
  },
}));

vi.mock('../../services/review/reviewFixRunStore.js', () => ({
  default: {
    deleteRuns: vi.fn(),
  },
}));

vi.mock('../../services/gitService.js', () => ({
  default: {
    getRemoteDefaultBranch: vi.fn(),
    inferBaseBranch: vi.fn(),
    getCurrentBranchName: vi.fn(),
    getRefSha: vi.fn(),
    listWorktrees: vi.fn(),
    refExists: vi.fn(),
    getMergeBase: vi.fn(),
    getThreeDotDiffStats: vi.fn(),
    getTwoDotDiffStats: vi.fn(),
    getCommitsBetween: vi.fn(),
    getForkPointFromReflog: vi.fn(),
    getThreeDotDiffNameStatus: vi.fn(),
    getFileAtRef: vi.fn(),
    listBranches: vi.fn(),
    isAncestorRef: vi.fn(),
  },
}));

vi.mock('../../services/gitWatcherService.js', () => ({
  default: {
    isWatching: vi.fn(),
    updateBaseBranch: vi.fn(),
    syncNow: vi.fn(),
  },
}));

vi.mock('../../services/workspaceReviewService.js', () => ({
  default: {
    list: vi.fn(),
  },
}));

vi.mock('../../middleware/quotas.js', () => ({
  enforceQuotas: (req, res, next) => next(),
}));

import { getProjectById, updateProject } from '../../db/queries.js';
import branchReviewService from '../../services/branchReviewService.js';
import prReviewService from '../../services/prReviewService.js';
import gitService from '../../services/gitService.js';
import reviewService from '../../services/reviewService.js';
import reviewFixRunStore from '../../services/review/reviewFixRunStore.js';
import gitWatcherService from '../../services/gitWatcherService.js';
import workspaceReviewService from '../../services/workspaceReviewService.js';
import branchReviewsRouter, { resetBranchReviewRouteTestState } from '../branchReviews.js';

function createMockReqRes({
  params = {},
  body = {},
  query = {},
  user = null,
} = {}) {
  const req = {
    params,
    body,
    query,
    user,
  };
  const res = {
    json: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
    setHeader: vi.fn().mockReturnThis(),
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

    let match = true;
    const extractedParams = {};
    for (let i = 0; i < routeParts.length; i += 1) {
      if (routeParts[i].startsWith(':')) {
        extractedParams[routeParts[i].slice(1)] = pathParts[i];
      } else if (routeParts[i] !== pathParts[i]) {
        match = false;
        break;
      }
    }
    if (!match) continue;

    req.params = { ...req.params, ...extractedParams };
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

  throw new Error(`Route not found: ${method} ${path}`);
}

async function flushBackgroundReconciliation() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';
const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
const ORIGINAL_DESKTOP_MODE = process.env.ATLAS_DESKTOP_MODE;

function buildBranchReviewActionSnapshot(overrides = {}) {
  return {
    id: 'br-action',
    projectId: 'proj-1',
    branchName: 'feature/review-polish',
    baseBranch: 'main',
    status: 'active',
    reviewStatus: 'reviewed',
    reviewHeadSha: 'head-ok',
    headSha: 'head-ok',
    reviewBaseBranch: 'main',
    reviewMergeBaseSha: 'merge-123',
    mergeBaseSha: 'merge-123',
    reviewError: null,
    reviewedAt: '2026-02-20T12:00:00.000Z',
    updatedAt: '2026-02-20T12:01:00.000Z',
    ...overrides,
  };
}

function expectDeterministicConflictPayload(payload, {
  expectedStaleReason = null,
  blockedReasonPattern = /blocked|stale|progress/i,
  expectedLifecycleStatus = null,
}) {
  expect(payload).toEqual(expect.objectContaining({
    error: expect.any(String),
    blockedReason: expect.any(String),
    staleReason: expectedStaleReason,
    reviewActionEligibility: expect.objectContaining({
      canApprove: false,
      canRequestChanges: false,
      staleReason: expectedStaleReason,
    }),
    branchReview: expect.objectContaining({
      reviewLifecycle: expect.objectContaining({
        status: expect.any(String),
        isTerminal: expect.any(Boolean),
      }),
      reviewActionEligibility: expect.objectContaining({
        canApprove: false,
        canRequestChanges: false,
      }),
    }),
  }));
  expect(payload.blockedReason).toMatch(blockedReasonPattern);
  expect(payload.error).toBe(payload.blockedReason);
  if (expectedLifecycleStatus) {
    expect(payload.branchReview.reviewLifecycle.status).toBe(expectedLifecycleStatus);
  }
}

describe('Branch review lifecycle reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBranchReviewRouteTestState();
    getProjectById.mockReset();
    updateProject.mockReset();
    branchReviewService.getByProject.mockReset();
    branchReviewService.getById.mockReset();
    branchReviewService.getByBranch.mockReset();
    branchReviewService.create.mockReset();
    branchReviewService.updateReview.mockReset();
    branchReviewService.collapseDuplicateTrackedReviews.mockReset();
    branchReviewService.setStatus.mockReset();
    branchReviewService.setCurrentBranch.mockReset();
    branchReviewService.deleteBranchReview.mockReset();
    prReviewService.getByProject.mockReset();
    prReviewService.getByProject.mockResolvedValue([]);
    prReviewService.findBaseBranchForHead.mockReset();
    prReviewService.findBaseBranchForHead.mockResolvedValue(null);
    gitService.getCurrentBranchName.mockReset();
    gitService.getRefSha.mockReset();
    gitService.getRemoteDefaultBranch.mockReset();
    gitService.listWorktrees.mockReset();
    gitService.listWorktrees.mockResolvedValue([]);
    gitService.refExists.mockReset();
    gitService.inferBaseBranch.mockReset();
    gitService.getMergeBase.mockReset();
    gitService.getThreeDotDiffStats.mockReset();
    gitService.getTwoDotDiffStats.mockReset();
    gitService.getCommitsBetween.mockReset();
    gitService.getForkPointFromReflog.mockReset();
    gitService.isAncestorRef.mockReset();
    gitService.isAncestorRef.mockResolvedValue(false);
    gitWatcherService.isWatching.mockReset();
    gitWatcherService.updateBaseBranch.mockReset();
    gitWatcherService.syncNow.mockReset();
    gitWatcherService.syncNow.mockResolvedValue(true);
    workspaceReviewService.list.mockReset();
    workspaceReviewService.list.mockResolvedValue([]);
    reviewService.getQueueStatus.mockReset();
    reviewService.reviewBranchReview.mockReset();
    reviewService.enqueueBranchReview.mockReset();
    reviewService.stopReview.mockReset();
    reviewService.markActiveBranchReviewRun.mockReset();
    reviewService.touchActiveBranchReviewRun.mockReset();
    reviewService.clearActiveBranchReviewRun.mockReset();
    reviewService.getActiveBranchReviewRun.mockReset();
    reviewService.refreshLatestBranchReviewHeadForRun.mockReset();
    reviewService.stopActiveBranchReviewRun.mockReset();
    reviewFixRunStore.deleteRuns.mockReset();
    let activeBranchReviewRun = null;

    getProjectById.mockResolvedValue({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: '/tmp/project',
    });

    gitService.refExists.mockImplementation(async (_projectPath, ref) => {
      if (ref === 'refs/heads/feature/review-polish') return true;
      if (ref === 'refs/remotes/origin/main') return true;
      return false;
    });
    gitService.getRemoteDefaultBranch.mockResolvedValue('main');
    gitService.inferBaseBranch.mockResolvedValue('main');
    gitService.getMergeBase.mockResolvedValue('merge-123');
    gitService.getRefSha.mockResolvedValue(null);
    gitService.getThreeDotDiffStats.mockResolvedValue({
      fileCount: 5,
      totalAdditions: 20,
      totalDeletions: 4,
      files: [],
    });
    gitService.getCommitsBetween.mockResolvedValue([
      { hash: 'head-new', date: '2026-02-15T10:00:00.000Z' },
      { hash: 'older', date: '2026-02-14T10:00:00.000Z' },
    ]);
    gitService.getForkPointFromReflog.mockResolvedValue(null);
    branchReviewService.getByBranch.mockResolvedValue(null);
    branchReviewService.create.mockImplementation(async ({
      projectId,
      branchName,
      baseBranch,
      baseBranchSource = 'inferred',
      mergeBaseSha,
      forkPointSha,
      headSha,
      stats,
      isCurrent,
    }) => ({
      id: 'br-created',
      displayId: 'BR-001',
      projectId,
      branchName,
      baseBranch,
      baseBranchSource,
      mergeBaseSha,
      forkPointSha,
      headSha,
      status: 'active',
      isCurrent,
      fileCount: stats?.fileCount || 0,
      totalAdditions: stats?.totalAdditions || 0,
      totalDeletions: stats?.totalDeletions || 0,
      commitCount: stats?.commitCount || 0,
      firstCommitAt: stats?.firstCommitAt || null,
      lastCommitAt: stats?.lastCommitAt || null,
      reviewStatus: 'none',
    }));
    branchReviewService.updateReview.mockImplementation(async (id, updates) => ({
      id,
      ...updates,
      projectId: 'proj-1',
      branchName: 'feature/review-polish',
      baseBranch: updates.base_branch || 'main',
      status: updates.status || 'active',
    }));
    branchReviewService.collapseDuplicateTrackedReviews.mockImplementation(async (_projectId, reviews) => ({ reviews }));
    branchReviewService.deleteBranchReview.mockResolvedValue(true);
    reviewService.getQueueStatus.mockReturnValue([]);
    reviewService.refreshLatestBranchReviewHeadForRun.mockImplementation(async (_projectPath, review) => review);
    reviewService.stopReview.mockReturnValue({ stopped: true, was: 'queued' });
    reviewFixRunStore.deleteRuns.mockResolvedValue({ deletedCount: 0 });
    reviewService.markActiveBranchReviewRun.mockImplementation((branchReviewId, state = {}) => {
      activeBranchReviewRun = {
        branchReviewId,
        ...state,
      };
      return activeBranchReviewRun;
    });
    reviewService.touchActiveBranchReviewRun.mockImplementation((branchReviewId, progress = null, state = {}) => {
      if (!activeBranchReviewRun || activeBranchReviewRun.branchReviewId !== branchReviewId) {
        activeBranchReviewRun = {
          branchReviewId,
          ...state,
          progress: progress || null,
        };
        return activeBranchReviewRun;
      }
      activeBranchReviewRun = {
        ...activeBranchReviewRun,
        ...state,
        progress: progress || activeBranchReviewRun.progress || null,
      };
      return activeBranchReviewRun;
    });
    reviewService.clearActiveBranchReviewRun.mockImplementation((branchReviewId) => {
      if (activeBranchReviewRun?.branchReviewId === branchReviewId) {
        activeBranchReviewRun = null;
      }
    });
    reviewService.getActiveBranchReviewRun.mockImplementation((branchReviewId) => (
      activeBranchReviewRun?.branchReviewId === branchReviewId ? activeBranchReviewRun : null
    ));
  });

  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    process.env.ATLAS_DESKTOP_MODE = ORIGINAL_DESKTOP_MODE;
  });

  it('creates an on-demand worktree branch review against local base when origin has already advanced', async () => {
    getProjectById.mockResolvedValue({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: '/tmp/project',
      base_branch_display: 'main',
    });
    gitService.refExists.mockImplementation(async (_projectPath, ref) => (
      ref === 'refs/heads/ImprovementsAndFixes'
      || ref === 'refs/heads/main'
      || ref === 'refs/remotes/origin/main'
    ));
    gitService.listBranches.mockResolvedValue([
      { name: 'main', current: false, headSha: 'local-main-sha' },
      { name: 'ImprovementsAndFixes', current: false, headSha: 'branch-head-sha' },
    ]);
    gitService.listWorktrees.mockResolvedValue([
      { path: '/tmp/wt/ImprovementsAndFixes', branch: 'ImprovementsAndFixes', head: 'branch-head-sha' },
    ]);
    gitService.getMergeBase.mockResolvedValue('local-main-sha');
    gitService.getRefSha.mockResolvedValue('branch-head-sha');
    gitService.getThreeDotDiffStats.mockResolvedValue({
      fileCount: 4,
      totalAdditions: 32,
      totalDeletions: 1,
      files: [],
    });
    gitService.getCommitsBetween.mockResolvedValue([
      { hash: 'branch-head-sha', date: '2026-04-29T06:04:18.000Z' },
    ]);

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1' },
      body: { branchName: 'ImprovementsAndFixes' },
    });

    await callRouteHandler(branchReviewsRouter, 'post', '/proj-1/branches/review', req, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(gitService.getMergeBase).toHaveBeenCalledWith('/tmp/project', 'refs/heads/main', 'ImprovementsAndFixes');
    expect(branchReviewService.create).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1',
      branchName: 'ImprovementsAndFixes',
      baseBranch: 'main',
      mergeBaseSha: 'local-main-sha',
      forkPointSha: 'local-main-sha',
      headSha: 'branch-head-sha',
      isCurrent: false,
      stats: expect.objectContaining({
        fileCount: 4,
        totalAdditions: 32,
        totalDeletions: 1,
        commitCount: 1,
      }),
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      branchReview: expect.objectContaining({
        branchName: 'ImprovementsAndFixes',
        isWorktree: true,
        worktreePath: '/tmp/wt/ImprovementsAndFixes',
      }),
    }));
  });

  it('creates an on-demand branch review scoped to the latest commit', async () => {
    getProjectById.mockResolvedValue({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: '/tmp/project',
      base_branch_display: 'main',
    });
    gitService.refExists.mockImplementation(async (_projectPath, ref) => (
      ref === 'refs/heads/feature/review-polish'
      || ref === 'refs/remotes/origin/main'
    ));
    gitService.listBranches.mockResolvedValue([
      { name: 'main', current: false, headSha: 'main-head' },
      { name: 'feature/review-polish', current: true, headSha: 'head-sha' },
    ]);
    gitService.getRefSha.mockImplementation(async (_projectPath, ref) => {
      if (ref === 'feature/review-polish') return 'head-sha';
      if (ref === 'feature/review-polish^1') return 'parent-sha';
      return null;
    });
    gitService.getTwoDotDiffStats.mockResolvedValue({
      fileCount: 2,
      totalAdditions: 11,
      totalDeletions: 3,
      files: [],
    });
    gitService.getCommitsBetween.mockResolvedValue([
      { hash: 'head-sha', date: '2026-05-07T09:30:00.000Z' },
    ]);
    branchReviewService.getById.mockResolvedValue({
      id: 'br-created',
      displayId: 'BR-001',
      projectId: 'proj-1',
      branchName: 'feature/review-polish',
      baseBranch: 'feature/review-polish~last-commit',
      baseBranchSource: 'last_commit',
      mergeBaseSha: 'parent-sha',
      forkPointSha: 'parent-sha',
      headSha: 'head-sha',
      status: 'active',
      isCurrent: true,
      fileCount: 2,
      reviewStatus: 'none',
    });

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1' },
      body: { branchName: 'feature/review-polish', diffScope: 'last_commit' },
    });

    await callRouteHandler(branchReviewsRouter, 'post', '/proj-1/branches/review', req, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(gitService.getMergeBase).not.toHaveBeenCalled();
    expect(gitService.getRefSha).toHaveBeenCalledWith('/tmp/project', 'feature/review-polish');
    expect(gitService.getRefSha).toHaveBeenCalledWith('/tmp/project', 'feature/review-polish^1');
    expect(gitService.getTwoDotDiffStats).toHaveBeenCalledWith('/tmp/project', 'parent-sha', 'head-sha');
    expect(branchReviewService.create).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1',
      branchName: 'feature/review-polish',
      baseBranch: 'feature/review-polish~last-commit',
      baseBranchSource: 'last_commit',
      mergeBaseSha: 'parent-sha',
      forkPointSha: 'parent-sha',
      headSha: 'head-sha',
      stats: expect.objectContaining({
        fileCount: 2,
        totalAdditions: 11,
        totalDeletions: 3,
        commitCount: 1,
      }),
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      branchReview: expect.objectContaining({
        baseBranch: 'feature/review-polish~last-commit',
        baseBranchSource: 'last_commit',
      }),
    }));
  });

  it('preserves the previous pinned base when switching an existing review to latest-commit scope', async () => {
    getProjectById.mockResolvedValue({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: '/tmp/project',
      base_branch_display: 'main',
    });
    branchReviewService.getByBranch.mockResolvedValue({
      id: 'br-pinned',
      displayId: 'BR-010',
      projectId: 'proj-1',
      branchName: 'feature/review-polish',
      baseBranch: 'development',
      baseBranchSource: 'pinned',
      status: 'active',
      isCurrent: true,
    });
    branchReviewService.getById.mockResolvedValue({
      id: 'br-pinned',
      displayId: 'BR-010',
      projectId: 'proj-1',
      branchName: 'feature/review-polish',
      baseBranch: 'feature/review-polish~last-commit',
      baseBranchSource: 'last_commit',
      reviewBaseBranch: 'development',
      status: 'active',
      isCurrent: true,
      fileCount: 2,
      reviewStatus: 'none',
    });
    gitService.refExists.mockImplementation(async (_projectPath, ref) => (
      ref === 'refs/heads/feature/review-polish'
      || ref === 'refs/remotes/origin/main'
    ));
    gitService.listBranches.mockResolvedValue([
      { name: 'main', current: false, headSha: 'main-head' },
      { name: 'feature/review-polish', current: true, headSha: 'head-sha' },
    ]);
    gitService.getRefSha.mockImplementation(async (_projectPath, ref) => {
      if (ref === 'feature/review-polish') return 'head-sha';
      if (ref === 'feature/review-polish^1') return 'parent-sha';
      return null;
    });
    gitService.getTwoDotDiffStats.mockResolvedValue({
      fileCount: 2,
      totalAdditions: 11,
      totalDeletions: 3,
      files: [],
    });
    gitService.getCommitsBetween.mockResolvedValue([
      { hash: 'head-sha', date: '2026-05-07T09:30:00.000Z' },
    ]);

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1' },
      body: { branchName: 'feature/review-polish', diffScope: 'last_commit' },
    });

    await callRouteHandler(branchReviewsRouter, 'post', '/proj-1/branches/review', req, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(branchReviewService.updateReview).toHaveBeenCalledWith('br-pinned', expect.objectContaining({
      base_branch: 'feature/review-polish~last-commit',
      base_branch_source: 'last_commit',
      review_base_branch: 'development',
      merge_base_sha: 'parent-sha',
      head_sha: 'head-sha',
    }));
  });

  it('allows last-commit review scope on the project base branch', async () => {
    getProjectById.mockResolvedValue({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: '/tmp/project',
      base_branch_display: 'main',
    });
    gitService.refExists.mockImplementation(async (_projectPath, ref) => ref === 'refs/heads/main');
    gitService.listBranches.mockResolvedValue([
      { name: 'main', current: true, headSha: 'main-head' },
    ]);
    gitService.getRefSha.mockImplementation(async (_projectPath, ref) => {
      if (ref === 'main') return 'main-head';
      if (ref === 'main^1') return 'main-parent';
      return null;
    });
    gitService.getTwoDotDiffStats.mockResolvedValue({
      fileCount: 1,
      totalAdditions: 3,
      totalDeletions: 1,
      files: [],
    });
    gitService.getCommitsBetween.mockResolvedValue([
      { hash: 'main-head', date: '2026-05-07T09:30:00.000Z' },
    ]);
    branchReviewService.getById.mockResolvedValue({
      id: 'br-created',
      displayId: 'BR-001',
      projectId: 'proj-1',
      branchName: 'main',
      baseBranch: 'main~last-commit',
      baseBranchSource: 'last_commit',
      mergeBaseSha: 'main-parent',
      forkPointSha: 'main-parent',
      headSha: 'main-head',
      status: 'active',
      isCurrent: true,
      fileCount: 1,
      reviewStatus: 'none',
    });

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1' },
      body: { branchName: 'main', diffScope: 'last_commit' },
    });

    await callRouteHandler(branchReviewsRouter, 'post', '/proj-1/branches/review', req, res);

    expect(res.status).not.toHaveBeenCalledWith(409);
    expect(branchReviewService.create).toHaveBeenCalledWith(expect.objectContaining({
      branchName: 'main',
      baseBranch: 'main~last-commit',
      baseBranchSource: 'last_commit',
    }));
  });

  it('uses a matching PR base when creating an on-demand branch review', async () => {
    getProjectById.mockResolvedValue({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: '/tmp/project',
      base_branch_display: 'development',
    });
    prReviewService.findBaseBranchForHead.mockResolvedValue('preetham/posthog_experiments_integration');
    gitService.refExists.mockImplementation(async (_projectPath, ref) => (
      ref === 'refs/heads/Sunil/Analytics/posthog_address'
      || ref === 'refs/remotes/origin/preetham/posthog_experiments_integration'
      || ref === 'refs/remotes/origin/development'
    ));
    gitService.listBranches.mockResolvedValue([
      { name: 'development', current: false, headSha: 'development-head' },
      { name: 'Sunil/Analytics/posthog_address', current: true, headSha: 'topic-head' },
    ]);
    gitService.getMergeBase.mockResolvedValue('pr-base-sha');
    gitService.getRefSha.mockResolvedValue('topic-head');
    gitService.getThreeDotDiffStats.mockResolvedValue({
      fileCount: 6,
      totalAdditions: 40,
      totalDeletions: 5,
      files: [],
    });
    gitService.getCommitsBetween.mockResolvedValue([
      { hash: 'topic-head', date: '2026-05-06T09:03:31.000Z' },
    ]);
    branchReviewService.getById.mockResolvedValue({
      id: 'br-created',
      displayId: 'BR-001',
      projectId: 'proj-1',
      branchName: 'Sunil/Analytics/posthog_address',
      baseBranch: 'preetham/posthog_experiments_integration',
      status: 'active',
      isCurrent: true,
      reviewStatus: 'none',
    });

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1' },
      body: { branchName: 'Sunil/Analytics/posthog_address' },
    });

    await callRouteHandler(branchReviewsRouter, 'post', '/proj-1/branches/review', req, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(gitService.getMergeBase).toHaveBeenCalledWith(
      '/tmp/project',
      'origin/preetham/posthog_experiments_integration',
      'Sunil/Analytics/posthog_address'
    );
    expect(branchReviewService.create).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1',
      branchName: 'Sunil/Analytics/posthog_address',
      baseBranch: 'preetham/posthog_experiments_integration',
      mergeBaseSha: 'pr-base-sha',
    }));
  });

  it('preserves a pinned per-review base when re-opening an existing branch review', async () => {
    getProjectById.mockResolvedValue({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: '/tmp/project',
      base_branch_display: 'main',
    });
    branchReviewService.getByBranch.mockResolvedValue({
      id: 'br-pinned',
      displayId: 'BR-010',
      projectId: 'proj-1',
      branchName: 'feature/review-polish',
      baseBranch: 'development',
      baseBranchSource: 'pinned',
      status: 'active',
      isCurrent: true,
      forkPointSha: 'merge-old',
    });
    gitService.refExists.mockImplementation(async (_projectPath, ref) => (
      ref === 'refs/heads/feature/review-polish'
      || ref === 'refs/heads/development'
      || ref === 'refs/remotes/origin/main'
    ));
    gitService.inferBaseBranch.mockResolvedValue('main');
    gitService.getMergeBase.mockResolvedValue('merge-dev');
    gitService.getRefSha.mockResolvedValue('head-dev');
    gitService.getThreeDotDiffStats.mockResolvedValue({
      fileCount: 9,
      totalAdditions: 90,
      totalDeletions: 10,
      files: [],
    });
    gitService.getCommitsBetween.mockResolvedValue([
      { hash: 'head-dev', date: '2026-04-29T06:04:18.000Z' },
    ]);

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1' },
      body: { branchName: 'feature/review-polish' },
    });

    await callRouteHandler(branchReviewsRouter, 'post', '/proj-1/branches/review', req, res);

    expect(gitService.getMergeBase).toHaveBeenCalledWith(
      '/tmp/project',
      'refs/heads/development',
      'feature/review-polish'
    );
    expect(gitService.inferBaseBranch).not.toHaveBeenCalled();
    expect(branchReviewService.updateReview).toHaveBeenCalledWith('br-pinned', expect.objectContaining({
      base_branch: 'development',
      base_branch_source: 'pinned',
      merge_base_sha: 'merge-dev',
      head_sha: 'head-dev',
      file_count: 9,
    }));
  });

  it('restores a preserved pinned base when switching a last-commit review back to base-branch scope', async () => {
    getProjectById.mockResolvedValue({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: '/tmp/project',
      base_branch_display: 'main',
    });
    branchReviewService.getByBranch.mockResolvedValue({
      id: 'br-last-commit',
      displayId: 'BR-010',
      projectId: 'proj-1',
      branchName: 'feature/review-polish',
      baseBranch: 'feature/review-polish~last-commit',
      baseBranchSource: 'last_commit',
      reviewBaseBranch: 'development',
      status: 'active',
      isCurrent: true,
      forkPointSha: 'parent-sha',
    });
    branchReviewService.getById.mockResolvedValue({
      id: 'br-last-commit',
      displayId: 'BR-010',
      projectId: 'proj-1',
      branchName: 'feature/review-polish',
      baseBranch: 'development',
      baseBranchSource: 'pinned',
      reviewBaseBranch: 'development',
      status: 'active',
      isCurrent: true,
      fileCount: 9,
      reviewStatus: 'none',
    });
    gitService.refExists.mockImplementation(async (_projectPath, ref) => (
      ref === 'refs/heads/feature/review-polish'
      || ref === 'refs/heads/development'
      || ref === 'refs/remotes/origin/main'
    ));
    gitService.listBranches.mockResolvedValue([
      { name: 'development', current: false, headSha: 'development-head' },
      { name: 'feature/review-polish', current: true, headSha: 'head-dev' },
    ]);
    gitService.inferBaseBranch.mockResolvedValue('main');
    gitService.getMergeBase.mockResolvedValue('merge-dev');
    gitService.getRefSha.mockResolvedValue('head-dev');
    gitService.getThreeDotDiffStats.mockResolvedValue({
      fileCount: 9,
      totalAdditions: 90,
      totalDeletions: 10,
      files: [],
    });
    gitService.getCommitsBetween.mockResolvedValue([
      { hash: 'head-dev', date: '2026-04-29T06:04:18.000Z' },
    ]);

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1' },
      body: { branchName: 'feature/review-polish' },
    });

    await callRouteHandler(branchReviewsRouter, 'post', '/proj-1/branches/review', req, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(gitService.getMergeBase).toHaveBeenCalledWith(
      '/tmp/project',
      'refs/heads/development',
      'feature/review-polish'
    );
    expect(gitService.inferBaseBranch).not.toHaveBeenCalled();
    expect(branchReviewService.updateReview).toHaveBeenCalledWith('br-last-commit', expect.objectContaining({
      base_branch: 'development',
      base_branch_source: 'pinned',
      merge_base_sha: 'merge-dev',
      head_sha: 'head-dev',
      file_count: 9,
    }));
  });

  it('tries fork-point recovery on tap before declaring a selected branch unreviewable', async () => {
    getProjectById.mockResolvedValue({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: '/tmp/project',
      base_branch_display: 'main',
    });
    gitService.refExists.mockImplementation(async (_projectPath, ref) => (
      ref === 'refs/heads/feature/merged'
      || ref === 'refs/heads/main'
    ));
    gitService.listBranches.mockResolvedValue([
      { name: 'main', current: false, headSha: 'branch-head-sha' },
      { name: 'feature/merged', current: false, headSha: 'branch-head-sha' },
    ]);
    gitService.getMergeBase.mockResolvedValue('branch-head-sha');
    gitService.getRefSha.mockResolvedValue('branch-head-sha');
    gitService.getThreeDotDiffStats
      .mockResolvedValueOnce({
        fileCount: 0,
        totalAdditions: 0,
        totalDeletions: 0,
        files: [],
      })
      .mockResolvedValueOnce({
        fileCount: 2,
        totalAdditions: 12,
        totalDeletions: 3,
        files: [],
      });
    gitService.getCommitsBetween
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { hash: 'branch-head-sha', date: '2026-04-29T06:04:18.000Z' },
      ]);
    gitService.getForkPointFromReflog.mockResolvedValue('fork-point-sha');
    gitService.isAncestorRef.mockResolvedValue(true);

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1' },
      body: { branchName: 'feature/merged' },
    });

    await callRouteHandler(branchReviewsRouter, 'post', '/proj-1/branches/review', req, res);

    expect(res.status).not.toHaveBeenCalled();
    expect(gitService.getForkPointFromReflog).toHaveBeenCalledWith('/tmp/project', 'main', 'feature/merged');
    expect(branchReviewService.create).toHaveBeenCalledWith(expect.objectContaining({
      branchName: 'feature/merged',
      mergeBaseSha: 'branch-head-sha',
      forkPointSha: 'fork-point-sha',
      stats: expect.objectContaining({
        fileCount: 2,
        totalAdditions: 12,
        totalDeletions: 3,
        commitCount: 1,
      }),
    }));
  });

  it('attaches deterministic reviewLifecycle fields on branch-review list responses', async () => {
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-lifecycle-list',
        projectId: 'proj-1',
        branchName: 'feature/review-polish',
        baseBranch: 'main',
        status: 'closed',
        reviewStatus: 'failed',
        reviewError: 'Review deadline exceeded (300s)',
        reviewedAt: '2026-02-20T10:00:00.000Z',
        updatedAt: '2026-02-20T10:01:00.000Z',
      },
    ]);

    const { req, res } = createMockReqRes({ params: { projectId: 'proj-1' } });
    await callRouteHandler(branchReviewsRouter, 'get', '/proj-1/branch-reviews', req, res);

    const payload = res.json.mock.calls.at(-1)?.[0];
    expect(payload?.success).toBe(true);
    expect(payload?.branchReviews?.[0]?.reviewLifecycle).toEqual(expect.objectContaining({
      status: 'failed',
      phase: 'failed',
      isActive: false,
      isTerminal: true,
      canRetry: true,
      error: 'Review deadline exceeded (300s)',
      reviewedAt: '2026-02-20T10:00:00.000Z',
      updatedAt: '2026-02-20T10:01:00.000Z',
    }));
    expect(payload?.branchReviews?.[0]?.reviewActionEligibility).toEqual(expect.objectContaining({
      canApprove: true,
      canRequestChanges: true,
      blockedReason: null,
      staleReason: null,
    }));
  });

  it('schedules duplicate tracked branch review collapsing outside the list response path', async () => {
    const duplicateReviews = [
      {
        id: 'br-current',
        projectId: 'proj-1',
        branchName: 'feature/review-polish',
        baseBranch: 'main',
        status: 'active',
        isCurrent: true,
        reviewStatus: 'none',
        updatedAt: '2026-02-20T10:01:00.000Z',
      },
      {
        id: 'br-duplicate',
        projectId: 'proj-1',
        branchName: 'feature/review-polish',
        baseBranch: 'main',
        status: 'active',
        isCurrent: false,
        reviewStatus: 'none',
        updatedAt: '2026-02-20T10:00:00.000Z',
      },
    ];
    branchReviewService.getByProject.mockResolvedValue(duplicateReviews);
    branchReviewService.collapseDuplicateTrackedReviews.mockResolvedValue({
      reviews: [duplicateReviews[0]],
      duplicates: [duplicateReviews[1]],
    });

    const { req, res } = createMockReqRes({ params: { projectId: 'proj-1' } });
    await callRouteHandler(branchReviewsRouter, 'get', '/proj-1/branch-reviews', req, res);

    const payload = res.json.mock.calls.at(-1)?.[0];
    expect(payload?.success).toBe(true);
    expect(payload?.branchReviews).toHaveLength(2);

    await flushBackgroundReconciliation();

    expect(branchReviewService.collapseDuplicateTrackedReviews).toHaveBeenCalledWith('proj-1', duplicateReviews);
  });

  it('hides duplicate-repair branch review rows from the list response', async () => {
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-current',
        projectId: 'proj-1',
        branchName: 'feature/review-polish',
        baseBranch: 'main',
        status: 'active',
        isCurrent: true,
        reviewStatus: 'none',
        reviewError: null,
        updatedAt: '2026-02-20T10:01:00.000Z',
      },
      {
        id: 'br-duplicate-closed',
        projectId: 'proj-1',
        branchName: 'feature/review-polish',
        baseBranch: 'main',
        status: 'closed',
        isCurrent: false,
        reviewStatus: 'none',
        reviewError: 'Superseded duplicate branch review entry',
        updatedAt: '2026-02-20T10:00:00.000Z',
      },
    ]);

    const { req, res } = createMockReqRes({ params: { projectId: 'proj-1' } });
    await callRouteHandler(branchReviewsRouter, 'get', '/proj-1/branch-reviews', req, res);

    const payload = res.json.mock.calls.at(-1)?.[0];
    expect(payload?.success).toBe(true);
    expect(payload?.branchReviews).toHaveLength(1);
    expect(payload?.branchReviews?.[0]?.id).toBe('br-current');
  });

  it('maps reviewed records with persisted terminal reason metadata to partial lifecycle fields', async () => {
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-lifecycle-partial',
        projectId: 'proj-1',
        branchName: 'feature/review-polish',
        baseBranch: 'main',
        status: 'closed',
        reviewStatus: 'reviewed',
        reviewError: 'Partial review: 2/5 chunks analyzed before timeout',
        reviewedAt: '2026-02-20T11:00:00.000Z',
        updatedAt: '2026-02-20T11:01:00.000Z',
      },
    ]);

    const { req, res } = createMockReqRes({ params: { projectId: 'proj-1' } });
    await callRouteHandler(branchReviewsRouter, 'get', '/proj-1/branch-reviews', req, res);

    const payload = res.json.mock.calls.at(-1)?.[0];
    expect(payload?.success).toBe(true);
    expect(payload?.branchReviews?.[0]?.reviewLifecycle).toEqual(expect.objectContaining({
      status: 'partial',
      phase: 'partial',
      isActive: false,
      isTerminal: true,
      canRetry: true,
      error: 'Partial review: 2/5 chunks analyzed before timeout',
      sourceStatus: 'reviewed',
      reviewedAt: '2026-02-20T11:00:00.000Z',
      updatedAt: '2026-02-20T11:01:00.000Z',
    }));
  });

  it('returns branch review list without waiting for slow reconciliation', async () => {
    branchReviewService.getByProject
      .mockResolvedValueOnce([
        {
          id: 'br-slow-list',
          projectId: 'proj-1',
          branchName: 'feature/review-polish',
          baseBranch: 'main',
          status: 'active',
          reviewStatus: 'reviewing',
          reviewError: null,
          reviewedAt: null,
          updatedAt: '2026-02-20T11:05:00.000Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'br-slow-list',
          projectId: 'proj-1',
          branchName: 'feature/review-polish',
          baseBranch: 'main',
          status: 'active',
          reviewStatus: 'reviewing',
          reviewError: null,
          reviewedAt: null,
          updatedAt: '2026-02-20T11:05:00.000Z',
        },
      ]);
    gitService.getMergeBase.mockImplementation(() => new Promise(() => {}));

    const { req, res } = createMockReqRes({ params: { projectId: 'proj-1' } });

    await Promise.race([
      callRouteHandler(branchReviewsRouter, 'get', '/proj-1/branch-reviews', req, res),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out waiting for branch review list response')), 100)),
    ]);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      branchReviews: expect.arrayContaining([
        expect.objectContaining({
          id: 'br-slow-list',
          branchName: 'feature/review-polish',
          reviewLifecycle: expect.objectContaining({
            status: 'running',
            isActive: true,
          }),
        }),
      ]),
    }));
  });

  it('attaches deterministic reviewLifecycle fields on branch-review detail responses', async () => {
    branchReviewService.getById.mockResolvedValue({
      id: 'br-lifecycle-detail',
      projectId: 'proj-1',
      branchName: 'feature/review-polish',
      baseBranch: 'main',
      status: 'active',
      mergeBaseSha: null,
      headSha: 'head-1',
      review_status: 'queued',
      review_error: null,
      updated_at: '2026-02-20T10:05:00.000Z',
    });

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-lifecycle-detail' },
      query: {},
    });
    await callRouteHandler(branchReviewsRouter, 'get', '/proj-1/branch-reviews/br-lifecycle-detail', req, res);

    const payload = res.json.mock.calls.at(-1)?.[0];
    expect(payload?.success).toBe(true);
    expect(payload?.branchReview?.reviewLifecycle).toEqual(expect.objectContaining({
      status: 'queued',
      phase: 'queued',
      isActive: true,
      isTerminal: false,
      canRetry: false,
      error: null,
      updatedAt: '2026-02-20T10:05:00.000Z',
    }));
  });

  it('preserves canonical runtime lifecycle values on branch-review detail responses', async () => {
    branchReviewService.getById.mockResolvedValue({
      id: 'br-lifecycle-runtime-canonical',
      projectId: 'proj-1',
      branchName: 'feature/review-polish',
      baseBranch: 'main',
      status: 'active',
      mergeBaseSha: null,
      headSha: 'head-2',
      review_status: 'running',
      review_error: null,
      updated_at: '2026-02-20T10:06:00.000Z',
    });

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-lifecycle-runtime-canonical' },
      query: {},
    });
    await callRouteHandler(branchReviewsRouter, 'get', '/proj-1/branch-reviews/br-lifecycle-runtime-canonical', req, res);

    const payload = res.json.mock.calls.at(-1)?.[0];
    expect(payload?.success).toBe(true);
    expect(payload?.branchReview?.reviewLifecycle).toEqual(expect.objectContaining({
      status: 'running',
      phase: 'running',
      isActive: true,
      isTerminal: false,
      canRetry: false,
      error: null,
      sourceStatus: 'running',
      updatedAt: '2026-02-20T10:06:00.000Z',
    }));
  });

  it('refreshes head_sha when active review drift is detected', async () => {
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-1',
        projectId: 'proj-1',
        branchName: 'feature/review-polish',
        baseBranch: 'main',
        status: 'active',
        mergeBaseSha: 'merge-123',
        headSha: 'head-old',
        fileCount: 5,
        totalAdditions: 20,
        totalDeletions: 4,
        commitCount: 2,
        firstCommitAt: '2026-02-14T10:00:00.000Z',
        lastCommitAt: '2026-02-15T10:00:00.000Z',
      },
    ]);

    const { req, res } = createMockReqRes({ params: { projectId: 'proj-1' } });
    await callRouteHandler(branchReviewsRouter, 'get', '/proj-1/branch-reviews', req, res);
    await flushBackgroundReconciliation();

    expect(branchReviewService.updateReview).toHaveBeenCalledWith('br-1', expect.objectContaining({
      merge_base_sha: 'merge-123',
      head_sha: 'head-new',
      file_count: 5,
      total_additions: 20,
      total_deletions: 4,
      commit_count: 2,
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      branchReviews: expect.arrayContaining([
        expect.objectContaining({
          id: 'br-1',
          headSha: 'head-old',
        }),
      ]),
    }));
  });

  it('refreshes a selected branch review before review actions', async () => {
    branchReviewService.getById.mockResolvedValue({
      id: 'br-action',
      projectId: 'proj-1',
      branchName: 'feature/review-polish',
      baseBranch: 'main',
      status: 'active',
      mergeBaseSha: 'merge-123',
      headSha: 'head-old',
      reviewStatus: 'reviewed',
      reviewHeadSha: 'head-old',
      fileCount: 5,
      totalAdditions: 20,
      totalDeletions: 4,
      commitCount: 2,
      firstCommitAt: '2026-02-14T10:00:00.000Z',
      lastCommitAt: '2026-02-15T10:00:00.000Z',
    });
    gitService.getRefSha.mockResolvedValue('head-new');

    const { req, res } = createMockReqRes();
    await callRouteHandler(
      branchReviewsRouter,
      'post',
      '/proj-1/branch-reviews/br-action/refresh',
      req,
      res
    );

    expect(branchReviewService.updateReview).toHaveBeenCalledWith('br-action', expect.objectContaining({
      head_sha: 'head-new',
      file_count: 5,
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      branchReview: expect.objectContaining({
        id: 'br-action',
      }),
    }));
  });

  it('writes merged status with refreshed head_sha when diff is empty', async () => {
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-2',
        projectId: 'proj-1',
        branchName: 'feature/review-polish',
        baseBranch: 'main',
        status: 'active',
        mergeBaseSha: 'merge-old',
        headSha: 'head-old',
        fileCount: 2,
        totalAdditions: 9,
        totalDeletions: 3,
        commitCount: 1,
        firstCommitAt: '2026-02-12T10:00:00.000Z',
        lastCommitAt: '2026-02-12T10:00:00.000Z',
      },
    ]);
    gitService.getThreeDotDiffStats.mockResolvedValueOnce({
      fileCount: 0,
      totalAdditions: 0,
      totalDeletions: 0,
      files: [],
    });
    gitService.getCommitsBetween.mockResolvedValueOnce([
      { hash: 'head-merged', date: '2026-02-15T12:00:00.000Z' },
    ]);

    const { req, res } = createMockReqRes({ params: { projectId: 'proj-1' } });
    await callRouteHandler(branchReviewsRouter, 'get', '/proj-1/branch-reviews', req, res);
    await flushBackgroundReconciliation();

    expect(branchReviewService.updateReview).toHaveBeenCalledWith('br-2', expect.objectContaining({
      status: 'merged',
      is_current: 0,
      merge_base_sha: 'merge-123',
      head_sha: 'head-merged',
      file_count: 0,
      total_additions: 0,
      total_deletions: 0,
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      branchReviews: expect.arrayContaining([
        expect.objectContaining({
          id: 'br-2',
          status: 'active',
          headSha: 'head-old',
        }),
      ]),
    }));
  });

  it('keeps fast-forward-merged branch active via fork_point_sha fallback diff', async () => {
    // Review has a stored fork_point_sha from before the FF-merge. After the
    // FF-merge, getMergeBase(base, HEAD) == HEAD so the merge-base diff is
    // empty, BUT `fork_point_sha..HEAD` still has the branch's original work.
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-ffmerged',
        projectId: 'proj-1',
        branchName: 'feature/review-polish',
        baseBranch: 'main',
        status: 'active',
        isCurrent: false,
        mergeBaseSha: 'fork-point-sha',
        forkPointSha: 'fork-point-sha',
        headSha: 'head-before-ff',
        fileCount: 5,
        totalAdditions: 20,
        totalDeletions: 4,
        commitCount: 2,
        firstCommitAt: '2026-02-12T10:00:00.000Z',
        lastCommitAt: '2026-02-15T10:00:00.000Z',
      },
    ]);
    // After FF-merge, getMergeBase returns HEAD == head-ff-merged.
    gitService.getMergeBase.mockResolvedValueOnce('head-ff-merged');
    gitService.getRefSha.mockResolvedValueOnce('head-ff-merged');
    // First getThreeDotDiffStats: merge-base vs HEAD after FF-merge → empty.
    gitService.getThreeDotDiffStats.mockResolvedValueOnce({
      fileCount: 0,
      totalAdditions: 0,
      totalDeletions: 0,
      files: [],
    });
    gitService.getCommitsBetween.mockResolvedValueOnce([]);
    // The preserved fork point is still an ancestor of the new HEAD.
    gitService.isAncestorRef.mockResolvedValue(true);
    // Second getThreeDotDiffStats: fork_point..HEAD — still has the branch work.
    gitService.getThreeDotDiffStats.mockResolvedValueOnce({
      fileCount: 5,
      totalAdditions: 20,
      totalDeletions: 4,
      files: [],
    });
    gitService.getCommitsBetween.mockResolvedValueOnce([
      { hash: 'head-ff-merged', date: '2026-02-15T12:00:00.000Z' },
      { hash: 'older', date: '2026-02-14T10:00:00.000Z' },
    ]);

    const { req, res } = createMockReqRes({ params: { projectId: 'proj-1' } });
    await callRouteHandler(branchReviewsRouter, 'get', '/proj-1/branch-reviews', req, res);
    await flushBackgroundReconciliation();

    // Should be kept active with fork_point_sha preserved; NOT transitioned to merged.
    const updateCalls = branchReviewService.updateReview.mock.calls
      .filter(([id]) => id === 'br-ffmerged');
    expect(updateCalls.length).toBeGreaterThan(0);
    const lastCall = updateCalls.at(-1)?.[1];
    expect(lastCall).toEqual(expect.objectContaining({
      status: 'active',
      fork_point_sha: 'fork-point-sha',
      file_count: 5,
    }));
    expect(updateCalls.find(([, payload]) => payload.status === 'merged')).toBeUndefined();
  });

  it('keeps the current zero-diff branch active during reconciliation', async () => {
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-current-zero',
        projectId: 'proj-1',
        branchName: 'feature/review-polish',
        baseBranch: 'main',
      status: 'active',
      isCurrent: true,
      mergeBaseSha: 'merge-old',
      headSha: 'head-old',
      reviewStatus: 'reviewed',
      reviewSummary: 'Old review summary',
      reviewHeadSha: 'head-old',
      reviewedAt: '2026-02-13T10:00:00.000Z',
      fileCount: 2,
      totalAdditions: 9,
      totalDeletions: 3,
        commitCount: 1,
        firstCommitAt: '2026-02-12T10:00:00.000Z',
        lastCommitAt: '2026-02-12T10:00:00.000Z',
      },
    ]);
    gitService.getThreeDotDiffStats.mockResolvedValueOnce({
      fileCount: 0,
      totalAdditions: 0,
      totalDeletions: 0,
      files: [],
    });
    gitService.getCommitsBetween.mockResolvedValueOnce([]);

    const { req, res } = createMockReqRes({ params: { projectId: 'proj-1' } });
    await callRouteHandler(branchReviewsRouter, 'get', '/proj-1/branch-reviews', req, res);
    await flushBackgroundReconciliation();

    expect(branchReviewService.updateReview).toHaveBeenCalledWith('br-current-zero', expect.objectContaining({
      status: 'active',
      merge_base_sha: 'merge-123',
      head_sha: 'head-old',
      file_count: 0,
      total_additions: 0,
      total_deletions: 0,
      commit_count: 0,
      first_commit_at: null,
      last_commit_at: null,
      review_status: 'none',
      review_summary: null,
      review_head_sha: null,
      reviewed_at: null,
    }));
    expect(branchReviewService.updateReview).not.toHaveBeenCalledWith('br-current-zero', expect.objectContaining({
      status: 'merged',
      is_current: 0,
    }));
  });

  it('retires accidental branch reviews for the remote default branch', async () => {
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-default-branch',
        projectId: 'proj-1',
        branchName: 'development',
        baseBranch: 'feature/stale-base',
        status: 'active',
        isCurrent: true,
        reviewStatus: 'reviewed',
        reviewSummary: 'Old summary',
        reviewHeadSha: 'head-old',
      },
    ]);
    gitService.getRemoteDefaultBranch.mockResolvedValueOnce('development');
    gitService.refExists.mockImplementation(async (_projectPath, ref) => {
      if (ref === 'refs/heads/development') return true;
      if (ref === 'refs/remotes/origin/development') return true;
      return false;
    });

    const { req, res } = createMockReqRes({ params: { projectId: 'proj-1' } });
    await callRouteHandler(branchReviewsRouter, 'get', '/proj-1/branch-reviews', req, res);
    await flushBackgroundReconciliation();

    expect(branchReviewService.updateReview).toHaveBeenCalledWith('br-default-branch', expect.objectContaining({
      status: 'stale',
      is_current: 0,
      base_branch: 'development',
      review_status: 'none',
      review_summary: null,
      review_head_sha: null,
    }));
  });

  it('does not fail branch review list requests when current-branch repair write throws', async () => {
    gitService.getCurrentBranchName.mockResolvedValueOnce('feature/review-polish');
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-repair-throws',
        projectId: 'proj-1',
        branchName: 'feature/review-polish',
        baseBranch: 'main',
        status: 'active',
        isCurrent: false,
        reviewStatus: 'reviewed',
        updatedAt: '2026-02-20T10:01:00.000Z',
      },
    ]);
    branchReviewService.setCurrentBranch.mockRejectedValueOnce(new Error('db unavailable'));

    const { req, res } = createMockReqRes({ params: { projectId: 'proj-1' } });
    await callRouteHandler(branchReviewsRouter, 'get', '/proj-1/branch-reviews', req, res);

    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      branchReviews: expect.arrayContaining([
        expect.objectContaining({
          id: 'br-repair-throws',
          isCurrent: false,
        }),
      ]),
    }));
  });

  it('reassigns the current branch review when git current branch changed', async () => {
    gitService.getCurrentBranchName.mockResolvedValueOnce('feature/combat-exceptions');
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-old-current',
        projectId: 'proj-1',
        branchName: 'feature/share-current-log',
        baseBranch: 'main',
        status: 'active',
        isCurrent: true,
        reviewStatus: 'reviewed',
        updatedAt: '2026-02-20T10:01:00.000Z',
      },
      {
        id: 'br-new-current',
        projectId: 'proj-1',
        branchName: 'feature/combat-exceptions',
        baseBranch: 'main',
        status: 'active',
        isCurrent: false,
        reviewStatus: 'reviewed',
        updatedAt: '2026-02-20T10:02:00.000Z',
      },
    ]);

    const { req, res } = createMockReqRes({ params: { projectId: 'proj-1' } });
    await callRouteHandler(branchReviewsRouter, 'get', '/proj-1/branch-reviews', req, res);

    expect(branchReviewService.setCurrentBranch).toHaveBeenCalledWith('proj-1', 'br-new-current');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      branchReviews: expect.arrayContaining([
        expect.objectContaining({
          id: 'br-old-current',
          isCurrent: false,
        }),
        expect.objectContaining({
          id: 'br-new-current',
          isCurrent: true,
        }),
      ]),
    }));
  });

  it('caches current branch lookups across normal list requests but bypasses cache for forced refresh', async () => {
    gitService.getCurrentBranchName.mockResolvedValue('feature/combat-exceptions');
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-old-current',
        projectId: 'proj-1',
        branchName: 'feature/share-current-log',
        baseBranch: 'main',
        status: 'active',
        isCurrent: true,
        reviewStatus: 'reviewed',
        updatedAt: '2026-02-20T10:01:00.000Z',
      },
      {
        id: 'br-new-current',
        projectId: 'proj-1',
        branchName: 'feature/combat-exceptions',
        baseBranch: 'main',
        status: 'active',
        isCurrent: false,
        reviewStatus: 'reviewed',
        updatedAt: '2026-02-20T10:02:00.000Z',
      },
    ]);

    const first = createMockReqRes({ params: { projectId: 'proj-1' } });
    await callRouteHandler(branchReviewsRouter, 'get', '/proj-1/branch-reviews', first.req, first.res);

    const second = createMockReqRes({ params: { projectId: 'proj-1' } });
    await callRouteHandler(branchReviewsRouter, 'get', '/proj-1/branch-reviews', second.req, second.res);

    expect(gitService.getCurrentBranchName).toHaveBeenCalledTimes(1);

    const forced = createMockReqRes({
      params: { projectId: 'proj-1' },
      query: { refreshCurrent: '1' },
    });
    await callRouteHandler(branchReviewsRouter, 'get', '/proj-1/branch-reviews', forced.req, forced.res);

    expect(gitService.getCurrentBranchName).toHaveBeenCalledTimes(2);
  });

  it('deduplicates rename-only files in detail manifest when numstat uses old => new syntax', async () => {
    branchReviewService.getById.mockResolvedValue({
      id: 'br-3',
      projectId: 'proj-1',
      branchName: 'feature/review-polish',
      baseBranch: 'main',
      status: 'active',
      mergeBaseSha: 'merge-rename-1',
      headSha: 'head-new',
    });

    gitService.getThreeDotDiffNameStatus.mockResolvedValue([
      {
        status: 'R',
        oldPath: '.planning/phases/01-PLAN.md',
        path: '.planning/archive/v0.30.0-branch-reviews/01-PLAN.md',
      },
    ]);
    gitService.getThreeDotDiffStats.mockResolvedValue({
      fileCount: 1,
      totalAdditions: 0,
      totalDeletions: 0,
      files: [
        {
          path: '.planning/{phases => archive/v0.30.0-branch-reviews}/01-PLAN.md',
          additions: 0,
          deletions: 0,
        },
      ],
    });

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-3' },
      query: {},
    });
    await callRouteHandler(branchReviewsRouter, 'get', '/proj-1/branch-reviews/br-3', req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      branchReview: expect.objectContaining({
        id: 'br-3',
        files: [
          expect.objectContaining({
            path: '.planning/archive/v0.30.0-branch-reviews/01-PLAN.md',
            oldPath: '.planning/phases/01-PLAN.md',
            status: 'R',
            additions: 0,
            deletions: 0,
          }),
        ],
      }),
    }));
  });

  it('returns the full detail manifest when includeAllFiles is requested', async () => {
    branchReviewService.getById.mockResolvedValue({
      id: 'br-detail-full',
      projectId: 'proj-1',
      branchName: 'feature/review-polish',
      baseBranch: 'main',
      status: 'active',
      mergeBaseSha: 'merge-full-1',
      headSha: 'head-new',
      fileCount: 60,
    });

    const manifestFiles = Array.from({ length: 60 }, (_entry, index) => ({
      path: `Assets/Scripts/File${String(index + 1).padStart(2, '0')}.cs`,
      additions: index + 1,
      deletions: 0,
      status: 'M',
      oldPath: null,
    }));
    gitService.getThreeDotDiffNameStatus.mockResolvedValue(
      manifestFiles.map((file) => ({
        status: file.status,
        path: file.path,
        oldPath: file.oldPath,
      }))
    );
    gitService.getThreeDotDiffStats.mockResolvedValue({
      fileCount: manifestFiles.length,
      totalAdditions: manifestFiles.reduce((sum, file) => sum + file.additions, 0),
      totalDeletions: 0,
      files: manifestFiles.map((file) => ({
        path: file.path,
        additions: file.additions,
        deletions: file.deletions,
      })),
    });

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-detail-full' },
      query: { includeAllFiles: 'true' },
    });
    await callRouteHandler(branchReviewsRouter, 'get', '/proj-1/branch-reviews/br-detail-full', req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      branchReview: expect.objectContaining({
        id: 'br-detail-full',
        files: expect.arrayContaining([
          expect.objectContaining({ path: 'Assets/Scripts/File01.cs' }),
          expect.objectContaining({ path: 'Assets/Scripts/File60.cs' }),
        ]),
        diffManifestSummary: expect.objectContaining({
          visibleCount: 60,
          totalCount: 60,
          hiddenCount: 0,
          isCapped: false,
        }),
      }),
    }));
    const payload = res.json.mock.calls.at(-1)?.[0];
    expect(payload?.branchReview?.files).toHaveLength(60);
  });

  it('reconciles active review using stored base branch (not re-inferred)', async () => {
    // After the stabilization fix (b55c40f1), reconciliation prefers the stored
    // baseBranch over re-inference to avoid inconsistent merge-base shifts.
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-4',
        projectId: 'proj-1',
        branchName: 'feature/review-polish-child',
        baseBranch: 'main',
        status: 'active',
        mergeBaseSha: 'old-merge',
        headSha: 'old-head',
        fileCount: 5,
        totalAdditions: 20,
        totalDeletions: 4,
        commitCount: 2,
        firstCommitAt: '2026-02-14T10:00:00.000Z',
        lastCommitAt: '2026-02-15T10:00:00.000Z',
      },
    ]);
    gitService.refExists.mockImplementation(async (_projectPath, ref) => {
      if (ref === 'refs/heads/feature/review-polish-child') return true;
      if (ref === 'refs/remotes/origin/main') return true;
      return false;
    });
    gitService.getMergeBase.mockResolvedValueOnce('merge-456');
    gitService.getThreeDotDiffStats.mockResolvedValueOnce({
      fileCount: 8,
      totalAdditions: 30,
      totalDeletions: 6,
    });
    gitService.getCommitsBetween.mockResolvedValueOnce([
      { hash: 'head-new', date: '2026-02-16T10:00:00.000Z' },
      { hash: 'commit-2', date: '2026-02-15T10:00:00.000Z' },
      { hash: 'commit-1', date: '2026-02-14T10:00:00.000Z' },
    ]);

    const { req, res } = createMockReqRes({ params: { projectId: 'proj-1' } });
    await callRouteHandler(branchReviewsRouter, 'get', '/proj-1/branch-reviews', req, res);
    await flushBackgroundReconciliation();

    // Should use stored baseBranch 'main', not re-infer
    expect(branchReviewService.updateReview).toHaveBeenCalledWith('br-4', expect.objectContaining({
      base_branch: 'main',
      merge_base_sha: 'merge-456',
      head_sha: 'head-new',
      file_count: 8,
    }));
    // inferBaseBranch should NOT have been called since baseBranch is already set
    expect(gitService.inferBaseBranch).not.toHaveBeenCalled();
  });

  it('prefers project base branch over stale stored base branch during reconciliation', async () => {
    getProjectById.mockResolvedValueOnce({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: '/tmp/project',
      base_branch_display: 'main',
    });
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-project-base',
        projectId: 'proj-1',
        branchName: 'feature/AgenticReview',
        baseBranch: 'feature/GeminiFullSupport',
        status: 'active',
        mergeBaseSha: 'old-merge',
        headSha: 'old-head',
        fileCount: 3,
        totalAdditions: 12,
        totalDeletions: 2,
        commitCount: 1,
        firstCommitAt: '2026-02-24T10:00:00.000Z',
        lastCommitAt: '2026-02-24T10:00:00.000Z',
      },
    ]);
    gitService.refExists.mockImplementation(async (_projectPath, ref) => {
      if (ref === 'refs/heads/feature/AgenticReview') return true;
      if (ref === 'refs/remotes/origin/main') return true;
      return false;
    });
    gitService.getMergeBase.mockResolvedValueOnce('merge-main');
    gitService.getThreeDotDiffStats.mockResolvedValueOnce({
      fileCount: 4,
      totalAdditions: 20,
      totalDeletions: 3,
    });
    gitService.getCommitsBetween.mockResolvedValueOnce([
      { hash: 'head-main', date: '2026-02-25T10:00:00.000Z' },
      { hash: 'older', date: '2026-02-24T10:00:00.000Z' },
    ]);

    const { req, res } = createMockReqRes({ params: { projectId: 'proj-1' } });
    await callRouteHandler(branchReviewsRouter, 'get', '/proj-1/branch-reviews', req, res);
    await flushBackgroundReconciliation();

    expect(branchReviewService.updateReview).toHaveBeenCalledWith('br-project-base', expect.objectContaining({
      base_branch: 'main',
      merge_base_sha: 'merge-main',
      head_sha: 'head-main',
      file_count: 4,
    }));
    expect(gitService.inferBaseBranch).not.toHaveBeenCalled();
  });

  it('keeps stored base branch when it still resolves during reconciliation', async () => {
    getProjectById.mockResolvedValueOnce({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: '/tmp/project',
      base_branch_display: 'main',
    });
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-stored-base',
        projectId: 'proj-1',
        branchName: 'feature/AgenticReview',
        baseBranch: 'feature/GeminiFullSupport',
        status: 'active',
        mergeBaseSha: 'old-merge',
        headSha: 'old-head',
        fileCount: 3,
        totalAdditions: 12,
        totalDeletions: 2,
        commitCount: 1,
        firstCommitAt: '2026-02-24T10:00:00.000Z',
        lastCommitAt: '2026-02-24T10:00:00.000Z',
      },
    ]);
    gitService.refExists.mockImplementation(async (_projectPath, ref) => {
      if (ref === 'refs/heads/feature/AgenticReview') return true;
      if (ref === 'refs/remotes/origin/feature/GeminiFullSupport') return true;
      if (ref === 'refs/remotes/origin/main') return true;
      return false;
    });
    gitService.getMergeBase.mockResolvedValueOnce('merge-stored-base');
    gitService.getThreeDotDiffStats.mockResolvedValueOnce({
      fileCount: 4,
      totalAdditions: 20,
      totalDeletions: 3,
    });
    gitService.getCommitsBetween.mockResolvedValueOnce([
      { hash: 'head-stored', date: '2026-02-25T10:00:00.000Z' },
      { hash: 'older', date: '2026-02-24T10:00:00.000Z' },
    ]);

    const { req, res } = createMockReqRes({ params: { projectId: 'proj-1' } });
    await callRouteHandler(branchReviewsRouter, 'get', '/proj-1/branch-reviews', req, res);
    await flushBackgroundReconciliation();

    expect(branchReviewService.updateReview).toHaveBeenCalledWith('br-stored-base', expect.objectContaining({
      base_branch: 'feature/GeminiFullSupport',
      merge_base_sha: 'merge-stored-base',
      head_sha: 'head-stored',
      file_count: 4,
    }));
    expect(gitService.getMergeBase).toHaveBeenCalledWith(
      '/tmp/project',
      'origin/feature/GeminiFullSupport',
      'feature/AgenticReview'
    );
  });

  it('re-inferrs stale stored project base when ancestry points to a different base', async () => {
    getProjectById.mockResolvedValueOnce({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: '/tmp/project',
      base_branch_display: 'main',
    });
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-heal-stale-base',
        projectId: 'proj-1',
        branchName: 'feature/AgenticReview',
        baseBranch: 'main',
        status: 'active',
        mergeBaseSha: 'old-merge',
        headSha: 'old-head',
        fileCount: 3,
        totalAdditions: 12,
        totalDeletions: 2,
        commitCount: 1,
        firstCommitAt: '2026-02-24T10:00:00.000Z',
        lastCommitAt: '2026-02-24T10:00:00.000Z',
      },
    ]);
    gitService.refExists.mockImplementation(async (_projectPath, ref) => {
      if (ref === 'refs/heads/feature/AgenticReview') return true;
      if (ref === 'refs/remotes/origin/main') return true;
      if (ref === 'refs/remotes/origin/feature/GeminiFullSupport') return true;
      return false;
    });
    gitService.inferBaseBranch.mockResolvedValueOnce('feature/GeminiFullSupport');
    gitService.getMergeBase.mockResolvedValueOnce('merge-healed-base');
    gitService.getThreeDotDiffStats.mockResolvedValueOnce({
      fileCount: 4,
      totalAdditions: 20,
      totalDeletions: 3,
    });
    gitService.getCommitsBetween.mockResolvedValueOnce([
      { hash: 'head-healed', date: '2026-02-25T10:00:00.000Z' },
      { hash: 'older', date: '2026-02-24T10:00:00.000Z' },
    ]);

    const { req, res } = createMockReqRes({ params: { projectId: 'proj-1' } });
    await callRouteHandler(branchReviewsRouter, 'get', '/proj-1/branch-reviews', req, res);
    await flushBackgroundReconciliation();

    expect(gitService.inferBaseBranch).toHaveBeenCalledWith(
      '/tmp/project',
      'feature/AgenticReview',
      { preferredBaseBranch: null }
    );
    expect(branchReviewService.updateReview).toHaveBeenCalledWith('br-heal-stale-base', expect.objectContaining({
      base_branch: 'feature/GeminiFullSupport',
      merge_base_sha: 'merge-healed-base',
      head_sha: 'head-healed',
      file_count: 4,
    }));
    expect(gitService.getMergeBase).toHaveBeenCalledWith(
      '/tmp/project',
      'origin/feature/GeminiFullSupport',
      'feature/AgenticReview'
    );
  });

  it('does not mutate review status before validating project path for direct review trigger', async () => {
    getProjectById.mockResolvedValueOnce({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: null,
    });
    branchReviewService.getById.mockResolvedValueOnce({
      id: 'br-5',
      projectId: 'proj-1',
      branchName: 'feature/review-polish',
      baseBranch: 'main',
      status: 'active',
      reviewStatus: 'failed',
    });

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-5' },
      body: {},
    });
    await callRouteHandler(branchReviewsRouter, 'post', '/proj-1/branch-reviews/br-5/review', req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(branchReviewService.updateReview).not.toHaveBeenCalledWith(
      'br-5',
      expect.objectContaining({ review_status: 'reviewing' })
    );
    expect(reviewService.reviewBranchReview).not.toHaveBeenCalled();
    expect(reviewService.events.emit).not.toHaveBeenCalled();
  });

  it('emits lifecycle events for direct review trigger so sockets reconcile immediate MCP runs', async () => {
    getProjectById.mockResolvedValueOnce({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: '/tmp/project',
    });
    branchReviewService.getById
      .mockResolvedValueOnce({
        id: 'br-6',
        projectId: 'proj-1',
        branchName: 'feature/review-polish',
        baseBranch: 'main',
        status: 'active',
        reviewStatus: 'none',
      })
      .mockResolvedValueOnce({
        id: 'br-6',
        projectId: 'proj-1',
        branchName: 'feature/review-polish',
        baseBranch: 'main',
        status: 'active',
        reviewStatus: 'reviewed',
        reviewError: null,
        reviewedAt: '2026-03-09T06:10:00.000Z',
        updatedAt: '2026-03-09T06:10:01.000Z',
      });
    reviewService.reviewBranchReview.mockResolvedValueOnce({
      riskLevel: 'medium',
      summary: 'Automated review completed.',
      reviewedAt: '2026-03-09T06:10:00.000Z',
    });

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-6' },
      body: {},
    });
    await callRouteHandler(branchReviewsRouter, 'post', '/proj-1/branch-reviews/br-6/review', req, res);

    expect(reviewService.reviewBranchReview).toHaveBeenCalledWith('/tmp/project', 'br-6', {
      codegraphMcpEnabledOverride: null,
      force: true,
      externalSignal: expect.any(AbortSignal),
      onHeartbeat: expect.any(Function),
      onProgressCheckpoint: expect.any(Function),
      policySource: undefined,
      reviewMode: undefined,
      scope: undefined,
    });
    expect(reviewService.events.emit).toHaveBeenNthCalledWith(1, 'branch-review-reviewing', {
      projectId: 'proj-1',
      branchReviewId: 'br-6',
    });
    expect(reviewService.events.emit).toHaveBeenNthCalledWith(2, 'branch-review-reviewed', {
      projectId: 'proj-1',
      branchReviewId: 'br-6',
      riskLevel: 'medium',
      summary: 'Automated review completed.',
      error: null,
      reviewedAt: '2026-03-09T06:10:00.000Z',
      updatedAt: expect.any(String),
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      review: expect.objectContaining({
        riskLevel: 'medium',
        summary: 'Automated review completed.',
      }),
      branchReview: expect.objectContaining({
        id: 'br-6',
        reviewStatus: 'reviewed',
      }),
    }));
  });

  it('rejects approve transitions while review lifecycle is non-terminal', async () => {
    branchReviewService.getById.mockResolvedValueOnce(buildBranchReviewActionSnapshot({
      id: 'br-action-running',
      reviewStatus: 'retrying',
      reviewHeadSha: 'head-1',
      headSha: 'head-1',
    }));

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-action-running' },
      body: { status: 'merged' },
    });
    await callRouteHandler(branchReviewsRouter, 'patch', '/proj-1/branch-reviews/br-action-running/status', req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    const payload = res.json.mock.calls.at(-1)?.[0];
    expectDeterministicConflictPayload(payload, {
      expectedStaleReason: null,
      blockedReasonPattern: /still in progress/i,
      expectedLifecycleStatus: 'retrying',
    });
    expect(branchReviewService.setStatus).not.toHaveBeenCalled();
  });

  it('allows request-changes transitions when review identity is stale', async () => {
    branchReviewService.getById.mockResolvedValueOnce(buildBranchReviewActionSnapshot({
      id: 'br-action-stale',
      reviewHeadSha: 'head-old',
      headSha: 'head-new',
    }));
    branchReviewService.setStatus.mockResolvedValueOnce({
      ...buildBranchReviewActionSnapshot({
        id: 'br-action-stale',
        reviewHeadSha: 'head-old',
        headSha: 'head-new',
      }),
      status: 'stale',
    });

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-action-stale' },
      body: { status: 'stale' },
    });
    await callRouteHandler(branchReviewsRouter, 'patch', '/proj-1/branch-reviews/br-action-stale/status', req, res);

    expect(branchReviewService.setStatus).toHaveBeenCalledWith('br-action-stale', 'stale');
    const payload = res.json.mock.calls.at(-1)?.[0];
    expect(payload).toEqual(expect.objectContaining({
      success: true,
      branchReview: expect.objectContaining({
        status: 'stale',
        reviewActionEligibility: expect.objectContaining({
          canApprove: true,
          canRequestChanges: true,
        }),
      }),
    }));
    expect(payload.branchReview.reviewActionEligibility).toEqual(expect.objectContaining({
      blockedReason: 'Review is stale: branch head changed after review completion. Run review again before actioning.',
      staleReason: 'head_mismatch',
    }));
  });

  it('rejects stale transition while review lifecycle is non-terminal with deterministic 409 payload shape', async () => {
    branchReviewService.getById.mockResolvedValueOnce(buildBranchReviewActionSnapshot({
      id: 'br-action-running-stale',
      reviewStatus: 'running',
      reviewHeadSha: 'head-2',
      headSha: 'head-2',
    }));

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-action-running-stale' },
      body: { status: 'stale' },
    });
    await callRouteHandler(branchReviewsRouter, 'patch', '/proj-1/branch-reviews/br-action-running-stale/status', req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    const payload = res.json.mock.calls.at(-1)?.[0];
    expectDeterministicConflictPayload(payload, {
      expectedStaleReason: null,
      blockedReasonPattern: /still in progress/i,
      expectedLifecycleStatus: 'running',
    });
    expect(branchReviewService.setStatus).not.toHaveBeenCalled();
  });

  it('allows approve transitions for terminal, non-stale review snapshots', async () => {
    branchReviewService.getById.mockResolvedValueOnce(buildBranchReviewActionSnapshot({
      id: 'br-action-ok',
    }));
    branchReviewService.setStatus.mockResolvedValueOnce({
      ...buildBranchReviewActionSnapshot({
        id: 'br-action-ok',
      }),
      status: 'merged',
    });

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-action-ok' },
      body: { status: 'merged' },
    });
    await callRouteHandler(branchReviewsRouter, 'patch', '/proj-1/branch-reviews/br-action-ok/status', req, res);

    expect(branchReviewService.setStatus).toHaveBeenCalledWith('br-action-ok', 'merged');
    const payload = res.json.mock.calls.at(-1)?.[0];
    expect(payload?.success).toBe(true);
    expect(payload?.branchReview?.reviewActionEligibility).toEqual(expect.objectContaining({
      canApprove: true,
      canRequestChanges: true,
      blockedReason: null,
      staleReason: null,
    }));
  });

  it('allows approve transitions when review status is canonical completed', async () => {
    branchReviewService.getById.mockResolvedValueOnce(buildBranchReviewActionSnapshot({
      id: 'br-action-canonical-completed',
      reviewStatus: 'completed',
      reviewHeadSha: 'head-canonical',
      headSha: 'head-canonical',
    }));
    branchReviewService.setStatus.mockResolvedValueOnce({
      ...buildBranchReviewActionSnapshot({
        id: 'br-action-canonical-completed',
        reviewStatus: 'completed',
        reviewHeadSha: 'head-canonical',
        headSha: 'head-canonical',
      }),
      status: 'merged',
    });

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-action-canonical-completed' },
      body: { status: 'merged' },
    });
    await callRouteHandler(
      branchReviewsRouter,
      'patch',
      '/proj-1/branch-reviews/br-action-canonical-completed/status',
      req,
      res
    );

    expect(branchReviewService.setStatus).toHaveBeenCalledWith('br-action-canonical-completed', 'merged');
    const payload = res.json.mock.calls.at(-1)?.[0];
    expect(payload?.success).toBe(true);
    expect(payload?.branchReview?.reviewActionEligibility).toEqual(expect.objectContaining({
      canApprove: true,
      canRequestChanges: true,
      blockedReason: null,
      staleReason: null,
    }));
  });

  it('returns alreadyRunning for queued branch reviews instead of re-enqueueing', async () => {
    branchReviewService.getById.mockResolvedValueOnce({
      id: 'br-queued-active',
      projectId: 'proj-1',
      branchName: 'feature/review-polish',
      baseBranch: 'main',
      status: 'active',
      reviewStatus: 'queued',
      reviewError: null,
      updatedAt: '2026-02-20T12:00:00.000Z',
    });
    reviewService.getQueueStatus.mockReturnValueOnce([
      {
        id: 'queue-1',
        type: 'branch_review',
        branchReviewId: 'br-queued-active',
        status: 'queued',
        lifecycle: {
          status: 'queued',
          isActive: true,
        },
      },
    ]);

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-queued-active' },
      body: {},
    });
    await callRouteHandler(
      branchReviewsRouter,
      'post',
      '/proj-1/branch-reviews/br-queued-active/review/queue',
      req,
      res
    );

    expect(reviewService.enqueueBranchReview).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      alreadyRunning: true,
      id: 'queue-1',
      position: 1,
      branchReview: expect.objectContaining({
        id: 'br-queued-active',
        reviewLifecycle: expect.objectContaining({
          status: 'queued',
          isActive: true,
        }),
      }),
    }));
  });

  it('passes reviewMode through without clearing the prior snapshot when queueing a full branch review', async () => {
    branchReviewService.getById.mockResolvedValueOnce({
      id: 'br-queue-mode',
      projectId: 'proj-1',
      branchName: 'feature/review-polish',
      baseBranch: 'main',
      status: 'active',
      reviewStatus: 'reviewed',
      reviewSummary: 'Previous review summary',
      reviewJson: { summary: 'Previous review summary' },
      reviewHeadSha: 'head-ok',
      reviewedAt: '2026-02-20T10:00:00.000Z',
      reviewError: null,
      updatedAt: '2026-02-20T12:00:00.000Z',
    });
    reviewService.enqueueBranchReview.mockReturnValueOnce({
      id: 'queue-mode-1',
      position: 1,
    });

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-queue-mode' },
      body: { reviewMode: 'full', policySource: 'working_tree' },
    });
    await callRouteHandler(
      branchReviewsRouter,
      'post',
      '/proj-1/branch-reviews/br-queue-mode/review/queue',
      req,
      res
    );

    expect(reviewService.enqueueBranchReview).toHaveBeenCalledWith('/tmp/project', 'br-queue-mode', expect.objectContaining({
      projectId: 'proj-1',
      reviewMode: 'full',
      policySource: 'working_tree',
    }));
    expect(branchReviewService.updateReview).not.toHaveBeenCalledWith('br-queue-mode', expect.objectContaining({
      review_status: 'none',
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      id: 'queue-mode-1',
      position: 1,
    }));
  });

  it('returns alreadyReviewed for a current last-commit review before queueing', async () => {
    const lastCommitReview = {
      id: 'br-last-reviewed',
      projectId: 'proj-1',
      branchName: 'feature/review-polish',
      baseBranch: 'feature/review-polish~last-commit',
      baseBranchSource: 'last_commit',
      status: 'active',
      reviewStatus: 'reviewed',
      headSha: 'head-reviewed',
      reviewHeadSha: 'head-reviewed',
      reviewedAt: '2026-05-07T10:00:00.000Z',
      reviewError: null,
      updatedAt: '2026-05-07T10:01:00.000Z',
    };
    branchReviewService.getById.mockResolvedValueOnce(lastCommitReview);
    reviewService.refreshLatestBranchReviewHeadForRun.mockResolvedValueOnce(lastCommitReview);

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-last-reviewed' },
      body: {},
    });
    await callRouteHandler(
      branchReviewsRouter,
      'post',
      '/proj-1/branch-reviews/br-last-reviewed/review/queue',
      req,
      res
    );

    expect(reviewService.refreshLatestBranchReviewHeadForRun).toHaveBeenCalledWith('/tmp/project', lastCommitReview);
    expect(reviewService.enqueueBranchReview).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      alreadyReviewed: true,
      reason: 'no_unreviewed_commits',
      branchReview: expect.objectContaining({
        id: 'br-last-reviewed',
        baseBranchSource: 'last_commit',
      }),
    }));
  });

  it('queues a forced last-commit review after already-reviewed confirmation', async () => {
    const lastCommitReview = {
      id: 'br-last-force',
      projectId: 'proj-1',
      branchName: 'feature/review-polish',
      baseBranch: 'feature/review-polish~last-commit',
      baseBranchSource: 'last_commit',
      status: 'active',
      reviewStatus: 'reviewed',
      headSha: 'head-reviewed',
      reviewHeadSha: 'head-reviewed',
      reviewedAt: '2026-05-07T10:00:00.000Z',
      reviewError: null,
      updatedAt: '2026-05-07T10:01:00.000Z',
    };
    branchReviewService.getById.mockResolvedValueOnce(lastCommitReview);
    reviewService.refreshLatestBranchReviewHeadForRun.mockResolvedValueOnce(lastCommitReview);
    reviewService.enqueueBranchReview.mockReturnValueOnce({
      id: 'queue-force-1',
      position: 1,
    });

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-last-force' },
      body: { force: true, policySource: 'working_tree' },
    });
    await callRouteHandler(
      branchReviewsRouter,
      'post',
      '/proj-1/branch-reviews/br-last-force/review/queue',
      req,
      res
    );

    expect(reviewService.enqueueBranchReview).toHaveBeenCalledWith('/tmp/project', 'br-last-force', expect.objectContaining({
      projectId: 'proj-1',
      policySource: 'working_tree',
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      id: 'queue-force-1',
      position: 1,
    }));
  });

  it('clears persisted snapshot before queueing a full branch rereview when requested', async () => {
    branchReviewService.getById.mockResolvedValueOnce(buildBranchReviewActionSnapshot({
      id: 'br-reset-queue',
      reviewStatus: 'reviewed',
      reviewSummary: 'Previous review summary',
      reviewJson: { summary: 'Previous review summary' },
      reviewHeadSha: 'head-ok',
      reviewedAt: '2026-02-20T10:00:00.000Z',
    }));
    branchReviewService.updateReview.mockResolvedValueOnce(buildBranchReviewActionSnapshot({
      id: 'br-reset-queue',
      reviewStatus: 'none',
      reviewSummary: null,
      reviewJson: null,
      reviewHeadSha: null,
      reviewedAt: null,
    }));
    reviewService.enqueueBranchReview.mockReturnValueOnce({
      id: 'queue-reset-1',
      position: 1,
    });

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-reset-queue' },
      body: { reviewMode: 'full', resetSnapshot: true },
    });
    await callRouteHandler(
      branchReviewsRouter,
      'post',
      '/proj-1/branch-reviews/br-reset-queue/review/queue',
      req,
      res
    );

    expect(branchReviewService.updateReview).toHaveBeenCalledWith('br-reset-queue', expect.objectContaining({
      review_status: 'none',
      review_summary: null,
      review_json: null,
      review_head_sha: null,
      reviewed_at: null,
    }));
    expect(reviewService.enqueueBranchReview).toHaveBeenCalledWith('/tmp/project', 'br-reset-queue', expect.objectContaining({
      projectId: 'proj-1',
      reviewMode: 'full',
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      id: 'queue-reset-1',
      position: 1,
    }));
  });

  it('returns alreadyRunning for active branch review queue entries on direct review requests', async () => {
    branchReviewService.getById.mockResolvedValueOnce({
      id: 'br-running-queued',
      projectId: 'proj-1',
      branchName: 'feature/review-polish',
      baseBranch: 'main',
      status: 'active',
      reviewStatus: 'reviewed',
      reviewError: null,
      reviewedAt: '2026-02-20T10:00:00.000Z',
      updatedAt: '2026-02-20T12:05:00.000Z',
    });
    reviewService.getQueueStatus.mockReturnValueOnce([
      {
        id: 'queue-2',
        type: 'branch_review',
        branchReviewId: 'br-running-queued',
        status: 'reviewing',
        lifecycle: {
          status: 'running',
          isActive: true,
        },
      },
    ]);

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-running-queued' },
      body: {},
    });
    await callRouteHandler(
      branchReviewsRouter,
      'post',
      '/proj-1/branch-reviews/br-running-queued/review',
      req,
      res
    );

    expect(reviewService.reviewBranchReview).not.toHaveBeenCalled();
    expect(reviewService.events.emit).not.toHaveBeenCalledWith(
      'branch-review-reviewing',
      expect.anything()
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      alreadyRunning: true,
      id: 'queue-2',
      position: 1,
      branchReview: expect.objectContaining({
        id: 'br-running-queued',
      }),
    }));
  });

  it('passes reviewMode and policySource through on direct branch review requests', async () => {
    branchReviewService.getById
      .mockResolvedValueOnce({
        id: 'br-direct-mode',
        projectId: 'proj-1',
        branchName: 'feature/review-polish',
        baseBranch: 'main',
        status: 'active',
        reviewStatus: 'none',
        reviewError: null,
        updatedAt: '2026-02-20T12:00:00.000Z',
      })
      .mockResolvedValueOnce({
        id: 'br-direct-mode',
        projectId: 'proj-1',
        branchName: 'feature/review-polish',
        baseBranch: 'main',
        status: 'active',
        reviewStatus: 'reviewed',
        reviewError: null,
        updatedAt: '2026-02-20T12:01:00.000Z',
      });
    reviewService.reviewBranchReview.mockResolvedValueOnce({
      summary: 'Reviewed incrementally',
      reviewedAt: '2026-02-20T12:01:00.000Z',
    });

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-direct-mode' },
      body: { reviewMode: 'full', policySource: 'working_tree' },
    });
    await callRouteHandler(
      branchReviewsRouter,
      'post',
      '/proj-1/branch-reviews/br-direct-mode/review',
      req,
      res
    );

    expect(reviewService.reviewBranchReview).toHaveBeenCalledWith('/tmp/project', 'br-direct-mode', expect.objectContaining({
      force: true,
      reviewMode: 'full',
      policySource: 'working_tree',
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      review: expect.objectContaining({
        summary: 'Reviewed incrementally',
      }),
    }));
  });

  it('clears persisted snapshot before direct full branch rereview when requested', async () => {
    branchReviewService.getById
      .mockResolvedValueOnce(buildBranchReviewActionSnapshot({
        id: 'br-reset-direct',
        reviewStatus: 'reviewed',
        reviewSummary: 'Previous review summary',
        reviewJson: { summary: 'Previous review summary' },
        reviewHeadSha: 'head-ok',
        reviewedAt: '2026-02-20T10:00:00.000Z',
      }))
      .mockResolvedValueOnce(buildBranchReviewActionSnapshot({
        id: 'br-reset-direct',
        reviewStatus: 'reviewed',
        reviewSummary: 'Fresh review summary',
        reviewJson: { summary: 'Fresh review summary' },
        reviewHeadSha: 'head-ok',
        reviewedAt: '2026-02-20T12:01:00.000Z',
      }));
    branchReviewService.updateReview.mockResolvedValueOnce(buildBranchReviewActionSnapshot({
      id: 'br-reset-direct',
      reviewStatus: 'none',
      reviewSummary: null,
      reviewJson: null,
      reviewHeadSha: null,
      reviewedAt: null,
    }));
    reviewService.reviewBranchReview.mockResolvedValueOnce({
      summary: 'Fresh review summary',
      reviewedAt: '2026-02-20T12:01:00.000Z',
    });

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-reset-direct' },
      body: { reviewMode: 'full', resetSnapshot: 'false' },
    });
    await callRouteHandler(
      branchReviewsRouter,
      'post',
      '/proj-1/branch-reviews/br-reset-direct/review',
      req,
      res
    );

    expect(branchReviewService.updateReview).not.toHaveBeenCalledWith('br-reset-direct', expect.objectContaining({
      review_status: 'none',
    }));

    branchReviewService.getById.mockReset();
    branchReviewService.getById
      .mockResolvedValueOnce(buildBranchReviewActionSnapshot({
        id: 'br-reset-direct',
        reviewStatus: 'reviewed',
        reviewSummary: 'Previous review summary',
        reviewJson: { summary: 'Previous review summary' },
        reviewHeadSha: 'head-ok',
        reviewedAt: '2026-02-20T10:00:00.000Z',
      }))
      .mockResolvedValueOnce(buildBranchReviewActionSnapshot({
        id: 'br-reset-direct',
        reviewStatus: 'reviewed',
        reviewSummary: 'Fresh review summary',
        reviewJson: { summary: 'Fresh review summary' },
        reviewHeadSha: 'head-ok',
        reviewedAt: '2026-02-20T12:01:00.000Z',
      }));
    branchReviewService.updateReview.mockReset();
    branchReviewService.updateReview.mockResolvedValueOnce(buildBranchReviewActionSnapshot({
      id: 'br-reset-direct',
      reviewStatus: 'none',
      reviewSummary: null,
      reviewJson: null,
      reviewHeadSha: null,
      reviewedAt: null,
    }));
    reviewService.reviewBranchReview.mockResolvedValueOnce({
      summary: 'Fresh review summary',
      reviewedAt: '2026-02-20T12:01:00.000Z',
    });

    const directResetReqRes = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-reset-direct' },
      body: { reviewMode: 'full', resetSnapshot: true },
    });
    await callRouteHandler(
      branchReviewsRouter,
      'post',
      '/proj-1/branch-reviews/br-reset-direct/review',
      directResetReqRes.req,
      directResetReqRes.res
    );

    expect(branchReviewService.updateReview).toHaveBeenCalledWith('br-reset-direct', expect.objectContaining({
      review_status: 'none',
      review_summary: null,
      review_json: null,
      review_head_sha: null,
      reviewed_at: null,
    }));
    expect(reviewService.reviewBranchReview).toHaveBeenCalledWith('/tmp/project', 'br-reset-direct', expect.objectContaining({
      force: true,
      reviewMode: 'full',
    }));
  });

  it('surfaces runtime-running lifecycle while a direct branch review is in flight', async () => {
    let releaseReview;
    const reviewGate = new Promise((resolve) => {
      releaseReview = resolve;
    });

    branchReviewService.getById
      .mockResolvedValueOnce({
        id: 'br-runtime-active',
        projectId: 'proj-1',
        branchName: 'feature/review-polish',
        baseBranch: 'main',
        status: 'active',
        reviewStatus: 'reviewed',
        reviewError: null,
        reviewedAt: '2026-02-20T10:00:00.000Z',
        updatedAt: '2026-02-20T12:05:00.000Z',
      })
      .mockResolvedValueOnce({
        id: 'br-runtime-active',
        projectId: 'proj-1',
        branchName: 'feature/review-polish',
        baseBranch: 'main',
        status: 'active',
        isCurrent: true,
        reviewStatus: 'reviewed',
        reviewError: null,
        reviewedAt: '2026-02-20T10:00:00.000Z',
        updatedAt: '2026-02-20T12:05:00.000Z',
      })
      .mockResolvedValueOnce({
        id: 'br-runtime-active',
        projectId: 'proj-1',
        branchName: 'feature/review-polish',
        baseBranch: 'main',
        status: 'active',
        reviewStatus: 'reviewed',
        reviewError: null,
        reviewedAt: '2026-02-20T10:00:00.000Z',
        updatedAt: '2026-02-20T12:05:00.000Z',
      });
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-runtime-active',
        projectId: 'proj-1',
        branchName: 'feature/review-polish',
        baseBranch: 'main',
        status: 'active',
        isCurrent: true,
        reviewStatus: 'reviewed',
        reviewError: null,
        reviewedAt: '2026-02-20T10:00:00.000Z',
        updatedAt: '2026-02-20T12:05:00.000Z',
      },
    ]);
    reviewService.reviewBranchReview.mockImplementation(async () => {
      await reviewGate;
      return {
        summary: 'Review complete',
        riskLevel: 'medium',
        reviewedAt: '2026-02-20T12:06:00.000Z',
      };
    });

    const reviewReqRes = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-runtime-active' },
      body: {},
    });
    const inFlightReview = callRouteHandler(
      branchReviewsRouter,
      'post',
      '/proj-1/branch-reviews/br-runtime-active/review',
      reviewReqRes.req,
      reviewReqRes.res
    );

    await Promise.resolve();

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1' },
    });
    await callRouteHandler(
      branchReviewsRouter,
      'get',
      '/proj-1/branch-reviews',
      req,
      res
    );

    const payload = res.json.mock.calls.at(-1)?.[0];
    expect(payload?.branchReviews).toEqual([
      expect.objectContaining({
        id: 'br-runtime-active',
        reviewStatus: 'reviewing',
        reviewLifecycle: expect.objectContaining({
          status: 'running',
          isActive: true,
        }),
      }),
    ]);

    releaseReview();
    await inFlightReview;
  });

  it('returns alreadyRunning when a direct branch review is already in flight', async () => {
    let releaseReview;
    const reviewGate = new Promise((resolve) => {
      releaseReview = resolve;
    });

    branchReviewService.getById
      .mockResolvedValueOnce({
        id: 'br-runtime-queue-guard',
        projectId: 'proj-1',
        branchName: 'feature/review-polish',
        baseBranch: 'main',
        status: 'active',
        reviewStatus: 'reviewed',
        reviewError: null,
        reviewedAt: '2026-02-20T10:00:00.000Z',
        updatedAt: '2026-02-20T12:05:00.000Z',
      })
      .mockResolvedValueOnce({
        id: 'br-runtime-queue-guard',
        projectId: 'proj-1',
        branchName: 'feature/review-polish',
        baseBranch: 'main',
        status: 'active',
        reviewStatus: 'reviewed',
        reviewError: null,
        reviewedAt: '2026-02-20T10:00:00.000Z',
        updatedAt: '2026-02-20T12:05:00.000Z',
      })
      .mockResolvedValueOnce({
        id: 'br-runtime-queue-guard',
        projectId: 'proj-1',
        branchName: 'feature/review-polish',
        baseBranch: 'main',
        status: 'active',
        reviewStatus: 'reviewed',
        reviewError: null,
        reviewedAt: '2026-02-20T10:00:00.000Z',
        updatedAt: '2026-02-20T12:05:00.000Z',
      });
    reviewService.reviewBranchReview.mockImplementation(async () => {
      await reviewGate;
      return {
        summary: 'Review complete',
        riskLevel: 'medium',
        reviewedAt: '2026-02-20T12:06:00.000Z',
      };
    });

    const reviewReqRes = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-runtime-queue-guard' },
      body: {},
    });
    const inFlightReview = callRouteHandler(
      branchReviewsRouter,
      'post',
      '/proj-1/branch-reviews/br-runtime-queue-guard/review',
      reviewReqRes.req,
      reviewReqRes.res
    );

    await Promise.resolve();

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-runtime-queue-guard' },
      body: {},
    });
    await callRouteHandler(
      branchReviewsRouter,
      'post',
      '/proj-1/branch-reviews/br-runtime-queue-guard/review/queue',
      req,
      res
    );

    expect(reviewService.enqueueBranchReview).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      alreadyRunning: true,
      id: null,
      position: null,
      branchReview: expect.objectContaining({
        id: 'br-runtime-queue-guard',
        reviewStatus: 'reviewing',
        reviewLifecycle: expect.objectContaining({
          status: 'running',
          isActive: true,
        }),
      }),
    }));

    releaseReview();
    await inFlightReview;
  });

  it('returns alreadyRunning for queue-started branch reviews that are already running', async () => {
    branchReviewService.getById.mockResolvedValueOnce({
      id: 'br-runtime-queue-worker',
      projectId: 'proj-1',
      branchName: 'feature/review-polish',
      baseBranch: 'main',
      status: 'active',
      reviewStatus: 'reviewing',
      reviewError: null,
      reviewedAt: '2026-02-20T10:00:00.000Z',
      updatedAt: '2026-02-20T12:05:00.000Z',
    });
    reviewService.getActiveBranchReviewRun.mockImplementation((branchReviewId) => (
      branchReviewId === 'br-runtime-queue-worker'
        ? {
      branchReviewId: 'br-runtime-queue-worker',
      projectId: 'proj-1',
      queueId: 'queue-runtime-1',
      position: 1,
      source: 'queue',
      progress: {
        phase: 'reviewing',
        updatedAt: '2026-02-20T12:05:10.000Z',
      },
    }
        : null
    ));

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-runtime-queue-worker' },
      body: {},
    });
    await callRouteHandler(
      branchReviewsRouter,
      'post',
      '/proj-1/branch-reviews/br-runtime-queue-worker/review/queue',
      req,
      res
    );

    expect(reviewService.enqueueBranchReview).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      alreadyRunning: true,
      id: 'queue-runtime-1',
      position: 1,
      branchReview: expect.objectContaining({
        id: 'br-runtime-queue-worker',
        reviewStatus: 'reviewing',
        reviewLifecycle: expect.objectContaining({
          status: 'running',
          isActive: true,
        }),
      }),
    }));
  });

  it('stops a direct runtime branch review started outside the queue', async () => {
    branchReviewService.getById.mockResolvedValueOnce({
      id: 'br-runtime-direct-stop',
      projectId: 'proj-1',
      branchName: 'feature/review-polish',
      baseBranch: 'main',
      status: 'active',
      reviewStatus: 'reviewing',
      reviewError: null,
      updatedAt: '2026-02-20T12:05:00.000Z',
    });
    reviewService.getActiveBranchReviewRun.mockReturnValueOnce({
      branchReviewId: 'br-runtime-direct-stop',
      projectId: 'proj-1',
      queueId: null,
      position: null,
      source: 'direct',
      progress: {
        phase: 'running',
        updatedAt: '2026-02-20T12:05:10.000Z',
      },
    });
    reviewService.stopActiveBranchReviewRun.mockReturnValueOnce({ stopped: true, was: 'running' });

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-runtime-direct-stop' },
    });
    await callRouteHandler(
      branchReviewsRouter,
      'delete',
      '/proj-1/branch-reviews/br-runtime-direct-stop/review/queue',
      req,
      res
    );

    expect(reviewService.stopReview).not.toHaveBeenCalled();
    expect(reviewService.stopActiveBranchReviewRun).toHaveBeenCalledWith('br-runtime-direct-stop');
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      stopped: true,
      was: 'running',
    });
  });

  it('stops the running branch review before a queued follow-up', async () => {
    reviewService.getQueueStatus.mockReturnValueOnce([
      {
        id: 'queue-follow-up',
        type: 'branch_review',
        branchReviewId: 'br-running-with-follow-up',
        status: 'queued',
        lifecycle: {
          status: 'queued',
          isActive: true,
        },
      },
      {
        id: 'queue-running',
        type: 'branch_review',
        branchReviewId: 'br-running-with-follow-up',
        status: 'reviewing',
        lifecycle: {
          status: 'running',
          isActive: true,
        },
      },
    ]);
    reviewService.stopReview.mockReturnValueOnce({ stopped: true, was: 'running' });

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-running-with-follow-up' },
    });
    await callRouteHandler(
      branchReviewsRouter,
      'delete',
      '/proj-1/branch-reviews/br-running-with-follow-up/review/queue',
      req,
      res
    );

    expect(reviewService.stopReview).toHaveBeenCalledWith('queue-running');
    expect(reviewService.stopReview).not.toHaveBeenCalledWith('queue-follow-up');
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      stopped: true,
      was: 'running',
    });
  });

  it('allows retries when persisted review state is non-terminal but no active queue or runtime exists', async () => {
    branchReviewService.getById
      .mockResolvedValueOnce({
        id: 'br-stale-persisted-active',
        projectId: 'proj-1',
        branchName: 'feature/review-polish',
        baseBranch: 'main',
        status: 'active',
        reviewStatus: 'reviewing',
        reviewError: null,
        reviewedAt: '2026-02-20T10:00:00.000Z',
        updatedAt: '2026-02-20T12:05:00.000Z',
      })
      .mockResolvedValueOnce({
        id: 'br-stale-persisted-active',
        projectId: 'proj-1',
        branchName: 'feature/review-polish',
        baseBranch: 'main',
        status: 'active',
        reviewStatus: 'queued',
        reviewError: null,
        reviewedAt: '2026-02-20T10:00:00.000Z',
        updatedAt: '2026-02-20T12:05:00.000Z',
      });
    reviewService.enqueueBranchReview.mockReturnValueOnce({
      id: 'queue-stale-retry',
      position: 1,
    });
    reviewService.reviewBranchReview.mockResolvedValueOnce({
      summary: 'Review complete',
      riskLevel: 'medium',
      reviewedAt: '2026-02-20T12:06:00.000Z',
    });

    const queueReqRes = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-stale-persisted-active' },
      body: {},
    });
    await callRouteHandler(
      branchReviewsRouter,
      'post',
      '/proj-1/branch-reviews/br-stale-persisted-active/review/queue',
      queueReqRes.req,
      queueReqRes.res
    );

    expect(reviewService.enqueueBranchReview).toHaveBeenCalledWith(
      '/tmp/project',
      'br-stale-persisted-active',
      expect.objectContaining({ projectId: 'proj-1', scope: undefined })
    );
    expect(queueReqRes.res.json).toHaveBeenCalledWith({
      success: true,
      position: 1,
      id: 'queue-stale-retry',
    });

    const reviewReqRes = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-stale-persisted-active' },
      body: {},
    });
    await callRouteHandler(
      branchReviewsRouter,
      'post',
      '/proj-1/branch-reviews/br-stale-persisted-active/review',
      reviewReqRes.req,
      reviewReqRes.res
    );

    expect(reviewService.reviewBranchReview).toHaveBeenCalledWith(
      '/tmp/project',
      'br-stale-persisted-active',
      expect.objectContaining({
        force: true,
        scope: undefined,
        onHeartbeat: expect.any(Function),
        onProgressCheckpoint: expect.any(Function),
      })
    );
    expect(reviewReqRes.res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      review: expect.objectContaining({
        summary: 'Review complete',
        riskLevel: 'medium',
      }),
    }));
  });

  it('clears the AI review snapshot for an inactive branch review and keeps the branch review row', async () => {
    branchReviewService.getById.mockResolvedValueOnce({
      id: 'br-delete-idle',
      projectId: 'proj-1',
      branchName: 'feature/review-polish',
      baseBranch: 'main',
      status: 'active',
      reviewStatus: 'reviewed',
      reviewError: null,
      updatedAt: '2026-02-20T12:00:00.000Z',
    });

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-delete-idle' },
    });
    await callRouteHandler(
      branchReviewsRouter,
      'delete',
      '/proj-1/branch-reviews/br-delete-idle',
      req,
      res
    );

    expect(reviewService.stopReview).not.toHaveBeenCalled();
    expect(reviewService.clearActiveBranchReviewRun).toHaveBeenCalledWith('br-delete-idle');
    expect(reviewFixRunStore.deleteRuns).toHaveBeenCalledWith({
      projectId: 'proj-1',
      reviewType: 'branch_review',
      reviewId: 'br-delete-idle',
    });
    expect(branchReviewService.updateReview).toHaveBeenCalledWith('br-delete-idle', expect.objectContaining({
      review_status: 'none',
      review_summary: null,
      review_json: null,
      review_head_sha: null,
      reviewed_at: null,
    }));
    expect(branchReviewService.deleteBranchReview).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      deleted: true,
      stopped: { stopped: false, was: null },
      branchReview: expect.objectContaining({
        id: 'br-delete-idle',
      }),
    }));
  });

  it('blocks branch review reset on non-desktop production servers', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.ATLAS_DESKTOP_MODE;

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-delete-prod' },
    });
    await callRouteHandler(
      branchReviewsRouter,
      'delete',
      '/proj-1/branch-reviews/br-delete-prod',
      req,
      res
    );

    expect(branchReviewService.getById).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Branch review reset is only available in local and desktop environments.',
    });
  });

  it('allows branch review reset in desktop mode even when NODE_ENV is production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.ATLAS_DESKTOP_MODE = 'true';

    branchReviewService.getById.mockResolvedValueOnce({
      id: 'br-delete-desktop',
      projectId: 'proj-1',
      branchName: 'feature/review-polish',
      baseBranch: 'main',
      status: 'active',
      reviewStatus: 'reviewed',
      reviewError: null,
      updatedAt: '2026-02-20T12:00:00.000Z',
    });

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-delete-desktop' },
    });
    await callRouteHandler(
      branchReviewsRouter,
      'delete',
      '/proj-1/branch-reviews/br-delete-desktop',
      req,
      res
    );

    expect(branchReviewService.updateReview).toHaveBeenCalledWith('br-delete-desktop', expect.objectContaining({
      review_status: 'none',
      review_summary: null,
      review_json: null,
      review_head_sha: null,
      reviewed_at: null,
    }));
    expect(reviewFixRunStore.deleteRuns).toHaveBeenCalledWith({
      projectId: 'proj-1',
      reviewType: 'branch_review',
      reviewId: 'br-delete-desktop',
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      branchReview: expect.objectContaining({
        id: 'br-delete-desktop',
      }),
    }));
  });

  it('stops queued branch review work before clearing the AI review snapshot', async () => {
    branchReviewService.getById.mockResolvedValueOnce({
      id: 'br-delete-queued',
      projectId: 'proj-1',
      branchName: 'feature/review-polish',
      baseBranch: 'main',
      status: 'active',
      reviewStatus: 'queued',
      reviewError: null,
      updatedAt: '2026-02-20T12:00:00.000Z',
    });
    reviewService.getQueueStatus.mockReturnValueOnce([
      {
        id: 'queue-delete-1',
        type: 'branch_review',
        branchReviewId: 'br-delete-queued',
        status: 'queued',
        lifecycle: {
          status: 'queued',
          isActive: true,
        },
      },
    ]);
    reviewService.stopReview.mockReturnValueOnce({ stopped: true, was: 'queued' });

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-delete-queued' },
    });
    await callRouteHandler(
      branchReviewsRouter,
      'delete',
      '/proj-1/branch-reviews/br-delete-queued',
      req,
      res
    );

    expect(reviewService.stopReview).toHaveBeenCalledWith('queue-delete-1');
    expect(reviewFixRunStore.deleteRuns).toHaveBeenCalledWith({
      projectId: 'proj-1',
      reviewType: 'branch_review',
      reviewId: 'br-delete-queued',
    });
    expect(branchReviewService.updateReview).toHaveBeenCalledWith('br-delete-queued', expect.objectContaining({
      review_status: 'none',
      review_summary: null,
      review_json: null,
      review_head_sha: null,
      reviewed_at: null,
    }));
    expect(branchReviewService.deleteBranchReview).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      deleted: true,
      stopped: { stopped: true, was: 'queued' },
      branchReview: expect.objectContaining({
        id: 'br-delete-queued',
      }),
    }));
  });
});

describe('Branch review base branch updates', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBranchReviewRouteTestState();
    getProjectById.mockReset();
    updateProject.mockReset();
    branchReviewService.getByProject.mockReset();
    branchReviewService.collapseDuplicateTrackedReviews.mockReset();
    branchReviewService.updateReview.mockReset();
    gitService.listWorktrees.mockReset();
    gitService.listWorktrees.mockResolvedValue([]);
    gitService.refExists.mockReset();
    gitWatcherService.isWatching.mockReset();
    gitWatcherService.updateBaseBranch.mockReset();
    gitWatcherService.syncNow.mockReset();
    gitWatcherService.syncNow.mockResolvedValue(true);
    workspaceReviewService.list.mockReset();
    workspaceReviewService.list.mockResolvedValue([]);
    reviewService.getQueueStatus.mockReset();
    reviewService.getQueueStatus.mockReturnValue([]);
    reviewService.getActiveBranchReviewRun.mockReset();
    reviewService.getActiveBranchReviewRun.mockReturnValue(null);
    gitService.getRefSha.mockReset();
    gitService.getRefSha.mockResolvedValue('head-new');
    branchReviewService.updateReview.mockImplementation(async (id, updates) => ({
      id,
      projectId: 'proj-1',
      branchName: 'feature/topic',
      status: updates.status || 'active',
      isCurrent: updates.is_current === 0 ? false : true,
      baseBranch: updates.base_branch || 'main',
      baseBranchSource: updates.base_branch_source || 'inferred',
      mergeBaseSha: updates.merge_base_sha || null,
      headSha: updates.head_sha || null,
      fileCount: updates.file_count ?? null,
      totalAdditions: updates.total_additions ?? null,
      totalDeletions: updates.total_deletions ?? null,
      commitCount: updates.commit_count ?? null,
      firstCommitAt: updates.first_commit_at ?? null,
      lastCommitAt: updates.last_commit_at ?? null,
    }));
  });

  it('reconciles and returns the updated review snapshot after a per-review base change', async () => {
    getProjectById.mockResolvedValue({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: '/tmp/repo',
      base_branch_display: 'main',
    });
    branchReviewService.getById.mockResolvedValue({
      id: 'br-1',
      projectId: 'proj-1',
      branchName: 'feature/topic',
      baseBranch: 'main',
      baseBranchSource: 'inferred',
      status: 'active',
      isCurrent: true,
      mergeBaseSha: 'merge-old',
      headSha: 'head-old',
      fileCount: 2,
      totalAdditions: 8,
      totalDeletions: 1,
    });
    gitService.refExists.mockImplementation(async (_projectPath, ref) => (
      ref === 'refs/heads/develop'
        || ref === 'refs/heads/feature/topic'
    ));
    gitService.getRemoteDefaultBranch.mockResolvedValue('main');
    gitService.getMergeBase.mockResolvedValue('merge-new');
    gitService.getRefSha.mockResolvedValue('head-new');
    gitService.getThreeDotDiffStats.mockResolvedValue({
      fileCount: 7,
      totalAdditions: 21,
      totalDeletions: 5,
    });

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1', brId: 'br-1' },
      body: { baseBranch: 'develop', pin: true },
    });

    await callRouteHandler(
      branchReviewsRouter,
      'patch',
      '/proj-1/branch-reviews/br-1/base-branch',
      req,
      res
    );

    expect(branchReviewService.updateReview.mock.calls).toEqual(expect.arrayContaining([
      ['br-1', expect.objectContaining({
        base_branch: 'develop',
        base_branch_source: 'pinned',
      })],
      ['br-1', expect.objectContaining({
        base_branch: 'develop',
        merge_base_sha: 'merge-new',
        head_sha: 'head-new',
        file_count: 7,
        total_additions: 21,
        total_deletions: 5,
      })],
    ]));
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      branchReview: expect.objectContaining({
        id: 'br-1',
        baseBranch: 'develop',
        mergeBaseSha: 'merge-new',
        headSha: 'head-new',
        fileCount: 7,
        totalAdditions: 21,
        totalDeletions: 5,
        reviewLifecycle: expect.objectContaining({
          isTerminal: true,
        }),
      }),
    });
    expect(reviewService.events.emit).toHaveBeenCalledWith('branch-review-update', {
      projectId: 'proj-1',
      type: 'updated',
      branchReview: expect.objectContaining({
        id: 'br-1',
        fileCount: 7,
      }),
    });
  });

  it('syncs the watcher immediately after changing the project base branch', async () => {
    getProjectById.mockResolvedValue({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: '/tmp/repo',
      base_branch_display: 'main',
    });
    gitService.refExists.mockResolvedValue(true);
    gitWatcherService.isWatching.mockReturnValue(true);

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1' },
      body: { baseBranch: 'develop' },
    });

    await callRouteHandler(
      branchReviewsRouter,
      'patch',
      '/proj-1/base-branch',
      req,
      res
    );
    await flushBackgroundReconciliation();

    expect(updateProject).toHaveBeenCalledWith('proj-1', {
      base_branch_display: 'develop',
      base_branch_ref: 'refs/heads/develop',
    });
    expect(gitWatcherService.updateBaseBranch).toHaveBeenCalledWith('proj-1', 'develop');
    expect(gitWatcherService.syncNow).toHaveBeenCalledWith('proj-1');
    expect(res.setHeader).toHaveBeenCalledWith(
      'Server-Timing',
      expect.stringContaining('reconcile_active_reviews;dur=')
    );
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      baseBranchDisplay: 'develop',
      baseBranchRef: 'refs/heads/develop',
    });
  });

  it('rejects base-branch changes while the current branch review is running', async () => {
    getProjectById.mockResolvedValue({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: '/tmp/repo',
      base_branch_display: 'main',
    });
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-1',
        projectId: 'proj-1',
        branchName: 'feature/topic',
        baseBranch: 'main',
        status: 'active',
      },
    ]);
    reviewService.getActiveBranchReviewRun.mockReturnValue({
      branchReviewId: 'br-1',
      updatedAt: '2026-04-15T08:00:00.000Z',
      progress: { phase: 'running' },
    });

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1' },
      body: { baseBranch: 'develop' },
    });

    await callRouteHandler(
      branchReviewsRouter,
      'patch',
      '/proj-1/base-branch',
      req,
      res
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Base branch cannot change while the current branch review is queued or running.',
      code: 'review_active',
      reviewType: 'branch_review',
      reviewId: 'br-1',
    });
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('rejects base-branch changes while the workspace review is queued', async () => {
    getProjectById.mockResolvedValue({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: '/tmp/repo',
      base_branch_display: 'main',
    });
    branchReviewService.getByProject.mockResolvedValue([]);
    workspaceReviewService.list.mockResolvedValue([
      {
        id: 'wr-current',
        projectId: 'proj-1',
      },
    ]);
    reviewService.getQueueStatus.mockReturnValue([
      {
        type: 'workspace_review',
        workspaceReviewId: 'wr-current',
        lifecycle: {
          isActive: true,
        },
      },
    ]);

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1' },
      body: { baseBranch: 'develop' },
    });

    await callRouteHandler(
      branchReviewsRouter,
      'patch',
      '/proj-1/base-branch',
      req,
      res
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Base branch cannot change while the workspace review is queued or running.',
      code: 'review_active',
      reviewType: 'workspace_review',
      reviewId: 'wr-current',
    });
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('reconciles persisted branch reviews when no watcher is active', async () => {
    getProjectById.mockResolvedValue({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: '/tmp/repo',
      base_branch_display: 'main',
    });
    gitService.refExists.mockResolvedValue(true);
    gitWatcherService.isWatching.mockReturnValue(false);
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-1',
        projectId: 'proj-1',
        branchName: 'feature/topic',
        baseBranch: 'main',
        status: 'active',
        isCurrent: true,
        reviewStatus: 'reviewed',
        mergeBaseSha: 'merge-old',
        headSha: 'head-old',
        fileCount: 4,
        totalAdditions: 10,
        totalDeletions: 2,
        commitCount: 2,
        firstCommitAt: '2026-02-20T10:00:00.000Z',
        lastCommitAt: '2026-02-20T12:00:00.000Z',
      },
    ]);
    branchReviewService.collapseDuplicateTrackedReviews.mockResolvedValue({ reviews: [] });
    gitService.getRemoteDefaultBranch.mockResolvedValue('main');
    gitService.getCurrentBranchName.mockResolvedValue('feature/topic');
    gitService.getMergeBase.mockResolvedValue('merge-new');
    gitService.getThreeDotDiffStats.mockResolvedValue({
      fileCount: 7,
      totalAdditions: 21,
      totalDeletions: 5,
    });
    gitService.getCommitsBetween.mockResolvedValue([
      { hash: 'head-new', date: '2026-02-21T12:00:00.000Z' },
      { hash: 'base-commit', date: '2026-02-20T10:00:00.000Z' },
    ]);

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1' },
      body: { baseBranch: 'develop' },
    });

    await callRouteHandler(
      branchReviewsRouter,
      'patch',
      '/proj-1/base-branch',
      req,
      res
    );
    await flushBackgroundReconciliation();

    expect(branchReviewService.getByProject).toHaveBeenCalledWith('proj-1');
    expect(branchReviewService.updateReview.mock.calls).toEqual(expect.arrayContaining([
      ['br-1', expect.objectContaining({ base_branch: 'develop' })],
      ['br-1', expect.objectContaining({
        merge_base_sha: 'merge-new',
        head_sha: 'head-new',
        file_count: 7,
        total_additions: 21,
        total_deletions: 5,
      })],
    ]));
    expect(gitService.getCommitsBetween).toHaveBeenCalledWith('/tmp/repo', 'merge-new', 'head-new');
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      baseBranchDisplay: 'develop',
      baseBranchRef: 'refs/heads/develop',
    });
  });

  it('falls back to direct reconciliation when watcher sync fails after a base branch change', async () => {
    getProjectById.mockResolvedValue({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: '/tmp/repo',
      base_branch_display: 'main',
    });
    gitService.refExists.mockResolvedValue(true);
    gitWatcherService.isWatching.mockReturnValue(true);
    gitWatcherService.syncNow.mockRejectedValue(new Error('sync failed'));
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-1',
        projectId: 'proj-1',
        branchName: 'feature/topic',
        baseBranch: 'main',
        status: 'active',
        isCurrent: true,
        reviewStatus: 'reviewed',
        mergeBaseSha: 'merge-old',
        headSha: 'head-old',
        fileCount: 4,
        totalAdditions: 10,
        totalDeletions: 2,
        commitCount: 2,
      },
    ]);
    branchReviewService.collapseDuplicateTrackedReviews.mockResolvedValue({ reviews: [] });
    gitService.getRemoteDefaultBranch.mockResolvedValue('main');
    gitService.getMergeBase.mockResolvedValue('merge-new');
    gitService.getThreeDotDiffStats.mockResolvedValue({
      fileCount: 7,
      totalAdditions: 21,
      totalDeletions: 5,
    });
    gitService.getCommitsBetween.mockResolvedValue([
      { hash: 'head-new', date: '2026-02-21T12:00:00.000Z' },
      { hash: 'base-commit', date: '2026-02-20T10:00:00.000Z' },
    ]);

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1' },
      body: { baseBranch: 'develop' },
    });

    await callRouteHandler(
      branchReviewsRouter,
      'patch',
      '/proj-1/base-branch',
      req,
      res
    );
    await flushBackgroundReconciliation();

    expect(gitWatcherService.syncNow).toHaveBeenCalledWith('proj-1');
    expect(branchReviewService.getByProject).toHaveBeenCalledWith('proj-1');
    expect(branchReviewService.updateReview.mock.calls).toEqual(expect.arrayContaining([
      ['br-1', expect.objectContaining({ base_branch: 'develop' })],
      ['br-1', expect.objectContaining({
        merge_base_sha: 'merge-new',
        head_sha: 'head-new',
        file_count: 7,
        total_additions: 21,
        total_deletions: 5,
      })],
    ]));
    expect(gitService.getCommitsBetween).toHaveBeenCalledWith('/tmp/repo', 'merge-new', 'head-new');
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      baseBranchDisplay: 'develop',
      baseBranchRef: 'refs/heads/develop',
    });
  });

  it('reconciles active branch reviews even when watcher sync succeeds', async () => {
    getProjectById.mockResolvedValue({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: '/tmp/repo',
      base_branch_display: 'main',
    });
    gitService.refExists.mockResolvedValue(true);
    gitWatcherService.isWatching.mockReturnValue(true);
    gitWatcherService.syncNow.mockResolvedValue(true);
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-1',
        projectId: 'proj-1',
        branchName: 'feature/topic',
        baseBranch: 'main',
        status: 'active',
        isCurrent: true,
        reviewStatus: 'reviewed',
        mergeBaseSha: 'merge-old',
        headSha: 'head-old',
        fileCount: 4,
        totalAdditions: 10,
        totalDeletions: 2,
        commitCount: 2,
      },
    ]);
    branchReviewService.collapseDuplicateTrackedReviews.mockResolvedValue({ reviews: [] });
    gitService.getRemoteDefaultBranch.mockResolvedValue('main');
    gitService.getMergeBase.mockResolvedValue('merge-new');
    gitService.getThreeDotDiffStats.mockResolvedValue({
      fileCount: 7,
      totalAdditions: 21,
      totalDeletions: 5,
    });
    gitService.getCommitsBetween.mockResolvedValue([
      { hash: 'head-new', date: '2026-02-21T12:00:00.000Z' },
      { hash: 'base-commit', date: '2026-02-20T10:00:00.000Z' },
    ]);

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1' },
      body: { baseBranch: 'develop' },
    });

    await callRouteHandler(
      branchReviewsRouter,
      'patch',
      '/proj-1/base-branch',
      req,
      res
    );
    await flushBackgroundReconciliation();

    expect(gitWatcherService.syncNow).toHaveBeenCalledWith('proj-1');
    expect(branchReviewService.getByProject).toHaveBeenCalledWith('proj-1');
    expect(branchReviewService.updateReview.mock.calls).toEqual(expect.arrayContaining([
      ['br-1', expect.objectContaining({ base_branch: 'develop' })],
      ['br-1', expect.objectContaining({
        merge_base_sha: 'merge-new',
        head_sha: 'head-new',
        file_count: 7,
        total_additions: 21,
        total_deletions: 5,
      })],
    ]));
    expect(gitService.getCommitsBetween).toHaveBeenCalledWith('/tmp/repo', 'merge-new', 'head-new');
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      baseBranchDisplay: 'develop',
      baseBranchRef: 'refs/heads/develop',
    });
  });

  it('does not wait for commit-history backfill before returning a base-branch update response', async () => {
    getProjectById.mockResolvedValue({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: '/tmp/repo',
      base_branch_display: 'main',
    });
    gitService.refExists.mockResolvedValue(true);
    gitWatcherService.isWatching.mockReturnValue(false);
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-1',
        projectId: 'proj-1',
        branchName: 'feature/topic',
        baseBranch: 'main',
        status: 'active',
        isCurrent: true,
        reviewStatus: 'reviewed',
        mergeBaseSha: 'merge-old',
        headSha: 'head-old',
        fileCount: 4,
        totalAdditions: 10,
        totalDeletions: 2,
        commitCount: 2,
      },
    ]);
    branchReviewService.collapseDuplicateTrackedReviews.mockResolvedValue({ reviews: [] });
    gitService.getRemoteDefaultBranch.mockResolvedValue('main');
    gitService.getMergeBase.mockResolvedValue('merge-new');
    gitService.getThreeDotDiffStats.mockResolvedValue({
      fileCount: 7,
      totalAdditions: 21,
      totalDeletions: 5,
    });
    gitService.getCommitsBetween.mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve([
        { hash: 'head-new', date: '2026-02-21T12:00:00.000Z' },
        { hash: 'base-commit', date: '2026-02-20T10:00:00.000Z' },
      ]), 250))
    );

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1' },
      body: { baseBranch: 'develop' },
    });

    await Promise.race([
      callRouteHandler(
        branchReviewsRouter,
        'patch',
        '/proj-1/base-branch',
        req,
        res
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out waiting for base-branch response')), 100)),
    ]);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      baseBranchDisplay: 'develop',
      baseBranchRef: 'refs/heads/develop',
    });
  });

  it('does not wait for diff-stat recomputation when the base change keeps the same merge-base and head', async () => {
    getProjectById.mockResolvedValue({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: '/tmp/repo',
      base_branch_display: 'development',
    });
    gitService.refExists.mockResolvedValue(true);
    gitWatcherService.isWatching.mockReturnValue(false);
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-same-merge-base',
        projectId: 'proj-1',
        branchName: 'feature/topic',
        baseBranch: 'development',
        status: 'active',
        isCurrent: true,
        mergeBaseSha: 'merge-same',
        headSha: 'head-same',
        fileCount: 142,
        totalAdditions: 327480,
        totalDeletions: 5067,
      },
    ]);
    branchReviewService.collapseDuplicateTrackedReviews.mockResolvedValue({ reviews: [] });
    gitService.getRemoteDefaultBranch.mockResolvedValue('main');
    gitService.getRefSha.mockResolvedValue('head-same');
    gitService.getMergeBase.mockResolvedValue('merge-same');
    gitService.getThreeDotDiffStats.mockImplementation(() => new Promise(() => {}));

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1' },
      body: { baseBranch: 'LevelDesign/BlockoutMap' },
    });

    await Promise.race([
      callRouteHandler(
        branchReviewsRouter,
        'patch',
        '/proj-1/base-branch',
        req,
        res
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out waiting for merge-base short-circuit response')), 100)),
    ]);

    expect(gitService.getThreeDotDiffStats).not.toHaveBeenCalled();
    expect(branchReviewService.updateReview).toHaveBeenCalledWith('br-same-merge-base', {
      base_branch: 'LevelDesign/BlockoutMap',
    });
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      baseBranchDisplay: 'LevelDesign/BlockoutMap',
      baseBranchRef: 'refs/heads/LevelDesign/BlockoutMap',
    });
  });

  it('does not re-infer ancestry for an explicit base-branch change', async () => {
    getProjectById.mockResolvedValue({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: '/tmp/repo',
      base_branch_display: 'development',
    });
    gitService.refExists.mockResolvedValue(true);
    gitWatcherService.isWatching.mockReturnValue(false);
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-explicit-base',
        projectId: 'proj-1',
        branchName: 'feature/topic',
        baseBranch: 'development',
        status: 'active',
        isCurrent: true,
        mergeBaseSha: 'merge-same',
        headSha: 'head-same',
        fileCount: 142,
        totalAdditions: 327480,
        totalDeletions: 5067,
      },
    ]);
    branchReviewService.collapseDuplicateTrackedReviews.mockResolvedValue({ reviews: [] });
    gitService.getRemoteDefaultBranch.mockResolvedValue('main');
    gitService.getRefSha.mockResolvedValue('head-same');
    gitService.getMergeBase.mockResolvedValue('merge-same');
    gitService.inferBaseBranch.mockImplementation(() => new Promise(() => {}));
    gitService.getThreeDotDiffStats.mockImplementation(() => new Promise(() => {}));

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1' },
      body: { baseBranch: 'LevelDesign/BlockoutMap' },
    });

    await Promise.race([
      callRouteHandler(
        branchReviewsRouter,
        'patch',
        '/proj-1/base-branch',
        req,
        res
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timed out waiting for explicit base-branch response')), 100)),
    ]);

    expect(gitService.inferBaseBranch).not.toHaveBeenCalled();
    expect(gitService.getThreeDotDiffStats).not.toHaveBeenCalled();
    expect(branchReviewService.updateReview).toHaveBeenCalledWith('br-explicit-base', {
      base_branch: 'LevelDesign/BlockoutMap',
    });
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      baseBranchDisplay: 'LevelDesign/BlockoutMap',
      baseBranchRef: 'refs/heads/LevelDesign/BlockoutMap',
    });
  });

  it('clears persisted review snapshot fields when the fast-path base change leaves the current review at zero diff', async () => {
    getProjectById.mockResolvedValue({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: '/tmp/repo',
      base_branch_display: 'main',
    });
    gitService.refExists.mockResolvedValue(true);
    gitWatcherService.isWatching.mockReturnValue(false);
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-zero',
        projectId: 'proj-1',
        branchName: 'feature/topic',
        baseBranch: 'main',
        status: 'active',
        isCurrent: true,
        reviewStatus: 'reviewed',
        reviewSummary: 'stale summary',
        reviewJson: { findings: [{ title: 'stale finding' }] },
        reviewHeadSha: 'review-head-old',
        mergeBaseSha: 'merge-old',
        headSha: 'head-old',
        fileCount: 4,
        totalAdditions: 10,
        totalDeletions: 2,
      },
    ]);
    branchReviewService.collapseDuplicateTrackedReviews.mockResolvedValue({ reviews: [] });
    gitService.getRemoteDefaultBranch.mockResolvedValue('main');
    gitService.getMergeBase.mockResolvedValue('merge-new');
    gitService.getThreeDotDiffStats.mockResolvedValue({
      fileCount: 0,
      totalAdditions: 0,
      totalDeletions: 0,
    });

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1' },
      body: { baseBranch: 'develop' },
    });

    await callRouteHandler(
      branchReviewsRouter,
      'patch',
      '/proj-1/base-branch',
      req,
      res
    );

    expect(branchReviewService.updateReview).toHaveBeenCalledWith('br-zero', expect.objectContaining({
      status: 'active',
      file_count: 0,
      review_status: 'none',
      review_summary: null,
      review_json: null,
      review_head_sha: null,
      reviewed_at: null,
    }));
  });

  it('fails the base-branch update when persisting the new base on an active review fails', async () => {
    getProjectById.mockResolvedValue({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: '/tmp/repo',
      base_branch_display: 'main',
    });
    gitService.refExists.mockResolvedValue(true);
    gitWatcherService.isWatching.mockReturnValue(false);
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-1',
        projectId: 'proj-1',
        branchName: 'feature/topic',
        baseBranch: 'main',
        status: 'active',
      },
    ]);
    branchReviewService.collapseDuplicateTrackedReviews.mockResolvedValue({ reviews: [] });
    branchReviewService.updateReview.mockRejectedValueOnce(new Error('write failed'));

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1' },
      body: { baseBranch: 'develop' },
    });

    await callRouteHandler(
      branchReviewsRouter,
      'patch',
      '/proj-1/base-branch',
      req,
      res
    );

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Failed to update base branch' });
  });

  it('reloads persisted review state before rolling back a failed current-review base change', async () => {
    getProjectById.mockResolvedValue({
      id: 'proj-1',
      user_id: ANONYMOUS_USER_ID,
      path: '/tmp/repo',
      base_branch_display: 'main',
      base_branch_ref: 'refs/heads/main',
    });
    gitService.refExists.mockResolvedValue(true);
    gitWatcherService.isWatching.mockReturnValue(false);
    branchReviewService.getByProject
      .mockResolvedValueOnce([
        {
          id: 'br-1',
          projectId: 'proj-1',
          branchName: 'feature/topic',
          baseBranch: 'main',
          status: 'active',
          isCurrent: true,
          mergeBaseSha: 'merge-old',
          headSha: 'head-old',
          fileCount: 4,
          totalAdditions: 10,
          totalDeletions: 2,
          commitCount: 2,
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'br-1',
          projectId: 'proj-1',
          branchName: 'feature/topic',
          baseBranch: 'develop',
          status: 'active',
          isCurrent: true,
          mergeBaseSha: 'merge-old',
          headSha: 'head-old',
          fileCount: 4,
          totalAdditions: 10,
          totalDeletions: 2,
          commitCount: 2,
        },
      ]);
    gitService.getRemoteDefaultBranch.mockResolvedValue('main');
    gitService.getMergeBase.mockResolvedValue('merge-new');
    gitService.getThreeDotDiffStats.mockResolvedValue({
      fileCount: 7,
      totalAdditions: 21,
      totalDeletions: 5,
    });
    gitService.getCommitsBetween.mockResolvedValue([
      { hash: 'head-new', date: '2026-02-21T12:00:00.000Z' },
      { hash: 'base-commit', date: '2026-02-20T10:00:00.000Z' },
    ]);
    let updateReviewCallCount = 0;
    branchReviewService.updateReview.mockImplementation(async (id, updates) => {
      updateReviewCallCount += 1;
      if (updateReviewCallCount === 2) {
        throw new Error('lifecycle failed');
      }
      return {
        id,
        projectId: 'proj-1',
        branchName: 'feature/topic',
        status: updates.status || 'active',
        isCurrent: true,
        baseBranch: updates.base_branch || 'main',
        mergeBaseSha: updates.merge_base_sha || null,
        headSha: updates.head_sha || null,
      };
    });

    const { req, res } = createMockReqRes({
      params: { projectId: 'proj-1' },
      body: { baseBranch: 'develop' },
    });

    await callRouteHandler(
      branchReviewsRouter,
      'patch',
      '/proj-1/base-branch',
      req,
      res
    );

    expect(branchReviewService.getByProject).toHaveBeenCalledTimes(2);
    expect(branchReviewService.updateReview.mock.calls).toEqual(expect.arrayContaining([
      ['br-1', expect.objectContaining({ base_branch: 'develop' })],
      ['br-1', expect.objectContaining({ base_branch: 'main' })],
    ]));
    expect(updateProject).toHaveBeenCalledWith('proj-1', {
      base_branch_display: 'develop',
      base_branch_ref: 'refs/heads/develop',
    });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Failed to update base branch' });
  });
});
