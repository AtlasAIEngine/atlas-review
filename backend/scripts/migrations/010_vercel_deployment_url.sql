-- Migration 010: Add vercel_url column for unique deployment URL
-- The deployment_url currently stores the custom domain (alias), which is the same for all deployments.
-- We need to store the unique Vercel deployment URL for each deployment to enable rollback.

ALTER TABLE publish_attempts
ADD COLUMN IF NOT EXISTS vercel_url VARCHAR(500);

-- Comment explaining the columns:
-- deployment_url: The custom domain alias (e.g., https://app-abc123.atlasengine.dev) - same for all deployments of a project
-- vercel_url: The unique immutable Vercel URL (e.g., https://project-abc123-team.vercel.app) - unique per deployment
-- deployment_id: The Vercel deployment ID (e.g., dpl_xxx) - unique per deployment
