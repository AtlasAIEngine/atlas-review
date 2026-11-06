/**
 * Walkthrough Service
 *
 * Phase 11 — decouples walkthrough generation from review.
 *
 * Walkthroughs are independently generated artifacts cached per
 * (projectId, baseSha, headSha). Findings are NOT stored here — they live
 * on the corresponding review row and are mapped to walkthrough steps at
 * read time on the frontend.
 *
 * Dual-DB notes (CLAUDE.md "Code Patterns"):
 * - Postgres `change_groups` is JSONB — the driver returns parsed objects.
 * - SQLite `change_groups` is TEXT — the driver returns raw JSON strings.
 * - Read paths must guard with `typeof x === 'string' ? JSON.parse(x) : x`.
 * - Write paths must serialize on SQLite to keep the column readable.
 */

import { query, getDbType } from '../db/connection.js';
import { randomUUID } from 'crypto';

function deserializeChangeGroups(value) {
  if (value == null) return [];
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      console.warn('[walkthroughService] Invalid change_groups JSON:', error.message);
      return [];
    }
  }
  return Array.isArray(value) ? value : [];
}

function deserializeRunMetadata(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch (error) {
      console.warn('[walkthroughService] Invalid run_metadata JSON:', error.message);
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function serializeChangeGroupsForDb(changeGroups) {
  // Postgres JSONB: pg accepts plain JS objects/arrays.
  // SQLite TEXT: must hand a string.
  if (getDbType() === 'sqlite') {
    return JSON.stringify(changeGroups);
  }
  return JSON.stringify(changeGroups);
}

function serializeRunMetadataForDb(runMetadata) {
  if (!runMetadata || typeof runMetadata !== 'object' || Array.isArray(runMetadata)) {
    return null;
  }
  return JSON.stringify(runMetadata);
}

function rowToWalkthrough(row) {
  if (!row) return null;
  return {
    id: row.id,
    projectId: row.project_id,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    changeGroups: deserializeChangeGroups(row.change_groups),
    modelId: row.model_id ?? null,
    providerType: row.provider_type ?? null,
    runMetadata: deserializeRunMetadata(row.run_metadata),
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function normalizeKey(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Look up a walkthrough by (projectId, baseSha, headSha).
 *
 * @param {{ projectId: string, baseSha: string, headSha: string }} params
 * @returns {Promise<{
 *   id: string,
 *   projectId: string,
 *   baseSha: string,
 *   headSha: string,
 *   changeGroups: Array,
 *   modelId: string | null,
 *   providerType: string | null,
 *   runMetadata: object | null,
 *   createdAt: string | null,
 *   updatedAt: string | null,
 * } | null>}
 */
async function getWalkthrough({ projectId, baseSha, headSha } = {}) {
  const pid = normalizeKey(projectId);
  const base = normalizeKey(baseSha);
  const head = normalizeKey(headSha);
  if (!pid || !base || !head) return null;

  const result = await query(
    `SELECT id, project_id, base_sha, head_sha, change_groups, model_id, provider_type, run_metadata,
            created_at, updated_at
     FROM walkthroughs
     WHERE project_id = $1 AND base_sha = $2 AND head_sha = $3
     LIMIT 1`,
    [pid, base, head]
  );
  return result.rows[0] ? rowToWalkthrough(result.rows[0]) : null;
}

async function getLatestWalkthroughForBase({ projectId, baseSha, excludeHeadSha = null } = {}) {
  const pid = normalizeKey(projectId);
  const base = normalizeKey(baseSha);
  const excludedHead = normalizeKey(excludeHeadSha);
  if (!pid || !base) return null;

  const result = await query(
    `SELECT id, project_id, base_sha, head_sha, change_groups, model_id, provider_type, run_metadata,
            created_at, updated_at
     FROM walkthroughs
     WHERE project_id = $1
       AND base_sha = $2
       AND ($3 = '' OR head_sha <> $3)
     ORDER BY updated_at DESC, created_at DESC
     LIMIT 1`,
    [pid, base, excludedHead]
  );
  return result.rows[0] ? rowToWalkthrough(result.rows[0]) : null;
}

/**
 * Upsert a walkthrough on the (projectId, baseSha, headSha) unique index.
 *
 * @param {{
 *   projectId: string,
 *   baseSha: string,
 *   headSha: string,
 *   changeGroups: Array,
 *   modelId?: string | null,
 *   providerType?: string | null,
 *   runMetadata?: object | null,
 * }} params
 * @returns {Promise<object>} The persisted walkthrough row, mapped to camelCase.
 */
async function saveWalkthrough({ projectId, baseSha, headSha, changeGroups, modelId = null, providerType = null, runMetadata = null } = {}) {
  const pid = normalizeKey(projectId);
  const base = normalizeKey(baseSha);
  const head = normalizeKey(headSha);
  if (!pid || !base || !head) {
    throw new Error('walkthroughService.saveWalkthrough: projectId, baseSha, and headSha are required');
  }
  if (!Array.isArray(changeGroups)) {
    throw new Error('walkthroughService.saveWalkthrough: changeGroups must be an array');
  }

  const dbType = getDbType();
  const serialized = serializeChangeGroupsForDb(changeGroups);
  const serializedRunMetadata = serializeRunMetadataForDb(runMetadata);
  // SQLite needs an explicit id (no DB-side default).
  const id = dbType === 'sqlite' ? randomUUID() : null;

  // Build a single INSERT ... ON CONFLICT ... DO UPDATE statement that works
  // on both Postgres and SQLite (both support the conflict clause via the
  // unique index). Postgres lets us omit `id` (uuid default); SQLite needs
  // the supplied id.
  const sql = id
    ? `
      INSERT INTO walkthroughs (id, project_id, base_sha, head_sha, change_groups, model_id, provider_type, run_metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (project_id, base_sha, head_sha) DO UPDATE SET
        change_groups = EXCLUDED.change_groups,
        model_id = EXCLUDED.model_id,
        provider_type = EXCLUDED.provider_type,
        run_metadata = EXCLUDED.run_metadata,
        updated_at = ${dbType === 'sqlite' ? "datetime('now')" : 'NOW()'}
      RETURNING *`
    : `
      INSERT INTO walkthroughs (project_id, base_sha, head_sha, change_groups, model_id, provider_type, run_metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (project_id, base_sha, head_sha) DO UPDATE SET
        change_groups = EXCLUDED.change_groups,
        model_id = EXCLUDED.model_id,
        provider_type = EXCLUDED.provider_type,
        run_metadata = EXCLUDED.run_metadata,
        updated_at = NOW()
      RETURNING *`;

  const params = id
    ? [id, pid, base, head, serialized, modelId, providerType, serializedRunMetadata]
    : [pid, base, head, serialized, modelId, providerType, serializedRunMetadata];

  const result = await query(sql, params);
  return rowToWalkthrough(result.rows[0]);
}

/**
 * Read a walkthrough's `changeGroups` for rendering, with a legacy fallback to
 * `reviewJson.changeGroups`. New rows go through `getWalkthrough`; older
 * reviews (pre-Phase-11) embed change groups in the review payload itself.
 *
 * The fallback path does NOT write the legacy data back into the new table.
 * Decoupling is the point of this phase: re-running review must not regenerate
 * a walkthrough, and reading a legacy review must not silently migrate it.
 *
 * @param {{
 *   projectId: string,
 *   baseSha: string,
 *   headSha: string,
 *   reviewJson?: { changeGroups?: Array } | null,
 * }} params
 * @returns {Promise<Array | null>} The change groups array, or null if neither
 *   source has them.
 */
async function getWalkthroughForReview({ projectId, baseSha, headSha, reviewJson = null } = {}) {
  const fresh = await getWalkthrough({ projectId, baseSha, headSha });
  if (fresh && Array.isArray(fresh.changeGroups) && fresh.changeGroups.length > 0) {
    return fresh.changeGroups;
  }

  // Legacy fallback: read embedded change groups from the review row payload.
  // Do NOT persist these into the new walkthroughs table — keeping legacy
  // reads read-only is what makes the decoupling honest.
  const legacy = reviewJson?.changeGroups;
  if (Array.isArray(legacy) && legacy.length > 0) {
    return legacy;
  }
  return null;
}

export default {
  getWalkthrough,
  getLatestWalkthroughForBase,
  saveWalkthrough,
  getWalkthroughForReview,
};

export {
  getWalkthrough,
  getLatestWalkthroughForBase,
  saveWalkthrough,
  getWalkthroughForReview,
};
