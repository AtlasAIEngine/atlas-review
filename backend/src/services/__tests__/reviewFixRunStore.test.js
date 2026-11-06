import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
const transactionMock = vi.fn(async (callback) => callback({ query: queryMock }));
const getDbTypeMock = vi.fn(() => 'postgres');

vi.mock('../../db/connection.js', () => ({
  default: {
    query: (...args) => queryMock(...args),
  },
  transaction: (...args) => transactionMock(...args),
  getDbType: (...args) => getDbTypeMock(...args),
}));

import reviewFixRunStore from '../review/reviewFixRunStore.js';
import { REVIEW_FIX_RECOMMENDATION_STATUSES, REVIEW_FIX_RUN_STATUSES } from '../review/reviewFixEvents.js';

describe('reviewFixRunStore', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getDbTypeMock.mockReturnValue('postgres');
    queryMock.mockResolvedValue({ rows: [] });
  });

  it('creates hidden-transcript run artifacts with running recommendation states', async () => {
    queryMock.mockImplementation(async (sql) => {
      if (String(sql).includes('RETURNING id, project_id')) {
        return {
          rows: [{
            id: 'run-1',
            project_id: 'project-1',
            review_type: 'branch_review',
            review_id: 'br-1',
            status: 'running',
            transcript_visibility: 'hidden',
            provider_type: 'openai',
            provider_model: 'gpt-5.4',
            selected_recommendation_keys: JSON.stringify(['rec-1']),
            recommendation_statuses: JSON.stringify({
              'rec-1': {
                recommendationKey: 'rec-1',
                status: 'running',
                updatedAt: '2026-04-06T10:00:00.000Z',
                filePaths: [],
                error: null,
              },
            }),
            build_summary: null,
            error: null,
            started_at: '2026-04-06T10:00:00.000Z',
            completed_at: null,
            stopped_at: null,
            failed_at: null,
            created_at: '2026-04-06T10:00:00.000Z',
            updated_at: '2026-04-06T10:00:00.000Z',
          }],
        };
      }
      return { rows: [] };
    });

    const created = await reviewFixRunStore.createRun({
      runId: 'run-1',
      projectId: 'project-1',
      reviewType: 'branch_review',
      reviewId: 'br-1',
      providerType: 'openai',
      providerModel: 'gpt-5.4',
      selectedRecommendationKeys: ['rec-1'],
      startedAt: '2026-04-06T10:00:00.000Z',
    });

    expect(created).toMatchObject({
      id: 'run-1',
      projectId: 'project-1',
      reviewType: 'branch_review',
      reviewId: 'br-1',
      status: 'running',
      transcriptVisibility: 'hidden',
      selectedRecommendationKeys: ['rec-1'],
      recommendationStatuses: {
        'rec-1': {
          recommendationKey: 'rec-1',
          status: 'running',
          updatedAt: '2026-04-06T10:00:00.000Z',
          filePaths: [],
          error: null,
        },
      },
    });
  });

  it('merges terminal recommendation statuses and build summaries on update', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{
          id: 'run-1',
          project_id: 'project-1',
          review_type: 'branch_review',
          review_id: 'br-1',
          status: 'running',
          transcript_visibility: 'hidden',
          provider_type: 'openai',
          provider_model: 'gpt-5.4',
          selected_recommendation_keys: JSON.stringify(['rec-1']),
          recommendation_statuses: JSON.stringify({
            'rec-1': {
              recommendationKey: 'rec-1',
              status: 'running',
              updatedAt: '2026-04-06T10:00:00.000Z',
              filePaths: [],
              error: null,
            },
          }),
          build_summary: null,
          error: null,
          started_at: '2026-04-06T10:00:00.000Z',
          completed_at: null,
          stopped_at: null,
          failed_at: null,
          created_at: '2026-04-06T10:00:00.000Z',
          updated_at: '2026-04-06T10:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'run-1',
          project_id: 'project-1',
          review_type: 'branch_review',
          review_id: 'br-1',
          status: 'verification_pending',
          transcript_visibility: 'hidden',
          provider_type: 'openai',
          provider_model: 'gpt-5.4',
          selected_recommendation_keys: JSON.stringify(['rec-1']),
          recommendation_statuses: JSON.stringify({
            'rec-1': {
              recommendationKey: 'rec-1',
              status: 'verification_pending',
              updatedAt: '2026-04-06T10:02:00.000Z',
              filePaths: ['src/example.ts'],
              error: null,
            },
          }),
          build_summary: JSON.stringify({
            filesChanged: 1,
            filePaths: ['src/example.ts'],
            newFiles: [],
            modifiedFiles: ['src/example.ts'],
            changesetId: 'cs-1',
            changesetTitle: 'Fix example',
          }),
          error: null,
          started_at: '2026-04-06T10:00:00.000Z',
          completed_at: '2026-04-06T10:02:00.000Z',
          stopped_at: null,
          failed_at: null,
          created_at: '2026-04-06T10:00:00.000Z',
          updated_at: '2026-04-06T10:02:00.000Z',
        }],
      });

    const updated = await reviewFixRunStore.updateRun('run-1', {
      status: REVIEW_FIX_RUN_STATUSES.verificationPending,
      completedAt: '2026-04-06T10:02:00.000Z',
      recommendationStatuses: {
        'rec-1': {
          recommendationKey: 'rec-1',
          status: 'verification_pending',
          updatedAt: '2026-04-06T10:02:00.000Z',
        },
      },
      buildSummary: {
        filesChanged: 1,
        filePaths: ['src/example.ts'],
        newFiles: [],
        modifiedFiles: ['src/example.ts'],
        changesetId: 'cs-1',
        changesetTitle: 'Fix example',
      },
    });

    expect(updated).toMatchObject({
      id: 'run-1',
      status: 'verification_pending',
      completedAt: '2026-04-06T10:02:00.000Z',
      buildSummary: {
        filesChanged: 1,
        filePaths: ['src/example.ts'],
        newFiles: [],
        modifiedFiles: ['src/example.ts'],
        changesetId: 'cs-1',
        changesetTitle: 'Fix example',
      },
      recommendationStatuses: {
        'rec-1': {
          recommendationKey: 'rec-1',
          status: 'verification_pending',
          updatedAt: '2026-04-06T10:02:00.000Z',
          filePaths: ['src/example.ts'],
          error: null,
        },
      },
    });
    expect(transactionMock).toHaveBeenCalledTimes(1);
  });

  it('normalizes persisted coverage metadata on update', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [{
          id: 'run-2',
          project_id: 'project-1',
          review_type: 'branch_review',
          review_id: 'br-1',
          status: 'running',
          transcript_visibility: 'hidden',
          provider_type: 'openai',
          provider_model: 'gpt-5.4',
          selected_recommendation_keys: JSON.stringify(['rec-1', 'rec-2']),
          recommendation_statuses: JSON.stringify({
            'rec-1': {
              recommendationKey: 'rec-1',
              status: 'running',
              updatedAt: '2026-04-06T10:00:00.000Z',
              filePaths: [],
              error: null,
            },
            'rec-2': {
              recommendationKey: 'rec-2',
              status: 'running',
              updatedAt: '2026-04-06T10:00:00.000Z',
              filePaths: [],
              error: null,
            },
          }),
          build_summary: null,
          error: null,
          started_at: '2026-04-06T10:00:00.000Z',
          completed_at: null,
          stopped_at: null,
          failed_at: null,
          created_at: '2026-04-06T10:00:00.000Z',
          updated_at: '2026-04-06T10:00:00.000Z',
        }],
      })
      .mockResolvedValueOnce({
        rows: [{
          id: 'run-2',
          project_id: 'project-1',
          review_type: 'branch_review',
          review_id: 'br-1',
          status: 'patch_applied',
          transcript_visibility: 'hidden',
          provider_type: 'openai',
          provider_model: 'gpt-5.4',
          selected_recommendation_keys: JSON.stringify(['rec-1', 'rec-2']),
          recommendation_statuses: JSON.stringify({
            'rec-1': {
              recommendationKey: 'rec-1',
              status: 'patch_applied',
              updatedAt: '2026-04-06T10:03:00.000Z',
              filePaths: ['src/example.ts'],
              error: null,
            },
            'rec-2': {
              recommendationKey: 'rec-2',
              status: 'skipped',
              updatedAt: '2026-04-06T10:03:00.000Z',
              filePaths: [],
              error: null,
            },
          }),
          build_summary: JSON.stringify({
            filesChanged: 1,
            filePaths: ['src/example.ts'],
            newFiles: [],
            modifiedFiles: ['src/example.ts'],
            changesetId: null,
            changesetTitle: null,
          }),
          error: null,
          started_at: '2026-04-06T10:00:00.000Z',
          completed_at: '2026-04-06T10:03:00.000Z',
          stopped_at: null,
          failed_at: null,
          created_at: '2026-04-06T10:00:00.000Z',
          updated_at: '2026-04-06T10:03:00.000Z',
        }],
      });

    const updated = await reviewFixRunStore.updateRun('run-2', {
      status: REVIEW_FIX_RUN_STATUSES.patchApplied,
      completedAt: '2026-04-06T10:03:00.000Z',
      recommendationStatuses: {
        'REC-1': {
          recommendationKey: 'REC-1',
          status: 'patch_applied',
          updatedAt: '2026-04-06T10:03:00.000Z',
          filePaths: ['./src/example.ts', 'src\\\\example.ts'],
        },
        'rec-2': {
          recommendationKey: 'rec-2',
          status: 'skipped',
          updatedAt: '2026-04-06T10:03:00.000Z',
          filePaths: [],
          error: '',
        },
      },
    });

    expect(updated?.recommendationStatuses).toEqual({
      'rec-1': {
        recommendationKey: 'rec-1',
        status: 'patch_applied',
        updatedAt: '2026-04-06T10:03:00.000Z',
        filePaths: ['src/example.ts'],
        error: null,
      },
      'rec-2': {
        recommendationKey: 'rec-2',
        status: 'skipped',
        updatedAt: '2026-04-06T10:03:00.000Z',
        filePaths: [],
        error: null,
      },
    });
  });

  it('marks orphaned running runs as stopped during startup reconciliation', async () => {
    const runningRunRow = {
      id: 'run-orphaned',
      project_id: 'project-1',
      review_type: 'branch_review',
      review_id: 'br-1',
      status: REVIEW_FIX_RUN_STATUSES.running,
      transcript_visibility: 'hidden',
      provider_type: 'openai',
      provider_model: 'gpt-5.4',
      selected_recommendation_keys: JSON.stringify(['rec-1']),
      recommendation_statuses: JSON.stringify({
        'rec-1': {
          recommendationKey: 'rec-1',
          status: REVIEW_FIX_RECOMMENDATION_STATUSES.running,
          updatedAt: '2026-04-06T10:00:00.000Z',
          filePaths: ['src/example.ts'],
          error: null,
        },
      }),
      build_summary: null,
      error: null,
      started_at: '2026-04-06T10:00:00.000Z',
      completed_at: null,
      stopped_at: null,
      failed_at: null,
      created_at: '2026-04-06T10:00:00.000Z',
      updated_at: '2026-04-06T10:00:00.000Z',
    };
    const stoppedRunRow = {
      ...runningRunRow,
      status: REVIEW_FIX_RUN_STATUSES.stopped,
      recommendation_statuses: JSON.stringify({
        'rec-1': {
          recommendationKey: 'rec-1',
          status: REVIEW_FIX_RECOMMENDATION_STATUSES.stopped,
          updatedAt: '2026-04-06T10:05:00.000Z',
          filePaths: ['src/example.ts'],
          error: 'Backend restarted before this fix run finished.',
        },
      }),
      error: 'Backend restarted before this fix run finished.',
      stopped_at: '2026-04-06T10:05:00.000Z',
      updated_at: '2026-04-06T10:05:00.000Z',
    };

    queryMock
      .mockResolvedValueOnce({ rows: [runningRunRow] })
      .mockResolvedValueOnce({ rows: [runningRunRow] })
      .mockResolvedValueOnce({ rows: [stoppedRunRow] });

    const updatedCount = await reviewFixRunStore.markRunningRunsStopped({
      stoppedAt: '2026-04-06T10:05:00.000Z',
    });

    expect(updatedCount).toBe(1);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('WHERE status = $1'),
      [REVIEW_FIX_RUN_STATUSES.running]
    );
    expect(queryMock).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('UPDATE review_fix_runs'),
      expect.arrayContaining([
        'run-orphaned',
        REVIEW_FIX_RUN_STATUSES.stopped,
        expect.stringContaining(REVIEW_FIX_RECOMMENDATION_STATUSES.stopped),
        'null',
        'Backend restarted before this fix run finished.',
        null,
        '2026-04-06T10:05:00.000Z',
        null,
      ])
    );
  });
});
