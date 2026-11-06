import crypto from 'crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/connection.js', () => ({
  default: { query: vi.fn() },
}));

vi.mock('../../middleware/quotas.js', () => ({
  enforceQuotas: (_req, _res, next) => next(),
}));

import db from '../../db/connection.js';
import githubRouter from '../github.js';

function createMockReqRes({ headers = {}, body = {}, rawBody = null, user = null, app = null } = {}) {
  const req = {
    headers,
    body,
    rawBody,
    params: {},
    query: {},
    user,
    app: app || { get: vi.fn(() => null) },
  };
  const res = {
    json: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
  };
  return { req, res };
}

async function callRouteHandler(router, method, path, req, res) {
  const pathParts = path.split('/').filter(Boolean);

  for (const layer of router.stack) {
    if (!layer.route) continue;
    const routePath = layer.route.path;
    const routeMethod = Object.keys(layer.route.methods)[0];
    if (routeMethod !== method) continue;

    const routeParts = routePath.split('/').filter(Boolean);
    if (routeParts.length !== pathParts.length) continue;

    let matches = true;
    const extractedParams = {};
    for (let i = 0; i < routeParts.length; i += 1) {
      if (routeParts[i].startsWith(':')) {
        extractedParams[routeParts[i].slice(1)] = pathParts[i];
      } else if (routeParts[i] !== pathParts[i]) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;

    req.params = { ...req.params, ...extractedParams };
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

function signPayload(secret, payload) {
  const rawBody = Buffer.from(JSON.stringify(payload));
  const signature = `sha256=${crypto.createHmac('sha256', secret).update(rawBody).digest('hex')}`;
  return { rawBody, signature };
}

describe('github webhook pull enqueue', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = {
      ...originalEnv,
      GITHUB_WEBHOOK_SECRET: 'test-webhook-secret',
    };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('queues pull sync job for push on default branch', async () => {
    const payload = {
      repository: { full_name: 'owner/repo' },
      ref: 'refs/heads/main',
      after: 'abcdef1234567890',
      pusher: { name: 'alice' },
    };
    const { rawBody, signature } = signPayload(process.env.GITHUB_WEBHOOK_SECRET, payload);

    db.query.mockImplementation(async (sql) => {
      if (sql.includes('FROM projects') && sql.includes('github_sync_enabled = true')) {
        return {
          rows: [{
            id: 'project-1',
            github_repo_owner: 'owner',
            github_repo_name: 'repo',
            github_default_branch: 'main',
            github_sync_enabled: true,
          }],
        };
      }
      if (sql.includes('INSERT INTO github_sync_queue')) {
        return { rows: [{ id: 77 }] };
      }
      return { rows: [] };
    });

    const { req, res } = createMockReqRes({
      headers: {
        'x-github-event': 'push',
        'x-hub-signature-256': signature,
      },
      body: payload,
      rawBody,
    });

    await callRouteHandler(githubRouter, 'post', '/webhook', req, res);

    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      jobId: 77,
      repository: 'owner/repo',
      branch: 'main',
      commitSha: 'abcdef1234567890',
    }));

    const insertCall = db.query.mock.calls.find(([sql]) => sql.includes('INSERT INTO github_sync_queue'));
    expect(insertCall).toBeTruthy();
    expect(insertCall[1][0]).toBe('project-1');
    expect(insertCall[1][1]).toBe('abcdef1234567890');
  });

  it('reuses existing pending pull job for duplicate webhook commit SHA', async () => {
    const payload = {
      repository: { full_name: 'owner/repo' },
      ref: 'refs/heads/main',
      after: 'abcdef1234567890',
      pusher: { name: 'alice' },
    };
    const { rawBody, signature } = signPayload(process.env.GITHUB_WEBHOOK_SECRET, payload);

    db.query.mockImplementation(async (sql) => {
      if (sql.includes('FROM projects') && sql.includes('github_sync_enabled = true')) {
        return {
          rows: [{
            id: 'project-1',
            github_repo_owner: 'owner',
            github_repo_name: 'repo',
            github_default_branch: 'main',
            github_sync_enabled: true,
          }],
        };
      }
      if (sql.includes('FROM github_sync_queue') && sql.includes("sync_type = 'pull'")) {
        return { rows: [{ id: 88, status: 'pending' }] };
      }
      return { rows: [] };
    });

    const { req, res } = createMockReqRes({
      headers: {
        'x-github-event': 'push',
        'x-hub-signature-256': signature,
      },
      body: payload,
      rawBody,
    });

    await callRouteHandler(githubRouter, 'post', '/webhook', req, res);

    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      jobId: 88,
      reusedExistingJob: true,
      commitSha: 'abcdef1234567890',
    }));
    expect(db.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO github_sync_queue'))).toBe(false);
  });

  it('ignores push to non-default branch without enqueuing pull job', async () => {
    const payload = {
      repository: { full_name: 'owner/repo' },
      ref: 'refs/heads/feature/test',
      after: '1234567890abcdef',
      pusher: { name: 'bob' },
    };
    const { rawBody, signature } = signPayload(process.env.GITHUB_WEBHOOK_SECRET, payload);

    db.query.mockResolvedValue({
      rows: [{
        id: 'project-1',
        github_repo_owner: 'owner',
        github_repo_name: 'repo',
        github_default_branch: 'main',
        github_sync_enabled: true,
      }],
    });

    const { req, res } = createMockReqRes({
      headers: {
        'x-github-event': 'push',
        'x-hub-signature-256': signature,
      },
      body: payload,
      rawBody,
    });

    await callRouteHandler(githubRouter, 'post', '/webhook', req, res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      message: expect.stringContaining('Ignoring non-default branch'),
    }));
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  it('reuses existing pending pull job for manual pull with same commit SHA', async () => {
    db.query.mockImplementation(async (sql) => {
      if (sql.includes('FROM projects') && sql.includes('WHERE id = $1 AND user_id = $2')) {
        return {
          rows: [{
            id: 'project-1',
            name: 'Project',
            github_sync_enabled: true,
            github_repo_owner: 'owner',
            github_repo_name: 'repo',
            github_default_branch: 'main',
          }],
        };
      }
      if (sql.includes('FROM github_sync_queue') && sql.includes("sync_type = 'pull'")) {
        return {
          rows: [{
            id: 99,
            project_id: 'project-1',
            sync_type: 'pull',
            status: 'processing',
            commit_sha: 'abcdef1234567890',
            files_changed: null,
            error_message: null,
            retry_count: 0,
            created_at: new Date().toISOString(),
            started_at: null,
            completed_at: null,
          }],
        };
      }
      if (sql.includes('FROM github_sync_queue') && sql.includes("status IN ('pending', 'processing')")) {
        return { rows: [{ id: 99 }] };
      }
      return { rows: [] };
    });

    const { req, res } = createMockReqRes({
      body: {
        type: 'pull',
        message: 'Manual pull',
        commitSha: 'abcdef1234567890',
      },
    });

    await callRouteHandler(githubRouter, 'post', '/projects/project-1/sync', req, res);

    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      message: 'pull sync already queued',
      reusedExistingJob: true,
      lifecycle: expect.objectContaining({
        state: 'processing',
        reusedExistingJob: true,
      }),
      job: expect.objectContaining({
        id: 99,
        type: 'pull',
        lifecycle: expect.objectContaining({ state: 'processing' }),
      }),
    }));
    expect(db.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO github_sync_queue'))).toBe(false);
  });

  it('returns lifecycle-rich sync status payload for active and last jobs', async () => {
    db.query.mockImplementation(async (sql) => {
      if (sql.includes('FROM projects') && sql.includes('github_sync_status')) {
        return {
          rows: [{
            id: 'project-1',
            name: 'Project',
            github_sync_enabled: true,
            github_repo_owner: 'owner',
            github_repo_name: 'repo',
            github_default_branch: 'main',
            github_last_sync_sha: 'sha-last',
            github_last_sync_at: '2026-02-20T00:00:00.000Z',
            github_sync_status: 'syncing',
            github_webhook_id: 1234,
          }],
        };
      }
      if (sql.includes("WHERE project_id = $1 AND status IN ('pending', 'processing')")) {
        return {
          rows: [{
            id: 'job-1',
            project_id: 'project-1',
            sync_type: 'pull',
            status: 'pending',
            commit_sha: 'sha-pending',
            files_changed: '["src/a.ts"]',
            error_message: 'Transient sync failure (retry 1/3) in 2s: timeout',
            retry_count: 1,
            created_at: '2026-02-20T01:00:00.000Z',
            started_at: null,
            completed_at: null,
          }],
        };
      }
      if (sql.includes('SUM(CASE WHEN status = \'pending\'')) {
        return {
          rows: [{
            pending_count: 2,
            processing_count: 1,
            retrying_count: 1,
          }],
        };
      }
      if (sql.includes("AND status IN ('completed', 'failed')")) {
        return {
          rows: [{
            id: 'job-0',
            project_id: 'project-1',
            sync_type: 'pull',
            status: 'completed',
            commit_sha: 'sha-complete',
            files_changed: '["src/b.ts"]',
            error_message: 'superseded pull job: newer pending pull abc1234 already queued',
            retry_count: 0,
            created_at: '2026-02-20T00:30:00.000Z',
            started_at: '2026-02-20T00:31:00.000Z',
            completed_at: '2026-02-20T00:32:00.000Z',
          }],
        };
      }
      return { rows: [] };
    });

    const { req, res } = createMockReqRes({
      user: { id: '00000000-0000-0000-0000-000000000000' },
    });

    await callRouteHandler(githubRouter, 'get', '/projects/project-1/sync/status', req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      syncEnabled: true,
      currentJob: expect.objectContaining({
        id: 'job-1',
        type: 'pull',
        retryCount: 1,
        lifecycle: expect.objectContaining({
          state: 'retrying',
        }),
      }),
      lifecycle: expect.objectContaining({
        pending: expect.objectContaining({
          total: 3,
          queued: 2,
          processing: 1,
          retrying: 1,
        }),
        lastOutcome: expect.objectContaining({
          state: 'superseded',
          superseded: true,
        }),
      }),
    }));
  });

  it('normalizes sync history with lifecycle and parsed files', async () => {
    db.query.mockImplementation(async (sql) => {
      if (sql.includes('SELECT id FROM projects WHERE id = $1 AND user_id = $2')) {
        return { rows: [{ id: 'project-1' }] };
      }
      if (sql.includes('FROM github_sync_queue')) {
        return {
          rows: [{
            id: 'job-1',
            project_id: 'project-1',
            sync_type: 'pull',
            status: 'completed',
            commit_sha: 'sha1',
            commit_message: 'Pull from GitHub',
            files_changed: '["src/a.ts","src/b.ts"]',
            error_message: 'superseded pull job: older commit',
            retry_count: 2,
            created_at: '2026-02-20T00:00:00.000Z',
            started_at: '2026-02-20T00:01:00.000Z',
            completed_at: '2026-02-20T00:02:30.000Z',
          }],
        };
      }
      return { rows: [] };
    });

    const { req, res } = createMockReqRes({
      user: { id: '00000000-0000-0000-0000-000000000000' },
    });
    req.query.limit = '10';

    await callRouteHandler(githubRouter, 'get', '/projects/project-1/sync/history', req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      total: 1,
      history: [
        expect.objectContaining({
          id: 'job-1',
          lifecycleState: 'superseded',
          filesChanged: ['src/a.ts', 'src/b.ts'],
          retry: expect.objectContaining({
            count: 2,
            max: expect.any(Number),
          }),
          lifecycle: expect.objectContaining({
            state: 'superseded',
            superseded: true,
          }),
        }),
      ],
    }));
  });

  it('returns lifecycle metadata for manual queued sync and emits queued event when socket is available', async () => {
    const emit = vi.fn();
    const to = vi.fn(() => ({ emit }));

    db.query.mockImplementation(async (sql) => {
      if (sql.includes('FROM projects') && sql.includes('WHERE id = $1 AND user_id = $2')) {
        return {
          rows: [{
            id: 'project-1',
            name: 'Project',
            github_sync_enabled: true,
            github_repo_owner: 'owner',
            github_repo_name: 'repo',
            github_default_branch: 'main',
          }],
        };
      }
      if (sql.includes("status IN ('pending', 'processing')")) {
        return { rows: [] };
      }
      if (sql.includes('INSERT INTO github_sync_queue')) {
        return {
          rows: [{
            id: 'job-new',
            project_id: 'project-1',
            sync_type: 'pull',
            status: 'pending',
            commit_sha: 'sha-new',
            commit_message: 'Manual pull',
            files_changed: null,
            error_message: null,
            retry_count: 0,
            created_at: '2026-02-20T02:00:00.000Z',
            started_at: null,
            completed_at: null,
          }],
        };
      }
      return { rows: [] };
    });

    const { req, res } = createMockReqRes({
      app: { get: vi.fn(() => ({ to })) },
      body: {
        type: 'pull',
        message: 'Manual pull',
        commitSha: 'sha-new',
      },
    });

    await callRouteHandler(githubRouter, 'post', '/projects/project-1/sync', req, res);

    expect(res.status).toHaveBeenCalledWith(202);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      lifecycle: expect.objectContaining({
        state: 'queued',
        reusedExistingJob: false,
      }),
      job: expect.objectContaining({
        lifecycle: expect.objectContaining({
          state: 'queued',
        }),
      }),
    }));
    expect(to).toHaveBeenCalledWith('project-project-1');
    expect(emit).toHaveBeenCalledWith(
      'sync-queued',
      expect.objectContaining({
        lifecycle: expect.objectContaining({
          state: 'queued',
          commitSha: 'sha-new',
        }),
      })
    );
    expect(emit).toHaveBeenCalledWith(
      'sync-lifecycle',
      expect.objectContaining({
        event: 'sync-queued',
        state: 'queued',
      })
    );
  });
});
