/**
 * CodeGraph routes — per-project enablement and index lifecycle.
 *
 * Endpoints:
 *   GET    /api/projects/:projectId/codegraph/status     → current enablement + latest index row
 *   PUT    /api/projects/:projectId/codegraph/enabled    → flip user's desired enablement
 *   POST   /api/projects/:projectId/codegraph/init       → start (or restart) indexing
 *   POST   /api/projects/:projectId/codegraph/uninit     → remove on-disk index, mark stale
 *
 * Two-state model — see codegraphService.js:
 *   - The toggle only flips the user's desired enablement.
 *   - Init runs async; the frontend polls status to follow progress.
 *   - Toggling OFF does not delete the index; only uninit does.
 *   - Reviews use CodeGraph only when toggle is ON AND a ready index row
 *     exists AND its worktree_sha === reviewHeadSha (invariant I1).
 */

import express from 'express';
import { getProjectById } from '../db/queries.js';
import {
  getStatus,
  setEnabled,
  initIndex,
  uninit,
  isCliAvailable,
  getRecentLogs,
} from '../services/codegraphService.js';

const router = express.Router();

const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

function checkOwnership(project, req) {
  const effectiveUserId = req.user?.id || ANONYMOUS_USER_ID;
  return project.user_id === effectiveUserId;
}

async function loadAuthorizedProject(req, res) {
  const { projectId } = req.params;
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

/**
 * Shape the service-layer status into a stable JSON wire shape. The
 * frontend reads this directly; keep field names stable.
 *
 * `recentLogs` is a newest-last array of `{ ts, stream, line }` entries
 * captured from the codegraph CLI's stdout/stderr during the most recent
 * init for this project. Empty when no init has run this session.
 */
function serializeStatus(projectId, status, cliAvailable) {
  const latest = status.latestIndex || null;
  return {
    enabled: status.enabled,
    cliAvailable,
    effectiveReadyForReview: Boolean(status.effectiveReadyForReview),
    index: latest
      ? {
        id: latest.id,
        state: latest.state,
        codegraphVersion: latest.codegraph_version || null,
        worktreeSha: latest.worktree_sha || null,
        startedAt: latest.started_at || null,
        readyAt: latest.ready_at || null,
        filesIndexed: Number.isFinite(Number(latest.files_indexed)) ? Number(latest.files_indexed) : 0,
        totalFiles: Number.isFinite(Number(latest.total_files)) ? Number(latest.total_files) : 0,
        nodes: latest.nodes != null ? Number(latest.nodes) : null,
        edges: latest.edges != null ? Number(latest.edges) : null,
        sizeBytes: latest.size_bytes != null ? Number(latest.size_bytes) : null,
        errorMessage: latest.error_message || null,
      }
      : null,
    recentLogs: getRecentLogs(projectId),
  };
}

router.get('/:projectId/codegraph/status', async (req, res) => {
  try {
    const project = await loadAuthorizedProject(req, res);
    if (!project) return;
    const [status, cliAvailable] = await Promise.all([
      getStatus(project.id),
      isCliAvailable(),
    ]);
    res.json(serializeStatus(project.id, status, cliAvailable));
  } catch (error) {
    console.error('[codegraph] GET status failed:', error);
    res.status(500).json({ error: error.message || 'Failed to read CodeGraph status' });
  }
});

router.put('/:projectId/codegraph/enabled', async (req, res) => {
  try {
    const project = await loadAuthorizedProject(req, res);
    if (!project) return;
    const desired = req.body?.enabled === true || req.body?.enabled === 'true';
    await setEnabled(project.id, desired);
    const status = await getStatus(project.id);
    res.json({
      success: true,
      ...serializeStatus(project.id, status, await isCliAvailable()),
    });
  } catch (error) {
    console.error('[codegraph] PUT enabled failed:', error);
    res.status(500).json({ error: error.message || 'Failed to update CodeGraph enablement' });
  }
});

router.post('/:projectId/codegraph/init', async (req, res) => {
  try {
    const project = await loadAuthorizedProject(req, res);
    if (!project) return;
    if (!project.path) {
      return res.status(400).json({ error: 'Project has no local path — cannot index' });
    }
    const cliAvailable = await isCliAvailable();
    if (!cliAvailable) {
      return res.status(503).json({
        error: 'CodeGraph CLI not found on PATH. Install with `npm i -g @colbymchenry/codegraph`.',
      });
    }

    // Await the synchronous prep phase so the indexing row exists before
    // we respond. The actual spawn runs in the background via
    // `result._background`; the route does not block on it (indexing can
    // take seconds to minutes depending on repo size).
    const result = await initIndex({ projectId: project.id, projectPath: project.path });
    if (!result.ok) {
      return res.status(500).json({ error: result.error || 'Failed to start CodeGraph init' });
    }
    result._background?.catch?.((err) => {
      console.error('[codegraph] init background failure:', err);
    });

    const status = await getStatus(project.id);
    res.json({
      success: true,
      ...serializeStatus(project.id, status, cliAvailable),
    });
  } catch (error) {
    console.error('[codegraph] POST init failed:', error);
    res.status(500).json({ error: error.message || 'Failed to start CodeGraph init' });
  }
});

router.post('/:projectId/codegraph/uninit', async (req, res) => {
  try {
    const project = await loadAuthorizedProject(req, res);
    if (!project) return;
    if (!project.path) {
      return res.status(400).json({ error: 'Project has no local path' });
    }
    await uninit({ projectId: project.id, projectPath: project.path });
    const status = await getStatus(project.id);
    res.json({
      success: true,
      ...serializeStatus(project.id, status, await isCliAvailable()),
    });
  } catch (error) {
    console.error('[codegraph] POST uninit failed:', error);
    res.status(500).json({ error: error.message || 'Failed to remove CodeGraph index' });
  }
});

export default router;
