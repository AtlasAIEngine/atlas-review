/**
 * Per-tool telemetry for the external CodeGraph MCP server's tools
 * (`mcp__codegraph__*`).
 *
 * Sibling to `runtimeMcpCallTelemetry.js`. Kept separate because the two
 * servers expose different tool shapes: atlas-review-rt has rich range
 * semantics (read_file_slice / get_hunk_context) for overlap/repeat-read
 * analysis; CodeGraph tools (search, callers, callees, ...) don't have
 * meaningful range overlap to compute, so a simpler counter is enough.
 *
 * Pure, no I/O. Subscribes to the same `onToolUse` callback that
 * `reviewToolUseTelemetry.js` already fans events into.
 *
 * Snapshot shape (returned alongside the per-call array):
 *
 *   {
 *     callCount: number,
 *     perTool: {
 *       codegraph_search, codegraph_context, codegraph_callers,
 *       codegraph_callees, codegraph_impact, codegraph_node,
 *       codegraph_explore, codegraph_status, codegraph_files,
 *     },
 *     unknownToolCount: number,
 *   }
 *
 * "unknownToolCount" surfaces calls to `mcp__codegraph__*` tools that
 * aren't in the known set (future CodeGraph releases may add tools).
 */

const CODEGRAPH_MCP_PREFIX = 'mcp__codegraph__';

const KNOWN_TOOLS = Object.freeze([
  'codegraph_search',
  'codegraph_context',
  'codegraph_callers',
  'codegraph_callees',
  'codegraph_impact',
  'codegraph_node',
  'codegraph_explore',
  'codegraph_status',
  'codegraph_files',
]);

function emptyPerTool() {
  const out = {};
  for (const tool of KNOWN_TOOLS) out[tool] = 0;
  return out;
}

export function createCodegraphMcpCallTelemetry() {
  /** @type {Array<{ tool: string, inputKeys: string[] }>} */
  const calls = [];
  const perTool = emptyPerTool();
  let unknownToolCount = 0;

  function onToolUse(event) {
    if (!event || event.type !== 'tool_use') return;
    const fullName = typeof event.name === 'string' ? event.name : '';
    if (!fullName.startsWith(CODEGRAPH_MCP_PREFIX)) return;
    const tool = fullName.slice(CODEGRAPH_MCP_PREFIX.length);
    const input = event.input && typeof event.input === 'object' ? event.input : {};
    const inputKeys = Object.keys(input);

    calls.push({ tool, inputKeys });
    if (Object.prototype.hasOwnProperty.call(perTool, tool)) {
      perTool[tool] += 1;
    } else {
      unknownToolCount += 1;
    }
  }

  function snapshot() {
    return {
      calls: calls.slice(),
      summary: {
        callCount: calls.length,
        perTool: { ...perTool },
        unknownToolCount,
      },
    };
  }

  function reset() {
    calls.length = 0;
    for (const tool of KNOWN_TOOLS) perTool[tool] = 0;
    unknownToolCount = 0;
  }

  return { onToolUse, snapshot, reset };
}

export const __testables = {
  CODEGRAPH_MCP_PREFIX,
  KNOWN_TOOLS,
};
