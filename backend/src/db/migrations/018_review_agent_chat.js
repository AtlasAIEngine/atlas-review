/**
 * Migration 018: Add review-scoped assistant chat persistence
 */

export const version = 18;
export const name = 'review_agent_chat';

export const up = {
  postgres: `
CREATE TABLE IF NOT EXISTS review_agent_sessions (
  id UUID PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  review_type TEXT NOT NULL,
  review_id TEXT NOT NULL,
  provider_type TEXT,
  provider_model TEXT,
  provider_session_id TEXT,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_review_agent_sessions_scope
  ON review_agent_sessions(project_id, review_type, review_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS review_agent_messages (
  id UUID PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES review_agent_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL DEFAULT '',
  tokens_used INT DEFAULT 0,
  model TEXT,
  meta JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_review_agent_messages_session
  ON review_agent_messages(session_id, created_at ASC);
`,
  sqlite: `
CREATE TABLE IF NOT EXISTS review_agent_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  review_type TEXT NOT NULL,
  review_id TEXT NOT NULL,
  provider_type TEXT,
  provider_model TEXT,
  provider_session_id TEXT,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_review_agent_sessions_scope
  ON review_agent_sessions(project_id, review_type, review_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS review_agent_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES review_agent_sessions(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content TEXT NOT NULL DEFAULT '',
  tokens_used INTEGER DEFAULT 0,
  model TEXT,
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_review_agent_messages_session
  ON review_agent_messages(session_id, created_at ASC);
`,
};

export default {
  version,
  name,
  up,
};
