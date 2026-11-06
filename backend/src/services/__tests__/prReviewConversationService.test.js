import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
const transactionMock = vi.fn();
const getDbTypeMock = vi.fn();
const getConversationThreadsMock = vi.fn();
const getIssueCommentsMock = vi.fn();
const getPullRequestReviewsMock = vi.fn();
const submitPullRequestReviewMock = vi.fn();
const updatePullRequestReviewCommentMock = vi.fn();
const deletePullRequestReviewCommentMock = vi.fn();
const resolveGitHubMetaMock = vi.fn();

vi.mock('../../db/connection.js', () => ({
  default: { query: (...args) => queryMock(...args) },
  getDbType: (...args) => getDbTypeMock(...args),
  transaction: (...args) => transactionMock(...args),
}));

vi.mock('../githubService.js', () => ({
  default: {
    getPullRequestConversationThreads: (...args) => getConversationThreadsMock(...args),
    getPullRequestIssueComments: (...args) => getIssueCommentsMock(...args),
    getPullRequestReviews: (...args) => getPullRequestReviewsMock(...args),
    submitPullRequestReview: (...args) => submitPullRequestReviewMock(...args),
    updatePullRequestReviewComment: (...args) => updatePullRequestReviewCommentMock(...args),
    deletePullRequestReviewComment: (...args) => deletePullRequestReviewCommentMock(...args),
  },
}));

vi.mock('../prReviewSyncService.js', () => ({
  buildGitHubReviewStatus: (reviews = [], options = {}) => ({
    githubReviewDecision: options.reviewDecision || null,
    githubMergeStateStatus: options.mergeStateStatus || null,
    githubLatestReviewState: reviews[0]?.state || null,
    githubLatestReviewAuthor: reviews[0]?.user?.login || null,
    githubLatestReviewSubmittedAt: reviews[0]?.submitted_at || null,
    githubReviewStateCounts: reviews.reduce((acc, review) => {
      if (review?.state) acc[review.state] = (acc[review.state] || 0) + 1;
      return acc;
    }, {}),
    githubReviewStatusSyncedAt: '2026-04-01T12:00:00.000Z',
  }),
  resolveGitHubMeta: (...args) => resolveGitHubMetaMock(...args),
}));

import prReviewConversationService from '../prReviewConversationService.js';

describe('prReviewConversationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDbTypeMock.mockReturnValue('sqlite');
    resolveGitHubMetaMock.mockResolvedValue({
      installationId: 123,
      owner: 'AtlasAIEngine',
      repo: 'AtlasEngineMVP',
    });
    getConversationThreadsMock.mockResolvedValue({ threads: [] });
    getIssueCommentsMock.mockResolvedValue([]);
    getPullRequestReviewsMock.mockResolvedValue([]);
    submitPullRequestReviewMock.mockResolvedValue({ githubReviewId: 'review-1' });
    updatePullRequestReviewCommentMock.mockResolvedValue({ id: 1001 });
    deletePullRequestReviewCommentMock.mockResolvedValue(true);
    transactionMock.mockImplementation(async (callback) => callback({ query: queryMock }));
    queryMock.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('FROM github_pr_threads')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM github_pr_thread_comments')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM github_pr_issue_comments')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
  });

  it('normalizes GraphQL review threads with resolved state and replies', () => {
    const thread = prReviewConversationService.__testing.normalizeThread({
      id: 'thread-node-1',
      isResolved: true,
      isOutdated: false,
      resolvedBy: { login: 'reviewer-a' },
      path: 'src/app.ts',
      line: 42,
      startLine: 40,
      diffSide: 'RIGHT',
      comments: {
        nodes: [
          {
            id: 'comment-node-1',
            databaseId: 1001,
            body: 'Please fix this',
            bodyText: 'Please fix this',
            author: { login: 'reviewer-a', avatarUrl: 'https://avatars.test/a.png', url: 'https://github.com/reviewer-a' },
            createdAt: '2026-04-01T10:00:00Z',
            updatedAt: '2026-04-01T10:00:00Z',
            url: 'https://github.com/org/repo/pull/7#discussion_r1001',
          },
          {
            id: 'comment-node-2',
            databaseId: 1002,
            body: 'Fixed',
            replyTo: { id: 'comment-node-1' },
            author: { login: 'author-a' },
            createdAt: '2026-04-01T11:00:00Z',
            updatedAt: '2026-04-01T11:05:00Z',
          },
        ],
      },
    }, 7);

    expect(thread).toMatchObject({
      threadNodeId: 'thread-node-1',
      githubPrNumber: 7,
      isResolved: true,
      resolvedByLogin: 'reviewer-a',
      path: 'src/app.ts',
      line: 42,
      commentCount: 2,
      firstCommentAt: '2026-04-01T10:00:00.000Z',
      lastCommentAt: '2026-04-01T11:05:00.000Z',
    });
    expect(thread.comments[1]).toMatchObject({
      commentNodeId: 'comment-node-2',
      replyToNodeId: 'comment-node-1',
      authorLogin: 'author-a',
    });
  });

  it('syncs GitHub conversation payloads into durable tables', async () => {
    getConversationThreadsMock.mockResolvedValue({
      pullRequestNodeId: 'pr-node-7',
      reviewDecision: 'CHANGES_REQUESTED',
      mergeStateStatus: 'BLOCKED',
      threads: [
        {
          id: 'thread-node-1',
          isResolved: false,
          isOutdated: false,
          path: 'src/app.ts',
          line: 42,
          comments: {
            nodes: [
              {
                id: 'comment-node-1',
                databaseId: 1001,
                body: 'Please fix this',
                bodyText: 'Please fix this',
                author: { login: 'reviewer-a' },
                createdAt: '2026-04-01T10:00:00Z',
                updatedAt: '2026-04-01T10:00:00Z',
              },
            ],
          },
        },
      ],
    });
    getPullRequestReviewsMock.mockResolvedValue([
      {
        state: 'CHANGES_REQUESTED',
        user: { login: 'reviewer-a' },
        submitted_at: '2026-04-01T10:05:00Z',
      },
    ]);
    getIssueCommentsMock.mockResolvedValue([
      {
        id: 2001,
        node_id: 'issue-comment-node-1',
        body: 'Top-level note',
        user: { login: 'reviewer-b', avatar_url: 'https://avatars.test/b.png', html_url: 'https://github.com/reviewer-b' },
        html_url: 'https://github.com/org/repo/pull/7#issuecomment-2001',
        created_at: '2026-04-01T09:00:00Z',
        updated_at: '2026-04-01T09:15:00Z',
      },
    ]);

    const result = await prReviewConversationService.syncConversations({
      project: { id: 'proj-1', user_id: 'user-1' },
      prReview: { id: 'pr-review-1', githubPrNumber: 7 },
      userId: 'user-1',
    });

    expect(getConversationThreadsMock).toHaveBeenCalledWith(123, 'AtlasAIEngine', 'AtlasEngineMVP', 7);
    expect(getIssueCommentsMock).toHaveBeenCalledWith(123, 'AtlasAIEngine', 'AtlasEngineMVP', 7);
    expect(getPullRequestReviewsMock).toHaveBeenCalledWith(123, 'AtlasAIEngine', 'AtlasEngineMVP', 7);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO github_pr_threads'))).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO github_pr_thread_comments'))).toBe(true);
    expect(queryMock.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO github_pr_issue_comments'))).toBe(true);
    expect(result.sync).toMatchObject({
      githubPrNumber: 7,
      pullRequestNodeId: 'pr-node-7',
      reviewDecision: 'CHANGES_REQUESTED',
      mergeStateStatus: 'BLOCKED',
      latestReviewState: 'CHANGES_REQUESTED',
      latestReviewAuthor: 'reviewer-a',
      threadCount: 1,
      issueCommentCount: 1,
    });
  });

  it('marks user-authored root inline review comments as editable and deletable', async () => {
    queryMock.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('FROM github_integrations')) {
        return { rows: [{ account_login: 'avinash-atlas' }], rowCount: 1 };
      }
      if (text.includes('FROM github_pr_threads')) {
        return {
          rows: [{
            thread_node_id: 'thread-node-1',
            github_pr_number: 7,
            is_resolved: false,
            is_outdated: false,
            path: 'src/app.ts',
            line: 42,
            comment_count: 1,
          }],
          rowCount: 1,
        };
      }
      if (text.includes('FROM github_pr_thread_comments')) {
        return {
          rows: [{
            comment_node_id: 'comment-node-root',
            thread_node_id: 'thread-node-1',
            database_id: 1001,
            reply_to_node_id: null,
            body: 'Root inline comment',
            body_text: 'Root inline comment',
            author_login: 'avinash-atlas',
            created_at_source: '2026-04-01T10:00:00.000Z',
            updated_at_source: '2026-04-01T10:00:00.000Z',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('FROM github_pr_issue_comments')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM pr_reviews')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });

    const result = await prReviewConversationService.listConversations('proj-1', 'pr-review-1', {
      userId: 'user-1',
    });

    expect(result.threads[0].comments[0]).toMatchObject({
      id: 'comment-node-root',
      replyToNodeId: null,
      canEdit: true,
      canDelete: true,
    });
  });

  it('creates a GitHub review thread comment and resyncs conversations', async () => {
    await prReviewConversationService.createThreadComment({
      project: { id: 'proj-1', user_id: 'user-1' },
      prReview: {
        id: 'pr-review-1',
        githubPrNumber: 7,
        headSha: 'head-sha-1',
      },
      userId: 'user-1',
      path: 'src/app.ts',
      line: 42,
      side: 'LEFT',
      body: 'Please update this line.',
    });

    expect(submitPullRequestReviewMock).toHaveBeenCalledWith(
      123,
      'AtlasAIEngine',
      'AtlasEngineMVP',
      7,
      {
        event: 'COMMENT',
        commitId: 'head-sha-1',
        comments: [{
          path: 'src/app.ts',
          line: 42,
          side: 'LEFT',
          body: 'Please update this line.',
        }],
      }
    );
    expect(getConversationThreadsMock).toHaveBeenCalledWith(123, 'AtlasAIEngine', 'AtlasEngineMVP', 7);
  });

  it('updates a user-authored root inline review comment', async () => {
    queryMock.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('FROM github_pr_thread_comments') && text.includes('comment_node_id = $3')) {
        return {
          rows: [{
            comment_node_id: 'comment-node-root',
            database_id: 1001,
            reply_to_node_id: null,
            author_login: 'avinash-atlas',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('FROM github_integrations')) {
        return { rows: [{ account_login: 'avinash-atlas' }], rowCount: 1 };
      }
      if (text.includes('FROM github_pr_threads')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM github_pr_thread_comments')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM github_pr_issue_comments')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM pr_reviews')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });

    await prReviewConversationService.updateThreadComment({
      project: { id: 'proj-1', user_id: 'user-1' },
      prReview: { id: 'pr-review-1', githubPrNumber: 7 },
      userId: 'user-1',
      commentNodeId: 'comment-node-root',
      body: 'Updated root comment',
    });

    expect(updatePullRequestReviewCommentMock).toHaveBeenCalledWith(
      123,
      'AtlasAIEngine',
      'AtlasEngineMVP',
      1001,
      'Updated root comment',
      { authMode: 'user' }
    );
  });

  it('deletes a user-authored root inline review comment', async () => {
    queryMock.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('FROM github_pr_thread_comments') && text.includes('comment_node_id = $3')) {
        return {
          rows: [{
            comment_node_id: 'comment-node-root',
            database_id: 1001,
            reply_to_node_id: null,
            author_login: 'avinash-atlas',
          }],
          rowCount: 1,
        };
      }
      if (text.includes('FROM github_integrations')) {
        return { rows: [{ account_login: 'avinash-atlas' }], rowCount: 1 };
      }
      if (text.includes('FROM github_pr_threads')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM github_pr_thread_comments')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM github_pr_issue_comments')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM pr_reviews')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });

    await prReviewConversationService.deleteThreadComment({
      project: { id: 'proj-1', user_id: 'user-1' },
      prReview: { id: 'pr-review-1', githubPrNumber: 7 },
      userId: 'user-1',
      commentNodeId: 'comment-node-root',
    });

    expect(deletePullRequestReviewCommentMock).toHaveBeenCalledWith(
      123,
      'AtlasAIEngine',
      'AtlasEngineMVP',
      1001,
      { authMode: 'user' }
    );
  });
});
