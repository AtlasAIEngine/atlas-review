/**
 * Memory Routes
 * CLAUDE.md management endpoints
 */

import express from 'express';
import { getProjectById } from '../db/queries.js';
import memoryService from '../services/memoryService.js';
import { enforceQuotas } from '../middleware/quotas.js';

const router = express.Router();

// Anonymous user ID for MVP (no authentication required)
const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

// Helper function to get effective user ID (supports anonymous access in MVP)
function getEffectiveUserId(req) {
  return req.user?.id || ANONYMOUS_USER_ID;
}

// Helper function to check project ownership (supports anonymous access in MVP)
function checkOwnership(project, req) {
  const effectiveUserId = getEffectiveUserId(req);
  return project.user_id === effectiveUserId;
}

/**
 * GET /api/projects/:id/memory
 * Get CLAUDE.md content for a project
 */
router.get('/:id/memory', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    const project = await getProjectById(id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Check ownership
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Get memory content
    const content = await memoryService.getMemoryContent(project.path);

    if (!content) {
      return res.status(404).json({ error: 'Memory not found' });
    }

    // Get memory stats
    const stats = await memoryService.getMemoryStats(project.id, project.path);

    res.json({
      success: true,
      content,
      stats: {
        currentSize: stats.currentSize,
        totalSnapshots: stats.totalSnapshots,
        checkpoints: stats.checkpoints,
        autoSnapshots: stats.autoSnapshots,
        lastUpdate: stats.lastUpdate
      }
    });
  } catch (error) {
    console.error('Error getting memory:', error);
    res.status(500).json({ error: 'Failed to get memory' });
  }
});

/**
 * POST /api/projects/:id/memory
 * Update CLAUDE.md content
 */
router.post('/:id/memory', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    const { updates } = req.body;

    if (!updates) {
      return res.status(400).json({ error: 'Updates are required' });
    }

    const project = await getProjectById(id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Check ownership
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Update memory
    const success = await memoryService.updateMemory(
      project.id,
      project.path,
      userId,
      updates
    );

    if (success) {
      res.json({
        success: true,
        message: 'Memory updated successfully'
      });
    } else {
      res.status(500).json({ error: 'Failed to update memory' });
    }
  } catch (error) {
    console.error('Error updating memory:', error);
    res.status(500).json({ error: 'Failed to update memory' });
  }
});

/**
 * POST /api/projects/:id/memory/checkpoint
 * Create a named checkpoint
 */
router.post('/:id/memory/checkpoint', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    const { name, notes } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Checkpoint name is required' });
    }

    const project = await getProjectById(id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Check ownership
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Create checkpoint
    const checkpoint = await memoryService.createCheckpoint(
      project.id,
      project.path,
      userId,
      name,
      notes
    );

    res.json({
      success: true,
      checkpoint: {
        id: checkpoint.snapshotId,
        name,
        notes,
        timestamp: checkpoint.timestamp
      },
      message: `Checkpoint '${name}' created successfully`
    });
  } catch (error) {
    console.error('Error creating checkpoint:', error);
    res.status(500).json({ error: 'Failed to create checkpoint' });
  }
});

/**
 * GET /api/projects/:id/memory/stats
 * Get memory statistics
 */
router.get('/:id/memory/stats', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    const project = await getProjectById(id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Check ownership
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Get stats
    const stats = await memoryService.getMemoryStats(project.id, project.path);

    res.json({
      success: true,
      stats: {
        currentSize: stats.currentSize,
        totalSnapshots: stats.totalSnapshots,
        checkpoints: stats.checkpoints,
        autoSnapshots: stats.autoSnapshots,
        totalSize: stats.totalSize,
        lastUpdate: stats.lastUpdate,
        oldestSnapshot: stats.oldestSnapshot
      }
    });
  } catch (error) {
    console.error('Error getting memory stats:', error);
    res.status(500).json({ error: 'Failed to get memory stats' });
  }
});

/**
 * POST /api/projects/:id/memory/compact
 * Compact memory (remove old auto-snapshots)
 */
router.post('/:id/memory/compact', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;
    const { keepLastN = 5 } = req.body;

    const project = await getProjectById(id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Check ownership
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Compact memory
    const removedCount = await memoryService.compactMemory(project.id, keepLastN);

    res.json({
      success: true,
      removedCount,
      message: `Removed ${removedCount} old auto-snapshots`
    });
  } catch (error) {
    console.error('Error compacting memory:', error);
    res.status(500).json({ error: 'Failed to compact memory' });
  }
});

/**
 * GET /api/projects/:id/memory/health
 * Analyze memory health
 */
router.get('/:id/memory/health', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    const project = await getProjectById(id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Check ownership
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Analyze health
    const health = await memoryService.analyzeMemoryHealth(project.id, project.path);

    res.json({
      success: true,
      health
    });
  } catch (error) {
    console.error('Error analyzing memory health:', error);
    res.status(500).json({ error: 'Failed to analyze memory health' });
  }
});

/**
 * POST /api/projects/:id/memory/init
 * Initialize memory for existing project
 */
router.post('/:id/memory/init', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id;

    const project = await getProjectById(id);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Check ownership
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Check if memory already exists
    const exists = await memoryService.memoryExists(project.path);

    if (exists) {
      return res.status(400).json({ error: 'Memory already initialized' });
    }

    // Initialize memory
    const result = await memoryService.initializeMemory(
      project.id,
      project.path,
      project.name,
      userId,
      {
        framework: project.framework,
        language: project.language,
        description: project.description
      }
    );

    res.json({
      success: true,
      result,
      message: 'Memory initialized successfully'
    });
  } catch (error) {
    console.error('Error initializing memory:', error);
    res.status(500).json({ error: 'Failed to initialize memory' });
  }
});

export default router;
