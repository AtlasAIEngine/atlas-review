import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { isValidSha } from './gitOps.js';
import {
  getDiffForFileSchema,
  createGetDiffForFileHandler,
} from './tools/getDiffForFile.js';
import {
  readFileSliceSchema,
  createReadFileSliceHandler,
} from './tools/readFileSlice.js';
import {
  getHunkContextSchema,
  createGetHunkContextHandler,
} from './tools/getHunkContext.js';

export const SERVER_NAME = 'atlas-review-rt';
export const SERVER_VERSION = '0.1.0';

/**
 * Build the runtime MCP Server with tool handlers wired in. Pure constructor
 * — does not call `connect()`. The caller (the bin script in production,
 * tests in unit tests) decides on transport.
 *
 * Required config:
 *   - projectRoot: absolute path to the review's project (used as cwd for git)
 *   - mergeBaseSha: SHA used as the base of the diff range
 *   - headSha:      SHA used as the head of the diff range and for `git show`
 */
export function buildRuntimeMcpServer(config) {
  const { projectRoot, mergeBaseSha, headSha } = config || {};
  if (typeof projectRoot !== 'string' || projectRoot.length === 0) {
    throw new Error('projectRoot is required');
  }
  if (!isValidSha(mergeBaseSha)) {
    throw new Error('mergeBaseSha must be a valid hex SHA');
  }
  if (!isValidSha(headSha)) {
    throw new Error('headSha must be a valid hex SHA');
  }

  const handlers = {
    [getDiffForFileSchema.name]: createGetDiffForFileHandler({ projectRoot, mergeBaseSha, headSha }),
    [readFileSliceSchema.name]: createReadFileSliceHandler({ projectRoot, headSha }),
    [getHunkContextSchema.name]: createGetHunkContextHandler({ projectRoot, headSha }),
  };
  const schemas = [getDiffForFileSchema, readFileSliceSchema, getHunkContextSchema];

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: schemas.map((s) => ({
      name: s.name,
      description: s.description,
      inputSchema: s.inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req?.params?.name;
    const handler = name ? handlers[name] : null;
    if (!handler) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${name}` }],
      };
    }
    try {
      return await handler(req.params.arguments || {});
    } catch (err) {
      return {
        isError: true,
        content: [{ type: 'text', text: `${name} failed: ${err?.message || String(err)}` }],
      };
    }
  });

  return server;
}

/**
 * Read the runtime config from env vars. Used by the bin entry point. Tests
 * pass config explicitly to `buildRuntimeMcpServer`.
 */
export function readRuntimeConfigFromEnv(env = process.env) {
  return {
    projectRoot: env.ATLAS_REVIEW_RT_PROJECT_PATH,
    mergeBaseSha: env.ATLAS_REVIEW_RT_BASE_SHA,
    headSha: env.ATLAS_REVIEW_RT_HEAD_SHA,
  };
}

/**
 * Production entry: read env, build server, connect stdio. Awaitable so the
 * bin script can `await runFromEnv()` without losing unhandled rejections.
 */
export async function runFromEnv(env = process.env) {
  const server = buildRuntimeMcpServer(readRuntimeConfigFromEnv(env));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}
