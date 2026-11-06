/**
 * Migration 002: Settings Table
 *
 * Creates a key-value settings table for storing app configuration.
 * Used for setup wizard state, user preferences, etc.
 */

export const version = 2;
export const name = 'settings_table';

// PostgreSQL schema
const postgresSQL = `
-- Settings table (key-value store)
CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_settings_updated ON settings(updated_at DESC);

-- Trigger for updated_at
DO $$ BEGIN
  CREATE TRIGGER update_settings_updated_at BEFORE UPDATE ON settings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
`;

// SQLite schema
const sqliteSQL = `
-- Settings table (key-value store)
CREATE TABLE IF NOT EXISTS settings (
  id TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_settings_updated ON settings(updated_at DESC);

-- Trigger for updated_at
CREATE TRIGGER IF NOT EXISTS update_settings_updated_at AFTER UPDATE ON settings
BEGIN
  UPDATE settings SET updated_at = datetime('now') WHERE id = NEW.id;
END;
`;

export const up = {
  postgres: postgresSQL,
  sqlite: sqliteSQL
};

export default {
  version,
  name,
  up
};
