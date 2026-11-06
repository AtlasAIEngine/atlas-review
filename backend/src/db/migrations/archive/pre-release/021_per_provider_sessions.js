/**
 * Migration 021: Per-provider CLI session tracking
 *
 * Adds `cli_sessions` (JSON TEXT) to store session IDs per CLI provider,
 * and `last_cli_provider` to track which provider was last used (for
 * detecting provider switches and injecting cross-provider context).
 *
 * JSON format: {"anthropic": "uuid-A", "openai": "uuid-B"}
 *
 * Migrates existing `cli_session_id` data into the JSON column for
 * backward compatibility (those were all Claude/anthropic sessions).
 *
 * SQLite ALTER TABLE ADD COLUMN is NOT idempotent — handled by
 * migration runner try-catch (same pattern as 012, 020).
 */

export const version = 21;
export const name = 'per_provider_sessions';

export const up = {
  postgres: `
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS cli_sessions TEXT;
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS last_cli_provider TEXT;

    UPDATE projects
    SET cli_sessions = '{"anthropic":"' || cli_session_id || '"}'
    WHERE cli_session_id IS NOT NULL AND (cli_sessions IS NULL OR cli_sessions = '');
  `,
  sqlite: `
    ALTER TABLE projects ADD COLUMN cli_sessions TEXT;
    ALTER TABLE projects ADD COLUMN last_cli_provider TEXT;

    UPDATE projects
    SET cli_sessions = '{"anthropic":"' || cli_session_id || '"}'
    WHERE cli_session_id IS NOT NULL AND (cli_sessions IS NULL OR cli_sessions = '');
  `
};

export default {
  version,
  name,
  up
};
