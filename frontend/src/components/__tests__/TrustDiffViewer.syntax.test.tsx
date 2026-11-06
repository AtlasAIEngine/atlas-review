import { test, expect } from '@playwright/test';
import type { DiffLine, DiffSegment } from '../../utils/diff';
import type { SyntaxTokenMap } from '../../utils/syntaxHighlight';
import {
  buildSyntaxAwareSegmentTokens,
  resolveLineSyntaxTokens,
} from '../trustDiffSyntax';
import { getEmptyReviewDiffMessage } from '../TrustDiffViewer';

function makeLookup(before: SyntaxTokenMap, after: SyntaxTokenMap) {
  return { before, after };
}

test.describe('resolveLineSyntaxTokens', () => {
  test('routes add/del/context lines to the correct token maps', () => {
    const before = new Map<number, Array<{ text: string; color: string }>>([
      [4, [{ text: 'old', color: '#f00' }]],
      [9, [{ text: 'context-old', color: '#0f0' }]],
    ]);
    const after = new Map<number, Array<{ text: string; color: string }>>([
      [6, [{ text: 'new', color: '#00f' }]],
      [9, [{ text: 'context-new', color: '#999' }]],
    ]);
    const lookup = makeLookup(before, after);

    const addLine: DiffLine = { type: 'add', content: 'new', oldNum: null, newNum: 6 };
    const delLine: DiffLine = { type: 'del', content: 'old', oldNum: 4, newNum: null };
    const contextLine: DiffLine = { type: 'context', content: 'ctx', oldNum: 9, newNum: 9 };

    expect(resolveLineSyntaxTokens(addLine, lookup, 'unified')).toEqual(after.get(6));
    expect(resolveLineSyntaxTokens(delLine, lookup, 'unified')).toEqual(before.get(4));
    expect(resolveLineSyntaxTokens(contextLine, lookup, 'unified')).toEqual(after.get(9));

    const fallbackContextLookup = makeLookup(before, new Map());
    expect(resolveLineSyntaxTokens(contextLine, fallbackContextLookup, 'unified')).toEqual(before.get(9));
    expect(resolveLineSyntaxTokens(contextLine, fallbackContextLookup, 'left')).toEqual(before.get(9));
  });
});

test.describe('buildSyntaxAwareSegmentTokens', () => {
  test('preserves syntax color and intraline highlight in merged output', () => {
    const segments: DiffSegment[] = [
      { text: 'const ', highlighted: false },
      { text: 'value', highlighted: true },
    ];

    const tokens = [
      { text: 'const ', color: '#ff7b72' },
      { text: 'value', color: '#e6edf3' },
    ];

    const merged = buildSyntaxAwareSegmentTokens(segments, tokens);
    expect(merged.map((item) => item.text).join('')).toBe('const value');
    expect(merged.map((item) => item.color)).toEqual(['#ff7b72', '#e6edf3']);
    expect(merged.map((item) => item.changeHighlighted)).toEqual([false, true]);
  });

  test('falls back to intraline-only output when syntax tokens are missing', () => {
    const segments: DiffSegment[] = [{ text: 'changed', highlighted: true }];
    const merged = buildSyntaxAwareSegmentTokens(segments, null);

    expect(merged).toEqual([
      { text: 'changed', color: null, changeHighlighted: true },
    ]);
  });
});

test.describe('getEmptyReviewDiffMessage', () => {
  test('describes zero-file branch reviews as a tracked empty branch', () => {
    expect(getEmptyReviewDiffMessage({
      isPrMode: false,
      branchReviewSnapshot: {
        id: 'br-1',
        branchName: 'feature/ClaudeMCP',
        baseBranch: 'main',
        headSha: null,
        commitCount: 0,
        fileCount: 0,
        updatedAt: null,
      },
    })).toBe(
      'No changed files on this branch yet. Atlas is tracking feature/ClaudeMCP against main and will populate the diff automatically when commits land.'
    );
  });

  test('uses pull-request copy for zero-file PR reviews', () => {
    expect(getEmptyReviewDiffMessage({
      isPrMode: true,
      branchReviewSnapshot: null,
    })).toBe('No changed files in this pull request yet.');
  });
});
