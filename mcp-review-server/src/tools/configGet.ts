import type { AtlasApiClient } from '../client.js';
import type { AtlasConfig } from '../config.js';
import { formatConfigGetSummary } from '../formatters/configFormatter.js';
import { TOOL_NAMES } from '../toolNames.js';
import type {
  ConfigGetToolData,
  ProviderContextActive,
  ProviderMetadata,
  ReviewModelStrategy,
  ToolExecutionResult,
} from '../types.js';
import { toCompactProjectSummary } from '../utils/reviewPayloadShapes.js';
import { resolveToolContext, type ToolContextInput } from './projectContext.js';

const REVIEW_MODEL_STRATEGY_KEY = 'review_model_strategy' as const;
const DEFAULT_REVIEW_STRATEGY: ReviewModelStrategy = 'smart';

export interface ConfigGetToolArgs extends ToolContextInput {}

export async function runConfigGetTool(
  client: AtlasApiClient,
  config: AtlasConfig,
  cwd: string,
  args: ConfigGetToolArgs
): Promise<ToolExecutionResult<ConfigGetToolData>> {
  const context = await resolveToolContext(client, config, args, cwd);

  const [strategySetting, providersResponse, reviewProviderContext] = await Promise.all([
    client.getSetting(REVIEW_MODEL_STRATEGY_KEY),
    client.listProviders(),
    client.getContextActiveProvider('review'),
  ]);

  const parsedStrategy = parseReviewStrategy(strategySetting.value);
  const reviewStrategy = parsedStrategy || DEFAULT_REVIEW_STRATEGY;
  const strategySource: ConfigGetToolData['strategySource'] = parsedStrategy ? 'persisted' : 'default';

  const providers = normalizeProviders(providersResponse.providers);
  const contextProvider = normalizeContextActiveProvider(reviewProviderContext.data);
  const routeActiveProvider = isProviderMetadata(providersResponse.activeProvider) ? providersResponse.activeProvider : null;

  let providerId = contextProvider?.providerId || routeActiveProvider?.id || null;
  let model = normalizeModel(contextProvider?.model ?? routeActiveProvider?.model);
  const provider = providerId
    ? providers.find((entry) => entry.id === providerId)
      || (routeActiveProvider && routeActiveProvider.id === providerId ? routeActiveProvider : null)
    : null;

  if (!model && provider) {
    model = normalizeModel(provider.model);
  }

  const data: ConfigGetToolData = {
    project: toCompactProjectSummary(context.project),
    strategySettingKey: REVIEW_MODEL_STRATEGY_KEY,
    reviewStrategy,
    strategySource,
    activeReviewProvider: {
      providerId,
      model,
      provider,
    },
    providers,
  };

  return {
    summary: formatConfigGetSummary(data),
    data,
    nextActions: providerId
      ? [
          `Run ${TOOL_NAMES.latest} to inspect latest findings with this strategy/provider context.`,
          `Run ${TOOL_NAMES.configSetStrategy} to change review strategy when needed.`,
        ]
      : [
          `Configure an active review provider in Atlas settings, then rerun ${TOOL_NAMES.configGet}.`,
          `Run ${TOOL_NAMES.configSetStrategy} to set the desired review strategy.`,
        ],
  };
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

function normalizeProviders(input: unknown): ProviderMetadata[] {
  if (!Array.isArray(input)) return [];
  return input.filter(isProviderMetadata);
}

function normalizeContextActiveProvider(input: unknown): ProviderContextActive | null {
  if (!input || typeof input !== 'object') return null;
  const providerId = String((input as { providerId?: unknown }).providerId || '').trim();
  if (!providerId) return null;
  const model = normalizeModel((input as { model?: unknown }).model);
  return { providerId, model };
}

function normalizeModel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized || null;
}

function isProviderMetadata(value: unknown): value is ProviderMetadata {
  return !!value && typeof value === 'object'
    && typeof (value as ProviderMetadata).id === 'string'
    && typeof (value as ProviderMetadata).type === 'string';
}
