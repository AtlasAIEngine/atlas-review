/**
 * Migration 006: Backfill users from review_sync_sessions
 *
 * Existing desktop installs created sync sessions but not user rows.
 * This creates a users row for each unique user_id in review_sync_sessions
 * that doesn't already exist in users.
 *
 * When these users update to the new build, issueGuestSession will match
 * the existing user row via ON CONFLICT and just work.
 */

export const version = 6;
export const name = 'backfill_sync_users';

export const up = {
  postgres: `
INSERT INTO users (id, email, name, plan, is_active)
SELECT
  s.user_id::uuid,
  'guest-' || LEFT(s.user_id, 8) || '@device.atlasengine.local',
  COALESCE(MAX(NULLIF(s.device_label, '')), 'Device ' || LEFT(MAX(s.device_id), 8)),
  'free',
  TRUE
FROM review_sync_sessions s
WHERE s.user_id IS NOT NULL
GROUP BY s.user_id
ON CONFLICT (id) DO NOTHING;
`,
  sqlite: `
INSERT OR IGNORE INTO users (id, email, name, plan, is_active)
SELECT
  s.user_id,
  'guest-' || substr(s.user_id, 1, 8) || '@device.atlasengine.local',
  COALESCE(s.device_label, 'Device ' || substr(s.device_id, 1, 8)),
  'free',
  1
FROM review_sync_sessions s
WHERE s.user_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.user_id)
GROUP BY s.user_id;
`,
};

export default {
  version,
  name,
  up,
};
