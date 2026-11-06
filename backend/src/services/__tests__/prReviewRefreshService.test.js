import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const dbQueryMock = vi.fn();
const getProjectByIdMock = vi.fn();
const syncProjectMock = vi.fn();
const resolveGitHubMetaMock = vi.fn();

vi.mock('../../db/connection.js', () => ({
  default: {
    query: (...args) => dbQueryMock(...args),
  },
}));

vi.mock('../../db/queries.js', () => ({
  getProjectById: (...args) => getProjectByIdMock(...args),
}));

vi.mock('../prReviewSyncService.js', () => ({
  default: {
    syncProject: (...args) => syncProjectMock(...args),
  },
  resolveGitHubMeta: (...args) => resolveGitHubMetaMock(...args),
}));

import prReviewRefreshService from '../prReviewRefreshService.js';

describe('prReviewRefreshService', () => {
  const enableBackgroundRefresh = () => {
    dbQueryMock.mockResolvedValue({
      rows: [
        { id: 'pr_auto_refresh_enabled', value: 'true' },
        { id: 'pr_auto_refresh_interval', value: '30' },
      ],
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
    dbQueryMock.mockResolvedValue({
      rows: [
        { id: 'pr_auto_refresh_enabled', value: 'false' },
        { id: 'pr_auto_refresh_interval', value: 'manual' },
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    prReviewRefreshService.stopAll();
  });

  it('does not start watchers for projects without GitHub connectivity', async () => {
    getProjectByIdMock.mockResolvedValue({
      id: 'proj-1',
      user_id: 'user-1',
      path: '/tmp/repo',
    });
    resolveGitHubMetaMock.mockResolvedValue(null);

    const started = await prReviewRefreshService.startWatching('proj-1');

    expect(started).toBe(false);
    expect(prReviewRefreshService.isWatching('proj-1')).toBe(false);
    expect(syncProjectMock).not.toHaveBeenCalled();
  });

  it('does not start watchers when background PR refresh is disabled by default', async () => {
    getProjectByIdMock.mockResolvedValue({
      id: 'proj-1',
      user_id: 'user-1',
      path: '/tmp/repo',
    });
    resolveGitHubMetaMock.mockResolvedValue({
      installationId: 1,
      owner: 'atlas',
      repo: 'atlas-engine',
    });

    const started = await prReviewRefreshService.startWatching('proj-1');

    expect(started).toBe(false);
    expect(prReviewRefreshService.isWatching('proj-1')).toBe(false);
    expect(syncProjectMock).not.toHaveBeenCalled();
  });

  it('logs when startWatching skips a project without a path', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    getProjectByIdMock.mockResolvedValue({
      id: 'proj-1',
      user_id: 'user-1',
      path: null,
    });

    const started = await prReviewRefreshService.startWatching('proj-1');

    expect(started).toBe(false);
    expect(debugSpy).toHaveBeenCalledWith(
      '[prReviewRefreshService] skipping watch for project without path',
      { projectId: 'proj-1' }
    );

    debugSpy.mockRestore();
  });

  it('releases the watcher when the last active project subscriber disconnects', async () => {
    enableBackgroundRefresh();
    getProjectByIdMock.mockResolvedValue({
      id: 'proj-1',
      user_id: 'user-1',
      path: '/tmp/repo',
    });
    resolveGitHubMetaMock.mockResolvedValue({
      installationId: 1,
      owner: 'atlas',
      repo: 'atlas-engine',
    });
    syncProjectMock.mockResolvedValue({ synced: 1, deltas: [], prReviews: [] });

    expect(prReviewRefreshService.trackProject('proj-1')).toBe(1);
    expect(prReviewRefreshService.trackProject('proj-1')).toBe(2);

    const started = await prReviewRefreshService.startWatching('proj-1');

    expect(started).toBe(true);
    expect(prReviewRefreshService.isWatching('proj-1')).toBe(true);
    expect(prReviewRefreshService.releaseProject('proj-1')).toBe(1);
    expect(prReviewRefreshService.isWatching('proj-1')).toBe(true);
    expect(prReviewRefreshService.releaseProject('proj-1')).toBe(0);
    expect(prReviewRefreshService.isWatching('proj-1')).toBe(false);
  });

  it('does not reschedule a timer after stopWatching removes an in-flight watcher', async () => {
    enableBackgroundRefresh();
    vi.useFakeTimers();

    getProjectByIdMock.mockResolvedValue({
      id: 'proj-1',
      user_id: 'user-1',
      path: '/tmp/repo',
    });
    resolveGitHubMetaMock.mockResolvedValue({
      installationId: 1,
      owner: 'atlas',
      repo: 'atlas-engine',
    });

    let resolveSync;
    syncProjectMock.mockImplementation(() => new Promise((resolve) => {
      resolveSync = resolve;
    }));

    prReviewRefreshService.trackProject('proj-1');
    await prReviewRefreshService.startWatching('proj-1');
    for (let attempt = 0; attempt < 5 && !resolveSync; attempt += 1) {
      await Promise.resolve();
    }

    expect(resolveSync).toEqual(expect.any(Function));
    expect(prReviewRefreshService.getStatus('proj-1')?.inFlight).toBe(true);
    expect(prReviewRefreshService.releaseProject('proj-1')).toBe(0);
    expect(prReviewRefreshService.isWatching('proj-1')).toBe(false);

    resolveSync({ synced: 1, deltas: [], prReviews: [] });
    await vi.runAllTicks();
    await Promise.resolve();
    vi.advanceTimersByTime(60000);

    expect(syncProjectMock).toHaveBeenCalledTimes(1);
  });

  it('emits refresh-failed and stops watching when a tracked project loses its path', async () => {
    enableBackgroundRefresh();
    const refreshFailedHandler = vi.fn();

    getProjectByIdMock
      .mockResolvedValueOnce({
        id: 'proj-1',
        user_id: 'user-1',
        path: '/tmp/repo',
      })
      .mockResolvedValueOnce({
        id: 'proj-1',
        user_id: 'user-1',
        path: null,
      });
    resolveGitHubMetaMock.mockResolvedValue({
      installationId: 1,
      owner: 'atlas',
      repo: 'atlas-engine',
    });

    prReviewRefreshService.on('refresh-failed', refreshFailedHandler);
    prReviewRefreshService.trackProject('proj-1');

    await prReviewRefreshService.startWatching('proj-1');
    for (let attempt = 0; attempt < 5 && refreshFailedHandler.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }

    expect(refreshFailedHandler).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1',
      error: 'Project path not found',
    }));
    expect(prReviewRefreshService.isWatching('proj-1')).toBe(false);
    expect(syncProjectMock).not.toHaveBeenCalled();

    prReviewRefreshService.off('refresh-failed', refreshFailedHandler);
  });

  it('skips repeated auto-sync attempts after a stable repo access denial for the same connected account', async () => {
    enableBackgroundRefresh();
    vi.useFakeTimers();

    const refreshFailedHandler = vi.fn();
    const refreshStartedHandler = vi.fn();
    getProjectByIdMock.mockResolvedValue({
      id: 'proj-1',
      user_id: 'user-1',
      path: '/tmp/repo',
    });
    resolveGitHubMetaMock.mockResolvedValue({
      installationId: 1,
      owner: 'example-org-github',
      repo: 'exampleproject',
      connectedLogin: 'avinash-atlas',
    });

    const accessError = new Error('The connected GitHub account (avinash-atlas) cannot access pull requests for example-org-Github/ExampleProject.');
    accessError.code = 'GITHUB_REPO_ACCESS_DENIED';
    accessError.connectedLogin = 'avinash-atlas';
    accessError.owner = 'example-org-Github';
    accessError.repo = 'ExampleProject';
    syncProjectMock.mockRejectedValue(accessError);

    prReviewRefreshService.on('refresh-failed', refreshFailedHandler);
    prReviewRefreshService.on('refresh-started', refreshStartedHandler);
    prReviewRefreshService.trackProject('proj-1');

    await prReviewRefreshService.startWatching('proj-1');
    for (let attempt = 0; attempt < 5 && refreshFailedHandler.mock.calls.length === 0; attempt += 1) {
      await Promise.resolve();
    }

    expect(syncProjectMock).toHaveBeenCalledTimes(1);
    expect(refreshFailedHandler).toHaveBeenCalledTimes(1);
    expect(refreshStartedHandler).toHaveBeenCalledTimes(1);
    expect(prReviewRefreshService.getStatus('proj-1')?.blockedRepoAccess).toEqual({
      connectedLogin: 'avinash-atlas',
      owner: 'example-org-github',
      repo: 'exampleproject',
    });

    vi.advanceTimersByTime(30000);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await Promise.resolve();
    }

    expect(syncProjectMock).toHaveBeenCalledTimes(1);
    expect(refreshFailedHandler).toHaveBeenCalledTimes(1);
    expect(refreshStartedHandler).toHaveBeenCalledTimes(1);

    prReviewRefreshService.off('refresh-failed', refreshFailedHandler);
    prReviewRefreshService.off('refresh-started', refreshStartedHandler);
  });

  it('resumes auto-sync when the connected GitHub account changes after an access denial', async () => {
    enableBackgroundRefresh();
    vi.useFakeTimers();

    getProjectByIdMock.mockResolvedValue({
      id: 'proj-1',
      user_id: 'user-1',
      path: '/tmp/repo',
    });
    resolveGitHubMetaMock
      .mockResolvedValueOnce({
        installationId: 1,
        owner: 'example-org-github',
        repo: 'exampleproject',
        connectedLogin: 'avinash-atlas',
      })
      .mockResolvedValueOnce({
        installationId: 1,
        owner: 'example-org-github',
        repo: 'exampleproject',
        connectedLogin: 'avinash-atlas',
      })
      .mockResolvedValueOnce({
        installationId: 1,
        owner: 'example-org-github',
        repo: 'exampleproject',
        connectedLogin: 'avinashp',
      })
      .mockResolvedValue({
        installationId: 1,
        owner: 'example-org-github',
        repo: 'exampleproject',
        connectedLogin: 'avinashp',
      });

    const accessError = new Error('The connected GitHub account (avinash-atlas) cannot access pull requests for example-org-Github/ExampleProject.');
    accessError.code = 'GITHUB_REPO_ACCESS_DENIED';
    accessError.connectedLogin = 'avinash-atlas';
    accessError.owner = 'example-org-Github';
    accessError.repo = 'ExampleProject';
    syncProjectMock
      .mockRejectedValueOnce(accessError)
      .mockResolvedValueOnce({ synced: 1, deltas: [], prReviews: [] });

    prReviewRefreshService.trackProject('proj-1');
    await prReviewRefreshService.startWatching('proj-1');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await Promise.resolve();
    }

    expect(syncProjectMock).toHaveBeenCalledTimes(1);
    expect(prReviewRefreshService.getStatus('proj-1')?.blockedRepoAccess).toEqual({
      connectedLogin: 'avinash-atlas',
      owner: 'example-org-github',
      repo: 'exampleproject',
    });

    vi.advanceTimersByTime(30000);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await Promise.resolve();
    }
    expect(syncProjectMock).toHaveBeenCalledTimes(2);
    expect(prReviewRefreshService.getStatus('proj-1')?.blockedRepoAccess).toBeNull();
  });
});
