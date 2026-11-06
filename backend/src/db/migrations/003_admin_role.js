/**
 * Migration 003: Add admin role to users table
 *
 * Adds is_admin boolean column for admin dashboard access control.
 */

export const version = 3;
export const name = 'admin_role';

export const up = {
  postgres: `
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_users_admin ON users(is_admin) WHERE is_admin = TRUE;
`,
  sqlite: `
ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_users_admin ON users(is_admin);
`,
};

export default {
  version,
  name,
  up,
};
