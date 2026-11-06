/**
 * Database Connection - Compatibility Layer
 *
 * Re-exports from the database abstraction layer (./index.js) for backward compatibility.
 * This file maintains the original API while allowing the underlying implementation
 * to switch between PostgreSQL and SQLite based on ATLAS_DB_TYPE environment variable.
 *
 * IMPORTANT: Direct pool access (db.pool) will throw an error in SQLite mode.
 * Use db.query() or db.transaction() instead for database-agnostic code.
 */

import db, {
  query,
  getClient,
  transaction,
  healthCheck,
  initialize,
  close,
  getPool,
  getDbType
} from './index.js';

// Re-export all async methods
export { query, getClient, transaction, healthCheck, initialize, close, getDbType };

/**
 * Get the connection pool (PostgreSQL only)
 *
 * WARNING: This will throw an error in SQLite mode.
 * For database-agnostic code, use db.query() instead.
 *
 * @returns {Object} PostgreSQL connection pool
 * @throws {Error} If using SQLite mode
 */
export function getPoolSafe() {
  return getPool();
}

/**
 * Legacy pool export
 *
 * Returns a proxy that throws a helpful error if accessed in SQLite mode.
 * In PostgreSQL mode, returns the actual pool.
 */
const poolProxy = new Proxy({}, {
  get(target, prop) {
    const dbType = getDbType();
    if (dbType === 'sqlite') {
      throw new Error(
        `Cannot access pool.${String(prop)} in SQLite mode. ` +
        'Use db.query() or db.transaction() instead. ' +
        'Set ATLAS_DB_TYPE=postgres if you need direct pool access.'
      );
    }
    // In PostgreSQL mode, get the actual pool
    try {
      const pool = getPool();
      return pool[prop];
    } catch (e) {
      throw new Error(
        `Cannot access pool: ${e.message}. ` +
        'Ensure database is initialized before accessing pool.'
      );
    }
  },
  apply(target, thisArg, args) {
    const dbType = getDbType();
    if (dbType === 'sqlite') {
      throw new Error(
        'Cannot call pool methods in SQLite mode. ' +
        'Use db.query() or db.transaction() instead.'
      );
    }
    const pool = getPool();
    return pool.apply(thisArg, args);
  }
});

// Export pool proxy for backward compatibility
// Code that imports { pool } from './connection.js' will get this proxy
export const pool = poolProxy;

// Default export includes all methods
export default {
  query,
  getClient,
  transaction,
  healthCheck,
  initialize,
  close,
  pool: poolProxy,
  getDbType
};
