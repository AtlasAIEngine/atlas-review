/**
 * Walkthrough File Cache Service
 *
 * Per-file walkthrough summary cache. The walkthrough generator hashes each
 * file's diff text together with the prompt version and resolved model id,
 * and stores the LLM-produced description for that file. On subsequent
 * walkthrough runs (force-pushes, re-reviews, overlapping diffs), files
 * with unchanged diff content reuse the cached summary instead of paying
 * for another LLM call.
 *
 * Dual-DB (CLAUDE.md):
 * - Postgres `summary` is JSONB → driver returns parsed objects.
 * - SQLite `summary` is TEXT → driver returns raw JSON strings.
 * - Read paths must guard with `typeof x === 'string' ? JSON.parse(x) : x`.
 */

import { createHash } from 'crypto';
import { query, getDbType } from '../db/connection.js';

// Bump when the cluster/single-pass walkthrough prompts change in a way that
// alters per-file output shape. Values cached under the prior version are
// invalidated automatically because the hash includes this string.
export const WALKTHROUGH_PROMPT_VERSION = 'v1';

const VALID_RISK = new Set(['low', 'medium', 'high', 'critical']);

function deserializeSummary(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function serializeSummaryForDb(summary) {
  return JSON.stringify(summary);
}

/**
 * Compute the canonical cache key for a file's diff text. The key intentionally
 * excludes the model id: a per-file description is essentially the same shape
 * across cheap and frontier tiers, and including the model would force us to
 * regenerate on every model swap. The model id is still recorded in the row
 * for provenance, and the prompt version is in the key so a schema change
 * silently invalidates the entire cache.
 *
 * @param {{ diffText: string, promptVersion?: string }} params
 * @returns {string} sha256 hex digest
 */
export function computeFileCacheKey({ diffText, promptVersion = WALKTHROUGH_PROMPT_VERSION }) {
  const hash = createHash('sha256');
  hash.update(String(promptVersion || WALKTHROUGH_PROMPT_VERSION));
  hash.update('\n');
  hash.update(String(diffText || ''));
  return hash.digest('hex');
}

function normalizeSummary(input) {
  if (!input || typeof input !== 'object') return null;
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (!description) return null;
  const riskRaw = typeof input.risk === 'string' ? input.risk.trim().toLowerCase() : '';
  const risk = VALID_RISK.has(riskRaw) ? riskRaw : 'low';
  return { description, risk };
}

function buildPlaceholderList(count, startIndex = 1) {
  return Array.from({ length: count }, (_, i) => `$${i + startIndex}`).join(', ');
}

/**
 * Bulk-fetch cached summaries by content hash. Returns a Map keyed by hash.
 * Hashes with no entry are simply absent from the returned Map.
 *
 * @param {string[]} contentHashes
 * @returns {Promise<Map<string, { description: string, risk: string }>>}
 */
export async function getMany(contentHashes) {
  const out = new Map();
  if (!Array.isArray(contentHashes) || contentHashes.length === 0) return out;
  const unique = Array.from(new Set(contentHashes.filter((h) => typeof h === 'string' && h)));
  if (unique.length === 0) return out;

  const placeholders = buildPlaceholderList(unique.length);
  const sql = `SELECT content_hash, summary FROM walkthrough_file_cache WHERE content_hash IN (${placeholders})`;
  const result = await query(sql, unique);

  for (const row of result.rows) {
    const summary = deserializeSummary(row.summary);
    const normalized = normalizeSummary(summary);
    if (normalized) out.set(row.content_hash, normalized);
  }

  // Best-effort hit-count bump. Ignore failures so a slow update never blocks
  // the read path; this column is for telemetry, not correctness.
  if (out.size > 0) {
    void bumpHitCounts(Array.from(out.keys())).catch(() => {});
  }
  return out;
}

async function bumpHitCounts(hashes) {
  if (!Array.isArray(hashes) || hashes.length === 0) return;
  const placeholders = buildPlaceholderList(hashes.length);
  const dbType = getDbType();
  const nowExpr = dbType === 'sqlite' ? "datetime('now')" : 'NOW()';
  const sql = `UPDATE walkthrough_file_cache
               SET hit_count = COALESCE(hit_count, 0) + 1,
                   last_hit_at = ${nowExpr}
               WHERE content_hash IN (${placeholders})`;
  await query(sql, hashes);
}

/**
 * Bulk insert/update cached summaries. Conflicts on content_hash refresh
 * the summary + model id (covers prompt/model migrations).
 *
 * @param {Array<{ contentHash: string, modelId: string|null, summary: object, promptVersion?: string }>} entries
 */
export async function putMany(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return;
  const validRows = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const contentHash = typeof entry.contentHash === 'string' ? entry.contentHash : '';
    if (!contentHash) continue;
    const summary = normalizeSummary(entry.summary);
    if (!summary) continue;
    validRows.push({
      contentHash,
      promptVersion: typeof entry.promptVersion === 'string' && entry.promptVersion
        ? entry.promptVersion
        : WALKTHROUGH_PROMPT_VERSION,
      modelId: typeof entry.modelId === 'string' && entry.modelId ? entry.modelId : null,
      summaryJson: serializeSummaryForDb(summary),
    });
  }
  if (validRows.length === 0) return;

  const params = [];
  const valuesClauses = [];
  for (const row of validRows) {
    const start = params.length + 1;
    valuesClauses.push(`($${start}, $${start + 1}, $${start + 2}, $${start + 3})`);
    params.push(row.contentHash, row.promptVersion, row.modelId, row.summaryJson);
  }

  const sql = `
    INSERT INTO walkthrough_file_cache (content_hash, prompt_version, model_id, summary)
    VALUES ${valuesClauses.join(', ')}
    ON CONFLICT (content_hash) DO UPDATE SET
      prompt_version = EXCLUDED.prompt_version,
      model_id = EXCLUDED.model_id,
      summary = EXCLUDED.summary
  `;

  await query(sql, params);
}

export default {
  computeFileCacheKey,
  getMany,
  putMany,
  WALKTHROUGH_PROMPT_VERSION,
};
