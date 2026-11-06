-- Migration 007: Project Secrets
-- Adds table for storing project environment variables and secrets
-- Created: 2026-01-26

-- ============================================================================
-- 1. PROJECT_SECRETS TABLE
-- Stores environment variables and secrets per project
-- ============================================================================

CREATE TABLE IF NOT EXISTS project_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,

  -- Secret key/value pair
  key VARCHAR(255) NOT NULL,                       -- Environment variable name (e.g., DATABASE_URL)
  value TEXT NOT NULL,                             -- The secret value (encrypted in application layer for Phase 2)

  -- Metadata
  is_secret BOOLEAN DEFAULT true,                  -- If true, value is masked in UI
  environment VARCHAR(50) DEFAULT 'production',   -- Environment scope (production, preview, development)

  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  -- Constraints
  CONSTRAINT unique_project_key_env UNIQUE (project_id, key, environment)
);

-- ============================================================================
-- 2. INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_project_secrets_project ON project_secrets(project_id);
CREATE INDEX IF NOT EXISTS idx_project_secrets_environment ON project_secrets(project_id, environment);

-- ============================================================================
-- 3. UPDATED_AT TRIGGER
-- ============================================================================

CREATE OR REPLACE FUNCTION update_project_secrets_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_project_secrets_updated_at ON project_secrets;
CREATE TRIGGER trigger_project_secrets_updated_at
  BEFORE UPDATE ON project_secrets
  FOR EACH ROW
  EXECUTE FUNCTION update_project_secrets_updated_at();

-- ============================================================================
-- 4. COMMENTS
-- ============================================================================

COMMENT ON TABLE project_secrets IS 'Environment variables and secrets for each project';
COMMENT ON COLUMN project_secrets.key IS 'Environment variable name (e.g., DATABASE_URL, API_KEY)';
COMMENT ON COLUMN project_secrets.value IS 'The secret value - encrypted in application layer for production';
COMMENT ON COLUMN project_secrets.is_secret IS 'If true, value is masked in UI (show as dots)';
COMMENT ON COLUMN project_secrets.environment IS 'Environment scope: production, preview, or development';

-- ============================================================================
-- 5. UPDATE SCHEMA VERSION
-- ============================================================================

INSERT INTO schema_version (version, description, applied_at)
VALUES (7, 'Project Secrets - Add environment variables and secrets table', NOW())
ON CONFLICT (version) DO NOTHING;
