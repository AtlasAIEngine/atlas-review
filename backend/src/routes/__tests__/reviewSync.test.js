import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('express', () => ({
  default: {
    Router: () => {
      const stack = [];
      const router = {
        stack,
        get(path, ...handlers) {
          stack.push({
            route: {
              path,
              methods: { get: true },
              stack: handlers.map((handle) => ({ handle })),
            },
          });
          return router;
        },
        post(path, ...handlers) {
          stack.push({
            route: {
              path,
              methods: { post: true },
              stack: handlers.map((handle) => ({ handle })),
            },
          });
          return router;
        },
      };
      return router;
    },
  },
}));

vi.mock('../../services/reviewSyncService.js', () => ({
  default: {
    issueGuestSession: vi.fn(),
    getGuestSessionByAuthToken: vi.fn(),
    touchGuestSession: vi.fn(),
    getLocalSyncStatus: vi.fn(),
    flushPendingEvents: vi.fn(),
    ingestEvents: vi.fn(),
    listHistory: vi.fn(),
    getStats: vi.fn(),
    getMe: vi.fn(),
    reissueAuthTokenForUser: vi.fn(),
    propagateIdentityToRemote: vi.fn().mockResolvedValue({ skipped: 'test' }),
  },
}));

vi.mock('../../services/identityLinkService.js', () => ({
  default: {
    unlinkGithub: unlinkGithubMock,
  },
  unlinkGithub: unlinkGithubMock,
}));

vi.mock('../../services/githubAccountConnectionService.js', () => ({
  default: {
    connectGitHubAccount: connectGitHubAccountMock,
  },
  connectGitHubAccount: connectGitHubAccountMock,
}));

const {
  requestDeviceCodeMock,
  exchangeDeviceCodeMock,
  connectGitHubAccountMock,
  unlinkGithubMock,
} = vi.hoisted(() => ({
  requestDeviceCodeMock: vi.fn(),
  exchangeDeviceCodeMock: vi.fn(),
  connectGitHubAccountMock: vi.fn(),
  unlinkGithubMock: vi.fn(),
}));

vi.mock('../github.js', () => ({
  default: {},
  requestDeviceCode: requestDeviceCodeMock,
  exchangeDeviceCode: exchangeDeviceCodeMock,
  __testing: {
    requestDeviceCode: requestDeviceCodeMock,
    exchangeDeviceCode: exchangeDeviceCodeMock,
  },
}));

import reviewSyncService from '../../services/reviewSyncService.js';
import reviewSyncRouter, { __testing as reviewSyncRouteTesting } from '../reviewSync.js';

function createMockReqRes({ params = {}, query = {}, body = {}, user = null } = {}) {
  const req = { params, query, body, user, ip: '127.0.0.1' };
  const res = {
    json: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
  };
  return { req, res };
}

async function callRouteHandler(router, method, path, req, res) {
  const stack = router.stack;
  const pathParts = path.split('/').filter(Boolean);

  for (const layer of stack) {
    if (!layer.route) continue;
    const routePath = layer.route.path;
    const routeMethod = Object.keys(layer.route.methods)[0];
    if (routeMethod !== method) continue;

    const routeParts = routePath.split('/').filter(Boolean);
    if (routeParts.length !== pathParts.length) continue;

    let matches = true;
    const params = {};
    for (let index = 0; index < routeParts.length; index += 1) {
      const routePart = routeParts[index];
      const pathPart = pathParts[index];
      if (routePart.startsWith(':')) {
        params[routePart.slice(1)] = pathPart;
      } else if (routePart !== pathPart) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;

    req.params = { ...req.params, ...params };
    const handlers = layer.route.stack.map((item) => item.handle);
    for (const handler of handlers) {
      const shouldContinue = await new Promise((resolve, reject) => {
        let nextCalled = false;
        const next = (err) => {
          if (err) {
            reject(err);
            return;
          }
          nextCalled = true;
          resolve(true);
        };
        const result = handler(req, res, next);
        if (result instanceof Promise) {
          result.then(() => resolve(nextCalled)).catch(reject);
          return;
        }
        resolve(nextCalled);
      });
      if (!shouldContinue) {
        return;
      }
    }
    return;
  }

  throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
}

describe('review sync routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ATLAS_DESKTOP_MODE;
    delete process.env.ATLAS_REVIEW_SYNC_GUEST_SESSION_WINDOW_MS;
    delete process.env.ATLAS_REVIEW_SYNC_GUEST_SESSION_MAX;
    reviewSyncRouteTesting.resetGuestSessionRateLimits();
  });

  it('returns desktop local sync status', async () => {
    process.env.ATLAS_DESKTOP_MODE = 'true';
    reviewSyncService.getLocalSyncStatus.mockResolvedValue({ pendingEvents: 1, state: 'idle' });
    const { req, res } = createMockReqRes();

    await callRouteHandler(reviewSyncRouter, 'get', '/local-status', req, res);

    expect(reviewSyncService.getLocalSyncStatus).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      status: { pendingEvents: 1, state: 'idle' },
    });
  });

  it('flushes desktop local sync events', async () => {
    process.env.ATLAS_DESKTOP_MODE = 'true';
    reviewSyncService.flushPendingEvents.mockResolvedValue({ status: 'synced', acknowledged: 2 });
    const { req, res } = createMockReqRes();

    await callRouteHandler(reviewSyncRouter, 'post', '/local-sync', req, res);

    expect(reviewSyncService.flushPendingEvents).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ success: true, result: { status: 'synced', acknowledged: 2 } });
  });

  it('issues a guest sync session', async () => {
    reviewSyncService.issueGuestSession.mockResolvedValue({
      userId: 'guest-user-1',
      deviceId: 'device-1',
      deviceLabel: 'Avinash MacBook Pro',
      authToken: 'guest-token',
    });
    const { req, res } = createMockReqRes({
      body: { userId: 'guest-user-1', deviceLabel: 'Avinash MacBook Pro' },
    });

    await callRouteHandler(reviewSyncRouter, 'post', '/guest-session', req, res);

    expect(reviewSyncService.issueGuestSession).toHaveBeenCalledWith({
      deviceLabel: 'Avinash MacBook Pro',
      clientSource: null,
    });
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      session: {
        userId: 'guest-user-1',
        deviceId: 'device-1',
        deviceLabel: 'Avinash MacBook Pro',
        authToken: 'guest-token',
      },
    });
  });

  it('rate limits guest session creation requests per client', async () => {
    reviewSyncService.issueGuestSession.mockResolvedValue({
      userId: 'guest-user-1',
      deviceId: 'device-1',
      deviceLabel: 'Avinash MacBook Pro',
      authToken: 'guest-token',
    });

    for (let index = 0; index < 10; index += 1) {
      const { req, res } = createMockReqRes({
        body: { deviceLabel: `Client ${index}` },
      });
      req.ip = '10.0.0.9';
      await callRouteHandler(reviewSyncRouter, 'post', '/guest-session', req, res);
      expect(res.status).not.toHaveBeenCalledWith(429);
    }

    const { req, res } = createMockReqRes({
      body: { deviceLabel: 'Client 11' },
    });
    req.ip = '10.0.0.9';

    await callRouteHandler(reviewSyncRouter, 'post', '/guest-session', req, res);

    expect(reviewSyncService.issueGuestSession).toHaveBeenCalledTimes(10);
    expect(res.set).toHaveBeenCalledWith('Retry-After', expect.any(String));
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Too many review sync guest session requests. Please retry later.',
    });
  });

  it('ignores raw x-forwarded-for values when applying guest-session rate limits', async () => {
    reviewSyncService.issueGuestSession.mockResolvedValue({
      userId: 'guest-user-1',
      deviceId: 'device-1',
      deviceLabel: 'Avinash MacBook Pro',
      authToken: 'guest-token',
    });

    for (let index = 0; index < 10; index += 1) {
      const { req, res } = createMockReqRes({
        body: { deviceLabel: `Spoof ${index}` },
      });
      req.ip = '10.0.0.10';
      req.get = vi.fn((header) => (header === 'x-forwarded-for' ? `198.51.100.${index}` : ''));
      await callRouteHandler(reviewSyncRouter, 'post', '/guest-session', req, res);
      expect(res.status).not.toHaveBeenCalledWith(429);
    }

    const { req, res } = createMockReqRes({
      body: { deviceLabel: 'Spoof final' },
    });
    req.ip = '10.0.0.10';
    req.get = vi.fn((header) => (header === 'x-forwarded-for' ? '203.0.113.77' : ''));

    await callRouteHandler(reviewSyncRouter, 'post', '/guest-session', req, res);

    expect(reviewSyncService.issueGuestSession).toHaveBeenCalledTimes(10);
    expect(res.status).toHaveBeenCalledWith(429);
  });

  it('prunes expired guest-session rate-limit entries', async () => {
    reviewSyncService.issueGuestSession.mockResolvedValue({
      userId: 'guest-user-1',
      deviceId: 'device-1',
      deviceLabel: 'Avinash MacBook Pro',
      authToken: 'guest-token',
    });
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy.mockReturnValue(0);

    const { req: firstReq, res: firstRes } = createMockReqRes({
      body: { deviceLabel: 'Client A' },
    });
    firstReq.ip = '10.0.0.1';
    await callRouteHandler(reviewSyncRouter, 'post', '/guest-session', firstReq, firstRes);

    const { req: secondReq, res: secondRes } = createMockReqRes({
      body: { deviceLabel: 'Client B' },
    });
    secondReq.ip = '10.0.0.2';
    await callRouteHandler(reviewSyncRouter, 'post', '/guest-session', secondReq, secondRes);

    expect(reviewSyncRouteTesting.getGuestSessionRateLimitSize()).toBe(2);

    nowSpy.mockReturnValue(61001);
    const { req: thirdReq, res: thirdRes } = createMockReqRes({
      body: { deviceLabel: 'Client C' },
    });
    thirdReq.ip = '10.0.0.3';
    await callRouteHandler(reviewSyncRouter, 'post', '/guest-session', thirdReq, thirdRes);

    expect(reviewSyncRouteTesting.getGuestSessionRateLimitSize()).toBe(1);
  });

  it('requires a guest auth token for cloud ingest', async () => {
    const { req, res } = createMockReqRes({
      body: { events: [] },
    });
    req.get = vi.fn().mockReturnValue('');

    await callRouteHandler(reviewSyncRouter, 'post', '/events/batch', req, res);

    expect(reviewSyncService.ingestEvents).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('ingests cloud events for an authorized guest session', async () => {
    reviewSyncService.getGuestSessionByAuthToken.mockResolvedValue({
      id: 'session-1',
      userId: 'guest-user-1',
      deviceId: 'device-1',
    });
    reviewSyncService.touchGuestSession.mockResolvedValue({
      id: 'session-1',
      userId: 'guest-user-1',
      deviceId: 'device-1',
    });
    reviewSyncService.ingestEvents.mockResolvedValue([{ id: 'evt-1' }]);
    const { req, res } = createMockReqRes({
      body: {
        deviceLabel: 'Avinash MacBook Pro',
        events: [{ eventType: 'review_completed' }],
      },
    });
    req.get = vi.fn().mockReturnValue('Bearer guest-token');

    await callRouteHandler(reviewSyncRouter, 'post', '/events/batch', req, res);

    expect(reviewSyncService.getGuestSessionByAuthToken).toHaveBeenCalledWith('guest-token');
    expect(reviewSyncService.touchGuestSession).toHaveBeenCalledWith('session-1', {
      deviceLabel: 'Avinash MacBook Pro',
    });
    expect(reviewSyncService.ingestEvents).toHaveBeenCalledWith({
      userId: 'guest-user-1',
      deviceId: 'device-1',
      events: [{ eventType: 'review_completed' }],
    });
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      ingested: 1,
      events: [{ id: 'evt-1' }],
    });
  });

  it('rejects invalid guest session tokens', async () => {
    reviewSyncService.getGuestSessionByAuthToken.mockResolvedValue(null);
    const { req, res } = createMockReqRes();
    req.get = vi.fn().mockReturnValue('Bearer guest-token');

    await callRouteHandler(reviewSyncRouter, 'get', '/stats', req, res);

    expect(reviewSyncService.getStats).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns a JSON auth error when guest session lookup fails', async () => {
    reviewSyncService.getGuestSessionByAuthToken.mockRejectedValue(new Error('db unavailable'));
    const { req, res } = createMockReqRes();
    req.get = vi.fn().mockReturnValue('Bearer guest-token');

    await callRouteHandler(reviewSyncRouter, 'get', '/stats', req, res);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Failed to authorize review sync session.',
    });
  });

  it('returns stats for the authorized guest user', async () => {
    reviewSyncService.getGuestSessionByAuthToken.mockResolvedValue({
      id: 'session-1',
      userId: 'guest-user-1',
      deviceId: 'device-1',
    });
    reviewSyncService.getStats.mockResolvedValue({ reviewsCompleted: 3 });
    const { req, res } = createMockReqRes();
    req.get = vi.fn().mockReturnValue('Bearer guest-token');

    await callRouteHandler(reviewSyncRouter, 'get', '/stats', req, res);

    expect(reviewSyncService.getStats).toHaveBeenCalledWith('guest-user-1');
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      stats: { reviewsCompleted: 3 },
    });
  });

  it('returns history for the authorized guest user', async () => {
    reviewSyncService.getGuestSessionByAuthToken.mockResolvedValue({
      id: 'session-1',
      userId: 'guest-user-1',
      deviceId: 'device-1',
    });
    reviewSyncService.listHistory.mockResolvedValue([{ id: 'evt-1', eventType: 'review_completed' }]);
    const { req, res } = createMockReqRes({
      query: { limit: '10' },
    });
    req.get = vi.fn().mockReturnValue('Bearer guest-token');

    await callRouteHandler(reviewSyncRouter, 'get', '/history', req, res);

    expect(reviewSyncService.listHistory).toHaveBeenCalledWith('guest-user-1', { limit: '10' });
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      history: [{ id: 'evt-1', eventType: 'review_completed' }],
    });
  });
});

describe('review sync GitHub sign-in routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ATLAS_DESKTOP_MODE;
    reviewSyncRouteTesting.resetGuestSessionRateLimits();
    reviewSyncRouteTesting.resetDeviceFlowStore();
  });

  it('GET /me returns the linked identity for a signed-in guest', async () => {
    reviewSyncService.getGuestSessionByAuthToken.mockResolvedValue({
      id: 'session-1',
      userId: 'guest-user-1',
      deviceId: 'device-1',
    });
    reviewSyncService.getMe.mockResolvedValue({
      userId: 'guest-user-1',
      email: 'octocat@example.com',
      github_login: 'octocat',
      github_avatar_url: 'https://example.com/o.png',
      isGuest: false,
    });
    const { req, res } = createMockReqRes();
    req.get = vi.fn().mockReturnValue('Bearer guest-token');

    await callRouteHandler(reviewSyncRouter, 'get', '/me', req, res);

    expect(reviewSyncService.getMe).toHaveBeenCalledWith('guest-user-1');
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      user: {
        userId: 'guest-user-1',
        email: 'octocat@example.com',
        github_login: 'octocat',
        github_avatar_url: 'https://example.com/o.png',
        isGuest: false,
      },
    });
  });

  it('POST /github/start returns device-flow codes and stores the device_code', async () => {
    reviewSyncService.getGuestSessionByAuthToken.mockResolvedValue({
      id: 'session-1',
      userId: 'guest-user-1',
      deviceId: 'device-1',
    });
    requestDeviceCodeMock.mockResolvedValue({
      device_code: 'dev-123',
      user_code: 'WDJB-MJHT',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    });
    const { req, res } = createMockReqRes();
    req.get = vi.fn().mockReturnValue('Bearer guest-token');

    await callRouteHandler(reviewSyncRouter, 'post', '/github/start', req, res);

    expect(requestDeviceCodeMock).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      deviceFlow: {
        userCode: 'WDJB-MJHT',
        verificationUri: 'https://github.com/login/device',
        expiresIn: 900,
        interval: 5,
      },
    });
  });

  it('POST /github/poll returns authorization_pending when not yet authorized', async () => {
    reviewSyncService.getGuestSessionByAuthToken.mockResolvedValue({
      id: 'session-1',
      userId: 'guest-user-1',
      deviceId: 'device-1',
    });
    requestDeviceCodeMock.mockResolvedValue({
      device_code: 'dev-123',
      user_code: 'WDJB-MJHT',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    });
    exchangeDeviceCodeMock.mockResolvedValue({
      error: 'authorization_pending',
    });

    {
      const { req, res } = createMockReqRes();
      req.get = vi.fn().mockReturnValue('Bearer guest-token');
      await callRouteHandler(reviewSyncRouter, 'post', '/github/start', req, res);
    }

    const { req, res } = createMockReqRes();
    req.get = vi.fn().mockReturnValue('Bearer guest-token');
    await callRouteHandler(reviewSyncRouter, 'post', '/github/poll', req, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      status: 'authorization_pending',
    });
  });

  it('POST /github/poll reissues authToken on merge and returns profile', async () => {
    reviewSyncService.getGuestSessionByAuthToken.mockResolvedValue({
      id: 'session-1',
      userId: 'guest-user-1',
      deviceId: 'device-1',
    });
    requestDeviceCodeMock.mockResolvedValue({
      device_code: 'dev-123',
      user_code: 'WDJB-MJHT',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    });
    exchangeDeviceCodeMock.mockResolvedValue({
      access_token: 'gh_token_1',
      token_type: 'bearer',
    });
    connectGitHubAccountMock.mockResolvedValue({
      userId: 'other-user-2',
      merged: true,
      profile: { id: 4242, login: 'octocat' },
    });
    reviewSyncService.reissueAuthTokenForUser.mockResolvedValue({
      authToken: 'new-auth-token',
    });
    reviewSyncService.getMe.mockResolvedValue({
      userId: 'other-user-2',
      email: 'octocat@example.com',
      github_login: 'octocat',
      github_avatar_url: 'https://example.com/o.png',
      isGuest: false,
    });

    {
      const { req, res } = createMockReqRes();
      req.get = vi.fn().mockReturnValue('Bearer guest-token');
      await callRouteHandler(reviewSyncRouter, 'post', '/github/start', req, res);
    }

    const { req, res } = createMockReqRes();
    req.get = vi.fn().mockReturnValue('Bearer guest-token');
    await callRouteHandler(reviewSyncRouter, 'post', '/github/poll', req, res);

    expect(connectGitHubAccountMock).toHaveBeenCalledWith({
      userId: 'guest-user-1',
      accessToken: 'gh_token_1',
      tokenMeta: {
        refreshToken: undefined,
        expiresIn: undefined,
        refreshTokenExpiresIn: undefined,
      },
      source: 'review_sync_device',
    });
    expect(reviewSyncService.reissueAuthTokenForUser).toHaveBeenCalledWith('other-user-2', {
      sessionId: 'session-1',
    });
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      status: 'linked',
      user: {
        userId: 'other-user-2',
        email: 'octocat@example.com',
        github_login: 'octocat',
        github_avatar_url: 'https://example.com/o.png',
        isGuest: false,
      },
      authToken: 'new-auth-token',
      merged: true,
    });
  });

  it('POST /github/unlink resets the profile but keeps the session auth token', async () => {
    reviewSyncService.getGuestSessionByAuthToken.mockResolvedValue({
      id: 'session-1',
      userId: 'guest-user-1',
      deviceId: 'device-1',
    });
    unlinkGithubMock.mockResolvedValue({
      userId: 'guest-user-1',
      unlinked: true,
    });
    reviewSyncService.getMe.mockResolvedValue({
      userId: 'guest-user-1',
      email: 'guest-guest-us@device.atlasengine.local',
      github_login: null,
      github_avatar_url: null,
      isGuest: true,
    });
    const { req, res } = createMockReqRes();
    req.get = vi.fn().mockReturnValue('Bearer guest-token');

    await callRouteHandler(reviewSyncRouter, 'post', '/github/unlink', req, res);

    expect(unlinkGithubMock).toHaveBeenCalledWith('guest-user-1');
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      user: {
        userId: 'guest-user-1',
        email: 'guest-guest-us@device.atlasengine.local',
        github_login: null,
        github_avatar_url: null,
        isGuest: true,
      },
    });
  });
});
