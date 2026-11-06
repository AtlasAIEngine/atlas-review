/**
 * Migration 016: PR review comment counts
 *
 * Stores GitHub aggregate PR comment counts from the lightweight pull-request
 * metadata sync so PR cards can show comment activity without loading full
 * conversation threads.
 */

export const version = 16;
export const name = 'pr_review_comment_counts';

const postgresSQL = `
ALTER TABLE pr_reviews
  ADD COLUMN IF NOT EXISTS github_comment_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS github_review_comment_count INTEGER NOT NULL DEFAULT 0;
`;

const sqliteSQL = `
ALTER TABLE pr_reviews
  ADD COLUMN github_comment_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE pr_reviews
  ADD COLUMN github_review_comment_count INTEGER NOT NULL DEFAULT 0;
`;

export const up = {
  postgres: postgresSQL,
  sqlite: sqliteSQL,
};
