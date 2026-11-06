import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
const getDbTypeMock = vi.fn(() => 'postgres');
const invalidateExecutionModeOrderCacheMock = vi.fn();

vi.mock('../../db/connection.js', () => ({
  default: {
    query: (...args) => queryMock(...args),
    getDbType: (...args) => getDbTypeMock(...args),
  },
}));

vi.mock('../../services/review/reviewProviderExecution.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    invalidateExecutionModeOrderCache: (...args) => invalidateExecutionModeOrderCacheMock(...args),
  };
});

import settingsRouter from '../settings.js';

function createMockReqRes({ pathKey, body = {} } = {}) {
  const req = {
    params: { key: pathKey },
    body,
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

describe('settings routes review_model_rollout normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ATLAS_REVIEW_SYNC_SERVER_URL;
    delete process.env.ATLAS_REVIEW_SYNC_USER_ID;
    queryMock.mockResolvedValue({
      rows: [{
        id: 'review_model_rollout',
        value: '{"mode":"on","canaryPercent":25,"projectAllowlist":[]}',
        updated_at: new Date().toISOString(),
      }],
    });
  });

  it('sanitizes rollout setting payload before persistence', async () => {
    const { req, res } = createMockReqRes({
      pathKey: 'review_model_rollout',
      body: {
        value: {
          mode: 'UNKNOWN',
          canaryPercent: 999,
          projectAllowlist: ['  Project-1 ', 'project-1', '', 'PROJECT-2'],
        },
      },
    });

    await callRouteHandler(settingsRouter, 'put', '/review_model_rollout', req, res);

    expect(queryMock).toHaveBeenCalled();
    const [, values] = queryMock.mock.calls[0];
    const storedRaw = values[1];
    const stored = JSON.parse(storedRaw);
    expect(stored).toEqual({
      mode: 'on',
      canaryPercent: 100,
      projectAllowlist: ['project-1', 'project-2'],
      gate: {
        status: 'pass',
        reasonCodes: [],
        source: 'unset',
        evaluatedAt: null,
      },
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      key: 'review_model_rollout',
    }));
  });

  it('supports canary mode with bounded percentage and normalized allowlist text', async () => {
    const { req, res } = createMockReqRes({
      pathKey: 'review_model_rollout',
      body: {
        value: {
          mode: 'canary',
          canaryPercent: -5,
          projectAllowlist: 'Alpha\nbeta , gamma',
        },
      },
    });

    await callRouteHandler(settingsRouter, 'put', '/review_model_rollout', req, res);

    const [, values] = queryMock.mock.calls[0];
    const stored = JSON.parse(values[1]);
    expect(stored).toEqual({
      mode: 'canary',
      canaryPercent: 0,
      projectAllowlist: ['alpha', 'beta', 'gamma'],
      gate: {
        status: 'pass',
        reasonCodes: [],
        source: 'unset',
        evaluatedAt: null,
      },
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      key: 'review_model_rollout',
    }));
  });

  it('normalizes rollout gate payload fields', async () => {
    const { req, res } = createMockReqRes({
      pathKey: 'review_model_rollout',
      body: {
        value: {
          mode: 'on',
          canaryPercent: 25,
          projectAllowlist: [],
          gate: {
            status: 'FAIL',
            reasonCodes: [' Gate Timeout ', 'gate timeout', ''],
            source: ' Harness ',
            evaluatedAt: '2026-02-22T00:00:00.000Z',
          },
        },
      },
    });

    await callRouteHandler(settingsRouter, 'put', '/review_model_rollout', req, res);

    const [, values] = queryMock.mock.calls[0];
    const stored = JSON.parse(values[1]);
    expect(stored).toEqual({
      mode: 'on',
      canaryPercent: 25,
      projectAllowlist: [],
      gate: {
        status: 'fail',
        reasonCodes: ['gate_timeout'],
        source: 'harness',
        evaluatedAt: '2026-02-22T00:00:00.000Z',
      },
    });
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      key: 'review_model_rollout',
    }));
  });
});

describe('settings routes review sync runtime application', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ATLAS_REVIEW_SYNC_SERVER_URL;
    delete process.env.ATLAS_REVIEW_SYNC_USER_ID;
    queryMock.mockResolvedValue({
      rows: [{
        id: 'review_sync_server_url',
        value: 'https://atlasenginemvpclaude-production.up.railway.app',
        updated_at: new Date().toISOString(),
      }],
    });
  });

  it('applies persisted review sync values to process env on save', async () => {
    const { req, res } = createMockReqRes({
      pathKey: 'review_sync_server_url',
      body: { value: 'https://atlasenginemvpclaude-production.up.railway.app/' },
    });

    await callRouteHandler(settingsRouter, 'put', '/review_sync_server_url', req, res);

    expect(process.env.ATLAS_REVIEW_SYNC_SERVER_URL).toBe('https://atlasenginemvpclaude-production.up.railway.app');
    const [, values] = queryMock.mock.calls[0];
    expect(values[1]).toBe('https://atlasenginemvpclaude-production.up.railway.app');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      key: 'review_sync_server_url',
    }));
  });

  it('clears runtime review sync env on delete', async () => {
    process.env.ATLAS_REVIEW_SYNC_USER_ID = 'operator-user';
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'review_sync_user_id' }],
    });

    const { req, res } = createMockReqRes({
      pathKey: 'review_sync_user_id',
    });

    await callRouteHandler(settingsRouter, 'delete', '/review_sync_user_id', req, res);

    expect(process.env.ATLAS_REVIEW_SYNC_USER_ID).toBeUndefined();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      deleted: true,
      key: 'review_sync_user_id',
    }));
  });
});

describe('settings routes review_model_strategy normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockResolvedValue({
      rows: [{
        id: 'review_model_strategy',
        value: 'smart',
        updated_at: new Date().toISOString(),
      }],
    });
  });

  it('accepts latency_first strategy and normalizes casing', async () => {
    const { req, res } = createMockReqRes({
      pathKey: 'review_model_strategy',
      body: {
        value: 'LaTeNcY_FiRsT',
      },
    });

    await callRouteHandler(settingsRouter, 'put', '/review_model_strategy', req, res);

    const [, values] = queryMock.mock.calls[0];
    expect(values[1]).toBe('latency_first');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      key: 'review_model_strategy',
    }));
  });

  it('accepts performance strategy', async () => {
    const { req, res } = createMockReqRes({
      pathKey: 'review_model_strategy',
      body: {
        value: 'Performance',
      },
    });

    await callRouteHandler(settingsRouter, 'put', '/review_model_strategy', req, res);

    const [, values] = queryMock.mock.calls[0];
    expect(values[1]).toBe('performance');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      key: 'review_model_strategy',
    }));
  });

  it('falls back unknown strategy values to smart', async () => {
    const { req } = createMockReqRes({
      pathKey: 'review_model_strategy',
      body: {
        value: 'ultra_fast',
      },
    });
    const res = {
      json: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
    };

    await callRouteHandler(settingsRouter, 'put', '/review_model_strategy', req, res);

    const [, values] = queryMock.mock.calls[0];
    expect(values[1]).toBe('smart');
  });
});

describe('settings routes execution mode order cache invalidation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('invalidates execution mode order cache on delete', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'review_execution_mode_order' }],
    });
    const { req, res } = createMockReqRes({
      pathKey: 'review_execution_mode_order',
    });

    await callRouteHandler(settingsRouter, 'delete', '/review_execution_mode_order', req, res);

    expect(invalidateExecutionModeOrderCacheMock).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      deleted: true,
      key: 'review_execution_mode_order',
    }));
  });

  it('does not invalidate execution mode order cache for unrelated setting deletes', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{ id: 'review_model_strategy' }],
    });
    const { req, res } = createMockReqRes({
      pathKey: 'review_model_strategy',
    });

    await callRouteHandler(settingsRouter, 'delete', '/review_model_strategy', req, res);

    expect(invalidateExecutionModeOrderCacheMock).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      deleted: true,
      key: 'review_model_strategy',
    }));
  });
});

describe('settings routes PR auto-refresh normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockResolvedValue({
      rows: [{
        id: 'pr_auto_refresh_interval',
        value: '30',
        updated_at: new Date().toISOString(),
      }],
    });
  });

  it('normalizes pr_auto_refresh_enabled to a stored boolean string', async () => {
    const { req, res } = createMockReqRes({
      pathKey: 'pr_auto_refresh_enabled',
      body: {
        value: 'YES',
      },
    });

    await callRouteHandler(settingsRouter, 'put', '/pr_auto_refresh_enabled', req, res);

    const [, values] = queryMock.mock.calls[0];
    expect(values[1]).toBe('true');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
    }));
  });

  it('falls back invalid pr_auto_refresh_interval values to manual', async () => {
    const { req, res } = createMockReqRes({
      pathKey: 'pr_auto_refresh_interval',
      body: {
        value: '7',
      },
    });

    await callRouteHandler(settingsRouter, 'put', '/pr_auto_refresh_interval', req, res);

    const [, values] = queryMock.mock.calls[0];
    expect(values[1]).toBe('manual');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      key: 'pr_auto_refresh_interval',
    }));
  });

  it('accepts manual for git poll interval normalization', async () => {
    const { req } = createMockReqRes({
      pathKey: 'git_poll_interval',
      body: {
        value: 'manual',
      },
    });
    const res = {
      json: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
    };

    await callRouteHandler(settingsRouter, 'put', '/git_poll_interval', req, res);

    const [, values] = queryMock.mock.calls[0];
    expect(values[1]).toBe('manual');
  });
});

describe('settings routes auto-review defaults', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockResolvedValue({ rows: [] });
  });

  it('returns global auto-review enabled by default when unset', async () => {
    const { req, res } = createMockReqRes({
      pathKey: 'auto_review_enabled',
    });

    await callRouteHandler(settingsRouter, 'get', '/auto_review_enabled', req, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      key: 'auto_review_enabled',
      value: 'true',
      exists: false,
      isDefault: true,
    });
  });

  it('normalizes project auto-review settings as boolean strings', async () => {
    queryMock.mockResolvedValue({
      rows: [{
        id: 'project_auto_review_enabled:project-1',
        value: 'true',
        updated_at: new Date().toISOString(),
      }],
    });
    const { req, res } = createMockReqRes({
      pathKey: 'project_auto_review_enabled:project-1',
      body: {
        value: 'YES',
      },
    });

    await callRouteHandler(settingsRouter, 'put', '/project_auto_review_enabled:project-1', req, res);

    const [, values] = queryMock.mock.calls[0];
    expect(values[1]).toBe('true');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      key: 'project_auto_review_enabled:project-1',
    }));
  });
});

describe('settings routes polling normalization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryMock.mockResolvedValue({
      rows: [{
        id: 'git_poll_interval',
        value: '5',
        updated_at: new Date().toISOString(),
      }],
    });
  });

  it('normalizes git poll interval values to supported options', async () => {
    const { req, res } = createMockReqRes({
      pathKey: 'git_poll_interval',
      body: {
        value: '999',
      },
    });

    await callRouteHandler(settingsRouter, 'put', '/git_poll_interval', req, res);

    const [, values] = queryMock.mock.calls[0];
    expect(values[1]).toBe('5');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      key: 'git_poll_interval',
    }));
  });

  it('accepts manual PR auto-refresh interval mode', async () => {
    const { req, res } = createMockReqRes({
      pathKey: 'pr_auto_refresh_interval',
      body: {
        value: 'manual',
      },
    });

    await callRouteHandler(settingsRouter, 'put', '/pr_auto_refresh_interval', req, res);

    const [, values] = queryMock.mock.calls[0];
    expect(values[1]).toBe('manual');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
    }));
  });

  it('falls back invalid PR auto-refresh intervals to the PR default', async () => {
    const { req } = createMockReqRes({
      pathKey: 'pr_auto_refresh_interval',
      body: {
        value: '0',
      },
    });
    const res = {
      json: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
    };

    await callRouteHandler(settingsRouter, 'put', '/pr_auto_refresh_interval', req, res);

    const [, values] = queryMock.mock.calls[0];
    expect(values[1]).toBe('manual');
  });
});
