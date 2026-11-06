function toNonNegativeInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

function toRate(numerator, denominator) {
  if (!Number.isFinite(denominator) || denominator <= 0) return null;
  return Math.max(0, Math.min(1, Number(numerator) / Number(denominator)));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasDirectPrecisionTelemetry(payload) {
  if (!isPlainObject(payload)) return false;
  return [
    'issuesTotal',
    'issuesGrounded',
    'issuesDemoted',
    'issuesSuppressed',
    'verifierSupported',
    'verifierUnsupported',
    'verifierNeedsMoreContext',
    'verifierNeedsContext',
    'corroborationChecked',
    'corroborationUnsupported',
    'corroborationDowngraded',
    'outcomeSuppressionCandidates',
    'outcomeSuppressionSuppressed',
    'reviewOutcomeTelemetry',
    'outcomeTelemetry',
  ].some((key) => payload[key] != null);
}

function normalizeStatsPayload(rawStats = {}) {
  if (!isPlainObject(rawStats)) return {};
  const nestedStats = isPlainObject(rawStats.stats) ? rawStats.stats : null;
  if (!nestedStats) return rawStats;
  if (hasDirectPrecisionTelemetry(rawStats)) return rawStats;
  return nestedStats;
}

function normalizeReviewOutcomeTelemetry(rawTelemetry = null) {
  if (!rawTelemetry || typeof rawTelemetry !== 'object' || Array.isArray(rawTelemetry)) {
    return {
      issueTotal: 0,
      issueDismissed: 0,
      issueAddressed: 0,
    };
  }
  const telemetry = rawTelemetry;
  const issueTotal = toNonNegativeInt(telemetry.issueTotal ?? telemetry.total ?? 0);
  const issueDismissed = toNonNegativeInt(telemetry.issueDismissed ?? telemetry.dismissed ?? 0);
  const issueAddressed = toNonNegativeInt(telemetry.issueAddressed ?? telemetry.addressed ?? 0);
  return {
    issueTotal,
    issueDismissed: Math.min(issueDismissed, issueTotal),
    issueAddressed: Math.min(issueAddressed, issueTotal),
  };
}

export function extractPrecisionMetricsFromStats(rawStats = {}) {
  const stats = normalizeStatsPayload(rawStats);

  const issuesGrounded = toNonNegativeInt(stats.issuesGrounded);
  const issuesDemoted = toNonNegativeInt(stats.issuesDemoted);
  const issuesSuppressed = toNonNegativeInt(stats.issuesSuppressed);
  const declaredIssuesTotal = toNonNegativeInt(stats.issuesTotal);
  const computedIssuesTotal = issuesGrounded + issuesDemoted + issuesSuppressed;
  const issuesTotal = Math.max(declaredIssuesTotal, computedIssuesTotal);

  const verifierSupported = toNonNegativeInt(stats.verifierSupported);
  const verifierUnsupported = toNonNegativeInt(stats.verifierUnsupported);
  const verifierNeedsMoreContext = toNonNegativeInt(
    stats.verifierNeedsMoreContext ?? stats.verifierNeedsContext
  );
  const verifierTotal = verifierSupported + verifierUnsupported + verifierNeedsMoreContext;

  const lowEvidenceIssueCount = Math.min(
    issuesTotal,
    toNonNegativeInt(issuesDemoted + issuesSuppressed)
  );
  const unsupportedIssueRate = toRate(verifierUnsupported, verifierTotal);
  const lowEvidenceIssueRate = toRate(lowEvidenceIssueCount, issuesTotal);

  const outcomeTelemetry = normalizeReviewOutcomeTelemetry(
    stats.reviewOutcomeTelemetry ?? stats.outcomeTelemetry ?? null
  );
  const dismissedIssueRate = toRate(outcomeTelemetry.issueDismissed, outcomeTelemetry.issueTotal);
  const corroborationChecked = toNonNegativeInt(
    stats.corroborationChecked ?? stats.corroboration?.checked
  );
  const corroborationUnsupported = toNonNegativeInt(
    stats.corroborationUnsupported ?? stats.corroboration?.unsupported
  );
  const corroborationDowngraded = toNonNegativeInt(
    stats.corroborationDowngraded ?? stats.corroboration?.downgraded
  );
  const uncorroboratedHighRiskRate = toRate(corroborationUnsupported, corroborationChecked);
  const outcomeSuppressionCandidates = toNonNegativeInt(
    stats.outcomeSuppressionCandidates ?? stats.outcomeSuppression?.candidates
  );
  const outcomeSuppressionSuppressed = toNonNegativeInt(
    stats.outcomeSuppressionSuppressed ?? stats.outcomeSuppression?.suppressed
  );
  const outcomeSuppressionRate = toRate(
    outcomeSuppressionSuppressed,
    outcomeSuppressionCandidates
  );

  return {
    issuesTotal,
    issuesGrounded,
    issuesDemoted,
    issuesSuppressed,
    lowEvidenceIssueCount,
    lowEvidenceIssueRate,
    verifierSupported,
    verifierUnsupported,
    verifierNeedsMoreContext,
    verifierTotal,
    unsupportedIssueRate,
    outcomeTelemetry,
    dismissedIssueRate,
    corroborationChecked,
    corroborationUnsupported,
    corroborationDowngraded,
    uncorroboratedHighRiskRate,
    outcomeSuppressionCandidates,
    outcomeSuppressionSuppressed,
    outcomeSuppressionRate,
    samples: {
      precisionIssues: issuesTotal > 0 ? 1 : 0,
      verifier: verifierTotal > 0 ? 1 : 0,
      dismissal: outcomeTelemetry.issueTotal > 0 ? 1 : 0,
      corroboration: corroborationChecked > 0 ? 1 : 0,
      suppression: outcomeSuppressionCandidates > 0 ? 1 : 0,
    },
  };
}

export default {
  extractPrecisionMetricsFromStats,
};
