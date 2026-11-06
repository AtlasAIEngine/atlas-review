/**
 * Shiki tokenization worker.
 *
 * Runs Shiki off the main thread so a 200-file PR diff doesn't freeze the
 * UI on slower JS engines (notably WKWebView in the desktop app). The
 * worker keeps its own LRU cache of tokenization results so repeated
 * requests for the same content never re-tokenize, even after the main-
 * thread cache evicts.
 *
 * Message protocol (request from main → worker):
 *   { id: number, content: string, language: string, theme: string }
 *
 * Response (worker → main):
 *   { id: number, ok: true,  rawLines: ShikiLikeToken[][] }
 *   { id: number, ok: false, error: string }
 */

interface ShikiLikeToken {
  content?: string;
  text?: string;
  color?: string | null;
}

interface ShikiLikeHighlighter {
  codeToTokens?: (code: string, options: { lang: string; theme: string }) => ShikiLikeToken[][];
}

interface TokenizeRequest {
  id: number;
  content: string;
  language: string;
  theme: string;
}

interface TokenizeResponseOk {
  id: number;
  ok: true;
  rawLines: ShikiLikeToken[][];
}

interface TokenizeResponseErr {
  id: number;
  ok: false;
  error: string;
}

type TokenizeResponse = TokenizeResponseOk | TokenizeResponseErr;

// Same theme/language pre-bundled set the main module uses. Keep in sync.
const SHIKI_THEMES = ['github-dark', 'github-light'] as const;
const SHIKI_LANGS = [
  'javascript', 'typescript', 'tsx', 'jsx', 'python', 'rust', 'go', 'java',
  'c', 'cpp', 'csharp', 'html', 'css', 'json', 'yaml', 'sql', 'bash',
  'dockerfile', 'ruby', 'php', 'swift', 'kotlin', 'toml', 'markdown',
  'scss', 'dotenv', 'make', 'cmake',
];

let highlighterPromise: Promise<ShikiLikeHighlighter | null> | null = null;

async function getHighlighter(): Promise<ShikiLikeHighlighter | null> {
  if (highlighterPromise) return highlighterPromise;
  highlighterPromise = (async () => {
    try {
      const moduleName: string = 'shiki';
      const shikiModule = await import(moduleName) as { createHighlighter?: unknown };
      if (typeof shikiModule.createHighlighter === 'function') {
        const create = shikiModule.createHighlighter as (opts: { themes: string[]; langs: string[] }) => Promise<ShikiLikeHighlighter>;
        return await create({ themes: [...SHIKI_THEMES], langs: SHIKI_LANGS });
      }
    } catch {
      // Fall through and signal unavailable.
    }
    return null;
  })();
  return highlighterPromise;
}

// Worker-local LRU. Same hash + key shape as the main-thread cache so the
// two layers don't double-store identical entries.
const CACHE_MAX = 600;
const cache: Map<string, ShikiLikeToken[][]> = new Map();

function fnv1aHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

function buildKey(content: string, language: string, theme: string): string {
  return `${theme}|${language}|${content.length}|${fnv1aHash(content)}`;
}

function rememberInLru(key: string, value: ShikiLikeToken[][]): ShikiLikeToken[][] {
  if (cache.has(key)) cache.delete(key);
  else if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
  return value;
}

self.onmessage = async (event: MessageEvent<TokenizeRequest>) => {
  const { id, content, language, theme } = event.data || ({} as TokenizeRequest);
  if (typeof id !== 'number') return;

  const reply = (msg: TokenizeResponse) => self.postMessage(msg);

  try {
    const key = buildKey(content, language, theme);
    const cached = cache.get(key);
    if (cached) {
      // LRU bump.
      cache.delete(key);
      cache.set(key, cached);
      reply({ id, ok: true, rawLines: cached });
      return;
    }

    const highlighter = await getHighlighter();
    if (!highlighter || typeof highlighter.codeToTokens !== 'function') {
      reply({ id, ok: false, error: 'highlighter-unavailable' });
      return;
    }
    const rawLines = highlighter.codeToTokens(content, { lang: language, theme });
    rememberInLru(key, rawLines);
    reply({ id, ok: true, rawLines });
  } catch (err) {
    reply({ id, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};

export {};
