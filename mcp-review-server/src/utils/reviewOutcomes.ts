import type { AtlasApiClient } from '../client.js';
import type {
  ReviewOutcomeByRecommendationKey,
  ReviewOutcomesResponse,
  ReviewType,
} from '../types.js';

export async function listOutcomeLookup(
  client: AtlasApiClient,
  projectId: string,
  reviewType: ReviewType,
  reviewId: string
): Promise<ReviewOutcomesResponse> {
  const response = await client.listReviewOutcomes(projectId, reviewType, reviewId);
  return {
    ...response,
    outcomes: Array.isArray(response.outcomes) ? response.outcomes : [],
    byRecommendationKey: normalizeOutcomeLookup(response.byRecommendationKey),
    telemetry: response.telemetry || undefined,
  };
}

export function normalizeOutcomeLookup(
  value: unknown
): Record<string, ReviewOutcomeByRecommendationKey> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  const entries = Object.entries(value).filter(([, entry]) => (
    entry
    && typeof entry === 'object'
    && typeof (entry as ReviewOutcomeByRecommendationKey).recommendationKey === 'string'
  ));
  return Object.fromEntries(entries) as Record<string, ReviewOutcomeByRecommendationKey>;
}
