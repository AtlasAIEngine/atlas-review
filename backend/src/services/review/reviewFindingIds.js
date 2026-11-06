const FINDING_ID_PATTERN = /^F[1-9]\d*$/i;

function normalizeFindingId(value) {
  const normalized = String(value || '').trim().toUpperCase();
  return FINDING_ID_PATTERN.test(normalized) ? normalized : '';
}

function normalizeIdentityKey(value) {
  return String(value || '').trim().toLowerCase();
}

function getNextFindingId(usedIds) {
  let index = 1;
  while (usedIds.has(`F${index}`)) {
    index += 1;
  }
  return `F${index}`;
}

function collectRecommendationEntries(reviewPayload) {
  if (!reviewPayload || typeof reviewPayload !== 'object' || Array.isArray(reviewPayload)) {
    return [];
  }
  return [
    ...(Array.isArray(reviewPayload.recommendations) ? reviewPayload.recommendations : []),
    ...(Array.isArray(reviewPayload.previousFindings) ? reviewPayload.previousFindings : []),
  ].filter((entry) => entry && typeof entry === 'object' && !Array.isArray(entry));
}

function buildPreviousFindingIdLookup(previousReview = null) {
  const lookup = new Map();
  for (const entry of collectRecommendationEntries(previousReview)) {
    const key = normalizeIdentityKey(entry.recommendationKey);
    const findingId = normalizeFindingId(entry.findingId);
    if (key && findingId && !lookup.has(key)) {
      lookup.set(key, findingId);
    }
  }
  return lookup;
}

function assignFindingIdsToEntries(entries, previousLookup, usedIds) {
  return entries.map((entry) => {
    const next = { ...entry };
    const key = normalizeIdentityKey(next.recommendationKey);
    const existingId = normalizeFindingId(next.findingId);
    const previousId = key ? normalizeFindingId(previousLookup.get(key)) : '';
    const findingId = (existingId && !usedIds.has(existingId) ? existingId : '')
      || (previousId && !usedIds.has(previousId) ? previousId : '')
      || getNextFindingId(usedIds);
    usedIds.add(findingId);
    next.findingId = findingId;
    return next;
  });
}

export function assignReviewFindingIds(reviewPayload, {
  previousReview = null,
} = {}) {
  if (!reviewPayload || typeof reviewPayload !== 'object' || Array.isArray(reviewPayload)) {
    return reviewPayload;
  }

  const review = { ...reviewPayload };
  const previousLookup = buildPreviousFindingIdLookup(previousReview);
  const usedIds = new Set();

  if (Array.isArray(review.recommendations)) {
    review.recommendations = assignFindingIdsToEntries(review.recommendations, previousLookup, usedIds);
  }

  if (Array.isArray(review.previousFindings)) {
    review.previousFindings = assignFindingIdsToEntries(review.previousFindings, previousLookup, usedIds);
  }

  return review;
}

export default {
  assignReviewFindingIds,
};
