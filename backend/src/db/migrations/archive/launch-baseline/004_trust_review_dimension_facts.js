/**
 * Migration 004: Trust Analytics dimension facts
 *
 * Persists issue-level, dimension-safe aggregates for provider, language, and
 * path breakdowns without inferring segmented metrics from review-level
 * averages.
 */

export const version = 4;
export const name = 'trust_review_dimension_facts';

const postgresSQL = `
CREATE TABLE IF NOT EXISTS trust_review_dimension_facts (
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  review_type TEXT NOT NULL,
  review_id TEXT NOT NULL,
  recommendation_key TEXT NOT NULL,
  completed_at TIMESTAMPTZ,
  provider_type TEXT,
  provider_model TEXT,
  language TEXT,
  path_pattern TEXT,
  issue_count INTEGER DEFAULT 0,
  high_risk_count INTEGER DEFAULT 0,
  outcome_addressed_count INTEGER DEFAULT 0,
  outcome_dismissed_count INTEGER DEFAULT 0,
  outcome_recorded_count INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (project_id, review_type, review_id, recommendation_key)
);

CREATE INDEX IF NOT EXISTS idx_trust_review_dimension_facts_project_completed
  ON trust_review_dimension_facts(project_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trust_review_dimension_facts_provider
  ON trust_review_dimension_facts(project_id, provider_model, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trust_review_dimension_facts_language
  ON trust_review_dimension_facts(project_id, language, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trust_review_dimension_facts_path
  ON trust_review_dimension_facts(project_id, path_pattern, completed_at DESC);
`;

const sqliteSQL = `
CREATE TABLE IF NOT EXISTS trust_review_dimension_facts (
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  review_type TEXT NOT NULL,
  review_id TEXT NOT NULL,
  recommendation_key TEXT NOT NULL,
  completed_at TEXT,
  provider_type TEXT,
  provider_model TEXT,
  language TEXT,
  path_pattern TEXT,
  issue_count INTEGER DEFAULT 0,
  high_risk_count INTEGER DEFAULT 0,
  outcome_addressed_count INTEGER DEFAULT 0,
  outcome_dismissed_count INTEGER DEFAULT 0,
  outcome_recorded_count INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, review_type, review_id, recommendation_key)
);

CREATE INDEX IF NOT EXISTS idx_trust_review_dimension_facts_project_completed
  ON trust_review_dimension_facts(project_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trust_review_dimension_facts_provider
  ON trust_review_dimension_facts(project_id, provider_model, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trust_review_dimension_facts_language
  ON trust_review_dimension_facts(project_id, language, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trust_review_dimension_facts_path
  ON trust_review_dimension_facts(project_id, path_pattern, completed_at DESC);
`;

export const up = {
  postgres: postgresSQL,
  sqlite: sqliteSQL,
};
