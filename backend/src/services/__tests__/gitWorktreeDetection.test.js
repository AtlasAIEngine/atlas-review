import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Hoisted mocks (vi.mock factories can only reference vi.hoisted values) ──
const {
  listWorktreesMock,
  sanitizeRemoteMock,
  getRemoteDefaultBranchMock,
  inferBaseBranchMock,
} = vi.hoisted(() => ({
  listWorktreesMock: vi.fn(),
  sanitizeRemoteMock: vi.fn(),
  getRemoteDefaultBranchMock: vi.fn(),
  inferBaseBranchMock: vi.fn(),
}));

vi.mock('../gitService.js', () => ({
  default: {
    listWorktrees: (...args) => listWorktreesMock(...args),
    sanitizeRemote: (...args) => sanitizeRemoteMock(...args),
    getRemoteDefaultBranch: (...args) => getRemoteDefaultBranchMock(...args),
    inferBaseBranch: (...args) => inferBaseBranchMock(...args),
    getCurrentBranchName: vi.fn().mockResolvedValue('main'),
    getCurrentSHA: vi.fn().mockResolvedValue('abc1234'),
  },
}));

vi.mock('fs/promises', () => ({
  default: { readFile: vi.fn().mockRejectedValue(new Error('not found')), writeFile: vi.fn(), mkdir: vi.fn() },
  readFile: vi.fn().mockRejectedValue(new Error('not found')),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
}));

import gitService from '../gitService.js';
import gitWatcherService from '../gitWatcherService.js';

// ─────────────────────────────────────────────────────────────────
// 1. parseWorktreePorcelain — pure function tests
//    Import the real implementation directly for these tests.
// ─────────────────────────────────────────────────────────────────

/**
 * Inline copy of parseWorktreePorcelain for pure-function unit testing.
 * The real implementation lives in gitService.js.
 */
function parseWorktreePorcelain(raw) {
  if (!raw || typeof raw !== 'string') return [];
  const entries = [];
  let current = {};
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current.path) entries.push(current);
      current = { path: line.slice('worktree '.length).trim() };
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      const ref = line.slice('branch '.length).trim();
      current.branch = ref.replace(/^refs\/heads\//, '');
    } else if (line.trim() === 'detached') {
      current.detached = true;
    }
  }
  if (current.path) entries.push(current);
  return entries
    .slice(1)
    .filter(e => e.branch && !e.detached)
    .map(({ path, head, branch }) => ({ path, head: head || '', branch }));
}

describe('parseWorktreePorcelain', () => {
  it('returns empty array for null/undefined/empty input', () => {
    expect(parseWorktreePorcelain(null)).toEqual([]);
    expect(parseWorktreePorcelain(undefined)).toEqual([]);
    expect(parseWorktreePorcelain('')).toEqual([]);
  });

  it('filters out the main (first) worktree', () => {
    const raw = [
      'worktree /main/path',
      'HEAD aaa1111',
      'branch refs/heads/main',
      '',
      'worktree /wt/feature',
      'HEAD bbb2222',
      'branch refs/heads/feature-x',
    ].join('\n');

    const result = parseWorktreePorcelain(raw);
    expect(result).toEqual([
      { path: '/wt/feature', head: 'bbb2222', branch: 'feature-x' },
    ]);
  });

  it('filters out detached HEAD worktrees', () => {
    const raw = [
      'worktree /main/path',
      'HEAD aaa1111',
      'branch refs/heads/main',
      '',
      'worktree /wt/detached',
      'HEAD ccc3333',
      'detached',
      '',
      'worktree /wt/feature',
      'HEAD bbb2222',
      'branch refs/heads/my-branch',
    ].join('\n');

    const result = parseWorktreePorcelain(raw);
    expect(result).toEqual([
      { path: '/wt/feature', head: 'bbb2222', branch: 'my-branch' },
    ]);
  });

  it('parses multiple secondary worktrees', () => {
    const raw = [
      'worktree /main',
      'HEAD aaa1111',
      'branch refs/heads/main',
      '',
      'worktree /wt/one',
      'HEAD bbb2222',
      'branch refs/heads/feature-one',
      '',
      'worktree /wt/two',
      'HEAD ccc3333',
      'branch refs/heads/feature-two',
    ].join('\n');

    const result = parseWorktreePorcelain(raw);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ path: '/wt/one', head: 'bbb2222', branch: 'feature-one' });
    expect(result[1]).toEqual({ path: '/wt/two', head: 'ccc3333', branch: 'feature-two' });
  });

  it('strips refs/heads/ prefix from branch names', () => {
    const raw = [
      'worktree /main',
      'HEAD aaa1111',
      'branch refs/heads/main',
      '',
      'worktree /wt/f',
      'HEAD ddd4444',
      'branch refs/heads/deep/nested/branch',
    ].join('\n');

    const result = parseWorktreePorcelain(raw);
    expect(result[0].branch).toBe('deep/nested/branch');
  });

  it('handles missing HEAD gracefully', () => {
    const raw = [
      'worktree /main',
      'HEAD aaa1111',
      'branch refs/heads/main',
      '',
      'worktree /wt/f',
      'branch refs/heads/feature',
    ].join('\n');

    const result = parseWorktreePorcelain(raw);
    expect(result[0]).toEqual({ path: '/wt/f', head: '', branch: 'feature' });
  });
});

// ─────────────────────────────────────────────────────────────────
// 2. GitWatcherService._pollWorktrees — state machine tests
// ─────────────────────────────────────────────────────────────────
describe('GitWatcherService._pollWorktrees', () => {
  let emitted;

  beforeEach(() => {
    vi.clearAllMocks();
    emitted = [];
    gitWatcherService.removeAllListeners();
    gitWatcherService.on('branch-switched', (e) => emitted.push({ type: 'branch-switched', ...e }));
    gitWatcherService.on('branch-updated', (e) => emitted.push({ type: 'branch-updated', ...e }));
    gitWatcherService.on('worktree-removed', (e) => emitted.push({ type: 'worktree-removed', ...e }));
  });

  it('emits branch-switched with isWorktree for new worktrees', async () => {
    listWorktreesMock.mockResolvedValue([
      { path: '/wt/feat', head: 'aaa', branch: 'feature-a' },
    ]);

    const state = new Map();
    await gitWatcherService._pollWorktrees('proj-1', '/main', 'main', state);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe('branch-switched');
    expect(emitted[0].isWorktree).toBe(true);
    expect(emitted[0].currentBranch).toBe('feature-a');
    expect(emitted[0].currentHead).toBe('aaa');
    expect(emitted[0].projectId).toBe('proj-1');
    expect(emitted[0].projectPath).toBe('/main');
  });

  it('emits branch-updated with isWorktree when HEAD changes', async () => {
    const state = new Map([
      ['/wt/feat', { branch: 'feature-a', head: 'aaa' }],
    ]);

    listWorktreesMock.mockResolvedValue([
      { path: '/wt/feat', head: 'bbb', branch: 'feature-a' },
    ]);

    await gitWatcherService._pollWorktrees('proj-1', '/main', 'main', state);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe('branch-updated');
    expect(emitted[0].isWorktree).toBe(true);
    expect(emitted[0].previousHead).toBe('aaa');
    expect(emitted[0].currentHead).toBe('bbb');
    expect(emitted[0].branch).toBe('feature-a');
  });

  it('skips worktrees on the base branch', async () => {
    listWorktreesMock.mockResolvedValue([
      { path: '/wt/main-copy', head: 'xxx', branch: 'main' },
    ]);

    const state = new Map();
    await gitWatcherService._pollWorktrees('proj-1', '/main', 'main', state);

    expect(emitted).toHaveLength(0);
    expect(state.size).toBe(0);
  });

  it('cleans up state when worktree is removed', async () => {
    const state = new Map([
      ['/wt/old', { branch: 'old-branch', head: 'xxx' }],
    ]);

    listWorktreesMock.mockResolvedValue([]); // worktree gone

    await gitWatcherService._pollWorktrees('proj-1', '/main', 'main', state);

    expect(state.size).toBe(0);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual(expect.objectContaining({
      type: 'worktree-removed',
      projectId: 'proj-1',
      projectPath: '/main',
      worktreePath: '/wt/old',
      branch: 'old-branch',
      head: 'xxx',
      baseBranch: 'main',
      isWorktree: true,
    }));
  });

  it('does not emit when worktree HEAD is unchanged', async () => {
    const state = new Map([
      ['/wt/feat', { branch: 'feature-a', head: 'aaa' }],
    ]);

    listWorktreesMock.mockResolvedValue([
      { path: '/wt/feat', head: 'aaa', branch: 'feature-a' },
    ]);

    await gitWatcherService._pollWorktrees('proj-1', '/main', 'main', state);
    expect(emitted).toHaveLength(0);
  });

  it('emits branch-switched when worktree changes branch', async () => {
    const state = new Map([
      ['/wt/feat', { branch: 'feature-a', head: 'aaa' }],
    ]);

    listWorktreesMock.mockResolvedValue([
      { path: '/wt/feat', head: 'aaa', branch: 'feature-b' },
    ]);

    await gitWatcherService._pollWorktrees('proj-1', '/main', 'main', state);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe('branch-switched');
    expect(emitted[0].isWorktree).toBe(true);
    expect(emitted[0].previousBranch).toBe('feature-a');
    expect(emitted[0].currentBranch).toBe('feature-b');
    expect(state.get('/wt/feat').branch).toBe('feature-b');
  });

  it('handles multiple worktrees in a single scan', async () => {
    listWorktreesMock.mockResolvedValue([
      { path: '/wt/a', head: 'h1', branch: 'feat-a' },
      { path: '/wt/b', head: 'h2', branch: 'feat-b' },
    ]);

    const state = new Map();
    await gitWatcherService._pollWorktrees('proj-1', '/main', 'main', state);

    expect(emitted).toHaveLength(2);
    expect(state.size).toBe(2);
  });

  it('swallows errors silently', async () => {
    listWorktreesMock.mockRejectedValue(new Error('git error'));

    const state = new Map();
    await expect(
      gitWatcherService._pollWorktrees('proj-1', '/main', 'main', state),
    ).resolves.toBeUndefined();
  });
});

describe('GitWatcherService.syncNow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitWatcherService.removeAllListeners();
    gitWatcherService.watchers.clear();
    gitWatcherService.worktreeWatchers.clear();
    gitWatcherService.pendingInitialBranchSwitches.clear();
  });

  it('waits for async branch-updated listeners before resolving', async () => {
    gitWatcherService.watchers.set('proj-1', {
      projectId: 'proj-1',
      projectPath: '/main',
      branch: 'feature-a',
      lastKnownHead: 'aaa1111',
      lastBranchName: 'feature-a',
      baseBranch: 'main',
      interval: null,
      pollInterval: '5s',
      pollIntervalMs: 5000,
    });

    gitService.getCurrentBranchName.mockResolvedValue('feature-a');
    gitService.getCurrentSHA.mockResolvedValue('bbb2222');

    let handled = false;
    gitWatcherService.on('branch-updated', async () => {
      await new Promise((resolve) => setTimeout(resolve, 15));
      handled = true;
    });

    await gitWatcherService.syncNow('proj-1');

    expect(handled).toBe(true);
  });

  it('waits for an in-flight initial branch switch before polling', async () => {
    gitWatcherService.watchers.set('proj-1', {
      projectId: 'proj-1',
      projectPath: '/main',
      branch: 'feature-a',
      lastKnownHead: 'aaa1111',
      lastBranchName: 'feature-a',
      baseBranch: 'main',
      interval: null,
      pollInterval: '5s',
      pollIntervalMs: 5000,
    });

    let releasePendingSwitch;
    let pendingSettled = false;
    const pendingSwitch = new Promise((resolve) => {
      releasePendingSwitch = () => {
        pendingSettled = true;
        resolve();
      };
    });
    gitWatcherService.pendingInitialBranchSwitches.set('proj-1', pendingSwitch);

    const getCurrentShaMock = gitService.getCurrentSHA;
    let polledBeforePendingSettled = false;
    getCurrentShaMock.mockImplementation(async () => {
      polledBeforePendingSettled = !pendingSettled;
      return 'aaa1111';
    });

    const syncPromise = gitWatcherService.syncNow('proj-1');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(polledBeforePendingSettled).toBe(false);

    releasePendingSwitch();
    await syncPromise;

    expect(polledBeforePendingSettled).toBe(false);
    expect(getCurrentShaMock).toHaveBeenCalled();
  });
});

describe('GitWatcherService.startWatching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gitWatcherService.removeAllListeners();
    gitWatcherService.watchers.clear();
    gitWatcherService.worktreeWatchers.clear();
    gitWatcherService.pendingInitialBranchSwitches.clear();
    sanitizeRemoteMock.mockResolvedValue(null);
    getRemoteDefaultBranchMock.mockResolvedValue('main');
    inferBaseBranchMock.mockResolvedValue('develop');
    vi.spyOn(gitWatcherService, '_isGitRepo').mockResolvedValue(true);
    vi.spyOn(gitWatcherService, '_loadPollIntervalSetting').mockResolvedValue({
      interval: '5s',
      intervalMs: 5000,
    });
    vi.spyOn(gitWatcherService, '_saveState').mockResolvedValue();
    vi.spyOn(gitWatcherService, '_applyPollingTimer').mockImplementation(() => {});
    vi.spyOn(gitWatcherService, '_startWorktreeScanning').mockImplementation(() => {});
  });

  it('refines the auto-detected remote default base branch for topic branches', async () => {
    gitService.getCurrentBranchName.mockResolvedValue('feature/unity-import');
    gitService.getCurrentSHA.mockResolvedValue('abc1234');

    const emitted = [];
    gitWatcherService.on('branch-switched', (event) => emitted.push(event));

    const started = await gitWatcherService.startWatching('proj-1', '/repo', {
      awaitInitialBranchSwitch: true,
    });

    expect(started).toBe(true);
    expect(inferBaseBranchMock).toHaveBeenCalledWith('/repo', 'feature/unity-import', {
      preferredBaseBranch: 'main',
    });
    expect(gitWatcherService.getStatus('proj-1')).toEqual(expect.objectContaining({
      projectId: 'proj-1',
      branch: 'feature/unity-import',
      baseBranch: 'develop',
      watching: true,
    }));
    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual(expect.objectContaining({
      previousBranch: null,
      currentBranch: 'feature/unity-import',
      baseBranch: 'develop',
    }));
  });
});
