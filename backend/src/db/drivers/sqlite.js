/**
 * SQLite Driver
 * Implements async database interface using better-sqlite3
 *
 * Note: better-sqlite3 is synchronous, but we wrap calls in Promise.resolve()
 * to maintain a consistent async interface with the PostgreSQL driver.
 */

import { convertParams } from '../paramConverter.js';
import { getDbPath } from '../../config/paths.js';
import fs from 'fs';
import path from 'path';

let db = null;
let initialized = false;

/**
 * Get or create the SQLite database instance
 * @returns {Object} better-sqlite3 database instance
 */
function getDbInstance() {
  if (!db) {
    // Dynamic import for better-sqlite3 (native module)
    // This will be called lazily when SQLite is actually needed
    throw new Error('SQLite database not initialized. Call initialize() first.');
  }
  return db;
}

/**
 * Initialize the SQLite database
 * @returns {Promise<boolean>} Success status
 */
export async function initialize() {
  if (initialized) {
    return true;
  }

  try {
    // Dynamic import for better-sqlite3
    const Database = (await import('better-sqlite3')).default;

    const dbPath = getDbPath();

    // Ensure directory exists
    const dbDir = path.dirname(dbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
      console.log(`Created database directory: ${dbDir}`);
    }

    // Create database connection
    db = new Database(dbPath, {
      verbose: process.env.NODE_ENV === 'development' ? console.log : null
    });

    // Set pragmas for performance and safety
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');

    console.log(`SQLite database initialized at: ${dbPath}`);
    initialized = true;

    // Apply the shipped launch baseline for fresh installs.
    const { runMigrations } = await import('../migrations/index.js');
    const db_facade = {
      query: (text, params) => query(text, params),
      getDbType: () => 'sqlite'
    };
    const applied = await runMigrations(db_facade);
    if (applied > 0) {
      console.log(`Applied ${applied} launch baseline step(s)`);
    } else {
      console.log('Launch baseline already present');
    }

    return true;
  } catch (error) {
    console.error('SQLite initialization failed:', error);
    return false;
  }
}

/**
 * Convert PostgreSQL-specific SQL to SQLite-compatible SQL
 * @param {string} sql - PostgreSQL SQL
 * @returns {string} SQLite-compatible SQL
 */
function convertPostgresToSqlite(sql) {
  let result = sql;

  // Replace NOW() with datetime('now')
  result = result.replace(/\bNOW\(\)/gi, "datetime('now')");

  // Replace date_trunc('month', ...) with date(..., 'start of month')
  result = result.replace(/date_trunc\s*\(\s*'month'\s*,\s*([^)]+)\)/gi, "date($1, 'start of month')");

  // Replace EXTRACT(EPOCH FROM (expr)) with (julianday(expr) * 86400)
  // This is a simplified version - may need adjustment for complex expressions
  result = result.replace(/EXTRACT\s*\(\s*EPOCH\s+FROM\s+\(([^)]+)\)\s*\)/gi, "(strftime('%s', $1))");

  return result;
}

/**
 * Execute a query
 * @param {string} text - SQL query text (PostgreSQL-style $N placeholders)
 * @param {Array} params - Query parameters
 * @returns {Promise<Object>} Query result with rows and rowCount
 */
export async function query(text, params = []) {
  const dbInstance = getDbInstance();
  const start = Date.now();

  // Convert $1, $2, ... to ? placeholders
  let { sql, params: convertedParams } = convertParams(text, params);

  // Convert PostgreSQL-specific syntax to SQLite
  sql = convertPostgresToSqlite(sql);

  try {
    // Detect query type
    const trimmed = sql.trim().toUpperCase();
    const isSelect = trimmed.startsWith('SELECT');
    const isPragma = trimmed.startsWith('PRAGMA');
    const isExplain = trimmed.startsWith('EXPLAIN');
    const isInsert = trimmed.startsWith('INSERT');
    const isReturning = trimmed.includes('RETURNING');

    let result;

    if (isSelect || isPragma || isExplain || isReturning) {
      // Use all() for SELECT queries and queries with RETURNING
      const stmt = dbInstance.prepare(sql);
      const rows = stmt.all(...convertedParams);
      result = {
        rows,
        rowCount: rows.length
      };
    } else {
      // Use run() for INSERT, UPDATE, DELETE without RETURNING
      const stmt = dbInstance.prepare(sql);
      const info = stmt.run(...convertedParams);
      result = {
        rows: [],
        rowCount: info.changes,
        lastInsertRowid: info.lastInsertRowid
      };
    }

    const duration = Date.now() - start;

    if (process.env.NODE_ENV === 'development') {
      console.log('Executed query', { sql: sql.substring(0, 100), duration, rows: result.rowCount });
    }

    return result;
  } catch (error) {
    console.error('SQLite query error:', {
      query: sql,
      params: convertedParams,
      error: error.message
    });
    throw error;
  }
}

/**
 * Get a client for transactions
 * SQLite doesn't have a connection pool, so we return a wrapper
 * @returns {Promise<Object>} Client-like object
 */
export async function getClient() {
  const dbInstance = getDbInstance();

  // Return a client-like object that wraps the SQLite instance
  const client = {
    query: async (text, params = []) => {
      return query(text, params);
    },
    release: () => {
      // No-op for SQLite - no pool to release to
    }
  };

  return client;
}

/**
 * Execute a transaction
 * @param {Function} callback - Async function to execute in transaction
 * @returns {Promise<any>} Transaction result
 */
export async function transaction(callback) {
  const dbInstance = getDbInstance();
  const client = await getClient();

  try {
    dbInstance.exec('BEGIN IMMEDIATE');
    const result = await callback(client);
    dbInstance.exec('COMMIT');
    return result;
  } catch (error) {
    dbInstance.exec('ROLLBACK');
    console.error('Transaction error:', error);
    throw error;
  }
}

/**
 * Get the connection pool
 * SQLite doesn't use a pool, so this throws an error
 * @throws {Error} Pool not available in SQLite mode
 */
export function getPool() {
  throw new Error(
    'Pool unavailable in SQLite mode. Use db.query() or db.transaction() instead. ' +
    'If you need pool-specific functionality, ensure ATLAS_DB_TYPE=postgres.'
  );
}

/**
 * Check database connection health
 * @returns {Promise<Object>} Health check result
 */
export async function healthCheck() {
  try {
    const result = await query("SELECT datetime('now') as now, sqlite_version() as version");
    return {
      healthy: true,
      timestamp: result.rows[0].now,
      version: `SQLite ${result.rows[0].version}`,
      poolStats: {
        total: 1,
        idle: 1,
        waiting: 0
      }
    };
  } catch (error) {
    console.error('Database health check failed:', error);
    return {
      healthy: false,
      error: error.message
    };
  }
}

function normalizeSuppressionPatterns(patterns) {
  if (!Array.isArray(patterns)) return [];
  return patterns
    .map((pattern) => {
      if (pattern instanceof RegExp) return pattern;
      const text = String(pattern || '').trim();
      return text ? new RegExp(text, 'i') : null;
    })
    .filter((pattern) => pattern instanceof RegExp);
}

/**
 * Execute multiple SQL statements (for migrations)
 * @param {string} sql - SQL with multiple statements separated by semicolons
 * @param {Object} [options]
 * @param {Array<string|RegExp>} [options.suppressErrorPatterns] - Error-message patterns that should not be logged
 * @returns {Promise<void>}
 */
export async function exec(sql, options = {}) {
  const dbInstance = getDbInstance();
  const suppressionPatterns = normalizeSuppressionPatterns(options.suppressErrorPatterns);
  try {
    dbInstance.exec(sql);
    return { success: true };
  } catch (error) {
    const message = String(error?.message || '');
    const shouldSuppress = suppressionPatterns.some((pattern) => pattern.test(message));
    if (!shouldSuppress) {
      console.error('SQLite exec error:', message);
    }
    throw error;
  }
}

/**
 * Close the database connection gracefully
 * @returns {Promise<void>}
 */
export async function close() {
  if (db) {
    try {
      db.close();
      db = null;
      initialized = false;
      console.log('SQLite database closed gracefully');
    } catch (error) {
      console.error('Error closing SQLite database:', error);
      throw error;
    }
  }
}

export default {
  query,
  getClient,
  transaction,
  getPool,
  healthCheck,
  initialize,
  close,
  exec
};
