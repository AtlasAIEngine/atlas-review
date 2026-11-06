/**
 * Migration 011: Branch Reviews
 *
 * Creates the `branch_reviews` table for tracking branch-level review items.
 * Also adds base_branch_display and base_branch_ref columns to the projects table.
 *
 * Branch reviews are lighter than changesets (no file before/after content stored).
 * Diff content is computed on-demand from git.
 */

export const version = 11;
export const name = 'branch_reviews';

export const up = {
  postgres: `
    CREATE TABLE IF NOT EXISTS branch_reviews (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
      display_id TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      merge_base_sha TEXT,
      head_sha TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'merged', 'closed', 'stale')),
      is_current BOOLEAN DEFAULT FALSE,
      file_count INTEGER DEFAULT 0,
      total_additions INTEGER DEFAULT 0,
      total_deletions INTEGER DEFAULT 0,
      commit_count INTEGER DEFAULT 0,
      first_commit_at TIMESTAMPTZ,
      last_commit_at TIMESTAMPTZ,
      review_status TEXT DEFAULT 'none'
        CHECK (review_status IN ('none', 'queued', 'reviewing', 'reviewed', 'failed')),
      review_risk_level TEXT,
      review_summary TEXT,
      review_json TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_branch_reviews_project ON branch_reviews(project_id);
    CREATE INDEX IF NOT EXISTS idx_branch_reviews_branch ON branch_reviews(project_id, branch_name);
    CREATE INDEX IF NOT EXISTS idx_branch_reviews_current ON branch_reviews(project_id, is_current);
    CREATE INDEX IF NOT EXISTS idx_branch_reviews_status ON branch_reviews(status);

    ALTER TABLE projects ADD COLUMN IF NOT EXISTS base_branch_display TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS base_branch_ref TEXT;
  `,
  sqlite: `
    CREATE TABLE IF NOT EXISTS branch_reviews (
      id TEXT PRIMARY KEY,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      display_id TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      base_branch TEXT NOT NULL,
      merge_base_sha TEXT,
      head_sha TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      is_current INTEGER DEFAULT 0,
      file_count INTEGER DEFAULT 0,
      total_additions INTEGER DEFAULT 0,
      total_deletions INTEGER DEFAULT 0,
      commit_count INTEGER DEFAULT 0,
      first_commit_at TEXT,
      last_commit_at TEXT,
      review_status TEXT DEFAULT 'none',
      review_risk_level TEXT,
      review_summary TEXT,
      review_json TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_branch_reviews_project ON branch_reviews(project_id);
    CREATE INDEX IF NOT EXISTS idx_branch_reviews_branch ON branch_reviews(project_id, branch_name);
    CREATE INDEX IF NOT EXISTS idx_branch_reviews_current ON branch_reviews(project_id, is_current);
    CREATE INDEX IF NOT EXISTS idx_branch_reviews_status ON branch_reviews(status);

    ALTER TABLE projects ADD COLUMN base_branch_display TEXT;
    ALTER TABLE projects ADD COLUMN base_branch_ref TEXT;
  `
};

export default {
  version,
  name,
  up
};
