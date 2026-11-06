import type { AtlasApiClient } from '../client.js';
import type { AtlasConfig } from '../config.js';
import type {
  BranchReviewSummary,
  PrReviewSummary,
  WorkspaceReviewSummary,
  ReviewActiveExecutionStatus,
  ReviewLifecycleSnapshot,
  ReviewProgressSnapshot,
  ReviewQueueEntry,
  ReviewTargetRef,
  StatusToolData,
} from '../types.js';
import { toCompactBranchReview, toCompactPrReview, toCompactProjectSummary, toCompactQueueEntry } from '../utils/reviewPayloadShapes.js';
import { resolveCurrentReviewContext, type ToolContextInput, type ToolContextResult } from './projectContext.js';

export const ACTIVE_REVIEW_STALE_AFTER_SECONDS = 600;

const ACTIVE_LIFECYCLE_STATUSES = new Set(['queued', 'running', 'retrying']);
const TERMINAL_LIFECYCLE_STATUSES = new Set(['completed', 'failed', 'partial']);
const ACTIVE_QUEUE_STATUSES = new Set(['queued', 'reviewing', 'running', 'retrying']);
const LONG_RUNNING_PHASES = new Set([
  'agentic_tool_use',
  'agentic_exploration',
  'chunk_inflight',
  'single_inflight',
  'provider_retry',
  'synthesizing',
]);

export interface StatusSnapshot {
  context: ToolContextResult;
  data: StatusToolData;
}

export async function loadStatusSnapshot(
  client: AtlasApiClient,
  config: AtlasConfig,
  cwd: string,
  args: ToolContextInput
): Promise<StatusSnapshot> {
  const context = await resolveCurrentReviewContext(client, config, args, cwd);
  const refreshedContext = await hydrateResolvedReview(client, context);

  const queue = await client.getReviewQueue();
  const queueForProject = queue.filter((entry) => entry.projectId === refreshedContext.project.id);
  const currentReviewId = refreshedContext.review?.id ?? null;
  const queueForCurrentReview = currentReviewId
    ? queueForProject.filter((entry) => isMatchingReview(entry, refreshedContext.review?.type, currentReviewId))
    : [];
  const activeQueueEntry = queueForCurrentReview.find((entry) => isActiveQueueStatus(entry.status)) || queueForCurrentReview[0] || null;
  const queuePosition = activeQueueEntry ? queueForProject.findIndex((entry) => entry.id === activeQueueEntry.id) + 1 : null;
  const lifecycleStatus = resolveLifecycleStatus(refreshedContext.branchReview || refreshedContext.prReview, activeQueueEntry);
  const activeExecution = buildActiveExecutionStatus(
    refreshedContext.branchReview || refreshedContext.prReview,
    activeQueueEntry,
    queuePosition,
    lifecycleStatus
  );
  const queueState = activeExecution?.isActive || (queueForCurrentReview.length > 0 && !activeExecution?.isTerminal)
    ? 'queued_or_running'
    : 'no_active_queue';

  return {
    context: refreshedContext,
    data: {
      project: toCompactProjectSummary(refreshedContext.project),
      review: refreshedContext.review,
      branchReview: toCompactBranchReview(refreshedContext.branchReview),
      prReview: toCompactPrReview(refreshedContext.prReview),
      queueCount: queueForProject.length,
      queueForCurrentReview: queueForCurrentReview.map((entry) => toCompactQueueEntry(entry)),
      queueForCurrentReviewCount: queueForCurrentReview.length,
      lifecycleStatus,
      queueState,
      activeExecution,
    },
  };
}

export function isTerminalLifecycleStatus(status: string | null | undefined): boolean {
  return TERMINAL_LIFECYCLE_STATUSES.has(normalizeLifecycleStatus(status));
}

function buildActiveExecutionStatus(
  review: BranchReviewSummary | WorkspaceReviewSummary | PrReviewSummary | null,
  queueEntry: ReviewQueueEntry | null,
  queuePosition: number | null,
  lifecycleStatus: string
): ReviewActiveExecutionStatus | null {
  const lifecycle = asLifecycleSnapshot(queueEntry?.lifecycle || review?.reviewLifecycle || null);
  const progress = asProgressSnapshot(queueEntry?.progress || null);
  const normalizedLifecycleStatus = normalizeLifecycleStatus(
    lifecycleStatus
      || lifecycle?.status
      || review?.reviewStatus
      || queueEntry?.status
      || 'none'
  );
  const phase = firstString(progress?.phase, lifecycle?.phase);
  const lastActivityAt = firstString(progress?.updatedAt, lifecycle?.updatedAt, queueEntry?.updatedAt, review?.updatedAt, queueEntry?.queuedAt);
  const startedAt = firstString(queueEntry?.queuedAt, review?.createdAt, review?.updatedAt);
  const elapsedSeconds = firstNumber(progress?.elapsedSeconds, diffSeconds(startedAt, lastActivityAt), diffSeconds(startedAt, new Date().toISOString()));
  const secondsSinceLastActivity = diffSeconds(lastActivityAt, new Date().toISOString());
  const isTerminal = isTerminalLifecycleStatus(normalizedLifecycleStatus) || lifecycle?.isTerminal === true;
  const hasQueueEvidence = Boolean(queueEntry);
  const queuelessQueuedLifecycle = normalizedLifecycleStatus === 'queued' && !hasQueueEvidence;
  const queuelessQueuedLifecycleIsStale = Boolean(
    queuelessQueuedLifecycle
    && (
      typeof secondsSinceLastActivity !== 'number'
      || secondsSinceLastActivity >= ACTIVE_REVIEW_STALE_AFTER_SECONDS
    )
  );
  const isActive = !isTerminal && (
    (
      queuelessQueuedLifecycle
        ? !queuelessQueuedLifecycleIsStale
        : lifecycle?.isActive === true || ACTIVE_LIFECYCLE_STATUSES.has(normalizedLifecycleStatus)
    )
    || isActiveQueueStatus(queueEntry?.status)
  );
  const isStale = Boolean(
    queuelessQueuedLifecycleIsStale
    || (
      isActive
      && normalizedLifecycleStatus !== 'queued'
      && typeof secondsSinceLastActivity === 'number'
      && secondsSinceLastActivity >= ACTIVE_REVIEW_STALE_AFTER_SECONDS
    )
  );
  const executionNote = buildExecutionNote({
    lifecycleStatus: normalizedLifecycleStatus,
    phase,
    totalFiles: firstNumber(progress?.totalFiles, null),
    isStale,
    secondsSinceLastActivity,
    queuelessQueuedLifecycleIsStale,
  });

  if (!queueEntry && !review && !isActive && !isTerminal) {
    return null;
  }

  return {
    queueEntryId: typeof queueEntry?.id === 'string' ? queueEntry.id : null,
    queuePosition: queuePosition && queuePosition > 0 ? queuePosition : null,
    lifecycleStatus: normalizedLifecycleStatus,
    phase,
    startedAt,
    lastActivityAt,
    elapsedSeconds,
    secondsSinceLastActivity,
    filesCompleted: firstNumber(progress?.filesCompleted, null),
    totalFiles: firstNumber(progress?.totalFiles, null),
    currentChunk: firstNumber(progress?.currentChunk, null),
    totalChunks: firstNumber(progress?.totalChunks, null),
    retryAttempt: firstNumber(progress?.retryAttempt, null),
    retryMaxAttempts: firstNumber(progress?.retryMaxAttempts, null),
    isActive,
    isTerminal,
    isStale,
    staleAfterSeconds: ACTIVE_REVIEW_STALE_AFTER_SECONDS,
    executionNote,
    queueStatus: firstString(queueEntry?.status, lifecycle?.sourceStatus),
    error: firstString(progress?.error, lifecycle?.error, queueEntry?.reviewError),
    progress,
    lifecycle,
  };
}

function buildExecutionNote({
  lifecycleStatus,
  phase,
  totalFiles,
  isStale,
  secondsSinceLastActivity,
  queuelessQueuedLifecycleIsStale,
}: {
  lifecycleStatus: string;
  phase: string | null;
  totalFiles: number | null;
  isStale: boolean;
  secondsSinceLastActivity: number | null;
  queuelessQueuedLifecycleIsStale: boolean;
}): string | null {
  if (queuelessQueuedLifecycleIsStale) {
    return typeof secondsSinceLastActivity === 'number'
      ? `Review is still marked queued, but no active queue entry has existed for ${secondsSinceLastActivity}s. Re-run the review instead of waiting.`
      : 'Review is still marked queued, but no active queue entry exists. Re-run the review instead of waiting.';
  }
  if (isStale) {
    return typeof secondsSinceLastActivity === 'number'
      ? `No new review activity observed for ${secondsSinceLastActivity}s. Investigate before cancelling.`
      : 'No new review activity observed for an extended period. Investigate before cancelling.';
  }
  if (lifecycleStatus === 'queued') {
    return 'Review is queued. Wait for execution to begin rather than cancelling on elapsed time alone.';
  }
  if (phase && LONG_RUNNING_PHASES.has(phase)) {
    return 'This phase often runs for several minutes on larger reviews. Do not cancel based on elapsed time alone.';
  }
  if (typeof totalFiles === 'number' && totalFiles >= 25) {
    return 'Large reviews can remain active for several minutes. Wait for fresh activity or terminal state before cancelling.';
  }
  if (lifecycleStatus === 'retrying') {
    return 'The review is retrying provider work. Wait for retry completion before treating it as stuck.';
  }
  if (lifecycleStatus === 'running') {
    return 'Review is actively running. Wait for terminal state unless activity goes stale.';
  }
  return null;
}

async function hydrateResolvedReview(
  client: AtlasApiClient,
  context: ToolContextResult
): Promise<ToolContextResult> {
  if (context.review?.type === 'pr_review' && context.prReview) {
    const prReview = await client.getPrReview(context.project.id, context.prReview.id).catch(() => null);
    if (!prReview) return context;
    return {
      ...context,
      review: toReviewTargetRef('pr_review', prReview.id, prReview.displayId || null, prReview.displayId || formatPrLabel(prReview)),
      prReview,
    };
  }

  if (context.review?.type === 'workspace_review' && context.branchReview) {
    const workspaceReview = await client.getWorkspaceReview(context.project.id, context.branchReview.id).catch(() => null);
    if (!workspaceReview) return context;
    return {
      ...context,
      review: toReviewTargetRef('workspace_review', workspaceReview.id, workspaceReview.displayId || null, workspaceReview.displayId || workspaceReview.id),
      branchReview: workspaceReview,
    };
  }

  if (context.branchReview) {
    const branchReview = await client.getBranchReview(context.project.id, context.branchReview.id).catch(() => null);
    if (!branchReview) return context;
    return {
      ...context,
      review: toReviewTargetRef('branch_review', branchReview.id, branchReview.displayId || null, branchReview.displayId || branchReview.id),
      branchReview,
    };
  }

  return context;
}

function isMatchingReview(entry: ReviewQueueEntry, reviewType: string | undefined, reviewId: string): boolean {
  if (reviewType === 'pr_review') {
    return entry.type === 'pr_review' && entry.prReviewId === reviewId;
  }
  if (reviewType === 'workspace_review') {
    return entry.type === 'workspace_review' && entry.workspaceReviewId === reviewId;
  }
  return entry.type === 'branch_review' && entry.branchReviewId === reviewId;
}

function resolveLifecycleStatus(
  review: BranchReviewSummary | WorkspaceReviewSummary | PrReviewSummary | null,
  queueEntry: ReviewQueueEntry | null
): string {
  return normalizeLifecycleStatus(
    queueEntry?.lifecycle?.status
    || review?.reviewLifecycle?.status
    || review?.reviewLifecycle?.sourceStatus
    || review?.reviewStatus
    || queueEntry?.status
    || 'none'
  );
}

function isActiveQueueStatus(status: string | undefined): boolean {
  return ACTIVE_QUEUE_STATUSES.has(String(status || '').trim().toLowerCase());
}

function normalizeLifecycleStatus(status: string | null | undefined): string {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'reviewing' || normalized === 'running') return 'running';
  if (normalized === 'reviewed' || normalized === 'completed') return 'completed';
  if (normalized === 'failed') return 'failed';
  if (normalized === 'partial') return 'partial';
  if (normalized === 'retrying') return 'retrying';
  if (normalized === 'queued') return 'queued';
  return normalized || 'none';
}

function toReviewTargetRef(
  type: ReviewTargetRef['type'],
  id: string,
  displayId: string | null,
  label: string
): ReviewTargetRef {
  return { type, id, displayId, label };
}

function formatPrLabel(prReview: PrReviewSummary): string {
  return Number.isFinite(prReview.githubPrNumber) ? `PR #${prReview.githubPrNumber}` : prReview.id;
}

function asProgressSnapshot(value: ReviewProgressSnapshot | null | undefined): ReviewProgressSnapshot | null {
  return value && typeof value === 'object' ? value : null;
}

function asLifecycleSnapshot(value: ReviewLifecycleSnapshot | null | undefined): ReviewLifecycleSnapshot | null {
  return value && typeof value === 'object' ? value : null;
}

function firstString(...values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function firstNumber(...values: Array<number | null | undefined>): number | null {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return null;
}

function diffSeconds(from: string | null | undefined, to: string | null | undefined): number | null {
  const fromMs = parseDate(from);
  const toMs = parseDate(to);
  if (fromMs == null || toMs == null) return null;
  return Math.max(0, Math.floor((toMs - fromMs) / 1000));
}

function parseDate(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  const naiveMatch = trimmed.match(
    /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/
  );
  const hasExplicitTimezone = /(?:Z|[+-]\d{2}:\d{2})$/i.test(trimmed);
  if (naiveMatch && !hasExplicitTimezone) {
    const [, year, month, day, hour, minute, second, millis = '0'] = naiveMatch;
    const parsedLocal = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Number(millis.padEnd(3, '0'))
    ).getTime();
    return Number.isFinite(parsedLocal) ? parsedLocal : null;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}
