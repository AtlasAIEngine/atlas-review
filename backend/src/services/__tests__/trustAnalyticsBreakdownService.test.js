import { beforeEach, describe, expect, it, vi } from 'vitest';

const listMergedReviewFactSnapshotsMock = vi.fn();
const listMergedDimensionFactRowsMock = vi.fn();

vi.mock('../trustAnalyticsService.js', () => ({
  normalizeAnalyticsScope: ({ scope, reviewType }) => {
    if (scope === 'prs') {
      return { scope: 'prs', reviewType: 'pr_review', reviewTypes: ['pr_review'] };
    }
    if (reviewType === 'pr_review') {
      return { scope: 'prs', reviewType: 'pr_review', reviewTypes: ['pr_review'] };
    }
    if (scope === 'branches') {
      return { scope: 'branches', reviewType: null, reviewTypes: ['changeset', 'branch_review'] };
    }
    if (scope == null || scope === '' || scope === 'all') {
      return { scope: 'all', reviewType: null, reviewTypes: null };
    }
    const error = new Error('scope must be one of: all, branches, prs');
    error.status = 400;
    throw error;
  },
  normalizeWindow: ({ window, from, to }) => {
    if (window === 'custom') {
      return {
        key: 'custom',
        from,
        to,
      };
    }
    return {
      key: window || '7d',
      from: '2026-02-06T00:00:00.000Z',
      to: '2026-03-07T00:00:00.000Z',
    };
  },
}));

vi.mock('../trustAnalyticsFactService.js', () => ({
  default: {
    listMergedReviewFactSnapshots: (...args) => listMergedReviewFactSnapshotsMock(...args),
    listMergedDimensionFactRows: (...args) => listMergedDimensionFactRowsMock(...args),
  },
}));

import trustAnalyticsBreakdownService from '../trustAnalyticsBreakdownService.js';

describe('trustAnalyticsBreakdownService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('groups provider_model metrics from review fact snapshots', async () => {
    listMergedReviewFactSnapshotsMock.mockResolvedValue([
      {
        reviewType: 'changeset',
        reviewId: 'cs-1',
        providerModel: 'sonnet-4.5',
        groundedIssueNumerator: 3,
        groundedIssueDenominator: 4,
        deepCoverageNumerator: 9,
        deepCoverageDenominator: 10,
        issueAddressedNumerator: 2,
        issueAddressedDenominator: 4,
        issueDismissedNumerator: 0,
        issueDismissedDenominator: 4,
        issuesFound: 4,
        highRiskFindings: 2,
        reviewReliability: 'partial',
      },
      {
        reviewType: 'changeset',
        reviewId: 'cs-2',
        providerModel: 'haiku-3.5',
        groundedIssueNumerator: 1,
        groundedIssueDenominator: 2,
        deepCoverageNumerator: 2,
        deepCoverageDenominator: 5,
        issueAddressedNumerator: 0,
        issueAddressedDenominator: 2,
        issueDismissedNumerator: 1,
        issueDismissedDenominator: 2,
        issuesFound: 2,
        highRiskFindings: 0,
        reviewReliability: 'full',
      },
    ]);

    const breakdown = await trustAnalyticsBreakdownService.getProjectTrustAnalyticsBreakdown({
      projectId: 'proj-1',
      by: 'provider_model',
      metric: 'grounded_issue_rate',
      window: '30d',
    });

    expect(listMergedReviewFactSnapshotsMock).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1',
      projectPath: undefined,
      scope: 'all',
      reviewType: null,
    }));
    expect(breakdown.groups).toEqual([
      {
        key: 'sonnet-4.5',
        label: 'sonnet-4.5',
        reviewCount: 1,
        metric: expect.objectContaining({
          value: 0.75,
          numerator: 3,
          denominator: 4,
          sampleSize: 4,
          minimumSampleSize: 5,
          isInsufficientSample: true,
        }),
      },
      {
        key: 'haiku-3.5',
        label: 'haiku-3.5',
        reviewCount: 1,
        metric: expect.objectContaining({
          value: 0.5,
          numerator: 1,
          denominator: 2,
          sampleSize: 2,
          minimumSampleSize: 5,
          isInsufficientSample: true,
        }),
      },
    ]);
  });

  it('groups language metrics from dimension facts and rejects unsupported combinations', async () => {
    listMergedDimensionFactRowsMock.mockResolvedValue([
      {
        reviewType: 'changeset',
        reviewId: 'cs-1',
        language: 'typescript',
        pathPattern: 'src/**',
        providerModel: 'sonnet-4.5',
        issueCount: 3,
        highRiskCount: 2,
        outcomeAddressedCount: 2,
        outcomeDismissedCount: 0,
        outcomeRecordedCount: 2,
      },
      {
        reviewType: 'changeset',
        reviewId: 'cs-2',
        language: 'ruby',
        pathPattern: 'lib/**',
        providerModel: 'sonnet-4.5',
        issueCount: 4,
        highRiskCount: 1,
        outcomeAddressedCount: 1,
        outcomeDismissedCount: 1,
        outcomeRecordedCount: 2,
      },
    ]);

    const breakdown = await trustAnalyticsBreakdownService.getProjectTrustAnalyticsBreakdown({
      projectId: 'proj-1',
      by: 'language',
      metric: 'issue_addressed_rate',
      window: '30d',
      limit: 5,
    });

    expect(listMergedDimensionFactRowsMock).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1',
      projectPath: undefined,
      scope: 'all',
      reviewType: null,
    }));
    expect(breakdown.groups).toEqual([
      {
        key: 'typescript',
        label: 'typescript',
        reviewCount: 1,
        metric: expect.objectContaining({
          value: 2 / 3,
          numerator: 2,
          denominator: 3,
          sampleSize: 3,
          minimumSampleSize: 3,
          isInsufficientSample: false,
        }),
      },
      {
        key: 'ruby',
        label: 'ruby',
        reviewCount: 1,
        metric: expect.objectContaining({
          value: 0.25,
          numerator: 1,
          denominator: 4,
          sampleSize: 4,
          minimumSampleSize: 3,
          isInsufficientSample: false,
        }),
      },
    ]);

    await expect(trustAnalyticsBreakdownService.getProjectTrustAnalyticsBreakdown({
      projectId: 'proj-1',
      by: 'language',
      metric: 'grounded_issue_rate',
      window: '30d',
    })).rejects.toMatchObject({
      status: 400,
      message: 'metric grounded_issue_rate is not supported for language breakdowns',
    });
  });

  it('aggregates mixed branch and PR history in all-scope provider breakdowns', async () => {
    listMergedReviewFactSnapshotsMock.mockResolvedValue([
      {
        reviewType: 'branch_review',
        reviewId: 'br-1',
        providerModel: 'sonnet-4.5',
        groundedIssueNumerator: 2,
        groundedIssueDenominator: 2,
        deepCoverageNumerator: 9,
        deepCoverageDenominator: 10,
        issueAddressedNumerator: 1,
        issueAddressedDenominator: 2,
        issueDismissedNumerator: 0,
        issueDismissedDenominator: 2,
        issuesFound: 2,
        highRiskFindings: 1,
        reviewReliability: 'full',
      },
      {
        reviewType: 'pr_review',
        reviewId: 'pr-1',
        providerModel: 'sonnet-4.5',
        groundedIssueNumerator: 1,
        groundedIssueDenominator: 2,
        deepCoverageNumerator: 4,
        deepCoverageDenominator: 5,
        issueAddressedNumerator: 1,
        issueAddressedDenominator: 2,
        issueDismissedNumerator: 0,
        issueDismissedDenominator: 2,
        issuesFound: 3,
        highRiskFindings: 2,
        reviewReliability: 'partial',
      },
      {
        reviewType: 'pr_review',
        reviewId: 'pr-2',
        providerModel: 'haiku-3.5',
        groundedIssueNumerator: 0,
        groundedIssueDenominator: 1,
        deepCoverageNumerator: 1,
        deepCoverageDenominator: 3,
        issueAddressedNumerator: 0,
        issueAddressedDenominator: 1,
        issueDismissedNumerator: 0,
        issueDismissedDenominator: 1,
        issuesFound: 1,
        highRiskFindings: 0,
        reviewReliability: 'partial',
      },
    ]);

    const breakdown = await trustAnalyticsBreakdownService.getProjectTrustAnalyticsBreakdown({
      projectId: 'proj-1',
      by: 'provider_model',
      metric: 'review_count',
      scope: 'all',
      window: '30d',
    });

    expect(listMergedReviewFactSnapshotsMock).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1',
      projectPath: undefined,
      scope: 'all',
      reviewType: null,
    }));
    expect(breakdown.groups).toEqual([
      {
        key: 'sonnet-4.5',
        label: 'sonnet-4.5',
        reviewCount: 2,
        metric: expect.objectContaining({
          value: 2,
          numerator: 2,
          denominator: null,
          sampleSize: 2,
        }),
      },
      {
        key: 'haiku-3.5',
        label: 'haiku-3.5',
        reviewCount: 1,
        metric: expect.objectContaining({
          value: 1,
          numerator: 1,
          denominator: null,
          sampleSize: 1,
        }),
      },
    ]);
  });

  it('fails fast when trust analytics fact tables are unavailable', async () => {
    listMergedReviewFactSnapshotsMock.mockRejectedValueOnce(
      new Error('relation trust_review_facts does not exist')
    );

    await expect(trustAnalyticsBreakdownService.getProjectTrustAnalyticsBreakdown({
      projectId: 'proj-1',
      by: 'provider_model',
      metric: 'review_count',
      window: '30d',
    })).rejects.toThrow('relation trust_review_facts does not exist');
  });

  it('does not swallow non-table postgres does-not-exist errors', async () => {
    listMergedReviewFactSnapshotsMock.mockRejectedValueOnce(
      new Error('column review_count does not exist')
    );

    await expect(trustAnalyticsBreakdownService.getProjectTrustAnalyticsBreakdown({
      projectId: 'proj-1',
      by: 'provider_model',
      metric: 'review_count',
      window: '30d',
    })).rejects.toThrow('column review_count does not exist');
  });
});
