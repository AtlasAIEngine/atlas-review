const parsedVisibleReviewFileLimit = Number(process.env.ATLAS_VISIBLE_REVIEW_FILE_LIMIT);
const DEFAULT_VISIBLE_REVIEW_FILE_LIMIT = Number.isFinite(parsedVisibleReviewFileLimit) && parsedVisibleReviewFileLimit > 0
  ? parsedVisibleReviewFileLimit
  : 200;

const CODE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.cpp',
  '.cs',
  '.css',
  '.cxx',
  '.go',
  '.h',
  '.hpp',
  '.hxx',
  '.java',
  '.js',
  '.jsx',
  '.kt',
  '.kts',
  '.m',
  '.mm',
  '.php',
  '.py',
  '.rb',
  '.rs',
  '.scss',
  '.shader',
  '.swift',
  '.ts',
  '.tsx',
  '.usf',
  '.ush',
  '.vue',
]);

const CODE_FILENAMES = new Set([
  'build.gradle',
  'build.gradle.kts',
  'cargo.toml',
  'cmakelists.txt',
  'dockerfile',
  'go.mod',
  'go.sum',
  'package-lock.json',
  'package.json',
  'pnpm-lock.yaml',
  'pyproject.toml',
  'requirements.txt',
  'settings.gradle',
  'settings.gradle.kts',
  'tsconfig.json',
  'vite.config.js',
  'vite.config.ts',
  'webpack.config.js',
  'webpack.config.ts',
  'yarn.lock',
]);

function normalizeFilePath(value) {
  return String(value || '').trim();
}

function getPathExtension(filePath) {
  const normalized = normalizeFilePath(filePath).toLowerCase();
  const lastDot = normalized.lastIndexOf('.');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastDot === -1 || lastDot < lastSlash) return '';
  return normalized.slice(lastDot);
}

function isCodeFilePath(filePath) {
  const normalized = normalizeFilePath(filePath);
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  const basename = lower.split('/').pop() || lower;
  return CODE_EXTENSIONS.has(getPathExtension(lower)) || CODE_FILENAMES.has(basename);
}

function buildRecommendationPathSet(reviewLike) {
  const reviewJson = reviewLike?.reviewJson && typeof reviewLike.reviewJson === 'object'
    ? reviewLike.reviewJson
    : (reviewLike && typeof reviewLike === 'object' ? reviewLike : null);
  const recommendationPaths = new Set();
  for (const recommendation of reviewJson?.recommendations || []) {
    if (!recommendation || recommendation.type === 'praise') continue;
    const path = normalizeFilePath(recommendation.file);
    if (path) recommendationPaths.add(path);
  }
  return recommendationPaths;
}

function getFileSortTuple(file, recommendationPaths) {
  const path = normalizeFilePath(file?.path);
  const oldPath = normalizeFilePath(file?.oldPath);
  const status = String(file?.status || 'M').trim().toUpperCase();
  const churn = Math.max(0, Number(file?.additions) || 0) + Math.max(0, Number(file?.deletions) || 0);
  const hasFinding = recommendationPaths.has(path) || (oldPath && recommendationPaths.has(oldPath));
  const isCode = isCodeFilePath(path) || (oldPath && isCodeFilePath(oldPath));
  const structuralPriority = status === 'R' || status === 'D' ? 0 : status === 'A' ? 1 : 2;
  return {
    hasFindingPriority: hasFinding ? 0 : 1,
    codePriority: isCode ? 0 : 1,
    structuralPriority,
    churnPriority: -churn,
    path,
  };
}

function compareVisibleReviewFiles(a, b, recommendationPaths) {
  const left = getFileSortTuple(a, recommendationPaths);
  const right = getFileSortTuple(b, recommendationPaths);
  if (left.hasFindingPriority !== right.hasFindingPriority) {
    return left.hasFindingPriority - right.hasFindingPriority;
  }
  if (left.codePriority !== right.codePriority) {
    return left.codePriority - right.codePriority;
  }
  if (left.structuralPriority !== right.structuralPriority) {
    return left.structuralPriority - right.structuralPriority;
  }
  if (left.churnPriority !== right.churnPriority) {
    return left.churnPriority - right.churnPriority;
  }
  return left.path.localeCompare(right.path, undefined, { numeric: true, sensitivity: 'base' });
}

export function getVisibleReviewFileLimit() {
  return DEFAULT_VISIBLE_REVIEW_FILE_LIMIT;
}

// Clamp the maximum any single client request can ask for. Prevents a tiny
// caller bug or hostile query string from forcing the backend to assemble
// payloads for thousands of files in one shot.
const MAX_REQUESTED_VISIBLE_REVIEW_FILE_LIMIT = 5000;

export function resolveVisibleReviewFileLimit(override) {
  if (override == null) return DEFAULT_VISIBLE_REVIEW_FILE_LIMIT;
  const parsed = Number(override);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_VISIBLE_REVIEW_FILE_LIMIT;
  const floored = Math.floor(parsed);
  return Math.min(MAX_REQUESTED_VISIBLE_REVIEW_FILE_LIMIT, Math.max(DEFAULT_VISIBLE_REVIEW_FILE_LIMIT, floored));
}

export function selectVisibleReviewFiles(files, reviewLike = null, maxVisible = DEFAULT_VISIBLE_REVIEW_FILE_LIMIT) {
  const sourceFiles = Array.isArray(files) ? files : [];
  const recommendationPaths = buildRecommendationPathSet(reviewLike);
  const sorted = [...sourceFiles].sort((a, b) => compareVisibleReviewFiles(a, b, recommendationPaths));
  if (sorted.length <= maxVisible) {
    return sorted;
  }
  return sorted.slice(0, maxVisible);
}

export function summarizeVisibleReviewFiles(visibleFiles, totalFileCount, maxVisible = DEFAULT_VISIBLE_REVIEW_FILE_LIMIT) {
  const visibleCount = Array.isArray(visibleFiles) ? visibleFiles.length : 0;
  const totalCount = Math.max(visibleCount, Number(totalFileCount) || 0);
  const hiddenCount = Math.max(0, totalCount - visibleCount);
  return {
    visibleCount,
    totalCount,
    hiddenCount,
    maxVisible,
    isCapped: hiddenCount > 0,
  };
}

export function isCodeReviewFilePath(filePath) {
  return isCodeFilePath(filePath);
}
