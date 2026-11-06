import type { AtlasApiClient } from '../client.js';
import type { AtlasConfig } from '../config.js';
import { AtlasMcpError } from '../errors.js';
import { formatFileSummary } from '../formatters/reviewFormatter.js';
import { TOOL_NAMES } from '../toolNames.js';
import type {
  BranchReviewSummary,
  FileToolData,
  PrReviewSummary,
  ReviewFileContent,
  WorkspaceReviewSummary,
  ToolExecutionResult,
} from '../types.js';
import { getRecommendationIdentityKey, normalizeRecommendations, parseLineNumber } from '../utils/recommendationNormalization.js';
import { getFindingId } from '../utils/findingReferences.js';
import { toCompactBranchReview, toCompactPrReview, toCompactProjectSummary } from '../utils/reviewPayloadShapes.js';
import { listOutcomeLookup } from '../utils/reviewOutcomes.js';
import { resolveCurrentReviewContext, type ToolContextInput, type ToolContextResult } from './projectContext.js';

export interface FileToolArgs extends ToolContextInput {
  path?: string;
}

export async function runFileTool(
  client: AtlasApiClient,
  config: AtlasConfig,
  cwd: string,
  args: FileToolArgs
): Promise<ToolExecutionResult<FileToolData>> {
  const path = normalizeRequestedPath(args.path);
  if (!path) {
    throw new AtlasMcpError('INVALID_INPUT', 'path is required. Example: {"path":"src/index.ts"}');
  }

  const context = await resolveCurrentReviewContext(client, config, args, cwd);
  if (!context.review) {
    throw new AtlasMcpError('INVALID_INPUT', `No resolved review found for project ${context.project.name}.`);
  }

  const { reviewRecord, reviewType, fileResponse } = await loadReviewAndFile(client, context.project.id, context, path);
  const outcomeResponse = await listOutcomeLookup(client, context.project.id, reviewType, reviewRecord.id);

  const files = Array.isArray(fileResponse.files)
    ? fileResponse.files.filter((entry) => entry && typeof entry.path === 'string')
    : [];
  const missingPaths = normalizePathList(fileResponse.missingPaths);
  const normalizedRequestedPath = normalizePathForMatch(path);

  const file = selectMatchedFile(files, normalizedRequestedPath);
  const fileInScope = !!file && !missingPaths.includes(normalizedRequestedPath);
  const findings = collectFindingsForFile(reviewRecord, normalizedRequestedPath, file, outcomeResponse.byRecommendationKey || {});

  const data: FileToolData = {
    project: toCompactProjectSummary(context.project),
    review: context.review,
    branchReview: reviewType !== 'pr_review' ? toCompactBranchReview(reviewRecord as BranchReviewSummary | WorkspaceReviewSummary) : null,
    prReview: reviewType === 'pr_review' ? toCompactPrReview(reviewRecord as PrReviewSummary) : null,
    path,
    file,
    fileInScope,
    missingPaths,
    findings,
  };

  return {
    summary: formatFileSummary(data),
    data,
    nextActions: fileInScope
      ? (
          findings.length > 0
            ? [
                `Run ${TOOL_NAMES.outcomeSet} with status "addressed" or "dismissed" for a matched finding.`,
                `Run ${TOOL_NAMES.outcomeGet} to confirm the persisted review outcomes.`,
                `Run ${TOOL_NAMES.latest} to inspect remaining findings.`,
              ]
            : [`Run ${TOOL_NAMES.file} for another changed path.`, `Run ${TOOL_NAMES.latest} for full review context.`]
        )
      : [`Run ${TOOL_NAMES.latest} to inspect reviewed files.`, `Retry ${TOOL_NAMES.file} with a path in the branch review diff.`],
  };
}

function normalizeRequestedPath(value: unknown): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
  return normalized;
}

function normalizePathForMatch(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/^\.\/+/, '')
    .replace(/^\/+/, '');
}

function normalizePathList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input
    .map((entry) => normalizePathForMatch(entry))
    .filter((entry) => !!entry);
}

function selectMatchedFile(files: ReviewFileContent[], normalizedRequestedPath: string): ReviewFileContent | null {
  const exact = files.find((entry) => {
    if (normalizePathForMatch(entry.path) === normalizedRequestedPath) return true;
    if (typeof entry.oldPath === 'string' && normalizePathForMatch(entry.oldPath) === normalizedRequestedPath) return true;
    return false;
  });
  return exact || null;
}

function collectFindingsForFile(
  review: BranchReviewSummary | WorkspaceReviewSummary | PrReviewSummary,
  normalizedRequestedPath: string,
  file: ReviewFileContent | null,
  outcomesByRecommendationKey: Record<string, FileToolData['findings'][number]['outcome']>
): FileToolData['findings'] {
  const recommendations = [
    ...normalizeRecommendations(review.reviewJson?.recommendations).map((item) => ({ item, previousFinding: false })),
    ...normalizeRecommendations(review.reviewJson?.previousFindings).map((item) => ({ item, previousFinding: true })),
  ];
  if (!recommendations.length) return [];

  const targetPaths = new Set<string>([normalizedRequestedPath]);
  if (file?.path) targetPaths.add(normalizePathForMatch(file.path));
  if (typeof file?.oldPath === 'string' && file.oldPath.trim()) {
    targetPaths.add(normalizePathForMatch(file.oldPath));
  }

  const findingsSource = recommendations
    .filter(({ item }) => String(item.type || '').toLowerCase() !== 'praise');

  const findings: FileToolData['findings'] = [];
  for (let index = 0; index < findingsSource.length; index += 1) {
    const { item: recommendation, previousFinding } = findingsSource[index];
    const recommendationPath = normalizePathForMatch(recommendation.file);
    if (!recommendationPath || !targetPaths.has(recommendationPath)) continue;

    const recommendationKey = getRecommendationIdentityKey(recommendation);
    findings.push({
      findingId: getFindingId(recommendation, index),
      recommendationKey,
      type: String(recommendation.type || 'issue'),
      severity: String(recommendation.severity || 'unknown'),
      title: String(recommendation.title || recommendation.description || 'Untitled finding'),
      description: String(recommendation.description || ''),
      previousFinding,
      file: typeof recommendation.file === 'string' ? recommendation.file : undefined,
      line: parseLineNumber(recommendation.line),
      outcome: outcomesByRecommendationKey[recommendationKey] || null,
    });
  }

  return findings;
}

async function loadReviewAndFile(
  client: AtlasApiClient,
  projectId: string,
  context: ToolContextResult,
  path: string
): Promise<{
  reviewRecord: BranchReviewSummary | WorkspaceReviewSummary | PrReviewSummary;
  reviewType: 'branch_review' | 'workspace_review' | 'pr_review';
  fileResponse: Awaited<ReturnType<AtlasApiClient['getBranchReviewFileContent']>>;
}> {
  if (context.review?.type === 'pr_review' && context.prReview) {
    const [prReview, fileResponse] = await Promise.all([
      client.getPrReview(projectId, context.prReview.id),
      client.getPrReviewFileContent(projectId, context.prReview.id, [path]),
    ]);
    if (!prReview) {
      throw new AtlasMcpError('PR_REVIEW_NOT_FOUND', `PR review ${context.prReview.id} not found.`);
    }
    return { reviewRecord: prReview, reviewType: 'pr_review', fileResponse };
  }

  if (context.review?.type === 'workspace_review' && context.branchReview) {
    const [workspaceReview, fileResponse] = await Promise.all([
      client.getWorkspaceReview(projectId, context.branchReview.id),
      client.getWorkspaceReviewFileContent(projectId, context.branchReview.id, [path]),
    ]);
    if (!workspaceReview) {
      throw new AtlasMcpError('BRANCH_REVIEW_NOT_FOUND', `Workspace review ${context.branchReview.id} not found.`);
    }
    return { reviewRecord: workspaceReview, reviewType: 'workspace_review', fileResponse };
  }

  if (context.review?.type === 'pr_review') {
    throw new AtlasMcpError('PR_REVIEW_NOT_FOUND', `PR review context lost for project ${context.project.name}.`);
  }

  if (!context.branchReview) {
    throw new AtlasMcpError('BRANCH_REVIEW_NOT_FOUND', `No branch review found for project ${context.project.name}. Create a branch review first.`);
  }
  const [branchReview, fileResponse] = await Promise.all([
    client.getBranchReview(projectId, context.branchReview.id),
    client.getBranchReviewFileContent(projectId, context.branchReview.id, [path]),
  ]);
  if (!branchReview) {
    throw new AtlasMcpError('BRANCH_REVIEW_NOT_FOUND', `Branch review ${context.branchReview.id} not found.`);
  }
  return { reviewRecord: branchReview, reviewType: 'branch_review', fileResponse };
}
