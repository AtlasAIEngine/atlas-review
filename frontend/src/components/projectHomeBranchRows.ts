import type { BranchRowData } from './review/BranchRow';

export interface SortableBranchRowData extends BranchRowData {
  sortTimeMs?: number;
}

export function pickLatestProjectHomeBranchTimestamp(
  ...timestamps: Array<string | null | undefined>
): string | null {
  let latestValue: string | null = null;
  let latestMs = 0;

  for (const timestamp of timestamps) {
    if (!timestamp) continue;
    const ms = new Date(timestamp).getTime();
    if (!Number.isFinite(ms) || ms <= latestMs) continue;
    latestMs = ms;
    latestValue = timestamp;
  }

  return latestValue;
}

export function getProjectHomeBranchSortTimeMs(timestamp: string | null | undefined): number {
  if (!timestamp) return 0;
  const ms = new Date(timestamp).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function getBranchRowRank(row: BranchRowData): number {
  if (row.nonReviewableBranchName && !row.active) return 8;
  if (row.generating) return 0;
  if (row.high > 0) return 1;
  if (row.med > 0) return 2;
  if (row.low > 0) return 3;
  if (row.active) return 4;
  if (!row.reviewId) return 5;
  if (row.risk === 'clean') return 6;
  return 5;
}

function getSortTime(row: SortableBranchRowData): number {
  const value = Number(row.sortTimeMs || 0);
  return Number.isFinite(value) ? value : 0;
}

function compareIssueCounts(left: BranchRowData, right: BranchRowData): number {
  return (right.high - left.high)
    || (right.med - left.med)
    || (right.low - left.low);
}

export function compareProjectHomeBranchRows(
  left: SortableBranchRowData,
  right: SortableBranchRowData,
): number {
  // HEAD (current/active branch) is always pinned to the top, regardless of
  // recency or whether it's a reviewable branch.
  const activeDelta = Number(Boolean(right.active)) - Number(Boolean(left.active));
  if (activeDelta !== 0) return activeDelta;

  // Everything else sorts by most recent activity first — including the base
  // branch, which used to be forced to the bottom.
  const timeDelta = getSortTime(right) - getSortTime(left);
  if (timeDelta !== 0) return timeDelta;

  const rankDelta = getBranchRowRank(left) - getBranchRowRank(right);
  if (rankDelta !== 0) return rankDelta;

  const issueDelta = compareIssueCounts(left, right);
  if (issueDelta !== 0) return issueDelta;

  return left.name.localeCompare(right.name);
}

export function sortProjectHomeBranchRows<T extends SortableBranchRowData>(rows: T[]): T[] {
  return [...rows].sort(compareProjectHomeBranchRows);
}
