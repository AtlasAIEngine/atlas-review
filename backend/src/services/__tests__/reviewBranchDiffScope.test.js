import { beforeEach, describe, expect, it, vi } from 'vitest';

import gitService from '../gitService.js';
import reviewService from '../reviewService.js';

describe('branch review diff scope resolution', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('defaults to delta after a completed baseline review when history is append-only', async () => {
    vi.spyOn(gitService, 'isAncestorRef').mockResolvedValue(true);

    const scope = await reviewService.__testing.resolveBranchReviewDiffScope('/repo', {
      headSha: 'head-new',
      mergeBaseSha: 'merge-1',
      reviewHeadSha: 'head-old',
      reviewMergeBaseSha: 'merge-1',
      reviewedAt: '2026-03-15T10:00:00.000Z',
      reviewJson: {
        summary: 'Prior review',
        stats: {},
      },
    }, {
      reviewMode: 'auto',
      headRef: 'head-new',
    });

    expect(scope.requestedMode).toBe('auto');
    expect(scope.mode).toBe('delta');
    expect(scope.diffBaseSha).toBe('head-old');
    expect(scope.diffHeadSha).toBe('head-new');
    expect(scope.deltaEligible).toBe(true);
    expect(scope.deltaFallbackReason).toBeNull();
  });

  it('forces a full rerun when reviewMode=full', async () => {
    const isAncestorSpy = vi.spyOn(gitService, 'isAncestorRef');

    const scope = await reviewService.__testing.resolveBranchReviewDiffScope('/repo', {
      headSha: 'head-new',
      mergeBaseSha: 'merge-1',
      reviewHeadSha: 'head-old',
      reviewMergeBaseSha: 'merge-1',
      reviewedAt: '2026-03-15T10:00:00.000Z',
      reviewJson: {
        summary: 'Prior review',
        stats: {},
      },
    }, {
      reviewMode: 'full',
      headRef: 'head-new',
    });

    expect(scope.requestedMode).toBe('full');
    expect(scope.mode).toBe('full');
    expect(scope.deltaEligible).toBe(false);
    expect(scope.deltaFallbackReason).toBe('forced_full_review');
    expect(isAncestorSpy).not.toHaveBeenCalled();
  });

  it('uses two-dot scope for explicit last-commit branch reviews', async () => {
    const isAncestorSpy = vi.spyOn(gitService, 'isAncestorRef');

    const scope = await reviewService.__testing.resolveBranchReviewDiffScope('/repo', {
      headSha: 'head-latest',
      mergeBaseSha: 'head-parent',
      forkPointSha: 'head-parent',
      baseBranch: 'feature/review-polish~last-commit',
      baseBranchSource: 'last_commit',
      reviewHeadSha: 'head-old',
      reviewMergeBaseSha: 'head-old-parent',
      reviewedAt: '2026-05-07T10:00:00.000Z',
      reviewJson: {
        summary: 'Prior last commit review',
        stats: {},
      },
    }, {
      reviewMode: 'auto',
      headRef: 'head-latest',
    });

    expect(scope.requestedMode).toBe('auto');
    expect(scope.mode).toBe('full');
    expect(scope.diffBaseSha).toBe('head-parent');
    expect(scope.diffHeadSha).toBe('head-latest');
    expect(scope.branchMergeBaseSha).toBe('head-parent');
    expect(scope.branchForkPointSha).toBe('head-parent');
    expect(scope.deltaEligible).toBe(false);
    expect(scope.deltaFallbackReason).toBe('last_commit_scope');
    expect(scope.nameStatusLoader).toEqual(expect.any(Function));
    expect(scope.diffStatLoader).toEqual(expect.any(Function));
    expect(scope.fullDiffLoader).toEqual(expect.any(Function));
    expect(isAncestorSpy).not.toHaveBeenCalled();
  });

  it('falls back to full when the merge base changed after the prior review', async () => {
    const scope = await reviewService.__testing.resolveBranchReviewDiffScope('/repo', {
      headSha: 'head-new',
      mergeBaseSha: 'merge-2',
      reviewHeadSha: 'head-old',
      reviewMergeBaseSha: 'merge-1',
      reviewedAt: '2026-03-15T10:00:00.000Z',
      reviewJson: {
        summary: 'Prior review',
        stats: {},
      },
    }, {
      reviewMode: 'auto',
      headRef: 'head-new',
    });

    expect(scope.mode).toBe('full');
    expect(scope.deltaEligible).toBe(false);
    expect(scope.deltaFallbackReason).toBe('merge_base_changed');
  });

  it('stays on the delta path after the branch was merged into base, using fork_point_sha as the stable baseline anchor', async () => {
    // Scenario: branch was reviewed when merge-base was `fork-X`. The
    // branch then got merged into main (FF), so merge-base collapsed
    // to the branch tip — but fork_point_sha is preserved at `fork-X`.
    // A new commit lands on the branch. Re-review in auto mode must
    // stay on the delta path (reviewedHead..HEAD) instead of retrying
    // the full branch from fork-X.
    vi.spyOn(gitService, 'isAncestorRef').mockResolvedValue(true);

    const scope = await reviewService.__testing.resolveBranchReviewDiffScope('/repo', {
      headSha: 'head-new',
      mergeBaseSha: 'head-old', // collapsed to the old branch tip after FF-merge
      forkPointSha: 'fork-X', // preserved pre-merge anchor
      reviewHeadSha: 'head-old',
      reviewMergeBaseSha: 'fork-X',
      reviewedAt: '2026-03-15T10:00:00.000Z',
      reviewJson: {
        summary: 'Prior review',
        stats: {},
      },
    }, {
      reviewMode: 'auto',
      headRef: 'head-new',
    });

    expect(scope.mode).toBe('delta');
    expect(scope.diffBaseSha).toBe('head-old');
    expect(scope.diffHeadSha).toBe('head-new');
    expect(scope.deltaEligible).toBe(true);
    expect(scope.deltaFallbackReason).toBeNull();
    expect(scope.branchForkPointSha).toBe('fork-X');
    expect(scope.branchMergeBaseSha).toBe('head-old');
  });

  it('still falls back to full when fork_point_sha also does not match the reviewed baseline', async () => {
    // A genuine base change: fork_point_sha moved (rebase onto a new,
    // unrelated base). The reviewed baseline no longer matches either
    // the current merge-base or the current fork point — delta must
    // yield to a full re-review.
    const scope = await reviewService.__testing.resolveBranchReviewDiffScope('/repo', {
      headSha: 'head-new',
      mergeBaseSha: 'new-base',
      forkPointSha: 'new-base',
      reviewHeadSha: 'head-old',
      reviewMergeBaseSha: 'old-base',
      reviewedAt: '2026-03-15T10:00:00.000Z',
      reviewJson: {
        summary: 'Prior review',
        stats: {},
      },
    }, {
      reviewMode: 'auto',
      headRef: 'head-new',
    });

    expect(scope.mode).toBe('full');
    expect(scope.deltaEligible).toBe(false);
    expect(scope.deltaFallbackReason).toBe('merge_base_changed');
  });

  it('keys delta eligibility on review_fork_point_sha when the column is populated', async () => {
    // Fresh row (post-v0.60.0) where review completion snapshotted the
    // fork point. Delta is eligible iff the stored fork matches the
    // current fork, regardless of merge-base drift.
    vi.spyOn(gitService, 'isAncestorRef').mockResolvedValue(true);

    const scope = await reviewService.__testing.resolveBranchReviewDiffScope('/repo', {
      headSha: 'head-new',
      mergeBaseSha: 'head-new', // collapsed after FF-merge
      forkPointSha: 'fork-X',
      reviewHeadSha: 'head-old',
      reviewMergeBaseSha: 'fork-X',
      reviewForkPointSha: 'fork-X', // first-class snapshot matches current fork
      reviewedAt: '2026-03-15T10:00:00.000Z',
      reviewJson: { summary: 'Prior review', stats: {} },
    }, {
      reviewMode: 'auto',
      headRef: 'head-new',
    });

    expect(scope.mode).toBe('delta');
    expect(scope.deltaEligible).toBe(true);
    expect(scope.deltaFallbackReason).toBeNull();
  });

  it('falls back to full when review_fork_point_sha does not match current fork point', async () => {
    // Genuine shift: the reviewed fork and the current fork differ
    // (e.g., user rebased onto a completely new base between reviews).
    const scope = await reviewService.__testing.resolveBranchReviewDiffScope('/repo', {
      headSha: 'head-new',
      mergeBaseSha: 'new-base',
      forkPointSha: 'new-base',
      reviewHeadSha: 'head-old',
      reviewMergeBaseSha: 'old-fork',
      reviewForkPointSha: 'old-fork',
      reviewedAt: '2026-03-15T10:00:00.000Z',
      reviewJson: { summary: 'Prior review', stats: {} },
    }, {
      reviewMode: 'auto',
      headRef: 'head-new',
    });

    expect(scope.mode).toBe('full');
    expect(scope.deltaEligible).toBe(false);
    expect(scope.deltaFallbackReason).toBe('merge_base_changed');
  });

  it('legacy row (no review_fork_point_sha) still accepts delta via review_merge_base_sha', async () => {
    // Pre-v0.60.0 row: review_fork_point_sha is null, delta eligibility
    // falls back to the historical merge-base check.
    vi.spyOn(gitService, 'isAncestorRef').mockResolvedValue(true);

    const scope = await reviewService.__testing.resolveBranchReviewDiffScope('/repo', {
      headSha: 'head-new',
      mergeBaseSha: 'merge-1',
      reviewHeadSha: 'head-old',
      reviewMergeBaseSha: 'merge-1',
      reviewForkPointSha: null,
      reviewedAt: '2026-03-15T10:00:00.000Z',
      reviewJson: { summary: 'Prior review', stats: {} },
    }, {
      reviewMode: 'auto',
      headRef: 'head-new',
    });

    expect(scope.mode).toBe('delta');
    expect(scope.deltaEligible).toBe(true);
  });
});
