import type { AtlasApiClient } from '../client.js';
import type { AtlasConfig } from '../config.js';
import { AtlasMcpError } from '../errors.js';
import { TOOL_NAMES } from '../toolNames.js';
import type { GitHubPublishToolData, ToolExecutionResult } from '../types.js';
import { toCompactProjectSummary } from '../utils/reviewPayloadShapes.js';
import { resolveOutcomeToolContext, type OutcomeToolContextInput } from './projectContext.js';

export interface GitHubPublishToolArgs extends OutcomeToolContextInput {
  action?: unknown;
  recommendationKeys?: unknown;
  body?: unknown;
}

export async function runGitHubPublishTool(
  client: AtlasApiClient,
  config: AtlasConfig,
  cwd: string,
  args: GitHubPublishToolArgs
): Promise<ToolExecutionResult<GitHubPublishToolData>> {
  const action = normalizeAction(args.action);
  const recommendationKeys = normalizeRecommendationKeyList(args.recommendationKeys);
  const body = typeof args.body === 'string' && args.body.trim() ? args.body.trim() : null;
  const context = await resolveOutcomeToolContext(client, config, {
    ...args,
    reviewType: args.reviewType || 'pr_review',
  }, cwd);

  if (context.review.type !== 'pr_review' || !context.prReview) {
    throw new AtlasMcpError('INVALID_INPUT', `${TOOL_NAMES.githubPublish} currently supports reviewType "pr_review" only.`);
  }

  const response = await client.publishPrReview(context.project.id, context.prReview.id, {
    action,
    recommendationKeys,
    body,
  });

  const publication = response.publication || {
    scope: {
      projectId: context.project.id,
      reviewType: 'pr_review',
      reviewId: context.prReview.id,
    },
    publications: [],
    byRecommendationKey: {},
    totalPublished: 0,
    latestAction: null,
    latestPublishedAt: null,
  };
  const results = Array.isArray(response.results) ? response.results : [];
  const publishedCount = results.filter((entry) => entry?.status === 'published').length;
  const alreadyPublishedCount = results.filter((entry) => entry?.status === 'already_published').length;
  const skippedCount = results.filter((entry) => entry?.status === 'skipped').length;

  return {
    summary: [
      `Project: ${context.project.name}`,
      `PR review: ${context.review.label}`,
      `GitHub action: ${action}`,
      `Published findings: ${publishedCount}`,
      `Already published: ${alreadyPublishedCount}`,
      `Skipped: ${skippedCount}`,
      response.reviewSubmission?.githubReviewId ? `GitHub review id: ${response.reviewSubmission.githubReviewId}` : 'GitHub review id: unavailable',
    ].join('\n'),
    data: {
      project: toCompactProjectSummary(context.project),
      review: context.review,
      action,
      publication,
      reviewSubmission: response.reviewSubmission || null,
      results,
    },
    nextActions: [`Run ${TOOL_NAMES.githubPublications} to inspect persisted publication state.`, `Run ${TOOL_NAMES.outcomeGet} to review Atlas outcome state for the same PR.`],
  };
}

function normalizeAction(value: unknown): 'comment' | 'approve' | 'request_changes' {
  const action = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (action === 'comment' || action === 'approve' || action === 'request_changes') {
    return action;
  }
  throw new AtlasMcpError('INVALID_INPUT', 'action must be one of: comment, approve, request_changes.');
}

function normalizeRecommendationKeyList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const deduped = new Set<string>();
  for (const entry of value) {
    const key = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    if (!key) continue;
    deduped.add(key);
  }
  return Array.from(deduped);
}
