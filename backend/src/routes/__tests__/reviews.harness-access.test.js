import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/reviewQualityHarness.js', () => ({
  default: {
    runHarness: vi.fn(),
    compareQualityModes: vi.fn(),
    compareBenchmarkVariants: vi.fn(),
    listFixtures: vi.fn(),
  },
}));

vi.mock('../../services/reviewService.js', () => ({
  default: {
    reviewChangeset: vi.fn(),
    enqueueReview: vi.fn(),
    cancelReview: vi.fn(),
    getQueueStatus: vi.fn(),
  },
}));

vi.mock('../../db/queries.js', () => ({
  getProjectById: vi.fn(),
}));

import reviewQualityHarness from '../../services/reviewQualityHarness.js';
import reviewsRouter from '../reviews.js';

function createMockReqRes({ body = {}, user = null, headers = {} } = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [String(key).toLowerCase(), value])
  );
  const req = {
    body,
    user,
    get: vi.fn((name) => normalizedHeaders[String(name || '').toLowerCase()]),
  };
  const res = {
    json: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
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

    let match = true;
    for (let i = 0; i < routeParts.length; i += 1) {
      if (!routeParts[i].startsWith(':') && routeParts[i] !== pathParts[i]) {
        match = false;
        break;
      }
    }
    if (!match) continue;

    const handlers = layer.route.stack.map((entry) => entry.handle);
    for (const handler of handlers) {
      await new Promise((resolve, reject) => {
        const next = (err) => (err ? reject(err) : resolve());
        const result = handler(req, res, next);
        if (result instanceof Promise) {
          result.then(resolve).catch(reject);
        }
      });
    }
    return;
  }

  throw new Error(`Route not found: ${method} ${path}`);
}

const ORIGINAL_ENV = { ...process.env };
const AUTH_USER = { id: '11111111-1111-1111-1111-111111111111' };

describe('Review harness route access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...ORIGINAL_ENV };
    process.env.NODE_ENV = 'production';
    process.env.ATLAS_DESKTOP_MODE = 'false';
    delete process.env.ATLAS_ENABLE_REVIEW_HARNESS;
    delete process.env.ATLAS_ENABLE_REVIEW_HARNESS_LIVE;
    delete process.env.ATLAS_REVIEW_HARNESS_TOKEN;

    reviewQualityHarness.runHarness.mockResolvedValue({
      fixtureCount: 1,
      passCount: 1,
      failCount: 0,
      results: [],
    });
    reviewQualityHarness.compareQualityModes.mockResolvedValue({
      baseline: { fixtureCount: 1 },
      improved: { fixtureCount: 1 },
      comparison: { passRateDelta: 0 },
    });
    reviewQualityHarness.compareBenchmarkVariants.mockResolvedValue({
      baseline: { fixtureCount: 2, mode: 'control' },
      improved: { fixtureCount: 2, mode: 'candidate' },
      delta: { avgScore: 0.1 },
    });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('rejects harness execution when production enable flag is missing', async () => {
    const { req, res } = createMockReqRes({ body: { dryRun: true }, user: AUTH_USER });
    await callRouteHandler(reviewsRouter, 'post', '/review-harness/run', req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringContaining('ATLAS_ENABLE_REVIEW_HARNESS=true'),
    }));
    expect(reviewQualityHarness.runHarness).not.toHaveBeenCalled();
  });

  it('requires authenticated user when harness is enabled in production', async () => {
    process.env.ATLAS_ENABLE_REVIEW_HARNESS = 'true';

    const { req, res } = createMockReqRes({ body: { dryRun: true }, user: null });
    await callRouteHandler(reviewsRouter, 'post', '/review-harness/run', req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(reviewQualityHarness.runHarness).not.toHaveBeenCalled();
  });

  it('allows dry-run harness execution with authenticated user in production', async () => {
    process.env.ATLAS_ENABLE_REVIEW_HARNESS = 'true';

    const { req, res } = createMockReqRes({
      body: { dryRun: true, fixtureIds: ['security-sql-01'], fixtureSet: 'pr_review', surface: 'pr_review' },
      user: AUTH_USER,
    });
    await callRouteHandler(reviewsRouter, 'post', '/review-harness/run', req, res);

    expect(reviewQualityHarness.runHarness).toHaveBeenCalledWith({
      fixtureIds: ['security-sql-01'],
      fixtureSet: 'pr_review',
      surface: 'pr_review',
      dryRun: true,
      qualityMode: undefined,
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('blocks live harness execution unless live flag is enabled', async () => {
    process.env.ATLAS_ENABLE_REVIEW_HARNESS = 'true';

    const { req, res } = createMockReqRes({
      body: { dryRun: false, fixtureIds: ['security-sql-01'] },
      user: AUTH_USER,
    });
    await callRouteHandler(reviewsRouter, 'post', '/review-harness/run', req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: expect.stringContaining('ATLAS_ENABLE_REVIEW_HARNESS_LIVE=true'),
    }));
    expect(reviewQualityHarness.runHarness).not.toHaveBeenCalled();
  });

  it('allows live harness execution when live flag is enabled', async () => {
    process.env.ATLAS_ENABLE_REVIEW_HARNESS = 'true';
    process.env.ATLAS_ENABLE_REVIEW_HARNESS_LIVE = 'true';

    const { req, res } = createMockReqRes({
      body: { dryRun: false, fixtureIds: ['security-sql-01'] },
      user: AUTH_USER,
    });
    await callRouteHandler(reviewsRouter, 'post', '/review-harness/run', req, res);

    expect(reviewQualityHarness.runHarness).toHaveBeenCalledWith({
      fixtureIds: ['security-sql-01'],
      dryRun: false,
      qualityMode: undefined,
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('enforces optional harness token on compare endpoint', async () => {
    process.env.ATLAS_ENABLE_REVIEW_HARNESS = 'true';
    process.env.ATLAS_REVIEW_HARNESS_TOKEN = 'expected-token';

    const { req, res } = createMockReqRes({
      body: { dryRun: true },
      user: AUTH_USER,
      headers: { 'x-atlas-harness-token': 'wrong-token' },
    });
    await callRouteHandler(reviewsRouter, 'post', '/review-harness/compare', req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      error: 'Invalid review harness token.',
    }));
    expect(reviewQualityHarness.compareQualityModes).not.toHaveBeenCalled();
  });

  it('forwards compare tuning overrides when authorized', async () => {
    process.env.ATLAS_ENABLE_REVIEW_HARNESS = 'true';
    process.env.ATLAS_ENABLE_REVIEW_HARNESS_TOKEN = 'expected-token';

    const { req, res } = createMockReqRes({
      body: {
        dryRun: true,
        fixtureIds: ['clean-code'],
        fixtureSet: 'pr_review',
        surface: 'pr_review',
        gateThresholds: { minCompletedFixtures: 3 },
        adaptiveConfig: { fastPathMaxFiles: 12, fastPathMaxDiffChars: 20000 },
        tuningTargets: { maxDeepScopePressureRate: 0.7 },
      },
      user: AUTH_USER,
      headers: { 'x-atlas-harness-token': 'expected-token' },
    });
    await callRouteHandler(reviewsRouter, 'post', '/review-harness/compare', req, res);

    expect(reviewQualityHarness.compareQualityModes).toHaveBeenCalledWith({
      fixtureIds: ['clean-code'],
      fixtureSet: 'pr_review',
      surface: 'pr_review',
      dryRun: true,
      gateThresholds: { minCompletedFixtures: 3 },
      adaptiveConfig: { fastPathMaxFiles: 12, fastPathMaxDiffChars: 20000 },
      tuningTargets: { maxDeepScopePressureRate: 0.7 },
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('forwards control-vs-candidate variant comparisons when authorized', async () => {
    process.env.ATLAS_ENABLE_REVIEW_HARNESS = 'true';

    const { req, res } = createMockReqRes({
      body: {
        dryRun: true,
        fixtureSet: 'pr_review',
        surface: 'pr_review',
        baseline: { label: 'control' },
        candidate: {
          label: 'candidate',
          promptMetadataOverrides: {
            additionalPromptContextBlocks: [
              {
                id: 'unity_stack_signals',
                title: '### Atlas Local Context: Unity Stack Signals',
                lines: ['Unity editor version: 6000.0.20f1'],
              },
            ],
          },
        },
      },
      user: AUTH_USER,
    });
    await callRouteHandler(reviewsRouter, 'post', '/review-harness/compare-variants', req, res);

    expect(reviewQualityHarness.compareBenchmarkVariants).toHaveBeenCalledWith({
      fixtureIds: undefined,
      fixtureSet: 'pr_review',
      surface: 'pr_review',
      dryRun: true,
      gateThresholds: undefined,
      adaptiveConfig: undefined,
      tuningTargets: undefined,
      baseline: { label: 'control' },
      candidate: {
        label: 'candidate',
        promptMetadataOverrides: {
          additionalPromptContextBlocks: [
            {
              id: 'unity_stack_signals',
              title: '### Atlas Local Context: Unity Stack Signals',
              lines: ['Unity editor version: 6000.0.20f1'],
            },
          ],
        },
      },
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});
