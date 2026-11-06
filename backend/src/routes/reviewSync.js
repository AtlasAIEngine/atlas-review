import express from 'express';
import reviewSyncService from '../services/reviewSyncService.js';
import identityLinkService from '../services/identityLinkService.js';
import githubAccountConnectionService from '../services/githubAccountConnectionService.js';
import { requestDeviceCode, exchangeDeviceCode } from './github.js';
import { query, getDbType } from '../db/connection.js';

const router = express.Router();
const guestSessionRateLimits = new Map();

/**
 * Per-user device-flow store for the review-sync sign-in flow.
 * Keyed by the guest session's userId so concurrent users don't clobber
 * each other. Entries expire after GitHub's stated `expires_in` (default
 * 900s) so stale codes don't accumulate.
 */
const guestDeviceFlows = new Map();
const GUEST_DEVICE_FLOW_DEFAULT_TTL_MS = 15 * 60 * 1000;

function pruneExpiredDeviceFlows(now = Date.now()) {
  for (const [key, record] of guestDeviceFlows.entries()) {
    if (!record || now > record.expiresAt) {
      guestDeviceFlows.delete(key);
    }
  }
}
const GUEST_SESSION_RATE_LIMIT_WINDOW_MS = Math.max(
  1000,
  Number.parseInt(process.env.ATLAS_REVIEW_SYNC_GUEST_SESSION_WINDOW_MS || '60000', 10) || 60000
);
const GUEST_SESSION_RATE_LIMIT_MAX = Math.max(
  1,
  Number.parseInt(process.env.ATLAS_REVIEW_SYNC_GUEST_SESSION_MAX || '10', 10) || 10
);

function normalizeText(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getGuestSessionRateLimitKey(req) {
  return normalizeText(req.ip) || normalizeText(req.socket?.remoteAddress) || 'unknown';
}

function pruneExpiredGuestSessionRateLimits(now = Date.now()) {
  for (const [key, record] of guestSessionRateLimits.entries()) {
    if (!record || now > record.resetAt) {
      guestSessionRateLimits.delete(key);
    }
  }
}

function checkGuestSessionRateLimit(req) {
  const now = Date.now();
  pruneExpiredGuestSessionRateLimits(now);
  const key = getGuestSessionRateLimitKey(req);
  const existing = guestSessionRateLimits.get(key);
  const record = existing && now <= existing.resetAt
    ? existing
    : { count: 0, resetAt: now + GUEST_SESSION_RATE_LIMIT_WINDOW_MS };

  record.count += 1;
  guestSessionRateLimits.set(key, record);

  return {
    allowed: record.count <= GUEST_SESSION_RATE_LIMIT_MAX,
    retryAfterSeconds: Math.max(1, Math.ceil((record.resetAt - now) / 1000)),
  };
}

function requireDesktopMode(req, res, next) {
  if (process.env.ATLAS_DESKTOP_MODE !== 'true') {
    return res.status(404).json({ error: 'Desktop review sync endpoints are unavailable in server mode.' });
  }
  return next();
}

async function requireGuestSession(req, res, next) {
  try {
    const authHeader = normalizeText(req.get('authorization'));
    const authToken = authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : '';
    if (!authToken) {
      return res.status(401).json({ error: 'Review sync auth token is required.' });
    }

    const session = await reviewSyncService.getGuestSessionByAuthToken(authToken);
    if (!session) {
      return res.status(401).json({ error: 'Invalid review sync auth token.' });
    }

    req.reviewSyncSession = session;
    return next();
  } catch (error) {
    return res.status(500).json({ error: 'Failed to authorize review sync session.' });
  }
}

router.post('/guest-session', async (req, res) => {
  try {
    const rateLimit = checkGuestSessionRateLimit(req);
    if (!rateLimit.allowed) {
      res.set?.('Retry-After', String(rateLimit.retryAfterSeconds));
      return res.status(429).json({
        error: 'Too many review sync guest session requests. Please retry later.',
      });
    }

    const issued = await reviewSyncService.issueGuestSession({
      deviceLabel: normalizeText(req.body?.deviceLabel),
      clientSource: typeof req.body?.clientSource === 'string' ? req.body.clientSource : null,
    });
    return res.json({
      success: true,
      session: {
        userId: issued.userId,
        deviceId: issued.deviceId,
        deviceLabel: issued.deviceLabel,
        authToken: issued.authToken,
      },
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to create review sync guest session.' });
  }
});

/**
 * POST /api/review-sync/ensure-user
 * Lightweight registration endpoint called on every app startup.
 * Creates a users row if one doesn't exist for this sync session's userId.
 * Idempotent — safe to call repeatedly.
 */
router.post('/ensure-user', requireGuestSession, async (req, res) => {
  try {
    const session = req.reviewSyncSession;
    const userId = session.userId;
    const deviceLabel = req.body?.deviceLabel || session.deviceLabel;
    const deviceId = req.body?.deviceId || session.deviceId;

    if (!userId) {
      return res.status(400).json({ error: 'No userId in session' });
    }

    const nowExpr = getDbType() === 'sqlite' ? "datetime('now')" : 'NOW()';
    const guestEmail = `guest-${userId.slice(0, 8)}@device.atlasengine.local`;
    const guestName = deviceLabel || `Device ${(deviceId || userId).slice(0, 8)}`;

    if (getDbType() === 'postgres') {
      await query(
        `INSERT INTO users (id, email, name, plan, is_active)
         VALUES ($1::uuid, $2, $3, 'free', TRUE)
         ON CONFLICT (id) DO UPDATE SET
           name = COALESCE(NULLIF($3, ''), users.name),
           updated_at = NOW()`,
        [userId, guestEmail, guestName]
      );
    } else {
      await query(
        `INSERT INTO users (id, email, name, plan, is_active)
         VALUES ($1, $2, $3, 'free', 1)
         ON CONFLICT (id) DO UPDATE SET
           name = COALESCE(NULLIF($3, ''), users.name),
           updated_at = datetime('now')`,
        [userId, guestEmail, guestName]
      );
    }

    return res.json({ success: true, registered: true });
  } catch (error) {
    console.error('[ReviewSync] ensure-user error:', error.message);
    return res.status(500).json({ success: false, registered: false, error: 'Failed to ensure user' });
  }
});

router.post('/events/batch', requireGuestSession, async (req, res) => {
  try {
    const session = req.reviewSyncSession;
    const events = Array.isArray(req.body?.events) ? req.body.events : [];
    const deviceLabel = normalizeText(req.body?.deviceLabel);

    if (deviceLabel) {
      await reviewSyncService.touchGuestSession(session.id, { deviceLabel });
    } else {
      await reviewSyncService.touchGuestSession(session.id);
    }

    const written = await reviewSyncService.ingestEvents({
      userId: session.userId,
      deviceId: session.deviceId,
      events,
    });
    return res.json({
      success: true,
      ingested: written.length,
      events: written,
    });
  } catch (error) {
    return res.status(400).json({ error: error?.message || 'Failed to ingest review sync events.' });
  }
});

router.get('/stats', requireGuestSession, async (req, res) => {
  try {
    const stats = await reviewSyncService.getStats(req.reviewSyncSession.userId);
    return res.json({ success: true, stats });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to load review sync stats.' });
  }
});

router.get('/history', requireGuestSession, async (req, res) => {
  try {
    const limit = req.query?.limit;
    const history = await reviewSyncService.listHistory(req.reviewSyncSession.userId, { limit });
    return res.json({ success: true, history });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to load review sync history.' });
  }
});

router.get('/local-status', requireDesktopMode, async (_req, res) => {
  try {
    const status = await reviewSyncService.getLocalSyncStatus();
    return res.json({ success: true, status });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to load desktop review sync status.' });
  }
});

router.post('/local-sync', requireDesktopMode, async (_req, res) => {
  try {
    const result = await reviewSyncService.flushPendingEvents();
    return res.json({ success: true, result });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to flush desktop review sync events.' });
  }
});

router.get('/me', requireGuestSession, async (req, res) => {
  try {
    const session = req.reviewSyncSession;
    const user = await reviewSyncService.getMe(session.userId);
    if (!user) {
      return res.status(404).json({ error: 'Review sync user not found.' });
    }
    return res.json({ success: true, user });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to load review sync user.' });
  }
});

router.post('/github/start', requireGuestSession, async (req, res) => {
  try {
    const session = req.reviewSyncSession;
    pruneExpiredDeviceFlows();

    const payload = await requestDeviceCode();
    const ttlMs = Math.max(60 * 1000, (Number(payload.expires_in) || 900) * 1000);
    const record = {
      deviceCode: payload.device_code,
      userCode: payload.user_code,
      verificationUri: payload.verification_uri,
      verificationUriComplete: payload.verification_uri_complete || null,
      interval: Math.max(5, Number(payload.interval) || 5),
      expiresAt: Date.now() + Math.min(ttlMs, GUEST_DEVICE_FLOW_DEFAULT_TTL_MS),
    };
    guestDeviceFlows.set(session.userId, record);

    return res.json({
      success: true,
      deviceFlow: {
        userCode: record.userCode,
        verificationUri: record.verificationUri,
        expiresIn: Math.floor((record.expiresAt - Date.now()) / 1000),
        interval: record.interval,
      },
    });
  } catch (error) {
    return res.status(502).json({ error: error?.message || 'Failed to start GitHub device flow.' });
  }
});

router.post('/github/poll', requireGuestSession, async (req, res) => {
  try {
    const session = req.reviewSyncSession;
    pruneExpiredDeviceFlows();
    const flow = guestDeviceFlows.get(session.userId);
    if (!flow) {
      return res.json({ success: true, status: 'expired' });
    }
    if (Date.now() > flow.expiresAt) {
      guestDeviceFlows.delete(session.userId);
      return res.json({ success: true, status: 'expired' });
    }

    // Rate-limit GitHub exchanges to `flow.interval` seconds so the UI can
    // poll at whatever cadence feels responsive without us forwarding every
    // tick to GitHub. Between real exchanges we echo the last known state
    // (defaulting to `authorization_pending`) so the frontend keeps waiting
    // quietly instead of triggering its own `slow_down` backoff cascade.
    const now = Date.now();
    const minIntervalMs = Math.max(1, Number(flow.interval) || 5) * 1000;
    const readyForExchange = !flow.lastExchangeAt
      || (now - flow.lastExchangeAt) >= minIntervalMs;
    if (!readyForExchange) {
      return res.json({ success: true, status: 'authorization_pending' });
    }
    flow.lastExchangeAt = now;
    guestDeviceFlows.set(session.userId, flow);

    const payload = await exchangeDeviceCode(flow.deviceCode);

    if (payload?.error) {
      const code = String(payload.error);
      if (code === 'authorization_pending') {
        return res.json({ success: true, status: 'authorization_pending' });
      }
      if (code === 'slow_down') {
        // GitHub wants us to back off. Bump our internal exchange cadence
        // but keep the frontend in its quiet `authorization_pending` state
        // so its own `intervalMs` doesn't also double on top of ours.
        flow.interval = Math.min(60, flow.interval * 2);
        guestDeviceFlows.set(session.userId, flow);
        return res.json({ success: true, status: 'authorization_pending' });
      }
      if (code === 'expired_token' || code === 'access_denied') {
        guestDeviceFlows.delete(session.userId);
        return res.json({ success: true, status: 'expired' });
      }
      return res.status(400).json({ error: payload.error_description || payload.error });
    }

    const accessToken = payload?.access_token;
    if (!accessToken) {
      return res.json({ success: true, status: 'authorization_pending' });
    }

    // Exchange succeeded; clear the flow and link the identity.
    guestDeviceFlows.delete(session.userId);

    const linkResult = await githubAccountConnectionService.connectGitHubAccount({
      userId: session.userId,
      accessToken,
      tokenMeta: {
        refreshToken: payload.refresh_token,
        expiresIn: payload.expires_in,
        refreshTokenExpiresIn: payload.refresh_token_expires_in,
      },
      source: 'review_sync_device',
    });

    let authToken = null;
    if (linkResult.merged) {
      const reissued = await reviewSyncService.reissueAuthTokenForUser(linkResult.userId, {
        sessionId: session.id,
      });
      authToken = reissued?.authToken || null;
    }

    // Mirror the link into the remote (Railway) DB when running in desktop
    // mode so the admin dashboard sees the signed-in identity. Fire-and-forget
    // — offline / network errors are logged but don't fail the sign-in.
    reviewSyncService.propagateIdentityToRemote({ profile: linkResult.profile })
      .catch(() => {});

    const user = await reviewSyncService.getMe(linkResult.userId);

    return res.json({
      success: true,
      status: 'linked',
      user,
      authToken,
      merged: Boolean(linkResult.merged),
    });
  } catch (error) {
    return res.status(502).json({ error: error?.message || 'Failed to poll GitHub device flow.' });
  }
});

router.post('/github/unlink', requireGuestSession, async (req, res) => {
  try {
    const session = req.reviewSyncSession;
    await identityLinkService.unlinkGithub(session.userId);
    // Mirror the unlink to the remote DB when in desktop mode (fire-and-forget).
    reviewSyncService.propagateIdentityToRemote({ unlink: true }).catch(() => {});
    const user = await reviewSyncService.getMe(session.userId);
    return res.json({ success: true, user });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to unlink GitHub identity.' });
  }
});

/**
 * Identity propagation endpoint used by the desktop app's local backend to
 * mirror a successful local link/unlink into the remote (Railway) DB without
 * re-running the GitHub OAuth flow. The client has already fetched the
 * profile against GitHub and persisted it locally; we accept the prefetched
 * fields here and reuse the same merge-on-conflict service.
 */
router.post('/identity', requireGuestSession, async (req, res) => {
  try {
    const session = req.reviewSyncSession;
    const body = req.body || {};

    if (body.unlink === true) {
      await identityLinkService.unlinkGithub(session.userId);
      const user = await reviewSyncService.getMe(session.userId);
      return res.json({ success: true, unlinked: true, user });
    }

    const githubUserId = Number(body.githubUserId);
    if (!Number.isFinite(githubUserId) || githubUserId <= 0) {
      return res.status(400).json({ error: 'githubUserId is required and must be a positive number.' });
    }

    const profile = {
      id: githubUserId,
      login: typeof body.githubLogin === 'string' ? body.githubLogin : null,
      avatarUrl: typeof body.githubAvatarUrl === 'string' ? body.githubAvatarUrl : null,
      email: typeof body.email === 'string' ? body.email : null,
      name: typeof body.name === 'string' ? body.name : null,
    };

    const linkResult = await identityLinkService.linkGuestToGithubProfile({
      currentUserId: session.userId,
      profile,
    });

    // If this device's row was merged into an existing linked user, reissue
    // the session so subsequent requests authenticate against the new userId.
    let authToken = null;
    if (linkResult.merged) {
      const reissued = await reviewSyncService.reissueAuthTokenForUser(linkResult.userId, {
        sessionId: session.id,
      });
      authToken = reissued?.authToken || null;
    }

    const user = await reviewSyncService.getMe(linkResult.userId);
    return res.json({
      success: true,
      userId: linkResult.userId,
      merged: Boolean(linkResult.merged),
      authToken,
      user,
    });
  } catch (error) {
    return res.status(500).json({ error: error?.message || 'Failed to sync identity.' });
  }
});

export const __testing = {
  resetGuestSessionRateLimits() {
    guestSessionRateLimits.clear();
  },
  getGuestSessionRateLimitSize() {
    return guestSessionRateLimits.size;
  },
  resetDeviceFlowStore() {
    guestDeviceFlows.clear();
  },
  getDeviceFlowStoreSize() {
    return guestDeviceFlows.size;
  },
};

export default router;
