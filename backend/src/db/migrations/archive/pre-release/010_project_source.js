/**
 * Migration 010: Project Source Field
 *
 * Adds a `source` column to the projects table to track how each project
 * was created: 'builder' (new project), 'local' (imported folder), or
 * 'github' (cloned from GitHub).
 *
 * Backfills existing projects based on heuristics:
 * - github_clone_url IS NOT NULL => 'github'
 * - description LIKE 'Imported from local folder%' => 'local'
 * - everything else => 'builder' (the default)
 */

export const version = 10;
export const name = 'project_source';

export const up = {
  postgres: `
    ALTER TABLE projects
      ADD COLUMN IF NOT EXISTS source TEXT DEFAULT 'builder';

    -- Backfill: GitHub-cloned projects
    UPDATE projects SET source = 'github'
      WHERE github_clone_url IS NOT NULL AND source = 'builder';

    -- Backfill: Local folder imports
    UPDATE projects SET source = 'local'
      WHERE description LIKE 'Imported from local folder%' AND source = 'builder';
  `,
  sqlite: `
    ALTER TABLE projects ADD COLUMN source TEXT DEFAULT 'builder';

    -- Backfill: GitHub-cloned projects
    UPDATE projects SET source = 'github'
      WHERE github_clone_url IS NOT NULL AND source = 'builder';

    -- Backfill: Local folder imports
    UPDATE projects SET source = 'local'
      WHERE description LIKE 'Imported from local folder%' AND source = 'builder';
  `
};

export default {
  version,
  name,
  up
};
