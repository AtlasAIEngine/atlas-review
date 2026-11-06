import type { DiffLine, DiffSegment } from '@/utils/diff';
import {
  mergeSyntaxAndSegments,
  type MergedToken,
  type SyntaxToken,
  type SyntaxTokenMap,
} from '@/utils/syntaxHighlight';

export interface SyntaxTokenLookup {
  before: SyntaxTokenMap;
  after: SyntaxTokenMap;
}

export function resolveLineSyntaxTokens(
  line: DiffLine,
  syntaxTokens: SyntaxTokenLookup,
  side: 'unified' | 'left' | 'right' = 'unified',
): SyntaxToken[] | undefined {
  const getBefore = () => (line.oldNum == null ? undefined : syntaxTokens.before.get(line.oldNum));
  const getAfter = () => (line.newNum == null ? undefined : syntaxTokens.after.get(line.newNum));

  if (line.type === 'add') return getAfter();
  if (line.type === 'del') return getBefore();

  if (side === 'left') return getBefore() || getAfter();
  if (side === 'right') return getAfter() || getBefore();
  return getAfter() || getBefore();
}

export function buildSyntaxAwareSegmentTokens(
  segments: DiffSegment[],
  tokens?: SyntaxToken[] | null,
): MergedToken[] {
  if (tokens && tokens.length > 0) {
    return mergeSyntaxAndSegments(tokens, segments);
  }
  return segments.map((segment) => ({
    text: segment.text,
    color: null,
    changeHighlighted: segment.highlighted,
  }));
}
