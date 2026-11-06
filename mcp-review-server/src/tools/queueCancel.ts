import type { AtlasApiClient } from '../client.js';
import type { AtlasConfig } from '../config.js';
import { AtlasMcpError } from '../errors.js';
import { TOOL_NAMES } from '../toolNames.js';
import type { QueueCancelToolData, ToolExecutionResult } from '../types.js';
import { toCompactBranchReview, toCompactPrReview, toCompactProjectSummary } from '../utils/reviewPayloadShapes.js';
import { resolveCurrentReviewContext, type ToolContextInput } from './projectContext.js';

export interface QueueCancelToolArgs extends ToolContextInput {}

export async function runQueueCancelTool(
  client: AtlasApiClient,
  config: AtlasConfig,
  cwd: string,
  args: QueueCancelToolArgs
): Promise<ToolExecutionResult<QueueCancelToolData>> {
  const context = await resolveCurrentReviewContext(client, config, args, cwd);

  if (!context.review) {
    throw new AtlasMcpError('INVALID_INPUT', `No resolved review found for project ${context.project.name}.`);
  }

  const response = context.review.type === 'pr_review' && context.prReview
    ? await client.cancelPrReviewQueue(context.project.id, context.prReview.id)
    : context.review.type === 'workspace_review' && context.branchReview
      ? await client.cancelWorkspaceReviewQueue(context.project.id, context.branchReview.id)
    : context.branchReview
      ? await client.cancelBranchReviewQueue(context.project.id, context.branchReview.id)
      : null;
  if (!response) {
    throw new AtlasMcpError('INVALID_INPUT', `No review found to cancel for project ${context.project.name}.`);
  }
  const stopped = response.stopped === true;
  const was = typeof response.was === 'string' ? response.was : null;
  const reviewLabel = context.review.label;

  return {
    summary: stopped
      ? `Stopped queued/running review for ${reviewLabel}${was ? ` (previous state: ${was}).` : '.'}`
      : `No queued/running review entry found for ${reviewLabel}.`,
    data: {
      project: toCompactProjectSummary(context.project),
      review: context.review,
      branchReview: toCompactBranchReview(context.branchReview),
      prReview: toCompactPrReview(context.prReview),
      stopped,
      was,
    },
    nextActions: [`Run ${TOOL_NAMES.status} to confirm queue state.`, `Run ${TOOL_NAMES.runCurrent} to start a new review when ready.`],
  };
}
