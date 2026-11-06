/**
 * Migration 005: GitHub Refresh Token
 *
 * Adds columns for storing the OAuth refresh token from GitHub's device flow.
 * GitHub Apps with "expiring user access tokens" enabled return a refresh_token
 * (valid ~6 months) alongside the 8-hour access_token. This enables silent
 * token renewal without re-prompting the user.
 *
 * Both columns are nullable: when the GitHub App has expiring tokens disabled,
 * no refresh token is returned and these stay NULL.
 */

export const version = 5;
export const name = 'github_refresh_token';

const postgresSQL = `
ALTER TABLE github_integrations
ADD COLUMN IF NOT EXISTS refresh_token_encrypted TEXT,
ADD COLUMN IF NOT EXISTS refresh_token_expires_at TIMESTAMPTZ;
`;

const sqliteSQL = `
ALTER TABLE github_integrations ADD COLUMN refresh_token_encrypted TEXT;
ALTER TABLE github_integrations ADD COLUMN refresh_token_expires_at TEXT;
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
