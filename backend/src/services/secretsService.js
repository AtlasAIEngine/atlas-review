/**
 * Secrets Service
 * Manages project environment variables and secrets
 *
 * Features:
 * - CRUD operations for project secrets
 * - Bulk import from .env file format
 * - Value masking for display (truncated values)
 * - Environment scoping (production, preview, development)
 */

import { query } from '../db/connection.js';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Parse .env file content into key-value pairs
 * Handles quoted values, comments, empty lines, and multi-line values
 *
 * @param {string} content - Raw .env file content
 * @returns {Array<{key: string, value: string}>} Parsed key-value pairs
 */
function parseEnvFile(content) {
  const result = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Skip empty lines and comments
    if (!line || line.startsWith('#')) {
      continue;
    }

    // Find the first = sign
    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) {
      continue;
    }

    const key = line.substring(0, eqIndex).trim();
    let value = line.substring(eqIndex + 1);

    // Skip if key is empty or invalid
    if (!key || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    // Handle quoted values
    value = value.trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      // Remove quotes and handle escape sequences for double quotes
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') {
        value = value
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '\r')
          .replace(/\\t/g, '\t')
          .replace(/\\\\/g, '\\')
          .replace(/\\"/g, '"');
      }
    } else {
      // Unquoted: strip inline comments
      const commentIndex = value.indexOf(' #');
      if (commentIndex !== -1) {
        value = value.substring(0, commentIndex).trim();
      }
    }

    result.push({ key, value });
  }

  return result;
}

/**
 * Mask a secret value for display
 * Shows first and last 2 characters with dots in between
 *
 * @param {string} value - Original value
 * @param {boolean} isSecret - Whether to mask the value
 * @returns {string} Masked or original value
 */
function maskValue(value, isSecret) {
  if (!isSecret || !value) {
    return value;
  }

  if (value.length <= 8) {
    return '*'.repeat(value.length);
  }

  return value.slice(0, 2) + '*'.repeat(Math.min(value.length - 4, 20)) + value.slice(-2);
}

// ============================================================================
// SERVICE FUNCTIONS
// ============================================================================

/**
 * List all secrets for a project
 * Values are masked for display (truncated)
 *
 * @param {string} projectId - Project UUID
 * @param {string} environment - Environment filter (default: 'production')
 * @returns {Promise<Array>} List of secrets with masked values
 */
async function listSecrets(projectId, environment = 'production') {
  const result = await query(
    `SELECT id, project_id, key, value, is_secret, environment, created_at, updated_at
     FROM project_secrets
     WHERE project_id = $1 AND environment = $2
     ORDER BY key ASC`,
    [projectId, environment]
  );

  return result.rows.map(row => ({
    id: row.id,
    projectId: row.project_id,
    key: row.key,
    value: maskValue(row.value, row.is_secret),
    isSecret: row.is_secret,
    environment: row.environment,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/**
 * Get a single secret by ID
 * Returns full value (for internal use only)
 *
 * @param {string} projectId - Project UUID
 * @param {string} secretId - Secret UUID
 * @returns {Promise<Object|null>} Secret object or null
 */
async function getSecret(projectId, secretId) {
  const result = await query(
    `SELECT id, project_id, key, value, is_secret, environment, created_at, updated_at
     FROM project_secrets
     WHERE id = $1 AND project_id = $2`,
    [secretId, projectId]
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: row.id,
    projectId: row.project_id,
    key: row.key,
    value: row.value, // Full value for internal use
    isSecret: row.is_secret,
    environment: row.environment,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Create a new secret
 *
 * @param {Object} params - Secret parameters
 * @param {string} params.projectId - Project UUID
 * @param {string} params.key - Environment variable name
 * @param {string} params.value - Secret value
 * @param {boolean} params.isSecret - Whether to mask in UI (default: true)
 * @param {string} params.environment - Environment scope (default: 'production')
 * @returns {Promise<Object>} Created secret (value masked)
 */
async function createSecret({ projectId, key, value, isSecret = true, environment = 'production' }) {
  const result = await query(
    `INSERT INTO project_secrets (project_id, key, value, is_secret, environment)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, project_id, key, value, is_secret, environment, created_at, updated_at`,
    [projectId, key, value, isSecret, environment]
  );

  const row = result.rows[0];
  return {
    id: row.id,
    projectId: row.project_id,
    key: row.key,
    value: maskValue(row.value, row.is_secret),
    isSecret: row.is_secret,
    environment: row.environment,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Update an existing secret
 *
 * @param {string} secretId - Secret UUID
 * @param {Object} updates - Fields to update
 * @param {string} updates.key - New key (optional)
 * @param {string} updates.value - New value (optional)
 * @param {boolean} updates.isSecret - New isSecret flag (optional)
 * @returns {Promise<Object>} Updated secret (value masked)
 */
async function updateSecret(secretId, { key, value, isSecret }) {
  const updates = [];
  const values = [];
  let paramIndex = 1;

  if (key !== undefined) {
    updates.push(`key = $${paramIndex}`);
    values.push(key);
    paramIndex++;
  }

  if (value !== undefined) {
    updates.push(`value = $${paramIndex}`);
    values.push(value);
    paramIndex++;
  }

  if (isSecret !== undefined) {
    updates.push(`is_secret = $${paramIndex}`);
    values.push(isSecret);
    paramIndex++;
  }

  if (updates.length === 0) {
    throw new Error('No fields to update');
  }

  values.push(secretId);

  const result = await query(
    `UPDATE project_secrets
     SET ${updates.join(', ')}
     WHERE id = $${paramIndex}
     RETURNING id, project_id, key, value, is_secret, environment, created_at, updated_at`,
    values
  );

  if (result.rows.length === 0) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: row.id,
    projectId: row.project_id,
    key: row.key,
    value: maskValue(row.value, row.is_secret),
    isSecret: row.is_secret,
    environment: row.environment,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Delete a secret
 *
 * @param {string} secretId - Secret UUID
 * @returns {Promise<boolean>} True if deleted, false if not found
 */
async function deleteSecret(secretId) {
  const result = await query(
    `DELETE FROM project_secrets WHERE id = $1 RETURNING id`,
    [secretId]
  );

  return result.rows.length > 0;
}

/**
 * Import secrets from .env file content
 * Performs upsert - updates existing keys, creates new ones
 *
 * @param {string} projectId - Project UUID
 * @param {string} envContent - Raw .env file content
 * @param {string} environment - Environment scope (default: 'production')
 * @returns {Promise<{created: number, updated: number, errors: string[]}>}
 */
async function importFromEnv(projectId, envContent, environment = 'production') {
  const parsed = parseEnvFile(envContent);
  let created = 0;
  let updated = 0;
  const errors = [];

  for (const { key, value } of parsed) {
    try {
      // Try to insert, on conflict update
      const result = await query(
        `INSERT INTO project_secrets (project_id, key, value, is_secret, environment)
         VALUES ($1, $2, $3, true, $4)
         ON CONFLICT (project_id, key, environment)
         DO UPDATE SET value = $3, updated_at = NOW()
         RETURNING (xmax = 0) AS inserted`,
        [projectId, key, value, environment]
      );

      if (result.rows[0].inserted) {
        created++;
      } else {
        updated++;
      }
    } catch (error) {
      errors.push(`Failed to import ${key}: ${error.message}`);
    }
  }

  return { created, updated, errors };
}

/**
 * Get all secrets for deployment
 * Returns full values (for Vercel sync, Docker build, etc.)
 *
 * @param {string} projectId - Project UUID
 * @param {string} environment - Environment scope (default: 'production')
 * @returns {Promise<Array<{key: string, value: string}>>} Secrets with full values
 */
async function getSecretsForDeploy(projectId, environment = 'production') {
  const result = await query(
    `SELECT key, value
     FROM project_secrets
     WHERE project_id = $1 AND environment = $2
     ORDER BY key ASC`,
    [projectId, environment]
  );

  return result.rows.map(row => ({
    key: row.key,
    value: row.value,
  }));
}

// ============================================================================
// EXPORTS
// ============================================================================

export default {
  // Helpers
  parseEnvFile,
  maskValue,

  // CRUD
  listSecrets,
  getSecret,
  createSecret,
  updateSecret,
  deleteSecret,

  // Bulk operations
  importFromEnv,

  // Deployment
  getSecretsForDeploy,
};

export {
  parseEnvFile,
  maskValue,
  listSecrets,
  getSecret,
  createSecret,
  updateSecret,
  deleteSecret,
  importFromEnv,
  getSecretsForDeploy,
};
