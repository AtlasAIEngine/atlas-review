import { describe, it, expect } from 'vitest';
import {
  buildReviewLifecycle,
  buildQueueLifecycle,
  buildReviewActionEligibility,
  deriveReviewStaleReason,
  mapLegacyReviewStatusToLifecycleStatus,
  normalizeLifecycleStatus,
} from '../reviewLifecycle.js';

describe('reviewLifecycle canonical contract', () => {
  it('maps legacy review status values to canonical lifecycle status values', () => {
    const cases = [
      ['none', 'completed'],
      ['queued', 'queued'],
      ['reviewing', 'running'],
      ['reviewed', 'completed'],
      ['failed', 'failed'],
    ];

    for (const [input, expected] of cases) {
      expect(mapLegacyReviewStatusToLifecycleStatus(input)).toBe(expected);
    }
  });

  it('normalizes lifecycle snapshot status to canonical vocabulary', () => {
    const cases = [
      ['running', 'running'],
      ['reviewing', 'running'],
      ['reviewed', 'completed'],
      ['failed', 'failed'],
      ['bogus', 'queued'],
    ];

    for (const [input, expected] of cases) {
      expect(normalizeLifecycleStatus(input)).toBe(expected);
    }
  });

  it('builds canonical lifecycle snapshots for legacy and canonical inputs', () => {
    const cases = [
      {
        label: 'legacy reviewing with chunk progress',
        input: {
          reviewStatus: 'reviewing',
          progress: {
            phase: 'chunk_inflight',
            updatedAt: '2026-02-21T10:00:00.000Z',
          },
          updatedAt: '2026-02-21T10:00:00.000Z',
          sourceStatus: 'reviewing',
        },
        expected: {
          status: 'running',
          phase: 'chunk_inflight',
          isActive: true,
          isTerminal: false,
          canRetry: false,
          error: null,
          sourceStatus: 'reviewing',
        },
      },
      {
        label: 'canonical retrying status',
        input: {
          reviewStatus: 'retrying',
          progress: {
            phase: 'provider_retry',
            updatedAt: '2026-02-21T10:02:00.000Z',
          },
          updatedAt: '2026-02-21T10:02:00.000Z',
          sourceStatus: 'retrying',
        },
        expected: {
          status: 'retrying',
          phase: 'provider_retry',
          isActive: true,
          isTerminal: false,
          canRetry: false,
          error: null,
          sourceStatus: 'retrying',
        },
      },
      {
        label: 'reviewed with persisted reason metadata',
        input: {
          reviewStatus: 'reviewed',
          errorMessage: 'Partial review: 3/5 chunks analyzed before timeout',
          reviewedAt: '2026-02-21T10:05:00.000Z',
          updatedAt: '2026-02-21T10:05:00.000Z',
          sourceStatus: 'reviewed',
        },
        expected: {
          status: 'partial',
          phase: 'partial',
          isActive: false,
          isTerminal: true,
          canRetry: true,
          error: 'Partial review: 3/5 chunks analyzed before timeout',
          sourceStatus: 'reviewed',
        },
      },
      {
        label: 'canonical completed without errors',
        input: {
          reviewStatus: 'completed',
          reviewedAt: '2026-02-21T10:06:00.000Z',
          updatedAt: '2026-02-21T10:06:00.000Z',
          sourceStatus: 'completed',
        },
        expected: {
          status: 'completed',
          phase: 'complete',
          isActive: false,
          isTerminal: true,
          canRetry: true,
          error: null,
          sourceStatus: 'completed',
        },
      },
      {
        label: 'failed lifecycle remains inactive even with active-looking progress phase',
        input: {
          reviewStatus: 'failed',
          progress: {
            phase: 'file_review_failed',
            updatedAt: '2026-02-21T10:07:00.000Z',
          },
          errorMessage: 'Claude CLI-agentic timed out after 600 seconds',
          updatedAt: '2026-02-21T10:07:00.000Z',
          sourceStatus: 'failed',
        },
        expected: {
          status: 'failed',
          phase: 'file_review_failed',
          isActive: false,
          isTerminal: true,
          canRetry: true,
          error: 'Claude CLI-agentic timed out after 600 seconds',
          sourceStatus: 'failed',
        },
      },
    ];

    for (const testCase of cases) {
      const lifecycle = buildReviewLifecycle(testCase.input);
      expect(lifecycle, testCase.label).toEqual(expect.objectContaining(testCase.expected));
    }
  });

  it('maps queue status entries to deterministic lifecycle snapshots', () => {
    const cases = [
      {
        input: {
          status: 'reviewing',
          progress: { phase: 'provider_retry', retryAttempt: 1, retryMaxAttempts: 2, updatedAt: '2026-02-21T10:10:00.000Z' },
          updatedAt: '2026-02-21T10:10:00.000Z',
          reviewError: null,
        },
        expected: {
          status: 'retrying',
          phase: 'provider_retry',
          isActive: true,
          isTerminal: false,
          canRetry: false,
          sourceStatus: 'reviewing',
        },
      },
      {
        input: {
          status: 'reviewed',
          progress: { phase: 'complete', updatedAt: '2026-02-21T10:11:00.000Z' },
          updatedAt: '2026-02-21T10:11:00.000Z',
          reviewError: 'Partial review: 1/3 chunks analyzed before timeout',
        },
        expected: {
          status: 'partial',
          phase: 'partial',
          isActive: false,
          isTerminal: true,
          canRetry: true,
          sourceStatus: 'reviewed',
          error: 'Partial review: 1/3 chunks analyzed before timeout',
        },
      },
    ];

    for (const { input, expected } of cases) {
      expect(buildQueueLifecycle(input)).toEqual(expect.objectContaining(expected));
    }
  });

  it('derives stale reasons from head/base/merge-base drift using camelCase and snake_case payloads', () => {
    expect(deriveReviewStaleReason({
      reviewHeadSha: 'head-old',
      headSha: 'head-new',
    })).toBe('head_mismatch');
    expect(deriveReviewStaleReason({
      review_base_branch: 'main',
      base_branch: 'develop',
    })).toBe('base_mismatch');
    expect(deriveReviewStaleReason({
      reviewMergeBaseSha: 'merge-old',
      mergeBaseSha: 'merge-new',
    })).toBe('merge_base_mismatch');
    expect(deriveReviewStaleReason({
      reviewHeadSha: 'same',
      headSha: 'same',
    })).toBe(null);
  });

  it('builds deterministic action eligibility for stale, non-terminal, and terminal review states', () => {
    const staleReview = {
      reviewStatus: 'reviewed',
      reviewHeadSha: 'head-old',
      headSha: 'head-new',
    };
    const staleEligibility = buildReviewActionEligibility(staleReview);
    expect(staleEligibility).toEqual({
      canApprove: true,
      canRequestChanges: true,
      blockedReason: 'Review is stale: branch head changed after review completion. Run review again before actioning.',
      staleReason: 'head_mismatch',
    });

    const inflightEligibility = buildReviewActionEligibility({
      reviewStatus: 'queued',
      reviewHeadSha: 'head-1',
      headSha: 'head-1',
    });
    expect(inflightEligibility.canApprove).toBe(false);
    expect(inflightEligibility.canRequestChanges).toBe(false);
    expect(inflightEligibility.staleReason).toBe(null);
    expect(inflightEligibility.blockedReason).toMatch(/queued|progress/i);

    const missingReviewEligibility = buildReviewActionEligibility({
      reviewStatus: 'none',
      reviewHeadSha: 'head-1',
      headSha: 'head-1',
    });
    expect(missingReviewEligibility.canApprove).toBe(false);
    expect(missingReviewEligibility.canRequestChanges).toBe(false);
    expect(missingReviewEligibility.blockedReason).toMatch(/no completed review/i);

    const terminalEligibility = buildReviewActionEligibility({
      reviewStatus: 'reviewed',
      reviewHeadSha: 'head-ok',
      headSha: 'head-ok',
    });
    expect(terminalEligibility).toEqual({
      canApprove: true,
      canRequestChanges: true,
      blockedReason: null,
      staleReason: null,
    });

    const canonicalTerminalStatuses = ['completed', 'partial', 'failed'];
    for (const canonicalStatus of canonicalTerminalStatuses) {
      const canonicalTerminalEligibility = buildReviewActionEligibility({
        reviewStatus: canonicalStatus,
        reviewHeadSha: 'head-canonical',
        headSha: 'head-canonical',
      });
      expect(canonicalTerminalEligibility, canonicalStatus).toEqual({
        canApprove: true,
        canRequestChanges: true,
        blockedReason: null,
        staleReason: null,
      });
    }

    const canonicalActiveEligibility = buildReviewActionEligibility({
      reviewStatus: 'retrying',
      reviewHeadSha: 'head-canonical-active',
      headSha: 'head-canonical-active',
    });
    expect(canonicalActiveEligibility.canApprove).toBe(false);
    expect(canonicalActiveEligibility.canRequestChanges).toBe(false);
    expect(canonicalActiveEligibility.blockedReason).toMatch(/retrying|progress/i);
  });
});
