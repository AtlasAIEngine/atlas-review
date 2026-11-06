/**
 * Usage Service
 * Tracks per-review token consumption and costs.
 * Provides monthly summaries and free tier enforcement.
 */

import db from '../db/connection.js';
import crypto from 'crypto';

/**
 * Free tier limit: 20 AI reviews per calendar month
 */
const FREE_TIER_MONTHLY_LIMIT = 20;

/**
 * Canonical review usage types shared across persisted review rows.
 */
const VALID_REVIEW_TYPES = new Set(['changeset', 'branch_review', 'pr_review', 'workspace_review']);

/**
 * Exact per-token pricing in USD for models Atlas currently offers in review flows.
 *
 * Pricing references verified against official vendor pricing pages on 2026-04-28:
 * - OpenAI API pricing (`developers.openai.com/api/docs/pricing`)
 * - Anthropic Claude pricing (`platform.claude.com/docs/en/about-claude/pricing`)
 * - Gemini API pricing (`ai.google.dev/gemini-api/docs/pricing`)
 */
const EXACT_MODEL_COSTS = Object.freeze({
  // Anthropic
  'anthropic/claude-opus-4-7': { input: 0.000005, output: 0.000025 },
  'anthropic/claude-opus-4-6': { input: 0.000005, output: 0.000025 },
  'anthropic/claude-sonnet-4-6': { input: 0.000003, output: 0.000015 },
  'anthropic/claude-sonnet-4-5-20250929': { input: 0.000003, output: 0.000015 },
  'anthropic/claude-haiku-4-5-20251001': { input: 0.000001, output: 0.000005 },
  'anthropic/claude-3-5-sonnet-20241022': { input: 0.000003, output: 0.000015 },
  'anthropic/claude-3-haiku-20240307': { input: 0.00000025, output: 0.00000125 },
  'anthropic/claude-3-opus-20240229': { input: 0.000015, output: 0.000075 },

  // OpenAI
  'openai/gpt-5.5': { input: 0.000005, output: 0.00003 },
  'openai/gpt-5.4': { input: 0.0000025, output: 0.000015 },
  'openai/gpt-5.4-nano': { input: 0.0000002, output: 0.00000125 },
  'openai/gpt-5.4-mini': { input: 0.00000075, output: 0.0000045 },
  'openai/gpt-5.3-codex': { input: 0.00000175, output: 0.000014 },
  'openai/gpt-4o': { input: 0.0000025, output: 0.00001 },
  'openai/gpt-4o-mini': { input: 0.00000015, output: 0.0000006 },
  'openai/gpt-4-turbo': { input: 0.00001, output: 0.00003 },

  // Google
  'google/gemini-3.1-pro-preview': {
    tiers: [
      { maxInputTokens: 200000, input: 0.000002, output: 0.000012 },
      { input: 0.000004, output: 0.000018 },
    ],
  },
  'google/gemini-3-flash-preview': { input: 0.0000005, output: 0.000003 },
  'google/gemini-3.1-flash-lite-preview': { input: 0.00000025, output: 0.0000015 },
  'google/gemini-2.5-pro': {
    tiers: [
      { maxInputTokens: 200000, input: 0.00000125, output: 0.00001 },
      { input: 0.0000025, output: 0.000015 },
    ],
  },
  'google/gemini-2.5-flash': { input: 0.0000003, output: 0.0000025 },
  'google/gemini-2.5-flash-lite': { input: 0.0000001, output: 0.0000004 },
});

/**
 * Family-level fallback pricing for supported providers when Atlas sees a new
 * model variant before the exact table is refreshed. These are estimates and
 * must be labelled approximate in review UI.
 */
const MODEL_FAMILY_FALLBACKS = Object.freeze([
  { key: 'anthropic/claude-opus-4.x', providerType: 'anthropic', pattern: /^claude-opus-4(?:[-.].+)?$/i, input: 0.000005, output: 0.000025 },
  { key: 'anthropic/claude-sonnet-4.x', providerType: 'anthropic', pattern: /^claude-sonnet-4(?:[-.].+)?$/i, input: 0.000003, output: 0.000015 },
  { key: 'anthropic/claude-haiku-4.x', providerType: 'anthropic', pattern: /^claude-haiku-4(?:[-.].+)?$/i, input: 0.000001, output: 0.000005 },
  { key: 'openai/gpt-5.5-family', providerType: 'openai', pattern: /^gpt-5\.5(?:[-.].+)?$/i, input: 0.000005, output: 0.00003 },
  { key: 'openai/gpt-5.4-nano-family', providerType: 'openai', pattern: /^gpt-5\.4-nano(?:[-.].+)?$/i, input: 0.0000002, output: 0.00000125 },
  { key: 'openai/gpt-5.4-mini-family', providerType: 'openai', pattern: /^gpt-5\.4-mini(?:[-.].+)?$/i, input: 0.00000075, output: 0.0000045 },
  { key: 'openai/gpt-5.4-family', providerType: 'openai', pattern: /^gpt-5\.4(?:[-.].+)?$/i, input: 0.0000025, output: 0.000015 },
  { key: 'openai/gpt-5.3-codex-family', providerType: 'openai', pattern: /^gpt-5\.3-codex(?:[-.].+)?$/i, input: 0.00000175, output: 0.000014 },
  { key: 'google/gemini-3.1-pro-family', providerType: 'google', pattern: /^gemini-3\.1-pro(?:[-.].+)?$/i, input: 0.000002, output: 0.000012 },
  { key: 'google/gemini-3-flash-family', providerType: 'google', pattern: /^gemini-3-flash(?:[-.].+)?$/i, input: 0.0000005, output: 0.000003 },
  { key: 'google/gemini-3.1-flash-lite-family', providerType: 'google', pattern: /^gemini-3\.1-flash-lite(?:[-.].+)?$/i, input: 0.00000025, output: 0.0000015 },
  { key: 'google/gemini-2.5-pro-family', providerType: 'google', pattern: /^gemini-2\.5-pro(?:[-.].+)?$/i, input: 0.00000125, output: 0.00001 },
  { key: 'google/gemini-2.5-flash-family', providerType: 'google', pattern: /^gemini-2\.5-flash(?:[-.].+)?$/i, input: 0.0000003, output: 0.0000025 },
  { key: 'google/gemini-2.5-flash-lite-family', providerType: 'google', pattern: /^gemini-2\.5-flash-lite(?:[-.].+)?$/i, input: 0.0000001, output: 0.0000004 },
]);

/**
 * Final fallback when Atlas cannot map a model to a supported family.
 */
const DEFAULT_REVIEW_COSTS = Object.freeze({
  key: 'atlas/default-review-estimate',
  input: 0.000003,
  output: 0.000015,
});

function normalizeFiniteNumber(value, fallback = 0) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : fallback;
}

function normalizeTokenCount(value) {
  return Math.max(0, Math.trunc(normalizeFiniteNumber(value, 0)));
}

function normalizeOptionalCurrency(value) {
  if (value == null || value === '') return null;
  const normalized = Number(value);
  return Number.isFinite(normalized) && normalized >= 0 ? normalized : null;
}

function normalizeReviewType(reviewType) {
  const normalized = typeof reviewType === 'string' ? reviewType.trim().toLowerCase() : '';
  return VALID_REVIEW_TYPES.has(normalized) ? normalized : null;
}

function normalizeReviewId(reviewId) {
  return typeof reviewId === 'string' && reviewId.trim() ? reviewId.trim() : null;
}

function normalizePricingIdentity(providerType, model) {
  let normalizedProviderType = typeof providerType === 'string'
    ? providerType.trim().toLowerCase()
    : '';
  let normalizedModel = typeof model === 'string'
    ? model.trim()
    : '';

  if (normalizedModel.includes('/')) {
    const [embeddedProviderType, ...modelParts] = normalizedModel.split('/');
    const embeddedModel = modelParts.join('/').trim();
    if (embeddedModel) {
      if (!normalizedProviderType || normalizedProviderType === 'unknown' || normalizedProviderType === 'opencode') {
        normalizedProviderType = embeddedProviderType.trim().toLowerCase();
        normalizedModel = embeddedModel;
      } else if (embeddedProviderType.trim().toLowerCase() === normalizedProviderType) {
        normalizedModel = embeddedModel;
      }
    }
  }

  return {
    providerType: normalizedProviderType || 'unknown',
    model: normalizedModel || 'unknown',
  };
}

function resolveRateForTokens(pricingRule, inputTokens) {
  if (!Array.isArray(pricingRule?.tiers)) {
    return pricingRule;
  }

  return pricingRule.tiers.find((tier) => (
    tier.maxInputTokens == null || inputTokens <= tier.maxInputTokens
  )) || pricingRule.tiers[pricingRule.tiers.length - 1];
}

function resolvePricingRule(providerType, model, inputTokens = 0) {
  const { providerType: normalizedProviderType, model: normalizedModel } = normalizePricingIdentity(providerType, model);
  const exactKey = `${normalizedProviderType}/${normalizedModel}`;
  const exact = EXACT_MODEL_COSTS[exactKey];
  if (exact) {
    const rates = resolveRateForTokens(exact, inputTokens);
    return {
      providerType: normalizedProviderType,
      model: normalizedModel,
      pricingKey: exactKey,
      inputRate: rates.input,
      outputRate: rates.output,
      costSource: 'pricing_table',
      costIsApproximate: false,
    };
  }

  const familyFallback = MODEL_FAMILY_FALLBACKS.find((entry) => (
    entry.providerType === normalizedProviderType
    && entry.pattern.test(normalizedModel)
  ));
  if (familyFallback) {
    return {
      providerType: normalizedProviderType,
      model: normalizedModel,
      pricingKey: familyFallback.key,
      inputRate: familyFallback.input,
      outputRate: familyFallback.output,
      costSource: 'fallback_pricing',
      costIsApproximate: true,
    };
  }

  return {
    providerType: normalizedProviderType,
    model: normalizedModel,
    pricingKey: DEFAULT_REVIEW_COSTS.key,
    inputRate: DEFAULT_REVIEW_COSTS.input,
    outputRate: DEFAULT_REVIEW_COSTS.output,
    costSource: 'fallback_pricing',
    costIsApproximate: true,
  };
}

function roundCurrency(value) {
  return Math.round((normalizeFiniteNumber(value, 0) + Number.EPSILON) * 1_000_000) / 1_000_000;
}

/**
 * Build the canonical review-cost contract used by persisted review payloads
 * and usage rows.
 */
function buildCostSnapshot({
  providerType,
  model,
  inputTokens,
  outputTokens,
  providerNativeCost = null,
} = {}) {
  const normalizedInputTokens = normalizeTokenCount(inputTokens);
  const normalizedOutputTokens = normalizeTokenCount(outputTokens);
  const totalTokens = normalizedInputTokens + normalizedOutputTokens;
  const nativeCost = normalizeOptionalCurrency(providerNativeCost);

  if (nativeCost != null && (nativeCost > 0 || totalTokens === 0)) {
    const identity = normalizePricingIdentity(providerType, model);
    return {
      providerType: identity.providerType,
      model: identity.model,
      inputTokens: normalizedInputTokens,
      outputTokens: normalizedOutputTokens,
      totalTokens,
      providerNativeCost: nativeCost,
      estimatedCost: roundCurrency(nativeCost),
      costSource: 'provider_native',
      costIsApproximate: false,
      pricingKey: null,
    };
  }

  const pricingRule = resolvePricingRule(providerType, model, normalizedInputTokens);
  const estimatedCost = roundCurrency(
    (normalizedInputTokens * pricingRule.inputRate) + (normalizedOutputTokens * pricingRule.outputRate)
  );

  return {
    providerType: pricingRule.providerType,
    model: pricingRule.model,
    inputTokens: normalizedInputTokens,
    outputTokens: normalizedOutputTokens,
    totalTokens,
    providerNativeCost: null,
    estimatedCost,
    costSource: pricingRule.costSource,
    costIsApproximate: pricingRule.costIsApproximate,
    pricingKey: pricingRule.pricingKey,
  };
}

/**
 * Calculate estimated cost for a review.
 * Retained as a compatibility wrapper for existing callers.
 */
function calculateCost(providerType, model, inputTokens, outputTokens) {
  return buildCostSnapshot({
    providerType,
    model,
    inputTokens,
    outputTokens,
  }).estimatedCost;
}

/**
 * Record token usage for a completed review
 * @param {Object} params
 * @param {string} params.projectId - Project ID (optional)
 * @param {string} params.changesetId - Changeset ID (optional)
 * @param {string} params.reviewType - 'changeset' | 'branch_review' | 'pr_review'
 * @param {string} params.reviewId - Review record ID for exact usage linkage
 * @param {string} params.providerType - Provider identifier
 * @param {string} params.model - Model used
 * @param {number} params.inputTokens - Input tokens consumed
 * @param {number} params.outputTokens - Output tokens consumed
 * @param {number} params.providerNativeCost - Provider-reported run cost in USD
 * @returns {Promise<Object>} The inserted usage record
 */
async function recordUsage({
  projectId,
  changesetId,
  reviewType,
  reviewId,
  providerType,
  model,
  inputTokens,
  outputTokens,
  providerNativeCost = null,
}) {
  const id = `ru_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const costSnapshot = buildCostSnapshot({
    providerType,
    model,
    inputTokens,
    outputTokens,
    providerNativeCost,
  });
  const normalizedReviewType = normalizeReviewType(reviewType);
  const normalizedReviewId = normalizeReviewId(reviewId);

  await db.query(
    `INSERT INTO review_usage (
       id, project_id, changeset_id, review_type, review_id,
       provider_type, model, input_tokens, output_tokens, total_tokens,
       estimated_cost, provider_native_cost, cost_source, cost_is_approximate
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      id,
      projectId || null,
      changesetId || null,
      normalizedReviewType,
      normalizedReviewId,
      costSnapshot.providerType,
      costSnapshot.model,
      costSnapshot.inputTokens,
      costSnapshot.outputTokens,
      costSnapshot.totalTokens,
      costSnapshot.estimatedCost,
      costSnapshot.providerNativeCost,
      costSnapshot.costSource,
      costSnapshot.costIsApproximate ? 1 : 0,
    ]
  );

  return {
    id,
    projectId: projectId || null,
    changesetId: changesetId || null,
    reviewType: normalizedReviewType,
    reviewId: normalizedReviewId,
    providerType: costSnapshot.providerType,
    model: costSnapshot.model,
    inputTokens: costSnapshot.inputTokens,
    outputTokens: costSnapshot.outputTokens,
    totalTokens: costSnapshot.totalTokens,
    estimatedCost: costSnapshot.estimatedCost,
    providerNativeCost: costSnapshot.providerNativeCost,
    costSource: costSnapshot.costSource,
    costIsApproximate: costSnapshot.costIsApproximate,
    pricingKey: costSnapshot.pricingKey,
  };
}

/**
 * Get usage summary for the current calendar month
 * @returns {Promise<Object>} Monthly summary
 */
async function getCurrentMonthSummary() {
  const dbType = db.getDbType ? db.getDbType() : 'postgres';

  let dateFilter;
  if (dbType === 'sqlite') {
    dateFilter = "reviewed_at >= date('now', 'start of month')";
  } else {
    dateFilter = "reviewed_at >= date_trunc('month', CURRENT_DATE)";
  }

  const result = await db.query(
    `SELECT
       COUNT(*) as review_count,
       COALESCE(SUM(input_tokens), 0) as total_input_tokens,
       COALESCE(SUM(output_tokens), 0) as total_output_tokens,
       COALESCE(SUM(total_tokens), 0) as total_tokens,
       COALESCE(SUM(estimated_cost), 0) as total_cost
     FROM review_usage
     WHERE ${dateFilter}`
  );

  const row = result.rows[0];
  const reviewCount = Number(row.review_count) || 0;

  return {
    reviewCount,
    totalInputTokens: Number(row.total_input_tokens) || 0,
    totalOutputTokens: Number(row.total_output_tokens) || 0,
    totalTokens: Number(row.total_tokens) || 0,
    totalCost: Number(row.total_cost) || 0,
    monthlyLimit: FREE_TIER_MONTHLY_LIMIT,
    reviewsRemaining: Math.max(0, FREE_TIER_MONTHLY_LIMIT - reviewCount),
    limitReached: reviewCount >= FREE_TIER_MONTHLY_LIMIT,
  };
}

/**
 * Get recent review usage records
 * @param {Object} options
 * @param {number} [options.limit=20] - Max records to return
 * @param {string} [options.projectId] - Filter by project
 * @param {string} [options.reviewType] - Filter by review type
 * @param {string} [options.reviewId] - Filter by review identity
 * @returns {Promise<Array>} Usage records
 */
async function getRecentUsage({ limit = 20, projectId, reviewType, reviewId } = {}) {
  let query = 'SELECT * FROM review_usage';
  const params = [];
  let paramIdx = 1;
  const where = [];

  if (projectId) {
    where.push(`project_id = $${paramIdx}`);
    params.push(projectId);
    paramIdx++;
  }

  const normalizedReviewType = normalizeReviewType(reviewType);
  if (normalizedReviewType) {
    where.push(`review_type = $${paramIdx}`);
    params.push(normalizedReviewType);
    paramIdx++;
  }

  const normalizedReviewId = normalizeReviewId(reviewId);
  if (normalizedReviewId) {
    where.push(`review_id = $${paramIdx}`);
    params.push(normalizedReviewId);
    paramIdx++;
  }

  if (where.length > 0) {
    query += ` WHERE ${where.join(' AND ')}`;
  }

  query += ` ORDER BY reviewed_at DESC LIMIT $${paramIdx}`;
  params.push(limit);

  const result = await db.query(query, params);
  return result.rows.map(row => ({
    id: row.id,
    projectId: row.project_id,
    changesetId: row.changeset_id,
    reviewType: row.review_type || null,
    reviewId: row.review_id || null,
    providerType: row.provider_type,
    model: row.model,
    inputTokens: Number(row.input_tokens),
    outputTokens: Number(row.output_tokens),
    totalTokens: Number(row.total_tokens),
    estimatedCost: Number(row.estimated_cost),
    providerNativeCost: row.provider_native_cost == null ? null : Number(row.provider_native_cost),
    costSource: row.cost_source || null,
    costIsApproximate: row.cost_is_approximate === true || row.cost_is_approximate === 1,
    reviewedAt: row.reviewed_at,
  }));
}

/**
 * Check if the free tier limit has been reached
 * @returns {Promise<boolean>} True if limit reached
 */
async function isLimitReached() {
  const summary = await getCurrentMonthSummary();
  return summary.limitReached;
}

/**
 * Get cost breakdown by provider for current month
 * @returns {Promise<Array>} Per-provider breakdown
 */
async function getProviderBreakdown() {
  const dbType = db.getDbType ? db.getDbType() : 'postgres';

  let dateFilter;
  if (dbType === 'sqlite') {
    dateFilter = "reviewed_at >= date('now', 'start of month')";
  } else {
    dateFilter = "reviewed_at >= date_trunc('month', CURRENT_DATE)";
  }

  const result = await db.query(
    `SELECT
       provider_type,
       model,
       COUNT(*) as review_count,
       COALESCE(SUM(total_tokens), 0) as total_tokens,
       COALESCE(SUM(estimated_cost), 0) as total_cost
     FROM review_usage
     WHERE ${dateFilter}
     GROUP BY provider_type, model
     ORDER BY total_cost DESC`
  );

  return result.rows.map(row => ({
    providerType: row.provider_type,
    model: row.model,
    reviewCount: Number(row.review_count),
    totalTokens: Number(row.total_tokens),
    totalCost: Number(row.total_cost),
  }));
}

export default {
  recordUsage,
  getCurrentMonthSummary,
  getRecentUsage,
  isLimitReached,
  getProviderBreakdown,
  buildCostSnapshot,
  calculateCost,
  FREE_TIER_MONTHLY_LIMIT,
};
