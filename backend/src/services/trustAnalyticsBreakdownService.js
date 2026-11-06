import trustAnalyticsFactService from './trustAnalyticsFactService.js';
import { normalizeAnalyticsScope, normalizeWindow } from './trustAnalyticsService.js';

const REVIEW_FACT_METRICS = new Set([
  'grounded_issue_rate',
  'deep_coverage_rate',
  'issue_addressed_rate',
  'issue_dismissed_rate',
  'partial_rate',
  'review_count',
  'issues_found',
  'high_risk_findings',
]);

const DIMENSION_FACT_METRICS = new Set([
  'issue_addressed_rate',
  'issue_dismissed_rate',
  'issue_outcome_coverage',
  'issues_found',
  'high_risk_findings',
]);

const SUPPORTED_DIMENSIONS = new Set(['provider_model', 'language', 'path_pattern']);

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeDimension(by) {
  const normalized = String(by || '').trim().toLowerCase();
  if (!SUPPORTED_DIMENSIONS.has(normalized)) {
    throw createHttpError(400, 'by must be one of: provider_model, language, path_pattern');
  }
  return normalized;
}

function normalizeMetric(metric) {
  const normalized = String(metric || '').trim().toLowerCase();
  if (!normalized) {
    throw createHttpError(400, 'metric is required');
  }
  return normalized;
}

function normalizeLimit(limit) {
  const parsed = Number(limit);
  if (!Number.isFinite(parsed)) return 8;
  return Math.max(1, Math.min(20, Math.trunc(parsed)));
}

function buildRateValue(numerator, denominator, minimumSampleSize = 0) {
  const safeNumerator = Math.max(0, Number(numerator) || 0);
  const safeDenominator = Math.max(0, Number(denominator) || 0);
  return {
    value: safeDenominator > 0 ? safeNumerator / safeDenominator : null,
    numerator: safeNumerator,
    denominator: safeDenominator,
    sampleSize: safeDenominator,
    minimumSampleSize,
    isInsufficientSample: minimumSampleSize > 0 && safeDenominator > 0 && safeDenominator < minimumSampleSize,
  };
}

function buildCountValue(value, reviewCount) {
  const safeValue = Math.max(0, Number(value) || 0);
  return {
    value: safeValue,
    numerator: safeValue,
    denominator: null,
    sampleSize: Math.max(0, Number(reviewCount) || 0),
    minimumSampleSize: 0,
    isInsufficientSample: false,
  };
}

function sortGroups(groups, limit) {
  return groups
    .sort((a, b) => {
      const aValue = Number(a.metric.value ?? -1);
      const bValue = Number(b.metric.value ?? -1);
      if (bValue !== aValue) return bValue - aValue;
      return String(a.key).localeCompare(String(b.key));
    })
    .slice(0, limit);
}

function summarizeReviewFactGroup(group, metric) {
  if (metric === 'grounded_issue_rate') {
    return buildRateValue(group.groundedNumerator, group.groundedDenominator, 5);
  }
  if (metric === 'deep_coverage_rate') {
    return buildRateValue(group.deepCoverageNumerator, group.deepCoverageDenominator);
  }
  if (metric === 'issue_addressed_rate') {
    return buildRateValue(group.issueAddressedNumerator, group.issueAddressedDenominator, 3);
  }
  if (metric === 'issue_dismissed_rate') {
    return buildRateValue(group.issueDismissedNumerator, group.issueDismissedDenominator, 3);
  }
  if (metric === 'partial_rate') {
    return buildRateValue(group.partialReviewCount, group.reviewCount);
  }
  if (metric === 'issues_found') {
    return buildCountValue(group.issuesFound, group.reviewCount);
  }
  if (metric === 'high_risk_findings') {
    return buildCountValue(group.highRiskFindings, group.reviewCount);
  }
  return buildCountValue(group.reviewCount, group.reviewCount);
}

function summarizeDimensionFactGroup(group, metric) {
  if (metric === 'issue_addressed_rate') {
    return buildRateValue(group.outcomeAddressedCount, group.issueCount, 3);
  }
  if (metric === 'issue_dismissed_rate') {
    return buildRateValue(group.outcomeDismissedCount, group.issueCount, 3);
  }
  if (metric === 'issue_outcome_coverage') {
    return buildRateValue(group.outcomeRecordedCount, group.issueCount, 3);
  }
  if (metric === 'high_risk_findings') {
    return buildCountValue(group.highRiskCount, group.reviewCount);
  }
  return buildCountValue(group.issueCount, group.reviewCount);
}

function groupReviewFacts(rows, by, metric, limit) {
  const grouped = new Map();
  for (const row of rows) {
    const key = String(row?.providerModel || 'unknown').trim() || 'unknown';
    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        reviewCount: 0,
        deepCoverageNumerator: 0,
        deepCoverageDenominator: 0,
        groundedNumerator: 0,
        groundedDenominator: 0,
        issueAddressedNumerator: 0,
        issueAddressedDenominator: 0,
        issueDismissedNumerator: 0,
        issueDismissedDenominator: 0,
        issuesFound: 0,
        highRiskFindings: 0,
        partialReviewCount: 0,
      });
    }
    const entry = grouped.get(key);
    entry.reviewCount += 1;
    entry.deepCoverageNumerator += Math.max(0, Number(row.deepCoverageNumerator) || 0);
    entry.deepCoverageDenominator += Math.max(0, Number(row.deepCoverageDenominator) || 0);
    entry.groundedNumerator += Math.max(0, Number(row.groundedIssueNumerator) || 0);
    entry.groundedDenominator += Math.max(0, Number(row.groundedIssueDenominator) || 0);
    entry.issueAddressedNumerator += Math.max(0, Number(row.issueAddressedNumerator) || 0);
    entry.issueAddressedDenominator += Math.max(0, Number(row.issueAddressedDenominator) || 0);
    entry.issueDismissedNumerator += Math.max(0, Number(row.issueDismissedNumerator) || 0);
    entry.issueDismissedDenominator += Math.max(0, Number(row.issueDismissedDenominator) || 0);
    entry.issuesFound += Math.max(0, Number(row.issuesFound) || 0);
    entry.highRiskFindings += Math.max(0, Number(row.highRiskFindings) || 0);
    if (row.reviewReliability === 'partial') {
      entry.partialReviewCount += 1;
    }
  }
  return sortGroups(Array.from(grouped.values()).map((entry) => ({
    key: entry.key,
    label: entry.key,
    reviewCount: entry.reviewCount,
    metric: summarizeReviewFactGroup(entry, metric),
  })), limit);
}

function groupDimensionFacts(rows, by, metric, limit) {
  const grouped = new Map();
  for (const row of rows) {
    const key = String(
      by === 'language'
        ? row?.language
        : by === 'path_pattern'
          ? row?.pathPattern
          : row?.providerModel
    || 'unknown').trim() || 'unknown';
    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        reviewIds: new Set(),
        issueCount: 0,
        highRiskCount: 0,
        outcomeAddressedCount: 0,
        outcomeDismissedCount: 0,
        outcomeRecordedCount: 0,
      });
    }
    const entry = grouped.get(key);
    entry.reviewIds.add(`${row.reviewType}:${row.reviewId}`);
    entry.issueCount += Math.max(0, Number(row.issueCount) || 0);
    entry.highRiskCount += Math.max(0, Number(row.highRiskCount) || 0);
    entry.outcomeAddressedCount += Math.max(0, Number(row.outcomeAddressedCount) || 0);
    entry.outcomeDismissedCount += Math.max(0, Number(row.outcomeDismissedCount) || 0);
    entry.outcomeRecordedCount += Math.max(0, Number(row.outcomeRecordedCount) || 0);
  }
  return sortGroups(Array.from(grouped.values()).map((entry) => ({
    key: entry.key,
    label: entry.key,
    reviewCount: entry.reviewIds.size,
    metric: summarizeDimensionFactGroup({
      ...entry,
      reviewCount: entry.reviewIds.size,
    }, metric),
  })), limit);
}

export async function getProjectTrustAnalyticsBreakdown({
  projectId,
  projectPath,
  scope,
  reviewType,
  metric,
  by,
  window,
  from,
  to,
  limit,
}) {
  const normalizedWindow = normalizeWindow({ window, from, to });
  const normalizedScope = normalizeAnalyticsScope({ scope, reviewType });
  const normalizedMetric = normalizeMetric(metric);
  const normalizedDimension = normalizeDimension(by);
  const normalizedLimit = normalizeLimit(limit);

  if (normalizedDimension === 'provider_model') {
    if (!REVIEW_FACT_METRICS.has(normalizedMetric)) {
      throw createHttpError(400, `metric ${normalizedMetric} is not supported for provider_model breakdowns`);
    }
    const rows = await trustAnalyticsFactService.listMergedReviewFactSnapshots({
      projectId,
      projectPath,
      scope: normalizedScope.scope,
      reviewType: normalizedScope.reviewType,
      from: normalizedWindow.from,
      to: normalizedWindow.to,
    });
    return {
      projectId,
      reviewType: normalizedScope.reviewType,
      scope: normalizedScope.scope,
      window: normalizedWindow,
      by: normalizedDimension,
      metric: normalizedMetric,
      groups: groupReviewFacts(rows, normalizedDimension, normalizedMetric, normalizedLimit),
    };
  }

  if (!DIMENSION_FACT_METRICS.has(normalizedMetric)) {
    throw createHttpError(400, `metric ${normalizedMetric} is not supported for ${normalizedDimension} breakdowns`);
  }
  const rows = await trustAnalyticsFactService.listMergedDimensionFactRows({
    projectId,
    projectPath,
    scope: normalizedScope.scope,
    reviewType: normalizedScope.reviewType,
    from: normalizedWindow.from,
    to: normalizedWindow.to,
  });
  return {
    projectId,
    reviewType: normalizedScope.reviewType,
    scope: normalizedScope.scope,
    window: normalizedWindow,
    by: normalizedDimension,
    metric: normalizedMetric,
    groups: groupDimensionFacts(rows, normalizedDimension, normalizedMetric, normalizedLimit),
  };
}

const trustAnalyticsBreakdownService = {
  getProjectTrustAnalyticsBreakdown,
};

export default trustAnalyticsBreakdownService;
