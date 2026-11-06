#!/usr/bin/env node
/**
 * Stdio entry point for the per-review runtime MCP server.
 *
 * Spawned by the agentic CLI per review via Claude Code's --mcp-config:
 *
 *   {
 *     "mcpServers": {
 *       "atlas-review-rt": {
 *         "command": "node",
 *         "args": ["<this file>"],
 *         "env": {
 *           "ATLAS_REVIEW_RT_PROJECT_PATH": "/abs/path/to/project",
 *           "ATLAS_REVIEW_RT_BASE_SHA": "<merge-base-sha>",
 *           "ATLAS_REVIEW_RT_HEAD_SHA": "<head-sha>"
 *         }
 *       }
 *     }
 *   }
 *
 * Lifetime is tied to the agentic CLI subprocess — when the CLI exits its
 * MCP transport, this process receives EOF on stdin and exits.
 */
import { runFromEnv } from './server.js';

runFromEnv().catch((err) => {
  // stderr only — stdout is the MCP transport.
  console.error('[atlas-review-rt] fatal:', err?.message || err);
  process.exit(1);
});
