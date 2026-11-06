/**
 * Migration 017: Review outcome dimensional buckets
 *
 * Adds optional outcome-dimension fields so suppression can be scoped by
 * provider/model/language/path-pattern buckets instead of only project+key.
 */

export const version = 17;
export const name = 'review_outcome_dimensions';

export const up = {
  postgres: `
    ALTER TABLE review_outcomes
      ADD COLUMN IF NOT EXISTS provider_type TEXT,
      ADD COLUMN IF NOT EXISTS provider_model TEXT,
      ADD COLUMN IF NOT EXISTS language TEXT,
      ADD COLUMN IF NOT EXISTS path_pattern TEXT;

    CREATE INDEX IF NOT EXISTS idx_review_outcomes_project_key_dimensions
      ON review_outcomes(
        project_id,
        recommendation_key,
        provider_type,
        provider_model,
        language,
        path_pattern,
        updated_at DESC
      );
  `,
  sqlite: `
    ALTER TABLE review_outcomes ADD COLUMN provider_type TEXT;
    ALTER TABLE review_outcomes ADD COLUMN provider_model TEXT;
    ALTER TABLE review_outcomes ADD COLUMN language TEXT;
    ALTER TABLE review_outcomes ADD COLUMN path_pattern TEXT;

    CREATE INDEX IF NOT EXISTS idx_review_outcomes_project_key_dimensions
      ON review_outcomes(
        project_id,
        recommendation_key,
        provider_type,
        provider_model,
        language,
        path_pattern,
        updated_at DESC
      );
  `,
};

export default {
  version,
  name,
  up,
};
