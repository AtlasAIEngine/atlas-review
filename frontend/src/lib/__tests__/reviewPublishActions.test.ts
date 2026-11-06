import { test, expect } from '@playwright/test';
import {
  isPrReviewStale,
  getPrStaleReviewSummary,
  submitBranchComment,
  submitPrReview,
  isPrReviewStaleFromReview,
} from '../reviewPublishActions';
import type { PrPublishClient } from '../reviewPublishActions';
import type { GitHubReviewAction, ReviewActionEligibility } from '../../types';

function eligibility(overrides: Partial<ReviewActionEligibility> = {}): ReviewActionEligibility {
  return { canApprove: true, canRequestChanges: true, ...overrides };
}

test.describe('reviewPublishActions.isPrReviewStale', () => {
  test('returns true when explicit staleReason is set', () => {
    expect(isPrReviewStale(eligibility({ staleReason: 'head_mismatch' }))).toBe(true);
    expect(isPrReviewStale(eligibility({ staleReason: 'base_mismatch' }))).toBe(true);
  });

  test('falls back to the legacy blockedReason pattern', () => {
    expect(isPrReviewStale(eligibility({
      blockedReason: 'Review is stale: branch head changed after review completion.',
    }))).toBe(true);
  });

  test('returns false when no stale signal is present', () => {
    expect(isPrReviewStale(null)).toBe(false);
    expect(isPrReviewStale(undefined)).toBe(false);
    expect(isPrReviewStale(eligibility({ blockedReason: 'Re-review required.' }))).toBe(false);
  });

  test('isPrReviewStaleFromReview reads through a PrReview', () => {
    expect(isPrReviewStaleFromReview(null)).toBe(false);
    expect(isPrReviewStaleFromReview({
      reviewActionEligibility: { staleReason: 'head_mismatch' },
      // The remaining PrReview fields are irrelevant for the stale check.
    } as unknown as Parameters<typeof isPrReviewStaleFromReview>[0])).toBe(true);
  });
});

test.describe('reviewPublishActions.getPrStaleReviewSummary', () => {
  test('returns dedicated copy for each recognised staleReason', () => {
    expect(getPrStaleReviewSummary(eligibility({ staleReason: 'head_mismatch' })))
      .toBe('This review is stale because the branch head changed after the review completed.');
    expect(getPrStaleReviewSummary(eligibility({ staleReason: 'base_mismatch' })))
      .toBe('This review is stale because the base branch changed after the review completed.');
    expect(getPrStaleReviewSummary(eligibility({ staleReason: 'merge_base_mismatch' })))
      .toBe('This review is stale because the merge base changed after the review completed.');
  });

  test('rewrites legacy blockedReason when no staleReason is set', () => {
    expect(getPrStaleReviewSummary(eligibility({
      blockedReason: 'Review is stale: branch head changed after review completion.',
    }))).toBe('This review is stale because branch head changed after review completion.');
  });

  test('falls back to a generic summary when nothing else is available', () => {
    expect(getPrStaleReviewSummary(null)).toBe('This review is stale relative to the current PR snapshot.');
  });
});

test.describe('reviewPublishActions.submitBranchComment', () => {
  test('always reports the branch-has-no-PR error; branch comments are not publishable', async () => {
    const result = await submitBranchComment({
      projectId: 'proj-1',
      branchReviewId: 'br-1',
      body: 'hi',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Branch reviews cannot publish comments');
    }
  });
});

test.describe('reviewPublishActions.submitPrReview', () => {
  test('returns ok on success and forwards the decision + body to publishToGitHub', async () => {
    const calls: Array<{
      projectId: string;
      prReviewId: string;
      action: GitHubReviewAction;
      body: string | null | undefined;
    }> = [];
    const stub: PrPublishClient = {
      publishToGitHub: async (projectId, prReviewId, payload) => {
        calls.push({ projectId, prReviewId, action: payload.action, body: payload.body });
        return { success: true };
      },
    };
    const result = await submitPrReview(
      { projectId: 'p', prReviewId: 'pr', body: 'LGTM', decision: 'approve' },
      stub,
    );
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([{ projectId: 'p', prReviewId: 'pr', action: 'approve', body: 'LGTM' }]);
  });

  test('blocks empty PR comments before calling the publish API', async () => {
    let captured: { body?: string | null } = {};
    const stub: PrPublishClient = {
      publishToGitHub: async (_projectId, _prReviewId, payload) => {
        captured = payload;
        return { success: true };
      },
    };
    const result = await submitPrReview(
      { projectId: 'p', prReviewId: 'pr', body: '   ', decision: 'comment' },
      stub,
    );
    expect(result).toEqual({ ok: false, error: 'Add a comment before submitting.' });
    expect(captured.body).toBeUndefined();
  });

  test('allows empty PR approval bodies', async () => {
    let captured: { body?: string | null } = {};
    const stub: PrPublishClient = {
      publishToGitHub: async (_projectId, _prReviewId, payload) => {
        captured = payload;
        return { success: true };
      },
    };
    const result = await submitPrReview(
      { projectId: 'p', prReviewId: 'pr', body: '   ', decision: 'approve' },
      stub,
    );
    expect(result).toEqual({ ok: true });
    expect(captured.body).toBe(null);
  });

  test('returns a failure result with the error message on rejection', async () => {
    const stub: PrPublishClient = {
      publishToGitHub: async () => {
        throw new Error('403 Forbidden');
      },
    };
    const result = await submitPrReview(
      { projectId: 'p', prReviewId: 'pr', body: 'Please address the blocking issue.', decision: 'request_changes' },
      stub,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('403 Forbidden');
    }
  });

  test('falls back to a generic error message for non-Error throws', async () => {
    const stub: PrPublishClient = {
      publishToGitHub: async () => {
        // Some legacy wrappers throw plain strings or objects.
        throw 'network glitch';
      },
    };
    const result = await submitPrReview(
      { projectId: 'p', prReviewId: 'pr', body: 'hi', decision: 'comment' },
      stub,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('Failed to submit review');
    }
  });
});
