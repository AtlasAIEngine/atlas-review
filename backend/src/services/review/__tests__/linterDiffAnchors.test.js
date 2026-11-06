import { describe, expect, it } from 'vitest';
import {
  buildChangedLineIndex,
  isFindingAnchoredToDiff,
  filterAnchoredFindings,
  resolveCanonicalDiffPath,
} from '../linter/linterDiffAnchors.js';

const SAMPLE_DIFF = `diff --git a/src/foo.ts b/src/foo.ts
index abc1234..def5678 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,3 +10,5 @@ function foo() {
   const a = 1;
+  const b = 2;
+  const c = 3;
   return a;
diff --git a/backend/server.js b/backend/server.js
index 1111111..2222222 100644
--- a/backend/server.js
+++ b/backend/server.js
@@ -50,2 +50,4 @@ app.listen(3000);
   console.log('ready');
+  console.log('new line 1');
+  console.log('new line 2');
`;

describe('buildChangedLineIndex', () => {
  it('extracts file entries with line ranges', () => {
    const index = buildChangedLineIndex(SAMPLE_DIFF);
    expect(index.size).toBe(2);
    expect(index.has('src/foo.ts')).toBe(true);
    expect(index.has('backend/server.js')).toBe(true);
  });

  it('parses hunk ranges correctly', () => {
    const index = buildChangedLineIndex(SAMPLE_DIFF);
    const foo = index.get('src/foo.ts');
    expect(foo.lineRanges).toHaveLength(1);
    expect(foo.lineRanges[0]).toEqual({ start: 11, end: 12 });
  });

  it('returns empty map for empty diff', () => {
    expect(buildChangedLineIndex('').size).toBe(0);
    expect(buildChangedLineIndex(null).size).toBe(0);
  });
});

describe('isFindingAnchoredToDiff', () => {
  const index = buildChangedLineIndex(SAMPLE_DIFF);

  it('returns true for finding on a changed line', () => {
    expect(isFindingAnchoredToDiff({ file: 'src/foo.ts', line: 11 }, index)).toBe(true);
    expect(isFindingAnchoredToDiff({ file: 'src/foo.ts', line: 12 }, index)).toBe(true);
  });

  it('returns false for finding outside changed range', () => {
    expect(isFindingAnchoredToDiff({ file: 'src/foo.ts', line: 10 }, index)).toBe(false);
    expect(isFindingAnchoredToDiff({ file: 'src/foo.ts', line: 13 }, index)).toBe(false);
    expect(isFindingAnchoredToDiff({ file: 'src/foo.ts', line: 1 }, index)).toBe(false);
    expect(isFindingAnchoredToDiff({ file: 'src/foo.ts', line: 100 }, index)).toBe(false);
  });

  it('returns false for unknown file', () => {
    expect(isFindingAnchoredToDiff({ file: 'unknown.ts', line: 10 }, index)).toBe(false);
  });

  it('returns false for missing file or line', () => {
    expect(isFindingAnchoredToDiff({ file: null, line: 10 }, index)).toBe(false);
    expect(isFindingAnchoredToDiff({ file: 'src/foo.ts', line: 0 }, index)).toBe(false);
    expect(isFindingAnchoredToDiff(null, index)).toBe(false);
  });

  it('handles suffix matching for subdirectory paths', () => {
    expect(isFindingAnchoredToDiff({ file: 'server.js', line: 51 }, index)).toBe(true);
    expect(isFindingAnchoredToDiff({ file: 'server.js', line: 50 }, index)).toBe(false);
  });

  it('rejects ambiguous suffix matches when multiple files share a basename', () => {
    const ambiguousIndex = buildChangedLineIndex(`${SAMPLE_DIFF}
diff --git a/src/server.js b/src/server.js
index 3333333..4444444 100644
--- a/src/server.js
+++ b/src/server.js
@@ -5,0 +6,1 @@
+console.log('duplicate basename');
`);
    expect(isFindingAnchoredToDiff({ file: 'server.js', line: 51 }, ambiguousIndex)).toBe(false);
  });
});

describe('filterAnchoredFindings', () => {
  const index = buildChangedLineIndex(SAMPLE_DIFF);

  it('separates anchored and unanchored findings', () => {
    const findings = [
      { file: 'src/foo.ts', line: 11, ruleId: 'a' },
      { file: 'src/foo.ts', line: 100, ruleId: 'b' },
      { file: 'unknown.ts', line: 1, ruleId: 'c' },
    ];
    const { anchored, unanchored } = filterAnchoredFindings(findings, index);
    expect(anchored).toHaveLength(1);
    expect(anchored[0].ruleId).toBe('a');
    expect(unanchored).toHaveLength(2);
  });
});

describe('resolveCanonicalDiffPath', () => {
  const index = buildChangedLineIndex(SAMPLE_DIFF);

  it('returns canonical path for exact match', () => {
    expect(resolveCanonicalDiffPath('src/foo.ts', index)).toBe('src/foo.ts');
  });

  it('resolves suffix match', () => {
    expect(resolveCanonicalDiffPath('server.js', index)).toBe('backend/server.js');
  });

  it('keeps the normalized input when suffix resolution is ambiguous', () => {
    const ambiguousIndex = buildChangedLineIndex(`${SAMPLE_DIFF}
diff --git a/src/server.js b/src/server.js
index 3333333..4444444 100644
--- a/src/server.js
+++ b/src/server.js
@@ -5,0 +6,1 @@
+console.log('duplicate basename');
`);
    expect(resolveCanonicalDiffPath('server.js', ambiguousIndex)).toBe('server.js');
  });

  it('returns normalized input for no match', () => {
    expect(resolveCanonicalDiffPath('unknown.ts', index)).toBe('unknown.ts');
  });
});
