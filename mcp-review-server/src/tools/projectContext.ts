import type { AtlasConfig } from '../config.js';
import type { AtlasApiClient } from '../client.js';
import {
  resolveBranchReviewContext,
  resolveCurrentBranchName,
  resolvePrReviewContext,
  resolveProjectContext,
  resolveWorkspaceReviewContext,
  type BranchReviewResolveOptions,
} from '../context.js';
import { AtlasMcpError } from '../errors.js';
import type {
  BranchReviewSummary,
  ChangesetSummary,
  PrReviewSummary,
  WorkspaceReviewSummary,
  ProjectSummary,
  ResolvedReviewTarget,
  ReviewTargetRef,
  ReviewType,
} from '../types.js';

export interface ToolContextInput extends BranchReviewResolveOptions {
  projectId?: string;
  reviewType?: string;
  workspaceReviewId?: string;
  prReviewId?: string;
  githubPrNumber?: number | string;
}

export interface ToolContextResult extends ResolvedReviewTarget {
  project: ProjectSummary;
  gitRoot: string;
}

export interface OutcomeToolContextInput extends ToolContextInput {
  changesetId?: string;
}

export interface OutcomeToolContextResult {
  project: ProjectSummary;
  gitRoot: string;
  review: ReviewTargetRef;
  branchReview: BranchReviewSummary | WorkspaceReviewSummary | null;
  prReview: PrReviewSummary | null;
  changeset: ChangesetSummary | null;
}

export async function resolveToolContext(
  client: AtlasApiClient,
  config: AtlasConfig,
  input: ToolContextInput,
  cwd: string
): Promise<ToolContextResult> {
  const reviewType = normalizeReviewType(input.reviewType);
  const projectIdOverride = normalizeOptionalString(input.projectId);
  if (projectIdOverride) {
    const resolvedProject = await resolveProjectOverride(client, config, projectIdOverride, cwd);
    const resolvedReview = await resolveReviewTarget(
      client,
      resolvedProject.project,
      resolvedProject.gitRoot,
      reviewType,
      input
    );

    return {
      project: resolvedProject.project,
      ...resolvedReview,
      gitRoot: resolvedProject.gitRoot,
    };
  }

  const resolved = await resolveProjectContext(client, config, cwd);
  const resolvedReview = await resolveReviewTarget(client, resolved.project, resolved.gitRoot, reviewType, input);

  return {
    project: resolved.project,
    ...resolvedReview,
    gitRoot: resolved.gitRoot,
  };
}

export async function resolveCurrentReviewContext(
  client: AtlasApiClient,
  config: AtlasConfig,
  input: ToolContextInput,
  cwd: string
): Promise<ToolContextResult> {
  const hasExplicitReviewTarget = !!(
    normalizeOptionalString(input.reviewType)
    || normalizeOptionalString(input.branchReviewId)
    || normalizeOptionalString(input.workspaceReviewId)
    || normalizeOptionalString(input.displayId)
    || normalizeOptionalString(input.prReviewId)
    || normalizeOptionalString(input.githubPrNumber)
  );

  if (hasExplicitReviewTarget) {
    return resolveToolContext(client, config, input, cwd);
  }

  const branchContext = await resolveToolContext(client, config, input, cwd);
  if (branchContext.review?.type === 'workspace_review') {
    return branchContext;
  }
  const currentBranch = await resolveCurrentBranchName(branchContext.gitRoot);
  const reviewMatchesCurrentBranch = Boolean(
    branchContext.branchReview
    && currentBranch
    && branchContext.branchReview.branchName === currentBranch
  );

  const workspaceReview = await resolveWorkspaceReviewContext(client, branchContext.project, {
    requireReview: false,
  });
  if (workspaceReview && (!currentBranch || workspaceReview.branchName === currentBranch)) {
    return {
      project: branchContext.project,
      gitRoot: branchContext.gitRoot,
      review: {
        type: 'workspace_review',
        id: workspaceReview.id,
        displayId: workspaceReview.displayId || null,
        label: workspaceReview.displayId || workspaceReview.id,
      },
      branchReview: workspaceReview,
      prReview: null,
    };
  }

  if (branchContext.review && (!currentBranch || reviewMatchesCurrentBranch)) {
    return branchContext;
  }

  const prReview = await resolvePrReviewContext(client, branchContext.project, {
    requireReview: false,
    gitRoot: branchContext.gitRoot,
    branchName: currentBranch || undefined,
  });
  if (!prReview) {
    if (!currentBranch) {
      return branchContext;
    }
    return {
      project: branchContext.project,
      gitRoot: branchContext.gitRoot,
      review: null,
      branchReview: null,
      prReview: null,
    };
  }

  return {
    project: branchContext.project,
    gitRoot: branchContext.gitRoot,
    review: {
      type: 'pr_review',
      id: prReview.id,
      displayId: prReview.displayId || null,
      label: prReview.displayId || (Number.isFinite(prReview.githubPrNumber) ? `PR #${prReview.githubPrNumber}` : prReview.id),
    },
    branchReview: null,
    prReview,
  };
}

export async function resolveOutcomeToolContext(
  client: AtlasApiClient,
  config: AtlasConfig,
  input: OutcomeToolContextInput,
  cwd: string
): Promise<OutcomeToolContextResult> {
  const baseContext = await resolveToolContext(client, config, input, cwd);
  const reviewType = normalizeReviewType(input.reviewType);

  if (reviewType === 'branch_review') {
    if (!baseContext.branchReview) {
      throw new AtlasMcpError(
        'BRANCH_REVIEW_NOT_FOUND',
        `No branch review found for project ${baseContext.project.name}. Create a branch review first.`
      );
    }
    return {
      project: baseContext.project,
      gitRoot: baseContext.gitRoot,
      review: {
        type: 'branch_review',
        id: baseContext.branchReview.id,
        displayId: baseContext.branchReview.displayId || null,
        label: baseContext.branchReview.displayId || baseContext.branchReview.id,
      },
      branchReview: baseContext.branchReview,
      prReview: null,
      changeset: null,
    };
  }

  if (reviewType === 'workspace_review') {
    const workspaceReviewId = normalizeRequiredId(input.workspaceReviewId, 'workspaceReviewId');
    const workspaceReview = await resolveWorkspaceReviewContext(client, baseContext.project, {
      workspaceReviewId,
      requireReview: true,
    });
    if (!workspaceReview) {
      throw new AtlasMcpError('BRANCH_REVIEW_NOT_FOUND', `Workspace review ${workspaceReviewId} not found.`);
    }
    return {
      project: baseContext.project,
      gitRoot: baseContext.gitRoot,
      review: {
        type: 'workspace_review',
        id: workspaceReview.id,
        displayId: workspaceReview.displayId || null,
        label: workspaceReview.displayId || workspaceReview.id,
      },
      branchReview: workspaceReview,
      prReview: null,
      changeset: null,
    };
  }

  if (reviewType === 'pr_review') {
    if (!baseContext.prReview || !baseContext.review || baseContext.review.type !== 'pr_review') {
      throw new AtlasMcpError(
        'PR_REVIEW_NOT_FOUND',
        `No PR review found for project ${baseContext.project.name}. Provide prReviewId or githubPrNumber, or run from a branch that maps to exactly one PR review.`
      );
    }
    return {
      project: baseContext.project,
      gitRoot: baseContext.gitRoot,
      review: baseContext.review,
      branchReview: null,
      prReview: baseContext.prReview,
      changeset: null,
    };
  }

  const changesetId = normalizeRequiredId(input.changesetId, 'changesetId');
  const changeset = await client.getChangeset(baseContext.project.id, changesetId);
  if (!changeset) {
    throw new AtlasMcpError('CHANGESET_NOT_FOUND', `Changeset ${changesetId} not found.`);
  }
  return {
    project: baseContext.project,
    gitRoot: baseContext.gitRoot,
    review: {
      type: 'changeset',
      id: changeset.id,
      displayId: changeset.displayId || null,
      label: changeset.displayId || changeset.id,
    },
    branchReview: null,
    prReview: null,
    changeset,
  };
}

async function resolveProjectOverride(
  client: AtlasApiClient,
  config: AtlasConfig,
  projectIdInput: string,
  cwd: string
): Promise<{ project: ProjectSummary; gitRoot: string }> {
  const requestedProjectId = normalizeOptionalString(projectIdInput);
  const projects = await client.getProjects();
  const exactProject = projects.find((entry) => entry.id === requestedProjectId);
  if (exactProject) {
    return {
      project: exactProject,
      gitRoot: exactProject.path || cwd,
    };
  }

  let cwdResolutionError: unknown = null;
  try {
    const resolved = await resolveProjectContext(client, config, cwd);
    if (matchesProjectAlias(resolved.project, requestedProjectId)) {
      return {
        project: resolved.project,
        gitRoot: resolved.gitRoot,
      };
    }
  } catch (error) {
    cwdResolutionError = error;
  }

  const cwdHint = cwdResolutionError instanceof AtlasMcpError
    ? ` ${cwdResolutionError.message}`
    : '';
  throw new AtlasMcpError(
    'PROJECT_NOT_FOUND',
    `Project ${requestedProjectId} not found. projectId must be the exact Atlas project id; usually omit projectId so Atlas MCP can auto-resolve the current git repository.${cwdHint}`,
    { details: { projectId: requestedProjectId } }
  );
}

function matchesProjectAlias(project: ProjectSummary, value: string): boolean {
  const requested = normalizeComparableIdentifier(value);
  if (!requested) return false;
  const aliases = [
    project.id,
    project.name,
    project.path ? pathBasename(project.path) : '',
  ].map(normalizeComparableIdentifier).filter(Boolean);
  return aliases.includes(requested);
}

async function resolveReviewTarget(
  client: AtlasApiClient,
  project: ProjectSummary,
  gitRoot: string,
  reviewType: ReviewType,
  input: ToolContextInput
): Promise<ResolvedReviewTarget> {
  if (reviewType === 'pr_review') {
    const prReview = await resolvePrReviewContext(client, project, {
      prReviewId: input.prReviewId,
      githubPrNumber: input.githubPrNumber,
      requireReview: true,
      gitRoot,
    });
    return {
      review: prReview
        ? {
            type: 'pr_review',
            id: prReview.id,
            displayId: prReview.displayId || null,
            label: prReview.displayId || (Number.isFinite(prReview.githubPrNumber) ? `PR #${prReview.githubPrNumber}` : prReview.id),
          }
        : null,
      branchReview: null,
      prReview,
    };
  }

  if (reviewType === 'workspace_review') {
    const workspaceReview = await resolveWorkspaceReviewContext(client, project, {
      workspaceReviewId: input.workspaceReviewId,
      requireReview: true,
    });
    return {
      review: workspaceReview
        ? {
            type: 'workspace_review',
            id: workspaceReview.id,
            displayId: workspaceReview.displayId || null,
            label: workspaceReview.displayId || workspaceReview.id,
          }
        : null,
      branchReview: workspaceReview,
      prReview: null,
    };
  }

  const branchReview = await resolveBranchReviewContext(client, project, {
    branchReviewId: input.branchReviewId,
    displayId: input.displayId,
    requireReview: false,
  });
  return {
    review: branchReview
      ? {
          type: 'branch_review',
          id: branchReview.id,
          displayId: branchReview.displayId || null,
          label: branchReview.displayId || branchReview.id,
        }
      : null,
    branchReview,
    prReview: null,
  };
}

function normalizeReviewType(value: unknown): ReviewType {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!normalized || normalized === 'branch_review') return 'branch_review';
  if (normalized === 'workspace_review') return 'workspace_review';
  if (normalized === 'pr_review') return 'pr_review';
  if (normalized === 'changeset') return 'changeset';
  throw new AtlasMcpError('INVALID_INPUT', 'reviewType must be "branch_review", "workspace_review", "pr_review", or "changeset".');
}

function normalizeRequiredId(value: unknown, fieldName: string): string {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new AtlasMcpError('INVALID_INPUT', `${fieldName} is required for the selected reviewType.`);
  }
  return normalized;
}

function normalizeOptionalString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
}

function normalizeComparableIdentifier(value: unknown): string {
  return normalizeOptionalString(value).toLowerCase();
}

function pathBasename(value: string): string {
  return value ? value.split(/[\\/]+/u).filter(Boolean).pop() || '' : '';
}
