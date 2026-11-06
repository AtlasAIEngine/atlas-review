/**
 * Migration 009: Add github_user_id + tighten github identity columns on users
 *
 * Migration 004 already added `github_login` and `github_avatar_url`, but the
 * original UNIQUE constraint was placed on `github_login`. GitHub logins can
 * be renamed, so the durable identity is `github_user_id` (the numeric
 * `id` from the REST API). This migration:
 *
 *   - Adds `github_user_id BIGINT` (idempotent)
 *   - Also adds `github_login` / `github_avatar_url` defensively in case the
 *     database predates migration 004 for any reason.
 *   - Creates a partial UNIQUE INDEX on (github_user_id) WHERE NOT NULL so
 *     merge-on-conflict can locate an existing linked user row.
 */

export const version = 9;
export const name = 'users_github_identity';

export const up = {
  postgres: `
ALTER TABLE users ADD COLUMN IF NOT EXISTS github_login TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS github_avatar_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS github_user_id BIGINT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_user_id
  ON users(github_user_id)
  WHERE github_user_id IS NOT NULL;
`,
  // Migration 004 already added `github_login` and `github_avatar_url` on
  // SQLite. Adding them again errors ("duplicate column name") even though
  // the migration runner's fallback papers over it. Only add the truly new
  // column here so existing local desktop installs upgrade cleanly.
  sqlite: `
ALTER TABLE users ADD COLUMN github_user_id INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_user_id
  ON users(github_user_id)
  WHERE github_user_id IS NOT NULL;
`,
};

export default {
  version,
  name,
  up,
};
