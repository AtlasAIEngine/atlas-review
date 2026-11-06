/**
 * Migration 012: snapshot the fork point at review completion
 *
 * Adds a `review_fork_point_sha` column to `branch_reviews`, mirroring the
 * existing `review_merge_base_sha` / `review_head_sha` snapshot fields.
 *
 * The review pipeline persists the branch's fork point at the time of each
 * completed review so delta-eligibility on the next rerun can key on a
 * first-class anchor instead of overloading `review_merge_base_sha` (which
 * v0.58.0 repurposed as a dual signal).
 */

export const version = 12;
export const name = 'review_fork_point';

export const up = {
  postgres: `
ALTER TABLE branch_reviews ADD COLUMN IF NOT EXISTS review_fork_point_sha TEXT;
`,
  sqlite: `
ALTER TABLE branch_reviews ADD COLUMN review_fork_point_sha TEXT;
`,
};

export default {
  version,
  name,
  up,
};
