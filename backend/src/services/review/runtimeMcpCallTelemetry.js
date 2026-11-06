/**
 * Section R Phase B / M2 #67 stage 1: per-call telemetry for the
 * runtime MCP retrieval tools (`mcp__atlas-review-rt__*`).
 *
 * Pure, no I/O. Subscribes to the same `onToolUse` callback that
 * `reviewToolUseTelemetry.js` and `reviewProviderExecution.js` already
 * pump tool_use events into. Produces, per review, an array of call
 * records and a summary suitable for sizing the Stage 2 coalescing
 * window and Stage 3 caps.
 *
 * Per-call record shape (matches the spec on M2 #67 stage 1):
 *
 *   {
 *     tool: 'read_file_slice' | 'get_hunk_context' | 'get_diff_for_file',
 *     path: string,
 *     // From the tool_use input. read_file_slice carries startLine/endLine;
 *     // get_hunk_context carries line/contextLines; get_diff_for_file has
 *     // neither and these stay null.
 *     requestedStartLine: number | null,
 *     requestedEndLine: number | null,
 *     line: number | null,
 *     contextLines: number | null,
 *     // Effective returned range — populated only when the result event is
 *     // wired through (Stage 2 follow-up). For Stage 1 these stay null,
 *     // and the schema field is preserved so consumers can detect
 *     // "measured but null" vs "field missing".
 *     effectiveStartLine: number | null,
 *     effectiveEndLine: number | null,
 *     // 0 for the first call against a path; 1-indexed thereafter so a
 *     // 4th call has repeatedReadIndexForPath = 3.
 *     repeatedReadIndexForPath: number,
 *     // Overlap with the union of all prior requested ranges on this path.
 *     // Range-typed tools only: read_file_slice and get_hunk_context.
 *     // null when not applicable (first call, get_diff_for_file, or unable
 *     // to compute because prior records also had null ranges).
 *     overlapPctWithPriorOnPath: number | null,
 *     // True when the requested range is fully contained inside any
 *     // single prior call's range on this path. Only meaningful for
 *     // range-typed tools.
 *     fullyContainedInPriorRead: boolean | null,
 *   }
 *
 * The summary shape (returned alongside `calls`):
 *
 *   {
 *     callCount: number,
 *     perToolCounts: { read_file_slice, get_hunk_context, get_diff_for_file },
 *     samePathCallCountP50: number,
 *     samePathCallCountMax: number,
 *     maxOverlapPct: number,
 *     fullyContainedRedundantReads: number,
 *     topRepeatedPaths: Array<{ path: string, count: number }>,
 *   }
 */

const RUNTIME_MCP_PREFIX = 'mcp__atlas-review-rt__';
const RANGE_TOOLS = new Set(['read_file_slice', 'get_hunk_context']);

function asNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Resolve the requested range for a runtime MCP tool call from its input.
 * Returns `{ startLine, endLine }` (both numbers) for `read_file_slice`,
 * `{ startLine, endLine }` derived from `line ± contextLines` for
 * `get_hunk_context`, or `{ startLine: null, endLine: null }` for
 * `get_diff_for_file` and any unrecognized tool.
 *
 * Pure helper; visible for unit testing of overlap/contained logic.
 */
export function resolveRequestedRange(tool, input = {}) {
  if (tool === 'read_file_slice') {
    const startLine = asNumber(input.startLine);
    const endLine = asNumber(input.endLine);
    if (startLine === null || endLine === null || endLine < startLine) {
      return { startLine: null, endLine: null };
    }
    return { startLine, endLine };
  }
  if (tool === 'get_hunk_context') {
    const line = asNumber(input.line);
    if (line === null || line < 1) return { startLine: null, endLine: null };
    const ctx = asNumber(input.contextLines);
    const span = ctx !== null && ctx > 0 ? ctx : 20;
    return {
      startLine: Math.max(1, line - span),
      endLine: line + span,
    };
  }
  return { startLine: null, endLine: null };
}

/**
 * Compute the percentage of a requested [start, end] range that overlaps
 * the union of prior ranges. 0 when fully disjoint, 100 when fully
 * contained. Returns null when the new request has no usable range or
 * none of the priors do.
 */
export function computeOverlapPct(requested, priorRanges) {
  if (!requested || requested.startLine === null || requested.endLine === null) return null;
  const usablePriors = priorRanges.filter((r) => r && r.startLine !== null && r.endLine !== null);
  if (usablePriors.length === 0) return null;
  const reqLength = Math.max(0, requested.endLine - requested.startLine + 1);
  if (reqLength === 0) return 0;
  // Build union of priors as a list of disjoint intervals, then sum overlap.
  const intervals = usablePriors
    .map((r) => [r.startLine, r.endLine])
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [s, e] of intervals) {
    if (merged.length === 0 || s > merged[merged.length - 1][1] + 1) {
      merged.push([s, e]);
    } else {
      merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
    }
  }
  let overlapLines = 0;
  for (const [s, e] of merged) {
    const lo = Math.max(s, requested.startLine);
    const hi = Math.min(e, requested.endLine);
    if (hi >= lo) overlapLines += (hi - lo + 1);
  }
  return Number(((overlapLines / reqLength) * 100).toFixed(2));
}

/**
 * True when `requested` is fully contained inside any single `priorRange`.
 * Returns false on `null` ranges.
 */
export function isFullyContainedInAnyPrior(requested, priorRanges) {
  if (!requested || requested.startLine === null || requested.endLine === null) return false;
  for (const prior of priorRanges) {
    if (!prior || prior.startLine === null || prior.endLine === null) continue;
    if (prior.startLine <= requested.startLine && prior.endLine >= requested.endLine) {
      return true;
    }
  }
  return false;
}

function percentile(sortedAsc, p) {
  if (sortedAsc.length === 0) return 0;
  if (sortedAsc.length === 1) return sortedAsc[0];
  const rank = (p / 100) * (sortedAsc.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  const w = rank - lo;
  return Number((sortedAsc[lo] * (1 - w) + sortedAsc[hi] * w).toFixed(2));
}

export function createRuntimeMcpCallTelemetry() {
  /** @type {Array<object>} */
  const calls = [];
  /** @type {Map<string, Array<{ startLine: number|null, endLine: number|null }>>} */
  const priorRangesByPath = new Map();

  function onToolUse(event) {
    if (!event || event.type !== 'tool_use') return;
    const fullName = typeof event.name === 'string' ? event.name : '';
    if (!fullName.startsWith(RUNTIME_MCP_PREFIX)) return;
    const tool = fullName.slice(RUNTIME_MCP_PREFIX.length);
    const input = event.input && typeof event.input === 'object' ? event.input : {};
    const path = typeof input.path === 'string' ? input.path : '';
    if (!path) return;

    const range = resolveRequestedRange(tool, input);
    const priorList = priorRangesByPath.get(path) || [];
    const repeatedReadIndexForPath = priorList.length;

    const isRangeTool = RANGE_TOOLS.has(tool);
    const overlapPctWithPriorOnPath = isRangeTool
      ? computeOverlapPct(range, priorList)
      : null;
    const fullyContainedInPriorRead = isRangeTool
      ? isFullyContainedInAnyPrior(range, priorList)
      : null;

    calls.push({
      tool,
      path,
      requestedStartLine: range.startLine,
      requestedEndLine: range.endLine,
      line: tool === 'get_hunk_context' ? asNumber(input.line) : null,
      contextLines: tool === 'get_hunk_context' ? asNumber(input.contextLines) : null,
      effectiveStartLine: null,
      effectiveEndLine: null,
      repeatedReadIndexForPath,
      overlapPctWithPriorOnPath,
      fullyContainedInPriorRead,
    });

    priorList.push(range);
    priorRangesByPath.set(path, priorList);
  }

  function snapshot() {
    const perToolCounts = { read_file_slice: 0, get_hunk_context: 0, get_diff_for_file: 0 };
    let maxOverlapPct = 0;
    let fullyContainedRedundantReads = 0;
    for (const call of calls) {
      if (perToolCounts[call.tool] !== undefined) perToolCounts[call.tool] += 1;
      if (typeof call.overlapPctWithPriorOnPath === 'number'
        && call.overlapPctWithPriorOnPath > maxOverlapPct) {
        maxOverlapPct = call.overlapPctWithPriorOnPath;
      }
      if (call.fullyContainedInPriorRead === true) fullyContainedRedundantReads += 1;
    }
    const samePathCounts = [];
    const repeatedPaths = [];
    for (const [path, list] of priorRangesByPath.entries()) {
      samePathCounts.push(list.length);
      if (list.length > 1) repeatedPaths.push({ path, count: list.length });
    }
    samePathCounts.sort((a, b) => a - b);
    repeatedPaths.sort((a, b) => b.count - a.count);
    return {
      calls: calls.slice(),
      summary: {
        callCount: calls.length,
        perToolCounts,
        samePathCallCountP50: percentile(samePathCounts, 50),
        samePathCallCountMax: samePathCounts.length > 0 ? samePathCounts[samePathCounts.length - 1] : 0,
        maxOverlapPct,
        fullyContainedRedundantReads,
        topRepeatedPaths: repeatedPaths.slice(0, 10),
      },
    };
  }

  function reset() {
    calls.length = 0;
    priorRangesByPath.clear();
  }

  return { onToolUse, snapshot, reset };
}

export const __testables = {
  RUNTIME_MCP_PREFIX,
  RANGE_TOOLS,
  percentile,
};
