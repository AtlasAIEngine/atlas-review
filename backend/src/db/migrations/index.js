/**
 * Database Migration System
 *
 * Manages schema migrations for both PostgreSQL and SQLite databases.
 * Uses a single schema_version table as the source of truth.
 *
 * Pre-release squash note:
 * - AtlasEngine is still pre-release, so the launch schema is shipped as a
 *   single fresh-install baseline migration (001_initial.js).
 * - Retired pre-release incremental migrations are kept only as source history
 *   and are not registered for runtime execution.
 *
 * Migration files are numbered (001_initial.js, 002_xxx.js, etc. as needed)
 * Each migration exports: { version, name, up: { postgres: sql, sqlite: sql } }
 */

import { getDbType } from '../index.js';

// Store loaded migrations
let migrations = null;
const BASELINE_VERSION = 1;

/**
 * Load all migrations from the migrations directory
 * @returns {Array} Array of migration objects sorted by version
 */
export function getMigrations() {
  if (migrations) {
    return migrations;
  }

  // Import migrations statically to avoid dynamic fs operations.
  // Baseline only (pre-release migration squash), plus incremental migrations.
  migrations = [
    {
      version: 1,
      name: 'pre_release_baseline',
      up: null,
      module: () => import('./001_initial.js')
    },
    {
      version: 2,
      name: 'review_sync_backfill',
      up: null,
      module: () => import('./002_review_sync_backfill.js')
    },
    {
      version: 3,
      name: 'admin_role',
      up: null,
      module: () => import('./003_admin_role.js')
    },
    {
      version: 4,
      name: 'user_github_identity',
      up: null,
      module: () => import('./004_user_github_identity.js')
    },
    {
      version: 5,
      name: 'review_usage_identity_and_cost_metadata',
      up: null,
      module: () => import('./005_review_usage_identity_and_cost_metadata.js')
    },
    {
      version: 6,
      name: 'backfill_sync_users',
      up: null,
      module: () => import('./006_backfill_sync_users.js')
    },
    {
      version: 7,
      name: 'sync_event_repo_identity',
      up: null,
      module: () => import('./007_sync_event_repo_identity.js')
    },
    {
      version: 8,
      name: 'review_fix_runs',
      up: null,
      module: () => import('./008_review_fix_runs.js')
    },
    {
      version: 9,
      name: 'users_github_identity',
      up: null,
      module: () => import('./009_users_github_identity.js')
    },
    {
      version: 10,
      name: 'users_client_source',
      up: null,
      module: () => import('./010_users_client_source.js')
    },
    {
      version: 11,
      name: 'branch_review_fork_point',
      up: null,
      module: () => import('./011_branch_review_fork_point.js')
    },
    {
      version: 12,
      name: 'review_fork_point',
      up: null,
      module: () => import('./012_review_fork_point.js')
    },
    {
      version: 13,
      name: 'base_branch_source',
      up: null,
      module: () => import('./013_base_branch_source.js')
    },
    {
      version: 14,
      name: 'create_walkthroughs',
      up: null,
      module: () => import('./014_create_walkthroughs.js')
    },
    {
      version: 15,
      name: 'pr_review_conversations',
      up: null,
      module: () => import('./015_pr_review_conversations.js')
    },
    {
      version: 16,
      name: 'pr_review_comment_counts',
      up: null,
      module: () => import('./016_pr_review_comment_counts.js')
    },
    {
      version: 17,
      name: 'pr_review_github_review_status',
      up: null,
      module: () => import('./017_pr_review_github_review_status.js')
    },
    {
      version: 18,
      name: 'review_agent_chat',
      up: null,
      module: () => import('./018_review_agent_chat.js')
    },
    {
      version: 19,
      name: 'walkthrough_file_cache',
      up: null,
      module: () => import('./019_walkthrough_file_cache.js')
    },
    {
      version: 20,
      name: 'pr_review_github_updated_at',
      up: null,
      module: () => import('./020_pr_review_github_updated_at.js')
    },
    {
      version: 21,
      name: 'project_last_pr_synced_at',
      up: null,
      module: () => import('./021_project_last_pr_synced_at.js')
    },
    {
      version: 22,
      name: 'walkthrough_run_metadata',
      up: null,
      module: () => import('./022_walkthrough_run_metadata.js')
    },
    {
      version: 23,
      name: 'codegraph_indexes',
      up: null,
      module: () => import('./023_codegraph_indexes.js')
    }
  ];

  return migrations;
}

function normalizeVersion(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSchemaVersionRows(rows = []) {
  return rows
    .map((row) => ({
      version: normalizeVersion(row?.version),
      description: typeof row?.description === 'string' ? row.description : '',
    }))
    .filter((row) => Number.isInteger(row.version));
}

function assertNoLegacySchemaVersionDrift(allMigrations, appliedRows) {
  if (!Array.isArray(appliedRows) || appliedRows.length === 0) return;

  const knownVersions = new Set(
    allMigrations
      .map((migration) => normalizeVersion(migration?.version))
      .filter((version) => Number.isInteger(version))
  );
  const unknownApplied = appliedRows
    .map((row) => row.version)
    .filter((version) => !knownVersions.has(version));

  if (unknownApplied.length > 0) {
    throw new Error(
      `Legacy schema_version entries detected (${unknownApplied.join(', ')}). `
      + 'This pre-release baseline cannot safely infer partial historical migrations. '
      + 'Reset and re-bootstrap the database with the baseline schema.'
    );
  }

  const baseline = allMigrations.find((migration) => normalizeVersion(migration?.version) === BASELINE_VERSION);
  if (!baseline) return;

  const baselineRow = appliedRows.find((row) => row.version === BASELINE_VERSION);
  if (!baselineRow) return;

  const expectedDescription = String(baseline.name || '').trim();
  const actualDescription = String(baselineRow.description || '').trim();
  if (actualDescription !== expectedDescription) {
    throw new Error(
      `Legacy baseline marker detected for schema version ${BASELINE_VERSION}. `
      + `Expected "${expectedDescription}" but found "${actualDescription || '(empty)'}". `
      + 'Reset and re-bootstrap the database with the baseline schema to avoid silent drift.'
    );
  }
}

function splitSqlStatements(sql, { dialect = 'generic' } = {}) {
  const source = String(sql || '');
  const statements = [];
  let current = '';
  let token = '';
  let i = 0;

  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarQuoteTag = null;

  const sqliteState = {
    sawCreate: false,
    inTrigger: false,
    triggerBodyDepth: 0,
  };

  const resetSqliteStatementState = () => {
    sqliteState.sawCreate = false;
    sqliteState.inTrigger = false;
    sqliteState.triggerBodyDepth = 0;
  };

  const flushToken = () => {
    if (!token) return;
    const upperToken = token.toUpperCase();
    token = '';

    if (dialect !== 'sqlite') return;

    if (!sqliteState.inTrigger) {
      if (upperToken === 'CREATE') {
        sqliteState.sawCreate = true;
        return;
      }
      if (sqliteState.sawCreate) {
        if (upperToken === 'TEMP' || upperToken === 'TEMPORARY' || upperToken === 'IF' || upperToken === 'NOT' || upperToken === 'EXISTS') {
          return;
        }
        if (upperToken === 'TRIGGER') {
          sqliteState.inTrigger = true;
          sqliteState.triggerBodyDepth = 0;
          return;
        }
      }
      sqliteState.sawCreate = false;
      return;
    }

    if (upperToken === 'BEGIN') {
      sqliteState.triggerBodyDepth += 1;
      return;
    }
    if (upperToken === 'END' && sqliteState.triggerBodyDepth > 0) {
      sqliteState.triggerBodyDepth -= 1;
    }
  };

  const pushCurrentStatement = () => {
    flushToken();
    const trimmed = current.trim();
    if (trimmed) {
      statements.push(trimmed);
    }
    current = '';
    if (dialect === 'sqlite') {
      resetSqliteStatementState();
    }
  };

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1] || '';

    if (inLineComment) {
      current += ch;
      i += 1;
      if (ch === '\n') inLineComment = false;
      continue;
    }

    if (inBlockComment) {
      current += ch;
      i += 1;
      if (ch === '*' && source[i] === '/') {
        current += '/';
        i += 1;
        inBlockComment = false;
      }
      continue;
    }

    if (dollarQuoteTag) {
      if (source.startsWith(dollarQuoteTag, i)) {
        current += dollarQuoteTag;
        i += dollarQuoteTag.length;
        dollarQuoteTag = null;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }

    if (inSingleQuote) {
      current += ch;
      i += 1;
      if (ch === '\'') {
        if (source[i] === '\'') {
          current += '\'';
          i += 1;
        } else {
          inSingleQuote = false;
        }
      }
      continue;
    }

    if (inDoubleQuote) {
      current += ch;
      i += 1;
      if (ch === '"') {
        if (source[i] === '"') {
          current += '"';
          i += 1;
        } else {
          inDoubleQuote = false;
        }
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      flushToken();
      current += '--';
      i += 2;
      inLineComment = true;
      continue;
    }

    if (ch === '/' && next === '*') {
      flushToken();
      current += '/*';
      i += 2;
      inBlockComment = true;
      continue;
    }

    if (ch === '\'') {
      flushToken();
      inSingleQuote = true;
      current += ch;
      i += 1;
      continue;
    }

    if (ch === '"') {
      flushToken();
      inDoubleQuote = true;
      current += ch;
      i += 1;
      continue;
    }

    if (dialect === 'postgres' && ch === '$') {
      const remainder = source.slice(i);
      const match = remainder.match(/^\$[A-Za-z_][A-Za-z0-9_]*\$/) || remainder.match(/^\$\$/);
      if (match) {
        flushToken();
        dollarQuoteTag = match[0];
        current += dollarQuoteTag;
        i += dollarQuoteTag.length;
        continue;
      }
    }

    if (/[A-Za-z0-9_]/.test(ch)) {
      token += ch;
      current += ch;
      i += 1;
      continue;
    }

    flushToken();
    if (ch === ';') {
      const inSqliteTriggerBody = dialect === 'sqlite' && sqliteState.inTrigger && sqliteState.triggerBodyDepth > 0;
      if (inSqliteTriggerBody) {
        current += ch;
        i += 1;
        continue;
      }
      pushCurrentStatement();
      i += 1;
      continue;
    }

    current += ch;
    i += 1;
  }

  flushToken();
  const tail = current.trim();
  if (tail) {
    statements.push(tail);
  }

  return statements;
}

/**
 * Get migrations that haven't been applied yet
 * @param {Object} db - Database instance
 * @returns {Promise<Array>} Pending migrations
 */
export async function getPendingMigrations(db) {
  const allMigrations = getMigrations();

  // Check if schema_version table exists
  const dbType = getDbType();
  let tableExists = false;

  if (dbType === 'sqlite') {
    const result = await db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
    );
    tableExists = result.rows.length > 0;
  } else {
    const result = await db.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'schema_version'
      ) as exists
    `);
    tableExists = result.rows[0].exists;
  }

  if (!tableExists) {
    // All migrations are pending
    return allMigrations;
  }

  // Get applied versions (+ descriptions when available)
  let appliedRows = [];
  try {
    const result = await db.query('SELECT version, description FROM schema_version ORDER BY version');
    appliedRows = normalizeSchemaVersionRows(result.rows || []);
  } catch {
    const result = await db.query('SELECT version FROM schema_version ORDER BY version');
    appliedRows = normalizeSchemaVersionRows(result.rows || []);
  }

  assertNoLegacySchemaVersionDrift(allMigrations, appliedRows);
  const appliedVersions = new Set(appliedRows.map((row) => row.version));

  // Filter to pending migrations
  return allMigrations.filter((migration) => {
    const version = normalizeVersion(migration?.version);
    return Number.isInteger(version) && !appliedVersions.has(version);
  });
}

/**
 * Execute SQLite SQL statement-by-statement with idempotent duplicate-column handling.
 *
 * NOTE: This is a fallback path only. We prefer executing the full SQL blob first,
 * because naive semicolon splitting can break valid SQLite constructs.
 *
 * @param {Object} sqliteDriver - SQLite driver module with exec()
 * @param {string} sql - SQL string potentially containing multiple statements
 */
async function safeSqliteExecByStatement(sqliteDriver, sql) {
  const statements = splitSqlStatements(sql, { dialect: 'sqlite' });
  for (const stmt of statements) {
    try {
      await sqliteDriver.exec(stmt, {
        suppressErrorPatterns: [/duplicate column name/i],
      });
    } catch (err) {
      // Ignore "duplicate column" errors for ALTER TABLE idempotency
      if (err.message && err.message.includes('duplicate column name')) {
        console.log(`  Skipping (column already exists): ${stmt.slice(0, 60)}...`);
        continue;
      }
      throw err; // Re-throw non-idempotency errors
    }
  }
}

/**
 * Apply a single migration
 * @param {Object} db - Database instance
 * @param {Object} migration - Migration object
 * @returns {Promise<void>}
 */
async function applyMigration(db, migration) {
  const dbType = getDbType();

  // Load the migration module if needed
  if (!migration.up && migration.module) {
    const mod = await migration.module();
    migration.up = mod.up;
  }

  if (!migration.up) {
    throw new Error(`Migration ${migration.version} has no up function`);
  }

  // Get the appropriate SQL or function for this database type
  const upStep = migration.up[dbType];
  if (!upStep) {
    throw new Error(`Migration ${migration.version} has no SQL for database type: ${dbType}`);
  }

  console.log(`Applying migration ${migration.version}: ${migration.name}`);

  // Execute the migration. Function-based steps run defensively against the db
  // facade (e.g. PRAGMA-guarded ALTER TABLE for SQLite); string-based steps run
  // through the dialect-aware executors below.
  if (typeof upStep === 'function') {
    await upStep(db);
  } else if (dbType === 'sqlite') {
    // SQLite: try full SQL blob first (robust for complex statements/triggers).
    // If this fails due duplicate-column idempotency, retry statement-by-statement
    // so only duplicate-column ALTER TABLE statements are skipped.
    const sqliteDriver = await import('../drivers/sqlite.js');
    try {
      await sqliteDriver.exec(upStep, {
        suppressErrorPatterns: [/duplicate column name/i],
      });
    } catch (error) {
      if (error.message && error.message.includes('duplicate column name')) {
        await safeSqliteExecByStatement(sqliteDriver, upStep);
      } else {
        throw error;
      }
    }
  } else {
    // PostgreSQL: Execute top-level statements while preserving dollar-quoted blocks.
    const statements = splitSqlStatements(upStep, { dialect: 'postgres' });

    for (const statement of statements) {
      await db.query(statement);
    }
  }

  // Record the migration
  await db.query(
    'INSERT INTO schema_version (version, description, applied_at) VALUES ($1, $2, $3)',
    [migration.version, migration.name, new Date().toISOString()]
  );

  console.log(`Migration ${migration.version} applied successfully`);
}

/**
 * Run all pending migrations
 * @param {Object} db - Database instance
 * @returns {Promise<number>} Number of migrations applied
 */
export async function runMigrations(db) {
  const pending = await getPendingMigrations(db);

  if (pending.length === 0) {
    console.log('No pending migrations');
    return 0;
  }

  console.log(`Found ${pending.length} pending migration(s)`);

  // Sort by version
  pending.sort((a, b) => a.version - b.version);

  for (const migration of pending) {
    await applyMigration(db, migration);
  }

  return pending.length;
}

/**
 * Get current schema version
 * @param {Object} db - Database instance
 * @returns {Promise<number|null>} Current version or null if not initialized
 */
export async function getCurrentVersion(db) {
  const dbType = getDbType();

  // Check if schema_version table exists
  let tableExists = false;

  if (dbType === 'sqlite') {
    const result = await db.query(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'"
    );
    tableExists = result.rows.length > 0;
  } else {
    const result = await db.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = 'schema_version'
      ) as exists
    `);
    tableExists = result.rows[0].exists;
  }

  if (!tableExists) {
    return null;
  }

  const result = await db.query('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1');
  return result.rows.length > 0 ? result.rows[0].version : 0;
}

export default {
  getMigrations,
  getPendingMigrations,
  runMigrations,
  getCurrentVersion,
  splitSqlStatements
};

export { splitSqlStatements };
