export const REVIEW_FIX_EVENT_NAMES = Object.freeze({
  started: 'fix-started',
  stream: 'fix-stream',
  toolUse: 'fix-tool-use',
  fileDiff: 'fix-file-diff',
  status: 'fix-status',
  complete: 'fix-complete',
  error: 'fix-error',
  stopped: 'fix-stopped',
});

export const REVIEW_FIX_RECOMMENDATION_STATUSES = Object.freeze({
  pending: 'pending',
  running: 'running',
  touched: 'touched',
  patchApplied: 'patch_applied',
  verificationPending: 'verification_pending',
  failed: 'failed',
  stopped: 'stopped',
  skipped: 'skipped',
});

export const REVIEW_FIX_RUN_STATUSES = Object.freeze({
  running: 'running',
  patchApplied: 'patch_applied',
  verificationPending: 'verification_pending',
  failed: 'failed',
  stopped: 'stopped',
  skipped: 'skipped',
});

export const REVIEW_FIX_TRANSCRIPT_VISIBILITY = 'hidden';

function buildReviewFixEvent(event, data) {
  return {
    event,
    data,
  };
}

export function createFixStartedEvent(data) {
  return buildReviewFixEvent(REVIEW_FIX_EVENT_NAMES.started, data);
}

export function createFixStreamEvent(data) {
  return buildReviewFixEvent(REVIEW_FIX_EVENT_NAMES.stream, data);
}

export function createFixToolUseEvent(data) {
  return buildReviewFixEvent(REVIEW_FIX_EVENT_NAMES.toolUse, data);
}

export function createFixFileDiffEvent(data) {
  return buildReviewFixEvent(REVIEW_FIX_EVENT_NAMES.fileDiff, data);
}

export function createFixStatusEvent(data) {
  return buildReviewFixEvent(REVIEW_FIX_EVENT_NAMES.status, data);
}

export function createFixCompleteEvent(data) {
  return buildReviewFixEvent(REVIEW_FIX_EVENT_NAMES.complete, data);
}

export function createFixErrorEvent(data) {
  return buildReviewFixEvent(REVIEW_FIX_EVENT_NAMES.error, data);
}

export function createFixStoppedEvent(data) {
  return buildReviewFixEvent(REVIEW_FIX_EVENT_NAMES.stopped, data);
}

function normalizeRecommendationKeys(recommendationKeys) {
  if (!Array.isArray(recommendationKeys)) {
    return [];
  }

  return Array.from(new Set(
    recommendationKeys
      .map((value) => String(value || '').trim())
      .filter(Boolean)
  ));
}

function normalizeCoverageFilePath(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '')
    .toLowerCase();
  return normalized || null;
}

function normalizeCoverageFilePathList(filePaths) {
  if (!Array.isArray(filePaths)) {
    return [];
  }

  return Array.from(new Set(
    filePaths
      .map((value) => normalizeCoverageFilePath(value))
      .filter(Boolean)
  )).sort();
}

export function resolveReviewFixObservedChanges({
  buildSummary = null,
  observedFilePaths = [],
} = {}) {
  const summaryFilePaths = Array.isArray(buildSummary?.filePaths)
    ? buildSummary.filePaths
    : [];
  const normalizedObservedFilePaths = normalizeCoverageFilePathList(
    summaryFilePaths.length > 0 ? summaryFilePaths : observedFilePaths
  );

  return {
    hasFileChanges: normalizedObservedFilePaths.length > 0,
    observedFilePaths: normalizedObservedFilePaths,
  };
}

export function buildFixRecommendationStatusEvents({
  projectId,
  runId = null,
  recommendationKeys = [],
  status,
  extra = {},
}) {
  return normalizeRecommendationKeys(recommendationKeys).map((recommendationKey) => (
    createFixStatusEvent({
      projectId,
      runId,
      recommendationKey,
      status,
      ...extra,
    })
  ));
}

export function buildFixCompletionStatusEvents({
  projectId,
  runId = null,
  recommendationKeys = [],
  recommendationFilePathsByKey = {},
  observedFilePaths = [],
  hasFileChanges = false,
  wasStopped = false,
  failed = false,
  error = null,
}) {
  const normalizedRecommendationKeys = normalizeRecommendationKeys(recommendationKeys);
  const normalizedObservedFilePaths = normalizeCoverageFilePathList(observedFilePaths);
  const normalizedRecommendationFilePathsByKey = Object.entries(
    recommendationFilePathsByKey && typeof recommendationFilePathsByKey === 'object'
      ? recommendationFilePathsByKey
      : {}
  ).reduce((acc, [recommendationKey, filePaths]) => {
    const normalizedKey = String(recommendationKey || '').trim().toLowerCase();
    if (!normalizedKey) {
      return acc;
    }
    acc[normalizedKey] = normalizeCoverageFilePathList(filePaths);
    return acc;
  }, {});

  return normalizedRecommendationKeys.map((recommendationKey) => {
    const coverageFilePaths = normalizedRecommendationFilePathsByKey[recommendationKey] || [];
    const matchedFilePaths = coverageFilePaths.filter((filePath) => normalizedObservedFilePaths.includes(filePath));

    let status = REVIEW_FIX_RECOMMENDATION_STATUSES.skipped;
    if (wasStopped) {
      status = REVIEW_FIX_RECOMMENDATION_STATUSES.stopped;
    } else if (failed) {
      status = REVIEW_FIX_RECOMMENDATION_STATUSES.failed;
    } else if (hasFileChanges && matchedFilePaths.length > 0) {
      status = normalizedRecommendationKeys.length === 1
        ? REVIEW_FIX_RECOMMENDATION_STATUSES.verificationPending
        : REVIEW_FIX_RECOMMENDATION_STATUSES.patchApplied;
    }

    return createFixStatusEvent({
      projectId,
      runId,
      recommendationKey,
      status,
      filePaths: matchedFilePaths.length > 0 ? matchedFilePaths : undefined,
      error: failed ? (String(error || '').trim() || null) : undefined,
    });
  });
}

export function buildReviewFixRunStatus({
  recommendationKeys = [],
  hasFileChanges = false,
  wasStopped = false,
  failed = false,
}) {
  if (wasStopped) {
    return REVIEW_FIX_RUN_STATUSES.stopped;
  }

  if (failed) {
    return REVIEW_FIX_RUN_STATUSES.failed;
  }

  if (!hasFileChanges) {
    return REVIEW_FIX_RUN_STATUSES.skipped;
  }

  return recommendationKeys.length === 1
    ? REVIEW_FIX_RUN_STATUSES.verificationPending
    : REVIEW_FIX_RUN_STATUSES.patchApplied;
}
