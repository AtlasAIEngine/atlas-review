function hasPersistedBranchReviewSnapshot(review = {}) {
  if (!review || typeof review !== 'object') return false;

  return [
    review.reviewStatus,
    review.review_status,
    review.reviewSummary,
    review.review_summary,
    review.reviewJson,
    review.review_json,
    review.reviewHeadSha,
    review.review_head_sha,
    review.reviewMergeBaseSha,
    review.review_merge_base_sha,
    review.reviewBaseBranch,
    review.review_base_branch,
    review.reviewedAt,
    review.reviewed_at,
  ].some((value) => {
    if (value == null) return false;
    if (typeof value === 'string') return value.trim().length > 0 && value.trim().toLowerCase() !== 'none';
    return true;
  });
}

function getClearedBranchReviewSnapshotFields() {
  return {
    review_status: 'none',
    review_risk_level: null,
    review_summary: null,
    review_json: null,
    review_error: null,
    review_base_branch: null,
    review_merge_base_sha: null,
    review_head_sha: null,
    reviewed_at: null,
  };
}

export {
  getClearedBranchReviewSnapshotFields,
  hasPersistedBranchReviewSnapshot,
};
