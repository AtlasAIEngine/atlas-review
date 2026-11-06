/**
 * PR Review Service
 * CRUD operations for pr_reviews table.
 *
 * Follows the same pattern as branchReviewService.js —
 * uses async db.query() abstraction for PostgreSQL/SQLite dual-DB support.
 */

import { query, getDbType } from '../db/connection.js';
import { randomUUID } from 'crypto';
import { assignReviewFindingIds } from './review/reviewFindingIds.js';

// Re-use the same sanitization logic from branchReviewService
const VALID_RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);
const RISK_WEIGHT = { low: 0, medium: 1, high: 2, critical: 3 };

function normalizeRiskLevel(value, fallback = 'medium') {
  const normalized = String(value || '').trim().toLowerCase();
  if (VALID_RISK_LEVELS.has(normalized)) return normalized;
  return VALID_RISK_LEVELS.has(fallback) ? fallback : 'medium';
}

function normalizeRecommendationType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'issue' || normalized === 'suggestion' || normalized === 'praise') return normalized;
  if (normalized === 'bug' || normalized === 'warning' || normalized === 'error' || normalized === 'problem') return 'issue';
  if (normalized === 'note' || normalized === 'nit' || normalized === 'info') return 'suggestion';
  return 'suggestion';
}

function normalizeRecommendationFingerprintPart(value) {
  return String(value ?? '')
    .replace(/\\+\|/g, '\\|')
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, '\'')
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function buildRecommendationIdentityKey(recommendation = {}) {
  const explicitKey = normalizeRecommendationFingerprintPart(recommendation.recommendationKey);
  if (explicitKey) {
    return explicitKey;
  }
  const escapePipe = (value) => value.replace(/\|/g, '\\|');
  return [
    escapePipe(normalizeRecommendationFingerprintPart(recommendation.type)),
    escapePipe(normalizeRecommendationFingerprintPart(recommendation.severity)),
    escapePipe(normalizeRecommendationFingerprintPart(recommendation.title)),
    escapePipe(normalizeRecommendationFingerprintPart(recommendation.description)),
    escapePipe(normalizeRecommendationFingerprintPart(recommendation.file)),
    escapePipe(normalizeRecommendationFingerprintPart(recommendation.line)),
    escapePipe(normalizeRecommendationFingerprintPart(recommendation.suggestedFix)),
  ].join('|');
}

function sanitizePersistedReviewJson(rawReview) {
  if (!rawReview || typeof rawReview !== 'object' || Array.isArray(rawReview)) return rawReview;
  const review = { ...rawReview };
  const sourceRecommendations = Array.isArray(rawReview.recommendations) ? rawReview.recommendations : [];
  const recommendations = [];
  for (const rawRec of sourceRecommendations) {
    if (!rawRec || typeof rawRec !== 'object' || Array.isArray(rawRec)) continue;
    const rec = { ...rawRec };
    rec.type = normalizeRecommendationType(rec.type);
    rec.severity = normalizeRiskLevel(rec.severity, 'low');
    if (rec.type !== 'issue' && (rec.severity === 'high' || rec.severity === 'critical')) {
      rec.severity = 'medium';
    }
    rec.recommendationKey = buildRecommendationIdentityKey(rec);
    rec.commentEligible = rec.commentEligible === true;
    if (rec.commentEligibility && typeof rec.commentEligibility === 'object' && !Array.isArray(rec.commentEligibility)) {
      rec.commentEligibility = {
        eligible: rec.commentEligibility.eligible === true,
        confidence: typeof rec.commentEligibility.confidence === 'string' && rec.commentEligibility.confidence.trim()
          ? rec.commentEligibility.confidence.trim().toLowerCase()
          : null,
        reasonCodes: Array.isArray(rec.commentEligibility.reasonCodes)
          ? rec.commentEligibility.reasonCodes
            .map((entry) => String(entry || '').trim().toLowerCase())
            .filter(Boolean)
          : [],
      };
    } else {
      rec.commentEligibility = {
        eligible: rec.commentEligible,
        confidence: null,
        reasonCodes: [],
      };
    }
    recommendations.push(rec);
  }
  review.recommendations = recommendations;
  const commentEligibilityStats = review?.stats?.commentEligibility
    && typeof review.stats.commentEligibility === 'object'
    && !Array.isArray(review.stats.commentEligibility)
    ? review.stats.commentEligibility
    : null;
  if (review.stats && typeof review.stats === 'object') {
    review.stats = { ...review.stats };
    if (commentEligibilityStats) {
      review.stats.commentEligibility = {
        totalFindings: Math.max(0, Math.trunc(Number(commentEligibilityStats.totalFindings) || recommendations.length)),
        eligibleFindings: Math.max(0, Math.trunc(Number(commentEligibilityStats.eligibleFindings) || 0)),
        withheldFindings: Math.max(0, Math.trunc(Number(commentEligibilityStats.withheldFindings) || 0)),
        reasonCounts: commentEligibilityStats.reasonCounts && typeof commentEligibilityStats.reasonCounts === 'object'
          ? Object.fromEntries(
            Object.entries(commentEligibilityStats.reasonCounts)
              .map(([key, value]) => [String(key || '').trim().toLowerCase(), Math.max(0, Math.trunc(Number(value) || 0))])
              .filter(([key]) => key)
          )
          : {},
      };
    }
  }
  const actionable = recommendations.filter((r) => r && r.type !== 'praise');
  if (actionable.length > 0) {
    let highest = 'low';
    for (const rec of actionable) {
      const severity = normalizeRiskLevel(rec.severity, 'low');
      if (RISK_WEIGHT[severity] > RISK_WEIGHT[highest]) highest = severity;
    }
    review.riskLevel = highest;
  } else {
    review.riskLevel = normalizeRiskLevel(review.riskLevel, 'medium');
  }
  return assignReviewFindingIds(review);
}

function parseReviewJson(value) {
  if (!value) return null;
  if (typeof value !== 'string') return sanitizePersistedReviewJson(value);
  try {
    return sanitizePersistedReviewJson(JSON.parse(value));
  } catch (error) {
    console.warn('Invalid pr_review review_json payload:', error.message);
    return null;
  }
}

function parseLabels(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseLoginList(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
  }
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parseAssignees(value) {
  return parseLoginList(value);
}

function parseRequestedReviewers(value) {
  return parseLoginList(value);
}

function parseReviewerParticipants(value) {
  return parseLoginList(value);
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeReasonCodes(values) {
  if (!Array.isArray(values)) return [];
  return values
    .map((entry) => String(entry || '').trim().toLowerCase())
    .filter(Boolean);
}

function buildParityReasonCodes(review, metrics) {
  const reasonCodes = [];
  const reviewTier = String(metrics.reviewTier || '').trim().toLowerCase();
  if (reviewTier === 'failed' || reviewTier === 'partial') {
    reasonCodes.push('partial_review');
  } else if (reviewTier === 'files_only') {
    reasonCodes.push('files_only_review');
  }
  if (metrics.totalFiles >= 5 && metrics.deepCoverageRate < 0.75) {
    reasonCodes.push('deep_coverage_below_floor');
  }
  if (metrics.totalFindings > 0 && metrics.eligibleFindings === 0) {
    reasonCodes.push('no_comment_ready_findings');
  } else if (metrics.totalFindings > 0 && metrics.commentReadyRate <= 0.5) {
    reasonCodes.push('comment_ready_rate_low');
  }
  if (!metrics.hasVerificationSummary) {
    reasonCodes.push('verification_summary_missing');
  }
  return Array.from(new Set(reasonCodes));
}

function buildReviewParityGate(review) {
  const reviewJson = review?.reviewJson && typeof review.reviewJson === 'object' && !Array.isArray(review.reviewJson)
    ? review.reviewJson
    : null;
  if (!reviewJson) return null;
  const stats = reviewJson.stats && typeof reviewJson.stats === 'object' && !Array.isArray(reviewJson.stats)
    ? reviewJson.stats
    : {};
  const recommendations = Array.isArray(reviewJson.recommendations) ? reviewJson.recommendations : [];
  const totalFiles = Math.max(
    0,
    Number(stats.filesTotal)
    || Number(stats.totalChangedFiles)
    || Number(review?.fileCount)
    || 0
  );
  const deepReviewedFiles = Math.max(
    0,
    Number(stats.filesDeepReviewed)
    || Number(stats.deepReviewedFiles)
    || Number(stats.filesAnalyzed)
    || 0
  );
  const deepCoverageRate = totalFiles > 0
    ? Math.min(1, deepReviewedFiles / totalFiles)
    : 1;
  const commentEligibility = (
    stats.commentEligibility
    && typeof stats.commentEligibility === 'object'
    && !Array.isArray(stats.commentEligibility)
  ) ? stats.commentEligibility : null;
  const actionableFindings = recommendations.filter((entry) => entry && entry.type !== 'praise');
  const totalFindings = Math.max(
    0,
    Number(commentEligibility?.totalFindings)
    || actionableFindings.length
  );
  const eligibleFindings = Math.max(
    0,
    Number(commentEligibility?.eligibleFindings)
    || actionableFindings.filter((entry) => entry?.commentEligible === true).length
  );
  const withheldFindings = Math.max(
    0,
    Number(commentEligibility?.withheldFindings)
    || Math.max(0, totalFindings - eligibleFindings)
  );
  const commentReadyRate = totalFindings > 0 ? Math.min(1, eligibleFindings / totalFindings) : 1;
  const verificationLines = Array.isArray(reviewJson.verificationStatus?.lines)
    ? reviewJson.verificationStatus.lines
    : [];
  const verificationSummary = (
    typeof reviewJson.verificationStatus?.summary === 'string' && reviewJson.verificationStatus.summary.trim()
      ? reviewJson.verificationStatus.summary.trim()
      : verificationLines.find((line) => typeof line === 'string' && line.trim()) || null
  );
  const metrics = {
    reviewTier: String(stats.reviewTier || (stats.isPartial ? 'partial' : 'full')).trim().toLowerCase(),
    totalFiles,
    deepReviewedFiles,
    deepCoverageRate,
    totalFindings,
    eligibleFindings,
    withheldFindings,
    commentReadyRate,
    hasVerificationSummary: Boolean(verificationSummary),
  };
  const reasonCodes = buildParityReasonCodes(review, metrics);
  const status = reasonCodes.includes('partial_review') || (metrics.totalFiles >= 5 && metrics.deepCoverageRate < 0.5)
    ? 'blocked'
    : reasonCodes.length > 0
      ? 'warn'
      : 'ready';
  return {
    status,
    reasonCodes: normalizeReasonCodes(reasonCodes),
    reviewTier: metrics.reviewTier || null,
    totalFiles,
    deepReviewedFiles,
    deepCoverageRate,
    totalFindings,
    eligibleFindings,
    withheldFindings,
    commentReadyRate,
    verificationSummary,
  };
}

/**
 * Transform a snake_case DB row into a camelCase object.
 */
function toCamelCase(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    displayId: row.display_id,
    githubPrNumber: row.github_pr_number,
    title: row.title,
    body: row.body ?? null,
    authorLogin: row.author_login,
    authorAvatarUrl: row.author_avatar_url ?? null,
    state: row.state,
    headBranch: row.head_branch,
    baseBranch: row.base_branch,
    headSha: row.head_sha ?? null,
    baseSha: row.base_sha ?? null,
    fileCount: row.file_count ?? 0,
    totalAdditions: row.total_additions ?? 0,
    totalDeletions: row.total_deletions ?? 0,
    commitCount: row.commit_count ?? 0,
    githubCommentCount: row.github_comment_count ?? 0,
    githubReviewCommentCount: row.github_review_comment_count ?? 0,
    githubReviewDecision: row.github_review_decision ?? null,
    githubMergeStateStatus: row.github_merge_state_status ?? null,
    githubLatestReviewState: row.github_latest_review_state ?? null,
    githubLatestReviewAuthor: row.github_latest_review_author ?? null,
    githubLatestReviewSubmittedAt: row.github_latest_review_submitted_at ?? null,
    githubReviewStateCounts: parseJsonObject(row.github_review_state_counts),
    githubReviewStatusSyncedAt: row.github_review_status_synced_at ?? null,
    githubUpdatedAt: row.github_updated_at ?? null,
    labels: parseLabels(row.labels),
    assignees: parseAssignees(row.assignees),
    requestedReviewers: parseRequestedReviewers(row.requested_reviewers),
    reviewerParticipants: parseReviewerParticipants(row.reviewer_participants),
    htmlUrl: row.html_url ?? null,
    reviewStatus: row.review_status ?? 'none',
    reviewRiskLevel: row.review_risk_level ?? null,
    reviewSummary: row.review_summary ?? null,
    reviewError: row.review_error ?? null,
    reviewJson: parseReviewJson(row.review_json),
    reviewHeadSha: row.review_head_sha ?? null,
    reviewedAt: row.reviewed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Generate auto-incrementing display ID (PR-001, PR-002, ...)
 */
async function generateDisplayId(projectId) {
  const result = await query(
    `SELECT MAX(CAST(SUBSTR(display_id, 4) AS INTEGER)) as max_num
     FROM pr_reviews WHERE project_id = $1 AND display_id LIKE 'PR-%'`,
    [projectId]
  );
  const maxNum = result.rows[0]?.max_num || 0;
  return `PR-${String(maxNum + 1).padStart(3, '0')}`;
}

/**
 * Create a new PR review record.
 */
async function create(data) {
  const id = getDbType() === 'sqlite' ? randomUUID() : null;
  const displayId = await generateDisplayId(data.projectId);
  const labels = Array.isArray(data.labels) ? JSON.stringify(data.labels) : null;
  const assignees = Array.isArray(data.assignees) ? JSON.stringify(data.assignees) : JSON.stringify([]);
  const requestedReviewers = Array.isArray(data.requestedReviewers)
    ? JSON.stringify(data.requestedReviewers)
    : JSON.stringify([]);
  const reviewerParticipants = Array.isArray(data.reviewerParticipants)
    ? JSON.stringify(data.reviewerParticipants)
    : JSON.stringify([]);
  const githubReviewStateCounts = data.githubReviewStateCounts && typeof data.githubReviewStateCounts === 'object'
    ? JSON.stringify(data.githubReviewStateCounts)
    : JSON.stringify({});

  const columns = [
    'project_id', 'display_id', 'github_pr_number', 'title', 'body',
    'author_login', 'author_avatar_url', 'state', 'head_branch', 'base_branch',
    'head_sha', 'base_sha', 'file_count', 'total_additions', 'total_deletions',
    'commit_count', 'github_comment_count', 'github_review_comment_count', 'labels',
    'assignees', 'requested_reviewers', 'reviewer_participants', 'html_url',
    'github_review_decision', 'github_merge_state_status', 'github_latest_review_state',
    'github_latest_review_author', 'github_latest_review_submitted_at',
    'github_review_state_counts', 'github_review_status_synced_at', 'github_updated_at',
  ];
  const values = [
    data.projectId, displayId, data.githubPrNumber, data.title || null, data.body || null,
    data.authorLogin || null, data.authorAvatarUrl || null, data.state || 'open',
    data.headBranch, data.baseBranch,
    data.headSha || null, data.baseSha || null,
    data.fileCount || 0, data.totalAdditions || 0, data.totalDeletions || 0,
    data.commitCount || 0, data.githubCommentCount || 0, data.githubReviewCommentCount || 0,
    labels, assignees, requestedReviewers, reviewerParticipants, data.htmlUrl || null,
    data.githubReviewDecision || null, data.githubMergeStateStatus || null,
    data.githubLatestReviewState || null, data.githubLatestReviewAuthor || null,
    data.githubLatestReviewSubmittedAt || null, githubReviewStateCounts,
    data.githubReviewStatusSyncedAt || null, data.githubUpdatedAt || null,
  ];

  if (id) {
    columns.unshift('id');
    values.unshift(id);
  }

  const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
  const result = await query(
    `INSERT INTO pr_reviews (${columns.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    values
  );
  return toCamelCase(result.rows[0]);
}

/**
 * Upsert a PR review by (project_id, github_pr_number).
 * Creates if not exists, updates metadata if exists.
 */
async function upsert(data) {
  const existing = await getByPrNumber(data.projectId, data.githubPrNumber);
  if (existing) {
    const updates = {
      title: data.title || existing.title,
      body: data.body !== undefined ? data.body : existing.body,
      author_login: data.authorLogin || existing.authorLogin,
      author_avatar_url: data.authorAvatarUrl || existing.authorAvatarUrl,
      state: data.state || existing.state,
      head_branch: data.headBranch || existing.headBranch,
      base_branch: data.baseBranch || existing.baseBranch,
      head_sha: data.headSha || existing.headSha,
      base_sha: data.baseSha || existing.baseSha,
      file_count: data.fileCount ?? existing.fileCount,
      total_additions: data.totalAdditions ?? existing.totalAdditions,
      total_deletions: data.totalDeletions ?? existing.totalDeletions,
      commit_count: data.commitCount ?? existing.commitCount,
      github_comment_count: data.githubCommentCount ?? existing.githubCommentCount ?? 0,
      github_review_comment_count: data.githubReviewCommentCount ?? existing.githubReviewCommentCount ?? 0,
      github_review_decision: data.githubReviewDecision ?? existing.githubReviewDecision ?? null,
      github_merge_state_status: data.githubMergeStateStatus ?? existing.githubMergeStateStatus ?? null,
      github_latest_review_state: data.githubLatestReviewState ?? existing.githubLatestReviewState ?? null,
      github_latest_review_author: data.githubLatestReviewAuthor ?? existing.githubLatestReviewAuthor ?? null,
      github_latest_review_submitted_at: data.githubLatestReviewSubmittedAt ?? existing.githubLatestReviewSubmittedAt ?? null,
      github_review_state_counts: data.githubReviewStateCounts && typeof data.githubReviewStateCounts === 'object'
        ? JSON.stringify(data.githubReviewStateCounts)
        : JSON.stringify(existing.githubReviewStateCounts || {}),
      github_review_status_synced_at: data.githubReviewStatusSyncedAt ?? existing.githubReviewStatusSyncedAt ?? null,
      github_updated_at: data.githubUpdatedAt ?? existing.githubUpdatedAt ?? null,
      labels: Array.isArray(data.labels) ? JSON.stringify(data.labels) : (existing.labels ? JSON.stringify(existing.labels) : null),
      assignees: Array.isArray(data.assignees) ? JSON.stringify(data.assignees) : JSON.stringify(existing.assignees || []),
      requested_reviewers: Array.isArray(data.requestedReviewers)
        ? JSON.stringify(data.requestedReviewers)
        : JSON.stringify(existing.requestedReviewers || []),
      reviewer_participants: Array.isArray(data.reviewerParticipants)
        ? JSON.stringify(data.reviewerParticipants)
        : JSON.stringify(existing.reviewerParticipants || []),
      html_url: data.htmlUrl || existing.htmlUrl,
    };
    return updateReview(existing.id, updates);
  }
  return create(data);
}

/**
 * Update a PR review with allowlist validation.
 */
async function updateReview(id, updates) {
  const allowedFields = new Set([
    'title', 'body', 'author_login', 'author_avatar_url',
    'state', 'head_branch', 'base_branch', 'head_sha', 'base_sha',
    'file_count', 'total_additions', 'total_deletions', 'commit_count',
    'github_comment_count', 'github_review_comment_count',
    'github_review_decision', 'github_merge_state_status', 'github_latest_review_state',
    'github_latest_review_author', 'github_latest_review_submitted_at',
    'github_review_state_counts', 'github_review_status_synced_at', 'github_updated_at',
    'labels', 'assignees', 'requested_reviewers', 'reviewer_participants', 'html_url',
    'review_status', 'review_risk_level', 'review_summary', 'review_json',
    'review_error', 'review_head_sha', 'reviewed_at',
  ]);

  const entries = Object.entries(updates).filter(([key]) => allowedFields.has(key));
  if (entries.length === 0) return null;

  const setClause = entries.map(([key], i) => `${key} = $${i + 2}`).join(', ');
  const values = [id, ...entries.map(([, val]) => val)];

  const result = await query(
    `UPDATE pr_reviews SET ${setClause}, updated_at = ${getDbType() === 'sqlite' ? "datetime('now')" : 'NOW()'}
     WHERE id = $1 RETURNING *`,
    values
  );

  return result.rows[0] ? toCamelCase(result.rows[0]) : null;
}

/**
 * Get all PR reviews for a project.
 */
async function getByProject(projectId) {
  const result = await query(
    'SELECT * FROM pr_reviews WHERE project_id = $1 ORDER BY COALESCE(github_updated_at, updated_at) DESC, updated_at DESC',
    [projectId]
  );
  return result.rows.map(toCamelCase);
}

/**
 * Find the active PR base branch for a local head branch.
 */
async function findBaseBranchForHead(projectId, headBranch) {
  const project = typeof projectId === 'string' && projectId.trim() ? projectId.trim() : '';
  const branch = typeof headBranch === 'string' && headBranch.trim() ? headBranch.trim() : '';
  if (!project || !branch) return null;

  try {
    const reviews = await getByProject(project);
    const matching = (Array.isArray(reviews) ? reviews : []).find((review) => (
      String(review?.headBranch || '').trim() === branch
      && typeof review?.baseBranch === 'string'
      && review.baseBranch.trim()
      && String(review?.state || '').toLowerCase() !== 'closed'
    ));
    return matching?.baseBranch?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Get a PR review by ID.
 */
async function getById(id) {
  const result = await query(
    'SELECT * FROM pr_reviews WHERE id = $1',
    [id]
  );
  return result.rows[0] ? toCamelCase(result.rows[0]) : null;
}

/**
 * Get a PR review by project + PR number.
 */
async function getByPrNumber(projectId, prNumber) {
  const result = await query(
    'SELECT * FROM pr_reviews WHERE project_id = $1 AND github_pr_number = $2',
    [projectId, prNumber]
  );
  return result.rows[0] ? toCamelCase(result.rows[0]) : null;
}

/**
 * Mark interrupted in-flight PR reviews as failed (same as branch reviews on restart).
 */
async function markInterruptedReviewsAsFailed() {
  const pendingResult = await query(
    `SELECT COUNT(*) AS cnt FROM pr_reviews
     WHERE review_status IN ('queued', 'reviewing', 'running', 'retrying')`
  );
  const pendingCount = Number(pendingResult.rows?.[0]?.cnt || 0);
  if (pendingCount === 0) return 0;

  const nowExpr = getDbType() === 'sqlite' ? "datetime('now')" : 'NOW()';
  await query(
    `UPDATE pr_reviews
     SET review_status = 'failed',
         review_error = COALESCE(review_error, 'Review interrupted after app restart. Please run Review Now again.'),
         review_summary = CASE
           WHEN review_summary IS NULL OR trim(review_summary) = ''
             THEN 'Review interrupted after app restart. Please run Review Now again.'
           ELSE review_summary
         END,
         reviewed_at = COALESCE(reviewed_at, ${nowExpr}),
         updated_at = ${nowExpr}
     WHERE review_status IN ('queued', 'reviewing', 'running', 'retrying')`
  );
  return pendingCount;
}

const prReviewService = {
  create,
  upsert,
  updateReview,
  getByProject,
  findBaseBranchForHead,
  getById,
  getByPrNumber,
  generateDisplayId,
  buildReviewParityGate,
  markInterruptedReviewsAsFailed,
};

export default prReviewService;
