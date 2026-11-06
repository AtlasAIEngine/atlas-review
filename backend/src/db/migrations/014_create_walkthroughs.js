/**
 * Migration 014: walkthroughs table
 *
 * Decouples walkthrough generation from the main review pipeline. Walkthroughs
 * are now an independently generated artifact, cached per
 * (project_id, base_sha, head_sha). Legacy review rows that still embed
 * `reviewJson.changeGroups` keep working through a fallback in
 * `walkthroughService.getWalkthroughForReview`.
 *
 * Schema:
 * - `id` (uuid pk)
 * - `project_id` (fk → projects, cascade)
 * - `base_sha`, `head_sha` (text)
 * - `change_groups` (Postgres JSONB / SQLite TEXT — serialized on write,
 *   parsed on read with the dual-DB guard documented in CLAUDE.md)
 * - `model_id`, `provider_type` (text — provenance for observability)
 * - `run_metadata` (JSONB/TEXT — generation duration, token/cost, mode)
 * - `created_at`, `updated_at`
 *
 * Unique index on (project_id, base_sha, head_sha) so upserts hit a single
 * row per diff.
 *
 * SQLite note: this migration creates a brand-new table; the
 * non-idempotent ALTER TABLE concern from CLAUDE.md doesn't apply here,
 * but the table itself is wrapped in `IF NOT EXISTS` for re-run safety.
 */

export const version = 14;
export const name = 'create_walkthroughs';

export const up = {
  postgres: `
CREATE TABLE IF NOT EXISTS walkthroughs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  change_groups JSONB NOT NULL,
  model_id TEXT,
  provider_type TEXT,
  run_metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_walkthroughs_project_shas
  ON walkthroughs(project_id, base_sha, head_sha);
`,
  sqlite: `
CREATE TABLE IF NOT EXISTS walkthroughs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  change_groups TEXT NOT NULL,
  model_id TEXT,
  provider_type TEXT,
  run_metadata TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_walkthroughs_project_shas
  ON walkthroughs(project_id, base_sha, head_sha);
`,
};

export default {
  version,
  name,
  up,
};
