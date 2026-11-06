import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { getAgentById, type AgentDefinition, type AgentId, type AgentPathContext } from './agentRegistry.js';

function resolveContext(context: AgentPathContext = {}): Required<AgentPathContext> {
  return {
    homeDir: context.homeDir || process.env.HOME || os.homedir(),
    cwd: context.cwd || process.cwd(),
    platform: context.platform || process.platform,
  };
}

function getClaudeDesktopPaths(homeDir: string, platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    return [path.join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')];
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    return [path.join(appData, 'Claude', 'claude_desktop_config.json')];
  }
  return [];
}

function getVsCodePaths(homeDir: string, cwd: string, platform: NodeJS.Platform): string[] {
  if (platform === 'darwin') {
    return [
      path.join(homeDir, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
      path.join(cwd, '.vscode', 'mcp.json'),
    ];
  }
  if (platform === 'win32') {
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    return [
      path.join(appData, 'Code', 'User', 'mcp.json'),
      path.join(cwd, '.vscode', 'mcp.json'),
    ];
  }
  return [
    path.join(homeDir, '.config', 'Code', 'User', 'mcp.json'),
    path.join(cwd, '.vscode', 'mcp.json'),
  ];
}

function getCursorPaths(homeDir: string, cwd: string, _platform: NodeJS.Platform): string[] {
  // Cursor loads MCP servers from `~/.cursor/mcp.json` (global) and
  // `<workspace>/.cursor/mcp.json` (project) on every platform. It does NOT
  // read `mcp.json` from the VS Code-style user data dir
  // (`~/Library/Application Support/Cursor/User/` etc.) — earlier versions of
  // this resolver wrote there, which produced "connected" false positives
  // while Cursor never picked up the server.
  return [
    path.join(homeDir, '.cursor', 'mcp.json'),
    path.join(cwd, '.cursor', 'mcp.json'),
  ];
}

function getGeminiPaths(homeDir: string): string[] {
  return [
    path.join(homeDir, '.gemini', 'settings.json'),
  ];
}

function getOpenCodePaths(homeDir: string): string[] {
  return [
    path.join(homeDir, '.config', 'opencode', 'opencode.json'),
    path.join(homeDir, '.config', 'opencode', 'opencode.jsonc'),
  ];
}

function resolveConfigPaths(agent: AgentDefinition, context: Required<AgentPathContext>): string[] {
  switch (agent.id) {
    case 'claude-code':
      return [
        path.join(context.homeDir, '.claude.json'),
        path.join(context.homeDir, '.claude', 'mcp.json'),
        path.join(context.cwd, '.mcp.json'),
      ];
    case 'claude-desktop':
      return getClaudeDesktopPaths(context.homeDir, context.platform);
    case 'vscode':
      return getVsCodePaths(context.homeDir, context.cwd, context.platform);
    case 'cursor':
      return getCursorPaths(context.homeDir, context.cwd, context.platform);
    case 'codex':
      return [path.join(context.homeDir, '.codex', 'config.toml')];
    case 'gemini':
      return getGeminiPaths(context.homeDir);
    case 'opencode':
      return getOpenCodePaths(context.homeDir);
    default:
      return [];
  }
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function resolveAgentConfigPaths(agentId: AgentId, context: AgentPathContext = {}): string[] {
  const resolved = resolveContext(context);
  const agent = getAgentById(agentId);
  if (!agent) return [];
  return resolveConfigPaths(agent, resolved);
}

export async function findExistingAgentConfigPath(agentId: AgentId, context: AgentPathContext = {}): Promise<string | null> {
  const configPaths = resolveAgentConfigPaths(agentId, context);
  for (const candidate of configPaths) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

export async function resolvePreferredAgentConfigPath(agentId: AgentId, context: AgentPathContext = {}): Promise<string> {
  const existingConfigPath = await findExistingAgentConfigPath(agentId, context);
  if (existingConfigPath) {
    return existingConfigPath;
  }
  return resolveAgentConfigPaths(agentId, context)[0] || '';
}
