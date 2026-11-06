function normalizeSha(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

async function shouldRotateBranchReviewOnHeadChange({
  projectPath,
  review,
  nextHeadSha,
  gitService,
} = {}) {
  const previousHeadSha = normalizeSha(review?.headSha ?? review?.head_sha ?? null);
  const currentHeadSha = normalizeSha(nextHeadSha);

  if (!projectPath || !previousHeadSha || !currentHeadSha) return false;
  if (previousHeadSha === currentHeadSha) return false;
  if (!gitService || typeof gitService.isAncestorRef !== 'function') return false;

  try {
    const previousHeadIsAncestor = await gitService.isAncestorRef(
      projectPath,
      previousHeadSha,
      currentHeadSha,
    );
    return previousHeadIsAncestor !== true;
  } catch {
    return false;
  }
}

export {
  shouldRotateBranchReviewOnHeadChange,
};
