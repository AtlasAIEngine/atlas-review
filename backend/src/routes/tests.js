/**
 * Test Routes
 * CRUD operations for automated tests and visual regression screenshots
 */

import express from 'express';
import { getProjectById } from '../db/queries.js';
import testService from '../services/testService.js';
import screenshotService from '../services/screenshotService.js';
import { enforceQuotas } from '../middleware/quotas.js';

const router = express.Router();

// Anonymous user ID for MVP (no authentication required)
const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

// Helper function to check project ownership (supports anonymous access in MVP)
function checkOwnership(project, req) {
  const effectiveUserId = req.user?.id || ANONYMOUS_USER_ID;
  return project.user_id === effectiveUserId;
}

/**
 * GET /api/projects/:projectId/tests
 * List all tests for a project
 */
router.get('/:projectId/tests', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;

    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const tests = await testService.getTests(project.path);

    res.json({
      success: true,
      tests: tests.map(test => ({
        ...test,
        projectId,
      })),
    });
  } catch (error) {
    console.error('Error listing tests:', error);
    res.status(500).json({ error: 'Failed to list tests' });
  }
});

/**
 * POST /api/projects/:projectId/tests
 * Create a new test
 */
router.post('/:projectId/tests', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;
    const { name, steps } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Test name is required' });
    }

    if (!steps || !Array.isArray(steps)) {
      return res.status(400).json({ error: 'Test steps are required and must be an array' });
    }

    // Validate steps
    const validActions = ['click', 'type', 'navigate', 'assert', 'screenshot'];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      if (!step.action || !validActions.includes(step.action)) {
        return res.status(400).json({
          error: `Invalid action in step ${i + 1}. Must be one of: ${validActions.join(', ')}`,
        });
      }
      // Validate required fields per action
      if ((step.action === 'click' || step.action === 'type' || step.action === 'assert') && !step.selector) {
        return res.status(400).json({
          error: `Selector is required for ${step.action} action in step ${i + 1}`,
        });
      }
      if (step.action === 'type' && step.value === undefined) {
        return res.status(400).json({
          error: `Value is required for type action in step ${i + 1}`,
        });
      }
      if (step.action === 'navigate' && !step.value) {
        return res.status(400).json({
          error: `URL value is required for navigate action in step ${i + 1}`,
        });
      }
      // Screenshot action has optional fields (screenshotName, threshold)
    }

    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const test = await testService.saveTest(project.path, { name, steps });

    res.status(201).json({
      success: true,
      test: {
        ...test,
        projectId,
      },
    });
  } catch (error) {
    console.error('Error creating test:', error);
    res.status(500).json({ error: 'Failed to create test' });
  }
});

/**
 * GET /api/projects/:projectId/tests/:testId
 * Get a single test
 */
router.get('/:projectId/tests/:testId', enforceQuotas, async (req, res) => {
  try {
    const { projectId, testId } = req.params;

    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const test = await testService.getTest(project.path, testId);

    if (!test) {
      return res.status(404).json({ error: 'Test not found' });
    }

    res.json({
      success: true,
      test: {
        ...test,
        projectId,
      },
    });
  } catch (error) {
    console.error('Error getting test:', error);
    res.status(500).json({ error: 'Failed to get test' });
  }
});

/**
 * PUT /api/projects/:projectId/tests/:testId
 * Update a test
 */
router.put('/:projectId/tests/:testId', enforceQuotas, async (req, res) => {
  try {
    const { projectId, testId } = req.params;
    const { name, steps } = req.body;

    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const existingTest = await testService.getTest(project.path, testId);

    if (!existingTest) {
      return res.status(404).json({ error: 'Test not found' });
    }

    // Validate steps if provided
    if (steps) {
      const validActions = ['click', 'type', 'navigate', 'assert', 'screenshot'];
      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        if (!step.action || !validActions.includes(step.action)) {
          return res.status(400).json({
            error: `Invalid action in step ${i + 1}. Must be one of: ${validActions.join(', ')}`,
          });
        }
      }
    }

    const test = await testService.saveTest(project.path, {
      id: testId,
      name: name || existingTest.name,
      steps: steps || existingTest.steps,
      createdAt: existingTest.createdAt,
    });

    res.json({
      success: true,
      test: {
        ...test,
        projectId,
      },
    });
  } catch (error) {
    console.error('Error updating test:', error);
    res.status(500).json({ error: 'Failed to update test' });
  }
});

/**
 * DELETE /api/projects/:projectId/tests/:testId
 * Delete a test
 */
router.delete('/:projectId/tests/:testId', enforceQuotas, async (req, res) => {
  try {
    const { projectId, testId } = req.params;

    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const deleted = await testService.deleteTest(project.path, testId);

    if (!deleted) {
      return res.status(404).json({ error: 'Test not found' });
    }

    res.json({
      success: true,
      message: 'Test deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting test:', error);
    res.status(500).json({ error: 'Failed to delete test' });
  }
});

/**
 * GET /api/projects/:projectId/tests/:testId/results
 * Get test results for a test
 */
router.get('/:projectId/tests/:testId/results', enforceQuotas, async (req, res) => {
  try {
    const { projectId, testId } = req.params;
    const { limit = 10 } = req.query;

    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const test = await testService.getTest(project.path, testId);

    if (!test) {
      return res.status(404).json({ error: 'Test not found' });
    }

    const results = await testService.getResults(project.path, testId, parseInt(limit, 10));

    res.json({
      success: true,
      results,
    });
  } catch (error) {
    console.error('Error getting test results:', error);
    res.status(500).json({ error: 'Failed to get test results' });
  }
});

/**
 * POST /api/projects/:projectId/tests/:testId/results
 * Save a test result
 */
router.post('/:projectId/tests/:testId/results', enforceQuotas, async (req, res) => {
  try {
    const { projectId, testId } = req.params;
    const { status, steps, duration } = req.body;

    if (!status || !['pass', 'fail'].includes(status)) {
      return res.status(400).json({ error: 'Status must be "pass" or "fail"' });
    }

    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const test = await testService.getTest(project.path, testId);

    if (!test) {
      return res.status(404).json({ error: 'Test not found' });
    }

    const result = await testService.saveResult(project.path, testId, {
      status,
      steps: steps || [],
      duration: duration || 0,
    });

    res.status(201).json({
      success: true,
      result,
    });
  } catch (error) {
    console.error('Error saving test result:', error);
    res.status(500).json({ error: 'Failed to save test result' });
  }
});

// ============================================================================
// SCREENSHOT API ENDPOINTS
// ============================================================================

/**
 * POST /api/projects/:projectId/tests/:testId/screenshots
 * Save a screenshot for a test step
 */
router.post('/:projectId/tests/:testId/screenshots', enforceQuotas, async (req, res) => {
  try {
    const { projectId, testId } = req.params;
    const { stepIndex, imageData, type = 'current' } = req.body;

    if (stepIndex === undefined || stepIndex < 0) {
      return res.status(400).json({ error: 'stepIndex is required and must be >= 0' });
    }

    if (!imageData) {
      return res.status(400).json({ error: 'imageData is required' });
    }

    if (!['current', 'baseline'].includes(type)) {
      return res.status(400).json({ error: 'type must be "current" or "baseline"' });
    }

    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const test = await testService.getTest(project.path, testId);

    if (!test) {
      return res.status(404).json({ error: 'Test not found' });
    }

    const result = await screenshotService.saveScreenshot(
      project.path,
      testId,
      stepIndex,
      imageData,
      type
    );

    res.status(201).json({
      success: true,
      screenshot: result,
    });
  } catch (error) {
    console.error('Error saving screenshot:', error);
    res.status(500).json({ error: 'Failed to save screenshot' });
  }
});

/**
 * GET /api/projects/:projectId/tests/:testId/screenshots/:stepIndex/baseline
 * Get baseline screenshot for a test step
 */
router.get('/:projectId/tests/:testId/screenshots/:stepIndex/baseline', enforceQuotas, async (req, res) => {
  try {
    const { projectId, testId, stepIndex } = req.params;

    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const baseline = await screenshotService.getBaseline(project.path, testId, parseInt(stepIndex, 10));

    res.json({
      success: true,
      baseline,
    });
  } catch (error) {
    console.error('Error getting baseline:', error);
    res.status(500).json({ error: 'Failed to get baseline' });
  }
});

/**
 * POST /api/projects/:projectId/tests/:testId/screenshots/:stepIndex/set-baseline
 * Set current screenshot or provided image as baseline
 */
router.post('/:projectId/tests/:testId/screenshots/:stepIndex/set-baseline', enforceQuotas, async (req, res) => {
  try {
    const { projectId, testId, stepIndex } = req.params;
    const { imageData } = req.body;

    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const test = await testService.getTest(project.path, testId);

    if (!test) {
      return res.status(404).json({ error: 'Test not found' });
    }

    let result;
    if (imageData) {
      // Set baseline from provided image data
      result = await screenshotService.setBaselineFromData(
        project.path,
        testId,
        parseInt(stepIndex, 10),
        imageData
      );
    } else {
      // Set baseline from current screenshot
      result = await screenshotService.setBaseline(
        project.path,
        testId,
        parseInt(stepIndex, 10)
      );
    }

    res.json({
      success: true,
      baseline: result,
    });
  } catch (error) {
    console.error('Error setting baseline:', error);
    if (error.message.includes('not found')) {
      return res.status(404).json({ error: error.message });
    }
    res.status(500).json({ error: 'Failed to set baseline' });
  }
});

/**
 * POST /api/projects/:projectId/tests/:testId/screenshots/:stepIndex/compare
 * Compare current screenshot against baseline
 */
router.post('/:projectId/tests/:testId/screenshots/:stepIndex/compare', enforceQuotas, async (req, res) => {
  try {
    const { projectId, testId, stepIndex } = req.params;
    const { imageData, threshold = 0.001 } = req.body;

    if (!imageData) {
      return res.status(400).json({ error: 'imageData is required' });
    }

    const project = await getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const test = await testService.getTest(project.path, testId);

    if (!test) {
      return res.status(404).json({ error: 'Test not found' });
    }

    // Save current screenshot first
    await screenshotService.saveScreenshot(
      project.path,
      testId,
      parseInt(stepIndex, 10),
      imageData,
      'current'
    );

    // Compare against baseline
    const result = await screenshotService.compareScreenshots(
      project.path,
      testId,
      parseInt(stepIndex, 10),
      imageData,
      threshold
    );

    res.json({
      success: true,
      comparison: result,
    });
  } catch (error) {
    console.error('Error comparing screenshots:', error);
    res.status(500).json({ error: 'Failed to compare screenshots' });
  }
});

export default router;
