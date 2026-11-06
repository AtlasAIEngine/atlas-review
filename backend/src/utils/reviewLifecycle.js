const LEGACY_REVIEW_STATUSES = new Set(['none', 'queued', 'reviewing', 'reviewed', 'failed']);
const CANONICAL_LIFECYCLE_STATUSES = new Set(['queued', 'running', 'retrying', 'partial', 'failed', 'completed']);
const ACTIVE_LIFECYCLE_STATUSES = new Set(['queued', 'running', 'retrying']);
const TERMINAL_LIFECYCLE_STATUSES = new Set(['partial', 'failed', 'completed']);
const RETRY_PROGRESS_PHASES = new Set(['provider_retry', 'retrying']);
const PARTIAL_PROGRESS_PHASES = new Set(['partial', 'chunk_partial', 'single_partial', 'file_partial']);
const ACTIVE_PROGRESS_PHASES = new Set([
  'queued',
  'reviewing',
  'running',
  'retrying',
  'preparing_files',
  'file_triage',
  'file_review_start',
  'file_review_inflight',
  'file_review_failed',
  'file_partial',
  'single_start',
  'single_inflight',
  'chunk_start',
  'chunk_inflight',
  'chunk_split',
  'provider_retry',
  'synthesizing',
]);
const VALID_QUEUE_STATUSES = new Set([
  'queued',
  'reviewing',
  'reviewed',
  'failed',
  'running',
  'retrying',
  'partial',
  'completed',
]);
const LEGACY_TO_CANONICAL_STATUS = Object.freeze({
  none: 'completed',
  queued: 'queued',
  reviewing: 'running',
  reviewed: 'completed',
  failed: 'failed',
});
const REVIEW_ACTION_STALE_REASONS = Object.freeze({
  headMismatch: 'head_mismatch',
  baseMismatch: 'base_mismatch',
  mergeBaseMismatch: 'merge_base_mismatch',
});

function toNullableString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeReviewStatus(value, fallback = 'none') {
  const normalized = String(value || '').trim().toLowerCase();
  if (LEGACY_REVIEW_STATUSES.has(normalized)) return normalized;
  return LEGACY_REVIEW_STATUSES.has(fallback) ? fallback : 'none';
}

function mapLegacyReviewStatusToLifecycleStatus(reviewStatus, fallback = 'none') {
  const normalized = normalizeReviewStatus(reviewStatus, fallback);
  return LEGACY_TO_CANONICAL_STATUS[normalized] || 'queued';
}

function normalizeLifecycleStatus(value, fallback = 'queued') {
  const normalized = String(value || '').trim().toLowerCase();
  if (CANONICAL_LIFECYCLE_STATUSES.has(normalized)) return normalized;
  if (LEGACY_REVIEW_STATUSES.has(normalized)) {
    return mapLegacyReviewStatusToLifecycleStatus(normalized);
  }
  const normalizedFallback = String(fallback || '').trim().toLowerCase();
  if (CANONICAL_LIFECYCLE_STATUSES.has(normalizedFallback)) return normalizedFallback;
  if (LEGACY_REVIEW_STATUSES.has(normalizedFallback)) {
    return mapLegacyReviewStatusToLifecycleStatus(normalizedFallback);
  }
  return 'queued';
}

function mapLifecycleStatusToPhase(lifecycleStatus, sourceStatus = null) {
  const normalizedSourceStatus = String(sourceStatus || '').trim().toLowerCase();
  if (lifecycleStatus === 'queued') return 'queued';
  if (lifecycleStatus === 'running') return 'running';
  if (lifecycleStatus === 'retrying') return 'retrying';
  if (lifecycleStatus === 'partial') return 'partial';
  if (lifecycleStatus === 'failed') return 'failed';
  if (lifecycleStatus === 'completed') {
    return normalizedSourceStatus === 'none' ? 'idle' : 'complete';
  }
  return 'idle';
}

function normalizeQueueStatus(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_QUEUE_STATUSES.has(normalized) ? normalized : 'queued';
}

function mapQueueStatusToLifecycleStatus(queueStatus) {
  if (queueStatus === 'queued') return 'queued';
  if (queueStatus === 'reviewing' || queueStatus === 'running') return 'running';
  if (queueStatus === 'retrying') return 'retrying';
  if (queueStatus === 'partial') return 'partial';
  if (queueStatus === 'reviewed' || queueStatus === 'completed') return 'completed';
  if (queueStatus === 'failed') return 'failed';
  return 'queued';
}

function mapQueueStatusToReviewStatus(queueStatus) {
  return mapQueueStatusToLifecycleStatus(queueStatus);
}

function isActiveProgressPhase(phase) {
  const normalized = String(phase || '').trim().toLowerCase();
  if (!normalized) return false;
  return ACTIVE_PROGRESS_PHASES.has(normalized);
}

function resolveLifecycleStatus({
  lifecycleStatus,
  phase,
  errorMessage,
} = {}) {
  const normalizedStatus = normalizeLifecycleStatus(lifecycleStatus);
  const normalizedPhase = String(phase || '').trim().toLowerCase();
  const hasErrorMessage = Boolean(toNullableString(errorMessage));

  if (TERMINAL_LIFECYCLE_STATUSES.has(normalizedStatus)) {
    if (
      normalizedStatus === 'completed'
      && (hasErrorMessage || PARTIAL_PROGRESS_PHASES.has(normalizedPhase))
    ) {
      return 'partial';
    }
    return normalizedStatus;
  }

  if (RETRY_PROGRESS_PHASES.has(normalizedPhase)) return 'retrying';
  if (normalizedPhase === 'queued') return 'queued';
  if (isActiveProgressPhase(normalizedPhase)) return 'running';

  if (normalizedStatus === 'retrying') return 'retrying';
  if (normalizedStatus === 'running') return 'running';
  if (normalizedStatus === 'queued') return 'queued';
  return normalizedStatus;
}

function buildReviewLifecycle({
  reviewStatus = 'none',
  progress = null,
  errorMessage = null,
  updatedAt = null,
  reviewedAt = null,
  sourceStatus = null,
} = {}) {
  const normalizedSourceStatus = String(sourceStatus || reviewStatus || '').trim().toLowerCase() || null;
  const sourceLifecycleStatus = normalizeLifecycleStatus(
    reviewStatus,
    mapLegacyReviewStatusToLifecycleStatus(reviewStatus)
  );
  const normalizedPhase = toNullableString(progress?.phase)
    || mapLifecycleStatusToPhase(sourceLifecycleStatus, normalizedSourceStatus);
  const resolvedStatus = resolveLifecycleStatus({
    lifecycleStatus: sourceLifecycleStatus,
    phase: normalizedPhase,
    errorMessage: errorMessage ?? progress?.error ?? null,
  });
  const resolvedPhase = resolvedStatus === 'partial' && normalizedPhase === 'complete'
    ? 'partial'
    : normalizedPhase;
  const isTerminal = TERMINAL_LIFECYCLE_STATUSES.has(resolvedStatus);
  const isActive = !isTerminal && (
    ACTIVE_LIFECYCLE_STATUSES.has(resolvedStatus) || isActiveProgressPhase(resolvedPhase)
  );
  const normalizedErrorCandidate = toNullableString(errorMessage) || toNullableString(progress?.error);
  const normalizedError = (resolvedStatus === 'failed' || resolvedStatus === 'partial')
    ? normalizedErrorCandidate
    : null;
  const normalizedUpdatedAt = toNullableString(updatedAt) || toNullableString(progress?.updatedAt) || null;
  const normalizedReviewedAt = toNullableString(reviewedAt) || null;

  return {
    status: resolvedStatus,
    phase: resolvedPhase,
    isActive,
    isTerminal,
    canRetry: isTerminal,
    error: normalizedError,
    updatedAt: normalizedUpdatedAt,
    reviewedAt: normalizedReviewedAt,
    hasProgress: Boolean(progress),
    sourceStatus: normalizedSourceStatus || null,
  };
}

function buildQueueLifecycle(entry = {}) {
  const queueStatus = normalizeQueueStatus(entry.status);
  const mappedReviewStatus = mapQueueStatusToLifecycleStatus(queueStatus);
  return buildReviewLifecycle({
    reviewStatus: mappedReviewStatus,
    progress: entry.progress || null,
    errorMessage: entry.reviewError || null,
    updatedAt: entry.updatedAt || entry.queuedAt || null,
    reviewedAt: entry.reviewedAt || null,
    sourceStatus: queueStatus,
  });
}

function readReviewShaOrBranch(review, camelCaseKey, snakeCaseKey) {
  return toNullableString(review?.[camelCaseKey] ?? review?.[snakeCaseKey] ?? null);
}

function deriveReviewStaleReason(review = {}) {
  if (!review || typeof review !== 'object') return null;

  const reviewedHeadSha = readReviewShaOrBranch(review, 'reviewHeadSha', 'review_head_sha');
  const currentHeadSha = readReviewShaOrBranch(review, 'headSha', 'head_sha');
  if (reviewedHeadSha && currentHeadSha && reviewedHeadSha !== currentHeadSha) {
    return REVIEW_ACTION_STALE_REASONS.headMismatch;
  }

  const reviewedBaseBranch = readReviewShaOrBranch(review, 'reviewBaseBranch', 'review_base_branch');
  const currentBaseBranch = readReviewShaOrBranch(review, 'baseBranch', 'base_branch');
  if (reviewedBaseBranch && currentBaseBranch && reviewedBaseBranch !== currentBaseBranch) {
    return REVIEW_ACTION_STALE_REASONS.baseMismatch;
  }

  const reviewedMergeBaseSha = readReviewShaOrBranch(review, 'reviewMergeBaseSha', 'review_merge_base_sha');
  const currentMergeBaseSha = readReviewShaOrBranch(review, 'mergeBaseSha', 'merge_base_sha');
  if (reviewedMergeBaseSha && currentMergeBaseSha && reviewedMergeBaseSha !== currentMergeBaseSha) {
    return REVIEW_ACTION_STALE_REASONS.mergeBaseMismatch;
  }

  return null;
}

function describeBlockedReasonForStaleState(staleReason) {
  if (staleReason === REVIEW_ACTION_STALE_REASONS.headMismatch) {
    return 'Review is stale: branch head changed after review completion. Run review again before actioning.';
  }
  if (staleReason === REVIEW_ACTION_STALE_REASONS.baseMismatch) {
    return 'Review is stale: base branch changed after review completion. Run review again before actioning.';
  }
  if (staleReason === REVIEW_ACTION_STALE_REASONS.mergeBaseMismatch) {
    return 'Review is stale: merge-base changed after review completion. Run review again before actioning.';
  }
  return 'Review is stale. Run review again before actioning.';
}

function describeBlockedReasonForActiveLifecycle(lifecycleStatus) {
  const normalizedStatus = normalizeLifecycleStatus(lifecycleStatus, 'running');
  if (normalizedStatus === 'queued') {
    return 'Review is queued. Wait for a terminal lifecycle outcome before actioning.';
  }
  if (normalizedStatus === 'retrying') {
    return 'Review is still in progress (retrying). Wait for a terminal lifecycle outcome before actioning.';
  }
  if (normalizedStatus === 'running') {
    return 'Review is still in progress (running). Wait for a terminal lifecycle outcome before actioning.';
  }
  return `Review is still in progress (${normalizedStatus}). Wait for a terminal lifecycle outcome before actioning.`;
}

function buildReviewActionEligibility(review = {}, lifecycle = null) {
  const resolvedLifecycle = lifecycle || buildReviewLifecycle({
    reviewStatus: review.reviewStatus ?? review.review_status ?? 'none',
    progress: review.progress || null,
    errorMessage: review.reviewError ?? review.review_error ?? null,
    updatedAt: review.updatedAt ?? review.updated_at ?? null,
    reviewedAt: review.reviewedAt ?? review.reviewed_at ?? null,
    sourceStatus: review.reviewStatus ?? review.review_status ?? null,
  });
  const sourceStatusRaw = String(
    resolvedLifecycle?.sourceStatus
    ?? review.reviewStatus
    ?? review.review_status
    ?? ''
  ).trim().toLowerCase();
  const sourceStatus = normalizeReviewStatus(sourceStatusRaw, 'none');
  const hasRecognizedSourceStatus =
    sourceStatusRaw.length > 0
    && sourceStatusRaw !== 'none'
    && (
      LEGACY_REVIEW_STATUSES.has(sourceStatusRaw)
      || CANONICAL_LIFECYCLE_STATUSES.has(sourceStatusRaw)
    );
  const staleReason = deriveReviewStaleReason(review);

  let blockedReason = null;
  if (staleReason) {
    blockedReason = describeBlockedReasonForStaleState(staleReason);
  } else if (!resolvedLifecycle?.isTerminal) {
    blockedReason = describeBlockedReasonForActiveLifecycle(resolvedLifecycle?.status);
  } else if (sourceStatus === 'none' && !hasRecognizedSourceStatus) {
    blockedReason = 'No completed review is available for this branch snapshot. Run review before actioning.';
  }

  const canTransition = !blockedReason || Boolean(staleReason);
  return {
    canApprove: canTransition,
    canRequestChanges: canTransition,
    blockedReason,
    staleReason,
  };
}

export {
  normalizeReviewStatus,
  normalizeLifecycleStatus,
  mapLegacyReviewStatusToLifecycleStatus,
  normalizeQueueStatus,
  mapQueueStatusToLifecycleStatus,
  mapQueueStatusToReviewStatus,
  isActiveProgressPhase,
  buildReviewLifecycle,
  buildQueueLifecycle,
  deriveReviewStaleReason,
  buildReviewActionEligibility,
};
