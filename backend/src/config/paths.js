/**
 * OS-Aware Path Configuration
 *
 * Provides cross-platform paths for database and data storage.
 * Supports:
 *   - Environment variable overrides (ATLAS_DB_PATH, ATLAS_DATA_DIR)
 *   - OS-specific defaults (macOS, Windows, Linux)
 *   - Tauri appDataDir integration for desktop mode
 */

import os from 'os';
import path from 'path';

const platform = os.platform();

/**
 * Get the application data directory based on OS
 * Follows OS conventions for app data storage:
 *   - macOS: ~/Library/Application Support/AtlasEngine
 *   - Windows: %APPDATA%/AtlasEngine
 *   - Linux: ~/.local/share/AtlasEngine
 *
 * @returns {string} Application data directory path
 */
export function getAppDataDir() {
  // Allow override via environment variable
  if (process.env.ATLAS_DATA_DIR) {
    return process.env.ATLAS_DATA_DIR;
  }

  const homeDir = os.homedir();

  switch (platform) {
    case 'darwin':
      // macOS: ~/Library/Application Support/AtlasEngine
      return path.join(homeDir, 'Library', 'Application Support', 'AtlasEngine');

    case 'win32':
      // Windows: %APPDATA%/AtlasEngine
      return path.join(process.env.APPDATA || path.join(homeDir, 'AppData', 'Roaming'), 'AtlasEngine');

    default:
      // Linux and others: ~/.local/share/AtlasEngine
      return path.join(homeDir, '.local', 'share', 'AtlasEngine');
  }
}

/**
 * Get the database file path for SQLite
 *
 * @returns {string} SQLite database file path
 */
export function getDbPath() {
  // Allow override via environment variable
  if (process.env.ATLAS_DB_PATH) {
    return process.env.ATLAS_DB_PATH;
  }

  // Default: {appDataDir}/atlas.db
  return path.join(getAppDataDir(), 'atlas.db');
}

/**
 * Get the projects directory for user projects
 *
 * @returns {string} Projects directory path
 */
export function getProjectsDir() {
  // Allow override via environment variable
  if (process.env.ATLAS_PROJECTS_DIR) {
    return process.env.ATLAS_PROJECTS_DIR;
  }

  // Default: {appDataDir}/projects
  return path.join(getAppDataDir(), 'projects');
}

/**
 * Get the logs directory
 *
 * @returns {string} Logs directory path
 */
export function getLogsDir() {
  // Allow override via environment variable
  if (process.env.ATLAS_LOGS_DIR) {
    return process.env.ATLAS_LOGS_DIR;
  }

  // Default: {appDataDir}/logs
  return path.join(getAppDataDir(), 'logs');
}

/**
 * Get the temp directory for build artifacts and temp files
 *
 * @returns {string} Temp directory path
 */
export function getTempDir() {
  // Allow override via environment variable
  if (process.env.ATLAS_TEMP_DIR) {
    return process.env.ATLAS_TEMP_DIR;
  }

  // Default: {appDataDir}/temp
  return path.join(getAppDataDir(), 'temp');
}

export default {
  getAppDataDir,
  getDbPath,
  getProjectsDir,
  getLogsDir,
  getTempDir
};
