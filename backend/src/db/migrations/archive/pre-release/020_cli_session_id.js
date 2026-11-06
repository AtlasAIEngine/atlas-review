/**
 * Migration 020: Add cli_session_id column to projects
 *
 * Stores the Claude CLI session ID so conversation context persists
 * across messages within a project. Nullable — old projects get a
 * session ID assigned on first message.
 *
 * SQLite ALTER TABLE ADD COLUMN is NOT idempotent — handled by
 * migration runner try-catch (same pattern as 012_branch_review_json).
 */

export const version = 20;
export const name = 'cli_session_id';

export const up = {
  postgres: `
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS cli_session_id TEXT;
  `,
  sqlite: `
    -- SQLite: ALTER TABLE ADD COLUMN throws if column exists, handled by migration runner try-catch
    ALTER TABLE projects ADD COLUMN cli_session_id TEXT;
  `
};

export default {
  version,
  name,
  up
};
