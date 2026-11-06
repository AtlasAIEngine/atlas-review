import db, { getDbType } from '../db/connection.js';
import { encrypt } from '../utils/encryption.js';
import {
  fetchGithubUser,
  linkGuestToGithubProfile,
} from './identityLinkService.js';

const GITHUB_INSTALLATIONS_ENDPOINT = 'https://api.github.com/user/installations';
const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';

function nowExpr() {
  return getDbType() === 'sqlite' ? "datetime('now')" : 'NOW()';
}

function normalizeTokenMeta(tokenMeta = {}) {
  return {
    refreshToken: tokenMeta.refreshToken ?? tokenMeta.refresh_token ?? null,
    expiresIn: tokenMeta.expiresIn ?? tokenMeta.expires_in ?? null,
    refreshTokenExpiresIn: tokenMeta.refreshTokenExpiresIn ?? tokenMeta.refresh_token_expires_in ?? null,
  };
}

function buildTokenExpiresAt(expiresIn) {
  const seconds = Number(expiresIn);
  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(Date.now() + seconds * 1000).toISOString();
  }
  return new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString();
}

function buildRefreshTokenExpiresAt(refreshTokenExpiresIn) {
  const seconds = Number(refreshTokenExpiresIn);
  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(Date.now() + seconds * 1000).toISOString();
  }
  return null;
}

async function discoverInstallations(accessToken) {
  try {
    const response = await fetch(GITHUB_INSTALLATIONS_ENDPOINT, {
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `token ${accessToken}`,
        'User-Agent': 'AtlasEngine',
      },
    });

    if (!response.ok) {
      console.warn('[GitHub Account Connection] Could not fetch user installations:', response.status);
      return [];
    }

    const payload = await response.json();
    return Array.isArray(payload?.installations) ? payload.installations : [];
  } catch (error) {
    console.warn('[GitHub Account Connection] Failed to fetch user installations:', error.message);
    return [];
  }
}

async function resolvePersonalInstallationId(userId, login) {
  const existing = await db.query(
    `SELECT installation_id, account_login FROM github_integrations
     WHERE user_id = $1 AND is_active = TRUE AND installation_id < 0
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  );
  const row = existing.rows?.[0] || null;
  if (row && row.account_login === login) {
    return Number(row.installation_id);
  }
  return -Math.floor(Date.now());
}

function accountFromInstallation(installation) {
  return {
    installationId: Number(installation.id),
    accountLogin: installation.account?.login || `org-${installation.id}`,
    accountType: installation.account?.type || 'Organization',
    avatarUrl: installation.account?.avatar_url || null,
  };
}

async function buildAccounts({ userId, profile, installations }) {
  const accounts = [{
    installationId: await resolvePersonalInstallationId(userId, profile.login),
    accountLogin: profile.login,
    accountType: 'User',
    avatarUrl: profile.avatarUrl || null,
  }];

  for (const installation of installations) {
    const account = accountFromInstallation(installation);
    if (!Number.isFinite(account.installationId) || account.installationId <= 0) {
      continue;
    }

    if (account.accountLogin === profile.login) {
      accounts[0] = {
        ...accounts[0],
        installationId: account.installationId,
        avatarUrl: account.avatarUrl || accounts[0].avatarUrl,
      };
      continue;
    }

    accounts.push(account);
  }

  return accounts;
}

async function claimLegacyAccountOwnership({ userId, installationId }) {
  if (!userId || !Number.isFinite(Number(installationId)) || Number(installationId) <= 0) {
    return;
  }

  await db.query(
    `UPDATE github_integrations
        SET user_id = $1,
            suspended_at = NULL,
            is_active = TRUE,
            updated_at = ${nowExpr()}
      WHERE installation_id = $2
        AND (
          user_id IS NULL
          OR user_id = $3
          OR NOT EXISTS (
            SELECT 1 FROM users WHERE users.id = github_integrations.user_id
          )
        )`,
    [userId, installationId, ANONYMOUS_USER_ID]
  );
}

export async function claimLegacyAccountsForLinkedUser(userId) {
  if (process.env.ATLAS_DESKTOP_MODE !== 'true' || !userId) {
    return { claimed: 0 };
  }

  const userResult = await db.query(
    `SELECT github_user_id, github_login
       FROM users
      WHERE id = $1
        AND github_user_id IS NOT NULL
        AND github_login IS NOT NULL
      LIMIT 1`,
    [userId]
  );
  if (userResult.rows.length === 0) {
    return { claimed: 0 };
  }
  const githubLogin = String(userResult.rows[0]?.github_login || '').trim();
  if (!githubLogin) {
    return { claimed: 0 };
  }

  const result = await db.query(
    `UPDATE github_integrations
        SET user_id = $1,
            suspended_at = NULL,
            is_active = TRUE,
            updated_at = ${nowExpr()}
      WHERE is_active = TRUE
        AND (
          user_access_token_encrypted IS NOT NULL
          OR access_token_encrypted IS NOT NULL
        )
        AND (
          user_id IS NULL
          OR user_id = $2
          OR NOT EXISTS (
            SELECT 1 FROM users WHERE users.id = github_integrations.user_id
          )
        )
        AND account_type = 'User'
        AND LOWER(account_login) = LOWER($3)`,
    [userId, ANONYMOUS_USER_ID, githubLogin]
  );

  return { claimed: Number(result.rowCount || 0) };
}

async function upsertAccount({
  userId,
  account,
  encryptedToken,
  tokenExpiresAt,
  encryptedRefreshToken,
  refreshTokenExpiresAt,
}) {
  await db.query(
    `INSERT INTO github_integrations (
      user_id, installation_id, account_login, account_type, account_avatar_url,
      access_token_encrypted, token_expires_at, user_access_token_encrypted,
      refresh_token_encrypted, refresh_token_expires_at, is_active
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
    ON CONFLICT (installation_id)
    DO UPDATE SET
      user_id = CASE
        WHEN github_integrations.user_id IS NULL THEN EXCLUDED.user_id
        ELSE github_integrations.user_id
      END,
      account_login = CASE
        WHEN github_integrations.user_id IS NULL OR github_integrations.user_id = EXCLUDED.user_id THEN EXCLUDED.account_login
        ELSE github_integrations.account_login
      END,
      account_type = CASE
        WHEN github_integrations.user_id IS NULL OR github_integrations.user_id = EXCLUDED.user_id THEN EXCLUDED.account_type
        ELSE github_integrations.account_type
      END,
      account_avatar_url = CASE
        WHEN github_integrations.user_id IS NULL OR github_integrations.user_id = EXCLUDED.user_id THEN EXCLUDED.account_avatar_url
        ELSE github_integrations.account_avatar_url
      END,
      access_token_encrypted = CASE
        WHEN github_integrations.user_id IS NOT NULL AND github_integrations.user_id <> EXCLUDED.user_id THEN github_integrations.access_token_encrypted
        WHEN github_integrations.installation_id < 0 THEN EXCLUDED.access_token_encrypted
        ELSE COALESCE(github_integrations.access_token_encrypted, EXCLUDED.access_token_encrypted)
      END,
      token_expires_at = CASE
        WHEN github_integrations.user_id IS NULL OR github_integrations.user_id = EXCLUDED.user_id THEN EXCLUDED.token_expires_at
        ELSE github_integrations.token_expires_at
      END,
      user_access_token_encrypted = CASE
        WHEN github_integrations.user_id IS NULL OR github_integrations.user_id = EXCLUDED.user_id THEN EXCLUDED.user_access_token_encrypted
        ELSE github_integrations.user_access_token_encrypted
      END,
      refresh_token_encrypted = CASE
        WHEN github_integrations.user_id IS NULL OR github_integrations.user_id = EXCLUDED.user_id THEN EXCLUDED.refresh_token_encrypted
        ELSE github_integrations.refresh_token_encrypted
      END,
      refresh_token_expires_at = CASE
        WHEN github_integrations.user_id IS NULL OR github_integrations.user_id = EXCLUDED.user_id THEN EXCLUDED.refresh_token_expires_at
        ELSE github_integrations.refresh_token_expires_at
      END,
      suspended_at = CASE
        WHEN github_integrations.user_id IS NULL OR github_integrations.user_id = EXCLUDED.user_id THEN NULL
        ELSE github_integrations.suspended_at
      END,
      is_active = CASE
        WHEN github_integrations.user_id IS NULL OR github_integrations.user_id = EXCLUDED.user_id THEN TRUE
        ELSE github_integrations.is_active
      END,
      updated_at = ${nowExpr()}`,
    [
      userId,
      account.installationId,
      account.accountLogin,
      account.accountType,
      account.avatarUrl,
      encryptedToken,
      tokenExpiresAt,
      encryptedToken,
      encryptedRefreshToken,
      refreshTokenExpiresAt,
    ]
  );
}

async function deactivateStalePersonalRows({ userId, login, storedInstallationIds }) {
  if (!storedInstallationIds.length) return;

  if (getDbType() === 'sqlite') {
    const placeholders = storedInstallationIds.map((_, index) => `$${index + 3}`).join(', ');
    await db.query(
      `UPDATE github_integrations
       SET is_active = FALSE, updated_at = datetime('now')
       WHERE user_id = $1
         AND installation_id < 0
         AND account_login = $2
         AND installation_id NOT IN (${placeholders})`,
      [userId, login, ...storedInstallationIds]
    );
    return;
  }

  await db.query(
    `UPDATE github_integrations
     SET is_active = FALSE, updated_at = NOW()
     WHERE user_id = $1
       AND installation_id < 0
       AND account_login = $2
       AND installation_id != ALL($3::bigint[])`,
    [userId, login, storedInstallationIds]
  );
}

export async function connectGitHubAccount({
  userId,
  accessToken,
  tokenMeta = {},
  source = 'unknown',
} = {}) {
  if (!userId) throw new Error('userId is required');
  if (!accessToken) throw new Error('accessToken is required');

  const profile = await fetchGithubUser(accessToken);
  const linkResult = await linkGuestToGithubProfile({
    currentUserId: userId,
    profile,
  });
  const resolvedUserId = linkResult.userId;

  const normalizedMeta = normalizeTokenMeta(tokenMeta);
  const encryptedToken = encrypt(accessToken);
  const tokenExpiresAt = buildTokenExpiresAt(normalizedMeta.expiresIn);
  const encryptedRefreshToken = normalizedMeta.refreshToken ? encrypt(normalizedMeta.refreshToken) : null;
  const refreshTokenExpiresAt = buildRefreshTokenExpiresAt(normalizedMeta.refreshTokenExpiresIn);

  const discoveredInstallations = await discoverInstallations(accessToken);
  const accounts = await buildAccounts({
    userId: resolvedUserId,
    profile,
    installations: discoveredInstallations,
  });

  for (const account of accounts) {
    await claimLegacyAccountOwnership({
      userId: resolvedUserId,
      installationId: account.installationId,
    });
    await upsertAccount({
      userId: resolvedUserId,
      account,
      encryptedToken,
      tokenExpiresAt,
      encryptedRefreshToken,
      refreshTokenExpiresAt,
    });
  }

  await deactivateStalePersonalRows({
    userId: resolvedUserId,
    login: profile.login,
    storedInstallationIds: accounts.map((account) => account.installationId),
  });

  console.log(
    `[GitHub Account Connection] ${source} connected @${profile.login} for user ${resolvedUserId}; stored ${accounts.length} account(s)`
  );

  return {
    userId: resolvedUserId,
    merged: Boolean(linkResult.merged),
    profile,
    primaryInstallationId: accounts[0]?.installationId ?? null,
    installations: accounts,
  };
}

export default {
  connectGitHubAccount,
  claimLegacyAccountsForLinkedUser,
};
