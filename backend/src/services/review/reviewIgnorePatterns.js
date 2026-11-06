/** Review Ignore Patterns — Scope/pattern matching, global ignore patterns, path normalization. */

import {
  REVIEW_IGNORE_PATTERNS_SETTING_KEY,
  REVIEW_IGNORE_PATTERNS_SELECTED_PRESET_SETTING_KEY,
  REVIEW_IGNORE_PATTERNS_CACHE_TTL_MS,
} from './reviewConstants.js';
import { normalizePathForMatch } from './reviewHelpers.js';
import { createSettingsReadError } from './reviewErrors.js';
import db from '../../db/connection.js';

let reviewIgnorePatternCache = {
  patterns: [],
  expiresAt: 0,
};
let reviewIgnorePresetCache = {
  presetId: null,
  expiresAt: 0,
};

function invalidateIgnorePatternCache() {
  reviewIgnorePatternCache = { patterns: [], expiresAt: 0 };
  reviewIgnorePresetCache = { presetId: null, expiresAt: 0 };
}

function normalizeScopePatternList(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : String(value).split(/[\n,]/);
  return raw
    .map((entry) => String(entry || '').trim())
    .filter(Boolean)
    .slice(0, 100);
}

function parseBooleanSetting(value, fallback = true) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['false', '0', 'off', 'no'].includes(normalized)) return false;
    if (['true', '1', 'on', 'yes'].includes(normalized)) return true;
  }
  return fallback;
}

function normalizeReviewScope(scope) {
  if (!scope || typeof scope !== 'object') {
    return {
      includePatterns: [],
      excludePatterns: [],
      applyGlobalIgnorePatterns: true,
      hasExplicitScope: false,
    };
  }
  const includePatterns = normalizeScopePatternList(scope.includePatterns || scope.include);
  const excludePatterns = normalizeScopePatternList(scope.excludePatterns || scope.exclude);
  const applyGlobalIgnorePatterns = parseBooleanSetting(scope.applyGlobalIgnorePatterns, true);
  return {
    includePatterns,
    excludePatterns,
    applyGlobalIgnorePatterns,
    hasExplicitScope:
      includePatterns.length > 0 ||
      excludePatterns.length > 0 ||
      applyGlobalIgnorePatterns === false,
  };
}

function dedupePatternList(patterns) {
  const out = [];
  const seen = new Set();
  for (const pattern of normalizeScopePatternList(patterns)) {
    const key = pattern.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pattern);
  }
  return out;
}

function parseStoredPatternSetting(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === '') return [];
  if (Array.isArray(rawValue)) return normalizeScopePatternList(rawValue);

  const text = String(rawValue);
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return normalizeScopePatternList(parsed);
    }
    if (typeof parsed === 'string') {
      return normalizeScopePatternList(parsed);
    }
  } catch {
    // Fall back to text parsing
  }
  return normalizeScopePatternList(text);
}

async function getGlobalReviewIgnorePatterns() {
  const now = Date.now();
  if (reviewIgnorePatternCache.expiresAt > now) {
    return reviewIgnorePatternCache.patterns;
  }

  try {
    const result = await db.query(
      'SELECT value FROM settings WHERE id = $1',
      [REVIEW_IGNORE_PATTERNS_SETTING_KEY]
    );
    const patterns = result.rows?.[0]?.value
      ? parseStoredPatternSetting(result.rows[0].value)
      : [];
    const deduped = dedupePatternList(patterns);
    reviewIgnorePatternCache = {
      patterns: deduped,
      expiresAt: now + REVIEW_IGNORE_PATTERNS_CACHE_TTL_MS,
    };
    return deduped;
  } catch (error) {
    throw createSettingsReadError({
      settingKey: REVIEW_IGNORE_PATTERNS_SETTING_KEY,
      settingLabel: 'review ignore patterns',
      operation: 'read review ignore patterns',
      cause: error,
    });
  }
}

async function getGlobalReviewIgnorePresetSelection() {
  const now = Date.now();
  if (reviewIgnorePresetCache.expiresAt > now) {
    return reviewIgnorePresetCache.presetId;
  }

  try {
    const result = await db.query(
      'SELECT value FROM settings WHERE id = $1',
      [REVIEW_IGNORE_PATTERNS_SELECTED_PRESET_SETTING_KEY]
    );
    const presetId = result.rows?.[0]?.value
      ? String(result.rows[0].value).trim()
      : null;
    reviewIgnorePresetCache = {
      presetId: presetId || null,
      expiresAt: now + REVIEW_IGNORE_PATTERNS_CACHE_TTL_MS,
    };
    return reviewIgnorePresetCache.presetId;
  } catch (error) {
    console.warn('[ReviewService] Failed to load review ignore preset selection:', error.message);
    reviewIgnorePresetCache = {
      presetId: null,
      expiresAt: now + 5000,
    };
    return null;
  }
}

async function buildEffectiveScope(scope) {
  const requestedScope = normalizeReviewScope(scope);
  const globalExcludePatterns = requestedScope.applyGlobalIgnorePatterns
    ? await getGlobalReviewIgnorePatterns()
    : [];
  const excludePatterns = dedupePatternList([
    ...globalExcludePatterns,
    ...requestedScope.excludePatterns,
  ]);
  const hasEffectiveScope = requestedScope.includePatterns.length > 0 || excludePatterns.length > 0;
  const effectiveScope = hasEffectiveScope
    ? {
      includePatterns: requestedScope.includePatterns,
      excludePatterns,
    }
    : null;
  return {
    requestedScope,
    effectiveScope,
    globalExcludePatterns,
  };
}

function wildcardToRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '__DOUBLE_STAR__')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
    .replace(/__DOUBLE_STAR__/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function pathMatchesPattern(filePath, pattern) {
  const normalizedPath = normalizePathForMatch(filePath);
  const normalizedPattern = normalizePathForMatch(pattern);
  if (!normalizedPattern) return false;

  const hasWildcard = normalizedPattern.includes('*') || normalizedPattern.includes('?');
  if (hasWildcard) {
    const regex = wildcardToRegex(normalizedPattern);
    if (regex.test(normalizedPath)) return true;
    // .gitignore-style: patterns without '/' match against the basename too,
    // so '*.md' matches 'docs/README.md', not just 'README.md'.
    if (!normalizedPattern.includes('/')) {
      const basename = normalizedPath.split('/').pop() || '';
      return regex.test(basename);
    }
    return false;
  }

  return normalizedPath.toLowerCase().includes(normalizedPattern.toLowerCase());
}

function matchesAnyPattern(filePath, patterns) {
  return patterns.some((pattern) => pathMatchesPattern(filePath, pattern));
}

function matchesScopeEntry(entry, scope) {
  const paths = [entry.path, entry.oldPath].filter(Boolean);
  if (paths.length === 0) return false;

  if (scope.includePatterns.length > 0 && !paths.some((p) => matchesAnyPattern(p, scope.includePatterns))) {
    return false;
  }
  if (scope.excludePatterns.length > 0 && paths.some((p) => matchesAnyPattern(p, scope.excludePatterns))) {
    return false;
  }
  return true;
}

const CODE_FILE_RE = /\.(c|cc|cpp|cs|go|java|js|jsx|kt|mjs|py|rb|rs|swift|ts|tsx)$/i;
const CONFIG_FILE_RE = /(^|\/)(config|configs|settings|docker|deploy|infra)\b|(^|\/)\.?env(\.|$)|(^|\/)(package|tsconfig|vite|webpack|babel|jest|vitest|eslint|prettier|caddy|nginx|docker-compose)\b/i;
const TEST_FILE_RE = /(^|\/)(__tests__|tests?|specs?)(\/|$)|\.(test|spec)\.[^/]+$/i;
const HIGH_RISK_RE = /(auth|permission|rbac|acl|security|crypto|token|session|secret|payment|billing|checkout|invoice|wallet|deploy|migration|schema|sql|database|api|router|middleware|webhook|queue|worker)/i;

function isHighRiskReviewFile(file) {
  if (!file || typeof file !== 'object') return false;
  const normalizedPath = normalizePathForMatch(file.path || '');
  const normalizedOldPath = normalizePathForMatch(file.oldPath || '');
  const candidate = `${normalizedPath} ${normalizedOldPath}`.trim();
  return HIGH_RISK_RE.test(candidate);
}

export {
  normalizeScopePatternList, parseBooleanSetting, normalizeReviewScope,
  dedupePatternList, parseStoredPatternSetting, getGlobalReviewIgnorePatterns,
  getGlobalReviewIgnorePresetSelection,
  buildEffectiveScope, normalizePathForMatch, wildcardToRegex, pathMatchesPattern,
  matchesAnyPattern, matchesScopeEntry, invalidateIgnorePatternCache,
  CODE_FILE_RE, CONFIG_FILE_RE, TEST_FILE_RE, HIGH_RISK_RE, isHighRiskReviewFile,
};
