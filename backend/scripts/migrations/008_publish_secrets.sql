-- Migration 008: Publish Secrets Tracking
-- Adds column to track which secrets were synced during each deployment
-- Created: 2026-01-26

-- ============================================================================
-- 1. ADD SECRETS_KEYS COLUMN TO PUBLISH_ATTEMPTS
-- Array of secret keys synced during this deployment
-- ============================================================================

ALTER TABLE publish_attempts
ADD COLUMN IF NOT EXISTS secrets_keys TEXT[] DEFAULT '{}';

-- Comment for the new column
COMMENT ON COLUMN publish_attempts.secrets_keys IS 'Array of secret keys synced during this deployment';

-- ============================================================================
-- 2. UPDATE SCHEMA VERSION
-- ============================================================================

INSERT INTO schema_version (version, description, applied_at)
VALUES (8, 'Publish Secrets - Track which secrets were synced per deployment', NOW())
ON CONFLICT (version) DO NOTHING;
