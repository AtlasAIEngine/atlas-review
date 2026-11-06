/**
 * Migration 013: distinguish pinned vs inferred base branches per review
 *
 * Adds a `base_branch_source` column to `branch_reviews`:
 *  - `'inferred'` (default for existing rows) — base was chosen by
 *    `inferBaseBranch` or inherits from the project-wide base. Will be
 *    healed/rewritten by reconcile and by the project-wide cascade.
 *  - `'pinned'` — user explicitly set this review's base via the per-
 *    review `PATCH /:projectId/branch-reviews/:brId/base-branch`
 *    endpoint. Reconcile and the project-wide cascade both skip pinned
 *    reviews so the override survives.
 *
 * The default is null at the SQL layer (matching the existing nullable
 * snapshot columns); the application treats null as `'inferred'`.
 */

export const version = 13;
export const name = 'base_branch_source';

export const up = {
  postgres: `
ALTER TABLE branch_reviews ADD COLUMN IF NOT EXISTS base_branch_source TEXT;
`,
  sqlite: `
ALTER TABLE branch_reviews ADD COLUMN base_branch_source TEXT;
`,
};

export default {
  version,
  name,
  up,
};
