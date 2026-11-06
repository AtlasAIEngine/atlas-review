/**
 * PR Review Routes
 * API endpoints for listing, syncing, and managing GitHub pull request reviews.
 */

import express from 'express';
import { getProjectById } from '../db/queries.js';
import db from '../db/connection.js';
import prReviewService from '../services/prReviewService.js';
import githubService from '../services/githubService.js';
import reviewService from '../services/reviewService.js';
import reviewFixRunStore from '../services/review/reviewFixRunStore.js';
import prReviewPublishService from '../services/prReviewPublishService.js';
import prReviewSyncService, { resolveGitHubMeta } from '../services/prReviewSyncService.js';
import prReviewConversationService from '../services/prReviewConversationService.js';
import reviewSyncService from '../services/reviewSyncService.js';
import { enforceQuotas } from '../middleware/quotas.js';
import { buildReviewActionEligibility, buildReviewLifecycle } from '../utils/reviewLifecycle.js';
import { selectVisibleReviewFiles, summarizeVisibleReviewFiles, resolveVisibleReviewFileLimit } from '../utils/reviewFileSelection.js';

const router = express.Router();

const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';
const REVIEW_DECISION_PUBLICATION_KEY = '__review_decision__';
const FILE_CONTENT_HYDRATE_CONCURRENCY = Math.min(
  12,
  Math.max(1, Number(process.env.ATLAS_PR_REVIEW_FILE_CONTENT_CONCURRENCY || 6))
);
const PR_FILE_MANIFEST_CACHE_TTL_MS = Math.max(
  60_000,
  Number(process.env.ATLAS_PR_FILE_MANIFEST_CACHE_TTL_MS || 30 * 60 * 1000)
);

const prFileManifestCache = new Map();
const prFileManifestInFlight = new Map();

function normalizePullRequestFiles(files = []) {
  return Array.isArray(files)
    ? files.map((f) => ({
      path: f.filename,
      status: f.status === 'removed' ? 'D' : f.status === 'added' ? 'A' : f.status === 'renamed' ? 'R' : 'M',
      additions: f.additions || 0,
      deletions: f.deletions || 0,
      oldPath: f.previous_filename || null,
      patch: typeof f.patch === 'string' ? f.patch : null,
    }))
    : [];
}

function buildPrFileManifestCacheKey(projectId, prReview) {
  const reviewId = String(prReview?.id || '').trim();
  const headSha = String(prReview?.headSha || '').trim();
  if (!projectId || !reviewId || !headSha) return null;
  return `${projectId}:${reviewId}:${headSha}`;
}

function prunePrFileManifestCache() {
  const now = Date.now();
  for (const [key, entry] of prFileManifestCache.entries()) {
    if (!entry || entry.expiresAt <= now) {
      prFileManifestCache.delete(key);
    }
  }
}

function invalidatePrFileManifestCache(projectId, prId = null) {
  if (!projectId) {
    prFileManifestCache.clear();
    prFileManifestInFlight.clear();
    return;
  }

  const projectPrefix = `${projectId}:`;
  for (const key of [...prFileManifestCache.keys()]) {
    if (!key.startsWith(projectPrefix)) continue;
    if (prId && !key.startsWith(`${projectId}:${prId}:`)) continue;
    prFileManifestCache.delete(key);
  }
  for (const key of [...prFileManifestInFlight.keys()]) {
    if (!key.startsWith(projectPrefix)) continue;
    if (prId && !key.startsWith(`${projectId}:${prId}:`)) continue;
    prFileManifestInFlight.delete(key);
  }
}

async function getPullRequestFileManifest(project, prReview, userId) {
  const cacheKey = buildPrFileManifestCacheKey(project?.id, prReview);
  prunePrFileManifestCache();
  if (cacheKey) {
    const cached = prFileManifestCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.files;
    }
    if (prFileManifestInFlight.has(cacheKey)) {
      return prFileManifestInFlight.get(cacheKey);
    }
  }

  const request = (async () => {
    const gh = await resolveGitHubMeta(project, userId || project?.user_id || ANONYMOUS_USER_ID);
    if (!gh) return [];
    const ghFiles = await githubService.getPullRequestFiles(
      gh.installationId,
      gh.owner,
      gh.repo,
      prReview.githubPrNumber
    );
    const files = normalizePullRequestFiles(ghFiles);
    if (cacheKey) {
      prunePrFileManifestCache();
      prFileManifestCache.set(cacheKey, {
        files,
        expiresAt: Date.now() + PR_FILE_MANIFEST_CACHE_TTL_MS,
      });
    }
    return files;
  })().finally(() => {
    if (cacheKey) {
      prFileManifestInFlight.delete(cacheKey);
    }
  });

  if (cacheKey) {
    prFileManifestInFlight.set(cacheKey, request);
  }

  return request;
}

function getBearerToken(req) {
  const authHeader = typeof req.get === 'function'
    ? req.get('authorization')
    : req.headers?.authorization;
  const value = String(authHeader || '').trim();
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : '';
}

async function getEffectiveUserId(req) {
  const jwtUserId = req.user?.id || null;
  if (jwtUserId && jwtUserId !== ANONYMOUS_USER_ID) {
    return jwtUserId;
  }

  const token = getBearerToken(req);
  if (token) {
    try {
      const session = await reviewSyncService.getGuestSessionByAuthToken(token);
      if (session?.userId) {
        return session.userId;
      }
    } catch (error) {
      console.error('[prReviews] review-sync session lookup failed:', error);
      const sentinel = new Error('Unable to verify review session. Try again.');
      sentinel.code = 'REVIEW_SYNC_LOOKUP_FAILED';
      sentinel.statusCode = 503;
      throw sentinel;
    }
  }

  return req.user?.id || ANONYMOUS_USER_ID;
}

async function getEffectiveProjectUserId(req, project) {
  const effectiveUserId = await getEffectiveUserId(req);
  if (effectiveUserId && effectiveUserId !== ANONYMOUS_USER_ID) {
    return effectiveUserId;
  }
  return project?.user_id || effectiveUserId || ANONYMOUS_USER_ID;
}

async function checkOwnership(project, req) {
  const jwtUserId = req.user?.id || null;
  if (project.user_id === ANONYMOUS_USER_ID && (!jwtUserId || jwtUserId === ANONYMOUS_USER_ID)) {
    return true;
  }
  const effectiveUserId = await getEffectiveUserId(req);
  return project.user_id === effectiveUserId;
}

function isPrReviewResetAllowed() {
  if (process.env.ATLAS_ALLOW_PR_REVIEW_RESET === 'true') return true;
  if (process.env.ATLAS_DESKTOP_MODE === 'true') return true;
  return process.env.NODE_ENV !== 'production';
}

async function getViewerGitHubLogins(req) {
  const effectiveUserId = await getEffectiveUserId(req);
  const result = await db.query(
    'SELECT account_login FROM github_integrations WHERE user_id = $1 AND is_active = TRUE',
    [effectiveUserId]
  );
  return new Set(
    (result.rows || [])
      .map((row) => String(row?.account_login || '').trim().toLowerCase())
      .filter(Boolean)
  );
}

function attachReviewLifecycle(review, viewerGitHubLogins = null) {
  if (!review || typeof review !== 'object') return review;
  const reviewStatus = review.reviewStatus ?? review.review_status ?? 'none';
  const reviewError = review.reviewError ?? review.review_error ?? null;
  const reviewedAt = review.reviewedAt ?? review.reviewed_at ?? null;
  const updatedAt = review.updatedAt ?? review.updated_at ?? null;
  const reviewCommentEligibility = review.reviewJson?.stats?.commentEligibility
    && typeof review.reviewJson.stats.commentEligibility === 'object'
    ? review.reviewJson.stats.commentEligibility
    : null;
  const reviewParityGate = prReviewService.buildReviewParityGate(review);
  const reviewLifecycle = buildReviewLifecycle({
    reviewStatus,
    sourceStatus: reviewStatus,
    errorMessage: reviewError,
    reviewedAt,
    updatedAt,
  });
  const reviewActionEligibility = buildReviewActionEligibility(review, reviewLifecycle);
  const authorLogin = String(review.authorLogin ?? review.author_login ?? '').trim().toLowerCase();
  const isSelfAuthoredPr = Boolean(
    authorLogin
    && viewerGitHubLogins instanceof Set
    && viewerGitHubLogins.has(authorLogin)
  );
  return {
    ...review,
    isSelfAuthored: isSelfAuthoredPr,
    reviewLifecycle,
    reviewActionEligibility: isSelfAuthoredPr
      ? {
          ...reviewActionEligibility,
          canApprove: false,
          canRequestChanges: false,
          approveBlockedReason: 'GitHub does not allow approving your own pull request.',
          requestChangesBlockedReason: 'GitHub does not allow requesting changes on your own pull request.',
        }
      : reviewActionEligibility,
    reviewCommentEligibility,
    reviewParityGate,
  };
}

async function attachPublicationSummary(projectId, reviews = []) {
  if (!projectId || !Array.isArray(reviews) || reviews.length === 0) {
    return Array.isArray(reviews) ? reviews : [];
  }

  const reviewIds = Array.from(new Set(
    reviews
      .map((review) => String(review?.id || '').trim())
      .filter(Boolean)
  ));
  if (reviewIds.length === 0) return reviews;

  const placeholders = reviewIds.map((_, index) => `$${index + 2}`).join(', ');
  const result = await db.query(
    `SELECT review_id, action, head_sha, published_at, updated_at
       FROM review_publications
      WHERE project_id = $1
        AND review_type = 'pr_review'
        AND channel = 'github_pr_review'
        AND review_id IN (${placeholders})
      ORDER BY review_id ASC, updated_at DESC, published_at DESC,
        CASE WHEN recommendation_key = '${REVIEW_DECISION_PUBLICATION_KEY}' THEN 0 ELSE 1 END`,
    [projectId, ...reviewIds]
  );

  const latestByReviewId = new Map();
  for (const row of result.rows || []) {
    const reviewId = String(row?.review_id || '').trim();
    if (!reviewId) continue;
    const existing = latestByReviewId.get(reviewId) || {
      latestPublicationAction: null,
      latestPublicationHeadSha: null,
      latestPublicationAt: null,
      latestApprovedPublicationHeadSha: null,
      latestApprovedPublicationAt: null,
    };
    if (!existing.latestPublicationAction) {
      existing.latestPublicationAction = row?.action ?? null;
      existing.latestPublicationHeadSha = row?.head_sha ?? null;
      existing.latestPublicationAt = row?.published_at ?? row?.updated_at ?? null;
    }
    if (!existing.latestApprovedPublicationHeadSha && row?.action === 'approve') {
      existing.latestApprovedPublicationHeadSha = row?.head_sha ?? null;
      existing.latestApprovedPublicationAt = row?.published_at ?? row?.updated_at ?? null;
    }
    latestByReviewId.set(reviewId, existing);
  }

  return reviews.map((review) => ({
    ...review,
    ...(latestByReviewId.get(String(review?.id || '').trim()) || {
      latestPublicationAction: null,
      latestPublicationHeadSha: null,
      latestPublicationAt: null,
      latestApprovedPublicationHeadSha: null,
      latestApprovedPublicationAt: null,
    }),
  }));
}

function respondWithGitHubSyncError(res, error, fallbackMessage) {
  const upstreamMessage = normalizeGitHubUpstreamErrorMessage(error, fallbackMessage);
  if (error?.message === 'Project is not connected to GitHub') {
    return res.status(400).json({ error: error.message });
  }
  if (error?.status === 401 || error?.statusCode === 401 || error?.code === 'AUTH_EXPIRED') {
    return res.status(400).json({
      error: error?.message || 'GitHub credentials expired',
      code: 'AUTH_EXPIRED',
      message: error?.message || 'Your GitHub token has expired. Please reconnect your account.',
    });
  }
  if (error?.code === 'GITHUB_REPO_ACCESS_DENIED') {
    return res.status(error?.statusCode || 403).json({
      error: error.message,
      code: error.code,
      connectedLogin: error.connectedLogin || null,
      owner: error.owner || null,
      repo: error.repo || null,
    });
  }
  if (error?.code === 'REVIEW_SYNC_LOOKUP_FAILED') {
    return res.status(error?.statusCode || 503).json({
      error: error.message,
      code: error.code,
    });
  }
  return res.status(500).json({ error: upstreamMessage });
}

function normalizeGitHubUpstreamErrorMessage(error, fallbackMessage) {
  const candidates = [
    error?.response?.data,
    error?.message,
  ];
  const message = candidates
    .map((value) => {
      if (typeof value === 'string') return value.trim();
      if (value && typeof value === 'object') {
        return String(value.error || value.message || value.details || '').trim();
      }
      return '';
    })
    .find(Boolean);
  if (!message) return fallbackMessage;

  const lower = message.toLowerCase();
  if (
    lower.includes("we couldn't respond to your request in time")
    || lower.includes('we could not respond to your request in time')
  ) {
    return 'GitHub timed out while loading conversations. Try syncing again in a moment.';
  }
  if (
    lower.includes('<!doctype html')
    || /^<html(?:\s|>)/i.test(message.trimStart())
    || lower.includes('hello future githubber')
  ) {
    return 'GitHub returned a temporary HTML error page. Try syncing again in a moment.';
  }
  return message;
}

export { normalizeGitHubUpstreamErrorMessage };

/**
 * GET /api/projects/:projectId/pr-reviews
 * List all PR reviews for a project.
 */
router.get('/:projectId/pr-reviews', async (req, res) => {
  try {
    const { projectId } = req.params;
    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!(await checkOwnership(project, req))) return res.status(403).json({ error: 'Forbidden' });

    const prReviews = await attachPublicationSummary(projectId, await prReviewService.getByProject(projectId));
    const viewerGitHubLogins = await getViewerGitHubLogins(req);
    const enriched = prReviews.map((review) => attachReviewLifecycle(review, viewerGitHubLogins));

    res.json({
      success: true,
      prReviews: enriched,
      lastSyncedAt: project.last_pr_synced_at || null,
    });
  } catch (error) {
    console.error('Error listing PR reviews:', error);
    res.status(500).json({ error: error.message || 'Failed to list PR reviews' });
  }
});

/**
 * POST /api/projects/:projectId/pr-reviews/sync
 * Fetch/sync open PRs from GitHub and upsert into pr_reviews.
 */
router.post('/:projectId/pr-reviews/sync', async (req, res) => {
  try {
    const { projectId } = req.params;
    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!(await checkOwnership(project, req))) return res.status(403).json({ error: 'Forbidden' });
    const syncResult = await prReviewSyncService.syncProject(project, {
      userId: await getEffectiveProjectUserId(req, project),
      source: 'manual',
    });
    invalidatePrFileManifestCache(projectId);
    const prReviews = await attachPublicationSummary(projectId, syncResult.prReviews || []);
    const viewerGitHubLogins = await getViewerGitHubLogins(req);
    const enriched = prReviews.map((review) => attachReviewLifecycle(review, viewerGitHubLogins));
    res.json({
      success: true,
      prReviews: enriched,
      synced: syncResult.synced,
      lastSyncedAt: syncResult.completedAt || null,
      deltas: (syncResult.deltas || []).map((delta) => ({
        type: delta.type,
        githubPrNumber: delta.prReview?.githubPrNumber || null,
      })),
    });
  } catch (error) {
    console.error('Error syncing PR reviews:', error);
    respondWithGitHubSyncError(res, error, 'Failed to sync PRs from GitHub');
  }
});

/**
 * POST /api/projects/:projectId/pr-reviews/:prId/refresh
 * Refresh a single PR review row from GitHub before review or publication actions.
 */
router.post('/:projectId/pr-reviews/:prId/refresh', async (req, res) => {
  try {
    const { projectId, prId } = req.params;
    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!(await checkOwnership(project, req))) return res.status(403).json({ error: 'Forbidden' });

    const prReview = await prReviewService.getById(prId);
    if (!prReview || prReview.projectId !== projectId) {
      return res.status(404).json({ error: 'PR review not found' });
    }

    const { prReview: refreshed } = await prReviewSyncService.refreshPrReview(project, prReview, {
      userId: await getEffectiveProjectUserId(req, project),
      source: 'review_action',
    });
    invalidatePrFileManifestCache(projectId, prId);
    const viewerGitHubLogins = await getViewerGitHubLogins(req);
    const enriched = attachReviewLifecycle(refreshed, viewerGitHubLogins);
    const [withPublicationSummary] = await attachPublicationSummary(projectId, [enriched]);
    res.json({ success: true, prReview: withPublicationSummary || enriched });
  } catch (error) {
    console.error('Error refreshing PR review:', error);
    respondWithGitHubSyncError(res, error, 'Failed to refresh PR from GitHub');
  }
});

/**
 * GET /api/projects/:projectId/pr-reviews/:prId
 * Get a single PR review with file manifest from GitHub.
 */
router.get('/:projectId/pr-reviews/:prId', async (req, res) => {
  try {
    const { projectId, prId } = req.params;
    const includeAllFiles = String(req.query?.includeAllFiles || '').trim().toLowerCase() === 'true';
    const visibleFileLimit = resolveVisibleReviewFileLimit(req.query?.visibleFileLimit);
    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!(await checkOwnership(project, req))) return res.status(403).json({ error: 'Forbidden' });

    const prReview = await prReviewService.getById(prId);
    if (!prReview || prReview.projectId !== projectId) {
      return res.status(404).json({ error: 'PR review not found' });
    }

    const viewerGitHubLogins = await getViewerGitHubLogins(req);
    const enriched = attachReviewLifecycle(prReview, viewerGitHubLogins);
    const [withPublicationSummary] = await attachPublicationSummary(projectId, [enriched]);
    const enrichedPrReview = withPublicationSummary || enriched;

    let files = [];
    try {
      files = await getPullRequestFileManifest(
        project,
        prReview,
        await getEffectiveProjectUserId(req, project)
      );
    } catch (err) {
      console.warn(`Failed to fetch PR #${prReview.githubPrNumber} files:`, err.message);
    }

    const visibleFiles = includeAllFiles ? files : selectVisibleReviewFiles(files, prReview, visibleFileLimit);
    res.json({
      success: true,
      prReview: {
        ...enrichedPrReview,
        diffManifestSummary: summarizeVisibleReviewFiles(
          visibleFiles,
          Number(prReview.fileCount || files.length || 0),
          visibleFileLimit
        ),
      },
      files: visibleFiles,
    });
  } catch (error) {
    console.error('Error getting PR review:', error);
    res.status(500).json({ error: error.message || 'Failed to get PR review' });
  }
});

/**
 * GET /api/projects/:projectId/pr-reviews/:prId/github-review/publications
 * List persisted GitHub publication state for a PR review.
 */
router.get('/:projectId/pr-reviews/:prId/github-review/publications', async (req, res) => {
  try {
    const { projectId, prId } = req.params;
    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!(await checkOwnership(project, req))) return res.status(403).json({ error: 'Forbidden' });

    const prReview = await prReviewService.getById(prId);
    if (!prReview || prReview.projectId !== projectId) {
      return res.status(404).json({ error: 'PR review not found' });
    }

    const publication = await prReviewPublishService.listPublications({
      projectId,
      reviewType: 'pr_review',
      reviewId: prId,
    });

    res.json({ success: true, publication });
  } catch (error) {
    console.error('Error listing PR review publications:', error);
    res.status(500).json({ error: error.message || 'Failed to list PR review publications' });
  }
});

/**
 * GET /api/projects/:projectId/pr-reviews/:prId/conversations
 * Read persisted GitHub PR conversation state for a PR review.
 */
router.get('/:projectId/pr-reviews/:prId/conversations', async (req, res) => {
  try {
    const { projectId, prId } = req.params;
    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!(await checkOwnership(project, req))) return res.status(403).json({ error: 'Forbidden' });

    const prReview = await prReviewService.getById(prId);
    if (!prReview || prReview.projectId !== projectId) {
      return res.status(404).json({ error: 'PR review not found' });
    }

    const conversations = await prReviewConversationService.listConversations(projectId, prId, {
      userId: await getEffectiveProjectUserId(req, project),
    });
    res.json({ success: true, conversations });
  } catch (error) {
    console.error('Error loading PR conversations:', error);
    res.status(500).json({ error: error.message || 'Failed to load PR conversations' });
  }
});

/**
 * POST /api/projects/:projectId/pr-reviews/:prId/conversations/sync
 * Fetch GitHub PR review threads/comments and persist current state.
 */
router.post('/:projectId/pr-reviews/:prId/conversations/sync', async (req, res) => {
  try {
    const { projectId, prId } = req.params;
    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!(await checkOwnership(project, req))) return res.status(403).json({ error: 'Forbidden' });

    const prReview = await prReviewService.getById(prId);
    if (!prReview || prReview.projectId !== projectId) {
      return res.status(404).json({ error: 'PR review not found' });
    }

    const conversations = await prReviewConversationService.syncConversations({
      project,
      prReview,
      userId: await getEffectiveProjectUserId(req, project),
    });
    res.json({ success: true, conversations });
  } catch (error) {
    console.error('Error syncing PR conversations:', error);
    respondWithGitHubSyncError(res, error, 'Failed to sync PR conversations from GitHub');
  }
});

/**
 * POST /api/projects/:projectId/pr-reviews/:prId/conversations/threads/reply
 * Reply to an existing GitHub PR review thread, then resync persisted state.
 */
router.post('/:projectId/pr-reviews/:prId/conversations/threads/reply', async (req, res) => {
  try {
    const { projectId, prId } = req.params;
    const { threadNodeId, body } = req.body || {};
    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!(await checkOwnership(project, req))) return res.status(403).json({ error: 'Forbidden' });

    const prReview = await prReviewService.getById(prId);
    if (!prReview || prReview.projectId !== projectId) {
      return res.status(404).json({ error: 'PR review not found' });
    }

    const conversations = await prReviewConversationService.replyToThread({
      project,
      prReview,
      userId: await getEffectiveProjectUserId(req, project),
      threadNodeId,
      body,
    });
    res.json({ success: true, conversations });
  } catch (error) {
    console.error('Error replying to PR conversation:', error);
    if (error?.status === 404) {
      return res.status(404).json({ error: error.message || 'GitHub review thread not found' });
    }
    respondWithGitHubSyncError(res, error, 'Failed to reply to GitHub conversation');
  }
});

/**
 * POST /api/projects/:projectId/pr-reviews/:prId/conversations/threads
 * Create a new GitHub PR review thread on a diff line, then resync persisted state.
 */
router.post('/:projectId/pr-reviews/:prId/conversations/threads', async (req, res) => {
  try {
    const { projectId, prId } = req.params;
    const { path, line, side, body } = req.body || {};
    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!(await checkOwnership(project, req))) return res.status(403).json({ error: 'Forbidden' });

    const prReview = await prReviewService.getById(prId);
    if (!prReview || prReview.projectId !== projectId) {
      return res.status(404).json({ error: 'PR review not found' });
    }

    const conversations = await prReviewConversationService.createThreadComment({
      project,
      prReview,
      userId: await getEffectiveProjectUserId(req, project),
      path,
      line,
      side,
      body,
    });
    res.json({ success: true, conversations });
  } catch (error) {
    console.error('Error creating PR conversation:', error);
    respondWithGitHubSyncError(res, error, 'Failed to create GitHub conversation');
  }
});

/**
 * PATCH /api/projects/:projectId/pr-reviews/:prId/conversations/threads/resolution
 * Resolve or reopen an existing GitHub PR review thread, then resync state.
 */
router.patch('/:projectId/pr-reviews/:prId/conversations/threads/resolution', async (req, res) => {
  try {
    const { projectId, prId } = req.params;
    const { threadNodeId, resolved } = req.body || {};
    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!(await checkOwnership(project, req))) return res.status(403).json({ error: 'Forbidden' });

    const prReview = await prReviewService.getById(prId);
    if (!prReview || prReview.projectId !== projectId) {
      return res.status(404).json({ error: 'PR review not found' });
    }

    const conversations = await prReviewConversationService.setThreadResolved({
      project,
      prReview,
      userId: await getEffectiveProjectUserId(req, project),
      threadNodeId,
      resolved: resolved === true,
    });
    res.json({ success: true, conversations });
  } catch (error) {
    console.error('Error updating PR conversation resolution:', error);
    if (error?.status === 404) {
      return res.status(404).json({ error: error.message || 'GitHub review thread not found' });
    }
    respondWithGitHubSyncError(res, error, 'Failed to update GitHub conversation status');
  }
});

/**
 * PATCH /api/projects/:projectId/pr-reviews/:prId/conversations/comments
 * Edit an existing GitHub PR review reply comment, then resync state.
 */
router.patch('/:projectId/pr-reviews/:prId/conversations/comments', async (req, res) => {
  try {
    const { projectId, prId } = req.params;
    const { commentNodeId, body } = req.body || {};
    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!(await checkOwnership(project, req))) return res.status(403).json({ error: 'Forbidden' });

    const prReview = await prReviewService.getById(prId);
    if (!prReview || prReview.projectId !== projectId) {
      return res.status(404).json({ error: 'PR review not found' });
    }

    const conversations = await prReviewConversationService.updateThreadComment({
      project,
      prReview,
      userId: await getEffectiveProjectUserId(req, project),
      commentNodeId,
      body,
    });
    res.json({ success: true, conversations });
  } catch (error) {
    console.error('Error updating PR conversation comment:', error);
    if ([403, 404, 409].includes(Number(error?.status))) {
      return res.status(error.status).json({ error: error.message || 'GitHub review comment cannot be updated' });
    }
    respondWithGitHubSyncError(res, error, 'Failed to update GitHub conversation comment');
  }
});

/**
 * DELETE /api/projects/:projectId/pr-reviews/:prId/conversations/comments
 * Delete an existing GitHub PR review reply comment, then resync state.
 */
router.delete('/:projectId/pr-reviews/:prId/conversations/comments', async (req, res) => {
  try {
    const { projectId, prId } = req.params;
    const { commentNodeId } = req.body || {};
    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!(await checkOwnership(project, req))) return res.status(403).json({ error: 'Forbidden' });

    const prReview = await prReviewService.getById(prId);
    if (!prReview || prReview.projectId !== projectId) {
      return res.status(404).json({ error: 'PR review not found' });
    }

    const conversations = await prReviewConversationService.deleteThreadComment({
      project,
      prReview,
      userId: await getEffectiveProjectUserId(req, project),
      commentNodeId,
    });
    res.json({ success: true, conversations });
  } catch (error) {
    console.error('Error deleting PR conversation comment:', error);
    if ([403, 404, 409].includes(Number(error?.status))) {
      return res.status(error.status).json({ error: error.message || 'GitHub review comment cannot be deleted' });
    }
    respondWithGitHubSyncError(res, error, 'Failed to delete GitHub conversation comment');
  }
});

/**
 * POST /api/projects/:projectId/pr-reviews/:prId/conversations/issue-comments
 * Add a top-level PR conversation comment, then resync state.
 */
router.post('/:projectId/pr-reviews/:prId/conversations/issue-comments', async (req, res) => {
  try {
    const { projectId, prId } = req.params;
    const { body } = req.body || {};
    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!(await checkOwnership(project, req))) return res.status(403).json({ error: 'Forbidden' });

    const prReview = await prReviewService.getById(prId);
    if (!prReview || prReview.projectId !== projectId) {
      return res.status(404).json({ error: 'PR review not found' });
    }

    const conversations = await prReviewConversationService.addIssueComment({
      project,
      prReview,
      userId: await getEffectiveProjectUserId(req, project),
      body,
    });
    res.json({ success: true, conversations });
  } catch (error) {
    console.error('Error adding PR issue comment:', error);
    respondWithGitHubSyncError(res, error, 'Failed to add GitHub PR comment');
  }
});

/**
 * PATCH /api/projects/:projectId/pr-reviews/:prId/conversations/issue-comments
 * Edit an existing top-level PR conversation comment, then resync state.
 */
router.patch('/:projectId/pr-reviews/:prId/conversations/issue-comments', async (req, res) => {
  try {
    const { projectId, prId } = req.params;
    const { commentNodeId, body } = req.body || {};
    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!(await checkOwnership(project, req))) return res.status(403).json({ error: 'Forbidden' });

    const prReview = await prReviewService.getById(prId);
    if (!prReview || prReview.projectId !== projectId) {
      return res.status(404).json({ error: 'PR review not found' });
    }

    const conversations = await prReviewConversationService.updateIssueComment({
      project,
      prReview,
      userId: await getEffectiveProjectUserId(req, project),
      commentNodeId,
      body,
    });
    res.json({ success: true, conversations });
  } catch (error) {
    console.error('Error updating PR issue comment:', error);
    if ([403, 404, 409].includes(Number(error?.status))) {
      return res.status(error.status).json({ error: error.message || 'GitHub PR comment cannot be updated' });
    }
    respondWithGitHubSyncError(res, error, 'Failed to update GitHub PR comment');
  }
});

/**
 * DELETE /api/projects/:projectId/pr-reviews/:prId/conversations/issue-comments
 * Delete an existing top-level PR conversation comment, then resync state.
 */
router.delete('/:projectId/pr-reviews/:prId/conversations/issue-comments', async (req, res) => {
  try {
    const { projectId, prId } = req.params;
    const { commentNodeId } = req.body || {};
    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!(await checkOwnership(project, req))) return res.status(403).json({ error: 'Forbidden' });

    const prReview = await prReviewService.getById(prId);
    if (!prReview || prReview.projectId !== projectId) {
      return res.status(404).json({ error: 'PR review not found' });
    }

    const conversations = await prReviewConversationService.deleteIssueComment({
      project,
      prReview,
      userId: await getEffectiveProjectUserId(req, project),
      commentNodeId,
    });
    res.json({ success: true, conversations });
  } catch (error) {
    console.error('Error deleting PR issue comment:', error);
    if ([403, 404, 409].includes(Number(error?.status))) {
      return res.status(error.status).json({ error: error.message || 'GitHub PR comment cannot be deleted' });
    }
    respondWithGitHubSyncError(res, error, 'Failed to delete GitHub PR comment');
  }
});

/**
 * POST /api/projects/:projectId/pr-reviews/:prId/github-review
 * Publish the current PR review findings as a GitHub pull-request review.
 */
router.post('/:projectId/pr-reviews/:prId/github-review', async (req, res) => {
  try {
    const { projectId, prId } = req.params;
    const {
      action,
      recommendationKeys,
      useExplicitRecommendationSelection,
      body,
      commentOverridesByRecommendationKey,
      manualLineComments,
      skipExistingPublicationCheck,
    } = req.body || {};

    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!(await checkOwnership(project, req))) return res.status(403).json({ error: 'Forbidden' });

    const prReview = await prReviewService.getById(prId);
    if (!prReview || prReview.projectId !== projectId) {
      return res.status(404).json({ error: 'PR review not found' });
    }

    const gh = await resolveGitHubMeta(project, await getEffectiveProjectUserId(req, project));
    if (!gh) {
      return res.status(400).json({ error: 'Project is not connected to GitHub' });
    }

    const result = await prReviewPublishService.publishReview({
      projectId,
      reviewId: prId,
      installationId: gh.installationId,
      owner: gh.owner,
      repo: gh.repo,
      prReview: attachReviewLifecycle(prReview, await getViewerGitHubLogins(req)),
      action,
      recommendationKeys,
      useExplicitRecommendationSelection,
      body,
      commentOverridesByRecommendationKey,
      manualLineComments,
      skipExistingPublicationCheck,
    });

    res.json({
      success: true,
      publication: result.publication,
      reviewSubmission: result.reviewSubmission,
      results: result.results,
    });
  } catch (error) {
    if (error?.statusCode === 409 || error?.code === 'ACTION_BLOCKED') {
      return res.status(409).json({
        error: error.message || 'Review action blocked',
        blockedReason: error.blockedReason || error.message || null,
        staleReason: error.staleReason || null,
      });
    }
    if (error?.message && /action must be one of|required/.test(error.message)) {
      return res.status(400).json({ error: error.message });
    }
    console.error('Error publishing PR review to GitHub:', error);
    res.status(500).json({ error: error.message || 'Failed to publish PR review to GitHub' });
  }
});

/**
 * POST /api/projects/:projectId/pr-reviews/:prId/files/content
 * Fetch before/after content for specific files from GitHub.
 */
router.post('/:projectId/pr-reviews/:prId/files/content', async (req, res) => {
  try {
    const { projectId, prId } = req.params;
    const { paths } = req.body || {};

    if (!Array.isArray(paths) || paths.length === 0) {
      return res.status(400).json({ error: 'paths array is required' });
    }

    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!(await checkOwnership(project, req))) return res.status(403).json({ error: 'Forbidden' });

    const prReview = await prReviewService.getById(prId);
    if (!prReview || prReview.projectId !== projectId) {
      return res.status(404).json({ error: 'PR review not found' });
    }

    const gh = await resolveGitHubMeta(project, await getEffectiveProjectUserId(req, project));
    if (!gh) {
      return res.status(400).json({ error: 'Project is not connected to GitHub' });
    }

    let prFiles = [];
    try {
      prFiles = await getPullRequestFileManifest(
        project,
        prReview,
        await getEffectiveProjectUserId(req, project)
      );
    } catch (err) {
      console.warn(`Failed to fetch PR file list for content hydration:`, err.message);
    }
    const prFileMap = new Map(prFiles.map((f) => [f.path, f]));

    const normalizedPaths = [...new Set(paths.map((p) => String(p || '').trim()).filter(Boolean))];
    const files = [];
    const missingPaths = [];

    // Fetch with concurrency limit
    for (let i = 0; i < normalizedPaths.length; i += FILE_CONTENT_HYDRATE_CONCURRENCY) {
      const batch = normalizedPaths.slice(i, i + FILE_CONTENT_HYDRATE_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (filePath) => {
          const prFile = prFileMap.get(filePath);
          const status = prFile?.status === 'A'
            ? 'added'
            : prFile?.status === 'D'
              ? 'removed'
              : prFile?.status === 'R'
                ? 'renamed'
                : 'modified';
          const oldPath = prFile?.oldPath || null;

          let before = null;
          let after = null;

          // Fetch "before" content (from base branch) — skip for added files
          if (status !== 'added') {
            try {
              const lookupPath = oldPath || filePath;
              const data = await githubService.getRepositoryContents(
                gh.installationId, gh.owner, gh.repo, lookupPath, prReview.baseSha
              );
              if (data && data.content) {
                before = Buffer.from(data.content, 'base64').toString('utf-8');
              }
            } catch {
              // File didn't exist on base — treat as added
            }
          }

          // Fetch "after" content (from head branch) — skip for removed files
          if (status !== 'removed') {
            try {
              const data = await githubService.getRepositoryContents(
                gh.installationId, gh.owner, gh.repo, filePath, prReview.headSha
              );
              if (data && data.content) {
                after = Buffer.from(data.content, 'base64').toString('utf-8');
              }
            } catch {
              // File doesn't exist on head — treat as deleted
            }
          }

          return {
            path: filePath,
            before,
            after,
            status: status === 'removed' ? 'D' : status === 'added' ? 'A' : status === 'renamed' ? 'R' : 'M',
            oldPath,
            patch: prFile?.patch || null,
          };
        })
      );

      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'fulfilled') {
          files.push(results[j].value);
        } else {
          missingPaths.push(batch[j]);
        }
      }
    }

    res.json({ success: true, files, missingPaths });
  } catch (error) {
    console.error('Error fetching PR file contents:', error);
    res.status(500).json({ error: error.message || 'Failed to fetch file contents' });
  }
});

/**
 * POST /api/projects/:projectId/pr-reviews/:prId/review/queue
 * Queue an AI review for a PR review.
 */
router.post('/:projectId/pr-reviews/:prId/review/queue', enforceQuotas, async (req, res) => {
  try {
    const { projectId, prId } = req.params;
    const {
      reviewMode,
      forceFullScope,
      policySource,
      reviewModelStrategy = null,
      reviewModelCustom = null,
      reviewModelAdaptive = null,
      reviewModelRollout = null,
    } = req.body || {};

    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!(await checkOwnership(project, req))) return res.status(403).json({ error: 'Forbidden' });

    const prReview = await prReviewService.getById(prId);
    if (!prReview || prReview.projectId !== projectId) {
      return res.status(404).json({ error: 'PR review not found' });
    }

    const gh = await resolveGitHubMeta(project, await getEffectiveProjectUserId(req, project));
    if (!gh) {
      return res.status(400).json({ error: 'Project is not connected to GitHub' });
    }

    const entry = reviewService.enqueuePrReview(projectId, prId, {
      installationId: gh.installationId,
      owner: gh.owner,
      repo: gh.repo,
      prNumber: prReview.githubPrNumber,
      projectPath: project.path || null,
      reviewMode,
      forceFullScope: forceFullScope === true,
      policySource,
      reviewModelStrategy,
      reviewModelCustom,
      reviewModelAdaptive,
      reviewModelRollout,
    });

    res.json({ success: true, position: entry.position, id: entry.id });
  } catch (error) {
    console.error('Error queueing PR review:', error);
    res.status(500).json({ error: error.message || 'Failed to queue PR review' });
  }
});

/**
 * DELETE /api/projects/:projectId/pr-reviews/:prId
 * Clear a PR review result and reset it to an unreviewed state.
 */
router.delete('/:projectId/pr-reviews/:prId', async (req, res) => {
  try {
    const { projectId, prId } = req.params;

    if (!isPrReviewResetAllowed()) {
      return res.status(403).json({
        error: 'PR review reset is only available in local and desktop environments.',
      });
    }

    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!(await checkOwnership(project, req))) return res.status(403).json({ error: 'Forbidden' });

    const prReview = await prReviewService.getById(prId);
    if (!prReview || prReview.projectId !== projectId) {
      return res.status(404).json({ error: 'PR review not found' });
    }

    const queueEntries = reviewService.getQueueStatus();
    const activeEntry = queueEntries.find(
      (entry) => entry?.type === 'pr_review' && entry?.prReviewId === prId && entry?.lifecycle?.isActive
    ) || null;

    let stopped = { stopped: false, was: null };
    if (activeEntry?.id) {
      stopped = await reviewService.stopReview(activeEntry.id);
    }

    await reviewFixRunStore.deleteRuns({
      projectId,
      reviewType: 'pr_review',
      reviewId: prId,
    });

    const updatedReview = await prReviewService.updateReview(prId, {
      review_status: 'none',
      review_risk_level: null,
      review_summary: null,
      review_json: null,
      review_error: null,
      review_head_sha: null,
      reviewed_at: null,
    });

    invalidatePrFileManifestCache(projectId, prId);

    res.json({
      success: true,
      deleted: true,
      prReview: attachReviewLifecycle(updatedReview || prReview),
      stopped,
    });
  } catch (error) {
    console.error('Error deleting PR review:', error);
    res.status(500).json({ error: error.message || 'Failed to delete PR review' });
  }
});

/**
 * DELETE /api/projects/:projectId/pr-reviews/:prId/review/queue
 * Stop a queued or running PR review.
 */
router.delete('/:projectId/pr-reviews/:prId/review/queue', async (req, res) => {
  try {
    const { projectId, prId } = req.params;

    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!(await checkOwnership(project, req))) return res.status(403).json({ error: 'Forbidden' });

    const queueEntries = reviewService.getQueueStatus();
    const match = queueEntries.find(
      (e) => e.type === 'pr_review' && e.prReviewId === prId
    );
    if (!match) {
      return res.json({ success: true, stopped: false, was: null });
    }

    const result = await reviewService.stopReview(match.id);
    res.json({ success: true, ...result });
  } catch (error) {
    console.error('Error stopping PR review:', error);
    res.status(500).json({ error: error.message || 'Failed to stop PR review' });
  }
});

export default router;
