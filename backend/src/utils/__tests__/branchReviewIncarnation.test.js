import { describe, expect, it, vi } from 'vitest';

import { shouldRotateBranchReviewOnHeadChange } from '../branchReviewIncarnation.js';

describe('shouldRotateBranchReviewOnHeadChange', () => {
  it('returns false when head did not change', async () => {
    const gitService = { isAncestorRef: vi.fn() };

    await expect(shouldRotateBranchReviewOnHeadChange({
      projectPath: '/tmp/project',
      review: { headSha: 'abc123' },
      nextHeadSha: 'abc123',
      gitService,
    })).resolves.toBe(false);

    expect(gitService.isAncestorRef).not.toHaveBeenCalled();
  });

  it('returns false when previous head is an ancestor of the new head', async () => {
    const gitService = { isAncestorRef: vi.fn().mockResolvedValue(true) };

    await expect(shouldRotateBranchReviewOnHeadChange({
      projectPath: '/tmp/project',
      review: { headSha: 'abc123' },
      nextHeadSha: 'def456',
      gitService,
    })).resolves.toBe(false);

    expect(gitService.isAncestorRef).toHaveBeenCalledWith('/tmp/project', 'abc123', 'def456');
  });

  it('returns true when the new head is no longer descended from the previous head', async () => {
    const gitService = { isAncestorRef: vi.fn().mockResolvedValue(false) };

    await expect(shouldRotateBranchReviewOnHeadChange({
      projectPath: '/tmp/project',
      review: { headSha: 'abc123' },
      nextHeadSha: 'def456',
      gitService,
    })).resolves.toBe(true);
  });

  it('returns false when ancestry cannot be determined', async () => {
    const gitService = { isAncestorRef: vi.fn().mockRejectedValue(new Error('git failed')) };

    await expect(shouldRotateBranchReviewOnHeadChange({
      projectPath: '/tmp/project',
      review: { headSha: 'abc123' },
      nextHeadSha: 'def456',
      gitService,
    })).resolves.toBe(false);
  });
});
