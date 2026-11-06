import type { AtlasApiClient } from '../client.js';
import type { AtlasConfig } from '../config.js';
import { LEGACY_TOOL_NAMES, TOOL_NAMES } from '../toolNames.js';
import type { ToolExecutionResult } from '../types.js';
import { runConfigGetTool } from './configGet.js';
import { runConfigSetStrategyTool } from './configSetStrategy.js';
import { runFileTool } from './file.js';
import { runGitHubPublicationsTool } from './githubPublications.js';
import { runGitHubPublishTool } from './githubPublish.js';
import { runLatestTool } from './latest.js';
import { runOutcomeClearTool } from './outcomeClear.js';
import { runOutcomeGetTool } from './outcomeGet.js';
import { runOutcomeSetTool } from './outcomeSet.js';
import { runQueueCancelTool } from './queueCancel.js';
import { runRunCurrentTool } from './runCurrent.js';
import { runStatusTool } from './status.js';
import { runWaitForTerminalTool } from './waitForTerminal.js';

export interface ToolDependencies {
  client: AtlasApiClient;
  config: AtlasConfig;
  cwd: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnlyHint?: boolean;
  handler: (args: Record<string, unknown>) => Promise<ToolExecutionResult>;
}

type ToolNameKey = keyof typeof TOOL_NAMES;
const PUBLIC_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/u;
const UNSUPPORTED_SCHEMA_KEYWORDS = new Set(['enum', 'oneOf', 'anyOf', 'allOf', 'not']);
const PROJECT_ID_SCHEMA = {
  type: 'string',
  description: 'Optional exact Atlas project id. Usually omit this so Atlas MCP auto-resolves the current git repository; do not guess from the repo name.',
};

export function createToolRegistry(deps: ToolDependencies): Map<string, ToolDefinition> {
  const tools: Array<ToolDefinition & { aliasKey: ToolNameKey }> = [
    {
      aliasKey: 'status',
      name: TOOL_NAMES.status,
      description: 'Get queue and lifecycle status for the current Atlas branch review context.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: PROJECT_ID_SCHEMA,
          reviewType: { type: 'string', enum: ['branch_review', 'workspace_review', 'pr_review'] },
          branchReviewId: { type: 'string' },
          workspaceReviewId: { type: 'string' },
          displayId: { type: 'string' },
          prReviewId: { type: 'string' },
          githubPrNumber: { type: 'number' },
        },
        additionalProperties: false,
      },
      readOnlyHint: true,
      handler: (args) => runStatusTool(deps.client, deps.config, deps.cwd, args),
    },
    {
      aliasKey: 'waitForTerminal',
      name: TOOL_NAMES.waitForTerminal,
      description: 'Wait for the resolved current review target to reach a terminal lifecycle state, then return the latest summary when available.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: PROJECT_ID_SCHEMA,
          reviewType: { type: 'string', enum: ['branch_review', 'workspace_review', 'pr_review'] },
          branchReviewId: { type: 'string' },
          workspaceReviewId: { type: 'string' },
          displayId: { type: 'string' },
          prReviewId: { type: 'string' },
          githubPrNumber: { type: 'number' },
          timeoutMs: { type: 'number' },
          pollIntervalMs: { type: 'number' },
        },
        additionalProperties: false,
      },
      readOnlyHint: true,
      handler: (args) => runWaitForTerminalTool(deps.client, deps.config, deps.cwd, args),
    },
    {
      aliasKey: 'githubPublications',
      name: TOOL_NAMES.githubPublications,
      description: 'List persisted GitHub publication state for a PR review.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: PROJECT_ID_SCHEMA,
          reviewType: { type: 'string', enum: ['pr_review'] },
          prReviewId: { type: 'string' },
          githubPrNumber: { type: 'number' },
        },
        additionalProperties: false,
      },
      readOnlyHint: true,
      handler: (args) => runGitHubPublicationsTool(deps.client, deps.config, deps.cwd, args),
    },
    {
      aliasKey: 'githubPublish',
      name: TOOL_NAMES.githubPublish,
      description: 'Publish the current PR review findings to GitHub as comment, approve, or request-changes review actions.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: PROJECT_ID_SCHEMA,
          reviewType: { type: 'string', enum: ['pr_review'] },
          prReviewId: { type: 'string' },
          githubPrNumber: { type: 'number' },
          action: { type: 'string', enum: ['comment', 'approve', 'request_changes'] },
          recommendationKeys: { type: 'array', items: { type: 'string' } },
          body: { type: 'string' },
        },
        required: ['action'],
        additionalProperties: false,
      },
      handler: (args) => runGitHubPublishTool(deps.client, deps.config, deps.cwd, args),
    },
    {
      aliasKey: 'latest',
      name: TOOL_NAMES.latest,
      description: 'Get the latest review summary, risk level, and top findings for current context, including short finding IDs, recommendation keys, and persisted outcomes.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: PROJECT_ID_SCHEMA,
          reviewType: { type: 'string', enum: ['branch_review', 'workspace_review', 'pr_review'] },
          branchReviewId: { type: 'string' },
          workspaceReviewId: { type: 'string' },
          displayId: { type: 'string' },
          prReviewId: { type: 'string' },
          githubPrNumber: { type: 'number' },
        },
        additionalProperties: false,
      },
      readOnlyHint: true,
      handler: (args) => runLatestTool(deps.client, deps.config, deps.cwd, args),
    },
    {
      aliasKey: 'configGet',
      name: TOOL_NAMES.configGet,
      description: 'Get current review strategy and active review provider/model context for the resolved project.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: PROJECT_ID_SCHEMA,
        },
        additionalProperties: false,
      },
      readOnlyHint: true,
      handler: (args) => runConfigGetTool(deps.client, deps.config, deps.cwd, args),
    },
    {
      aliasKey: 'configSetStrategy',
      name: TOOL_NAMES.configSetStrategy,
      description: 'Set review strategy via settings key route with strict strategy validation.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: PROJECT_ID_SCHEMA,
          strategy: { type: 'string', enum: ['smart', 'latency_first', 'max_quality', 'custom', 'adaptive'] },
        },
        required: ['strategy'],
        additionalProperties: false,
      },
      handler: (args) => runConfigSetStrategyTool(deps.client, deps.config, deps.cwd, args),
    },
    {
      aliasKey: 'file',
      name: TOOL_NAMES.file,
      description: 'Load before/after/patch content and matched findings for one file in the current review scope, including short finding IDs, recommendation keys, and persisted outcomes.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: PROJECT_ID_SCHEMA,
          reviewType: { type: 'string', enum: ['branch_review', 'workspace_review', 'pr_review'] },
          branchReviewId: { type: 'string' },
          workspaceReviewId: { type: 'string' },
          displayId: { type: 'string' },
          prReviewId: { type: 'string' },
          githubPrNumber: { type: 'number' },
          path: { type: 'string' },
        },
        required: ['path'],
        additionalProperties: false,
      },
      readOnlyHint: true,
      handler: (args) => runFileTool(deps.client, deps.config, deps.cwd, args),
    },
    {
      aliasKey: 'outcomeGet',
      name: TOOL_NAMES.outcomeGet,
      description: 'List persisted recommendation outcomes for the selected review scope.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: PROJECT_ID_SCHEMA,
          reviewType: { type: 'string', enum: ['branch_review', 'workspace_review', 'pr_review', 'changeset'] },
          branchReviewId: { type: 'string' },
          workspaceReviewId: { type: 'string' },
          displayId: { type: 'string' },
          prReviewId: { type: 'string' },
          githubPrNumber: { type: 'number' },
          changesetId: { type: 'string' },
        },
        additionalProperties: false,
      },
      readOnlyHint: true,
      handler: (args) => runOutcomeGetTool(deps.client, deps.config, deps.cwd, args),
    },
    {
      aliasKey: 'outcomeSet',
      name: TOOL_NAMES.outcomeSet,
      description: 'Persist addressed/dismissed recommendation outcome for the selected review scope by findingId or recommendationKey.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: PROJECT_ID_SCHEMA,
          reviewType: { type: 'string', enum: ['branch_review', 'workspace_review', 'pr_review', 'changeset'] },
          branchReviewId: { type: 'string' },
          workspaceReviewId: { type: 'string' },
          displayId: { type: 'string' },
          prReviewId: { type: 'string' },
          githubPrNumber: { type: 'number' },
          changesetId: { type: 'string' },
          status: { type: 'string', enum: ['addressed', 'dismissed'] },
          note: { type: 'string' },
          findingId: { type: 'string' },
          recommendationKey: { type: 'string' },
          filePath: { type: 'string' },
        },
        required: ['status'],
        additionalProperties: false,
      },
      handler: (args) => runOutcomeSetTool(deps.client, deps.config, deps.cwd, args),
    },
    {
      aliasKey: 'outcomeClear',
      name: TOOL_NAMES.outcomeClear,
      description: 'Clear one persisted recommendation outcome for the selected review scope by findingId or recommendationKey.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: PROJECT_ID_SCHEMA,
          reviewType: { type: 'string', enum: ['branch_review', 'workspace_review', 'pr_review', 'changeset'] },
          branchReviewId: { type: 'string' },
          workspaceReviewId: { type: 'string' },
          displayId: { type: 'string' },
          prReviewId: { type: 'string' },
          githubPrNumber: { type: 'number' },
          changesetId: { type: 'string' },
          findingId: { type: 'string' },
          recommendationKey: { type: 'string' },
        },
        additionalProperties: false,
      },
      handler: (args) => runOutcomeClearTool(deps.client, deps.config, deps.cwd, args),
    },
    {
      aliasKey: 'runCurrent',
      name: TOOL_NAMES.runCurrent,
      description: 'Queue (default) or immediately trigger review for the resolved current review target.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: PROJECT_ID_SCHEMA,
          reviewType: { type: 'string', enum: ['branch_review', 'workspace_review', 'pr_review'] },
          branchReviewId: { type: 'string' },
          workspaceReviewId: { type: 'string' },
          displayId: { type: 'string' },
          prReviewId: { type: 'string' },
          githubPrNumber: { type: 'number' },
          mode: { type: 'string', enum: ['queue', 'immediate'] },
          reviewMode: { type: 'string', enum: ['auto', 'full'] },
          scope: {
            type: 'object',
            properties: {
              includePatterns: { type: 'array', items: { type: 'string' } },
              excludePatterns: { type: 'array', items: { type: 'string' } },
              applyGlobalIgnorePatterns: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
        additionalProperties: false,
      },
      handler: (args) => runRunCurrentTool(deps.client, deps.config, deps.cwd, args),
    },
    {
      aliasKey: 'queueCancel',
      name: TOOL_NAMES.queueCancel,
      description: 'Cancel queued/running review work for the resolved current review target.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: PROJECT_ID_SCHEMA,
          reviewType: { type: 'string', enum: ['branch_review', 'workspace_review', 'pr_review'] },
          branchReviewId: { type: 'string' },
          workspaceReviewId: { type: 'string' },
          displayId: { type: 'string' },
          prReviewId: { type: 'string' },
          githubPrNumber: { type: 'number' },
        },
        additionalProperties: false,
      },
      handler: (args) => runQueueCancelTool(deps.client, deps.config, deps.cwd, args),
    },
  ];

  const registry = new Map<string, ToolDefinition>();
  for (const tool of tools) {
    const { aliasKey, ...definition } = tool;
    registry.set(definition.name, definition);
    const legacyName = LEGACY_TOOL_NAMES[aliasKey];
    if (legacyName) {
      registry.set(legacyName, {
        ...definition,
        name: legacyName,
        description: `${definition.description} Deprecated alias; prefer ${definition.name}.`,
      });
    }
  }
  return registry;
}

export function listAdvertisedTools(registry: Map<string, ToolDefinition>): ToolDefinition[] {
  const published = new Map<string, ToolDefinition>();
  for (const [name, definition] of registry.entries()) {
    if (!PUBLIC_TOOL_NAME_PATTERN.test(name)) continue;
    if (published.has(name)) continue;
    published.set(name, {
      ...definition,
      inputSchema: sanitizeAdvertisedSchema(definition.inputSchema),
    });
  }
  return Array.from(published.values());
}

function sanitizeAdvertisedSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return sanitizeSchemaNode(schema) as Record<string, unknown>;
}

function sanitizeSchemaNode(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((entry) => sanitizeSchemaNode(entry));
  }

  if (!node || typeof node !== 'object') {
    return node;
  }

  const input = node as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  let enumValues: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    if (key === 'enum' && Array.isArray(value)) {
      enumValues = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
      continue;
    }

    if (UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) {
      continue;
    }

    sanitized[key] = sanitizeSchemaNode(value);
  }

  if (enumValues.length > 0) {
    const enumDescription = `Allowed values: ${enumValues.join(', ')}.`;
    sanitized.description = typeof sanitized.description === 'string' && sanitized.description.trim().length > 0
      ? `${sanitized.description} ${enumDescription}`
      : enumDescription;
  }

  return sanitized;
}
