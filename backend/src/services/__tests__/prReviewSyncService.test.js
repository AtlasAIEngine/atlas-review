import { beforeEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'child_process';

const dbQueryMock = vi.fn();
const listPullRequestsMock = vi.fn();
const getPullRequestDetailMock = vi.fn();
const getPullRequestReviewsMock = vi.fn();
const getByProjectMock = vi.fn();
const upsertMock = vi.fn();
const updateReviewMock = vi.fn();
const syncFailedHandler = vi.fn();

vi.mock('../../db/connection.js', () => ({
  default: {
    query: (...args) => dbQueryMock(...args),
  },
}));

vi.mock('../githubService.js', () => ({
  default: {
    listPullRequests: (...args) => listPullRequestsMock(...args),
    getPullRequestDetail: (...args) => getPullRequestDetailMock(...args),
    getPullRequestReviews: (...args) => getPullRequestReviewsMock(...args),
  },
}));

vi.mock('../prReviewService.js', () => ({
  default: {
    getByProject: (...args) => getByProjectMock(...args),
    upsert: (...args) => upsertMock(...args),
    updateReview: (...args) => updateReviewMock(...args),
  },
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

import prReviewSyncService, { buildPrReviewUpsertPayload, resolveGitHubMeta } from '../prReviewSyncService.js';

const execFileMock = vi.mocked(execFile);

describe('prReviewSyncService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    syncFailedHandler.mockReset();
    getPullRequestReviewsMock.mockResolvedValue([]);
    dbQueryMock.mockResolvedValue({
      rows: [],
    });
    execFileMock.mockReset();
    execFileMock.mockImplementation((...args) => {
      const callback = args[args.length - 1];
      callback(new Error('no remote'));
    });
  });

  it('maps GitHub aggregate PR comment counts into review metadata', () => {
    const payload = buildPrReviewUpsertPayload('proj-1', {
      number: 45,
      title: 'Commented PR',
      body: null,
      user: { login: 'atlas', avatar_url: null },
      assignees: [],
      requested_reviewers: [],
      state: 'open',
      head: { ref: 'feature/comments', sha: 'head-45' },
      base: { ref: 'main', sha: 'base-1' },
      changed_files: 3,
      additions: 10,
      deletions: 2,
      commits: 1,
      comments: 4,
      review_comments: 9,
      updated_at: '2026-04-29T10:15:00.000Z',
      html_url: 'https://example.test/pr/45',
    });

    expect(payload).toMatchObject({
      githubCommentCount: 4,
      githubReviewCommentCount: 9,
      githubUpdatedAt: '2026-04-29T10:15:00.000Z',
    });
  });

  // Regression: a draft PR that was closed (without merging) was previously
  // upserted with state='draft', so it survived the frontend's closed/merged
  // filter and showed up under "Your PRs" / "Others' PRs".
  it('upserts a closed draft PR with state="closed", not "draft"', () => {
    const payload = buildPrReviewUpsertPayload('proj-1', {
      number: 197,
      title: 'Closed draft',
      body: null,
      user: { login: 'atlas', avatar_url: null },
      assignees: [],
      requested_reviewers: [],
      state: 'closed',
      draft: true,
      head: { ref: 'feature/x', sha: 'head-197' },
      base: { ref: 'main', sha: 'base-1' },
      html_url: 'https://example.test/pr/197',
    });

    expect(payload.state).toBe('closed');
  });


  it('classifies created and closed PR deltas during project sync', async () => {
    const project = {
      id: 'proj-1',
      user_id: 'user-1',
      path: '/tmp/repo',
      github_sync_enabled: true,
      github_installation_id: 123,
      github_repo_owner: 'AtlasAIEngine',
      github_repo_name: 'AtlasEngineMVPClaude',
    };
    const existingOpenReview = {
      id: 'pr-old',
      projectId: 'proj-1',
      githubPrNumber: 44,
      state: 'open',
    };
    const existingDraftReview = {
      id: 'pr-draft',
      projectId: 'proj-1',
      githubPrNumber: 43,
      state: 'draft',
    };
    const existingClosedReview = {
      id: 'pr-closed',
      projectId: 'proj-1',
      githubPrNumber: 42,
      state: 'closed',
    };
    const createdReview = {
      id: 'pr-new',
      projectId: 'proj-1',
      githubPrNumber: 45,
      state: 'open',
      title: 'New PR',
      body: null,
      headBranch: 'feature/new',
      baseBranch: 'main',
      headSha: 'head-45',
      baseSha: 'base-1',
      fileCount: 3,
      totalAdditions: 10,
      totalDeletions: 2,
      commitCount: 1,
      assignees: [],
      requestedReviewers: [],
      authorLogin: 'atlas',
      authorAvatarUrl: null,
      htmlUrl: 'https://example.test/pr/45',
    };
    const recentMergedReview = {
      id: 'pr-merged-recent',
      projectId: 'proj-1',
      githubPrNumber: 46,
      state: 'merged',
      title: 'Recently merged PR',
      body: null,
      headBranch: 'feature/merged',
      baseBranch: 'main',
      headSha: 'head-46',
      baseSha: 'base-1',
      fileCount: 2,
      totalAdditions: 8,
      totalDeletions: 1,
      commitCount: 1,
      assignees: [],
      requestedReviewers: [],
      authorLogin: 'atlas',
      authorAvatarUrl: null,
      htmlUrl: 'https://example.test/pr/46',
    };

    getByProjectMock
      .mockResolvedValueOnce([existingOpenReview, existingDraftReview, existingClosedReview])
      .mockResolvedValueOnce([
        createdReview,
        recentMergedReview,
        { ...existingOpenReview, state: 'closed' },
        { ...existingDraftReview, state: 'closed' },
        existingClosedReview,
      ]);
    listPullRequestsMock.mockImplementation(async (_installationId, _owner, _repo, options = {}) => (
      options.state === 'closed'
        ? [
            {
              number: 46,
              title: 'Recently merged PR',
              body: null,
              user: { login: 'atlas', avatar_url: null },
              assignees: [],
              requested_reviewers: [],
              state: 'merged',
              head: { ref: 'feature/merged', sha: 'head-46' },
              base: { ref: 'main', sha: 'base-1' },
              changed_files: 2,
              additions: 8,
              deletions: 1,
              commits: 1,
              html_url: 'https://example.test/pr/46',
            },
          ]
        : [
            {
              number: 45,
              title: 'New PR',
              body: null,
              user: { login: 'atlas', avatar_url: null },
              assignees: [],
              requested_reviewers: [],
              state: 'open',
              head: { ref: 'feature/new', sha: 'head-45' },
              base: { ref: 'main', sha: 'base-1' },
              changed_files: 3,
              additions: 10,
              deletions: 2,
              commits: 1,
              html_url: 'https://example.test/pr/45',
            },
          ]
    ));
    upsertMock.mockImplementation(async (payload) => (
      payload.githubPrNumber === 46 ? recentMergedReview : createdReview
    ));
    updateReviewMock
      .mockResolvedValueOnce({ ...existingOpenReview, state: 'closed' })
      .mockResolvedValueOnce({ ...existingDraftReview, state: 'closed' });

    const result = await prReviewSyncService.syncProject(project, { source: 'auto' });

    expect(result.synced).toBe(2);
    expect(result.deltas).toEqual([
      { type: 'created', prReview: createdReview },
      { type: 'created', prReview: recentMergedReview },
      { type: 'closed', prReview: { ...existingOpenReview, state: 'closed' } },
      { type: 'closed', prReview: { ...existingDraftReview, state: 'closed' } },
    ]);
    expect(listPullRequestsMock).toHaveBeenCalledWith(
      123,
      'AtlasAIEngine',
      'AtlasEngineMVPClaude',
      { state: 'closed', sort: 'updated', direction: 'desc', maxResults: 20 }
    );
    expect(updateReviewMock).toHaveBeenCalledTimes(2);
  });

  it('classifies unchanged single-PR refreshes as refreshed', async () => {
    const project = {
      id: 'proj-1',
      user_id: 'user-1',
      path: '/tmp/repo',
      github_sync_enabled: true,
      github_installation_id: 123,
      github_repo_owner: 'AtlasAIEngine',
      github_repo_name: 'AtlasEngineMVPClaude',
    };
    const existingReview = {
      id: 'pr-45',
      projectId: 'proj-1',
      githubPrNumber: 45,
      title: 'Stable PR',
      body: null,
      state: 'open',
      headBranch: 'feature/stable',
      baseBranch: 'main',
      headSha: 'head-45',
      baseSha: 'base-1',
      fileCount: 3,
      totalAdditions: 10,
      totalDeletions: 2,
      commitCount: 1,
      assignees: [],
      requestedReviewers: [],
      authorLogin: 'atlas',
      authorAvatarUrl: null,
      htmlUrl: 'https://example.test/pr/45',
    };

    getPullRequestDetailMock.mockResolvedValue({
      number: 45,
      title: 'Stable PR',
      body: null,
      draft: false,
      state: 'open',
      user: { login: 'atlas', avatar_url: null },
      assignees: [],
      requested_reviewers: [],
      head: { ref: 'feature/stable', sha: 'head-45' },
      base: { ref: 'main', sha: 'base-1' },
      changed_files: 3,
      additions: 10,
      deletions: 2,
      commits: 1,
      html_url: 'https://example.test/pr/45',
    });
    getPullRequestReviewsMock.mockResolvedValue([
      { user: { login: 'reviewer-a' } },
      { user: { login: 'reviewer-a' } },
      { user: { login: 'reviewer-b' } },
    ]);
    upsertMock.mockResolvedValue(existingReview);

    const syncStartedHandler = vi.fn();
    prReviewSyncService.once('sync-started', syncStartedHandler);

    const result = await prReviewSyncService.refreshPrReview(project, existingReview, { source: 'review_action' });

    expect(result.deltaType).toBe('refreshed');
    expect(syncStartedHandler).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1',
      source: 'review_action',
    }));
    expect(upsertMock).toHaveBeenCalledWith(expect.objectContaining({
      githubPrNumber: 45,
      headSha: 'head-45',
      reviewerParticipants: ['reviewer-a', 'reviewer-b'],
    }));
  });

  it('emits sync-failed when single-PR refresh throws after sync-started', async () => {
    const project = {
      id: 'proj-1',
      user_id: 'user-1',
      path: '/tmp/repo',
      github_sync_enabled: true,
      github_installation_id: 123,
      github_repo_owner: 'AtlasAIEngine',
      github_repo_name: 'AtlasEngineMVPClaude',
    };
    const existingReview = {
      id: 'pr-45',
      projectId: 'proj-1',
      githubPrNumber: 45,
    };

    getPullRequestDetailMock.mockRejectedValue(new Error('GitHub API down'));
    prReviewSyncService.once('sync-failed', syncFailedHandler);

    await expect(
      prReviewSyncService.refreshPrReview(project, existingReview, { source: 'review_action' })
    ).rejects.toThrow('GitHub API down');

    expect(syncFailedHandler).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1',
      source: 'review_action',
      error: 'GitHub API down',
    }));
  });

  it('rewrites GitHub 404 pull-list errors into a repo access message', async () => {
    const project = {
      id: 'proj-1',
      user_id: 'user-1',
      path: '/tmp/repo',
      github_sync_enabled: true,
      github_installation_id: 123,
      github_repo_owner: 'example-org-Github',
      github_repo_name: 'ExampleProject',
    };

    dbQueryMock.mockResolvedValueOnce({
      rows: [
        { installation_id: 123, account_login: 'AtlasAIEngine', account_type: 'Organization' },
        { installation_id: -101, account_login: 'avinash-atlas', account_type: 'User' },
      ],
    });
    getByProjectMock.mockResolvedValueOnce([]);

    const githubError = new Error('Not Found - https://docs.github.com/rest/pulls/pulls#list-pull-requests');
    githubError.status = 404;
    githubError.response = {
      data: {
        documentation_url: 'https://docs.github.com/rest/pulls/pulls#list-pull-requests',
      },
    };
    listPullRequestsMock.mockRejectedValue(githubError);
    prReviewSyncService.once('sync-failed', syncFailedHandler);

    await expect(
      prReviewSyncService.syncProject(project, { source: 'manual' })
    ).rejects.toMatchObject({
      code: 'GITHUB_REPO_ACCESS_DENIED',
      statusCode: 403,
      connectedLogin: 'AtlasAIEngine',
      owner: 'example-org-Github',
      repo: 'ExampleProject',
    });

    expect(syncFailedHandler).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1',
      source: 'manual',
      code: 'GITHUB_REPO_ACCESS_DENIED',
      connectedLogin: 'AtlasAIEngine',
      owner: 'example-org-Github',
      repo: 'ExampleProject',
      error: 'The connected GitHub account (AtlasAIEngine) cannot access pull requests for example-org-Github/ExampleProject. Reconnect GitHub with an account that has repo access, or grant the Atlas GitHub App access to this repository.',
    }));
  });

  it('does not classify unrelated GitHub 404s as repo access denied', async () => {
    const project = {
      id: 'proj-1',
      user_id: 'user-1',
      path: '/tmp/repo',
      github_sync_enabled: true,
      github_installation_id: 123,
      github_repo_owner: 'AtlasAIEngine',
      github_repo_name: 'AtlasEngineMVPClaude',
    };

    getByProjectMock.mockResolvedValueOnce([]);

    const githubError = new Error('Not Found');
    githubError.status = 404;
    listPullRequestsMock.mockRejectedValue(githubError);

    await expect(
      prReviewSyncService.syncProject(project, { source: 'manual' })
    ).rejects.toThrow('Not Found');
  });

  it('does not resolve GitHub metadata for disconnected local projects', async () => {
    const project = {
      id: 'proj-local',
      user_id: 'user-1',
      path: '/tmp/repo',
      github_sync_enabled: false,
      github_installation_id: null,
      github_repo_owner: null,
      github_repo_name: null,
    };

    const resolved = await resolveGitHubMeta(project, 'user-1');

    expect(resolved).toBeNull();
    expect(dbQueryMock).not.toHaveBeenCalled();
  });

  it('repairs stale project installation metadata when another active org installation can access the repo', async () => {
    const project = {
      id: 'proj-org',
      user_id: 'user-1',
      path: '/tmp/repo',
      github_sync_enabled: true,
      github_installation_id: 113423831,
      github_repo_owner: 'AtlasAIEngine',
      github_repo_name: 'AtlasEngineMVPClaude',
    };

    dbQueryMock.mockResolvedValueOnce({
      rows: [
        {
          installation_id: 113423831,
          account_login: 'AvinashP',
          account_type: 'User',
          repositories_accessible: JSON.stringify(['AvinashP/personal-repo']),
        },
        {
          installation_id: 113436148,
          account_login: 'AtlasAIEngine',
          account_type: 'Organization',
          repositories_accessible: JSON.stringify(['AtlasAIEngine/AtlasEngineMVPClaude']),
        },
      ],
    });

    const resolved = await resolveGitHubMeta(project, 'user-1');

    expect(resolved).toEqual({
      installationId: 113436148,
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVPClaude',
      connectedLogin: 'AtlasAIEngine',
    });
  });

  it('falls back to a safe active installation when repo caches are known but incomplete', async () => {
    const project = {
      id: 'proj-local',
      user_id: 'user-1',
      path: '/tmp/repo',
      github_sync_enabled: false,
      github_installation_id: null,
      github_repo_owner: null,
      github_repo_name: null,
    };

    execFileMock.mockImplementation((...args) => {
      const callback = args[args.length - 1];
      callback(null, { stdout: 'https://github.com/example-org-Github/ExampleProject.git\n', stderr: '' });
    });
    dbQueryMock.mockResolvedValueOnce({
      rows: [
        {
          installation_id: 113436148,
          account_login: 'AtlasAIEngine',
          account_type: 'Organization',
          repositories_accessible: JSON.stringify(['AtlasAIEngine/AtlasEngineMVPClaude']),
        },
        {
          installation_id: 119937368,
          account_login: 'avinash-atlas',
          account_type: 'User',
          repositories_accessible: JSON.stringify([]),
        },
      ],
    });

    const resolved = await resolveGitHubMeta(project, 'user-1');

    expect(resolved).toEqual({
      installationId: 119937368,
      owner: 'example-org-Github',
      repo: 'ExampleProject',
      connectedLogin: 'avinash-atlas',
    });
  });

  it('prefers an owner-matching installation before a generic user fallback when caches are known', async () => {
    const project = {
      id: 'proj-local',
      user_id: 'user-1',
      path: '/tmp/repo',
      github_sync_enabled: false,
      github_installation_id: null,
      github_repo_owner: null,
      github_repo_name: null,
    };

    execFileMock.mockImplementation((...args) => {
      const callback = args[args.length - 1];
      callback(null, { stdout: 'https://github.com/example-org-Github/ExampleProject.git\n', stderr: '' });
    });
    dbQueryMock.mockResolvedValueOnce({
      rows: [
        {
          installation_id: 113436148,
          account_login: 'example-org-Github',
          account_type: 'Organization',
          repositories_accessible: JSON.stringify([]),
        },
        {
          installation_id: 119937368,
          account_login: 'avinash-atlas',
          account_type: 'User',
          repositories_accessible: JSON.stringify([]),
        },
      ],
    });

    const resolved = await resolveGitHubMeta(project, 'user-1');

    expect(resolved).toEqual({
      installationId: 113436148,
      owner: 'example-org-Github',
      repo: 'ExampleProject',
      connectedLogin: 'example-org-Github',
    });
  });

  it('does not emit sync-started when single-PR refresh fails before GitHub connectivity is resolved', async () => {
    const project = {
      id: 'proj-1',
      user_id: 'user-1',
      path: null,
      github_installation_id: null,
      github_repo_owner: null,
      github_repo_name: null,
    };
    const existingReview = {
      id: 'pr-45',
      projectId: 'proj-1',
      githubPrNumber: 45,
    };
    const syncStartedHandler = vi.fn();

    prReviewSyncService.once('sync-started', syncStartedHandler);
    prReviewSyncService.once('sync-failed', syncFailedHandler);

    await expect(
      prReviewSyncService.refreshPrReview(project, existingReview, { source: 'review_action' })
    ).rejects.toThrow('Project is not connected to GitHub');

    expect(syncStartedHandler).not.toHaveBeenCalled();
    expect(syncFailedHandler).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1',
      source: 'review_action',
      error: 'Project is not connected to GitHub',
    }));
  });

  it('does not emit sync-started when project sync fails before GitHub connectivity is resolved', async () => {
    const project = {
      id: 'proj-1',
      user_id: 'user-1',
      path: null,
      github_installation_id: null,
      github_repo_owner: null,
      github_repo_name: null,
    };
    const syncStartedHandler = vi.fn();

    prReviewSyncService.once('sync-started', syncStartedHandler);
    prReviewSyncService.once('sync-failed', syncFailedHandler);

    await expect(
      prReviewSyncService.syncProject(project, { source: 'manual' })
    ).rejects.toThrow('Project is not connected to GitHub');

    expect(syncStartedHandler).not.toHaveBeenCalled();
    expect(syncFailedHandler).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1',
      source: 'manual',
      error: 'Project is not connected to GitHub',
    }));
  });
});
