/**
 * Review Service (Orchestrator)
 * AI-powered code review engine for the Trust Pipeline.
 * Orchestrates the review pipeline using decomposed modules in ./review/.
 */

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import path from 'path';
import providerService from './providerService.js';
import changesetService, { getChangeSetFilePath, updateChangeSetReviewIndex } from './changesetService.js';
import branchReviewService from './branchReviewService.js';
import prReviewService from './prReviewService.js';
import workspaceReviewService from './workspaceReviewService.js';
import githubService from './githubService.js';
import gitService from './gitService.js';
import memoryService from './memoryService.js';
import verificationService from './verificationService.js';
import usageService from './usageService.js';
import {
  findReadyIndexForSha as findCodegraphReadyIndexForSha,
  getStatus as getCodegraphStatusForReview,
} from './codegraphService.js';
import reviewOutcomeService from './reviewOutcomeService.js';
import { readJsonFileWithRetry, writeJsonFileAtomic } from '../utils/jsonFile.js';
import { buildQueueLifecycle } from '../utils/reviewLifecycle.js';
import { extractPrecisionMetricsFromStats } from './reviewPrecisionMetrics.js';
import { getProjectById } from '../db/queries.js';
import db from '../db/connection.js';

// ── Extracted module imports ──────────────────────────────────────────────────

import {
  REVIEW_TOTAL_DEADLINE_MS,
  REVIEW_TOTAL_DEADLINE_CLI_AGENTIC_MS,
  REVIEW_TOTAL_DEADLINE_CLI_AGENTIC_LARGE_MS,
  REVIEW_DEADLINE_START_BUFFER_MS,
  CLI_AGENTIC_PARALLEL_SHARD_CONCURRENCY,
  REVIEW_PROVIDER_HEARTBEAT_MS,
  REVIEW_PROVIDER_FAILOVER_MAX_CANDIDATES,
  REVIEW_MAX_CHUNKS,
  REVIEW_CHUNK_CONCURRENCY_DYNAMIC_MAX,
  REVIEW_CHUNK_CHAR_LIMIT,
  REVIEW_CHUNK_CHAR_LIMIT_CODEX_CLI,
  REVIEW_CHUNK_CHAR_LIMIT_CLAUDE_CLI,
  REVIEW_CHUNK_CHAR_LIMIT_GEMINI_CLI,
  REVIEW_CHUNK_CHAR_LIMIT_OPENCODE_CLI,
  REVIEW_CHUNK_CONCURRENCY,
  REVIEW_CHUNK_CONCURRENCY_CLI,
  REVIEW_CHUNK_SPLIT_MAX_DEPTH,
  REVIEW_OPENCODE_CHUNK_STOP_FINALIZATION_BUFFER_MS,
  REVIEW_OPENCODE_CHUNK_STOP_REMAINING_MS,
  REVIEW_PER_FILE_ENABLED,
  REVIEW_PER_FILE_TRIGGER_FILE_COUNT,
  REVIEW_PER_FILE_CONCURRENCY,
  REVIEW_PER_FILE_CONCURRENCY_MAX,
  REVIEW_PER_FILE_TRIVIAL_FILE_CHARS,
  REVIEW_PER_FILE_LARGE_FILE_CHARS,
  REVIEW_FILE_CACHE_ENABLED,
  REVIEW_FILE_CACHE_PROMPT_VERSION,
  REVIEW_FILE_PREP_CONCURRENCY,
  REVIEW_OMITTED_FILE_PROMPT_LIMIT,
  REVIEW_PROMPT_HARD_LIMIT_DEFAULT,
  REVIEW_PROMPT_HARD_LIMIT_CLAUDE_CLI,
  REVIEW_PROMPT_HARD_LIMIT_CODEX_CLI,
  REVIEW_PROMPT_HARD_LIMIT_GEMINI_CLI,
  REVIEW_PROMPT_HARD_LIMIT_OPENCODE_CLI,
  SINGLE_REVIEW_DIFF_LIMIT_DEFAULT,
  SINGLE_REVIEW_DIFF_LIMIT_CLAUDE_CLI,
  SINGLE_REVIEW_DIFF_LIMIT_CODEX_CLI,
  SINGLE_REVIEW_DIFF_LIMIT_GEMINI_CLI,
  SINGLE_REVIEW_DIFF_LIMIT_OPENCODE_CLI,
  SINGLE_REVIEW_MAX_FILES_CLI,
  LARGE_REVIEW_FILE_COUNT,
  MEDIUM_REVIEW_FILE_COUNT,
  FOCUSED_REVIEW_TRIGGER_FILE_COUNT,
  PROVIDER_TRANSIENT_MAX_RETRIES,
  REVIEW_TWO_PASS_VERIFIER_ENABLED,
  REVIEW_TWO_PASS_VERIFIER_MAX_FINDINGS,
  REVIEW_TWO_PASS_VERIFIER_INCLUDE_MEDIUM,
  REVIEW_TWO_PASS_VERIFIER_DIFF_HARD_LIMIT,
  REVIEW_TWO_PASS_VERIFIER_MAX_MEDIUM_FINDINGS,
  REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_FIRST_SIGNAL_MS,
  REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_DURATION_MS,
  REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_OMITTED_RATE,
  REVIEW_TWO_PASS_VERIFIER_MEDIUM_MIN_DEEP_REVIEWED_FILES,
  REVIEW_TWO_PASS_VERIFIER_UNSUPPORTED_POLICY,
  REVIEW_CORROBORATION_ENABLED,
  REVIEW_CORROBORATION_ALLOW_GROUNDED_FALLBACK,
  REVIEW_CORROBORATION_DOWNGRADE_UNSUPPORTED,
  REVIEW_OUTCOME_SUPPRESSION_ENABLED,
  REVIEW_OUTCOME_SUPPRESSION_MIN_SAMPLES,
  REVIEW_OUTCOME_SUPPRESSION_MIN_DISMISSED_RATE,
  REVIEW_OUTCOME_SUPPRESSION_MAX_PER_RUN,
  REVIEW_OUTCOME_SUPPRESSION_MAX_KEYS,
  REVIEW_OUTCOME_SUPPRESSION_MAX_ROWS,
  REVIEW_OUTCOME_SUPPRESSION_MAX_ROWS_PER_KEY,
  REVIEW_FILE_RISK_CONTEXT_MAX_FILES,
  REVIEW_PROMPT_CONTEXT_BUDGET_CHARS,
  REVIEW_PROMPT_CONTEXT_PRIOR_FINDINGS_LOOKUP_LIMIT,
  REVIEW_PROMPT_CONTEXT_SAME_HASH_ONLY,
  REVIEW_PROMPT_CONTEXT_ALLOW_CROSS_HASH_HINTS,
  VALID_REVIEW_MODEL_STRATEGIES,
  REVIEW_MODEL_PHASES,
  REVIEW_MODEL_ROUTING_POLICY_VERSION,
  DEFAULT_REVIEW_MODEL_ROLLOUT,
  DEFAULT_REVIEW_MODEL_CONFIG,
  REVIEW_QUEUE_WATCHDOG_STALE_MS,
  REVIEW_QUEUE_WATCHDOG_POLL_MS,
  REVIEW_QUEUE_WATCHDOG_MAX_RETRIES,
  ReviewDeadlineError,
  ReviewWatchdogError,
  ReviewUserStopError,
  KNOWN_REVIEW_PROGRESS_PHASES,
  DOC_FILE_RE,
  TEST_FILE_RE,
  CLI_AGENTIC_PRE_COMPUTED_DIFF_HARD_LIMIT,
  PARTIAL_MODE_MAX_FILES,
} from './review/reviewConstants.js';

import {
  parseEnvInteger,
  clampNumber,
  mapWithConcurrency,
  hashReviewFileContent,
  normalizeProviderIdentity,
  normalizePathForMatch,
  resolveReviewQualityMode,
  isReviewQualityV2Enabled,
  toNumberOrNull,
} from './review/reviewHelpers.js';

import {
  createReviewDeadline,
  throwIfDeadlineExceeded,
} from './review/reviewDeadline.js';

import {
  createReviewTiming,
  recordFirstSignal,
  recordProviderTiming,
  recordProviderRetry,
  setProviderCandidates,
  recordProviderAttempt,
  finalizeReviewTiming,
  logReviewTiming,
} from './review/reviewTiming.js';

import {
  createReviewRuntimeError,
  classifyReviewRuntimeError,
  classifyProviderError,
  isLikelyContextWindowError,
  isLikelyModelUnavailableError,
  isLikelyTransientProviderError,
  isLikelyRateLimitError,
  isLikelyTimeoutOrContextError,
  computeRetryDelayMs,
  buildPersistedReviewErrorMessage,
  derivePersistedReviewErrorFromResult,
  normalizeReviewTierFromResult,
  applyTimingSnapshotToReviewStats,
  applyPromptContextTelemetryToReviewStats,
  appendRuntimeClassTag,
} from './review/reviewErrorClassification.js';

import {
  isLockFile,
  generateDiffFromFiles,
  prepareDiffForPrompt,
} from './review/reviewDiff.js';

import {
  buildEffectiveScope,
  matchesScopeEntry,
  matchesAnyPattern,
  getGlobalReviewIgnorePatterns,
  normalizeReviewScope,
  invalidateIgnorePatternCache,
  pathMatchesPattern,
  wildcardToRegex,
  isHighRiskReviewFile,
  CODE_FILE_RE,
} from './review/reviewIgnorePatterns.js';
import { isSettingsReadError } from './review/reviewErrors.js';

import {
  getGlobalReviewModelConfig,
  cloneReviewModelConfig,
  resolveEffectiveReviewModel,
  normalizeReviewModelStrategy,
  normalizeReviewModelGatePayload,
  parseStoredReviewModelCustom,
  parseStoredReviewModelAdaptive,
  parseStoredReviewModelRollout,
  buildAdaptiveThresholdProfile,
  evaluateReviewRunGate,
  resolveAdaptiveRolloutDecision,
  computeStableRolloutBucket,
  buildRoutingDecisionContext,
  estimateDiffCharsForFiles,
  normalizeReasonCodeList,
} from './review/reviewModelConfig.js';

import {
  REVIEW_OUTPUT_SCHEMA,
  collectPromptContextSignals,
  resolveBranchReviewVerificationStatus,
  buildBoundedPromptContextBlocks,
  buildDismissedPatternHints,
  buildPromptContextHashDescriptors,
  buildPromptContextPriorFindingHintsFromCacheRows,
} from './review/reviewPromptContext.js';

import {
  buildReviewPrompt,
  parseReviewResponse,
  reconcileReviewRiskLevel,
  getRecommendationBudget,
  recommendationKey,
  normalizeContextFilePathSet,
} from './review/reviewPromptBuilder.js';

import {
  deriveFocusedReviewBudgetConfig,
  selectFilesForFocusedReview,
  summarizeOmittedFilesForPrompt,
  estimateFileReviewSize,
  estimateReviewSizeHintFromDiffStat,
  buildDiffStatMap,
  scoreNameStatusEntry,
  prioritizeNameStatusEntries,
  shapeReviewScopeForProfile,
  buildOmissionReasonMap,
  chunkFilesForReview,
  synthesizeLargeReviewSummary,
  resolveDeadlinePressure,
  resolveReviewPromptVersionForCache,
  buildReviewFileCacheDescriptor,
  getProviderCandidatesInPreferredOrder,
  isValidCachedPerFileReview,
} from './review/reviewFileSelection.js';
import {
  resolveReviewProjectProfile,
} from './review/reviewProjectProfileService.js';
import {
  applyReviewPolicyToReviewProfile,
  buildReviewPolicyStats,
  ensureGeneratedProjectReviewPolicy,
  normalizeReviewPolicySource,
  resolveEffectiveReviewPolicy,
} from './review/reviewPolicyService.js';

import {
  aggregateChunkReviews,
  annotatePartialReview,
  assignReviewTier,
  buildDeadlinePartialAggregate,
} from './review/reviewAggregation.js';

import {
  callProviderForReview,
  callProviderForReviewWithRetry,
  callProviderForReviewWithFailover,
  createProviderFailoverState,
  resolveProviderExecutionModes,
  resolveProviderExecutionMode,
  isCliAgentExecutionEnabled,
  isCliAgenticExecutionEnabled,
  getExecutionModeOrder,
  buildCliAgentReviewRequest,
  buildCliAgenticReviewPrompt,
  buildCliAgenticDiscoveryPrompt,
  buildCliAgenticDiscoveryExtractionPrompt,
  parseCliAgenticDiscoveryResponse,
  convertCliAgenticDiscoveryToReviewPayload,
  buildBehavioralHotspotDistillation,
  summarizeToolInput,
  resolveAgenticTier,
  computeAgenticMaxTurns,
  tierFileHintsForAgenticPrompt,
  partitionFilesForParallelAgenticReview,
} from './review/reviewProviderExecution.js';
import {
  writeReviewDebugJson,
  writeReviewDebugText,
} from './review/reviewDebugCapture.js';

import {
  normalizeVerifierDecision,
  normalizeVerifierUnsupportedPolicy,
  applyVerifierDecisionToRecommendation,
  evaluateMediumVerifierExpansionGate,
  runBoundedHighRiskVerifierPass,
  runCandidateFindingPromotionPass,
  parseHighRiskVerifierDecision,
  buildHighRiskVerifierPrompt,
} from './review/reviewVerifier.js';

import {
  applyCorroborationPolicyToReview,
  createCorroborationSourceEvaluator,
  createVerificationLogCorroborationSourceEvaluator,
  applyOutcomeSuppressionPolicyToReview,
  normalizePrecisionIssueCounters,
  applyEvidencePolicyToReview,
  normalizeEvidencePolicyForReview,
  applyPrCommentEligibilityPolicy,
} from './review/reviewCorroborationIntegration.js';

import {
  runReviewLinterPrePass,
  getLinterCorroborationFindings,
  mergePrePassFindingsIntoReview,
  getPromptLinterFindings,
  filterPromptLinterFindingsForFileHints,
} from './review/linter/linterReviewIntegration.js';
import {
  assignReviewFindingIds,
} from './review/reviewFindingIds.js';
import {
  createReviewToolUseTelemetry,
  shouldEmitPerformanceTelemetry,
} from './review/reviewToolUseTelemetry.js';
import {
  classifyExplorationMode,
  resolveIntendedExplorationMode,
  reconcileExplorationMode,
  buildIntendedExplorationModeSignals,
} from './review/reviewExplorationMode.js';

// ── Module state ──────────────────────────────────────────────────────────────

/**
 * Event emitter for review lifecycle events.
 * Forwarded via Socket.IO to clients.
 */
const reviewEvents = new EventEmitter();
const reviewQueue = [];
const activeBranchReviewRuns = new Map();
let isProcessing = false;

function startQueueProcessing() {
  void processQueue().catch((error) => {
    console.error('Queue processing error:', error?.message || error);
  });
}

function markActiveBranchReviewRun(branchReviewId, state = {}) {
  if (!branchReviewId) return null;
  const now = new Date().toISOString();
  const existing = activeBranchReviewRuns.get(branchReviewId) || null;
  const next = {
    branchReviewId,
    projectId: state.projectId || existing?.projectId || null,
    queueId: state.queueId || existing?.queueId || null,
    position: Number.isFinite(state.position) ? Number(state.position) : (existing?.position ?? null),
    source: state.source || existing?.source || null,
    autoReviewSnapshot: state.autoReviewSnapshot || existing?.autoReviewSnapshot || null,
    abortController: state.abortController || existing?.abortController || null,
    startedAt: state.startedAt || existing?.startedAt || now,
    updatedAt: state.updatedAt || now,
    progress: state.progress || existing?.progress || null,
  };
  activeBranchReviewRuns.set(branchReviewId, next);
  return next;
}

function touchActiveBranchReviewRun(branchReviewId, progress = null, state = {}) {
  if (!branchReviewId) return null;
  const existing = activeBranchReviewRuns.get(branchReviewId);
  if (!existing) {
    return markActiveBranchReviewRun(branchReviewId, {
      ...state,
      progress,
    });
  }
  const now = new Date().toISOString();
  const next = {
    ...existing,
    projectId: state.projectId || existing.projectId || null,
    queueId: state.queueId || existing.queueId || null,
    position: Number.isFinite(state.position) ? Number(state.position) : existing.position,
    source: state.source || existing.source || null,
    autoReviewSnapshot: state.autoReviewSnapshot || existing.autoReviewSnapshot || null,
    abortController: state.abortController || existing.abortController || null,
    updatedAt: state.updatedAt || now,
    progress: progress || existing.progress || null,
  };
  activeBranchReviewRuns.set(branchReviewId, next);
  return next;
}

function clearActiveBranchReviewRun(branchReviewId) {
  if (!branchReviewId) return;
  activeBranchReviewRuns.delete(branchReviewId);
}

function getActiveBranchReviewRun(branchReviewId) {
  if (!branchReviewId) return null;
  return activeBranchReviewRuns.get(branchReviewId) || null;
}

async function stopActiveBranchReviewRun(branchReviewId) {
  if (!branchReviewId) return { stopped: false, was: null };
  const activeRun = activeBranchReviewRuns.get(branchReviewId) || null;
  if (!activeRun) return { stopped: false, was: null };
  if (activeRun.queueId) {
    return stopReview(activeRun.queueId);
  }
  if (activeRun.source === 'direct' && activeRun.abortController && !activeRun.abortController.signal.aborted) {
    activeRun.abortController.abort(new ReviewUserStopError(branchReviewId));
    return { stopped: true, was: 'running' };
  }
  return { stopped: false, was: null };
}


// ── Orchestrator-local functions ─────────────────────────────────────────────
// Functions that depend on providerService or are specific to pipeline orchestration.

function resolveProviderReviewExecutionProfile(providerData = null) {
  const providerType = normalizeProviderIdentity(providerData).providerType;
  const profile = typeof providerService.getProviderReviewExecutionProfile === 'function'
    ? providerService.getProviderReviewExecutionProfile(providerType)
    : null;
  return {
    coverageMultiplier: clampNumber(profile?.coverageMultiplier ?? 1, 0.7, 1.8),
    chunkConcurrencyBias: clampNumber(profile?.chunkConcurrencyBias ?? 1, 0.75, 1.5),
    perFileConcurrencyBias: clampNumber(profile?.perFileConcurrencyBias ?? 1, 0.75, 1.75),
    focusedTriggerFileCountBias: clampNumber(profile?.focusedTriggerFileCountBias ?? 1, 0.6, 1.4),
    focusedTriggerDiffBias: clampNumber(profile?.focusedTriggerDiffBias ?? 1, 0.6, 1.4),
  };
}

function resolveBoundedSchedulerConcurrency({
  path = 'chunk',
  totalUnits = 1,
  providerData = null,
  budgetClass = 'balanced',
  deadline = null,
  baseline = 1,
  maxConcurrency = 8,
} = {}) {
  const safeUnits = Math.max(1, Math.trunc(Number(totalUnits) || 1));
  const safeBaseline = Math.max(1, Math.trunc(Number(baseline) || 1));
  const safeMax = Math.max(safeBaseline, Math.trunc(Number(maxConcurrency) || safeBaseline));
  const providerProfile = resolveProviderReviewExecutionProfile(providerData);
  const deadlinePressure = resolveDeadlinePressure(deadline);

  const unitScale = safeUnits >= 40
    ? 2
    : safeUnits >= 20
      ? 1
      : safeUnits >= 8
        ? 0.5
        : 0;
  const budgetScale = budgetClass === 'quality'
    ? -0.35
    : budgetClass === 'latency'
      ? 0.8
      : budgetClass === 'custom'
        ? 0.45
        : 0.25;
  const deadlineScale = deadlinePressure.ratio < 0.4
    ? 1.25
    : deadlinePressure.ratio < 0.65
      ? 0.8
      : deadlinePressure.ratio > 1.05
        ? -0.1
        : 0.2;
  const providerBias = path === 'per_file'
    ? providerProfile.perFileConcurrencyBias
    : providerProfile.chunkConcurrencyBias;

  const scaled = Math.round(
    (safeBaseline + unitScale + budgetScale + deadlineScale) * providerBias
  );
  return Math.max(1, Math.min(safeMax, safeUnits, scaled));
}

function shouldUseChunkedReviewPath(providerData, diffLength, fileCount) {
  if (fileCount > LARGE_REVIEW_FILE_COUNT) return true;
  if ((providerData?.useClaudeCLI || providerData?.useCodexCLI || providerData?.useGeminiCLI || providerData?.useOpenCodeCLI) && fileCount > SINGLE_REVIEW_MAX_FILES_CLI) {
    return true;
  }
  return diffLength > resolveSingleReviewDiffLimit(providerData);
}

function shouldUsePerFileReviewPath(providerData, fileCount) {
  if (!REVIEW_PER_FILE_ENABLED) return false;
  if (!Number.isFinite(Number(fileCount))) return false;
  if (Number(fileCount) < REVIEW_PER_FILE_TRIGGER_FILE_COUNT) return false;
  // Per-file path is most valuable on large reviews and most stable on API mode.
  // For CLI mode we still allow it, but keep chunk fallback available.
  return true;
}

function evaluateAgenticCoverageResult({
  providerType = null,
  totalFiles = 0,
  stats = null,
} = {}) {
  const normalizedProviderType = typeof providerType === 'string'
    ? providerType.trim().toLowerCase()
    : '';
  const normalizedTotalFiles = Math.max(0, Math.trunc(Number(totalFiles) || 0));
  const statsSource = stats && typeof stats === 'object' ? stats : {};
  const reportedDeepReviewedFiles = Math.max(
    0,
    Math.trunc(Number(
      statsSource.deepReviewedFiles
      ?? statsSource.filesDeepReviewed
      ?? statsSource.filesAnalyzed
      ?? 0
    ) || 0)
  );
  const minimumCoverageRate = clampNumber(
    1 - REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_OMITTED_RATE,
    0,
    1
  );
  const minimumDeepReviewedFiles = Math.max(
    0,
    Math.min(
      normalizedTotalFiles,
      Math.max(
        REVIEW_TWO_PASS_VERIFIER_MEDIUM_MIN_DEEP_REVIEWED_FILES,
        Math.ceil(normalizedTotalFiles * minimumCoverageRate)
      )
    )
  );
  // Require coverage universally when the PR is large enough.
  // Previously Google-only, but all providers can return low-coverage results
  // on large PRs. Partial fallback (Phase 3) now handles gaps gracefully.
  const coverageRequired = (
    normalizedTotalFiles >= REVIEW_TWO_PASS_VERIFIER_MEDIUM_MIN_DEEP_REVIEWED_FILES
  );
  const insufficientCoverage = coverageRequired && reportedDeepReviewedFiles < minimumDeepReviewedFiles;
  return {
    insufficientCoverage,
    coverageRequired,
    providerType: normalizedProviderType || null,
    totalFiles: normalizedTotalFiles,
    reportedDeepReviewedFiles,
    minimumDeepReviewedFiles,
    minimumCoverageRate,
  };
}

/**
 * Identify files not covered by the agentic review result.
 * Covered = mentioned in changeGroups[].files[].path OR recommendations[].file.
 *
 * @param {Object} reviewResult - Parsed agentic review result
 * @param {Array<{path: string}>} allFileHints - All files in scope
 * @returns {Array<{path: string}>} File hints not covered by the agentic result
 */
function identifyUncoveredFiles(reviewResult, allFileHints) {
  const coveredPaths = new Set();

  if (Array.isArray(reviewResult?.changeGroups)) {
    for (const group of reviewResult.changeGroups) {
      if (Array.isArray(group?.files)) {
        for (const f of group.files) {
          if (typeof f?.path === 'string' && f.path.trim()) {
            coveredPaths.add(normalizePathForMatch(f.path));
          }
        }
      }
    }
  }

  if (Array.isArray(reviewResult?.recommendations)) {
    for (const rec of reviewResult.recommendations) {
      if (typeof rec?.file === 'string' && rec.file.trim()) {
        coveredPaths.add(normalizePathForMatch(rec.file));
      }
    }
  }

  const safeHints = Array.isArray(allFileHints) ? allFileHints : [];
  return safeHints.filter((hint) => {
    const memberPaths = Array.isArray(hint?.memberPaths) && hint.memberPaths.length > 0
      ? hint.memberPaths
      : [hint?.path];
    return !memberPaths.some((filePath) => coveredPaths.has(normalizePathForMatch(filePath)));
  });
}

function collectReviewUnitMemberPaths(reviewUnits = []) {
  return Array.from(new Set(
    (Array.isArray(reviewUnits) ? reviewUnits : [])
      .flatMap((entry) => (
        Array.isArray(entry?.memberPaths) && entry.memberPaths.length > 0
          ? entry.memberPaths
          : [entry?.path]
      ))
      .map((entry) => normalizePathForMatch(entry))
      .filter(Boolean)
  ));
}

function reviewUnitIntersectsPathSet(reviewUnit, pathSet) {
  if (!(pathSet instanceof Set) || pathSet.size === 0) return false;
  const memberPaths = Array.isArray(reviewUnit?.memberPaths) && reviewUnit.memberPaths.length > 0
    ? reviewUnit.memberPaths
    : [reviewUnit?.path];
  return memberPaths.some((filePath) => pathSet.has(normalizePathForMatch(filePath)));
}

function buildReviewProfileStats(reviewProfile = null, shapedScopeTelemetry = null) {
  if (!reviewProfile && !shapedScopeTelemetry) return {};
  const stats = {};
  if (reviewProfile && typeof reviewProfile === 'object') {
    stats.reviewProfile = {
      id: reviewProfile.id || 'generic',
      label: reviewProfile.label || 'Generic',
      source: reviewProfile.source || 'fallback',
      presetId: reviewProfile.presetId || null,
      detectionSignals: Array.isArray(reviewProfile.detectionSignals)
        ? reviewProfile.detectionSignals.slice()
        : [],
    };
  }
  if (shapedScopeTelemetry && typeof shapedScopeTelemetry === 'object') {
    const classCounts = shapedScopeTelemetry.classCounts && typeof shapedScopeTelemetry.classCounts === 'object'
      ? shapedScopeTelemetry.classCounts
      : {};
    stats.shapedScope = {
      rawFileCount: Math.max(0, Math.trunc(Number(shapedScopeTelemetry.rawFileCount) || 0)),
      reviewUnitCount: Math.max(0, Math.trunc(Number(shapedScopeTelemetry.reviewUnitCount) || 0)),
      pairedFiles: Math.max(0, Math.trunc(Number(shapedScopeTelemetry.pairedFiles) || 0)),
      classCounts: {
        deep: Math.max(0, Math.trunc(Number(classCounts.deep) || 0)),
        structural: Math.max(0, Math.trunc(Number(classCounts.structural) || 0)),
        shallow: Math.max(0, Math.trunc(Number(classCounts.shallow) || 0)),
        collapsed: Math.max(0, Math.trunc(Number(classCounts.collapsed) || 0)),
        skip: Math.max(0, Math.trunc(Number(classCounts.skip) || 0)),
      },
    };
  }
  return stats;
}

function applyReviewProfileStats(reviewResult, {
  reviewProfile = null,
  shapedScopeTelemetry = null,
} = {}) {
  if (!reviewResult || typeof reviewResult !== 'object') return reviewResult;
  const stats = reviewResult.stats && typeof reviewResult.stats === 'object'
    ? reviewResult.stats
    : {};
  reviewResult.stats = {
    ...stats,
    ...buildReviewProfileStats(reviewProfile, shapedScopeTelemetry),
  };
  return reviewResult;
}

function enforceFinalReviewPolicy(reviewResult, {
  reviewPolicy = null,
} = {}) {
  if (!reviewResult || typeof reviewResult !== 'object') return reviewResult;
  if (!reviewPolicy || typeof reviewPolicy !== 'object') return reviewResult;
  if (!Array.isArray(reviewResult.recommendations)) return reviewResult;

  const policyDefaults = reviewPolicy.defaults && typeof reviewPolicy.defaults === 'object'
    ? reviewPolicy.defaults
    : {};
  const allowPraise = policyDefaults.allowPraise === true;
  const rawMaxRecommendations = Number(policyDefaults.maxRecommendations);
  const maxRecommendations = Number.isFinite(rawMaxRecommendations) && rawMaxRecommendations > 0
    ? Math.max(1, Math.trunc(rawMaxRecommendations))
    : null;

  let recommendations = reviewResult.recommendations.filter(
    (recommendation) => recommendation && typeof recommendation === 'object' && !Array.isArray(recommendation)
  );

  if (!allowPraise) {
    recommendations = recommendations.filter((recommendation) => recommendation.type !== 'praise');
  }

  if (maxRecommendations != null) {
    recommendations = recommendations.slice(0, maxRecommendations);
  }

  reviewResult.recommendations = recommendations;
  reconcileReviewRiskLevel(reviewResult);
  return reviewResult;
}

function applyReviewPolicyStats(reviewResult, {
  reviewPolicy = null,
} = {}) {
  if (!reviewResult || typeof reviewResult !== 'object') return reviewResult;
  enforceFinalReviewPolicy(reviewResult, { reviewPolicy });
  const stats = reviewResult.stats && typeof reviewResult.stats === 'object'
    ? reviewResult.stats
    : {};
  reviewResult.stats = {
    ...stats,
    ...buildReviewPolicyStats(reviewPolicy),
  };
  return reviewResult;
}

function coerceFocusedSelectionForAgenticFallback(
  focusedSelection,
  allReviewFiles = [],
  agenticFallbackMeta = null
) {
  if (!focusedSelection || typeof focusedSelection !== 'object') return focusedSelection;
  const fallbackReason = typeof agenticFallbackMeta?.reason === 'string'
    ? agenticFallbackMeta.reason.trim().toLowerCase()
    : '';
  if (!['insufficient_deep_coverage', 'agentic_runtime_failure'].includes(fallbackReason)) {
    return focusedSelection;
  }
  if (focusedSelection.mode !== 'focused') return focusedSelection;

  const normalizedReviewFiles = Array.isArray(allReviewFiles) && allReviewFiles.length > 0
    ? allReviewFiles
    : (Array.isArray(focusedSelection.reviewFiles) ? focusedSelection.reviewFiles : []);
  const normalizedTotalFiles = Math.max(
    normalizedReviewFiles.length,
    Math.max(0, Math.trunc(Number(focusedSelection.totalFiles) || 0))
  );
  const planner = focusedSelection.planner && typeof focusedSelection.planner === 'object'
    ? focusedSelection.planner
    : {};

  return {
    ...focusedSelection,
    mode: 'full',
    reviewFiles: normalizedReviewFiles,
    omittedFiles: [],
    totalFiles: normalizedTotalFiles,
    planner: {
      ...planner,
      forcedFullCoverage: true,
      forceReason: fallbackReason === 'agentic_runtime_failure'
        ? 'agentic_runtime_failure'
        : 'agentic_insufficient_deep_coverage',
    },
  };
}

function shouldFallbackFromAgenticRuntimeError(error) {
  if (error?.isDeadline || error?.isUserStop) return false;
  const classification = classifyReviewRuntimeError(error);
  return classification.retryable === true;
}

function buildFocusedSelectionInputFromReviewEntries(reviewEntries = [], diffStatMap = null, reviewProfile = null) {
  const enrichedEntries = (Array.isArray(reviewEntries) ? reviewEntries : []).map((entry) => ({
    path: entry.path,
    oldPath: entry.oldPath || null,
    status: entry.status || 'M',
    reviewSizeHint: estimateReviewSizeHintFromDiffStat(entry, diffStatMap),
  }));
  return shapeReviewScopeForProfile(enrichedEntries, { reviewProfile, diffStatMap });
}

function buildReviewablePrNameStatusFromGitHubFiles(ghFiles = [], ignorePatterns = []) {
  const safeGhFiles = Array.isArray(ghFiles) ? ghFiles : [];
  const filteredFiles = safeGhFiles.filter((entry) => (
    entry
    && typeof entry.filename === 'string'
    && entry.filename.trim()
    && !isLockFile(entry.filename)
    && !matchesAnyPattern(entry.filename, ignorePatterns)
  ));

  return filteredFiles.map((entry) => ({
    path: entry.filename,
    oldPath: entry.previous_filename || null,
    status: entry.status === 'removed'
      ? 'D'
      : entry.status === 'added'
        ? 'A'
        : entry.status === 'renamed'
          ? 'R'
          : 'M',
    additions: Math.max(0, Number(entry.additions) || 0),
    deletions: Math.max(0, Number(entry.deletions) || 0),
    patch: typeof entry.patch === 'string' ? entry.patch : null,
  }));
}

function normalizeReviewScopeRef(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function createUpdatedReviewedAt(previousReviewedAt = null) {
  const previousMs = Date.parse(String(previousReviewedAt || ''));
  const nextMs = Date.now();
  if (Number.isFinite(previousMs) && nextMs <= previousMs) {
    return new Date(previousMs + 1).toISOString();
  }
  return new Date(nextMs).toISOString();
}

function normalizeBranchReviewRunMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'full') return 'full';
  return 'auto';
}

function isLastCommitBranchReviewScope(branchReview = {}) {
  const baseBranchSource = String(branchReview?.baseBranchSource || '').trim().toLowerCase();
  if (baseBranchSource === 'last_commit') return true;
  const baseBranch = String(branchReview?.baseBranch || '').trim();
  return baseBranch.endsWith('~last-commit');
}

function normalizePrReviewRequestedMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'agentic_discovery') return 'agentic_discovery';
  if (normalized === 'full') return 'full';
  return 'auto';
}

function normalizePrReviewRunMode(value) {
  const normalized = normalizePrReviewRequestedMode(value);
  // Pipeline mode (discovery vs structured) is decided by
  // normalizePrReviewPipelineMode and stays orthogonal to diff scope.
  // Treat agentic_discovery the same as 'auto' for diff scoping so subsequent
  // runs use the delta range against the prior review's baseline instead of
  // always re-running the full PR diff. The first run still falls back to
  // full automatically when no completed baseline exists.
  if (normalized === 'agentic_discovery') return 'auto';
  return normalizeBranchReviewRunMode(normalized);
}

function normalizePrReviewPipelineMode(value) {
  return normalizePrReviewRequestedMode(value) === 'agentic_discovery'
    ? 'agentic_discovery'
    : 'standard';
}

const PR_AGENTIC_DISCOVERY_AUTO_MIN_FILES = 3;
const PR_AGENTIC_DISCOVERY_AUTO_MIN_CHURN = 40;
const MAX_PREVIOUS_UNRESOLVED_BRANCH_FINDINGS = 50;

function isOpenCodeProvider(providerData = null) {
  return String(providerData?.provider?.type || '').trim().toLowerCase() === 'opencode';
}

function shouldUseCliAgenticFastPath({
  providerData = null,
  executionModeOrder = null,
  reviewType = 'branch_review',
  requestedMode = null,
} = {}) {
  const primaryExecutionMode = resolveProviderExecutionModes(providerData, executionModeOrder)[0] || null;
  if (primaryExecutionMode !== 'cli-agentic') return false;

  if (!isOpenCodeProvider(providerData)) return true;

  if (reviewType === 'pr_review') {
    return normalizePrReviewRequestedMode(requestedMode) === 'agentic_discovery';
  }

  return false;
}

function shouldAutoUsePrAgenticDiscovery({
  projectPath = null,
  providerData = null,
  executionModeOrder = null,
  fileCount = 0,
  totalAdditions = 0,
  totalDeletions = 0,
} = {}) {
  if (!projectPath) return false;
  if (!shouldUseCliAgenticFastPath({
    providerData,
    executionModeOrder,
    reviewType: 'pr_review',
    requestedMode: 'agentic_discovery',
  })) {
    return false;
  }

  const normalizedFileCount = Math.max(0, Math.trunc(Number(fileCount) || 0));
  const normalizedChurn = Math.max(0, Math.trunc(Number(totalAdditions) || 0))
    + Math.max(0, Math.trunc(Number(totalDeletions) || 0));
  return normalizedFileCount >= PR_AGENTIC_DISCOVERY_AUTO_MIN_FILES
    || normalizedChurn >= PR_AGENTIC_DISCOVERY_AUTO_MIN_CHURN;
}

function resolveEffectivePrReviewRequestedMode(requestedMode, context = {}) {
  const normalized = normalizePrReviewRequestedMode(requestedMode);
  if (normalized !== 'auto') return normalized;
  if (isOpenCodeProvider(context?.providerData)) return 'auto';
  return shouldAutoUsePrAgenticDiscovery(context) ? 'agentic_discovery' : 'auto';
}

function isOpenCodeCliReviewProvider(providerData = null) {
  return Boolean(providerData?.useOpenCodeCLI) || isOpenCodeProvider(providerData);
}

function isChunkedCliReviewProvider(providerData = null) {
  return Boolean(
    providerData?.useCodexCLI
    || providerData?.useClaudeCLI
    || providerData?.useGeminiCLI
    || providerData?.useOpenCodeCLI
  );
}

function prioritizeReviewFilesForChunking(files = [], providerData = null, options = {}) {
  const safeFiles = Array.isArray(files) ? files.filter(Boolean) : [];
  if (!isOpenCodeCliReviewProvider(providerData) || safeFiles.length <= 1) return safeFiles;

  const classBonus = {
    deep: 360,
    structural: 220,
    shallow: 0,
    collapsed: -180,
    skip: -700,
  };
  const scored = safeFiles.map((file, index) => {
    const entry = {
      ...file,
      path: file.path,
      oldPath: file.oldPath || null,
      status: file.status || 'M',
      profileClass: file.profileClass || null,
    };
    const normalizedPath = normalizePathForMatch(file?.path || '');
    const profileClass = String(file?.profileClass || '').trim().toLowerCase();
    let score = scoreNameStatusEntry(entry, options);
    score += classBonus[profileClass] || 0;
    if (CODE_FILE_RE.test(normalizedPath)) score += 180;
    if (DOC_FILE_RE.test(normalizedPath)) score -= 160;
    if (TEST_FILE_RE.test(normalizedPath)) score -= 40;
    return { file, index, score };
  });

  return scored
    .sort((a, b) => {
      const scoreDiff = b.score - a.score;
      if (scoreDiff !== 0) return scoreDiff;
      return a.index - b.index;
    })
    .map((entry) => entry.file);
}

function percentile(values = [], quantile = 0.75) {
  const sorted = (Array.isArray(values) ? values : [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const safePercentile = Math.min(1, Math.max(0, Number(quantile) || 0));
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * safePercentile) - 1);
  return sorted[Math.max(0, index)];
}

function resolveCliChunkStopTierReferenceMs(totalReviewFiles = 0) {
  const fileCount = Math.max(0, Math.trunc(Number(totalReviewFiles) || 0));
  if (fileCount >= LARGE_REVIEW_FILE_COUNT) return 150000;
  if (fileCount >= MEDIUM_REVIEW_FILE_COUNT) return 90000;
  return 60000;
}

function resolveOpenCodeChunkStopTierReferenceMs(totalReviewFiles = 0) {
  return resolveCliChunkStopTierReferenceMs(totalReviewFiles);
}

function resolveCliChunkStopThresholdMs({
  staticThresholdMs = REVIEW_OPENCODE_CHUNK_STOP_REMAINING_MS,
  chunkDurationsMs = [],
  totalReviewFiles = 0,
  finalizationBufferMs = REVIEW_OPENCODE_CHUNK_STOP_FINALIZATION_BUFFER_MS,
  multiplier = 1.25,
} = {}) {
  const safeStaticThresholdMs = Math.max(
    1,
    Number(staticThresholdMs) || REVIEW_OPENCODE_CHUNK_STOP_REMAINING_MS
  );
  const durationP75Ms = percentile(chunkDurationsMs, 0.75);
  const safeFinalizationBufferMs = Math.max(
    0,
    Number(finalizationBufferMs) || REVIEW_OPENCODE_CHUNK_STOP_FINALIZATION_BUFFER_MS
  );
  const tierReferenceMs = resolveCliChunkStopTierReferenceMs(totalReviewFiles);
  const estimatedNextChunkMs = durationP75Ms == null ? 0 : durationP75Ms;
  const dynamicThresholdMs = durationP75Ms == null
    ? 0
    : Math.ceil(estimatedNextChunkMs * Math.max(1, Number(multiplier) || 1) + safeFinalizationBufferMs);
  const thresholdMs = Math.max(safeStaticThresholdMs, dynamicThresholdMs);
  return {
    thresholdMs,
    staticThresholdMs: safeStaticThresholdMs,
    dynamicThresholdMs,
    tierReferenceMs,
    estimatedNextChunkMs,
    observedP75Ms: durationP75Ms,
    finalizationBufferMs: safeFinalizationBufferMs,
    multiplier: Math.max(1, Number(multiplier) || 1),
  };
}

function resolveOpenCodeChunkStopThresholdMs(options = {}) {
  return resolveCliChunkStopThresholdMs(options);
}

function resolveChunkDeadlinePressureStop({
  providerData = null,
  deadline = null,
  chunkState = null,
  nextChunkIndex = 0,
  totalChunks = 0,
  thresholdMs = REVIEW_OPENCODE_CHUNK_STOP_REMAINING_MS,
  totalReviewFiles = 0,
} = {}) {
  if (!isChunkedCliReviewProvider(providerData)) return null;
  if (!deadline || typeof deadline.remainingMs !== 'function') return null;
  const completedChunks = Array.isArray(chunkState?.chunkReviews) ? chunkState.chunkReviews.length : 0;
  if (completedChunks <= 0) return null;

  const remainingMs = Math.max(0, Number(deadline.remainingMs()) || 0);
  const threshold = resolveCliChunkStopThresholdMs({
    staticThresholdMs: thresholdMs,
    chunkDurationsMs: chunkState?.chunkDurationsMs,
    totalReviewFiles,
  });
  const safeThresholdMs = threshold.thresholdMs;
  if (remainingMs >= safeThresholdMs) return null;

  return {
    reason: 'deadline_pressure',
    remainingMs,
    thresholdMs: safeThresholdMs,
    staticThresholdMs: threshold.staticThresholdMs,
    dynamicThresholdMs: threshold.dynamicThresholdMs,
    tierReferenceMs: threshold.tierReferenceMs,
    estimatedNextChunkMs: threshold.estimatedNextChunkMs,
    observedP75Ms: threshold.observedP75Ms,
    finalizationBufferMs: threshold.finalizationBufferMs,
    thresholdMultiplier: threshold.multiplier,
    completedChunks,
    nextChunkIndex: Math.max(0, Number(nextChunkIndex) || 0),
    totalChunks: Math.max(0, Number(totalChunks) || 0),
    message: `Stopped before starting chunk ${nextChunkIndex}/${totalChunks}; ${Math.ceil(remainingMs / 1000)}s remained before the review deadline.`,
  };
}

function resolveReviewModelConfigOverride(baseConfig, overrides = {}) {
  const hasStrategyOverride = overrides?.reviewModelStrategy != null;
  const hasCustomOverride = overrides?.reviewModelCustom != null;
  const hasAdaptiveOverride = overrides?.reviewModelAdaptive != null;
  const hasRolloutOverride = overrides?.reviewModelRollout != null;
  if (!hasStrategyOverride && !hasCustomOverride && !hasAdaptiveOverride && !hasRolloutOverride) {
    return baseConfig;
  }

  const nextConfig = cloneReviewModelConfig(baseConfig || DEFAULT_REVIEW_MODEL_CONFIG);
  if (hasStrategyOverride) {
    nextConfig.strategy = normalizeReviewModelStrategy(overrides.reviewModelStrategy);
  }
  if (hasCustomOverride) {
    nextConfig.customModels = parseStoredReviewModelCustom(overrides.reviewModelCustom);
  }
  if (hasAdaptiveOverride) {
    nextConfig.adaptive = parseStoredReviewModelAdaptive(overrides.reviewModelAdaptive);
  }
  if (hasRolloutOverride) {
    nextConfig.rollout = parseStoredReviewModelRollout(overrides.reviewModelRollout);
  }
  return nextConfig;
}

function hasCompletedBranchReviewBaseline(branchReview = {}) {
  const reviewHeadSha = normalizeReviewScopeRef(branchReview?.reviewHeadSha);
  const reviewMergeBaseSha = normalizeReviewScopeRef(branchReview?.reviewMergeBaseSha);
  const reviewedAt = normalizeReviewScopeRef(branchReview?.reviewedAt);
  const reviewJson = branchReview?.reviewJson;
  const reviewStats = reviewJson?.stats && typeof reviewJson.stats === 'object'
    ? reviewJson.stats
    : {};
  const isPartialReview =
    reviewStats.isPartial === true
    || String(reviewStats.reviewTier || '').trim().toLowerCase() === 'partial';

  return Boolean(
    reviewHeadSha
    && reviewMergeBaseSha
    && reviewedAt
    && reviewJson
    && typeof reviewJson === 'object'
    && !Array.isArray(reviewJson)
    && !isPartialReview
  );
}

function hasCompletedPrReviewBaseline(prReview = {}) {
  const reviewHeadSha = normalizeReviewScopeRef(prReview?.reviewHeadSha);
  const reviewedAt = normalizeReviewScopeRef(prReview?.reviewedAt);
  const reviewJson = prReview?.reviewJson;
  const reviewStats = reviewJson?.stats && typeof reviewJson.stats === 'object'
    ? reviewJson.stats
    : {};
  const reviewedBaseSha = normalizeReviewScopeRef(reviewStats?.diffMergeBaseSha);
  const isPartialReview =
    reviewStats.isPartial === true
    || String(reviewStats.reviewTier || '').trim().toLowerCase() === 'partial';

  return Boolean(
    reviewHeadSha
    && reviewedBaseSha
    && reviewedAt
    && reviewJson
    && typeof reviewJson === 'object'
    && !Array.isArray(reviewJson)
    && !isPartialReview
  );
}

async function resolveBranchReviewDiffScope(projectPath, branchReview, options = {}) {
  const requestedMode = normalizeBranchReviewRunMode(options.reviewMode);
  const headRef = normalizeReviewScopeRef(options.headRef) || branchReview?.headSha || 'HEAD';
  const currentMergeBaseSha = normalizeReviewScopeRef(branchReview?.mergeBaseSha);
  // Prefer the preserved fork point as the three-dot diff base when available.
  // After a fast-forward merge, `merge_base_sha` collapses to HEAD while
  // `fork_point_sha` still anchors the branch's original work. Older rows
  // predating the fork-point migration fall back to `merge_base_sha`.
  const currentForkPointSha = normalizeReviewScopeRef(branchReview?.forkPointSha);
  const effectiveDiffBaseSha = currentForkPointSha || currentMergeBaseSha;
  if (isLastCommitBranchReviewScope(branchReview)) {
    return {
      requestedMode,
      mode: 'full',
      diffBaseSha: effectiveDiffBaseSha,
      diffHeadSha: headRef,
      branchMergeBaseSha: currentMergeBaseSha,
      branchForkPointSha: currentForkPointSha || null,
      deltaEligible: false,
      deltaFallbackReason: 'last_commit_scope',
      nameStatusLoader: gitService.getTwoDotDiffNameStatus.bind(gitService),
      diffStatLoader: gitService.getTwoDotDiffStats.bind(gitService),
      fullDiffLoader: gitService.getTwoDotFullDiff.bind(gitService),
    };
  }
  const baseScope = {
    requestedMode,
    mode: 'full',
    diffBaseSha: effectiveDiffBaseSha,
    diffHeadSha: headRef,
    branchMergeBaseSha: currentMergeBaseSha,
    branchForkPointSha: currentForkPointSha || null,
    deltaEligible: false,
    deltaFallbackReason: null,
    nameStatusLoader: gitService.getThreeDotDiffNameStatus.bind(gitService),
    diffStatLoader: gitService.getThreeDotDiffStats.bind(gitService),
    fullDiffLoader: gitService.getThreeDotFullDiff.bind(gitService),
  };

  if (requestedMode === 'full') {
    return {
      ...baseScope,
      deltaFallbackReason: 'forced_full_review',
    };
  }

  if (!effectiveDiffBaseSha) {
    return {
      ...baseScope,
      deltaFallbackReason: 'missing_merge_base',
    };
  }

  if (!hasCompletedBranchReviewBaseline(branchReview)) {
    return {
      ...baseScope,
      deltaFallbackReason: 'no_prior_completed_review',
    };
  }

  const reviewedHeadSha = normalizeReviewScopeRef(branchReview?.reviewHeadSha);
  const reviewedMergeBaseSha = normalizeReviewScopeRef(branchReview?.reviewMergeBaseSha);
  const reviewedForkPointSha = normalizeReviewScopeRef(branchReview?.reviewForkPointSha);
  if (!reviewedHeadSha || !reviewedMergeBaseSha) {
    return {
      ...baseScope,
      deltaFallbackReason: 'missing_review_identity',
    };
  }

  if (reviewedHeadSha === headRef) {
    return {
      requestedMode,
      mode: 'delta',
      diffBaseSha: reviewedHeadSha,
      diffHeadSha: headRef,
      branchMergeBaseSha: currentMergeBaseSha,
      branchForkPointSha: currentForkPointSha || null,
      deltaEligible: true,
      skipReview: true,
      deltaFallbackReason: 'no_unreviewed_commits',
      nameStatusLoader: gitService.getTwoDotDiffNameStatus.bind(gitService),
      diffStatLoader: gitService.getTwoDotDiffStats.bind(gitService),
      fullDiffLoader: gitService.getTwoDotFullDiff.bind(gitService),
    };
  }

  // The baseline is still valid for delta review when the branch's
  // historical anchor hasn't moved. Prefer the first-class
  // `review_fork_point_sha` snapshot; fall back to the legacy merge-base
  // signals for rows persisted before Phase 04 (v0.60.0) added the
  // explicit column.
  //
  // Legacy row semantics:
  //   - review_merge_base_sha === current merge-base → no shift.
  //   - review_merge_base_sha === current fork_point  → the post-v0.58.0
  //     post-merge case where fork point was preserved but the stored
  //     snapshot still carries the original merge-base value.
  let baselineMatchesReviewed;
  if (reviewedForkPointSha) {
    baselineMatchesReviewed = currentForkPointSha
      && reviewedForkPointSha === currentForkPointSha;
  } else {
    baselineMatchesReviewed = reviewedMergeBaseSha === currentMergeBaseSha
      || (currentForkPointSha && reviewedMergeBaseSha === currentForkPointSha);
  }
  if (!baselineMatchesReviewed) {
    return {
      ...baseScope,
      deltaFallbackReason: 'merge_base_changed',
    };
  }

  const isAncestor = await gitService.isAncestorRef(projectPath, reviewedHeadSha, headRef).catch(() => false);
  if (!isAncestor) {
    return {
      ...baseScope,
      deltaFallbackReason: 'rebased_or_force_pushed',
    };
  }

  return {
    requestedMode,
    mode: 'delta',
    diffBaseSha: reviewedHeadSha,
    diffHeadSha: headRef,
    branchMergeBaseSha: currentMergeBaseSha,
    branchForkPointSha: currentForkPointSha || null,
    deltaEligible: true,
    deltaFallbackReason: null,
    nameStatusLoader: gitService.getTwoDotDiffNameStatus.bind(gitService),
    diffStatLoader: gitService.getTwoDotDiffStats.bind(gitService),
    fullDiffLoader: gitService.getTwoDotFullDiff.bind(gitService),
  };
}

function slicePullRequestCommitsSince(prCommits = [], reviewedHeadSha, currentHeadSha) {
  const normalizedReviewedHeadSha = normalizeReviewScopeRef(reviewedHeadSha);
  const normalizedCurrentHeadSha = normalizeReviewScopeRef(currentHeadSha);
  const safeCommits = Array.isArray(prCommits) ? prCommits : [];
  if (!normalizedReviewedHeadSha || safeCommits.length === 0) return [];
  if (normalizedCurrentHeadSha && normalizedReviewedHeadSha === normalizedCurrentHeadSha) return [];

  const reviewedIndex = safeCommits.findIndex((entry) => (
    normalizeReviewScopeRef(entry?.sha) === normalizedReviewedHeadSha
  ));
  if (reviewedIndex < 0) return [];
  return safeCommits.slice(reviewedIndex + 1);
}

async function resolvePrReviewDiffScope(projectPath, prReview, options = {}) {
  const requestedMode = normalizePrReviewRunMode(options.reviewMode);
  const headRef = normalizeReviewScopeRef(options.headRef) || prReview?.headSha || null;
  const currentBaseSha = normalizeReviewScopeRef(prReview?.baseSha);
  const baseScope = {
    requestedMode,
    mode: 'full',
    diffBaseSha: currentBaseSha,
    diffHeadSha: headRef,
    branchMergeBaseSha: currentBaseSha,
    deltaEligible: false,
    deltaFallbackReason: null,
    nameStatusLoader: gitService.getThreeDotDiffNameStatus.bind(gitService),
    diffStatLoader: gitService.getThreeDotDiffStats.bind(gitService),
    fullDiffLoader: gitService.getThreeDotFullDiff.bind(gitService),
  };

  if (requestedMode === 'full') {
    return {
      ...baseScope,
      deltaFallbackReason: 'forced_full_review',
    };
  }

  if (!currentBaseSha || !headRef) {
    return {
      ...baseScope,
      deltaFallbackReason: 'missing_pr_refs',
    };
  }

  if (!hasCompletedPrReviewBaseline(prReview)) {
    return {
      ...baseScope,
      deltaFallbackReason: 'no_prior_completed_review',
    };
  }

  const reviewedHeadSha = normalizeReviewScopeRef(prReview?.reviewHeadSha);
  const reviewedBaseSha = normalizeReviewScopeRef(prReview?.reviewJson?.stats?.diffMergeBaseSha);
  if (!reviewedHeadSha || !reviewedBaseSha) {
    return {
      ...baseScope,
      deltaFallbackReason: 'missing_review_identity',
    };
  }

  if (reviewedHeadSha === headRef) {
    return {
      requestedMode,
      mode: 'delta',
      diffBaseSha: reviewedHeadSha,
      diffHeadSha: headRef,
      branchMergeBaseSha: currentBaseSha,
      deltaEligible: true,
      skipReview: true,
      deltaFallbackReason: 'no_unreviewed_commits',
      nameStatusLoader: gitService.getTwoDotDiffNameStatus.bind(gitService),
      diffStatLoader: gitService.getTwoDotDiffStats.bind(gitService),
      fullDiffLoader: gitService.getTwoDotFullDiff.bind(gitService),
    };
  }

  if (reviewedBaseSha !== currentBaseSha) {
    return {
      ...baseScope,
      deltaFallbackReason: 'base_sha_changed',
    };
  }

  let isAncestor = null;
  if (projectPath) {
    isAncestor = await gitService.isAncestorRef(projectPath, reviewedHeadSha, headRef).catch(() => null);
  }
  if (isAncestor == null) {
    const commitShas = Array.isArray(options.prCommits)
      ? options.prCommits
        .map((entry) => normalizeReviewScopeRef(entry?.sha))
        .filter(Boolean)
      : [];
    if (commitShas.length === 0) {
      return {
        ...baseScope,
        deltaFallbackReason: 'missing_commit_context',
      };
    }
    isAncestor = commitShas.includes(reviewedHeadSha);
  }

  if (!isAncestor) {
    return {
      ...baseScope,
      deltaFallbackReason: 'rebased_or_force_pushed',
    };
  }

  return {
    requestedMode,
    mode: 'delta',
    diffBaseSha: reviewedHeadSha,
    diffHeadSha: headRef,
    branchMergeBaseSha: currentBaseSha,
    deltaEligible: true,
    deltaFallbackReason: null,
    nameStatusLoader: gitService.getTwoDotDiffNameStatus.bind(gitService),
    diffStatLoader: gitService.getTwoDotDiffStats.bind(gitService),
    fullDiffLoader: gitService.getTwoDotFullDiff.bind(gitService),
  };
}

function clonePersistedReviewResult(reviewJson = null) {
  if (!reviewJson || typeof reviewJson !== 'object' || Array.isArray(reviewJson)) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(reviewJson));
  } catch {
    return null;
  }
}

function applyDiffScopeMetadata(reviewResult, diffScope = null) {
  if (!reviewResult || typeof reviewResult !== 'object') return reviewResult;
  const stats = reviewResult.stats && typeof reviewResult.stats === 'object'
    ? reviewResult.stats
    : {};
  reviewResult.stats = {
    ...stats,
    diffScopeRequestedMode: diffScope?.requestedMode || 'auto',
    diffScopeMode: diffScope?.mode === 'delta' ? 'delta' : 'full',
    diffScopeCommitCount: Math.max(
      0,
      Number(diffScope?.diffScopeCommitCount ?? diffScope?.commitCount ?? 0) || 0
    ),
    diffBaseSha: diffScope?.diffBaseSha || null,
    diffHeadSha: diffScope?.diffHeadSha || null,
    diffMergeBaseSha: diffScope?.branchMergeBaseSha || null,
    deltaEligible: Boolean(diffScope?.deltaEligible),
    deltaFallbackReason: diffScope?.deltaFallbackReason || null,
  };
  return reviewResult;
}

// Prior review payload is optional on reruns. Missing reviewJson means we have
// no reusable findings context and should safely fall back to the delta/full
// scope decision already made upstream.
function collectReviewFindingCandidates(reviewPayload) {
  if (!reviewPayload || typeof reviewPayload !== 'object' || Array.isArray(reviewPayload)) {
    return [];
  }
  return [
    ...(Array.isArray(reviewPayload.recommendations) ? reviewPayload.recommendations : []),
    ...(Array.isArray(reviewPayload.previousFindings) ? reviewPayload.previousFindings : []),
  ];
}

function dedupeReviewFindingCandidates(recommendations) {
  const seenKeys = new Set();
  const deduped = [];
  for (const recommendation of Array.isArray(recommendations) ? recommendations : []) {
    if (!recommendation || typeof recommendation !== 'object') continue;
    if (String(recommendation.type || '').trim().toLowerCase() === 'praise') continue;
    const key = getReviewRecommendationKey(recommendation);
    if (key) {
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
    }
    deduped.push(recommendation);
  }
  return deduped;
}

function summarizePriorReviewFindings(reviewPayload, maxItems = 3) {
  const recommendations = dedupeReviewFindingCandidates(collectReviewFindingCandidates(reviewPayload));
  const normalizedMaxItems = Math.max(1, Math.trunc(Number(maxItems) || 3));
  const results = [];
  for (const recommendation of recommendations) {
    const severity = String(recommendation.severity || 'medium').trim().toLowerCase();
    const filePath = normalizePathForMatch(recommendation.file || '');
    const title = String(recommendation.title || recommendation.description || '').replace(/\s+/g, ' ').trim();
    if (!title) continue;
    results.push(`[${severity}] ${filePath ? `${filePath}: ` : ''}${title}`);
    if (results.length >= normalizedMaxItems) break;
  }
  return results;
}

function cloneReviewRecommendation(recommendation) {
  if (!recommendation || typeof recommendation !== 'object' || Array.isArray(recommendation)) {
    return null;
  }
  try {
    return JSON.parse(JSON.stringify(recommendation));
  } catch {
    return null;
  }
}

function getReviewRecommendationKey(recommendation) {
  try {
    return reviewOutcomeService.getRecommendationIdentityKey(recommendation);
  } catch {
    return '';
  }
}

async function collectPreviousUnresolvedBranchFindings({
  branchReviewId,
  projectId,
  previousReview,
  nextReview,
  previousHeadSha = null,
  maxFindings = MAX_PREVIOUS_UNRESOLVED_BRANCH_FINDINGS,
} = {}) {
  if (!branchReviewId || !projectId || !previousReview || typeof previousReview !== 'object') {
    return [];
  }

  const nextRecommendationKeys = new Set();
  for (const recommendation of Array.isArray(nextReview?.recommendations) ? nextReview.recommendations : []) {
    const key = getReviewRecommendationKey(recommendation);
    if (key) nextRecommendationKeys.add(key);
  }

  let resolvedKeys = new Set();
  try {
    const outcomes = await reviewOutcomeService.listOutcomes({
      projectId,
      reviewType: 'branch_review',
      reviewId: branchReviewId,
    });
    resolvedKeys = new Set(Object.keys(outcomes?.byRecommendationKey || {}));
  } catch (error) {
    console.warn(`[ReviewService] Failed to load prior branch review outcomes for ${branchReviewId}:`, error.message);
  }

  const sourceRecommendations = dedupeReviewFindingCandidates(collectReviewFindingCandidates(previousReview));
  const seenKeys = new Set();
  const previousFindings = [];
  const reviewedAt = typeof previousReview.reviewedAt === 'string' && previousReview.reviewedAt.trim()
    ? previousReview.reviewedAt.trim()
    : null;

  for (const sourceRecommendation of sourceRecommendations) {
    if (!sourceRecommendation || typeof sourceRecommendation !== 'object') continue;
    const type = String(sourceRecommendation.type || '').trim().toLowerCase();
    if (type !== 'issue' && type !== 'suggestion') continue;
    const key = getReviewRecommendationKey(sourceRecommendation);
    if (!key || seenKeys.has(key) || nextRecommendationKeys.has(key) || resolvedKeys.has(key)) continue;
    const finding = cloneReviewRecommendation(sourceRecommendation);
    if (!finding) continue;
    finding.recommendationKey = key;
    finding.previousFinding = true;
    finding.previousFindingMeta = {
      source: 'branch_review',
      lastSeenAt: finding?.previousFindingMeta?.lastSeenAt || reviewedAt,
      lastSeenHeadSha: finding?.previousFindingMeta?.lastSeenHeadSha || previousHeadSha || null,
    };
    previousFindings.push(finding);
    seenKeys.add(key);
    if (previousFindings.length >= maxFindings) break;
  }

  return previousFindings;
}

async function attachPreviousUnresolvedBranchFindings({
  branchReviewId,
  projectId,
  previousReview,
  nextReview,
  previousHeadSha = null,
} = {}) {
  if (!nextReview || typeof nextReview !== 'object' || Array.isArray(nextReview)) {
    return nextReview;
  }
  const previousFindings = await collectPreviousUnresolvedBranchFindings({
    branchReviewId,
    projectId,
    previousReview,
    nextReview,
    previousHeadSha,
  });
  if (previousFindings.length === 0) {
    delete nextReview.previousFindings;
    return nextReview;
  }
  nextReview.previousFindings = previousFindings;
  nextReview.stats = {
    ...(nextReview.stats && typeof nextReview.stats === 'object' ? nextReview.stats : {}),
    previousUnresolvedFindings: previousFindings.length,
  };
  return nextReview;
}

async function preparePrReviewScope({
  projectPath = null,
  mergeBaseSha = '',
  headSha = 'HEAD',
  ghFiles = [],
  ignorePatterns = [],
  reviewProfile = null,
  nameStatusLoader = gitService.getThreeDotDiffNameStatus.bind(gitService),
  diffStatLoader = gitService.getThreeDotDiffStats.bind(gitService),
} = {}) {
  if (projectPath && mergeBaseSha && typeof nameStatusLoader === 'function') {
    try {
      const [nameStatus, diffStats] = await Promise.all([
        nameStatusLoader(projectPath, mergeBaseSha, headSha || 'HEAD'),
        typeof diffStatLoader === 'function'
          ? Promise.resolve(diffStatLoader(projectPath, mergeBaseSha, headSha || 'HEAD')).catch(() => null)
          : Promise.resolve(null),
      ]);
      const prioritizedNameStatus = prioritizeNameStatusEntries(nameStatus);
      const reviewableNameStatus = prioritizedNameStatus.filter((entry) => (
        entry
        && typeof entry.path === 'string'
        && entry.path.trim()
        && !isLockFile(entry.path)
        && !matchesAnyPattern(entry.path, ignorePatterns)
      ));
      const shapedScope = buildFocusedSelectionInputFromReviewEntries(
        reviewableNameStatus,
        buildDiffStatMap(diffStats?.files || []),
        reviewProfile
      );
      const shapedMemberPathSet = new Set(collectReviewUnitMemberPaths(shapedScope.reviewUnits));
      if (shapedScope.reviewUnits.length > 0 || reviewableNameStatus.length > 0) {
        return {
          source: 'local_git',
          reviewableNameStatus: reviewableNameStatus.filter(
            (entry) => shapedMemberPathSet.has(normalizePathForMatch(entry.path))
          ),
          focusedSelectionInput: shapedScope.reviewUnits,
          shapedScopeTelemetry: shapedScope.telemetry,
          diffStats: {
            fileCount: Math.max(0, Number(diffStats?.fileCount || reviewableNameStatus.length) || 0),
            totalAdditions: Math.max(0, Number(diffStats?.totalAdditions || 0) || 0),
            totalDeletions: Math.max(0, Number(diffStats?.totalDeletions || 0) || 0),
            commitCount: Math.max(0, Number(diffStats?.commitCount || 0) || 0),
          },
        };
      }
    } catch (error) {
      console.warn('[ReviewService] PR local diff scope failed, falling back to GitHub file metadata:', error.message);
    }
  }

  const reviewableNameStatus = buildReviewablePrNameStatusFromGitHubFiles(ghFiles, ignorePatterns);
  const shapedScope = buildFocusedSelectionInputFromReviewEntries(
    reviewableNameStatus,
    buildDiffStatMap(reviewableNameStatus.map((entry) => ({
      path: entry.path,
      additions: entry.additions,
      deletions: entry.deletions,
    }))),
    reviewProfile
  );
  const shapedMemberPathSet = new Set(collectReviewUnitMemberPaths(shapedScope.reviewUnits));

  return {
    source: 'github',
    reviewableNameStatus: reviewableNameStatus.filter(
      (entry) => shapedMemberPathSet.has(normalizePathForMatch(entry.path))
    ),
    focusedSelectionInput: shapedScope.reviewUnits,
    shapedScopeTelemetry: shapedScope.telemetry,
    diffStats: {
      fileCount: reviewableNameStatus.length,
      totalAdditions: reviewableNameStatus.reduce((sum, entry) => sum + Math.max(0, Number(entry.additions) || 0), 0),
      totalDeletions: reviewableNameStatus.reduce((sum, entry) => sum + Math.max(0, Number(entry.deletions) || 0), 0),
      commitCount: 0,
    },
  };
}

async function runCliAgenticReviewFastPath({
  reviewType = 'branch_review',
  reviewId = null,
  projectId = null,
  projectPath = null,
  providerData = null,
  providerFailoverState = null,
  reviewModelConfig = DEFAULT_REVIEW_MODEL_CONFIG,
  unavailableModels = null,
  executionModeOrder = [],
  deadline = null,
  reviewTiming = null,
  emitProgress = () => {},
  emitHeartbeat = () => {},
  markModelUsed = () => {},
  fileHintsInput = [],
  ignorePatterns = [],
  branchName = '',
  baseBranch = 'main',
  mergeBaseSha = '',
  headSha = '',
  totalAdditions = 0,
  totalDeletions = 0,
  qualityMode = null,
  lockSkippedCount = 0,
  reviewProfile = null,
  reviewPolicy = null,
  shapedScopeTelemetry = null,
  diffLoader = gitService.getThreeDotFullDiff.bind(gitService),
  providerCaller = callProviderForReviewWithFailover,
  prTitle = '',
  prBody = '',
  prCommitsSummary = [],
  discoveryMode = false,
  diffMode = 'full',
  partialMode = false,
  // CodeGraph experiment: explicit override knob threaded down from the
  // branchReviews / prReviews routes via request body. true forces ON
  // (still subject to the I1 ready-index + SHA check), false forces OFF,
  // null defers to the per-project setting. See reviewService compute
  // block below for the full priority order.
  codegraphMcpEnabledOverride = null,
} = {}) {
  const isPrDiscoveryMode = discoveryMode === true;
  const isPartialMode = partialMode === true;
  const safeFileHintsInput = Array.isArray(fileHintsInput)
    ? fileHintsInput.filter((entry) => entry && typeof entry.path === 'string' && entry.path.trim())
    : [];

  if (!projectPath || safeFileHintsInput.length === 0) {
    // Bailing here means the caller falls back to the structured review path
    // (which runs the provider in cli-agentic mode now that the shared core
    // forwards reviewExecutionMode). The most common cause for PR review is the
    // PR's commits not being present in the local checkout, so the local-git
    // file scope comes back empty — surface it so it's not a silent downgrade.
    console.warn(
      `[ReviewService] ${reviewType} ${reviewId || 'unknown'} skipped agentic fast path: ${
        !projectPath ? 'no local project path' : 'no reviewable files from local git scope (PR commits may not be fetched locally)'
      }; falling back to structured review.`
    );
    return {
      accepted: false,
      reviewResult: null,
      tokenUsage: { input: 0, output: 0 },
      modelUsed: null,
      selectedProviderData: providerData,
      fallbackMeta: null,
    };
  }

  const totalFilesAll = safeFileHintsInput.length;
  const providerType = providerData?.provider?.type || providerData?.type || null;
  const agentName = {
    anthropic: 'Claude',
    openai: 'Codex',
    google: 'Gemini',
    opencode: 'OpenCode',
  }[providerType] || 'Agent';

  emitProgress({
    phase: 'agentic_exploration',
    totalFiles: totalFilesAll,
    agentName,
    partialMode: false, // not yet sliced; updated below if partial
    totalScopeFiles: totalFilesAll,
  });

  const agenticTier = resolveAgenticTier(totalFilesAll);
  const dynamicMaxTurns = computeAgenticMaxTurns(totalFilesAll, agenticTier);
  const discoveryPrimaryFileCap = (
    isPrDiscoveryMode && providerType === 'openai'
      ? 4
      : 6
  );
  const discoveryMaxTurns = (
    isPrDiscoveryMode && providerType === 'openai'
      ? Math.min(dynamicMaxTurns, 6)
      : Math.min(dynamicMaxTurns, 10)
  );
  const fileHintsAll = safeFileHintsInput.map((entry) => ({
    path: entry.path,
    oldPath: entry.oldPath || null,
    status: entry.status || 'M',
    riskScore: Number(entry.reviewSizeHint) || 0,
    profileClass: entry.profileClass || null,
    memberPaths: Array.isArray(entry.memberPaths) ? entry.memberPaths : [entry.path],
  }));
  // Partial mode: keep only the top-N highest-risk files; record the rest as deferred.
  let deferredFileHints = [];
  let fileHints = fileHintsAll;
  if (isPartialMode && fileHintsAll.length > PARTIAL_MODE_MAX_FILES) {
    const sortedByRisk = [...fileHintsAll].sort(
      (a, b) => (Number(b.riskScore) || 0) - (Number(a.riskScore) || 0)
    );
    fileHints = sortedByRisk.slice(0, PARTIAL_MODE_MAX_FILES);
    deferredFileHints = sortedByRisk.slice(PARTIAL_MODE_MAX_FILES);
  }
  const totalFiles = fileHints.length;

  const isLikelyBehavioralCodePath = (filePath) => {
    const normalized = String(filePath || '').trim().toLowerCase();
    if (!normalized) return false;
    if (!normalized.endsWith('.cs')) return false;
    if (normalized.endsWith('.designer.cs')) return false;
    if (normalized.includes('/editor/')) return false;
    if (normalized.includes('/generated/')) return false;
    if (normalized.endsWith('.g.cs')) return false;
    return true;
  };

  const discoveryFocusHints = isPrDiscoveryMode
    ? (() => {
      const codeHints = fileHints.filter((hint) => isLikelyBehavioralCodePath(hint.path));
      const preferred = codeHints.length > 0 ? codeHints : fileHints;
      return preferred.slice(0, Math.min(preferred.length, discoveryPrimaryFileCap));
    })()
    : fileHints;
  const effectivePromptFileHints = isPrDiscoveryMode ? discoveryFocusHints : fileHints;
  const effectivePromptFileCount = effectivePromptFileHints.length || fileHints.length;

  let preComputedDiff = null;
  if (providerType !== 'google' && typeof diffLoader === 'function') {
    try {
      const diffFilePaths = isPrDiscoveryMode
        ? discoveryFocusHints.flatMap((hint) => (
          Array.isArray(hint.memberPaths) && hint.memberPaths.length > 0
            ? hint.memberPaths
            : [hint.path, hint.oldPath].filter(Boolean)
        ))
        : null;
      const rawDiff = diffFilePaths && diffFilePaths.length > 0
        ? await diffLoader(projectPath, mergeBaseSha, headSha, diffFilePaths)
        : await diffLoader(projectPath, mergeBaseSha, headSha);
      if (typeof rawDiff === 'string' && rawDiff.length > 0) {
        preComputedDiff = prepareDiffForPrompt(rawDiff, CLI_AGENTIC_PRE_COMPUTED_DIFF_HARD_LIMIT);
      }
    } catch (error) {
      console.warn(`[ReviewService] ${reviewType} ${reviewId || 'unknown'} pre-computed diff failed, agent will run git diff:`, error.message);
    }
  }

  const behavioralHotspotDistillation = buildBehavioralHotspotDistillation(preComputedDiff, fileHints);
  const distilledFileHints = fileHints.map((hint) => {
    const signals = behavioralHotspotDistillation.perPath.get(hint.path) || [];
    const riskBoost = signals.reduce((sum, signal) => sum + Math.max(0, Number(signal.score) || 0), 0);
    return {
      ...hint,
      behavioralSignals: signals.map((signal) => signal.id),
      behavioralSummary: signals.slice(0, 2).map((signal) => signal.summary).join('; ') || null,
      riskScore: (Number(hint.riskScore) || 0) + riskBoost,
    };
  });
  const agenticCoverageTarget = evaluateAgenticCoverageResult({
    providerType,
    totalFiles: effectivePromptFileCount,
    stats: {},
  });
  const { detailedHints: tieredFileHints, summaryHints: agenticSummaryHints } =
    tierFileHintsForAgenticPrompt(distilledFileHints, effectivePromptFileCount);
  const agenticPromptHints = isPrDiscoveryMode
    ? discoveryFocusHints.map((hint) => {
      const distilled = distilledFileHints.find((entry) => entry.path === hint.path);
      return distilled || hint;
    })
    : tieredFileHints;
  const omittedDiscoveryHintCount = Math.max(0, fileHints.length - agenticPromptHints.length);
  const discoverySummaryHints = omittedDiscoveryHintCount > 0
    ? `## Additional changed files\n\n- ${omittedDiscoveryHintCount} lower-priority changed file${omittedDiscoveryHintCount === 1 ? '' : 's'} were omitted from the detailed list. Expand only if the top files do not explain the risky behavior.`
    : null;
  const promptSummaryHints = isPrDiscoveryMode
    ? discoverySummaryHints
    : agenticSummaryHints;
  const buildAgenticPromptForMode = (promptOptions = {}) => (
    isPrDiscoveryMode
      ? buildCliAgenticDiscoveryPrompt(promptOptions)
      : buildCliAgenticReviewPrompt(promptOptions)
  );
  const countReviewFindings = (review) => {
    const actionable = Array.isArray(review?.recommendations) ? review.recommendations.length : 0;
    const candidates = Array.isArray(review?.candidateFindings) ? review.candidateFindings.length : 0;
    return actionable + candidates;
  };
  const shouldFallbackToLocalDiscoveryExtraction = (extractedReview, fallbackReview) => {
    const fallbackCount = countReviewFindings(fallbackReview);
    if (fallbackCount === 0) return false;
    const extractedCount = countReviewFindings(extractedReview);
    if (extractedCount === 0) return true;
    const parseMode = typeof extractedReview?.stats?.parseMode === 'string'
      ? extractedReview.stats.parseMode.trim().toLowerCase()
      : '';
    return parseMode === 'minimal_fallback' && extractedCount < fallbackCount;
  };
  const parseAgenticResponseForMode = async (rawText, parseContext = {}, extractionContext = {}) => {
    if (!isPrDiscoveryMode) {
      return parseReviewResponseWithVisibility(rawText, parseContext, {
        reviewType,
        reviewId,
        stage: 'agentic_review',
      });
    }

    const discovery = parseCliAgenticDiscoveryResponse(rawText);
    const fallbackPayload = convertCliAgenticDiscoveryToReviewPayload(discovery, {
      fileCount: parseContext.fileCount,
      totalAdditions: parseContext.totalAdditions,
      totalDeletions: parseContext.totalDeletions,
    });
    const fallbackReview = parseReviewResponseWithVisibility(
      JSON.stringify(fallbackPayload),
      parseContext,
      {
        reviewType,
        reviewId,
        stage: 'agentic_discovery_local_conversion',
      }
    );

    const discoveryText = String(rawText || '').trim();
    if (!discoveryText) {
      if (!fallbackReview.stats || typeof fallbackReview.stats !== 'object') {
        fallbackReview.stats = {};
      }
      fallbackReview.stats.agenticDiscoveryContract = 'two_pass_v1';
      fallbackReview.stats.agenticDiscoveryExtractionMode = 'local_fallback';
      fallbackReview.stats.agenticDiscoveryStageCount = 2;
      return fallbackReview;
    }

    const extractionPrompt = buildCliAgenticDiscoveryExtractionPrompt({
      discoveryText,
      outputSchema: REVIEW_OUTPUT_SCHEMA,
      filePaths: parseContext.filePaths,
      fileCount: parseContext.fileCount,
    });
    await writeReviewDebugText({
      projectId,
      projectPath,
      reviewType,
      reviewId,
    }, extractionContext.debugLabel || 'prompt-agentic-discovery-extraction', extractionPrompt);

    const extractionDecisionContext = buildRoutingDecisionContext({
      files: Array.isArray(parseContext.filePaths)
        ? parseContext.filePaths.map((entry) => ({ path: entry }))
        : [],
      riskFlags: {
        largeBlastRadius: (Number(parseContext.fileCount) || 0) > LARGE_REVIEW_FILE_COUNT,
      },
      diffChars: discoveryText.length,
      fallbackFileCount: Number(parseContext.fileCount) || 0,
      focusedReview: true,
      projectId: projectId || null,
      reviewType,
      reviewId,
      branchName: branchName || null,
      baseBranch: baseBranch || null,
      headSha: headSha || null,
      mergeBaseSha: mergeBaseSha || null,
      projectPath,
    });
    extractionDecisionContext._executionModeOrder = executionModeOrder;
    extractionDecisionContext.maxTurns = 1;
    extractionDecisionContext.agenticTier = 'small';
    extractionDecisionContext.reviewExecutionMode = 'cli-agentic';
    extractionDecisionContext.agenticDiscoveryMode = false;
    extractionDecisionContext.agenticExtractionMode = true;

    try {
      deadline?.check?.(REVIEW_DEADLINE_START_BUFFER_MS, 'agentic discovery extraction');
      const extractionStartedAt = Date.now();
      const extractionResult = await providerCaller(agenticFailoverState, extractionPrompt, {
        maxRetries: 0,
        deadline,
        modelPhase: 'review',
        reviewModelConfig,
        unavailableModels,
        modelDecisionContext: extractionDecisionContext,
        onRetry: buildAgenticRetryHandler(),
        reviewTiming,
      });
      recordProviderTiming(reviewTiming, {
        scope: 'agentic_discovery_extraction',
        chunkIndex: Number(extractionContext.chunkIndex || 1),
        totalChunks: Number(extractionContext.totalChunks || 1),
        fileCount: Number(parseContext.fileCount) || 0,
        diffChars: discoveryText.length,
        promptChars: extractionPrompt.length,
        promptBuildMs: 0,
        providerMs: Date.now() - extractionStartedAt,
      });

      if (extractionResult?.providerData) {
        selectedProviderData = extractionResult.providerData;
      }
      markModelUsed('review', extractionResult?.modelUsed);
      agenticTokensUsed.input += Math.max(0, Number(extractionResult?.tokensUsed?.input || 0));
      agenticTokensUsed.output += Math.max(0, Number(extractionResult?.tokensUsed?.output || 0));

      if (typeof extractionResult?.text === 'string' && extractionResult.text.trim()) {
        await writeReviewDebugText({
          projectId,
          projectPath,
          reviewType,
          reviewId,
        }, extractionContext.resultLabel || 'result-agentic-discovery-extraction', extractionResult.text);

        const extractedReview = parseReviewResponseWithVisibility(
          extractionResult.text,
          parseContext,
          {
            reviewType,
            reviewId,
            stage: 'agentic_discovery_extraction',
          }
        );
        const finalReview = shouldFallbackToLocalDiscoveryExtraction(extractedReview, fallbackReview)
          ? fallbackReview
          : extractedReview;

        if (!finalReview.stats || typeof finalReview.stats !== 'object') {
          finalReview.stats = {};
        }
        finalReview.stats.agenticDiscoveryContract = 'two_pass_v1';
        finalReview.stats.agenticDiscoveryStageCount = 2;
        finalReview.stats.agenticDiscoveryExtractionMode = finalReview === fallbackReview
          ? 'local_fallback'
          : 'model';
        finalReview.stats.agenticDiscoveryExtractionPromptChars = extractionPrompt.length;
        finalReview.stats.agenticDiscoveryTextChars = discoveryText.length;
        return finalReview;
      }
    } catch (error) {
      console.warn(
        `[ReviewService] ${reviewType} ${reviewId || 'unknown'} agentic discovery extraction failed, falling back to local conversion:`,
        error.message,
      );
    }

    if (!fallbackReview.stats || typeof fallbackReview.stats !== 'object') {
      fallbackReview.stats = {};
    }
    fallbackReview.stats.agenticDiscoveryContract = 'two_pass_v1';
    fallbackReview.stats.agenticDiscoveryStageCount = 2;
    fallbackReview.stats.agenticDiscoveryExtractionMode = 'local_fallback';
    fallbackReview.stats.agenticDiscoveryExtractionPromptChars = extractionPrompt.length;
    fallbackReview.stats.agenticDiscoveryTextChars = discoveryText.length;
    return fallbackReview;
  };

  // ── Linter pre-pass (CLI-agentic) ──────────────────────────────────
  let agenticLinterPrePass = null;
  let agenticPromptLinterFindings = [];
  if (!isPrDiscoveryMode) {
    agenticLinterPrePass = await runReviewLinterPrePass(
      projectPath,
      safeFileHintsInput,
      preComputedDiff || '',
      {
        reviewPolicy: reviewPolicy || null,
        reviewProfile: reviewProfile || null,
      }
    );
    await writeReviewDebugJson({
      projectId,
      projectPath,
      reviewType,
      reviewId,
    }, 'linter-prepass-agentic', agenticLinterPrePass);
    agenticPromptLinterFindings = getPromptLinterFindings(agenticLinterPrePass);
  }
  // ─────────────────────────────────────────────────────────────────────

  // M1a/M1b — resolve the intended exploration mode for Performance runs
  // before the prompt is built so M1b's prompt nudges can consume it.
  // Under any non-Performance strategy `intendedExplorationDecision` is
  // null and downstream code paths behave exactly as pre-M1b. The resolver
  // depends on linter pre-pass output (just computed above) and on file
  // hints; it does not depend on the prompt or the agent call.
  const explorationModeSignals = buildIntendedExplorationModeSignals({
    fileHints: effectivePromptFileHints,
    linterFindings: agenticPromptLinterFindings,
    behavioralHotspots: behavioralHotspotDistillation,
    largeBlastRadius: totalFiles > LARGE_REVIEW_FILE_COUNT,
    candidateFindingsCount: agenticPromptLinterFindings.length,
  });
  const intendedExplorationDecision = resolveIntendedExplorationMode(
    reviewModelConfig?.strategy,
    explorationModeSignals,
  );

  // Section R Phase B: gate the per-review runtime MCP on Performance +
  // Anthropic provider + valid SHAs. Computed once so the prompt builder
  // and the routing context observe the same value. Balanced is excluded
  // so its tool allowlist (and prompt) stay byte-equivalent to pre-Phase-B.
  // Codex/OpenAI fall back to the Phase A.0 prompt-only experience until
  // per-provider MCP wiring lands.
  const runtimeMcpEnabledForReview = (
    reviewModelConfig?.strategy === 'performance'
    && (providerData?.provider?.type || '') === 'anthropic'
    && typeof mergeBaseSha === 'string' && mergeBaseSha.trim().length > 0
    && typeof headSha === 'string' && headSha.trim().length > 0
  );

  // CodeGraph experiment: gate the per-review CodeGraph MCP server on
  // the two-state model (toggle ON + ready index for the matching
  // worktree_sha) AND the Anthropic CLI-agentic path. Balanced/Codex are
  // excluded for the same reason as runtimeMcpEnabled — keep the baseline
  // path byte-stable.
  //
  // Override knobs (in priority order):
  //   1. requestContext.codegraphMcpEnabledOverride === true|false
  //      (used by the benchmark harness via the branchReviews route body)
  //   2. ATLAS_REVIEW_CODEGRAPH_FORCE=1 — force ON for ad-hoc testing
  //   3. ATLAS_REVIEW_CODEGRAPH_DISABLE=1 — force OFF
  //   4. The per-project setting + ready-index gate (the production path)
  //
  // Skip reasons are recorded onto the stats block downstream so reviews
  // make it explicit when CodeGraph was requested but skipped.
  let codegraphMcpEnabledForReview = false;
  let codegraphSkippedReason = null;
  const codegraphProviderEligible = (
    reviewModelConfig?.strategy === 'performance'
    && (providerData?.provider?.type || '') === 'anthropic'
  );
  const codegraphOverride = typeof codegraphMcpEnabledOverride === 'boolean'
    ? codegraphMcpEnabledOverride
    : null;
  if (codegraphOverride === false) {
    codegraphSkippedReason = 'override_disabled';
  } else if (process.env.ATLAS_REVIEW_CODEGRAPH_DISABLE === '1') {
    codegraphSkippedReason = 'env_disabled';
  } else if (!codegraphProviderEligible && codegraphOverride !== true && process.env.ATLAS_REVIEW_CODEGRAPH_FORCE !== '1') {
    codegraphSkippedReason = (providerData?.provider?.type || '') !== 'anthropic'
      ? 'unsupported_provider'
      : 'strategy_not_performance';
  } else {
    try {
      if (codegraphOverride === true || process.env.ATLAS_REVIEW_CODEGRAPH_FORCE === '1') {
        // Force ON paths still require a ready index matching the head SHA
        // — graph facts for the wrong revision are invariant I1's whole
        // concern. We don't shortcut the SHA check just because the
        // benchmark requested it.
        const ready = await findCodegraphReadyIndexForSha(projectId, headSha);
        if (ready) {
          codegraphMcpEnabledForReview = true;
        } else {
          codegraphSkippedReason = 'no_ready_index_for_sha';
        }
      } else {
        const status = await getCodegraphStatusForReview(projectId);
        if (!status.enabled) {
          codegraphSkippedReason = 'toggle_off';
        } else if (!status.latestIndex) {
          codegraphSkippedReason = 'no_ready_index';
        } else if (status.latestIndex.state === 'indexing') {
          codegraphSkippedReason = 'index_not_ready';
        } else if (status.latestIndex.state !== 'ready') {
          codegraphSkippedReason = 'index_error_or_stale';
        } else if (!status.latestIndex.worktree_sha) {
          // Old row without a recorded SHA — refuse to enable rather than
          // risk reasoning over the wrong revision.
          codegraphSkippedReason = 'worktree_sha_unknown';
        } else if (typeof headSha === 'string' && headSha.trim() && status.latestIndex.worktree_sha !== headSha.trim()) {
          codegraphSkippedReason = 'worktree_revision_mismatch';
        } else {
          codegraphMcpEnabledForReview = true;
        }
      }
    } catch (err) {
      // Never block a review on a CodeGraph-status read failure — degrade
      // to "skipped" and continue. This matches the spirit of CLAUDE.md's
      // "review must surface failures, not silently default" guidance:
      // the skip reason IS the surfaced signal.
      codegraphSkippedReason = `status_read_failed:${err?.message || 'unknown'}`;
      console.warn('[reviewService] CodeGraph status read failed; skipping for this review:', err?.message || err);
    }
  }

  const agenticPrompt = buildAgenticPromptForMode({
    branchName,
    baseBranch,
    mergeBaseSha,
    headSha,
    prTitle,
    prBody,
    prCommitsSummary,
    fileHints: agenticPromptHints,
    ignorePatterns,
    outputSchema: REVIEW_OUTPUT_SCHEMA,
    fileCount: effectivePromptFileCount,
    maxTurns: isPrDiscoveryMode ? discoveryMaxTurns : dynamicMaxTurns,
    minimumDeepReviewedFiles: agenticCoverageTarget.coverageRequired
      ? agenticCoverageTarget.minimumDeepReviewedFiles
      : null,
    minimumCoverageRate: agenticCoverageTarget.coverageRequired
      ? agenticCoverageTarget.minimumCoverageRate
      : null,
    preferFileListOnly: providerType === 'google',
    summaryHints: promptSummaryHints,
    behavioralHotspotsSummary: behavioralHotspotDistillation.summary,
    reviewProfile,
    shapedScope: shapedScopeTelemetry,
    preComputedDiff,
    linterFindings: agenticPromptLinterFindings,
    discoveryMode: isPrDiscoveryMode,
    providerType,
    diffMode,
    reviewModelStrategy: reviewModelConfig?.strategy,
    intendedExplorationMode: intendedExplorationDecision?.mode || null,
    intendedExplorationModeReasons: intendedExplorationDecision?.reasonCodes || [],
    runtimeMcpEnabled: runtimeMcpEnabledForReview,
    codegraphMcpEnabled: codegraphMcpEnabledForReview,
  });
  await writeReviewDebugText({
    projectId,
    projectPath,
    reviewType,
    reviewId,
  }, 'prompt-agentic-top-level', agenticPrompt);

  const agenticModelDecisionContext = buildRoutingDecisionContext({
    files: effectivePromptFileHints,
    riskFlags: {
      largeBlastRadius: effectivePromptFileCount > LARGE_REVIEW_FILE_COUNT,
    },
    diffChars: effectivePromptFileHints.reduce(
      (sum, entry) => sum + (Number(entry.reviewSizeHint) || 0),
      0
    ),
    fallbackFileCount: effectivePromptFileCount,
    focusedReview: false,
    projectId: projectId || null,
    reviewType,
    reviewId,
    branchName: branchName || null,
    baseBranch: baseBranch || null,
    headSha: headSha || null,
    mergeBaseSha: mergeBaseSha || null,
    projectPath,
  });
  agenticModelDecisionContext._executionModeOrder = executionModeOrder;
  agenticModelDecisionContext.maxTurns = isPrDiscoveryMode ? discoveryMaxTurns : dynamicMaxTurns;
  agenticModelDecisionContext.agenticTier = agenticTier;
  agenticModelDecisionContext.reviewExecutionMode = 'cli-agentic';
  agenticModelDecisionContext.agenticDiscoveryMode = isPrDiscoveryMode;
  agenticModelDecisionContext.runtimeMcpEnabled = runtimeMcpEnabledForReview;
  agenticModelDecisionContext.codegraphMcpEnabled = codegraphMcpEnabledForReview;

  const providerStartedAt = Date.now();
  const agenticStartMs = Date.now();
  let agenticStillWorkingEmitted = false;
  let selectedProviderData = providerData;
  let agenticTokensUsed = { input: 0, output: 0 };
  let agenticModelUsed = null;
  let totalShardPromptChars = 0;
  let agenticToolUseCount = 0;
  let reviewResult;
  let fallbackMeta = null;
  const agenticFailoverState = {
    candidates: Array.isArray(providerFailoverState?.candidates)
      ? providerFailoverState.candidates.slice(0, 1)
      : [],
    preferredIndex: 0,
  };

  // M0 Performance telemetry: classifies every tool_use event into kinds
  // (full_file_read, git_diff, ...) for cost/speed analysis. Read-only;
  // only attached to review.stats when the gate below allows it.
  const performanceTelemetry = createReviewToolUseTelemetry();

  // M1b note: `intendedExplorationDecision` is resolved earlier in the
  // function (just after the linter pre-pass, before the prompt is built)
  // so that buildAgenticPromptForMode can render the Performance soft-
  // enforcement bullets. The decision flows in here only for telemetry.

  // Local helper: emit the namespaced `review.stats.performance.*` block
  // when the M0 gate allows it. Combines tool-use telemetry (M0) with the
  // exploration-mode classifier output (M1a) plus intended-vs-observed
  // reconciliation. Pure metadata — no agent-visible side effects.
  const attachPerformanceStatsBlock = (statsObj, agenticStatsForClassifier) => {
    if (!shouldEmitPerformanceTelemetry(reviewModelConfig?.strategy)) return;
    const toolUseTelemetry = performanceTelemetry.snapshot();
    const observedMode = classifyExplorationMode({
      toolUseTelemetry,
      shapedScope: shapedScopeTelemetry,
      agenticStats: agenticStatsForClassifier || null,
    });
    const intendedMode = intendedExplorationDecision?.mode || null;
    const reconciliation = reconcileExplorationMode(intendedMode, observedMode);
    statsObj.performance = {
      ...(statsObj.performance || {}),
      toolUseTelemetry,
      explorationMode: observedMode,
      explorationModeIntended: intendedMode,
      explorationModeIntendedReasons: intendedExplorationDecision?.reasonCodes || [],
      explorationModeReconciled: reconciliation.reconciled,
      explorationModeDrift: reconciliation.drift,
      // CodeGraph experiment: surface adoption + gate decision so the
      // benchmark harness can read it without parsing CLI args.
      codegraphMcpEnabled: codegraphMcpEnabledForReview,
      codegraphSkippedReason,
    };
  };

  const buildAgenticToolUseHandler = (filesInScope, perRunMaxTurns) => (toolEvent) => {
    agenticToolUseCount += 1;
    performanceTelemetry.onToolUse(toolEvent);
    const toolSummary = summarizeToolInput(toolEvent);
    recordFirstSignal(reviewTiming, {
      scope: 'agentic_tool_use',
      filesCompleted: 0,
      totalFiles: filesInScope,
    });
    emitProgress({
      phase: 'agentic_tool_use',
      totalFiles: filesInScope,
      agenticToolSummary: toolSummary,
      agentName,
      agenticToolUseCount,
      agenticMaxTurns: perRunMaxTurns ?? null,
    });
    const elapsedMs = Date.now() - agenticStartMs;
    if (elapsedMs > 90_000 && !agenticStillWorkingEmitted) {
      agenticStillWorkingEmitted = true;
      emitProgress({
        phase: 'agentic_exploration',
        totalFiles: effectivePromptFileCount,
        agenticToolSummary: `Still working... ${agentName} is thoroughly reviewing the codebase.`,
        agentName,
        agenticToolUseCount,
        agenticMaxTurns: perRunMaxTurns ?? null,
      });
    }
  };

  const buildAgenticRetryHandler = () => (retryMeta) => {
    recordProviderRetry(reviewTiming, retryMeta);
    emitProgress({
      phase: 'provider_retry',
      retryAttempt: retryMeta.attempt,
      retryMaxAttempts: retryMeta.maxAttempts,
      retryDelayMs: retryMeta.delayMs,
    });
  };

  if (agenticTier === 'large' && !isPrDiscoveryMode) {
    const shards = partitionFilesForParallelAgenticReview(distilledFileHints);
    emitProgress({
      phase: 'agentic_exploration',
      totalFiles,
      agentName,
      agenticToolSummary: isPartialMode
        ? `${agentName} reviewing ${totalFiles} of ${totalFilesAll} files (partial) across ${shards.length} parallel shards.`
        : `${agentName} reviewing ${totalFiles} files across ${shards.length} parallel shards.`,
      partialMode: isPartialMode,
      totalScopeFiles: totalFilesAll,
      effectiveReviewFiles: totalFiles,
    });

    const shardResults = [];
    const shardFailures = [];
    let deadlineHit = false;
    const shardPressureThresholdMs = resolveCliChunkStopTierReferenceMs(totalFiles);
    await mapWithConcurrency(
      shards.map((shardHints, idx) => ({ shardHints, idx })),
      CLI_AGENTIC_PARALLEL_SHARD_CONCURRENCY,
      async ({ shardHints, idx }) => {
        if (deadlineHit) {
          shardFailures.push({ idx, reason: 'skipped_after_deadline' });
          return;
        }
        if (
          shardResults.length > 0
          && deadline
          && typeof deadline.remainingMs === 'function'
          && deadline.remainingMs() < shardPressureThresholdMs
        ) {
          deadlineHit = true;
          shardFailures.push({ idx, reason: 'skipped_deadline_pressure' });
          return;
        }
        const shardMaxTurns = computeAgenticMaxTurns(shardHints.length, 'large');

        let shardPreComputedDiff = null;
        if (providerType !== 'google' && typeof diffLoader === 'function') {
          try {
            const shardFilePaths = shardHints.flatMap((hint) => (
              Array.isArray(hint.memberPaths) && hint.memberPaths.length > 0
                ? hint.memberPaths
                : [hint.path, hint.oldPath].filter(Boolean)
            ));
            const rawShardDiff = await diffLoader(projectPath, mergeBaseSha, headSha, shardFilePaths);
            if (typeof rawShardDiff === 'string' && rawShardDiff.length > 0) {
              shardPreComputedDiff = prepareDiffForPrompt(rawShardDiff, CLI_AGENTIC_PRE_COMPUTED_DIFF_HARD_LIMIT);
            }
          } catch (error) {
            console.warn(`[ReviewService] ${reviewType} ${reviewId || 'unknown'} shard ${idx + 1} pre-computed diff failed, agent will run git diff:`, error.message);
          }
        }

        const shardBehavioralHotspots = buildBehavioralHotspotDistillation(shardPreComputedDiff, shardHints);
        const shardDistilledHints = shardHints.map((hint) => {
          const signals = shardBehavioralHotspots.perPath.get(hint.path) || [];
          const riskBoost = signals.reduce((sum, signal) => sum + Math.max(0, Number(signal.score) || 0), 0);
          return {
            ...hint,
            behavioralSignals: signals.map((signal) => signal.id),
            behavioralSummary: signals.slice(0, 2).map((signal) => signal.summary).join('; ') || hint.behavioralSummary || null,
            riskScore: (Number(hint.riskScore) || 0) + riskBoost,
          };
        });
        const { detailedHints: shardDetailedHints, summaryHints: shardSummaryHints } =
          tierFileHintsForAgenticPrompt(shardDistilledHints, shardHints.length);
        const shardPromptHints = isPrDiscoveryMode
          ? shardDistilledHints.slice(0, Math.min(shardDistilledHints.length, 8))
          : shardDetailedHints;
        const shardOmittedHintCount = Math.max(0, shardDistilledHints.length - shardPromptHints.length);
        const shardPromptSummaryHints = isPrDiscoveryMode
          ? (
            shardOmittedHintCount > 0
              ? `## Additional changed files\n\n- ${shardOmittedHintCount} lower-priority changed file${shardOmittedHintCount === 1 ? '' : 's'} were omitted from the detailed list. Expand only if the top files do not explain the risky behavior.`
              : null
          )
          : shardSummaryHints;

        const shardPrompt = buildAgenticPromptForMode({
          branchName,
          baseBranch,
          mergeBaseSha,
          headSha,
          prTitle,
          prBody,
          prCommitsSummary,
          fileHints: shardPromptHints,
          ignorePatterns,
          outputSchema: REVIEW_OUTPUT_SCHEMA,
          fileCount: shardHints.length,
          maxTurns: shardMaxTurns,
          minimumDeepReviewedFiles: null,
          minimumCoverageRate: null,
          preferFileListOnly: providerType === 'google',
          summaryHints: shardPromptSummaryHints,
          behavioralHotspotsSummary: shardBehavioralHotspots.summary,
          reviewProfile,
          shapedScope: shapedScopeTelemetry,
          linterFindings: isPrDiscoveryMode
            ? []
            : filterPromptLinterFindingsForFileHints(agenticPromptLinterFindings, shardHints),
          shardContext: {
            shardIndex: idx + 1,
            totalShards: shards.length,
            totalFiles,
          },
          preComputedDiff: shardPreComputedDiff,
          discoveryMode: isPrDiscoveryMode,
          diffMode,
          reviewModelStrategy: reviewModelConfig?.strategy,
          intendedExplorationMode: intendedExplorationDecision?.mode || null,
          intendedExplorationModeReasons: intendedExplorationDecision?.reasonCodes || [],
          runtimeMcpEnabled: runtimeMcpEnabledForReview,
          codegraphMcpEnabled: codegraphMcpEnabledForReview,
        });
        await writeReviewDebugText({
          projectId,
          projectPath,
          reviewType,
          reviewId,
        }, `prompt-agentic-shard-${idx + 1}`, shardPrompt);

        totalShardPromptChars += shardPrompt.length;

        const shardDecisionContext = buildRoutingDecisionContext({
          files: shardHints.map((hint) => ({ path: hint.path })),
          riskFlags: { largeBlastRadius: totalFiles > LARGE_REVIEW_FILE_COUNT },
          diffChars: shardHints.reduce((sum, hint) => sum + (Number(hint.riskScore) || 0), 0),
          fallbackFileCount: shardHints.length,
          focusedReview: false,
          projectId: projectId || null,
          reviewType,
          reviewId,
          branchName: branchName || null,
          baseBranch: baseBranch || null,
          headSha: headSha || null,
          mergeBaseSha: mergeBaseSha || null,
          projectPath,
        });
        shardDecisionContext._executionModeOrder = executionModeOrder;
        shardDecisionContext.maxTurns = shardMaxTurns;
        shardDecisionContext.agenticTier = 'large';
        shardDecisionContext.reviewExecutionMode = 'cli-agentic';
        shardDecisionContext.agenticDiscoveryMode = isPrDiscoveryMode;
        // Section R Phase B: shard reviews get the same runtime MCP wiring
        // as the top-level path. Without this, large Anthropic Performance
        // reviews would silently fall back to the Phase A.0 Bash pattern
        // even though the top-level review opted into MCP — defeating the
        // purpose on the high-value sharded path.
        shardDecisionContext.runtimeMcpEnabled = runtimeMcpEnabledForReview;
        shardDecisionContext.codegraphMcpEnabled = codegraphMcpEnabledForReview;

        let shardResult;
        try {
          shardResult = await providerCaller(agenticFailoverState, shardPrompt, {
            maxRetries: 0,
            deadline,
            modelPhase: 'review',
            reviewModelConfig,
            unavailableModels,
            modelDecisionContext: shardDecisionContext,
            onToolUse: buildAgenticToolUseHandler(shardHints.length, shardMaxTurns),
            onRetry: buildAgenticRetryHandler(),
            reviewTiming,
          });
        } catch (error) {
          if (error?.isDeadline) {
            deadlineHit = true;
            shardFailures.push({ idx, reason: 'deadline', error });
          } else {
            shardFailures.push({ idx, reason: 'error', error });
          }
          console.warn(`[ReviewService] ${reviewType} ${reviewId || 'unknown'} shard ${idx + 1}/${shards.length} failed: ${error?.message || error}`);
          return;
        }

        if (!shardResult?.text || typeof shardResult.text !== 'string') {
          console.warn(`[ReviewService] ${reviewType} ${reviewId || 'unknown'} shard ${idx + 1}/${shards.length} returned empty response, skipping.`);
          shardFailures.push({ idx, reason: 'empty_response' });
          return;
        }

        const parsedShard = await parseAgenticResponseForMode(shardResult.text, {
          diffText: shardPreComputedDiff,
          filePaths: shardHints.map((hint) => hint.path),
          fileCount: shardHints.length,
          totalAdditions,
          totalDeletions,
          qualityMode,
          agenticMode: true,
          reviewPolicy,
        }, {
          debugLabel: `prompt-agentic-discovery-extraction-shard-${idx + 1}`,
          resultLabel: `result-agentic-discovery-extraction-shard-${idx + 1}`,
          chunkIndex: idx + 1,
          totalChunks: shards.length,
        });

        if (shardResult.providerData) {
          selectedProviderData = shardResult.providerData;
        }
        markModelUsed('review', shardResult.modelUsed);
        shardResults.push({
          review: parsedShard,
          tokensUsed: shardResult.tokensUsed || { input: 0, output: 0 },
          agenticMeta: shardResult.agenticMeta || null,
        });
      }
    );

    if (shardResults.length === 0) {
      const firstHardError = shardFailures.find((f) => f.error);
      if (firstHardError?.error) {
        throw firstHardError.error;
      }
      throw new Error('All parallel agentic shards returned empty responses');
    }

    const aggregated = aggregateChunkReviews(shardResults, {
      fallbackSummary: `Reviewed ${totalFiles} files across ${shards.length} parallel agentic shards.`,
      fileCount: totalFiles,
      totalFileCount: totalFiles,
      focusedFileCount: totalFiles,
      omittedFileCount: 0,
      filePaths: fileHints.map((entry) => entry.path),
      totalAdditions,
      totalDeletions,
      reviewPolicy,
    });

    const isPartialShardOutcome = shardFailures.length > 0;
    if (isPartialShardOutcome) {
      const deadlineFailure = shardFailures.find(
        (f) => f.reason === 'deadline'
          || f.reason === 'skipped_after_deadline'
          || f.reason === 'skipped_deadline_pressure'
      );
      annotatePartialReview(aggregated, {
        completedChunks: shardResults.length,
        totalChunks: shards.length,
        errorMessage: deadlineFailure
          ? `Review deadline reached; ${shardFailures.length}/${shards.length} shard(s) did not complete.`
          : `${shardFailures.length}/${shards.length} shard(s) failed before completion.`,
        errorClass: deadlineFailure ? 'deadline' : null,
        remainingChunkStatus: deadlineFailure ? 'skipped' : 'failed',
      });
    }

    reviewResult = aggregated.review;
    agenticTokensUsed = aggregated.tokensUsed || { input: 0, output: 0 };
    if (!reviewResult.stats || typeof reviewResult.stats !== 'object') {
      reviewResult.stats = {};
    }
    reviewResult.stats.executionMode = 'cli-agentic';
    reviewResult.stats.agenticReview = true;
    reviewResult.stats.agenticTier = 'large';
    reviewResult.stats.agenticShardCount = shards.length;
    reviewResult.stats.agenticShardResultCount = shardResults.length;
    reviewResult.stats.fileCount = totalFiles;
    reviewResult.stats.lockSkippedCount = lockSkippedCount;

    const shardTurnCounts = shardResults
      .map((result) => result.agenticMeta?.actualTurns)
      .filter((count) => typeof count === 'number');
    reviewResult.stats.agenticMaxTurns = computeAgenticMaxTurns(shards[0]?.length || 0, 'large');
    reviewResult.stats.agenticActualTurns = shardTurnCounts.length > 0
      ? Math.max(...shardTurnCounts)
      : null;
    reviewResult.stats.agenticTotalShardTurns = shardTurnCounts.length > 0
      ? shardTurnCounts.reduce((sum, count) => sum + count, 0)
      : null;
    reviewResult.stats.agenticCompletionReason = isPartialShardOutcome
      ? (deadlineHit ? 'partial_deadline' : 'partial_error')
      : 'success';
    reviewResult.stats.agenticShardFailureCount = shardFailures.length;
    if (isPartialShardOutcome) {
      reviewResult.stats.agenticShardFailures = shardFailures.map((f) => ({
        index: f.idx,
        reason: f.reason,
        message: f.error?.message || null,
      }));
    }
    reviewResult.stats.agenticToolUseCount = agenticToolUseCount;
    reviewResult.stats.agenticPreComputedDiff = preComputedDiff != null;
    reviewResult.stats.agenticDurationMs = Date.now() - providerStartedAt;
    attachPerformanceStatsBlock(reviewResult.stats, reviewResult.stats);
  } else {
    let agenticResult;
    try {
      agenticResult = await providerCaller(agenticFailoverState, agenticPrompt, {
        maxRetries: 0,
        deadline,
        modelPhase: 'review',
        reviewModelConfig,
        unavailableModels,
        modelDecisionContext: agenticModelDecisionContext,
        onToolUse: buildAgenticToolUseHandler(
          totalFiles,
          isPrDiscoveryMode ? discoveryMaxTurns : dynamicMaxTurns,
        ),
        onRetry: buildAgenticRetryHandler(),
        reviewTiming,
      });
    } catch (error) {
      if (!shouldFallbackFromAgenticRuntimeError(error)) {
        throw error;
      }
      const classification = classifyReviewRuntimeError(error);
      fallbackMeta = {
        mode: 'diff_followup',
        reason: 'agentic_runtime_failure',
        errorClass: classification.legacyClass || classification.runtimeClass || null,
        errorMessage: error?.message || String(error || 'Agentic review failed'),
      };
      emitProgress({
        phase: 'synthesizing',
        totalFiles,
        agentName,
        agenticToolSummary: `${agentName} agentic review did not complete; running structured follow-up review.`,
      });
      console.warn(
        `[ReviewService] ${reviewType} ${reviewId || 'unknown'} agentic review failed with `
        + `${classification.legacyClass || classification.runtimeClass || 'unknown'}; falling back to non-agentic execution: `
        + `${error?.message || error}`
      );
    }

    if (fallbackMeta) {
      return {
        accepted: false,
        reviewResult: null,
        tokenUsage: agenticTokensUsed,
        modelUsed: agenticModelUsed,
        selectedProviderData,
        fallbackMeta,
      };
    }

    if (agenticResult?.providerData) {
      selectedProviderData = agenticResult.providerData;
    }
    markModelUsed('review', agenticResult?.modelUsed);
    agenticTokensUsed = agenticResult?.tokensUsed || { input: 0, output: 0 };
    agenticModelUsed = agenticResult?.modelUsed || null;

    if (!agenticResult?.text || typeof agenticResult.text !== 'string') {
      throw new Error('Agentic review returned empty or invalid response');
    }

    reviewResult = await parseAgenticResponseForMode(agenticResult.text, {
      diffText: preComputedDiff,
      filePaths: fileHints.map((entry) => entry.path),
      fileCount: totalFiles,
      totalAdditions,
      totalDeletions,
      qualityMode,
      agenticMode: true,
      reviewPolicy,
    }, {
      debugLabel: 'prompt-agentic-discovery-extraction-top-level',
      resultLabel: 'result-agentic-discovery-extraction-top-level',
      chunkIndex: 1,
      totalChunks: 1,
    });

    if (!reviewResult.stats || typeof reviewResult.stats !== 'object') {
      reviewResult.stats = {};
    }
    reviewResult.stats.executionMode = 'cli-agentic';
    reviewResult.stats.agenticReview = true;
    reviewResult.stats.agenticTier = agenticTier;
    reviewResult.stats.agenticShardCount = 1;
    reviewResult.stats.agenticShardResultCount = 1;
    reviewResult.stats.fileCount = totalFiles;
    reviewResult.stats.lockSkippedCount = lockSkippedCount;

    const meta = agenticResult.agenticMeta || {};
    reviewResult.stats.agenticMaxTurns = isPrDiscoveryMode ? discoveryMaxTurns : dynamicMaxTurns;
    reviewResult.stats.agenticActualTurns = meta.actualTurns ?? null;
    reviewResult.stats.agenticCompletionReason = meta.completionReason || 'success';
    reviewResult.stats.agenticToolUseCount = agenticToolUseCount;
    reviewResult.stats.agenticPreComputedDiff = preComputedDiff != null;
    reviewResult.stats.agenticDurationMs = Date.now() - providerStartedAt;
    reviewResult.stats.agenticCostUsd = meta.costUsd ?? null;
    attachPerformanceStatsBlock(reviewResult.stats, reviewResult.stats);
  }

  reviewResult = await runCandidateFindingPromotionPass(reviewResult, {
    verifyCandidate: async (candidateFinding, verifierMeta = {}) => {
      emitHeartbeat('provider_call');
      deadline?.check?.(REVIEW_DEADLINE_START_BUFFER_MS, 'candidate verifier pass');
      const verifierDiff = typeof preComputedDiff === 'string' && preComputedDiff.length > 0
        ? preComputedDiff
        : prepareDiffForPrompt(
          await diffLoader(projectPath, mergeBaseSha, headSha).catch(() => ''),
          REVIEW_TWO_PASS_VERIFIER_DIFF_HARD_LIMIT
        );
      const verifierPrompt = buildHighRiskVerifierPrompt(verifierDiff, candidateFinding, {
        title: `${reviewType}:${branchName || reviewId || 'agentic_review'}`,
        fileCount: totalFiles,
        totalAdditions,
        totalDeletions,
      });
      const verifierDecisionContext = buildRoutingDecisionContext({
        files: safeFileHintsInput,
        riskFlags: {
          largeBlastRadius: totalFiles > LARGE_REVIEW_FILE_COUNT,
        },
        diffChars: safeFileHintsInput.reduce(
          (sum, entry) => sum + (Number(entry.reviewSizeHint) || 0),
          0
        ),
        fallbackFileCount: totalFiles,
        focusedReview: false,
        projectId: projectId || null,
        reviewType,
        reviewId,
        branchName: branchName || null,
        baseBranch: baseBranch || null,
        headSha: headSha || null,
        mergeBaseSha: mergeBaseSha || null,
        projectPath,
      });
      verifierDecisionContext._executionModeOrder = executionModeOrder;
      verifierDecisionContext.reviewExecutionMode = 'cli-agentic';
      const verifierStartedAt = Date.now();
      const result = await providerCaller(agenticFailoverState, verifierPrompt, {
        maxRetries: 0,
        deadline,
        modelPhase: 'verifier',
        reviewModelConfig,
        unavailableModels,
        modelDecisionContext: verifierDecisionContext,
        onRetry: buildAgenticRetryHandler(),
        reviewTiming,
      });
      recordProviderTiming(reviewTiming, {
        scope: 'candidate_verifier',
        chunkIndex: Number(verifierMeta?.ordinal || 1),
        totalChunks: Number(verifierMeta?.maxFindings || 1),
        fileCount: totalFiles,
        diffChars: verifierDiff.length,
        promptChars: verifierPrompt.length,
        promptBuildMs: 0,
        providerMs: Date.now() - verifierStartedAt,
      });
      if (result?.providerData) {
        selectedProviderData = result.providerData;
      }
      markModelUsed('verifier', result?.modelUsed);
      agenticTokensUsed.input += Math.max(0, Number(result?.tokensUsed?.input || 0));
      agenticTokensUsed.output += Math.max(0, Number(result?.tokensUsed?.output || 0));
      return parseHighRiskVerifierDecision(result?.text || '');
    },
  });

  applyReviewProfileStats(reviewResult, {
    reviewProfile,
    shapedScopeTelemetry,
  });
  reviewResult.stats = {
    ...(reviewResult.stats && typeof reviewResult.stats === 'object' ? reviewResult.stats : {}),
    prPipelineMode: isPrDiscoveryMode ? 'agentic_discovery' : 'standard',
  };
  const agenticReviewResolution = resolveEffectiveReviewModel(
    selectedProviderData || providerData,
    'review',
    reviewModelConfig,
    agenticModelDecisionContext
  );
  reviewResult.stats.reviewModelStrategy = normalizeReviewModelStrategy(reviewModelConfig.strategy);
  reviewResult.stats.reviewModelEffectiveStrategy =
    normalizeReviewModelStrategy(agenticReviewResolution.effectiveStrategy || agenticReviewResolution.strategy);
  reviewResult.stats.reviewModelPolicyVersion =
    agenticReviewResolution.policyVersion || REVIEW_MODEL_ROUTING_POLICY_VERSION;
  reviewResult.stats.reviewModelDecisionInputs = {
    ...agenticReviewResolution.decisionInputs,
  };
  reviewResult.stats.reviewModelDecisionReason = agenticReviewResolution.decisionReason || null;
  reviewResult.stats.reviewModelFallbackReason = agenticReviewResolution.fallbackReason || null;
  reviewResult.stats.reviewModelBudgetClass = agenticReviewResolution.budgetClass || 'balanced';
  reviewResult.stats.reviewModelThresholdProfile = agenticReviewResolution.thresholdProfile || null;
  reviewResult.stats.reviewModelRollout = {
    mode: agenticReviewResolution.rollout?.mode || DEFAULT_REVIEW_MODEL_ROLLOUT.mode,
    enabled: Boolean(agenticReviewResolution.rollout?.enabled),
    reason: agenticReviewResolution.rollout?.reason || null,
    canaryPercent: Number(agenticReviewResolution.rollout?.canaryPercent || 0),
    canaryBucket: Number(agenticReviewResolution.rollout?.canaryBucket || 0),
    allowlistEnabled: Boolean(agenticReviewResolution.rollout?.allowlistEnabled),
    allowlistMatched: Boolean(agenticReviewResolution.rollout?.allowlistMatched),
    gate: {
      status: agenticReviewResolution.rollout?.gate?.status || DEFAULT_REVIEW_MODEL_ROLLOUT.gate.status,
      reasonCodes: normalizeReasonCodeList(agenticReviewResolution.rollout?.gate?.reasonCodes || [], 20),
      source: agenticReviewResolution.rollout?.gate?.source || DEFAULT_REVIEW_MODEL_ROLLOUT.gate.source,
      evaluatedAt: agenticReviewResolution.rollout?.gate?.evaluatedAt || null,
    },
  };

  console.info(
    `[ReviewService] AGENTIC_TIER_METRICS reviewType=${reviewType}`
    + ` reviewId=${reviewId || 'unknown'}`
    + ` tier=${reviewResult.stats.agenticTier}`
    + ` maxTurns=${reviewResult.stats.agenticMaxTurns}`
    + ` actualTurns=${reviewResult.stats.agenticActualTurns ?? '?'}`
    + ` toolUses=${reviewResult.stats.agenticToolUseCount}`
    + ` files=${reviewResult.stats.fileCount}`
    + ` completion=${reviewResult.stats.agenticCompletionReason}`
    + ` preComputedDiff=${reviewResult.stats.agenticPreComputedDiff}`
    + ` durationMs=${reviewResult.stats.agenticDurationMs}`
    + (reviewResult.stats.agenticShardCount ? ` shards=${reviewResult.stats.agenticShardCount}` : '')
    + (reviewResult.stats.agenticCostUsd != null ? ` costUsd=${reviewResult.stats.agenticCostUsd}` : '')
  );

  const providerMs = Date.now() - providerStartedAt;
  const effectivePromptChars = totalShardPromptChars > 0
    ? totalShardPromptChars
    : agenticPrompt.length;
  recordProviderTiming(reviewTiming, {
    scope: 'agentic',
    fileCount: totalFiles,
    diffChars: effectivePromptChars,
    promptChars: effectivePromptChars,
    promptBuildMs: 0,
    providerMs,
  });
  recordFirstSignal(reviewTiming, {
    scope: 'agentic',
    filesCompleted: totalFiles,
    totalFiles,
  });

  const agenticCoverage = evaluateAgenticCoverageResult({
    providerType: selectedProviderData?.provider?.type || providerType,
    totalFiles,
    stats: reviewResult.stats,
  });

  if (agenticCoverage.insufficientCoverage) {
    const uncoveredFiles = identifyUncoveredFiles(reviewResult, fileHints);
    if (uncoveredFiles.length === 0) {
      console.info(
        `[ReviewService] ${reviewType} ${reviewId || 'unknown'} agentic coverage stats below floor but all files covered; accepting result.`
      );
    } else if (uncoveredFiles.length <= 15) {
      emitProgress({
        phase: 'synthesizing',
        totalFiles,
        agentName,
        agenticToolSummary: `${agentName} agentic review covered ${agenticCoverage.reportedDeepReviewedFiles}/${agenticCoverage.totalFiles} files; running targeted follow-up on ${uncoveredFiles.length} uncovered files.`,
      });
      console.info(
        `[ReviewService] ${reviewType} ${reviewId || 'unknown'} agentic partial coverage gap: ${uncoveredFiles.length} uncovered files; running targeted non-agentic follow-up.`
      );
      fallbackMeta = {
        mode: 'partial_followup',
        reason: 'partial_coverage_gap',
        uncoveredFileCount: uncoveredFiles.length,
        uncoveredFiles: uncoveredFiles.map((file) => file.path),
        agenticReviewResult: reviewResult,
        agenticTokensUsed,
        ...agenticCoverage,
      };
    } else {
      fallbackMeta = {
        mode: 'diff_followup',
        reason: 'insufficient_deep_coverage',
        ...agenticCoverage,
      };
      emitProgress({
        phase: 'synthesizing',
        totalFiles,
        agentName,
        agenticToolSummary: `${agentName} agentic coverage ${agenticCoverage.reportedDeepReviewedFiles}/${agenticCoverage.totalFiles} below required ${agenticCoverage.minimumDeepReviewedFiles}; running structured follow-up review.`,
      });
      console.warn(
        `[ReviewService] ${reviewType} ${reviewId || 'unknown'} agentic coverage below floor `
        + `(${agenticCoverage.reportedDeepReviewedFiles}/${agenticCoverage.totalFiles}, `
        + `required ${agenticCoverage.minimumDeepReviewedFiles}); falling back to non-agentic execution.`
      );
    }
  }

  // Merge standalone deterministic findings (agentic path)
  if (!fallbackMeta && reviewResult && agenticLinterPrePass) {
    reviewResult = mergePrePassFindingsIntoReview(reviewResult, agenticLinterPrePass);
  }

  // Partial-mode: annotate with reviewed/deferred file accounting so the user
  // can see what was skipped and run a follow-up partial on the remainder.
  if (!fallbackMeta && reviewResult && isPartialMode && deferredFileHints.length > 0) {
    if (!reviewResult.stats || typeof reviewResult.stats !== 'object') {
      reviewResult.stats = {};
    }
    reviewResult.stats.partialMode = true;
    reviewResult.stats.partialReviewedFileCount = fileHints.length;
    reviewResult.stats.partialDeferredFileCount = deferredFileHints.length;
    reviewResult.stats.partialDeferredFiles = deferredFileHints.map((h) => h.path);
    // Skip the file-level partial annotation if shard failures already produced
    // a shard-level annotation; otherwise the second call would overwrite
    // partialChunksCompleted/partialChunksTotal with file counts and lose the
    // shard accounting set by the failure path.
    if (reviewResult.stats.isPartial !== true) {
      annotatePartialReview({ review: reviewResult }, {
        completedChunks: fileHints.length,
        totalChunks: totalFilesAll,
        errorMessage: `Partial review: ${fileHints.length}/${totalFilesAll} highest-risk files reviewed; ${deferredFileHints.length} deferred. Run a follow-up partial review to cover the rest.`,
        errorClass: null,
        remainingChunkStatus: 'skipped',
      });
    }
  }

  return {
    accepted: !fallbackMeta,
    reviewResult: fallbackMeta ? null : reviewResult,
    tokenUsage: agenticTokensUsed,
    modelUsed: agenticModelUsed,
    selectedProviderData,
    fallbackMeta,
  };
}

function classifyFileForPerFileReview(file) {
  if (!file || typeof file !== 'object') return 'skip';
  const normalizedPath = normalizePathForMatch(file.path);
  if (!normalizedPath) return 'skip';

  if (
    file.status === 'R'
    && typeof file.before === 'string'
    && typeof file.after === 'string'
    && file.before === file.after
  ) {
    return 'skip';
  }

  const estimatedChars = estimateFileReviewSize(file);
  if ((DOC_FILE_RE.test(normalizedPath) || TEST_FILE_RE.test(normalizedPath)) && estimatedChars <= REVIEW_PER_FILE_TRIVIAL_FILE_CHARS) {
    return 'trivial';
  }
  if (estimatedChars >= REVIEW_PER_FILE_LARGE_FILE_CHARS) {
    return 'large';
  }
  return 'standard';
}

function resolveChunkCharLimit(providerData) {
  if (!providerData) return REVIEW_CHUNK_CHAR_LIMIT;
  if (providerData.useCodexCLI) return REVIEW_CHUNK_CHAR_LIMIT_CODEX_CLI;
  if (providerData.useClaudeCLI) return REVIEW_CHUNK_CHAR_LIMIT_CLAUDE_CLI;
  if (providerData.useGeminiCLI) return REVIEW_CHUNK_CHAR_LIMIT_GEMINI_CLI;
  if (providerData.useOpenCodeCLI) return REVIEW_CHUNK_CHAR_LIMIT_OPENCODE_CLI;
  return REVIEW_CHUNK_CHAR_LIMIT;
}

function resolveChunkConcurrency(providerData, chunkCount) {
  const safeChunkCount = Math.max(1, Math.trunc(Number(chunkCount) || 1));
  const isCliProvider = Boolean(providerData?.useCodexCLI || providerData?.useClaudeCLI || providerData?.useGeminiCLI || providerData?.useOpenCodeCLI);
  const configured = isCliProvider ? REVIEW_CHUNK_CONCURRENCY_CLI : REVIEW_CHUNK_CONCURRENCY;
  return Math.min(Math.max(1, Math.trunc(Number(configured) || 1)), safeChunkCount);
}

function resolvePromptHardLimit(providerData) {
  if (!providerData) return REVIEW_PROMPT_HARD_LIMIT_DEFAULT;
  if (providerData.useCodexCLI) return REVIEW_PROMPT_HARD_LIMIT_CODEX_CLI;
  if (providerData.useClaudeCLI) return REVIEW_PROMPT_HARD_LIMIT_CLAUDE_CLI;
  if (providerData.useGeminiCLI) return REVIEW_PROMPT_HARD_LIMIT_GEMINI_CLI;
  if (providerData.useOpenCodeCLI) return REVIEW_PROMPT_HARD_LIMIT_OPENCODE_CLI;
  return REVIEW_PROMPT_HARD_LIMIT_DEFAULT;
}

function resolveSingleReviewDiffLimit(providerData) {
  if (!providerData) return SINGLE_REVIEW_DIFF_LIMIT_DEFAULT;
  if (providerData.useCodexCLI) return SINGLE_REVIEW_DIFF_LIMIT_CODEX_CLI;
  if (providerData.useClaudeCLI) return SINGLE_REVIEW_DIFF_LIMIT_CLAUDE_CLI;
  if (providerData.useGeminiCLI) return SINGLE_REVIEW_DIFF_LIMIT_GEMINI_CLI;
  if (providerData.useOpenCodeCLI) return SINGLE_REVIEW_DIFF_LIMIT_OPENCODE_CLI;
  return SINGLE_REVIEW_DIFF_LIMIT_DEFAULT;
}

async function persistChangesetTerminalState(projectPath, changesetId, {
  reviewStatus,
  reviewData = undefined,
  reviewRiskLevel = undefined,
  reviewSummary = undefined,
  reviewedBy = undefined,
  reviewedAt = undefined,
  reviewError = undefined,
} = {}) {
  const payload = {
    reviewStatus,
    reviewData,
    reviewRiskLevel,
    reviewSummary,
    reviewedBy,
    reviewedAt,
    reviewError,
  };
  Object.keys(payload).forEach((key) => {
    if (payload[key] === undefined) {
      delete payload[key];
    }
  });
  await updateChangeSetReview(projectPath, changesetId, payload);
  try {
    const { default: trustAnalyticsFactService } = await import('./trustAnalyticsFactService.js');
    await trustAnalyticsFactService.syncReviewFacts({
      projectPath,
      reviewType: 'changeset',
      reviewId: changesetId,
    });
  } catch (error) {
    console.warn(`Failed to sync Trust Analytics facts for changeset ${changesetId}:`, error.message);
  }
}

function buildReviewSettingsFailureMessage(error, reviewSurfaceLabel = 'Review') {
  const surfaceLabel = typeof reviewSurfaceLabel === 'string' && reviewSurfaceLabel.trim()
    ? reviewSurfaceLabel.trim()
    : 'Review';
  const settingLabel = typeof error?.settingLabel === 'string' && error.settingLabel.trim()
    ? error.settingLabel.trim()
    : 'review settings';
  return `${surfaceLabel} could not load ${settingLabel}. Check Review Settings or database connectivity and retry.`;
}

function normalizeReviewSettingsReadError(error, reviewSurfaceLabel = 'Review') {
  if (!isSettingsReadError(error)) return error;
  console.warn('[ReviewService] Review settings read failed', {
    reviewSurface: reviewSurfaceLabel,
    settingKey: error.settingKey || null,
    settingLabel: error.settingLabel || null,
    operation: error.operation || null,
    cause: error.cause?.message || error.message,
  });
  return createReviewRuntimeError(
    buildReviewSettingsFailureMessage(error, reviewSurfaceLabel),
    'invalid_request',
    {
      cause: error,
      settingsReadFailure: true,
      settingKey: error.settingKey || null,
      settingLabel: error.settingLabel || null,
    }
  );
}

async function loadReviewSettingOrThrow(loader, reviewSurfaceLabel = 'Review') {
  try {
    return await loader();
  } catch (error) {
    throw normalizeReviewSettingsReadError(error, reviewSurfaceLabel);
  }
}

async function persistPreflightSettingsFailure(persistFailure, error) {
  if (!error?.settingsReadFailure || typeof persistFailure !== 'function') {
    throw error;
  }
  const persistedReviewError = buildPersistedReviewErrorMessage(error);
  error.persistedReviewError = persistedReviewError;
  await persistFailure(persistedReviewError);
  throw error;
}

function getReviewParseMode(review) {
  if (typeof review?.stats?.parseMode !== 'string') return 'strict_json';
  const parseMode = review.stats.parseMode.trim();
  return parseMode || 'strict_json';
}

function isDeepParseRecoveryReview(review) {
  const parseMode = getReviewParseMode(review).toLowerCase();
  return parseMode === 'section_salvage' || parseMode === 'minimal_fallback';
}

function logParseRecoveryVisibility(review, {
  reviewType = 'review',
  reviewId = null,
  stage = 'review',
} = {}) {
  if (!isDeepParseRecoveryReview(review)) return review;
  const parseMode = getReviewParseMode(review);
  const reviewLabel = typeof reviewType === 'string' && reviewType.trim()
    ? reviewType.trim()
    : 'review';
  const reviewKey = typeof reviewId === 'string' && reviewId.trim()
    ? reviewId.trim()
    : 'unknown';
  const stageLabel = typeof stage === 'string' && stage.trim()
    ? stage.trim()
    : 'review';
  console.warn(
    `[ReviewService] ${reviewLabel} ${reviewKey} used deep parse recovery (${parseMode}) during ${stageLabel}; review may be incomplete.`
  );
  return review;
}

function parseReviewResponseWithVisibility(rawText, parseContext = {}, visibility = {}) {
  const parsed = parseReviewResponse(rawText, parseContext);
  return logParseRecoveryVisibility(parsed, visibility);
}

async function persistBranchReviewTerminalState(branchReviewId, {
  reviewStatus,
  reviewRiskLevel = undefined,
  reviewSummary = undefined,
  reviewJson = undefined,
  reviewError = undefined,
  reviewBaseBranch = undefined,
  reviewMergeBaseSha = undefined,
  reviewForkPointSha = undefined,
  reviewHeadSha = undefined,
  reviewedAt = undefined,
} = {}) {
  const payload = {
    review_status: reviewStatus,
    review_risk_level: reviewRiskLevel,
    review_summary: reviewSummary,
    review_json: reviewJson,
    review_error: reviewError,
    review_base_branch: reviewBaseBranch,
    review_merge_base_sha: reviewMergeBaseSha,
    review_fork_point_sha: reviewForkPointSha,
    review_head_sha: reviewHeadSha,
    reviewed_at: reviewedAt,
  };
  Object.keys(payload).forEach((key) => {
    if (payload[key] === undefined) {
      delete payload[key];
    }
  });
  const updated = await branchReviewService.updateReview(branchReviewId, payload);
  try {
    const { default: trustAnalyticsFactService } = await import('./trustAnalyticsFactService.js');
    await trustAnalyticsFactService.syncReviewFacts({
      projectId: updated?.projectId || null,
      reviewType: 'branch_review',
      reviewId: branchReviewId,
    });
  } catch (error) {
    console.warn(`Failed to sync Trust Analytics facts for branch review ${branchReviewId}:`, error.message);
  }
}

function attachReviewCostMetadata(reviewPayload, {
  providerType,
  model,
  tokensUsed,
  providerNativeCost = null,
} = {}) {
  if (!reviewPayload || typeof reviewPayload !== 'object' || Array.isArray(reviewPayload)) {
    return null;
  }

  const costSnapshot = usageService.buildCostSnapshot({
    providerType,
    model,
    inputTokens: Math.max(0, Number(tokensUsed?.input || 0)),
    outputTokens: Math.max(0, Number(tokensUsed?.output || 0)),
    providerNativeCost,
  });

  if (!reviewPayload.stats || typeof reviewPayload.stats !== 'object' || Array.isArray(reviewPayload.stats)) {
    reviewPayload.stats = {};
  }

  reviewPayload.estimatedCost = costSnapshot.estimatedCost;
  reviewPayload.costSource = costSnapshot.costSource;
  reviewPayload.costIsApproximate = costSnapshot.costIsApproximate;
  reviewPayload.stats.estimatedCostUsd = costSnapshot.estimatedCost;
  reviewPayload.stats.costSource = costSnapshot.costSource;
  reviewPayload.stats.costIsApproximate = costSnapshot.costIsApproximate;
  reviewPayload.stats.providerNativeCostUsd = costSnapshot.providerNativeCost;
  reviewPayload.stats.costPricingKey = costSnapshot.pricingKey;

  return costSnapshot;
}

function buildPrReviewTerminalUpdatePayload({
  reviewStatus,
  reviewRiskLevel = undefined,
  reviewSummary = undefined,
  reviewJson = undefined,
  reviewError = undefined,
  reviewHeadSha = undefined,
  reviewedAt = undefined,
} = {}) {
  const payload = {
    review_status: reviewStatus,
    review_risk_level: reviewRiskLevel,
    review_summary: reviewSummary,
    review_json: reviewJson,
    review_error: reviewError,
    review_head_sha: reviewHeadSha,
    reviewed_at: reviewedAt,
  };
  if (reviewStatus === 'failed') {
    payload.review_risk_level = reviewRiskLevel === undefined ? null : reviewRiskLevel;
    payload.review_summary = reviewSummary === undefined ? null : reviewSummary;
    payload.review_json = reviewJson === undefined ? null : reviewJson;
    payload.review_head_sha = reviewHeadSha === undefined ? null : reviewHeadSha;
    payload.reviewed_at = reviewedAt === undefined ? null : reviewedAt;
  }
  Object.keys(payload).forEach((key) => {
    if (payload[key] === undefined) delete payload[key];
  });
  return payload;
}

async function persistPrReviewTerminalState(prReviewId, options = {}) {
  const payload = buildPrReviewTerminalUpdatePayload(options);
  const updated = await prReviewService.updateReview(prReviewId, payload);
  try {
    const { default: trustAnalyticsFactService } = await import('./trustAnalyticsFactService.js');
    await trustAnalyticsFactService.syncReviewFacts({
      projectId: updated?.projectId || null,
      reviewType: 'pr_review',
      reviewId: prReviewId,
    });
  } catch (error) {
    console.warn(`Failed to sync Trust Analytics facts for PR review ${prReviewId}:`, error.message);
  }
}

async function persistWorkspaceReviewTerminalState(projectPath, workspaceReviewId, {
  reviewStatus,
  reviewRiskLevel = undefined,
  reviewSummary = undefined,
  reviewJson = undefined,
  reviewError = undefined,
  reviewHeadSha = undefined,
  reviewSnapshotKey = undefined,
  reviewedAt = undefined,
} = {}) {
  const payload = {
    reviewStatus,
    reviewRiskLevel,
    reviewSummary,
    reviewJson,
    reviewError,
    reviewHeadSha,
    reviewSnapshotKey,
    reviewedAt,
  };
  Object.keys(payload).forEach((key) => {
    if (payload[key] === undefined) delete payload[key];
  });
  const updated = await workspaceReviewService.updateReview(projectPath, workspaceReviewId, payload);
  try {
    const { default: trustAnalyticsFactService } = await import('./trustAnalyticsFactService.js');
    await trustAnalyticsFactService.syncReviewFacts({
      projectId: updated?.projectId || null,
      projectPath,
      reviewType: 'workspace_review',
      reviewId: workspaceReviewId,
    });
  } catch (error) {
    console.warn(`Failed to sync Trust Analytics facts for workspace review ${workspaceReviewId}:`, error.message);
  }
}

function hasPersistedReviewSnapshot(review) {
  const reviewJson = review?.reviewJson;
  return Boolean(
    reviewJson
    && typeof reviewJson === 'object'
    && !Array.isArray(reviewJson)
  );
}

async function resolveStoppedBranchReviewStatus(branchReviewId) {
  const review = await branchReviewService.getById(branchReviewId).catch(() => null);
  return hasPersistedReviewSnapshot(review) ? 'reviewed' : 'none';
}

async function refreshLatestBranchReviewHeadForRun(projectPath, branchReview) {
  if (!projectPath || !branchReview?.id || !branchReview.branchName) {
    return branchReview;
  }

  const branchRef = await gitService.resolveBranchRef(projectPath, branchReview.branchName)
    .catch(() => null);
  const headRef = branchRef || branchReview.branchName;
  const liveHeadSha = await gitService.getRefSha(projectPath, headRef).catch(() => null);
  if (!liveHeadSha || liveHeadSha === branchReview.headSha) {
    return branchReview;
  }

  const updateFields = {
    head_sha: liveHeadSha,
  };
  if (isLastCommitBranchReviewScope(branchReview)) {
    const parentSha = await gitService.getRefSha(projectPath, `${headRef}^1`).catch(() => null);
    if (!parentSha) {
      console.warn(`[ReviewService] Skipping last-commit branch review refresh for ${branchReview.id}: latest HEAD has no parent.`);
      return branchReview;
    }
    updateFields.merge_base_sha = parentSha;
    updateFields.fork_point_sha = parentSha;
    updateFields.base_branch = `${branchReview.branchName}~last-commit`;
    updateFields.base_branch_source = 'last_commit';
    const diffStats = await gitService.getTwoDotDiffStats(projectPath, parentSha, liveHeadSha)
      .catch(() => null);
    if (diffStats) {
      updateFields.file_count = diffStats.fileCount;
      updateFields.total_additions = diffStats.totalAdditions;
      updateFields.total_deletions = diffStats.totalDeletions;
    }
    const updated = await branchReviewService.updateReview(branchReview.id, updateFields).catch((error) => {
      console.warn(`[ReviewService] Failed to refresh last-commit branch review ${branchReview.id} before run:`, error.message);
      return null;
    });
    return updated || {
      ...branchReview,
      headSha: liveHeadSha,
      ...(parentSha ? {
        mergeBaseSha: parentSha,
        forkPointSha: parentSha,
        baseBranch: `${branchReview.branchName}~last-commit`,
        baseBranchSource: 'last_commit',
      } : {}),
    };
  }
  const diffBaseSha = branchReview.forkPointSha || branchReview.mergeBaseSha || null;
  if (diffBaseSha) {
    const diffStats = await gitService.getThreeDotDiffStats(projectPath, diffBaseSha, liveHeadSha)
      .catch(() => null);
    if (diffStats) {
      updateFields.file_count = diffStats.fileCount;
      updateFields.total_additions = diffStats.totalAdditions;
      updateFields.total_deletions = diffStats.totalDeletions;
    }
  }

  const updated = await branchReviewService.updateReview(branchReview.id, updateFields).catch((error) => {
    console.warn(`[ReviewService] Failed to refresh branch review ${branchReview.id} before run:`, error.message);
    return null;
  });
  if (!updated) {
    return {
      ...branchReview,
      headSha: liveHeadSha,
    };
  }

  console.log(`[ReviewService] Refreshed ${branchReview.displayId || branchReview.id} to latest head ${liveHeadSha.slice(0, 12)} before review`);
  return updated;
}

async function resolveStoppedPrReviewStatus(prReviewId) {
  const review = await prReviewService.getById(prReviewId).catch(() => null);
  return hasPersistedReviewSnapshot(review) ? 'reviewed' : 'none';
}

async function resolveStoppedWorkspaceReviewStatus(projectPath, workspaceReviewId) {
  const review = await workspaceReviewService.getById(projectPath, workspaceReviewId).catch(() => null);
  return hasPersistedReviewSnapshot(review) ? 'reviewed' : 'none';
}


// ── Main review pipelines ─────────────────────────────────────────────────────

/**
 * Execute a review on a changeset
 * @param {string} projectPath - Project path
 * @param {string} changesetId - Changeset ID
 * @param {Object} [options] - Review options
 * @param {boolean} [options.force] - Force re-review even if already reviewed
 * @returns {Promise<Object>} ReviewResult with metadata
 */
async function reviewChangeset(projectPath, changesetId, options = {}) {
  const externalSignal = options?.externalSignal || null;
  const onHeartbeat = typeof options?.onHeartbeat === 'function' ? options.onHeartbeat : null;
  const emitHeartbeat = (stage = 'running') => {
    if (!onHeartbeat) return;
    onHeartbeat({
      stage,
      reviewType: 'changeset',
      reviewId: changesetId,
      ts: Date.now(),
    });
  };

  // Log free tier usage (display-only — enforcement deferred until payments are wired up)
  // const limitReached = await usageService.isLimitReached();
  // if (limitReached) {
  //   throw new Error('Monthly review limit reached (20/20). Upgrade to continue using AI reviews.');
  // }

  // Get review-specific provider preference, then build failover chain
  const reviewCtx = typeof providerService.getContextActiveProvider === 'function'
    ? await providerService.getContextActiveProvider('review')
    : null;
  const providerCandidates = typeof providerService.getReviewProviderCandidatesWithKeys === 'function'
    ? await providerService.getReviewProviderCandidatesWithKeys({
        maxCandidates: REVIEW_PROVIDER_FAILOVER_MAX_CANDIDATES,
        preferredProviderId: reviewCtx?.providerId || null,
      })
    : [];
  const fallbackActiveProvider = providerCandidates.length === 0
    ? await providerService.getActiveProviderWithKey()
    : null;
  if (fallbackActiveProvider) {
    providerCandidates.push(fallbackActiveProvider);
  }
  const providerData = providerCandidates[0] || null;
  if (!providerData) {
    throw new Error('No active AI provider configured. Add an API key in Settings → AI Provider.');
  }
  const policySource = normalizeReviewPolicySource(options.policySource, 'trusted');
  const unavailableModels = new Set();
  const modelsUsed = {};
  const markModelUsed = (phase, model) => {
    if (!REVIEW_MODEL_PHASES.includes(phase)) return;
    if (typeof model !== 'string' || !model.trim()) return;
    modelsUsed[phase] = model.trim();
  };
  let selectedProviderData = providerData;
  const providerFailoverState = createProviderFailoverState(providerCandidates);

  // Load changeset
  const changeset = await changesetService.getChangeSet(projectPath, changesetId);
  if (!changeset) {
    throw new Error('Changeset not found');
  }

  // Check if already reviewed (unless force)
  if (changeset.reviewStatus === 'reviewed' && !options.force) {
    return changeset.reviewData;
  }

  // Update status to reviewing
  await updateChangeSetReview(projectPath, changesetId, {
    reviewStatus: 'reviewing',
    reviewError: null,
  });
  const reviewTiming = createReviewTiming('changeset', changesetId);
  reviewTiming.providerMode = resolveProviderExecutionMode(providerData, { reviewExecutionMode: null });
  setProviderCandidates(
    reviewTiming,
    providerFailoverState.candidates,
    (candidate) => resolveProviderExecutionMode(candidate, { reviewExecutionMode: null })
  );
  const deadline = createReviewDeadline(externalSignal);
  const heartbeatInterval = onHeartbeat
    ? setInterval(() => emitHeartbeat('running'), REVIEW_PROVIDER_HEARTBEAT_MS)
    : null;
  if (typeof heartbeatInterval?.unref === 'function') heartbeatInterval.unref();

  try {
    emitHeartbeat('starting');
    const filePrepStartedAt = Date.now();
    const reviewModelConfig = resolveReviewModelConfigOverride(
      await loadReviewSettingOrThrow(
        () => getGlobalReviewModelConfig(),
        'Changeset review'
      ),
      {
        reviewModelStrategy: options.reviewModelStrategy,
        reviewModelCustom: options.reviewModelCustom,
        reviewModelAdaptive: options.reviewModelAdaptive,
        reviewModelRollout: options.reviewModelRollout,
      }
    );
    const globalIgnorePatterns = await loadReviewSettingOrThrow(
      () => getGlobalReviewIgnorePatterns(),
      'Changeset review'
    );
    const executionModeOrder = await loadReviewSettingOrThrow(
      () => getExecutionModeOrder(),
      'Changeset review'
    );

    if (!changeset.files || changeset.files.length === 0) {
      if (changeset.commitSha) {
        // For git-watcher changesets that only have commit SHA
        // TODO: generate diff from git log
        throw new Error('Cannot review changeset without file contents');
      }
      throw new Error('Changeset has no files to review');
    }

    const scopedFiles = globalIgnorePatterns.length > 0
      ? changeset.files.filter((file) => !matchesAnyPattern(file.path, globalIgnorePatterns))
      : changeset.files;
    if (scopedFiles.length === 0) {
      throw new Error('No reviewable files matched review ignore patterns. Adjust Review Settings → Ignore Patterns and retry.');
    }

    const preparedFiles = [];
    let skippedCount = 0;
    for (const file of scopedFiles) {
      if (isLockFile(file.path)) {
        skippedCount++;
        continue;
      }

      const before = typeof file.before === 'string' ? file.before : null;
      const after = typeof file.after === 'string' ? file.after : null;
      if ((before && before.includes('\0')) || (after && after.includes('\0'))) {
        skippedCount++;
        continue;
      }

      preparedFiles.push({
        ...file,
        before,
        after,
        status: file.after === null ? 'D' : file.before === null ? 'A' : 'M',
      });
    }

    if (preparedFiles.length === 0) {
      throw new Error('Changeset has no reviewable files after applying ignore/lock/binary filters.');
    }

    const focusedDecisionContext = buildRoutingDecisionContext({
      files: preparedFiles,
      riskFlags: changeset.riskFlags || {},
      diffChars: estimateDiffCharsForFiles(preparedFiles),
      fallbackFileCount: preparedFiles.length,
      focusedReview: false,
      projectId: changeset.projectId || null,
      projectPath,
      reviewType: 'changeset',
      reviewId: changesetId,
    });
    const focusedReviewResolution = resolveEffectiveReviewModel(
      providerData,
      'review',
      reviewModelConfig,
      focusedDecisionContext
    );
    const focusedBudget = deriveFocusedReviewBudgetConfig({
      files: preparedFiles,
      providerData,
      reviewResolution: focusedReviewResolution,
      deadline,
    });
    const focusedSelection = selectFilesForFocusedReview(preparedFiles, focusedBudget);
    const reviewFiles = focusedSelection.reviewFiles;
    const omittedFiles = focusedSelection.omittedFiles;
    const isFocusedReview = focusedSelection.mode === 'focused';
    const focusedCoveragePlanner = focusedSelection.planner || focusedBudget.planner || null;
    const qualityMode = resolveReviewQualityMode(options.qualityMode);
    reviewTiming.filePrepMs += Date.now() - filePrepStartedAt;
    const omittedPromptFiles = isFocusedReview
      ? summarizeOmittedFilesForPrompt(omittedFiles, REVIEW_OMITTED_FILE_PROMPT_LIMIT, { reviewProfile })
      : [];
    const promptContextSignals = await collectPromptContextSignals(projectPath, {
      commitMessages: changeset.commitMessage ? [changeset.commitMessage] : [],
      queuedCommitShas: changeset.commitSha ? [changeset.commitSha] : [],
      verificationStatus: changeset.verification || null,
      contextFiles: reviewFiles,
      cacheProjectId: changeset.projectId || null,
      reviewProfile: reviewProfile || null,
      sameHashOnly: REVIEW_PROMPT_CONTEXT_SAME_HASH_ONLY,
      allowGuardedCrossHashHints: REVIEW_PROMPT_CONTEXT_ALLOW_CROSS_HASH_HINTS,
    });

    // ── Linter pre-pass (changeset) ──────────────────────────────────────
    const changesetDiffForLinter = generateDiffFromFiles(reviewFiles);
    const linterPrePass = await runReviewLinterPrePass(projectPath, reviewFiles, changesetDiffForLinter, {
      reviewPolicy: null, // changesets do not have review policy in scope
      reviewProfile: reviewProfile || null,
      externalSignal: externalSignal || null,
    });
    await writeReviewDebugJson({
      projectId: changeset.projectId || null,
      projectPath,
      reviewType: 'changeset',
      reviewId: changesetId,
    }, 'linter-prepass', linterPrePass);
    // ─────────────────────────────────────────────────────────────────────

    const metadataBase = {
      title: changeset.title,
      commitMessages: promptContextSignals.commitMessages,
      verificationStatus: promptContextSignals.verificationStatus,
      priorFindingHints: promptContextSignals.priorFindingHints,
      fileRiskContext: promptContextSignals.fileRiskContext,
      claudeConventions: promptContextSignals.claudeConventions,
      projectMetadata: promptContextSignals.projectMetadata,
      dismissedPatterns: promptContextSignals.dismissedPatterns,
      additionalPromptContextBlocks: promptContextSignals.additionalBlocks,
      linterFindings: getPromptLinterFindings(linterPrePass),
      queuedCommitShas: promptContextSignals.queuedCommitShas,
      promptContextBudgetChars: REVIEW_PROMPT_CONTEXT_BUDGET_CHARS,
      promptContextSameHashOnly: REVIEW_PROMPT_CONTEXT_SAME_HASH_ONLY,
      promptContextAllowCrossHashHints: REVIEW_PROMPT_CONTEXT_ALLOW_CROSS_HASH_HINTS,
      evidencePolicy: normalizeEvidencePolicyForReview(options.evidencePolicy),
      riskFlags: changeset.riskFlags,
      fileCount: reviewFiles.length,
      filePaths: reviewFiles.map((file) => file.path),
      omittedFilesCount: omittedFiles.length,
      omittedFiles: omittedPromptFiles,
      totalAdditions: changeset.riskFlags?.totalAdditions ?? null,
      totalDeletions: changeset.riskFlags?.totalDeletions ?? null,
      qualityMode,
    };

    const runSingleReview = async (diffText, metadata, callContext = {}) => {
      emitHeartbeat('provider_call');
      const modelDecisionContext = buildRoutingDecisionContext({
        files: Array.isArray(metadata?.filePaths)
          ? metadata.filePaths.map((path) => ({ path }))
          : [],
        riskFlags: metadata?.riskFlags || changeset.riskFlags || {},
        riskLevel: null,
        diffChars: diffText.length,
        fallbackFileCount: metadata?.fileCount ?? reviewFiles.length,
        focusedReview: isFocusedReview,
        projectId: changeset.projectId || null,
        projectPath,
        reviewType: 'changeset',
        reviewId: changesetId,
      });
      modelDecisionContext._executionModeOrder = executionModeOrder;
      const promptBuildStartedAt = Date.now();
      const promptDiff = prepareDiffForPrompt(diffText, resolvePromptHardLimit(providerData));
      const { prompt, promptContextTelemetry } = buildReviewPrompt(promptDiff, metadata);
      const promptArtifactName = callContext?.scope === 'chunk' && callContext?.chunkIndex
        ? `prompt-standard-chunk-${callContext.chunkIndex}`
        : callContext?.scope === 'file' && Array.isArray(metadata?.filePaths) && metadata.filePaths[0]
          ? `prompt-standard-file-${normalizePathForMatch(metadata.filePaths[0]).replace(/\//g, '__')}`
          : 'prompt-standard';
      await writeReviewDebugText({
        projectId: changeset.projectId || null,
        projectPath,
        reviewType: 'changeset',
        reviewId: changesetId,
      }, promptArtifactName, prompt);
      const promptBuildMs = Date.now() - promptBuildStartedAt;
      const providerStartedAt = Date.now();
      const result = await callProviderForReviewWithFailover(providerFailoverState, prompt, {
        deadline,
        modelPhase: 'review',
        reviewModelConfig,
        unavailableModels,
        modelDecisionContext,
        onRetry: (retryMeta) => {
          recordProviderRetry(reviewTiming, retryMeta);
          emitHeartbeat('provider_retry');
        },
        reviewTiming,
      });
      if (result?.providerData) {
        selectedProviderData = result.providerData;
      }
      markModelUsed('review', result?.modelUsed);
      const resolvedProviderData = result?.providerData || selectedProviderData;
      const effectiveReviewResolution = resolveEffectiveReviewModel(
        resolvedProviderData,
        'review',
        reviewModelConfig,
        modelDecisionContext
      );
      const providerMs = Date.now() - providerStartedAt;
      recordProviderTiming(reviewTiming, {
        ...callContext,
        fileCount: metadata.fileCount,
        diffChars: diffText.length,
        promptChars: prompt.length,
        promptBuildMs,
        providerMs,
      });
      const parsedReview = parseReviewResponseWithVisibility(result.text, {
        diffText,
        filePaths: metadata.filePaths,
        fileCount: metadata.fileCount,
        totalAdditions: metadata.totalAdditions,
        totalDeletions: metadata.totalDeletions,
        qualityMode: metadata.qualityMode || qualityMode,
        reviewPolicy: metadata.reviewPolicy || null,
      }, {
        reviewType: 'changeset',
        reviewId: changesetId,
        stage: 'standard_review',
      });
      applyPromptContextTelemetryToReviewStats(parsedReview, promptContextTelemetry);
      const evidenceReview = applyEvidencePolicyToReview(parsedReview, {
        diffText,
        filePaths: metadata.filePaths,
        policy: metadata.evidencePolicy,
      });
      if (!evidenceReview.review.stats || typeof evidenceReview.review.stats !== 'object') {
        evidenceReview.review.stats = {};
      }
      evidenceReview.review.stats.evidencePolicy = evidenceReview.policy;
      return {
        review: evidenceReview.review,
        tokensUsed: result.tokensUsed || { input: 0, output: 0 },
        provider: {
          providerType: normalizeProviderIdentity(resolvedProviderData).providerType,
          providerModel: result?.modelUsed
            || normalizeProviderIdentity(resolvedProviderData).providerModel,
          effectiveStrategy: effectiveReviewResolution.effectiveStrategy,
        },
      };
    };

    const chunkTargetChars = resolveChunkCharLimit(providerData);
    const runChunkedReview = async () => {
      const chunks = chunkFilesForReview(reviewFiles, chunkTargetChars, REVIEW_MAX_CHUNKS);
      const totalChunkFiles = reviewFiles.length;
      const createChunkRunState = () => ({
        chunkReviews: [],
        filesCompleted: 0,
        cancelled: false,
      });

      const runChunkWithFallback = async (chunkFiles, {
        chunkIndex,
        totalChunks,
        splitDepth = 0,
        splitOrdinal = '',
      }, chunkState) => {
        if (chunkState.cancelled) return;
        emitHeartbeat('chunk');
        deadline.check();
        const chunkDiffStartedAt = Date.now();
        const chunkDiff = generateDiffFromFiles(chunkFiles);
        const chunkDiffMs = Date.now() - chunkDiffStartedAt;
        reviewTiming.diffBuildMs += chunkDiffMs;
        const splitLabel = splitOrdinal ? `.${splitOrdinal}` : '';
        const chunkMeta = {
          ...metadataBase,
          title: `${metadataBase.title} (chunk ${chunkIndex}/${totalChunks}${splitLabel})`,
          fileCount: chunkFiles.length,
          filePaths: chunkFiles.map((file) => file.path),
        };

        try {
          const reviewedChunk = await runSingleReview(chunkDiff, chunkMeta, {
            scope: 'chunk',
            chunkIndex,
            totalChunks,
            splitOrdinal: splitLabel || null,
            fileCount: chunkFiles.length,
            diffBuildMs: chunkDiffMs,
          });
          if (chunkState.cancelled) return;
          chunkState.chunkReviews.push(reviewedChunk);
          chunkState.filesCompleted += chunkFiles.length;
          recordFirstSignal(reviewTiming, {
            scope: 'chunk',
            chunkIndex,
            totalChunks,
            filesCompleted: chunkState.filesCompleted,
            totalFiles: totalChunkFiles,
          });
        } catch (error) {
          if (error.isDeadline) {
            chunkState.cancelled = true;
            throw error;
          }
          if (chunkState.cancelled) return;
          const canSplitFurther =
            isLikelyTimeoutOrContextError(error) &&
            chunkFiles.length > 1 &&
            splitDepth < REVIEW_CHUNK_SPLIT_MAX_DEPTH;
          if (!canSplitFurther) {
            chunkState.cancelled = true;
            throw error;
          }

          const midpoint = Math.ceil(chunkFiles.length / 2);
          const left = chunkFiles.slice(0, midpoint);
          const right = chunkFiles.slice(midpoint);

          await runChunkWithFallback(left, {
            chunkIndex,
            totalChunks,
            splitDepth: splitDepth + 1,
            splitOrdinal: `${splitOrdinal}a`,
          }, chunkState);
          await runChunkWithFallback(right, {
            chunkIndex,
            totalChunks,
            splitDepth: splitDepth + 1,
            splitOrdinal: `${splitOrdinal}b`,
          }, chunkState);
        }
      };

      const runChunksWithConcurrency = async (concurrency, chunkState) => {
        if (concurrency <= 1 || chunks.length <= 1) {
          for (let i = 0; i < chunks.length; i++) {
            if (chunkState.cancelled) return;
            await runChunkWithFallback(chunks[i], {
              chunkIndex: i + 1,
              totalChunks: chunks.length,
            }, chunkState);
          }
          return;
        }

        await mapWithConcurrency(
          chunks.map((chunkFiles, index) => ({ chunkFiles, index })),
          concurrency,
          async ({ chunkFiles, index }) => {
            if (chunkState.cancelled) return;
            emitHeartbeat('chunk_queue');
            await runChunkWithFallback(chunkFiles, {
              chunkIndex: index + 1,
              totalChunks: chunks.length,
            }, chunkState);
          }
        );
      };

      const configuredConcurrency = resolveBoundedSchedulerConcurrency({
        path: 'chunk',
        totalUnits: chunks.length,
        providerData,
        budgetClass: focusedReviewResolution?.budgetClass || 'balanced',
        deadline,
        baseline: resolveChunkConcurrency(providerData, chunks.length),
        maxConcurrency: REVIEW_CHUNK_CONCURRENCY_DYNAMIC_MAX,
      });
      let chunkFailure = null;
      let activeChunkState = createChunkRunState();
      try {
        await runChunksWithConcurrency(configuredConcurrency, activeChunkState);
      } catch (error) {
        activeChunkState.cancelled = true;
        const canFallbackToSerial =
          !error.isDeadline &&
          configuredConcurrency > 1 &&
          activeChunkState.chunkReviews.length === 0 &&
          (isLikelyTimeoutOrContextError(error) || isLikelyRateLimitError(error));
        if (!canFallbackToSerial) {
          chunkFailure = error;
        } else {
          console.warn(
            `[ReviewService] CS ${changesetId} parallel chunking failed (${error.message}); retrying serially`
          );
          const serialChunkState = createChunkRunState();
          activeChunkState = serialChunkState;
          try {
            await runChunksWithConcurrency(1, serialChunkState);
          } catch (serialError) {
            serialChunkState.cancelled = true;
            chunkFailure = serialError;
          }
        }
      }

      const finalChunkReviews = activeChunkState.chunkReviews;
      const aggregated = aggregateChunkReviews(finalChunkReviews, {
        fallbackSummary: `Reviewed ${reviewFiles.length} files using chunked analysis.`,
        fileCount: changeset.riskFlags?.fileCount ?? reviewFiles.length,
        totalFileCount: preparedFiles.length,
        focusedFileCount: reviewFiles.length,
        omittedFileCount: omittedFiles.length,
        filePaths: reviewFiles.map((file) => file.path),
        totalAdditions: changeset.riskFlags?.totalAdditions ?? 0,
        totalDeletions: changeset.riskFlags?.totalDeletions ?? 0,
      });

      if (chunkFailure) {
        if (finalChunkReviews.length === 0) {
          if (chunkFailure?.isDeadline) {
            return buildDeadlinePartialAggregate({
              fallbackSummary: `Review deadline reached before chunk analysis completed for ${reviewFiles.length} files.`,
              fileCount: changeset.riskFlags?.fileCount ?? reviewFiles.length,
              totalFileCount: preparedFiles.length,
              focusedFileCount: reviewFiles.length,
              omittedFileCount: omittedFiles.length,
              filePaths: reviewFiles.map((file) => file.path),
              totalAdditions: changeset.riskFlags?.totalAdditions ?? 0,
              totalDeletions: changeset.riskFlags?.totalDeletions ?? 0,
              totalChunks: chunks.length,
              errorMessage: chunkFailure?.message || 'Review deadline exceeded',
              errorClass: classifyProviderError(chunkFailure),
            });
          }
          throw chunkFailure;
        }
        annotatePartialReview(aggregated, {
          completedChunks: finalChunkReviews.length,
          totalChunks: chunks.length,
          errorMessage: chunkFailure?.message || 'Chunk review failed',
          errorClass: classifyProviderError(chunkFailure),
        });
      }

      return aggregated;
    };

    const runPerFileReview = async () => {
      const triaged = reviewFiles.map((file) => ({
        file,
        className: classifyFileForPerFileReview(file),
      }));
      const deepReviewEntries = triaged.filter((entry) => entry.className === 'standard' || entry.className === 'large');
      const triageOmittedCount = Math.max(0, triaged.length - deepReviewEntries.length);
      const triageOmittedPaths = triaged
        .filter((entry) => entry.className !== 'standard' && entry.className !== 'large')
        .map((entry) => String(entry?.file?.path || '').trim())
        .filter(Boolean);
      const totalDeepFiles = deepReviewEntries.length;
      const cacheProjectId = changeset.projectId || null;
      const cacheEnabledForRun = REVIEW_FILE_CACHE_ENABLED && !!cacheProjectId;

      const aggregateArgs = {
        fallbackSummary: `Reviewed ${totalDeepFiles}/${reviewFiles.length} files using per-file analysis.`,
        fileCount: changeset.riskFlags?.fileCount ?? reviewFiles.length,
        totalFileCount: preparedFiles.length,
        focusedFileCount: totalDeepFiles,
        omittedFileCount: omittedFiles.length + triageOmittedCount,
        filePaths: reviewFiles.map((file) => file.path),
        totalAdditions: changeset.riskFlags?.totalAdditions ?? 0,
        totalDeletions: changeset.riskFlags?.totalDeletions ?? 0,
        reviewPolicy: metadataBase.reviewPolicy || null,
      };

      if (totalDeepFiles === 0) {
        const emptyAggregate = aggregateChunkReviews([], aggregateArgs);
        emptyAggregate.review.summary = `${emptyAggregate.review.summary} (All ${reviewFiles.length} files were triaged as trivial/skip in this run.)`;
        emptyAggregate.review.stats.perFileMode = true;
        emptyAggregate.review.stats.filesDeepReviewed = 0;
        emptyAggregate.review.stats.filesTotal = preparedFiles.length;
        emptyAggregate.review.stats.omittedFiles = omittedFiles.length + triageOmittedCount;
        emptyAggregate.review.stats.perFileFailedFiles = 0;
        emptyAggregate.review.stats.perFileFailedPaths = [];
        emptyAggregate.review.stats.perFileCacheHits = 0;
        emptyAggregate.review.stats.perFileCacheMisses = 0;
        emptyAggregate.review.stats.perFileTriageOmittedPaths = triageOmittedPaths;
        return emptyAggregate;
      }

      const cacheCandidateProviders = getProviderCandidatesInPreferredOrder(
        providerFailoverState,
        selectedProviderData || providerData
      );
      const deepEntriesWithCache = deepReviewEntries.map((entry, index) => {
        const seen = new Set();
        const cacheCandidates = [];
        for (const candidate of cacheCandidateProviders) {
          const identity = normalizeProviderIdentity(candidate);
          const modelDecisionContext = buildRoutingDecisionContext({
            files: [entry.file],
            riskFlags: changeset.riskFlags || {},
            fallbackFileCount: 1,
            focusedReview: isFocusedReview,
            projectId: changeset.projectId || null,
            projectPath,
            reviewType: 'changeset',
            reviewId: changesetId,
          });
          modelDecisionContext._executionModeOrder = executionModeOrder;
          const modelResolution = resolveEffectiveReviewModel(
            candidate,
            'review',
            reviewModelConfig,
            modelDecisionContext
          );
          const descriptor = buildReviewFileCacheDescriptor({
            contextType: 'changeset',
            file: entry.file,
            providerType: identity.providerType,
            providerModel: modelResolution.model || identity.providerModel,
            effectiveStrategy: modelResolution.effectiveStrategy,
            qualityMode,
          });
          if (seen.has(descriptor.cacheKey)) continue;
          seen.add(descriptor.cacheKey);
          cacheCandidates.push(descriptor);
        }
        if (cacheCandidates.length === 0) {
          const identity = normalizeProviderIdentity(selectedProviderData || providerData);
          const modelDecisionContext = buildRoutingDecisionContext({
            files: [entry.file],
            riskFlags: changeset.riskFlags || {},
            fallbackFileCount: 1,
            focusedReview: isFocusedReview,
            projectId: changeset.projectId || null,
            projectPath,
            reviewType: 'changeset',
            reviewId: changesetId,
          });
          modelDecisionContext._executionModeOrder = executionModeOrder;
          const modelResolution = resolveEffectiveReviewModel(
            selectedProviderData || providerData,
            'review',
            reviewModelConfig,
            modelDecisionContext
          );
          cacheCandidates.push(buildReviewFileCacheDescriptor({
            contextType: 'changeset',
            file: entry.file,
            providerType: identity.providerType,
            providerModel: modelResolution.model || identity.providerModel,
            effectiveStrategy: modelResolution.effectiveStrategy,
            qualityMode,
          }));
        }
        return { ...entry, index, cacheCandidates };
      });

      const cacheRowsByKey = new Map();
      if (cacheEnabledForRun) {
        const cacheKeys = Array.from(
          new Set(deepEntriesWithCache.flatMap((entry) => entry.cacheCandidates.map((candidate) => candidate.cacheKey)))
        );
        if (cacheKeys.length > 0) {
          try {
            const cacheRows = await branchReviewService.getReviewFileCacheByKeys(cacheProjectId, cacheKeys);
            for (const row of cacheRows) {
              if (!row?.cacheKey || !isValidCachedPerFileReview(row.review)) continue;
              cacheRowsByKey.set(row.cacheKey, row);
            }
            if (cacheRowsByKey.size > 0) {
              await branchReviewService.touchReviewFileCacheByKeys(cacheProjectId, Array.from(cacheRowsByKey.keys()));
            }
          } catch (error) {
            console.warn(`[ReviewService] Failed to read per-file cache for CS ${changesetId}:`, error.message);
          }
        }
      }

      let perFileCacheHits = 0;
      const entriesToReview = [];
      const perFileResults = new Array(totalDeepFiles).fill(null);
      for (const entry of deepEntriesWithCache) {
        const cacheHit = entry.cacheCandidates.find((candidate) => cacheRowsByKey.has(candidate.cacheKey));
        if (cacheHit) {
          const cached = cacheRowsByKey.get(cacheHit.cacheKey);
          perFileResults[entry.index] = {
            review: cached.review,
            tokensUsed: { input: 0, output: 0 },
            provider: {
              providerType: cached.providerType || 'unknown',
              providerModel: cached.providerModel || 'unknown',
              effectiveStrategy: cached.effectiveStrategy || cacheHit.effectiveStrategy || 'unknown',
            },
          };
          perFileCacheHits += 1;
        } else {
          entriesToReview.push(entry);
        }
      }
      const perFileCacheMisses = entriesToReview.length;
      let completedDeepFiles = perFileCacheHits;
      if (perFileCacheHits > 0) {
        recordFirstSignal(reviewTiming, {
          scope: 'per_file_cache',
          chunkIndex: 1,
          totalChunks: totalDeepFiles,
          filesCompleted: completedDeepFiles,
          totalFiles: totalDeepFiles,
        });
      }

      const failedFileEntries = [];
      const cacheWriteEntries = [];
      if (entriesToReview.length > 0) {
        const perFileConcurrency = resolveBoundedSchedulerConcurrency({
          path: 'per_file',
          totalUnits: entriesToReview.length,
          providerData,
          budgetClass: focusedReviewResolution?.budgetClass || 'balanced',
          deadline,
          baseline: REVIEW_PER_FILE_CONCURRENCY,
          maxConcurrency: REVIEW_PER_FILE_CONCURRENCY_MAX,
        });
        await mapWithConcurrency(
          entriesToReview,
          perFileConcurrency,
          async ({ file, index }) => {
            emitHeartbeat('file_review');
            deadline.check(REVIEW_DEADLINE_START_BUFFER_MS, `review file ${file.path}`);
            const fileDiffStartedAt = Date.now();
            const fileDiff = generateDiffFromFiles([file]);
            const fileDiffMs = Date.now() - fileDiffStartedAt;
            reviewTiming.diffBuildMs += fileDiffMs;
            const fileMetadata = {
              ...metadataBase,
              title: `${metadataBase.title} (${file.path})`,
              fileCount: 1,
              filePaths: [file.path],
              omittedFilesCount: 0,
              omittedFiles: [],
            };
            try {
              const reviewedFile = await runSingleReview(fileDiff, fileMetadata, {
                scope: 'file',
                chunkIndex: index + 1,
                totalChunks: totalDeepFiles,
                fileCount: 1,
                diffBuildMs: fileDiffMs,
              });
              perFileResults[index] = reviewedFile;
              completedDeepFiles += 1;
              recordFirstSignal(reviewTiming, {
                scope: 'per_file',
                chunkIndex: index + 1,
                totalChunks: totalDeepFiles,
                filesCompleted: completedDeepFiles,
                totalFiles: totalDeepFiles,
              });
              if (cacheEnabledForRun && reviewedFile?.review) {
                const descriptor = buildReviewFileCacheDescriptor({
                  contextType: 'changeset',
                  file,
                  providerType: reviewedFile.provider?.providerType,
                  providerModel: reviewedFile.provider?.providerModel,
                  effectiveStrategy: reviewedFile.provider?.effectiveStrategy,
                  qualityMode,
                });
                cacheWriteEntries.push({
                  ...descriptor,
                  review: reviewedFile.review,
                });
              }
            } catch (error) {
              completedDeepFiles += 1;
              failedFileEntries.push({
                path: file.path,
                message: error?.message || 'Review failed',
                deadline: !!error?.isDeadline,
                errorClass: classifyProviderError(error),
              });
            }
          }
        );
      }

      if (cacheEnabledForRun && cacheWriteEntries.length > 0) {
        try {
          await branchReviewService.upsertReviewFileCacheEntries(cacheProjectId, cacheWriteEntries);
        } catch (error) {
          console.warn(`[ReviewService] Failed to write per-file cache for CS ${changesetId}:`, error.message);
        }
      }

      const perFileReviews = perFileResults.filter(Boolean);

      const aggregated = aggregateChunkReviews(perFileReviews, aggregateArgs);
      aggregated.review.stats.perFileMode = true;
      aggregated.review.stats.perFileFailedFiles = failedFileEntries.length;
      aggregated.review.stats.perFileFailedPaths = failedFileEntries.map((entry) => entry.path);
      aggregated.review.stats.perFileCacheHits = perFileCacheHits;
      aggregated.review.stats.perFileCacheMisses = perFileCacheMisses;
      aggregated.review.stats.perFileTriageOmittedPaths = triageOmittedPaths;
      aggregated.review.stats.filesDeepReviewed = Math.max(0, totalDeepFiles - failedFileEntries.length);

      if (failedFileEntries.length > 0) {
        const firstFailures = failedFileEntries.slice(0, 3).map((entry) => entry.path).join(', ');
        const suffix = failedFileEntries.length > 3 ? ` +${failedFileEntries.length - 3} more` : '';
        const primaryFailureClass = failedFileEntries.find((entry) => entry.errorClass && entry.errorClass !== 'unknown')?.errorClass || null;
        annotatePartialReview(aggregated, {
          completedChunks: perFileReviews.length,
          totalChunks: totalDeepFiles,
          errorMessage: `Per-file review failed for ${failedFileEntries.length}/${totalDeepFiles} file(s): ${firstFailures}${suffix}`,
          errorClass: primaryFailureClass,
        });
      }

      return aggregated;
    };

    const usePerFilePath = shouldUsePerFileReviewPath(providerData, reviewFiles.length);
    let reviewResult;
    let tokenUsage;

    if (usePerFilePath) {
      reviewTiming.strategy = 'per_file';
      const perFile = await runPerFileReview();
      reviewResult = perFile.review;
      tokenUsage = perFile.tokensUsed;
    } else {
      const fullDiffStartedAt = Date.now();
      const fullDiff = generateDiffFromFiles(reviewFiles);
      const fullDiffMs = Date.now() - fullDiffStartedAt;
      reviewTiming.diffBuildMs += fullDiffMs;
      const shouldUseChunkedPath = shouldUseChunkedReviewPath(
        providerData,
        fullDiff.length,
        reviewFiles.length
      );

      if (shouldUseChunkedPath) {
        reviewTiming.strategy = 'chunked';
        const chunked = await runChunkedReview();
        reviewResult = chunked.review;
        tokenUsage = chunked.tokensUsed;
      } else {
        reviewTiming.strategy = 'single';
        try {
          const single = await runSingleReview(fullDiff, metadataBase, {
            scope: 'single',
            chunkIndex: 1,
            totalChunks: 1,
            fileCount: reviewFiles.length,
            diffBuildMs: fullDiffMs,
          });
          reviewResult = single.review;
          tokenUsage = single.tokensUsed;
          recordFirstSignal(reviewTiming, {
            scope: 'single',
            chunkIndex: 1,
            totalChunks: 1,
            filesCompleted: reviewFiles.length,
            totalFiles: reviewFiles.length,
          });
        } catch (error) {
          if (error?.isDeadline) {
            const partial = buildDeadlinePartialAggregate({
              fallbackSummary: `Review deadline reached before single-pass analysis completed for ${reviewFiles.length} files.`,
              fileCount: changeset.riskFlags?.fileCount ?? reviewFiles.length,
              totalFileCount: preparedFiles.length,
              focusedFileCount: reviewFiles.length,
              omittedFileCount: omittedFiles.length,
              filePaths: reviewFiles.map((file) => file.path),
              totalAdditions: changeset.riskFlags?.totalAdditions ?? 0,
              totalDeletions: changeset.riskFlags?.totalDeletions ?? 0,
              totalChunks: 1,
              errorMessage: error?.message || 'Review deadline exceeded',
              errorClass: classifyProviderError(error),
            });
            reviewResult = partial.review;
            tokenUsage = partial.tokensUsed;
          } else {
            if (!isLikelyTimeoutOrContextError(error) || reviewFiles.length <= 1) {
              throw error;
            }
            deadline.check();
            reviewTiming.strategy = 'single_fallback_chunked';
            console.warn(
              `[ReviewService] CS ${changesetId} single-shot review failed (${error.message}); retrying with chunked strategy`
            );
            const chunked = await runChunkedReview();
            reviewResult = chunked.review;
            tokenUsage = chunked.tokensUsed;
          }
        }
      }
    }

    if (isFocusedReview) {
      const requiresFocusedSummary = reviewResult?.stats?.reviewMode !== 'focused';
      if (requiresFocusedSummary) {
        reviewResult.summary = synthesizeLargeReviewSummary({
          chunkCount: reviewResult.stats?.chunkCount || 1,
          summaryText: reviewResult.summary,
          focusedFiles: reviewFiles.length,
          totalFiles: preparedFiles.length,
          omittedFiles: omittedFiles.length,
          recommendations: reviewResult.recommendations || [],
        });
      }
    }

    if (!reviewResult.stats || typeof reviewResult.stats !== 'object') {
      reviewResult.stats = {
        filesAnalyzed: reviewFiles.length,
        totalAdditions: changeset.riskFlags?.totalAdditions ?? 0,
        totalDeletions: changeset.riskFlags?.totalDeletions ?? 0,
        estimatedComplexity: 'moderate',
      };
    }
    const totalChangedFiles = preparedFiles.length;
    const deepReviewedFiles = Math.max(
      0,
      Math.min(
        totalChangedFiles,
        Number(reviewResult.stats.filesDeepReviewed ?? reviewFiles.length) || 0
      )
    );
    const triageOmittedPaths = Array.isArray(reviewResult.stats.perFileTriageOmittedPaths)
      ? reviewResult.stats.perFileTriageOmittedPaths
      : [];
    const failedPaths = Array.isArray(reviewResult.stats.perFileFailedPaths)
      ? reviewResult.stats.perFileFailedPaths
      : [];
    const omissionReasons = buildOmissionReasonMap({
      focusedOmittedFiles: omittedFiles,
      triageOmittedPaths,
      failedPaths,
    });
    const derivedOmittedFiles = Math.max(0, totalChangedFiles - deepReviewedFiles);
    const declaredOmittedFiles = Math.max(0, Number(reviewResult.stats.omittedFiles || 0));
    reviewResult.stats.reviewMode = isFocusedReview ? 'focused' : 'full';
    reviewResult.stats.filesDeepReviewed = deepReviewedFiles;
    reviewResult.stats.deepReviewedFiles = deepReviewedFiles;
    reviewResult.stats.filesTotal = totalChangedFiles;
    reviewResult.stats.totalChangedFiles = totalChangedFiles;
    reviewResult.stats.omittedFiles = Math.max(declaredOmittedFiles, derivedOmittedFiles);
    reviewResult.stats.omissionReasons = omissionReasons;
    reviewResult.stats.chunkCount = reviewResult.stats.chunkCount || 1;
    if (focusedCoveragePlanner) {
      reviewResult.stats.coveragePlanner = focusedCoveragePlanner;
    }
    if (!tokenUsage || typeof tokenUsage !== 'object') {
      tokenUsage = { input: 0, output: 0 };
    }
    let verifierPromptDiff = null;
    const resolveVerifierPromptDiff = () => {
      if (typeof verifierPromptDiff === 'string') return verifierPromptDiff;
      const rawVerifierDiff = generateDiffFromFiles(reviewFiles);
      verifierPromptDiff = prepareDiffForPrompt(rawVerifierDiff, REVIEW_TWO_PASS_VERIFIER_DIFF_HARD_LIMIT);
      return verifierPromptDiff;
    };
    reviewResult = await runBoundedHighRiskVerifierPass(reviewResult, {
      enabled: REVIEW_TWO_PASS_VERIFIER_ENABLED,
      maxFindings: REVIEW_TWO_PASS_VERIFIER_MAX_FINDINGS,
      includeMedium: REVIEW_TWO_PASS_VERIFIER_INCLUDE_MEDIUM,
      maxMediumFindings: REVIEW_TWO_PASS_VERIFIER_MAX_MEDIUM_FINDINGS,
      mediumGate: {
        maxFirstSignalMs: REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_FIRST_SIGNAL_MS,
        maxDurationMs: REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_DURATION_MS,
        maxOmittedRate: REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_OMITTED_RATE,
        minDeepReviewedFiles: REVIEW_TWO_PASS_VERIFIER_MEDIUM_MIN_DEEP_REVIEWED_FILES,
      },
      unsupportedPolicy: REVIEW_TWO_PASS_VERIFIER_UNSUPPORTED_POLICY,
      verifyRecommendation: REVIEW_TWO_PASS_VERIFIER_ENABLED
        ? async (recommendation, verifierMeta = {}) => {
            emitHeartbeat('provider_call');
            deadline.check(REVIEW_DEADLINE_START_BUFFER_MS, 'verifier pass');
            const verifierDiff = resolveVerifierPromptDiff();
            const verifierPrompt = buildHighRiskVerifierPrompt(verifierDiff, recommendation, {
              title: metadataBase.title,
              fileCount: reviewFiles.length,
              totalAdditions: changeset.riskFlags?.totalAdditions ?? 0,
              totalDeletions: changeset.riskFlags?.totalDeletions ?? 0,
            });
            const modelDecisionContext = buildRoutingDecisionContext({
              files: reviewFiles,
              riskFlags: changeset.riskFlags || {},
              riskLevel: recommendation?.severity || reviewResult?.riskLevel || null,
              fallbackFileCount: reviewFiles.length,
              focusedReview: isFocusedReview,
              projectId: changeset.projectId || null,
              projectPath,
              reviewType: 'changeset',
              reviewId: changesetId,
            });
            modelDecisionContext._executionModeOrder = executionModeOrder;
            const verifierStartedAt = Date.now();
            const result = await callProviderForReviewWithFailover(providerFailoverState, verifierPrompt, {
              deadline,
              modelPhase: 'verifier',
              reviewModelConfig,
              unavailableModels,
              modelDecisionContext,
              onRetry: (retryMeta) => {
                recordProviderRetry(reviewTiming, retryMeta);
                emitHeartbeat('provider_retry');
              },
              reviewTiming,
            });
            const verifierProviderMs = Date.now() - verifierStartedAt;
            recordProviderTiming(reviewTiming, {
              scope: 'verifier',
              chunkIndex: Number(verifierMeta?.ordinal || 1),
              totalChunks: Number(verifierMeta?.maxFindings || REVIEW_TWO_PASS_VERIFIER_MAX_FINDINGS),
              fileCount: reviewFiles.length,
              diffChars: verifierDiff.length,
              promptChars: verifierPrompt.length,
              promptBuildMs: 0,
              providerMs: verifierProviderMs,
            });
            if (result?.providerData) {
              selectedProviderData = result.providerData;
            }
            markModelUsed('verifier', result?.modelUsed);
            tokenUsage.input += Math.max(0, Number(result?.tokensUsed?.input || 0));
            tokenUsage.output += Math.max(0, Number(result?.tokensUsed?.output || 0));
            return parseHighRiskVerifierDecision(result?.text || '');
          }
        : null,
    });
    const corroborationSourceEvaluator = createCorroborationSourceEvaluator({
      verificationStatus: changeset.verification || null,
      linterFindings: getLinterCorroborationFindings(linterPrePass),
    });
    reviewResult = applyCorroborationPolicyToReview(reviewResult, {
      enabled: REVIEW_CORROBORATION_ENABLED,
      allowGroundedFallback: REVIEW_CORROBORATION_ALLOW_GROUNDED_FALLBACK,
      downgradeOnUnsupported: REVIEW_CORROBORATION_DOWNGRADE_UNSUPPORTED,
      sourceEvaluator: corroborationSourceEvaluator,
    });
    // Merge standalone deterministic findings
    reviewResult = mergePrePassFindingsIntoReview(reviewResult, linterPrePass);
    reviewResult = await applyOutcomeSuppressionPolicyToReview(reviewResult, {
      projectId: changeset.projectId || null,
      providerType: selectedProviderData?.providerType || null,
      providerModel: selectedProviderData?.providerModel || null,
      enabled: REVIEW_OUTCOME_SUPPRESSION_ENABLED,
      minSamples: REVIEW_OUTCOME_SUPPRESSION_MIN_SAMPLES,
      minDismissedRate: REVIEW_OUTCOME_SUPPRESSION_MIN_DISMISSED_RATE,
      maxPerRun: REVIEW_OUTCOME_SUPPRESSION_MAX_PER_RUN,
      maxKeys: REVIEW_OUTCOME_SUPPRESSION_MAX_KEYS,
      maxRows: REVIEW_OUTCOME_SUPPRESSION_MAX_ROWS,
      maxRowsPerKey: REVIEW_OUTCOME_SUPPRESSION_MAX_ROWS_PER_KEY,
    });
    normalizePrecisionIssueCounters(reviewResult);
    assignReviewTier(reviewResult);

    // Enrich with metadata
    const selectedProviderIdentity = normalizeProviderIdentity(selectedProviderData);
    const routingDecisionContext = buildRoutingDecisionContext({
      files: reviewFiles,
      riskFlags: changeset.riskFlags || {},
      riskLevel: reviewResult?.riskLevel || null,
      fallbackFileCount: reviewFiles.length,
      focusedReview: isFocusedReview,
      projectId: changeset.projectId || null,
      projectPath,
      reviewType: 'changeset',
      reviewId: changesetId,
    });
    const triageResolution = resolveEffectiveReviewModel(
      selectedProviderData,
      'triage',
      reviewModelConfig,
      routingDecisionContext
    );
    const reviewResolution = resolveEffectiveReviewModel(
      selectedProviderData,
      'review',
      reviewModelConfig,
      routingDecisionContext
    );
    const synthesisResolution = resolveEffectiveReviewModel(
      selectedProviderData,
      'synthesis',
      reviewModelConfig,
      routingDecisionContext
    );
    const effectiveReviewModel = modelsUsed.review || reviewResolution.model || selectedProviderIdentity.providerModel;
    markModelUsed('triage', triageResolution.model);
    markModelUsed('review', effectiveReviewModel);
    markModelUsed('synthesis', synthesisResolution.model);
    if (!reviewResult.stats || typeof reviewResult.stats !== 'object') {
      reviewResult.stats = {
        filesAnalyzed: reviewFiles.length,
        totalAdditions: changeset.riskFlags?.totalAdditions ?? 0,
        totalDeletions: changeset.riskFlags?.totalDeletions ?? 0,
        estimatedComplexity: 'moderate',
      };
    }
    reviewResult.stats.reviewModelStrategy = normalizeReviewModelStrategy(reviewModelConfig.strategy);
    reviewResult.stats.reviewModelEffectiveStrategy =
      normalizeReviewModelStrategy(reviewResolution.effectiveStrategy || reviewResolution.strategy);
    reviewResult.stats.reviewModelPolicyVersion =
      reviewResolution.policyVersion || REVIEW_MODEL_ROUTING_POLICY_VERSION;
    reviewResult.stats.reviewModelDecisionInputs = {
      ...reviewResolution.decisionInputs,
    };
    reviewResult.stats.reviewModelDecisionReason = reviewResolution.decisionReason || null;
    reviewResult.stats.reviewModelFallbackReason = reviewResolution.fallbackReason || null;
    reviewResult.stats.reviewModelBudgetClass = reviewResolution.budgetClass || 'balanced';
    reviewResult.stats.reviewModelThresholdProfile = reviewResolution.thresholdProfile || null;
    reviewResult.stats.reviewModelRollout = {
      mode: reviewResolution.rollout?.mode || DEFAULT_REVIEW_MODEL_ROLLOUT.mode,
      enabled: Boolean(reviewResolution.rollout?.enabled),
      reason: reviewResolution.rollout?.reason || null,
      canaryPercent: Number(reviewResolution.rollout?.canaryPercent || 0),
      canaryBucket: Number(reviewResolution.rollout?.canaryBucket || 0),
      allowlistEnabled: Boolean(reviewResolution.rollout?.allowlistEnabled),
      allowlistMatched: Boolean(reviewResolution.rollout?.allowlistMatched),
      gate: {
        status: reviewResolution.rollout?.gate?.status || DEFAULT_REVIEW_MODEL_ROLLOUT.gate.status,
        reasonCodes: normalizeReasonCodeList(reviewResolution.rollout?.gate?.reasonCodes || [], 20),
        source: reviewResolution.rollout?.gate?.source || DEFAULT_REVIEW_MODEL_ROLLOUT.gate.source,
        evaluatedAt: reviewResolution.rollout?.gate?.evaluatedAt || null,
      },
    };
    reviewResult.stats.modelsUsed = {
      ...modelsUsed,
    };
    reviewResult.stats.modelsChosenByPhase = {
      triage: triageResolution.model || null,
      review: effectiveReviewModel || null,
      synthesis: synthesisResolution.model || null,
      verifier: modelsUsed.verifier || null,
    };
    reviewResult.stats.phaseTimingsMs = {
      triage: 0,
      review: Math.max(0, Number(reviewTiming.providerMs) || 0),
      synthesis: 0,
      verifier: 0,
    };

    const fullResult = {
      ...reviewResult,
      provider: {
        type: selectedProviderIdentity.providerType,
        model: effectiveReviewModel,
      },
      tokensUsed: tokenUsage || { input: 0, output: 0 },
      reviewedAt: new Date().toISOString(),
      timing: finalizeReviewTiming(reviewTiming, 'success'),
    };
    const costSnapshot = attachReviewCostMetadata(fullResult, {
      providerType: selectedProviderIdentity.providerType,
      model: effectiveReviewModel,
      tokensUsed: fullResult.tokensUsed,
      providerNativeCost: toNumberOrNull(fullResult?.stats?.agenticCostUsd),
    });
    normalizePrecisionIssueCounters(fullResult);
    applyTimingSnapshotToReviewStats(fullResult, fullResult.timing);
    fullResult.stats.reviewModelGate = evaluateReviewRunGate(fullResult);
    logReviewTiming(fullResult.timing);
    emitHeartbeat('persisting');

    if (skippedCount > 0) {
      fullResult.summary = `${fullResult.summary} (${skippedCount} lock/binary file${skippedCount === 1 ? '' : 's'} excluded from review.)`;
    }
    Object.assign(fullResult, assignReviewFindingIds(fullResult, {
      previousReview: changeset.reviewData || null,
    }));

    // Save to changeset
    const terminalReviewError = derivePersistedReviewErrorFromResult(fullResult);
    await persistChangesetTerminalState(projectPath, changesetId, {
      reviewStatus: 'reviewed',
      reviewData: fullResult,
      reviewRiskLevel: fullResult.riskLevel,
      reviewSummary: fullResult.summary,
      reviewedBy: `${selectedProviderIdentity.providerType}/${effectiveReviewModel}`,
      reviewedAt: fullResult.reviewedAt,
      reviewError: terminalReviewError,
    });

    // Record token usage for billing/tracking
    try {
      await usageService.recordUsage({
        projectId: changeset.projectId || null,
        changesetId,
        reviewType: 'changeset',
        reviewId: changesetId,
        providerType: selectedProviderIdentity.providerType,
        model: effectiveReviewModel,
        inputTokens: fullResult.tokensUsed.input,
        outputTokens: fullResult.tokensUsed.output,
        providerNativeCost: costSnapshot?.providerNativeCost ?? null,
      });
    } catch (usageErr) {
      // Usage tracking is best-effort; don't fail the review
      console.error('Failed to record usage:', usageErr.message);
    }

    return fullResult;

  } catch (error) {
    reviewTiming.failureClass = classifyProviderError(error);
    const failureTiming = finalizeReviewTiming(reviewTiming, 'failed', reviewTiming.failureClass);
    logReviewTiming(failureTiming);
    const persistedReviewError = buildPersistedReviewErrorMessage(error, failureTiming);
    error.persistedReviewError = persistedReviewError;
    // Update status to failed
    await persistChangesetTerminalState(projectPath, changesetId, {
      reviewStatus: 'failed',
      reviewError: persistedReviewError,
    });
    throw error;
  } finally {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    deadline.clear();
  }
}

async function executeSharedPreparedReviewCore({
  contextType,
  reviewId,
  projectId = null,
  projectPath = null,
  reviewType = contextType,
  providerData,
  providerState,
  providerFailoverState,
  reviewModelConfig,
  unavailableModels,
  modelsUsed,
  markModelUsed,
  reviewTiming,
  deadline,
  executionModeOrder = [],
  emitHeartbeat = () => {},
  emitProgress = () => {},
  reviewFiles = [],
  totalFilesForCoverage = 0,
  omittedFiles = [],
  focusedCoveragePlanner = null,
  isFocusedReview = false,
  focusedReviewResolution = null,
  metadataBase = {},
  riskFlags = {},
  totalAdditions = 0,
  totalDeletions = 0,
  verificationStatus = null,
  linterPrePass = null,
  routeContext = {},
  // When the active provider's primary execution mode is `cli-agentic`, callers
  // pass 'cli-agentic' here so the shared structured core also runs the provider
  // in agentic mode. Without it, `filterExecutionModesForRequest` strips
  // cli-agentic by default and silently downgrades to `cli-agent`/`cli-pipe` —
  // a different `claude` invocation that can fail on machines where the agentic
  // path works fine (e.g. flaky Bun-compiled CLI on CPUs without AVX).
  reviewExecutionMode = null,
}) {
  const normalizedReviewFiles = Array.isArray(reviewFiles) ? reviewFiles.filter(Boolean) : [];
  if (normalizedReviewFiles.length === 0) {
    throw new Error('Shared review core requires at least one prepared file');
  }

  const normalizedTotalFiles = Math.max(
    normalizedReviewFiles.length,
    Number.isFinite(Number(totalFilesForCoverage)) ? Number(totalFilesForCoverage) : normalizedReviewFiles.length
  );
  const normalizedRiskFlags = (riskFlags && typeof riskFlags === 'object') ? riskFlags : {};
  const normalizedOmittedFiles = Array.isArray(omittedFiles) ? omittedFiles : [];
  const qualityMode = metadataBase.qualityMode || resolveReviewQualityMode();
  const chunkTargetChars = resolveChunkCharLimit(providerData);

  const buildDecisionContext = ({
    files,
    diffChars = null,
    fallbackFileCount = null,
    riskLevel = null,
  } = {}) => {
    const modelDecisionContext = buildRoutingDecisionContext({
      files,
      riskFlags: normalizedRiskFlags,
      riskLevel,
      diffChars,
      fallbackFileCount,
      focusedReview: isFocusedReview,
      projectId,
      projectPath,
      reviewType,
      reviewId,
      branchName: routeContext.branchName || null,
      baseBranch: routeContext.baseBranch || null,
      headSha: routeContext.headSha || null,
      mergeBaseSha: routeContext.mergeBaseSha || null,
    });
    modelDecisionContext._executionModeOrder = executionModeOrder;
    if (reviewExecutionMode) {
      modelDecisionContext.reviewExecutionMode = reviewExecutionMode;
    }
    return modelDecisionContext;
  };

  const runSingleReview = async (diffText, metadata, progressContext = null, callContext = {}) => {
    emitHeartbeat('provider_call');
    const promptBuildStartedAt = Date.now();
    const promptDiff = prepareDiffForPrompt(diffText, resolvePromptHardLimit(providerData));
    const { prompt, promptContextTelemetry } = buildReviewPrompt(promptDiff, metadata);
    const promptArtifactName = callContext?.scope === 'chunk' && callContext?.chunkIndex
      ? `prompt-standard-chunk-${callContext.chunkIndex}`
      : callContext?.scope === 'file' && Array.isArray(metadata?.filePaths) && metadata.filePaths[0]
        ? `prompt-standard-file-${normalizePathForMatch(metadata.filePaths[0]).replace(/\//g, '__')}`
        : 'prompt-standard';
    await writeReviewDebugText({
      projectId,
      projectPath,
      reviewType,
      reviewId,
    }, promptArtifactName, prompt);
    const promptBuildMs = Date.now() - promptBuildStartedAt;
    let heartbeatInterval = null;

    const resolveProgressValue = (fieldName, getterName) => {
      if (!progressContext) return 0;
      if (getterName && typeof progressContext[getterName] === 'function') {
        const dynamicValue = Number(progressContext[getterName]());
        if (Number.isFinite(dynamicValue)) return Math.max(0, Math.trunc(dynamicValue));
      }
      const fallbackValue = Number(progressContext[fieldName]);
      if (Number.isFinite(fallbackValue)) return Math.max(0, Math.trunc(fallbackValue));
      return 0;
    };

    if (progressContext) {
      const isActive = typeof progressContext.isActive === 'function'
        ? progressContext.isActive
        : () => true;
      const emitProgressHeartbeat = () => {
        if (!isActive()) return;
        emitProgress({
          phase: progressContext.phase || 'chunk_inflight',
          currentChunk: progressContext.currentChunk,
          totalChunks: progressContext.totalChunks,
          filesCompleted: resolveProgressValue('filesCompleted', 'getFilesCompleted'),
          totalFiles: resolveProgressValue('totalFiles', 'getTotalFiles'),
          activeChunkFiles: resolveProgressValue('activeChunkFiles', 'getActiveChunkFiles'),
          elapsedSeconds: 0,
        });
      };
      emitProgressHeartbeat();
      heartbeatInterval = setInterval(emitProgressHeartbeat, REVIEW_PROVIDER_HEARTBEAT_MS);
    }

    try {
      const result = await callProviderForReviewWithFailover(providerFailoverState, prompt, {
        deadline,
        modelPhase: 'review',
        reviewModelConfig,
        unavailableModels,
        modelDecisionContext: buildDecisionContext({
          files: Array.isArray(metadata?.filePaths)
            ? metadata.filePaths.map((path) => ({ path }))
            : [],
          diffChars: diffText.length,
          fallbackFileCount: metadata?.fileCount ?? normalizedReviewFiles.length,
        }),
        onRetry: (retryMeta) => {
          recordProviderRetry(reviewTiming, retryMeta);
          if (!progressContext) return;
          if (typeof progressContext.isActive === 'function' && !progressContext.isActive()) return;
          emitProgress({
            phase: 'provider_retry',
            currentChunk: progressContext.currentChunk,
            totalChunks: progressContext.totalChunks,
            filesCompleted: resolveProgressValue('filesCompleted', 'getFilesCompleted'),
            totalFiles: resolveProgressValue('totalFiles', 'getTotalFiles'),
            activeChunkFiles: resolveProgressValue('activeChunkFiles', 'getActiveChunkFiles'),
            elapsedSeconds: 0,
            retryAttempt: retryMeta.attempt,
            retryMaxAttempts: retryMeta.maxAttempts,
            retryDelayMs: retryMeta.delayMs,
          });
        },
        reviewTiming,
      });
      if (result?.providerData) {
        providerState.selectedProviderData = result.providerData;
      }
      markModelUsed('review', result?.modelUsed);
      const resolvedProviderData = result?.providerData || providerState.selectedProviderData;
      const effectiveReviewResolution = resolveEffectiveReviewModel(
        resolvedProviderData,
        'review',
        reviewModelConfig,
        buildDecisionContext({
          files: Array.isArray(metadata?.filePaths)
            ? metadata.filePaths.map((path) => ({ path }))
            : [],
          diffChars: diffText.length,
          fallbackFileCount: metadata?.fileCount ?? normalizedReviewFiles.length,
        })
      );
      recordProviderTiming(reviewTiming, {
        ...callContext,
        fileCount: metadata.fileCount,
        diffChars: diffText.length,
        promptChars: prompt.length,
        promptBuildMs,
        providerMs: 0,
      });
      const parsedReview = parseReviewResponseWithVisibility(result.text, {
        diffText,
        filePaths: metadata.filePaths,
        fileCount: metadata.fileCount,
        totalAdditions: metadata.totalAdditions,
        totalDeletions: metadata.totalDeletions,
        qualityMode: metadata.qualityMode || qualityMode,
        reviewPolicy: metadata.reviewPolicy || null,
      }, {
        reviewType: contextType,
        reviewId,
        stage: 'standard_review',
      });
      applyPromptContextTelemetryToReviewStats(parsedReview, promptContextTelemetry);
      const evidenceReview = applyEvidencePolicyToReview(parsedReview, {
        diffText,
        filePaths: metadata.filePaths,
        policy: metadata.evidencePolicy,
      });
      if (!evidenceReview.review.stats || typeof evidenceReview.review.stats !== 'object') {
        evidenceReview.review.stats = {};
      }
      evidenceReview.review.stats.evidencePolicy = evidenceReview.policy;
      return {
        review: evidenceReview.review,
        tokensUsed: result.tokensUsed || { input: 0, output: 0 },
        provider: {
          providerType: normalizeProviderIdentity(resolvedProviderData).providerType,
          providerModel: result?.modelUsed
            || normalizeProviderIdentity(resolvedProviderData).providerModel,
          effectiveStrategy: effectiveReviewResolution.effectiveStrategy,
        },
      };
    } finally {
      if (heartbeatInterval) clearInterval(heartbeatInterval);
    }
  };

  const runChunkedReview = async () => {
    const chunkReviewFiles = prioritizeReviewFilesForChunking(normalizedReviewFiles, providerData, {
      reviewProfile: metadataBase.reviewProfile || null,
    });
    const chunks = chunkFilesForReview(chunkReviewFiles, chunkTargetChars, REVIEW_MAX_CHUNKS);
    const createChunkRunState = () => ({
      chunkReviews: [],
      completedFilePaths: [],
      chunkDurationsMs: [],
      filesCompleted: 0,
      activeChunkFiles: 0,
      cancelled: false,
      deadlinePressureStop: null,
    });

    const runChunkWithFallback = async (chunkFiles, {
      chunkIndex,
      totalChunks,
      splitDepth = 0,
      splitOrdinal = '',
    }, chunkState) => {
      if (chunkState.cancelled) return;
      deadline.check();
      let isChunkActive = false;
      const markChunkActive = () => {
        if (isChunkActive) return;
        chunkState.activeChunkFiles += chunkFiles.length;
        isChunkActive = true;
      };
      const markChunkInactive = () => {
        if (!isChunkActive) return;
        chunkState.activeChunkFiles = Math.max(0, chunkState.activeChunkFiles - chunkFiles.length);
        isChunkActive = false;
      };
      markChunkActive();
      const chunkStartedAt = Date.now();
      const chunkDiff = generateDiffFromFiles(chunkFiles);
      const splitLabel = splitOrdinal ? `.${splitOrdinal}` : '';
      const chunkMeta = {
        ...metadataBase,
        title: `${metadataBase.title} (chunk ${chunkIndex}/${totalChunks}${splitLabel})`,
        fileCount: chunkFiles.length,
        filePaths: chunkFiles.map((file) => file.path),
      };

      try {
        const reviewedChunk = await runSingleReview(chunkDiff, chunkMeta, {
          phase: 'chunk_inflight',
          currentChunk: chunkIndex,
          totalChunks,
          filesCompleted: chunkState.filesCompleted,
          getFilesCompleted: () => chunkState.filesCompleted,
          totalFiles: normalizedReviewFiles.length,
          getTotalFiles: () => normalizedReviewFiles.length,
          activeChunkFiles: chunkState.activeChunkFiles,
          getActiveChunkFiles: () => chunkState.activeChunkFiles,
          isActive: () => !chunkState.cancelled,
        }, {
          scope: 'chunk',
          chunkIndex,
          totalChunks,
          splitOrdinal: splitLabel || null,
          fileCount: chunkFiles.length,
        });
        if (chunkState.cancelled) {
          markChunkInactive();
          return;
        }
        chunkState.chunkReviews.push(reviewedChunk);
        chunkState.filesCompleted += chunkFiles.length;
        chunkState.completedFilePaths.push(...chunkFiles.map((file) => file.path).filter(Boolean));
        chunkState.chunkDurationsMs.push(Math.max(1, Date.now() - chunkStartedAt));
        markChunkInactive();
        recordFirstSignal(reviewTiming, {
          scope: 'chunk',
          chunkIndex,
          totalChunks,
          filesCompleted: chunkState.filesCompleted,
          totalFiles: normalizedReviewFiles.length,
        });
        emitProgress({
          phase: 'chunk_complete',
          currentChunk: chunkIndex,
          totalChunks,
          filesCompleted: chunkState.filesCompleted,
          totalFiles: normalizedReviewFiles.length,
          activeChunkFiles: chunkState.activeChunkFiles,
          elapsedSeconds: 0,
        });
      } catch (error) {
        markChunkInactive();
        if (error.isDeadline) {
          chunkState.cancelled = true;
          throw error;
        }
        if (chunkState.cancelled) return;
        const canSplitFurther =
          isLikelyTimeoutOrContextError(error)
          && chunkFiles.length > 1
          && splitDepth < REVIEW_CHUNK_SPLIT_MAX_DEPTH;
        if (!canSplitFurther) {
          chunkState.cancelled = true;
          throw error;
        }
        const midpoint = Math.ceil(chunkFiles.length / 2);
        await runChunkWithFallback(chunkFiles.slice(0, midpoint), {
          chunkIndex,
          totalChunks,
          splitDepth: splitDepth + 1,
          splitOrdinal: `${splitOrdinal}a`,
        }, chunkState);
        await runChunkWithFallback(chunkFiles.slice(midpoint), {
          chunkIndex,
          totalChunks,
          splitDepth: splitDepth + 1,
          splitOrdinal: `${splitOrdinal}b`,
        }, chunkState);
      }
    };

    const chunkState = createChunkRunState();
    for (let i = 0; i < chunks.length; i += 1) {
      const pressureStop = resolveChunkDeadlinePressureStop({
        providerData: providerState.selectedProviderData || providerData,
        deadline,
        chunkState,
        nextChunkIndex: i + 1,
        totalChunks: chunks.length,
        totalReviewFiles: chunkReviewFiles.length,
      });
      if (pressureStop) {
        chunkState.cancelled = true;
        chunkState.deadlinePressureStop = pressureStop;
        emitProgress({
          phase: 'chunk_partial',
          currentChunk: Math.min(chunks.length, Math.max(1, i)),
          totalChunks: chunks.length,
          filesCompleted: chunkState.filesCompleted,
          totalFiles: normalizedReviewFiles.length,
          activeChunkFiles: 0,
          elapsedSeconds: 0,
        });
        break;
      }
      emitProgress({
        phase: 'chunk_start',
        currentChunk: i + 1,
        totalChunks: chunks.length,
        filesCompleted: chunkState.filesCompleted,
        totalFiles: normalizedReviewFiles.length,
        activeChunkFiles: Math.max(0, chunkState.activeChunkFiles + chunks[i].length),
      });
      await runChunkWithFallback(chunks[i], {
        chunkIndex: i + 1,
        totalChunks: chunks.length,
      }, chunkState);
    }

    const stoppedForDeadlinePressure = !!chunkState.deadlinePressureStop;
    const completedReviewFiles = stoppedForDeadlinePressure
      ? chunkState.filesCompleted
      : chunkReviewFiles.length;
    const completedFilePaths = stoppedForDeadlinePressure
      ? chunkState.completedFilePaths
      : chunkReviewFiles.map((file) => file.path);
    const omittedByDeadlinePressure = stoppedForDeadlinePressure
      ? Math.max(0, chunkReviewFiles.length - chunkState.filesCompleted)
      : 0;
    const aggregated = aggregateChunkReviews(chunkState.chunkReviews, {
      fallbackSummary: `Reviewed ${chunkReviewFiles.length} files using chunked analysis.`,
      fileCount: normalizedTotalFiles,
      totalFileCount: normalizedTotalFiles,
      focusedFileCount: completedReviewFiles,
      omittedFileCount: normalizedOmittedFiles.length + omittedByDeadlinePressure,
      filePaths: completedFilePaths,
      totalAdditions,
      totalDeletions,
    });
    if (chunkState.deadlinePressureStop) {
      annotatePartialReview(aggregated, {
        completedChunks: chunkState.deadlinePressureStop.completedChunks,
        totalChunks: chunks.length,
        errorMessage: chunkState.deadlinePressureStop.message,
        errorClass: 'deadline',
        remainingChunkStatus: 'skipped',
      });
      aggregated.review.stats.chunkDeadlinePressureStop = true;
      aggregated.review.stats.chunkDeadlineRemainingMs = chunkState.deadlinePressureStop.remainingMs;
      aggregated.review.stats.chunkDeadlineStopThresholdMs = chunkState.deadlinePressureStop.thresholdMs;
      aggregated.review.stats.chunkDeadlineStaticThresholdMs = chunkState.deadlinePressureStop.staticThresholdMs;
      aggregated.review.stats.chunkDeadlineDynamicThresholdMs = chunkState.deadlinePressureStop.dynamicThresholdMs;
      aggregated.review.stats.chunkDeadlineTierReferenceMs = chunkState.deadlinePressureStop.tierReferenceMs;
      aggregated.review.stats.chunkDeadlineTierFloorMs = chunkState.deadlinePressureStop.tierReferenceMs;
      aggregated.review.stats.chunkEstimatedNextChunkMs = chunkState.deadlinePressureStop.estimatedNextChunkMs;
      aggregated.review.stats.chunkObservedP75Ms = chunkState.deadlinePressureStop.observedP75Ms;
      aggregated.review.stats.chunkStopFinalizationBufferMs = chunkState.deadlinePressureStop.finalizationBufferMs;
      aggregated.review.stats.chunkDeadlineNextChunkIndex = chunkState.deadlinePressureStop.nextChunkIndex;
    }
    return aggregated;
  };

  const runPerFileReview = async () => {
    const triaged = normalizedReviewFiles.map((file) => ({
      file,
      className: classifyFileForPerFileReview(file),
    }));
    const deepReviewEntries = triaged.filter((entry) => entry.className === 'standard' || entry.className === 'large');
    const triageOmittedCount = Math.max(0, triaged.length - deepReviewEntries.length);
    const triageOmittedPaths = triaged
      .filter((entry) => entry.className !== 'standard' && entry.className !== 'large')
      .map((entry) => String(entry?.file?.path || '').trim())
      .filter(Boolean);
    const totalDeepFiles = deepReviewEntries.length;
    const cacheEnabledForRun = REVIEW_FILE_CACHE_ENABLED && !!projectId;

    emitProgress({
      phase: 'file_triage',
      currentChunk: 0,
      totalChunks: Math.max(1, totalDeepFiles),
      filesCompleted: 0,
      totalFiles: normalizedReviewFiles.length,
    });

    const aggregateArgs = {
      fallbackSummary: `Reviewed ${totalDeepFiles}/${normalizedReviewFiles.length} files using per-file analysis.`,
      fileCount: normalizedTotalFiles,
      totalFileCount: normalizedTotalFiles,
      focusedFileCount: totalDeepFiles,
      omittedFileCount: normalizedOmittedFiles.length + triageOmittedCount,
      filePaths: normalizedReviewFiles.map((file) => file.path),
      totalAdditions,
      totalDeletions,
      reviewPolicy: metadataBase.reviewPolicy || null,
    };

    if (totalDeepFiles === 0) {
      const emptyAggregate = aggregateChunkReviews([], aggregateArgs);
      emptyAggregate.review.summary = `${emptyAggregate.review.summary} (All ${normalizedReviewFiles.length} files were triaged as trivial/skip in this run.)`;
      emptyAggregate.review.stats.perFileMode = true;
      emptyAggregate.review.stats.filesDeepReviewed = 0;
      emptyAggregate.review.stats.filesTotal = normalizedTotalFiles;
      emptyAggregate.review.stats.omittedFiles = normalizedOmittedFiles.length + triageOmittedCount;
      emptyAggregate.review.stats.perFileFailedFiles = 0;
      emptyAggregate.review.stats.perFileFailedPaths = [];
      emptyAggregate.review.stats.perFileCacheHits = 0;
      emptyAggregate.review.stats.perFileCacheMisses = 0;
      emptyAggregate.review.stats.perFileTriageOmittedPaths = triageOmittedPaths;
      return emptyAggregate;
    }

    const cacheCandidateProviders = getProviderCandidatesInPreferredOrder(
      providerFailoverState,
      providerState.selectedProviderData || providerData
    );
    const deepEntriesWithCache = deepReviewEntries.map((entry, index) => {
      const seen = new Set();
      const cacheCandidates = [];
      for (const candidate of cacheCandidateProviders) {
        const identity = normalizeProviderIdentity(candidate);
        const modelResolution = resolveEffectiveReviewModel(
          candidate,
          'review',
          reviewModelConfig,
          buildDecisionContext({ files: [entry.file], fallbackFileCount: 1 })
        );
        const descriptor = buildReviewFileCacheDescriptor({
          contextType,
          file: entry.file,
          providerType: identity.providerType,
          providerModel: modelResolution.model || identity.providerModel,
          effectiveStrategy: modelResolution.effectiveStrategy,
          qualityMode,
        });
        if (seen.has(descriptor.cacheKey)) continue;
        seen.add(descriptor.cacheKey);
        cacheCandidates.push(descriptor);
      }
      return { ...entry, index, cacheCandidates };
    });

    const cacheRowsByKey = new Map();
    if (cacheEnabledForRun) {
      const cacheKeys = Array.from(new Set(
        deepEntriesWithCache.flatMap((entry) => entry.cacheCandidates.map((candidate) => candidate.cacheKey))
      ));
      if (cacheKeys.length > 0) {
        try {
          const cacheRows = await branchReviewService.getReviewFileCacheByKeys(projectId, cacheKeys);
          for (const row of cacheRows) {
            if (!row?.cacheKey || !isValidCachedPerFileReview(row.review)) continue;
            cacheRowsByKey.set(row.cacheKey, row);
          }
          if (cacheRowsByKey.size > 0) {
            await branchReviewService.touchReviewFileCacheByKeys(projectId, Array.from(cacheRowsByKey.keys()));
          }
        } catch (error) {
          console.warn(`[ReviewService] Failed to read per-file cache for ${contextType} ${reviewId}:`, error.message);
        }
      }
    }

    const perFileResults = new Array(totalDeepFiles).fill(null);
    const entriesToReview = [];
    let perFileCacheHits = 0;
    for (const entry of deepEntriesWithCache) {
      const cacheHit = entry.cacheCandidates.find((candidate) => cacheRowsByKey.has(candidate.cacheKey));
      if (cacheHit) {
        const cached = cacheRowsByKey.get(cacheHit.cacheKey);
        perFileResults[entry.index] = {
          review: cached.review,
          tokensUsed: { input: 0, output: 0 },
          provider: {
            providerType: cached.providerType || 'unknown',
            providerModel: cached.providerModel || 'unknown',
            effectiveStrategy: cached.effectiveStrategy || cacheHit.effectiveStrategy || 'unknown',
          },
        };
        perFileCacheHits += 1;
      } else {
        entriesToReview.push(entry);
      }
    }
    const perFileCacheMisses = entriesToReview.length;
    let completedFiles = perFileCacheHits;
    const failedFileEntries = [];
    const cacheWriteEntries = [];

    for (const { file, index } of entriesToReview) {
      emitProgress({
        phase: 'file_review_start',
        currentChunk: index + 1,
        totalChunks: totalDeepFiles,
        filesCompleted: completedFiles,
        totalFiles: totalDeepFiles,
        activeChunkFiles: 1,
      });
      deadline.check(REVIEW_DEADLINE_START_BUFFER_MS, `review file ${file.path}`);
      const reviewedFileMeta = {
        ...metadataBase,
        title: `${metadataBase.title} (${file.path})`,
        fileCount: 1,
        filePaths: [file.path],
        omittedFilesCount: 0,
        omittedFiles: [],
      };
      try {
        const reviewedFile = await runSingleReview(generateDiffFromFiles([file]), reviewedFileMeta, {
          phase: 'file_review_inflight',
          currentChunk: index + 1,
          totalChunks: totalDeepFiles,
          filesCompleted: completedFiles,
          totalFiles: totalDeepFiles,
          activeChunkFiles: 1,
        }, {
          scope: 'file',
          chunkIndex: index + 1,
          totalChunks: totalDeepFiles,
          fileCount: 1,
        });
        perFileResults[index] = reviewedFile;
        completedFiles += 1;
        recordFirstSignal(reviewTiming, {
          scope: 'per_file',
          chunkIndex: index + 1,
          totalChunks: totalDeepFiles,
          filesCompleted: completedFiles,
          totalFiles: totalDeepFiles,
        });
        if (cacheEnabledForRun && reviewedFile?.review) {
          cacheWriteEntries.push({
            ...buildReviewFileCacheDescriptor({
              contextType,
              file,
              providerType: reviewedFile.provider?.providerType,
              providerModel: reviewedFile.provider?.providerModel,
              effectiveStrategy: reviewedFile.provider?.effectiveStrategy,
              qualityMode,
            }),
            review: reviewedFile.review,
          });
        }
        emitProgress({
          phase: 'file_review_complete',
          currentChunk: index + 1,
          totalChunks: totalDeepFiles,
          filesCompleted: completedFiles,
          totalFiles: totalDeepFiles,
          activeChunkFiles: 0,
          elapsedSeconds: 0,
        });
      } catch (error) {
        completedFiles += 1;
        failedFileEntries.push({
          path: file.path,
          message: error?.message || 'Review failed',
          deadline: !!error?.isDeadline,
          errorClass: classifyProviderError(error),
        });
        emitProgress({
          phase: 'file_review_failed',
          currentChunk: index + 1,
          totalChunks: totalDeepFiles,
          filesCompleted: completedFiles,
          totalFiles: totalDeepFiles,
          activeChunkFiles: 0,
          elapsedSeconds: 0,
        });
      }
    }

    if (cacheEnabledForRun && cacheWriteEntries.length > 0) {
      try {
        await branchReviewService.upsertReviewFileCacheEntries(projectId, cacheWriteEntries);
      } catch (error) {
        console.warn(`[ReviewService] Failed to write per-file cache for ${contextType} ${reviewId}:`, error.message);
      }
    }

    const aggregated = aggregateChunkReviews(perFileResults.filter(Boolean), aggregateArgs);
    aggregated.review.stats.perFileMode = true;
    aggregated.review.stats.perFileFailedFiles = failedFileEntries.length;
    aggregated.review.stats.perFileFailedPaths = failedFileEntries.map((entry) => entry.path);
    aggregated.review.stats.perFileCacheHits = perFileCacheHits;
    aggregated.review.stats.perFileCacheMisses = perFileCacheMisses;
    aggregated.review.stats.perFileTriageOmittedPaths = triageOmittedPaths;
    aggregated.review.stats.filesDeepReviewed = Math.max(0, totalDeepFiles - failedFileEntries.length);

    if (failedFileEntries.length > 0) {
      annotatePartialReview(aggregated, {
        completedChunks: aggregated.review.stats.filesDeepReviewed || 0,
        totalChunks: totalDeepFiles,
        errorMessage: `Per-file review failed for ${failedFileEntries.length}/${totalDeepFiles} file(s).`,
        errorClass: failedFileEntries[0]?.errorClass || null,
      });
      emitProgress({
        phase: 'file_partial',
        currentChunk: Math.min(totalDeepFiles, Math.max(1, completedFiles)),
        totalChunks: totalDeepFiles,
        filesCompleted: completedFiles,
        totalFiles: totalDeepFiles,
        activeChunkFiles: 0,
        elapsedSeconds: 0,
      });
    }

    return aggregated;
  };

  const usePerFilePath = shouldUsePerFileReviewPath(providerData, normalizedReviewFiles.length);
  let reviewResult;
  let tokenUsage;

  if (usePerFilePath) {
    reviewTiming.strategy = 'per_file';
    const perFile = await runPerFileReview();
    reviewResult = perFile.review;
    tokenUsage = perFile.tokensUsed;
  } else {
    const fullDiff = generateDiffFromFiles(normalizedReviewFiles);
    const shouldUseChunkedPath = shouldUseChunkedReviewPath(
      providerData,
      fullDiff.length,
      normalizedReviewFiles.length
    );

    if (shouldUseChunkedPath) {
      reviewTiming.strategy = 'chunked';
      const chunked = await runChunkedReview();
      reviewResult = chunked.review;
      tokenUsage = chunked.tokensUsed;
    } else {
      reviewTiming.strategy = 'single';
      try {
        emitProgress({
          phase: 'single_start',
          currentChunk: 1,
          totalChunks: 1,
          filesCompleted: 0,
          totalFiles: normalizedReviewFiles.length,
        });
        const single = await runSingleReview(fullDiff, metadataBase, {
          phase: 'single_inflight',
          currentChunk: 1,
          totalChunks: 1,
          filesCompleted: 0,
          totalFiles: normalizedReviewFiles.length,
          activeChunkFiles: normalizedReviewFiles.length,
        }, {
          scope: 'single',
          chunkIndex: 1,
          totalChunks: 1,
          fileCount: normalizedReviewFiles.length,
        });
        reviewResult = single.review;
        tokenUsage = single.tokensUsed;
        recordFirstSignal(reviewTiming, {
          scope: 'single',
          chunkIndex: 1,
          totalChunks: 1,
          filesCompleted: normalizedReviewFiles.length,
          totalFiles: normalizedReviewFiles.length,
        });
        emitProgress({
          phase: 'single_complete',
          currentChunk: 1,
          totalChunks: 1,
          filesCompleted: normalizedReviewFiles.length,
          totalFiles: normalizedReviewFiles.length,
        });
      } catch (error) {
        if (error?.isDeadline) {
          const partial = buildDeadlinePartialAggregate({
            fallbackSummary: `Review deadline reached before single-pass analysis completed for ${normalizedReviewFiles.length} files.`,
            fileCount: normalizedTotalFiles,
            totalFileCount: normalizedTotalFiles,
            focusedFileCount: normalizedReviewFiles.length,
            omittedFileCount: normalizedOmittedFiles.length,
            filePaths: normalizedReviewFiles.map((file) => file.path),
            totalAdditions,
            totalDeletions,
            totalChunks: 1,
            errorMessage: error?.message || 'Review deadline exceeded',
            errorClass: classifyProviderError(error),
          });
          reviewResult = partial.review;
          tokenUsage = partial.tokensUsed;
          emitProgress({
            phase: 'single_partial',
            currentChunk: 1,
            totalChunks: 1,
            filesCompleted: 0,
            totalFiles: normalizedReviewFiles.length,
            activeChunkFiles: normalizedReviewFiles.length,
            elapsedSeconds: 0,
          });
        } else if (isLikelyTimeoutOrContextError(error) && normalizedReviewFiles.length > 1) {
          deadline.check();
          reviewTiming.strategy = 'single_fallback_chunked';
          const chunked = await runChunkedReview();
          reviewResult = chunked.review;
          tokenUsage = chunked.tokensUsed;
        } else {
          throw error;
        }
      }
    }
  }

  if (isFocusedReview && reviewResult?.stats?.reviewMode !== 'focused') {
    reviewResult.summary = synthesizeLargeReviewSummary({
      chunkCount: reviewResult.stats?.chunkCount || 1,
      summaryText: reviewResult.summary,
      focusedFiles: normalizedReviewFiles.length,
      totalFiles: normalizedTotalFiles,
      omittedFiles: normalizedOmittedFiles.length,
      recommendations: reviewResult.recommendations || [],
    });
  }
  if (!reviewResult.stats || typeof reviewResult.stats !== 'object') {
    reviewResult.stats = {
      filesAnalyzed: normalizedReviewFiles.length,
      totalAdditions,
      totalDeletions,
      estimatedComplexity: 'moderate',
    };
  }

  const deepReviewedFiles = Math.max(
    0,
    Math.min(
      normalizedTotalFiles,
      Number(reviewResult.stats.filesDeepReviewed ?? normalizedReviewFiles.length) || 0
    )
  );
  const omissionReasons = buildOmissionReasonMap({
    focusedOmittedFiles: normalizedOmittedFiles,
    triageOmittedPaths: Array.isArray(reviewResult.stats.perFileTriageOmittedPaths)
      ? reviewResult.stats.perFileTriageOmittedPaths
      : [],
    failedPaths: Array.isArray(reviewResult.stats.perFileFailedPaths)
      ? reviewResult.stats.perFileFailedPaths
      : [],
  });
  const derivedOmittedFiles = Math.max(0, normalizedTotalFiles - deepReviewedFiles);
  const declaredOmittedFiles = Math.max(0, Number(reviewResult.stats.omittedFiles || 0));
  reviewResult.stats.reviewMode = isFocusedReview ? 'focused' : 'full';
  reviewResult.stats.filesDeepReviewed = deepReviewedFiles;
  reviewResult.stats.deepReviewedFiles = deepReviewedFiles;
  reviewResult.stats.filesTotal = normalizedTotalFiles;
  reviewResult.stats.totalChangedFiles = normalizedTotalFiles;
  reviewResult.stats.omittedFiles = Math.max(declaredOmittedFiles, derivedOmittedFiles);
  reviewResult.stats.omissionReasons = omissionReasons;
  reviewResult.stats.chunkCount = reviewResult.stats.chunkCount || 1;
  if (focusedCoveragePlanner) {
    reviewResult.stats.coveragePlanner = focusedCoveragePlanner;
  }
  if (!tokenUsage || typeof tokenUsage !== 'object') {
    tokenUsage = { input: 0, output: 0 };
  }

  let verifierPromptDiff = null;
  const resolveVerifierPromptDiff = () => {
    if (typeof verifierPromptDiff === 'string') return verifierPromptDiff;
    verifierPromptDiff = prepareDiffForPrompt(
      generateDiffFromFiles(normalizedReviewFiles),
      REVIEW_TWO_PASS_VERIFIER_DIFF_HARD_LIMIT
    );
    return verifierPromptDiff;
  };

  reviewResult = await runBoundedHighRiskVerifierPass(reviewResult, {
    enabled: REVIEW_TWO_PASS_VERIFIER_ENABLED,
    maxFindings: REVIEW_TWO_PASS_VERIFIER_MAX_FINDINGS,
    includeMedium: REVIEW_TWO_PASS_VERIFIER_INCLUDE_MEDIUM,
    maxMediumFindings: REVIEW_TWO_PASS_VERIFIER_MAX_MEDIUM_FINDINGS,
    mediumGate: {
      maxFirstSignalMs: REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_FIRST_SIGNAL_MS,
      maxDurationMs: REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_DURATION_MS,
      maxOmittedRate: REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_OMITTED_RATE,
      minDeepReviewedFiles: REVIEW_TWO_PASS_VERIFIER_MEDIUM_MIN_DEEP_REVIEWED_FILES,
    },
    unsupportedPolicy: REVIEW_TWO_PASS_VERIFIER_UNSUPPORTED_POLICY,
    verifyRecommendation: REVIEW_TWO_PASS_VERIFIER_ENABLED
      ? async (recommendation, verifierMeta = {}) => {
          emitHeartbeat('provider_call');
          deadline.check(REVIEW_DEADLINE_START_BUFFER_MS, 'verifier pass');
          const verifierPrompt = buildHighRiskVerifierPrompt(resolveVerifierPromptDiff(), recommendation, {
            title: metadataBase.title,
            fileCount: normalizedReviewFiles.length,
            totalAdditions,
            totalDeletions,
          });
          const result = await callProviderForReviewWithFailover(providerFailoverState, verifierPrompt, {
            deadline,
            modelPhase: 'verifier',
            reviewModelConfig,
            unavailableModels,
            modelDecisionContext: buildDecisionContext({
              files: normalizedReviewFiles,
              riskLevel: recommendation?.severity || reviewResult?.riskLevel || null,
              fallbackFileCount: normalizedReviewFiles.length,
            }),
            onRetry: (retryMeta) => {
              recordProviderRetry(reviewTiming, retryMeta);
              emitHeartbeat('provider_retry');
            },
            reviewTiming,
          });
          if (result?.providerData) {
            providerState.selectedProviderData = result.providerData;
          }
          markModelUsed('verifier', result?.modelUsed);
          tokenUsage.input += Math.max(0, Number(result?.tokensUsed?.input || 0));
          tokenUsage.output += Math.max(0, Number(result?.tokensUsed?.output || 0));
          return parseHighRiskVerifierDecision(result?.text || '');
        }
      : null,
  });

  reviewResult = applyCorroborationPolicyToReview(reviewResult, {
    enabled: REVIEW_CORROBORATION_ENABLED,
    allowGroundedFallback: REVIEW_CORROBORATION_ALLOW_GROUNDED_FALLBACK,
    downgradeOnUnsupported: REVIEW_CORROBORATION_DOWNGRADE_UNSUPPORTED,
    sourceEvaluator: createCorroborationSourceEvaluator({
      verificationStatus,
      linterFindings: getLinterCorroborationFindings(linterPrePass),
    }),
  });
  // Merge standalone deterministic findings (shared core)
  reviewResult = mergePrePassFindingsIntoReview(reviewResult, linterPrePass);
  reviewResult = await applyOutcomeSuppressionPolicyToReview(reviewResult, {
    projectId,
    providerType: providerState.selectedProviderData?.providerType || null,
    providerModel: providerState.selectedProviderData?.providerModel || null,
    enabled: REVIEW_OUTCOME_SUPPRESSION_ENABLED,
    minSamples: REVIEW_OUTCOME_SUPPRESSION_MIN_SAMPLES,
    minDismissedRate: REVIEW_OUTCOME_SUPPRESSION_MIN_DISMISSED_RATE,
    maxPerRun: REVIEW_OUTCOME_SUPPRESSION_MAX_PER_RUN,
    maxKeys: REVIEW_OUTCOME_SUPPRESSION_MAX_KEYS,
    maxRows: REVIEW_OUTCOME_SUPPRESSION_MAX_ROWS,
    maxRowsPerKey: REVIEW_OUTCOME_SUPPRESSION_MAX_ROWS_PER_KEY,
  });
  normalizePrecisionIssueCounters(reviewResult);
  assignReviewTier(reviewResult);

  return {
    reviewResult,
    tokenUsage,
  };
}

/**
 * Execute a review on a branch review
 * @param {string} projectPath - Project path
 * @param {string} branchReviewId - Branch review UUID
 * @param {Object} [options] - Review options
 * @param {boolean} [options.force] - Force re-review even if already reviewed
 * @param {'auto'|'full'} [options.reviewMode] - Diff-scope preference for reruns
 * @param {'trusted'|'working_tree'} [options.policySource] - Policy source for this run
 * @returns {Promise<Object>} ReviewResult with metadata
 */
async function reviewBranchReview(projectPath, branchReviewId, options = {}) {
  const externalSignal = options?.externalSignal || null;
  const onHeartbeat = typeof options?.onHeartbeat === 'function' ? options.onHeartbeat : null;
  const onProgressCheckpoint = typeof options?.onProgressCheckpoint === 'function'
    ? options.onProgressCheckpoint
    : null;
  const emitHeartbeat = (stage = 'running') => {
    if (!onHeartbeat) return;
    onHeartbeat({
      stage,
      reviewType: 'branch_review',
      reviewId: branchReviewId,
      ts: Date.now(),
    });
  };

  // Get review-specific provider preference, then build failover chain
  const reviewCtx2 = typeof providerService.getContextActiveProvider === 'function'
    ? await providerService.getContextActiveProvider('review')
    : null;
  const providerCandidates = typeof providerService.getReviewProviderCandidatesWithKeys === 'function'
    ? await providerService.getReviewProviderCandidatesWithKeys({
        maxCandidates: REVIEW_PROVIDER_FAILOVER_MAX_CANDIDATES,
        preferredProviderId: reviewCtx2?.providerId || null,
      })
    : [];
  const fallbackActiveProvider = providerCandidates.length === 0
    ? await providerService.getActiveProviderWithKey()
    : null;
  if (fallbackActiveProvider) {
    providerCandidates.push(fallbackActiveProvider);
  }
  const providerData = providerCandidates[0] || null;
  if (!providerData) {
    throw new Error('No active AI provider configured. Add an API key in Settings → AI Provider.');
  }
  const policySource = normalizeReviewPolicySource(options.policySource, 'trusted');
  const unavailableModels = new Set();
  const modelsUsed = {};
  const markModelUsed = (phase, model) => {
    if (!REVIEW_MODEL_PHASES.includes(phase)) return;
    if (typeof model !== 'string' || !model.trim()) return;
    modelsUsed[phase] = model.trim();
  };
  let selectedProviderData = providerData;
  const providerFailoverState = createProviderFailoverState(providerCandidates);

  // Load branch review
  let br = await branchReviewService.getById(branchReviewId);
  if (!br) {
    throw new Error('Branch review not found');
  }
  if (options.refreshLatestHead !== false) {
    br = await refreshLatestBranchReviewHeadForRun(projectPath, br);
  }

  // Check if already reviewed (unless force)
  if (br.reviewStatus === 'reviewed' && !options.force) {
    return null; // Already reviewed, caller should read from DB
  }

  let reviewModelConfig = null;
  let executionModeOrder = null;
  try {
    reviewModelConfig = resolveReviewModelConfigOverride(
      await loadReviewSettingOrThrow(
        () => getGlobalReviewModelConfig(),
        'Branch review'
      ),
      {
        reviewModelStrategy: options.reviewModelStrategy,
        reviewModelCustom: options.reviewModelCustom,
        reviewModelAdaptive: options.reviewModelAdaptive,
        reviewModelRollout: options.reviewModelRollout,
      }
    );
    executionModeOrder = await loadReviewSettingOrThrow(
      () => getExecutionModeOrder(),
      'Branch review'
    );
  } catch (error) {
    await persistPreflightSettingsFailure(
      async (reviewError) => persistBranchReviewTerminalState(branchReviewId, {
        reviewStatus: 'failed',
        reviewError,
      }),
      error
    );
  }
  const reviewTiming = createReviewTiming('branch_review', branchReviewId);
  const isCliAgenticPrimary = shouldUseCliAgenticFastPath({
    providerData,
    executionModeOrder,
    reviewType: 'branch_review',
    requestedMode: options.reviewMode,
  });
  const reviewExecutionContext = { reviewExecutionMode: isCliAgenticPrimary ? 'cli-agentic' : null };
  reviewTiming.providerMode = resolveProviderExecutionMode(providerData, reviewExecutionContext);
  setProviderCandidates(
    reviewTiming,
    providerFailoverState.candidates,
    (candidate) => resolveProviderExecutionMode(candidate, reviewExecutionContext)
  );
  const preEstimatedAgenticTier = isCliAgenticPrimary
    ? resolveAgenticTier(Number(br.fileCount) || 0)
    : null;
  const deadlineBudgetMs = isCliAgenticPrimary
    ? (preEstimatedAgenticTier === 'large'
      ? REVIEW_TOTAL_DEADLINE_CLI_AGENTIC_LARGE_MS
      : REVIEW_TOTAL_DEADLINE_CLI_AGENTIC_MS)
    : REVIEW_TOTAL_DEADLINE_MS;
  const deadline = createReviewDeadline(externalSignal, deadlineBudgetMs);
  let progressReviewModelDecision = resolveEffectiveReviewModel(
    providerData,
    'review',
    reviewModelConfig,
    {
      fallbackFileCount: Number(br.fileCount) || 0,
      projectId: br.projectId || null,
      reviewType: 'branch_review',
      reviewId: branchReviewId,
      branchName: br.branchName || null,
      baseBranch: br.baseBranch || null,
      headSha: br.headSha || null,
      mergeBaseSha: br.mergeBaseSha || null,
      projectPath,
    }
  );
  const heartbeatInterval = onHeartbeat
    ? setInterval(() => emitHeartbeat('running'), REVIEW_PROVIDER_HEARTBEAT_MS)
    : null;
  if (typeof heartbeatInterval?.unref === 'function') heartbeatInterval.unref();
  const reviewProgressStartedAt = Date.now();
  const getReviewProgressElapsedSeconds = () => Math.max(0, Math.floor((Date.now() - reviewProgressStartedAt) / 1000));
  let lastProgressCheckpoint = null;
  let progressScopeMetadata = null;
  const emitProgress = (payload = {}) => {
    emitHeartbeat(payload?.phase || 'progress');
    const payloadElapsed = Number(payload?.elapsedSeconds);
    const elapsedSeconds = Number.isFinite(payloadElapsed) && payloadElapsed > 0
      ? Math.floor(payloadElapsed)
      : getReviewProgressElapsedSeconds();
    const fallbackPhase = typeof payload?.phase === 'string' && payload.phase.trim()
      ? payload.phase.trim()
      : 'running';
    const checkpoint = normalizeQueueProgress({
      reviewModel: progressReviewModelDecision.model || providerData?.provider?.model || null,
      reviewModelStrategy: normalizeReviewModelStrategy(reviewModelConfig.strategy),
      reviewModelEffectiveStrategy: normalizeReviewModelStrategy(
        progressReviewModelDecision.effectiveStrategy || progressReviewModelDecision.strategy || reviewModelConfig.strategy
      ),
      ...(progressScopeMetadata || {}),
      ...payload,
      phase: fallbackPhase,
      elapsedSeconds,
    }, fallbackPhase, lastProgressCheckpoint);
    lastProgressCheckpoint = checkpoint;
    reviewEvents.emit('branch-review-progress', {
      projectId: br.projectId,
      branchReviewId,
      queueId: options.queueId || null,
      ...checkpoint,
    });
    if (onProgressCheckpoint) {
      onProgressCheckpoint(checkpoint);
    }
  };

  try {
    emitHeartbeat('starting');
    const filePrepStartedAt = Date.now();
    if (!br.mergeBaseSha) {
      throw new Error('Branch review has no merge-base SHA — cannot compute diff');
    }

    const headRef = br.headSha || 'HEAD';
    const diffScope = await resolveBranchReviewDiffScope(projectPath, br, {
      headRef,
      reviewMode: options.reviewMode,
    });
    if (diffScope.skipReview) {
      const reusedResult = clonePersistedReviewResult(br.reviewJson);
      if (reusedResult) {
        progressScopeMetadata = {
          diffScopeMode: diffScope.mode,
          diffScopeCommitCount: 0,
          diffBaseSha: diffScope.diffBaseSha || null,
          diffHeadSha: diffScope.diffHeadSha || headRef || null,
        };
        diffScope.diffScopeCommitCount = 0;
        applyDiffScopeMetadata(reusedResult, diffScope);
        reusedResult.stats = {
          ...(reusedResult.stats && typeof reusedResult.stats === 'object' ? reusedResult.stats : {}),
          incrementalSkipped: true,
          incrementalSkippedReason: 'no_unreviewed_commits',
          diffScopeCommitCount: 0,
        };
        const reviewedAt = createUpdatedReviewedAt(br.reviewedAt || reusedResult.reviewedAt || null);
        reusedResult.reviewedAt = reviewedAt;
        await persistBranchReviewTerminalState(branchReviewId, {
          reviewStatus: 'reviewed',
          reviewRiskLevel: reusedResult.riskLevel ?? br.reviewRiskLevel ?? null,
          reviewSummary: reusedResult.summary ?? br.reviewSummary ?? null,
          reviewJson: JSON.stringify(reusedResult),
          reviewError: null,
          reviewBaseBranch: br.baseBranch || br.reviewBaseBranch || null,
          reviewMergeBaseSha: br.mergeBaseSha || br.reviewMergeBaseSha || null,
          reviewForkPointSha: br.forkPointSha || br.reviewForkPointSha || null,
          reviewHeadSha: br.headSha || br.reviewHeadSha || null,
          reviewedAt,
        });
        emitProgress({
          phase: 'complete',
          totalFiles: 0,
          reviewedFiles: 0,
          diffScopeMode: diffScope.mode,
          diffScopeCommitCount: 0,
          diffBaseSha: diffScope.diffBaseSha || null,
          diffHeadSha: diffScope.diffHeadSha || headRef || null,
        });
        return reusedResult;
      }
      console.warn(
        `[ReviewService] skipReview was requested for branch review ${branchReviewId}, but no persisted review payload was available; continuing with a fresh review.`
      );
    }

    // Update status to reviewing only after the run is accepted.
    await branchReviewService.updateReview(branchReviewId, {
      review_status: 'reviewing',
      review_error: null,
    });
    const reviewDiffBaseSha = diffScope.diffBaseSha || br.mergeBaseSha;
    const [nameStatus, diffStats] = await Promise.all([
      diffScope.nameStatusLoader(projectPath, reviewDiffBaseSha, headRef),
      diffScope.diffStatLoader(projectPath, reviewDiffBaseSha, headRef).catch(() => null),
    ]);
    const reviewScopeFileCount = Math.max(0, Number(diffStats?.fileCount ?? br.fileCount) || 0);
    const reviewScopeTotalAdditions = Math.max(
      0,
      Number(diffStats?.totalAdditions ?? br.totalAdditions) || 0
    );
    const reviewScopeTotalDeletions = Math.max(
      0,
      Number(diffStats?.totalDeletions ?? br.totalDeletions) || 0
    );
    progressScopeMetadata = {
      diffScopeMode: diffScope.mode,
      diffScopeCommitCount: Math.max(0, Number(diffStats?.commitCount || 0)),
      diffBaseSha: diffScope.diffBaseSha || null,
      diffHeadSha: diffScope.diffHeadSha || headRef || null,
    };
    diffScope.diffScopeCommitCount = progressScopeMetadata.diffScopeCommitCount;
    const baseReviewProfile = await resolveReviewProjectProfile({ projectPath });
    const projectRecord = br.projectId ? await getProjectById(br.projectId).catch(() => null) : null;
    const generatedProjectPolicy = await ensureGeneratedProjectReviewPolicy(projectRecord);
    const reviewPolicy = await resolveEffectiveReviewPolicy({
      projectPath,
      reviewType: 'branch_review',
      reviewProfile: baseReviewProfile,
      baseBranch: br.baseBranch || null,
      baseSha: reviewDiffBaseSha || br.mergeBaseSha || null,
      policySource,
      generatedProjectPolicy,
    });
    const reviewProfile = applyReviewPolicyToReviewProfile(baseReviewProfile, reviewPolicy, {
      totalFiles: reviewScopeFileCount,
    });
    const {
      requestedScope,
      effectiveScope,
      globalExcludePatterns,
    } = await loadReviewSettingOrThrow(
      () => buildEffectiveScope(options.scope),
      'Branch review'
    );
    const scopedNameStatus = effectiveScope
      ? nameStatus.filter((entry) => matchesScopeEntry(entry, effectiveScope))
      : nameStatus;
    const prioritizedNameStatus = prioritizeNameStatusEntries(scopedNameStatus);
    const diffStatMap = buildDiffStatMap(diffStats?.files || []);
    const rawReviewableNameStatus = prioritizedNameStatus.filter((entry) => !isLockFile(entry.path));
    const lockSkippedCount = Math.max(0, prioritizedNameStatus.length - rawReviewableNameStatus.length);
    const shapedScope = buildFocusedSelectionInputFromReviewEntries(
      rawReviewableNameStatus,
      diffStatMap,
      reviewProfile
    );
    const reviewableMemberPathSet = new Set(collectReviewUnitMemberPaths(shapedScope.reviewUnits));
    const reviewableNameStatus = rawReviewableNameStatus.filter(
      (entry) => reviewableMemberPathSet.has(normalizePathForMatch(entry.path))
    );
    const focusedSelectionInput = shapedScope.reviewUnits;
    const shapedScopeTelemetry = shapedScope.telemetry;
    let focusedSelection = null;
    let focusedReviewResolution = null;
    let focusedBudget = null;
    const focusedDecisionContext = buildRoutingDecisionContext({
      files: focusedSelectionInput,
      riskFlags: {
        largeBlastRadius: focusedSelectionInput.length > LARGE_REVIEW_FILE_COUNT,
      },
      diffChars: focusedSelectionInput.reduce(
        (sum, entry) => sum + (Number(entry.reviewSizeHint) || 0),
        0
      ),
      fallbackFileCount: focusedSelectionInput.length,
      focusedReview: false,
      projectId: br.projectId || null,
      projectPath,
      reviewType: 'branch_review',
      reviewId: branchReviewId,
      branchName: br.branchName || null,
      baseBranch: br.baseBranch || null,
      headSha: br.headSha || null,
      mergeBaseSha: reviewDiffBaseSha || null,
    });
    focusedReviewResolution = resolveEffectiveReviewModel(
      providerData,
      'review',
      reviewModelConfig,
      focusedDecisionContext
    );
    progressReviewModelDecision = focusedReviewResolution || progressReviewModelDecision;
    focusedBudget = deriveFocusedReviewBudgetConfig({
      files: focusedSelectionInput,
      providerData,
      reviewResolution: focusedReviewResolution,
      deadline,
    });
    focusedSelection = selectFilesForFocusedReview(focusedSelectionInput, focusedBudget);
    let agenticFallbackMeta = null;

    // ── Agentic early-exit ──────────────────────────────────────────────
    // When cli-agentic is the primary execution mode for the active provider,
    // bypass file hydration, diff gen, verification, and corroboration.
    // Instead, send a directive prompt that lets the agent explore the repo itself.
    if (isCliAgenticPrimary) {
      const ignorePatterns = [
        ...(Array.isArray(globalExcludePatterns) ? globalExcludePatterns : []),
        ...(Array.isArray(effectiveScope?.excludePatterns) ? effectiveScope.excludePatterns : []),
      ].filter(Boolean);
      const agenticOutcome = await runCliAgenticReviewFastPath({
        reviewType: 'branch_review',
        reviewId: branchReviewId,
        projectId: br.projectId || null,
        projectPath,
        providerData,
        providerFailoverState,
        reviewModelConfig,
        unavailableModels,
        executionModeOrder,
        deadline,
        reviewTiming,
        emitProgress,
        emitHeartbeat,
        markModelUsed,
        fileHintsInput: focusedSelectionInput,
        ignorePatterns,
        reviewProfile,
        reviewPolicy,
        shapedScopeTelemetry,
        branchName: br.branchName || '',
        baseBranch: br.baseBranch || 'main',
        mergeBaseSha: reviewDiffBaseSha || '',
        headSha: br.headSha || headRef || 'HEAD',
        totalAdditions: reviewScopeTotalAdditions,
        totalDeletions: reviewScopeTotalDeletions,
        qualityMode: resolveReviewQualityMode(options.qualityMode),
        lockSkippedCount,
        diffLoader: diffScope.fullDiffLoader,
        diffMode: diffScope.mode || 'full',
        partialMode: options.partial === true,
        codegraphMcpEnabledOverride: typeof options.codegraphMcpEnabledOverride === 'boolean'
          ? options.codegraphMcpEnabledOverride
          : null,
      });
      selectedProviderData = agenticOutcome.selectedProviderData || selectedProviderData;
      agenticFallbackMeta = agenticOutcome.fallbackMeta || null;

      if (agenticOutcome.accepted && agenticOutcome.reviewResult) {
        const selectedProviderIdentity = normalizeProviderIdentity(selectedProviderData);
        const effectiveReviewModel = modelsUsed.review || selectedProviderIdentity.providerModel;
        const fullResult = {
          ...agenticOutcome.reviewResult,
          provider: {
            type: selectedProviderIdentity.providerType,
            model: effectiveReviewModel,
          },
          tokensUsed: agenticOutcome.tokenUsage || { input: 0, output: 0 },
          reviewedAt: new Date().toISOString(),
          timing: finalizeReviewTiming(reviewTiming, 'success'),
        };
        const costSnapshot = attachReviewCostMetadata(fullResult, {
          providerType: selectedProviderIdentity.providerType,
          model: effectiveReviewModel,
          tokensUsed: fullResult.tokensUsed,
          providerNativeCost: toNumberOrNull(fullResult?.stats?.agenticCostUsd),
        });
        applyReviewProfileStats(fullResult, {
          reviewProfile,
          shapedScopeTelemetry,
        });
        applyReviewPolicyStats(fullResult, { reviewPolicy });
        applyDiffScopeMetadata(fullResult, diffScope);
        normalizePrecisionIssueCounters(fullResult);
        applyTimingSnapshotToReviewStats(fullResult, fullResult.timing);
        logReviewTiming(fullResult.timing);
        await attachPreviousUnresolvedBranchFindings({
          branchReviewId,
          projectId: br.projectId,
          previousReview: br.reviewJson,
          nextReview: fullResult,
          previousHeadSha: br.reviewHeadSha || br.headSha || null,
        });
        Object.assign(fullResult, assignReviewFindingIds(fullResult, {
          previousReview: br.reviewJson,
        }));

        const terminalReviewError = derivePersistedReviewErrorFromResult(fullResult);
        await persistBranchReviewTerminalState(branchReviewId, {
          reviewStatus: 'reviewed',
          reviewRiskLevel: fullResult.riskLevel,
          reviewSummary: fullResult.summary,
          reviewJson: JSON.stringify(fullResult),
          reviewError: terminalReviewError,
          reviewBaseBranch: br.baseBranch || null,
          reviewMergeBaseSha: br.mergeBaseSha || null,
          reviewForkPointSha: br.forkPointSha || null,
          reviewHeadSha: br.headSha || null,
          reviewedAt: fullResult.reviewedAt || new Date().toISOString(),
        });

        try {
          await usageService.recordUsage({
            projectId: br.projectId || null,
            changesetId: null,
            reviewType: 'branch_review',
            reviewId: branchReviewId,
            providerType: selectedProviderIdentity.providerType,
            model: effectiveReviewModel,
            inputTokens: fullResult.tokensUsed.input,
            outputTokens: fullResult.tokensUsed.output,
            providerNativeCost: costSnapshot?.providerNativeCost ?? null,
          });
        } catch (usageErr) {
          console.error('Failed to record usage:', usageErr.message);
        }

        return fullResult;
      }
    }
    // ── End agentic early-exit ──────────────────────────────────────────

    // ── Partial coverage followup: targeted non-agentic review on uncovered files ──
    if (agenticFallbackMeta?.mode === 'partial_followup') {
      const uncoveredPaths = new Set(
        (agenticFallbackMeta.uncoveredFiles || []).map(p => normalizePathForMatch(p)).filter(Boolean)
      );
      const uncoveredEntries = focusedSelectionInput.filter(
        (entry) => reviewUnitIntersectsPathSet(entry, uncoveredPaths)
      );
      // Reset fallback to let it flow into the standard non-agentic path
      // scoped only to uncovered files
      agenticFallbackMeta = {
        ...agenticFallbackMeta,
        mode: 'diff_followup',
        reason: 'insufficient_deep_coverage',
        _partialMergeSource: agenticFallbackMeta.agenticReviewResult,
        _partialMergeTokens: agenticFallbackMeta.agenticTokensUsed,
        _partialUncoveredEntries: uncoveredEntries,
      };
      // Override focused selection to target only uncovered files
      focusedSelection = {
        mode: uncoveredEntries.length < focusedSelectionInput.length ? 'focused' : 'full',
        reviewFiles: uncoveredEntries,
        omittedFiles: focusedSelectionInput
          .filter((entry) => !reviewUnitIntersectsPathSet(entry, uncoveredPaths)),
        totalFiles: focusedSelectionInput.length,
      };
    }

    if (!agenticFallbackMeta || agenticFallbackMeta.mode !== 'diff_followup') {
      // No fallback needed — should not reach here (handled in agentic early-exit)
    }

    focusedSelection = coerceFocusedSelectionForAgenticFallback(
      focusedSelection,
      focusedSelectionInput,
      agenticFallbackMeta
    );

    let isFocusedReview = focusedSelection.mode === 'focused';
    let omittedFiles = focusedSelection.omittedFiles;
    const focusedCoveragePlanner = focusedSelection.planner || focusedBudget?.planner || null;
    const focusedPathSet = new Set(collectReviewUnitMemberPaths(focusedSelection.reviewFiles));
    const primaryEntriesToHydrate = isFocusedReview
      ? reviewableNameStatus.filter((entry) => focusedPathSet.has(normalizePathForMatch(entry.path)))
      : reviewableNameStatus;
    const fallbackEntriesToHydrate = isFocusedReview
      ? reviewableNameStatus.filter((entry) => !focusedPathSet.has(normalizePathForMatch(entry.path)))
      : [];
    const totalEntriesToHydrate = primaryEntriesToHydrate.length + fallbackEntriesToHydrate.length;

    // Build hydrated file list with before/after content
    const files = [];
    let skippedCount = lockSkippedCount;
    let entriesProcessed = 0;
    emitProgress({
      phase: 'preparing_files',
      currentChunk: 0,
      totalChunks: 1,
      filesCompleted: 0,
      totalFiles: totalEntriesToHydrate,
    });
    const emitPrepareProgress = () => {
      if (entriesProcessed % 5 !== 0 && entriesProcessed !== totalEntriesToHydrate) return;
      emitProgress({
        phase: 'preparing_files',
        currentChunk: 0,
        totalChunks: 1,
        filesCompleted: entriesProcessed,
        totalFiles: totalEntriesToHydrate,
      });
    };

    const hydrateEntries = async (entries) => {
      if (!Array.isArray(entries) || entries.length === 0) return;
      const preparedEntries = await mapWithConcurrency(
        entries,
        REVIEW_FILE_PREP_CONCURRENCY,
        async (entry) => {
          try {
            const beforePath = entry.oldPath || entry.path;
            const [before, after] = await Promise.all([
              entry.status !== 'A'
                ? gitService.getFileAtRef(projectPath, reviewDiffBaseSha, beforePath)
                : Promise.resolve(null),
              entry.status !== 'D'
                ? gitService.getFileAtRef(projectPath, headRef, entry.path)
                : Promise.resolve(null),
            ]);

            // Skip binary files
            if ((before && before.includes('\0')) || (after && after.includes('\0'))) {
              return { skipped: true };
            }

            return {
              skipped: false,
              file: {
                path: entry.path,
                oldPath: entry.oldPath || null,
                before,
                after,
                status: entry.status,
              },
            };
          } finally {
            entriesProcessed++;
            emitPrepareProgress();
          }
        }
      );

      for (const preparedEntry of preparedEntries) {
        if (preparedEntry?.skipped) {
          skippedCount++;
          continue;
        }
        if (preparedEntry?.file) {
          files.push(preparedEntry.file);
        }
      }
    };

    await hydrateEntries(primaryEntriesToHydrate);
    if (files.length === 0 && isFocusedReview && fallbackEntriesToHydrate.length > 0) {
      console.warn(
        `[ReviewService] BR ${branchReviewId} focused preselection yielded no reviewable hydrated files; retrying broader hydration scope`
      );
      await hydrateEntries(fallbackEntriesToHydrate);
      if (files.length > 0) {
        isFocusedReview = false;
        omittedFiles = [];
      }
    }

    if (files.length === 0) {
      if (effectiveScope) {
        throw new Error('No reviewable files matched active scope/ignore filters. Adjust scope or Review Settings → Ignore Patterns and retry.');
      }
      throw new Error('Branch review has no reviewable files');
    }
    const reviewFiles = files;
    const qualityMode = resolveReviewQualityMode(options.qualityMode);
    reviewTiming.filePrepMs += Date.now() - filePrepStartedAt;
    const totalFilesForCoverage = isFocusedReview
      ? focusedSelectionInput.length
      : reviewFiles.length;
    const omittedPromptFiles = isFocusedReview
      ? summarizeOmittedFilesForPrompt(omittedFiles, REVIEW_OMITTED_FILE_PROMPT_LIMIT, { reviewProfile })
      : [];
    const branchRangeCommits = (
      reviewDiffBaseSha
      && headRef
      && typeof gitService.getCommitsBetween === 'function'
    )
      ? await gitService.getCommitsBetween(projectPath, reviewDiffBaseSha, headRef).catch(() => [])
      : [];
    const branchVerificationStatus = await resolveBranchReviewVerificationStatus(projectPath, br, {
      mergeBaseSha: reviewDiffBaseSha,
      headSha: headRef,
      rangeCommits: branchRangeCommits,
    });
    const priorReviewSummary = diffScope.mode === 'delta'
      ? String(br.reviewJson?.summary || br.reviewSummary || '').trim()
      : '';
    const priorReviewFindings = diffScope.mode === 'delta'
      ? summarizePriorReviewFindings(br.reviewJson)
      : [];
    const promptContextSignals = await collectPromptContextSignals(projectPath, {
      commitMessages: [],
      queuedCommitShas: [br.headSha, reviewDiffBaseSha].filter(Boolean),
      mergeBaseSha: reviewDiffBaseSha,
      headSha: headRef,
      rangeCommits: branchRangeCommits,
      verificationStatus: branchVerificationStatus,
      contextFiles: reviewFiles,
      cacheProjectId: br.projectId || null,
      reviewProfile: reviewProfile || null,
      sameHashOnly: REVIEW_PROMPT_CONTEXT_SAME_HASH_ONLY,
      allowGuardedCrossHashHints: REVIEW_PROMPT_CONTEXT_ALLOW_CROSS_HASH_HINTS,
    });

    // ── Linter pre-pass (branch review) ────────────────────────────────
    const branchDiffForLinter = generateDiffFromFiles(reviewFiles);
    const linterPrePass = await runReviewLinterPrePass(projectPath, reviewFiles, branchDiffForLinter, {
      reviewPolicy: reviewPolicy || null,
      reviewProfile: reviewProfile || null,
      externalSignal: externalSignal || null,
    });
    await writeReviewDebugJson({
      projectId: br.projectId || null,
      projectPath,
      reviewType: 'branch_review',
      reviewId: branchReviewId,
    }, 'linter-prepass', linterPrePass);
    // ─────────────────────────────────────────────────────────────────────

    // Build prompt metadata with branch context
    const metadataBase = {
      title: `Branch review: ${br.branchName} vs ${br.baseBranch}`,
      commitMessages: promptContextSignals.commitMessages,
      verificationStatus: promptContextSignals.verificationStatus,
      priorFindingHints: promptContextSignals.priorFindingHints,
      fileRiskContext: promptContextSignals.fileRiskContext,
      claudeConventions: promptContextSignals.claudeConventions,
      projectMetadata: promptContextSignals.projectMetadata,
      dismissedPatterns: promptContextSignals.dismissedPatterns,
      additionalPromptContextBlocks: promptContextSignals.additionalBlocks,
      linterFindings: getPromptLinterFindings(linterPrePass),
      queuedCommitShas: promptContextSignals.queuedCommitShas,
      promptContextBudgetChars: REVIEW_PROMPT_CONTEXT_BUDGET_CHARS,
      promptContextSameHashOnly: REVIEW_PROMPT_CONTEXT_SAME_HASH_ONLY,
      promptContextAllowCrossHashHints: REVIEW_PROMPT_CONTEXT_ALLOW_CROSS_HASH_HINTS,
      evidencePolicy: normalizeEvidencePolicyForReview(options.evidencePolicy),
      reviewProfile: buildReviewProfileStats(reviewProfile, null).reviewProfile,
      reviewPolicy,
      shapedScope: buildReviewProfileStats(null, shapedScopeTelemetry).shapedScope,
      fileCount: reviewFiles.length,
      filePaths: reviewFiles.map((file) => file.path),
      omittedFilesCount: omittedFiles.length,
      omittedFiles: omittedPromptFiles,
      totalAdditions: reviewScopeTotalAdditions,
      totalDeletions: reviewScopeTotalDeletions,
      qualityMode,
      diffScopeMode: diffScope.mode,
      diffScopeCommitCount: branchRangeCommits.length,
      diffBaseSha: diffScope.diffBaseSha || null,
      diffHeadSha: diffScope.diffHeadSha || null,
      priorReviewSummary,
      priorReviewFindings,
    };
    const chunkTargetChars = resolveChunkCharLimit(providerData);

    const runSingleReview = async (diffText, metadata, progressContext = null, callContext = {}) => {
      emitHeartbeat('provider_call');
      const modelDecisionContext = buildRoutingDecisionContext({
        files: Array.isArray(metadata?.filePaths)
          ? metadata.filePaths.map((path) => ({ path }))
          : [],
        riskFlags: metadata?.riskFlags || {},
        riskLevel: null,
        diffChars: diffText.length,
        fallbackFileCount: metadata?.fileCount ?? reviewFiles.length,
        focusedReview: isFocusedReview,
        projectId: br.projectId || null,
        projectPath,
        reviewType: 'branch_review',
        reviewId: branchReviewId,
        branchName: br.branchName || null,
        baseBranch: br.baseBranch || null,
        headSha: br.headSha || null,
        mergeBaseSha: reviewDiffBaseSha || null,
      });
      modelDecisionContext._executionModeOrder = executionModeOrder;
      const promptBuildStartedAt = Date.now();
      const promptDiff = prepareDiffForPrompt(diffText, resolvePromptHardLimit(providerData));
      const { prompt, promptContextTelemetry } = buildReviewPrompt(promptDiff, metadata);
      const promptArtifactName = callContext?.scope === 'chunk' && callContext?.chunkIndex
        ? `prompt-standard-chunk-${callContext.chunkIndex}`
        : callContext?.scope === 'file' && Array.isArray(metadata?.filePaths) && metadata.filePaths[0]
          ? `prompt-standard-file-${normalizePathForMatch(metadata.filePaths[0]).replace(/\//g, '__')}`
          : 'prompt-standard';
      await writeReviewDebugText({
        projectId: br.projectId || null,
        projectPath,
        reviewType: 'branch_review',
        reviewId: branchReviewId,
      }, promptArtifactName, prompt);
      const promptBuildMs = Date.now() - promptBuildStartedAt;
      let heartbeatInterval = null;
      const resolveProgressValue = (fieldName, getterName) => {
        if (!progressContext) return 0;
        if (getterName && typeof progressContext[getterName] === 'function') {
          const dynamic = Number(progressContext[getterName]());
          if (Number.isFinite(dynamic)) return Math.max(0, Math.trunc(dynamic));
        }
        const fallback = Number(progressContext[fieldName]);
        if (Number.isFinite(fallback)) return Math.max(0, Math.trunc(fallback));
        return 0;
      };

      if (progressContext) {
        const isActive = typeof progressContext.isActive === 'function'
          ? progressContext.isActive
          : () => true;
        const emitHeartbeat = () => {
          if (!isActive()) return;
          emitProgress({
            phase: progressContext.phase || 'chunk_inflight',
            currentChunk: progressContext.currentChunk,
            totalChunks: progressContext.totalChunks,
            filesCompleted: resolveProgressValue('filesCompleted', 'getFilesCompleted'),
            totalFiles: resolveProgressValue('totalFiles', 'getTotalFiles'),
            activeChunkFiles: resolveProgressValue('activeChunkFiles', 'getActiveChunkFiles'),
            elapsedSeconds: getReviewProgressElapsedSeconds(),
          });
        };
        emitHeartbeat();
        heartbeatInterval = setInterval(emitHeartbeat, REVIEW_PROVIDER_HEARTBEAT_MS);
      }

      try {
        const providerStartedAt = Date.now();
        const result = await callProviderForReviewWithFailover(providerFailoverState, prompt, {
          deadline,
          modelPhase: 'review',
          reviewModelConfig,
          unavailableModels,
          modelDecisionContext,
          onRetry: (retryMeta) => {
            recordProviderRetry(reviewTiming, retryMeta);
            if (!progressContext) return;
            if (typeof progressContext.isActive === 'function' && !progressContext.isActive()) return;
            emitProgress({
              phase: 'provider_retry',
              currentChunk: progressContext.currentChunk,
              totalChunks: progressContext.totalChunks,
              filesCompleted: resolveProgressValue('filesCompleted', 'getFilesCompleted'),
              totalFiles: resolveProgressValue('totalFiles', 'getTotalFiles'),
              activeChunkFiles: resolveProgressValue('activeChunkFiles', 'getActiveChunkFiles'),
              elapsedSeconds: getReviewProgressElapsedSeconds(),
              retryAttempt: retryMeta.attempt,
              retryMaxAttempts: retryMeta.maxAttempts,
              retryDelayMs: retryMeta.delayMs,
            });
          },
          reviewTiming,
        });
        if (result?.providerData) {
          selectedProviderData = result.providerData;
        }
        markModelUsed('review', result?.modelUsed);
        const resolvedProviderData = result?.providerData || selectedProviderData;
        const effectiveReviewResolution = resolveEffectiveReviewModel(
          resolvedProviderData,
          'review',
          reviewModelConfig,
          modelDecisionContext
        );
        const providerMs = Date.now() - providerStartedAt;
        recordProviderTiming(reviewTiming, {
          ...callContext,
          fileCount: metadata.fileCount,
          diffChars: diffText.length,
          promptChars: prompt.length,
          promptBuildMs,
          providerMs,
        });
        const parsedReview = parseReviewResponseWithVisibility(result.text, {
          diffText,
          filePaths: metadata.filePaths,
          fileCount: metadata.fileCount,
          totalAdditions: metadata.totalAdditions,
          totalDeletions: metadata.totalDeletions,
          qualityMode: metadata.qualityMode || qualityMode,
          reviewPolicy: metadata.reviewPolicy || null,
        }, {
          reviewType: 'branch_review',
          reviewId: branchReviewId,
          stage: 'standard_review',
        });
        applyPromptContextTelemetryToReviewStats(parsedReview, promptContextTelemetry);
        const evidenceReview = applyEvidencePolicyToReview(parsedReview, {
          diffText,
          filePaths: metadata.filePaths,
          policy: metadata.evidencePolicy,
        });
        if (!evidenceReview.review.stats || typeof evidenceReview.review.stats !== 'object') {
          evidenceReview.review.stats = {};
        }
        evidenceReview.review.stats.evidencePolicy = evidenceReview.policy;
        return {
          review: evidenceReview.review,
          tokensUsed: result.tokensUsed || { input: 0, output: 0 },
          provider: {
            providerType: normalizeProviderIdentity(resolvedProviderData).providerType,
            providerModel: result?.modelUsed
              || normalizeProviderIdentity(resolvedProviderData).providerModel,
            effectiveStrategy: effectiveReviewResolution.effectiveStrategy,
          },
        };
      } finally {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
      }
    };

    const runChunkedReview = async () => {
      const chunks = chunkFilesForReview(reviewFiles, chunkTargetChars, REVIEW_MAX_CHUNKS);
      const createChunkRunState = () => ({
        chunkReviews: [],
        filesCompleted: 0,
        activeChunkFiles: 0,
        cancelled: false,
      });
      const totalFiles = reviewFiles.length;

      const runChunkWithFallback = async (chunkFiles, {
        chunkIndex,
        totalChunks,
        splitDepth = 0,
        splitOrdinal = '',
      }, chunkState) => {
        if (chunkState.cancelled) return;
        deadline.check();
        let isChunkActive = false;
        const markChunkActive = () => {
          if (isChunkActive) return;
          chunkState.activeChunkFiles = Math.max(
            0,
            Math.trunc(Number(chunkState.activeChunkFiles) || 0) + chunkFiles.length
          );
          isChunkActive = true;
        };
        const markChunkInactive = () => {
          if (!isChunkActive) return;
          chunkState.activeChunkFiles = Math.max(
            0,
            Math.trunc(Number(chunkState.activeChunkFiles) || 0) - chunkFiles.length
          );
          isChunkActive = false;
        };
        markChunkActive();
        const chunkDiffStartedAt = Date.now();
        const chunkDiff = generateDiffFromFiles(chunkFiles);
        const chunkDiffMs = Date.now() - chunkDiffStartedAt;
        reviewTiming.diffBuildMs += chunkDiffMs;
        const splitLabel = splitOrdinal ? `.${splitOrdinal}` : '';
        const chunkMeta = {
          ...metadataBase,
          title: `${metadataBase.title} (chunk ${chunkIndex}/${totalChunks}${splitLabel})`,
          fileCount: chunkFiles.length,
          filePaths: chunkFiles.map((file) => file.path),
        };

        try {
          const reviewedChunk = await runSingleReview(chunkDiff, chunkMeta, {
            phase: 'chunk_inflight',
            currentChunk: chunkIndex,
            totalChunks,
            filesCompleted: chunkState.filesCompleted,
            getFilesCompleted: () => chunkState.filesCompleted,
            totalFiles,
            getTotalFiles: () => totalFiles,
            activeChunkFiles: chunkState.activeChunkFiles,
            getActiveChunkFiles: () => chunkState.activeChunkFiles,
            isActive: () => !chunkState.cancelled,
          }, {
            scope: 'chunk',
            chunkIndex,
            totalChunks,
            splitOrdinal: splitLabel || null,
            fileCount: chunkFiles.length,
            diffBuildMs: chunkDiffMs,
          });
          if (chunkState.cancelled) {
            markChunkInactive();
            return;
          }
          chunkState.chunkReviews.push(reviewedChunk);
          chunkState.filesCompleted += chunkFiles.length;
          markChunkInactive();
          recordFirstSignal(reviewTiming, {
            scope: 'chunk',
            chunkIndex,
            totalChunks,
            filesCompleted: chunkState.filesCompleted,
            totalFiles,
          });
          emitProgress({
            phase: 'chunk_complete',
            currentChunk: chunkIndex,
            totalChunks,
            filesCompleted: chunkState.filesCompleted,
            totalFiles,
            activeChunkFiles: chunkState.activeChunkFiles,
            elapsedSeconds: 0,
          });
        } catch (error) {
          markChunkInactive();
          if (error.isDeadline) {
            chunkState.cancelled = true;
            throw error;
          }
          if (chunkState.cancelled) return;
          const canSplitFurther =
            isLikelyTimeoutOrContextError(error) &&
            chunkFiles.length > 1 &&
            splitDepth < REVIEW_CHUNK_SPLIT_MAX_DEPTH;

          if (!canSplitFurther) {
            chunkState.cancelled = true;
            throw error;
          }

          const midpoint = Math.ceil(chunkFiles.length / 2);
          const left = chunkFiles.slice(0, midpoint);
          const right = chunkFiles.slice(midpoint);

          emitProgress({
            phase: 'chunk_split',
            currentChunk: chunkIndex,
            totalChunks,
            filesCompleted: chunkState.filesCompleted,
            totalFiles,
            activeChunkFiles: chunkState.activeChunkFiles,
            splitDepth: splitDepth + 1,
            splitParts: 2,
          });

          await runChunkWithFallback(left, {
            chunkIndex,
            totalChunks,
            splitDepth: splitDepth + 1,
            splitOrdinal: `${splitOrdinal}a`,
          }, chunkState);
          await runChunkWithFallback(right, {
            chunkIndex,
            totalChunks,
            splitDepth: splitDepth + 1,
            splitOrdinal: `${splitOrdinal}b`,
          }, chunkState);
        }
      };

      const runChunksWithConcurrency = async (concurrency, chunkState) => {
        if (concurrency <= 1 || chunks.length <= 1) {
          for (let i = 0; i < chunks.length; i++) {
            if (chunkState.cancelled) return;
            emitProgress({
              phase: 'chunk_start',
              currentChunk: i + 1,
              totalChunks: chunks.length,
              filesCompleted: chunkState.filesCompleted,
              totalFiles,
              activeChunkFiles: Math.max(0, (Number(chunkState.activeChunkFiles) || 0) + chunks[i].length),
            });

            await runChunkWithFallback(chunks[i], {
              chunkIndex: i + 1,
              totalChunks: chunks.length,
            }, chunkState);
          }
          return;
        }

        await mapWithConcurrency(
          chunks.map((chunkFiles, index) => ({ chunkFiles, index })),
          concurrency,
          async ({ chunkFiles, index }) => {
            if (chunkState.cancelled) return;
            emitProgress({
              phase: 'chunk_start',
              currentChunk: index + 1,
              totalChunks: chunks.length,
              filesCompleted: chunkState.filesCompleted,
              totalFiles,
              activeChunkFiles: Math.max(0, (Number(chunkState.activeChunkFiles) || 0) + chunkFiles.length),
            });

            await runChunkWithFallback(chunkFiles, {
              chunkIndex: index + 1,
              totalChunks: chunks.length,
            }, chunkState);
          }
        );
      };

      const configuredConcurrency = resolveBoundedSchedulerConcurrency({
        path: 'chunk',
        totalUnits: chunks.length,
        providerData,
        budgetClass: focusedReviewResolution?.budgetClass || 'balanced',
        deadline,
        baseline: resolveChunkConcurrency(providerData, chunks.length),
        maxConcurrency: REVIEW_CHUNK_CONCURRENCY_DYNAMIC_MAX,
      });
      let chunkFailure = null;
      let activeChunkState = createChunkRunState();
      try {
        await runChunksWithConcurrency(configuredConcurrency, activeChunkState);
      } catch (error) {
        activeChunkState.cancelled = true;
        const canFallbackToSerial =
          !error.isDeadline &&
          configuredConcurrency > 1 &&
          activeChunkState.chunkReviews.length === 0 &&
          (isLikelyTimeoutOrContextError(error) || isLikelyRateLimitError(error));
        if (!canFallbackToSerial) {
          chunkFailure = error;
        } else {
          console.warn(
            `[ReviewService] BR ${branchReviewId} parallel chunking failed (${error.message}); retrying serially`
          );
          const serialChunkState = createChunkRunState();
          activeChunkState = serialChunkState;
          try {
            await runChunksWithConcurrency(1, serialChunkState);
          } catch (serialError) {
            serialChunkState.cancelled = true;
            chunkFailure = serialError;
          }
        }
      }

      const finalChunkReviews = activeChunkState.chunkReviews;
      const aggregated = aggregateChunkReviews(finalChunkReviews, {
        fallbackSummary: `Reviewed ${reviewFiles.length} files using chunked analysis.`,
        fileCount: reviewScopeFileCount || reviewFiles.length,
        totalFileCount: totalFilesForCoverage,
        focusedFileCount: reviewFiles.length,
        omittedFileCount: omittedFiles.length,
        filePaths: reviewFiles.map((file) => file.path),
        totalAdditions: reviewScopeTotalAdditions,
        totalDeletions: reviewScopeTotalDeletions,
        reviewPolicy,
      });

      if (chunkFailure) {
        if (finalChunkReviews.length === 0) {
          if (chunkFailure?.isDeadline) {
            const partial = buildDeadlinePartialAggregate({
              fallbackSummary: `Review deadline reached before chunk analysis completed for ${reviewFiles.length} files.`,
              fileCount: reviewScopeFileCount || reviewFiles.length,
              totalFileCount: totalFilesForCoverage,
              focusedFileCount: reviewFiles.length,
              omittedFileCount: omittedFiles.length,
              filePaths: reviewFiles.map((file) => file.path),
              totalAdditions: reviewScopeTotalAdditions,
              totalDeletions: reviewScopeTotalDeletions,
              totalChunks: chunks.length,
              errorMessage: chunkFailure?.message || 'Review deadline exceeded',
              errorClass: classifyProviderError(chunkFailure),
            });
            applyDiffScopeMetadata(partial, diffScope);
            emitProgress({
              phase: 'chunk_partial',
              currentChunk: 1,
              totalChunks: chunks.length,
              filesCompleted: 0,
              totalFiles,
              activeChunkFiles: 0,
              elapsedSeconds: 0,
            });
            return partial;
          }
          throw chunkFailure;
        }
        annotatePartialReview(aggregated, {
          completedChunks: finalChunkReviews.length,
          totalChunks: chunks.length,
          errorMessage: chunkFailure?.message || 'Chunk review failed',
          errorClass: classifyProviderError(chunkFailure),
        });
        emitProgress({
          phase: 'chunk_partial',
          currentChunk: Math.min(chunks.length, Math.max(1, finalChunkReviews.length)),
          totalChunks: chunks.length,
          filesCompleted: activeChunkState.filesCompleted,
          totalFiles,
          activeChunkFiles: 0,
          elapsedSeconds: 0,
        });
      }

      return aggregated;
    };

    const runPerFileReview = async () => {
      const triaged = reviewFiles.map((file) => ({
        file,
        className: classifyFileForPerFileReview(file),
      }));
      const deepReviewEntries = triaged.filter((entry) => entry.className === 'standard' || entry.className === 'large');
      const triageOmittedCount = Math.max(0, triaged.length - deepReviewEntries.length);
      const triageOmittedPaths = triaged
        .filter((entry) => entry.className !== 'standard' && entry.className !== 'large')
        .map((entry) => String(entry?.file?.path || '').trim())
        .filter(Boolean);
      const totalDeepFiles = deepReviewEntries.length;
      const cacheProjectId = br.projectId || null;
      const cacheEnabledForRun = REVIEW_FILE_CACHE_ENABLED && !!cacheProjectId;

      emitProgress({
        phase: 'file_triage',
        currentChunk: 0,
        totalChunks: Math.max(1, totalDeepFiles),
        filesCompleted: 0,
        totalFiles: reviewFiles.length,
      });

      const aggregateArgs = {
        fallbackSummary: `Reviewed ${totalDeepFiles}/${reviewFiles.length} files using per-file analysis.`,
        fileCount: reviewScopeFileCount || reviewFiles.length,
        totalFileCount: totalFilesForCoverage,
        focusedFileCount: totalDeepFiles,
        omittedFileCount: omittedFiles.length + triageOmittedCount,
        filePaths: reviewFiles.map((file) => file.path),
        totalAdditions: reviewScopeTotalAdditions,
        totalDeletions: reviewScopeTotalDeletions,
        reviewPolicy,
      };

      if (totalDeepFiles === 0) {
        const emptyAggregate = aggregateChunkReviews([], aggregateArgs);
        emptyAggregate.review.summary = `${emptyAggregate.review.summary} (All ${reviewFiles.length} files were triaged as trivial/skip in this run.)`;
        emptyAggregate.review.stats.perFileMode = true;
        emptyAggregate.review.stats.filesDeepReviewed = 0;
        emptyAggregate.review.stats.filesTotal = totalFilesForCoverage;
        emptyAggregate.review.stats.omittedFiles = omittedFiles.length + triageOmittedCount;
        emptyAggregate.review.stats.perFileFailedFiles = 0;
        emptyAggregate.review.stats.perFileFailedPaths = [];
        emptyAggregate.review.stats.perFileCacheHits = 0;
        emptyAggregate.review.stats.perFileCacheMisses = 0;
        emptyAggregate.review.stats.perFileTriageOmittedPaths = triageOmittedPaths;
        emitProgress({
          phase: 'file_review_complete',
          currentChunk: 0,
          totalChunks: 1,
          filesCompleted: 0,
          totalFiles: reviewFiles.length,
          activeChunkFiles: 0,
          elapsedSeconds: 0,
        });
        return emptyAggregate;
      }

      const cacheCandidateProviders = getProviderCandidatesInPreferredOrder(
        providerFailoverState,
        selectedProviderData || providerData
      );
      const deepEntriesWithCache = deepReviewEntries.map((entry, index) => {
        const seen = new Set();
        const cacheCandidates = [];
        for (const candidate of cacheCandidateProviders) {
          const identity = normalizeProviderIdentity(candidate);
          const modelDecisionContext = buildRoutingDecisionContext({
            files: [entry.file],
            riskFlags: {
              largeBlastRadius: totalFilesForCoverage > FOCUSED_REVIEW_TRIGGER_FILE_COUNT,
            },
            fallbackFileCount: 1,
            focusedReview: isFocusedReview,
            projectId: br.projectId || null,
            projectPath,
            reviewType: 'branch_review',
            reviewId: branchReviewId,
            branchName: br.branchName || null,
            baseBranch: br.baseBranch || null,
            headSha: br.headSha || null,
            mergeBaseSha: reviewDiffBaseSha || null,
          });
          modelDecisionContext._executionModeOrder = executionModeOrder;
          const modelResolution = resolveEffectiveReviewModel(
            candidate,
            'review',
            reviewModelConfig,
            modelDecisionContext
          );
          const descriptor = buildReviewFileCacheDescriptor({
            contextType: 'branch_review',
            file: entry.file,
            providerType: identity.providerType,
            providerModel: modelResolution.model || identity.providerModel,
            effectiveStrategy: modelResolution.effectiveStrategy,
            qualityMode,
          });
          if (seen.has(descriptor.cacheKey)) continue;
          seen.add(descriptor.cacheKey);
          cacheCandidates.push(descriptor);
        }
        if (cacheCandidates.length === 0) {
          const identity = normalizeProviderIdentity(selectedProviderData || providerData);
          const modelDecisionContext = buildRoutingDecisionContext({
            files: [entry.file],
            riskFlags: {
              largeBlastRadius: totalFilesForCoverage > FOCUSED_REVIEW_TRIGGER_FILE_COUNT,
            },
            fallbackFileCount: 1,
            focusedReview: isFocusedReview,
            projectId: br.projectId || null,
            projectPath,
            reviewType: 'branch_review',
            reviewId: branchReviewId,
            branchName: br.branchName || null,
            baseBranch: br.baseBranch || null,
            headSha: br.headSha || null,
            mergeBaseSha: reviewDiffBaseSha || null,
          });
          modelDecisionContext._executionModeOrder = executionModeOrder;
          const modelResolution = resolveEffectiveReviewModel(
            selectedProviderData || providerData,
            'review',
            reviewModelConfig,
            modelDecisionContext
          );
          cacheCandidates.push(buildReviewFileCacheDescriptor({
            contextType: 'branch_review',
            file: entry.file,
            providerType: identity.providerType,
            providerModel: modelResolution.model || identity.providerModel,
            effectiveStrategy: modelResolution.effectiveStrategy,
            qualityMode,
          }));
        }
        return { ...entry, index, cacheCandidates };
      });

      const cacheRowsByKey = new Map();
      if (cacheEnabledForRun) {
        const cacheKeys = Array.from(
          new Set(deepEntriesWithCache.flatMap((entry) => entry.cacheCandidates.map((candidate) => candidate.cacheKey)))
        );
        if (cacheKeys.length > 0) {
          try {
            const cacheRows = await branchReviewService.getReviewFileCacheByKeys(cacheProjectId, cacheKeys);
            for (const row of cacheRows) {
              if (!row?.cacheKey || !isValidCachedPerFileReview(row.review)) continue;
              cacheRowsByKey.set(row.cacheKey, row);
            }
            if (cacheRowsByKey.size > 0) {
              await branchReviewService.touchReviewFileCacheByKeys(cacheProjectId, Array.from(cacheRowsByKey.keys()));
            }
          } catch (error) {
            console.warn(`[ReviewService] Failed to read per-file cache for BR ${branchReviewId}:`, error.message);
          }
        }
      }

      const perFileResults = new Array(totalDeepFiles).fill(null);
      const entriesToReview = [];
      let perFileCacheHits = 0;
      for (const entry of deepEntriesWithCache) {
        const cacheHit = entry.cacheCandidates.find((candidate) => cacheRowsByKey.has(candidate.cacheKey));
        if (cacheHit) {
          const cached = cacheRowsByKey.get(cacheHit.cacheKey);
          perFileResults[entry.index] = {
            review: cached.review,
            tokensUsed: { input: 0, output: 0 },
            provider: {
              providerType: cached.providerType || 'unknown',
              providerModel: cached.providerModel || 'unknown',
              effectiveStrategy: cached.effectiveStrategy || cacheHit.effectiveStrategy || 'unknown',
            },
          };
          perFileCacheHits += 1;
        } else {
          entriesToReview.push(entry);
        }
      }
      const perFileCacheMisses = entriesToReview.length;

      let completedFiles = perFileCacheHits;
      if (perFileCacheHits > 0) {
        recordFirstSignal(reviewTiming, {
          scope: 'per_file_cache',
          chunkIndex: 1,
          totalChunks: totalDeepFiles,
          filesCompleted: completedFiles,
          totalFiles: totalDeepFiles,
        });
      }
      if (perFileCacheHits > 0) {
        emitProgress({
          phase: 'file_review_complete',
          currentChunk: Math.min(totalDeepFiles, Math.max(1, perFileCacheHits)),
          totalChunks: totalDeepFiles,
          filesCompleted: completedFiles,
          totalFiles: totalDeepFiles,
          activeChunkFiles: 0,
          elapsedSeconds: 0,
        });
      }

      const failedFileEntries = [];
      const cacheWriteEntries = [];
      if (entriesToReview.length > 0) {
        const perFileConcurrency = resolveBoundedSchedulerConcurrency({
          path: 'per_file',
          totalUnits: entriesToReview.length,
          providerData,
          budgetClass: focusedReviewResolution?.budgetClass || 'balanced',
          deadline,
          baseline: REVIEW_PER_FILE_CONCURRENCY,
          maxConcurrency: REVIEW_PER_FILE_CONCURRENCY_MAX,
        });
        await mapWithConcurrency(
          entriesToReview,
          perFileConcurrency,
          async ({ file, index }) => {
            emitProgress({
              phase: 'file_review_start',
              currentChunk: index + 1,
              totalChunks: totalDeepFiles,
              filesCompleted: completedFiles,
              totalFiles: totalDeepFiles,
              activeChunkFiles: 1,
            });

            deadline.check(REVIEW_DEADLINE_START_BUFFER_MS, `review file ${file.path}`);
            const fileDiffStartedAt = Date.now();
            const fileDiff = generateDiffFromFiles([file]);
            const fileDiffMs = Date.now() - fileDiffStartedAt;
            reviewTiming.diffBuildMs += fileDiffMs;
            const fileMetadata = {
              ...metadataBase,
              title: `${metadataBase.title} (${file.path})`,
              fileCount: 1,
              filePaths: [file.path],
              omittedFilesCount: 0,
              omittedFiles: [],
            };
            try {
              const reviewedFile = await runSingleReview(fileDiff, fileMetadata, {
                phase: 'file_review_inflight',
                currentChunk: index + 1,
                totalChunks: totalDeepFiles,
                filesCompleted: completedFiles,
                totalFiles: totalDeepFiles,
                activeChunkFiles: 1,
                isActive: () => true,
              }, {
                scope: 'file',
                chunkIndex: index + 1,
                totalChunks: totalDeepFiles,
                fileCount: 1,
                diffBuildMs: fileDiffMs,
              });
              completedFiles += 1;
              perFileResults[index] = reviewedFile;
              recordFirstSignal(reviewTiming, {
                scope: 'per_file',
                chunkIndex: index + 1,
                totalChunks: totalDeepFiles,
                filesCompleted: completedFiles,
                totalFiles: totalDeepFiles,
              });
              if (cacheEnabledForRun && reviewedFile?.review) {
                const descriptor = buildReviewFileCacheDescriptor({
                  contextType: 'branch_review',
                  file,
                  providerType: reviewedFile.provider?.providerType,
                  providerModel: reviewedFile.provider?.providerModel,
                  effectiveStrategy: reviewedFile.provider?.effectiveStrategy,
                  qualityMode,
                });
                cacheWriteEntries.push({
                  ...descriptor,
                  review: reviewedFile.review,
                });
              }
              emitProgress({
                phase: 'file_review_complete',
                currentChunk: index + 1,
                totalChunks: totalDeepFiles,
                filesCompleted: completedFiles,
                totalFiles: totalDeepFiles,
                activeChunkFiles: 0,
                elapsedSeconds: 0,
              });
            } catch (error) {
              completedFiles += 1;
              failedFileEntries.push({
                path: file.path,
                message: error?.message || 'Review failed',
                deadline: !!error?.isDeadline,
                errorClass: classifyProviderError(error),
              });
              emitProgress({
                phase: 'file_review_failed',
                currentChunk: index + 1,
                totalChunks: totalDeepFiles,
                filesCompleted: completedFiles,
                totalFiles: totalDeepFiles,
                activeChunkFiles: 0,
                elapsedSeconds: 0,
              });
            }
          }
        );
      }

      if (cacheEnabledForRun && cacheWriteEntries.length > 0) {
        try {
          await branchReviewService.upsertReviewFileCacheEntries(cacheProjectId, cacheWriteEntries);
        } catch (error) {
          console.warn(`[ReviewService] Failed to write per-file cache for BR ${branchReviewId}:`, error.message);
        }
      }

      const perFileReviews = perFileResults.filter(Boolean);

      const aggregated = aggregateChunkReviews(perFileReviews, aggregateArgs);
      aggregated.review.stats.perFileMode = true;
      aggregated.review.stats.perFileFailedFiles = failedFileEntries.length;
      aggregated.review.stats.perFileFailedPaths = failedFileEntries.map((entry) => entry.path);
      aggregated.review.stats.perFileCacheHits = perFileCacheHits;
      aggregated.review.stats.perFileCacheMisses = perFileCacheMisses;
      aggregated.review.stats.perFileTriageOmittedPaths = triageOmittedPaths;
      aggregated.review.stats.filesDeepReviewed = Math.max(0, totalDeepFiles - failedFileEntries.length);

      if (failedFileEntries.length > 0) {
        const firstFailures = failedFileEntries.slice(0, 3).map((entry) => entry.path).join(', ');
        const suffix = failedFileEntries.length > 3 ? ` +${failedFileEntries.length - 3} more` : '';
        const primaryFailureClass = failedFileEntries.find((entry) => entry.errorClass && entry.errorClass !== 'unknown')?.errorClass || null;
        annotatePartialReview(aggregated, {
          completedChunks: perFileReviews.length,
          totalChunks: totalDeepFiles,
          errorMessage: `Per-file review failed for ${failedFileEntries.length}/${totalDeepFiles} file(s): ${firstFailures}${suffix}`,
          errorClass: primaryFailureClass,
        });
        emitProgress({
          phase: 'file_partial',
          currentChunk: Math.min(totalDeepFiles, Math.max(1, perFileReviews.length)),
          totalChunks: totalDeepFiles,
          filesCompleted: completedFiles,
          totalFiles: totalDeepFiles,
          activeChunkFiles: 0,
          elapsedSeconds: 0,
        });
      }

      return aggregated;
    };

    const usePerFilePath = shouldUsePerFileReviewPath(providerData, reviewFiles.length);
    let reviewResult;
    let tokenUsage;

    if (usePerFilePath) {
      reviewTiming.strategy = 'per_file';
      const perFile = await runPerFileReview();
      reviewResult = perFile.review;
      tokenUsage = perFile.tokensUsed;
    } else {
      const fullDiffStartedAt = Date.now();
      const fullDiff = generateDiffFromFiles(reviewFiles);
      const fullDiffMs = Date.now() - fullDiffStartedAt;
      reviewTiming.diffBuildMs += fullDiffMs;
      const shouldUseChunkedPath = shouldUseChunkedReviewPath(
        providerData,
        fullDiff.length,
        reviewFiles.length
      );

      if (shouldUseChunkedPath) {
        reviewTiming.strategy = 'chunked';
        const chunked = await runChunkedReview();
        reviewResult = chunked.review;
        tokenUsage = chunked.tokensUsed;
      } else {
        reviewTiming.strategy = 'single';
        try {
          emitProgress({
            phase: 'single_start',
            currentChunk: 1,
            totalChunks: 1,
            filesCompleted: 0,
            totalFiles: reviewFiles.length,
          });
          const single = await runSingleReview(fullDiff, metadataBase, {
            phase: 'single_inflight',
            currentChunk: 1,
            totalChunks: 1,
            filesCompleted: 0,
            totalFiles: reviewFiles.length,
            activeChunkFiles: reviewFiles.length,
          }, {
            scope: 'single',
            chunkIndex: 1,
            totalChunks: 1,
            fileCount: reviewFiles.length,
            diffBuildMs: fullDiffMs,
          });
          reviewResult = single.review;
          tokenUsage = single.tokensUsed;
          recordFirstSignal(reviewTiming, {
            scope: 'single',
            chunkIndex: 1,
            totalChunks: 1,
            filesCompleted: reviewFiles.length,
            totalFiles: reviewFiles.length,
          });
          emitProgress({
            phase: 'single_complete',
            currentChunk: 1,
            totalChunks: 1,
            filesCompleted: reviewFiles.length,
            totalFiles: reviewFiles.length,
          });
        } catch (error) {
          if (error?.isDeadline) {
            const partial = buildDeadlinePartialAggregate({
              fallbackSummary: `Review deadline reached before single-pass analysis completed for ${reviewFiles.length} files.`,
              fileCount: reviewScopeFileCount || reviewFiles.length,
              totalFileCount: totalFilesForCoverage,
              focusedFileCount: reviewFiles.length,
              omittedFileCount: omittedFiles.length,
              filePaths: reviewFiles.map((file) => file.path),
              totalAdditions: reviewScopeTotalAdditions,
              totalDeletions: reviewScopeTotalDeletions,
              totalChunks: 1,
              errorMessage: error?.message || 'Review deadline exceeded',
              errorClass: classifyProviderError(error),
            });
            reviewResult = partial.review;
            tokenUsage = partial.tokensUsed;
            emitProgress({
              phase: 'single_partial',
              currentChunk: 1,
              totalChunks: 1,
              filesCompleted: 0,
              totalFiles: reviewFiles.length,
              activeChunkFiles: reviewFiles.length,
              elapsedSeconds: 0,
            });
          } else {
            if (!isLikelyTimeoutOrContextError(error) || reviewFiles.length <= 1) {
              throw error;
            }
            deadline.check();
            reviewTiming.strategy = 'single_fallback_chunked';
            console.warn(
              `[ReviewService] BR ${branchReviewId} single-shot review failed (${error.message}); retrying with chunked strategy`
            );
            const chunked = await runChunkedReview();
            reviewResult = chunked.review;
            tokenUsage = chunked.tokensUsed;
          }
        }
      }
    }

    if (isFocusedReview) {
      const requiresFocusedSummary = reviewResult?.stats?.reviewMode !== 'focused';
      if (requiresFocusedSummary) {
        reviewResult.summary = synthesizeLargeReviewSummary({
          chunkCount: reviewResult.stats?.chunkCount || 1,
          summaryText: reviewResult.summary,
          focusedFiles: reviewFiles.length,
          totalFiles: totalFilesForCoverage,
          omittedFiles: omittedFiles.length,
          recommendations: reviewResult.recommendations || [],
        });
      }
    }
    if (!reviewResult.stats || typeof reviewResult.stats !== 'object') {
      reviewResult.stats = {
        filesAnalyzed: reviewFiles.length,
        totalAdditions: reviewScopeTotalAdditions,
        totalDeletions: reviewScopeTotalDeletions,
        estimatedComplexity: 'moderate',
      };
    }
    const deepReviewedFiles = Math.max(
      0,
      Math.min(
        totalFilesForCoverage,
        Number(reviewResult.stats.filesDeepReviewed ?? reviewFiles.length) || 0
      )
    );
    const triageOmittedPaths = Array.isArray(reviewResult.stats.perFileTriageOmittedPaths)
      ? reviewResult.stats.perFileTriageOmittedPaths
      : [];
    const failedPaths = Array.isArray(reviewResult.stats.perFileFailedPaths)
      ? reviewResult.stats.perFileFailedPaths
      : [];
    const omissionReasons = buildOmissionReasonMap({
      focusedOmittedFiles: omittedFiles,
      triageOmittedPaths,
      failedPaths,
    });
    const derivedOmittedFiles = Math.max(0, totalFilesForCoverage - deepReviewedFiles);
    const declaredOmittedFiles = Math.max(0, Number(reviewResult.stats.omittedFiles || 0));
    reviewResult.stats.reviewMode = isFocusedReview ? 'focused' : 'full';
    reviewResult.stats.filesDeepReviewed = deepReviewedFiles;
    reviewResult.stats.deepReviewedFiles = deepReviewedFiles;
    reviewResult.stats.filesTotal = totalFilesForCoverage;
    reviewResult.stats.totalChangedFiles = totalFilesForCoverage;
    reviewResult.stats.omittedFiles = Math.max(declaredOmittedFiles, derivedOmittedFiles);
    reviewResult.stats.omissionReasons = omissionReasons;
    reviewResult.stats.chunkCount = reviewResult.stats.chunkCount || 1;
    if (focusedCoveragePlanner) {
      reviewResult.stats.coveragePlanner = focusedCoveragePlanner;
    }
    if (!tokenUsage || typeof tokenUsage !== 'object') {
      tokenUsage = { input: 0, output: 0 };
    }
    let verifierPromptDiff = null;
    const resolveVerifierPromptDiff = () => {
      if (typeof verifierPromptDiff === 'string') return verifierPromptDiff;
      const rawVerifierDiff = generateDiffFromFiles(reviewFiles);
      verifierPromptDiff = prepareDiffForPrompt(rawVerifierDiff, REVIEW_TWO_PASS_VERIFIER_DIFF_HARD_LIMIT);
      return verifierPromptDiff;
    };
    reviewResult = await runBoundedHighRiskVerifierPass(reviewResult, {
      enabled: REVIEW_TWO_PASS_VERIFIER_ENABLED,
      maxFindings: REVIEW_TWO_PASS_VERIFIER_MAX_FINDINGS,
      includeMedium: REVIEW_TWO_PASS_VERIFIER_INCLUDE_MEDIUM,
      maxMediumFindings: REVIEW_TWO_PASS_VERIFIER_MAX_MEDIUM_FINDINGS,
      mediumGate: {
        maxFirstSignalMs: REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_FIRST_SIGNAL_MS,
        maxDurationMs: REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_DURATION_MS,
        maxOmittedRate: REVIEW_TWO_PASS_VERIFIER_MEDIUM_MAX_OMITTED_RATE,
        minDeepReviewedFiles: REVIEW_TWO_PASS_VERIFIER_MEDIUM_MIN_DEEP_REVIEWED_FILES,
      },
      unsupportedPolicy: REVIEW_TWO_PASS_VERIFIER_UNSUPPORTED_POLICY,
      verifyRecommendation: REVIEW_TWO_PASS_VERIFIER_ENABLED
        ? async (recommendation, verifierMeta = {}) => {
            emitHeartbeat('provider_call');
            deadline.check(REVIEW_DEADLINE_START_BUFFER_MS, 'verifier pass');
            const verifierDiff = resolveVerifierPromptDiff();
            const verifierPrompt = buildHighRiskVerifierPrompt(verifierDiff, recommendation, {
              title: metadataBase.title,
              fileCount: reviewFiles.length,
              totalAdditions: reviewScopeTotalAdditions,
              totalDeletions: reviewScopeTotalDeletions,
            });
            const modelDecisionContext = buildRoutingDecisionContext({
              files: reviewFiles,
              riskFlags: {
                largeBlastRadius: totalFilesForCoverage > FOCUSED_REVIEW_TRIGGER_FILE_COUNT,
              },
              riskLevel: recommendation?.severity || reviewResult?.riskLevel || null,
              fallbackFileCount: reviewFiles.length,
              focusedReview: isFocusedReview,
              projectId: br.projectId || null,
              projectPath,
              reviewType: 'branch_review',
              reviewId: branchReviewId,
              branchName: br.branchName || null,
              baseBranch: br.baseBranch || null,
              headSha: br.headSha || null,
              mergeBaseSha: reviewDiffBaseSha || null,
            });
            modelDecisionContext._executionModeOrder = executionModeOrder;
            const verifierStartedAt = Date.now();
            const result = await callProviderForReviewWithFailover(providerFailoverState, verifierPrompt, {
              deadline,
              modelPhase: 'verifier',
              reviewModelConfig,
              unavailableModels,
              modelDecisionContext,
              onRetry: (retryMeta) => {
                recordProviderRetry(reviewTiming, retryMeta);
                emitHeartbeat('provider_retry');
              },
              reviewTiming,
            });
            const verifierProviderMs = Date.now() - verifierStartedAt;
            recordProviderTiming(reviewTiming, {
              scope: 'verifier',
              chunkIndex: Number(verifierMeta?.ordinal || 1),
              totalChunks: Number(verifierMeta?.maxFindings || REVIEW_TWO_PASS_VERIFIER_MAX_FINDINGS),
              fileCount: reviewFiles.length,
              diffChars: verifierDiff.length,
              promptChars: verifierPrompt.length,
              promptBuildMs: 0,
              providerMs: verifierProviderMs,
            });
            if (result?.providerData) {
              selectedProviderData = result.providerData;
            }
            markModelUsed('verifier', result?.modelUsed);
            tokenUsage.input += Math.max(0, Number(result?.tokensUsed?.input || 0));
            tokenUsage.output += Math.max(0, Number(result?.tokensUsed?.output || 0));
            return parseHighRiskVerifierDecision(result?.text || '');
          }
        : null,
    });
    const corroborationSourceEvaluator = createCorroborationSourceEvaluator({
      verificationStatus: branchVerificationStatus,
      linterFindings: getLinterCorroborationFindings(linterPrePass),
    });
    reviewResult = applyCorroborationPolicyToReview(reviewResult, {
      enabled: REVIEW_CORROBORATION_ENABLED,
      allowGroundedFallback: REVIEW_CORROBORATION_ALLOW_GROUNDED_FALLBACK,
      downgradeOnUnsupported: REVIEW_CORROBORATION_DOWNGRADE_UNSUPPORTED,
      sourceEvaluator: corroborationSourceEvaluator,
    });
    // Merge standalone deterministic findings
    reviewResult = mergePrePassFindingsIntoReview(reviewResult, linterPrePass);
    reviewResult = await applyOutcomeSuppressionPolicyToReview(reviewResult, {
      projectId: br.projectId || null,
      providerType: selectedProviderData?.providerType || null,
      providerModel: selectedProviderData?.providerModel || null,
      enabled: REVIEW_OUTCOME_SUPPRESSION_ENABLED,
      minSamples: REVIEW_OUTCOME_SUPPRESSION_MIN_SAMPLES,
      minDismissedRate: REVIEW_OUTCOME_SUPPRESSION_MIN_DISMISSED_RATE,
      maxPerRun: REVIEW_OUTCOME_SUPPRESSION_MAX_PER_RUN,
      maxKeys: REVIEW_OUTCOME_SUPPRESSION_MAX_KEYS,
      maxRows: REVIEW_OUTCOME_SUPPRESSION_MAX_ROWS,
      maxRowsPerKey: REVIEW_OUTCOME_SUPPRESSION_MAX_ROWS_PER_KEY,
    });
    normalizePrecisionIssueCounters(reviewResult);
    assignReviewTier(reviewResult);

    // Enrich with metadata
    const selectedProviderIdentity = normalizeProviderIdentity(selectedProviderData);
    const routingDecisionContext = buildRoutingDecisionContext({
      files: reviewFiles,
      riskFlags: {
        largeBlastRadius: totalFilesForCoverage > FOCUSED_REVIEW_TRIGGER_FILE_COUNT,
      },
      riskLevel: reviewResult?.riskLevel || null,
      fallbackFileCount: reviewFiles.length,
      focusedReview: isFocusedReview,
      projectId: br.projectId || null,
      projectPath,
      reviewType: 'branch_review',
      reviewId: branchReviewId,
      branchName: br.branchName || null,
      baseBranch: br.baseBranch || null,
      headSha: br.headSha || null,
      mergeBaseSha: reviewDiffBaseSha || null,
    });
    const triageResolution = resolveEffectiveReviewModel(
      selectedProviderData,
      'triage',
      reviewModelConfig,
      routingDecisionContext
    );
    const reviewResolution = resolveEffectiveReviewModel(
      selectedProviderData,
      'review',
      reviewModelConfig,
      routingDecisionContext
    );
    const synthesisResolution = resolveEffectiveReviewModel(
      selectedProviderData,
      'synthesis',
      reviewModelConfig,
      routingDecisionContext
    );
    const effectiveReviewModel = modelsUsed.review || reviewResolution.model || selectedProviderIdentity.providerModel;
    markModelUsed('triage', triageResolution.model);
    markModelUsed('review', effectiveReviewModel);
    markModelUsed('synthesis', synthesisResolution.model);
    if (!reviewResult.stats || typeof reviewResult.stats !== 'object') {
      reviewResult.stats = {
        filesAnalyzed: reviewFiles.length,
        totalAdditions: reviewScopeTotalAdditions,
        totalDeletions: reviewScopeTotalDeletions,
        estimatedComplexity: 'moderate',
      };
    }
    reviewResult.stats.reviewModelStrategy = normalizeReviewModelStrategy(reviewModelConfig.strategy);
    reviewResult.stats.reviewModelEffectiveStrategy =
      normalizeReviewModelStrategy(reviewResolution.effectiveStrategy || reviewResolution.strategy);
    reviewResult.stats.reviewModelPolicyVersion =
      reviewResolution.policyVersion || REVIEW_MODEL_ROUTING_POLICY_VERSION;
    reviewResult.stats.reviewModelDecisionInputs = {
      ...reviewResolution.decisionInputs,
    };
    reviewResult.stats.reviewModelDecisionReason = reviewResolution.decisionReason || null;
    reviewResult.stats.reviewModelFallbackReason = reviewResolution.fallbackReason || null;
    reviewResult.stats.reviewModelBudgetClass = reviewResolution.budgetClass || 'balanced';
    reviewResult.stats.reviewModelThresholdProfile = reviewResolution.thresholdProfile || null;
    reviewResult.stats.reviewModelRollout = {
      mode: reviewResolution.rollout?.mode || DEFAULT_REVIEW_MODEL_ROLLOUT.mode,
      enabled: Boolean(reviewResolution.rollout?.enabled),
      reason: reviewResolution.rollout?.reason || null,
      canaryPercent: Number(reviewResolution.rollout?.canaryPercent || 0),
      canaryBucket: Number(reviewResolution.rollout?.canaryBucket || 0),
      allowlistEnabled: Boolean(reviewResolution.rollout?.allowlistEnabled),
      allowlistMatched: Boolean(reviewResolution.rollout?.allowlistMatched),
      gate: {
        status: reviewResolution.rollout?.gate?.status || DEFAULT_REVIEW_MODEL_ROLLOUT.gate.status,
        reasonCodes: normalizeReasonCodeList(reviewResolution.rollout?.gate?.reasonCodes || [], 20),
        source: reviewResolution.rollout?.gate?.source || DEFAULT_REVIEW_MODEL_ROLLOUT.gate.source,
        evaluatedAt: reviewResolution.rollout?.gate?.evaluatedAt || null,
      },
    };
    reviewResult.stats.modelsUsed = {
      ...modelsUsed,
    };
    reviewResult.stats.modelsChosenByPhase = {
      triage: triageResolution.model || null,
      review: effectiveReviewModel || null,
      synthesis: synthesisResolution.model || null,
      verifier: modelsUsed.verifier || null,
    };
    reviewResult.stats.phaseTimingsMs = {
      triage: 0,
      review: Math.max(0, Number(reviewTiming.providerMs) || 0),
      synthesis: 0,
      verifier: 0,
    };
    // Merge partial agentic result with non-agentic followup when applicable
    if (agenticFallbackMeta?._partialMergeSource) {
      const agenticReview = agenticFallbackMeta._partialMergeSource;
      const agenticTokens = agenticFallbackMeta._partialMergeTokens || { input: 0, output: 0 };
      const followupTokens = tokenUsage || { input: 0, output: 0 };

      const mergedAggregate = aggregateChunkReviews([
        { review: agenticReview, tokensUsed: agenticTokens },
        { review: reviewResult, tokensUsed: followupTokens },
      ], {
        fallbackSummary: reviewResult.summary || agenticReview.summary || '',
        fileCount: focusedSelectionInput.length,
        totalFileCount: focusedSelectionInput.length,
        focusedFileCount: focusedSelectionInput.length,
        omittedFileCount: 0,
        filePaths: focusedSelectionInput.map((entry) => entry.path),
        totalAdditions: reviewScopeTotalAdditions,
        totalDeletions: reviewScopeTotalDeletions,
        reviewPolicy,
      });
      reviewResult = mergedAggregate.review;
      tokenUsage = mergedAggregate.tokensUsed;
      reviewResult.stats.partialAgenticMerge = true;
      reviewResult.stats.partialAgenticUncoveredFiles = agenticFallbackMeta._partialUncoveredEntries?.length || 0;
      // Clean up internal fields before persisting
      delete agenticFallbackMeta._partialMergeSource;
      delete agenticFallbackMeta._partialMergeTokens;
      delete agenticFallbackMeta._partialUncoveredEntries;
    }

    if (agenticFallbackMeta) {
      reviewResult.stats.agenticFallback = {
        ...agenticFallbackMeta,
      };
    }

    const fullResult = {
      ...reviewResult,
      provider: {
        type: selectedProviderIdentity.providerType,
        model: effectiveReviewModel,
      },
      tokensUsed: tokenUsage || { input: 0, output: 0 },
      reviewedAt: new Date().toISOString(),
      timing: finalizeReviewTiming(reviewTiming, 'success'),
    };
    const costSnapshot = attachReviewCostMetadata(fullResult, {
      providerType: selectedProviderIdentity.providerType,
      model: effectiveReviewModel,
      tokensUsed: fullResult.tokensUsed,
      providerNativeCost: toNumberOrNull(fullResult?.stats?.agenticCostUsd),
    });
    applyReviewProfileStats(fullResult, {
      reviewProfile,
      shapedScopeTelemetry,
    });
    applyReviewPolicyStats(fullResult, { reviewPolicy });
    applyDiffScopeMetadata(fullResult, diffScope);
    normalizePrecisionIssueCounters(fullResult);
    applyTimingSnapshotToReviewStats(fullResult, fullResult.timing);
    fullResult.stats.reviewModelGate = evaluateReviewRunGate(fullResult);
    logReviewTiming(fullResult.timing);

    if (skippedCount > 0) {
      fullResult.summary = `${fullResult.summary} (${skippedCount} lock/binary file${skippedCount === 1 ? '' : 's'} excluded from review.)`;
    }
    const includeCount = requestedScope.includePatterns.length;
    const scopedExcludeCount = requestedScope.excludePatterns.length;
    const globalExcludeCount = globalExcludePatterns.length;
    const hasScopeMetadata =
      includeCount > 0 ||
      scopedExcludeCount > 0 ||
      globalExcludeCount > 0 ||
      requestedScope.applyGlobalIgnorePatterns === false;
    if (hasScopeMetadata) {
      const labels = [];
      if (includeCount > 0) labels.push(`include ${includeCount}`);
      if (scopedExcludeCount > 0) labels.push(`exclude ${scopedExcludeCount} scoped`);
      if (requestedScope.applyGlobalIgnorePatterns) {
        labels.push(`global ignore ${globalExcludeCount}`);
      } else {
        labels.push('global ignore off');
      }
      fullResult.summary = `${fullResult.summary} (Scope: ${labels.join(' • ')})`;
    }
    await attachPreviousUnresolvedBranchFindings({
      branchReviewId,
      projectId: br.projectId,
      previousReview: br.reviewJson,
      nextReview: fullResult,
      previousHeadSha: br.reviewHeadSha || br.headSha || null,
    });
    Object.assign(fullResult, assignReviewFindingIds(fullResult, {
      previousReview: br.reviewJson,
    }));

    // Save to branch review
    const terminalReviewError = derivePersistedReviewErrorFromResult(fullResult);
    await persistBranchReviewTerminalState(branchReviewId, {
      reviewStatus: 'reviewed',
      reviewRiskLevel: fullResult.riskLevel,
      reviewSummary: fullResult.summary,
      reviewJson: JSON.stringify(fullResult),
      reviewError: terminalReviewError,
      reviewBaseBranch: br.baseBranch || null,
      // Keep storing the branch merge-base in the first-class column. Delta
      // diff-base lineage is persisted separately in reviewJson.stats.diffBaseSha.
      reviewMergeBaseSha: br.mergeBaseSha || null,
      reviewForkPointSha: br.forkPointSha || null,
      reviewHeadSha: br.headSha || null,
      reviewedAt: fullResult.reviewedAt || new Date().toISOString(),
    });

    // Record token usage
    try {
      await usageService.recordUsage({
        projectId: br.projectId || null,
        changesetId: null,
        reviewType: 'branch_review',
        reviewId: branchReviewId,
        providerType: selectedProviderIdentity.providerType,
        model: effectiveReviewModel,
        inputTokens: fullResult.tokensUsed.input,
        outputTokens: fullResult.tokensUsed.output,
        providerNativeCost: costSnapshot?.providerNativeCost ?? null,
      });
    } catch (usageErr) {
      console.error('Failed to record usage:', usageErr.message);
    }

    return fullResult;
  } catch (error) {
    reviewTiming.failureClass = classifyProviderError(error);
    const failureTiming = finalizeReviewTiming(reviewTiming, 'failed', reviewTiming.failureClass);
    logReviewTiming(failureTiming);
    const persistedReviewError = buildPersistedReviewErrorMessage(error, failureTiming);
    error.persistedReviewError = persistedReviewError;
    // Update status to failed
    await persistBranchReviewTerminalState(branchReviewId, {
      reviewStatus: 'failed',
      reviewError: persistedReviewError,
    });
    throw error;
  } finally {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    deadline.clear();
  }
}


// ── PR Review pipeline ───────────────────────────────────────────────────────

/**
 * Execute a review on a GitHub PR.
 * Fetches files from GitHub API, builds diff, and runs through review pipeline.
 * `options.reviewMode` accepts:
 * - `auto` / `full` for normal PR review diff scoping
 * - `agentic_discovery` for the terminal-like discovery-first PR mode
 */
async function reviewPrReview(projectId, prReviewId, options = {}) {
  const externalSignal = options?.externalSignal || null;
  const onHeartbeat = typeof options?.onHeartbeat === 'function' ? options.onHeartbeat : null;
  const onProgressCheckpoint = typeof options?.onProgressCheckpoint === 'function'
    ? options.onProgressCheckpoint
    : null;
  const emitHeartbeat = (stage = 'running') => {
    if (!onHeartbeat) return;
    onHeartbeat({ stage, reviewType: 'pr_review', reviewId: prReviewId, ts: Date.now() });
  };

  // Get review-specific provider preference, then build failover chain
  const reviewCtx3 = typeof providerService.getContextActiveProvider === 'function'
    ? await providerService.getContextActiveProvider('review')
    : null;
  const providerCandidates = typeof providerService.getReviewProviderCandidatesWithKeys === 'function'
    ? await providerService.getReviewProviderCandidatesWithKeys({
        maxCandidates: REVIEW_PROVIDER_FAILOVER_MAX_CANDIDATES,
        preferredProviderId: reviewCtx3?.providerId || null,
      })
    : [];
  const fallbackActiveProvider = providerCandidates.length === 0
    ? await providerService.getActiveProviderWithKey()
    : null;
  if (fallbackActiveProvider) providerCandidates.push(fallbackActiveProvider);
  const providerData = providerCandidates[0] || null;
  if (!providerData) {
    throw new Error('No active AI provider configured. Add an API key in Settings → AI Provider.');
  }
  const policySource = normalizeReviewPolicySource(options.policySource, 'trusted');
  const unavailableModels = new Set();
  const modelsUsed = {};
  const markModelUsed = (phase, model) => {
    if (!REVIEW_MODEL_PHASES.includes(phase)) return;
    if (typeof model !== 'string' || !model.trim()) return;
    modelsUsed[phase] = model.trim();
  };
  let selectedProviderData = providerData;
  const providerState = { selectedProviderData };
  const providerFailoverState = createProviderFailoverState(providerCandidates);

  // Load PR review
  const pr = await prReviewService.getById(prReviewId);
  if (!pr) throw new Error('PR review not found');
  if (pr.reviewStatus === 'reviewed' && !options.force) return null;

  const { installationId, owner, repo, projectPath = null } = options;
  if (!installationId || !owner || !repo) {
    throw new Error('Missing GitHub connection info (installationId, owner, repo)');
  }

  let reviewModelConfig = null;
  let executionModeOrder = null;
  try {
    reviewModelConfig = resolveReviewModelConfigOverride(
      await loadReviewSettingOrThrow(
        () => getGlobalReviewModelConfig(),
        'PR review'
      ),
      {
        reviewModelStrategy: options.reviewModelStrategy,
        reviewModelCustom: options.reviewModelCustom,
        reviewModelAdaptive: options.reviewModelAdaptive,
        reviewModelRollout: options.reviewModelRollout,
      }
    );
    executionModeOrder = await loadReviewSettingOrThrow(
      () => getExecutionModeOrder(),
      'PR review'
    );
  } catch (error) {
    await persistPreflightSettingsFailure(
      async (reviewError) => prReviewService.updateReview(prReviewId, {
        review_status: 'failed',
        review_error: reviewError,
      }),
      error
    );
  }

  const [prCommits, rawGitHubChecks, prDetail, prReviewThreads] = await Promise.all([
    githubService.getPullRequestCommits(installationId, owner, repo, pr.githubPrNumber).catch(() => []),
    pr.headSha
      ? githubService.getCommitCombinedStatus(installationId, owner, repo, pr.headSha).catch(() => null)
      : Promise.resolve(null),
    githubService.getPullRequestDetail(installationId, owner, repo, pr.githubPrNumber).catch(() => null),
    githubService.getPullRequestReviewThreads(installationId, owner, repo, pr.githubPrNumber).catch(() => []),
  ]);
  const baseReviewProfile = await resolveReviewProjectProfile({ projectPath });
  const effectivePrReviewMode = resolveEffectivePrReviewRequestedMode(options.reviewMode, {
    reviewProfile: baseReviewProfile,
    projectPath,
    providerData,
    executionModeOrder,
    fileCount: pr.fileCount,
    totalAdditions: pr.totalAdditions,
    totalDeletions: pr.totalDeletions,
  });
  const prPipelineMode = normalizePrReviewPipelineMode(effectivePrReviewMode);
  const diffScopeReviewMode = options.forceFullScope === true ? 'full' : effectivePrReviewMode;
  let diffScope = await resolvePrReviewDiffScope(projectPath, pr, {
    headRef: pr.headSha || null,
    reviewMode: diffScopeReviewMode,
    prCommits,
  });
  if (diffScope.skipReview) {
    const reusedResult = clonePersistedReviewResult(pr.reviewJson);
    if (reusedResult) {
      diffScope.diffScopeCommitCount = 0;
      applyDiffScopeMetadata(reusedResult, diffScope);
      reusedResult.stats = {
        ...(reusedResult.stats && typeof reusedResult.stats === 'object' ? reusedResult.stats : {}),
        prPipelineMode,
        incrementalSkipped: true,
        incrementalSkippedReason: 'no_unreviewed_commits',
        diffScopeCommitCount: 0,
      };
      const reviewedAt = createUpdatedReviewedAt(pr.reviewedAt || reusedResult.reviewedAt || null);
      await persistPrReviewTerminalState(prReviewId, {
        reviewStatus: 'reviewed',
        reviewRiskLevel: reusedResult.riskLevel ?? pr.reviewRiskLevel ?? null,
        reviewSummary: reusedResult.summary ?? pr.reviewSummary ?? null,
        reviewJson: JSON.stringify(reusedResult),
        reviewError: null,
        reviewHeadSha: pr.headSha || pr.reviewHeadSha || null,
        reviewedAt,
      });
      reusedResult.reviewedAt = reviewedAt;
      return reusedResult;
    }
    console.warn(
      `[ReviewService] skipReview was requested for PR review ${prReviewId}, but no persisted review payload was available; continuing with a fresh review.`
    );
  }

  // Update status only after the run is accepted.
  await prReviewService.updateReview(prReviewId, { review_status: 'reviewing', review_error: null });
  const reviewTiming = createReviewTiming('pr_review', prReviewId);
  const isCliAgenticPrimary = shouldUseCliAgenticFastPath({
    providerData,
    executionModeOrder,
    reviewType: 'pr_review',
    requestedMode: effectivePrReviewMode,
  });
  const reviewExecutionContext = { reviewExecutionMode: isCliAgenticPrimary ? 'cli-agentic' : null };
  reviewTiming.providerMode = resolveProviderExecutionMode(providerData, reviewExecutionContext);
  setProviderCandidates(
    reviewTiming,
    providerFailoverState.candidates,
    (candidate) => resolveProviderExecutionMode(candidate, reviewExecutionContext)
  );
  const preEstimatedAgenticTier = isCliAgenticPrimary
    ? resolveAgenticTier(Number(pr.fileCount) || 0)
    : null;
  const deadlineBudgetMs = isCliAgenticPrimary
    ? (preEstimatedAgenticTier === 'large'
      ? REVIEW_TOTAL_DEADLINE_CLI_AGENTIC_LARGE_MS
      : REVIEW_TOTAL_DEADLINE_CLI_AGENTIC_MS)
    : REVIEW_TOTAL_DEADLINE_MS;
  const deadline = createReviewDeadline(externalSignal, deadlineBudgetMs);
  let progressReviewModelDecision = resolveEffectiveReviewModel(
    providerData,
    'review',
    reviewModelConfig,
    {
      fallbackFileCount: Number(pr.fileCount) || 0,
      projectId: pr.projectId || null,
      reviewType: 'pr_review',
      reviewId: prReviewId,
      branchName: pr.headRef || null,
      baseBranch: pr.baseRef || null,
      headSha: pr.headSha || null,
      projectPath,
    }
  );
  const heartbeatInterval = onHeartbeat
    ? setInterval(() => emitHeartbeat('running'), REVIEW_PROVIDER_HEARTBEAT_MS)
    : null;
  if (typeof heartbeatInterval?.unref === 'function') heartbeatInterval.unref();
  const reviewProgressStartedAt = Date.now();
  const getReviewProgressElapsedSeconds = () => Math.max(0, Math.floor((Date.now() - reviewProgressStartedAt) / 1000));
  let progressEffectiveReviewFiles = Math.max(0, Number(pr.fileCount || 0) || 0);
  let progressScopeMetadata = null;

  const emitProgress = (payload = {}) => {
    emitHeartbeat(payload?.phase || 'progress');
    const elapsedSeconds = getReviewProgressElapsedSeconds();
    const checkpoint = normalizeQueueProgress({
      reviewModel: progressReviewModelDecision.model || providerData?.provider?.model || null,
      reviewModelStrategy: normalizeReviewModelStrategy(reviewModelConfig.strategy),
      reviewModelEffectiveStrategy: normalizeReviewModelStrategy(
        progressReviewModelDecision.effectiveStrategy || progressReviewModelDecision.strategy || reviewModelConfig.strategy
      ),
      ...(progressScopeMetadata || {}),
      ...payload,
      prRequestedMode: normalizePrReviewRequestedMode(options.reviewMode),
      prEffectiveMode: effectivePrReviewMode,
      prPipelineMode,
      totalPrFiles: Math.max(0, Number(pr.fileCount || 0) || 0),
      effectiveReviewFiles: Math.max(0, Number(progressEffectiveReviewFiles || 0) || 0),
      phase: payload?.phase || 'running',
      elapsedSeconds,
    }, payload?.phase || 'running');
    reviewEvents.emit('pr-review-progress', {
      projectId: pr.projectId,
      prReviewId,
      ...checkpoint,
    });
    if (onProgressCheckpoint) onProgressCheckpoint(checkpoint);
  };

  try {
    emitHeartbeat('starting');
    const projectRecord = pr.projectId ? await getProjectById(pr.projectId).catch(() => null) : null;
    const globalIgnorePatterns = await loadReviewSettingOrThrow(
      () => getGlobalReviewIgnorePatterns(),
      'PR review'
    );
    const qualityMode = resolveReviewQualityMode(options.qualityMode);
    let reviewDiffBaseSha = diffScope.diffBaseSha || pr.baseSha || '';
    let reviewDiffHeadSha = diffScope.diffHeadSha || pr.headSha || 'HEAD';
    const generatedProjectPolicy = await ensureGeneratedProjectReviewPolicy(projectRecord);
    const reviewPolicy = await resolveEffectiveReviewPolicy({
      projectPath,
      reviewType: 'pr_review',
      reviewProfile: baseReviewProfile,
      baseBranch: pr.baseBranch || null,
      baseSha: reviewDiffBaseSha || pr.baseSha || null,
      policySource,
      generatedProjectPolicy,
    });
    // Pre-load diff stats from the resolved diff scope (delta or full) so the
    // structural-skip threshold sees the *effective* PR review scope, not the
    // raw pr.fileCount which may reflect the entire PR even in delta/incremental
    // mode. Falls back to pr.fileCount when the loader is unavailable or fails.
    const upfrontPrDiffStats = (typeof diffScope.diffStatLoader === 'function'
      && projectPath
      && reviewDiffBaseSha)
      ? await Promise.resolve(
          diffScope.diffStatLoader(projectPath, reviewDiffBaseSha, reviewDiffHeadSha || 'HEAD')
        ).catch(() => null)
      : null;
    const policyTotalFiles = Math.max(
      0,
      Number(upfrontPrDiffStats?.fileCount ?? pr.fileCount ?? 0) || 0
    );
    const reviewProfile = applyReviewPolicyToReviewProfile(baseReviewProfile, reviewPolicy, {
      totalFiles: policyTotalFiles,
    });
    const deltaRangeCommitsFromPr = diffScope.mode === 'delta'
      ? slicePullRequestCommitsSince(prCommits, diffScope.diffBaseSha, diffScope.diffHeadSha)
      : [];
    let prRangeCommits = (
      projectPath
      && reviewDiffBaseSha
      && reviewDiffHeadSha
      && typeof gitService.getCommitsBetween === 'function'
    )
      ? await gitService.getCommitsBetween(projectPath, reviewDiffBaseSha, reviewDiffHeadSha).catch(() => [])
      : (diffScope.mode === 'delta'
          ? deltaRangeCommitsFromPr.map((entry) => ({
              hash: entry?.sha || null,
              message: entry?.message || '',
            }))
          : prCommits.map((entry) => ({
              hash: entry?.sha || null,
              message: entry?.message || '',
            })));
    progressScopeMetadata = {
      diffScopeMode: diffScope.mode,
      diffScopeCommitCount: Math.max(0, Number(prRangeCommits.length || 0)),
      diffBaseSha: diffScope.diffBaseSha || null,
      diffHeadSha: diffScope.diffHeadSha || null,
    };
    diffScope.diffScopeCommitCount = progressScopeMetadata.diffScopeCommitCount;
    let reviewScopeFileCount = Math.max(0, Number(pr.fileCount || 0) || 0);
    let reviewScopeTotalAdditions = Math.max(0, Number(pr.totalAdditions || 0) || 0);
    let reviewScopeTotalDeletions = Math.max(0, Number(pr.totalDeletions || 0) || 0);
    let reviewableNameStatus = [];
    let focusedSelectionInput = [];
    let shapedScopeTelemetry = null;
    let agenticFallbackMeta = null;
    progressEffectiveReviewFiles = reviewScopeFileCount;

    if (isCliAgenticPrimary && projectPath && prPipelineMode === 'agentic_discovery') {
      const prScope = await preparePrReviewScope({
        projectPath,
        mergeBaseSha: reviewDiffBaseSha,
        headSha: reviewDiffHeadSha,
        ignorePatterns: globalIgnorePatterns,
        reviewProfile,
        nameStatusLoader: diffScope.nameStatusLoader,
        diffStatLoader: diffScope.diffStatLoader,
      });
      reviewableNameStatus = prScope.reviewableNameStatus;
      focusedSelectionInput = prScope.focusedSelectionInput;
      shapedScopeTelemetry = prScope.shapedScopeTelemetry;
      reviewScopeFileCount = Math.max(0, Number(prScope.diffStats?.fileCount ?? reviewScopeFileCount) || 0);
      reviewScopeTotalAdditions = Math.max(
        0,
        Number(prScope.diffStats?.totalAdditions ?? reviewScopeTotalAdditions) || 0
      );
      reviewScopeTotalDeletions = Math.max(
        0,
        Number(prScope.diffStats?.totalDeletions ?? reviewScopeTotalDeletions) || 0
      );
      progressEffectiveReviewFiles = reviewScopeFileCount;
      progressScopeMetadata.diffScopeCommitCount = Math.max(
        progressScopeMetadata.diffScopeCommitCount,
        Math.max(0, Number(prScope.diffStats?.commitCount || 0))
      );
      diffScope.diffScopeCommitCount = progressScopeMetadata.diffScopeCommitCount;

      const agenticOutcome = await runCliAgenticReviewFastPath({
        reviewType: 'pr_review',
        reviewId: prReviewId,
        projectId: pr.projectId || projectId || null,
        projectPath,
        providerData,
        providerFailoverState,
        reviewModelConfig,
        unavailableModels,
        executionModeOrder,
        deadline,
        reviewTiming,
        emitProgress,
        emitHeartbeat,
        markModelUsed,
        fileHintsInput: focusedSelectionInput,
        ignorePatterns: globalIgnorePatterns,
        reviewProfile,
        reviewPolicy,
        shapedScopeTelemetry,
        branchName: pr.headBranch || '',
        baseBranch: pr.baseBranch || 'main',
        mergeBaseSha: reviewDiffBaseSha,
        headSha: reviewDiffHeadSha,
        totalAdditions: reviewScopeTotalAdditions,
        totalDeletions: reviewScopeTotalDeletions,
        qualityMode,
        diffLoader: diffScope.fullDiffLoader,
        prTitle: pr.title || '',
        prBody: pr.body || '',
        prCommitsSummary: Array.isArray(prCommits)
          ? prCommits
            .map((entry) => String(entry?.message || '').trim())
            .filter(Boolean)
            .slice(0, 12)
          : [],
        discoveryMode: true,
        diffMode: diffScope.mode || 'full',
        codegraphMcpEnabledOverride: typeof options.codegraphMcpEnabledOverride === 'boolean'
          ? options.codegraphMcpEnabledOverride
          : null,
      });
      selectedProviderData = agenticOutcome.selectedProviderData || selectedProviderData;
      agenticFallbackMeta = agenticOutcome.fallbackMeta || null;

      if (agenticOutcome.accepted && agenticOutcome.reviewResult) {
        const selectedProviderIdentity = normalizeProviderIdentity(selectedProviderData);
        const effectiveReviewModel = modelsUsed.review || selectedProviderIdentity.providerModel || 'unknown';
        const fullResult = applyPrCommentEligibilityPolicy({
          ...agenticOutcome.reviewResult,
          provider: {
            type: selectedProviderIdentity.providerType,
            model: effectiveReviewModel,
          },
          tokensUsed: agenticOutcome.tokenUsage || { input: 0, output: 0 },
          reviewedAt: new Date().toISOString(),
          timing: finalizeReviewTiming(reviewTiming, 'success'),
        });
        const costSnapshot = attachReviewCostMetadata(fullResult, {
          providerType: selectedProviderIdentity.providerType,
          model: effectiveReviewModel,
          tokensUsed: fullResult.tokensUsed,
          providerNativeCost: toNumberOrNull(fullResult?.stats?.agenticCostUsd),
        });
        applyReviewProfileStats(fullResult, {
          reviewProfile,
          shapedScopeTelemetry,
        });
        applyReviewPolicyStats(fullResult, { reviewPolicy });
        applyDiffScopeMetadata(fullResult, diffScope);
        fullResult.stats = {
          ...(fullResult.stats && typeof fullResult.stats === 'object' ? fullResult.stats : {}),
          prRequestedMode: normalizePrReviewRequestedMode(options.reviewMode),
          prEffectiveMode: effectivePrReviewMode,
          prPipelineMode,
        };
        normalizePrecisionIssueCounters(fullResult);
        applyTimingSnapshotToReviewStats(fullResult, fullResult.timing);
        logReviewTiming(fullResult.timing);
        Object.assign(fullResult, assignReviewFindingIds(fullResult, {
          previousReview: pr.reviewJson,
        }));

        const terminalReviewError = derivePersistedReviewErrorFromResult(fullResult);
        await persistPrReviewTerminalState(prReviewId, {
          reviewStatus: 'reviewed',
          reviewRiskLevel: fullResult.riskLevel,
          reviewSummary: fullResult.summary,
          reviewJson: JSON.stringify(fullResult),
          reviewError: terminalReviewError,
          reviewHeadSha: pr.headSha,
          reviewedAt: fullResult.reviewedAt,
        });

        try {
          await usageService.recordUsage({
            projectId: pr.projectId || null,
            changesetId: null,
            reviewType: 'pr_review',
            reviewId: prReviewId,
            providerType: selectedProviderIdentity.providerType,
            model: effectiveReviewModel,
            inputTokens: fullResult.tokensUsed.input,
            outputTokens: fullResult.tokensUsed.output,
            providerNativeCost: costSnapshot?.providerNativeCost ?? null,
          });
        } catch (usageErr) {
          console.error('Failed to record PR review usage:', usageErr.message);
        }

        return fullResult;
      }
    }

    if (reviewableNameStatus.length === 0) {
      emitProgress({
        phase: 'fetching_files',
        totalFiles: reviewScopeFileCount || pr.fileCount || 0,
        ...progressScopeMetadata,
      });
      let ghFiles = [];
      let ghDiffStats = null;
      if (diffScope.mode === 'delta') {
        try {
          ghDiffStats = await githubService.getCompareFiles(
            installationId,
            owner,
            repo,
            reviewDiffBaseSha,
            reviewDiffHeadSha
          );
          if (ghDiffStats?.truncated) {
            throw new Error('delta compare scope truncated');
          }
          ghFiles = ghDiffStats.files || [];
        } catch (error) {
          const fallbackReason = ghDiffStats?.truncated
            ? 'delta_file_scope_truncated'
            : 'delta_file_scope_unavailable';
          console.warn(
            `[ReviewService] PR delta compare scope failed for ${prReviewId}, falling back to full PR scope:`,
            error.message
          );
          diffScope = {
            requestedMode: diffScope.requestedMode,
            mode: 'full',
            diffBaseSha: pr.baseSha || null,
            diffHeadSha: pr.headSha || null,
            branchMergeBaseSha: pr.baseSha || null,
            deltaEligible: false,
            deltaFallbackReason: fallbackReason,
            nameStatusLoader: gitService.getThreeDotDiffNameStatus.bind(gitService),
            diffStatLoader: gitService.getThreeDotDiffStats.bind(gitService),
            fullDiffLoader: gitService.getThreeDotFullDiff.bind(gitService),
          };
          reviewDiffBaseSha = diffScope.diffBaseSha || pr.baseSha || '';
          reviewDiffHeadSha = diffScope.diffHeadSha || pr.headSha || 'HEAD';
          ghDiffStats = null;
          prRangeCommits = prCommits.map((entry) => ({
            hash: entry?.sha || null,
            message: entry?.message || '',
          }));
          progressScopeMetadata = {
            diffScopeMode: 'full',
            diffScopeCommitCount: Math.max(0, Number(prCommits.length || 0)),
            diffBaseSha: reviewDiffBaseSha || null,
            diffHeadSha: reviewDiffHeadSha || null,
          };
          diffScope.diffScopeCommitCount = progressScopeMetadata.diffScopeCommitCount;
          ghFiles = await githubService.getPullRequestFiles(
            installationId,
            owner,
            repo,
            pr.githubPrNumber
          );
        }
      } else {
        ghFiles = await githubService.getPullRequestFiles(
          installationId,
          owner,
          repo,
          pr.githubPrNumber
        );
      }
      const prScope = await preparePrReviewScope({
        ghFiles,
        ignorePatterns: globalIgnorePatterns,
        reviewProfile,
      });
      reviewableNameStatus = prScope.reviewableNameStatus;
      focusedSelectionInput = prScope.focusedSelectionInput;
      shapedScopeTelemetry = prScope.shapedScopeTelemetry;
      reviewScopeFileCount = Math.max(
        0,
        Number(ghDiffStats?.fileCount ?? prScope.diffStats?.fileCount ?? reviewScopeFileCount) || 0
      );
      reviewScopeTotalAdditions = Math.max(
        0,
        Number(ghDiffStats?.totalAdditions ?? prScope.diffStats?.totalAdditions ?? reviewScopeTotalAdditions) || 0
      );
      reviewScopeTotalDeletions = Math.max(
        0,
        Number(ghDiffStats?.totalDeletions ?? prScope.diffStats?.totalDeletions ?? reviewScopeTotalDeletions) || 0
      );
    }

    const focusedDecisionContext = buildRoutingDecisionContext({
      files: focusedSelectionInput,
      riskFlags: {
        largeBlastRadius: focusedSelectionInput.length > LARGE_REVIEW_FILE_COUNT,
        hasGitHubCheckFailures: rawGitHubChecks?.state === 'failure',
      },
      diffChars: focusedSelectionInput.reduce(
        (sum, entry) => sum + (Number(entry.reviewSizeHint) || 0),
        0
      ),
      fallbackFileCount: focusedSelectionInput.length,
      focusedReview: false,
      projectId: pr.projectId || projectId || null,
      projectPath,
      reviewType: 'pr_review',
      reviewId: prReviewId,
      branchName: pr.headBranch || null,
      baseBranch: pr.baseBranch || null,
      headSha: reviewDiffHeadSha || pr.headSha || null,
      mergeBaseSha: reviewDiffBaseSha || pr.baseSha || null,
    });
    const focusedReviewResolution = resolveEffectiveReviewModel(
      providerData,
      'review',
      reviewModelConfig,
      focusedDecisionContext
    );
    progressReviewModelDecision = focusedReviewResolution || progressReviewModelDecision;
    const focusedBudget = deriveFocusedReviewBudgetConfig({
      files: focusedSelectionInput,
      providerData,
      reviewResolution: focusedReviewResolution,
      deadline,
    });
    let focusedSelection = selectFilesForFocusedReview(focusedSelectionInput, focusedBudget);

    if (agenticFallbackMeta?.mode === 'partial_followup') {
      const uncoveredPaths = new Set(
        (agenticFallbackMeta.uncoveredFiles || []).map((entry) => normalizePathForMatch(entry)).filter(Boolean)
      );
      const uncoveredEntries = focusedSelectionInput.filter(
        (entry) => reviewUnitIntersectsPathSet(entry, uncoveredPaths)
      );
      agenticFallbackMeta = {
        ...agenticFallbackMeta,
        mode: 'diff_followup',
        reason: 'insufficient_deep_coverage',
        // Consumed by the shared partial-agentic merge block after the
        // structured follow-up review result is available.
        _partialMergeSource: agenticFallbackMeta.agenticReviewResult,
        _partialMergeTokens: agenticFallbackMeta.agenticTokensUsed,
        _partialUncoveredEntries: uncoveredEntries,
      };
      focusedSelection = {
        mode: uncoveredEntries.length < focusedSelectionInput.length ? 'focused' : 'full',
        reviewFiles: uncoveredEntries,
        omittedFiles: focusedSelectionInput
          .filter((entry) => !reviewUnitIntersectsPathSet(entry, uncoveredPaths)),
        totalFiles: focusedSelectionInput.length,
      };
    }
    focusedSelection = coerceFocusedSelectionForAgenticFallback(
      focusedSelection,
      focusedSelectionInput,
      agenticFallbackMeta
    );
    let isFocusedReview = focusedSelection.mode === 'focused';
    let omittedFiles = focusedSelection.omittedFiles;
    const focusedCoveragePlanner = focusedSelection.planner || focusedBudget?.planner || null;
    const focusedPathSet = new Set(collectReviewUnitMemberPaths(focusedSelection.reviewFiles));
    const primaryEntriesToHydrate = isFocusedReview
      ? reviewableNameStatus.filter((entry) => focusedPathSet.has(normalizePathForMatch(entry.path)))
      : reviewableNameStatus;
    const fallbackEntriesToHydrate = isFocusedReview
      ? reviewableNameStatus.filter((entry) => !focusedPathSet.has(normalizePathForMatch(entry.path)))
      : [];
    const totalEntriesToHydrate = primaryEntriesToHydrate.length + fallbackEntriesToHydrate.length;
    progressEffectiveReviewFiles = reviewScopeFileCount;

    emitProgress({
      phase: 'hydrating_content',
      totalFiles: totalEntriesToHydrate,
      ...progressScopeMetadata,
    });

    // Hydrate before/after content with concurrency limit
    const PR_FILE_HYDRATE_CONCURRENCY = 6;
    const files = [];
    const hydrateEntries = async (entries) => {
      for (let i = 0; i < entries.length; i += PR_FILE_HYDRATE_CONCURRENCY) {
        const batch = entries.slice(i, i + PR_FILE_HYDRATE_CONCURRENCY);
        const batchResults = await Promise.allSettled(
          batch.map(async (f) => {
            let before = null;
            let after = null;
            const beforePath = f.oldPath || f.path;

            if (f.status !== 'A') {
              try {
                const data = await githubService.getRepositoryContents(
                  installationId, owner, repo, beforePath, reviewDiffBaseSha
                );
                if (data?.content) before = Buffer.from(data.content, 'base64').toString('utf-8');
              } catch { /* file didn't exist on base */ }
              if (before == null && projectPath && reviewDiffBaseSha) {
                before = await gitService.getFileAtRef(projectPath, reviewDiffBaseSha, beforePath);
              }
            }

            if (f.status !== 'D') {
              try {
                const data = await githubService.getRepositoryContents(
                  installationId, owner, repo, f.path, reviewDiffHeadSha
                );
                if (data?.content) after = Buffer.from(data.content, 'base64').toString('utf-8');
              } catch { /* file doesn't exist on head */ }
              if (after == null && projectPath && reviewDiffHeadSha) {
                after = await gitService.getFileAtRef(projectPath, reviewDiffHeadSha, f.path);
              }
            }

            return {
              path: f.path,
              oldPath: f.oldPath || null,
              before,
              after,
              language: f.path.split('.').pop() || '',
              status: f.status || 'M',
              patch: typeof f.patch === 'string' ? f.patch : null,
            };
          })
        );
        for (const result of batchResults) {
          if (result.status === 'fulfilled' && result.value) files.push(result.value);
        }
        emitProgress({
          phase: 'hydrating_content',
          filesCompleted: files.length,
          totalFiles: totalEntriesToHydrate,
          ...progressScopeMetadata,
        });
      }
    };
    await hydrateEntries(primaryEntriesToHydrate);
    if (files.length === 0 && isFocusedReview && fallbackEntriesToHydrate.length > 0) {
      console.warn(
        `[ReviewService] PR ${prReviewId} focused preselection yielded no reviewable hydrated files; retrying broader hydration scope`
      );
      await hydrateEntries(fallbackEntriesToHydrate);
      if (files.length > 0) {
        focusedSelection = {
          mode: 'full',
          reviewFiles: focusedSelectionInput,
          omittedFiles: [],
          totalFiles: focusedSelectionInput.length,
          planner: focusedCoveragePlanner,
        };
        isFocusedReview = false;
        omittedFiles = [];
      }
    }

    if (files.length === 0) {
      const emptyResult = {
        summary: 'No reviewable files found in this pull request.',
        riskLevel: 'low',
        recommendations: [],
        changeGroups: [],
        stats: { totalFiles: 0, additions: 0, deletions: 0 },
        tokensUsed: { input: 0, output: 0 },
        reviewedAt: new Date().toISOString(),
        timing: finalizeReviewTiming(reviewTiming, 'success'),
      };
      attachReviewCostMetadata(emptyResult, {
        providerType: selectedProviderIdentity.providerType,
        model: selectedProviderIdentity.providerModel || 'unknown',
        tokensUsed: emptyResult.tokensUsed,
      });
      applyReviewProfileStats(emptyResult, {
        reviewProfile,
        shapedScopeTelemetry,
      });
      applyReviewPolicyStats(emptyResult, { reviewPolicy });
      applyDiffScopeMetadata(emptyResult, diffScope);
      emptyResult.stats = {
        ...(emptyResult.stats && typeof emptyResult.stats === 'object' ? emptyResult.stats : {}),
        prRequestedMode: normalizePrReviewRequestedMode(options.reviewMode),
        prEffectiveMode: effectivePrReviewMode,
        prPipelineMode,
      };
      applyTimingSnapshotToReviewStats(emptyResult, emptyResult.timing);
      logReviewTiming(emptyResult.timing);
      await persistPrReviewTerminalState(prReviewId, {
        reviewStatus: 'reviewed',
        reviewRiskLevel: 'low',
        reviewSummary: emptyResult.summary,
        reviewJson: JSON.stringify(emptyResult),
        reviewHeadSha: pr.headSha,
        reviewedAt: emptyResult.reviewedAt,
      });
      return emptyResult;
    }

    emitProgress({
      phase: 'reviewing',
      totalFiles: files.length,
      ...progressScopeMetadata,
    });

    const prVerificationStatus = buildPrReviewVerificationStatus(rawGitHubChecks);
    const priorReviewSummary = diffScope.mode === 'delta'
      ? String(pr.reviewJson?.summary || pr.reviewSummary || '').trim()
      : '';
    const priorReviewFindings = diffScope.mode === 'delta'
      ? summarizePriorReviewFindings(pr.reviewJson)
      : [];
    const prCommitMessages = [
      pr.body ? `PR description: ${pr.body}` : null,
      ...(diffScope.mode === 'delta' ? deltaRangeCommitsFromPr : prCommits).map((entry) => entry?.message).filter(Boolean),
    ].filter(Boolean);
    const promptContextSignals = await collectPromptContextSignals(projectPath, {
      commitMessages: prCommitMessages,
      queuedCommitShas: [reviewDiffHeadSha, reviewDiffBaseSha].filter(Boolean),
      mergeBaseSha: reviewDiffBaseSha || null,
      headSha: reviewDiffHeadSha || null,
      rangeCommits: prRangeCommits,
      verificationStatus: prVerificationStatus,
      requestedReviewers: [
        ...(Array.isArray(prDetail?.requested_reviewers)
          ? prDetail.requested_reviewers.map((entry) => entry?.login)
          : []),
        ...(Array.isArray(prDetail?.requested_teams)
          ? prDetail.requested_teams.map((entry) => entry?.slug || entry?.name)
          : []),
      ],
      assignees: Array.isArray(prDetail?.assignees)
        ? prDetail.assignees.map((entry) => entry?.login)
        : (Array.isArray(pr.assignees) ? pr.assignees : []),
      reviewThreads: prReviewThreads,
      contextFiles: files,
      cacheProjectId: pr.projectId || null,
      reviewProfile: reviewProfile || null,
      sameHashOnly: REVIEW_PROMPT_CONTEXT_SAME_HASH_ONLY,
      allowGuardedCrossHashHints: REVIEW_PROMPT_CONTEXT_ALLOW_CROSS_HASH_HINTS,
    });

    // ── Linter pre-pass (PR review) ────────────────────────────────────
    const prDiffForLinter = generateDiffFromFiles(files);
    const linterPrePass = await runReviewLinterPrePass(projectPath, files, prDiffForLinter, {
      reviewPolicy: reviewPolicy || null,
      reviewProfile: reviewProfile || null,
      externalSignal: externalSignal || null,
    });
    await writeReviewDebugJson({
      projectId: pr.projectId || null,
      projectPath,
      reviewType: 'pr_review',
      reviewId: prReviewId,
    }, 'linter-prepass', linterPrePass);
    // ─────────────────────────────────────────────────────────────────────

    const metadataBase = {
      title: `PR #${pr.githubPrNumber}: ${pr.title || 'Untitled'}`,
      commitMessages: promptContextSignals.commitMessages,
      verificationStatus: promptContextSignals.verificationStatus,
      requestedReviewers: promptContextSignals.requestedReviewers,
      assignees: promptContextSignals.assignees,
      reviewThreads: promptContextSignals.reviewThreads,
      priorFindingHints: promptContextSignals.priorFindingHints,
      fileRiskContext: promptContextSignals.fileRiskContext,
      claudeConventions: promptContextSignals.claudeConventions,
      projectMetadata: promptContextSignals.projectMetadata,
      dismissedPatterns: promptContextSignals.dismissedPatterns,
      additionalPromptContextBlocks: promptContextSignals.additionalBlocks,
      linterFindings: getPromptLinterFindings(linterPrePass),
      queuedCommitShas: promptContextSignals.queuedCommitShas,
      promptContextBudgetChars: REVIEW_PROMPT_CONTEXT_BUDGET_CHARS,
      promptContextSameHashOnly: REVIEW_PROMPT_CONTEXT_SAME_HASH_ONLY,
      promptContextAllowCrossHashHints: REVIEW_PROMPT_CONTEXT_ALLOW_CROSS_HASH_HINTS,
      evidencePolicy: normalizeEvidencePolicyForReview(options.evidencePolicy),
      reviewProfile: buildReviewProfileStats(reviewProfile, null).reviewProfile,
      reviewPolicy,
      shapedScope: buildReviewProfileStats(null, shapedScopeTelemetry).shapedScope,
      fileCount: files.length,
      filePaths: files.map((file) => file.path),
      omittedFilesCount: omittedFiles.length,
      omittedFiles: isFocusedReview
        ? summarizeOmittedFilesForPrompt(omittedFiles, REVIEW_OMITTED_FILE_PROMPT_LIMIT, { reviewProfile })
        : [],
      totalAdditions: reviewScopeTotalAdditions,
      totalDeletions: reviewScopeTotalDeletions,
      qualityMode,
      diffScopeMode: diffScope.mode,
      diffScopeCommitCount: progressScopeMetadata.diffScopeCommitCount,
      diffBaseSha: diffScope.diffBaseSha || null,
      diffHeadSha: diffScope.diffHeadSha || null,
      priorReviewSummary,
      priorReviewFindings,
    };

    const riskFlags = {
      largeBlastRadius: focusedSelectionInput.length > LARGE_REVIEW_FILE_COUNT,
      hasGitHubCheckFailures: prVerificationStatus?.overallStatus === 'fail',
    };
    const preparedResult = await executeSharedPreparedReviewCore({
      contextType: 'pr_review',
      reviewId: prReviewId,
      projectId: pr.projectId || projectId || null,
      projectPath,
      reviewType: 'pr_review',
      providerData,
      providerState,
      providerFailoverState,
      reviewModelConfig,
      unavailableModels,
      modelsUsed,
      markModelUsed,
      reviewTiming,
      deadline,
      executionModeOrder,
      emitHeartbeat,
      emitProgress,
      reviewFiles: files,
      totalFilesForCoverage: isFocusedReview ? focusedSelectionInput.length : files.length,
      omittedFiles,
      focusedCoveragePlanner,
      isFocusedReview,
      focusedReviewResolution,
      metadataBase,
      riskFlags,
      totalAdditions: reviewScopeTotalAdditions,
      totalDeletions: reviewScopeTotalDeletions,
      verificationStatus: prVerificationStatus,
      linterPrePass,
      routeContext: {
        branchName: pr.headBranch || null,
        baseBranch: pr.baseBranch || null,
        headSha: reviewDiffHeadSha || pr.headSha || null,
        mergeBaseSha: reviewDiffBaseSha || pr.baseSha || null,
      },
      reviewExecutionMode: reviewExecutionContext.reviewExecutionMode,
    });

    selectedProviderData = providerState.selectedProviderData || selectedProviderData;
    const selectedProviderIdentity = normalizeProviderIdentity(selectedProviderData);
    const effectiveReviewModel = modelsUsed.review || selectedProviderIdentity.providerModel || 'unknown';
    const fullResult = applyPrCommentEligibilityPolicy({
      ...preparedResult.reviewResult,
      verificationStatus: prVerificationStatus,
      provider: {
        type: selectedProviderIdentity.providerType,
        model: effectiveReviewModel,
      },
      tokensUsed: preparedResult.tokenUsage || { input: 0, output: 0 },
      reviewedAt: new Date().toISOString(),
      timing: finalizeReviewTiming(reviewTiming, 'success'),
    });
    const costSnapshot = attachReviewCostMetadata(fullResult, {
      providerType: selectedProviderIdentity.providerType,
      model: effectiveReviewModel,
      tokensUsed: fullResult.tokensUsed,
      providerNativeCost: toNumberOrNull(fullResult?.stats?.agenticCostUsd),
    });
    applyReviewProfileStats(fullResult, {
      reviewProfile,
      shapedScopeTelemetry,
    });
    applyReviewPolicyStats(fullResult, { reviewPolicy });
    applyDiffScopeMetadata(fullResult, diffScope);
    fullResult.stats = fullResult.stats || {};
    fullResult.stats.prPipelineMode = prPipelineMode;
    fullResult.stats.prRequestedMode = normalizePrReviewRequestedMode(options.reviewMode);
    fullResult.stats.prEffectiveMode = effectivePrReviewMode;
    fullResult.stats.fileCount = Math.max(
      0,
      Number(fullResult.stats.fileCount ?? reviewScopeFileCount ?? files.length) || 0
    );
    fullResult.stats.totalAdditions = Math.max(
      0,
      Number(fullResult.stats.totalAdditions ?? reviewScopeTotalAdditions) || 0
    );
    fullResult.stats.totalDeletions = Math.max(
      0,
      Number(fullResult.stats.totalDeletions ?? reviewScopeTotalDeletions) || 0
    );
    Object.assign(fullResult, assignReviewFindingIds(fullResult, {
      previousReview: pr.reviewJson,
    }));
    applyTimingSnapshotToReviewStats(fullResult, fullResult.timing);
    logReviewTiming(fullResult.timing);

    const terminalReviewError = derivePersistedReviewErrorFromResult(fullResult);
    await persistPrReviewTerminalState(prReviewId, {
      reviewStatus: 'reviewed',
      reviewRiskLevel: fullResult.riskLevel,
      reviewSummary: fullResult.summary,
      reviewJson: JSON.stringify(fullResult),
      reviewError: terminalReviewError,
      reviewHeadSha: pr.headSha,
      reviewedAt: fullResult.reviewedAt,
    });

    // Record usage
    try {
      await usageService.recordUsage({
        projectId: pr.projectId || null,
        changesetId: null,
        reviewType: 'pr_review',
        reviewId: prReviewId,
        providerType: selectedProviderIdentity.providerType,
        model: effectiveReviewModel,
        inputTokens: fullResult.tokensUsed.input,
        outputTokens: fullResult.tokensUsed.output,
        providerNativeCost: costSnapshot?.providerNativeCost ?? null,
      });
    } catch (usageErr) {
      console.error('Failed to record PR review usage:', usageErr.message);
    }

    return fullResult;
  } catch (error) {
    reviewTiming.failureClass = classifyProviderError(error);
    const failureTiming = finalizeReviewTiming(reviewTiming, 'failed', reviewTiming.failureClass);
    logReviewTiming(failureTiming);
    const persistedReviewError = buildPersistedReviewErrorMessage(error, failureTiming);
    error.persistedReviewError = persistedReviewError;
    await persistPrReviewTerminalState(prReviewId, {
      reviewStatus: 'failed',
      reviewError: persistedReviewError,
    });
    throw error;
  } finally {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    deadline.clear();
  }
}

async function reviewWorkspaceReview(projectId, projectPath, workspaceReviewId, options = {}) {
  const externalSignal = options?.externalSignal || null;
  const onHeartbeat = typeof options?.onHeartbeat === 'function' ? options.onHeartbeat : null;
  const onProgressCheckpoint = typeof options?.onProgressCheckpoint === 'function'
    ? options.onProgressCheckpoint
    : null;
  const emitHeartbeat = (stage = 'running') => {
    if (!onHeartbeat) return;
    onHeartbeat({ stage, reviewType: 'workspace_review', reviewId: workspaceReviewId, ts: Date.now() });
  };

  const reviewCtx = typeof providerService.getContextActiveProvider === 'function'
    ? await providerService.getContextActiveProvider('review')
    : null;
  const providerCandidates = typeof providerService.getReviewProviderCandidatesWithKeys === 'function'
    ? await providerService.getReviewProviderCandidatesWithKeys({
        maxCandidates: REVIEW_PROVIDER_FAILOVER_MAX_CANDIDATES,
        preferredProviderId: reviewCtx?.providerId || null,
      })
    : [];
  const fallbackActiveProvider = providerCandidates.length === 0
    ? await providerService.getActiveProviderWithKey()
    : null;
  if (fallbackActiveProvider) providerCandidates.push(fallbackActiveProvider);
  const providerData = providerCandidates[0] || null;
  if (!providerData) {
    throw new Error('No active AI provider configured. Add an API key in Settings → AI Provider.');
  }

  const workspaceReview = await workspaceReviewService.getById(projectPath, workspaceReviewId, {
    projectId,
    baseBranch: options.baseBranch || null,
    includeContent: true,
  });
  if (!workspaceReview) {
    throw new Error('Workspace review not found');
  }

  const currentSnapshotMatchesPrevious =
    workspaceReview.reviewStatus === 'reviewed'
    && workspaceReview.reviewSnapshotKey
    && workspaceReview.snapshotKey
    && workspaceReview.reviewSnapshotKey === workspaceReview.snapshotKey;
  if (currentSnapshotMatchesPrevious && !options.force) {
    return workspaceReview.reviewJson || null;
  }

  let reviewModelConfig = null;
  let executionModeOrder = null;
  try {
    reviewModelConfig = await loadReviewSettingOrThrow(
      () => getGlobalReviewModelConfig(),
      'Workspace review'
    );
    executionModeOrder = await loadReviewSettingOrThrow(
      () => getExecutionModeOrder(),
      'Workspace review'
    );
  } catch (error) {
    await persistPreflightSettingsFailure(
      async (reviewError) => persistWorkspaceReviewTerminalState(projectPath, workspaceReviewId, {
        reviewStatus: 'failed',
        reviewError,
      }),
      error
    );
  }
  const policySource = normalizeReviewPolicySource(options.policySource, 'trusted');
  const unavailableModels = new Set();
  const modelsUsed = {};
  const markModelUsed = (phase, model) => {
    if (!REVIEW_MODEL_PHASES.includes(phase)) return;
    if (typeof model !== 'string' || !model.trim()) return;
    modelsUsed[phase] = model.trim();
  };
  let selectedProviderData = providerData;
  const providerState = { selectedProviderData };
  const providerFailoverState = createProviderFailoverState(providerCandidates);

  await workspaceReviewService.updateReview(projectPath, workspaceReviewId, {
    reviewStatus: 'reviewing',
    reviewError: null,
  });

  const reviewTiming = createReviewTiming('workspace_review', workspaceReviewId);
  const isCliAgenticPrimary = shouldUseCliAgenticFastPath({
    providerData,
    executionModeOrder,
    reviewType: 'workspace_review',
    requestedMode: options.reviewMode,
  });
  const reviewExecutionContext = { reviewExecutionMode: isCliAgenticPrimary ? 'cli-agentic' : null };
  reviewTiming.providerMode = resolveProviderExecutionMode(providerData, reviewExecutionContext);
  setProviderCandidates(
    reviewTiming,
    providerFailoverState.candidates,
    (candidate) => resolveProviderExecutionMode(candidate, reviewExecutionContext)
  );
  const estimatedAgenticTier = isCliAgenticPrimary
    ? resolveAgenticTier(Number(workspaceReview.fileCount) || 0)
    : null;
  const deadlineBudgetMs = isCliAgenticPrimary
    ? (estimatedAgenticTier === 'large'
      ? REVIEW_TOTAL_DEADLINE_CLI_AGENTIC_LARGE_MS
      : REVIEW_TOTAL_DEADLINE_CLI_AGENTIC_MS)
    : REVIEW_TOTAL_DEADLINE_MS;
  const deadline = createReviewDeadline(externalSignal, deadlineBudgetMs);
  let progressReviewModelDecision = resolveEffectiveReviewModel(
    providerData,
    'review',
    reviewModelConfig,
    {
      fallbackFileCount: Number(workspaceReview.fileCount) || 0,
      projectId: projectId || null,
      reviewType: 'workspace_review',
      reviewId: workspaceReviewId,
      projectPath,
    }
  );
  const heartbeatInterval = onHeartbeat
    ? setInterval(() => emitHeartbeat('running'), REVIEW_PROVIDER_HEARTBEAT_MS)
    : null;
  if (typeof heartbeatInterval?.unref === 'function') heartbeatInterval.unref();
  const reviewProgressStartedAt = Date.now();
  const getReviewProgressElapsedSeconds = () => Math.max(0, Math.floor((Date.now() - reviewProgressStartedAt) / 1000));
  const emitProgress = (payload = {}) => {
    emitHeartbeat(payload?.phase || 'progress');
    const elapsedSeconds = getReviewProgressElapsedSeconds();
    const checkpoint = normalizeQueueProgress({
      reviewModel: progressReviewModelDecision.model || providerData?.provider?.model || null,
      reviewModelStrategy: normalizeReviewModelStrategy(reviewModelConfig.strategy),
      reviewModelEffectiveStrategy: normalizeReviewModelStrategy(
        progressReviewModelDecision.effectiveStrategy || progressReviewModelDecision.strategy || reviewModelConfig.strategy
      ),
      ...payload,
      phase: payload?.phase || 'running',
      elapsedSeconds,
    }, payload?.phase || 'running');
    reviewEvents.emit('workspace-review-progress', {
      projectId,
      workspaceReviewId,
      ...checkpoint,
    });
    if (onProgressCheckpoint) onProgressCheckpoint(checkpoint);
  };

  try {
    emitHeartbeat('starting');
    const projectRecord = projectId ? await getProjectById(projectId).catch(() => null) : null;
    const baseReviewProfile = await resolveReviewProjectProfile({ projectPath });
    const generatedProjectPolicy = await ensureGeneratedProjectReviewPolicy(projectRecord);
    const reviewPolicy = await resolveEffectiveReviewPolicy({
      projectPath,
      reviewType: 'workspace_review',
      reviewProfile: baseReviewProfile,
      baseBranch: workspaceReview.baseBranch || null,
      baseSha: workspaceReview.headSha || null,
      policySource,
      generatedProjectPolicy,
    });
    const reviewProfile = applyReviewPolicyToReviewProfile(baseReviewProfile, reviewPolicy, {
      totalFiles: Array.isArray(workspaceReview.files) ? workspaceReview.files.length : 0,
    });
    const files = Array.isArray(workspaceReview.files)
      ? workspaceReview.files
        .filter((file) => file && typeof file === 'object')
        .map((file) => ({
          ...file,
          language: file.path?.includes('.') ? file.path.split('.').pop() || '' : '',
        }))
      : [];

    if (files.length === 0) {
      const emptyResult = {
        summary: 'No workspace files are currently dirty on this branch.',
        riskLevel: 'low',
        recommendations: [],
        changeGroups: [],
        stats: { totalFiles: 0, additions: 0, deletions: 0 },
        tokensUsed: { input: 0, output: 0 },
        reviewedAt: new Date().toISOString(),
      };
      const selectedProviderIdentity = normalizeProviderIdentity(selectedProviderData);
      attachReviewCostMetadata(emptyResult, {
        providerType: selectedProviderIdentity.providerType,
        model: selectedProviderIdentity.providerModel || 'unknown',
        tokensUsed: emptyResult.tokensUsed,
      });
      applyReviewPolicyStats(emptyResult, { reviewPolicy });
      await persistWorkspaceReviewTerminalState(projectPath, workspaceReviewId, {
        reviewStatus: 'reviewed',
        reviewRiskLevel: 'low',
        reviewSummary: emptyResult.summary,
        reviewJson: JSON.stringify(emptyResult),
        reviewError: null,
        reviewHeadSha: workspaceReview.headSha || null,
        reviewSnapshotKey: workspaceReview.snapshotKey || null,
        reviewedAt: emptyResult.reviewedAt,
      });
      return emptyResult;
    }

    const focusedSelectionInput = files.map((file) => ({
      path: file.path,
      oldPath: file.oldPath || null,
      status: file.status || 'M',
      additions: Math.max(0, Number(file.additions) || 0),
      deletions: Math.max(0, Number(file.deletions) || 0),
      reviewSizeHint: estimateFileReviewSize(file),
    }));
    const reviewScopeFileCount = files.length;
    const reviewScopeTotalAdditions = files.reduce((sum, file) => sum + Math.max(0, Number(file.additions) || 0), 0);
    const reviewScopeTotalDeletions = files.reduce((sum, file) => sum + Math.max(0, Number(file.deletions) || 0), 0);
    const focusedDecisionContext = buildRoutingDecisionContext({
      files: focusedSelectionInput,
      riskFlags: {
        largeBlastRadius: focusedSelectionInput.length > LARGE_REVIEW_FILE_COUNT,
      },
      diffChars: focusedSelectionInput.reduce(
        (sum, entry) => sum + (Number(entry.reviewSizeHint) || 0),
        0
      ),
      fallbackFileCount: focusedSelectionInput.length,
      focusedReview: false,
      projectId: projectId || null,
      projectPath,
      reviewType: 'workspace_review',
      reviewId: workspaceReviewId,
      branchName: workspaceReview.branchName || null,
      baseBranch: workspaceReview.baseBranch || null,
      headSha: workspaceReview.headSha || null,
      mergeBaseSha: null,
    });
    const focusedReviewResolution = resolveEffectiveReviewModel(
      providerData,
      'review',
      reviewModelConfig,
      focusedDecisionContext
    );
    progressReviewModelDecision = focusedReviewResolution || progressReviewModelDecision;
    const focusedBudget = deriveFocusedReviewBudgetConfig({
      files: focusedSelectionInput,
      providerData,
      reviewResolution: focusedReviewResolution,
      deadline,
    });
    let focusedSelection = selectFilesForFocusedReview(focusedSelectionInput, focusedBudget);
    let isFocusedReview = focusedSelection.mode === 'focused';
    let omittedFiles = focusedSelection.omittedFiles;
    const focusedCoveragePlanner = focusedSelection.planner || focusedBudget?.planner || null;
    const focusedPathSet = new Set(collectReviewUnitMemberPaths(focusedSelection.reviewFiles));
    let preparedFiles = isFocusedReview
      ? files.filter((entry) => focusedPathSet.has(normalizePathForMatch(entry.path)))
      : files;
    if (preparedFiles.length === 0) {
      preparedFiles = files;
      focusedSelection = {
        mode: 'full',
        reviewFiles: focusedSelectionInput,
        omittedFiles: [],
        totalFiles: focusedSelectionInput.length,
        planner: focusedCoveragePlanner,
      };
      isFocusedReview = false;
      omittedFiles = [];
    }

    emitProgress({
      phase: 'reviewing',
      totalFiles: preparedFiles.length,
    });

    const linterDiff = generateDiffFromFiles(preparedFiles);
    const linterPrePass = await runReviewLinterPrePass(projectPath, preparedFiles, linterDiff, {
      reviewPolicy: reviewPolicy || null,
      reviewProfile: reviewProfile || null,
      externalSignal: externalSignal || null,
    });
    await writeReviewDebugJson({
      projectId: projectId || null,
      projectPath,
      reviewType: 'workspace_review',
      reviewId: workspaceReviewId,
    }, 'linter-prepass', linterPrePass);

    const promptContextSignals = await collectPromptContextSignals(projectPath, {
      commitMessages: [],
      queuedCommitShas: [workspaceReview.headSha].filter(Boolean),
      headSha: workspaceReview.headSha || null,
      contextFiles: preparedFiles,
      cacheProjectId: projectId || null,
      reviewProfile: reviewProfile || null,
      sameHashOnly: REVIEW_PROMPT_CONTEXT_SAME_HASH_ONLY,
      allowGuardedCrossHashHints: REVIEW_PROMPT_CONTEXT_ALLOW_CROSS_HASH_HINTS,
    });

    const metadataBase = {
      title: `Workspace review for ${workspaceReview.branchName || 'current branch'}`,
      commitMessages: promptContextSignals.commitMessages,
      verificationStatus: null,
      requestedReviewers: [],
      assignees: [],
      reviewThreads: [],
      priorFindingHints: promptContextSignals.priorFindingHints,
      fileRiskContext: promptContextSignals.fileRiskContext,
      claudeConventions: promptContextSignals.claudeConventions,
      projectMetadata: promptContextSignals.projectMetadata,
      dismissedPatterns: promptContextSignals.dismissedPatterns,
      additionalPromptContextBlocks: promptContextSignals.additionalBlocks,
      linterFindings: getPromptLinterFindings(linterPrePass),
      queuedCommitShas: promptContextSignals.queuedCommitShas,
      promptContextBudgetChars: REVIEW_PROMPT_CONTEXT_BUDGET_CHARS,
      promptContextSameHashOnly: REVIEW_PROMPT_CONTEXT_SAME_HASH_ONLY,
      promptContextAllowCrossHashHints: REVIEW_PROMPT_CONTEXT_ALLOW_CROSS_HASH_HINTS,
      evidencePolicy: normalizeEvidencePolicyForReview(options.evidencePolicy),
      reviewProfile: buildReviewProfileStats(reviewProfile, null).reviewProfile,
      reviewPolicy,
      shapedScope: null,
      fileCount: preparedFiles.length,
      filePaths: preparedFiles.map((file) => file.path),
      omittedFilesCount: omittedFiles.length,
      omittedFiles: isFocusedReview
        ? summarizeOmittedFilesForPrompt(omittedFiles, REVIEW_OMITTED_FILE_PROMPT_LIMIT, { reviewProfile })
        : [],
      totalAdditions: reviewScopeTotalAdditions,
      totalDeletions: reviewScopeTotalDeletions,
      qualityMode: resolveReviewQualityMode(options.qualityMode),
      diffScopeMode: 'workspace',
      diffScopeCommitCount: 0,
      diffBaseSha: null,
      diffHeadSha: workspaceReview.headSha || null,
      priorReviewSummary: '',
      priorReviewFindings: [],
    };

    const preparedResult = await executeSharedPreparedReviewCore({
      contextType: 'workspace_review',
      reviewId: workspaceReviewId,
      projectId: projectId || null,
      projectPath,
      reviewType: 'workspace_review',
      providerData,
      providerState,
      providerFailoverState,
      reviewModelConfig,
      unavailableModels,
      modelsUsed,
      markModelUsed,
      reviewTiming,
      deadline,
      executionModeOrder,
      emitHeartbeat,
      emitProgress,
      reviewFiles: preparedFiles,
      totalFilesForCoverage: isFocusedReview ? focusedSelectionInput.length : preparedFiles.length,
      omittedFiles,
      focusedCoveragePlanner,
      isFocusedReview,
      focusedReviewResolution,
      metadataBase,
      riskFlags: {
        largeBlastRadius: focusedSelectionInput.length > LARGE_REVIEW_FILE_COUNT,
      },
      totalAdditions: reviewScopeTotalAdditions,
      totalDeletions: reviewScopeTotalDeletions,
      verificationStatus: null,
      linterPrePass,
      routeContext: {
        branchName: workspaceReview.branchName || null,
        baseBranch: workspaceReview.baseBranch || null,
        headSha: workspaceReview.headSha || null,
        mergeBaseSha: null,
      },
      reviewExecutionMode: reviewExecutionContext.reviewExecutionMode,
    });

    selectedProviderData = providerState.selectedProviderData || selectedProviderData;
    const selectedProviderIdentity = normalizeProviderIdentity(selectedProviderData);
    const effectiveReviewModel = modelsUsed.review || selectedProviderIdentity.providerModel || 'unknown';
    const fullResult = {
      ...preparedResult.reviewResult,
      provider: {
        type: selectedProviderIdentity.providerType,
        model: effectiveReviewModel,
      },
      tokensUsed: preparedResult.tokenUsage || { input: 0, output: 0 },
      reviewedAt: new Date().toISOString(),
      timing: finalizeReviewTiming(reviewTiming, 'success'),
    };
    const costSnapshot = attachReviewCostMetadata(fullResult, {
      providerType: selectedProviderIdentity.providerType,
      model: effectiveReviewModel,
      tokensUsed: fullResult.tokensUsed,
      providerNativeCost: toNumberOrNull(fullResult?.stats?.agenticCostUsd),
    });
    applyReviewPolicyStats(fullResult, { reviewPolicy });
    fullResult.stats = fullResult.stats || {};
    fullResult.stats.fileCount = Math.max(0, Number(fullResult.stats.fileCount ?? reviewScopeFileCount) || 0);
    fullResult.stats.totalAdditions = Math.max(
      0,
      Number(fullResult.stats.totalAdditions ?? reviewScopeTotalAdditions) || 0
    );
    fullResult.stats.totalDeletions = Math.max(
      0,
      Number(fullResult.stats.totalDeletions ?? reviewScopeTotalDeletions) || 0
    );
    Object.assign(fullResult, assignReviewFindingIds(fullResult, {
      previousReview: workspaceReview.reviewJson,
    }));
    applyTimingSnapshotToReviewStats(fullResult, fullResult.timing);
    logReviewTiming(fullResult.timing);

    const terminalReviewError = derivePersistedReviewErrorFromResult(fullResult);
    await persistWorkspaceReviewTerminalState(projectPath, workspaceReviewId, {
      reviewStatus: 'reviewed',
      reviewRiskLevel: fullResult.riskLevel,
      reviewSummary: fullResult.summary,
      reviewJson: JSON.stringify(fullResult),
      reviewError: terminalReviewError,
      reviewHeadSha: workspaceReview.headSha || null,
      reviewSnapshotKey: workspaceReview.snapshotKey || null,
      reviewedAt: fullResult.reviewedAt,
    });

    try {
      await usageService.recordUsage({
        projectId: projectId || null,
        changesetId: null,
        reviewType: 'workspace_review',
        reviewId: workspaceReviewId,
        providerType: selectedProviderIdentity.providerType,
        model: effectiveReviewModel,
        inputTokens: fullResult.tokensUsed.input,
        outputTokens: fullResult.tokensUsed.output,
        providerNativeCost: costSnapshot?.providerNativeCost ?? null,
      });
    } catch (usageErr) {
      console.error('Failed to record workspace review usage:', usageErr.message);
    }

    return fullResult;
  } catch (error) {
    reviewTiming.failureClass = classifyProviderError(error);
    const failureTiming = finalizeReviewTiming(reviewTiming, 'failed', reviewTiming.failureClass);
    logReviewTiming(failureTiming);
    const persistedReviewError = buildPersistedReviewErrorMessage(error, failureTiming);
    error.persistedReviewError = persistedReviewError;
    await persistWorkspaceReviewTerminalState(projectPath, workspaceReviewId, {
      reviewStatus: 'failed',
      reviewError: persistedReviewError,
    });
    throw error;
  } finally {
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    deadline.clear();
  }
}


// ── Queue management ──────────────────────────────────────────────────────────

function normalizeQueueProgress(
  progress = {},
  fallbackPhase = 'queued',
  previousProgress = null,
  options = {}
) {
  const normalizePhase = (value, fallback = 'queued') => {
    const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (KNOWN_REVIEW_PROGRESS_PHASES.has(normalized)) return normalized;
    const normalizedFallback = typeof fallback === 'string' ? fallback.trim().toLowerCase() : '';
    if (KNOWN_REVIEW_PROGRESS_PHASES.has(normalizedFallback)) return normalizedFallback;
    return 'queued';
  };
  const normalizeInteger = (value) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
  };
  const allowReset = options?.allowReset === true;
  const normalizedPhase = normalizePhase(progress?.phase, fallbackPhase);
  const normalized = {
    phase: normalizedPhase,
    currentChunk: normalizeInteger(progress?.currentChunk),
    totalChunks: normalizeInteger(progress?.totalChunks),
    filesCompleted: normalizeInteger(progress?.filesCompleted),
    totalFiles: normalizeInteger(progress?.totalFiles),
    activeChunkFiles: normalizeInteger(progress?.activeChunkFiles),
    elapsedSeconds: normalizeInteger(progress?.elapsedSeconds),
    splitDepth: normalizeInteger(progress?.splitDepth),
    splitParts: normalizeInteger(progress?.splitParts),
    retryAttempt: normalizeInteger(progress?.retryAttempt),
    retryMaxAttempts: normalizeInteger(progress?.retryMaxAttempts),
    retryDelayMs: normalizeInteger(progress?.retryDelayMs),
    error: typeof progress?.error === 'string' && progress.error.trim()
      ? progress.error.trim()
      : null,
    agenticToolSummary: typeof progress?.agenticToolSummary === 'string' && progress.agenticToolSummary.trim()
      ? progress.agenticToolSummary.trim()
      : null,
    agentName: typeof progress?.agentName === 'string' && progress.agentName.trim()
      ? progress.agentName.trim()
      : null,
    reviewModel: typeof progress?.reviewModel === 'string' && progress.reviewModel.trim()
      ? progress.reviewModel.trim()
      : null,
    reviewModelStrategy: VALID_REVIEW_MODEL_STRATEGIES.includes(progress?.reviewModelStrategy)
      ? progress.reviewModelStrategy
      : null,
    reviewModelEffectiveStrategy: VALID_REVIEW_MODEL_STRATEGIES.includes(progress?.reviewModelEffectiveStrategy)
      ? progress.reviewModelEffectiveStrategy
      : null,
    agenticToolUseCount: normalizeInteger(progress?.agenticToolUseCount),
    agenticMaxTurns: normalizeInteger(progress?.agenticMaxTurns),
    diffScopeMode: progress?.diffScopeMode === 'delta'
      ? 'delta'
      : progress?.diffScopeMode === 'full'
        ? 'full'
        : null,
    diffScopeCommitCount: normalizeInteger(progress?.diffScopeCommitCount),
    diffBaseSha: typeof progress?.diffBaseSha === 'string' && progress.diffBaseSha.trim()
      ? progress.diffBaseSha.trim()
      : null,
    diffHeadSha: typeof progress?.diffHeadSha === 'string' && progress.diffHeadSha.trim()
      ? progress.diffHeadSha.trim()
      : null,
    prRequestedMode: progress?.prRequestedMode === 'agentic_discovery'
      ? 'agentic_discovery'
      : progress?.prRequestedMode === 'full'
        ? 'full'
        : progress?.prRequestedMode === 'auto'
          ? 'auto'
          : null,
    prEffectiveMode: progress?.prEffectiveMode === 'agentic_discovery'
      ? 'agentic_discovery'
      : progress?.prEffectiveMode === 'full'
        ? 'full'
        : progress?.prEffectiveMode === 'auto'
          ? 'auto'
          : null,
    prPipelineMode: progress?.prPipelineMode === 'agentic_discovery'
      ? 'agentic_discovery'
      : progress?.prPipelineMode === 'standard'
        ? 'standard'
        : null,
    totalPrFiles: normalizeInteger(progress?.totalPrFiles),
    effectiveReviewFiles: normalizeInteger(progress?.effectiveReviewFiles),
    partialMode: progress?.partialMode === true,
    totalScopeFiles: normalizeInteger(progress?.totalScopeFiles),
    updatedAt: new Date().toISOString(),
  };

  if (previousProgress && typeof previousProgress === 'object' && !allowReset) {
    const previous = {
      currentChunk: normalizeInteger(previousProgress.currentChunk),
      totalChunks: normalizeInteger(previousProgress.totalChunks),
      filesCompleted: normalizeInteger(previousProgress.filesCompleted),
      totalFiles: normalizeInteger(previousProgress.totalFiles),
      elapsedSeconds: normalizeInteger(previousProgress.elapsedSeconds),
      splitDepth: normalizeInteger(previousProgress.splitDepth),
      splitParts: normalizeInteger(previousProgress.splitParts),
      retryAttempt: normalizeInteger(previousProgress.retryAttempt),
      retryMaxAttempts: normalizeInteger(previousProgress.retryMaxAttempts),
      retryDelayMs: normalizeInteger(previousProgress.retryDelayMs),
      totalPrFiles: normalizeInteger(previousProgress.totalPrFiles),
      effectiveReviewFiles: normalizeInteger(previousProgress.effectiveReviewFiles),
      partialMode: previousProgress.partialMode === true,
      totalScopeFiles: normalizeInteger(previousProgress.totalScopeFiles),
      agenticToolUseCount: normalizeInteger(previousProgress.agenticToolUseCount),
      agenticMaxTurns: normalizeInteger(previousProgress.agenticMaxTurns),
    };
    normalized.currentChunk = Math.max(previous.currentChunk, normalized.currentChunk);
    normalized.totalChunks = Math.max(previous.totalChunks, normalized.totalChunks);
    normalized.filesCompleted = Math.max(previous.filesCompleted, normalized.filesCompleted);
    normalized.totalFiles = Math.max(previous.totalFiles, normalized.totalFiles);
    normalized.elapsedSeconds = Math.max(previous.elapsedSeconds, normalized.elapsedSeconds);
    normalized.totalPrFiles = Math.max(previous.totalPrFiles, normalized.totalPrFiles);
    // Partial mode emits a smaller post-slice effectiveReviewFiles; never let
    // the previous (pre-slice) value overwrite it. Use new value if non-zero,
    // else fall back to previous.
    normalized.effectiveReviewFiles = normalized.effectiveReviewFiles > 0
      ? normalized.effectiveReviewFiles
      : previous.effectiveReviewFiles;
    // Partial flag is sticky once set (subsequent generic emits shouldn't clear it).
    normalized.partialMode = normalized.partialMode || previous.partialMode;
    normalized.totalScopeFiles = Math.max(previous.totalScopeFiles, normalized.totalScopeFiles);
    // Agentic counters are monotonic during a single run; later emits shouldn't lose progress.
    normalized.agenticToolUseCount = Math.max(previous.agenticToolUseCount, normalized.agenticToolUseCount);
    normalized.agenticMaxTurns = Math.max(previous.agenticMaxTurns, normalized.agenticMaxTurns);
    if (!normalized.agenticToolSummary) {
      normalized.agenticToolSummary = typeof previousProgress.agenticToolSummary === 'string'
        && previousProgress.agenticToolSummary.trim()
        ? previousProgress.agenticToolSummary.trim()
        : null;
    }
    if (!normalized.agentName) {
      normalized.agentName = typeof previousProgress.agentName === 'string'
        && previousProgress.agentName.trim()
        ? previousProgress.agentName.trim()
        : null;
    }
    if (!normalized.reviewModel) {
      normalized.reviewModel = typeof previousProgress.reviewModel === 'string'
        && previousProgress.reviewModel.trim()
        ? previousProgress.reviewModel.trim()
        : null;
    }
    if (!normalized.reviewModelStrategy) {
      normalized.reviewModelStrategy = VALID_REVIEW_MODEL_STRATEGIES.includes(previousProgress.reviewModelStrategy)
        ? previousProgress.reviewModelStrategy
        : null;
    }
    if (!normalized.reviewModelEffectiveStrategy) {
      normalized.reviewModelEffectiveStrategy = VALID_REVIEW_MODEL_STRATEGIES.includes(previousProgress.reviewModelEffectiveStrategy)
        ? previousProgress.reviewModelEffectiveStrategy
        : null;
    }
    if (!normalized.diffScopeMode) {
      normalized.diffScopeMode = previousProgress.diffScopeMode === 'delta'
        ? 'delta'
        : previousProgress.diffScopeMode === 'full'
          ? 'full'
          : null;
    }
    if (!normalized.diffScopeCommitCount) {
      normalized.diffScopeCommitCount = normalizeInteger(previousProgress.diffScopeCommitCount);
    }
    if (!normalized.diffBaseSha) {
      normalized.diffBaseSha = typeof previousProgress.diffBaseSha === 'string'
        && previousProgress.diffBaseSha.trim()
        ? previousProgress.diffBaseSha.trim()
        : null;
    }
    if (!normalized.diffHeadSha) {
      normalized.diffHeadSha = typeof previousProgress.diffHeadSha === 'string'
        && previousProgress.diffHeadSha.trim()
        ? previousProgress.diffHeadSha.trim()
        : null;
    }
    if (!normalized.prRequestedMode) {
      normalized.prRequestedMode = previousProgress.prRequestedMode === 'agentic_discovery'
        ? 'agentic_discovery'
        : previousProgress.prRequestedMode === 'full'
          ? 'full'
          : previousProgress.prRequestedMode === 'auto'
            ? 'auto'
            : null;
    }
    if (!normalized.prEffectiveMode) {
      normalized.prEffectiveMode = previousProgress.prEffectiveMode === 'agentic_discovery'
        ? 'agentic_discovery'
        : previousProgress.prEffectiveMode === 'full'
          ? 'full'
          : previousProgress.prEffectiveMode === 'auto'
            ? 'auto'
            : null;
    }
    if (!normalized.prPipelineMode) {
      normalized.prPipelineMode = previousProgress.prPipelineMode === 'agentic_discovery'
        ? 'agentic_discovery'
        : previousProgress.prPipelineMode === 'standard'
          ? 'standard'
          : null;
    }
    normalized.splitDepth = Math.max(previous.splitDepth, normalized.splitDepth);
    normalized.splitParts = Math.max(previous.splitParts, normalized.splitParts);
    normalized.retryAttempt = Math.max(previous.retryAttempt, normalized.retryAttempt);
    normalized.retryMaxAttempts = Math.max(previous.retryMaxAttempts, normalized.retryMaxAttempts);
    normalized.retryDelayMs = Math.max(previous.retryDelayMs, normalized.retryDelayMs);
  }

  if (normalized.totalChunks > 0) {
    normalized.currentChunk = Math.min(normalized.currentChunk, normalized.totalChunks);
  } else if (normalized.currentChunk > 0) {
    normalized.totalChunks = normalized.currentChunk;
  }

  if (normalized.totalFiles > 0) {
    normalized.filesCompleted = Math.min(normalized.filesCompleted, normalized.totalFiles);
  } else if (normalized.filesCompleted > 0) {
    normalized.totalFiles = normalized.filesCompleted;
  }

  if (normalized.retryMaxAttempts > 0) {
    normalized.retryAttempt = Math.min(normalized.retryAttempt, normalized.retryMaxAttempts);
  } else if (normalized.retryAttempt > 0) {
    normalized.retryMaxAttempts = normalized.retryAttempt;
  }

  return normalized;
}

function updateQueueEntryProgress(entry, progress = {}, fallbackPhase = 'queued', options = {}) {
  if (!entry || typeof entry !== 'object') return;
  entry.progress = normalizeQueueProgress(progress, fallbackPhase, entry.progress || null, options);
  entry.updatedAt = entry.progress.updatedAt;
}

function normalizeQueuedReviewHeadSha(snapshot) {
  return typeof snapshot?.headSha === 'string' && snapshot.headSha.trim()
    ? snapshot.headSha.trim()
    : null;
}

/**
 * Add a branch review to the review queue
 * @param {string} projectPath - Project path
 * @param {string} branchReviewId - Branch review UUID
 * @returns {Object} Queue entry with position
 */
function enqueueBranchReview(projectPath, branchReviewId, options = {}) {
  const normalizedScope = normalizeReviewScope(options.scope);
  const reviewMode = normalizeBranchReviewRunMode(options.reviewMode);
  const policySource = normalizeReviewPolicySource(options.policySource, 'trusted');
  const partial = options.partial === true;
  const normalizedProjectId = typeof options.projectId === 'string' && options.projectId.trim()
    ? options.projectId.trim()
    : null;
  // CodeGraph experiment override: only stored when explicitly boolean
  // so the queued entry round-trips the harness intent unchanged.
  const codegraphMcpEnabledOverride = typeof options.codegraphMcpEnabledOverride === 'boolean'
    ? options.codegraphMcpEnabledOverride
    : null;
  const scope = normalizedScope.hasExplicitScope
    ? {
      includePatterns: normalizedScope.includePatterns,
      excludePatterns: normalizedScope.excludePatterns,
      applyGlobalIgnorePatterns: normalizedScope.applyGlobalIgnorePatterns,
    }
    : null;
  // Reuse an already-queued follow-up run, but do not mutate an in-flight
  // entry. When a new commit lands during an active review we need a fresh
  // queued rerun behind the current execution.
  const incomingAutoReviewHeadSha = normalizeQueuedReviewHeadSha(options.autoReviewSnapshot);
  const activeSameHeadEntry = incomingAutoReviewHeadSha
    ? reviewQueue.find(
      q => q.type === 'branch_review'
        && q.branchReviewId === branchReviewId
        && q.status === 'reviewing'
        && normalizeQueuedReviewHeadSha(q.autoReviewSnapshot) === incomingAutoReviewHeadSha
    )
    : null;
  if (activeSameHeadEntry) {
    return {
      position: reviewQueue.indexOf(activeSameHeadEntry) + 1,
      id: activeSameHeadEntry.id,
      alreadyRunning: true,
    };
  }

  const existing = reviewQueue.find(
    q => q.type === 'branch_review'
      && q.branchReviewId === branchReviewId
      && q.status === 'queued'
  );
  if (existing) {
    existing.projectPath = projectPath;
    existing.scope = scope || null;
    existing.reviewMode = reviewMode;
    existing.policySource = policySource;
    existing.partial = partial;
    existing.codegraphMcpEnabledOverride = codegraphMcpEnabledOverride;
    existing.autoReviewSnapshot = options.autoReviewSnapshot || existing.autoReviewSnapshot || null;
    if (!existing.projectId && normalizedProjectId) {
      existing.projectId = normalizedProjectId;
    }
    existing.status = 'queued';
    updateQueueEntryProgress(existing, {
      phase: 'queued',
      currentChunk: 0,
      totalChunks: 0,
      filesCompleted: 0,
      totalFiles: 0,
    }, 'queued', { allowReset: true });
    const position = reviewQueue.indexOf(existing) + 1;
    const emitProjectId = existing.projectId || null;
    if (emitProjectId) {
      reviewEvents.emit('branch-review-queued', {
        projectId: emitProjectId,
        branchReviewId,
        queueId: existing.id,
        position,
      });
    }
    return { position, id: existing.id };
  }

  const entry = {
    id: `${Date.now()}-br-${branchReviewId.substring(0, 8)}`,
    type: 'branch_review',
    projectId: normalizedProjectId,
    projectPath,
    branchReviewId,
    scope: scope || null,
    reviewMode,
    policySource,
    partial,
    codegraphMcpEnabledOverride,
    autoReviewSnapshot: options.autoReviewSnapshot || null,
    status: 'queued',
    queuedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    progress: normalizeQueueProgress({
      phase: 'queued',
      currentChunk: 0,
      totalChunks: 0,
      filesCompleted: 0,
      totalFiles: 0,
    }, 'queued'),
  };

  const hasInFlightEntry = reviewQueue.some(
    q => q.type === 'branch_review'
      && q.branchReviewId === branchReviewId
      && q.status === 'reviewing'
  );
  reviewQueue.push(entry);

  // Keep the persisted lifecycle in "reviewing" when a catch-up rerun is
  // queued behind an active execution for the same branch review.
  if (!hasInFlightEntry) {
    branchReviewService.updateReview(branchReviewId, { review_status: 'queued', review_error: null }).catch(() => {});
  }

  if (normalizedProjectId) {
    reviewEvents.emit('branch-review-queued', {
      projectId: normalizedProjectId,
      branchReviewId,
      queueId: entry.id,
      position: reviewQueue.length,
    });
  }

  // Kick off processing after listeners have seen the queued state. If this
  // starts first, the UI can receive "reviewing" and then a stale "queued"
  // event for the same entry, which looks like an extra follow-up review.
  startQueueProcessing();

  return { position: reviewQueue.length, id: entry.id };
}

/**
 * Add a PR review to the review queue.
 * @param {string} projectId - Project UUID
 * @param {string} prReviewId - PR review UUID
 * @param {Object} options - { installationId, owner, repo, prNumber }
 * @returns {Object} Queue entry with position
 */
function enqueuePrReview(projectId, prReviewId, options = {}) {
  const reviewMode = normalizePrReviewRequestedMode(options.reviewMode);
  const policySource = normalizeReviewPolicySource(options.policySource, 'trusted');
  // Check if already in queue
  const existing = reviewQueue.find(
    q => q.type === 'pr_review' && q.prReviewId === prReviewId
  );
  if (existing) {
    existing.status = 'queued';
    existing.reviewMode = reviewMode;
    existing.forceFullScope = options.forceFullScope === true;
    existing.policySource = policySource;
    existing.reviewModelStrategy = options.reviewModelStrategy ?? null;
    existing.reviewModelCustom = options.reviewModelCustom ?? null;
    existing.reviewModelAdaptive = options.reviewModelAdaptive ?? null;
    existing.reviewModelRollout = options.reviewModelRollout ?? null;
    if (!existing.projectPath && options.projectPath) {
      existing.projectPath = options.projectPath;
    }
    updateQueueEntryProgress(existing, {
      phase: 'queued', currentChunk: 0, totalChunks: 0, filesCompleted: 0, totalFiles: 0,
    }, 'queued', { allowReset: true });
    const position = reviewQueue.indexOf(existing) + 1;
    if (projectId) {
      reviewEvents.emit('pr-review-queued', { projectId, prReviewId, position });
    }
    return { position, id: existing.id };
  }

  const entry = {
    id: `${Date.now()}-pr-${prReviewId.substring(0, 8)}`,
    type: 'pr_review',
    projectId,
    prReviewId,
    installationId: options.installationId,
    owner: options.owner,
    repo: options.repo,
    prNumber: options.prNumber,
    projectPath: options.projectPath || null,
    reviewMode,
    forceFullScope: options.forceFullScope === true,
    policySource,
    reviewModelStrategy: options.reviewModelStrategy ?? null,
    reviewModelCustom: options.reviewModelCustom ?? null,
    reviewModelAdaptive: options.reviewModelAdaptive ?? null,
    reviewModelRollout: options.reviewModelRollout ?? null,
    status: 'queued',
    queuedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    progress: normalizeQueueProgress({
      phase: 'queued', currentChunk: 0, totalChunks: 0, filesCompleted: 0, totalFiles: 0,
    }, 'queued'),
  };

  reviewQueue.push(entry);

  // Update PR review status
  prReviewService.updateReview(prReviewId, { review_status: 'queued', review_error: null }).catch(() => {});

  startQueueProcessing();

  if (projectId) {
    reviewEvents.emit('pr-review-queued', { projectId, prReviewId, position: reviewQueue.length });
  }

  return { position: reviewQueue.length, id: entry.id };
}

function enqueueWorkspaceReview(projectId, projectPath, workspaceReviewId, options = {}) {
  const reviewMode = normalizeBranchReviewRunMode(options.reviewMode);
  const policySource = normalizeReviewPolicySource(options.policySource, 'trusted');
  const baseBranch = typeof options.baseBranch === 'string' && options.baseBranch.trim()
    ? options.baseBranch.trim()
    : null;
  const existing = reviewQueue.find(
    q => q.type === 'workspace_review' && q.workspaceReviewId === workspaceReviewId
  );
  if (existing) {
    existing.status = 'queued';
    existing.reviewMode = reviewMode;
    existing.policySource = policySource;
    if (!existing.projectPath && projectPath) {
      existing.projectPath = projectPath;
    }
    if (!existing.projectId && projectId) {
      existing.projectId = projectId;
    }
    if (!existing.baseBranch && baseBranch) {
      existing.baseBranch = baseBranch;
    }
    updateQueueEntryProgress(existing, {
      phase: 'queued', currentChunk: 0, totalChunks: 0, filesCompleted: 0, totalFiles: 0,
    }, 'queued', { allowReset: true });
    const position = reviewQueue.indexOf(existing) + 1;
    if (projectId) {
      reviewEvents.emit('workspace-review-queued', { projectId, workspaceReviewId, position });
    }
    return { position, id: existing.id };
  }

  const entry = {
    id: `${Date.now()}-wr-${workspaceReviewId.substring(0, 8)}`,
    type: 'workspace_review',
    projectId,
    projectPath,
    workspaceReviewId,
    baseBranch,
    reviewMode,
    policySource,
    status: 'queued',
    queuedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    progress: normalizeQueueProgress({
      phase: 'queued', currentChunk: 0, totalChunks: 0, filesCompleted: 0, totalFiles: 0,
    }, 'queued'),
  };

  reviewQueue.push(entry);
  workspaceReviewService.updateReview(projectPath, workspaceReviewId, {
    reviewStatus: 'queued',
    reviewError: null,
  }).catch(() => {});
  startQueueProcessing();

  if (projectId) {
    reviewEvents.emit('workspace-review-queued', { projectId, workspaceReviewId, position: reviewQueue.length });
  }

  return { position: reviewQueue.length, id: entry.id };
}

/**
 * Update review fields on a changeset (both full file and index)
 * @param {string} projectPath - Project path
 * @param {string} changesetId - Changeset ID
 * @param {Object} reviewFields - Fields to update
 */
async function updateChangeSetReview(projectPath, changesetId, reviewFields) {
  const changesetPath = getChangeSetFilePath(projectPath, changesetId);
  const legacyChangesetPath = path.join(projectPath, '.atlas', 'changesets', `${changesetId}.json`);

  try {
    let changeset;
    try {
      changeset = await readJsonFileWithRetry(changesetPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      changeset = await readJsonFileWithRetry(legacyChangesetPath);
    }

    // Update review fields on full changeset
    Object.assign(changeset, reviewFields);
    await writeJsonFileAtomic(changesetPath, changeset);

    try {
      await updateChangeSetReviewIndex(projectPath, changesetId, reviewFields);
    } catch {
      // Index update is best-effort
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error('Changeset not found');
    }
    throw error;
  }
}

/**
 * Clear failed review state so a changeset returns to unreviewed status.
 * Keeps change data intact while removing stale failure metadata.
 * @param {string} projectPath
 * @param {string} changesetId
 */
async function dismissChangeSetReviewFailure(projectPath, changesetId) {
  await updateChangeSetReview(projectPath, changesetId, {
    reviewStatus: 'none',
    reviewRiskLevel: null,
    reviewSummary: null,
    reviewedBy: null,
    reviewedAt: null,
    reviewError: null,
    reviewData: null,
  });
}

function buildPrReviewVerificationStatus(rawStatus) {
  if (!rawStatus || typeof rawStatus !== 'object') return null;
  const rawState = String(rawStatus.state || '').trim().toLowerCase();
  const contexts = Array.isArray(rawStatus.contexts) ? rawStatus.contexts : [];
  const failingContexts = [];
  const pendingContexts = [];
  const successfulContexts = [];

  for (const entry of contexts) {
    const context = String(entry?.context || '').trim();
    if (!context) continue;
    const state = String(entry?.state || '').trim().toLowerCase();
    const description = String(entry?.description || '').trim();
    const conclusion = String(entry?.conclusion || '').trim().toLowerCase();
    const status = String(entry?.status || '').trim().toLowerCase();
    const detail = description
      ? `${context} (${conclusion || state || status || 'unknown'}: ${description})`
      : `${context} (${conclusion || state || status || 'unknown'})`;
    if (state === 'failure' || state === 'error') {
      failingContexts.push(detail);
    } else if (state === 'pending') {
      pendingContexts.push(detail);
    } else if (state === 'success') {
      successfulContexts.push(detail);
    }
  }

  const overallStatus = failingContexts.length > 0
    ? 'fail'
    : pendingContexts.length > 0
    ? 'not_run'
    : rawState === 'success'
    ? 'pass'
    : rawState === 'failure' || rawState === 'error'
    ? 'fail'
    : null;

  if (!overallStatus) return null;

  const lines = [];
  lines.push(`GitHub checks: state=${rawState || 'unknown'} total=${Math.max(0, Number(rawStatus.totalCount || contexts.length || 0))}`);
  if (failingContexts.length > 0) {
    lines.push(`Failing contexts: ${failingContexts.slice(0, 6).join(', ')}`);
  }
  if (pendingContexts.length > 0) {
    lines.push(`Pending contexts: ${pendingContexts.slice(0, 6).join(', ')}`);
  }
  if (successfulContexts.length > 0 && failingContexts.length === 0 && pendingContexts.length === 0) {
    lines.push(`Passing contexts: ${successfulContexts.slice(0, 6).join(', ')}`);
  }

  return {
    overallStatus,
    lines,
    source: 'github_checks',
  };
}

/**
 * Add a changeset to the review queue
 * @param {string} projectPath - Project path
 * @param {string} changesetId - Changeset ID
 * @param {Object} [options] - Queue options
 * @param {boolean} [options.force] - Force re-review even if already reviewed
 * @returns {Object} Queue entry with position
 */
function enqueueReview(projectPath, changesetId, options = {}) {
  const force = !!options.force;
  // Check if already in queue
  const existing = reviewQueue.find(
    q => q.projectPath === projectPath && q.changesetId === changesetId
  );
  if (existing) {
    existing.force = existing.force || force;
    existing.status = 'queued';
    existing.reviewError = null;
    updateQueueEntryProgress(existing, {
      phase: 'queued',
      currentChunk: 0,
      totalChunks: 0,
      filesCompleted: 0,
      totalFiles: 0,
      retryAttempt: 0,
      retryMaxAttempts: 0,
      retryDelayMs: 0,
      error: null,
    }, 'queued', { allowReset: true });
    return { position: reviewQueue.indexOf(existing) + 1, id: existing.id };
  }

  const entry = {
    id: `${Date.now()}-${changesetId.substring(0, 8)}`,
    type: 'changeset',
    projectPath,
    changesetId,
    force,
    status: 'queued',
    queuedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    reviewError: null,
    progress: normalizeQueueProgress({
      phase: 'queued',
      currentChunk: 0,
      totalChunks: 0,
      filesCompleted: 0,
      totalFiles: 0,
      retryAttempt: 0,
      retryMaxAttempts: 0,
      retryDelayMs: 0,
      error: null,
    }, 'queued'),
  };

  reviewQueue.push(entry);

  // Update changeset status
  updateChangeSetReview(projectPath, changesetId, { reviewStatus: 'queued', reviewError: null }).catch(() => {});

  // Kick off processing if not already running
  startQueueProcessing();

  return { position: reviewQueue.length, id: entry.id };
}

/**
 * Cancel a queued review
 * @param {string} changesetId - Changeset ID
 * @returns {boolean} True if cancelled
 */
function cancelReview(changesetId) {
  const idx = reviewQueue.findIndex(
    q => q.changesetId === changesetId && q.status === 'queued'
  );
  if (idx >= 0) {
    const entry = reviewQueue[idx];
    reviewQueue.splice(idx, 1);
    updateChangeSetReview(entry.projectPath, changesetId, { reviewStatus: 'none', reviewError: null }).catch(() => {});
    return true;
  }
  return false;
}

/**
 * Stop a queued or running review (branch review or changeset).
 * For queued entries: splices from queue and resets DB status to 'none'.
 * For running entries: aborts the watchdog controller so processQueue catches ReviewUserStopError.
 * @param {string} entryId - Queue entry ID
 * @returns {{ stopped: boolean, was: 'queued'|'running'|null }}
 */
async function stopReview(entryId) {
  const idx = reviewQueue.findIndex(q => q.id === entryId);
  if (idx < 0) return { stopped: false, was: null };

  const entry = reviewQueue[idx];

  if (entry.status === 'queued') {
    reviewQueue.splice(idx, 1);
    if (entry.type === 'branch_review') {
      const reviewStatus = await resolveStoppedBranchReviewStatus(entry.branchReviewId);
      await persistBranchReviewTerminalState(entry.branchReviewId, {
        reviewStatus,
        reviewError: null,
      }).catch(() => {});
      reviewEvents.emit('branch-review-stopped', {
        projectId: entry.projectId || null,
        branchReviewId: entry.branchReviewId,
        reviewStatus,
      });
    } else if (entry.type === 'workspace_review') {
      const reviewStatus = await resolveStoppedWorkspaceReviewStatus(entry.projectPath, entry.workspaceReviewId);
      await persistWorkspaceReviewTerminalState(entry.projectPath, entry.workspaceReviewId, {
        reviewStatus,
        reviewError: null,
      }).catch(() => {});
      reviewEvents.emit('workspace-review-stopped', {
        projectId: entry.projectId || null,
        workspaceReviewId: entry.workspaceReviewId,
        reviewStatus,
      });
    } else if (entry.type === 'pr_review') {
      const reviewStatus = await resolveStoppedPrReviewStatus(entry.prReviewId);
      await persistPrReviewTerminalState(entry.prReviewId, {
        reviewStatus,
        reviewError: null,
      }).catch(() => {});
      reviewEvents.emit('pr-review-stopped', {
        projectId: entry.projectId || null,
        prReviewId: entry.prReviewId,
        reviewStatus,
      });
    } else {
      persistChangesetTerminalState(entry.projectPath, entry.changesetId, {
        reviewStatus: 'none',
        reviewError: null,
      }).catch(() => {});
    }
    return { stopped: true, was: 'queued' };
  }

  if (entry.status === 'reviewing' && entry._abortController) {
    const itemId = entry.type === 'branch_review'
      ? entry.branchReviewId
      : entry.type === 'pr_review'
        ? entry.prReviewId
        : entry.type === 'workspace_review'
          ? entry.workspaceReviewId
          : entry.changesetId;
    entry._abortController.abort(new ReviewUserStopError(itemId));
    return { stopped: true, was: 'running' };
  }

  return { stopped: false, was: null };
}

/**
 * Get current queue status
 * @returns {Array} Queue entries
 */
function getQueueStatus() {
  return reviewQueue.map(({ id, type, projectId, changesetId, branchReviewId, prReviewId, workspaceReviewId, status, queuedAt, updatedAt, progress, reviewError, autoReviewSnapshot }, index) => ({
    id,
    type: type || 'changeset',
    projectId: projectId || null,
    changesetId: changesetId || null,
    branchReviewId: branchReviewId || null,
    prReviewId: prReviewId || null,
    workspaceReviewId: workspaceReviewId || null,
    status,
    position: index + 1,
    queuedAt,
    updatedAt: updatedAt || queuedAt,
    reviewError: reviewError || null,
    autoReviewSnapshot: autoReviewSnapshot || null,
    progress: progress ? { ...progress } : null,
    lifecycle: buildQueueLifecycle({
      status,
      progress,
      reviewError,
      queuedAt,
      updatedAt,
    }),
  }));
}

function getQueueEntryStatus(entryId) {
  if (!entryId) return null;
  const entry = reviewQueue.find((candidate) => candidate.id === entryId);
  if (!entry) return null;
  const {
    id,
    type,
    projectId,
    changesetId,
    branchReviewId,
    prReviewId,
    workspaceReviewId,
    status,
    queuedAt,
    updatedAt,
    progress,
    reviewError,
    autoReviewSnapshot,
  } = entry;
  return {
    id,
    type: type || 'changeset',
    projectId: projectId || null,
    changesetId: changesetId || null,
    branchReviewId: branchReviewId || null,
    prReviewId: prReviewId || null,
    workspaceReviewId: workspaceReviewId || null,
    status,
    queuedAt,
    updatedAt: updatedAt || queuedAt,
    reviewError: reviewError || null,
    autoReviewSnapshot: autoReviewSnapshot || null,
    progress: progress ? { ...progress } : null,
    lifecycle: buildQueueLifecycle({
      status,
      progress,
      reviewError,
      queuedAt,
      updatedAt,
    }),
  };
}

async function cancelQueuedReviewEntry(entryId) {
  const idx = reviewQueue.findIndex((entry) => entry.id === entryId);
  if (idx < 0) return { stopped: false, was: null };
  const entry = reviewQueue[idx];
  if (entry.status !== 'queued') {
    return { stopped: false, was: entry.status === 'reviewing' ? 'running' : null };
  }

  if (entry.type !== 'branch_review') {
    return stopReview(entryId);
  }

  reviewQueue.splice(idx, 1);

  const hasActiveSameReview = Boolean(activeBranchReviewRuns.get(entry.branchReviewId))
    || reviewQueue.some((candidate) => (
      candidate.type === 'branch_review'
      && candidate.branchReviewId === entry.branchReviewId
      && candidate.status === 'reviewing'
    ));
  if (hasActiveSameReview) {
    reviewEvents.emit('branch-review-queued-cancelled', {
      projectId: entry.projectId || null,
      branchReviewId: entry.branchReviewId,
      queueId: entry.id,
    });
    return { stopped: true, was: 'queued' };
  }
  const reviewStatus = await resolveStoppedBranchReviewStatus(entry.branchReviewId);
  await persistBranchReviewTerminalState(entry.branchReviewId, {
    reviewStatus,
    reviewError: null,
  }).catch(() => {});
  reviewEvents.emit('branch-review-stopped', {
    projectId: entry.projectId || null,
    branchReviewId: entry.branchReviewId,
    reviewStatus,
  });
  return { stopped: true, was: 'queued' };
}

/**
 * Process the review queue (one at a time)
 * Handles both changeset reviews and branch reviews.
 */
async function processQueue() {
  if (isProcessing) return;
  isProcessing = true;

  try {
    while (reviewQueue.length > 0) {
      const entry = reviewQueue[0];
      if (entry.status !== 'queued') {
        reviewQueue.shift();
        continue;
      }

      const normalizedRetryBudget = Math.max(0, Number(REVIEW_QUEUE_WATCHDOG_MAX_RETRIES) || 0);
      let watchdogAttempt = 0;
      let terminalFailure = null;

      while (watchdogAttempt <= normalizedRetryBudget) {
        watchdogAttempt += 1;
        entry.status = 'reviewing';
        entry.reviewError = null;
        updateQueueEntryProgress(entry, {
          phase: 'reviewing',
          currentChunk: 0,
          totalChunks: 0,
          filesCompleted: 0,
          totalFiles: 0,
          retryAttempt: 0,
          retryMaxAttempts: 0,
          retryDelayMs: 0,
          error: null,
        }, 'reviewing', { allowReset: true });
        const watchdogController = new AbortController();
        entry._abortController = watchdogController;
        let lastHeartbeatAt = Date.now();
        const touchHeartbeat = () => {
          lastHeartbeatAt = Date.now();
        };
        const watchdogInterval = setInterval(() => {
          if (watchdogController.signal.aborted) return;
          const staleMs = Date.now() - lastHeartbeatAt;
          if (staleMs >= REVIEW_QUEUE_WATCHDOG_STALE_MS) {
            const itemId = entry.type === 'branch_review'
              ? entry.branchReviewId
              : entry.type === 'pr_review'
                ? entry.prReviewId
                : entry.type === 'workspace_review'
                  ? entry.workspaceReviewId
                  : entry.changesetId;
            watchdogController.abort(new ReviewWatchdogError(staleMs, itemId));
          }
        }, REVIEW_QUEUE_WATCHDOG_POLL_MS);
        if (typeof watchdogInterval?.unref === 'function') watchdogInterval.unref();

        try {
          if (entry.type === 'branch_review') {
            // Emit reviewing event for BR
            const brBefore = await branchReviewService.getById(entry.branchReviewId).catch(() => null);
            if (!entry.projectId && brBefore?.projectId) {
              entry.projectId = brBefore.projectId;
            }
            const emitProjectId = entry.projectId || brBefore?.projectId || null;
            markActiveBranchReviewRun(entry.branchReviewId, {
              projectId: emitProjectId,
              queueId: entry.id,
              position: 1,
              source: 'queue',
              autoReviewSnapshot: entry.autoReviewSnapshot || null,
              progress: entry.progress || {
                phase: 'reviewing',
                updatedAt: new Date().toISOString(),
              },
            });
            if (emitProjectId) {
              reviewEvents.emit('branch-review-reviewing', {
                projectId: emitProjectId,
                branchReviewId: entry.branchReviewId,
                queueId: entry.id,
              });
            }
            const result = await reviewBranchReview(entry.projectPath, entry.branchReviewId, {
              force: true,
              reviewMode: entry.reviewMode,
              policySource: entry.policySource,
              scope: entry.scope || undefined,
              partial: entry.partial === true,
              codegraphMcpEnabledOverride: typeof entry.codegraphMcpEnabledOverride === 'boolean'
                ? entry.codegraphMcpEnabledOverride
                : null,
              queueId: entry.id,
              externalSignal: watchdogController.signal,
              onHeartbeat: touchHeartbeat,
              onProgressCheckpoint: (progress) => {
                updateQueueEntryProgress(entry, progress, progress?.phase || 'reviewing');
                touchActiveBranchReviewRun(entry.branchReviewId, progress, {
                  projectId: entry.projectId || emitProjectId,
                  queueId: entry.id,
                  position: 1,
                  source: 'queue',
                  autoReviewSnapshot: entry.autoReviewSnapshot || null,
                });
              },
            });
            const terminalReviewError = derivePersistedReviewErrorFromResult(result);
            const terminalPhase = terminalReviewError ? 'partial' : 'complete';
            entry.status = terminalReviewError ? 'partial' : 'reviewed';
            entry.reviewError = terminalReviewError || null;
            updateQueueEntryProgress(entry, {
              phase: terminalPhase,
              currentChunk: 0,
              totalChunks: 0,
              filesCompleted: 0,
              totalFiles: 0,
              retryAttempt: 0,
              retryMaxAttempts: 0,
              retryDelayMs: 0,
              error: terminalReviewError || null,
            }, terminalPhase);
            clearActiveBranchReviewRun(entry.branchReviewId);
            // Emit reviewed event for BR
            const brAfter = await branchReviewService.getById(entry.branchReviewId).catch(() => null);
            if (!entry.projectId && brAfter?.projectId) {
              entry.projectId = brAfter.projectId;
            }
            const emitReviewedProjectId = entry.projectId || brAfter?.projectId || brBefore?.projectId || null;
            if (emitReviewedProjectId) {
              reviewEvents.emit('branch-review-reviewed', {
                projectId: emitReviewedProjectId,
                branchReviewId: entry.branchReviewId,
                riskLevel: result?.riskLevel || null,
                summary: result?.summary || null,
                error: terminalReviewError || null,
                reviewedAt: result?.reviewedAt || null,
              });
            }
          } else if (entry.type === 'pr_review') {
            // ── PR Review dispatch ──
            const prBefore = await prReviewService.getById(entry.prReviewId).catch(() => null);
            if (!entry.projectId && prBefore?.projectId) {
              entry.projectId = prBefore.projectId;
            }
            const emitProjectId = entry.projectId || prBefore?.projectId || null;
            if (emitProjectId) {
              reviewEvents.emit('pr-review-reviewing', {
                projectId: emitProjectId,
                prReviewId: entry.prReviewId,
              });
            }
            const result = await reviewPrReview(entry.projectId, entry.prReviewId, {
              force: true,
              reviewMode: entry.reviewMode,
              forceFullScope: entry.forceFullScope === true,
              policySource: entry.policySource,
              reviewModelStrategy: entry.reviewModelStrategy ?? null,
              reviewModelCustom: entry.reviewModelCustom ?? null,
              reviewModelAdaptive: entry.reviewModelAdaptive ?? null,
              reviewModelRollout: entry.reviewModelRollout ?? null,
              installationId: entry.installationId,
              owner: entry.owner,
              repo: entry.repo,
              projectPath: entry.projectPath || null,
              externalSignal: watchdogController.signal,
              onHeartbeat: touchHeartbeat,
              onProgressCheckpoint: (progress) => {
                updateQueueEntryProgress(entry, progress, progress?.phase || 'reviewing');
              },
            });
            const terminalReviewError = derivePersistedReviewErrorFromResult(result);
            const terminalPhase = terminalReviewError ? 'partial' : 'complete';
            entry.status = terminalReviewError ? 'partial' : 'reviewed';
            entry.reviewError = terminalReviewError || null;
            updateQueueEntryProgress(entry, {
              phase: terminalPhase, currentChunk: 0, totalChunks: 0,
              filesCompleted: 0, totalFiles: 0, retryAttempt: 0,
              retryMaxAttempts: 0, retryDelayMs: 0,
              error: terminalReviewError || null,
            }, terminalPhase);
            // Emit reviewed event
            const prAfter = await prReviewService.getById(entry.prReviewId).catch(() => null);
            const emitReviewedProjectId = entry.projectId || prAfter?.projectId || prBefore?.projectId || null;
            if (emitReviewedProjectId) {
              reviewEvents.emit('pr-review-reviewed', {
                projectId: emitReviewedProjectId,
                prReviewId: entry.prReviewId,
                riskLevel: result?.riskLevel || null,
                summary: result?.summary || null,
                error: terminalReviewError || null,
                reviewedAt: result?.reviewedAt || null,
              });
            }
          } else if (entry.type === 'workspace_review') {
            const result = await reviewWorkspaceReview(entry.projectId, entry.projectPath, entry.workspaceReviewId, {
              force: true,
              baseBranch: entry.baseBranch || null,
              reviewMode: entry.reviewMode,
              policySource: entry.policySource,
              externalSignal: watchdogController.signal,
              onHeartbeat: touchHeartbeat,
              onProgressCheckpoint: (progress) => {
                updateQueueEntryProgress(entry, progress, progress?.phase || 'reviewing');
              },
            });
            const terminalReviewError = derivePersistedReviewErrorFromResult(result);
            const terminalPhase = terminalReviewError ? 'partial' : 'complete';
            entry.status = terminalReviewError ? 'partial' : 'reviewed';
            entry.reviewError = terminalReviewError || null;
            updateQueueEntryProgress(entry, {
              phase: terminalPhase, currentChunk: 0, totalChunks: 0,
              filesCompleted: 0, totalFiles: 0, retryAttempt: 0,
              retryMaxAttempts: 0, retryDelayMs: 0,
              error: terminalReviewError || null,
            }, terminalPhase);
            if (entry.projectId) {
              reviewEvents.emit('workspace-review-reviewed', {
                projectId: entry.projectId,
                workspaceReviewId: entry.workspaceReviewId,
                riskLevel: result?.riskLevel || null,
                summary: result?.summary || null,
                error: terminalReviewError || null,
                reviewedAt: result?.reviewedAt || null,
              });
            }
          } else {
            const result = await reviewChangeset(entry.projectPath, entry.changesetId, {
              force: entry.force !== undefined ? !!entry.force : true,
              externalSignal: watchdogController.signal,
              onHeartbeat: touchHeartbeat,
            });
            const terminalReviewError = derivePersistedReviewErrorFromResult(result);
            const terminalPhase = terminalReviewError ? 'partial' : 'complete';
            entry.status = terminalReviewError ? 'partial' : 'reviewed';
            entry.reviewError = terminalReviewError || null;
            updateQueueEntryProgress(entry, {
              phase: terminalPhase,
              currentChunk: 0,
              totalChunks: 0,
              filesCompleted: 0,
              totalFiles: 0,
              retryAttempt: 0,
              retryMaxAttempts: 0,
              retryDelayMs: 0,
              error: terminalReviewError || null,
            }, terminalPhase);
          }
          terminalFailure = null;
          break;
        } catch (error) {
          if (entry.type === 'branch_review') {
            clearActiveBranchReviewRun(entry.branchReviewId);
          }
          const abortReason = watchdogController.signal.aborted
            ? watchdogController.signal.reason
            : null;

          // ── User stop ────────────────────────────────────────────
          const isUserStop = abortReason?.isUserStop || error?.isUserStop;
          if (isUserStop) {
            const itemId = entry.type === 'branch_review'
              ? entry.branchReviewId
              : entry.type === 'pr_review'
                ? entry.prReviewId
                : entry.type === 'workspace_review'
                  ? entry.workspaceReviewId
                  : entry.changesetId;
            console.log(`[ReviewService] Review stopped by user for ${itemId}`);
            if (entry.type === 'branch_review') {
              const reviewStatus = await resolveStoppedBranchReviewStatus(entry.branchReviewId);
              await persistBranchReviewTerminalState(entry.branchReviewId, {
                reviewStatus,
                reviewError: null,
              }).catch(() => {});
              const br = await branchReviewService.getById(entry.branchReviewId).catch(() => null);
              if (!entry.projectId && br?.projectId) {
                entry.projectId = br.projectId;
              }
              const emitProjectId = entry.projectId || br?.projectId || null;
              if (emitProjectId) {
                reviewEvents.emit('branch-review-stopped', {
                  projectId: emitProjectId,
                  branchReviewId: entry.branchReviewId,
                  reviewStatus,
                });
              }
            } else if (entry.type === 'pr_review') {
              const reviewStatus = await resolveStoppedPrReviewStatus(entry.prReviewId);
              await persistPrReviewTerminalState(entry.prReviewId, {
                reviewStatus,
                reviewError: null,
              }).catch(() => {});
              const pr = await prReviewService.getById(entry.prReviewId).catch(() => null);
              if (!entry.projectId && pr?.projectId) {
                entry.projectId = pr.projectId;
              }
              const emitProjectId = entry.projectId || pr?.projectId || null;
              if (emitProjectId) {
                reviewEvents.emit('pr-review-stopped', {
                  projectId: emitProjectId,
                  prReviewId: entry.prReviewId,
                  reviewStatus,
                });
              }
            } else if (entry.type === 'workspace_review') {
              const reviewStatus = await resolveStoppedWorkspaceReviewStatus(entry.projectPath, entry.workspaceReviewId);
              await persistWorkspaceReviewTerminalState(entry.projectPath, entry.workspaceReviewId, {
                reviewStatus,
                reviewError: null,
              }).catch(() => {});
              if (entry.projectId) {
                reviewEvents.emit('workspace-review-stopped', {
                  projectId: entry.projectId,
                  workspaceReviewId: entry.workspaceReviewId,
                  reviewStatus,
                });
              }
            } else {
              await persistChangesetTerminalState(entry.projectPath, entry.changesetId, {
                reviewStatus: 'none',
                reviewError: null,
              }).catch(() => {});
            }
            terminalFailure = null;
            break;
          }

          // ── Watchdog timeout ─────────────────────────────────────
          const watchdogError = abortReason?.isWatchdog
            ? abortReason
            : (error?.isWatchdog ? error : null);
          const shouldRetryWatchdog = Boolean(watchdogError && watchdogAttempt <= normalizedRetryBudget);

          if (shouldRetryWatchdog) {
            const itemId = entry.type === 'branch_review'
              ? entry.branchReviewId
              : entry.type === 'pr_review'
                ? entry.prReviewId
                : entry.type === 'workspace_review'
                  ? entry.workspaceReviewId
                  : entry.changesetId;
            console.warn(
              `[ReviewService] Watchdog retry ${watchdogAttempt}/${normalizedRetryBudget + 1} for ${itemId}: ${watchdogError.message}`
            );
            if (entry.type === 'branch_review') {
              const brRetry = await branchReviewService.getById(entry.branchReviewId).catch(() => null);
              if (!entry.projectId && brRetry?.projectId) {
                entry.projectId = brRetry.projectId;
              }
              const emitProjectId = entry.projectId || brRetry?.projectId || null;
              if (emitProjectId) {
                reviewEvents.emit('branch-review-queued', {
                  projectId: emitProjectId,
                  branchReviewId: entry.branchReviewId,
                  queueId: entry.id,
                  position: 1,
                  retryAttempt: watchdogAttempt,
                  retryReason: watchdogError.message,
                });
                reviewEvents.emit('branch-review-progress', {
                  projectId: emitProjectId,
                  branchReviewId: entry.branchReviewId,
                  phase: 'provider_retry',
                  currentChunk: 0,
                  totalChunks: 0,
                  filesCompleted: 0,
                  totalFiles: 0,
                  elapsedSeconds: 0,
                  retryAttempt: watchdogAttempt,
                  retryMaxAttempts: normalizedRetryBudget + 1,
                  retryDelayMs: 0,
                  error: watchdogError.message,
                });
              }
            }
            entry.status = 'queued';
            updateQueueEntryProgress(entry, {
              phase: 'provider_retry',
              currentChunk: 0,
              totalChunks: 0,
              filesCompleted: 0,
              totalFiles: 0,
              elapsedSeconds: 0,
              retryAttempt: watchdogAttempt,
              retryMaxAttempts: normalizedRetryBudget + 1,
              retryDelayMs: 0,
              error: watchdogError.message,
            }, 'provider_retry');
            terminalFailure = null;
            continue;
          }

          terminalFailure = error;
          break;
        } finally {
          entry._abortController = null;
          clearInterval(watchdogInterval);
        }
      }

      if (terminalFailure) {
        entry.status = 'failed';
        const persistedReviewError = terminalFailure?.persistedReviewError
          ? String(terminalFailure.persistedReviewError)
          : (terminalFailure?.message ? String(terminalFailure.message) : 'Review failed');
        entry.reviewError = persistedReviewError;
        updateQueueEntryProgress(entry, {
          phase: 'failed',
          currentChunk: 0,
          totalChunks: 0,
          filesCompleted: 0,
          totalFiles: 0,
          retryAttempt: watchdogAttempt,
          retryMaxAttempts: normalizedRetryBudget + 1,
          retryDelayMs: 0,
          error: persistedReviewError,
        }, 'failed');
        if (entry.type === 'branch_review') {
          await persistBranchReviewTerminalState(entry.branchReviewId, {
            reviewStatus: 'failed',
            reviewError: persistedReviewError,
          }).catch(() => {});
          const br = await branchReviewService.getById(entry.branchReviewId).catch(() => null);
          if (!entry.projectId && br?.projectId) {
            entry.projectId = br.projectId;
          }
          const emitProjectId = entry.projectId || br?.projectId || null;
          if (emitProjectId) {
            reviewEvents.emit('branch-review-review-failed', {
              projectId: emitProjectId,
              branchReviewId: entry.branchReviewId,
              error: persistedReviewError,
            });
          }
        } else if (entry.type === 'pr_review') {
          await persistPrReviewTerminalState(entry.prReviewId, {
            reviewStatus: 'failed',
            reviewError: persistedReviewError,
          }).catch(() => {});
          const pr = await prReviewService.getById(entry.prReviewId).catch(() => null);
          if (!entry.projectId && pr?.projectId) {
            entry.projectId = pr.projectId;
          }
          const emitProjectId = entry.projectId || pr?.projectId || null;
          if (emitProjectId) {
            reviewEvents.emit('pr-review-review-failed', {
              projectId: emitProjectId,
              prReviewId: entry.prReviewId,
              error: persistedReviewError,
            });
          }
        } else if (entry.type === 'workspace_review') {
          await persistWorkspaceReviewTerminalState(entry.projectPath, entry.workspaceReviewId, {
            reviewStatus: 'failed',
            reviewError: persistedReviewError,
          }).catch(() => {});
          if (entry.projectId) {
            reviewEvents.emit('workspace-review-review-failed', {
              projectId: entry.projectId,
              workspaceReviewId: entry.workspaceReviewId,
              error: persistedReviewError,
            });
          }
        } else {
          await persistChangesetTerminalState(entry.projectPath, entry.changesetId, {
            reviewStatus: 'failed',
            reviewError: persistedReviewError,
          }).catch(() => {});
        }
        const itemId = entry.type === 'branch_review'
          ? entry.branchReviewId
          : entry.type === 'pr_review'
            ? entry.prReviewId
            : entry.type === 'workspace_review'
              ? entry.workspaceReviewId
              : entry.changesetId;
        console.error(`Review failed for ${itemId}:`, persistedReviewError);
      }

      reviewQueue.shift();
    }
  } finally {
    isProcessing = false;
  }
}


// ── Module export ─────────────────────────────────────────────────────────────

export default {
  reviewChangeset,
  reviewBranchReview,
  updateChangeSetReview,
  dismissChangeSetReviewFailure,
  enqueueReview,
  enqueueBranchReview,
  reviewPrReview,
  enqueuePrReview,
  reviewWorkspaceReview,
  enqueueWorkspaceReview,
  cancelReview,
  stopReview,
  cancelQueuedReviewEntry,
  getQueueStatus,
  getQueueEntryStatus,
  markActiveBranchReviewRun,
  touchActiveBranchReviewRun,
  clearActiveBranchReviewRun,
  getActiveBranchReviewRun,
  stopActiveBranchReviewRun,
  refreshLatestBranchReviewHeadForRun,
  events: reviewEvents,
  invalidateIgnorePatternCache,
  buildReviewPrompt,
  parseReviewResponse,
  generateDiffFromFiles,

  __testing: {
    createReviewTiming,
    finalizeReviewTiming,
    parseEnvInteger,
    prioritizeNameStatusEntries,
    selectFilesForFocusedReview,
    estimateFileReviewSize,
    deriveFocusedReviewBudgetConfig,
    chunkFilesForReview,
    createReviewRuntimeError,
    classifyReviewRuntimeError,
    classifyProviderError,
    isLikelyContextWindowError,
    isLikelyModelUnavailableError,
    isLikelyTransientProviderError,
    normalizeReviewModelStrategy,
    parseStoredReviewModelCustom,
    parseStoredReviewModelRollout,
    normalizeReviewModelGatePayload,
    buildAdaptiveThresholdProfile,
    evaluateReviewRunGate,
    buildRoutingDecisionContext,
    resolveEffectiveReviewModel,
    resolveAdaptiveRolloutDecision,
    computeStableRolloutBucket,
    callProviderForReviewWithRetry,
    ReviewDeadlineError,
    annotatePartialReview,
    buildDeadlinePartialAggregate,
    assignReviewTier,
    classifyFileForPerFileReview,
    shouldUsePerFileReviewPath,
    shouldUseChunkedReviewPath,
    resolveChunkCharLimit,
    resolveChunkConcurrency,
    resolvePromptHardLimit,
    resolveSingleReviewDiffLimit,
    resolveProviderExecutionMode,
    resolveProviderReviewExecutionProfile,
    buildPrReviewTerminalUpdatePayload,
    resolveBoundedSchedulerConcurrency,
    buildReviewFileCacheDescriptor,
    buildPersistedReviewErrorMessage,
    buildReviewSettingsFailureMessage,
    normalizeReviewSettingsReadError,
    loadReviewSettingOrThrow,
    getReviewParseMode,
    isDeepParseRecoveryReview,
    logParseRecoveryVisibility,
    parseReviewResponseWithVisibility,
    derivePersistedReviewErrorFromResult,
    getRecommendationBudget,
    normalizeBranchReviewRunMode,
    normalizePrReviewRequestedMode,
    normalizePrReviewRunMode,
    normalizePrReviewPipelineMode,
    isOpenCodeProvider,
    isOpenCodeCliReviewProvider,
    isChunkedCliReviewProvider,
    prioritizeReviewFilesForChunking,
    resolveCliChunkStopThresholdMs,
    resolveOpenCodeChunkStopThresholdMs,
    resolveChunkDeadlinePressureStop,
    shouldUseCliAgenticFastPath,
    shouldAutoUsePrAgenticDiscovery,
    resolveEffectivePrReviewRequestedMode,
    resolveBranchReviewDiffScope,
    resolvePrReviewDiffScope,
    applyDiffScopeMetadata,
    collectReviewFindingCandidates,
    dedupeReviewFindingCandidates,
    summarizePriorReviewFindings,
    collectPreviousUnresolvedBranchFindings,
    attachPreviousUnresolvedBranchFindings,
    applyTimingSnapshotToReviewStats,
    applyPromptContextTelemetryToReviewStats,
    normalizeVerifierDecision,
    normalizeVerifierUnsupportedPolicy,
    applyVerifierDecisionToRecommendation,
    evaluateMediumVerifierExpansionGate,
    runBoundedHighRiskVerifierPass,
    parseHighRiskVerifierDecision,
    applyCorroborationPolicyToReview,
    createCorroborationSourceEvaluator,
    createVerificationLogCorroborationSourceEvaluator,
    applyOutcomeSuppressionPolicyToReview,
    normalizePrecisionIssueCounters,
    applyEvidencePolicyToReview,
    normalizeEvidencePolicyForReview,
    applyPrCommentEligibilityPolicy,
    buildBoundedPromptContextBlocks,
    resolveBranchReviewVerificationStatus,
    collectPromptContextSignals,
    recordFirstSignal,
    buildCliAgentReviewRequest,
    buildCliAgenticReviewPrompt,
    isCliAgenticExecutionEnabled,
    summarizeToolInput,
    computeAgenticMaxTurns,
    preparePrReviewScope,
    runCliAgenticReviewFastPath,
    evaluateAgenticCoverageResult,
    coerceFocusedSelectionForAgenticFallback,
    enforceFinalReviewPolicy,
    resolveProviderExecutionModes,
    normalizeQueueProgress,
    updateQueueEntryProgress,
    createProviderFailoverState,
    buildPrReviewVerificationStatus,
    pathMatchesPattern,
    matchesAnyPattern,
    matchesScopeEntry,
    wildcardToRegex,
    refreshLatestBranchReviewHeadForRun,
    clearReviewQueueForTesting: () => {
      reviewQueue.length = 0;
    },
    seedReviewQueueForTesting: (entries = []) => {
      reviewQueue.length = 0;
      for (const entry of Array.isArray(entries) ? entries : []) {
        reviewQueue.push({
          id: entry.id || `test-${Date.now()}`,
          type: entry.type || 'branch_review',
          projectId: entry.projectId || null,
          projectPath: entry.projectPath || '',
          branchReviewId: entry.branchReviewId || null,
          prReviewId: entry.prReviewId || null,
          changesetId: entry.changesetId || null,
          scope: entry.scope || null,
          reviewMode: entry.reviewMode || 'full',
          policySource: entry.policySource || 'trusted',
          status: entry.status || 'queued',
          queuedAt: entry.queuedAt || new Date().toISOString(),
          updatedAt: entry.updatedAt || new Date().toISOString(),
          progress: entry.progress || null,
          reviewError: entry.reviewError || null,
          autoReviewSnapshot: entry.autoReviewSnapshot || null,
        });
      }
      return reviewQueue.map((entry) => ({ ...entry }));
    },
    getReviewQueueForTesting: () => reviewQueue.map((entry) => ({ ...entry })),
    setReviewQueueEntryStatusForTesting: (entryId, status) => {
      const entry = reviewQueue.find((candidate) => candidate.id === entryId);
      if (!entry) return null;
      entry.status = status;
      return entry;
    },
    setQueueProcessingForTesting: (value) => {
      isProcessing = Boolean(value);
      return isProcessing;
    },
  },
};
