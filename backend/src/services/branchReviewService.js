/**
 * Branch Review Service
 * CRUD operations for branch_reviews table.
 *
 * Uses the async db.query() abstraction from connection.js so it works
 * with both PostgreSQL and SQLite (the SQLite driver wraps synchronous
 * better-sqlite3 calls in the same async interface).
 */

import { query, getDbType, transaction } from '../db/connection.js';
import { randomUUID } from 'crypto';
import { assignReviewFindingIds } from './review/reviewFindingIds.js';

const VALID_RISK_LEVELS = new Set(['low', 'medium', 'high', 'critical']);
const DUPLICATE_BRANCH_REVIEW_ERROR = 'Superseded duplicate branch review entry';
const TRACKED_BRANCH_REVIEW_STATUSES = new Set(['active', 'stale']);
const RISK_WEIGHT = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function normalizeRiskLevel(value, fallback = 'medium') {
  const normalized = String(value || '').trim().toLowerCase();
  if (VALID_RISK_LEVELS.has(normalized)) return normalized;
  return VALID_RISK_LEVELS.has(fallback) ? fallback : 'medium';
}

function normalizeRecommendationType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'issue' || normalized === 'suggestion' || normalized === 'praise') {
    return normalized;
  }
  if (normalized === 'bug' || normalized === 'warning' || normalized === 'error' || normalized === 'problem') {
    return 'issue';
  }
  if (normalized === 'note' || normalized === 'nit' || normalized === 'info') {
    return 'suggestion';
  }
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
  if (!rawReview || typeof rawReview !== 'object' || Array.isArray(rawReview)) {
    return rawReview;
  }

  const review = { ...rawReview };
  const sourceRecommendations = Array.isArray(rawReview.recommendations)
    ? rawReview.recommendations
    : [];

  const recommendations = [];
  for (const rawRecommendation of sourceRecommendations) {
    if (!rawRecommendation || typeof rawRecommendation !== 'object' || Array.isArray(rawRecommendation)) {
      continue;
    }
    const recommendation = { ...rawRecommendation };
    recommendation.type = normalizeRecommendationType(recommendation.type);
    recommendation.severity = normalizeRiskLevel(recommendation.severity, 'low');
    if (
      recommendation.type !== 'issue'
      && (recommendation.severity === 'high' || recommendation.severity === 'critical')
    ) {
      recommendation.severity = 'medium';
    }
    recommendation.recommendationKey = buildRecommendationIdentityKey(recommendation);
    recommendations.push(recommendation);
  }
  review.recommendations = recommendations;

  const actionable = recommendations.filter((rec) => rec && rec.type !== 'praise');
  if (actionable.length > 0) {
    let highest = 'low';
    for (const rec of actionable) {
      const severity = normalizeRiskLevel(rec.severity, 'low');
      if (RISK_WEIGHT[severity] > RISK_WEIGHT[highest]) {
        highest = severity;
      }
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
    console.warn('Invalid branch review_json payload:', error.message);
    return null;
  }
}

function parseCacheReviewJson(value) {
  if (!value) return null;
  if (typeof value !== 'string') return sanitizePersistedReviewJson(value);
  try {
    return sanitizePersistedReviewJson(JSON.parse(value));
  } catch (error) {
    console.warn('Invalid review_file_cache review_json payload:', error.message);
    return null;
  }
}

function getTrackedBranchReviewScore(review) {
  const updatedAtMs = Date.parse(review?.updatedAt || review?.createdAt || 0) || 0;
  const createdAtMs = Date.parse(review?.createdAt || 0) || 0;
  const reviewStatus = String(review?.reviewStatus || '').trim().toLowerCase();
  return [
    review?.isCurrent ? 1 : 0,
    review?.status === 'active' ? 1 : 0,
    reviewStatus && reviewStatus !== 'none' ? 1 : 0,
    updatedAtMs,
    createdAtMs,
  ];
}

function compareTrackedBranchReviewCandidates(left, right) {
  const leftScore = getTrackedBranchReviewScore(left);
  const rightScore = getTrackedBranchReviewScore(right);
  for (let index = 0; index < leftScore.length; index += 1) {
    if (leftScore[index] !== rightScore[index]) {
      return rightScore[index] - leftScore[index];
    }
  }
  return String(right?.id || '').localeCompare(String(left?.id || ''));
}

function normalizeDuplicateTrackedBranchReviews(reviews) {
  if (!Array.isArray(reviews) || reviews.length === 0) {
    return { reviews: [], duplicates: [] };
  }

  const trackedByBranch = new Map();
  for (const review of reviews) {
    if (!review?.branchName || !TRACKED_BRANCH_REVIEW_STATUSES.has(review.status)) continue;
    const list = trackedByBranch.get(review.branchName) || [];
    list.push(review);
    trackedByBranch.set(review.branchName, list);
  }

  const duplicateIds = new Set();
  for (const entries of trackedByBranch.values()) {
    if (!Array.isArray(entries) || entries.length <= 1) continue;
    const sorted = [...entries].sort(compareTrackedBranchReviewCandidates);
    for (const duplicate of sorted.slice(1)) {
      duplicateIds.add(duplicate.id);
    }
  }

  if (duplicateIds.size === 0) {
    return { reviews, duplicates: [] };
  }

  return {
    reviews: reviews.filter((review) => !duplicateIds.has(review?.id)),
    duplicates: reviews.filter((review) => duplicateIds.has(review?.id)),
  };
}

function normalizeCacheKeys(cacheKeys) {
  if (!Array.isArray(cacheKeys)) return [];
  const seen = new Set();
  const normalized = [];
  for (const raw of cacheKeys) {
    const key = typeof raw === 'string' ? raw.trim() : '';
    if (!key || seen.has(key)) continue;
    seen.add(key);
    normalized.push(key);
  }
  return normalized;
}

function normalizeCacheHashDescriptors(descriptors, maxItems = 20) {
  const normalizedMaxItems = Math.max(1, Math.trunc(Number(maxItems) || 20));
  if (!Array.isArray(descriptors)) return [];
  const seen = new Set();
  const normalized = [];
  for (const descriptor of descriptors) {
    if (!descriptor || typeof descriptor !== 'object') continue;
    const filePath = typeof descriptor.filePath === 'string' ? descriptor.filePath.trim() : '';
    const beforeHash = typeof descriptor.beforeHash === 'string' ? descriptor.beforeHash.trim() : '';
    const afterHash = typeof descriptor.afterHash === 'string' ? descriptor.afterHash.trim() : '';
    if (!filePath || !beforeHash || !afterHash) continue;
    const key = `${filePath}\u001f${beforeHash}\u001f${afterHash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ filePath, beforeHash, afterHash });
    if (normalized.length >= normalizedMaxItems) break;
  }
  return normalized;
}

/**
 * Transform a snake_case DB row into a camelCase object
 */
function toCamelCase(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    displayId: row.display_id,
    branchName: row.branch_name,
    baseBranch: row.base_branch,
    baseBranchSource: row.base_branch_source ?? 'inferred',
    mergeBaseSha: row.merge_base_sha,
    forkPointSha: row.fork_point_sha ?? null,
    headSha: row.head_sha,
    status: row.status,
    isCurrent: row.is_current === 1 || row.is_current === true,
    fileCount: row.file_count,
    totalAdditions: row.total_additions,
    totalDeletions: row.total_deletions,
    commitCount: row.commit_count,
    firstCommitAt: row.first_commit_at,
    lastCommitAt: row.last_commit_at,
    reviewStatus: row.review_status,
    reviewRiskLevel: row.review_risk_level,
    reviewSummary: row.review_summary,
    reviewError: row.review_error ?? null,
    reviewBaseBranch: row.review_base_branch ?? null,
    reviewMergeBaseSha: row.review_merge_base_sha ?? null,
    reviewForkPointSha: row.review_fork_point_sha ?? null,
    reviewHeadSha: row.review_head_sha ?? null,
    reviewedAt: row.reviewed_at ?? null,
    reviewJson: parseReviewJson(row.review_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Generate an auto-incrementing display ID (BR-001, BR-002, ...)
 */
async function generateDisplayId(projectId) {
  const result = await query(
    'SELECT COUNT(*) as cnt FROM branch_reviews WHERE project_id = $1',
    [projectId]
  );
  const count = result.rows[0]?.cnt || 0;
  const nextNum = count + 1;
  return `BR-${String(nextNum).padStart(3, '0')}`;
}

/**
 * Create a new branch review
 */
async function create({
  projectId,
  branchName,
  baseBranch,
  baseBranchSource = 'inferred',
  mergeBaseSha,
  forkPointSha = null,
  reviewForkPointSha = null,
  headSha,
  stats,
  isCurrent = true,
}) {
  const id = getDbType() === 'sqlite' ? randomUUID() : null;
  const displayId = await generateDisplayId(projectId);

  const fileCount = stats?.fileCount || 0;
  const totalAdditions = stats?.totalAdditions || 0;
  const totalDeletions = stats?.totalDeletions || 0;
  const commitCount = stats?.commitCount || 0;
  const firstCommitAt = stats?.firstCommitAt || null;
  const lastCommitAt = stats?.lastCommitAt || null;
  const currentFlag = isCurrent ? 1 : 0;
  const normalizedForkPointSha =
    typeof forkPointSha === 'string' && forkPointSha.trim() ? forkPointSha.trim() : null;
  const normalizedReviewForkPointSha =
    typeof reviewForkPointSha === 'string' && reviewForkPointSha.trim()
      ? reviewForkPointSha.trim()
      : null;
  const normalizedBaseBranchSource =
    typeof baseBranchSource === 'string' && baseBranchSource.trim()
      ? baseBranchSource.trim()
      : 'inferred';

  const result = id
    ? await query(
        `INSERT INTO branch_reviews (id, project_id, display_id, branch_name, base_branch, base_branch_source, merge_base_sha, fork_point_sha, head_sha, is_current, file_count, total_additions, total_deletions, commit_count, first_commit_at, last_commit_at, review_fork_point_sha)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
         RETURNING *`,
        [id, projectId, displayId, branchName, baseBranch, normalizedBaseBranchSource, mergeBaseSha, normalizedForkPointSha, headSha, currentFlag, fileCount, totalAdditions, totalDeletions, commitCount, firstCommitAt, lastCommitAt, normalizedReviewForkPointSha]
      )
    : await query(
        `INSERT INTO branch_reviews (project_id, display_id, branch_name, base_branch, base_branch_source, merge_base_sha, fork_point_sha, head_sha, is_current, file_count, total_additions, total_deletions, commit_count, first_commit_at, last_commit_at, review_fork_point_sha)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         RETURNING *`,
        [projectId, displayId, branchName, baseBranch, normalizedBaseBranchSource, mergeBaseSha, normalizedForkPointSha, headSha, currentFlag, fileCount, totalAdditions, totalDeletions, commitCount, firstCommitAt, lastCommitAt, normalizedReviewForkPointSha]
      );

  return toCamelCase(result.rows[0]);
}

/**
 * Update an existing branch review with new diff stats
 */
async function updateReview(id, updates, dbClient = null) {
  const allowedFields = new Set([
    'base_branch', 'merge_base_sha', 'fork_point_sha', 'head_sha', 'status', 'is_current',
    'file_count', 'total_additions', 'total_deletions',
    'commit_count', 'first_commit_at', 'last_commit_at',
    'review_status', 'review_risk_level', 'review_summary', 'review_json',
    'review_error',
    'review_base_branch', 'review_merge_base_sha', 'review_fork_point_sha', 'review_head_sha', 'reviewed_at',
    'base_branch_source',
  ]);

  const entries = Object.entries(updates).filter(([key]) => allowedFields.has(key));
  if (entries.length === 0) return null;

  const setClause = entries
    .map(([key], i) => `${key} = $${i + 2}`)
    .join(', ');

  const values = [id, ...entries.map(([, val]) => val)];

  const executor = dbClient && typeof dbClient.query === 'function'
    ? dbClient
    : { query };

  const result = await executor.query(
    `UPDATE branch_reviews SET ${setClause}, updated_at = ${getDbType() === 'sqlite' ? "datetime('now')" : 'NOW()'}
     WHERE id = $1 RETURNING *`,
    values
  );

  return result.rows[0] ? toCamelCase(result.rows[0]) : null;
}

/**
 * Get all branch reviews for a project
 */
async function getByProject(projectId) {
  const result = await query(
    `SELECT * FROM branch_reviews WHERE project_id = $1 ORDER BY updated_at DESC`,
    [projectId]
  );
  return result.rows.map(toCamelCase);
}

/**
 * Get a branch review by project + branch name (most recent)
 */
async function getByBranch(projectId, branchName, options = {}) {
  const statuses = Array.isArray(options.statuses) && options.statuses.length > 0
    ? options.statuses
      .map((status) => String(status || '').trim().toLowerCase())
      .filter(Boolean)
    : ['active'];
  const uniqueStatuses = Array.from(new Set(statuses));
  const statusPlaceholders = uniqueStatuses.map((_, index) => `$${index + 3}`).join(', ');
  const result = await query(
    `SELECT * FROM branch_reviews
     WHERE project_id = $1 AND branch_name = $2 AND status IN (${statusPlaceholders})
     ORDER BY is_current DESC,
              CASE status WHEN 'active' THEN 0 WHEN 'stale' THEN 1 ELSE 2 END ASC,
              updated_at DESC,
              created_at DESC
     LIMIT 1`,
    [projectId, branchName, ...uniqueStatuses]
  );
  return result.rows[0] ? toCamelCase(result.rows[0]) : null;
}

/**
 * Get a branch review by ID
 */
async function getById(id) {
  const result = await query(
    'SELECT * FROM branch_reviews WHERE id = $1',
    [id]
  );
  return result.rows[0] ? toCamelCase(result.rows[0]) : null;
}

/**
 * Set status of a branch review
 */
async function setStatus(id, status) {
  return updateReview(id, { status });
}

/**
 * Set the current branch review for a project (unsets all others)
 */
async function setCurrentBranch(projectId, branchReviewId) {
  await transaction(async (client) => {
    // Unset all current flags for this project
    await client.query(
      `UPDATE branch_reviews SET is_current = ${getDbType() === 'sqlite' ? '0' : 'FALSE'}
       WHERE project_id = $1 AND is_current = ${getDbType() === 'sqlite' ? '1' : 'TRUE'}`,
      [projectId]
    );

    // Set the specified one as current
    if (branchReviewId) {
      await client.query(
        `UPDATE branch_reviews SET is_current = ${getDbType() === 'sqlite' ? '1' : 'TRUE'}
         WHERE id = $1`,
        [branchReviewId]
      );
    }
  });
}

/**
 * Deactivate all active branch reviews for a project
 */
async function deactivateAll(projectId) {
  await query(
    `UPDATE branch_reviews SET status = 'stale', is_current = ${getDbType() === 'sqlite' ? '0' : 'FALSE'}
     WHERE project_id = $1 AND status = 'active'`,
    [projectId]
  );
}

/**
 * Delete a branch review by ID
 */
async function deleteBranchReview(id) {
  const result = await query(
    'DELETE FROM branch_reviews WHERE id = $1',
    [id]
  );
  return result.rowCount > 0;
}

/**
 * Get the current (active) branch review for a project
 */
async function getCurrent(projectId) {
  const result = await query(
    `SELECT * FROM branch_reviews
     WHERE project_id = $1 AND is_current = ${getDbType() === 'sqlite' ? '1' : 'TRUE'}
     LIMIT 1`,
    [projectId]
  );
  return result.rows[0] ? toCamelCase(result.rows[0]) : null;
}

async function collapseDuplicateTrackedReviews(projectId, reviews = null) {
  const sourceReviews = Array.isArray(reviews) ? reviews : await getByProject(projectId);
  const normalized = normalizeDuplicateTrackedBranchReviews(sourceReviews);

  if (normalized.duplicates.length === 0) {
    return {
      reviews: sourceReviews,
      duplicates: [],
    };
  }

  await transaction(async (client) => {
    for (const duplicate of normalized.duplicates) {
      await updateReview(duplicate.id, {
        status: 'closed',
        is_current: 0,
        review_error: duplicate.reviewError || DUPLICATE_BRANCH_REVIEW_ERROR,
      }, client);
    }
  });

  return normalized;
}

/**
 * Mark interrupted in-flight reviews as failed.
 * Queue state is in-memory, so queued/reviewing rows can become stale after restart.
 */
async function markInterruptedReviewsAsFailed() {
  const pendingResult = await query(
    `SELECT COUNT(*) AS cnt
     FROM branch_reviews
     WHERE review_status IN ('queued', 'reviewing', 'running', 'retrying')`
  );
  const pendingCount = Number(pendingResult.rows?.[0]?.cnt || 0);
  if (pendingCount === 0) return 0;

  const nowExpr = getDbType() === 'sqlite' ? "datetime('now')" : 'NOW()';
  await query(
    `UPDATE branch_reviews
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

/**
 * Fetch per-file review cache rows for a project by cache key.
 */
async function getReviewFileCacheByKeys(projectId, cacheKeys) {
  const keys = normalizeCacheKeys(cacheKeys);
  if (!projectId || keys.length === 0) return [];

  const placeholders = keys.map((_, index) => `$${index + 2}`).join(', ');
  const result = await query(
    `SELECT project_id, context_type, cache_key, file_path, before_hash, after_hash,
            provider_type, provider_model, prompt_version, quality_mode, review_json,
            created_at, updated_at, last_used_at
     FROM review_file_cache
     WHERE project_id = $1 AND cache_key IN (${placeholders})`,
    [projectId, ...keys]
  );

  return result.rows.map((row) => ({
    projectId: row.project_id,
    contextType: row.context_type,
    cacheKey: row.cache_key,
    filePath: row.file_path,
    beforeHash: row.before_hash,
    afterHash: row.after_hash,
    providerType: row.provider_type,
    providerModel: row.provider_model,
    promptVersion: row.prompt_version,
    qualityMode: row.quality_mode,
    review: parseCacheReviewJson(row.review_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  }));
}

/**
 * Fetch review cache rows by file-path + before/after hash descriptors.
 */
async function getReviewFileCacheByHashDescriptors(projectId, descriptors, {
  maxDescriptors = 20,
  maxRows = 60,
} = {}) {
  const normalizedDescriptors = normalizeCacheHashDescriptors(descriptors, maxDescriptors);
  if (!projectId || normalizedDescriptors.length === 0) return [];

  const params = [projectId];
  const valuesPlaceholders = [];
  for (const descriptor of normalizedDescriptors) {
    const baseOffset = params.length + 1;
    params.push(descriptor.filePath, descriptor.beforeHash, descriptor.afterHash);
    valuesPlaceholders.push(`($${baseOffset}, $${baseOffset + 1}, $${baseOffset + 2})`);
  }
  const normalizedMaxRows = Math.max(1, Math.trunc(Number(maxRows) || 60));
  const limitPlaceholder = `$${params.length + 1}`;
  params.push(normalizedMaxRows);

  const result = await query(
    `WITH requested(file_path, before_hash, after_hash) AS (
       VALUES ${valuesPlaceholders.join(', ')}
     )
     SELECT r.project_id, r.context_type, r.cache_key, r.file_path, r.before_hash, r.after_hash,
            r.provider_type, r.provider_model, r.prompt_version, r.quality_mode, r.review_json,
            r.created_at, r.updated_at, r.last_used_at
     FROM review_file_cache r
     INNER JOIN requested req
       ON req.file_path = r.file_path
      AND req.before_hash = r.before_hash
      AND req.after_hash = r.after_hash
     WHERE r.project_id = $1
     ORDER BY updated_at DESC
     LIMIT ${limitPlaceholder}`,
    params
  );

  return result.rows.map((row) => ({
    projectId: row.project_id,
    contextType: row.context_type,
    cacheKey: row.cache_key,
    filePath: row.file_path,
    beforeHash: row.before_hash,
    afterHash: row.after_hash,
    providerType: row.provider_type,
    providerModel: row.provider_model,
    promptVersion: row.prompt_version,
    qualityMode: row.quality_mode,
    review: parseCacheReviewJson(row.review_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  }));
}

/**
 * Fetch latest review cache rows by file path (hash-agnostic historical hints).
 */
async function getReviewFileCacheByFilePaths(projectId, filePaths, {
  maxFilePaths = 20,
  maxRows = 80,
} = {}) {
  const normalizedMaxFilePaths = Math.max(1, Math.trunc(Number(maxFilePaths) || 20));
  const normalizedMaxRows = Math.max(1, Math.trunc(Number(maxRows) || 80));
  const normalizedFilePaths = Array.from(new Set(
    (Array.isArray(filePaths) ? filePaths : [])
      .map((entry) => String(entry || '').trim())
      .filter(Boolean)
  )).slice(0, normalizedMaxFilePaths);
  if (!projectId || normalizedFilePaths.length === 0) return [];

  const placeholders = normalizedFilePaths.map((_, index) => `$${index + 2}`).join(', ');
  const limitPlaceholder = `$${normalizedFilePaths.length + 2}`;
  const params = [projectId, ...normalizedFilePaths, normalizedMaxRows];
  const result = await query(
    `SELECT project_id, context_type, cache_key, file_path, before_hash, after_hash,
            provider_type, provider_model, prompt_version, quality_mode, review_json,
            created_at, updated_at, last_used_at
     FROM review_file_cache
     WHERE project_id = $1
       AND file_path IN (${placeholders})
     ORDER BY updated_at DESC
     LIMIT ${limitPlaceholder}`,
    params
  );

  return result.rows.map((row) => ({
    projectId: row.project_id,
    contextType: row.context_type,
    cacheKey: row.cache_key,
    filePath: row.file_path,
    beforeHash: row.before_hash,
    afterHash: row.after_hash,
    providerType: row.provider_type,
    providerModel: row.provider_model,
    promptVersion: row.prompt_version,
    qualityMode: row.quality_mode,
    review: parseCacheReviewJson(row.review_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  }));
}

/**
 * Touch cache rows after reusing them.
 */
async function touchReviewFileCacheByKeys(projectId, cacheKeys) {
  const keys = normalizeCacheKeys(cacheKeys);
  if (!projectId || keys.length === 0) return 0;

  const placeholders = keys.map((_, index) => `$${index + 2}`).join(', ');
  const nowExpr = getDbType() === 'sqlite' ? "datetime('now')" : 'NOW()';
  const result = await query(
    `UPDATE review_file_cache
     SET last_used_at = ${nowExpr},
         updated_at = ${nowExpr}
     WHERE project_id = $1
       AND cache_key IN (${placeholders})`,
    [projectId, ...keys]
  );
  return Number(result.rowCount || 0);
}

/**
 * Upsert per-file review cache entries.
 */
async function upsertReviewFileCacheEntries(projectId, entries) {
  if (!projectId || !Array.isArray(entries) || entries.length === 0) return 0;

  const nowExpr = getDbType() === 'sqlite' ? "datetime('now')" : 'NOW()';
  let written = 0;

  for (const entry of entries) {
    const cacheKey = typeof entry?.cacheKey === 'string' ? entry.cacheKey.trim() : '';
    const contextType = typeof entry?.contextType === 'string' ? entry.contextType.trim() : '';
    const filePath = typeof entry?.filePath === 'string' ? entry.filePath.trim() : '';
    const beforeHash = typeof entry?.beforeHash === 'string' ? entry.beforeHash.trim() : '';
    const afterHash = typeof entry?.afterHash === 'string' ? entry.afterHash.trim() : '';
    const providerType = typeof entry?.providerType === 'string' ? entry.providerType.trim() : '';
    const providerModel = typeof entry?.providerModel === 'string' ? entry.providerModel.trim() : '';
    const promptVersion = typeof entry?.promptVersion === 'string' ? entry.promptVersion.trim() : '';
    const qualityMode = typeof entry?.qualityMode === 'string' ? entry.qualityMode.trim() : '';
    const review = entry?.review && typeof entry.review === 'object' ? entry.review : null;
    if (!cacheKey || !contextType || !filePath || !beforeHash || !afterHash || !providerType || !providerModel || !promptVersion || !qualityMode || !review) {
      continue;
    }

    await query(
      `INSERT INTO review_file_cache (
          project_id, context_type, cache_key, file_path, before_hash, after_hash,
          provider_type, provider_model, prompt_version, quality_mode, review_json
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (project_id, cache_key) DO UPDATE SET
         context_type = EXCLUDED.context_type,
         file_path = EXCLUDED.file_path,
         before_hash = EXCLUDED.before_hash,
         after_hash = EXCLUDED.after_hash,
         provider_type = EXCLUDED.provider_type,
         provider_model = EXCLUDED.provider_model,
         prompt_version = EXCLUDED.prompt_version,
         quality_mode = EXCLUDED.quality_mode,
         review_json = EXCLUDED.review_json,
         updated_at = ${nowExpr},
         last_used_at = ${nowExpr}`,
      [
        projectId,
        contextType,
        cacheKey,
        filePath,
        beforeHash,
        afterHash,
        providerType,
        providerModel,
        promptVersion,
        qualityMode,
        JSON.stringify(review),
      ]
    );
    written += 1;
  }

  return written;
}

const branchReviewService = {
  create,
  updateReview,
  getByProject,
  getByBranch,
  getById,
  collapseDuplicateTrackedReviews,
  setStatus,
  setCurrentBranch,
  deactivateAll,
  deleteBranchReview,
  delete: deleteBranchReview,
  getCurrent,
  markInterruptedReviewsAsFailed,
  getReviewFileCacheByKeys,
  getReviewFileCacheByHashDescriptors,
  getReviewFileCacheByFilePaths,
  touchReviewFileCacheByKeys,
  upsertReviewFileCacheEntries,
};

export default branchReviewService;
