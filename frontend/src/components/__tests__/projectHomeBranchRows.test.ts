import { test, expect } from '@playwright/test';

import {
  compareProjectHomeBranchRows,
  getProjectHomeBranchSortTimeMs,
  pickLatestProjectHomeBranchTimestamp,
  sortProjectHomeBranchRows,
  type SortableBranchRowData,
} from '../projectHomeBranchRows';

function row(overrides: Partial<SortableBranchRowData> & Pick<SortableBranchRowData, 'id' | 'name'>): SortableBranchRowData {
  return {
    base: 'main',
    high: 0,
    med: 0,
    low: 0,
    coverage: 0,
    additions: 0,
    deletions: 0,
    updatedLabel: '1h',
    risk: 'low',
    ...overrides,
  };
}

test.describe('ProjectHome branch row sorting', () => {
  test('sorts branch rows by latest activity before finding severity', () => {
    const sorted = sortProjectHomeBranchRows([
      row({ id: 'med-new', name: 'channel_view', med: 2, risk: 'med', sortTimeMs: 300 }),
      row({ id: 'high-old', name: 'player_view', high: 1, risk: 'high', sortTimeMs: 100 }),
      row({ id: 'med-old', name: 'search_page', med: 1, risk: 'med', sortTimeMs: 200 }),
    ]);

    expect(sorted.map((item) => item.id)).toEqual(['med-new', 'med-old', 'high-old']);
  });

  test('keeps recently updated clean reviews ahead of older unreviewed rows', () => {
    const sorted = sortProjectHomeBranchRows([
      row({ id: 'old-unreviewed', name: 'backup_branch', statusLabel: 'Not reviewed', sortTimeMs: 100 }),
      row({ id: 'clean-review', name: 'active_worktree', reviewId: 'br-clean', risk: 'clean', sortTimeMs: 500 }),
    ]);

    expect(sorted.map((item) => item.id)).toEqual(['clean-review', 'old-unreviewed']);
  });

  test('pins HEAD to the top and sorts base branch by recency below it', () => {
    const sorted = sortProjectHomeBranchRows([
      row({ id: 'clean-review', name: 'old_clean', reviewId: 'br-clean', risk: 'clean', sortTimeMs: 500 }),
      row({ id: 'base', name: 'main', nonReviewableBranchName: 'main', statusLabel: 'Base branch', sortTimeMs: 900 }),
      row({ id: 'local-current', name: 'landing_page', active: true, statusLabel: 'Current branch', sortTimeMs: 100 }),
    ]);

    expect(sorted.map((item) => item.id)).toEqual(['local-current', 'base', 'clean-review']);
  });

  test('does not bury the active HEAD row when the current branch is the base branch', () => {
    const sorted = sortProjectHomeBranchRows([
      row({ id: 'old-topic', name: 'Animation/AnimationTestBranch', statusLabel: 'Not reviewed', sortTimeMs: 100 }),
      row({ id: 'base-current', name: 'development', active: true, nonReviewableBranchName: 'development', statusLabel: 'Base branch', sortTimeMs: 900 }),
      row({ id: 'older-topic', name: 'Ravi/RuleBasedAI', statusLabel: 'Not reviewed', sortTimeMs: 200 }),
    ]);

    expect(sorted.map((item) => item.id)).toEqual(['base-current', 'older-topic', 'old-topic']);
  });

  test('puts active reviews before inactive rows at the same priority', () => {
    const active = row({ id: 'current', name: 'landing_page', high: 1, risk: 'high', active: true });
    const inactive = row({ id: 'inactive', name: 'utility_branch', high: 1, risk: 'high' });

    expect(compareProjectHomeBranchRows(active, inactive)).toBeLessThan(0);
  });

  test('uses the latest valid branch activity timestamp', () => {
    const latest = pickLatestProjectHomeBranchTimestamp(
      '2026-04-29T10:00:00.000Z',
      null,
      'invalid-date',
      '2026-04-29T11:00:00.000Z',
    );

    expect(latest).toBe('2026-04-29T11:00:00.000Z');
    expect(getProjectHomeBranchSortTimeMs(latest)).toBe(new Date('2026-04-29T11:00:00.000Z').getTime());
  });
});
