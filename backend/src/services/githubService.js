/**
 * GitHub Service
 * Handles GitHub App authentication, installation management, and GitHub API interactions
 *
 * Features:
 * - GitHub App authentication using private key
 * - Installation token generation and refresh (1-hour expiry)
 * - Repository access and operations
 * - Token encryption/decryption for secure storage
 * - Installation lifecycle management
 *
 * Environment Requirements:
 * - GITHUB_APP_ID: GitHub App ID
 * - GITHUB_APP_CLIENT_ID: GitHub App Client ID
 * - GITHUB_APP_CLIENT_SECRET: GitHub App Client Secret
 * - GITHUB_APP_PRIVATE_KEY_PATH: Path to private key PEM file
 * - ENCRYPTION_KEY: 32-byte base64-encoded encryption key
 */

import { App } from '@octokit/app';
import { Octokit } from '@octokit/rest';
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import db from '../db/connection.js';
import { encrypt, decrypt } from '../utils/encryption.js';

const isDesktopMode = process.env.ATLAS_DESKTOP_MODE === 'true';
const DEVICE_TOKEN_REFRESH_RECENT_TTL_MS = 30_000;
const deviceTokenRefreshInFlight = new Map();
const deviceTokenRefreshRecent = new Map();

function isDeviceInstallationId(installationId) {
  return typeof installationId === 'number' && installationId < 0;
}

// GitHub returns `state: "closed"` for both merged and closed-without-merge PRs,
// and `draft: true` for any PR that was ever opened as a draft — including drafts
// that were later closed. Order matters: a closed draft is closed, not draft.
export function derivePrLifecycleState(pr) {
  if (!pr) return 'open';
  if (pr.merged_at) return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (pr.draft) return 'draft';
  return pr.state || 'open';
}

function buildDeviceTokenRefreshKey(integration) {
  const refreshToken = String(integration?.refresh_token_encrypted || '').trim();
  if (refreshToken) return `refresh:${refreshToken}`;
  return `installation:${integration?.installation_id}`;
}

function buildAuthExpiredError(message, cause = null) {
  const error = new Error(message);
  error.code = 'AUTH_EXPIRED';
  error.status = 401;
  error.statusCode = 401;
  if (cause) {
    error.cause = cause;
  }
  return error;
}

function normalizeUserScopedAuthError(error) {
  const message = String(error?.message || '').trim();
  if (!message) return error;

  if (message.startsWith('Decryption failed:')) {
    return buildAuthExpiredError(
      'GitHub credentials could not be decrypted. Please reconnect your GitHub account.',
      error
    );
  }

  if (
    /github token has expired/i.test(message)
    || /no refresh token available/i.test(message)
  ) {
    return buildAuthExpiredError(
      'GitHub token has expired. Please reconnect your GitHub account.',
      error
    );
  }

  return error;
}

function buildPullRequestReviewPermissionError() {
  if (isDesktopMode) {
    return new Error(
      'GitHub rejected this PR review with installation auth, and Atlas could not complete a user-auth or gh CLI fallback. Reconnect your GitHub account and verify gh is signed in.'
    );
  }
  return new Error(
    'GitHub App auth cannot submit this PR review here. Reconnect your personal GitHub account in Atlas, or use the desktop app where gh CLI fallback is available.'
  );
}

class GitHubService {
  constructor() {
    this.app = null;
    this.initialized = false;
  }

  createAuthClient(token) {
    return new Octokit({ auth: token });
  }

  async submitPullRequestReviewWithGhCli(owner, repo, pullNumber, payload) {
    return new Promise((resolve, reject) => {
      const child = spawn(
        'gh',
        [
          'api',
          '--method', 'POST',
          `repos/${owner}/${repo}/pulls/${pullNumber}/reviews`,
          '--input', '-',
        ],
        {
          env: {
            ...process.env,
            GH_REPO: `${owner}/${repo}`,
          },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      child.on('error', (error) => {
        reject(error);
      });
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error((stderr || stdout || `gh api exited with code ${code}`).trim()));
          return;
        }
        try {
          resolve(JSON.parse(stdout || '{}'));
        } catch (error) {
          reject(new Error(`Failed to parse gh api response: ${error.message}`));
        }
      });

      child.stdin.write(JSON.stringify(payload));
      child.stdin.end();
    });
  }

  /**
   * Initialize GitHub App
   * Loads private key and creates App instance
   */
  async initializeApp() {
    if (this.initialized) {
      return;
    }

    try {
      const appId = process.env.GITHUB_APP_ID;
      const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;

      if (!appId) {
        throw new Error('GITHUB_APP_ID environment variable is not set');
      }

      if (!privateKeyPath) {
        throw new Error('GITHUB_APP_PRIVATE_KEY_PATH environment variable is not set');
      }

      // Read private key from file
      const privateKeyFullPath = path.resolve(privateKeyPath);
      const privateKey = await fs.readFile(privateKeyFullPath, 'utf8');

      // Create GitHub App instance
      this.app = new App({
        appId,
        privateKey,
      });

      this.initialized = true;
      console.log(`✅ GitHub App initialized (App ID: ${appId})`);
    } catch (error) {
      console.error('Failed to initialize GitHub App:', error.message);
      throw error;
    }
  }

  hasAppAuthenticationConfigured() {
    return Boolean(process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY_PATH);
  }

  async ensureAppAuthentication() {
    if (this.app) {
      return true;
    }
    if (!this.hasAppAuthenticationConfigured()) {
      return false;
    }
    try {
      await this.initializeApp();
      return Boolean(this.app);
    } catch (error) {
      console.warn('GitHub App authentication unavailable, falling back to user token auth:', error.message);
      return false;
    }
  }

  async getUserScopedAccessToken(integration) {
    const { token } = await this.getUserScopedAuthContext(integration);
    return token;
  }

  async getUserScopedAuthContextFromRow(integration) {
    const encryptedToken = integration?.user_access_token_encrypted || integration?.access_token_encrypted;
    if (!encryptedToken) {
      throw buildAuthExpiredError('GitHub token has expired. Please reconnect your GitHub account.');
    }

    if (integration.token_expires_at && this.isTokenExpired(integration.token_expires_at)) {
      if (integration.refresh_token_encrypted) {
        try {
          const token = await this.refreshDeviceToken(integration);
          const refreshedIntegration = await this.getInstallationById(integration.installation_id);
          return {
            token,
            integration: refreshedIntegration || integration,
          };
        } catch (refreshError) {
          console.warn('[Device Token Refresh] Failed, user must re-auth:', refreshError.message);
        }
      }
      throw buildAuthExpiredError('GitHub token has expired. Please reconnect your GitHub account.');
    }

    try {
      return {
        token: decrypt(encryptedToken),
        integration,
      };
    } catch (error) {
      throw normalizeUserScopedAuthError(error);
    }
  }

  async getUserScopedAuthContext(integration) {
    let localError = null;
    const hasLocalToken = Boolean(
      integration?.user_access_token_encrypted || integration?.access_token_encrypted
    );

    if (hasLocalToken) {
      try {
        return await this.getUserScopedAuthContextFromRow(integration);
      } catch (error) {
        localError = normalizeUserScopedAuthError(error);
      }
    }

    if (
      integration?.user_id
      && !isDeviceInstallationId(integration?.installation_id)
    ) {
      const resolved = await this.resolveUserInstallationSyncAuth(
        integration.user_id,
        { excludeInstallationIds: [integration.installation_id] }
      );
      if (resolved?.token) {
        return resolved;
      }
    }

    if (localError) {
      throw localError;
    }

    throw buildAuthExpiredError('GitHub token has expired. Please reconnect your GitHub account.');
  }

  async resolveUserInstallationSyncAuth(userId, options = {}) {
    const excludedInstallationIds = new Set(
      (Array.isArray(options?.excludeInstallationIds) ? options.excludeInstallationIds : [])
        .filter((value) => value != null)
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value))
    );
    const result = await db.query(
      `SELECT *
       FROM github_integrations
       WHERE user_id = $1 AND is_active = TRUE
         AND (user_access_token_encrypted IS NOT NULL OR access_token_encrypted IS NOT NULL)
       ORDER BY created_at DESC`,
      [userId]
    );

    const candidates = [...result.rows].sort((left, right) => {
      const leftDeviceRank = isDeviceInstallationId(left.installation_id) ? 0 : 1;
      const rightDeviceRank = isDeviceInstallationId(right.installation_id) ? 0 : 1;
      if (leftDeviceRank !== rightDeviceRank) return leftDeviceRank - rightDeviceRank;

      const leftRefreshRank = left.refresh_token_encrypted ? 0 : 1;
      const rightRefreshRank = right.refresh_token_encrypted ? 0 : 1;
      if (leftRefreshRank !== rightRefreshRank) return leftRefreshRank - rightRefreshRank;

      const leftExpiryRank = this.isTokenExpired(left.token_expires_at) ? 1 : 0;
      const rightExpiryRank = this.isTokenExpired(right.token_expires_at) ? 1 : 0;
      if (leftExpiryRank !== rightExpiryRank) return leftExpiryRank - rightExpiryRank;

      return new Date(right.created_at || 0).getTime() - new Date(left.created_at || 0).getTime();
    });

    for (const integration of candidates) {
      if (excludedInstallationIds.has(Number(integration.installation_id))) {
        continue;
      }
      try {
        const resolved = await this.getUserScopedAuthContextFromRow(integration);
        return resolved;
      } catch (error) {
        console.warn(
          `[GitHub] Skipping installation sync token candidate ${integration.installation_id}: ${error.message}`
        );
      }
    }

    return null;
  }

  /**
   * Get Octokit client for a specific installation
   * Automatically handles token refresh if expired
   *
   * @param {number} installationId - GitHub installation ID
   * @returns {Promise<Octokit>} Authenticated Octokit client
   */
  async getInstallationClient(installationId) {
    const { octokit } = await this.getInstallationClientContext(installationId);
    return octokit;
  }

  async getInstallationClientContext(installationId) {
    const integration = await this.getInstallationById(installationId);
    if (!integration) {
      throw new Error(`Installation ${installationId} not found`);
    }

    const hasUserToken = Boolean(integration.user_access_token_encrypted || integration.access_token_encrypted);
    if (isDeviceInstallationId(integration.installation_id)) {
      const { token } = await this.getUserScopedAuthContext(integration);
      return {
        integration,
        octokit: this.createAuthClient(token),
        authMode: 'user',
      };
    }

    const appReady = await this.ensureAppAuthentication();

    if (appReady) {
      try {
        return {
          integration,
          octokit: await this.app.getInstallationOctokit(installationId),
          authMode: 'installation',
        };
      } catch (error) {
        if (hasUserToken) {
          const { token } = await this.getUserScopedAuthContext(integration);
          return {
            integration,
            octokit: this.createAuthClient(token),
            authMode: 'user',
          };
        }
        console.error(`Failed to get installation client for ${installationId}:`, error.message);
        throw new Error(`GitHub installation authentication failed: ${error.message}`);
      }
    }

    if (hasUserToken) {
      const { token } = await this.getUserScopedAuthContext(integration);
      return {
        integration,
        octokit: this.createAuthClient(token),
        authMode: 'user',
      };
    }

    throw new Error(`GitHub installation authentication failed: installation ${installationId} is not connected`);
  }

  async resolveUserReviewFallbackToken(integration) {
    if (!integration) {
      return null;
    }

    try {
      const resolved = await this.getUserScopedAuthContext(integration);
      if (!resolved?.token) {
        return null;
      }
      return resolved.token;
    } catch {
      return null;
    }
  }

  async getUserPreferredConversationMutationClient(installationId) {
    const { integration, octokit, authMode } = await this.getInstallationClientContext(installationId);
    if (authMode === 'user') {
      return { octokit, authMode };
    }

    const userToken = await this.resolveUserReviewFallbackToken(integration);
    if (userToken) {
      return {
        octokit: this.createAuthClient(userToken),
        authMode: 'user',
      };
    }

    throw buildAuthExpiredError(
      'GitHub user authentication is required to reply to or resolve PR conversations. Please reconnect your GitHub account.'
    );
  }

  async getConversationRestMutationClient(installationId, authMode = 'user') {
    if (authMode !== 'installation') {
      return this.getUserPreferredConversationMutationClient(installationId);
    }

    const integration = await this.getInstallationById(installationId);
    if (!integration) {
      throw new Error(`Installation ${installationId} not found`);
    }
    if (isDeviceInstallationId(integration.installation_id)) {
      throw buildAuthExpiredError(
        'GitHub App authentication is required to edit Atlas-authored PR conversation comments.'
      );
    }

    const appReady = await this.ensureAppAuthentication();
    if (!appReady) {
      throw new Error('GitHub App authentication is required to edit Atlas-authored PR conversation comments.');
    }

    try {
      return {
        octokit: await this.app.getInstallationOctokit(installationId),
        authMode: 'installation',
      };
    } catch (error) {
      throw new Error(`GitHub installation authentication failed: ${error.message}`);
    }
  }

  /**
   * Refresh installation token and update database
   * Installation tokens expire after 1 hour
   *
   * @param {number} installationId - GitHub installation ID
   * @returns {Promise<Object>} New token data
   */
  async refreshInstallationToken(installationId) {
    try {
      // Ensure app is initialized
      if (!this.initialized) {
        await this.initializeApp();
      }

      // Use App's JWT authentication to create installation access token
      // Cannot use installation client for this - only App JWT can create tokens
      // Use request() method directly instead of REST API wrapper
      const { data } = await this.app.octokit.request('POST /app/installations/{installation_id}/access_tokens', {
        installation_id: installationId,
      });

      const encryptedToken = encrypt(data.token);
      const expiresAt = new Date(data.expires_at).toISOString();

      // Update database
      await db.query(
        `UPDATE github_integrations
         SET access_token_encrypted = $1, token_expires_at = $2, updated_at = NOW()
         WHERE installation_id = $3`,
        [encryptedToken, expiresAt, installationId]
      );

      console.log(`🔄 Refreshed token for installation ${installationId}`);

      return {
        token: data.token,
        expiresAt,
      };
    } catch (error) {
      console.error(`Failed to refresh token for installation ${installationId}:`, error.message);
      throw error;
    }
  }

  /**
   * Refresh a device flow (OAuth) token using the stored refresh_token.
   * GitHub rotates the refresh_token on every use, so the new one must be stored.
   *
   * @param {Object} integration - The github_integrations DB row
   * @returns {Promise<string>} New decrypted access token
   */
  async refreshDeviceToken(integration) {
    const refreshKey = buildDeviceTokenRefreshKey(integration);
    const sourceRefreshToken = integration?.refresh_token_encrypted || null;
    const recent = deviceTokenRefreshRecent.get(refreshKey);
    if (
      recent
      && recent.sourceRefreshToken === sourceRefreshToken
      && recent.expiresAt > Date.now()
    ) {
      return recent.token;
    }

    const inFlight = deviceTokenRefreshInFlight.get(refreshKey);
    if (inFlight) {
      return inFlight;
    }

    const refreshPromise = this.performDeviceTokenRefresh(integration)
      .then((token) => {
        deviceTokenRefreshRecent.set(refreshKey, {
          token,
          sourceRefreshToken,
          expiresAt: Date.now() + DEVICE_TOKEN_REFRESH_RECENT_TTL_MS,
        });
        return token;
      })
      .finally(() => {
        deviceTokenRefreshInFlight.delete(refreshKey);
      });

    deviceTokenRefreshInFlight.set(refreshKey, refreshPromise);
    return refreshPromise;
  }

  async performDeviceTokenRefresh(integration) {
    const { installation_id } = integration;

    // Guard: check refresh token exists
    if (!integration.refresh_token_encrypted) {
      throw new Error('No refresh token available. Please reconnect your GitHub account.');
    }

    // Guard: check refresh token hasn't expired (~6 months)
    if (integration.refresh_token_expires_at && this.isTokenExpired(integration.refresh_token_expires_at)) {
      throw new Error('Refresh token has expired. Please reconnect your GitHub account.');
    }

    const refreshToken = decrypt(integration.refresh_token_encrypted);
    const clientId = process.env.GITHUB_APP_CLIENT_ID;
    if (!clientId) {
      throw new Error('GITHUB_APP_CLIENT_ID environment variable is missing');
    }

    const params = new URLSearchParams({
      client_id: clientId,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });

    const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
    if (clientSecret) {
      params.append('client_secret', clientSecret);
    }

    console.log(`[Device Token Refresh] Refreshing token for installation ${installation_id}...`);

    const response = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    const payload = await response.json();

    if (payload.error || !payload.access_token) {
      throw new Error(
        `GitHub token refresh failed: ${payload.error_description || payload.error || 'unknown error'}`
      );
    }

    // Store the new tokens (GitHub rotates the refresh token on each use)
    const encryptedAccessToken = encrypt(payload.access_token);
    const tokenExpiresAt = payload.expires_in
      ? new Date(Date.now() + payload.expires_in * 1000).toISOString()
      : new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString();

    const encryptedRefreshToken = payload.refresh_token
      ? encrypt(payload.refresh_token)
      : integration.refresh_token_encrypted; // keep existing if not rotated

    const refreshTokenExpiresAt = payload.refresh_token_expires_in
      ? new Date(Date.now() + payload.refresh_token_expires_in * 1000).toISOString()
      : integration.refresh_token_expires_at; // keep existing if not returned

    await db.query(
      `UPDATE github_integrations
       SET access_token_encrypted = $1,
           token_expires_at = $2,
           user_access_token_encrypted = $3,
           refresh_token_encrypted = $4,
           refresh_token_expires_at = $5,
           updated_at = NOW()
       WHERE installation_id = $6`,
      [
        encryptedAccessToken,
        tokenExpiresAt,
        encryptedAccessToken,
        encryptedRefreshToken,
        refreshTokenExpiresAt,
        installation_id,
      ]
    );

    if (integration.user_id) {
      await db.query(
        `UPDATE github_integrations
         SET token_expires_at = $1,
             user_access_token_encrypted = $2,
             refresh_token_encrypted = $3,
             refresh_token_expires_at = $4,
             updated_at = NOW()
         WHERE user_id = $5
           AND is_active = TRUE
           AND installation_id != $6`,
        [
          tokenExpiresAt,
          encryptedAccessToken,
          encryptedRefreshToken,
          refreshTokenExpiresAt,
          integration.user_id,
          installation_id,
        ]
      );
    }

    console.log(`[Device Token Refresh] Token refreshed successfully for installation ${installation_id}`);

    return payload.access_token;
  }

  /**
   * Check if installation token is expired or about to expire
   * Refresh proactively if less than 5 minutes remaining
   *
   * @param {Date} expiresAt - Token expiration timestamp
   * @returns {boolean} True if token needs refresh
   */
  isTokenExpired(expiresAt) {
    const now = new Date();
    const expires = new Date(expiresAt);
    const bufferMs = 5 * 60 * 1000; // 5 minutes

    return (expires - now) < bufferMs;
  }

  /**
   * Get user's repositories accessible via installation
   *
   * @param {number} installationId - GitHub installation ID
   * @param {Object} options - Query options (page, per_page, sort)
   * @returns {Promise<Array>} List of repositories
   */
  async getUserRepositories(installationId, options = {}) {
    try {
      const { integration, octokit, authMode } = await this.getInstallationClientContext(installationId);

      const { page = 1, per_page = 100 } = options;

      let repositories;

      if (integration && isDeviceInstallationId(integration.installation_id)) {
        // Device-flow fake installation: list all user repos
        const { data } = await octokit.request('GET /user/repos', {
          page,
          per_page,
          sort: 'updated',
          affiliation: 'owner,collaborator,organization_member',
        });
        repositories = data;
      } else if (authMode === 'user') {
        // Real installation ID but using user OAuth token (desktop mode)
        // Must use user-scoped endpoint instead of installation-scoped
        const { data } = await octokit.request('GET /user/installations/{installation_id}/repositories', {
          installation_id: parseInt(installationId),
          page,
          per_page,
        });
        repositories = data.repositories;
      } else {
        // App JWT installation token
        const { data } = await octokit.request('GET /installation/repositories', {
          page,
          per_page,
        });
        repositories = data.repositories;
      }

      return repositories.map(repo => ({
        id: repo.id,
        name: repo.name,
        fullName: repo.full_name,
        owner: repo.owner.login,
        private: repo.private,
        description: repo.description,
        cloneUrl: repo.clone_url,
        defaultBranch: repo.default_branch,
        updatedAt: repo.updated_at,
        language: repo.language,
        size: repo.size,
      }));
    } catch (error) {
      console.error(`Failed to get repositories for installation ${installationId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get detailed information about a specific repository
   *
   * @param {number} installationId - GitHub installation ID
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @returns {Promise<Object>} Repository details
   */
  async getRepositoryDetails(installationId, owner, repo) {
    try {
      const octokit = await this.getInstallationClient(installationId);

      const { data } = await octokit.request('GET /repos/{owner}/{repo}', {
        owner,
        repo,
      });

      return {
        id: data.id,
        name: data.name,
        fullName: data.full_name,
        owner: data.owner.login,
        private: data.private,
        description: data.description,
        cloneUrl: data.clone_url,
        sshUrl: data.ssh_url,
        defaultBranch: data.default_branch,
        language: data.language,
        size: data.size,
        createdAt: data.created_at,
        updatedAt: data.updated_at,
        pushedAt: data.pushed_at,
      };
    } catch (error) {
      console.error(`Failed to get repository details for ${owner}/${repo}:`, error.message);
      throw error;
    }
  }

  /**
   * Get repository contents at a specific path
   *
   * @param {number} installationId - GitHub installation ID
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {string} path - File path (default: root)
   * @param {string} ref - Branch/commit ref (default: default branch)
   * @returns {Promise<Array|Object>} Contents (array for directory, object for file)
   */
  async getRepositoryContents(installationId, owner, repo, path = '', ref = null) {
    try {
      const octokit = await this.getInstallationClient(installationId);

      const params = {
        owner,
        repo,
        path,
      };

      if (ref) {
        params.ref = ref;
      }

      const { data } = await octokit.rest.repos.getContent(params);

      return data;
    } catch (error) {
      console.error(`Failed to get contents for ${owner}/${repo}/${path}:`, error.message);
      throw error;
    }
  }

  /**
   * Create webhook for repository (for bidirectional sync)
   *
   * @param {number} installationId - GitHub installation ID
   * @param {string} owner - Repository owner
   * @param {string} repo - Repository name
   * @param {string} webhookUrl - AtlasEngine webhook URL
   * @returns {Promise<Object>} Created webhook data
   */
  async createWebhook(installationId, owner, repo, webhookUrl) {
    try {
      const octokit = await this.getInstallationClient(installationId);
      const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;

      if (!webhookSecret) {
        throw new Error('GITHUB_WEBHOOK_SECRET environment variable is not set');
      }

      const { data } = await octokit.request('POST /repos/{owner}/{repo}/hooks', {
        owner,
        repo,
        config: {
          url: webhookUrl,
          content_type: 'json',
          secret: webhookSecret,
          insecure_ssl: '0', // Require SSL
        },
        events: ['push', 'pull_request'],
        active: true,
      });

      console.log(`✅ Created webhook for ${owner}/${repo}`);

      return {
        id: data.id,
        url: data.config.url,
        events: data.events,
        active: data.active,
      };
    } catch (error) {
      // Webhook might already exist - not critical
      if (error.status === 422) {
        console.warn(`Webhook already exists for ${owner}/${repo}`);
        return null;
      }

      console.error(`Failed to create webhook for ${owner}/${repo}:`, error.message);
      throw error;
    }
  }

  /**
   * Store GitHub installation in database
   *
   * @param {string} userId - AtlasEngine user ID
   * @param {Object} installationData - Installation data from GitHub
   * @returns {Promise<Object>} Stored integration record
   */
  async storeInstallation(userId, installationData) {
    try {
      const {
        installation_id,
        account_login,
        account_type,
        account_avatar_url,
        token,
        token_expires_at,
        repositories,
        permissions,
      } = installationData;

      const encryptedToken = encrypt(token);

      const result = await db.query(
        `INSERT INTO github_integrations (
          user_id, installation_id, account_login, account_type, account_avatar_url,
          access_token_encrypted, token_expires_at, repositories_accessible, permissions
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (installation_id)
        DO UPDATE SET
          access_token_encrypted = EXCLUDED.access_token_encrypted,
          token_expires_at = EXCLUDED.token_expires_at,
          repositories_accessible = EXCLUDED.repositories_accessible,
          permissions = EXCLUDED.permissions,
          suspended_at = NULL,
          is_active = TRUE,
          updated_at = NOW()
        RETURNING *`,
        [
          userId,
          installation_id,
          account_login,
          account_type,
          account_avatar_url,
          encryptedToken,
          token_expires_at,
          JSON.stringify(repositories),
          JSON.stringify(permissions),
        ]
      );

      console.log(`✅ Stored GitHub installation ${installation_id} for user ${userId}`);

      return result.rows[0];
    } catch (error) {
      console.error('Failed to store GitHub installation:', error.message);
      throw error;
    }
  }

  /**
   * Get user's GitHub installation
   *
   * @param {string} userId - AtlasEngine user ID
   * @returns {Promise<Object|null>} Integration record or null
   */
  async getInstallation(userId) {
    try {
      let result;

      if (isDesktopMode) {
        result = await db.query(
          `SELECT * FROM github_integrations
           WHERE user_id = $1 AND is_active = TRUE AND installation_id < 0
           ORDER BY created_at DESC
           LIMIT 1`,
          [userId]
        );
      }

      if (!result || result.rows.length === 0) {
        result = await db.query(
          `SELECT * FROM github_integrations
           WHERE user_id = $1 AND is_active = TRUE
           ORDER BY created_at DESC
           LIMIT 1`,
          [userId]
        );
      }

      if (result.rows.length === 0) {
        return null;
      }

      const integration = result.rows[0];

      // Device-flow rows always use the OAuth token path.
      if (isDeviceInstallationId(integration.installation_id)) {
        return integration;
      }

      const appReady = await this.ensureAppAuthentication();

      // Check if token needs refresh (App JWT path only). Real installations may
      // also carry a user token for desktop fallback, but that should not disable
      // installation-token refresh when the GitHub App is available.
      if (appReady && this.isTokenExpired(integration.token_expires_at)) {
        console.log(`🔄 Token expired for installation ${integration.installation_id}, refreshing...`);
        await this.refreshInstallationToken(integration.installation_id);

        // Fetch updated record
        const updatedResult = await db.query(
          'SELECT * FROM github_integrations WHERE installation_id = $1 AND is_active = TRUE',
          [integration.installation_id]
        );
        return updatedResult.rows[0];
      }

      return integration;
    } catch (error) {
      console.error(`Failed to get installation for user ${userId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get installation by installation ID
   *
   * @param {number} installationId - GitHub installation ID
   * @returns {Promise<Object|null>} Integration record or null
   */
  async getInstallationById(installationId) {
    try {
      const result = await db.query(
        'SELECT * FROM github_integrations WHERE installation_id = $1 AND is_active = TRUE',
        [installationId]
      );

      return result.rows.length > 0 ? result.rows[0] : null;
    } catch (error) {
      console.error(`Failed to get installation ${installationId}:`, error.message);
      throw error;
    }
  }

  /**
   * Delete/deactivate GitHub installation
   *
   * @param {number} installationId - GitHub installation ID
   * @returns {Promise<boolean>} Success status
   */
  async deleteInstallation(installationId) {
    try {
      // Soft delete - mark as inactive
      await db.query(
        `UPDATE github_integrations
         SET is_active = FALSE, suspended_at = NOW(), updated_at = NOW()
         WHERE installation_id = $1`,
        [installationId]
      );

      // Also disable sync for all projects using this installation
      await db.query(
        `UPDATE projects
         SET github_sync_enabled = FALSE, github_sync_status = 'disabled', updated_at = NOW()
         WHERE github_installation_id = $1`,
        [installationId]
      );

      console.log(`✅ Deactivated GitHub installation ${installationId}`);

      return true;
    } catch (error) {
      console.error(`Failed to delete installation ${installationId}:`, error.message);
      throw error;
    }
  }

  /**
   * Get decrypted access token for installation
   *
   * @param {number} installationId - GitHub installation ID
   * @returns {Promise<string>} Decrypted access token
   */
  async getDecryptedToken(installationId) {
    try {
      const integration = await this.getInstallationById(installationId);

      if (!integration) {
        throw new Error(`Installation ${installationId} not found`);
      }

      if (isDeviceInstallationId(integration.installation_id)) {
        return await this.getUserScopedAccessToken(integration);
      }

      const appReady = await this.ensureAppAuthentication();

      if (appReady) {
        const shouldRefreshInstallationToken = (
          !integration.access_token_encrypted
          || this.isTokenExpired(integration.token_expires_at)
        );

        if (shouldRefreshInstallationToken) {
          const { token } = await this.refreshInstallationToken(installationId);
          return token;
        }

        return decrypt(integration.access_token_encrypted);
      }

      return await this.getUserScopedAccessToken(integration);
    } catch (error) {
      console.error(`Failed to get decrypted token for ${installationId}:`, error.message);
      throw error;
    }
  }

  /**
   * Create a new GitHub repository
   * Used when user wants to create a new GitHub repo from an AtlasEngine project
   *
   * @param {number} installationId - GitHub installation ID
   * @param {Object} options - Repository options
   * @param {string} options.name - Repository name
   * @param {string} [options.description] - Repository description
   * @param {boolean} [options.private] - Whether repo should be private (default: true)
   * @param {string} [options.org] - Organization name (if creating under org)
   * @returns {Promise<Object>} Created repository data
   */
  async createRepository(installationId, options) {
    try {
      const { name, description, private: isPrivate = true, org } = options;

      console.log(`📦 Creating GitHub repository: ${org ? `${org}/` : ''}${name}...`);

      let octokit;
      let usingUserToken = false;

      // For personal accounts (no org), try to use user-to-server token
      if (!org) {
        try {
          // Get installation details including user access token
          const result = await db.query(
            'SELECT user_access_token_encrypted FROM github_integrations WHERE installation_id = $1',
            [installationId]
          );

          if (result.rows.length > 0 && result.rows[0].user_access_token_encrypted) {
            // Decrypt user access token
            const { decrypt } = await import('../utils/encryption.js');
            const userAccessToken = decrypt(result.rows[0].user_access_token_encrypted);

            // Create Octokit instance with user token
            const { Octokit } = await import('@octokit/rest');
            octokit = new Octokit({ auth: userAccessToken });
            usingUserToken = true;

            // Verify token is valid before using it
            try {
              const { headers } = await octokit.request('GET /user');
              console.log(`🔑 Using user access token for personal account repository creation`);
              console.log(`📋 Token scopes:`, headers['x-oauth-scopes']);
            } catch (scopeError) {
              console.log(`⚠️  User access token invalid, falling back to installation token:`, scopeError.message);
              octokit = null;  // Reset so we fall back to installation token
              usingUserToken = false;
            }
          }
        } catch (tokenError) {
          console.log(`⚠️  Could not retrieve user access token, falling back to installation token:`, tokenError.message);
        }
      }

      // Fall back to installation token (for organizations or if user token not available)
      if (!octokit) {
        octokit = await this.getInstallationClient(installationId);
      }

      // Create repository
      const { data } = org
        ? await octokit.request('POST /orgs/{org}/repos', {
            org,
            name,
            description: description || '',
            private: isPrivate,
            auto_init: false, // Don't create README - we'll push from AtlasEngine
          })
        : await octokit.request('POST /user/repos', {
            name,
            description: description || '',
            private: isPrivate,
            auto_init: false,
          });

      console.log(`✅ Created GitHub repository: ${data.full_name}`);

      return {
        id: data.id,
        name: data.name,
        full_name: data.full_name,
        owner: data.owner.login,
        private: data.private,
        html_url: data.html_url,
        clone_url: data.clone_url,
        default_branch: data.default_branch || 'main',
        created_at: data.created_at,
      };
    } catch (error) {
      // Handle specific GitHub errors
      if (error.status === 422) {
        throw new Error(`Repository '${options.name}' already exists`);
      }

      // GitHub Apps cannot create repositories in personal accounts (with installation tokens)
      if (error.status === 403 && error.message?.includes('Resource not accessible')) {
        throw new Error(
          `Unable to create repository in personal account. ` +
          `Please authorize the GitHub App to "act on your behalf" by visiting ` +
          `the Connect GitHub page and clicking "Authorize GitHub App".`
        );
      }

      console.error(`Failed to create repository:`, error.message);
      throw new Error(`Failed to create GitHub repository: ${error.message}`);
    }
  }

  /**
   * Health check for GitHub service
   * Tests GitHub App authentication
   *
   * @returns {Promise<Object>} Health status
   */
  async healthCheck() {
    try {
      if (isDesktopMode) {
        if (!process.env.GITHUB_APP_CLIENT_ID) {
          return {
            healthy: false,
            error: 'GITHUB_APP_CLIENT_ID environment variable is not set',
          };
        }
        return {
          healthy: true,
          appName: 'GitHub OAuth (Device Flow)',
          appId: process.env.GITHUB_APP_CLIENT_ID,
        };
      }

      if (!this.initialized) {
        await this.initializeApp();
      }

      // Simple health check - if app is initialized, it's healthy
      return {
        healthy: true,
        appName: 'Atlas Engine GitHub App',
        appId: process.env.GITHUB_APP_ID,
      };
    } catch (error) {
      return {
        healthy: false,
        error: error.message,
      };
    }
  }

  // ── Pull Request API methods ───────────────────────────────────────────────

  /**
   * List pull requests for a repository.
   * Fetches individual PR stats (additions/deletions) in parallel.
   *
   * @param {number} installationId
   * @param {string} owner
   * @param {string} repo
   * @param {object} [options]
   * @param {string} [options.state='open']
   * @param {number} [options.per_page=30]
   * @param {string} [options.sort='updated']
   * @param {string} [options.direction='desc']
   * @returns {Promise<Array>}
   */
  async listPullRequests(installationId, owner, repo, options = {}) {
    const octokit = await this.getInstallationClient(installationId);
    const { state = 'open', sort = 'updated', direction = 'desc' } = options;
    const maxResults = Number.isFinite(Number(options.maxResults)) && Number(options.maxResults) > 0
      ? Math.trunc(Number(options.maxResults))
      : null;

    // Paginate to fetch all matching PRs (GitHub caps per_page at 100)
    const pulls = [];
    let page = 1;
    const perPage = maxResults ? Math.min(100, maxResults) : 100;

    while (true) {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls', {
        owner,
        repo,
        state,
        per_page: perPage,
        sort,
        direction,
        page,
      });
      const pagePulls = Array.isArray(data) ? data : [];
      pulls.push(...pagePulls);
      if (maxResults && pulls.length >= maxResults) {
        pulls.length = maxResults;
        break;
      }
      if (pagePulls.length < perPage) break;
      page += 1;
    }

    // The list endpoint doesn't include additions/deletions/changed_files —
    // fetch individual PRs in parallel with bounded concurrency.
    const PR_STAT_CONCURRENCY = 5;
    const results = [];
    for (let i = 0; i < pulls.length; i += PR_STAT_CONCURRENCY) {
      const batch = pulls.slice(i, i + PR_STAT_CONCURRENCY);
      const detailed = await Promise.all(
        batch.map(async (pr) => {
          try {
            const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
              owner,
              repo,
              pull_number: pr.number,
            });
            return {
              number: data.number,
              title: data.title,
              body: data.body,
              state: derivePrLifecycleState(data),
              draft: data.draft,
              user: data.user ? { login: data.user.login, avatar_url: data.user.avatar_url } : null,
              assignees: Array.isArray(data.assignees)
                ? data.assignees
                  .map((assignee) => assignee?.login)
                  .filter(Boolean)
                : [],
              requested_reviewers: Array.isArray(data.requested_reviewers)
                ? data.requested_reviewers
                  .map((reviewer) => reviewer?.login)
                  .filter(Boolean)
                : [],
              reviewer_participants: [],
              head: { ref: data.head.ref, sha: data.head.sha, label: data.head.label },
              base: { ref: data.base.ref, sha: data.base.sha, label: data.base.label },
              html_url: data.html_url,
              created_at: data.created_at,
              updated_at: data.updated_at,
              closed_at: data.closed_at,
              merged_at: data.merged_at,
              additions: data.additions,
              deletions: data.deletions,
              changed_files: data.changed_files,
              commits: data.commits,
              comments: data.comments,
              review_comments: data.review_comments,
              mergeable: data.mergeable,
              merge_commit_sha: data.merge_commit_sha,
            };
          } catch (err) {
            // Fallback to list data (without stats)
            return {
              number: pr.number,
              title: pr.title,
              body: pr.body,
              state: derivePrLifecycleState(pr),
              draft: pr.draft,
              user: pr.user ? { login: pr.user.login, avatar_url: pr.user.avatar_url } : null,
              assignees: Array.isArray(pr.assignees)
                ? pr.assignees
                  .map((assignee) => assignee?.login)
                  .filter(Boolean)
                : [],
              requested_reviewers: Array.isArray(pr.requested_reviewers)
                ? pr.requested_reviewers
                  .map((reviewer) => reviewer?.login)
                  .filter(Boolean)
                : [],
              reviewer_participants: [],
              head: { ref: pr.head.ref, sha: pr.head.sha, label: pr.head.label },
              base: { ref: pr.base.ref, sha: pr.base.sha, label: pr.base.label },
              html_url: pr.html_url,
              created_at: pr.created_at,
              updated_at: pr.updated_at,
              closed_at: pr.closed_at,
              merged_at: pr.merged_at,
              additions: 0,
              deletions: 0,
              changed_files: 0,
              commits: 0,
              comments: pr.comments,
              review_comments: pr.review_comments,
              mergeable: null,
              merge_commit_sha: null,
            };
          }
        })
      );
      results.push(...detailed);
    }

    return results;
  }

  /**
   * Get detailed metadata for a single pull request.
   *
   * @param {number} installationId
   * @param {string} owner
   * @param {string} repo
   * @param {number} pullNumber
   * @returns {Promise<Object>}
   */
  async getPullRequestDetail(installationId, owner, repo, pullNumber) {
    const octokit = await this.getInstallationClient(installationId);
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner,
      repo,
      pull_number: pullNumber,
    });
    return data;
  }

  /**
   * List submitted pull request reviews.
   *
   * @param {number} installationId
   * @param {string} owner
   * @param {string} repo
   * @param {number} pullNumber
   * @returns {Promise<Array>}
   */
  async getPullRequestReviews(installationId, owner, repo, pullNumber) {
    const octokit = await this.getInstallationClient(installationId);
    const reviews = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: perPage,
        page,
      });
      reviews.push(...data);
      if (data.length < perPage) break;
      page += 1;
    }

    return reviews;
  }

  /**
   * Summarize review-comment threads on a pull request into bounded, prompt-friendly rows.
   *
   * @param {number} installationId
   * @param {string} owner
   * @param {string} repo
   * @param {number} pullNumber
   * @returns {Promise<Array<{path: string, line: number | null, author: string | null, summary: string, replyCount: number, updatedAt: string | null}>>}
   */
  async getPullRequestReviewThreads(installationId, owner, repo, pullNumber) {
    const octokit = await this.getInstallationClient(installationId);
    const comments = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/comments', {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: perPage,
        page,
      });

      comments.push(...(Array.isArray(data) ? data : []));
      if (!Array.isArray(data) || data.length < perPage) break;
      page += 1;
    }

    if (comments.length === 0) return [];

    const replyBuckets = new Map();

    for (const comment of comments) {
      if (!comment || typeof comment !== 'object') continue;
      const replyTo = comment.in_reply_to_id;
      if (replyTo == null) continue;
      const replies = replyBuckets.get(replyTo) || [];
      replies.push(comment);
      replyBuckets.set(replyTo, replies);
    }

    const rootThreads = comments
      .filter((comment) => comment && comment.in_reply_to_id == null)
      .map((rootComment) => {
        const replies = replyBuckets.get(rootComment.id) || [];
        const orderedReplies = [...replies].sort((left, right) => (
          String(left?.created_at || '').localeCompare(String(right?.created_at || ''))
        ));
        const pathValue = String(rootComment.path || '').trim();
        const lineValue = Number(rootComment.line || rootComment.original_line || 0);
        const author = String(rootComment.user?.login || '').trim() || null;
        const rootBody = String(rootComment.body || '').replace(/\s+/g, ' ').trim();
        const replyPreview = orderedReplies
          .slice(0, 2)
          .map((reply) => String(reply?.body || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
          .join(' | ');
        const combinedSummary = [rootBody, replyPreview]
          .filter(Boolean)
          .join(' | ');
        return {
          path: pathValue,
          line: Number.isFinite(lineValue) && lineValue > 0 ? lineValue : null,
          author,
          summary: combinedSummary,
          replyCount: orderedReplies.length,
          updatedAt: orderedReplies[orderedReplies.length - 1]?.updated_at || rootComment.updated_at || null,
        };
      })
      .filter((thread) => thread.path && thread.summary);

    rootThreads.sort((left, right) => {
      const updatedAtDiff = String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''));
      if (updatedAtDiff !== 0) return updatedAtDiff;
      const pathDiff = String(left.path || '').localeCompare(String(right.path || ''));
      if (pathDiff !== 0) return pathDiff;
      return (right.replyCount || 0) - (left.replyCount || 0);
    });

    return rootThreads;
  }

  /**
   * Fetch full pull-request review-thread state from GitHub GraphQL.
   * REST review comments do not expose resolved/unresolved thread state, so
   * Atlas uses GraphQL for durable conversation sync.
   *
   * @param {number} installationId
   * @param {string} owner
   * @param {string} repo
   * @param {number} pullNumber
   * @returns {Promise<{pullRequestNodeId: string | null, reviewDecision: string | null, mergeStateStatus: string | null, threads: Array}>}
   */
  async getPullRequestConversationThreads(installationId, owner, repo, pullNumber) {
    const octokit = await this.getInstallationClient(installationId);
    if (typeof octokit.graphql !== 'function') {
      throw new Error('GitHub GraphQL client is unavailable for this installation.');
    }

    const query = `
      query AtlasPullRequestReviewThreads($owner: String!, $repo: String!, $pullNumber: Int!, $after: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pullNumber) {
            id
            reviewDecision
            mergeStateStatus
            reviewThreads(first: 100, after: $after) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                isResolved
                isOutdated
                resolvedBy {
                  login
                }
                path
                line
                startLine
                originalLine
                originalStartLine
                diffSide
                comments(first: 100) {
                  nodes {
                    id
                    databaseId
                    body
                    bodyText
                    author {
                      login
                      url
                      avatarUrl
                    }
                    createdAt
                    updatedAt
                    url
                    path
                    line
                    startLine
                    diffHunk
                    isMinimized
                    minimizedReason
                    replyTo {
                      id
                    }
                    pullRequestReview {
                      id
                      databaseId
                      state
                      submittedAt
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const threads = [];
    let after = null;
    let pullRequestNodeId = null;
    let reviewDecision = null;
    let mergeStateStatus = null;

    while (true) {
      const result = await octokit.graphql(query, {
        owner,
        repo,
        pullNumber: Number(pullNumber),
        after,
      });
      const pullRequest = result?.repository?.pullRequest || null;
      if (!pullRequest) {
        return {
          pullRequestNodeId,
          reviewDecision,
          mergeStateStatus,
          threads,
        };
      }
      pullRequestNodeId = pullRequest.id || pullRequestNodeId;
      reviewDecision = pullRequest.reviewDecision || reviewDecision;
      mergeStateStatus = pullRequest.mergeStateStatus || mergeStateStatus;
      const connection = pullRequest.reviewThreads || {};
      threads.push(...(Array.isArray(connection.nodes) ? connection.nodes.filter(Boolean) : []));
      if (!connection.pageInfo?.hasNextPage) break;
      after = connection.pageInfo.endCursor || null;
      if (!after) break;
    }

    return {
      pullRequestNodeId,
      reviewDecision,
      mergeStateStatus,
      threads,
    };
  }

  /**
   * Reply to an existing pull-request review thread.
   *
   * GitHub exposes review thread replies through GraphQL; REST review
   * comments do not carry the thread-resolution model Atlas syncs.
   */
  async addPullRequestReviewThreadReply(installationId, threadNodeId, body) {
    const normalizedThreadNodeId = String(threadNodeId || '').trim();
    const normalizedBody = String(body || '').trim();
    if (!normalizedThreadNodeId) throw new Error('GitHub review thread id is required.');
    if (!normalizedBody) throw new Error('Reply body is required.');

    const { octokit } = await this.getUserPreferredConversationMutationClient(installationId);
    if (typeof octokit.graphql !== 'function') {
      throw new Error('GitHub GraphQL client is unavailable for this installation.');
    }

    const mutation = `
      mutation AtlasAddPullRequestReviewThreadReply($threadId: ID!, $body: String!) {
        addPullRequestReviewThreadReply(input: {
          pullRequestReviewThreadId: $threadId,
          body: $body
        }) {
          comment {
            id
            databaseId
            body
            bodyText
            createdAt
            updatedAt
            url
            author {
              login
              url
              avatarUrl
            }
            replyTo {
              id
            }
          }
        }
      }
    `;

    const result = await octokit.graphql(mutation, {
      threadId: normalizedThreadNodeId,
      body: normalizedBody,
    });
    return result?.addPullRequestReviewThreadReply?.comment || null;
  }

  /**
   * Resolve or reopen an existing pull-request review thread.
   */
  async setPullRequestReviewThreadResolved(installationId, threadNodeId, resolved) {
    const normalizedThreadNodeId = String(threadNodeId || '').trim();
    if (!normalizedThreadNodeId) throw new Error('GitHub review thread id is required.');

    const { octokit } = await this.getUserPreferredConversationMutationClient(installationId);
    if (typeof octokit.graphql !== 'function') {
      throw new Error('GitHub GraphQL client is unavailable for this installation.');
    }

    const mutation = resolved ? `
      mutation AtlasResolveReviewThread($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) {
          thread {
            id
            isResolved
            isOutdated
            resolvedBy {
              login
            }
          }
        }
      }
    ` : `
      mutation AtlasUnresolveReviewThread($threadId: ID!) {
        unresolveReviewThread(input: { threadId: $threadId }) {
          thread {
            id
            isResolved
            isOutdated
            resolvedBy {
              login
            }
          }
        }
      }
    `;

    const result = await octokit.graphql(mutation, { threadId: normalizedThreadNodeId });
    return resolved
      ? (result?.resolveReviewThread?.thread || null)
      : (result?.unresolveReviewThread?.thread || null);
  }

  /**
   * Edit a pull-request review comment reply.
   */
  async updatePullRequestReviewComment(installationId, owner, repo, commentDatabaseId, body, options = {}) {
    const normalizedOwner = String(owner || '').trim();
    const normalizedRepo = String(repo || '').trim();
    const normalizedBody = String(body || '').trim();
    const commentId = Number(commentDatabaseId);
    if (!normalizedOwner || !normalizedRepo) throw new Error('GitHub repository is required.');
    if (!Number.isFinite(commentId) || commentId <= 0) throw new Error('GitHub review comment id is required.');
    if (!normalizedBody) throw new Error('Comment body is required.');

    const { octokit } = await this.getConversationRestMutationClient(installationId, options.authMode || 'user');
    const { data } = await octokit.request('PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}', {
      owner: normalizedOwner,
      repo: normalizedRepo,
      comment_id: Math.trunc(commentId),
      body: normalizedBody,
    });
    return data;
  }

  /**
   * Delete a pull-request review comment reply.
   */
  async deletePullRequestReviewComment(installationId, owner, repo, commentDatabaseId, options = {}) {
    const normalizedOwner = String(owner || '').trim();
    const normalizedRepo = String(repo || '').trim();
    const commentId = Number(commentDatabaseId);
    if (!normalizedOwner || !normalizedRepo) throw new Error('GitHub repository is required.');
    if (!Number.isFinite(commentId) || commentId <= 0) throw new Error('GitHub review comment id is required.');

    const { octokit } = await this.getConversationRestMutationClient(installationId, options.authMode || 'user');
    await octokit.request('DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}', {
      owner: normalizedOwner,
      repo: normalizedRepo,
      comment_id: Math.trunc(commentId),
    });
    return true;
  }

  /**
   * Add a top-level pull-request conversation comment. GitHub models these as
   * issue comments on the pull request issue.
   */
  async addPullRequestIssueComment(installationId, owner, repo, pullNumber, body) {
    const normalizedOwner = String(owner || '').trim();
    const normalizedRepo = String(repo || '').trim();
    const issueNumber = Number(pullNumber);
    const normalizedBody = String(body || '').trim();
    if (!normalizedOwner || !normalizedRepo) throw new Error('GitHub repository is required.');
    if (!Number.isFinite(issueNumber) || issueNumber <= 0) throw new Error('GitHub pull request number is required.');
    if (!normalizedBody) throw new Error('Comment body is required.');

    const { octokit } = await this.getUserPreferredConversationMutationClient(installationId);
    const { data } = await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/comments', {
      owner: normalizedOwner,
      repo: normalizedRepo,
      issue_number: Math.trunc(issueNumber),
      body: normalizedBody,
    });
    return data;
  }

  /**
   * Edit a top-level pull-request issue comment.
   */
  async updatePullRequestIssueComment(installationId, owner, repo, commentDatabaseId, body, options = {}) {
    const normalizedOwner = String(owner || '').trim();
    const normalizedRepo = String(repo || '').trim();
    const commentId = Number(commentDatabaseId);
    const normalizedBody = String(body || '').trim();
    if (!normalizedOwner || !normalizedRepo) throw new Error('GitHub repository is required.');
    if (!Number.isFinite(commentId) || commentId <= 0) throw new Error('GitHub issue comment id is required.');
    if (!normalizedBody) throw new Error('Comment body is required.');

    const { octokit } = await this.getConversationRestMutationClient(installationId, options.authMode || 'user');
    const { data } = await octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
      owner: normalizedOwner,
      repo: normalizedRepo,
      comment_id: Math.trunc(commentId),
      body: normalizedBody,
    });
    return data;
  }

  /**
   * Delete a top-level pull-request issue comment.
   */
  async deletePullRequestIssueComment(installationId, owner, repo, commentDatabaseId, options = {}) {
    const normalizedOwner = String(owner || '').trim();
    const normalizedRepo = String(repo || '').trim();
    const commentId = Number(commentDatabaseId);
    if (!normalizedOwner || !normalizedRepo) throw new Error('GitHub repository is required.');
    if (!Number.isFinite(commentId) || commentId <= 0) throw new Error('GitHub issue comment id is required.');

    const { octokit } = await this.getConversationRestMutationClient(installationId, options.authMode || 'user');
    await octokit.request('DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}', {
      owner: normalizedOwner,
      repo: normalizedRepo,
      comment_id: Math.trunc(commentId),
    });
    return true;
  }

  /**
   * Fetch top-level PR conversation comments. GitHub models these as issue
   * comments on the pull request issue, separate from line review threads.
   */
  async getPullRequestIssueComments(installationId, owner, repo, pullNumber) {
    const octokit = await this.getInstallationClient(installationId);
    const comments = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
        owner,
        repo,
        issue_number: pullNumber,
        per_page: perPage,
        page,
      });
      comments.push(...(Array.isArray(data) ? data : []));
      if (!Array.isArray(data) || data.length < perPage) break;
      page += 1;
    }

    return comments;
  }

  /**
   * List files changed in a pull request.
   * Handles pagination for PRs with >100 files.
   *
   * @param {number} installationId
   * @param {string} owner
   * @param {string} repo
   * @param {number} pullNumber
   * @returns {Promise<Array<{filename, status, additions, deletions, patch, previous_filename}>>}
   */
  async getPullRequestFiles(installationId, owner, repo, pullNumber) {
    const octokit = await this.getInstallationClient(installationId);
    const files = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/files', {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: perPage,
        page,
      });

      for (const f of data) {
        files.push({
          filename: f.filename,
          status: f.status,        // added, removed, modified, renamed, copied, changed, unchanged
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch || null,
          previous_filename: f.previous_filename || null,
        });
      }

      if (data.length < perPage) break;
      page += 1;
    }

    return files;
  }

  /**
   * List commits in a pull request for intent/context extraction.
   *
   * @param {number} installationId
   * @param {string} owner
   * @param {string} repo
   * @param {number} pullNumber
   * @returns {Promise<Array<{ sha: string, message: string }>>}
   */
  async getPullRequestCommits(installationId, owner, repo, pullNumber) {
    const octokit = await this.getInstallationClient(installationId);
    const commits = [];
    let page = 1;
    const perPage = 100;

    while (true) {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/commits', {
        owner,
        repo,
        pull_number: pullNumber,
        per_page: perPage,
        page,
      });

      for (const commit of data) {
        commits.push({
          sha: commit?.sha || '',
          message: commit?.commit?.message || '',
        });
      }

      if (data.length < perPage) break;
      page += 1;
    }

    return commits;
  }

  /**
   * Compare two refs and return changed files plus aggregate stats.
   *
   * @param {number} installationId
   * @param {string} owner
   * @param {string} repo
   * @param {string} baseRef
   * @param {string} headRef
   * @returns {Promise<{files: Array<{filename, status, additions, deletions, patch, previous_filename}>, totalAdditions: number, totalDeletions: number, fileCount: number, commitCount: number, truncated: boolean}>}
   */
  async getCompareFiles(installationId, owner, repo, baseRef, headRef) {
    const octokit = await this.getInstallationClient(installationId);
    const MAX_COMPARE_PAGES = 20;
    const safeBaseRef = String(baseRef || '').trim();
    const safeHeadRef = String(headRef || '').trim();
    if (!safeBaseRef || !safeHeadRef) {
      throw new Error('baseRef and headRef are required for compare');
    }

    let page = 1;
    const files = [];
    let commits = [];
    let truncated = false;

    while (true) {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
        owner,
        repo,
        basehead: `${safeBaseRef}...${safeHeadRef}`,
        per_page: 100,
        page,
      });

      if (page === 1 && Array.isArray(data?.commits)) {
        commits = data.commits;
      }

      const batch = Array.isArray(data?.files)
        ? data.files.map((file) => ({
          filename: file.filename,
          status: file.status,
          additions: Number(file.additions) || 0,
          deletions: Number(file.deletions) || 0,
          patch: file.patch || null,
          previous_filename: file.previous_filename || null,
        }))
        : [];
      files.push(...batch);

      if (batch.length < 100) break;
      if (page >= MAX_COMPARE_PAGES) {
        truncated = true;
        console.warn(`[GitHub] Compare pagination hit cap for ${owner}/${repo} ${safeBaseRef}...${safeHeadRef}`);
        break;
      }
      page += 1;
    }
    const totalAdditions = files.reduce((sum, file) => sum + Math.max(0, Number(file.additions) || 0), 0);
    const totalDeletions = files.reduce((sum, file) => sum + Math.max(0, Number(file.deletions) || 0), 0);

    return {
      files,
      totalAdditions,
      totalDeletions,
      fileCount: files.length,
      commitCount: Array.isArray(commits) ? commits.length : 0,
      truncated,
    };
  }

  /**
   * Submit a pull-request review with optional inline comments.
   *
   * @param {number} installationId
   * @param {string} owner
   * @param {string} repo
   * @param {number} pullNumber
   * @param {object} options
   * @param {'COMMENT'|'APPROVE'|'REQUEST_CHANGES'} options.event
   * @param {string} [options.body]
   * @param {string|null} [options.commitId]
   * @param {Array<{path: string, line: number, side?: 'RIGHT'|'LEFT', startLine?: number | null, startSide?: 'RIGHT'|'LEFT' | null, body: string}>} [options.comments]
   * @returns {Promise<{event: string, githubReviewId: string | null, htmlUrl: string | null, state: string | null, submittedAt: string | null}>}
   */
  async submitPullRequestReview(installationId, owner, repo, pullNumber, options = {}) {
    let { integration, octokit, authMode } = await this.getInstallationClientContext(installationId);
    if (authMode !== 'user' && options.preferUserAuth !== false) {
      const userToken = await this.resolveUserReviewFallbackToken(integration);
      if (userToken) {
        octokit = this.createAuthClient(userToken);
        authMode = 'user';
      }
    }
    const event = String(options.event || '').trim().toUpperCase() || 'COMMENT';
    const body = typeof options.body === 'string' ? options.body.trim() : '';
    const commitId = typeof options.commitId === 'string' && options.commitId.trim()
      ? options.commitId.trim()
      : null;
    const comments = Array.isArray(options.comments)
      ? options.comments
        .map((entry) => ({
          path: String(entry?.path || '').trim(),
          line: Number(entry?.line),
          side: String(entry?.side || 'RIGHT').trim().toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT',
          startLine: Number(entry?.startLine),
          startSide: String(entry?.startSide || 'RIGHT').trim().toUpperCase() === 'LEFT' ? 'LEFT' : 'RIGHT',
          body: String(entry?.body || '').trim(),
        }))
        .filter((entry) => (
          entry.path
          && Number.isFinite(entry.line)
          && entry.line > 0
          && entry.body
          && (!Number.isFinite(entry.startLine) || (entry.startLine > 0 && entry.startLine <= entry.line))
        ))
      : [];

    const payload = {
      owner,
      repo,
      pull_number: pullNumber,
      event,
      body: body || undefined,
      comments: comments.length > 0
        ? comments.map((entry) => ({
            path: entry.path,
            line: entry.line,
            side: entry.side,
            body: entry.body,
            ...(Number.isFinite(entry.startLine) && entry.startLine > 0 && entry.startLine < entry.line
              ? {
                  start_line: entry.startLine,
                  start_side: entry.startSide,
                }
              : {}),
          }))
        : undefined,
      commit_id: commitId || undefined,
    };
    const requestRoute = 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews';
    const isResourceBlockedError = (error) => (
      error?.status === 403
      && String(error?.message || '').toLowerCase().includes('resource not accessible')
    );

    let data;
    try {
      ({ data } = await octokit.request(requestRoute, payload));
    } catch (error) {
      if (!isResourceBlockedError(error)) {
        throw error;
      }
      console.warn(
        `[GitHub] PR review creation was blocked for ${owner}/${repo}#${pullNumber} using ${authMode} auth.`
      );
      if (authMode === 'user') {
        if (!isDesktopMode) {
          throw buildPullRequestReviewPermissionError();
        }
        console.warn('[GitHub] Attempting gh CLI fallback for PR review publish.');
        data = await this.submitPullRequestReviewWithGhCli(owner, repo, pullNumber, {
          event,
          body: body || undefined,
          comments: comments.length > 0 ? comments : undefined,
          commit_id: commitId || undefined,
        });
        return {
          event,
          githubReviewId: data?.id != null ? String(data.id) : null,
          htmlUrl: data?.html_url || null,
          state: data?.state || null,
          submittedAt: data?.submitted_at || data?.submittedAt || null,
        };
      }
      const userToken = await this.resolveUserReviewFallbackToken(integration);
      if (userToken) {
        const fallbackOctokit = this.createAuthClient(userToken);
        try {
          console.warn('[GitHub] Attempting user-token fallback for PR review publish.');
          ({ data } = await fallbackOctokit.request(requestRoute, payload));
        } catch (fallbackError) {
          console.warn(
            `[GitHub] User-token fallback failed for PR review publish: ${fallbackError?.message || 'unknown error'}`
          );
          if (isDesktopMode && isResourceBlockedError(fallbackError)) {
            console.warn('[GitHub] Attempting gh CLI fallback for PR review publish.');
            data = await this.submitPullRequestReviewWithGhCli(owner, repo, pullNumber, {
              event,
              body: body || undefined,
              comments: comments.length > 0 ? comments : undefined,
              commit_id: commitId || undefined,
            });
          } else if (isResourceBlockedError(fallbackError)) {
            throw buildPullRequestReviewPermissionError();
          } else {
            throw fallbackError;
          }
        }
      } else if (isDesktopMode) {
        console.warn('[GitHub] No user token fallback available, attempting gh CLI fallback for PR review publish.');
        data = await this.submitPullRequestReviewWithGhCli(owner, repo, pullNumber, {
          event,
          body: body || undefined,
          comments: comments.length > 0 ? comments : undefined,
          commit_id: commitId || undefined,
        });
      } else {
        throw buildPullRequestReviewPermissionError();
      }
    }
    return {
      event,
      githubReviewId: data?.id != null ? String(data.id) : null,
      htmlUrl: data?.html_url || null,
      state: data?.state || null,
      submittedAt: data?.submitted_at || data?.submittedAt || null,
    };
  }

  /**
   * Fetch combined status + check-run summary for a commit SHA.
   *
   * @param {number} installationId
   * @param {string} owner
   * @param {string} repo
   * @param {string} ref
   * @returns {Promise<{state: string, totalCount: number, contexts: Array<{context: string, state: string, description: string | null, targetUrl: string | null}>}>}
   */
  async getCommitCombinedStatus(installationId, owner, repo, ref) {
    const octokit = await this.getInstallationClient(installationId);
    const normalizedContexts = new Map();

    const recordContext = (
      context,
      state,
      description = null,
      targetUrl = null,
      extra = {}
    ) => {
      const normalizedContext = String(context || '').trim();
      if (!normalizedContext) return;
      normalizedContexts.set(normalizedContext, {
        context: normalizedContext,
        state: String(state || 'unknown').trim().toLowerCase() || 'unknown',
        description: description ? String(description).trim() : null,
        targetUrl: targetUrl ? String(targetUrl).trim() : null,
        status: typeof extra.status === 'string' && extra.status.trim()
          ? extra.status.trim().toLowerCase()
          : null,
        conclusion: typeof extra.conclusion === 'string' && extra.conclusion.trim()
          ? extra.conclusion.trim().toLowerCase()
          : null,
      });
    };

    try {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/status', {
        owner,
        repo,
        ref,
      });
      for (const status of Array.isArray(data?.statuses) ? data.statuses : []) {
        recordContext(
          status?.context,
          status?.state,
          status?.description || null,
          status?.target_url || null,
          {
            status: status?.state || null,
            conclusion: status?.state || null,
          }
        );
      }
    } catch (error) {
      if (error?.status !== 404) throw error;
    }

    try {
      const { data } = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
        owner,
        repo,
        ref,
        per_page: 100,
      });
      for (const checkRun of Array.isArray(data?.check_runs) ? data.check_runs : []) {
        const rawStatus = String(checkRun?.status || '').trim().toLowerCase();
        const rawConclusion = String(checkRun?.conclusion || '').trim().toLowerCase();
        let state = rawStatus || 'unknown';
        if (rawStatus === 'completed') {
          if (rawConclusion === 'success' || rawConclusion === 'neutral' || rawConclusion === 'skipped') {
            state = 'success';
          } else if (rawConclusion === 'failure' || rawConclusion === 'cancelled' || rawConclusion === 'timed_out' || rawConclusion === 'action_required') {
            state = 'failure';
          } else {
            state = rawConclusion || 'completed';
          }
        } else if (rawStatus === 'queued' || rawStatus === 'in_progress' || rawStatus === 'waiting' || rawStatus === 'requested') {
          state = 'pending';
        }

        recordContext(
          checkRun?.name,
          state,
          checkRun?.output?.title || checkRun?.conclusion || checkRun?.status || null,
          checkRun?.html_url || null,
          {
            status: rawStatus || null,
            conclusion: rawConclusion || null,
          }
        );
      }
    } catch (error) {
      if (error?.status !== 404) throw error;
    }

    const contexts = Array.from(normalizedContexts.values());
    const states = contexts.map((entry) => entry.state);
    const hasFailure = states.some((state) => state === 'failure' || state === 'error');
    const hasPending = states.some((state) => state === 'pending');
    const hasSuccess = states.length > 0 && states.every((state) => state === 'success');

    return {
      state: hasFailure ? 'failure' : hasPending ? 'pending' : hasSuccess ? 'success' : 'unknown',
      totalCount: contexts.length,
      contexts,
    };
  }
}

// Export singleton instance
const githubService = new GitHubService();
export default githubService;
