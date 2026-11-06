/**
 * Migration 004: Add GitHub identity columns to users table
 *
 * Allows linking guest users (from review sync) to their GitHub identity.
 * When a desktop app connects GitHub, the user's github_login is set,
 * enabling GitHub OAuth login on the admin dashboard.
 */

export const version = 4;
export const name = 'user_github_identity';

export const up = {
  postgres: `
ALTER TABLE users ADD COLUMN IF NOT EXISTS github_login TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS github_avatar_url TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_login ON users(github_login) WHERE github_login IS NOT NULL;
`,
  sqlite: `
ALTER TABLE users ADD COLUMN github_login TEXT;
ALTER TABLE users ADD COLUMN github_avatar_url TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_github_login ON users(github_login);
`,
};

export default {
  version,
  name,
  up,
};
