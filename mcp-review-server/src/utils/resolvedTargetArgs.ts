import type { ToolContextResult } from '../tools/projectContext.js';

export function toResolvedTargetArgs(context: ToolContextResult): Record<string, string> {
  if (context.review?.type === 'pr_review' && context.prReview) {
    return {
      projectId: context.project.id,
      reviewType: 'pr_review',
      prReviewId: context.prReview.id,
    };
  }

  if (context.review?.type === 'workspace_review' && context.branchReview) {
    return {
      projectId: context.project.id,
      reviewType: 'workspace_review',
      workspaceReviewId: context.branchReview.id,
    };
  }

  if (context.branchReview) {
    return {
      projectId: context.project.id,
      reviewType: 'branch_review',
      branchReviewId: context.branchReview.id,
    };
  }

  return { projectId: context.project.id };
}
