/**
 * GitHub Sync Worker
 * Background service that processes GitHub sync queue (push/pull operations)
 *
 * Features:
 * - Polls github_sync_queue every 5 seconds
 * - Processes push operations (AtlasEngine → GitHub)
 * - Processes pull operations (GitHub → AtlasEngine) [Phase 3]
 * - Updates project sync status and tracking
 * - Handles errors and retries (max 3 attempts)
 * - Graceful start/stop with health reporting
 *
 * Dependencies:
 * - gitService: For Git operations (commit, push, pull)
 * - githubService: For GitHub API operations (tokens, webhooks)
 * - pool: Database connection for queue operations
 */

import db from '../db/connection.js';
import gitService from './gitService.js';
import githubService from './githubService.js';
import changesetService from './changesetService.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MAX_SYNC_RETRIES = Math.max(0, Number.parseInt(process.env.ATLAS_SYNC_MAX_RETRIES || '3', 10) || 3);
const SYNC_RETRY_BASE_DELAY_MS = Math.max(1000, Number.parseInt(process.env.ATLAS_SYNC_RETRY_BASE_DELAY_MS || '2000', 10) || 2000);
const SYNC_RETRY_MAX_DELAY_MS = Math.max(
  SYNC_RETRY_BASE_DELAY_MS,
  Number.parseInt(process.env.ATLAS_SYNC_RETRY_MAX_DELAY_MS || '30000', 10) || 30000
);
const PENDING_JOB_SCAN_LIMIT = Math.max(1, Number.parseInt(process.env.ATLAS_SYNC_PENDING_SCAN_LIMIT || '25', 10) || 25);

class SyncWorker {
  constructor() {
    this.isRunning = false;
    this.pollInterval = null;
    this.pollIntervalMs = 5000; // Poll every 5 seconds
    this.currentJob = null;
    this.io = null; // Socket.IO instance for WebSocket events
    this.tableExists = null; // Cache table existence check
    this.maxRetries = MAX_SYNC_RETRIES;
    this.retryBackoffUntilByJobId = new Map();
    this.pullSyncCommitLocks = new Map();
    this.stats = {
      startedAt: null,
      totalProcessed: 0,
      successCount: 0,
      errorCount: 0,
      lastJobAt: null,
    };
  }

  /**
   * Set Socket.IO instance for emitting WebSocket events
   * Called from server.js after io is created to avoid circular imports
   *
   * @param {Object} io - Socket.IO server instance
   */
  setIo(io) {
    this.io = io;
    console.log('🔌 SyncWorker connected to Socket.IO');
  }

  /**
   * Emit a sync event to a project's room
   * Used to notify connected clients about sync status changes
   *
   * @param {string} projectId - Project UUID
   * @param {string} event - Event name (sync-started, sync-complete, sync-error)
   * @param {Object} data - Event data payload
   */
  emitSyncEvent(projectId, event, data) {
    if (this.io) {
      this.io.to(`project-${projectId}`).emit(event, data);
    }
  }

  normalizeCommitSha(value) {
    const normalized = String(value || '').trim();
    return normalized || null;
  }

  toISOStringOrNull(value) {
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      return null;
    }
    return date.toISOString();
  }

  /**
   * Serialize pull-sync changeset creation per (projectPath, commitSha).
   * Prevents local check-then-create races when duplicate pull jobs are processed concurrently.
   */
  async withPullSyncCommitLock(projectPath, commitSha, task) {
    const normalizedCommitSha = this.normalizeCommitSha(commitSha);
    if (!normalizedCommitSha) {
      return task();
    }

    const lockKey = `${projectPath}::${normalizedCommitSha}`;
    const previousTail = this.pullSyncCommitLocks.get(lockKey) || Promise.resolve();
    let releaseCurrentLock;
    const currentLock = new Promise((resolve) => {
      releaseCurrentLock = resolve;
    });
    const currentTail = previousTail
      .catch(() => {})
      .then(() => currentLock);
    this.pullSyncCommitLocks.set(lockKey, currentTail);

    await previousTail.catch(() => {});

    try {
      return await task();
    } finally {
      releaseCurrentLock();
      if (this.pullSyncCommitLocks.get(lockKey) === currentTail) {
        this.pullSyncCommitLocks.delete(lockKey);
      }
    }
  }

  normalizeLifecycleState(queueStatus, options = {}) {
    const normalizedStatus = String(queueStatus || '').trim().toLowerCase();
    const reason = String(options.reason || '').trim().toLowerCase();
    const retryCount = Math.max(0, Number(options.retryCount || 0) || 0);

    if (normalizedStatus === 'processing') return 'processing';
    if (normalizedStatus === 'pending') {
      if (retryCount > 0 || reason.includes('retry')) return 'retrying';
      return 'queued';
    }
    if (normalizedStatus === 'failed') return 'failed';
    if (normalizedStatus === 'completed') {
      if (reason.startsWith('superseded pull job:')) return 'superseded';
      return 'completed';
    }

    return 'processing';
  }

  buildSyncLifecyclePayload({
    event = null,
    job = null,
    projectId = null,
    syncType = null,
    state = null,
    commitSha = null,
    reason = null,
    retryCount = null,
    backoffMs = null,
    nextAttemptAt = null,
    filesChanged = null,
    changesetId = null,
    reusedExistingJob = false,
  } = {}) {
    const resolvedRetryCount = Math.max(0, Number(retryCount ?? job?.retry_count ?? 0) || 0);
    const resolvedReason = reason ? String(reason) : null;
    const resolvedState = state || this.normalizeLifecycleState(job?.status, {
      reason: resolvedReason,
      retryCount: resolvedRetryCount,
    });
    const resolvedFilesChanged = Array.isArray(filesChanged)
      ? filesChanged.filter((filePath) => typeof filePath === 'string' && filePath.trim())
      : [];
    const resolvedProjectId = String(projectId || job?.project_id || '').trim() || null;
    const resolvedSyncType = String(syncType || job?.sync_type || 'pull').trim().toLowerCase();

    return {
      event: event || null,
      projectId: resolvedProjectId,
      jobId: job?.id || null,
      syncType: resolvedSyncType === 'push' ? 'push' : 'pull',
      state: resolvedState,
      commitSha: this.normalizeCommitSha(commitSha ?? job?.commit_sha),
      reason: resolvedReason,
      retry: {
        count: resolvedRetryCount,
        max: this.maxRetries,
        willRetry: resolvedState === 'retrying',
        backoffMs: Number.isFinite(backoffMs) ? Number(backoffMs) : null,
        nextAttemptAt: this.toISOStringOrNull(nextAttemptAt),
      },
      filesChanged: resolvedFilesChanged,
      changesetId: changesetId || null,
      terminal: resolvedState === 'completed' || resolvedState === 'failed' || resolvedState === 'superseded',
      superseded: resolvedState === 'superseded',
      reusedExistingJob: Boolean(reusedExistingJob),
      timestamps: {
        createdAt: this.toISOStringOrNull(job?.created_at),
        startedAt: this.toISOStringOrNull(job?.started_at),
        completedAt: this.toISOStringOrNull(job?.completed_at),
      },
      updatedAt: new Date().toISOString(),
    };
  }

  emitSyncLifecycle(projectId, eventName, lifecycleInput = {}, legacyPayload = {}) {
    const lifecycle = this.buildSyncLifecyclePayload({
      ...lifecycleInput,
      event: eventName,
      projectId,
    });

    this.emitSyncEvent(projectId, eventName, {
      ...legacyPayload,
      projectId,
      type: lifecycle.syncType,
      sha: legacyPayload.sha || lifecycle.commitSha,
      lifecycle,
    });
    this.emitSyncEvent(projectId, 'sync-lifecycle', lifecycle);
    return lifecycle;
  }

  /**
   * Emit arbitrary event to a project's room.
   * Keeps sync worker payload parity with server-side emitters.
   */
  emitProjectEvent(projectId, event, data) {
    if (this.io) {
      this.io.to(`project-${projectId}`).emit(event, data);
    }
  }

  /**
   * Return true when text likely represents binary content.
   */
  isLikelyBinaryContent(content) {
    return typeof content === 'string' && content.includes('\u0000');
  }

  /**
   * Build reviewable file changes between two refs.
   * Uses name-status to preserve added/deleted/renamed semantics and
   * commit-bound file reads to avoid working-tree race conditions.
   */
  async buildFileChangesFromRange(projectPath, baseRef, headRef) {
    if (!baseRef || !headRef || baseRef === headRef) {
      return [];
    }

    const git = gitService.getGitInstance(projectPath);
    const raw = await git.raw(['diff', '--name-status', `${baseRef}..${headRef}`]);
    if (!raw || !raw.trim()) {
      return [];
    }

    const changes = [];
    for (const line of raw.trim().split('\n')) {
      if (!line) continue;
      const parts = line.split('\t');
      if (parts.length < 2) continue;

      const status = String(parts[0] || '').charAt(0);
      const currentPath = parts[2] || parts[1];
      const previousPath = status === 'R' ? parts[1] : currentPath;
      if (!currentPath) continue;

      let before = null;
      let after = null;

      if (status === 'A') {
        after = await gitService.getFileAtRef(projectPath, headRef, currentPath);
      } else if (status === 'D') {
        before = await gitService.getFileAtRef(projectPath, baseRef, previousPath);
      } else {
        before = await gitService.getFileAtRef(projectPath, baseRef, previousPath);
        after = await gitService.getFileAtRef(projectPath, headRef, currentPath);
      }

      if (this.isLikelyBinaryContent(before) || this.isLikelyBinaryContent(after)) {
        continue;
      }
      if (before === after) {
        continue;
      }

      changes.push({
        path: currentPath,
        before,
        after,
      });
    }

    return changes;
  }

  computeRetryBackoffMs(nextRetryCount) {
    const safeRetryCount = Math.max(1, Number(nextRetryCount) || 1);
    const exponentialDelay = SYNC_RETRY_BASE_DELAY_MS * (2 ** (safeRetryCount - 1));
    return Math.min(SYNC_RETRY_MAX_DELAY_MS, exponentialDelay);
  }

  parseTimestampMs(value) {
    const time = Date.parse(String(value || ''));
    return Number.isFinite(time) ? time : null;
  }

  isLikelyTransientSyncError(error) {
    const status = Number(error?.status || error?.statusCode || error?.response?.status || 0);
    if (status > 0) {
      if (status === 401 || status === 403 || status === 404) return false;
      if (status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) return true;
    }

    const code = String(error?.code || '').toLowerCase();
    const message = String(error?.message || '').toLowerCase();
    const text = `${code} ${message}`.trim();
    if (!text) return false;

    const terminalPatterns = [
      'authentication failed',
      'bad credentials',
      'invalid token',
      'token has expired',
      'permission denied',
      'access denied',
      'forbidden',
      'repository not configured',
      'repository not found',
      'github sync not enabled',
      'conflict',
      'merge conflict',
      'not a git repository',
      'unknown sync type',
    ];

    if (terminalPatterns.some((pattern) => text.includes(pattern))) {
      return false;
    }

    const transientPatterns = [
      'econnreset',
      'etimedout',
      'timed out',
      'timeout',
      'eai_again',
      'enotfound',
      'ecanceled',
      'network',
      'socket hang up',
      'temporarily unavailable',
      'temporary failure',
      'fetch failed',
      'connection reset',
      'connection refused',
      'rate limit',
      '429',
      '502',
      '503',
      '504',
      'remote hung up unexpectedly',
    ];
    return transientPatterns.some((pattern) => text.includes(pattern));
  }

  async shouldSkipSupersededPullJob(project, job, projectPath) {
    const commitSha = String(job?.commit_sha || '').trim();
    if (!commitSha) {
      return { skip: false, reason: null };
    }

    const lastSyncedSha = String(project?.github_last_sync_sha || '').trim();
    if (lastSyncedSha) {
      if (lastSyncedSha === commitSha) {
        return {
          skip: true,
          reason: `superseded pull job: commit ${commitSha.slice(0, 7)} already synced as head ${lastSyncedSha.slice(0, 7)}`,
        };
      }

      const behindLastSync = await gitService.isAncestorRef(projectPath, commitSha, lastSyncedSha).catch(() => false);
      if (behindLastSync) {
        return {
          skip: true,
          reason: `superseded pull job: commit ${commitSha.slice(0, 7)} is older than synced head ${lastSyncedSha.slice(0, 7)}`,
        };
      }
    }

    const queuedResult = await db.query(
      `SELECT id, commit_sha, created_at, status
       FROM github_sync_queue
       WHERE project_id = $1
         AND sync_type = 'pull'
         AND status IN ('pending', 'processing')
         AND id <> $2
         AND commit_sha IS NOT NULL
       ORDER BY created_at DESC
       LIMIT 25`,
      [project.id, job.id]
    );

    const jobCreatedAtMs = this.parseTimestampMs(job?.created_at);
    for (const row of queuedResult.rows || []) {
      const otherCommitSha = String(row?.commit_sha || '').trim();
      if (!otherCommitSha) continue;

      if (otherCommitSha === commitSha) {
        return {
          skip: true,
          reason: `superseded pull job: duplicate pending pull exists for commit ${commitSha.slice(0, 7)}`,
        };
      }

      let supersededByOtherCommit = await gitService.isAncestorRef(projectPath, commitSha, otherCommitSha).catch(() => false);
      if (!supersededByOtherCommit) {
        const otherCreatedAtMs = this.parseTimestampMs(row?.created_at);
        if (jobCreatedAtMs && otherCreatedAtMs && otherCreatedAtMs > jobCreatedAtMs) {
          supersededByOtherCommit = true;
        }
      }

      if (supersededByOtherCommit) {
        return {
          skip: true,
          reason: `superseded pull job: newer pending pull ${otherCommitSha.slice(0, 7)} (job ${row.id}) already queued`,
        };
      }
    }

    return { skip: false, reason: null };
  }

  /**
   * Start the sync worker
   * Begins polling the queue for pending jobs
   */
  start() {
    if (this.isRunning) {
      console.warn('⚠️ SyncWorker already running');
      return;
    }

    this.isRunning = true;
    this.stats.startedAt = new Date();
    console.log('🚀 SyncWorker started - polling every 5 seconds');

    // Start polling loop
    this.pollInterval = setInterval(() => {
      this.processNextJob();
    }, this.pollIntervalMs);

    // Process first job immediately
    this.processNextJob();
  }

  /**
   * Stop the sync worker
   * Waits for current job to finish before stopping
   */
  async stop() {
    if (!this.isRunning) {
      console.warn('⚠️ SyncWorker not running');
      return;
    }

    console.log('🛑 Stopping SyncWorker...');
    this.isRunning = false;

    // Clear polling interval
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    // Wait for current job to finish
    if (this.currentJob) {
      console.log('⏳ Waiting for current job to complete...');
      await this.waitForJobCompletion();
    }

    console.log('✅ SyncWorker stopped');
  }

  /**
   * Check if the github_sync_queue table exists
   * Caches result to avoid repeated queries
   *
   * @returns {Promise<boolean>} True if table exists
   */
  async checkTableExists() {
    if (this.tableExists !== null) {
      return this.tableExists;
    }

    try {
      // Try to query the table - if it fails, table doesn't exist
      await db.query(`SELECT 1 FROM github_sync_queue LIMIT 0`);
      this.tableExists = true;
      return true;
    } catch (error) {
      // Table doesn't exist (SQLite desktop mode likely)
      console.log('ℹ️  github_sync_queue table not found - GitHub sync disabled (desktop mode)');
      this.tableExists = false;
      return false;
    }
  }

  /**
   * Process next pending job from the queue
   */
  async processNextJob() {
    // Skip if already processing a job
    if (this.currentJob) {
      return;
    }

    // Check if sync queue table exists (desktop mode may not have it)
    const tableAvailable = await this.checkTableExists();
    if (!tableAvailable) {
      return;
    }

    try {
      // Get pending job candidates (FIFO order), then skip entries still under retry backoff.
      const result = await db.query(
        `SELECT *
         FROM github_sync_queue
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT $1`,
        [PENDING_JOB_SCAN_LIMIT]
      );

      if (result.rows.length === 0) {
        // No pending jobs
        return;
      }

      const nowMs = Date.now();
      const job = result.rows.find((candidate) => {
        const backoffUntil = this.retryBackoffUntilByJobId.get(candidate.id);
        if (!backoffUntil) return true;
        return backoffUntil <= nowMs;
      });

      if (!job) {
        return;
      }

      this.retryBackoffUntilByJobId.delete(job.id);
      this.currentJob = job;
      this.stats.lastJobAt = new Date();

      console.log(`🔄 Processing sync job ${job.id} (${job.sync_type}) for project ${job.project_id}`);

      // Mark job as processing
      await db.query(
        `UPDATE github_sync_queue
         SET status = 'processing',
             started_at = NOW(),
             error_message = NULL
         WHERE id = $1`,
        [job.id]
      );

      // Process based on sync type
      if (job.sync_type === 'push') {
        await this.processPushJob(job);
      } else if (job.sync_type === 'pull') {
        await this.processPullJob(job);
      } else {
        throw new Error(`Unknown sync type: ${job.sync_type}`);
      }

      // Mark job as completed
      await db.query(
        `UPDATE github_sync_queue
         SET status = 'completed',
             error_message = CASE
               WHEN error_message LIKE 'superseded pull job:%' THEN error_message
               ELSE NULL
             END,
             completed_at = NOW()
         WHERE id = $1`,
        [job.id]
      );

      this.retryBackoffUntilByJobId.delete(job.id);
      this.stats.totalProcessed++;
      this.stats.successCount++;
      console.log(`✅ Sync job ${job.id} completed successfully`);
    } catch (error) {
      console.error(`❌ Sync job failed:`, error.message);
      await this.handleJobError(error);
      this.stats.errorCount++;
    } finally {
      this.currentJob = null;
    }
  }

  /**
   * Process push job (AtlasEngine → GitHub)
   * Commits and pushes changes from local project to GitHub
   *
   * @param {Object} job - Sync job from queue
   */
  async processPushJob(job) {
    const { project_id, commit_message } = job;

    // Get project details
    const projectResult = await db.query(
      `SELECT p.*
       FROM projects p
       WHERE p.id = $1`,
      [project_id]
    );

    if (projectResult.rows.length === 0) {
      throw new Error(`Project ${project_id} not found`);
    }

    const project = projectResult.rows[0];

    // Validate GitHub sync is enabled
    if (!project.github_sync_enabled) {
      throw new Error(`GitHub sync not enabled for project ${project_id}`);
    }

    // Validate required fields
    if (!project.github_repo_owner || !project.github_repo_name) {
      throw new Error(`GitHub repository not configured for project ${project_id}`);
    }

    // Get GitHub installation token
    const token = await this.getGitHubToken(project);

    // Get project path from database
    const projectPath = project.path;

    // Check if there are uncommitted changes OR unpushed commits
    const hasChanges = await gitService.hasUncommittedChanges(projectPath);
    const status = await gitService.getStatus(projectPath);
    const hasUnpushedCommits = (status.ahead || 0) > 0;

    if (!hasChanges && !hasUnpushedCommits) {
      console.log(`ℹ️ No uncommitted changes or unpushed commits for project ${project_id}, skipping push`);
      return;
    }

    // Get changed files (may be empty if we only have unpushed commits)
    const changedFiles = hasChanges ? await gitService.getChangedFiles(projectPath) : [];
    console.log(`📝 Found ${changedFiles.length} changed file(s), ${status.ahead || 0} unpushed commit(s)`);

    // Update project sync status to 'syncing'
    await db.query(
      `UPDATE projects
       SET github_sync_status = 'syncing',
           updated_at = NOW()
       WHERE id = $1`,
      [project_id]
    );

    // Emit sync-started event to connected clients
    this.emitSyncLifecycle(
      project_id,
      'sync-started',
      {
        job,
        state: 'processing',
        syncType: 'push',
        filesChanged: changedFiles,
      },
      {
        filesCount: changedFiles.length,
      }
    );

    try {
      let result;

      if (hasChanges) {
        // Commit and push uncommitted changes
        result = await gitService.commitAndPush(
          projectPath,
          commit_message || 'Update from AtlasEngine',
          changedFiles,
          token,
          project.github_repo_owner,
          project.github_repo_name,
          project.github_default_branch
        );
      } else {
        // Only push existing unpushed commits (no new commit needed)
        console.log(`📤 Pushing ${status.ahead} existing commit(s) to remote...`);
        const repoUrl = `https://github.com/${project.github_repo_owner}/${project.github_repo_name}.git`;
        await gitService.setRemoteUrl(projectPath, repoUrl, token, 'origin');
        await gitService.push(projectPath, 'origin', project.github_default_branch, { token });

        // Get the actual HEAD SHA after push
        const headSha = await gitService.getCurrentSHA(projectPath);
        result = {
          success: true,
          commit: headSha,
          branch: project.github_default_branch,
          filesChanged: [],
        };
      }

      // Update project with sync tracking
      await db.query(
        `UPDATE projects
         SET github_last_sync_sha = $1,
             github_last_sync_at = NOW(),
             github_sync_status = 'synced',
             updated_at = NOW()
         WHERE id = $2`,
        [result.commit, project_id]
      );

      // Update job with commit info
      await db.query(
        `UPDATE github_sync_queue
         SET commit_sha = $1,
             files_changed = $2
         WHERE id = $3`,
        [result.commit, JSON.stringify(changedFiles), job.id]
      );

      const commitInfo = hasChanges
        ? `commit ${result.commit}`
        : `${status.ahead} existing commit(s)`;
      console.log(`✅ Pushed ${commitInfo} to ${project.github_repo_owner}/${project.github_repo_name}`);

      // Emit sync-complete event to connected clients
      const completionMessage = hasChanges
        ? `Pushed to GitHub (${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'})`
        : `Pushed ${status.ahead} existing commit(s) to GitHub`;
      this.emitSyncLifecycle(
        project_id,
        'sync-complete',
        {
          job,
          state: 'completed',
          syncType: 'push',
          commitSha: result.commit,
          filesChanged: changedFiles,
          reason: completionMessage,
        },
        {
          message: completionMessage,
          filesChanged: changedFiles,
          sha: result.commit,
        }
      );
    } catch (error) {
      const managedByQueue = this.currentJob?.id === job.id;
      if (!managedByQueue) {
        // Direct invocation fallback (outside queue worker loop).
        this.emitSyncLifecycle(
          project_id,
          'sync-error',
          {
            job,
            state: 'failed',
            syncType: 'push',
            reason: error.message,
          },
          {
            error: error.message,
          }
        );

        await db.query(
          `UPDATE projects
           SET github_sync_status = 'error',
               updated_at = NOW()
           WHERE id = $1`,
          [project_id]
        );
      }

      throw error;
    }
  }

  /**
   * Process pull job (GitHub → AtlasEngine)
   * Pulls changes from GitHub and updates local project
   *
   * @param {Object} job - Sync job from queue
   */
  async processPullJob(job) {
    const { project_id, commit_sha, commit_message } = job;

    // Get project details
    const projectResult = await db.query(
      `SELECT p.*
       FROM projects p
       WHERE p.id = $1`,
      [project_id]
    );

    if (projectResult.rows.length === 0) {
      throw new Error(`Project ${project_id} not found`);
    }

    const project = projectResult.rows[0];

    // Validate GitHub sync is enabled
    if (!project.github_sync_enabled) {
      throw new Error(`GitHub sync not enabled for project ${project_id}`);
    }

    // Validate required fields
    if (!project.github_repo_owner || !project.github_repo_name) {
      throw new Error(`GitHub repository not configured for project ${project_id}`);
    }

    // Get project path from database
    const projectPath = project.path;

    const lifecycleGuard = await this.shouldSkipSupersededPullJob(project, job, projectPath);
    if (lifecycleGuard.skip) {
      const skipReason = lifecycleGuard.reason || 'superseded pull job';
      await db.query(
        `UPDATE github_sync_queue
         SET status = 'completed',
             error_message = $1,
             files_changed = $2,
             completed_at = NOW()
         WHERE id = $3`,
        [skipReason, JSON.stringify([]), job.id]
      );
      console.log(`ℹ️ ${skipReason}`);
      this.emitSyncLifecycle(
        project_id,
        'sync-complete',
        {
          job,
          state: 'superseded',
          syncType: 'pull',
          commitSha: project.github_last_sync_sha || commit_sha || null,
          reason: skipReason,
          filesChanged: [],
          changesetId: null,
        },
        {
          message: skipReason,
          filesChanged: [],
          changesetId: null,
          sha: project.github_last_sync_sha || commit_sha || null,
        }
      );
      return;
    }

    // Get GitHub installation token
    const token = await this.getGitHubToken(project);
    const previousHead = await gitService.getCurrentSHA(projectPath);

    console.log(`📥 Pulling changes from ${project.github_repo_owner}/${project.github_repo_name}@${project.github_default_branch}`);

    // Update project sync status to 'syncing'
    await db.query(
      `UPDATE projects
       SET github_sync_status = 'syncing',
           updated_at = NOW()
       WHERE id = $1`,
      [project_id]
    );

    // Emit sync-started event to connected clients
    this.emitSyncLifecycle(
      project_id,
      'sync-started',
      {
        job,
        state: 'processing',
        syncType: 'pull',
        commitSha: commit_sha || null,
      }
    );

    try {
      // Check for uncommitted local changes (conflict detection - basic version)
      const hasLocalChanges = await gitService.hasUncommittedChanges(projectPath);
      if (hasLocalChanges) {
        // For now, we'll stash local changes
        // In Phase 4, we could implement more sophisticated conflict resolution
        console.log(`⚠️ Local uncommitted changes detected, will be overwritten by pull`);
        // This is a basic MVP approach - pull will fail if there are conflicts
      }

      // Ensure the stored remote stays clean; auth is injected per command.
      const repoUrl = `https://github.com/${project.github_repo_owner}/${project.github_repo_name}.git`;
      await gitService.setRemoteUrl(projectPath, repoUrl, token, 'origin');

      // Pull changes from GitHub
      const pullResult = await gitService.pull(
        projectPath,
        'origin',
        project.github_default_branch,
        { token }
      );

      // Get the new HEAD commit SHA
      const newSHA = await gitService.getCurrentSHA(projectPath);
      const baseRef = project.github_last_sync_sha || previousHead;
      let fileChanges = [];
      try {
        fileChanges = await this.buildFileChangesFromRange(projectPath, baseRef, newSHA);
      } catch (diffError) {
        console.warn('⚠️ Could not build pull-sync file changes:', diffError.message);
      }

      const changedFiles = [...new Set(fileChanges.map((file) => file.path))];

      let createdChangeset = null;
      if (newSHA && fileChanges.length > 0) {
        createdChangeset = await this.withPullSyncCommitLock(projectPath, newSHA, async () => {
          const existing = await changesetService.getChangeSetsWithCommit(projectPath, newSHA);
          const existingPullSync = existing.find((entry) => entry.source === 'github_pull_sync');

          if (existingPullSync) {
            console.log(
              `ℹ️ Pull sync commit ${newSHA.slice(0, 7)} already recorded as ${existingPullSync.displayId || existingPullSync.id}, skipping duplicate changeset`
            );
            return null;
          }

          const commitShortSha = newSHA.slice(0, 7);
          const title = `GitHub pull sync (${commitShortSha})`;
          const summary = commit_sha && commit_sha !== newSHA
            ? `Pulled from GitHub webhook commit ${commit_sha.slice(0, 7)}`
            : `Pulled ${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'} from GitHub`;

          const created = await changesetService.createChangeSet(projectPath, {
            source: 'github_pull_sync',
            title,
            summary,
            files: fileChanges,
          });

          await changesetService.updateChangeSetCommit(
            projectPath,
            created.id,
            newSHA,
            commit_message || null
          );
          await changesetService.updateChangeSetStatus(projectPath, created.id, 'committed');

          console.log(
            `📋 [SyncWorker→CS] Created ${created.displayId} for pull sync in project ${project_id}`
          );

          this.emitProjectEvent(project_id, 'claude-stream-event', {
            type: 'changeset_created',
            data: {
              id: created.id,
              title: created.title,
              source: 'github_pull_sync',
              displayId: created.displayId,
              fileCount: created.files.length,
              filePaths: created.files.map((f) => f.path),
            },
          });

          return created;
        });
      } else if (newSHA === previousHead) {
        console.log('ℹ️ Pull sync produced no new head SHA; skipping changeset creation');
      } else {
        console.log('ℹ️ Pull sync produced no reviewable file changes; skipping changeset creation');
      }

      console.log(`📥 Pulled ${changedFiles.length} reviewable file(s) from GitHub`);

      // Update project with sync tracking
      await db.query(
        `UPDATE projects
         SET github_last_sync_sha = $1,
             github_last_sync_at = NOW(),
             github_sync_status = 'synced',
             updated_at = NOW()
         WHERE id = $2`,
        [newSHA, project_id]
      );

      // Update job with commit info
      await db.query(
        `UPDATE github_sync_queue
         SET commit_sha = $1,
             files_changed = $2
         WHERE id = $3`,
        [newSHA, JSON.stringify(changedFiles), job.id]
      );

      console.log(`✅ Pulled commit ${newSHA?.substring(0, 7)} from ${project.github_repo_owner}/${project.github_repo_name}`);

      // Emit sync-complete event to connected clients
      const completionMessage = `Pulled from GitHub (${changedFiles.length} file${changedFiles.length === 1 ? '' : 's'})`;
      this.emitSyncLifecycle(
        project_id,
        'sync-complete',
        {
          job,
          state: 'completed',
          syncType: 'pull',
          commitSha: newSHA,
          reason: completionMessage,
          filesChanged: changedFiles,
          changesetId: createdChangeset?.id || null,
        },
        {
          sha: newSHA,
          message: completionMessage,
          filesChanged: changedFiles,
          changesetId: createdChangeset?.id || null,
        }
      );
    } catch (error) {
      const managedByQueue = this.currentJob?.id === job.id;
      if (!managedByQueue) {
        // Direct invocation fallback (outside queue worker loop).
        this.emitSyncLifecycle(
          project_id,
          'sync-error',
          {
            job,
            state: 'failed',
            syncType: 'pull',
            reason: error.message,
            commitSha: commit_sha || null,
          },
          {
            error: error.message,
          }
        );

        await db.query(
          `UPDATE projects
           SET github_sync_status = 'error',
               updated_at = NOW()
           WHERE id = $1`,
          [project_id]
        );
      }

      throw error;
    }
  }

  /**
   * Get GitHub access token for a project
   * Uses GitHub App installation token
   *
   * @param {Object} project - Project record
   * @returns {Promise<string>} GitHub access token
   */
  async getGitHubToken(project) {
    try {
      // Get installation token from GitHub App (decrypted and refreshed if needed)
      const token = await githubService.getDecryptedToken(project.github_installation_id);

      if (!token) {
        throw new Error(`Failed to get GitHub installation token for project ${project.id}`);
      }

      return token;
    } catch (error) {
      console.error('Failed to get GitHub token:', error.message);
      throw new Error(`GitHub authentication failed: ${error.message}`);
    }
  }

  /**
   * Handle job error
   * Updates job status, increments retry count, logs error
   *
   * @param {Error} error - Error that occurred
   */
  async handleJobError(error) {
    if (!this.currentJob) {
      return;
    }

    const job = this.currentJob;
    const retryCount = Number(job.retry_count || 0);
    const errorMessage = String(error?.message || 'Unknown sync error');
    const transient = this.isLikelyTransientSyncError(error);
    const canRetry = transient && retryCount < this.maxRetries;

    try {
      if (canRetry) {
        const nextRetryCount = retryCount + 1;
        const backoffMs = this.computeRetryBackoffMs(nextRetryCount);
        const nextAttemptAtMs = Date.now() + backoffMs;
        this.retryBackoffUntilByJobId.set(job.id, nextAttemptAtMs);
        job.retry_count = nextRetryCount;
        const retryMessage = `Transient sync failure (retry ${nextRetryCount}/${this.maxRetries}) in ${Math.ceil(backoffMs / 1000)}s: ${errorMessage}`;

        await db.query(
          `UPDATE github_sync_queue
           SET status = 'pending',
               retry_count = $1,
               error_message = $2,
               started_at = NULL,
               completed_at = NULL
           WHERE id = $3`,
          [
            nextRetryCount,
            retryMessage,
            job.id,
          ]
        );

        this.emitSyncLifecycle(
          job.project_id,
          'sync-retrying',
          {
            job: { ...job, status: 'pending' },
            state: 'retrying',
            reason: retryMessage,
            retryCount: nextRetryCount,
            backoffMs,
            nextAttemptAt: new Date(nextAttemptAtMs),
          },
          {
            error: errorMessage,
            retryCount: nextRetryCount,
            backoffMs,
            nextAttemptAt: new Date(nextAttemptAtMs).toISOString(),
          }
        );

        console.warn(
          `⚠️ Job ${job.id} transient failure (retry ${nextRetryCount}/${this.maxRetries}) in ${backoffMs}ms:`,
          errorMessage
        );
        return;
      }

      this.retryBackoffUntilByJobId.delete(job.id);
      const finalMessage = transient
        ? `Transient retry limit reached (${retryCount}/${this.maxRetries}): ${errorMessage}`
        : errorMessage;

      await db.query(
        `UPDATE github_sync_queue
         SET status = 'failed',
             retry_count = $1,
             error_message = $2,
             completed_at = NOW()
         WHERE id = $3`,
        [retryCount, finalMessage, job.id]
      );

      if (transient) {
        console.error(`❌ Job ${job.id} failed after ${retryCount} retries:`, errorMessage);
      } else {
        console.error(`❌ Job ${job.id} failed with terminal error:`, errorMessage);
      }

      this.emitSyncLifecycle(
        job.project_id,
        'sync-error',
        {
          job: { ...job, status: 'failed' },
          state: 'failed',
          reason: finalMessage,
          retryCount,
        },
        {
          error: finalMessage,
        }
      );

      // Update project sync status to error only when job is terminally failed.
      await db.query(
        `UPDATE projects
         SET github_sync_status = 'error',
             updated_at = NOW()
         WHERE id = $1`,
        [job.project_id]
      );
    } catch (dbError) {
      this.retryBackoffUntilByJobId.delete(job.id);
      console.error('Failed to update job error status:', dbError.message);
      try {
        await db.query(
          `UPDATE github_sync_queue
           SET status = 'failed',
               retry_count = $1,
               error_message = $2,
               completed_at = NOW()
           WHERE id = $3`,
          [retryCount, errorMessage, job.id]
        );
      } catch (fallbackError) {
        console.error('Failed to persist fallback failed status:', fallbackError.message);
      }
    }
  }

  /**
   * Wait for current job to complete
   * Used during graceful shutdown
   *
   * @returns {Promise<void>}
   */
  async waitForJobCompletion() {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (!this.currentJob) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
    });
  }

  /**
   * Get worker health and statistics
   *
   * @returns {Object} Worker health status
   */
  getHealth() {
    return {
      isRunning: this.isRunning,
      currentJob: this.currentJob ? {
        id: this.currentJob.id,
        projectId: this.currentJob.project_id,
        syncType: this.currentJob.sync_type,
        startedAt: this.currentJob.started_at,
      } : null,
      stats: {
        ...this.stats,
        uptime: this.stats.startedAt ? Date.now() - this.stats.startedAt.getTime() : 0,
      },
    };
  }
}

// Export singleton instance
const syncWorker = new SyncWorker();
export default syncWorker;
