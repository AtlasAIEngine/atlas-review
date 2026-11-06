import { describe, expect, it } from 'vitest';

import { resolveTrackedBranchReviewStatus } from '../branchReviewStatus.js';

describe('resolveTrackedBranchReviewStatus', () => {
  it('keeps merged reviews merged when the branch still has no diff', () => {
    expect(resolveTrackedBranchReviewStatus({
      currentStatus: 'merged',
      fileCount: 0,
    })).toBe('merged');
  });

  it('reactivates merged reviews when the branch has new diff again', () => {
    expect(resolveTrackedBranchReviewStatus({
      currentStatus: 'merged',
      fileCount: 3,
    })).toBe('active');
  });

  it('keeps non-merged reviews active even when their net diff is zero', () => {
    expect(resolveTrackedBranchReviewStatus({
      currentStatus: 'active',
      fileCount: 0,
    })).toBe('active');
  });

  it('defaults to active when file count is unavailable', () => {
    expect(resolveTrackedBranchReviewStatus({
      currentStatus: 'merged',
      fileCount: null,
    })).toBe('active');
  });
});
