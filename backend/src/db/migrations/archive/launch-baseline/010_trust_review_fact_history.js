/**
 * Migration 010: Trust Analytics fact history
 *
 * Persist one fact snapshot per completed review run instead of overwriting the
 * latest snapshot for a stable branch/PR review scope. This lets project-level
 * analytics count repeated branch rereviews and PR rereviews correctly.
 */

export const version = 10;
export const name = 'trust_review_fact_history';

const postgresSQL = `
UPDATE trust_review_facts
SET completed_at = COALESCE(completed_at, created_at_source, NOW())
WHERE completed_at IS NULL;

UPDATE trust_review_dimension_facts
SET completed_at = COALESCE(completed_at, updated_at, NOW())
WHERE completed_at IS NULL;

ALTER TABLE trust_review_facts DROP CONSTRAINT IF EXISTS trust_review_facts_pkey;
ALTER TABLE trust_review_facts
  ADD PRIMARY KEY (project_id, review_type, review_id, completed_at);

ALTER TABLE trust_review_dimension_facts DROP CONSTRAINT IF EXISTS trust_review_dimension_facts_pkey;
ALTER TABLE trust_review_dimension_facts
  ADD PRIMARY KEY (project_id, review_type, review_id, completed_at, recommendation_key);
`;

const sqliteSQL = `
ALTER TABLE trust_review_facts RENAME TO trust_review_facts_legacy;

CREATE TABLE trust_review_facts (
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
  completed_at TEXT NOT NULL,
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
  PRIMARY KEY (project_id, review_type, review_id, completed_at)
);

INSERT INTO trust_review_facts (
  project_id, review_type, review_id, display_id, branch_name, review_status,
  review_reliability, gate_status, gate_reason_codes, provider_type, provider_model,
  created_at_source, completed_at, ttfs_ms, review_duration_ms, total_changed_files,
  deep_coverage_numerator, deep_coverage_denominator, issues_found, high_risk_findings,
  grounded_issue_numerator, grounded_issue_denominator,
  unsupported_issue_numerator, unsupported_issue_denominator,
  low_evidence_issue_numerator, low_evidence_issue_denominator,
  uncorroborated_high_risk_numerator, uncorroborated_high_risk_denominator,
  outcome_suppression_numerator, outcome_suppression_denominator,
  issue_addressed_numerator, issue_addressed_denominator,
  issue_dismissed_numerator, issue_dismissed_denominator,
  issue_outcome_coverage_numerator, issue_outcome_coverage_denominator,
  omitted_files, failed_files, updated_at
)
SELECT
  project_id, review_type, review_id, display_id, branch_name, review_status,
  review_reliability, gate_status, gate_reason_codes, provider_type, provider_model,
  created_at_source, COALESCE(completed_at, created_at_source, datetime('now')), ttfs_ms, review_duration_ms, total_changed_files,
  deep_coverage_numerator, deep_coverage_denominator, issues_found, high_risk_findings,
  grounded_issue_numerator, grounded_issue_denominator,
  unsupported_issue_numerator, unsupported_issue_denominator,
  low_evidence_issue_numerator, low_evidence_issue_denominator,
  uncorroborated_high_risk_numerator, uncorroborated_high_risk_denominator,
  outcome_suppression_numerator, outcome_suppression_denominator,
  issue_addressed_numerator, issue_addressed_denominator,
  issue_dismissed_numerator, issue_dismissed_denominator,
  issue_outcome_coverage_numerator, issue_outcome_coverage_denominator,
  omitted_files, failed_files, updated_at
FROM trust_review_facts_legacy;

DROP TABLE trust_review_facts_legacy;

CREATE INDEX idx_trust_review_facts_project_completed
  ON trust_review_facts(project_id, completed_at DESC);
CREATE INDEX idx_trust_review_facts_project_type_completed
  ON trust_review_facts(project_id, review_type, completed_at DESC);
CREATE INDEX idx_trust_review_facts_project_provider
  ON trust_review_facts(project_id, provider_model, completed_at DESC);

ALTER TABLE trust_review_dimension_facts RENAME TO trust_review_dimension_facts_legacy;

CREATE TABLE trust_review_dimension_facts (
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  review_type TEXT NOT NULL,
  review_id TEXT NOT NULL,
  recommendation_key TEXT NOT NULL,
  completed_at TEXT NOT NULL,
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
  PRIMARY KEY (project_id, review_type, review_id, completed_at, recommendation_key)
);

INSERT INTO trust_review_dimension_facts (
  project_id, review_type, review_id, recommendation_key, completed_at,
  provider_type, provider_model, language, path_pattern,
  issue_count, high_risk_count, outcome_addressed_count,
  outcome_dismissed_count, outcome_recorded_count, updated_at
)
SELECT
  project_id, review_type, review_id, recommendation_key, COALESCE(completed_at, updated_at, datetime('now')),
  provider_type, provider_model, language, path_pattern,
  issue_count, high_risk_count, outcome_addressed_count,
  outcome_dismissed_count, outcome_recorded_count, updated_at
FROM trust_review_dimension_facts_legacy;

DROP TABLE trust_review_dimension_facts_legacy;

CREATE INDEX idx_trust_review_dimension_facts_project_completed
  ON trust_review_dimension_facts(project_id, completed_at DESC);
CREATE INDEX idx_trust_review_dimension_facts_provider
  ON trust_review_dimension_facts(project_id, provider_model, completed_at DESC);
CREATE INDEX idx_trust_review_dimension_facts_language
  ON trust_review_dimension_facts(project_id, language, completed_at DESC);
CREATE INDEX idx_trust_review_dimension_facts_path
  ON trust_review_dimension_facts(project_id, path_pattern, completed_at DESC);
`;

export const up = {
  postgres: postgresSQL,
  sqlite: sqliteSQL,
};
