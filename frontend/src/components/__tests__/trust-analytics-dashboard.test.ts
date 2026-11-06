import { test, expect } from '@playwright/test';
import {
  buildSparklinePath,
  formatTrendMetricValue,
  getTrendMetricDescription,
  getTrendMetricLabel,
} from '../trustAnalyticsDashboardUtils';
import {
  buildBreakdownCards,
  buildDashboardHeroCards,
  buildMetricAvailabilityMessage,
  buildScopeSummaryMessage,
  getDashboardGuardrailMessage,
} from '../trustAnalyticsDashboardContent';
import type { TrustAnalyticsBreakdown, TrustAnalyticsSummary } from '@/types';

function buildSummary(overrides: Partial<TrustAnalyticsSummary> = {}): TrustAnalyticsSummary {
  return {
    projectId: 'proj-1',
    reviewType: null,
    scope: 'all',
    window: {
      key: '7d',
      from: '2026-03-01T00:00:00.000Z',
      to: '2026-03-07T00:00:00.000Z',
    },
    reviewCount: 4,
    scopeBreakdown: {
      branchScopedCount: 3,
      branchReviewCount: 2,
      workspaceReviewCount: 0,
      changesetCount: 1,
      prReviewCount: 1,
    },
    comparison: {
      dominantScope: 'branches',
      branchScopedCount: 3,
      prReviewCount: 1,
      branchShare: 0.75,
      prShare: 0.25,
    },
    heroCards: [
      {
        key: 'median_ttfs',
        label: 'Median TTFS',
        description: 'Median time to first signal across completed reviews in this window.',
      },
      {
        key: 'deep_coverage',
        label: 'Deep coverage',
        description: 'Share of changed files that received deep review coverage.',
      },
      {
        key: 'grounded_issues',
        label: 'Grounded issues',
        description: 'Share of actionable findings backed by grounded evidence.',
      },
      {
        key: 'reliability_mix',
        label: 'Reliability mix',
        description: 'Reliability distribution across completed reviews in this window.',
      },
    ],
    hero: {
      medianTtfsMs: {
        value: 4200,
        sampleSize: 4,
      },
      medianReviewDurationMs: {
        value: 16000,
        sampleSize: 4,
      },
      deepCoverageRate: {
        value: 0.8,
        numerator: 8,
        denominator: 10,
        sampleSize: 10,
        minimumSampleSize: 0,
        isInsufficientSample: false,
      },
      findingsFoundPerReview: {
        value: 1.5,
        numerator: 6,
        denominator: 4,
        sampleSize: 4,
      },
      issuesFoundPerReview: {
        value: 1.5,
        numerator: 6,
        denominator: 4,
        sampleSize: 4,
      },
      commentReadyFindingsPerReview: {
        value: 1.5,
        numerator: 6,
        denominator: 4,
        sampleSize: 4,
      },
      medianChangedFiles: {
        value: 9,
        sampleSize: 4,
      },
      verificationContextRate: {
        value: 0.75,
        numerator: 3,
        denominator: 4,
        sampleSize: 4,
        minimumSampleSize: 0,
        isInsufficientSample: false,
      },
      groundedIssueRate: {
        value: 0.67,
        numerator: 2,
        denominator: 3,
        sampleSize: 3,
        minimumSampleSize: 5,
        isInsufficientSample: true,
      },
    },
    quality: {
      groundedIssueRate: {
        value: 0.67,
        numerator: 2,
        denominator: 3,
        sampleSize: 3,
        minimumSampleSize: 5,
        isInsufficientSample: true,
      },
      unsupportedIssueRate: {
        value: null,
        numerator: 0,
        denominator: 3,
        sampleSize: 3,
        minimumSampleSize: 5,
        isInsufficientSample: true,
      },
      lowEvidenceIssueRate: {
        value: null,
        numerator: 0,
        denominator: 3,
        sampleSize: 3,
        minimumSampleSize: 5,
        isInsufficientSample: true,
      },
      uncorroboratedHighRiskRate: {
        value: null,
        numerator: 0,
        denominator: 0,
        sampleSize: 0,
        minimumSampleSize: 5,
        isInsufficientSample: false,
      },
      outcomeSuppressionRate: {
        value: null,
        numerator: 0,
        denominator: 0,
        sampleSize: 0,
        minimumSampleSize: 5,
        isInsufficientSample: false,
      },
    },
    outcome: {
      issueAddressedRate: {
        value: 0.5,
        numerator: 1,
        denominator: 2,
        sampleSize: 2,
        minimumSampleSize: 3,
        isInsufficientSample: true,
      },
      issueDismissedRate: {
        value: 0,
        numerator: 0,
        denominator: 2,
        sampleSize: 2,
        minimumSampleSize: 3,
        isInsufficientSample: true,
      },
      issueOutcomeCoverage: {
        value: 0.5,
        numerator: 1,
        denominator: 2,
        sampleSize: 2,
        minimumSampleSize: 3,
        isInsufficientSample: true,
      },
      addressedCount: 1,
      dismissedCount: 0,
    },
    reliability: {
      fullCount: 3,
      partialCount: 1,
      filesOnlyCount: 0,
      failedCount: 0,
      partialRate: {
        value: 0.25,
        numerator: 1,
        denominator: 4,
        sampleSize: 4,
        minimumSampleSize: 0,
        isInsufficientSample: false,
      },
      filesOnlyRate: {
        value: 0,
        numerator: 0,
        denominator: 4,
        sampleSize: 4,
        minimumSampleSize: 0,
        isInsufficientSample: false,
      },
      failedRate: {
        value: 0,
        numerator: 0,
        denominator: 4,
        sampleSize: 4,
        minimumSampleSize: 0,
        isInsufficientSample: false,
      },
      gateWarnRate: {
        value: 0.25,
        numerator: 1,
        denominator: 4,
        sampleSize: 4,
        minimumSampleSize: 0,
        isInsufficientSample: false,
      },
      gateFailRate: {
        value: 0,
        numerator: 0,
        denominator: 4,
        sampleSize: 4,
        minimumSampleSize: 0,
        isInsufficientSample: false,
      },
    },
    ...overrides,
  };
}

function buildBreakdown(overrides: Partial<TrustAnalyticsBreakdown> = {}): TrustAnalyticsBreakdown {
  return {
    projectId: 'proj-1',
    reviewType: null,
    scope: 'all',
    window: {
      key: '30d',
      from: '2026-02-07T00:00:00.000Z',
      to: '2026-03-07T00:00:00.000Z',
    },
    by: 'provider_model',
    metric: 'grounded_issue_rate',
    groups: [
      {
        key: 'sonnet-4.5',
        label: 'sonnet-4.5',
        reviewCount: 4,
        metric: {
          value: 0.75,
          numerator: 3,
          denominator: 4,
          sampleSize: 4,
          minimumSampleSize: 5,
          isInsufficientSample: true,
        },
      },
      {
        key: 'haiku-3.5',
        label: 'haiku-3.5',
        reviewCount: 3,
        metric: {
          value: 0.5,
          numerator: 2,
          denominator: 4,
          sampleSize: 4,
          minimumSampleSize: 5,
          isInsufficientSample: true,
        },
      },
    ],
    ...overrides,
  };
}

test('buildSparklinePath returns an empty path for missing values', () => {
  expect(buildSparklinePath([null, null])).toBe('');
});

test('buildSparklinePath creates a line for numeric points', () => {
  const path = buildSparklinePath([0.2, 0.5, 0.8], 100, 40);
  expect(path.startsWith('M')).toBeTruthy();
  expect(path.includes('L')).toBeTruthy();
});

test('formatTrendMetricValue formats latency and rate metrics distinctly', () => {
  expect(formatTrendMetricValue('ttfs_ms', 4200)).toBe('4.2s');
  expect(formatTrendMetricValue('grounded_issue_rate', 0.67)).toBe('67%');
  expect(formatTrendMetricValue('deep_coverage_rate', null)).toBe('n/a');
});

test('trend helpers prefer backend metric labels and descriptions when present', () => {
  expect(getTrendMetricLabel('deep_coverage_rate', {
    metricLabel: 'PR diff coverage',
  } as never)).toBe('PR diff coverage');
  expect(getTrendMetricDescription('deep_coverage_rate', {
    metricDescription: 'Share of changed PR files that received deep review coverage.',
  } as never)).toContain('changed PR files');
});

test('buildDashboardHeroCards hides guarded quality values until the sample is sufficient', () => {
  const summary = buildSummary();
  const cards = buildDashboardHeroCards(summary);

  expect(cards.map((card) => card.label)).toEqual([
    'Median TTFS',
    'Deep coverage',
    'Grounded issues',
    'Reliability mix',
  ]);
  expect(cards[2]).toMatchObject({
    label: 'Grounded issues',
    value: 'n/a',
    detail: 'Insufficient sample (n=3, min 5)',
    tone: 'info',
  });
  expect(getDashboardGuardrailMessage(summary)).toContain('Sample guardrails are active in this window');
});

test('buildDashboardHeroCards switches to PR-native cards for PR scope', () => {
  const summary = buildSummary({
    scope: 'prs',
    reviewType: 'pr_review',
    heroCards: [
      {
        key: 'comment_ready_findings',
        label: 'Comment-ready findings',
        description: 'Average actionable findings surfaced per completed PR review.',
      },
      {
        key: 'median_pr_size',
        label: 'Median PR size reviewed',
        description: 'Median changed-file count across completed PR reviews in this window.',
      },
      {
        key: 'verification_context',
        label: 'Verification context',
        description: 'Share of completed PR reviews that carried verifier or check context.',
      },
      {
        key: 'review_reliability',
        label: 'Review reliability',
        description: 'Reliability mix across completed PR reviews in this window.',
      },
    ],
  });
  const cards = buildDashboardHeroCards(summary);

  expect(cards.map((card) => card.label)).toEqual([
    'Comment-ready findings',
    'Median PR size reviewed',
    'Verification context',
    'Review reliability',
  ]);
  expect(cards[0]).toMatchObject({
    value: '1.5',
    detail: '6 findings across 4 PR reviews',
  });
  expect(cards[1]).toMatchObject({
    value: '9 files',
  });
});

test('getDashboardGuardrailMessage returns null when the summary has no guarded metrics', () => {
  const summary = buildSummary({
    hero: {
      ...buildSummary().hero,
      groundedIssueRate: {
        value: 0.8,
        numerator: 4,
        denominator: 5,
        sampleSize: 5,
        minimumSampleSize: 5,
        isInsufficientSample: false,
      },
    },
    quality: {
      ...buildSummary().quality,
      groundedIssueRate: {
        value: 0.8,
        numerator: 4,
        denominator: 5,
        sampleSize: 5,
        minimumSampleSize: 5,
        isInsufficientSample: false,
      },
      unsupportedIssueRate: {
        value: 0,
        numerator: 0,
        denominator: 5,
        sampleSize: 5,
        minimumSampleSize: 5,
        isInsufficientSample: false,
      },
      lowEvidenceIssueRate: {
        value: 0,
        numerator: 0,
        denominator: 5,
        sampleSize: 5,
        minimumSampleSize: 5,
        isInsufficientSample: false,
      },
    },
    outcome: {
      ...buildSummary().outcome,
      issueAddressedRate: {
        value: 0.5,
        numerator: 1,
        denominator: 3,
        sampleSize: 3,
        minimumSampleSize: 3,
        isInsufficientSample: false,
      },
      issueDismissedRate: {
        value: 0,
        numerator: 0,
        denominator: 3,
        sampleSize: 3,
        minimumSampleSize: 3,
        isInsufficientSample: false,
      },
      issueOutcomeCoverage: {
        value: 0.67,
        numerator: 2,
        denominator: 3,
        sampleSize: 3,
        minimumSampleSize: 3,
        isInsufficientSample: false,
      },
    },
  });

  expect(getDashboardGuardrailMessage(summary)).toBeNull();
});

test('buildBreakdownCards hides guarded rate segments until the sample is sufficient', () => {
  const cards = buildBreakdownCards(buildBreakdown());
  expect(cards[0]).toMatchObject({
    label: 'sonnet-4.5',
    value: 'n/a',
    detail: 'Insufficient sample (n=4, min 5)',
    tone: 'info',
  });
});

test('buildBreakdownCards formats count-based hotspot segments without guardrails', () => {
  const cards = buildBreakdownCards(buildBreakdown({
    by: 'path_pattern',
    metric: 'issues_found',
    groups: [
      {
        key: 'src/**',
        label: 'src/**',
        reviewCount: 4,
        metric: {
          value: 7,
          numerator: 7,
          denominator: null,
          sampleSize: 4,
          minimumSampleSize: 0,
          isInsufficientSample: false,
        },
      },
    ],
  }));

  expect(cards).toEqual([
    expect.objectContaining({
      label: 'src/**',
      value: '7',
      detail: '7 findings across 4 reviews',
      tone: 'info',
    }),
  ]);
});

test('buildScopeSummaryMessage explains how all scope combines branch and PR samples', () => {
  expect(buildScopeSummaryMessage(buildSummary(), 'all')).toBe(
    'All combines 3 branch-scoped reviews and 1 PR review. Branches currently drive 75% of samples.'
  );
});

test('buildScopeSummaryMessage stays honest when all-scope history is balanced', () => {
  expect(buildScopeSummaryMessage(buildSummary({
    scopeBreakdown: {
      branchScopedCount: 2,
      branchReviewCount: 1,
      workspaceReviewCount: 0,
      changesetCount: 1,
      prReviewCount: 2,
    },
    comparison: {
      dominantScope: 'balanced',
      branchScopedCount: 2,
      prReviewCount: 2,
      branchShare: 0.5,
      prShare: 0.5,
    },
  }), 'all')).toBe(
    'All combines 2 branch-scoped reviews and 2 PR reviews. Samples are evenly split between branch and PR history.'
  );
});

test('buildMetricAvailabilityMessage keeps PR scope copy honest', () => {
  expect(buildMetricAvailabilityMessage(buildSummary({ scope: 'prs' }), 'prs')).toContain(
    'PR-native metrics such as comment-ready findings'
  );
});
