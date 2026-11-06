/**
 * Migration 011: preserve the branch's fork point separately from merge-base
 *
 * Adds a `fork_point_sha` column to `branch_reviews` so we can retain the
 * original point where a topic branch diverged from its base even after the
 * branch is merged (especially via fast-forward, where `merge-base(base, HEAD)
 * == HEAD` and the previous `merge_base_sha` would be overwritten).
 *
 * The merge-base continues to live on `merge_base_sha`; downstream code prefers
 * `fork_point_sha` when computing review diff ranges, falling back to
 * `merge_base_sha` for historical rows.
 */

export const version = 11;
export const name = 'branch_review_fork_point';

export const up = {
  postgres: `
ALTER TABLE branch_reviews ADD COLUMN IF NOT EXISTS fork_point_sha TEXT;
`,
  sqlite: `
ALTER TABLE branch_reviews ADD COLUMN fork_point_sha TEXT;
`,
};

export default {
  version,
  name,
  up,
};
