/**
 * Preview/Deployment Routes
 * Manage running containers and deployments
 */

import express from 'express';
import { getActivePreview } from '../db/queries.js';
import { query } from '../db/connection.js';
import dockerService from '../services/dockerService.js';
import portRegistry from '../services/portRegistry.js';
import { enforceQuotas } from '../middleware/quotas.js';

const router = express.Router();

// Anonymous user ID for MVP (no authentication required)
const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

// Helper function to get effective user ID (supports anonymous access in MVP)
function getEffectiveUserId(req) {
  return req.user?.id || ANONYMOUS_USER_ID;
}

/**
 * GET /api/previews/:id
 * Get preview details
 */
router.get('/:id', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    const result = await query('SELECT * FROM previews WHERE id = $1', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Preview not found' });
    }

    const preview = result.rows[0];

    // Check ownership
    const effectiveUserId = getEffectiveUserId(req);
    if (preview.user_id !== effectiveUserId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json({
      success: true,
      preview: {
        id: preview.id,
        projectId: preview.project_id,
        buildId: preview.build_id,
        containerId: preview.container_id,
        containerName: preview.container_name,
        host: preview.host,
        port: preview.port,
        status: preview.status,
        url: `http://localhost:${preview.port}`,
        memoryLimitMb: preview.memory_limit_mb,
        cpuLimit: preview.cpu_limit,
        requestCount: preview.request_count,
        lastAccessed: preview.last_accessed,
        createdAt: preview.created_at
      }
    });
  } catch (error) {
    console.error('Error getting preview:', error);
    res.status(500).json({ error: 'Failed to get preview' });
  }
});

/**
 * GET /api/projects/:projectId/preview
 * Get active preview for a project
 */
router.get('/project/:projectId', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user?.id;

    // Verify project ownership
    const projectResult = await query(
      'SELECT user_id FROM projects WHERE id = $1',
      [projectId]
    );

    if (projectResult.rows.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const effectiveUserId = getEffectiveUserId(req);
    if (projectResult.rows[0].user_id !== effectiveUserId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Get active preview
    const preview = await getActivePreview(projectId);

    if (!preview) {
      return res.json({
        success: true,
        preview: null,
        message: 'No active preview for this project'
      });
    }

    res.json({
      success: true,
      preview: {
        id: preview.id,
        containerId: preview.container_id,
        containerName: preview.container_name,
        host: preview.host,
        port: preview.port,
        status: preview.status,
        url: `http://localhost:${preview.port}`,
        createdAt: preview.created_at
      }
    });
  } catch (error) {
    console.error('Error getting active preview:', error);
    res.status(500).json({ error: 'Failed to get active preview' });
  }
});

/**
 * DELETE /api/previews/:id
 * Stop and remove a preview
 */
router.delete('/:id', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    const result = await query(
      'SELECT * FROM previews WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Preview not found' });
    }

    const preview = result.rows[0];

    // Check ownership
    const effectiveUserId = getEffectiveUserId(req);
    if (preview.user_id !== effectiveUserId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Stop container
    await dockerService.stopContainer(
      preview.id,
      preview.container_id,
      preview.project_id
    );

    res.json({
      success: true,
      message: 'Preview stopped successfully'
    });
  } catch (error) {
    console.error('Error stopping preview:', error);
    res.status(500).json({ error: 'Failed to stop preview' });
  }
});

/**
 * GET /api/previews/:id/logs
 * Get container logs
 */
router.get('/:id/logs', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    const { tail = 100 } = req.query;

    const result = await query(
      'SELECT user_id, container_id FROM previews WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Preview not found' });
    }

    const preview = result.rows[0];

    // Check ownership
    const effectiveUserId = getEffectiveUserId(req);
    if (preview.user_id !== effectiveUserId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Get logs
    const logs = await dockerService.getContainerLogs(preview.container_id, {
      tail: parseInt(tail)
    });

    res.json({
      success: true,
      logs
    });
  } catch (error) {
    console.error('Error getting container logs:', error);
    res.status(500).json({ error: 'Failed to get container logs' });
  }
});

/**
 * GET /api/previews/:id/stats
 * Get container stats
 */
router.get('/:id/stats', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    const result = await query(
      'SELECT user_id, container_id FROM previews WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Preview not found' });
    }

    const preview = result.rows[0];

    // Check ownership
    const effectiveUserId = getEffectiveUserId(req);
    if (preview.user_id !== effectiveUserId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Get stats
    const stats = await dockerService.getContainerStats(preview.container_id);

    res.json({
      success: true,
      stats: {
        memoryUsage: stats.memoryUsage,
        memoryLimit: stats.memoryLimit,
        memoryPercent: ((stats.memoryUsage / stats.memoryLimit) * 100).toFixed(2),
        cpuUsage: stats.cpuUsage,
        networkRx: stats.networkRx,
        networkTx: stats.networkTx
      }
    });
  } catch (error) {
    console.error('Error getting container stats:', error);
    res.status(500).json({ error: 'Failed to get container stats' });
  }
});

/**
 * POST /api/previews/:id/health
 * Trigger health check
 */
router.post('/:id/health', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    const result = await query(
      'SELECT user_id, port FROM previews WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Preview not found' });
    }

    const preview = result.rows[0];

    // Check ownership
    const effectiveUserId = getEffectiveUserId(req);
    if (preview.user_id !== effectiveUserId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Run health check
    const healthCheck = await portRegistry.healthCheck(preview.port, {
      maxAttempts: 3,
      intervalMs: 1000
    });

    res.json({
      success: true,
      healthCheck: {
        healthy: healthCheck.healthy,
        port: healthCheck.port,
        attempts: healthCheck.attempt || healthCheck.attempts,
        statusCode: healthCheck.statusCode
      }
    });
  } catch (error) {
    console.error('Error running health check:', error);
    res.status(500).json({ error: 'Failed to run health check' });
  }
});

/**
 * GET /api/previews/all
 * List all previews for user
 */
router.get('/', enforceQuotas, async (req, res) => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const result = await query(
      `SELECT * FROM previews
       WHERE user_id = $1 AND status IN ('starting', 'healthy')
       ORDER BY created_at DESC`,
      [userId]
    );

    res.json({
      success: true,
      previews: result.rows.map(p => ({
        id: p.id,
        projectId: p.project_id,
        containerName: p.container_name,
        host: p.host,
        port: p.port,
        status: p.status,
        url: `http://localhost:${p.port}`,
        createdAt: p.created_at
      })),
      total: result.rows.length
    });
  } catch (error) {
    console.error('Error listing previews:', error);
    res.status(500).json({ error: 'Failed to list previews' });
  }
});

export default router;
