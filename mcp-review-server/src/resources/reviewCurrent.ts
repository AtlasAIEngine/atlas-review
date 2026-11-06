import { isAtlasMcpError } from '../errors.js';
import { runLatestTool } from '../tools/latest.js';
import { resolveCurrentReviewContext } from '../tools/projectContext.js';
import { runStatusTool } from '../tools/status.js';
import type { ResourceDefinition } from '../types.js';
import { toResolvedTargetArgs } from '../utils/resolvedTargetArgs.js';
import type { ResourceDependencies } from './index.js';

export function createReviewCurrentResource(deps: ResourceDependencies): ResourceDefinition {
  return {
    uri: 'atlas://review/current',
    name: 'Current Review Context',
    description: 'Combined status and latest findings context for the currently resolved Atlas review.',
    mimeType: 'application/json',
    handler: async () => {
      const currentReview = await resolveCurrentReviewContext(deps.client, deps.config, {}, deps.cwd);
      const targetArgs = toResolvedTargetArgs(currentReview);
      const status = await runStatusTool(deps.client, deps.config, deps.cwd, targetArgs);

      let latest: Awaited<ReturnType<typeof runLatestTool>> | null = null;
      if (currentReview.review) {
        try {
          latest = await runLatestTool(deps.client, deps.config, deps.cwd, targetArgs);
        } catch (error) {
          if (!isMissingReviewError(error)) {
            throw error;
          }
        }
      }

      const review = latest?.data.review || status.data.review;
      const branchReview = latest?.data.branchReview || status.data.branchReview;
      const prReview = latest?.data.prReview || status.data.prReview;
      const summary = latest
        ? `Project ${status.data.project.name} review ${review?.label || 'unknown'} risk ${latest.data.riskLevel}.`
        : `Project ${status.data.project.name} has no resolved review yet.`;

      return {
        summary,
        data: {
          schemaVersion: 1,
          project: {
            id: status.data.project.id,
            name: status.data.project.name,
            path: status.data.project.path || null,
          },
          review,
          branchReview: branchReview
            ? {
                id: branchReview.id,
                displayId: branchReview.displayId || null,
                branchName: branchReview.branchName || null,
                baseBranch: branchReview.baseBranch || null,
                reviewStatus: branchReview.reviewStatus || null,
              }
            : null,
          prReview: prReview
            ? {
                id: prReview.id,
                displayId: prReview.displayId || null,
                githubPrNumber: prReview.githubPrNumber || null,
                headBranch: prReview.headBranch || null,
                baseBranch: prReview.baseBranch || null,
                reviewStatus: prReview.reviewStatus || null,
              }
            : null,
          status: {
            lifecycleStatus: status.data.lifecycleStatus,
            queueState: status.data.queueState,
            queueCounts: {
              project: status.data.queueCount,
              currentReview: status.data.queueForCurrentReviewCount,
            },
          },
          latest: latest
            ? {
                summary: latest.data.summary,
                riskLevel: latest.data.riskLevel,
                findings: latest.data.findings,
              }
            : null,
          nextActions: status.nextActions || [],
        },
      };
    },
  };
}

function isMissingReviewError(error: unknown): boolean {
  return isAtlasMcpError(error) && (error.code === 'BRANCH_REVIEW_NOT_FOUND' || error.code === 'PR_REVIEW_NOT_FOUND');
}
