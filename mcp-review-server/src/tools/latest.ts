import type { AtlasApiClient } from '../client.js';
import type { AtlasConfig } from '../config.js';
import { AtlasMcpError } from '../errors.js';
import { formatLatestSummary } from '../formatters/reviewFormatter.js';
import { TOOL_NAMES } from '../toolNames.js';
import type { BranchReviewSummary, WorkspaceReviewSummary, LatestToolData, PrReviewSummary, ToolExecutionResult } from '../types.js';
import { getRecommendationIdentityKey, normalizeRecommendations } from '../utils/recommendationNormalization.js';
import { getFindingId } from '../utils/findingReferences.js';
import { toCompactBranchReview, toCompactPrReview, toCompactProjectSummary } from '../utils/reviewPayloadShapes.js';
import { listOutcomeLookup } from '../utils/reviewOutcomes.js';
import { resolveCurrentReviewContext, type ToolContextInput, type ToolContextResult } from './projectContext.js';

export interface LatestToolArgs extends ToolContextInput {}

export async function runLatestTool(
  client: AtlasApiClient,
  config: AtlasConfig,
  cwd: string,
  args: LatestToolArgs
): Promise<ToolExecutionResult<LatestToolData>> {
  const context = await resolveCurrentReviewContext(client, config, args, cwd);

  if (!context.review) {
    throw new AtlasMcpError('INVALID_INPUT', `No resolved review found for project ${context.project.name}.`);
  }

  const { reviewRecord, reviewType } = await loadResolvedReview(client, context.project.id, context);

  const reviewPayload = reviewRecord.reviewJson || null;
  const summary = reviewPayload?.summary || reviewRecord.reviewSummary || 'No review summary available.';
  const riskLevel = reviewPayload?.riskLevel || reviewRecord.reviewRiskLevel || 'unknown';
  const recommendations = [
    ...normalizeRecommendations(reviewPayload?.recommendations).map((item) => ({ item, previousFinding: false })),
    ...normalizeRecommendations(reviewPayload?.previousFindings).map((item) => ({ item, previousFinding: true })),
  ];
  const outcomes = await listOutcomeLookup(client, context.project.id, reviewType, reviewRecord.id);

  const findings = recommendations
    .filter(({ item }) => String(item.type || '').toLowerCase() !== 'praise')
    .slice(0, 10)
    .map(({ item, previousFinding }, index) => ({
      findingId: getFindingId(item, index),
      recommendationKey: getRecommendationIdentityKey(item),
      severity: String(item.severity || 'unknown'),
      title: String(item.title || item.description || 'Untitled finding'),
      previousFinding,
      file: item.file,
      line: item.line,
      outcome: outcomes.byRecommendationKey?.[getRecommendationIdentityKey(item)] || null,
    }));

  const data: LatestToolData = {
    project: toCompactProjectSummary(context.project),
    review: context.review,
    branchReview: reviewType !== 'pr_review' ? toCompactBranchReview(reviewRecord as BranchReviewSummary | WorkspaceReviewSummary) : null,
    prReview: reviewType === 'pr_review' ? toCompactPrReview(reviewRecord as PrReviewSummary) : null,
    summary,
    riskLevel,
    findings,
  };

  return {
    summary: formatLatestSummary(data),
    data,
    nextActions: [`Run ${TOOL_NAMES.status} to inspect queue/lifecycle state.`],
  };
}

async function loadResolvedReview(client: AtlasApiClient, projectId: string, context: ToolContextResult): Promise<{
  reviewRecord: BranchReviewSummary | WorkspaceReviewSummary | PrReviewSummary;
  reviewType: 'branch_review' | 'workspace_review' | 'pr_review';
}> {
  if (context.review?.type === 'pr_review' && context.prReview) {
    const prReview = await client.getPrReview(projectId, context.prReview.id);
    if (!prReview) {
      throw new AtlasMcpError('PR_REVIEW_NOT_FOUND', `PR review ${context.prReview.id} not found.`);
    }
    return { reviewRecord: prReview, reviewType: 'pr_review' };
  }

  if (context.review?.type === 'workspace_review' && context.branchReview) {
    const workspaceReview = await client.getWorkspaceReview(projectId, context.branchReview.id);
    if (!workspaceReview) {
      throw new AtlasMcpError('BRANCH_REVIEW_NOT_FOUND', `Workspace review ${context.branchReview.id} not found.`);
    }
    return { reviewRecord: workspaceReview, reviewType: 'workspace_review' };
  }

  if (!context.branchReview) {
    throw new AtlasMcpError('BRANCH_REVIEW_NOT_FOUND', `No branch review found for project ${context.project.name}. Create a branch review first.`);
  }
  const branchReview = await client.getBranchReview(projectId, context.branchReview.id);
  if (!branchReview) {
    throw new AtlasMcpError('BRANCH_REVIEW_NOT_FOUND', `Branch review ${context.branchReview.id} not found.`);
  }
  return { reviewRecord: branchReview, reviewType: 'branch_review' };
}
