import type { CSSProperties } from 'react';
import { tokenize } from './tokenize';

export type DiffHunkKind = '+' | '-' | ' ';

export interface DiffHunkLine {
  kind: DiffHunkKind;
  n?: number | string;
  text: string;
}

interface DiffHunkProps {
  lines: DiffHunkLine[];
  style?: CSSProperties;
}

const TOKEN_VAR: Record<'keyword' | 'string' | 'comment' | 'number', string> = {
  keyword: 'var(--diff-token-keyword)',
  string:  'var(--diff-token-string)',
  comment: 'var(--diff-token-comment)',
  number:  'var(--diff-token-number)',
};

/**
 * Direction C diff renderer. Each line is a 3-column grid
 * (`40px 18px 1fr`): gutter line number, marker, tokenized code. Row
 * tint is driven by `--diff-add-bg` / `--diff-del-bg` (identical on
 * both themes). Mono 12.5px / 1.6 line-height.
 */
export function DiffHunk({ lines, style }: DiffHunkProps) {
  return (
    <div
      data-atlas-diff-hunk=""
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 12.5,
        lineHeight: 1.6,
        background: 'var(--bg-base)',
        borderRadius: 4,
        overflow: 'hidden',
        border: '1px solid var(--border-muted)',
        ...style,
      }}
    >
      {lines.map((line, idx) => {
        const bg =
          line.kind === '+' ? 'var(--diff-add-bg)'
          : line.kind === '-' ? 'var(--diff-del-bg)'
          : 'transparent';
        const marker =
          line.kind === '+' ? 'var(--sev-ok)'
          : line.kind === '-' ? 'var(--sev-high)'
          : 'var(--text-tertiary)';
        const tokens = tokenize(line.text ?? '');
        return (
          <div
            key={idx}
            data-kind={line.kind}
            style={{
              display: 'grid',
              gridTemplateColumns: '40px 18px 1fr',
              background: bg,
            }}
          >
            <span
              style={{
                color: 'var(--text-tertiary)',
                textAlign: 'right',
                paddingRight: 10,
                userSelect: 'none',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {line.n ?? ''}
            </span>
            <span style={{ color: marker, textAlign: 'center', userSelect: 'none' }}>
              {line.kind === ' ' ? '' : line.kind}
            </span>
            <span
              style={{
                color: 'var(--text-primary)',
                whiteSpace: 'pre',
                paddingRight: 10,
              }}
            >
              {tokens.map((tok, j) => (
                <span
                  key={j}
                  data-token={tok.token || undefined}
                  style={{ color: tok.token ? TOKEN_VAR[tok.token] : undefined }}
                >
                  {tok.text}
                </span>
              ))}
            </span>
          </div>
        );
      })}
    </div>
  );
}
