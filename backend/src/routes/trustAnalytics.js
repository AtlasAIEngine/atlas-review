import express from 'express';
import { getProjectById } from '../db/queries.js';
import { enforceQuotas } from '../middleware/quotas.js';
import trustAnalyticsService from '../services/trustAnalyticsService.js';
import trustAnalyticsBreakdownService from '../services/trustAnalyticsBreakdownService.js';

const router = express.Router();
const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

function checkOwnership(project, req) {
  const effectiveUserId = req.user?.id || ANONYMOUS_USER_ID;
  return project.user_id === effectiveUserId;
}

async function resolveOwnedProject(projectId, req, res) {
  const project = await getProjectById(projectId);
  if (!project) {
    res.status(404).json({ error: 'Project not found' });
    return null;
  }
  if (!checkOwnership(project, req)) {
    res.status(403).json({ error: 'Forbidden' });
    return null;
  }
  return project;
}

function handleAnalyticsRouteError(error, res, fallbackMessage) {
  const status = Number(error?.status);
  if (Number.isInteger(status) && status >= 400 && status <= 599) {
    res.status(status).json({ error: error.message });
    return;
  }
  console.error(fallbackMessage, error);
  res.status(500).json({ error: fallbackMessage });
}

router.get('/:projectId/trust-analytics/summary', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;
    const project = await resolveOwnedProject(projectId, req, res);
    if (!project) return;

    const summary = await trustAnalyticsService.getProjectTrustAnalyticsSummary({
      projectId,
      projectPath: project.path,
      scope: req.query.scope,
      reviewType: req.query.reviewType,
      window: req.query.window,
      from: req.query.from,
      to: req.query.to,
    });

    res.json({ success: true, summary });
  } catch (error) {
    handleAnalyticsRouteError(error, res, 'Failed to get Trust Analytics summary');
  }
});

router.get('/:projectId/trust-analytics/timeseries', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;
    const project = await resolveOwnedProject(projectId, req, res);
    if (!project) return;

    const timeseries = await trustAnalyticsService.getProjectTrustAnalyticsTimeseries({
      projectId,
      projectPath: project.path,
      scope: req.query.scope,
      reviewType: req.query.reviewType,
      metric: req.query.metric,
      window: req.query.window,
      from: req.query.from,
      to: req.query.to,
      interval: req.query.interval,
    });

    res.json({ success: true, timeseries });
  } catch (error) {
    handleAnalyticsRouteError(error, res, 'Failed to get Trust Analytics timeseries');
  }
});

router.get('/:projectId/trust-analytics/breakdown', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;
    const project = await resolveOwnedProject(projectId, req, res);
    if (!project) return;

    const breakdown = await trustAnalyticsBreakdownService.getProjectTrustAnalyticsBreakdown({
      projectId,
      projectPath: project.path,
      scope: req.query.scope,
      reviewType: req.query.reviewType,
      metric: req.query.metric,
      by: req.query.by,
      window: req.query.window,
      from: req.query.from,
      to: req.query.to,
      limit: req.query.limit,
    });

    res.json({ success: true, breakdown });
  } catch (error) {
    handleAnalyticsRouteError(error, res, 'Failed to get Trust Analytics breakdown');
  }
});

export default router;
