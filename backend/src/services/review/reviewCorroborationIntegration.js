/** Review Corroboration Integration — Corroboration sources, outcome suppression, and evidence policy. */

import {
  REVIEW_CORROBORATION_SOURCE_MODE,
  REVIEW_CORROBORATION_SOURCE_LOG_MAX_CHARS,
  REVIEW_CORROBORATION_SOURCE_TOKEN_MAX,
  REVIEW_OUTCOME_SUPPRESSION_ENABLED,
  REVIEW_OUTCOME_SUPPRESSION_MIN_SAMPLES,
  REVIEW_OUTCOME_SUPPRESSION_MIN_DISMISSED_RATE,
  REVIEW_OUTCOME_SUPPRESSION_MAX_PER_RUN,
  REVIEW_OUTCOME_SUPPRESSION_MAX_KEYS,
  REVIEW_OUTCOME_SUPPRESSION_MAX_ROWS,
  REVIEW_OUTCOME_SUPPRESSION_MAX_ROWS_PER_KEY,
  REVIEW_EVIDENCE_POLICY_DEFAULT,
  OUTCOME_SUPPRESSION_SECURITY_RE,
} from './reviewConstants.js';
import {
  reconcileReviewRiskLevel,
  normalizeRecommendationTypeValue,
  normalizeRiskValue,
} from './reviewPromptBuilder.js';
import { clampNumber } from './reviewHelpers.js';
import { isVerifierDecisionSupported } from './reviewVerifier.js';
import reviewCorroborationService from '../reviewCorroborationService.js';
import reviewOutcomeService from '../reviewOutcomeService.js';
import reviewEvidenceValidator from '../reviewEvidenceValidator.js';
import {
  isLinterFindingMatch,
  normalizeReviewPath,
  scoreLinterIssueSimilarity,
} from './linter/linterFindingSimilarity.js';

// ---------------------------------------------------------------------------
// Corroboration source constants
// ---------------------------------------------------------------------------

const CORROBORATION_SOURCE_CLASS_VALUES = new Set(['deterministic_tool', 'verifier', 'grounding', 'none']);
const CORROBORATION_SOURCE_TOKEN_STOPWORDS = new Set([
  'this',
  'that',
  'with',
  'from',
  'when',
  'where',
  'which',
  'missing',
  'issue',
  'risk',
  'route',
  'file',
  'path',
  'line',
  'code',
  'check',
  'verify',
  'verification',
  'fallback',
  'review',
  'finding',
  'context',
  'high',
  'critical',
  'medium',
  'low',
]);

// ---------------------------------------------------------------------------
// Corroboration count normalization
// ---------------------------------------------------------------------------

function normalizeCorroborationCountMap(value, maxKeys = 20, keyNormalizer = null) {
  const counts = value && typeof value === 'object' ? value : {};
  const normalizeKey = typeof keyNormalizer === 'function'
    ? keyNormalizer
    : (raw) => String(raw || '').trim().toLowerCase();
  const collapsed = {};
  for (const [rawKey, rawCount] of Object.entries(counts)) {
    const normalizedKey = normalizeKey(rawKey);
    if (!normalizedKey) continue;
    collapsed[normalizedKey] = (collapsed[normalizedKey] || 0) + Math.max(0, Math.trunc(Number(rawCount) || 0));
  }
  const normalized = {};
  const sortedKeys = Object.keys(collapsed).sort();
  for (const key of sortedKeys.slice(0, Math.max(1, Math.trunc(Number(maxKeys) || 20)))) {
    normalized[key] = collapsed[key];
  }
  return normalized;
}

function normalizeCorroborationReasonCounts(value, maxKeys = 20) {
  return normalizeCorroborationCountMap(value, maxKeys);
}

function normalizeCorroborationSourceClassCounts(value, maxKeys = 8) {
  return normalizeCorroborationCountMap(
    value,
    maxKeys,
    (raw) => {
      const normalized = String(raw || '').trim().toLowerCase();
      return CORROBORATION_SOURCE_CLASS_VALUES.has(normalized) ? normalized : '';
    }
  );
}

function normalizeCorroborationSourceNameCounts(value, maxKeys = 16) {
  return normalizeCorroborationCountMap(value, maxKeys);
}

function dedupeReasonCodes(reasonCodes = []) {
  const unique = [];
  const seen = new Set();
  for (const rawCode of Array.isArray(reasonCodes) ? reasonCodes : []) {
    const code = String(rawCode || '').trim().toLowerCase();
    if (!code || seen.has(code)) continue;
    seen.add(code);
    unique.push(code);
  }
  return unique;
}

function normalizeRecommendationConfidence(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high') {
    return normalized;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Corroboration source tokens
// ---------------------------------------------------------------------------

function normalizeCorroborationSourceToken(rawToken) {
  const normalized = String(rawToken || '').trim().toLowerCase();
  if (!normalized) return null;
  if (!/^[a-z0-9_./:-]+$/.test(normalized)) return null;
  if (normalized.length < 4) return null;
  if (CORROBORATION_SOURCE_TOKEN_STOPWORDS.has(normalized)) return null;
  return normalized;
}

function buildCorroborationSourceTokens(recommendation, maxItems = REVIEW_CORROBORATION_SOURCE_TOKEN_MAX) {
  const normalizedMaxItems = Math.max(1, Math.trunc(Number(maxItems) || REVIEW_CORROBORATION_SOURCE_TOKEN_MAX));
  const title = String(recommendation?.title || '');
  const description = String(recommendation?.description || '');
  const filePath = String(recommendation?.file || '');
  const combined = `${title} ${description} ${filePath}`.toLowerCase();
  const rawTokens = combined.split(/[^a-z0-9_./:-]+/g).filter(Boolean);
  const unique = [];
  const seen = new Set();
  for (const rawToken of rawTokens) {
    const normalized = normalizeCorroborationSourceToken(rawToken);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(normalized);
    if (unique.length >= normalizedMaxItems) break;
  }
  return unique;
}

// ---------------------------------------------------------------------------
// Corroboration source evaluators
// ---------------------------------------------------------------------------

function createVerificationLogCorroborationSourceEvaluator(verificationStatus, options = {}) {
  const maxLogChars = Math.max(800, Math.trunc(Number(options.maxLogChars) || REVIEW_CORROBORATION_SOURCE_LOG_MAX_CHARS));
  const source = verificationStatus && typeof verificationStatus === 'object'
    ? verificationStatus
    : {};
  const logs = source.logs && typeof source.logs === 'object' ? source.logs : {};
  const checks = ['lint', 'unit', 'e2e'];
  const failingLogs = [];

  for (const check of checks) {
    if (String(source[check] || '').trim().toLowerCase() !== 'fail') continue;
    const rawLog = String(logs[check] || '').trim();
    if (!rawLog) continue;
    const clipped = rawLog.length > maxLogChars
      ? rawLog.slice(-maxLogChars)
      : rawLog;
    const normalized = clipped.toLowerCase();
    if (!normalized) continue;
    failingLogs.push({
      check,
      text: normalized,
    });
  }

  if (failingLogs.length === 0) return null;

  return (recommendation) => {
    const tokens = buildCorroborationSourceTokens(recommendation, REVIEW_CORROBORATION_SOURCE_TOKEN_MAX);
    if (tokens.length === 0) return null;
    for (const logEntry of failingLogs) {
      const matched = tokens.some((token) => logEntry.text.includes(token));
      if (!matched) continue;
      return {
        status: 'supported',
        reason: 'verification_log_match',
        confidence: 'medium',
        sourceClass: 'deterministic_tool',
        sourceName: `verification:${logEntry.check}`,
      };
    }
    return null;
  };
}

function createLinterCorroborationSourceEvaluator(linterFindings, { lineWindow = 3 } = {}) {
  if (!Array.isArray(linterFindings) || linterFindings.length === 0) return null;

  // Build file:line keyed index from linter findings
  const fileIndex = new Map();
  for (const finding of linterFindings) {
    const file = normalizeReviewPath(finding.file);
    if (!file) continue;
    if (!fileIndex.has(file)) fileIndex.set(file, []);
    fileIndex.get(file).push(finding);
  }

  return (recommendation) => {
    if (!recommendation || typeof recommendation !== 'object') return null;
    const recFile = normalizeReviewPath(recommendation.file);
    if (!recFile) return null;

    const exactFindings = fileIndex.get(recFile) || null;
    let pool = exactFindings;
    if (!pool) {
      const suffix = `/${recFile}`;
      const suffixCandidates = [];
      for (const [key, val] of fileIndex) {
        if (key.endsWith(suffix) || recFile.endsWith(`/${key}`)) {
          suffixCandidates.push(...val);
        }
      }
      const candidateFiles = new Set(
        suffixCandidates
          .map((finding) => normalizeReviewPath(finding?.file))
          .filter(Boolean)
      );
      if (candidateFiles.size !== 1) return null;
      pool = suffixCandidates;
    }
    if (!pool || pool.length === 0) return null;

    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestScore = Number.NEGATIVE_INFINITY;
    let isAmbiguousBest = false;

    for (const finding of pool) {
      if (!isLinterFindingMatch(recommendation, finding, { lineWindow, minimumScore: 2 })) continue;
      const distance = Math.abs((Number(recommendation.line) || 0) - (Number(finding.line) || 0));
      const score = scoreLinterIssueSimilarity(recommendation, finding);
      if (
        distance < bestDistance
        || (distance === bestDistance && score > bestScore)
      ) {
        best = finding;
        bestDistance = distance;
        bestScore = score;
        isAmbiguousBest = false;
        continue;
      }
      if (distance === bestDistance && score === bestScore) {
        isAmbiguousBest = true;
      }
    }

    if (!best || isAmbiguousBest) return null;
    return {
      status: 'supported',
      reason: 'deterministic_linter_match',
      confidence: normalizeRecommendationConfidence(best?.confidence) || 'high',
      sourceClass: 'deterministic_tool',
      sourceName: `${best.source || 'linter'}:${best.ruleId || 'unknown'}`,
    };
  };
}

function createCorroborationSourceEvaluator({ verificationStatus = null, linterFindings = [] } = {}) {
  if (REVIEW_CORROBORATION_SOURCE_MODE === 'none') return null;

  const evaluators = [];

  // Linter evaluator takes priority (deterministic > verification logs)
  const linterEvaluator = createLinterCorroborationSourceEvaluator(linterFindings);
  if (linterEvaluator) evaluators.push(linterEvaluator);

  // Verification log evaluator
  if (REVIEW_CORROBORATION_SOURCE_MODE === 'verification_logs') {
    const verificationEvaluator = createVerificationLogCorroborationSourceEvaluator(verificationStatus, {
      maxLogChars: REVIEW_CORROBORATION_SOURCE_LOG_MAX_CHARS,
    });
    if (verificationEvaluator) evaluators.push(verificationEvaluator);
  }

  if (evaluators.length === 0) return null;
  if (evaluators.length === 1) return evaluators[0];

  // Compose: first evaluator to return non-null wins
  return (recommendation) => {
    for (const evaluator of evaluators) {
      const result = evaluator(recommendation);
      if (result) return result;
    }
    return null;
  };
}

// ---------------------------------------------------------------------------
// Corroboration policy
// ---------------------------------------------------------------------------

function applyCorroborationPolicyToReview(reviewResult, options = {}) {
  const applied = reviewCorroborationService.applyCorroborationToReview(reviewResult, {
    enabled: options.enabled !== false,
    allowGroundedFallback: options.allowGroundedFallback !== false,
    downgradeOnUnsupported: options.downgradeOnUnsupported !== false,
    sourceEvaluator: typeof options.sourceEvaluator === 'function'
      ? options.sourceEvaluator
      : null,
  });
  const nextReview = applied?.review && typeof applied.review === 'object'
    ? applied.review
    : reviewResult;
  reconcileReviewRiskLevel(nextReview);
  return nextReview;
}

// ---------------------------------------------------------------------------
// Outcome suppression
// ---------------------------------------------------------------------------

function isOutcomeSuppressionExemptRecommendation(recommendation) {
  if (!recommendation || typeof recommendation !== 'object') return true;
  const type = normalizeRecommendationTypeValue(recommendation.type);
  if (type === 'praise') return true;
  const severity = normalizeRiskValue(recommendation.severity, 'low');
  if (severity === 'critical' || severity === 'high') return true;
  if (recommendation?.corroboration?.isSecuritySensitive === true) return true;
  const combined = `${recommendation.title || ''} ${recommendation.description || ''}`.trim();
  if (combined && OUTCOME_SUPPRESSION_SECURITY_RE.test(combined)) return true;
  return false;
}

async function applyOutcomeSuppressionPolicyToReview(reviewResult, {
  projectId = null,
  providerType = null,
  providerModel = null,
  enabled = REVIEW_OUTCOME_SUPPRESSION_ENABLED,
  minSamples = REVIEW_OUTCOME_SUPPRESSION_MIN_SAMPLES,
  minDismissedRate = REVIEW_OUTCOME_SUPPRESSION_MIN_DISMISSED_RATE,
  maxPerRun = REVIEW_OUTCOME_SUPPRESSION_MAX_PER_RUN,
  maxKeys = REVIEW_OUTCOME_SUPPRESSION_MAX_KEYS,
  maxRows = REVIEW_OUTCOME_SUPPRESSION_MAX_ROWS,
  maxRowsPerKey = REVIEW_OUTCOME_SUPPRESSION_MAX_ROWS_PER_KEY,
} = {}) {
  const source = reviewResult && typeof reviewResult === 'object' ? reviewResult : {};
  const recommendations = Array.isArray(source.recommendations) ? source.recommendations : [];
  const nextStats = source.stats && typeof source.stats === 'object'
    ? { ...source.stats }
    : {};
  const normalizedMinSamples = Math.max(1, Math.trunc(Number(minSamples) || 1));
  const normalizedMinDismissedRate = clampNumber(minDismissedRate, 0, 1);
  const normalizedMaxPerRun = Math.max(0, Math.trunc(Number(maxPerRun) || 0));
  const reasonCounts = {};
  const addReason = (reason) => {
    const key = String(reason || '').trim().toLowerCase().replace(/\s+/g, '_') || 'unknown';
    reasonCounts[key] = (reasonCounts[key] || 0) + 1;
  };

  const normalizedProjectId = typeof projectId === 'string' && projectId.trim()
    ? projectId.trim()
    : null;
  if (!enabled || !normalizedProjectId || recommendations.length === 0 || normalizedMaxPerRun <= 0) {
    nextStats.outcomeSuppressionEnabled = enabled === true;
    nextStats.outcomeSuppressionCandidates = 0;
    nextStats.outcomeSuppressionChecked = 0;
    nextStats.outcomeSuppressionSuppressed = 0;
    nextStats.outcomeSuppressionMinSamples = normalizedMinSamples;
    nextStats.outcomeSuppressionMinDismissedRate = normalizedMinDismissedRate;
    nextStats.outcomeSuppressionMaxPerRun = normalizedMaxPerRun;
    nextStats.outcomeSuppressionReasonCounts = {};
    nextStats.outcomeSuppression = {
      enabled: enabled === true,
      candidates: 0,
      checked: 0,
      suppressed: 0,
      minSamples: normalizedMinSamples,
      minDismissedRate: normalizedMinDismissedRate,
      maxPerRun: normalizedMaxPerRun,
      reasonCounts: {},
    };
    return {
      ...source,
      stats: nextStats,
    };
  }

  const candidates = [];
  const recommendationKeys = [];
  const dimensionsByRecommendationKey = {};
  const seenKeys = new Set();
  for (let index = 0; index < recommendations.length; index += 1) {
    const recommendation = recommendations[index];
    if (!recommendation || typeof recommendation !== 'object') continue;
    if (isOutcomeSuppressionExemptRecommendation(recommendation)) {
      addReason('exempt_recommendation');
      continue;
    }
    let recommendationKey = null;
    try {
      recommendationKey = reviewOutcomeService.getRecommendationIdentityKey(recommendation);
    } catch {
      recommendationKey = null;
    }
    if (!recommendationKey) {
      addReason('key_unavailable');
      continue;
    }
    const recommendationDimensions = reviewOutcomeService.getRecommendationOutcomeDimensions(
      recommendation,
      { providerType, providerModel }
    );
    candidates.push({
      recommendation,
      recommendationKey,
      dimensions: recommendationDimensions,
      index,
    });
    if (!seenKeys.has(recommendationKey) && recommendationKeys.length < Math.max(1, Math.trunc(Number(maxKeys) || 1))) {
      seenKeys.add(recommendationKey);
      recommendationKeys.push(recommendationKey);
      dimensionsByRecommendationKey[recommendationKey] = recommendationDimensions;
    }
  }

  let historicalByRecommendationKey = {};
  try {
    if (recommendationKeys.length > 0) {
      const history = await reviewOutcomeService.listProjectOutcomesByRecommendationKeys(
        normalizedProjectId,
        recommendationKeys,
        {
          maxRows,
          maxPerKey: maxRowsPerKey,
          dimensionsByRecommendationKey,
        }
      );
      historicalByRecommendationKey = history?.byRecommendationKey && typeof history.byRecommendationKey === 'object'
        ? history.byRecommendationKey
        : {};
    }
  } catch (error) {
    addReason('lookup_failed');
    historicalByRecommendationKey = {};
  }

  const shouldSuppressKey = new Set();
  let checked = 0;
  let suppressed = 0;
  let aggregateIssueTotal = 0;
  let aggregateIssueDismissed = 0;
  let aggregateIssueAddressed = 0;

  for (const key of recommendationKeys) {
    const summary = historicalByRecommendationKey[key] && typeof historicalByRecommendationKey[key] === 'object'
      ? historicalByRecommendationKey[key]
      : {};
    const total = Math.max(0, Math.trunc(Number(summary.total) || 0));
    const dismissed = Math.max(0, Math.trunc(Number(summary.dismissed) || 0));
    const addressed = Math.max(0, Math.trunc(Number(summary.addressed) || 0));
    const dismissedRate = total > 0 ? dismissed / total : 0;
    aggregateIssueTotal += total;
    aggregateIssueDismissed += Math.min(dismissed, total);
    aggregateIssueAddressed += Math.min(addressed, total);

    if (total < normalizedMinSamples) {
      addReason('insufficient_samples');
      continue;
    }
    checked += 1;
    if (dismissedRate >= normalizedMinDismissedRate) {
      shouldSuppressKey.add(key);
    } else {
      addReason('dismissed_rate_below_threshold');
    }
  }

  const nextRecommendations = [];
  for (const candidate of candidates) {
    if (suppressed >= normalizedMaxPerRun) break;
    if (!shouldSuppressKey.has(candidate.recommendationKey)) continue;
    candidate.suppressed = true;
    suppressed += 1;
    addReason('dismissed_rate_threshold');
  }

  const suppressedIndexes = new Set(
    candidates.filter((candidate) => candidate.suppressed === true).map((candidate) => candidate.index)
  );
  recommendations.forEach((recommendation, index) => {
    if (suppressedIndexes.has(index)) return;
    nextRecommendations.push(recommendation);
  });

  nextStats.reviewOutcomeTelemetry = {
    issueTotal: aggregateIssueTotal,
    issueDismissed: Math.min(aggregateIssueDismissed, aggregateIssueTotal),
    issueAddressed: Math.min(aggregateIssueAddressed, aggregateIssueTotal),
  };
  nextStats.outcomeSuppressionEnabled = true;
  nextStats.outcomeSuppressionCandidates = candidates.length;
  nextStats.outcomeSuppressionChecked = checked;
  nextStats.outcomeSuppressionSuppressed = suppressed;
  nextStats.outcomeSuppressionMinSamples = normalizedMinSamples;
  nextStats.outcomeSuppressionMinDismissedRate = normalizedMinDismissedRate;
  nextStats.outcomeSuppressionMaxPerRun = normalizedMaxPerRun;
  nextStats.outcomeSuppressionReasonCounts = { ...reasonCounts };
  nextStats.outcomeSuppression = {
    enabled: true,
    candidates: candidates.length,
    checked,
    suppressed,
    minSamples: normalizedMinSamples,
    minDismissedRate: normalizedMinDismissedRate,
    maxPerRun: normalizedMaxPerRun,
    reasonCounts: { ...reasonCounts },
  };

  const nextReview = {
    ...source,
    recommendations: nextRecommendations,
    stats: nextStats,
  };
  reconcileReviewRiskLevel(nextReview);
  return nextReview;
}

// ---------------------------------------------------------------------------
// Precision issue counters
// ---------------------------------------------------------------------------

function normalizePrecisionIssueCounters(reviewResult) {
  if (!reviewResult || typeof reviewResult !== 'object') return reviewResult;
  if (!reviewResult.stats || typeof reviewResult.stats !== 'object') {
    reviewResult.stats = {};
  }
  const stats = reviewResult.stats;
  const grounded = Math.max(0, Math.trunc(Number(stats.issuesGrounded) || 0));
  const demoted = Math.max(0, Math.trunc(Number(stats.issuesDemoted) || 0));
  const suppressed = Math.max(0, Math.trunc(Number(stats.issuesSuppressed) || 0));
  const declaredTotal = Math.max(0, Math.trunc(Number(stats.issuesTotal) || 0));
  const computedTotal = grounded + demoted + suppressed;
  const total = Math.max(declaredTotal, computedTotal);

  stats.issuesTotal = total;
  stats.issuesGrounded = Math.min(grounded, total);
  stats.issuesDemoted = Math.min(demoted, total);
  stats.issuesSuppressed = Math.min(suppressed, total);
  stats.verifierSupported = Math.max(0, Math.trunc(Number(stats.verifierSupported) || 0));
  stats.verifierUnsupported = Math.max(0, Math.trunc(Number(stats.verifierUnsupported) || 0));
  stats.verifierNeedsMoreContext = Math.max(0, Math.trunc(Number(stats.verifierNeedsMoreContext) || 0));
  stats.verifierSkippedBudget = Math.max(0, Math.trunc(Number(stats.verifierSkippedBudget) || 0));
  stats.verifierMediumEnabled = stats.verifierMediumEnabled === true;
  stats.verifierMediumMaxFindings = Math.max(0, Math.trunc(Number(stats.verifierMediumMaxFindings) || 0));
  stats.verifierMediumConsidered = Math.max(0, Math.trunc(Number(stats.verifierMediumConsidered) || 0));
  stats.verifierMediumChecked = Math.max(0, Math.trunc(Number(stats.verifierMediumChecked) || 0));
  stats.verifierMediumSkippedBudget = Math.max(0, Math.trunc(Number(stats.verifierMediumSkippedBudget) || 0));
  {
    const gateStatus = String(stats.verifierMediumGateStatus || '').trim().toLowerCase();
    stats.verifierMediumGateStatus = ['pass', 'blocked', 'disabled'].includes(gateStatus)
      ? gateStatus
      : 'disabled';
  }
  stats.verifierMediumGateReasonCodes = Array.isArray(stats.verifierMediumGateReasonCodes)
    ? stats.verifierMediumGateReasonCodes
        .map((reason) => String(reason || '').trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 12)
    : [];
  if (stats.verifierNeedsContext === undefined) {
    stats.verifierNeedsContext = stats.verifierNeedsMoreContext;
  } else {
    stats.verifierNeedsContext = Math.max(0, Math.trunc(Number(stats.verifierNeedsContext) || 0));
    stats.verifierNeedsMoreContext = Math.max(stats.verifierNeedsMoreContext, stats.verifierNeedsContext);
  }
  const corroborationStats = stats.corroboration && typeof stats.corroboration === 'object'
    ? stats.corroboration
    : {};
  const corroborationReasonCounts = normalizeCorroborationReasonCounts(
    stats.corroborationReasonCounts ?? corroborationStats.reasonCounts,
    32
  );
  const corroborationSourceClassCounts = normalizeCorroborationSourceClassCounts(
    stats.corroborationSourceClassCounts ?? corroborationStats.sourceClassCounts,
    8
  );
  const corroborationSourceNameCounts = normalizeCorroborationSourceNameCounts(
    stats.corroborationSourceNameCounts ?? corroborationStats.sourceNameCounts,
    16
  );
  const corroborationChecked = Math.max(0, Math.trunc(Number(
    stats.corroborationChecked ?? corroborationStats.checked
  ) || 0));
  const corroborationSupported = Math.max(0, Math.trunc(Number(
    stats.corroborationSupported ?? corroborationStats.supported
  ) || 0));
  const corroborationUnsupported = Math.max(0, Math.trunc(Number(
    stats.corroborationUnsupported ?? corroborationStats.unsupported
  ) || 0));
  const corroborationNotApplicable = Math.max(0, Math.trunc(Number(
    stats.corroborationNotApplicable ?? corroborationStats.notApplicable
  ) || 0));
  const corroborationDowngraded = Math.max(0, Math.trunc(Number(
    stats.corroborationDowngraded ?? corroborationStats.downgraded
  ) || 0));
  const corroborationSecuritySensitiveChecked = Math.max(0, Math.trunc(Number(
    stats.corroborationSecuritySensitiveChecked ?? corroborationStats.securitySensitiveChecked
  ) || 0));
  const corroborationEnabled = stats.corroborationEnabled === undefined
    ? (corroborationStats.enabled === true)
    : stats.corroborationEnabled === true;
  stats.corroborationEnabled = corroborationEnabled;
  stats.corroborationChecked = corroborationChecked;
  stats.corroborationSupported = corroborationSupported;
  stats.corroborationUnsupported = corroborationUnsupported;
  stats.corroborationNotApplicable = corroborationNotApplicable;
  stats.corroborationDowngraded = corroborationDowngraded;
  stats.corroborationSecuritySensitiveChecked = corroborationSecuritySensitiveChecked;
  stats.corroborationReasonCounts = corroborationReasonCounts;
  stats.corroborationSourceClassCounts = corroborationSourceClassCounts;
  stats.corroborationSourceNameCounts = corroborationSourceNameCounts;
  stats.corroboration = {
    enabled: corroborationEnabled,
    checked: corroborationChecked,
    supported: corroborationSupported,
    unsupported: corroborationUnsupported,
    notApplicable: corroborationNotApplicable,
    downgraded: corroborationDowngraded,
    securitySensitiveChecked: corroborationSecuritySensitiveChecked,
    reasonCounts: { ...corroborationReasonCounts },
    sourceClassCounts: { ...corroborationSourceClassCounts },
    sourceNameCounts: { ...corroborationSourceNameCounts },
  };
  const reviewOutcomeTelemetry = stats.reviewOutcomeTelemetry && typeof stats.reviewOutcomeTelemetry === 'object'
    ? stats.reviewOutcomeTelemetry
    : {};
  const issueTotal = Math.max(0, Math.trunc(Number(reviewOutcomeTelemetry.issueTotal) || 0));
  const issueDismissed = Math.max(0, Math.trunc(Number(reviewOutcomeTelemetry.issueDismissed) || 0));
  const issueAddressed = Math.max(0, Math.trunc(Number(reviewOutcomeTelemetry.issueAddressed) || 0));
  stats.reviewOutcomeTelemetry = {
    issueTotal,
    issueDismissed: Math.min(issueDismissed, issueTotal),
    issueAddressed: Math.min(issueAddressed, issueTotal),
  };

  const suppressionStats = stats.outcomeSuppression && typeof stats.outcomeSuppression === 'object'
    ? stats.outcomeSuppression
    : {};
  const suppressionReasonCounts = normalizeCorroborationReasonCounts(
    stats.outcomeSuppressionReasonCounts ?? suppressionStats.reasonCounts,
    32
  );
  const suppressionEnabled = stats.outcomeSuppressionEnabled === undefined
    ? suppressionStats.enabled === true
    : stats.outcomeSuppressionEnabled === true;
  const suppressionCandidates = Math.max(0, Math.trunc(Number(
    stats.outcomeSuppressionCandidates ?? suppressionStats.candidates
  ) || 0));
  const suppressionChecked = Math.max(0, Math.trunc(Number(
    stats.outcomeSuppressionChecked ?? suppressionStats.checked
  ) || 0));
  const suppressionSuppressed = Math.max(0, Math.trunc(Number(
    stats.outcomeSuppressionSuppressed ?? suppressionStats.suppressed
  ) || 0));
  const suppressionMinSamples = Math.max(1, Math.trunc(Number(
    stats.outcomeSuppressionMinSamples ?? suppressionStats.minSamples
  ) || REVIEW_OUTCOME_SUPPRESSION_MIN_SAMPLES));
  const suppressionMinDismissedRate = clampNumber(
    stats.outcomeSuppressionMinDismissedRate ?? suppressionStats.minDismissedRate,
    0,
    1
  );
  const suppressionMaxPerRun = Math.max(0, Math.trunc(Number(
    stats.outcomeSuppressionMaxPerRun ?? suppressionStats.maxPerRun
  ) || REVIEW_OUTCOME_SUPPRESSION_MAX_PER_RUN));
  stats.outcomeSuppressionEnabled = suppressionEnabled;
  stats.outcomeSuppressionCandidates = suppressionCandidates;
  stats.outcomeSuppressionChecked = suppressionChecked;
  stats.outcomeSuppressionSuppressed = suppressionSuppressed;
  stats.outcomeSuppressionMinSamples = suppressionMinSamples;
  stats.outcomeSuppressionMinDismissedRate = suppressionMinDismissedRate;
  stats.outcomeSuppressionMaxPerRun = suppressionMaxPerRun;
  stats.outcomeSuppressionReasonCounts = suppressionReasonCounts;
  stats.outcomeSuppression = {
    enabled: suppressionEnabled,
    candidates: suppressionCandidates,
    checked: suppressionChecked,
    suppressed: suppressionSuppressed,
    minSamples: suppressionMinSamples,
    minDismissedRate: suppressionMinDismissedRate,
    maxPerRun: suppressionMaxPerRun,
    reasonCounts: { ...suppressionReasonCounts },
  };
  return reviewResult;
}

// ---------------------------------------------------------------------------
// Evidence policy
// ---------------------------------------------------------------------------

function normalizeEvidencePolicyForReview(policy) {
  return reviewEvidenceValidator.normalizeEvidencePolicy(policy, REVIEW_EVIDENCE_POLICY_DEFAULT);
}

function applyEvidencePolicyToReview(reviewResult, {
  diffText = '',
  filePaths = [],
  policy = null,
} = {}) {
  const normalizedPolicy = normalizeEvidencePolicyForReview(policy);
  const applied = reviewEvidenceValidator.applyEvidencePolicyToReview(reviewResult, {
    diffText,
    allowedFilePaths: Array.isArray(filePaths) ? filePaths : [],
    policy: normalizedPolicy,
  });
  normalizePrecisionIssueCounters(applied.review);
  return {
    ...applied,
    policy: normalizedPolicy,
  };
}

// ---------------------------------------------------------------------------
// PR comment eligibility
// ---------------------------------------------------------------------------

function evaluatePrCommentEligibility(recommendation) {
  const rec = recommendation && typeof recommendation === 'object'
    ? recommendation
    : {};
  const reasonCodes = [];
  const type = normalizeRecommendationTypeValue(rec.type);
  const file = typeof rec.file === 'string' && rec.file.trim()
    ? rec.file.trim()
    : null;
  const line = Number.isFinite(Number(rec.line)) && Number(rec.line) > 0
    ? Math.floor(Number(rec.line))
    : null;
  const corroborationStatus = String(rec?.corroboration?.status || '').trim().toLowerCase();
  const explicitConfidence = normalizeRecommendationConfidence(rec.confidence);
  const derivedConfidence = explicitConfidence
    || (corroborationStatus === 'supported' ? 'medium' : null)
    || (isVerifierDecisionSupported(rec.verifierDecision) ? 'medium' : null);

  if (type === 'praise') {
    reasonCodes.push('not_actionable_type');
  }
  if (!file) {
    reasonCodes.push('missing_file');
  }
  if (!line) {
    reasonCodes.push('missing_line');
  }
  if (rec.evidenceMissing === true || rec?.grounding?.grounded === false) {
    reasonCodes.push('ungrounded');
  }
  if (derivedConfidence !== 'medium' && derivedConfidence !== 'high') {
    reasonCodes.push('low_confidence');
  }
  if (rec.verifierDecision != null && !isVerifierDecisionSupported(rec.verifierDecision)) {
    reasonCodes.push('verifier_not_supported');
  }
  if (
    corroborationStatus
    && corroborationStatus !== 'supported'
    && corroborationStatus !== 'not_applicable'
  ) {
    reasonCodes.push('corroboration_not_supported');
  }

  return {
    eligible: reasonCodes.length === 0,
    confidence: derivedConfidence,
    reasonCodes: dedupeReasonCodes(reasonCodes),
    file,
    line,
  };
}

function applyPrCommentEligibilityPolicy(reviewResult) {
  const source = reviewResult && typeof reviewResult === 'object' ? reviewResult : {};
  const recommendations = Array.isArray(source.recommendations) ? source.recommendations : [];
  const stats = source.stats && typeof source.stats === 'object'
    ? { ...source.stats }
    : {};
  const reasonCounts = {};
  let totalFindings = 0;
  let eligibleFindings = 0;

  const nextRecommendations = recommendations.map((recommendation) => {
    const eligibility = evaluatePrCommentEligibility(recommendation);
    totalFindings += 1;
    if (eligibility.eligible) {
      eligibleFindings += 1;
    } else {
      for (const reasonCode of eligibility.reasonCodes) {
        reasonCounts[reasonCode] = (reasonCounts[reasonCode] || 0) + 1;
      }
    }
    return {
      ...recommendation,
      commentEligible: eligibility.eligible,
      commentEligibility: {
        eligible: eligibility.eligible,
        confidence: eligibility.confidence,
        reasonCodes: [...eligibility.reasonCodes],
      },
    };
  });

  const withheldFindings = Math.max(0, totalFindings - eligibleFindings);
  stats.commentEligibility = {
    totalFindings,
    eligibleFindings,
    withheldFindings,
    reasonCounts: normalizeCorroborationReasonCounts(reasonCounts, 20),
  };

  return {
    ...source,
    recommendations: nextRecommendations,
    stats,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export {
  CORROBORATION_SOURCE_CLASS_VALUES,
  CORROBORATION_SOURCE_TOKEN_STOPWORDS,
  normalizeCorroborationCountMap,
  normalizeCorroborationReasonCounts,
  normalizeCorroborationSourceClassCounts,
  normalizeCorroborationSourceNameCounts,
  normalizeCorroborationSourceToken,
  buildCorroborationSourceTokens,
  createVerificationLogCorroborationSourceEvaluator,
  createLinterCorroborationSourceEvaluator,
  createCorroborationSourceEvaluator,
  applyCorroborationPolicyToReview,
  isOutcomeSuppressionExemptRecommendation,
  applyOutcomeSuppressionPolicyToReview,
  normalizePrecisionIssueCounters,
  normalizeEvidencePolicyForReview,
  applyEvidencePolicyToReview,
  evaluatePrCommentEligibility,
  applyPrCommentEligibilityPolicy,
};
