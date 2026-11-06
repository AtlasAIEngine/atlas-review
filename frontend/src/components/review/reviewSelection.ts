export type UnifiedReviewItem = {
  id: string;
  type: 'branch_review' | 'pr_review' | 'workspace_review';
};

export type ReviewSelection = {
  id: string;
  type: 'branch_review' | 'pr_review' | 'workspace_review';
};

export type ReviewSelectionSource = 'auto' | 'explicit';

type CurrentBranchReviewCandidate = {
  id?: string | null;
  branchName?: string | null;
  status?: string | null;
  isCurrent?: boolean | null;
};

type CurrentWorkspaceReviewCandidate = {
  id?: string | null;
  branchName?: string | null;
  status?: string | null;
  isCurrent?: boolean | null;
};

export function resolveNextReviewSelection({
  selectedItemId,
  selectedItemType,
  combinedItems,
}: {
  selectedItemId: string | null;
  selectedItemType: 'branch_review' | 'pr_review' | 'workspace_review' | null;
  combinedItems: UnifiedReviewItem[];
}): ReviewSelection | null {
  if (!selectedItemId || !selectedItemType) {
    return combinedItems[0] || null;
  }

  const selectedStillExists = combinedItems.some(
    (item) => item.id === selectedItemId && item.type === selectedItemType
  );

  if (selectedStillExists) {
    return {
      id: selectedItemId,
      type: selectedItemType,
    };
  }

  return combinedItems[0] || null;
}

export function isExplicitReviewSelectionLocked({
  selection,
  source,
}: {
  selection: ReviewSelection | null;
  source: ReviewSelectionSource;
}): boolean {
  return Boolean(selection && source === 'explicit');
}

export function shouldContinueCurrentBranchDiscovery({
  currentBranchName,
  baseBranchName,
  branchReviews,
  hasWorkspaceReview,
}: {
  currentBranchName?: string | null;
  baseBranchName?: string | null;
  branchReviews: CurrentBranchReviewCandidate[];
  hasWorkspaceReview: boolean;
}): boolean {
  const currentBranch = String(currentBranchName || '').trim();
  if (!currentBranch) return false;

  const baseBranch = String(baseBranchName || '').trim();
  if (baseBranch && currentBranch === baseBranch) {
    return false;
  }

  if (hasWorkspaceReview) {
    return false;
  }

  return !branchReviews.some((review) => (
    String(review?.status || '').trim().toLowerCase() === 'active'
    && String(review?.branchName || '').trim() === currentBranch
  ));
}

function normalizeBranchName(value?: string | null): string {
  return String(value || '').trim();
}

function isSelectableBranchReviewStatus(value?: string | null): boolean {
  const status = String(value || '').trim().toLowerCase();
  return status === 'active' || status === 'stale';
}

function isSelectableWorkspaceReviewStatus(value?: string | null): boolean {
  return String(value || '').trim().toLowerCase() === 'active';
}

export function pickCurrentReviewSelection({
  branchReviews,
  workspaceReviews = [],
  currentBranchName,
}: {
  branchReviews: CurrentBranchReviewCandidate[];
  workspaceReviews?: CurrentWorkspaceReviewCandidate[];
  currentBranchName?: string | null;
}): ReviewSelection | null {
  const currentBranch = normalizeBranchName(currentBranchName);

  const currentBranchReview = branchReviews.find((review) => (
    !!review?.id
    && review.isCurrent === true
    && isSelectableBranchReviewStatus(review.status)
  ));
  if (currentBranchReview?.id) {
    return { id: currentBranchReview.id, type: 'branch_review' };
  }

  const matchingBranchReview = currentBranch
    ? branchReviews.find((review) => (
      !!review?.id
      && isSelectableBranchReviewStatus(review.status)
      && normalizeBranchName(review.branchName) === currentBranch
    ))
    : null;
  if (matchingBranchReview?.id) {
    return { id: matchingBranchReview.id, type: 'branch_review' };
  }

  const currentWorkspaceReview = workspaceReviews.find((review) => (
    !!review?.id
    && review.isCurrent === true
    && isSelectableWorkspaceReviewStatus(review.status)
  ));
  if (currentWorkspaceReview?.id) {
    return { id: currentWorkspaceReview.id, type: 'workspace_review' };
  }

  const matchingWorkspaceReview = currentBranch
    ? workspaceReviews.find((review) => (
      !!review?.id
      && isSelectableWorkspaceReviewStatus(review.status)
      && normalizeBranchName(review.branchName) === currentBranch
    ))
    : null;
  if (matchingWorkspaceReview?.id) {
    return { id: matchingWorkspaceReview.id, type: 'workspace_review' };
  }

  return null;
}
