import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
const getDbTypeMock = vi.fn(() => 'postgres');

vi.mock('../../db/connection.js', () => ({
  default: {
    query: (...args) => queryMock(...args),
    getDbType: (...args) => getDbTypeMock(...args),
  },
  query: (...args) => queryMock(...args),
  getDbType: (...args) => getDbTypeMock(...args),
}));

import reviewOutcomeService from '../reviewOutcomeService.js';

const SAMPLE_RECOMMENDATION = Object.freeze({
  type: 'issue',
  severity: 'high',
  title: 'Authorization guard missing',
  description: 'Route is missing an authorization guard.',
  file: 'src/routes/admin.ts',
  line: 42,
  suggestedFix: 'Add requireAdmin middleware before route handler.',
});

describe('reviewOutcomeService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDbTypeMock.mockReturnValue('postgres');
  });

  it('persists recommendation outcomes with deterministic scoped identity keys', async () => {
    const recommendationKey = reviewOutcomeService.__testing.getRecommendationIdentityKey(SAMPLE_RECOMMENDATION);
    queryMock.mockResolvedValueOnce({
      rows: [{
        project_id: 'project-1',
        review_type: 'changeset',
        review_id: 'cs-1',
        recommendation_key: recommendationKey,
        status: 'addressed',
        note: 'fixed in follow-up commit',
        provider_type: 'unknown',
        provider_model: 'unknown',
        language: 'typescript',
        path_pattern: 'src/**',
        created_at: '2026-02-22T10:00:00.000Z',
        updated_at: '2026-02-22T10:00:00.000Z',
      }],
    });

    const persisted = await reviewOutcomeService.upsertOutcome(
      {
        projectId: 'project-1',
        reviewType: 'changeset',
        reviewId: 'cs-1',
      },
      {
        recommendation: SAMPLE_RECOMMENDATION,
        status: 'addressed',
        note: '  fixed in follow-up commit  ',
      }
    );

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0]).toContain('INSERT INTO review_outcomes');
    expect(queryMock.mock.calls[0][1]).toEqual([
      'project-1',
      'changeset',
      'cs-1',
      recommendationKey,
      'addressed',
      'fixed in follow-up commit',
      'unknown',
      'unknown',
      'typescript',
      'src/**',
    ]);
    expect(persisted).toEqual({
      projectId: 'project-1',
      reviewType: 'changeset',
      reviewId: 'cs-1',
      recommendationKey,
      status: 'addressed',
      note: 'fixed in follow-up commit',
      dimensions: {
        providerType: 'unknown',
        providerModel: 'unknown',
        language: 'typescript',
        pathPattern: 'src/**',
      },
      createdAt: '2026-02-22T10:00:00.000Z',
      updatedAt: '2026-02-22T10:00:00.000Z',
    });
  });

  it('normalizes typographic punctuation so recommendation keys stay stable across UI and MCP variants', () => {
    const fromUi = {
      ...SAMPLE_RECOMMENDATION,
      description: 'Verify fails with “No verification checks available” even when checks exist…',
      suggestedFix: 'Use the “full” response — do not strip metadata.',
    };
    const fromMcp = {
      ...SAMPLE_RECOMMENDATION,
      description: 'Verify fails with "No verification checks available" even when checks exist...',
      suggestedFix: 'Use the "full" response - do not strip metadata.',
    };

    expect(reviewOutcomeService.__testing.getRecommendationIdentityKey(fromUi))
      .toBe(reviewOutcomeService.__testing.getRecommendationIdentityKey(fromMcp));
  });

  it('prefers an explicit recommendationKey when one is already present', () => {
    expect(reviewOutcomeService.__testing.getRecommendationIdentityKey({
      ...SAMPLE_RECOMMENDATION,
      recommendationKey: 'Issue|High|Canonical Key',
      description: 'different description',
      suggestedFix: 'different fix',
    })).toBe('issue|high|canonical key');
  });

  it('supports addressed -> dismissed transitions and returns latest state per recommendation key', async () => {
    const recommendationKey = reviewOutcomeService.__testing.getRecommendationIdentityKey(SAMPLE_RECOMMENDATION);
    queryMock
      .mockResolvedValueOnce({
        rows: [{
          project_id: 'project-1',
          review_type: 'changeset',
          review_id: 'cs-1',
          recommendation_key: recommendationKey,
          status: 'addressed',
          note: 'initially fixed',
          provider_type: 'unknown',
          provider_model: 'unknown',
          language: 'typescript',
          path_pattern: 'src/**',
          created_at: '2026-02-22T10:00:00.000Z',
          updated_at: '2026-02-22T10:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          project_id: 'project-1',
          review_type: 'changeset',
          review_id: 'cs-1',
          recommendation_key: recommendationKey,
          status: 'dismissed',
          note: 'intentional pattern',
          provider_type: 'unknown',
          provider_model: 'unknown',
          language: 'typescript',
          path_pattern: 'src/**',
          created_at: '2026-02-22T10:00:00.000Z',
          updated_at: '2026-02-22T10:05:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            project_id: 'project-1',
            review_type: 'changeset',
            review_id: 'cs-1',
            recommendation_key: recommendationKey,
            status: 'dismissed',
            note: 'intentional pattern',
            provider_type: 'unknown',
            provider_model: 'unknown',
            language: 'typescript',
            path_pattern: 'src/**',
            created_at: '2026-02-22T10:00:00.000Z',
            updated_at: '2026-02-22T10:05:00.000Z',
          },
          {
            project_id: 'project-1',
            review_type: 'changeset',
            review_id: 'cs-1',
            recommendation_key: recommendationKey,
            status: 'addressed',
            note: 'initially fixed',
            provider_type: 'unknown',
            provider_model: 'unknown',
            language: 'typescript',
            path_pattern: 'src/**',
            created_at: '2026-02-22T10:00:00.000Z',
            updated_at: '2026-02-22T10:00:00.000Z',
          },
        ],
      });

    await reviewOutcomeService.upsertOutcome(
      { projectId: 'project-1', reviewType: 'changeset', reviewId: 'cs-1' },
      { recommendationKey, status: 'addressed', note: 'initially fixed' }
    );
    await reviewOutcomeService.upsertOutcome(
      { projectId: 'project-1', reviewType: 'changeset', reviewId: 'cs-1' },
      { recommendationKey, status: 'dismissed', note: 'intentional pattern' }
    );

    const listed = await reviewOutcomeService.listOutcomes({
      projectId: 'project-1',
      reviewType: 'changeset',
      reviewId: 'cs-1',
    });

    expect(listed.byRecommendationKey[recommendationKey]).toEqual({
      recommendationKey,
      status: 'dismissed',
      note: 'intentional pattern',
      dimensions: {
        providerType: 'unknown',
        providerModel: 'unknown',
        language: 'typescript',
        pathPattern: 'src/**',
      },
      updatedAt: '2026-02-22T10:05:00.000Z',
    });
    expect(listed.telemetry).toEqual({
      total: 1,
      addressed: 0,
      dismissed: 1,
      addressedRate: 0,
      dismissedRate: 1,
      findingTotal: 0,
      findingAddressed: 0,
      findingDismissed: 0,
      findingAddressedRate: 0,
      findingDismissedRate: 0,
      issueTotal: 0,
      issueAddressed: 0,
      issueDismissed: 0,
      issueAddressedRate: 0,
      issueDismissedRate: 0,
    });
  });

  it('normalizes empty notes to null when reading persisted outcome records', async () => {
    const recommendationKey = reviewOutcomeService.__testing.getRecommendationIdentityKey(SAMPLE_RECOMMENDATION);
    queryMock.mockResolvedValueOnce({
      rows: [{
        project_id: 'project-1',
        review_type: 'changeset',
        review_id: 'cs-1',
        recommendation_key: recommendationKey,
        status: 'addressed',
        note: '   ',
        provider_type: 'unknown',
        provider_model: 'unknown',
        language: 'typescript',
        path_pattern: 'src/**',
        created_at: '2026-02-22T10:00:00.000Z',
        updated_at: '2026-02-22T10:00:00.000Z',
      }],
    });

    const persisted = await reviewOutcomeService.upsertOutcome(
      { projectId: 'project-1', reviewType: 'changeset', reviewId: 'cs-1' },
      { recommendationKey, status: 'addressed', note: '' }
    );

    expect(persisted?.note).toBeNull();
  });

  it('lists bounded project historical findings for changed paths using exact-path and path-pattern matches', async () => {
    const exactRecommendationKey = reviewOutcomeService.__testing.getRecommendationIdentityKey({
      type: 'issue',
      severity: 'high',
      title: 'Authorization guard missing',
      description: 'Route is missing an authorization guard.',
      file: 'src/routes/admin.ts',
      line: 42,
      suggestedFix: 'Add requireAdmin middleware before route handler.',
    });
    const siblingRecommendationKey = reviewOutcomeService.__testing.getRecommendationIdentityKey({
      type: 'issue',
      severity: 'medium',
      title: 'Input validation missing',
      description: 'Sibling route skips validation.',
      file: 'src/routes/users.ts',
      line: 14,
      suggestedFix: 'Validate request body.',
    });
    const broadRecommendationKey = reviewOutcomeService.__testing.getRecommendationIdentityKey({
      type: 'issue',
      severity: 'high',
      title: 'Unrelated subsystem issue',
      description: 'Different subsystem under the same repo-wide path bucket.',
      file: 'src/payments/processor.ts',
      line: 27,
      suggestedFix: 'Add payment retry guard.',
    });

    queryMock.mockResolvedValueOnce({
      rows: [
        {
          project_id: 'project-1',
          review_type: 'pr_review',
          review_id: 'pr-10',
          recommendation_key: exactRecommendationKey,
          status: 'addressed',
          note: null,
          provider_type: 'openai',
          provider_model: 'gpt-5.3-codex',
          language: 'typescript',
          path_pattern: 'src/**',
          created_at: '2026-04-10T10:00:00.000Z',
          updated_at: '2026-04-10T10:00:00.000Z',
        },
        {
          project_id: 'project-1',
          review_type: 'pr_review',
          review_id: 'pr-09',
          recommendation_key: exactRecommendationKey,
          status: 'dismissed',
          note: null,
          provider_type: 'openai',
          provider_model: 'gpt-5.3-codex',
          language: 'typescript',
          path_pattern: 'src/**',
          created_at: '2026-04-09T10:00:00.000Z',
          updated_at: '2026-04-09T10:00:00.000Z',
        },
        {
          project_id: 'project-1',
          review_type: 'branch_review',
          review_id: 'br-02',
          recommendation_key: siblingRecommendationKey,
          status: 'dismissed',
          note: null,
          provider_type: 'openai',
          provider_model: 'gpt-5.3-codex',
          language: 'typescript',
          path_pattern: 'src/**',
          created_at: '2026-04-08T10:00:00.000Z',
          updated_at: '2026-04-08T10:00:00.000Z',
        },
        {
          project_id: 'project-1',
          review_type: 'branch_review',
          review_id: 'br-01',
          recommendation_key: broadRecommendationKey,
          status: 'addressed',
          note: null,
          provider_type: 'openai',
          provider_model: 'gpt-5.3-codex',
          language: 'typescript',
          path_pattern: 'src/**',
          created_at: '2026-04-07T10:00:00.000Z',
          updated_at: '2026-04-07T10:00:00.000Z',
        },
      ],
    });

    const result = await reviewOutcomeService.listProjectHistoricalFindings('project-1', {
      changedPaths: ['src/routes/admin.ts'],
      maxFindings: 5,
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0]).toContain('FROM review_outcomes');
    expect(result.changedPaths).toEqual(['src/routes/admin.ts']);
    expect(result.findings).toEqual([
      expect.objectContaining({
        recommendationKey: exactRecommendationKey,
        matchType: 'exact_path',
        matchValue: 'src/routes/admin.ts',
        addressedCount: 1,
        dismissedCount: 1,
        totalCount: 2,
        lastStatus: 'addressed',
        relevance: 'Exact-path history for src/routes/admin.ts',
        recommendation: expect.objectContaining({
          title: 'authorization guard missing',
          file: 'src/routes/admin.ts',
          line: 42,
        }),
      }),
      expect.objectContaining({
        recommendationKey: siblingRecommendationKey,
        matchType: 'path_pattern',
        matchValue: 'src/**',
        addressedCount: 0,
        dismissedCount: 1,
        totalCount: 1,
        relevance: 'Path-pattern history near src/routes/admin.ts',
        pathAffinityScore: expect.any(Number),
        recommendation: expect.objectContaining({
          title: 'input validation missing',
          file: 'src/routes/users.ts',
        }),
      }),
    ]);
  });

  it('prefers path-local history that also matches the changed bug family', async () => {
    const targetRecommendationKey = reviewOutcomeService.__testing.getRecommendationIdentityKey({
      type: 'issue',
      severity: 'high',
      title: 'Missing unsubscribe on scene teardown',
      description: 'FeatureVisited subscription is never removed during teardown.',
      file: 'Project_BLACK/BLACK_Unity/Assets/BLACK/FTUE/CombatHints/Scripts/CombatHintMarker.cs',
      line: 17,
      suggestedFix: 'Remove FeatureVisited subscription in OnDestroy.',
    });
    const noisyRecommendationKey = reviewOutcomeService.__testing.getRecommendationIdentityKey({
      type: 'issue',
      severity: 'high',
      title: 'Environment comparisons need normalization before matching',
      description: 'Comma-separated environment values need trimming before comparison.',
      file: 'Project_BLACK/BLACK_Unity/Assets/BLACK/Prototyping/Scripts/SheetValidation/CrossSheetValidators/ItemCrossSheetValidator.cs',
      line: 58,
      suggestedFix: 'Normalize and split environment tokens before equality checks.',
    });

    queryMock.mockResolvedValueOnce({
      rows: [
        {
          project_id: 'project-1',
          review_type: 'pr_review',
          review_id: 'pr-1',
          recommendation_key: targetRecommendationKey,
          status: 'addressed',
          note: null,
          provider_type: 'openai',
          provider_model: 'gpt-5.3-codex',
          language: 'csharp',
          path_pattern: 'project_black/**',
          created_at: '2026-04-10T10:00:00.000Z',
          updated_at: '2026-04-10T10:00:00.000Z',
        },
        {
          project_id: 'project-1',
          review_type: 'pr_review',
          review_id: 'pr-2',
          recommendation_key: noisyRecommendationKey,
          status: 'addressed',
          note: null,
          provider_type: 'openai',
          provider_model: 'gpt-5.3-codex',
          language: 'csharp',
          path_pattern: 'project_black/**',
          created_at: '2026-04-09T10:00:00.000Z',
          updated_at: '2026-04-09T10:00:00.000Z',
        },
      ],
    });

    const result = await reviewOutcomeService.listProjectHistoricalFindings('project-1', {
      changedPaths: ['Project_BLACK/BLACK_Unity/Assets/BLACK/FTUE/CombatHints/Scripts/CombatHintMarker.cs'],
      changedRecommendations: [
        {
          file: 'Project_BLACK/BLACK_Unity/Assets/BLACK/FTUE/CombatHints/Scripts/CombatHintMarker.cs',
          title: 'FeatureVisited subscription is never removed',
          description: 'The new event subscription is missing teardown cleanup and unsubscribe logic.',
          suggestedFix: 'Unsubscribe in OnDestroy.',
        },
      ],
      maxFindings: 5,
    });

    expect(result.findings).toEqual([
      expect.objectContaining({
        recommendationKey: targetRecommendationKey,
        familyAffinityScore: expect.any(Number),
        bugClass: 'missing_unsubscribe',
        bugClassMatched: true,
        familyAffinityOverlapTokens: expect.arrayContaining(['featurevisited', 'unsubscribe']),
      }),
    ]);
  });

  it('treats exact-path history as case-insensitive when recommendation keys normalize file paths', async () => {
    const recommendationKey = reviewOutcomeService.__testing.getRecommendationIdentityKey({
      type: 'issue',
      severity: 'high',
      title: 'Missing unsubscribe on scene teardown',
      description: 'FeatureVisited subscription is never removed during teardown.',
      file: 'Project_BLACK/BLACK_Unity/Assets/BLACK/FTUE/CombatHints/Scripts/CombatHintMarker.cs',
      line: 17,
      suggestedFix: 'Remove FeatureVisited subscription in OnDestroy.',
    });

    queryMock.mockResolvedValueOnce({
      rows: [
        {
          project_id: 'project-1',
          review_type: 'pr_review',
          review_id: 'pr-1',
          recommendation_key: recommendationKey,
          status: 'addressed',
          note: null,
          provider_type: 'openai',
          provider_model: 'gpt-5.3-codex',
          language: 'csharp',
          path_pattern: 'project_black/**',
          created_at: '2026-04-10T10:00:00.000Z',
          updated_at: '2026-04-10T10:00:00.000Z',
        },
      ],
    });

    const result = await reviewOutcomeService.listProjectHistoricalFindings('project-1', {
      changedPaths: ['Project_BLACK/BLACK_Unity/Assets/BLACK/FTUE/CombatHints/Scripts/CombatHintMarker.cs'],
      changedRecommendations: [
        {
          file: 'Project_BLACK/BLACK_Unity/Assets/BLACK/FTUE/CombatHints/Scripts/CombatHintMarker.cs',
          title: 'CombatHintMarker teardown cleanup',
          description: 'Subscription cleanup is missing.',
        },
      ],
      maxFindings: 5,
    });

    expect(result.findings).toEqual([
      expect.objectContaining({
        recommendationKey,
        matchType: 'exact_path',
        matchValue: 'project_black/black_unity/assets/black/ftue/combathints/scripts/combathintmarker.cs',
        pathAffinityScore: 1,
        relevance: 'Exact-path history for project_black/black_unity/assets/black/ftue/combathints/scripts/combathintmarker.cs',
      }),
    ]);
  });

  it('counts duplicate issue fingerprints in outcome telemetry without undercounting collisions', async () => {
    const recommendationKey = reviewOutcomeService.__testing.getRecommendationIdentityKey(SAMPLE_RECOMMENDATION);
    queryMock.mockResolvedValueOnce({
      rows: [{
        project_id: 'project-1',
        review_type: 'changeset',
        review_id: 'cs-1',
        recommendation_key: recommendationKey,
        status: 'addressed',
        note: null,
        provider_type: 'unknown',
        provider_model: 'unknown',
        language: 'typescript',
        path_pattern: 'src/**',
        created_at: '2026-02-22T10:00:00.000Z',
        updated_at: '2026-02-22T10:00:00.000Z',
      }],
    });

    const duplicateRecommendation = {
      ...SAMPLE_RECOMMENDATION,
    };
    const listed = await reviewOutcomeService.listOutcomes(
      { projectId: 'project-1', reviewType: 'changeset', reviewId: 'cs-1' },
      {
        reviewRecommendations: [
          SAMPLE_RECOMMENDATION,
          duplicateRecommendation,
        ],
      }
    );

    expect(listed.telemetry.issueTotal).toBe(2);
    expect(listed.telemetry.issueAddressed).toBe(2);
    expect(listed.telemetry.issueDismissed).toBe(0);
    expect(listed.telemetry.issueAddressedRate).toBe(1);
  });

  it('builds distinct scoped keys for different review identities', () => {
    const scopedA = reviewOutcomeService.__testing.buildScopedOutcomeKey({
      projectId: 'project-1',
      reviewType: 'changeset',
      reviewId: 'cs-1',
      recommendationKey: 'key-1',
    });
    const scopedB = reviewOutcomeService.__testing.buildScopedOutcomeKey({
      projectId: 'project-1',
      reviewType: 'branch_review',
      reviewId: 'br-1',
      recommendationKey: 'key-1',
    });

    expect(scopedA).toBe('project-1|changeset|cs-1|key-1');
    expect(scopedB).toBe('project-1|branch_review|br-1|key-1');
    expect(scopedA).not.toBe(scopedB);
  });

  it('deletes outcomes by scoped recommendation identity key', async () => {
    const recommendationKey = reviewOutcomeService.__testing.getRecommendationIdentityKey(SAMPLE_RECOMMENDATION);
    queryMock.mockResolvedValueOnce({
      rows: [{
        project_id: 'project-1',
        review_type: 'changeset',
        review_id: 'cs-1',
        recommendation_key: recommendationKey,
        status: 'addressed',
        note: 'fixed',
        created_at: '2026-02-22T10:00:00.000Z',
        updated_at: '2026-02-22T10:02:00.000Z',
      }],
      rowCount: 1,
    });

    const deleted = await reviewOutcomeService.deleteOutcome(
      { projectId: 'project-1', reviewType: 'changeset', reviewId: 'cs-1' },
      { recommendation: SAMPLE_RECOMMENDATION }
    );

    expect(queryMock.mock.calls[0][0]).toContain('DELETE FROM review_outcomes');
    expect(queryMock.mock.calls[0][1]).toEqual([
      'project-1',
      'changeset',
      'cs-1',
      recommendationKey,
    ]);
    expect(deleted?.recommendationKey).toBe(recommendationKey);
  });

  it('aggregates project-scoped outcome history by recommendation key with bounded per-key samples', async () => {
    const keyA = reviewOutcomeService.__testing.getRecommendationIdentityKey(SAMPLE_RECOMMENDATION);
    const keyB = `${keyA}|variant`;
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          project_id: 'project-1',
          review_type: 'changeset',
          review_id: 'cs-3',
          recommendation_key: keyA,
          status: 'dismissed',
          note: null,
          created_at: '2026-02-22T10:10:00.000Z',
          updated_at: '2026-02-22T10:10:00.000Z',
        },
        {
          project_id: 'project-1',
          review_type: 'changeset',
          review_id: 'cs-2',
          recommendation_key: keyA,
          status: 'dismissed',
          note: null,
          created_at: '2026-02-22T10:05:00.000Z',
          updated_at: '2026-02-22T10:05:00.000Z',
        },
        {
          project_id: 'project-1',
          review_type: 'changeset',
          review_id: 'cs-1',
          recommendation_key: keyA,
          status: 'addressed',
          note: null,
          created_at: '2026-02-22T10:00:00.000Z',
          updated_at: '2026-02-22T10:00:00.000Z',
        },
        {
          project_id: 'project-1',
          review_type: 'branch_review',
          review_id: 'br-1',
          recommendation_key: keyB,
          status: 'dismissed',
          note: null,
          created_at: '2026-02-22T10:00:00.000Z',
          updated_at: '2026-02-22T10:00:00.000Z',
        },
      ],
    });

    const history = await reviewOutcomeService.listProjectOutcomesByRecommendationKeys(
      'project-1',
      [keyA, keyB],
      { maxPerKey: 2, maxRows: 20 }
    );

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0]).toContain('FROM review_outcomes');
    expect(history.byRecommendationKey[keyA]).toMatchObject({
      recommendationKey: keyA,
      total: 2,
      dismissed: 2,
      addressed: 0,
      dismissedRate: 1,
    });
    expect(history.byRecommendationKey[keyB]).toMatchObject({
      recommendationKey: keyB,
      total: 1,
      dismissed: 1,
      addressed: 0,
      dismissedRate: 1,
    });
  });

  it('filters project outcome history using dimension-aware buckets per recommendation key', async () => {
    const recommendationKey = reviewOutcomeService.__testing.getRecommendationIdentityKey({
      ...SAMPLE_RECOMMENDATION,
      severity: 'medium',
    });
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          project_id: 'project-1',
          review_type: 'changeset',
          review_id: 'cs-3',
          recommendation_key: recommendationKey,
          status: 'dismissed',
          note: null,
          provider_type: 'openai',
          provider_model: 'gpt-5.3-codex',
          language: 'typescript',
          path_pattern: 'src/**',
          created_at: '2026-02-22T10:10:00.000Z',
          updated_at: '2026-02-22T10:10:00.000Z',
        },
        {
          project_id: 'project-1',
          review_type: 'changeset',
          review_id: 'cs-2',
          recommendation_key: recommendationKey,
          status: 'dismissed',
          note: null,
          provider_type: 'anthropic',
          provider_model: 'claude-sonnet-4.5',
          language: 'typescript',
          path_pattern: 'src/**',
          created_at: '2026-02-22T10:05:00.000Z',
          updated_at: '2026-02-22T10:05:00.000Z',
        },
      ],
    });

    const history = await reviewOutcomeService.listProjectOutcomesByRecommendationKeys(
      'project-1',
      [recommendationKey],
      {
        maxPerKey: 10,
        maxRows: 20,
        dimensionsByRecommendationKey: {
          [recommendationKey]: {
            providerType: 'openai',
            providerModel: 'gpt-5.3-codex',
            language: 'typescript',
            pathPattern: 'src/**',
          },
        },
      }
    );

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('WITH scoped AS');
    expect(sql).toContain("COALESCE(provider_type, 'unknown')");
    expect(sql).toContain('ROW_NUMBER() OVER (PARTITION BY recommendation_key ORDER BY updated_at DESC)');
    expect(params).toEqual([
      'project-1',
      recommendationKey,
      'openai',
      'gpt-5.3-codex',
      'typescript',
      'src/**',
      10,
      20,
    ]);

    expect(history.byRecommendationKey[recommendationKey]).toMatchObject({
      recommendationKey,
      total: 1,
      dismissed: 1,
      addressed: 0,
      dismissedRate: 1,
      dimensions: {
        providerType: 'openai',
        providerModel: 'gpt-5.3-codex',
        language: 'typescript',
        pathPattern: 'src/**',
      },
    });
  });

  it('counts issue outcomes across selected review scopes', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        { status: 'addressed', cnt: 5 },
        { status: 'dismissed', cnt: 2 },
      ],
    });

    const totals = await reviewOutcomeService.countIssueOutcomesForReviewScopes({
      projectId: 'project-1',
      reviewScopes: [
        { reviewType: 'branch_review', reviewId: 'br-1' },
        { reviewType: 'pr_review', reviewId: 'pr-1' },
        { reviewType: 'branch_review', reviewId: 'br-1' },
      ],
    });

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('recommendation_key LIKE');
    expect(sql).toContain('(review_type = $2 AND review_id = $3)');
    expect(sql).toContain('(review_type = $4 AND review_id = $5)');
    expect(params).toEqual([
      'project-1',
      'branch_review',
      'br-1',
      'pr_review',
      'pr-1',
      'issue|%',
    ]);
    expect(totals).toEqual({
      total: 7,
      addressed: 5,
      dismissed: 2,
      addressedRate: 5 / 7,
      dismissedRate: 2 / 7,
    });
  });

  it('returns zero issue totals when no valid review scopes are provided', async () => {
    const totals = await reviewOutcomeService.countIssueOutcomesForReviewScopes({
      projectId: 'project-1',
      reviewScopes: [{ reviewType: 'invalid', reviewId: 'nope' }],
    });

    expect(queryMock).not.toHaveBeenCalled();
    expect(totals).toEqual({
      total: 0,
      addressed: 0,
      dismissed: 0,
      addressedRate: 0,
      dismissedRate: 0,
    });
  });

  it('rejects unbounded review scope lists when counting issue outcomes', async () => {
    await expect(reviewOutcomeService.countIssueOutcomesForReviewScopes({
      projectId: 'project-1',
      reviewScopes: new Array(501).fill(null).map((_, index) => ({
        reviewType: 'branch_review',
        reviewId: `br-${index}`,
      })),
    })).rejects.toThrow('Too many review scopes requested for outcome counting');

    expect(queryMock).not.toHaveBeenCalled();
  });
});
