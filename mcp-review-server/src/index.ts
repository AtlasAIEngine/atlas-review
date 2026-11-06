import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { AtlasApiClient } from './client.js';
import { loadConfig } from './config.js';
import { toAtlasMcpError } from './errors.js';
import { createPromptRegistry } from './prompts/index.js';
import { createResourceRegistry } from './resources/index.js';
import { createToolRegistry, listAdvertisedTools } from './tools/index.js';

export async function startServer(): Promise<void> {
  const config = loadConfig();
  const client = new AtlasApiClient(config);

  const server = new Server(
    {
      name: 'atlas-review-mcp',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
        prompts: {},
        resources: {},
      },
    }
  );

  const deps = {
    client,
    config,
    cwd: process.cwd(),
  };
  const tools = createToolRegistry(deps);
  const prompts = createPromptRegistry(deps);
  const resources = createResourceRegistry(deps);

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listAdvertisedTools(tools).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: {
        readOnlyHint: tool.readOnlyHint ?? false,
      },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.get(request.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
      };
    }

    try {
      const args = asObject(request.params.arguments);
      const result = await tool.handler(args);

      return {
        content: [{ type: 'text', text: result.summary }],
        structuredContent: {
          data: result.data,
          nextActions: result.nextActions || [],
        },
      } as any;
    } catch (error) {
      const mapped = toAtlasMcpError(error);
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `[${mapped.code}] ${mapped.message}`,
          },
        ],
        structuredContent: {
          code: mapped.code,
          message: mapped.message,
          details: mapped.details ?? null,
        },
      } as any;
    }
  });

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: Array.from(prompts.values()).map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      arguments: prompt.arguments,
    })),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const prompt = prompts.get(request.params.name);
    if (!prompt) {
      throw new Error(`Unknown prompt: ${request.params.name}`);
    }

    try {
      const args = asStringRecord(request.params.arguments);
      const result = await prompt.handler(args);
      return {
        description: result.description || prompt.description,
        messages: result.messages.map((message) => ({
          role: message.role,
          content: {
            type: 'text',
            text: message.text,
          },
        })),
      };
    } catch (error) {
      const mapped = toAtlasMcpError(error);
      throw new Error(`[${mapped.code}] ${mapped.message}`);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: Array.from(resources.values()).map((resource) => ({
      uri: resource.uri,
      name: resource.name,
      description: resource.description,
      mimeType: resource.mimeType || 'application/json',
    })),
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const resource = resources.get(request.params.uri);
    if (!resource) {
      throw new Error(`Unknown resource: ${request.params.uri}`);
    }

    try {
      const result = await resource.handler();
      return {
        contents: [
          {
            uri: resource.uri,
            mimeType: resource.mimeType || 'application/json',
            text: JSON.stringify(
              {
                uri: resource.uri,
                summary: result.summary,
                data: result.data,
              },
              null,
              2
            ),
          },
          {
            uri: resource.uri,
            mimeType: 'text/plain',
            text: result.summary,
          },
        ],
      };
    } catch (error) {
      const mapped = toAtlasMcpError(error);
      throw new Error(`[${mapped.code}] ${mapped.message}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function asObject(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }
  return input as Record<string, unknown>;
}

function asStringRecord(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {};
  }

  const args: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === 'string') {
      args[key] = value;
    }
  }
  return args;
}
