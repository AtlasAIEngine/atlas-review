/**
 * Migration 006: review publications
 *
 * Persists outbound review-publication metadata so Atlas can avoid duplicate
 * GitHub PR review comments for the same recommendation on the same review.
 */

export const version = 6;
export const name = 'review_publications';

const postgresSQL = `
CREATE TABLE IF NOT EXISTS review_publications (
  project_id TEXT NOT NULL,
  review_type TEXT NOT NULL,
  review_id TEXT NOT NULL,
  recommendation_key TEXT NOT NULL,
  channel TEXT NOT NULL,
  action TEXT NOT NULL,
  github_review_id TEXT,
  github_pr_number INTEGER,
  head_sha TEXT,
  file_path TEXT,
  line INTEGER,
  published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, review_type, review_id, recommendation_key, channel)
);

CREATE INDEX IF NOT EXISTS idx_review_publications_scope
  ON review_publications(project_id, review_type, review_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_publications_scope_head
  ON review_publications(project_id, review_type, review_id, head_sha, channel);
`;

const sqliteSQL = `
CREATE TABLE IF NOT EXISTS review_publications (
  project_id TEXT NOT NULL,
  review_type TEXT NOT NULL,
  review_id TEXT NOT NULL,
  recommendation_key TEXT NOT NULL,
  channel TEXT NOT NULL,
  action TEXT NOT NULL,
  github_review_id TEXT,
  github_pr_number INTEGER,
  head_sha TEXT,
  file_path TEXT,
  line INTEGER,
  published_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, review_type, review_id, recommendation_key, channel)
);

CREATE INDEX IF NOT EXISTS idx_review_publications_scope
  ON review_publications(project_id, review_type, review_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_publications_scope_head
  ON review_publications(project_id, review_type, review_id, head_sha, channel);
`;

export const up = {
  postgres: postgresSQL,
  sqlite: sqliteSQL,
};
