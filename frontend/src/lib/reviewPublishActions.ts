/**
 * reviewPublishActions — helpers extracted from ActionBars.tsx so the
 * Direction C `SubmitPopover` can call them without pulling in the
 * legacy render tree.
 *
 * Responsibilities:
 *   - submitBranchComment:  branch-review comment submission (disabled in
 *     UI today; branches have no PR, so the helper surfaces the
 *     documented limitation rather than hitting a non-existent endpoint).
 *   - submitPrReview:       PR-review publish (comment / approve /
 *     request_changes) via `prReviewApi.publishToGitHub`.
 *   - isPrReviewStale / getPrStaleReviewSummary: unchanged classification
 *     + summary helpers that the shell needs to surface the stale chip.
 */
import type {
  GitHubReviewAction,
  PrReview,
  ReviewActionEligibility,
} from '@/types';

/**
 * Minimal shape of `prReviewApi.publishToGitHub` the publish helper
 * needs. Exposed so unit tests can inject a stub — Playwright doesn't
 * support module-level `jest.mock`, and `api.ts` reads `import.meta.env`
 * at load time, which crashes the Node-side test runner.
 */
export interface PrPublishClient {
  publishToGitHub: (
    projectId: string,
    prReviewId: string,
    payload: { action: GitHubReviewAction; body?: string | null },
  ) => Promise<unknown>;
}

export type ReviewPublishSuccess = { ok: true };
export type ReviewPublishFailure = { ok: false; error: string };
export type ReviewPublishResult = ReviewPublishSuccess | ReviewPublishFailure;

/**
 * Branches don't publish anywhere — only PRs publish to GitHub. The
 * legacy UI blocked the Publish Comments button with a disabled-reason
 * tooltip; we keep that invariant at the helper boundary so a mis-wired
 * caller can't accidentally post into a branch context that has no
 * GitHub surface.
 */
export async function submitBranchComment(_args: {
  projectId: string;
  branchReviewId: string;
  body: string;
}): Promise<ReviewPublishResult> {
  return {
    ok: false,
    error: 'Branch reviews cannot publish comments on their own. Open or switch to a PR from this branch to comment there.',
  };
}

/**
 * PR-review publish wrapper.
 *
 * Uses `prReviewApi.publishToGitHub`, which already owns the
 * publication-state normalization and cache invalidation. We only forward
 * the minimal payload — decision + free-form body — because this is the
 * submit-popover path, not the full finding-selection dialog.
 */
export async function submitPrReview(
  {
    projectId,
    prReviewId,
    body,
    decision,
  }: {
    projectId: string;
    prReviewId: string;
    body: string;
    decision: GitHubReviewAction;
  },
  client?: PrPublishClient,
): Promise<ReviewPublishResult> {
  const trimmedBody = body.trim();
  if ((decision === 'comment' || decision === 'request_changes') && trimmedBody.length === 0) {
    return {
      ok: false,
      error: decision === 'request_changes'
        ? 'Add a summary before requesting changes.'
        : 'Add a comment before submitting.',
    };
  }

  try {
    // Lazy-load the real client so callers that only need the pure helpers
    // (e.g. unit tests on the stale/isStale surface) don't pay the cost of
    // loading `api.ts` — which touches `import.meta.env` at module scope.
    const resolvedClient = client ?? (await import('@/services/api')).prReviewApi;
    await resolvedClient.publishToGitHub(projectId, prReviewId, {
      action: decision,
      body: trimmedBody.length > 0 ? body : null,
    });
    return { ok: true };
  } catch (error: unknown) {
    const message = error instanceof Error
      ? error.message
      : 'Failed to submit review';
    return { ok: false, error: message };
  }
}

/**
 * A PR review is "stale" when the review snapshot no longer matches the
 * PR head / base / merge-base. The original ActionBars version returned
 * true both for an explicit `staleReason` and for a best-effort pattern
 * match on the legacy free-form `blockedReason`. We preserve both
 * branches so the Direction C shell can keep showing the stale pill on
 * PRs that predate the `staleReason` field.
 */
export function isPrReviewStale(
  reviewEligibility: ReviewActionEligibility | null | undefined,
): boolean {
  const staleReason = String(reviewEligibility?.staleReason || '').trim().toLowerCase();
  if (staleReason.length > 0) return true;
  return /review is stale/i.test(String(reviewEligibility?.blockedReason || ''));
}

export function getPrStaleReviewSummary(
  reviewEligibility: ReviewActionEligibility | null | undefined,
): string {
  const normalized = String(reviewEligibility?.staleReason || '').trim().toLowerCase();
  if (normalized === 'head_mismatch') {
    return 'This review is stale because the branch head changed after the review completed.';
  }
  if (normalized === 'base_mismatch') {
    return 'This review is stale because the base branch changed after the review completed.';
  }
  if (normalized === 'merge_base_mismatch') {
    return 'This review is stale because the merge base changed after the review completed.';
  }
  const blockedReason = String(reviewEligibility?.blockedReason || '').trim();
  if (blockedReason) {
    return blockedReason.replace(/^Review is stale:\s*/i, 'This review is stale because ');
  }
  return 'This review is stale relative to the current PR snapshot.';
}

/**
 * Convenience re-export: callers that only need the PrReview-level check
 * (e.g. the shell top bar) can read from the same surface the legacy
 * ActionBars used.
 */
export function isPrReviewStaleFromReview(pr: PrReview | null | undefined): boolean {
  return isPrReviewStale(pr?.reviewActionEligibility || null);
}
