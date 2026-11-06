/**
 * Small, self-contained widget components extracted from TrustReviewPanel.
 *
 * CountChip, ReviewTierNotice, CollapsibleSection, ProgressPill, NoReviewSection
 */

import React, { useState, useEffect, useRef } from 'react';
import type { ReviewTier } from './reviewPanelUtils';
import { computeProgressPercent, getDiffScopeSummaryFromStats } from './reviewPanelUtils';
import { ReviewActionButton, getReviewCardStyle, getReviewMetaTextStyle } from './ReviewChrome';

// ── CountChip ───────────────────────────────────────────────────────────

export function CountChip({
  count,
  label,
  color,
  bg,
  title,
}: {
  count: number;
  label: string;
  color: string;
  bg: string;
  title?: string;
}) {
  const shouldShowCount = count > 0;
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      minHeight: 20,
      padding: '0 9px',
      borderRadius: 999,
      border: '1px solid var(--review-chip-neutral-border)',
      background: bg,
      boxShadow: 'var(--review-chip-shadow)',
      fontSize: 9,
      fontWeight: 700,
      letterSpacing: '0.06em',
      textTransform: 'uppercase',
      color,
      whiteSpace: 'nowrap',
    }}
    title={title}
    >
      {shouldShowCount ? `${count} ${label}${count !== 1 ? 's' : ''}` : label}
    </span>
  );
}

// ── ReviewTierNotice ────────────────────────────────────────────────────

export function ReviewTierNotice({
  tier,
  failedFileCount,
  failedFileCountUnlisted,
  omittedOnlyCount,
  totalFollowUpCount,
  onViewFollowUpFiles,
  deferredFileCount = 0,
  onRunPartialOnDeferred,
}: {
  tier: ReviewTier;
  failedFileCount: number;
  failedFileCountUnlisted: number;
  omittedOnlyCount: number;
  totalFollowUpCount: number;
  onViewFollowUpFiles?: (() => void) | undefined;
  deferredFileCount?: number;
  onRunPartialOnDeferred?: (() => void) | undefined;
}) {
  if (tier === 'full') return null;
  // Incremental reviews intentionally analyze only the new delta. The
  // omitted-file metadata remains available for analytics, but surfacing it
  // as a warning makes normal re-review flow look broken.
  if (tier === 'files_only') return null;

  const hasDeferred = deferredFileCount > 0 && typeof onRunPartialOnDeferred === 'function';
  const title = tier === 'partial'
      ? 'Partial review'
      : 'Review failed';
  const body = hasDeferred
      ? `${deferredFileCount} file${deferredFileCount !== 1 ? 's were' : ' was'} deferred. Tap to review the next chunk.`
      : tier === 'partial'
        ? 'Some files did not complete deep analysis. Retry with narrower scope before approving.'
        : 'Review failed before usable output was produced. Retry with narrower scope or run again.';
  const followUpLabel = (failedFileCount > 0 || omittedOnlyCount > 0)
    ? `Follow-up: ${totalFollowUpCount} file${totalFollowUpCount !== 1 ? 's' : ''} (${failedFileCount} failed, ${omittedOnlyCount} omitted)`
    : '';
  const unattributedLabel = failedFileCountUnlisted > 0
    ? `${failedFileCountUnlisted} failed file${failedFileCountUnlisted !== 1 ? 's were' : ' was'} not path-attributed.`
    : '';

  const baseStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 'var(--space-2)',
    marginBottom: 'var(--space-2)',
    padding: '6px 8px',
    borderRadius: 'var(--review-control-radius)',
    border: '1px solid var(--chip-warning-border)',
    background: 'var(--chip-warning-bg)',
    boxShadow: 'var(--review-chip-shadow)',
  };

  if (hasDeferred) {
    return (
      <button
        type="button"
        onClick={onRunPartialOnDeferred}
        title="Run partial review on the deferred files"
        style={{
          ...baseStyle,
          width: '100%',
          textAlign: 'left',
          cursor: 'pointer',
          font: 'inherit',
          color: 'inherit',
        }}
      >
        <span
          style={{
            color: 'var(--accent-yellow)',
            flexShrink: 0,
            fontSize: 9,
            fontWeight: 800,
            letterSpacing: '0.08em',
            lineHeight: 1,
            textTransform: 'uppercase',
          }}
        >
          {title}
        </span>
        <span style={{ ...getReviewMetaTextStyle({ bright: true }), color: 'var(--text-secondary)', lineHeight: 1.3, flex: '1 1 220px' }}>
          {body}
        </span>
        <span
          style={{
            ...getReviewMetaTextStyle({ bright: true }),
            color: 'var(--accent-blue)',
            fontWeight: 700,
            lineHeight: 1.3,
            flexShrink: 0,
          }}
        >
          Run next chunk →
        </span>
      </button>
    );
  }

  return (
    <div style={baseStyle}>
      <span
        style={{
          color: 'var(--accent-yellow)',
          flexShrink: 0,
          fontSize: 9,
          fontWeight: 800,
          letterSpacing: '0.08em',
          lineHeight: 1,
          textTransform: 'uppercase',
        }}
      >
        {title}
      </span>
      <span style={{ ...getReviewMetaTextStyle({ bright: true }), color: 'var(--text-secondary)', lineHeight: 1.3, flex: '1 1 220px' }}>
        {body}
      </span>
      {followUpLabel && (
        <span style={{ ...getReviewMetaTextStyle({ bright: true }), color: 'var(--text-tertiary)', lineHeight: 1.3 }}>
          {followUpLabel}
        </span>
      )}
      {unattributedLabel && (
        <span style={{ ...getReviewMetaTextStyle({ bright: true }), color: 'var(--text-tertiary)', lineHeight: 1.3 }}>
          {unattributedLabel}
        </span>
      )}
      {typeof onViewFollowUpFiles === 'function' && totalFollowUpCount > 0 && (
        <ReviewActionButton
          onClick={onViewFollowUpFiles}
          style={{
            minHeight: 22,
            padding: '0 8px',
            fontSize: 10,
          }}
          tone="blue"
        >
          View files
        </ReviewActionButton>
      )}
    </div>
  );
}

// ── CollapsibleSection ──────────────────────────────────────────────────

export function CollapsibleSection({
  title,
  isOpen,
  onToggle,
  badge,
  headerActions,
  children,
}: {
  title: string;
  isOpen: boolean;
  onToggle: () => void;
  badge?: number;
  headerActions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      ...getReviewCardStyle({ background: 'var(--review-toolbar-bg)' }),
      marginBottom: 'var(--space-3)',
      padding: 'var(--space-2) var(--space-3)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
        <button
          type="button"
          onClick={onToggle}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
            width: '100%',
            padding: 'var(--space-1) 0',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            fontSize: 'var(--text-xs)',
            fontWeight: 600,
            fontFamily: 'var(--font-sans)',
            color: 'var(--text-primary)',
            textAlign: 'left',
            minWidth: 0,
            flex: 1,
          }}
        >
          {/* Chevron */}
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{
              transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
              transition: 'transform var(--transition-fast)',
              flexShrink: 0,
            }}
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
          {title}
          {badge !== undefined && badge > 0 && (
            <span style={{
              padding: '0 var(--space-1)',
              borderRadius: 'var(--radius-full)',
              background: 'var(--review-chip-neutral-bg)',
              fontSize: 9,
              color: 'var(--text-secondary)',
              fontWeight: 500,
              minWidth: 16,
              textAlign: 'center',
            }}>
              {badge}
            </span>
          )}
        </button>
        {headerActions && (
          <div onClick={(event) => event.stopPropagation()} style={{ minWidth: 0 }}>
            {headerActions}
          </div>
        )}
      </div>
      {isOpen && (
        <div style={{ marginTop: 'var(--space-2)' }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ── ProgressPill ────────────────────────────────────────────────────────

export function ProgressPill({
  currentChunk,
  totalChunks,
  filesCompleted,
  totalFiles,
  progressPercent,
  phase,
  activeChunkFiles,
  elapsedSeconds,
  splitDepth,
  splitParts,
  agenticToolSummary,
  agentName,
  diffScopeMode,
  diffScopeCommitCount,
  diffBaseSha,
  diffHeadSha,
  prRequestedMode,
  prEffectiveMode,
  prPipelineMode,
  totalPrFiles,
  effectiveReviewFiles,
  metaLabelOverride,
  activityLabelOverride,
  flushTop = false,
}: {
  currentChunk: number;
  totalChunks: number;
  filesCompleted: number;
  totalFiles: number;
  progressPercent: number;
  phase?: string;
  activeChunkFiles?: number;
  elapsedSeconds?: number;
  splitDepth?: number;
  splitParts?: number;
  agenticToolSummary?: string | null;
  agentName?: string | null;
  diffScopeMode?: 'full' | 'delta' | null;
  diffScopeCommitCount?: number;
  diffBaseSha?: string | null;
  diffHeadSha?: string | null;
  prRequestedMode?: 'auto' | 'full' | 'agentic_discovery' | null;
  prEffectiveMode?: 'auto' | 'full' | 'agentic_discovery' | null;
  prPipelineMode?: 'standard' | 'agentic_discovery' | null;
  totalPrFiles?: number;
  effectiveReviewFiles?: number;
  metaLabelOverride?: string | null;
  activityLabelOverride?: string | null;
  flushTop?: boolean;
}) {
  const formatElapsedDuration = (totalSeconds: number): string => {
    const safeSeconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
    if (safeSeconds < 60) return `${safeSeconds}s`;
    if (safeSeconds < 3600) {
      const minutes = Math.floor(safeSeconds / 60);
      const seconds = safeSeconds % 60;
      return `${minutes}m ${seconds}s`;
    }
    const hours = Math.floor(safeSeconds / 3600);
    const minutes = Math.floor((safeSeconds % 3600) / 60);
    const seconds = safeSeconds % 60;
    return `${hours}h ${minutes}m ${seconds}s`;
  };

  // Client-side tick: increment elapsed time locally every second between
  // server heartbeats so the timer doesn't appear frozen.  Resyncs when a
  // new server value arrives via the elapsedSeconds prop.
  const serverElapsed = Number(elapsedSeconds) || 0;
  const [displayElapsed, setDisplayElapsed] = useState(serverElapsed);
  const lastServerRef = useRef(serverElapsed);

  useEffect(() => {
    // Resync when server sends a new value
    if (serverElapsed !== lastServerRef.current) {
      lastServerRef.current = serverElapsed;
      setDisplayElapsed(serverElapsed);
    }
  }, [serverElapsed]);

  useEffect(() => {
    const id = setInterval(() => {
      setDisplayElapsed((prev) => prev + 1);
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Agentic mode: show live activity feed instead of chunk-based progress
  const isAgenticPhase = phase === 'agentic_exploration' || phase === 'agentic_tool_use';
  const diffScopeSummary = getDiffScopeSummaryFromStats({
    diffScopeMode: diffScopeMode || undefined,
    diffScopeCommitCount,
    diffBaseSha,
    diffHeadSha,
    totalChangedFiles: totalFiles,
  }, totalFiles);

  if (isAgenticPhase) {
    const elapsedLabel = displayElapsed >= 0
      ? formatElapsedDuration(displayElapsed)
      : null;
    const toolLabel = typeof activityLabelOverride === 'string' && activityLabelOverride.trim()
      ? activityLabelOverride.trim()
      : typeof agenticToolSummary === 'string' && agenticToolSummary.trim()
        ? agenticToolSummary.trim()
        : `${agentName || 'Agent'} is exploring the codebase\u2026`;
    const scopeMetaLabel = (() => {
      const scopeCount = Math.max(0, Number(effectiveReviewFiles || totalFiles) || 0);
      const prCount = Math.max(0, Number(totalPrFiles || 0) || 0);
      if (prCount > 0 && scopeCount > 0 && prCount > scopeCount) {
        return `${scopeCount} of ${prCount} files in scope`;
      }
      if (!diffScopeSummary) {
        return totalFiles > 0 ? `${totalFiles} files in scope` : null;
      }
      const trimmed = diffScopeSummary.longLabel.replace(/^(Incremental|Full) review · /, '');
      return trimmed === diffScopeSummary.longLabel ? null : trimmed;
    })();
    const reviewModeLabel = (() => {
      if (prEffectiveMode === 'agentic_discovery' || prPipelineMode === 'agentic_discovery') {
        return 'agentic discovery review';
      }
      if (prEffectiveMode === 'full' || prPipelineMode === 'standard' || prRequestedMode === 'full') {
        return 'standard review';
      }
      return 'review';
    })();
    const metaParts = metaLabelOverride
      ? [metaLabelOverride]
      : [
      diffScopeSummary
        ? `${agentName || 'Agentic'} ${reviewModeLabel} · ${diffScopeSummary.shortLabel.toLowerCase()}`
        : `${agentName || 'Agentic'} ${reviewModeLabel}`,
      scopeMetaLabel,
      elapsedLabel,
    ].filter(Boolean);

    return (
      <div style={{ marginTop: flushTop ? 0 : '-8px', marginBottom: 'var(--space-2)' }}>
        <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginBottom: 4 }}>
          {metaParts.join(' \u2022 ')}
        </div>
        <div style={{
          fontSize: 11,
          color: 'var(--text-secondary)',
          padding: '4px 8px',
          background: 'var(--bg-overlay)',
          borderRadius: 'var(--radius-sm)',
          fontFamily: 'var(--font-mono, monospace)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          maxWidth: '100%',
        }}>
          {toolLabel}
        </div>
        <div style={{
          width: '100%',
          height: 4,
          background: 'var(--bg-overlay)',
          borderRadius: 999,
          overflow: 'hidden',
          marginTop: 4,
        }}>
          <div style={{
            width: '100%',
            height: '100%',
            background: 'var(--accent-blue)',
            opacity: 0.6,
            animation: 'pulse 2s ease-in-out infinite',
          }} />
        </div>
      </div>
    );
  }

  const safeTotalChunks = totalChunks > 0 ? totalChunks : 1;
  const chunkLabel = safeTotalChunks > 1 ? `Chunk ${Math.max(currentChunk, 1)}/${safeTotalChunks}` : 'Processing';
  const fileLabel = totalFiles > 0 ? `${filesCompleted} of ${totalFiles} files reviewed` : 'Preparing files';
  const chunkSizeLabel = activeChunkFiles && activeChunkFiles > 0 ? `${activeChunkFiles} in-flight` : null;
  const elapsedLabel = displayElapsed >= 0
    ? formatElapsedDuration(displayElapsed)
    : null;
  const splitLabel = splitDepth && splitDepth > 0 ? `split d${splitDepth}${splitParts ? ` x${splitParts}` : ''}` : null;
  const phaseLabel = phase === 'preparing_files'
    ? 'Preparing diff\u2026'
    : phase === 'file_triage'
      ? 'Triaging files\u2026'
    : phase === 'file_review_start' || phase === 'file_review_inflight'
      ? 'Reviewing files\u2026'
    : phase === 'file_review_failed' || phase === 'file_partial'
      ? 'Partial coverage\u2026'
    : phase === 'chunk_split'
      ? 'Retrying with smaller chunks\u2026'
    : phase?.includes('complete')
      ? 'Synthesizing\u2026'
      : 'Analyzing\u2026';
  const metaParts = [
    diffScopeSummary?.longLabel || null,
    chunkLabel,
    fileLabel,
    chunkSizeLabel,
    splitLabel,
    phaseLabel,
    elapsedLabel,
  ].filter(Boolean);

  return (
    <div style={{ marginTop: flushTop ? 0 : '-8px', marginBottom: 'var(--space-2)' }}>
      <div style={{ ...getReviewMetaTextStyle({ mono: true }), marginBottom: 6 }}>
        {metaParts.join(' \u2022 ')}
      </div>
      <div style={{
        width: '100%',
        height: 6,
        background: 'var(--review-control-muted-bg)',
        borderRadius: 999,
        overflow: 'hidden',
      }}>
        <div style={{
          width: `${Math.max(5, Math.min(progressPercent, 100))}%`,
          height: '100%',
          background: 'var(--accent-blue)',
          transition: 'width 180ms ease',
        }} />
      </div>
    </div>
  );
}

// ── NoReviewSection ─────────────────────────────────────────────────────

export function NoReviewSection({
  isReviewing,
  isQueued,
  onReviewNow,
  onStopReview,
  statusLabel = null,
  runActionLabel = 'Run Review',
  stopActionLabel = 'Stop Review',
  showReviewButton = true,
  idleHint = null,
  contextHintTitle = null,
  contextHintDetail = null,
  error,
  isFailedReview,
  failedReviewDetail,
  isDismissingFailedReview,
  onRetryFailedReview,
  onDismissFailedReview,
  progress,
  runActionDisabled = false,
  runActionDisabledReason = null,
}: {
  isReviewing: boolean;
  isQueued: boolean;
  onReviewNow: () => void;
  onStopReview?: () => void;
  statusLabel?: string | null;
  runActionLabel?: string;
  stopActionLabel?: string;
  showReviewButton?: boolean;
  idleHint?: string | null;
  contextHintTitle?: string | null;
  contextHintDetail?: string | null;
  error: string | null;
  isFailedReview: boolean;
  failedReviewDetail: string;
  isDismissingFailedReview: boolean;
  onRetryFailedReview: () => void;
  onDismissFailedReview: () => void;
  progress: {
    phase?: string;
    currentChunk: number;
    totalChunks: number;
    filesCompleted: number;
    totalFiles: number;
    activeChunkFiles?: number;
    elapsedSeconds?: number;
    splitDepth?: number;
    splitParts?: number;
    agenticToolSummary?: string | null;
    agentName?: string | null;
    diffScopeMode?: 'full' | 'delta' | null;
    diffScopeCommitCount?: number;
    diffBaseSha?: string | null;
    diffHeadSha?: string | null;
  } | null;
  runActionDisabled?: boolean;
  runActionDisabledReason?: string | null;
}) {
  // Preserve prop contract for call sites even when stop action is hidden in this section.
  void onStopReview;

  const totalFiles = progress?.totalFiles || 0;
  const filesCompleted = Math.min(progress?.filesCompleted || 0, totalFiles);
  const primaryContentWidth = 'min(100%, 560px)';
  const secondaryContentWidth = 'min(100%, 420px)';
  const percent = computeProgressPercent({
    phase: progress?.phase,
    filesCompleted,
    totalFiles,
    currentChunk: progress?.currentChunk,
    totalChunks: progress?.totalChunks,
    activeChunkFiles: progress?.activeChunkFiles,
    isRunActive: isQueued || isReviewing,
    isLifecycleTerminal: !isQueued && !isReviewing,
  });
  const effectiveStatusLabel = statusLabel || (isQueued ? 'Queued for review...' : isReviewing ? 'AI is reviewing...' : 'Not reviewed yet');

  return (
    <div style={{
      ...getReviewCardStyle({ background: 'var(--review-toolbar-bg)' }),
      padding: 'var(--space-4)',
      textAlign: 'center',
    }}>
      <div style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 40,
        height: 40,
        borderRadius: '50%',
        background: 'var(--chip-ai-bg)',
        marginBottom: 'var(--space-3)',
      }}>
        {isReviewing ? (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent-purple)" strokeWidth="2" style={{ animation: 'spin 1s linear infinite' }}>
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83" />
          </svg>
        ) : (
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent-purple)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2L2 7l10 5 10-5-10-5z" />
            <path d="M2 17l10 5 10-5" />
            <path d="M2 12l10 5 10-5" />
          </svg>
        )}
      </div>
      <p style={{
        fontSize: 'var(--text-xs)',
        color: 'var(--text-secondary)',
        width: primaryContentWidth,
        margin: '0 auto var(--space-3)',
        marginBottom: 'var(--space-3)',
      }}>
        {effectiveStatusLabel}
      </p>
      {(isQueued || isReviewing) && progress && (
        <div style={{ width: primaryContentWidth, margin: '0 auto var(--space-3)' }}>
          <ProgressPill
            currentChunk={progress.currentChunk}
            totalChunks={progress.totalChunks}
            filesCompleted={filesCompleted}
            totalFiles={totalFiles}
            progressPercent={percent}
            phase={progress.phase}
            activeChunkFiles={progress.activeChunkFiles}
            elapsedSeconds={progress.elapsedSeconds}
            splitDepth={progress.splitDepth}
            splitParts={progress.splitParts}
            agenticToolSummary={progress.agenticToolSummary}
            agentName={progress.agentName}
            diffScopeMode={progress.diffScopeMode || null}
            diffScopeCommitCount={progress.diffScopeCommitCount || 0}
            diffBaseSha={progress.diffBaseSha || null}
            diffHeadSha={progress.diffHeadSha || null}
          />
        </div>
      )}
      {(contextHintTitle || contextHintDetail) && (
        <div style={{
          margin: '0 auto var(--space-3)',
          width: secondaryContentWidth,
          textAlign: 'left',
          border: '1px solid var(--chip-info-border)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--chip-info-bg)',
          padding: 'var(--space-2)',
          display: 'grid',
          gap: 4,
        }}>
          {contextHintTitle && (
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent-blue)' }}>
              {contextHintTitle}
            </div>
          )}
          {contextHintDetail && (
            <div style={{ fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
              {contextHintDetail}
            </div>
          )}
        </div>
      )}
      {error && (
        <p style={{
          fontSize: 10,
          color: 'var(--accent-red)',
          marginBottom: 'var(--space-2)',
        }}>
          {error}
        </p>
      )}
      {isFailedReview && (
        <div style={{
          margin: '0 auto var(--space-3)',
          width: secondaryContentWidth,
          textAlign: 'left',
          border: '1px solid var(--chip-error-border)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--chip-error-bg)',
          padding: 'var(--space-2)',
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent-red)', marginBottom: 4 }}>
            &#9888; Review failed
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 'var(--space-2)' }}>
            {failedReviewDetail}
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)' }}>
            <button
              type="button"
              onClick={onRetryFailedReview}
              disabled={isReviewing || isQueued}
              style={{
                padding: '2px var(--space-2)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--accent-blue)',
                background: 'transparent',
                color: 'var(--accent-blue)',
                cursor: (isReviewing || isQueued) ? 'wait' : 'pointer',
                fontSize: 10,
                fontFamily: 'var(--font-sans)',
              }}
            >
              Retry Review
            </button>
            <button
              type="button"
              onClick={onDismissFailedReview}
              disabled={isDismissingFailedReview}
              style={{
                padding: '2px var(--space-2)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-muted)',
                background: 'transparent',
                color: isDismissingFailedReview ? 'var(--text-tertiary)' : 'var(--text-secondary)',
                cursor: isDismissingFailedReview ? 'wait' : 'pointer',
                fontSize: 10,
                fontFamily: 'var(--font-sans)',
              }}
            >
              {isDismissingFailedReview ? 'Dismissing...' : 'Dismiss'}
            </button>
          </div>
        </div>
      )}
      {!isFailedReview && showReviewButton && (isQueued || isReviewing) && onStopReview && (
        <button
          type="button"
          onClick={onStopReview}
          style={{
            padding: 'var(--space-1) var(--space-3)',
            fontSize: 'var(--text-xs)',
            fontFamily: 'var(--font-sans)',
            fontWeight: 500,
            color: 'var(--accent-red)',
            background: 'transparent',
            border: '1px solid var(--accent-red)',
            borderRadius: 'var(--radius-md)',
            cursor: 'pointer',
          }}
        >
          {stopActionLabel}
        </button>
      )}
      {!isFailedReview && showReviewButton && !(isQueued || isReviewing) && (
        <button
          type="button"
          disabled={runActionDisabled}
          title={runActionDisabled ? (runActionDisabledReason || undefined) : undefined}
          onClick={onReviewNow}
          style={{
            padding: 'var(--space-1) var(--space-3)',
            fontSize: 'var(--text-xs)',
            fontFamily: 'var(--font-sans)',
            fontWeight: 500,
            color: 'var(--accent-purple)',
            background: 'var(--chip-ai-bg)',
            border: 'none',
            borderRadius: 'var(--radius-md)',
            cursor: runActionDisabled ? 'not-allowed' : 'pointer',
            opacity: runActionDisabled ? 0.6 : 1,
            transition: 'opacity var(--transition-fast)',
          }}
        >
          {runActionLabel}
        </button>
      )}
      {!isFailedReview && !showReviewButton && idleHint && (
        <p style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 'var(--space-2)' }}>
          {idleHint}
        </p>
      )}
    </div>
  );
}

const ANALYTICS_TONE_STYLES: Record<'default' | 'good' | 'warn' | 'critical' | 'info', { border: string; background: string; value: string }> = {
  default: {
    border: 'var(--border-muted)',
    background: 'var(--bg-overlay)',
    value: 'var(--text-primary)',
  },
  good: {
    border: 'var(--accent-green)',
    background: 'var(--chip-success-bg)',
    value: 'var(--accent-green)',
  },
  warn: {
    border: 'var(--accent-yellow)',
    background: 'var(--chip-warning-bg)',
    value: 'var(--accent-yellow)',
  },
  critical: {
    border: 'var(--accent-red)',
    background: 'var(--chip-error-bg)',
    value: 'var(--accent-red)',
  },
  info: {
    border: 'var(--accent-blue)',
    background: 'var(--chip-info-bg)',
    value: 'var(--accent-blue)',
  },
};

export function AnalyticsMetricGrid({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
      gap: 'var(--space-2)',
    }}>
      {children}
    </div>
  );
}

export function AnalyticsMetricCard({
  label,
  value,
  detail,
  tone = 'default',
}: {
  label: string;
  value: string;
  detail: string;
  tone?: 'default' | 'good' | 'warn' | 'critical' | 'info';
}) {
  const style = ANALYTICS_TONE_STYLES[tone] || ANALYTICS_TONE_STYLES.default;
  return (
    <div style={{
      display: 'grid',
      gap: 'var(--space-1)',
      padding: 'var(--space-2)',
      borderRadius: 'var(--radius-md)',
      border: `1px solid ${style.border}`,
      background: style.background,
      minWidth: 0,
    }}>
      <span style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: 0.4,
        textTransform: 'uppercase',
        color: 'var(--text-tertiary)',
      }}>
        {label}
      </span>
      <span style={{
        fontSize: 'var(--text-lg)',
        fontWeight: 700,
        color: style.value,
        lineHeight: 1.1,
      }}>
        {value}
      </span>
      <span style={{
        fontSize: 10,
        color: 'var(--text-secondary)',
        lineHeight: 1.35,
      }}>
        {detail}
      </span>
    </div>
  );
}
