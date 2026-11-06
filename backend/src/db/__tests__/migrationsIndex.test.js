import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getMigrations,
  getPendingMigrations,
  runMigrations,
  splitSqlStatements,
} from '../migrations/index.js';

const ORIGINAL_DB_TYPE = process.env.ATLAS_DB_TYPE;

afterEach(() => {
  if (ORIGINAL_DB_TYPE === undefined) {
    delete process.env.ATLAS_DB_TYPE;
  } else {
    process.env.ATLAS_DB_TYPE = ORIGINAL_DB_TYPE;
  }
});

describe('migrations index', () => {
  it('registers the baseline plus incremental migrations', () => {
    const migrations = getMigrations();
    expect(migrations).toHaveLength(23);
    expect(migrations.map((migration) => migration?.version)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23,
    ]);
    expect(migrations.map((migration) => migration?.name)).toEqual([
      'pre_release_baseline',
      'review_sync_backfill',
      'admin_role',
      'user_github_identity',
      'review_usage_identity_and_cost_metadata',
      'backfill_sync_users',
      'sync_event_repo_identity',
      'review_fix_runs',
      'users_github_identity',
      'users_client_source',
      'branch_review_fork_point',
      'review_fork_point',
      'base_branch_source',
      'create_walkthroughs',
      'pr_review_conversations',
      'pr_review_comment_counts',
      'pr_review_github_review_status',
      'review_agent_chat',
      'walkthrough_file_cache',
      'pr_review_github_updated_at',
      'project_last_pr_synced_at',
      'walkthrough_run_metadata',
      'codegraph_indexes',
    ]);
  });

  it('splits PostgreSQL SQL without breaking DO $$ blocks', () => {
    const sql = `
      CREATE TABLE one (id INTEGER);
      DO $$
      BEGIN
        PERFORM 1;
        PERFORM 2;
      END
      $$;
      CREATE TABLE two (id INTEGER);
    `;

    const statements = splitSqlStatements(sql, { dialect: 'postgres' });
    expect(statements).toHaveLength(3);
    expect(statements[1]).toContain('DO $$');
    expect(statements[1]).toContain('PERFORM 1;');
    expect(statements[1]).toContain('PERFORM 2;');
  });

  it('splits SQLite SQL without breaking trigger BEGIN...END bodies', () => {
    const sql = `
      CREATE TABLE review_outcomes (id INTEGER PRIMARY KEY, status TEXT);
      CREATE TRIGGER trg_validate
      BEFORE INSERT ON review_outcomes
      FOR EACH ROW
      WHEN NEW.status NOT IN ('addressed', 'dismissed')
      BEGIN
        SELECT RAISE(ABORT, 'constraint violation');
      END;
      INSERT INTO review_outcomes (status) VALUES ('addressed');
    `;

    const statements = splitSqlStatements(sql, { dialect: 'sqlite' });
    expect(statements).toHaveLength(3);
    expect(statements[1]).toContain('CREATE TRIGGER trg_validate');
    expect(statements[1]).toContain('BEGIN');
    expect(statements[1]).toContain("SELECT RAISE(ABORT, 'constraint violation');");
    expect(statements[1]).toContain('END');
  });

  it('throws when legacy schema_version rows would silently bypass the baseline', async () => {
    process.env.ATLAS_DB_TYPE = 'postgres';
    const db = {
      query: vi.fn(async (text) => {
        if (String(text).includes('information_schema.tables')) {
          return { rows: [{ exists: true }] };
        }
        if (String(text).includes('SELECT version, description FROM schema_version')) {
          return {
            rows: [
              { version: 1, description: 'pre_release_baseline' },
              { version: 99, description: 'legacy_unknown' },
            ],
          };
        }
        throw new Error(`Unexpected query: ${text}`);
      }),
    };

    await expect(getPendingMigrations(db)).rejects.toThrow(/Legacy schema_version entries detected/);
  });

  it('runs postgres migrations with DO blocks as intact statements (smoke)', async () => {
    process.env.ATLAS_DB_TYPE = 'postgres';
    const migrations = getMigrations();
    const originalMigrations = [...migrations];

    migrations.splice(0, migrations.length, {
      version: 1,
      name: 'pre_release_baseline',
      up: {
        postgres: `
          CREATE TABLE smoke_one (id INTEGER);
          DO $$ BEGIN
            PERFORM 1;
          END $$;
          CREATE TABLE smoke_two (id INTEGER);
        `,
      },
    });

    const executedStatements = [];
    const db = {
      query: vi.fn(async (text, params) => {
        const sql = String(text);
        if (sql.includes('information_schema.tables')) {
          return { rows: [{ exists: false }] };
        }
        executedStatements.push({ sql, params });
        return { rows: [], rowCount: 0 };
      }),
    };

    try {
      const applied = await runMigrations(db);
      expect(applied).toBe(1);
      const sqlCalls = executedStatements.map((entry) => entry.sql);
      expect(sqlCalls).toContain('CREATE TABLE smoke_one (id INTEGER)');
      expect(sqlCalls.some((sql) => sql.includes('DO $$ BEGIN'))).toBe(true);
      expect(sqlCalls).toContain('CREATE TABLE smoke_two (id INTEGER)');
      expect(sqlCalls.some((sql) => sql.startsWith('INSERT INTO schema_version'))).toBe(true);
    } finally {
      migrations.splice(0, migrations.length, ...originalMigrations);
    }
  });
});
