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

const HIGH_RISK_SEVERITIES = new Set(['critical', 'high']);

export function createTriageHighRiskFindingsPrompt(deps: PromptDependencies): PromptDefinition {
  return {
    name: 'triage_high_risk_findings',
    description: 'Generate a triage-focused analysis for high-risk findings in the current Atlas review.',
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
          nextTools: [TOOL_NAMES.runCurrent, TOOL_NAMES.latest],
        };

        return {
          description: 'High-risk triage requires an available review.',
          messages: [
            {
              role: 'user',
              text: [
                'Atlas review prompt context:',
                toJsonBlock(missingContext),
                `There is no review payload yet. Provide a brief triage bootstrap checklist and include ${TOOL_NAMES.runCurrent} then ${TOOL_NAMES.latest}.`,
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
      const recommendations = [
        ...normalizeRecommendations(reviewRecord.reviewJson?.recommendations).map((item) => ({ item, previousFinding: false })),
        ...normalizeRecommendations(reviewRecord.reviewJson?.previousFindings).map((item) => ({ item, previousFinding: true })),
      ]
        .filter(({ item }) => String(item.type || '').toLowerCase() !== 'praise')
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
        }));

      const highRiskFindings = recommendations.filter((item) => HIGH_RISK_SEVERITIES.has(item.severity.toLowerCase()));
      const findingsForPrompt = (highRiskFindings.length > 0 ? highRiskFindings : recommendations).slice(0, 20);

      const promptContext = {
        project: {
          id: context.project.id,
          name: context.project.name,
          gitRoot: context.gitRoot,
        },
        review: {
          ...context.review,
          reviewStatus: reviewRecord.reviewStatus || null,
          riskLevel: reviewRecord.reviewJson?.riskLevel || reviewRecord.reviewRiskLevel || 'unknown',
        },
        highRiskOnly: highRiskFindings.length > 0,
        findings: findingsForPrompt,
        nextTools: [TOOL_NAMES.file, TOOL_NAMES.outcomeGet, TOOL_NAMES.outcomeSet, TOOL_NAMES.latest],
      };

      return {
        description: `High-risk triage prompt for ${context.review.label}`,
        messages: [
          {
            role: 'user',
            text: [
              'Atlas triage prompt context:',
              toJsonBlock(promptContext),
              'Produce a triage report that includes:',
              '1) risk-ranked findings with clear addressed/dismissed recommendation',
              '2) evidence needed before dismissing any finding',
              `3) exact ${TOOL_NAMES.file} lookups to run first`,
              `4) ${TOOL_NAMES.outcomeSet} payload hints for each triaged finding using its findingId or recommendationKey`,
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
