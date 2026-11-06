import db, { transaction, getDbType } from '../../db/connection.js';
import {
  REVIEW_FIX_RECOMMENDATION_STATUSES,
  REVIEW_FIX_RUN_STATUSES,
  REVIEW_FIX_TRANSCRIPT_VISIBILITY,
} from './reviewFixEvents.js';

// Persists summary-level review-fix run artifacts while transcript visibility stays hidden.

const VALID_REVIEW_TYPES = new Set(['changeset', 'branch_review', 'workspace_review', 'pr_review']);
const VALID_RUN_STATUSES = new Set(Object.values(REVIEW_FIX_RUN_STATUSES));
const VALID_RECOMMENDATION_STATUSES = new Set(Object.values(REVIEW_FIX_RECOMMENDATION_STATUSES));
const DEFAULT_LIST_LIMIT = 10;
const MAX_LIST_LIMIT = 20;

let schemaReady = false;
let schemaReadyPromise = null;

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeScope(rawScope = {}) {
  const projectId = normalizeText(rawScope.projectId);
  const reviewType = normalizeText(rawScope.reviewType).toLowerCase();
  const reviewId = normalizeText(rawScope.reviewId);

  if (!projectId) throw new Error('projectId is required for review fix runs');
  if (!reviewId) throw new Error('reviewId is required for review fix runs');
  if (!VALID_REVIEW_TYPES.has(reviewType)) {
    throw new Error('reviewType must be one of: changeset, branch_review, workspace_review, pr_review');
  }

  return { projectId, reviewType, reviewId };
}

function normalizeRunId(value) {
  const runId = normalizeText(value);
  if (!runId) throw new Error('runId is required for review fix runs');
  return runId;
}

function normalizeTimestamp(value, fallback = null) {
  const raw = normalizeText(value);
  if (!raw) return fallback;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function normalizeRunStatus(value, fallback = REVIEW_FIX_RUN_STATUSES.running) {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return fallback;
  if (!VALID_RUN_STATUSES.has(normalized)) {
    throw new Error(`Invalid review fix run status: ${value}`);
  }
  return normalized;
}

function normalizeRecommendationKeyList(rawKeys = []) {
  if (!Array.isArray(rawKeys)) return [];
  return Array.from(new Set(
    rawKeys
      .map((value) => normalizeText(value).toLowerCase())
      .filter(Boolean)
  ));
}

function normalizeCoverageFilePathList(rawFilePaths = []) {
  if (!Array.isArray(rawFilePaths)) return [];
  return Array.from(new Set(
    rawFilePaths
      .map((value) => String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase())
      .filter(Boolean)
  )).sort();
}

function normalizeRecommendationStatusEntry(recommendationKey, rawEntry = {}, fallbackTimestamp) {
  const key = normalizeText(recommendationKey).toLowerCase();
  if (!key) return null;
  const entry = rawEntry && typeof rawEntry === 'object' ? rawEntry : {};
  const status = normalizeText(entry.status).toLowerCase();
  if (!VALID_RECOMMENDATION_STATUSES.has(status)) return null;
  return {
    recommendationKey: key,
    status,
    updatedAt: normalizeTimestamp(entry.updatedAt, fallbackTimestamp) || fallbackTimestamp,
    filePaths: normalizeCoverageFilePathList(entry.filePaths),
    error: normalizeText(entry.error) || null,
  };
}

function normalizeRecommendationStatusMap(rawMap = {}, fallbackTimestamp = new Date().toISOString()) {
  if (!rawMap || typeof rawMap !== 'object' || Array.isArray(rawMap)) return {};
  const normalized = {};
  for (const [recommendationKey, rawEntry] of Object.entries(rawMap)) {
    const entry = normalizeRecommendationStatusEntry(recommendationKey, rawEntry, fallbackTimestamp);
    if (!entry) continue;
    normalized[entry.recommendationKey] = entry;
  }
  return normalized;
}

function buildInitialRecommendationStatusMap(recommendationKeys, startedAt) {
  return recommendationKeys.reduce((acc, recommendationKey) => {
    acc[recommendationKey] = {
      recommendationKey,
      status: REVIEW_FIX_RECOMMENDATION_STATUSES.running,
      updatedAt: startedAt,
    };
    return acc;
  }, {});
}

function normalizeBuildSummary(rawSummary = null) {
  if (!rawSummary || typeof rawSummary !== 'object' || Array.isArray(rawSummary)) return null;
  const filePaths = Array.isArray(rawSummary.filePaths)
    ? rawSummary.filePaths.map((value) => normalizeText(value)).filter(Boolean)
    : [];
  const newFiles = Array.isArray(rawSummary.newFiles)
    ? rawSummary.newFiles.map((value) => normalizeText(value)).filter(Boolean)
    : [];
  const modifiedFiles = Array.isArray(rawSummary.modifiedFiles)
    ? rawSummary.modifiedFiles.map((value) => normalizeText(value)).filter(Boolean)
    : [];
  const filesChanged = Number(rawSummary.filesChanged);

  return {
    filesChanged: Number.isFinite(filesChanged) ? Math.max(0, Math.trunc(filesChanged)) : filePaths.length,
    filePaths: Array.from(new Set(filePaths)).sort(),
    newFiles: Array.from(new Set(newFiles)).sort(),
    modifiedFiles: Array.from(new Set(modifiedFiles)).sort(),
    changesetId: normalizeText(rawSummary.changesetId) || null,
    changesetTitle: normalizeText(rawSummary.changesetTitle) || null,
  };
}

function parseJsonValue(rawValue, fallback) {
  if (typeof rawValue !== 'string' || !rawValue.trim()) return fallback;
  try {
    return JSON.parse(rawValue);
  } catch {
    return fallback;
  }
}

function serializeJson(value) {
  return JSON.stringify(value ?? null);
}

function getNowExpression() {
  return getDbType() === 'sqlite' ? "datetime('now')" : 'NOW()';
}

async function ensureSchema() {
  if (schemaReady) return;
  if (schemaReadyPromise) {
    await schemaReadyPromise;
    return;
  }

  schemaReadyPromise = (async () => {
    if (getDbType() === 'sqlite') {
      await db.query(`
        CREATE TABLE IF NOT EXISTS review_fix_runs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          review_type TEXT NOT NULL,
          review_id TEXT NOT NULL,
          status TEXT NOT NULL,
          transcript_visibility TEXT NOT NULL DEFAULT 'hidden',
          provider_type TEXT,
          provider_model TEXT,
          selected_recommendation_keys TEXT NOT NULL,
          recommendation_statuses TEXT NOT NULL,
          build_summary TEXT,
          error TEXT,
          started_at TEXT NOT NULL,
          completed_at TEXT,
          stopped_at TEXT,
          failed_at TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_review_fix_runs_scope_updated
          ON review_fix_runs(project_id, review_type, review_id, updated_at DESC)
      `);
    } else {
      await db.query(`
        CREATE TABLE IF NOT EXISTS review_fix_runs (
          id UUID PRIMARY KEY,
          project_id UUID NOT NULL,
          review_type TEXT NOT NULL,
          review_id TEXT NOT NULL,
          status TEXT NOT NULL,
          transcript_visibility TEXT NOT NULL DEFAULT 'hidden',
          provider_type TEXT,
          provider_model TEXT,
          selected_recommendation_keys JSONB NOT NULL,
          recommendation_statuses JSONB NOT NULL,
          build_summary JSONB,
          error TEXT,
          started_at TIMESTAMPTZ NOT NULL,
          completed_at TIMESTAMPTZ,
          stopped_at TIMESTAMPTZ,
          failed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_review_fix_runs_scope_updated
          ON review_fix_runs(project_id, review_type, review_id, updated_at DESC)
      `);
    }
    schemaReady = true;
  })();

  try {
    await schemaReadyPromise;
  } finally {
    schemaReadyPromise = null;
  }
}

function toRunRecord(row) {
  if (!row) return null;
  const startedAt = normalizeTimestamp(row.started_at, row.started_at);
  const recommendationStatuses = normalizeRecommendationStatusMap(
    parseJsonValue(row.recommendation_statuses, {}),
    startedAt || new Date().toISOString()
  );
  return {
    id: normalizeRunId(row.id),
    projectId: normalizeText(row.project_id),
    reviewType: normalizeText(row.review_type).toLowerCase(),
    reviewId: normalizeText(row.review_id),
    status: normalizeRunStatus(row.status),
    transcriptVisibility: normalizeText(row.transcript_visibility) || REVIEW_FIX_TRANSCRIPT_VISIBILITY,
    providerType: normalizeText(row.provider_type) || null,
    providerModel: normalizeText(row.provider_model) || null,
    selectedRecommendationKeys: normalizeRecommendationKeyList(
      parseJsonValue(row.selected_recommendation_keys, [])
    ),
    recommendationStatuses,
    buildSummary: normalizeBuildSummary(parseJsonValue(row.build_summary, null)),
    error: normalizeText(row.error) || null,
    startedAt,
    completedAt: normalizeTimestamp(row.completed_at, row.completed_at),
    stoppedAt: normalizeTimestamp(row.stopped_at, row.stopped_at),
    failedAt: normalizeTimestamp(row.failed_at, row.failed_at),
    createdAt: normalizeTimestamp(row.created_at, row.created_at),
    updatedAt: normalizeTimestamp(row.updated_at, row.updated_at),
  };
}

async function createRun(rawInput = {}) {
  await ensureSchema();

  const scope = normalizeScope(rawInput);
  const runId = normalizeRunId(rawInput.runId);
  const startedAt = normalizeTimestamp(rawInput.startedAt, new Date().toISOString());
  const selectedRecommendationKeys = normalizeRecommendationKeyList(rawInput.selectedRecommendationKeys);
  const recommendationStatuses = buildInitialRecommendationStatusMap(selectedRecommendationKeys, startedAt);
  const status = normalizeRunStatus(rawInput.status || REVIEW_FIX_RUN_STATUSES.running);
  const transcriptVisibility = REVIEW_FIX_TRANSCRIPT_VISIBILITY;
  const providerType = normalizeText(rawInput.providerType) || null;
  const providerModel = normalizeText(rawInput.providerModel) || null;

  const result = await db.query(
    `INSERT INTO review_fix_runs (
      id, project_id, review_type, review_id, status, transcript_visibility,
      provider_type, provider_model, selected_recommendation_keys, recommendation_statuses, started_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
    RETURNING id, project_id, review_type, review_id, status, transcript_visibility,
      provider_type, provider_model, selected_recommendation_keys, recommendation_statuses, build_summary,
      error, started_at, completed_at, stopped_at, failed_at, created_at, updated_at`,
    [
      runId,
      scope.projectId,
      scope.reviewType,
      scope.reviewId,
      status,
      transcriptVisibility,
      providerType,
      providerModel,
      serializeJson(selectedRecommendationKeys),
      serializeJson(recommendationStatuses),
      startedAt,
    ]
  );

  return toRunRecord(result.rows?.[0] || null);
}

async function getRunById(runId, executor = db) {
  const result = await executor.query(
    `SELECT id, project_id, review_type, review_id, status, transcript_visibility,
      provider_type, provider_model, selected_recommendation_keys, recommendation_statuses,
      build_summary, error, started_at, completed_at, stopped_at, failed_at, created_at, updated_at
     FROM review_fix_runs
     WHERE id = $1`,
    [normalizeRunId(runId)]
  );
  return toRunRecord(result.rows?.[0] || null);
}

async function updateRun(runId, patch = {}) {
  await ensureSchema();

  return transaction(async (tx) => {
    const existing = await getRunById(runId, tx);
    if (!existing) {
      throw new Error('Review fix run not found');
    }

    const nextUpdatedAt = new Date().toISOString();
    const mergedRecommendationStatuses = {
      ...existing.recommendationStatuses,
      ...normalizeRecommendationStatusMap(patch.recommendationStatuses, nextUpdatedAt),
    };
    const nextRecord = {
      ...existing,
      status: patch.status ? normalizeRunStatus(patch.status, existing.status) : existing.status,
      buildSummary: Object.prototype.hasOwnProperty.call(patch, 'buildSummary')
        ? normalizeBuildSummary(patch.buildSummary)
        : existing.buildSummary,
      error: Object.prototype.hasOwnProperty.call(patch, 'error')
        ? (normalizeText(patch.error) || null)
        : existing.error,
      recommendationStatuses: mergedRecommendationStatuses,
      completedAt: Object.prototype.hasOwnProperty.call(patch, 'completedAt')
        ? normalizeTimestamp(patch.completedAt, null)
        : existing.completedAt,
      stoppedAt: Object.prototype.hasOwnProperty.call(patch, 'stoppedAt')
        ? normalizeTimestamp(patch.stoppedAt, null)
        : existing.stoppedAt,
      failedAt: Object.prototype.hasOwnProperty.call(patch, 'failedAt')
        ? normalizeTimestamp(patch.failedAt, null)
        : existing.failedAt,
      updatedAt: nextUpdatedAt,
    };

    const nowExpr = getNowExpression();
    const result = await tx.query(
      `UPDATE review_fix_runs
       SET status = $2,
           recommendation_statuses = $3,
           build_summary = $4,
           error = $5,
           completed_at = $6,
           stopped_at = $7,
           failed_at = $8,
           updated_at = ${nowExpr}
       WHERE id = $1
       RETURNING id, project_id, review_type, review_id, status, transcript_visibility,
         provider_type, provider_model, selected_recommendation_keys, recommendation_statuses,
         build_summary, error, started_at, completed_at, stopped_at, failed_at, created_at, updated_at`,
      [
        existing.id,
        nextRecord.status,
        serializeJson(nextRecord.recommendationStatuses),
        serializeJson(nextRecord.buildSummary),
        nextRecord.error,
        nextRecord.completedAt,
        nextRecord.stoppedAt,
        nextRecord.failedAt,
      ]
    );

    return toRunRecord(result.rows?.[0] || null);
  });
}

function normalizeListLimit(rawLimit) {
  const parsed = Number(rawLimit);
  if (!Number.isFinite(parsed)) return DEFAULT_LIST_LIMIT;
  return Math.max(1, Math.min(MAX_LIST_LIMIT, Math.trunc(parsed)));
}

async function listRuns(rawScope, options = {}) {
  await ensureSchema();
  const scope = normalizeScope(rawScope);
  const limit = normalizeListLimit(options.limit);

  const result = await db.query(
    `SELECT id, project_id, review_type, review_id, status, transcript_visibility,
      provider_type, provider_model, selected_recommendation_keys, recommendation_statuses,
      build_summary, error, started_at, completed_at, stopped_at, failed_at, created_at, updated_at
     FROM review_fix_runs
     WHERE project_id = $1 AND review_type = $2 AND review_id = $3
     ORDER BY updated_at DESC
     LIMIT $4`,
    [scope.projectId, scope.reviewType, scope.reviewId, limit]
  );

  const runs = (result.rows || []).map((row) => toRunRecord(row)).filter(Boolean);
  return {
    scope,
    runs,
  };
}

async function getLatestRun(rawScope) {
  const listed = await listRuns(rawScope, { limit: 1 });
  return listed.runs[0] || null;
}

async function listRunningRuns() {
  await ensureSchema();

  const result = await db.query(
    `SELECT id, project_id, review_type, review_id, status, transcript_visibility,
      provider_type, provider_model, selected_recommendation_keys, recommendation_statuses,
      build_summary, error, started_at, completed_at, stopped_at, failed_at, created_at, updated_at
     FROM review_fix_runs
     WHERE status = $1
     ORDER BY updated_at ASC`,
    [REVIEW_FIX_RUN_STATUSES.running]
  );

  return (result.rows || []).map((row) => toRunRecord(row)).filter(Boolean);
}

async function markRunningRunsStopped({
  error = 'Backend restarted before this fix run finished.',
  stoppedAt = new Date().toISOString(),
} = {}) {
  const runningRuns = await listRunningRuns();
  let updatedCount = 0;

  for (const run of runningRuns) {
    const stoppedRecommendationStatuses = {};
    for (const recommendationKey of run.selectedRecommendationKeys || []) {
      const existingStatus = run.recommendationStatuses?.[recommendationKey] || {};
      stoppedRecommendationStatuses[recommendationKey] = {
        recommendationKey,
        status: REVIEW_FIX_RECOMMENDATION_STATUSES.stopped,
        updatedAt: stoppedAt,
        filePaths: Array.isArray(existingStatus.filePaths) ? existingStatus.filePaths : [],
        error: normalizeText(error) || null,
      };
    }

    await updateRun(run.id, {
      status: REVIEW_FIX_RUN_STATUSES.stopped,
      recommendationStatuses: stoppedRecommendationStatuses,
      error,
      completedAt: null,
      stoppedAt,
      failedAt: null,
    });
    updatedCount += 1;
  }

  return updatedCount;
}

async function deleteRuns(rawScope) {
  await ensureSchema();
  const scope = normalizeScope(rawScope);

  const result = await db.query(
    `DELETE FROM review_fix_runs
     WHERE project_id = $1 AND review_type = $2 AND review_id = $3`,
    [scope.projectId, scope.reviewType, scope.reviewId]
  );

  const deletedCount = Number(result?.rowCount);
  return {
    scope,
    deletedCount: Number.isFinite(deletedCount) ? deletedCount : 0,
  };
}

const reviewFixRunStore = {
  createRun,
  getRunById,
  updateRun,
  listRuns,
  listRunningRuns,
  markRunningRunsStopped,
  getLatestRun,
  deleteRuns,
  __testing: {
    ensureSchema,
    normalizeScope,
    normalizeRunStatus,
    normalizeRecommendationStatusMap,
    normalizeBuildSummary,
    toRunRecord,
  },
};

export default reviewFixRunStore;
