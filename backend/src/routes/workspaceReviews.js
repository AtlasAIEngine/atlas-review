import express from 'express';

import { getProjectById } from '../db/queries.js';
import workspaceReviewService from '../services/workspaceReviewService.js';
import reviewService from '../services/reviewService.js';
import trustAnalyticsService from '../services/trustAnalyticsService.js';
import { enforceQuotas } from '../middleware/quotas.js';
import { resolveVisibleReviewFileLimit } from '../utils/reviewFileSelection.js';

const router = express.Router();

const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

function checkOwnership(project, req) {
  const effectiveUserId = req.user?.id || ANONYMOUS_USER_ID;
  return project.user_id === effectiveUserId;
}

function parseBooleanFlag(value, defaultValue = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return defaultValue;
}

function normalizeRequestedPaths(paths, maxCount = 40) {
  if (!Array.isArray(paths)) return [];
  return [...new Set(paths.map((value) => String(value || '').trim()).filter(Boolean))].slice(0, maxCount);
}

function resolveWorkspaceBaseBranch(project) {
  const candidates = [
    project?.default_branch,
    project?.defaultBranch,
    project?.base_branch,
    project?.baseBranch,
    'main',
  ];
  for (const value of candidates) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function buildRuntimeState(queueEntry) {
  if (!queueEntry) return null;
  return {
    updatedAt: queueEntry.updatedAt || new Date().toISOString(),
    progress: queueEntry.progress || {
      phase: queueEntry.status === 'queued' ? 'queued' : 'running',
      updatedAt: queueEntry.updatedAt || new Date().toISOString(),
    },
  };
}

function getWorkspaceQueueEntry(workspaceReviewId) {
  const queueEntries = reviewService.getQueueStatus();
  return queueEntries.find((entry) => entry.type === 'workspace_review' && entry.workspaceReviewId === workspaceReviewId) || null;
}

async function hydrateWorkspaceReview(project, workspaceReviewId, { includeContent = false, includeAllFiles = false, visibleFileLimit } = {}) {
  const baseBranch = resolveWorkspaceBaseBranch(project);
  const baseOptions = {
    projectId: project.id,
    baseBranch,
    includeContent,
    // includeAllFiles=true sends null to bypass the cap entirely; otherwise
    // pass the resolved numeric limit through.
    visibleFileLimit: includeAllFiles ? null : visibleFileLimit,
  };
  let review = workspaceReviewId
    ? await workspaceReviewService.getById(project.path, workspaceReviewId, baseOptions)
    : await workspaceReviewService.getCurrent(project.path, baseOptions);
  if (!review) return null;
  const runtimeState = buildRuntimeState(getWorkspaceQueueEntry(review.id));
  if (runtimeState) {
    review = await workspaceReviewService.getById(project.path, review.id, {
      ...baseOptions,
      runtimeState,
    });
    if (!review) return null;
  }
  const trustAnalytics = await trustAnalyticsService.getWorkspaceReviewTrustAnalytics({
    projectId: project.id,
    workspaceReview: review,
  }).catch(() => null);
  return trustAnalytics
    ? { ...review, trustAnalytics }
    : review;
}

router.get('/:projectId/workspace-reviews', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;
    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!checkOwnership(project, req)) return res.status(403).json({ error: 'Forbidden' });

    const review = await hydrateWorkspaceReview(project, null, {
      includeContent: parseBooleanFlag(req.query.includeContent, false),
      includeAllFiles: parseBooleanFlag(req.query.includeAllFiles, false),
      visibleFileLimit: resolveVisibleReviewFileLimit(req.query.visibleFileLimit),
    });
    res.json({
      success: true,
      workspaceReviews: review ? [review] : [],
    });
  } catch (error) {
    console.error('Error listing workspace reviews:', error);
    res.status(500).json({ error: error.message || 'Failed to list workspace reviews' });
  }
});

router.get('/:projectId/workspace-reviews/:workspaceReviewId', enforceQuotas, async (req, res) => {
  try {
    const { projectId, workspaceReviewId } = req.params;
    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!checkOwnership(project, req)) return res.status(403).json({ error: 'Forbidden' });

    const review = await hydrateWorkspaceReview(project, workspaceReviewId, {
      includeContent: parseBooleanFlag(req.query.includeContent, false),
      includeAllFiles: parseBooleanFlag(req.query.includeAllFiles, false),
      visibleFileLimit: resolveVisibleReviewFileLimit(req.query.visibleFileLimit),
    });
    if (!review) {
      return res.status(404).json({ error: 'Workspace review not found' });
    }

    res.json({ success: true, workspaceReview: review });
  } catch (error) {
    console.error('Error getting workspace review:', error);
    res.status(500).json({ error: error.message || 'Failed to get workspace review' });
  }
});

router.post('/:projectId/workspace-reviews/:workspaceReviewId/files/content', enforceQuotas, async (req, res) => {
  try {
    const { projectId, workspaceReviewId } = req.params;
    const requestedPaths = normalizeRequestedPaths(req.body?.paths, 40);
    if (requestedPaths.length === 0) {
      return res.status(400).json({ error: 'paths must include at least one file path' });
    }

    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!checkOwnership(project, req)) return res.status(403).json({ error: 'Forbidden' });

    const review = await hydrateWorkspaceReview(project, workspaceReviewId, {
      includeContent: true,
      visibleFileLimit: null,
    });
    if (!review) {
      return res.status(404).json({ error: 'Workspace review not found' });
    }

    const fileMap = new Map((Array.isArray(review.files) ? review.files : []).map((file) => [file.path, file]));
    const missingPaths = requestedPaths.filter((filePath) => !fileMap.has(filePath));
    const files = requestedPaths.map((filePath) => fileMap.get(filePath)).filter(Boolean);

    res.json({ success: true, files, missingPaths });
  } catch (error) {
    console.error('Error loading workspace review file contents:', error);
    res.status(500).json({ error: error.message || 'Failed to load file contents' });
  }
});

router.post('/:projectId/workspace-reviews/:workspaceReviewId/review/queue', enforceQuotas, async (req, res) => {
  try {
    const { projectId, workspaceReviewId } = req.params;
    const { reviewMode, policySource } = req.body || {};

    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!checkOwnership(project, req)) return res.status(403).json({ error: 'Forbidden' });
    if (!project.path) {
      return res.status(400).json({ error: 'Project has no local path — cannot queue workspace review' });
    }

    const review = await hydrateWorkspaceReview(project, workspaceReviewId, { includeContent: false });
    if (!review) {
      return res.status(404).json({ error: 'Workspace review not found' });
    }

    const queueEntry = getWorkspaceQueueEntry(workspaceReviewId);
    if (queueEntry) {
      return res.json({
        success: true,
        alreadyRunning: true,
        id: queueEntry.id,
        position: reviewService.getQueueStatus().findIndex((entry) => entry.id === queueEntry.id) + 1,
        workspaceReview: review,
      });
    }

    const entry = reviewService.enqueueWorkspaceReview(projectId, project.path, workspaceReviewId, {
      baseBranch: resolveWorkspaceBaseBranch(project),
      reviewMode,
      policySource,
    });

    res.json({ success: true, position: entry.position, id: entry.id, workspaceReview: review });
  } catch (error) {
    console.error('Error queueing workspace review:', error);
    res.status(500).json({ error: error.message || 'Failed to queue workspace review' });
  }
});

router.delete('/:projectId/workspace-reviews/:workspaceReviewId/review/queue', async (req, res) => {
  try {
    const { projectId, workspaceReviewId } = req.params;
    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!checkOwnership(project, req)) return res.status(403).json({ error: 'Forbidden' });

    const queueEntry = getWorkspaceQueueEntry(workspaceReviewId);
    if (!queueEntry) {
      return res.json({ success: true, stopped: false, was: null });
    }

    const result = await reviewService.stopReview(queueEntry.id);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error stopping workspace review:', error);
    res.status(500).json({ error: error.message || 'Failed to stop workspace review' });
  }
});

export default router;
