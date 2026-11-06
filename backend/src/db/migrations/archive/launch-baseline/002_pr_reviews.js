/**
 * Migration 002: PR Reviews table
 *
 * Stores GitHub pull request metadata and AI review results.
 * Follows the same pattern as branch_reviews for review fields.
 */

export const version = 2;
export const name = 'pr_reviews';

const postgresSQL = `
CREATE TABLE IF NOT EXISTS pr_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  display_id TEXT NOT NULL,
  github_pr_number INTEGER NOT NULL,
  title TEXT,
  body TEXT,
  author_login TEXT,
  author_avatar_url TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  head_branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  head_sha TEXT,
  base_sha TEXT,
  file_count INTEGER DEFAULT 0,
  total_additions INTEGER DEFAULT 0,
  total_deletions INTEGER DEFAULT 0,
  commit_count INTEGER DEFAULT 0,
  labels TEXT,
  html_url TEXT,
  review_status TEXT DEFAULT 'none',
  review_risk_level TEXT,
  review_summary TEXT,
  review_error TEXT,
  review_json TEXT,
  review_head_sha TEXT,
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(project_id, github_pr_number)
);

CREATE INDEX IF NOT EXISTS idx_pr_reviews_project ON pr_reviews(project_id);
CREATE INDEX IF NOT EXISTS idx_pr_reviews_state ON pr_reviews(project_id, state);
`;

const sqliteSQL = `
CREATE TABLE IF NOT EXISTS pr_reviews (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  display_id TEXT NOT NULL,
  github_pr_number INTEGER NOT NULL,
  title TEXT,
  body TEXT,
  author_login TEXT,
  author_avatar_url TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  head_branch TEXT NOT NULL,
  base_branch TEXT NOT NULL,
  head_sha TEXT,
  base_sha TEXT,
  file_count INTEGER DEFAULT 0,
  total_additions INTEGER DEFAULT 0,
  total_deletions INTEGER DEFAULT 0,
  commit_count INTEGER DEFAULT 0,
  labels TEXT,
  html_url TEXT,
  review_status TEXT DEFAULT 'none',
  review_risk_level TEXT,
  review_summary TEXT,
  review_error TEXT,
  review_json TEXT,
  review_head_sha TEXT,
  reviewed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(project_id, github_pr_number)
);

CREATE INDEX IF NOT EXISTS idx_pr_reviews_project ON pr_reviews(project_id);
CREATE INDEX IF NOT EXISTS idx_pr_reviews_state ON pr_reviews(project_id, state);
`;

export const up = {
  postgres: postgresSQL,
  sqlite: sqliteSQL,
};
