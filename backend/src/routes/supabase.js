/**
 * Supabase Routes
 * PAT-based connection, project listing, and project linking for Supabase integration.
 *
 * Users generate a Personal Access Token at https://supabase.com/dashboard/account/tokens
 * and save it via POST /api/supabase/connect.
 */

import express from 'express';
import crypto from 'crypto';
import supabaseService from '../services/supabaseService.js';
import { detectFrameworkType, SUPABASE_ENV_VAR_MAP } from '../services/integrationsService.js';
import { getProjectById } from '../db/queries.js';
import db from '../db/connection.js';
import fs from 'fs/promises';
import path from 'path';

const router = express.Router();

const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

function getEffectiveUserId(req) {
  return req.user?.id || ANONYMOUS_USER_ID;
}

function checkOwnership(project, req) {
  const effectiveUserId = req.user?.id || ANONYMOUS_USER_ID;
  return project.user_id === effectiveUserId;
}

// ---------------------------------------------------------------------------
// GET /api/supabase/status
// ---------------------------------------------------------------------------
router.get('/status', async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const integration = await supabaseService.getIntegration(userId);

    if (!integration) {
      return res.json({ connected: false });
    }

    res.json({
      connected: true,
      email: integration.account_email || null,
      organizations: integration.organizations || [],
    });
  } catch (error) {
    console.error('Error checking Supabase status:', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/supabase/connect
// Save a Personal Access Token
// Body: { accessToken: string }
// ---------------------------------------------------------------------------
router.post('/connect', async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { accessToken } = req.body;

    if (!accessToken || typeof accessToken !== 'string') {
      return res.status(400).json({ error: 'accessToken is required' });
    }

    // Validate the token by calling the API
    const valid = await supabaseService.validateToken(accessToken);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid Supabase access token. Please check and try again.' });
    }

    await supabaseService.storeToken(userId, accessToken);

    console.log(`[Supabase] Access token stored for user ${userId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error connecting Supabase:', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/supabase/disconnect
// ---------------------------------------------------------------------------
router.post('/disconnect', async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    await supabaseService.disconnect(userId);
    res.json({ success: true });
  } catch (error) {
    console.error('Error disconnecting Supabase:', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/supabase/organizations
// ---------------------------------------------------------------------------
router.get('/organizations', async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const orgs = await supabaseService.listOrganizations(userId);
    res.json({ organizations: orgs });
  } catch (error) {
    console.error('Error listing Supabase organizations:', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/supabase/projects
// ---------------------------------------------------------------------------
router.get('/projects', async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    let projects = await supabaseService.listProjects(userId);

    // Optional org filter
    const { orgId } = req.query;
    if (orgId) {
      projects = projects.filter(p => p.organization_id === orgId);
    }

    res.json({ projects });
  } catch (error) {
    console.error('Error listing Supabase projects:', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/supabase/projects/:projectId/link
// Link an existing (or newly created) Supabase project to an AtlasEngine project.
// ---------------------------------------------------------------------------
router.post('/projects/:projectId/link', async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { projectId } = req.params;

    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!checkOwnership(project, req)) return res.status(403).json({ error: 'Forbidden' });

    const { supabaseProjectRef, create, organizationId, region, projectName } = req.body;

    let ref = supabaseProjectRef;
    let name = projectName;
    let orgId = organizationId;
    let projectRegion = region;

    // Option A: Create a new Supabase project
    if (create) {
      if (!organizationId || !projectName) {
        return res.status(400).json({ error: 'organizationId and projectName are required when creating a new project' });
      }

      const dbPass = crypto.randomBytes(16).toString('hex');
      const created = await supabaseService.createProject(userId, {
        name: projectName,
        organizationId,
        region: region || 'us-east-1',
        dbPass,
      });

      ref = created.id; // project ref
      name = created.name;
      orgId = created.organization_id;
      projectRegion = created.region;

      // Poll until ACTIVE_HEALTHY (max 2 minutes)
      const deadline = Date.now() + 2 * 60 * 1000;
      let status = created.status;
      while (status !== 'ACTIVE_HEALTHY' && Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 5000));
        const fresh = await supabaseService.getProjectStatus(userId, ref);
        status = fresh.status;
      }

      if (status !== 'ACTIVE_HEALTHY') {
        return res.status(504).json({ error: 'Supabase project creation timed out. Try linking manually later.' });
      }
    }

    if (!ref) {
      return res.status(400).json({ error: 'supabaseProjectRef is required' });
    }

    // Validate projectRef format (20 lowercase alpha chars)
    if (!/^[a-z]{20}$/.test(ref)) {
      return res.status(400).json({ error: 'Invalid Supabase project reference format' });
    }

    // Fetch API keys
    const keys = await supabaseService.getProjectApiKeys(userId, ref);
    const anonKey = (keys.find(k => k.name === 'anon') || {}).api_key || null;
    const serviceRoleKey = (keys.find(k => k.name === 'service_role') || {}).api_key || null;

    // Fetch project info for URL
    const projectInfo = await supabaseService.getProjectStatus(userId, ref);
    const supabaseUrl = `https://${ref}.supabase.co`;

    // Persist link
    await supabaseService.linkProject(projectId, {
      supabaseProjectRef: ref,
      supabaseProjectName: name || projectInfo.name,
      supabaseOrgId: orgId || projectInfo.organization_id,
      region: projectRegion || projectInfo.region,
      databaseUrl: null, // Not available via API; user can add via secrets
      anonKey,
      serviceRoleKey,
      supabaseUrl,
      provisionedBy: create ? 'created' : 'linked',
    });

    // Auto-create project secrets — framework-aware prefixed vars
    let framework = 'node';
    try {
      const pkgContent = await fs.readFile(path.join(project.path, 'package.json'), 'utf-8');
      framework = detectFrameworkType(JSON.parse(pkgContent));
    } catch {
      // No package.json, default to 'node'
    }
    const envMap = SUPABASE_ENV_VAR_MAP[framework] || SUPABASE_ENV_VAR_MAP.node;

    // Use a Map to deduplicate (for 'node' framework, base and mapped are the same)
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
      // Upsert secret (ON CONFLICT handles both insert and update)
      await db.query(
        `INSERT INTO project_secrets (project_id, key, value, is_secret, environment)
         VALUES ($1, $2, $3, true, 'production')
         ON CONFLICT (project_id, key, environment)
         DO UPDATE SET value = $3, updated_at = NOW()`,
        [projectId, key, value]
      );
    }

    const linked = await supabaseService.getLinkedProject(projectId);
    res.json({ success: true, linked });
  } catch (error) {
    console.error('Error linking Supabase project:', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// POST /api/supabase/projects/:projectId/unlink
// ---------------------------------------------------------------------------
router.post('/projects/:projectId/unlink', async (req, res) => {
  try {
    const { projectId } = req.params;

    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!checkOwnership(project, req)) return res.status(403).json({ error: 'Forbidden' });

    const { removeSecrets } = req.body || {};

    await supabaseService.unlinkProject(projectId);

    if (removeSecrets) {
      await db.query(
        `DELETE FROM project_secrets WHERE project_id = $1 AND key IN (
          'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
          'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
          'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY',
          'REACT_APP_SUPABASE_URL', 'REACT_APP_SUPABASE_ANON_KEY'
        )`,
        [projectId]
      );
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error unlinking Supabase project:', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/supabase/projects/:projectId/database
// Delete the Supabase project itself, then clean up the local link + secrets
// ---------------------------------------------------------------------------
router.delete('/projects/:projectId/database', async (req, res) => {
  try {
    const userId = getEffectiveUserId(req);
    const { projectId } = req.params;

    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!checkOwnership(project, req)) return res.status(403).json({ error: 'Forbidden' });

    const { confirmName } = req.body || {};

    const linked = await supabaseService.getLinkedProject(projectId);
    if (!linked) {
      return res.status(404).json({ error: 'No Supabase project linked to this project' });
    }

    if (!confirmName || confirmName !== linked.supabase_project_name) {
      return res.status(400).json({ error: 'confirmName must match the Supabase project name' });
    }

    // Delete the Supabase project via Management API
    try {
      await supabaseService.deleteProject(userId, linked.supabase_project_ref);
    } catch (err) {
      // If already deleted (404), continue with local cleanup
      if (!err.message?.includes('(404)')) {
        throw err;
      }
    }

    // Clean up local link + secrets (same as unlink)
    await supabaseService.unlinkProject(projectId);
    await db.query(
      `DELETE FROM project_secrets WHERE project_id = $1 AND key IN (
        'SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY',
        'NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
        'VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY',
        'REACT_APP_SUPABASE_URL', 'REACT_APP_SUPABASE_ANON_KEY'
      )`,
      [projectId]
    );

    console.log(`[Supabase] Deleted project ${linked.supabase_project_ref} and cleaned up link for ${projectId}`);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting Supabase database:', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/supabase/projects/:projectId/link
// ---------------------------------------------------------------------------
router.get('/projects/:projectId/link', async (req, res) => {
  try {
    const { projectId } = req.params;

    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!checkOwnership(project, req)) return res.status(403).json({ error: 'Forbidden' });

    const linked = await supabaseService.getLinkedProject(projectId);
    res.json({ linked: linked || null });
  } catch (error) {
    console.error('Error getting linked Supabase project:', error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
