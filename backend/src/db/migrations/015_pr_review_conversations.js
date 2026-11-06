/**
 * Migration 015: PR review conversations
 *
 * Persists inbound GitHub PR conversation state separately from Atlas AI
 * review output. Review-thread resolution is sourced from GitHub GraphQL;
 * top-level PR comments are sourced from the issue-comments REST surface.
 */

export const version = 15;
export const name = 'pr_review_conversations';

export const up = {
  postgres: `
CREATE TABLE IF NOT EXISTS github_pr_threads (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pr_review_id UUID NOT NULL REFERENCES pr_reviews(id) ON DELETE CASCADE,
  github_pr_number INTEGER NOT NULL,
  thread_node_id TEXT NOT NULL,
  is_resolved BOOLEAN NOT NULL DEFAULT FALSE,
  is_outdated BOOLEAN NOT NULL DEFAULT FALSE,
  resolved_by_login TEXT,
  path TEXT,
  line INTEGER,
  start_line INTEGER,
  side TEXT,
  original_line INTEGER,
  original_start_line INTEGER,
  first_comment_at TIMESTAMPTZ,
  last_comment_at TIMESTAMPTZ,
  comment_count INTEGER NOT NULL DEFAULT 0,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, pr_review_id, thread_node_id)
);

CREATE INDEX IF NOT EXISTS idx_github_pr_threads_scope
  ON github_pr_threads(project_id, pr_review_id, is_resolved, updated_at DESC);

CREATE TABLE IF NOT EXISTS github_pr_thread_comments (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pr_review_id UUID NOT NULL REFERENCES pr_reviews(id) ON DELETE CASCADE,
  thread_node_id TEXT NOT NULL,
  comment_node_id TEXT NOT NULL,
  database_id BIGINT,
  reply_to_node_id TEXT,
  github_review_node_id TEXT,
  github_review_database_id BIGINT,
  body TEXT NOT NULL DEFAULT '',
  body_text TEXT,
  author_login TEXT,
  author_avatar_url TEXT,
  author_url TEXT,
  html_url TEXT,
  path TEXT,
  line INTEGER,
  start_line INTEGER,
  side TEXT,
  diff_hunk TEXT,
  is_minimized BOOLEAN NOT NULL DEFAULT FALSE,
  minimized_reason TEXT,
  created_at_source TIMESTAMPTZ,
  updated_at_source TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, pr_review_id, comment_node_id)
);

CREATE INDEX IF NOT EXISTS idx_github_pr_thread_comments_thread
  ON github_pr_thread_comments(project_id, pr_review_id, thread_node_id, created_at_source ASC);

CREATE TABLE IF NOT EXISTS github_pr_issue_comments (
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pr_review_id UUID NOT NULL REFERENCES pr_reviews(id) ON DELETE CASCADE,
  github_pr_number INTEGER NOT NULL,
  comment_node_id TEXT NOT NULL,
  database_id BIGINT,
  body TEXT NOT NULL DEFAULT '',
  body_text TEXT,
  author_login TEXT,
  author_avatar_url TEXT,
  author_url TEXT,
  html_url TEXT,
  created_at_source TIMESTAMPTZ,
  updated_at_source TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (project_id, pr_review_id, comment_node_id)
);

CREATE INDEX IF NOT EXISTS idx_github_pr_issue_comments_scope
  ON github_pr_issue_comments(project_id, pr_review_id, updated_at_source DESC);
`,
  sqlite: `
CREATE TABLE IF NOT EXISTS github_pr_threads (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pr_review_id TEXT NOT NULL REFERENCES pr_reviews(id) ON DELETE CASCADE,
  github_pr_number INTEGER NOT NULL,
  thread_node_id TEXT NOT NULL,
  is_resolved INTEGER NOT NULL DEFAULT 0,
  is_outdated INTEGER NOT NULL DEFAULT 0,
  resolved_by_login TEXT,
  path TEXT,
  line INTEGER,
  start_line INTEGER,
  side TEXT,
  original_line INTEGER,
  original_start_line INTEGER,
  first_comment_at TEXT,
  last_comment_at TEXT,
  comment_count INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, pr_review_id, thread_node_id)
);

CREATE INDEX IF NOT EXISTS idx_github_pr_threads_scope
  ON github_pr_threads(project_id, pr_review_id, is_resolved, updated_at DESC);

CREATE TABLE IF NOT EXISTS github_pr_thread_comments (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pr_review_id TEXT NOT NULL REFERENCES pr_reviews(id) ON DELETE CASCADE,
  thread_node_id TEXT NOT NULL,
  comment_node_id TEXT NOT NULL,
  database_id INTEGER,
  reply_to_node_id TEXT,
  github_review_node_id TEXT,
  github_review_database_id INTEGER,
  body TEXT NOT NULL DEFAULT '',
  body_text TEXT,
  author_login TEXT,
  author_avatar_url TEXT,
  author_url TEXT,
  html_url TEXT,
  path TEXT,
  line INTEGER,
  start_line INTEGER,
  side TEXT,
  diff_hunk TEXT,
  is_minimized INTEGER NOT NULL DEFAULT 0,
  minimized_reason TEXT,
  created_at_source TEXT,
  updated_at_source TEXT,
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, pr_review_id, comment_node_id)
);

CREATE INDEX IF NOT EXISTS idx_github_pr_thread_comments_thread
  ON github_pr_thread_comments(project_id, pr_review_id, thread_node_id, created_at_source ASC);

CREATE TABLE IF NOT EXISTS github_pr_issue_comments (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  pr_review_id TEXT NOT NULL REFERENCES pr_reviews(id) ON DELETE CASCADE,
  github_pr_number INTEGER NOT NULL,
  comment_node_id TEXT NOT NULL,
  database_id INTEGER,
  body TEXT NOT NULL DEFAULT '',
  body_text TEXT,
  author_login TEXT,
  author_avatar_url TEXT,
  author_url TEXT,
  html_url TEXT,
  created_at_source TEXT,
  updated_at_source TEXT,
  synced_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, pr_review_id, comment_node_id)
);

CREATE INDEX IF NOT EXISTS idx_github_pr_issue_comments_scope
  ON github_pr_issue_comments(project_id, pr_review_id, updated_at_source DESC);
`,
};

export default {
  version,
  name,
  up,
};
