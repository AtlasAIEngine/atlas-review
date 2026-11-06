import { describe, expect, it, vi } from 'vitest';

import {
  resolvePreservedForkPointSha,
  resolveEffectiveDiffStats,
  classifyForkPointRecovery,
  computeUnreviewedScope,
} from '../branchReviewReconcileHelpers.js';

function makeGitService(overrides = {}) {
  return {
    isAncestorRef: vi.fn().mockResolvedValue(false),
    getThreeDotDiffStats: vi.fn().mockResolvedValue(null),
    getTwoDotDiffStats: vi.fn().mockResolvedValue(null),
    getCommitsBetween: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

/**
 * Helper: build an isAncestorRef mock that distinguishes the two call
 * sites (existing-vs-HEAD, existing-vs-mergeBase). The new preservation
 * rule asks both questions; tests specify each answer explicitly.
 */
function makeAncestorSpy({ ancestorOfHead = true, ancestorOfMergeBase = false } = {}) {
  return vi.fn(async (_projectPath, ancestor, descendant) => {
    // Tests pass sentinel values like 'head-new' / 'merge-new' as the
    // descendant, so we branch on that to answer each question.
    if (descendant === 'head-new' || descendant === 'HEAD') return ancestorOfHead;
    return ancestorOfMergeBase;
  });
}

describe('resolvePreservedForkPointSha', () => {
  it('keeps an existing fork when it is still an ancestor of HEAD and not older than the new merge-base', async () => {
    const gitService = makeGitService({
      isAncestorRef: makeAncestorSpy({ ancestorOfHead: true, ancestorOfMergeBase: false }),
    });
    const result = await resolvePreservedForkPointSha({
      projectPath: '/repo',
      existingForkPointSha: 'fork-X',
      nextMergeBaseSha: 'fork-X',
      nextHeadSha: 'head-new',
      gitService,
    });
    expect(result).toBe('fork-X');
  });

  it('falls back to the new merge-base when the existing fork point is no longer an ancestor of HEAD', async () => {
    const gitService = makeGitService({
      isAncestorRef: makeAncestorSpy({ ancestorOfHead: false }),
    });
    const result = await resolvePreservedForkPointSha({
      projectPath: '/repo',
      existingForkPointSha: 'fork-old',
      nextMergeBaseSha: 'merge-new',
      nextHeadSha: 'head-new',
      gitService,
    });
    expect(result).toBe('merge-new');
  });

  it('recomputes when the existing fork point is strictly older than the new merge-base (rebase onto descendant)', async () => {
    // Branch was rebased onto a newer tip of the same base — old fork
    // is still in HEAD's history via main, but it's no longer the
    // correct anchor for "this branch's work."
    const gitService = makeGitService({
      isAncestorRef: makeAncestorSpy({ ancestorOfHead: true, ancestorOfMergeBase: true }),
    });
    const result = await resolvePreservedForkPointSha({
      projectPath: '/repo',
      existingForkPointSha: 'fork-old',
      nextMergeBaseSha: 'merge-new',
      nextHeadSha: 'head-new',
      gitService,
    });
    expect(result).toBe('merge-new');
  });

  it('recomputes when the project base branch has changed (same semantics as rebase-onto-descendant)', async () => {
    // User changed project base from main to develop; new merge-base
    // is the develop/feature intersection, which happens to descend
    // from the old fork point via main's history.
    const gitService = makeGitService({
      isAncestorRef: makeAncestorSpy({ ancestorOfHead: true, ancestorOfMergeBase: true }),
    });
    const result = await resolvePreservedForkPointSha({
      projectPath: '/repo',
      existingForkPointSha: 'old-main-tip',
      nextMergeBaseSha: 'new-develop-intersection',
      nextHeadSha: 'head-new',
      gitService,
    });
    expect(result).toBe('new-develop-intersection');
  });

  it('keeps the existing fork when FF-collapse fires, even if fork looks "older than merge-base"', async () => {
    // After FF-merge, merge-base === HEAD. The "older than merge-base"
    // comparison is meaningless there — guard must fire first.
    const gitService = makeGitService({
      isAncestorRef: makeAncestorSpy({ ancestorOfHead: true, ancestorOfMergeBase: true }),
    });
    const result = await resolvePreservedForkPointSha({
      projectPath: '/repo',
      existingForkPointSha: 'fork-X',
      nextMergeBaseSha: 'head-new',
      nextHeadSha: 'head-new',
      gitService,
    });
    expect(result).toBe('fork-X');
  });

  it('returns the new merge-base when there is no existing fork point', async () => {
    const gitService = makeGitService();
    const result = await resolvePreservedForkPointSha({
      projectPath: '/repo',
      existingForkPointSha: null,
      nextMergeBaseSha: 'merge-new',
      nextHeadSha: 'head-new',
      gitService,
    });
    expect(result).toBe('merge-new');
    expect(gitService.isAncestorRef).not.toHaveBeenCalled();
  });

  it('returns null when there is no merge-base and no existing fork', async () => {
    const gitService = makeGitService();
    const result = await resolvePreservedForkPointSha({
      projectPath: '/repo',
      existingForkPointSha: null,
      nextMergeBaseSha: null,
      nextHeadSha: 'head-new',
      gitService,
    });
    expect(result).toBeNull();
  });

  it('returns null when merge-base === HEAD and there is no prior fork point', async () => {
    const gitService = makeGitService();
    const result = await resolvePreservedForkPointSha({
      projectPath: '/repo',
      existingForkPointSha: null,
      nextMergeBaseSha: 'head-new',
      nextHeadSha: 'head-new',
      gitService,
    });
    expect(result).toBeNull();
  });

  it('treats isAncestorRef rejection on the HEAD check as "not ancestor" and falls through', async () => {
    const gitService = makeGitService({
      isAncestorRef: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const result = await resolvePreservedForkPointSha({
      projectPath: '/repo',
      existingForkPointSha: 'fork-old',
      nextMergeBaseSha: 'merge-new',
      nextHeadSha: 'head-new',
      gitService,
    });
    expect(result).toBe('merge-new');
  });

  it('keeps existing fork when existing === nextMergeBase (stable branch, no shift)', async () => {
    // Fork point matches current merge-base: nothing has shifted, no
    // need to re-query ancestry against merge-base — keep the anchor.
    const gitService = makeGitService({
      isAncestorRef: makeAncestorSpy({ ancestorOfHead: true }),
    });
    const result = await resolvePreservedForkPointSha({
      projectPath: '/repo',
      existingForkPointSha: 'shared',
      nextMergeBaseSha: 'shared',
      nextHeadSha: 'head-new',
      gitService,
    });
    expect(result).toBe('shared');
  });
});

describe('resolveEffectiveDiffStats', () => {
  const base = {
    fileCount: 0,
    totalAdditions: 0,
    totalDeletions: 0,
    commitCount: 0,
    firstCommitAt: null,
    lastCommitAt: null,
    mergeBaseSha: 'head-new',
    headSha: 'head-new',
  };

  it('returns diffStats unchanged when fileCount is non-zero', async () => {
    const gitService = makeGitService();
    const diffStats = { ...base, fileCount: 4, mergeBaseSha: 'merge-X', headSha: 'head-Y' };
    const result = await resolveEffectiveDiffStats({
      projectPath: '/repo',
      branchName: 'feature',
      diffStats,
      forkPointSha: 'fork-X',
      gitService,
    });
    expect(result).toBe(diffStats);
    expect(gitService.getThreeDotDiffStats).not.toHaveBeenCalled();
  });

  it('returns original when fork point equals HEAD (no distinct anchor)', async () => {
    const gitService = makeGitService();
    const diffStats = { ...base };
    const result = await resolveEffectiveDiffStats({
      projectPath: '/repo',
      branchName: 'feature',
      diffStats,
      forkPointSha: 'head-new',
      gitService,
    });
    expect(result).toBe(diffStats);
    expect(gitService.getThreeDotDiffStats).not.toHaveBeenCalled();
  });

  it('returns original when fork point equals merge-base (retry would be identical)', async () => {
    const gitService = makeGitService();
    const diffStats = { ...base, mergeBaseSha: 'shared' };
    const result = await resolveEffectiveDiffStats({
      projectPath: '/repo',
      branchName: 'feature',
      diffStats,
      forkPointSha: 'shared',
      gitService,
    });
    expect(result).toBe(diffStats);
    expect(gitService.getThreeDotDiffStats).not.toHaveBeenCalled();
  });

  it('overlays recovered counts when fork-point diff is non-empty', async () => {
    const gitService = makeGitService({
      getThreeDotDiffStats: vi.fn().mockResolvedValue({
        fileCount: 24,
        totalAdditions: 1100,
        totalDeletions: 30,
        commitCount: 13,
        firstCommitAt: '2026-04-20T00:00:00.000Z',
        lastCommitAt: '2026-04-21T00:00:00.000Z',
      }),
    });
    const diffStats = { ...base };
    const result = await resolveEffectiveDiffStats({
      projectPath: '/repo',
      branchName: 'feature',
      diffStats,
      forkPointSha: 'fork-X',
      gitService,
    });
    expect(result).not.toBe(diffStats);
    expect(result).toMatchObject({
      fileCount: 24,
      totalAdditions: 1100,
      totalDeletions: 30,
      commitCount: 13,
      firstCommitAt: '2026-04-20T00:00:00.000Z',
      lastCommitAt: '2026-04-21T00:00:00.000Z',
      mergeBaseSha: 'head-new',
      headSha: 'head-new',
    });
  });

  it('returns original when fork-point diff is also empty', async () => {
    const gitService = makeGitService({
      getThreeDotDiffStats: vi.fn().mockResolvedValue({ fileCount: 0 }),
    });
    const diffStats = { ...base };
    const result = await resolveEffectiveDiffStats({
      projectPath: '/repo',
      branchName: 'feature',
      diffStats,
      forkPointSha: 'fork-X',
      gitService,
    });
    expect(result).toBe(diffStats);
  });

  it('returns original when gitService.getThreeDotDiffStats rejects', async () => {
    const gitService = makeGitService({
      getThreeDotDiffStats: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const diffStats = { ...base };
    const result = await resolveEffectiveDiffStats({
      projectPath: '/repo',
      branchName: 'feature',
      diffStats,
      forkPointSha: 'fork-X',
      gitService,
    });
    expect(result).toBe(diffStats);
  });

  it('returns diffStats unchanged when branchName is missing', async () => {
    const gitService = makeGitService();
    const diffStats = { ...base };
    const result = await resolveEffectiveDiffStats({
      projectPath: '/repo',
      branchName: '',
      diffStats,
      forkPointSha: 'fork-X',
      gitService,
    });
    expect(result).toBe(diffStats);
    expect(gitService.getThreeDotDiffStats).not.toHaveBeenCalled();
  });

  it('returns null/undefined diffStats unchanged', async () => {
    const gitService = makeGitService();
    const result = await resolveEffectiveDiffStats({
      projectPath: '/repo',
      branchName: 'feature',
      diffStats: null,
      forkPointSha: 'fork-X',
      gitService,
    });
    expect(result).toBeNull();
  });
});

describe('classifyForkPointRecovery', () => {
  it('returns "ok" for a normal review with distinct fork point', () => {
    expect(classifyForkPointRecovery({
      forkPointSha: 'fork-X',
      mergeBaseSha: 'fork-X',
      headSha: 'head-new',
    })).toBe('ok');
  });

  it('returns "preserved" when merge-base has collapsed to HEAD but fork point holds', () => {
    expect(classifyForkPointRecovery({
      forkPointSha: 'fork-X',
      mergeBaseSha: 'head-new',
      headSha: 'head-new',
    })).toBe('preserved');
  });

  it('returns "unrecoverable" when merge-base has collapsed to HEAD and no fork point is stored', () => {
    expect(classifyForkPointRecovery({
      forkPointSha: null,
      mergeBaseSha: 'head-new',
      headSha: 'head-new',
    })).toBe('unrecoverable');
  });

  it('returns "ok" for a legitimate empty branch (fork == merge-base == head)', () => {
    // A branch created at base with no commits: not a reflog failure,
    // just nothing unique yet.
    expect(classifyForkPointRecovery({
      forkPointSha: 'shared',
      mergeBaseSha: 'shared',
      headSha: 'shared',
    })).toBe('ok');
  });

  it('returns "ok" for a legacy row with no fork point yet but non-collapsed merge-base', () => {
    expect(classifyForkPointRecovery({
      forkPointSha: null,
      mergeBaseSha: 'merge-X',
      headSha: 'head-Y',
    })).toBe('ok');
  });
});

describe('computeUnreviewedScope', () => {
  it('returns zeros (not degraded) when there is no completed baseline yet', async () => {
    const gitService = makeGitService();
    const result = await computeUnreviewedScope({
      projectPath: '/repo',
      branchName: 'feature',
      reviewHeadSha: null,
      headSha: 'head-new',
      gitService,
    });
    expect(result).toEqual({ unreviewedFileCount: 0, unreviewedCommitCount: 0, degraded: false });
    expect(gitService.getTwoDotDiffStats).not.toHaveBeenCalled();
  });

  it('returns zeros when the last reviewed head already matches the current head', async () => {
    const gitService = makeGitService();
    const result = await computeUnreviewedScope({
      projectPath: '/repo',
      branchName: 'feature',
      reviewHeadSha: 'same-sha',
      headSha: 'same-sha',
      gitService,
    });
    expect(result).toEqual({ unreviewedFileCount: 0, unreviewedCommitCount: 0, degraded: false });
    expect(gitService.getTwoDotDiffStats).not.toHaveBeenCalled();
  });

  it('computes unreviewed file and commit counts from the reviewed_head..HEAD range', async () => {
    const gitService = makeGitService({
      getTwoDotDiffStats: vi.fn().mockResolvedValue({ fileCount: 4 }),
      getCommitsBetween: vi.fn().mockResolvedValue([
        { hash: 'c3' },
        { hash: 'c2' },
        { hash: 'c1' },
      ]),
    });
    const result = await computeUnreviewedScope({
      projectPath: '/repo',
      branchName: 'feature',
      reviewHeadSha: 'reviewed-head',
      headSha: 'head-new',
      gitService,
    });
    expect(result).toEqual({
      unreviewedFileCount: 4,
      unreviewedCommitCount: 3,
      degraded: false,
    });
    expect(gitService.getTwoDotDiffStats).toHaveBeenCalledWith('/repo', 'reviewed-head', 'head-new');
    expect(gitService.getCommitsBetween).toHaveBeenCalledWith('/repo', 'reviewed-head', 'head-new');
  });

  it('marks the result degraded when a git call rejects', async () => {
    const gitService = makeGitService({
      getTwoDotDiffStats: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const result = await computeUnreviewedScope({
      projectPath: '/repo',
      branchName: 'feature',
      reviewHeadSha: 'reviewed-head',
      headSha: 'head-new',
      gitService,
    });
    expect(result).toEqual({ unreviewedFileCount: 0, unreviewedCommitCount: 0, degraded: true });
  });

  it('returns degraded zeros when branchName is missing', async () => {
    const gitService = makeGitService();
    const result = await computeUnreviewedScope({
      projectPath: '/repo',
      branchName: '',
      reviewHeadSha: 'reviewed-head',
      headSha: 'head-new',
      gitService,
    });
    expect(result).toEqual({ unreviewedFileCount: 0, unreviewedCommitCount: 0, degraded: true });
    expect(gitService.getTwoDotDiffStats).not.toHaveBeenCalled();
  });
});
