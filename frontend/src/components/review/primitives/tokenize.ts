/**
 * Direction C diff tokenizer. Ported from `system.jsx` — 3-color palette
 * (keyword / string / comment / number). Keyword set covers the subset
 * that appears in review diffs (C#, HLSL, JS/TS).
 *
 * Single-line `//` comments dim the remainder of the line. Leading
 * whitespace is preserved verbatim so indentation survives the grid.
 */

export type DiffTokenColor = 'keyword' | 'string' | 'comment' | 'number';

export interface DiffTokenSpan {
  text: string;
  token?: DiffTokenColor;
}

const DIFF_KEYWORDS: ReadonlySet<string> = new Set([
  'public', 'private', 'protected', 'static', 'void', 'new', 'class', 'interface', 'return',
  'if', 'else', 'for', 'foreach', 'while', 'switch', 'case', 'break', 'continue', 'using',
  'namespace', 'var', 'const', 'let', 'function', 'import', 'export', 'from', 'await', 'async',
  'true', 'false', 'null', 'this', 'base', 'override', 'virtual', 'float', 'float2', 'float4',
  'int', 'bool', 'string', 'TODO',
]);

const TOKEN_RE = /("[^"]*")|('[^']*')|(\b[A-Za-z_][A-Za-z0-9_]*\b)|(\b\d[\d.]*\b)|([^A-Za-z0-9_"']+)/g;

function tokenizeCode(source: string): DiffTokenSpan[] {
  const out: DiffTokenSpan[] = [];
  TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN_RE.exec(source)) !== null) {
    if (m[1] || m[2]) {
      out.push({ text: m[0], token: 'string' });
    } else if (m[3]) {
      out.push({ text: m[0], token: DIFF_KEYWORDS.has(m[0]) ? 'keyword' : undefined });
    } else if (m[4]) {
      out.push({ text: m[0], token: 'number' });
    } else {
      out.push({ text: m[0] });
    }
  }
  return out;
}

/**
 * Tokenize a single line of code into restrained 3-color spans.
 * Leading whitespace is always emitted as an untokenized span so
 * indentation renders verbatim in the grid.
 */
export function tokenize(text: string): DiffTokenSpan[] {
  const source = text ?? '';
  const leadingMatch = source.match(/^\s*/);
  const leading = leadingMatch ? leadingMatch[0] : '';
  const rest = source.slice(leading.length);

  const commentIdx = rest.search(/\/\//);
  if (commentIdx !== -1) {
    const pre = rest.slice(0, commentIdx);
    const cmt = rest.slice(commentIdx);
    return [
      { text: leading },
      ...tokenizeCode(pre),
      { text: cmt, token: 'comment' },
    ];
  }
  return [{ text: leading }, ...tokenizeCode(rest)];
}
