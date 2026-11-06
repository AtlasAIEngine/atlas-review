import db, { getDbType, transaction } from '../db/connection.js';
import changesetService from './changesetService.js';
import branchReviewService from './branchReviewService.js';
import prReviewService from './prReviewService.js';
import workspaceReviewService from './workspaceReviewService.js';
import reviewOutcomeService from './reviewOutcomeService.js';
import { getProjectById } from '../db/queries.js';
import reviewSyncService from './reviewSyncService.js';
import gitService from './gitService.js';

const TERMINAL_REVIEW_STATUSES = new Set(['reviewed', 'failed']);
const VALID_REVIEW_TYPES = new Set(['changeset', 'branch_review', 'pr_review', 'workspace_review']);
const VALID_SCOPE_VALUES = new Set(['all', 'branches', 'prs']);

function toInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.trunc(parsed));
}

function toNullableInt(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.trunc(parsed));
}

function toJsonText(value) {
  if (!Array.isArray(value) && (!value || typeof value !== 'object')) {
    return '[]';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '[]';
  }
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [];
  } catch {
    return [];
  }
}

function normalizeReviewType(reviewType) {
  const normalized = String(reviewType || '').trim().toLowerCase();
  if (normalized === 'all') return null;
  if (!VALID_REVIEW_TYPES.has(normalized)) {
    throw new Error('reviewType must be one of: all, changeset, branch_review, pr_review, workspace_review');
  }
  return normalized;
}

function normalizeScope(scope) {
  if (scope == null || scope === '') return null;
  const normalized = String(scope).trim().toLowerCase();
  if (!VALID_SCOPE_VALUES.has(normalized)) {
    throw new Error('scope must be one of: all, branches, prs');
  }
  return normalized;
}

function resolveRequestedReviewTypes({ scope = null, reviewType = null } = {}) {
  const normalizedScope = normalizeScope(scope);
  const normalizedReviewType = reviewType == null || reviewType === ''
    ? null
    : normalizeReviewType(reviewType);

  if (normalizedReviewType) {
    const derivedScope = normalizedReviewType === 'pr_review' ? 'prs' : 'branches';
    if (normalizedScope && normalizedScope !== 'all' && normalizedScope !== derivedScope) {
      throw new Error('scope does not match the requested reviewType');
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

function getNowExpression() {
  return getDbType() === 'sqlite' ? "datetime('now')" : 'NOW()';
}

function buildRateMetric(numerator, denominator, { minimumSampleSize = 0 } = {}) {
  const safeNumerator = toInt(numerator);
  const safeDenominator = toInt(denominator);
  return {
    value: safeDenominator > 0 ? safeNumerator / safeDenominator : null,
    numerator: safeNumerator,
    denominator: safeDenominator,
    sampleSize: safeDenominator,
    minimumSampleSize: toInt(minimumSampleSize),
    isInsufficientSample: toInt(minimumSampleSize) > 0 && safeDenominator > 0 && safeDenominator < toInt(minimumSampleSize),
  };
}

function normalizeFactScope({ projectId = null, projectPath = null, reviewType, reviewId }) {
  const normalizedReviewType = normalizeReviewType(reviewType);
  const normalizedReviewId = String(reviewId || '').trim();
  if (!normalizedReviewId) {
    throw new Error('reviewId is required for Trust Analytics facts');
  }
  return {
    projectId: typeof projectId === 'string' && projectId.trim() ? projectId.trim() : null,
    projectPath: typeof projectPath === 'string' && projectPath.trim() ? projectPath.trim() : null,
    reviewType: normalizedReviewType,
    reviewId: normalizedReviewId,
  };
}

export function buildReviewFactSnapshot(analytics) {
  if (!analytics || typeof analytics !== 'object') {
    throw new Error('analytics is required to build a Trust Analytics fact snapshot');
  }

  return {
    projectId: analytics.meta?.projectId || null,
    reviewType: analytics.meta?.reviewType || null,
    reviewId: analytics.meta?.reviewId || null,
    displayId: analytics.meta?.displayId || null,
    branchName: analytics.meta?.branchName || null,
    reviewStatus: analytics.reliability?.reviewStatus || 'failed',
    reviewReliability: analytics.reliability?.reviewReliability || 'failed',
    gateStatus: analytics.reliability?.gateStatus || null,
    gateReasonCodes: Array.isArray(analytics.reliability?.gateReasonCodes)
      ? analytics.reliability.gateReasonCodes
      : [],
    providerType: analytics.meta?.providerType || null,
    providerModel: analytics.meta?.providerModel || null,
    createdAtSource: analytics.meta?.createdAt || null,
    completedAt: analytics.meta?.completedAt || null,
    ttfsMs: toNullableInt(analytics.immediateValue?.ttfsMs),
    reviewDurationMs: toNullableInt(analytics.immediateValue?.reviewDurationMs),
    totalChangedFiles: toInt(analytics.immediateValue?.deepCoverage?.denominator),
    deepCoverageNumerator: toInt(analytics.immediateValue?.deepCoverage?.numerator),
    deepCoverageDenominator: toInt(analytics.immediateValue?.deepCoverage?.denominator),
    issuesFound: toInt(analytics.immediateValue?.issuesFound),
    highRiskFindings: toInt(analytics.immediateValue?.highRiskFindings),
    groundedIssueNumerator: toInt(analytics.trustQuality?.groundedIssueRate?.numerator),
    groundedIssueDenominator: toInt(analytics.trustQuality?.groundedIssueRate?.denominator),
    unsupportedIssueNumerator: toInt(analytics.trustQuality?.unsupportedIssueRate?.numerator),
    unsupportedIssueDenominator: toInt(analytics.trustQuality?.unsupportedIssueRate?.denominator),
    lowEvidenceIssueNumerator: toInt(analytics.trustQuality?.lowEvidenceIssueRate?.numerator),
    lowEvidenceIssueDenominator: toInt(analytics.trustQuality?.lowEvidenceIssueRate?.denominator),
    uncorroboratedHighRiskNumerator: toInt(analytics.trustQuality?.uncorroboratedHighRiskRate?.numerator),
    uncorroboratedHighRiskDenominator: toInt(analytics.trustQuality?.uncorroboratedHighRiskRate?.denominator),
    outcomeSuppressionNumerator: toInt(analytics.trustQuality?.outcomeSuppressionRate?.numerator),
    outcomeSuppressionDenominator: toInt(analytics.trustQuality?.outcomeSuppressionRate?.denominator),
    issueAddressedNumerator: toInt(analytics.followThrough?.issueAddressedRate?.numerator),
    issueAddressedDenominator: toInt(analytics.followThrough?.issueAddressedRate?.denominator),
    issueDismissedNumerator: toInt(analytics.followThrough?.issueDismissedRate?.numerator),
    issueDismissedDenominator: toInt(analytics.followThrough?.issueDismissedRate?.denominator),
    issueOutcomeCoverageNumerator: toInt(analytics.followThrough?.issueOutcomeCoverage?.numerator),
    issueOutcomeCoverageDenominator: toInt(analytics.followThrough?.issueOutcomeCoverage?.denominator),
    omittedFiles: toInt(analytics.reliability?.omittedFiles),
    failedFiles: toInt(analytics.reliability?.failedFiles),
  };
}

function buildReviewScopeKey(reviewType, reviewId) {
  return `${String(reviewType || '').trim().toLowerCase()}:${String(reviewId || '').trim()}`;
}

function buildReviewSnapshotKey(reviewType, reviewId, completedAt) {
  return `${buildReviewScopeKey(reviewType, reviewId)}:${String(completedAt || '').trim()}`;
}

function buildDimensionSnapshotKey(reviewType, reviewId, completedAt, recommendationKey) {
  return `${buildReviewSnapshotKey(reviewType, reviewId, completedAt)}:${String(recommendationKey || '').trim()}`;
}

function isWithinRange(completedAt, { from = null, to = null } = {}) {
  const completedMs = new Date(completedAt || '').getTime();
  if (!Number.isFinite(completedMs)) return false;
  if (from) {
    const fromMs = new Date(from).getTime();
    if (Number.isFinite(fromMs) && completedMs < fromMs) return false;
  }
  if (to) {
    const toMs = new Date(to).getTime();
    if (Number.isFinite(toMs) && completedMs > toMs) return false;
  }
  return true;
}

function maxTimestamp(...values) {
  let latest = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const timestamp = new Date(value || '').getTime();
    if (!Number.isFinite(timestamp)) continue;
    if (timestamp > latestMs) {
      latestMs = timestamp;
      latest = new Date(timestamp).toISOString();
    }
  }
  return latest;
}

function isPersistedScopeFresh(persistedUpdatedAt, sourceUpdatedAt) {
  const persistedMs = new Date(persistedUpdatedAt || '').getTime();
  if (!Number.isFinite(persistedMs)) return false;
  const sourceMs = new Date(sourceUpdatedAt || '').getTime();
  if (!Number.isFinite(sourceMs)) return true;
  return persistedMs >= sourceMs;
}

export function hydrateTrustAnalyticsFromFactSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return null;
  return {
    meta: {
      projectId: snapshot.projectId || null,
      reviewType: snapshot.reviewType,
      reviewId: snapshot.reviewId || null,
      displayId: snapshot.displayId || null,
      branchName: snapshot.branchName || null,
      completedAt: snapshot.completedAt || null,
      createdAt: snapshot.createdAtSource || null,
      providerType: snapshot.providerType || null,
      providerModel: snapshot.providerModel || null,
    },
    immediateValue: {
      ttfsMs: snapshot.ttfsMs ?? null,
      reviewDurationMs: snapshot.reviewDurationMs ?? null,
      deepCoverage: buildRateMetric(snapshot.deepCoverageNumerator, snapshot.deepCoverageDenominator),
      issuesFound: toInt(snapshot.issuesFound),
      highRiskFindings: toInt(snapshot.highRiskFindings),
    },
    trustQuality: {
      groundedIssueRate: buildRateMetric(snapshot.groundedIssueNumerator, snapshot.groundedIssueDenominator, { minimumSampleSize: 5 }),
      unsupportedIssueRate: buildRateMetric(snapshot.unsupportedIssueNumerator, snapshot.unsupportedIssueDenominator, { minimumSampleSize: 5 }),
      lowEvidenceIssueRate: buildRateMetric(snapshot.lowEvidenceIssueNumerator, snapshot.lowEvidenceIssueDenominator, { minimumSampleSize: 5 }),
      uncorroboratedHighRiskRate: buildRateMetric(snapshot.uncorroboratedHighRiskNumerator, snapshot.uncorroboratedHighRiskDenominator, { minimumSampleSize: 5 }),
      outcomeSuppressionRate: buildRateMetric(snapshot.outcomeSuppressionNumerator, snapshot.outcomeSuppressionDenominator, { minimumSampleSize: 5 }),
    },
    followThrough: {
      issueAddressedRate: buildRateMetric(snapshot.issueAddressedNumerator, snapshot.issueAddressedDenominator, { minimumSampleSize: 3 }),
      issueDismissedRate: buildRateMetric(snapshot.issueDismissedNumerator, snapshot.issueDismissedDenominator, { minimumSampleSize: 3 }),
      issueOutcomeCoverage: buildRateMetric(snapshot.issueOutcomeCoverageNumerator, snapshot.issueOutcomeCoverageDenominator, { minimumSampleSize: 3 }),
      addressedCount: toInt(snapshot.issueAddressedNumerator),
      dismissedCount: toInt(snapshot.issueDismissedNumerator),
    },
    reliability: {
      reviewReliability: snapshot.reviewReliability || 'failed',
      gateStatus: snapshot.gateStatus || null,
      gateReasonCodes: Array.isArray(snapshot.gateReasonCodes) ? snapshot.gateReasonCodes : [],
      gateEvaluatedAt: null,
      omittedFiles: toInt(snapshot.omittedFiles),
      failedFiles: toInt(snapshot.failedFiles),
      reviewStatus: snapshot.reviewStatus || 'failed',
    },
  };
}

function normalizeFactRow(row) {
  if (!row) return null;
  return {
    projectId: row.project_id,
    reviewType: row.review_type,
    reviewId: row.review_id,
    displayId: row.display_id ?? null,
    branchName: row.branch_name ?? null,
    reviewStatus: row.review_status,
    reviewReliability: row.review_reliability,
    gateStatus: row.gate_status ?? null,
    gateReasonCodes: parseJsonArray(row.gate_reason_codes),
    providerType: row.provider_type ?? null,
    providerModel: row.provider_model ?? null,
    createdAtSource: row.created_at_source ?? null,
    completedAt: row.completed_at ?? null,
    ttfsMs: toNullableInt(row.ttfs_ms),
    reviewDurationMs: toNullableInt(row.review_duration_ms),
    totalChangedFiles: toInt(row.total_changed_files),
    deepCoverageNumerator: toInt(row.deep_coverage_numerator),
    deepCoverageDenominator: toInt(row.deep_coverage_denominator),
    issuesFound: toInt(row.issues_found),
    highRiskFindings: toInt(row.high_risk_findings),
    groundedIssueNumerator: toInt(row.grounded_issue_numerator),
    groundedIssueDenominator: toInt(row.grounded_issue_denominator),
    unsupportedIssueNumerator: toInt(row.unsupported_issue_numerator),
    unsupportedIssueDenominator: toInt(row.unsupported_issue_denominator),
    lowEvidenceIssueNumerator: toInt(row.low_evidence_issue_numerator),
    lowEvidenceIssueDenominator: toInt(row.low_evidence_issue_denominator),
    uncorroboratedHighRiskNumerator: toInt(row.uncorroborated_high_risk_numerator),
    uncorroboratedHighRiskDenominator: toInt(row.uncorroborated_high_risk_denominator),
    outcomeSuppressionNumerator: toInt(row.outcome_suppression_numerator),
    outcomeSuppressionDenominator: toInt(row.outcome_suppression_denominator),
    issueAddressedNumerator: toInt(row.issue_addressed_numerator),
    issueAddressedDenominator: toInt(row.issue_addressed_denominator),
    issueDismissedNumerator: toInt(row.issue_dismissed_numerator),
    issueDismissedDenominator: toInt(row.issue_dismissed_denominator),
    issueOutcomeCoverageNumerator: toInt(row.issue_outcome_coverage_numerator),
    issueOutcomeCoverageDenominator: toInt(row.issue_outcome_coverage_denominator),
    omittedFiles: toInt(row.omitted_files),
    failedFiles: toInt(row.failed_files),
    updatedAt: row.updated_at ?? null,
  };
}

function normalizeDimensionRow(row) {
  if (!row) return null;
  return {
    projectId: row.project_id,
    reviewType: row.review_type,
    reviewId: row.review_id,
    recommendationKey: row.recommendation_key,
    completedAt: row.completed_at ?? null,
    providerType: row.provider_type ?? null,
    providerModel: row.provider_model ?? null,
    language: row.language ?? null,
    pathPattern: row.path_pattern ?? null,
    issueCount: toInt(row.issue_count),
    highRiskCount: toInt(row.high_risk_count),
    outcomeAddressedCount: toInt(row.outcome_addressed_count),
    outcomeDismissedCount: toInt(row.outcome_dismissed_count),
    outcomeRecordedCount: toInt(row.outcome_recorded_count),
    updatedAt: row.updated_at ?? null,
  };
}

export function buildDimensionFactRows({
  analytics,
  reviewPayload,
  outcomesByRecommendationKey = {},
} = {}) {
  const recommendations = Array.isArray(reviewPayload?.recommendations)
    ? reviewPayload.recommendations
    : [];
  const grouped = new Map();
  const providerType = analytics?.meta?.providerType || reviewPayload?.provider?.type || null;
  const providerModel = analytics?.meta?.providerModel || reviewPayload?.provider?.model || null;

  for (const recommendation of recommendations) {
    if (!recommendation || recommendation.type !== 'issue') continue;
    let recommendationKey = null;
    try {
      recommendationKey = reviewOutcomeService.getRecommendationIdentityKey(recommendation);
    } catch {
      recommendationKey = null;
    }
    if (!recommendationKey) continue;
    const outcome = outcomesByRecommendationKey[recommendationKey] || null;
    const dimensions = outcome?.dimensions || reviewOutcomeService.getRecommendationOutcomeDimensions(
      recommendation,
      { providerType, providerModel }
    );
    if (!grouped.has(recommendationKey)) {
      grouped.set(recommendationKey, {
        recommendationKey,
        providerType: dimensions.providerType,
        providerModel: dimensions.providerModel,
        language: dimensions.language,
        pathPattern: dimensions.pathPattern,
        issueCount: 0,
        highRiskCount: 0,
        outcomeAddressedCount: 0,
        outcomeDismissedCount: 0,
        outcomeRecordedCount: 0,
      });
    }
    const entry = grouped.get(recommendationKey);
    entry.issueCount += 1;
    const severity = String(recommendation.severity || '').trim().toLowerCase();
    if (severity === 'high' || severity === 'critical') {
      entry.highRiskCount += 1;
    }
    if (outcome?.status === 'addressed') {
      entry.outcomeAddressedCount += 1;
      entry.outcomeRecordedCount += 1;
    } else if (outcome?.status === 'dismissed') {
      entry.outcomeDismissedCount += 1;
      entry.outcomeRecordedCount += 1;
    }
  }

  return Array.from(grouped.values());
}

async function loadAnalyticsForScope(scope) {
  const {
    getChangesetTrustAnalytics,
    getBranchReviewTrustAnalytics,
    getWorkspaceReviewTrustAnalytics,
    getPrReviewTrustAnalytics,
  } = await import('./trustAnalyticsService.js');
  if (scope.reviewType === 'changeset') {
    if (!scope.projectPath) {
      throw new Error('projectPath is required to sync changeset Trust Analytics facts');
    }
    const changeset = await changesetService.getChangeSet(scope.projectPath, scope.reviewId);
    if (!changeset) return null;
    const analytics = await getChangesetTrustAnalytics({
      projectId: scope.projectId || changeset.projectId || null,
      changeset,
    });
    return {
      projectId: scope.projectId || changeset.projectId || null,
      analytics,
      reviewPayload: changeset.reviewData || null,
    };
  }

  if (scope.reviewType === 'branch_review') {
    const branchReview = await branchReviewService.getById(scope.reviewId);
    if (!branchReview) return null;
    const analytics = await getBranchReviewTrustAnalytics({
      projectId: scope.projectId || branchReview.projectId || null,
      branchReview,
    });
    return {
      projectId: scope.projectId || branchReview.projectId || null,
      analytics,
      reviewPayload: branchReview.reviewJson || null,
    };
  }

  if (scope.reviewType === 'workspace_review') {
    if (!scope.projectPath) {
      throw new Error('projectPath is required to sync workspace review Trust Analytics facts');
    }
    const workspaceReview = await workspaceReviewService.getById(scope.projectPath, scope.reviewId, {
      projectId: scope.projectId || null,
      includeContent: false,
    });
    if (!workspaceReview) return null;
    const analytics = await getWorkspaceReviewTrustAnalytics({
      projectId: scope.projectId || workspaceReview.projectId || null,
      workspaceReview,
    });
    return {
      projectId: scope.projectId || workspaceReview.projectId || null,
      analytics,
      reviewPayload: workspaceReview.reviewJson || null,
    };
  }

  const prReview = await prReviewService.getById(scope.reviewId);
  if (!prReview) return null;
  const analytics = await getPrReviewTrustAnalytics({
    projectId: scope.projectId || prReview.projectId || null,
    prReview,
  });
  return {
    projectId: scope.projectId || prReview.projectId || null,
    analytics,
    reviewPayload: prReview.reviewJson || null,
  };
}

export async function upsertReviewFactSnapshot(snapshot, executor = db) {
  const nowExpr = getNowExpression();
  const result = await executor.query(
    `INSERT INTO trust_review_facts (
        project_id, review_type, review_id, display_id, branch_name, review_status,
        review_reliability, gate_status, gate_reason_codes, provider_type, provider_model,
        created_at_source, completed_at, ttfs_ms, review_duration_ms, total_changed_files,
        deep_coverage_numerator, deep_coverage_denominator, issues_found, high_risk_findings,
        grounded_issue_numerator, grounded_issue_denominator,
        unsupported_issue_numerator, unsupported_issue_denominator,
        low_evidence_issue_numerator, low_evidence_issue_denominator,
        uncorroborated_high_risk_numerator, uncorroborated_high_risk_denominator,
        outcome_suppression_numerator, outcome_suppression_denominator,
        issue_addressed_numerator, issue_addressed_denominator,
        issue_dismissed_numerator, issue_dismissed_denominator,
        issue_outcome_coverage_numerator, issue_outcome_coverage_denominator,
        omitted_files, failed_files
     ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11,
        $12, $13, $14, $15, $16,
        $17, $18, $19, $20,
        $21, $22,
        $23, $24,
        $25, $26,
        $27, $28,
        $29, $30,
        $31, $32,
        $33, $34,
        $35, $36,
        $37, $38
     )
     ON CONFLICT (project_id, review_type, review_id, completed_at) DO UPDATE SET
       display_id = EXCLUDED.display_id,
       branch_name = EXCLUDED.branch_name,
       review_status = EXCLUDED.review_status,
       review_reliability = EXCLUDED.review_reliability,
       gate_status = EXCLUDED.gate_status,
       gate_reason_codes = EXCLUDED.gate_reason_codes,
       provider_type = EXCLUDED.provider_type,
       provider_model = EXCLUDED.provider_model,
       created_at_source = EXCLUDED.created_at_source,
       completed_at = EXCLUDED.completed_at,
       ttfs_ms = EXCLUDED.ttfs_ms,
       review_duration_ms = EXCLUDED.review_duration_ms,
       total_changed_files = EXCLUDED.total_changed_files,
       deep_coverage_numerator = EXCLUDED.deep_coverage_numerator,
       deep_coverage_denominator = EXCLUDED.deep_coverage_denominator,
       issues_found = EXCLUDED.issues_found,
       high_risk_findings = EXCLUDED.high_risk_findings,
       grounded_issue_numerator = EXCLUDED.grounded_issue_numerator,
       grounded_issue_denominator = EXCLUDED.grounded_issue_denominator,
       unsupported_issue_numerator = EXCLUDED.unsupported_issue_numerator,
       unsupported_issue_denominator = EXCLUDED.unsupported_issue_denominator,
       low_evidence_issue_numerator = EXCLUDED.low_evidence_issue_numerator,
       low_evidence_issue_denominator = EXCLUDED.low_evidence_issue_denominator,
       uncorroborated_high_risk_numerator = EXCLUDED.uncorroborated_high_risk_numerator,
       uncorroborated_high_risk_denominator = EXCLUDED.uncorroborated_high_risk_denominator,
       outcome_suppression_numerator = EXCLUDED.outcome_suppression_numerator,
       outcome_suppression_denominator = EXCLUDED.outcome_suppression_denominator,
       issue_addressed_numerator = EXCLUDED.issue_addressed_numerator,
       issue_addressed_denominator = EXCLUDED.issue_addressed_denominator,
       issue_dismissed_numerator = EXCLUDED.issue_dismissed_numerator,
       issue_dismissed_denominator = EXCLUDED.issue_dismissed_denominator,
       issue_outcome_coverage_numerator = EXCLUDED.issue_outcome_coverage_numerator,
       issue_outcome_coverage_denominator = EXCLUDED.issue_outcome_coverage_denominator,
       omitted_files = EXCLUDED.omitted_files,
       failed_files = EXCLUDED.failed_files,
       updated_at = ${nowExpr}
     RETURNING *`,
    [
      snapshot.projectId,
      snapshot.reviewType,
      snapshot.reviewId,
      snapshot.displayId,
      snapshot.branchName,
      snapshot.reviewStatus,
      snapshot.reviewReliability,
      snapshot.gateStatus,
      toJsonText(snapshot.gateReasonCodes),
      snapshot.providerType,
      snapshot.providerModel,
      snapshot.createdAtSource,
      snapshot.completedAt,
      snapshot.ttfsMs,
      snapshot.reviewDurationMs,
      snapshot.totalChangedFiles,
      snapshot.deepCoverageNumerator,
      snapshot.deepCoverageDenominator,
      snapshot.issuesFound,
      snapshot.highRiskFindings,
      snapshot.groundedIssueNumerator,
      snapshot.groundedIssueDenominator,
      snapshot.unsupportedIssueNumerator,
      snapshot.unsupportedIssueDenominator,
      snapshot.lowEvidenceIssueNumerator,
      snapshot.lowEvidenceIssueDenominator,
      snapshot.uncorroboratedHighRiskNumerator,
      snapshot.uncorroboratedHighRiskDenominator,
      snapshot.outcomeSuppressionNumerator,
      snapshot.outcomeSuppressionDenominator,
      snapshot.issueAddressedNumerator,
      snapshot.issueAddressedDenominator,
      snapshot.issueDismissedNumerator,
      snapshot.issueDismissedDenominator,
      snapshot.issueOutcomeCoverageNumerator,
      snapshot.issueOutcomeCoverageDenominator,
      snapshot.omittedFiles,
      snapshot.failedFiles,
    ]
  );
  return normalizeFactRow(result.rows?.[0] || null);
}

async function replaceDimensionFactRows(scope, rows = [], executor = db) {
  const nowExpr = getNowExpression();
  await executor.query(
    `DELETE FROM trust_review_dimension_facts
     WHERE project_id = $1 AND review_type = $2 AND review_id = $3`,
    [scope.projectId, scope.reviewType, scope.reviewId]
  );
  for (const row of rows) {
    await executor.query(
      `INSERT INTO trust_review_dimension_facts (
          project_id, review_type, review_id, recommendation_key, completed_at,
          provider_type, provider_model, language, path_pattern,
          issue_count, high_risk_count, outcome_addressed_count,
          outcome_dismissed_count, outcome_recorded_count
       ) VALUES (
          $1, $2, $3, $4, $5,
          $6, $7, $8, $9,
          $10, $11, $12,
          $13, $14
       )
       ON CONFLICT (project_id, review_type, review_id, completed_at, recommendation_key) DO UPDATE SET
         completed_at = EXCLUDED.completed_at,
         provider_type = EXCLUDED.provider_type,
         provider_model = EXCLUDED.provider_model,
         language = EXCLUDED.language,
         path_pattern = EXCLUDED.path_pattern,
         issue_count = EXCLUDED.issue_count,
         high_risk_count = EXCLUDED.high_risk_count,
         outcome_addressed_count = EXCLUDED.outcome_addressed_count,
         outcome_dismissed_count = EXCLUDED.outcome_dismissed_count,
         outcome_recorded_count = EXCLUDED.outcome_recorded_count,
         updated_at = ${nowExpr}`,
      [
        scope.projectId,
        scope.reviewType,
        scope.reviewId,
        row.recommendationKey,
        row.completedAt,
        row.providerType,
        row.providerModel,
        row.language,
        row.pathPattern,
        row.issueCount,
        row.highRiskCount,
        row.outcomeAddressedCount,
        row.outcomeDismissedCount,
        row.outcomeRecordedCount,
      ]
    );
  }
}

export async function deleteReviewFacts(scopeLike, executor = db) {
  const scope = normalizeFactScope(scopeLike);
  if (!scope.projectId) {
    const loaded = await loadAnalyticsForScope(scope).catch(() => null);
    scope.projectId = loaded?.projectId || null;
  }
  if (!scope.projectId) return;
  await executor.query(
    `DELETE FROM trust_review_dimension_facts
     WHERE project_id = $1 AND review_type = $2 AND review_id = $3`,
    [scope.projectId, scope.reviewType, scope.reviewId]
  );
  await executor.query(
    `DELETE FROM trust_review_facts
     WHERE project_id = $1 AND review_type = $2 AND review_id = $3`,
    [scope.projectId, scope.reviewType, scope.reviewId]
  );
}

export async function syncReviewFacts(scopeLike) {
  const scope = normalizeFactScope(scopeLike);
  const loaded = await loadAnalyticsForScope(scope);
  if (!loaded) {
    await transaction(async (tx) => {
      await deleteReviewFacts(scope, tx);
    });
    return { status: 'deleted', reviewId: scope.reviewId };
  }
  if (!loaded.analytics) {
    return { status: 'skipped', reviewId: scope.reviewId, reason: 'analytics_unavailable' };
  }

  const projectId = loaded.projectId || loaded.analytics.meta?.projectId || scope.projectId;
  const reviewStatus = String(loaded.analytics.reliability?.reviewStatus || '').trim().toLowerCase();
  if (!projectId || !TERMINAL_REVIEW_STATUSES.has(reviewStatus) || !loaded.analytics.meta?.completedAt) {
    return { status: 'skipped', reviewId: scope.reviewId, reason: 'review_not_terminal' };
  }

  const factSnapshot = buildReviewFactSnapshot({
    ...loaded.analytics,
    meta: {
      ...loaded.analytics.meta,
      projectId,
      createdAt: loaded.analytics.meta?.createdAt || null,
    },
  });
  const outcomes = await reviewOutcomeService.listOutcomes(
    {
      projectId,
      reviewType: scope.reviewType,
      reviewId: scope.reviewId,
    },
    {
      reviewRecommendations: Array.isArray(loaded.reviewPayload?.recommendations)
        ? loaded.reviewPayload.recommendations
        : [],
    }
  );
  const dimensionRows = buildDimensionFactRows({
    analytics: loaded.analytics,
    reviewPayload: loaded.reviewPayload,
    outcomesByRecommendationKey: outcomes.byRecommendationKey,
  }).map((row) => ({
    ...row,
    completedAt: loaded.analytics.meta?.completedAt || null,
  }));
  await transaction(async (tx) => {
    await upsertReviewFactSnapshot(factSnapshot, tx);
    await replaceDimensionFactRows(
      { projectId, reviewType: scope.reviewType, reviewId: scope.reviewId },
      dimensionRows,
      tx
    );
  });
  try {
    const project = projectId ? await getProjectById(projectId).catch(() => null) : null;
    const effectivePath = project?.path || scope.projectPath || null;
    let repoRemoteUrl = null;
    if (effectivePath) {
      try { repoRemoteUrl = await gitService.getRemoteUrl(effectivePath); } catch { /* no git remote */ }
    }
    await reviewSyncService.queueEvent(
      reviewSyncService.buildReviewCompletedEvent({
        userId: project?.user_id || null,
        projectId,
        projectName: project?.name || null,
        projectPath: project?.path || scope.projectPath || null,
        reviewType: scope.reviewType,
        reviewId: scope.reviewId,
        displayId: factSnapshot.displayId,
        branchName: factSnapshot.branchName,
        reviewStatus: factSnapshot.reviewStatus,
        reviewReliability: factSnapshot.reviewReliability,
        providerType: factSnapshot.providerType,
        providerModel: factSnapshot.providerModel,
        completedAt: factSnapshot.completedAt,
        issuesFound: factSnapshot.issuesFound,
        highRiskFindings: factSnapshot.highRiskFindings,
        inputTokens: Number(loaded.reviewPayload?.tokensUsed?.input || 0),
        outputTokens: Number(loaded.reviewPayload?.tokensUsed?.output || 0),
        totalTokens: Number(
          loaded.reviewPayload?.tokensUsed?.input || 0
        ) + Number(
          loaded.reviewPayload?.tokensUsed?.output || 0
        ),
        estimatedCost: Number(loaded.reviewPayload?.estimatedCost || 0),
        costSource: loaded.reviewPayload?.costSource || null,
        costIsApproximate: typeof loaded.reviewPayload?.costIsApproximate === 'boolean'
          ? loaded.reviewPayload.costIsApproximate
          : null,
        repoRemoteUrl,
      })
    );
  } catch (error) {
    console.warn('[review-sync] Failed to queue review_completed event', {
      projectId,
      reviewType: scope.reviewType,
      reviewId: scope.reviewId,
      error: error?.message || error,
    });
  }
  return {
    status: 'synced',
    reviewId: scope.reviewId,
    reviewType: scope.reviewType,
    projectId,
    dimensionRowCount: dimensionRows.length,
  };
}

export async function listReviewFactSnapshots({ projectId, scope = null, reviewType = null, from = null, to = null } = {}) {
  const resolved = resolveRequestedReviewTypes({ scope, reviewType });
  const params = [projectId];
  let whereSql = 'project_id = $1';
  if (resolved.reviewTypes?.length === 1) {
    params.push(resolved.reviewTypes[0]);
    whereSql += ` AND review_type = $${params.length}`;
  } else if (resolved.reviewTypes?.length > 1) {
    const placeholders = resolved.reviewTypes.map((value) => {
      params.push(value);
      return `$${params.length}`;
    });
    whereSql += ` AND review_type IN (${placeholders.join(', ')})`;
  }
  if (from) {
    params.push(from);
    whereSql += ` AND completed_at >= $${params.length}`;
  }
  if (to) {
    params.push(to);
    whereSql += ` AND completed_at <= $${params.length}`;
  }
  const result = await db.query(
    `SELECT * FROM trust_review_facts WHERE ${whereSql} ORDER BY completed_at ASC`,
    params
  );
  return (result.rows || []).map(normalizeFactRow).filter(Boolean);
}

export async function listDimensionFactRows({ projectId, scope = null, reviewType = null, from = null, to = null } = {}) {
  const resolved = resolveRequestedReviewTypes({ scope, reviewType });
  const params = [projectId];
  let whereSql = 'project_id = $1';
  if (resolved.reviewTypes?.length === 1) {
    params.push(resolved.reviewTypes[0]);
    whereSql += ` AND review_type = $${params.length}`;
  } else if (resolved.reviewTypes?.length > 1) {
    const placeholders = resolved.reviewTypes.map((value) => {
      params.push(value);
      return `$${params.length}`;
    });
    whereSql += ` AND review_type IN (${placeholders.join(', ')})`;
  }
  if (from) {
    params.push(from);
    whereSql += ` AND completed_at >= $${params.length}`;
  }
  if (to) {
    params.push(to);
    whereSql += ` AND completed_at <= $${params.length}`;
  }
  const result = await db.query(
    `SELECT * FROM trust_review_dimension_facts WHERE ${whereSql} ORDER BY completed_at ASC`,
    params
  );
  return (result.rows || []).map(normalizeDimensionRow).filter(Boolean);
}

async function listProjectTerminalScopes({ projectId, projectPath, scope = null, reviewType = null } = {}) {
  const resolved = resolveRequestedReviewTypes({ scope, reviewType });
  const scopes = [];

  if (!resolved.reviewTypes || resolved.reviewTypes.includes('branch_review')) {
    const branchReviews = await branchReviewService.getByProject(projectId);
    for (const review of branchReviews) {
      const reviewStatus = String(review?.reviewStatus || '').trim().toLowerCase();
      if (!TERMINAL_REVIEW_STATUSES.has(reviewStatus)) continue;
      scopes.push({
        projectId,
        reviewType: 'branch_review',
        reviewId: review.id,
        sourceUpdatedAt: maxTimestamp(review.updatedAt, review.reviewedAt, review.createdAt),
      });
    }
  }

  if (!resolved.reviewTypes || resolved.reviewTypes.includes('workspace_review')) {
    if (!projectPath) {
      throw new Error('projectPath is required for Trust Analytics workspace review reads');
    }
    const workspaceReviews = await workspaceReviewService.list(projectPath, { projectId });
    for (const review of workspaceReviews) {
      const reviewStatus = String(review?.reviewStatus || '').trim().toLowerCase();
      if (!TERMINAL_REVIEW_STATUSES.has(reviewStatus)) continue;
      scopes.push({
        projectId,
        projectPath,
        reviewType: 'workspace_review',
        reviewId: review.id,
        sourceUpdatedAt: maxTimestamp(review.updatedAt, review.reviewedAt, review.createdAt),
      });
    }
  }

  if (!resolved.reviewTypes || resolved.reviewTypes.includes('changeset')) {
    if (!projectPath) {
      throw new Error('projectPath is required for Trust Analytics changeset reads');
    }
    const changesets = await changesetService.getChangeSets(projectPath);
    for (const changeset of changesets) {
      const reviewStatus = String(changeset?.reviewStatus || '').trim().toLowerCase();
      if (!TERMINAL_REVIEW_STATUSES.has(reviewStatus)) continue;
      scopes.push({
        projectId,
        projectPath,
        reviewType: 'changeset',
        reviewId: changeset.id,
        sourceUpdatedAt: maxTimestamp(changeset.updatedAt, changeset.reviewedAt, changeset.createdAt),
      });
    }
  }

  if (!resolved.reviewTypes || resolved.reviewTypes.includes('pr_review')) {
    const prReviews = await prReviewService.getByProject(projectId);
    for (const review of prReviews) {
      const reviewStatus = String(review?.reviewStatus || '').trim().toLowerCase();
      if (!TERMINAL_REVIEW_STATUSES.has(reviewStatus)) continue;
      scopes.push({
        projectId,
        reviewType: 'pr_review',
        reviewId: review.id,
        sourceUpdatedAt: maxTimestamp(review.updatedAt, review.reviewedAt, review.createdAt),
      });
    }
  }

  return scopes;
}

async function listOutcomeFreshnessByScope({ projectId, scope = null, reviewType = null } = {}) {
  const resolved = resolveRequestedReviewTypes({ scope, reviewType });
  const params = [projectId];
  let whereSql = 'project_id = $1';
  if (resolved.reviewTypes?.length === 1) {
    params.push(resolved.reviewTypes[0]);
    whereSql += ` AND review_type = $${params.length}`;
  } else if (resolved.reviewTypes?.length > 1) {
    const placeholders = resolved.reviewTypes.map((value) => {
      params.push(value);
      return `$${params.length}`;
    });
    whereSql += ` AND review_type IN (${placeholders.join(', ')})`;
  }
  const result = await db.query(
    `SELECT review_type, review_id, MAX(updated_at) AS latest_updated_at
     FROM review_outcomes
     WHERE ${whereSql}
     GROUP BY review_type, review_id`,
    params
  );
  const freshness = new Map();
  for (const row of result.rows || []) {
    freshness.set(
      buildReviewScopeKey(row.review_type, row.review_id),
      maxTimestamp(row.latest_updated_at)
    );
  }
  return freshness;
}

async function buildLiveFactDataForScope(scope) {
  const loaded = await loadAnalyticsForScope(scope);
  if (!loaded?.analytics) return null;

  const projectId = loaded.projectId || loaded.analytics.meta?.projectId || scope.projectId;
  const reviewStatus = String(loaded.analytics.reliability?.reviewStatus || '').trim().toLowerCase();
  if (!projectId || !TERMINAL_REVIEW_STATUSES.has(reviewStatus) || !loaded.analytics.meta?.completedAt) {
    return null;
  }

  const outcomes = await reviewOutcomeService.listOutcomes(
    {
      projectId,
      reviewType: scope.reviewType,
      reviewId: scope.reviewId,
    },
    {
      reviewRecommendations: Array.isArray(loaded.reviewPayload?.recommendations)
        ? loaded.reviewPayload.recommendations
        : [],
    }
  );

  const snapshot = buildReviewFactSnapshot({
    ...loaded.analytics,
    meta: {
      ...loaded.analytics.meta,
      projectId,
      createdAt: loaded.analytics.meta?.createdAt || null,
    },
  });
  const dimensionRows = buildDimensionFactRows({
    analytics: loaded.analytics,
    reviewPayload: loaded.reviewPayload,
    outcomesByRecommendationKey: outcomes.byRecommendationKey,
  }).map((row) => ({
    projectId,
    reviewType: scope.reviewType,
    reviewId: scope.reviewId,
    completedAt: loaded.analytics.meta?.completedAt || null,
    ...row,
  }));

  return {
    snapshot,
    dimensionRows,
  };
}

export async function listMergedReviewFactSnapshots({ projectId, projectPath, scope = null, reviewType = null, from = null, to = null } = {}) {
  const persistedRows = await listReviewFactSnapshots({ projectId, scope, reviewType, from, to });
  const scopes = await listProjectTerminalScopes({ projectId, projectPath, scope, reviewType });
  const outcomeFreshness = await listOutcomeFreshnessByScope({ projectId, scope, reviewType });
  const activeScopeKeys = new Set(
    scopes.map((entry) => buildReviewScopeKey(entry.reviewType, entry.reviewId))
  );
  const scopedPersistedRows = persistedRows.filter((row) => activeScopeKeys.has(buildReviewScopeKey(row.reviewType, row.reviewId)));
  const merged = new Map(
    scopedPersistedRows.map((row) => [buildReviewSnapshotKey(row.reviewType, row.reviewId, row.completedAt), row])
  );
  const latestPersistedByScope = new Map();

  for (const row of scopedPersistedRows) {
    const scopeKey = buildReviewScopeKey(row.reviewType, row.reviewId);
    const existing = latestPersistedByScope.get(scopeKey);
    if (!existing || String(existing.completedAt || '').localeCompare(String(row.completedAt || '')) < 0) {
      latestPersistedByScope.set(scopeKey, row);
    }
  }

  for (const scope of scopes) {
    const scopeKey = buildReviewScopeKey(scope.reviewType, scope.reviewId);
    const persisted = latestPersistedByScope.get(scopeKey);
    const sourceUpdatedAt = maxTimestamp(scope.sourceUpdatedAt, outcomeFreshness.get(scopeKey));
    if (persisted && isPersistedScopeFresh(persisted.updatedAt, sourceUpdatedAt)) {
      continue;
    }

    const liveData = await buildLiveFactDataForScope(scope);
    if (!liveData?.snapshot) {
      for (const key of Array.from(merged.keys())) {
        if (key.startsWith(`${scopeKey}:`)) {
          merged.delete(key);
        }
      }
      continue;
    }
    if (!isWithinRange(liveData.snapshot.completedAt, { from, to })) {
      continue;
    }
    merged.set(
      buildReviewSnapshotKey(liveData.snapshot.reviewType, liveData.snapshot.reviewId, liveData.snapshot.completedAt),
      liveData.snapshot
    );
  }

  return Array.from(merged.values()).sort((a, b) => String(a.completedAt || '').localeCompare(String(b.completedAt || '')));
}

export async function listMergedDimensionFactRows({ projectId, projectPath, scope = null, reviewType = null, from = null, to = null } = {}) {
  const persistedRows = await listDimensionFactRows({ projectId, scope, reviewType, from, to });
  const scopes = await listProjectTerminalScopes({ projectId, projectPath, scope, reviewType });
  const outcomeFreshness = await listOutcomeFreshnessByScope({ projectId, scope, reviewType });
  const activeScopeKeys = new Set(
    scopes.map((entry) => buildReviewScopeKey(entry.reviewType, entry.reviewId))
  );
  const merged = new Map(
    persistedRows
      .filter((row) => activeScopeKeys.has(buildReviewScopeKey(row.reviewType, row.reviewId)))
      .map((row) => [buildDimensionSnapshotKey(row.reviewType, row.reviewId, row.completedAt, row.recommendationKey), row])
  );
  const persistedScopeFreshness = new Map();

  for (const row of persistedRows) {
    const scopeKey = buildReviewScopeKey(row.reviewType, row.reviewId);
    if (!activeScopeKeys.has(scopeKey)) continue;
    persistedScopeFreshness.set(
      scopeKey,
      maxTimestamp(persistedScopeFreshness.get(scopeKey), row.updatedAt)
    );
  }

  for (const scope of scopes) {
    const scopeKey = buildReviewScopeKey(scope.reviewType, scope.reviewId);
    const sourceUpdatedAt = maxTimestamp(scope.sourceUpdatedAt, outcomeFreshness.get(scopeKey));
    if (isPersistedScopeFresh(persistedScopeFreshness.get(scopeKey), sourceUpdatedAt)) {
      continue;
    }

    const liveData = await buildLiveFactDataForScope(scope);
    if (!liveData?.dimensionRows?.length) {
      for (const key of Array.from(merged.keys())) {
        if (key.startsWith(`${scopeKey}:`)) {
          merged.delete(key);
        }
      }
      continue;
    }
    for (const key of Array.from(merged.keys())) {
      if (key.startsWith(`${scopeKey}:`)) {
        merged.delete(key);
      }
    }
    for (const row of liveData.dimensionRows) {
      if (!isWithinRange(row.completedAt, { from, to })) continue;
      merged.set(buildDimensionSnapshotKey(row.reviewType, row.reviewId, row.completedAt, row.recommendationKey), row);
    }
  }

  return Array.from(merged.values()).sort((a, b) => String(a.completedAt || '').localeCompare(String(b.completedAt || '')));
}

export async function backfillProjectTrustAnalytics({ projectId, projectPath, dryRun = false } = {}) {
  if (!projectId || !projectPath) {
    throw new Error('projectId and projectPath are required for Trust Analytics backfill');
  }
  const branchReviews = await branchReviewService.getByProject(projectId);
  const changesets = await changesetService.getChangeSets(projectPath);
  const workspaceReviews = await workspaceReviewService.list(projectPath, { projectId });
  const scopes = [];

  for (const review of branchReviews) {
    const reviewStatus = String(review?.reviewStatus || '').trim().toLowerCase();
    if (!TERMINAL_REVIEW_STATUSES.has(reviewStatus)) continue;
    scopes.push({ projectId, projectPath, reviewType: 'branch_review', reviewId: review.id });
  }
  for (const changeset of changesets) {
    const reviewStatus = String(changeset?.reviewStatus || '').trim().toLowerCase();
    if (!TERMINAL_REVIEW_STATUSES.has(reviewStatus)) continue;
    scopes.push({ projectId, projectPath, reviewType: 'changeset', reviewId: changeset.id });
  }
  for (const review of workspaceReviews) {
    const reviewStatus = String(review?.reviewStatus || '').trim().toLowerCase();
    if (!TERMINAL_REVIEW_STATUSES.has(reviewStatus)) continue;
    scopes.push({ projectId, projectPath, reviewType: 'workspace_review', reviewId: review.id });
  }
  const prReviews = await prReviewService.getByProject(projectId);
  for (const review of prReviews) {
    const reviewStatus = String(review?.reviewStatus || '').trim().toLowerCase();
    if (!TERMINAL_REVIEW_STATUSES.has(reviewStatus)) continue;
    scopes.push({ projectId, projectPath, reviewType: 'pr_review', reviewId: review.id });
  }

  const results = [];
  for (const scope of scopes) {
    if (dryRun) {
      results.push({ ...scope, status: 'dry-run' });
      continue;
    }
    const synced = await syncReviewFacts(scope);
    results.push(synced);
  }
  return {
    projectId,
    reviewCount: scopes.length,
    syncedCount: results.filter((entry) => entry.status === 'synced').length,
    dryRun: Boolean(dryRun),
    results,
  };
}

const trustAnalyticsFactService = {
  buildReviewFactSnapshot,
  hydrateTrustAnalyticsFromFactSnapshot,
  buildDimensionFactRows,
  upsertReviewFactSnapshot,
  deleteReviewFacts,
  syncReviewFacts,
  listReviewFactSnapshots,
  listDimensionFactRows,
  listMergedReviewFactSnapshots,
  listMergedDimensionFactRows,
  backfillProjectTrustAnalytics,
};

export default trustAnalyticsFactService;
