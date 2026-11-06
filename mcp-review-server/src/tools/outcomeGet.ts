import type { AtlasApiClient } from '../client.js';
import type { AtlasConfig } from '../config.js';
import { formatOutcomeGetSummary } from '../formatters/outcomeFormatter.js';
import { TOOL_NAMES } from '../toolNames.js';
import type { OutcomeGetToolData, ToolExecutionResult } from '../types.js';
import { toCompactProjectSummary } from '../utils/reviewPayloadShapes.js';
import { listOutcomeLookup } from '../utils/reviewOutcomes.js';
import { resolveOutcomeToolContext, type OutcomeToolContextInput } from './projectContext.js';

export interface OutcomeGetToolArgs extends OutcomeToolContextInput {}

export async function runOutcomeGetTool(
  client: AtlasApiClient,
  config: AtlasConfig,
  cwd: string,
  args: OutcomeGetToolArgs
): Promise<ToolExecutionResult<OutcomeGetToolData>> {
  const context = await resolveOutcomeToolContext(client, config, args, cwd);
  const response = await listOutcomeLookup(client, context.project.id, context.review.type, context.review.id);

  const data: OutcomeGetToolData = {
    project: toCompactProjectSummary(context.project),
    review: context.review,
    outcomes: response.outcomes || [],
    byRecommendationKey: response.byRecommendationKey || {},
    telemetry: response.telemetry || null,
  };

  return {
    summary: formatOutcomeGetSummary(data),
    data,
    nextActions: [
      `Run ${TOOL_NAMES.latest} or ${TOOL_NAMES.file} to inspect findings with finding IDs and recommendation keys.`,
      `Run ${TOOL_NAMES.outcomeSet} or ${TOOL_NAMES.outcomeClear} for a specific findingId or recommendationKey.`,
    ],
  };
}
