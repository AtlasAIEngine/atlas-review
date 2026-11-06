import { resolveCurrentReviewContext } from '../tools/projectContext.js';
import { TOOL_NAMES } from '../toolNames.js';
import type { PromptDefinition } from '../types.js';
import {
  getRecommendationIdentityKey,
  normalizeRecommendations,
  normalizeOptionalString,
  parseLineNumber,
} from '../utils/recommendationNormalization.js';
import { getFindingId } from '../utils/findingReferences.js';
import type { PromptDependencies } from './index.js';

interface PromptContextArgs {
  projectId?: string;
  reviewType?: string;
  branchReviewId?: string;
  displayId?: string;
  prReviewId?: string;
  githubPrNumber?: string;
}

export function createPrepareFixPlanFromFindingsPrompt(deps: PromptDependencies): PromptDefinition {
  return {
    name: 'prepare_fix_plan_from_findings',
    description: 'Prepare an implementation-ready fix plan from current Atlas review findings.',
    arguments: [
      { name: 'projectId', description: 'Optional exact Atlas project ID override. Usually omit it so Atlas MCP resolves the current git repository.' },
      { name: 'reviewType', description: 'Optional review target type: branch_review or pr_review.' },
      { name: 'branchReviewId', description: 'Optional explicit branch review ID.' },
      { name: 'displayId', description: 'Optional branch review display ID (for example BR-123).' },
      { name: 'prReviewId', description: 'Optional explicit PR review ID.' },
      { name: 'githubPrNumber', description: 'Optional GitHub pull request number for PR review resolution.' },
    ],
    handler: async (args) => {
      const input = toPromptContextArgs(args);
      const context = await resolveCurrentReviewContext(deps.client, deps.config, input, deps.cwd);

      if (!context.review) {
        const missingContext = {
          project: {
            id: context.project.id,
            name: context.project.name,
            gitRoot: context.gitRoot,
          },
          review: null,
          nextTools: [TOOL_NAMES.runCurrent, TOOL_NAMES.latest, TOOL_NAMES.status],
        };

        return {
          description: 'No findings available because no review was resolved.',
          messages: [
            {
              role: 'user',
              text: [
                'Atlas fix-plan prompt context:',
                toJsonBlock(missingContext),
                `Generate a bootstrap fix-plan sequence that starts with ${TOOL_NAMES.runCurrent} and ${TOOL_NAMES.latest}.`,
              ].join('\n'),
            },
          ],
        };
      }

      const reviewRecord = context.review.type === 'pr_review' && context.prReview
        ? (await deps.client.getPrReview(context.project.id, context.prReview.id)) || context.prReview
        : context.branchReview
          ? (await deps.client.getBranchReview(context.project.id, context.branchReview.id)) || context.branchReview
          : null;
      if (!reviewRecord) {
        throw new Error('Expected resolved review context to load a review record.');
      }
      const findings = [
        ...normalizeRecommendations(reviewRecord.reviewJson?.recommendations).map((item) => ({ item, previousFinding: false })),
        ...normalizeRecommendations(reviewRecord.reviewJson?.previousFindings).map((item) => ({ item, previousFinding: true })),
      ]
        .filter(({ item }) => String(item.type || '').toLowerCase() !== 'praise')
        .slice(0, 25)
        .map(({ item, previousFinding }, index) => ({
          findingId: getFindingId(item, index),
          recommendationKey: getRecommendationIdentityKey(item),
          severity: String(item.severity || 'unknown'),
          type: String(item.type || 'issue'),
          title: String(item.title || item.description || 'Untitled finding'),
          description: String(item.description || ''),
          previousFinding,
          file: normalizeOptionalString(item.file),
          line: parseLineNumber(item.line),
          suggestedFix: normalizeOptionalString(item.suggestedFix),
        }));

      const promptContext = {
        project: {
          id: context.project.id,
          name: context.project.name,
          gitRoot: context.gitRoot,
        },
        review: {
          ...context.review,
          branchName: context.review.type === 'branch_review'
            ? (reviewRecord as { branchName?: string }).branchName || null
            : (reviewRecord as { headBranch?: string }).headBranch || null,
          reviewStatus: reviewRecord.reviewStatus || null,
          riskLevel: reviewRecord.reviewJson?.riskLevel || reviewRecord.reviewRiskLevel || 'unknown',
          summary: reviewRecord.reviewJson?.summary || reviewRecord.reviewSummary || 'No review summary available.',
        },
        findings,
        nextTools: [TOOL_NAMES.file, TOOL_NAMES.outcomeGet, TOOL_NAMES.outcomeSet, TOOL_NAMES.runCurrent, TOOL_NAMES.status],
      };

      return {
        description: `Fix-plan prompt for ${context.review.label}`,
        messages: [
          {
            role: 'user',
            text: [
              'Atlas fix-plan prompt context:',
              toJsonBlock(promptContext),
              'Create an actionable fix plan with:',
              '1) grouped workstreams by file/area',
              '2) per-step implementation order and validation checks',
              '3) rollback or fallback notes for risky changes',
              `4) explicit MCP follow-ups using ${TOOL_NAMES.file}, ${TOOL_NAMES.outcomeSet} with findingId or recommendationKey, and ${TOOL_NAMES.status}`,
            ].join('\n'),
          },
        ],
      };
    },
  };
}

function toPromptContextArgs(args: Record<string, string>): PromptContextArgs {
  const projectId = normalizeOptionalString(args.projectId);
  const reviewType = normalizeOptionalString(args.reviewType);
  const branchReviewId = normalizeOptionalString(args.branchReviewId);
  const displayId = normalizeOptionalString(args.displayId);
  const prReviewId = normalizeOptionalString(args.prReviewId);
  const githubPrNumber = normalizeOptionalString(args.githubPrNumber);
  return { projectId, reviewType, branchReviewId, displayId, prReviewId, githubPrNumber };
}

function toJsonBlock(value: unknown): string {
  return ['```json', JSON.stringify(value, null, 2), '```'].join('\n');
}
