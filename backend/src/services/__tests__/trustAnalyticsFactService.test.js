import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
const getDbTypeMock = vi.fn(() => 'postgres');
const transactionMock = vi.fn();
const getChangeSetMock = vi.fn();
const getChangeSetsMock = vi.fn();
const getByIdMock = vi.fn();
const getByProjectMock = vi.fn();
const getPrByIdMock = vi.fn();
const getPrByProjectMock = vi.fn();
const listOutcomesMock = vi.fn();
const getRecommendationIdentityKeyMock = vi.fn();
const getRecommendationOutcomeDimensionsMock = vi.fn();
const getChangesetTrustAnalyticsMock = vi.fn();
const getBranchReviewTrustAnalyticsMock = vi.fn();
const getPrReviewTrustAnalyticsMock = vi.fn();

vi.mock('../../db/connection.js', () => ({
  default: {
    query: (...args) => queryMock(...args),
    getDbType: (...args) => getDbTypeMock(...args),
    transaction: (...args) => transactionMock(...args),
  },
  query: (...args) => queryMock(...args),
  getDbType: (...args) => getDbTypeMock(...args),
  transaction: (...args) => transactionMock(...args),
}));

vi.mock('../changesetService.js', () => ({
  default: {
    getChangeSet: (...args) => getChangeSetMock(...args),
    getChangeSets: (...args) => getChangeSetsMock(...args),
  },
}));

vi.mock('../branchReviewService.js', () => ({
  default: {
    getById: (...args) => getByIdMock(...args),
    getByProject: (...args) => getByProjectMock(...args),
  },
}));

vi.mock('../prReviewService.js', () => ({
  default: {
    getById: (...args) => getPrByIdMock(...args),
    getByProject: (...args) => getPrByProjectMock(...args),
  },
}));

vi.mock('../reviewOutcomeService.js', () => ({
  default: {
    listOutcomes: (...args) => listOutcomesMock(...args),
    getRecommendationIdentityKey: (...args) => getRecommendationIdentityKeyMock(...args),
    getRecommendationOutcomeDimensions: (...args) => getRecommendationOutcomeDimensionsMock(...args),
  },
}));

vi.mock('../trustAnalyticsService.js', () => ({
  getChangesetTrustAnalytics: (...args) => getChangesetTrustAnalyticsMock(...args),
  getBranchReviewTrustAnalytics: (...args) => getBranchReviewTrustAnalyticsMock(...args),
  getPrReviewTrustAnalytics: (...args) => getPrReviewTrustAnalyticsMock(...args),
  getWorkspaceReviewTrustAnalytics: vi.fn(),
}));

import trustAnalyticsFactService, {
  buildDimensionFactRows,
  buildReviewFactSnapshot,
  hydrateTrustAnalyticsFromFactSnapshot,
} from '../trustAnalyticsFactService.js';

function buildAnalytics(overrides = {}) {
  return {
    meta: {
      projectId: 'proj-1',
      reviewType: 'changeset',
      reviewId: 'cs-1',
      displayId: 'CS-001',
      branchName: 'feature/auth',
      providerType: 'claude',
      providerModel: 'sonnet-4.5',
      createdAt: '2026-03-07T09:55:00.000Z',
      completedAt: '2026-03-07T10:00:00.000Z',
    },
    immediateValue: {
      ttfsMs: 4200,
      reviewDurationMs: 18400,
      deepCoverage: {
        numerator: 8,
        denominator: 10,
      },
      issuesFound: 2,
      highRiskFindings: 1,
    },
    trustQuality: {
      groundedIssueRate: { numerator: 1, denominator: 2 },
      unsupportedIssueRate: { numerator: 1, denominator: 2 },
      lowEvidenceIssueRate: { numerator: 0, denominator: 2 },
      uncorroboratedHighRiskRate: { numerator: 0, denominator: 1 },
      outcomeSuppressionRate: { numerator: 1, denominator: 2 },
    },
    followThrough: {
      issueAddressedRate: { numerator: 1, denominator: 2 },
      issueDismissedRate: { numerator: 0, denominator: 2 },
      issueOutcomeCoverage: { numerator: 1, denominator: 2 },
      addressedCount: 1,
      dismissedCount: 0,
    },
    reliability: {
      reviewReliability: 'partial',
      gateStatus: 'warn',
      gateReasonCodes: ['coverage_low'],
      omittedFiles: 2,
      failedFiles: 1,
      reviewStatus: 'reviewed',
    },
    ...overrides,
  };
}

describe('trustAnalyticsFactService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDbTypeMock.mockReturnValue('postgres');
    transactionMock.mockImplementation(async (callback) => callback({ query: (...args) => queryMock(...args) }));
    getPrByProjectMock.mockResolvedValue([]);
  });

  it('builds snapshots and hydrates analytics with guardrail metadata intact', () => {
    const snapshot = buildReviewFactSnapshot(buildAnalytics());
    expect(snapshot).toMatchObject({
      projectId: 'proj-1',
      reviewType: 'changeset',
      reviewId: 'cs-1',
      providerModel: 'sonnet-4.5',
      deepCoverageNumerator: 8,
      deepCoverageDenominator: 10,
      groundedIssueNumerator: 1,
      groundedIssueDenominator: 2,
      issueAddressedNumerator: 1,
      issueAddressedDenominator: 2,
      omittedFiles: 2,
      failedFiles: 1,
    });

    const hydrated = hydrateTrustAnalyticsFromFactSnapshot(snapshot);
    expect(hydrated).toEqual(expect.objectContaining({
      meta: expect.objectContaining({
        projectId: 'proj-1',
        reviewType: 'changeset',
        reviewId: 'cs-1',
      }),
      immediateValue: expect.objectContaining({
        ttfsMs: 4200,
        reviewDurationMs: 18400,
        issuesFound: 2,
      }),
      followThrough: expect.objectContaining({
        addressedCount: 1,
        dismissedCount: 0,
        issueAddressedRate: expect.objectContaining({
          numerator: 1,
          denominator: 2,
          minimumSampleSize: 3,
          isInsufficientSample: true,
        }),
      }),
    }));
  });

  it('builds dimension rows from issue recommendations and persisted outcomes safely', () => {
    const authIssue = {
      type: 'issue',
      severity: 'high',
      title: 'Auth bypass',
      file: 'src/admin.ts',
    };
    const logIssue = {
      type: 'issue',
      severity: 'low',
      title: 'Log leak',
      file: 'src/log.ts',
    };
    const suggestion = {
      type: 'suggestion',
      severity: 'medium',
      title: 'Extract helper',
      file: 'src/admin.ts',
    };
    getRecommendationIdentityKeyMock.mockImplementation((recommendation) => {
      if (recommendation.title === 'Auth bypass') return 'auth-key';
      if (recommendation.title === 'Log leak') return 'log-key';
      return 'other-key';
    });
    getRecommendationOutcomeDimensionsMock.mockImplementation((recommendation) => ({
      providerType: 'claude',
      providerModel: 'sonnet-4.5',
      language: recommendation.file.endsWith('.ts') ? 'typescript' : 'unknown',
      pathPattern: recommendation.file.startsWith('src/') ? 'src/**' : 'unknown',
    }));

    const rows = buildDimensionFactRows({
      analytics: buildAnalytics(),
      reviewPayload: {
        provider: { type: 'claude', model: 'sonnet-4.5' },
        recommendations: [authIssue, authIssue, logIssue, suggestion],
      },
      outcomesByRecommendationKey: {
        'auth-key': {
          status: 'addressed',
          dimensions: {
            providerType: 'claude',
            providerModel: 'sonnet-4.5',
            language: 'typescript',
            pathPattern: 'src/**',
          },
        },
      },
    });

    expect(rows).toEqual([
      {
        recommendationKey: 'auth-key',
        providerType: 'claude',
        providerModel: 'sonnet-4.5',
        language: 'typescript',
        pathPattern: 'src/**',
        issueCount: 2,
        highRiskCount: 2,
        outcomeAddressedCount: 2,
        outcomeDismissedCount: 0,
        outcomeRecordedCount: 2,
      },
      {
        recommendationKey: 'log-key',
        providerType: 'claude',
        providerModel: 'sonnet-4.5',
        language: 'typescript',
        pathPattern: 'src/**',
        issueCount: 1,
        highRiskCount: 0,
        outcomeAddressedCount: 0,
        outcomeDismissedCount: 0,
        outcomeRecordedCount: 0,
      },
    ]);
  });

  it('syncs terminal review facts and replaces dimension rows deterministically', async () => {
    const recommendations = [
      { type: 'issue', severity: 'high', title: 'Auth bypass', file: 'src/admin.ts' },
      { type: 'issue', severity: 'low', title: 'Log leak', file: 'src/log.ts' },
    ];
    getChangeSetMock.mockResolvedValue({
      id: 'cs-1',
      projectId: 'proj-1',
      reviewData: {
        provider: { type: 'claude', model: 'sonnet-4.5' },
        recommendations,
      },
    });
    getChangesetTrustAnalyticsMock.mockResolvedValue(buildAnalytics());
    getRecommendationIdentityKeyMock.mockImplementation((recommendation) => (
      recommendation.title === 'Auth bypass' ? 'auth-key' : 'log-key'
    ));
    getRecommendationOutcomeDimensionsMock.mockImplementation((recommendation) => ({
      providerType: 'claude',
      providerModel: 'sonnet-4.5',
      language: recommendation.file.endsWith('.ts') ? 'typescript' : 'unknown',
      pathPattern: 'src/**',
    }));
    listOutcomesMock.mockResolvedValue({
      byRecommendationKey: {
        'auth-key': {
          status: 'addressed',
          dimensions: {
            providerType: 'claude',
            providerModel: 'sonnet-4.5',
            language: 'typescript',
            pathPattern: 'src/**',
          },
        },
      },
    });
    queryMock.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('INSERT INTO trust_review_facts')) {
        return {
          rows: [{
            project_id: 'proj-1',
            review_type: 'changeset',
            review_id: 'cs-1',
            display_id: 'CS-001',
            branch_name: 'feature/auth',
            review_status: 'reviewed',
            review_reliability: 'partial',
            gate_status: 'warn',
            gate_reason_codes: JSON.stringify(['coverage_low']),
            provider_type: 'claude',
            provider_model: 'sonnet-4.5',
            created_at_source: '2026-03-07T09:55:00.000Z',
            completed_at: '2026-03-07T10:00:00.000Z',
            ttfs_ms: 4200,
            review_duration_ms: 18400,
            total_changed_files: 10,
            deep_coverage_numerator: 8,
            deep_coverage_denominator: 10,
            issues_found: 2,
            high_risk_findings: 1,
            grounded_issue_numerator: 1,
            grounded_issue_denominator: 2,
            unsupported_issue_numerator: 1,
            unsupported_issue_denominator: 2,
            low_evidence_issue_numerator: 0,
            low_evidence_issue_denominator: 2,
            uncorroborated_high_risk_numerator: 0,
            uncorroborated_high_risk_denominator: 1,
            outcome_suppression_numerator: 1,
            outcome_suppression_denominator: 2,
            issue_addressed_numerator: 1,
            issue_addressed_denominator: 2,
            issue_dismissed_numerator: 0,
            issue_dismissed_denominator: 2,
            issue_outcome_coverage_numerator: 1,
            issue_outcome_coverage_denominator: 2,
            omitted_files: 2,
            failed_files: 1,
            updated_at: '2026-03-07T10:00:00.000Z',
          }],
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const result = await trustAnalyticsFactService.syncReviewFacts({
      projectPath: '/tmp/repo',
      reviewType: 'changeset',
      reviewId: 'cs-1',
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'synced',
      projectId: 'proj-1',
      reviewType: 'changeset',
      reviewId: 'cs-1',
      dimensionRowCount: 2,
    }));
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledTimes(6);
    expect(queryMock.mock.calls[0][0]).toContain('INSERT INTO trust_review_facts');
    expect(queryMock.mock.calls[1][0]).toContain('DELETE FROM trust_review_dimension_facts');
    expect(queryMock.mock.calls[2][0]).toContain('INSERT INTO trust_review_dimension_facts');
    expect(queryMock.mock.calls[3][0]).toContain('INSERT INTO trust_review_dimension_facts');
  });

  it('does not look up branch reviews while syncing PR review facts', async () => {
    getPrByIdMock.mockResolvedValue({
      id: 'pr-1',
      projectId: 'proj-1',
      reviewJson: { recommendations: [] },
    });
    getPrReviewTrustAnalyticsMock.mockResolvedValue(buildAnalytics({
      meta: {
        projectId: 'proj-1',
        reviewType: 'pr_review',
        reviewId: 'pr-1',
        displayId: 'PR-001',
        branchName: 'feature/pr',
        providerType: 'claude',
        providerModel: 'sonnet-4.5',
        createdAt: '2026-03-07T09:55:00.000Z',
        completedAt: '2026-03-07T10:00:00.000Z',
      },
    }));
    listOutcomesMock.mockResolvedValue({ byRecommendationKey: {}, telemetry: {} });
    queryMock.mockResolvedValue({ rows: [], rowCount: 1 });

    await trustAnalyticsFactService.syncReviewFacts({
      projectId: 'proj-1',
      reviewType: 'pr_review',
      reviewId: 'pr-1',
    });

    expect(getByIdMock).not.toHaveBeenCalled();
    expect(getPrByIdMock).toHaveBeenCalledWith('pr-1');
  });

  it('preserves historical facts when a review scope is non-terminal during rerun', async () => {
    getByIdMock.mockResolvedValue({
      id: 'br-1',
      projectId: 'proj-1',
      reviewStatus: 'queued',
      reviewJson: { recommendations: [] },
    });
    getBranchReviewTrustAnalyticsMock.mockResolvedValue(buildAnalytics({
      meta: {
        projectId: 'proj-1',
        reviewType: 'branch_review',
        reviewId: 'br-1',
        displayId: 'BR-001',
        branchName: 'feature/auth',
        providerType: 'openai',
        providerModel: 'gpt-5.3-codex',
        createdAt: '2026-03-07T10:00:00.000Z',
        completedAt: null,
      },
      reliability: {
        reviewReliability: 'failed',
        gateStatus: null,
        gateReasonCodes: [],
        omittedFiles: 0,
        failedFiles: 0,
        reviewStatus: 'queued',
      },
    }));

    const result = await trustAnalyticsFactService.syncReviewFacts({
      projectId: 'proj-1',
      reviewType: 'branch_review',
      reviewId: 'br-1',
    });

    expect(result).toEqual({
      status: 'skipped',
      reviewId: 'br-1',
      reason: 'review_not_terminal',
    });
    expect(transactionMock).not.toHaveBeenCalled();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('rehydrates only stale review fact scopes during merged reads', async () => {
    getChangeSetsMock.mockResolvedValue([
      {
        id: 'cs-fresh',
        reviewStatus: 'reviewed',
        updatedAt: '2026-03-07T09:00:00.000Z',
      },
      {
        id: 'cs-stale',
        reviewStatus: 'reviewed',
        updatedAt: '2026-03-07T11:00:00.000Z',
      },
    ]);
    queryMock.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('FROM trust_review_facts')) {
        return {
          rows: [
            {
              project_id: 'proj-1',
              review_type: 'changeset',
              review_id: 'cs-fresh',
              issues_found: 2,
              completed_at: '2026-03-07T10:00:00.000Z',
              updated_at: '2026-03-07T10:30:00.000Z',
            },
            {
              project_id: 'proj-1',
              review_type: 'changeset',
              review_id: 'cs-stale',
              issues_found: 1,
              completed_at: '2026-03-07T10:15:00.000Z',
              updated_at: '2026-03-07T10:00:00.000Z',
            },
          ],
        };
      }
      if (text.includes('FROM review_outcomes')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    getChangeSetMock.mockImplementation(async (_projectPath, reviewId) => {
      if (reviewId !== 'cs-stale') {
        throw new Error(`Unexpected live hydrate for ${reviewId}`);
      }
      return {
        id: 'cs-stale',
        projectId: 'proj-1',
        reviewData: {
          provider: { type: 'claude', model: 'sonnet-4.5' },
          recommendations: [],
        },
      };
    });
    getChangesetTrustAnalyticsMock.mockResolvedValue(buildAnalytics({
      meta: {
        projectId: 'proj-1',
        reviewType: 'changeset',
        reviewId: 'cs-stale',
        displayId: 'CS-STALE',
        branchName: 'feature/auth',
        providerType: 'claude',
        providerModel: 'sonnet-4.5',
        createdAt: '2026-03-07T10:10:00.000Z',
        completedAt: '2026-03-07T10:15:00.000Z',
      },
      immediateValue: {
        ttfsMs: 1200,
        reviewDurationMs: 2000,
        deepCoverage: { numerator: 1, denominator: 1 },
        issuesFound: 9,
        highRiskFindings: 0,
      },
    }));
    listOutcomesMock.mockResolvedValue({ byRecommendationKey: {} });

    const rows = await trustAnalyticsFactService.listMergedReviewFactSnapshots({
      projectId: 'proj-1',
      projectPath: '/tmp/repo',
      reviewType: 'changeset',
    });

    expect(rows).toHaveLength(2);
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ reviewId: 'cs-fresh', issuesFound: 2 }),
      expect.objectContaining({ reviewId: 'cs-stale', issuesFound: 9 }),
    ]));
    expect(getChangeSetMock).toHaveBeenCalledTimes(1);
    expect(getChangeSetMock).toHaveBeenCalledWith('/tmp/repo', 'cs-stale');
    expect(getChangesetTrustAnalyticsMock).toHaveBeenCalledTimes(1);
  });

  it('retains multiple persisted fact snapshots for repeated reruns on one branch review scope', async () => {
    getChangeSetsMock.mockResolvedValue([]);
    getPrByProjectMock.mockResolvedValue([]);
    getByProjectMock.mockResolvedValue([
      {
        id: 'br-1',
        reviewStatus: 'reviewed',
        updatedAt: '2026-03-07T11:15:00.000Z',
      },
    ]);
    queryMock.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('FROM trust_review_facts')) {
        return {
          rows: [
            {
              project_id: 'proj-1',
              review_type: 'branch_review',
              review_id: 'br-1',
              completed_at: '2026-03-07T10:00:00.000Z',
              issues_found: 2,
              updated_at: '2026-03-07T10:00:00.000Z',
            },
            {
              project_id: 'proj-1',
              review_type: 'branch_review',
              review_id: 'br-1',
              completed_at: '2026-03-07T11:00:00.000Z',
              issues_found: 3,
              updated_at: '2026-03-07T11:15:00.000Z',
            },
          ],
        };
      }
      if (text.includes('FROM review_outcomes')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    const rows = await trustAnalyticsFactService.listMergedReviewFactSnapshots({
      projectId: 'proj-1',
      projectPath: '/tmp/repo',
      reviewType: 'branch_review',
    });

    expect(rows).toHaveLength(2);
    expect(rows).toEqual([
      expect.objectContaining({
        reviewType: 'branch_review',
        reviewId: 'br-1',
        completedAt: '2026-03-07T10:00:00.000Z',
        issuesFound: 2,
      }),
      expect.objectContaining({
        reviewType: 'branch_review',
        reviewId: 'br-1',
        completedAt: '2026-03-07T11:00:00.000Z',
        issuesFound: 3,
      }),
    ]);
    expect(getByIdMock).not.toHaveBeenCalled();
    expect(getBranchReviewTrustAnalyticsMock).not.toHaveBeenCalled();
  });

  it('drops persisted review facts when the live terminal scope no longer exists', async () => {
    getChangeSetsMock.mockResolvedValue([]);
    getByProjectMock.mockResolvedValue([]);
    getPrByProjectMock.mockResolvedValue([
      {
        id: 'pr-live',
        reviewStatus: 'reviewed',
        updatedAt: '2026-03-07T10:00:00.000Z',
      },
    ]);
    queryMock.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('FROM trust_review_facts')) {
        return {
          rows: [
            {
              project_id: 'proj-1',
              review_type: 'pr_review',
              review_id: 'pr-stale',
              issues_found: 4,
              completed_at: '2026-03-07T09:30:00.000Z',
              updated_at: '2026-03-07T09:45:00.000Z',
            },
            {
              project_id: 'proj-1',
              review_type: 'pr_review',
              review_id: 'pr-live',
              issues_found: 1,
              completed_at: '2026-03-07T10:15:00.000Z',
              updated_at: '2026-03-07T10:15:00.000Z',
            },
          ],
        };
      }
      if (text.includes('FROM review_outcomes')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });

    const rows = await trustAnalyticsFactService.listMergedReviewFactSnapshots({
      projectId: 'proj-1',
      projectPath: '/tmp/repo',
      reviewType: 'pr_review',
    });

    expect(rows).toEqual([
      expect.objectContaining({
        reviewType: 'pr_review',
        reviewId: 'pr-live',
        issuesFound: 1,
      }),
    ]);
    expect(getPrByIdMock).not.toHaveBeenCalled();
    expect(getPrReviewTrustAnalyticsMock).not.toHaveBeenCalled();
  });

  it('replaces persisted review facts when newer outcome writes exist', async () => {
    getChangeSetsMock.mockResolvedValue([
      {
        id: 'cs-outcome',
        reviewStatus: 'reviewed',
        updatedAt: '2026-03-07T09:00:00.000Z',
      },
    ]);
    queryMock.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('FROM trust_review_facts')) {
        return {
          rows: [{
            project_id: 'proj-1',
            review_type: 'changeset',
            review_id: 'cs-outcome',
            issues_found: 1,
            completed_at: '2026-03-07T10:00:00.000Z',
            updated_at: '2026-03-07T10:00:00.000Z',
          }],
        };
      }
      if (text.includes('FROM review_outcomes')) {
        return {
          rows: [{
            review_type: 'changeset',
            review_id: 'cs-outcome',
            latest_updated_at: '2026-03-07T11:00:00.000Z',
          }],
        };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    getChangeSetMock.mockResolvedValue({
      id: 'cs-outcome',
      projectId: 'proj-1',
      reviewData: {
        provider: { type: 'claude', model: 'sonnet-4.5' },
        recommendations: [],
      },
    });
    getChangesetTrustAnalyticsMock.mockResolvedValue(buildAnalytics({
      meta: {
        projectId: 'proj-1',
        reviewType: 'changeset',
        reviewId: 'cs-outcome',
        displayId: 'CS-OUTCOME',
        branchName: 'feature/auth',
        providerType: 'claude',
        providerModel: 'sonnet-4.5',
        createdAt: '2026-03-07T10:05:00.000Z',
        completedAt: '2026-03-07T10:00:00.000Z',
      },
      immediateValue: {
        ttfsMs: 1000,
        reviewDurationMs: 2200,
        deepCoverage: { numerator: 1, denominator: 1 },
        issuesFound: 5,
        highRiskFindings: 1,
      },
    }));
    listOutcomesMock.mockResolvedValue({ byRecommendationKey: {} });

    const rows = await trustAnalyticsFactService.listMergedReviewFactSnapshots({
      projectId: 'proj-1',
      projectPath: '/tmp/repo',
      reviewType: 'changeset',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(expect.objectContaining({
      reviewId: 'cs-outcome',
      issuesFound: 5,
    }));
    expect(getChangeSetMock).toHaveBeenCalledTimes(1);
  });

  it('drops persisted review fact snapshots when an active scope can no longer hydrate live analytics', async () => {
    getChangeSetsMock.mockResolvedValue([]);
    getPrByProjectMock.mockResolvedValue([]);
    getByProjectMock.mockResolvedValue([
      {
        id: 'br-stale-live',
        reviewStatus: 'reviewed',
        updatedAt: '2026-03-07T11:00:00.000Z',
      },
    ]);
    queryMock.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('FROM trust_review_facts')) {
        return {
          rows: [
            {
              project_id: 'proj-1',
              review_type: 'branch_review',
              review_id: 'br-stale-live',
              issues_found: 2,
              completed_at: '2026-03-07T09:30:00.000Z',
              updated_at: '2026-03-07T09:30:00.000Z',
            },
            {
              project_id: 'proj-1',
              review_type: 'branch_review',
              review_id: 'br-stale-live',
              issues_found: 3,
              completed_at: '2026-03-07T10:00:00.000Z',
              updated_at: '2026-03-07T10:00:00.000Z',
            },
          ],
        };
      }
      if (text.includes('FROM review_outcomes')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    getByIdMock.mockResolvedValue(null);

    const rows = await trustAnalyticsFactService.listMergedReviewFactSnapshots({
      projectId: 'proj-1',
      projectPath: '/tmp/repo',
      reviewType: 'branch_review',
    });

    expect(rows).toEqual([]);
    expect(getByIdMock).toHaveBeenCalledTimes(1);
    expect(getByIdMock).toHaveBeenCalledWith('br-stale-live');
    expect(getBranchReviewTrustAnalyticsMock).not.toHaveBeenCalled();
  });

  it('rehydrates only stale dimension fact scopes during merged reads', async () => {
    getChangeSetsMock.mockResolvedValue([
      {
        id: 'cs-fresh',
        reviewStatus: 'reviewed',
        updatedAt: '2026-03-07T09:00:00.000Z',
      },
      {
        id: 'cs-stale',
        reviewStatus: 'reviewed',
        updatedAt: '2026-03-07T11:00:00.000Z',
      },
    ]);
    queryMock.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('FROM trust_review_dimension_facts')) {
        return {
          rows: [
            {
              project_id: 'proj-1',
              review_type: 'changeset',
              review_id: 'cs-fresh',
              recommendation_key: 'fresh-key',
              completed_at: '2026-03-07T10:00:00.000Z',
              provider_type: 'claude',
              provider_model: 'sonnet-4.5',
              language: 'typescript',
              path_pattern: 'src/**',
              issue_count: 2,
              high_risk_count: 0,
              outcome_addressed_count: 0,
              outcome_dismissed_count: 0,
              outcome_recorded_count: 0,
              updated_at: '2026-03-07T10:30:00.000Z',
            },
            {
              project_id: 'proj-1',
              review_type: 'changeset',
              review_id: 'cs-stale',
              recommendation_key: 'stale-key',
              completed_at: '2026-03-07T10:15:00.000Z',
              provider_type: 'claude',
              provider_model: 'sonnet-4.5',
              language: 'typescript',
              path_pattern: 'src/**',
              issue_count: 1,
              high_risk_count: 0,
              outcome_addressed_count: 0,
              outcome_dismissed_count: 0,
              outcome_recorded_count: 0,
              updated_at: '2026-03-07T10:00:00.000Z',
            },
          ],
        };
      }
      if (text.includes('FROM review_outcomes')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    getChangeSetMock.mockImplementation(async (_projectPath, reviewId) => {
      if (reviewId !== 'cs-stale') {
        throw new Error(`Unexpected live hydrate for ${reviewId}`);
      }
      return {
        id: 'cs-stale',
        projectId: 'proj-1',
        reviewData: {
          provider: { type: 'claude', model: 'sonnet-4.5' },
          recommendations: [
            { type: 'issue', severity: 'high', title: 'Auth bypass', file: 'src/admin.ts' },
            { type: 'issue', severity: 'high', title: 'Auth bypass', file: 'src/admin.ts' },
            { type: 'issue', severity: 'medium', title: 'Session leak', file: 'src/admin.ts' },
          ],
        },
      };
    });
    getChangesetTrustAnalyticsMock.mockResolvedValue(buildAnalytics({
      meta: {
        projectId: 'proj-1',
        reviewType: 'changeset',
        reviewId: 'cs-stale',
        displayId: 'CS-STALE',
        branchName: 'feature/auth',
        providerType: 'claude',
        providerModel: 'sonnet-4.5',
        createdAt: '2026-03-07T10:10:00.000Z',
        completedAt: '2026-03-07T10:20:00.000Z',
      },
    }));
    getRecommendationIdentityKeyMock.mockImplementation((recommendation) => (
      recommendation.title === 'Auth bypass' ? 'auth-key' : 'session-key'
    ));
    getRecommendationOutcomeDimensionsMock.mockReturnValue({
      providerType: 'claude',
      providerModel: 'sonnet-4.5',
      language: 'typescript',
      pathPattern: 'src/**',
    });
    listOutcomesMock.mockResolvedValue({ byRecommendationKey: {} });

    const rows = await trustAnalyticsFactService.listMergedDimensionFactRows({
      projectId: 'proj-1',
      projectPath: '/tmp/repo',
      reviewType: 'changeset',
    });

    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        reviewId: 'cs-fresh',
        recommendationKey: 'fresh-key',
        issueCount: 2,
      }),
      expect.objectContaining({
        reviewId: 'cs-stale',
        recommendationKey: 'auth-key',
        issueCount: 2,
      }),
      expect.objectContaining({
        reviewId: 'cs-stale',
        recommendationKey: 'session-key',
        issueCount: 1,
      }),
    ]));
    expect(getChangeSetMock).toHaveBeenCalledTimes(1);
    expect(getChangeSetMock).toHaveBeenCalledWith('/tmp/repo', 'cs-stale');
  });

  it('replaces stale dimension scopes without leaking removed recommendation keys', async () => {
    getChangeSetsMock.mockResolvedValue([]);
    getByProjectMock.mockResolvedValue([]);
    getPrByProjectMock.mockResolvedValue([
      {
        id: 'pr-stale',
        reviewStatus: 'reviewed',
        updatedAt: '2026-03-07T11:00:00.000Z',
      },
    ]);
    queryMock.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('FROM trust_review_dimension_facts')) {
        return {
          rows: [
            {
              project_id: 'proj-1',
              review_type: 'pr_review',
              review_id: 'pr-stale',
              recommendation_key: 'legacy-key',
              completed_at: '2026-03-07T10:00:00.000Z',
              provider_type: 'claude',
              provider_model: 'sonnet-4.5',
              language: 'typescript',
              path_pattern: 'src/**',
              issue_count: 3,
              high_risk_count: 1,
              outcome_addressed_count: 0,
              outcome_dismissed_count: 0,
              outcome_recorded_count: 0,
              updated_at: '2026-03-07T10:00:00.000Z',
            },
            {
              project_id: 'proj-1',
              review_type: 'pr_review',
              review_id: 'pr-stale',
              recommendation_key: 'keep-key',
              completed_at: '2026-03-07T10:00:00.000Z',
              provider_type: 'claude',
              provider_model: 'sonnet-4.5',
              language: 'typescript',
              path_pattern: 'src/**',
              issue_count: 1,
              high_risk_count: 0,
              outcome_addressed_count: 0,
              outcome_dismissed_count: 0,
              outcome_recorded_count: 0,
              updated_at: '2026-03-07T10:00:00.000Z',
            },
          ],
        };
      }
      if (text.includes('FROM review_outcomes')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    getPrByIdMock.mockResolvedValue({
      id: 'pr-stale',
      projectId: 'proj-1',
      reviewJson: {
        provider: { type: 'claude', model: 'sonnet-4.5' },
        recommendations: [
          { type: 'issue', severity: 'high', title: 'Keep issue', file: 'src/admin.ts' },
        ],
      },
    });
    getPrReviewTrustAnalyticsMock.mockResolvedValue(buildAnalytics({
      meta: {
        projectId: 'proj-1',
        reviewType: 'pr_review',
        reviewId: 'pr-stale',
        displayId: 'PR-001',
        branchName: 'feature/auth',
        providerType: 'claude',
        providerModel: 'sonnet-4.5',
        createdAt: '2026-03-07T10:10:00.000Z',
        completedAt: '2026-03-07T10:00:00.000Z',
      },
    }));
    getRecommendationIdentityKeyMock.mockReturnValue('keep-key');
    getRecommendationOutcomeDimensionsMock.mockReturnValue({
      providerType: 'claude',
      providerModel: 'sonnet-4.5',
      language: 'typescript',
      pathPattern: 'src/**',
    });
    listOutcomesMock.mockResolvedValue({ byRecommendationKey: {} });

    const rows = await trustAnalyticsFactService.listMergedDimensionFactRows({
      projectId: 'proj-1',
      projectPath: '/tmp/repo',
      reviewType: 'pr_review',
    });

    expect(rows).toEqual([
      expect.objectContaining({
        reviewType: 'pr_review',
        reviewId: 'pr-stale',
        recommendationKey: 'keep-key',
        issueCount: 1,
        highRiskCount: 1,
      }),
    ]);
    expect(getPrByIdMock).toHaveBeenCalledTimes(1);
    expect(getPrByIdMock).toHaveBeenCalledWith('pr-stale');
    expect(getPrReviewTrustAnalyticsMock).toHaveBeenCalledTimes(1);
  });

  it('drops persisted dimension facts when an active scope can no longer hydrate live analytics', async () => {
    getChangeSetsMock.mockResolvedValue([]);
    getPrByProjectMock.mockResolvedValue([]);
    getByProjectMock.mockResolvedValue([
      {
        id: 'br-dimension-stale',
        reviewStatus: 'reviewed',
        updatedAt: '2026-03-07T11:00:00.000Z',
      },
    ]);
    queryMock.mockImplementation(async (sql) => {
      const text = String(sql);
      if (text.includes('FROM trust_review_dimension_facts')) {
        return {
          rows: [
            {
              project_id: 'proj-1',
              review_type: 'branch_review',
              review_id: 'br-dimension-stale',
              recommendation_key: 'legacy-key',
              completed_at: '2026-03-07T09:30:00.000Z',
              provider_type: 'claude',
              provider_model: 'sonnet-4.5',
              language: 'typescript',
              path_pattern: 'src/**',
              issue_count: 2,
              high_risk_count: 1,
              outcome_addressed_count: 0,
              outcome_dismissed_count: 0,
              outcome_recorded_count: 0,
              updated_at: '2026-03-07T09:30:00.000Z',
            },
            {
              project_id: 'proj-1',
              review_type: 'branch_review',
              review_id: 'br-dimension-stale',
              recommendation_key: 'extra-key',
              completed_at: '2026-03-07T10:00:00.000Z',
              provider_type: 'claude',
              provider_model: 'sonnet-4.5',
              language: 'typescript',
              path_pattern: 'src/**',
              issue_count: 1,
              high_risk_count: 0,
              outcome_addressed_count: 0,
              outcome_dismissed_count: 0,
              outcome_recorded_count: 0,
              updated_at: '2026-03-07T10:00:00.000Z',
            },
          ],
        };
      }
      if (text.includes('FROM review_outcomes')) {
        return { rows: [] };
      }
      throw new Error(`Unexpected query: ${text}`);
    });
    getByIdMock.mockResolvedValue(null);

    const rows = await trustAnalyticsFactService.listMergedDimensionFactRows({
      projectId: 'proj-1',
      projectPath: '/tmp/repo',
      reviewType: 'branch_review',
    });

    expect(rows).toEqual([]);
    expect(getByIdMock).toHaveBeenCalledTimes(1);
    expect(getByIdMock).toHaveBeenCalledWith('br-dimension-stale');
    expect(getBranchReviewTrustAnalyticsMock).not.toHaveBeenCalled();
  });

  it('reports dry-run backfill scopes without writing rows', async () => {
    getByProjectMock.mockResolvedValue([
      { id: 'br-1', reviewStatus: 'reviewed' },
      { id: 'br-2', reviewStatus: 'reviewing' },
    ]);
    getPrByProjectMock.mockResolvedValue([
      { id: 'pr-1', reviewStatus: 'reviewed' },
      { id: 'pr-2', reviewStatus: 'queued' },
    ]);
    getChangeSetsMock.mockResolvedValue([
      { id: 'cs-1', reviewStatus: 'reviewed' },
      { id: 'cs-2', reviewStatus: 'queued' },
    ]);

    const result = await trustAnalyticsFactService.backfillProjectTrustAnalytics({
      projectId: 'proj-1',
      projectPath: '/tmp/repo',
      dryRun: true,
    });

    expect(result).toEqual({
      projectId: 'proj-1',
      reviewCount: 3,
      syncedCount: 0,
      dryRun: true,
      results: [
        {
          projectId: 'proj-1',
          projectPath: '/tmp/repo',
          reviewType: 'branch_review',
          reviewId: 'br-1',
          status: 'dry-run',
        },
        {
          projectId: 'proj-1',
          projectPath: '/tmp/repo',
          reviewType: 'changeset',
          reviewId: 'cs-1',
          status: 'dry-run',
        },
        {
          projectId: 'proj-1',
          projectPath: '/tmp/repo',
          reviewType: 'pr_review',
          reviewId: 'pr-1',
          status: 'dry-run',
        },
      ],
    });
    expect(queryMock).not.toHaveBeenCalled();
  });
});
