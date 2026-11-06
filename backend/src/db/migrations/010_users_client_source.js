/**
 * Migration 010: tag users and sync sessions with their originating client
 *
 * Adds a `client_source` column to `users` and `review_sync_sessions` so the
 * admin dashboard can distinguish guests created from the desktop (Tauri) app
 * from browser-based local-dev testing. Allowed values at the application
 * layer: 'desktop', 'browser', 'unknown'. Legacy rows stay NULL.
 */

export const version = 10;
export const name = 'users_client_source';

export const up = {
  postgres: `
ALTER TABLE users ADD COLUMN IF NOT EXISTS client_source TEXT;
ALTER TABLE review_sync_sessions ADD COLUMN IF NOT EXISTS client_source TEXT;
CREATE INDEX IF NOT EXISTS idx_users_client_source
  ON users(client_source)
  WHERE client_source IS NOT NULL;
`,
  sqlite: `
ALTER TABLE users ADD COLUMN client_source TEXT;
ALTER TABLE review_sync_sessions ADD COLUMN client_source TEXT;
CREATE INDEX IF NOT EXISTS idx_users_client_source
  ON users(client_source)
  WHERE client_source IS NOT NULL;
`,
};

export default {
  version,
  name,
  up,
};
