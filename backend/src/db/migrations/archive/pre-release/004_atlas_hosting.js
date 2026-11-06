/**
 * Migration 004: Atlas Hosting (Vercel Deployment)
 *
 * Adds tables and columns required for Atlas Hosting deployment via Vercel.
 * Consolidates PostgreSQL migrations 006, 008, 009, 010, 012 into a single
 * SQLite migration for the desktop app.
 *
 * - publish_attempts table for tracking deployments
 * - Vercel project columns on projects table
 * - Production deployment pointer columns on projects table
 */

export const version = 4;
export const name = 'atlas_hosting';

// PostgreSQL schema (matches the existing PG migrations 006+008+009+010+012)
const postgresSQL = `
-- Vercel project columns on projects
ALTER TABLE projects
ADD COLUMN IF NOT EXISTS vercel_project_id VARCHAR(255),
ADD COLUMN IF NOT EXISTS vercel_project_name VARCHAR(255),
ADD COLUMN IF NOT EXISTS last_deployment_url VARCHAR(500),
ADD COLUMN IF NOT EXISTS last_deployment_at TIMESTAMP;

-- Publish attempts table
CREATE TABLE IF NOT EXISTS publish_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  changeset_id VARCHAR(100),
  commit_hash VARCHAR(40),
  vercel_project_id VARCHAR(255),
  deployment_id VARCHAR(255),
  deployment_url VARCHAR(500),
  vercel_url VARCHAR(500),
  inspect_url VARCHAR(500),
  status VARCHAR(20) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  started_at TIMESTAMP,
  finished_at TIMESTAMP,
  logs TEXT,
  error_message TEXT,
  secrets_keys TEXT[] DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_publish_attempts_project ON publish_attempts(project_id);
CREATE INDEX IF NOT EXISTS idx_publish_attempts_status ON publish_attempts(status);
CREATE INDEX IF NOT EXISTS idx_publish_attempts_created ON publish_attempts(project_id, created_at DESC);

-- Production deployment pointer columns on projects
ALTER TABLE projects
ADD COLUMN IF NOT EXISTS production_deployment_id UUID REFERENCES publish_attempts(id),
ADD COLUMN IF NOT EXISTS production_commit_hash VARCHAR(40),
ADD COLUMN IF NOT EXISTS production_changeset_id VARCHAR(100),
ADD COLUMN IF NOT EXISTS production_url VARCHAR(500),
ADD COLUMN IF NOT EXISTS production_updated_at TIMESTAMP;
`;

// SQLite schema
const sqliteSQL = `
-- Vercel project columns on projects
ALTER TABLE projects ADD COLUMN vercel_project_id TEXT;
ALTER TABLE projects ADD COLUMN vercel_project_name TEXT;
ALTER TABLE projects ADD COLUMN last_deployment_url TEXT;
ALTER TABLE projects ADD COLUMN last_deployment_at TEXT;

-- Publish attempts table
CREATE TABLE IF NOT EXISTS publish_attempts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  changeset_id TEXT,
  commit_hash TEXT,
  vercel_project_id TEXT,
  deployment_id TEXT,
  deployment_url TEXT,
  vercel_url TEXT,
  inspect_url TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  started_at TEXT,
  finished_at TEXT,
  logs TEXT,
  error_message TEXT,
  secrets_keys TEXT DEFAULT '[]',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_publish_attempts_project ON publish_attempts(project_id);
CREATE INDEX IF NOT EXISTS idx_publish_attempts_status ON publish_attempts(status);
CREATE INDEX IF NOT EXISTS idx_publish_attempts_created ON publish_attempts(project_id, created_at DESC);

-- Production deployment pointer columns on projects
ALTER TABLE projects ADD COLUMN production_deployment_id TEXT;
ALTER TABLE projects ADD COLUMN production_commit_hash TEXT;
ALTER TABLE projects ADD COLUMN production_changeset_id TEXT;
ALTER TABLE projects ADD COLUMN production_url TEXT;
ALTER TABLE projects ADD COLUMN production_updated_at TEXT;
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
