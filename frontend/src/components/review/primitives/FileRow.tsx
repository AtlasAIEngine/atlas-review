import type { CSSProperties, MouseEventHandler } from 'react';
import type { SevLevel } from './SevChip';

interface FileRowProps {
  path: string;
  sev?: SevLevel;
  adds?: number;
  dels?: number;
  state?: 'addressed';
  active?: boolean;
  dense?: boolean;
  onClick?: MouseEventHandler<HTMLDivElement>;
  style?: CSSProperties;
}

const SEV_VAR: Record<SevLevel, string> = {
  HIGH: 'var(--sev-high)',
  MED:  'var(--sev-med)',
  LOW:  'var(--sev-low)',
};

/**
 * File tree row. Flat, no nesting UI — dir in muted colour, filename in
 * strong text. Addressed state strikes through the label. Active state
 * shows a left accent bar on `--bg-surface-raised`.
 */
export function FileRow({
  path,
  sev,
  adds,
  dels,
  state,
  active = false,
  dense = false,
  onClick,
  style,
}: FileRowProps) {
  const parts = (path || '').split('/');
  const name = parts.pop() ?? '';
  const dir = parts.join('/');
  const isAddressed = state === 'addressed';

  return (
    <div
      onClick={onClick}
      style={{
        display: 'grid',
        gridTemplateColumns: '8px 1fr auto',
        alignItems: 'center',
        gap: 10,
        padding: dense ? '4px 12px' : '7px 14px',
        fontSize: 12,
        fontFamily: 'var(--font-ui)',
        background: active ? 'var(--bg-surface-raised)' : 'transparent',
        borderLeft: active ? '2px solid var(--text-primary)' : '2px solid transparent',
        cursor: onClick ? 'pointer' : 'default',
        ...style,
      }}
    >
      <span>
        {sev && (
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: 3,
              background: SEV_VAR[sev],
              display: 'inline-block',
            }}
          />
        )}
      </span>
      <span
        title={path}
        style={{
          display: 'flex',
          alignItems: 'baseline',
          minWidth: 0,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          color: isAddressed ? 'var(--text-tertiary)' : 'var(--text-primary)',
          textDecoration: isAddressed ? 'line-through' : 'none',
        }}
      >
        {dir && (
          <span
            style={{
              color: 'var(--text-tertiary)',
              minWidth: 0,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {dir}/
          </span>
        )}
        <span
          style={{
            flexShrink: 0,
            maxWidth: dir ? '58%' : '100%',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            fontWeight: 500,
          }}
        >
          {name}
        </span>
      </span>
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10.5,
          color: 'var(--text-tertiary)',
          display: 'flex',
          gap: 6,
        }}
      >
        {adds != null && <span style={{ color: 'var(--sev-ok)' }}>+{adds}</span>}
        {dels != null && <span style={{ color: 'var(--sev-high)' }}>−{dels}</span>}
      </span>
    </div>
  );
}
