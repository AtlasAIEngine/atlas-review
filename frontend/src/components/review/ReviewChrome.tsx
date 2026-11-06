import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react';

type ReviewTone = 'neutral' | 'blue' | 'green' | 'red' | 'yellow' | 'purple';

type ToneVars = {
  text: string;
  bg: string;
  border: string;
};

const TONE_VARS: Record<ReviewTone, ToneVars> = {
  neutral: {
    text: 'var(--text-secondary)',
    bg: 'var(--review-chip-neutral-bg)',
    border: 'var(--review-chip-neutral-border)',
  },
  blue: {
    text: 'var(--accent-blue)',
    bg: 'var(--chip-info-bg)',
    border: 'var(--chip-info-border)',
  },
  green: {
    text: 'var(--accent-green)',
    bg: 'var(--chip-success-bg)',
    border: 'var(--chip-success-border)',
  },
  red: {
    text: 'var(--accent-red)',
    bg: 'var(--chip-error-bg)',
    border: 'var(--chip-error-border)',
  },
  yellow: {
    text: 'var(--accent-yellow)',
    bg: 'var(--chip-warning-bg)',
    border: 'var(--chip-warning-border)',
  },
  purple: {
    text: 'var(--accent-purple)',
    bg: 'var(--chip-ai-bg)',
    border: 'rgba(var(--accent-purple-rgb), 0.24)',
  },
};

export function getReviewToneVars(tone: ReviewTone = 'neutral'): ToneVars {
  return TONE_VARS[tone] || TONE_VARS.neutral;
}

export function getReviewActionButtonStyle(options: {
  tone?: ReviewTone;
  active?: boolean;
  disabled?: boolean;
} = {}): CSSProperties {
  const { tone = 'neutral', active = false, disabled = false } = options;
  const vars = getReviewToneVars(tone);

  return {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    minHeight: 30,
    padding: '0 12px',
    borderRadius: 'var(--review-control-radius)',
    border: `1px solid ${active ? vars.border : disabled ? 'var(--review-shell-border)' : vars.border}`,
    background: active ? vars.bg : disabled ? 'var(--review-control-muted-bg)' : 'var(--review-segment-bg)',
    boxShadow: active ? `inset 0 0 0 1px ${vars.border}` : 'var(--review-chip-shadow)',
    color: disabled ? 'var(--text-tertiary)' : vars.text,
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 11,
    fontFamily: 'var(--font-sans)',
    fontWeight: 700,
    letterSpacing: '0.03em',
    lineHeight: 1,
    whiteSpace: 'nowrap',
    opacity: disabled ? 0.55 : 1,
    transition: 'border-color var(--transition-fast), background var(--transition-fast), color var(--transition-fast), box-shadow var(--transition-fast), transform var(--transition-fast)',
  };
}

export function reviewSurfaceStyle(options: {
  elevated?: boolean;
  padded?: boolean;
  variant?: 'panel' | 'panelAlt' | 'card' | 'toolbar';
} = {}): CSSProperties {
  const { elevated = false, padded = true, variant = 'panel' } = options;
  const background = variant === 'panelAlt'
    ? 'var(--review-panel-alt-bg)'
    : variant === 'card'
      ? 'var(--review-card-bg)'
      : variant === 'toolbar'
        ? 'var(--review-toolbar-bg)'
        : 'var(--review-panel-bg)';
  return {
    background,
    border: `1px solid ${elevated ? 'var(--review-shell-border-strong)' : 'var(--review-shell-border)'}`,
    borderRadius: 'var(--review-card-radius)',
    boxShadow: elevated ? 'var(--review-panel-shadow)' : 'none',
    padding: padded ? 'var(--space-3)' : 0,
  };
}

export function getReviewIconButtonStyle(options: {
  active?: boolean;
  disabled?: boolean;
  compact?: boolean;
} = {}): CSSProperties {
  const { active = false, disabled = false, compact = false } = options;
  const size = compact ? 24 : 28;
  return {
    width: size,
    height: size,
    padding: 0,
    borderRadius: compact ? 8 : 10,
    border: `1px solid ${active ? 'var(--review-segment-active-border)' : 'var(--review-shell-border)'}`,
    background: active ? 'var(--review-segment-active-bg)' : 'var(--review-segment-bg)',
    color: disabled ? 'var(--text-tertiary)' : 'var(--text-secondary-bright)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    opacity: disabled ? 0.55 : 1,
    boxShadow: active ? '0 0 0 1px var(--review-selection-glow)' : 'var(--review-chip-shadow)',
    transition: 'border-color var(--transition-fast), background var(--transition-fast), color var(--transition-fast), box-shadow var(--transition-fast)',
  };
}

export function getReviewSegmentButtonStyle(options: {
  active?: boolean;
} = {}): CSSProperties {
  const { active = false } = options;
  return {
    minHeight: 28,
    padding: '0 10px',
    borderRadius: 'var(--review-control-radius)',
    border: `1px solid ${active ? 'var(--review-segment-active-border)' : 'var(--review-shell-border)'}`,
    background: active ? 'var(--review-segment-active-bg)' : 'var(--review-segment-bg)',
    color: active ? 'var(--accent-blue)' : 'var(--text-secondary)',
    fontSize: 10,
    fontWeight: 700,
    cursor: 'pointer',
    boxShadow: active ? '0 0 0 1px var(--review-selection-glow)' : 'var(--review-chip-shadow)',
    transition: 'border-color var(--transition-fast), background var(--transition-fast), color var(--transition-fast), box-shadow var(--transition-fast)',
  };
}

export function getReviewCardStyle(options: {
  selected?: boolean;
  interactive?: boolean;
  dashed?: boolean;
  expanded?: boolean;
  background?: string;
} = {}): CSSProperties {
  const { selected = false, interactive = false, dashed = false, expanded = false, background } = options;
  return {
    borderRadius: 'var(--review-card-radius)',
    background: background || (selected ? 'var(--review-card-selected-bg)' : 'var(--review-card-bg)'),
    border: `${dashed ? '1px dashed' : '1px solid'} ${selected || expanded ? 'var(--review-shell-border-strong)' : 'var(--review-shell-border)'}`,
    boxShadow: selected || expanded ? 'var(--review-panel-shadow)' : 'none',
    transition: 'background var(--transition-fast), border-color var(--transition-fast), box-shadow var(--transition-fast), transform var(--transition-fast)',
    ...(interactive ? { cursor: 'pointer' } : null),
  };
}

export function getReviewMetaTextStyle(options: {
  bright?: boolean;
  mono?: boolean;
  uppercase?: boolean;
} = {}): CSSProperties {
  const { bright = false, mono = false, uppercase = false } = options;
  return {
    fontSize: 10,
    color: bright ? 'var(--text-secondary-bright)' : 'var(--text-tertiary)',
    fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
    letterSpacing: uppercase ? '0.08em' : '0.02em',
    textTransform: uppercase ? 'uppercase' : 'none',
    lineHeight: 1.2,
  };
}

export function ReviewChip({
  children,
  tone = 'neutral',
  active = false,
  style,
  title,
}: {
  children: ReactNode;
  tone?: ReviewTone;
  active?: boolean;
  style?: CSSProperties;
  title?: string;
}) {
  const vars = getReviewToneVars(tone);
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        minHeight: 24,
        padding: '0 10px',
        borderRadius: 999,
        border: `1px solid ${active ? vars.border : vars.border}`,
        background: active ? vars.bg : vars.bg,
        color: vars.text,
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.06em',
        lineHeight: 1,
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
        boxShadow: 'var(--review-chip-shadow)',
        ...style,
      }}
    >
      {children}
    </span>
  );
}

export function ReviewActionButton({
  children,
  tone = 'neutral',
  active = false,
  disabled = false,
  style,
  ...props
}: {
  children: ReactNode;
  tone?: ReviewTone;
  active?: boolean;
  disabled?: boolean;
  style?: CSSProperties;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      disabled={disabled}
      style={{
        ...getReviewActionButtonStyle({ tone, active, disabled }),
        ...style,
      }}
      {...props}
    >
      {children}
    </button>
  );
}

export function ReviewPanelHeader({
  title,
  meta,
  actions,
}: {
  title: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div
      style={{
        padding: 'var(--space-3)',
        borderBottom: '1px solid var(--review-shell-divider)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--space-3)',
        background: 'var(--review-panel-header-bg)',
      }}
    >
      <div style={{ display: 'grid', gap: 2, minWidth: 0 }}>
        <span className="review-shell-title" style={{ fontSize: 'var(--text-sm)', fontWeight: 700, color: 'var(--text-primary)', letterSpacing: '-0.01em' }}>
          {title}
        </span>
        {meta ? (
          <span style={{ ...getReviewMetaTextStyle(), minWidth: 0 }}>
            {meta}
          </span>
        ) : null}
      </div>
      {actions ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {actions}
        </div>
      ) : null}
    </div>
  );
}
