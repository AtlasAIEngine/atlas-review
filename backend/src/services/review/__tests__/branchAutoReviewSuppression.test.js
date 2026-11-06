import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../db/connection.js', () => ({
  default: {
    query: vi.fn(),
  },
  getDbType: vi.fn(() => 'postgres'),
}));

import db from '../../../db/connection.js';
import {
  isBranchAutoReviewSuppressedForSnapshot,
  suppressBranchAutoReviewForSnapshot,
} from '../branchAutoReviewSuppression.js';

describe('branchAutoReviewSuppression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.query.mockResolvedValue({ rows: [] });
  });

  it('persists the current branch review snapshot', async () => {
    await expect(suppressBranchAutoReviewForSnapshot({
      id: 'br-1',
      headSha: 'stale-head',
      mergeBaseSha: 'stale-base',
    }, {
      snapshot: {
        headSha: 'head-a',
        mergeBaseSha: 'base-a',
      },
    })).resolves.toBe(true);

    expect(db.query).toHaveBeenCalledTimes(1);
    expect(db.query.mock.calls[0][0]).toContain('INSERT INTO settings');
    expect(db.query.mock.calls[0][1][0]).toBe('branch_auto_review_suppressed:br-1');
    expect(JSON.parse(db.query.mock.calls[0][1][1])).toEqual(expect.objectContaining({
      headSha: 'head-a',
      mergeBaseSha: 'base-a',
      reason: 'user_stopped_review',
    }));
  });

  it('suppresses only the matching head and merge-base snapshot', async () => {
    db.query.mockResolvedValue({
      rows: [{
        value: JSON.stringify({
          headSha: 'head-a',
          mergeBaseSha: 'base-a',
          reason: 'user_stopped_review',
        }),
      }],
    });

    await expect(isBranchAutoReviewSuppressedForSnapshot(
      { id: 'br-1', headSha: 'head-a', mergeBaseSha: 'base-a' },
      { headSha: 'head-a', mergeBaseSha: 'base-a' },
    )).resolves.toBe(true);

    await expect(isBranchAutoReviewSuppressedForSnapshot(
      { id: 'br-1', headSha: 'head-a', mergeBaseSha: 'base-a' },
      { headSha: 'head-b', mergeBaseSha: 'base-a' },
    )).resolves.toBe(false);
  });

  it('falls back to base branch identity when merge-base is unavailable', async () => {
    db.query.mockResolvedValue({
      rows: [{
        value: JSON.stringify({
          headSha: 'head-a',
          mergeBaseSha: '',
          baseBranch: 'feature~last-commit',
        }),
      }],
    });

    await expect(isBranchAutoReviewSuppressedForSnapshot({
      id: 'br-1',
      headSha: 'head-a',
      mergeBaseSha: null,
      baseBranch: 'feature~last-commit',
    })).resolves.toBe(true);

    await expect(isBranchAutoReviewSuppressedForSnapshot({
      id: 'br-1',
      headSha: 'head-a',
      mergeBaseSha: null,
      baseBranch: 'main',
    })).resolves.toBe(false);
  });
});
