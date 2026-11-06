/**
 * Review Helpers
 * Pure utility functions with no external service dependencies.
 */

import { createHash } from 'crypto';
import {
  SMALL_REVIEW_FILE_COUNT,
  MEDIUM_REVIEW_FILE_COUNT,
  RECOMMENDATION_BUDGET_SMALL,
  RECOMMENDATION_BUDGET_MEDIUM,
  RECOMMENDATION_BUDGET_LARGE,
} from './reviewConstants.js';

export function parseEnvInteger(name, fallback, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  const parsed = Number(process.env[name]);
  const normalized = Number.isFinite(parsed) ? Math.trunc(parsed) : Math.trunc(fallback);
  return Math.min(max, Math.max(min, normalized));
}

export function parseEnvBoolean(name, fallback) {
  const raw = process.env[name];
  if (raw == null) return fallback;
  if (typeof raw !== 'string') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

export function parseEnvFloat(name, fallback, { min = Number.NEGATIVE_INFINITY, max = Number.POSITIVE_INFINITY } = {}) {
  const parsed = Number(process.env[name]);
  const normalized = Number.isFinite(parsed) ? parsed : Number(fallback);
  return Math.min(max, Math.max(min, normalized));
}

export function clampNumber(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return Number(min);
  return Math.min(Number(max), Math.max(Number(min), parsed));
}

export async function mapWithConcurrency(items, concurrency, mapper) {
  if (!Array.isArray(items) || items.length === 0) return [];

  const safeConcurrency = Math.max(1, Number(concurrency) || 1);
  const maxWorkers = Math.min(safeConcurrency, items.length);
  const results = new Array(items.length);
  let nextIndex = 0;
  let firstError = null;
  let stopScheduling = false;

  const workers = Array.from({ length: maxWorkers }, async () => {
    while (true) {
      if (stopScheduling) break;
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) break;
      try {
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      } catch (error) {
        if (!firstError) {
          firstError = error;
        }
        stopScheduling = true;
        break;
      }
    }
  });

  await Promise.all(workers);
  if (firstError) throw firstError;
  return results;
}

export function hashReviewFileContent(content) {
  if (typeof content !== 'string') return 'null';
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export function normalizeProviderIdentity(providerData) {
  const provider = providerData?.provider || {};
  const providerType = typeof provider.type === 'string' && provider.type.trim()
    ? provider.type.trim()
    : 'unknown';
  const providerModel = typeof provider.model === 'string' && provider.model.trim()
    ? provider.model.trim()
    : 'unknown';
  return { providerType, providerModel };
}

export function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function getBaseRecommendationBudget(fileCount) {
  const normalizedFileCount = toNumberOrNull(fileCount);
  if (normalizedFileCount == null) return RECOMMENDATION_BUDGET_MEDIUM;
  if (normalizedFileCount <= SMALL_REVIEW_FILE_COUNT) return RECOMMENDATION_BUDGET_SMALL;
  if (normalizedFileCount <= MEDIUM_REVIEW_FILE_COUNT) return RECOMMENDATION_BUDGET_MEDIUM;
  return RECOMMENDATION_BUDGET_LARGE;
}

export function resolveReviewQualityMode(overrideMode) {
  if (overrideMode === 'v1' || overrideMode === 'v2') return overrideMode;
  return process.env.ATLAS_REVIEW_QUALITY_V2 === '0' ? 'v1' : 'v2';
}

export function isReviewQualityV2Enabled(overrideMode) {
  return resolveReviewQualityMode(overrideMode) === 'v2';
}

export function normalizePathForMatch(filePath) {
  return String(filePath || '').replace(/\\/g, '/').replace(/^\.\/+/, '');
}
