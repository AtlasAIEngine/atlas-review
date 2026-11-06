/** Review Model Config — Model routing, strategy, rollout, and gate evaluation. */

import { createHash } from 'crypto';
import {
  DEFAULT_REVIEW_MODEL_ADAPTIVE,
  DEFAULT_REVIEW_MODEL_CONFIG,
  DEFAULT_REVIEW_MODEL_ROLLOUT,
  REVIEW_MODEL_ADAPTIVE_SETTING_KEY,
  REVIEW_MODEL_CONFIG_CACHE_TTL_MS,
  REVIEW_MODEL_CUSTOM_SETTING_KEY,
  REVIEW_MODEL_PHASES,
  REVIEW_MODEL_ROLLOUT_SETTING_KEY,
  REVIEW_MODEL_ROUTING_POLICY_VERSION,
  REVIEW_MODEL_STRATEGY_SETTING_KEY,
  REVIEW_RUN_GATE_MAX_DISMISSED_ISSUE_RATE,
  REVIEW_RUN_GATE_MAX_DURATION_MS,
  REVIEW_RUN_GATE_MAX_DURATION_CLI_AGENTIC_MS,
  REVIEW_RUN_GATE_MAX_DURATION_CLI_AGENTIC_LARGE_MS,
  REVIEW_RUN_GATE_MAX_FIRST_SIGNAL_MS,
  REVIEW_RUN_GATE_MAX_FIRST_SIGNAL_CLI_AGENTIC_MS,
  REVIEW_RUN_GATE_MAX_LOW_EVIDENCE_ISSUE_RATE,
  REVIEW_RUN_GATE_MAX_OUTCOME_SUPPRESSION_RATE,
  REVIEW_RUN_GATE_MAX_UNCORROBORATED_HIGH_RISK_RATE,
  REVIEW_RUN_GATE_MAX_UNSUPPORTED_ISSUE_RATE,
  REVIEW_RUN_GATE_MIN_COVERAGE_FILE_COUNT,
  REVIEW_RUN_GATE_MIN_DEEP_COVERAGE_RATE,
  REVIEW_RUN_GATE_WARN_OMITTED_RATE,
  VALID_REVIEW_MODEL_GATE_STATUSES,
  VALID_REVIEW_MODEL_ROLLOUT_MODES,
  VALID_REVIEW_MODEL_STRATEGIES,
  VALID_RISK_LEVELS,
} from './reviewConstants.js';
import { clampNumber } from './reviewHelpers.js';
import { parseBooleanSetting } from './reviewIgnorePatterns.js';
import {
  HIGH_RISK_ROUTING_FLAG_KEYS,
  normalizeRoutingRiskFlags,
} from './riskFlagHeuristics.js';
import { extractPrecisionMetricsFromStats } from '../reviewPrecisionMetrics.js';
import { createSettingsReadError } from './reviewErrors.js';
import providerService from '../providerService.js';
import db from '../../db/connection.js';

// ── Cache state ─────────────────────────────────────────────────────────────

let reviewModelConfigCache = {
  config: DEFAULT_REVIEW_MODEL_CONFIG,
  expiresAt: 0,
};

// ── Exported functions ──────────────────────────────────────────────────────

function cloneReviewModelConfig(config) {
  const strategy = normalizeReviewModelStrategy(config?.strategy);
  const customModels = { ...(config?.customModels || {}) };
  const adaptive = parseStoredReviewModelAdaptive(config?.adaptive || {});
  const rollout = parseStoredReviewModelRollout(config?.rollout || {});
  return {
    strategy,
    customModels,
    adaptive,
    rollout,
  };
}

function normalizeReviewModelStrategy(value) {
  if (typeof value !== 'string') return DEFAULT_REVIEW_MODEL_CONFIG.strategy;
  const normalized = value.trim().toLowerCase();
  return VALID_REVIEW_MODEL_STRATEGIES.includes(normalized)
    ? normalized
    : DEFAULT_REVIEW_MODEL_CONFIG.strategy;
}

function parseStoredReviewModelCustom(rawValue) {
  if (!rawValue) return {};

  let parsed = rawValue;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return {};
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {};
  }

  const out = {};
  for (const phase of REVIEW_MODEL_PHASES) {
    const value = parsed[phase];
    if (typeof value === 'string' && value.trim()) {
      out[phase] = value.trim();
    }
  }
  return out;
}

function toClampedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function parseStoredReviewModelAdaptive(rawValue) {
  if (!rawValue) return { ...DEFAULT_REVIEW_MODEL_ADAPTIVE };

  let parsed = rawValue;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return { ...DEFAULT_REVIEW_MODEL_ADAPTIVE };
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...DEFAULT_REVIEW_MODEL_ADAPTIVE };
  }

  const fastPathMaxFiles = toClampedInteger(
    parsed.fastPathMaxFiles,
    DEFAULT_REVIEW_MODEL_ADAPTIVE.fastPathMaxFiles,
    1,
    200
  );
  const fastPathMaxDiffChars = toClampedInteger(
    parsed.fastPathMaxDiffChars,
    DEFAULT_REVIEW_MODEL_ADAPTIVE.fastPathMaxDiffChars,
    2000,
    1000000
  );
  const preferQualityOnHighRisk = parseBooleanSetting(
    parsed.preferQualityOnHighRisk,
    DEFAULT_REVIEW_MODEL_ADAPTIVE.preferQualityOnHighRisk
  );

  return {
    fastPathMaxFiles,
    fastPathMaxDiffChars,
    preferQualityOnHighRisk,
  };
}

function normalizeRolloutAllowlist(value) {
  if (!value) return [];
  const source = Array.isArray(value) ? value : String(value).split(/[\n,]/);
  const deduped = new Set();
  for (const entry of source) {
    const normalized = String(entry || '').trim().toLowerCase();
    if (!normalized) continue;
    deduped.add(normalized);
    if (deduped.size >= 100) break;
  }
  return Array.from(deduped);
}

function normalizeReasonCodeList(value, maxItems = 20) {
  if (!value) return [];
  const source = Array.isArray(value) ? value : String(value).split(/[\n,\s]+/);
  const deduped = new Set();
  for (const entry of source) {
    const normalized = String(entry || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_:-]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!normalized) continue;
    deduped.add(normalized);
    if (deduped.size >= maxItems) break;
  }
  return Array.from(deduped);
}

function normalizeReviewModelGatePayload(rawValue, fallback = DEFAULT_REVIEW_MODEL_ROLLOUT.gate) {
  const parsed = (rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue))
    ? rawValue
    : {};
  const rawStatus = typeof parsed.status === 'string'
    ? parsed.status.trim().toLowerCase()
    : '';
  const status = VALID_REVIEW_MODEL_GATE_STATUSES.includes(rawStatus)
    ? rawStatus
    : fallback.status;
  const source = typeof parsed.source === 'string' && parsed.source.trim()
    ? parsed.source.trim().toLowerCase().slice(0, 64)
    : fallback.source;
  const evaluatedAt = typeof parsed.evaluatedAt === 'string' && parsed.evaluatedAt.trim()
    ? parsed.evaluatedAt.trim()
    : null;
  return {
    status,
    reasonCodes: normalizeReasonCodeList(parsed.reasonCodes, 20),
    source,
    evaluatedAt,
  };
}

function parseStoredReviewModelRollout(rawValue) {
  if (!rawValue) {
    return {
      ...DEFAULT_REVIEW_MODEL_ROLLOUT,
      gate: { ...DEFAULT_REVIEW_MODEL_ROLLOUT.gate },
    };
  }

  let parsed = rawValue;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return {
        ...DEFAULT_REVIEW_MODEL_ROLLOUT,
        gate: { ...DEFAULT_REVIEW_MODEL_ROLLOUT.gate },
      };
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ...DEFAULT_REVIEW_MODEL_ROLLOUT,
      gate: { ...DEFAULT_REVIEW_MODEL_ROLLOUT.gate },
    };
  }

  const rawMode = typeof parsed.mode === 'string' ? parsed.mode.trim().toLowerCase() : '';
  const mode = VALID_REVIEW_MODEL_ROLLOUT_MODES.includes(rawMode)
    ? rawMode
    : DEFAULT_REVIEW_MODEL_ROLLOUT.mode;
  const canaryPercent = toClampedInteger(
    parsed.canaryPercent,
    DEFAULT_REVIEW_MODEL_ROLLOUT.canaryPercent,
    0,
    100
  );
  const projectAllowlist = normalizeRolloutAllowlist(parsed.projectAllowlist);

  return {
    mode,
    canaryPercent,
    projectAllowlist,
    gate: normalizeReviewModelGatePayload(parsed.gate),
  };
}

function buildRolloutSeedInput(decisionContext = {}) {
  const parts = [
    decisionContext?.projectId,
    decisionContext?.reviewType,
    decisionContext?.reviewId,
    decisionContext?.branchName,
    decisionContext?.baseBranch,
    decisionContext?.headSha,
    decisionContext?.mergeBaseSha,
    decisionContext?.fileCount,
    decisionContext?.diffChars,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  if (parts.length === 0) return 'global';
  return parts.join('|');
}

function computeStableRolloutBucket(seedInput = 'global') {
  const hash = createHash('sha256').update(seedInput).digest('hex');
  const upper32 = Number.parseInt(hash.slice(0, 8), 16);
  if (!Number.isFinite(upper32)) return 0;
  return Math.floor((upper32 / 0x100000000) * 100);
}

function resolveAdaptiveRolloutDecision(reviewModelConfig = DEFAULT_REVIEW_MODEL_CONFIG, decisionContext = {}) {
  const rollout = parseStoredReviewModelRollout(reviewModelConfig?.rollout || {});
  const projectId = String(decisionContext?.projectId || '').trim().toLowerCase();
  const normalizedAllowlist = normalizeRolloutAllowlist(rollout.projectAllowlist);
  const allowlistEnabled = normalizedAllowlist.length > 0;
  const allowlistMatch = !allowlistEnabled || (projectId && normalizedAllowlist.includes(projectId));
  const seedInput = buildRolloutSeedInput(decisionContext);
  const canaryBucket = computeStableRolloutBucket(seedInput);
  const canaryPercent = Number(rollout.canaryPercent || 0);
  const gate = normalizeReviewModelGatePayload(
    rollout.gate,
    DEFAULT_REVIEW_MODEL_ROLLOUT.gate
  );

  if (!allowlistMatch) {
    return {
      mode: rollout.mode,
      enabled: false,
      reason: 'rollout_allowlist_excluded',
      canaryBucket,
      canaryPercent,
      allowlistEnabled,
      allowlistMatched: false,
      seedInput,
      gate,
    };
  }

  if (gate.status === 'fail') {
    return {
      mode: rollout.mode,
      enabled: false,
      reason: 'rollout_gate_failed',
      canaryBucket,
      canaryPercent,
      allowlistEnabled,
      allowlistMatched: true,
      seedInput,
      gate,
    };
  }

  if (gate.status === 'warn' && rollout.mode === 'on') {
    return {
      mode: rollout.mode,
      enabled: false,
      reason: 'rollout_gate_warn',
      canaryBucket,
      canaryPercent,
      allowlistEnabled,
      allowlistMatched: true,
      seedInput,
      gate,
    };
  }

  if (rollout.mode === 'off') {
    return {
      mode: rollout.mode,
      enabled: false,
      reason: 'rollout_off',
      canaryBucket,
      canaryPercent,
      allowlistEnabled,
      allowlistMatched: true,
      seedInput,
      gate,
    };
  }

  if (rollout.mode === 'shadow') {
    return {
      mode: rollout.mode,
      enabled: false,
      reason: 'rollout_shadow',
      canaryBucket,
      canaryPercent,
      allowlistEnabled,
      allowlistMatched: true,
      seedInput,
      gate,
    };
  }

  if (rollout.mode === 'canary') {
    const enabled = canaryBucket < canaryPercent;
    return {
      mode: rollout.mode,
      enabled,
      reason: enabled ? 'rollout_canary_selected' : 'rollout_canary_skipped',
      canaryBucket,
      canaryPercent,
      allowlistEnabled,
      allowlistMatched: true,
      seedInput,
      gate,
    };
  }

  return {
    mode: rollout.mode,
    enabled: true,
    reason: 'rollout_on',
    canaryBucket,
    canaryPercent,
    allowlistEnabled,
    allowlistMatched: true,
    seedInput,
    gate,
  };
}

function normalizeAdaptiveDecisionInputs(rawContext = {}) {
  const fileCount = toClampedInteger(rawContext.fileCount, 0, 0, 100000);
  const diffChars = toClampedInteger(rawContext.diffChars, 0, 0, 50000000);
  const normalizedRiskLevel = VALID_RISK_LEVELS.includes(rawContext.riskLevel)
    ? rawContext.riskLevel
    : null;
  const focusedReview = parseBooleanSetting(rawContext.focusedReview, false);

  const riskFlags = rawContext.riskFlags && typeof rawContext.riskFlags === 'object'
    ? rawContext.riskFlags
    : {};
  const highRiskHints = Boolean(
    rawContext.highRiskHints
    || normalizedRiskLevel === 'high'
    || normalizedRiskLevel === 'critical'
    || riskFlags.dependencyChanges
    || riskFlags.envChanges
    || riskFlags.buildConfigChanges
    || riskFlags.largeBlastRadius
    || riskFlags.securitySensitive
  );
  const costAwareHighRiskHints = Boolean(
    rawContext.highRiskHints
    || normalizedRiskLevel === 'high'
    || normalizedRiskLevel === 'critical'
    || HIGH_RISK_ROUTING_FLAG_KEYS.some((key) => Boolean(riskFlags[key]))
  );

  return {
    fileCount,
    diffChars,
    riskLevel: normalizedRiskLevel,
    highRiskHints,
    costAwareHighRiskHints,
    focusedReview,
  };
}

function deriveReviewModelBudgetClass({
  strategy = 'smart',
  effectiveStrategy = 'smart',
  decisionReason = '',
}) {
  const normalizedStrategy = normalizeReviewModelStrategy(effectiveStrategy || strategy);
  const reason = String(decisionReason || '').trim().toLowerCase();

  if (normalizedStrategy === 'max_quality') return 'quality';
  if (normalizedStrategy === 'latency_first') return 'latency';
  if (normalizedStrategy === 'custom') return 'custom';
  if (normalizedStrategy === 'performance') return 'balanced';

  if (normalizedStrategy === 'adaptive') {
    if (reason.includes('quality_path')) return 'quality';
    if (reason.includes('fast_path') || reason.includes('triage_default')) return 'latency';
    return 'balanced';
  }

  if (normalizedStrategy === 'smart') {
    if (reason.includes('triage_default') || reason.includes('walkthrough_default')) return 'latency';
    return 'balanced';
  }

  return 'balanced';
}

function buildReviewRunGateThresholds(overrides = null) {
  const parsed = (overrides && typeof overrides === 'object' && !Array.isArray(overrides))
    ? overrides
    : {};
  const minDeepCoverageRate = Number.isFinite(Number(parsed.minDeepCoverageRate))
    ? Number(parsed.minDeepCoverageRate)
    : REVIEW_RUN_GATE_MIN_DEEP_COVERAGE_RATE;
  const warnOmittedRate = Number.isFinite(Number(parsed.warnOmittedRate))
    ? Number(parsed.warnOmittedRate)
    : REVIEW_RUN_GATE_WARN_OMITTED_RATE;
  const maxUnsupportedIssueRate = Number.isFinite(Number(parsed.maxUnsupportedIssueRate))
    ? Number(parsed.maxUnsupportedIssueRate)
    : REVIEW_RUN_GATE_MAX_UNSUPPORTED_ISSUE_RATE;
  const maxLowEvidenceIssueRate = Number.isFinite(Number(parsed.maxLowEvidenceIssueRate))
    ? Number(parsed.maxLowEvidenceIssueRate)
    : REVIEW_RUN_GATE_MAX_LOW_EVIDENCE_ISSUE_RATE;
  const maxDismissedIssueRate = Number.isFinite(Number(parsed.maxDismissedIssueRate))
    ? Number(parsed.maxDismissedIssueRate)
    : REVIEW_RUN_GATE_MAX_DISMISSED_ISSUE_RATE;
  const maxUncorroboratedHighRiskRate = Number.isFinite(Number(parsed.maxUncorroboratedHighRiskRate))
    ? Number(parsed.maxUncorroboratedHighRiskRate)
    : REVIEW_RUN_GATE_MAX_UNCORROBORATED_HIGH_RISK_RATE;
  const maxOutcomeSuppressionRate = Number.isFinite(Number(parsed.maxOutcomeSuppressionRate))
    ? Number(parsed.maxOutcomeSuppressionRate)
    : REVIEW_RUN_GATE_MAX_OUTCOME_SUPPRESSION_RATE;
  return {
    minCoverageFileCount: toClampedInteger(
      parsed.minCoverageFileCount,
      REVIEW_RUN_GATE_MIN_COVERAGE_FILE_COUNT,
      1,
      5000
    ),
    minDeepCoverageRate: clampNumber(minDeepCoverageRate, 0, 1),
    warnOmittedRate: clampNumber(warnOmittedRate, 0, 1),
    maxDurationMs: toClampedInteger(
      parsed.maxDurationMs,
      REVIEW_RUN_GATE_MAX_DURATION_MS,
      1000,
      3600000
    ),
    maxFirstSignalMs: toClampedInteger(
      parsed.maxFirstSignalMs,
      REVIEW_RUN_GATE_MAX_FIRST_SIGNAL_MS,
      1000,
      3600000
    ),
    maxUnsupportedIssueRate: clampNumber(maxUnsupportedIssueRate, 0, 1),
    maxLowEvidenceIssueRate: clampNumber(maxLowEvidenceIssueRate, 0, 1),
    maxDismissedIssueRate: clampNumber(maxDismissedIssueRate, 0, 1),
    maxUncorroboratedHighRiskRate: clampNumber(maxUncorroboratedHighRiskRate, 0, 1),
    maxOutcomeSuppressionRate: clampNumber(maxOutcomeSuppressionRate, 0, 1),
  };
}

function evaluateReviewRunGate(reviewResult = {}, options = {}) {
  // Detect agentic execution mode from stats to select appropriate duration/signal thresholds
  const resultStats = (reviewResult?.stats && typeof reviewResult.stats === 'object')
    ? reviewResult.stats
    : {};
  const isAgenticExecution = resultStats.executionMode === 'cli-agentic' || resultStats.agenticReview === true;
  const agenticTier = typeof resultStats.agenticTier === 'string'
    ? resultStats.agenticTier.trim().toLowerCase()
    : '';

  const effectiveMaxDurationMs = isAgenticExecution
    ? (agenticTier === 'large'
      ? REVIEW_RUN_GATE_MAX_DURATION_CLI_AGENTIC_LARGE_MS
      : REVIEW_RUN_GATE_MAX_DURATION_CLI_AGENTIC_MS)
    : REVIEW_RUN_GATE_MAX_DURATION_MS;
  const effectiveMaxFirstSignalMs = isAgenticExecution
    ? REVIEW_RUN_GATE_MAX_FIRST_SIGNAL_CLI_AGENTIC_MS
    : REVIEW_RUN_GATE_MAX_FIRST_SIGNAL_MS;

  const thresholds = buildReviewRunGateThresholds(options?.thresholds || {
    minCoverageFileCount: REVIEW_RUN_GATE_MIN_COVERAGE_FILE_COUNT,
    minDeepCoverageRate: REVIEW_RUN_GATE_MIN_DEEP_COVERAGE_RATE,
    warnOmittedRate: REVIEW_RUN_GATE_WARN_OMITTED_RATE,
    maxDurationMs: effectiveMaxDurationMs,
    maxFirstSignalMs: effectiveMaxFirstSignalMs,
    maxUnsupportedIssueRate: REVIEW_RUN_GATE_MAX_UNSUPPORTED_ISSUE_RATE,
    maxLowEvidenceIssueRate: REVIEW_RUN_GATE_MAX_LOW_EVIDENCE_ISSUE_RATE,
    maxDismissedIssueRate: REVIEW_RUN_GATE_MAX_DISMISSED_ISSUE_RATE,
    maxUncorroboratedHighRiskRate: REVIEW_RUN_GATE_MAX_UNCORROBORATED_HIGH_RISK_RATE,
    maxOutcomeSuppressionRate: REVIEW_RUN_GATE_MAX_OUTCOME_SUPPRESSION_RATE,
  });
  const stats = (reviewResult?.stats && typeof reviewResult.stats === 'object')
    ? reviewResult.stats
    : {};
  const timing = (reviewResult?.timing && typeof reviewResult.timing === 'object')
    ? reviewResult.timing
    : {};

  const totalFiles = Math.max(0, Math.trunc(Number(
    stats.totalChangedFiles ?? stats.filesTotal ?? stats.filesAnalyzed ?? 0
  ) || 0));
  const deepReviewedFiles = Math.max(0, Math.trunc(Number(
    stats.deepReviewedFiles ?? stats.filesDeepReviewed ?? stats.filesAnalyzed ?? 0
  ) || 0));
  const declaredOmittedFiles = Math.max(0, Math.trunc(Number(stats.omittedFiles || 0) || 0));
  const inferredOmittedFiles = Math.max(0, totalFiles - deepReviewedFiles);
  const omittedFiles = Math.max(declaredOmittedFiles, inferredOmittedFiles);
  const deepCoverageRate = totalFiles > 0 ? Math.max(0, Math.min(1, 1 - (omittedFiles / totalFiles))) : 1;
  const omittedRate = totalFiles > 0 ? Math.max(0, Math.min(1, omittedFiles / totalFiles)) : 0;
  const durationMs = Math.max(0, Number(timing.totalMs ?? stats.totalDurationMs ?? 0) || 0);
  const firstSignalMs = Math.max(0, Number(stats.firstSignalMs ?? timing.firstSignalMs ?? 0) || 0);
  const hasFirstSignal = Number.isFinite(firstSignalMs) && firstSignalMs > 0;
  const tier = typeof stats.reviewTier === 'string' ? stats.reviewTier.trim().toLowerCase() : '';
  const isPartial = Boolean(stats.isPartial) || tier === 'partial' || tier === 'files_only';
  const precisionMetrics = extractPrecisionMetricsFromStats(stats);
  const unsupportedIssueRate = precisionMetrics.unsupportedIssueRate;
  const lowEvidenceIssueRate = precisionMetrics.lowEvidenceIssueRate;
  const dismissedIssueRate = precisionMetrics.dismissedIssueRate;
  const uncorroboratedHighRiskRate = precisionMetrics.uncorroboratedHighRiskRate;
  const outcomeSuppressionRate = precisionMetrics.outcomeSuppressionRate;
  const hasUnsupportedIssueRate = Number.isFinite(unsupportedIssueRate);
  const hasLowEvidenceIssueRate = Number.isFinite(lowEvidenceIssueRate);
  const hasDismissedIssueRate = Number.isFinite(dismissedIssueRate);
  const hasUncorroboratedHighRiskRate = Number.isFinite(uncorroboratedHighRiskRate);
  const hasOutcomeSuppressionRate = Number.isFinite(outcomeSuppressionRate);

  const criticalReasonCodes = [];
  const warningReasonCodes = [];
  const coverageRequired = totalFiles >= thresholds.minCoverageFileCount;

  if (durationMs <= 0) {
    criticalReasonCodes.push('gate_telemetry_missing_duration');
  } else if (durationMs > thresholds.maxDurationMs) {
    criticalReasonCodes.push('gate_duration_exceeded');
  }

  if (coverageRequired && !Number.isFinite(deepCoverageRate)) {
    criticalReasonCodes.push('gate_telemetry_missing_deep_coverage');
  } else if (coverageRequired && deepCoverageRate < thresholds.minDeepCoverageRate) {
    criticalReasonCodes.push('gate_deep_coverage_below_floor');
  }

  if (coverageRequired && !hasFirstSignal) {
    criticalReasonCodes.push('gate_telemetry_missing_first_signal');
  } else if (coverageRequired && hasFirstSignal && firstSignalMs > thresholds.maxFirstSignalMs) {
    warningReasonCodes.push('gate_first_signal_slow');
  }

  if (isPartial) {
    criticalReasonCodes.push('gate_partial_review');
  }

  if (omittedRate > thresholds.warnOmittedRate) {
    warningReasonCodes.push('gate_omitted_rate_high');
  }

  if (hasUnsupportedIssueRate && unsupportedIssueRate > thresholds.maxUnsupportedIssueRate) {
    criticalReasonCodes.push('gate_precision_unsupported_issue_rate_high');
  }

  if (hasLowEvidenceIssueRate && lowEvidenceIssueRate > thresholds.maxLowEvidenceIssueRate) {
    criticalReasonCodes.push('gate_precision_low_evidence_issue_rate_high');
  }

  if (hasDismissedIssueRate && dismissedIssueRate > thresholds.maxDismissedIssueRate) {
    warningReasonCodes.push('gate_precision_dismissed_issue_rate_high');
  }

  if (
    hasUncorroboratedHighRiskRate
    && uncorroboratedHighRiskRate > thresholds.maxUncorroboratedHighRiskRate
  ) {
    criticalReasonCodes.push('gate_precision_uncorroborated_high_risk_rate_high');
  }

  if (
    hasOutcomeSuppressionRate
    && outcomeSuppressionRate > thresholds.maxOutcomeSuppressionRate
  ) {
    warningReasonCodes.push('gate_precision_outcome_suppression_rate_high');
  }

  const reasonCodes = Array.from(new Set([
    ...criticalReasonCodes,
    ...warningReasonCodes,
  ]));
  const status = criticalReasonCodes.length > 0
    ? 'fail'
    : warningReasonCodes.length > 0
      ? 'warn'
      : 'pass';

  return {
    status,
    reasonCodes,
    criticalReasonCodes,
    warningReasonCodes,
    source: 'runtime',
    evaluatedAt: new Date().toISOString(),
    thresholds,
    metrics: {
      totalFiles,
      deepReviewedFiles,
      omittedFiles,
      deepCoverageRate,
      omittedRate,
      durationMs,
      firstSignalMs: hasFirstSignal ? firstSignalMs : null,
      isPartial,
      unsupportedIssueRate: hasUnsupportedIssueRate ? unsupportedIssueRate : null,
      lowEvidenceIssueRate: hasLowEvidenceIssueRate ? lowEvidenceIssueRate : null,
      dismissedIssueRate: hasDismissedIssueRate ? dismissedIssueRate : null,
      uncorroboratedHighRiskRate: hasUncorroboratedHighRiskRate ? uncorroboratedHighRiskRate : null,
      outcomeSuppressionRate: hasOutcomeSuppressionRate ? outcomeSuppressionRate : null,
      precisionIssueSampleCount: precisionMetrics.samples.precisionIssues,
      verifierSampleCount: precisionMetrics.samples.verifier,
      dismissalSampleCount: precisionMetrics.samples.dismissal,
      corroborationSampleCount: precisionMetrics.samples.corroboration,
      suppressionSampleCount: precisionMetrics.samples.suppression,
    },
  };
}

function buildAdaptiveThresholdProfile(adaptiveConfig = {}) {
  const adaptiveFastPathMaxFiles = toClampedInteger(
    adaptiveConfig.fastPathMaxFiles,
    DEFAULT_REVIEW_MODEL_ADAPTIVE.fastPathMaxFiles,
    1,
    200
  );
  const adaptiveFastPathMaxDiffChars = toClampedInteger(
    adaptiveConfig.fastPathMaxDiffChars,
    DEFAULT_REVIEW_MODEL_ADAPTIVE.fastPathMaxDiffChars,
    2000,
    1000000
  );
  const preferQualityOnHighRisk = parseBooleanSetting(
    adaptiveConfig.preferQualityOnHighRisk,
    DEFAULT_REVIEW_MODEL_ADAPTIVE.preferQualityOnHighRisk
  );

  const latencyFirstReviewMaxFiles = adaptiveFastPathMaxFiles;
  const latencyFirstReviewMaxDiffChars = adaptiveFastPathMaxDiffChars;
  const latencyFirstSynthesisMaxFiles = Math.max(1, Math.floor(adaptiveFastPathMaxFiles / 2));
  const latencyFirstSynthesisMaxDiffChars = Math.max(1000, Math.floor(adaptiveFastPathMaxDiffChars / 2));

  return {
    adaptive: {
      fastPathMaxFiles: adaptiveFastPathMaxFiles,
      fastPathMaxDiffChars: adaptiveFastPathMaxDiffChars,
      preferQualityOnHighRisk,
    },
    latencyFirst: {
      reviewMaxFiles: latencyFirstReviewMaxFiles,
      reviewMaxDiffChars: latencyFirstReviewMaxDiffChars,
      synthesisMaxFiles: latencyFirstSynthesisMaxFiles,
      synthesisMaxDiffChars: latencyFirstSynthesisMaxDiffChars,
      guardHighRisk: true,
    },
  };
}

async function getGlobalReviewModelConfig() {
  const now = Date.now();
  if (reviewModelConfigCache.expiresAt > now) {
    return cloneReviewModelConfig(reviewModelConfigCache.config);
  }

  try {
    const [strategyResult, customResult, adaptiveResult, rolloutResult] = await Promise.all([
      db.query('SELECT value FROM settings WHERE id = $1', [REVIEW_MODEL_STRATEGY_SETTING_KEY]),
      db.query('SELECT value FROM settings WHERE id = $1', [REVIEW_MODEL_CUSTOM_SETTING_KEY]),
      db.query('SELECT value FROM settings WHERE id = $1', [REVIEW_MODEL_ADAPTIVE_SETTING_KEY]),
      db.query('SELECT value FROM settings WHERE id = $1', [REVIEW_MODEL_ROLLOUT_SETTING_KEY]),
    ]);

    const strategy = normalizeReviewModelStrategy(strategyResult.rows?.[0]?.value || null);
    const customModels = parseStoredReviewModelCustom(customResult.rows?.[0]?.value || null);
    const adaptive = parseStoredReviewModelAdaptive(adaptiveResult.rows?.[0]?.value || null);
    const rollout = parseStoredReviewModelRollout(rolloutResult.rows?.[0]?.value || null);
    const config = { strategy, customModels, adaptive, rollout };

    reviewModelConfigCache = {
      config,
      expiresAt: now + REVIEW_MODEL_CONFIG_CACHE_TTL_MS,
    };
    return cloneReviewModelConfig(config);
  } catch (error) {
    throw createSettingsReadError({
      settingKey: 'review_model_config',
      settingLabel: 'review model routing settings',
      operation: 'read review model routing settings',
      cause: error,
    });
  }
}

function resolveEffectiveReviewModel(
  providerData,
  phase = 'review',
  reviewModelConfig = DEFAULT_REVIEW_MODEL_CONFIG,
  decisionContext = {}
) {
  const provider = providerData?.provider || {};
  const providerType = typeof provider.type === 'string' ? provider.type.trim() : '';
  const providerModel = typeof provider.model === 'string' && provider.model.trim()
    ? provider.model.trim()
    : null;
  const normalizedPhase = REVIEW_MODEL_PHASES.includes(phase) ? phase : 'review';
  const strategy = normalizeReviewModelStrategy(reviewModelConfig?.strategy);
  const customModels = parseStoredReviewModelCustom(reviewModelConfig?.customModels || {});
  const adaptiveConfig = parseStoredReviewModelAdaptive(reviewModelConfig?.adaptive || {});
  const thresholdProfile = buildAdaptiveThresholdProfile(adaptiveConfig);
  const rolloutDecision = resolveAdaptiveRolloutDecision(reviewModelConfig, decisionContext);
  const decisionInputs = normalizeAdaptiveDecisionInputs(decisionContext);
  const isReviewLikePhase = normalizedPhase === 'review' || normalizedPhase === 'verifier';
  const providerUsesCli = (
    providerData?.useClaudeCLI
    || providerData?.useCodexCLI
    || providerData?.useGeminiCLI
    || providerData?.useOpenCodeCLI
    || provider?.source === 'cli_detected'
  );
  const smartModelTransport = providerUsesCli ? 'cli' : 'api';

  const resolveSmartModel = (targetPhase) => (typeof providerService.getSmartReviewModel === 'function'
    ? providerService.getSmartReviewModel(providerType, targetPhase, {
      transport: smartModelTransport,
    })
    : null);
  const resolveCostAwareModel = (targetPhase) => (typeof providerService.getCostAwareReviewModel === 'function'
    ? providerService.getCostAwareReviewModel(providerType, targetPhase, {
      transport: smartModelTransport,
    })
    : null);
  // Codex CLI account entitlements are discovered per user, so quality phases
  // use the detected runnable model. Keep triage and walkthrough on the CLI
  // phase defaults so cheap/fast routing stays intact.
  const cliOpenAiDetectedModel = providerUsesCli && providerType === 'openai' ? providerModel : null;
  const resolveSmartModelForPhase = (targetPhase) => {
    if (
      cliOpenAiDetectedModel
      && (targetPhase === 'review' || targetPhase === 'synthesis' || targetPhase === 'verifier')
    ) {
      return cliOpenAiDetectedModel;
    }
    return resolveSmartModel(targetPhase);
  };
  const smartModel = resolveSmartModelForPhase(normalizedPhase);
  const smartTriageModel = resolveSmartModelForPhase('triage');
  const smartReviewModel = resolveSmartModelForPhase('review');
  const smartSynthesisModel = resolveSmartModelForPhase('synthesis');
  const smartLatencyGuardrailModel = smartSynthesisModel || smartReviewModel;
  const costAwareReviewModel = resolveCostAwareModel('review');
  const costAwareSynthesisModel = resolveCostAwareModel('synthesis');
  const costAwareVerifierModel = resolveCostAwareModel('verifier');
  const providerDefaultModel = typeof providerService.getProviderDefaultModel === 'function'
    ? providerService.getProviderDefaultModel(providerType)
    : null;
  const providerHasKnownModel = (model) => {
    if (!model || typeof providerService.isKnownProviderModel !== 'function') return false;
    return providerService.isKnownProviderModel(providerType, model);
  };

  // Balanced (smart) contract, also used as the adaptive rollout-disabled
  // fallback so both paths stay aligned. Auxiliary phases keep cheap
  // defaults; review-class phases honor the user's selection. Risk-based
  // variation is confined to the 'adaptive' branch.
  const resolveSmartPreferredModel = (phase) => {
    if (phase === 'triage' || phase === 'walkthrough') {
      return smartModel || providerModel;
    }
    return providerModel || smartModel;
  };

  let preferredModel = providerModel;
  let decisionReason = 'provider_default';
  let effectiveStrategy = strategy;
  if (strategy === 'smart' || strategy === 'performance') {
    preferredModel = resolveSmartPreferredModel(normalizedPhase);
    const reasonPrefix = strategy === 'performance' ? 'performance' : 'smart';
    decisionReason = (normalizedPhase === 'triage' || normalizedPhase === 'walkthrough')
      ? `${reasonPrefix}_${normalizedPhase}_default`
      : strategy === 'performance'
        ? 'performance_user_selected_model'
        : 'balanced_user_selected_model';
  } else if (strategy === 'latency_first') {
    const reviewFastPathEligible = (
      decisionInputs.fileCount > 0
      && decisionInputs.fileCount <= thresholdProfile.latencyFirst.reviewMaxFiles
      && decisionInputs.diffChars > 0
      && decisionInputs.diffChars <= thresholdProfile.latencyFirst.reviewMaxDiffChars
      && !decisionInputs.highRiskHints
    );
    const synthesisFastPathEligible = (
      decisionInputs.fileCount > 0
      && decisionInputs.fileCount <= thresholdProfile.latencyFirst.synthesisMaxFiles
      && decisionInputs.diffChars > 0
      && decisionInputs.diffChars <= thresholdProfile.latencyFirst.synthesisMaxDiffChars
      && !decisionInputs.highRiskHints
    );
    if (normalizedPhase === 'triage') {
      preferredModel = smartTriageModel || providerModel;
      decisionReason = 'latency_first_triage';
    } else if (isReviewLikePhase) {
      preferredModel = reviewFastPathEligible
        ? (smartTriageModel || smartReviewModel || providerModel)
        : (smartLatencyGuardrailModel || providerModel);
      decisionReason = reviewFastPathEligible
        ? 'latency_first_fast_path'
        : 'latency_first_guardrail_quality_path';
    } else {
      preferredModel = synthesisFastPathEligible
        ? (smartTriageModel || smartSynthesisModel || providerModel)
        : (smartSynthesisModel || providerModel);
      decisionReason = synthesisFastPathEligible
        ? 'latency_first_synthesis_fast_path'
        : 'latency_first_synthesis_guardrail_quality_path';
    }
  } else if (strategy === 'max_quality') {
    preferredModel = providerModel || providerDefaultModel || smartReviewModel || smartModel;
    decisionReason = 'max_quality_all_phases';
  } else if (strategy === 'custom') {
    preferredModel = customModels[normalizedPhase] || smartModel || providerModel;
    decisionReason = customModels[normalizedPhase] ? 'custom_override' : `custom_fallback_${normalizedPhase}`;
  } else if (strategy === 'adaptive') {
    if (!rolloutDecision.enabled) {
      effectiveStrategy = 'smart';
      preferredModel = resolveSmartPreferredModel(normalizedPhase);
      decisionReason = rolloutDecision.reason;
    } else {
      const fastPathEligible = (
        decisionInputs.fileCount > 0
        && decisionInputs.fileCount <= thresholdProfile.adaptive.fastPathMaxFiles
        && decisionInputs.diffChars > 0
        && decisionInputs.diffChars <= thresholdProfile.adaptive.fastPathMaxDiffChars
        && (!thresholdProfile.adaptive.preferQualityOnHighRisk || !decisionInputs.costAwareHighRiskHints)
      );
      const synthesisFastEligible = (
        decisionInputs.fileCount > 0
        && decisionInputs.fileCount <= Math.max(1, Math.floor(thresholdProfile.adaptive.fastPathMaxFiles / 2))
        && decisionInputs.diffChars > 0
        && decisionInputs.diffChars <= Math.max(1000, Math.floor(thresholdProfile.adaptive.fastPathMaxDiffChars / 2))
        && (!thresholdProfile.adaptive.preferQualityOnHighRisk || !decisionInputs.costAwareHighRiskHints)
      );
      if (normalizedPhase === 'triage') {
        preferredModel = smartTriageModel || providerModel;
        decisionReason = 'adaptive_triage_default';
      } else if (isReviewLikePhase) {
        const fastPathReviewModel = normalizedPhase === 'verifier'
          ? (costAwareVerifierModel || costAwareReviewModel)
          : costAwareReviewModel;
        preferredModel = fastPathEligible
          ? (fastPathReviewModel || smartReviewModel || providerModel)
          : (smartReviewModel || providerModel);
        decisionReason = fastPathEligible ? 'adaptive_fast_path' : 'adaptive_quality_path';
      } else {
        preferredModel = synthesisFastEligible
          ? (costAwareSynthesisModel || smartSynthesisModel || providerModel)
          : (smartSynthesisModel || providerModel);
        decisionReason = synthesisFastEligible ? 'adaptive_synthesis_fast_path' : 'adaptive_synthesis_quality_path';
      }
    }
  }

  const fallbackModel = providerModel || smartModel || providerDefaultModel || preferredModel || null;
  const candidate = typeof preferredModel === 'string' && preferredModel.trim()
    ? preferredModel.trim()
    : null;

  // When validation rejects the candidate, walk known candidates explicitly.
  // The previous fallbackModel chain leads with providerModel, which is the
  // most likely value to be stale (user-stored or CLI-detected) — returning
  // it can hand back the same unknown model the guard just rejected. Prefer
  // smartModel and providerDefaultModel (statically configured) first.
  const resolveKnownProviderFallback = () => {
    const candidates = [smartModel, providerDefaultModel, providerModel];
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim() && providerHasKnownModel(c.trim())) {
        return c.trim();
      }
    }
    return fallbackModel;
  };
  const budgetClass = deriveReviewModelBudgetClass({
    strategy,
    effectiveStrategy,
    decisionReason,
  });
  const adaptiveRolloutFallbackReason = (
    strategy === 'adaptive'
    && !rolloutDecision.enabled
    && typeof rolloutDecision.reason === 'string'
    && rolloutDecision.reason.trim()
  )
    ? rolloutDecision.reason.trim()
    : null;

  if (!candidate) {
    return {
      phase: normalizedPhase,
      strategy,
      effectiveStrategy,
      model: fallbackModel,
      fallback: Boolean(adaptiveRolloutFallbackReason),
      fallbackReason: adaptiveRolloutFallbackReason,
      policyVersion: REVIEW_MODEL_ROUTING_POLICY_VERSION,
      decisionInputs,
      decisionReason,
      budgetClass,
      rollout: rolloutDecision,
      thresholdProfile,
    };
  }

  // For known providers, constrain to known model list and fail safe to provider default.
  if (providerType && typeof providerService.isKnownProviderModel === 'function' && !providerHasKnownModel(candidate)) {
    if (strategy === 'custom') {
      return {
        phase: normalizedPhase,
        strategy,
        effectiveStrategy,
        model: resolveKnownProviderFallback(),
        fallback: true,
        fallbackReason: 'custom_model_unavailable',
        policyVersion: REVIEW_MODEL_ROUTING_POLICY_VERSION,
        decisionInputs,
        decisionReason: 'custom_model_unavailable',
        budgetClass,
        rollout: rolloutDecision,
        thresholdProfile,
      };
    }
    const fallbackReason = strategy === 'adaptive'
      ? 'adaptive_model_unavailable'
      : strategy === 'latency_first'
        ? 'latency_first_model_unavailable'
      : strategy === 'max_quality'
        ? 'max_quality_model_unavailable'
      : strategy === 'performance'
        ? 'performance_model_unavailable'
      : 'smart_model_unavailable';
    return {
      phase: normalizedPhase,
      strategy,
      effectiveStrategy,
      model: resolveKnownProviderFallback(),
      fallback: true,
      fallbackReason,
      policyVersion: REVIEW_MODEL_ROUTING_POLICY_VERSION,
      decisionInputs,
      decisionReason: fallbackReason,
      budgetClass,
      rollout: rolloutDecision,
      thresholdProfile,
    };
  }

  // Block models marked reviewCapable: false in PROVIDER_CONFIGS.
  // Walkthrough remains exempt because it is structural narration. Triage still
  // emits structured routing JSON, so it uses the same reliability guard as
  // review/synthesis/verifier.
  if (
    normalizedPhase !== 'walkthrough'
    && typeof providerService.isModelReviewCapable === 'function'
    && !providerService.isModelReviewCapable(providerType, candidate)
  ) {
    const candidates = [smartModel, providerDefaultModel, fallbackModel];
    const replacement = candidates.find(m => m && providerService.isModelReviewCapable(providerType, m)) || fallbackModel;
    const fallbackReason = 'model_blocked_unreliable_json';
    const fallbackBudgetClass = effectiveStrategy === 'max_quality'
      ? 'quality'
      : effectiveStrategy === 'custom'
        ? 'custom'
        : 'balanced';
    return {
      phase: normalizedPhase,
      strategy,
      effectiveStrategy,
      model: replacement,
      fallback: true,
      fallbackReason,
      policyVersion: REVIEW_MODEL_ROUTING_POLICY_VERSION,
      decisionInputs,
      decisionReason,
      budgetClass: fallbackBudgetClass,
      rollout: rolloutDecision,
      thresholdProfile,
    };
  }

  return {
    phase: normalizedPhase,
    strategy,
    effectiveStrategy,
    model: candidate,
    fallback: Boolean(adaptiveRolloutFallbackReason),
    fallbackReason: adaptiveRolloutFallbackReason,
    policyVersion: REVIEW_MODEL_ROUTING_POLICY_VERSION,
    decisionInputs,
    decisionReason,
    budgetClass,
    rollout: rolloutDecision,
    thresholdProfile,
  };
}

function estimateDiffCharsForFiles(files = []) {
  if (!Array.isArray(files) || files.length === 0) return 0;
  let total = 0;
  for (const file of files) {
    const before = typeof file?.before === 'string' ? file.before.length : 0;
    const after = typeof file?.after === 'string' ? file.after.length : 0;
    total += before + after + 80;
  }
  return total;
}

function buildRoutingDecisionContext({
  files = [],
  riskFlags = {},
  riskLevel = null,
  diffChars = null,
  fallbackFileCount = null,
  focusedReview = false,
  projectId = null,
  projectPath = null,
  reviewType = null,
  reviewId = null,
  branchName = null,
  baseBranch = null,
  headSha = null,
  mergeBaseSha = null,
} = {}) {
  const normalizedFiles = Array.isArray(files) ? files : [];
  const normalizedRiskFlags = (riskFlags && typeof riskFlags === 'object') ? riskFlags : {};
  const fileCount = Number.isFinite(Number(fallbackFileCount))
    ? Math.max(0, Number(fallbackFileCount))
    : normalizedFiles.length;
  const computedDiffChars = Number.isFinite(Number(diffChars))
    ? Math.max(0, Number(diffChars))
    : estimateDiffCharsForFiles(normalizedFiles);

  return {
    fileCount,
    diffChars: computedDiffChars,
    riskFlags: normalizeRoutingRiskFlags(normalizedRiskFlags, normalizedFiles),
    riskLevel: VALID_RISK_LEVELS.includes(riskLevel) ? riskLevel : null,
    focusedReview: parseBooleanSetting(focusedReview, false),
    projectId: projectId ? String(projectId).trim() : null,
    reviewType: reviewType ? String(reviewType).trim() : null,
    reviewId: reviewId ? String(reviewId).trim() : null,
    branchName: branchName ? String(branchName).trim() : null,
    baseBranch: baseBranch ? String(baseBranch).trim() : null,
    headSha: headSha ? String(headSha).trim() : null,
    mergeBaseSha: mergeBaseSha ? String(mergeBaseSha).trim() : null,
    projectPath: projectPath ? String(projectPath).trim() : null,
  };
}

// ── Named exports ───────────────────────────────────────────────────────────

export {
  // Internal helpers re-exported for reviewService.js use
  parseBooleanSetting,
  toClampedInteger,

  // Core config functions
  cloneReviewModelConfig,
  normalizeReviewModelStrategy,
  parseStoredReviewModelCustom,
  parseStoredReviewModelAdaptive,
  parseStoredReviewModelRollout,
  normalizeReviewModelGatePayload,

  // Rollout / canary / allowlist
  normalizeRolloutAllowlist,
  normalizeReasonCodeList,
  buildRolloutSeedInput,
  computeStableRolloutBucket,
  resolveAdaptiveRolloutDecision,

  // Adaptive decision inputs / thresholds
  normalizeAdaptiveDecisionInputs,
  buildAdaptiveThresholdProfile,
  deriveReviewModelBudgetClass,

  // Run gate
  buildReviewRunGateThresholds,
  evaluateReviewRunGate,

  // Global config cache
  getGlobalReviewModelConfig,

  // Model resolution
  resolveEffectiveReviewModel,

  // Routing decision context
  estimateDiffCharsForFiles,
  buildRoutingDecisionContext,

  // Cache reference (for direct manipulation / invalidation)
  reviewModelConfigCache,
};
