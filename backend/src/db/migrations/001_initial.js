/**
 * Migration 001: Pre-release baseline schema
 *
 * Squashed baseline for AtlasEngine launch candidate.
 * Contains the effective schema from migrations 001-021.
 *
 * Notes:
 * - Migration 012 (branch_review_json) is intentionally omitted in the
 *   baseline because migration 011 already creates the column in fresh DBs.
 */

export const version = 1;
export const name = 'pre_release_baseline';

const postgresSQL = `
-- Migration 001: initial_schema
-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Schema version table (must be first)
CREATE TABLE IF NOT EXISTS schema_version (
  version INT PRIMARY KEY,
  description TEXT,
  applied_at TIMESTAMPTZ DEFAULT NOW()
);

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  name TEXT,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
  is_active BOOLEAN DEFAULT TRUE,
  email_verified BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_login TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_plan ON users(plan);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

-- User quotas table
CREATE TABLE IF NOT EXISTS user_quotas (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  monthly_token_limit BIGINT DEFAULT 1000000,
  tokens_used_this_month BIGINT DEFAULT 0,
  monthly_cost_limit DECIMAL(10,2) DEFAULT 50.00,
  cost_this_month DECIMAL(10,2) DEFAULT 0.00,
  max_concurrent_containers INT DEFAULT 1,
  max_container_memory_mb INT DEFAULT 512,
  max_container_vcpu DECIMAL(3,2) DEFAULT 0.50,
  requests_per_hour INT DEFAULT 50,
  requests_this_hour INT DEFAULT 0,
  hour_window_start TIMESTAMPTZ DEFAULT NOW(),
  max_builds_per_day INT DEFAULT 10,
  builds_today INT DEFAULT 0,
  day_window_start TIMESTAMPTZ DEFAULT NOW(),
  quota_exceeded BOOLEAN DEFAULT FALSE,
  quota_exceeded_reason TEXT,
  last_reset TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_quotas_exceeded ON user_quotas(quota_exceeded);

-- Projects table
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  path TEXT,
  repo_url TEXT,
  has_memory BOOLEAN DEFAULT FALSE,
  memory_size BIGINT DEFAULT 0,
  last_memory_update TIMESTAMPTZ,
  framework TEXT,
  language TEXT,
  source TEXT DEFAULT 'builder',
  generated_review_policy_json TEXT,
  generated_review_policy_hash TEXT,
  generated_review_policy_version INTEGER,
  generated_review_policy_generator_version TEXT,
  generated_review_policy_generated_at TIMESTAMPTZ,
  base_branch_display TEXT,
  base_branch_ref TEXT,
  cli_session_id TEXT,
  cli_sessions TEXT,
  last_cli_provider TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_accessed TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_session ON projects(session_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);

-- Builds table
CREATE TABLE IF NOT EXISTS builds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  build_number SERIAL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  builder_container_id TEXT,
  image_id TEXT,
  build_logs TEXT,
  error_message TEXT,
  queued_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  duration_seconds INT,
  memory_used_mb INT,
  cpu_time_seconds INT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_builds_project ON builds(project_id);
CREATE INDEX IF NOT EXISTS idx_builds_user ON builds(user_id);
CREATE INDEX IF NOT EXISTS idx_builds_status ON builds(status);
CREATE INDEX IF NOT EXISTS idx_builds_created ON builds(created_at DESC);

-- Previews table
CREATE TABLE IF NOT EXISTS previews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  build_id UUID REFERENCES builds(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  container_id TEXT UNIQUE,
  container_name TEXT UNIQUE,
  image_id TEXT,
  host TEXT NOT NULL,
  port INT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('starting', 'healthy', 'unhealthy', 'stopped', 'failed')),
  health_check_count INT DEFAULT 0,
  last_health_check TIMESTAMPTZ,
  memory_limit_mb INT DEFAULT 256,
  cpu_limit DECIMAL(3,2) DEFAULT 0.25,
  request_count BIGINT DEFAULT 0,
  last_accessed TIMESTAMPTZ DEFAULT NOW(),
  auto_sleep_enabled BOOLEAN DEFAULT TRUE,
  sleep_after_minutes INT DEFAULT 30,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  stopped_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_previews_project ON previews(project_id);
CREATE INDEX IF NOT EXISTS idx_previews_user ON previews(user_id);
CREATE INDEX IF NOT EXISTS idx_previews_status ON previews(status);
CREATE INDEX IF NOT EXISTS idx_previews_host ON previews(host);
CREATE INDEX IF NOT EXISTS idx_previews_container ON previews(container_id);
CREATE INDEX IF NOT EXISTS idx_previews_last_accessed ON previews(last_accessed);

-- Memory snapshots table
CREATE TABLE IF NOT EXISTS memory_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('claude_md', 'scratch', 'checkpoint', 'auto')),
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT,
  size_bytes BIGINT NOT NULL,
  context_size INT,
  notes TEXT,
  checkpoint_name TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_snapshots_project ON memory_snapshots(project_id);
CREATE INDEX IF NOT EXISTS idx_memory_snapshots_user ON memory_snapshots(user_id);
CREATE INDEX IF NOT EXISTS idx_memory_snapshots_kind ON memory_snapshots(kind);
CREATE INDEX IF NOT EXISTS idx_memory_snapshots_created ON memory_snapshots(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_snapshots_hash ON memory_snapshots(content_hash);

-- Usage ledger table
CREATE TABLE IF NOT EXISTS usage_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tokens', 'containers', 'build_minutes', 'api_call', 'storage')),
  amount BIGINT NOT NULL,
  cost DECIMAL(10,4) DEFAULT 0.0000,
  meta JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_usage_ledger_user ON usage_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_project ON usage_ledger(project_id);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_kind ON usage_ledger(kind);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_created ON usage_ledger(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_user_created ON usage_ledger(user_id, created_at DESC);

-- Events table
CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  status TEXT,
  message TEXT,
  meta JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_user_created ON events(user_id, created_at DESC);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  ip_address INET,
  user_agent TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_activity TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(is_active);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Chat messages table
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  tokens_used INT DEFAULT 0,
  model TEXT,
  meta JSONB,
  file_diff JSONB,
  is_deleted BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_project ON chat_messages(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_user ON chat_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_role ON chat_messages(role);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_project_role ON chat_messages(project_id, role);

-- Chat stream state table
CREATE TABLE IF NOT EXISTS chat_stream_state (
  project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  started_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_stream_state_updated ON chat_stream_state(updated_at DESC);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
DO $$ BEGIN
  CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER update_projects_updated_at BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER update_user_quotas_updated_at BEFORE UPDATE ON user_quotas FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TRIGGER update_previews_updated_at BEFORE UPDATE ON previews FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Function to create default user quota
CREATE OR REPLACE FUNCTION create_default_user_quota()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO user_quotas (user_id) VALUES (NEW.id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER create_user_quota_on_signup AFTER INSERT ON users FOR EACH ROW EXECUTE FUNCTION create_default_user_quota();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- View: Chat statistics by project
CREATE OR REPLACE VIEW chat_stats_by_project AS
SELECT
  project_id,
  COUNT(*) as total_messages,
  COUNT(*) FILTER (WHERE role = 'user') as user_messages,
  COUNT(*) FILTER (WHERE role = 'assistant') as assistant_messages,
  COALESCE(SUM(tokens_used), 0) as total_tokens,
  MIN(created_at) as first_message_at,
  MAX(created_at) as last_message_at
FROM chat_messages
WHERE is_deleted = FALSE
GROUP BY project_id;

-- Seed: Anonymous user for unauthenticated access (MVP mode)
INSERT INTO users (id, email, name, plan, is_active)
VALUES ('00000000-0000-0000-0000-000000000000', 'anonymous@atlasengine.local', 'Anonymous User', 'free', TRUE)
ON CONFLICT (id) DO NOTHING;

-- Migration 002: settings_table
-- Settings table (key-value store)
CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_settings_updated ON settings(updated_at DESC);

-- Trigger for updated_at
DO $$ BEGIN
  CREATE TRIGGER update_settings_updated_at BEFORE UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Migration 003: github_integration
-- GitHub integrations
CREATE TABLE IF NOT EXISTS github_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_id BIGINT UNIQUE NOT NULL,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK (account_type IN ('User', 'Organization')),
  account_avatar_url TEXT,
  access_token_encrypted TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  user_access_token_encrypted TEXT,
  repositories_accessible JSONB,
  permissions JSONB,
  events JSONB,
  is_active BOOLEAN DEFAULT TRUE,
  suspended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_github_integrations_user ON github_integrations(user_id);
CREATE INDEX IF NOT EXISTS idx_github_integrations_installation ON github_integrations(installation_id);
CREATE INDEX IF NOT EXISTS idx_github_integrations_active ON github_integrations(is_active) WHERE is_active = TRUE;

DO $$ BEGIN
  CREATE TRIGGER update_github_integrations_updated_at
  BEFORE UPDATE ON github_integrations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- GitHub sync events
CREATE TABLE IF NOT EXISTS github_sync_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  direction TEXT NOT NULL CHECK (direction IN ('to_github', 'from_github')),
  event_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'success', 'failed')),
  commit_sha TEXT,
  commit_message TEXT,
  branch TEXT DEFAULT 'main',
  files_changed JSONB,
  files_count INT DEFAULT 0,
  error_message TEXT,
  retry_count INT DEFAULT 0,
  duration_ms INT,
  metadata JSONB,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sync_events_project ON github_sync_events(project_id);
CREATE INDEX IF NOT EXISTS idx_sync_events_status ON github_sync_events(status);
CREATE INDEX IF NOT EXISTS idx_sync_events_direction ON github_sync_events(direction);
CREATE INDEX IF NOT EXISTS idx_sync_events_created ON github_sync_events(created_at DESC);

-- GitHub sync queue
CREATE TABLE IF NOT EXISTS github_sync_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sync_type TEXT NOT NULL CHECK (sync_type IN ('push', 'pull')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
  commit_sha TEXT,
  commit_message TEXT,
  files_changed JSONB,
  error_message TEXT,
  retry_count INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_sync_queue_project ON github_sync_queue(project_id);
CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON github_sync_queue(status);
CREATE INDEX IF NOT EXISTS idx_sync_queue_created ON github_sync_queue(created_at DESC);

-- Project columns for GitHub metadata
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS generated_review_policy_json TEXT,
  ADD COLUMN IF NOT EXISTS generated_review_policy_hash TEXT,
  ADD COLUMN IF NOT EXISTS generated_review_policy_version INTEGER,
  ADD COLUMN IF NOT EXISTS generated_review_policy_generator_version TEXT,
  ADD COLUMN IF NOT EXISTS generated_review_policy_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS github_repo_id BIGINT,
  ADD COLUMN IF NOT EXISTS github_repo_full_name TEXT,
  ADD COLUMN IF NOT EXISTS github_installation_id BIGINT,
  ADD COLUMN IF NOT EXISTS github_default_branch TEXT DEFAULT 'main',
  ADD COLUMN IF NOT EXISTS github_clone_url TEXT,
  ADD COLUMN IF NOT EXISTS github_last_sync_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS github_sync_enabled BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS github_sync_status TEXT DEFAULT 'disabled'
    CHECK (github_sync_status IN ('synced', 'syncing', 'error', 'disabled', 'conflict')),
  ADD COLUMN IF NOT EXISTS github_repo_owner TEXT,
  ADD COLUMN IF NOT EXISTS github_repo_name TEXT,
  ADD COLUMN IF NOT EXISTS github_last_sync_sha TEXT,
  ADD COLUMN IF NOT EXISTS github_webhook_id BIGINT;

CREATE INDEX IF NOT EXISTS idx_projects_github_repo ON projects(github_repo_id);
CREATE INDEX IF NOT EXISTS idx_projects_github_sync ON projects(github_sync_enabled) WHERE github_sync_enabled = TRUE;
CREATE INDEX IF NOT EXISTS idx_projects_github_installation ON projects(github_installation_id);

-- Migration 004: atlas_hosting
-- Vercel project columns on projects
ALTER TABLE projects
ADD COLUMN IF NOT EXISTS vercel_project_id VARCHAR(255),
ADD COLUMN IF NOT EXISTS vercel_project_name VARCHAR(255),
ADD COLUMN IF NOT EXISTS last_deployment_url VARCHAR(500),
ADD COLUMN IF NOT EXISTS last_deployment_at TIMESTAMP;

-- Publish attempts table
CREATE TABLE IF NOT EXISTS publish_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  changeset_id VARCHAR(100),
  commit_hash VARCHAR(40),
  vercel_project_id VARCHAR(255),
  deployment_id VARCHAR(255),
  deployment_url VARCHAR(500),
  vercel_url VARCHAR(500),
  inspect_url VARCHAR(500),
  status VARCHAR(20) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  started_at TIMESTAMP,
  finished_at TIMESTAMP,
  logs TEXT,
  error_message TEXT,
  secrets_keys TEXT[] DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_publish_attempts_project ON publish_attempts(project_id);
CREATE INDEX IF NOT EXISTS idx_publish_attempts_status ON publish_attempts(status);
CREATE INDEX IF NOT EXISTS idx_publish_attempts_created ON publish_attempts(project_id, created_at DESC);

-- Production deployment pointer columns on projects
ALTER TABLE projects
ADD COLUMN IF NOT EXISTS production_deployment_id UUID REFERENCES publish_attempts(id),
ADD COLUMN IF NOT EXISTS production_commit_hash VARCHAR(40),
ADD COLUMN IF NOT EXISTS production_changeset_id VARCHAR(100),
ADD COLUMN IF NOT EXISTS production_url VARCHAR(500),
ADD COLUMN IF NOT EXISTS production_updated_at TIMESTAMP;

-- Migration 005: github_refresh_token
ALTER TABLE github_integrations
ADD COLUMN IF NOT EXISTS refresh_token_encrypted TEXT,
ADD COLUMN IF NOT EXISTS refresh_token_expires_at TIMESTAMPTZ;

-- Migration 006: database_provisioning
ALTER TABLE projects
ADD COLUMN IF NOT EXISTS database_name VARCHAR(255),
ADD COLUMN IF NOT EXISTS database_user VARCHAR(255),
ADD COLUMN IF NOT EXISTS database_url TEXT,
ADD COLUMN IF NOT EXISTS database_provisioned BOOLEAN DEFAULT FALSE;

-- Migration 007: project_secrets
CREATE TABLE IF NOT EXISTS project_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key VARCHAR(255) NOT NULL,
  value TEXT NOT NULL,
  is_secret BOOLEAN DEFAULT true,
  environment VARCHAR(50) DEFAULT 'production',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_project_key_env UNIQUE (project_id, key, environment)
);

CREATE INDEX IF NOT EXISTS idx_project_secrets_project ON project_secrets(project_id);
CREATE INDEX IF NOT EXISTS idx_project_secrets_environment ON project_secrets(project_id, environment);

-- Migration 008: actions_log
-- Drop and recreate to fix TEXT/UUID FK mismatch from earlier partial migrations
DROP TABLE IF EXISTS actions_log;
CREATE TABLE IF NOT EXISTS actions_log (
      id TEXT PRIMARY KEY,
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      changeset_id TEXT,
      action_type TEXT NOT NULL,
      action_status TEXT NOT NULL DEFAULT 'pending',
      input TEXT,
      output TEXT,
      error_message TEXT,
      triggered_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_actions_log_project ON actions_log(project_id);
    CREATE INDEX IF NOT EXISTS idx_actions_log_changeset ON actions_log(changeset_id);

-- Migration 009: review_usage_tracking
CREATE TABLE IF NOT EXISTS review_usage (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      changeset_id TEXT,
      review_type TEXT,
      review_id TEXT,
      provider_type TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost NUMERIC(10, 6) NOT NULL DEFAULT 0,
      provider_native_cost NUMERIC(10, 6),
      cost_source TEXT,
      cost_is_approximate BOOLEAN NOT NULL DEFAULT FALSE,
      reviewed_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_review_usage_project ON review_usage(project_id);
    CREATE INDEX IF NOT EXISTS idx_review_usage_reviewed_at ON review_usage(reviewed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_review_usage_review_identity
      ON review_usage(project_id, review_type, review_id, reviewed_at DESC);

-- Migration 011: branch_reviews
CREATE TABLE IF NOT EXISTS branch_reviews (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
      display_id TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      merge_base_sha TEXT,
      fork_point_sha TEXT,
      head_sha TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'merged', 'closed', 'stale')),
      is_current BOOLEAN DEFAULT FALSE,
      file_count INTEGER DEFAULT 0,
      total_additions INTEGER DEFAULT 0,
      total_deletions INTEGER DEFAULT 0,
      commit_count INTEGER DEFAULT 0,
      first_commit_at TIMESTAMPTZ,
      last_commit_at TIMESTAMPTZ,
      review_status TEXT DEFAULT 'none'
        CHECK (review_status IN ('none', 'queued', 'reviewing', 'reviewed', 'failed')),
      review_risk_level TEXT,
      review_summary TEXT,
      review_json TEXT,
      review_error TEXT,
      review_base_branch TEXT,
      review_merge_base_sha TEXT,
      review_fork_point_sha TEXT,
      review_head_sha TEXT,
      reviewed_at TIMESTAMPTZ,
      base_branch_source TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_branch_reviews_project ON branch_reviews(project_id);
    CREATE INDEX IF NOT EXISTS idx_branch_reviews_branch ON branch_reviews(project_id, branch_name);
    CREATE INDEX IF NOT EXISTS idx_branch_reviews_current ON branch_reviews(project_id, is_current);
    CREATE INDEX IF NOT EXISTS idx_branch_reviews_status ON branch_reviews(status);

-- Migration 012: pr_reviews
CREATE TABLE IF NOT EXISTS pr_reviews (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
      display_id TEXT NOT NULL,
      github_pr_number INTEGER NOT NULL,
      title TEXT,
      body TEXT,
      author_login TEXT,
      author_avatar_url TEXT,
      state TEXT NOT NULL DEFAULT 'open',
      head_branch TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      head_sha TEXT,
      base_sha TEXT,
      file_count INTEGER DEFAULT 0,
      total_additions INTEGER DEFAULT 0,
      total_deletions INTEGER DEFAULT 0,
      commit_count INTEGER DEFAULT 0,
      labels TEXT,
      html_url TEXT,
      assignees JSONB DEFAULT '[]'::jsonb,
      requested_reviewers JSONB DEFAULT '[]'::jsonb,
      reviewer_participants JSONB DEFAULT '[]'::jsonb,
      review_status TEXT DEFAULT 'none',
      review_risk_level TEXT,
      review_summary TEXT,
      review_error TEXT,
      review_json TEXT,
      review_head_sha TEXT,
      reviewed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(project_id, github_pr_number)
    );

    CREATE INDEX IF NOT EXISTS idx_pr_reviews_project ON pr_reviews(project_id);
    CREATE INDEX IF NOT EXISTS idx_pr_reviews_state ON pr_reviews(project_id, state);

-- Migration 015: review_file_cache
CREATE TABLE IF NOT EXISTS review_file_cache (
      project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
      context_type TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      file_path TEXT NOT NULL,
      before_hash TEXT NOT NULL,
      after_hash TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      provider_model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      quality_mode TEXT NOT NULL DEFAULT 'v2',
      review_json TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      last_used_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (project_id, cache_key)
    );

    CREATE INDEX IF NOT EXISTS idx_review_file_cache_project_context
      ON review_file_cache(project_id, context_type);

    CREATE INDEX IF NOT EXISTS idx_review_file_cache_project_path
      ON review_file_cache(project_id, file_path);

-- Migration 016: trust_review_facts
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
      completed_at TIMESTAMPTZ NOT NULL,
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
      PRIMARY KEY (project_id, review_type, review_id, completed_at)
    );

    CREATE INDEX IF NOT EXISTS idx_trust_review_facts_project_completed
      ON trust_review_facts(project_id, completed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_trust_review_facts_project_type_completed
      ON trust_review_facts(project_id, review_type, completed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_trust_review_facts_project_provider
      ON trust_review_facts(project_id, provider_model, completed_at DESC);

-- Migration 017: trust_review_dimension_facts
CREATE TABLE IF NOT EXISTS trust_review_dimension_facts (
      project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
      review_type TEXT NOT NULL,
      review_id TEXT NOT NULL,
      recommendation_key TEXT NOT NULL,
      completed_at TIMESTAMPTZ NOT NULL,
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
      PRIMARY KEY (project_id, review_type, review_id, completed_at, recommendation_key)
    );

    CREATE INDEX IF NOT EXISTS idx_trust_review_dimension_facts_project_completed
      ON trust_review_dimension_facts(project_id, completed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_trust_review_dimension_facts_provider
      ON trust_review_dimension_facts(project_id, provider_model, completed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_trust_review_dimension_facts_language
      ON trust_review_dimension_facts(project_id, language, completed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_trust_review_dimension_facts_path
      ON trust_review_dimension_facts(project_id, path_pattern, completed_at DESC);

-- Migration 016: review_outcomes
CREATE TABLE IF NOT EXISTS review_outcomes (
      project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      review_type TEXT NOT NULL
        CHECK (review_type IN ('changeset', 'branch_review', 'pr_review')),
      review_id TEXT NOT NULL,
      recommendation_key TEXT NOT NULL,
      status TEXT NOT NULL
        CHECK (status IN ('addressed', 'dismissed')),
      note TEXT,
      provider_type TEXT,
      provider_model TEXT,
      language TEXT,
      path_pattern TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (project_id, review_type, review_id, recommendation_key)
    );

    CREATE INDEX IF NOT EXISTS idx_review_outcomes_project_scope
      ON review_outcomes(project_id, review_type, review_id);

    CREATE INDEX IF NOT EXISTS idx_review_outcomes_scope_updated
      ON review_outcomes(project_id, review_type, review_id, updated_at DESC);

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

-- Migration 018: review_publications
CREATE TABLE IF NOT EXISTS review_publications (
      project_id TEXT NOT NULL,
      review_type TEXT NOT NULL,
      review_id TEXT NOT NULL,
      recommendation_key TEXT NOT NULL,
      channel TEXT NOT NULL,
      action TEXT NOT NULL,
      github_review_id TEXT,
      github_pr_number INTEGER,
      head_sha TEXT,
      file_path TEXT,
      line INTEGER,
      published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (project_id, review_type, review_id, recommendation_key, channel)
    );

    CREATE INDEX IF NOT EXISTS idx_review_publications_scope
      ON review_publications(project_id, review_type, review_id, updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_review_publications_scope_head
      ON review_publications(project_id, review_type, review_id, head_sha, channel);

-- Migration 019: review_outcomes_sqlite_constraints
SELECT 1;

-- Migration 020: supabase_integration
-- Supabase integrations (one per user)
CREATE TABLE IF NOT EXISTS supabase_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  account_email TEXT,
  organizations JSONB,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_supabase_integrations_user
  ON supabase_integrations(user_id) WHERE is_active = TRUE;

DROP TRIGGER IF EXISTS update_supabase_integrations_updated_at ON supabase_integrations;
CREATE TRIGGER update_supabase_integrations_updated_at
  BEFORE UPDATE ON supabase_integrations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Supabase project links (one per AtlasEngine project)
CREATE TABLE IF NOT EXISTS supabase_project_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  supabase_project_ref TEXT NOT NULL,
  supabase_project_name TEXT NOT NULL,
  supabase_org_id TEXT,
  region TEXT,
  database_url_encrypted TEXT,
  anon_key TEXT,
  service_role_key_encrypted TEXT,
  supabase_url TEXT NOT NULL,
  provisioned_by TEXT NOT NULL DEFAULT 'linked',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_supabase_project_links_project
  ON supabase_project_links(project_id);

DROP TRIGGER IF EXISTS update_supabase_project_links_updated_at ON supabase_project_links;
CREATE TRIGGER update_supabase_project_links_updated_at
  BEFORE UPDATE ON supabase_project_links
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Migration 023: review_cloud_sync
CREATE TABLE IF NOT EXISTS review_sync_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL UNIQUE,
  device_label TEXT,
  auth_token_hash TEXT NOT NULL UNIQUE,
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_review_sync_sessions_user
  ON review_sync_sessions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_sync_sessions_active
  ON review_sync_sessions(revoked_at, last_seen_at DESC);

DROP TRIGGER IF EXISTS update_review_sync_sessions_updated_at ON review_sync_sessions;
CREATE TRIGGER update_review_sync_sessions_updated_at
  BEFORE UPDATE ON review_sync_sessions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TABLE IF NOT EXISTS review_sync_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  device_id TEXT,
  project_id TEXT,
  project_name TEXT,
  project_path TEXT,
  review_type TEXT NOT NULL,
  review_id TEXT NOT NULL,
  recommendation_key TEXT,
  event_type TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  sync_error TEXT,
  sync_attempt_count INTEGER NOT NULL DEFAULT 0,
  synced_at TIMESTAMPTZ,
  event_idempotency_key TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_sync_events_user_idempotency
  ON review_sync_events(user_id, event_idempotency_key);

CREATE INDEX IF NOT EXISTS idx_review_sync_events_status_occurred
  ON review_sync_events(sync_status, occurred_at ASC);

CREATE INDEX IF NOT EXISTS idx_review_sync_events_user_occurred
  ON review_sync_events(user_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_sync_events_scope_occurred
  ON review_sync_events(user_id, review_type, review_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_sync_events_recommendation
  ON review_sync_events(user_id, review_type, review_id, recommendation_key, occurred_at DESC);

DROP TRIGGER IF EXISTS update_review_sync_events_updated_at ON review_sync_events;
CREATE TRIGGER update_review_sync_events_updated_at
  BEFORE UPDATE ON review_sync_events
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Migration 021: cli_session_id
ALTER TABLE projects ADD COLUMN IF NOT EXISTS cli_session_id TEXT;

-- Migration 022: per_provider_sessions
ALTER TABLE projects ADD COLUMN IF NOT EXISTS cli_sessions TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_cli_provider TEXT;

    UPDATE projects
    SET cli_sessions = '{"anthropic":"' || cli_session_id || '"}'
    WHERE cli_session_id IS NOT NULL AND (cli_sessions IS NULL OR cli_sessions = '');
`;

const sqliteSQL = `
-- Migration 001: initial_schema
-- SQLite pragmas
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- Schema version table (must be first)
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  description TEXT,
  applied_at TEXT DEFAULT (datetime('now'))
);

-- Users table
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  name TEXT,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro', 'enterprise')),
  is_active INTEGER DEFAULT 1,
  email_verified INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  last_login TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_plan ON users(plan);
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

-- User quotas table
CREATE TABLE IF NOT EXISTS user_quotas (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  monthly_token_limit INTEGER DEFAULT 1000000,
  tokens_used_this_month INTEGER DEFAULT 0,
  monthly_cost_limit REAL DEFAULT 50.00,
  cost_this_month REAL DEFAULT 0.00,
  max_concurrent_containers INTEGER DEFAULT 1,
  max_container_memory_mb INTEGER DEFAULT 512,
  max_container_vcpu REAL DEFAULT 0.50,
  requests_per_hour INTEGER DEFAULT 50,
  requests_this_hour INTEGER DEFAULT 0,
  hour_window_start TEXT DEFAULT (datetime('now')),
  max_builds_per_day INTEGER DEFAULT 10,
  builds_today INTEGER DEFAULT 0,
  day_window_start TEXT DEFAULT (datetime('now')),
  quota_exceeded INTEGER DEFAULT 0,
  quota_exceeded_reason TEXT,
  last_reset TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_user_quotas_exceeded ON user_quotas(quota_exceeded);

-- Projects table
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  path TEXT,
  repo_url TEXT,
  has_memory INTEGER DEFAULT 0,
  memory_size INTEGER DEFAULT 0,
  last_memory_update TEXT,
  framework TEXT,
  language TEXT,
  source TEXT DEFAULT 'builder',
  generated_review_policy_json TEXT,
  generated_review_policy_hash TEXT,
  generated_review_policy_version INTEGER,
  generated_review_policy_generator_version TEXT,
  generated_review_policy_generated_at TEXT,
  base_branch_display TEXT,
  base_branch_ref TEXT,
  cli_session_id TEXT,
  cli_sessions TEXT,
  last_cli_provider TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived', 'deleted')),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  last_accessed TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(user_id);
CREATE INDEX IF NOT EXISTS idx_projects_session ON projects(session_id);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_updated ON projects(updated_at DESC);

-- Builds table
CREATE TABLE IF NOT EXISTS builds (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  build_number INTEGER,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  builder_container_id TEXT,
  image_id TEXT,
  build_logs TEXT,
  error_message TEXT,
  queued_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  duration_seconds INTEGER,
  memory_used_mb INTEGER,
  cpu_time_seconds INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_builds_project ON builds(project_id);
CREATE INDEX IF NOT EXISTS idx_builds_user ON builds(user_id);
CREATE INDEX IF NOT EXISTS idx_builds_status ON builds(status);
CREATE INDEX IF NOT EXISTS idx_builds_created ON builds(created_at DESC);

-- Previews table
CREATE TABLE IF NOT EXISTS previews (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  build_id TEXT REFERENCES builds(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  container_id TEXT UNIQUE,
  container_name TEXT UNIQUE,
  image_id TEXT,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('starting', 'healthy', 'unhealthy', 'stopped', 'failed')),
  health_check_count INTEGER DEFAULT 0,
  last_health_check TEXT,
  memory_limit_mb INTEGER DEFAULT 256,
  cpu_limit REAL DEFAULT 0.25,
  request_count INTEGER DEFAULT 0,
  last_accessed TEXT DEFAULT (datetime('now')),
  auto_sleep_enabled INTEGER DEFAULT 1,
  sleep_after_minutes INTEGER DEFAULT 30,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  stopped_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_previews_project ON previews(project_id);
CREATE INDEX IF NOT EXISTS idx_previews_user ON previews(user_id);
CREATE INDEX IF NOT EXISTS idx_previews_status ON previews(status);
CREATE INDEX IF NOT EXISTS idx_previews_host ON previews(host);
CREATE INDEX IF NOT EXISTS idx_previews_container ON previews(container_id);
CREATE INDEX IF NOT EXISTS idx_previews_last_accessed ON previews(last_accessed);

-- Memory snapshots table
CREATE TABLE IF NOT EXISTS memory_snapshots (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('claude_md', 'scratch', 'checkpoint', 'auto')),
  path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT,
  size_bytes INTEGER NOT NULL,
  context_size INTEGER,
  notes TEXT,
  checkpoint_name TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_memory_snapshots_project ON memory_snapshots(project_id);
CREATE INDEX IF NOT EXISTS idx_memory_snapshots_user ON memory_snapshots(user_id);
CREATE INDEX IF NOT EXISTS idx_memory_snapshots_kind ON memory_snapshots(kind);
CREATE INDEX IF NOT EXISTS idx_memory_snapshots_created ON memory_snapshots(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_snapshots_hash ON memory_snapshots(content_hash);

-- Usage ledger table
CREATE TABLE IF NOT EXISTS usage_ledger (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('tokens', 'containers', 'build_minutes', 'api_call', 'storage')),
  amount INTEGER NOT NULL,
  cost REAL DEFAULT 0.0000,
  meta TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_usage_ledger_user ON usage_ledger(user_id);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_project ON usage_ledger(project_id);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_kind ON usage_ledger(kind);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_created ON usage_ledger(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_ledger_user_created ON usage_ledger(user_id, created_at DESC);

-- Events table
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  status TEXT,
  message TEXT,
  meta TEXT,
  ip_address TEXT,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id);
CREATE INDEX IF NOT EXISTS idx_events_kind ON events(kind);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_user_created ON events(user_id, created_at DESC);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT UNIQUE NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  last_activity TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(is_active);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

-- Chat messages table
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  tokens_used INTEGER DEFAULT 0,
  model TEXT,
  meta TEXT,
  file_diff TEXT,
  is_deleted INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_project ON chat_messages(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_user ON chat_messages(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_messages_role ON chat_messages(role);
CREATE INDEX IF NOT EXISTS idx_chat_messages_created ON chat_messages(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_project_role ON chat_messages(project_id, role);

-- Chat stream state table
CREATE TABLE IF NOT EXISTS chat_stream_state (
  project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL DEFAULT '',
  started_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_stream_state_updated ON chat_stream_state(updated_at DESC);

-- Triggers for updated_at (SQLite syntax)
CREATE TRIGGER IF NOT EXISTS update_users_updated_at AFTER UPDATE ON users
BEGIN
  UPDATE users SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_projects_updated_at AFTER UPDATE ON projects
BEGIN
  UPDATE projects SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS update_user_quotas_updated_at AFTER UPDATE ON user_quotas
BEGIN
  UPDATE user_quotas SET updated_at = datetime('now') WHERE user_id = NEW.user_id;
END;

CREATE TRIGGER IF NOT EXISTS update_previews_updated_at AFTER UPDATE ON previews
BEGIN
  UPDATE previews SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Trigger to create default user quota
CREATE TRIGGER IF NOT EXISTS create_user_quota_on_signup AFTER INSERT ON users
BEGIN
  INSERT INTO user_quotas (user_id) VALUES (NEW.id);
END;

-- View: Chat statistics by project (SQLite syntax - uses SUM with CASE instead of FILTER)
CREATE VIEW IF NOT EXISTS chat_stats_by_project AS
SELECT
  project_id,
  COUNT(*) as total_messages,
  SUM(CASE WHEN role = 'user' THEN 1 ELSE 0 END) as user_messages,
  SUM(CASE WHEN role = 'assistant' THEN 1 ELSE 0 END) as assistant_messages,
  COALESCE(SUM(tokens_used), 0) as total_tokens,
  MIN(created_at) as first_message_at,
  MAX(created_at) as last_message_at
FROM chat_messages
WHERE is_deleted = 0
GROUP BY project_id;

-- Seed: Anonymous user for unauthenticated access (MVP mode)
INSERT OR IGNORE INTO users (id, email, name, plan, is_active)
VALUES ('00000000-0000-0000-0000-000000000000', 'anonymous@atlasengine.local', 'Anonymous User', 'free', 1);

-- Migration 002: settings_table
-- Settings table (key-value store)
CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_settings_updated ON settings(updated_at DESC);

-- Trigger for updated_at
CREATE TRIGGER IF NOT EXISTS update_settings_updated_at AFTER UPDATE ON settings
BEGIN
  UPDATE settings SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Migration 003: github_integration
-- GitHub integrations
CREATE TABLE IF NOT EXISTS github_integrations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  installation_id INTEGER UNIQUE NOT NULL,
  account_login TEXT NOT NULL,
  account_type TEXT NOT NULL,
  account_avatar_url TEXT,
  access_token_encrypted TEXT NOT NULL,
  token_expires_at TEXT NOT NULL,
  user_access_token_encrypted TEXT,
  repositories_accessible TEXT,
  permissions TEXT,
  events TEXT,
  is_active INTEGER DEFAULT 1,
  suspended_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_github_integrations_user ON github_integrations(user_id);
CREATE INDEX IF NOT EXISTS idx_github_integrations_installation ON github_integrations(installation_id);
CREATE INDEX IF NOT EXISTS idx_github_integrations_active ON github_integrations(is_active);

CREATE TRIGGER IF NOT EXISTS update_github_integrations_updated_at AFTER UPDATE ON github_integrations
BEGIN
  UPDATE github_integrations SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- GitHub sync events
CREATE TABLE IF NOT EXISTS github_sync_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  event_type TEXT NOT NULL,
  status TEXT NOT NULL,
  commit_sha TEXT,
  commit_message TEXT,
  branch TEXT DEFAULT 'main',
  files_changed TEXT,
  files_count INTEGER DEFAULT 0,
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  duration_ms INTEGER,
  metadata TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sync_events_project ON github_sync_events(project_id);
CREATE INDEX IF NOT EXISTS idx_sync_events_status ON github_sync_events(status);
CREATE INDEX IF NOT EXISTS idx_sync_events_direction ON github_sync_events(direction);
CREATE INDEX IF NOT EXISTS idx_sync_events_created ON github_sync_events(created_at DESC);

-- GitHub sync queue
CREATE TABLE IF NOT EXISTS github_sync_queue (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sync_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  commit_sha TEXT,
  commit_message TEXT,
  files_changed TEXT,
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_queue_project ON github_sync_queue(project_id);
CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON github_sync_queue(status);
CREATE INDEX IF NOT EXISTS idx_sync_queue_created ON github_sync_queue(created_at DESC);

-- Project columns for GitHub metadata
ALTER TABLE projects ADD COLUMN github_repo_id INTEGER;
ALTER TABLE projects ADD COLUMN github_repo_full_name TEXT;
ALTER TABLE projects ADD COLUMN github_installation_id INTEGER;
ALTER TABLE projects ADD COLUMN github_default_branch TEXT DEFAULT 'main';
ALTER TABLE projects ADD COLUMN github_clone_url TEXT;
ALTER TABLE projects ADD COLUMN github_last_sync_at TEXT;
ALTER TABLE projects ADD COLUMN github_sync_enabled INTEGER DEFAULT 0;
ALTER TABLE projects ADD COLUMN github_sync_status TEXT DEFAULT 'disabled';
ALTER TABLE projects ADD COLUMN github_repo_owner TEXT;
ALTER TABLE projects ADD COLUMN github_repo_name TEXT;
ALTER TABLE projects ADD COLUMN github_last_sync_sha TEXT;
ALTER TABLE projects ADD COLUMN github_webhook_id INTEGER;

-- Migration 004: atlas_hosting
-- Vercel project columns on projects
ALTER TABLE projects ADD COLUMN vercel_project_id TEXT;
ALTER TABLE projects ADD COLUMN vercel_project_name TEXT;
ALTER TABLE projects ADD COLUMN last_deployment_url TEXT;
ALTER TABLE projects ADD COLUMN last_deployment_at TEXT;

-- Publish attempts table
CREATE TABLE IF NOT EXISTS publish_attempts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  changeset_id TEXT,
  commit_hash TEXT,
  vercel_project_id TEXT,
  deployment_id TEXT,
  deployment_url TEXT,
  vercel_url TEXT,
  inspect_url TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  started_at TEXT,
  finished_at TEXT,
  logs TEXT,
  error_message TEXT,
  secrets_keys TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_publish_attempts_project ON publish_attempts(project_id);
CREATE INDEX IF NOT EXISTS idx_publish_attempts_status ON publish_attempts(status);
CREATE INDEX IF NOT EXISTS idx_publish_attempts_created ON publish_attempts(project_id, created_at DESC);

-- Production deployment pointer columns on projects
ALTER TABLE projects ADD COLUMN production_deployment_id TEXT;
ALTER TABLE projects ADD COLUMN production_commit_hash TEXT;
ALTER TABLE projects ADD COLUMN production_changeset_id TEXT;
ALTER TABLE projects ADD COLUMN production_url TEXT;
ALTER TABLE projects ADD COLUMN production_updated_at TEXT;

-- Migration 005: github_refresh_token
ALTER TABLE github_integrations ADD COLUMN refresh_token_encrypted TEXT;
ALTER TABLE github_integrations ADD COLUMN refresh_token_expires_at TEXT;

-- Migration 006: database_provisioning
ALTER TABLE projects ADD COLUMN database_name TEXT;
ALTER TABLE projects ADD COLUMN database_user TEXT;
ALTER TABLE projects ADD COLUMN database_url TEXT;
ALTER TABLE projects ADD COLUMN database_provisioned INTEGER DEFAULT 0;

-- Migration 007: project_secrets
CREATE TABLE IF NOT EXISTS project_secrets (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  is_secret INTEGER DEFAULT 1,
  environment TEXT DEFAULT 'production',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (project_id, key, environment)
);

CREATE INDEX IF NOT EXISTS idx_project_secrets_project ON project_secrets(project_id);
CREATE INDEX IF NOT EXISTS idx_project_secrets_environment ON project_secrets(project_id, environment);

-- Migration 008: actions_log
CREATE TABLE IF NOT EXISTS actions_log (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      changeset_id TEXT,
      action_type TEXT NOT NULL,
      action_status TEXT NOT NULL DEFAULT 'pending',
      input TEXT,
      output TEXT,
      error_message TEXT,
      triggered_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_actions_log_project ON actions_log(project_id);
    CREATE INDEX IF NOT EXISTS idx_actions_log_changeset ON actions_log(changeset_id);

-- Migration 009: review_usage_tracking
CREATE TABLE IF NOT EXISTS review_usage (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      changeset_id TEXT,
      review_type TEXT,
      review_id TEXT,
      provider_type TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost REAL NOT NULL DEFAULT 0,
      provider_native_cost REAL,
      cost_source TEXT,
      cost_is_approximate INTEGER NOT NULL DEFAULT 0,
      reviewed_at TEXT DEFAULT (datetime('now')),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_review_usage_project ON review_usage(project_id);
    CREATE INDEX IF NOT EXISTS idx_review_usage_reviewed_at ON review_usage(reviewed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_review_usage_review_identity
      ON review_usage(project_id, review_type, review_id, reviewed_at DESC);

-- Migration 011: branch_reviews
CREATE TABLE IF NOT EXISTS branch_reviews (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      display_id TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      merge_base_sha TEXT,
      fork_point_sha TEXT,
      head_sha TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      is_current INTEGER DEFAULT 0,
      file_count INTEGER DEFAULT 0,
      total_additions INTEGER DEFAULT 0,
      total_deletions INTEGER DEFAULT 0,
      commit_count INTEGER DEFAULT 0,
      first_commit_at TEXT,
      last_commit_at TEXT,
      review_status TEXT DEFAULT 'none',
      review_risk_level TEXT,
      review_summary TEXT,
      review_json TEXT,
      review_error TEXT,
      review_base_branch TEXT,
      review_merge_base_sha TEXT,
      review_fork_point_sha TEXT,
      review_head_sha TEXT,
      reviewed_at TEXT,
      base_branch_source TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_branch_reviews_project ON branch_reviews(project_id);
    CREATE INDEX IF NOT EXISTS idx_branch_reviews_branch ON branch_reviews(project_id, branch_name);
    CREATE INDEX IF NOT EXISTS idx_branch_reviews_current ON branch_reviews(project_id, is_current);
    CREATE INDEX IF NOT EXISTS idx_branch_reviews_status ON branch_reviews(status);

-- Migration 012: pr_reviews
CREATE TABLE IF NOT EXISTS pr_reviews (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      display_id TEXT NOT NULL,
      github_pr_number INTEGER NOT NULL,
      title TEXT,
      body TEXT,
      author_login TEXT,
      author_avatar_url TEXT,
      state TEXT NOT NULL DEFAULT 'open',
      head_branch TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      head_sha TEXT,
      base_sha TEXT,
      file_count INTEGER DEFAULT 0,
      total_additions INTEGER DEFAULT 0,
      total_deletions INTEGER DEFAULT 0,
      commit_count INTEGER DEFAULT 0,
      labels TEXT,
      html_url TEXT,
      assignees TEXT DEFAULT '[]',
      requested_reviewers TEXT DEFAULT '[]',
      reviewer_participants TEXT DEFAULT '[]',
      review_status TEXT DEFAULT 'none',
      review_risk_level TEXT,
      review_summary TEXT,
      review_error TEXT,
      review_json TEXT,
      review_head_sha TEXT,
      reviewed_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(project_id, github_pr_number)
    );

    CREATE INDEX IF NOT EXISTS idx_pr_reviews_project ON pr_reviews(project_id);
    CREATE INDEX IF NOT EXISTS idx_pr_reviews_state ON pr_reviews(project_id, state);

-- Migration 015: review_file_cache
CREATE TABLE IF NOT EXISTS review_file_cache (
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      context_type TEXT NOT NULL,
      cache_key TEXT NOT NULL,
      file_path TEXT NOT NULL,
      before_hash TEXT NOT NULL,
      after_hash TEXT NOT NULL,
      provider_type TEXT NOT NULL,
      provider_model TEXT NOT NULL,
      prompt_version TEXT NOT NULL,
      quality_mode TEXT NOT NULL DEFAULT 'v2',
      review_json TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      last_used_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (project_id, cache_key)
    );

    CREATE INDEX IF NOT EXISTS idx_review_file_cache_project_context
      ON review_file_cache(project_id, context_type);

    CREATE INDEX IF NOT EXISTS idx_review_file_cache_project_path
      ON review_file_cache(project_id, file_path);

-- Migration 016: trust_review_facts
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

    CREATE INDEX IF NOT EXISTS idx_trust_review_facts_project_completed
      ON trust_review_facts(project_id, completed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_trust_review_facts_project_type_completed
      ON trust_review_facts(project_id, review_type, completed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_trust_review_facts_project_provider
      ON trust_review_facts(project_id, provider_model, completed_at DESC);

-- Migration 017: trust_review_dimension_facts
CREATE TABLE IF NOT EXISTS trust_review_dimension_facts (
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

    CREATE INDEX IF NOT EXISTS idx_trust_review_dimension_facts_project_completed
      ON trust_review_dimension_facts(project_id, completed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_trust_review_dimension_facts_provider
      ON trust_review_dimension_facts(project_id, provider_model, completed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_trust_review_dimension_facts_language
      ON trust_review_dimension_facts(project_id, language, completed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_trust_review_dimension_facts_path
      ON trust_review_dimension_facts(project_id, path_pattern, completed_at DESC);

-- Migration 016: review_outcomes
CREATE TABLE IF NOT EXISTS review_outcomes (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      review_type TEXT NOT NULL,
      review_id TEXT NOT NULL,
      recommendation_key TEXT NOT NULL,
      status TEXT NOT NULL,
      note TEXT,
      provider_type TEXT,
      provider_model TEXT,
      language TEXT,
      path_pattern TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (project_id, review_type, review_id, recommendation_key)
    );

    CREATE INDEX IF NOT EXISTS idx_review_outcomes_project_scope
      ON review_outcomes(project_id, review_type, review_id);

    CREATE INDEX IF NOT EXISTS idx_review_outcomes_scope_updated
      ON review_outcomes(project_id, review_type, review_id, updated_at DESC);

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

-- Migration 018: review_outcomes_sqlite_constraints
CREATE TRIGGER IF NOT EXISTS trg_review_outcomes_validate_insert
    BEFORE INSERT ON review_outcomes
    FOR EACH ROW
    WHEN NEW.review_type NOT IN ('changeset', 'branch_review', 'pr_review')
      OR NEW.status NOT IN ('addressed', 'dismissed')
    BEGIN
      SELECT RAISE(ABORT, 'review_outcomes constraint violation');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_review_outcomes_validate_update
    BEFORE UPDATE ON review_outcomes
    FOR EACH ROW
    WHEN NEW.review_type NOT IN ('changeset', 'branch_review', 'pr_review')
      OR NEW.status NOT IN ('addressed', 'dismissed')
    BEGIN
      SELECT RAISE(ABORT, 'review_outcomes constraint violation');
    END;

-- Migration 019: review_publications
CREATE TABLE IF NOT EXISTS review_publications (
  project_id TEXT NOT NULL,
  review_type TEXT NOT NULL,
  review_id TEXT NOT NULL,
  recommendation_key TEXT NOT NULL,
  channel TEXT NOT NULL,
  action TEXT NOT NULL,
  github_review_id TEXT,
  github_pr_number INTEGER,
  head_sha TEXT,
  file_path TEXT,
  line INTEGER,
  published_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, review_type, review_id, recommendation_key, channel)
);

CREATE INDEX IF NOT EXISTS idx_review_publications_scope
  ON review_publications(project_id, review_type, review_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_publications_scope_head
  ON review_publications(project_id, review_type, review_id, head_sha, channel);

-- Migration 020: supabase_integration
-- Supabase integrations (one per user)
CREATE TABLE IF NOT EXISTS supabase_integrations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  token_expires_at TEXT NOT NULL,
  account_email TEXT,
  organizations TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_supabase_integrations_user
  ON supabase_integrations(user_id) WHERE is_active = 1;

CREATE TRIGGER IF NOT EXISTS update_supabase_integrations_updated_at AFTER UPDATE ON supabase_integrations
BEGIN
  UPDATE supabase_integrations SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Supabase project links (one per AtlasEngine project)
CREATE TABLE IF NOT EXISTS supabase_project_links (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  supabase_project_ref TEXT NOT NULL,
  supabase_project_name TEXT NOT NULL,
  supabase_org_id TEXT,
  region TEXT,
  database_url_encrypted TEXT,
  anon_key TEXT,
  service_role_key_encrypted TEXT,
  supabase_url TEXT NOT NULL,
  provisioned_by TEXT NOT NULL DEFAULT 'linked',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_supabase_project_links_project
  ON supabase_project_links(project_id);

CREATE TRIGGER IF NOT EXISTS update_supabase_project_links_updated_at AFTER UPDATE ON supabase_project_links
BEGIN
  UPDATE supabase_project_links SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Migration 021: review_cloud_sync
CREATE TABLE IF NOT EXISTS review_sync_sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL UNIQUE,
  device_label TEXT,
  auth_token_hash TEXT NOT NULL UNIQUE,
  last_seen_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_review_sync_sessions_user
  ON review_sync_sessions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_sync_sessions_active
  ON review_sync_sessions(revoked_at, last_seen_at DESC);

CREATE TRIGGER IF NOT EXISTS update_review_sync_sessions_updated_at AFTER UPDATE ON review_sync_sessions
BEGIN
  UPDATE review_sync_sessions SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS review_sync_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  device_id TEXT,
  project_id TEXT,
  project_name TEXT,
  project_path TEXT,
  review_type TEXT NOT NULL,
  review_id TEXT NOT NULL,
  recommendation_key TEXT,
  event_type TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  sync_error TEXT,
  sync_attempt_count INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT,
  event_idempotency_key TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_sync_events_user_idempotency
  ON review_sync_events(user_id, event_idempotency_key);

CREATE INDEX IF NOT EXISTS idx_review_sync_events_status_occurred
  ON review_sync_events(sync_status, occurred_at ASC);

CREATE INDEX IF NOT EXISTS idx_review_sync_events_user_occurred
  ON review_sync_events(user_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_sync_events_scope_occurred
  ON review_sync_events(user_id, review_type, review_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_sync_events_recommendation
  ON review_sync_events(user_id, review_type, review_id, recommendation_key, occurred_at DESC);

CREATE TRIGGER IF NOT EXISTS update_review_sync_events_updated_at AFTER UPDATE ON review_sync_events
BEGIN
  UPDATE review_sync_events SET updated_at = datetime('now') WHERE id = NEW.id;
END;

`;

export const up = {
  postgres: postgresSQL,
  sqlite: sqliteSQL,
};

export default {
  version,
  name,
  up,
};
