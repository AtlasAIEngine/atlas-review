import type { AtlasApiClient } from '../client.js';
import type { AtlasConfig } from '../config.js';
import { AtlasMcpError } from '../errors.js';
import { TOOL_NAMES } from '../toolNames.js';
import type { BranchReviewScope, BranchReviewSummary, WorkspaceReviewSummary, PrReviewSummary, RunCurrentToolData, ToolExecutionResult } from '../types.js';
import { toCompactBranchReview, toCompactPrReview, toCompactProjectSummary } from '../utils/reviewPayloadShapes.js';
import { resolveCurrentReviewContext, type ToolContextInput, type ToolContextResult } from './projectContext.js';
import { ACTIVE_REVIEW_STALE_AFTER_SECONDS } from './statusShared.js';

export interface RunCurrentToolArgs extends ToolContextInput {
  mode?: 'queue' | 'immediate';
  reviewMode?: 'auto' | 'full';
  scope?: BranchReviewScope;
}

export async function runRunCurrentTool(
  client: AtlasApiClient,
  config: AtlasConfig,
  cwd: string,
  args: RunCurrentToolArgs
): Promise<ToolExecutionResult<RunCurrentToolData>> {
  const mode = normalizeMode(args.mode);
  const context = await resolveCurrentReviewContext(client, config, args, cwd);

  if (!context.review) {
    throw new AtlasMcpError('INVALID_INPUT', `No resolved review found for project ${context.project.name}.`);
  }

  if (context.review.type === 'pr_review') {
    if (args.scope) {
      throw new AtlasMcpError(
        'INVALID_INPUT',
        'scope is not supported for PR review scope. Omit scope or target a branch review.'
      );
    }
    if (args.reviewMode) {
      throw new AtlasMcpError(
        'INVALID_INPUT',
        'reviewMode is currently supported only for branch review scope. Omit reviewMode or target a branch review.'
      );
    }
    return runPrCurrentTool(client, context, mode);
  }

  if (context.review.type === 'workspace_review') {
    if (args.scope) {
      throw new AtlasMcpError(
        'INVALID_INPUT',
        'scope is not supported for workspace review scope. Omit scope or target a branch review.'
      );
    }
    return runWorkspaceCurrentTool(client, context, mode, args.reviewMode);
  }

  if (!context.branchReview) {
    throw new AtlasMcpError('BRANCH_REVIEW_NOT_FOUND', `No branch review found for project ${context.project.name}. Create a branch review before triggering review.`);
  }

  let queueId: string | null = null;
  let queuePosition: number | null = null;
  let reviewStatus = context.branchReview.reviewStatus || 'none';
  let lifecycleStatus = normalizeLifecycleStatus(context.branchReview);
  let requestTimedOut = false;
  let alreadyRunning = false;
  let responseBranchReview = context.branchReview;

  if (isActiveLifecycleStatus(lifecycleStatus)) {
    const queue = await client.getReviewQueue().catch(() => []);
    const activeQueueIndex = queue.findIndex((entry) =>
      entry.projectId === context.project.id
      && entry.type === 'branch_review'
      && entry.branchReviewId === context.branchReview?.id
      && isActiveQueueStatus(entry.status)
    );
    if (activeQueueIndex >= 0) {
      const activeEntry = queue[activeQueueIndex];
      queueId = typeof activeEntry?.id === 'string' ? activeEntry.id : null;
      queuePosition = activeQueueIndex + 1;
    }

    if (shouldTreatLifecycleAsAlreadyRunning(context.branchReview, lifecycleStatus, activeQueueIndex >= 0)) {
      return {
        summary: `Review for ${context.branchReview.displayId || context.branchReview.id} is already active${formatQueuePosition(queuePosition)}.`,
        data: {
          project: toCompactProjectSummary(context.project),
          review: context.review,
          branchReview: toCompactBranchReview(responseBranchReview),
          prReview: null,
          mode,
          queueId,
          queuePosition,
          reviewStatus,
          lifecycleStatus,
          alreadyRunning: true,
        },
        nextActions: [`Run ${TOOL_NAMES.waitForTerminal} to wait for a terminal review outcome.`, `Run ${TOOL_NAMES.status} to inspect freshness and progress.`],
      };
    }
  }

  if (mode === 'immediate') {
    const timeoutMs = getImmediateRunTimeoutMs(config);
    try {
      const response = await client.runBranchReview(context.project.id, context.branchReview.id, {
        reviewMode: args.reviewMode,
        scope: args.scope,
        timeoutMs,
      });
      alreadyRunning = response.alreadyRunning === true;
      queueId = typeof response.id === 'string' ? response.id : null;
      queuePosition = Number.isFinite(response.position) ? Number(response.position) : null;
      responseBranchReview = response.branchReview || responseBranchReview;
      reviewStatus = responseBranchReview?.reviewStatus || (alreadyRunning ? reviewStatus : 'reviewing');
      lifecycleStatus = normalizeLifecycleStatus(responseBranchReview) || lifecycleStatus;
    } catch (error) {
      if (!(error instanceof AtlasMcpError) || error.code !== 'REQUEST_TIMEOUT') {
        throw error;
      }

      requestTimedOut = true;
      // Immediate review call can outlive MCP timeout. Refresh once before deciding
      // whether the run is still active or already terminal.
      const refreshed = await client.getBranchReview(context.project.id, context.branchReview.id);
      reviewStatus = refreshed?.reviewStatus || 'reviewing';
      lifecycleStatus = normalizeLifecycleStatus(refreshed) || lifecycleStatus;
      if (isTerminalLifecycleStatus(lifecycleStatus)) {
        requestTimedOut = false;
      }
    }
  } else {
    const response = await client.queueBranchReview(context.project.id, context.branchReview.id, {
      reviewMode: args.reviewMode,
      scope: args.scope,
    });
    alreadyRunning = response.alreadyRunning === true;
    queueId = typeof response.id === 'string' ? response.id : null;
    queuePosition = Number.isFinite(response.position) ? Number(response.position) : null;
    if (response.branchReview) {
      responseBranchReview = response.branchReview;
      reviewStatus = responseBranchReview?.reviewStatus || (alreadyRunning ? reviewStatus : 'queued');
      lifecycleStatus = normalizeLifecycleStatus(responseBranchReview) || (alreadyRunning ? lifecycleStatus : 'queued');
    } else if (!alreadyRunning) {
      reviewStatus = 'queued';
      lifecycleStatus = 'queued';
      responseBranchReview = withQueuedLifecycle(responseBranchReview);
    }
  }

  const reviewLabel = context.branchReview.displayId || context.branchReview.id;
  const summary = mode === 'immediate'
    ? (
        alreadyRunning
          ? `Review for ${reviewLabel} is already active${formatQueuePosition(queuePosition)}.`
          :
        requestTimedOut
          ? `Triggered immediate review for ${reviewLabel}; request timed out while review continues (status: ${reviewStatus}, lifecycle: ${lifecycleStatus}).`
          : isTerminalLifecycleStatus(lifecycleStatus)
            ? `Immediate review for ${reviewLabel} reached terminal state (${lifecycleStatus}).`
            : `Triggered immediate review for ${reviewLabel}.`
      )
    : alreadyRunning
      ? `Review for ${reviewLabel} is already active${formatQueuePosition(queuePosition)}.`
      : `Queued review for ${reviewLabel}${queuePosition != null ? ` at position ${queuePosition}.` : '.'}`;

  return {
    summary,
    data: {
      project: toCompactProjectSummary(context.project),
      review: context.review,
      branchReview: toCompactBranchReview(responseBranchReview),
      prReview: null,
      mode,
      queueId,
      queuePosition,
      reviewStatus,
      lifecycleStatus,
      alreadyRunning: alreadyRunning || undefined,
      requestTimedOut: requestTimedOut || undefined,
    },
    nextActions: [`Run ${TOOL_NAMES.waitForTerminal} to wait for a terminal review outcome.`, `Run ${TOOL_NAMES.status} to inspect freshness and progress.`],
  };
}

async function runWorkspaceCurrentTool(
  client: AtlasApiClient,
  context: ToolContextResult,
  mode: 'queue' | 'immediate',
  reviewMode?: 'auto' | 'full'
): Promise<ToolExecutionResult<RunCurrentToolData>> {
  if (!context.branchReview || !context.review || context.review.type !== 'workspace_review') {
    throw new AtlasMcpError('BRANCH_REVIEW_NOT_FOUND', `No workspace review found for project ${context.project.name}.`);
  }
  if (mode === 'immediate') {
    throw new AtlasMcpError('INVALID_INPUT', 'mode "immediate" is not supported for workspace review scope. Use queue mode.');
  }

  let queueId: string | null = null;
  let queuePosition: number | null = null;
  let reviewStatus = context.branchReview.reviewStatus || 'none';
  let lifecycleStatus = normalizeLifecycleStatus(context.branchReview);
  let alreadyRunning = false;
  let responseWorkspaceReview: WorkspaceReviewSummary = context.branchReview as WorkspaceReviewSummary;

  if (isActiveLifecycleStatus(lifecycleStatus)) {
    const queue = await client.getReviewQueue().catch(() => []);
    const activeQueueIndex = queue.findIndex((entry) =>
      entry.projectId === context.project.id
      && entry.type === 'workspace_review'
      && entry.workspaceReviewId === context.branchReview?.id
      && isActiveQueueStatus(entry.status)
    );
    if (activeQueueIndex >= 0) {
      const activeEntry = queue[activeQueueIndex];
      queueId = typeof activeEntry?.id === 'string' ? activeEntry.id : null;
      queuePosition = activeQueueIndex + 1;
    }

    if (shouldTreatLifecycleAsAlreadyRunning(context.branchReview, lifecycleStatus, activeQueueIndex >= 0)) {
      return {
        summary: `Review for ${context.review.label} is already active${formatQueuePosition(queuePosition)}.`,
        data: {
          project: toCompactProjectSummary(context.project),
          review: context.review,
          branchReview: toCompactBranchReview(responseWorkspaceReview),
          prReview: null,
          mode,
          queueId,
          queuePosition,
          reviewStatus,
          lifecycleStatus,
          alreadyRunning: true,
        },
        nextActions: [`Run ${TOOL_NAMES.waitForTerminal} to wait for a terminal review outcome.`, `Run ${TOOL_NAMES.status} to inspect freshness and progress.`],
      };
    }
  }

  const response = await client.queueWorkspaceReview(context.project.id, context.branchReview.id, {
    ...(reviewMode ? { reviewMode } : {}),
  });
  alreadyRunning = response.alreadyRunning === true;
  queueId = typeof response.id === 'string' ? response.id : null;
  queuePosition = Number.isFinite(response.position) ? Number(response.position) : null;
  if (response.workspaceReview) {
    responseWorkspaceReview = response.workspaceReview;
    reviewStatus = responseWorkspaceReview.reviewStatus || (alreadyRunning ? reviewStatus : 'queued');
    lifecycleStatus = normalizeLifecycleStatus(responseWorkspaceReview) || (alreadyRunning ? lifecycleStatus : 'queued');
  } else if (!alreadyRunning) {
    reviewStatus = 'queued';
    lifecycleStatus = 'queued';
    responseWorkspaceReview = withQueuedLifecycle(responseWorkspaceReview) as WorkspaceReviewSummary;
  }

  return {
    summary: alreadyRunning
      ? `Review for ${context.review.label} is already active${formatQueuePosition(queuePosition)}.`
      : `Queued review for ${context.review.label}${queuePosition != null ? ` at position ${queuePosition}.` : '.'}`,
    data: {
      project: toCompactProjectSummary(context.project),
      review: context.review,
      branchReview: toCompactBranchReview(responseWorkspaceReview),
      prReview: null,
      mode,
      queueId,
      queuePosition,
      reviewStatus,
      lifecycleStatus,
      alreadyRunning: alreadyRunning || undefined,
    },
    nextActions: [`Run ${TOOL_NAMES.waitForTerminal} to wait for a terminal review outcome.`, `Run ${TOOL_NAMES.status} to inspect freshness and progress.`],
  };
}

async function runPrCurrentTool(
  client: AtlasApiClient,
  context: ToolContextResult,
  mode: 'queue' | 'immediate'
): Promise<ToolExecutionResult<RunCurrentToolData>> {
  if (!context.prReview || !context.review) {
    throw new AtlasMcpError('PR_REVIEW_NOT_FOUND', `No PR review found for project ${context.project.name}.`);
  }
  if (mode === 'immediate') {
    throw new AtlasMcpError('INVALID_INPUT', 'mode "immediate" is not supported for PR review scope. Use queue mode.');
  }

  let queueId: string | null = null;
  let queuePosition: number | null = null;
  let reviewStatus = context.prReview.reviewStatus || 'none';
  let lifecycleStatus = normalizeLifecycleStatus(context.prReview);
  let alreadyRunning = false;
  let responsePrReview: PrReviewSummary = context.prReview;

  if (isActiveLifecycleStatus(lifecycleStatus)) {
    const queue = await client.getReviewQueue().catch(() => []);
    const activeQueueIndex = queue.findIndex((entry) =>
      entry.projectId === context.project.id
      && entry.type === 'pr_review'
      && entry.prReviewId === context.prReview?.id
      && isActiveQueueStatus(entry.status)
    );
    if (activeQueueIndex >= 0) {
      const activeEntry = queue[activeQueueIndex];
      queueId = typeof activeEntry?.id === 'string' ? activeEntry.id : null;
      queuePosition = activeQueueIndex + 1;
    }

    if (shouldTreatLifecycleAsAlreadyRunning(context.prReview, lifecycleStatus, activeQueueIndex >= 0)) {
      return {
        summary: `Review for ${context.review.label} is already active${formatQueuePosition(queuePosition)}.`,
        data: {
          project: toCompactProjectSummary(context.project),
          review: context.review,
          branchReview: null,
          prReview: toCompactPrReview(responsePrReview),
          mode,
          queueId,
          queuePosition,
          reviewStatus,
          lifecycleStatus,
          alreadyRunning: true,
        },
        nextActions: [`Run ${TOOL_NAMES.waitForTerminal} to wait for a terminal review outcome.`, `Run ${TOOL_NAMES.status} to inspect freshness and progress.`],
      };
    }
  }

  const response = await client.queuePrReview(context.project.id, context.prReview.id);
  alreadyRunning = response.alreadyRunning === true;
  queueId = typeof response.id === 'string' ? response.id : null;
  queuePosition = Number.isFinite(response.position) ? Number(response.position) : null;
  if (response.prReview) {
    responsePrReview = response.prReview;
    reviewStatus = responsePrReview.reviewStatus || (alreadyRunning ? reviewStatus : 'queued');
    lifecycleStatus = normalizeLifecycleStatus(responsePrReview) || (alreadyRunning ? lifecycleStatus : 'queued');
  } else if (!alreadyRunning) {
    reviewStatus = 'queued';
    lifecycleStatus = 'queued';
    responsePrReview = withQueuedLifecycle(responsePrReview);
  }

  return {
    summary: alreadyRunning
      ? `Review for ${context.review.label} is already active${formatQueuePosition(queuePosition)}.`
      : `Queued review for ${context.review.label}${queuePosition != null ? ` at position ${queuePosition}.` : '.'}`,
    data: {
      project: toCompactProjectSummary(context.project),
      review: context.review,
      branchReview: null,
      prReview: toCompactPrReview(responsePrReview),
      mode,
      queueId,
      queuePosition,
      reviewStatus,
      lifecycleStatus,
      alreadyRunning: alreadyRunning || undefined,
    },
    nextActions: [`Run ${TOOL_NAMES.waitForTerminal} to wait for a terminal review outcome.`, `Run ${TOOL_NAMES.status} to inspect freshness and progress.`],
  };
}

function formatQueuePosition(queuePosition: number | null): string {
  return queuePosition != null ? ` at position ${queuePosition}` : '';
}

function isActiveLifecycleStatus(status: string): boolean {
  return status === 'queued' || status === 'running' || status === 'retrying';
}

function isActiveQueueStatus(status: string | undefined): boolean {
  const normalized = String(status || '').trim().toLowerCase();
  return normalized === 'queued' || normalized === 'reviewing' || normalized === 'running' || normalized === 'retrying';
}

function shouldTreatLifecycleAsAlreadyRunning(
  review: {
    updatedAt?: string | null;
    reviewLifecycle?: { status?: string | null; updatedAt?: string | null } | null;
  } | null | undefined,
  lifecycleStatus: string,
  hasActiveQueueEntry: boolean
): boolean {
  if (!isActiveLifecycleStatus(lifecycleStatus)) {
    return false;
  }

  if (hasActiveQueueEntry) {
    return true;
  }

  if (lifecycleStatus !== 'queued') {
    return true;
  }

  const lastActivityAt = firstString(review?.reviewLifecycle?.updatedAt, review?.updatedAt);
  const secondsSinceLastActivity = diffSeconds(lastActivityAt, new Date().toISOString());
  // Without queue evidence, prefer allowing a retry when age is unknown.
  if (typeof secondsSinceLastActivity !== 'number') {
    return false;
  }
  return secondsSinceLastActivity < ACTIVE_REVIEW_STALE_AFTER_SECONDS;
}

function normalizeMode(mode: unknown): 'queue' | 'immediate' {
  if (mode == null) return 'queue';
  const normalized = String(mode).trim().toLowerCase();
  if (normalized === 'queue' || normalized === 'immediate') return normalized;
  throw new AtlasMcpError('INVALID_INPUT', `Invalid mode "${String(mode)}". Use "queue" or "immediate".`);
}

function getImmediateRunTimeoutMs(config: AtlasConfig): number {
  const minimumImmediateTimeoutMs = 300_000;
  return Math.max(config.requestTimeoutMs, minimumImmediateTimeoutMs);
}

function normalizeLifecycleStatus(review: {
  reviewLifecycle?: { status?: string | null; sourceStatus?: string | null } | null;
  reviewStatus?: string;
} | null | undefined): string {
  const raw = String(
    review?.reviewLifecycle?.status
    || review?.reviewLifecycle?.sourceStatus
    || review?.reviewStatus
    || 'none'
  )
    .trim()
    .toLowerCase();

  if (raw === 'reviewing') return 'running';
  if (raw === 'reviewed') return 'completed';
  return raw;
}

function isTerminalLifecycleStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'partial';
}

function withQueuedLifecycle<T extends BranchReviewSummary | PrReviewSummary>(review: T): T {
  return {
    ...review,
    reviewStatus: 'queued',
    reviewLifecycle: {
      ...(review.reviewLifecycle || {}),
      status: 'queued',
      sourceStatus: 'queued',
      isActive: true,
      isTerminal: false,
    },
  } as T;
}

function firstString(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return null;
}

function diffSeconds(from: string | null | undefined, to: string | null | undefined): number | null {
  const start = parseTimestamp(from);
  const end = parseTimestamp(to);
  if (start == null || end == null) return null;
  return Math.max(0, Math.floor((end - start) / 1000));
}

function parseTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const normalized = /\dT\d/.test(value) || /[zZ]|[+-]\d\d:\d\d$/.test(value)
    ? value
    : value.replace(' ', 'T');
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? null : parsed;
}
