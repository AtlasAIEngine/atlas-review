/**
 * Claude Binary Utility
 * Shared helper to locate the Claude CLI binary on the local machine.
 * Used by provider detection and review execution.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import { homedir } from 'os';
import path from 'path';
import { getWindowsCliShimCandidates } from './windowsCliPaths.js';
import { getAppDataDir } from '../config/paths.js';

const execFileAsync = promisify(execFile);
const isWindows = process.platform === 'win32';
const DEFAULT_PREFERRED_FLAGS = ['--tools'];

function resolveWindowsNodeRuntime(candidateDir) {
  const runtimeCandidates = [
    path.join(candidateDir, 'node.exe'),
  ];

  if (path.basename(process.execPath || '').toLowerCase() === 'node.exe') {
    runtimeCandidates.push(process.execPath);
  }

  for (const runtimeCandidate of runtimeCandidates) {
    try {
      fs.accessSync(runtimeCandidate, fs.constants.X_OK);
      return runtimeCandidate;
    } catch {
      // Try next runtime.
    }
  }

  return null;
}

function resolveWindowsClaudeCliEntry(candidatePath) {
  const shimDir = path.dirname(candidatePath);
  const cliCandidates = [
    path.join(shimDir, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js'),
    path.join(path.dirname(shimDir), '@anthropic-ai', 'claude-code', 'cli.js'),
  ];

  for (const cliCandidate of cliCandidates) {
    try {
      fs.accessSync(cliCandidate, fs.constants.R_OK);
      return cliCandidate;
    } catch {
      // Try next CLI entry.
    }
  }

  return null;
}

function normalizeClaudeBinaryCandidate(candidatePath, probe = {}) {
  const help = String(probe.help || '');
  const metadata = {
    supportsTools: help.includes('--tools'),
    supportsSessionId: help.includes('--session-id'),
    supportsResume: help.includes('--resume'),
    supportsSettingSources: help.includes('--setting-sources'),
    version: probe.version || null,
  };

  if (!isWindows || path.extname(candidatePath).toLowerCase() !== '.cmd') {
    return { binary: candidatePath, args: [], ...metadata };
  }

  const nodeRuntime = resolveWindowsNodeRuntime(path.dirname(candidatePath));
  const cliEntry = resolveWindowsClaudeCliEntry(candidatePath);
  if (nodeRuntime && cliEntry) {
    return {
      binary: nodeRuntime,
      args: [cliEntry],
      ...metadata,
    };
  }

  return { binary: candidatePath, args: [], ...metadata };
}

function compareSemverDesc(a, b) {
  const pa = String(a || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return db - da;
  }
  return 0;
}

function extractVersion(raw = '') {
  const match = String(raw || '').match(/\d+\.\d+\.\d+/);
  return match ? match[0] : null;
}

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean))];
}

function normalizePathForCompare(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  return isWindows ? resolved.toLowerCase() : resolved;
}

function isPathInside(candidatePath, parentPath) {
  const candidate = normalizePathForCompare(candidatePath);
  const parent = normalizePathForCompare(parentPath);
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function getHomeDir() {
  return process.env.HOME || homedir();
}

export function getAtlasManagedClaudeCliPrefixes({ home = getHomeDir() } = {}) {
  const prefixes = [
    path.join(getAppDataDir(), 'cli-tools'),
  ];

  if (process.platform === 'darwin') {
    prefixes.push(
      path.join(home, 'Library', 'Application Support', 'AtlasEngine', 'cli-tools'),
      path.join(home, 'Library', 'Application Support', 'com.atlasengine.desktop', 'cli-tools'),
      path.join(home, 'Library', 'Application Support', 'dev.atlasengine.desktop', 'cli-tools'),
    );
  } else if (isWindows) {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    prefixes.push(
      path.join(appData, 'AtlasEngine', 'cli-tools'),
      path.join(appData, 'com.atlasengine.desktop', 'cli-tools'),
      path.join(appData, 'dev.atlasengine.desktop', 'cli-tools'),
    );
  } else {
    prefixes.push(
      path.join(home, '.local', 'share', 'AtlasEngine', 'cli-tools'),
      path.join(home, '.local', 'share', 'com.atlasengine.desktop', 'cli-tools'),
      path.join(home, '.local', 'share', 'dev.atlasengine.desktop', 'cli-tools'),
    );
  }

  return uniquePaths(prefixes);
}

export function getAtlasManagedClaudeCliPrefix() {
  return getAtlasManagedClaudeCliPrefixes()[0];
}

export function isAtlasManagedClaudeBinaryPath(candidatePath) {
  if (!candidatePath || typeof candidatePath !== 'string') {
    return false;
  }

  return getAtlasManagedClaudeCliPrefixes().some((prefix) => isPathInside(candidatePath, prefix));
}

async function probeClaudeCandidate(candidatePath) {
  const ext = path.extname(String(candidatePath || '')).toLowerCase();
  const isWindowsShim = isWindows && (ext === '.cmd' || ext === '.bat');
  const options = {
    encoding: 'utf8',
    timeout: 3000,
    windowsHide: true,
    ...(isWindowsShim ? { shell: true } : {}),
  };

  let help = '';
  let version = null;
  try {
    const { stdout } = await execFileAsync(candidatePath, ['--help'], options);
    help = stdout || '';
  } catch {
    // Some wrappers cannot be probed from the desktop process.
  }
  try {
    const { stdout } = await execFileAsync(candidatePath, ['--version'], options);
    version = extractVersion(stdout);
  } catch {
    // Version is optional for ranking.
  }
  return { help: String(help || ''), version };
}

function getNvmClaudeCandidates(home) {
  const candidates = [];
  if (!isWindows) {
    const nvmVersionsDir = path.join(home, '.nvm', 'versions', 'node');
    try {
      const versions = fs.readdirSync(nvmVersionsDir).sort(compareSemverDesc);
      for (const version of versions) {
        candidates.push(path.join(nvmVersionsDir, version, 'bin', 'claude'));
      }
    } catch {
      // no ~/.nvm
    }
  } else {
    const appData = process.env.APPDATA;
    if (appData) {
      const nvmWinDir = path.join(appData, 'nvm');
      try {
        const versions = fs.readdirSync(nvmWinDir).sort(compareSemverDesc);
        for (const version of versions) {
          candidates.push(
            path.join(nvmWinDir, version, 'claude.cmd'),
            path.join(nvmWinDir, version, 'claude.exe'),
            path.join(nvmWinDir, version, 'claude.ps1'),
          );
        }
      } catch {
        // no nvm-windows
      }
    }
  }
  return candidates;
}

export function getClaudeBinaryCandidates({ home = process.env.HOME || homedir() } = {}) {
  const candidates = [];

  if (isWindows) {
    candidates.push(
      path.join(home, '.local', 'bin', 'claude.exe'),
      ...getWindowsCliShimCandidates('claude'),
    );

    const appData = process.env.APPDATA;
    const localAppData = process.env.LOCALAPPDATA;
    if (appData) {
      candidates.push(
        path.join(appData, 'npm', 'claude.cmd'),
        path.join(appData, 'npm', 'claude.ps1'),
      );
    }
    if (localAppData) {
      candidates.push(path.join(localAppData, 'Volta', 'bin', 'claude.exe'));
    }
    candidates.push(
      path.join(home, 'scoop', 'shims', 'claude.cmd'),
      path.join(home, 'scoop', 'shims', 'claude.exe'),
      'C:\\ProgramData\\chocolatey\\bin\\claude.exe',
    );
  }

  candidates.push(
    path.join(home, '.local', 'bin', 'claude'),
    path.join(home, '.volta', 'bin', 'claude'),
    path.join(home, '.fnm', 'aliases', 'default', 'bin', 'claude'),
    path.join(home, '.nvm', 'current', 'bin', 'claude'),
    path.join(home, '.asdf', 'shims', 'claude'),
    path.join(home, '.npm-global', 'bin', 'claude'),
    path.join(home, 'node_modules', '.bin', 'claude'),
    ...getNvmClaudeCandidates(home),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  );

  return uniquePaths(candidates);
}

function rankCompatibleCandidates(entries, preferredFlags = DEFAULT_PREFERRED_FLAGS) {
  const compatible = preferredFlags.length
    ? entries.filter((entry) => preferredFlags.every((flag) => entry.help.includes(flag)))
    : entries;
  return compatible.slice().sort((a, b) => {
    const versionCompare = compareSemverDesc(a.version, b.version);
    return versionCompare || a.priority - b.priority;
  });
}

async function selectClaudeCandidate(candidates, { preferredFlags = DEFAULT_PREFERRED_FLAGS } = {}) {
  const accessibleCandidates = [];
  for (const candidate of uniquePaths(candidates).filter((entry) => !isAtlasManagedClaudeBinaryPath(entry))) {
    try {
      fs.accessSync(candidate, isWindows ? fs.constants.F_OK : fs.constants.X_OK);
      accessibleCandidates.push({ candidate, priority: accessibleCandidates.length });
    } catch {
      // Not found or not executable, try next.
    }
  }

  const available = await Promise.all(accessibleCandidates.map(async (entry) => ({
    ...entry,
    ...await probeClaudeCandidate(entry.candidate),
  })));

  if (!available.length) {
    return { compatible: null, fallback: null };
  }

  const rankedCompatible = rankCompatibleCandidates(available, preferredFlags);
  return {
    compatible: rankedCompatible[0] ? normalizeClaudeBinaryCandidate(rankedCompatible[0].candidate, rankedCompatible[0]) : null,
    fallback: normalizeClaudeBinaryCandidate(available[0].candidate, available[0]),
  };
}

async function getClaudePathCandidates() {
  const cmd = isWindows ? 'where' : 'which';
  const args = isWindows ? ['claude'] : ['-a', 'claude'];
  const { stdout } = await execFileAsync(cmd, args, { timeout: 5000 });
  return stdout
    .trim()
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .filter((entry) => !isAtlasManagedClaudeBinaryPath(entry));
}

/**
 * Find the Claude CLI binary path.
 * Prefers direct binaries that support the agentic-review flags Atlas needs.
 * Falls back to the first installed Claude binary, then npx if allowed.
 * @returns {Promise<{binary: string, args: string[]}>}
 */
export async function findClaudeBinary({
  allowNpx = true,
  home = process.env.HOME || homedir(),
  preferredFlags = DEFAULT_PREFERRED_FLAGS,
} = {}) {
  let pathSelected = null;
  try {
    const pathCandidates = await getClaudePathCandidates();
    if (pathCandidates.length) {
      pathSelected = await selectClaudeCandidate(pathCandidates, { preferredFlags });
      if (pathSelected.compatible) return pathSelected.compatible;
    }
  } catch {
    // Not in PATH, try common install locations below.
  }

  const candidates = getClaudeBinaryCandidates({ home });
  const selected = await selectClaudeCandidate(candidates, { preferredFlags });
  if (selected.compatible) {
    return selected.compatible;
  }

  if (pathSelected?.fallback) {
    return pathSelected.fallback;
  }

  if (selected.fallback) {
    return selected.fallback;
  }

  if (!allowNpx) {
    throw new Error('Claude CLI not found. Please install Claude Code CLI.');
  }
  return { binary: 'npx', args: ['@anthropic-ai/claude-code'] };
}
