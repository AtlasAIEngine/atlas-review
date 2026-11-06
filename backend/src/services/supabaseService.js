/**
 * Supabase Service
 * Manages Supabase Personal Access Token (PAT) storage, Management API
 * interactions, and project linking.
 *
 * Users generate a PAT at https://supabase.com/dashboard/account/tokens
 * and paste it into the Settings panel. The token is encrypted at rest.
 *
 * Environment Requirements:
 * - ENCRYPTION_KEY: 32-byte base64-encoded encryption key
 */

import db from '../db/connection.js';
import { encrypt, decrypt } from '../utils/encryption.js';
import { detectFrameworkType, SUPABASE_ENV_VAR_MAP } from './integrationsService.js';
import fs from 'fs/promises';
import path from 'path';

const SUPABASE_API_BASE = 'https://api.supabase.com';

class SupabaseService {
  // ---------------------------------------------------------------------------
  // Token management
  // ---------------------------------------------------------------------------

  /**
   * Get the decrypted access token for a user.
   * @param {string} userId
   * @returns {Promise<string>} Decrypted PAT
   */
  async getAccessToken(userId) {
    const integration = await this.getIntegration(userId);
    if (!integration) {
      throw new Error('Supabase not connected. Please add your access token in Settings.');
    }
    return decrypt(integration.access_token_encrypted);
  }

  /**
   * Store a PAT for a user. Deactivates any previous token first.
   * @param {string} userId
   * @param {string} accessToken - The plaintext PAT
   */
  async storeToken(userId, accessToken) {
    const accessEncrypted = encrypt(accessToken);
    const farFuture = '2099-12-31T23:59:59.000Z';

    await db.query('BEGIN');
    try {
      // Deactivate previous rows
      await db.query(
        `UPDATE supabase_integrations SET is_active = FALSE WHERE user_id = $1`,
        [userId]
      );

      await db.query(
        `INSERT INTO supabase_integrations
          (user_id, access_token_encrypted, refresh_token_encrypted, token_expires_at, is_active)
         VALUES ($1, $2, $3, $4, TRUE)`,
        [userId, accessEncrypted, accessEncrypted, farFuture]
      );

      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
  }

  /**
   * Validate a PAT by making a lightweight API call.
   * @param {string} accessToken - Plaintext PAT
   * @returns {Promise<boolean>}
   */
  async validateToken(accessToken) {
    const res = await fetch(`${SUPABASE_API_BASE}/v1/organizations`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    return res.ok;
  }

  // ---------------------------------------------------------------------------
  // Management API wrapper
  // ---------------------------------------------------------------------------

  /**
   * Make an authenticated request to the Supabase Management API.
   * @param {string} userId
   * @param {string} method - HTTP method
   * @param {string} urlPath - e.g. '/v1/projects'
   * @param {Object|null} body - JSON body (for POST/PATCH)
   * @returns {Promise<Object>} Parsed JSON response
   */
  async apiRequest(userId, method, urlPath, body = null) {
    const token = await this.getAccessToken(userId);
    const options = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    };
    if (body) {
      options.body = JSON.stringify(body);
    }

    const res = await fetch(`${SUPABASE_API_BASE}${urlPath}`, options);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Supabase API ${method} ${urlPath} failed (${res.status}): ${text}`);
    }

    // Some endpoints return 204 No Content
    if (res.status === 204) return null;
    return res.json();
  }

  // ---------------------------------------------------------------------------
  // API methods
  // ---------------------------------------------------------------------------

  async listOrganizations(userId) {
    return this.apiRequest(userId, 'GET', '/v1/organizations');
  }

  async listProjects(userId) {
    return this.apiRequest(userId, 'GET', '/v1/projects');
  }

  async createProject(userId, { name, organizationId, region = 'us-east-1', dbPass }) {
    return this.apiRequest(userId, 'POST', '/v1/projects', {
      name,
      organization_id: organizationId,
      region,
      db_pass: dbPass,
    });
  }

  async getProjectApiKeys(userId, projectRef) {
    return this.apiRequest(userId, 'GET', `/v1/projects/${projectRef}/api-keys`);
  }

  async getProjectStatus(userId, projectRef) {
    return this.apiRequest(userId, 'GET', `/v1/projects/${projectRef}`);
  }

  async deleteProject(userId, projectRef) {
    return this.apiRequest(userId, 'DELETE', `/v1/projects/${projectRef}`);
  }

  // ---------------------------------------------------------------------------
  // Project linking
  // ---------------------------------------------------------------------------

  /**
   * Link an AtlasEngine project to a Supabase project.
   * @param {string} projectId - AtlasEngine project UUID
   * @param {Object} linkData
   */
  async linkProject(projectId, linkData) {
    const {
      supabaseProjectRef,
      supabaseProjectName,
      supabaseOrgId,
      region,
      databaseUrl,
      anonKey,
      serviceRoleKey,
      supabaseUrl,
      provisionedBy = 'linked',
    } = linkData;

    const dbUrlEncrypted = databaseUrl ? encrypt(databaseUrl) : null;
    const srkEncrypted = serviceRoleKey ? encrypt(serviceRoleKey) : null;

    await db.query('BEGIN');
    try {
      // Upsert — only one link per project
      await db.query(`DELETE FROM supabase_project_links WHERE project_id = $1`, [projectId]);

      await db.query(
        `INSERT INTO supabase_project_links
          (project_id, supabase_project_ref, supabase_project_name, supabase_org_id,
           region, database_url_encrypted, anon_key, service_role_key_encrypted,
           supabase_url, provisioned_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          projectId, supabaseProjectRef, supabaseProjectName, supabaseOrgId,
          region, dbUrlEncrypted, anonKey, srkEncrypted,
          supabaseUrl, provisionedBy,
        ]
      );

      await db.query('COMMIT');
    } catch (err) {
      await db.query('ROLLBACK');
      throw err;
    }
  }

  /**
   * Remove the Supabase link for an AtlasEngine project.
   * @param {string} projectId
   */
  async unlinkProject(projectId) {
    await db.query(`DELETE FROM supabase_project_links WHERE project_id = $1`, [projectId]);
  }

  /**
   * Get linked Supabase project info (safe for frontend — no encrypted fields).
   * @param {string} projectId
   * @returns {Promise<Object|null>}
   */
  async getLinkedProject(projectId) {
    const result = await db.query(
      `SELECT id, project_id, supabase_project_ref, supabase_project_name,
              supabase_org_id, region, anon_key, supabase_url, provisioned_by,
              created_at, updated_at
       FROM supabase_project_links
       WHERE project_id = $1`,
      [projectId]
    );
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  /**
   * Get linked project with decrypted secrets (for backend use only).
   * @param {string} projectId
   * @returns {Promise<Object|null>}
   */
  async getLinkedProjectWithSecrets(projectId) {
    const result = await db.query(
      `SELECT * FROM supabase_project_links WHERE project_id = $1`,
      [projectId]
    );
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      ...row,
      databaseUrl: row.database_url_encrypted ? decrypt(row.database_url_encrypted) : null,
      serviceRoleKey: row.service_role_key_encrypted ? decrypt(row.service_role_key_encrypted) : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Auto-linking
  // ---------------------------------------------------------------------------

  /**
   * Attempt to auto-link a Supabase project when exactly one is available.
   * Returns null if PAT not connected, { needsSelection, projects } if >1,
   * or the linked project info if auto-linked.
   *
   * @param {string} projectId - AtlasEngine project UUID
   * @param {string} userId
   * @param {string} projectPath - Path to project directory (for framework detection)
   * @returns {Promise<Object|null>}
   */
  async autoLinkIfSingleProject(projectId, userId, projectPath) {
    // Already linked — nothing to do
    const existing = await this.getLinkedProject(projectId);
    if (existing) {
      return { linked: existing, autoLinked: false };
    }

    // Check if user has a Supabase PAT connected
    const integration = await this.getIntegration(userId);
    if (!integration) return null;

    // List available Supabase projects
    let projects;
    try {
      projects = await this.listProjects(userId);
    } catch {
      return null; // PAT invalid or API error
    }

    // Filter to active projects only
    const activeProjects = (projects || []).filter(
      p => p.status === 'ACTIVE_HEALTHY'
    );

    if (activeProjects.length === 0) return null;
    if (activeProjects.length > 1) {
      return { needsSelection: true, projects: activeProjects };
    }

    // Exactly 1 project — auto-link
    const supaProject = activeProjects[0];
    const ref = supaProject.id;
    const supabaseUrl = `https://${ref}.supabase.co`;

    // Fetch API keys
    const keys = await this.getProjectApiKeys(userId, ref);
    const anonKey = (keys.find(k => k.name === 'anon') || {}).api_key || null;
    const serviceRoleKey = (keys.find(k => k.name === 'service_role') || {}).api_key || null;

    // Persist the link
    await this.linkProject(projectId, {
      supabaseProjectRef: ref,
      supabaseProjectName: supaProject.name,
      supabaseOrgId: supaProject.organization_id,
      region: supaProject.region,
      databaseUrl: null,
      anonKey,
      serviceRoleKey,
      supabaseUrl,
      provisionedBy: 'auto',
    });

    // Create framework-aware project secrets
    let framework = 'node';
    try {
      const pkgContent = await fs.readFile(path.join(projectPath, 'package.json'), 'utf-8');
      framework = detectFrameworkType(JSON.parse(pkgContent));
    } catch {
      // No package.json, default to 'node'
    }
    const envMap = SUPABASE_ENV_VAR_MAP[framework] || SUPABASE_ENV_VAR_MAP.node;

    const secretMap = new Map();
    secretMap.set('SUPABASE_URL', supabaseUrl);
    secretMap.set('SUPABASE_ANON_KEY', anonKey);
    secretMap.set(envMap.url, supabaseUrl);
    secretMap.set(envMap.anonKey, anonKey);

    const secretsToCreate = [...secretMap.entries()].map(([key, value]) => ({ key, value }));
    if (serviceRoleKey) {
      secretsToCreate.push({ key: 'SUPABASE_SERVICE_ROLE_KEY', value: serviceRoleKey });
    }

    for (const { key, value } of secretsToCreate) {
      if (!value) continue;
      await db.query(
        `INSERT INTO project_secrets (project_id, key, value, is_secret, environment)
         VALUES ($1, $2, $3, true, 'production')
         ON CONFLICT (project_id, key, environment)
         DO UPDATE SET value = $3, updated_at = NOW()`,
        [projectId, key, value]
      );
    }

    const linked = await this.getLinkedProject(projectId);
    console.log(`✅ Auto-linked Supabase project "${supaProject.name}" to project ${projectId}`);

    return { linked, autoLinked: true, supabaseProjectName: supaProject.name };
  }

  // ---------------------------------------------------------------------------
  // Connection management
  // ---------------------------------------------------------------------------

  /**
   * Get the active Supabase integration for a user.
   * @param {string} userId
   * @returns {Promise<Object|null>}
   */
  async getIntegration(userId) {
    const result = await db.query(
      `SELECT * FROM supabase_integrations
       WHERE user_id = $1 AND is_active = TRUE
       ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    // SQLite TEXT columns need deserialization
    if (row.organizations && typeof row.organizations === 'string') {
      try { row.organizations = JSON.parse(row.organizations); } catch { /* leave as-is */ }
    }
    return row;
  }

  /**
   * Soft-delete the Supabase integration for a user.
   * @param {string} userId
   */
  async disconnect(userId) {
    await db.query(
      `UPDATE supabase_integrations SET is_active = FALSE WHERE user_id = $1`,
      [userId]
    );
  }
}

export default new SupabaseService();
