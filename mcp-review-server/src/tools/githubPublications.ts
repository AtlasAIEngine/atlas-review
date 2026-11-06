import type { AtlasApiClient } from '../client.js';
import type { AtlasConfig } from '../config.js';
import { AtlasMcpError } from '../errors.js';
import { TOOL_NAMES } from '../toolNames.js';
import type { GitHubPublicationsToolData, ReviewPublicationRecord, ToolExecutionResult } from '../types.js';
import { toCompactProjectSummary } from '../utils/reviewPayloadShapes.js';
import { resolveOutcomeToolContext, type OutcomeToolContextInput } from './projectContext.js';

export interface GitHubPublicationsToolArgs extends OutcomeToolContextInput {}

export async function runGitHubPublicationsTool(
  client: AtlasApiClient,
  config: AtlasConfig,
  cwd: string,
  args: GitHubPublicationsToolArgs
): Promise<ToolExecutionResult<GitHubPublicationsToolData>> {
  const context = await resolveOutcomeToolContext(client, config, {
    ...args,
    reviewType: args.reviewType || 'pr_review',
  }, cwd);

  if (context.review.type !== 'pr_review' || !context.prReview) {
    throw new AtlasMcpError('INVALID_INPUT', `${TOOL_NAMES.githubPublications} currently supports reviewType "pr_review" only.`);
  }

  const response = await client.getPrReviewPublications(context.project.id, context.prReview.id);
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

  const publishedCount = Array.isArray(publication.publications) ? publication.publications.length : 0;
  const latestAction = typeof publication.latestAction === 'string' ? publication.latestAction : null;
  const findingsPreview = summarizePublications(publication.publications || []);

  return {
    summary: [
      `Project: ${context.project.name}`,
      `PR review: ${context.review.label}`,
      `Published findings: ${publishedCount}`,
      `Latest GitHub action: ${latestAction || 'none'}`,
      findingsPreview ? `Recent publications:\n${findingsPreview}` : 'Recent publications: none',
    ].join('\n'),
    data: {
      project: toCompactProjectSummary(context.project),
      review: context.review,
      publication,
    },
    nextActions: publishedCount > 0
      ? [`Run ${TOOL_NAMES.githubPublish} to submit another GitHub review action.`, `Run ${TOOL_NAMES.outcomeGet} to reconcile Atlas outcomes with posted findings.`]
      : [`Run ${TOOL_NAMES.githubPublish} to submit comment-ready findings to GitHub.`],
  };
}

function summarizePublications(publications: ReviewPublicationRecord[]): string {
  return publications
    .slice(0, 5)
    .map((entry) => {
      const location = entry.path ? `${entry.path}${entry.line ? `:${entry.line}` : ''}` : 'unknown location';
      return `- ${entry.recommendationKey} (${location}) via ${entry.action}`;
    })
    .join('\n');
}
