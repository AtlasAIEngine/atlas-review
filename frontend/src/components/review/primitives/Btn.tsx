import { useEffect, useState } from 'react';
import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';

export type BtnVariant = 'primary' | 'ghost' | 'subtle' | 'bare';
export type BtnSize = 'sm' | 'md';

interface BtnProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'style'> {
  children: ReactNode;
  variant?: BtnVariant;
  size?: BtnSize;
  /**
   * Optional accent hex/colour override for the `primary` variant fill.
   * When omitted, uses the themed review primary action tokens.
   */
  accent?: string;
  style?: CSSProperties;
}

/**
 * Read a CSS custom property from `<html>` at runtime so theme switches update
 * inline styles that need concrete color values.
 */
export function useAccent(varName: string): string {
  const [value, setValue] = useState<string>('');
  useEffect(() => {
    const read = () => {
      const raw = getComputedStyle(document.documentElement).getPropertyValue(varName);
      setValue(raw.trim());
    };
    read();
    // Observe class flips on <html> so dark/light switches re-read the accent.
    const observer = new MutationObserver(read);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] });
    return () => observer.disconnect();
  }, [varName]);
  return value;
}

/**
 * Direction C button. Matches prototype dimensions: sm = 26px / 11.5px font,
 * md = 30px / 12.5px font, radius 5px.
 *
 * - `primary`: fills with themed action tokens; foreground is theme-specific
 *   so light mode can use a deeper blue without losing contrast.
 * - `ghost`: transparent with a default border.
 * - `subtle`: surface-raised fill, no border.
 * - `bare`: text-only button.
 */
export function Btn({
  children,
  variant = 'ghost',
  size = 'md',
  accent,
  style,
  ...rest
}: BtnProps) {
  const themedPrimaryBg = useAccent('--review-primary-action-bg');
  const themedPrimaryBorder = useAccent('--review-primary-action-border');
  const themedPrimaryFg = useAccent('--review-primary-action-fg');
  const resolvedAccent = accent || themedPrimaryBg || 'var(--review-primary-action-bg)';
  const resolvedPrimaryBorder = accent || themedPrimaryBorder || resolvedAccent;
  const resolvedPrimaryFg = themedPrimaryFg || 'var(--review-primary-action-fg)';

  const height = size === 'sm' ? 26 : 30;
  const px = size === 'sm' ? 10 : 12;

  const base: CSSProperties = {
    height,
    padding: `0 ${px}px`,
    borderRadius: 5,
    fontFamily: 'var(--font-ui)',
    fontSize: size === 'sm' ? 11.5 : 12.5,
    fontWeight: 500,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    cursor: rest.disabled ? 'not-allowed' : 'pointer',
    border: '1px solid transparent',
    transition: 'background var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast)',
    whiteSpace: 'nowrap',
    opacity: rest.disabled ? 0.55 : 1,
  };

  const variants: Record<BtnVariant, CSSProperties> = {
    primary: {
      background: resolvedAccent,
      color: resolvedPrimaryFg,
      borderColor: resolvedPrimaryBorder,
    },
    ghost: {
      background: 'transparent',
      color: 'var(--text-primary)',
      borderColor: 'var(--border-default)',
    },
    subtle: {
      background: 'var(--bg-surface-raised)',
      color: 'var(--text-primary)',
      borderColor: 'transparent',
    },
    bare: {
      background: 'transparent',
      color: 'var(--text-secondary)',
      borderColor: 'transparent',
    },
  };

  return (
    <button type="button" {...rest} style={{ ...base, ...variants[variant], ...style }}>
      {children}
    </button>
  );
}
