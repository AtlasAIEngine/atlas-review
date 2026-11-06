/**
 * Migration 019: walkthrough_file_cache table
 *
 * Per-file walkthrough summary cache. The walkthrough generator hashes each
 * file's diff text together with the prompt version and resolved model id,
 * and stores the LLM-produced description for that file. On subsequent
 * walkthrough runs (force-pushes, re-reviews, overlapping diffs), files
 * with unchanged diff content reuse the cached summary instead of paying
 * for another LLM call.
 *
 * Schema:
 * - `content_hash` (text pk) — sha256 of (PROMPT_VERSION + model + diff text)
 * - `prompt_version` (text) — pinned to walkthrough prompt schema version
 * - `model_id` (text) — model that produced the cached summary
 * - `summary` (Postgres JSONB / SQLite TEXT — JSON object with description, risk)
 * - `created_at`, `last_hit_at` (timestamps for telemetry / future eviction)
 * - `hit_count` (integer)
 *
 * No project/user scope: identical (prompt, model, diff) → identical summary,
 * so the cache is content-addressable and shareable across projects. This
 * matters for multi-repo monorepos and for re-reviews that touch the same
 * upstream files.
 */

export const version = 19;
export const name = 'walkthrough_file_cache';

export const up = {
  postgres: `
CREATE TABLE IF NOT EXISTS walkthrough_file_cache (
  content_hash TEXT PRIMARY KEY,
  prompt_version TEXT NOT NULL,
  model_id TEXT,
  summary JSONB NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_hit_at TIMESTAMPTZ DEFAULT NOW(),
  hit_count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_walkthrough_file_cache_last_hit
  ON walkthrough_file_cache(last_hit_at);
`,
  sqlite: `
CREATE TABLE IF NOT EXISTS walkthrough_file_cache (
  content_hash TEXT PRIMARY KEY,
  prompt_version TEXT NOT NULL,
  model_id TEXT,
  summary TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  last_hit_at TEXT DEFAULT (datetime('now')),
  hit_count INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_walkthrough_file_cache_last_hit
  ON walkthrough_file_cache(last_hit_at);
`,
};

export default {
  version,
  name,
  up,
};
