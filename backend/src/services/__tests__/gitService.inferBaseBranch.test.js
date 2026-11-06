import { afterEach, describe, expect, it, vi } from 'vitest';
import gitService from '../gitService.js';

describe('gitService.inferBaseBranch', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a zero-distance preferred base instead of falling back to an older ancestor branch', async () => {
    vi.spyOn(gitService, 'getRemoteDefaultBranch').mockResolvedValue('main');
    vi.spyOn(gitService, 'listBranches').mockResolvedValue([
      { name: 'feature/PR_Analytics' },
      { name: 'feature/WindowsBuildTest' },
      { name: 'main' },
    ]);
    vi.spyOn(gitService, 'resolveBranchRef').mockImplementation(async (_projectPath, branchName) => {
      switch (branchName) {
        case 'feature/PR_Analytics':
          return 'refs/heads/feature/PR_Analytics';
        case 'feature/WindowsBuildTest':
          return 'refs/remotes/origin/feature/WindowsBuildTest';
        case 'main':
          return 'refs/remotes/origin/main';
        default:
          return null;
      }
    });

    const rawMock = vi.fn(async (args) => {
      if (args[0] === 'for-each-ref') {
        return 'origin/main\norigin/feature/WindowsBuildTest\n';
      }
      if (args[0] === 'merge-base' && args[1] === '--is-ancestor') {
        return '';
      }
      if (args[0] === 'rev-list' && args[1] === '--count') {
        if (args[2] === 'refs/remotes/origin/main..refs/heads/feature/PR_Analytics') {
          return '0\n';
        }
        if (args[2] === 'refs/remotes/origin/feature/WindowsBuildTest..refs/heads/feature/PR_Analytics') {
          return '8\n';
        }
      }
      throw new Error(`Unexpected git.raw call: ${args.join(' ')}`);
    });

    vi.spyOn(gitService, 'getGitInstance').mockReturnValue({ raw: rawMock });

    const inferred = await gitService.inferBaseBranch('/tmp/project', 'feature/PR_Analytics', {
      preferredBaseBranch: 'main',
    });

    expect(inferred).toBe('main');
  });
});

describe('gitService.getDiffForWalkthrough', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps deleted files in the manifest while omitting deleted patch bodies by default', async () => {
    vi.spyOn(gitService, 'getTwoDotDiffStats').mockResolvedValue({
      files: [
        { path: 'src/live.ts', additions: 2, deletions: 1 },
        { path: 'Assets/Obsolete.asset', additions: 0, deletions: 7000 },
      ],
      totalAdditions: 2,
      totalDeletions: 7001,
      fileCount: 2,
      commitCount: 1,
      firstCommitAt: null,
      lastCommitAt: null,
    });
    vi.spyOn(gitService, 'getTwoDotDiffNameStatus').mockResolvedValue([
      { status: 'M', path: 'src/live.ts' },
      { status: 'D', path: 'Assets/Obsolete.asset' },
    ]);
    vi.spyOn(gitService, 'runGitCommandWithOutputLimit').mockResolvedValue({
      output: 'diff --git a/src/live.ts b/src/live.ts\n',
      truncated: false,
    });

    const result = await gitService.getDiffForWalkthrough('/tmp/project', 'base', 'head');

    expect(gitService.runGitCommandWithOutputLimit).toHaveBeenCalledWith(
      '/tmp/project',
      expect.arrayContaining(['--diff-filter=ACMRTUXB']),
      expect.any(Object),
    );
    expect(result.fileSummaries).toEqual([
      { path: 'src/live.ts', additions: 2, deletions: 1, status: 'M' },
      { path: 'Assets/Obsolete.asset', additions: 0, deletions: 7000, status: 'D' },
    ]);
    expect(result.diff).not.toContain('Assets/Obsolete.asset');
  });

  it('can include deleted patch bodies when explicitly requested', async () => {
    vi.spyOn(gitService, 'getTwoDotDiffStats').mockResolvedValue({
      files: [{ path: 'src/deleted.ts', additions: 0, deletions: 3 }],
      totalAdditions: 0,
      totalDeletions: 3,
      fileCount: 1,
      commitCount: 1,
      firstCommitAt: null,
      lastCommitAt: null,
    });
    vi.spyOn(gitService, 'getTwoDotDiffNameStatus').mockResolvedValue([
      { status: 'D', path: 'src/deleted.ts' },
    ]);
    vi.spyOn(gitService, 'runGitCommandWithOutputLimit').mockResolvedValue({
      output: 'diff --git a/src/deleted.ts b/src/deleted.ts\n',
      truncated: false,
    });

    await gitService.getDiffForWalkthrough('/tmp/project', 'base', 'head', {
      omitDeletedFileBodies: false,
    });

    expect(gitService.runGitCommandWithOutputLimit).toHaveBeenCalledWith(
      '/tmp/project',
      expect.not.arrayContaining(['--diff-filter=ACMRTUXB']),
      expect.any(Object),
    );
  });
});
