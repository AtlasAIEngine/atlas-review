import type { AtlasApiClient } from '../client.js';
import { AtlasMcpError } from '../errors.js';
import type { ReviewRecommendation } from '../types.js';
import type { OutcomeToolContextResult } from '../tools/projectContext.js';
import { getRecommendationIdentityKey, normalizeRecommendations } from './recommendationNormalization.js';

export function normalizeFindingId(value: unknown): string | undefined {
  const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
  return /^F[1-9]\d*$/.test(normalized) ? normalized : undefined;
}

export function getFindingId(recommendation: ReviewRecommendation, index: number): string {
  return normalizeFindingId(recommendation.findingId) || `F${index + 1}`;
}

export async function resolveRecommendationKeyFromFindingReference(
  client: AtlasApiClient,
  context: OutcomeToolContextResult,
  input: {
    recommendationKey?: unknown;
    findingId?: unknown;
  }
): Promise<string | undefined> {
  const directKey = normalizeRecommendationKey(input.recommendationKey);
  if (directKey) return directKey;

  const findingId = normalizeFindingId(input.findingId);
  if (!findingId) return undefined;

  const reviewPayload = await loadReviewPayload(client, context);
  const recommendations = [
    ...normalizeRecommendations(reviewPayload?.recommendations),
    ...normalizeRecommendations(reviewPayload?.previousFindings),
  ].filter((item) => String(item.type || '').toLowerCase() !== 'praise');

  for (let index = 0; index < recommendations.length; index += 1) {
    const recommendation = recommendations[index];
    if (getFindingId(recommendation, index) === findingId) {
      return getRecommendationIdentityKey(recommendation);
    }
  }

  throw new AtlasMcpError(
    'INVALID_INPUT',
    `Finding ID ${findingId} was not found in ${context.review.label}. Run atlas_review_latest or atlas://review/current/findings for current IDs.`
  );
}

function normalizeRecommendationKey(value: unknown): string | undefined {
  if (value == null) return undefined;
  const normalized = String(value).trim();
  return normalized || undefined;
}

async function loadReviewPayload(
  client: AtlasApiClient,
  context: OutcomeToolContextResult
): Promise<{
  recommendations?: ReviewRecommendation[];
  previousFindings?: ReviewRecommendation[];
} | null> {
  if (context.review.type === 'pr_review') {
    const prReview = await client.getPrReview(context.project.id, context.review.id);
    return prReview?.reviewJson || context.prReview?.reviewJson || null;
  }
  if (context.review.type === 'workspace_review') {
    const workspaceReview = await client.getWorkspaceReview(context.project.id, context.review.id);
    return workspaceReview?.reviewJson || context.branchReview?.reviewJson || null;
  }
  if (context.review.type === 'changeset') {
    const changeset = context.changeset || await client.getChangeset(context.project.id, context.review.id);
    return changeset?.reviewJson || null;
  }
  const branchReview = await client.getBranchReview(context.project.id, context.review.id);
  return branchReview?.reviewJson || context.branchReview?.reviewJson || null;
}
