import type { CSSProperties } from 'react';
import { getReviewActionButtonStyle, getReviewToneVars } from '../review/ReviewChrome';

type SetupTone = 'neutral' | 'blue' | 'green' | 'purple' | 'yellow' | 'red';

export const SETUP_PRIMARY_FILL = '#9aafd6';
export const SETUP_PRIMARY_TEXT = '#0b0f17';

export function getSetupButtonStyle(options: {
  tone?: SetupTone;
  active?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  compact?: boolean;
} = {}): CSSProperties {
  const { tone = 'neutral', active = false, disabled = false, fullWidth = false, compact = false } = options;
  const primary = active && (tone === 'blue' || tone === 'purple' || tone === 'green');
  if (primary) {
    return {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: compact ? 6 : 8,
      minHeight: compact ? 32 : 48,
      padding: compact ? '0 12px' : '0 28px',
      borderRadius: compact ? 7 : 10,
      border: `1px solid color-mix(in srgb, ${SETUP_PRIMARY_FILL} 88%, white 0%)`,
      background: disabled ? 'var(--review-control-muted-bg)' : SETUP_PRIMARY_FILL,
      color: disabled ? 'var(--text-tertiary)' : SETUP_PRIMARY_TEXT,
      cursor: disabled ? 'not-allowed' : 'pointer',
      fontFamily: 'var(--font-sans)',
      fontSize: compact ? 11 : 'var(--text-base)',
      fontWeight: 600,
      lineHeight: 1,
      whiteSpace: 'nowrap',
      width: fullWidth ? '100%' : undefined,
      boxShadow: 'none',
      opacity: disabled ? 0.55 : 1,
      transition: 'background var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast), transform var(--transition-fast)',
    };
  }

  return {
    ...getReviewActionButtonStyle({ tone, active, disabled }),
    minHeight: compact ? 32 : 44,
    padding: compact ? '0 12px' : '0 18px',
    borderRadius: compact ? 7 : 10,
    fontSize: 'var(--text-sm)',
    fontWeight: 700,
    width: fullWidth ? '100%' : undefined,
    justifyContent: 'center',
    boxShadow: active ? 'var(--review-panel-shadow)' : undefined,
  };
}

export function getSetupTextButtonStyle(options: {
  tone?: 'muted' | 'link';
} = {}): CSSProperties {
  const { tone = 'muted' } = options;
  return {
    background: 'transparent',
    border: 'none',
    padding: 0,
    color: tone === 'link' ? SETUP_PRIMARY_FILL : 'var(--text-secondary)',
    fontSize: 'var(--text-sm)',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'color var(--transition-fast)',
  };
}

export function getSetupIconBadgeStyle(tone: SetupTone = 'blue'): CSSProperties {
  const vars = getReviewToneVars(tone);
  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 56,
    height: 56,
    borderRadius: 18,
    background: vars.bg,
    border: `1px solid ${vars.border}`,
    color: vars.text,
    boxShadow: 'var(--review-panel-shadow)',
  };
}

export function getSetupOptionCardStyle(options: {
  tone?: SetupTone;
  interactive?: boolean;
  selected?: boolean;
} = {}): CSSProperties {
  const { tone = 'neutral', interactive = false, selected = false } = options;
  const vars = getReviewToneVars(tone);

  return {
    width: '100%',
    background: selected
      ? `color-mix(in srgb, var(--review-card-bg) 82%, ${vars.bg} 18%)`
      : 'var(--review-card-bg)',
    border: `1px solid ${selected ? vars.border : 'var(--review-shell-border)'}`,
    borderRadius: 18,
    padding: 'var(--space-4)',
    boxShadow: 'var(--review-panel-shadow)',
    transition: 'border-color var(--transition-fast), background var(--transition-fast), box-shadow var(--transition-fast), transform var(--transition-fast)',
    cursor: interactive ? 'pointer' : 'default',
  };
}

export const setupSectionStyle: CSSProperties = {
  background: 'var(--review-panel-bg)',
  border: '1px solid var(--review-shell-border)',
  borderRadius: 22,
  padding: 'var(--space-5)',
  boxShadow: 'var(--review-panel-shadow)',
};

export const setupInsetPanelStyle: CSSProperties = {
  background: 'var(--review-panel-alt-bg)',
  border: '1px solid var(--review-shell-border)',
  borderRadius: 18,
  padding: 'var(--space-4)',
};

export const setupInputStyle: CSSProperties = {
  width: '100%',
  background: 'var(--review-code-bg)',
  border: '1px solid var(--review-shell-border-strong)',
  color: 'var(--text-primary)',
  borderRadius: 12,
  padding: '12px 14px',
  fontSize: 'var(--text-sm)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
};

export const setupCodeBlockStyle: CSSProperties = {
  background: 'var(--review-code-bg)',
  border: '1px solid var(--review-shell-border)',
  borderRadius: 12,
  padding: '12px 14px',
  color: 'var(--text-secondary)',
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--text-xs)',
  lineHeight: 1.5,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

export function getSetupNoticeStyle(tone: SetupTone = 'red'): CSSProperties {
  const vars = getReviewToneVars(tone);
  return {
    background: vars.bg,
    border: `1px solid ${vars.border}`,
    borderRadius: 14,
    padding: '12px 14px',
    color: vars.text,
    fontSize: 'var(--text-sm)',
  };
}
