import changesetService from './changesetService.js';
import branchReviewService from './branchReviewService.js';
import prReviewService from './prReviewService.js';
import workspaceReviewService from './workspaceReviewService.js';
import reviewOutcomeService from './reviewOutcomeService.js';
import { extractPrecisionMetricsFromStats } from './reviewPrecisionMetrics.js';

const SUPPORTED_REVIEW_TYPES = new Set(['changeset', 'branch_review', 'pr_review', 'workspace_review']);
const SUPPORTED_SCOPE_VALUES = new Set(['all', 'branches', 'prs']);
const SUPPORTED_WINDOWS = new Set(['24h', '7d', '30d', 'custom']);
const SUPPORTED_INTERVALS = new Set(['hour', 'day', 'week']);
const SUPPORTED_TIMESERIES_METRICS = new Set([
  'ttfs_ms',
  'review_duration_ms',
  'deep_coverage_rate',
  'grounded_issue_rate',
  'issue_addressed_rate',
  'issue_dismissed_rate',
  'partial_rate',
  'review_count',
  'issues_found',
  'findings_found',
]);
const TERMINAL_REVIEW_STATUSES = new Set(['reviewed', 'failed']);
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const WINDOW_TO_MS = Object.freeze({
  '24h': MS_PER_DAY,
  '7d': 7 * MS_PER_DAY,
  '30d': 30 * MS_PER_DAY,
});

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function toFiniteNumber(value, fallback = null) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function toNonNegativeInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

function clampRate(value) {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function buildRateMetric(numerator, denominator, options = {}) {
  const normalizedNumerator = Math.max(0, Number(numerator) || 0);
  const normalizedDenominator = Math.max(0, Number(denominator) || 0);
  const sampleSize = Math.max(0, Number(options.sampleSize ?? normalizedDenominator) || 0);
  const minimumSampleSize = Math.max(0, Number(options.minimumSampleSize) || 0);
  const value = normalizedDenominator > 0
    ? clampRate(normalizedNumerator / normalizedDenominator)
    : null;

  return {
    value,
    numerator: normalizedNumerator,
    denominator: normalizedDenominator,
    sampleSize,
    minimumSampleSize,
    isInsufficientSample: minimumSampleSize > 0 && sampleSize > 0 && sampleSize < minimumSampleSize,
  };
}

function buildValueMetric(value, sampleSize = 0) {
  const normalizedValue = toFiniteNumber(value, null);
  return {
    value: normalizedValue,
    sampleSize: Math.max(0, Number(sampleSize) || 0),
  };
}

function median(values = []) {
  const normalized = values
    .map((value) => toFiniteNumber(value, null))
    .filter((value) => value != null)
    .sort((a, b) => a - b);
  if (normalized.length === 0) return null;
  const middle = Math.floor(normalized.length / 2);
  if (normalized.length % 2 === 1) return normalized[middle];
  return (normalized[middle - 1] + normalized[middle]) / 2;
}

function normalizeReviewTier(review) {
  if (!review || typeof review !== 'object') return 'failed';
  const stats = review.stats && typeof review.stats === 'object' ? review.stats : {};
  const rawTier = String(stats.reviewTier || '').trim().toLowerCase();
  if (rawTier === 'full' || rawTier === 'partial' || rawTier === 'files_only' || rawTier === 'failed') {
    return rawTier;
  }
  const partialFlag = stats.isPartial === true;
  const failedFileCount = Math.max(0, Number(stats.perFileFailedFiles || 0));
  const hasGroups = Array.isArray(review.changeGroups) && review.changeGroups.length > 0;
  const hasRecommendations = Array.isArray(review.recommendations) && review.recommendations.length > 0;
  if (partialFlag || failedFileCount > 0) return 'partial';
  if (hasRecommendations && !hasGroups) return 'files_only';
  return 'full';
}

function normalizeRiskLevel(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'low' || normalized === 'medium' || normalized === 'high' || normalized === 'critical') {
    return normalized;
  }
  return 'medium';
}

function normalizeRecommendationSeverity(recommendation = {}) {
  let severity = normalizeRiskLevel(recommendation.severity);
  if (recommendation.type !== 'issue' && (severity === 'high' || severity === 'critical')) {
    severity = 'medium';
  }
  return severity;
}

function getIssueCounts(recommendations = []) {
  let findingsFound = 0;
  let issuesFound = 0;
  let highRiskFindings = 0;
  for (const recommendation of Array.isArray(recommendations) ? recommendations : []) {
    const recommendationType = String(recommendation?.type || '').trim().toLowerCase();
    if (!recommendation || (recommendationType !== 'issue' && recommendationType !== 'suggestion')) continue;
    findingsFound += 1;
    if (recommendationType !== 'issue') continue;
    issuesFound += 1;
    const severity = normalizeRecommendationSeverity(recommendation);
    if (severity === 'high' || severity === 'critical') {
      highRiskFindings += 1;
    }
  }
  return { findingsFound, issuesFound, highRiskFindings };
}

function normalizeGate(stats = {}) {
  const reviewModelGate = stats.reviewModelGate && typeof stats.reviewModelGate === 'object'
    ? stats.reviewModelGate
    : null;
  const rolloutGate = stats.reviewModelRollout
    && typeof stats.reviewModelRollout === 'object'
    && stats.reviewModelRollout.gate
    && typeof stats.reviewModelRollout.gate === 'object'
    ? stats.reviewModelRollout.gate
    : null;
  const gate = reviewModelGate || rolloutGate;
  if (!gate) return null;
  const status = String(gate.status || '').trim().toLowerCase();
  if (status !== 'pass' && status !== 'warn' && status !== 'fail') return null;
  return {
    status,
    reasonCodes: Array.isArray(gate.reasonCodes) ? gate.reasonCodes.filter(Boolean) : [],
    evaluatedAt: typeof gate.evaluatedAt === 'string' ? gate.evaluatedAt : null,
  };
}

function resolveDeepCoverage(stats = {}, fallbackTotalChangedFiles = 0) {
  const numerator = Math.max(
    0,
    Number(stats.deepReviewedFiles ?? stats.filesDeepReviewed ?? stats.filesAnalyzed ?? 0) || 0
  );
  const denominator = Math.max(
    0,
    Number(stats.totalChangedFiles ?? stats.filesTotal ?? fallbackTotalChangedFiles ?? 0) || 0
  );
  return buildRateMetric(Math.min(numerator, denominator || numerator), denominator, {
    sampleSize: denominator,
  });
}

function normalizeReviewPayload(reviewPayload) {
  if (!reviewPayload || typeof reviewPayload !== 'object' || Array.isArray(reviewPayload)) {
    return null;
  }
  return reviewPayload;
}

function normalizeCompletedAt(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
    if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  }
  return null;
}

export function normalizeReviewType(value) {
  if (value == null || value === '') return null;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'all') return null;
  if (!SUPPORTED_REVIEW_TYPES.has(normalized)) {
    throw createHttpError(400, 'reviewType must be one of: all, changeset, branch_review, pr_review, workspace_review');
  }
  return normalized;
}

export function normalizeAnalyticsScope({ scope = null, reviewType = null } = {}) {
  const normalizedScope = scope == null || scope === ''
    ? null
    : String(scope).trim().toLowerCase();
  if (normalizedScope && !SUPPORTED_SCOPE_VALUES.has(normalizedScope)) {
    throw createHttpError(400, 'scope must be one of: all, branches, prs');
  }

  const normalizedReviewType = normalizeReviewType(reviewType);
  if (normalizedReviewType) {
    const derivedScope = normalizedReviewType === 'pr_review' ? 'prs' : 'branches';
    if (normalizedScope && normalizedScope !== 'all' && normalizedScope !== derivedScope) {
      throw createHttpError(400, 'scope does not match the requested reviewType');
    }
    return {
      scope: derivedScope,
      reviewType: normalizedReviewType,
      reviewTypes: [normalizedReviewType],
    };
  }

  if (!normalizedScope || normalizedScope === 'all') {
    return { scope: 'all', reviewType: null, reviewTypes: null };
  }
  if (normalizedScope === 'prs') {
    return { scope: 'prs', reviewType: 'pr_review', reviewTypes: ['pr_review'] };
  }
  return {
    scope: 'branches',
    reviewType: null,
    reviewTypes: ['changeset', 'branch_review', 'workspace_review'],
  };
}

export function normalizeWindow({ window, from, to, now = new Date() }) {
  const normalizedWindow = String(window || '7d').trim().toLowerCase();
  if (!SUPPORTED_WINDOWS.has(normalizedWindow)) {
    throw createHttpError(400, 'window must be one of: 24h, 7d, 30d, custom');
  }

  if (normalizedWindow === 'custom') {
    const fromDate = new Date(from || '');
    const toDate = new Date(to || '');
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw createHttpError(400, 'from and to are required ISO timestamps when window=custom');
    }
    if (fromDate.getTime() >= toDate.getTime()) {
      throw createHttpError(400, 'from must be earlier than to');
    }
    return {
      key: normalizedWindow,
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
    };
  }

  const durationMs = WINDOW_TO_MS[normalizedWindow];
  const end = new Date(now);
  const start = new Date(end.getTime() - durationMs);
  return {
    key: normalizedWindow,
    from: start.toISOString(),
    to: end.toISOString(),
  };
}

function normalizeInterval(interval, windowKey) {
  if (!interval) {
    if (windowKey === '24h') return 'hour';
    if (windowKey === '30d') return 'week';
    return 'day';
  }
  const normalized = String(interval).trim().toLowerCase();
  if (!SUPPORTED_INTERVALS.has(normalized)) {
    throw createHttpError(400, 'interval must be one of: hour, day, week');
  }
  return normalized;
}

function normalizeMetric(metric) {
  const normalized = String(metric || '').trim().toLowerCase();
  if (!SUPPORTED_TIMESERIES_METRICS.has(normalized)) {
    throw createHttpError(
      400,
      `metric must be one of: ${Array.from(SUPPORTED_TIMESERIES_METRICS).join(', ')}`
    );
  }
  return normalized;
}

function buildBucketStart(isoTimestamp, interval) {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return null;
  const utc = new Date(date);
  if (interval === 'hour') {
    utc.setUTCMinutes(0, 0, 0);
    return utc.toISOString();
  }
  if (interval === 'day') {
    utc.setUTCHours(0, 0, 0, 0);
    return utc.toISOString();
  }
  utc.setUTCHours(0, 0, 0, 0);
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() - (day - 1));
  return utc.toISOString();
}

function addInterval(isoTimestamp, interval) {
  const date = new Date(isoTimestamp);
  if (interval === 'hour') {
    date.setUTCHours(date.getUTCHours() + 1);
  } else if (interval === 'day') {
    date.setUTCDate(date.getUTCDate() + 1);
  } else {
    date.setUTCDate(date.getUTCDate() + 7);
  }
  return date.toISOString();
}

async function buildOutcomeMetrics({ projectId, reviewType, reviewId, recommendations }) {
  const safeRecommendations = Array.isArray(recommendations) ? recommendations : [];
  if (!projectId || !reviewId || !SUPPORTED_REVIEW_TYPES.has(reviewType)) {
    return {
      issueAddressedRate: buildRateMetric(0, 0, { minimumSampleSize: 3 }),
      issueDismissedRate: buildRateMetric(0, 0, { minimumSampleSize: 3 }),
      issueOutcomeCoverage: buildRateMetric(0, 0, { minimumSampleSize: 3 }),
      addressedCount: 0,
      dismissedCount: 0,
      findingAddressedCount: 0,
      findingDismissedCount: 0,
    };
  }

  const outcomeResult = await reviewOutcomeService.listOutcomes(
    { projectId, reviewType, reviewId },
    { reviewRecommendations: safeRecommendations }
  );
  const telemetry = outcomeResult?.telemetry || {};
  const issueTotal = toNonNegativeInt(telemetry.issueTotal);
  const issueAddressed = Math.min(issueTotal, toNonNegativeInt(telemetry.issueAddressed));
  const issueDismissed = Math.min(issueTotal, toNonNegativeInt(telemetry.issueDismissed));
  const issueOutcomeCoverageCount = Math.min(issueTotal, issueAddressed + issueDismissed);
  const findingTotal = toNonNegativeInt(telemetry.findingTotal);
  const findingAddressed = Math.min(findingTotal, toNonNegativeInt(telemetry.findingAddressed));
  const findingDismissed = Math.min(findingTotal, toNonNegativeInt(telemetry.findingDismissed));

  return {
    issueAddressedRate: buildRateMetric(issueAddressed, issueTotal, { minimumSampleSize: 3 }),
    issueDismissedRate: buildRateMetric(issueDismissed, issueTotal, { minimumSampleSize: 3 }),
    issueOutcomeCoverage: buildRateMetric(issueOutcomeCoverageCount, issueTotal, { minimumSampleSize: 3 }),
    addressedCount: issueAddressed,
    dismissedCount: issueDismissed,
    findingAddressedCount: findingAddressed,
    findingDismissedCount: findingDismissed,
  };
}

export async function buildReviewTrustAnalytics(input = {}) {
  const reviewType = normalizeReviewType(input.reviewType);
  const reviewStatus = String(input.reviewStatus || '').trim().toLowerCase();
  if (!reviewType || !TERMINAL_REVIEW_STATUSES.has(reviewStatus)) {
    return null;
  }

  const review = normalizeReviewPayload(input.reviewPayload);
  const recommendations = Array.isArray(review?.recommendations) ? review.recommendations : [];
  const stats = review?.stats && typeof review.stats === 'object' ? review.stats : {};
  const completedAt = normalizeCompletedAt(input.reviewedAt, input.updatedAt, input.createdAt);
  const precision = extractPrecisionMetricsFromStats(stats);
  const issueCounts = getIssueCounts(recommendations);
  const deepCoverage = resolveDeepCoverage(stats, input.totalChangedFiles);
  const gate = normalizeGate(stats);
  const omittedFiles = Math.max(
    toNonNegativeInt(stats.omittedFiles),
    deepCoverage.denominator > 0
      ? Math.max(0, deepCoverage.denominator - Math.min(deepCoverage.numerator, deepCoverage.denominator))
      : 0
  );
  const followThrough = await buildOutcomeMetrics({
    projectId: input.projectId,
    reviewType,
    reviewId: input.reviewId,
    recommendations,
  });

  return {
    meta: {
      projectId: input.projectId || null,
      reviewType,
      reviewId: input.reviewId || null,
      displayId: input.displayId || null,
      branchName: input.branchName || null,
      completedAt,
      providerType: input.providerType || review?.provider?.type || null,
      providerModel: input.providerModel || review?.provider?.model || null,
    },
    immediateValue: {
      ttfsMs: toFiniteNumber(stats.firstSignalMs, null),
      reviewDurationMs: toFiniteNumber(stats.reviewTotalDurationMs, null),
      deepCoverage,
      findingsFound: issueCounts.findingsFound,
      issuesFound: issueCounts.issuesFound,
      highRiskFindings: issueCounts.highRiskFindings,
    },
    trustQuality: {
      groundedIssueRate: buildRateMetric(precision.issuesGrounded, precision.issuesTotal, {
        sampleSize: precision.issuesTotal,
        minimumSampleSize: 5,
      }),
      unsupportedIssueRate: buildRateMetric(precision.verifierUnsupported, precision.verifierTotal, {
        sampleSize: precision.verifierTotal,
        minimumSampleSize: 5,
      }),
      lowEvidenceIssueRate: buildRateMetric(precision.lowEvidenceIssueCount, precision.issuesTotal, {
        sampleSize: precision.issuesTotal,
        minimumSampleSize: 5,
      }),
      uncorroboratedHighRiskRate: buildRateMetric(
        precision.corroborationUnsupported,
        precision.corroborationChecked,
        {
          sampleSize: precision.corroborationChecked,
          minimumSampleSize: 5,
        }
      ),
      outcomeSuppressionRate: buildRateMetric(
        precision.outcomeSuppressionSuppressed,
        precision.outcomeSuppressionCandidates,
        {
          sampleSize: precision.outcomeSuppressionCandidates,
          minimumSampleSize: 5,
        }
      ),
    },
    followThrough,
    reliability: {
      reviewReliability: review ? normalizeReviewTier(review) : 'failed',
      gateStatus: gate?.status || null,
      gateReasonCodes: gate?.reasonCodes || [],
      gateEvaluatedAt: gate?.evaluatedAt || null,
      omittedFiles,
      failedFiles: toNonNegativeInt(stats.perFileFailedFiles),
      reviewStatus,
    },
  };
}

function sumRateMetrics(reviews, selectMetric) {
  let numerator = 0;
  let denominator = 0;
  for (const review of reviews) {
    const metric = selectMetric(review);
    if (!metric) continue;
    numerator += Math.max(0, Number(metric.numerator) || 0);
    denominator += Math.max(0, Number(metric.denominator) || 0);
  }
  return { numerator, denominator };
}

function countReliability(reviews) {
  const counts = { full: 0, partial: 0, files_only: 0, failed: 0 };
  for (const review of reviews) {
    const tier = review?.reliability?.reviewReliability;
    if (tier === 'full' || tier === 'partial' || tier === 'files_only' || tier === 'failed') {
      counts[tier] += 1;
    }
  }
  return counts;
}

function buildScopeBreakdown(reviews) {
  let branchReviewCount = 0;
  let changesetCount = 0;
  let workspaceReviewCount = 0;
  let prReviewCount = 0;
  for (const review of reviews) {
    const reviewType = review?.meta?.reviewType;
    if (reviewType === 'branch_review') branchReviewCount += 1;
    if (reviewType === 'changeset') changesetCount += 1;
    if (reviewType === 'workspace_review') workspaceReviewCount += 1;
    if (reviewType === 'pr_review') prReviewCount += 1;
  }
  return {
    branchScopedCount: branchReviewCount + changesetCount + workspaceReviewCount,
    branchReviewCount,
    changesetCount,
    workspaceReviewCount,
    prReviewCount,
  };
}

function buildScopeComparison(scopeBreakdown) {
  const branchScopedCount = Math.max(0, Number(scopeBreakdown?.branchScopedCount) || 0);
  const prReviewCount = Math.max(0, Number(scopeBreakdown?.prReviewCount) || 0);
  const total = branchScopedCount + prReviewCount;

  let dominantScope = 'balanced';
  if (branchScopedCount > prReviewCount) dominantScope = 'branches';
  if (prReviewCount > branchScopedCount) dominantScope = 'prs';

  return {
    dominantScope,
    branchScopedCount,
    prReviewCount,
    branchShare: total > 0 ? branchScopedCount / total : 0,
    prShare: total > 0 ? prReviewCount / total : 0,
  };
}

function buildCommentReadyMetric(totalIssuesFound, reviewCount) {
  return {
    value: reviewCount > 0 ? totalIssuesFound / reviewCount : null,
    numerator: totalIssuesFound,
    denominator: reviewCount,
    sampleSize: reviewCount,
  };
}

function buildMedianChangedFilesMetric(reviews) {
  const changedFileCounts = reviews
    .map((review) => review?.immediateValue?.deepCoverage?.denominator)
    .filter((value) => value != null && Number.isFinite(value) && value >= 0);
  return buildValueMetric(median(changedFileCounts), changedFileCounts.length);
}

function buildVerificationContextRate(reviews) {
  const reviewsWithContext = reviews.filter((review) => {
    const unsupportedMetric = review?.trustQuality?.unsupportedIssueRate;
    const gateStatus = review?.reliability?.gateStatus;
    return (unsupportedMetric && unsupportedMetric.denominator > 0)
      || gateStatus === 'pass'
      || gateStatus === 'warn'
      || gateStatus === 'fail';
  }).length;

  return buildRateMetric(reviewsWithContext, reviews.length, {
    sampleSize: reviews.length,
  });
}

function buildSummaryHeroCards(scope) {
  if (scope === 'prs') {
    return [
      {
        key: 'comment_ready_findings',
        label: 'Comment-ready findings',
        description: 'Average actionable findings surfaced per completed PR review.',
      },
      {
        key: 'median_pr_size',
        label: 'Median PR size reviewed',
        description: 'Median changed-file count across completed PR reviews in this window.',
      },
      {
        key: 'verification_context',
        label: 'Verification context',
        description: 'Share of completed PR reviews that carried verifier or check context.',
      },
      {
        key: 'review_reliability',
        label: 'Review reliability',
        description: 'Reliability mix across completed PR reviews in this window.',
      },
    ];
  }

  return [
    {
      key: 'median_ttfs',
      label: 'Median TTFS',
      description: 'Median time to first signal across completed reviews in this window.',
    },
    {
      key: 'deep_coverage',
      label: 'Deep coverage',
      description: 'Share of changed files that received deep review coverage.',
    },
    {
      key: 'grounded_issues',
      label: 'Grounded issues',
      description: 'Share of actionable findings backed by grounded evidence.',
    },
    {
      key: 'reliability_mix',
      label: 'Reliability mix',
      description: 'Reliability distribution across completed reviews in this window.',
    },
  ];
}

function buildTimeseriesMetadata(metric, scope) {
  const isPrScope = scope === 'prs';
  switch (metric) {
    case 'ttfs_ms':
      return {
        metricLabel: 'Review start',
        metricDescription: isPrScope
          ? 'Time to first signal across completed PR reviews.'
          : 'Time to first signal across completed reviews.',
      };
    case 'review_duration_ms':
      return {
        metricLabel: isPrScope ? 'PR review duration' : 'Review duration',
        metricDescription: isPrScope
          ? 'End-to-end review runtime across completed PR reviews.'
          : 'End-to-end review runtime across completed reviews.',
      };
    case 'deep_coverage_rate':
      return {
        metricLabel: isPrScope ? 'PR diff coverage' : 'Deep coverage',
        metricDescription: isPrScope
          ? 'Share of changed PR files that received deep review coverage.'
          : 'Share of changed files that received deep review coverage.',
      };
    case 'grounded_issue_rate':
      return {
        metricLabel: isPrScope ? 'Grounded PR findings' : 'Grounded findings',
        metricDescription: isPrScope
          ? 'Share of PR findings backed by grounded evidence.'
          : 'Share of actionable findings backed by grounded evidence.',
      };
    case 'issue_addressed_rate':
      return {
        metricLabel: 'Addressed findings',
        metricDescription: isPrScope
          ? 'Share of PR findings later marked addressed.'
          : 'Share of findings later marked addressed.',
      };
    case 'issue_dismissed_rate':
      return {
        metricLabel: 'Dismissed findings',
        metricDescription: isPrScope
          ? 'Share of PR findings later dismissed.'
          : 'Share of findings later dismissed.',
      };
    case 'partial_rate':
      return {
        metricLabel: isPrScope ? 'PR partial coverage' : 'Partial coverage',
        metricDescription: isPrScope
          ? 'Share of PR reviews that fell back to partial coverage.'
          : 'Share of reviews that fell back to partial coverage.',
      };
    case 'review_count':
      return {
        metricLabel: isPrScope ? 'PR reviews' : 'Reviews',
        metricDescription: isPrScope
          ? 'Number of completed PR reviews per period.'
          : 'Number of completed reviews per period.',
      };
    case 'issues_found':
      return {
        metricLabel: isPrScope ? 'PR findings' : 'Findings',
        metricDescription: isPrScope
          ? 'Total actionable findings surfaced across PR reviews per period.'
          : 'Total actionable findings surfaced across reviews per period.',
      };
    case 'findings_found':
      return {
        metricLabel: isPrScope ? 'PR findings' : 'Findings',
        metricDescription: isPrScope
          ? 'Total actionable issues and suggestions surfaced across PR reviews per period.'
          : 'Total actionable issues and suggestions surfaced across reviews per period.',
      };
    default:
      return {
        metricLabel: 'Review metric',
        metricDescription: 'Review analytics trend.',
      };
  }
}

function buildOutcomeScopeList(projectId, reviews = []) {
  if (!projectId) return [];
  const scopes = [];
  const seen = new Set();
  for (const review of reviews) {
    const reviewType = String(review?.meta?.reviewType || '').trim().toLowerCase();
    const reviewId = String(review?.meta?.reviewId || '').trim();
    if (!SUPPORTED_REVIEW_TYPES.has(reviewType) || !reviewId) continue;
    const scopeKey = `${reviewType}:${reviewId}`;
    if (seen.has(scopeKey)) continue;
    seen.add(scopeKey);
    scopes.push({
      projectId,
      reviewType,
      reviewId,
    });
  }
  return scopes;
}

async function loadProjectOutcomeTotals(projectId, reviews = []) {
  const reviewScopes = buildOutcomeScopeList(projectId, reviews);
  if (!projectId || reviewScopes.length === 0) {
    return {
      total: 0,
      addressed: 0,
      dismissed: 0,
    };
  }

  const counts = await reviewOutcomeService.countIssueOutcomesForReviewScopes({
    projectId,
    reviewScopes,
    recommendationTypes: ['issue', 'suggestion'],
  });
  return {
    total: Math.max(0, Number(counts?.total) || 0),
    addressed: Math.max(0, Number(counts?.addressed) || 0),
    dismissed: Math.max(0, Number(counts?.dismissed) || 0),
  };
}

function buildSummary(reviews, window, { scope, reviewType }, projectId = null, outcomeTotals = null) {
  const totalFindingsFound = reviews.reduce(
    (sum, review) => sum + Math.max(0, Number(review?.immediateValue?.findingsFound ?? review?.immediateValue?.issuesFound) || 0),
    0
  );
  const ttfsValues = reviews
    .map((review) => review?.immediateValue?.ttfsMs)
    .filter((value) => value != null);
  const durationValues = reviews
    .map((review) => review?.immediateValue?.reviewDurationMs)
    .filter((value) => value != null);
  const totalIssuesFound = reviews.reduce(
    (sum, review) => sum + Math.max(0, Number(review?.immediateValue?.issuesFound) || 0),
    0
  );
  const deepCoverage = sumRateMetrics(reviews, (review) => review?.immediateValue?.deepCoverage);
  const groundedIssueRate = sumRateMetrics(reviews, (review) => review?.trustQuality?.groundedIssueRate);
  const unsupportedIssueRate = sumRateMetrics(reviews, (review) => review?.trustQuality?.unsupportedIssueRate);
  const lowEvidenceIssueRate = sumRateMetrics(reviews, (review) => review?.trustQuality?.lowEvidenceIssueRate);
  const uncorroboratedHighRiskRate = sumRateMetrics(reviews, (review) => review?.trustQuality?.uncorroboratedHighRiskRate);
  const outcomeSuppressionRate = sumRateMetrics(reviews, (review) => review?.trustQuality?.outcomeSuppressionRate);
  const normalizedOutcomeTotals = outcomeTotals && typeof outcomeTotals === 'object'
    ? {
      total: Math.max(0, Number(outcomeTotals.total) || 0),
      addressed: Math.max(0, Number(outcomeTotals.addressed) || 0),
      dismissed: Math.max(0, Number(outcomeTotals.dismissed) || 0),
    }
    : { total: 0, addressed: 0, dismissed: 0 };
  const issueAddressedTotal = reviews.reduce(
    (sum, review) => sum + Math.max(0, Number(review?.followThrough?.addressedCount) || 0),
    0
  );
  const issueDismissedTotal = reviews.reduce(
    (sum, review) => sum + Math.max(0, Number(review?.followThrough?.dismissedCount) || 0),
    0
  );
  const issueOutcomeCoverageTotal = Math.min(
    totalIssuesFound,
    issueAddressedTotal + issueDismissedTotal
  );
  const reliabilityCounts = countReliability(reviews);
  const gateStatuses = reviews
    .map((review) => review?.reliability?.gateStatus)
    .filter((value) => value === 'pass' || value === 'warn' || value === 'fail');
  const gateWarnCount = gateStatuses.filter((status) => status === 'warn').length;
  const gateFailCount = gateStatuses.filter((status) => status === 'fail').length;
  const scopeBreakdown = buildScopeBreakdown(reviews);
  const comparison = buildScopeComparison(scopeBreakdown);
  const commentReadyFindingsPerReview = buildCommentReadyMetric(totalIssuesFound, reviews.length);
  const medianChangedFiles = buildMedianChangedFilesMetric(reviews);
  const verificationContextRate = buildVerificationContextRate(reviews);
  const cappedOutcomeAddressed = Math.min(issueAddressedTotal, totalIssuesFound);
  const cappedOutcomeDismissed = Math.min(issueDismissedTotal, totalIssuesFound);
  const cappedOutcomeTotal = Math.min(issueOutcomeCoverageTotal, totalIssuesFound);

  return {
    projectId,
    reviewType: reviewType || null,
    scope,
    window,
    reviewCount: reviews.length,
    scopeBreakdown,
    comparison,
    heroCards: buildSummaryHeroCards(scope),
    hero: {
      medianTtfsMs: buildValueMetric(median(ttfsValues), ttfsValues.length),
      medianReviewDurationMs: buildValueMetric(median(durationValues), durationValues.length),
      deepCoverageRate: buildRateMetric(deepCoverage.numerator, deepCoverage.denominator, {
        sampleSize: deepCoverage.denominator,
      }),
      findingsFoundPerReview: {
        value: reviews.length > 0 ? totalFindingsFound / reviews.length : null,
        numerator: totalFindingsFound,
        denominator: reviews.length,
        sampleSize: reviews.length,
      },
      issuesFoundPerReview: {
        value: reviews.length > 0 ? totalIssuesFound / reviews.length : null,
        numerator: totalIssuesFound,
        denominator: reviews.length,
        sampleSize: reviews.length,
      },
      groundedIssueRate: buildRateMetric(groundedIssueRate.numerator, groundedIssueRate.denominator, {
        sampleSize: groundedIssueRate.denominator,
        minimumSampleSize: 5,
      }),
      commentReadyFindingsPerReview,
      medianChangedFiles,
      verificationContextRate,
    },
    quality: {
      groundedIssueRate: buildRateMetric(groundedIssueRate.numerator, groundedIssueRate.denominator, {
        sampleSize: groundedIssueRate.denominator,
        minimumSampleSize: 5,
      }),
      unsupportedIssueRate: buildRateMetric(unsupportedIssueRate.numerator, unsupportedIssueRate.denominator, {
        sampleSize: unsupportedIssueRate.denominator,
        minimumSampleSize: 5,
      }),
      lowEvidenceIssueRate: buildRateMetric(lowEvidenceIssueRate.numerator, lowEvidenceIssueRate.denominator, {
        sampleSize: lowEvidenceIssueRate.denominator,
        minimumSampleSize: 5,
      }),
      uncorroboratedHighRiskRate: buildRateMetric(
        uncorroboratedHighRiskRate.numerator,
        uncorroboratedHighRiskRate.denominator,
        {
          sampleSize: uncorroboratedHighRiskRate.denominator,
          minimumSampleSize: 5,
        }
      ),
      outcomeSuppressionRate: buildRateMetric(
        outcomeSuppressionRate.numerator,
        outcomeSuppressionRate.denominator,
        {
          sampleSize: outcomeSuppressionRate.denominator,
          minimumSampleSize: 5,
        }
      ),
    },
    outcome: {
      issueAddressedRate: buildRateMetric(cappedOutcomeAddressed, totalIssuesFound, {
        sampleSize: totalIssuesFound,
        minimumSampleSize: 3,
      }),
      issueDismissedRate: buildRateMetric(cappedOutcomeDismissed, totalIssuesFound, {
        sampleSize: totalIssuesFound,
        minimumSampleSize: 3,
      }),
      issueOutcomeCoverage: buildRateMetric(cappedOutcomeTotal, totalIssuesFound, {
        sampleSize: totalIssuesFound,
        minimumSampleSize: 3,
      }),
      addressedCount: normalizedOutcomeTotals.addressed,
      dismissedCount: normalizedOutcomeTotals.dismissed,
    },
    reliability: {
      fullCount: reliabilityCounts.full,
      partialCount: reliabilityCounts.partial,
      filesOnlyCount: reliabilityCounts.files_only,
      failedCount: reliabilityCounts.failed,
      partialRate: buildRateMetric(reliabilityCounts.partial, reviews.length, {
        sampleSize: reviews.length,
      }),
      filesOnlyRate: buildRateMetric(reliabilityCounts.files_only, reviews.length, {
        sampleSize: reviews.length,
      }),
      failedRate: buildRateMetric(reliabilityCounts.failed, reviews.length, {
        sampleSize: reviews.length,
      }),
      gateWarnRate: buildRateMetric(gateWarnCount, gateStatuses.length, {
        sampleSize: gateStatuses.length,
      }),
      gateFailRate: buildRateMetric(gateFailCount, gateStatuses.length, {
        sampleSize: gateStatuses.length,
      }),
    },
  };
}

function summarizeTimeseriesMetric(metric, reviews) {
  if (metric === 'review_count') {
    return {
      value: reviews.length,
      numerator: reviews.length,
      denominator: null,
      sampleSize: reviews.length,
      aggregation: 'count',
    };
  }
  if (metric === 'issues_found') {
    const total = reviews.reduce(
      (sum, review) => sum + Math.max(0, Number(review?.immediateValue?.issuesFound) || 0),
      0
    );
    return {
      value: total,
      numerator: total,
      denominator: null,
      sampleSize: reviews.length,
      aggregation: 'sum',
    };
  }
  if (metric === 'findings_found') {
    const total = reviews.reduce(
      (sum, review) => sum + Math.max(0, Number(review?.immediateValue?.findingsFound ?? review?.immediateValue?.issuesFound) || 0),
      0
    );
    return {
      value: total,
      numerator: total,
      denominator: null,
      sampleSize: reviews.length,
      aggregation: 'sum',
    };
  }
  if (metric === 'ttfs_ms') {
    const values = reviews
      .map((review) => review?.immediateValue?.ttfsMs)
      .filter((value) => value != null);
    return {
      value: median(values),
      numerator: null,
      denominator: null,
      sampleSize: values.length,
      aggregation: 'median',
    };
  }
  if (metric === 'review_duration_ms') {
    const values = reviews
      .map((review) => review?.immediateValue?.reviewDurationMs)
      .filter((value) => value != null);
    return {
      value: median(values),
      numerator: null,
      denominator: null,
      sampleSize: values.length,
      aggregation: 'median',
    };
  }
  if (metric === 'partial_rate') {
    const numerator = reviews.filter((review) => review?.reliability?.reviewReliability === 'partial').length;
    const denominator = reviews.length;
    return {
      value: denominator > 0 ? numerator / denominator : null,
      numerator,
      denominator,
      sampleSize: denominator,
      aggregation: 'rate',
    };
  }

  const metricPath = {
    deep_coverage_rate: (review) => review?.immediateValue?.deepCoverage,
    grounded_issue_rate: (review) => review?.trustQuality?.groundedIssueRate,
    issue_addressed_rate: (review) => review?.followThrough?.issueAddressedRate,
    issue_dismissed_rate: (review) => review?.followThrough?.issueDismissedRate,
  }[metric];

  const total = sumRateMetrics(reviews, metricPath);
  return {
    value: total.denominator > 0 ? total.numerator / total.denominator : null,
    numerator: total.numerator,
    denominator: total.denominator,
    sampleSize: total.denominator,
    aggregation: 'rate',
  };
}

function buildTimeseries(reviews, { metric, interval, window, scope, reviewType, projectId = null }) {
  const grouped = new Map();
  for (const review of reviews) {
    const completedAt = review?.meta?.completedAt;
    if (!completedAt) continue;
    const bucketStart = buildBucketStart(completedAt, interval);
    if (!bucketStart) continue;
    if (!grouped.has(bucketStart)) grouped.set(bucketStart, []);
    grouped.get(bucketStart).push(review);
  }

  const points = Array.from(grouped.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([bucketStart, bucketReviews]) => {
      const summary = summarizeTimeseriesMetric(metric, bucketReviews);
      return {
        bucketStart,
        bucketEnd: addInterval(bucketStart, interval),
        reviewCount: bucketReviews.length,
        ...summary,
      };
    });

  const metadata = buildTimeseriesMetadata(metric, scope);

  return {
    projectId,
    reviewType: reviewType || null,
    scope,
    window,
    metric,
    metricLabel: metadata.metricLabel,
    metricDescription: metadata.metricDescription,
    interval,
    points,
  };
}

function isWithinWindow(completedAt, window) {
  if (!completedAt) return false;
  const timestamp = new Date(completedAt).getTime();
  const from = new Date(window.from).getTime();
  const to = new Date(window.to).getTime();
  if (Number.isNaN(timestamp) || Number.isNaN(from) || Number.isNaN(to)) return false;
  return timestamp >= from && timestamp <= to;
}

async function loadFactBackedProjectReviews({ projectId, projectPath, scope, reviewType, window }) {
  const { default: trustAnalyticsFactService } = await import('./trustAnalyticsFactService.js');
  const facts = await trustAnalyticsFactService.listMergedReviewFactSnapshots({
    projectId,
    projectPath,
    scope,
    reviewType,
    from: window.from,
    to: window.to,
  });
  const dimensionRows = await trustAnalyticsFactService.listMergedDimensionFactRows({
    projectId,
    projectPath,
    scope,
    reviewType,
    from: window.from,
    to: window.to,
  });
  const followThroughByScope = new Map();
  for (const row of dimensionRows) {
    const scopeKey = `${String(row?.reviewType || '').trim().toLowerCase()}:${String(row?.reviewId || '').trim()}`;
    const existing = followThroughByScope.get(scopeKey) || {
      issueTotal: 0,
      issueAddressed: 0,
      issueDismissed: 0,
      issueOutcomeCoverage: 0,
    };
    existing.issueTotal += Math.max(0, Number(row?.issueCount) || 0);
    existing.issueAddressed += Math.max(0, Number(row?.outcomeAddressedCount) || 0);
    existing.issueDismissed += Math.max(0, Number(row?.outcomeDismissedCount) || 0);
    existing.issueOutcomeCoverage += Math.max(0, Number(row?.outcomeRecordedCount) || 0);
    followThroughByScope.set(scopeKey, existing);
  }

  const hydratedReviews = await Promise.all(facts.map(async (fact) => {
      let findingsFound = Math.max(0, Number(fact?.issuesFound) || 0);
      let recommendations = null;
      if (fact?.reviewType === 'changeset' && projectPath) {
        const changeset = await changesetService.getChangeSet(projectPath, fact.reviewId).catch(() => null);
        recommendations = changeset?.reviewData?.recommendations;
      } else if (fact?.reviewType === 'branch_review') {
        const branchReview = await branchReviewService.getById(fact.reviewId).catch(() => null);
        recommendations = branchReview?.reviewJson?.recommendations;
      } else if (fact?.reviewType === 'workspace_review' && projectPath) {
        const workspaceReview = await workspaceReviewService.getById(projectPath, fact.reviewId, {
          projectId: fact.projectId || null,
          includeContent: false,
        }).catch(() => null);
        recommendations = workspaceReview?.reviewJson?.recommendations;
      } else if (fact?.reviewType === 'pr_review') {
        const prReview = await prReviewService.getById(fact.reviewId).catch(() => null);
        recommendations = prReview?.reviewJson?.recommendations;
      }
      if (Array.isArray(recommendations)) {
        findingsFound = getIssueCounts(recommendations).findingsFound;
      }
      const hydrated = trustAnalyticsFactService.hydrateTrustAnalyticsFromFactSnapshot(fact);
      if (!hydrated) return null;
      const scopeKey = `${String(fact?.reviewType || '').trim().toLowerCase()}:${String(fact?.reviewId || '').trim()}`;
      const followThrough = followThroughByScope.get(scopeKey);
      const nextHydrated = {
        ...hydrated,
        immediateValue: {
          ...hydrated.immediateValue,
          findingsFound,
        },
      };
      if (!followThrough) return nextHydrated;
      return {
        ...nextHydrated,
        followThrough: {
          issueAddressedRate: buildRateMetric(followThrough.issueAddressed, followThrough.issueTotal, { minimumSampleSize: 3 }),
          issueDismissedRate: buildRateMetric(followThrough.issueDismissed, followThrough.issueTotal, { minimumSampleSize: 3 }),
          issueOutcomeCoverage: buildRateMetric(followThrough.issueOutcomeCoverage, followThrough.issueTotal, { minimumSampleSize: 3 }),
          addressedCount: followThrough.issueAddressed,
          dismissedCount: followThrough.issueDismissed,
        },
      };
    }));
  return hydratedReviews.filter(Boolean);
}

async function loadChangesetReviews(projectId, projectPath) {
  const changesets = await changesetService.getChangeSets(projectPath);
  const candidates = changesets.filter((changeset) => TERMINAL_REVIEW_STATUSES.has(String(changeset.reviewStatus || '').trim().toLowerCase()));

  return Promise.all(candidates.map(async (changeset) => {
    const reviewStatus = String(changeset.reviewStatus || '').trim().toLowerCase();
    const fullChangeset = (reviewStatus === 'reviewed' || changeset.reviewData)
      ? await changesetService.getChangeSet(projectPath, changeset.id)
      : changeset;
    const source = fullChangeset || changeset;
    return buildReviewTrustAnalytics({
      projectId,
      reviewType: 'changeset',
      reviewId: source.id,
      displayId: source.displayId || changeset.displayId || null,
      reviewStatus,
      reviewedAt: source.reviewedAt || changeset.reviewedAt || null,
      updatedAt: source.updatedAt || changeset.updatedAt || null,
      createdAt: source.createdAt || changeset.createdAt || null,
      totalChangedFiles: Array.isArray(source.files) ? source.files.length : changeset.riskFlags?.fileCount,
      providerType: source.reviewData?.provider?.type || null,
      providerModel: source.reviewData?.provider?.model || null,
      reviewPayload: source.reviewData || null,
    });
  }));
}

async function loadBranchReviewAnalytics(projectId) {
  const reviews = await branchReviewService.getByProject(projectId);
  return Promise.all(reviews
    .filter((review) => TERMINAL_REVIEW_STATUSES.has(String(review.reviewStatus || '').trim().toLowerCase()))
    .map((review) => buildReviewTrustAnalytics({
      projectId,
      reviewType: 'branch_review',
      reviewId: review.id,
      displayId: review.displayId || null,
      branchName: review.branchName || null,
      reviewStatus: review.reviewStatus,
      reviewedAt: review.reviewedAt || null,
      updatedAt: review.updatedAt || null,
      createdAt: review.createdAt || null,
      totalChangedFiles: review.fileCount,
      providerType: review.reviewJson?.provider?.type || null,
      providerModel: review.reviewJson?.provider?.model || null,
      reviewPayload: review.reviewJson || null,
    })));
}

async function loadWorkspaceReviewAnalytics(projectId, projectPath) {
  if (!projectPath) return [];
  const reviews = await workspaceReviewService.list(projectPath, { projectId });
  return Promise.all(reviews
    .filter((review) => TERMINAL_REVIEW_STATUSES.has(String(review.reviewStatus || '').trim().toLowerCase()))
    .map((review) => buildReviewTrustAnalytics({
      projectId,
      reviewType: 'workspace_review',
      reviewId: review.id,
      displayId: review.displayId || null,
      branchName: review.branchName || null,
      reviewStatus: review.reviewStatus,
      reviewedAt: review.reviewedAt || null,
      updatedAt: review.updatedAt || null,
      createdAt: review.createdAt || null,
      totalChangedFiles: review.fileCount,
      providerType: review.reviewJson?.provider?.type || null,
      providerModel: review.reviewJson?.provider?.model || null,
      reviewPayload: review.reviewJson || null,
    })));
}

async function loadPrReviewAnalytics(projectId) {
  const reviews = await prReviewService.getByProject(projectId);
  return Promise.all(reviews
    .filter((review) => TERMINAL_REVIEW_STATUSES.has(String(review.reviewStatus || '').trim().toLowerCase()))
    .map((review) => buildReviewTrustAnalytics({
      projectId,
      reviewType: 'pr_review',
      reviewId: review.id,
      displayId: review.displayId || null,
      branchName: review.headBranch || null,
      reviewStatus: review.reviewStatus,
      reviewedAt: review.reviewedAt || null,
      updatedAt: review.updatedAt || null,
      createdAt: review.createdAt || null,
      totalChangedFiles: review.fileCount,
      providerType: review.reviewJson?.provider?.type || null,
      providerModel: review.reviewJson?.provider?.model || null,
      reviewPayload: review.reviewJson || null,
    })));
}

async function loadProjectReviews({ projectId, projectPath, scope, reviewType }) {
  const requested = normalizeAnalyticsScope({ scope, reviewType });
  const tasks = [];
  if (!requested.reviewTypes || requested.reviewTypes.includes('changeset')) {
    tasks.push(loadChangesetReviews(projectId, projectPath));
  }
  if (!requested.reviewTypes || requested.reviewTypes.includes('branch_review')) {
    tasks.push(loadBranchReviewAnalytics(projectId));
  }
  if (!requested.reviewTypes || requested.reviewTypes.includes('workspace_review')) {
    tasks.push(loadWorkspaceReviewAnalytics(projectId, projectPath));
  }
  if (!requested.reviewTypes || requested.reviewTypes.includes('pr_review')) {
    tasks.push(loadPrReviewAnalytics(projectId));
  }
  const results = await Promise.all(tasks);
  return results.flat().filter(Boolean);
}

async function loadWindowedProjectReviews({ projectId, projectPath, scope, reviewType, window }) {
  const factBacked = await loadFactBackedProjectReviews({
    projectId,
    projectPath,
    scope,
    reviewType,
    window,
  });

  if (factBacked.length > 0) {
    return factBacked;
  }

  const reviews = await loadProjectReviews({
    projectId,
    projectPath,
    scope,
    reviewType,
  });
  return reviews.filter((review) => isWithinWindow(review?.meta?.completedAt, window));
}

export async function getChangesetTrustAnalytics({ projectId, changeset }) {
  return buildReviewTrustAnalytics({
    projectId,
    reviewType: 'changeset',
    reviewId: changeset?.id,
    displayId: changeset?.displayId || null,
    reviewStatus: changeset?.reviewStatus,
    reviewedAt: changeset?.reviewedAt || null,
    updatedAt: changeset?.updatedAt || null,
    createdAt: changeset?.createdAt || null,
    totalChangedFiles: Array.isArray(changeset?.files) ? changeset.files.length : changeset?.riskFlags?.fileCount,
    providerType: changeset?.reviewData?.provider?.type || null,
    providerModel: changeset?.reviewData?.provider?.model || null,
    reviewPayload: changeset?.reviewData || null,
  });
}

export async function getBranchReviewTrustAnalytics({ projectId, branchReview }) {
  return buildReviewTrustAnalytics({
    projectId,
    reviewType: 'branch_review',
    reviewId: branchReview?.id,
    displayId: branchReview?.displayId || null,
    branchName: branchReview?.branchName || null,
    reviewStatus: branchReview?.reviewStatus,
    reviewedAt: branchReview?.reviewedAt || null,
    updatedAt: branchReview?.updatedAt || null,
    createdAt: branchReview?.createdAt || null,
    totalChangedFiles: branchReview?.fileCount,
    providerType: branchReview?.reviewJson?.provider?.type || null,
    providerModel: branchReview?.reviewJson?.provider?.model || null,
    reviewPayload: branchReview?.reviewJson || null,
  });
}

export async function getWorkspaceReviewTrustAnalytics({ projectId, workspaceReview }) {
  return buildReviewTrustAnalytics({
    projectId,
    reviewType: 'workspace_review',
    reviewId: workspaceReview?.id,
    displayId: workspaceReview?.displayId || null,
    branchName: workspaceReview?.branchName || null,
    reviewStatus: workspaceReview?.reviewStatus,
    reviewedAt: workspaceReview?.reviewedAt || null,
    updatedAt: workspaceReview?.updatedAt || null,
    createdAt: workspaceReview?.createdAt || null,
    totalChangedFiles: workspaceReview?.fileCount,
    providerType: workspaceReview?.reviewJson?.provider?.type || null,
    providerModel: workspaceReview?.reviewJson?.provider?.model || null,
    reviewPayload: workspaceReview?.reviewJson || null,
  });
}

export async function getPrReviewTrustAnalytics({ projectId, prReview }) {
  return buildReviewTrustAnalytics({
    projectId,
    reviewType: 'pr_review',
    reviewId: prReview?.id,
    displayId: prReview?.displayId || null,
    branchName: prReview?.headBranch || null,
    reviewStatus: prReview?.reviewStatus,
    reviewedAt: prReview?.reviewedAt || null,
    updatedAt: prReview?.updatedAt || null,
    createdAt: prReview?.createdAt || null,
    totalChangedFiles: prReview?.fileCount,
    providerType: prReview?.reviewJson?.provider?.type || null,
    providerModel: prReview?.reviewJson?.provider?.model || null,
    reviewPayload: prReview?.reviewJson || null,
  });
}

export async function getProjectTrustAnalyticsSummary({ projectId, projectPath, scope, reviewType, window, from, to, now }) {
  const normalizedWindow = normalizeWindow({ window, from, to, now });
  const normalizedScope = normalizeAnalyticsScope({ scope, reviewType });
  const filtered = await loadWindowedProjectReviews({
    projectId,
    projectPath,
    scope: normalizedScope.scope,
    reviewType: normalizedScope.reviewType,
    window: normalizedWindow,
  });
  const outcomeTotals = await loadProjectOutcomeTotals(projectId, filtered);
  return buildSummary(filtered, normalizedWindow, normalizedScope, projectId, outcomeTotals);
}

export async function getProjectTrustAnalyticsTimeseries({ projectId, projectPath, scope, reviewType, metric, window, from, to, interval, now }) {
  const normalizedWindow = normalizeWindow({ window, from, to, now });
  const normalizedScope = normalizeAnalyticsScope({ scope, reviewType });
  const normalizedMetric = normalizeMetric(metric);
  const normalizedInterval = normalizeInterval(interval, normalizedWindow.key);
  const filtered = await loadWindowedProjectReviews({
    projectId,
    projectPath,
    scope: normalizedScope.scope,
    reviewType: normalizedScope.reviewType,
    window: normalizedWindow,
  });
  return buildTimeseries(filtered, {
    metric: normalizedMetric,
    interval: normalizedInterval,
    window: normalizedWindow,
    scope: normalizedScope.scope,
    reviewType: normalizedScope.reviewType,
    projectId,
  });
}

const trustAnalyticsService = {
  normalizeAnalyticsScope,
  buildReviewTrustAnalytics,
  getChangesetTrustAnalytics,
  getBranchReviewTrustAnalytics,
  getWorkspaceReviewTrustAnalytics,
  getPrReviewTrustAnalytics,
  getProjectTrustAnalyticsSummary,
  getProjectTrustAnalyticsTimeseries,
};

export default trustAnalyticsService;
