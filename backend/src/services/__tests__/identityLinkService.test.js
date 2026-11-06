import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * identityLinkService tests.
 *
 * Uses a mocked connection module where `query` is backed by an in-memory
 * SQLite database. This mirrors the desktop app's runtime database and lets
 * the service exercise real SQL without hitting Postgres.
 */

import Database from 'better-sqlite3';

let sqliteDb;
const queryMock = vi.fn();
const transactionMock = vi.fn(async (callback) => {
  sqliteDb.exec('BEGIN');
  try {
    const result = await callback({
      query: (sql, params = []) => runSqlite(sql, params),
    });
    sqliteDb.exec('COMMIT');
    return result;
  } catch (err) {
    try { sqliteDb.exec('ROLLBACK'); } catch { /* noop */ }
    throw err;
  }
});

vi.mock('../../db/connection.js', () => ({
  default: {
    query: (...args) => queryMock(...args),
    transaction: (...args) => transactionMock(...args),
  },
  query: (...args) => queryMock(...args),
  transaction: (...args) => transactionMock(...args),
  getDbType: () => 'sqlite',
}));

function runSqlite(sql, params = []) {
  // Convert $1/$2 parameter placeholders to ? for better-sqlite3.
  const converted = String(sql).replace(/\$(\d+)/g, '?');
  const stmt = sqliteDb.prepare(converted);
  const trimmed = converted.trim().toUpperCase();
  if (trimmed.startsWith('SELECT') || / RETURNING /i.test(converted)) {
    const rows = stmt.all(...params);
    return { rows, rowCount: rows.length };
  }
  const info = stmt.run(...params);
  return { rows: [], rowCount: info.changes };
}

function setupSchema() {
  sqliteDb = new Database(':memory:');
  sqliteDb.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT,
      name TEXT,
      plan TEXT DEFAULT 'free',
      is_active INTEGER DEFAULT 1,
      github_login TEXT,
      github_avatar_url TEXT,
      github_user_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX idx_users_github_user_id
      ON users(github_user_id) WHERE github_user_id IS NOT NULL;

    CREATE TABLE user_quotas (
      user_id TEXT PRIMARY KEY,
      tokens_used_this_month INTEGER DEFAULT 0,
      cost_this_month REAL DEFAULT 0,
      requests_this_hour INTEGER DEFAULT 0,
      builds_today INTEGER DEFAULT 0,
      quota_exceeded INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE review_sync_events (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      event_type TEXT
    );

    CREATE TABLE review_sync_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL
    );

    CREATE TABLE usage_ledger (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      amount INTEGER DEFAULT 0
    );

    CREATE TABLE chat_stream_state (
      session_id TEXT PRIMARY KEY,
      stream_state TEXT
    );
  `);

  queryMock.mockImplementation(async (sql, params = []) => runSqlite(sql, params));
}

beforeEach(() => {
  vi.clearAllMocks();
  setupSchema();
  // Reinstall the impl after clearAllMocks.
  queryMock.mockImplementation(async (sql, params = []) => runSqlite(sql, params));
  transactionMock.mockImplementation(async (callback) => {
    sqliteDb.exec('BEGIN');
    try {
      const result = await callback({
        query: async (sql, params = []) => runSqlite(sql, params),
      });
      sqliteDb.exec('COMMIT');
      return result;
    } catch (err) {
      try { sqliteDb.exec('ROLLBACK'); } catch { /* noop */ }
      throw err;
    }
  });

  // Mock GitHub fetch by default.
  globalThis.fetch = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      id: 4242,
      login: 'octocat',
      avatar_url: 'https://example.com/octocat.png',
      email: 'octocat@example.com',
    }),
  }));
});

function insertUser(id, overrides = {}) {
  const row = {
    email: `guest-${id.slice(0, 8)}@device.atlasengine.local`,
    name: null,
    github_login: null,
    github_avatar_url: null,
    github_user_id: null,
    ...overrides,
  };
  sqliteDb
    .prepare(`INSERT INTO users (id, email, name, github_login, github_avatar_url, github_user_id)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, row.email, row.name, row.github_login, row.github_avatar_url, row.github_user_id);
  sqliteDb.prepare('INSERT INTO user_quotas (user_id, tokens_used_this_month) VALUES (?, ?)').run(id, 0);
}

describe('identityLinkService.linkGuestToGithub', () => {
  it('Case A: no prior linked user — updates current row with GitHub profile', async () => {
    const currentUserId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    insertUser(currentUserId);

    const { linkGuestToGithub } = await import('../identityLinkService.js');

    const result = await linkGuestToGithub({
      currentUserId,
      accessToken: 'gh_token_1',
    });

    expect(result).toMatchObject({ userId: currentUserId, merged: false });

    const row = sqliteDb.prepare('SELECT * FROM users WHERE id = ?').get(currentUserId);
    expect(row.github_user_id).toBe(4242);
    expect(row.github_login).toBe('octocat');
    expect(row.github_avatar_url).toBe('https://example.com/octocat.png');
    expect(row.email).toBe('octocat@example.com');
  });

  it('Case B: GitHub already linked to a different user — merges current into existing', async () => {
    const existingUserId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const currentUserId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

    insertUser(existingUserId, {
      email: 'octocat@example.com',
      github_user_id: 4242,
      github_login: 'octocat',
      github_avatar_url: 'https://example.com/old.png',
    });
    insertUser(currentUserId);

    // Seed rows on the current (guest) userId that should re-point to existingUserId.
    sqliteDb.prepare('INSERT INTO review_sync_events (id, user_id, event_type) VALUES (?, ?, ?)')
      .run('evt-1', currentUserId, 'review_completed');
    sqliteDb.prepare('INSERT INTO review_sync_sessions (id, user_id) VALUES (?, ?)')
      .run('sess-1', currentUserId);
    sqliteDb.prepare('INSERT INTO usage_ledger (id, user_id, amount) VALUES (?, ?, ?)')
      .run('u-1', currentUserId, 100);
    sqliteDb.prepare('INSERT INTO chat_stream_state (session_id, stream_state) VALUES (?, ?)')
      .run('stream-1', '{}');

    const { linkGuestToGithub } = await import('../identityLinkService.js');

    const result = await linkGuestToGithub({
      currentUserId,
      accessToken: 'gh_token_1',
    });

    expect(result).toMatchObject({ userId: existingUserId, merged: true });

    // Current (guest) user row should be gone.
    const gone = sqliteDb.prepare('SELECT id FROM users WHERE id = ?').get(currentUserId);
    expect(gone).toBeUndefined();

    // Events, sessions, usage_ledger should have re-pointed.
    const eventRow = sqliteDb.prepare('SELECT user_id FROM review_sync_events WHERE id = ?').get('evt-1');
    expect(eventRow.user_id).toBe(existingUserId);
    const sessionRow = sqliteDb.prepare('SELECT user_id FROM review_sync_sessions WHERE id = ?').get('sess-1');
    expect(sessionRow.user_id).toBe(existingUserId);
    const ledgerRow = sqliteDb.prepare('SELECT user_id FROM usage_ledger WHERE id = ?').get('u-1');
    expect(ledgerRow.user_id).toBe(existingUserId);

    // Existing row profile fields should be refreshed.
    const existing = sqliteDb.prepare('SELECT * FROM users WHERE id = ?').get(existingUserId);
    expect(existing.github_avatar_url).toBe('https://example.com/octocat.png');
  });

  it('Case B (Postgres semantics): completes even when re-point tables are missing', async () => {
    // Regression for the Railway failure "current transaction is aborted,
    // commands ignored until end of transaction block": on Postgres any
    // statement error poisons the whole transaction, so the old bare
    // try/catch around the re-point UPDATEs silently broke every merge as
    // soon as it hit a table that doesn't exist in the schema. This test
    // wraps the merge in a transaction client that emulates that behaviour.
    let poisoned = false;
    transactionMock.mockImplementationOnce(async (callback) => {
      sqliteDb.exec('BEGIN');
      const client = {
        query: async (sql, params = []) => {
          const op = String(sql).trim().toUpperCase();
          const isSavepointCtl =
            op.startsWith('SAVEPOINT ') ||
            op.startsWith('RELEASE SAVEPOINT ') ||
            op.startsWith('ROLLBACK TO SAVEPOINT ');
          if (poisoned && !op.startsWith('ROLLBACK TO SAVEPOINT ')) {
            throw new Error('current transaction is aborted, commands ignored until end of transaction block');
          }
          try {
            const result = runSqlite(sql, params);
            if (op.startsWith('ROLLBACK TO SAVEPOINT ')) poisoned = false;
            return result;
          } catch (err) {
            if (!isSavepointCtl) poisoned = true; // a data statement error poisons the txn
            throw err;
          }
        },
      };
      try {
        const result = await callback(client);
        sqliteDb.exec('COMMIT');
        return result;
      } catch (err) {
        try { sqliteDb.exec('ROLLBACK'); } catch { /* noop */ }
        throw err;
      }
    });

    const existingUserId = 'b0b0b0b0-0000-0000-0000-000000000000';
    const currentUserId = 'c0c0c0c0-0000-0000-0000-000000000000';
    insertUser(existingUserId, {
      email: 'octocat@example.com',
      github_user_id: 4242,
      github_login: 'octocat',
      github_avatar_url: 'https://example.com/old.png',
    });
    insertUser(currentUserId);
    sqliteDb.prepare('INSERT INTO review_sync_events (id, user_id, event_type) VALUES (?, ?, ?)')
      .run('evt-pg', currentUserId, 'review_completed');
    sqliteDb.prepare('INSERT INTO usage_ledger (id, user_id, amount) VALUES (?, ?, ?)')
      .run('u-pg', currentUserId, 7);

    const { linkGuestToGithub } = await import('../identityLinkService.js');

    const result = await linkGuestToGithub({ currentUserId, accessToken: 'gh_token_1' });

    expect(result).toMatchObject({ userId: existingUserId, merged: true });
    expect(poisoned).toBe(false); // txn never left in an aborted state at COMMIT time

    // Guest row gone; history re-pointed onto the existing linked user.
    expect(sqliteDb.prepare('SELECT id FROM users WHERE id = ?').get(currentUserId)).toBeUndefined();
    expect(sqliteDb.prepare('SELECT user_id FROM review_sync_events WHERE id = ?').get('evt-pg').user_id)
      .toBe(existingUserId);
    expect(sqliteDb.prepare('SELECT user_id FROM usage_ledger WHERE id = ?').get('u-pg').user_id)
      .toBe(existingUserId);
    expect(sqliteDb.prepare('SELECT github_avatar_url FROM users WHERE id = ?').get(existingUserId).github_avatar_url)
      .toBe('https://example.com/octocat.png');
  });

  it('Case B: a non-schema error inside a re-point step aborts the whole merge', async () => {
    // The savepoint guard must only swallow "table/column does not exist".
    // A real failure (e.g. a Postgres type mismatch) must propagate so the
    // transaction rolls back rather than half-merging.
    transactionMock.mockImplementationOnce(async (callback) => {
      sqliteDb.exec('BEGIN');
      const client = {
        query: async (sql, params = []) => {
          if (/^\s*UPDATE\s+review_sync_events\b/i.test(String(sql))) {
            throw new Error('operator does not exist: text = uuid');
          }
          return runSqlite(sql, params);
        },
      };
      try {
        const result = await callback(client);
        sqliteDb.exec('COMMIT');
        return result;
      } catch (err) {
        try { sqliteDb.exec('ROLLBACK'); } catch { /* noop */ }
        throw err;
      }
    });

    const existingUserId = 'a1a1a1a1-0000-0000-0000-000000000000';
    const currentUserId = 'a2a2a2a2-0000-0000-0000-000000000000';
    insertUser(existingUserId, { github_user_id: 4242, github_login: 'octocat' });
    insertUser(currentUserId);

    const { linkGuestToGithub } = await import('../identityLinkService.js');

    await expect(linkGuestToGithub({ currentUserId, accessToken: 'gh_token_1' }))
      .rejects.toThrow(/operator does not exist/i);

    // Merge rolled back: the guest row must still be there.
    expect(sqliteDb.prepare('SELECT id FROM users WHERE id = ?').get(currentUserId)).toBeTruthy();
  });

  it('Case C: already linked to this user — refreshes profile, no merge', async () => {
    const currentUserId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    insertUser(currentUserId, {
      email: 'stale@example.com',
      github_user_id: 4242,
      github_login: 'stale-login',
      github_avatar_url: 'https://example.com/stale.png',
    });

    const { linkGuestToGithub } = await import('../identityLinkService.js');

    const result = await linkGuestToGithub({
      currentUserId,
      accessToken: 'gh_token_1',
    });

    expect(result).toMatchObject({ userId: currentUserId, merged: false });

    const row = sqliteDb.prepare('SELECT * FROM users WHERE id = ?').get(currentUserId);
    expect(row.github_login).toBe('octocat');
    expect(row.github_avatar_url).toBe('https://example.com/octocat.png');
    expect(row.email).toBe('octocat@example.com');
  });

  it('rejects when GitHub user lookup fails', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({ message: 'Bad credentials' }),
    }));

    const { linkGuestToGithub } = await import('../identityLinkService.js');

    await expect(
      linkGuestToGithub({ currentUserId: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', accessToken: 'bad' })
    ).rejects.toThrow();
  });
});

describe('identityLinkService.unlinkGithub', () => {
  it('nulls GitHub profile fields and resets email to guest placeholder', async () => {
    const userId = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    insertUser(userId, {
      email: 'octocat@example.com',
      github_user_id: 4242,
      github_login: 'octocat',
      github_avatar_url: 'https://example.com/octocat.png',
    });
    sqliteDb.prepare('INSERT INTO review_sync_events (id, user_id, event_type) VALUES (?, ?, ?)')
      .run('evt-2', userId, 'review_completed');

    const { unlinkGithub } = await import('../identityLinkService.js');

    const result = await unlinkGithub(userId);

    expect(result).toEqual({ userId, unlinked: true });

    const row = sqliteDb.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    expect(row.github_user_id).toBeNull();
    expect(row.github_login).toBeNull();
    expect(row.github_avatar_url).toBeNull();
    expect(row.email).toBe(`guest-${userId.slice(0, 8)}@device.atlasengine.local`);

    // Events must still belong to the same user (history preserved).
    const eventRow = sqliteDb.prepare('SELECT user_id FROM review_sync_events WHERE id = ?').get('evt-2');
    expect(eventRow.user_id).toBe(userId);
  });
});
