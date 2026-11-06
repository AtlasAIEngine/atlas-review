import { test, expect } from '@playwright/test';
import {
  MAX_TOKENIZE_CHARS,
  MAX_TOKENIZE_LINES,
  mergeSyntaxAndSegments,
  resolveLanguage,
  shouldTokenize,
  tokenizeFile,
  type SyntaxToken,
} from '../syntaxHighlight';
import type { DiffSegment } from '../diff';

test.describe('resolveLanguage', () => {
  test('resolves by extension and special filenames', () => {
    expect(resolveLanguage('src/components/TrustDiffViewer.tsx')).toBe('tsx');
    expect(resolveLanguage('Dockerfile')).toBe('dockerfile');
    expect(resolveLanguage('.env')).toBe('dotenv');
    expect(resolveLanguage('scripts/deploy.sh')).toBe('bash');
    expect(resolveLanguage('fixtures/change.patch')).toBe('diff');
    expect(resolveLanguage('fixtures/change.diff')).toBe('diff');
    expect(resolveLanguage('Project_BLACK/GraphicsSettingsSystem.cs')).toBe('csharp');
  });

  test('uses shebang for extensionless scripts and returns null when unknown', () => {
    expect(resolveLanguage('tools/review-script', '#!/usr/bin/env node\nconsole.log(1);')).toBe('javascript');
    expect(resolveLanguage('README.unknownext')).toBeNull();
    expect(resolveLanguage('notes/no-extension', 'plain text')).toBeNull();
  });
});

test.describe('shouldTokenize', () => {
  test('accepts normal content and rejects oversized files', () => {
    expect(shouldTokenize('const value = 1;\n').ok).toBe(true);

    const largeButSupported = Array.from({ length: 2653 }, () => 'line').join('\n');
    expect(shouldTokenize(largeButSupported).ok).toBe(true);

    const tooManyLines = Array.from({ length: MAX_TOKENIZE_LINES + 1 }, () => 'line').join('\n');
    const lineGate = shouldTokenize(tooManyLines);
    expect(lineGate.ok).toBe(false);
    expect(lineGate.reason).toBe('line-limit');

    const charGate = shouldTokenize('a'.repeat(MAX_TOKENIZE_CHARS + 1));
    expect(charGate.ok).toBe(false);
    expect(charGate.reason).toBe('char-limit');
  });
});

test.describe('tokenizeFile', () => {
  test('fallback tokenization highlights csharp keywords', async () => {
    const globalWithOverride = globalThis as typeof globalThis & { __atlasCreateHighlighter?: unknown };
    const originalOverride = globalWithOverride.__atlasCreateHighlighter;

    globalWithOverride.__atlasCreateHighlighter = async () => ({
      codeToTokens: () => {
        throw new Error('force-fallback');
      },
    });

    try {
      const tokens = await tokenizeFile('public class GraphicsSettings { return; }', 'csharp');
      const line = tokens.get(1) || [];
      const keywordPublic = line.find((token) => token.text === 'public');
      const keywordClass = line.find((token) => token.text === 'class');
      expect(keywordPublic?.color).toBe('#ff7b72');
      expect(keywordClass?.color).toBe('#ff7b72');
    } finally {
      if (originalOverride === undefined) {
        delete globalWithOverride.__atlasCreateHighlighter;
      } else {
        globalWithOverride.__atlasCreateHighlighter = originalOverride;
      }
    }
  });

  test('fallback tokenization highlights patch files and nested code lines', async () => {
    const tokens = await tokenizeFile(
      [
        'diff --git a/src/server.ts b/src/server.ts',
        '@@ -1,2 +1,3 @@',
        '+import { createServer } from "node:http";',
        '+const port = 3000;',
      ].join('\n'),
      'diff',
    );

    const headerLine = tokens.get(1) || [];
    expect(headerLine[0]?.color).toBe('#ff7b72');

    const importLine = tokens.get(3) || [];
    const keywordImport = importLine.find((token) => token.text === 'import');
    const moduleString = importLine.find((token) => token.text === '"node:http"');
    expect(keywordImport?.color).toBe('#ff7b72');
    expect(moduleString?.color).toBe('#a5d6ff');
  });
});

test.describe('fallback comment detection', () => {
  test('does not treat # or // inside string literals as comments', async () => {
    const globalWithOverride = globalThis as typeof globalThis & { __atlasCreateHighlighter?: unknown };
    const originalOverride = globalWithOverride.__atlasCreateHighlighter;

    globalWithOverride.__atlasCreateHighlighter = async () => ({
      codeToTokens: () => { throw new Error('force-fallback'); },
    });

    try {
      // Python URL in string — // should NOT start a comment
      const pyTokens = await tokenizeFile('url = "https://example.com"', 'python');
      const pyLine = pyTokens.get(1) || [];
      const pyCommentTokens = pyLine.filter((t) => t.color === '#8b949e');
      expect(pyCommentTokens.length).toBe(0);

      // Ruby hex color — # should NOT start a comment
      const rbTokens = await tokenizeFile("color = '#ff0000'", 'ruby');
      const rbLine = rbTokens.get(1) || [];
      const rbCommentTokens = rbLine.filter((t) => t.color === '#8b949e');
      expect(rbCommentTokens.length).toBe(0);

      // Python real comment after string — # SHOULD start a comment
      const pyRealTokens = await tokenizeFile('x = "value" # real comment', 'python');
      const pyRealLine = pyRealTokens.get(1) || [];
      const pyRealComment = pyRealLine.filter((t) => t.color === '#8b949e');
      expect(pyRealComment.length).toBeGreaterThan(0);
      expect(pyRealComment[0].text).toContain('# real comment');
    } finally {
      if (originalOverride === undefined) {
        delete globalWithOverride.__atlasCreateHighlighter;
      } else {
        globalWithOverride.__atlasCreateHighlighter = originalOverride;
      }
    }
  });
});

test.describe('mergeSyntaxAndSegments', () => {
  test('merges syntax colors and intraline highlights while preserving text', () => {
    const syntaxTokens: SyntaxToken[] = [
      { text: 'const ', color: '#ff7b72' },
      { text: 'count', color: '#e6edf3' },
      { text: ' = 1;', color: '#79c0ff' },
    ];
    const segments: DiffSegment[] = [
      { text: 'const ', highlighted: false },
      { text: 'count', highlighted: true },
      { text: ' = 1;', highlighted: false },
    ];

    const merged = mergeSyntaxAndSegments(syntaxTokens, segments);
    expect(merged.map((token) => token.text).join('')).toBe('const count = 1;');
    expect(merged.map((token) => token.changeHighlighted)).toEqual([false, true, false]);
    expect(merged.map((token) => token.color)).toEqual(['#ff7b72', '#e6edf3', '#79c0ff']);
  });

  test('falls back to intraline-only tokens when streams mismatch', () => {
    const syntaxTokens: SyntaxToken[] = [{ text: 'abc', color: '#fff' }];
    const segments: DiffSegment[] = [{ text: 'xyz', highlighted: true }];

    const merged = mergeSyntaxAndSegments(syntaxTokens, segments);
    expect(merged).toEqual([
      { text: 'xyz', color: null, changeHighlighted: true },
    ]);
  });
});
