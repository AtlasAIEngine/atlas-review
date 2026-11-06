import os from 'node:os';

import {
  getAgentById,
  getAutoWriteAgents,
  getSupportedAgents,
  type AgentId,
  type AgentPathContext,
} from './agentRegistry.js';
import { detectInstalledAgents } from './detector.js';
import {
  buildAgentGuidance,
  buildSetupCliGuidance,
  DEFAULT_SERVER_NAME,
  generateAgentConfigOutput,
  normalizeSetupBackendUrl,
  resolveServerBinaryPath,
} from './configGenerator.js';
import { removeAgentConfig, writeAgentConfig } from './configWriter.js';
import { resolveAgentConfigPaths } from './pathResolver.js';
import {
  buildSetupSeparationSummary,
  buildWorkflowPolicySummary,
  installAgentWorkflowGuidance,
  removeAgentWorkflowGuidance,
  resolveAgentWorkflowGuidanceState,
  supportsManagedWorkflowGuidance,
} from './workflowGuidance.js';

export interface SetupRuntimeOptions extends AgentPathContext {
  serverName?: string;
}

export interface SetupApplyOptions extends SetupRuntimeOptions {
  backendUrl?: string;
  configPath?: string;
  dryRun?: boolean;
}

export interface SetupApplyAutoOptions extends SetupApplyOptions {
  targetAgentIds?: string[];
}

export interface SetupSyncOptions extends SetupApplyOptions {
  selectedAgentIds?: string[];
  removeUnselected?: boolean;
}

export interface SetupManagedRemovalOptions extends SetupApplyOptions {}

export interface SetupWorkflowGuidanceInstallOptions extends SetupRuntimeOptions {
  dryRun?: boolean;
}

function resolveRuntimeOptions(options: SetupRuntimeOptions = {}): Required<SetupRuntimeOptions> {
  return {
    homeDir: options.homeDir || process.env.HOME || os.homedir(),
    cwd: options.cwd || process.cwd(),
    platform: options.platform || process.platform,
    serverName: options.serverName || DEFAULT_SERVER_NAME,
  };
}

async function removeAgentConfigFromAllPaths(
  agentId: AgentId,
  options: SetupApplyOptions,
  resolved: Required<SetupRuntimeOptions>
) {
  const explicitConfigPath = typeof options.configPath === 'string' && options.configPath.trim()
    ? [options.configPath.trim()]
    : [];
  const discoveredConfigPaths = resolveAgentConfigPaths(agentId, resolved);
  const uniqueConfigPaths = [...new Set([...explicitConfigPath, ...discoveredConfigPaths])];
  const results: Array<Awaited<ReturnType<typeof removeAgentConfig>>> = [];

  for (const configPath of uniqueConfigPaths) {
    const result = await removeAgentConfig({
      agentId,
      backendUrl: options.backendUrl,
      configPath,
      dryRun: !!options.dryRun,
      cwd: resolved.cwd,
      homeDir: resolved.homeDir,
      platform: resolved.platform,
      serverName: resolved.serverName,
    });
    results.push(result);
  }

  return results;
}

export async function listAgentDetection(options: SetupRuntimeOptions = {}) {
  const resolved = resolveRuntimeOptions(options);
  return detectInstalledAgents(resolved, {
    serverName: resolved.serverName,
    backendUrl: (options as SetupRuntimeOptions & { backendUrl?: string }).backendUrl,
  });
}

export function listSupportedAgentMetadata(
  options: SetupRuntimeOptions & { backendUrl?: string } = {}
) {
  const resolved = resolveRuntimeOptions(options);
  const backendUrl = normalizeSetupBackendUrl(options.backendUrl);
  return getSupportedAgents().map((agent) => {
    const guidance = buildAgentGuidance(agent.id, {
      backendUrl,
      serverName: resolved.serverName,
    });
    return {
      id: agent.id,
      displayName: agent.displayName,
      format: agent.format,
      configScope: agent.configScope,
      docsUrl: guidance.docsUrl,
      wrapperKey: agent.wrapperKey || null,
      supportStatus: guidance.supportStatus,
      supportLabel: guidance.supportLabel,
      restartHint: guidance.restartHint,
      autoWriteSupported: guidance.autoWriteSupported,
      recommendedCommands: guidance.recommendedCommands,
      workflowGuidance: guidance.workflowGuidance,
      workflowGuidanceState: guidance.workflowGuidanceState,
    };
  });
}

export async function getAgentConfigSnippet(
  agentId: string,
  options: SetupRuntimeOptions & {
    backendUrl?: string;
    serverName?: string;
    configPath?: string;
  } = {}
) {
  const resolved = resolveRuntimeOptions(options);
  const backendUrl = normalizeSetupBackendUrl(options.backendUrl);
  const output = await generateAgentConfigOutput(agentId, {
    ...resolved,
    configPath: options.configPath,
    backendUrl,
    serverName: resolved.serverName,
  });
  const workflowGuidanceState = await resolveAgentWorkflowGuidanceState(output.agent.id, resolved);
  return {
    agent: {
      id: output.agent.id,
      displayName: output.agent.displayName,
      format: output.agent.format,
      configScope: output.agent.configScope,
      docsUrl: output.guidance.docsUrl,
      wrapperKey: output.wrapperKey || null,
      supportStatus: output.guidance.supportStatus,
      supportLabel: output.guidance.supportLabel,
      restartHint: output.guidance.restartHint,
      autoWriteSupported: output.guidance.autoWriteSupported,
      recommendedCommands: output.guidance.recommendedCommands,
      workflowGuidance: output.guidance.workflowGuidance,
      workflowGuidanceState,
    },
    backendUrl,
    serverName: output.serverName,
    configPath: output.configPath,
    snippet: output.snippet,
    jsonObject: output.jsonObject || null,
    serverEntry: output.serverEntry,
  };
}

export async function applyAgentConfig(
  agentId: string,
  options: SetupApplyOptions = {}
) {
  const agent = getAgentById(agentId);
  if (!agent) {
    throw new Error(`Unsupported agent "${agentId}".`);
  }

  const resolved = resolveRuntimeOptions(options);
  const backendUrl = normalizeSetupBackendUrl(options.backendUrl);
  const result = await writeAgentConfig({
    agentId: agent.id,
    backendUrl,
    configPath: options.configPath,
    dryRun: !!options.dryRun,
    cwd: resolved.cwd,
    homeDir: resolved.homeDir,
    platform: resolved.platform,
    serverName: resolved.serverName,
  });

  if (supportsManagedWorkflowGuidance(agent.id)) {
    const workflowGuidanceResult = await installAgentWorkflowGuidance(agent.id, {
      dryRun: !!options.dryRun,
      cwd: resolved.cwd,
      homeDir: resolved.homeDir,
      platform: resolved.platform,
    });
    return {
      ...result,
      workflowGuidanceResult,
    };
  }

  return result;
}

export async function applyAutoSetup(options: SetupApplyAutoOptions = {}) {
  const resolved = resolveRuntimeOptions(options);
  const backendUrl = normalizeSetupBackendUrl(options.backendUrl);
  const detected = await detectInstalledAgents(resolved, {
    serverName: resolved.serverName,
  });

  const requestedIds: AgentId[] = [];
  if (Array.isArray(options.targetAgentIds)) {
    for (const value of options.targetAgentIds) {
      const normalized = String(value || '').trim();
      if (!normalized) continue;
      const agent = getAgentById(normalized);
      if (!agent) continue;
      if (!requestedIds.includes(agent.id)) {
        requestedIds.push(agent.id);
      }
    }
  }
  const autoDetectedIds = detected.filter((entry) => entry.isInstalled).map((entry) => entry.id);
  const autoWriteSet = new Set(getAutoWriteAgents().map((agent) => agent.id));

  const targetAgentIds: AgentId[] = requestedIds.length > 0
    ? requestedIds
    : autoDetectedIds.filter((agentId) => autoWriteSet.has(agentId));
  if (targetAgentIds.length === 0) {
    targetAgentIds.push('codex');
  }

  const results: Array<Awaited<ReturnType<typeof writeAgentConfig>>> = [];
  const failures: Array<{ agentId: string; message: string }> = [];
  for (const agentId of targetAgentIds) {
    try {
      const result = await writeAgentConfig({
        agentId,
        backendUrl,
        configPath: options.configPath,
        dryRun: !!options.dryRun,
        cwd: resolved.cwd,
        homeDir: resolved.homeDir,
        platform: resolved.platform,
        serverName: resolved.serverName,
      });
      results.push(result);
      if (supportsManagedWorkflowGuidance(agentId)) {
        await installAgentWorkflowGuidance(agentId, {
          dryRun: !!options.dryRun,
          cwd: resolved.cwd,
          homeDir: resolved.homeDir,
          platform: resolved.platform,
        });
      }
    } catch (error) {
      failures.push({
        agentId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    backendUrl,
    serverName: resolved.serverName,
    targetAgentIds,
    detectedAgents: detected,
    results,
    failures,
  };
}

export async function installWorkflowGuidance(
  agentId: string,
  options: SetupWorkflowGuidanceInstallOptions = {},
) {
  if (!getAgentById(agentId)) {
    throw new Error(`Unsupported agent "${agentId}".`);
  }

  const resolved = resolveRuntimeOptions(options);
  return installAgentWorkflowGuidance(agentId, {
    ...resolved,
    dryRun: !!options.dryRun,
  });
}

export async function removeWorkflowGuidance(
  agentId: string,
  options: SetupWorkflowGuidanceInstallOptions = {},
) {
  if (!getAgentById(agentId)) {
    throw new Error(`Unsupported agent "${agentId}".`);
  }

  const resolved = resolveRuntimeOptions(options);
  return removeAgentWorkflowGuidance(agentId, {
    ...resolved,
    dryRun: !!options.dryRun,
  });
}

function resolveAgentIdSelection(rawValues: string[] | undefined): AgentId[] {
  const selected: AgentId[] = [];
  if (!Array.isArray(rawValues)) return selected;
  for (const value of rawValues) {
    const normalized = String(value || '').trim();
    if (!normalized) continue;
    const agent = getAgentById(normalized);
    if (!agent) continue;
    if (!selected.includes(agent.id)) {
      selected.push(agent.id);
    }
  }
  return selected;
}

export async function syncAgentSetup(options: SetupSyncOptions = {}) {
  const resolved = resolveRuntimeOptions(options);
  const backendUrl = normalizeSetupBackendUrl(options.backendUrl);
  const removeUnselected = options.removeUnselected === true;
  const selectedAgentIds = resolveAgentIdSelection(options.selectedAgentIds);
  const autoWriteSet = new Set(getAutoWriteAgents().map((agent) => agent.id));
  const writableSelectedAgentIds = selectedAgentIds.filter((agentId) => autoWriteSet.has(agentId));
  const blockedSelectedAgentIds = selectedAgentIds.filter((agentId) => !autoWriteSet.has(agentId));
  const supportedAgentIds = getSupportedAgents().map((agent) => agent.id);

  if (removeUnselected && writableSelectedAgentIds.length === 0) {
    throw new Error(
      'syncAgentSetup with removeUnselected=true requires at least one shipped auto-write selectedAgentId; refusing to remove all shipped agent configs.'
    );
  }

  const appliedResults: Array<Awaited<ReturnType<typeof writeAgentConfig>>> = [];
  const removedResults: Array<Awaited<ReturnType<typeof removeAgentConfig>>> = [];
  const failures: Array<{ agentId: string; action: 'apply' | 'remove'; message: string }> = [];

  for (const agentId of blockedSelectedAgentIds) {
    failures.push({
      agentId,
      action: 'apply',
      message: 'This agent is manual-snippet-only and cannot be auto-written by Atlas.',
    });
  }

  for (const agentId of writableSelectedAgentIds) {
    try {
      const result = await writeAgentConfig({
        agentId,
        backendUrl,
        configPath: options.configPath,
        dryRun: !!options.dryRun,
        cwd: resolved.cwd,
        homeDir: resolved.homeDir,
        platform: resolved.platform,
        serverName: resolved.serverName,
      });
      appliedResults.push(result);
      if (supportsManagedWorkflowGuidance(agentId)) {
        await installAgentWorkflowGuidance(agentId, {
          dryRun: !!options.dryRun,
          cwd: resolved.cwd,
          homeDir: resolved.homeDir,
          platform: resolved.platform,
        });
      }
    } catch (error) {
      failures.push({
        agentId,
        action: 'apply',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (removeUnselected) {
    const selectedSet = new Set(writableSelectedAgentIds);
    const toRemove = getAutoWriteAgents()
      .map((agent) => agent.id)
      .filter((agentId) => !selectedSet.has(agentId));
    for (const agentId of toRemove) {
      try {
        if (supportsManagedWorkflowGuidance(agentId)) {
          await removeAgentWorkflowGuidance(agentId, {
            dryRun: !!options.dryRun,
            cwd: resolved.cwd,
            homeDir: resolved.homeDir,
            platform: resolved.platform,
          });
        }
        const results = await removeAgentConfigFromAllPaths(agentId, {
          backendUrl,
          configPath: options.configPath,
          dryRun: !!options.dryRun,
        }, resolved);
        removedResults.push(...results);
      } catch (error) {
        failures.push({
          agentId,
          action: 'remove',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    backendUrl,
    serverName: resolved.serverName,
    selectedAgentIds: writableSelectedAgentIds,
    supportedAgentIds,
    removeUnselected,
    appliedResults,
    removedResults,
    failures,
  };
}

export async function removeManagedIntegrations(options: SetupManagedRemovalOptions = {}) {
  const resolved = resolveRuntimeOptions(options);
  const backendUrl = normalizeSetupBackendUrl(options.backendUrl);
  const targetAgentIds = getAutoWriteAgents().map((agent) => agent.id);
  const removedResults: Array<Awaited<ReturnType<typeof removeAgentConfig>>> = [];
  const workflowGuidanceResults: Array<Awaited<ReturnType<typeof removeAgentWorkflowGuidance>>> = [];
  const failures: Array<{ agentId: string; action: 'remove_config' | 'remove_workflow_guidance'; message: string }> = [];

  for (const agentId of targetAgentIds) {
    if (supportsManagedWorkflowGuidance(agentId)) {
      try {
        const result = await removeAgentWorkflowGuidance(agentId, {
          dryRun: !!options.dryRun,
          cwd: resolved.cwd,
          homeDir: resolved.homeDir,
          platform: resolved.platform,
        });
        workflowGuidanceResults.push(result);
      } catch (error) {
        failures.push({
          agentId,
          action: 'remove_workflow_guidance',
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      const results = await removeAgentConfigFromAllPaths(agentId, {
        backendUrl,
        configPath: options.configPath,
        dryRun: !!options.dryRun,
      }, resolved);
      removedResults.push(...results);
    } catch (error) {
      failures.push({
        agentId,
        action: 'remove_config',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    backendUrl,
    serverName: resolved.serverName,
    targetAgentIds,
    removedResults,
    workflowGuidanceResults,
    failures,
  };
}

export function getSetupRuntimeStatus(
  options: SetupRuntimeOptions & { backendUrl?: string } = {}
) {
  const resolved = resolveRuntimeOptions(options);
  const backendUrl = normalizeSetupBackendUrl(options.backendUrl);
  return {
    serverNameDefault: DEFAULT_SERVER_NAME,
    serverBinaryPath: resolveServerBinaryPath(),
    recommendedCommands: buildSetupCliGuidance({
      backendUrl,
      serverName: resolved.serverName,
    }),
    setupSeparationSummary: buildSetupSeparationSummary(),
    workflowPolicySummary: buildWorkflowPolicySummary(),
    remediation: 'Build the MCP server, inspect detected agents, then sync the shipped agents you want Atlas to manage. Settings and the desktop wizard apply the same Atlas-managed global bundle for supported agents.',
  };
}

export function isAgentSupported(agentId: string): boolean {
  return !!getAgentById(agentId);
}
