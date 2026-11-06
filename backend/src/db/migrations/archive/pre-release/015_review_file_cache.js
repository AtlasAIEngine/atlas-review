/**
 * Migration 015: Per-file AI review cache
 *
 * Caches per-file review payloads for incremental re-review runs.
 * Cache key is deterministic and includes:
 * - context type
 * - file path + before/after hashes
 * - provider + model
 * - prompt version
 */

export const version = 15;
export const name = 'review_file_cache';

export const up = {
  postgres: `
    CREATE TABLE IF NOT EXISTS review_file_cache (
      project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
      context_type TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      file_path TEXT NOT NULL,
      before_hash TEXT NOT NULL,
      after_hash TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      provider_model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      quality_mode TEXT NOT NULL DEFAULT 'v2',
      review_json TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      last_used_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (project_id, cache_key)
    );

    CREATE INDEX IF NOT EXISTS idx_review_file_cache_project_context
      ON review_file_cache(project_id, context_type);

    CREATE INDEX IF NOT EXISTS idx_review_file_cache_project_path
      ON review_file_cache(project_id, file_path);
  `,
  sqlite: `
    CREATE TABLE IF NOT EXISTS review_file_cache (
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      context_type TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      file_path TEXT NOT NULL,
      before_hash TEXT NOT NULL,
      after_hash TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      provider_model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      quality_mode TEXT NOT NULL DEFAULT 'v2',
      review_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      last_used_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (project_id, cache_key)
    );

    CREATE INDEX IF NOT EXISTS idx_review_file_cache_project_context
      ON review_file_cache(project_id, context_type);

    CREATE INDEX IF NOT EXISTS idx_review_file_cache_project_path
      ON review_file_cache(project_id, file_path);
  `,
};

export default {
  version,
  name,
  up,
};
