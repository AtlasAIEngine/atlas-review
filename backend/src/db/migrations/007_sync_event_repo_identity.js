/**
 * Migration 007: Add repo identity columns to review_sync_events
 *
 * Enables deduplication of the same project across different devices/users
 * by storing a hash of the normalized git remote URL as a stable identity key.
 */

export const version = 7;
export const name = 'sync_event_repo_identity';

export const up = {
  postgres: `
ALTER TABLE review_sync_events ADD COLUMN IF NOT EXISTS repo_identity_hash TEXT;
ALTER TABLE review_sync_events ADD COLUMN IF NOT EXISTS repo_remote_url TEXT;
CREATE INDEX IF NOT EXISTS idx_sync_events_repo_identity ON review_sync_events(repo_identity_hash);
`,
  sqlite: `
ALTER TABLE review_sync_events ADD COLUMN repo_identity_hash TEXT;
ALTER TABLE review_sync_events ADD COLUMN repo_remote_url TEXT;
CREATE INDEX IF NOT EXISTS idx_sync_events_repo_identity ON review_sync_events(repo_identity_hash);
`,
};

export default {
  version,
  name,
  up,
};
