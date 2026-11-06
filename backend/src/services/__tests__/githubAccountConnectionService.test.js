import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { decrypt } from '../../utils/encryption.js';

let sqliteDb;
const queryMock = vi.fn();
const transactionMock = vi.fn();
const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

vi.mock('../../db/connection.js', () => ({
  default: {
    query: (...args) => queryMock(...args),
  },
  query: (...args) => queryMock(...args),
  transaction: (...args) => transactionMock(...args),
  getDbType: () => 'sqlite',
}));

function runSqlite(sql, params = []) {
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

    CREATE TABLE review_sync_events (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, event_type TEXT);
    CREATE TABLE review_sync_sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL);
    CREATE TABLE usage_ledger (id TEXT PRIMARY KEY, user_id TEXT, amount INTEGER DEFAULT 0);

    CREATE TABLE github_integrations (
      id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
      user_id TEXT,
      installation_id INTEGER UNIQUE NOT NULL,
      account_login TEXT NOT NULL,
      account_type TEXT NOT NULL,
      account_avatar_url TEXT,
      access_token_encrypted TEXT NOT NULL,
      token_expires_at TEXT NOT NULL,
      user_access_token_encrypted TEXT,
      refresh_token_encrypted TEXT,
      refresh_token_expires_at TEXT,
      repositories_accessible TEXT,
      permissions TEXT,
      events TEXT,
      is_active INTEGER DEFAULT 1,
      suspended_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

function installDbMocks() {
  queryMock.mockImplementation(async (sql, params = []) => runSqlite(sql, params));
  transactionMock.mockImplementation(async (callback) => {
    sqliteDb.exec('BEGIN');
    try {
      const result = await callback({
        query: async (sql, params = []) => runSqlite(sql, params),
      });
      sqliteDb.exec('COMMIT');
      return result;
    } catch (error) {
      try { sqliteDb.exec('ROLLBACK'); } catch { /* noop */ }
      throw error;
    }
  });
}

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
  sqliteDb.prepare('INSERT INTO user_quotas (user_id) VALUES (?)').run(id);
}

function mockGitHub({ profile = {}, installations = [] } = {}) {
  global.fetch = vi.fn(async (url) => {
    const raw = String(url);
    if (raw.endsWith('/user')) {
      return {
        ok: true,
        json: async () => ({
          id: 4242,
          login: 'octocat',
          avatar_url: 'https://example.com/octocat.png',
          email: 'octocat@example.com',
          name: 'Octo Cat',
          ...profile,
        }),
      };
    }
    if (raw.endsWith('/user/installations')) {
      return {
        ok: true,
        json: async () => ({ installations }),
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ENCRYPTION_KEY = Buffer.from('a'.repeat(32)).toString('base64');
  setupSchema();
  installDbMocks();
  mockGitHub();
});

afterEach(() => {
  delete process.env.ATLAS_DESKTOP_MODE;
});

describe('githubAccountConnectionService.connectGitHubAccount', () => {
  it('links identity and stores a personal negative installation with token metadata', async () => {
    const userId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    insertUser(userId);

    const { connectGitHubAccount } = await import('../githubAccountConnectionService.js');
    const result = await connectGitHubAccount({
      userId,
      accessToken: 'gh-access-token',
      tokenMeta: {
        refreshToken: 'gh-refresh-token',
        expiresIn: 28800,
        refreshTokenExpiresIn: 15811200,
      },
      source: 'test',
    });

    expect(result).toMatchObject({
      userId,
      merged: false,
      profile: { id: 4242, login: 'octocat' },
    });
    expect(result.primaryInstallationId).toBeLessThan(0);

    const user = sqliteDb.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    expect(user.github_user_id).toBe(4242);
    expect(user.github_login).toBe('octocat');

    const row = sqliteDb.prepare('SELECT * FROM github_integrations WHERE user_id = ?').get(userId);
    expect(row.installation_id).toBe(result.primaryInstallationId);
    expect(row.account_login).toBe('octocat');
    expect(decrypt(row.user_access_token_encrypted)).toBe('gh-access-token');
    expect(decrypt(row.access_token_encrypted)).toBe('gh-access-token');
    expect(decrypt(row.refresh_token_encrypted)).toBe('gh-refresh-token');
    expect(row.refresh_token_expires_at).toBeTruthy();
  });

  it('stores the real personal installation and organization installations discovered from GitHub', async () => {
    const userId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    insertUser(userId);
    mockGitHub({
      installations: [
        {
          id: 123,
          account: { login: 'octocat', type: 'User', avatar_url: 'https://example.com/personal.png' },
        },
        {
          id: 999,
          account: { login: 'AtlasAIEngine', type: 'Organization', avatar_url: 'https://example.com/org.png' },
        },
      ],
    });

    const { connectGitHubAccount } = await import('../githubAccountConnectionService.js');
    const result = await connectGitHubAccount({
      userId,
      accessToken: 'gh-access-token',
      tokenMeta: {},
      source: 'test',
    });

    expect(result.primaryInstallationId).toBe(123);
    expect(result.installations).toEqual([
      expect.objectContaining({ installationId: 123, accountLogin: 'octocat', accountType: 'User' }),
      expect.objectContaining({ installationId: 999, accountLogin: 'AtlasAIEngine', accountType: 'Organization' }),
    ]);

    const rows = sqliteDb
      .prepare('SELECT installation_id, account_login, account_type FROM github_integrations ORDER BY installation_id')
      .all();
    expect(rows).toEqual([
      { installation_id: 123, account_login: 'octocat', account_type: 'User' },
      { installation_id: 999, account_login: 'AtlasAIEngine', account_type: 'Organization' },
    ]);
  });

  it('does not transfer or reactivate another user-owned installation on conflict', async () => {
    const originalUserId = '11111111-1111-1111-1111-111111111111';
    const connectingUserId = '22222222-2222-2222-2222-222222222222';
    insertUser(originalUserId, {
      github_user_id: 9898,
      github_login: 'other-linked-user',
    });
    insertUser(connectingUserId);
    sqliteDb
      .prepare(`INSERT INTO github_integrations (
        user_id, installation_id, account_login, account_type, account_avatar_url,
        access_token_encrypted, token_expires_at, user_access_token_encrypted,
        refresh_token_encrypted, refresh_token_expires_at, is_active, suspended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
      .run(
        originalUserId,
        999,
        'LegacyOrg',
        'Organization',
        'https://example.com/old-org.png',
        'old-token',
        '2099-01-01T00:00:00.000Z',
        'old-token',
        'old-refresh-token',
        '2099-06-01T00:00:00.000Z',
        '2025-01-01T00:00:00.000Z'
      );
    mockGitHub({
      installations: [
        {
          id: 999,
          account: { login: 'AtlasAIEngine', type: 'Organization', avatar_url: 'https://example.com/org.png' },
        },
      ],
    });

    const { connectGitHubAccount } = await import('../githubAccountConnectionService.js');
    await connectGitHubAccount({
      userId: connectingUserId,
      accessToken: 'new-token',
      source: 'test',
    });

    const row = sqliteDb
      .prepare(`SELECT
        user_id, account_login, account_type, account_avatar_url,
        access_token_encrypted, token_expires_at, user_access_token_encrypted,
        refresh_token_encrypted, refresh_token_expires_at, is_active, suspended_at
        FROM github_integrations WHERE installation_id = 999`)
      .get();
    expect(row.user_id).toBe(originalUserId);
    expect(row.account_login).toBe('LegacyOrg');
    expect(row.account_type).toBe('Organization');
    expect(row.account_avatar_url).toBe('https://example.com/old-org.png');
    expect(row.access_token_encrypted).toBe('old-token');
    expect(row.token_expires_at).toBe('2099-01-01T00:00:00.000Z');
    expect(row.user_access_token_encrypted).toBe('old-token');
    expect(row.refresh_token_encrypted).toBe('old-refresh-token');
    expect(row.refresh_token_expires_at).toBe('2099-06-01T00:00:00.000Z');
    expect(row.is_active).toBe(0);
    expect(row.suspended_at).toBe('2025-01-01T00:00:00.000Z');
  });

  it('claims a discovered installation from the anonymous legacy owner', async () => {
    const connectingUserId = '23232323-2323-2323-2323-232323232323';
    insertUser(connectingUserId);
    sqliteDb
      .prepare(`INSERT INTO github_integrations (
        user_id, installation_id, account_login, account_type, account_avatar_url,
        access_token_encrypted, token_expires_at, user_access_token_encrypted,
        refresh_token_encrypted, refresh_token_expires_at, is_active, suspended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
      .run(
        ANONYMOUS_USER_ID,
        777,
        'LegacyOrg',
        'Organization',
        'https://example.com/legacy-org.png',
        'old-token',
        '2099-01-01T00:00:00.000Z',
        'old-token',
        'old-refresh-token',
        '2099-06-01T00:00:00.000Z',
        '2025-01-01T00:00:00.000Z'
      );
    mockGitHub({
      installations: [
        {
          id: 777,
          account: { login: 'AtlasAIEngine', type: 'Organization', avatar_url: 'https://example.com/org.png' },
        },
      ],
    });

    const { connectGitHubAccount } = await import('../githubAccountConnectionService.js');
    await connectGitHubAccount({
      userId: connectingUserId,
      accessToken: 'new-token',
      tokenMeta: { refreshToken: 'new-refresh-token', refreshTokenExpiresIn: 3600 },
      source: 'test',
    });

    const row = sqliteDb
      .prepare(`SELECT
        user_id, account_login, account_avatar_url, user_access_token_encrypted,
        refresh_token_encrypted, is_active, suspended_at
        FROM github_integrations WHERE installation_id = 777`)
      .get();
    expect(row.user_id).toBe(connectingUserId);
    expect(row.account_login).toBe('AtlasAIEngine');
    expect(row.account_avatar_url).toBe('https://example.com/org.png');
    expect(decrypt(row.user_access_token_encrypted)).toBe('new-token');
    expect(decrypt(row.refresh_token_encrypted)).toBe('new-refresh-token');
    expect(row.is_active).toBe(1);
    expect(row.suspended_at).toBeNull();
  });

  it('does not claim a discovered installation from another unlinked user', async () => {
    const legacyUserId = '12121212-1212-1212-1212-121212121212';
    const connectingUserId = '23232323-2323-2323-2323-232323232323';
    insertUser(legacyUserId);
    insertUser(connectingUserId);
    sqliteDb
      .prepare(`INSERT INTO github_integrations (
        user_id, installation_id, account_login, account_type, account_avatar_url,
        access_token_encrypted, token_expires_at, user_access_token_encrypted,
        refresh_token_encrypted, refresh_token_expires_at, is_active, suspended_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)`)
      .run(
        legacyUserId,
        778,
        'LegacyOrg',
        'Organization',
        'https://example.com/legacy-org.png',
        'old-token',
        '2099-01-01T00:00:00.000Z',
        'old-token',
        'old-refresh-token',
        '2099-06-01T00:00:00.000Z'
      );
    mockGitHub({
      installations: [
        {
          id: 778,
          account: { login: 'AtlasAIEngine', type: 'Organization', avatar_url: 'https://example.com/org.png' },
        },
      ],
    });

    const { connectGitHubAccount } = await import('../githubAccountConnectionService.js');
    await connectGitHubAccount({
      userId: connectingUserId,
      accessToken: 'new-token',
      tokenMeta: { refreshToken: 'new-refresh-token', refreshTokenExpiresIn: 3600 },
      source: 'test',
    });

    const row = sqliteDb
      .prepare(`SELECT user_id, account_login, user_access_token_encrypted
        FROM github_integrations WHERE installation_id = 778`)
      .get();
    expect(row.user_id).toBe(legacyUserId);
    expect(row.account_login).toBe('LegacyOrg');
    expect(row.user_access_token_encrypted).toBe('old-token');
  });

  it('claims and reactivates an unowned installation on conflict', async () => {
    const connectingUserId = '33333333-3333-3333-3333-333333333333';
    insertUser(connectingUserId);
    sqliteDb
      .prepare(`INSERT INTO github_integrations (
        user_id, installation_id, account_login, account_type, account_avatar_url,
        access_token_encrypted, token_expires_at, user_access_token_encrypted, is_active, suspended_at
      ) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, 0, ?)`)
      .run(
        999,
        'SuspendedOrg',
        'Organization',
        null,
        'old-token',
        '2099-01-01T00:00:00.000Z',
        'old-token',
        '2025-01-01T00:00:00.000Z'
      );
    mockGitHub({
      installations: [
        {
          id: 999,
          account: { login: 'AtlasAIEngine', type: 'Organization', avatar_url: 'https://example.com/org.png' },
        },
      ],
    });

    const { connectGitHubAccount } = await import('../githubAccountConnectionService.js');
    await connectGitHubAccount({
      userId: connectingUserId,
      accessToken: 'new-token',
      tokenMeta: { refreshToken: 'new-refresh-token', refreshTokenExpiresIn: 3600 },
      source: 'test',
    });

    const row = sqliteDb
      .prepare(`SELECT
        user_id, account_login, account_avatar_url, user_access_token_encrypted,
        refresh_token_encrypted, is_active, suspended_at
        FROM github_integrations WHERE installation_id = 999`)
      .get();
    expect(row.user_id).toBe(connectingUserId);
    expect(row.account_login).toBe('AtlasAIEngine');
    expect(row.account_avatar_url).toBe('https://example.com/org.png');
    expect(decrypt(row.user_access_token_encrypted)).toBe('new-token');
    expect(decrypt(row.refresh_token_encrypted)).toBe('new-refresh-token');
    expect(row.is_active).toBe(1);
    expect(row.suspended_at).toBeNull();
  });

  it('deactivates stale negative personal rows when a real personal installation replaces them', async () => {
    const userId = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
    insertUser(userId);
    sqliteDb
      .prepare(`INSERT INTO github_integrations (
        user_id, installation_id, account_login, account_type, account_avatar_url,
        access_token_encrypted, token_expires_at, user_access_token_encrypted, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
      .run(userId, -111, 'octocat', 'User', null, 'old-token', '2099-01-01T00:00:00.000Z', 'old-token');
    mockGitHub({
      installations: [
        { id: 123, account: { login: 'octocat', type: 'User', avatar_url: null } },
      ],
    });

    const { connectGitHubAccount } = await import('../githubAccountConnectionService.js');
    await connectGitHubAccount({ userId, accessToken: 'new-token', source: 'test' });

    const stale = sqliteDb.prepare('SELECT is_active FROM github_integrations WHERE installation_id = -111').get();
    const current = sqliteDb.prepare('SELECT is_active FROM github_integrations WHERE installation_id = 123').get();
    expect(stale.is_active).toBe(0);
    expect(current.is_active).toBe(1);
  });

  it('writes integrations under the resolved user when identity linking merges users', async () => {
    const existingUserId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const currentUserId = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
    insertUser(existingUserId, {
      email: 'octocat@example.com',
      github_user_id: 4242,
      github_login: 'octocat',
    });
    insertUser(currentUserId);

    const { connectGitHubAccount } = await import('../githubAccountConnectionService.js');
    const result = await connectGitHubAccount({
      userId: currentUserId,
      accessToken: 'gh-access-token',
      source: 'test',
    });

    expect(result).toMatchObject({ userId: existingUserId, merged: true });
    expect(sqliteDb.prepare('SELECT id FROM users WHERE id = ?').get(currentUserId)).toBeUndefined();

    const integration = sqliteDb.prepare('SELECT user_id, account_login FROM github_integrations').get();
    expect(integration.user_id).toBe(existingUserId);
    expect(integration.account_login).toBe('octocat');
  });

  it('repairs anonymous legacy desktop integrations for an already linked user', async () => {
    process.env.ATLAS_DESKTOP_MODE = 'true';
    const linkedUserId = '56565656-5656-5656-5656-565656565656';
    insertUser(ANONYMOUS_USER_ID);
    insertUser(linkedUserId, {
      github_user_id: 4242,
      github_login: 'octocat',
    });
    sqliteDb
      .prepare(`INSERT INTO github_integrations (
        user_id, installation_id, account_login, account_type, account_avatar_url,
        access_token_encrypted, token_expires_at, user_access_token_encrypted, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
      .run(
        ANONYMOUS_USER_ID,
        888,
        'octocat',
        'User',
        null,
        'old-token',
        '2099-01-01T00:00:00.000Z',
        'old-token'
      );

    const { claimLegacyAccountsForLinkedUser } = await import('../githubAccountConnectionService.js');
    const result = await claimLegacyAccountsForLinkedUser(linkedUserId);

    expect(result.claimed).toBe(1);
    const row = sqliteDb.prepare('SELECT user_id, is_active FROM github_integrations WHERE installation_id = 888').get();
    expect(row.user_id).toBe(linkedUserId);
    expect(row.is_active).toBe(1);
  });

  it('does not repair legacy desktop integrations owned by another unlinked user', async () => {
    process.env.ATLAS_DESKTOP_MODE = 'true';
    const unlinkedUserId = '45454545-4545-4545-4545-454545454545';
    const linkedUserId = '56565656-5656-5656-5656-565656565656';
    insertUser(unlinkedUserId);
    insertUser(linkedUserId, {
      github_user_id: 4242,
      github_login: 'octocat',
    });
    sqliteDb
      .prepare(`INSERT INTO github_integrations (
        user_id, installation_id, account_login, account_type, account_avatar_url,
        access_token_encrypted, token_expires_at, user_access_token_encrypted, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
      .run(
        unlinkedUserId,
        890,
        'OtherUserOrg',
        'Organization',
        null,
        'old-token',
        '2099-01-01T00:00:00.000Z',
        'old-token'
      );

    const { claimLegacyAccountsForLinkedUser } = await import('../githubAccountConnectionService.js');
    const result = await claimLegacyAccountsForLinkedUser(linkedUserId);

    expect(result.claimed).toBe(0);
    const row = sqliteDb.prepare('SELECT user_id, is_active FROM github_integrations WHERE installation_id = 890').get();
    expect(row.user_id).toBe(unlinkedUserId);
    expect(row.is_active).toBe(1);
  });

  it('does not repair anonymous organization integrations without a GitHub API visibility check', async () => {
    process.env.ATLAS_DESKTOP_MODE = 'true';
    const linkedUserId = '56565656-5656-5656-5656-565656565656';
    insertUser(linkedUserId, {
      github_user_id: 4242,
      github_login: 'octocat',
    });
    sqliteDb
      .prepare(`INSERT INTO github_integrations (
        user_id, installation_id, account_login, account_type, account_avatar_url,
        access_token_encrypted, token_expires_at, user_access_token_encrypted, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
      .run(
        ANONYMOUS_USER_ID,
        891,
        'OtherOrg',
        'Organization',
        null,
        'old-token',
        '2099-01-01T00:00:00.000Z',
        'old-token'
      );

    const { claimLegacyAccountsForLinkedUser } = await import('../githubAccountConnectionService.js');
    const result = await claimLegacyAccountsForLinkedUser(linkedUserId);

    expect(result.claimed).toBe(0);
    const row = sqliteDb.prepare('SELECT user_id, is_active FROM github_integrations WHERE installation_id = 891').get();
    expect(row.user_id).toBe(ANONYMOUS_USER_ID);
    expect(row.is_active).toBe(1);
  });

  it('does not repair legacy integrations outside desktop mode', async () => {
    const legacyUserId = '67676767-6767-6767-6767-676767676767';
    const linkedUserId = '78787878-7878-7878-7878-787878787878';
    insertUser(legacyUserId);
    insertUser(linkedUserId, {
      github_user_id: 4242,
      github_login: 'octocat',
    });
    sqliteDb
      .prepare(`INSERT INTO github_integrations (
        user_id, installation_id, account_login, account_type, account_avatar_url,
        access_token_encrypted, token_expires_at, user_access_token_encrypted, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)`)
      .run(
        legacyUserId,
        889,
        'LegacyOrg',
        'Organization',
        null,
        'old-token',
        '2099-01-01T00:00:00.000Z',
        'old-token'
      );

    const { claimLegacyAccountsForLinkedUser } = await import('../githubAccountConnectionService.js');
    const result = await claimLegacyAccountsForLinkedUser(linkedUserId);

    expect(result.claimed).toBe(0);
    const row = sqliteDb.prepare('SELECT user_id FROM github_integrations WHERE installation_id = 889').get();
    expect(row.user_id).toBe(legacyUserId);
  });
});
