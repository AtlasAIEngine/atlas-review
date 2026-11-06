/**
 * Shared fork-point reconciliation helpers for branch reviews.
 *
 * Consolidates the logic that was previously duplicated across
 * `routes/branchReviews.js::resolveReconciledForkPointSha`,
 * `server-runtime.js::resolveWatcherForkPointSha`,
 * `server-runtime.js::resolveWatcherEffectiveStats`, and inline
 * fork-point-fallback blocks in the retire-previous and worktree-removed
 * handlers.
 *
 * Kept as pure functions with `gitService` injected so they can be
 * unit-tested without global module state and reused from any
 * reconcile-adjacent code path.
 *
 * Semantics reference: v0.58.0-merged-branch-review-recovery.
 */

function normalizeSha(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Resolve the `fork_point_sha` value to persist for a reconciled branch
 * review.
 *
 * Rules:
 *  - If an existing fork point is set AND still an ancestor of HEAD,
 *    preserve it. This keeps the historical anchor stable across normal
 *    commits, merge commits, and squash merges, and specifically
 *    survives the fast-forward-merge collapse (merge-base == HEAD).
 *  - If the existing fork point is no longer an ancestor of HEAD (true
 *    rebase onto a different base), fall through to compute a new value.
 *  - If merge-base equals HEAD (FF-collapse), never accept it as the
 *    fork point — keep whatever was already stored.
 *  - Otherwise, return the new merge-base.
 *
 * @param {Object} args
 * @param {string} args.projectPath
 * @param {string|null} args.existingForkPointSha
 * @param {string|null} args.nextMergeBaseSha
 * @param {string|null} args.nextHeadSha
 * @param {{ isAncestorRef: Function }} args.gitService
 * @returns {Promise<string|null>}
 */
export async function resolvePreservedForkPointSha({
  projectPath,
  existingForkPointSha,
  nextMergeBaseSha,
  nextHeadSha,
  gitService,
}) {
  const existing = normalizeSha(existingForkPointSha);
  const nextMergeBase = normalizeSha(nextMergeBaseSha);
  const nextHead = normalizeSha(nextHeadSha);

  if (existing) {
    const stillAncestor = await gitService
      .isAncestorRef(projectPath, existing, nextHead || 'HEAD')
      .catch(() => false);
    if (!stillAncestor) {
      // Existing fork point is no longer in HEAD's history — rebase onto
      // a disjoint base. Fall through to pick up the new anchor.
    } else {
      // The stored fork is an ancestor of HEAD, but that alone isn't
      // enough to trust it. After a rebase onto a newer tip of the same
      // base, or a project-wide base-branch change, the stored fork can
      // sit far behind the new merge-base — treat that as stale unless
      // we're in the FF-collapse case (where the merge-base comparison
      // is meaningless).
      const isFfCollapse = Boolean(nextMergeBase && nextHead && nextMergeBase === nextHead);
      if (isFfCollapse) {
        return existing;
      }
      if (!nextMergeBase || existing === nextMergeBase) {
        return existing;
      }
      const forkIsBehindMergeBase = await gitService
        .isAncestorRef(projectPath, existing, nextMergeBase)
        .catch(() => false);
      if (!forkIsBehindMergeBase) {
        // Fork is not older than the new merge-base (sibling or
        // descendant): the stored anchor still represents the branch's
        // real divergence point. Keep it.
        return existing;
      }
      // Fork is strictly older than the new merge-base — the branch has
      // advanced (rebase / base-change) and the stored anchor is stale.
      // Fall through and recompute.
    }
  }

  if (!nextMergeBase) {
    return existing || null;
  }

  if (nextHead && nextMergeBase === nextHead) {
    // FF-collapse guard: merge-base(base, HEAD) === HEAD means the branch
    // has been absorbed into base. Storing this as fork_point would
    // defeat the whole point — keep whatever existed before.
    return existing || null;
  }

  return nextMergeBase;
}

/**
 * Overlay fork-point-recovered diff counts onto `diffStats` when the
 * merge-base diff has collapsed to zero but the preserved fork point is
 * a distinct anchor that still has reviewable work.
 *
 * Returns the original `diffStats` unchanged in every other case. The
 * overlay only touches file/commit counters — it preserves
 * `diffStats.mergeBaseSha` and `diffStats.headSha` so callers can still
 * record the live refs.
 *
 * @param {Object} args
 * @param {string} args.projectPath
 * @param {string} args.branchName
 * @param {Object|null|undefined} args.diffStats
 * @param {string|null} args.forkPointSha
 * @param {{ getThreeDotDiffStats: Function }} args.gitService
 * @returns {Promise<Object|null|undefined>}
 */
export async function resolveEffectiveDiffStats({
  projectPath,
  branchName,
  diffStats,
  forkPointSha,
  gitService,
}) {
  if (!diffStats) return diffStats;
  if (Number(diffStats.fileCount || 0) !== 0) return diffStats;

  const fork = normalizeSha(forkPointSha);
  if (!fork || !branchName) return diffStats;
  if (fork === normalizeSha(diffStats.headSha)) return diffStats;
  if (fork === normalizeSha(diffStats.mergeBaseSha)) return diffStats;

  const forkStats = await gitService
    .getThreeDotDiffStats(projectPath, fork, branchName)
    .catch(() => null);
  if (!forkStats || Number(forkStats.fileCount || 0) === 0) return diffStats;

  return {
    ...diffStats,
    fileCount: forkStats.fileCount,
    totalAdditions: forkStats.totalAdditions,
    totalDeletions: forkStats.totalDeletions,
    commitCount: forkStats.commitCount,
    firstCommitAt: forkStats.firstCommitAt,
    lastCommitAt: forkStats.lastCommitAt,
  };
}

/**
 * Classify the branch review's fork-point recovery state for UI display.
 *
 *  - `'ok'`           — normal review where the branch has distinct work
 *                       and the fork point anchors it cleanly.
 *  - `'preserved'`    — branch was merged into base (merge-base == HEAD)
 *                       but the stored fork point is holding the
 *                       historical anchor. This is the v0.58.0 win path.
 *  - `'unrecoverable'` — branch appears merged into base (merge-base ==
 *                       HEAD) AND no fork point was recovered from the
 *                       reflog. UI should surface a hint explaining the
 *                       empty counts.
 *
 * A legitimate empty branch (fork_point === merge_base === head, i.e.
 * "created at base with no commits") classifies as `'ok'` rather than
 * `'unrecoverable'` — it's not a reflog failure, just a no-work branch.
 *
 * @param {Object} args
 * @param {string|null} args.forkPointSha
 * @param {string|null} args.mergeBaseSha
 * @param {string|null} args.headSha
 * @returns {'ok'|'preserved'|'unrecoverable'}
 */
export function classifyForkPointRecovery({ forkPointSha, mergeBaseSha, headSha }) {
  const fork = normalizeSha(forkPointSha);
  const mergeBase = normalizeSha(mergeBaseSha);
  const head = normalizeSha(headSha);

  const mergedIntoBase = Boolean(mergeBase && head && mergeBase === head);

  if (mergedIntoBase && !fork) {
    return 'unrecoverable';
  }
  if (mergedIntoBase && fork && fork !== head) {
    return 'preserved';
  }
  return 'ok';
}

/**
 * Compute "unreviewed scope" — the files and commits between the last
 * completed review's head and the branch's current HEAD. This is what
 * the next incremental review would actually touch; surfacing it in
 * the UI resolves the common "why did Atlas skip file X?" confusion
 * when the branch card shows a much larger full-branch total.
 *
 * Returns `{ unreviewedFileCount, unreviewedCommitCount, degraded }`.
 * `degraded: true` signals the git calls failed and the zero counts
 * should not be trusted — the UI can fall back to hiding the hint.
 *
 * @param {Object} args
 * @param {string} args.projectPath
 * @param {string} args.branchName
 * @param {string|null} args.reviewHeadSha  Last completed review's head.
 * @param {string|null} args.headSha        Current branch tip.
 * @param {{ getTwoDotDiffStats: Function, getCommitsBetween: Function }} args.gitService
 * @returns {Promise<{ unreviewedFileCount: number, unreviewedCommitCount: number, degraded: boolean }>}
 */
export async function computeUnreviewedScope({
  projectPath,
  branchName,
  reviewHeadSha,
  headSha,
  gitService,
}) {
  const reviewed = normalizeSha(reviewHeadSha);
  const head = normalizeSha(headSha);
  if (!reviewed || !head) {
    return { unreviewedFileCount: 0, unreviewedCommitCount: 0, degraded: false };
  }
  if (reviewed === head) {
    return { unreviewedFileCount: 0, unreviewedCommitCount: 0, degraded: false };
  }
  if (!projectPath || !branchName) {
    return { unreviewedFileCount: 0, unreviewedCommitCount: 0, degraded: true };
  }

  try {
    const [stats, commits] = await Promise.all([
      gitService.getTwoDotDiffStats(projectPath, reviewed, head),
      gitService.getCommitsBetween(projectPath, reviewed, head),
    ]);
    return {
      unreviewedFileCount: Number(stats?.fileCount || 0),
      unreviewedCommitCount: Array.isArray(commits) ? commits.length : 0,
      degraded: false,
    };
  } catch {
    return { unreviewedFileCount: 0, unreviewedCommitCount: 0, degraded: true };
  }
}

export default {
  resolvePreservedForkPointSha,
  resolveEffectiveDiffStats,
  classifyForkPointRecovery,
  computeUnreviewedScope,
};
