-- Migration 006: Atlas Hosting
-- Adds tables and columns for Atlas Hosting deployment via Vercel
-- Created: 2026-01-22

-- ============================================================================
-- 1. UPDATE PROJECTS TABLE
-- Add Atlas Hosting related columns
-- ============================================================================

ALTER TABLE projects
ADD COLUMN IF NOT EXISTS vercel_project_id VARCHAR(255),
ADD COLUMN IF NOT EXISTS vercel_project_name VARCHAR(255),
ADD COLUMN IF NOT EXISTS last_deployment_url VARCHAR(500),
ADD COLUMN IF NOT EXISTS last_deployment_at TIMESTAMP;

-- Comments for projects columns
COMMENT ON COLUMN projects.vercel_project_id IS 'Vercel project ID for Atlas Hosting deployments';
COMMENT ON COLUMN projects.vercel_project_name IS 'Vercel project name (subdomain prefix)';
COMMENT ON COLUMN projects.last_deployment_url IS 'URL of the most recent successful deployment';
COMMENT ON COLUMN projects.last_deployment_at IS 'Timestamp of the most recent successful deployment';

-- ============================================================================
-- 2. PUBLISH_ATTEMPTS TABLE
-- Tracks all publish attempts through Atlas Hosting
-- ============================================================================

CREATE TABLE IF NOT EXISTS publish_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Changeset and Git Information
  changeset_id VARCHAR(100),                    -- ChangeSet ID being published
  commit_hash VARCHAR(40),                      -- Git commit hash being deployed

  -- Vercel Information
  vercel_project_id VARCHAR(255),               -- Vercel project ID used
  deployment_id VARCHAR(255),                   -- Vercel deployment ID
  deployment_url VARCHAR(500),                  -- Final deployment URL

  -- Status Tracking
  status VARCHAR(20) NOT NULL DEFAULT 'queued'  -- queued, running, succeeded, failed, canceled
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),

  -- Timing
  started_at TIMESTAMP,                         -- When deployment started
  finished_at TIMESTAMP,                        -- When deployment finished

  -- Output
  logs TEXT,                                    -- Streaming logs from deployment
  error_message TEXT,                           -- Error message if failed

  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for publish_attempts
CREATE INDEX IF NOT EXISTS idx_publish_attempts_project ON publish_attempts(project_id);
CREATE INDEX IF NOT EXISTS idx_publish_attempts_status ON publish_attempts(status);
CREATE INDEX IF NOT EXISTS idx_publish_attempts_created ON publish_attempts(project_id, created_at DESC);

-- Comments
COMMENT ON TABLE publish_attempts IS 'Tracks all Atlas Hosting deployment attempts';
COMMENT ON COLUMN publish_attempts.changeset_id IS 'Reference to the ChangeSet being deployed';
COMMENT ON COLUMN publish_attempts.status IS 'Current status: queued, running, succeeded, failed, canceled';
COMMENT ON COLUMN publish_attempts.logs IS 'Streaming deployment logs (truncated if too large)';

-- ============================================================================
-- 3. UPDATE SCHEMA VERSION
-- ============================================================================

INSERT INTO schema_version (version, description, applied_at)
VALUES (6, 'Atlas Hosting - Add Vercel deployment tables and columns', NOW())
ON CONFLICT (version) DO NOTHING;
