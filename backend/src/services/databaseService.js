/**
 * Database Provisioning Service
 * Automatically provisions isolated PostgreSQL databases for user projects
 */

import { query } from '../db/connection.js';
import crypto from 'crypto';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

class DatabaseService {
  constructor() {
    // PostgreSQL connection config from environment
    this.dbHost = process.env.DB_HOST || 'localhost';
    this.dbPort = process.env.DB_PORT || '5432';
    this.adminUser = process.env.DB_USER || 'postgres';
    this.adminPassword = process.env.DB_PASSWORD || '';
    this.dbName = process.env.DB_NAME || 'atlasengine_dev';
  }

  /**
   * Execute a PostgreSQL command as admin user
   * @param {string} sql - SQL command to execute
   * @param {string} database - Database to connect to (default: postgres)
   * @returns {Promise<Object>} Execution result
   */
  async execPsql(sql, database = 'postgres') {
    const cmd = `psql -U ${this.adminUser} -d ${database} -c "${sql.replace(/"/g, '\\"')}"`;
    try {
      const { stdout, stderr } = await execAsync(cmd);
      if (stderr && !stderr.includes('NOTICE')) {
        console.warn('psql stderr:', stderr);
      }
      return { success: true, stdout, stderr };
    } catch (error) {
      throw new Error(`psql command failed: ${error.message}`);
    }
  }

  /**
   * Generate secure random password for database user
   * @returns {string} Secure password
   */
  generatePassword() {
    return crypto.randomBytes(24).toString('base64').replace(/[^a-zA-Z0-9]/g, '');
  }

  /**
   * Sanitize project name for database naming
   * @param {string} name - Project name
   * @returns {string} Sanitized name
   */
  sanitizeName(name) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '_')
      .substring(0, 30); // Max 30 chars for sanitized portion
  }

  /**
   * Generate database and user names for a project
   * @param {string} projectId - Project UUID
   * @param {string} projectName - Project name
   * @returns {Object} Database and user names
   */
  generateNames(projectId, projectName) {
    const sanitized = this.sanitizeName(projectName);
    const shortId = projectId.substring(0, 8);

    return {
      dbName: `atlas_${sanitized}_${shortId}`,
      userName: `user_${shortId}`
    };
  }

  /**
   * Check if project needs a database by analyzing package.json
   * @param {string} packageJson - Contents of package.json
   * @returns {Object} Detection result
   */
  detectDatabaseNeed(packageJson) {
    try {
      const pkg = JSON.parse(packageJson);
      const allDeps = {
        ...pkg.dependencies,
        ...pkg.devDependencies
      };

      // Database-related dependencies
      const dbIndicators = {
        drizzle: ['drizzle-orm', 'drizzle-kit'],
        prisma: ['prisma', '@prisma/client'],
        typeorm: ['typeorm'],
        postgres: ['pg', '@neondatabase/serverless', 'postgres'],
        mysql: ['mysql', 'mysql2'],
        mongodb: ['mongodb', 'mongoose']
      };

      for (const [type, packages] of Object.entries(dbIndicators)) {
        for (const pkg of packages) {
          if (allDeps[pkg]) {
            return {
              needsDatabase: true,
              type,
              package: pkg
            };
          }
        }
      }

      return { needsDatabase: false };
    } catch (error) {
      console.error('Failed to parse package.json:', error.message);
      return { needsDatabase: false };
    }
  }

  /**
   * Provision a new PostgreSQL database for a project
   * @param {string} projectId - Project UUID
   * @param {string} projectName - Project name
   * @returns {Promise<Object>} Database credentials
   */
  async provisionDatabase(projectId, projectName) {
    const { dbName, userName } = this.generateNames(projectId, projectName);
    const password = this.generatePassword();

    try {
      console.log(`🗄️  Provisioning database for project ${projectName} (${projectId})`);

      // Create database
      console.log(`📊 Creating database: ${dbName}`);
      await this.execPsql(`CREATE DATABASE ${dbName}`);

      // Create user with password
      console.log(`👤 Creating database user: ${userName}`);
      await this.execPsql(`CREATE USER ${userName} WITH PASSWORD '${password}'`);

      // Grant privileges
      console.log(`🔑 Granting privileges to ${userName} on ${dbName}`);
      await this.execPsql(`GRANT ALL PRIVILEGES ON DATABASE ${dbName} TO ${userName}`);

      // Connect to the new database and grant schema privileges
      await this.execPsql(`GRANT ALL ON SCHEMA public TO ${userName}`, dbName);
      await this.execPsql(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${userName}`, dbName);
      await this.execPsql(`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO ${userName}`, dbName);

      // Set default privileges for future tables
      await this.execPsql(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${userName}`, dbName);
      await this.execPsql(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${userName}`, dbName);

      // Construct DATABASE_URL
      const databaseUrl = `postgresql://${userName}:${password}@${this.dbHost}:${this.dbPort}/${dbName}`;

      console.log(`✅ Database provisioned successfully: ${dbName}`);

      return {
        success: true,
        dbName,
        userName,
        password,
        databaseUrl,
        host: this.dbHost,
        port: this.dbPort
      };
    } catch (error) {
      console.error(`Failed to provision database for ${projectId}:`, error);

      // Attempt cleanup on error
      try {
        await this.dropDatabase(projectId, dbName, userName);
      } catch (cleanupError) {
        console.error('Cleanup after provision failure also failed:', cleanupError);
      }

      throw new Error(`Database provisioning failed: ${error.message}`);
    }
  }

  /**
   * Drop a database and user
   * @param {string} projectId - Project UUID
   * @param {string} dbName - Database name (optional, will be generated if not provided)
   * @param {string} userName - User name (optional, will be generated if not provided)
   * @returns {Promise<Object>} Cleanup result
   */
  async dropDatabase(projectId, dbName = null, userName = null) {
    try {
      // If names not provided, try to get from database
      if (!dbName || !userName) {
        const result = await query(
          'SELECT database_name, database_user FROM projects WHERE id = $1',
          [projectId]
        );

        if (result.rows.length > 0) {
          dbName = result.rows[0].database_name;
          userName = result.rows[0].database_user;
        }
      }

      if (!dbName || !userName) {
        console.warn(`No database found for project ${projectId}`);
        return { success: false, message: 'No database to drop' };
      }

      console.log(`🗑️  Dropping database ${dbName} and user ${userName}`);

      // Terminate active connections to the database
      await this.execPsql(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${dbName}'`
      );

      // Drop database
      await this.execPsql(`DROP DATABASE IF EXISTS ${dbName}`);
      console.log(`✅ Dropped database: ${dbName}`);

      // Drop user
      await this.execPsql(`DROP USER IF EXISTS ${userName}`);
      console.log(`✅ Dropped user: ${userName}`);

      // Update project record
      await query(
        `UPDATE projects
         SET database_provisioned = FALSE,
             database_name = NULL,
             database_user = NULL,
             database_url = NULL
         WHERE id = $1`,
        [projectId]
      );

      return { success: true, message: 'Database and user dropped successfully' };
    } catch (error) {
      console.error(`Failed to drop database for ${projectId}:`, error);
      throw new Error(`Database cleanup failed: ${error.message}`);
    }
  }

  /**
   * Get database info for a project
   * @param {string} projectId - Project UUID
   * @returns {Promise<Object>} Database info
   */
  async getDatabaseInfo(projectId) {
    const result = await query(
      `SELECT database_name, database_user, database_url, database_provisioned
       FROM projects
       WHERE id = $1`,
      [projectId]
    );

    if (result.rows.length === 0) {
      return null;
    }

    const row = result.rows[0];
    return {
      provisioned: row.database_provisioned,
      dbName: row.database_name,
      userName: row.database_user,
      databaseUrl: row.database_url
    };
  }

  /**
   * Update project with database credentials
   * @param {string} projectId - Project UUID
   * @param {Object} credentials - Database credentials
   * @returns {Promise<void>}
   */
  async updateProjectDatabase(projectId, credentials) {
    await query(
      `UPDATE projects
       SET database_provisioned = TRUE,
           database_name = $1,
           database_user = $2,
           database_url = $3,
           updated_at = NOW()
       WHERE id = $4`,
      [credentials.dbName, credentials.userName, credentials.databaseUrl, projectId]
    );
  }
}

// Singleton instance
const databaseService = new DatabaseService();

export default databaseService;
