/**
 * Compact CodeGraph status pill for the project header.
 *
 * Renders the at-a-glance per-project state the user asked for in the
 * plan: "show me on a project level whether that codegraph has been
 * initialized for that specific project or not."
 *
 * Self-polls while `state === 'indexing'` so the badge advances without
 * the parent having to manage timers. Idle when the latest row is
 * terminal (ready/error/stale) or there's no row at all.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { codegraphApi, type CodegraphStatus } from '@/services/codegraphApi';

interface CodegraphStatusBadgeProps {
  projectId: string;
  /** Polling interval while indexing, in ms. Default 1500. */
  pollMs?: number;
  /** Style override for inline placement. */
  style?: React.CSSProperties;
  /** Click handler — typically opens the settings modal to the CodeGraph section. */
  onClick?: () => void;
}

function formatBytes(bytes: number | null): string {
  if (!bytes || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function pillStyles(tone: 'idle' | 'progress' | 'ready' | 'error'): React.CSSProperties {
  const palette = {
    idle: { bg: 'var(--bg-secondary, #2a2a2a)', fg: 'var(--text-secondary, #aaa)', border: 'var(--border-default, #3a3a3a)' },
    progress: { bg: 'rgba(59, 130, 246, 0.12)', fg: '#60a5fa', border: 'rgba(59, 130, 246, 0.35)' },
    ready: { bg: 'rgba(34, 197, 94, 0.12)', fg: '#4ade80', border: 'rgba(34, 197, 94, 0.35)' },
    error: { bg: 'rgba(239, 68, 68, 0.12)', fg: '#f87171', border: 'rgba(239, 68, 68, 0.35)' },
  };
  const colors = palette[tone];
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '2px 8px',
    fontSize: 11,
    fontWeight: 500,
    borderRadius: 999,
    background: colors.bg,
    color: colors.fg,
    border: `1px solid ${colors.border}`,
    whiteSpace: 'nowrap',
    cursor: 'pointer',
    userSelect: 'none',
  };
}

export const CodegraphStatusBadge: React.FC<CodegraphStatusBadgeProps> = ({
  projectId,
  pollMs = 1500,
  style,
  onClick,
}) => {
  const [status, setStatus] = useState<CodegraphStatus | null>(null);
  const cancelledRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchOnce = useCallback(async () => {
    if (!projectId || cancelledRef.current) return null;
    try {
      const next = await codegraphApi.getStatus(projectId);
      if (!cancelledRef.current) setStatus(next);
      return next;
    } catch {
      // Soft-fail — leave the badge in its last known state rather than
      // flashing an error pill on every transient network blip.
      return null;
    }
  }, [projectId]);

  // One-shot fetch on mount / project switch.
  useEffect(() => {
    cancelledRef.current = false;
    void fetchOnce();
    return () => {
      cancelledRef.current = true;
    };
  }, [fetchOnce]);

  // State-driven polling: poll until state leaves 'indexing'. Reacting to
  // the state value (not just fetchOnce identity) means transitions caused
  // *outside* this component (e.g. the Settings modal toggling ON) trigger
  // polling here too.
  useEffect(() => {
    if (status?.index?.state !== 'indexing') return;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      await fetchOnce();
      if (stopped) return;
      timerRef.current = setTimeout(tick, pollMs);
    };
    timerRef.current = setTimeout(tick, pollMs);
    return () => {
      stopped = true;
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [status?.index?.state, fetchOnce, pollMs]);

  if (!status) return null;

  const { enabled, index } = status;

  // Resolve tone + label + tooltip from the spec/status pair.
  let tone: 'idle' | 'progress' | 'ready' | 'error' = 'idle';
  let label = 'CodeGraph: off';
  let tooltip = 'CodeGraph is off for this project. Open Settings → Review → Policy File to enable it.';

  if (!status.cliAvailable) {
    tone = 'error';
    label = 'CodeGraph: CLI missing';
    tooltip = 'CodeGraph CLI not found on PATH. Install with `npm i -g @colbymchenry/codegraph`.';
  } else if (!enabled && !index) {
    tone = 'idle';
    label = 'CodeGraph: off';
  } else if (!enabled && index?.state === 'ready') {
    tone = 'idle';
    label = 'CodeGraph: ready (off)';
    tooltip = 'Index is built and ready, but the toggle is OFF — reviews are not using it.';
  } else if (index?.state === 'indexing') {
    tone = 'progress';
    const pct = index.totalFiles > 0
      ? Math.min(99, Math.round((index.filesIndexed / index.totalFiles) * 100))
      : null;
    label = pct != null ? `CodeGraph: indexing ${pct}%` : 'CodeGraph: indexing…';
    tooltip = `Building index — ${index.filesIndexed}${index.totalFiles ? ` / ${index.totalFiles}` : ''} files processed`;
  } else if (index?.state === 'ready') {
    tone = 'ready';
    const nodeCount = index.nodes != null ? `${(index.nodes / 1000).toFixed(1)}k nodes` : null;
    const size = formatBytes(index.sizeBytes);
    const detail = [nodeCount, size].filter(Boolean).join(' · ');
    label = detail ? `CodeGraph: ready · ${detail}` : 'CodeGraph: ready';
    tooltip = [
      `Index ready at SHA ${index.worktreeSha?.slice(0, 7) || 'unknown'}`,
      index.codegraphVersion ? `v${index.codegraphVersion.replace(/^v/, '')}` : null,
      nodeCount,
      size,
    ].filter(Boolean).join(' · ');
  } else if (index?.state === 'error') {
    tone = 'error';
    label = 'CodeGraph: error';
    tooltip = index.errorMessage || 'Index build failed. See Settings → Review → Policy File to retry.';
  } else if (enabled && (!index || index.state === 'stale')) {
    tone = 'progress';
    label = 'CodeGraph: index pending';
    tooltip = 'CodeGraph is enabled but no ready index exists. Open Settings → Review → Policy File to initialize.';
  }

  return (
    <span
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (!onClick) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      title={tooltip}
      style={{ ...pillStyles(tone), ...style }}
    >
      {label}
    </span>
  );
};

export default CodegraphStatusBadge;
