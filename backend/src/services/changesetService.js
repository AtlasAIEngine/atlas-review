/**
 * ChangeSet Service
 * Manages change sets for tracking file modifications
 * Stores runtime changeset metadata in Atlas app data, keyed by project path.
 */

import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { detectLanguage } from './diffService.js';
import projectVerificationService from './projectVerificationService.js';
import gitService from './gitService.js';
import { EMPTY_FILE_RISK_FLAGS, inferFileRiskFlags } from './review/riskFlagHeuristics.js';
import { getProjectStoragePath } from './atlasProjectStorageService.js';
import { readJsonFileWithRetry, writeJsonFileAtomic } from '../utils/jsonFile.js';

const INTERRUPTED_REVIEW_RECOVERY_MESSAGE = 'Review interrupted after app restart. Please run Review Now again.';
const INTERRUPTED_REVIEW_STATUSES = new Set(['queued', 'reviewing', 'running', 'retrying']);

/**
 * Ensure the changesets directory exists for a project
 * @param {string} projectPath - Path to the project
 * @returns {Promise<string>} - Path to the changesets directory
 */
async function ensureChangesetsDir(projectPath) {
  const changesetsDir = getProjectStoragePath(projectPath, 'changesets');
  await fs.mkdir(changesetsDir, { recursive: true });
  return changesetsDir;
}

/**
 * Get the path to the counter file for generating display IDs
 * @param {string} projectPath - Path to the project
 * @returns {string} - Path to the counter file
 */
function getCounterPath(projectPath) {
  return getProjectStoragePath(projectPath, 'changesets', 'counter.json');
}

/**
 * Get the next display ID for a changeset (e.g., CS-001, CS-002, etc.)
 * @param {string} projectPath - Path to the project
 * @returns {Promise<string>} - The next display ID
 */
async function getNextDisplayId(projectPath) {
  await ensureChangesetsDir(projectPath);
  const counterPath = getCounterPath(projectPath);

  let counter = 0;
  try {
    const data = await readJsonFileWithRetry(counterPath);
    const parsedCounter = Number(data?.counter);
    counter = Number.isFinite(parsedCounter) ? parsedCounter : 0;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
    // Counter file doesn't exist yet, start from 0
  }

  // Increment counter
  counter += 1;

  // Save updated counter
  await writeJsonFileAtomic(counterPath, { counter, updatedAt: new Date().toISOString() });

  // Format as CS-XXX (padded to 3 digits)
  return `CS-${String(counter).padStart(3, '0')}`;
}

/**
 * Get the path to the changesets index file
 * @param {string} projectPath - Path to the project
 * @returns {string} - Path to the index file
 */
function getIndexPath(projectPath) {
  return getProjectStoragePath(projectPath, 'changesets.json');
}

export function getChangeSetFilePath(projectPath, changesetId) {
  return getProjectStoragePath(projectPath, 'changesets', `${changesetId}.json`);
}

export function getChangeSetIndexPath(projectPath) {
  return getIndexPath(projectPath);
}

function getLegacyChangeSetFilePath(projectPath, changesetId) {
  return path.join(projectPath, '.atlas', 'changesets', `${changesetId}.json`);
}

function getLegacyChangeSetIndexPath(projectPath) {
  return path.join(projectPath, '.atlas', 'changesets.json');
}

/**
 * Normalize commit SHA values that may be persisted in legacy/object form.
 * @param {unknown} rawCommitSha
 * @returns {string|null}
 */
function normalizeCommitSha(rawCommitSha) {
  if (typeof rawCommitSha === 'string') {
    const trimmed = rawCommitSha.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (rawCommitSha && typeof rawCommitSha === 'object') {
    const nestedCommitSha = rawCommitSha.commitSha;
    if (typeof nestedCommitSha === 'string') {
      const trimmed = nestedCommitSha.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
  }

  return null;
}

function normalizeVerificationStatus(value) {
  return ['pass', 'fail', 'not_run'].includes(value) ? value : 'not_run';
}

function createEmptyVerificationState() {
  return {
    lint: 'not_run',
    unit: 'not_run',
    e2e: 'not_run',
    lastRunAt: null,
    logs: {},
    checks: {},
  };
}

function recomputeLegacyVerificationFields(verification) {
  const checks = verification?.checks && typeof verification.checks === 'object'
    ? Object.values(verification.checks)
    : [];
  const logs = verification?.logs && typeof verification.logs === 'object'
    ? verification.logs
    : {};

  const summarizeKind = (kind) => {
    const matchingChecks = checks.filter((check) => check?.kind === kind);
    if (matchingChecks.length === 0) {
      return {
        status: normalizeVerificationStatus(verification?.[kind]),
        log: typeof logs?.[kind] === 'string' ? logs[kind] : undefined,
      };
    }

    const statuses = matchingChecks.map((check) => normalizeVerificationStatus(check?.status));
    const status = statuses.includes('fail')
      ? 'fail'
      : statuses.length > 0 && statuses.every((entry) => entry === 'pass')
        ? 'pass'
        : 'not_run';

    const failingCheck = matchingChecks.find((check) => normalizeVerificationStatus(check?.status) === 'fail');
    const mostRecentCheck = [...matchingChecks]
      .sort((a, b) => String(b?.lastRunAt || '').localeCompare(String(a?.lastRunAt || '')))[0];
    const logKey = failingCheck?.id || mostRecentCheck?.id || kind;
    const log = typeof logs?.[logKey] === 'string'
      ? logs[logKey]
      : (typeof logs?.[kind] === 'string' ? logs[kind] : undefined);
    return { status, log };
  };

  const lint = summarizeKind('lint');
  const unit = summarizeKind('unit');
  const e2e = summarizeKind('e2e');

  verification.lint = lint.status;
  verification.unit = unit.status;
  verification.e2e = e2e.status;
  verification.logs = {
    ...logs,
    ...(lint.log ? { lint: lint.log } : {}),
    ...(unit.log ? { unit: unit.log } : {}),
    ...(e2e.log ? { e2e: e2e.log } : {}),
  };

  return verification;
}

function normalizeVerificationState(verification) {
  const normalized = createEmptyVerificationState();
  if (verification && typeof verification === 'object') {
    normalized.lint = normalizeVerificationStatus(verification.lint);
    normalized.unit = normalizeVerificationStatus(verification.unit);
    normalized.e2e = normalizeVerificationStatus(verification.e2e);
    normalized.lastRunAt = typeof verification.lastRunAt === 'string' && verification.lastRunAt.trim()
      ? verification.lastRunAt.trim()
      : null;
    normalized.logs = verification.logs && typeof verification.logs === 'object'
      ? { ...verification.logs }
      : {};
    normalized.checks = verification.checks && typeof verification.checks === 'object'
      ? { ...verification.checks }
      : {};
  }

  return recomputeLegacyVerificationFields(normalized);
}

/**
 * Normalize commit fields on a changeset/index record in-place.
 * Handles legacy data where commitSha was accidentally persisted as an object.
 * @param {Record<string, any>} record
 * @returns {boolean} true if record was mutated
 */
function normalizeCommitFields(record) {
  if (!record || typeof record !== 'object') {
    return false;
  }

  const originalCommitSha = record.commitSha;
  const normalizedCommitSha = normalizeCommitSha(originalCommitSha);
  let changed = false;

  if (normalizedCommitSha) {
    if (record.commitSha !== normalizedCommitSha) {
      record.commitSha = normalizedCommitSha;
      changed = true;
    }

    if (
      (!record.commitMessage || typeof record.commitMessage !== 'string')
      && originalCommitSha
      && typeof originalCommitSha === 'object'
      && typeof originalCommitSha.commitMessage === 'string'
      && originalCommitSha.commitMessage.trim().length > 0
    ) {
      record.commitMessage = originalCommitSha.commitMessage;
      changed = true;
    }
  } else if (record.commitSha && typeof record.commitSha !== 'string') {
    record.commitSha = null;
    changed = true;
  }

  return changed;
}

/**
 * Load the changesets index
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Array>} - Array of changeset index entries
 */
async function loadIndex(projectPath) {
  const indexPath = getIndexPath(projectPath);
  try {
    const data = await readJsonFileWithRetry(indexPath);
    const changesets = Array.isArray(data.changesets) ? data.changesets : [];
    for (const changeset of changesets) {
      normalizeCommitFields(changeset);
    }
    return changesets;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  const legacyIndexPath = getLegacyChangeSetIndexPath(projectPath);
  try {
    const data = await readJsonFileWithRetry(legacyIndexPath);
    const changesets = Array.isArray(data.changesets) ? data.changesets : [];
    for (const changeset of changesets) {
      normalizeCommitFields(changeset);
    }
    await saveIndex(projectPath, changesets);
    return changesets;
  } catch (legacyError) {
    if (legacyError.code === 'ENOENT') {
      return [];
    }
    throw legacyError;
  }
}

/**
 * Save the changesets index
 * @param {string} projectPath - Path to the project
 * @param {Array} changesets - Array of changeset index entries
 * @returns {Promise<void>}
 */
async function saveIndex(projectPath, changesets) {
  await ensureChangesetsDir(projectPath);
  const indexPath = getIndexPath(projectPath);
  const data = {
    version: 1,
    updatedAt: new Date().toISOString(),
    changesets,
  };
  await writeJsonFileAtomic(indexPath, data);
}

function applyReviewIndexFields(entry, reviewFields) {
  if (!entry || typeof entry !== 'object' || !reviewFields || typeof reviewFields !== 'object') {
    return false;
  }

  let changed = false;
  const fieldNames = [
    'reviewStatus',
    'reviewRiskLevel',
    'reviewSummary',
    'reviewedBy',
    'reviewedAt',
    'reviewError',
  ];

  for (const fieldName of fieldNames) {
    if (reviewFields[fieldName] === undefined) {
      continue;
    }
    if (entry[fieldName] !== reviewFields[fieldName]) {
      entry[fieldName] = reviewFields[fieldName];
      changed = true;
    }
  }

  return changed;
}

function isZeroFileBaselineEntry(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const fileCount = Number(entry.fileCount ?? entry?.riskFlags?.fileCount ?? 0);
  if (!Number.isFinite(fileCount) || fileCount !== 0) return false;
  const title = String(entry.title || '').toLowerCase();
  return entry.source === 'baseline' || title.includes('baseline') || title.includes('opened from local folder');
}

function sortByCreatedAtAscending(a, b) {
  const aTime = Date.parse(String(a?.createdAt || ''));
  const bTime = Date.parse(String(b?.createdAt || ''));
  const aTs = Number.isFinite(aTime) ? aTime : Number.MAX_SAFE_INTEGER;
  const bTs = Number.isFinite(bTime) ? bTime : Number.MAX_SAFE_INTEGER;
  if (aTs !== bTs) return aTs - bTs;
  return String(a?.id || '').localeCompare(String(b?.id || ''));
}

async function pruneRedundantZeroFileBaselines(projectPath, index) {
  const list = Array.isArray(index) ? index : [];
  const baselineEntries = list.filter(isZeroFileBaselineEntry);
  if (baselineEntries.length <= 1) {
    return { index: list, removedIds: [] };
  }

  const sortedBaselines = [...baselineEntries].sort(sortByCreatedAtAscending);
  const keepId = sortedBaselines[0]?.id;
  const removedIds = sortedBaselines
    .slice(1)
    .map((entry) => entry?.id)
    .filter(Boolean);
  if (!keepId || removedIds.length === 0) {
    return { index: list, removedIds: [] };
  }

  const removedIdSet = new Set(removedIds);
  const prunedIndex = list.filter((entry) => !removedIdSet.has(entry?.id));

  await Promise.all(removedIds.map(async (id) => {
    const changesetPath = getChangeSetFilePath(projectPath, id);
    try {
      await fs.unlink(changesetPath);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        console.warn(`Could not delete redundant baseline changeset ${id}:`, error.message);
      }
    }
  }));

  return { index: prunedIndex, removedIds };
}

/**
 * Create a new changeset
 * @param {string} projectPath - Path to the project
 * @param {Object} options - Changeset options
 * @param {string} [options.title] - Changeset title (auto-generated if not provided)
 * @param {string} [options.summary] - Human-readable summary explaining what changed
 * @param {'agent'|'visual_edit'|'workflow'|'git_watcher'|'github_pull_sync'|'manual'|'baseline'} options.source - Source of the changes
 * @param {Array<{path: string, before: string|null, after: string|null}>} options.files - File changes
 * @returns {Promise<Object>} - Created changeset
 */
async function createChangeSet(projectPath, { title, summary, source, files }) {
  if (!files || files.length === 0) {
    throw new Error('At least one file change is required');
  }

  const validSources = ['agent', 'visual_edit', 'workflow', 'git_watcher', 'github_pull_sync', 'manual', 'baseline'];
  if (!source || !validSources.includes(source)) {
    throw new Error(`Source must be one of: ${validSources.join(', ')}`);
  }

  const changesetsDir = await ensureChangesetsDir(projectPath);
  const id = uuidv4();
  const displayId = await getNextDisplayId(projectPath);
  const now = new Date().toISOString();

  // Auto-generate title if not provided
  const autoTitle = title || generateTitle(files, source);

  // Build full changeset with file contents
  const fileChanges = files.map(file => ({
    path: file.path,
    before: file.before,
    after: file.after,
    language: detectLanguage(file.path),
  }));

  // Initialize verification object with all checks as 'not_run'
  const verification = {
    ...createEmptyVerificationState(),
  };

  // Calculate risk flags
  const riskFlags = calculateRiskFlags(files);

  const changeset = {
    id,
    displayId,
    title: autoTitle,
    summary: summary || null,
    source,
    status: 'applied',
    createdAt: now,
    files: fileChanges,
    riskFlags,
    verification,
  };

  // Save full changeset to its own file
  const changesetPath = getChangeSetFilePath(projectPath, id);
  await writeJsonFileAtomic(changesetPath, changeset);

  // Update index with lightweight entry (no file contents)
  const index = await loadIndex(projectPath);
  const indexEntry = {
    id,
    displayId,
    title: autoTitle,
    summary: summary || null,
    source,
    status: 'applied',
    createdAt: now,
    fileCount: files.length,
    filePaths: files.map(f => f.path),
    riskFlags,
  };
  index.unshift(indexEntry); // Add to beginning (newest first)
  await saveIndex(projectPath, index);

  // Trigger auto-verification in background (non-blocking)
  setImmediate(async () => {
    try {
      await triggerAutoVerification(projectPath, id);
    } catch (err) {
      console.error('Auto-verification error:', err.message);
    }
  });

  return changeset;
}

/**
 * Calculate risk flags for a changeset based on file changes
 * @param {Array<{path: string, before: string|null, after: string|null}>} files - File changes
 * @returns {Object} - Risk flags object
 */
function calculateRiskFlags(files) {
  const flags = {
    ...EMPTY_FILE_RISK_FLAGS,
    largeBlastRadius: false,
    fileCount: files.length,
    totalAdditions: 0,
    totalDeletions: 0,
  };
  Object.assign(flags, inferFileRiskFlags(files));

  for (const file of files) {
    // Calculate line changes
    const beforeLines = file.before ? file.before.split('\n').length : 0;
    const afterLines = file.after ? file.after.split('\n').length : 0;

    if (file.before === null) {
      // New file - all lines are additions
      flags.totalAdditions += afterLines;
    } else if (file.after === null) {
      // Deleted file - all lines are deletions
      flags.totalDeletions += beforeLines;
    } else {
      // Modified file - rough estimate
      flags.totalAdditions += Math.max(0, afterLines - beforeLines);
      flags.totalDeletions += Math.max(0, beforeLines - afterLines);
    }
  }

  // Check for large blast radius (5+ files OR 100+ line changes)
  const totalChanges = flags.totalAdditions + flags.totalDeletions;
  flags.largeBlastRadius = files.length >= 5 || totalChanges >= 100;

  return flags;
}

/**
 * Generate a title for a changeset based on files changed
 * @param {Array} files - File changes
 * @param {string} source - Source of changes
 * @returns {string} - Generated title
 */
function generateTitle(files, source) {
  if (files.length === 0) return 'Empty changeset';

  const firstFile = files[0].path;
  const baseName = path.basename(firstFile);

  if (source === 'visual_edit') {
    return `UI edit: ${baseName}`;
  }

  if (files.length === 1) {
    // Determine action based on before/after
    if (files[0].before === null) {
      return `Created ${baseName}`;
    } else if (files[0].after === null) {
      return `Deleted ${baseName}`;
    } else {
      return `Modified ${baseName}`;
    }
  }

  return `Modified ${files.length} files (${baseName} +${files.length - 1} more)`;
}

/**
 * Get all changesets for a project (index only, no file contents)
 * Automatically backfills displayId for legacy changesets that don't have one.
 * @param {string} projectPath - Path to the project
 * @returns {Promise<Array>} - Array of changeset index entries
 */
async function getChangeSets(projectPath) {
  let changesets = await loadIndex(projectPath);
  const pruned = await pruneRedundantZeroFileBaselines(projectPath, changesets);
  if (pruned.removedIds.length > 0) {
    changesets = pruned.index;
  }

  // Backfill displayId for any legacy changesets that don't have one
  let needsSave = pruned.removedIds.length > 0;
  for (const cs of changesets) {
    if (normalizeCommitFields(cs)) {
      needsSave = true;
    }

    if (!cs.displayId) {
      cs.displayId = await getNextDisplayId(projectPath);
      needsSave = true;

      // Also update the full changeset file
      const changesetPath = getChangeSetFilePath(projectPath, cs.id);
      try {
        let fullChangeset;
        try {
          fullChangeset = await readJsonFileWithRetry(changesetPath);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
          fullChangeset = await readJsonFileWithRetry(getLegacyChangeSetFilePath(projectPath, cs.id));
        }
        fullChangeset.displayId = cs.displayId;
        await writeJsonFileAtomic(changesetPath, fullChangeset);
      } catch (error) {
        // Changeset file might not exist (corrupted data), skip
        console.warn(`Could not update displayId for changeset ${cs.id}:`, error.message);
      }
    }
  }

  // Save index if any changesets were updated
  if (needsSave) {
    try {
      await saveIndex(projectPath, changesets);
    } catch (error) {
      console.warn(`Could not persist normalized changeset index for ${projectPath}:`, error.message);
    }
  }

  return changesets;
}

/**
 * Get a single changeset with full file contents
 * @param {string} projectPath - Path to the project
 * @param {string} id - Changeset ID
 * @returns {Promise<Object|null>} - Changeset with file contents or null if not found
 */
async function getChangeSet(projectPath, id) {
  const changesetPath = getChangeSetFilePath(projectPath, id);
  const legacyChangesetPath = getLegacyChangeSetFilePath(projectPath, id);

  try {
    const changeset = await readJsonFileWithRetry(changesetPath);
    let changed = normalizeCommitFields(changeset);
    const normalizedVerification = normalizeVerificationState(changeset.verification);
    if (JSON.stringify(changeset.verification || null) !== JSON.stringify(normalizedVerification)) {
      changeset.verification = normalizedVerification;
      changed = true;
    }
    if (changed) {
      try {
        await writeJsonFileAtomic(changesetPath, changeset);
      } catch (error) {
        console.warn(`Could not persist normalized changeset ${id}:`, error.message);
      }
    }
    return changeset;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  try {
    const legacyChangeset = await readJsonFileWithRetry(legacyChangesetPath);
    let changed = normalizeCommitFields(legacyChangeset);
    const normalizedVerification = normalizeVerificationState(legacyChangeset.verification);
    if (JSON.stringify(legacyChangeset.verification || null) !== JSON.stringify(normalizedVerification)) {
      legacyChangeset.verification = normalizedVerification;
      changed = true;
    }
    try {
      await ensureChangesetsDir(projectPath);
      await writeJsonFileAtomic(changesetPath, legacyChangeset);
    } catch (persistError) {
      console.warn(`Could not migrate legacy changeset ${id}:`, persistError.message);
    }
    if (changed) {
      try {
        await writeJsonFileAtomic(legacyChangesetPath, legacyChangeset);
      } catch (persistError) {
        console.warn(`Could not normalize legacy changeset ${id}:`, persistError.message);
      }
    }
    return legacyChangeset;
  } catch (legacyError) {
    if (legacyError.code === 'ENOENT') {
      return null;
    }
    throw legacyError;
  }
}

function normalizeNonEmptyString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function reconcileInterruptedReviewRecord(record, nowIso) {
  if (!record || typeof record !== 'object') return false;
  const reviewStatus = normalizeNonEmptyString(record.reviewStatus)?.toLowerCase() || null;
  if (!reviewStatus || !INTERRUPTED_REVIEW_STATUSES.has(reviewStatus)) {
    return false;
  }

  const existingError = normalizeNonEmptyString(record.reviewError);
  const existingSummary = normalizeNonEmptyString(record.reviewSummary);

  record.reviewStatus = 'failed';
  record.reviewError = existingError || INTERRUPTED_REVIEW_RECOVERY_MESSAGE;
  if (!existingSummary) {
    record.reviewSummary = INTERRUPTED_REVIEW_RECOVERY_MESSAGE;
  }
  if (!normalizeNonEmptyString(record.reviewedAt)) {
    record.reviewedAt = nowIso;
  }
  record.updatedAt = nowIso;
  return true;
}

/**
 * Mark interrupted queued/reviewing review records as failed.
 * Queue state is in-memory, so stale in-flight statuses can persist on disk after restart.
 * @param {string} projectPath
 * @returns {Promise<number>} Count of recovered changesets.
 */
async function markInterruptedReviewsAsFailed(projectPath) {
  const nowIso = new Date().toISOString();
  const index = await loadIndex(projectPath);
  let indexChanged = false;
  const recoveredIds = new Set();

  for (const entry of index) {
    if (reconcileInterruptedReviewRecord(entry, nowIso)) {
      indexChanged = true;
      if (entry?.id) recoveredIds.add(entry.id);
    }
  }

  if (recoveredIds.size === 0) {
    return 0;
  }

  if (indexChanged) {
    await saveIndex(projectPath, index);
  }

  await Promise.all(Array.from(recoveredIds).map(async (changesetId) => {
    const changesetPath = getChangeSetFilePath(projectPath, changesetId);
    try {
      const fullChangeset = await readJsonFileWithRetry(changesetPath);
      const changed = reconcileInterruptedReviewRecord(fullChangeset, nowIso);
      if (changed) {
        await writeJsonFileAtomic(changesetPath, fullChangeset);
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw error;
      }
    }
  }));

  return recoveredIds.size;
}

/**
 * Revert a changeset by writing 'before' content back to files
 * @param {string} projectPath - Path to the project
 * @param {string} id - Changeset ID
 * @returns {Promise<Object>} - Result with reverted files info
 */
async function revertChangeSet(projectPath, id) {
  const changeset = await getChangeSet(projectPath, id);

  if (!changeset) {
    throw new Error('Changeset not found');
  }

  if (changeset.status === 'reverted') {
    throw new Error('Changeset is already reverted');
  }

  const revertedFiles = [];
  const errors = [];

  for (const file of changeset.files) {
    const fullPath = path.join(projectPath, file.path);

    try {
      if (file.before === null) {
        // File was created - delete it
        await fs.unlink(fullPath);
        revertedFiles.push({ path: file.path, action: 'deleted' });
      } else if (file.after === null) {
        // File was deleted - recreate it
        const dir = path.dirname(fullPath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(fullPath, file.before, 'utf8');
        revertedFiles.push({ path: file.path, action: 'restored' });
      } else {
        // File was modified - restore original content
        await fs.writeFile(fullPath, file.before, 'utf8');
        revertedFiles.push({ path: file.path, action: 'reverted' });
      }
    } catch (error) {
      errors.push({ path: file.path, error: error.message });
    }
  }

  if (errors.length > 0 && revertedFiles.length === 0) {
    throw new Error(`Failed to revert any files: ${errors.map(e => e.error).join(', ')}`);
  }

  // Update status
  await updateChangeSetStatus(projectPath, id, 'reverted');

  return {
    success: true,
    revertedFiles,
    errors,
    partialRevert: errors.length > 0,
  };
}

/**
 * Reapply a reverted changeset by writing 'after' content back to files
 * @param {string} projectPath - Path to the project
 * @param {string} id - Changeset ID
 * @returns {Promise<Object>} - Result with reapplied files info
 */
async function reapplyChangeSet(projectPath, id) {
  const changeset = await getChangeSet(projectPath, id);

  if (!changeset) {
    throw new Error('Changeset not found');
  }

  if (changeset.status !== 'reverted') {
    throw new Error('Only reverted changesets can be reapplied');
  }

  const reappliedFiles = [];
  const errors = [];

  for (const file of changeset.files) {
    const fullPath = path.join(projectPath, file.path);

    try {
      if (file.after === null) {
        // File should be deleted (original changeset deleted this file)
        await fs.unlink(fullPath);
        reappliedFiles.push({ path: file.path, action: 'deleted' });
      } else if (file.before === null) {
        // File was created - recreate it
        const dir = path.dirname(fullPath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(fullPath, file.after, 'utf8');
        reappliedFiles.push({ path: file.path, action: 'created' });
      } else {
        // File was modified - restore "after" content
        await fs.writeFile(fullPath, file.after, 'utf8');
        reappliedFiles.push({ path: file.path, action: 'reapplied' });
      }
    } catch (error) {
      errors.push({ path: file.path, error: error.message });
    }
  }

  if (errors.length > 0 && reappliedFiles.length === 0) {
    throw new Error(`Failed to reapply any files: ${errors.map(e => e.error).join(', ')}`);
  }

  // Update status back to applied
  await updateChangeSetStatus(projectPath, id, 'applied');

  return {
    success: true,
    reappliedFiles,
    errors,
    partialReapply: errors.length > 0,
  };
}

/**
 * Update a changeset's status
 * @param {string} projectPath - Path to the project
 * @param {string} id - Changeset ID
 * @param {'applied'|'verified'|'committed'|'published'|'reverted'} status - New status
 * @param {Object} [options] - Additional options
 * @param {string} [options.publishedUrl] - URL of published deployment (for 'published' status)
 * @returns {Promise<Object>} - Updated changeset
 */
async function updateChangeSetStatus(projectPath, id, status, options = {}) {
  if (!['applied', 'verified', 'committed', 'published', 'reverted'].includes(status)) {
    throw new Error('Status must be one of: applied, verified, committed, published, reverted');
  }

  // Update full changeset file
  const changeset = await getChangeSet(projectPath, id);
  if (!changeset) {
    throw new Error('Changeset not found');
  }

  changeset.status = status;

  // Handle publishedUrl for published status
  if (status === 'published' && options.publishedUrl) {
    changeset.publishedUrl = options.publishedUrl;
  }

  const changesetPath = getChangeSetFilePath(projectPath, id);
  await writeJsonFileAtomic(changesetPath, changeset);

  // Update index
  const index = await loadIndex(projectPath);
  const indexEntry = index.find(entry => entry.id === id);
  if (indexEntry) {
    indexEntry.status = status;
    if (status === 'published' && options.publishedUrl) {
      indexEntry.publishedUrl = options.publishedUrl;
    }
    await saveIndex(projectPath, index);
  }

  return changeset;
}

/**
 * Update a changeset's verification status for a specific check type
 * @param {string} projectPath - Path to the project
 * @param {string} id - Changeset ID
 * @param {string} checkType - Check ID
 * @param {'pass'|'fail'} result - Check result
 * @param {string} [logs] - Optional logs from the check
 * @param {{ kind?: string, label?: string, command?: string, duration?: number, exitCode?: number }} [metadata]
 * @returns {Promise<Object>} - Updated changeset
 */
async function updateChangeSetVerification(projectPath, id, checkType, result, logs = '', metadata = {}) {
  if (!checkType || typeof checkType !== 'string') {
    throw new Error('Check type must be a non-empty string');
  }

  if (!['pass', 'fail'].includes(result)) {
    throw new Error('Result must be either "pass" or "fail"');
  }

  // Update full changeset file
  const changeset = await getChangeSet(projectPath, id);
  if (!changeset) {
    throw new Error('Changeset not found');
  }

  // Initialize verification if it doesn't exist (for backwards compatibility)
  changeset.verification = normalizeVerificationState(changeset.verification);

  const nowIso = new Date().toISOString();

  // Update the specific check
  changeset.verification.lastRunAt = nowIso;
  const nextCheckState = {
    ...(changeset.verification.checks?.[checkType] || {}),
    id: checkType,
    label: typeof metadata.label === 'string' && metadata.label.trim()
      ? metadata.label.trim()
      : (changeset.verification.checks?.[checkType]?.label || checkType),
    kind: typeof metadata.kind === 'string' && metadata.kind.trim()
      ? metadata.kind.trim()
      : (changeset.verification.checks?.[checkType]?.kind || checkType),
    command: typeof metadata.command === 'string' ? metadata.command : (changeset.verification.checks?.[checkType]?.command || ''),
    status: result,
    lastRunAt: nowIso,
    ...(Number.isFinite(metadata.duration) ? { duration: metadata.duration } : {}),
    ...(Number.isFinite(metadata.exitCode) ? { exitCode: metadata.exitCode } : {}),
  };
  changeset.verification.checks = {
    ...(changeset.verification.checks || {}),
    [checkType]: nextCheckState,
  };

  // Store logs (truncate to max 50KB to avoid storage bloat)
  const MAX_LOG_SIZE = 50 * 1024; // 50KB
  const truncatedLogs = logs.length > MAX_LOG_SIZE
    ? logs.substring(0, MAX_LOG_SIZE) + '\n... [truncated]'
    : logs;
  if (logs) {
    changeset.verification.logs[checkType] = truncatedLogs;
  }

  recomputeLegacyVerificationFields(changeset.verification);

  const changesetPath = getChangeSetFilePath(projectPath, id);
  await writeJsonFileAtomic(changesetPath, changeset);

  // Update index with verification summary
  const index = await loadIndex(projectPath);
  const indexEntry = index.find(entry => entry.id === id);
  if (indexEntry) {
    indexEntry.verification = {
      lint: changeset.verification.lint,
      unit: changeset.verification.unit,
      e2e: changeset.verification.e2e,
      lastRunAt: changeset.verification.lastRunAt,
    };
    await saveIndex(projectPath, index);
  }

  return changeset;
}

/**
 * Delete a changeset
 * @param {string} projectPath - Path to the project
 * @param {string} id - Changeset ID
 * @returns {Promise<boolean>} - True if deleted, false if not found
 */
async function deleteChangeSet(projectPath, id) {
  const changesetPath = getChangeSetFilePath(projectPath, id);
  const legacyChangesetPath = getLegacyChangeSetFilePath(projectPath, id);
  let deleted = false;

  try {
    await fs.unlink(changesetPath);
    deleted = true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  try {
    await fs.unlink(legacyChangesetPath);
    deleted = true;
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error;
    }
  }

  if (!deleted) {
    return false;
  }

  // Update index
  const index = await loadIndex(projectPath);
  const filteredIndex = index.filter(entry => entry.id !== id);
  await saveIndex(projectPath, filteredIndex);

  return true;
}

/**
 * Update a changeset with commit SHA after git commit
 * @param {string} projectPath - Path to the project
 * @param {string} id - Changeset ID
 * @param {string} commitSha - Git commit SHA
 * @returns {Promise<Object>} - Updated changeset
 */
async function updateChangeSetCommit(projectPath, id, commitSha, commitMessage = null) {
  const normalizedCommitSha = normalizeCommitSha(commitSha);
  if (!normalizedCommitSha) {
    throw new Error('Commit SHA is required');
  }

  // Update full changeset file
  const changeset = await getChangeSet(projectPath, id);
  if (!changeset) {
    throw new Error('Changeset not found');
  }

  changeset.commitSha = normalizedCommitSha;
  if (commitMessage) {
    changeset.commitMessage = commitMessage;
  }
  const changesetPath = getChangeSetFilePath(projectPath, id);
  await writeJsonFileAtomic(changesetPath, changeset);

  // Update index
  const index = await loadIndex(projectPath);
  const indexEntry = index.find(entry => entry.id === id);
  if (indexEntry) {
    indexEntry.commitSha = normalizedCommitSha;
    if (commitMessage) {
      indexEntry.commitMessage = commitMessage;
    }
    await saveIndex(projectPath, index);
  }

  return changeset;
}

/**
 * Update a changeset's summary
 * @param {string} projectPath - Path to the project
 * @param {string} id - Changeset ID
 * @param {string} summary - New summary text
 * @returns {Promise<Object>} - Updated changeset
 */
async function updateChangeSetSummary(projectPath, id, summary) {
  // Update full changeset file
  const changeset = await getChangeSet(projectPath, id);
  if (!changeset) {
    throw new Error('Changeset not found');
  }

  changeset.summary = summary || null;
  const changesetPath = getChangeSetFilePath(projectPath, id);
  await writeJsonFileAtomic(changesetPath, changeset);

  // Update index
  const index = await loadIndex(projectPath);
  const indexEntry = index.find(entry => entry.id === id);
  if (indexEntry) {
    indexEntry.summary = summary || null;
    await saveIndex(projectPath, index);
  }

  return changeset;
}

/**
 * Update lightweight review fields on a changeset index entry.
 * Uses the shared index load/save helpers so legacy repo-local indexes are
 * migrated into app data before review state is written.
 * @param {string} projectPath
 * @param {string} id
 * @param {Object} reviewFields
 * @returns {Promise<boolean>} true when an index entry was updated
 */
async function updateChangeSetReviewIndex(projectPath, id, reviewFields) {
  const index = await loadIndex(projectPath);
  const indexEntry = index.find((entry) => entry.id === id);
  if (!indexEntry) {
    return false;
  }

  if (!applyReviewIndexFields(indexEntry, reviewFields)) {
    return false;
  }

  await saveIndex(projectPath, index);
  return true;
}

/**
 * Get all changesets that share a given commit SHA
 * Used for showing "Also in: CS-XXX" tooltip for legacy multi-CS commits
 * @param {string} projectPath - Path to the project
 * @param {string} commitSha - Git commit SHA to search for
 * @param {string} [excludeId] - Changeset ID to exclude from results
 * @returns {Promise<Array>} - Array of changeset index entries with matching commitSha
 */
async function getChangeSetsWithCommit(projectPath, commitSha, excludeId = null) {
  const normalizedCommitSha = normalizeCommitSha(commitSha);
  if (!normalizedCommitSha) return [];

  const changesets = await loadIndex(projectPath);
  return changesets.filter(cs =>
    normalizeCommitSha(cs.commitSha) === normalizedCommitSha && cs.id !== excludeId
  );
}

/**
 * Trigger auto-verification for a changeset (runs asynchronously)
 * If all checks pass, also auto-commits the changeset
 * @param {string} projectPath - Path to the project
 * @param {string} changesetId - Changeset ID
 * @returns {Promise<Object|null>} - Results or null if no checks available
 */
async function triggerAutoVerification(projectPath, changesetId) {
  try {
    const verifyConfig = await projectVerificationService.getProjectVerifyConfig(null, projectPath);
    if (!projectVerificationService.shouldAutoRunVerification(verifyConfig)) {
      return null;
    }

    const { checksToRun, results } = await projectVerificationService.runProjectVerification(projectPath, verifyConfig);

    if (checksToRun.length === 0) {
      console.log(`ℹ️ No checks available for auto-verification`);
      return null;
    }

    console.log(`🔄 Auto-verifying changeset ${changesetId}: ${checksToRun.map((check) => check.id).join(', ')}`);

    for (const check of checksToRun) {
      const result = results[check.id];
      await updateChangeSetVerification(projectPath, changesetId, check.id, result.status, result.logs, {
        kind: check.kind,
        label: check.label,
        command: check.command,
        duration: result.duration,
        exitCode: result.exitCode,
      });
    }

    // Check if all passed → auto-commit
    const allPassed = checksToRun.every((check) => results[check.id]?.status === 'pass');
    if (allPassed) {
      // Re-fetch changeset to check current status (user may have reverted/published)
      const currentChangeset = await getChangeSet(projectPath, changesetId);
      if (!currentChangeset || currentChangeset.status !== 'applied') {
        console.log(`ℹ️ Skipping auto-commit: changeset ${changesetId} is no longer in 'applied' status`);
        return results;
      }

      await updateChangeSetStatus(projectPath, changesetId, 'verified');

      // Auto-commit
      const isGitRepo = await gitService.isGitRepository(projectPath);

      // Re-fetch again to check commitSha (race condition guard)
      const changesetForCommit = await getChangeSet(projectPath, changesetId);
      if (isGitRepo && changesetForCommit && !changesetForCommit.commitSha) {
        try {
          const commitMessage = changesetForCommit.title || `Changeset ${changesetId}`;
          const filesToCommit = changesetForCommit.files.map(f => f.path);
          const commitResult = await gitService.commitChanges(projectPath, commitMessage, filesToCommit);

          if (commitResult.success || commitResult.commit) {
            await updateChangeSetCommit(projectPath, changesetId, commitResult.commit, commitMessage);
            await updateChangeSetStatus(projectPath, changesetId, 'committed');
            console.log(`✅ Auto-committed changeset ${changesetId}: ${commitResult.commit}`);
          }
        } catch (commitError) {
          console.error(`⚠️ Auto-commit failed:`, commitError.message);
        }
      }
    }

    return results;
  } catch (error) {
    console.error(`⚠️ Auto-verification failed:`, error.message);
    return null;
  }
}

/**
 * Create a lightweight changeset for imported code (e.g., GitHub clone).
 * Unlike createChangeSet(), this does not require files, does not trigger
 * auto-verification, and sets the changeset as already committed.
 *
 * @param {string} projectPath - Path to the project
 * @param {Object} options - Import changeset options
 * @param {string} options.commitSha - Git commit SHA of the import
 * @param {string} [options.commitMessage] - Commit message
 * @param {string} [options.title] - Changeset title
 * @param {string} [options.source] - Source identifier (defaults to 'workflow')
 * @returns {Promise<Object>} - Created changeset
 */
async function createImportChangeset(projectPath, { commitSha, commitMessage, title, source }) {
  const changesetsDir = await ensureChangesetsDir(projectPath);
  const id = uuidv4();
  const displayId = await getNextDisplayId(projectPath);
  const now = new Date().toISOString();
  const normalizedCommitSha = normalizeCommitSha(commitSha);

  const changeset = {
    id,
    displayId,
    title: title || 'Initial import from GitHub',
    summary: commitMessage || null,
    source: source || 'workflow',
    status: 'committed',
    createdAt: now,
    files: [],
    riskFlags: {
      ...EMPTY_FILE_RISK_FLAGS,
      largeBlastRadius: false,
      fileCount: 0,
      totalAdditions: 0,
      totalDeletions: 0,
    },
    verification: createEmptyVerificationState(),
    commitSha: normalizedCommitSha,
    commitMessage: commitMessage || null,
  };

  // Save full changeset file
  const changesetPath = getChangeSetFilePath(projectPath, id);
  await writeJsonFileAtomic(changesetPath, changeset);

  // Update index
  const index = await loadIndex(projectPath);
  index.unshift({
    id,
    displayId,
    title: changeset.title,
    summary: changeset.summary,
    source: changeset.source,
    status: 'committed',
    createdAt: now,
    fileCount: 0,
    filePaths: [],
    riskFlags: changeset.riskFlags,
    commitSha: normalizedCommitSha,
    commitMessage: changeset.commitMessage,
  });
  await saveIndex(projectPath, index);

  return changeset;
}

/**
 * Create a baseline changeset (CS-000) for project import/open.
 * Metadata-only: no file diffs, no review, no verification.
 * Used when a project is first imported or opened in AtlasEngine.
 * @param {string} projectPath - Path to the project
 * @param {Object} options - Baseline options
 * @param {string} [options.commitSha] - Current HEAD SHA (if git repo)
 * @param {string} [options.branch] - Current branch name
 * @param {string} [options.title] - Override title
 * @param {string} [options.importSource] - Where the project came from (e.g. 'github', 'local_folder')
 * @returns {Promise<Object>} - Created baseline changeset
 */
async function createBaselineChangeset(projectPath, { commitSha, branch, title, importSource } = {}) {
  const changesetsDir = await ensureChangesetsDir(projectPath);
  let index = await loadIndex(projectPath);

  // Cleanup historical redundant 0-file baselines first, then avoid creating new duplicates.
  const pruned = await pruneRedundantZeroFileBaselines(projectPath, index);
  if (pruned.removedIds.length > 0) {
    index = pruned.index;
    await saveIndex(projectPath, index);
  }

  const existingBaseline = index
    .filter(isZeroFileBaselineEntry)
    .sort(sortByCreatedAtAscending)[0];
  if (existingBaseline?.id) {
    const existing = await getChangeSet(projectPath, existingBaseline.id);
    if (existing) {
      return existing;
    }
    // Index points to a missing file; drop the stale entry and continue creating.
    index = index.filter((entry) => entry.id !== existingBaseline.id);
    await saveIndex(projectPath, index);
  }

  const id = uuidv4();
  const displayId = await getNextDisplayId(projectPath);
  const now = new Date().toISOString();
  const normalizedCommitSha = normalizeCommitSha(commitSha);

  const defaultTitle = importSource === 'github'
    ? 'Baseline — imported from GitHub'
    : importSource === 'local_folder'
      ? 'Baseline — opened from local folder'
      : 'Baseline — project snapshot';

  const changeset = {
    id,
    displayId,
    title: title || defaultTitle,
    summary: `Initial project state captured at import. No diff or review — this is the starting point for the trust pipeline.`,
    source: 'baseline',
    status: 'committed',
    createdAt: now,
    files: [],
    riskFlags: {
      ...EMPTY_FILE_RISK_FLAGS,
      largeBlastRadius: false,
      fileCount: 0,
      totalAdditions: 0,
      totalDeletions: 0,
    },
    verification: createEmptyVerificationState(),
    commitSha: normalizedCommitSha,
    commitMessage: null,
    branch: branch || null,
    reviewStatus: 'none',
  };

  // Save full changeset file
  const changesetPath = getChangeSetFilePath(projectPath, id);
  await writeJsonFileAtomic(changesetPath, changeset);

  // Update index
  index.unshift({
    id,
    displayId,
    title: changeset.title,
    summary: changeset.summary,
    source: 'baseline',
    status: 'committed',
    createdAt: now,
    fileCount: 0,
    filePaths: [],
    riskFlags: changeset.riskFlags,
    commitSha: changeset.commitSha,
    commitMessage: null,
    reviewStatus: 'none',
  });
  await saveIndex(projectPath, index);

  return changeset;
}

export default {
  createChangeSet,
  createImportChangeset,
  createBaselineChangeset,
  getChangeSets,
  getChangeSet,
  getChangeSetsWithCommit,
  revertChangeSet,
  reapplyChangeSet,
  updateChangeSetStatus,
  updateChangeSetVerification,
  updateChangeSetCommit,
  updateChangeSetSummary,
  updateChangeSetReviewIndex,
  deleteChangeSet,
  markInterruptedReviewsAsFailed,
  triggerAutoVerification,
};

export { updateChangeSetReviewIndex };
