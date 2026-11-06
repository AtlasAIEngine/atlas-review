/** Review Aggregation — Chunk result merging, partial review annotation, and tier assignment. */

import { applyReviewQualityGuards } from './reviewPromptBuilder.js';
import { appendRuntimeClassTag } from './reviewErrorClassification.js';
import { normalizePrecisionIssueCounters } from './reviewCorroborationIntegration.js';
import { synthesizeLargeReviewSummary } from './reviewFileSelection.js';

// ---------------------------------------------------------------------------
// aggregateChunkReviews
// ---------------------------------------------------------------------------

function aggregateChunkReviews(chunkReviews, {
  fallbackSummary,
  fileCount,
  totalFileCount,
  focusedFileCount,
  omittedFileCount,
  filePaths,
  totalAdditions,
  totalDeletions,
  reviewPolicy = null,
}) {
  const riskOrder = { low: 0, medium: 1, high: 2, critical: 3 };
  const complexityOrder = { trivial: 0, simple: 1, moderate: 2, complex: 3 };

  let highestRisk = 'low';
  let highestComplexity = 'simple';

  const summaries = [];
  const changeGroups = [];
  const recommendations = [];
  const candidateFindings = [];
  const recKeys = new Set();
  const candidateKeys = new Set();

  let inputTokens = 0;
  let outputTokens = 0;
  let issuesTotal = 0;
  let issuesGrounded = 0;
  let issuesDemoted = 0;
  let issuesSuppressed = 0;

  for (const item of chunkReviews) {
    const review = item.review;

    if (review?.summary) summaries.push(review.summary);

    if (review?.riskLevel && riskOrder[review.riskLevel] > riskOrder[highestRisk]) {
      highestRisk = review.riskLevel;
    }

    if (Array.isArray(review?.changeGroups)) {
      changeGroups.push(...review.changeGroups);
    }

    if (Array.isArray(review?.recommendations)) {
      for (const rec of review.recommendations) {
        const key = `${rec.type}|${rec.title}|${rec.file || ''}|${rec.line || ''}`;
        if (recKeys.has(key)) continue;
        recKeys.add(key);
        recommendations.push(rec);
      }
    }

    if (Array.isArray(review?.candidateFindings)) {
      for (const candidate of review.candidateFindings) {
        const key = `${candidate.type}|${candidate.title}|${candidate.file || ''}|${candidate.line || ''}`;
        if (recKeys.has(key) || candidateKeys.has(key)) continue;
        candidateKeys.add(key);
        candidateFindings.push(candidate);
      }
    }

    const complexity = review?.stats?.estimatedComplexity || 'simple';
    if (complexityOrder[complexity] > complexityOrder[highestComplexity]) {
      highestComplexity = complexity;
    }

    issuesTotal += Math.max(0, Number(review?.stats?.issuesTotal || 0));
    issuesGrounded += Math.max(0, Number(review?.stats?.issuesGrounded || 0));
    issuesDemoted += Math.max(0, Number(review?.stats?.issuesDemoted || 0));
    issuesSuppressed += Math.max(0, Number(review?.stats?.issuesSuppressed || 0));

    inputTokens += item.tokensUsed?.input || 0;
    outputTokens += item.tokensUsed?.output || 0;
  }

  const combinedSummary = summaries.length > 0
    ? (summaries[0].length > 0 ? summaries[0] : fallbackSummary)
    : fallbackSummary;
  const synthesizedSummary = synthesizeLargeReviewSummary({
    chunkCount: chunkReviews.length,
    summaryText: combinedSummary,
    focusedFiles: focusedFileCount || fileCount || 0,
    totalFiles: totalFileCount || fileCount || focusedFileCount || 0,
    omittedFiles: omittedFileCount || 0,
    recommendations,
  });

  const mergedReview = applyReviewQualityGuards({
    summary: synthesizedSummary || combinedSummary,
    riskLevel: highestRisk,
    changeGroups,
    recommendations,
    candidateFindings,
    stats: {
      filesAnalyzed: fileCount || 0,
      totalAdditions: totalAdditions || 0,
      totalDeletions: totalDeletions || 0,
      estimatedComplexity: highestComplexity,
    },
  }, {
    filePaths: Array.isArray(filePaths) ? filePaths : [],
    fileCount: focusedFileCount || fileCount || 0,
    totalAdditions: totalAdditions || 0,
    totalDeletions: totalDeletions || 0,
    reviewPolicy,
  });
  mergedReview.stats.reviewMode = (omittedFileCount || 0) > 0 ? 'focused' : 'full';
  mergedReview.stats.filesDeepReviewed = focusedFileCount || fileCount || 0;
  mergedReview.stats.filesTotal = totalFileCount || fileCount || focusedFileCount || 0;
  mergedReview.stats.omittedFiles = omittedFileCount || 0;
  mergedReview.stats.chunkCount = chunkReviews.length;
  mergedReview.stats.issuesTotal = Math.max(0, Math.trunc(issuesTotal));
  mergedReview.stats.issuesGrounded = Math.max(0, Math.trunc(issuesGrounded));
  mergedReview.stats.issuesDemoted = Math.max(0, Math.trunc(issuesDemoted));
  mergedReview.stats.issuesSuppressed = Math.max(0, Math.trunc(issuesSuppressed));
  normalizePrecisionIssueCounters(mergedReview);

  return {
    review: mergedReview,
    tokensUsed: {
      input: inputTokens,
      output: outputTokens,
    },
  };
}

// ---------------------------------------------------------------------------
// annotatePartialReview
// ---------------------------------------------------------------------------

function annotatePartialReview(reviewPayload, {
  completedChunks = 0,
  totalChunks = 0,
  errorMessage = 'Chunk analysis failed before completion.',
  errorClass = null,
  remainingChunkStatus = 'failed',
} = {}) {
  if (!reviewPayload || typeof reviewPayload !== 'object') return reviewPayload;
  const safeCompleted = Math.max(0, Number(completedChunks) || 0);
  const safeTotal = Math.max(safeCompleted, Number(totalChunks) || 0);
  const reason = appendRuntimeClassTag(
    String(errorMessage || 'Chunk analysis failed before completion.').trim(),
    errorClass
  );

  const review = reviewPayload.review || {};
  if (!review.stats || typeof review.stats !== 'object') {
    review.stats = {};
  }
  review.stats.isPartial = true;
  review.stats.partialChunksCompleted = safeCompleted;
  review.stats.partialChunksTotal = safeTotal;
  review.stats.partialReason = reason;

  const normalizedStatus = String(remainingChunkStatus || '').trim().toLowerCase();
  const remainingNote = normalizedStatus === 'skipped'
    ? `Remaining chunks were skipped (${reason}).`
    : `Remaining chunks failed (${reason}).`;
  const partialNote = `Partial review: analyzed ${safeCompleted}/${safeTotal || safeCompleted} chunk(s). ${remainingNote}`;
  review.summary = `${String(review.summary || '').trim()} ${partialNote}`.trim();
  if (safeCompleted === 0 && review.riskLevel === 'low') {
    review.riskLevel = 'medium';
  }
  reviewPayload.review = review;
  return reviewPayload;
}

// ---------------------------------------------------------------------------
// assignReviewTier
// ---------------------------------------------------------------------------

function assignReviewTier(review) {
  if (!review || typeof review !== 'object') return review;
  if (!review.stats || typeof review.stats !== 'object') {
    review.stats = {};
  }
  const recommendationCount = Array.isArray(review.recommendations) ? review.recommendations.length : 0;
  const changeGroupCount = Array.isArray(review.changeGroups) ? review.changeGroups.length : 0;
  const partialFlag = review.stats.isPartial === true;
  const perFileFailures = Math.max(0, Number(review.stats.perFileFailedFiles) || 0);

  let tier = 'full';
  if (partialFlag || perFileFailures > 0) {
    tier = 'partial';
  } else if (recommendationCount > 0 && changeGroupCount === 0) {
    tier = 'files_only';
  }

  review.stats.reviewTier = tier;
  return review;
}

// ---------------------------------------------------------------------------
// buildDeadlinePartialAggregate
// ---------------------------------------------------------------------------

function buildDeadlinePartialAggregate({
  fallbackSummary = 'Automated review timed out before completion.',
  fileCount = 0,
  totalFileCount = fileCount,
  focusedFileCount = fileCount,
  omittedFileCount = 0,
  filePaths = [],
  totalAdditions = 0,
  totalDeletions = 0,
  totalChunks = 1,
  errorMessage = 'Review deadline exceeded',
  errorClass = null,
} = {}) {
  const aggregate = aggregateChunkReviews([], {
    fallbackSummary,
    fileCount,
    totalFileCount,
    focusedFileCount,
    omittedFileCount,
    filePaths,
    totalAdditions,
    totalDeletions,
  });
  annotatePartialReview(aggregate, {
    completedChunks: 0,
    totalChunks,
    errorMessage,
    errorClass,
  });
  return aggregate;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  aggregateChunkReviews,
  annotatePartialReview,
  assignReviewTier,
  buildDeadlinePartialAggregate,
};
