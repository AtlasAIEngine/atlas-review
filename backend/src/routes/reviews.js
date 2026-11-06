/**
 * Review API Routes
 * Endpoints for the Trust Pipeline review engine.
 */

import path from 'node:path';
import express from 'express';
import { getProjectById } from '../db/queries.js';
import reviewService from '../services/reviewService.js';
import reviewQualityHarness from '../services/reviewQualityHarness.js';
import changesetService from '../services/changesetService.js';
import branchReviewService from '../services/branchReviewService.js';
import prReviewService from '../services/prReviewService.js';
import workspaceReviewService from '../services/workspaceReviewService.js';
import gitService from '../services/gitService.js';
import reviewOutcomeService from '../services/reviewOutcomeService.js';
import reviewFixRunStore from '../services/review/reviewFixRunStore.js';
import trustAnalyticsFactService from '../services/trustAnalyticsFactService.js';
import reviewSyncService from '../services/reviewSyncService.js';
import { suppressBranchAutoReviewForSnapshot } from '../services/review/branchAutoReviewSuppression.js';
import { normalizePrecisionIssueCounters as normalizeSharedPrecisionIssueCounters } from '../../../shared/reviewPrecisionStats.js';

const router = express.Router();

const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';
const HARNESS_ENABLE_FLAG = 'ATLAS_ENABLE_REVIEW_HARNESS';
const HARNESS_TOKEN_ENV = 'ATLAS_REVIEW_HARNESS_TOKEN';

function normalizePrecisionIssueCounters(stats = {}) {
  return normalizeSharedPrecisionIssueCounters(stats, { includePassthrough: true });
}

function normalizeReviewPayload(review) {
  if (!review || typeof review !== 'object') return review;
  const stats = review.stats && typeof review.stats === 'object' ? review.stats : {};
  return {
    ...review,
    stats: normalizePrecisionIssueCounters(stats),
  };
}

function getRecommendationListFromReviewPayload(reviewPayload) {
  if (!reviewPayload || typeof reviewPayload !== 'object') return [];
  return Array.isArray(reviewPayload.recommendations) ? reviewPayload.recommendations : [];
}

function normalizeRecommendationLookupKey(rawKey) {
  return String(rawKey || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function buildRecommendationLookupByKey(reviewRecommendations = []) {
  const lookup = {};
  for (const recommendation of Array.isArray(reviewRecommendations) ? reviewRecommendations : []) {
    if (!recommendation || typeof recommendation !== 'object') continue;
    let key = null;
    try {
      key = reviewOutcomeService.getRecommendationIdentityKey(recommendation);
    } catch {
      key = null;
    }
    const normalizedKey = normalizeRecommendationLookupKey(key);
    if (!normalizedKey) continue;
    if (!lookup[normalizedKey]) {
      lookup[normalizedKey] = recommendation;
    }
  }
  return lookup;
}

async function suppressQueuedBranchAutoReviewAfterCancel(entry, result) {
  if (entry?.type !== 'branch_review' || !entry.branchReviewId || !result?.stopped) return;
  let review = null;
  try {
    review = await branchReviewService.getById(entry.branchReviewId);
  } catch {
    review = null;
  }
  if (!review) return;
  await suppressBranchAutoReviewForSnapshot(review, {
    snapshot: entry.autoReviewSnapshot || null,
    reason: 'user_cancelled_queued_review',
  });
}

function buildOutcomePayloadWithDimensions(rawPayload = {}, context = {}) {
  const payload = (rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload))
    ? { ...rawPayload }
    : {};
  const recommendationLookup = context.recommendationLookup && typeof context.recommendationLookup === 'object'
    ? context.recommendationLookup
    : {};
  const recommendationKey = normalizeRecommendationLookupKey(payload.recommendationKey);
  const recommendation = (
    payload.recommendation && typeof payload.recommendation === 'object'
      ? payload.recommendation
      : (recommendationKey ? recommendationLookup[recommendationKey] : null)
  );
  const dimensions = reviewOutcomeService.getRecommendationOutcomeDimensions(
    recommendation,
    {
      providerType: context.providerType,
      providerModel: context.providerModel,
      filePath: payload.filePath ?? payload.file_path,
    }
  );

  return {
    ...payload,
    recommendation,
    dimensions,
  };
}

async function syncOutcomeAnalyticsScope(scope) {
  try {
    await trustAnalyticsFactService.syncReviewFacts(scope);
  } catch (error) {
    console.warn('[trust-analytics] Failed to sync facts after outcome mutation', {
      reviewType: scope?.reviewType,
      reviewId: scope?.reviewId,
      projectId: scope?.projectId,
      error: error?.message || error,
    });
  }
}

async function queueOutcomeSyncEvent(req, scope, eventInput) {
  try {
    const built = eventInput.type === 'cleared'
      ? reviewSyncService.buildFindingClearedEvent({
          projectId: scope.projectId,
          projectName: req.project?.name || null,
          projectPath: req.projectPath || null,
          reviewType: scope.reviewType,
          reviewId: scope.reviewId,
          recommendationKey: eventInput.recommendationKey,
          occurredAt: eventInput.occurredAt,
        })
      : reviewSyncService.buildFindingOutcomeEvent({
          projectId: scope.projectId,
          projectName: req.project?.name || null,
          projectPath: req.projectPath || null,
          reviewType: scope.reviewType,
          reviewId: scope.reviewId,
          recommendationKey: eventInput.recommendationKey,
          occurredAt: eventInput.occurredAt,
          status: eventInput.status,
          note: eventInput.note,
          dimensions: eventInput.dimensions,
        });
    await reviewSyncService.queueEvent(built);
  } catch (error) {
    console.warn('[review-sync] Failed to queue finding outcome event', {
      projectId: scope?.projectId,
      reviewType: scope?.reviewType,
      reviewId: scope?.reviewId,
      error: error?.message || error,
    });
  }
}

function emitReviewOutcomesUpdated(req, scope, action, recommendationKey = null) {
  const io = req.app?.get?.('io');
  if (!io || !scope?.projectId || !scope?.reviewType || !scope?.reviewId) return;
  io.to(`project-${scope.projectId}`).emit('review-outcomes-updated', {
    projectId: scope.projectId,
    reviewType: scope.reviewType,
    reviewId: scope.reviewId,
    action,
    recommendationKey: typeof recommendationKey === 'string' && recommendationKey.trim()
      ? recommendationKey.trim()
      : null,
  });
}

function classifyOutcomeRouteErrorStatus(error) {
  const toHttpStatus = (value) => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed)) return null;
    if (parsed < 400 || parsed > 599) return null;
    return parsed;
  };
  const explicitStatus = toHttpStatus(error?.status)
    ?? toHttpStatus(error?.statusCode)
    ?? toHttpStatus(error?.httpStatus)
    ?? toHttpStatus(error?.response?.status);
  if (explicitStatus) return explicitStatus;

  const normalizedCode = String(error?.code || '').trim().toUpperCase();
  if (normalizedCode === 'ENOENT') return 404;
  if (
    normalizedCode === 'SQLITE_CONSTRAINT'
    || normalizedCode.startsWith('SQLITE_CONSTRAINT_')
    || normalizedCode === 'SQLITE_MISMATCH'
    || normalizedCode === '22P02'
    || normalizedCode === '23502'
    || normalizedCode === '23503'
    || normalizedCode === '23505'
    || normalizedCode === '23514'
  ) {
    return 400;
  }

  if (error?.name === 'SyntaxError') {
    const syntaxMessage = String(error?.message || '').toLowerCase();
    if (syntaxMessage.includes('json')) return 400;
  }

  const message = String(error?.message || '').toLowerCase();
  if (message.includes('not found')) return 404;
  if (
    message.includes('required')
    || message.includes('must be')
    || message.includes('recommendationkey')
    || message.includes('recommendation must be')
    || message.includes('status must be')
  ) {
    return 400;
  }
  return 500;
}

function normalizeRepositoryPathValue(rawValue) {
  return String(rawValue || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');
}

function buildVerificationSnapshotTargetFiles(run) {
  return Array.from(new Set(
    (Array.isArray(run?.buildSummary?.filePaths) ? run.buildSummary.filePaths : [])
      .map((value) => normalizeRepositoryPathValue(value))
      .filter(Boolean)
  ));
}

function buildChangedRepositoryPathSet(status = {}) {
  const values = [
    ...(Array.isArray(status.modified) ? status.modified : []),
    ...(Array.isArray(status.created) ? status.created : []),
    ...(Array.isArray(status.deleted) ? status.deleted : []),
    ...(Array.isArray(status.staged) ? status.staged : []),
    ...(Array.isArray(status.notAdded) ? status.notAdded : []),
    ...((Array.isArray(status.renamed) ? status.renamed : []).flatMap((entry) => [entry?.from, entry?.to])),
  ];
  return new Set(
    values
      .map((value) => normalizeRepositoryPathValue(value))
      .filter(Boolean)
  );
}

async function respondWithScopedFixRuns(res, scope, rawLimit) {
  const listed = await reviewFixRunStore.listRuns(scope, { limit: rawLimit });
  res.json({
    success: true,
    scope: listed.scope,
    runs: listed.runs,
  });
}

async function respondWithLatestScopedFixRun(res, scope) {
  const run = await reviewFixRunStore.getLatestRun(scope);
  res.json({
    success: true,
    scope,
    run,
  });
}

async function resolveChangesetOutcomeContext(projectPath, changesetId) {
  const changeset = await changesetService.getChangeSet(projectPath, changesetId);
  if (!changeset) {
    throw new Error('Changeset not found');
  }
  const reviewPayload = normalizeReviewPayload(changeset.reviewData);
  const reviewRecommendations = getRecommendationListFromReviewPayload(reviewPayload);
  return {
    reviewType: 'changeset',
    reviewId: changesetId,
    reviewRecommendations,
    recommendationLookup: buildRecommendationLookupByKey(reviewRecommendations),
    providerType: reviewPayload?.provider?.type || null,
    providerModel: reviewPayload?.provider?.model || null,
  };
}

async function resolveBranchReviewOutcomeContext(projectId, branchReviewId) {
  const branchReview = await branchReviewService.getById(branchReviewId);
  if (!branchReview || branchReview.projectId !== projectId) {
    throw new Error('Branch review not found');
  }
  const reviewPayload = normalizeReviewPayload(branchReview.reviewJson);
  const reviewRecommendations = getRecommendationListFromReviewPayload(reviewPayload);
  return {
    reviewType: 'branch_review',
    reviewId: branchReviewId,
    reviewRecommendations,
    recommendationLookup: buildRecommendationLookupByKey(reviewRecommendations),
    providerType: reviewPayload?.provider?.type || null,
    providerModel: reviewPayload?.provider?.model || null,
  };
}

async function resolvePrReviewOutcomeContext(projectId, prReviewId) {
  const prReview = await prReviewService.getById(prReviewId);
  if (!prReview || prReview.projectId !== projectId) {
    throw new Error('PR review not found');
  }
  const reviewPayload = normalizeReviewPayload(prReview.reviewJson);
  const reviewRecommendations = getRecommendationListFromReviewPayload(reviewPayload);
  return {
    reviewType: 'pr_review',
    reviewId: prReviewId,
    reviewRecommendations,
    recommendationLookup: buildRecommendationLookupByKey(reviewRecommendations),
    providerType: reviewPayload?.provider?.type || null,
    providerModel: reviewPayload?.provider?.model || null,
  };
}

async function resolveWorkspaceReviewOutcomeContext(projectPath, projectId, workspaceReviewId) {
  const workspaceReview = await workspaceReviewService.getById(projectPath, workspaceReviewId, {
    projectId,
    includeContent: false,
  });
  if (!workspaceReview || workspaceReview.projectId !== projectId) {
    throw new Error('Workspace review not found');
  }
  const reviewPayload = normalizeReviewPayload(workspaceReview.reviewJson);
  const reviewRecommendations = getRecommendationListFromReviewPayload(reviewPayload);
  return {
    reviewType: 'workspace_review',
    reviewId: workspaceReviewId,
    reviewRecommendations,
    recommendationLookup: buildRecommendationLookupByKey(reviewRecommendations),
    providerType: reviewPayload?.provider?.type || null,
    providerModel: reviewPayload?.provider?.model || null,
  };
}

function isDesktopMode() {
  return process.env.ATLAS_DESKTOP_MODE === 'true';
}

function isNonProdMode() {
  return (process.env.NODE_ENV || 'development') !== 'production';
}

function isAuthenticatedRequest(req) {
  const userId = req.user?.id;
  return typeof userId === 'string' && userId !== ANONYMOUS_USER_ID;
}

function enforceHarnessAccess(req, res, { dryRun = false } = {}) {
  // Desktop/dev are treated as trusted local/internal environments.
  if (isDesktopMode() || isNonProdMode()) {
    return true;
  }

  // In production, require explicit feature flag and authenticated user.
  if (process.env[HARNESS_ENABLE_FLAG] !== 'true') {
    res.status(403).json({
      error: `Review harness is disabled. Set ${HARNESS_ENABLE_FLAG}=true to enable.`,
    });
    return false;
  }

  if (!isAuthenticatedRequest(req)) {
    res.status(401).json({ error: 'Authentication required for review harness.' });
    return false;
  }

  // Optional defense-in-depth token for internal/admin usage in production.
  const expectedToken = process.env[HARNESS_TOKEN_ENV];
  if (expectedToken) {
    const providedToken = req.get('x-atlas-harness-token');
    if (providedToken !== expectedToken) {
      res.status(403).json({ error: 'Invalid review harness token.' });
      return false;
    }
  }

  // Optional extra protection: allow dry-runs by default once enabled, but
  // require explicit opt-in for live provider calls in production.
  if (!dryRun && process.env.ATLAS_ENABLE_REVIEW_HARNESS_LIVE !== 'true') {
    res.status(403).json({
      error: 'Live harness execution disabled. Set ATLAS_ENABLE_REVIEW_HARNESS_LIVE=true to run provider-backed harness calls.',
    });
    return false;
  }

  return true;
}

/**
 * Middleware to resolve project path from projectId param
 */
async function resolveProject(req, res, next) {
  const { projectId } = req.params;
  if (!projectId) return next();

  try {
    const project = await getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const effectiveUserId = req.user?.id || ANONYMOUS_USER_ID;
    if (project.user_id !== effectiveUserId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    req.project = project;
    req.projectPath = project.path;
    next();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

/**
 * POST /api/projects/:projectId/changesets/:changesetId/review
 * Trigger a review on a changeset
 */
router.post('/projects/:projectId/changesets/:changesetId/review', resolveProject, async (req, res) => {
  try {
    const { changesetId } = req.params;
    const { force } = req.body;

    const result = await reviewService.reviewChangeset(req.projectPath, changesetId, { force });
    res.json({ success: true, review: normalizeReviewPayload(result) });
  } catch (error) {
    console.error('Review error:', error.message);
    const status = error.message.includes('not found') ? 404
      : error.message.includes('No active AI provider') ? 400
      : error.message.includes('Invalid API key') ? 401
      : error.message.includes('Rate limited') ? 429
      : 500;
    res.status(status).json({ error: error.message });
  }
});

/**
 * POST /api/projects/:projectId/changesets/:changesetId/review/queue
 * Add a changeset to the review queue
 */
router.post('/projects/:projectId/changesets/:changesetId/review/queue', resolveProject, async (req, res) => {
  try {
    const { changesetId } = req.params;
    const { force } = req.body || {};
    const queueEntry = reviewService.enqueueReview(req.projectPath, changesetId, { force: !!force });
    res.json({ success: true, ...queueEntry });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/projects/:projectId/changesets/:changesetId/review/queue
 * Cancel a queued review
 */
router.delete('/projects/:projectId/changesets/:changesetId/review/queue', resolveProject, async (req, res) => {
  try {
    const { changesetId } = req.params;
    // Try stopReview first (handles both queued and running entries)
    const queueEntries = reviewService.getQueueStatus();
    const match = queueEntries.find(
      e => e.type === 'changeset' && e.changesetId === changesetId
    );
    if (match) {
      const result = await reviewService.stopReview(match.id);
      return res.json({ success: true, stopped: result.stopped, was: result.was, cancelled: result.stopped });
    }
    // Fallback to cancelReview for backward compat
    const cancelled = reviewService.cancelReview(changesetId);
    res.json({ success: true, cancelled });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/projects/:projectId/changesets/:changesetId/review/dismiss
 * Clear failed/stale review state for a changeset.
 */
router.post('/projects/:projectId/changesets/:changesetId/review/dismiss', resolveProject, async (req, res) => {
  try {
    const { changesetId } = req.params;
    await reviewService.dismissChangeSetReviewFailure(req.projectPath, changesetId);
    res.json({ success: true });
  } catch (error) {
    const status = error.message?.includes('not found') ? 404 : 500;
    res.status(status).json({ error: error.message || 'Failed to dismiss review failure' });
  }
});

/**
 * GET /api/projects/:projectId/changesets/:changesetId/review/outcomes
 * List persisted recommendation outcomes for a changeset review scope.
 */
router.get('/projects/:projectId/changesets/:changesetId/review/outcomes', resolveProject, async (req, res) => {
  try {
    const { projectId, changesetId } = req.params;
    const context = await resolveChangesetOutcomeContext(req.projectPath, changesetId);
    const listed = await reviewOutcomeService.listOutcomes(
      {
        projectId,
        reviewType: context.reviewType,
        reviewId: context.reviewId,
      },
      {
        reviewRecommendations: context.reviewRecommendations,
      }
    );
    res.json({ success: true, ...listed });
  } catch (error) {
    const status = classifyOutcomeRouteErrorStatus(error);
    res.status(status).json({ error: error.message || 'Failed to list recommendation outcomes' });
  }
});

/**
 * PUT /api/projects/:projectId/changesets/:changesetId/review/outcomes
 * Upsert one recommendation outcome for a changeset review scope.
 */
router.put('/projects/:projectId/changesets/:changesetId/review/outcomes', resolveProject, async (req, res) => {
  try {
    const { projectId, changesetId } = req.params;
    const context = await resolveChangesetOutcomeContext(req.projectPath, changesetId);
    const scope = {
      projectId,
      projectPath: req.projectPath,
      reviewType: context.reviewType,
      reviewId: context.reviewId,
    };
    const outcomePayload = buildOutcomePayloadWithDimensions(req.body || {}, context);
    const outcome = await reviewOutcomeService.upsertOutcome(scope, outcomePayload);
    await queueOutcomeSyncEvent(req, scope, {
      type: 'outcome',
      recommendationKey: outcome?.recommendationKey || outcomePayload.recommendationKey,
      occurredAt: outcome?.updatedAt || new Date().toISOString(),
      status: outcome?.status || outcomePayload.status,
      note: outcome?.note || outcomePayload.note || null,
      dimensions: outcome?.dimensions || outcomePayload.dimensions || {},
    });
    await syncOutcomeAnalyticsScope(scope);
    const listed = await reviewOutcomeService.listOutcomes(
      scope,
      {
        reviewRecommendations: context.reviewRecommendations,
      }
    );
    emitReviewOutcomesUpdated(req, scope, 'upsert', outcomePayload.recommendationKey);
    res.json({ success: true, outcome, ...listed });
  } catch (error) {
    const status = classifyOutcomeRouteErrorStatus(error);
    res.status(status).json({ error: error.message || 'Failed to save recommendation outcome' });
  }
});

/**
 * DELETE /api/projects/:projectId/changesets/:changesetId/review/outcomes
 * Remove one persisted recommendation outcome for a changeset review scope.
 */
router.delete('/projects/:projectId/changesets/:changesetId/review/outcomes', resolveProject, async (req, res) => {
  try {
    const { projectId, changesetId } = req.params;
    const context = await resolveChangesetOutcomeContext(req.projectPath, changesetId);
    const scope = {
      projectId,
      projectPath: req.projectPath,
      reviewType: context.reviewType,
      reviewId: context.reviewId,
    };
    const deletedOutcome = await reviewOutcomeService.deleteOutcome(
      scope,
      req.body || {}
    );
    await queueOutcomeSyncEvent(req, scope, {
      type: 'cleared',
      recommendationKey: deletedOutcome?.recommendationKey || req.body?.recommendationKey,
      occurredAt: new Date().toISOString(),
    });
    await syncOutcomeAnalyticsScope(scope);
    const listed = await reviewOutcomeService.listOutcomes(
      scope,
      {
        reviewRecommendations: context.reviewRecommendations,
      }
    );
    emitReviewOutcomesUpdated(req, scope, 'delete', req.body?.recommendationKey);
    res.json({ success: true, deletedOutcome, ...listed });
  } catch (error) {
    const status = classifyOutcomeRouteErrorStatus(error);
    res.status(status).json({ error: error.message || 'Failed to clear recommendation outcome' });
  }
});

/**
 * GET /api/projects/:projectId/branch-reviews/:branchReviewId/review/outcomes
 * List persisted recommendation outcomes for a branch-review scope.
 */
router.get('/projects/:projectId/branch-reviews/:branchReviewId/review/outcomes', resolveProject, async (req, res) => {
  try {
    const { projectId, branchReviewId } = req.params;
    const context = await resolveBranchReviewOutcomeContext(projectId, branchReviewId);
    const listed = await reviewOutcomeService.listOutcomes(
      {
        projectId,
        reviewType: context.reviewType,
        reviewId: context.reviewId,
      },
      {
        reviewRecommendations: context.reviewRecommendations,
      }
    );
    res.json({ success: true, ...listed });
  } catch (error) {
    const status = classifyOutcomeRouteErrorStatus(error);
    res.status(status).json({ error: error.message || 'Failed to list recommendation outcomes' });
  }
});

/**
 * PUT /api/projects/:projectId/branch-reviews/:branchReviewId/review/outcomes
 * Upsert one recommendation outcome for a branch-review scope.
 */
router.put('/projects/:projectId/branch-reviews/:branchReviewId/review/outcomes', resolveProject, async (req, res) => {
  try {
    const { projectId, branchReviewId } = req.params;
    const context = await resolveBranchReviewOutcomeContext(projectId, branchReviewId);
    const scope = {
      projectId,
      reviewType: context.reviewType,
      reviewId: context.reviewId,
    };
    const outcomePayload = buildOutcomePayloadWithDimensions(req.body || {}, context);
    const outcome = await reviewOutcomeService.upsertOutcome(scope, outcomePayload);
    await queueOutcomeSyncEvent(req, scope, {
      type: 'outcome',
      recommendationKey: outcome?.recommendationKey || outcomePayload.recommendationKey,
      occurredAt: outcome?.updatedAt || new Date().toISOString(),
      status: outcome?.status || outcomePayload.status,
      note: outcome?.note || outcomePayload.note || null,
      dimensions: outcome?.dimensions || outcomePayload.dimensions || {},
    });
    await syncOutcomeAnalyticsScope(scope);
    const listed = await reviewOutcomeService.listOutcomes(
      scope,
      {
        reviewRecommendations: context.reviewRecommendations,
      }
    );
    emitReviewOutcomesUpdated(req, scope, 'upsert', outcomePayload.recommendationKey);
    res.json({ success: true, outcome, ...listed });
  } catch (error) {
    const status = classifyOutcomeRouteErrorStatus(error);
    res.status(status).json({ error: error.message || 'Failed to save recommendation outcome' });
  }
});

/**
 * DELETE /api/projects/:projectId/branch-reviews/:branchReviewId/review/outcomes
 * Remove one persisted recommendation outcome for a branch-review scope.
 */
router.delete('/projects/:projectId/branch-reviews/:branchReviewId/review/outcomes', resolveProject, async (req, res) => {
  try {
    const { projectId, branchReviewId } = req.params;
    const context = await resolveBranchReviewOutcomeContext(projectId, branchReviewId);
    const scope = {
      projectId,
      reviewType: context.reviewType,
      reviewId: context.reviewId,
    };
    const deletedOutcome = await reviewOutcomeService.deleteOutcome(
      scope,
      req.body || {}
    );
    await queueOutcomeSyncEvent(req, scope, {
      type: 'cleared',
      recommendationKey: deletedOutcome?.recommendationKey || req.body?.recommendationKey,
      occurredAt: new Date().toISOString(),
    });
    await syncOutcomeAnalyticsScope(scope);
    const listed = await reviewOutcomeService.listOutcomes(
      scope,
      {
        reviewRecommendations: context.reviewRecommendations,
      }
    );
    emitReviewOutcomesUpdated(req, scope, 'delete', req.body?.recommendationKey);
    res.json({ success: true, deletedOutcome, ...listed });
  } catch (error) {
    const status = classifyOutcomeRouteErrorStatus(error);
    res.status(status).json({ error: error.message || 'Failed to clear recommendation outcome' });
  }
});

/**
 * GET /api/projects/:projectId/workspace-reviews/:workspaceReviewId/review/outcomes
 * List persisted recommendation outcomes for a workspace-review scope.
 */
router.get('/projects/:projectId/workspace-reviews/:workspaceReviewId/review/outcomes', resolveProject, async (req, res) => {
  try {
    const { projectId, workspaceReviewId } = req.params;
    const context = await resolveWorkspaceReviewOutcomeContext(req.projectPath, projectId, workspaceReviewId);
    const listed = await reviewOutcomeService.listOutcomes(
      {
        projectId,
        reviewType: context.reviewType,
        reviewId: context.reviewId,
      },
      {
        reviewRecommendations: context.reviewRecommendations,
      }
    );
    res.json({ success: true, ...listed });
  } catch (error) {
    const status = classifyOutcomeRouteErrorStatus(error);
    res.status(status).json({ error: error.message || 'Failed to list recommendation outcomes' });
  }
});

/**
 * PUT /api/projects/:projectId/workspace-reviews/:workspaceReviewId/review/outcomes
 * Upsert one recommendation outcome for a workspace-review scope.
 */
router.put('/projects/:projectId/workspace-reviews/:workspaceReviewId/review/outcomes', resolveProject, async (req, res) => {
  try {
    const { projectId, workspaceReviewId } = req.params;
    const context = await resolveWorkspaceReviewOutcomeContext(req.projectPath, projectId, workspaceReviewId);
    const scope = {
      projectId,
      reviewType: context.reviewType,
      reviewId: context.reviewId,
    };
    const outcomePayload = buildOutcomePayloadWithDimensions(req.body || {}, context);
    const outcome = await reviewOutcomeService.upsertOutcome(scope, outcomePayload);
    await queueOutcomeSyncEvent(req, scope, {
      type: 'outcome',
      recommendationKey: outcome?.recommendationKey || outcomePayload.recommendationKey,
      occurredAt: outcome?.updatedAt || new Date().toISOString(),
      status: outcome?.status || outcomePayload.status,
      note: outcome?.note || outcomePayload.note || null,
      dimensions: outcome?.dimensions || outcomePayload.dimensions || {},
    });
    await syncOutcomeAnalyticsScope(scope);
    const listed = await reviewOutcomeService.listOutcomes(
      scope,
      {
        reviewRecommendations: context.reviewRecommendations,
      }
    );
    emitReviewOutcomesUpdated(req, scope, 'upsert', outcomePayload.recommendationKey);
    res.json({ success: true, outcome, ...listed });
  } catch (error) {
    const status = classifyOutcomeRouteErrorStatus(error);
    res.status(status).json({ error: error.message || 'Failed to save recommendation outcome' });
  }
});

/**
 * DELETE /api/projects/:projectId/workspace-reviews/:workspaceReviewId/review/outcomes
 * Remove one persisted recommendation outcome for a workspace-review scope.
 */
router.delete('/projects/:projectId/workspace-reviews/:workspaceReviewId/review/outcomes', resolveProject, async (req, res) => {
  try {
    const { projectId, workspaceReviewId } = req.params;
    const context = await resolveWorkspaceReviewOutcomeContext(req.projectPath, projectId, workspaceReviewId);
    const scope = {
      projectId,
      reviewType: context.reviewType,
      reviewId: context.reviewId,
    };
    const deletedOutcome = await reviewOutcomeService.deleteOutcome(
      scope,
      req.body || {}
    );
    await queueOutcomeSyncEvent(req, scope, {
      type: 'cleared',
      recommendationKey: deletedOutcome?.recommendationKey || req.body?.recommendationKey,
      occurredAt: new Date().toISOString(),
    });
    await syncOutcomeAnalyticsScope(scope);
    const listed = await reviewOutcomeService.listOutcomes(
      scope,
      {
        reviewRecommendations: context.reviewRecommendations,
      }
    );
    emitReviewOutcomesUpdated(req, scope, 'delete', req.body?.recommendationKey);
    res.json({ success: true, deletedOutcome, ...listed });
  } catch (error) {
    const status = classifyOutcomeRouteErrorStatus(error);
    res.status(status).json({ error: error.message || 'Failed to clear recommendation outcome' });
  }
});

/**
 * GET /api/projects/:projectId/pr-reviews/:prReviewId/review/outcomes
 * List persisted recommendation outcomes for a PR-review scope.
 */
router.get('/projects/:projectId/pr-reviews/:prReviewId/review/outcomes', resolveProject, async (req, res) => {
  try {
    const { projectId, prReviewId } = req.params;
    const context = await resolvePrReviewOutcomeContext(projectId, prReviewId);
    const listed = await reviewOutcomeService.listOutcomes(
      {
        projectId,
        reviewType: context.reviewType,
        reviewId: context.reviewId,
      },
      {
        reviewRecommendations: context.reviewRecommendations,
      }
    );
    res.json({ success: true, ...listed });
  } catch (error) {
    const status = classifyOutcomeRouteErrorStatus(error);
    res.status(status).json({ error: error.message || 'Failed to list recommendation outcomes' });
  }
});

/**
 * PUT /api/projects/:projectId/pr-reviews/:prReviewId/review/outcomes
 * Upsert one recommendation outcome for a PR-review scope.
 */
router.put('/projects/:projectId/pr-reviews/:prReviewId/review/outcomes', resolveProject, async (req, res) => {
  try {
    const { projectId, prReviewId } = req.params;
    const context = await resolvePrReviewOutcomeContext(projectId, prReviewId);
    const scope = {
      projectId,
      reviewType: context.reviewType,
      reviewId: context.reviewId,
    };
    const outcomePayload = buildOutcomePayloadWithDimensions(req.body || {}, context);
    const outcome = await reviewOutcomeService.upsertOutcome(scope, outcomePayload);
    await queueOutcomeSyncEvent(req, scope, {
      type: 'outcome',
      recommendationKey: outcome?.recommendationKey || outcomePayload.recommendationKey,
      occurredAt: outcome?.updatedAt || new Date().toISOString(),
      status: outcome?.status || outcomePayload.status,
      note: outcome?.note || outcomePayload.note || null,
      dimensions: outcome?.dimensions || outcomePayload.dimensions || {},
    });
    await syncOutcomeAnalyticsScope(scope);
    const listed = await reviewOutcomeService.listOutcomes(
      scope,
      {
        reviewRecommendations: context.reviewRecommendations,
      }
    );
    emitReviewOutcomesUpdated(req, scope, 'upsert', outcomePayload.recommendationKey);
    res.json({ success: true, outcome, ...listed });
  } catch (error) {
    const status = classifyOutcomeRouteErrorStatus(error);
    res.status(status).json({ error: error.message || 'Failed to save recommendation outcome' });
  }
});

/**
 * DELETE /api/projects/:projectId/pr-reviews/:prReviewId/review/outcomes
 * Remove one persisted recommendation outcome for a PR-review scope.
 */
router.delete('/projects/:projectId/pr-reviews/:prReviewId/review/outcomes', resolveProject, async (req, res) => {
  try {
    const { projectId, prReviewId } = req.params;
    const context = await resolvePrReviewOutcomeContext(projectId, prReviewId);
    const scope = {
      projectId,
      reviewType: context.reviewType,
      reviewId: context.reviewId,
    };
    const deletedOutcome = await reviewOutcomeService.deleteOutcome(
      scope,
      req.body || {}
    );
    await queueOutcomeSyncEvent(req, scope, {
      type: 'cleared',
      recommendationKey: deletedOutcome?.recommendationKey || req.body?.recommendationKey,
      occurredAt: new Date().toISOString(),
    });
    await syncOutcomeAnalyticsScope(scope);
    const listed = await reviewOutcomeService.listOutcomes(
      scope,
      {
        reviewRecommendations: context.reviewRecommendations,
      }
    );
    emitReviewOutcomesUpdated(req, scope, 'delete', req.body?.recommendationKey);
    res.json({ success: true, deletedOutcome, ...listed });
  } catch (error) {
    const status = classifyOutcomeRouteErrorStatus(error);
    res.status(status).json({ error: error.message || 'Failed to clear recommendation outcome' });
  }
});

router.get('/projects/:projectId/changesets/:changesetId/review/fix-runs', resolveProject, async (req, res) => {
  try {
    const { projectId, changesetId } = req.params;
    const context = await resolveChangesetOutcomeContext(req.projectPath, changesetId);
    await respondWithScopedFixRuns(res, {
      projectId,
      reviewType: context.reviewType,
      reviewId: context.reviewId,
    }, req.query?.limit);
  } catch (error) {
    const status = classifyOutcomeRouteErrorStatus(error);
    res.status(status).json({ error: error.message || 'Failed to list review fix runs' });
  }
});

router.get('/projects/:projectId/changesets/:changesetId/review/fix-runs/latest', resolveProject, async (req, res) => {
  try {
    const { projectId, changesetId } = req.params;
    const context = await resolveChangesetOutcomeContext(req.projectPath, changesetId);
    await respondWithLatestScopedFixRun(res, {
      projectId,
      reviewType: context.reviewType,
      reviewId: context.reviewId,
    });
  } catch (error) {
    const status = classifyOutcomeRouteErrorStatus(error);
    res.status(status).json({ error: error.message || 'Failed to load latest review fix run' });
  }
});

router.get('/projects/:projectId/branch-reviews/:branchReviewId/review/fix-runs', resolveProject, async (req, res) => {
  try {
    const { projectId, branchReviewId } = req.params;
    const context = await resolveBranchReviewOutcomeContext(projectId, branchReviewId);
    await respondWithScopedFixRuns(res, {
      projectId,
      reviewType: context.reviewType,
      reviewId: context.reviewId,
    }, req.query?.limit);
  } catch (error) {
    const status = classifyOutcomeRouteErrorStatus(error);
    res.status(status).json({ error: error.message || 'Failed to list review fix runs' });
  }
});

router.get('/projects/:projectId/branch-reviews/:branchReviewId/review/fix-runs/latest', resolveProject, async (req, res) => {
  try {
    const { projectId, branchReviewId } = req.params;
    const context = await resolveBranchReviewOutcomeContext(projectId, branchReviewId);
    await respondWithLatestScopedFixRun(res, {
      projectId,
      reviewType: context.reviewType,
      reviewId: context.reviewId,
    });
  } catch (error) {
    const status = classifyOutcomeRouteErrorStatus(error);
    res.status(status).json({ error: error.message || 'Failed to load latest review fix run' });
  }
});

router.post('/projects/:projectId/branch-reviews/:branchReviewId/review/fix-runs/:runId/verification-snapshot', resolveProject, async (req, res) => {
  try {
    const { projectId, branchReviewId, runId } = req.params;
    const branchReview = await branchReviewService.getById(branchReviewId);
    if (!branchReview || branchReview.projectId !== projectId) {
      return res.status(404).json({ error: 'Branch review not found' });
    }

    const run = await reviewFixRunStore.getRunById(runId);
    if (!run) {
      return res.status(404).json({ error: 'Review fix run not found' });
    }
    if (run.projectId !== projectId || run.reviewType !== 'branch_review' || run.reviewId !== branchReviewId) {
      return res.status(400).json({ error: 'Review fix run does not belong to this branch review' });
    }

    const snapshotEligibleStatuses = new Set(['patch_applied', 'verification_pending']);
    if (!snapshotEligibleStatuses.has(run.status)) {
      return res.status(400).json({ error: `Fix run status '${run.status}' is not eligible for verification snapshot` });
    }

    const targetFilePaths = buildVerificationSnapshotTargetFiles(run)
      .filter((p) => !p.split('/').includes('..') && !path.isAbsolute(p))
      .filter((p) => {
        const resolved = path.resolve(req.projectPath, p);
        const projectRoot = path.resolve(req.projectPath);
        const relative = path.relative(projectRoot, resolved);
        return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
      });
    if (targetFilePaths.length === 0) {
      return res.status(400).json({ error: 'Fix run has no valid file paths to commit for verification' });
    }

    const status = await gitService.getStatus(req.projectPath);
    const changedPathSet = buildChangedRepositoryPathSet(status);
    const filesCommitted = targetFilePaths.filter((filePath) => changedPathSet.has(normalizeRepositoryPathValue(filePath)));
    const commitMessage = typeof req.body?.message === 'string' && req.body.message.trim()
      ? req.body.message.trim()
      : 'chore(review): verification snapshot for issue fixer';

    if (filesCommitted.length === 0) {
      const currentHeadSha = await gitService.getCurrentSHA(req.projectPath);
      if (!currentHeadSha) {
        return res.status(400).json({ error: 'No verification snapshot commit available for this branch yet' });
      }
      return res.json({
        success: true,
        alreadyCommitted: true,
        commitCreated: false,
        commitSha: currentHeadSha,
        filesCommitted: [],
        targetFilePaths,
        commitMessage,
      });
    }

    const result = await gitService.commitChanges(req.projectPath, commitMessage, filesCommitted);
    if (!result?.commit) {
      return res.status(400).json({ error: 'Verification snapshot commit returned no SHA' });
    }

    return res.json({
      success: true,
      alreadyCommitted: false,
      commitCreated: true,
      commitSha: result.commit,
      branch: result.branch,
      filesCommitted,
      targetFilePaths,
      commitMessage,
    });
  } catch (error) {
    return res.status(500).json({ error: error.message || 'Failed to create verification snapshot commit' });
  }
});

router.get('/projects/:projectId/workspace-reviews/:workspaceReviewId/review/fix-runs', resolveProject, async (req, res) => {
  try {
    const { projectId, workspaceReviewId } = req.params;
    const context = await resolveWorkspaceReviewOutcomeContext(req.projectPath, projectId, workspaceReviewId);
    await respondWithScopedFixRuns(res, {
      projectId,
      reviewType: context.reviewType,
      reviewId: context.reviewId,
    }, req.query?.limit);
  } catch (error) {
    const status = classifyOutcomeRouteErrorStatus(error);
    res.status(status).json({ error: error.message || 'Failed to list review fix runs' });
  }
});

router.get('/projects/:projectId/workspace-reviews/:workspaceReviewId/review/fix-runs/latest', resolveProject, async (req, res) => {
  try {
    const { projectId, workspaceReviewId } = req.params;
    const context = await resolveWorkspaceReviewOutcomeContext(req.projectPath, projectId, workspaceReviewId);
    await respondWithLatestScopedFixRun(res, {
      projectId,
      reviewType: context.reviewType,
      reviewId: context.reviewId,
    });
  } catch (error) {
    const status = classifyOutcomeRouteErrorStatus(error);
    res.status(status).json({ error: error.message || 'Failed to load latest review fix run' });
  }
});

router.get('/projects/:projectId/pr-reviews/:prReviewId/review/fix-runs', resolveProject, async (req, res) => {
  try {
    const { projectId, prReviewId } = req.params;
    const context = await resolvePrReviewOutcomeContext(projectId, prReviewId);
    await respondWithScopedFixRuns(res, {
      projectId,
      reviewType: context.reviewType,
      reviewId: context.reviewId,
    }, req.query?.limit);
  } catch (error) {
    const status = classifyOutcomeRouteErrorStatus(error);
    res.status(status).json({ error: error.message || 'Failed to list review fix runs' });
  }
});

router.get('/projects/:projectId/pr-reviews/:prReviewId/review/fix-runs/latest', resolveProject, async (req, res) => {
  try {
    const { projectId, prReviewId } = req.params;
    const context = await resolvePrReviewOutcomeContext(projectId, prReviewId);
    await respondWithLatestScopedFixRun(res, {
      projectId,
      reviewType: context.reviewType,
      reviewId: context.reviewId,
    });
  } catch (error) {
    const status = classifyOutcomeRouteErrorStatus(error);
    res.status(status).json({ error: error.message || 'Failed to load latest review fix run' });
  }
});

/**
 * GET /api/review-queue
 * Get current review queue status
 */
router.get('/review-queue', async (req, res) => {
  try {
    const queue = reviewService.getQueueStatus();
    res.json({ success: true, queue });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * DELETE /api/review-queue/:entryId
 * Cancel a specific queued review entry without stopping an active run.
 */
router.delete('/review-queue/:entryId', async (req, res) => {
  try {
    const { entryId } = req.params;
    const entry = reviewService.getQueueEntryStatus?.(entryId);
    if (!entry) {
      return res.json({ success: true, stopped: false, was: null });
    }
    const effectiveUserId = req.user?.id || ANONYMOUS_USER_ID;
    if (!entry.projectId && effectiveUserId !== ANONYMOUS_USER_ID) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (entry.projectId) {
      const project = await getProjectById(entry.projectId);
      if (!project) return res.status(404).json({ error: 'Project not found' });
      if (project.user_id !== effectiveUserId) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }
    if (entry.status !== 'queued') {
      return res.status(409).json({ error: 'Only queued review entries can be cancelled directly.' });
    }
    const result = await reviewService.cancelQueuedReviewEntry(entryId);
    await suppressQueuedBranchAutoReviewAfterCancel(entry, result);
    res.json({ success: true, ...result });
  } catch (error) {
    res.status(500).json({ error: error.message || 'Failed to cancel queued review' });
  }
});

/**
 * GET /api/review-harness/fixtures
 * List available quality harness fixtures
 */
router.get('/review-harness/fixtures', async (req, res) => {
  try {
    const fixtures = reviewQualityHarness.listFixtures({
      fixtureSet: req.query?.fixtureSet,
      surface: req.query?.surface,
    });
    res.json({ success: true, fixtures });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/review-harness/run
 * Run the quality harness against all or selected fixtures.
 * Body: { fixtureIds?: string[], fixtureSet?: string, surface?: string, dryRun?: boolean, qualityMode?: 'auto' | 'v1' | 'v2' }
 */
router.post('/review-harness/run', async (req, res) => {
  try {
    const { fixtureIds, fixtureSet, surface, dryRun, qualityMode } = req.body;
    if (!enforceHarnessAccess(req, res, { dryRun: !!dryRun })) return;
    const results = await reviewQualityHarness.runHarness({ fixtureIds, fixtureSet, surface, dryRun, qualityMode });
    res.json({ success: true, ...results });
  } catch (error) {
    console.error('Quality harness error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/review-harness/compare
 * Compare baseline quality mode (v1) vs improved mode (v2).
 * Body: { fixtureIds?: string[], fixtureSet?: string, surface?: string, dryRun?: boolean }
 */
router.post('/review-harness/compare', async (req, res) => {
  try {
    const {
      fixtureIds,
      fixtureSet,
      surface,
      dryRun,
      gateThresholds,
      adaptiveConfig,
      tuningTargets,
    } = req.body || {};
    if (!enforceHarnessAccess(req, res, { dryRun: !!dryRun })) return;
    const comparison = await reviewQualityHarness.compareQualityModes({
      fixtureIds,
      fixtureSet,
      surface,
      dryRun,
      gateThresholds,
      adaptiveConfig,
      tuningTargets,
    });
    res.json({ success: true, ...comparison });
  } catch (error) {
    console.error('Quality harness comparison error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/review-harness/compare-variants
 * Compare a control configuration vs a candidate configuration on one fixture set.
 */
router.post('/review-harness/compare-variants', async (req, res) => {
  try {
    const {
      fixtureIds,
      fixtureSet,
      surface,
      dryRun,
      gateThresholds,
      adaptiveConfig,
      tuningTargets,
      baseline,
      candidate,
    } = req.body || {};
    if (!enforceHarnessAccess(req, res, { dryRun: !!dryRun })) return;
    const comparison = await reviewQualityHarness.compareBenchmarkVariants({
      fixtureIds,
      fixtureSet,
      surface,
      dryRun,
      gateThresholds,
      adaptiveConfig,
      tuningTargets,
      baseline,
      candidate,
    });
    res.json({ success: true, ...comparison });
  } catch (error) {
    console.error('Quality harness variant comparison error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

export const __testing = {
  classifyOutcomeRouteErrorStatus,
  normalizePrecisionIssueCounters,
};

export default router;
