/**
 * Migration 008: Actions Log
 *
 * Creates the actions_log table for tracking action executions
 * (push, deploy, rollback, export, verify) against changesets.
 */

export const version = 8;
export const name = 'actions_log';

export const up = {
  postgres: `
    CREATE TABLE IF NOT EXISTS actions_log (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      changeset_id TEXT,
      action_type TEXT NOT NULL,
      action_status TEXT NOT NULL DEFAULT 'pending',
      input TEXT,
      output TEXT,
      error_message TEXT,
      triggered_at TIMESTAMPTZ DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_actions_log_project ON actions_log(project_id);
    CREATE INDEX IF NOT EXISTS idx_actions_log_changeset ON actions_log(changeset_id);
  `,
  sqlite: `
    CREATE TABLE IF NOT EXISTS actions_log (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      changeset_id TEXT,
      action_type TEXT NOT NULL,
      action_status TEXT NOT NULL DEFAULT 'pending',
      input TEXT,
      output TEXT,
      error_message TEXT,
      triggered_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_actions_log_project ON actions_log(project_id);
    CREATE INDEX IF NOT EXISTS idx_actions_log_changeset ON actions_log(changeset_id);
  `
};
