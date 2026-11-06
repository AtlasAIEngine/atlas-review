/**
 * Migration 013: Add review_error column to branch_reviews
 *
 * Persists explicit failure reason for branch reviews so the UI can
 * surface actionable errors instead of generic timeout messaging.
 */

export const version = 13;
export const name = 'branch_review_error';

export const up = {
  postgres: `
    ALTER TABLE branch_reviews ADD COLUMN IF NOT EXISTS review_error TEXT;
  `,
  sqlite: `
    -- SQLite: ALTER TABLE ADD COLUMN throws if column exists, handled by migration runner
    ALTER TABLE branch_reviews ADD COLUMN review_error TEXT;
  `,
};

export default {
  version,
  name,
  up,
};
