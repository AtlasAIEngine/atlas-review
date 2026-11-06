/**
 * BranchRow — Direction C dense branch row (see
 * `/tmp/atlas-design/atlasreviewuiprototype/project/direction-c.jsx`
 * `CBranchRow`, lines 11–42).
 *
 * Visual layout: 6-col grid — severity dot / branch+base / severity
 * chips / coverage bar / adds-dels / updated time.
 */

import type { CSSProperties } from 'react';
import { SevChip } from './primitives';

export type BranchRisk = 'high' | 'med' | 'low' | 'clean';

export interface BranchRowData {
  id: string;
  name: string;
  base: string;
  high: number;
  med: number;
  low: number;
  coverage: number;
  additions: number;
  deletions: number;
  changesLabel?: string;
  updatedLabel: string;
  risk: BranchRisk;
  active?: boolean;
  isWorktree?: boolean;
  generating?: boolean;
  reviewId?: string;
  nonReviewableBranchName?: string;
  statusLabel?: string;
  statusColor?: string;
}

interface BranchRowProps {
  row: BranchRowData;
  onClick?: (row: BranchRowData) => void;
  /** When true the row renders the top divider. First row omits it. */
  withTopDivider?: boolean;
  selected?: boolean;
  onNavigate?: (row: BranchRowData, delta: number) => void;
  onFocusRow?: (row: BranchRowData) => void;
}

function riskDotColor(risk: BranchRisk): string {
  if (risk === 'high') return 'var(--sev-high)';
  if (risk === 'med') return 'var(--sev-med)';
  if (risk === 'clean') return 'var(--sev-ok)';
  return 'var(--text-tertiary)';
}

function BranchSkeletonBar({
  width,
  height = 8,
  radius = 4,
  style,
}: {
  width: number | string;
  height?: number;
  radius?: number;
  style?: CSSProperties;
}) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'block',
        width,
        height,
        borderRadius: radius,
        background: 'linear-gradient(90deg, var(--bg-hover) 0%, var(--bg-surface-raised) 45%, var(--bg-hover) 100%)',
        opacity: 0.62,
        animation: 'skeleton-pulse 1.5s ease-in-out infinite',
        animationDelay: 'inherit',
        ...style,
      }}
    />
  );
}

export function BranchRowSkeleton({ withTopDivider = true, delayMs = 0 }: { withTopDivider?: boolean; delayMs?: number }) {
  return (
    <div
      aria-hidden="true"
      data-branch-row-skeleton="true"
      style={{
        display: 'grid',
        gridTemplateColumns: '20px 1fr 150px 130px 100px 90px',
        gap: 14,
        padding: '11px 14px',
        alignItems: 'center',
        borderTop: withTopDivider ? '1px solid var(--review-shell-divider)' : 'none',
        borderLeft: '2px solid transparent',
        fontSize: 12,
        animationDelay: `${delayMs}ms`,
      }}
    >
      <BranchSkeletonBar width={8} height={8} radius={4} />
      <div style={{ minWidth: 0 }}>
        <BranchSkeletonBar width="44%" height={11} style={{ marginBottom: 7 }} />
        <BranchSkeletonBar width="28%" height={9} />
      </div>
      <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
        <BranchSkeletonBar width={52} height={18} radius={3} />
        <BranchSkeletonBar width={44} height={18} radius={3} />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <BranchSkeletonBar width="100%" height={3} radius={2} />
        <BranchSkeletonBar width={24} height={9} style={{ flexShrink: 0 }} />
      </div>
      <BranchSkeletonBar width={58} height={10} />
      <BranchSkeletonBar width={42} height={10} />
    </div>
  );
}

export function BranchRow({ row, onClick, withTopDivider = true, selected = false, onNavigate, onFocusRow }: BranchRowProps) {
  const rowStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: '20px 1fr 150px 130px 100px 90px',
    gap: 14,
    padding: '11px 14px',
    alignItems: 'center',
    borderTop: withTopDivider ? '1px solid var(--review-shell-divider)' : 'none',
    fontSize: 12,
    cursor: onClick ? 'pointer' : 'default',
    background: selected
      ? 'var(--bg-hover)'
      : row.active
      ? 'color-mix(in oklab, var(--accent-blue) 6%, transparent)'
      : 'transparent',
    borderLeft: row.active
      ? '2px solid var(--accent-blue)'
      : '2px solid transparent',
    transition: 'background var(--transition-fast)',
  };

  const cleanRow = row.high === 0 && row.med === 0 && row.low === 0;

  return (
    <div
      role="button"
      tabIndex={onClick ? 0 : -1}
      data-branch-row-id={row.id}
      onClick={() => onClick?.(row)}
      onFocus={() => onFocusRow?.(row)}
      onKeyDown={(e) => {
        if (!onClick) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick(row);
          return;
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'j' || e.key === 'J' || e.key === 'k' || e.key === 'K') {
          e.preventDefault();
          onNavigate?.(row, e.key === 'ArrowUp' || e.key.toLowerCase() === 'j' ? -1 : 1);
        }
      }}
      style={rowStyle}
      onMouseEnter={(e) => {
        if (!row.active && !selected && onClick) {
          e.currentTarget.style.background = 'var(--bg-hover)';
        }
      }}
      onMouseLeave={(e) => {
        if (!row.active && onClick) {
          e.currentTarget.style.background = selected ? 'var(--bg-hover)' : 'transparent';
        }
      }}
    >
      {/* Risk dot */}
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: 4,
          background: riskDotColor(row.risk),
          display: 'inline-block',
        }}
        aria-hidden="true"
      />

      {/* Branch + base */}
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <div
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 11.5,
              fontWeight: row.active ? 600 : 500,
              color: 'var(--text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
            }}
          >
            {row.name}
          </div>
          {row.active && (
            <span
              style={{
                flexShrink: 0,
                padding: '1px 6px',
                borderRadius: 999,
                border: '1px solid color-mix(in oklab, var(--accent-blue) 44%, transparent)',
                background: 'color-mix(in oklab, var(--accent-blue) 12%, transparent)',
                color: 'var(--accent-blue)',
                fontSize: 9.5,
                fontFamily: 'var(--font-mono)',
                fontWeight: 700,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
              }}
            >
              HEAD
            </span>
          )}
          {row.isWorktree && (
            <span
              style={{
                flexShrink: 0,
                padding: '1px 6px',
                borderRadius: 999,
                border: '1px solid var(--review-shell-divider)',
                background: 'var(--bg-surface-raised)',
                color: 'var(--text-tertiary)',
                fontSize: 9.5,
                fontFamily: 'var(--font-mono)',
                fontWeight: 700,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
              }}
            >
              WORKTREE
            </span>
          )}
        </div>
        <div
          style={{
            fontSize: 10.5,
            color: 'var(--text-tertiary)',
            fontFamily: 'var(--font-mono)',
            marginTop: 2,
          }}
        >
          {'\u21af'} {row.base}
        </div>
      </div>

      {/* Severity chips */}
      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
        {row.high > 0 && <SevChip level="HIGH" count={row.high} />}
        {row.med > 0 && <SevChip level="MED" count={row.med} />}
        {row.low > 0 && <SevChip level="LOW" count={row.low} />}
        {row.generating && (
          <span
            style={{
              fontSize: 10.5,
              color: 'var(--accent-blue)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 5,
              padding: '2px 6px',
              border: '1px solid color-mix(in oklab, var(--accent-blue) 35%, transparent)',
              borderRadius: 3,
            }}
          >
            <span
              style={{
                width: 5,
                height: 5,
                borderRadius: 3,
                background: 'var(--accent-blue)',
                animation: 'atlas-pulse 1.2s ease-in-out infinite',
              }}
            />
            Reviewing
          </span>
        )}
        {row.statusLabel && (
          <span
            style={{
              fontSize: 11,
              color: row.statusColor || 'var(--text-tertiary)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            {row.statusLabel}
          </span>
        )}
        {cleanRow && !row.generating && !row.statusLabel && (
          <span
            style={{
              fontSize: 11,
              color: 'var(--sev-ok)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
            }}
          >
            {'\u2713'} Clean
          </span>
        )}
      </div>

      {/* Coverage */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div
          style={{
            flex: 1,
            height: 3,
            background: 'var(--border-muted)',
            borderRadius: 2,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              width: `${Math.max(0, Math.min(100, row.coverage))}%`,
              height: '100%',
              background: row.coverage >= 90 ? 'var(--accent-blue)' : 'var(--sev-med)',
            }}
          />
        </div>
        <span style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)', color: 'var(--text-tertiary)' }}>
          {row.coverage}%
        </span>
      </div>

      {/* Adds/dels */}
      <div style={{ fontSize: 10.5, fontFamily: 'var(--font-mono)' }}>
        {row.changesLabel ? (
          <span style={{ color: 'var(--text-tertiary)' }}>{row.changesLabel}</span>
        ) : (
          <>
            <span style={{ color: 'var(--sev-ok)' }}>+{row.additions}</span>{' '}
            <span style={{ color: 'var(--sev-high)' }}>{'\u2212'}{row.deletions}</span>
          </>
        )}
      </div>

      {/* Updated */}
      <div style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>{row.updatedLabel}</div>
    </div>
  );
}
