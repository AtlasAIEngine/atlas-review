import { EventEmitter } from 'events';
import db from '../db/connection.js';
import { getProjectById } from '../db/queries.js';
import prReviewSyncService, { resolveGitHubMeta } from './prReviewSyncService.js';
import {
  DEFAULT_PR_AUTO_REFRESH_ENABLED,
  DEFAULT_PR_AUTO_REFRESH_INTERVAL,
  PR_AUTO_REFRESH_INTERVAL_OPTIONS,
  normalizeBooleanSetting,
  normalizePollIntervalSetting,
  pollIntervalSettingToMs,
} from '../utils/pollingSettings.js';

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildRepoAccessSignature(meta) {
  if (!meta) return null;
  return {
    connectedLogin: normalizeString(meta.connectedLogin) || null,
    owner: normalizeString(meta.owner).toLowerCase() || null,
    repo: normalizeString(meta.repo).toLowerCase() || null,
  };
}

function isSameRepoAccessSignature(left, right) {
  return Boolean(left && right)
    && (left.connectedLogin || null) === (right.connectedLogin || null)
    && (left.owner || null) === (right.owner || null)
    && (left.repo || null) === (right.repo || null);
}

async function loadRefreshSettings() {
  const result = await db.query(
    'SELECT id, value FROM settings WHERE id IN ($1, $2)',
    ['pr_auto_refresh_enabled', 'pr_auto_refresh_interval']
  );
  const byKey = new Map((result.rows || []).map((row) => [row.id, row.value]));
  const enabled = normalizeBooleanSetting(
    byKey.get('pr_auto_refresh_enabled'),
    DEFAULT_PR_AUTO_REFRESH_ENABLED
  );
  const interval = normalizePollIntervalSetting(
    byKey.get('pr_auto_refresh_interval'),
    PR_AUTO_REFRESH_INTERVAL_OPTIONS,
    DEFAULT_PR_AUTO_REFRESH_INTERVAL
  );
  return {
    enabled,
    interval,
    intervalMs: pollIntervalSettingToMs(
      interval,
      PR_AUTO_REFRESH_INTERVAL_OPTIONS,
      DEFAULT_PR_AUTO_REFRESH_INTERVAL
    ),
  };
}

class PrReviewRefreshService extends EventEmitter {
  constructor() {
    super();
    this.watchers = new Map();
    this.pendingStarts = new Set();
    this.projectSubscriptions = new Map();
  }

  _clearTimer(watcher) {
    if (!watcher?.timeout) return;
    clearTimeout(watcher.timeout);
    watcher.timeout = null;
  }

  _scheduleNext(projectId, watcher, intervalMs) {
    this._clearTimer(watcher);
    watcher.intervalMs = intervalMs;
    if (!intervalMs) return;
    watcher.timeout = setTimeout(() => {
      void this._run(projectId);
    }, intervalMs);
  }

  async _run(projectId) {
    const watcher = this.watchers.get(projectId);
    if (!watcher || watcher.inFlight) return false;

    const settings = await loadRefreshSettings().catch(() => ({
      enabled: DEFAULT_PR_AUTO_REFRESH_ENABLED,
      interval: DEFAULT_PR_AUTO_REFRESH_INTERVAL,
      intervalMs: pollIntervalSettingToMs(
        DEFAULT_PR_AUTO_REFRESH_INTERVAL,
        PR_AUTO_REFRESH_INTERVAL_OPTIONS,
        DEFAULT_PR_AUTO_REFRESH_INTERVAL
      ),
    }));

    watcher.enabled = settings.enabled;
    watcher.interval = settings.interval;

    if (!settings.enabled || !settings.intervalMs) {
      this._scheduleNext(projectId, watcher, null);
      return false;
    }

    watcher.inFlight = true;

    try {
      const project = await getProjectById(projectId);
      if (!project?.path) {
        watcher.lastError = 'Project path not found';
        this.emit('refresh-failed', {
          projectId,
          error: watcher.lastError,
          failedAt: new Date().toISOString(),
        });
        this.stopWatching(projectId);
        return false;
      }
      const githubMeta = await resolveGitHubMeta(project, project.user_id || null);
      const currentAccessSignature = buildRepoAccessSignature(githubMeta);
      if (watcher.blockedRepoAccess && isSameRepoAccessSignature(watcher.blockedRepoAccess, currentAccessSignature)) {
        watcher.lastError = watcher.lastError
          || 'Connected GitHub account cannot access this repository.';
        return false;
      }

      watcher.blockedRepoAccess = null;
      watcher.lastStartedAt = new Date().toISOString();
      this.emit('refresh-started', {
        projectId,
        startedAt: watcher.lastStartedAt,
        interval: settings.interval,
      });

      await prReviewSyncService.syncProject(project, {
        userId: project.user_id || null,
        source: 'auto',
      });
      watcher.lastCompletedAt = new Date().toISOString();
      watcher.lastError = null;
      watcher.blockedRepoAccess = null;
      this.emit('refresh-completed', {
        projectId,
        completedAt: watcher.lastCompletedAt,
      });
      return true;
    } catch (error) {
      watcher.lastError = error?.message || 'Failed to auto-refresh pull requests';
      if (error?.code === 'GITHUB_REPO_ACCESS_DENIED') {
        watcher.blockedRepoAccess = buildRepoAccessSignature({
          connectedLogin: error.connectedLogin || null,
          owner: error.owner || null,
          repo: error.repo || null,
        });
      }
      this.emit('refresh-failed', {
        projectId,
        error: watcher.lastError,
        failedAt: new Date().toISOString(),
      });
      return false;
    } finally {
      watcher.inFlight = false;
      if (this.watchers.get(projectId) === watcher) {
        this._scheduleNext(projectId, watcher, settings.intervalMs);
      }
    }
  }

  async startWatching(projectId) {
    if (this.pendingStarts.has(projectId)) return false;
    this.pendingStarts.add(projectId);

    try {
      const project = await getProjectById(projectId);
      if (!project?.path) {
        console.debug('[prReviewRefreshService] skipping watch for project without path', { projectId });
        return false;
      }

      const githubMeta = await resolveGitHubMeta(project, project.user_id || null);
      if (!githubMeta) {
        this.stopWatching(projectId);
        return false;
      }

      const settings = await loadRefreshSettings();
      if (!settings.enabled || !settings.intervalMs) {
        this.stopWatching(projectId);
        return false;
      }

      let watcher = this.watchers.get(projectId);
      const isNewWatcher = !watcher;
      if (!watcher) {
        watcher = {
          projectId,
          timeout: null,
          inFlight: false,
          lastStartedAt: null,
          lastCompletedAt: null,
          lastError: null,
          blockedRepoAccess: null,
          enabled: settings.enabled,
          interval: settings.interval,
          intervalMs: settings.intervalMs,
        };
        this.watchers.set(projectId, watcher);
      } else {
        watcher.enabled = settings.enabled;
        watcher.interval = settings.interval;
      }

      this._scheduleNext(projectId, watcher, settings.intervalMs);
      if (isNewWatcher) {
        void this._run(projectId);
      }
      return true;
    } finally {
      this.pendingStarts.delete(projectId);
    }
  }

  stopWatching(projectId) {
    const watcher = this.watchers.get(projectId);
    if (!watcher) return false;
    this._clearTimer(watcher);
    this.watchers.delete(projectId);
    return true;
  }

  trackProject(projectId) {
    const current = this.projectSubscriptions.get(projectId) || 0;
    const next = current + 1;
    this.projectSubscriptions.set(projectId, next);
    return next;
  }

  releaseProject(projectId) {
    const current = this.projectSubscriptions.get(projectId) || 0;
    if (current <= 1) {
      this.projectSubscriptions.delete(projectId);
      this.stopWatching(projectId);
      return 0;
    }
    const next = current - 1;
    this.projectSubscriptions.set(projectId, next);
    return next;
  }

  async reloadAllSettings() {
    const settings = await loadRefreshSettings();
    if (!settings.enabled || !settings.intervalMs) {
      for (const projectId of Array.from(this.watchers.keys())) {
        this.stopWatching(projectId);
      }
      return;
    }

    const projectIds = new Set([...this.projectSubscriptions.keys(), ...this.watchers.keys()]);
    for (const projectId of projectIds) {
      const existingWatcher = this.watchers.get(projectId);
      if (existingWatcher) {
        existingWatcher.enabled = settings.enabled;
        existingWatcher.interval = settings.interval;
        this._scheduleNext(projectId, existingWatcher, settings.intervalMs);
        continue;
      }
      await this.startWatching(projectId);
    }
  }

  async syncNow(projectId) {
    const project = await getProjectById(projectId);
    if (!project?.path) return false;
    await prReviewSyncService.syncProject(project, {
      userId: project.user_id || null,
      source: 'manual',
    });
    return true;
  }

  isWatching(projectId) {
    return this.watchers.has(projectId);
  }

  getStatus(projectId) {
    const watcher = this.watchers.get(projectId);
    if (!watcher) return null;
    return {
      projectId,
      watching: true,
      enabled: watcher.enabled,
      interval: watcher.interval,
      intervalMs: watcher.intervalMs,
      inFlight: watcher.inFlight,
      lastStartedAt: watcher.lastStartedAt,
      lastCompletedAt: watcher.lastCompletedAt,
      lastError: watcher.lastError,
      blockedRepoAccess: watcher.blockedRepoAccess,
    };
  }

  stopAll() {
    for (const [projectId] of this.watchers) {
      this.stopWatching(projectId);
    }
  }
}

const prReviewRefreshService = new PrReviewRefreshService();

export default prReviewRefreshService;
