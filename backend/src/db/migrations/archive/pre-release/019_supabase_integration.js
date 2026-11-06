/**
 * Migration 019: Supabase Integration
 *
 * Adds tables for Supabase OAuth tokens and project-level Supabase project links.
 */

export const version = 19;
export const name = 'supabase_integration';

const postgresSQL = `
-- Supabase integrations (one per user)
CREATE TABLE IF NOT EXISTS supabase_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  account_email TEXT,
  organizations JSONB,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_supabase_integrations_user
  ON supabase_integrations(user_id) WHERE is_active = TRUE;

DROP TRIGGER IF EXISTS update_supabase_integrations_updated_at ON supabase_integrations;
CREATE TRIGGER update_supabase_integrations_updated_at
  BEFORE UPDATE ON supabase_integrations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Supabase project links (one per AtlasEngine project)
CREATE TABLE IF NOT EXISTS supabase_project_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  supabase_project_ref TEXT NOT NULL,
  supabase_project_name TEXT NOT NULL,
  supabase_org_id TEXT,
  region TEXT,
  database_url_encrypted TEXT,
  anon_key TEXT,
  service_role_key_encrypted TEXT,
  supabase_url TEXT NOT NULL,
  provisioned_by TEXT NOT NULL DEFAULT 'linked',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_supabase_project_links_project
  ON supabase_project_links(project_id);

DROP TRIGGER IF EXISTS update_supabase_project_links_updated_at ON supabase_project_links;
CREATE TRIGGER update_supabase_project_links_updated_at
  BEFORE UPDATE ON supabase_project_links
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
`;

const sqliteSQL = `
-- Supabase integrations (one per user)
CREATE TABLE IF NOT EXISTS supabase_integrations (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT NOT NULL,
  token_expires_at TEXT NOT NULL,
  account_email TEXT,
  organizations TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_supabase_integrations_user
  ON supabase_integrations(user_id) WHERE is_active = 1;

CREATE TRIGGER IF NOT EXISTS update_supabase_integrations_updated_at AFTER UPDATE ON supabase_integrations
BEGIN
  UPDATE supabase_integrations SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- Supabase project links (one per AtlasEngine project)
CREATE TABLE IF NOT EXISTS supabase_project_links (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  supabase_project_ref TEXT NOT NULL,
  supabase_project_name TEXT NOT NULL,
  supabase_org_id TEXT,
  region TEXT,
  database_url_encrypted TEXT,
  anon_key TEXT,
  service_role_key_encrypted TEXT,
  supabase_url TEXT NOT NULL,
  provisioned_by TEXT NOT NULL DEFAULT 'linked',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_supabase_project_links_project
  ON supabase_project_links(project_id);

CREATE TRIGGER IF NOT EXISTS update_supabase_project_links_updated_at AFTER UPDATE ON supabase_project_links
BEGIN
  UPDATE supabase_project_links SET updated_at = datetime('now') WHERE id = NEW.id;
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
