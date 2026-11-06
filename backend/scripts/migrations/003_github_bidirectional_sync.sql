-- Migration 003: GitHub Bidirectional Sync
-- Adds support for Lovable-style automatic bidirectional sync between AtlasEngine and GitHub
-- Created: 2025-11-04

BEGIN;

-- ============================================================================
-- PART 1: Update projects table with sync-related columns
-- ============================================================================

-- Repository linking
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_repo_owner TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_repo_name TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_default_branch TEXT DEFAULT 'main';

-- Sync tracking
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_last_sync_sha TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_last_sync_at TIMESTAMP;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_sync_status TEXT DEFAULT 'idle'
  CHECK (github_sync_status IN ('idle', 'syncing', 'error', 'conflict'));

-- Webhook
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_webhook_id INTEGER;

-- Add comments for documentation
COMMENT ON COLUMN projects.github_repo_owner IS 'GitHub repository owner (user/org)';
COMMENT ON COLUMN projects.github_repo_name IS 'GitHub repository name';
COMMENT ON COLUMN projects.github_default_branch IS 'Default branch to sync (main/master)';
COMMENT ON COLUMN projects.github_last_sync_sha IS 'Last synced commit SHA';
COMMENT ON COLUMN projects.github_last_sync_at IS 'Timestamp of last successful sync';
COMMENT ON COLUMN projects.github_sync_status IS 'Current sync status: idle, syncing, error, conflict';
COMMENT ON COLUMN projects.github_webhook_id IS 'GitHub webhook ID for this repository';

-- ============================================================================
-- PART 2: Create github_sync_queue table
-- ============================================================================

CREATE TABLE IF NOT EXISTS github_sync_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Sync operation
  sync_type TEXT NOT NULL CHECK (sync_type IN ('push', 'pull')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),

  -- Commit information
  commit_sha TEXT,
  commit_message TEXT,
  files_changed JSONB,  -- Array of file paths: ["src/App.tsx", "package.json"]

  -- Error handling
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,

  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  started_at TIMESTAMP,
  completed_at TIMESTAMP
);

-- Add indexes for query performance
CREATE INDEX IF NOT EXISTS idx_sync_queue_project ON github_sync_queue(project_id);
CREATE INDEX IF NOT EXISTS idx_sync_queue_status ON github_sync_queue(status);
CREATE INDEX IF NOT EXISTS idx_sync_queue_created ON github_sync_queue(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sync_queue_pending ON github_sync_queue(project_id, status) WHERE status = 'pending';

-- Add comments for documentation
COMMENT ON TABLE github_sync_queue IS 'Queue for managing GitHub sync operations (push/pull)';
COMMENT ON COLUMN github_sync_queue.sync_type IS 'Type of sync: push (AtlasEngine → GitHub) or pull (GitHub → AtlasEngine)';
COMMENT ON COLUMN github_sync_queue.status IS 'Current status: pending, processing, completed, failed';
COMMENT ON COLUMN github_sync_queue.commit_sha IS 'Git commit SHA associated with this sync';
COMMENT ON COLUMN github_sync_queue.commit_message IS 'Commit message for push operations';
COMMENT ON COLUMN github_sync_queue.files_changed IS 'JSON array of file paths that changed';
COMMENT ON COLUMN github_sync_queue.error_message IS 'Error message if sync failed';
COMMENT ON COLUMN github_sync_queue.retry_count IS 'Number of retry attempts (max 3)';

-- ============================================================================
-- PART 3: Create helper views for monitoring
-- ============================================================================

-- View: Active sync operations
CREATE OR REPLACE VIEW active_syncs AS
SELECT
  q.id AS sync_id,
  q.project_id,
  p.name AS project_name,
  q.sync_type,
  q.status,
  q.retry_count,
  q.created_at,
  q.started_at,
  EXTRACT(EPOCH FROM (NOW() - q.created_at)) AS age_seconds
FROM github_sync_queue q
JOIN projects p ON q.project_id = p.id
WHERE q.status IN ('pending', 'processing')
ORDER BY q.created_at ASC;

COMMENT ON VIEW active_syncs IS 'Currently active (pending or processing) sync operations';

-- View: Sync queue health
CREATE OR REPLACE VIEW sync_queue_health AS
SELECT
  COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
  COUNT(*) FILTER (WHERE status = 'processing') AS processing_count,
  COUNT(*) FILTER (WHERE status = 'failed' AND created_at > NOW() - INTERVAL '1 hour') AS failed_last_hour,
  COUNT(*) FILTER (WHERE status = 'completed' AND completed_at > NOW() - INTERVAL '1 hour') AS completed_last_hour,
  AVG(EXTRACT(EPOCH FROM (completed_at - created_at))) FILTER (WHERE status = 'completed' AND completed_at > NOW() - INTERVAL '1 hour') AS avg_processing_time_seconds
FROM github_sync_queue;

COMMENT ON VIEW sync_queue_health IS 'Health metrics for the GitHub sync queue';

-- View: Projects with sync enabled
CREATE OR REPLACE VIEW synced_projects AS
SELECT
  p.id,
  p.name,
  p.github_repo_owner || '/' || p.github_repo_name AS repo_full_name,
  p.github_default_branch,
  p.github_sync_status,
  p.github_last_sync_at,
  p.github_last_sync_sha,
  EXTRACT(EPOCH FROM (NOW() - p.github_last_sync_at)) / 60 AS minutes_since_last_sync
FROM projects p
WHERE p.github_repo_name IS NOT NULL
  AND p.github_sync_enabled = TRUE
ORDER BY p.github_last_sync_at DESC NULLS LAST;

COMMENT ON VIEW synced_projects IS 'All projects with GitHub sync enabled';

-- ============================================================================
-- PART 4: Cleanup function for old completed/failed sync jobs
-- ============================================================================

CREATE OR REPLACE FUNCTION cleanup_old_sync_jobs()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
  deleted_failed INTEGER;
BEGIN
  -- Delete completed jobs older than 7 days
  DELETE FROM github_sync_queue
  WHERE status = 'completed'
    AND completed_at < NOW() - INTERVAL '7 days';

  GET DIAGNOSTICS deleted_count = ROW_COUNT;

  -- Delete failed jobs older than 30 days
  DELETE FROM github_sync_queue
  WHERE status = 'failed'
    AND completed_at < NOW() - INTERVAL '30 days';

  GET DIAGNOSTICS deleted_failed = ROW_COUNT;

  RETURN deleted_count + deleted_failed;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION cleanup_old_sync_jobs() IS 'Cleanup old completed (7d+) and failed (30d+) sync jobs. Returns count of deleted rows.';

-- ============================================================================
-- PART 5: Automatic retry for failed syncs (optional - can be disabled)
-- ============================================================================

-- Automatically retry failed syncs that haven't exceeded retry limit
CREATE OR REPLACE FUNCTION auto_retry_failed_syncs()
RETURNS INTEGER AS $$
DECLARE
  retried_count INTEGER;
BEGIN
  -- Reset failed jobs to pending if retry_count < 3 and failed more than 5 minutes ago
  UPDATE github_sync_queue
  SET status = 'pending',
      retry_count = retry_count + 1,
      error_message = NULL,
      completed_at = NULL
  WHERE status = 'failed'
    AND retry_count < 3
    AND completed_at < NOW() - INTERVAL '5 minutes';

  GET DIAGNOSTICS retried_count = ROW_COUNT;

  RETURN retried_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION auto_retry_failed_syncs() IS 'Automatically retry failed syncs (max 3 attempts, 5 min cooldown). Returns count of retried jobs.';

COMMIT;

-- ============================================================================
-- Migration complete!
-- ============================================================================
--
-- Summary of changes:
-- 1. Added 7 new columns to projects table for sync tracking
-- 2. Created github_sync_queue table with indexes
-- 3. Created 3 monitoring views (active_syncs, sync_queue_health, synced_projects)
-- 4. Added cleanup_old_sync_jobs() function
-- 5. Added auto_retry_failed_syncs() function (optional)
--
-- Next steps:
-- 1. Update clone endpoint to populate github_repo_owner, github_repo_name, github_default_branch
-- 2. Implement SyncWorker service to process queue
-- 3. Update file save endpoint to queue push syncs
-- 4. Implement webhook handler to queue pull syncs
--
-- ============================================================================
