/**
 * Migration 017: PR review GitHub review status
 *
 * Persists GitHub's current review decision and latest submitted review state
 * so Atlas can show approval / changes-requested status without requiring a
 * fresh conversation sync on every page load.
 */

export const version = 17;
export const name = 'pr_review_github_review_status';

const postgresSQL = `
ALTER TABLE pr_reviews
  ADD COLUMN IF NOT EXISTS github_review_decision TEXT,
  ADD COLUMN IF NOT EXISTS github_merge_state_status TEXT,
  ADD COLUMN IF NOT EXISTS github_latest_review_state TEXT,
  ADD COLUMN IF NOT EXISTS github_latest_review_author TEXT,
  ADD COLUMN IF NOT EXISTS github_latest_review_submitted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS github_review_state_counts JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS github_review_status_synced_at TIMESTAMPTZ;
`;

const sqliteSQL = `
ALTER TABLE pr_reviews
  ADD COLUMN github_review_decision TEXT;

ALTER TABLE pr_reviews
  ADD COLUMN github_merge_state_status TEXT;

ALTER TABLE pr_reviews
  ADD COLUMN github_latest_review_state TEXT;

ALTER TABLE pr_reviews
  ADD COLUMN github_latest_review_author TEXT;

ALTER TABLE pr_reviews
  ADD COLUMN github_latest_review_submitted_at TEXT;

ALTER TABLE pr_reviews
  ADD COLUMN github_review_state_counts TEXT DEFAULT '{}';

ALTER TABLE pr_reviews
  ADD COLUMN github_review_status_synced_at TEXT;
`;

export const up = {
  postgres: postgresSQL,
  sqlite: sqliteSQL,
};
