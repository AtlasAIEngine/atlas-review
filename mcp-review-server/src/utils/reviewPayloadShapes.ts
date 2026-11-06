import type {
  BranchReviewSummary,
  WorkspaceReviewSummary,
  CompactProjectSummary,
  CompactQueueEntry,
  CompactReviewRecord,
  PrReviewSummary,
  ProjectSummary,
  ReviewQueueEntry,
} from '../types.js';

export function toCompactProjectSummary(project: ProjectSummary): CompactProjectSummary {
  return {
    id: project.id,
    name: project.name,
    path: project.path || null,
  };
}

export function toCompactBranchReview(review: BranchReviewSummary | WorkspaceReviewSummary | null | undefined): CompactReviewRecord | null {
  if (!review) return null;
  return {
    id: review.id,
    displayId: review.displayId || null,
    reviewStatus: review.reviewStatus || null,
    lifecycleStatus: review.reviewLifecycle?.status || null,
    branchName: review.branchName || null,
    baseBranch: review.baseBranch || null,
    updatedAt: review.updatedAt || null,
  };
}

export function toCompactPrReview(review: PrReviewSummary | null | undefined): CompactReviewRecord | null {
  if (!review) return null;
  return {
    id: review.id,
    displayId: review.displayId || null,
    reviewStatus: review.reviewStatus || null,
    lifecycleStatus: review.reviewLifecycle?.status || null,
    githubPrNumber: Number.isFinite(review.githubPrNumber) ? review.githubPrNumber : null,
    headBranch: review.headBranch || null,
    baseBranch: review.baseBranch || null,
    updatedAt: review.updatedAt || null,
  };
}

export function toCompactQueueEntry(entry: ReviewQueueEntry): CompactQueueEntry {
  return {
    id: entry.id ?? null,
    type: entry.type,
    status: entry.status || null,
    branchReviewId: entry.branchReviewId || null,
    workspaceReviewId: entry.workspaceReviewId || null,
    prReviewId: entry.prReviewId || null,
    queuedAt: entry.queuedAt || null,
    updatedAt: entry.updatedAt || null,
  };
}
