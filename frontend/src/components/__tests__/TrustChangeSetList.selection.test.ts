import { test, expect } from '@playwright/test';
import {
  resolveNextReviewSelection,
  shouldContinueCurrentBranchDiscovery,
} from '../review/reviewSelection';

test.describe('resolveNextReviewSelection', () => {
  test('defaults to the first available item when nothing is selected', () => {
    expect(resolveNextReviewSelection({
      selectedItemId: null,
      selectedItemType: null,
      combinedItems: [
        { id: 'br-1', type: 'branch_review' },
        { id: 'pr-1', type: 'pr_review' },
      ],
    })).toEqual({ id: 'br-1', type: 'branch_review' });
  });

  test('keeps the current selection when it still exists in the loaded lists', () => {
    expect(resolveNextReviewSelection({
      selectedItemId: 'pr-1',
      selectedItemType: 'pr_review',
      combinedItems: [{ id: 'pr-1', type: 'pr_review' }],
    })).toEqual({ id: 'pr-1', type: 'pr_review' });
  });

  test('falls back to the first current item when the held selection is stale', () => {
    expect(resolveNextReviewSelection({
      selectedItemId: 'pr-old',
      selectedItemType: 'pr_review',
      combinedItems: [
        { id: 'br-current', type: 'branch_review' },
        { id: 'pr-1', type: 'pr_review' },
      ],
    })).toEqual({ id: 'br-current', type: 'branch_review' });
  });

  test('clears the stale selection when no valid review items remain', () => {
    expect(resolveNextReviewSelection({
      selectedItemId: 'br-old',
      selectedItemType: 'branch_review',
      combinedItems: [],
    })).toBeNull();
  });

  test('drops a hidden merged branch review selection when only the new branch placeholder remains', () => {
    expect(resolveNextReviewSelection({
      selectedItemId: 'br-merged-old',
      selectedItemType: 'branch_review',
      combinedItems: [],
    })).toBeNull();
  });
});

test.describe('shouldContinueCurrentBranchDiscovery', () => {
  test('retries first-load discovery for a topic branch with no active review yet', () => {
    expect(shouldContinueCurrentBranchDiscovery({
      currentBranchName: 'feature/topic',
      baseBranchName: 'develop',
      branchReviews: [],
      hasWorkspaceReview: false,
    })).toBe(true);
  });

  test('stops retrying once the current branch review appears', () => {
    expect(shouldContinueCurrentBranchDiscovery({
      currentBranchName: 'feature/topic',
      baseBranchName: 'develop',
      branchReviews: [
        { branchName: 'feature/topic', status: 'active' },
      ],
      hasWorkspaceReview: false,
    })).toBe(false);
  });

  test('does not retry for the base branch placeholder state', () => {
    expect(shouldContinueCurrentBranchDiscovery({
      currentBranchName: 'develop',
      baseBranchName: 'develop',
      branchReviews: [],
      hasWorkspaceReview: false,
    })).toBe(false);
  });
});
