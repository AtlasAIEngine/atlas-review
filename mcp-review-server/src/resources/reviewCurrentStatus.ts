import { resolveCurrentReviewContext } from '../tools/projectContext.js';
import { runStatusTool } from '../tools/status.js';
import type { ResourceDefinition } from '../types.js';
import { toResolvedTargetArgs } from '../utils/resolvedTargetArgs.js';
import type { ResourceDependencies } from './index.js';

export function createReviewCurrentStatusResource(deps: ResourceDependencies): ResourceDefinition {
  return {
    uri: 'atlas://review/current/status',
    name: 'Current Review Status',
    description: 'Lifecycle and queue state for the currently resolved Atlas review context.',
    mimeType: 'application/json',
    handler: async () => {
      const currentReview = await resolveCurrentReviewContext(deps.client, deps.config, {}, deps.cwd);
      const status = await runStatusTool(deps.client, deps.config, deps.cwd, toResolvedTargetArgs(currentReview));
      const branchReview = status.data.branchReview;
      const prReview = status.data.prReview;

      const data = {
        schemaVersion: 1,
        project: {
          id: status.data.project.id,
          name: status.data.project.name,
          path: status.data.project.path || null,
        },
        review: status.data.review,
        branchReview: branchReview || null,
        prReview: prReview || null,
        lifecycleStatus: status.data.lifecycleStatus,
        queueState: status.data.queueState,
        queueCounts: {
          project: status.data.queueCount,
          currentReview: status.data.queueForCurrentReviewCount,
        },
        queueForCurrentReview: status.data.queueForCurrentReview,
        nextActions: status.nextActions || [],
      };

      return {
        summary: status.summary,
        data,
      };
    },
  };
}
