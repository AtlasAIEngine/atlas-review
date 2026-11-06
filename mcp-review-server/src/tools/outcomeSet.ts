import type { AtlasApiClient } from '../client.js';
import type { AtlasConfig } from '../config.js';
import { AtlasMcpError } from '../errors.js';
import { formatOutcomeSetSummary } from '../formatters/outcomeFormatter.js';
import { TOOL_NAMES } from '../toolNames.js';
import type {
  OutcomeSetToolData,
  ReviewOutcomeRecord,
  ReviewOutcomeStatus,
  ReviewOutcomeMutationPayload,
  ToolExecutionResult,
} from '../types.js';
import { resolveRecommendationKeyFromFindingReference } from '../utils/findingReferences.js';
import { toCompactProjectSummary } from '../utils/reviewPayloadShapes.js';
import { resolveOutcomeToolContext, type OutcomeToolContextInput } from './projectContext.js';

export interface OutcomeSetToolArgs extends OutcomeToolContextInput {
  status?: string;
  note?: unknown;
  recommendationKey?: unknown;
  findingId?: unknown;
  filePath?: unknown;
}

export async function runOutcomeSetTool(
  client: AtlasApiClient,
  config: AtlasConfig,
  cwd: string,
  args: OutcomeSetToolArgs
): Promise<ToolExecutionResult<OutcomeSetToolData>> {
  const status = normalizeStatus(args.status);
  const context = await resolveOutcomeToolContext(client, config, args, cwd);

  const payload = await buildOutcomePayload(client, context, args, status);
  const response = await client.upsertReviewOutcome(context.project.id, context.review.type, context.review.id, payload);

  const outcomes = Array.isArray(response.outcomes)
    ? response.outcomes.filter((entry) => entry && typeof entry.recommendationKey === 'string')
    : [];
  const outcome = isOutcomeRecord(response.outcome) ? response.outcome : null;
  const recommendationKey = outcome?.recommendationKey || payload.recommendationKey || null;

  const data: OutcomeSetToolData = {
    project: toCompactProjectSummary(context.project),
    review: context.review,
    status,
    recommendationKey,
    outcome,
    outcomes,
    telemetry: response.telemetry || null,
  };

  return {
    summary: formatOutcomeSetSummary(data),
    data,
    nextActions: [
      `Run ${TOOL_NAMES.file} for the same file path to continue triage.`,
      `Run ${TOOL_NAMES.latest} to inspect remaining findings.`,
    ],
  };
}

function normalizeStatus(value: unknown): ReviewOutcomeStatus {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized === 'addressed' || normalized === 'dismissed') {
    return normalized;
  }
  throw new AtlasMcpError('INVALID_INPUT', 'status is required and must be "addressed" or "dismissed".');
}

function normalizeNote(value: unknown): string | null | undefined {
  if (value == null) return undefined;
  const normalized = String(value).trim();
  return normalized || null;
}

async function buildOutcomePayload(
  client: AtlasApiClient,
  context: Awaited<ReturnType<typeof resolveOutcomeToolContext>>,
  args: OutcomeSetToolArgs,
  status: ReviewOutcomeStatus
): Promise<ReviewOutcomeMutationPayload> {
  const recommendationKey = await resolveRecommendationKeyFromFindingReference(client, context, {
    recommendationKey: args.recommendationKey,
    findingId: args.findingId,
  });
  const filePath = typeof args.filePath === 'string' && args.filePath.trim()
    ? args.filePath.trim()
    : undefined;
  const note = normalizeNote(args.note);

  if (!recommendationKey) {
    throw new AtlasMcpError(
      'INVALID_INPUT',
      `Provide findingId or recommendationKey. Use ${TOOL_NAMES.file}, ${TOOL_NAMES.latest}, or atlas://review/current/findings to get current IDs.`
    );
  }

  return {
    status,
    note,
    recommendationKey,
    filePath,
  };
}

function isOutcomeRecord(value: unknown): value is ReviewOutcomeRecord {
  return !!value && typeof value === 'object' && typeof (value as ReviewOutcomeRecord).recommendationKey === 'string';
}
