export type AgentId = 'claude-code' | 'claude-desktop' | 'vscode' | 'cursor' | 'codex' | 'gemini' | 'opencode';
export type AgentFormat = 'json' | 'toml';
export type AgentSupportStatus = 'shipped' | 'experimental' | 'deferred';
export type AgentSupportLabel = 'Shipped auto-write' | 'Manual snippet only';
export type AgentMcpConnectionStatus = 'configured' | 'detected' | 'not_detected' | 'parse_error';
export type AgentWorkflowGuidanceStatus = 'installed' | 'not_installed' | 'manual_install_required' | 'not_supported';

export interface AgentRecommendedCommands {
  preferred: string;
  dryRun: string;
  snippet: string;
}

export interface AgentWorkflowGuidance {
  strategyId: 'codex_global_skill' | 'claude_global_guidance' | 'opencode_global_skill';
  title: string;
  defaultSummary: string;
  installSummary: string;
  installSteps: string[];
  snippetLabel: string;
  snippet: string;
  overrideSummary: string;
  fallbackSummary: string;
}

export interface AgentMcpConnectionState {
  status: AgentMcpConnectionStatus;
  label: string;
}

export interface AgentWorkflowGuidanceState {
  status: AgentWorkflowGuidanceStatus;
  label: string;
  summary: string;
  detectedPath?: string | null;
}

export interface AgentGuidance {
  docsUrl: string;
  supportStatus: AgentSupportStatus;
  supportLabel: AgentSupportLabel;
  restartHint: string;
  autoWriteSupported: boolean;
  recommendedCommands: AgentRecommendedCommands;
  workflowGuidance: AgentWorkflowGuidance | null;
  workflowGuidanceState: AgentWorkflowGuidanceState;
}

export interface AgentPathContext {
  homeDir?: string;
  cwd?: string;
  platform?: NodeJS.Platform;
}

export interface AgentDefinition {
  id: AgentId;
  displayName: string;
  format: AgentFormat;
  configScope: 'user' | 'workspace';
  docsUrl: string;
  wrapperKey?: 'mcpServers' | 'servers' | 'mcp';
  supportStatus: AgentSupportStatus;
  supportLabel: AgentSupportLabel;
  restartHint: string;
  autoWriteSupported: boolean;
}

export interface DetectedAgent {
  id: AgentId;
  displayName: string;
  format: AgentFormat;
  configScope: 'user' | 'workspace';
  docsUrl: string;
  wrapperKey?: string;
  supportStatus: AgentSupportStatus;
  supportLabel: AgentSupportLabel;
  restartHint: string;
  autoWriteSupported: boolean;
  recommendedCommands: AgentRecommendedCommands;
  workflowGuidance: AgentWorkflowGuidance | null;
  workflowGuidanceState: AgentWorkflowGuidanceState;
  configPaths: string[];
  selectedConfigPath: string;
  existingConfigPath: string | null;
  isInstalled: boolean;
  alreadyConfigured: boolean;
  parseError: string | null;
  mcpConnectionState: AgentMcpConnectionState;
}

export const SUPPORTED_AGENTS: AgentDefinition[] = [
  {
    id: 'codex',
    displayName: 'Codex',
    format: 'toml',
    configScope: 'user',
    docsUrl: 'https://developers.openai.com/resources/docs-mcp',
    supportStatus: 'shipped',
    supportLabel: 'Shipped auto-write',
    restartHint: 'Restart Codex session.',
    autoWriteSupported: true,
  },
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    format: 'json',
    configScope: 'user',
    docsUrl: 'https://code.claude.com/docs/en/mcp',
    wrapperKey: 'mcpServers',
    supportStatus: 'shipped',
    supportLabel: 'Shipped auto-write',
    restartHint: 'Restart Claude Code session or run /mcp reconnect.',
    autoWriteSupported: true,
  },
  {
    id: 'gemini',
    displayName: 'Gemini CLI',
    format: 'json',
    configScope: 'user',
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
    wrapperKey: 'mcpServers',
    supportStatus: 'shipped',
    supportLabel: 'Shipped auto-write',
    restartHint: 'Restart Gemini CLI session.',
    autoWriteSupported: true,
  },
  {
    id: 'opencode',
    displayName: 'OpenCode',
    format: 'json',
    configScope: 'user',
    docsUrl: 'https://opencode.ai/docs/mcp-servers/',
    wrapperKey: 'mcp',
    supportStatus: 'shipped',
    supportLabel: 'Shipped auto-write',
    restartHint: 'Restart the active OpenCode session.',
    autoWriteSupported: true,
  },
  {
    id: 'claude-desktop',
    displayName: 'Claude Desktop',
    format: 'json',
    configScope: 'user',
    docsUrl: 'https://modelcontextprotocol.io/docs/develop/connect-local-servers',
    wrapperKey: 'mcpServers',
    supportStatus: 'shipped',
    supportLabel: 'Shipped auto-write',
    restartHint: 'Fully quit and reopen Claude Desktop.',
    autoWriteSupported: true,
  },
  {
    id: 'vscode',
    displayName: 'VS Code',
    format: 'json',
    configScope: 'user',
    docsUrl: 'https://code.visualstudio.com/docs/copilot/customization/mcp-servers',
    wrapperKey: 'servers',
    supportStatus: 'shipped',
    supportLabel: 'Shipped auto-write',
    restartHint: 'Reload VS Code window.',
    autoWriteSupported: true,
  },
  {
    id: 'cursor',
    displayName: 'Cursor',
    format: 'json',
    configScope: 'user',
    docsUrl: 'https://docs.cursor.com/context/model-context-protocol',
    wrapperKey: 'mcpServers',
    supportStatus: 'experimental',
    supportLabel: 'Manual snippet only',
    restartHint: 'Reload Cursor window if snippet tools do not appear immediately.',
    autoWriteSupported: false,
  },
];

export function getSupportedAgents(): AgentDefinition[] {
  return [...SUPPORTED_AGENTS];
}

export function getAgentById(agentId: string): AgentDefinition | undefined {
  return SUPPORTED_AGENTS.find((agent) => agent.id === agentId);
}

export function getAutoWriteAgents(): AgentDefinition[] {
  return SUPPORTED_AGENTS.filter((agent) => agent.autoWriteSupported);
}
