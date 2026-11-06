import { normalizePathForMatch } from './reviewHelpers.js';
import { collectUnityStackContext } from './stackContext/unityStackContextProvider.js';

const DEFAULT_MAX_ITEMS = 4;
const DEFAULT_MAX_CHARS_PER_LINE = 140;

const SEVERITY_WEIGHT = Object.freeze({
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
});

const TYPE_WEIGHT = Object.freeze({
  issue: 3,
  suggestion: 2,
});

const STACK_CONTEXT_PROVIDER_BY_FAMILY = Object.freeze({
  unity: collectUnityStackContext,
});

function normalizeLine(value, maxChars = DEFAULT_MAX_CHARS_PER_LINE) {
  const collapsed = String(value || '').replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  const normalizedMaxChars = Math.max(40, Math.trunc(Number(maxChars) || DEFAULT_MAX_CHARS_PER_LINE));
  if (collapsed.length <= normalizedMaxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(0, normalizedMaxChars - 3)).trimEnd()}...`;
}

function normalizeSeverity(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'critical' || normalized === 'high' || normalized === 'medium' || normalized === 'low') {
    return normalized;
  }
  return 'medium';
}

function normalizeType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'issue' || normalized === 'suggestion' || normalized === 'praise') return normalized;
  return 'suggestion';
}

function mergeProjectMetadata(baseMetadata = {}, patchMetadata = {}) {
  const base = baseMetadata && typeof baseMetadata === 'object' ? baseMetadata : {};
  const patch = patchMetadata && typeof patchMetadata === 'object' ? patchMetadata : {};
  const baseChecks = base.availableChecks && typeof base.availableChecks === 'object'
    ? base.availableChecks
    : {};
  const patchChecks = patch.availableChecks && typeof patch.availableChecks === 'object'
    ? patch.availableChecks
    : {};

  return {
    ...base,
    ...patch,
    availableChecks: {
      ...baseChecks,
      ...patchChecks,
    },
  };
}

function normalizeAdditionalBlocks(blocks = [], {
  maxItems = DEFAULT_MAX_ITEMS,
  maxCharsPerLine = DEFAULT_MAX_CHARS_PER_LINE,
} = {}) {
  const normalizedBlocks = [];
  const seenIds = new Set();

  for (const block of Array.isArray(blocks) ? blocks : []) {
    const id = String(block?.id || '').trim();
    const title = String(block?.title || '').trim();
    if (!id || !title || seenIds.has(id)) continue;

    const lines = [];
    const seenLines = new Set();
    for (const rawLine of Array.isArray(block?.lines) ? block.lines : []) {
      const line = normalizeLine(rawLine, maxCharsPerLine);
      if (!line || seenLines.has(line)) continue;
      seenLines.add(line);
      lines.push(line);
      if (lines.length >= Math.max(1, Math.trunc(Number(maxItems) || DEFAULT_MAX_ITEMS))) break;
    }

    if (lines.length === 0) continue;
    seenIds.add(id);
    normalizedBlocks.push({
      id,
      title,
      lines,
      priority: Number.isFinite(Number(block?.priority)) ? Number(block.priority) : null,
    });
  }

  return normalizedBlocks;
}

function buildHistoricalLearningBlocks(priorCacheRows = [], {
  maxItems = DEFAULT_MAX_ITEMS,
  maxCharsPerLine = DEFAULT_MAX_CHARS_PER_LINE,
} = {}) {
  const aggregate = new Map();

  for (const row of Array.isArray(priorCacheRows) ? priorCacheRows : []) {
    const filePath = normalizePathForMatch(row?.filePath || '');
    if (!filePath) continue;
    const recommendations = Array.isArray(row?.review?.recommendations)
      ? row.review.recommendations
      : [];

    for (const recommendation of recommendations) {
      if (!recommendation || typeof recommendation !== 'object') continue;
      const type = normalizeType(recommendation.type);
      if (type === 'praise') continue;
      const title = normalizeLine(
        recommendation.title || recommendation.description || '',
        Math.max(60, maxCharsPerLine - 28)
      );
      if (!title) continue;
      const severity = normalizeSeverity(recommendation.severity);
      const key = `${filePath}\u001f${type}\u001f${title.toLowerCase()}`;
      const current = aggregate.get(key) || {
        filePath,
        title,
        type,
        severity,
        count: 0,
        latestTimestamp: 0,
      };
      current.count += 1;
      if ((SEVERITY_WEIGHT[severity] || 0) > (SEVERITY_WEIGHT[current.severity] || 0)) {
        current.severity = severity;
      }
      const timestamp = Math.max(
        Date.parse(String(row?.updatedAt || '')) || 0,
        Date.parse(String(row?.createdAt || '')) || 0,
      );
      current.latestTimestamp = Math.max(current.latestTimestamp, timestamp);
      aggregate.set(key, current);
    }
  }

  const ranked = Array.from(aggregate.values())
    .filter((entry) => entry.count >= 2 || entry.severity === 'high' || entry.severity === 'critical')
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      const severityDiff = (SEVERITY_WEIGHT[right.severity] || 0) - (SEVERITY_WEIGHT[left.severity] || 0);
      if (severityDiff !== 0) return severityDiff;
      const typeDiff = (TYPE_WEIGHT[right.type] || 0) - (TYPE_WEIGHT[left.type] || 0);
      if (typeDiff !== 0) return typeDiff;
      if (right.latestTimestamp !== left.latestTimestamp) return right.latestTimestamp - left.latestTimestamp;
      return `${left.filePath}:${left.title}`.localeCompare(`${right.filePath}:${right.title}`);
    })
    .slice(0, Math.max(1, Math.trunc(Number(maxItems) || DEFAULT_MAX_ITEMS)));

  if (ranked.length === 0) {
    return [];
  }

  return [{
    id: 'historical_review_learnings',
    title: '### Atlas Local Context: Historical Review Learnings',
    priority: 33,
    lines: ranked.map((entry) => (
      `[${entry.severity} ${entry.type}${entry.count > 1 ? ` x${entry.count}` : ''}] ${entry.filePath}: ${entry.title}`
    )),
  }];
}

async function collectReviewStackContext(projectPath, {
  reviewProfile = null,
  contextFiles = [],
  priorCacheRows = [],
  projectMetadata = {},
  maxItems = DEFAULT_MAX_ITEMS,
  maxCharsPerLine = DEFAULT_MAX_CHARS_PER_LINE,
} = {}) {
  const additionalBlocks = buildHistoricalLearningBlocks(priorCacheRows, {
    maxItems,
    maxCharsPerLine,
  });

  const stackFamily = String(reviewProfile?.stackFamily || '').trim().toLowerCase();
  const provider = stackFamily ? STACK_CONTEXT_PROVIDER_BY_FAMILY[stackFamily] : null;
  let providerResult = null;
  if (typeof provider === 'function') {
    providerResult = await provider(projectPath, {
      reviewProfile,
      contextFiles,
      projectMetadata,
      maxItems,
      maxCharsPerLine,
    }).catch(() => null);
  }

  const mergedProjectMetadata = mergeProjectMetadata(projectMetadata, providerResult?.projectMetadata || {});
  const mergedBlocks = normalizeAdditionalBlocks(
    [
      ...additionalBlocks,
      ...(Array.isArray(providerResult?.additionalBlocks) ? providerResult.additionalBlocks : []),
    ],
    {
      maxItems,
      maxCharsPerLine,
    }
  );

  return {
    projectMetadata: mergedProjectMetadata,
    additionalBlocks: mergedBlocks,
  };
}

export {
  collectReviewStackContext,
  buildHistoricalLearningBlocks,
};
