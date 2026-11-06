import db, { getDbType } from '../db/connection.js';

const VALID_REVIEW_TYPES = new Set(['changeset', 'branch_review', 'pr_review']);
const VALID_CHANNELS = new Set(['github_pr_review']);
const VALID_ACTIONS = new Set(['comment', 'approve', 'request_changes']);
export const REVIEW_DECISION_PUBLICATION_KEY = '__review_decision__';

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeScope(rawScope = {}) {
  const projectId = normalizeText(rawScope.projectId);
  const reviewType = normalizeText(rawScope.reviewType).toLowerCase();
  const reviewId = normalizeText(rawScope.reviewId);

  if (!projectId) throw new Error('projectId is required for review publications');
  if (!reviewId) throw new Error('reviewId is required for review publications');
  if (!VALID_REVIEW_TYPES.has(reviewType)) {
    throw new Error('reviewType must be one of: changeset, branch_review, pr_review');
  }

  return { projectId, reviewType, reviewId };
}

function normalizeChannel(value) {
  const channel = normalizeText(value).toLowerCase();
  if (!VALID_CHANNELS.has(channel)) {
    throw new Error('channel must be "github_pr_review"');
  }
  return channel;
}

function normalizeAction(value) {
  const action = normalizeText(value).toLowerCase();
  if (!VALID_ACTIONS.has(action)) {
    throw new Error('action must be one of: comment, approve, request_changes');
  }
  return action;
}

function normalizeRecommendationKey(value) {
  const recommendationKey = normalizeText(value).toLowerCase();
  if (!recommendationKey) throw new Error('recommendationKey is required for review publications');
  return recommendationKey;
}

function normalizePayload(rawPayload = {}) {
  const payload = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload)
    ? rawPayload
    : {};

  const lineNumber = Number(payload.line);
  const githubPrNumber = Number(payload.githubPrNumber);

  return {
    recommendationKey: normalizeRecommendationKey(payload.recommendationKey),
    channel: normalizeChannel(payload.channel || 'github_pr_review'),
    action: normalizeAction(payload.action),
    githubReviewId: normalizeText(payload.githubReviewId) || null,
    githubPrNumber: Number.isFinite(githubPrNumber) && githubPrNumber > 0 ? Math.trunc(githubPrNumber) : null,
    headSha: normalizeText(payload.headSha) || null,
    filePath: normalizeText(payload.filePath) || null,
    line: Number.isFinite(lineNumber) && lineNumber > 0 ? Math.trunc(lineNumber) : null,
    publishedAt: normalizeText(payload.publishedAt) || null,
  };
}

function getNowExpression() {
  return getDbType() === 'sqlite' ? "datetime('now')" : 'NOW()';
}

function toPublicationRecord(row) {
  if (!row) return null;
  return {
    projectId: row.project_id,
    reviewType: row.review_type,
    reviewId: row.review_id,
    recommendationKey: row.recommendation_key,
    channel: row.channel,
    action: row.action,
    githubReviewId: row.github_review_id ?? null,
    githubPrNumber: Number.isFinite(Number(row.github_pr_number)) ? Number(row.github_pr_number) : null,
    headSha: row.head_sha ?? null,
    path: row.file_path ?? null,
    line: Number.isFinite(Number(row.line)) ? Number(row.line) : null,
    publishedAt: row.published_at ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

async function upsertPublication(rawScope, rawPayload) {
  const scope = normalizeScope(rawScope);
  const payload = normalizePayload(rawPayload);
  const nowExpr = getNowExpression();

  const result = await db.query(
    `INSERT INTO review_publications (
      project_id, review_type, review_id, recommendation_key, channel, action,
      github_review_id, github_pr_number, head_sha, file_path, line, published_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12, ${nowExpr}))
    ON CONFLICT (project_id, review_type, review_id, recommendation_key, channel) DO UPDATE SET
      action = EXCLUDED.action,
      github_review_id = EXCLUDED.github_review_id,
      github_pr_number = EXCLUDED.github_pr_number,
      head_sha = EXCLUDED.head_sha,
      file_path = EXCLUDED.file_path,
      line = EXCLUDED.line,
      published_at = EXCLUDED.published_at,
      updated_at = ${nowExpr}
    RETURNING project_id, review_type, review_id, recommendation_key, channel, action,
      github_review_id, github_pr_number, head_sha, file_path, line, published_at, created_at, updated_at`,
    [
      scope.projectId,
      scope.reviewType,
      scope.reviewId,
      payload.recommendationKey,
      payload.channel,
      payload.action,
      payload.githubReviewId,
      payload.githubPrNumber,
      payload.headSha,
      payload.filePath,
      payload.line,
      payload.publishedAt,
    ]
  );

  return toPublicationRecord(result.rows?.[0] || null);
}

async function listPublications(rawScope, options = {}) {
  const scope = normalizeScope(rawScope);
  const channel = options.channel ? normalizeChannel(options.channel) : null;
  const params = [scope.projectId, scope.reviewType, scope.reviewId];
  let whereSql = 'project_id = $1 AND review_type = $2 AND review_id = $3';

  if (channel) {
    params.push(channel);
    whereSql += ` AND channel = $${params.length}`;
  }

  const result = await db.query(
    `SELECT project_id, review_type, review_id, recommendation_key, channel, action,
      github_review_id, github_pr_number, head_sha, file_path, line, published_at, created_at, updated_at
     FROM review_publications
     WHERE ${whereSql}
     ORDER BY updated_at DESC, published_at DESC,
       CASE WHEN recommendation_key = '${REVIEW_DECISION_PUBLICATION_KEY}' THEN 0 ELSE 1 END`,
    params
  );

  const allPublications = (result.rows || []).map(toPublicationRecord).filter(Boolean);
  const latest = allPublications[0] || null;
  const publications = allPublications.filter((entry) => (
    entry.recommendationKey !== REVIEW_DECISION_PUBLICATION_KEY
  ));
  const byRecommendationKey = publications.reduce((acc, entry) => {
    if (!entry) return acc;
    const existing = acc[entry.recommendationKey];
    if (!existing) {
      acc[entry.recommendationKey] = entry;
      return acc;
    }
    const existingTs = Date.parse(String(existing.updatedAt || existing.publishedAt || ''));
    const candidateTs = Date.parse(String(entry.updatedAt || entry.publishedAt || ''));
    if (!Number.isFinite(existingTs) || (Number.isFinite(candidateTs) && candidateTs >= existingTs)) {
      acc[entry.recommendationKey] = entry;
    }
    return acc;
  }, {});

  return {
    scope,
    publications,
    byRecommendationKey,
    totalPublished: publications.length,
    latestAction: latest?.action || null,
    latestPublishedAt: latest?.publishedAt || null,
  };
}

const reviewPublicationService = {
  upsertPublication,
  listPublications,
  __testing: {
    normalizeScope,
    normalizePayload,
    toPublicationRecord,
  },
};

export default reviewPublicationService;
