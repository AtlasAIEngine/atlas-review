/**
 * Myers diff algorithm (O(ND)) with intraline word highlighting.
 *
 * Produces a unified diff sequence from two string arrays (old/new lines),
 * then pairs consecutive del/add runs and computes word-level segments
 * so the renderer can highlight exactly which tokens changed.
 */

// ── Memoization for repeated remounts ────────────────────────────────
//
// Per-card useMemo loses its result on Virtuoso unmount/remount. For a
// 1000+ line file the diff parse + Myers run can spike to 100-300 ms in
// WebKit, which produces the "blank-then-content" flash on fast scroll.
// Module-level LRU caches keyed on a fast hash of the inputs let remounts
// reuse the previous result.

const DIFF_CACHE_MAX = 200;
const computedDiffCache: Map<string, DiffLine[]> = new Map();
const parsedPatchCache: Map<string, DiffLine[]> = new Map();

function fnv1aHashShort(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(36);
}

function rememberInLru<T>(cache: Map<string, T>, key: string, value: T): T {
  if (cache.has(key)) cache.delete(key);
  else if (cache.size >= DIFF_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
  return value;
}

// ── Public types ─────────────────────────────────────────────────────

export interface DiffSegment {
  text: string;
  /** true = this token was changed (should be highlighted) */
  highlighted: boolean;
}

export interface DiffLine {
  type: 'context' | 'add' | 'del';
  content: string;
  oldNum: number | null;
  newNum: number | null;
  /** Word-level segments for intraline highlighting (only on paired add/del lines) */
  segments?: DiffSegment[];
}

// ── Myers shortest-edit-script ───────────────────────────────────────

interface EditStep {
  type: 'keep' | 'insert' | 'delete';
  oldIdx: number;
  newIdx: number;
}

/**
 * Myers O(ND) diff — returns the shortest edit script.
 * For large files (>5000 lines) falls back to a simple O(N) scan
 * to avoid blowing the call stack or hogging the main thread.
 */
function myersDiff(oldArr: string[], newArr: string[]): EditStep[] {
  const N = oldArr.length;
  const M = newArr.length;

  // Fallback for very large files — simple line-by-line comparison
  if (N + M > 5000) {
    return simpleDiff(oldArr, newArr);
  }

  const MAX = N + M;
  // V[k] stores the furthest-reaching x on diagonal k
  // Offset by MAX so negative indices work
  const size = 2 * MAX + 1;
  const V = new Int32Array(size);
  V.fill(-1);
  V[MAX + 1] = 0; // V[1] = 0

  // Store traces for backtracking
  const traces: Int32Array[] = [];

  outer:
  for (let d = 0; d <= MAX; d++) {
    traces.push(V.slice());
    for (let k = -d; k <= d; k += 2) {
      const kIdx = k + MAX;
      let x: number;
      if (k === -d || (k !== d && V[kIdx - 1] < V[kIdx + 1])) {
        x = V[kIdx + 1]; // move down (insert)
      } else {
        x = V[kIdx - 1] + 1; // move right (delete)
      }
      let y = x - k;
      // Follow diagonal (matches)
      while (x < N && y < M && oldArr[x] === newArr[y]) {
        x++;
        y++;
      }
      V[kIdx] = x;
      if (x >= N && y >= M) {
        break outer;
      }
    }
  }

  // Backtrack to reconstruct edit script
  const steps: EditStep[] = [];
  let x = N;
  let y = M;

  for (let d = traces.length - 1; d > 0; d--) {
    const prevV = traces[d - 1];
    const k = x - y;
    const kIdx = k + MAX;

    let prevK: number;
    if (k === -d || (k !== d && prevV[kIdx - 1] < prevV[kIdx + 1])) {
      prevK = k + 1; // came from above (insert)
    } else {
      prevK = k - 1; // came from left (delete)
    }

    const prevX = prevV[prevK + MAX];
    const prevY = prevX - prevK;

    // Diagonal (matches) — walk backwards
    while (x > prevX && y > prevY) {
      x--;
      y--;
      steps.push({ type: 'keep', oldIdx: x, newIdx: y });
    }

    if (d > 0) {
      if (x === prevX) {
        // Insert
        y--;
        steps.push({ type: 'insert', oldIdx: x, newIdx: y });
      } else {
        // Delete
        x--;
        steps.push({ type: 'delete', oldIdx: x, newIdx: y });
      }
    }
  }

  // Handle remaining diagonal at d=0
  while (x > 0 && y > 0) {
    x--;
    y--;
    steps.push({ type: 'keep', oldIdx: x, newIdx: y });
  }

  steps.reverse();
  return steps;
}

/** Simple O(N) fallback for huge files */
function simpleDiff(oldArr: string[], newArr: string[]): EditStep[] {
  const result: EditStep[] = [];
  const maxLen = Math.max(oldArr.length, newArr.length);
  for (let i = 0; i < maxLen; i++) {
    const hasOld = i < oldArr.length;
    const hasNew = i < newArr.length;
    if (hasOld && hasNew && oldArr[i] === newArr[i]) {
      result.push({ type: 'keep', oldIdx: i, newIdx: i });
    } else {
      if (hasOld) result.push({ type: 'delete', oldIdx: i, newIdx: hasNew ? i : newArr.length });
      if (hasNew) result.push({ type: 'insert', oldIdx: hasOld ? i : oldArr.length, newIdx: i });
    }
  }
  return result;
}

// ── Intraline word-level diff ────────────────────────────────────────

function normalizeDiffInput(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Tokenize a line into words + whitespace for word-level diffing */
function tokenize(line: unknown): string[] {
  if (typeof line !== 'string') return [];
  const tokens: string[] = [];
  let current = '';
  for (const ch of line) {
    if (/\s/.test(ch)) {
      if (current) { tokens.push(current); current = ''; }
      tokens.push(ch);
    } else if (/[{}()\[\];,.<>:=+\-*\/&|!?@#$%^~`"']/.test(ch)) {
      if (current) { tokens.push(current); current = ''; }
      tokens.push(ch);
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

/** Compute word-level diff segments between two lines using LCS on tokens */
function computeWordSegments(oldLine: string, newLine: string): { delSegments: DiffSegment[]; addSegments: DiffSegment[] } {
  const safeOldLine = typeof oldLine === 'string' ? oldLine : '';
  const safeNewLine = typeof newLine === 'string' ? newLine : '';
  const oldTokens = tokenize(safeOldLine);
  const newTokens = tokenize(safeNewLine);

  // LCS on tokens (simple DP — tokens are short so this is fine)
  const m = oldTokens.length;
  const n = newTokens.length;

  // If either line is very long, skip word-level diff
  if (m > 200 || n > 200) {
    return {
      delSegments: [{ text: safeOldLine, highlighted: true }],
      addSegments: [{ text: safeNewLine, highlighted: true }],
    };
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldTokens[i - 1] === newTokens[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack to find which tokens are common
  const oldMatch = new Set<number>();
  const newMatch = new Set<number>();
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (oldTokens[i - 1] === newTokens[j - 1]) {
      oldMatch.add(i - 1);
      newMatch.add(j - 1);
      i--; j--;
    } else if (dp[i - 1][j] >= dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  // Build segments: consecutive matching tokens → not highlighted, others → highlighted
  const buildSegments = (tokens: string[], matchSet: Set<number>): DiffSegment[] => {
    const segs: DiffSegment[] = [];
    let buf = '';
    let bufHighlight = false;
    for (let t = 0; t < tokens.length; t++) {
      const isMatch = matchSet.has(t);
      const highlight = !isMatch;
      if (buf && highlight !== bufHighlight) {
        segs.push({ text: buf, highlighted: bufHighlight });
        buf = '';
      }
      bufHighlight = highlight;
      buf += tokens[t];
    }
    if (buf) segs.push({ text: buf, highlighted: bufHighlight });
    return segs;
  };

  return {
    delSegments: buildSegments(oldTokens, oldMatch),
    addSegments: buildSegments(newTokens, newMatch),
  };
}

// ── Main: compute unified diff with word segments ────────────────────

export function computeUnifiedDiff(before: string | null, after: string | null): DiffLine[] {
  // Cache lookup before any work — same inputs always produce same diff.
  const beforeKey = before == null ? '∅' : `${before.length}:${fnv1aHashShort(before)}`;
  const afterKey = after == null ? '∅' : `${after.length}:${fnv1aHashShort(after)}`;
  const cacheKey = `${beforeKey}|${afterKey}`;
  const cached = computedDiffCache.get(cacheKey);
  if (cached) {
    computedDiffCache.delete(cacheKey);
    computedDiffCache.set(cacheKey, cached);
    return cached;
  }
  const safeBefore = normalizeDiffInput(before);
  const safeAfter = normalizeDiffInput(after);

  if (safeBefore === null && safeAfter !== null) {
    return rememberInLru(computedDiffCache, cacheKey, safeAfter.split('\n').map((line, idx) => ({
      type: 'add' as const, content: line, oldNum: null, newNum: idx + 1,
    })));
  }
  if (safeAfter === null && safeBefore !== null) {
    return rememberInLru(computedDiffCache, cacheKey, safeBefore.split('\n').map((line, idx) => ({
      type: 'del' as const, content: line, oldNum: idx + 1, newNum: null,
    })));
  }
  if (safeBefore === null || safeAfter === null) return rememberInLru(computedDiffCache, cacheKey, []);

  const oldLines = safeBefore.split('\n');
  const newLines = safeAfter.split('\n');
  const steps = myersDiff(oldLines, newLines);

  // Convert edit steps → DiffLine array
  const result: DiffLine[] = [];
  let oldNum = 0;
  let newNum = 0;

  for (const step of steps) {
    if (step.type === 'keep') {
      oldNum++;
      newNum++;
      result.push({ type: 'context', content: oldLines[step.oldIdx] ?? '', oldNum, newNum });
    } else if (step.type === 'delete') {
      oldNum++;
      result.push({ type: 'del', content: oldLines[step.oldIdx] ?? '', oldNum, newNum: null });
    } else {
      newNum++;
      result.push({ type: 'add', content: newLines[step.newIdx] ?? '', oldNum: null, newNum });
    }
  }

  // Now pair consecutive del/add runs for intraline highlighting
  addIntralineSegments(result, oldLines, newLines);

  return rememberInLru(computedDiffCache, cacheKey, result);
}

/**
 * Parse raw unified patch text (`git diff -U*`) into DiffLine rows.
 * This keeps line numbers and add/del classification aligned with git/GitHub hunks.
 */
export function parseUnifiedPatchToDiffLines(patchText: string | null | undefined): DiffLine[] {
  if (typeof patchText !== 'string' || !patchText.trim()) return [];

  // Cache lookup keyed on the patch hash. Patches are deterministic for a
  // given (file, base, head); reusing across remounts saves a full reparse.
  const cacheKey = `${patchText.length}:${fnv1aHashShort(patchText)}`;
  const cached = parsedPatchCache.get(cacheKey);
  if (cached) {
    parsedPatchCache.delete(cacheKey);
    parsedPatchCache.set(cacheKey, cached);
    return cached;
  }

  const lines = patchText.replace(/\r\n/g, '\n').split('\n');
  const result: DiffLine[] = [];

  let inHunk = false;
  let oldNum = 0;
  let newNum = 0;

  for (const rawLine of lines) {
    if (rawLine.startsWith('@@')) {
      const match = rawLine.match(/^@@\s*-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s*@@/);
      if (!match) {
        inHunk = false;
        continue;
      }
      oldNum = Number.parseInt(match[1], 10);
      newNum = Number.parseInt(match[2], 10);
      inHunk = true;
      continue;
    }

    if (!inHunk) continue;
    if (!rawLine) continue;

    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      result.push({
        type: 'add',
        content: rawLine.slice(1),
        oldNum: null,
        newNum,
      });
      newNum += 1;
      continue;
    }

    if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
      result.push({
        type: 'del',
        content: rawLine.slice(1),
        oldNum,
        newNum: null,
      });
      oldNum += 1;
      continue;
    }

    if (rawLine.startsWith(' ')) {
      result.push({
        type: 'context',
        content: rawLine.slice(1),
        oldNum,
        newNum,
      });
      oldNum += 1;
      newNum += 1;
      continue;
    }

    // "\ No newline at end of file" and any other out-of-hunk metadata are ignored.
  }

  addIntralineSegments(result, [], []);
  return rememberInLru(parsedPatchCache, cacheKey, result);
}

/**
 * Walk through the diff result looking for consecutive del→add runs.
 * For each paired del/add, compute word-level segments and attach them.
 */
function addIntralineSegments(lines: DiffLine[], _oldLines: string[], _newLines: string[]): void {
  let i = 0;
  while (i < lines.length) {
    // Find a run of dels
    const delStart = i;
    while (i < lines.length && lines[i].type === 'del') i++;
    const delEnd = i;

    // Find a run of adds immediately after
    const addStart = i;
    while (i < lines.length && lines[i].type === 'add') i++;
    const addEnd = i;

    const delCount = delEnd - delStart;
    const addCount = addEnd - addStart;

    if (delCount > 0 && addCount > 0) {
      // Pair up: min(delCount, addCount) pairs get word-level diff
      const pairs = Math.min(delCount, addCount);
      for (let p = 0; p < pairs; p++) {
        const delLine = lines[delStart + p];
        const addLine = lines[addStart + p];
        const { delSegments, addSegments } = computeWordSegments(delLine.content, addLine.content);
        delLine.segments = delSegments;
        addLine.segments = addSegments;
      }
    }

    // If we didn't advance (context line or other), skip forward
    if (i === delStart) i++;
  }
}

// ── Context collapsing (Week 6a) ─────────────────────────────────────

/** Number of context lines to show around each change */
const DEFAULT_CONTEXT_LINES = 3;

export interface CollapsedSection {
  type: 'collapsed';
  /** Number of context lines hidden */
  count: number;
  /** Index into the original lines array where this section starts */
  startIdx: number;
  /** Index into the original lines array where this section ends (exclusive) */
  endIdx: number;
}

export type DiffLineOrCollapsed = DiffLine | CollapsedSection;

/**
 * Collapse long runs of context lines into CollapsedSection markers.
 * Keeps `contextLines` lines before and after each change (add/del).
 * Only collapses runs of context longer than 2*contextLines + 1 (to avoid
 * collapsing tiny runs where the expand button takes more space than the lines).
 */
export function collapseContext(
  lines: DiffLine[],
  contextLines: number = DEFAULT_CONTEXT_LINES,
): DiffLineOrCollapsed[] {
  if (lines.length === 0) return [];

  // Find indices of all change lines
  const changeIndices = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type !== 'context') {
      changeIndices.add(i);
    }
  }

  // If no changes (all context), show first/last few lines and collapse middle
  if (changeIndices.size === 0) {
    if (lines.length <= contextLines * 2 + 2) return [...lines];
    const result: DiffLineOrCollapsed[] = [];
    for (let i = 0; i < contextLines; i++) result.push(lines[i]);
    result.push({ type: 'collapsed', count: lines.length - contextLines * 2, startIdx: contextLines, endIdx: lines.length - contextLines });
    for (let i = lines.length - contextLines; i < lines.length; i++) result.push(lines[i]);
    return result;
  }

  // Mark which lines should be visible (near a change)
  const visible = new Uint8Array(lines.length);
  for (const ci of changeIndices) {
    for (let offset = -contextLines; offset <= contextLines; offset++) {
      const idx = ci + offset;
      if (idx >= 0 && idx < lines.length) visible[idx] = 1;
    }
  }

  // Build result with collapsed sections for hidden context runs
  const result: DiffLineOrCollapsed[] = [];
  let i = 0;
  while (i < lines.length) {
    if (visible[i]) {
      result.push(lines[i]);
      i++;
    } else {
      // Find end of hidden run
      const start = i;
      while (i < lines.length && !visible[i]) i++;
      const count = i - start;
      // Only collapse if the hidden section is meaningful (> 1 line)
      if (count > 1) {
        result.push({ type: 'collapsed', count, startIdx: start, endIdx: i });
      } else {
        // Just show the line — not worth collapsing 1 line
        for (let j = start; j < i; j++) result.push(lines[j]);
      }
    }
  }

  return result;
}

// ── Confidence overlay (Pattern 6) ───────────────────────────────────

/** Numeric risk score: higher = more dangerous */
const RISK_SCORE: Record<string, number> = {
  low: 0.25,
  medium: 0.5,
  high: 0.75,
  critical: 1.0,
};

/** How many lines in each direction a recommendation's risk radiates */
const RISK_RADIUS = 3;

export interface ConfidenceEntry {
  /** 0-1 risk intensity (0 = safe, 1 = critical) */
  risk: number;
  /** CSS rgba color for the gutter stripe */
  color: string;
  /** CSS rgba color for the row background tint */
  bg: string;
}

/**
 * Recommendation shape expected by the confidence map builder.
 * Intentionally minimal so it doesn't import from @/types.
 */
interface RecForConfidence {
  type: string;
  severity: string;
  line?: number;
}

/**
 * Build a Map<lineNumber, ConfidenceEntry> from file-scoped recommendations.
 * Each recommendation with a `line` generates risk at that line and fading
 * risk across `RISK_RADIUS` lines on each side.
 */
export function buildConfidenceMap(recs: RecForConfidence[], totalLines: number): Map<number, ConfidenceEntry> {
  if (!recs.length || totalLines <= 0) return new Map();

  // Accumulate raw scores per line
  const scores = new Float32Array(totalLines + 1); // 1-indexed

  for (const rec of recs) {
    if (!rec.line || rec.type === 'praise') continue;
    const base = RISK_SCORE[rec.severity] ?? 0.25;
    const center = rec.line;

    for (let offset = -RISK_RADIUS; offset <= RISK_RADIUS; offset++) {
      const lineNum = center + offset;
      if (lineNum < 1 || lineNum > totalLines) continue;
      // Linear falloff: full at center, 0 at edge
      const falloff = 1 - Math.abs(offset) / (RISK_RADIUS + 1);
      scores[lineNum] = Math.min(1, scores[lineNum] + base * falloff);
    }
  }

  // Convert scores → ConfidenceEntry map (only for non-zero lines)
  const map = new Map<number, ConfidenceEntry>();
  for (let i = 1; i <= totalLines; i++) {
    const s = scores[i];
    if (s <= 0) continue;
    map.set(i, {
      risk: s,
      color: riskToGutterColor(s),
      bg: riskToBgColor(s),
    });
  }
  return map;
}

/** Risk score → gutter stripe color (opaque-ish vertical bar) */
function riskToGutterColor(risk: number): string {
  if (risk >= 0.75) return 'rgba(248, 81, 73, 0.8)';   // red
  if (risk >= 0.5)  return 'rgba(210, 153, 34, 0.7)';   // orange
  if (risk >= 0.25) return 'rgba(210, 153, 34, 0.4)';   // yellow
  return 'rgba(63, 185, 80, 0.3)';                       // green
}

/** Risk score → row background tint (very subtle) */
function riskToBgColor(risk: number): string {
  if (risk >= 0.75) return 'rgba(248, 81, 73, 0.06)';
  if (risk >= 0.5)  return 'rgba(210, 153, 34, 0.05)';
  if (risk >= 0.25) return 'rgba(210, 153, 34, 0.03)';
  return 'rgba(63, 185, 80, 0.02)';
}
