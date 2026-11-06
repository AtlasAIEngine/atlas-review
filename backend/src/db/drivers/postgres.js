/**
 * PostgreSQL Driver
 * Implements async database interface using node-postgres (pg)
 */

import pg from 'pg';
// Environment variables are loaded by server.js at startup.

const { Pool } = pg;

function resolveDatabaseUrlConfig() {
  const rawUrl = process.env.DATABASE_URL;
  if (!rawUrl) return null;

  try {
    const parsed = new URL(rawUrl);
    return {
      host: parsed.hostname,
      port: parsed.port ? parseInt(parsed.port, 10) : 5432,
      database: parsed.pathname ? parsed.pathname.replace(/^\//, '') : undefined,
      user: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
      ssl: process.env.NODE_ENV === 'production'
        ? { rejectUnauthorized: false }
        : false,
    };
  } catch (error) {
    console.warn('Failed to parse DATABASE_URL, falling back to DB_* variables:', error?.message || error);
    return null;
  }
}

const databaseUrlConfig = resolveDatabaseUrlConfig();

// Database configuration
const dbConfig = {
  host: databaseUrlConfig?.host || process.env.DB_HOST || 'localhost',
  port: databaseUrlConfig?.port || parseInt(process.env.DB_PORT || '5432', 10),
  database: databaseUrlConfig?.database || process.env.DB_NAME || 'atlasengine',
  user: databaseUrlConfig?.user || process.env.DB_USER || 'atlasengine',
  password: databaseUrlConfig?.password || process.env.DB_PASSWORD,

  // Connection pool settings
  max: 20,                    // Maximum number of clients in pool
  idleTimeoutMillis: 30000,   // Close idle clients after 30 seconds
  connectionTimeoutMillis: 5000, // Wait 5 seconds for connection

  // SSL configuration (enable in production)
  ssl: databaseUrlConfig?.ssl || (process.env.NODE_ENV === 'production' ? {
    rejectUnauthorized: false
  } : false)
};

// Create connection pool
let pool = null;

/**
 * Get or create the connection pool
 */
function getPoolInstance() {
  if (!pool) {
    pool = new Pool(dbConfig);

    // Pool error handler
    pool.on('error', (err, client) => {
      console.error('Unexpected error on idle PostgreSQL client', err);
      process.exit(-1);
    });

    // Pool connection event
    pool.on('connect', (client) => {
      if (process.env.NODE_ENV === 'development') {
        console.log('PostgreSQL client connected');
      }
    });

    // Pool removal event
    pool.on('remove', (client) => {
      if (process.env.NODE_ENV === 'development') {
        console.log('PostgreSQL client removed from pool');
      }
    });
  }
  return pool;
}

/**
 * Execute a query with automatic error handling
 * @param {string} text - SQL query text
 * @param {Array} params - Query parameters
 * @returns {Promise<Object>} Query result
 */
export async function query(text, params) {
  const start = Date.now();
  const poolInstance = getPoolInstance();

  try {
    const result = await poolInstance.query(text, params);
    const duration = Date.now() - start;

    if (process.env.NODE_ENV === 'development') {
      console.log('Executed query', { text: text.substring(0, 100), duration, rows: result.rowCount });
    }

    return result;
  } catch (error) {
    console.error('Database query error:', {
      query: text,
      params,
      error: error.message
    });
    throw error;
  }
}

/**
 * Get a client from the pool for transactions
 * @returns {Promise<Object>} Database client
 */
export async function getClient() {
  const poolInstance = getPoolInstance();
  const client = await poolInstance.connect();

  // Add query method with logging
  const originalQuery = client.query.bind(client);
  client.query = (...args) => {
    const start = Date.now();
    const result = originalQuery(...args);
    if (!result || typeof result.then !== 'function') {
      return result;
    }
    return result.then(result => {
      const duration = Date.now() - start;
      if (process.env.NODE_ENV === 'development') {
        console.log('Transaction query', { duration, rows: result.rowCount });
      }
      return result;
    });
  };

  return client;
}

/**
 * Execute a transaction
 * @param {Function} callback - Async function to execute in transaction
 * @returns {Promise<any>} Transaction result
 */
export async function transaction(callback) {
  const client = await getClient();

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('Transaction error:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get the connection pool (for advanced usage)
 * @returns {Pool} PostgreSQL connection pool
 */
export function getPool() {
  return getPoolInstance();
}

/**
 * Check database connection health
 * @returns {Promise<Object>} Health check result
 */
export async function healthCheck() {
  try {
    const result = await query('SELECT NOW() as now, version() as version');
    const poolInstance = getPoolInstance();
    return {
      healthy: true,
      timestamp: result.rows[0].now,
      version: result.rows[0].version,
      poolStats: {
        total: poolInstance.totalCount,
        idle: poolInstance.idleCount,
        waiting: poolInstance.waitingCount
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

/**
 * Initialize database - run migrations
 * @returns {Promise<boolean>} Success status
 */
export async function initialize() {
  try {
    // Always run migrations. The migration runner handles both empty databases
    // and already-initialized schemas via the baseline `schema_version` table.
    const { runMigrations } = await import('../migrations/index.js');
    const dbFacade = {
      query: (text, params) => query(text, params),
      getDbType: () => 'postgres',
    };
    const applied = await runMigrations(dbFacade);
    if (applied > 0) {
      console.log(`Applied ${applied} migration(s)`);
    }

    const versionResult = await query('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1');
    if (versionResult.rows.length > 0) {
      console.log(`Schema version: ${versionResult.rows[0].version}`);
    }

    return true;
  } catch (error) {
    console.error('Database initialization check failed:', error);
    return false;
  }
}

/**
 * Close all database connections gracefully
 * @returns {Promise<void>}
 */
export async function close() {
  if (pool) {
    try {
      await pool.end();
      pool = null;
      console.log('Database pool closed gracefully');
    } catch (error) {
      console.error('Error closing database pool:', error);
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
  close
};
