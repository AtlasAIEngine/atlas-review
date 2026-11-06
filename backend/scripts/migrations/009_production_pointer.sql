-- Migration 009: Production Deployment Pointer
-- Adds production pointer columns to track which deployment is currently live
-- Created: 2026-01-26

-- ============================================================================
-- 1. UPDATE PROJECTS TABLE
-- Add production deployment pointer columns
-- ============================================================================

ALTER TABLE projects
ADD COLUMN IF NOT EXISTS production_deployment_id UUID REFERENCES publish_attempts(id),
ADD COLUMN IF NOT EXISTS production_commit_hash VARCHAR(40),
ADD COLUMN IF NOT EXISTS production_changeset_id VARCHAR(100),
ADD COLUMN IF NOT EXISTS production_url VARCHAR(500),
ADD COLUMN IF NOT EXISTS production_updated_at TIMESTAMP;

-- Comments for production pointer columns
COMMENT ON COLUMN projects.production_deployment_id IS 'Reference to the publish attempt currently marked as production';
COMMENT ON COLUMN projects.production_commit_hash IS 'Git commit hash of the current production deployment';
COMMENT ON COLUMN projects.production_changeset_id IS 'ChangeSet ID of the current production deployment';
COMMENT ON COLUMN projects.production_url IS 'URL of the current production deployment';
COMMENT ON COLUMN projects.production_updated_at IS 'When the production pointer was last updated';

-- ============================================================================
-- 2. UPDATE SCHEMA VERSION
-- ============================================================================

INSERT INTO schema_version (version, description, applied_at)
VALUES (9, 'Production Deployment Pointer - Add production tracking columns', NOW())
ON CONFLICT (version) DO NOTHING;
