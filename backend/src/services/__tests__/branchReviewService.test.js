import { beforeEach, describe, expect, it, vi } from 'vitest';

const queryMock = vi.fn();
const transactionMock = vi.fn();

vi.mock('../../db/connection.js', () => ({
  query: (...args) => queryMock(...args),
  transaction: (...args) => transactionMock(...args),
  getDbType: () => 'postgres',
}));

import branchReviewService from '../branchReviewService.js';

describe('branchReviewService cache descriptor lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transactionMock.mockImplementation(async (callback) => {
      const client = {
        query: (...args) => queryMock(...args),
      };
      return callback(client);
    });
  });

  it('uses descriptor VALUES join for hash-descriptor cache lookups', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });

    await branchReviewService.getReviewFileCacheByHashDescriptors(
      'project-1',
      [
        { filePath: 'src/a.ts', beforeHash: 'before-a', afterHash: 'after-a' },
        { filePath: 'src/b.ts', beforeHash: 'before-b', afterHash: 'after-b' },
      ],
      { maxRows: 25 }
    );

    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('WITH requested(file_path, before_hash, after_hash) AS');
    expect(sql).toContain('VALUES ($2, $3, $4), ($5, $6, $7)');
    expect(sql).toContain('INNER JOIN requested req');
    expect(sql).toContain('LIMIT $8');
    expect(params).toEqual([
      'project-1',
      'src/a.ts',
      'before-a',
      'after-a',
      'src/b.ts',
      'before-b',
      'after-b',
      25,
    ]);
  });

  it('normalizes persisted non-issue high severities from review_json payloads', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'br-1',
          project_id: 'project-1',
          display_id: 'BR-001',
          branch_name: 'feature/test',
          base_branch: 'main',
          merge_base_sha: 'merge-sha',
          head_sha: 'head-sha',
          status: 'active',
          is_current: true,
          file_count: 40,
          total_additions: 120,
          total_deletions: 20,
          commit_count: 3,
          first_commit_at: null,
          last_commit_at: null,
          review_status: 'reviewed',
          review_risk_level: 'high',
          review_summary: 'Legacy payload',
          review_error: null,
          review_base_branch: 'main',
          review_merge_base_sha: 'merge-sha',
          review_head_sha: 'head-sha',
          reviewed_at: '2026-02-26T00:00:00.000Z',
          review_json: JSON.stringify({
            summary: 'Legacy payload',
            riskLevel: 'high',
            changeGroups: [],
            recommendations: [
              {
                type: 'suggestion',
                severity: 'high',
                title: 'Provide accessible source diff for review',
                description: 'Diff context unavailable.',
              },
            ],
            stats: {
              filesAnalyzed: 0,
              omittedFiles: 40,
            },
          }),
          created_at: '2026-02-26T00:00:00.000Z',
          updated_at: '2026-02-26T00:00:00.000Z',
        },
      ],
    });

    const review = await branchReviewService.getById('br-1');
    expect(review?.reviewJson?.recommendations?.[0]?.type).toBe('suggestion');
    expect(review?.reviewJson?.recommendations?.[0]?.severity).toBe('medium');
    expect(review?.reviewJson?.riskLevel).toBe('medium');
  });

  it('exposes fork_point_sha through the row mapper and persists forkPointSha via create()', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ cnt: 0 }] })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'br-new',
            project_id: 'project-1',
            display_id: 'BR-001',
            branch_name: 'feature/fork',
            base_branch: 'main',
            merge_base_sha: 'merge-sha',
            fork_point_sha: 'fork-sha',
            head_sha: 'head-sha',
            status: 'active',
            is_current: true,
            file_count: 0,
            total_additions: 0,
            total_deletions: 0,
            commit_count: 0,
            review_status: 'none',
            created_at: '2026-04-20T00:00:00.000Z',
            updated_at: '2026-04-20T00:00:00.000Z',
          },
        ],
      });

    const created = await branchReviewService.create({
      projectId: 'project-1',
      branchName: 'feature/fork',
      baseBranch: 'main',
      mergeBaseSha: 'merge-sha',
      forkPointSha: 'fork-sha',
      headSha: 'head-sha',
      stats: {},
    });

    expect(created?.forkPointSha).toBe('fork-sha');
    const [insertSql, insertParams] = queryMock.mock.calls[1];
    expect(insertSql).toContain('fork_point_sha');
    expect(insertParams).toContain('fork-sha');
  });

  it('allows updating fork_point_sha via updateReview()', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [
        {
          id: 'br-1',
          project_id: 'project-1',
          display_id: 'BR-001',
          branch_name: 'feature/fork',
          base_branch: 'main',
          merge_base_sha: 'merge-sha',
          fork_point_sha: 'preserved-fork',
          head_sha: 'new-head-sha',
          status: 'active',
          is_current: true,
          review_status: 'none',
          created_at: '2026-04-20T00:00:00.000Z',
          updated_at: '2026-04-20T00:00:00.000Z',
        },
      ],
    });

    const updated = await branchReviewService.updateReview('br-1', {
      fork_point_sha: 'preserved-fork',
    });

    expect(updated?.forkPointSha).toBe('preserved-fork');
    const [sql, params] = queryMock.mock.calls[0];
    expect(sql).toContain('fork_point_sha = $2');
    expect(params).toEqual(['br-1', 'preserved-fork']);
  });

  it('collapses duplicate tracked branch reviews and closes the older duplicate', async () => {
    queryMock
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'br-current',
            project_id: 'project-1',
            display_id: 'BR-010',
            branch_name: 'feature/test',
            base_branch: 'main',
            merge_base_sha: 'merge-sha',
            head_sha: 'head-new',
            status: 'active',
            is_current: true,
            review_status: 'none',
            review_error: null,
            created_at: '2026-04-06T09:00:00.000Z',
            updated_at: '2026-04-06T09:05:00.000Z',
          },
          {
            id: 'br-duplicate',
            project_id: 'project-1',
            display_id: 'BR-009',
            branch_name: 'feature/test',
            base_branch: 'main',
            merge_base_sha: 'merge-sha',
            head_sha: 'head-old',
            status: 'active',
            is_current: false,
            review_status: 'none',
            review_error: null,
            created_at: '2026-04-06T08:00:00.000Z',
            updated_at: '2026-04-06T08:05:00.000Z',
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: 'br-duplicate',
            project_id: 'project-1',
            display_id: 'BR-009',
            branch_name: 'feature/test',
            base_branch: 'main',
            merge_base_sha: 'merge-sha',
            head_sha: 'head-old',
            status: 'closed',
            is_current: false,
            review_status: 'none',
            review_error: 'Superseded duplicate branch review entry',
            created_at: '2026-04-06T08:00:00.000Z',
            updated_at: '2026-04-06T09:06:00.000Z',
          },
        ],
      });

    const result = await branchReviewService.collapseDuplicateTrackedReviews('project-1');

    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[1][0]).toContain('UPDATE branch_reviews SET');
    expect(queryMock.mock.calls[1][1]).toEqual([
      'br-duplicate',
      'closed',
      0,
      'Superseded duplicate branch review entry',
    ]);
    expect(result.reviews).toHaveLength(1);
    expect(result.reviews[0].id).toBe('br-current');
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0].id).toBe('br-duplicate');
  });

  it('updates the current branch pointer atomically on the normal path', async () => {
    queryMock
      .mockResolvedValueOnce({ rowCount: 1, rows: [] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await branchReviewService.setCurrentBranch('project-1', 'br-next');

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(queryMock.mock.calls[0][0]).toContain('WHERE project_id = $1');
    expect(queryMock.mock.calls[0][1]).toEqual(['project-1']);
    expect(queryMock.mock.calls[1][0]).toContain('WHERE id = $1');
    expect(queryMock.mock.calls[1][1]).toEqual(['br-next']);
  });

  it('clears the current branch inside a transaction when no replacement id is provided', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1, rows: [] });

    await branchReviewService.setCurrentBranch('project-1', null);

    expect(transactionMock).toHaveBeenCalledTimes(1);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][0]).toContain('WHERE project_id = $1');
    expect(queryMock.mock.calls[0][1]).toEqual(['project-1']);
  });

  it('rolls back setCurrentBranch when the second update fails', async () => {
    let rows = [
      { id: 'br-current', project_id: 'project-1', is_current: true },
      { id: 'br-next', project_id: 'project-1', is_current: false },
    ];

    transactionMock.mockImplementationOnce(async (callback) => {
      const snapshot = rows.map((row) => ({ ...row }));
      const client = {
        query: async (sql, params = []) => {
          if (sql.includes('WHERE project_id = $1')) {
            rows = rows.map((row) => (
              row.project_id === params[0]
                ? { ...row, is_current: false }
                : row
            ));
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes('WHERE id = $1')) {
            throw new Error('set-current failed');
          }
          return { rowCount: 0, rows: [] };
        },
      };

      try {
        return await callback(client);
      } catch (error) {
        rows = snapshot;
        throw error;
      }
    });

    await expect(branchReviewService.setCurrentBranch('project-1', 'br-next'))
      .rejects
      .toThrow('set-current failed');

    expect(rows).toEqual([
      { id: 'br-current', project_id: 'project-1', is_current: true },
      { id: 'br-next', project_id: 'project-1', is_current: false },
    ]);
  });

  it('rolls back setCurrentBranch when clearing current flags fails first', async () => {
    let rows = [
      { id: 'br-current', project_id: 'project-1', is_current: true },
      { id: 'br-next', project_id: 'project-1', is_current: false },
    ];

    transactionMock.mockImplementationOnce(async (callback) => {
      const snapshot = rows.map((row) => ({ ...row }));
      const client = {
        query: async (sql) => {
          if (sql.includes('WHERE project_id = $1')) {
            throw new Error('clear-current failed');
          }
          return { rowCount: 0, rows: [] };
        },
      };

      try {
        return await callback(client);
      } catch (error) {
        rows = snapshot;
        throw error;
      }
    });

    await expect(branchReviewService.setCurrentBranch('project-1', 'br-next'))
      .rejects
      .toThrow('clear-current failed');

    expect(rows).toEqual([
      { id: 'br-current', project_id: 'project-1', is_current: true },
      { id: 'br-next', project_id: 'project-1', is_current: false },
    ]);
  });

  it('keeps unrelated project rows untouched when the transaction rolls back', async () => {
    let rows = [
      { id: 'br-current', project_id: 'project-1', is_current: true },
      { id: 'br-next', project_id: 'project-1', is_current: false },
      { id: 'br-other', project_id: 'project-2', is_current: true },
    ];

    transactionMock.mockImplementationOnce(async (callback) => {
      const snapshot = rows.map((row) => ({ ...row }));
      const client = {
        query: async (sql, params = []) => {
          if (sql.includes('WHERE project_id = $1')) {
            rows = rows.map((row) => (
              row.project_id === params[0]
                ? { ...row, is_current: false }
                : row
            ));
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes('WHERE id = $1')) {
            throw new Error('set-current failed');
          }
          return { rowCount: 0, rows: [] };
        },
      };

      try {
        return await callback(client);
      } catch (error) {
        rows = snapshot;
        throw error;
      }
    });

    await expect(branchReviewService.setCurrentBranch('project-1', 'br-next'))
      .rejects
      .toThrow('set-current failed');

    expect(rows.find((row) => row.id === 'br-other')?.is_current).toBe(true);
  });

  it('keeps current-branch state coherent under concurrent setCurrentBranch calls', async () => {
    let rows = [
      { id: 'br-current', project_id: 'project-1', is_current: true },
      { id: 'br-a', project_id: 'project-1', is_current: false },
      { id: 'br-b', project_id: 'project-1', is_current: false },
    ];
    let serialized = Promise.resolve();

    transactionMock.mockImplementation((callback) => {
      const run = serialized.then(async () => {
        const snapshot = rows.map((row) => ({ ...row }));
        const client = {
          query: async (sql, params = []) => {
            if (sql.includes('WHERE project_id = $1')) {
              rows = rows.map((row) => (
                row.project_id === params[0]
                  ? { ...row, is_current: false }
                  : row
              ));
              return { rowCount: 1, rows: [] };
            }
            if (sql.includes('WHERE id = $1')) {
              rows = rows.map((row) => (
                row.id === params[0]
                  ? { ...row, is_current: true }
                  : row
              ));
              return { rowCount: 1, rows: [] };
            }
            return { rowCount: 0, rows: [] };
          },
        };

        try {
          return await callback(client);
        } catch (error) {
          rows = snapshot;
          throw error;
        }
      });

      serialized = run.catch(() => {});
      return run;
    });

    await Promise.all([
      branchReviewService.setCurrentBranch('project-1', 'br-a'),
      branchReviewService.setCurrentBranch('project-1', 'br-b'),
    ]);

    const currentRows = rows.filter((row) => row.is_current);
    expect(currentRows).toHaveLength(1);
    expect(currentRows[0].id).toBe('br-b');
  });

  it('keeps current-branch state coherent under concurrent clear and set calls', async () => {
    let rows = [
      { id: 'br-current', project_id: 'project-1', is_current: true },
      { id: 'br-next', project_id: 'project-1', is_current: false },
    ];
    let serialized = Promise.resolve();

    transactionMock.mockImplementation((callback) => {
      const run = serialized.then(async () => {
        const snapshot = rows.map((row) => ({ ...row }));
        const client = {
          query: async (sql, params = []) => {
            if (sql.includes('WHERE project_id = $1')) {
              rows = rows.map((row) => (
                row.project_id === params[0]
                  ? { ...row, is_current: false }
                  : row
              ));
              return { rowCount: 1, rows: [] };
            }
            if (sql.includes('WHERE id = $1')) {
              rows = rows.map((row) => (
                row.id === params[0]
                  ? { ...row, is_current: true }
                  : row
              ));
              return { rowCount: 1, rows: [] };
            }
            return { rowCount: 0, rows: [] };
          },
        };

        try {
          return await callback(client);
        } catch (error) {
          rows = snapshot;
          throw error;
        }
      });

      serialized = run.catch(() => {});
      return run;
    });

    await Promise.all([
      branchReviewService.setCurrentBranch('project-1', null),
      branchReviewService.setCurrentBranch('project-1', 'br-next'),
    ]);

    const currentRows = rows.filter((row) => row.is_current);
    expect(currentRows).toHaveLength(1);
    expect(currentRows[0].id).toBe('br-next');
  });

  it('propagates transaction-level failures without masking them', async () => {
    transactionMock.mockRejectedValueOnce(new Error('transaction unavailable'));

    await expect(branchReviewService.setCurrentBranch('project-1', 'br-next'))
      .rejects
      .toThrow('transaction unavailable');

    expect(queryMock).not.toHaveBeenCalled();
  });

  it('keeps exactly one current branch when setting the already-current review again', async () => {
    let rows = [
      { id: 'br-current', project_id: 'project-1', is_current: true },
      { id: 'br-other', project_id: 'project-1', is_current: false },
    ];

    transactionMock.mockImplementationOnce(async (callback) => {
      const snapshot = rows.map((row) => ({ ...row }));
      const client = {
        query: async (sql, params = []) => {
          if (sql.includes('WHERE project_id = $1')) {
            rows = rows.map((row) => (
              row.project_id === params[0]
                ? { ...row, is_current: false }
                : row
            ));
            return { rowCount: 1, rows: [] };
          }
          if (sql.includes('WHERE id = $1')) {
            rows = rows.map((row) => (
              row.id === params[0]
                ? { ...row, is_current: true }
                : row
            ));
            return { rowCount: 1, rows: [] };
          }
          return { rowCount: 0, rows: [] };
        },
      };

      try {
        return await callback(client);
      } catch (error) {
        rows = snapshot;
        throw error;
      }
    });

    await branchReviewService.setCurrentBranch('project-1', 'br-current');

    const currentRows = rows.filter((row) => row.is_current);
    expect(currentRows).toHaveLength(1);
    expect(currentRows[0].id).toBe('br-current');
  });
});
