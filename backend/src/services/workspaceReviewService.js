import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';

import gitService from './gitService.js';
import { getProjectStoragePath } from './atlasProjectStorageService.js';
import { assignReviewFindingIds } from './review/reviewFindingIds.js';
import { buildReviewActionEligibility, buildReviewLifecycle } from '../utils/reviewLifecycle.js';
import { readJsonFileWithRetry, writeJsonFileAtomic } from '../utils/jsonFile.js';
import { getVisibleReviewFileLimit, selectVisibleReviewFiles, summarizeVisibleReviewFiles } from '../utils/reviewFileSelection.js';

const STATE_VERSION = 1;
const DISPLAY_ID_PREFIX = 'WS';
const projectStateLocks = new Map();
const VALID_REVIEW_UPDATE_FIELDS = new Set([
  'reviewStatus',
  'reviewRiskLevel',
  'reviewSummary',
  'reviewError',
  'reviewJson',
  'reviewedAt',
  'reviewHeadSha',
  'reviewSnapshotKey',
]);

function nowIso() {
  return new Date().toISOString();
}

function normalizeBranchName(value) {
  return String(value || '').trim();
}

function normalizePathValue(value) {
  const normalized = String(value || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
  if (!normalized) return '';
  const segments = normalized.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    return '';
  }
  return segments.join('/');
}

function buildWorkspaceReviewId(branchName) {
  const normalized = normalizeBranchName(branchName).toLowerCase();
  return `wr-${createHash('sha1').update(normalized).digest('hex').slice(0, 12)}`;
}

function buildWorkspaceReviewDisplayId(branchName) {
  const normalized = normalizeBranchName(branchName)
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase();
  const suffix = normalized ? normalized.slice(0, 24) : 'CURRENT';
  return `${DISPLAY_ID_PREFIX}-${suffix}`;
}

function getStatePath(projectPath) {
  return getProjectStoragePath(projectPath, 'workspace-reviews.json');
}

async function ensureStateDir(projectPath) {
  await fs.mkdir(path.dirname(getStatePath(projectPath)), { recursive: true });
}

async function loadState(projectPath) {
  try {
    const loaded = await readJsonFileWithRetry(getStatePath(projectPath));
    if (!loaded || typeof loaded !== 'object') {
      return { version: STATE_VERSION, reviews: [] };
    }
    return {
      version: STATE_VERSION,
      reviews: Array.isArray(loaded.reviews) ? loaded.reviews : [],
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { version: STATE_VERSION, reviews: [] };
    }
    throw error;
  }
}

async function saveState(projectPath, state) {
  await ensureStateDir(projectPath);
  await writeJsonFileAtomic(getStatePath(projectPath), {
    version: STATE_VERSION,
    reviews: Array.isArray(state?.reviews) ? state.reviews : [],
    updatedAt: nowIso(),
  });
}

async function withProjectStateLock(projectPath, callback) {
  const lockKey = path.resolve(projectPath);
  const previousTail = projectStateLocks.get(lockKey) || Promise.resolve();
  let release;
  const nextTail = new Promise((resolve) => {
    release = resolve;
  });
  const lockTail = previousTail.catch(() => {}).then(() => nextTail);
  projectStateLocks.set(lockKey, lockTail);
  await previousTail.catch(() => {});
  try {
    return await callback();
  } finally {
    release();
    if (projectStateLocks.get(lockKey) === lockTail) {
      projectStateLocks.delete(lockKey);
    }
  }
}

function countTextLines(value) {
  if (typeof value !== 'string' || value.length === 0) return 0;
  return value.split('\n').length;
}

async function readWorkspaceFile(projectPath, relativePath) {
  const normalizedPath = normalizePathValue(relativePath);
  if (!normalizedPath) return null;
  const absoluteProjectPath = path.resolve(projectPath);
  const absolutePath = path.resolve(absoluteProjectPath, normalizedPath);
  if (absolutePath !== absoluteProjectPath && !absolutePath.startsWith(`${absoluteProjectPath}${path.sep}`)) {
    return null;
  }
  try {
    const buffer = await fs.readFile(absolutePath);
    if (buffer.includes(0)) return null;
    return buffer.toString('utf8');
  } catch (error) {
    // `git status` can report untracked directories (e.g. `?? .claude/`) as
    // single entries. Treat directories and missing files as "no content"
    // instead of crashing the whole workspace review load.
    if (error?.code === 'ENOENT' || error?.code === 'EISDIR') return null;
    throw error;
  }
}

function hashContent(value) {
  if (value == null) return null;
  return createHash('sha1').update(value).digest('hex');
}

function buildSnapshotKey(files) {
  const normalized = Array.isArray(files)
    ? files.map((file) => ({
        path: normalizePathValue(file.path),
        oldPath: file.oldPath ? normalizePathValue(file.oldPath) : null,
        status: String(file.status || '').trim().toUpperCase() || 'M',
        beforeHash: file.beforeHash || null,
        afterHash: file.afterHash || null,
      }))
    : [];
  return createHash('sha1').update(JSON.stringify(normalized)).digest('hex');
}

async function getFileStatSummary(projectPath, headSha, file) {
  if (!headSha || file.status === 'A') {
    const additions = countTextLines(file.after);
    return { additions, deletions: 0 };
  }

  try {
    const git = gitService.getGitInstance(projectPath);
    const pathArgs = [];
    if (file.path) pathArgs.push(file.path);
    if (file.oldPath && file.oldPath !== file.path) pathArgs.push(file.oldPath);
    const raw = await git.raw([
      'diff',
      '--numstat',
      '--find-renames',
      headSha,
      '--',
      ...pathArgs,
    ]);
    const line = String(raw || '').trim().split('\n').find(Boolean);
    if (!line) {
      const beforeLines = countTextLines(file.before);
      const afterLines = countTextLines(file.after);
      if (file.status === 'D') {
        return { additions: 0, deletions: beforeLines };
      }
      return {
        additions: Math.max(0, afterLines - beforeLines),
        deletions: Math.max(0, beforeLines - afterLines),
      };
    }
    const [additionsRaw, deletionsRaw] = line.split('\t');
    const additions = additionsRaw === '-' ? 0 : Math.max(0, Number(additionsRaw) || 0);
    const deletions = deletionsRaw === '-' ? 0 : Math.max(0, Number(deletionsRaw) || 0);
    return { additions, deletions };
  } catch {
    const beforeLines = countTextLines(file.before);
    const afterLines = countTextLines(file.after);
    if (file.status === 'D') {
      return { additions: 0, deletions: beforeLines };
    }
    return {
      additions: Math.max(0, afterLines - beforeLines),
      deletions: Math.max(0, beforeLines - afterLines),
    };
  }
}

function normalizeWorkingTreeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const filePath = normalizePathValue(entry.path);
  if (!filePath) return null;
  const oldPath = entry.oldPath ? normalizePathValue(entry.oldPath) : null;
  const rawStatus = String(entry.status || '').trim().toUpperCase();
  const status = rawStatus === 'A' || rawStatus === 'D' || rawStatus === 'R' ? rawStatus : 'M';
  return {
    path: filePath,
    oldPath: oldPath && oldPath !== filePath ? oldPath : null,
    status,
  };
}

async function buildWorkspaceFiles(projectPath, headSha, includeContent = false) {
  const rawEntries = await gitService.getWorkingTreeEntries(projectPath);
  const entries = rawEntries
    .map(normalizeWorkingTreeEntry)
    .filter(Boolean);

  const files = [];
  for (const entry of entries) {
    const beforePath = entry.oldPath || entry.path;
    const before = headSha && entry.status !== 'A'
      ? await gitService.getFileAtRef(projectPath, headSha, beforePath)
      : null;
    const after = entry.status !== 'D'
      ? await readWorkspaceFile(projectPath, entry.path)
      : null;
    const statSummary = await getFileStatSummary(projectPath, headSha, {
      ...entry,
      before,
      after,
    });
    files.push({
      path: entry.path,
      oldPath: entry.oldPath,
      status: entry.status,
      additions: statSummary.additions,
      deletions: statSummary.deletions,
      beforeHash: hashContent(before),
      afterHash: hashContent(after),
      ...(includeContent ? { before, after, patch: null } : {}),
    });
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function attachWorkspaceLifecycle(review, {
  isSnapshotStale,
  runtimeState = null,
} = {}) {
  const reviewStatus = review?.reviewStatus || 'none';
  const reviewError = review?.reviewError || null;
  const reviewedAt = review?.reviewedAt || null;
  const updatedAt = review?.updatedAt || null;
  const lifecycle = runtimeState
    ? buildReviewLifecycle({
        reviewStatus: 'reviewing',
        sourceStatus: 'reviewing',
        errorMessage: null,
        reviewedAt,
        updatedAt: runtimeState.updatedAt || updatedAt,
        progress: runtimeState.progress || {
          phase: 'running',
          updatedAt: runtimeState.updatedAt || updatedAt || nowIso(),
        },
      })
    : buildReviewLifecycle({
        reviewStatus,
        sourceStatus: reviewStatus,
        errorMessage: reviewError,
        reviewedAt,
        updatedAt,
      });

  const reviewActionEligibility = buildReviewActionEligibility(
    {
      headSha: review?.headSha || null,
      reviewHeadSha: isSnapshotStale ? review?.reviewHeadSha || null : review?.headSha || null,
      baseBranch: review?.baseBranch || null,
      reviewBaseBranch: review?.baseBranch || null,
      mergeBaseSha: review?.snapshotKey || null,
      reviewMergeBaseSha: review?.reviewSnapshotKey || review?.snapshotKey || null,
    },
    lifecycle
  );

  if (isSnapshotStale) {
    reviewActionEligibility.canApprove = false;
    reviewActionEligibility.canRequestChanges = false;
    reviewActionEligibility.staleReason = 'workspace_snapshot_mismatch';
    reviewActionEligibility.blockedReason = 'Workspace changed since the last review. Re-run review to validate the current files.';
    reviewActionEligibility.approveBlockedReason = reviewActionEligibility.blockedReason;
    reviewActionEligibility.requestChangesBlockedReason = reviewActionEligibility.blockedReason;
  }

  return {
    ...review,
    reviewLifecycle: lifecycle,
    reviewActionEligibility,
  };
}

function findRecordByBranch(state, branchName) {
  return Array.isArray(state?.reviews)
    ? state.reviews.find((entry) => normalizeBranchName(entry.branchName) === normalizeBranchName(branchName)) || null
    : null;
}

function findRecordById(state, reviewId) {
  return Array.isArray(state?.reviews)
    ? state.reviews.find((entry) => String(entry.id || '').trim() === String(reviewId || '').trim()) || null
    : null;
}

function normalizeStoredReviewJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return assignReviewFindingIds(value);
  if (typeof value !== 'string') return null;
  try {
    return assignReviewFindingIds(JSON.parse(value));
  } catch {
    return null;
  }
}

function toWorkspaceReviewRecord(record, runtime = {}) {
  return {
    id: record.id,
    projectId: record.projectId,
    displayId: record.displayId,
    branchName: record.branchName,
    baseBranch: record.baseBranch,
    status: 'active',
    isCurrent: true,
    fileCount: runtime.fileCount ?? 0,
    totalAdditions: runtime.totalAdditions ?? 0,
    totalDeletions: runtime.totalDeletions ?? 0,
    commitCount: 0,
    headSha: runtime.headSha || null,
    snapshotKey: runtime.snapshotKey || null,
    reviewSnapshotKey: record.reviewSnapshotKey || null,
    reviewStatus: record.reviewStatus || 'none',
    reviewRiskLevel: record.reviewRiskLevel || null,
    reviewSummary: record.reviewSummary || null,
    reviewError: record.reviewError || null,
    reviewJson: normalizeStoredReviewJson(record.reviewJson),
    reviewedAt: record.reviewedAt || null,
    reviewHeadSha: record.reviewHeadSha || null,
    createdAt: record.createdAt,
    updatedAt: runtime.updatedAt || record.updatedAt || record.createdAt,
    ...(Array.isArray(runtime.files) ? { files: runtime.files } : {}),
  };
}

async function resolveCurrentWorkspaceReview(projectPath, {
  projectId,
  baseBranch = null,
  includeContent = false,
  runtimeState = null,
  visibleFileLimit = getVisibleReviewFileLimit(),
} = {}) {
  const branchName = await gitService.getCurrentBranchName(projectPath).catch(() => null);
  if (!branchName || branchName === 'HEAD') return null;

  const hasUncommittedChanges = await gitService.hasUncommittedChanges(projectPath).catch(() => false);
  if (!hasUncommittedChanges) return null;

  const headSha = await gitService.getCurrentSHA(projectPath).catch(() => null);
  const files = await buildWorkspaceFiles(projectPath, headSha, includeContent);
  if (files.length === 0) return null;

  const snapshotKey = buildSnapshotKey(files);
  const totalAdditions = files.reduce((sum, file) => sum + Math.max(0, Number(file.additions) || 0), 0);
  const totalDeletions = files.reduce((sum, file) => sum + Math.max(0, Number(file.deletions) || 0), 0);
  const timestamp = nowIso();
  const record = await withProjectStateLock(projectPath, async () => {
    const state = await loadState(projectPath);
    let nextRecord = findRecordByBranch(state, branchName);
    let mutated = false;

    if (!nextRecord) {
      mutated = true;
      nextRecord = {
        id: buildWorkspaceReviewId(branchName),
        projectId: projectId || null,
        displayId: buildWorkspaceReviewDisplayId(branchName),
        branchName,
        baseBranch: baseBranch || null,
        reviewStatus: 'none',
        reviewRiskLevel: null,
        reviewSummary: null,
        reviewError: null,
        reviewJson: null,
        reviewedAt: null,
        reviewHeadSha: null,
        reviewSnapshotKey: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      state.reviews.push(nextRecord);
    }

    if (projectId && nextRecord.projectId !== projectId) {
      nextRecord.projectId = projectId;
      mutated = true;
    }
    if ((baseBranch || null) !== (nextRecord.baseBranch || null)) {
      nextRecord.baseBranch = baseBranch || null;
      mutated = true;
    }
    if (mutated) {
      nextRecord.updatedAt = timestamp;
      await saveState(projectPath, state);
    }
    return { ...nextRecord };
  });

  const review = toWorkspaceReviewRecord(record, {
    files,
    fileCount: files.length,
    totalAdditions,
    totalDeletions,
    headSha,
    snapshotKey,
    updatedAt: timestamp,
  });

  const cappedFiles = Number.isFinite(Number(visibleFileLimit)) && Number(visibleFileLimit) > 0
    ? selectVisibleReviewFiles(review.files || [], review, Number(visibleFileLimit))
    : (review.files || []);
  review.files = cappedFiles;
  review.diffManifestSummary = Number.isFinite(Number(visibleFileLimit)) && Number(visibleFileLimit) > 0
    ? summarizeVisibleReviewFiles(cappedFiles, files.length, Number(visibleFileLimit))
    : summarizeVisibleReviewFiles(cappedFiles, files.length);

  return attachWorkspaceLifecycle(review, {
    isSnapshotStale: Boolean(record.reviewSnapshotKey && record.reviewSnapshotKey !== snapshotKey),
    runtimeState,
  });
}

async function updateReview(projectPath, workspaceReviewId, updates = {}) {
  return withProjectStateLock(projectPath, async () => {
    const state = await loadState(projectPath);
    const record = findRecordById(state, workspaceReviewId);
    if (!record) {
      throw new Error('Workspace review not found');
    }
    let changed = false;
    for (const [key, value] of Object.entries(updates || {})) {
      if (!VALID_REVIEW_UPDATE_FIELDS.has(key)) continue;
      record[key] = value;
      changed = true;
    }
    if (changed) {
      record.updatedAt = nowIso();
      await saveState(projectPath, state);
    }
    return { ...record };
  });
}

export default {
  async list(projectPath, options = {}) {
    const current = await resolveCurrentWorkspaceReview(projectPath, options);
    return current ? [current] : [];
  },

  async getCurrent(projectPath, options = {}) {
    return resolveCurrentWorkspaceReview(projectPath, options);
  },

  async getById(projectPath, workspaceReviewId, options = {}) {
    const current = await resolveCurrentWorkspaceReview(projectPath, options);
    if (!current) return null;
    return current.id === workspaceReviewId ? current : null;
  },

  async updateReview(projectPath, workspaceReviewId, updates = {}) {
    return updateReview(projectPath, workspaceReviewId, updates);
  },

  __testing: {
    buildWorkspaceReviewId,
    buildWorkspaceReviewDisplayId,
    buildSnapshotKey,
    normalizeWorkingTreeEntry,
    normalizePathValue,
    readWorkspaceFile,
    getStatePath,
    loadState,
  },
};
