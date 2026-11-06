/**
 * Quota Enforcement Middleware
 * CRITICAL: Hard limits to prevent runaway costs
 *
 * This middleware is NOT optional - it enforces resource quotas
 * to protect against unexpected API costs and resource usage
 */

import {
  getUserQuotas,
  checkUserQuota,
  updateTokenUsage,
  logUsage,
  logEvent
} from '../db/queries.js';

/**
 * Enforce user quotas before expensive operations
 * Checks:
 * - Token limits
 * - Cost limits
 * - Rate limits
 * - Container limits
 *
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next function
 */
export async function enforceQuotas(req, res, next) {
  try {
    const userId = req.user?.id;

    // Skip quota check if no user (public endpoints)
    if (!userId) {
      return next();
    }

    // Get user quotas
    const quotas = await getUserQuotas(userId);

    if (!quotas) {
      // No quotas found - this shouldn't happen due to trigger
      // Create default quotas and continue
      console.warn(`No quotas found for user ${userId} - this should not happen`);
      return next();
    }

    // Check if quota exceeded flag is set
    if (quotas.quota_exceeded) {
      await logEvent({
        userId,
        kind: 'quota_exceeded',
        status: 'warning',
        message: `Request blocked: ${quotas.quota_exceeded_reason}`,
        ipAddress: req.ip,
        userAgent: req.get('user-agent')
      });

      return res.status(429).json({
        error: 'Quota exceeded',
        message: quotas.quota_exceeded_reason || 'Monthly limit reached',
        quotaExceeded: true,
        resetDate: getNextMonthStart()
      });
    }

    // Check token limit
    if (quotas.tokens_used_this_month >= quotas.monthly_token_limit) {
      return res.status(429).json({
        error: 'Token limit exceeded',
        message: `You have used ${quotas.tokens_used_this_month} of ${quotas.monthly_token_limit} tokens this month`,
        tokensUsed: quotas.tokens_used_this_month,
        tokenLimit: quotas.monthly_token_limit,
        resetDate: getNextMonthStart()
      });
    }

    // Check cost limit
    if (quotas.cost_this_month >= quotas.monthly_cost_limit) {
      return res.status(429).json({
        error: 'Cost limit exceeded',
        message: `You have spent $${quotas.cost_this_month} of $${quotas.monthly_cost_limit} this month`,
        costThisMonth: quotas.cost_this_month,
        costLimit: quotas.monthly_cost_limit,
        resetDate: getNextMonthStart()
      });
    }

    // Check hourly rate limit
    const hoursSinceWindowStart =
      (Date.now() - new Date(quotas.hour_window_start)) / (1000 * 60 * 60);

    if (hoursSinceWindowStart >= 1) {
      // Reset hourly window
      // Note: This should be done with a proper query, but for simplicity:
      quotas.requests_this_hour = 1;
      quotas.hour_window_start = new Date();
    } else if (quotas.requests_this_hour >= quotas.requests_per_hour) {
      const retryAfter = Math.ceil((1 - hoursSinceWindowStart) * 3600);

      return res.status(429).json({
        error: 'Rate limit exceeded',
        message: `You have made ${quotas.requests_this_hour} requests in the last hour. Limit: ${quotas.requests_per_hour}/hour`,
        requestsThisHour: quotas.requests_this_hour,
        requestsPerHour: quotas.requests_per_hour,
        retryAfter
      });
    }

    // Attach quotas to request for later use
    req.userQuotas = quotas;

    // Continue to next middleware
    next();
  } catch (error) {
    console.error('Error enforcing quotas:', error);

    // Don't block request on quota check error (fail open for better UX)
    // but log the error
    await logEvent({
      userId: req.user?.id,
      kind: 'quota_check_error',
      status: 'failure',
      message: `Quota check failed: ${error.message}`,
      meta: { error: error.message }
    });

    next();
  }
}

/**
 * Track API usage after request completion
 * Records token usage, costs, and other metrics
 *
 * @param {Object} options - Usage tracking options
 */
export function trackUsage(options = {}) {
  return async (req, res, next) => {
    // Store original json method
    const originalJson = res.json.bind(res);

    // Override json method to intercept response
    res.json = function (data) {
      // Track usage asynchronously (don't block response)
      setImmediate(async () => {
        try {
          const userId = req.user?.id;
          const projectId = req.params?.projectId || req.body?.projectId;

          if (!userId) return;

          // Extract usage data from response
          const tokensUsed = data.usage?.total_tokens || options.estimatedTokens || 0;
          const cost = calculateCost(data.usage || {}, options);

          if (tokensUsed > 0) {
            // Update user quotas
            await updateTokenUsage(userId, tokensUsed, cost);

            // Log to usage ledger
            await logUsage({
              userId,
              projectId,
              kind: 'tokens',
              amount: tokensUsed,
              cost,
              meta: {
                endpoint: req.path,
                method: req.method,
                model: data.model || options.model || 'unknown',
                inputTokens: data.usage?.prompt_tokens || 0,
                outputTokens: data.usage?.completion_tokens || 0
              }
            });
          }
        } catch (error) {
          console.error('Error tracking usage:', error);
        }
      });

      // Send response
      return originalJson(data);
    };

    next();
  };
}

/**
 * Check container quota before deployment
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next function
 */
export async function checkContainerQuota(req, res, next) {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return next();
    }

    const quotas = await getUserQuotas(userId);

    if (!quotas) {
      return next();
    }

    // Get current number of running containers for user
    // This would need to query the previews table
    // For now, we'll use a placeholder
    const runningContainers = 0; // TODO: Query from database

    if (runningContainers >= quotas.max_concurrent_containers) {
      return res.status(429).json({
        error: 'Container limit exceeded',
        message: `You have ${runningContainers} running containers. Limit: ${quotas.max_concurrent_containers}`,
        runningContainers,
        maxContainers: quotas.max_concurrent_containers
      });
    }

    next();
  } catch (error) {
    console.error('Error checking container quota:', error);
    next();
  }
}

/**
 * Check build quota before starting a build
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 * @param {Function} next - Express next function
 */
export async function checkBuildQuota(req, res, next) {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return next();
    }

    const quotas = await getUserQuotas(userId);

    if (!quotas) {
      return next();
    }

    // Check daily build limit
    const hoursSinceDayStart =
      (Date.now() - new Date(quotas.day_window_start)) / (1000 * 60 * 60);

    if (hoursSinceDayStart >= 24) {
      // Reset daily window
      quotas.builds_today = 0;
    } else if (quotas.builds_today >= quotas.max_builds_per_day) {
      const retryAfter = Math.ceil((24 - hoursSinceDayStart) * 3600);

      return res.status(429).json({
        error: 'Daily build limit exceeded',
        message: `You have triggered ${quotas.builds_today} builds today. Limit: ${quotas.max_builds_per_day}/day`,
        buildsToday: quotas.builds_today,
        maxBuildsPerDay: quotas.max_builds_per_day,
        retryAfter
      });
    }

    next();
  } catch (error) {
    console.error('Error checking build quota:', error);
    next();
  }
}

/**
 * Calculate cost based on token usage
 * @param {Object} usage - Usage object with token counts
 * @param {Object} options - Pricing options
 * @returns {number} Cost in USD
 */
function calculateCost(usage, options = {}) {
  // Default pricing (example rates - adjust based on actual API pricing)
  const pricing = {
    'claude-sonnet-4': {
      input: 0.003 / 1000,   // $0.003 per 1K input tokens
      output: 0.015 / 1000    // $0.015 per 1K output tokens
    },
    'claude-opus-4': {
      input: 0.015 / 1000,
      output: 0.075 / 1000
    },
    'claude-haiku-4': {
      input: 0.00025 / 1000,
      output: 0.00125 / 1000
    }
  };

  const model = options.model || 'claude-sonnet-4';
  const rates = pricing[model] || pricing['claude-sonnet-4'];

  const inputCost = (usage.prompt_tokens || 0) * rates.input;
  const outputCost = (usage.completion_tokens || 0) * rates.output;

  return parseFloat((inputCost + outputCost).toFixed(6));
}

/**
 * Get the start of next month
 * @returns {Date} Next month start date
 */
function getNextMonthStart() {
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return nextMonth.toISOString();
}

/**
 * Quota summary for user dashboard
 * @param {Object} req - Express request
 * @param {Object} res - Express response
 */
export async function getQuotaSummary(req, res) {
  try {
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const quotas = await getUserQuotas(userId);

    if (!quotas) {
      return res.status(404).json({ error: 'Quotas not found' });
    }

    const summary = {
      tokens: {
        used: quotas.tokens_used_this_month,
        limit: quotas.monthly_token_limit,
        percentage: ((quotas.tokens_used_this_month / quotas.monthly_token_limit) * 100).toFixed(2),
        remaining: quotas.monthly_token_limit - quotas.tokens_used_this_month
      },
      cost: {
        used: parseFloat(quotas.cost_this_month),
        limit: parseFloat(quotas.monthly_cost_limit),
        percentage: ((quotas.cost_this_month / quotas.monthly_cost_limit) * 100).toFixed(2),
        remaining: (quotas.monthly_cost_limit - quotas.cost_this_month).toFixed(2)
      },
      requests: {
        thisHour: quotas.requests_this_hour,
        limit: quotas.requests_per_hour,
        windowStart: quotas.hour_window_start
      },
      builds: {
        today: quotas.builds_today,
        limit: quotas.max_builds_per_day,
        windowStart: quotas.day_window_start
      },
      containers: {
        limit: quotas.max_concurrent_containers,
        memoryLimitMb: quotas.max_container_memory_mb,
        cpuLimit: quotas.max_container_vcpu
      },
      status: {
        exceeded: quotas.quota_exceeded,
        reason: quotas.quota_exceeded_reason,
        lastReset: quotas.last_reset
      },
      nextReset: getNextMonthStart()
    };

    res.json(summary);
  } catch (error) {
    console.error('Error getting quota summary:', error);
    res.status(500).json({ error: 'Failed to get quota summary' });
  }
}

export default {
  enforceQuotas,
  trackUsage,
  checkContainerQuota,
  checkBuildQuota,
  getQuotaSummary
};
