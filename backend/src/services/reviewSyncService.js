import { createHash, randomBytes, randomUUID } from 'crypto';
import db, { getDbType } from '../db/connection.js';
import { normalizeRepoUrl, hashRepoUrl } from '../utils/repoIdentity.js';

const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';
const VALID_EVENT_TYPES = new Set([
  'review_completed',
  'finding_addressed',
  'finding_dismissed',
  'finding_cleared',
  'review_published',
  'fix_run_completed',
  'chat_message_sent',
  'walkthrough_generated',
  'walkthrough_step_read',
]);
const VALID_SYNC_STATUSES = new Set(['pending', 'synced', 'failed']);
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;
const REVIEW_SYNC_AUTH_TOKEN_BYTES = 32;
const SYNC_FLUSH_INTERVAL_MS = Math.max(
  5000,
  Number.parseInt(process.env.ATLAS_REVIEW_SYNC_FLUSH_INTERVAL_MS || '30000', 10) || 30000
);

let flushTimer = null;
let ioRef = null;

const localSyncState = {
  state: 'idle',
  lastSyncedAt: null,
  lastError: null,
  lastAttemptAt: null,
};

function getNowExpression() {
  return getDbType() === 'sqlite' ? "datetime('now')" : 'NOW()';
}

function generateIdIfSqlite() {
  return getDbType() === 'sqlite' ? randomUUID() : null;
}

function isDesktopMode() {
  return process.env.ATLAS_DESKTOP_MODE === 'true';
}

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeNullableText(value) {
  const normalized = normalizeText(value);
  return normalized || null;
}

function normalizeUserId(value) {
  const normalized = normalizeNullableText(value);
  const configuredUserId = getDesktopSyncConfig().userId;
  if (!normalized) {
    return configuredUserId || ANONYMOUS_USER_ID;
  }
  if (normalized === ANONYMOUS_USER_ID && configuredUserId) {
    return configuredUserId;
  }
  return normalized;
}

function hashAuthToken(token) {
  const normalized = normalizeText(token);
  if (!normalized) return null;
  return createHash('sha256').update(normalized).digest('hex');
}

function createGuestAuthToken() {
  return randomBytes(REVIEW_SYNC_AUTH_TOKEN_BYTES).toString('base64url');
}

function normalizeEventType(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!VALID_EVENT_TYPES.has(normalized)) {
    throw new Error(`eventType must be one of: ${Array.from(VALID_EVENT_TYPES).join(', ')}`);
  }
  return normalized;
}

function normalizeSyncStatus(value, fallback = 'pending') {
  const normalized = normalizeText(value).toLowerCase();
  if (!normalized) return fallback;
  if (!VALID_SYNC_STATUSES.has(normalized)) {
    throw new Error(`syncStatus must be one of: ${Array.from(VALID_SYNC_STATUSES).join(', ')}`);
  }
  return normalized;
}

function normalizeOccurredAt(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }

  const normalized = normalizeText(value);
  if (!normalized) {
    return new Date().toISOString();
  }

  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('occurredAt must be a valid ISO timestamp');
  }
  return parsed.toISOString();
}

function normalizePayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }
  return payload;
}

function toJsonText(value) {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== 'string') return {};

  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function toInt(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.trunc(parsed));
}

function buildEventIdempotencyKey(input = {}) {
  const payloadHash = createHash('sha1')
    .update(toJsonText(normalizePayload(input.payload)))
    .digest('hex');
  const source = [
    normalizeUserId(input.userId),
    normalizeEventType(input.eventType),
    normalizeNullableText(input.projectId) || 'none',
    normalizeNullableText(input.reviewType) || 'none',
    normalizeNullableText(input.reviewId) || 'none',
    normalizeNullableText(input.recommendationKey) || 'none',
    normalizeOccurredAt(input.occurredAt),
    payloadHash,
  ].join('|');
  return createHash('sha1').update(source).digest('hex');
}

function getDesktopSyncConfig() {
  return {
    serverUrl: normalizeNullableText(process.env.ATLAS_REVIEW_SYNC_SERVER_URL),
    authToken: normalizeNullableText(process.env.ATLAS_REVIEW_SYNC_AUTH_TOKEN),
    userId: normalizeNullableText(process.env.ATLAS_REVIEW_SYNC_USER_ID),
    deviceId: normalizeNullableText(process.env.ATLAS_REVIEW_SYNC_DEVICE_ID),
    deviceLabel: normalizeNullableText(process.env.ATLAS_REVIEW_SYNC_DEVICE_LABEL),
  };
}

function hasDesktopSyncConfig(config = getDesktopSyncConfig()) {
  return Boolean(config.serverUrl && config.authToken && config.userId && config.deviceId);
}

function getReviewSyncSettingUpsertSql() {
  if (getDbType() === 'sqlite') {
    return `INSERT INTO settings (id, value, updated_at)
      VALUES ($1, $2, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        value = excluded.value,
        updated_at = datetime('now')`;
  }
  return `INSERT INTO settings (id, value, updated_at)
    VALUES ($1, $2, NOW())
    ON CONFLICT(id) DO UPDATE SET
      value = EXCLUDED.value,
      updated_at = NOW()`;
}

async function persistDesktopSyncRuntimeConfig(patch = {}, executor = db) {
  const settingEntries = [
    ['review_sync_server_url', patch.serverUrl],
    ['review_sync_auth_token', patch.authToken],
    ['review_sync_user_id', patch.userId],
    ['review_sync_device_id', patch.deviceId],
    ['review_sync_device_label', patch.deviceLabel],
  ];
  const upsertSql = getReviewSyncSettingUpsertSql();

  for (const [key, rawValue] of settingEntries) {
    if (rawValue === undefined) continue;
    const value = normalizeNullableText(rawValue);
    const envName = key === 'review_sync_server_url'
      ? 'ATLAS_REVIEW_SYNC_SERVER_URL'
      : key === 'review_sync_auth_token'
        ? 'ATLAS_REVIEW_SYNC_AUTH_TOKEN'
        : key === 'review_sync_user_id'
          ? 'ATLAS_REVIEW_SYNC_USER_ID'
          : key === 'review_sync_device_id'
            ? 'ATLAS_REVIEW_SYNC_DEVICE_ID'
            : 'ATLAS_REVIEW_SYNC_DEVICE_LABEL';

    if (value) {
      await executor.query(upsertSql, [key, value]);
      process.env[envName] = value;
    } else {
      await executor.query('DELETE FROM settings WHERE id = $1', [key]);
      delete process.env[envName];
    }
  }
}

async function migrateAnonymousPendingEvents(targetUserId, executor = db) {
  const normalizedUserId = normalizeNullableText(targetUserId);
  if (!normalizedUserId || normalizedUserId === ANONYMOUS_USER_ID) {
    return 0;
  }
  const result = await executor.query(
    `UPDATE review_sync_events
        SET user_id = $1
      WHERE user_id = $2
        AND sync_status != 'synced'`,
    [normalizedUserId, ANONYMOUS_USER_ID]
  );
  return toInt(result.rowCount);
}

function toEventRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    deviceId: row.device_id ?? null,
    eventType: row.event_type,
    syncStatus: row.sync_status,
    syncError: row.sync_error ?? null,
    syncAttemptCount: toInt(row.sync_attempt_count),
    syncedAt: row.synced_at ?? null,
    projectId: row.project_id ?? null,
    projectName: row.project_name ?? null,
    projectPath: row.project_path ?? null,
    repoIdentityHash: row.repo_identity_hash ?? null,
    repoRemoteUrl: row.repo_remote_url ?? null,
    reviewType: row.review_type ?? null,
    reviewId: row.review_id ?? null,
    recommendationKey: row.recommendation_key ?? null,
    idempotencyKey: row.event_idempotency_key,
    occurredAt: row.occurred_at,
    payload: parseJsonObject(row.payload_json),
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function toSessionRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    deviceId: row.device_id,
    deviceLabel: row.device_label ?? null,
    authTokenHash: row.auth_token_hash,
    lastSeenAt: row.last_seen_at ?? null,
    revokedAt: row.revoked_at ?? null,
    createdAt: row.created_at ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

function normalizeQueueInput(rawInput = {}) {
  const payload = normalizePayload(rawInput.payload);
  const eventType = normalizeEventType(rawInput.eventType);
  const occurredAt = normalizeOccurredAt(rawInput.occurredAt);

  return {
    userId: normalizeUserId(rawInput.userId),
    deviceId: normalizeNullableText(rawInput.deviceId) || getDesktopSyncConfig().deviceId,
    eventType,
    syncStatus: normalizeSyncStatus(rawInput.syncStatus, isDesktopMode() ? 'pending' : 'synced'),
    projectId: normalizeNullableText(rawInput.projectId),
    projectName: normalizeNullableText(rawInput.projectName),
    projectPath: normalizeNullableText(rawInput.projectPath),
    reviewType: normalizeNullableText(rawInput.reviewType),
    reviewId: normalizeNullableText(rawInput.reviewId),
    recommendationKey: normalizeNullableText(rawInput.recommendationKey),
    repoIdentityHash: normalizeNullableText(rawInput.repoIdentityHash),
    repoRemoteUrl: normalizeNullableText(rawInput.repoRemoteUrl),
    occurredAt,
    payload,
    idempotencyKey: normalizeNullableText(rawInput.idempotencyKey) || buildEventIdempotencyKey({
      userId: rawInput.userId,
      eventType,
      projectId: rawInput.projectId,
      reviewType: rawInput.reviewType,
      reviewId: rawInput.reviewId,
      recommendationKey: rawInput.recommendationKey,
      occurredAt,
      payload,
    }),
  };
}

function getLocalStatusState() {
  return { ...localSyncState };
}

function emitLocalStatusPatch(patch = {}) {
  const next = {
    ...localSyncState,
    ...patch,
  };
  Object.assign(localSyncState, next);
  if (ioRef) {
    ioRef.emit('review-sync-status', next);
  }
}

function buildRemoteSyncUrl(serverUrl, pathname) {
  return new URL(pathname, `${serverUrl.replace(/\/+$/, '')}/`).toString();
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 15000);

  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = {};
      }
    }
    if (!response.ok) {
      const error = new Error(normalizeText(payload?.error) || response.statusText || 'Sync request failed');
      error.status = response.status;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function getAcceptedIdempotencyKeys(responsePayload = {}) {
  const responseEvents = Array.isArray(responsePayload?.events) ? responsePayload.events : [];
  return new Set(
    responseEvents
      .map((event) => normalizeText(event?.idempotencyKey || event?.eventIdempotencyKey))
      .filter(Boolean)
  );
}

const ALLOWED_CLIENT_SOURCES = new Set(['desktop', 'browser', 'unknown']);

function normalizeClientSource(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ALLOWED_CLIENT_SOURCES.has(v) ? v : null;
}

export async function issueGuestSession({ deviceLabel = null, clientSource = null } = {}, executor = db) {
  const normalizedUserId = randomUUID();
  const normalizedDeviceLabel = normalizeNullableText(deviceLabel);
  const normalizedSource = normalizeClientSource(clientSource);
  const deviceId = randomUUID();
  const authToken = createGuestAuthToken();
  const authTokenHash = hashAuthToken(authToken);
  const generatedId = generateIdIfSqlite() || randomUUID();

  // Create a real user row for this guest so they appear in the admin dashboard
  // and can later be linked to a GitHub identity.
  const guestEmail = `guest-${normalizedUserId.slice(0, 8)}@device.atlasengine.local`;
  const guestName = normalizedDeviceLabel || `Device ${deviceId.slice(0, 8)}`;
  try {
    await executor.query(
      `INSERT INTO users (id, email, name, plan, is_active, client_source)
       VALUES ($1, $2, $3, 'free', TRUE, $4)
       ON CONFLICT (id) DO NOTHING`,
      [normalizedUserId, guestEmail, guestName, normalizedSource]
    );
  } catch (err) {
    // Non-fatal: guest session still works even if user creation fails
    console.warn('[ReviewSync] Failed to create user row for guest session:', err.message);
  }

  const result = await executor.query(
    `INSERT INTO review_sync_sessions (
        id, user_id, device_id, device_label, auth_token_hash, last_seen_at, client_source
     ) VALUES (
        $1, $2, $3, $4, $5, ${getNowExpression()}, $6
     )
     RETURNING *`,
    [generatedId, normalizedUserId, deviceId, normalizedDeviceLabel, authTokenHash, normalizedSource]
  );

  return {
    ...(toSessionRecord(result.rows?.[0] || null) || {
      id: generatedId,
      userId: normalizedUserId,
      deviceId,
      deviceLabel: normalizedDeviceLabel,
      authTokenHash,
      lastSeenAt: null,
      revokedAt: null,
      createdAt: null,
      updatedAt: null,
    }),
    authToken,
  };
}

export async function getGuestSessionByAuthToken(authToken, executor = db) {
  const authTokenHash = hashAuthToken(authToken);
  if (!authTokenHash) return null;

  const result = await executor.query(
    `SELECT *
       FROM review_sync_sessions
      WHERE auth_token_hash = $1
        AND revoked_at IS NULL
      LIMIT 1`,
    [authTokenHash]
  );
  return toSessionRecord(result.rows?.[0] || null);
}

export async function touchGuestSession(sessionId, { deviceLabel = undefined } = {}, executor = db) {
  const normalizedSessionId = normalizeText(sessionId);
  if (!normalizedSessionId) return null;

  const fields = [];
  const values = [normalizedSessionId];
  if (deviceLabel !== undefined) {
    values.push(normalizeNullableText(deviceLabel));
    fields.push(`device_label = COALESCE($${values.length}, device_label)`);
  }
  fields.push(`last_seen_at = ${getNowExpression()}`);
  fields.push(`updated_at = ${getNowExpression()}`);

  const result = await executor.query(
    `UPDATE review_sync_sessions
        SET ${fields.join(', ')}
      WHERE id = $1
      RETURNING *`,
    values
  );
  return toSessionRecord(result.rows?.[0] || null);
}

/**
 * Return the current linked identity for a desktop guest user.
 * `isGuest` is true while `github_user_id` is NULL.
 */
export async function getMe(userId, executor = db) {
  const normalizedUserId = normalizeText(userId);
  if (!normalizedUserId) return null;

  const result = await executor.query(
    `SELECT id, email, github_login, github_avatar_url, github_user_id
       FROM users
      WHERE id = $1
      LIMIT 1`,
    [normalizedUserId]
  );
  const row = result.rows?.[0];
  if (!row) return null;

  return {
    userId: row.id,
    email: row.email || null,
    github_login: row.github_login || null,
    github_avatar_url: row.github_avatar_url || null,
    isGuest: row.github_user_id === null || row.github_user_id === undefined,
  };
}

/**
 * Re-point a guest session's user_id and issue a fresh authToken for it.
 * Used after merge-on-conflict so the desktop client's existing session row
 * now belongs to the GitHub-linked user row.
 */
export async function reissueAuthTokenForUser(targetUserId, { sessionId } = {}, executor = db) {
  const normalizedUserId = normalizeText(targetUserId);
  const normalizedSessionId = normalizeText(sessionId);
  if (!normalizedUserId || !normalizedSessionId) {
    throw new Error('reissueAuthTokenForUser requires targetUserId and sessionId');
  }

  const authToken = createGuestAuthToken();
  const authTokenHash = hashAuthToken(authToken);

  await executor.query(
    `UPDATE review_sync_sessions
        SET user_id = $1,
            auth_token_hash = $2,
            last_seen_at = ${getNowExpression()},
            updated_at = ${getNowExpression()}
      WHERE id = $3`,
    [normalizedUserId, authTokenHash, normalizedSessionId]
  );

  return { authToken };
}

async function ensureDesktopGuestSession({ forceRefresh = false } = {}) {
  if (!isDesktopMode()) {
    return null;
  }

  const currentConfig = getDesktopSyncConfig();
  if (!currentConfig.serverUrl) {
    return null;
  }

  if (!currentConfig.userId) {
    const generatedUserId = randomUUID();
    await persistDesktopSyncRuntimeConfig({ userId: generatedUserId });
  }

  const config = getDesktopSyncConfig();
  if (!forceRefresh && hasDesktopSyncConfig(config)) {
    return config;
  }

  const response = await fetchJson(buildRemoteSyncUrl(config.serverUrl, '/api/review-sync/guest-session'), {
    method: 'POST',
    body: {
      deviceLabel: config.deviceLabel,
      clientSource: 'desktop',
    },
  });
  const session = response?.session || {};
  const nextUserId = normalizeNullableText(session.userId) || config.userId || null;
  const nextDeviceId = normalizeNullableText(session.deviceId);
  const nextAuthToken = normalizeNullableText(session.authToken);
  const nextDeviceLabel = normalizeNullableText(session.deviceLabel) || config.deviceLabel || null;
  if (!nextUserId || !nextDeviceId || !nextAuthToken) {
    throw new Error('Review sync guest session bootstrap returned incomplete credentials.');
  }

  await persistDesktopSyncRuntimeConfig({
    userId: nextUserId,
    deviceId: nextDeviceId,
    authToken: nextAuthToken,
    deviceLabel: nextDeviceLabel,
  });
  await migrateAnonymousPendingEvents(nextUserId);

  return getDesktopSyncConfig();
}

/**
 * Propagate a local identity link/unlink into the remote (Railway) DB.
 *
 * The desktop app's local backend owns identity — sign-in mutates its local
 * SQLite users row. Without this call, Railway's users table keeps seeing
 * the device as a guest with no github_user_id. Fire-and-forget from the
 * link/unlink route handlers; failures are logged but never thrown so
 * offline / network issues don't break local sign-in.
 */
export async function propagateIdentityToRemote({ unlink = false, profile = null } = {}) {
  if (!isDesktopMode()) return { skipped: 'not_desktop_mode' };
  const config = getDesktopSyncConfig();
  if (!config.serverUrl || !config.authToken) {
    return { skipped: 'no_remote_sync_config' };
  }

  const body = unlink ? { unlink: true } : {
    githubUserId: profile?.id,
    githubLogin: profile?.login ?? null,
    githubAvatarUrl: profile?.avatarUrl ?? null,
    email: profile?.email ?? null,
    name: profile?.name ?? null,
  };

  try {
    const response = await fetchJson(buildRemoteSyncUrl(config.serverUrl, '/api/review-sync/identity'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.authToken}`,
      },
      body,
      timeoutMs: 10000,
    });
    // If Railway merged this device into an existing linked user, its
    // session was reissued with a new authToken pointing at the target
    // userId. Persist so subsequent flushes continue to authenticate.
    if (response?.authToken) {
      await persistDesktopSyncRuntimeConfig({
        userId: response.userId || config.userId,
        authToken: response.authToken,
      });
    }
    return { ok: true, merged: Boolean(response?.merged), userId: response?.userId || null };
  } catch (err) {
    console.warn('[ReviewSync] Identity propagation to remote failed (non-fatal):', err.message);
    return { ok: false, error: err.message };
  }
}

let _userRegistrationDone = false;

async function ensureRemoteUserRegistration(config) {
  if (_userRegistrationDone) return;
  if (!config.serverUrl || !config.userId || !config.authToken) return;

  try {
    await fetchJson(buildRemoteSyncUrl(config.serverUrl, '/api/review-sync/ensure-user'), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.authToken}`,
      },
      body: {
        userId: config.userId,
        deviceId: config.deviceId,
        deviceLabel: config.deviceLabel,
      },
      timeoutMs: 10000,
    });
    _userRegistrationDone = true;
  } catch {
    // Non-fatal: user registration is best-effort
  }
}

let _syncSchemaRepaired = false;
let _syncSchemaRepairPromise = null;
async function ensureSyncEventSchema() {
  if (getDbType() !== 'sqlite') return;
  if (_syncSchemaRepaired) return;
  if (_syncSchemaRepairPromise) return _syncSchemaRepairPromise;
  _syncSchemaRepairPromise = (async () => {
    // Migration 007 may have been tracked as applied without actually adding these columns.
    try { await db.query('ALTER TABLE review_sync_events ADD COLUMN repo_identity_hash TEXT'); } catch { /* already exists */ }
    try { await db.query('ALTER TABLE review_sync_events ADD COLUMN repo_remote_url TEXT'); } catch { /* already exists */ }
    _syncSchemaRepaired = true;
  })().catch((error) => {
    _syncSchemaRepairPromise = null;
    throw error;
  });
  return _syncSchemaRepairPromise;
}

export async function queueEvent(rawInput = {}, executor = db) {
  await ensureSyncEventSchema();
  const nowExpr = getNowExpression();
  const event = normalizeQueueInput(rawInput);
  const generatedId = generateIdIfSqlite() || randomUUID();
  const result = await executor.query(
    `INSERT INTO review_sync_events (
        id, user_id, device_id, event_type, sync_status, sync_error, sync_attempt_count, synced_at,
        project_id, project_name, project_path, review_type, review_id, recommendation_key,
        event_idempotency_key, occurred_at, payload_json, repo_identity_hash, repo_remote_url
     ) VALUES (
        $1, $2, $3, $4, $5, NULL, 0,
        CASE WHEN $5 = 'synced' THEN ${nowExpr} ELSE NULL END,
        $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16
     )
     ON CONFLICT (user_id, event_idempotency_key) DO UPDATE SET
       device_id = COALESCE(EXCLUDED.device_id, review_sync_events.device_id),
       event_type = EXCLUDED.event_type,
       sync_status = EXCLUDED.sync_status,
       sync_error = NULL,
       synced_at = CASE
         WHEN EXCLUDED.sync_status = 'synced' THEN COALESCE(review_sync_events.synced_at, ${nowExpr})
         ELSE review_sync_events.synced_at
       END,
       project_id = COALESCE(EXCLUDED.project_id, review_sync_events.project_id),
       project_name = COALESCE(EXCLUDED.project_name, review_sync_events.project_name),
       project_path = COALESCE(EXCLUDED.project_path, review_sync_events.project_path),
       review_type = COALESCE(EXCLUDED.review_type, review_sync_events.review_type),
       review_id = COALESCE(EXCLUDED.review_id, review_sync_events.review_id),
       recommendation_key = COALESCE(EXCLUDED.recommendation_key, review_sync_events.recommendation_key),
       occurred_at = EXCLUDED.occurred_at,
       payload_json = EXCLUDED.payload_json,
       repo_identity_hash = COALESCE(EXCLUDED.repo_identity_hash, review_sync_events.repo_identity_hash),
       repo_remote_url = COALESCE(EXCLUDED.repo_remote_url, review_sync_events.repo_remote_url),
       updated_at = ${nowExpr}
     RETURNING *`,
    [
      generatedId,
      event.userId,
      event.deviceId,
      event.eventType,
      event.syncStatus,
      event.projectId,
      event.projectName,
      event.projectPath,
      event.reviewType,
      event.reviewId,
      event.recommendationKey,
      event.idempotencyKey,
      event.occurredAt,
      toJsonText(event.payload),
      event.repoIdentityHash || null,
      event.repoRemoteUrl || null,
    ]
  );

  return toEventRecord(result.rows?.[0] || null);
}

export async function ingestEvents({ userId, deviceId = null, events = [] } = {}) {
  const normalizedUserId = normalizeUserId(userId);
  const written = [];

  for (const event of Array.isArray(events) ? events : []) {
    const persisted = await queueEvent({
      ...event,
      userId: normalizedUserId,
      deviceId: event.deviceId ?? deviceId ?? null,
      syncStatus: 'synced',
    });
    if (persisted) {
      written.push(persisted);
    }
  }

  return written;
}

export async function listPendingEvents(userId, { limit = DEFAULT_PAGE_LIMIT } = {}) {
  const normalizedUserId = normalizeUserId(userId);
  const cappedLimit = Math.min(MAX_PAGE_LIMIT, Math.max(1, toInt(limit, DEFAULT_PAGE_LIMIT)));
  const result = await db.query(
    `SELECT *
       FROM review_sync_events
      WHERE user_id = $1
        AND sync_status != 'synced'
      ORDER BY occurred_at ASC, created_at ASC
      LIMIT $2`,
    [normalizedUserId, cappedLimit]
  );
  return (result.rows || []).map(toEventRecord).filter(Boolean);
}

export async function acknowledgeEvents(userId, eventIds = []) {
  const normalizedUserId = normalizeUserId(userId);
  const ids = Array.isArray(eventIds)
    ? eventIds.map((value) => normalizeText(value)).filter(Boolean)
    : [];
  if (ids.length === 0) {
    return 0;
  }

  const placeholders = ids.map((_, index) => `$${index + 2}`).join(', ');
  const nowExpr = getNowExpression();
  const result = await db.query(
    `UPDATE review_sync_events
        SET sync_status = 'synced',
            sync_error = NULL,
            synced_at = COALESCE(synced_at, ${nowExpr}),
            updated_at = ${nowExpr}
      WHERE user_id = $1
        AND id IN (${placeholders})`,
    [normalizedUserId, ...ids]
  );
  return toInt(result.rowCount);
}

export async function recordSyncFailure(userId, eventIds = [], errorMessage = null) {
  const normalizedUserId = normalizeUserId(userId);
  const ids = Array.isArray(eventIds)
    ? eventIds.map((value) => normalizeText(value)).filter(Boolean)
    : [];
  if (ids.length === 0) {
    return 0;
  }

  const placeholders = ids.map((_, index) => `$${index + 3}`).join(', ');
  const nowExpr = getNowExpression();
  const result = await db.query(
    `UPDATE review_sync_events
        SET sync_status = 'failed',
            sync_error = $2,
            sync_attempt_count = COALESCE(sync_attempt_count, 0) + 1,
            updated_at = ${nowExpr}
      WHERE user_id = $1
        AND id IN (${placeholders})`,
    [normalizedUserId, normalizeNullableText(errorMessage), ...ids]
  );
  return toInt(result.rowCount);
}

export async function listHistory(userId, { limit = DEFAULT_PAGE_LIMIT } = {}) {
  const normalizedUserId = normalizeUserId(userId);
  const cappedLimit = Math.min(MAX_PAGE_LIMIT, Math.max(1, toInt(limit, DEFAULT_PAGE_LIMIT)));
  const result = await db.query(
    `SELECT *
       FROM review_sync_events
      WHERE user_id = $1
        AND sync_status = 'synced'
      ORDER BY occurred_at DESC, created_at DESC
      LIMIT $2`,
    [normalizedUserId, cappedLimit]
  );
  return (result.rows || []).map(toEventRecord).filter(Boolean);
}

export async function getStats(userId) {
  const normalizedUserId = normalizeUserId(userId);
  const result = await db.query(
    `SELECT *
       FROM review_sync_events
      WHERE user_id = $1
        AND sync_status = 'synced'
      ORDER BY occurred_at ASC, created_at ASC`,
    [normalizedUserId]
  );

  const rows = (result.rows || []).map(toEventRecord).filter(Boolean);
  const latestFindingState = new Map();
  const publishedReviewScopes = new Set();
  let reviewsCompleted = 0;
  let issuesFound = 0;
  let highRiskFindings = 0;
  let lastSyncedAt = null;

  for (const row of rows) {
    if (row.syncedAt) {
      lastSyncedAt = row.syncedAt;
    }
    if (row.eventType === 'review_completed') {
      reviewsCompleted += 1;
      issuesFound += toInt(row.payload.issuesFound);
      highRiskFindings += toInt(row.payload.highRiskFindings);
    }
    if (row.eventType === 'review_published') {
      publishedReviewScopes.add([row.projectId, row.reviewType, row.reviewId].join('|'));
    }
    if (
      row.eventType === 'finding_addressed'
      || row.eventType === 'finding_dismissed'
      || row.eventType === 'finding_cleared'
    ) {
      const key = [row.projectId, row.reviewType, row.reviewId, row.recommendationKey].join('|');
      latestFindingState.set(key, row.eventType);
    }
  }

  let findingsAddressed = 0;
  let findingsDismissed = 0;
  for (const state of latestFindingState.values()) {
    if (state === 'finding_addressed') findingsAddressed += 1;
    if (state === 'finding_dismissed') findingsDismissed += 1;
  }

  const totalResolvedFindings = findingsAddressed + findingsDismissed;
  const fixRate = issuesFound > 0 ? Number((findingsAddressed / issuesFound).toFixed(4)) : null;
  const resolutionRate = issuesFound > 0 ? Number((totalResolvedFindings / issuesFound).toFixed(4)) : null;

  return {
    reviewsCompleted,
    issuesFound,
    highRiskFindings,
    findingsAddressed,
    findingsDismissed,
    totalResolvedFindings,
    fixRate,
    resolutionRate,
    publishedReviews: publishedReviewScopes.size,
    pendingEvents: 0,
    lastSyncedAt,
    totalEvents: rows.length,
  };
}

export async function getLocalSyncStatus() {
  const config = getDesktopSyncConfig();
  if (config.userId) {
    await migrateAnonymousPendingEvents(config.userId);
  }
  const pendingEvents = await listPendingEvents(config.userId || ANONYMOUS_USER_ID, {
    limit: MAX_PAGE_LIMIT,
  });
  return {
    enabled: isDesktopMode(),
    configured: Boolean(config.serverUrl && config.userId),
    serverUrl: config.serverUrl,
    userId: config.userId,
    deviceId: config.deviceId,
    pendingEvents: pendingEvents.length,
    ...getLocalStatusState(),
  };
}

export async function flushPendingEvents() {
  if (!isDesktopMode()) {
    return { status: 'disabled', reason: 'desktop_only' };
  }

  let config = getDesktopSyncConfig();
  if (!config.serverUrl) {
    const currentStatus = await getLocalSyncStatus();
    emitLocalStatusPatch({
      state: currentStatus.pendingEvents > 0 ? 'error' : 'disabled',
      lastError: currentStatus.pendingEvents > 0
        ? 'Review sync server URL is not configured.'
        : null,
    });
    return { status: 'disabled', pendingEvents: currentStatus.pendingEvents };
  }

  try {
    config = await ensureDesktopGuestSession() || config;
    // Ensure user row exists on Railway (fire-and-forget).
    // Existing users with cached sessions skip issueGuestSession,
    // so this ensures they still get a users row on the cloud side.
    if (config.serverUrl && config.userId && config.authToken) {
      ensureRemoteUserRegistration(config).catch(() => {});
    }
  } catch (error) {
    const currentStatus = await getLocalSyncStatus();
    emitLocalStatusPatch({
      state: currentStatus.pendingEvents > 0 ? 'error' : 'disabled',
      lastError: error?.message || 'Review sync guest session bootstrap failed',
    });
    return {
      status: 'error',
      pendingEvents: currentStatus.pendingEvents,
      error: error?.message || 'Review sync guest session bootstrap failed',
    };
  }

  const currentStatus = await getLocalSyncStatus();
  if (config.userId) {
    await migrateAnonymousPendingEvents(config.userId);
  }

  const pendingEvents = await listPendingEvents(config.userId, { limit: MAX_PAGE_LIMIT });
  if (pendingEvents.length === 0) {
    emitLocalStatusPatch({ state: 'idle', lastError: null });
    return { status: 'idle', pendingEvents: 0 };
  }

  emitLocalStatusPatch({
    state: 'syncing',
    lastAttemptAt: new Date().toISOString(),
    lastError: null,
  });

  let response = null;
  let finalError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetchJson(buildRemoteSyncUrl(config.serverUrl, '/api/review-sync/events/batch'), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.authToken}`,
          'Content-Type': 'application/json',
        },
        body: {
          deviceLabel: config.deviceLabel,
          events: pendingEvents.map((event) => ({
            eventType: event.eventType,
            projectId: event.projectId,
            projectName: event.projectName,
            projectPath: event.projectPath,
            repoIdentityHash: event.repoIdentityHash,
            repoRemoteUrl: event.repoRemoteUrl,
            reviewType: event.reviewType,
            reviewId: event.reviewId,
            recommendationKey: event.recommendationKey,
            occurredAt: event.occurredAt,
            payload: event.payload,
            idempotencyKey: event.idempotencyKey,
          })),
        },
      });
      finalError = null;
      break;
    } catch (error) {
      finalError = error;
      if ((error?.status === 401 || error?.status === 403) && attempt === 0) {
        try {
          await persistDesktopSyncRuntimeConfig({ authToken: null, deviceId: null });
          config = await ensureDesktopGuestSession({ forceRefresh: true }) || getDesktopSyncConfig();
        } catch (refreshError) {
          finalError = refreshError;
          break;
        }
        continue;
      }
      break;
    }
  }

  if (!response) {
    await recordSyncFailure(
      config.userId,
      pendingEvents.map((event) => event.id),
      finalError?.message || 'Review sync failed'
    );
    emitLocalStatusPatch({
      state: 'error',
      lastError: finalError?.message || 'Review sync failed',
    });
    return {
      status: 'error',
      pendingEvents: pendingEvents.length,
      error: finalError?.message || 'Review sync failed',
    };
  }

  const acceptedIdempotencyKeys = getAcceptedIdempotencyKeys(response);
  const acknowledgedTargets = pendingEvents
    .filter((event) => acceptedIdempotencyKeys.has(event.idempotencyKey))
    .map((event) => event.id);
  const failedTargets = pendingEvents
    .filter((event) => !acceptedIdempotencyKeys.has(event.idempotencyKey))
    .map((event) => event.id);

  const acknowledged = await acknowledgeEvents(
    config.userId,
    acknowledgedTargets
  );
  if (failedTargets.length > 0) {
    await recordSyncFailure(config.userId, failedTargets, 'Not acknowledged by server');
  }

  const syncedAt = acknowledged > 0 ? new Date().toISOString() : currentStatus.lastSyncedAt;
  const partialFailureMessage = failedTargets.length > 0
    ? `${failedTargets.length} event(s) were not acknowledged by server.`
    : null;
  emitLocalStatusPatch({
    state: failedTargets.length > 0 ? 'error' : 'idle',
    lastSyncedAt: syncedAt,
    lastError: partialFailureMessage,
  });
  return {
    status: failedTargets.length > 0 ? 'partial' : 'synced',
    acknowledged,
    pendingEvents: failedTargets.length,
    error: partialFailureMessage,
  };
}

export function buildReviewCompletedEvent({
  userId,
  projectId,
  projectName = null,
  projectPath = null,
  reviewType,
  reviewId,
  displayId = null,
  branchName = null,
  reviewStatus = null,
  reviewReliability = null,
  providerType = null,
  providerModel = null,
  completedAt,
  issuesFound = 0,
  highRiskFindings = 0,
  inputTokens = 0,
  outputTokens = 0,
  totalTokens = null,
  estimatedCost = 0,
  costSource = null,
  costIsApproximate = null,
  repoRemoteUrl = null,
} = {}) {
  const normalizedInputTokens = toInt(inputTokens);
  const normalizedOutputTokens = toInt(outputTokens);
  const normalizedTotalTokens = totalTokens == null
    ? (normalizedInputTokens + normalizedOutputTokens)
    : toInt(totalTokens);
  const normalizedEstimatedCost = Number.isFinite(Number(estimatedCost))
    ? Math.max(0, Number(estimatedCost))
    : 0;
  return {
    userId,
    eventType: 'review_completed',
    projectId,
    projectName,
    projectPath,
    repoIdentityHash: hashRepoUrl(repoRemoteUrl),
    repoRemoteUrl: normalizeRepoUrl(repoRemoteUrl),
    reviewType,
    reviewId,
    occurredAt: completedAt,
    payload: {
      displayId,
      branchName,
      reviewStatus,
      reviewReliability,
      providerType,
      providerModel,
      issuesFound: toInt(issuesFound),
      highRiskFindings: toInt(highRiskFindings),
      inputTokens: normalizedInputTokens,
      outputTokens: normalizedOutputTokens,
      totalTokens: normalizedTotalTokens,
      estimatedCost: normalizedEstimatedCost,
      costSource: normalizeNullableText(costSource),
      costIsApproximate: typeof costIsApproximate === 'boolean' ? costIsApproximate : null,
    },
  };
}

export function buildFindingOutcomeEvent({
  userId,
  projectId,
  projectName = null,
  projectPath = null,
  reviewType,
  reviewId,
  recommendationKey,
  occurredAt,
  status,
  note = null,
  dimensions = {},
} = {}) {
  const normalizedStatus = normalizeText(status).toLowerCase();
  const eventType = normalizedStatus === 'dismissed' ? 'finding_dismissed' : 'finding_addressed';
  return {
    userId,
    eventType,
    projectId,
    projectName,
    projectPath,
    reviewType,
    reviewId,
    recommendationKey,
    occurredAt,
    payload: {
      status: normalizedStatus,
      note: normalizeNullableText(note),
      dimensions: normalizePayload(dimensions),
    },
  };
}

export function buildFindingClearedEvent({
  userId,
  projectId,
  projectName = null,
  projectPath = null,
  reviewType,
  reviewId,
  recommendationKey,
  occurredAt,
} = {}) {
  return {
    userId,
    eventType: 'finding_cleared',
    projectId,
    projectName,
    projectPath,
    reviewType,
    reviewId,
    recommendationKey,
    occurredAt,
    payload: {},
  };
}

export function buildReviewPublishedEvent({
  userId,
  projectId,
  projectName = null,
  projectPath = null,
  reviewType,
  reviewId,
  recommendationKey,
  occurredAt,
  action,
  channel,
  githubPrNumber = null,
  headSha = null,
} = {}) {
  return {
    userId,
    eventType: 'review_published',
    projectId,
    projectName,
    projectPath,
    reviewType,
    reviewId,
    recommendationKey,
    occurredAt,
    payload: {
      action: normalizeNullableText(action),
      channel: normalizeNullableText(channel),
      githubPrNumber: githubPrNumber == null ? null : Number(githubPrNumber),
      headSha: normalizeNullableText(headSha),
    },
  };
}

export function buildFixRunCompletedEvent({
  userId,
  projectId,
  projectName = null,
  projectPath = null,
  reviewType,
  reviewId,
  runId,
  runStatus,
  providerType = null,
  providerModel = null,
  completedAt,
  findingsSelected = 0,
  findingsPatched = 0,
  findingsFailed = 0,
  filesChanged = 0,
  repoRemoteUrl = null,
} = {}) {
  const normalizedRunId = normalizeNullableText(runId);
  return {
    userId,
    eventType: 'fix_run_completed',
    idempotencyKey: `fix_run_completed:${normalizedRunId || randomUUID()}`,
    projectId,
    projectName,
    projectPath,
    repoIdentityHash: hashRepoUrl(repoRemoteUrl),
    repoRemoteUrl: normalizeRepoUrl(repoRemoteUrl),
    reviewType,
    reviewId,
    occurredAt: completedAt,
    payload: {
      runId: normalizedRunId,
      runStatus: normalizeNullableText(runStatus),
      providerType: normalizeNullableText(providerType),
      providerModel: normalizeNullableText(providerModel),
      findingsSelected: toInt(findingsSelected),
      findingsPatched: toInt(findingsPatched),
      findingsFailed: toInt(findingsFailed),
      filesChanged: toInt(filesChanged),
    },
  };
}

export function buildChatMessageSentEvent({
  userId,
  projectId,
  projectName = null,
  projectPath = null,
  providerType = null,
  providerModel = null,
  occurredAt = null,
  messageLength = 0,
  attachmentCount = 0,
  hasUiSelection = false,
  hasUiEdits = false,
  isSlashCommand = false,
  repoRemoteUrl = null,
} = {}) {
  return {
    userId,
    eventType: 'chat_message_sent',
    // Each chat send is its own event; randomize so retries / re-renders
    // don't dedupe via the (user, idempotency_key) unique constraint.
    idempotencyKey: `chat_message_sent:${randomUUID()}`,
    projectId,
    projectName,
    projectPath,
    // review_type / review_id are NOT NULL in review_sync_events but chat
    // events have no review scope. Use a sentinel so the row inserts without
    // affecting metrics queries (which filter by event_type).
    reviewType: 'chat',
    reviewId: 'chat',
    repoIdentityHash: hashRepoUrl(repoRemoteUrl),
    repoRemoteUrl: normalizeRepoUrl(repoRemoteUrl),
    occurredAt: occurredAt || new Date().toISOString(),
    payload: {
      providerType: normalizeNullableText(providerType),
      providerModel: normalizeNullableText(providerModel),
      // Length only — we never send the message body itself.
      messageLength: toInt(messageLength),
      attachmentCount: toInt(attachmentCount),
      hasUiSelection: Boolean(hasUiSelection),
      hasUiEdits: Boolean(hasUiEdits),
      isSlashCommand: Boolean(isSlashCommand),
    },
  };
}

export function buildWalkthroughGeneratedEvent({
  userId,
  projectId,
  projectName = null,
  projectPath = null,
  baseSha = null,
  headSha = null,
  reviewType = null,
  reviewId = null,
  providerType = null,
  providerModel = null,
  occurredAt = null,
  stepCount = 0,
  fileCount = 0,
  incremental = false,
  cached = false,
  noChanges = false,
  repoRemoteUrl = null,
} = {}) {
  const normalizedHead = normalizeNullableText(headSha);
  const normalizedBase = normalizeNullableText(baseSha);
  // Idempotency: one event per (project, base, head) walkthrough save. Repeated
  // generations with the same SHAs (e.g. cache hits) collapse into a single row.
  const idempotencySuffix = normalizedHead
    ? `${normalizeNullableText(projectId) || 'np'}:${normalizedBase || 'nb'}:${normalizedHead}`
    : randomUUID();
  return {
    userId,
    eventType: 'walkthrough_generated',
    idempotencyKey: `walkthrough_generated:${idempotencySuffix}`,
    projectId,
    projectName,
    projectPath,
    // Sentinels for NOT NULL columns: walkthroughs are scoped to a base/head
    // pair, not a review. Use stable sentinel + actual reviewType/Id when known.
    reviewType: normalizeNullableText(reviewType) || 'walkthrough',
    reviewId: normalizeNullableText(reviewId) || normalizedHead || 'walkthrough',
    repoIdentityHash: hashRepoUrl(repoRemoteUrl),
    repoRemoteUrl: normalizeRepoUrl(repoRemoteUrl),
    occurredAt: occurredAt || new Date().toISOString(),
    payload: {
      baseSha: normalizedBase,
      headSha: normalizedHead,
      providerType: normalizeNullableText(providerType),
      providerModel: normalizeNullableText(providerModel),
      stepCount: toInt(stepCount),
      fileCount: toInt(fileCount),
      incremental: Boolean(incremental),
      cached: Boolean(cached),
      noChanges: Boolean(noChanges),
    },
  };
}

export function buildWalkthroughStepReadEvent({
  userId,
  projectId,
  projectName = null,
  projectPath = null,
  baseSha = null,
  headSha = null,
  stepIndex = 0,
  occurredAt = null,
  repoRemoteUrl = null,
} = {}) {
  const normalizedHead = normalizeNullableText(headSha);
  const normalizedBase = normalizeNullableText(baseSha);
  const normalizedProject = normalizeNullableText(projectId);
  // Idempotent per (project, base, head, step) so repeated toggles of the same
  // step never inflate counts.
  const idempotencySuffix = normalizedHead
    ? `${normalizedProject || 'np'}:${normalizedBase || 'nb'}:${normalizedHead}:${toInt(stepIndex)}`
    : randomUUID();
  return {
    userId,
    eventType: 'walkthrough_step_read',
    idempotencyKey: `walkthrough_step_read:${idempotencySuffix}`,
    projectId,
    projectName,
    projectPath,
    reviewType: 'walkthrough',
    reviewId: normalizedHead || 'walkthrough',
    repoIdentityHash: hashRepoUrl(repoRemoteUrl),
    repoRemoteUrl: normalizeRepoUrl(repoRemoteUrl),
    occurredAt: occurredAt || new Date().toISOString(),
    payload: {
      baseSha: normalizedBase,
      headSha: normalizedHead,
      stepIndex: toInt(stepIndex),
    },
  };
}

export function startDesktopSyncWorker(io = null) {
  ioRef = io;
  if (!isDesktopMode() || flushTimer) return;

  flushPendingEvents().catch((error) => {
    emitLocalStatusPatch({
      state: 'error',
      lastError: error?.message || 'Review sync failed',
      lastAttemptAt: new Date().toISOString(),
    });
  });

  flushTimer = setInterval(() => {
    flushPendingEvents().catch((error) => {
      emitLocalStatusPatch({
        state: 'error',
        lastError: error?.message || 'Review sync failed',
        lastAttemptAt: new Date().toISOString(),
      });
    });
  }, SYNC_FLUSH_INTERVAL_MS);
}

export function stopDesktopSyncWorker() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
}

const reviewSyncService = {
  issueGuestSession,
  getGuestSessionByAuthToken,
  touchGuestSession,
  getMe,
  reissueAuthTokenForUser,
  propagateIdentityToRemote,
  queueEvent,
  ingestEvents,
  listPendingEvents,
  acknowledgeEvents,
  recordSyncFailure,
  listHistory,
  getStats,
  getLocalSyncStatus,
  flushPendingEvents,
  buildReviewCompletedEvent,
  buildFindingOutcomeEvent,
  buildFindingClearedEvent,
  buildReviewPublishedEvent,
  buildFixRunCompletedEvent,
  buildChatMessageSentEvent,
  buildWalkthroughGeneratedEvent,
  buildWalkthroughStepReadEvent,
  startDesktopSyncWorker,
  stopDesktopSyncWorker,
  __testing: {
    normalizeQueueInput,
    buildEventIdempotencyKey,
    toEventRecord,
    toSessionRecord,
    hashAuthToken,
    hasDesktopSyncConfig,
    getDesktopSyncConfig,
    getAcceptedIdempotencyKeys,
    ensureDesktopGuestSession,
    migrateAnonymousPendingEvents,
    resetSyncSchemaRepairState: () => {
      _syncSchemaRepaired = false;
      _syncSchemaRepairPromise = null;
    },
  },
};

export default reviewSyncService;
