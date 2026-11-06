import { afterEach, describe, expect, it, vi } from 'vitest';
import reviewService from '../reviewService.js';
import reviewOutcomeService from '../reviewOutcomeService.js';

function recommendation(overrides = {}) {
  return {
    type: 'issue',
    severity: 'medium',
    title: 'Persisted issue',
    description: 'The issue remains open.',
    file: 'src/example.js',
    line: 12,
    suggestedFix: 'Fix the issue.',
    ...overrides,
  };
}

function recommendationKey(rec) {
  return reviewOutcomeService.__testing.getRecommendationIdentityKey(rec);
}

describe('previous branch review findings', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('carries unresolved findings while filtering repeated and outcome-resolved findings', async () => {
    const carried = recommendation({
      title: 'Carry me forward',
      description: 'This was not repeated.',
      file: 'src/carry.js',
    });
    const repeated = recommendation({
      title: 'Repeated in latest review',
      description: 'The new review found this again.',
      file: 'src/repeated.js',
    });
    const addressed = recommendation({
      title: 'Already addressed',
      description: 'The user marked this addressed.',
      file: 'src/addressed.js',
    });
    const addressedKey = recommendationKey(addressed);

    vi.spyOn(reviewOutcomeService, 'listOutcomes').mockResolvedValue({
      byRecommendationKey: {
        [addressedKey]: {
          recommendationKey: addressedKey,
          status: 'addressed',
          updatedAt: '2026-04-22T10:00:00.000Z',
        },
      },
    });

    const previousFindings = await reviewService.__testing.collectPreviousUnresolvedBranchFindings({
      projectId: 'project-1',
      branchReviewId: 'br-1',
      previousReview: {
        reviewedAt: '2026-04-22T09:00:00.000Z',
        recommendations: [carried, repeated, addressed],
      },
      nextReview: {
        recommendations: [repeated],
      },
      previousHeadSha: 'abc123',
    });

    expect(previousFindings).toHaveLength(1);
    expect(previousFindings[0]).toEqual(expect.objectContaining({
      title: 'Carry me forward',
      recommendationKey: recommendationKey(carried),
      previousFinding: true,
      previousFindingMeta: {
        source: 'branch_review',
        lastSeenAt: '2026-04-22T09:00:00.000Z',
        lastSeenHeadSha: 'abc123',
      },
    }));
  });

  it('keeps transitive carried findings and dedupes them against current recommendations', async () => {
    const original = recommendation({
      title: 'Original finding',
      description: 'Came from recommendations.',
      file: 'src/original.js',
    });
    const transitive = recommendation({
      title: 'Transitive carried finding',
      description: 'Was already carried once.',
      file: 'src/transitive.js',
      previousFinding: true,
      previousFindingMeta: {
        source: 'branch_review',
        lastSeenAt: '2026-04-21T09:00:00.000Z',
        lastSeenHeadSha: 'oldsha',
      },
    });
    const repeatedTransitive = { ...transitive };

    vi.spyOn(reviewOutcomeService, 'listOutcomes').mockResolvedValue({
      byRecommendationKey: {},
    });

    const previousFindings = await reviewService.__testing.collectPreviousUnresolvedBranchFindings({
      projectId: 'project-1',
      branchReviewId: 'br-1',
      previousReview: {
        recommendations: [original],
        previousFindings: [transitive],
      },
      nextReview: {
        recommendations: [repeatedTransitive],
      },
      previousHeadSha: 'newsha',
    });

    expect(previousFindings.map((entry) => entry.title)).toEqual(['Original finding']);
    expect(previousFindings[0].previousFindingMeta.lastSeenHeadSha).toBe('newsha');
  });

  it('does not carry candidate findings that were not promoted to recommendations', async () => {
    const candidate = recommendation({
      type: 'suggestion',
      severity: 'medium',
      title: 'Candidate carry',
      description: 'This was stored outside recommendations.',
      file: 'src/candidate.js',
    });

    vi.spyOn(reviewOutcomeService, 'listOutcomes').mockResolvedValue({
      byRecommendationKey: {},
    });

    const previousFindings = await reviewService.__testing.collectPreviousUnresolvedBranchFindings({
      projectId: 'project-1',
      branchReviewId: 'br-1',
      previousReview: {
        recommendations: [],
        candidateFindings: [candidate],
      },
      nextReview: {
        recommendations: [],
      },
      previousHeadSha: 'candidatesha',
    });

    expect(previousFindings).toEqual([]);
  });

  it('attaches unresolved prior findings to the next branch review payload', async () => {
    const prior = recommendation({
      title: 'Previously surfaced issue',
      description: 'This should remain visible if the next run misses it.',
      file: 'src/prior.js',
    });
    const nextReview = {
      stats: {
        filesAnalyzed: 1,
      },
      recommendations: [],
    };

    vi.spyOn(reviewOutcomeService, 'listOutcomes').mockResolvedValue({
      byRecommendationKey: {},
    });

    await reviewService.__testing.attachPreviousUnresolvedBranchFindings({
      projectId: 'project-1',
      branchReviewId: 'br-1',
      previousReview: {
        reviewedAt: '2026-04-22T09:00:00.000Z',
        recommendations: [prior],
      },
      nextReview,
      previousHeadSha: 'prior-head',
    });

    expect(nextReview.previousFindings).toHaveLength(1);
    expect(nextReview.previousFindings[0]).toEqual(expect.objectContaining({
      title: 'Previously surfaced issue',
      recommendationKey: recommendationKey(prior),
      previousFinding: true,
    }));
    expect(nextReview.stats.previousUnresolvedFindings).toBe(1);
  });

  it('summarizes carried previous findings for delta prompt context', () => {
    const summary = reviewService.__testing.summarizePriorReviewFindings({
      recommendations: [
        recommendation({
          title: 'Current previous review issue',
          file: 'src/current.js',
        }),
      ],
      previousFindings: [
        recommendation({
          title: 'Carried issue',
          file: 'src/carried.js',
        }),
      ],
    }, 5);

    expect(summary).toEqual([
      '[medium] src/current.js: Current previous review issue',
      '[medium] src/carried.js: Carried issue',
    ]);
  });
});
