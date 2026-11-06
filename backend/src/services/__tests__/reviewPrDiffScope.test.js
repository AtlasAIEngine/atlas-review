import { beforeEach, describe, expect, it, vi } from 'vitest';

import gitService from '../gitService.js';
import reviewService from '../reviewService.js';

describe('PR review diff scope resolution', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to delta after a completed PR baseline review when history is append-only', async () => {
    vi.spyOn(gitService, 'isAncestorRef').mockResolvedValue(true);

    const scope = await reviewService.__testing.resolvePrReviewDiffScope('/repo', {
      headSha: 'head-new',
      baseSha: 'base-1',
      reviewHeadSha: 'head-old',
      reviewedAt: '2026-03-15T10:00:00.000Z',
      reviewJson: {
        summary: 'Prior PR review',
        stats: {
          diffMergeBaseSha: 'base-1',
        },
      },
    }, {
      reviewMode: 'auto',
      headRef: 'head-new',
      prCommits: [
        { sha: 'head-old', message: 'feat: old' },
        { sha: 'head-new', message: 'feat: new' },
      ],
    });

    expect(scope.requestedMode).toBe('auto');
    expect(scope.mode).toBe('delta');
    expect(scope.diffBaseSha).toBe('head-old');
    expect(scope.diffHeadSha).toBe('head-new');
    expect(scope.deltaEligible).toBe(true);
    expect(scope.deltaFallbackReason).toBeNull();
  });

  it('runs delta scope when reviewMode=agentic_discovery and a baseline exists', async () => {
    vi.spyOn(gitService, 'isAncestorRef').mockResolvedValue(true);

    const scope = await reviewService.__testing.resolvePrReviewDiffScope('/repo', {
      headSha: 'head-new',
      baseSha: 'base-1',
      reviewHeadSha: 'head-old',
      reviewedAt: '2026-03-15T10:00:00.000Z',
      reviewJson: {
        summary: 'Prior PR review',
        stats: {
          diffMergeBaseSha: 'base-1',
        },
      },
    }, {
      reviewMode: 'agentic_discovery',
      headRef: 'head-new',
      prCommits: [
        { sha: 'head-old', message: 'feat: old' },
        { sha: 'head-new', message: 'feat: new' },
      ],
    });

    expect(scope.requestedMode).toBe('auto');
    expect(scope.mode).toBe('delta');
    expect(scope.deltaEligible).toBe(true);
    expect(scope.deltaFallbackReason).toBeNull();
  });

  it('forces a full PR rerun when reviewMode=full', async () => {
    const isAncestorSpy = vi.spyOn(gitService, 'isAncestorRef');

    const scope = await reviewService.__testing.resolvePrReviewDiffScope('/repo', {
      headSha: 'head-new',
      baseSha: 'base-1',
      reviewHeadSha: 'head-old',
      reviewedAt: '2026-03-15T10:00:00.000Z',
      reviewJson: {
        summary: 'Prior PR review',
        stats: {
          diffMergeBaseSha: 'base-1',
        },
      },
    }, {
      reviewMode: 'full',
      headRef: 'head-new',
    });

    expect(scope.mode).toBe('full');
    expect(scope.deltaEligible).toBe(false);
    expect(scope.deltaFallbackReason).toBe('forced_full_review');
    expect(isAncestorSpy).not.toHaveBeenCalled();
  });

  it('falls back to full when the PR base SHA changed after the prior review', async () => {
    const scope = await reviewService.__testing.resolvePrReviewDiffScope('/repo', {
      headSha: 'head-new',
      baseSha: 'base-2',
      reviewHeadSha: 'head-old',
      reviewedAt: '2026-03-15T10:00:00.000Z',
      reviewJson: {
        summary: 'Prior PR review',
        stats: {
          diffMergeBaseSha: 'base-1',
        },
      },
    }, {
      reviewMode: 'auto',
      headRef: 'head-new',
    });

    expect(scope.mode).toBe('full');
    expect(scope.deltaEligible).toBe(false);
    expect(scope.deltaFallbackReason).toBe('base_sha_changed');
  });

  it('reuses the persisted review when the PR head has no unreviewed commits', async () => {
    const scope = await reviewService.__testing.resolvePrReviewDiffScope('/repo', {
      headSha: 'head-same',
      baseSha: 'base-1',
      reviewHeadSha: 'head-same',
      reviewedAt: '2026-03-15T10:00:00.000Z',
      reviewJson: {
        summary: 'Prior PR review',
        stats: {
          diffMergeBaseSha: 'base-1',
        },
      },
    }, {
      reviewMode: 'auto',
      headRef: 'head-same',
    });

    expect(scope.mode).toBe('delta');
    expect(scope.skipReview).toBe(true);
    expect(scope.deltaFallbackReason).toBe('no_unreviewed_commits');
  });

  it('uses PR commit history as the ancestry fallback when local git is unavailable', async () => {
    const scope = await reviewService.__testing.resolvePrReviewDiffScope(null, {
      headSha: 'head-new',
      baseSha: 'base-1',
      reviewHeadSha: 'head-old',
      reviewedAt: '2026-03-15T10:00:00.000Z',
      reviewJson: {
        summary: 'Prior PR review',
        stats: {
          diffMergeBaseSha: 'base-1',
        },
      },
    }, {
      reviewMode: 'auto',
      headRef: 'head-new',
      prCommits: [
        { sha: 'head-old', message: 'feat: old' },
        { sha: 'head-new', message: 'feat: new' },
      ],
    });

    expect(scope.mode).toBe('delta');
    expect(scope.deltaEligible).toBe(true);
    expect(scope.deltaFallbackReason).toBeNull();
  });
});
