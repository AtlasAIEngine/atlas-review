import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/connection.js', () => ({
  default: { query: vi.fn() },
}));

vi.mock('../gitService.js', () => ({
  default: {
    hasUncommittedChanges: vi.fn(),
    setRemoteUrl: vi.fn(),
    pull: vi.fn(),
    getCurrentSHA: vi.fn(),
    getGitInstance: vi.fn(),
    getFileAtRef: vi.fn(),
    isAncestorRef: vi.fn(),
  },
}));

vi.mock('../githubService.js', () => ({
  default: {
    getDecryptedToken: vi.fn(),
  },
}));

vi.mock('../changesetService.js', () => ({
  default: {
    getChangeSetsWithCommit: vi.fn(),
    createChangeSet: vi.fn(),
    updateChangeSetCommit: vi.fn(),
    updateChangeSetStatus: vi.fn(),
  },
}));

import db from '../../db/connection.js';
import gitService from '../gitService.js';
import githubService from '../githubService.js';
import changesetService from '../changesetService.js';
import syncWorker from '../syncWorker.js';

function installDbQueryMock({ project }) {
  db.query.mockImplementation(async (sql) => {
    if (sql.includes('FROM projects p')) {
      return { rows: [project] };
    }
    return { rows: [] };
  });
}

describe('syncWorker pull -> changeset lifecycle', () => {
  const project = {
    id: 'proj-1',
    path: '/tmp/project',
    github_sync_enabled: true,
    github_repo_owner: 'owner',
    github_repo_name: 'repo',
    github_default_branch: 'main',
    github_installation_id: 123,
    github_last_sync_sha: 'sha-old',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    syncWorker.io = null;
    syncWorker.currentJob = null;
    syncWorker.retryBackoffUntilByJobId = new Map();
    syncWorker.pullSyncCommitLocks = new Map();
    githubService.getDecryptedToken.mockResolvedValue('gh-token');
    gitService.hasUncommittedChanges.mockResolvedValue(false);
    gitService.setRemoteUrl.mockResolvedValue(true);
    gitService.pull.mockResolvedValue({ success: true });
    gitService.isAncestorRef.mockResolvedValue(false);
  });

  it('creates committed pull-sync changeset without queueing a review', async () => {
    installDbQueryMock({ project });

    gitService.getCurrentSHA
      .mockResolvedValueOnce('sha-old')
      .mockResolvedValueOnce('sha-new');

    const rawMock = vi.fn().mockResolvedValue('M\tsrc/app.js\nA\tREADME.md');
    gitService.getGitInstance.mockReturnValue({ raw: rawMock });
    gitService.getFileAtRef.mockImplementation(async (_projectPath, ref, filePath) => {
      if (ref === 'sha-old' && filePath === 'src/app.js') return 'const v = 1;\n';
      if (ref === 'sha-new' && filePath === 'src/app.js') return 'const v = 2;\n';
      if (ref === 'sha-new' && filePath === 'README.md') return '# docs\n';
      return null;
    });

    changesetService.getChangeSetsWithCommit.mockResolvedValue([]);
    changesetService.createChangeSet.mockResolvedValue({
      id: 'cs-1',
      displayId: 'CS-101',
      title: 'GitHub pull sync (sha-new)',
      files: [{ path: 'src/app.js' }, { path: 'README.md' }],
    });
    const emit = vi.fn();
    const io = { to: vi.fn(() => ({ emit })) };
    syncWorker.setIo(io);

    await syncWorker.processPullJob({
      id: 99,
      project_id: 'proj-1',
      commit_sha: 'sha-new',
      commit_message: 'Pull from GitHub',
    });

    expect(changesetService.createChangeSet).toHaveBeenCalledWith(
      '/tmp/project',
      expect.objectContaining({
        source: 'github_pull_sync',
        files: [
          { path: 'src/app.js', before: 'const v = 1;\n', after: 'const v = 2;\n' },
          { path: 'README.md', before: null, after: '# docs\n' },
        ],
      })
    );
    expect(changesetService.updateChangeSetCommit).toHaveBeenCalledWith(
      '/tmp/project',
      'cs-1',
      'sha-new',
      'Pull from GitHub'
    );
    expect(changesetService.updateChangeSetStatus).toHaveBeenCalledWith('/tmp/project', 'cs-1', 'committed');
    expect(io.to).toHaveBeenCalledWith('project-proj-1');
    expect(emit).toHaveBeenCalledWith(
      'claude-stream-event',
      expect.objectContaining({
        type: 'changeset_created',
        data: expect.objectContaining({ id: 'cs-1', source: 'github_pull_sync' }),
      })
    );

    const queueUpdateCall = db.query.mock.calls.find(
      ([sql]) => sql.includes('UPDATE github_sync_queue') && sql.includes('files_changed')
    );
    expect(queueUpdateCall).toBeTruthy();
    expect(queueUpdateCall[1][1]).toBe(JSON.stringify(['src/app.js', 'README.md']));
  });

  it('skips changeset creation when pull has no reviewable file delta', async () => {
    installDbQueryMock({ project });

    gitService.getCurrentSHA
      .mockResolvedValueOnce('sha-old')
      .mockResolvedValueOnce('sha-new');
    gitService.getGitInstance.mockReturnValue({
      raw: vi.fn().mockResolvedValue('M\tsrc/app.js'),
    });
    gitService.getFileAtRef.mockResolvedValue('same-content');

    await syncWorker.processPullJob({
      id: 100,
      project_id: 'proj-1',
      commit_sha: 'sha-new',
      commit_message: 'Pull from GitHub',
    });

    expect(changesetService.getChangeSetsWithCommit).not.toHaveBeenCalled();
    expect(changesetService.createChangeSet).not.toHaveBeenCalled();
  });

  it('deduplicates replayed pull jobs for same head SHA', async () => {
    installDbQueryMock({ project });

    gitService.getCurrentSHA
      .mockResolvedValueOnce('sha-old')
      .mockResolvedValueOnce('sha-new');
    gitService.getGitInstance.mockReturnValue({
      raw: vi.fn().mockResolvedValue('M\tsrc/app.js'),
    });
    gitService.getFileAtRef.mockImplementation(async (_projectPath, ref) => {
      if (ref === 'sha-old') return 'old';
      return 'new';
    });

    changesetService.getChangeSetsWithCommit.mockResolvedValue([
      { id: 'existing-id', displayId: 'CS-001', source: 'github_pull_sync' },
    ]);

    await syncWorker.processPullJob({
      id: 101,
      project_id: 'proj-1',
      commit_sha: 'sha-new',
      commit_message: 'Pull from GitHub',
    });

    expect(changesetService.getChangeSetsWithCommit).toHaveBeenCalledWith('/tmp/project', 'sha-new');
    expect(changesetService.createChangeSet).not.toHaveBeenCalled();
  });

  it('serializes pull-sync creation per commit to avoid duplicate changesets', async () => {
    installDbQueryMock({ project });

    gitService.getCurrentSHA.mockResolvedValue('sha-new');
    gitService.getGitInstance.mockReturnValue({
      raw: vi.fn().mockResolvedValue('M\tsrc/app.js'),
    });
    gitService.getFileAtRef.mockImplementation(async (_projectPath, ref) => {
      if (ref === 'sha-old') return 'old';
      return 'new';
    });

    let commitRecorded = false;
    changesetService.getChangeSetsWithCommit.mockImplementation(async (_projectPath, sha) => {
      if (sha === 'sha-new' && commitRecorded) {
        return [{ id: 'existing-id', displayId: 'CS-001', source: 'github_pull_sync' }];
      }
      return [];
    });
    changesetService.createChangeSet.mockResolvedValue({
      id: 'cs-1',
      displayId: 'CS-101',
      title: 'GitHub pull sync (sha-new)',
      files: [{ path: 'src/app.js' }],
    });
    changesetService.updateChangeSetCommit.mockImplementation(async () => {
      commitRecorded = true;
    });

    await Promise.all([
      syncWorker.processPullJob({
        id: 104,
        project_id: 'proj-1',
        commit_sha: 'sha-new',
        commit_message: 'Pull from GitHub',
      }),
      syncWorker.processPullJob({
        id: 105,
        project_id: 'proj-1',
        commit_sha: 'sha-new',
        commit_message: 'Pull from GitHub',
      }),
    ]);

    expect(changesetService.createChangeSet).toHaveBeenCalledTimes(1);
    expect(changesetService.updateChangeSetCommit).toHaveBeenCalledTimes(1);
  });

  it('skips superseded pull job when commit is behind last synced SHA', async () => {
    installDbQueryMock({
      project: {
        ...project,
        github_last_sync_sha: 'sha-new',
      },
    });

    gitService.isAncestorRef.mockResolvedValueOnce(true);
    const emit = vi.fn();
    syncWorker.setIo({ to: vi.fn(() => ({ emit })) });

    await syncWorker.processPullJob({
      id: 102,
      project_id: 'proj-1',
      commit_sha: 'sha-old',
      commit_message: 'Pull from GitHub',
      created_at: new Date().toISOString(),
    });

    expect(gitService.pull).not.toHaveBeenCalled();
    expect(changesetService.createChangeSet).not.toHaveBeenCalled();
    const jobUpdateCall = db.query.mock.calls.find(
      ([sql]) => sql.includes('UPDATE github_sync_queue') && sql.includes('error_message')
    );
    expect(jobUpdateCall).toBeTruthy();
    expect(String(jobUpdateCall[1][0] || '')).toContain('superseded');
    // Superseded jobs must reach terminal status — not stay stuck in 'processing'
    expect(jobUpdateCall[0]).toContain("status = 'completed'");
    expect(jobUpdateCall[0]).toContain('completed_at');
    expect(emit).toHaveBeenCalledWith(
      'sync-complete',
      expect.objectContaining({
        type: 'pull',
        lifecycle: expect.objectContaining({
          state: 'superseded',
          superseded: true,
          reason: expect.stringContaining('superseded pull job'),
        }),
      })
    );
    expect(emit).toHaveBeenCalledWith(
      'sync-lifecycle',
      expect.objectContaining({
        state: 'superseded',
      })
    );
  });

  it('requeues transient sync errors with incremented retry count', async () => {
    syncWorker.currentJob = {
      id: 500,
      project_id: 'proj-1',
      retry_count: 0,
      sync_type: 'pull',
      commit_sha: 'sha-retry',
    };
    const emit = vi.fn();
    syncWorker.setIo({ to: vi.fn(() => ({ emit })) });

    await syncWorker.handleJobError(new Error('ETIMEDOUT while pulling from GitHub'));

    const retryUpdateCall = db.query.mock.calls.find(
      ([sql]) => sql.includes("SET status = 'pending'") && sql.includes('retry_count')
    );
    expect(retryUpdateCall).toBeTruthy();
    expect(retryUpdateCall[1][0]).toBe(1);
    expect(retryUpdateCall[1][2]).toBe(500);
    expect(emit).toHaveBeenCalledWith(
      'sync-retrying',
      expect.objectContaining({
        type: 'pull',
        lifecycle: expect.objectContaining({
          state: 'retrying',
          commitSha: 'sha-retry',
          retry: expect.objectContaining({
            count: 1,
            max: expect.any(Number),
            willRetry: true,
          }),
        }),
      })
    );
    expect(emit).toHaveBeenCalledWith(
      'sync-lifecycle',
      expect.objectContaining({
        state: 'retrying',
      })
    );
  });

});
