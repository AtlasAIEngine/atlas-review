import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Reads the discovery file that the AtlasEngine desktop app publishes on
 * startup at `<app_data_dir>/backend-port.json`. This lets the MCP client
 * find the current backend port across app restarts — and heal stale
 * `ATLAS_BACKEND_URL` values written by earlier setup runs.
 *
 * File contract (schema v1) matches the writer in
 * `apps/desktop/src-tauri/src/discovery.rs`:
 * ```json
 * {
 *   "schemaVersion": 1,
 *   "host": "127.0.0.1",
 *   "port": 52779,
 *   "pid": 1234,
 *   "startedAt": "...",
 *   "appVersion": "0.24.6"
 * }
 * ```
 */

const DESKTOP_BUNDLE_ID = 'com.atlasengine.desktop';
const DISCOVERY_FILE_NAME = 'backend-port.json';
const SUPPORTED_SCHEMA_VERSIONS = new Set<number>([1]);

export interface DiscoveryEntry {
  schemaVersion: number;
  host: string;
  port: number;
  pid: number;
  startedAt: string;
  appVersion: string;
}

export interface DiscoveryResult {
  entry: DiscoveryEntry;
  url: string;
  source: 'discovery';
  path: string;
}

export interface DesktopDiscoveryOptions {
  /** Override the resolved app data dir. Primary hook for tests and dev. */
  dataDir?: string;
  /** Override the default bundle id when computing the OS-specific dir. */
  bundleId?: string;
  /** Inject a custom pid-alive check. Defaults to `process.kill(pid, 0)`. */
  isProcessAlive?: (pid: number) => boolean;
  /** Inject a custom readFileSync (for tests). */
  readFileSync?: (filePath: string) => string;
  /** Override `os.platform()` for tests. */
  platform?: NodeJS.Platform;
  /** Override `os.homedir()` for tests. */
  homedir?: string;
  /** Override the env for resolving `ATLAS_DESKTOP_DATA_DIR`, `XDG_DATA_HOME`, `APPDATA`. */
  env?: NodeJS.ProcessEnv;
}

export function resolveDesktopDataDir(options: DesktopDiscoveryOptions = {}): string {
  const env = options.env ?? process.env;
  const override = env.ATLAS_DESKTOP_DATA_DIR?.trim();
  if (override) return override;

  if (options.dataDir) return options.dataDir;

  const bundleId = options.bundleId || DESKTOP_BUNDLE_ID;
  const platform = options.platform ?? os.platform();
  const homedir = options.homedir ?? os.homedir();

  if (platform === 'darwin') {
    return path.join(homedir, 'Library', 'Application Support', bundleId);
  }
  if (platform === 'win32') {
    const appData = env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
    return path.join(appData, bundleId);
  }
  // Linux / other Unix: honor XDG_DATA_HOME per Tauri's app_data_dir.
  const xdg = env.XDG_DATA_HOME?.trim();
  const base = xdg ? xdg : path.join(homedir, '.local', 'share');
  return path.join(base, bundleId);
}

export function resolveDiscoveryFilePath(options: DesktopDiscoveryOptions = {}): string {
  return path.join(resolveDesktopDataDir(options), DISCOVERY_FILE_NAME);
}

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    // EPERM means the process exists but we can't signal it — still alive.
    return code === 'EPERM';
  }
}

/**
 * Read the discovery file and validate it. Returns `null` when the file is
 * missing, malformed, schema-incompatible, or its pid is no longer alive.
 * Never throws — callers can treat any non-null result as "desktop app
 * claims to be listening at this URL right now."
 */
export function readDiscoveryEntry(options: DesktopDiscoveryOptions = {}): DiscoveryResult | null {
  const filePath = resolveDiscoveryFilePath(options);
  let raw: string;
  try {
    raw = options.readFileSync ? options.readFileSync(filePath) : fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  const entry = coerceEntry(parsed);
  if (!entry) return null;
  if (!SUPPORTED_SCHEMA_VERSIONS.has(entry.schemaVersion)) return null;

  const alive = options.isProcessAlive ?? defaultIsProcessAlive;
  if (!alive(entry.pid)) return null;

  const url = buildBackendUrl(entry.host, entry.port);
  return { entry, url, source: 'discovery', path: filePath };
}

function coerceEntry(value: unknown): DiscoveryEntry | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const schemaVersion = Number(record.schemaVersion);
  const host = typeof record.host === 'string' ? record.host.trim() : '';
  const port = Number(record.port);
  const pid = Number(record.pid);
  const startedAt = typeof record.startedAt === 'string' ? record.startedAt : '';
  const appVersion = typeof record.appVersion === 'string' ? record.appVersion : '';

  if (!Number.isFinite(schemaVersion)) return null;
  if (!host) return null;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  if (!Number.isInteger(pid) || pid <= 0) return null;

  return { schemaVersion, host, port, pid, startedAt, appVersion };
}

function buildBackendUrl(host: string, port: number): string {
  const safeHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `http://${safeHost}:${port}/api`;
}
