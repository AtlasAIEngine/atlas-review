/**
 * Development Server API Routes
 * Auto-start dev servers for Vite/Next.js/CRA projects
 */

import express from 'express';
import devServerService from '../services/devServerService.js';
import { getProjectById } from '../db/queries.js';

const router = express.Router();

/**
 * POST /api/devservers/:projectId/start
 * Start development server for a project
 */
router.post('/:projectId/start', async (req, res) => {
  try {
    const { projectId } = req.params;
    const userId = req.user?.id || '00000000-0000-0000-0000-000000000000';

    // Get project details
    const project = await getProjectById(projectId);
    if (!project) {
      return res.status(404).json({
        success: false,
        error: 'Project not found',
      });
    }

    // Start dev server
    const result = await devServerService.startDevServer(
      projectId,
      project.path,
      userId
    );

    res.json({
      success: true,
      devServer: result,
    });
  } catch (error) {
    console.error('Failed to start dev server:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * DELETE /api/devservers/:projectId
 * Stop development server for a project
 */
router.delete('/:projectId', async (req, res) => {
  try {
    const { projectId } = req.params;

    const result = await devServerService.stopDevServer(projectId);

    res.json({
      success: true,
      message: result.message,
    });
  } catch (error) {
    console.error('Failed to stop dev server:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/devservers/:projectId/status
 * Get development server status
 */
router.get('/:projectId/status', async (req, res) => {
  try {
    const { projectId } = req.params;

    const project = await getProjectById(projectId);
    const status = await devServerService.getDevServerStatus(projectId, project?.path || null);

    res.json({
      success: true,
      devServer: status,
    });
  } catch (error) {
    console.error('Failed to get dev server status:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * GET /api/devservers/:projectId/logs
 * Get development server logs
 */
router.get('/:projectId/logs', async (req, res) => {
  try {
    const { projectId } = req.params;
    const limit = parseInt(req.query.limit) || 100;

    const logs = devServerService.getDevServerLogs(projectId, limit);

    res.json({
      success: true,
      logs,
    });
  } catch (error) {
    console.error('Failed to get dev server logs:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
