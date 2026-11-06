/**
 * Migration 003: Trust Analytics review facts
 *
 * Persists one normalized Trust Analytics snapshot per completed review so
 * project summary and timeseries endpoints do not need to rehydrate full
 * review payloads for historical queries.
 */

export const version = 3;
export const name = 'trust_review_facts';

const postgresSQL = `
CREATE TABLE IF NOT EXISTS trust_review_facts (
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  review_type TEXT NOT NULL,
  review_id TEXT NOT NULL,
  display_id TEXT,
  branch_name TEXT,
  review_status TEXT NOT NULL,
  review_reliability TEXT NOT NULL,
  gate_status TEXT,
  gate_reason_codes TEXT,
  provider_type TEXT,
  provider_model TEXT,
  created_at_source TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  ttfs_ms INTEGER,
  review_duration_ms INTEGER,
  total_changed_files INTEGER DEFAULT 0,
  deep_coverage_numerator INTEGER DEFAULT 0,
  deep_coverage_denominator INTEGER DEFAULT 0,
  issues_found INTEGER DEFAULT 0,
  high_risk_findings INTEGER DEFAULT 0,
  grounded_issue_numerator INTEGER DEFAULT 0,
  grounded_issue_denominator INTEGER DEFAULT 0,
  unsupported_issue_numerator INTEGER DEFAULT 0,
  unsupported_issue_denominator INTEGER DEFAULT 0,
  low_evidence_issue_numerator INTEGER DEFAULT 0,
  low_evidence_issue_denominator INTEGER DEFAULT 0,
  uncorroborated_high_risk_numerator INTEGER DEFAULT 0,
  uncorroborated_high_risk_denominator INTEGER DEFAULT 0,
  outcome_suppression_numerator INTEGER DEFAULT 0,
  outcome_suppression_denominator INTEGER DEFAULT 0,
  issue_addressed_numerator INTEGER DEFAULT 0,
  issue_addressed_denominator INTEGER DEFAULT 0,
  issue_dismissed_numerator INTEGER DEFAULT 0,
  issue_dismissed_denominator INTEGER DEFAULT 0,
  issue_outcome_coverage_numerator INTEGER DEFAULT 0,
  issue_outcome_coverage_denominator INTEGER DEFAULT 0,
  omitted_files INTEGER DEFAULT 0,
  failed_files INTEGER DEFAULT 0,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (project_id, review_type, review_id)
);

CREATE INDEX IF NOT EXISTS idx_trust_review_facts_project_completed
  ON trust_review_facts(project_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trust_review_facts_project_type_completed
  ON trust_review_facts(project_id, review_type, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trust_review_facts_project_provider
  ON trust_review_facts(project_id, provider_model, completed_at DESC);
`;

const sqliteSQL = `
CREATE TABLE IF NOT EXISTS trust_review_facts (
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  review_type TEXT NOT NULL,
  review_id TEXT NOT NULL,
  display_id TEXT,
  branch_name TEXT,
  review_status TEXT NOT NULL,
  review_reliability TEXT NOT NULL,
  gate_status TEXT,
  gate_reason_codes TEXT,
  provider_type TEXT,
  provider_model TEXT,
  created_at_source TEXT,
  completed_at TEXT,
  ttfs_ms INTEGER,
  review_duration_ms INTEGER,
  total_changed_files INTEGER DEFAULT 0,
  deep_coverage_numerator INTEGER DEFAULT 0,
  deep_coverage_denominator INTEGER DEFAULT 0,
  issues_found INTEGER DEFAULT 0,
  high_risk_findings INTEGER DEFAULT 0,
  grounded_issue_numerator INTEGER DEFAULT 0,
  grounded_issue_denominator INTEGER DEFAULT 0,
  unsupported_issue_numerator INTEGER DEFAULT 0,
  unsupported_issue_denominator INTEGER DEFAULT 0,
  low_evidence_issue_numerator INTEGER DEFAULT 0,
  low_evidence_issue_denominator INTEGER DEFAULT 0,
  uncorroborated_high_risk_numerator INTEGER DEFAULT 0,
  uncorroborated_high_risk_denominator INTEGER DEFAULT 0,
  outcome_suppression_numerator INTEGER DEFAULT 0,
  outcome_suppression_denominator INTEGER DEFAULT 0,
  issue_addressed_numerator INTEGER DEFAULT 0,
  issue_addressed_denominator INTEGER DEFAULT 0,
  issue_dismissed_numerator INTEGER DEFAULT 0,
  issue_dismissed_denominator INTEGER DEFAULT 0,
  issue_outcome_coverage_numerator INTEGER DEFAULT 0,
  issue_outcome_coverage_denominator INTEGER DEFAULT 0,
  omitted_files INTEGER DEFAULT 0,
  failed_files INTEGER DEFAULT 0,
  updated_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, review_type, review_id)
);

CREATE INDEX IF NOT EXISTS idx_trust_review_facts_project_completed
  ON trust_review_facts(project_id, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trust_review_facts_project_type_completed
  ON trust_review_facts(project_id, review_type, completed_at DESC);
CREATE INDEX IF NOT EXISTS idx_trust_review_facts_project_provider
  ON trust_review_facts(project_id, provider_model, completed_at DESC);
`;

export const up = {
  postgres: postgresSQL,
  sqlite: sqliteSQL,
};
