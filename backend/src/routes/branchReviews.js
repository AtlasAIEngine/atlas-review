/**
 * Branch Review Routes
 * API endpoints for listing, viewing, and managing branch reviews.
 */

import express from 'express';
import path from 'path';
import { getProjectById } from '../db/queries.js';
import { updateProject } from '../db/queries.js';
import branchReviewService from '../services/branchReviewService.js';
import prReviewService from '../services/prReviewService.js';
import reviewService from '../services/reviewService.js';
import reviewFixRunStore from '../services/review/reviewFixRunStore.js';
import gitService from '../services/gitService.js';
import gitWatcherService from '../services/gitWatcherService.js';
import workspaceReviewService from '../services/workspaceReviewService.js';
import { enforceQuotas } from '../middleware/quotas.js';
import { buildReviewActionEligibility, buildReviewLifecycle } from '../utils/reviewLifecycle.js';
import { getClearedBranchReviewSnapshotFields, hasPersistedBranchReviewSnapshot } from '../utils/branchReviewSnapshot.js';
import { selectVisibleReviewFiles, summarizeVisibleReviewFiles, resolveVisibleReviewFileLimit } from '../utils/reviewFileSelection.js';
import trustAnalyticsService from '../services/trustAnalyticsService.js';
import {
  resolvePreservedForkPointSha,
  resolveEffectiveDiffStats,
  classifyForkPointRecovery,
  computeUnreviewedScope,
} from '../services/review/branchReviewReconcileHelpers.js';
import { suppressBranchAutoReviewForSnapshot } from '../services/review/branchAutoReviewSuppression.js';

function attachForkPointRecovery(review) {
  if (!review || typeof review !== 'object') return review;
  return {
    ...review,
    forkPointRecovery: classifyForkPointRecovery({
      forkPointSha: review.forkPointSha,
      mergeBaseSha: review.mergeBaseSha,
      headSha: review.headSha,
    }),
  };
}

/**
 * Populate `unreviewedFileCount` / `unreviewedCommitCount` for reviews
 * that have a completed baseline. Uses `Promise.allSettled` so one
 * slow review doesn't block the whole list response. Skips inactive
 * reviews (status !== 'active') and reviews with no prior completed
 * baseline (no `reviewHeadSha`).
 */
async function attachUnreviewedScopeBulk(reviews, projectPath) {
  if (!Array.isArray(reviews) || reviews.length === 0 || !projectPath) return reviews;
  const results = await Promise.allSettled(
    reviews.map(async (review) => {
      if (
        !review
        || review.status !== 'active'
        || !review.reviewHeadSha
        || review.reviewHeadSha === review.headSha
      ) {
        return review;
      }
      const scope = await computeUnreviewedScope({
        projectPath,
        branchName: review.branchName,
        reviewHeadSha: review.reviewHeadSha,
        headSha: review.headSha,
        gitService,
      });
      return {
        ...review,
        unreviewedFileCount: scope.unreviewedFileCount,
        unreviewedCommitCount: scope.unreviewedCommitCount,
      };
    })
  );
  return results.map((r, i) => (r.status === 'fulfilled' ? r.value : reviews[i]));
}

async function attachUnreviewedScope(review, projectPath) {
  if (!review || review.status !== 'active' || !review.reviewHeadSha) return review;
  if (review.reviewHeadSha === review.headSha) return review;
  const scope = await computeUnreviewedScope({
    projectPath,
    branchName: review.branchName,
    reviewHeadSha: review.reviewHeadSha,
    headSha: review.headSha,
    gitService,
  });
  return {
    ...review,
    unreviewedFileCount: scope.unreviewedFileCount,
    unreviewedCommitCount: scope.unreviewedCommitCount,
  };
}

async function suppressAutoReviewAfterUserStop(branchReviewId, result, snapshot = null) {
  if (!result?.stopped) return;
  let review = null;
  try {
    review = await branchReviewService.getById(branchReviewId);
  } catch {
    review = null;
  }
  if (!review) return;
  await suppressBranchAutoReviewForSnapshot(review, {
    snapshot,
    reason: result.was === 'queued' ? 'user_cancelled_queued_review' : 'user_stopped_review',
  });
}

const router = express.Router();

const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';
const MANIFEST_CACHE_TTL_MS = 30 * 1000;
const MANIFEST_CACHE_MAX_ENTRIES = 200;
const FILE_CONTENT_HYDRATE_CONCURRENCY = Math.min(
  12,
  Math.max(1, Number(process.env.ATLAS_BRANCH_REVIEW_FILE_CONTENT_CONCURRENCY || 6))
);
const LIST_RECONCILE_COOLDOWN_MS = Math.max(
  1000,
  Number(process.env.ATLAS_BRANCH_REVIEW_LIST_RECONCILE_COOLDOWN_MS || 30000)
);
const CURRENT_BRANCH_CACHE_TTL_MS = Math.max(
  1000,
  Number(process.env.ATLAS_BRANCH_REVIEW_CURRENT_BRANCH_CACHE_TTL_MS || 10000)
);
const DUPLICATE_BRANCH_REVIEW_ERROR = 'Superseded duplicate branch review entry';

/**
 * Resolve the effective diff base SHA for a branch review. Prefers
 * `fork_point_sha` (the preserved pre-merge anchor) over the volatile
 * `merge_base_sha`, which collapses to HEAD after a fast-forward merge.
 * Legacy rows without `fork_point_sha` fall back to `merge_base_sha`.
 */
function resolveEffectiveDiffBaseSha(review) {
  const forkPoint = typeof review?.forkPointSha === 'string' ? review.forkPointSha.trim() : '';
  if (forkPoint) return forkPoint;
  const mergeBase = typeof review?.mergeBaseSha === 'string' ? review.mergeBaseSha.trim() : '';
  return mergeBase || null;
}

function normalizeBranchReviewDiffScope(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'last_commit' ? 'last_commit' : 'base_branch';
}

function isLastCommitBranchReviewScope(review) {
  const baseBranchSource = String(review?.baseBranchSource || '').trim().toLowerCase();
  if (baseBranchSource === 'last_commit') return true;
  const baseBranch = String(review?.baseBranch || '').trim();
  return baseBranch.endsWith('~last-commit');
}

function buildLastCommitBaseBranch(branchName) {
  return `${String(branchName || '').trim()}~last-commit`;
}

const manifestCache = new Map();
const manifestInFlight = new Map();
const listReconcileInFlight = new Map();
const listReconcileStartedAt = new Map();
const repairedCurrentBranchReviewState = new Map();
const currentBranchCache = new Map();

export function resetBranchReviewRouteTestState() {
  manifestCache.clear();
  manifestInFlight.clear();
  listReconcileInFlight.clear();
  listReconcileStartedAt.clear();
  repairedCurrentBranchReviewState.clear();
  currentBranchCache.clear();
}

function checkOwnership(project, req) {
  const effectiveUserId = req.user?.id || ANONYMOUS_USER_ID;
  return project.user_id === effectiveUserId;
}

function isBranchReviewResetAllowed() {
  if (process.env.ATLAS_ALLOW_BRANCH_REVIEW_RESET === 'true') return true;
  if (process.env.ATLAS_DESKTOP_MODE === 'true') return true;
  return process.env.NODE_ENV !== 'production';
}

function getBranchReviewRunActive(branchReviewId) {
  return typeof reviewService.getActiveBranchReviewRun === 'function'
    ? reviewService.getActiveBranchReviewRun(branchReviewId)
    : null;
}

function attachBranchReviewLifecycle(review) {
  if (!review || typeof review !== 'object') return review;
  const runtimeState = getBranchReviewRunActive(review.id);
  const reviewStatus = review.reviewStatus ?? review.review_status ?? 'none';
  const reviewError = review.reviewError ?? review.review_error ?? null;
  const reviewedAt = review.reviewedAt ?? review.reviewed_at ?? null;
  const updatedAt = review.updatedAt ?? review.updated_at ?? null;
  const reviewLifecycle = runtimeState
    ? buildReviewLifecycle({
        reviewStatus: 'reviewing',
        sourceStatus: 'reviewing',
        errorMessage: null,
        reviewedAt,
        updatedAt: runtimeState.updatedAt || updatedAt,
        progress: runtimeState.progress || {
          phase: 'running',
          updatedAt: runtimeState.updatedAt || updatedAt || new Date().toISOString(),
        },
      })
    : buildReviewLifecycle({
        reviewStatus,
        sourceStatus: reviewStatus,
        errorMessage: reviewError,
        reviewedAt,
        updatedAt,
      });
  return {
    ...review,
    reviewStatus: runtimeState ? 'reviewing' : reviewStatus,
    reviewLifecycle,
    reviewActionEligibility: buildReviewActionEligibility(review, reviewLifecycle),
  };
}

async function listProjectWorktrees(projectPath) {
  if (!projectPath) return [];
  const worktrees = await gitService.listWorktrees(projectPath);
  return Array.isArray(worktrees) ? worktrees : [];
}

function buildWorktreeMap(worktrees) {
  const map = new Map();
  for (const entry of worktrees) {
    const branchName = String(entry?.branch || '').trim();
    if (!branchName || map.has(branchName)) continue;
    const worktreePath = String(entry?.path || '').trim();
    map.set(branchName, {
      isWorktree: true,
      worktreePath: worktreePath || null,
      worktreeName: worktreePath ? path.basename(worktreePath) : null,
      worktreeHead: String(entry?.head || '').trim() || null,
    });
  }
  return map;
}

function attachWorktreeMetadata(review, worktreeMap) {
  if (!review || typeof review !== 'object') return review;
  const branchName = String(review.branchName || review.branch_name || '').trim();
  if (!branchName || !(worktreeMap instanceof Map)) {
    return {
      ...review,
      isWorktree: false,
      worktreePath: null,
      worktreeName: null,
      worktreeHead: null,
    };
  }
  const metadata = worktreeMap.get(branchName);
  return {
    ...review,
    isWorktree: Boolean(metadata),
    worktreePath: metadata?.worktreePath || null,
    worktreeName: metadata?.worktreeName || null,
    worktreeHead: metadata?.worktreeHead || null,
  };
}

function getActiveBranchReviewState(branchReviewId) {
  const activeRun = getBranchReviewRunActive(branchReviewId);
  if (activeRun) {
    return {
      entry: null,
      position: Number.isFinite(activeRun.position) ? Number(activeRun.position) : null,
      runtime: activeRun,
    };
  }

  const queueEntries = typeof reviewService.getQueueStatus === 'function'
    ? reviewService.getQueueStatus()
    : [];
  const runningIndex = queueEntries.findIndex(
    (entry) => entry?.type === 'branch_review'
      && entry?.branchReviewId === branchReviewId
      && (
        entry?.status === 'reviewing'
        || entry?.status === 'running'
        || entry?.status === 'retrying'
        || entry?.lifecycle?.status === 'running'
        || entry?.lifecycle?.status === 'retrying'
      )
  );
  if (runningIndex !== -1) {
    return {
      entry: queueEntries[runningIndex],
      position: runningIndex + 1,
      runtime: null,
    };
  }

  const activeIndex = queueEntries.findIndex(
    (entry) => entry?.type === 'branch_review'
      && entry?.branchReviewId === branchReviewId
      && entry?.lifecycle?.isActive
  );
  if (activeIndex === -1) {
    return { entry: null, position: null, runtime: null };
  }
  return {
    entry: queueEntries[activeIndex],
    position: activeIndex + 1,
    runtime: null,
  };
}

function isActiveQueueLifecycle(entry) {
  return entry?.lifecycle?.isActive === true;
}

async function getProjectBaseBranchChangeLock(projectId, projectPath, branchReviews = null) {
  const queueEntries = typeof reviewService.getQueueStatus === 'function'
    ? reviewService.getQueueStatus()
    : [];
  const projectBranchReviews = Array.isArray(branchReviews)
    ? branchReviews
    : await branchReviewService.getByProject(projectId);
  const branchReviewIds = new Set(
    (Array.isArray(projectBranchReviews) ? projectBranchReviews : [])
      .map((review) => String(review?.id || '').trim())
      .filter(Boolean)
  );

  for (const branchReviewId of branchReviewIds) {
    if (getBranchReviewRunActive(branchReviewId)) {
      return {
        type: 'branch_review',
        reviewId: branchReviewId,
      };
    }
  }

  const activeBranchQueueEntry = queueEntries.find((entry) => (
    entry?.type === 'branch_review'
    && branchReviewIds.has(String(entry?.branchReviewId || '').trim())
    && isActiveQueueLifecycle(entry)
  ));
  if (activeBranchQueueEntry) {
    return {
      type: 'branch_review',
      reviewId: String(activeBranchQueueEntry.branchReviewId || '').trim() || null,
    };
  }

  if (!projectPath || typeof workspaceReviewService.list !== 'function') {
    return null;
  }

  const workspaceReviews = await workspaceReviewService.list(projectPath, { projectId });
  const workspaceReviewIds = new Set(
    (Array.isArray(workspaceReviews) ? workspaceReviews : [])
      .map((review) => String(review?.id || '').trim())
      .filter(Boolean)
  );
  const activeWorkspaceQueueEntry = queueEntries.find((entry) => (
    entry?.type === 'workspace_review'
    && workspaceReviewIds.has(String(entry?.workspaceReviewId || '').trim())
    && isActiveQueueLifecycle(entry)
  ));
  if (activeWorkspaceQueueEntry) {
    return {
      type: 'workspace_review',
      reviewId: String(activeWorkspaceQueueEntry.workspaceReviewId || '').trim() || null,
    };
  }

  return null;
}

function getBaseBranchChangeLockMessage(lock) {
  if (!lock || typeof lock !== 'object') {
    return 'Base branch cannot change while review work is in progress.';
  }
  if (lock.type === 'workspace_review') {
    return 'Base branch cannot change while the workspace review is queued or running.';
  }
  return 'Base branch cannot change while the current branch review is queued or running.';
}

async function resetBranchReviewSnapshotIfRequested(review, shouldReset) {
  if (!shouldReset || !review || !hasPersistedBranchReviewSnapshot(review)) {
    return review;
  }
  return branchReviewService.updateReview(review.id, getClearedBranchReviewSnapshotFields());
}

function parseBooleanFlag(value, defaultValue = false) {
  if (value == null) return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return defaultValue;
}

function getManifestCacheKey(projectPath, mergeBaseSha, headRef) {
  return `${projectPath}::${mergeBaseSha}::${headRef || 'HEAD'}`;
}

function pruneManifestCache() {
  const now = Date.now();
  for (const [key, entry] of manifestCache.entries()) {
    if (!entry || entry.expiresAt <= now) {
      manifestCache.delete(key);
    }
  }
  while (manifestCache.size > MANIFEST_CACHE_MAX_ENTRIES) {
    const oldestKey = manifestCache.keys().next().value;
    if (!oldestKey) break;
    manifestCache.delete(oldestKey);
  }
}

function parseRenameStatPath(rawPath) {
  const text = String(rawPath || '').trim();
  if (!text) return { path: '', oldPath: null };

  const braceMatch = text.match(/^(.*)\{(.*)\s=>\s(.*)\}(.*)$/);
  if (braceMatch) {
    const [, prefix, oldMid, newMid, suffix] = braceMatch;
    return {
      path: `${prefix}${newMid}${suffix}`,
      oldPath: `${prefix}${oldMid}${suffix}`,
    };
  }

  const simpleMatch = text.match(/^(.*)\s=>\s(.*)$/);
  if (simpleMatch) {
    return {
      oldPath: simpleMatch[1].trim() || null,
      path: simpleMatch[2].trim(),
    };
  }

  return { path: text, oldPath: null };
}

function mergeDiffMetadata(stats, nameStatus) {
  const files = [];
  const nameStatusEntries = Array.isArray(nameStatus) ? nameStatus : [];
  const statsFiles = Array.isArray(stats?.files) ? stats.files : [];

  const coveredNameStatusPaths = new Set();
  for (const entry of nameStatusEntries) {
    if (entry?.path) coveredNameStatusPaths.add(entry.path);
    if (entry?.oldPath) coveredNameStatusPaths.add(entry.oldPath);
  }

  const normalizedStats = statsFiles
    .map((file) => {
      const parsed = parseRenameStatPath(file?.path);
      return {
        path: parsed.path,
        oldPath: parsed.oldPath,
        additions: Number(file?.additions || 0),
        deletions: Number(file?.deletions || 0),
      };
    })
    .filter((file) => !!file.path);

  const statByPath = new Map();
  for (const file of normalizedStats) {
    if (file.path) statByPath.set(file.path, file);
    if (file.oldPath) statByPath.set(file.oldPath, file);
  }

  for (const entry of nameStatusEntries) {
    if (!entry?.path) continue;
    const stat = statByPath.get(entry.path)
      || (entry.oldPath ? statByPath.get(entry.oldPath) : null);
    files.push({
      path: entry.path,
      additions: Number(stat?.additions || 0),
      deletions: Number(stat?.deletions || 0),
      status: entry.status || 'M',
      oldPath: entry.oldPath || null,
    });
  }

  for (const stat of normalizedStats) {
    if (!stat.path) continue;
    if (coveredNameStatusPaths.has(stat.path) || (stat.oldPath && coveredNameStatusPaths.has(stat.oldPath))) {
      continue;
    }
    files.push({
      path: stat.path,
      additions: stat.additions,
      deletions: stat.deletions,
      status: stat.oldPath ? 'R' : 'M',
      oldPath: stat.oldPath || null,
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const file of files) {
    const key = `${file.status}|${file.oldPath || ''}|${file.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(file);
  }

  return deduped;
}

async function buildDiffManifest(projectPath, mergeBaseSha, headRef) {
  const [stats, nameStatus] = await Promise.all([
    gitService.getThreeDotDiffStats(projectPath, mergeBaseSha, headRef),
    gitService.getThreeDotDiffNameStatus(projectPath, mergeBaseSha, headRef),
  ]);
  return mergeDiffMetadata(stats, nameStatus);
}

async function getDiffManifest(projectPath, mergeBaseSha, headRef) {
  const key = getManifestCacheKey(projectPath, mergeBaseSha, headRef);
  const now = Date.now();
  const cached = manifestCache.get(key);
  if (cached && cached.expiresAt > now) {
    return cached.files;
  }
  if (cached) {
    manifestCache.delete(key);
  }
  if (manifestInFlight.has(key)) {
    return manifestInFlight.get(key);
  }

  const request = (async () => {
    const files = await buildDiffManifest(projectPath, mergeBaseSha, headRef);
    pruneManifestCache();
    manifestCache.set(key, {
      files,
      expiresAt: Date.now() + MANIFEST_CACHE_TTL_MS,
    });
    return files;
  })();

  manifestInFlight.set(key, request);
  try {
    return await request;
  } finally {
    manifestInFlight.delete(key);
  }
}

async function hydrateFileContent(projectPath, mergeBaseSha, headRef, file) {
  const beforePath = file.oldPath || file.path;
  const [before, after, patch] = await Promise.all([
    file.status !== 'A'
      ? gitService.getFileAtRef(projectPath, mergeBaseSha, beforePath)
      : Promise.resolve(null),
    file.status !== 'D'
      ? gitService.getFileAtRef(projectPath, headRef, file.path)
      : Promise.resolve(null),
    gitService
      .getThreeDotFilePatch(projectPath, mergeBaseSha, headRef, file.path)
      .catch(() => null),
  ]);

  return {
    ...file,
    before,
    after,
    patch,
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const safeConcurrency = Math.max(1, Number(concurrency) || 1);
  const workers = Math.min(items.length, safeConcurrency);
  const results = new Array(items.length);
  let cursor = 0;

  const worker = async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: workers }, () => worker()));
  return results;
}

function normalizeRequestedPaths(paths, max = 40) {
  if (!Array.isArray(paths)) return [];
  const deduped = [];
  const seen = new Set();
  for (const entry of paths) {
    const path = String(entry || '').trim();
    if (!path || seen.has(path)) continue;
    deduped.push(path);
    seen.add(path);
    if (deduped.length >= max) break;
  }
  return deduped;
}

async function resolveBaseRef(projectPath, baseBranch) {
  if (!baseBranch) return null;
  let baseRef = `origin/${baseBranch}`;
  if (!(await gitService.refExists(projectPath, `refs/remotes/${baseRef}`))) {
    baseRef = baseBranch;
    if (!(await gitService.refExists(projectPath, `refs/heads/${baseRef}`))) {
      return null;
    }
  }
  return baseRef;
}

async function resolveLocalReviewBaseRef(projectPath, baseBranch) {
  const branch = typeof baseBranch === 'string' ? baseBranch.trim() : '';
  if (!projectPath || !branch) return { baseBranch: null, baseRef: null };

  const localRef = `refs/heads/${branch}`;
  if (await gitService.refExists(projectPath, localRef).catch(() => false)) {
    return { baseBranch: branch, baseRef: localRef };
  }

  const remoteRef = `refs/remotes/origin/${branch}`;
  if (await gitService.refExists(projectPath, remoteRef).catch(() => false)) {
    return { baseBranch: branch, baseRef: `origin/${branch}` };
  }

  return { baseBranch: null, baseRef: null };
}

async function resolveOnDemandBranchBase(projectPath, branchName, preferredBaseBranch = null, projectId = null) {
  const preferred = typeof preferredBaseBranch === 'string' && preferredBaseBranch.trim()
    ? preferredBaseBranch.trim()
    : null;
  const branch = typeof branchName === 'string' ? branchName.trim() : '';

  const prBase = await prReviewService.findBaseBranchForHead(projectId, branch);
  if (prBase && prBase !== branch) {
    const prBaseRef = await resolveLocalReviewBaseRef(projectPath, prBase);
    if (prBaseRef.baseRef) return prBaseRef;
  }

  const inferred = await gitService.inferBaseBranch(projectPath, branch, {
    preferredBaseBranch: preferred,
  }).catch(() => null);
  if (typeof inferred === 'string' && inferred.trim() && inferred.trim() !== branch) {
    const inferredRef = await resolveLocalReviewBaseRef(projectPath, inferred.trim());
    if (inferredRef.baseRef) return inferredRef;
  }

  if (preferred && preferred !== branch) {
    const preferredRef = await resolveLocalReviewBaseRef(projectPath, preferred);
    if (preferredRef.baseRef) return preferredRef;
  }

  return { baseBranch: null, baseRef: null };
}

async function computeOnDemandBranchDiffStats(projectPath, baseRef, headRef) {
  if (!projectPath || !baseRef || !headRef) return null;
  const mergeBaseSha = await gitService.getMergeBase(projectPath, baseRef, headRef).catch(() => null);
  if (!mergeBaseSha) return null;

  const [stats, commits, headSha] = await Promise.all([
    gitService.getThreeDotDiffStats(projectPath, mergeBaseSha, headRef).catch(() => null),
    gitService.getCommitsBetween(projectPath, mergeBaseSha, headRef).catch(() => []),
    gitService.getRefSha(projectPath, headRef).catch(() => null),
  ]);
  if (!stats) return null;

  const commitList = Array.isArray(commits) ? commits : [];
  return {
    mergeBaseSha,
    headSha,
    fileCount: Number(stats.fileCount || 0),
    totalAdditions: Number(stats.totalAdditions || 0),
    totalDeletions: Number(stats.totalDeletions || 0),
    commitCount: commitList.length,
    firstCommitAt: commitList.length ? (commitList[commitList.length - 1]?.date || null) : null,
    lastCommitAt: commitList.length ? (commitList[0]?.date || null) : null,
  };
}

async function computeLastCommitBranchDiffStats(projectPath, branchName) {
  if (!projectPath || !branchName) return null;
  const headSha = await gitService.getRefSha(projectPath, branchName).catch(() => null);
  if (!headSha) return null;
  const parentSha = await gitService.getRefSha(projectPath, `${branchName}^1`).catch(() => null);
  if (!parentSha) return null;

  const [stats, commits] = await Promise.all([
    gitService.getTwoDotDiffStats(projectPath, parentSha, headSha).catch(() => null),
    gitService.getCommitsBetween(projectPath, parentSha, headSha).catch(() => []),
  ]);
  if (!stats) return null;
  const commitList = Array.isArray(commits) ? commits : [];
  return {
    mergeBaseSha: parentSha,
    forkPointSha: parentSha,
    headSha,
    fileCount: Number(stats.fileCount || 0),
    totalAdditions: Number(stats.totalAdditions || 0),
    totalDeletions: Number(stats.totalDeletions || 0),
    commitCount: commitList.length,
    firstCommitAt: commitList.length ? (commitList[commitList.length - 1]?.date || null) : null,
    lastCommitAt: commitList.length ? (commitList[0]?.date || null) : null,
    commits: commitList,
  };
}

async function recoverOnDemandForkPoint(projectPath, baseBranch, baseRef, branchName, diffStats) {
  const headSha = typeof diffStats?.headSha === 'string' ? diffStats.headSha.trim() : '';
  const mergeBaseSha = typeof diffStats?.mergeBaseSha === 'string' ? diffStats.mergeBaseSha.trim() : '';
  if (!projectPath || !baseBranch || !branchName || !headSha || !mergeBaseSha) return null;
  if (mergeBaseSha !== headSha) return null;

  const candidates = [
    baseBranch,
    `refs/heads/${baseBranch}`,
    baseRef,
    `origin/${baseBranch}`,
  ].filter(Boolean);
  const seen = new Set();
  for (const candidate of candidates) {
    const ref = String(candidate || '').trim();
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);

    const recovered = await gitService
      .getForkPointFromReflog(projectPath, ref, branchName)
      .catch(() => null);
    const forkPointSha = typeof recovered === 'string' ? recovered.trim() : '';
    if (!forkPointSha || forkPointSha === headSha) continue;

    const stillAncestor = await gitService
      .isAncestorRef(projectPath, forkPointSha, headSha)
      .catch(() => false);
    if (!stillAncestor) continue;

    const recoveredStats = await gitService
      .getThreeDotDiffStats(projectPath, forkPointSha, branchName)
      .catch(() => null);
    if (!recoveredStats || Number(recoveredStats.fileCount || 0) === 0) continue;

    const commits = await gitService
      .getCommitsBetween(projectPath, forkPointSha, branchName)
      .catch(() => []);
    const commitList = Array.isArray(commits) ? commits : [];
    return {
      forkPointSha,
      stats: {
        ...diffStats,
        fileCount: Number(recoveredStats.fileCount || 0),
        totalAdditions: Number(recoveredStats.totalAdditions || 0),
        totalDeletions: Number(recoveredStats.totalDeletions || 0),
        commitCount: commitList.length,
        firstCommitAt: commitList.length ? (commitList[commitList.length - 1]?.date || null) : null,
        lastCommitAt: commitList.length ? (commitList[0]?.date || null) : null,
      },
    };
  }

  return null;
}

async function resolveEffectiveReviewBaseBranch(projectPath, review, preferredBaseBranch = null) {
  const preferred = typeof preferredBaseBranch === 'string' && preferredBaseBranch.trim()
    ? preferredBaseBranch.trim()
    : null;
  const fallbackBaseBranch = preferred || review?.baseBranch || null;
  const branchName = review?.branchName;
  if (!projectPath || !branchName) return fallbackBaseBranch;

  if (review?.baseBranchSource === 'pinned') {
    const pinned = typeof review?.baseBranch === 'string' ? review.baseBranch.trim() : '';
    if (pinned && pinned !== branchName) {
      const pinnedRef = await resolveLocalReviewBaseRef(projectPath, pinned);
      if (pinnedRef?.baseRef) {
        return pinned;
      }
    }
  }

  const prBase = await prReviewService.findBaseBranchForHead(review?.projectId, branchName);
  if (prBase && prBase !== branchName) {
    return prBase;
  }

  try {
    const inferred = await gitService.inferBaseBranch(projectPath, branchName, {
      preferredBaseBranch: fallbackBaseBranch,
    });
    if (typeof inferred === 'string' && inferred.trim()) {
      return inferred.trim();
    }
  } catch (error) {
    console.warn(`Failed to infer base branch for review ${review?.id}:`, error.message);
  }

  return fallbackBaseBranch;
}

async function resolveRemoteDefaultBranch(projectPath) {
  if (!projectPath) return null;
  try {
    const branch = await gitService.getRemoteDefaultBranch(projectPath);
    if (typeof branch === 'string' && branch.trim()) {
      return branch.trim();
    }
  } catch {
    // Best-effort only.
  }
  return null;
}

async function resolveReconciliationBase(projectPath, review, preferredBaseBranch = null, options = {}) {
  const preferred = typeof preferredBaseBranch === 'string' && preferredBaseBranch.trim()
    ? preferredBaseBranch.trim()
    : null;
  const stored = typeof review?.baseBranch === 'string' && review.baseBranch.trim()
    ? review.baseBranch.trim()
    : null;
  const allowStoredBaseHealing = options?.allowStoredBaseHealing !== false;
  const isPinned = review?.baseBranchSource === 'pinned';

  if (!projectPath) {
    return { baseBranch: stored || preferred || null, baseRef: null };
  }

  if (stored) {
    const storedRef = await resolveBaseRef(projectPath, stored);
    if (storedRef) {
      // Pinned reviews (Phase 05) short-circuit — the user chose this
      // base explicitly via PATCH /:brId/base-branch and does not want
      // inferBaseBranch healing or project-wide cascades to rewrite it.
      if (isPinned) {
        return { baseBranch: stored, baseRef: storedRef };
      }
      // Auto-heal stale rows from older builds where active reviews were
      // accidentally stamped with project base (often "main") instead of
      // the branch's nearest ancestor.
      if (allowStoredBaseHealing && preferred && stored === preferred) {
        const inferredFromAncestry = await resolveEffectiveReviewBaseBranch(
          projectPath,
          { ...review, baseBranch: null },
          null
        );
        if (inferredFromAncestry && inferredFromAncestry !== stored) {
          const inferredRef = await resolveBaseRef(projectPath, inferredFromAncestry);
          if (inferredRef) {
            return { baseBranch: inferredFromAncestry, baseRef: inferredRef };
          }
        }
      }
      return { baseBranch: stored, baseRef: storedRef };
    }
  }

  if (preferred) {
    const preferredRef = await resolveBaseRef(projectPath, preferred);
    if (preferredRef) {
      return { baseBranch: preferred, baseRef: preferredRef };
    }
  }

  const inferred = await resolveEffectiveReviewBaseBranch(projectPath, review, preferredBaseBranch);
  if (!inferred) {
    return { baseBranch: null, baseRef: null };
  }
  const inferredRef = await resolveBaseRef(projectPath, inferred);
  if (!inferredRef) {
    return { baseBranch: null, baseRef: null };
  }

  return { baseBranch: inferred, baseRef: inferredRef };
}

/**
 * Resolve the fork_point_sha value to persist for a reconciled branch review.
 *
 * Rules (see v0.58.0-merged-branch-review-recovery):
 * - If `review.forkPointSha` exists and is still an ancestor of the current
 *   HEAD, preserve it. (Rebase onto the same base leaves the fork point intact
 *   in history even when the merge-base moves forward.)
 * - Otherwise fall back to the newly-computed merge-base, but NEVER allow a
 *   value equal to `headSha` (that's the fast-forward-merge collapse we guard
 *   against — merging HEAD trivially into base makes merge-base == HEAD).
 * - A true rebase onto a different base makes the old fork point no longer an
 *   ancestor of HEAD; in that case we accept the new merge-base.
 *
 * @returns {Promise<string|null>} The fork point SHA to persist, or null.
 */
async function resolveReconciledForkPointSha({
  projectPath,
  review,
  mergeBaseSha,
  headSha,
}) {
  return resolvePreservedForkPointSha({
    projectPath,
    existingForkPointSha: review?.forkPointSha,
    nextMergeBaseSha: mergeBaseSha,
    nextHeadSha: headSha,
    gitService,
  });
}

async function reconcileBranchReviewLifecycle(
  projectPath,
  review,
  preferredBaseBranch = null,
  options = {}
) {
  if (!projectPath || !review || review.status !== 'active') return review;
  const includeCommitMetadata = options?.includeCommitMetadata !== false;
  const allowEquivalentBaseReuse = options?.allowEquivalentBaseReuse === true;
  const allowStoredBaseHealing = options?.allowStoredBaseHealing !== false;

  // Last-commit fallback reviews have no real base branch to reconcile against.
  // Skip all reconciliation checks — they would incorrectly stale/close the review
  // because the branch name matches the remote default (it's the only branch).
  if (isLastCommitBranchReviewScope(review)) {
    return review;
  }

  const remoteDefaultBranch = await resolveRemoteDefaultBranch(projectPath);
  if (
    typeof remoteDefaultBranch === 'string'
    && remoteDefaultBranch.trim()
    && review.branchName === remoteDefaultBranch.trim()
  ) {
    return branchReviewService.updateReview(review.id, {
      status: 'stale',
      is_current: 0,
      base_branch: remoteDefaultBranch.trim(),
      ...(hasPersistedBranchReviewSnapshot(review)
        ? getClearedBranchReviewSnapshotFields()
        : {}),
    });
  }

  const branchRef = `refs/heads/${review.branchName}`;
  const branchExists = await gitService.refExists(projectPath, branchRef).catch(() => false);

  if (!branchExists) {
    return branchReviewService.updateReview(review.id, {
      status: 'closed',
      is_current: 0,
    });
  }

  // Use the stored base branch for reconciliation rather than re-inferring.
  // Re-inference can pick a different branch (e.g. 'main' instead of 'development')
  // on large repos with many branches, producing a different merge-base and 0-file
  // diff that incorrectly transitions the review to 'merged'.
  const { baseBranch: effectiveBaseBranch, baseRef } = await resolveReconciliationBase(
    projectPath,
    review,
    preferredBaseBranch,
    { allowStoredBaseHealing }
  );
  if (!effectiveBaseBranch || !baseRef) return review;

  const mergeBaseSha = await gitService.getMergeBase(projectPath, baseRef, review.branchName).catch(() => null);
  if (!mergeBaseSha) return review;

  const commitSha = await gitService.getRefSha(projectPath, review.branchName).catch(() => null);
  const provisionalHeadSha = commitSha || (review.headSha || null);
  // Resolve the preserved fork point up front so the primary diff reflects
  // the *entire* scope of this branch (everything since it diverged from
  // base), not just the incremental delta relative to the current
  // merge-base. Atlas's incremental review handles "what's new to review"
  // separately; the file/commit counts surfaced in the UI should match the
  // branch's total body of work.
  const nextForkPointSha = await resolveReconciledForkPointSha({
    projectPath,
    review,
    mergeBaseSha,
    headSha: provisionalHeadSha,
  });
  const effectiveDiffBaseSha = nextForkPointSha || mergeBaseSha;
  const canReusePersistedDiffState =
    review.fileCount != null
    && review.totalAdditions != null
    && review.totalDeletions != null
    && (
      Number(review.fileCount || 0) !== 0
      || !hasPersistedBranchReviewSnapshot(review)
    );
  // Don't include fork_point_sha in the short-circuit equality check:
  // legacy rows have forkPointSha=null while nextForkPointSha collapses to
  // mergeBaseSha, so requiring equality would force an unneeded full
  // recompute on every no-op base-branch rename. The fork point gets
  // backfilled on the next real-change reconcile instead.
  if (
    allowEquivalentBaseReuse
    &&
    !includeCommitMetadata
    && commitSha
    && review.mergeBaseSha === mergeBaseSha
    && (review.headSha || null) === commitSha
    && canReusePersistedDiffState
  ) {
    if ((review.baseBranch || null) === (effectiveBaseBranch || null)) {
      return review;
    }
    return branchReviewService.updateReview(review.id, {
      base_branch: effectiveBaseBranch,
    });
  }

  const [stats, commits] = await Promise.all([
    gitService.getThreeDotDiffStats(projectPath, effectiveDiffBaseSha, review.branchName).catch(() => null),
    includeCommitMetadata
      ? gitService.getCommitsBetween(projectPath, effectiveDiffBaseSha, review.branchName).catch(() => [])
      : Promise.resolve(null),
  ]);
  if (!stats) return review;
  const commitList = Array.isArray(commits) ? commits : null;
  const nextHeadSha = commitSha
    || (commitList?.length ? commitList[0].hash : null)
    || (review.headSha || null);

  if (Number(stats.fileCount || 0) === 0) {
    // Before transitioning to 'merged' (e.g. fast-forward merge makes
    // merge-base == HEAD so fileCount collapses to 0), recompute the diff
    // against the preserved fork point. If that range still has content, the
    // branch's original work is recoverable and must stay 'active'.
    //
    // Skip the extra diff if the fork point equals the merge-base we already
    // diffed against (the two ranges would produce the same result), or if the
    // fork point equals HEAD (the FF-collapse we can't see past).
    let forkStats = null;
    let forkCommitList = null;
    const forkPointForRange =
      nextForkPointSha
      && nextForkPointSha !== (nextHeadSha || '')
      && nextForkPointSha !== mergeBaseSha
        ? nextForkPointSha
        : null;
    if (forkPointForRange) {
      [forkStats, forkCommitList] = await Promise.all([
        gitService
          .getThreeDotDiffStats(projectPath, forkPointForRange, review.branchName)
          .catch(() => null),
        includeCommitMetadata
          ? gitService
              .getCommitsBetween(projectPath, forkPointForRange, review.branchName)
              .catch(() => [])
          : Promise.resolve(null),
      ]);
    }

    if (forkStats && Number(forkStats.fileCount || 0) > 0) {
      const forkCommits = Array.isArray(forkCommitList) ? forkCommitList : null;
      const forkFileCount = Number(forkStats.fileCount || 0);
      const forkAdditions = Number(forkStats.totalAdditions || 0);
      const forkDeletions = Number(forkStats.totalDeletions || 0);
      const forkCommitCount = forkCommits?.length || 0;
      const forkFirstCommitAt = includeCommitMetadata
        ? (forkCommits?.length ? forkCommits[forkCommits.length - 1].date : null)
        : (review.firstCommitAt || null);
      const forkLastCommitAt = includeCommitMetadata
        ? (forkCommits?.length ? forkCommits[0].date : null)
        : (review.lastCommitAt || null);
      const hasForkReviewChanged =
        (review.baseBranch || null) !== (effectiveBaseBranch || null)
        || review.status !== 'active'
        || review.mergeBaseSha !== mergeBaseSha
        || (review.forkPointSha || null) !== (nextForkPointSha || null)
        || (review.headSha || null) !== nextHeadSha
        || Number(review.fileCount || 0) !== forkFileCount
        || Number(review.totalAdditions || 0) !== forkAdditions
        || Number(review.totalDeletions || 0) !== forkDeletions
        || (
          includeCommitMetadata
          && (
            Number(review.commitCount || 0) !== forkCommitCount
            || (review.firstCommitAt || null) !== forkFirstCommitAt
            || (review.lastCommitAt || null) !== forkLastCommitAt
          )
        );
      if (!hasForkReviewChanged) return review;
      return branchReviewService.updateReview(review.id, {
        base_branch: effectiveBaseBranch,
        status: 'active',
        merge_base_sha: mergeBaseSha,
        fork_point_sha: nextForkPointSha,
        head_sha: nextHeadSha,
        file_count: forkFileCount,
        total_additions: forkAdditions,
        total_deletions: forkDeletions,
        ...(includeCommitMetadata
          ? {
              commit_count: forkCommitCount,
              first_commit_at: forkFirstCommitAt,
              last_commit_at: forkLastCommitAt,
            }
          : {}),
      });
    }

    if (review.isCurrent) {
      const nextFirstCommitAt = includeCommitMetadata
        ? (commitList?.length ? commitList[commitList.length - 1].date : null)
        : (review.firstCommitAt || null);
      const nextLastCommitAt = includeCommitMetadata
        ? (commitList?.length ? commitList[0].date : null)
        : (review.lastCommitAt || null);
      const hasCurrentZeroDiffChanged =
        (review.baseBranch || null) !== (effectiveBaseBranch || null)
        || review.status !== 'active'
        || review.mergeBaseSha !== mergeBaseSha
        || (review.forkPointSha || null) !== (nextForkPointSha || null)
        || (review.headSha || null) !== nextHeadSha
        || Number(review.fileCount || 0) !== 0
        || Number(review.totalAdditions || 0) !== 0
        || Number(review.totalDeletions || 0) !== 0
        || (
          includeCommitMetadata
          && (
            Number(review.commitCount || 0) !== (commitList?.length || 0)
            || (review.firstCommitAt || null) !== nextFirstCommitAt
            || (review.lastCommitAt || null) !== nextLastCommitAt
          )
        );
      if (!hasCurrentZeroDiffChanged) return review;
      return branchReviewService.updateReview(review.id, {
        base_branch: effectiveBaseBranch,
        status: 'active',
        merge_base_sha: mergeBaseSha,
        fork_point_sha: nextForkPointSha,
        head_sha: nextHeadSha,
        file_count: 0,
        total_additions: 0,
        total_deletions: 0,
        ...(includeCommitMetadata
          ? {
              commit_count: commitList?.length || 0,
              first_commit_at: nextFirstCommitAt,
              last_commit_at: nextLastCommitAt,
            }
          : {}),
        ...(hasPersistedBranchReviewSnapshot(review)
          ? getClearedBranchReviewSnapshotFields()
          : {}),
      });
    }
    return branchReviewService.updateReview(review.id, {
      base_branch: effectiveBaseBranch,
      status: 'merged',
      is_current: 0,
      merge_base_sha: mergeBaseSha,
      fork_point_sha: nextForkPointSha,
      head_sha: nextHeadSha,
      file_count: 0,
      total_additions: 0,
      total_deletions: 0,
      ...(includeCommitMetadata
        ? {
            commit_count: commitList?.length || 0,
            first_commit_at: commitList?.length ? commitList[commitList.length - 1].date : null,
            last_commit_at: commitList?.length ? commitList[0].date : null,
          }
        : {}),
    });
  }

  const nextFileCount = Number(stats.fileCount || 0);
  const nextAdditions = Number(stats.totalAdditions || 0);
  const nextDeletions = Number(stats.totalDeletions || 0);
  const nextCommitCount = commitList?.length || 0;
  const nextFirstCommitAt = includeCommitMetadata
    ? (commitList?.length ? commitList[commitList.length - 1].date : null)
    : (review.firstCommitAt || null);
  const nextLastCommitAt = includeCommitMetadata
    ? (commitList?.length ? commitList[0].date : null)
    : (review.lastCommitAt || null);

  const hasChanged =
    (review.baseBranch || null) !== (effectiveBaseBranch || null)
    ||
    review.mergeBaseSha !== mergeBaseSha
    || (review.forkPointSha || null) !== (nextForkPointSha || null)
    || (review.headSha || null) !== nextHeadSha
    || Number(review.fileCount || 0) !== nextFileCount
    || Number(review.totalAdditions || 0) !== nextAdditions
    || Number(review.totalDeletions || 0) !== nextDeletions
    || (
      includeCommitMetadata
      && (
        Number(review.commitCount || 0) !== nextCommitCount
        || (review.firstCommitAt || null) !== nextFirstCommitAt
        || (review.lastCommitAt || null) !== nextLastCommitAt
      )
    );

  if (!hasChanged) return review;

  return branchReviewService.updateReview(review.id, {
    base_branch: effectiveBaseBranch,
    merge_base_sha: mergeBaseSha,
    fork_point_sha: nextForkPointSha,
    head_sha: nextHeadSha,
    file_count: nextFileCount,
    total_additions: nextAdditions,
    total_deletions: nextDeletions,
    ...(includeCommitMetadata
      ? {
          commit_count: nextCommitCount,
          first_commit_at: nextFirstCommitAt,
          last_commit_at: nextLastCommitAt,
        }
      : {}),
  });
}

/**
 * Best-effort list-path reconcile: swallows per-review failures into a
 * `console.warn`. Used by the background list reconcile task where a
 * single bad review must not crash the entire request.
 */
async function reconcileBranchReviews(projectPath, reviews, preferredBaseBranch = null, options = {}) {
  if (!projectPath || !Array.isArray(reviews) || reviews.length === 0) return reviews;

  const activeReviews = reviews.filter((review) => review.status === 'active');
  if (activeReviews.length === 0) return reviews;

  const reconciledMap = new Map();
  await Promise.all(activeReviews.map(async (activeReview) => {
    try {
      const reconciled = await reconcileBranchReviewLifecycle(projectPath, activeReview, preferredBaseBranch, options);
      if (reconciled) {
        reconciledMap.set(activeReview.id, reconciled);
      }
    } catch (error) {
      console.warn(`Failed to reconcile branch review ${activeReview.id}:`, error.message);
    }
  }));

  return reviews.map((review) => reconciledMap.get(review.id) || review);
}

/**
 * Strict reconcile used by the synchronous PATCH base-branch flow where
 * success/failure must be atomic. Propagates `reconcileBranchReviewLifecycle`
 * errors to the caller so the route's rollback path fires. Uses
 * `Promise.allSettled` internally so one failure doesn't prevent other
 * reviews from reporting their own errors, but re-throws the first error
 * we see after the fan-out completes.
 */
async function reconcileBranchReviewsStrict(projectPath, reviews, preferredBaseBranch = null, options = {}) {
  if (!projectPath || !Array.isArray(reviews) || reviews.length === 0) return reviews;

  const activeReviews = reviews.filter((review) => review.status === 'active');
  if (activeReviews.length === 0) return reviews;

  const settlements = await Promise.allSettled(activeReviews.map(async (activeReview) => {
    return [
      activeReview.id,
      await reconcileBranchReviewLifecycle(projectPath, activeReview, preferredBaseBranch, options),
    ];
  }));

  const firstRejection = settlements.find((s) => s.status === 'rejected');
  if (firstRejection) {
    // Log every failure before propagating so a multi-review fan-out
    // with multiple bad entries still surfaces full context.
    settlements.forEach((settlement, i) => {
      if (settlement.status === 'rejected') {
        const id = activeReviews[i]?.id || 'unknown';
        console.warn(`Failed to reconcile branch review ${id} (strict):`, settlement.reason?.message || settlement.reason);
      }
    });
    throw firstRejection.reason;
  }

  const reconciledMap = new Map(
    settlements
      .map((s) => (s.status === 'fulfilled' ? s.value : null))
      .filter((entry) => entry?.[1])
  );

  return reviews.map((review) => reconciledMap.get(review.id) || review);
}

async function enrichBranchReviewCommitMetadata(projectPath, review) {
  const diffBaseSha = resolveEffectiveDiffBaseSha(review);
  if (!projectPath || !review || review.status !== 'active' || !diffBaseSha) return review;

  const headRef = review.headSha || review.branchName;
  if (!headRef) return review;

  const commits = await gitService.getCommitsBetween(projectPath, diffBaseSha, headRef).catch(() => null);
  if (!Array.isArray(commits)) return review;

  const nextCommitCount = commits.length;
  const nextFirstCommitAt = commits.length > 0 ? commits[commits.length - 1].date : null;
  const nextLastCommitAt = commits.length > 0 ? commits[0].date : null;

  const hasChanged =
    Number(review.commitCount || 0) !== nextCommitCount
    || (review.firstCommitAt || null) !== nextFirstCommitAt
    || (review.lastCommitAt || null) !== nextLastCommitAt;
  if (!hasChanged) return review;

  return branchReviewService.updateReview(review.id, {
    commit_count: nextCommitCount,
    first_commit_at: nextFirstCommitAt,
    last_commit_at: nextLastCommitAt,
  });
}

async function enrichBranchReviewsCommitMetadata(projectPath, reviews) {
  if (!projectPath || !Array.isArray(reviews) || reviews.length === 0) return reviews;

  const activeReviews = reviews.filter((review) => review.status === 'active');
  if (activeReviews.length === 0) return reviews;

  await Promise.all(activeReviews.map(async (activeReview) => {
    try {
      await enrichBranchReviewCommitMetadata(projectPath, activeReview);
    } catch (error) {
      console.warn(`Failed to backfill commit metadata for branch review ${activeReview.id}:`, error.message);
    }
  }));

  return reviews;
}

async function getCachedCurrentBranch(project, { force = false } = {}) {
  if (!project?.id || !project?.path) return null;

  const projectId = String(project.id);
  const now = Date.now();
  const cached = currentBranchCache.get(projectId) || null;
  if (!force && cached && (now - cached.resolvedAt) < CURRENT_BRANCH_CACHE_TTL_MS) {
    return cached.branchName;
  }

  let currentBranch = null;
  try {
    currentBranch = await gitService.getCurrentBranchName(project.path);
  } catch {
    currentBranch = null;
  }

  currentBranchCache.set(projectId, {
    branchName: currentBranch,
    resolvedAt: now,
  });
  return currentBranch;
}

async function alignCurrentBranchReview(project, reviews, { force = false } = {}) {
  if (!project?.id || !project?.path || !Array.isArray(reviews) || reviews.length === 0) {
    return reviews;
  }
  const projectId = String(project.id);

  const currentBranch = await getCachedCurrentBranch(project, { force });
  if (!currentBranch || currentBranch === 'HEAD') {
    return reviews;
  }

  const currentReview = reviews.find((review) => review?.isCurrent) || null;
  if (currentReview?.branchName === currentBranch) {
    repairedCurrentBranchReviewState.delete(projectId);
    return reviews;
  }

  const previousRepairState = repairedCurrentBranchReviewState.get(projectId) || null;
  if (
    !force
    && previousRepairState?.branchName === currentBranch
    && previousRepairState?.branchReviewId === (currentReview?.id || null)
  ) {
    return reviews;
  }

  const matchingReview = reviews.find(
    (review) => review?.status === 'active' && review.branchName === currentBranch
  );
  if (!matchingReview) {
    if (currentReview) {
      try {
        await branchReviewService.setCurrentBranch(project.id, null);
      } catch (repairError) {
        console.warn(
          `[BranchReviews] Failed to clear stale current branch state for project ${projectId}:`,
          repairError.message
        );
        return reviews;
      }
    }
    repairedCurrentBranchReviewState.set(projectId, { branchName: currentBranch, branchReviewId: null });
    return reviews.map((review) => ({
      ...review,
      isCurrent: false,
    }));
  }

  try {
    await branchReviewService.setCurrentBranch(project.id, matchingReview.id);
    repairedCurrentBranchReviewState.set(projectId, {
      branchName: currentBranch,
      branchReviewId: matchingReview.id,
    });
    return reviews.map((review) => ({
      ...review,
      isCurrent: review.id === matchingReview.id,
    }));
  } catch (repairError) {
    console.warn(
      `[BranchReviews] Failed to repair current branch state for project ${projectId}:`,
      repairError.message
    );
    return reviews;
  }
}

const BRANCH_REVIEW_CHANGE_FIELDS = [
  'status',
  'isCurrent',
  'baseBranch',
  'mergeBaseSha',
  'forkPointSha',
  'headSha',
  'fileCount',
  'totalAdditions',
  'totalDeletions',
  'commitCount',
  'reviewStatus',
  'reviewError',
  'updatedAt',
];

function branchReviewStateChanged(before, after) {
  if (!after) return false;
  if (!before) return true;
  for (const field of BRANCH_REVIEW_CHANGE_FIELDS) {
    const prev = before[field] ?? null;
    const next = after[field] ?? null;
    if (prev !== next) return true;
  }
  return false;
}

const LIST_WAIT_THRESHOLD = Math.max(
  0,
  Number(process.env.ATLAS_BRANCH_REVIEW_LIST_WAIT_THRESHOLD || 10),
);

/**
 * Kick the list reconcile task and return a Promise that resolves when
 * it finishes (or immediately if one is already running / cooldown hit).
 * Callers who want the list response to reflect post-reconcile state
 * can `await` this; default callers should use
 * `scheduleBranchReviewListReconcile` which is fire-and-forget.
 */
function scheduleBranchReviewListReconcile(project, preferredBaseBranch = null) {
  if (!project?.id || !project?.path) return null;

  const projectId = String(project.id);
  const existing = listReconcileInFlight.get(projectId);
  if (existing) return existing;

  const now = Date.now();
  const lastStartedAt = listReconcileStartedAt.get(projectId) || 0;
  if ((now - lastStartedAt) < LIST_RECONCILE_COOLDOWN_MS) return null;
  listReconcileStartedAt.set(projectId, now);

  const task = (async () => {
    try {
      const latestReviews = await branchReviewService.getByProject(projectId);
      if (typeof branchReviewService.collapseDuplicateTrackedReviews === 'function') {
        await branchReviewService.collapseDuplicateTrackedReviews(projectId, latestReviews);
      }
      const beforeById = new Map(
        (Array.isArray(latestReviews) ? latestReviews : [])
          .filter((review) => review && review.id)
          .map((review) => [review.id, review])
      );
      // Close stale reviews whose branch no longer exists locally. The
      // active-only reconcile below doesn't touch `status='stale'`
      // entries, so without this a stale review stays forever after its
      // branch is merged+deleted locally — the UI then keeps rendering
      // it on Current/All Local until the user manually dismisses.
      const staleCloseUpdates = new Map();
      const staleReviews = Array.isArray(latestReviews)
        ? latestReviews.filter((review) => review?.status === 'stale' && review?.branchName)
        : [];
      if (staleReviews.length > 0) {
        await Promise.all(staleReviews.map(async (staleReview) => {
          try {
            const branchExists = await gitService
              .refExists(project.path, `refs/heads/${staleReview.branchName}`)
              .catch(() => false);
            if (!branchExists) {
              const closed = await branchReviewService.updateReview(staleReview.id, {
                status: 'closed',
                is_current: 0,
              });
              if (closed) {
                staleCloseUpdates.set(staleReview.id, closed);
              }
            }
          } catch (error) {
            console.warn(
              `Failed to close stale branch review ${staleReview.id} for project ${projectId}:`,
              error.message,
            );
          }
        }));
      }
      // Emit for any stale review that just got closed above so the UI
      // drops it from the list immediately.
      for (const closed of staleCloseUpdates.values()) {
        reviewService.events.emit('branch-review-update', {
          projectId,
          type: 'updated',
          branchReview: closed,
        });
      }
      const reconciled = await reconcileBranchReviews(
        project.path,
        latestReviews,
        preferredBaseBranch
      );
      // The list fetch returns the persisted snapshot before reconcile
      // finishes. Push any reconcile-driven changes back to connected UI
      // clients so the review list, detail pane, and breadcrumb converge
      // without a manual navigation / refresh.
      if (Array.isArray(reconciled)) {
        for (const after of reconciled) {
          if (!after || !after.id) continue;
          const before = beforeById.get(after.id);
          if (branchReviewStateChanged(before, after)) {
            reviewService.events.emit('branch-review-update', {
              projectId,
              type: 'updated',
              branchReview: after,
            });
          }
        }
      }
    } catch (error) {
      console.warn(`Failed to background reconcile branch reviews for project ${projectId}:`, error.message);
    } finally {
      listReconcileInFlight.delete(projectId);
    }
  })();

  listReconcileInFlight.set(projectId, task);
  return task;
}

/**
 * GET /api/projects/:projectId/branch-reviews
 * List all branch reviews for a project
 */
router.get('/:projectId/branch-reviews', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;
    const forceCurrentRefresh = String(req.query.refreshCurrent || '').trim() === '1';
    const waitMode = String(req.query.wait || '').trim().toLowerCase();

    const project = await getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // `?wait=reconcile` (Phase 05): for small projects, await the
    // background reconcile before responding so the UI doesn't flash
    // stale counts on first load. Large projects keep the fire-and-
    // forget behavior and rely on the `branch-review-update` socket
    // event to converge.
    const waitRequested = waitMode === 'reconcile';
    let preReviews = await branchReviewService.getByProject(projectId);
    const preActiveCount = Array.isArray(preReviews)
      ? preReviews.filter((review) => review?.status === 'active').length
      : 0;
    const didAwaitReconcile = waitRequested
      && preActiveCount > 0
      && preActiveCount <= LIST_WAIT_THRESHOLD;
    if (didAwaitReconcile) {
      const task = scheduleBranchReviewListReconcile(project, project.base_branch_display || null);
      if (task) {
        try { await task; } catch { /* reconcile failures are non-fatal for the list */ }
      }
      preReviews = await branchReviewService.getByProject(projectId);
    }

    const normalizedReviews = await alignCurrentBranchReview(project, preReviews, {
      force: forceCurrentRefresh,
    });
    const visibleReviews = normalizedReviews.filter(
      (review) => review?.reviewError !== DUPLICATE_BRANCH_REVIEW_ERROR
    );

    // Keep the list route responsive on large repos. Branch reconciliation can
    // require expensive git ancestry and diff-stat checks, so do it in the
    // background and return the persisted snapshot immediately. Must still
    // fire on waitRequested calls that exceeded the threshold — otherwise
    // large projects opt into wait, we skip the await, and the background
    // path is also skipped, leaving counts stale until another fetch.
    if (
      !didAwaitReconcile
      && Array.isArray(visibleReviews)
      && visibleReviews.some((review) => review?.status === 'active')
    ) {
      scheduleBranchReviewListReconcile(project, project.base_branch_display || null);
    }

    const worktreeMap = buildWorktreeMap(await listProjectWorktrees(project.path));

    const decoratedReviews = visibleReviews
      .map((review) => attachBranchReviewLifecycle(review))
      .map((review) => attachWorktreeMetadata(review, worktreeMap))
      .map((review) => attachForkPointRecovery(review));
    const reviewsWithUnreviewedScope = await attachUnreviewedScopeBulk(decoratedReviews, project.path);

    res.json({
      success: true,
      branchReviews: reviewsWithUnreviewedScope,
    });
  } catch (error) {
    console.error('Error listing branch reviews:', error);
    res.status(500).json({ error: 'Failed to list branch reviews' });
  }
});

/**
 * GET /api/projects/:projectId/branch-reviews/:brId
 * Get a single branch review with on-demand diff content
 */
router.get('/:projectId/branch-reviews/:brId', enforceQuotas, async (req, res) => {
  try {
    const { projectId, brId } = req.params;
    const includeContent = parseBooleanFlag(req.query.includeContent, false);
    const includeAllFiles = parseBooleanFlag(req.query.includeAllFiles, false);
    const visibleFileLimit = resolveVisibleReviewFileLimit(req.query.visibleFileLimit);

    const project = await getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const review = await branchReviewService.getById(brId);
    if (!review || review.projectId !== projectId) {
      return res.status(404).json({ error: 'Branch review not found' });
    }

    // Compute on-demand diff content from git if merge base is available
    let files = [];
    let commits = [];
    let diffManifestSummary = summarizeVisibleReviewFiles([], Number(review.fileCount || 0), visibleFileLimit);

    const diffBaseSha = resolveEffectiveDiffBaseSha(review);
    if (diffBaseSha && project.path) {
      const headRef = review.headSha || 'HEAD';
      try {
        const manifest = await getDiffManifest(project.path, diffBaseSha, headRef);
        const visibleFiles = includeAllFiles ? manifest : selectVisibleReviewFiles(manifest, review, visibleFileLimit);
        diffManifestSummary = summarizeVisibleReviewFiles(
          visibleFiles,
          Number(manifest.length || review.fileCount || 0),
          visibleFileLimit
        );
        files = visibleFiles;
        if (includeContent && visibleFiles.length > 0) {
          files = await mapWithConcurrency(
            visibleFiles,
            FILE_CONTENT_HYDRATE_CONCURRENCY,
            (file) => hydrateFileContent(project.path, diffBaseSha, headRef, file)
          );
        }
      } catch (error) {
        console.warn('Failed to compute on-demand diff:', error.message);
      }
      try {
        commits = await gitService.getCommitsBetween(project.path, diffBaseSha, headRef);
      } catch (error) {
        console.warn('Failed to get commit messages:', error.message);
      }
    }

    const worktreeMap = buildWorktreeMap(await listProjectWorktrees(project.path));
    const branchReviewWithLifecycle = attachBranchReviewLifecycle(attachWorktreeMetadata({
      ...review,
      files,
      commits,
      diffManifestSummary,
    }, worktreeMap));
    const trustAnalytics = await trustAnalyticsService.getBranchReviewTrustAnalytics({
      projectId,
      branchReview: branchReviewWithLifecycle,
    });

    const withUnreviewedScope = await attachUnreviewedScope(
      attachForkPointRecovery(branchReviewWithLifecycle),
      project.path,
    );
    res.json({
      success: true,
      branchReview: {
        ...withUnreviewedScope,
        trustAnalytics,
      },
    });
  } catch (error) {
    console.error('Error getting branch review:', error);
    res.status(500).json({ error: 'Failed to get branch review' });
  }
});

/**
 * POST /api/projects/:projectId/branch-reviews/:brId/refresh
 * Refresh a single branch review from the local git worktree before review actions.
 */
router.post('/:projectId/branch-reviews/:brId/refresh', enforceQuotas, async (req, res) => {
  try {
    const { projectId, brId } = req.params;

    const project = await getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    let review = await branchReviewService.getById(brId);
    if (!review || review.projectId !== projectId) {
      return res.status(404).json({ error: 'Branch review not found' });
    }

    if (project.path && review.status === 'active') {
      const [refreshed] = await reconcileBranchReviewsStrict(
        project.path,
        [review],
        project.base_branch_display || null,
        { includeCommitMetadata: true }
      );
      review = refreshed || review;
    }

    const worktreeMap = buildWorktreeMap(await listProjectWorktrees(project.path));
    const decorated = attachForkPointRecovery(
      attachBranchReviewLifecycle(
        attachWorktreeMetadata(review, worktreeMap)
      )
    );
    const withUnreviewedScope = await attachUnreviewedScope(decorated, project.path);

    res.json({ success: true, branchReview: withUnreviewedScope });
  } catch (error) {
    console.error('Error refreshing branch review:', error);
    res.status(500).json({ error: error.message || 'Failed to refresh branch review' });
  }
});

/**
 * POST /api/projects/:projectId/branch-reviews/:brId/files/content
 * Fetch before/after content for a subset of files in the branch review diff.
 */
router.post('/:projectId/branch-reviews/:brId/files/content', enforceQuotas, async (req, res) => {
  try {
    const { projectId, brId } = req.params;
    const requestedPaths = normalizeRequestedPaths(req.body?.paths, 40);

    if (requestedPaths.length === 0) {
      return res.status(400).json({ error: 'paths must include at least one file path' });
    }

    const project = await getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const review = await branchReviewService.getById(brId);
    if (!review || review.projectId !== projectId) {
      return res.status(404).json({ error: 'Branch review not found' });
    }
    const diffBaseSha = resolveEffectiveDiffBaseSha(review);
    if (!diffBaseSha || !project.path) {
      return res.status(400).json({ error: 'Branch review has no merge base or project path' });
    }

    const headRef = review.headSha || 'HEAD';
    const manifest = await getDiffManifest(project.path, diffBaseSha, headRef);
    const manifestByPath = new Map(manifest.map((file) => [file.path, file]));
    const missingPaths = requestedPaths.filter((path) => !manifestByPath.has(path));

    const targetFiles = requestedPaths
      .map((path) => manifestByPath.get(path))
      .filter(Boolean);

    const files = await mapWithConcurrency(
      targetFiles,
      FILE_CONTENT_HYDRATE_CONCURRENCY,
      (file) => hydrateFileContent(project.path, diffBaseSha, headRef, file)
    );

    res.json({
      success: true,
      files,
      missingPaths,
    });
  } catch (error) {
    console.error('Error loading branch review file contents:', error);
    res.status(500).json({ error: 'Failed to load file contents' });
  }
});

/**
 * PATCH /api/projects/:projectId/branch-reviews/:brId/status
 * Update branch review status
 */
router.patch('/:projectId/branch-reviews/:brId/status', enforceQuotas, async (req, res) => {
  try {
    const { projectId, brId } = req.params;
    const { status } = req.body;

    if (!status || !['active', 'merged', 'closed', 'stale'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be: active, merged, closed, stale' });
    }

    const project = await getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const review = await branchReviewService.getById(brId);
    if (!review || review.projectId !== projectId) {
      return res.status(404).json({ error: 'Branch review not found' });
    }

    const currentWithLifecycle = attachBranchReviewLifecycle(review);
    if (status === 'merged' || status === 'stale') {
      const eligibility = currentWithLifecycle.reviewActionEligibility
        || buildReviewActionEligibility(review, currentWithLifecycle.reviewLifecycle);
      const canTransition = status === 'merged'
        ? eligibility?.canApprove === true
        : eligibility?.canRequestChanges === true;

      if (!canTransition) {
        const blockedReason = eligibility?.blockedReason || 'Review action is blocked by current lifecycle state.';
        return res.status(409).json({
          error: blockedReason,
          blockedReason,
          staleReason: eligibility?.staleReason || null,
          reviewActionEligibility: eligibility || null,
          branchReview: currentWithLifecycle,
        });
      }
    }

    const updated = await branchReviewService.setStatus(brId, status);

    res.json({
      success: true,
      branchReview: attachBranchReviewLifecycle(updated),
    });
  } catch (error) {
    console.error('Error updating branch review status:', error);
    res.status(500).json({ error: 'Failed to update status' });
  }
});

/**
 * PATCH /api/projects/:projectId/branch-reviews/:brId/base-branch
 *
 * Per-review base-branch override. Body: { baseBranch: string, pin?: boolean }.
 *  - `pin: true` (default) writes `base_branch_source='pinned'` so
 *    reconcile's `inferBaseBranch` healing and the project-wide
 *    `seedActiveReviewsWithBaseBranch` cascade both skip this review.
 *  - `pin: false` un-pins the review (sets `base_branch_source='inferred'`)
 *    and lets the next reconcile heal it back to the project-wide base.
 *
 * Emits `branch-review-update` so connected clients refresh.
 */
router.patch('/:projectId/branch-reviews/:brId/base-branch', enforceQuotas, async (req, res) => {
  try {
    const { projectId, brId } = req.params;
    const { baseBranch, pin = true } = req.body || {};

    if (pin && (!baseBranch || typeof baseBranch !== 'string' || !baseBranch.trim())) {
      return res.status(400).json({ error: 'baseBranch is required when pinning' });
    }

    const project = await getProjectById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!checkOwnership(project, req)) return res.status(403).json({ error: 'Forbidden' });

    const review = await branchReviewService.getById(brId);
    if (!review || review.projectId !== projectId) {
      return res.status(404).json({ error: 'Branch review not found' });
    }

    const trimmedBase = typeof baseBranch === 'string' ? baseBranch.trim() : '';

    if (pin) {
      if (project.path) {
        const [localExists, remoteExists] = await Promise.all([
          gitService.refExists(project.path, `refs/heads/${trimmedBase}`).catch(() => false),
          gitService.refExists(project.path, `refs/remotes/origin/${trimmedBase}`).catch(() => false),
        ]);
        if (!localExists && !remoteExists) {
          return res.status(400).json({ error: `Branch '${trimmedBase}' not found locally or on remote` });
        }
      }

      const previousBaseBranch = review.baseBranch || null;
      const previousBaseBranchSource = review.baseBranchSource || 'inferred';
      let updated = await branchReviewService.updateReview(brId, {
        base_branch: trimmedBase,
        base_branch_source: 'pinned',
      });
      try {
        if (project.path) {
          const reconciled = await reconcileBranchReviewsStrict(
            project.path,
            [updated],
            trimmedBase,
            {
              includeCommitMetadata: false,
              allowEquivalentBaseReuse: true,
              allowStoredBaseHealing: false,
            }
          );
          updated = Array.isArray(reconciled) && reconciled[0] ? reconciled[0] : updated;
        }
      } catch (reconcileError) {
        try {
          await branchReviewService.updateReview(brId, {
            base_branch: previousBaseBranch,
            base_branch_source: previousBaseBranchSource,
          });
        } catch (rollbackError) {
          console.error(
            `Failed to roll back per-review base branch update for ${brId}:`,
            rollbackError
          );
        }
        throw reconcileError;
      }

      const decorated = attachForkPointRecovery(
        attachBranchReviewLifecycle(updated)
      );
      reviewService.events.emit('branch-review-update', {
        projectId,
        type: 'updated',
        branchReview: decorated,
      });
      return res.json({ success: true, branchReview: decorated });
    }

    // Un-pin: clear the pin marker; leave the stored base_branch alone so
    // the next reconcile tick can heal it back to the project-wide base.
    const updated = await branchReviewService.updateReview(brId, {
      base_branch_source: 'inferred',
    });
    reviewService.events.emit('branch-review-update', {
      projectId,
      type: 'updated',
      branchReview: updated,
    });
    return res.json({ success: true, branchReview: updated });
  } catch (error) {
    console.error('Error updating per-review base branch:', error);
    return res.status(500).json({ error: 'Failed to update branch-review base branch' });
  }
});

/**
 * POST /api/projects/:projectId/branch-reviews/:brId/review
 * Trigger AI review on a branch review
 */
router.post('/:projectId/branch-reviews/:brId/review', enforceQuotas, async (req, res) => {
  let lifecycleStarted = false;
  try {
    const { projectId, brId } = req.params;
    const {
      scope,
      reviewMode,
      resetSnapshot,
      policySource,
      // CodeGraph experiment override: when explicitly true/false, takes
      // precedence over the per-project setting. Used by the benchmark
      // harness so off/on cells can be paired within one process without
      // touching the user's persisted toggle. Null/undefined → use the
      // per-project setting (production path).
      codegraphMcpEnabled,
    } = req.body || {};

    const project = await getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const review = await branchReviewService.getById(brId);
    if (!review || review.projectId !== projectId) {
      return res.status(404).json({ error: 'Branch review not found' });
    }

    const currentWithLifecycle = attachBranchReviewLifecycle(review);
    const activeReviewState = getActiveBranchReviewState(brId);
    if (activeReviewState.entry || activeReviewState.runtime) {
      return res.json({
        success: true,
        alreadyRunning: true,
        id: activeReviewState.entry?.id || activeReviewState.runtime?.queueId || null,
        position: activeReviewState.position,
        branchReview: currentWithLifecycle,
      });
    }

    const projectPath = project.path;
    if (!projectPath) {
      return res.status(400).json({ error: 'Project has no local path — cannot run review' });
    }

    await resetBranchReviewSnapshotIfRequested(review, parseBooleanFlag(resetSnapshot, false));

    const directReviewController = new AbortController();
    reviewService.markActiveBranchReviewRun?.(brId, {
      projectId,
      source: 'direct',
      abortController: directReviewController,
      progress: {
        phase: 'running',
        updatedAt: new Date().toISOString(),
      },
    });

    reviewService.events?.emit?.('branch-review-reviewing', {
      projectId,
      branchReviewId: brId,
    });
    lifecycleStarted = true;

    // Run the actual AI review (service transitions status and clears stale errors
    // only after the run is accepted).
    const result = await reviewService.reviewBranchReview(projectPath, brId, {
      force: true,
      reviewMode,
      policySource,
      scope,
      externalSignal: directReviewController.signal,
      codegraphMcpEnabledOverride: typeof codegraphMcpEnabled === 'boolean' ? codegraphMcpEnabled : null,
      onHeartbeat: () => {
        reviewService.touchActiveBranchReviewRun?.(brId, null, { projectId, source: 'direct' });
      },
      onProgressCheckpoint: (progress) => {
        reviewService.touchActiveBranchReviewRun?.(brId, progress, { projectId, source: 'direct' });
      },
    });
    reviewService.clearActiveBranchReviewRun?.(brId);
    const latestReview = attachBranchReviewLifecycle(await branchReviewService.getById(brId));

    reviewService.events?.emit?.('branch-review-reviewed', {
      projectId,
      branchReviewId: brId,
      riskLevel: result?.riskLevel || null,
      summary: result?.summary || null,
      error: latestReview?.reviewError || null,
      reviewedAt: result?.reviewedAt || latestReview?.reviewedAt || null,
      updatedAt: latestReview?.reviewLifecycle?.updatedAt || latestReview?.updatedAt || null,
    });

    res.json({
      success: true,
      review: result,
      branchReview: latestReview,
    });
  } catch (error) {
    reviewService.clearActiveBranchReviewRun?.(req.params.brId);
    if (lifecycleStarted) {
      const latestReview = await branchReviewService.getById(req.params.brId).catch(() => null);
      const latestWithLifecycle = attachBranchReviewLifecycle(latestReview);
      reviewService.events?.emit?.('branch-review-review-failed', {
        projectId: req.params.projectId,
        branchReviewId: req.params.brId,
        error: error.message || 'Failed to trigger review',
        updatedAt: latestWithLifecycle?.reviewLifecycle?.updatedAt || latestWithLifecycle?.updatedAt || null,
      });
    }
    console.error('Error triggering branch review:', error);
    res.status(500).json({ error: error.message || 'Failed to trigger review' });
  } finally {
    reviewService.clearActiveBranchReviewRun?.(req.params.brId);
  }
});

/**
 * POST /api/projects/:projectId/branch-reviews/:brId/review/queue
 * Queue an AI review for a branch review
 */
router.post('/:projectId/branch-reviews/:brId/review/queue', enforceQuotas, async (req, res) => {
  try {
    const { projectId, brId } = req.params;
    const {
      scope,
      reviewMode,
      resetSnapshot,
      policySource,
      partial,
      force,
      // CodeGraph experiment override (see /review route above for semantics).
      codegraphMcpEnabled,
    } = req.body || {};

    const project = await getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    let review = await branchReviewService.getById(brId);
    if (!review || review.projectId !== projectId) {
      return res.status(404).json({ error: 'Branch review not found' });
    }

    const currentWithLifecycle = attachBranchReviewLifecycle(review);
    const activeReviewState = getActiveBranchReviewState(brId);
    if (activeReviewState.entry || activeReviewState.runtime) {
      return res.json({
        success: true,
        alreadyRunning: true,
        position: activeReviewState.position,
        id: activeReviewState.entry?.id || activeReviewState.runtime?.queueId || null,
        branchReview: currentWithLifecycle,
      });
    }

    const projectPath = project.path;
    if (!projectPath) {
      return res.status(400).json({ error: 'Project has no local path — cannot queue review' });
    }

    if (isLastCommitBranchReviewScope(review) && typeof reviewService.refreshLatestBranchReviewHeadForRun === 'function') {
      review = await reviewService.refreshLatestBranchReviewHeadForRun(projectPath, review).catch(() => review) || review;
    }

    if (
      isLastCommitBranchReviewScope(review)
      && !parseBooleanFlag(force, false)
      && String(review.reviewStatus || '').trim().toLowerCase() === 'reviewed'
      && review.reviewHeadSha
      && review.headSha
      && review.reviewHeadSha === review.headSha
    ) {
      return res.json({
        success: true,
        alreadyReviewed: true,
        reason: 'no_unreviewed_commits',
        branchReview: attachBranchReviewLifecycle(review),
      });
    }

    await resetBranchReviewSnapshotIfRequested(review, parseBooleanFlag(resetSnapshot, false));

    const entry = reviewService.enqueueBranchReview(projectPath, brId, {
      scope,
      reviewMode,
      policySource,
      projectId,
      partial: partial === true,
      codegraphMcpEnabledOverride: typeof codegraphMcpEnabled === 'boolean' ? codegraphMcpEnabled : null,
    });

    res.json({
      success: true,
      position: entry.position,
      id: entry.id,
    });
  } catch (error) {
    console.error('Error queueing branch review:', error);
    res.status(500).json({ error: error.message || 'Failed to queue review' });
  }
});

/**
 * DELETE /api/projects/:projectId/branch-reviews/:brId
 * Delete a branch review and reset the branch to its initial review state.
 */
router.delete('/:projectId/branch-reviews/:brId', async (req, res) => {
  try {
    const { projectId, brId } = req.params;

    if (!isBranchReviewResetAllowed()) {
      return res.status(403).json({
        error: 'Branch review reset is only available in local and desktop environments.',
      });
    }

    const project = await getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const review = await branchReviewService.getById(brId);
    if (!review || review.projectId !== projectId) {
      return res.status(404).json({ error: 'Branch review not found' });
    }

    const activeReviewState = getActiveBranchReviewState(brId);
    const stoppableQueueId = activeReviewState.entry?.id || activeReviewState.runtime?.queueId || null;
    if (!stoppableQueueId && activeReviewState.runtime?.source === 'direct') {
      return res.status(409).json({
        error: 'Stop the active branch review before deleting it.',
        branchReview: attachBranchReviewLifecycle(review),
      });
    }

    let stopped = { stopped: false, was: null };
    if (stoppableQueueId) {
      stopped = await reviewService.stopReview(stoppableQueueId);
    }
    reviewService.clearActiveBranchReviewRun?.(brId);
    await reviewFixRunStore.deleteRuns({
      projectId,
      reviewType: 'branch_review',
      reviewId: brId,
    });

    const updatedReview = hasPersistedBranchReviewSnapshot(review)
      ? await branchReviewService.updateReview(brId, getClearedBranchReviewSnapshotFields())
      : review;

    res.json({
      success: true,
      deleted: true,
      branchReview: attachBranchReviewLifecycle(updatedReview),
      stopped,
    });
  } catch (error) {
    console.error('Error deleting branch review:', error);
    res.status(500).json({ error: error.message || 'Failed to delete branch review' });
  }
});

/**
 * DELETE /api/projects/:projectId/branch-reviews/:brId/review/queue
 * Stop a queued or running branch review
 */
router.delete('/:projectId/branch-reviews/:brId/review/queue', async (req, res) => {
  try {
    const { projectId, brId } = req.params;

    const project = await getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const activeReviewState = getActiveBranchReviewState(brId);
    const stoppableQueueId = activeReviewState.entry?.id || activeReviewState.runtime?.queueId || null;

    if (stoppableQueueId) {
      const result = await reviewService.stopReview(stoppableQueueId);
      await suppressAutoReviewAfterUserStop(
        brId,
        result,
        activeReviewState.entry?.autoReviewSnapshot || activeReviewState.runtime?.autoReviewSnapshot || null
      );
      return res.json({ success: true, ...result });
    }

    if (activeReviewState.runtime?.source === 'direct' && typeof reviewService.stopActiveBranchReviewRun === 'function') {
      const result = await reviewService.stopActiveBranchReviewRun(brId);
      await suppressAutoReviewAfterUserStop(brId, result, activeReviewState.runtime?.autoReviewSnapshot || null);
      return res.json({ success: true, ...result });
    }

    res.json({ success: true, stopped: false, was: null });
  } catch (error) {
    console.error('Error stopping branch review:', error);
    res.status(500).json({ error: error.message || 'Failed to stop review' });
  }
});

/**
 * PATCH /api/projects/:projectId/base-branch
 * Update the project's base branch
 */
router.patch('/:projectId/base-branch', enforceQuotas, async (req, res) => {
  const routeStartedAt = Date.now();
  const serverTiming = [];
  const withTiming = async (name, fn) => {
    const startedAt = Date.now();
    try {
      return await fn();
    } finally {
      serverTiming.push(`${name};dur=${Math.max(0, Date.now() - startedAt)}`);
    }
  };
  const applyServerTimingHeader = () => {
    if (res.headersSent) return;
    const metrics = [...serverTiming, `total;dur=${Math.max(0, Date.now() - routeStartedAt)}`];
    res.setHeader('Server-Timing', metrics.join(', '));
  };

  try {
    const { projectId } = req.params;
    const { baseBranch } = req.body;

    if (!baseBranch || typeof baseBranch !== 'string') {
      return res.status(400).json({ error: 'baseBranch is required' });
    }

    const project = await withTiming('load_project', () => getProjectById(projectId));
    if (!project) {
      applyServerTimingHeader();
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!checkOwnership(project, req)) {
      applyServerTimingHeader();
      return res.status(403).json({ error: 'Forbidden' });
    }

    const projectBranchReviews = await withTiming(
      'load_branch_reviews',
      () => branchReviewService.getByProject(projectId)
    );
    const activeReviewLock = await withTiming(
      'review_lock_check',
      () => getProjectBaseBranchChangeLock(projectId, project.path, projectBranchReviews)
    );
    if (activeReviewLock) {
      applyServerTimingHeader();
      return res.status(409).json({
        error: getBaseBranchChangeLockMessage(activeReviewLock),
        code: 'review_active',
        reviewType: activeReviewLock.type,
        reviewId: activeReviewLock.reviewId,
      });
    }

    // Validate the branch exists in the repo
    if (project.path) {
      const [localExists, remoteExists] = await withTiming(
        'validate_target_base',
        () => Promise.all([
          gitService.refExists(project.path, `refs/heads/${baseBranch}`),
          gitService.refExists(project.path, `refs/remotes/origin/${baseBranch}`),
        ])
      );
      if (!localExists && !remoteExists) {
        applyServerTimingHeader();
        return res.status(400).json({ error: `Branch '${baseBranch}' not found locally or on remote` });
      }
    }

    const previousBaseBranchDisplay = typeof project.base_branch_display === 'string'
      ? project.base_branch_display
      : null;
    const previousBaseBranchRef = typeof project.base_branch_ref === 'string'
      ? project.base_branch_ref
      : null;
    const watcherActive = gitWatcherService.isWatching(projectId);

    const seedActiveReviewsWithBaseBranch = async (targetBaseBranch, existingReviews = null) => {
      if (!project.path) return;
      const latestReviews = Array.isArray(existingReviews)
        ? existingReviews
        : await branchReviewService.getByProject(projectId);
      if (typeof branchReviewService.collapseDuplicateTrackedReviews === 'function') {
        await branchReviewService.collapseDuplicateTrackedReviews(projectId, latestReviews);
      }
      return Array.isArray(latestReviews)
        ? await Promise.all(latestReviews.map(async (review) => {
          // Pinned reviews (Phase 05) opt out of the project-wide base
          // cascade — the user deliberately overrode this review's base
          // and expects it to survive project-wide Change Base operations.
          if (review?.baseBranchSource === 'pinned') {
            return review;
          }
          if (review?.status !== 'active' || review?.baseBranch === targetBaseBranch) {
            return review;
          }
          await branchReviewService.updateReview(review.id, { base_branch: targetBaseBranch });
          return { ...review, baseBranch: targetBaseBranch };
        }))
        : latestReviews;
    };

    const reconcileBaseBranchChange = async (targetBaseBranch, existingReviews = null, options = {}) => {
      if (!project.path) return;
      const reviewsSeededWithNewBase = await seedActiveReviewsWithBaseBranch(targetBaseBranch, existingReviews);
      return reconcileBranchReviews(project.path, reviewsSeededWithNewBase, targetBaseBranch, options);
    };

    const reconcileBaseBranchChangeStrict = async (targetBaseBranch, existingReviews = null, options = {}) => {
      if (!project.path) return;
      const reviewsSeededWithNewBase = await seedActiveReviewsWithBaseBranch(targetBaseBranch, existingReviews);
      return reconcileBranchReviewsStrict(project.path, reviewsSeededWithNewBase, targetBaseBranch, options);
    };

    const backfillActiveReviewCommitMetadata = async (existingReviews = null) => {
      if (!project.path) return;
      const latestReviews = Array.isArray(existingReviews)
        ? existingReviews
        : await branchReviewService.getByProject(projectId);
      await enrichBranchReviewsCommitMetadata(project.path, latestReviews);
    };

    const syncWatcherBaseBranch = async (targetBaseBranch, { waitForSync = true } = {}) => {
      if (!watcherActive || !targetBaseBranch) return;
      await gitWatcherService.updateBaseBranch(projectId, targetBaseBranch);
      const syncPromise = Promise.resolve(gitWatcherService.syncNow(projectId)).catch((syncError) => {
        console.warn(`Failed to sync watcher after base branch update for project ${projectId}:`, syncError.message);
      });
      if (waitForSync) {
        await syncPromise;
      }
    };

    // Update project record first, then roll it back if follow-up reconciliation fails.
    await withTiming('persist_project_base', () => updateProject(projectId, {
      base_branch_display: baseBranch,
      base_branch_ref: `refs/heads/${baseBranch}`,
    }));

    let reconciledBranchReviews = projectBranchReviews;
    try {
      if (watcherActive) {
        await withTiming('persist_watcher_base', () => gitWatcherService.updateBaseBranch(projectId, baseBranch));
      }
      if (project.path) {
        reconciledBranchReviews = await withTiming(
          'reconcile_active_reviews',
          () => reconcileBaseBranchChangeStrict(baseBranch, projectBranchReviews, {
            includeCommitMetadata: false,
            allowEquivalentBaseReuse: true,
            allowStoredBaseHealing: false,
          })
        );
      }
    } catch (reconcileError) {
      try {
        await updateProject(projectId, {
          base_branch_display: previousBaseBranchDisplay,
          base_branch_ref: previousBaseBranchRef,
        });
        if (watcherActive && previousBaseBranchDisplay) {
          await gitWatcherService.updateBaseBranch(projectId, previousBaseBranchDisplay);
        }
        if (project.path && previousBaseBranchDisplay) {
          // Re-read persisted branch-review state before rollback. The forward
          // reconcile path may already have written the new base branch on one
          // or more active reviews, so reusing the stale pre-update snapshot
          // can incorrectly skip the rollback write.
          await reconcileBaseBranchChange(previousBaseBranchDisplay, null, {
            includeCommitMetadata: false,
            allowEquivalentBaseReuse: true,
            allowStoredBaseHealing: false,
          });
        }
      } catch (rollbackError) {
        console.error(
          `Failed to roll back base branch update for project ${projectId}:`,
          rollbackError
        );
      }
      throw reconcileError;
    }

    void Promise.resolve().then(async () => {
      try {
        await syncWatcherBaseBranch(baseBranch);
      } catch (backgroundError) {
        console.warn(`Background watcher sync failed for project ${projectId}:`, backgroundError?.message || backgroundError);
      }
      try {
        await backfillActiveReviewCommitMetadata(reconciledBranchReviews);
      } catch (backgroundError) {
        console.warn(`Background review metadata backfill failed for project ${projectId}:`, backgroundError?.message || backgroundError);
      }
    });

    applyServerTimingHeader();
    res.json({
      success: true,
      baseBranchDisplay: baseBranch,
      baseBranchRef: `refs/heads/${baseBranch}`,
    });
  } catch (error) {
    console.error('Error updating base branch:', error);
    applyServerTimingHeader();
    res.status(500).json({ error: 'Failed to update base branch' });
  }
});

/**
 * POST /api/projects/:projectId/branches/review
 * Create or update a reviewable branch review for a selected local branch.
 *
 * This is intentionally on-demand: the branch list route remains a cheap
 * discovery/read path, and the heavier diff/fork-point recovery work only
 * runs after the user chooses a branch to review.
 */
router.post('/:projectId/branches/review', enforceQuotas, async (req, res) => {
  try {
    const { projectId } = req.params;
    const branchName = String(req.body?.branchName || '').trim();
    const diffScope = normalizeBranchReviewDiffScope(req.body?.diffScope);
    const project = await getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!project.path) {
      return res.status(400).json({ error: 'Project has no local path', reason: 'missing_project_path' });
    }
    if (!branchName || branchName === 'HEAD') {
      return res.status(400).json({ error: 'branchName is required', reason: 'invalid_branch' });
    }

    const preferredBaseBranch = project.base_branch_display || null;
    if (preferredBaseBranch && branchName === preferredBaseBranch && diffScope !== 'last_commit') {
      return res.status(409).json({
        error: 'Base branch is not reviewable as a branch review',
        reason: 'base_branch',
        branchName,
        baseBranch: preferredBaseBranch,
      });
    }

    const branchRef = `refs/heads/${branchName}`;
    const branchExists = await gitService.refExists(project.path, branchRef).catch(() => false);
    if (!branchExists) {
      return res.status(404).json({
        error: 'Local branch was not found',
        reason: 'branch_not_found',
        branchName,
      });
    }

    const existingReview = await branchReviewService.getByBranch(projectId, branchName, {
      statuses: ['active', 'stale'],
    });
    const [localBranches, worktrees] = await Promise.all([
      gitService.listBranches(project.path).catch(() => []),
      listProjectWorktrees(project.path),
    ]);
    const branchMetadata = Array.isArray(localBranches)
      ? localBranches.find((branch) => String(branch?.name || '').trim() === branchName)
      : null;
    const worktreeMap = buildWorktreeMap(worktrees);
    const isWorktree = worktreeMap.has(branchName);
    const isCurrent = Boolean(branchMetadata?.current) && !isWorktree;

    if (diffScope === 'last_commit') {
      const diffStats = await computeLastCommitBranchDiffStats(project.path, branchName);
      if (!diffStats) {
        return res.status(409).json({
          error: 'Unable to compute latest commit diff for this branch',
          reason: 'last_commit_diff_unavailable',
          branchName,
        });
      }
      if (Number(diffStats.fileCount || 0) === 0) {
        return res.status(409).json({
          error: 'Latest commit has no reviewable diff',
          reason: 'no_reviewable_diff',
          branchName,
          baseBranch: buildLastCommitBaseBranch(branchName),
        });
      }

      const lastCommitBaseBranch = buildLastCommitBaseBranch(branchName);
      let branchReview;
      if (existingReview) {
        const preservedPinnedBase = existingReview.baseBranchSource === 'pinned'
          && typeof existingReview.baseBranch === 'string'
          && existingReview.baseBranch.trim()
          && existingReview.baseBranch.trim() !== branchName
          ? existingReview.baseBranch.trim()
          : null;
        branchReview = await branchReviewService.updateReview(existingReview.id, {
          base_branch: lastCommitBaseBranch,
          base_branch_source: 'last_commit',
          ...(preservedPinnedBase ? { review_base_branch: preservedPinnedBase } : {}),
          merge_base_sha: diffStats.mergeBaseSha,
          fork_point_sha: diffStats.forkPointSha,
          head_sha: diffStats.headSha,
          status: 'active',
          ...(isCurrent ? { is_current: 1 } : {}),
          file_count: diffStats.fileCount,
          total_additions: diffStats.totalAdditions,
          total_deletions: diffStats.totalDeletions,
          commit_count: diffStats.commitCount,
          first_commit_at: diffStats.firstCommitAt,
          last_commit_at: diffStats.lastCommitAt,
        }) || existingReview;
      } else {
        branchReview = await branchReviewService.create({
          projectId,
          branchName,
          baseBranch: lastCommitBaseBranch,
          baseBranchSource: 'last_commit',
          mergeBaseSha: diffStats.mergeBaseSha,
          forkPointSha: diffStats.forkPointSha,
          headSha: diffStats.headSha,
          stats: diffStats,
          isCurrent,
        });
      }

      if (isCurrent) {
        await branchReviewService.setCurrentBranch(projectId, branchReview.id);
        branchReview = await branchReviewService.getById(branchReview.id).catch(() => branchReview) || branchReview;
      }

      const decorated = attachForkPointRecovery(
        attachWorktreeMetadata(
          attachBranchReviewLifecycle(branchReview),
          worktreeMap,
        )
      );

      reviewService.events.emit('branch-review-update', {
        projectId,
        type: existingReview ? 'updated' : 'created',
        branchReview: decorated,
      });

      return res.json({
        success: true,
        branchReview: decorated,
      });
    }

    const pinnedBaseBranch = (() => {
      if (!existingReview) return null;
      const candidate = existingReview.baseBranchSource === 'pinned'
        ? existingReview.baseBranch
        : existingReview.baseBranchSource === 'last_commit'
          ? existingReview.reviewBaseBranch
          : null;
      return typeof candidate === 'string'
        && candidate.trim()
        && candidate.trim() !== branchName
        ? candidate.trim()
        : null;
    })();
    const pinnedBaseRef = pinnedBaseBranch
      ? await resolveLocalReviewBaseRef(project.path, pinnedBaseBranch)
      : null;
    const preservingPinnedBase = Boolean(pinnedBaseRef?.baseRef);
    const resolvedBase = preservingPinnedBase
      ? pinnedBaseRef
      : await resolveOnDemandBranchBase(
          project.path,
          branchName,
          preferredBaseBranch,
          projectId,
        );
    const { baseBranch, baseRef } = resolvedBase;
    if (!baseBranch || !baseRef) {
      return res.status(409).json({
        error: 'No base branch could be resolved for this branch',
        reason: 'base_not_found',
        branchName,
      });
    }
    if (baseBranch === branchName) {
      return res.status(409).json({
        error: 'Base branch is not reviewable as a branch review',
        reason: 'base_branch',
        branchName,
        baseBranch,
      });
    }

    const diffStats = await computeOnDemandBranchDiffStats(project.path, baseRef, branchName);
    if (!diffStats) {
      return res.status(409).json({
        error: 'Unable to compute a branch diff for this branch',
        reason: 'diff_unavailable',
        branchName,
        baseBranch,
      });
    }

    let forkPointSha = await resolvePreservedForkPointSha({
      projectPath: project.path,
      existingForkPointSha: existingReview?.forkPointSha,
      nextMergeBaseSha: diffStats.mergeBaseSha,
      nextHeadSha: diffStats.headSha,
      gitService,
    });
    let effectiveStats = await resolveEffectiveDiffStats({
      projectPath: project.path,
      branchName,
      diffStats,
      forkPointSha,
      gitService,
    });

    if (Number(effectiveStats?.fileCount || 0) === 0) {
      const recovered = await recoverOnDemandForkPoint(
        project.path,
        baseBranch,
        baseRef,
        branchName,
        diffStats,
      );
      if (recovered) {
        forkPointSha = recovered.forkPointSha;
        effectiveStats = recovered.stats;
      }
    }

    if (Number(effectiveStats?.fileCount || 0) === 0) {
      return res.status(409).json({
        error: 'Branch has no reviewable diff against its base branch',
        reason: 'no_reviewable_diff',
        branchName,
        baseBranch,
        forkPointRecovery: classifyForkPointRecovery({
          forkPointSha,
          mergeBaseSha: diffStats.mergeBaseSha,
          headSha: diffStats.headSha,
        }),
      });
    }

    let branchReview;
    if (existingReview) {
      branchReview = await branchReviewService.updateReview(existingReview.id, {
        base_branch: baseBranch,
        ...(preservingPinnedBase
          ? { base_branch_source: 'pinned' }
          : existingReview.baseBranchSource === 'pinned' || isLastCommitBranchReviewScope(existingReview)
            ? { base_branch_source: 'inferred' }
            : {}),
        merge_base_sha: diffStats.mergeBaseSha,
        fork_point_sha: forkPointSha,
        head_sha: diffStats.headSha,
        status: 'active',
        ...(isCurrent ? { is_current: 1 } : {}),
        file_count: effectiveStats.fileCount,
        total_additions: effectiveStats.totalAdditions,
        total_deletions: effectiveStats.totalDeletions,
        commit_count: effectiveStats.commitCount,
        first_commit_at: effectiveStats.firstCommitAt,
        last_commit_at: effectiveStats.lastCommitAt,
      }) || existingReview;
    } else {
      branchReview = await branchReviewService.create({
        projectId,
        branchName,
        baseBranch,
        baseBranchSource: 'inferred',
        mergeBaseSha: diffStats.mergeBaseSha,
        forkPointSha,
        headSha: diffStats.headSha,
        stats: effectiveStats,
        isCurrent,
      });
    }

    if (isCurrent) {
      await branchReviewService.setCurrentBranch(projectId, branchReview.id);
      branchReview = await branchReviewService.getById(branchReview.id).catch(() => branchReview) || branchReview;
    }

    const decorated = attachForkPointRecovery(
      attachWorktreeMetadata(
        attachBranchReviewLifecycle(branchReview),
        worktreeMap,
      )
    );

    reviewService.events.emit('branch-review-update', {
      projectId,
      type: existingReview ? 'updated' : 'created',
      branchReview: decorated,
    });

    res.json({
      success: true,
      branchReview: decorated,
    });
  } catch (error) {
    console.error('Error ensuring branch review:', error);
    res.status(500).json({ error: 'Failed to prepare branch review' });
  }
});

/**
 * GET /api/projects/:projectId/branches/last-commit-preview?branchName=x
 * Return lightweight metadata for the latest commit on a branch without
 * creating a persisted branch review.
 */
router.get('/:projectId/branches/last-commit-preview', async (req, res) => {
  try {
    const { projectId } = req.params;
    const branchName = String(req.query.branchName || '').trim();
    const project = await getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!project.path) {
      return res.status(400).json({ error: 'Project has no local path', reason: 'missing_project_path' });
    }
    if (!branchName || branchName === 'HEAD') {
      return res.status(400).json({ error: 'branchName is required', reason: 'invalid_branch' });
    }

    const branchRef = `refs/heads/${branchName}`;
    const branchExists = await gitService.refExists(project.path, branchRef).catch(() => false);
    if (!branchExists) {
      return res.status(404).json({
        error: 'Local branch was not found',
        reason: 'branch_not_found',
        branchName,
      });
    }

    const stats = await computeLastCommitBranchDiffStats(project.path, branchName);
    if (!stats) {
      return res.status(409).json({
        error: 'Unable to compute latest commit diff for this branch',
        reason: 'last_commit_diff_unavailable',
        branchName,
      });
    }

    return res.json({
      success: true,
      preview: {
        branchName,
        baseBranch: buildLastCommitBaseBranch(branchName),
        ...stats,
      },
    });
  } catch (error) {
    console.error('Error loading last commit preview:', error);
    res.status(500).json({ error: 'Failed to load last commit preview' });
  }
});

/**
 * GET /api/projects/:projectId/branches
 * List local branches for the project repo (used by Change Base dropdown)
 */
router.get('/:projectId/branches', async (req, res) => {
  try {
    const { projectId } = req.params;
    const reviewableOnly = String(req.query.reviewableOnly || '').trim() === '1';
    const project = await getProjectById(projectId);
    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (!checkOwnership(project, req)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (!project.path) {
      return res.json({ success: true, branches: [] });
    }

    const [branches, worktrees] = await Promise.all([
      gitService.listBranches(project.path),
      listProjectWorktrees(project.path),
    ]);
    const worktreeMap = buildWorktreeMap(worktrees);
    const preferredBaseBranch = project.base_branch_display || null;
    const enrichedBranches = await mapWithConcurrency((Array.isArray(branches) ? branches : []), 8, async (branch) => {
      const branchName = String(branch?.name || '').trim();
      const metadata = worktreeMap.get(branchName);
      let aheadCount = null;
      if (preferredBaseBranch && branchName && branchName !== preferredBaseBranch) {
        try {
          const rawAhead = await gitService
            .getGitInstance(project.path)
            .raw(['rev-list', '--count', `${preferredBaseBranch}..${branchName}`]);
          const parsed = Number.parseInt(String(rawAhead || '').trim(), 10);
          aheadCount = Number.isFinite(parsed) ? parsed : null;
        } catch {
          aheadCount = null;
        }
      }
      return {
        ...branch,
        aheadCount,
        isWorktree: Boolean(metadata),
        worktreePath: metadata?.worktreePath || null,
        worktreeName: metadata?.worktreeName || null,
        worktreeHead: metadata?.worktreeHead || null,
      };
    });

    const filteredBranches = reviewableOnly
      ? await mapWithConcurrency(enrichedBranches, 4, async (branch) => {
        const branchName = String(branch?.name || '').trim();
        if (!branchName) return null;
        if (branch.current || branch.isWorktree) return branch;
        try {
          const inferredBaseBranch = await gitService.inferBaseBranch(project.path, branchName, {
            preferredBaseBranch,
          });
          if (!inferredBaseBranch || inferredBaseBranch === branchName) {
            return branch;
          }
          const mergeBaseSha = await gitService.getMergeBase(project.path, branchName, inferredBaseBranch);
          const diffStats = await gitService.getThreeDotDiffStats(project.path, mergeBaseSha, branchName);
          return diffStats.fileCount > 0 ? branch : null;
        } catch {
          // Best-effort filter: if we cannot determine reviewability, keep the branch visible.
          return branch;
        }
      }).then((items) => items.filter(Boolean))
      : enrichedBranches;
    res.json({ success: true, branches: filteredBranches });
  } catch (error) {
    console.error('Error listing branches:', error);
    res.status(500).json({ error: 'Failed to list branches' });
  }
});

export default router;
