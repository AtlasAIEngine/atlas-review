export interface AtlasConfig {
  backendUrl: string;
  apiToken: string | null;
  autoImport: boolean;
  requestTimeoutMs: number;
  toolCallTimeoutMs?: number;
  enableWatcherSync: boolean;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function ensureHttpScheme(value: string): string {
  if (/^[A-Za-z][A-Za-z\d+\-.]*:\/\//.test(value)) {
    return value;
  }
  return `http://${value}`;
}

export function normalizeBackendUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (!trimmed) {
    return 'http://localhost:3000/api';
  }

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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AtlasConfig {
  const backendUrl = normalizeBackendUrl(env.ATLAS_BACKEND_URL || 'http://localhost:3000/api');

  return {
    backendUrl,
    apiToken: env.ATLAS_API_TOKEN?.trim() || null,
    autoImport: parseBoolean(env.ATLAS_AUTO_IMPORT, false),
    requestTimeoutMs: parsePositiveInt(env.ATLAS_REQUEST_TIMEOUT_MS ?? env.ATLAS_REQUEST_TIMEOUT, 120_000),
    toolCallTimeoutMs: parsePositiveInt(
      env.ATLAS_TOOL_CALL_TIMEOUT_MS ?? env.ATLAS_MCP_TOOL_TIMEOUT_MS,
      120_000
    ),
    enableWatcherSync: parseBoolean(env.ATLAS_ENABLE_WATCHER_SYNC, false),
  };
}
