import { test, expect } from '@playwright/test';
import {
  buildTrustAnalyticsInstantReturnCards,
  buildTrustAnalyticsFollowThroughCards,
  buildRecommendationOutcomeScope,
  buildRecommendationResolutionStorageKey,
  getRecommendationFingerprint,
  getRecommendationResolutionFor,
  normalizeRecommendationResolutionMap,
} from '../review/reviewPanelUtils';
import type { TrustReviewAnalytics } from '@/types';

const analytics: TrustReviewAnalytics = {
  meta: {
    projectId: 'proj-1',
    reviewType: 'changeset',
    reviewId: 'cs-1',
    displayId: 'CS-001',
    branchName: null,
    completedAt: '2026-03-07T10:00:00.000Z',
    providerType: 'claude',
    providerModel: 'sonnet-4.5',
  },
  immediateValue: {
    ttfsMs: 4200,
    reviewDurationMs: 18000,
    deepCoverage: {
      value: 0.8,
      numerator: 8,
      denominator: 10,
      sampleSize: 10,
      minimumSampleSize: 0,
      isInsufficientSample: false,
    },
    issuesFound: 3,
    highRiskFindings: 1,
  },
  trustQuality: {
    groundedIssueRate: {
      value: 0.67,
      numerator: 2,
      denominator: 3,
      sampleSize: 3,
      minimumSampleSize: 0,
      isInsufficientSample: false,
    },
    unsupportedIssueRate: {
      value: null,
      numerator: 0,
      denominator: 0,
      sampleSize: 0,
      minimumSampleSize: 5,
      isInsufficientSample: false,
    },
    lowEvidenceIssueRate: {
      value: 0.33,
      numerator: 1,
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
  followThrough: {
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
    reviewReliability: 'partial',
    gateStatus: 'warn',
    gateReasonCodes: ['coverage_low'],
    gateEvaluatedAt: null,
    omittedFiles: 2,
    failedFiles: 1,
    reviewStatus: 'reviewed',
  },
};

test('buildTrustAnalyticsInstantReturnCards produces trust-focused hero cards', () => {
  const cards = buildTrustAnalyticsInstantReturnCards(analytics);
  expect(cards).toHaveLength(5);
  expect(cards.map((card) => card.label)).toEqual([
    'TTFS',
    'Deep coverage',
    'Issues found',
    'Trust quality',
    'Reliability',
  ]);
  expect(cards[0].value).toBe('4.2s');
  expect(cards[1].detail).toBe('8/10 files');
  expect(cards[4].tone).toBe('warn');
});

test('buildTrustAnalyticsFollowThroughCards preserves sample guardrails in details', () => {
  const cards = buildTrustAnalyticsFollowThroughCards(analytics);
  expect(cards).toHaveLength(3);
  expect(cards[0].detail).toContain('n=2');
  expect(cards[1].value).toBe('0%');
  expect(cards[2].label).toBe('Outcome coverage');
});

test('recommendation outcome helpers support PR review scopes', () => {
  expect(buildRecommendationOutcomeScope({
    prReviewId: 'pr-1',
  })).toEqual({
    reviewType: 'pr_review',
    reviewId: 'pr-1',
  });

  expect(buildRecommendationResolutionStorageKey({
    projectId: 'proj-1',
    prReviewId: 'pr-1',
  })).toBe('atlas_review_resolution:pr:proj-1:pr-1');
});

test('recommendation outcomes resolve backend canonical keys on reopened reviews', () => {
  const recommendation = {
    type: 'issue' as const,
    severity: 'medium' as const,
    title: 'Handle missing INVALID_INPUT | empty review',
    description: 'Breaks atlas://review/current when no review exists',
    file: 'mcp-review-server/src/resources/reviewCurrent.ts',
    line: 22,
    suggestedFix: 'Catch INVALID_INPUT | return an empty review payload',
  };

  const backendOutcomeKey = 'issue|medium|handle missing invalid_input \\| empty review|breaks atlas://review/current when no review exists|mcp-review-server/src/resources/reviewcurrent.ts|22|catch invalid_input \\| return an empty review payload';
  const hydrated = normalizeRecommendationResolutionMap({
    [backendOutcomeKey]: {
      status: 'addressed',
      updatedAt: '2026-03-10T10:00:00.000Z',
    },
  });

  expect(getRecommendationFingerprint(recommendation)).toBe(backendOutcomeKey);
  expect(getRecommendationResolutionFor(recommendation, hydrated)).toEqual({
    state: 'addressed',
    updatedAt: '2026-03-10T10:00:00.000Z',
  });
});

test('recommendation outcomes keep resolving legacy locally-stored keys', () => {
  const recommendation = {
    type: 'issue' as const,
    severity: 'low' as const,
    title: 'Queue cancel copy',
    description: 'queueCancel throws a branch-specific error for PR review',
    file: 'mcp-review-server/src/tools/queueCancel.ts',
    line: 27,
    suggestedFix: 'Return a generic invalid input error',
  };

  const hydrated = normalizeRecommendationResolutionMap({
    'issue|low|queue cancel copy|queuecancel throws a branch-specific error for pr review|mcp-review-server/src/tools/queuecancel.ts|27|return a generic invalid input error': {
      status: 'dismissed',
      updatedAt: '2026-03-10T10:05:00.000Z',
    },
  });

  expect(getRecommendationResolutionFor(recommendation, hydrated)).toEqual({
    state: 'dismissed',
    updatedAt: '2026-03-10T10:05:00.000Z',
  });
});
