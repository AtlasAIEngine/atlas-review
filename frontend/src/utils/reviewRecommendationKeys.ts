import type { ReviewRecommendation } from '@/types';

export function normalizeRecommendationKeyPart(value: unknown): string {
  return String(value ?? '')
    .replace(/\\+\|/g, '\\|')
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, '\'')
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function escapeRecommendationKeyPart(value: string): string {
  return value.replace(/\|/g, '\\|');
}

export function buildReviewRecommendationKey(rec: Pick<
  ReviewRecommendation,
  'type' | 'severity' | 'title' | 'description' | 'file' | 'line' | 'targetSnippet' | 'suggestedFix' | 'recommendationKey'
>): string {
  const explicitKey = normalizeRecommendationKeyPart(rec.recommendationKey);
  if (explicitKey) return explicitKey;
  return [
    escapeRecommendationKeyPart(normalizeRecommendationKeyPart(rec.type)),
    escapeRecommendationKeyPart(normalizeRecommendationKeyPart(rec.severity)),
    escapeRecommendationKeyPart(normalizeRecommendationKeyPart(rec.title)),
    escapeRecommendationKeyPart(normalizeRecommendationKeyPart(rec.description)),
    escapeRecommendationKeyPart(normalizeRecommendationKeyPart(rec.file)),
    escapeRecommendationKeyPart(normalizeRecommendationKeyPart(rec.line)),
    escapeRecommendationKeyPart(normalizeRecommendationKeyPart(rec.suggestedFix)),
  ].join('|');
}

export function buildLegacyReviewRecommendationKey(rec: Pick<
  ReviewRecommendation,
  'type' | 'severity' | 'title' | 'description' | 'file' | 'line' | 'targetSnippet' | 'suggestedFix'
>): string {
  return [
    normalizeRecommendationKeyPart(rec.type),
    normalizeRecommendationKeyPart(rec.severity),
    normalizeRecommendationKeyPart(rec.title),
    normalizeRecommendationKeyPart(rec.description),
    normalizeRecommendationKeyPart(rec.file),
    normalizeRecommendationKeyPart(rec.line),
    normalizeRecommendationKeyPart(rec.suggestedFix),
  ].join('|');
}
