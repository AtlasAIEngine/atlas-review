/**
 * FindingsView — Direction C left-pane container for the completed review
 * state. Renders VerdictCard at the top, then a scrollable list of
 * findings via `children`. The right pane (diff viewer) is owned by the
 * shell, not this component, so the selected-finding focus sync stays
 * where it already lives.
 */

import type { ReactNode } from 'react';
import { Kbd } from './primitives';

interface FindingsViewProps {
  verdict: ReactNode;
  children: ReactNode;
  footerAction?: ReactNode;
}

export function FindingsView({ verdict, children, footerAction = null }: FindingsViewProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        minHeight: 0,
        background: 'var(--review-panel-bg)',
      }}
    >
      <div style={{ padding: '14px 16px 0' }}>{verdict}</div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        {children}
      </div>
      {/* Shortcut footer — keys are display-only; wiring deferred. See direction-c.jsx:817-822. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 14px',
          borderTop: '1px solid var(--review-shell-divider)',
          fontSize: 10.5,
          color: 'var(--text-tertiary)',
          flexShrink: 0,
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Kbd>j</Kbd>
          <span>prev</span>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Kbd>k</Kbd>
          <span>next</span>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Kbd>a</Kbd>
          <span>address</span>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <Kbd>d</Kbd>
          <span>dismiss</span>
        </span>
        {footerAction && (
          <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center' }}>
            {footerAction}
          </span>
        )}
      </div>
    </div>
  );
}
