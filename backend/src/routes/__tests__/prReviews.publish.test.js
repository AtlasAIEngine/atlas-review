import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('express', () => ({
  default: {
    Router: () => {
      const stack = [];
      const router = { stack };
      for (const method of ['get', 'put', 'delete', 'post', 'patch']) {
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

vi.mock('../../db/connection.js', () => ({
  default: { query: vi.fn() },
}));

vi.mock('../../services/prReviewService.js', () => ({
  default: {
    getById: vi.fn(),
    getByProject: vi.fn(),
    upsert: vi.fn(),
    updateReview: vi.fn(),
    buildReviewParityGate: vi.fn(() => null),
  },
}));

vi.mock('../../services/reviewService.js', () => ({
  default: {
    enqueuePrReview: vi.fn(),
    getQueueStatus: vi.fn(),
    stopReview: vi.fn(),
  },
}));

vi.mock('../../services/githubService.js', () => ({
  default: {
    listPullRequests: vi.fn(),
    getPullRequestDetail: vi.fn(),
    getPullRequestReviews: vi.fn(),
    getPullRequestFiles: vi.fn(),
    getRepositoryContents: vi.fn(),
  },
}));

vi.mock('../../services/prReviewPublishService.js', () => ({
  default: {
    listPublications: vi.fn(),
    publishReview: vi.fn(),
  },
}));

vi.mock('../../services/reviewSyncService.js', () => ({
  default: {
    getGuestSessionByAuthToken: vi.fn(),
  },
}));

vi.mock('../../middleware/quotas.js', () => ({
  enforceQuotas: (req, res, next) => next(),
}));

import { getProjectById } from '../../db/queries.js';
import db from '../../db/connection.js';
import prReviewService from '../../services/prReviewService.js';
import githubService from '../../services/githubService.js';
import prReviewPublishService from '../../services/prReviewPublishService.js';
import reviewService from '../../services/reviewService.js';
import reviewSyncService from '../../services/reviewSyncService.js';
import prReviewsRouter from '../prReviews.js';

function createMockReqRes(params = {}, body = {}, user = null, headers = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), value])
  );
  const req = {
    params,
    body,
    user,
    headers: normalizedHeaders,
    get: vi.fn((name) => normalizedHeaders[String(name || '').toLowerCase()]),
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

const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

describe('PR review GitHub publication routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    reviewSyncService.getGuestSessionByAuthToken.mockResolvedValue(null);

    getProjectById.mockResolvedValue({
      id: 'proj-1',
      path: '/tmp/repo',
      user_id: ANONYMOUS_USER_ID,
      github_installation_id: 123,
      github_repo_owner: 'AtlasAIEngine',
      github_repo_name: 'AtlasEngineMVPClaude',
    });

    prReviewService.getById.mockResolvedValue({
      id: 'pr-1',
      projectId: 'proj-1',
      githubPrNumber: 65,
      authorLogin: 'SomeAuthor',
      reviewJson: {
        summary: 'Review summary',
        recommendations: [
          {
            type: 'issue',
            severity: 'high',
            title: 'Fix the bug',
            description: 'There is a bug.',
            file: 'src/example.ts',
            line: 12,
          },
        ],
      },
    });
    prReviewService.getByProject.mockResolvedValue([]);
    prReviewService.upsert.mockImplementation(async (payload) => ({
      id: `pr-${payload.githubPrNumber}`,
      displayId: 'PR-001',
      projectId: payload.projectId,
      githubPrNumber: payload.githubPrNumber,
      title: payload.title,
      body: payload.body,
      authorLogin: payload.authorLogin,
      authorAvatarUrl: payload.authorAvatarUrl,
      state: payload.state,
      headBranch: payload.headBranch,
      baseBranch: payload.baseBranch,
      headSha: payload.headSha,
      baseSha: payload.baseSha,
      fileCount: payload.fileCount,
      totalAdditions: payload.totalAdditions,
      totalDeletions: payload.totalDeletions,
      commitCount: payload.commitCount,
      labels: payload.labels || [],
      assignees: payload.assignees || [],
      requestedReviewers: payload.requestedReviewers || [],
      htmlUrl: payload.htmlUrl,
      reviewStatus: 'none',
      createdAt: '2026-03-10T00:00:00.000Z',
      updatedAt: '2026-03-10T00:00:00.000Z',
    }));
    prReviewService.updateReview.mockResolvedValue(null);

    prReviewPublishService.listPublications.mockResolvedValue({
      reviewType: 'pr_review',
      reviewId: 'pr-1',
      totalPublished: 1,
      byRecommendationKey: {
        'issue|high|fix the bug|there is a bug.|src/example.ts|12|': {
          recommendationKey: 'issue|high|fix the bug|there is a bug.|src/example.ts|12|',
          githubReviewId: '2001',
          githubCommentId: '3001',
          action: 'comment',
          headSha: 'abc123',
          path: 'src/example.ts',
          line: 12,
          publishedAt: '2026-03-09T12:00:00.000Z',
          updatedAt: '2026-03-09T12:00:00.000Z',
        },
      },
      latestAction: 'comment',
    });

    prReviewPublishService.publishReview.mockResolvedValue({
      publication: {
        reviewType: 'pr_review',
        reviewId: 'pr-1',
        totalPublished: 1,
        byRecommendationKey: {
          'issue|high|fix the bug|there is a bug.|src/example.ts|12|': {
            recommendationKey: 'issue|high|fix the bug|there is a bug.|src/example.ts|12|',
            githubReviewId: '2001',
            githubCommentId: '3001',
            action: 'request_changes',
            headSha: 'abc123',
            path: 'src/example.ts',
            line: 12,
            publishedAt: '2026-03-09T12:00:00.000Z',
            updatedAt: '2026-03-09T12:00:00.000Z',
          },
        },
        latestAction: 'request_changes',
      },
      reviewSubmission: {
        event: 'REQUEST_CHANGES',
        githubReviewId: '2001',
        commentCount: 1,
      },
      results: [
        {
          recommendationKey: 'issue|high|fix the bug|there is a bug.|src/example.ts|12|',
          status: 'published',
          githubCommentId: '3001',
        },
      ],
    });

    db.query.mockResolvedValue({
      rows: [{ account_login: 'AtlasReviewer' }],
    });
    githubService.getPullRequestReviews.mockResolvedValue([]);
  });

  it('lists PR review GitHub publication state', async () => {
    const { req, res } = createMockReqRes({ projectId: 'proj-1', prId: 'pr-1' });

    await callRouteHandler(
      prReviewsRouter,
      'get',
      '/proj-1/pr-reviews/pr-1/github-review/publications',
      req,
      res
    );

    expect(prReviewService.getById).toHaveBeenCalledWith('pr-1');
    expect(prReviewPublishService.listPublications).toHaveBeenCalledWith({
      projectId: 'proj-1',
      reviewType: 'pr_review',
      reviewId: 'pr-1',
    });
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      publication: expect.objectContaining({
        reviewType: 'pr_review',
        reviewId: 'pr-1',
        totalPublished: 1,
        latestAction: 'comment',
      }),
    });
  });

  it('preserves latest approve summary when a newer comment is published', async () => {
    prReviewService.getByProject.mockResolvedValue([
      {
        id: 'pr-1',
        projectId: 'proj-1',
        githubPrNumber: 65,
        title: 'PR title',
        authorLogin: 'SomeAuthor',
        state: 'open',
        headBranch: 'feature/test',
        baseBranch: 'main',
        headSha: 'head-ok',
        fileCount: 1,
        totalAdditions: 10,
        totalDeletions: 2,
        commitCount: 1,
        reviewStatus: 'reviewed',
        createdAt: '2026-03-10T00:00:00.000Z',
        updatedAt: '2026-03-10T00:00:00.000Z',
      },
    ]);
    db.query
      .mockResolvedValueOnce({
        rows: [
          {
            review_id: 'pr-1',
            action: 'comment',
            head_sha: 'head-ok',
            published_at: '2026-03-11T12:05:00.000Z',
            updated_at: '2026-03-11T12:05:00.000Z',
          },
          {
            review_id: 'pr-1',
            action: 'approve',
            head_sha: 'head-ok',
            published_at: '2026-03-11T12:00:00.000Z',
            updated_at: '2026-03-11T12:00:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [{ account_login: 'AtlasReviewer' }],
      });

    const { req, res } = createMockReqRes({ projectId: 'proj-1' });
    await callRouteHandler(
      prReviewsRouter,
      'get',
      '/proj-1/pr-reviews',
      req,
      res
    );

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      prReviews: [
        expect.objectContaining({
          latestPublicationAction: 'comment',
          latestPublicationHeadSha: 'head-ok',
          latestApprovedPublicationHeadSha: 'head-ok',
        }),
      ],
    }));
  });

  it('hydrates latest approval state when loading a single PR review', async () => {
    prReviewService.getById.mockResolvedValue({
      id: 'pr-1',
      projectId: 'proj-1',
      githubPrNumber: 65,
      authorLogin: 'SomeAuthor',
      state: 'open',
      headBranch: 'feature/test',
      baseBranch: 'main',
      headSha: 'head-ok',
      fileCount: 1,
      reviewStatus: 'reviewed',
      reviewJson: {
        summary: 'Review summary',
        recommendations: [],
      },
      createdAt: '2026-03-10T00:00:00.000Z',
      updatedAt: '2026-03-10T00:00:00.000Z',
    });
    db.query
      .mockResolvedValueOnce({
        rows: [{ account_login: 'AtlasReviewer' }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            review_id: 'pr-1',
            action: 'approve',
            head_sha: 'head-ok',
            published_at: '2026-03-11T12:00:00.000Z',
            updated_at: '2026-03-11T12:00:00.000Z',
          },
        ],
      });

    const { req, res } = createMockReqRes({ projectId: 'proj-1', prId: 'pr-1' });
    await callRouteHandler(
      prReviewsRouter,
      'get',
      '/proj-1/pr-reviews/pr-1',
      req,
      res
    );

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      prReview: expect.objectContaining({
        latestPublicationAction: 'approve',
        latestPublicationHeadSha: 'head-ok',
        latestApprovedPublicationHeadSha: 'head-ok',
      }),
    }));
  });

  it('publishes PR review findings to GitHub review comments', async () => {
    const { req, res } = createMockReqRes(
      { projectId: 'proj-1', prId: 'pr-1' },
      {
        action: 'request_changes',
        recommendationKeys: ['issue|high|fix the bug|there is a bug.|src/example.ts|12|'],
      }
    );

    await callRouteHandler(
      prReviewsRouter,
      'post',
      '/proj-1/pr-reviews/pr-1/github-review',
      req,
      res
    );

    expect(prReviewService.getById).toHaveBeenCalledWith('pr-1');
    expect(prReviewPublishService.publishReview).toHaveBeenCalledWith({
      projectId: 'proj-1',
      reviewId: 'pr-1',
      installationId: 123,
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVPClaude',
      prReview: expect.objectContaining({
        id: 'pr-1',
        githubPrNumber: 65,
      }),
      action: 'request_changes',
      recommendationKeys: ['issue|high|fix the bug|there is a bug.|src/example.ts|12|'],
      body: undefined,
    });
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      publication: expect.objectContaining({
        latestAction: 'request_changes',
      }),
      reviewSubmission: expect.objectContaining({
        event: 'REQUEST_CHANGES',
      }),
      results: expect.arrayContaining([
        expect.objectContaining({
          status: 'published',
        }),
      ]),
    });
  });

  it('forwards per-finding comment overrides for PR review publication', async () => {
    const { req, res } = createMockReqRes(
      { projectId: 'proj-1', prId: 'pr-1' },
      {
        action: 'comment',
        recommendationKeys: ['issue|high|fix the bug|there is a bug.|src/example.ts|12|'],
        body: null,
        commentOverridesByRecommendationKey: {
          'issue|high|fix the bug|there is a bug.|src/example.ts|12|': 'Please dispose this subscription in OnDestroy.',
        },
        skipExistingPublicationCheck: true,
      }
    );

    await callRouteHandler(
      prReviewsRouter,
      'post',
      '/proj-1/pr-reviews/pr-1/github-review',
      req,
      res
    );

    expect(prReviewPublishService.publishReview).toHaveBeenCalledWith(expect.objectContaining({
      action: 'comment',
      recommendationKeys: ['issue|high|fix the bug|there is a bug.|src/example.ts|12|'],
      body: null,
      commentOverridesByRecommendationKey: {
        'issue|high|fix the bug|there is a bug.|src/example.ts|12|': 'Please dispose this subscription in OnDestroy.',
      },
      skipExistingPublicationCheck: true,
    }));
  });

  it('forwards manual line comments for PR review publication', async () => {
    const { req, res } = createMockReqRes(
      { projectId: 'proj-1', prId: 'pr-1' },
      {
        action: 'comment',
        recommendationKeys: [],
        useExplicitRecommendationSelection: true,
        manualLineComments: [
          {
            id: 'lc_test_manual',
            path: 'src/example.ts',
            line: 12,
            side: 'LEFT',
            body: 'Please rename this variable before merging.',
          },
        ],
      }
    );

    await callRouteHandler(
      prReviewsRouter,
      'post',
      '/proj-1/pr-reviews/pr-1/github-review',
      req,
      res
    );

    expect(prReviewPublishService.publishReview).toHaveBeenCalledWith(expect.objectContaining({
      action: 'comment',
      recommendationKeys: [],
      useExplicitRecommendationSelection: true,
      manualLineComments: [
        {
          id: 'lc_test_manual',
          path: 'src/example.ts',
          line: 12,
          side: 'LEFT',
          body: 'Please rename this variable before merging.',
        },
      ],
    }));
  });

  it('persists requested reviewers during PR sync so review requests show up in ownership filters', async () => {
    const syncedRecord = {
      id: 'pr-9010',
      displayId: 'PR-001',
      projectId: 'proj-1',
      githubPrNumber: 9010,
      title: 'feat: shrine ux',
      body: '...',
      authorLogin: 'yulun-lila',
      authorAvatarUrl: 'https://example.com/avatar.png',
      state: 'open',
      headBranch: 'feat/shrine-ux',
      baseBranch: 'main',
      headSha: 'head-sha',
      baseSha: 'base-sha',
      fileCount: 12,
      totalAdditions: 200,
      totalDeletions: 50,
      commitCount: 4,
      labels: [],
      assignees: [],
      requestedReviewers: ['AvinashP', 'Tomasz-Lila'],
      htmlUrl: 'https://github.com/example-org-Github/ExampleProject/pull/9010',
      reviewStatus: 'none',
      createdAt: '2026-03-10T00:00:00.000Z',
      updatedAt: '2026-03-10T00:00:00.000Z',
    };
    githubService.listPullRequests
      .mockResolvedValueOnce([
        {
          number: 9010,
          title: 'feat: shrine ux',
          body: '...',
          user: { login: 'yulun-lila', avatar_url: 'https://example.com/avatar.png' },
          assignees: [],
          requested_reviewers: ['AvinashP', 'Tomasz-Lila'],
          state: 'open',
          head: { ref: 'feat/shrine-ux', sha: 'head-sha' },
          base: { ref: 'main', sha: 'base-sha' },
          changed_files: 12,
          additions: 200,
          deletions: 50,
          commits: 4,
          html_url: 'https://github.com/example-org-Github/ExampleProject/pull/9010',
        },
      ])
      .mockResolvedValueOnce([]);
    prReviewService.upsert.mockResolvedValue(syncedRecord);
    prReviewService.getByProject
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([syncedRecord]);

    const { req, res } = createMockReqRes({ projectId: 'proj-1' });
    await callRouteHandler(
      prReviewsRouter,
      'post',
      '/proj-1/pr-reviews/sync',
      req,
      res
    );

    expect(prReviewService.upsert).toHaveBeenCalledWith(expect.objectContaining({
      githubPrNumber: 9010,
      assignees: [],
      requestedReviewers: ['AvinashP', 'Tomasz-Lila'],
    }));
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      prReviews: [
        expect.objectContaining({
          githubPrNumber: 9010,
          requestedReviewers: ['AvinashP', 'Tomasz-Lila'],
        }),
      ],
      synced: 1,
    }));
  });

  it('uses the review-sync bearer user when syncing PRs', async () => {
    reviewSyncService.getGuestSessionByAuthToken.mockResolvedValue({
      userId: 'linked-user-1',
    });
    githubService.listPullRequests.mockResolvedValue([]);
    prReviewService.getByProject
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const { req, res } = createMockReqRes(
      { projectId: 'proj-1' },
      {},
      null,
      { authorization: 'Bearer review-sync-token' }
    );
    await callRouteHandler(
      prReviewsRouter,
      'post',
      '/proj-1/pr-reviews/sync',
      req,
      res
    );

    expect(reviewSyncService.getGuestSessionByAuthToken).toHaveBeenCalledWith('review-sync-token');
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining('FROM github_integrations'),
      ['linked-user-1']
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
    }));
  });

  it('does not let authenticated users access anonymous-owned PR reviews', async () => {
    const { req, res } = createMockReqRes(
      { projectId: 'proj-1' },
      {},
      { id: 'user-1' }
    );

    await callRouteHandler(
      prReviewsRouter,
      'get',
      '/proj-1/pr-reviews',
      req,
      res
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Forbidden' });
    expect(prReviewService.getByProject).not.toHaveBeenCalled();
  });

  it('does not fall back to anonymous access when review-sync lookup fails', async () => {
    const lookupError = new Error('review sync unavailable');
    reviewSyncService.getGuestSessionByAuthToken.mockRejectedValueOnce(lookupError);

    const { req, res } = createMockReqRes(
      { projectId: 'proj-1' },
      {},
      null,
      { authorization: 'Bearer review-sync-token' }
    );

    await callRouteHandler(
      prReviewsRouter,
      'post',
      '/proj-1/pr-reviews/sync',
      req,
      res
    );

    expect(reviewSyncService.getGuestSessionByAuthToken).toHaveBeenCalledWith('review-sync-token');
    expect(githubService.listPullRequests).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Unable to verify review session. Try again.',
      code: 'REVIEW_SYNC_LOOKUP_FAILED',
    });
  });

  it('returns 400 when syncing PRs for a project without a GitHub connection', async () => {
    getProjectById.mockResolvedValueOnce({
      id: 'proj-1',
      path: null,
      user_id: ANONYMOUS_USER_ID,
      github_installation_id: null,
      github_repo_owner: null,
      github_repo_name: null,
    });

    const { req, res } = createMockReqRes({ projectId: 'proj-1' });
    await callRouteHandler(
      prReviewsRouter,
      'post',
      '/proj-1/pr-reviews/sync',
      req,
      res
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: 'Project is not connected to GitHub' });
  });

  it('returns a friendly 403 when the connected GitHub account cannot access the repo PRs', async () => {
    getProjectById.mockResolvedValueOnce({
      id: 'proj-1',
      path: '/tmp/repo',
      user_id: ANONYMOUS_USER_ID,
      github_installation_id: 123,
      github_repo_owner: 'example-org-Github',
      github_repo_name: 'ExampleProject',
    });
    db.query.mockResolvedValueOnce({
      rows: [
        { installation_id: 123, account_login: 'AtlasAIEngine', account_type: 'Organization' },
        { installation_id: -101, account_login: 'avinash-atlas', account_type: 'User' },
      ],
    });
    prReviewService.getByProject.mockResolvedValueOnce([]);

    const githubError = new Error('Not Found - https://docs.github.com/rest/pulls/pulls#list-pull-requests');
    githubError.status = 404;
    githubError.response = {
      data: {
        documentation_url: 'https://docs.github.com/rest/pulls/pulls#list-pull-requests',
      },
    };
    githubService.listPullRequests.mockRejectedValueOnce(githubError);

    const { req, res } = createMockReqRes({ projectId: 'proj-1' });
    await callRouteHandler(
      prReviewsRouter,
      'post',
      '/proj-1/pr-reviews/sync',
      req,
      res
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: 'The connected GitHub account (avinash-atlas) cannot access pull requests for example-org-Github/ExampleProject. Reconnect GitHub with an account that has repo access, or grant the Atlas GitHub App access to this repository.',
      code: 'GITHUB_REPO_ACCESS_DENIED',
      connectedLogin: 'avinash-atlas',
      owner: 'example-org-Github',
      repo: 'ExampleProject',
    });
  });

  it('refreshes a single PR review from GitHub before review actions', async () => {
    prReviewService.getById.mockResolvedValue({
      id: 'pr-9010',
      projectId: 'proj-1',
      githubPrNumber: 9010,
      reviewStatus: 'none',
    });
    githubService.getPullRequestDetail.mockResolvedValue({
      number: 9010,
      title: 'feat: shrine ux',
      body: 'Latest body',
      draft: false,
      state: 'open',
      user: { login: 'yulun-lila', avatar_url: 'https://example.com/avatar.png' },
      assignees: [{ login: 'AvinashP' }],
      requested_reviewers: [{ login: 'Tomasz-Lila' }],
      head: { ref: 'feat/shrine-ux', sha: 'new-head-sha' },
      base: { ref: 'main', sha: 'base-sha' },
      changed_files: 15,
      additions: 250,
      deletions: 75,
      commits: 5,
      html_url: 'https://github.com/example-org-Github/ExampleProject/pull/9010',
    });
    prReviewService.upsert.mockResolvedValue({
      id: 'pr-9010',
      projectId: 'proj-1',
      githubPrNumber: 9010,
      title: 'feat: shrine ux',
      assignees: ['AvinashP'],
      requestedReviewers: ['Tomasz-Lila'],
      headSha: 'new-head-sha',
      reviewStatus: 'none',
      createdAt: '2026-03-10T00:00:00.000Z',
      updatedAt: '2026-03-10T00:00:00.000Z',
    });

    const { req, res } = createMockReqRes({ projectId: 'proj-1', prId: 'pr-9010' });
    await callRouteHandler(
      prReviewsRouter,
      'post',
      '/proj-1/pr-reviews/pr-9010/refresh',
      req,
      res
    );

    expect(githubService.getPullRequestDetail).toHaveBeenCalledWith(123, 'AtlasAIEngine', 'AtlasEngineMVPClaude', 9010);
    expect(prReviewService.upsert).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1',
      githubPrNumber: 9010,
      assignees: ['AvinashP'],
      requestedReviewers: ['Tomasz-Lila'],
      headSha: 'new-head-sha',
    }));
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      prReview: expect.objectContaining({
        githubPrNumber: 9010,
        assignees: ['AvinashP'],
        requestedReviewers: ['Tomasz-Lila'],
        headSha: 'new-head-sha',
      }),
    });
  });

  it('disables request changes for self-authored PRs and blocks publishing that action', async () => {
    prReviewService.getById.mockResolvedValue({
      id: 'pr-1',
      projectId: 'proj-1',
      githubPrNumber: 65,
      authorLogin: 'AvinashP',
      reviewStatus: 'reviewed',
      reviewHeadSha: 'head-ok',
      headSha: 'head-ok',
      reviewJson: {
        summary: 'Review summary',
        recommendations: [],
      },
    });
    db.query.mockResolvedValue({
      rows: [{ account_login: 'AvinashP' }],
    });
    prReviewPublishService.publishReview.mockRejectedValueOnce(Object.assign(
      new Error('GitHub does not allow requesting changes on your own pull request.'),
      {
        code: 'ACTION_BLOCKED',
        statusCode: 409,
        blockedReason: 'GitHub does not allow requesting changes on your own pull request.',
        staleReason: null,
      },
    ));

    const { req, res } = createMockReqRes({ projectId: 'proj-1', prId: 'pr-1' });
    await callRouteHandler(
      prReviewsRouter,
      'get',
      '/proj-1/pr-reviews/pr-1',
      req,
      res
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      prReview: expect.objectContaining({
        reviewActionEligibility: expect.objectContaining({
          canApprove: false,
          canRequestChanges: false,
          approveBlockedReason: 'GitHub does not allow approving your own pull request.',
          requestChangesBlockedReason: 'GitHub does not allow requesting changes on your own pull request.',
        }),
      }),
    }));

    const publish = createMockReqRes(
      { projectId: 'proj-1', prId: 'pr-1' },
      { action: 'request_changes', recommendationKeys: [] },
    );
    await callRouteHandler(
      prReviewsRouter,
      'post',
      '/proj-1/pr-reviews/pr-1/github-review',
      publish.req,
      publish.res
    );
    expect(prReviewPublishService.publishReview).toHaveBeenCalledWith(expect.objectContaining({
      prReview: expect.objectContaining({
        reviewActionEligibility: expect.objectContaining({
          canRequestChanges: false,
          requestChangesBlockedReason: 'GitHub does not allow requesting changes on your own pull request.',
        }),
      }),
      action: 'request_changes',
    }));
    expect(publish.res.status).toHaveBeenCalledWith(409);
    expect(publish.res.json).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: 'GitHub does not allow requesting changes on your own pull request.',
    }));
  });

  it('reuses the cached PR file manifest for repeated review detail loads on the same head sha', async () => {
    getProjectById.mockResolvedValue({
      id: 'proj-cache',
      path: '/tmp/repo',
      user_id: ANONYMOUS_USER_ID,
      github_installation_id: 123,
      github_repo_owner: 'AtlasAIEngine',
      github_repo_name: 'AtlasEngineMVPClaude',
    });
    prReviewService.getById.mockResolvedValue({
      id: 'pr-cache',
      projectId: 'proj-cache',
      githubPrNumber: 9100,
      authorLogin: 'SomeAuthor',
      headSha: 'head-cache-1',
      baseSha: 'base-cache-1',
      reviewJson: null,
    });
    db.query.mockResolvedValue({
      rows: [],
    });
    githubService.getPullRequestFiles.mockResolvedValue([
      {
        filename: 'src/cached.ts',
        status: 'modified',
        additions: 12,
        deletions: 3,
        previous_filename: null,
        patch: '@@ -1 +1 @@',
      },
    ]);

    const first = createMockReqRes({ projectId: 'proj-cache', prId: 'pr-cache' });
    await callRouteHandler(
      prReviewsRouter,
      'get',
      '/proj-cache/pr-reviews/pr-cache',
      first.req,
      first.res
    );
    const second = createMockReqRes({ projectId: 'proj-cache', prId: 'pr-cache' });
    await callRouteHandler(
      prReviewsRouter,
      'get',
      '/proj-cache/pr-reviews/pr-cache',
      second.req,
      second.res
    );

    expect(githubService.getPullRequestFiles).toHaveBeenCalledTimes(1);
    expect(second.res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      files: [
        {
          path: 'src/cached.ts',
          status: 'M',
          additions: 12,
          deletions: 3,
          oldPath: null,
          patch: '@@ -1 +1 @@',
        },
      ],
    }));
  });

  it('preserves cached patch text for the PR file content route', async () => {
    getProjectById.mockResolvedValue({
      id: 'proj-cache',
      path: '/tmp/repo',
      user_id: ANONYMOUS_USER_ID,
      github_installation_id: 123,
      github_repo_owner: 'AtlasAIEngine',
      github_repo_name: 'AtlasEngineMVPClaude',
    });
    prReviewService.getById.mockResolvedValue({
      id: 'pr-cache-patch',
      projectId: 'proj-cache',
      githubPrNumber: 9101,
      authorLogin: 'SomeAuthor',
      headSha: 'head-cache-patch-1',
      baseSha: 'base-cache-patch-1',
      reviewJson: null,
    });
    db.query.mockResolvedValue({
      rows: [],
    });
    githubService.getPullRequestFiles.mockResolvedValue([
      {
        filename: 'src/cached.ts',
        status: 'modified',
        additions: 12,
        deletions: 3,
        previous_filename: null,
        patch: '@@ -1 +1 @@',
      },
    ]);
    githubService.getRepositoryContents.mockResolvedValue({
      content: Buffer.from('const nextValue = true;', 'utf-8').toString('base64'),
    });

    const detail = createMockReqRes({ projectId: 'proj-cache', prId: 'pr-cache-patch' });
    await callRouteHandler(
      prReviewsRouter,
      'get',
      '/proj-cache/pr-reviews/pr-cache-patch',
      detail.req,
      detail.res
    );

    const hydrate = createMockReqRes(
      { projectId: 'proj-cache', prId: 'pr-cache-patch' },
      { paths: ['src/cached.ts'] }
    );
    await callRouteHandler(
      prReviewsRouter,
      'post',
      '/proj-cache/pr-reviews/pr-cache-patch/files/content',
      hydrate.req,
      hydrate.res
    );

    expect(githubService.getPullRequestFiles).toHaveBeenCalledTimes(1);
    expect(hydrate.res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      files: [
        expect.objectContaining({
          path: 'src/cached.ts',
          patch: '@@ -1 +1 @@',
        }),
      ],
    }));
  });

  it('blocks approve for self-authored PRs with a specific reason', async () => {
    prReviewService.getById.mockResolvedValue({
      id: 'pr-1',
      projectId: 'proj-1',
      githubPrNumber: 65,
      authorLogin: 'AvinashP',
      reviewStatus: 'reviewed',
      reviewHeadSha: 'head-ok',
      headSha: 'head-ok',
      reviewJson: {
        summary: 'Review summary',
        recommendations: [],
      },
    });
    db.query.mockResolvedValue({
      rows: [{ account_login: 'AvinashP' }],
    });
    prReviewPublishService.publishReview.mockRejectedValueOnce(Object.assign(
      new Error('GitHub does not allow approving your own pull request.'),
      {
        code: 'ACTION_BLOCKED',
        statusCode: 409,
        blockedReason: 'GitHub does not allow approving your own pull request.',
        staleReason: null,
      },
    ));

    const publish = createMockReqRes(
      { projectId: 'proj-1', prId: 'pr-1' },
      { action: 'approve', recommendationKeys: [] },
    );
    await callRouteHandler(
      prReviewsRouter,
      'post',
      '/proj-1/pr-reviews/pr-1/github-review',
      publish.req,
      publish.res
    );
    expect(prReviewPublishService.publishReview).toHaveBeenCalledWith(expect.objectContaining({
      prReview: expect.objectContaining({
        reviewActionEligibility: expect.objectContaining({
          canApprove: false,
          approveBlockedReason: 'GitHub does not allow approving your own pull request.',
        }),
      }),
      action: 'approve',
    }));
    expect(publish.res.status).toHaveBeenCalledWith(409);
    expect(publish.res.json).toHaveBeenCalledWith(expect.objectContaining({
      blockedReason: 'GitHub does not allow approving your own pull request.',
    }));
  });

  it('passes policySource through when queueing a PR review', async () => {
    reviewService.enqueuePrReview.mockReturnValueOnce({
      id: 'pr-queue-1',
      position: 1,
    });

    const queue = createMockReqRes(
      { projectId: 'proj-1', prId: 'pr-1' },
      { reviewMode: 'full', forceFullScope: true, policySource: 'working_tree' }
    );
    await callRouteHandler(
      prReviewsRouter,
      'post',
      '/proj-1/pr-reviews/pr-1/review/queue',
      queue.req,
      queue.res
    );

    expect(reviewService.enqueuePrReview).toHaveBeenCalledWith('proj-1', 'pr-1', expect.objectContaining({
      reviewMode: 'full',
      forceFullScope: true,
      policySource: 'working_tree',
      projectPath: '/tmp/repo',
      prNumber: 65,
    }));
    expect(queue.res.json).toHaveBeenCalledWith({
      success: true,
      id: 'pr-queue-1',
      position: 1,
    });
  });
});
