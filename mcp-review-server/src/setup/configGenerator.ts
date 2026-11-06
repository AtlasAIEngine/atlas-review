import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  getAgentById,
  type AgentDefinition,
  type AgentGuidance,
  type AgentPathContext,
} from './agentRegistry.js';
import { resolvePreferredAgentConfigPath } from './pathResolver.js';
import { quoteTomlKey, tomlString } from './toml.js';
import { buildAgentWorkflowGuidance, buildAgentWorkflowGuidanceState } from './workflowGuidance.js';

export const DEFAULT_SETUP_BACKEND_URL = 'http://127.0.0.1:3000/api';
export const DEFAULT_SERVER_NAME = 'atlas-review';

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export type JsonServerEntry = McpServerEntry | Record<string, unknown>;

export interface GenerateAgentConfigOptions extends AgentPathContext {
  serverBinaryPath?: string;
  backendUrl?: string;
  command?: string;
  serverName?: string;
  configPath?: string;
}

export interface GeneratedAgentConfigOutput {
  agent: AgentDefinition;
  guidance: AgentGuidance;
  format: 'json' | 'toml';
  serverName: string;
  backendUrl: string;
  configPath: string;
  wrapperKey?: string;
  serverEntry: McpServerEntry;
  jsonServerEntry?: JsonServerEntry;
  snippet: string;
  jsonObject?: Record<string, unknown>;
}

export interface SetupCliCommandOptions {
  backendUrl?: string;
  serverName?: string;
}

function ensureHttpScheme(value: string): string {
  if (/^[A-Za-z][A-Za-z\d+\-.]*:\/\//.test(value)) {
    return value;
  }
  return `http://${value}`;
}

export function normalizeSetupBackendUrl(rawValue: string | undefined): string {
  const trimmed = String(rawValue || '').trim().replace(/\/+$/, '');
  if (!trimmed) return DEFAULT_SETUP_BACKEND_URL;

  const candidate = ensureHttpScheme(trimmed);

  try {
    const parsed = new URL(candidate);
    const protocol = parsed.protocol.toLowerCase();
    if (protocol !== 'http:' && protocol !== 'https:') {
      return candidate.replace(/\/+$/, '');
    }

    const normalizedPath = parsed.pathname.replace(/\/+$/, '');
    if (!normalizedPath || normalizedPath === '/') {
      parsed.pathname = '/api';
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString().replace(/\/+$/, '');
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return candidate.replace(/\/+$/, '');
  }
}

export function resolveServerBinaryPath(): string {
  return path.resolve(fileURLToPath(new URL('../../bin/atlas-review-mcp.js', import.meta.url)));
}

function renderSetupCliCommand(
  args: string[],
  options: SetupCliCommandOptions = {}
): string {
  const commandArgs = ['node', 'dist/bin/atlas-review-mcp.js', 'setup', ...args];
  const backendUrl = normalizeSetupBackendUrl(options.backendUrl);
  if (options.backendUrl !== undefined) {
    commandArgs.push(`--backend-url=${backendUrl}`);
  }
  const serverName = options.serverName?.trim();
  if (serverName && serverName !== DEFAULT_SERVER_NAME) {
    commandArgs.push(`--name=${serverName}`);
  }
  return commandArgs.join(' ');
}

export function buildAgentGuidance(
  agentId: string,
  options: SetupCliCommandOptions = {}
): AgentGuidance {
  const agent = getAgentById(agentId);
  if (!agent) {
    throw new Error(`Unsupported agent "${agentId}".`);
  }

  const recommendedCommands = {
    preferred: renderSetupCliCommand(
      agent.autoWriteSupported ? [`--agent=${agent.id}`] : [`--agent=${agent.id}`, '--json'],
      options
    ),
    dryRun: renderSetupCliCommand([`--agent=${agent.id}`, '--dry-run'], options),
    snippet: renderSetupCliCommand([`--agent=${agent.id}`, '--json'], options),
  };

  return {
    docsUrl: agent.docsUrl,
    supportStatus: agent.supportStatus,
    supportLabel: agent.supportLabel,
    restartHint: agent.restartHint,
    autoWriteSupported: agent.autoWriteSupported,
    recommendedCommands,
    workflowGuidance: buildAgentWorkflowGuidance(agent.id),
    workflowGuidanceState: buildAgentWorkflowGuidanceState(agent.id),
  };
}

export function buildSetupCliGuidance(options: SetupCliCommandOptions = {}) {
  return {
    list: renderSetupCliCommand(['--list'], options),
    auto: renderSetupCliCommand(['--auto'], options),
    autoDryRun: renderSetupCliCommand(['--auto', '--dry-run'], options),
  };
}

export function buildServerEntry(options: {
  serverBinaryPath?: string;
  backendUrl?: string;
  command?: string;
} = {}): McpServerEntry {
  const backendUrl = normalizeSetupBackendUrl(options.backendUrl);
  const serverBinaryPath = path.resolve(options.serverBinaryPath || resolveServerBinaryPath());
  return {
    command: options.command || 'node',
    args: [serverBinaryPath],
    env: {
      ATLAS_BACKEND_URL: backendUrl,
    },
  };
}

function buildJsonServerEntry(agentId: string, entry: McpServerEntry): JsonServerEntry {
  if (agentId === 'opencode') {
    return {
      type: 'local',
      command: [entry.command, ...entry.args],
      environment: entry.env,
      enabled: true,
    };
  }
  return entry;
}

export function renderTomlServerSection(serverName: string, entry: McpServerEntry): string {
  const quotedServerName = quoteTomlKey(serverName);
  const sectionPath = `mcp_servers.${quotedServerName}`;
  const argsValue = entry.args.map((item) => tomlString(item)).join(', ');
  const lines: string[] = [
    `[${sectionPath}]`,
    `command = ${tomlString(entry.command)}`,
    `args = [${argsValue}]`,
  ];

  const envEntries = Object.entries(entry.env || {}).filter(
    ([key, value]) => !!key && typeof value === 'string'
  );
  if (envEntries.length > 0) {
    lines.push('');
    lines.push(`[${sectionPath}.env]`);
    for (const [key, value] of envEntries.sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`${key} = ${tomlString(value)}`);
    }
  }

  return lines.join('\n');
}

async function resolveConfigPath(
  agent: AgentDefinition,
  options: GenerateAgentConfigOptions
): Promise<string> {
  if (options.configPath && options.configPath.trim()) {
    return path.resolve(options.configPath.trim());
  }

  const configPath = await resolvePreferredAgentConfigPath(agent.id, options);
  if (configPath) {
    return configPath;
  }

  throw new Error(`No verified config path is available for "${agent.displayName}" on platform "${options.platform || process.platform}".`);
}

export async function generateAgentConfigOutput(
  agentId: string,
  options: GenerateAgentConfigOptions = {}
): Promise<GeneratedAgentConfigOutput> {
  const agent = getAgentById(agentId);
  if (!agent) {
    throw new Error(`Unsupported agent "${agentId}".`);
  }

  const serverName = options.serverName || DEFAULT_SERVER_NAME;
  const serverEntry = buildServerEntry(options);
  const configPath = await resolveConfigPath(agent, options);
  const backendUrl = normalizeSetupBackendUrl(options.backendUrl);
  const guidance = buildAgentGuidance(agent.id, {
    backendUrl,
    serverName,
  });

  if (agent.format === 'json') {
    const wrapperKey = agent.wrapperKey || 'mcpServers';
    const jsonServerEntry = buildJsonServerEntry(agent.id, serverEntry);
    const jsonObject = {
      [wrapperKey]: {
        [serverName]: jsonServerEntry,
      },
    } as Record<string, unknown>;
    return {
      agent,
      guidance,
      format: agent.format,
      serverName,
      backendUrl,
      configPath,
      wrapperKey,
      serverEntry,
      jsonServerEntry,
      jsonObject,
      snippet: `${JSON.stringify(jsonObject, null, 2)}\n`,
    };
  }

  return {
    agent,
    guidance,
    format: agent.format,
    serverName,
    backendUrl,
    configPath,
    serverEntry,
    snippet: `${renderTomlServerSection(serverName, serverEntry)}\n`,
  };
}
