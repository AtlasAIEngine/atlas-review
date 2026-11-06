/**
 * Review Timing
 * Instrumentation for review pipeline performance tracking.
 */

import { REVIEW_TIMING_DEBUG } from './reviewConstants.js';

export function createReviewTiming(reviewType, reviewId) {
  return {
    reviewType,
    reviewId,
    startedAtMs: Date.now(),
    strategy: null,
    providerMode: null,
    filePrepMs: 0,
    diffBuildMs: 0,
    promptBuildMs: 0,
    providerMs: 0,
    providerCalls: [],
    providerRetries: 0,
    providerRetryEvents: [],
    providerCandidates: [],
    providerAttempts: [],
    firstSignalMs: null,
    firstSignalScope: null,
    firstSignalChunkIndex: null,
    firstSignalTotalChunks: null,
    firstSignalFilesCompleted: null,
    firstSignalTotalFiles: null,
    failureClass: null,
  };
}

export function recordFirstSignal(timing, signalMeta = {}) {
  if (!timing || typeof timing !== 'object') return false;
  if (timing.firstSignalMs != null && Number.isFinite(Number(timing.firstSignalMs))) return false;

  const toSafeInt = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return null;
    return Math.max(0, Math.trunc(parsed));
  };

  timing.firstSignalMs = Math.max(0, Date.now() - (timing.startedAtMs || Date.now()));
  timing.firstSignalScope = typeof signalMeta.scope === 'string' && signalMeta.scope.trim()
    ? signalMeta.scope.trim()
    : 'unknown';
  timing.firstSignalChunkIndex = toSafeInt(signalMeta.chunkIndex);
  timing.firstSignalTotalChunks = toSafeInt(signalMeta.totalChunks);
  timing.firstSignalFilesCompleted = toSafeInt(signalMeta.filesCompleted);
  timing.firstSignalTotalFiles = toSafeInt(signalMeta.totalFiles);
  return true;
}

export function recordProviderTiming(timing, callTiming = {}) {
  if (!timing || !callTiming || typeof callTiming !== 'object') return;

  const promptBuildMs = Number(callTiming.promptBuildMs) || 0;
  const providerMs = Number(callTiming.providerMs) || 0;
  timing.promptBuildMs += promptBuildMs;
  timing.providerMs += providerMs;

  timing.providerCalls.push({
    scope: callTiming.scope || 'single',
    chunkIndex: Number.isFinite(Number(callTiming.chunkIndex)) ? Number(callTiming.chunkIndex) : null,
    totalChunks: Number.isFinite(Number(callTiming.totalChunks)) ? Number(callTiming.totalChunks) : null,
    splitOrdinal: typeof callTiming.splitOrdinal === 'string' && callTiming.splitOrdinal
      ? callTiming.splitOrdinal
      : null,
    fileCount: Number.isFinite(Number(callTiming.fileCount)) ? Number(callTiming.fileCount) : null,
    diffChars: Number.isFinite(Number(callTiming.diffChars)) ? Number(callTiming.diffChars) : null,
    promptChars: Number.isFinite(Number(callTiming.promptChars)) ? Number(callTiming.promptChars) : null,
    diffBuildMs: Number(callTiming.diffBuildMs) || 0,
    promptBuildMs,
    providerMs,
  });
}

export function recordProviderRetry(timing, retryMeta = {}) {
  if (!timing || typeof timing !== 'object') return;
  timing.providerRetries += 1;
  timing.providerRetryEvents.push({
    attempt: Number.isFinite(Number(retryMeta.attempt)) ? Number(retryMeta.attempt) : null,
    maxAttempts: Number.isFinite(Number(retryMeta.maxAttempts)) ? Number(retryMeta.maxAttempts) : null,
    delayMs: Number.isFinite(Number(retryMeta.delayMs)) ? Number(retryMeta.delayMs) : null,
    errorClass: typeof retryMeta.errorClass === 'string' ? retryMeta.errorClass : 'unknown',
  });
}

export function describeProviderCandidate(providerData, modelOverride = null, resolveProviderExecutionMode = null) {
  const provider = providerData?.provider || {};
  const resolvedModel = typeof modelOverride === 'string' && modelOverride.trim()
    ? modelOverride.trim()
    : provider.model;
  return {
    providerId: provider.id || null,
    providerType: provider.type || 'unknown',
    model: resolvedModel || null,
    mode: resolveProviderExecutionMode ? resolveProviderExecutionMode(providerData) : 'unknown',
  };
}

export function setProviderCandidates(timing, providerCandidates = [], resolveProviderExecutionMode = null) {
  if (!timing || typeof timing !== 'object') return;
  if (!Array.isArray(providerCandidates)) return;
  timing.providerCandidates = providerCandidates.map(
    (providerData) => describeProviderCandidate(providerData, null, resolveProviderExecutionMode)
  );
}

export function recordProviderAttempt(timing, attemptMeta = {}) {
  if (!timing || typeof timing !== 'object') return;
  timing.providerAttempts.push({
    providerId: attemptMeta.providerId || null,
    providerType: attemptMeta.providerType || 'unknown',
    model: attemptMeta.model || null,
    mode: attemptMeta.mode || 'unknown',
    outcome: attemptMeta.outcome || 'failed',
    errorClass: attemptMeta.errorClass || null,
    retries: Math.max(0, Math.round(Number(attemptMeta.retries) || 0)),
  });
}

export function finalizeReviewTiming(timing, status = 'success', failureClass = null) {
  const safeTiming = timing || {};
  const toInt = (value) => Math.max(0, Math.round(Number(value) || 0));
  const providerCalls = Array.isArray(safeTiming.providerCalls) ? safeTiming.providerCalls : [];
  const providerRetryEvents = Array.isArray(safeTiming.providerRetryEvents) ? safeTiming.providerRetryEvents : [];
  const providerCandidates = Array.isArray(safeTiming.providerCandidates) ? safeTiming.providerCandidates : [];
  const providerAttempts = Array.isArray(safeTiming.providerAttempts) ? safeTiming.providerAttempts : [];

  return {
    reviewType: safeTiming.reviewType || 'unknown',
    reviewId: safeTiming.reviewId || null,
    status,
    strategy: safeTiming.strategy || null,
    providerMode: safeTiming.providerMode || null,
    failureClass: failureClass || safeTiming.failureClass || null,
    totalMs: toInt(Date.now() - (safeTiming.startedAtMs || Date.now())),
    filePrepMs: toInt(safeTiming.filePrepMs),
    diffBuildMs: toInt(safeTiming.diffBuildMs),
    promptBuildMs: toInt(safeTiming.promptBuildMs),
    providerMs: toInt(safeTiming.providerMs),
    providerCallCount: providerCalls.length,
    providerRetryCount: toInt(safeTiming.providerRetries),
    providerCandidates,
    providerAttempts,
    providerCalls: providerCalls.map((entry) => ({
      ...entry,
      diffBuildMs: toInt(entry.diffBuildMs),
      promptBuildMs: toInt(entry.promptBuildMs),
      providerMs: toInt(entry.providerMs),
    })),
    providerRetryEvents: providerRetryEvents.map((entry) => ({
      ...entry,
      delayMs: toInt(entry.delayMs),
    })),
    firstSignal: safeTiming.firstSignalMs != null && Number.isFinite(Number(safeTiming.firstSignalMs))
      ? {
        ms: toInt(safeTiming.firstSignalMs),
        scope: typeof safeTiming.firstSignalScope === 'string' && safeTiming.firstSignalScope
          ? safeTiming.firstSignalScope
          : 'unknown',
        chunkIndex: Number.isFinite(Number(safeTiming.firstSignalChunkIndex))
          ? toInt(safeTiming.firstSignalChunkIndex)
          : null,
        totalChunks: Number.isFinite(Number(safeTiming.firstSignalTotalChunks))
          ? toInt(safeTiming.firstSignalTotalChunks)
          : null,
        filesCompleted: Number.isFinite(Number(safeTiming.firstSignalFilesCompleted))
          ? toInt(safeTiming.firstSignalFilesCompleted)
          : null,
        totalFiles: Number.isFinite(Number(safeTiming.firstSignalTotalFiles))
          ? toInt(safeTiming.firstSignalTotalFiles)
          : null,
      }
      : null,
  };
}

export function logReviewTiming(timingSnapshot) {
  if (!REVIEW_TIMING_DEBUG || !timingSnapshot) return;
  const firstSignalLabel = timingSnapshot.firstSignal
    ? ` firstSignal=${timingSnapshot.firstSignal.ms}ms(${timingSnapshot.firstSignal.scope || 'unknown'})`
    : '';
  console.log(
    `[ReviewTiming] ${timingSnapshot.reviewType}:${timingSnapshot.reviewId || 'n/a'} `
    + `status=${timingSnapshot.status} strategy=${timingSnapshot.strategy || 'n/a'} `
    + `mode=${timingSnapshot.providerMode || 'n/a'} total=${timingSnapshot.totalMs}ms `
    + `prep=${timingSnapshot.filePrepMs}ms diff=${timingSnapshot.diffBuildMs}ms `
    + `prompt=${timingSnapshot.promptBuildMs}ms provider=${timingSnapshot.providerMs}ms `
    + `calls=${timingSnapshot.providerCallCount} retries=${timingSnapshot.providerRetryCount}`
    + firstSignalLabel
  );
}
