/**
 * Migration 012: Add review_json column to branch_reviews
 *
 * For databases that already ran migration 011, the branch_reviews table
 * exists but lacks the review_json column (added for Phase 3 AI integration).
 * SQLite ALTER TABLE ADD COLUMN is NOT idempotent — must wrap in try-catch.
 */

export const version = 12;
export const name = 'branch_review_json';

export const up = {
  postgres: `
    ALTER TABLE branch_reviews ADD COLUMN IF NOT EXISTS review_json TEXT;
  `,
  sqlite: `
    -- SQLite: ALTER TABLE ADD COLUMN throws if column exists, handled by migration runner try-catch
    ALTER TABLE branch_reviews ADD COLUMN review_json TEXT;
  `
};

export default {
  version,
  name,
  up
};
