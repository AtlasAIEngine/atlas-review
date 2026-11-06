import type { DiffSegment } from './diff';

export interface SyntaxToken {
  text: string;
  color: string;
}

export interface MergedToken {
  text: string;
  color: string | null;
  changeHighlighted: boolean;
}

export type SyntaxTokenMap = Map<number, SyntaxToken[]>;

type TokenizeFailureReason = 'empty' | 'line-limit' | 'char-limit';

interface TokenizeGate {
  ok: boolean;
  reason?: TokenizeFailureReason;
}

interface ShikiLikeToken {
  content?: string;
  text?: string;
  color?: string | null;
}

interface ShikiLikeHighlighter {
  codeToTokens?: (code: string, options: { lang: string; theme: string }) => ShikiLikeToken[][];
}

const SHIKI_THEMES = ['github-dark', 'github-light'] as const;
type ShikiThemeName = typeof SHIKI_THEMES[number];

const THEME_COLORS = {
  'github-dark': {
    default: '#e6edf3',
    keyword: '#ff7b72',
    string: '#a5d6ff',
    comment: '#8b949e',
    number: '#79c0ff',
  },
  'github-light': {
    default: '#1f2328',
    keyword: '#cf222e',
    string: '#0a3069',
    comment: '#6e7781',
    number: '#0550ae',
  },
} as const;

function getShikiTheme(resolvedTheme?: string): ShikiThemeName {
  return resolvedTheme === 'light' ? 'github-light' : 'github-dark';
}

function getFallbackColors(resolvedTheme?: string) {
  return resolvedTheme === 'light' ? THEME_COLORS['github-light'] : THEME_COLORS['github-dark'];
}

export const MAX_TOKENIZE_LINES = 4000;
export const MAX_TOKENIZE_CHARS = 120_000;
export const MAX_DIFF_TOKENIZE_CHARS = 500_000;

const shikiLanguages = [
  'javascript',
  'typescript',
  'tsx',
  'jsx',
  'python',
  'rust',
  'go',
  'java',
  'c',
  'cpp',
  'csharp',
  'html',
  'css',
  'json',
  'yaml',
  'sql',
  'bash',
  'dockerfile',
  'ruby',
  'php',
  'swift',
  'kotlin',
  'toml',
  'markdown',
  'scss',
  'dotenv',
  'make',
  'cmake',
];

const extensionMap = new Map<string, string>([
  ['js', 'javascript'],
  ['mjs', 'javascript'],
  ['cjs', 'javascript'],
  ['jsx', 'jsx'],
  ['ts', 'typescript'],
  ['tsx', 'tsx'],
  ['py', 'python'],
  ['rb', 'ruby'],
  ['rs', 'rust'],
  ['go', 'go'],
  ['java', 'java'],
  ['c', 'c'],
  ['h', 'c'],
  ['cc', 'cpp'],
  ['cpp', 'cpp'],
  ['cxx', 'cpp'],
  ['hpp', 'cpp'],
  ['hh', 'cpp'],
  ['cs', 'csharp'],
  ['php', 'php'],
  ['swift', 'swift'],
  ['kt', 'kotlin'],
  ['kts', 'kotlin'],
  ['html', 'html'],
  ['htm', 'html'],
  ['css', 'css'],
  ['scss', 'scss'],
  ['less', 'css'],
  ['json', 'json'],
  ['jsonc', 'json'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['toml', 'toml'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['sql', 'sql'],
  ['sh', 'bash'],
  ['bash', 'bash'],
  ['zsh', 'bash'],
  ['fish', 'bash'],
  ['env', 'dotenv'],
  ['mk', 'make'],
  ['dockerfile', 'dockerfile'],
  ['cmake', 'cmake'],
  ['diff', 'diff'],
  ['patch', 'diff'],
]);

const specialFilenameMap = new Map<string, string>([
  ['dockerfile', 'dockerfile'],
  ['containerfile', 'dockerfile'],
  ['makefile', 'make'],
  ['gnumakefile', 'make'],
  ['cmakelists.txt', 'cmake'],
  ['.env', 'dotenv'],
  ['.env.local', 'dotenv'],
  ['.env.development', 'dotenv'],
  ['.env.production', 'dotenv'],
  ['.bashrc', 'bash'],
  ['.zshrc', 'bash'],
  ['gemfile', 'ruby'],
  ['rakefile', 'ruby'],
]);

const keywordMap = new Map<string, Set<string>>([
  ['javascript', new Set(['const', 'let', 'var', 'function', 'class', 'if', 'else', 'return', 'await', 'async', 'import', 'export', 'switch', 'case', 'default', 'for', 'while', 'new', 'throw', 'try', 'catch'])],
  ['jsx', new Set(['const', 'let', 'var', 'function', 'class', 'if', 'else', 'return', 'await', 'async', 'import', 'export'])],
  ['typescript', new Set(['const', 'let', 'var', 'function', 'class', 'interface', 'type', 'extends', 'implements', 'if', 'else', 'return', 'await', 'async', 'import', 'export'])],
  ['tsx', new Set(['const', 'let', 'var', 'function', 'class', 'interface', 'type', 'extends', 'implements', 'if', 'else', 'return', 'await', 'async', 'import', 'export'])],
  ['python', new Set(['def', 'class', 'if', 'elif', 'else', 'return', 'import', 'from', 'for', 'while', 'try', 'except', 'raise', 'with', 'as', 'lambda', 'async', 'await'])],
  ['bash', new Set(['if', 'then', 'fi', 'for', 'do', 'done', 'case', 'esac', 'function', 'export', 'local'])],
  ['rust', new Set(['fn', 'let', 'mut', 'struct', 'enum', 'impl', 'trait', 'if', 'else', 'match', 'return', 'pub', 'use', 'mod'])],
  ['go', new Set(['func', 'var', 'const', 'type', 'struct', 'interface', 'if', 'else', 'for', 'range', 'return', 'package', 'import'])],
  ['java', new Set(['class', 'interface', 'enum', 'public', 'private', 'protected', 'static', 'final', 'if', 'else', 'return', 'new', 'extends', 'implements'])],
  ['csharp', new Set(['class', 'interface', 'enum', 'struct', 'record', 'namespace', 'public', 'private', 'protected', 'internal', 'static', 'readonly', 'const', 'var', 'if', 'else', 'switch', 'case', 'default', 'for', 'foreach', 'while', 'do', 'return', 'new', 'using', 'try', 'catch', 'finally', 'throw', 'async', 'await', 'get', 'set'])],
  ['sql', new Set(['select', 'from', 'where', 'insert', 'update', 'delete', 'join', 'left', 'right', 'inner', 'outer', 'order', 'by', 'group', 'into', 'values'])],
  ['ruby', new Set(['def', 'class', 'module', 'if', 'elsif', 'else', 'end', 'do', 'yield', 'return', 'require'])],
]);

let highlighterPromise: Promise<ShikiLikeHighlighter | null> | null = null;

export function resolveLanguage(path: string, content?: string | null): string | null {
  const trimmedPath = String(path || '').trim();
  const filename = trimmedPath.split(/[\\/]/).pop()?.toLowerCase() || '';
  if (!filename) return resolveLanguageFromShebang(content);

  if (specialFilenameMap.has(filename)) {
    return specialFilenameMap.get(filename) || null;
  }

  const extMatch = filename.match(/\.([a-z0-9]+)$/);
  if (extMatch) {
    const ext = extMatch[1];
    if (extensionMap.has(ext)) {
      return extensionMap.get(ext) || null;
    }
  }

  return resolveLanguageFromShebang(content);
}

function resolveLanguageFromShebang(content?: string | null): string | null {
  if (!content) return null;
  const firstLine = content.split('\n', 1)[0] || '';
  if (!firstLine.startsWith('#!')) return null;
  const normalized = firstLine.toLowerCase();

  if (normalized.includes('node') || normalized.includes('deno')) return 'javascript';
  if (normalized.includes('python')) return 'python';
  if (normalized.includes('bash') || normalized.includes('/sh') || normalized.includes('zsh') || normalized.includes('fish')) return 'bash';
  if (normalized.includes('ruby')) return 'ruby';
  if (normalized.includes('php')) return 'php';
  return null;
}

export function shouldTokenize(content: string | null): TokenizeGate {
  if (!content) {
    return { ok: false, reason: 'empty' };
  }

  if (content.length > MAX_TOKENIZE_CHARS) {
    return { ok: false, reason: 'char-limit' };
  }

  let lineCount = 1;
  for (let i = 0; i < content.length; i += 1) {
    if (content[i] === '\n') lineCount += 1;
    if (lineCount > MAX_TOKENIZE_LINES) {
      return { ok: false, reason: 'line-limit' };
    }
  }

  return { ok: true };
}

// Keep tokenization off the critical path on slower JS engines (notably
// WKWebView in the desktop app) by:
//   1. Caching results across re-mounts and shared content (LRU on hash).
//   2. Bounding concurrent Shiki calls so 200-file PRs don't fire 400 sync
//      tokenization chunks at once and freeze the main thread.
//
// Browser (V8) is fast enough that the cap is invisible there; the main win
// is for WebKit/JSC where each `codeToTokens` call is a long sync chunk.

const TOKEN_CACHE_MAX = 600;
const tokenCache: Map<string, SyntaxTokenMap> = new Map();
const tokenInflight: Map<string, Promise<SyntaxTokenMap>> = new Map();

const TOKENIZE_MAX_CONCURRENT = 4;
let tokenizeActive = 0;
const tokenizeQueue: Array<() => void> = [];

function fnv1aHash(input: string): string {
  // Cheap, deterministic, collision-tolerant — we already namespace by
  // length + language + theme so collisions are exceedingly rare.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(36);
}

function buildTokenCacheKey(content: string, language: string, theme: string): string {
  return `${theme}|${language}|${content.length}|${fnv1aHash(content)}`;
}

function rememberTokenResult(key: string, value: SyntaxTokenMap): SyntaxTokenMap {
  if (tokenCache.has(key)) {
    // Move-to-end for LRU recency.
    tokenCache.delete(key);
  } else if (tokenCache.size >= TOKEN_CACHE_MAX) {
    const oldestKey = tokenCache.keys().next().value;
    if (oldestKey !== undefined) tokenCache.delete(oldestKey);
  }
  tokenCache.set(key, value);
  return value;
}

function withConcurrencyLimit<T>(work: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      tokenizeActive += 1;
      work()
        .then((value) => {
          tokenizeActive -= 1;
          const next = tokenizeQueue.shift();
          if (next) next();
          resolve(value);
        })
        .catch((err) => {
          tokenizeActive -= 1;
          const next = tokenizeQueue.shift();
          if (next) next();
          reject(err);
        });
    };
    if (tokenizeActive < TOKENIZE_MAX_CONCURRENT) {
      run();
    } else {
      tokenizeQueue.push(run);
    }
  });
}

// Worker bridge: route Shiki tokenization off the main thread so big PR diffs
// (200+ files) don't lock up WKWebView. Falls back to main-thread Shiki if the
// worker fails to initialize, posts a non-OK reply, or is explicitly disabled
// (test override / SSR).

interface WorkerTokenizeResponse {
  id: number;
  ok: boolean;
  rawLines?: ShikiLikeToken[][];
  error?: string;
}

interface PendingWorkerRequest {
  resolve: (value: ShikiLikeToken[][] | null) => void;
  reject: (err: unknown) => void;
}

let syntaxWorker: Worker | null = null;
let syntaxWorkerDisabled = false;
let syntaxWorkerLoadPromise: Promise<Worker | null> | null = null;
let nextWorkerRequestId = 1;
const pendingWorkerRequests = new Map<number, PendingWorkerRequest>();

function attachWorkerHandlers(worker: Worker): void {
  worker.onmessage = (event: MessageEvent<WorkerTokenizeResponse>) => {
    const data = event.data;
    if (!data || typeof data.id !== 'number') return;
    const pending = pendingWorkerRequests.get(data.id);
    if (!pending) return;
    pendingWorkerRequests.delete(data.id);
    if (data.ok && Array.isArray(data.rawLines)) {
      pending.resolve(data.rawLines);
    } else {
      // Non-OK — let caller fall back to main-thread Shiki.
      pending.resolve(null);
    }
  };
  worker.onerror = () => {
    // Worker crashed; mark disabled, drain pending, and let everything fall
    // back to the main thread.
    syntaxWorkerDisabled = true;
    const pendings = Array.from(pendingWorkerRequests.values());
    pendingWorkerRequests.clear();
    for (const entry of pendings) entry.resolve(null);
    try { syntaxWorker?.terminate(); } catch { /* ignore */ }
    syntaxWorker = null;
  };
}

async function loadSyntaxWorker(): Promise<Worker | null> {
  if (syntaxWorkerDisabled) return null;
  if (syntaxWorker) return syntaxWorker;
  if (syntaxWorkerLoadPromise) return syntaxWorkerLoadPromise;

  // Tests stub Shiki via __atlasCreateHighlighter on the main thread; the
  // worker can't see that override, so prefer main-thread tokenization in
  // tests.
  const testOverride = (globalThis as { __atlasCreateHighlighter?: unknown }).__atlasCreateHighlighter;
  if (typeof testOverride === 'function') {
    syntaxWorkerDisabled = true;
    return null;
  }

  if (typeof Worker === 'undefined') {
    syntaxWorkerDisabled = true;
    return null;
  }

  // Dynamic import keeps the Vite `?worker` resolver out of test runners
  // (Playwright unit tests don't understand the suffix) — failure here just
  // disables the worker and falls back to the main thread.
  syntaxWorkerLoadPromise = (async () => {
    try {
      const mod = await import('./syntaxHighlight.worker.ts?worker');
      const Ctor = (mod as { default?: new () => Worker }).default;
      if (typeof Ctor !== 'function') {
        syntaxWorkerDisabled = true;
        return null;
      }
      const w = new Ctor();
      attachWorkerHandlers(w);
      syntaxWorker = w;
      return w;
    } catch {
      syntaxWorkerDisabled = true;
      return null;
    }
  })();

  return syntaxWorkerLoadPromise;
}

async function tokenizeOnWorker(content: string, language: string, theme: string): Promise<ShikiLikeToken[][] | null> {
  const worker = await loadSyntaxWorker();
  if (!worker) return null;

  return new Promise<ShikiLikeToken[][] | null>((resolve, reject) => {
    const id = nextWorkerRequestId;
    nextWorkerRequestId += 1;
    pendingWorkerRequests.set(id, { resolve, reject });
    try {
      worker.postMessage({ id, content, language, theme });
    } catch {
      pendingWorkerRequests.delete(id);
      resolve(null);
    }
  });
}

export function __resetSyntaxTokenCacheForTests(): void {
  tokenCache.clear();
  tokenInflight.clear();
  tokenizeActive = 0;
  tokenizeQueue.length = 0;
  pendingWorkerRequests.clear();
  if (syntaxWorker) {
    try { syntaxWorker.terminate(); } catch { /* ignore */ }
    syntaxWorker = null;
  }
  syntaxWorkerDisabled = false;
  syntaxWorkerLoadPromise = null;
  nextWorkerRequestId = 1;
}

/**
 * Synchronous cache lookup used by `useSyntaxTokens` to avoid a one-frame
 * empty flash when the same content was tokenized earlier in the session
 * (e.g. user collapsed a file then re-expanded, or the parent re-rendered
 * the same row). Returns `null` if the gate would skip tokenization, or
 * if the entry isn't cached yet.
 */
export function getCachedTokensSync(
  content: string | null,
  language: string | null,
  resolvedTheme?: string,
): SyntaxTokenMap | null {
  if (!content || !language) return null;
  const gate = shouldTokenize(content);
  const isDiffLanguage = language === 'diff';
  const canUseLargeDiffFallback =
    isDiffLanguage && gate.reason === 'char-limit' && content.length <= MAX_DIFF_TOKENIZE_CHARS;
  if (!gate.ok && !canUseLargeDiffFallback) return null;
  const key = buildTokenCacheKey(content, language, getShikiTheme(resolvedTheme));
  const hit = tokenCache.get(key);
  return hit ?? null;
}

export async function tokenizeFile(content: string | null, language: string | null, resolvedTheme?: string): Promise<SyntaxTokenMap> {
  const gate = shouldTokenize(content);
  const isDiffLanguage = language === 'diff';
  const canUseLargeDiffFallback =
    Boolean(content)
    && isDiffLanguage
    && gate.reason === 'char-limit'
    && content!.length <= MAX_DIFF_TOKENIZE_CHARS;
  if ((!gate.ok && !canUseLargeDiffFallback) || !content || !language) {
    return new Map();
  }

  const shikiTheme = getShikiTheme(resolvedTheme);
  const cacheKey = buildTokenCacheKey(content, language, shikiTheme);
  const cached = tokenCache.get(cacheKey);
  if (cached) {
    // Promote recency on hit so hot files stay resident.
    tokenCache.delete(cacheKey);
    tokenCache.set(cacheKey, cached);
    return cached;
  }
  const inflight = tokenInflight.get(cacheKey);
  if (inflight) return inflight;

  const colors = getFallbackColors(resolvedTheme);

  const work = async (): Promise<SyntaxTokenMap> => {
    if (isDiffLanguage) {
      return fallbackTokenize(content, language, colors);
    }
    // Prefer the worker; on failure (worker disabled, init error, non-OK
    // reply) fall through to main-thread Shiki, then to deterministic
    // tokenization. Worker output uses the same Shiki token shape, so the
    // downstream conversion is identical.
    try {
      const workerLines = await tokenizeOnWorker(content, language, shikiTheme);
      if (workerLines) {
        return toSyntaxTokenMap(content, workerLines, colors.default);
      }
    } catch {
      // Ignore and fall through.
    }
    try {
      const highlighter = await getHighlighter();
      if (highlighter?.codeToTokens) {
        const rawLines = highlighter.codeToTokens(content, { lang: language, theme: shikiTheme });
        return toSyntaxTokenMap(content, rawLines, colors.default);
      }
    } catch {
      // Ignore and fall through to deterministic local fallback.
    }
    return fallbackTokenize(content, language, colors);
  };

  const promise = withConcurrencyLimit(work)
    .then((value) => {
      tokenInflight.delete(cacheKey);
      return rememberTokenResult(cacheKey, value);
    })
    .catch((err) => {
      tokenInflight.delete(cacheKey);
      throw err;
    });

  tokenInflight.set(cacheKey, promise);
  return promise;
}

export function mergeSyntaxAndSegments(
  syntaxTokens: SyntaxToken[] | null | undefined,
  segments: DiffSegment[] | null | undefined
): MergedToken[] {
  if ((!syntaxTokens || syntaxTokens.length === 0) && (!segments || segments.length === 0)) {
    return [];
  }

  if (!segments || segments.length === 0) {
    return (syntaxTokens || []).map((token) => ({
      text: token.text,
      color: token.color || null,
      changeHighlighted: false,
    }));
  }

  if (!syntaxTokens || syntaxTokens.length === 0) {
    return segments.map((segment) => ({
      text: segment.text,
      color: null,
      changeHighlighted: segment.highlighted,
    }));
  }

  const syntaxText = syntaxTokens.map((token) => token.text).join('');
  const segmentText = segments.map((segment) => segment.text).join('');
  if (syntaxText !== segmentText) {
    return segments.map((segment) => ({
      text: segment.text,
      color: null,
      changeHighlighted: segment.highlighted,
    }));
  }

  const merged: MergedToken[] = [];
  let syntaxIdx = 0;
  let segmentIdx = 0;
  let syntaxOffset = 0;
  let segmentOffset = 0;

  while (syntaxIdx < syntaxTokens.length && segmentIdx < segments.length) {
    const syntax = syntaxTokens[syntaxIdx];
    const segment = segments[segmentIdx];

    const syntaxRemaining = syntax.text.length - syntaxOffset;
    const segmentRemaining = segment.text.length - segmentOffset;

    if (syntaxRemaining <= 0) {
      syntaxIdx += 1;
      syntaxOffset = 0;
      continue;
    }
    if (segmentRemaining <= 0) {
      segmentIdx += 1;
      segmentOffset = 0;
      continue;
    }

    const take = Math.min(syntaxRemaining, segmentRemaining);
    const slice = syntax.text.slice(syntaxOffset, syntaxOffset + take);
    merged.push({
      text: slice,
      color: syntax.color || null,
      changeHighlighted: segment.highlighted,
    });

    syntaxOffset += take;
    segmentOffset += take;

    if (syntaxOffset >= syntax.text.length) {
      syntaxIdx += 1;
      syntaxOffset = 0;
    }

    if (segmentOffset >= segment.text.length) {
      segmentIdx += 1;
      segmentOffset = 0;
    }
  }

  if (syntaxIdx !== syntaxTokens.length || segmentIdx !== segments.length) {
    return segments.map((segment) => ({
      text: segment.text,
      color: null,
      changeHighlighted: segment.highlighted,
    }));
  }

  return mergeAdjacentTokens(merged);
}

async function getHighlighter(): Promise<ShikiLikeHighlighter | null> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterSafely();
  }
  return highlighterPromise;
}

async function createHighlighterSafely(): Promise<ShikiLikeHighlighter | null> {
  const createHighlighter = await loadCreateHighlighter();
  if (!createHighlighter) return null;
  try {
    return await createHighlighter({
      themes: [...SHIKI_THEMES],
      langs: shikiLanguages,
    });
  } catch {
    return null;
  }
}

async function loadCreateHighlighter(): Promise<((options: { themes: string[]; langs: string[] }) => Promise<ShikiLikeHighlighter>) | null> {
  const testOverride = (globalThis as { __atlasCreateHighlighter?: unknown }).__atlasCreateHighlighter;
  if (typeof testOverride === 'function') {
    return testOverride as (options: { themes: string[]; langs: string[] }) => Promise<ShikiLikeHighlighter>;
  }

  try {
    const moduleName: string = 'shiki';
    const shikiModule = await import(moduleName) as { createHighlighter?: unknown };
    if (typeof shikiModule.createHighlighter === 'function') {
      return shikiModule.createHighlighter as (options: { themes: string[]; langs: string[] }) => Promise<ShikiLikeHighlighter>;
    }
  } catch {
    return null;
  }

  return null;
}

function toSyntaxTokenMap(content: string, rawLines: ShikiLikeToken[][], defaultColor: string): SyntaxTokenMap {
  const expectedLines = content.split('\n');
  const map: SyntaxTokenMap = new Map();

  for (let idx = 0; idx < expectedLines.length; idx += 1) {
    const lineNumber = idx + 1;
    const lineTokens = rawLines[idx];
    if (!lineTokens || lineTokens.length === 0) {
      map.set(lineNumber, [{ text: expectedLines[idx], color: defaultColor }]);
      continue;
    }

    const tokens = lineTokens.map((token) => ({
      text: token.content ?? token.text ?? '',
      color: token.color || defaultColor,
    }));
    map.set(lineNumber, tokens.length > 0 ? tokens : [{ text: expectedLines[idx], color: defaultColor }]);
  }

  return map;
}

interface FallbackColors {
  default: string;
  keyword: string;
  string: string;
  comment: string;
  number: string;
}

function fallbackTokenize(content: string, language: string, colors: FallbackColors): SyntaxTokenMap {
  const map: SyntaxTokenMap = new Map();
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    map.set(i + 1, fallbackTokenizeLine(lines[i], language, colors));
  }
  return map;
}

function fallbackTokenizeLine(line: string, language: string, colors: FallbackColors): SyntaxToken[] {
  if (language === 'diff') {
    return fallbackTokenizeDiffLine(line, colors);
  }

  const commentIndex = findCommentStart(line, language);
  const beforeComment = commentIndex >= 0 ? line.slice(0, commentIndex) : line;
  const commentSuffix = commentIndex >= 0 ? line.slice(commentIndex) : '';
  const tokens = tokenizeCodeFragment(beforeComment, language, colors);
  if (commentSuffix) {
    tokens.push({ text: commentSuffix, color: colors.comment });
  }
  return tokens.length > 0 ? tokens : [{ text: line, color: colors.default }];
}

function fallbackTokenizeDiffLine(line: string, colors: FallbackColors): SyntaxToken[] {
  if (!line) return [{ text: line, color: colors.default }];

  if (line.startsWith('diff --git') || line.startsWith('index ')) {
    return [{ text: line, color: colors.keyword }];
  }

  if (line.startsWith('@@')) {
    return [{ text: line, color: colors.number }];
  }

  if (line.startsWith('+++') || line.startsWith('---')) {
    return [{ text: line, color: colors.string }];
  }

  const marker = line[0];
  if (marker === '+' || marker === '-' || marker === ' ') {
    const markerColor = marker === '+' ? colors.string : marker === '-' ? colors.comment : colors.default;
    const rest = line.slice(1);
    return [
      { text: marker, color: markerColor },
      ...tokenizeCodeFragment(rest, guessDiffLineLanguage(rest), colors),
    ];
  }

  return tokenizeCodeFragment(line, guessDiffLineLanguage(line), colors);
}

function guessDiffLineLanguage(line: string): string {
  const trimmed = line.trimStart();
  // Check Python-distinct tokens first. `import`/`class`/`return`/`if`/`else`
  // are shared with TypeScript, so a Python-second order would never reach
  // this branch for the shared keywords; only `def`/`elif`/`from` plus the
  // colon-suffix block opener disambiguate Python deterministically.
  if (/^(def|elif|from)\b/.test(trimmed) || /:\s*$/.test(trimmed)) {
    return 'python';
  }
  if (/^(import|export|const|let|var|type|interface|function|class|return|if|else|await|async)\b/.test(trimmed)) {
    return 'typescript';
  }
  return 'typescript';
}

function findCommentStart(line: string, language: string): number {
  const supportsHashComment = language === 'python' || language === 'bash' || language === 'yaml' || language === 'dotenv' || language === 'ruby';
  const supportsDoubleSlash = language !== 'python' && language !== 'bash' && language !== 'yaml' && language !== 'dotenv';

  // Scan character-by-character, skipping string literals, to avoid false
  // positives on # or // inside quoted strings (e.g., URLs, hex colors).
  let inString: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === '\\') { i++; continue; } // skip escaped char
      if (ch === inString) inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }
    if (supportsHashComment && ch === '#') return i;
    if (supportsDoubleSlash && ch === '/' && line[i + 1] === '/') return i;
  }
  return -1;
}

function tokenizeCodeFragment(fragment: string, language: string, colors: FallbackColors): SyntaxToken[] {
  const keywordSet = keywordMap.get(language) || keywordMap.get(normalizeLanguageFamily(language)) || new Set<string>();
  const tokens: SyntaxToken[] = [];
  const pattern = /(`[^`]*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][A-Za-z0-9_]*\b|[^A-Za-z0-9_])/g;
  let lastIndex = 0;
  let match = pattern.exec(fragment);

  while (match) {
    const token = match[0];
    if (match.index > lastIndex) {
      tokens.push({ text: fragment.slice(lastIndex, match.index), color: colors.default });
    }
    tokens.push({
      text: token,
      color: classifyTokenColor(token, keywordSet, colors),
    });
    lastIndex = match.index + token.length;
    match = pattern.exec(fragment);
  }

  if (lastIndex < fragment.length) {
    tokens.push({ text: fragment.slice(lastIndex), color: colors.default });
  }

  return mergeAdjacentTokens(tokens.map((token) => ({ ...token, changeHighlighted: false }))).map((token) => ({
    text: token.text,
    color: token.color || colors.default,
  }));
}

function normalizeLanguageFamily(language: string): string {
  if (language === 'tsx' || language === 'typescript') return 'typescript';
  if (language === 'jsx' || language === 'javascript') return 'javascript';
  return language;
}

function classifyTokenColor(token: string, keywordSet: Set<string>, colors: FallbackColors): string {
  const lower = token.toLowerCase();
  if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")) || (token.startsWith('`') && token.endsWith('`'))) {
    return colors.string;
  }
  if (/^\d+(\.\d+)?$/.test(token)) return colors.number;
  if (keywordSet.has(lower) || keywordSet.has(token)) return colors.keyword;
  return colors.default;
}

function mergeAdjacentTokens<T extends { text: string; color: string | null; changeHighlighted: boolean }>(tokens: T[]): T[] {
  const merged: T[] = [];
  for (const token of tokens) {
    if (!token.text) continue;
    const previous = merged[merged.length - 1];
    if (previous && previous.color === token.color && previous.changeHighlighted === token.changeHighlighted) {
      previous.text += token.text;
      continue;
    }
    merged.push({ ...token });
  }
  return merged;
}
