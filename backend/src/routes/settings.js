/**
 * Settings Routes
 * Key-value storage for app settings (setup state, preferences, etc.)
 */

import express from 'express';
import db from '../db/connection.js';
import reviewService from '../services/reviewService.js';
import providerService from '../services/providerService.js';
import { clearClaudeCache } from './claude.js';
import { clearGitHubCache } from './github.js';
import {
  DEFAULT_REVIEW_MODEL_ADAPTIVE,
  DEFAULT_REVIEW_MODEL_ROLLOUT,
  VALID_REVIEW_MODEL_STRATEGIES,
} from '../services/review/reviewConstants.js';
import { CLAUDE_OAUTH_TOKEN_SETTING_KEY, clearStoredClaudeOAuthToken } from '../services/claudeTokenService.js';
import {
  DEFAULT_REVIEW_SYNC_SERVER_URL,
  REVIEW_SYNC_SETTING_ENV_MAP,
  applyReviewSyncSettingToEnv,
  normalizeReviewSyncSettingValue,
} from '../services/reviewSyncSettings.js';
import {
  DEFAULT_GIT_POLL_INTERVAL,
  DEFAULT_PR_AUTO_REFRESH_ENABLED,
  DEFAULT_PR_AUTO_REFRESH_INTERVAL,
  GIT_POLL_INTERVAL_OPTIONS,
  PR_AUTO_REFRESH_INTERVAL_OPTIONS,
  normalizeBooleanSetting,
  normalizePollIntervalSetting,
} from '../utils/pollingSettings.js';

const router = express.Router();
const VALID_REVIEW_MODEL_STRATEGY_SET = new Set(VALID_REVIEW_MODEL_STRATEGIES);
const VALID_REVIEW_MODEL_ROLLOUT_MODES = new Set(['off', 'shadow', 'canary', 'on']);
const VALID_REVIEW_MODEL_GATE_STATUSES = new Set(['pass', 'warn', 'fail']);
const REVIEW_MODEL_PHASES = ['triage', 'review', 'synthesis'];

// Known settings with their default values (returned even when not yet persisted to DB)
const VALID_EXECUTION_MODES = new Set(['api', 'cli-agentic', 'cli-agent', 'cli-pipe']);
const REVIEW_SYNC_SETTING_KEYS = new Set(Object.keys(REVIEW_SYNC_SETTING_ENV_MAP));

const KNOWN_SETTING_DEFAULTS = {
  review_model_strategy: 'smart',
  review_model_adaptive: JSON.stringify(DEFAULT_REVIEW_MODEL_ADAPTIVE),
  review_model_rollout: JSON.stringify(DEFAULT_REVIEW_MODEL_ROLLOUT),
  review_model_custom: JSON.stringify({}),
  review_execution_mode_order: JSON.stringify([]),
  auto_review_enabled: 'true',
  git_poll_interval: DEFAULT_GIT_POLL_INTERVAL,
  pr_auto_refresh_enabled: String(DEFAULT_PR_AUTO_REFRESH_ENABLED),
  pr_auto_refresh_interval: DEFAULT_PR_AUTO_REFRESH_INTERVAL,
  review_sync_server_url: DEFAULT_REVIEW_SYNC_SERVER_URL,
};

async function invalidateExecutionModeOrderCacheSafely() {
  try {
    const { invalidateExecutionModeOrderCache } = await import('../services/review/reviewProviderExecution.js');
    invalidateExecutionModeOrderCache();
  } catch {
    // Best-effort — module may not be loaded yet
  }
}

async function invalidateReviewModelConfigCacheSafely() {
  try {
    // Read through the namespace object so the mutation always targets the
    // live ESM binding, not a snapshot. Destructuring would capture the cache
    // object at import time; if getGlobalReviewModelConfig() reassigns
    // reviewModelConfigCache between import and mutation, the snapshot would
    // be stale and the cache would not actually be invalidated.
    const mod = await import('../services/review/reviewModelConfig.js');
    mod.reviewModelConfigCache.config = null;
    mod.reviewModelConfigCache.expiresAt = 0;
  } catch {
    // Best-effort — module may not be loaded yet
  }
}

async function invalidateReviewSettingCaches(key) {
  if (
    key === 'review_ignore_patterns'
    || key === 'review_ignore_patterns_selected_preset'
    || key === 'review_ignore_patterns_by_preset'
  ) {
    reviewService.invalidateIgnorePatternCache();
  }
  if (key === 'review_execution_mode_order') {
    await invalidateExecutionModeOrderCacheSafely();
  }
  if (key.startsWith('review_model_')) {
    await invalidateReviewModelConfigCacheSafely();
  }
}

async function invalidateRuntimeSettingCaches(key) {
  if (REVIEW_SYNC_SETTING_KEYS.has(key)) {
    return;
  }

  if (key === 'git_poll_interval') {
    try {
      const { default: gitWatcherService } = await import('../services/gitWatcherService.js');
      await gitWatcherService.reloadAllSettings();
    } catch {
      // Best-effort — watcher may not be active yet.
    }
  }

  if (key === 'pr_auto_refresh_enabled' || key === 'pr_auto_refresh_interval') {
    try {
      const { default: prReviewRefreshService } = await import('../services/prReviewRefreshService.js');
      await prReviewRefreshService.reloadAllSettings();
    } catch {
      // Best-effort — service may not be loaded yet.
    }
  }
}

function parseBoolean(value, fallback = false) {
  return normalizeBooleanSetting(value, fallback);
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function parseJsonObjectValue(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      return null;
    }
  }
  return null;
}

function normalizePatternList(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : String(value).split(/[\n,]/);
  const deduped = new Set();
  for (const entry of raw) {
    const normalized = String(entry || '').trim().toLowerCase();
    if (!normalized) continue;
    deduped.add(normalized);
    if (deduped.size >= 100) break;
  }
  return Array.from(deduped);
}

function normalizeReasonCodeList(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : String(value).split(/[\n,\s]+/);
  const deduped = new Set();
  for (const entry of raw) {
    const normalized = String(entry || '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_:-]+/g, '_')
      .replace(/^_+|_+$/g, '');
    if (!normalized) continue;
    deduped.add(normalized);
    if (deduped.size >= 20) break;
  }
  return Array.from(deduped);
}

function normalizeRolloutGate(value) {
  const parsed = parseJsonObjectValue(value) || (value && typeof value === 'object' ? value : null);
  const rawStatus = String(parsed?.status || '').trim().toLowerCase();
  const status = VALID_REVIEW_MODEL_GATE_STATUSES.has(rawStatus)
    ? rawStatus
    : DEFAULT_REVIEW_MODEL_ROLLOUT.gate.status;
  const source = typeof parsed?.source === 'string' && parsed.source.trim()
    ? parsed.source.trim().toLowerCase().slice(0, 64)
    : DEFAULT_REVIEW_MODEL_ROLLOUT.gate.source;
  const evaluatedAt = typeof parsed?.evaluatedAt === 'string' && parsed.evaluatedAt.trim()
    ? parsed.evaluatedAt.trim()
    : null;
  return {
    status,
    reasonCodes: normalizeReasonCodeList(parsed?.reasonCodes),
    source,
    evaluatedAt,
  };
}

function normalizeSettingValue(key, rawValue) {
  if (key === 'review_model_strategy') {
    const normalized = String(rawValue || '').trim().toLowerCase();
    return VALID_REVIEW_MODEL_STRATEGY_SET.has(normalized) ? normalized : 'smart';
  }

  if (key === 'review_model_custom') {
    const parsed = parseJsonObjectValue(rawValue);
    const custom = {};
    if (parsed) {
      for (const phase of REVIEW_MODEL_PHASES) {
        const value = parsed[phase];
        if (typeof value === 'string' && value.trim()) {
          custom[phase] = value.trim();
        }
      }
    }
    return JSON.stringify(custom);
  }

  if (key === 'review_model_adaptive') {
    const parsed = parseJsonObjectValue(rawValue);
    const adaptive = {
      fastPathMaxFiles: clampInteger(
        parsed?.fastPathMaxFiles,
        DEFAULT_REVIEW_MODEL_ADAPTIVE.fastPathMaxFiles,
        1,
        200
      ),
      fastPathMaxDiffChars: clampInteger(
        parsed?.fastPathMaxDiffChars,
        DEFAULT_REVIEW_MODEL_ADAPTIVE.fastPathMaxDiffChars,
        2000,
        1000000
      ),
      preferQualityOnHighRisk: parseBoolean(
        parsed?.preferQualityOnHighRisk,
        DEFAULT_REVIEW_MODEL_ADAPTIVE.preferQualityOnHighRisk
      ),
    };
    return JSON.stringify(adaptive);
  }

  if (key === 'review_execution_mode_order') {
    let arr = [];
    if (typeof rawValue === 'string') {
      try { arr = JSON.parse(rawValue); } catch { arr = []; }
    } else if (Array.isArray(rawValue)) {
      arr = rawValue;
    }
    if (!Array.isArray(arr)) arr = [];
    const seen = new Set();
    const filtered = [];
    for (const entry of arr) {
      const normalized = String(entry || '').trim().toLowerCase();
      if (!normalized || !VALID_EXECUTION_MODES.has(normalized) || seen.has(normalized)) continue;
      seen.add(normalized);
      filtered.push(normalized);
      if (filtered.length >= 4) break;
    }
    return JSON.stringify(filtered);
  }

  if (key === 'review_model_rollout') {
    const parsed = parseJsonObjectValue(rawValue);
    const modeRaw = String(parsed?.mode || '').trim().toLowerCase();
    const rollout = {
      mode: VALID_REVIEW_MODEL_ROLLOUT_MODES.has(modeRaw)
        ? modeRaw
        : DEFAULT_REVIEW_MODEL_ROLLOUT.mode,
      canaryPercent: clampInteger(
        parsed?.canaryPercent,
        DEFAULT_REVIEW_MODEL_ROLLOUT.canaryPercent,
        0,
        100
      ),
      projectAllowlist: normalizePatternList(parsed?.projectAllowlist),
      gate: normalizeRolloutGate(parsed?.gate),
    };
    return JSON.stringify(rollout);
  }

  if (key === 'build_cli_timeout') {
    return String(clampInteger(rawValue, 180, 30, 600));
  }

  if (key === 'git_poll_interval') {
    return normalizePollIntervalSetting(rawValue, GIT_POLL_INTERVAL_OPTIONS, DEFAULT_GIT_POLL_INTERVAL);
  }

  if (key === 'pr_auto_refresh_enabled') {
    return String(parseBoolean(rawValue, DEFAULT_PR_AUTO_REFRESH_ENABLED));
  }

  if (key === 'auto_review_enabled' || key.startsWith('project_auto_review_enabled:')) {
    return String(parseBoolean(rawValue, key === 'auto_review_enabled'));
  }

  if (key === 'pr_auto_refresh_interval') {
    return normalizePollIntervalSetting(
      rawValue,
      PR_AUTO_REFRESH_INTERVAL_OPTIONS,
      DEFAULT_PR_AUTO_REFRESH_INTERVAL
    );
  }

  if (key === 'review_active_provider' || key === 'build_active_provider') {
    const parsed = parseJsonObjectValue(rawValue);
    if (!parsed || typeof parsed.providerId !== 'string' || !parsed.providerId.trim()) {
      return JSON.stringify({});
    }
    return JSON.stringify({
      providerId: parsed.providerId.trim(),
      model: typeof parsed.model === 'string' && parsed.model.trim() ? parsed.model.trim() : null,
    });
  }

  if (REVIEW_SYNC_SETTING_KEYS.has(key)) {
    return normalizeReviewSyncSettingValue(key, rawValue) || '';
  }

  return typeof rawValue === 'string' ? rawValue : JSON.stringify(rawValue);
}

/**
 * POST /api/settings/reset-for-signout
 * Clears setup state, detected CLI providers, and cached settings
 * so the next app launch shows the initial setup wizard.
 * Does NOT delete projects or database content.
 */
router.post('/reset-for-signout', async (req, res) => {
  try {
    // 1. Delete setup-related settings from DB
    const setupKeys = [
      'setup_completed',
      'setup_completed_at',
      'default_tab',
      'keyboard_shortcuts_enabled',
      'show_shortcut_bar',
    ];
    for (const key of setupKeys) {
      await db.query('DELETE FROM settings WHERE id = $1', [key]);
    }

    // 1b. Drop any stored Claude OAuth token. Use the dedicated helper rather
    // than a bare DELETE so the in-process `process.env.CLAUDE_CODE_OAUTH_TOKEN`
    // mirror is cleared too — otherwise a stale token keeps shadowing the
    // `claude` CLI's own login until the next app restart.
    let claudeTokenCleared = true;
    await clearStoredClaudeOAuthToken().catch((err) => {
      claudeTokenCleared = false;
      console.warn('Could not clear stored Claude OAuth token during sign-out:', err.message);
    });

    // 2. Reset provider detection cache (deletes .atlas-providers.json)
    await providerService.resetForSignout();

    // 3. Clear Claude CLI detection and model caches
    clearClaudeCache();

    // 4. Clear GitHub device flow caches
    clearGitHubCache();

    // 5. Deactivate GitHub integrations for current user (clear OAuth tokens)
    try {
      const signoutUserId = req.user?.id || '00000000-0000-0000-0000-000000000000';
      await db.query(
        `UPDATE github_integrations SET is_active = FALSE, suspended_at = NOW(), updated_at = NOW() WHERE user_id = $1`,
        [signoutUserId]
      );

      // 5b. Clear GitHub linkage on projects so stale installation IDs can't resolve tokens
      await db.query(
        `UPDATE projects
         SET github_repo_id = NULL,
             github_repo_full_name = NULL,
             github_repo_owner = NULL,
             github_repo_name = NULL,
             github_installation_id = NULL,
             github_clone_url = NULL,
             github_sync_enabled = FALSE,
             github_sync_status = 'disabled',
             github_webhook_id = NULL,
             github_last_sync_at = NULL,
             github_last_sync_sha = NULL,
             updated_at = NOW()
         WHERE user_id = $1`,
        [signoutUserId]
      );
    } catch (ghErr) {
      // Table may not exist if GitHub was never configured — safe to ignore
      console.warn('Could not clear GitHub integrations:', ghErr.message);
    }

    return res.json({
      success: true,
      message: 'Sign-out reset complete. Restart the app to begin fresh setup.',
      clearedKeys: claudeTokenCleared ? [...setupKeys, CLAUDE_OAUTH_TOKEN_SETTING_KEY] : setupKeys,
    });
  } catch (error) {
    console.error('Error during sign-out reset:', error);
    res.status(500).json({ error: 'Failed to reset for sign-out' });
  }
});

/**
 * GET /api/settings/:key
 * Get a setting value by key
 */
router.get('/:key', async (req, res) => {
  try {
    const { key } = req.params;

    const result = await db.query(
      'SELECT id, value, updated_at FROM settings WHERE id = $1',
      [key]
    );

    if (result.rows.length === 0) {
      if (Object.prototype.hasOwnProperty.call(KNOWN_SETTING_DEFAULTS, key)) {
        return res.json({
          success: true,
          key,
          value: KNOWN_SETTING_DEFAULTS[key],
          exists: false,
          isDefault: true
        });
      }
      return res.json({
        success: true,
        key,
        value: null,
        exists: false
      });
    }

    const setting = result.rows[0];
    return res.json({
      success: true,
      key: setting.id,
      value: setting.value,
      exists: true,
      updatedAt: setting.updated_at
    });
  } catch (error) {
    console.error('Error getting setting:', error);
    res.status(500).json({ error: 'Failed to get setting' });
  }
});

/**
 * PUT /api/settings/:key
 * Set a setting value (upsert)
 */
router.put('/:key', async (req, res) => {
  try {
    const { key } = req.params;
    const { value } = req.body;

    if (value === undefined) {
      return res.status(400).json({ error: 'Value is required' });
    }

    // Normalize/sanitize value for known settings keys before storage.
    const valueStr = normalizeSettingValue(key, value);

    // Upsert the setting
    const dbType = db.getDbType ? db.getDbType() : 'postgres';

    let result;
    if (dbType === 'sqlite') {
      // SQLite upsert syntax
      result = await db.query(
        `INSERT INTO settings (id, value, updated_at)
         VALUES ($1, $2, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET
           value = excluded.value,
           updated_at = datetime('now')
         RETURNING id, value, updated_at`,
        [key, valueStr]
      );
    } else {
      // PostgreSQL upsert syntax
      result = await db.query(
        `INSERT INTO settings (id, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT(id) DO UPDATE SET
           value = EXCLUDED.value,
           updated_at = NOW()
         RETURNING id, value, updated_at`,
        [key, valueStr]
      );
    }

    const setting = result.rows[0];

    if (REVIEW_SYNC_SETTING_KEYS.has(key)) {
      applyReviewSyncSettingToEnv(key, setting.value, { override: true });
    }

    // Ensure in-memory caches reflect persisted setting updates immediately.
    await invalidateReviewSettingCaches(key);
    await invalidateRuntimeSettingCaches(key);

    return res.json({
      success: true,
      key: setting.id,
      value: setting.value,
      updatedAt: setting.updated_at
    });
  } catch (error) {
    console.error('Error setting value:', error);
    res.status(500).json({ error: 'Failed to set setting' });
  }
});

/**
 * GET /api/settings
 * Get all settings (for debugging)
 */
router.get('/', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, value, updated_at FROM settings ORDER BY updated_at DESC'
    );

    // Seed with known defaults so they always appear in the listing
    const settings = {};
    for (const [key, defaultValue] of Object.entries(KNOWN_SETTING_DEFAULTS)) {
      settings[key] = { value: defaultValue, updatedAt: null, isDefault: true };
    }

    // Override defaults with persisted DB values
    for (const row of result.rows) {
      settings[row.id] = {
        value: row.value,
        updatedAt: row.updated_at,
        isDefault: false,
      };
    }

    return res.json({
      success: true,
      settings,
      count: result.rows.length,
      countWithDefaults: Object.keys(settings).length
    });
  } catch (error) {
    console.error('Error listing settings:', error);
    res.status(500).json({ error: 'Failed to list settings' });
  }
});

/**
 * DELETE /api/settings/:key
 * Delete a setting
 */
router.delete('/:key', async (req, res) => {
  try {
    const { key } = req.params;

    const result = await db.query(
      'DELETE FROM settings WHERE id = $1 RETURNING id',
      [key]
    );

    if (result.rows.length === 0) {
      return res.json({
        success: true,
        deleted: false,
        message: 'Setting not found'
      });
    }

    if (REVIEW_SYNC_SETTING_KEYS.has(key)) {
      applyReviewSyncSettingToEnv(key, null, { override: true });
    }

    // Ensure in-memory caches reflect deleted settings immediately.
    await invalidateReviewSettingCaches(key);
    await invalidateRuntimeSettingCaches(key);

    return res.json({
      success: true,
      deleted: true,
      key
    });
  } catch (error) {
    console.error('Error deleting setting:', error);
    res.status(500).json({ error: 'Failed to delete setting' });
  }
});

export default router;
