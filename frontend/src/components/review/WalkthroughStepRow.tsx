/**
 * WalkthroughStepRow — single row in the Walkthrough left-pane
 * step list. Status icon (read / active / unread) + "N. Title" +
 * optional severity chip + mono meta line with files / +adds / -dels.
 * See direction-c.jsx:933-967.
 */

import type { KeyboardEvent } from 'react';
import { SevChip } from './primitives';
import type { SevLevel } from './primitives';

export type StepRowStatus = 'read' | 'active' | 'unread';

interface WalkthroughStepRowProps {
  index: number;
  title: string;
  status: StepRowStatus;
  files: number;
  adds: number;
  dels: number;
  read?: boolean;
  sev?: SevLevel | null;
  roleLabel?: string | null;
  onSelect: () => void;
  onNavigate?: (delta: number) => void;
}

function StatusIcon({ status, read }: { status: StepRowStatus; read: boolean }) {
  if (read) {
    return (
      <span
        style={{
          width: 14,
          height: 14,
          borderRadius: 7,
          flexShrink: 0,
          background: 'var(--sev-ok)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <svg width="9" height="9" viewBox="0 0 16 16" fill="none" stroke="var(--bg-base)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 8 6 11 13 4" />
        </svg>
      </span>
    );
  }
  if (status === 'active') {
    return (
      <span
        style={{
          width: 14,
          height: 14,
          borderRadius: 7,
          flexShrink: 0,
          border: '1.5px solid var(--accent-blue)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span
          style={{
            width: 5,
            height: 5,
            borderRadius: 3,
            background: 'var(--accent-blue)',
          }}
        />
      </span>
    );
  }
  return (
    <span
      style={{
        width: 14,
        height: 14,
        borderRadius: 7,
        flexShrink: 0,
        border: '1.5px solid var(--border-default)',
      }}
    />
  );
}

export function WalkthroughStepRow({
  index,
  title,
  status,
  files,
  adds,
  dels,
  read = false,
  sev,
  roleLabel,
  onSelect,
  onNavigate,
}: WalkthroughStepRowProps) {
  const isActive = status === 'active';
  const isRead = read || status === 'read';

  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect();
      return;
    }
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown' || event.key === 'j' || event.key === 'J' || event.key === 'k' || event.key === 'K') {
      event.preventDefault();
      onNavigate?.(event.key === 'ArrowUp' || event.key.toLowerCase() === 'j' ? -1 : 1);
    }
  };

  return (
    <div
      tabIndex={0}
      role="button"
      data-walkthrough-step-index={index}
      onClick={onSelect}
      onKeyDown={handleKey}
      style={{
        padding: '10px 18px 10px 16px',
        borderBottom: '1px solid var(--review-shell-divider)',
        borderLeft: isActive ? '2px solid var(--accent-blue)' : '2px solid transparent',
        background: isActive ? 'color-mix(in oklab, var(--accent-blue) 8%, transparent)' : 'transparent',
        cursor: 'pointer',
        display: 'grid',
        gridTemplateColumns: '14px 1fr',
        columnGap: 12,
        alignItems: 'start',
        outline: 'none',
      }}
      onFocus={(e) => { e.currentTarget.style.boxShadow = 'inset 0 0 0 1px var(--accent-blue)'; }}
      onBlur={(e) => { e.currentTarget.style.boxShadow = 'none'; }}
    >
      <div style={{ paddingTop: 3 }}>
        <StatusIcon status={status} read={isRead} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 3 }}>
          <span
            style={{
              fontSize: 13,
              fontWeight: isActive ? 600 : 500,
              lineHeight: 1.35,
              color: isRead ? 'var(--text-tertiary)' : 'var(--text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 0,
              flex: 1,
            }}
          >
            <span
              style={{
                color: 'var(--text-tertiary)',
                fontWeight: 500,
                marginRight: 6,
              }}
            >
              {index + 1}.
            </span>
            {title}
          </span>
          {roleLabel && (
            <span
              title="Step role"
              style={{
                flexShrink: 0,
                fontSize: 10,
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-tertiary)',
                border: '1px solid var(--border-default)',
                borderRadius: 4,
                padding: '1px 5px',
                background: 'var(--review-panel-bg)',
              }}
            >
              {roleLabel}
            </span>
          )}
          {sev && <SevChip level={sev} />}
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--text-tertiary)',
            fontFamily: 'var(--font-mono)',
            fontVariantNumeric: 'tabular-nums',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            minWidth: 0,
          }}
        >
          <span>{files} file{files === 1 ? '' : 's'}</span>
          <span style={{ color: 'var(--border-default)' }}>·</span>
          {adds > 0 && <span style={{ color: 'var(--sev-ok)' }}>+{adds}</span>}
          {dels > 0 && <span style={{ color: 'var(--sev-high)' }}>−{dels}</span>}
        </div>
      </div>
    </div>
  );
}
