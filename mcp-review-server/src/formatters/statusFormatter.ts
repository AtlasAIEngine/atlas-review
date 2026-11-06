import type { StatusToolData } from '../types.js';

function describeReviewType(reviewType: string): string {
  if (reviewType === 'pr_review') return 'PR review';
  if (reviewType === 'workspace_review') return 'Workspace review';
  return 'Branch review';
}

export function formatStatusSummary(data: StatusToolData): string {
  const lines: string[] = [];
  lines.push(`Project: ${data.project.name} (${data.project.id})`);

  if (!data.review) {
    lines.push('Review: none found');
  } else {
    lines.push(`${describeReviewType(data.review.type)}: ${data.review.label}`);
    lines.push(`Review status: ${data.prReview?.reviewStatus || data.branchReview?.reviewStatus || 'none'}`);
  }

  lines.push(`Lifecycle status: ${data.lifecycleStatus}`);
  lines.push(`Queue entries for project: ${data.queueCount}`);
  lines.push(`Queue entries for selected review: ${data.queueForCurrentReviewCount}`);
  if (data.activeExecution) {
    lines.push(`Execution active: ${data.activeExecution.isActive ? 'yes' : 'no'}`);
    lines.push(`Execution terminal: ${data.activeExecution.isTerminal ? 'yes' : 'no'}`);
    if (data.activeExecution.queuePosition != null) {
      lines.push(`Queue position: ${data.activeExecution.queuePosition}`);
    }
    if (data.activeExecution.phase) {
      lines.push(`Phase: ${data.activeExecution.phase}`);
    }
    if (data.activeExecution.elapsedSeconds != null) {
      lines.push(`Elapsed seconds: ${data.activeExecution.elapsedSeconds}`);
    }
    if (data.activeExecution.secondsSinceLastActivity != null) {
      lines.push(`Seconds since last activity: ${data.activeExecution.secondsSinceLastActivity}`);
    }
    if (data.activeExecution.filesCompleted != null || data.activeExecution.totalFiles != null) {
      lines.push(`Files progress: ${data.activeExecution.filesCompleted ?? 0}/${data.activeExecution.totalFiles ?? 0}`);
    }
    if (data.activeExecution.currentChunk != null || data.activeExecution.totalChunks != null) {
      lines.push(`Chunk progress: ${data.activeExecution.currentChunk ?? 0}/${data.activeExecution.totalChunks ?? 0}`);
    }
    if (data.activeExecution.retryAttempt != null && data.activeExecution.retryMaxAttempts != null && data.activeExecution.retryMaxAttempts > 0) {
      lines.push(`Retry attempt: ${data.activeExecution.retryAttempt}/${data.activeExecution.retryMaxAttempts}`);
    }
    if (data.activeExecution.isStale) {
      lines.push(`Freshness: stale (>${data.activeExecution.staleAfterSeconds}s without activity)`);
    } else if (data.activeExecution.isActive) {
      lines.push('Freshness: active/fresh');
    } else {
      lines.push('Freshness: inactive');
    }
    if (data.activeExecution.executionNote) {
      lines.push(`Execution note: ${data.activeExecution.executionNote}`);
    }
    if (data.activeExecution.error) {
      lines.push(`Execution error: ${data.activeExecution.error}`);
    }
  }
  lines.push(
    data.queueState === 'queued_or_running'
      ? 'Queue state: selected review is queued or running.'
      : 'Queue state: no queued or running review state detected.'
  );

  return lines.join('\n');
}
