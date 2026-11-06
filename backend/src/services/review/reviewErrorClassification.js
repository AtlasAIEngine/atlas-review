/**
 * Review Error Classification
 * All error detection, classification, retry delay, and persisted error message functions.
 */

import {
  PROVIDER_TRANSIENT_RETRY_BASE_MS,
  PROVIDER_TRANSIENT_RETRY_MAX_MS,
} from './reviewConstants.js';

export function createReviewRuntimeError(message, runtimeCode, metadata = {}) {
  const error = new Error(message);
  error.runtimeCode = runtimeCode;
  Object.assign(error, metadata);
  return error;
}

function normalizeRuntimeCode(error) {
  return String(error?.runtimeCode || error?.code || '').trim().toLowerCase();
}

export function isLikelyTimeoutError(error) {
  if (error?.isDeadline) return false;
  const runtimeCode = normalizeRuntimeCode(error);
  const msg = (error?.message || '').toLowerCase();
  return (
    msg.includes('timeout')
    || msg.includes('timed out')
    || msg.includes('etimedout')
    || runtimeCode === 'etimedout'
    || runtimeCode === 'econnaborted'
    || runtimeCode === 'request_timeout'
  );
}

export function isLikelyContextWindowError(error) {
  if (error?.isDeadline) return false;
  const msg = (error?.message || '').toLowerCase();
  return (
    msg.includes('context window') ||
    msg.includes('maximum context length') ||
    msg.includes('context length exceeded') ||
    msg.includes('too many tokens') ||
    msg.includes('token limit') ||
    msg.includes('prompt is too long') ||
    msg.includes('prompt too long') ||
    msg.includes('request too large') ||
    msg.includes('input is too long')
  );
}

export function isLikelyRateLimitError(error) {
  const runtimeCode = normalizeRuntimeCode(error);
  const msg = (error?.message || '').toLowerCase();
  return (
    msg.includes('rate limit')
    || msg.includes('429')
    || runtimeCode === 'rate_limit'
    || runtimeCode === '429'
    || runtimeCode === 'too_many_requests'
  );
}

export function isLikelyQuotaOrBillingError(error) {
  const runtimeCode = normalizeRuntimeCode(error);
  const msg = String(error?.message || '').toLowerCase();
  return (
    runtimeCode === 'quota'
    || runtimeCode === 'billing'
    || runtimeCode === 'insufficient_credits'
    || runtimeCode === 'payment_required'
    || runtimeCode === 'insufficient_quota'
    || msg.includes('credit balance')
    || msg.includes('insufficient credits')
    || msg.includes('credits exhausted')
    || msg.includes('out of credits')
    || msg.includes('no credits')
    || msg.includes('quota exceeded')
    || msg.includes('insufficient quota')
    || msg.includes('billing')
    || msg.includes('payment required')
    || msg.includes('no payment method')
    || msg.includes('purchase credits')
  );
}

export function isLikelyNetworkError(error) {
  const runtimeCode = normalizeRuntimeCode(error);
  const msg = String(error?.message || '').toLowerCase();
  return (
    runtimeCode === 'econnreset'
    || runtimeCode === 'econnrefused'
    || runtimeCode === 'ehostunreach'
    || runtimeCode === 'enotfound'
    || runtimeCode === 'eai_again'
    || runtimeCode === 'network'
    || runtimeCode === 'transient'
    ||
    msg.includes('econnreset')
    || msg.includes('etimedout')
    || msg.includes('network error')
    || msg.includes('fetch failed')
    || msg.includes('socket hang up')
    || msg.includes('service unavailable')
    || msg.includes('temporarily unavailable')
    || msg.includes('overloaded')
  );
}

export function isLikelyModelUnavailableError(error) {
  const runtimeCode = normalizeRuntimeCode(error);
  const msg = String(error?.message || '').toLowerCase();
  return (
    runtimeCode === 'model_unavailable'
    ||
    msg.includes('model not found')
    || msg.includes('model does not exist')
    || msg.includes('unknown model')
    || msg.includes('invalid model')
    || msg.includes('unsupported model')
    || msg.includes('model is not supported')
    || msg.includes('selected model is not enabled')
    || msg.includes('model is not enabled')
    || msg.includes('not enabled for this account')
    || msg.includes('model unavailable')
  );
}

export function isLikelyAuthError(error) {
  const runtimeCode = normalizeRuntimeCode(error);
  const msg = String(error?.message || '').toLowerCase();
  return (
    runtimeCode === 'auth'
    || runtimeCode === 'unauthorized'
    || runtimeCode === 'forbidden'
    || runtimeCode === '401'
    || runtimeCode === '403'
    || runtimeCode === 'invalid_api_key'
    ||
    msg.includes('invalid api key')
    || msg.includes('unauthorized')
    || msg.includes('authentication failed')
    || msg.includes('forbidden')
    || msg.includes('token expired')
    || msg.includes('api key required')
    || msg.includes('please run `claude login`')
    || msg.includes('please run `codex login`')
  );
}

export function isLikelyInvalidRequestError(error) {
  const runtimeCode = normalizeRuntimeCode(error);
  const msg = String(error?.message || '').toLowerCase();
  return (
    runtimeCode === 'invalid_request'
    || runtimeCode === 'bad_request'
    || runtimeCode === '400'
    || runtimeCode === '422'
    || runtimeCode === 'unprocessable_entity'
    ||
    msg.includes('invalid request')
    || msg.includes('bad request')
    || msg.includes('unprocessable')
    || msg.includes('invalid schema')
    || msg.includes('invalid json')
    || msg.includes('missing required')
  );
}

export function classifyReviewRuntimeError(error) {
  if (error?.isDeadline) {
    return { runtimeClass: 'timeout', legacyClass: 'deadline', retryable: false };
  }
  if (error?.isWatchdog) {
    return { runtimeClass: 'timeout', legacyClass: 'timeout', retryable: false };
  }

  const runtimeCode = normalizeRuntimeCode(error);
  const msg = String(error?.message || '').toLowerCase();
  if (runtimeCode === 'deadline' || runtimeCode === 'deadline_exceeded') {
    return { runtimeClass: 'timeout', legacyClass: 'deadline', retryable: false };
  }
  if (msg.includes('deadline exceeded') || msg.includes('review deadline')) {
    return { runtimeClass: 'timeout', legacyClass: 'deadline', retryable: false };
  }
  if (
    runtimeCode === 'auth'
    || runtimeCode === 'unauthorized'
    || runtimeCode === 'forbidden'
    || runtimeCode === '401'
    || runtimeCode === '403'
    || runtimeCode === 'invalid_api_key'
  ) {
    return { runtimeClass: 'auth', legacyClass: 'auth', retryable: false };
  }
  if (runtimeCode === 'context_limit' || runtimeCode === 'context_window' || runtimeCode === 'token_limit') {
    return { runtimeClass: 'context_limit', legacyClass: 'context_window', retryable: false };
  }
  if (
    runtimeCode === 'quota'
    || runtimeCode === 'billing'
    || runtimeCode === 'insufficient_credits'
    || runtimeCode === 'payment_required'
    || runtimeCode === 'insufficient_quota'
    || isLikelyQuotaOrBillingError(error)
  ) {
    return { runtimeClass: 'quota', legacyClass: 'quota', retryable: false };
  }
  if (
    runtimeCode === 'invalid_request'
    || runtimeCode === 'bad_request'
    || runtimeCode === '400'
    || runtimeCode === '422'
    || runtimeCode === 'unprocessable_entity'
  ) {
    return { runtimeClass: 'invalid_request', legacyClass: 'invalid_request', retryable: false };
  }
  if (
    runtimeCode === 'timeout'
    || runtimeCode === 'etimedout'
    || runtimeCode === 'econnaborted'
    || runtimeCode === 'request_timeout'
  ) {
    return { runtimeClass: 'timeout', legacyClass: 'timeout', retryable: true };
  }
  if (runtimeCode === 'rate_limit' || runtimeCode === '429' || runtimeCode === 'too_many_requests') {
    return { runtimeClass: 'transient', legacyClass: 'rate_limit', retryable: true };
  }
  if (
    runtimeCode === 'network'
    || runtimeCode === 'transient'
    || runtimeCode === 'econnreset'
    || runtimeCode === 'econnrefused'
    || runtimeCode === 'ehostunreach'
    || runtimeCode === 'enotfound'
    || runtimeCode === 'eai_again'
  ) {
    return { runtimeClass: 'transient', legacyClass: 'network', retryable: true };
  }
  if (runtimeCode === 'max_turns_exceeded') {
    return { runtimeClass: 'max_turns_exceeded', legacyClass: 'max_turns_exceeded', retryable: false };
  }
  if (runtimeCode === 'model_unavailable') {
    return { runtimeClass: 'invalid_request', legacyClass: 'model_unavailable', retryable: false };
  }

  if (isLikelyModelUnavailableError(error)) {
    return { runtimeClass: 'invalid_request', legacyClass: 'model_unavailable', retryable: false };
  }
  if (isLikelyContextWindowError(error)) {
    return { runtimeClass: 'context_limit', legacyClass: 'context_window', retryable: false };
  }
  if (isLikelyAuthError(error)) {
    return { runtimeClass: 'auth', legacyClass: 'auth', retryable: false };
  }
  if (isLikelyRateLimitError(error)) {
    return { runtimeClass: 'transient', legacyClass: 'rate_limit', retryable: true };
  }
  if (isLikelyTimeoutError(error)) {
    return { runtimeClass: 'timeout', legacyClass: 'timeout', retryable: true };
  }
  if (isLikelyNetworkError(error)) {
    return { runtimeClass: 'transient', legacyClass: 'network', retryable: true };
  }
  if (isLikelyInvalidRequestError(error)) {
    return { runtimeClass: 'invalid_request', legacyClass: 'invalid_request', retryable: false };
  }
  return { runtimeClass: 'unknown', legacyClass: 'unknown', retryable: false };
}

export function classifyProviderError(error) {
  return classifyReviewRuntimeError(error).legacyClass;
}

export function isLikelyTimeoutOrContextError(error) {
  const classification = classifyReviewRuntimeError(error);
  return classification.runtimeClass === 'timeout' || classification.runtimeClass === 'context_limit';
}

export function isLikelyTransientProviderError(error) {
  const classification = classifyReviewRuntimeError(error);
  if (classification.retryable) return true;
  const msg = String(error?.message || '').toLowerCase();
  return msg.includes('retry later');
}

export function computeRetryDelayMs(attemptNumber) {
  const attempt = Math.max(1, Number(attemptNumber) || 1);
  const exponential = PROVIDER_TRANSIENT_RETRY_BASE_MS * Math.pow(2, attempt - 1);
  const jitter = Math.floor(Math.random() * 250);
  return Math.min(PROVIDER_TRANSIENT_RETRY_MAX_MS, exponential + jitter);
}

function providerAttemptDisplayLabel(attempt) {
  const providerType = attempt?.providerType || 'unknown';
  const model = attempt?.model || 'unknown';
  const mode = attempt?.mode || 'unknown';
  const outcome = attempt?.outcome || 'failed';
  const errorClass = attempt?.errorClass ? `/${attempt.errorClass}` : '';
  return `${providerType}/${model} (${mode}:${outcome}${errorClass})`;
}

function appendRuntimeClassTag(message, runtimeClass = null) {
  const baseMessage = String(message || '').trim();
  const normalizedClass = String(runtimeClass || '').trim().toLowerCase();
  if (!baseMessage) return baseMessage;
  if (!normalizedClass || normalizedClass === 'unknown') return baseMessage;
  if (/\[class=[^\]]+\]/i.test(baseMessage)) return baseMessage;
  return `${baseMessage} [class=${normalizedClass}]`;
}

export function buildPersistedReviewErrorMessage(error, timingSnapshot = null) {
  const baseMessage = String(error?.message || 'Review failed').trim() || 'Review failed';
  const failureClass = timingSnapshot?.failureClass || classifyProviderError(error) || 'unknown';
  const taggedBaseMessage = appendRuntimeClassTag(baseMessage, failureClass);
  const attempts = Array.isArray(timingSnapshot?.providerAttempts)
    ? timingSnapshot.providerAttempts
    : [];

  if (attempts.length === 0) {
    return taggedBaseMessage;
  }

  const trail = attempts
    .slice(0, 6)
    .map((attempt) => providerAttemptDisplayLabel(attempt))
    .join(' -> ');
  const raw = `${taggedBaseMessage} Attempts: ${trail}`;
  return raw.length > 900 ? `${raw.slice(0, 897)}...` : raw;
}

export function normalizeReviewTierFromResult(reviewResult) {
  const rawTier = String(reviewResult?.stats?.reviewTier || '').trim().toLowerCase();
  if (rawTier === 'full' || rawTier === 'partial' || rawTier === 'files_only' || rawTier === 'failed') {
    return rawTier;
  }
  if (reviewResult?.stats?.isPartial) return 'partial';
  const failedFileCount = Math.max(0, Number(reviewResult?.stats?.perFileFailedFiles || 0));
  if (failedFileCount > 0) return 'partial';
  const hasGroups = Array.isArray(reviewResult?.changeGroups) && reviewResult.changeGroups.length > 0;
  const hasRecommendations = Array.isArray(reviewResult?.recommendations) && reviewResult.recommendations.length > 0;
  if (hasRecommendations && !hasGroups) return 'files_only';
  return 'full';
}

export function derivePersistedReviewErrorFromResult(reviewResult) {
  const tier = normalizeReviewTierFromResult(reviewResult);
  if (tier === 'full' || tier === 'files_only') return null;
  const partialReasonRaw = typeof reviewResult?.stats?.partialReason === 'string'
    ? reviewResult.stats.partialReason.trim()
    : '';
  const partialReason = partialReasonRaw
    ? appendRuntimeClassTag(
      partialReasonRaw,
      classifyProviderError({ message: partialReasonRaw })
    )
    : '';
  const partialCompleted = Math.max(0, Number(reviewResult?.stats?.partialChunksCompleted || 0));
  const partialTotal = Math.max(partialCompleted, Number(reviewResult?.stats?.partialChunksTotal || 0));
  const failedFileCount = Math.max(0, Number(reviewResult?.stats?.perFileFailedFiles || 0));

  if (tier === 'failed') {
    return partialReason || 'Review failed before producing usable output.';
  }

  const chunkSegment = partialTotal > 0
    ? `${partialCompleted}/${partialTotal} chunk(s) analyzed`
    : null;
  const failedFileSegment = failedFileCount > 0
    ? `${failedFileCount} file${failedFileCount === 1 ? '' : 's'} failed deep analysis`
    : null;
  const details = [chunkSegment, failedFileSegment].filter(Boolean).join('; ');
  if (partialReason && details) {
    return `Partial review (${details}): ${partialReason}`;
  }
  if (partialReason) {
    return `Partial review: ${partialReason}`;
  }
  if (details) {
    return `Partial review (${details}).`;
  }
  return 'Partial review completed with reduced coverage.';
}

export function applyTimingSnapshotToReviewStats(reviewResult, timingSnapshot = null) {
  if (!reviewResult || typeof reviewResult !== 'object') return;
  if (!reviewResult.stats || typeof reviewResult.stats !== 'object') {
    reviewResult.stats = {};
  }

  const firstSignal = timingSnapshot?.firstSignal || null;
  reviewResult.stats.firstSignalMs = firstSignal ? Number(firstSignal.ms) || 0 : null;
  reviewResult.stats.firstSignalScope = firstSignal?.scope || null;
  reviewResult.stats.firstSignalChunkIndex = Number.isFinite(Number(firstSignal?.chunkIndex))
    ? Number(firstSignal.chunkIndex)
    : null;
  reviewResult.stats.firstSignalTotalChunks = Number.isFinite(Number(firstSignal?.totalChunks))
    ? Number(firstSignal.totalChunks)
    : null;
  reviewResult.stats.firstSignalFilesCompleted = Number.isFinite(Number(firstSignal?.filesCompleted))
    ? Number(firstSignal.filesCompleted)
    : null;
  reviewResult.stats.firstSignalTotalFiles = Number.isFinite(Number(firstSignal?.totalFiles))
    ? Number(firstSignal.totalFiles)
    : null;
  reviewResult.stats.firstSignalCaptured = Boolean(firstSignal);
  reviewResult.stats.reviewTotalDurationMs = Number.isFinite(Number(timingSnapshot?.totalMs))
    ? Number(timingSnapshot.totalMs)
    : null;
}

export function applyPromptContextTelemetryToReviewStats(reviewResult, promptContextTelemetry = null) {
  if (!reviewResult || typeof reviewResult !== 'object') return reviewResult;
  const telemetry = promptContextTelemetry && typeof promptContextTelemetry === 'object'
    ? promptContextTelemetry
    : null;
  if (!telemetry || typeof telemetry !== 'object') return reviewResult;
  if (!reviewResult.stats || typeof reviewResult.stats !== 'object') {
    reviewResult.stats = {};
  }
  reviewResult.stats.promptContextTelemetry = {
    budgetChars: Math.max(0, Math.trunc(Number(telemetry.budgetChars) || 0)),
    usedChars: Math.max(0, Math.trunc(Number(telemetry.usedChars) || 0)),
    truncated: telemetry.truncated === true,
    blocks: Array.isArray(telemetry.blocks)
      ? telemetry.blocks.map((block) => ({
        id: String(block?.id || '').trim(),
        totalLines: Math.max(0, Math.trunc(Number(block?.totalLines) || 0)),
        includedLines: Math.max(0, Math.trunc(Number(block?.includedLines) || 0)),
        omittedLines: Math.max(0, Math.trunc(Number(block?.omittedLines) || 0)),
        truncated: block?.truncated === true,
      }))
      : [],
    queuedCommitShas: Array.isArray(telemetry.queuedCommitShas)
      ? telemetry.queuedCommitShas
        .map((sha) => String(sha || '').trim())
        .filter(Boolean)
      : [],
  };
  return reviewResult;
}

// Re-export appendRuntimeClassTag for use in other modules
export { appendRuntimeClassTag };
