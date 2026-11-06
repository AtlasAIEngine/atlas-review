import { test, expect } from '@playwright/test';
import {
  beginSyntaxTokenRequest,
  commitSyntaxTokensIfCurrent,
  createEmptySyntaxTokenPair,
  createSyntaxTokenRequestTracker,
  loadSyntaxTokensForFile,
  type SyntaxTokenPair,
} from '../useSyntaxTokens';

test.describe('loadSyntaxTokensForFile', () => {
  test('returns empty maps when language cannot be resolved', async () => {
    const result = await loadSyntaxTokensForFile(
      {
        beforeContent: 'plain text',
        afterContent: 'still plain text',
        filePath: 'notes/no-extension',
      },
      {
        resolveLanguage: () => null,
      },
    );

    expect(result.before.size).toBe(0);
    expect(result.after.size).toBe(0);
  });

  test('tokenizes before and after with resolved language', async () => {
    const beforeMap = new Map<number, { text: string; color: string }[]>([[1, [{ text: 'before', color: '#fff' }]]]);
    const afterMap = new Map<number, { text: string; color: string }[]>([[1, [{ text: 'after', color: '#000' }]]]);
    const tokenizeCalls: Array<{ content: string | null; language: string | null }> = [];

    const result = await loadSyntaxTokensForFile(
      {
        beforeContent: 'before',
        afterContent: 'after',
        filePath: 'src/file.ts',
      },
      {
        resolveLanguage: () => 'typescript',
        tokenizeFile: async (content, language) => {
          tokenizeCalls.push({ content, language });
          return content === 'before' ? beforeMap : afterMap;
        },
      },
    );

    expect(tokenizeCalls).toEqual([
      { content: 'before', language: 'typescript' },
      { content: 'after', language: 'typescript' },
    ]);
    expect(result.before).toBe(beforeMap);
    expect(result.after).toBe(afterMap);
  });

  test('returns empty maps when content exceeds tokenizer guardrails', async () => {
    const veryLarge = `${'a'.repeat(130_000)}\n`;
    const result = await loadSyntaxTokensForFile({
      beforeContent: veryLarge,
      afterContent: veryLarge,
      filePath: 'src/huge.ts',
    });

    expect(result.before.size).toBe(0);
    expect(result.after.size).toBe(0);
  });
});

test.describe('request tracking', () => {
  test('ignores stale requests and commits only latest request state', () => {
    const tracker = createSyntaxTokenRequestTracker();
    let committed: SyntaxTokenPair | null = null;
    const setTokens = (tokens: SyntaxTokenPair) => {
      committed = tokens;
    };

    const firstRequestId = tracker.nextRequest();
    const secondRequestId = tracker.nextRequest();

    const staleCommit = commitSyntaxTokensIfCurrent(tracker, firstRequestId, createEmptySyntaxTokenPair(), setTokens);
    expect(staleCommit).toBe(false);
    expect(committed).toBeNull();

    const currentTokens: SyntaxTokenPair = {
      before: new Map([[1, [{ text: 'ok', color: '#fff' }]]]),
      after: new Map([[1, [{ text: 'ok', color: '#fff' }]]]),
    };

    const currentCommit = commitSyntaxTokensIfCurrent(tracker, secondRequestId, currentTokens, setTokens);
    expect(currentCommit).toBe(true);
    expect(committed).toBe(currentTokens);
  });

  test('beginSyntaxTokenRequest resets local maps immediately', () => {
    const tracker = createSyntaxTokenRequestTracker();
    let calls = 0;
    const received: SyntaxTokenPair[] = [];

    const requestId = beginSyntaxTokenRequest(tracker, (tokens) => {
      calls += 1;
      received.push(tokens);
    });

    expect(requestId).toBe(1);
    expect(calls).toBe(1);
    expect(received.length).toBe(1);
    const latestSnapshot = received[0]!;
    expect(latestSnapshot.before.size).toBe(0);
    expect(latestSnapshot.after.size).toBe(0);
  });
});
