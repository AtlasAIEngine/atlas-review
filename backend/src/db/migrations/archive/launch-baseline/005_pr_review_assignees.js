/**
 * Migration 005: PR review assignees
 *
 * Persists GitHub PR assignee logins so the review UI can filter large PR
 * queues by ownership without having to re-fetch GitHub metadata on every load.
 */

export const version = 5;
export const name = 'pr_review_assignees';

const postgresSQL = `
ALTER TABLE pr_reviews
  ADD COLUMN IF NOT EXISTS assignees JSONB DEFAULT '[]'::jsonb;
`;

const sqliteSQL = `
ALTER TABLE pr_reviews
  ADD COLUMN assignees TEXT DEFAULT '[]';
`;

export const up = {
  postgres: postgresSQL,
  sqlite: sqliteSQL,
};
