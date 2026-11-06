/**
 * Performance-mode tool-use telemetry accumulator (M0).
 *
 * Subscribes to the same `onToolUse` callback that
 * `reviewProviderExecution.js` already invokes for every CLI-agentic
 * tool_use event, and produces a per-review snapshot of:
 *
 *   - total tool calls
 *   - per-kind counts (full_file_read, partial_file_read, grep, ...)
 *   - repeated reads per file path
 *   - git diff invocation count
 *   - classification reliability (1 - unclassified/total)
 *
 * Pure in-memory; no I/O, no logging. Composes with the existing
 * `buildAgenticToolUseHandler` in reviewService.js — the wiring layer
 * fans the same event to both handlers.
 */

import { classifyToolEvent, TOOL_EVENT_KINDS } from './reviewToolEventClassifier.js';
import { createRuntimeMcpCallTelemetry } from './runtimeMcpCallTelemetry.js';
import { createCodegraphMcpCallTelemetry } from './codegraphMcpCallTelemetry.js';

/**
 * Gate for whether to attach the `review.stats.performance.*` namespace.
 *
 * Performance strategy always emits telemetry. Balanced (smart) strategy
 * only emits when ATLAS_REVIEW_TELEMETRY_BALANCED=1 — this lets benchmark
 * runs collect baseline data without changing default Balanced output bytes.
 *
 * @param {string|null|undefined} strategy - normalized review_model_strategy
 * @param {NodeJS.ProcessEnv} [env] - injected env for testability
 * @returns {boolean}
 */
export function shouldEmitPerformanceTelemetry(strategy, env = process.env) {
  if (strategy === 'performance') return true;
  if (env && env.ATLAS_REVIEW_TELEMETRY_BALANCED === '1') return true;
  return false;
}

function createEmptyKindCounts() {
  const counts = {};
  for (const kind of TOOL_EVENT_KINDS) {
    counts[kind] = 0;
  }
  return counts;
}

/**
 * Create a fresh telemetry accumulator.
 *
 * @returns {{
 *   onToolUse: (event: object) => void,
 *   snapshot: () => {
 *     toolCalls: number,
 *     fullFileReads: number,
 *     partialFileReads: number,
 *     gitDiffCalls: number,
 *     repeatedReadsPerPath: Record<string, number>,
 *     repeatedReadsTotal: number,
 *     uniqueFilesRead: number,
 *     classifiedCounts: Record<string, number>,
 *     unclassifiedCount: number,
 *     classificationReliability: number,
 *   },
 *   reset: () => void,
 * }}
 */
export function createReviewToolUseTelemetry() {
  let toolCalls = 0;
  let kindCounts = createEmptyKindCounts();
  // Per-path read counters: counts every full_file_read OR partial_file_read
  // hit on a given path. The first hit doesn't count as "repeated"; subsequent
  // hits do.
  const readsPerPath = new Map();
  // M2 #67 stage 1: per-call records for the runtime MCP retrieval tools.
  // Captures requested ranges, overlap %, contained-in-prior so Stage 2
  // can size the coalescing window from real data.
  const runtimeMcpCalls = createRuntimeMcpCallTelemetry();
  // CodeGraph experiment: per-tool counts for the external `codegraph`
  // MCP server (mcp__codegraph__*). Separate from runtimeMcpCalls because
  // the two servers expose different tool shapes — see
  // codegraphMcpCallTelemetry.js for the snapshot schema.
  const codegraphMcpCalls = createCodegraphMcpCallTelemetry();

  function onToolUse(event) {
    toolCalls += 1;
    const { kind, target } = classifyToolEvent(event);
    kindCounts[kind] = (kindCounts[kind] || 0) + 1;
    if ((kind === 'full_file_read' || kind === 'partial_file_read') && target) {
      readsPerPath.set(target, (readsPerPath.get(target) || 0) + 1);
    }
    runtimeMcpCalls.onToolUse(event);
    codegraphMcpCalls.onToolUse(event);
  }

  function snapshot() {
    const repeatedReadsPerPath = {};
    let repeatedReadsTotal = 0;
    for (const [path, count] of readsPerPath.entries()) {
      if (count > 1) {
        repeatedReadsPerPath[path] = count;
        repeatedReadsTotal += (count - 1);
      }
    }
    const unclassifiedCount = kindCounts.unclassified || 0;
    const classificationReliability = toolCalls > 0
      ? Number(((toolCalls - unclassifiedCount) / toolCalls).toFixed(4))
      : 1;
    const runtimeMcp = runtimeMcpCalls.snapshot();
    const codegraphMcp = codegraphMcpCalls.snapshot();
    return {
      toolCalls,
      fullFileReads: kindCounts.full_file_read || 0,
      partialFileReads: kindCounts.partial_file_read || 0,
      gitDiffCalls: kindCounts.git_diff || 0,
      repeatedReadsPerPath,
      repeatedReadsTotal,
      uniqueFilesRead: readsPerPath.size,
      classifiedCounts: { ...kindCounts },
      unclassifiedCount,
      classificationReliability,
      // M2 #67 stage 1: per-call breakdown for the runtime MCP tools.
      // Empty arrays/zeros when no MCP tool fired (Phase A.0 fallback path,
      // Codex, small PRs that landed verdicts from the precomputed diff).
      runtimeMcpCalls: runtimeMcp.calls,
      runtimeMcpSummary: runtimeMcp.summary,
      // CodeGraph experiment: per-`codegraph_*`-tool counts. Empty/zero
      // when CodeGraph is not enabled for the review (codegraphMcpEnabled
      // === false in the request context). Proves adoption — if the
      // agent had the tools but didn't use them, callCount stays 0.
      codegraphMcpCalls: codegraphMcp.calls,
      codegraphMcpSummary: codegraphMcp.summary,
    };
  }

  function reset() {
    toolCalls = 0;
    kindCounts = createEmptyKindCounts();
    readsPerPath.clear();
    runtimeMcpCalls.reset();
    codegraphMcpCalls.reset();
  }

  return { onToolUse, snapshot, reset };
}
