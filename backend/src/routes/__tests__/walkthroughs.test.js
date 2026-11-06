/**
 * walkthroughs route tests.
 *
 * Phase 11 — verifies the GET/POST endpoints for walkthrough generation:
 * - GET returns 404 on miss, 200 + walkthrough on hit.
 * - POST returns cached walkthrough when available (no provider call).
 * - POST generates and persists when no cache exists.
 * - POST returns 400 when baseSha/headSha missing.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/queries.js', () => ({
  getProjectById: vi.fn(),
}));

const dbQueryMock = vi.fn();
vi.mock('../../db/connection.js', () => ({
  default: {
    query: (...args) => dbQueryMock(...args),
    getDbType: () => 'postgres',
  },
  query: (...args) => dbQueryMock(...args),
  getDbType: () => 'postgres',
}));

vi.mock('../../middleware/quotas.js', () => ({
  enforceQuotas: (req, _res, next) => next(),
}));

const getWalkthroughMock = vi.fn();
const getLatestWalkthroughForBaseMock = vi.fn();
const saveWalkthroughMock = vi.fn();
vi.mock('../../services/walkthroughService.js', () => ({
  default: {
    getWalkthrough: (...args) => getWalkthroughMock(...args),
    getLatestWalkthroughForBase: (...args) => getLatestWalkthroughForBaseMock(...args),
    saveWalkthrough: (...args) => saveWalkthroughMock(...args),
  },
}));

const getDiffForWalkthroughMock = vi.fn();
vi.mock('../../services/gitService.js', () => ({
  default: {
    getDiffForWalkthrough: (...args) => getDiffForWalkthroughMock(...args),
  },
}));

const getPrReviewByIdMock = vi.fn();
vi.mock('../../services/prReviewService.js', () => ({
  default: {
    getById: (...args) => getPrReviewByIdMock(...args),
  },
}));

const getActiveProviderWithKeyMock = vi.fn();
const getReviewProviderCandidatesMock = vi.fn();
vi.mock('../../services/providerService.js', () => ({
  default: {
    getActiveProviderWithKey: (...args) => getActiveProviderWithKeyMock(...args),
    getReviewProviderCandidatesWithKeys: (...args) => getReviewProviderCandidatesMock(...args),
    REVIEW_MODEL_DEFAULTS: {
      anthropic: { triage: 't', walkthrough: 'w', review: 'r', synthesis: 's', verifier: 'v' },
    },
    getSmartReviewModel: (_t, phase) => (phase === 'walkthrough' ? 'w' : 'r'),
  },
  REVIEW_MODEL_DEFAULTS: {
    anthropic: { triage: 't', walkthrough: 'w', review: 'r', synthesis: 's', verifier: 'v' },
  },
}));

const generateWalkthroughMock = vi.fn();
vi.mock('../../services/review/walkthroughGeneration.js', () => ({
  generateWalkthrough: (...args) => generateWalkthroughMock(...args),
}));

const callProviderMock = vi.fn();
vi.mock('../../services/review/reviewProviderExecution.js', () => ({
  callProviderForReviewWithFailover: (...args) => callProviderMock(...args),
}));

import { getProjectById } from '../../db/queries.js';
import walkthroughsRouter from '../walkthroughs.js';

function createMockReqRes(params = {}, query = {}, body = {}, user = null) {
  const req = { params, query, body, user };
  const res = {
    statusCode: 200,
    json: vi.fn().mockReturnThis(),
    status: vi.fn(function (code) { this.statusCode = code; return this; }),
  };
  return { req, res };
}

function createStreamingMockReqRes(params = {}, query = {}, body = {}, user = null) {
  const { req, res } = createMockReqRes(params, query, body, user);
  Object.assign(res, {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    setHeader: vi.fn().mockReturnThis(),
    flushHeaders: vi.fn(function () { this.headersSent = true; return this; }),
    write: vi.fn().mockReturnThis(),
    end: vi.fn(function () { this.writableEnded = true; return this; }),
    once: vi.fn().mockReturnThis(),
  });
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
    for (let i = 0; i < routeParts.length; i += 1) {
      const routePart = routeParts[i];
      const pathPart = pathParts[i];
      if (routePart.startsWith(':')) {
        params[routePart.slice(1)] = pathPart;
      } else if (routePart !== pathPart) {
        matches = false; break;
      }
    }
    if (!matches) continue;
    req.params = { ...req.params, ...params };
    const handlers = layer.route.stack.map((item) => item.handle);
    for (const handler of handlers) {
      await new Promise((resolve, reject) => {
        const next = (err) => (err ? reject(err) : resolve());
        const result = handler(req, res, next);
        if (result instanceof Promise) result.then(resolve).catch(reject);
      });
    }
    return;
  }
  throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
}

const PROJECT = {
  id: 'proj-1',
  path: '/tmp/repo',
  name: 'demo',
  user_id: '00000000-0000-0000-0000-000000000000',
};

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks wipes call history but NOT mockResolvedValue implementations.
  // Reset the mocks whose implementations leak across tests and would change
  // routing behavior (incremental discovery + downstream save).
  getLatestWalkthroughForBaseMock.mockReset();
  saveWalkthroughMock.mockReset();
  getProjectById.mockResolvedValue(PROJECT);
  // Default: setting row not present → defaults to true.
  dbQueryMock.mockResolvedValue({ rows: [] });
  getReviewProviderCandidatesMock.mockResolvedValue([
    { provider: { type: 'anthropic', model: 'review-model' }, apiKey: 'k', authType: 'api' },
  ]);
  getActiveProviderWithKeyMock.mockResolvedValue(null);
  callProviderMock.mockResolvedValue({ text: '{"changeGroups":[]}' });
  getPrReviewByIdMock.mockResolvedValue(null);
});

describe('GET /:projectId/walkthroughs', () => {
  it('returns 400 when baseSha or headSha is missing', async () => {
    const { req, res } = createMockReqRes({}, { baseSha: '' }, {});
    await callRouteHandler(walkthroughsRouter, 'get', '/proj-1/walkthroughs', req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 404 when no walkthrough exists for the SHAs', async () => {
    getWalkthroughMock.mockResolvedValue(null);
    const { req, res } = createMockReqRes({}, { baseSha: 'b', headSha: 'h' }, {});
    await callRouteHandler(walkthroughsRouter, 'get', '/proj-1/walkthroughs', req, res);
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('returns the latest stale walkthrough for the same base when requested', async () => {
    const staleWalkthrough = {
      projectId: 'proj-1',
      baseSha: 'b',
      headSha: 'old-h',
      changeGroups: [{ label: 'stale', files: [] }],
      modelId: 'w',
      providerType: 'anthropic',
    };
    getWalkthroughMock.mockResolvedValue(null);
    getLatestWalkthroughForBaseMock.mockResolvedValue(staleWalkthrough);

    const { req, res } = createMockReqRes({}, { baseSha: 'b', headSha: 'h', includeStale: '1' }, {});
    await callRouteHandler(walkthroughsRouter, 'get', '/proj-1/walkthroughs', req, res);

    expect(getLatestWalkthroughForBaseMock).toHaveBeenCalledWith({
      projectId: 'proj-1',
      baseSha: 'b',
      excludeHeadSha: 'h',
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      walkthrough: staleWalkthrough,
      stale: true,
      currentBaseSha: 'b',
      currentHeadSha: 'h',
    }));
  });

  it('returns the walkthrough on hit', async () => {
    const walkthrough = {
      projectId: 'proj-1', baseSha: 'b', headSha: 'h',
      changeGroups: [{ label: 'x', files: [] }],
      modelId: 'w', providerType: 'anthropic',
    };
    getWalkthroughMock.mockResolvedValue(walkthrough);
    const { req, res } = createMockReqRes({}, { baseSha: 'b', headSha: 'h' }, {});
    await callRouteHandler(walkthroughsRouter, 'get', '/proj-1/walkthroughs', req, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, walkthrough }));
  });
});

describe('POST /:projectId/walkthroughs', () => {
  it('returns 400 when baseSha or headSha is missing', async () => {
    const { req, res } = createMockReqRes({}, {}, { baseSha: 'b' });
    await callRouteHandler(walkthroughsRouter, 'post', '/proj-1/walkthroughs', req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns the cached walkthrough without re-generating when one exists', async () => {
    const cached = { projectId: 'proj-1', baseSha: 'b', headSha: 'h', changeGroups: [] };
    getWalkthroughMock.mockResolvedValueOnce(cached);
    const { req, res } = createMockReqRes({}, {}, { baseSha: 'b', headSha: 'h' });
    await callRouteHandler(walkthroughsRouter, 'post', '/proj-1/walkthroughs', req, res);
    expect(generateWalkthroughMock).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ cached: true }));
  });

  it('bypasses an exact cache hit without disabling incremental mode', async () => {
    const previousWalkthrough = {
      projectId: 'proj-1',
      baseSha: 'b',
      headSha: 'old-h',
      changeGroups: [{ label: 'Old', files: [{ path: 'old.js' }] }],
      modelId: 'w',
      providerType: 'anthropic',
    };
    const deltaGroups = [{ label: 'New commits', files: [{ path: 'new.js' }] }];
    getWalkthroughMock.mockResolvedValueOnce({
      projectId: 'proj-1',
      baseSha: 'b',
      headSha: 'h',
      changeGroups: deltaGroups,
    });
    getLatestWalkthroughForBaseMock.mockResolvedValue(previousWalkthrough);
    getDiffForWalkthroughMock.mockResolvedValue({
      diff: 'delta diff',
      fileSummaries: [{ path: 'new.js', additions: 1, deletions: 0 }],
    });
    generateWalkthroughMock.mockResolvedValue(deltaGroups);

    const { req, res } = createMockReqRes({}, {}, { baseSha: 'b', headSha: 'h', bypassCache: true });
    await callRouteHandler(walkthroughsRouter, 'post', '/proj-1/walkthroughs', req, res);

    expect(getWalkthroughMock).toHaveBeenCalledTimes(1);
    expect(getLatestWalkthroughForBaseMock).toHaveBeenCalledWith({
      projectId: 'proj-1',
      baseSha: 'b',
      excludeHeadSha: 'h',
    });
    expect(getDiffForWalkthroughMock).toHaveBeenCalledWith(
      '/tmp/repo',
      'old-h',
      'h',
      expect.objectContaining({ rangeMode: 'two-dot' }),
    );
    expect(generateWalkthroughMock).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      incremental: true,
      walkthrough: expect.objectContaining({ changeGroups: deltaGroups }),
    }));
  });

  it('generates and persists when no cache exists, defaulting useCheapModel=true', async () => {
    getWalkthroughMock
      .mockResolvedValueOnce(null) // initial cache check
      .mockResolvedValueOnce({ projectId: 'proj-1', baseSha: 'b', headSha: 'h', changeGroups: [{ label: 'X', files: [] }] }); // post-generate read
    getDiffForWalkthroughMock.mockResolvedValue({ diff: 'diff text', fileSummaries: [{ path: 'src/auth.js', additions: 1, deletions: 0 }] });
    generateWalkthroughMock.mockResolvedValue([{ label: 'X', files: [] }]);

    const { req, res } = createMockReqRes({}, {}, { baseSha: 'b', headSha: 'h' });
    await callRouteHandler(walkthroughsRouter, 'post', '/proj-1/walkthroughs', req, res);

    expect(getDiffForWalkthroughMock).toHaveBeenCalledWith(
      '/tmp/repo',
      'b',
      'h',
      expect.objectContaining({ rangeMode: 'two-dot', maxChars: expect.any(Number) }),
    );
    expect(generateWalkthroughMock).toHaveBeenCalledTimes(1);
    const callArgs = generateWalkthroughMock.mock.calls[0][0];
    // useCheapModel is hardcoded true; the user-facing setting was removed.
    expect(callArgs.useCheapModel).toBe(true);
    expect(callArgs.providerType).toBe('anthropic');
    expect(callArgs.fileSummaries).toEqual([{ path: 'src/auth.js', additions: 1, deletions: 0 }]);
    callProviderMock.mockResolvedValueOnce({ text: '{"changeGroups":[]}' });
    await callArgs.providerCall({ prompt: 'walkthrough prompt', model: 'w' });
    expect(callProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({ candidates: expect.any(Array) }),
      'walkthrough prompt',
      expect.objectContaining({
        modelPhase: 'walkthrough',
        reviewModelConfig: expect.objectContaining({
          strategy: 'custom',
          customModels: { walkthrough: 'w' },
        }),
        modelDecisionContext: expect.objectContaining({ reviewSurface: 'walkthrough' }),
      })
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('streams a JSON-compatible heartbeat during generation before the final payload', async () => {
    getWalkthroughMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ projectId: 'proj-1', baseSha: 'b', headSha: 'h', changeGroups: [{ label: 'X', files: [] }] });
    getDiffForWalkthroughMock.mockResolvedValue({
      diff: 'diff text',
      fileSummaries: [{ path: 'src/auth.js', additions: 1, deletions: 0 }],
    });
    generateWalkthroughMock.mockResolvedValue([{ label: 'X', files: [] }]);

    const { req, res } = createStreamingMockReqRes({}, {}, { baseSha: 'b', headSha: 'h' });
    await callRouteHandler(walkthroughsRouter, 'post', '/proj-1/walkthroughs', req, res);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json; charset=utf-8');
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache, no-transform');
    expect(res.flushHeaders).toHaveBeenCalled();
    expect(res.write).toHaveBeenCalledWith(' ');
    const finalWrite = res.write.mock.calls[res.write.mock.calls.length - 1][0];
    expect(JSON.parse(finalWrite)).toEqual(expect.objectContaining({ success: true }));
    expect(res.end).toHaveBeenCalled();
    expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('uses three-dot diff scope for PR walkthrough generation', async () => {
    getWalkthroughMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ projectId: 'proj-1', baseSha: 'b', headSha: 'h', changeGroups: [{ label: 'X', files: [] }] });
    getPrReviewByIdMock.mockResolvedValue({
      id: 'pr-1',
      projectId: 'proj-1',
      baseSha: 'b',
      headSha: 'h',
    });
    getDiffForWalkthroughMock.mockResolvedValue({ diff: 'diff text', fileSummaries: [{ path: 'src/auth.js', additions: 1, deletions: 0 }] });
    generateWalkthroughMock.mockResolvedValue([{ label: 'X', files: [] }]);

    const { req, res } = createMockReqRes({}, {}, {
      baseSha: 'b',
      headSha: 'h',
      reviewType: 'pr_review',
      reviewId: 'pr-1',
    });
    await callRouteHandler(walkthroughsRouter, 'post', '/proj-1/walkthroughs', req, res);

    expect(getPrReviewByIdMock).toHaveBeenCalledWith('pr-1');
    expect(getDiffForWalkthroughMock).toHaveBeenCalledWith(
      '/tmp/repo',
      'b',
      'h',
      expect.objectContaining({ rangeMode: 'three-dot', maxChars: expect.any(Number) }),
    );
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('persists empty walkthrough when diff is empty', async () => {
    getWalkthroughMock.mockResolvedValueOnce(null);
    getDiffForWalkthroughMock.mockResolvedValue({ diff: '', fileSummaries: [] });
    saveWalkthroughMock.mockResolvedValue({
      projectId: 'proj-1', baseSha: 'b', headSha: 'h', changeGroups: [],
    });

    const { req, res } = createMockReqRes({}, {}, { baseSha: 'b', headSha: 'h' });
    await callRouteHandler(walkthroughsRouter, 'post', '/proj-1/walkthroughs', req, res);

    expect(generateWalkthroughMock).not.toHaveBeenCalled();
    expect(saveWalkthroughMock).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ empty: true }));
  });

  it('returns 400 when no AI provider is configured', async () => {
    getWalkthroughMock.mockResolvedValueOnce(null);
    getDiffForWalkthroughMock.mockResolvedValue({ diff: 'diff', fileSummaries: [{ path: 'src/auth.js', additions: 1, deletions: 0 }] });
    getReviewProviderCandidatesMock.mockResolvedValue([]);
    getActiveProviderWithKeyMock.mockResolvedValue(null);

    const { req, res } = createMockReqRes({}, {}, { baseSha: 'b', headSha: 'h' });
    await callRouteHandler(walkthroughsRouter, 'post', '/proj-1/walkthroughs', req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });

  describe('incremental mode', () => {
    const previousWalkthrough = {
      projectId: 'proj-1',
      baseSha: 'b',
      headSha: 'old-h',
      changeGroups: [
        { label: 'Auth refactor', files: [{ path: 'src/auth.js' }, { path: 'src/login.js' }] },
        { label: 'Settings page', files: [{ path: 'src/settings.tsx' }] },
      ],
      modelId: 'w',
      providerType: 'anthropic',
    };

    it('diffs previousHead..newHead and keeps the saved walkthrough delta-only', async () => {
      const deltaGroups = [
        { label: 'Auth tweak + new feature', files: [{ path: 'src/auth.js' }, { path: 'src/new-feature.js' }] },
      ];
      getWalkthroughMock
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          projectId: 'proj-1',
          baseSha: 'b',
          headSha: 'h',
          changeGroups: deltaGroups,
        });
      getLatestWalkthroughForBaseMock.mockResolvedValue(previousWalkthrough);
      getDiffForWalkthroughMock.mockResolvedValue({
        diff: 'delta diff',
        fileSummaries: [{ path: 'src/auth.js', additions: 5, deletions: 0 }, { path: 'src/new-feature.js', additions: 10, deletions: 0 }],
      });
      generateWalkthroughMock.mockResolvedValue(deltaGroups);

      const { req, res } = createMockReqRes({}, {}, { baseSha: 'b', headSha: 'h' });
      await callRouteHandler(walkthroughsRouter, 'post', '/proj-1/walkthroughs', req, res);

      expect(getLatestWalkthroughForBaseMock).toHaveBeenCalledWith({
        projectId: 'proj-1',
        baseSha: 'b',
        excludeHeadSha: 'h',
      });
      // Diff is computed against previousHead, not baseSha.
      expect(getDiffForWalkthroughMock).toHaveBeenCalledWith(
        '/tmp/repo',
        'old-h',
        'h',
        expect.objectContaining({ rangeMode: 'two-dot' }),
      );
      // generateWalkthrough already persists the delta artifact. Do not merge
      // prior steps into the new head, otherwise the updated walkthrough shows
      // old files as if they belonged to the latest commits.
      expect(saveWalkthroughMock).not.toHaveBeenCalled();
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        walkthrough: expect.objectContaining({ changeGroups: deltaGroups }),
        incremental: true,
        previousHeadSha: 'old-h',
      }));
    });

    it('returns noChanges:true and carries previous walkthrough forward when delta is empty', async () => {
      getWalkthroughMock.mockResolvedValueOnce(null);
      getLatestWalkthroughForBaseMock.mockResolvedValue(previousWalkthrough);
      getDiffForWalkthroughMock.mockResolvedValue({ diff: '', fileSummaries: [] });
      saveWalkthroughMock.mockResolvedValue({
        ...previousWalkthrough,
        headSha: 'h',
      });

      const { req, res } = createMockReqRes({}, {}, { baseSha: 'b', headSha: 'h' });
      await callRouteHandler(walkthroughsRouter, 'post', '/proj-1/walkthroughs', req, res);

      expect(generateWalkthroughMock).not.toHaveBeenCalled();
      // Carry-forward save: copy previous changeGroups to the new headSha so
      // the next GET is a direct cache hit.
      expect(saveWalkthroughMock).toHaveBeenCalledWith(expect.objectContaining({
        projectId: 'proj-1',
        baseSha: 'b',
        headSha: 'h',
        changeGroups: previousWalkthrough.changeGroups,
      }));
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        noChanges: true,
        previousHeadSha: 'old-h',
      }));
    });

    it('falls back to full mode when no previous walkthrough exists for the base', async () => {
      getWalkthroughMock
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ projectId: 'proj-1', baseSha: 'b', headSha: 'h', changeGroups: [{ label: 'X', files: [] }] });
      getLatestWalkthroughForBaseMock.mockResolvedValue(null);
      getDiffForWalkthroughMock.mockResolvedValue({
        diff: 'full diff',
        fileSummaries: [{ path: 'src/auth.js', additions: 1, deletions: 0 }],
      });
      generateWalkthroughMock.mockResolvedValue([{ label: 'X', files: [] }]);

      const { req, res } = createMockReqRes({}, {}, { baseSha: 'b', headSha: 'h' });
      await callRouteHandler(walkthroughsRouter, 'post', '/proj-1/walkthroughs', req, res);

      // Diff is against the base, not against any previous head.
      expect(getDiffForWalkthroughMock).toHaveBeenCalledWith(
        '/tmp/repo',
        'b',
        'h',
        expect.any(Object),
      );
      expect(generateWalkthroughMock).toHaveBeenCalledWith(expect.objectContaining({
        incremental: false,
        bypassFileCache: false,
      }));
      // Single save inside generateWalkthrough; no incremental merge re-save.
      expect(saveWalkthroughMock).not.toHaveBeenCalled();
      const responseArgs = res.json.mock.calls[0][0];
      expect(responseArgs.success).toBe(true);
      expect(responseArgs.incremental).toBeUndefined();
    });

    it('skips incremental when force=true (full from scratch)', async () => {
      // force bypasses the cache check entirely, then takes the full path.
      getLatestWalkthroughForBaseMock.mockResolvedValue(previousWalkthrough);
      getDiffForWalkthroughMock.mockResolvedValue({
        diff: 'full diff',
        fileSummaries: [{ path: 'src/auth.js', additions: 1, deletions: 0 }],
      });
      generateWalkthroughMock.mockResolvedValue([{ label: 'X', files: [] }]);
      getWalkthroughMock.mockResolvedValueOnce({ projectId: 'proj-1', baseSha: 'b', headSha: 'h', changeGroups: [{ label: 'X', files: [] }] });

      const { req, res } = createMockReqRes({}, {}, { baseSha: 'b', headSha: 'h', force: true });
      await callRouteHandler(walkthroughsRouter, 'post', '/proj-1/walkthroughs', req, res);

      // force=true must NOT consult the latest-for-base cache.
      expect(getLatestWalkthroughForBaseMock).not.toHaveBeenCalled();
      // Diff is against the base, not against the previous head.
      expect(getDiffForWalkthroughMock).toHaveBeenCalledWith(
        '/tmp/repo',
        'b',
        'h',
        expect.any(Object),
      );
      expect(generateWalkthroughMock).toHaveBeenCalledWith(expect.objectContaining({
        incremental: false,
        bypassFileCache: true,
      }));
      const responseArgs = res.json.mock.calls[0][0];
      expect(responseArgs.incremental).toBeUndefined();
    });

    it('runs incremental for PR review with a two-dot delta diff', async () => {
      // Even though the original PR walkthrough was generated with three-dot
      // semantics, the new commits sit linearly on top of previousHead, so
      // the delta diff must be two-dot.
      getWalkthroughMock
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ projectId: 'proj-1', baseSha: 'b', headSha: 'h', changeGroups: [] });
      getLatestWalkthroughForBaseMock.mockResolvedValue(previousWalkthrough);
      getPrReviewByIdMock.mockResolvedValue({ id: 'pr-1', projectId: 'proj-1', baseSha: 'b', headSha: 'h' });
      getDiffForWalkthroughMock.mockResolvedValue({
        diff: 'delta diff',
        fileSummaries: [{ path: 'src/new.js', additions: 5, deletions: 0 }],
      });
      generateWalkthroughMock.mockResolvedValue([
        { label: 'New PR commits', files: [{ path: 'src/new.js' }] },
      ]);

      const { req, res } = createMockReqRes({}, {}, {
        baseSha: 'b', headSha: 'h', reviewType: 'pr_review', reviewId: 'pr-1',
      });
      await callRouteHandler(walkthroughsRouter, 'post', '/proj-1/walkthroughs', req, res);

      expect(getLatestWalkthroughForBaseMock).toHaveBeenCalledWith({
        projectId: 'proj-1',
        baseSha: 'b',
        excludeHeadSha: 'h',
      });
      // Delta diff: previousHead..newHead, two-dot, NOT three-dot from base.
      expect(getDiffForWalkthroughMock).toHaveBeenCalledWith(
        '/tmp/repo',
        'old-h',
        'h',
        expect.objectContaining({ rangeMode: 'two-dot' }),
      );
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        incremental: true,
        previousHeadSha: 'old-h',
      }));
    });

    it('still uses three-dot for PR review when no previous walkthrough exists (full path)', async () => {
      getWalkthroughMock
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ projectId: 'proj-1', baseSha: 'b', headSha: 'h', changeGroups: [{ label: 'X', files: [] }] });
      getLatestWalkthroughForBaseMock.mockResolvedValue(null);
      getPrReviewByIdMock.mockResolvedValue({ id: 'pr-1', projectId: 'proj-1', baseSha: 'b', headSha: 'h' });
      getDiffForWalkthroughMock.mockResolvedValue({
        diff: 'full diff',
        fileSummaries: [{ path: 'src/auth.js', additions: 1, deletions: 0 }],
      });
      generateWalkthroughMock.mockResolvedValue([{ label: 'X', files: [] }]);

      const { req, res } = createMockReqRes({}, {}, {
        baseSha: 'b', headSha: 'h', reviewType: 'pr_review', reviewId: 'pr-1',
      });
      await callRouteHandler(walkthroughsRouter, 'post', '/proj-1/walkthroughs', req, res);

      expect(getDiffForWalkthroughMock).toHaveBeenCalledWith(
        '/tmp/repo',
        'b',
        'h',
        expect.objectContaining({ rangeMode: 'three-dot' }),
      );
    });
  });
});
