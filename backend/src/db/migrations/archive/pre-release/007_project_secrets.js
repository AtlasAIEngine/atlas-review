/**
 * Migration 007: Project Secrets
 *
 * Adds project_secrets table for storing project environment variables
 * and secrets (used during Vercel deployment).
 */

export const version = 7;
export const name = 'project_secrets';

// PostgreSQL schema
const postgresSQL = `
CREATE TABLE IF NOT EXISTS project_secrets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key VARCHAR(255) NOT NULL,
  value TEXT NOT NULL,
  is_secret BOOLEAN DEFAULT true,
  environment VARCHAR(50) DEFAULT 'production',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  CONSTRAINT unique_project_key_env UNIQUE (project_id, key, environment)
);

CREATE INDEX IF NOT EXISTS idx_project_secrets_project ON project_secrets(project_id);
CREATE INDEX IF NOT EXISTS idx_project_secrets_environment ON project_secrets(project_id, environment);
`;

// SQLite schema
const sqliteSQL = `
CREATE TABLE IF NOT EXISTS project_secrets (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  is_secret INTEGER DEFAULT 1,
  environment TEXT DEFAULT 'production',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (project_id, key, environment)
);

CREATE INDEX IF NOT EXISTS idx_project_secrets_project ON project_secrets(project_id);
CREATE INDEX IF NOT EXISTS idx_project_secrets_environment ON project_secrets(project_id, environment);
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
