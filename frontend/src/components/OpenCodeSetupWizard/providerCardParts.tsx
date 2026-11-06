/**
 * Shared sub-components for OpenCode provider configuration UI.
 * Used by both ProviderConfigStep (wizard) and OpenCodeProvidersModal (settings).
 */

import type React from 'react';
import { getReviewActionButtonStyle } from '../review/ReviewChrome';

export interface ConfiguredProvider {
  type: string;
  hasKey: boolean;
}

// -- Expandable card --

export function ExpandableProviderCard({
  title,
  description,
  badge,
  badgeColor,
  configured,
  selected,
  expanded,
  onToggle,
  children,
}: {
  title: string;
  description: string;
  badge?: string;
  badgeColor?: string;
  configured: boolean;
  selected?: boolean;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={{
      background: expanded ? 'var(--review-card-hover)' : 'var(--review-card-bg)',
      border: `1px solid ${expanded ? 'var(--review-shell-border-strong)' : 'var(--review-shell-border)'}`,
      borderRadius: 14,
      overflow: 'hidden',
      transition: 'border-color 0.15s, background 0.15s',
    }}>
      <button type="button" onClick={onToggle} style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
        padding: 'var(--space-4)', background: 'none', border: 'none',
        cursor: 'pointer', textAlign: 'left', width: '100%',
      }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-primary)' }}>{title}</span>
            {badge && !configured && (
              <span style={{
                fontSize: 10, fontWeight: 600,
                color: badgeColor || 'var(--text-tertiary)',
                background: `${badgeColor || 'var(--text-tertiary)'}18`,
                padding: '1px 6px', borderRadius: 'var(--radius-sm)',
                textTransform: 'uppercase', letterSpacing: '0.04em',
              }}>{badge}</span>
            )}
            {configured && (
              <span style={{
                fontSize: 10, fontWeight: 600,
                color: 'var(--status-success, #22c55e)',
                background: 'var(--chip-success-bg)',
                border: '1px solid var(--chip-success-border)',
                padding: '1px 6px', borderRadius: 'var(--radius-sm)',
                textTransform: 'uppercase', letterSpacing: '0.04em',
                display: 'inline-flex', alignItems: 'center', gap: 3,
              }}>
                <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Configured
              </span>
            )}
            {configured && selected && (
              <span style={{
                fontSize: 10, fontWeight: 600,
                color: 'var(--accent-blue)',
                background: 'var(--chip-info-bg)',
                border: '1px solid var(--chip-info-border)',
                padding: '1px 6px', borderRadius: 'var(--radius-sm)',
                textTransform: 'uppercase', letterSpacing: '0.04em',
                display: 'inline-flex', alignItems: 'center', gap: 3,
              }}>
                <svg width={10} height={10} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Selected
              </span>
            )}
          </div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)', marginTop: 2 }}>{description}</div>
        </div>
        <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="var(--text-tertiary)"
          strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          style={{ flexShrink: 0, transition: 'transform 0.15s', transform: expanded ? 'rotate(90deg)' : 'none' }}>
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>

      {expanded && (
        <div style={{
          padding: '0 var(--space-4) var(--space-4)',
          display: 'flex', flexDirection: 'column', gap: 'var(--space-3)',
          borderTop: '1px solid var(--review-shell-divider)', paddingTop: 'var(--space-4)',
        }}>
          {children}
        </div>
      )}
    </div>
  );
}

// -- Save button --

export function SaveButton({
  saving, configured, disabled, onClick,
}: {
  saving: boolean; configured: boolean; disabled: boolean; onClick: () => void;
}) {
  return (
    <button type="button" onClick={onClick} disabled={saving || disabled} style={{
      ...getReviewActionButtonStyle({ tone: 'blue', active: !(saving || disabled), disabled: saving || disabled }),
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      gap: 'var(--space-2)', padding: '0 var(--space-4)',
      minHeight: 32,
      borderRadius: 10,
      fontSize: 'var(--text-sm)', fontWeight: 700,
      cursor: (saving || disabled) ? 'not-allowed' : 'pointer',
      opacity: (saving || disabled) ? 0.6 : 1, alignSelf: 'flex-start',
    }}>
      {saving ? 'Saving...' : configured ? 'Update' : 'Save'}
    </button>
  );
}

// -- Error banner --

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div style={{
      padding: 'var(--space-2) var(--space-3)', borderRadius: 'var(--radius-sm)',
      background: 'var(--chip-danger-bg)', border: '1px solid var(--chip-danger-border)',
      color: 'var(--status-error, #ef4444)', fontSize: 'var(--text-xs)',
    }}>{message}</div>
  );
}

// -- Small icons --

export function CheckIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ animation: 'spin 1s linear infinite', flexShrink: 0 }}>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" fill="none" opacity={0.25} />
      <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </svg>
  );
}

// -- Shared styles --

export const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: 'var(--space-2) var(--space-3)',
  background: 'var(--review-code-bg)',
  border: '1px solid var(--review-shell-border)',
  borderRadius: 10,
  color: 'var(--text-primary)',
  fontSize: 'var(--text-sm)',
  fontFamily: 'var(--font-mono)',
  outline: 'none',
};

export const selectStyle: React.CSSProperties = {
  ...inputStyle,
  fontFamily: 'var(--font-sans)',
  cursor: 'pointer',
  appearance: 'auto' as React.CSSProperties['appearance'],
};
