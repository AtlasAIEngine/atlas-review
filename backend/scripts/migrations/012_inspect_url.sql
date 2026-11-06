-- Migration 012: Add inspect_url column for Vercel logs access
-- The inspect URL provides direct access to deployment logs in Vercel dashboard

ALTER TABLE publish_attempts
ADD COLUMN IF NOT EXISTS inspect_url VARCHAR(500);

-- Comment: inspect_url stores the full Vercel inspect URL
-- Format: https://vercel.com/{team}/{project}/{deploymentId}
