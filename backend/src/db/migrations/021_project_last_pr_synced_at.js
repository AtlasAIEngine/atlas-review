/**
 * Migration 021: projects.last_pr_synced_at
 *
 * Persistent timestamp of when this project's PR review list was last synced
 * from GitHub. The frontend used to compute this client-side via
 * `new Date().toISOString()` after each manual sync, which meant the chip
 * always read "0m ago" right after sync and reset every page load.
 *
 * Stored at the project level (not derived from MAX(updated_at) across
 * pr_reviews) because PR row updated_at can move for reasons other than a
 * full sync — e.g. comment counts, publication summaries, lifecycle flips.
 */

export const version = 21;
export const name = 'project_last_pr_synced_at';

const postgresSQL = `
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS last_pr_synced_at TIMESTAMPTZ;
`;

// SQLite ALTER TABLE ADD COLUMN is not idempotent (no IF NOT EXISTS); guard
// with PRAGMA table_info() so re-runs do not error with "duplicate column".
const sqliteUp = async (db) => {
  const cols = await db.query("PRAGMA table_info(projects)");
  const hasCol = (cols.rows || []).some((r) => r.name === 'last_pr_synced_at');
  if (!hasCol) {
    await db.query('ALTER TABLE projects ADD COLUMN last_pr_synced_at TEXT');
  }
};

export const up = {
  postgres: postgresSQL,
  sqlite: sqliteUp,
};
