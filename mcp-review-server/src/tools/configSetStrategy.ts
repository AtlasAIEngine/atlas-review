import type { AtlasApiClient } from '../client.js';
import type { AtlasConfig } from '../config.js';
import { AtlasMcpError } from '../errors.js';
import { formatConfigSetStrategySummary } from '../formatters/configFormatter.js';
import { TOOL_NAMES } from '../toolNames.js';
import type { ConfigSetStrategyToolData, ReviewModelStrategy, ToolExecutionResult } from '../types.js';
import { toCompactProjectSummary } from '../utils/reviewPayloadShapes.js';
import { resolveToolContext, type ToolContextInput } from './projectContext.js';

const REVIEW_MODEL_STRATEGY_KEY = 'review_model_strategy' as const;
const REVIEW_MODEL_STRATEGIES: ReviewModelStrategy[] = ['smart', 'latency_first', 'max_quality', 'custom', 'adaptive'];

export interface ConfigSetStrategyToolArgs extends ToolContextInput {
  strategy?: unknown;
}

export async function runConfigSetStrategyTool(
  client: AtlasApiClient,
  config: AtlasConfig,
  cwd: string,
  args: ConfigSetStrategyToolArgs
): Promise<ToolExecutionResult<ConfigSetStrategyToolData>> {
  const nextStrategy = normalizeRequestedStrategy(args.strategy);
  const context = await resolveToolContext(client, config, args, cwd);

  const previousSetting = await client.getSetting(REVIEW_MODEL_STRATEGY_KEY);
  const previousReviewStrategy = parseReviewStrategy(previousSetting.value);

  const updatedSetting = await client.setSetting(REVIEW_MODEL_STRATEGY_KEY, nextStrategy);
  const persistedStrategy = parseReviewStrategy(updatedSetting.value) || nextStrategy;

  const data: ConfigSetStrategyToolData = {
    project: toCompactProjectSummary(context.project),
    strategySettingKey: REVIEW_MODEL_STRATEGY_KEY,
    reviewStrategy: persistedStrategy,
    previousReviewStrategy,
  };

  return {
    summary: formatConfigSetStrategySummary(data),
    data,
    nextActions: [
      `Run ${TOOL_NAMES.configGet} to confirm strategy and provider context.`,
      `Run ${TOOL_NAMES.latest} or ${TOOL_NAMES.runCurrent} for the next review action.`,
    ],
  };
}

function normalizeRequestedStrategy(value: unknown): ReviewModelStrategy {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'smart') return 'smart';
  if (normalized === 'latency_first') return 'latency_first';
  if (normalized === 'max_quality') return 'max_quality';
  if (normalized === 'custom') return 'custom';
  if (normalized === 'adaptive') return 'adaptive';

  const allowed = REVIEW_MODEL_STRATEGIES.join(', ');
  throw new AtlasMcpError('INVALID_INPUT', `strategy is required and must be one of: ${allowed}.`);
}

function parseReviewStrategy(value: unknown): ReviewModelStrategy | null {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'smart') return 'smart';
  if (normalized === 'latency_first') return 'latency_first';
  if (normalized === 'max_quality') return 'max_quality';
  if (normalized === 'custom') return 'custom';
  if (normalized === 'adaptive') return 'adaptive';
  return null;
}
