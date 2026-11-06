-- Migration 002: GitHub Integration
-- Adds tables and columns for GitHub App integration and repository synchronization
-- Created: 2025-11-03

-- ============================================================================
-- 1. GITHUB INTEGRATIONS TABLE
-- Stores GitHub App installations and authentication tokens per user
-- ============================================================================

CREATE TABLE IF NOT EXISTS github_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

  -- GitHub App Installation Details
  installation_id BIGINT UNIQUE NOT NULL,       -- GitHub's installation ID
  account_login TEXT NOT NULL,                  -- GitHub username or org name
  account_type TEXT NOT NULL CHECK (account_type IN ('User', 'Organization')),
  account_avatar_url TEXT,                      -- Profile/org avatar

  -- Authentication
  access_token_encrypted TEXT NOT NULL,         -- Encrypted installation access token
  token_expires_at TIMESTAMPTZ NOT NULL,        -- Token expiration (1 hour from issue)

  -- Cached Metadata
  repositories_accessible JSONB,                -- Array of accessible repo objects
  permissions JSONB,                            -- Granted permissions
  events JSONB,                                 -- Subscribed webhook events

  -- Status
  is_active BOOLEAN DEFAULT TRUE,               -- Installation still active
  suspended_at TIMESTAMPTZ,                     -- If suspended by user/GitHub

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for github_integrations
CREATE INDEX idx_github_integrations_user ON github_integrations(user_id);
CREATE INDEX idx_github_integrations_installation ON github_integrations(installation_id);
CREATE INDEX idx_github_integrations_active ON github_integrations(is_active) WHERE is_active = TRUE;

-- Auto-update timestamp trigger
CREATE TRIGGER update_github_integrations_updated_at
  BEFORE UPDATE ON github_integrations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ============================================================================
-- 2. GITHUB SYNC EVENTS TABLE
-- Tracks all synchronization events between AtlasEngine and GitHub
-- ============================================================================

CREATE TABLE IF NOT EXISTS github_sync_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Event Details
  direction TEXT NOT NULL CHECK (direction IN ('to_github', 'from_github')),
  event_type TEXT NOT NULL,                     -- 'commit', 'push', 'pull', 'conflict', 'webhook'
  status TEXT NOT NULL CHECK (status IN ('pending', 'in_progress', 'success', 'failed')),

  -- Git Information
  commit_sha TEXT,                              -- Git commit SHA
  commit_message TEXT,                          -- Commit message
  branch TEXT DEFAULT 'main',                   -- Branch name

  -- Changed Files
  files_changed JSONB,                          -- Array of file paths with actions
  files_count INT DEFAULT 0,                    -- Number of files changed

  -- Error Handling
  error_message TEXT,                           -- Error details if failed
  retry_count INT DEFAULT 0,                    -- Number of retry attempts

  -- Performance Metrics
  duration_ms INT,                              -- Time taken in milliseconds

  -- Additional Data
  metadata JSONB,                               -- Webhook payload or other context

  -- Timestamps
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for github_sync_events
CREATE INDEX idx_sync_events_project ON github_sync_events(project_id);
CREATE INDEX idx_sync_events_status ON github_sync_events(status);
CREATE INDEX idx_sync_events_direction ON github_sync_events(direction);
CREATE INDEX idx_sync_events_type ON github_sync_events(event_type);
CREATE INDEX idx_sync_events_created ON github_sync_events(created_at DESC);

-- Composite index for querying project sync history
CREATE INDEX idx_sync_events_project_created ON github_sync_events(project_id, created_at DESC);

-- ============================================================================
-- 3. UPDATE PROJECTS TABLE
-- Add GitHub-related columns to existing projects table
-- ============================================================================

ALTER TABLE projects
ADD COLUMN IF NOT EXISTS github_repo_id BIGINT,               -- GitHub's numeric repository ID
ADD COLUMN IF NOT EXISTS github_repo_full_name TEXT,          -- 'owner/repo' format
ADD COLUMN IF NOT EXISTS github_installation_id BIGINT,       -- Links to github_integrations.installation_id
ADD COLUMN IF NOT EXISTS github_default_branch TEXT DEFAULT 'main',
ADD COLUMN IF NOT EXISTS github_clone_url TEXT,               -- Git clone URL
ADD COLUMN IF NOT EXISTS github_last_sync_at TIMESTAMPTZ,     -- Last successful sync timestamp
ADD COLUMN IF NOT EXISTS github_sync_enabled BOOLEAN DEFAULT FALSE,  -- Auto-sync on/off
ADD COLUMN IF NOT EXISTS github_sync_status TEXT CHECK (github_sync_status IN ('synced', 'syncing', 'conflict', 'error', 'disabled')) DEFAULT 'disabled';

-- Indexes for projects GitHub columns
CREATE INDEX IF NOT EXISTS idx_projects_github_repo ON projects(github_repo_id);
CREATE INDEX IF NOT EXISTS idx_projects_github_sync ON projects(github_sync_enabled) WHERE github_sync_enabled = TRUE;
CREATE INDEX IF NOT EXISTS idx_projects_github_installation ON projects(github_installation_id);

-- ============================================================================
-- 4. HELPER VIEWS
-- Useful views for querying GitHub sync status
-- ============================================================================

-- View: Active GitHub integrations with repository count
CREATE OR REPLACE VIEW github_integrations_summary AS
SELECT
  gi.id,
  gi.user_id,
  gi.installation_id,
  gi.account_login,
  gi.account_type,
  gi.is_active,
  gi.token_expires_at,
  JSONB_ARRAY_LENGTH(COALESCE(gi.repositories_accessible, '[]'::JSONB)) as repos_count,
  COUNT(p.id) as connected_projects_count,
  gi.created_at,
  gi.updated_at
FROM github_integrations gi
LEFT JOIN projects p ON p.github_installation_id = gi.installation_id
GROUP BY gi.id;

-- View: Project sync health
CREATE OR REPLACE VIEW project_sync_health AS
SELECT
  p.id as project_id,
  p.name as project_name,
  p.github_repo_full_name,
  p.github_sync_enabled,
  p.github_sync_status,
  p.github_last_sync_at,
  -- Recent sync stats
  COUNT(gse.id) FILTER (WHERE gse.created_at > NOW() - INTERVAL '24 hours') as syncs_last_24h,
  COUNT(gse.id) FILTER (WHERE gse.status = 'failed' AND gse.created_at > NOW() - INTERVAL '24 hours') as failed_syncs_24h,
  COUNT(gse.id) FILTER (WHERE gse.status = 'success' AND gse.created_at > NOW() - INTERVAL '24 hours') as successful_syncs_24h,
  -- Last sync event
  (SELECT gse2.status FROM github_sync_events gse2 WHERE gse2.project_id = p.id ORDER BY gse2.created_at DESC LIMIT 1) as last_sync_status,
  (SELECT gse2.created_at FROM github_sync_events gse2 WHERE gse2.project_id = p.id ORDER BY gse2.created_at DESC LIMIT 1) as last_sync_time
FROM projects p
LEFT JOIN github_sync_events gse ON gse.project_id = p.id
WHERE p.github_sync_enabled = TRUE
GROUP BY p.id;

-- ============================================================================
-- 5. COMMENTS (for documentation)
-- ============================================================================

COMMENT ON TABLE github_integrations IS 'Stores GitHub App installations and OAuth tokens per user';
COMMENT ON COLUMN github_integrations.installation_id IS 'GitHub App installation ID (unique per user/org)';
COMMENT ON COLUMN github_integrations.access_token_encrypted IS 'AES-256 encrypted installation access token';
COMMENT ON COLUMN github_integrations.token_expires_at IS 'Installation tokens expire after 1 hour';

COMMENT ON TABLE github_sync_events IS 'Audit log of all sync operations between AtlasEngine and GitHub';
COMMENT ON COLUMN github_sync_events.direction IS 'to_github = local changes pushed, from_github = remote changes pulled';
COMMENT ON COLUMN github_sync_events.event_type IS 'Type of sync: commit, push, pull, conflict, webhook';

COMMENT ON COLUMN projects.github_repo_id IS 'GitHub repository ID (numeric, from GitHub API)';
COMMENT ON COLUMN projects.github_repo_full_name IS 'Repository in owner/repo format';
COMMENT ON COLUMN projects.github_sync_enabled IS 'Whether auto-sync is enabled for this project';
COMMENT ON COLUMN projects.github_sync_status IS 'Current sync status: synced, syncing, conflict, error, disabled';

-- ============================================================================
-- 6. UPDATE SCHEMA VERSION
-- ============================================================================

INSERT INTO schema_version (version, description, applied_at)
VALUES (2, 'GitHub Integration - Add tables for GitHub App auth and repository sync', NOW())
ON CONFLICT (version) DO NOTHING;
