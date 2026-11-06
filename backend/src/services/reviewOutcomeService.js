import db, { getDbType } from '../db/connection.js';
import { RECOMMENDATION_SEVERITY_WEIGHT } from './review/reviewConstants.js';
import { detectHistoricalBugClass } from './review/reviewHistoricalSignals.js';

const VALID_REVIEW_TYPES = new Set(['changeset', 'branch_review', 'pr_review', 'workspace_review']);
const VALID_OUTCOME_STATUSES = new Set(['addressed', 'dismissed']);
const RECOMMENDATION_IDENTITY_FIELDS = Object.freeze([
  'type',
  'severity',
  'title',
  'description',
  'file',
  'line',
  'suggestedFix',
]);
const MAX_NOTE_LENGTH = 2000;
const MAX_DIMENSION_VALUE_LENGTH = 120;
const MAX_PATH_PATTERN_LENGTH = 200;
const MIN_HISTORICAL_PATH_AFFINITY_SCORE = 0.6;
const MIN_HISTORICAL_FAMILY_AFFINITY_SCORE = 0.18;
const HISTORICAL_FAMILY_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'for',
  'of',
  'to',
  'in',
  'on',
  'at',
  'by',
  'with',
  'from',
  'after',
  'before',
  'during',
  'when',
  'while',
  'is',
  'are',
  'was',
  'were',
  'be',
  'being',
  'been',
  'this',
  'that',
  'these',
  'those',
  'new',
  'missing',
  'issue',
  'issues',
  'path',
  'files',
  'file',
  'line',
  'history',
  'exact',
  'pattern',
  'runtime',
  'project',
  'branch',
  'review',
]);

const FILE_LANGUAGE_BY_EXTENSION = Object.freeze({
  js: 'javascript',
  jsx: 'javascript',
  cjs: 'javascript',
  mjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  php: 'php',
  cs: 'csharp',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  c: 'c',
  h: 'c',
  hpp: 'cpp',
  html: 'html',
  css: 'css',
  scss: 'scss',
  less: 'less',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  md: 'markdown',
  sql: 'sql',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  dockerfile: 'docker',
});

function normalizeRecommendationFingerprintPart(value) {
  return String(value ?? '')
    .replace(/\\+\|/g, '\\|')
    .normalize('NFKC')
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, '\'')
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    .replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function normalizeDimensionValue(rawValue, {
  fallback = 'unknown',
  maxLength = MAX_DIMENSION_VALUE_LENGTH,
} = {}) {
  const normalizedFallback = normalizeRecommendationFingerprintPart(fallback) || 'unknown';
  const normalized = normalizeRecommendationFingerprintPart(rawValue);
  if (!normalized) return normalizedFallback;
  return normalized.slice(0, Math.max(1, Math.trunc(Number(maxLength) || MAX_DIMENSION_VALUE_LENGTH)));
}

function normalizePathForDimensions(rawPath) {
  const normalized = String(rawPath || '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
  return normalized;
}

function inferLanguageFromFilePath(rawPath) {
  const normalizedPath = normalizePathForDimensions(rawPath).toLowerCase();
  if (!normalizedPath) return 'unknown';
  const fileName = normalizedPath.split('/').pop() || '';
  if (fileName === 'dockerfile') return 'docker';
  const extension = fileName.includes('.')
    ? fileName.slice(fileName.lastIndexOf('.') + 1)
    : '';
  if (!extension) return 'unknown';
  return FILE_LANGUAGE_BY_EXTENSION[extension] || extension;
}

function normalizePathPattern(rawPath, fallback = 'unknown') {
  const normalizedPath = normalizePathForDimensions(rawPath).toLowerCase();
  if (!normalizedPath) return normalizeDimensionValue(fallback, {
    fallback: 'unknown',
    maxLength: MAX_PATH_PATTERN_LENGTH,
  });
  const segments = normalizedPath.split('/').filter(Boolean);
  if (segments.length === 0) return normalizeDimensionValue(fallback, {
    fallback: 'unknown',
    maxLength: MAX_PATH_PATTERN_LENGTH,
  });
  if (segments.length === 1) {
    return normalizeDimensionValue('*', {
      fallback: 'unknown',
      maxLength: MAX_PATH_PATTERN_LENGTH,
    });
  }
  return normalizeDimensionValue(`${segments[0]}/**`, {
    fallback: 'unknown',
    maxLength: MAX_PATH_PATTERN_LENGTH,
  });
}

function splitNormalizedPathSegments(rawPath) {
  return normalizePathForDimensions(rawPath)
    .toLowerCase()
    .split('/')
    .filter(Boolean);
}

function countSharedLeadingPathSegments(leftPath, rightPath) {
  const leftSegments = splitNormalizedPathSegments(leftPath);
  const rightSegments = splitNormalizedPathSegments(rightPath);
  const limit = Math.min(leftSegments.length, rightSegments.length);
  let count = 0;
  for (let index = 0; index < limit; index += 1) {
    if (leftSegments[index] !== rightSegments[index]) break;
    count += 1;
  }
  return {
    sharedSegments: count,
    leftLength: leftSegments.length,
    rightLength: rightSegments.length,
  };
}

function scoreHistoricalPathAffinity(changedPaths = [], historicalPath = '') {
  const normalizedHistoricalPath = normalizePathForDimensions(historicalPath);
  if (!normalizedHistoricalPath) {
    return {
      score: 0,
      sharedSegments: 0,
      matchedPath: null,
    };
  }

  let best = {
    score: 0,
    sharedSegments: 0,
    matchedPath: null,
  };

  for (const changedPath of Array.isArray(changedPaths) ? changedPaths : []) {
    const normalizedChangedPath = normalizePathForDimensions(changedPath);
    if (!normalizedChangedPath) continue;
    if (normalizedChangedPath === normalizedHistoricalPath) {
      return {
        score: 1,
        sharedSegments: splitNormalizedPathSegments(normalizedHistoricalPath).length,
        matchedPath: normalizedChangedPath,
      };
    }

    const { sharedSegments, leftLength, rightLength } = countSharedLeadingPathSegments(
      normalizedChangedPath,
      normalizedHistoricalPath
    );
    const denominator = Math.max(leftLength, rightLength, 1);
    const score = sharedSegments / denominator;
    if (
      score > best.score
      || (score === best.score && sharedSegments > best.sharedSegments)
    ) {
      best = {
        score,
        sharedSegments,
        matchedPath: normalizedChangedPath,
      };
    }
  }

  return best;
}

function extractHistoricalFamilyTokens(value) {
  const normalized = normalizeRecommendationFingerprintPart(value);
  if (!normalized) return [];
  return normalized
    .split(/[^a-z0-9_]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4 && !HISTORICAL_FAMILY_STOPWORDS.has(token));
}

function buildHistoricalFamilyTokenSet(recommendation = {}) {
  const values = [
    recommendation.title,
    recommendation.description,
    recommendation.suggestedFix,
  ];
  return new Set(values.flatMap((value) => extractHistoricalFamilyTokens(value)));
}

function scoreHistoricalFamilyAffinity(changedPaths = [], changedRecommendations = [], historicalRecommendation = {}) {
  const changedTokenSet = new Set();
  const changedBugClasses = new Set();
  for (const recommendation of Array.isArray(changedRecommendations) ? changedRecommendations : []) {
    const bugClass = detectHistoricalBugClass(recommendation);
    if (bugClass) changedBugClasses.add(bugClass);
    for (const token of buildHistoricalFamilyTokenSet(recommendation)) {
      changedTokenSet.add(token);
    }
  }

  const historicalTokens = buildHistoricalFamilyTokenSet(historicalRecommendation);
  const historicalBugClass = detectHistoricalBugClass(historicalRecommendation);
  const bugClassMatched = historicalBugClass ? changedBugClasses.has(historicalBugClass) : false;
  if (changedTokenSet.size === 0) {
    return {
      score: bugClassMatched ? 1 : null,
      overlapCount: 0,
      overlapTokens: [],
      bugClass: historicalBugClass,
      bugClassMatched,
    };
  }
  if (changedTokenSet.size === 0 || historicalTokens.size === 0) {
    return {
      score: bugClassMatched ? 1 : 0,
      overlapCount: 0,
      overlapTokens: [],
      bugClass: historicalBugClass,
      bugClassMatched,
    };
  }

  const overlapTokens = Array.from(historicalTokens).filter((token) => changedTokenSet.has(token));
  const denominator = Math.max(changedTokenSet.size, historicalTokens.size, 1);
  const tokenScore = overlapTokens.length / denominator;
  return {
    score: bugClassMatched ? Math.max(tokenScore, 1) : tokenScore,
    overlapCount: overlapTokens.length,
    overlapTokens,
    bugClass: historicalBugClass,
    bugClassMatched,
  };
}

function getRecommendationOutcomeDimensions(rawRecommendation = null, context = {}) {
  const recommendation = rawRecommendation && typeof rawRecommendation === 'object'
    ? rawRecommendation
    : {};
  const filePath = recommendation.file ?? recommendation.path ?? context.filePath ?? null;

  return {
    providerType: normalizeDimensionValue(
      context.providerType ?? recommendation.providerType ?? recommendation.provider?.type,
      { fallback: 'unknown' }
    ),
    providerModel: normalizeDimensionValue(
      context.providerModel ?? recommendation.providerModel ?? recommendation.provider?.model,
      { fallback: 'unknown' }
    ),
    language: normalizeDimensionValue(
      context.language ?? recommendation.language ?? inferLanguageFromFilePath(filePath),
      { fallback: 'unknown' }
    ),
    pathPattern: normalizePathPattern(
      context.pathPattern ?? recommendation.pathPattern ?? filePath,
      'unknown'
    ),
  };
}

function normalizeOutcomeDimensions(rawDimensions = {}, {
  recommendation = null,
  context = {},
} = {}) {
  const dimensions = (rawDimensions && typeof rawDimensions === 'object' && !Array.isArray(rawDimensions))
    ? rawDimensions
    : {};
  const recommendationDimensions = getRecommendationOutcomeDimensions(recommendation, context);
  return {
    providerType: normalizeDimensionValue(
      dimensions.providerType ?? dimensions.provider_type ?? recommendationDimensions.providerType,
      { fallback: 'unknown' }
    ),
    providerModel: normalizeDimensionValue(
      dimensions.providerModel ?? dimensions.provider_model ?? recommendationDimensions.providerModel,
      { fallback: 'unknown' }
    ),
    language: normalizeDimensionValue(
      dimensions.language ?? recommendationDimensions.language,
      { fallback: 'unknown' }
    ),
    pathPattern: normalizePathPattern(
      dimensions.pathPattern ?? dimensions.path_pattern ?? recommendationDimensions.pathPattern,
      recommendationDimensions.pathPattern
    ),
  };
}

function normalizeReviewScope(rawScope = {}) {
  const projectId = typeof rawScope.projectId === 'string' ? rawScope.projectId.trim() : '';
  const reviewType = typeof rawScope.reviewType === 'string'
    ? rawScope.reviewType.trim().toLowerCase()
    : '';
  const reviewId = typeof rawScope.reviewId === 'string' ? rawScope.reviewId.trim() : '';

  if (!projectId) {
    throw new Error('projectId is required for recommendation outcomes');
  }
  if (!reviewId) {
    throw new Error('reviewId is required for recommendation outcomes');
  }
  if (!VALID_REVIEW_TYPES.has(reviewType)) {
    throw new Error('reviewType must be one of: changeset, branch_review, pr_review, workspace_review');
  }

  return { projectId, reviewType, reviewId };
}

function normalizeReviewScopeList(rawScopes = []) {
  if (!Array.isArray(rawScopes)) return [];
  const deduped = new Map();
  for (const rawScope of rawScopes) {
    try {
      const normalized = normalizeReviewScope(rawScope);
      deduped.set(buildScopedOutcomeKey({
        projectId: normalized.projectId,
        reviewType: normalized.reviewType,
        reviewId: normalized.reviewId,
        recommendationKey: '*',
      }), normalized);
    } catch {
      continue;
    }
  }
  return Array.from(deduped.values());
}

function normalizeOutcomeStatus(rawStatus) {
  const normalized = typeof rawStatus === 'string'
    ? rawStatus.trim().toLowerCase()
    : '';
  if (!VALID_OUTCOME_STATUSES.has(normalized)) {
    throw new Error('status must be one of: addressed, dismissed');
  }
  return normalized;
}

function normalizeOutcomeNote(rawNote) {
  if (rawNote == null) return null;
  const normalized = typeof rawNote === 'string'
    ? rawNote.trim()
    : String(rawNote).trim();
  if (!normalized) return null;
  return normalized.slice(0, MAX_NOTE_LENGTH);
}

function normalizeRecommendationIdentity(rawRecommendation = null) {
  if (!rawRecommendation || typeof rawRecommendation !== 'object' || Array.isArray(rawRecommendation)) {
    throw new Error('recommendation must be an object when recommendationKey is omitted');
  }

  const normalized = {};
  for (const field of RECOMMENDATION_IDENTITY_FIELDS) {
    if (field === 'line') {
      const parsed = Number(rawRecommendation.line);
      normalized.line = Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : null;
      continue;
    }
    if (rawRecommendation[field] == null) {
      normalized[field] = null;
      continue;
    }
    normalized[field] = String(rawRecommendation[field]).trim();
  }
  return normalized;
}

function getRecommendationIdentityKey(rawRecommendation) {
  const explicitKey = normalizeRecommendationFingerprintPart(rawRecommendation?.recommendationKey);
  if (explicitKey) {
    return explicitKey;
  }
  const normalized = normalizeRecommendationIdentity(rawRecommendation);
  // Escape pipe characters in each part before joining to prevent collisions
  // when a field value naturally contains '|' (e.g., AI-generated descriptions).
  const escapePipe = (s) => s.replace(/\|/g, '\\|');
  return [
    escapePipe(normalizeRecommendationFingerprintPart(normalized.type)),
    escapePipe(normalizeRecommendationFingerprintPart(normalized.severity)),
    escapePipe(normalizeRecommendationFingerprintPart(normalized.title)),
    escapePipe(normalizeRecommendationFingerprintPart(normalized.description)),
    escapePipe(normalizeRecommendationFingerprintPart(normalized.file)),
    escapePipe(normalizeRecommendationFingerprintPart(normalized.line)),
    escapePipe(normalizeRecommendationFingerprintPart(normalized.suggestedFix)),
  ].join('|');
}

function normalizeRecommendationKey(rawKey) {
  const normalized = normalizeRecommendationFingerprintPart(rawKey);
  if (!normalized) {
    throw new Error('recommendationKey is required for recommendation outcomes');
  }
  return normalized;
}

function splitEscapedRecommendationIdentityKey(rawKey) {
  const normalizedKey = normalizeRecommendationKey(rawKey);
  const parts = [];
  let current = '';
  let escaping = false;

  for (const char of normalizedKey) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === '\\') {
      escaping = true;
      continue;
    }
    if (char === '|') {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }

  if (escaping) current += '\\';
  parts.push(current);
  while (parts.length < RECOMMENDATION_IDENTITY_FIELDS.length) {
    parts.push('');
  }
  return parts.slice(0, RECOMMENDATION_IDENTITY_FIELDS.length);
}

function parseRecommendationIdentityKey(rawKey) {
  const [type, severity, title, description, file, line, suggestedFix] =
    splitEscapedRecommendationIdentityKey(rawKey);
  const parsedLine = Number.parseInt(String(line || '').trim(), 10);
  return {
    type: type || null,
    severity: severity || null,
    title: title || null,
    description: description || null,
    file: file || null,
    line: Number.isFinite(parsedLine) && parsedLine > 0 ? parsedLine : null,
    suggestedFix: suggestedFix || null,
  };
}

function normalizeOutcomePayload(rawPayload = {}) {
  const payload = (rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload))
    ? rawPayload
    : {};
  const recommendation = payload.recommendation && typeof payload.recommendation === 'object'
    ? payload.recommendation
    : null;
  const recommendationKey = payload.recommendationKey
    ? normalizeRecommendationKey(payload.recommendationKey)
    : getRecommendationIdentityKey(recommendation);
  const dimensions = normalizeOutcomeDimensions(payload.dimensions, {
    recommendation,
    context: {
      providerType: payload.providerType ?? payload.provider_type ?? payload.provider?.type,
      providerModel: payload.providerModel ?? payload.provider_model ?? payload.provider?.model,
      language: payload.language,
      pathPattern: payload.pathPattern ?? payload.path_pattern,
      filePath: payload.filePath ?? payload.file_path,
    },
  });

  return {
    recommendationKey,
    status: normalizeOutcomeStatus(payload.status),
    note: normalizeOutcomeNote(payload.note),
    dimensions,
  };
}

function normalizeOutcomeKeyPayload(rawPayload = {}) {
  const payload = (rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload))
    ? rawPayload
    : {};
  const recommendationKey = payload.recommendationKey
    ? normalizeRecommendationKey(payload.recommendationKey)
    : getRecommendationIdentityKey(payload.recommendation);
  return {
    recommendationKey,
  };
}

function buildScopedOutcomeKey({ projectId, reviewType, reviewId, recommendationKey }) {
  return [projectId, reviewType, reviewId, recommendationKey].join('|');
}

function toOutcomeRecord(row) {
  if (!row) return null;
  const note = typeof row.note === 'string' ? row.note.trim() : '';
  const dimensions = normalizeOutcomeDimensions({
    providerType: row.provider_type,
    providerModel: row.provider_model,
    language: row.language,
    pathPattern: row.path_pattern,
  });
  return {
    projectId: row.project_id,
    reviewType: row.review_type,
    reviewId: row.review_id,
    recommendationKey: normalizeRecommendationFingerprintPart(row.recommendation_key),
    status: row.status,
    note: note || null,
    dimensions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function dedupeToLatestOutcomeRecords(rows = []) {
  const deduped = new Map();
  for (const row of rows) {
    const record = toOutcomeRecord(row);
    if (!record) continue;
    if (!deduped.has(record.recommendationKey)) {
      deduped.set(record.recommendationKey, record);
      continue;
    }

    const current = deduped.get(record.recommendationKey);
    const currentTs = Date.parse(String(current.updatedAt || ''));
    const candidateTs = Date.parse(String(record.updatedAt || ''));
    const candidateIsNewer = Number.isFinite(candidateTs)
      ? (!Number.isFinite(currentTs) || candidateTs > currentTs)
      : false;
    if (candidateIsNewer) {
      deduped.set(record.recommendationKey, record);
    }
  }
  return Array.from(deduped.values());
}

function buildOutcomeTelemetry(outcomes = [], reviewRecommendations = []) {
  const total = outcomes.length;
  const addressed = outcomes.filter((entry) => entry.status === 'addressed').length;
  const dismissed = outcomes.filter((entry) => entry.status === 'dismissed').length;
  const addressedRate = total > 0 ? addressed / total : 0;
  const dismissedRate = total > 0 ? dismissed / total : 0;

  const issueRecommendationKeyCounts = new Map();
  const findingRecommendationKeyCounts = new Map();
  for (const recommendation of Array.isArray(reviewRecommendations) ? reviewRecommendations : []) {
    const recommendationType = String(recommendation?.type || '').trim().toLowerCase();
    if (recommendationType !== 'issue' && recommendationType !== 'suggestion') continue;
    let recommendationKey = null;
    try {
      recommendationKey = getRecommendationIdentityKey(recommendation);
    } catch {
      recommendationKey = null;
    }
    if (!recommendationKey) continue;
    findingRecommendationKeyCounts.set(
      recommendationKey,
      (findingRecommendationKeyCounts.get(recommendationKey) || 0) + 1
    );
    if (recommendationType !== 'issue') continue;
    issueRecommendationKeyCounts.set(
      recommendationKey,
      (issueRecommendationKeyCounts.get(recommendationKey) || 0) + 1
    );
  }
  const issueTotal = Array.from(issueRecommendationKeyCounts.values()).reduce(
    (sum, count) => sum + count,
    0
  );
  const outcomeByRecommendationKey = new Map();
  for (const outcome of Array.isArray(outcomes) ? outcomes : []) {
    const recommendationKey = normalizeRecommendationFingerprintPart(outcome?.recommendationKey);
    if (!recommendationKey) continue;
    outcomeByRecommendationKey.set(recommendationKey, outcome);
  }
  let issueAddressed = 0;
  let issueDismissed = 0;
  let findingAddressed = 0;
  let findingDismissed = 0;
  for (const [recommendationKey, keyCount] of issueRecommendationKeyCounts.entries()) {
    const outcome = outcomeByRecommendationKey.get(recommendationKey);
    if (!outcome) continue;
    if (outcome.status === 'addressed') issueAddressed += keyCount;
    if (outcome.status === 'dismissed') issueDismissed += keyCount;
  }
  for (const [recommendationKey, keyCount] of findingRecommendationKeyCounts.entries()) {
    const outcome = outcomeByRecommendationKey.get(recommendationKey);
    if (!outcome) continue;
    if (outcome.status === 'addressed') findingAddressed += keyCount;
    if (outcome.status === 'dismissed') findingDismissed += keyCount;
  }

  return {
    total,
    addressed,
    dismissed,
    addressedRate,
    dismissedRate,
    issueTotal,
    issueAddressed,
    issueDismissed,
    issueAddressedRate: issueTotal > 0 ? issueAddressed / issueTotal : 0,
    issueDismissedRate: issueTotal > 0 ? issueDismissed / issueTotal : 0,
    findingTotal: Array.from(findingRecommendationKeyCounts.values()).reduce((sum, count) => sum + count, 0),
    findingAddressed,
    findingDismissed,
    findingAddressedRate: findingRecommendationKeyCounts.size > 0
      ? findingAddressed / Array.from(findingRecommendationKeyCounts.values()).reduce((sum, count) => sum + count, 0)
      : 0,
    findingDismissedRate: findingRecommendationKeyCounts.size > 0
      ? findingDismissed / Array.from(findingRecommendationKeyCounts.values()).reduce((sum, count) => sum + count, 0)
      : 0,
  };
}

function normalizeRecommendationKeyList(rawKeys = null) {
  if (!Array.isArray(rawKeys)) return [];
  const deduped = new Set();
  for (const rawKey of rawKeys) {
    const normalized = normalizeRecommendationFingerprintPart(rawKey);
    if (!normalized) continue;
    deduped.add(normalized);
    if (deduped.size >= 400) break;
  }
  return Array.from(deduped);
}

function normalizeProjectId(rawProjectId) {
  const projectId = typeof rawProjectId === 'string' ? rawProjectId.trim() : '';
  if (!projectId) {
    throw new Error('projectId is required for recommendation outcomes');
  }
  return projectId;
}

function normalizeDimensionsByRecommendationKey(rawLookup = {}) {
  const lookup = (rawLookup && typeof rawLookup === 'object' && !Array.isArray(rawLookup))
    ? rawLookup
    : {};
  const normalized = {};
  for (const [rawKey, rawDimensions] of Object.entries(lookup)) {
    const recommendationKey = normalizeRecommendationFingerprintPart(rawKey);
    if (!recommendationKey) continue;
    normalized[recommendationKey] = normalizeOutcomeDimensions(rawDimensions);
  }
  return normalized;
}

function outcomeMatchesDimensions(outcome, expectedDimensions = null) {
  if (!expectedDimensions || typeof expectedDimensions !== 'object') return true;
  const normalizedExpected = normalizeOutcomeDimensions(expectedDimensions);
  const outcomeDimensions = normalizeOutcomeDimensions(outcome?.dimensions || {});
  return (
    normalizedExpected.providerType === outcomeDimensions.providerType
    && normalizedExpected.providerModel === outcomeDimensions.providerModel
    && normalizedExpected.language === outcomeDimensions.language
    && normalizedExpected.pathPattern === outcomeDimensions.pathPattern
  );
}

function getNowExpression() {
  return getDbType() === 'sqlite' ? "datetime('now')" : 'NOW()';
}

async function upsertOutcome(rawScope, rawPayload) {
  const scope = normalizeReviewScope(rawScope);
  const payload = normalizeOutcomePayload(rawPayload);
  const nowExpr = getNowExpression();

  const result = await db.query(
    `INSERT INTO review_outcomes (
        project_id, review_type, review_id, recommendation_key, status, note,
        provider_type, provider_model, language, path_pattern
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (project_id, review_type, review_id, recommendation_key) DO UPDATE SET
       status = EXCLUDED.status,
       note = EXCLUDED.note,
       provider_type = EXCLUDED.provider_type,
       provider_model = EXCLUDED.provider_model,
       language = EXCLUDED.language,
       path_pattern = EXCLUDED.path_pattern,
       updated_at = ${nowExpr}
     RETURNING project_id, review_type, review_id, recommendation_key, status, note,
       provider_type, provider_model, language, path_pattern,
       created_at, updated_at`,
    [
      scope.projectId,
      scope.reviewType,
      scope.reviewId,
      payload.recommendationKey,
      payload.status,
      payload.note,
      payload.dimensions.providerType,
      payload.dimensions.providerModel,
      payload.dimensions.language,
      payload.dimensions.pathPattern,
    ]
  );

  return toOutcomeRecord(result.rows?.[0] || null);
}

async function upsertOutcomes(rawScope, rawPayloads = []) {
  if (!Array.isArray(rawPayloads) || rawPayloads.length === 0) {
    return [];
  }
  const written = [];
  for (const payload of rawPayloads) {
    // Keep this deterministic and simple; per-review write volume is tiny.
    const persisted = await upsertOutcome(rawScope, payload);
    if (persisted) written.push(persisted);
  }
  return written;
}

async function deleteOutcome(rawScope, rawPayload) {
  const scope = normalizeReviewScope(rawScope);
  const payload = normalizeOutcomeKeyPayload(rawPayload);
  const result = await db.query(
    `DELETE FROM review_outcomes
     WHERE project_id = $1
       AND review_type = $2
       AND review_id = $3
       AND recommendation_key = $4
     RETURNING project_id, review_type, review_id, recommendation_key, status, note,
       provider_type, provider_model, language, path_pattern,
       created_at, updated_at`,
    [
      scope.projectId,
      scope.reviewType,
      scope.reviewId,
      payload.recommendationKey,
    ]
  );
  return toOutcomeRecord(result.rows?.[0] || null);
}

async function listOutcomes(rawScope, options = {}) {
  const scope = normalizeReviewScope(rawScope);
  const recommendationKeys = normalizeRecommendationKeyList(options?.recommendationKeys);

  const params = [scope.projectId, scope.reviewType, scope.reviewId];
  let whereSql = 'project_id = $1 AND review_type = $2 AND review_id = $3';
  if (recommendationKeys.length > 0) {
    const placeholders = recommendationKeys
      .map((_, index) => `$${index + 4}`)
      .join(', ');
    whereSql += ` AND recommendation_key IN (${placeholders})`;
    params.push(...recommendationKeys);
  }

  const result = await db.query(
    `SELECT project_id, review_type, review_id, recommendation_key, status, note,
       provider_type, provider_model, language, path_pattern,
       created_at, updated_at
     FROM review_outcomes
     WHERE ${whereSql}
     ORDER BY updated_at DESC`,
    params
  );

  const outcomes = dedupeToLatestOutcomeRecords(result.rows || []);
  const byRecommendationKey = outcomes.reduce((acc, outcome) => {
    acc[outcome.recommendationKey] = {
      recommendationKey: outcome.recommendationKey,
      status: outcome.status,
      note: outcome.note,
      dimensions: outcome.dimensions,
      updatedAt: outcome.updatedAt,
    };
    return acc;
  }, {});

  return {
    scope,
    outcomes,
    byRecommendationKey,
    telemetry: buildOutcomeTelemetry(outcomes, options?.reviewRecommendations || []),
  };
}

async function listProjectOutcomesByRecommendationKeys(rawProjectId, rawRecommendationKeys, options = {}) {
  const projectId = normalizeProjectId(rawProjectId);
  const recommendationKeys = normalizeRecommendationKeyList(rawRecommendationKeys);
  const dimensionsByRecommendationKey = normalizeDimensionsByRecommendationKey(options?.dimensionsByRecommendationKey);
  if (recommendationKeys.length === 0) {
    return {
      projectId,
      outcomes: [],
      byRecommendationKey: {},
    };
  }

  const maxRows = Math.max(1, Math.trunc(Number(options?.maxRows) || 2000));
  const maxPerKey = Math.max(1, Math.trunc(Number(options?.maxPerKey) || 20));
  const scopedClauses = [];
  const params = [projectId];
  for (const recommendationKey of recommendationKeys) {
    const expectedDimensions = dimensionsByRecommendationKey[recommendationKey];
    const recommendationKeyPlaceholder = `$${params.length + 1}`;
    params.push(recommendationKey);
    if (expectedDimensions && typeof expectedDimensions === 'object') {
      const providerTypePlaceholder = `$${params.length + 1}`;
      params.push(expectedDimensions.providerType);
      const providerModelPlaceholder = `$${params.length + 1}`;
      params.push(expectedDimensions.providerModel);
      const languagePlaceholder = `$${params.length + 1}`;
      params.push(expectedDimensions.language);
      const pathPatternPlaceholder = `$${params.length + 1}`;
      params.push(expectedDimensions.pathPattern);
      scopedClauses.push(
        `(recommendation_key = ${recommendationKeyPlaceholder}`
        + ` AND COALESCE(provider_type, 'unknown') = ${providerTypePlaceholder}`
        + ` AND COALESCE(provider_model, 'unknown') = ${providerModelPlaceholder}`
        + ` AND COALESCE(language, 'unknown') = ${languagePlaceholder}`
        + ` AND COALESCE(path_pattern, 'unknown') = ${pathPatternPlaceholder})`
      );
    } else {
      scopedClauses.push(`(recommendation_key = ${recommendationKeyPlaceholder})`);
    }
  }
  const maxPerKeyPlaceholder = `$${params.length + 1}`;
  params.push(maxPerKey);
  const maxRowsPlaceholder = `$${params.length + 1}`;
  params.push(maxRows);
  const result = await db.query(
    `WITH scoped AS (
       SELECT project_id, review_type, review_id, recommendation_key, status, note,
         provider_type, provider_model, language, path_pattern,
         created_at, updated_at
       FROM review_outcomes
       WHERE project_id = $1
         AND (${scopedClauses.join(' OR ')})
     ),
     ranked AS (
       SELECT project_id, review_type, review_id, recommendation_key, status, note,
         provider_type, provider_model, language, path_pattern,
         created_at, updated_at,
         ROW_NUMBER() OVER (PARTITION BY recommendation_key ORDER BY updated_at DESC) AS recommendation_rank
       FROM scoped
     )
     SELECT project_id, review_type, review_id, recommendation_key, status, note,
       provider_type, provider_model, language, path_pattern,
       created_at, updated_at
     FROM ranked
     WHERE recommendation_rank <= ${maxPerKeyPlaceholder}
     ORDER BY updated_at DESC
     LIMIT ${maxRowsPlaceholder}`,
    params
  );

  const perKeyCounts = {};
  const outcomes = [];
  for (const row of result.rows || []) {
    const record = toOutcomeRecord(row);
    if (!record) continue;
    const key = record.recommendationKey;
    const expectedDimensions = dimensionsByRecommendationKey[key];
    if (expectedDimensions && !outcomeMatchesDimensions(record, expectedDimensions)) {
      continue;
    }
    const currentCount = perKeyCounts[key] || 0;
    if (currentCount >= maxPerKey) continue;
    perKeyCounts[key] = currentCount + 1;
    outcomes.push(record);
  }

  const byRecommendationKey = {};
  for (const recommendationKey of recommendationKeys) {
    byRecommendationKey[recommendationKey] = {
      recommendationKey,
      total: 0,
      dismissed: 0,
      addressed: 0,
      dismissedRate: 0,
      dimensions: dimensionsByRecommendationKey[recommendationKey] || null,
    };
  }
  for (const outcome of outcomes) {
    const entry = byRecommendationKey[outcome.recommendationKey];
    if (!entry) continue;
    entry.total += 1;
    if (outcome.status === 'dismissed') entry.dismissed += 1;
    if (outcome.status === 'addressed') entry.addressed += 1;
  }
  Object.values(byRecommendationKey).forEach((entry) => {
    entry.dismissed = Math.min(entry.dismissed, entry.total);
    entry.addressed = Math.min(entry.addressed, entry.total);
    entry.dismissedRate = entry.total > 0 ? entry.dismissed / entry.total : 0;
  });

  return {
    projectId,
    outcomes,
    byRecommendationKey,
  };
}

async function getProjectDismissalSummary(projectId, {
  minSamples = 3,
  minDismissedRate = 0.6,
  limit = 3,
} = {}) {
  const normalizedId = normalizeProjectId(projectId);
  if (!normalizedId) return { patterns: [] };
  const dbType = getDbType();
  const recentFilter = dbType === 'sqlite'
    ? "AND updated_at >= date('now', '-30 days')"
    : "AND updated_at >= CURRENT_DATE - INTERVAL '30 days'";

  const result = await db.query(
    `SELECT path_pattern, language, status, COUNT(*) as cnt
     FROM review_outcomes
     WHERE project_id = $1 ${recentFilter}
     GROUP BY path_pattern, language, status
     ORDER BY cnt DESC`,
    [normalizedId]
  );

  const groups = new Map();
  for (const row of result.rows || []) {
    const key = `${row.path_pattern || '*'}|${row.language || '*'}`;
    if (!groups.has(key)) {
      groups.set(key, { total: 0, dismissed: 0, pathPattern: row.path_pattern, language: row.language });
    }
    const g = groups.get(key);
    const count = Number(row.cnt) || 0;
    g.total += count;
    if (row.status === 'dismissed') g.dismissed += count;
  }

  const patterns = [];
  for (const [, g] of groups) {
    if (g.total < minSamples) continue;
    const rate = g.dismissed / g.total;
    if (rate < minDismissedRate) continue;
    patterns.push({
      pathPattern: g.pathPattern || '*',
      language: g.language || 'unknown',
      total: g.total,
      dismissed: g.dismissed,
      dismissedRate: rate,
    });
  }

  patterns.sort((a, b) => b.dismissed - a.dismissed);
  return { patterns: patterns.slice(0, limit) };
}

async function listProjectHistoricalFindings(rawProjectId, {
  changedPaths = [],
  changedRecommendations = [],
  maxRows = 300,
  maxFindings = 6,
  maxPerRecommendation = 10,
  maxAgeDays = 180,
  minPathAffinityScore = MIN_HISTORICAL_PATH_AFFINITY_SCORE,
  minFamilyAffinityScore = MIN_HISTORICAL_FAMILY_AFFINITY_SCORE,
} = {}) {
  const projectId = normalizeProjectId(rawProjectId);
  const normalizedChangedPaths = Array.from(new Set(
    (Array.isArray(changedPaths) ? changedPaths : [])
      .map((value) => normalizePathForDimensions(value))
      .filter(Boolean)
  ));
  if (normalizedChangedPaths.length === 0) {
    return {
      projectId,
      changedPaths: [],
      findings: [],
    };
  }

  const normalizedMaxRows = Math.max(1, Math.trunc(Number(maxRows) || 300));
  const normalizedMaxFindings = Math.max(1, Math.trunc(Number(maxFindings) || 6));
  const normalizedMaxPerRecommendation = Math.max(1, Math.trunc(Number(maxPerRecommendation) || 10));
  const normalizedMaxAgeDays = Math.max(1, Math.trunc(Number(maxAgeDays) || 180));
  const normalizedMinPathAffinityScore = Math.max(
    0,
    Math.min(1, Number.isFinite(Number(minPathAffinityScore)) ? Number(minPathAffinityScore) : MIN_HISTORICAL_PATH_AFFINITY_SCORE)
  );
  const normalizedMinFamilyAffinityScore = Math.max(
    0,
    Math.min(1, Number.isFinite(Number(minFamilyAffinityScore)) ? Number(minFamilyAffinityScore) : MIN_HISTORICAL_FAMILY_AFFINITY_SCORE)
  );
  const changedPathSet = new Set(normalizedChangedPaths.map((value) => value.toLowerCase()));
  const changedPathPatterns = Array.from(new Set(
    normalizedChangedPaths.map((value) => normalizePathPattern(value))
  ));

  const params = [projectId];
  const pathPatternPlaceholders = changedPathPatterns.map((pattern) => {
    params.push(pattern);
    return `$${params.length}`;
  });
  const ageExpression = getDbType() === 'sqlite'
    ? `datetime('now', '-${normalizedMaxAgeDays} days')`
    : `NOW() - INTERVAL '${normalizedMaxAgeDays} days'`;
  params.push(normalizedMaxRows);
  const maxRowsPlaceholder = `$${params.length}`;

  const result = await db.query(
    `SELECT project_id, review_type, review_id, recommendation_key, status, note,
       provider_type, provider_model, language, path_pattern,
       created_at, updated_at
     FROM review_outcomes
     WHERE project_id = $1
       AND updated_at >= ${ageExpression}
       AND path_pattern IN (${pathPatternPlaceholders.join(', ')})
     ORDER BY updated_at DESC
     LIMIT ${maxRowsPlaceholder}`,
    params
  );

  const grouped = new Map();
  for (const row of result.rows || []) {
    const record = toOutcomeRecord(row);
    if (!record?.recommendationKey) continue;
    const identity = parseRecommendationIdentityKey(record.recommendationKey);
    const identityFile = normalizePathForDimensions(identity.file || '');
    const exactPathMatch = identityFile && changedPathSet.has(identityFile.toLowerCase());
    const pathPatternMatch = changedPathPatterns.includes(record.dimensions?.pathPattern || '');
    const pathAffinity = scoreHistoricalPathAffinity(normalizedChangedPaths, identityFile);
    const familyAffinity = scoreHistoricalFamilyAffinity(normalizedChangedPaths, changedRecommendations, identity);
    if (!exactPathMatch && !pathPatternMatch) continue;
    if (!exactPathMatch && pathAffinity.score < normalizedMinPathAffinityScore) continue;
    if (
      !exactPathMatch
      && Number.isFinite(familyAffinity.score)
      && familyAffinity.score < normalizedMinFamilyAffinityScore
    ) continue;

    const matchType = exactPathMatch ? 'exact_path' : 'path_pattern';
    const matchValue = exactPathMatch ? identityFile : (record.dimensions?.pathPattern || null);
    if (!grouped.has(record.recommendationKey)) {
      grouped.set(record.recommendationKey, {
        recommendationKey: record.recommendationKey,
        recommendation: identity,
        matchType,
        matchValue,
        language: record.dimensions?.language || 'unknown',
        pathPattern: record.dimensions?.pathPattern || null,
        pathAffinityScore: exactPathMatch ? 1 : pathAffinity.score,
        pathAffinitySharedSegments: exactPathMatch ? pathAffinity.sharedSegments : pathAffinity.sharedSegments,
        matchedChangedPath: exactPathMatch ? identityFile : pathAffinity.matchedPath,
        familyAffinityScore: Number.isFinite(familyAffinity.score) ? familyAffinity.score : null,
        familyAffinityOverlapCount: familyAffinity.overlapCount,
        familyAffinityOverlapTokens: familyAffinity.overlapTokens,
        bugClass: familyAffinity.bugClass,
        bugClassMatched: familyAffinity.bugClassMatched === true,
        totalCount: 0,
        addressedCount: 0,
        dismissedCount: 0,
        lastStatus: record.status,
        lastUpdatedAt: record.updatedAt,
        relevance: exactPathMatch
          ? `Exact-path history for ${identityFile}`
          : `Path-pattern history near ${pathAffinity.matchedPath || identityFile || record.dimensions?.pathPattern || 'unknown'}`,
      });
    }

    const entry = grouped.get(record.recommendationKey);
    if (entry.totalCount >= normalizedMaxPerRecommendation) continue;
    entry.totalCount += 1;
    if (record.status === 'addressed') entry.addressedCount += 1;
    if (record.status === 'dismissed') entry.dismissedCount += 1;

    const currentTs = Date.parse(String(entry.lastUpdatedAt || ''));
    const candidateTs = Date.parse(String(record.updatedAt || ''));
    if (
      (!Number.isFinite(currentTs) && Number.isFinite(candidateTs))
      || (Number.isFinite(candidateTs) && candidateTs > currentTs)
    ) {
      entry.lastUpdatedAt = record.updatedAt;
      entry.lastStatus = record.status;
    }
    if (entry.matchType !== 'exact_path' && exactPathMatch) {
      entry.matchType = 'exact_path';
      entry.matchValue = identityFile;
      entry.pathAffinityScore = 1;
      entry.matchedChangedPath = identityFile;
      entry.relevance = `Exact-path history for ${identityFile}`;
    }
  }

  const findings = Array.from(grouped.values())
    .sort((left, right) => {
      if (left.matchType !== right.matchType) {
        return left.matchType === 'exact_path' ? -1 : 1;
      }
      const affinityDiff = (right.pathAffinityScore || 0) - (left.pathAffinityScore || 0);
      if (affinityDiff !== 0) return affinityDiff;
      const sharedSegmentDiff = (right.pathAffinitySharedSegments || 0) - (left.pathAffinitySharedSegments || 0);
      if (sharedSegmentDiff !== 0) return sharedSegmentDiff;
      const familyAffinityDiff = ((right.familyAffinityScore ?? -1) - (left.familyAffinityScore ?? -1));
      if (familyAffinityDiff !== 0) return familyAffinityDiff;
      const bugClassDiff = Number(right.bugClassMatched === true) - Number(left.bugClassMatched === true);
      if (bugClassDiff !== 0) return bugClassDiff;
      const familyOverlapDiff = (right.familyAffinityOverlapCount || 0) - (left.familyAffinityOverlapCount || 0);
      if (familyOverlapDiff !== 0) return familyOverlapDiff;
      const severityDiff =
        (RECOMMENDATION_SEVERITY_WEIGHT[right.recommendation?.severity] || 0)
        - (RECOMMENDATION_SEVERITY_WEIGHT[left.recommendation?.severity] || 0);
      if (severityDiff !== 0) return severityDiff;
      const rightTs = Date.parse(String(right.lastUpdatedAt || ''));
      const leftTs = Date.parse(String(left.lastUpdatedAt || ''));
      if (Number.isFinite(rightTs) || Number.isFinite(leftTs)) {
        return (Number.isFinite(rightTs) ? rightTs : 0) - (Number.isFinite(leftTs) ? leftTs : 0);
      }
      return (right.totalCount || 0) - (left.totalCount || 0);
    })
    .slice(0, normalizedMaxFindings);

  return {
    projectId,
    changedPaths: normalizedChangedPaths,
    findings,
  };
}

async function countIssueOutcomesForReviewScopes({
  projectId,
  reviewScopes = [],
  recommendationTypes = ['issue'],
} = {}) {
  const normalizedProjectId = normalizeProjectId(projectId);
  const normalizedScopes = normalizeReviewScopeList(
    Array.isArray(reviewScopes)
      ? reviewScopes.map((scope) => ({
        projectId: normalizedProjectId,
        reviewType: scope?.reviewType,
        reviewId: scope?.reviewId,
      }))
      : []
  );

  if (normalizedScopes.length === 0) {
    return {
      total: 0,
      addressed: 0,
      dismissed: 0,
      addressedRate: 0,
      dismissedRate: 0,
    };
  }

  if (normalizedScopes.length > 500) {
    throw new Error('Too many review scopes requested for outcome counting');
  }

  const normalizedRecommendationTypes = Array.from(new Set(
    (Array.isArray(recommendationTypes) ? recommendationTypes : ['issue'])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter((value) => value === 'issue' || value === 'suggestion')
  ));
  if (normalizedRecommendationTypes.length === 0) {
    return {
      total: 0,
      addressed: 0,
      dismissed: 0,
      addressedRate: 0,
      dismissedRate: 0,
    };
  }

  const params = [normalizedProjectId];
  const scopeClauses = normalizedScopes.map((scope) => {
    params.push(scope.reviewType);
    const reviewTypePlaceholder = `$${params.length}`;
    params.push(scope.reviewId);
    const reviewIdPlaceholder = `$${params.length}`;
    return `(review_type = ${reviewTypePlaceholder} AND review_id = ${reviewIdPlaceholder})`;
  });
  const keyClauses = normalizedRecommendationTypes.map((recommendationType) => {
    params.push(`${recommendationType}|%`);
    return `recommendation_key LIKE $${params.length}`;
  });

  const result = await db.query(
    `SELECT status, COUNT(*) AS cnt
     FROM review_outcomes
     WHERE project_id = $1
       AND (${keyClauses.join(' OR ')})
       AND (${scopeClauses.join(' OR ')})
     GROUP BY status`,
    params
  );

  let addressed = 0;
  let dismissed = 0;
  for (const row of result.rows || []) {
    const count = Math.max(0, Number(row?.cnt) || 0);
    if (row?.status === 'addressed') addressed += count;
    if (row?.status === 'dismissed') dismissed += count;
  }
  const total = addressed + dismissed;

  return {
    total,
    addressed,
    dismissed,
    addressedRate: total > 0 ? addressed / total : 0,
    dismissedRate: total > 0 ? dismissed / total : 0,
  };
}

const reviewOutcomeService = {
  getRecommendationIdentityKey,
  getRecommendationOutcomeDimensions,
  upsertOutcome,
  upsertOutcomes,
  deleteOutcome,
  listOutcomes,
  listProjectOutcomesByRecommendationKeys,
  getProjectDismissalSummary,
  listProjectHistoricalFindings,
  countIssueOutcomesForReviewScopes,
  __testing: {
    normalizeProjectId,
    normalizeReviewScope,
    normalizeReviewScopeList,
    normalizeOutcomePayload,
    normalizeOutcomeKeyPayload,
    normalizeOutcomeStatus,
    normalizeOutcomeNote,
    normalizeRecommendationIdentity,
    normalizeRecommendationKey,
    normalizeRecommendationFingerprintPart,
    splitEscapedRecommendationIdentityKey,
    parseRecommendationIdentityKey,
    normalizeOutcomeDimensions,
    normalizeDimensionsByRecommendationKey,
    outcomeMatchesDimensions,
    inferLanguageFromFilePath,
    normalizePathPattern,
    splitNormalizedPathSegments,
    countSharedLeadingPathSegments,
    scoreHistoricalPathAffinity,
    extractHistoricalFamilyTokens,
    buildHistoricalFamilyTokenSet,
    scoreHistoricalFamilyAffinity,
    getRecommendationOutcomeDimensions,
    getRecommendationIdentityKey,
    buildScopedOutcomeKey,
    dedupeToLatestOutcomeRecords,
    buildOutcomeTelemetry,
  },
};

export default reviewOutcomeService;
