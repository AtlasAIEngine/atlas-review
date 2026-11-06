import type { AtlasApiClient } from '../client.js';
import type { AtlasConfig } from '../config.js';
import { AtlasMcpError } from '../errors.js';
import { formatOutcomeClearSummary } from '../formatters/outcomeFormatter.js';
import { TOOL_NAMES } from '../toolNames.js';
import type { OutcomeClearToolData, ReviewOutcomeRecord, ToolExecutionResult } from '../types.js';
import { resolveRecommendationKeyFromFindingReference } from '../utils/findingReferences.js';
import { toCompactProjectSummary } from '../utils/reviewPayloadShapes.js';
import { resolveOutcomeToolContext, type OutcomeToolContextInput } from './projectContext.js';

export interface OutcomeClearToolArgs extends OutcomeToolContextInput {
  recommendationKey?: unknown;
  findingId?: unknown;
}

export async function runOutcomeClearTool(
  client: AtlasApiClient,
  config: AtlasConfig,
  cwd: string,
  args: OutcomeClearToolArgs
): Promise<ToolExecutionResult<OutcomeClearToolData>> {
  const context = await resolveOutcomeToolContext(client, config, args, cwd);
  const recommendationKey = await resolveRecommendationKeyFromFindingReference(client, context, {
    recommendationKey: args.recommendationKey,
    findingId: args.findingId,
  });
  if (!recommendationKey) {
    throw new AtlasMcpError(
      'INVALID_INPUT',
      `Provide findingId or recommendationKey. Use ${TOOL_NAMES.file}, ${TOOL_NAMES.latest}, or atlas://review/current/findings to get current IDs.`
    );
  }

  const response = await client.deleteReviewOutcome(context.project.id, context.review.type, context.review.id, {
    recommendationKey,
  });

  const data: OutcomeClearToolData = {
    project: toCompactProjectSummary(context.project),
    review: context.review,
    recommendationKey,
    deletedOutcome: isOutcomeRecord(response.deletedOutcome) ? response.deletedOutcome : null,
    outcomes: Array.isArray(response.outcomes)
      ? response.outcomes.filter((entry) => entry && typeof entry.recommendationKey === 'string')
      : [],
    telemetry: response.telemetry || null,
  };

  return {
    summary: formatOutcomeClearSummary(data),
    data,
    nextActions: [
      `Run ${TOOL_NAMES.outcomeGet} to confirm the remaining persisted outcomes.`,
      `Run ${TOOL_NAMES.latest} to inspect unresolved findings.`,
    ],
  };
}

function isOutcomeRecord(value: unknown): value is ReviewOutcomeRecord {
  return !!value && typeof value === 'object' && typeof (value as ReviewOutcomeRecord).recommendationKey === 'string';
}
