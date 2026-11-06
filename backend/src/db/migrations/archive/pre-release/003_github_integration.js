/**
 * Migration 003: GitHub Integration (App + Desktop OAuth)
 *
 * Adds tables and columns required for GitHub connection and sync features.
 * Includes support for desktop device-flow tokens (stored as user_access_token_encrypted).
 */

export const version = 3;
export const name = 'github_integration';

// PostgreSQL schema
const postgresSQL = `
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
`;

// SQLite schema
const sqliteSQL = `
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
`;

export const up = {
  postgres: postgresSQL,
  sqlite: sqliteSQL
};

export default {
  version,
  name,
  up
};
