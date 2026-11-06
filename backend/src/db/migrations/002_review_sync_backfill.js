import {
  postgresReviewSyncSchemaSQL,
  sqliteReviewSyncSchemaSQL,
} from '../schema/reviewSyncSchema.js';

/**
 * Migration 002: Backfill review sync tables for existing desktop installs
 *
 * Older SQLite desktop databases may already be marked at baseline version 1
 * from before review_sync_events was added to the squashed schema. This
 * migration is intentionally idempotent and safe for both fresh and existing
 * databases.
 */

export const version = 2;
export const name = 'review_sync_backfill';

export const up = {
  postgres: postgresReviewSyncSchemaSQL,
  sqlite: sqliteReviewSyncSchemaSQL,
};

export default {
  version,
  name,
  up,
};
