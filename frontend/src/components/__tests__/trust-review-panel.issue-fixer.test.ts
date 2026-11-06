import { test, expect } from '@playwright/test';

import {
  buildFixPrompt,
  buildFixIssueFilePaths,
  buildPrCommentSelectionItems,
  buildFixSelectionItems,
  buildPersistedFixRunStatusLabel,
  buildReviewFixRunPatchSummary,
  buildReviewFixRunHistoryItems,
  buildRecommendationFixStatusesFromRun,
  buildRecommendationFixStatusesFromRuns,
  getVisibleRecommendationFixStatusLabel,
  getRecommendationVerificationState,
  getVerificationPendingRecommendationKeys,
  getRecommendationFingerprint,
} from '../review/reviewPanelUtils';
import type { ReviewFixRunArtifact } from '@/types';

const SAMPLE_REVIEW = {
  riskLevel: 'high',
  summary: 'Sample review',
  recommendations: [
    {
      recommendationKey: 'issue|high|camera-null|playerlook.cs|42',
      type: 'issue',
      severity: 'high',
      title: 'scope cameras may be null in ResetThirdPersonFromSocket',
      description: 'Null reference risk during camera reset path.',
      file: 'PlayerLook.cs',
      line: 42,
      sourceAnchor: {
        file: 'PlayerLook.cs',
        line: 42,
        snippet: 'scopeCameras.Reset();',
        reasoning: 'The call assumes scopeCameras is always initialized.',
      },
    },
    {
      recommendationKey: 'issue|low|logging|playerlook.cs|12',
      type: 'issue',
      severity: 'low',
      title: 'remove noisy debug logging',
      description: 'Optional cleanup.',
      file: 'PlayerLook.cs',
      line: 12,
    },
  ],
  stats: {
    totalAdditions: 10,
    totalDeletions: 4,
    totalChangedFiles: 1,
  },
} as any;

test.describe('issue fixer prompt helpers', () => {
  test('defaults high and medium findings in the fix selection dialog', () => {
    const items = buildFixSelectionItems(SAMPLE_REVIEW.recommendations);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: 'scope cameras may be null in ResetThirdPersonFromSocket',
      defaultSelected: true,
    });
    expect(items[1]).toMatchObject({
      title: 'remove noisy debug logging',
      defaultSelected: false,
    });
  });

  test('excludes resolved and already published findings from PR comment selection', () => {
    const firstKey = getRecommendationFingerprint(SAMPLE_REVIEW.recommendations[0]);
    const secondKey = getRecommendationFingerprint(SAMPLE_REVIEW.recommendations[1]);

    const items = buildPrCommentSelectionItems(SAMPLE_REVIEW.recommendations, {
      publishedByRecommendationKey: {
        [firstKey]: { headSha: 'old-head' },
      },
      currentHeadSha: 'new-head',
      recommendationResolutions: {
        [secondKey]: {
          state: 'addressed',
          updatedAt: '2026-04-27T00:00:00.000Z',
        },
      },
    });

    expect(items).toEqual([]);
  });

  test('defaults low-only findings in the fix selection dialog when they are the only actionable items', () => {
    const items = buildFixSelectionItems([
      {
        type: 'issue',
        severity: 'low',
        title: 'Low issue',
        description: 'A small issue.',
        file: 'src/low-issue.ts',
        line: 10,
      } as any,
      {
        type: 'suggestion',
        severity: 'low',
        title: 'Low suggestion',
        description: 'A small suggestion.',
        file: 'src/low-suggestion.ts',
        line: 20,
      } as any,
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({
      title: 'Low issue',
      defaultSelected: true,
    });
    expect(items[1]).toMatchObject({
      title: 'Low suggestion',
      defaultSelected: true,
    });
  });

  test('builds a rich fix prompt with constraints and non-goals', () => {
    const selectedRecommendationKeys = [
      getRecommendationFingerprint(SAMPLE_REVIEW.recommendations[0]),
    ];
    const prompt = buildFixPrompt({
      review: SAMPLE_REVIEW,
      contextLabel: 'feature branch vs main',
      includeResolved: false,
      recommendationResolutions: {},
      selectedRecommendationKeys,
    });

    expect(prompt).toContain('Selected findings:');
    expect(prompt).toContain('Why it matters: Null reference risk during camera reset path.');
    expect(prompt).toContain('Previous review reasoning: The call assumes scopeCameras is always initialized.');
    expect(prompt).toContain('Acceptance criteria:');
    expect(prompt).toContain('Constraints:');
    expect(prompt).toContain('Non-goals:');
    expect(prompt).toContain('Do not mark the finding addressed; leave it ready for verification.');
  });

  test('collects deterministic file-path hints for persisted coverage', () => {
    expect(buildFixIssueFilePaths(SAMPLE_REVIEW.recommendations[0])).toEqual(['PlayerLook.cs']);
  });

  test('derives verification state from fix status and reviewer resolution', () => {
    expect(getRecommendationVerificationState({
      resolution: null,
      fixStatus: 'verification_pending',
    })).toBe('verification_pending');

    expect(getRecommendationVerificationState({
      resolution: null,
      fixStatus: 'still_open',
    })).toBe('still_open');

    expect(getRecommendationVerificationState({
      resolution: {
        state: 'addressed',
        updatedAt: '2026-04-06T00:00:00.000Z',
      },
      fixStatus: 'verification_pending',
    })).toBe('addressed');
  });

  test('tracks only pending verification findings for rerun controls', () => {
    const keys = [
      getRecommendationFingerprint(SAMPLE_REVIEW.recommendations[0]),
      getRecommendationFingerprint(SAMPLE_REVIEW.recommendations[1]),
    ];
    const verificationKeys = getVerificationPendingRecommendationKeys(
      SAMPLE_REVIEW.recommendations,
      {},
      {
        [keys[0]]: {
          status: 'verification_pending',
          updatedAt: '2026-04-06T00:00:00.000Z',
        },
        [keys[1]]: {
          status: 'still_open',
          updatedAt: '2026-04-06T00:00:00.000Z',
        },
      }
    );

    expect(verificationKeys).toEqual([keys[0]]);
  });

  test('hydrates a persisted run summary without exposing transcript detail', () => {
    const recommendationKey = getRecommendationFingerprint(SAMPLE_REVIEW.recommendations[0]);
    const run: ReviewFixRunArtifact = {
      id: 'run-1',
      projectId: 'project-1',
      reviewType: 'branch_review',
      reviewId: 'br-1',
      status: 'verification_pending',
      transcriptVisibility: 'hidden',
      selectedRecommendationKeys: [recommendationKey],
      recommendationStatuses: {
        [recommendationKey]: {
          recommendationKey,
          status: 'verification_pending',
          updatedAt: '2026-04-06T10:00:00.000Z',
          filePaths: ['PlayerLook.cs'],
          error: null,
        },
      },
      buildSummary: {
        filesChanged: 1,
        filePaths: ['PlayerLook.cs'],
        newFiles: [],
        modifiedFiles: ['PlayerLook.cs'],
        changesetId: 'cs-1',
        changesetTitle: 'Fix camera null guard',
      },
      startedAt: '2026-04-06T09:59:00.000Z',
      updatedAt: '2026-04-06T10:00:00.000Z',
    };

    expect(buildPersistedFixRunStatusLabel(run)).toBe('Fix run complete. Inspect the patch and resolve the finding manually.');
    expect(buildRecommendationFixStatusesFromRun(run)).toEqual({
      [recommendationKey]: {
        status: 'verification_pending',
        updatedAt: '2026-04-06T10:00:00.000Z',
        filePaths: ['PlayerLook.cs'],
        error: null,
      },
    });
  });

  test('preserves patch-ready status for unresolved findings across recent runs', () => {
    const firstRecommendationKey = getRecommendationFingerprint(SAMPLE_REVIEW.recommendations[0]);
    const secondRecommendationKey = getRecommendationFingerprint(SAMPLE_REVIEW.recommendations[1]);

    expect(buildRecommendationFixStatusesFromRuns([
      {
        id: 'run-latest',
        projectId: 'project-1',
        reviewType: 'branch_review',
        reviewId: 'br-1',
        status: 'failed',
        transcriptVisibility: 'hidden',
        selectedRecommendationKeys: [secondRecommendationKey],
        recommendationStatuses: {
          [secondRecommendationKey]: {
            recommendationKey: secondRecommendationKey,
            status: 'failed',
            updatedAt: '2026-04-06T11:00:00.000Z',
            filePaths: [],
            error: 'CLI failed',
          },
        },
        buildSummary: null,
        error: 'CLI failed',
        startedAt: '2026-04-06T10:59:00.000Z',
        failedAt: '2026-04-06T11:00:00.000Z',
        updatedAt: '2026-04-06T11:00:00.000Z',
      },
      {
        id: 'run-older',
        projectId: 'project-1',
        reviewType: 'branch_review',
        reviewId: 'br-1',
        status: 'patch_applied',
        transcriptVisibility: 'hidden',
        selectedRecommendationKeys: [firstRecommendationKey],
        recommendationStatuses: {
          [firstRecommendationKey]: {
            recommendationKey: firstRecommendationKey,
            status: 'patch_applied',
            updatedAt: '2026-04-06T10:00:00.000Z',
            filePaths: ['PlayerLook.cs'],
            error: null,
          },
        },
        buildSummary: {
          filesChanged: 1,
          filePaths: ['PlayerLook.cs'],
          newFiles: [],
          modifiedFiles: ['PlayerLook.cs'],
          changesetId: 'cs-1',
          changesetTitle: 'Fix camera null guard',
        },
        startedAt: '2026-04-06T09:59:00.000Z',
        updatedAt: '2026-04-06T10:00:00.000Z',
      },
    ])).toEqual({
      [secondRecommendationKey]: {
        status: 'failed',
        updatedAt: '2026-04-06T11:00:00.000Z',
        filePaths: [],
        error: 'CLI failed',
      },
      [firstRecommendationKey]: {
        status: 'patch_applied',
        updatedAt: '2026-04-06T10:00:00.000Z',
        filePaths: ['PlayerLook.cs'],
        error: null,
      },
    });
  });

  test('sorts fix runs deterministically when timestamps are missing', () => {
    expect(buildRecommendationFixStatusesFromRuns([
      {
        id: 'run-a',
        projectId: 'project-1',
        reviewType: 'branch_review',
        reviewId: 'br-1',
        status: 'patch_applied',
        transcriptVisibility: 'hidden',
        selectedRecommendationKeys: ['key-a'],
        recommendationStatuses: {
          'key-a': {
            recommendationKey: 'key-a',
            status: 'patch_applied',
            updatedAt: '',
            filePaths: ['a.ts'],
            error: null,
          },
        },
        buildSummary: null,
        startedAt: '',
        updatedAt: '',
      },
      {
        id: 'run-z',
        projectId: 'project-1',
        reviewType: 'branch_review',
        reviewId: 'br-1',
        status: 'failed',
        transcriptVisibility: 'hidden',
        selectedRecommendationKeys: ['key-z'],
        recommendationStatuses: {
          'key-z': {
            recommendationKey: 'key-z',
            status: 'failed',
            updatedAt: '',
            filePaths: [],
            error: 'boom',
          },
        },
        buildSummary: null,
        startedAt: '',
        updatedAt: '',
        error: 'boom',
      },
    ])).toEqual({
      'key-z': {
        status: 'failed',
        updatedAt: '',
        filePaths: [],
        error: 'boom',
      },
      'key-a': {
        status: 'patch_applied',
        updatedAt: '',
        filePaths: ['a.ts'],
        error: null,
      },
    });
  });

  test('renders post-fix statuses as patch ready in the current simplified UX', () => {
    expect(getVisibleRecommendationFixStatusLabel('patch_applied')).toBe('patch ready');
    expect(getVisibleRecommendationFixStatusLabel('verification_pending')).toBe('patch ready');
    expect(getVisibleRecommendationFixStatusLabel('re_reviewing')).toBe('patch ready');
    expect(getVisibleRecommendationFixStatusLabel('running')).toBe('running');
  });

  test('builds summary-only run history items with verification-first and coverage-aware retry actions', () => {
    const recommendationKey = getRecommendationFingerprint(SAMPLE_REVIEW.recommendations[0]);
    const secondRecommendationKey = getRecommendationFingerprint(SAMPLE_REVIEW.recommendations[1]);
    const items = buildReviewFixRunHistoryItems({
      runs: [
        {
          id: 'run-latest',
          projectId: 'project-1',
          reviewType: 'branch_review',
          reviewId: 'br-1',
          status: 'patch_applied',
          transcriptVisibility: 'hidden',
          selectedRecommendationKeys: [recommendationKey, secondRecommendationKey],
          recommendationStatuses: {
            [recommendationKey]: {
              recommendationKey,
              status: 'patch_applied',
              updatedAt: '2026-04-06T10:00:00.000Z',
              filePaths: ['PlayerLook.cs'],
              error: null,
            },
            [secondRecommendationKey]: {
              recommendationKey: secondRecommendationKey,
              status: 'skipped',
              updatedAt: '2026-04-06T10:00:00.000Z',
              filePaths: [],
              error: null,
            },
          },
          buildSummary: {
            filesChanged: 1,
            filePaths: ['PlayerLook.cs'],
            newFiles: [],
            modifiedFiles: ['PlayerLook.cs'],
            changesetId: 'cs-1',
            changesetTitle: 'Fix camera null guard',
          },
          startedAt: '2026-04-06T09:59:00.000Z',
          updatedAt: '2026-04-06T10:00:00.000Z',
        },
        {
          id: 'run-partial',
          projectId: 'project-1',
          reviewType: 'branch_review',
          reviewId: 'br-1',
          status: 'patch_applied',
          transcriptVisibility: 'hidden',
          selectedRecommendationKeys: [secondRecommendationKey],
          recommendationStatuses: {
            [secondRecommendationKey]: {
              recommendationKey: secondRecommendationKey,
              status: 'skipped',
              updatedAt: '2026-04-06T09:55:00.000Z',
              filePaths: [],
              error: null,
            },
          },
          buildSummary: {
            filesChanged: 1,
            filePaths: ['SomeOtherFile.cs'],
            newFiles: [],
            modifiedFiles: ['SomeOtherFile.cs'],
            changesetId: 'cs-2',
            changesetTitle: 'Partial patch',
          },
          startedAt: '2026-04-06T09:54:00.000Z',
          updatedAt: '2026-04-06T09:55:00.000Z',
        },
        {
          id: 'run-older',
          projectId: 'project-1',
          reviewType: 'branch_review',
          reviewId: 'br-1',
          status: 'failed',
          transcriptVisibility: 'hidden',
          selectedRecommendationKeys: [recommendationKey],
          recommendationStatuses: {
            [recommendationKey]: {
              recommendationKey,
              status: 'failed',
              updatedAt: '2026-04-06T09:51:00.000Z',
              filePaths: [],
              error: 'CLI failed',
            },
          },
          buildSummary: null,
          error: 'CLI failed',
          startedAt: '2026-04-06T09:50:00.000Z',
          failedAt: '2026-04-06T09:51:00.000Z',
          updatedAt: '2026-04-06T09:51:00.000Z',
        },
      ],
      latestRunId: 'run-latest',
      retryableRecommendationKeys: [recommendationKey, secondRecommendationKey],
      verificationPendingRecommendationKeys: [recommendationKey],
      nowMs: Date.parse('2026-04-06T10:05:00.000Z'),
    });

    expect(items).toEqual([
      expect.objectContaining({
        id: 'run-latest',
        isLatest: true,
        action: 'retry',
        actionLabel: 'Retry',
        actionRecommendationKeys: [secondRecommendationKey],
        patchAction: 'inspect_patch',
        summaryLabel: '1 file changed',
        patchActionLabel: 'Inspect patch',
        changesetId: 'cs-1',
        changesetTitle: 'Fix camera null guard',
        fileSummaryLabel: '1 file changed · 1 modified',
        filePreviewLabel: 'PlayerLook.cs',
        coverageLabel: '1/2 selected findings touched files',
      }),
      expect.objectContaining({
        id: 'run-partial',
        isLatest: false,
        action: 'retry',
        actionLabel: 'Retry',
        actionRecommendationKeys: [secondRecommendationKey],
        patchAction: 'inspect_patch',
        summaryLabel: '1 file changed',
        patchActionLabel: 'Inspect patch',
      }),
      expect.objectContaining({
        id: 'run-older',
        isLatest: false,
        action: 'retry',
        actionLabel: 'Retry',
        actionRecommendationKeys: [recommendationKey],
        error: 'CLI failed',
      }),
    ]);
  });

  test('summarizes patch handoff metadata from persisted run artifacts', () => {
    const patchSummary = buildReviewFixRunPatchSummary({
      id: 'run-1',
      projectId: 'project-1',
      reviewType: 'branch_review',
      reviewId: 'br-1',
      status: 'patch_applied',
      transcriptVisibility: 'hidden',
      selectedRecommendationKeys: ['key-1', 'key-2'],
      recommendationStatuses: {
        'key-1': {
          recommendationKey: 'key-1',
          status: 'patch_applied',
          updatedAt: '2026-04-06T10:00:00.000Z',
          filePaths: ['PlayerLook.cs'],
          error: null,
        },
        'key-2': {
          recommendationKey: 'key-2',
          status: 'patch_applied',
          updatedAt: '2026-04-06T10:00:00.000Z',
          filePaths: [],
          error: null,
        },
      },
      buildSummary: {
        filesChanged: 2,
        filePaths: ['src/PlayerLook.cs', 'src/Weapons/GunController.cs'],
        newFiles: ['src/NewFix.cs'],
        modifiedFiles: ['src/PlayerLook.cs'],
        changesetId: 'cs-9',
        changesetTitle: 'Tighten camera reset guard',
      },
      startedAt: '2026-04-06T09:59:00.000Z',
      updatedAt: '2026-04-06T10:00:00.000Z',
    });

    expect(patchSummary).toEqual(expect.objectContaining({
      changesetId: 'cs-9',
      changesetTitle: 'Tighten camera reset guard',
      fileSummaryLabel: '2 files changed · 1 new, 1 modified',
      filePreviewLabel: 'PlayerLook.cs, GunController.cs',
      coverageLabel: '1/2 selected findings touched files',
      patchActionLabel: 'Inspect patch',
    }));
  });
});
