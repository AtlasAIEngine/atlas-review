import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../db/queries.js', () => ({
  getProjectById: vi.fn(),
}));
vi.mock('../../branchReviewService.js', () => ({ default: { getById: vi.fn() } }));
vi.mock('../../prReviewService.js', () => ({ default: { getById: vi.fn() } }));
vi.mock('../../workspaceReviewService.js', () => ({ default: { getById: vi.fn() } }));
vi.mock('../../changesetService.js', () => ({ default: { getChangeSet: vi.fn() } }));
vi.mock('../../reviewOutcomeService.js', () => ({
  default: {
    listOutcomes: vi.fn(),
    getRecommendationIdentityKey: vi.fn((rec) => rec?.recommendationKey || [
      rec?.type,
      rec?.severity,
      rec?.title,
      rec?.description,
      rec?.file,
      rec?.line,
      rec?.suggestedFix,
    ].map((part) => String(part || '').trim().toLowerCase()).join('|')),
  },
}));
vi.mock('../../prReviewConversationService.js', () => ({ default: { listConversations: vi.fn() } }));

import { getProjectById } from '../../../db/queries.js';
import prReviewService from '../../prReviewService.js';
import prReviewConversationService from '../../prReviewConversationService.js';
import reviewAgentContextService from '../reviewAgentContextService.js';

describe('reviewAgentContextService helpers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps only compact, supported attachments', () => {
    const attachments = reviewAgentContextService.__testing.normalizeAttachments([
      { type: 'finding', recommendationKey: ' Rec-1 ', findingId: ' f2 ' },
      { type: 'file', path: './src/App.tsx' },
      { type: 'line_range', path: 'src/App.tsx', startLine: 4, endLine: 2, side: 'right', selectedText: 'const answer = 42;' },
      { type: 'file', path: '../secret.txt' },
      { type: 'github_thread', threadNodeId: 'x' },
      { type: 'github_issue_comment', commentNodeId: 'y' },
    ]);

    expect(attachments).toEqual([
      { type: 'finding', recommendationKey: 'rec-1', findingId: 'F2' },
      { type: 'file', path: 'src/App.tsx' },
      { type: 'line_range', path: 'src/App.tsx', startLine: 4, endLine: 4, side: 'RIGHT', selectedText: 'const answer = 42;' },
      { type: 'github_thread', threadNodeId: 'x' },
      { type: 'github_issue_comment', commentNodeId: 'y' },
    ]);
  });

  it('formats a compact finding ID map for review assistant prompts', () => {
    const context = {
      project: { id: 'project-1', name: 'Atlas' },
      scope: { reviewType: 'branch_review', reviewId: 'review-1' },
      review: {
        status: 'reviewed',
        riskLevel: 'high',
        summary: 'Risk summary',
        findingCount: 1,
        highCount: 1,
      },
      findingRefs: [{
        findingId: 'F1',
        recommendationKey: 'issue|high|one',
        severity: 'high',
        title: 'One',
        file: 'src/App.tsx',
        line: 12,
      }],
      attachments: [],
    };

    const formatted = reviewAgentContextService.formatReviewAgentContext(context);
    expect(formatted).toContain('Finding ID map:');
    expect(formatted).toContain('- F1: high - One @ src/App.tsx:12');
    expect(formatted).toContain('recommendationKey: issue|high|one');
  });

  it('formats selected line-range text for review assistant prompts', () => {
    const context = {
      project: { id: 'project-1', name: 'Atlas' },
      scope: { reviewType: 'branch_review', reviewId: 'review-1' },
      review: {
        status: 'reviewed',
        riskLevel: 'medium',
        summary: 'Risk summary',
        findingCount: 0,
        highCount: 0,
      },
      findingRefs: [],
      attachments: [{
        type: 'line_range',
        path: 'src/App.tsx',
        startLine: 4,
        endLine: 6,
        side: 'RIGHT',
        selectedText: 'function App() {\n  return null;\n}',
      }],
    };

    const formatted = reviewAgentContextService.formatReviewAgentContext(context);
    expect(formatted).toContain('Attached line range: src/App.tsx:4-6');
    expect(formatted).toContain('Selected code:');
    expect(formatted).toContain('function App()');
  });

  it('finds selected findings by persisted recommendation key', () => {
    const reviewJson = {
      recommendations: [
        { recommendationKey: 'issue|high|one', title: 'One' },
      ],
      previousFindings: [
        { recommendationKey: 'issue|medium|two', title: 'Two' },
      ],
    };

    expect(reviewAgentContextService.__testing.findRecommendation(reviewJson, 'ISSUE|MEDIUM|TWO')).toMatchObject({
      title: 'Two',
    });
  });

  it('hydrates persisted GitHub review thread attachments for PR reviews', async () => {
    getProjectById.mockResolvedValue({
      id: 'project-1',
      name: 'Atlas',
      path: null,
      user_id: 'user-1',
    });
    prReviewService.getById.mockResolvedValue({
      id: 'review-1',
      projectId: 'project-1',
      reviewJson: { summary: 'Review summary', recommendations: [] },
      reviewStatus: 'completed',
    });
    prReviewConversationService.listConversations.mockResolvedValue({
      summary: { totalThreads: 1, openThreads: 1 },
      issueComments: [],
      threads: [{
        id: 'thread-1',
        nodeId: 'thread-1',
        isResolved: false,
        isOutdated: false,
        path: 'src/App.tsx',
        line: 42,
        side: 'RIGHT',
        commentCount: 1,
        comments: [{
          id: 'comment-1',
          nodeId: 'comment-1',
          authorLogin: 'reviewer',
          body: 'Please check this edge case.',
          diffHunk: '@@ -40,3 +40,4 @@',
        }],
      }],
    });

    const context = await reviewAgentContextService.hydrateContext({
      projectId: 'project-1',
      reviewType: 'pr_review',
      reviewId: 'review-1',
      attachments: [{ type: 'github_thread', threadNodeId: 'thread-1' }],
    });

    expect(prReviewConversationService.listConversations).toHaveBeenCalledWith('project-1', 'review-1', {
      userId: 'user-1',
    });
    expect(context.attachments[0].conversation.thread).toMatchObject({
      nodeId: 'thread-1',
      path: 'src/App.tsx',
      line: 42,
      comments: [{ authorLogin: 'reviewer', body: 'Please check this edge case.' }],
    });
    expect(reviewAgentContextService.formatReviewAgentContext(context)).toContain('Attached GitHub review thread: thread-1');
  });
});
