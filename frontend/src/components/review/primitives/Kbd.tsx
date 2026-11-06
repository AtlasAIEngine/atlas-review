import type { ReactNode } from 'react';

interface KbdProps {
  children: ReactNode;
  tone?: 'default' | 'onPrimary';
}

/**
 * Compact keycap pill for keyboard shortcut hints. Mono 10px, tabular-nums,
 * muted border on the surface background.
 */
export function Kbd({ children, tone = 'default' }: KbdProps) {
  const onPrimary = tone === 'onPrimary';
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        padding: '1px 5px',
        border: onPrimary ? '1px solid rgba(12, 13, 14, 0.35)' : '1px solid var(--border-default)',
        borderRadius: 3,
        color: onPrimary ? '#0c0d0e' : 'var(--text-secondary)',
        background: onPrimary ? 'transparent' : 'var(--bg-surface)',
        fontVariantNumeric: 'tabular-nums',
        lineHeight: 1.5,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}
