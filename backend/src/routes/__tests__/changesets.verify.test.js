import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/queries.js', () => ({
  getProjectById: vi.fn(),
}));

vi.mock('../../db/connection.js', () => ({
  default: {
    query: vi.fn(),
  },
}));

vi.mock('../../services/changesetService.js', () => ({
  default: {
    getChangeSet: vi.fn(),
    updateChangeSetVerification: vi.fn(),
    updateChangeSetStatus: vi.fn(),
    updateChangeSetCommit: vi.fn(),
  },
}));

vi.mock('../../services/gitService.js', () => ({
  default: {
    isGitRepository: vi.fn(),
    commitChanges: vi.fn(),
  },
}));

vi.mock('../../services/projectVerificationService.js', () => ({
  default: {
    getProjectVerifyConfig: vi.fn(),
    updateProjectVerifyConfig: vi.fn(),
    summarizeAvailableChecks: vi.fn(),
    runProjectVerification: vi.fn(),
    evaluateVerificationGate: vi.fn(),
  },
}));

vi.mock('../../services/publishService.js', () => ({
  default: {
    checkPublishGate: vi.fn(),
    detectPublishMethod: vi.fn(),
    runPublish: vi.fn(),
    getLatestAppliedChangeset: vi.fn(),
    getPublishPreflight: vi.fn(),
    getEligibleChangesets: vi.fn(),
    checkDatabaseProvisioning: vi.fn(),
  },
}));

vi.mock('../../services/atlasHostingService.js', () => ({
  default: {
    getDeploymentsForChangesets: vi.fn(),
  },
}));

vi.mock('../../services/actionService.js', () => ({
  default: {
    runAction: vi.fn(),
  },
}));

vi.mock('../../services/trustAnalyticsService.js', () => ({
  default: {
    trackEvent: vi.fn(),
  },
}));

vi.mock('../../middleware/quotas.js', () => ({
  enforceQuotas: (req, res, next) => next(),
}));

import { getProjectById } from '../../db/queries.js';
import changesetService from '../../services/changesetService.js';
import gitService from '../../services/gitService.js';
import projectVerificationService from '../../services/projectVerificationService.js';
import changesetsRouter from '../changesets.js';

function createMockReqRes(params = {}, body = {}, user = null) {
  const req = {
    params,
    body,
    user,
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
    const params = {};
    for (let index = 0; index < routeParts.length; index += 1) {
      const routePart = routeParts[index];
      const pathPart = pathParts[index];
      if (routePart.startsWith(':')) {
        params[routePart.slice(1)] = pathPart;
        continue;
      }
      if (routePart !== pathPart) {
        match = false;
        break;
      }
    }

    if (!match) continue;

    req.params = { ...req.params, ...params };
    const handlers = layer.route.stack.map((item) => item.handle);
    for (const handler of handlers) {
      await new Promise((resolve, reject) => {
        const next = (error) => {
          if (error) reject(error);
          else resolve();
        };
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

describe('ChangeSet verify routes', () => {
  const testProject = {
    id: 'proj-123',
    name: 'Test Project',
    path: '/tmp/test-project',
    user_id: '00000000-0000-0000-0000-000000000000',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getProjectById.mockResolvedValue(testProject);
    gitService.isGitRepository.mockResolvedValue(false);
  });

  it('returns available checks from the project verify config', async () => {
    projectVerificationService.getProjectVerifyConfig.mockResolvedValue({
      version: 2,
      projectType: 'node',
      autoRun: 'on_changeset',
      checks: [],
    });
    projectVerificationService.summarizeAvailableChecks.mockReturnValue({
      lint: true,
      unit: false,
      e2e: false,
      hasChecks: true,
      checks: [
        { id: 'lint', label: 'Lint', kind: 'lint', command: 'npm run lint', enabled: true },
      ],
      projectType: 'node',
    });

    const { req, res } = createMockReqRes({ projectId: 'proj-123' });
    await callRouteHandler(changesetsRouter, 'get', '/proj-123/available-checks', req, res);

    expect(projectVerificationService.getProjectVerifyConfig).toHaveBeenCalledWith('proj-123', '/tmp/test-project');
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      lint: true,
      unit: false,
      e2e: false,
      hasChecks: true,
      checks: [
        { id: 'lint', label: 'Lint', kind: 'lint', command: 'npm run lint', enabled: true },
      ],
      projectType: 'node',
    });
  });

  it('gets and updates project verify config', async () => {
    const verifyConfig = {
      version: 2,
      projectType: 'node',
      autoRun: 'never',
      checks: [
        { id: 'typecheck', label: 'Type Check', kind: 'typecheck', command: 'npx tsc --noEmit', enabled: true },
      ],
    };
    projectVerificationService.getProjectVerifyConfig.mockResolvedValue(verifyConfig);
    projectVerificationService.updateProjectVerifyConfig.mockResolvedValue({
      ...verifyConfig,
      autoRun: 'on_changeset',
    });

    const getReqRes = createMockReqRes({ projectId: 'proj-123' });
    await callRouteHandler(changesetsRouter, 'get', '/proj-123/verify-config', getReqRes.req, getReqRes.res);
    expect(getReqRes.res.json).toHaveBeenCalledWith(verifyConfig);

    const putReqRes = createMockReqRes(
      { projectId: 'proj-123' },
      {
        autoRun: 'on_changeset',
        checks: verifyConfig.checks,
      }
    );
    await callRouteHandler(changesetsRouter, 'put', '/proj-123/verify-config', putReqRes.req, putReqRes.res);
    expect(projectVerificationService.updateProjectVerifyConfig).toHaveBeenCalledWith(
      'proj-123',
      '/tmp/test-project',
      {
        autoRun: 'on_changeset',
        checks: verifyConfig.checks,
      }
    );
    expect(putReqRes.res.json).toHaveBeenCalledWith({
      ...verifyConfig,
      autoRun: 'on_changeset',
    });
  });

  it('returns existing verification when no checks are runnable', async () => {
    const changeset = {
      id: 'cs-1',
      status: 'applied',
      verification: {
        lint: 'not_run',
        unit: 'not_run',
        e2e: 'not_run',
        lastRunAt: null,
        logs: {},
        checks: {},
      },
    };

    changesetService.getChangeSet.mockResolvedValue(changeset);
    projectVerificationService.getProjectVerifyConfig.mockResolvedValue({
      version: 2,
      projectType: 'node',
      autoRun: 'never',
      checks: [],
    });
    projectVerificationService.runProjectVerification.mockResolvedValue({
      checksToRun: [],
      results: {},
    });

    const { req, res } = createMockReqRes({ projectId: 'proj-123', changesetId: 'cs-1' });
    await callRouteHandler(changesetsRouter, 'post', '/proj-123/changesets/cs-1/verify', req, res);

    expect(res.json).toHaveBeenCalledWith({
      success: true,
      message: 'No runnable checks found',
      verification: changeset.verification,
      results: {},
    });
    expect(changesetService.updateChangeSetVerification).not.toHaveBeenCalled();
  });

  it('runs configured checks, persists metadata, and promotes the changeset when all checks pass', async () => {
    const changeset = {
      id: 'cs-1',
      status: 'applied',
      files: [{ path: 'src/index.ts' }],
      verification: {
        lint: 'not_run',
        unit: 'not_run',
        e2e: 'not_run',
        logs: {},
        checks: {},
      },
    };
    const verifyConfig = {
      version: 2,
      projectType: 'node',
      autoRun: 'on_changeset',
      checks: [
        { id: 'lint', label: 'Lint', kind: 'lint', command: 'npm run lint', enabled: true },
        { id: 'typecheck', label: 'Type Check', kind: 'typecheck', command: 'npx tsc --noEmit', enabled: true },
      ],
    };
    const results = {
      lint: {
        status: 'pass',
        exitCode: 0,
        logs: 'lint ok',
        duration: 15,
      },
      typecheck: {
        status: 'pass',
        exitCode: 0,
        logs: 'typecheck ok',
        duration: 22,
      },
    };
    const updatedChangeset = {
      ...changeset,
      status: 'applied',
      verification: {
        lint: 'pass',
        unit: 'not_run',
        e2e: 'not_run',
        logs: {
          lint: 'lint ok',
          typecheck: 'typecheck ok',
        },
        checks: {
          lint: { id: 'lint', kind: 'lint', label: 'Lint', status: 'pass' },
          typecheck: { id: 'typecheck', kind: 'typecheck', label: 'Type Check', status: 'pass' },
        },
      },
    };

    changesetService.getChangeSet
      .mockResolvedValueOnce(changeset)
      .mockResolvedValueOnce(updatedChangeset);
    projectVerificationService.getProjectVerifyConfig.mockResolvedValue(verifyConfig);
    projectVerificationService.runProjectVerification.mockResolvedValue({
      checksToRun: verifyConfig.checks,
      results,
    });
    projectVerificationService.evaluateVerificationGate.mockReturnValue({
      enabledChecks: verifyConfig.checks,
      failedChecks: [],
      notRunChecks: [],
    });

    const { req, res } = createMockReqRes(
      { projectId: 'proj-123', changesetId: 'cs-1' },
      { checks: ['lint', 'typecheck'] }
    );
    await callRouteHandler(changesetsRouter, 'post', '/proj-123/changesets/cs-1/verify', req, res);

    expect(projectVerificationService.runProjectVerification).toHaveBeenCalledWith(
      '/tmp/test-project',
      verifyConfig,
      ['lint', 'typecheck']
    );
    expect(changesetService.updateChangeSetVerification).toHaveBeenNthCalledWith(
      1,
      '/tmp/test-project',
      'cs-1',
      'lint',
      'pass',
      'lint ok',
      {
        kind: 'lint',
        label: 'Lint',
        command: 'npm run lint',
        duration: 15,
        exitCode: 0,
      }
    );
    expect(changesetService.updateChangeSetVerification).toHaveBeenNthCalledWith(
      2,
      '/tmp/test-project',
      'cs-1',
      'typecheck',
      'pass',
      'typecheck ok',
      {
        kind: 'typecheck',
        label: 'Type Check',
        command: 'npx tsc --noEmit',
        duration: 22,
        exitCode: 0,
      }
    );
    expect(changesetService.updateChangeSetStatus).toHaveBeenCalledWith('/tmp/test-project', 'cs-1', 'verified');
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      verification: updatedChangeset.verification,
      results,
      status: 'verified',
      autoCommitted: false,
      commitSha: null,
    });
  });

  it('rejects invalid requested check identifiers', async () => {
    changesetService.getChangeSet.mockResolvedValue({
      id: 'cs-1',
      status: 'applied',
    });

    const { req, res } = createMockReqRes(
      { projectId: 'proj-123', changesetId: 'cs-1' },
      { checks: ['lint', ''] }
    );
    await callRouteHandler(changesetsRouter, 'post', '/proj-123/changesets/cs-1/verify', req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Requested checks must be non-empty string identifiers',
    });
  });

  it('rejects unknown requested checks before running verification', async () => {
    changesetService.getChangeSet.mockResolvedValue({
      id: 'cs-1',
      status: 'applied',
    });
    projectVerificationService.getProjectVerifyConfig.mockResolvedValue({
      version: 2,
      projectType: 'node',
      autoRun: 'on_changeset',
      checks: [
        { id: 'lint', label: 'Lint', kind: 'lint', command: 'npm run lint', enabled: true },
      ],
    });

    const { req, res } = createMockReqRes(
      { projectId: 'proj-123', changesetId: 'cs-1' },
      { checks: ['build'] }
    );
    await callRouteHandler(changesetsRouter, 'post', '/proj-123/changesets/cs-1/verify', req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Unknown check identifiers: build',
    });
    expect(projectVerificationService.runProjectVerification).not.toHaveBeenCalled();
  });
});
