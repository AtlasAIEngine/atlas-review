/**
 * Migration 014: Persist review identity snapshot for branch reviews
 *
 * Adds explicit reviewed identity fields so UI can show:
 * - review_base_branch
 * - review_merge_base_sha
 * - review_head_sha
 * - reviewed_at
 *
 * This enables reliable out-of-date detection when branch HEAD moves
 * after a completed review.
 */

export const version = 14;
export const name = 'branch_review_identity';

export const up = {
  postgres: `
    ALTER TABLE branch_reviews ADD COLUMN IF NOT EXISTS review_base_branch TEXT;
    ALTER TABLE branch_reviews ADD COLUMN IF NOT EXISTS review_merge_base_sha TEXT;
    ALTER TABLE branch_reviews ADD COLUMN IF NOT EXISTS review_head_sha TEXT;
    ALTER TABLE branch_reviews ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

    UPDATE branch_reviews
    SET
      review_base_branch = COALESCE(review_base_branch, base_branch),
      review_merge_base_sha = COALESCE(review_merge_base_sha, merge_base_sha),
      review_head_sha = COALESCE(review_head_sha, head_sha),
      reviewed_at = COALESCE(reviewed_at, updated_at)
    WHERE review_status = 'reviewed';
  `,
  sqlite: `
    -- SQLite: duplicate-column errors are handled by migration runner fallback.
    ALTER TABLE branch_reviews ADD COLUMN review_base_branch TEXT;
    ALTER TABLE branch_reviews ADD COLUMN review_merge_base_sha TEXT;
    ALTER TABLE branch_reviews ADD COLUMN review_head_sha TEXT;
    ALTER TABLE branch_reviews ADD COLUMN reviewed_at TEXT;

    UPDATE branch_reviews
    SET
      review_base_branch = COALESCE(review_base_branch, base_branch),
      review_merge_base_sha = COALESCE(review_merge_base_sha, merge_base_sha),
      review_head_sha = COALESCE(review_head_sha, head_sha),
      reviewed_at = COALESCE(reviewed_at, updated_at)
    WHERE review_status = 'reviewed';
  `,
};

export default {
  version,
  name,
  up,
};
