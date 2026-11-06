/**
 * Migration 016: Recommendation outcome persistence
 *
 * Persists per-recommendation review outcomes (`addressed` | `dismissed`)
 * scoped by project + review identity + recommendation identity.
 */

export const version = 16;
export const name = 'review_outcomes';

export const up = {
  postgres: `
    CREATE TABLE IF NOT EXISTS review_outcomes (
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      review_type TEXT NOT NULL
        CHECK (review_type IN ('changeset', 'branch_review')),
      review_id TEXT NOT NULL,
      recommendation_key TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN ('addressed', 'dismissed')),
      note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (project_id, review_type, review_id, recommendation_key)
    );

    CREATE INDEX IF NOT EXISTS idx_review_outcomes_project_scope
      ON review_outcomes(project_id, review_type, review_id);

    CREATE INDEX IF NOT EXISTS idx_review_outcomes_scope_updated
      ON review_outcomes(project_id, review_type, review_id, updated_at DESC);
  `,
  sqlite: `
    CREATE TABLE IF NOT EXISTS review_outcomes (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      review_type TEXT NOT NULL,
      review_id TEXT NOT NULL,
      recommendation_key TEXT NOT NULL,
      status TEXT NOT NULL,
      note TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (project_id, review_type, review_id, recommendation_key)
    );

    CREATE INDEX IF NOT EXISTS idx_review_outcomes_project_scope
      ON review_outcomes(project_id, review_type, review_id);

    CREATE INDEX IF NOT EXISTS idx_review_outcomes_scope_updated
      ON review_outcomes(project_id, review_type, review_id, updated_at DESC);
  `,
};

export default {
  version,
  name,
  up,
};
