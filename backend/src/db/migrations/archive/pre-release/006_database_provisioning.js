/**
 * Migration 006: Database Provisioning Columns
 *
 * Adds columns to the projects table for tracking per-project database provisioning.
 * Used by databaseService.js to provision, deprovision, and query project databases.
 *
 * - database_name: Name of the provisioned database
 * - database_user: Username for the provisioned database
 * - database_url: Connection URL for the provisioned database
 * - database_provisioned: Whether the database has been provisioned
 */

export const version = 6;
export const name = 'database_provisioning';

const postgresSQL = `
ALTER TABLE projects
ADD COLUMN IF NOT EXISTS database_name VARCHAR(255),
ADD COLUMN IF NOT EXISTS database_user VARCHAR(255),
ADD COLUMN IF NOT EXISTS database_url TEXT,
ADD COLUMN IF NOT EXISTS database_provisioned BOOLEAN DEFAULT FALSE;
`;

const sqliteSQL = `
ALTER TABLE projects ADD COLUMN database_name TEXT;
ALTER TABLE projects ADD COLUMN database_user TEXT;
ALTER TABLE projects ADD COLUMN database_url TEXT;
ALTER TABLE projects ADD COLUMN database_provisioned INTEGER DEFAULT 0;
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
