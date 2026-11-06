import { test, expect } from '@playwright/test';

import {
  isExplicitReviewSelectionLocked,
  pickCurrentReviewSelection,
  resolveNextReviewSelection,
  shouldContinueCurrentBranchDiscovery,
} from '../reviewSelection';

test.describe('review selection helpers', () => {
  test('keeps the existing selected item when it is still present', () => {
    expect(resolveNextReviewSelection({
      selectedItemId: 'br-1',
      selectedItemType: 'branch_review',
      combinedItems: [
        { id: 'br-1', type: 'branch_review' },
        { id: 'pr-1', type: 'pr_review' },
      ],
    })).toEqual({ id: 'br-1', type: 'branch_review' });
  });

  test('selects an isCurrent active branch review first', () => {
    expect(pickCurrentReviewSelection({
      currentBranchName: 'feature/current',
      branchReviews: [
        { id: 'br-other', branchName: 'feature/current', status: 'active', isCurrent: false },
        { id: 'br-current', branchName: 'feature/stored-current', status: 'active', isCurrent: true },
      ],
    })).toEqual({ id: 'br-current', type: 'branch_review' });
  });

  test('falls back to matching the current branch name when isCurrent is late', () => {
    expect(pickCurrentReviewSelection({
      currentBranchName: 'feature/current',
      branchReviews: [
        { id: 'br-old', branchName: 'feature/old', status: 'active', isCurrent: false },
        { id: 'br-current', branchName: 'feature/current', status: 'active', isCurrent: false },
      ],
    })).toEqual({ id: 'br-current', type: 'branch_review' });
  });

  test('allows stale branch reviews to be selected for refresh', () => {
    expect(pickCurrentReviewSelection({
      currentBranchName: 'feature/current',
      branchReviews: [
        { id: 'br-stale', branchName: 'feature/current', status: 'stale', isCurrent: false },
      ],
    })).toEqual({ id: 'br-stale', type: 'branch_review' });
  });

  test('falls back to a current workspace review when no branch review matches', () => {
    expect(pickCurrentReviewSelection({
      currentBranchName: 'main',
      branchReviews: [],
      workspaceReviews: [
        { id: 'ws-1', branchName: 'main', status: 'active', isCurrent: true },
      ],
    })).toEqual({ id: 'ws-1', type: 'workspace_review' });
  });

  test('continues discovery when current branch has no review or workspace snapshot', () => {
    expect(shouldContinueCurrentBranchDiscovery({
      currentBranchName: 'feature/current',
      baseBranchName: 'main',
      branchReviews: [{ branchName: 'feature/old', status: 'active' }],
      hasWorkspaceReview: false,
    })).toBe(true);
  });

  test('locks explicit branch selections against background current-branch discovery', () => {
    expect(isExplicitReviewSelectionLocked({
      selection: { id: 'br-explicit', type: 'branch_review' },
      source: 'explicit',
    })).toBe(true);
  });

  test('does not lock auto-selected current branch reviews', () => {
    expect(isExplicitReviewSelectionLocked({
      selection: { id: 'br-current', type: 'branch_review' },
      source: 'auto',
    })).toBe(false);
  });
});
