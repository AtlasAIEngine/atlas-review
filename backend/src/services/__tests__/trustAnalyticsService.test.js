import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../changesetService.js', () => ({
  default: {
    getChangeSets: vi.fn(),
    getChangeSet: vi.fn(),
  },
}));

vi.mock('../branchReviewService.js', () => ({
  default: {
    getByProject: vi.fn(),
    getById: vi.fn(),
  },
}));

vi.mock('../prReviewService.js', () => ({
  default: {
    getByProject: vi.fn(),
    getById: vi.fn(),
  },
}));

vi.mock('../reviewOutcomeService.js', () => ({
  default: {
    listOutcomes: vi.fn(),
    countIssueOutcomesForReviewScopes: vi.fn(),
  },
}));

vi.mock('../trustAnalyticsFactService.js', () => ({
  default: {
    listReviewFactSnapshots: vi.fn().mockResolvedValue([]),
    listMergedReviewFactSnapshots: vi.fn().mockResolvedValue([]),
    listMergedDimensionFactRows: vi.fn().mockResolvedValue([]),
    hydrateTrustAnalyticsFromFactSnapshot: vi.fn((fact) => fact),
  },
}));

import changesetService from '../changesetService.js';
import branchReviewService from '../branchReviewService.js';
import prReviewService from '../prReviewService.js';
import reviewOutcomeService from '../reviewOutcomeService.js';
import trustAnalyticsFactService from '../trustAnalyticsFactService.js';
import {
  buildReviewTrustAnalytics,
  getProjectTrustAnalyticsSummary,
  getProjectTrustAnalyticsTimeseries,
  normalizeAnalyticsScope,
} from '../trustAnalyticsService.js';

function buildReviewPayload(overrides = {}) {
  return {
    summary: 'Atlas review',
    riskLevel: 'medium',
    provider: { type: 'claude', model: 'sonnet-4.5' },
    changeGroups: [{ title: 'Auth' }],
    recommendations: [
      { type: 'issue', severity: 'high', title: 'SQL injection', description: 'Unsanitized query', file: 'src/auth.ts', line: 18 },
      { type: 'issue', severity: 'low', title: 'Log leak', description: 'Sensitive log', file: 'src/log.ts', line: 9 },
      { type: 'suggestion', severity: 'high', title: 'Refactor', description: 'Extract helper', file: 'src/auth.ts', line: 44 },
    ],
    stats: {
      firstSignalMs: 4200,
      reviewTotalDurationMs: 18400,
      deepReviewedFiles: 8,
      totalChangedFiles: 10,
      issuesGrounded: 1,
      issuesDemoted: 1,
      issuesSuppressed: 0,
      issuesTotal: 2,
      verifierSupported: 1,
      verifierUnsupported: 1,
      corroborationChecked: 1,
      corroborationUnsupported: 0,
      outcomeSuppressionCandidates: 2,
      outcomeSuppressionSuppressed: 1,
      reviewTier: 'partial',
      omittedFiles: 2,
      perFileFailedFiles: 1,
      reviewModelGate: {
        status: 'warn',
        reasonCodes: ['coverage_low'],
      },
    },
    ...overrides,
  };
}

describe('trustAnalyticsService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prReviewService.getByProject.mockResolvedValue([]);
    prReviewService.getById.mockResolvedValue(null);
    branchReviewService.getById.mockResolvedValue(null);
    trustAnalyticsFactService.listMergedReviewFactSnapshots.mockResolvedValue([]);
    trustAnalyticsFactService.listMergedDimensionFactRows.mockResolvedValue([]);
    reviewOutcomeService.listOutcomes.mockResolvedValue({
      telemetry: {
        issueTotal: 2,
        issueAddressed: 1,
        issueDismissed: 0,
      },
    });
    reviewOutcomeService.countIssueOutcomesForReviewScopes.mockResolvedValue({
      total: 1,
      addressed: 1,
      dismissed: 0,
    });
  });

  it('builds deterministic per-review analytics from review telemetry and outcomes', async () => {
    const analytics = await buildReviewTrustAnalytics({
      projectId: 'proj-1',
      reviewType: 'changeset',
      reviewId: 'cs-1',
      displayId: 'CS-001',
      reviewStatus: 'reviewed',
      reviewedAt: '2026-03-07T10:00:00.000Z',
      totalChangedFiles: 10,
      reviewPayload: buildReviewPayload(),
    });

    expect(analytics.meta).toEqual(expect.objectContaining({
      projectId: 'proj-1',
      reviewType: 'changeset',
      reviewId: 'cs-1',
      displayId: 'CS-001',
      providerType: 'claude',
      providerModel: 'sonnet-4.5',
    }));
    expect(analytics.immediateValue).toEqual(expect.objectContaining({
      ttfsMs: 4200,
      reviewDurationMs: 18400,
      issuesFound: 2,
      highRiskFindings: 1,
    }));
    expect(analytics.immediateValue.deepCoverage).toEqual(expect.objectContaining({
      value: 0.8,
      numerator: 8,
      denominator: 10,
    }));
    expect(analytics.trustQuality.groundedIssueRate).toEqual(expect.objectContaining({
      value: 0.5,
      numerator: 1,
      denominator: 2,
    }));
    expect(analytics.followThrough.issueAddressedRate).toEqual(expect.objectContaining({
      value: 0.5,
      numerator: 1,
      denominator: 2,
      isInsufficientSample: true,
    }));
    expect(analytics.reliability).toEqual(expect.objectContaining({
      reviewReliability: 'partial',
      gateStatus: 'warn',
      omittedFiles: 2,
      failedFiles: 1,
    }));
  });

  it('treats scope=all as compatible with an explicit reviewType', () => {
    expect(normalizeAnalyticsScope({ scope: 'all', reviewType: 'pr_review' })).toEqual({
      scope: 'prs',
      reviewType: 'pr_review',
      reviewTypes: ['pr_review'],
    });
    expect(normalizeAnalyticsScope({ scope: 'all', reviewType: 'branch_review' })).toEqual({
      scope: 'branches',
      reviewType: 'branch_review',
      reviewTypes: ['branch_review'],
    });
  });

  it('aggregates live project reviews into summary metrics', async () => {
    changesetService.getChangeSets.mockResolvedValue([
      {
        id: 'cs-1',
        displayId: 'CS-001',
        reviewStatus: 'reviewed',
        reviewedAt: '2026-03-07T10:00:00.000Z',
        createdAt: '2026-03-07T09:55:00.000Z',
      },
      {
        id: 'cs-2',
        displayId: 'CS-002',
        reviewStatus: 'failed',
        reviewedAt: '2026-03-07T11:00:00.000Z',
        createdAt: '2026-03-07T10:58:00.000Z',
      },
    ]);
    changesetService.getChangeSet.mockResolvedValue({
      id: 'cs-1',
      displayId: 'CS-001',
      reviewStatus: 'reviewed',
      reviewedAt: '2026-03-07T10:00:00.000Z',
      createdAt: '2026-03-07T09:55:00.000Z',
      files: new Array(10).fill({ path: 'file.ts' }),
      reviewData: buildReviewPayload(),
    });
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-1',
        displayId: 'BR-001',
        branchName: 'feature/auth',
        fileCount: 12,
        reviewStatus: 'reviewed',
        reviewedAt: '2026-03-07T12:00:00.000Z',
        createdAt: '2026-03-07T11:40:00.000Z',
        reviewJson: buildReviewPayload({
          recommendations: [
            { type: 'issue', severity: 'critical', title: 'Auth bypass', description: 'Missing permission check', file: 'src/admin.ts', line: 5 },
          ],
          stats: {
            firstSignalMs: 2100,
            reviewTotalDurationMs: 9200,
            deepReviewedFiles: 12,
            totalChangedFiles: 12,
            issuesGrounded: 1,
            issuesDemoted: 0,
            issuesSuppressed: 0,
            issuesTotal: 1,
            verifierSupported: 1,
            verifierUnsupported: 0,
            corroborationChecked: 1,
            corroborationUnsupported: 0,
            outcomeSuppressionCandidates: 0,
            outcomeSuppressionSuppressed: 0,
            reviewTier: 'full',
            omittedFiles: 0,
            perFileFailedFiles: 0,
            reviewModelGate: { status: 'pass', reasonCodes: [] },
          },
        }),
      },
    ]);
    reviewOutcomeService.listOutcomes
      .mockResolvedValueOnce({ telemetry: { issueTotal: 2, issueAddressed: 1, issueDismissed: 0 } })
      .mockResolvedValueOnce({ telemetry: { issueTotal: 0, issueAddressed: 0, issueDismissed: 0 } })
      .mockResolvedValueOnce({ telemetry: { issueTotal: 1, issueAddressed: 1, issueDismissed: 0 } });
    reviewOutcomeService.countIssueOutcomesForReviewScopes.mockResolvedValueOnce({
      total: 2,
      addressed: 2,
      dismissed: 0,
    });

    const summary = await getProjectTrustAnalyticsSummary({
      projectId: 'proj-1',
      projectPath: '/tmp/repo',
      window: '24h',
      now: new Date('2026-03-07T18:00:00.000Z'),
    });

    expect(summary.reviewCount).toBe(3);
    expect(summary.hero.medianTtfsMs).toEqual(expect.objectContaining({ value: 3150, sampleSize: 2 }));
    expect(summary.hero.deepCoverageRate).toEqual(expect.objectContaining({
      numerator: 20,
      denominator: 22,
      value: 20 / 22,
    }));
    expect(summary.hero.groundedIssueRate).toEqual(expect.objectContaining({
      numerator: 2,
      denominator: 3,
      value: 2 / 3,
    }));
    expect(summary.outcome.issueAddressedRate).toEqual(expect.objectContaining({
      numerator: 2,
      denominator: 3,
      value: 2 / 3,
    }));
    expect(summary.reliability).toEqual(expect.objectContaining({
      fullCount: 1,
      partialCount: 1,
      failedCount: 1,
    }));
    expect(summary.scope).toBe('all');
    expect(summary.scopeBreakdown).toEqual({
      workspaceReviewCount: 0,
      branchScopedCount: 3,
      branchReviewCount: 1,
      changesetCount: 2,
      prReviewCount: 0,
    });
    expect(summary.comparison).toEqual({
      dominantScope: 'branches',
      branchScopedCount: 3,
      prReviewCount: 0,
      branchShare: 1,
      prShare: 0,
    });
    expect(summary.heroCards.map((card) => card.label)).toEqual([
      'Median TTFS',
      'Deep coverage',
      'Grounded issues',
      'Reliability mix',
    ]);
  });

  it('supports PR-only analytics scope and exact pr_review facts', async () => {
    prReviewService.getByProject.mockResolvedValue([
      {
        id: 'pr-1',
        displayId: 'PR-001',
        headBranch: 'feature/auth',
        reviewStatus: 'reviewed',
        reviewedAt: '2026-03-07T13:00:00.000Z',
        createdAt: '2026-03-07T12:20:00.000Z',
        updatedAt: '2026-03-07T13:00:00.000Z',
        fileCount: 6,
        reviewJson: buildReviewPayload({
          stats: {
            ...buildReviewPayload().stats,
            firstSignalMs: 5100,
            reviewTotalDurationMs: 21000,
            deepReviewedFiles: 5,
            totalChangedFiles: 6,
            reviewTier: 'full',
            omittedFiles: 1,
            perFileFailedFiles: 0,
          },
        }),
      },
    ]);
    reviewOutcomeService.listOutcomes.mockResolvedValue({
      telemetry: { issueTotal: 2, issueAddressed: 1, issueDismissed: 0 },
    });
    reviewOutcomeService.countIssueOutcomesForReviewScopes.mockResolvedValueOnce({
      total: 1,
      addressed: 1,
      dismissed: 0,
    });

    const summary = await getProjectTrustAnalyticsSummary({
      projectId: 'proj-1',
      projectPath: '/tmp/repo',
      scope: 'prs',
      window: '24h',
      now: new Date('2026-03-07T18:00:00.000Z'),
    });

    expect(summary.scope).toBe('prs');
    expect(summary.reviewType).toBe('pr_review');
    expect(summary.reviewCount).toBe(1);
    expect(summary.scopeBreakdown).toEqual({
      workspaceReviewCount: 0,
      branchScopedCount: 0,
      branchReviewCount: 0,
      changesetCount: 0,
      prReviewCount: 1,
    });
    expect(summary.heroCards).toEqual([
      expect.objectContaining({
        key: 'comment_ready_findings',
        label: 'Comment-ready findings',
      }),
      expect.objectContaining({
        key: 'median_pr_size',
        label: 'Median PR size reviewed',
      }),
      expect.objectContaining({
        key: 'verification_context',
        label: 'Verification context',
      }),
      expect.objectContaining({
        key: 'review_reliability',
        label: 'Review reliability',
      }),
    ]);
    expect(summary.hero.deepCoverageRate).toEqual(expect.objectContaining({
      numerator: 5,
      denominator: 6,
      value: 5 / 6,
    }));
    expect(summary.hero.verificationContextRate).toEqual(expect.objectContaining({
      numerator: 1,
      denominator: 1,
      value: 1,
    }));
  });

  it('uses project issue outcome totals for summary counts', async () => {
    trustAnalyticsFactService.listMergedReviewFactSnapshots.mockResolvedValue([
      {
        projectId: 'proj-1',
        reviewType: 'pr_review',
        reviewId: 'pr-1',
        completedAt: '2026-03-07T13:00:00.000Z',
      },
    ]);
    trustAnalyticsFactService.hydrateTrustAnalyticsFromFactSnapshot.mockReturnValue({
      meta: {
        projectId: 'proj-1',
        reviewType: 'pr_review',
        reviewId: 'pr-1',
        completedAt: '2026-03-07T13:00:00.000Z',
      },
      immediateValue: {
        ttfsMs: 5100,
        reviewDurationMs: 21000,
        deepCoverage: { numerator: 5, denominator: 6, value: 5 / 6 },
        issuesFound: 3,
        highRiskFindings: 1,
      },
      trustQuality: {
        groundedIssueRate: { numerator: 1, denominator: 2, value: 0.5 },
        unsupportedIssueRate: { numerator: 0, denominator: 2, value: 0 },
        lowEvidenceIssueRate: { numerator: 0, denominator: 2, value: 0 },
        uncorroboratedHighRiskRate: { numerator: 0, denominator: 1, value: 0 },
        outcomeSuppressionRate: { numerator: 0, denominator: 2, value: 0 },
      },
      followThrough: {
        issueAddressedRate: { numerator: 0, denominator: 3, value: 0 },
        issueDismissedRate: { numerator: 0, denominator: 3, value: 0 },
        issueOutcomeCoverage: { numerator: 0, denominator: 3, value: 0 },
        addressedCount: 0,
        dismissedCount: 0,
      },
      reliability: {
        reviewReliability: 'full',
        gateStatus: 'pass',
        omittedFiles: 0,
        failedFiles: 0,
        reviewStatus: 'reviewed',
      },
    });
    trustAnalyticsFactService.listMergedDimensionFactRows.mockResolvedValue([
      {
        projectId: 'proj-1',
        reviewType: 'pr_review',
        reviewId: 'pr-1',
        recommendationKey: 'rec-a',
        issueCount: 2,
        outcomeAddressedCount: 2,
        outcomeDismissedCount: 0,
        outcomeRecordedCount: 2,
      },
      {
        projectId: 'proj-1',
        reviewType: 'pr_review',
        reviewId: 'pr-1',
        recommendationKey: 'rec-b',
        issueCount: 1,
        outcomeAddressedCount: 0,
        outcomeDismissedCount: 1,
        outcomeRecordedCount: 1,
      },
    ]);
    reviewOutcomeService.countIssueOutcomesForReviewScopes.mockResolvedValueOnce({
      total: 7,
      addressed: 5,
      dismissed: 2,
    });

    const summary = await getProjectTrustAnalyticsSummary({
      projectId: 'proj-1',
      projectPath: '/tmp/repo',
      scope: 'prs',
      window: '24h',
      now: new Date('2026-03-07T18:00:00.000Z'),
    });

    expect(summary.reviewCount).toBe(1);
    expect(summary.outcome).toEqual(expect.objectContaining({
      addressedCount: 5,
      dismissedCount: 2,
      issueAddressedRate: expect.objectContaining({
        numerator: 2,
        denominator: 3,
        value: 2 / 3,
      }),
      issueDismissedRate: expect.objectContaining({
        numerator: 1,
        denominator: 3,
        value: 1 / 3,
      }),
      issueOutcomeCoverage: expect.objectContaining({
        numerator: 3,
        denominator: 3,
        value: 1,
      }),
    }));
  });

  it('counts repeated branch rereviews as separate review events when fact history contains multiple snapshots for one scope', async () => {
    trustAnalyticsFactService.listMergedReviewFactSnapshots.mockResolvedValue([
      {
        projectId: 'proj-1',
        reviewType: 'branch_review',
        reviewId: 'br-1',
        completedAt: '2026-03-07T13:00:00.000Z',
        issuesFound: 1,
      },
      {
        projectId: 'proj-1',
        reviewType: 'branch_review',
        reviewId: 'br-1',
        completedAt: '2026-03-07T14:00:00.000Z',
        issuesFound: 2,
      },
    ]);
    trustAnalyticsFactService.hydrateTrustAnalyticsFromFactSnapshot
      .mockImplementation((fact) => ({
        meta: {
          projectId: 'proj-1',
          reviewType: 'branch_review',
          reviewId: fact.reviewId,
          completedAt: fact.completedAt,
        },
        immediateValue: {
          ttfsMs: null,
          reviewDurationMs: null,
          deepCoverage: { numerator: 0, denominator: 0, value: null },
          issuesFound: fact.issuesFound,
          findingsFound: fact.issuesFound,
          highRiskFindings: 0,
        },
        trustQuality: {
          groundedIssueRate: { numerator: 0, denominator: 0, value: null },
          unsupportedIssueRate: { numerator: 0, denominator: 0, value: null },
          lowEvidenceIssueRate: { numerator: 0, denominator: 0, value: null },
          uncorroboratedHighRiskRate: { numerator: 0, denominator: 0, value: null },
          outcomeSuppressionRate: { numerator: 0, denominator: 0, value: null },
        },
        followThrough: {
          issueAddressedRate: { numerator: 0, denominator: 0, value: null },
          issueDismissedRate: { numerator: 0, denominator: 0, value: null },
          issueOutcomeCoverage: { numerator: 0, denominator: 0, value: null },
          addressedCount: 0,
          dismissedCount: 0,
        },
        reliability: {
          reviewReliability: 'full',
          gateStatus: null,
          gateReasonCodes: [],
          omittedFiles: 0,
          failedFiles: 0,
          reviewStatus: 'reviewed',
        },
      }));
    trustAnalyticsFactService.listMergedDimensionFactRows.mockResolvedValue([]);
    reviewOutcomeService.countIssueOutcomesForReviewScopes.mockResolvedValueOnce({
      total: 0,
      addressed: 0,
      dismissed: 0,
    });

    const summary = await getProjectTrustAnalyticsSummary({
      projectId: 'proj-1',
      projectPath: '/tmp/repo',
      scope: 'branches',
      window: '24h',
      now: new Date('2026-03-07T18:00:00.000Z'),
    });

    expect(summary.reviewCount).toBe(2);
    expect(summary.hero.issuesFoundPerReview).toEqual(expect.objectContaining({
      numerator: 3,
      denominator: 2,
      value: 1.5,
    }));
  });

  it('does not count issue presence alone as PR verification context', async () => {
    prReviewService.getByProject.mockResolvedValue([
      {
        id: 'pr-plain',
        displayId: 'PR-PLAIN',
        headBranch: 'feature/plain',
        reviewStatus: 'reviewed',
        reviewedAt: '2026-03-07T13:00:00.000Z',
        createdAt: '2026-03-07T12:20:00.000Z',
        updatedAt: '2026-03-07T13:00:00.000Z',
        fileCount: 4,
        reviewJson: buildReviewPayload({
          stats: {
            ...buildReviewPayload().stats,
            issuesGrounded: 1,
            issuesTotal: 2,
            verifierSupported: 0,
            verifierUnsupported: 0,
            reviewModelGate: null,
            deepReviewedFiles: 4,
            totalChangedFiles: 4,
          },
        }),
      },
    ]);
    reviewOutcomeService.listOutcomes.mockResolvedValue({
      telemetry: { issueTotal: 2, issueAddressed: 0, issueDismissed: 0 },
    });
    reviewOutcomeService.countIssueOutcomesForReviewScopes.mockResolvedValueOnce({
      total: 0,
      addressed: 0,
      dismissed: 0,
    });

    const summary = await getProjectTrustAnalyticsSummary({
      projectId: 'proj-1',
      projectPath: '/tmp/repo',
      scope: 'prs',
      window: '24h',
      now: new Date('2026-03-07T18:00:00.000Z'),
    });

    expect(summary.hero.groundedIssueRate).toEqual(expect.objectContaining({
      numerator: 1,
      denominator: 2,
      value: 0.5,
    }));
    expect(summary.hero.verificationContextRate).toEqual(expect.objectContaining({
      numerator: 0,
      denominator: 1,
      value: 0,
    }));
  });

  it('falls back to live branch reviews when fact-backed reads return no rows', async () => {
    trustAnalyticsFactService.listMergedReviewFactSnapshots.mockResolvedValue([]);
    changesetService.getChangeSets.mockResolvedValue([]);
    branchReviewService.getByProject.mockResolvedValue([
      {
        id: 'br-live',
        displayId: 'BR-001',
        branchName: 'feature/project-black',
        fileCount: 46,
        reviewStatus: 'reviewed',
        reviewedAt: '2026-03-09T04:21:08.000Z',
        createdAt: '2026-03-09T04:10:00.000Z',
        updatedAt: '2026-03-09T04:21:08.000Z',
        reviewJson: buildReviewPayload({
          stats: {
            ...buildReviewPayload().stats,
            firstSignalMs: 1800,
            reviewTotalDurationMs: 12800,
            deepReviewedFiles: 46,
            totalChangedFiles: 46,
            issuesGrounded: 2,
            issuesTotal: 3,
            verifierSupported: 2,
            verifierUnsupported: 1,
            reviewModelGate: { status: 'pass', reasonCodes: [] },
          },
        }),
      },
    ]);
    prReviewService.getByProject.mockResolvedValue([]);
    reviewOutcomeService.listOutcomes.mockResolvedValue({
      telemetry: { issueTotal: 3, issueAddressed: 0, issueDismissed: 0 },
    });

    const summary = await getProjectTrustAnalyticsSummary({
      projectId: 'proj-black',
      projectPath: '/tmp/project-black',
      scope: 'all',
      window: '7d',
      now: new Date('2026-03-09T05:00:00.000Z'),
    });

    expect(trustAnalyticsFactService.listMergedReviewFactSnapshots).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-black',
      projectPath: '/tmp/project-black',
      scope: 'all',
      reviewType: null,
    }));
    expect(branchReviewService.getByProject).toHaveBeenCalledWith('proj-black');
    expect(summary.reviewCount).toBe(1);
    expect(summary.scopeBreakdown).toEqual({
      workspaceReviewCount: 0,
      branchScopedCount: 1,
      branchReviewCount: 1,
      changesetCount: 0,
      prReviewCount: 0,
    });
    expect(summary.hero.medianChangedFiles.value).toBe(46);
  });

  it('merges persisted fact snapshots with live reviews when backfill is incomplete', async () => {
    trustAnalyticsFactService.hydrateTrustAnalyticsFromFactSnapshot.mockImplementation((fact) => ({
      meta: {
        projectId: fact.projectId,
        reviewType: fact.reviewType,
        reviewId: fact.reviewId,
        displayId: fact.displayId,
        branchName: fact.branchName ?? null,
        completedAt: fact.completedAt,
        createdAt: fact.createdAtSource ?? null,
        providerType: fact.providerType ?? null,
        providerModel: fact.providerModel ?? null,
      },
      immediateValue: {
        ttfsMs: fact.ttfsMs,
        reviewDurationMs: fact.reviewDurationMs,
        deepCoverage: {
          value: fact.deepCoverageDenominator > 0 ? fact.deepCoverageNumerator / fact.deepCoverageDenominator : null,
          numerator: fact.deepCoverageNumerator,
          denominator: fact.deepCoverageDenominator,
          sampleSize: fact.deepCoverageDenominator,
          minimumSampleSize: 0,
          isInsufficientSample: false,
        },
        issuesFound: fact.issuesFound,
        highRiskFindings: fact.highRiskFindings,
      },
      trustQuality: {
        groundedIssueRate: {
          value: fact.groundedIssueDenominator > 0 ? fact.groundedIssueNumerator / fact.groundedIssueDenominator : null,
          numerator: fact.groundedIssueNumerator,
          denominator: fact.groundedIssueDenominator,
          sampleSize: fact.groundedIssueDenominator,
          minimumSampleSize: 5,
          isInsufficientSample: fact.groundedIssueDenominator > 0 && fact.groundedIssueDenominator < 5,
        },
        unsupportedIssueRate: { value: null, numerator: 0, denominator: 0, sampleSize: 0, minimumSampleSize: 5, isInsufficientSample: false },
        lowEvidenceIssueRate: { value: null, numerator: 0, denominator: 0, sampleSize: 0, minimumSampleSize: 5, isInsufficientSample: false },
        uncorroboratedHighRiskRate: { value: null, numerator: 0, denominator: 0, sampleSize: 0, minimumSampleSize: 5, isInsufficientSample: false },
        outcomeSuppressionRate: { value: null, numerator: 0, denominator: 0, sampleSize: 0, minimumSampleSize: 5, isInsufficientSample: false },
      },
      followThrough: {
        issueAddressedRate: {
          value: fact.issueAddressedDenominator > 0 ? fact.issueAddressedNumerator / fact.issueAddressedDenominator : null,
          numerator: fact.issueAddressedNumerator,
          denominator: fact.issueAddressedDenominator,
          sampleSize: fact.issueAddressedDenominator,
          minimumSampleSize: 3,
          isInsufficientSample: fact.issueAddressedDenominator > 0 && fact.issueAddressedDenominator < 3,
        },
        issueDismissedRate: {
          value: fact.issueDismissedDenominator > 0 ? fact.issueDismissedNumerator / fact.issueDismissedDenominator : null,
          numerator: fact.issueDismissedNumerator,
          denominator: fact.issueDismissedDenominator,
          sampleSize: fact.issueDismissedDenominator,
          minimumSampleSize: 3,
          isInsufficientSample: fact.issueDismissedDenominator > 0 && fact.issueDismissedDenominator < 3,
        },
        issueOutcomeCoverage: {
          value: fact.issueOutcomeCoverageDenominator > 0 ? fact.issueOutcomeCoverageNumerator / fact.issueOutcomeCoverageDenominator : null,
          numerator: fact.issueOutcomeCoverageNumerator,
          denominator: fact.issueOutcomeCoverageDenominator,
          sampleSize: fact.issueOutcomeCoverageDenominator,
          minimumSampleSize: 3,
          isInsufficientSample: fact.issueOutcomeCoverageDenominator > 0 && fact.issueOutcomeCoverageDenominator < 3,
        },
        addressedCount: fact.issueAddressedNumerator,
        dismissedCount: fact.issueDismissedNumerator,
      },
      reliability: {
        reviewReliability: fact.reviewReliability,
        gateStatus: fact.gateStatus ?? null,
        gateReasonCodes: fact.gateReasonCodes ?? [],
        gateEvaluatedAt: null,
        omittedFiles: fact.omittedFiles,
        failedFiles: fact.failedFiles,
        reviewStatus: fact.reviewStatus,
      },
    }));
    trustAnalyticsFactService.listMergedReviewFactSnapshots.mockResolvedValue([
      {
        projectId: 'proj-1',
        reviewType: 'changeset',
        reviewId: 'cs-1',
        displayId: 'CS-001',
        reviewStatus: 'reviewed',
        reviewReliability: 'full',
        gateStatus: 'pass',
        gateReasonCodes: [],
        providerType: 'claude',
        providerModel: 'sonnet-4.5',
        createdAtSource: '2026-03-07T09:55:00.000Z',
        completedAt: '2026-03-07T10:00:00.000Z',
        ttfsMs: 1000,
        reviewDurationMs: 4000,
        totalChangedFiles: 4,
        deepCoverageNumerator: 4,
        deepCoverageDenominator: 4,
        issuesFound: 1,
        highRiskFindings: 0,
        groundedIssueNumerator: 1,
        groundedIssueDenominator: 1,
        unsupportedIssueNumerator: 0,
        unsupportedIssueDenominator: 1,
        lowEvidenceIssueNumerator: 0,
        lowEvidenceIssueDenominator: 1,
        uncorroboratedHighRiskNumerator: 0,
        uncorroboratedHighRiskDenominator: 0,
        outcomeSuppressionNumerator: 0,
        outcomeSuppressionDenominator: 0,
        issueAddressedNumerator: 1,
        issueAddressedDenominator: 1,
        issueDismissedNumerator: 0,
        issueDismissedDenominator: 1,
        issueOutcomeCoverageNumerator: 1,
        issueOutcomeCoverageDenominator: 1,
        omittedFiles: 0,
        failedFiles: 0,
      },
      {
        projectId: 'proj-1',
        reviewType: 'changeset',
        reviewId: 'cs-2',
        displayId: 'CS-002',
        reviewStatus: 'reviewed',
        reviewReliability: 'partial',
        gateStatus: null,
        gateReasonCodes: [],
        providerType: 'claude',
        providerModel: 'sonnet-4.5',
        createdAtSource: '2026-03-07T10:58:00.000Z',
        completedAt: '2026-03-07T11:00:00.000Z',
        ttfsMs: 3000,
        reviewDurationMs: 9000,
        totalChangedFiles: 2,
        deepCoverageNumerator: 1,
        deepCoverageDenominator: 2,
        issuesFound: 0,
        highRiskFindings: 0,
        groundedIssueNumerator: 0,
        groundedIssueDenominator: 0,
        unsupportedIssueNumerator: 0,
        unsupportedIssueDenominator: 0,
        lowEvidenceIssueNumerator: 0,
        lowEvidenceIssueDenominator: 0,
        uncorroboratedHighRiskNumerator: 0,
        uncorroboratedHighRiskDenominator: 0,
        outcomeSuppressionNumerator: 0,
        outcomeSuppressionDenominator: 0,
        issueAddressedNumerator: 0,
        issueAddressedDenominator: 0,
        issueDismissedNumerator: 0,
        issueDismissedDenominator: 0,
        issueOutcomeCoverageNumerator: 0,
        issueOutcomeCoverageDenominator: 0,
        omittedFiles: 1,
        failedFiles: 0,
      },
    ]);

    const summary = await getProjectTrustAnalyticsSummary({
      projectId: 'proj-1',
      projectPath: '/tmp/repo',
      window: '24h',
      now: new Date('2026-03-07T18:00:00.000Z'),
    });

    expect(summary.reviewCount).toBe(2);
    expect(summary.hero.deepCoverageRate).toEqual(expect.objectContaining({
      numerator: 5,
      denominator: 6,
    }));
    expect(summary.reliability).toEqual(expect.objectContaining({
      fullCount: 1,
      partialCount: 1,
    }));
  });

  it('groups timeseries metrics by bucket and validates metric names', async () => {
    changesetService.getChangeSets.mockResolvedValue([
      {
        id: 'cs-1',
        displayId: 'CS-001',
        reviewStatus: 'reviewed',
        reviewedAt: '2026-03-07T10:00:00.000Z',
        createdAt: '2026-03-07T09:55:00.000Z',
      },
    ]);
    changesetService.getChangeSet.mockResolvedValue({
      id: 'cs-1',
      displayId: 'CS-001',
      reviewStatus: 'reviewed',
      reviewedAt: '2026-03-07T10:00:00.000Z',
      createdAt: '2026-03-07T09:55:00.000Z',
      files: new Array(10).fill({ path: 'file.ts' }),
      reviewData: buildReviewPayload(),
    });
    branchReviewService.getByProject.mockResolvedValue([]);

    const timeseries = await getProjectTrustAnalyticsTimeseries({
      projectId: 'proj-1',
      projectPath: '/tmp/repo',
      metric: 'ttfs_ms',
      window: '24h',
      interval: 'hour',
      now: new Date('2026-03-07T18:00:00.000Z'),
    });

    expect(timeseries.points).toHaveLength(1);
    expect(timeseries.points[0]).toEqual(expect.objectContaining({
      bucketStart: '2026-03-07T10:00:00.000Z',
      value: 4200,
      sampleSize: 1,
      aggregation: 'median',
    }));
    expect(timeseries.metricLabel).toBe('Review start');
    expect(timeseries.metricDescription).toContain('Time to first signal');

    await expect(getProjectTrustAnalyticsTimeseries({
      projectId: 'proj-1',
      projectPath: '/tmp/repo',
      metric: 'bogus',
      window: '24h',
      now: new Date('2026-03-07T18:00:00.000Z'),
    })).rejects.toMatchObject({ status: 400 });
  });

  it('adds PR-specific timeseries copy when PR scope is selected', async () => {
    prReviewService.getByProject.mockResolvedValue([
      {
        id: 'pr-1',
        displayId: 'PR-001',
        headBranch: 'feature/auth',
        reviewStatus: 'reviewed',
        reviewedAt: '2026-03-07T13:00:00.000Z',
        createdAt: '2026-03-07T12:20:00.000Z',
        updatedAt: '2026-03-07T13:00:00.000Z',
        fileCount: 6,
        reviewJson: buildReviewPayload({
          stats: {
            ...buildReviewPayload().stats,
            firstSignalMs: 5100,
            reviewTotalDurationMs: 21000,
            deepReviewedFiles: 5,
            totalChangedFiles: 6,
            reviewTier: 'full',
            omittedFiles: 1,
            perFileFailedFiles: 0,
          },
        }),
      },
    ]);

    const timeseries = await getProjectTrustAnalyticsTimeseries({
      projectId: 'proj-1',
      projectPath: '/tmp/repo',
      scope: 'prs',
      metric: 'deep_coverage_rate',
      window: '24h',
      interval: 'hour',
      now: new Date('2026-03-07T18:00:00.000Z'),
    });

    expect(timeseries.metricLabel).toBe('PR diff coverage');
    expect(timeseries.metricDescription).toContain('changed PR files');
  });
});
