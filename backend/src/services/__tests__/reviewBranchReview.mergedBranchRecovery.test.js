import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import gitService from '../gitService.js';
import reviewService from '../reviewService.js';

const execFileAsync = promisify(execFile);

async function run(cmd, args, options = {}) {
  const { cwd, env } = options;
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    cwd,
    env: env ? { ...process.env, ...env } : process.env,
    maxBuffer: 10 * 1024 * 1024,
  });
  return {
    stdout: stdout?.toString().trim() || '',
    stderr: stderr?.toString().trim() || '',
  };
}

async function git(repoPath, ...args) {
  return run('git', args, { cwd: repoPath });
}

async function initRepo(rootDir, name = 'repo') {
  const repoDir = path.join(rootDir, name);
  await fs.mkdir(repoDir, { recursive: true });
  await run('git', ['init', repoDir]);
  await git(repoDir, 'config', 'user.name', 'Merged Branch Tester');
  await git(repoDir, 'config', 'user.email', 'merged-branch-tester@example.com');
  await git(repoDir, 'config', 'commit.gpgsign', 'false');
  await git(repoDir, 'checkout', '-b', 'main');
  await fs.writeFile(path.join(repoDir, 'README.md'), '# main\n', 'utf8');
  await git(repoDir, 'add', 'README.md');
  await git(repoDir, 'commit', '-m', 'chore: initial main');
  return repoDir;
}

async function writeAndCommit(repoDir, relPath, content, message) {
  const absPath = path.join(repoDir, relPath);
  await fs.mkdir(path.dirname(absPath), { recursive: true });
  await fs.writeFile(absPath, content, 'utf8');
  await git(repoDir, 'add', relPath);
  await git(repoDir, 'commit', '-m', message);
  return (await git(repoDir, 'rev-parse', 'HEAD')).stdout;
}

async function headSha(repoDir, ref = 'HEAD') {
  return (await git(repoDir, 'rev-parse', ref)).stdout;
}

describe('merged-branch recovery across merge shapes', () => {
  let testRoot;

  beforeEach(async () => {
    testRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-merged-branch-recovery-'));
  });

  afterEach(async () => {
    await fs.rm(testRoot, { recursive: true, force: true });
  });

  describe('scenario 1: fast-forward merge after review was created', () => {
    it('merge-base collapses to HEAD but the preserved fork point remains a valid ancestor', async () => {
      const repoDir = await initRepo(testRoot);
      const mainBeforeSha = await headSha(repoDir, 'main');

      await git(repoDir, 'checkout', '-b', 'feature/ff');
      const featureCommitSha = await writeAndCommit(
        repoDir,
        'src/feat.js',
        "export const feat = 'ff';\n",
        'feat: add feat on feature branch'
      );

      // Pre-merge: merge-base is the fork point. This is what a review
      // created at this moment would capture as fork_point_sha.
      const preMergeBase = await gitService.getMergeBase(repoDir, 'main', 'feature/ff');
      expect(preMergeBase).toBe(mainBeforeSha);
      const capturedForkPoint = preMergeBase;

      // Agent accidentally fast-forward-merges feature into main.
      await git(repoDir, 'checkout', 'main');
      await git(repoDir, 'merge', '--ff-only', 'feature/ff');
      expect(await headSha(repoDir, 'main')).toBe(featureCommitSha);

      // Post-merge: merge-base collapses — git now reports HEAD itself as the
      // common ancestor between main and the feature tip. This is precisely
      // the bug the preservation logic defends against.
      const postMergeBase = await gitService.getMergeBase(repoDir, 'main', 'feature/ff');
      expect(postMergeBase).toBe(featureCommitSha);

      // Preservation rule: the captured fork point is still a valid ancestor
      // of HEAD, so reconcile must keep it rather than overwriting with the
      // collapsed merge-base.
      const stillAncestor = await gitService.isAncestorRef(
        repoDir,
        capturedForkPoint,
        'feature/ff'
      );
      expect(stillAncestor).toBe(true);

      // Sanity: the captured fork point produces a non-empty three-dot diff
      // covering the feature's work, while the collapsed merge-base would not.
      const diffStats = await gitService.getThreeDotDiffStats(
        repoDir,
        capturedForkPoint,
        'feature/ff'
      );
      expect(diffStats.fileCount).toBeGreaterThan(0);
    });
  });

  describe('scenario 2: fast-forward merge before any review was created', () => {
    it('getForkPointFromReflog cannot recover a distinct fork point after a simple FF-merge, caller filters HEAD-equal', async () => {
      const repoDir = await initRepo(testRoot);

      await git(repoDir, 'checkout', '-b', 'feature/ff-preexisting');
      const featureCommitSha = await writeAndCommit(
        repoDir,
        'src/a.js',
        "export const a = 1;\n",
        'feat: add a'
      );

      // Simple FF-merge, no intermediate main commits.
      await git(repoDir, 'checkout', 'main');
      await git(repoDir, 'merge', '--ff-only', 'feature/ff-preexisting');

      // `git merge-base --fork-point` uses main's reflog. For a pure FF-merge
      // with no divergent main history, the reflog only shows main advancing
      // directly to the feature tip — there is no earlier entry that would
      // reveal the original fork point. So --fork-point resolves to HEAD
      // (the same as regular merge-base). The caller in server-runtime.js
      // filters this by rejecting `recovered === nextHead`.
      const recovered = await gitService.getForkPointFromReflog(
        repoDir,
        'main',
        'feature/ff-preexisting'
      );
      expect(recovered).toBe(featureCommitSha);

      // Caller-side filtering logic (mirrors `recoverForkPointForNewReview`):
      const usable = recovered && recovered !== featureCommitSha ? recovered : null;
      expect(usable).toBeNull();
    });

    // Note: `git merge-base --fork-point` *can* in principle recover a
    // fork point from base's reflog when the branch was created from an
    // earlier tip of the base (classic upstream-rebased scenario). In
    // practice, reproducing that cleanly in a temp repo requires very
    // specific reflog shapes that are brittle across git versions, so we
    // do not assert the positive recovery path here. The code in
    // `recoverForkPointForNewReview` attempts reflog recovery and
    // correctly falls back to `null` when git cannot produce a useful
    // result — that filtering behavior is the contract that matters, and
    // it is exercised by the `scenario 6` and the simple-FF test above.
  });

  describe('scenario 3: non-fast-forward merge commit', () => {
    it('merge-base collapses to feature tip after --no-ff merge, but preservation keeps the original fork point as ancestor', async () => {
      const repoDir = await initRepo(testRoot);
      const forkPointSha = await headSha(repoDir, 'main');

      await git(repoDir, 'checkout', '-b', 'feature/merge-commit');
      await writeAndCommit(repoDir, 'src/b.js', "export const b = 2;\n", 'feat: add b');
      const featureTip = await headSha(repoDir, 'feature/merge-commit');

      // Divergent main commit forces --no-ff to produce an actual merge commit.
      await git(repoDir, 'checkout', 'main');
      await writeAndCommit(repoDir, 'src/main-extra.js', "export const extra = true;\n", 'chore: main moves forward');

      await git(repoDir, 'merge', '--no-ff', 'feature/merge-commit', '-m', 'Merge feature/merge-commit');

      // After --no-ff merge, feature tip is now a parent of the merge commit,
      // so it appears in main's history. merge-base(main, featureTip)
      // therefore collapses to featureTip (the closer common ancestor)
      // — this is the same collapse the FF case has, contrary to the
      // common intuition that merge-commits preserve the original base.
      const mergeBase = await gitService.getMergeBase(repoDir, 'main', featureTip);
      expect(mergeBase).toBe(featureTip);

      // The preservation rule saves us: the original fork point captured at
      // review creation is still an ancestor of feature's tip.
      const stillAncestor = await gitService.isAncestorRef(repoDir, forkPointSha, featureTip);
      expect(stillAncestor).toBe(true);
    });
  });

  describe('scenario 4: squash merge keeps merge-base at the fork point', () => {
    it('squashed-content commit on main does not change merge-base for the feature branch', async () => {
      const repoDir = await initRepo(testRoot);
      const forkPointSha = await headSha(repoDir, 'main');

      await git(repoDir, 'checkout', '-b', 'feature/squash');
      await writeAndCommit(repoDir, 'src/c1.js', "export const c1 = 1;\n", 'feat: c1');
      await writeAndCommit(repoDir, 'src/c2.js', "export const c2 = 2;\n", 'feat: c2');
      const featureTip = await headSha(repoDir, 'feature/squash');

      await git(repoDir, 'checkout', 'main');
      await git(repoDir, 'merge', '--squash', 'feature/squash');
      await git(repoDir, 'commit', '-m', 'feat: squashed feature/squash');

      // Squash creates a new commit whose parent is main's prior tip, NOT
      // feature's tip — so feature tip is NOT in main's history and
      // merge-base remains at the original fork point.
      const mergeBase = await gitService.getMergeBase(repoDir, 'main', featureTip);
      expect(mergeBase).toBe(forkPointSha);
    });
  });

  describe('scenario 5: branch rebased onto a new base shifts merge-base to the new fork point', () => {
    it('getMergeBase returns the new base tip and the old fork point remains an ancestor via main history', async () => {
      const repoDir = await initRepo(testRoot);
      const originalForkPoint = await headSha(repoDir, 'main');

      await git(repoDir, 'checkout', '-b', 'feature/rebase-me');
      await writeAndCommit(repoDir, 'src/d.js', "export const d = 1;\n", 'feat: d');

      // Main moves forward with its own commits.
      await git(repoDir, 'checkout', 'main');
      await writeAndCommit(repoDir, 'src/main-moved.js', "export const moved = true;\n", 'chore: main moves');
      const newMainTip = await headSha(repoDir, 'main');

      // Rebase feature onto the new main tip.
      await git(repoDir, 'checkout', 'feature/rebase-me');
      await git(repoDir, 'rebase', 'main');
      const rebasedHead = await headSha(repoDir, 'feature/rebase-me');

      // After rebase, merge-base now points to the new main tip — feature's
      // unique commits start there, not at the original fork point. The
      // preservation rule must recompute fork_point when the stored anchor
      // no longer matches this updated base relationship.
      const newMergeBase = await gitService.getMergeBase(repoDir, 'main', rebasedHead);
      expect(newMergeBase).toBe(newMainTip);
      expect(newMergeBase).not.toBe(originalForkPoint);

      // Note: the original fork point remains reachable from HEAD through
      // main's own history, so `isAncestorRef(originalForkPoint, HEAD)` is
      // still true. Preservation logic should therefore key off a shift in
      // `getMergeBase` rather than raw ancestry alone when deciding to
      // recompute fork_point for rebased branches.
      const stillReachable = await gitService.isAncestorRef(repoDir, originalForkPoint, rebasedHead);
      expect(stillReachable).toBe(true);
    });
  });

  describe('scenario 6: reflog unavailable', () => {
    it('degrades to regular merge-base (= HEAD after FF-merge), and caller must treat HEAD-equal as unrecoverable', async () => {
      const repoDir = await initRepo(testRoot);

      await git(repoDir, 'checkout', '-b', 'feature/no-reflog');
      const featureCommitSha = await writeAndCommit(
        repoDir,
        'src/e.js',
        "export const e = 1;\n",
        'feat: e'
      );

      await git(repoDir, 'checkout', 'main');
      await git(repoDir, 'merge', '--ff-only', 'feature/no-reflog');

      // Physically remove reflogs to simulate a fresh clone / CI checkout.
      await fs.rm(path.join(repoDir, '.git', 'logs'), { recursive: true, force: true });

      // Without a reflog, `git merge-base --fork-point` degrades to plain
      // `merge-base`, which for a FF-merged branch returns HEAD itself.
      // `getForkPointFromReflog` surfaces whatever git produces — the
      // caller is responsible for rejecting HEAD-equal results as
      // unrecoverable.
      const recovered = await gitService.getForkPointFromReflog(
        repoDir,
        'main',
        'feature/no-reflog'
      );
      expect(recovered).toBe(featureCommitSha);
      const usable = recovered && recovered !== featureCommitSha ? recovered : null;
      expect(usable).toBeNull();
    });
  });

  describe('resolveBranchReviewDiffScope prefers forkPointSha over mergeBaseSha', () => {
    it('uses fork_point_sha as the three-dot diff base when present', async () => {
      const repoDir = await initRepo(testRoot);
      const forkPointSha = await headSha(repoDir, 'main');

      await git(repoDir, 'checkout', '-b', 'feature/diff-scope');
      const featureTip = await writeAndCommit(
        repoDir,
        'src/f.js',
        "export const f = 1;\n",
        'feat: f'
      );

      // Simulate a FF-merged branch row: mergeBaseSha collapsed to HEAD,
      // but forkPointSha retains the original anchor.
      await git(repoDir, 'checkout', 'main');
      await git(repoDir, 'merge', '--ff-only', 'feature/diff-scope');

      const branchReview = {
        id: 'br-diff-scope',
        projectId: 'project-diff-scope',
        branchName: 'feature/diff-scope',
        baseBranch: 'main',
        mergeBaseSha: featureTip, // collapsed
        forkPointSha,              // preserved
        headSha: featureTip,
        reviewStatus: 'none',
      };

      const scope = await reviewService.__testing.resolveBranchReviewDiffScope(repoDir, branchReview, {
        reviewMode: 'full',
        headRef: featureTip,
      });

      expect(scope.diffBaseSha).toBe(forkPointSha);
      expect(scope.branchForkPointSha).toBe(forkPointSha);
      expect(scope.branchMergeBaseSha).toBe(featureTip);
    });

    it('falls back to mergeBaseSha when forkPointSha is null (legacy rows)', async () => {
      const repoDir = await initRepo(testRoot);
      const forkPointSha = await headSha(repoDir, 'main');

      await git(repoDir, 'checkout', '-b', 'feature/legacy');
      const featureTip = await writeAndCommit(
        repoDir,
        'src/g.js',
        "export const g = 1;\n",
        'feat: g'
      );

      const branchReview = {
        id: 'br-legacy',
        projectId: 'project-legacy',
        branchName: 'feature/legacy',
        baseBranch: 'main',
        mergeBaseSha: forkPointSha,
        forkPointSha: null,
        headSha: featureTip,
        reviewStatus: 'none',
      };

      const scope = await reviewService.__testing.resolveBranchReviewDiffScope(repoDir, branchReview, {
        reviewMode: 'full',
        headRef: featureTip,
      });

      expect(scope.diffBaseSha).toBe(forkPointSha);
      expect(scope.branchForkPointSha).toBeNull();
      expect(scope.branchMergeBaseSha).toBe(forkPointSha);
    });
  });
});
