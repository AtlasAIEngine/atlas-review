import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getCurrentBranchNameMock = vi.fn();
const hasUncommittedChangesMock = vi.fn();
const getCurrentSHAMock = vi.fn();
const getFileAtRefMock = vi.fn();
const getWorkingTreeEntriesMock = vi.fn();
const getGitInstanceMock = vi.fn();

vi.mock('../gitService.js', () => ({
  default: {
    getCurrentBranchName: (...args) => getCurrentBranchNameMock(...args),
    hasUncommittedChanges: (...args) => hasUncommittedChangesMock(...args),
    getCurrentSHA: (...args) => getCurrentSHAMock(...args),
    getFileAtRef: (...args) => getFileAtRefMock(...args),
    getWorkingTreeEntries: (...args) => getWorkingTreeEntriesMock(...args),
    getGitInstance: (...args) => getGitInstanceMock(...args),
  },
}));

import workspaceReviewService from '../workspaceReviewService.js';

describe('workspaceReviewService', () => {
  let projectPath;

  beforeEach(async () => {
    vi.clearAllMocks();
    projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-workspace-review-'));
    getCurrentBranchNameMock.mockResolvedValue('main');
    hasUncommittedChangesMock.mockResolvedValue(true);
    getCurrentSHAMock.mockResolvedValue('head-123');
    getGitInstanceMock.mockReturnValue({
      raw: vi.fn().mockResolvedValue('3\t1\tsrc/app.ts\n'),
    });
  });

  afterEach(async () => {
    await fs.rm(projectPath, { recursive: true, force: true });
  });

  it('returns null when the current branch has no uncommitted changes', async () => {
    hasUncommittedChangesMock.mockResolvedValue(false);

    const review = await workspaceReviewService.getCurrent(projectPath, {
      projectId: 'proj-1',
      baseBranch: 'main',
    });

    expect(review).toBeNull();
  });

  it('hydrates a current workspace review snapshot for dirty files', async () => {
    await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'src/app.ts'), 'export const value = 2;\n');
    await fs.writeFile(path.join(projectPath, 'README.md'), '# Draft\n');

    getWorkingTreeEntriesMock.mockResolvedValue([
      { path: 'src/app.ts', status: 'M' },
      { path: 'README.md', status: 'A' },
    ]);
    getFileAtRefMock.mockImplementation(async (_projectPath, _ref, filePath) => {
      if (filePath === 'src/app.ts') return 'export const value = 1;\n';
      return null;
    });

    const review = await workspaceReviewService.getCurrent(projectPath, {
      projectId: 'proj-1',
      baseBranch: 'main',
      includeContent: true,
    });

    expect(review).toEqual(expect.objectContaining({
      projectId: 'proj-1',
      branchName: 'main',
      baseBranch: 'main',
      fileCount: 2,
      totalAdditions: 5,
      totalDeletions: 1,
      reviewStatus: 'none',
      reviewSnapshotKey: null,
      snapshotKey: expect.any(String),
    }));
    expect(review.files).toEqual([
      expect.objectContaining({
        path: 'README.md',
        status: 'A',
        before: null,
        after: '# Draft\n',
      }),
      expect.objectContaining({
        path: 'src/app.ts',
        status: 'M',
        before: 'export const value = 1;\n',
        after: 'export const value = 2;\n',
      }),
    ]);
  });

  it('marks persisted workspace reviews as stale when the workspace snapshot changes after review', async () => {
    await fs.mkdir(path.join(projectPath, 'src'), { recursive: true });
    await fs.writeFile(path.join(projectPath, 'src/app.ts'), 'export const value = 2;\n');

    getWorkingTreeEntriesMock.mockResolvedValue([{ path: 'src/app.ts', status: 'M' }]);
    getFileAtRefMock.mockResolvedValue('export const value = 1;\n');

    const firstReview = await workspaceReviewService.getCurrent(projectPath, {
      projectId: 'proj-1',
      baseBranch: 'main',
      includeContent: true,
    });

    await workspaceReviewService.updateReview(projectPath, firstReview.id, {
      reviewStatus: 'reviewed',
      reviewSummary: 'Looks good',
      reviewSnapshotKey: firstReview.snapshotKey,
      reviewHeadSha: 'head-123',
      reviewedAt: '2026-04-06T10:00:00.000Z',
    });

    await fs.writeFile(path.join(projectPath, 'src/app.ts'), 'export const value = 3;\n');
    const staleReview = await workspaceReviewService.getCurrent(projectPath, {
      projectId: 'proj-1',
      baseBranch: 'main',
      includeContent: true,
    });

    expect(staleReview.reviewStatus).toBe('reviewed');
    expect(staleReview.snapshotKey).not.toBe(firstReview.snapshotKey);
    expect(staleReview.reviewActionEligibility).toEqual(expect.objectContaining({
      staleReason: 'workspace_snapshot_mismatch',
      blockedReason: expect.stringContaining('Workspace changed since the last review'),
    }));
  });

  it('rejects working-tree paths that attempt to escape the project root', async () => {
    expect(workspaceReviewService.__testing.normalizePathValue('../secrets.env')).toBe('');
    expect(workspaceReviewService.__testing.normalizePathValue('src/../../secrets.env')).toBe('');
    expect(workspaceReviewService.__testing.normalizeWorkingTreeEntry({
      path: '../outside.ts',
      status: 'M',
    })).toBeNull();
  });

  it('refuses to read workspace files outside the project root', async () => {
    const outsidePath = path.join(path.dirname(projectPath), 'outside-secret.txt');
    await fs.writeFile(outsidePath, 'top-secret\n');
    try {
      const content = await workspaceReviewService.__testing.readWorkspaceFile(projectPath, '../outside-secret.txt');
      expect(content).toBeNull();
    } finally {
      await fs.rm(outsidePath, { force: true });
    }
  });

  it('returns null when a workspace entry resolves to a directory (untracked dir)', async () => {
    // `git status` reports untracked directories as single entries (e.g. `?? .claude/`).
    // normalizePathValue strips the trailing slash, so the path resolves to a real
    // directory. readWorkspaceFile must treat this like a missing file, not crash
    // with EISDIR (which would blow up the whole workspace review endpoint).
    await fs.mkdir(path.join(projectPath, '.claude'), { recursive: true });
    const content = await workspaceReviewService.__testing.readWorkspaceFile(projectPath, '.claude');
    expect(content).toBeNull();
  });

  it('builds workspace files without crashing when an entry is an untracked directory', async () => {
    await fs.mkdir(path.join(projectPath, '.claude'), { recursive: true });
    getWorkingTreeEntriesMock.mockResolvedValue([{ path: '.claude', status: 'A' }]);
    getFileAtRefMock.mockResolvedValue(null);

    const review = await workspaceReviewService.getCurrent(projectPath, {
      projectId: 'proj-1',
      baseBranch: 'main',
      includeContent: true,
    });

    expect(review).not.toBeNull();
    expect(review.files).toEqual([
      expect.objectContaining({ path: '.claude', status: 'A', after: null }),
    ]);
  });
});
