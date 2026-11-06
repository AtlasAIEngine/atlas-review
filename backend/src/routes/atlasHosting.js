/**
 * Atlas Hosting Routes
 * API endpoints for Atlas Hosting deployment (Vercel-based)
 */

import express from 'express';
import fs from 'fs';
import path from 'path';
import { getProjectById } from '../db/queries.js';
import { query } from '../db/connection.js';
import atlasHostingService from '../services/atlasHostingService.js';
import changesetService from '../services/changesetService.js';
import gitService from '../services/gitService.js';
import { enforceQuotas } from '../middleware/quotas.js';
import { getAppDataDir } from '../config/paths.js';

const router = express.Router();

// Anonymous user ID for MVP (no authentication required)
const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

// Max log size to store in database (500KB)
const MAX_LOG_SIZE = 500 * 1024;

function maskVercelToken(token) {
  if (!token || typeof token !== 'string') return null;
  const trimmed = token.trim();
  if (!trimmed) return null;
  return `${trimmed.slice(0, Math.min(10, trimmed.length))}...`;
}

// Helper function to check project ownership (supports anonymous access in MVP)
function checkOwnership(project, req) {
  const effectiveUserId = req.user?.id || ANONYMOUS_USER_ID;
  return project.user_id === effectiveUserId;
}

/**
 * GET /api/atlas-hosting/status
 * Check if Atlas Hosting is configured and available
 */
router.get('/atlas-hosting/status', (req, res) => {
  try {
    const status = atlasHostingService.isConfigured();

    // In desktop mode, provide a helpful hint when not configured
    if (process.env.ATLAS_DESKTOP_MODE === 'true' && !status.enabled) {
      status.reason = 'Configure your Vercel token in Settings → Deployment';
    }

    res.json({
      success: true,
      ...status,
    });
  } catch (error) {
    console.error('Error checking Atlas Hosting status:', error);
    res.status(500).json({
      error: 'Failed to check Atlas Hosting status',
      details: error.message,
    });
  }
});

// ============================================================================
// DEPLOYMENT SETTINGS (Desktop-only)
// ============================================================================

/**
 * Helper: update a key=value in the .env file at the app data directory
 */
function updateEnvFile(key, value) {
  const envPath = path.join(getAppDataDir(), '.env');
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    // File doesn't exist yet - that's fine
  }
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }
  fs.writeFileSync(envPath, content.trimStart(), 'utf8');
  process.env[key] = value;
}

function removeEnvFileKey(key) {
  const envPath = path.join(getAppDataDir(), '.env');
  let content = '';
  try {
    content = fs.readFileSync(envPath, 'utf8');
  } catch {
    process.env[key] = '';
    return;
  }

  const regex = new RegExp(`^${key}=.*\\n?`, 'gm');
  const nextContent = content.replace(regex, '').replace(/\n{3,}/g, '\n\n').trim();
  fs.writeFileSync(envPath, nextContent ? `${nextContent}\n` : '', 'utf8');
  process.env[key] = '';
}

/**
 * GET /api/atlas-hosting/deployment-settings
 * Get deployment settings status (desktop-only)
 */
router.get('/atlas-hosting/deployment-settings', (req, res) => {
  if (process.env.ATLAS_DESKTOP_MODE !== 'true') {
    return res.status(404).json({ error: 'Not available' });
  }

  const vercelToken = process.env.VERCEL_TOKEN || '';

  res.json({
    success: true,
    configured: !!vercelToken,
    hasToken: !!vercelToken,
    hasTeamId: !!process.env.VERCEL_TEAM_ID,
    teamId: process.env.VERCEL_TEAM_ID || null,
    tokenPreview: maskVercelToken(vercelToken),
  });
});

/**
 * PUT /api/atlas-hosting/deployment-settings
 * Save Vercel credentials (desktop-only)
 * Validates the token by calling Vercel API, then persists to .env
 */
router.put('/atlas-hosting/deployment-settings', async (req, res) => {
  if (process.env.ATLAS_DESKTOP_MODE !== 'true') {
    return res.status(404).json({ error: 'Not available' });
  }

  const { vercelToken, vercelTeamId } = req.body;

  if (!vercelToken || typeof vercelToken !== 'string') {
    return res.status(400).json({ error: 'vercelToken is required' });
  }

  // Validate token by calling Vercel API
  try {
    const response = await fetch('https://api.vercel.com/v2/user', {
      headers: { 'Authorization': `Bearer ${vercelToken.trim()}` },
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      return res.status(401).json({
        error: 'Invalid Vercel token',
        details: data.error?.message || `HTTP ${response.status}`,
      });
    }

    const userData = await response.json();
    const username = userData.user?.username || userData.user?.name || 'unknown';

    // Token is valid — persist to .env and process.env
    updateEnvFile('VERCEL_TOKEN', vercelToken.trim());

    if (vercelTeamId && typeof vercelTeamId === 'string' && vercelTeamId.trim()) {
      updateEnvFile('VERCEL_TEAM_ID', vercelTeamId.trim());
    } else {
      removeEnvFileKey('VERCEL_TEAM_ID');
    }

    res.json({
      success: true,
      username,
      message: `Connected as ${username}`,
      teamId: process.env.VERCEL_TEAM_ID || null,
      tokenPreview: maskVercelToken(vercelToken),
    });
  } catch (error) {
    console.error('Error validating Vercel token:', error);
    res.status(500).json({
      error: 'Failed to validate Vercel token',
      details: error.message,
    });
  }
});

/**
 * DELETE /api/atlas-hosting/deployment-settings
 * Clear saved Vercel credentials (desktop-only)
 */
router.delete('/atlas-hosting/deployment-settings', (req, res) => {
  if (process.env.ATLAS_DESKTOP_MODE !== 'true') {
    return res.status(404).json({ error: 'Not available' });
  }

  try {
    removeEnvFileKey('VERCEL_TOKEN');
    removeEnvFileKey('VERCEL_TEAM_ID');
    res.json({
      success: true,
      message: 'Vercel credentials removed',
    });
  } catch (error) {
    console.error('Error clearing deployment settings:', error);
    res.status(500).json({
      error: 'Failed to clear deployment settings',
      details: error.message,
    });
  }
});

/**
 * POST /api/projects/:projectId/publish/atlas-hosting
 * Start Atlas Hosting deployment
 */
router.post('/projects/:projectId/publish/atlas-hosting', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { changesetId, commitHash } = req.body;

    // Validate required fields
    if (!changesetId || !commitHash) {
      return res.status(400).json({
        error: 'Missing required fields',
        details: 'changesetId and commitHash are required',
      });
    }

    // Check if Atlas Hosting is configured
    const config = atlasHostingService.isConfigured();
    if (!config.enabled) {
      return res.status(503).json({
        error: 'Atlas Hosting not configured',
        reason: config.reason,
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

    // Validate changeset exists
    const changeset = await changesetService.getChangeSet(project.path, changesetId);
    if (!changeset) {
      return res.status(404).json({
        error: 'Changeset not found',
        details: `Changeset ${changesetId} does not exist`,
      });
    }

    // Validate changeset has been committed to git
    // A changeset is deployable if:
    // 1. It has a commitSha (proves it was committed, regardless of status field)
    // 2. OR its status is in the deployable list (for backwards compatibility)
    // Note: Status can get out of sync (e.g., after revert operations), so commitSha is the source of truth
    if (!changeset.commitSha) {
      const deployableStatuses = ['committed', 'verified', 'published'];
      if (!deployableStatuses.includes(changeset.status)) {
        return res.status(400).json({
          error: 'Changeset not committed',
          details: `Changeset status is '${changeset.status}'. Must be committed to publish via Atlas Hosting.`,
        });
      }
      // Status says committed but no SHA - shouldn't happen, but reject to be safe
      return res.status(400).json({
        error: 'Changeset has no commit',
        details: 'Changeset must have a commit SHA to publish via Atlas Hosting.',
      });
    }

    if (commitHash !== changeset.commitSha) {
      return res.status(400).json({
        error: 'Commit hash mismatch',
        details: `Provided commitHash (${commitHash.substring(0, 7)}) does not match changeset commit (${changeset.commitSha.substring(0, 7)}).`,
      });
    }

    // Check quota
    try {
      await atlasHostingService.checkQuota(projectId);
    } catch (quotaError) {
      return res.status(429).json({
        error: 'Quota exceeded',
        details: quotaError.message,
      });
    }

    // Get or create Vercel project ID
    let vercelProjectId;
    try {
      vercelProjectId = await atlasHostingService.ensureVercelProject(projectId, project.name);
    } catch (vercelError) {
      return res.status(500).json({
        error: 'Failed to create Vercel project',
        details: vercelError.message,
      });
    }

    // Create publish attempt record
    const attempt = await atlasHostingService.createPublishAttempt({
      projectId,
      changesetId,
      commitHash,
      vercelProjectId,
    });

    res.json({
      success: true,
      publishAttemptId: attempt.id,
      message: 'Publish attempt created. Subscribe to events endpoint for progress.',
    });
  } catch (error) {
    console.error('Error starting Atlas Hosting publish:', error);
    res.status(500).json({
      error: 'Failed to start Atlas Hosting publish',
      details: error.message,
    });
  }
});

/**
 * GET /api/publish/atlas-hosting/:id/events
 * SSE endpoint for streaming deployment logs
 */
router.get('/publish/atlas-hosting/:id/events', async (req, res) => {
  const { id: attemptId } = req.params;

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Helper to send SSE events
  const sendEvent = (type, data) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  let logs = '';

  try {
    // Load publish attempt
    const attempt = await atlasHostingService.getPublishAttempt(attemptId);
    if (!attempt) {
      sendEvent('error', { error: 'Publish attempt not found' });
      res.end();
      return;
    }

    // If already complete, send result immediately
    if (attempt.status === 'succeeded') {
      sendEvent('complete', {
        success: true,
        url: attempt.deployment_url,
        deploymentId: attempt.deployment_id,
      });
      res.end();
      return;
    }

    if (attempt.status === 'failed') {
      sendEvent('error', { error: attempt.error_message || 'Deployment failed' });
      res.end();
      return;
    }

    if (attempt.status === 'canceled') {
      sendEvent('error', { error: 'Deployment was canceled' });
      res.end();
      return;
    }

    // Guard against re-running an in-flight deployment (e.g., EventSource reconnect)
    if (attempt.status === 'running') {
      sendEvent('error', { error: 'Deployment already in progress. Please wait for it to complete.' });
      res.end();
      return;
    }

    // Load project
    const project = await getProjectById(attempt.project_id);
    if (!project) {
      sendEvent('error', { error: 'Project not found' });
      res.end();
      return;
    }

    // Enforce ownership - prevent unauthorized users from triggering deployments
    if (!checkOwnership(project, req)) {
      sendEvent('error', { error: 'Forbidden: You do not have access to this project' });
      res.end();
      return;
    }

    // Update status to running
    await atlasHostingService.updatePublishAttempt(attemptId, {
      status: 'running',
      started_at: new Date().toISOString(),
    });

    sendEvent('status', { status: 'running' });

    // Run deployment with log streaming
    const onLog = (text) => {
      logs += text;
      sendEvent('log', { text });
    };

    const result = await atlasHostingService.publishToAtlasHosting(
      project.path,
      attempt.project_id,
      project.name,
      attempt.changeset_id,
      attempt.commit_hash,
      onLog
    );

    // Update publish attempt in database
    const truncatedLogs = logs.length > MAX_LOG_SIZE
      ? logs.substring(0, MAX_LOG_SIZE) + '\n... [truncated]'
      : logs;

    await atlasHostingService.updatePublishAttempt(attemptId, {
      status: 'succeeded',
      finished_at: new Date().toISOString(),
      deployment_url: result.url,
      vercel_url: result.vercelUrl,
      deployment_id: result.deploymentId,
      inspect_url: result.inspectUrl,
      logs: truncatedLogs,
      secrets_keys: result.secretsKeys || [],
    });

    // Update project's last deployment info
    await atlasHostingService.updateProjectDeployment(attempt.project_id, result.url);

    // Set this deployment as production
    await atlasHostingService.updateProductionPointer(attempt.project_id, attemptId);

    // Update changeset status to published
    try {
      await changesetService.updateChangeSetStatus(
        project.path,
        attempt.changeset_id,
        'published',
        { publishedUrl: result.url }
      );
    } catch (err) {
      console.warn('Failed to update changeset status:', err.message);
    }

    // Send complete event
    sendEvent('complete', {
      success: true,
      url: result.url,
      vercelUrl: result.vercelUrl,
      deploymentId: result.deploymentId,
    });
  } catch (error) {
    console.error('Atlas Hosting deployment error:', error);

    // Truncate logs before storing
    const truncatedLogs = logs.length > MAX_LOG_SIZE
      ? logs.substring(0, MAX_LOG_SIZE) + '\n... [truncated]'
      : logs;

    // Update attempt as failed
    try {
      await atlasHostingService.updatePublishAttempt(attemptId, {
        status: 'failed',
        finished_at: new Date().toISOString(),
        error_message: error.message,
        logs: truncatedLogs,
      });
    } catch (updateErr) {
      console.error('Failed to update publish attempt:', updateErr);
    }

    sendEvent('error', { error: error.message });
  }

  res.end();
});

/**
 * GET /api/publish/atlas-hosting/:id
 * Get a single publish attempt
 */
router.get('/publish/atlas-hosting/:id', enforceQuotas, async (req, res) => {
  try {
    const { id: attemptId } = req.params;

    const attempt = await atlasHostingService.getPublishAttempt(attemptId);

    if (!attempt) {
      return res.status(404).json({ error: 'Publish attempt not found' });
    }

    // Load project to check ownership
    const project = await getProjectById(attempt.project_id);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json({
      success: true,
      attempt,
    });
  } catch (error) {
    console.error('Error getting publish attempt:', error);
    res.status(500).json({
      error: 'Failed to get publish attempt',
      details: error.message,
    });
  }
});

/**
 * GET /api/projects/:projectId/production-status
 * Get the current production deployment status for a project
 */
router.get('/projects/:projectId/production-status', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;

    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Get the latest successful deployment
    const latestDeployment = await atlasHostingService.getLatestSuccessfulDeployment(projectId);

    if (!latestDeployment) {
      return res.json({
        success: true,
        hasProduction: false,
      });
    }

    // Get the changeset details if available
    let changesetDetails = null;
    if (latestDeployment.changeset_id) {
      try {
        const changeset = await changesetService.getChangeSet(project.path, latestDeployment.changeset_id);
        if (changeset) {
          changesetDetails = {
            id: changeset.id,
            displayId: changeset.displayId,
            title: changeset.title,
            summary: changeset.summary,
          };
        }
      } catch (err) {
        console.warn('Failed to load changeset for production status:', err.message);
      }
    }

    res.json({
      success: true,
      hasProduction: true,
      deployment: {
        url: latestDeployment.deployment_url,
        deployedAt: latestDeployment.finished_at,
        commitHash: latestDeployment.commit_hash,
        changeset: changesetDetails,
      },
    });
  } catch (error) {
    console.error('Error getting production status:', error);
    res.status(500).json({
      error: 'Failed to get production status',
      details: error.message,
    });
  }
});

/**
 * GET /api/projects/:projectId/publish-history
 * Get recent publish attempts for a project
 */
router.get('/projects/:projectId/publish-history', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;
    const limit = Math.min(parseInt(req.query.limit || '10', 10), 50);

    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const history = await atlasHostingService.getPublishHistory(projectId, limit);

    res.json({
      success: true,
      history,
      lastDeploymentUrl: project.last_deployment_url,
      lastDeploymentAt: project.last_deployment_at,
    });
  } catch (error) {
    console.error('Error getting publish history:', error);
    res.status(500).json({
      error: 'Failed to get publish history',
      details: error.message,
    });
  }
});

/**
 * GET /api/projects/:projectId/deployments
 * Get deployment history with production pointer
 */
router.get('/projects/:projectId/deployments', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;
    const limit = Math.min(parseInt(req.query.limit || '20', 10), 100);

    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Get production pointer
    let productionPointer = await atlasHostingService.getProductionPointer(projectId);

    // Enrich production pointer with changeset display ID and title
    if (productionPointer && productionPointer.changesetId && project.path) {
      try {
        const changeset = await changesetService.getChangeSet(project.path, productionPointer.changesetId);
        if (changeset) {
          productionPointer = {
            ...productionPointer,
            changesetDisplayId: changeset.displayId || null,
            changesetTitle: changeset.title || null,
          };
        }
      } catch (err) {
        // Changeset not found - continue without display ID
      }
    }

    // Get deployment history from publish_attempts
    const result = await query(
      `SELECT
        id,
        changeset_id,
        commit_hash,
        deployment_url,
        vercel_url,
        deployment_id,
        inspect_url,
        status,
        error_message,
        started_at,
        finished_at,
        created_at
       FROM publish_attempts
       WHERE project_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [projectId, limit]
    );

    // Fetch changeset info from file-based service for each deployment
    const deployments = await Promise.all(
      result.rows.map(async (row) => {
        let changesetDisplayId = null;
        let changesetTitle = null;

        // Try to get changeset info if changeset_id exists
        if (row.changeset_id && project.path) {
          try {
            const changeset = await changesetService.getChangeSet(project.path, row.changeset_id);
            if (changeset) {
              changesetDisplayId = changeset.displayId || null;
              changesetTitle = changeset.title || null;
            }
          } catch (err) {
            // Changeset may have been deleted or not found - continue without it
          }
        }

        // Compute duration in seconds
        let durationSeconds = null;
        if (row.started_at && row.finished_at) {
          const start = new Date(row.started_at).getTime();
          const end = new Date(row.finished_at).getTime();
          durationSeconds = Math.round((end - start) / 1000);
        }

        return {
          id: row.id,
          changesetId: row.changeset_id,
          changesetDisplayId,
          changesetTitle,
          commitHash: row.commit_hash,
          url: row.deployment_url,
          vercelUrl: row.vercel_url,
          deploymentId: row.deployment_id,
          inspectUrl: row.inspect_url,
          status: row.status,
          errorMessage: row.error_message,
          durationSeconds,
          startedAt: row.started_at,
          finishedAt: row.finished_at,
          isProduction: productionPointer?.deploymentId === row.id,
        };
      })
    );

    res.json({
      success: true,
      production: productionPointer || {
        deploymentId: null,
        changesetId: null,
        commitHash: null,
        url: null,
        updatedAt: null,
      },
      deployments,
    });
  } catch (error) {
    console.error('Error getting deployments:', error);
    res.status(500).json({
      error: 'Failed to get deployments',
      details: error.message,
    });
  }
});

/**
 * POST /api/projects/:projectId/deployments/:deploymentId/promote
 * Promote a previous deployment to production (rollback)
 */
router.post('/projects/:projectId/deployments/:deploymentId/promote', enforceQuotas, async (req, res) => {
  try {
    const { projectId, deploymentId } = req.params;

    // Check if Atlas Hosting is configured
    const config = atlasHostingService.isConfigured();
    if (!config.enabled) {
      return res.status(503).json({
        error: 'Atlas Hosting not configured',
        reason: config.reason,
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

    // Promote the deployment (this validates the deployment exists and is successful)
    const result = await atlasHostingService.promoteDeployment(projectId, deploymentId);

    res.json({
      success: true,
      message: 'Deployment promoted to production',
      production: result.production,
    });
  } catch (error) {
    console.error('Error promoting deployment:', error);

    // Return specific error messages for known errors
    const knownErrors = [
      'Deployment not found',
      'Deployment does not belong to this project',
      'Can only promote successful deployments',
      'Deployment has no Vercel URL',
      'Project not found',
    ];

    const isKnownError = knownErrors.some((msg) => error.message.includes(msg));

    res.status(isKnownError ? 400 : 500).json({
      error: 'Failed to promote deployment',
      details: error.message,
    });
  }
});

/**
 * GET /api/projects/:projectId/deployments/:deploymentId/promote/events
 * SSE endpoint for streaming promotion progress
 */
router.get('/projects/:projectId/deployments/:deploymentId/promote/events', enforceQuotas, async (req, res) => {
  const { projectId, deploymentId } = req.params;

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering

  // Helper to send SSE events
  const sendEvent = (type, data) => {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  try {
    // Check if Atlas Hosting is configured
    const config = atlasHostingService.isConfigured();
    if (!config.enabled) {
      sendEvent('error', { error: 'Atlas Hosting not configured', reason: config.reason });
      res.end();
      return;
    }

    // Load project
    const project = await getProjectById(projectId);
    if (!project) {
      sendEvent('error', { error: 'Project not found' });
      res.end();
      return;
    }

    // Check ownership
    if (!checkOwnership(project, req)) {
      sendEvent('error', { error: 'Forbidden: You do not have access to this project' });
      res.end();
      return;
    }

    sendEvent('status', { status: 'starting' });

    // Run promotion with log streaming
    const onLog = (text) => {
      sendEvent('log', { text });
    };

    const result = await atlasHostingService.promoteDeployment(projectId, deploymentId, onLog);

    sendEvent('complete', {
      success: true,
      message: 'Deployment promoted to production',
      production: result.production,
    });
  } catch (error) {
    console.error('Promotion SSE error:', error);
    sendEvent('error', { error: error.message });
  }

  res.end();
});

export default router;
