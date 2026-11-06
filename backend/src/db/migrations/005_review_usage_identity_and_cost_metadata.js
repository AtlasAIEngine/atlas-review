/**
 * Migration 005: add exact review identity and cost provenance to review_usage
 *
 * This migration is intentionally idempotent so it is safe on fresh installs
 * (where the squashed baseline already includes the columns) and existing
 * desktop databases upgraded in place.
 */

export const version = 5;
export const name = 'review_usage_identity_and_cost_metadata';

export const up = {
  postgres: `
    ALTER TABLE review_usage
      ADD COLUMN IF NOT EXISTS review_type TEXT,
      ADD COLUMN IF NOT EXISTS review_id TEXT,
      ADD COLUMN IF NOT EXISTS provider_native_cost NUMERIC(10, 6),
      ADD COLUMN IF NOT EXISTS cost_source TEXT,
      ADD COLUMN IF NOT EXISTS cost_is_approximate BOOLEAN NOT NULL DEFAULT FALSE;

    CREATE INDEX IF NOT EXISTS idx_review_usage_review_identity
      ON review_usage(project_id, review_type, review_id, reviewed_at DESC);
  `,
  sqlite: `
    ALTER TABLE review_usage ADD COLUMN review_type TEXT;
    ALTER TABLE review_usage ADD COLUMN review_id TEXT;
    ALTER TABLE review_usage ADD COLUMN provider_native_cost REAL;
    ALTER TABLE review_usage ADD COLUMN cost_source TEXT;
    ALTER TABLE review_usage ADD COLUMN cost_is_approximate INTEGER NOT NULL DEFAULT 0;

    CREATE INDEX IF NOT EXISTS idx_review_usage_review_identity
      ON review_usage(project_id, review_type, review_id, reviewed_at DESC);
  `,
};

export default {
  version,
  name,
  up,
};
