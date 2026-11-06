const postgresReviewSyncStatements = [
  'CREATE EXTENSION IF NOT EXISTS "pgcrypto"',
  `CREATE TABLE IF NOT EXISTS review_sync_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL UNIQUE,
  device_label TEXT,
  auth_token_hash TEXT NOT NULL UNIQUE,
  last_seen_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 )`,
  `CREATE INDEX IF NOT EXISTS idx_review_sync_sessions_user
     ON review_sync_sessions(user_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_review_sync_sessions_active
     ON review_sync_sessions(revoked_at, last_seen_at DESC)`,
  `CREATE TABLE IF NOT EXISTS review_sync_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  device_id TEXT,
  project_id TEXT,
  project_name TEXT,
  project_path TEXT,
  review_type TEXT NOT NULL,
  review_id TEXT NOT NULL,
  recommendation_key TEXT,
  event_type TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  sync_error TEXT,
  sync_attempt_count INTEGER NOT NULL DEFAULT 0,
  synced_at TIMESTAMPTZ,
  event_idempotency_key TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
 )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_review_sync_events_user_idempotency
     ON review_sync_events(user_id, event_idempotency_key)`,
  `CREATE INDEX IF NOT EXISTS idx_review_sync_events_status_occurred
     ON review_sync_events(sync_status, occurred_at ASC)`,
  `CREATE INDEX IF NOT EXISTS idx_review_sync_events_user_occurred
     ON review_sync_events(user_id, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_review_sync_events_scope_occurred
     ON review_sync_events(user_id, review_type, review_id, occurred_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_review_sync_events_recommendation
     ON review_sync_events(user_id, review_type, review_id, recommendation_key, occurred_at DESC)`,
  `CREATE OR REPLACE FUNCTION update_updated_at_column()
   RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ language 'plpgsql'`,
  'DROP TRIGGER IF EXISTS update_review_sync_sessions_updated_at ON review_sync_sessions',
  `CREATE TRIGGER update_review_sync_sessions_updated_at
     BEFORE UPDATE ON review_sync_sessions
     FOR EACH ROW
     EXECUTE FUNCTION update_updated_at_column()`,
  'DROP TRIGGER IF EXISTS update_review_sync_events_updated_at ON review_sync_events',
  `CREATE TRIGGER update_review_sync_events_updated_at
     BEFORE UPDATE ON review_sync_events
     FOR EACH ROW
     EXECUTE FUNCTION update_updated_at_column()`,
];

export const postgresReviewSyncSchemaSQL = `${postgresReviewSyncStatements.join(';\n')};`;

export const sqliteReviewSyncSchemaSQL = `
CREATE TABLE IF NOT EXISTS review_sync_sessions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  device_id TEXT NOT NULL UNIQUE,
  device_label TEXT,
  auth_token_hash TEXT NOT NULL UNIQUE,
  last_seen_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_review_sync_sessions_user
  ON review_sync_sessions(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_sync_sessions_active
  ON review_sync_sessions(revoked_at, last_seen_at DESC);

CREATE TRIGGER IF NOT EXISTS update_review_sync_sessions_updated_at AFTER UPDATE ON review_sync_sessions
BEGIN
  UPDATE review_sync_sessions SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS review_sync_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  device_id TEXT,
  project_id TEXT,
  project_name TEXT,
  project_path TEXT,
  review_type TEXT NOT NULL,
  review_id TEXT NOT NULL,
  recommendation_key TEXT,
  event_type TEXT NOT NULL,
  sync_status TEXT NOT NULL DEFAULT 'pending',
  sync_error TEXT,
  sync_attempt_count INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT,
  event_idempotency_key TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_sync_events_user_idempotency
  ON review_sync_events(user_id, event_idempotency_key);

CREATE INDEX IF NOT EXISTS idx_review_sync_events_status_occurred
  ON review_sync_events(sync_status, occurred_at ASC);

CREATE INDEX IF NOT EXISTS idx_review_sync_events_user_occurred
  ON review_sync_events(user_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_sync_events_scope_occurred
  ON review_sync_events(user_id, review_type, review_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_review_sync_events_recommendation
  ON review_sync_events(user_id, review_type, review_id, recommendation_key, occurred_at DESC);

CREATE TRIGGER IF NOT EXISTS update_review_sync_events_updated_at AFTER UPDATE ON review_sync_events
BEGIN
  UPDATE review_sync_events SET updated_at = datetime('now') WHERE id = NEW.id;
END;
`;

export async function ensurePostgresReviewSyncSchema(executor) {
  for (const statement of postgresReviewSyncStatements) {
    await executor.query(statement);
  }
}
