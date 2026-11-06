import type { CSSProperties } from 'react';

export type SevLevel = 'HIGH' | 'MED' | 'LOW';

interface SevChipProps {
  level: SevLevel;
  count?: number;
  muted?: boolean;
  style?: CSSProperties;
}

const SEV_VAR: Record<SevLevel, string> = {
  HIGH: 'var(--sev-high)',
  MED: 'var(--sev-med)',
  LOW: 'var(--sev-low)',
};

/**
 * Severity pill used across the review shell. Dot + optional count + level
 * label in a 14%-alpha fill with a 30%-alpha border. Muted variant drops
 * the fill and uses the default border colour for the "no-count" legend.
 */
export function SevChip({ level, count, muted = false, style }: SevChipProps) {
  const color = SEV_VAR[level];
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 8px',
        borderRadius: 4,
        fontSize: 11,
        fontWeight: 600,
        letterSpacing: 0.3,
        fontFamily: 'var(--font-ui)',
        lineHeight: 1.1,
        color: muted ? 'var(--text-secondary)' : color,
        background: muted ? 'transparent' : `color-mix(in oklab, ${color} 14%, transparent)`,
        border: muted
          ? '1px solid var(--border-default)'
          : `1px solid color-mix(in oklab, ${color} 30%, transparent)`,
        ...style,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 3,
          background: color,
          opacity: muted ? 0.5 : 1,
        }}
      />
      {count != null && <span style={{ fontVariantNumeric: 'tabular-nums' }}>{count}</span>}
      <span>{level}</span>
    </span>
  );
}
