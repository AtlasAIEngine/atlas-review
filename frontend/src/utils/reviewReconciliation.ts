/**
 * Pure helper functions for branch review progress reconciliation.
 * Extracted from TrustReviewView.tsx for testability.
 */

export type ReviewLifecycleStatus = 'queued' | 'running' | 'retrying' | 'partial' | 'failed' | 'completed';

export type BranchReviewProgress = {
  phase?: string;
  currentChunk: number;
  totalChunks: number;
  filesCompleted: number;
  totalFiles: number;
  activeChunkFiles?: number;
  agenticToolSummary?: string | null;
  agentName?: string | null;
  prRequestedMode?: 'auto' | 'full' | 'agentic_discovery' | null;
  prEffectiveMode?: 'auto' | 'full' | 'agentic_discovery' | null;
  prPipelineMode?: 'standard' | 'agentic_discovery' | null;
  totalPrFiles?: number;
  effectiveReviewFiles?: number;
  updatedAt?: string | null;
};

export const ACTIVE_LIFECYCLE_STATUSES = new Set<ReviewLifecycleStatus>(['queued', 'running', 'retrying']);
export const TERMINAL_LIFECYCLE_STATUSES = new Set<ReviewLifecycleStatus>(['partial', 'failed', 'completed']);
const COMPLETED_OPTIMISTIC_PROGRESS_GRACE_MS = 30_000;

export function parseProgressTimestamp(value?: string | null): number | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeLifecycleStatusValue(
  value: unknown,
  fallback: ReviewLifecycleStatus = 'queued'
): ReviewLifecycleStatus {
  const normalized = String(value || '').trim().toLowerCase();
  if (
    normalized === 'queued'
    || normalized === 'running'
    || normalized === 'retrying'
    || normalized === 'partial'
    || normalized === 'failed'
    || normalized === 'completed'
  ) {
    return normalized;
  }
  const LEGACY_MAP: Record<string, ReviewLifecycleStatus> = {
    none: 'completed',
    reviewing: 'running',
    reviewed: 'completed',
  };
  if (normalized in LEGACY_MAP) return LEGACY_MAP[normalized];
  return fallback;
}

export function isActiveLifecycleStatus(status: unknown): boolean {
  return ACTIVE_LIFECYCLE_STATUSES.has(normalizeLifecycleStatusValue(status, 'completed'));
}

export function isActiveReviewProgressPhase(phase?: string): boolean {
  const normalized = String(phase || '').toLowerCase();
  return normalized === 'queued'
    || normalized === 'reviewing'
    || normalized === 'running'
    || normalized === 'retrying'
    || normalized === 'preparing_files'
    || normalized === 'file_triage'
    || normalized === 'file_review_start'
    || normalized === 'file_review_inflight'
    || normalized === 'file_review_failed'
    || normalized === 'file_partial'
    || normalized === 'single_start'
    || normalized === 'single_inflight'
    || normalized === 'chunk_start'
    || normalized === 'chunk_inflight'
    || normalized === 'chunk_split'
    || normalized === 'provider_retry'
    || normalized === 'synthesizing'
    || normalized === 'agentic_exploration'
    || normalized === 'agentic_tool_use';
}

export function hasInFlightOrPendingProgress(progress: BranchReviewProgress | null | undefined): boolean {
  if (!progress) return false;

  const activeChunkFiles = Math.max(0, Number(progress.activeChunkFiles) || 0);
  if (activeChunkFiles > 0) return true;

  const totalChunks = Math.max(0, Number(progress.totalChunks) || 0);
  const currentChunk = Math.max(0, Number(progress.currentChunk) || 0);
  const totalFiles = Math.max(0, Number(progress.totalFiles) || 0);
  const filesCompleted = Math.max(0, Number(progress.filesCompleted) || 0);

  return (totalChunks > 0 && currentChunk < totalChunks)
    || (totalFiles > 0 && filesCompleted < totalFiles);
}

/**
 * Decide whether a stale in-memory progress entry should be cleared,
 * given the backend lifecycle status fetched from the API.
 *
 * Returns true → progress entry should be deleted (review is done/stale).
 * Returns false → progress entry should be kept (review is still active or freshly optimistic).
 */
export function shouldClearStaleProgress(
  progress: BranchReviewProgress,
  reviewStatus: string | undefined,
  reviewUpdatedAt: string | null | undefined,
  nowMs: number = Date.now()
): boolean {
  const status = reviewStatus
    ? normalizeLifecycleStatusValue(reviewStatus, 'completed')
    : undefined;
  const activeStatus = status ? isActiveLifecycleStatus(status) : false;
  const activePhase = isActiveReviewProgressPhase(progress?.phase);
  const hasCounterWork = hasInFlightOrPendingProgress(progress);
  const hasTerminalStatus = typeof status === 'string' && !activeStatus;
  const isUnknownAndInactive = !status && !activePhase;

  const progressUpdatedAtMs = parseProgressTimestamp(progress?.updatedAt || null) || 0;
  const reviewUpdatedAtMs = parseProgressTimestamp(reviewUpdatedAt || null) || 0;
  const progressAppearsNewer = progressUpdatedAtMs > reviewUpdatedAtMs;
  const progressIsFresh = progressUpdatedAtMs > 0
    && nowMs >= progressUpdatedAtMs
    && (nowMs - progressUpdatedAtMs) <= COMPLETED_OPTIMISTIC_PROGRESS_GRACE_MS;
  // Failed/partial snapshots should always clear stale optimistic progress. Preserving
  // optimistic state here can leave the UI in an indefinite "reviewing" loop after failures.
  if (status === 'failed' || status === 'partial') {
    return true;
  }

  const shouldPreserveOptimisticRun = status === 'completed'
    && progressAppearsNewer
    && progressIsFresh
    && (activePhase || hasCounterWork);

  // When the backend says terminal, trust it — stale counters should NOT prevent cleanup.
  // Only preserve if progress appears to be from a genuinely newer optimistic run.
  if ((hasTerminalStatus && !shouldPreserveOptimisticRun) || isUnknownAndInactive) {
    return true;
  }

  return false;
}

/**
 * Decide whether an incoming branch snapshot should replace the existing one.
 */
export function shouldReplaceBranchSnapshot(
  existing: { reviewLifecycleIsActive?: boolean; reviewLifecycleIsTerminal?: boolean; updatedAt?: string | null } | undefined,
  incoming: { reviewLifecycleIsActive?: boolean; reviewLifecycleIsTerminal?: boolean; updatedAt?: string | null }
): boolean {
  if (!existing) return true;

  const existingMs = parseProgressTimestamp(existing.updatedAt) || 0;
  const incomingMs = parseProgressTimestamp(incoming.updatedAt) || 0;

  if (incomingMs > existingMs) return true;
  if (incomingMs < existingMs) return false;

  // On equal timestamps, terminal is a later lifecycle stage than active.
  // Prefer terminal (completed/failed/partial) over active (queued/running/retrying)
  // so completed results replace optimistic "queued" snapshots reliably.
  if (existing.reviewLifecycleIsTerminal && !incoming.reviewLifecycleIsTerminal) {
    return false;
  }

  return true;
}
