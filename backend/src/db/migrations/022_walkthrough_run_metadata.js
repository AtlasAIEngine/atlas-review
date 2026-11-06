/**
 * Migration 022: walkthrough run metadata
 *
 * Stores observability data for the last walkthrough generation run:
 * duration, model strategy, token/cost estimates, cache hits, map-reduce
 * counts, and escalation counts.
 */

export const version = 22;
export const name = 'walkthrough_run_metadata';

const postgresSQL = `
ALTER TABLE walkthroughs
  ADD COLUMN IF NOT EXISTS run_metadata JSONB;
`;

const sqliteUp = async (db) => {
  const cols = await db.query("PRAGMA table_info(walkthroughs)");
  const hasCol = (cols.rows || []).some((r) => r.name === 'run_metadata');
  if (!hasCol) {
    await db.query('ALTER TABLE walkthroughs ADD COLUMN run_metadata TEXT');
  }
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
