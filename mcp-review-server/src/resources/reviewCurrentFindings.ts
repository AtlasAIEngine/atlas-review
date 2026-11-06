import { resolveCurrentReviewContext } from '../tools/projectContext.js';
import { TOOL_NAMES } from '../toolNames.js';
import type { ResourceDefinition } from '../types.js';
import {
  getRecommendationIdentityKey,
  normalizeRecommendations,
  normalizeOptionalString,
  parseLineNumber,
} from '../utils/recommendationNormalization.js';
import { getFindingId } from '../utils/findingReferences.js';
import { listOutcomeLookup } from '../utils/reviewOutcomes.js';
import type { ResourceDependencies } from './index.js';

export function createReviewCurrentFindingsResource(deps: ResourceDependencies): ResourceDefinition {
  return {
    uri: 'atlas://review/current/findings',
    name: 'Current Review Findings',
    description: 'Machine-readable findings extracted from the currently resolved Atlas review.',
    mimeType: 'application/json',
    handler: async () => {
      const context = await resolveCurrentReviewContext(deps.client, deps.config, {}, deps.cwd);
      if (!context.review) {
        return {
          summary: `Project ${context.project.name} has no resolved review. Run ${TOOL_NAMES.runCurrent} first.`,
          data: {
            schemaVersion: 1,
            project: {
              id: context.project.id,
              name: context.project.name,
              path: context.project.path || null,
            },
            review: null,
            branchReview: null,
            prReview: null,
            findings: [],
            totals: {
              findings: 0,
              bySeverity: {},
            },
            nextActions: [TOOL_NAMES.runCurrent, TOOL_NAMES.latest],
          },
        };
      }

      const resolvedReview = context.review.type === 'pr_review' && context.prReview
        ? (await deps.client.getPrReview(context.project.id, context.prReview.id)) || context.prReview
        : context.review.type === 'workspace_review' && context.branchReview
          ? (await deps.client.getWorkspaceReview(context.project.id, context.branchReview.id)) || context.branchReview
          : context.branchReview
            ? (await deps.client.getBranchReview(context.project.id, context.branchReview.id)) || context.branchReview
            : null;
      if (!resolvedReview) {
        return {
          summary: `Project ${context.project.name} has no resolved review. Run ${TOOL_NAMES.runCurrent} first.`,
          data: {
            schemaVersion: 1,
            project: {
              id: context.project.id,
              name: context.project.name,
              path: context.project.path || null,
            },
            review: null,
            branchReview: null,
            prReview: null,
            findings: [],
            totals: {
              findings: 0,
              bySeverity: {},
            },
            nextActions: [TOOL_NAMES.runCurrent, TOOL_NAMES.latest],
          },
        };
      }

      const outcomeResponse = await listOutcomeLookup(deps.client, context.project.id, context.review.type, resolvedReview.id);
      const findings = [
        ...normalizeRecommendations(resolvedReview.reviewJson?.recommendations).map((item) => ({ item, previousFinding: false })),
        ...normalizeRecommendations(resolvedReview.reviewJson?.previousFindings).map((item) => ({ item, previousFinding: true })),
      ]
        .filter(({ item }) => String(item.type || '').toLowerCase() !== 'praise')
        .map(({ item, previousFinding }, index) => {
          const recommendationKey = getRecommendationIdentityKey(item);
          return {
            findingId: getFindingId(item, index),
            recommendationKey,
            severity: String(item.severity || 'unknown'),
            type: String(item.type || 'issue'),
            title: String(item.title || item.description || 'Untitled finding'),
            description: String(item.description || ''),
            previousFinding,
            file: normalizeOptionalString(item.file),
            line: parseLineNumber(item.line),
            suggestedFix: normalizeOptionalString(item.suggestedFix),
            outcome: outcomeResponse.byRecommendationKey?.[recommendationKey] || null,
          };
        });

      const bySeverity = findings.reduce<Record<string, number>>((acc, finding) => {
        const key = finding.severity.toLowerCase();
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {});

      return {
        summary: `Found ${findings.length} non-praise findings for ${context.review.label}.`,
        data: {
          schemaVersion: 1,
          project: {
            id: context.project.id,
            name: context.project.name,
            path: context.project.path || null,
          },
          review: context.review,
          branchReview: context.review.type === 'branch_review'
            ? {
                id: resolvedReview.id,
                displayId: resolvedReview.displayId || null,
                branchName: (resolvedReview as { branchName?: string }).branchName || null,
                reviewStatus: resolvedReview.reviewStatus || null,
                riskLevel: resolvedReview.reviewJson?.riskLevel || resolvedReview.reviewRiskLevel || 'unknown',
              }
            : null,
          prReview: context.review.type === 'pr_review'
            ? {
                id: resolvedReview.id,
                displayId: resolvedReview.displayId || null,
                githubPrNumber: (resolvedReview as { githubPrNumber?: number }).githubPrNumber || null,
                headBranch: (resolvedReview as { headBranch?: string }).headBranch || null,
                reviewStatus: resolvedReview.reviewStatus || null,
                riskLevel: resolvedReview.reviewJson?.riskLevel || resolvedReview.reviewRiskLevel || 'unknown',
              }
            : null,
          findings,
          totals: {
            findings: findings.length,
            bySeverity,
          },
          nextActions: [TOOL_NAMES.file, TOOL_NAMES.outcomeSet, TOOL_NAMES.outcomeGet, TOOL_NAMES.latest],
        },
      };
    },
  };
}
