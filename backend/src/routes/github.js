/**
 * GitHub Routes
 * OAuth installation flow, repository operations, and sync management
 */

import express from 'express';
import path from 'path';
import crypto from 'crypto';
import fs from 'fs/promises';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import githubService from '../services/githubService.js';
import gitService from '../services/gitService.js';
import memoryService from '../services/memoryService.js';
import changesetService from '../services/changesetService.js';
import { enforceQuotas } from '../middleware/quotas.js';
import { createProject } from '../db/queries.js';
import * as queries from '../db/queries.js';
import db from '../db/connection.js';
import integrationsService from '../services/integrationsService.js';
import supabaseService from '../services/supabaseService.js';
import { createGeneratedProjectReviewPolicyBaseline } from '../services/review/reviewPolicyService.js';
import reviewSyncService from '../services/reviewSyncService.js';
import githubAccountConnectionService from '../services/githubAccountConnectionService.js';

const router = express.Router();

// Anonymous user ID for MVP (no authentication required)
const ANONYMOUS_USER_ID = '00000000-0000-0000-0000-000000000000';
const isDesktopMode = process.env.ATLAS_DESKTOP_MODE === 'true';
const DEVICE_FLOW_SCOPE = process.env.GITHUB_DEVICE_SCOPE || 'repo read:user read:org';
const USER_OAUTH_SCOPE = process.env.GITHUB_USER_OAUTH_SCOPE || 'repo read:user read:org';
const deviceFlows = new Map();

// Helper function to get effective user ID
function getBearerToken(req) {
  const authHeader = typeof req.get === 'function'
    ? req.get('authorization')
    : req.headers?.authorization;
  const value = String(authHeader || '').trim();
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : '';
}

async function getEffectiveUserId(req) {
  const jwtUserId = req.user?.id || null;
  if (jwtUserId && jwtUserId !== ANONYMOUS_USER_ID) {
    return jwtUserId;
  }

  const token = getBearerToken(req);
  if (token) {
    try {
      const session = await reviewSyncService.getGuestSessionByAuthToken(token);
      if (session?.userId) {
        return session.userId;
      }
    } catch {
      // Fall back to the legacy anonymous route behavior.
    }
  }

  return req.user?.id || ANONYMOUS_USER_ID;
}

async function resolveRequestedInstallation(userId, requestedInstallationId = null) {
  const parsedInstallationId = Number(requestedInstallationId);
  if (Number.isFinite(parsedInstallationId) && parsedInstallationId !== 0) {
    const installation = await githubService.getInstallationById(parsedInstallationId);
    if (!installation) {
      const error = new Error('GitHub installation not found');
      error.statusCode = 404;
      throw error;
    }
    if (String(installation.user_id) !== String(userId)) {
      const error = new Error('You do not have access to this GitHub installation');
      error.statusCode = 403;
      throw error;
    }
    return installation;
  }

  return githubService.getInstallation(userId);
}

function normalizeGitHubRepoIdentity(owner, repo) {
  const normalizedOwner = String(owner || '').trim().toLowerCase();
  const normalizedRepo = String(repo || '').trim().replace(/\.git$/i, '').toLowerCase();
  if (!normalizedOwner || !normalizedRepo) return null;
  return {
    owner: normalizedOwner,
    repo: normalizedRepo,
    fullName: `${normalizedOwner}/${normalizedRepo}`,
  };
}

function parseGitHubRepoIdentity(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const urlMatch = raw.match(/github\.com[:/]([^/]+)\/([^/\s]+?)(?:\.git)?$/i);
  if (urlMatch) {
    return normalizeGitHubRepoIdentity(urlMatch[1], urlMatch[2]);
  }

  const fullNameMatch = raw.match(/^([^/\s]+)\/([^/\s]+?)(?:\.git)?$/);
  if (fullNameMatch) {
    return normalizeGitHubRepoIdentity(fullNameMatch[1], fullNameMatch[2]);
  }

  return null;
}

function buildGitHubUserOAuthUrl(userId) {
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  const state = Buffer.from(JSON.stringify({
    userId,
    timestamp: Date.now(),
  })).toString('base64');
  const params = new URLSearchParams({
    client_id: clientId,
    scope: USER_OAUTH_SCOPE,
    state,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

function classifyRepoAccessRefreshFailure(error) {
  const status = Number(error?.status || error?.response?.status || 0);
  const message = [
    error?.message,
    error?.response?.data?.message,
    error?.error_description,
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean)
    .join(' ');

  const needsReconnect = status === 401
    || message.includes('bad credentials')
    || message.includes('token expired')
    || message.includes('refresh token')
    || message.includes('expired or revoked');

  if (needsReconnect) {
    return {
      state: 'reauth_required',
      message: 'Reconnect GitHub to load repo access',
    };
  }

  return {
    state: 'refresh_failed',
    message: 'Could not load repo access',
  };
}

function shapeClonedProjectResponse(project) {
  return {
    id: project.id,
    sessionId: project.session_id,
    name: project.name,
    description: project.description,
    framework: project.framework,
    language: project.language,
    path: project.path,
    github: project.github_repo_full_name ? {
      repoId: project.github_repo_id,
      repoFullName: project.github_repo_full_name,
      repoOwner: project.github_repo_owner,
      repoName: project.github_repo_name,
      installationId: project.github_installation_id,
      cloneUrl: project.github_clone_url,
      defaultBranch: project.github_default_branch,
      lastSyncSha: project.github_last_sync_sha,
      lastSyncAt: project.github_last_sync_at,
      webhookId: project.github_webhook_id,
      syncEnabled: project.github_sync_enabled,
      syncStatus: project.github_sync_status,
    } : null,
    hasMemory: Boolean(project.has_memory),
    status: project.status,
    source: project.source,
    createdAt: project.created_at,
    updatedAt: project.updated_at,
    lastAccessed: project.last_accessed,
  };
}

async function findExistingProjectForRepository(userId, owner, repo) {
  const target = normalizeGitHubRepoIdentity(owner, repo);
  if (!target) return null;

  const metadataMatch = await db.query(
    `SELECT * FROM projects
     WHERE user_id = $1
       AND status != 'deleted'
       AND (
         LOWER(COALESCE(github_repo_full_name, '')) = $2
         OR (
           LOWER(COALESCE(github_repo_owner, '')) = $3
           AND LOWER(COALESCE(github_repo_name, '')) = $4
         )
       )
     ORDER BY updated_at DESC
     LIMIT 1`,
    [userId, target.fullName, target.owner, target.repo]
  );

  if (metadataMatch.rows[0]) {
    return metadataMatch.rows[0];
  }

  const existingProjects = await db.query(
    `SELECT * FROM projects
     WHERE user_id = $1
       AND status != 'deleted'
     ORDER BY updated_at DESC
     LIMIT 200`,
    [userId]
  );

  for (const project of existingProjects.rows) {
    const projectPath = String(project.path || '').trim();
    if (!projectPath) continue;

    try {
      await fs.access(path.join(projectPath, '.git'));
    } catch {
      continue;
    }

    let originUrl = '';
    try {
      originUrl = await gitService.getRemoteUrl(projectPath, 'origin');
    } catch {
      continue;
    }

    const remoteIdentity = parseGitHubRepoIdentity(originUrl);
    if (remoteIdentity?.fullName === target.fullName) {
      return project;
    }
  }

  return null;
}

const STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes
const SYNC_MAX_RETRIES = Math.max(0, Number.parseInt(process.env.ATLAS_SYNC_MAX_RETRIES || '3', 10) || 3);

function isLoopbackHostname(hostname) {
  const normalized = String(hostname || '').trim().toLowerCase();
  return normalized === 'localhost' || normalized === '127.0.0.1' || normalized === '[::1]' || normalized === '::1';
}

function extractHostname(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  try {
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      return new URL(raw).hostname;
    }
    return new URL(`http://${raw}`).hostname;
  } catch {
    return null;
  }
}

function shouldUseDeviceFlow(req) {
  if (isDesktopMode) return true;

  const host = extractHostname(req.headers.host);
  const origin = extractHostname(req.headers.origin);
  const referer = extractHostname(req.headers.referer);
  const browserContextHosts = [origin, referer].filter(Boolean);

  if (browserContextHosts.length > 0) {
    return browserContextHosts.some((hostname) => isLoopbackHostname(hostname));
  }

  return Boolean(host && isLoopbackHostname(host));
}

function parseAndValidateState(stateParam) {
  let stateData;
  try {
    stateData = JSON.parse(Buffer.from(stateParam, 'base64').toString('utf8'));
  } catch {
    return { error: 'Invalid state parameter' };
  }

  if (stateData.timestamp && (Date.now() - stateData.timestamp > STATE_MAX_AGE_MS)) {
    return { error: 'State parameter expired. Please try again.' };
  }

  return { data: stateData };
}

function getGitHubOAuthClientId() {
  const clientId = process.env.GITHUB_APP_CLIENT_ID;
  if (!clientId) {
    throw new Error('GITHUB_APP_CLIENT_ID environment variable is missing');
  }
  return clientId;
}

function toIsoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function parseFilesChanged(filesChanged) {
  if (!filesChanged) return [];
  if (Array.isArray(filesChanged)) {
    return filesChanged.filter((filePath) => typeof filePath === 'string' && filePath.trim());
  }
  if (typeof filesChanged === 'string') {
    try {
      const parsed = JSON.parse(filesChanged);
      if (Array.isArray(parsed)) {
        return parsed.filter((filePath) => typeof filePath === 'string' && filePath.trim());
      }
      return [];
    } catch {
      return [];
    }
  }
  return [];
}

function deriveLifecycleStateFromJob(job) {
  const status = String(job?.status || '').trim().toLowerCase();
  const reason = String(job?.error_message || '').trim().toLowerCase();
  const retryCount = Math.max(0, Number(job?.retry_count || 0) || 0);

  if (status === 'processing') return 'processing';
  if (status === 'pending') return retryCount > 0 || reason.includes('retry') ? 'retrying' : 'queued';
  if (status === 'failed') return 'failed';
  if (status === 'completed') {
    if (reason.startsWith('superseded pull job:')) return 'superseded';
    return 'completed';
  }
  return 'queued';
}

function buildLifecycleSnapshot(job, overrides = {}) {
  const normalizedState = overrides.state || deriveLifecycleStateFromJob(job);
  const retryCount = Math.max(0, Number(overrides.retryCount ?? job?.retry_count ?? 0) || 0);
  const reason = overrides.reason ?? job?.error_message ?? null;
  return {
    projectId: overrides.projectId || job?.project_id || null,
    jobId: job?.id || null,
    syncType: overrides.syncType || job?.sync_type || null,
    state: normalizedState,
    commitSha: normalizeCommitSha(overrides.commitSha ?? job?.commit_sha ?? null),
    reason: reason ? String(reason) : null,
    retry: {
      count: retryCount,
      max: SYNC_MAX_RETRIES,
      willRetry: normalizedState === 'retrying',
      backoffMs: Number.isFinite(overrides.backoffMs) ? Number(overrides.backoffMs) : null,
      nextAttemptAt: toIsoOrNull(overrides.nextAttemptAt),
    },
    filesChanged: parseFilesChanged(overrides.filesChanged ?? job?.files_changed),
    terminal: normalizedState === 'completed' || normalizedState === 'failed' || normalizedState === 'superseded',
    superseded: normalizedState === 'superseded',
    reusedExistingJob: Boolean(overrides.reusedExistingJob),
    timestamps: {
      createdAt: toIsoOrNull(job?.created_at),
      startedAt: toIsoOrNull(job?.started_at),
      completedAt: toIsoOrNull(job?.completed_at),
    },
    updatedAt: new Date().toISOString(),
  };
}

function serializeQueueJob(job, overrides = {}) {
  if (!job) return null;
  const lifecycle = buildLifecycleSnapshot(job, overrides);
  return {
    id: job.id,
    type: lifecycle.syncType,
    status: job.status,
    createdAt: toIsoOrNull(job.created_at),
    startedAt: toIsoOrNull(job.started_at),
    completedAt: toIsoOrNull(job.completed_at),
    retryCount: lifecycle.retry.count,
    commitSha: lifecycle.commitSha,
    reason: lifecycle.reason,
    filesChanged: lifecycle.filesChanged,
    lifecycle,
  };
}

function emitSyncLifecycleEvent(req, projectId, eventName, lifecycle, extras = {}) {
  const io = req?.app?.get?.('io');
  if (!io || !projectId) return;
  const room = `project-${projectId}`;
  const payload = {
    ...extras,
    projectId,
    type: lifecycle.syncType,
    sha: lifecycle.commitSha,
    lifecycle,
  };
  io.to(room).emit(eventName, payload);
  io.to(room).emit('sync-lifecycle', { ...lifecycle, event: eventName });
}

async function requestDeviceCode() {
  const clientId = getGitHubOAuthClientId();
  const params = new URLSearchParams({
    client_id: clientId,
    scope: DEVICE_FLOW_SCOPE
  });

  const response = await fetch('https://github.com/login/device/code', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  const payload = await response.json();
  if (!response.ok || payload.error) {
    throw new Error(payload.error_description || payload.error || 'Failed to start device flow');
  }

  return payload;
}

async function exchangeDeviceCode(deviceCode) {
  const clientId = getGitHubOAuthClientId();
  const params = new URLSearchParams({
    client_id: clientId,
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
  });

  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET;
  if (clientSecret) {
    params.append('client_secret', clientSecret);
  }

  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: params.toString()
  });

  return response.json();
}

function scheduleDevicePoll(userId) {
  const flow = deviceFlows.get(userId);
  if (!flow) return;

  if (flow.timer) {
    clearTimeout(flow.timer);
  }

  flow.timer = setTimeout(async () => {
    const current = deviceFlows.get(userId);
    if (!current) return;

    if (Date.now() >= current.expiresAt) {
      deviceFlows.delete(userId);
      return;
    }

    try {
      // If we already have the access token cached (from a previous successful exchange
      // where storage failed), skip the exchange and go straight to storage.
      let accessToken = current.cachedAccessToken;
      let tokenMeta = current.cachedTokenMeta || {};

      if (!accessToken) {
        const payload = await exchangeDeviceCode(current.deviceCode);

        if (payload.access_token) {
          accessToken = payload.access_token;
          tokenMeta = {
            refreshToken: payload.refresh_token,
            expiresIn: payload.expires_in,
            refreshTokenExpiresIn: payload.refresh_token_expires_in,
          };
          // Cache the token so retries don't need to call exchangeDeviceCode again
          // (GitHub consumes the device code after the first successful exchange)
          current.cachedAccessToken = accessToken;
          current.cachedTokenMeta = tokenMeta;
        } else if (payload.error === 'authorization_pending') {
          scheduleDevicePoll(userId);
          return;
        } else if (payload.error === 'slow_down') {
          current.intervalMs = Math.min(current.intervalMs + 5000, 120000);
          scheduleDevicePoll(userId);
          return;
        } else {
          console.error('[Device Flow] Unexpected response:', payload.error);
          deviceFlows.delete(userId);
          return;
        }
      }

      console.log('[Device Flow] Authorization complete, connecting GitHub account...');
      await githubAccountConnectionService.connectGitHubAccount({
        userId,
        accessToken,
        tokenMeta,
        source: 'github_connect_device',
      });
      console.log('[Device Flow] GitHub account connected successfully');
      deviceFlows.delete(userId);
    } catch (error) {
      console.error('[Device Flow] Poll error:', error.message);
      // Retry on transient errors (network or storage)
      if (current && Date.now() < current.expiresAt) {
        current.retryCount = (current.retryCount || 0) + 1;
        if (current.retryCount < 10) {
          console.log(`[Device Flow] Retrying (attempt ${current.retryCount}/10)...`);
          scheduleDevicePoll(userId);
          return;
        }
        console.error('[Device Flow] Max retries reached, giving up');
      }
      deviceFlows.delete(userId);
    }
  }, flow.intervalMs);
}

async function startDeviceFlow(userId, options = {}) {
  const forceNew = options.forceNew === true;
  const currentFlow = deviceFlows.get(userId);
  if (forceNew && currentFlow) {
    if (currentFlow.timer) {
      clearTimeout(currentFlow.timer);
    }
    deviceFlows.delete(userId);
  }
  if (!forceNew && currentFlow && currentFlow.expiresAt > Date.now()) {
    return currentFlow;
  }
  if (currentFlow) {
    deviceFlows.delete(userId);
  }

  const payload = await requestDeviceCode();

  const flow = {
    deviceCode: payload.device_code,
    userCode: payload.user_code,
    verificationUri: payload.verification_uri,
    verificationUriComplete: payload.verification_uri_complete,
    intervalMs: Math.max((payload.interval || 5) * 1000, 5000),
    expiresAt: Date.now() + (payload.expires_in || 900) * 1000,
    timer: null,
  };

  deviceFlows.set(userId, flow);
  scheduleDevicePoll(userId);
  return flow;
}

/**
 * Detect package manager from lock files
 */
async function detectPackageManager(projectPath) {
  try {
    await fs.access(path.join(projectPath, 'pnpm-lock.yaml'));
    return 'pnpm';
  } catch { /* not pnpm */ }
  try {
    await fs.access(path.join(projectPath, 'yarn.lock'));
    return 'yarn';
  } catch { /* not yarn */ }
  return 'npm';
}

/**
 * Install project dependencies after clone
 */
function installDependencies(projectPath) {
  return new Promise((resolve, reject) => {
    detectPackageManager(projectPath).then((pm) => {
      const args = pm === 'yarn' ? ['install'] : ['install', '--include=dev'];
      console.log(`📦 Installing dependencies with ${pm}...`);

      const child = spawn(pm, args, {
        cwd: projectPath,
        stdio: 'pipe',
        env: { ...process.env, CI: 'true' },
      });

      let stderr = '';
      child.stdout.on('data', (d) => process.stdout.write(d));
      child.stderr.on('data', (d) => { stderr += d.toString(); });

      child.on('close', (code) => {
        if (code === 0) {
          console.log(`✅ Dependencies installed successfully`);
          resolve();
        } else {
          reject(new Error(`${pm} install exited with code ${code}\n${stderr}`));
        }
      });

      child.on('error', (err) => reject(err));
    });
  });
}

/**
 * GET /api/github/install
 * Returns GitHub App installation URL.
 * Optional query param ?target_id=123 to pre-select an org for installation.
 */
router.get('/install', async (req, res) => {
  try {
    const appSlug = process.env.GITHUB_APP_NAME || 'atlasengine';

    if (!process.env.GITHUB_APP_CLIENT_ID) {
      return res.status(500).json({
        error: 'GitHub App not configured',
        message: 'GITHUB_APP_CLIENT_ID environment variable is missing'
      });
    }

    const state = Buffer.from(JSON.stringify({
      userId: await getEffectiveUserId(req),
      timestamp: Date.now(),
    })).toString('base64');

    // If target_id is provided, link directly to the installation page for that org.
    // Otherwise fall back to /installations/new (first-time install) or public page.
    const targetId = req.query.target_id;
    let installUrl;
    if (targetId) {
      installUrl = `https://github.com/apps/${appSlug}/installations/new/permissions?target_id=${targetId}&state=${state}`;
    } else {
      installUrl = `https://github.com/apps/${appSlug}/installations/new?state=${state}`;
    }

    res.json({
      success: true,
      installUrl,
      message: 'Redirect user to installUrl to begin GitHub App installation'
    });
  } catch (error) {
    console.error('Error generating install URL:', error);
    res.status(500).json({ error: 'Failed to generate installation URL' });
  }
});

/**
 * GET /api/github/user/orgs
 * Returns the authenticated user's GitHub organizations.
 * Used to show orgs where the App can be installed.
 */
router.get('/user/orgs', async (req, res) => {
  try {
    const userId = await getEffectiveUserId(req);
    const installation = await githubService.getInstallation(userId);

    if (!installation?.user_access_token_encrypted && !installation?.access_token_encrypted) {
      return res.json({ success: true, orgs: [] });
    }

    const { decrypt } = await import('../utils/encryption.js');
    const token = decrypt(installation.user_access_token_encrypted || installation.access_token_encrypted);

    const response = await fetch('https://api.github.com/user/orgs?per_page=100', {
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `token ${token}`,
        'User-Agent': 'AtlasEngine'
      }
    });

    if (!response.ok) {
      console.warn('[GitHub] Failed to fetch user orgs:', response.status);
      return res.json({ success: true, orgs: [] });
    }

    const orgs = await response.json();
    res.json({
      success: true,
      orgs: (Array.isArray(orgs) ? orgs : []).map(org => ({
        id: org.id,
        login: org.login,
        avatarUrl: org.avatar_url,
        description: org.description,
      })),
    });
  } catch (error) {
    console.error('[GitHub] Error fetching user orgs:', error.message);
    res.json({ success: true, orgs: [] });
  }
});

/**
 * GET /api/github/connect
 * Smart endpoint that returns the appropriate URL based on user's connection state
 * - No installation: returns installation URL
 * - Has installation but no user token: returns OAuth authorization URL
 * - Fully connected: returns success status
 */
router.get('/connect', async (req, res) => {
  try {
    const userId = await getEffectiveUserId(req);
    const preferDeviceFlow = shouldUseDeviceFlow(req);
    const forceNewAccount = String(req.query.force || '').trim().toLowerCase() === 'new-account';

    if (preferDeviceFlow || forceNewAccount) {
      const installation = await githubService.getInstallation(userId);
      if (!forceNewAccount && installation && installation.user_access_token_encrypted) {
        // Validate the token is still valid by calling GitHub API
        try {
          const { decrypt } = await import('../utils/encryption.js');
          const token = decrypt(installation.user_access_token_encrypted);
          const resp = await fetch('https://api.github.com/user', {
            headers: {
              Authorization: `token ${token}`,
              'User-Agent': 'AtlasEngine',
              'Accept': 'application/vnd.github+json',
            }
          });
          if (!resp.ok) throw new Error('Token invalid');

          return res.json({
            success: true,
            url: null,
            step: 'connected',
            message: 'GitHub account is fully connected'
          });
        } catch (tokenError) {
          // Token expired/revoked — start device flow for re-auth
          console.log(`[GitHub Connect] Device-flow user ${userId} token expired/invalid, starting device flow:`, tokenError.message);
          const flow = await startDeviceFlow(userId);
          const url = flow.verificationUriComplete || flow.verificationUri;
          return res.json({
            success: true,
            url,
            step: 'device',
            message: 'Your GitHub authorization has expired. Please re-authorize.',
            userCode: flow.userCode,
            verificationUri: flow.verificationUri
          });
        }
      }

      const flow = await startDeviceFlow(userId, { forceNew: forceNewAccount });
      const url = flow.verificationUriComplete || flow.verificationUri;
      return res.json({
        success: true,
        url,
        step: 'device',
        message: forceNewAccount
          ? 'Complete GitHub authorization in your browser to add another account'
          : 'Complete GitHub authorization in your browser',
        userCode: flow.userCode,
        verificationUri: flow.verificationUri
      });
    }

    // Check if user has an installation
    const installationResult = await db.query(
      'SELECT installation_id, user_access_token_encrypted FROM github_integrations WHERE user_id = $1 AND is_active = TRUE ORDER BY created_at DESC LIMIT 1',
      [userId]
    );

    // Case 1: No installation - need to install GitHub App first
    if (installationResult.rows.length === 0) {
      const state = Buffer.from(JSON.stringify({
        userId,
        timestamp: Date.now(),
      })).toString('base64');

      const installUrl = `https://github.com/apps/${process.env.GITHUB_APP_NAME || 'atlasengine'}/installations/new?state=${state}`;

      console.log(`[GitHub Connect] User ${userId} needs to install GitHub App`);

      return res.json({
        success: true,
        url: installUrl,
        step: 'install',
        message: 'Install the GitHub App to connect your account'
      });
    }

    // Case 2: Has installation but no user token - need to authorize
    const installation = installationResult.rows[0];

    // Helper to generate auth URL
    const getAuthUrl = () => {
      return buildGitHubUserOAuthUrl(userId);
    };

    if (!installation.user_access_token_encrypted) {
      console.log(`[GitHub Connect] User ${userId} needs to authorize GitHub App for personal repos`);

      return res.json({
        success: true,
        url: getAuthUrl(),
        step: 'authorize',
        message: 'Authorize the GitHub App to create repositories in your personal account'
      });
    }

    // Case 3: Has token - verify it's still valid
    try {
      const { decrypt } = await import('../utils/encryption.js');
      const { Octokit } = await import('@octokit/rest');

      const userToken = decrypt(installation.user_access_token_encrypted);
      const octokit = new Octokit({ auth: userToken });

      // Test the token
      await octokit.request('GET /user');

      // Token is valid - fully connected
      console.log(`[GitHub Connect] User ${userId} is fully connected to GitHub`);
      return res.json({
        success: true,
        url: null,
        step: 'connected',
        message: 'GitHub account is fully connected'
      });
    } catch (tokenError) {
      // Token is invalid - need to re-authorize
      console.log(`[GitHub Connect] User ${userId} token expired/invalid, needs to re-authorize:`, tokenError.message);

      return res.json({
        success: true,
        url: getAuthUrl(),
        step: 'reauthorize',
        message: 'Your GitHub authorization has expired. Please re-authorize to create repositories.'
      });
    }
  } catch (error) {
    console.error('Error checking GitHub connection status:', error);

    // Provide helpful error messages for common failure modes
    const cause = error.cause || error;
    const isTimeout = cause?.code === 'UND_ERR_CONNECT_TIMEOUT' || error.message?.includes('timeout');
    const isNetwork = error.message?.includes('fetch failed') || cause?.code === 'ENOTFOUND' || cause?.code === 'ECONNREFUSED';

    let userMessage = 'Failed to check connection status';
    if (isTimeout || isNetwork) {
      userMessage = 'Cannot reach GitHub. Check your internet connection and try again.';
    }

    res.status(500).json({
      success: false,
      error: userMessage,
      message: error.message
    });
  }
});

/**
 * GET /api/github/callback
 * Handle GitHub App installation callback
 *
 * Query params:
 * - installation_id: GitHub installation ID
 * - setup_action: 'install' or 'update'
 * - state: CSRF protection token
 */
router.get('/callback', async (req, res) => {
  try {
    const { installation_id, setup_action, state } = req.query;

    if (!installation_id) {
      return res.status(400).json({ error: 'Missing installation_id' });
    }

    // Verify state parameter (with expiration check)
    const { data: stateData, error: stateError } = parseAndValidateState(state);
    if (stateError) {
      return res.status(400).json({ error: stateError });
    }

    const userId = stateData.userId;

    // Initialize GitHub App
    await githubService.initializeApp();

    // Create installation access token using the App
    const octokit = await githubService.app.getInstallationOctokit(parseInt(installation_id));

    // Create installation access token to get details
    const { data: tokenData } = await octokit.request('POST /app/installations/{installation_id}/access_tokens', {
      installation_id: parseInt(installation_id)
    });

    // Get installation details using app-level auth
    const { data: installationData } = await githubService.app.octokit.request('GET /app/installations/{installation_id}', {
      installation_id: parseInt(installation_id)
    });

    // Encrypt and store the token
    const { encrypt } = await import('../utils/encryption.js');
    const encryptedToken = encrypt(tokenData.token);
    const expiresAt = new Date(tokenData.expires_at).toISOString();

    // Store installation in database
    await db.query(
      `INSERT INTO github_integrations (
        user_id, installation_id, account_login, account_type, account_avatar_url,
        access_token_encrypted, token_expires_at, is_active
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
      ON CONFLICT (installation_id)
      DO UPDATE SET
        access_token_encrypted = EXCLUDED.access_token_encrypted,
        token_expires_at = EXCLUDED.token_expires_at,
        account_login = EXCLUDED.account_login,
        account_type = EXCLUDED.account_type,
        account_avatar_url = EXCLUDED.account_avatar_url,
        suspended_at = NULL,
        is_active = TRUE,
        updated_at = NOW()
      RETURNING *`,
      [
        userId,
        parseInt(installation_id),
        installationData.account.login,
        installationData.account.type,
        installationData.account.avatar_url,
        encryptedToken,
        expiresAt
      ]
    );

    console.log(`✅ Stored GitHub installation ${installation_id} for user ${userId}`);

    // Return HTML that closes the popup window
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>GitHub Connected</title>
        </head>
        <body>
          <div style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h1>✅ GitHub Connected!</h1>
            <p>This window will close automatically...</p>
          </div>
          <script>
            // Close popup window after a short delay
            setTimeout(() => {
              window.close();
            }, 1000);
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Error handling GitHub callback:', error);

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    res.redirect(`${frontendUrl}/github/error?message=${encodeURIComponent(error.message)}`);
  }
});

/**
 * GET /api/github/authorize
 * Redirect user to GitHub OAuth authorization for user-to-server tokens
 * This enables "Act on your behalf" permission needed for personal account repo creation
 */
router.get('/authorize', async (req, res) => {
  try {
    const clientId = process.env.GITHUB_APP_CLIENT_ID;

    if (!clientId) {
      return res.status(500).json({
        error: 'GitHub App not configured',
        message: 'GITHUB_APP_CLIENT_ID environment variable is missing'
      });
    }

    // Scope 'repo' grants PR review/comment writes for private repositories.
    // read:user/read:org let Atlas attribute and discover the authorized account.
    const authUrl = buildGitHubUserOAuthUrl(await getEffectiveUserId(req));

    console.log(`[GitHub] Redirecting to OAuth authorization: ${authUrl}`);

    res.json({
      success: true,
      authUrl,
      message: 'Redirect user to authUrl to authorize GitHub App to act on their behalf'
    });
  } catch (error) {
    console.error('Error generating OAuth authorization URL:', error);
    res.status(500).json({ error: 'Failed to generate authorization URL' });
  }
});

/**
 * GET /api/github/oauth/callback
 * Handle GitHub OAuth callback and exchange code for user access token
 *
 * Query params:
 * - code: OAuth authorization code
 * - state: CSRF protection token
 */
router.get('/oauth/callback', async (req, res) => {
  try {
    const { code, state, installation_id } = req.query;

    if (!code) {
      return res.status(400).json({ error: 'Missing authorization code' });
    }

    // Verify state parameter (with expiration check)
    const { data: stateData, error: stateError } = parseAndValidateState(state);
    if (stateError) {
      return res.status(400).json({ error: stateError });
    }

    const userId = stateData.userId;

    console.log(`[GitHub OAuth] Exchanging code for user access token for user ${userId}`);

    // Exchange code for access token
    const tokenPayload = {
      client_id: process.env.GITHUB_APP_CLIENT_ID,
      code,
    };
    if (process.env.GITHUB_APP_CLIENT_SECRET) {
      tokenPayload.client_secret = process.env.GITHUB_APP_CLIENT_SECRET;
    }

    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(tokenPayload),
    });

    const tokenData = await tokenResponse.json();

    if (tokenData.error) {
      throw new Error(`GitHub OAuth error: ${tokenData.error_description || tokenData.error}`);
    }

    const userAccessToken = tokenData.access_token;

    console.log(`[GitHub OAuth] Successfully obtained user access token`);

    // Preserve the GitHub App installation-token path when the OAuth callback
    // arrives with an installation id that has not hit the install callback yet.
    const installationResult = await db.query(
      'SELECT installation_id FROM github_integrations WHERE user_id = $1 AND is_active = TRUE ORDER BY created_at DESC LIMIT 1',
      [userId]
    );

    if (installationResult.rows.length === 0 && installation_id) {
      console.log(`[GitHub OAuth] Installation not found in DB, creating it now for installation ${installation_id}`);

      await githubService.initializeApp();

      const { data: installationData } = await githubService.app.octokit.request('GET /app/installations/{installation_id}', {
        installation_id: parseInt(installation_id)
      });

      const octokit = await githubService.app.getInstallationOctokit(parseInt(installation_id));
      const { data: installationTokenData } = await octokit.request('POST /app/installations/{installation_id}/access_tokens', {
        installation_id: parseInt(installation_id)
      });

      const { encrypt } = await import('../utils/encryption.js');
      const encryptedToken = encrypt(installationTokenData.token);
      const expiresAt = new Date(installationTokenData.expires_at).toISOString();

      await db.query(
        `INSERT INTO github_integrations (
          user_id, installation_id, account_login, account_type, account_avatar_url,
          access_token_encrypted, token_expires_at, is_active
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, TRUE)
        ON CONFLICT (installation_id)
        DO UPDATE SET
          access_token_encrypted = EXCLUDED.access_token_encrypted,
          token_expires_at = EXCLUDED.token_expires_at,
          account_login = EXCLUDED.account_login,
          account_type = EXCLUDED.account_type,
          account_avatar_url = EXCLUDED.account_avatar_url,
          suspended_at = NULL,
          is_active = TRUE,
          updated_at = NOW()`,
        [
          userId,
          parseInt(installation_id),
          installationData.account.login,
          installationData.account.type,
          installationData.account.avatar_url,
          encryptedToken,
          expiresAt
        ]
      );

      console.log(`✅ Created GitHub installation ${installation_id} for user ${userId}`);
    }

    await githubAccountConnectionService.connectGitHubAccount({
      userId,
      accessToken: userAccessToken,
      tokenMeta: tokenData,
      source: 'github_oauth_callback',
    });

    // Return HTML that closes the popup window
    res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <title>GitHub Authorized</title>
        </head>
        <body>
          <div style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h1>✅ GitHub Authorized!</h1>
            <p>You can now create repositories in your personal account.</p>
            <p>This window will close automatically...</p>
          </div>
          <script>
            // Close popup window after a short delay
            setTimeout(() => {
              window.close();
            }, 1500);
          </script>
        </body>
      </html>
    `);
  } catch (error) {
    console.error('Error handling GitHub OAuth callback:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/github/installations
 * Get user's GitHub installations
 */
router.get('/installations', enforceQuotas, async (req, res) => {
  try {
    const userId = await getEffectiveUserId(req);
    const summaryOnly = ['1', 'true', 'yes'].includes(String(req.query.summary || '').trim().toLowerCase());
    const reactivateAccount = String(req.query.reactivateAccount || '').trim().toLowerCase();
    const normalizeRepositoriesAccessible = (value) => {
      if (Array.isArray(value)) return value;
      if (typeof value === 'string' && value.trim()) {
        try {
          const parsed = JSON.parse(value);
          return Array.isArray(parsed) ? parsed : null;
        } catch {
          return null;
        }
      }
      return null;
    };

    // Settings only needs the cached account list. Skip network validation there so the UI stays fast.
    if (!summaryOnly) {
      // First, try to sync installations from GitHub API (handles missed webhooks)
      try {
        const syncAuth = await githubService.resolveUserInstallationSyncAuth(userId);
        const tokenRow = syncAuth?.integration || null;
        const userToken = syncAuth?.token || null;
        const encToken = tokenRow?.user_access_token_encrypted || tokenRow?.access_token_encrypted || null;
        if (userToken && encToken) {
          const ghRes = await fetch('https://api.github.com/user/installations', {
            headers: {
              'Accept': 'application/vnd.github+json',
              'Authorization': `token ${userToken}`,
              'User-Agent': 'AtlasEngine'
            }
          });
          if (ghRes.ok) {
            const ghData = await ghRes.json();
            const appInstallations = Array.isArray(ghData.installations) ? ghData.installations : [];
            const knownIds = await db.query(
              `SELECT installation_id, is_active, suspended_at
               FROM github_integrations
               WHERE user_id = $1`,
              [userId]
            );
            // Coerce to numbers for comparison since GitHub returns numbers and DB may return bigints
            const knownSet = new Set(
              knownIds.rows
                .filter((row) => row.is_active)
                .map((row) => Number(row.installation_id))
            );
            const manuallyDisconnectedSet = new Set(
              knownIds.rows
                .filter((row) => !row.is_active && row.suspended_at)
                .map((row) => Number(row.installation_id))
            );
            for (const inst of appInstallations) {
              const accountLogin = String(inst.account?.login || '').trim().toLowerCase();
              const isRequestedReactivation = reactivateAccount && accountLogin === reactivateAccount;
              if (manuallyDisconnectedSet.has(Number(inst.id)) && !isRequestedReactivation) {
                continue;
              }
              if (!knownSet.has(Number(inst.id))) {
                // New installation not in DB — upsert it (reuse tokens from existing row)
                // Use the same token_expires_at as the existing installation
                const existingExpiry = tokenRow?.token_expires_at || new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
                await db.query(
                  `INSERT INTO github_integrations (
                    user_id, installation_id, account_login, account_type, account_avatar_url,
                    access_token_encrypted, user_access_token_encrypted, token_expires_at,
                    refresh_token_encrypted, refresh_token_expires_at, is_active
                  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, TRUE)
                  ON CONFLICT (installation_id)
                  DO UPDATE SET
                    account_login = EXCLUDED.account_login,
                    account_type = EXCLUDED.account_type,
                    account_avatar_url = EXCLUDED.account_avatar_url,
                    access_token_encrypted = COALESCE(EXCLUDED.access_token_encrypted, github_integrations.access_token_encrypted),
                    user_access_token_encrypted = COALESCE(EXCLUDED.user_access_token_encrypted, github_integrations.user_access_token_encrypted),
                    token_expires_at = COALESCE(EXCLUDED.token_expires_at, github_integrations.token_expires_at),
                    refresh_token_encrypted = COALESCE(EXCLUDED.refresh_token_encrypted, github_integrations.refresh_token_encrypted),
                    refresh_token_expires_at = COALESCE(EXCLUDED.refresh_token_expires_at, github_integrations.refresh_token_expires_at),
                    suspended_at = NULL,
                    is_active = TRUE,
                    updated_at = NOW()`,
                  [
                    userId,
                    inst.id,
                    inst.account?.login || `org-${inst.id}`,
                    inst.account?.type || 'Organization',
                    inst.account?.avatar_url || null,
                    encToken,
                    encToken,
                    existingExpiry,
                    tokenRow?.refresh_token_encrypted || null,
                    tokenRow?.refresh_token_expires_at || null,
                  ]
                );
                console.log(`[Installations] Synced new installation: ${inst.account?.login} (${inst.id})`);
              }
            }
          }
        }
      } catch (syncErr) {
        // Non-critical — fall through to DB read
        console.warn('[Installations] GitHub sync failed:', syncErr.message);
      }
    } else if (isDesktopMode) {
      try {
        await githubAccountConnectionService.claimLegacyAccountsForLinkedUser(userId);
      } catch (claimErr) {
        console.warn('[Installations] Legacy account ownership repair failed:', claimErr.message);
      }
    }

    const result = await db.query(
      `SELECT
        id,
        installation_id,
        account_login,
        account_type,
        account_avatar_url,
        is_active,
        token_expires_at,
        repositories_accessible,
        permissions,
        created_at,
        updated_at
       FROM github_integrations
       WHERE user_id = $1 AND is_active = TRUE
       ORDER BY created_at DESC`,
      [userId]
    );

    const rows = Array.isArray(result.rows) ? [...result.rows] : [];
    for (const row of rows) {
      if (summaryOnly) {
        row.repositories_accessible = normalizeRepositoriesAccessible(row.repositories_accessible);
        row.repo_access_state = null;
        row.repo_access_message = null;
        continue;
      }

      try {
        const repoNames = [];
        const seenRepoNames = new Set();
        const MAX_REPO_PAGE_REFRESHES = 100;
        for (let page = 1; page <= MAX_REPO_PAGE_REFRESHES; page += 1) {
          const repositories = await githubService.getUserRepositories(row.installation_id, {
            page,
            per_page: 100,
          });
          const names = repositories.map((repo) => repo.fullName).filter(Boolean);
          let newNames = 0;
          for (const name of names) {
            if (seenRepoNames.has(name)) continue;
            seenRepoNames.add(name);
            repoNames.push(name);
            newNames += 1;
          }
          if (repositories.length < 100 || newNames === 0) {
            break;
          }
        }
        await db.query(
          `UPDATE github_integrations
              SET repositories_accessible = $2,
                  updated_at = NOW()
            WHERE id = $1`,
          [row.id, JSON.stringify(repoNames)]
        );
        row.repositories_accessible = repoNames;
        row.repo_access_state = 'loaded';
        row.repo_access_message = null;
      } catch (repoError) {
        console.warn(
          `[Installations] Failed to refresh repositories for ${row.account_login} (${row.installation_id}):`,
          repoError?.message || repoError
        );
        row.repositories_accessible = normalizeRepositoriesAccessible(row.repositories_accessible);
        if (Array.isArray(row.repositories_accessible)) {
          row.repo_access_state = 'loaded';
          row.repo_access_message = null;
        } else {
          const failure = classifyRepoAccessRefreshFailure(repoError);
          row.repo_access_state = failure.state;
          row.repo_access_message = failure.message;
        }
      }
    }

    const installations = rows.map(row => {
      const repositoriesAccessible = normalizeRepositoriesAccessible(row.repositories_accessible);
      const reposCount = Array.isArray(repositoriesAccessible) ? repositoriesAccessible.length : null;
      return ({
      id: row.id,
      installationId: row.installation_id,
      accountLogin: row.account_login,
      accountType: row.account_type,
      avatarUrl: row.account_avatar_url,
      isActive: row.is_active,
      tokenExpiresAt: row.token_expires_at,
      reposCount,
      reposKnown: reposCount !== null,
      repoAccessState: row.repo_access_state || (reposCount !== null ? 'loaded' : 'unknown'),
      repoAccessMessage: row.repo_access_message || null,
      permissions: row.permissions,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      });
    });

    res.json({
      success: true,
      installations,
      total: installations.length,
    });
  } catch (error) {
    console.error('Error fetching installations:', error);
    res.status(500).json({ error: 'Failed to fetch GitHub installations' });
  }
});

/**
 * GET /api/github/repositories/:installationId
 * List repositories accessible via installation
 */
router.get('/repositories/:installationId', enforceQuotas, async (req, res) => {
  try {
    const { installationId } = req.params;
    const userId = await getEffectiveUserId(req);

    // Verify user owns this installation
    const installation = await githubService.getInstallationById(parseInt(installationId));

    if (!installation) {
      return res.status(404).json({ error: 'Installation not found' });
    }

    if (installation.user_id !== userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Get repositories from GitHub
    const repositories = await githubService.getUserRepositories(parseInt(installationId), {
      page: parseInt(req.query.page) || 1,
      per_page: parseInt(req.query.per_page) || 100,
    });

    res.json({
      success: true,
      repositories,
      total: repositories.length,
    });
  } catch (error) {
    console.error('Error fetching repositories:', error);
    if (error.status === 401) {
      return res.status(401).json({
        error: 'GitHub credentials expired',
        code: 'AUTH_EXPIRED',
        message: 'Your GitHub token has expired. Please reconnect your account.'
      });
    }
    res.status(500).json({ error: 'Failed to fetch repositories' });
  }
});

/**
 * GET /api/github/repo/:owner/:repo
 * Get detailed repository information
 */
router.get('/repo/:owner/:repo', enforceQuotas, async (req, res) => {
  try {
    const { owner, repo } = req.params;
    const userId = await getEffectiveUserId(req);

    // Get user's active installation
    const installation = await githubService.getInstallation(userId);

    if (!installation) {
      return res.status(404).json({
        error: 'GitHub not connected',
        message: 'Please connect your GitHub account first'
      });
    }

    // Get repository details
    const repoDetails = await githubService.getRepositoryDetails(
      installation.installation_id,
      owner,
      repo
    );

    res.json({
      success: true,
      repository: repoDetails,
    });
  } catch (error) {
    console.error('Error fetching repository details:', error);

    if (error.status === 404) {
      return res.status(404).json({ error: 'Repository not found' });
    }

    res.status(500).json({ error: 'Failed to fetch repository details' });
  }
});

/**
 * DELETE /api/github/disconnect
 * Disconnect GitHub integration
 */
router.delete('/disconnect', enforceQuotas, async (req, res) => {
  try {
    const userId = await getEffectiveUserId(req);

    // Get user's installation
    const installation = await githubService.getInstallation(userId);

    if (!installation) {
      return res.status(404).json({ error: 'No GitHub connection found' });
    }

    // Deactivate installation
    await githubService.deleteInstallation(installation.installation_id);

    res.json({
      success: true,
      message: 'GitHub integration disconnected successfully',
    });
  } catch (error) {
    console.error('Error disconnecting GitHub:', error);
    res.status(500).json({ error: 'Failed to disconnect GitHub' });
  }
});

/**
 * DELETE /api/github/installations/:installationId
 * Disconnect a single GitHub installation
 */
router.delete('/installations/:installationId', enforceQuotas, async (req, res) => {
  try {
    const userId = await getEffectiveUserId(req);
    const installationId = parseInt(req.params.installationId, 10);

    if (isNaN(installationId)) {
      return res.status(400).json({ error: 'Invalid installation ID' });
    }

    // Verify the installation belongs to this user and is active
    const result = await db.query(
      `SELECT id FROM github_integrations
       WHERE user_id = $1 AND installation_id = $2 AND is_active = TRUE`,
      [userId, installationId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Installation not found' });
    }

    await githubService.deleteInstallation(installationId);

    res.json({ success: true, message: 'Installation disconnected successfully' });
  } catch (error) {
    console.error('Error disconnecting installation:', error);
    res.status(500).json({ error: 'Failed to disconnect installation' });
  }
});

/**
 * GET /api/projects/:id/github/status
 * Get GitHub sync status for a project
 */
router.get('/projects/:id/github/status', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;

    // Get project
    const projectResult = await db.query(
      `SELECT
        id,
        github_repo_id,
        github_repo_full_name,
        github_installation_id,
        github_default_branch,
        github_last_sync_at,
        github_sync_enabled,
        github_sync_status
       FROM projects
       WHERE id = $1`,
      [id]
    );

    if (projectResult.rows.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const project = projectResult.rows[0];

    // Get recent sync events
    const eventsResult = await db.query(
      `SELECT
        id,
        direction,
        event_type,
        status,
        commit_sha,
        commit_message,
        branch,
        files_count,
        error_message,
        duration_ms,
        created_at
       FROM github_sync_events
       WHERE project_id = $1
       ORDER BY created_at DESC
       LIMIT 10`,
      [id]
    );

    res.json({
      success: true,
      project: {
        id: project.id,
        githubRepoId: project.github_repo_id,
        githubRepoFullName: project.github_repo_full_name,
        githubInstallationId: project.github_installation_id,
        defaultBranch: project.github_default_branch,
        lastSyncAt: project.github_last_sync_at,
        syncEnabled: project.github_sync_enabled,
        syncStatus: project.github_sync_status,
      },
      recentEvents: eventsResult.rows.map(event => ({
        id: event.id,
        direction: event.direction,
        eventType: event.event_type,
        status: event.status,
        commitSha: event.commit_sha,
        commitMessage: event.commit_message,
        branch: event.branch,
        filesCount: event.files_count,
        errorMessage: event.error_message,
        durationMs: event.duration_ms,
        createdAt: event.created_at,
      })),
    });
  } catch (error) {
    console.error('Error fetching GitHub status:', error);
    res.status(500).json({ error: 'Failed to fetch GitHub status' });
  }
});

/**
 * POST /api/projects/:id/github/enable
 * Enable GitHub sync for a project
 */
router.post('/projects/:id/github/enable', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;

    await db.query(
      `UPDATE projects
       SET github_sync_enabled = TRUE, github_sync_status = 'synced', updated_at = NOW()
       WHERE id = $1`,
      [id]
    );

    res.json({
      success: true,
      message: 'GitHub sync enabled',
    });
  } catch (error) {
    console.error('Error enabling GitHub sync:', error);
    res.status(500).json({ error: 'Failed to enable GitHub sync' });
  }
});

/**
 * POST /api/projects/:id/github/disable
 * Disable GitHub sync for a project
 */
router.post('/projects/:id/github/disable', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;

    await db.query(
      `UPDATE projects
       SET github_sync_enabled = FALSE, github_sync_status = 'disabled', updated_at = NOW()
       WHERE id = $1`,
      [id]
    );

    res.json({
      success: true,
      message: 'GitHub sync disabled',
    });
  } catch (error) {
    console.error('Error disabling GitHub sync:', error);
    res.status(500).json({ error: 'Failed to disable GitHub sync' });
  }
});

/**
 * POST /api/github/projects/:id/unlink
 * Unlink project from GitHub and clear all GitHub-related data
 */
router.post('/projects/:id/unlink', enforceQuotas, async (req, res) => {
  try {
    const { id } = req.params;

    // Clear all GitHub-related fields from the project
    await db.query(
      `UPDATE projects
       SET
         github_sync_enabled = FALSE,
         github_sync_status = 'disabled',
         github_repo_full_name = NULL,
         github_repo_owner = NULL,
         github_repo_name = NULL,
         github_repo_id = NULL,
         github_installation_id = NULL,
         github_clone_url = NULL,
         github_default_branch = NULL,
         github_last_sync_sha = NULL,
         github_last_sync_at = NULL,
         github_webhook_id = NULL,
         updated_at = NOW()
       WHERE id = $1`,
      [id]
    );

    // Delete all sync jobs for this project
    await db.query(
      `DELETE FROM github_sync_queue WHERE project_id = $1`,
      [id]
    );

    res.json({
      success: true,
      message: 'Project unlinked from GitHub successfully',
    });
  } catch (error) {
    console.error('Error unlinking project from GitHub:', error);
    res.status(500).json({ error: 'Failed to unlink project from GitHub' });
  }
});

/**
 * POST /api/github/clone
 * Clone a GitHub repository into a new AtlasEngine project
 *
 * Body:
 * - owner: Repository owner
 * - repo: Repository name
 * - branch: Branch to clone (optional, defaults to default branch)
 * - name: Project name (optional, defaults to repo name)
 * - description: Project description (optional)
 */
router.post('/clone', enforceQuotas, async (req, res) => {
  try {
    const { owner, repo, branch, name, description, installationId } = req.body;
    const userId = await getEffectiveUserId(req);

    if (!owner || !repo) {
      return res.status(400).json({ error: 'Owner and repo are required' });
    }

    // Get the selected GitHub installation. Import UI repository lists are scoped
    // by installation, so preserve that selection when linking the project.
    const installation = await resolveRequestedInstallation(userId, installationId);

    if (!installation) {
      return res.status(404).json({
        error: 'GitHub not connected',
        message: 'Please connect your GitHub account first'
      });
    }

    // Get repository details from GitHub
    const repoDetails = await githubService.getRepositoryDetails(
      installation.installation_id,
      owner,
      repo
    );

    const existingProject = await findExistingProjectForRepository(userId, owner, repo);
    if (existingProject) {
      const repairedProject = {
        ...existingProject,
        github_repo_id: repoDetails.id,
        github_repo_full_name: repoDetails.fullName,
        github_repo_owner: owner,
        github_repo_name: repo,
        github_installation_id: installation.installation_id,
        github_clone_url: repoDetails.cloneUrl,
        github_default_branch: repoDetails.defaultBranch,
        github_sync_enabled: true,
        github_sync_status: 'synced',
      };
      await db.query(
        `UPDATE projects
         SET github_repo_id = $1,
             github_repo_full_name = $2,
             github_installation_id = $3,
             github_default_branch = $4,
             github_clone_url = $5,
             github_repo_owner = $6,
             github_repo_name = $7,
             github_sync_enabled = TRUE,
             github_sync_status = 'synced',
             updated_at = NOW()
         WHERE id = $8`,
        [
          repoDetails.id,
          repoDetails.fullName,
          installation.installation_id,
          repoDetails.defaultBranch,
          repoDetails.cloneUrl,
          owner,
          repo,
          existingProject.id,
        ]
      );
      await queries.updateProjectLastAccessed(existingProject.id);
      return res.json({
        success: true,
        alreadyExists: true,
        project: shapeClonedProjectResponse(repairedProject),
        integrations: [],
        autoLinkedIntegrations: [],
      });
    }

    // Generate session ID and project path
    const sessionId = uuidv4();
    const projectsDir = process.env.PROJECTS_DIR || path.join(process.cwd(), '../projects');
    const projectName = name || repo;
    const projectPath = path.join(projectsDir, `${userId === ANONYMOUS_USER_ID ? 'anonymous' : userId}_${sessionId}`);

    // Get decrypted token for cloning
    // Prefer user access token for personal repos, fall back to installation token
    let token = await githubService.getDecryptedToken(installation.installation_id);
    if (installation.user_access_token_encrypted) {
      try {
        const { decrypt } = await import('../utils/encryption.js');
        token = decrypt(installation.user_access_token_encrypted);
      } catch (tokenError) {
        console.warn(`[GitHub] Failed to decrypt user access token, using installation token:`, tokenError.message);
      }
    }

    // Clone repository
    console.log(`🔄 Cloning ${owner}/${repo} to ${projectPath}...`);

    const cloneResult = await gitService.cloneRepository(
      repoDetails.cloneUrl,
      projectPath,
      {
        branch: branch || repoDetails.defaultBranch,
        token,
      }
    );

    // Detect framework and language from cloned repo
    const packageJsonPath = path.join(projectPath, 'package.json');
    let framework = null;
    let language = null;

    try {
      const packageJsonContent = await import('fs/promises').then(fs => fs.readFile(packageJsonPath, 'utf-8'));
      const packageJson = JSON.parse(packageJsonContent);

      // Detect framework
      if (packageJson.dependencies?.next || packageJson.devDependencies?.next) {
        framework = 'next';
      } else if (packageJson.dependencies?.react || packageJson.devDependencies?.react) {
        framework = 'react';
      } else if (packageJson.dependencies?.vue || packageJson.devDependencies?.vue) {
        framework = 'vue';
      } else if (packageJson.dependencies?.express) {
        framework = 'express';
      }

      // Detect language
      if (packageJson.dependencies?.typescript || packageJson.devDependencies?.typescript) {
        language = 'typescript';
      } else {
        language = 'javascript';
      }
    } catch (err) {
      // package.json might not exist or be invalid
      console.warn('Could not detect framework/language:', err.message);
    }

    // Install dependencies so project is immediately runnable and verifiable
    try {
      await installDependencies(projectPath);
    } catch (installError) {
      // Non-blocking — deps will also be installed when preview starts
      console.warn(`⚠️ Failed to install dependencies after clone:`, installError.message);
    }

    // Create project in database
    const generatedReviewPolicy = createGeneratedProjectReviewPolicyBaseline(projectPath);
    const project = await createProject({
      userId,
      sessionId,
      name: projectName,
      description: description || repoDetails.description || `Cloned from ${owner}/${repo}`,
      path: projectPath,
      framework,
      language,
      source: 'github',
      generatedReviewPolicyJson: generatedReviewPolicy.content.trim(),
      generatedReviewPolicyHash: generatedReviewPolicy.hash,
      generatedReviewPolicyVersion: generatedReviewPolicy.version,
      generatedReviewPolicyGeneratorVersion: generatedReviewPolicy.generatorVersion,
      generatedReviewPolicyGeneratedAt: generatedReviewPolicy.generatedAt,
    });

    // Update project with GitHub metadata and sync fields
    await db.query(
      `UPDATE projects
       SET github_repo_id = $1,
           github_repo_full_name = $2,
           github_installation_id = $3,
           github_default_branch = $4,
           github_clone_url = $5,
           github_repo_owner = $6,
           github_repo_name = $7,
           github_last_sync_sha = $8,
           github_last_sync_at = NOW(),
           github_sync_enabled = TRUE,
           github_sync_status = 'synced',
           updated_at = NOW()
       WHERE id = $9`,
      [
        repoDetails.id,
        repoDetails.fullName,
        installation.installation_id,
        repoDetails.defaultBranch,
        repoDetails.cloneUrl,
        owner,
        repo,
        cloneResult.latestCommit?.hash || null,
        project.id,
      ]
    );

    // Imported projects are left untouched — we do not write CLAUDE.md or .claude/
    // into the user's repo. Users opt in via the Agent Rules modal.

    // Create CS-000 baseline changeset — metadata-only snapshot of initial state
    try {
      await changesetService.createBaselineChangeset(projectPath, {
        commitSha: cloneResult.latestCommit?.hash,
        branch: branch || cloneResult.branch || 'main',
        title: `Baseline — imported from ${owner}/${repo}`,
        importSource: 'github',
      });
    } catch (csError) {
      console.warn('Could not create baseline changeset:', csError.message);
    }

    // Log sync event
    await db.query(
      `INSERT INTO github_sync_events (
        project_id, direction, event_type, status,
        commit_sha, commit_message, branch, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        project.id,
        'from_github',
        'clone',
        'success',
        cloneResult.latestCommit?.hash || null,
        cloneResult.latestCommit?.message || 'Initial clone',
        cloneResult.branch,
        JSON.stringify({
          repoFullName: repoDetails.fullName,
          repoId: repoDetails.id,
          cloneUrl: repoDetails.cloneUrl,
        }),
      ]
    );

    // Register webhook for push events (web mode only)
    if (!isDesktopMode && installation.installation_id > 0) {
      // Webhook registration is non-critical - log warning but don't fail clone if it fails
      try {
        const webhookUrl = `${process.env.API_URL || 'http://localhost:3000'}/api/github/webhook`;
        console.log(`🔗 Registering webhook for ${owner}/${repo} at ${webhookUrl}...`);

        const webhook = await githubService.createWebhook(
          installation.installation_id,
          owner,
          repo,
          webhookUrl
        );

        // Update project with webhook ID
        await db.query(
          `UPDATE projects
           SET github_webhook_id = $1
           WHERE id = $2`,
          [webhook.id, project.id]
        );

        console.log(`✅ Webhook registered successfully (ID: ${webhook.id})`);
      } catch (webhookError) {
        // Log warning but don't fail the clone operation
        console.warn(`⚠️ Failed to register webhook for ${owner}/${repo}:`, webhookError.message);
        console.warn(`   You can manually register a webhook later if needed`);
      }
    }

    console.log(`✅ Repository ${owner}/${repo} cloned successfully to project ${project.id}`);

    // Detect integrations that need configuration (no secrets configured yet)
    let integrations = [];
    try {
      const result = await integrationsService.checkProjectIntegrations(projectPath, []);
      integrations = result.integrations.filter(i => i.missingCount > 0);
    } catch (intErr) {
      console.warn('Post-clone integration detection failed (non-critical):', intErr.message);
    }

    // Attempt auto-link for Supabase if it has missing env vars
    const autoLinkedIntegrations = [];
    if (integrations.some(i => i.id === 'supabase' && i.missingCount > 0)) {
      try {
        const autoResult = await supabaseService.autoLinkIfSingleProject(
          project.id, userId, projectPath
        );
        if (autoResult?.autoLinked) {
          // Remove Supabase from missing integrations since it's now configured
          integrations = integrations.filter(i => i.id !== 'supabase');
          autoLinkedIntegrations.push({
            id: 'supabase',
            name: 'Supabase',
            supabaseProjectName: autoResult.supabaseProjectName,
          });
        }
      } catch (err) {
        console.warn('Auto-link Supabase failed (non-critical):', err.message);
      }
    }

    res.status(201).json({
      success: true,
      alreadyExists: false,
      project: {
        ...shapeClonedProjectResponse({
          ...project,
          has_memory: true,
          github_repo_id: repoDetails.id,
          github_repo_full_name: repoDetails.fullName,
          github_repo_owner: owner,
          github_repo_name: repo,
          github_installation_id: installation.installation_id,
          github_clone_url: repoDetails.cloneUrl,
          github_default_branch: repoDetails.defaultBranch,
          github_last_sync_sha: cloneResult.latestCommit?.hash || null,
          github_last_sync_at: new Date().toISOString(),
          github_webhook_id: null,
          github_sync_enabled: true,
          github_sync_status: 'synced',
        }),
      },
      cloneResult: {
        branch: cloneResult.branch,
        latestCommit: cloneResult.latestCommit,
      },
      integrations,
      autoLinkedIntegrations,
    });
  } catch (error) {
    console.error('Error cloning repository:', error);

    if (error.statusCode) {
      return res.status(error.statusCode).json({ error: error.message });
    }

    if (error.message.includes('not found') || error.message.includes('404')) {
      return res.status(404).json({ error: 'Repository not found or not accessible' });
    }

    res.status(500).json({
      error: 'Failed to clone repository',
      message: error.message,
    });
  }
});

/**
 * POST /api/github/projects/:projectId/create-repo
 * Create a new GitHub repository from an existing AtlasEngine project
 *
 * Request body:
 * {
 *   "name": "my-repo",            // Repository name (required)
 *   "description": "My project",  // Repository description (optional)
 *   "private": true,              // Whether repo should be private (optional, default: true)
 *   "org": "my-org"               // Organization name (optional, if creating under org)
 * }
 */
router.post('/projects/:projectId/create-repo', async (req, res) => {
  try {
    const { projectId } = req.params;
    const { name, description, private: isPrivate = true, org } = req.body;
    const userId = await getEffectiveUserId(req);

    console.log(`[GitHub] Creating repository for project ${projectId}...`);
    console.log(`[GitHub] Request body:`, JSON.stringify(req.body, null, 2));
    console.log(`[GitHub] Extracted values: name=${name}, org=${org}, org type=${typeof org}, org is undefined? ${org === undefined}`);

    // Validate required fields
    if (!name) {
      return res.status(400).json({ error: 'Repository name is required' });
    }

    // Validate repository name format (GitHub requirements)
    const nameRegex = /^[a-zA-Z0-9._-]+$/;
    if (!nameRegex.test(name)) {
      return res.status(400).json({
        error: 'Invalid repository name. Use only letters, numbers, hyphens, underscores, and periods.',
      });
    }

    // Get project and verify ownership
    const project = await queries.getProjectById(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    if (project.user_id !== userId) {
      return res.status(403).json({ error: 'You do not have permission to access this project' });
    }

    // Check if project already has GitHub integration
    if (project.github_repo_full_name) {
      return res.status(400).json({
        error: 'Project already has a GitHub repository',
        repo: project.github_repo_full_name,
      });
    }

    // Get user's GitHub installation
    const installation = await githubService.getInstallation(userId);

    if (!installation) {
      return res.status(404).json({
        error: 'GitHub installation not found',
        message: 'Please connect your GitHub account first',
      });
    }

    // Step 1: Create GitHub repository with auto-suffix retry on name conflicts
    let repo;
    let repoName = name;
    let attempts = 0;
    const maxAttempts = 3;

    while (attempts < maxAttempts) {
      try {
        console.log(`[GitHub] Creating GitHub repository (attempt ${attempts + 1}/${maxAttempts}): ${org ? `${org}/` : ''}${repoName}`);
        repo = await githubService.createRepository(installation.installation_id, {
          name: repoName,
          description,
          private: isPrivate,
          org,
        });

        console.log(`[GitHub] Repository created: ${repo.full_name}`);
        break; // Success - exit retry loop
      } catch (repoError) {
        if (repoError.message.includes('already exists') && attempts < maxAttempts - 1) {
          // Generate unique suffix (8 random hex characters)
          const suffix = Math.random().toString(16).substring(2, 10);
          repoName = `${name}-${suffix}`;
          console.log(`[GitHub] Repository name exists, retrying with suffix: ${repoName}`);
          attempts++;
        } else {
          // Either not a name conflict or max retries reached - throw error
          throw repoError;
        }
      }
    }

    // Step 2: Get decrypted access token for git operations
    const token = await githubService.getDecryptedToken(installation.installation_id);

    // Step 3: Initialize git locally and push to GitHub
    const projectPath = project.path; // Use the actual project path from the database
    console.log(`[GitHub] Using project path: ${projectPath}`);
    console.log(`[GitHub] Initializing git and pushing to ${repo.clone_url}...`);

    const pushResult = await gitService.initAndPushToRemote(
      projectPath,
      repo.clone_url,
      token,
      repo.default_branch,
      `Initial commit from AtlasEngine

Created via AtlasEngine MVP
Project: ${project.name}`
    );

    console.log(`[GitHub] Successfully pushed to GitHub (commit: ${pushResult.commit})`);

    // Step 4: Create webhook for bidirectional sync (web mode only)
    if (!isDesktopMode && installation.installation_id > 0) {
      console.log(`[GitHub] Creating webhook for bidirectional sync...`);
      const webhookUrl = `${process.env.WEBHOOK_BASE_URL || 'https://atlasengine.dev'}/api/github/webhook`;

      try {
        const webhook = await githubService.createWebhook(
          installation.installation_id,
          repo.owner,
          repo.name,
          webhookUrl
        );

        if (webhook) {
          console.log(`[GitHub] Webhook created successfully`);
        } else {
          console.log(`[GitHub] Webhook already exists (skipped)`);
        }
      } catch (webhookError) {
        // Webhook creation is not critical - log and continue
        console.warn(`[GitHub] Failed to create webhook (non-critical):`, webhookError.message);
      }
    }

    // Step 5: Update project with GitHub metadata
    console.log(`[GitHub] Updating project with GitHub metadata...`);
    const [owner, actualRepoName] = repo.full_name.split('/');
    await queries.updateProject(projectId, {
      github_repo_id: repo.id,
      github_repo_full_name: repo.full_name,
      github_repo_owner: owner,
      github_repo_name: actualRepoName,
      github_clone_url: repo.clone_url,
      github_installation_id: installation.installation_id,
      github_sync_enabled: true,
      github_sync_status: 'synced',
      github_default_branch: repo.default_branch,
    });

    console.log(`[GitHub] Project updated with GitHub integration`);

    // Step 6: Log event
    await queries.logEvent({
      userId,
      projectId,
      kind: 'github.repo.created',
      status: 'completed',
      message: `GitHub repository ${repo.full_name} created and synced`,
      meta: {
        repo_full_name: repo.full_name,
        repo_url: repo.html_url,
        private: repo.private,
        default_branch: repo.default_branch,
        commit: pushResult.commit,
      },
    });

    // Return success response
    res.json({
      success: true,
      message: 'GitHub repository created and synced successfully',
      repository: {
        id: repo.id,
        name: repo.name,
        full_name: repo.full_name,
        owner: repo.owner,
        private: repo.private,
        html_url: repo.html_url,
        clone_url: repo.clone_url,
        default_branch: repo.default_branch,
        created_at: repo.created_at,
      },
      sync: {
        enabled: true,
        status: 'active',
        initial_commit: pushResult.commit,
        branch: pushResult.branch,
      },
    });
  } catch (error) {
    console.error('Error creating GitHub repository:', error);

    if (error.message.includes('already exists')) {
      return res.status(409).json({
        error: 'Repository name already exists',
        message: 'Unable to create repository - name conflicts persist after multiple retry attempts with different suffixes.',
      });
    }

    if (error.message.includes('authentication') || error.message.includes('installation')) {
      return res.status(401).json({
        error: 'GitHub authentication failed',
        message: 'Please reconnect your GitHub account',
      });
    }

    res.status(500).json({
      error: 'Failed to create GitHub repository',
      message: error.message,
    });
  }
});

/**
 * GET /api/github/health
 * Health check for GitHub service
 */
router.get('/health', async (req, res) => {
  try {
    const health = await githubService.healthCheck();

    if (health.healthy) {
      res.json({
        success: true,
        service: 'github',
        status: 'healthy',
        appName: health.appName,
        appId: health.appId,
        owner: health.owner,
      });
    } else {
      res.status(503).json({
        success: false,
        service: 'github',
        status: 'unhealthy',
        error: health.error,
      });
    }
  } catch (error) {
    res.status(503).json({
      success: false,
      service: 'github',
      status: 'unhealthy',
      error: error.message,
    });
  }
});

/**
 * Helper: Verify GitHub webhook signature
 * Uses HMAC SHA-256 to validate webhook came from GitHub
 *
 * @param {Buffer} payload - Raw request body
 * @param {string} signature - X-Hub-Signature-256 header value
 * @returns {boolean} True if signature is valid
 */
function verifyWebhookSignature(payload, signature) {
  if (!signature) {
    return false;
  }

  const webhookSecret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('⚠️ GITHUB_WEBHOOK_SECRET not configured');
    return false;
  }

  // GitHub sends signature as "sha256=<signature>"
  const expectedSignature = `sha256=${crypto
    .createHmac('sha256', webhookSecret)
    .update(payload)
    .digest('hex')}`;

  // Use timing-safe comparison to prevent timing attacks
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature)
    );
  } catch (error) {
    return false;
  }
}

function normalizeCommitSha(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

async function findReusablePullSyncJob(projectId, commitSha = null) {
  const normalizedCommitSha = normalizeCommitSha(commitSha);
  const params = [projectId];
  let commitWhereClause = `AND commit_sha IS NULL`;
  if (normalizedCommitSha) {
    params.push(normalizedCommitSha);
    commitWhereClause = `AND commit_sha = $2`;
  }

  const result = await db.query(
    `SELECT id, project_id, sync_type, status, commit_sha, commit_message, files_changed, error_message, retry_count, created_at, started_at, completed_at
     FROM github_sync_queue
     WHERE project_id = $1
       AND sync_type = 'pull'
       AND status IN ('pending', 'processing')
       ${commitWhereClause}
     ORDER BY created_at DESC
     LIMIT 1`,
    params
  );

  return result.rows[0] || null;
}

async function queuePullSyncJob(projectId, commitSha, commitMessage) {
  const normalizedCommitSha = normalizeCommitSha(commitSha);
  const existingJob = await findReusablePullSyncJob(projectId, normalizedCommitSha);
  if (existingJob) {
    return {
      job: existingJob,
      reusedExistingJob: true,
    };
  }

  const queueResult = await db.query(
    `INSERT INTO github_sync_queue (project_id, sync_type, commit_sha, commit_message, status)
     VALUES ($1, 'pull', $2, $3, 'pending')
     RETURNING id, project_id, sync_type, status, commit_sha, commit_message, files_changed, error_message, retry_count, created_at, started_at, completed_at`,
    [projectId, normalizedCommitSha, commitMessage]
  );

  return {
    job: queueResult.rows[0],
    reusedExistingJob: false,
  };
}

/**
 * POST /api/github/webhook
 * GitHub webhook endpoint for receiving push events
 * Triggers pull sync when changes are pushed to GitHub
 *
 * Phase 3: Webhook Handler (GitHub → AtlasEngine)
 *
 * Security: Verifies webhook signature using HMAC SHA-256
 * Events: Handles 'ping' and 'push' events
 * Sync: Only syncs default branch (main/master)
 */
router.post('/webhook', async (req, res) => {
  try {
    // Verify webhook signature using raw body (stored by express.json verify callback)
    const signature = req.headers['x-hub-signature-256'];
    const rawBody = req.rawBody;

    if (!rawBody) {
      console.error('❌ Missing raw body for webhook signature verification');
      return res.status(400).json({ error: 'Missing raw body' });
    }

    if (!verifyWebhookSignature(rawBody, signature)) {
      console.error('❌ Invalid webhook signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // Body is already parsed by express.json()
    const payload = req.body;
    const event = req.headers['x-github-event'];

    console.log(`📥 GitHub webhook received: ${event}`);

    // Handle ping event (sent when webhook is first created)
    if (event === 'ping') {
      console.log('🏓 Webhook ping received');
      return res.json({ message: 'pong' });
    }

    // Handle push event
    if (event === 'push') {
      const { repository, ref, after, pusher } = payload;

      if (!repository || !ref) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      const repoFullName = repository.full_name; // "owner/repo"
      const [owner, repo] = repoFullName.split('/');
      const branch = ref.replace('refs/heads/', '');
      const commitSha = after;

      console.log(`🔔 Push event: ${repoFullName}@${branch} (${commitSha.substring(0, 7)})`);

      // Find project by repository
      const projectResult = await db.query(
        `SELECT id, github_repo_owner, github_repo_name, github_default_branch, github_sync_enabled
         FROM projects
         WHERE github_repo_owner = $1
           AND github_repo_name = $2
           AND github_sync_enabled = true`,
        [owner, repo]
      );

      if (projectResult.rows.length === 0) {
        console.log(`ℹ️ No enabled projects found for ${repoFullName}`);
        return res.status(200).json({ message: 'No projects configured for this repository' });
      }

      const project = projectResult.rows[0];

      // Only sync default branch (ignore feature branches)
      if (branch !== project.github_default_branch) {
        console.log(`ℹ️ Ignoring push to non-default branch: ${branch} (default: ${project.github_default_branch})`);
        return res.status(200).json({ message: `Ignoring non-default branch: ${branch}` });
      }

      const pullQueue = await queuePullSyncJob(
        project.id,
        commitSha,
        `Pull from GitHub: ${pusher?.name || 'unknown'} pushed ${commitSha.substring(0, 7)}`
      );

      const jobId = pullQueue.job.id;
      const queueAction = pullQueue.reusedExistingJob ? 'Reused' : 'Queued';
      const lifecycle = buildLifecycleSnapshot(pullQueue.job, {
        projectId: project.id,
        syncType: 'pull',
        state: 'queued',
        commitSha,
        reusedExistingJob: pullQueue.reusedExistingJob,
      });
      emitSyncLifecycleEvent(
        req,
        project.id,
        'sync-queued',
        lifecycle,
        {
          message: pullQueue.reusedExistingJob ? 'Pull sync already queued' : 'Pull sync queued',
          reusedExistingJob: pullQueue.reusedExistingJob,
        }
      );
      console.log(`✅ ${queueAction} pull sync job ${jobId} for project ${project.id} (${repoFullName}@${branch})`);

      return res.status(202).json({
        success: true,
        message: pullQueue.reusedExistingJob ? 'Pull sync already queued' : 'Pull sync queued',
        jobId,
        reusedExistingJob: pullQueue.reusedExistingJob,
        lifecycle,
        job: serializeQueueJob(pullQueue.job, {
          state: lifecycle.state,
          commitSha,
          reusedExistingJob: pullQueue.reusedExistingJob,
        }),
        projectId: project.id,
        repository: repoFullName,
        branch,
        commitSha,
      });
    }

    // Unsupported event type
    console.log(`ℹ️ Unsupported webhook event: ${event}`);
    return res.status(200).json({ message: `Event type ${event} not supported` });

  } catch (error) {
    console.error('❌ Webhook processing error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/github/projects/:id/sync/status
 * Get current sync status for a project
 */
router.get('/projects/:id/sync/status', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id || '00000000-0000-0000-0000-000000000000';

    // Get project with sync status
    const projectResult = await db.query(
      `SELECT
        id,
        name,
        github_sync_enabled,
        github_repo_owner,
        github_repo_name,
        github_default_branch,
        github_last_sync_sha,
        github_last_sync_at,
        github_sync_status,
        github_webhook_id
       FROM projects
       WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (projectResult.rows.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const project = projectResult.rows[0];

    if (!project.github_sync_enabled) {
      return res.json({
        success: true,
        syncEnabled: false,
        status: 'disabled',
        lifecycle: {
          current: null,
          lastOutcome: null,
          pending: {
            total: 0,
            queued: 0,
            processing: 0,
            retrying: 0,
          },
          maxRetries: SYNC_MAX_RETRIES,
        },
      });
    }

    // Get current sync job if any (processing wins over pending retry/queued entries)
    const jobResult = await db.query(
      `SELECT id, project_id, sync_type, status, commit_sha, files_changed, error_message, retry_count, created_at, started_at, completed_at
       FROM github_sync_queue
       WHERE project_id = $1 AND status IN ('pending', 'processing')
       ORDER BY
         CASE WHEN status = 'processing' THEN 0 ELSE 1 END,
         created_at DESC
       LIMIT 1`,
      [id]
    );
    const currentJob = jobResult.rows[0] || null;

    const pendingSummaryResult = await db.query(
      `SELECT
         COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_count,
         COALESCE(SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END), 0) AS processing_count,
         COALESCE(SUM(CASE WHEN status = 'pending' AND retry_count > 0 THEN 1 ELSE 0 END), 0) AS retrying_count
       FROM github_sync_queue
       WHERE project_id = $1
         AND status IN ('pending', 'processing')`,
      [id]
    );
    const pendingSummary = pendingSummaryResult.rows[0] || {};

    const lastOutcomeResult = await db.query(
      `SELECT id, project_id, sync_type, status, commit_sha, files_changed, error_message, retry_count, created_at, started_at, completed_at
       FROM github_sync_queue
       WHERE project_id = $1
         AND status IN ('completed', 'failed')
       ORDER BY COALESCE(completed_at, created_at) DESC
       LIMIT 1`,
      [id]
    );
    const lastOutcome = lastOutcomeResult.rows[0] || null;

    const currentLifecycle = currentJob ? buildLifecycleSnapshot(currentJob) : null;
    const lastOutcomeLifecycle = lastOutcome ? buildLifecycleSnapshot(lastOutcome) : null;
    const pending = {
      total: Number(pendingSummary.pending_count || 0) + Number(pendingSummary.processing_count || 0),
      queued: Number(pendingSummary.pending_count || 0),
      processing: Number(pendingSummary.processing_count || 0),
      retrying: Number(pendingSummary.retrying_count || 0),
    };

    res.json({
      success: true,
      syncEnabled: true,
      status: project.github_sync_status,
      repository: `${project.github_repo_owner}/${project.github_repo_name}`,
      branch: project.github_default_branch,
      lastSyncSha: project.github_last_sync_sha,
      lastSyncAt: project.github_last_sync_at,
      webhookConfigured: !!project.github_webhook_id,
      currentJob: serializeQueueJob(currentJob),
      lifecycle: {
        current: currentLifecycle,
        lastOutcome: lastOutcomeLifecycle,
        pending,
        maxRetries: SYNC_MAX_RETRIES,
      },
    });
  } catch (error) {
    console.error('❌ Error getting sync status:', error);
    res.status(500).json({ error: 'Failed to get sync status' });
  }
});

/**
 * GET /api/github/projects/:id/sync/history
 * Get recent sync operations for a project
 */
router.get('/projects/:id/sync/history', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id || '00000000-0000-0000-0000-000000000000';
    const { limit = 20 } = req.query;
    const parsedLimit = Math.min(100, Math.max(1, Number.parseInt(String(limit), 10) || 20));

    // Verify project ownership
    const projectResult = await db.query(
      `SELECT id FROM projects WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (projectResult.rows.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    // Get sync history
    const historyResult = await db.query(
      `SELECT
        id,
        project_id,
        sync_type,
        status,
        commit_sha,
        commit_message,
        files_changed,
        error_message,
        retry_count,
        created_at,
        started_at,
        completed_at
       FROM github_sync_queue
       WHERE project_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [id, parsedLimit]
    );

    const history = historyResult.rows.map((job) => {
      const lifecycle = buildLifecycleSnapshot(job);
      const startedAtIso = toIsoOrNull(job.started_at);
      const completedAtIso = toIsoOrNull(job.completed_at);
      const duration = startedAtIso && completedAtIso
        ? new Date(completedAtIso).getTime() - new Date(startedAtIso).getTime()
        : null;

      return {
        id: job.id,
        type: job.sync_type,
        status: job.status,
        lifecycleState: lifecycle.state,
        commitSha: lifecycle.commitSha,
        commitMessage: job.commit_message,
        filesChanged: lifecycle.filesChanged,
        errorMessage: job.error_message,
        retryCount: lifecycle.retry.count,
        retry: lifecycle.retry,
        reason: lifecycle.reason,
        createdAt: toIsoOrNull(job.created_at),
        startedAt: startedAtIso,
        completedAt: completedAtIso,
        duration,
        lifecycle,
      };
    });

    res.json({
      success: true,
      history,
      total: history.length,
    });
  } catch (error) {
    console.error('❌ Error getting sync history:', error);
    res.status(500).json({ error: 'Failed to get sync history' });
  }
});

/**
 * POST /api/github/projects/:id/sync
 * Manually trigger a sync operation
 */
router.post('/projects/:id/sync', async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user?.id || '00000000-0000-0000-0000-000000000000';
    const { type = 'push', message, commitSha } = req.body;

    // Validate sync type
    if (!['push', 'pull'].includes(type)) {
      return res.status(400).json({ error: 'Invalid sync type. Must be "push" or "pull"' });
    }

    // Get project
    const projectResult = await db.query(
      `SELECT
        id,
        name,
        github_sync_enabled,
        github_repo_owner,
        github_repo_name,
        github_default_branch
       FROM projects
       WHERE id = $1 AND user_id = $2`,
      [id, userId]
    );

    if (projectResult.rows.length === 0) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const project = projectResult.rows[0];

    if (!project.github_sync_enabled) {
      return res.status(400).json({ error: 'GitHub sync is not enabled for this project' });
    }

    if (!project.github_repo_owner || !project.github_repo_name) {
      return res.status(400).json({ error: 'GitHub repository is not configured for this project' });
    }

    const requestedPullCommitSha = type === 'pull' ? normalizeCommitSha(commitSha) : null;
    if (type === 'pull') {
      const existingPullJob = await findReusablePullSyncJob(id, requestedPullCommitSha);
      if (existingPullJob) {
        const lifecycle = buildLifecycleSnapshot(existingPullJob, {
          projectId: id,
          syncType: 'pull',
          state: existingPullJob.status === 'processing' ? 'processing' : 'queued',
          commitSha: requestedPullCommitSha || existingPullJob.commit_sha || null,
          reusedExistingJob: true,
        });
        emitSyncLifecycleEvent(
          req,
          id,
          'sync-queued',
          lifecycle,
          {
            message: 'pull sync already queued',
            reusedExistingJob: true,
          }
        );

        return res.status(202).json({
          success: true,
          message: 'pull sync already queued',
          reusedExistingJob: true,
          lifecycle,
          job: serializeQueueJob(existingPullJob, {
            state: lifecycle.state,
            commitSha: lifecycle.commitSha,
            reusedExistingJob: true,
          }),
          repository: `${project.github_repo_owner}/${project.github_repo_name}`,
          branch: project.github_default_branch,
          commitSha: requestedPullCommitSha,
        });
      }
    }

    // Check if there's already a pending/processing job
    const existingJobResult = await db.query(
      `SELECT id FROM github_sync_queue
       WHERE project_id = $1 AND status IN ('pending', 'processing')
       LIMIT 1`,
      [id]
    );

    if (existingJobResult.rows.length > 0) {
      return res.status(409).json({
        error: 'A sync operation is already in progress',
        jobId: existingJobResult.rows[0].id,
      });
    }

    // Queue sync job
    const commitMessage = message || (type === 'push'
      ? `Manual push from AtlasEngine`
      : `Manual pull from GitHub`
    );

    const jobResult = await db.query(
      `INSERT INTO github_sync_queue (project_id, sync_type, commit_sha, commit_message, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id, project_id, sync_type, status, commit_sha, commit_message, files_changed, error_message, retry_count, created_at, started_at, completed_at`,
      [id, type, requestedPullCommitSha, commitMessage]
    );

    const job = jobResult.rows[0];
    const lifecycle = buildLifecycleSnapshot(job, {
      projectId: id,
      syncType: type,
      state: 'queued',
      commitSha: requestedPullCommitSha || job.commit_sha || null,
      reusedExistingJob: false,
    });

    emitSyncLifecycleEvent(
      req,
      id,
      'sync-queued',
      lifecycle,
      {
        message: `${type} sync queued successfully`,
        reusedExistingJob: false,
      }
    );

    console.log(`✅ Manually queued ${type} sync job ${job.id} for project ${id}`);

    res.status(202).json({
      success: true,
      message: `${type} sync queued successfully`,
      reusedExistingJob: false,
      lifecycle,
      job: serializeQueueJob(job, {
        state: lifecycle.state,
        commitSha: lifecycle.commitSha,
      }),
      repository: `${project.github_repo_owner}/${project.github_repo_name}`,
      branch: project.github_default_branch,
      commitSha: requestedPullCommitSha,
    });
  } catch (error) {
    console.error('❌ Error triggering manual sync:', error);
    res.status(500).json({ error: 'Failed to trigger sync' });
  }
});

/**
 * Clear in-memory device flow caches (for sign-out reset).
 */
export function clearGitHubCache() {
  deviceFlows.clear();
}

/**
 * Named exports for device-flow callers outside this module (guest sign-in).
 */
export { requestDeviceCode, exchangeDeviceCode };

export const __testing = {
  requestDeviceCode: (...args) => requestDeviceCode(...args),
  exchangeDeviceCode: (...args) => exchangeDeviceCode(...args),
  resetDeviceFlows() {
    for (const flow of deviceFlows.values()) {
      if (flow?.timer) clearTimeout(flow.timer);
    }
    deviceFlows.clear();
  },
};

export default router;
