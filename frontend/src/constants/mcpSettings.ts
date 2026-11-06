export const MCP_AUTO_SELECTED_AGENTS_KEY = 'mcp_auto_selected_agents';

export function parseMcpSelectedAgents(raw: string | null | undefined): string[] {
  if (!raw || typeof raw !== 'string') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const normalized = parsed
      .map((entry) => String(entry || '').trim())
      .filter(Boolean);
    return [...new Set(normalized)];
  } catch {
    return [];
  }
}
