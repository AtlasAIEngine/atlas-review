/**
 * Migration 020: PR review GitHub updated timestamp
 *
 * Stores GitHub's pull-request updated_at separately from Atlas' local row
 * updated_at, which changes during metadata syncs.
 */

export const version = 20;
export const name = 'pr_review_github_updated_at';

const postgresSQL = `
ALTER TABLE pr_reviews
  ADD COLUMN IF NOT EXISTS github_updated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pr_reviews_github_updated
  ON pr_reviews(project_id, github_updated_at DESC);
`;

// SQLite ALTER TABLE ADD COLUMN is not idempotent (no IF NOT EXISTS); guard
// with PRAGMA table_info() so re-runs after a partial failure on the
// subsequent CREATE INDEX do not wedge the database.
const sqliteUp = async (db) => {
  const cols = await db.query("PRAGMA table_info(pr_reviews)");
  const hasCol = (cols.rows || []).some((r) => r.name === 'github_updated_at');
  if (!hasCol) {
    await db.query('ALTER TABLE pr_reviews ADD COLUMN github_updated_at TEXT');
  }
  await db.query(
    'CREATE INDEX IF NOT EXISTS idx_pr_reviews_github_updated ON pr_reviews(project_id, github_updated_at DESC)'
  );
};

export const up = {
  postgres: postgresSQL,
  sqlite: sqliteUp,
};
