/**
 * Migration 007: PR review requested reviewers
 *
 * Persists GitHub PR requested reviewer logins so the review UI can filter
 * PR queues by review ownership as well as direct assignee ownership.
 */

export const version = 7;
export const name = 'pr_review_requested_reviewers';

const postgresSQL = `
ALTER TABLE pr_reviews
  ADD COLUMN IF NOT EXISTS requested_reviewers JSONB DEFAULT '[]'::jsonb;
`;

const sqliteSQL = `
ALTER TABLE pr_reviews
  ADD COLUMN requested_reviewers TEXT DEFAULT '[]';
`;

export const up = {
  postgres: postgresSQL,
  sqlite: sqliteSQL,
};
