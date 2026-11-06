/**
 * Migration 023: CodeGraph index lifecycle
 *
 * Adds opt-in CodeGraph MCP integration support:
 *  - Two columns on `projects`: `codegraph_enabled` (user's desired
 *    enablement) and `codegraph_current_index_id` (O(1) pointer at the
 *    latest ready index row).
 *  - New `project_codegraph_indexes` table — one row per init attempt.
 *    Append-only by convention: "Not initialized" = no row; re-index
 *    creates a new row; old rows preserved for history/metrics.
 *
 * Two-state model (spec / status separation):
 *  - `projects.codegraph_enabled` is the user's desired enablement.
 *  - The latest index row carries the system status (`indexing` / `ready`
 *    / `error` / `stale`).
 *  - Reviews use CodeGraph only when BOTH are favorable AND
 *    `worktree_sha === reviewHeadSha` (invariant I1 — revision match).
 *
 * SQLite caveat: ALTER TABLE ADD COLUMN is not idempotent in SQLite.
 * The function-form sqliteUp checks PRAGMA table_info() first.
 */

export const version = 23;
export const name = 'codegraph_indexes';

const postgresSQL = `
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS codegraph_enabled BOOLEAN DEFAULT FALSE;
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS codegraph_current_index_id UUID;

CREATE TABLE IF NOT EXISTS project_codegraph_indexes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('indexing', 'ready', 'error', 'stale')),
  codegraph_version TEXT,
  worktree_sha TEXT,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ready_at TIMESTAMPTZ,
  files_indexed INT DEFAULT 0,
  total_files INT DEFAULT 0,
  nodes INT,
  edges INT,
  size_bytes BIGINT,
  error_message TEXT,
  metadata JSONB
);

CREATE INDEX IF NOT EXISTS idx_pcg_indexes_project_started
  ON project_codegraph_indexes(project_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_pcg_indexes_project_state
  ON project_codegraph_indexes(project_id, state);
`;

const sqliteUp = async (db) => {
  const projectCols = await db.query('PRAGMA table_info(projects)');
  const projectColNames = new Set((projectCols.rows || []).map((r) => r.name));
  if (!projectColNames.has('codegraph_enabled')) {
    await db.query('ALTER TABLE projects ADD COLUMN codegraph_enabled INTEGER DEFAULT 0');
  }
  if (!projectColNames.has('codegraph_current_index_id')) {
    await db.query('ALTER TABLE projects ADD COLUMN codegraph_current_index_id TEXT');
  }

  await db.query(`
    CREATE TABLE IF NOT EXISTS project_codegraph_indexes (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      state TEXT NOT NULL CHECK (state IN ('indexing', 'ready', 'error', 'stale')),
      codegraph_version TEXT,
      worktree_sha TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      ready_at TEXT,
      files_indexed INTEGER DEFAULT 0,
      total_files INTEGER DEFAULT 0,
      nodes INTEGER,
      edges INTEGER,
      size_bytes INTEGER,
      error_message TEXT,
      metadata TEXT
    )
  `);

  await db.query(
    'CREATE INDEX IF NOT EXISTS idx_pcg_indexes_project_started '
    + 'ON project_codegraph_indexes(project_id, started_at DESC)'
  );
  await db.query(
    'CREATE INDEX IF NOT EXISTS idx_pcg_indexes_project_state '
    + 'ON project_codegraph_indexes(project_id, state)'
  );
};

export const up = {
  postgres: postgresSQL,
  sqlite: sqliteUp,
};

export default {
  version,
  name,
  up,
};
