/**
 * Secrets Routes
 * API endpoints for managing project environment variables and secrets
 */

import express from 'express';
import { getProjectById } from '../db/queries.js';
import secretsService from '../services/secretsService.js';
import integrationsService from '../services/integrationsService.js';

const router = express.Router();

// Anonymous user ID for MVP (no authentication required)
const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

// Helper function to check project ownership (supports anonymous access in MVP)
function checkOwnership(project, req) {
  const effectiveUserId = req.user?.id || ANONYMOUS_USER_ID;
  return project.user_id === effectiveUserId;
}

/**
 * GET /api/projects/:projectId/secrets
 * List all secrets for a project (values masked)
 */
router.get('/projects/:projectId/secrets', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { environment = 'production' } = req.query;

    // Load project
    const project = await getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const secrets = await secretsService.listSecrets(projectId, environment);

    res.json({
      success: true,
      secrets,
    });
  } catch (error) {
    console.error('Error listing secrets:', error);
    res.status(500).json({
      error: 'Failed to list secrets',
      details: error.message,
    });
  }
});

/**
 * POST /api/projects/:projectId/secrets
 * Create a new secret
 */
router.post('/projects/:projectId/secrets', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { key, value, isSecret = true, environment = 'production' } = req.body;

    // Validate required fields
    if (!key || typeof key !== 'string') {
      return res.status(400).json({
        error: 'Invalid request',
        details: 'key is required and must be a string',
      });
    }

    if (value === undefined || value === null) {
      return res.status(400).json({
        error: 'Invalid request',
        details: 'value is required',
      });
    }

    // Validate key format (environment variable naming rules)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return res.status(400).json({
        error: 'Invalid key format',
        details: 'Key must start with a letter or underscore and contain only letters, numbers, and underscores',
      });
    }

    // Load project
    const project = await getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const secret = await secretsService.createSecret({
      projectId,
      key,
      value: String(value),
      isSecret: Boolean(isSecret),
      environment,
    });

    res.status(201).json({
      success: true,
      secret,
    });
  } catch (error) {
    console.error('Error creating secret:', error);

    // Handle unique constraint violation
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'Secret already exists',
        details: `A secret with this key already exists for the ${req.body.environment || 'production'} environment`,
      });
    }

    res.status(500).json({
      error: 'Failed to create secret',
      details: error.message,
    });
  }
});

/**
 * PUT /api/projects/:projectId/secrets/:secretId
 * Update an existing secret
 */
router.put('/projects/:projectId/secrets/:secretId', async (req, res) => {
  try {
    const { projectId, secretId } = req.params;
    const { key, value, isSecret } = req.body;

    // Validate at least one field to update
    if (key === undefined && value === undefined && isSecret === undefined) {
      return res.status(400).json({
        error: 'Invalid request',
        details: 'At least one field (key, value, isSecret) is required',
      });
    }

    // Validate key format if provided
    if (key !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      return res.status(400).json({
        error: 'Invalid key format',
        details: 'Key must start with a letter or underscore and contain only letters, numbers, and underscores',
      });
    }

    // Load project
    const project = await getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Check secret exists and belongs to project
    const existingSecret = await secretsService.getSecret(projectId, secretId);
    if (!existingSecret) {
      return res.status(404).json({ error: 'Secret not found' });
    }

    const updates = {};
    if (key !== undefined) updates.key = key;
    if (value !== undefined) updates.value = String(value);
    if (isSecret !== undefined) updates.isSecret = Boolean(isSecret);

    const secret = await secretsService.updateSecret(secretId, updates);

    res.json({
      success: true,
      secret,
    });
  } catch (error) {
    console.error('Error updating secret:', error);

    // Handle unique constraint violation
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'Secret already exists',
        details: 'A secret with this key already exists for this environment',
      });
    }

    res.status(500).json({
      error: 'Failed to update secret',
      details: error.message,
    });
  }
});

/**
 * DELETE /api/projects/:projectId/secrets/:secretId
 * Delete a secret
 */
router.delete('/projects/:projectId/secrets/:secretId', async (req, res) => {
  try {
    const { projectId, secretId } = req.params;

    // Load project
    const project = await getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Check secret exists and belongs to project
    const existingSecret = await secretsService.getSecret(projectId, secretId);
    if (!existingSecret) {
      return res.status(404).json({ error: 'Secret not found' });
    }

    const deleted = await secretsService.deleteSecret(secretId);

    if (!deleted) {
      return res.status(404).json({ error: 'Secret not found' });
    }

    res.json({
      success: true,
      message: 'Secret deleted',
    });
  } catch (error) {
    console.error('Error deleting secret:', error);
    res.status(500).json({
      error: 'Failed to delete secret',
      details: error.message,
    });
  }
});

/**
 * GET /api/projects/:projectId/secrets/:secretId/value
 * Get the full unmasked value of a secret (for reveal functionality)
 *
 * Note: Consider adding rate limiting in production to prevent abuse
 */
router.get('/projects/:projectId/secrets/:secretId/value', async (req, res) => {
  try {
    const { projectId, secretId } = req.params;

    // Load project
    const project = await getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Get secret with full value
    const secret = await secretsService.getSecret(projectId, secretId);
    if (!secret) {
      return res.status(404).json({ error: 'Secret not found' });
    }

    res.json({
      success: true,
      value: secret.value,
    });
  } catch (error) {
    console.error('Error getting secret value:', error);
    res.status(500).json({
      error: 'Failed to get secret value',
      details: error.message,
    });
  }
});

/**
 * GET /api/projects/:projectId/secrets/integrations
 * Detect known integrations and check for missing required environment variables
 */
router.get('/projects/:projectId/secrets/integrations', async (req, res) => {
  try {
    const { projectId } = req.params;

    // Load project
    const project = await getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Get project path and configured secrets
    const projectPath = project.path;
    if (!projectPath) {
      return res.json({
        success: true,
        integrations: [],
        missingVars: [],
      });
    }

    const secrets = await secretsService.listSecrets(projectId, 'production');
    const result = await integrationsService.checkProjectIntegrations(projectPath, secrets);

    res.json({
      success: true,
      integrations: result.integrations,
      missingVars: result.missingVars,
    });
  } catch (error) {
    console.error('Error detecting integrations:', error);
    res.status(500).json({
      error: 'Failed to detect integrations',
      details: error.message,
    });
  }
});

/**
 * POST /api/projects/:projectId/secrets/import
 * Import secrets from .env file content
 */
router.post('/projects/:projectId/secrets/import', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { content, environment = 'production' } = req.body;

    // Validate content
    if (!content || typeof content !== 'string') {
      return res.status(400).json({
        error: 'Invalid request',
        details: 'content is required and must be a string',
      });
    }

    // Load project
    const project = await getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const result = await secretsService.importFromEnv(projectId, content, environment);

    res.json({
      success: true,
      created: result.created,
      updated: result.updated,
      errors: result.errors,
      message: `Imported ${result.created} new and updated ${result.updated} existing secrets`,
    });
  } catch (error) {
    console.error('Error importing secrets:', error);
    res.status(500).json({
      error: 'Failed to import secrets',
      details: error.message,
    });
  }
});

export default router;
