import type { CSSProperties } from 'react';

export type FindingState = 'open' | 'addressed' | 'dismissed';

const STATE_VAR: Record<FindingState, string> = {
  open:       'var(--sev-high)',
  addressed:  'var(--sev-ok)',
  dismissed:  'var(--text-tertiary)',
};

interface StateDotProps {
  state: FindingState;
  style?: CSSProperties;
}

/**
 * 6px dot used alongside finding titles in the left pane and chip rows.
 * Maps finding state to the muted severity palette: open = high, addressed =
 * ok, dismissed = tertiary.
 */
export function StateDot({ state, style }: StateDotProps) {
  return (
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: 3,
        background: STATE_VAR[state],
        display: 'inline-block',
        flexShrink: 0,
        ...style,
      }}
    />
  );
}
