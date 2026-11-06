import fs from 'node:fs/promises';

import { getSupportedAgents, type AgentMcpConnectionState, type AgentPathContext, type DetectedAgent } from './agentRegistry.js';
import { buildAgentGuidance } from './configGenerator.js';
import { resolveAgentConfigPaths, findExistingAgentConfigPath } from './pathResolver.js';
import { findTomlSectionRanges, validateTomlDocument } from './toml.js';
import { resolveAgentWorkflowGuidanceState } from './workflowGuidance.js';

function hasOwnProperty(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

async function detectConfiguredInJson(
  filePath: string,
  wrapperKey: string | undefined,
  serverName: string
): Promise<{ configured: boolean; parseError: string | null }> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        configured: false,
        parseError: 'JSON root must be an object.',
      };
    }

    const wrapper = wrapperKey ? (parsed[wrapperKey] as unknown) : parsed;
    if (!wrapper || typeof wrapper !== 'object' || Array.isArray(wrapper)) {
      return { configured: false, parseError: null };
    }
    return { configured: hasOwnProperty(wrapper as object, serverName), parseError: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { configured: false, parseError: `Failed to parse JSON: ${message}` };
  }
}

async function detectConfiguredInToml(
  filePath: string,
  serverName: string
): Promise<{ configured: boolean; parseError: string | null }> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    validateTomlDocument(raw, filePath);
    const target = `mcp_servers.${serverName}`;
    const ranges = findTomlSectionRanges(raw);
    const configured = ranges.some((range) => range.name === target || range.name.startsWith(`${target}.`));
    return { configured, parseError: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { configured: false, parseError: `Failed to parse TOML: ${message}` };
  }
}

function buildMcpConnectionState(options: {
  parseError: string | null;
  isInstalled: boolean;
  alreadyConfigured: boolean;
}): AgentMcpConnectionState {
  if (options.parseError) {
    return { status: 'parse_error', label: 'Config parse error' };
  }
  if (options.alreadyConfigured) {
    return { status: 'configured', label: 'Connected now' };
  }
  if (options.isInstalled) {
    return { status: 'detected', label: 'Detected config path' };
  }
  return { status: 'not_detected', label: 'Config not detected yet' };
}

export async function detectInstalledAgents(
  context: AgentPathContext = {},
  options: { serverName?: string; backendUrl?: string } = {}
): Promise<DetectedAgent[]> {
  const serverName = options.serverName || 'atlas-review';
  const result: DetectedAgent[] = [];

  for (const agent of getSupportedAgents()) {
    const configPaths = resolveAgentConfigPaths(agent.id, context);
    const existingConfigPath = await findExistingAgentConfigPath(agent.id, context);
    const selectedConfigPath = existingConfigPath || configPaths[0] || '';
    let alreadyConfigured = false;
    let parseError: string | null = null;

    if (existingConfigPath) {
      if (agent.format === 'json') {
        const detected = await detectConfiguredInJson(existingConfigPath, agent.wrapperKey, serverName);
        alreadyConfigured = detected.configured;
        parseError = detected.parseError;
      } else {
        const detected = await detectConfiguredInToml(existingConfigPath, serverName);
        alreadyConfigured = detected.configured;
        parseError = detected.parseError;
      }
    }

    const guidance = buildAgentGuidance(agent.id, {
      backendUrl: options.backendUrl,
      serverName,
    });
    const workflowGuidanceState = await resolveAgentWorkflowGuidanceState(agent.id, context);

    result.push({
      id: agent.id,
      displayName: agent.displayName,
      format: agent.format,
      configScope: agent.configScope,
      docsUrl: guidance.docsUrl,
      wrapperKey: agent.wrapperKey,
      supportStatus: guidance.supportStatus,
      supportLabel: guidance.supportLabel,
      restartHint: guidance.restartHint,
      autoWriteSupported: guidance.autoWriteSupported,
      recommendedCommands: guidance.recommendedCommands,
      workflowGuidance: guidance.workflowGuidance,
      workflowGuidanceState,
      configPaths,
      selectedConfigPath,
      existingConfigPath,
      isInstalled: !!existingConfigPath,
      alreadyConfigured,
      parseError,
      mcpConnectionState: buildMcpConnectionState({
        parseError,
        isInstalled: !!existingConfigPath,
        alreadyConfigured,
      }),
    });
  }

  return result;
}
