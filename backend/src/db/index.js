/**
 * Database Abstraction Layer
 *
 * Provides a unified async interface for both PostgreSQL and SQLite databases.
 * Database type is controlled by ATLAS_DB_TYPE environment variable:
 *   - 'postgres' (default): Use PostgreSQL
 *   - 'sqlite': Use SQLite for desktop/self-hosted mode
 *
 * All methods return Promises for a consistent async interface.
 */

// Environment variables are loaded by server.js at startup.
// Do NOT call dotenv.config() here — it would load CWD's .env and
// override the desktop-mode scoped loading in server.js.

// Read database type lazily so dotenv.config() in server.js has time to run
// before the value is captured.  ES module imports are evaluated before any
// top-level code in the importing module, so reading process.env at module
// evaluation time would always see 'undefined' and fall back to 'postgres'.
function resolveDbType() {
  return process.env.ATLAS_DB_TYPE || 'postgres';
}

// Lazy-loaded driver reference
let driver = null;
let initializationPromise = null;

/**
 * Get the appropriate database driver
 * Lazy-loads the driver on first access
 * @returns {Promise<Object>} Database driver module
 */
async function getDriver() {
  if (driver) {
    return driver;
  }

  if (resolveDbType() === 'sqlite') {
    driver = await import('./drivers/sqlite.js');
    // Initialize SQLite on first load
    await driver.initialize();
  } else {
    driver = await import('./drivers/postgres.js');
  }

  return driver;
}

/**
 * Execute a query
 * @param {string} text - SQL query text
 * @param {Array} params - Query parameters
 * @returns {Promise<Object>} Query result with rows and rowCount
 */
export async function query(text, params) {
  const d = await getDriver();
  return d.query(text, params);
}

/**
 * Get a client for transactions
 * @returns {Promise<Object>} Database client
 */
export async function getClient() {
  const d = await getDriver();
  return d.getClient();
}

/**
 * Execute a transaction
 * @param {Function} callback - Async function to execute in transaction
 * @returns {Promise<any>} Transaction result
 */
export async function transaction(callback) {
  const d = await getDriver();
  return d.transaction(callback);
}

/**
 * Get the connection pool (PostgreSQL only)
 * @returns {Object} PostgreSQL connection pool
 * @throws {Error} If using SQLite - pool not available
 */
export function getPool() {
  // Synchronous check - if we've loaded SQLite, throw
  if (resolveDbType() === 'sqlite') {
    throw new Error(
      'Pool unavailable in SQLite mode. Use db.query() or db.transaction() instead. ' +
      'If you need pool-specific functionality, ensure ATLAS_DB_TYPE=postgres.'
    );
  }

  // For PostgreSQL, we need to get pool synchronously
  // This is a bit of a hack, but pool access is synchronous in pg
  if (!driver) {
    // Driver not yet loaded, import synchronously for pool access
    // This only happens if getPool() is called before any async method
    const pg = require('pg');
    const Pool = pg.Pool;
    const dbConfig = {
      host: process.env.DB_HOST || 'localhost',
      port: parseInt(process.env.DB_PORT || '5432', 10),
      database: process.env.DB_NAME || 'atlasengine',
      user: process.env.DB_USER || 'atlasengine',
      password: process.env.DB_PASSWORD,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
    };
    return new Pool(dbConfig);
  }

  return driver.getPool();
}

/**
 * Check database connection health
 * @returns {Promise<Object>} Health check result
 */
export async function healthCheck() {
  const d = await getDriver();
  return d.healthCheck();
}

/**
 * Initialize the database (run migrations, check schema)
 * @returns {Promise<boolean>} Success status
 */
export async function initialize() {
  if (!initializationPromise) {
    initializationPromise = (async () => {
      try {
        const d = await getDriver();
        const initialized = await d.initialize();
        if (!initialized) {
          initializationPromise = null;
        }
        return initialized;
      } catch (error) {
        initializationPromise = null;
        throw error;
      }
    })();
  }

  return initializationPromise;
}

/**
 * Close all database connections gracefully
 * @returns {Promise<void>}
 */
export async function close() {
  if (driver) {
    await driver.close();
    driver = null;
  }
  initializationPromise = null;
}

/**
 * Get the current database type
 * @returns {string} 'postgres' or 'sqlite'
 */
export function getDbType() {
  return resolveDbType();
}

// Default export for backward compatibility
export default {
  query,
  getClient,
  transaction,
  getPool,
  healthCheck,
  initialize,
  close,
  getDbType
};
