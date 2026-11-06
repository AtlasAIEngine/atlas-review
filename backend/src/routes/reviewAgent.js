import express from 'express';
import { getProjectById } from '../db/queries.js';
import reviewAgentStore from '../services/review/reviewAgentStore.js';

const router = express.Router();
const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

function getEffectiveUserId(req) {
  return req.user?.id || ANONYMOUS_USER_ID;
}

function checkOwnership(project, req) {
  const userId = getEffectiveUserId(req);
  return project.user_id === userId || project.user_id === ANONYMOUS_USER_ID;
}

function buildScope(req) {
  return {
    projectId: req.params.projectId,
    reviewType: req.query.reviewType || req.body?.reviewType,
    reviewId: req.query.reviewId || req.body?.reviewId,
  };
}

function normalizeActionResult(rawResult = {}) {
  const status = String(rawResult.status || '').trim().toLowerCase();
  if (!['opened', 'posted', 'applied', 'failed'].includes(status)) {
    throw new Error('action result status must be one of: opened, posted, applied, failed');
  }
  const label = String(rawResult.label || '').trim().slice(0, 180);
  const detail = String(rawResult.detail || '').trim().slice(0, 1000);
  const atValue = String(rawResult.at || '').trim();
  const at = Number.isNaN(new Date(atValue).getTime()) ? new Date().toISOString() : new Date(atValue).toISOString();
  return {
    status,
    label: label || status,
    ...(detail ? { detail } : {}),
    at,
  };
}

async function loadProject(req, res) {
  const project = await getProjectById(req.params.projectId);
  if (!project) {
    res.status(404).json({ success: false, error: 'Project not found' });
    return null;
  }
  if (!checkOwnership(project, req)) {
    res.status(403).json({ success: false, error: 'Forbidden' });
    return null;
  }
  return project;
}

router.get('/:projectId/review-agent/sessions', async (req, res) => {
  try {
    const project = await loadProject(req, res);
    if (!project) return;
    const sessions = await reviewAgentStore.listSessions(buildScope(req));
    res.json({ success: true, sessions });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message || 'Failed to list review assistant sessions' });
  }
});

router.post('/:projectId/review-agent/sessions', async (req, res) => {
  try {
    const project = await loadProject(req, res);
    if (!project) return;
    const session = await reviewAgentStore.getOrCreateSession({
      ...buildScope(req),
      userId: getEffectiveUserId(req),
      providerType: req.body?.providerType,
      providerModel: req.body?.providerModel,
      title: req.body?.title,
    });
    res.json({ success: true, session });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message || 'Failed to create review assistant session' });
  }
});

router.get('/:projectId/review-agent/sessions/:sessionId/messages', async (req, res) => {
  try {
    const project = await loadProject(req, res);
    if (!project) return;
    const scope = buildScope(req);
    const session = await reviewAgentStore.getSession(req.params.sessionId, scope);
    if (!session || session.status === 'deleted') {
      return res.status(404).json({ success: false, error: 'Review assistant session not found' });
    }
    const messages = await reviewAgentStore.listMessages(session.id, { limit: req.query.limit });
    res.json({ success: true, messages });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message || 'Failed to load review assistant messages' });
  }
});

router.patch('/:projectId/review-agent/sessions/:sessionId/messages/:messageId/action-results', async (req, res) => {
  try {
    const project = await loadProject(req, res);
    if (!project) return;
    const scope = buildScope(req);
    const session = await reviewAgentStore.getSession(req.params.sessionId, scope);
    if (!session || session.status !== 'active') {
      return res.status(404).json({ success: false, error: 'Review assistant session not found' });
    }
    const actionKey = String(req.body?.actionKey || '').trim().slice(0, 240);
    if (!actionKey) {
      return res.status(400).json({ success: false, error: 'actionKey is required' });
    }
    const result = normalizeActionResult(req.body?.result || {});
    const message = await reviewAgentStore.recordMessageActionResult(
      session.id,
      req.params.messageId,
      actionKey,
      result
    );
    if (!message) {
      return res.status(404).json({ success: false, error: 'Review assistant message not found' });
    }
    res.json({ success: true, message });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message || 'Failed to record review assistant action result' });
  }
});

router.delete('/:projectId/review-agent/sessions/:sessionId', async (req, res) => {
  try {
    const project = await loadProject(req, res);
    if (!project) return;
    const deleted = await reviewAgentStore.deleteSession(req.params.sessionId, buildScope(req));
    res.json({ success: true, deleted });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message || 'Failed to delete review assistant session' });
  }
});

export default router;
