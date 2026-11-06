/**
 * Migration 009: Review Usage Tracking
 *
 * Creates the review_usage table for tracking per-review token consumption
 * and costs. Supports monthly summaries and free tier enforcement (20 reviews/month).
 */

export const version = 9;
export const name = 'review_usage_tracking';

export const up = {
  postgres: `
    CREATE TABLE IF NOT EXISTS review_usage (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      changeset_id TEXT,
      provider_type TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost NUMERIC(10, 6) NOT NULL DEFAULT 0,
      reviewed_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_review_usage_project ON review_usage(project_id);
    CREATE INDEX IF NOT EXISTS idx_review_usage_reviewed_at ON review_usage(reviewed_at DESC);
  `,
  sqlite: `
    CREATE TABLE IF NOT EXISTS review_usage (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      changeset_id TEXT,
      provider_type TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0,
      reviewed_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_review_usage_project ON review_usage(project_id);
    CREATE INDEX IF NOT EXISTS idx_review_usage_reviewed_at ON review_usage(reviewed_at DESC);
  `
};
