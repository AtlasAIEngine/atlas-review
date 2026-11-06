/**
 * PRLane — Direction C swim-lane container for the Pull Requests tab
 * (see `direction-c.jsx` `CLane`, lines 84–98).
 *
 * Sticky header + scrollable body. `tint` / `accent` are CSS-variable
 * tokens so the lane color follows the active theme without hex literals.
 */

import type { ReactNode } from 'react';

type LaneColorToken = 'med' | 'accent' | 'ok';

interface PRLaneProps {
  title: string;
  count: number;
  tint?: LaneColorToken;
  accent?: LaneColorToken;
  children: ReactNode;
}

function tokenToVar(token: LaneColorToken | undefined): string | null {
  if (!token) return null;
  if (token === 'med') return 'var(--sev-med)';
  if (token === 'accent') return 'var(--accent-blue)';
  if (token === 'ok') return 'var(--sev-ok)';
  return null;
}

export function PRLane({ title, count, tint, accent, children }: PRLaneProps) {
  const tintVar = tokenToVar(tint);
  const accentVar = tokenToVar(accent);
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        background: 'var(--review-panel-bg)',
      }}
    >
      <div
        style={{
          padding: '10px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          borderBottom: '1px solid var(--review-shell-divider)',
          background: tintVar
            ? `color-mix(in oklab, ${tintVar} 6%, transparent)`
            : 'transparent',
          position: 'sticky',
          top: 0,
          zIndex: 1,
        }}
      >
        {accentVar && (
          <span
            aria-hidden="true"
            style={{ width: 6, height: 6, borderRadius: 3, background: accentVar }}
          />
        )}
        <span style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--text-primary)' }}>
          {title}
        </span>
        <span
          style={{
            fontSize: 10.5,
            color: 'var(--text-tertiary)',
            fontVariantNumeric: 'tabular-nums',
            padding: '1px 6px',
            background: 'var(--bg-surface-raised)',
            borderRadius: 8,
          }}
        >
          {count}
        </span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: '10px 10px 20px' }}>{children}</div>
    </div>
  );
}
