/**
 * Git Watcher Service
 * Polls project git repos for new commits and branch switches.
 *
 * Architecture:
 *   - Each watched project has a polling interval (default 5s)
 *   - Tracks both HEAD SHA and branch name per project
 *   - Four outcomes per poll: no change, new commits (same branch),
 *     branch switch, or detached HEAD
 *   - Base branch commits → emit 'new-commits' (creates changeset)
 *   - Topic branch commits → emit 'branch-updated' (updates branch review)
 *   - Branch switch → emit 'branch-switched'
 *   - Persists lastKnownHead + lastBranchName in Atlas app data per project
 *   - Works in both web (Node.js) and desktop (Tauri) modes
 */

import fs from 'fs/promises';
import path from 'path';
import gitService from './gitService.js';
import { EventEmitter } from 'events';
import db from '../db/connection.js';
import { getProjectStoragePath } from './atlasProjectStorageService.js';
import {
  DEFAULT_GIT_POLL_INTERVAL,
  GIT_POLL_INTERVAL_OPTIONS,
  normalizePollIntervalSetting,
  pollIntervalSettingToMs,
} from '../utils/pollingSettings.js';

const WORKTREE_SCAN_INTERVAL_MS = 30000; // 30 seconds
const WATCHER_STATE_FILE = 'watcher.json';

/**
 * Well-known base branch names, ordered by preference.
 * Used for auto-detection when no base branch is configured.
 */
const BASE_BRANCH_CANDIDATES = ['development', 'develop', 'dev', 'main', 'master'];

class GitWatcherService extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, { interval: NodeJS.Timeout, projectPath: string, projectId: string, branch: string, lastKnownHead: string|null, lastBranchName: string|null, baseBranch: string|null }>} */
    this.watchers = new Map();
    /** @type {Map<string, { interval: NodeJS.Timeout, state: Map<string, { branch: string, head: string }> }>} */
    this.worktreeWatchers = new Map();
    /** @type {Map<string, Promise<void>>} */
    this.pendingInitialBranchSwitches = new Map();
  }

  async _emitAsync(eventName, payload) {
    const listeners = this.listeners(eventName);
    if (listeners.length === 0) return false;

    const results = await Promise.allSettled(
      listeners.map((listener) => Promise.resolve().then(() => listener.call(this, payload)))
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        console.warn(`[GitWatcher] ${eventName} listener failed:`, result.reason?.message || result.reason);
      }
    }

    return true;
  }

  _trackInitialBranchSwitch(projectId, task) {
    if (!projectId || !task || typeof task.then !== 'function') {
      return task;
    }

    let normalizedTask;
    normalizedTask = Promise.resolve(task)
      .catch((error) => {
        console.warn(
          `[GitWatcher] Initial branch switch failed for ${projectId}:`,
          error?.message || error
        );
      })
      .finally(() => {
        if (this.pendingInitialBranchSwitches.get(projectId) === normalizedTask) {
          this.pendingInitialBranchSwitches.delete(projectId);
        }
      });

    this.pendingInitialBranchSwitches.set(projectId, normalizedTask);
    return normalizedTask;
  }

  async _loadPollIntervalSetting() {
    try {
      const result = await db.query(
        'SELECT value FROM settings WHERE id = $1',
        ['git_poll_interval']
      );
      const rawValue = result.rows?.[0]?.value || DEFAULT_GIT_POLL_INTERVAL;
      const interval = normalizePollIntervalSetting(
        rawValue,
        GIT_POLL_INTERVAL_OPTIONS,
        DEFAULT_GIT_POLL_INTERVAL
      );
      return {
        interval,
        intervalMs: pollIntervalSettingToMs(
          interval,
          GIT_POLL_INTERVAL_OPTIONS,
          DEFAULT_GIT_POLL_INTERVAL
        ),
      };
    } catch {
      return {
        interval: DEFAULT_GIT_POLL_INTERVAL,
        intervalMs: pollIntervalSettingToMs(
          DEFAULT_GIT_POLL_INTERVAL,
          GIT_POLL_INTERVAL_OPTIONS,
          DEFAULT_GIT_POLL_INTERVAL
        ),
      };
    }
  }

  _applyPollingTimer(projectId, watcher, intervalMs) {
    if (watcher.interval) {
      clearInterval(watcher.interval);
      watcher.interval = null;
    }
    watcher.pollIntervalMs = intervalMs;
    if (!intervalMs) return;
    watcher.interval = setInterval(() => this._poll(projectId, watcher.projectPath), intervalMs);
  }

  /**
   * Get the path to the watcher state file
   */
  _getStatePath(projectPath) {
    return getProjectStoragePath(projectPath, WATCHER_STATE_FILE);
  }

  /**
   * Load persisted watcher state from Atlas app data
   */
  async _loadState(projectPath) {
    try {
      const statePath = this._getStatePath(projectPath);
      const content = await fs.readFile(statePath, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      console.warn(`[GitWatcher] Failed to load state for ${projectPath}:`, error.message);
      return {};
    }
  }

  /**
   * Persist watcher state to Atlas app data
   */
  async _saveState(projectPath, state) {
    try {
      const statePath = this._getStatePath(projectPath);
      await fs.mkdir(path.dirname(statePath), { recursive: true });
      await fs.writeFile(statePath, JSON.stringify(state, null, 2), 'utf8');
    } catch (error) {
      console.warn(`[GitWatcher] Failed to save state for ${projectPath}:`, error.message);
    }
  }

  /**
   * Check if a path is a git repository
   */
  async _isGitRepo(projectPath) {
    try {
      await fs.access(path.join(projectPath, '.git'));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get commit log between two SHAs
   */
  async _getCommitsBetween(projectPath, fromSha, toSha) {
    try {
      const git = gitService.getGitInstance(projectPath);
      const log = await git.log({ from: fromSha, to: toSha });
      return log.all.map(entry => ({
        hash: entry.hash,
        message: entry.message,
        author: entry.author_name,
        date: entry.date,
      }));
    } catch (error) {
      console.warn(`[GitWatcher] Failed to get commits between ${fromSha}..${toSha}:`, error.message);
      return [];
    }
  }

  /**
   * Get diff summary between two SHAs (file list with stats)
   */
  async _getDiffSummary(projectPath, fromSha, toSha) {
    try {
      const git = gitService.getGitInstance(projectPath);
      const diff = await git.diffSummary([`${fromSha}..${toSha}`]);
      return {
        files: diff.files.map(f => ({
          path: f.file,
          insertions: f.insertions,
          deletions: f.deletions,
          binary: f.binary,
        })),
        totalInsertions: diff.insertions,
        totalDeletions: diff.deletions,
        totalFiles: diff.changed,
      };
    } catch (error) {
      console.warn(`[GitWatcher] Failed to get diff summary:`, error.message);
      return { files: [], totalInsertions: 0, totalDeletions: 0, totalFiles: 0 };
    }
  }

  /**
   * Get file content at a specific commit
   */
  async _getFileAtCommit(projectPath, filePath, commitSha) {
    try {
      const git = gitService.getGitInstance(projectPath);
      return await git.show([`${commitSha}:${filePath}`]);
    } catch {
      return null; // File didn't exist at that commit
    }
  }

  /**
   * Auto-detect the base branch for a project.
   * Checks remote refs first (origin/development, origin/develop, origin/dev, origin/main, origin/master),
   * then local refs.
   *
   * @param {string} projectPath - Project directory path
   * @returns {Promise<string|null>} Base branch name or null
   */
  async _detectBaseBranch(projectPath) {
    // Try remote default branch first
    try {
      const remoteBranch = await gitService.getRemoteDefaultBranch(projectPath);
      if (remoteBranch) return remoteBranch;
    } catch {
      // No remote or offline
    }

    // Check well-known branch names
    for (const candidate of BASE_BRANCH_CANDIDATES) {
      // Check remote ref
      if (await gitService.refExists(projectPath, `refs/remotes/origin/${candidate}`)) {
        return candidate;
      }
      // Check local ref
      if (await gitService.refExists(projectPath, `refs/heads/${candidate}`)) {
        return candidate;
      }
    }

    return null;
  }

  /**
   * Public wrapper for fast base-branch detection used by project import/startup
   * flows. This intentionally avoids ancestry inference so callers can get a
   * deterministic startup base without scanning every branch in large repos.
   */
  async detectBaseBranch(projectPath) {
    return this._detectBaseBranch(projectPath);
  }

  /**
   * Check if a branch is the base branch
   */
  _isBaseBranch(branchName, baseBranch) {
    if (!baseBranch) return false;
    return branchName === baseBranch;
  }

  /**
   * Build file changes with before/after content for changeset creation.
   * Used for base branch commits only.
   */
  async _buildFileChanges(projectPath, diffSummary, previousHead, currentHead) {
    const fileChanges = [];
    for (const file of diffSummary.files) {
      if (file.binary) continue;
      const before = await this._getFileAtCommit(projectPath, file.path, previousHead);
      const after = await this._getFileAtCommit(projectPath, file.path, currentHead);
      if (before !== after) {
        fileChanges.push({ path: file.path, before, after });
      }
    }
    return fileChanges;
  }

  /**
   * Core polling function: check if HEAD or branch has changed.
   *
   * Outcomes:
   *   1. No change (same HEAD, same branch) → do nothing
   *   2. New commits on the same branch → emit event based on branch type
   *   3. Branch switch → emit 'branch-switched'
   *   4. Detached HEAD → emit 'detached-head'
   */
  async _poll(projectId, projectPath) {
    const watcher = this.watchers.get(projectId);
    if (!watcher) return;

    try {
      const currentHead = await gitService.getCurrentSHA(projectPath);
      if (!currentHead) return; // No commits yet

      const currentBranch = await gitService.getCurrentBranchName(projectPath);

      const previousHead = watcher.lastKnownHead;
      const previousBranch = watcher.lastBranchName;

      // Detect detached HEAD
      if (currentBranch === 'HEAD') {
        // Only emit once per detach (when transitioning from a named branch)
        if (previousBranch && previousBranch !== 'HEAD') {
          console.log(`[GitWatcher] Detached HEAD detected in project ${projectId}`);
          await this._emitAsync('detached-head', { projectId, projectPath, previousBranch });
        }
        // Update state
        watcher.lastKnownHead = currentHead;
        watcher.lastBranchName = 'HEAD';
        watcher.branch = 'HEAD';
        await this._saveState(projectPath, {
          lastKnownHead: currentHead,
          lastBranchName: 'HEAD',
          branch: 'HEAD',
          baseBranch: watcher.baseBranch,
          lastCheckedAt: new Date().toISOString(),
        });
        return;
      }

      // Detect branch switch
      const branchChanged = previousBranch && previousBranch !== currentBranch;

      // No change at all
      if (!branchChanged && currentHead === previousHead) return;

      // Update watcher state
      watcher.lastKnownHead = currentHead;
      watcher.lastBranchName = currentBranch;
      watcher.branch = currentBranch;

      // Persist state
      await this._saveState(projectPath, {
        lastKnownHead: currentHead,
        lastBranchName: currentBranch,
        branch: currentBranch,
        baseBranch: watcher.baseBranch,
        lastCheckedAt: new Date().toISOString(),
      });

      // First poll after start — record HEAD and emit initial branch-switched
      // so the server can create the branch review immediately.
      if (!previousHead || !previousBranch) {
        // Only emit if not on the base branch (base branches don't get reviewed)
        if (!this._isBaseBranch(currentBranch, watcher.baseBranch)) {
          console.log(`[GitWatcher] Initial branch detection for project ${projectId}: ${currentBranch}`);
          await this._emitAsync('branch-switched', {
            projectId,
            projectPath,
            previousBranch: null,
            currentBranch,
            currentHead,
            baseBranch: watcher.baseBranch,
          });
        }
        return;
      }

      // === Branch switch detected ===
      if (branchChanged) {
        console.log(`[GitWatcher] Branch switch detected in project ${projectId}: ${previousBranch} → ${currentBranch}`);
        await this._emitAsync('branch-switched', {
          projectId,
          projectPath,
          previousBranch,
          currentBranch,
          currentHead,
          baseBranch: watcher.baseBranch,
        });
        return; // Don't also emit new-commits on the same poll
      }

      // === Same branch, new commit(s) ===
      if (currentHead === previousHead) return;

      const isOnBaseBranch = this._isBaseBranch(currentBranch, watcher.baseBranch);

      if (isOnBaseBranch) {
        // Base branch commits → create changeset (existing behavior)
        const commits = await this._getCommitsBetween(projectPath, previousHead, currentHead);
        const diffSummary = await this._getDiffSummary(projectPath, previousHead, currentHead);

        if (diffSummary.totalFiles === 0) return;

        const fileChanges = await this._buildFileChanges(projectPath, diffSummary, previousHead, currentHead);
        if (fileChanges.length === 0) return;

        console.log(`[GitWatcher] Detected ${commits.length} new commit(s) on base branch '${currentBranch}' in project ${projectId}: ${previousHead.slice(0, 7)}..${currentHead.slice(0, 7)} (${fileChanges.length} files)`);

        await this._emitAsync('new-commits', {
          projectId,
          projectPath,
          previousHead,
          currentHead,
          branch: currentBranch,
          commits,
          diffSummary,
          fileChanges,
        });
      } else {
        // Topic branch commits → update branch review
        console.log(`[GitWatcher] Detected new commit(s) on topic branch '${currentBranch}' in project ${projectId}: ${previousHead.slice(0, 7)}..${currentHead.slice(0, 7)}`);

        await this._emitAsync('branch-updated', {
          projectId,
          projectPath,
          previousHead,
          currentHead,
          branch: currentBranch,
          baseBranch: watcher.baseBranch,
        });
      }
    } catch (error) {
      // Swallow errors silently — watcher should be resilient
      if (error.message && !error.message.includes('does not have any commits yet')) {
        console.warn(`[GitWatcher] Poll error for ${projectId}:`, error.message);
      }
    }
  }

  /**
   * Start watching a project for git changes.
   *
   * @param {string} projectId - Project ID
   * @param {string} projectPath - Absolute path to project directory
   * @param {Object} [options] - Watch options
   * @param {string} [options.branch] - Branch to watch (default: current branch)
   * @param {string} [options.baseBranch] - Base branch name (auto-detected if not set)
   * @param {boolean} [options.awaitInitialBranchSwitch] - Await initial topic branch reconciliation
   * @returns {Promise<boolean>} true if watch started, false if not a git repo or already watching
   */
  async startWatching(projectId, projectPath, options = {}) {
    // Already watching
    if (this.watchers.has(projectId)) {
      return false;
    }

    // Must be a git repo
    if (!(await this._isGitRepo(projectPath))) {
      return false;
    }

    // Existing desktop clones may still have token-bearing remote URLs from
    // older builds. Strip credentials before any background watcher activity.
    await gitService.sanitizeRemote(projectPath, 'origin').catch(() => null);

    // Load persisted state
    const state = await this._loadState(projectPath);

    // Determine current branch
    let branch;
    try {
      branch = await gitService.getCurrentBranchName(projectPath);
    } catch {
      branch = options.branch || 'main';
    }

    // Determine base branch: explicit option > persisted state > auto-detect.
    // When the current branch is a topic branch and the detected/default base
    // would over-broaden the diff (for example, remote default `main` while
    // the topic branch actually forked from `develop`), prefer ancestry-based
    // inference before the first branch review is created.
    let baseBranch = options.baseBranch || state.baseBranch || null;
    if (!baseBranch) {
      baseBranch = await this._detectBaseBranch(projectPath);
      if (baseBranch) {
        console.log(`[GitWatcher] Auto-detected base branch for ${projectId}: ${baseBranch}`);
      }
    }
    if (!options.baseBranch && branch && baseBranch && branch !== baseBranch) {
      try {
        const inferredBaseBranch = await gitService.inferBaseBranch(projectPath, branch, {
          preferredBaseBranch: baseBranch,
        });
        if (inferredBaseBranch && inferredBaseBranch !== branch && inferredBaseBranch !== baseBranch) {
          console.log(
            `[GitWatcher] Refined base branch for ${projectId}: ${baseBranch} → ${inferredBaseBranch} `
            + `(topic branch: ${branch})`
          );
          baseBranch = inferredBaseBranch;
        }
      } catch (error) {
        console.warn(
          `[GitWatcher] Failed to refine base branch for ${projectId}:`,
          error?.message || error
        );
      }
    }

    // If the detected base branch IS the current branch and no other branches
    // exist, clear it so the handler can fall back to last-commit review.
    // This happens in single-branch repos or forks where the default branch
    // is also the only working branch.
    if (baseBranch && branch && baseBranch === branch) {
      const localBranches = await gitService.listBranches(projectPath).catch(() => []);
      const otherBranches = localBranches.filter(
        (entry) => entry?.name && entry.name !== branch
      );
      if (otherBranches.length === 0) {
        console.log(`[GitWatcher] Base branch '${baseBranch}' is the only branch for ${projectId}, clearing for last-commit fallback`);
        baseBranch = null;
      }
    }

    // Determine starting HEAD
    let lastKnownHead = state.lastKnownHead || null;
    if (!lastKnownHead) {
      try {
        lastKnownHead = await gitService.getCurrentSHA(projectPath);
      } catch {
        lastKnownHead = null;
      }
    }

    // Determine last known branch name
    const lastBranchName = state.lastBranchName || branch;

    const { interval, intervalMs } = await this._loadPollIntervalSetting();

    const watcher = {
      projectPath,
      projectId,
      branch,
      lastKnownHead,
      lastBranchName,
      baseBranch,
      interval: null,
      pollInterval: interval,
      pollIntervalMs: intervalMs,
    };

    this.watchers.set(projectId, watcher);
    this._applyPollingTimer(projectId, watcher, intervalMs);

    // Save initial state
    await this._saveState(projectPath, {
      lastKnownHead,
      lastBranchName,
      branch,
      baseBranch,
      lastCheckedAt: new Date().toISOString(),
    });

    console.log(
      `[GitWatcher] Started watching project ${projectId} `
      + `(branch: ${branch}, baseBranch: ${baseBranch || 'unknown'}, HEAD: ${lastKnownHead?.slice(0, 7) || 'none'}, `
      + `poll: ${intervalMs ? `${intervalMs}ms` : 'manual'})`
    );

    // If already on a feature branch at startup, emit branch-switched once so
    // the server can create the current branch review immediately.
    if (baseBranch && branch !== baseBranch) {
      const payload = {
        projectId,
        projectPath,
        previousBranch: null,
        currentBranch: branch,
        currentHead: lastKnownHead,
        baseBranch,
      };
      console.log(`[GitWatcher] Emitting initial branch-switched for ${projectId}: ${branch}`);
      if (options.awaitInitialBranchSwitch) {
        await this._emitAsync('branch-switched', payload);
      } else {
        process.nextTick(() => {
          const task = this._emitAsync('branch-switched', payload);
          this._trackInitialBranchSwitch(projectId, task);
        });
      }
    }

    // Start worktree scanning for this project
    this._startWorktreeScanning(projectId, projectPath);

    return true;
  }

  /**
   * Start periodic worktree scanning for a project.
   * Detects branches checked out in git worktrees and emits events
   * so branch reviews are created for them.
   *
   * @param {string} projectId
   * @param {string} projectPath - Main project directory
   * @private
   */
  _startWorktreeScanning(projectId, projectPath) {
    const state = new Map();
    const poll = () => {
      const watcher = this.watchers.get(projectId);
      const baseBranch = watcher?.baseBranch || null;
      this._pollWorktrees(projectId, projectPath, baseBranch, state);
    };
    const interval = setInterval(poll, WORKTREE_SCAN_INTERVAL_MS);
    this.worktreeWatchers.set(projectId, { interval, state });

    // Initial scan on next tick (after branch-switched for main branch fires)
    process.nextTick(poll);
  }

  /**
   * Poll for worktree changes. Detects new worktrees, HEAD updates, and removals.
   *
   * @param {string} projectId
   * @param {string} projectPath - Main project directory
   * @param {string|null} baseBranch
   * @param {Map<string, { branch: string, head: string }>} state - Tracked worktree state
   */
  async _pollWorktrees(projectId, projectPath, baseBranch, state) {
    try {
      const worktrees = await gitService.listWorktrees(projectPath);
      const currentPaths = new Set();

      for (const wt of worktrees) {
        currentPaths.add(wt.path);

        // Skip worktrees on the base branch (no diff to review)
        if (baseBranch && this._isBaseBranch(wt.branch, baseBranch)) continue;

        const prev = state.get(wt.path);

        if (!prev) {
          // New worktree detected — emit branch-switched
          state.set(wt.path, { branch: wt.branch, head: wt.head });
          console.log(`[GitWatcher] Detected worktree for '${wt.branch}' at ${wt.path}`);
          await this._emitAsync('branch-switched', {
            projectId,
            projectPath,
            previousBranch: baseBranch || 'main',
            currentBranch: wt.branch,
            currentHead: wt.head,
            baseBranch,
            isWorktree: true,
          });
        } else if (prev.branch !== wt.branch) {
          // Worktree switched branches — emit branch-switched
          state.set(wt.path, { branch: wt.branch, head: wt.head });
          console.log(`[GitWatcher] Worktree at ${wt.path} switched: '${prev.branch}' → '${wt.branch}'`);
          await this._emitAsync('branch-switched', {
            projectId,
            projectPath,
            previousBranch: prev.branch,
            currentBranch: wt.branch,
            currentHead: wt.head,
            baseBranch,
            isWorktree: true,
          });
        } else if (prev.head !== wt.head) {
          // Worktree HEAD changed — emit branch-updated
          const previousHead = prev.head;
          state.set(wt.path, { branch: wt.branch, head: wt.head });
          console.log(`[GitWatcher] Worktree '${wt.branch}' updated: ${previousHead.slice(0, 7)}..${wt.head.slice(0, 7)}`);
          await this._emitAsync('branch-updated', {
            projectId,
            projectPath,
            previousHead,
            currentHead: wt.head,
            branch: wt.branch,
            baseBranch,
            isWorktree: true,
          });
        }
      }

      // Clean up removed worktrees
      for (const [wtPath] of state) {
        if (!currentPaths.has(wtPath)) {
          const removed = state.get(wtPath);
          state.delete(wtPath);
          console.log(`[GitWatcher] Worktree removed: '${removed.branch}' at ${wtPath}`);
          await this._emitAsync('worktree-removed', {
            projectId,
            projectPath,
            worktreePath: wtPath,
            branch: removed.branch,
            head: removed.head,
            baseBranch,
            isWorktree: true,
          });
        }
      }
    } catch (error) {
      // Non-fatal — worktree scan should not crash the watcher
      if (!error.message?.includes('not a git repository')) {
        console.warn(`[GitWatcher] Worktree scan error for ${projectId}:`, error.message);
      }
    }
  }

  /**
   * Stop watching a project.
   *
   * @param {string} projectId - Project ID
   * @returns {boolean} true if stopped, false if wasn't watching
   */
  stopWatching(projectId) {
    const watcher = this.watchers.get(projectId);
    if (!watcher) return false;

    if (watcher.interval) {
      clearInterval(watcher.interval);
    }
    this.watchers.delete(projectId);
    this.pendingInitialBranchSwitches.delete(projectId);

    // Clean up worktree watcher
    const wtWatcher = this.worktreeWatchers.get(projectId);
    if (wtWatcher) {
      clearInterval(wtWatcher.interval);
      this.worktreeWatchers.delete(projectId);
    }

    console.log(`[GitWatcher] Stopped watching project ${projectId}`);
    return true;
  }

  /**
   * Manual "Sync Now" trigger — immediately checks for changes.
   *
   * @param {string} projectId - Project ID
   * @returns {Promise<boolean>} true if sync triggered
   */
  async syncNow(projectId) {
    const watcher = this.watchers.get(projectId);
    if (!watcher) return false;

    const pendingInitialBranchSwitch = this.pendingInitialBranchSwitches.get(projectId);
    if (pendingInitialBranchSwitch) {
      await pendingInitialBranchSwitch;
    }

    await this._poll(projectId, watcher.projectPath);
    if (watcher.branch && watcher.branch !== 'HEAD' && !this._isBaseBranch(watcher.branch, watcher.baseBranch)) {
      await this._emitAsync('branch-switched', {
        projectId,
        projectPath: watcher.projectPath,
        previousBranch: watcher.branch,
        currentBranch: watcher.branch,
        currentHead: watcher.lastKnownHead,
        baseBranch: watcher.baseBranch,
      });
    }
    return true;
  }

  /**
   * Check if a project is being watched.
   *
   * @param {string} projectId - Project ID
   * @returns {boolean}
   */
  isWatching(projectId) {
    return this.watchers.has(projectId);
  }

  /**
   * Get watcher status for a project.
   *
   * @param {string} projectId - Project ID
   * @returns {Object|null} Watcher status or null if not watching
   */
  getStatus(projectId) {
    const watcher = this.watchers.get(projectId);
    if (!watcher) return null;

    return {
      projectId,
      branch: watcher.branch,
      lastKnownHead: watcher.lastKnownHead,
      lastBranchName: watcher.lastBranchName,
      baseBranch: watcher.baseBranch,
      pollInterval: watcher.pollInterval,
      pollIntervalMs: watcher.pollIntervalMs,
      watching: true,
    };
  }

  /**
   * Get all active watchers.
   *
   * @returns {Array<Object>} List of watcher statuses
   */
  getActiveWatchers() {
    return Array.from(this.watchers.values()).map(w => ({
      projectId: w.projectId,
      branch: w.branch,
      lastKnownHead: w.lastKnownHead,
      lastBranchName: w.lastBranchName,
      baseBranch: w.baseBranch,
      pollInterval: w.pollInterval,
      pollIntervalMs: w.pollIntervalMs,
    }));
  }

  async reloadAllSettings() {
    const { interval, intervalMs } = await this._loadPollIntervalSetting();
    for (const [projectId, watcher] of this.watchers) {
      watcher.pollInterval = interval;
      this._applyPollingTimer(projectId, watcher, intervalMs);
    }
  }

  /**
   * Update the base branch for a watched project.
   *
   * @param {string} projectId - Project ID
   * @param {string} baseBranch - New base branch name
   */
  async updateBaseBranch(projectId, baseBranch) {
    const watcher = this.watchers.get(projectId);
    if (!watcher) return;

    watcher.baseBranch = baseBranch;
    await this._saveState(watcher.projectPath, {
      lastKnownHead: watcher.lastKnownHead,
      lastBranchName: watcher.lastBranchName,
      branch: watcher.branch,
      baseBranch,
      lastCheckedAt: new Date().toISOString(),
    });
  }

  /**
   * Stop all watchers. Called on server shutdown.
   */
  stopAll() {
    for (const [projectId] of this.watchers) {
      this.stopWatching(projectId);
    }
  }
}

// Singleton instance
const gitWatcherService = new GitWatcherService();

export default gitWatcherService;
