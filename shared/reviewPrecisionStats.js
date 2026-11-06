const REVIEW_STATS_PASSTHROUGH_KEYS = Object.freeze([
  'filesAnalyzed',
  'totalAdditions',
  'totalDeletions',
  'estimatedComplexity',
  'reviewMode',
  'reviewTier',
  'filesDeepReviewed',
  'deepReviewedFiles',
  'filesTotal',
  'totalChangedFiles',
  'omittedFiles',
  'omissionReasons',
  'perFileFailedFiles',
  'perFileFailedPaths',
  'perFileTriageOmittedPaths',
  'perFileCacheHits',
  'perFileCacheMisses',
  'coveragePlanner',
  'chunkCount',
  'isPartial',
  'partialReason',
  'partialChunksCompleted',
  'partialChunksTotal',
  'reviewModelStrategy',
  'reviewModelEffectiveStrategy',
  'reviewModelPolicyVersion',
  'reviewModelDecisionReason',
  'reviewModelFallbackReason',
  'reviewModelBudgetClass',
  'reviewModelThresholdProfile',
  'reviewModelDecisionInputs',
  'reviewModelRollout',
  'reviewModelGate',
  'modelsUsed',
  'modelsChosenByPhase',
  'phaseTimingsMs',
  'reviewTotalDurationMs',
  'firstSignalMs',
  'firstSignalScope',
  'firstSignalChunkIndex',
  'firstSignalTotalChunks',
  'firstSignalFilesCompleted',
  'firstSignalTotalFiles',
  'firstSignalCaptured',
  'promptContextTelemetry',
  'verifierEnabled',
  'verifierMaxFindings',
  'verifierUnsupportedPolicy',
  'verifierChecked',
]);

function toFiniteNumber(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function toLowercaseReasonCodeList(value, maxEntries = 12) {
  if (!Array.isArray(value)) return [];
  const normalized = [];
  for (const entry of value) {
    const reason = String(entry || '').trim().toLowerCase();
    if (!reason) continue;
    normalized.push(reason);
    if (normalized.length >= maxEntries) break;
  }
  return normalized;
}

function normalizeReasonCountMap(value, maxEntries = 32) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([reason, count]) => [
        String(reason || '').trim().toLowerCase(),
        Math.max(0, Math.trunc(toFiniteNumber(count, 0))),
      ])
      .filter(([reason]) => Boolean(reason))
      .slice(0, maxEntries)
  );
}

function pickAllowedReviewStats(stats = {}) {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return {};
  const picked = {};
  for (const key of REVIEW_STATS_PASSTHROUGH_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(stats, key)) continue;
    const value = stats[key];
    if (value === undefined) continue;
    picked[key] = value;
  }
  return picked;
}

export function normalizePrecisionIssueCounters(stats = {}, options = {}) {
  const includePassthrough = options?.includePassthrough === true;
  const sourceStats = (stats && typeof stats === 'object' && !Array.isArray(stats))
    ? stats
    : {};
  const grounded = Math.max(0, Math.trunc(toFiniteNumber(sourceStats.issuesGrounded, 0)));
  const demoted = Math.max(0, Math.trunc(toFiniteNumber(sourceStats.issuesDemoted, 0)));
  const suppressed = Math.max(0, Math.trunc(toFiniteNumber(sourceStats.issuesSuppressed, 0)));
  const declaredTotal = Math.max(0, Math.trunc(toFiniteNumber(sourceStats.issuesTotal, 0)));
  const total = Math.max(declaredTotal, grounded + demoted + suppressed);
  const verifierSupported = Math.max(0, Math.trunc(toFiniteNumber(sourceStats.verifierSupported, 0)));
  const verifierUnsupported = Math.max(0, Math.trunc(toFiniteNumber(sourceStats.verifierUnsupported, 0)));
  const verifierNeedsMoreContext = Math.max(0, Math.trunc(toFiniteNumber(
    sourceStats.verifierNeedsMoreContext ?? sourceStats.verifierNeedsContext,
    0
  )));
  const verifierSkippedBudget = Math.max(0, Math.trunc(toFiniteNumber(sourceStats.verifierSkippedBudget, 0)));
  const verifierMediumEnabled = sourceStats.verifierMediumEnabled === true;
  const verifierMediumMaxFindings = Math.max(0, Math.trunc(toFiniteNumber(sourceStats.verifierMediumMaxFindings, 0)));
  const verifierMediumConsidered = Math.max(0, Math.trunc(toFiniteNumber(sourceStats.verifierMediumConsidered, 0)));
  const verifierMediumChecked = Math.max(0, Math.trunc(toFiniteNumber(sourceStats.verifierMediumChecked, 0)));
  const verifierMediumSkippedBudget = Math.max(0, Math.trunc(toFiniteNumber(sourceStats.verifierMediumSkippedBudget, 0)));
  const verifierMediumGateStatusRaw = String(sourceStats.verifierMediumGateStatus || '').trim().toLowerCase();
  const verifierMediumGateStatus = (
    verifierMediumGateStatusRaw === 'pass'
    || verifierMediumGateStatusRaw === 'blocked'
    || verifierMediumGateStatusRaw === 'disabled'
  )
    ? verifierMediumGateStatusRaw
    : 'disabled';
  const verifierMediumGateReasonCodes = toLowercaseReasonCodeList(sourceStats.verifierMediumGateReasonCodes, 12);
  const corroborationStats = (
    sourceStats.corroboration && typeof sourceStats.corroboration === 'object' && !Array.isArray(sourceStats.corroboration)
  )
    ? sourceStats.corroboration
    : {};
  const corroborationReasonCounts = normalizeReasonCountMap(
    sourceStats.corroborationReasonCounts
    ?? corroborationStats.reasonCounts,
    32
  );
  const corroborationSourceClassCounts = normalizeReasonCountMap(
    sourceStats.corroborationSourceClassCounts
    ?? corroborationStats.sourceClassCounts,
    8
  );
  const corroborationSourceNameCounts = normalizeReasonCountMap(
    sourceStats.corroborationSourceNameCounts
    ?? corroborationStats.sourceNameCounts,
    16
  );
  const corroborationEnabled = sourceStats.corroborationEnabled === undefined
    ? corroborationStats.enabled === true
    : sourceStats.corroborationEnabled === true;
  const corroborationChecked = Math.max(0, Math.trunc(toFiniteNumber(
    sourceStats.corroborationChecked ?? corroborationStats.checked,
    0
  )));
  const corroborationSupported = Math.max(0, Math.trunc(toFiniteNumber(
    sourceStats.corroborationSupported ?? corroborationStats.supported,
    0
  )));
  const corroborationUnsupported = Math.max(0, Math.trunc(toFiniteNumber(
    sourceStats.corroborationUnsupported ?? corroborationStats.unsupported,
    0
  )));
  const corroborationInconclusive = Math.max(0, Math.trunc(toFiniteNumber(
    sourceStats.corroborationInconclusive ?? corroborationStats.inconclusive,
    0
  )));
  const corroborationNotApplicable = Math.max(0, Math.trunc(toFiniteNumber(
    sourceStats.corroborationNotApplicable ?? corroborationStats.notApplicable,
    0
  )));
  const corroborationDowngraded = Math.max(0, Math.trunc(toFiniteNumber(
    sourceStats.corroborationDowngraded ?? corroborationStats.downgraded,
    0
  )));
  const corroborationSecuritySensitiveChecked = Math.max(0, Math.trunc(toFiniteNumber(
    sourceStats.corroborationSecuritySensitiveChecked ?? corroborationStats.securitySensitiveChecked,
    0
  )));
  const reviewOutcomeTelemetry = (
    sourceStats.reviewOutcomeTelemetry && typeof sourceStats.reviewOutcomeTelemetry === 'object' && !Array.isArray(sourceStats.reviewOutcomeTelemetry)
  )
    ? sourceStats.reviewOutcomeTelemetry
    : {};
  const outcomeIssueTotal = Math.max(0, Math.trunc(toFiniteNumber(reviewOutcomeTelemetry.issueTotal, 0)));
  const outcomeIssueDismissed = Math.max(0, Math.trunc(toFiniteNumber(reviewOutcomeTelemetry.issueDismissed, 0)));
  const outcomeIssueAddressed = Math.max(0, Math.trunc(toFiniteNumber(reviewOutcomeTelemetry.issueAddressed, 0)));
  const outcomeSuppression = (
    sourceStats.outcomeSuppression && typeof sourceStats.outcomeSuppression === 'object' && !Array.isArray(sourceStats.outcomeSuppression)
  )
    ? sourceStats.outcomeSuppression
    : {};
  const outcomeSuppressionReasonCounts = normalizeReasonCountMap(
    sourceStats.outcomeSuppressionReasonCounts
      ?? outcomeSuppression.reasonCounts,
    32
  );
  const outcomeSuppressionEnabled = sourceStats.outcomeSuppressionEnabled === undefined
    ? outcomeSuppression.enabled === true
    : sourceStats.outcomeSuppressionEnabled === true;
  const outcomeSuppressionCandidates = Math.max(0, Math.trunc(toFiniteNumber(
    sourceStats.outcomeSuppressionCandidates ?? outcomeSuppression.candidates,
    0
  )));
  const outcomeSuppressionChecked = Math.max(0, Math.trunc(toFiniteNumber(
    sourceStats.outcomeSuppressionChecked ?? outcomeSuppression.checked,
    0
  )));
  const outcomeSuppressionSuppressed = Math.max(0, Math.trunc(toFiniteNumber(
    sourceStats.outcomeSuppressionSuppressed ?? outcomeSuppression.suppressed,
    0
  )));
  const outcomeSuppressionMinSamples = Math.max(1, Math.trunc(toFiniteNumber(
    sourceStats.outcomeSuppressionMinSamples ?? outcomeSuppression.minSamples,
    1
  )));
  const outcomeSuppressionMinDismissedRate = Math.max(0, Math.min(1, toFiniteNumber(
    sourceStats.outcomeSuppressionMinDismissedRate ?? outcomeSuppression.minDismissedRate,
    0
  )));
  const outcomeSuppressionMaxPerRun = Math.max(0, Math.trunc(toFiniteNumber(
    sourceStats.outcomeSuppressionMaxPerRun ?? outcomeSuppression.maxPerRun,
    0
  )));
  const passthroughStats = includePassthrough ? pickAllowedReviewStats(sourceStats) : {};
  return {
    ...passthroughStats,
    issuesTotal: total,
    issuesGrounded: Math.min(grounded, total),
    issuesDemoted: Math.min(demoted, total),
    issuesSuppressed: Math.min(suppressed, total),
    verifierSupported,
    verifierUnsupported,
    verifierNeedsMoreContext,
    verifierNeedsContext: verifierNeedsMoreContext,
    verifierSkippedBudget,
    verifierMediumEnabled,
    verifierMediumMaxFindings,
    verifierMediumConsidered,
    verifierMediumChecked,
    verifierMediumSkippedBudget,
    verifierMediumGateStatus,
    verifierMediumGateReasonCodes,
    corroborationEnabled,
    corroborationChecked,
    corroborationSupported,
    corroborationUnsupported,
    corroborationInconclusive,
    corroborationNotApplicable,
    corroborationDowngraded,
    corroborationSecuritySensitiveChecked,
    corroborationReasonCounts,
    corroborationSourceClassCounts,
    corroborationSourceNameCounts,
    corroboration: {
      enabled: corroborationEnabled,
      checked: corroborationChecked,
      supported: corroborationSupported,
      unsupported: corroborationUnsupported,
      inconclusive: corroborationInconclusive,
      notApplicable: corroborationNotApplicable,
      downgraded: corroborationDowngraded,
      securitySensitiveChecked: corroborationSecuritySensitiveChecked,
      reasonCounts: { ...corroborationReasonCounts },
      sourceClassCounts: { ...corroborationSourceClassCounts },
      sourceNameCounts: { ...corroborationSourceNameCounts },
    },
    reviewOutcomeTelemetry: {
      issueTotal: outcomeIssueTotal,
      issueDismissed: Math.min(outcomeIssueDismissed, outcomeIssueTotal),
      issueAddressed: Math.min(outcomeIssueAddressed, outcomeIssueTotal),
    },
    outcomeSuppressionEnabled,
    outcomeSuppressionCandidates,
    outcomeSuppressionChecked,
    outcomeSuppressionSuppressed,
    outcomeSuppressionMinSamples,
    outcomeSuppressionMinDismissedRate,
    outcomeSuppressionMaxPerRun,
    outcomeSuppressionReasonCounts,
    outcomeSuppression: {
      enabled: outcomeSuppressionEnabled,
      candidates: outcomeSuppressionCandidates,
      checked: outcomeSuppressionChecked,
      suppressed: outcomeSuppressionSuppressed,
      minSamples: outcomeSuppressionMinSamples,
      minDismissedRate: outcomeSuppressionMinDismissedRate,
      maxPerRun: outcomeSuppressionMaxPerRun,
      reasonCounts: { ...outcomeSuppressionReasonCounts },
    },
  };
}

export default {
  normalizePrecisionIssueCounters,
};
