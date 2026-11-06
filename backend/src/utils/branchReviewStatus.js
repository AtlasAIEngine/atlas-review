function normalizeBranchReviewStatus(status) {
  return String(status || '').trim().toLowerCase();
}

function normalizeFileCount(fileCount) {
  if (fileCount == null || fileCount === '') return null;
  const parsed = Number(fileCount);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.trunc(parsed);
}

export function resolveTrackedBranchReviewStatus({ currentStatus, fileCount } = {}) {
  const normalizedStatus = normalizeBranchReviewStatus(currentStatus);
  const normalizedFileCount = normalizeFileCount(fileCount);

  if (normalizedStatus === 'merged' && normalizedFileCount === 0) {
    return 'merged';
  }

  return 'active';
}
