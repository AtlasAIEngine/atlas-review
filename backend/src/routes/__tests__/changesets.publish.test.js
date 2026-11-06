/**
 * Publish API Endpoint Integration Tests
 * Tests for GET /publish-status and POST /publish endpoints
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock all dependencies before importing the router
vi.mock('../../db/queries.js', () => ({
  getProjectById: vi.fn(),
}));

vi.mock('../../services/changesetService.js', () => ({
  default: {
    getChangeSets: vi.fn(),
    getChangeSet: vi.fn(),
    updateChangeSetVerification: vi.fn(),
    updateChangeSetStatus: vi.fn(),
  },
}));

vi.mock('../../services/gitService.js', () => ({
  default: {
    isGitRepository: vi.fn(),
    getCurrentBranch: vi.fn(),
    getStatus: vi.fn(),
    commitChanges: vi.fn(),
  },
}));

vi.mock('../../services/verificationService.js', () => ({
  default: {
    detectAvailableChecks: vi.fn(),
    runCheck: vi.fn(),
    readPackageJson: vi.fn(),
  },
}));

vi.mock('../../services/publishService.js', () => ({
  default: {
    checkPublishGate: vi.fn(),
    checkDatabaseProvisioning: vi.fn().mockResolvedValue({ needed: false, provisioned: false, connected: false }),
    detectPublishMethod: vi.fn(),
    runPublish: vi.fn(),
    getLatestAppliedChangeset: vi.fn(),
    getPublishPreflight: vi.fn(),
    getEligibleChangesets: vi.fn(),
  },
}));

vi.mock('../../middleware/quotas.js', () => ({
  enforceQuotas: (req, res, next) => next(),
}));

import express from 'express';
import { getProjectById } from '../../db/queries.js';
import publishService from '../../services/publishService.js';
import changesetsRouter from '../changesets.js';

// Helper to create mock request and response
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

// Helper to find and call route handler
async function callRouteHandler(router, method, path, req, res) {
  // Find the matching route handler
  const stack = router.stack;
  const pathParts = path.split('/').filter(p => p);

  for (const layer of stack) {
    if (layer.route) {
      const routePath = layer.route.path;
      const routeMethod = Object.keys(layer.route.methods)[0];

      if (routeMethod === method) {
        // Check if paths match (handle params)
        const routeParts = routePath.split('/').filter(p => p);
        if (routeParts.length === pathParts.length) {
          let match = true;
          const params = {};
          for (let i = 0; i < routeParts.length; i++) {
            if (routeParts[i].startsWith(':')) {
              params[routeParts[i].slice(1)] = pathParts[i];
            } else if (routeParts[i] !== pathParts[i]) {
              match = false;
              break;
            }
          }
          if (match) {
            req.params = { ...req.params, ...params };
            // Call all middleware in the route
            const handlers = layer.route.stack.map(s => s.handle);
            for (const handler of handlers) {
              await new Promise((resolve, reject) => {
                const next = (err) => {
                  if (err) reject(err);
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
        }
      }
    }
  }
  throw new Error(`Route not found: ${method} ${path}`);
}

describe('Publish API Endpoints', () => {
  const testProject = {
    id: 'proj-123',
    name: 'Test Project',
    path: '/tmp/test-project',
    user_id: '00000000-0000-0000-0000-000000000000',
  };

  const defaultPreflight = {
    isGitRepo: true,
    workingTreeClean: true,
    changesetCommitted: false,
    changesetCommitSha: null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    getProjectById.mockResolvedValue(testProject);
    // Default preflight mock for all tests
    publishService.getPublishPreflight.mockResolvedValue(defaultPreflight);
    // Default eligible changesets mock
    publishService.getEligibleChangesets.mockResolvedValue([]);
  });

  describe('GET /api/projects/:projectId/publish-status', () => {
    it('should return canPublish=false when no changeset exists', async () => {
      publishService.checkPublishGate.mockResolvedValue({
        canPublish: false,
        reason: 'No applied changeset exists. Make changes first.',
        changeset: null,
        availableChecks: { lint: false, unit: false, e2e: false },
      });
      publishService.detectPublishMethod.mockResolvedValue({
        method: 'manual',
        instructions: ['No automated deploy method detected.'],
      });

      const { req, res } = createMockReqRes({ projectId: 'proj-123' });
      await callRouteHandler(changesetsRouter, 'get', '/proj-123/publish-status', req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        canPublish: false,
        reason: 'No applied changeset exists. Make changes first.',
        latestChangeset: null,
        publishMethod: {
          method: 'manual',
          instructions: ['No automated deploy method detected.'],
        },
        availableChecks: { lint: false, unit: false, e2e: false },
        preflight: defaultPreflight,
        eligibleChangesets: [],
        secretsReady: undefined,
        missingSecrets: undefined,
        databaseProvisioning: { needed: false, provisioned: false, connected: false },
      });
    });

    it('should return canPublish=false when verification not run', async () => {
      const changeset = {
        id: 'cs-1',
        title: 'Test changeset',
        createdAt: '2026-01-21T12:00:00Z',
        verification: { lint: 'not_run', unit: 'not_run', e2e: 'not_run' },
      };

      publishService.checkPublishGate.mockResolvedValue({
        canPublish: false,
        reason: 'Run checks first',
        changeset,
        availableChecks: { lint: true, unit: true, e2e: false },
      });
      publishService.detectPublishMethod.mockResolvedValue({
        method: 'vercel',
        command: 'vercel --prod --yes',
      });

      const { req, res } = createMockReqRes({ projectId: 'proj-123' });
      await callRouteHandler(changesetsRouter, 'get', '/proj-123/publish-status', req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        canPublish: false,
        reason: 'Run checks first',
        latestChangeset: expect.objectContaining({
          id: 'cs-1',
          title: 'Test changeset',
          createdAt: '2026-01-21T12:00:00Z',
          verification: { lint: 'not_run', unit: 'not_run', e2e: 'not_run' },
        }),
        availableChecks: { lint: true, unit: true, e2e: false },
        preflight: defaultPreflight,
      }));
    });

    it('should return canPublish=true when checks pass', async () => {
      const changeset = {
        id: 'cs-1',
        title: 'Test changeset',
        createdAt: '2026-01-21T12:00:00Z',
        verification: { lint: 'pass', unit: 'pass', e2e: 'not_run' },
      };

      publishService.checkPublishGate.mockResolvedValue({
        canPublish: true,
        reason: 'All configured checks passed',
        changeset,
        availableChecks: { lint: true, unit: true, e2e: false },
      });
      publishService.detectPublishMethod.mockResolvedValue({
        method: 'vercel',
        command: 'vercel --prod --yes',
      });

      const { req, res } = createMockReqRes({ projectId: 'proj-123' });
      await callRouteHandler(changesetsRouter, 'get', '/proj-123/publish-status', req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true,
        canPublish: true,
        reason: 'All configured checks passed',
        publishMethod: {
          method: 'vercel',
          command: 'vercel --prod --yes',
        },
        availableChecks: { lint: true, unit: true, e2e: false },
        preflight: defaultPreflight,
      }));
    });

    it('should return publishMethod info with script method', async () => {
      const changeset = {
        id: 'cs-1',
        title: 'Test',
        createdAt: '2026-01-21T12:00:00Z',
        verification: { lint: 'pass', unit: 'pass', e2e: 'not_run' },
      };

      publishService.checkPublishGate.mockResolvedValue({
        canPublish: true,
        reason: 'All configured checks passed',
        changeset,
        availableChecks: { lint: true, unit: true, e2e: false },
      });
      publishService.detectPublishMethod.mockResolvedValue({
        method: 'script',
        command: 'npm run deploy',
      });

      const { req, res } = createMockReqRes({ projectId: 'proj-123' });
      await callRouteHandler(changesetsRouter, 'get', '/proj-123/publish-status', req, res);

      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        publishMethod: {
          method: 'script',
          command: 'npm run deploy',
        },
        availableChecks: { lint: true, unit: true, e2e: false },
        preflight: defaultPreflight,
      }));
    });

    it('should return 404 when project not found', async () => {
      getProjectById.mockResolvedValue(null);

      const { req, res } = createMockReqRes({ projectId: 'non-existent' });
      await callRouteHandler(changesetsRouter, 'get', '/non-existent/publish-status', req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Project not found' });
    });

    it('should return 500 on service error', async () => {
      publishService.checkPublishGate.mockRejectedValue(new Error('Database error'));

      const { req, res } = createMockReqRes({ projectId: 'proj-123' });
      await callRouteHandler(changesetsRouter, 'get', '/proj-123/publish-status', req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: 'Failed to get publish status',
      }));
    });
  });

  describe('POST /api/projects/:projectId/publish', () => {
    it('should reject when gate fails (400)', async () => {
      publishService.checkPublishGate.mockResolvedValue({
        canPublish: false,
        reason: 'Fix failing checks',
        changeset: { id: 'cs-1' },
      });

      const { req, res } = createMockReqRes({ projectId: 'proj-123' });
      await callRouteHandler(changesetsRouter, 'post', '/proj-123/publish', req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Cannot publish',
        reason: 'Fix failing checks',
      });
    });

    it('should accept when gate passes and run publish', async () => {
      publishService.checkPublishGate.mockResolvedValue({
        canPublish: true,
        reason: 'All checks passed',
        changeset: { id: 'cs-1' },
      });
      publishService.detectPublishMethod.mockResolvedValue({
        method: 'vercel',
        command: 'vercel --prod --yes',
      });
      publishService.runPublish.mockResolvedValue({
        success: true,
        logs: 'Deployed to production\nProduction: https://my-app.vercel.app',
        url: 'https://my-app.vercel.app',
      });

      const { req, res } = createMockReqRes({ projectId: 'proj-123' });
      await callRouteHandler(changesetsRouter, 'post', '/proj-123/publish', req, res);

      expect(publishService.runPublish).toHaveBeenCalledWith(testProject.path, 'vercel');
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        logs: expect.any(String),
        url: 'https://my-app.vercel.app',
        changesetId: 'cs-1',
      });
    });

    it('should return success/logs/url on publish', async () => {
      publishService.checkPublishGate.mockResolvedValue({
        canPublish: true,
        reason: 'All checks passed',
        changeset: { id: 'cs-1' },
      });
      publishService.detectPublishMethod.mockResolvedValue({
        method: 'script',
        command: 'npm run deploy',
      });
      publishService.runPublish.mockResolvedValue({
        success: true,
        logs: 'Build completed\nDeployed successfully',
        url: 'https://custom-domain.com',
      });

      const { req, res } = createMockReqRes({ projectId: 'proj-123' });
      await callRouteHandler(changesetsRouter, 'post', '/proj-123/publish', req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        logs: 'Build completed\nDeployed successfully',
        url: 'https://custom-domain.com',
        changesetId: 'cs-1',
      });
    });

    it('should handle manual deployment method', async () => {
      publishService.checkPublishGate.mockResolvedValue({
        canPublish: true,
        reason: 'All checks passed',
        changeset: { id: 'cs-1' },
      });
      publishService.detectPublishMethod.mockResolvedValue({
        method: 'manual',
        instructions: [
          'No automated deploy method detected.',
          'To deploy with Vercel:',
          '  1. Install Vercel CLI: npm i -g vercel',
          '  2. Run: vercel --prod',
        ],
      });

      const { req, res } = createMockReqRes({ projectId: 'proj-123' });
      await callRouteHandler(changesetsRouter, 'post', '/proj-123/publish', req, res);

      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Manual deployment required',
        instructions: expect.any(Array),
      });
    });

    it('should return 500 on publish failure', async () => {
      publishService.checkPublishGate.mockResolvedValue({
        canPublish: true,
        reason: 'All checks passed',
        changeset: { id: 'cs-1' },
      });
      publishService.detectPublishMethod.mockResolvedValue({
        method: 'vercel',
        command: 'vercel --prod --yes',
      });
      publishService.runPublish.mockResolvedValue({
        success: false,
        logs: 'Error: Authentication failed',
        error: 'Publish failed with exit code 1',
      });

      const { req, res } = createMockReqRes({ projectId: 'proj-123' });
      await callRouteHandler(changesetsRouter, 'post', '/proj-123/publish', req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: false,
        error: 'Publish failed with exit code 1',
        logs: 'Error: Authentication failed',
      });
    });

    it('should return 404 when project not found', async () => {
      getProjectById.mockResolvedValue(null);

      const { req, res } = createMockReqRes({ projectId: 'non-existent' });
      await callRouteHandler(changesetsRouter, 'post', '/non-existent/publish', req, res);

      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({ error: 'Project not found' });
    });

    it('should return 500 on unexpected error', async () => {
      publishService.checkPublishGate.mockRejectedValue(new Error('Unexpected database error'));

      const { req, res } = createMockReqRes({ projectId: 'proj-123' });
      await callRouteHandler(changesetsRouter, 'post', '/proj-123/publish', req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        error: 'Failed to publish project',
      }));
    });
  });
});
