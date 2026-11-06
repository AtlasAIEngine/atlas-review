/**
 * Migration 009: PR review reviewer participants
 *
 * Persists GitHub review author logins so PR ownership filters can keep
 * showing PRs where the current user is an active reviewer even after the
 * explicit review request is cleared.
 */

export const version = 9;
export const name = 'pr_review_reviewer_participants';

const postgresSQL = `
ALTER TABLE pr_reviews
  ADD COLUMN IF NOT EXISTS reviewer_participants JSONB DEFAULT '[]'::jsonb;
`;

const sqliteSQL = `
ALTER TABLE pr_reviews
  ADD COLUMN reviewer_participants TEXT DEFAULT '[]';
`;

export const up = {
  postgres: postgresSQL,
  sqlite: sqliteSQL,
};
