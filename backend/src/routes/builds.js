/**
 * Build Routes
 * Build history and logs
 */

import express from 'express';
import { getProjectBuilds } from '../db/queries.js';
import { query } from '../db/connection.js';
import { enforceQuotas } from '../middleware/quotas.js';

const router = express.Router();

// Anonymous user ID for MVP (no authentication required)
const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

// Helper function to get effective user ID (supports anonymous access in MVP)
function getEffectiveUserId(req) {
  return req.user?.id || ANONYMOUS_USER_ID;
}

/**
 * GET /api/builds/:id
 * Get build details
 */
router.get('/:id', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    const result = await query('SELECT * FROM builds WHERE id = $1', [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Build not found' });
    }

    const build = result.rows[0];

    // Check ownership
    const effectiveUserId = getEffectiveUserId(req);
    if (build.user_id !== effectiveUserId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json({
      success: true,
      build: {
        id: build.id,
        projectId: build.project_id,
        status: build.status,
        buildLogs: build.build_logs,
        errorMessage: build.error_message,
        builderContainerId: build.builder_container_id,
        imageId: build.image_id,
        queuedAt: build.queued_at,
        startedAt: build.started_at,
        finishedAt: build.finished_at,
        durationSeconds: build.duration_seconds,
        createdAt: build.created_at
      }
    });
  } catch (error) {
    console.error('Error getting build:', error);
    res.status(500).json({ error: 'Failed to get build' });
  }
});

/**
 * GET /api/projects/:projectId/builds
 * Get build history for a project
 */
router.get('/project/:projectId', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user?.id;
    const { limit = 10 } = req.query;

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

    // Get builds
    const builds = await getProjectBuilds(projectId, parseInt(limit));

    res.json({
      success: true,
      builds: builds.map(b => ({
        id: b.id,
        status: b.status,
        queuedAt: b.queued_at,
        startedAt: b.started_at,
        finishedAt: b.finished_at,
        durationSeconds: b.duration_seconds,
        errorMessage: b.error_message
      })),
      total: builds.length
    });
  } catch (error) {
    console.error('Error getting builds:', error);
    res.status(500).json({ error: 'Failed to get builds' });
  }
});

/**
 * GET /api/builds/:id/logs
 * Get build logs
 */
router.get('/:id/logs', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    const result = await query(
      'SELECT user_id, build_logs FROM builds WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Build not found' });
    }

    const build = result.rows[0];

    // Check ownership
    const effectiveUserId = getEffectiveUserId(req);
    if (build.user_id !== effectiveUserId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json({
      success: true,
      logs: build.build_logs || 'No logs available'
    });
  } catch (error) {
    console.error('Error getting build logs:', error);
    res.status(500).json({ error: 'Failed to get build logs' });
  }
});

export default router;
