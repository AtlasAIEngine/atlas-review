import { describe, expect, it } from 'vitest';

import {
  REVIEW_FIX_RECOMMENDATION_STATUSES,
  REVIEW_FIX_RUN_STATUSES,
  buildReviewFixRunStatus,
  buildFixCompletionStatusEvents,
  resolveReviewFixObservedChanges,
} from '../../services/review/reviewFixEvents.js';

describe('reviewFixSocket status mapping', () => {
  it('marks only covered findings as patch_applied in multi-finding runs', () => {
    expect(buildFixCompletionStatusEvents({
      projectId: 'project-1',
      runId: 'run-1',
      recommendationKeys: ['rec-1', 'rec-2'],
      recommendationFilePathsByKey: {
        'rec-1': ['src/playerlook.cs'],
        'rec-2': ['src/playercameras.cs'],
      },
      observedFilePaths: ['src/playerlook.cs'],
      hasFileChanges: true,
    })).toEqual([
      {
        event: 'fix-status',
        data: {
          projectId: 'project-1',
          runId: 'run-1',
          recommendationKey: 'rec-1',
          status: REVIEW_FIX_RECOMMENDATION_STATUSES.patchApplied,
          filePaths: ['src/playerlook.cs'],
        },
      },
      {
        event: 'fix-status',
        data: {
          projectId: 'project-1',
          runId: 'run-1',
          recommendationKey: 'rec-2',
          status: REVIEW_FIX_RECOMMENDATION_STATUSES.skipped,
        },
      },
    ]);
  });

  it('marks stopped runs as stopped for every selected recommendation', () => {
    expect(buildFixCompletionStatusEvents({
      projectId: 'project-1',
      runId: 'run-1',
      recommendationKeys: ['rec-1'],
      wasStopped: true,
    })).toEqual([
      {
        event: 'fix-status',
        data: {
          projectId: 'project-1',
          runId: 'run-1',
          recommendationKey: 'rec-1',
          status: REVIEW_FIX_RECOMMENDATION_STATUSES.stopped,
        },
      },
    ]);
  });

  it('keeps failure terminal while preserving deterministic coverage metadata', () => {
    expect(buildFixCompletionStatusEvents({
      projectId: 'project-1',
      runId: 'run-1',
      recommendationKeys: ['rec-1'],
      recommendationFilePathsByKey: {
        'rec-1': ['src/playerlook.cs'],
      },
      observedFilePaths: ['src/playerlook.cs'],
      failed: true,
      error: 'CLI failed',
    })).toEqual([
      {
        event: 'fix-status',
        data: {
          projectId: 'project-1',
          runId: 'run-1',
          recommendationKey: 'rec-1',
          status: REVIEW_FIX_RECOMMENDATION_STATUSES.failed,
          filePaths: ['src/playerlook.cs'],
          error: 'CLI failed',
        },
      },
    ]);
  });

  it('builds a summary-level run status that stays verification-safe for multi-finding patches', () => {
    expect(buildReviewFixRunStatus({
      recommendationKeys: ['rec-1', 'rec-2'],
      hasFileChanges: true,
    })).toBe(REVIEW_FIX_RUN_STATUSES.patchApplied);

    expect(buildReviewFixRunStatus({
      recommendationKeys: ['rec-1'],
      hasFileChanges: true,
    })).toBe(REVIEW_FIX_RUN_STATUSES.verificationPending);
  });

  it('treats git-summary file paths as real observed changes when snapshot coverage is empty', () => {
    expect(resolveReviewFixObservedChanges({
      buildSummary: {
        filesChanged: 1,
        filePaths: ['Project_BLACK/BLACK_Unity/Assets/BLACK/Prototyping/Scripts/Player/PlayerCameras.cs'],
        newFiles: [],
        modifiedFiles: ['Project_BLACK/BLACK_Unity/Assets/BLACK/Prototyping/Scripts/Player/PlayerCameras.cs'],
      },
      observedFilePaths: [],
    })).toEqual({
      hasFileChanges: true,
      observedFilePaths: ['project_black/black_unity/assets/black/prototyping/scripts/player/playercameras.cs'],
    });
  });
});
