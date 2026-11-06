/**
 * AtlasEngine Desktop Mode Entry Point
 *
 * This is the entry point for running AtlasEngine in desktop/self-hosted mode.
 * It configures the environment for SQLite and local-only operation, then starts
 * the main server.
 *
 * Key differences from server.js:
 *   - Uses SQLite instead of PostgreSQL (via ATLAS_DB_TYPE=sqlite)
 *   - Bootstraps the shipped fresh-install launch baseline on first run
 *   - Skips Docker initialization
 *   - Uses OS-appropriate data paths (~/Library/Application Support/AtlasEngine, etc.)
 *   - Simpler logging (no PM2, no cluster mode)
 */

import fs from 'fs';
import path from 'path';
import { getAppDataDir, getDbPath, getProjectsDir } from './src/config/paths.js';
import { loadDesktopEncryptionKey } from './src/utils/desktopEncryptionKey.js';
import {
  REVIEW_SYNC_SETTING_ENV_MAP,
  REVIEW_SYNC_SETTING_KEYS,
  applyReviewSyncSettingToEnv,
  seedDefaultReviewSyncEnv,
} from './src/services/reviewSyncSettings.js';

// =============================================================================
// PATH AUGMENTATION (must happen before any child process spawns)
// =============================================================================

// When launched from Finder/Dock, macOS provides a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin).
// Node.js tools (npm, npx) live in locations like /opt/homebrew/bin, /usr/local/bin, or NVM/Volta dirs.
// Prepend common locations so spawn('npm', ...) in devServerService.js works.
{
  const currentPath = process.env.PATH || '';
  const pathSep = process.platform === 'win32' ? ';' : ':';
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const isWindows = process.platform === 'win32';
  const candidates = [
    path.join(homeDir, '.local', 'bin'),                          // Claude CLI, pip --user installs
  ];
  if (isWindows) {
    // Windows-specific tool paths
    const appData = process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming');
    candidates.push(
      path.join(appData, 'nvm'),                                  // nvm-windows
      path.join(appData, 'npm'),                                  // npm global (Windows)
      path.join(homeDir, '.volta', 'bin'),                        // Volta (Windows)
      path.join(homeDir, '.fnm', 'aliases', 'default'),           // fnm (Windows)
    );
  } else {
    // Unix-specific tool paths
    candidates.push(
      '/opt/homebrew/bin',                                        // Homebrew (Apple Silicon)
      '/usr/local/bin',                                           // Homebrew (Intel) / manual installs
      path.join(homeDir, '.nvm/versions/node/default/bin'),       // NVM symlinked default (custom alias)
      path.join(homeDir, '.volta/bin'),                           // Volta
      path.join(homeDir, '.fnm/aliases/default/bin'),             // fnm
    );
  }

  // Also probe the current NVM version if NVM_DIR is set
  const nvmDir = process.env.NVM_DIR || path.join(homeDir, '.nvm');
  const nvmDefaultPath = path.join(nvmDir, 'alias');
  try {
    // Resolve the "default" alias → version directory
    if (fs.existsSync(path.join(nvmDefaultPath, 'default'))) {
      const version = fs.readFileSync(path.join(nvmDefaultPath, 'default'), 'utf8').trim();
      if (version) {
        candidates.push(path.join(nvmDir, 'versions/node', version, 'bin'));
      }
    }
  } catch {
    // NVM not installed — no-op
  }

  // Also try a glob-free probe: the most-recently-modified node version dir
  try {
    const nvmVersionsDir = path.join(nvmDir, 'versions/node');
    if (fs.existsSync(nvmVersionsDir)) {
      const versions = fs.readdirSync(nvmVersionsDir).filter(v => v.startsWith('v'));
      if (versions.length > 0) {
        // Sort descending by semver-ish (latest first)
        versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
        candidates.push(path.join(nvmVersionsDir, versions[0], 'bin'));
      }
    }
  } catch {
    // No NVM versions — no-op
  }

  const dirsToAdd = candidates.filter(d => {
    try { return fs.existsSync(d) && !currentPath.split(pathSep).includes(d); } catch { return false; }
  });

  if (dirsToAdd.length > 0) {
    process.env.PATH = dirsToAdd.join(pathSep) + pathSep + currentPath;
    console.log('🔧 PATH augmented with:', dirsToAdd.join(', '));
  }
}

seedDefaultReviewSyncEnv({ override: false });
if (!process.env.ATLAS_REVIEW_SYNC_USER_ID) {
  process.env.ATLAS_REVIEW_SYNC_USER_ID = crypto.randomUUID();
}

// =============================================================================
// DESKTOP MODE ENVIRONMENT CONFIGURATION
// =============================================================================

// Set desktop mode flag FIRST (before any other imports)
process.env.ATLAS_DESKTOP_MODE = 'true';
if (!process.env.ATLAS_BIND_HOST) {
  process.env.ATLAS_BIND_HOST = '127.0.0.1';
}

// Configure SQLite as the database
process.env.ATLAS_DB_TYPE = 'sqlite';

// Set database path using OS-appropriate location
const dbPath = getDbPath();
process.env.ATLAS_DB_PATH = dbPath;

// Set projects directory
const projectsDir = getProjectsDir();
process.env.PROJECTS_DIR = projectsDir;

// =============================================================================
// DIRECTORY INITIALIZATION
// =============================================================================

// Ensure required directories exist
const appDataDir = getAppDataDir();
const dirsToCreate = [appDataDir, projectsDir, path.dirname(dbPath)];

for (const dir of dirsToCreate) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`📁 Created directory: ${dir}`);
  }
}

// =============================================================================
// GITHUB & ENCRYPTION CONFIGURATION
// =============================================================================

// Load user-provided .env from the data directory (takes precedence over defaults)
const shellProvidedReviewSyncEnvNames = new Set(
  Object.values(REVIEW_SYNC_SETTING_ENV_MAP).filter((envName) => Boolean(process.env[envName]))
);

const userEnvPath = path.join(appDataDir, '.env');
if (fs.existsSync(userEnvPath)) {
  const envContent = fs.readFileSync(userEnvPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes (matches dotenv behavior)
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Only set if not already provided via shell/Tauri env
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

async function loadPersistedDesktopReviewSyncSettings() {
  try {
    const dbFilePath = getDbPath();
    if (!fs.existsSync(dbFilePath)) {
      seedDefaultReviewSyncEnv({ override: false });
      if (!process.env.ATLAS_REVIEW_SYNC_USER_ID) {
        process.env.ATLAS_REVIEW_SYNC_USER_ID = crypto.randomUUID();
      }
      return;
    }

    const Database = (await import('better-sqlite3')).default;
    const sqlite = new Database(dbFilePath, { fileMustExist: true });
    try {
      const tableRow = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settings'")
        .get();
      if (!tableRow) {
        seedDefaultReviewSyncEnv({ override: false });
        if (!process.env.ATLAS_REVIEW_SYNC_USER_ID) {
          process.env.ATLAS_REVIEW_SYNC_USER_ID = crypto.randomUUID();
        }
        return;
      }

      const placeholders = REVIEW_SYNC_SETTING_KEYS.map(() => '?').join(', ');
      const rows = sqlite
        .prepare(`SELECT id, value FROM settings WHERE id IN (${placeholders})`)
        .all(...REVIEW_SYNC_SETTING_KEYS);

      for (const row of rows) {
        const envName = REVIEW_SYNC_SETTING_ENV_MAP[row?.id];
        if (!envName || shellProvidedReviewSyncEnvNames.has(envName)) continue;
        applyReviewSyncSettingToEnv(row.id, row.value, { override: true });
      }

      if (!process.env.ATLAS_REVIEW_SYNC_SERVER_URL) {
        seedDefaultReviewSyncEnv({ override: false });
      }
      if (!process.env.ATLAS_REVIEW_SYNC_USER_ID) {
        const generatedUserId = crypto.randomUUID();
        if (!shellProvidedReviewSyncEnvNames.has('ATLAS_REVIEW_SYNC_USER_ID')) {
          sqlite
            .prepare(
              `INSERT INTO settings (id, value, updated_at) VALUES (?, ?, datetime('now'))
               ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
            )
            .run('review_sync_user_id', generatedUserId);
        }
        process.env.ATLAS_REVIEW_SYNC_USER_ID = generatedUserId;
      }
    } finally {
      sqlite.close();
    }
  } catch (error) {
    console.warn('⚠️  Failed to load persisted review sync settings:', error?.message || error);
    seedDefaultReviewSyncEnv({ override: false });
    if (!process.env.ATLAS_REVIEW_SYNC_USER_ID) {
      process.env.ATLAS_REVIEW_SYNC_USER_ID = crypto.randomUUID();
    }
  }
}

let desktopReviewSyncSettingsPromise = null;

function ensureDesktopReviewSyncSettingsLoaded() {
  if (desktopReviewSyncSettingsPromise) {
    return desktopReviewSyncSettingsPromise;
  }

  const reviewSyncSettingsStartedAt = Date.now();
  desktopReviewSyncSettingsPromise = loadPersistedDesktopReviewSyncSettings()
    .then(() => {
      console.log(`[startup] Desktop review sync settings loaded in ${Date.now() - reviewSyncSettingsStartedAt}ms`);
    })
    .catch((error) => {
      console.warn(
        `[startup] Desktop review sync settings load failed after ${Date.now() - reviewSyncSettingsStartedAt}ms:`,
        error?.message || error
      );
    });

  globalThis.__ATLAS_DESKTOP_REVIEW_SYNC_SETTINGS_PROMISE = desktopReviewSyncSettingsPromise;
  return desktopReviewSyncSettingsPromise;
}

// Default GitHub App metadata for desktop device flow.
// CLIENT_ID is public (visible in OAuth URLs). Do not embed client secrets in
// the shipped desktop app bundle; operators can provide one via the per-user
// data-dir .env only if they intentionally opt into that flow.
if (!process.env.GITHUB_APP_CLIENT_ID) {
  process.env.GITHUB_APP_CLIENT_ID = 'Iv23li2EAp9sw7J1UHjf';
}
if (!process.env.GITHUB_APP_NAME) {
  process.env.GITHUB_APP_NAME = 'atlasengineapp';
}

if (!process.env.ENCRYPTION_KEY) {
  try {
    process.env.ENCRYPTION_KEY = loadDesktopEncryptionKey(appDataDir, {
      dbPath: getDbPath(),
    });
  } catch (err) {
    console.error('Failed to load/migrate desktop encryption key:', err.message);
    console.error('GitHub token storage requires a working encryption key.');
    console.error('Data directory:', appDataDir);
    process.exit(1);
  }
}

// Auto-generate a per-installation encryption key for token storage.
// Stored in the data directory so it persists across app updates.
if (!process.env.ENCRYPTION_KEY) {
  const keyPath = path.join(appDataDir, '.encryption-key');
  try {
    if (fs.existsSync(keyPath)) {
      process.env.ENCRYPTION_KEY = fs.readFileSync(keyPath, 'utf8').trim();
    } else {
      const key = crypto.randomBytes(32).toString('base64');
      fs.writeFileSync(keyPath, key, { mode: 0o600 });
      process.env.ENCRYPTION_KEY = key;
      console.log('🔐 Generated new encryption key');
    }
  } catch (err) {
    console.error('❌ Failed to load/generate encryption key:', err.message);
    console.error('   GitHub token storage requires a working encryption key.');
    console.error('   Data directory:', appDataDir);
    process.exit(1);
  }
}

// =============================================================================
// DESKTOP MODE BANNER
// =============================================================================

console.log('');
console.log('╔════════════════════════════════════════════════════════════════════╗');
console.log('║                 AtlasEngine - Desktop Mode                         ║');
console.log('╚════════════════════════════════════════════════════════════════════╝');
console.log('');
console.log('🖥️  Running in self-hosted desktop mode');
console.log('📊 Database: SQLite');
console.log('🧱 Launch schema: fresh-install baseline');
console.log(`📂 Data directory: ${appDataDir}`);
console.log(`🗃️  Database path: ${dbPath}`);
console.log(`📁 Projects directory: ${projectsDir}`);
console.log('');

// =============================================================================
// START SERVER
// =============================================================================

// Import and start the main server
// The server will detect ATLAS_DESKTOP_MODE and ATLAS_DB_TYPE and adjust behavior
globalThis.__ATLAS_DESKTOP_REVIEW_SYNC_SETTINGS_PROMISE = null;
globalThis.__ATLAS_START_DESKTOP_REVIEW_SYNC_SETTINGS__ = ensureDesktopReviewSyncSettingsLoaded;

import('./server.js').catch(error => {
  console.error('❌ Failed to start desktop server:', error);
  process.exit(1);
});
