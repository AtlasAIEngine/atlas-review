/**
 * Publish Service Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

vi.mock('../../db/connection.js', () => ({
  default: {
    query: vi.fn(),
  },
}));

// Mock changesetService and verificationService
vi.mock('../changesetService.js', () => ({
  default: {
    getChangeSets: vi.fn(),
    getChangeSet: vi.fn(),
  },
}));

vi.mock('../projectVerificationService.js', () => ({
  default: {
    getProjectVerifyConfig: vi.fn(),
    summarizeAvailableChecks: vi.fn(),
    evaluateVerificationGate: vi.fn(),
  },
}));

vi.mock('../verificationService.js', () => ({
  default: {
    readPackageJson: vi.fn(),
  },
}));

vi.mock('../gitService.js', () => ({
  default: {
    isGitRepository: vi.fn(),
    getStatus: vi.fn(),
  },
}));

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  exec: vi.fn(),
}));

vi.mock('util', () => ({
  promisify: (fn) => fn,
}));

import publishService from '../publishService.js';
import changesetService from '../changesetService.js';
import db from '../../db/connection.js';
import projectVerificationService from '../projectVerificationService.js';
import verificationService from '../verificationService.js';
import gitService from '../gitService.js';
import { exec } from 'child_process';

describe('publishService', () => {
  let testProjectPath;

  function createCheck(id, kind, label = id) {
    return {
      id,
      kind,
      label,
      command: `run-${id}`,
      enabled: true,
    };
  }

  function mockVerifyGate({ checks = [], failedChecks = [], notRunChecks = [], projectType = 'node' } = {}) {
    const config = {
      version: 2,
      autoRun: 'on_changeset',
      projectType,
      checks,
    };
    projectVerificationService.getProjectVerifyConfig.mockResolvedValue(config);
    projectVerificationService.summarizeAvailableChecks.mockReturnValue({
      lint: checks.some((check) => check.kind === 'lint'),
      unit: checks.some((check) => check.kind === 'unit'),
      e2e: checks.some((check) => check.kind === 'e2e'),
      hasChecks: checks.length > 0,
      checks,
      projectType,
    });
    projectVerificationService.evaluateVerificationGate.mockReturnValue({
      enabledChecks: checks.filter((check) => check.enabled !== false),
      failedChecks,
      notRunChecks,
    });
  }

  beforeEach(async () => {
    // Create a unique temp directory for each test
    testProjectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-publish-test-'));
    vi.clearAllMocks();
    db.query.mockResolvedValue({ rows: [] });
    mockVerifyGate();
  });

  afterEach(async () => {
    // Clean up the temp directory
    try {
      await fs.rm(testProjectPath, { recursive: true, force: true });
    } catch (error) {
      // Ignore cleanup errors
    }
  });

  describe('getLatestAppliedChangeset', () => {
    it('should return null when no changesets exist', async () => {
      changesetService.getChangeSets.mockResolvedValue([]);

      const result = await publishService.getLatestAppliedChangeset(testProjectPath);

      expect(result).toBeNull();
    });

    it('should return most recent applied changeset', async () => {
      const changesets = [
        { id: 'cs-2', status: 'applied', createdAt: '2026-01-21T12:00:00Z' },
        { id: 'cs-1', status: 'applied', createdAt: '2026-01-21T11:00:00Z' },
      ];
      const fullChangeset = {
        id: 'cs-2',
        status: 'applied',
        verification: { lint: 'pass', unit: 'pass', e2e: 'not_run' },
      };

      changesetService.getChangeSets.mockResolvedValue(changesets);
      changesetService.getChangeSet.mockResolvedValue(fullChangeset);

      const result = await publishService.getLatestAppliedChangeset(testProjectPath);

      expect(result).toEqual(fullChangeset);
      expect(changesetService.getChangeSet).toHaveBeenCalledWith(testProjectPath, 'cs-2');
    });

    it('should return most recent committed changeset', async () => {
      const changesets = [
        { id: 'cs-2', status: 'committed', createdAt: '2026-01-21T12:00:00Z' },
        { id: 'cs-1', status: 'applied', createdAt: '2026-01-21T11:00:00Z' },
      ];
      const fullChangeset = {
        id: 'cs-2',
        status: 'committed',
        verification: { lint: 'pass', unit: 'pass', e2e: 'not_run' },
      };

      changesetService.getChangeSets.mockResolvedValue(changesets);
      changesetService.getChangeSet.mockResolvedValue(fullChangeset);

      const result = await publishService.getLatestAppliedChangeset(testProjectPath);

      expect(result).toEqual(fullChangeset);
      expect(changesetService.getChangeSet).toHaveBeenCalledWith(testProjectPath, 'cs-2');
    });

    it('should ignore reverted changesets', async () => {
      const changesets = [
        { id: 'cs-3', status: 'reverted', createdAt: '2026-01-21T13:00:00Z' },
        { id: 'cs-2', status: 'reverted', createdAt: '2026-01-21T12:00:00Z' },
        { id: 'cs-1', status: 'applied', createdAt: '2026-01-21T11:00:00Z' },
      ];
      const fullChangeset = {
        id: 'cs-1',
        status: 'applied',
        verification: { lint: 'pass', unit: 'not_run', e2e: 'not_run' },
      };

      changesetService.getChangeSets.mockResolvedValue(changesets);
      changesetService.getChangeSet.mockResolvedValue(fullChangeset);

      const result = await publishService.getLatestAppliedChangeset(testProjectPath);

      expect(result).toEqual(fullChangeset);
      expect(changesetService.getChangeSet).toHaveBeenCalledWith(testProjectPath, 'cs-1');
    });

    it('should return null when all changesets are reverted', async () => {
      const changesets = [
        { id: 'cs-2', status: 'reverted', createdAt: '2026-01-21T12:00:00Z' },
        { id: 'cs-1', status: 'reverted', createdAt: '2026-01-21T11:00:00Z' },
      ];

      changesetService.getChangeSets.mockResolvedValue(changesets);

      const result = await publishService.getLatestAppliedChangeset(testProjectPath);

      expect(result).toBeNull();
      expect(changesetService.getChangeSet).not.toHaveBeenCalled();
    });
  });

  describe('checkPublishGate', () => {
    it('should not allow publish when no applied changeset exists', async () => {
      changesetService.getChangeSets.mockResolvedValue([]);
      mockVerifyGate();

      const result = await publishService.checkPublishGate(testProjectPath);

      expect(result.canPublish).toBe(false);
      expect(result.reason).toBe('No applied changeset exists. Make changes first.');
      expect(result.changeset).toBeNull();
      expect(result.availableChecks).toEqual({
        lint: false,
        unit: false,
        e2e: false,
        hasChecks: false,
        checks: [],
        projectType: 'node',
      });
    });

    it('should not allow publish when verification not run', async () => {
      const lintCheck = createCheck('lint', 'lint', 'Lint');
      const unitCheck = createCheck('unit', 'unit', 'Unit Tests');
      const changesets = [{ id: 'cs-1', status: 'applied' }];
      const fullChangeset = {
        id: 'cs-1',
        status: 'applied',
        verification: { lint: 'not_run', unit: 'not_run', e2e: 'not_run' },
      };

      changesetService.getChangeSets.mockResolvedValue(changesets);
      changesetService.getChangeSet.mockResolvedValue(fullChangeset);
      mockVerifyGate({
        checks: [lintCheck, unitCheck],
        notRunChecks: [lintCheck, unitCheck],
      });

      const result = await publishService.checkPublishGate(testProjectPath);

      expect(result.canPublish).toBe(false);
      expect(result.reason).toBe('Run all checks first (Lint, Unit Tests not run)');
      expect(result.changeset).toEqual(fullChangeset);
    });

    it('should not allow publish when lint failed', async () => {
      const lintCheck = createCheck('lint', 'lint', 'Lint');
      const unitCheck = createCheck('unit', 'unit', 'Unit Tests');
      const changesets = [{ id: 'cs-1', status: 'applied' }];
      const fullChangeset = {
        id: 'cs-1',
        status: 'applied',
        verification: { lint: 'fail', unit: 'pass', e2e: 'not_run' },
      };

      changesetService.getChangeSets.mockResolvedValue(changesets);
      changesetService.getChangeSet.mockResolvedValue(fullChangeset);
      mockVerifyGate({
        checks: [lintCheck, unitCheck],
        failedChecks: [lintCheck],
      });

      const result = await publishService.checkPublishGate(testProjectPath);

      expect(result.canPublish).toBe(false);
      expect(result.reason).toBe('Fix failing checks (Lint)');
    });

    it('should not allow publish when unit tests failed', async () => {
      const lintCheck = createCheck('lint', 'lint', 'Lint');
      const unitCheck = createCheck('unit', 'unit', 'Unit Tests');
      const changesets = [{ id: 'cs-1', status: 'applied' }];
      const fullChangeset = {
        id: 'cs-1',
        status: 'applied',
        verification: { lint: 'pass', unit: 'fail', e2e: 'not_run' },
      };

      changesetService.getChangeSets.mockResolvedValue(changesets);
      changesetService.getChangeSet.mockResolvedValue(fullChangeset);
      mockVerifyGate({
        checks: [lintCheck, unitCheck],
        failedChecks: [unitCheck],
      });

      const result = await publishService.checkPublishGate(testProjectPath);

      expect(result.canPublish).toBe(false);
      expect(result.reason).toBe('Fix failing checks (Unit Tests)');
    });

    it('should allow publish when all checks pass', async () => {
      const lintCheck = createCheck('lint', 'lint', 'Lint');
      const unitCheck = createCheck('unit', 'unit', 'Unit Tests');
      const e2eCheck = createCheck('e2e', 'e2e', 'E2E Tests');
      const changesets = [{ id: 'cs-1', status: 'applied' }];
      const fullChangeset = {
        id: 'cs-1',
        status: 'applied',
        verification: { lint: 'pass', unit: 'pass', e2e: 'pass' },
      };

      changesetService.getChangeSets.mockResolvedValue(changesets);
      changesetService.getChangeSet.mockResolvedValue(fullChangeset);
      mockVerifyGate({
        checks: [lintCheck, unitCheck, e2eCheck],
      });

      const result = await publishService.checkPublishGate(testProjectPath);

      expect(result.canPublish).toBe(true);
      expect(result.reason).toBe('All configured checks passed');
      expect(result.changeset).toEqual(fullChangeset);
      expect(result.availableChecks).toEqual({
        lint: true,
        unit: true,
        e2e: true,
        hasChecks: true,
        checks: [lintCheck, unitCheck, e2eCheck],
        projectType: 'node',
      });
    });

    it('should allow publish when only available checks need to pass', async () => {
      const lintCheck = createCheck('lint', 'lint', 'Lint');
      const changesets = [{ id: 'cs-1', status: 'applied' }];
      const fullChangeset = {
        id: 'cs-1',
        status: 'applied',
        verification: { lint: 'pass', unit: 'not_run', e2e: 'not_run' },
      };

      changesetService.getChangeSets.mockResolvedValue(changesets);
      changesetService.getChangeSet.mockResolvedValue(fullChangeset);
      mockVerifyGate({
        checks: [lintCheck],
      });

      const result = await publishService.checkPublishGate(testProjectPath);

      expect(result.canPublish).toBe(true);
      expect(result.reason).toBe('All configured checks passed');
      expect(result.availableChecks).toEqual({
        lint: true,
        unit: false,
        e2e: false,
        hasChecks: true,
        checks: [lintCheck],
        projectType: 'node',
      });
    });

    it('should allow publish when no checks are configured', async () => {
      const changesets = [{ id: 'cs-1', status: 'applied' }];
      const fullChangeset = {
        id: 'cs-1',
        status: 'applied',
        verification: { lint: 'not_run', unit: 'not_run', e2e: 'not_run' },
      };

      changesetService.getChangeSets.mockResolvedValue(changesets);
      changesetService.getChangeSet.mockResolvedValue(fullChangeset);
      mockVerifyGate();

      const result = await publishService.checkPublishGate(testProjectPath);

      expect(result.canPublish).toBe(true);
      expect(result.reason).toBe('No verification checks configured.');
      expect(result.availableChecks).toEqual({
        lint: false,
        unit: false,
        e2e: false,
        hasChecks: false,
        checks: [],
        projectType: 'node',
      });
    });

    it('should handle missing verification object in changeset', async () => {
      const lintCheck = createCheck('lint', 'lint', 'Lint');
      const changesets = [{ id: 'cs-1', status: 'applied' }];
      const fullChangeset = {
        id: 'cs-1',
        status: 'applied',
        // No verification property
      };

      changesetService.getChangeSets.mockResolvedValue(changesets);
      changesetService.getChangeSet.mockResolvedValue(fullChangeset);
      mockVerifyGate({
        checks: [lintCheck],
        notRunChecks: [lintCheck],
      });

      const result = await publishService.checkPublishGate(testProjectPath);

      expect(result.canPublish).toBe(false);
      expect(result.reason).toBe('Run all checks first (Lint not run)');
    });

    it('should not allow publish if only some available checks passed and others not run', async () => {
      const lintCheck = createCheck('lint', 'lint', 'Lint');
      const unitCheck = createCheck('unit', 'unit', 'Unit Tests');
      const changesets = [{ id: 'cs-1', status: 'applied' }];
      const fullChangeset = {
        id: 'cs-1',
        status: 'applied',
        verification: { lint: 'pass', unit: 'not_run', e2e: 'not_run' },
      };

      changesetService.getChangeSets.mockResolvedValue(changesets);
      changesetService.getChangeSet.mockResolvedValue(fullChangeset);
      mockVerifyGate({
        checks: [lintCheck, unitCheck],
        notRunChecks: [unitCheck],
      });

      const result = await publishService.checkPublishGate(testProjectPath);

      // Should NOT allow - all available checks must pass
      expect(result.canPublish).toBe(false);
      expect(result.reason).toBe('Run all checks first (Unit Tests not run)');
    });
  });

  describe('detectPublishMethod', () => {
    it('should detect vercel CLI when installed globally', async () => {
      exec.mockImplementation((cmd, callback) => {
        if (callback) {
          callback(null, '/usr/local/bin/vercel', '');
        }
        return Promise.resolve({ stdout: '/usr/local/bin/vercel', stderr: '' });
      });
      verificationService.readPackageJson.mockResolvedValue(null);

      const result = await publishService.detectPublishMethod(testProjectPath);

      expect(result.method).toBe('vercel');
      expect(result.command).toBe('vercel --prod --yes');
    });

    it('should detect vercel via vercel.json config file', async () => {
      // Create vercel.json in test directory
      await fs.writeFile(
        path.join(testProjectPath, 'vercel.json'),
        JSON.stringify({ version: 2 })
      );

      exec.mockImplementation((cmd) => {
        return Promise.reject(new Error('command not found'));
      });
      verificationService.readPackageJson.mockResolvedValue(null);

      const result = await publishService.detectPublishMethod(testProjectPath);

      expect(result.method).toBe('vercel');
      expect(result.command).toBe('vercel --prod --yes');
    });

    it('should detect package.json deploy script', async () => {
      exec.mockImplementation((cmd) => {
        return Promise.reject(new Error('command not found'));
      });
      verificationService.readPackageJson.mockResolvedValue({
        name: 'test-project',
        scripts: {
          deploy: 'npm run build && scp -r dist/ server:/var/www/',
        },
      });

      const result = await publishService.detectPublishMethod(testProjectPath);

      expect(result.method).toBe('script');
      expect(result.command).toBe('npm run deploy');
    });

    it('should fall back to manual with instructions when no method detected', async () => {
      exec.mockImplementation((cmd) => {
        return Promise.reject(new Error('command not found'));
      });
      verificationService.readPackageJson.mockResolvedValue({
        name: 'test-project',
        scripts: {
          build: 'vite build',
          // No deploy script
        },
      });

      const result = await publishService.detectPublishMethod(testProjectPath);

      expect(result.method).toBe('manual');
      expect(result.instructions).toBeDefined();
      expect(result.instructions.length).toBeGreaterThan(0);
      expect(result.instructions.join(' ')).toContain('Vercel');
    });

    it('should prefer vercel over deploy script when both available', async () => {
      exec.mockImplementation((cmd, callback) => {
        if (callback) {
          callback(null, '/usr/local/bin/vercel', '');
        }
        return Promise.resolve({ stdout: '/usr/local/bin/vercel', stderr: '' });
      });
      verificationService.readPackageJson.mockResolvedValue({
        name: 'test-project',
        scripts: {
          deploy: 'custom-deploy-script',
        },
      });

      const result = await publishService.detectPublishMethod(testProjectPath);

      expect(result.method).toBe('vercel');
    });

    it('should handle null package.json gracefully', async () => {
      exec.mockImplementation((cmd) => {
        return Promise.reject(new Error('command not found'));
      });
      verificationService.readPackageJson.mockResolvedValue(null);

      const result = await publishService.detectPublishMethod(testProjectPath);

      expect(result.method).toBe('manual');
    });
  });

  describe('getPublishPreflight', () => {
    it('should return isGitRepo=false when project is not a git repository', async () => {
      gitService.isGitRepository.mockResolvedValue(false);

      const result = await publishService.getPublishPreflight(testProjectPath, null);

      expect(result.isGitRepo).toBe(false);
      expect(result.workingTreeClean).toBe(true); // N/A value
      expect(result.changesetCommitted).toBe(false);
      expect(result.changesetCommitSha).toBeNull();
    });

    it('should return working tree clean status when git repo', async () => {
      gitService.isGitRepository.mockResolvedValue(true);
      gitService.getStatus.mockResolvedValue({
        isClean: true,
        modified: [],
        created: [],
        deleted: [],
        staged: [],
        conflicted: [],
        renamed: [],
        notAdded: [],
      });

      const result = await publishService.getPublishPreflight(testProjectPath, null);

      expect(result.isGitRepo).toBe(true);
      expect(result.workingTreeClean).toBe(true);
      expect(result.changesetCommitted).toBe(false);
      expect(result.changesetCommitSha).toBeNull();
    });

    it('should detect dirty working tree', async () => {
      gitService.isGitRepository.mockResolvedValue(true);
      gitService.getStatus.mockResolvedValue({
        isClean: false,
        modified: ['file.js'],
        created: [],
        deleted: [],
        staged: [],
        conflicted: [],
        renamed: [],
        notAdded: [],
      });

      const result = await publishService.getPublishPreflight(testProjectPath, null);

      expect(result.isGitRepo).toBe(true);
      expect(result.workingTreeClean).toBe(false);
    });

    it('should detect committed changeset', async () => {
      gitService.isGitRepository.mockResolvedValue(true);
      gitService.getStatus.mockResolvedValue({
        isClean: true,
        modified: [],
        created: [],
        deleted: [],
        staged: [],
        conflicted: [],
        renamed: [],
        notAdded: [],
      });

      const changeset = {
        id: 'cs-1',
        commitSha: 'abc123def',
      };

      const result = await publishService.getPublishPreflight(testProjectPath, changeset);

      expect(result.changesetCommitted).toBe(true);
      expect(result.changesetCommitSha).toBe('abc123def');
    });

    it('should detect uncommitted changeset', async () => {
      gitService.isGitRepository.mockResolvedValue(true);
      gitService.getStatus.mockResolvedValue({
        isClean: false,
        modified: ['file.js'],
        created: [],
        deleted: [],
        staged: [],
        conflicted: [],
        renamed: [],
        notAdded: [],
      });

      const changeset = {
        id: 'cs-1',
        // No commitSha
      };

      const result = await publishService.getPublishPreflight(testProjectPath, changeset);

      expect(result.changesetCommitted).toBe(false);
      expect(result.changesetCommitSha).toBeNull();
    });

    it('should handle git status error gracefully', async () => {
      gitService.isGitRepository.mockResolvedValue(true);
      gitService.getStatus.mockRejectedValue(new Error('Git error'));

      const result = await publishService.getPublishPreflight(testProjectPath, null);

      expect(result.isGitRepo).toBe(true);
      expect(result.workingTreeClean).toBe(false); // Default to not clean on error
    });
  });
});
