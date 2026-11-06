import { useEffect, useRef, useState } from 'react';
import {
  getCachedTokensSync,
  resolveLanguage,
  tokenizeFile,
  type SyntaxToken,
  type SyntaxTokenMap,
} from '@/utils/syntaxHighlight';
import { useThemeStore } from '@/stores/themeStore';

export interface SyntaxTokenPair {
  before: SyntaxTokenMap;
  after: SyntaxTokenMap;
}

export interface SyntaxTokenRequestTracker {
  nextRequest: () => number;
  isCurrent: (requestId: number) => boolean;
  currentRequest: () => number;
}

type ResolveLanguageFn = (path: string, content?: string | null) => string | null;
type TokenizeFileFn = (content: string | null, language: string | null, resolvedTheme?: string) => Promise<Map<number, SyntaxToken[]>>;

export interface SyntaxTokenLoadOptions {
  beforeContent: string | null;
  afterContent: string | null;
  filePath: string;
  resolvedTheme?: string;
}

interface SyntaxTokenLoadDeps {
  resolveLanguage: ResolveLanguageFn;
  tokenizeFile: TokenizeFileFn;
}

const defaultDeps: SyntaxTokenLoadDeps = {
  resolveLanguage,
  tokenizeFile,
};

export function createEmptySyntaxTokenPair(): SyntaxTokenPair {
  return {
    before: new Map<number, SyntaxToken[]>(),
    after: new Map<number, SyntaxToken[]>(),
  };
}

export function createSyntaxTokenRequestTracker(initialRequest = 0): SyntaxTokenRequestTracker {
  let latestRequest = initialRequest;
  return {
    nextRequest: () => {
      latestRequest += 1;
      return latestRequest;
    },
    isCurrent: (requestId: number) => requestId === latestRequest,
    currentRequest: () => latestRequest,
  };
}

export function beginSyntaxTokenRequest(
  tracker: SyntaxTokenRequestTracker,
  setTokens: (tokens: SyntaxTokenPair) => void,
): number {
  const requestId = tracker.nextRequest();
  setTokens(createEmptySyntaxTokenPair());
  return requestId;
}

export function commitSyntaxTokensIfCurrent(
  tracker: SyntaxTokenRequestTracker,
  requestId: number,
  tokens: SyntaxTokenPair,
  setTokens: (tokens: SyntaxTokenPair) => void,
): boolean {
  if (!tracker.isCurrent(requestId)) return false;
  setTokens(tokens);
  return true;
}

export async function loadSyntaxTokensForFile(
  options: SyntaxTokenLoadOptions,
  deps: Partial<SyntaxTokenLoadDeps> = {},
): Promise<SyntaxTokenPair> {
  const { beforeContent, afterContent, filePath, resolvedTheme } = options;
  const resolveLanguageFn = deps.resolveLanguage ?? defaultDeps.resolveLanguage;
  const tokenizeFileFn = deps.tokenizeFile ?? defaultDeps.tokenizeFile;

  const language = resolveLanguageFn(filePath, beforeContent ?? afterContent);
  if (!language) {
    return createEmptySyntaxTokenPair();
  }

  const [before, after] = await Promise.all([
    tokenizeFileFn(beforeContent, language, resolvedTheme),
    tokenizeFileFn(afterContent, language, resolvedTheme),
  ]);

  return { before, after };
}

function readSyncCachedPair(
  beforeContent: string | null,
  afterContent: string | null,
  filePath: string,
  resolvedTheme?: string,
): SyntaxTokenPair | null {
  const language = resolveLanguage(filePath, beforeContent ?? afterContent);
  if (!language) return null;
  // Either side may be null (added/removed file); a sync hit only makes sense
  // when every non-null side is already cached. Otherwise fall back to async.
  const beforeOk = beforeContent == null || getCachedTokensSync(beforeContent, language, resolvedTheme);
  const afterOk = afterContent == null || getCachedTokensSync(afterContent, language, resolvedTheme);
  if (!beforeOk || !afterOk) return null;
  return {
    before: beforeContent == null
      ? new Map<number, SyntaxToken[]>()
      : getCachedTokensSync(beforeContent, language, resolvedTheme) ?? new Map<number, SyntaxToken[]>(),
    after: afterContent == null
      ? new Map<number, SyntaxToken[]>()
      : getCachedTokensSync(afterContent, language, resolvedTheme) ?? new Map<number, SyntaxToken[]>(),
  };
}

export function useSyntaxTokens(
  beforeContent: string | null,
  afterContent: string | null,
  filePath: string,
  enabled: boolean = true,
): SyntaxTokenPair {
  const trackerRef = useRef<SyntaxTokenRequestTracker>(createSyntaxTokenRequestTracker());
  const resolvedTheme = useThemeStore((s) => s.resolved);
  // Lazy initializer: avoids the empty-state flash when the same content
  // (e.g. file collapsed then re-expanded, or parent re-rendered the same
  // row) is already in the syntax-token cache. Honors the cache even when
  // `enabled` is false so previously-tokenized files stay highlighted.
  const [tokens, setTokens] = useState<SyntaxTokenPair>(() =>
    readSyncCachedPair(beforeContent, afterContent, filePath, resolvedTheme)
      ?? createEmptySyntaxTokenPair()
  );

  useEffect(() => {
    const tracker = trackerRef.current;
    let cancelled = false;

    const synchronous = readSyncCachedPair(beforeContent, afterContent, filePath, resolvedTheme);
    if (synchronous) {
      // Cached hit: commit immediately regardless of `enabled`. Cached tokens
      // are free to display.
      const requestId = tracker.nextRequest();
      commitSyntaxTokensIfCurrent(tracker, requestId, synchronous, setTokens);
      return () => { cancelled = true; };
    }

    if (!enabled) {
      // Caller wants to defer tokenization (e.g. file is off-screen in a
      // long feed). Don't schedule work; show plain text until the caller
      // re-runs us with enabled=true.
      return () => { cancelled = true; };
    }

    const requestId = beginSyntaxTokenRequest(tracker, setTokens);

    void loadSyntaxTokensForFile({ beforeContent, afterContent, filePath, resolvedTheme })
      .then((nextTokens) => {
        if (cancelled) return;
        commitSyntaxTokensIfCurrent(tracker, requestId, nextTokens, setTokens);
      })
      .catch(() => {
        if (cancelled) return;
        commitSyntaxTokensIfCurrent(tracker, requestId, createEmptySyntaxTokenPair(), setTokens);
      });

    return () => {
      cancelled = true;
    };
  }, [beforeContent, afterContent, filePath, resolvedTheme, enabled]);

  return tokens;
}
