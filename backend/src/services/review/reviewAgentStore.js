import { randomUUID } from 'crypto';
import db, { getDbType } from '../../db/connection.js';

const VALID_REVIEW_TYPES = new Set(['changeset', 'branch_review', 'workspace_review', 'pr_review']);
const VALID_ROLES = new Set(['user', 'assistant', 'system', 'tool']);
const VALID_STATUSES = new Set(['active', 'deleted']);
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;

let schemaReady = false;
let schemaReadyPromise = null;

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeScope(rawScope = {}) {
  const projectId = normalizeText(rawScope.projectId);
  const reviewType = normalizeText(rawScope.reviewType).toLowerCase();
  const reviewId = normalizeText(rawScope.reviewId);

  if (!projectId) throw new Error('projectId is required for review agent sessions');
  if (!reviewId) throw new Error('reviewId is required for review agent sessions');
  if (!VALID_REVIEW_TYPES.has(reviewType)) {
    throw new Error('reviewType must be one of: changeset, branch_review, workspace_review, pr_review');
  }

  return { projectId, reviewType, reviewId };
}

function normalizeSessionId(value) {
  const sessionId = normalizeText(value);
  if (!sessionId) throw new Error('sessionId is required for review agent chat');
  return sessionId;
}

function normalizeMessageId(value) {
  const messageId = normalizeText(value);
  if (!messageId) throw new Error('messageId is required for review agent chat');
  return messageId;
}

function normalizeRole(value) {
  const role = normalizeText(value).toLowerCase();
  if (!VALID_ROLES.has(role)) {
    throw new Error('role must be one of: user, assistant, system, tool');
  }
  return role;
}

function normalizeStatus(value, fallback = 'active') {
  const status = normalizeText(value).toLowerCase();
  if (!status) return fallback;
  if (!VALID_STATUSES.has(status)) {
    throw new Error('Invalid review agent session status');
  }
  return status;
}

function normalizeLimit(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(parsed)));
}

function serializeMeta(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return JSON.stringify(value);
}

function parseMeta(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function getNowExpression() {
  return getDbType() === 'sqlite' ? "datetime('now')" : 'NOW()';
}

async function ensureSchema() {
  if (schemaReady) return;
  if (schemaReadyPromise) {
    await schemaReadyPromise;
    return;
  }

  schemaReadyPromise = (async () => {
    if (getDbType() === 'sqlite') {
      await db.query(`
        CREATE TABLE IF NOT EXISTS review_agent_sessions (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          user_id TEXT,
          review_type TEXT NOT NULL,
          review_id TEXT NOT NULL,
          provider_type TEXT,
          provider_model TEXT,
          provider_session_id TEXT,
          title TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_review_agent_sessions_scope
          ON review_agent_sessions(project_id, review_type, review_id, updated_at DESC)
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS review_agent_messages (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
          content TEXT NOT NULL DEFAULT '',
          tokens_used INTEGER DEFAULT 0,
          model TEXT,
          meta TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        )
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_review_agent_messages_session
          ON review_agent_messages(session_id, created_at ASC)
      `);
    } else {
      await db.query(`
        CREATE TABLE IF NOT EXISTS review_agent_sessions (
          id UUID PRIMARY KEY,
          project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          review_type TEXT NOT NULL,
          review_id TEXT NOT NULL,
          provider_type TEXT,
          provider_model TEXT,
          provider_session_id TEXT,
          title TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_review_agent_sessions_scope
          ON review_agent_sessions(project_id, review_type, review_id, updated_at DESC)
      `);
      await db.query(`
        CREATE TABLE IF NOT EXISTS review_agent_messages (
          id UUID PRIMARY KEY,
          session_id UUID NOT NULL REFERENCES review_agent_sessions(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
          content TEXT NOT NULL DEFAULT '',
          tokens_used INT DEFAULT 0,
          model TEXT,
          meta JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await db.query(`
        CREATE INDEX IF NOT EXISTS idx_review_agent_messages_session
          ON review_agent_messages(session_id, created_at ASC)
      `);
    }
    schemaReady = true;
  })();

  try {
    await schemaReadyPromise;
  } finally {
    schemaReadyPromise = null;
  }
}

function toSession(row) {
  if (!row) return null;
  return {
    id: normalizeText(row.id),
    projectId: normalizeText(row.project_id),
    userId: normalizeText(row.user_id) || null,
    reviewType: normalizeText(row.review_type).toLowerCase(),
    reviewId: normalizeText(row.review_id),
    providerType: normalizeText(row.provider_type) || null,
    providerModel: normalizeText(row.provider_model) || null,
    providerSessionId: normalizeText(row.provider_session_id) || null,
    title: normalizeText(row.title) || null,
    status: normalizeStatus(row.status),
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
  };
}

function toMessage(row) {
  if (!row) return null;
  return {
    id: normalizeText(row.id),
    sessionId: normalizeText(row.session_id),
    role: normalizeRole(row.role),
    content: typeof row.content === 'string' ? row.content : '',
    tokensUsed: Math.max(0, Math.trunc(Number(row.tokens_used) || 0)),
    model: normalizeText(row.model) || null,
    meta: parseMeta(row.meta),
    createdAt: row.created_at || null,
  };
}

async function listSessions(rawScope) {
  await ensureSchema();
  const scope = normalizeScope(rawScope);
  const result = await db.query(
    `SELECT id, project_id, user_id, review_type, review_id, provider_type, provider_model,
       provider_session_id, title, status, created_at, updated_at
     FROM review_agent_sessions
     WHERE project_id = $1
       AND review_type = $2
       AND review_id = $3
       AND status != 'deleted'
     ORDER BY updated_at DESC, created_at DESC`,
    [scope.projectId, scope.reviewType, scope.reviewId]
  );
  return (result.rows || []).map(toSession).filter(Boolean);
}

async function getSession(sessionId, rawScope = null) {
  await ensureSchema();
  const normalizedSessionId = normalizeSessionId(sessionId);
  const params = [normalizedSessionId];
  let whereSql = 'id = $1';
  if (rawScope) {
    const scope = normalizeScope(rawScope);
    whereSql += ' AND project_id = $2 AND review_type = $3 AND review_id = $4';
    params.push(scope.projectId, scope.reviewType, scope.reviewId);
  }

  const result = await db.query(
    `SELECT id, project_id, user_id, review_type, review_id, provider_type, provider_model,
       provider_session_id, title, status, created_at, updated_at
     FROM review_agent_sessions
     WHERE ${whereSql}
     LIMIT 1`,
    params
  );
  return toSession(result.rows?.[0] || null);
}

async function createSession(rawInput = {}) {
  await ensureSchema();
  const scope = normalizeScope(rawInput);
  const id = normalizeText(rawInput.sessionId) || randomUUID();
  const userId = normalizeText(rawInput.userId) || null;
  const providerType = normalizeText(rawInput.providerType) || null;
  const providerModel = normalizeText(rawInput.providerModel) || null;
  const title = normalizeText(rawInput.title) || null;
  const status = normalizeStatus(rawInput.status);

  const result = await db.query(
    `INSERT INTO review_agent_sessions (
       id, project_id, user_id, review_type, review_id, provider_type, provider_model, title, status
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, project_id, user_id, review_type, review_id, provider_type, provider_model,
       provider_session_id, title, status, created_at, updated_at`,
    [id, scope.projectId, userId, scope.reviewType, scope.reviewId, providerType, providerModel, title, status]
  );
  return toSession(result.rows?.[0] || null);
}

async function getOrCreateSession(rawInput = {}) {
  const sessions = await listSessions(rawInput);
  const active = sessions.find((session) => session.status === 'active');
  if (active) return active;
  return createSession(rawInput);
}

async function updateSession(sessionId, rawPatch = {}) {
  await ensureSchema();
  const normalizedSessionId = normalizeSessionId(sessionId);
  const patch = {};
  if ('providerType' in rawPatch) patch.provider_type = normalizeText(rawPatch.providerType) || null;
  if ('providerModel' in rawPatch) patch.provider_model = normalizeText(rawPatch.providerModel) || null;
  if ('providerSessionId' in rawPatch) patch.provider_session_id = normalizeText(rawPatch.providerSessionId) || null;
  if ('title' in rawPatch) patch.title = normalizeText(rawPatch.title) || null;
  if ('status' in rawPatch) patch.status = normalizeStatus(rawPatch.status);

  const entries = Object.entries(patch);
  if (entries.length === 0) {
    return getSession(normalizedSessionId);
  }

  const setSql = entries
    .map(([key], index) => `${key} = $${index + 2}`)
    .join(', ');
  const values = [normalizedSessionId, ...entries.map(([, value]) => value)];
  const result = await db.query(
    `UPDATE review_agent_sessions
       SET ${setSql}, updated_at = ${getNowExpression()}
     WHERE id = $1
     RETURNING id, project_id, user_id, review_type, review_id, provider_type, provider_model,
       provider_session_id, title, status, created_at, updated_at`,
    values
  );
  return toSession(result.rows?.[0] || null);
}

async function deleteSession(sessionId, rawScope = null) {
  await ensureSchema();
  const session = await getSession(sessionId, rawScope);
  if (!session) return false;
  await db.query('DELETE FROM review_agent_messages WHERE session_id = $1', [session.id]);
  await db.query('DELETE FROM review_agent_sessions WHERE id = $1', [session.id]);
  return true;
}

async function listMessages(sessionId, options = {}) {
  await ensureSchema();
  const normalizedSessionId = normalizeSessionId(sessionId);
  const limit = normalizeLimit(options.limit);
  const result = await db.query(
    `SELECT id, session_id, role, content, tokens_used, model, meta, created_at
     FROM review_agent_messages
     WHERE session_id = $1
     ORDER BY created_at ASC
     LIMIT $2`,
    [normalizedSessionId, limit]
  );
  return (result.rows || []).map(toMessage).filter(Boolean);
}

async function getMessage(sessionId, messageId) {
  await ensureSchema();
  const normalizedSessionId = normalizeSessionId(sessionId);
  const normalizedMessageId = normalizeMessageId(messageId);
  const result = await db.query(
    `SELECT id, session_id, role, content, tokens_used, model, meta, created_at
     FROM review_agent_messages
     WHERE session_id = $1 AND id = $2
     LIMIT 1`,
    [normalizedSessionId, normalizedMessageId]
  );
  return toMessage(result.rows?.[0] || null);
}

async function saveMessage(rawInput = {}) {
  await ensureSchema();
  const sessionId = normalizeSessionId(rawInput.sessionId);
  const id = normalizeText(rawInput.messageId) || randomUUID();
  const role = normalizeRole(rawInput.role);
  const content = typeof rawInput.content === 'string' ? rawInput.content : '';
  const tokensUsed = Math.max(0, Math.trunc(Number(rawInput.tokensUsed) || 0));
  const model = normalizeText(rawInput.model) || null;
  const meta = serializeMeta(rawInput.meta);
  const metaValue = getDbType() === 'sqlite' ? meta : meta ? JSON.parse(meta) : null;

  const result = await db.query(
    `INSERT INTO review_agent_messages (id, session_id, role, content, tokens_used, model, meta)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, session_id, role, content, tokens_used, model, meta, created_at`,
    [id, sessionId, role, content, tokensUsed, model, metaValue]
  );
  await db.query(
    `UPDATE review_agent_sessions SET updated_at = ${getNowExpression()} WHERE id = $1`,
    [sessionId]
  );
  return toMessage(result.rows?.[0] || null);
}

async function updateMessageMeta(sessionId, messageId, meta) {
  await ensureSchema();
  const normalizedSessionId = normalizeSessionId(sessionId);
  const normalizedMessageId = normalizeMessageId(messageId);
  const serializedMeta = serializeMeta(meta);
  const metaValue = getDbType() === 'sqlite' ? serializedMeta : serializedMeta ? JSON.parse(serializedMeta) : null;
  const result = await db.query(
    `UPDATE review_agent_messages
       SET meta = $3
     WHERE session_id = $1 AND id = $2
     RETURNING id, session_id, role, content, tokens_used, model, meta, created_at`,
    [normalizedSessionId, normalizedMessageId, metaValue]
  );
  await db.query(
    `UPDATE review_agent_sessions SET updated_at = ${getNowExpression()} WHERE id = $1`,
    [normalizedSessionId]
  );
  return toMessage(result.rows?.[0] || null);
}

async function recordMessageActionResult(sessionId, messageId, actionKey, result) {
  const message = await getMessage(sessionId, messageId);
  if (!message) return null;
  const normalizedActionKey = normalizeText(actionKey);
  if (!normalizedActionKey) throw new Error('actionKey is required for review agent action results');
  const currentMeta = message.meta && typeof message.meta === 'object' && !Array.isArray(message.meta)
    ? message.meta
    : {};
  const currentResults = currentMeta.actionResults && typeof currentMeta.actionResults === 'object' && !Array.isArray(currentMeta.actionResults)
    ? currentMeta.actionResults
    : {};
  return updateMessageMeta(sessionId, messageId, {
    ...currentMeta,
    actionResults: {
      ...currentResults,
      [normalizedActionKey]: result && typeof result === 'object' && !Array.isArray(result) ? result : {},
    },
  });
}

export default {
  ensureSchema,
  normalizeScope,
  listSessions,
  getSession,
  createSession,
  getOrCreateSession,
  updateSession,
  deleteSession,
  listMessages,
  getMessage,
  saveMessage,
  updateMessageMeta,
  recordMessageActionResult,
  __testing: {
    toSession,
    toMessage,
    parseMeta,
    normalizeMessageId,
  },
};
