/**
 * Migration 008: Add persisted review_fix run artifacts
 *
 * Stores summary-level issue-fixer run metadata by review scope while keeping
 * transcript visibility explicitly hidden for the current product surface.
 */

export const version = 8;
export const name = 'review_fix_runs';

export const up = {
  postgres: `
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
);

CREATE INDEX IF NOT EXISTS idx_review_fix_runs_scope_updated
  ON review_fix_runs(project_id, review_type, review_id, updated_at DESC);
`,
  sqlite: `
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
);

CREATE INDEX IF NOT EXISTS idx_review_fix_runs_scope_updated
  ON review_fix_runs(project_id, review_type, review_id, updated_at DESC);
`,
};

export default {
  version,
  name,
  up,
};
