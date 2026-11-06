/**
 * Codex Binary Utility
 * Shared helper to locate the Codex CLI binary on the local machine.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import { homedir } from 'os';
import path from 'path';
import cliInstallService from '../services/cliInstallService.js';
import { getWindowsCliShimCandidates } from './windowsCliPaths.js';

const execFileAsync = promisify(execFile);

let npmGlobalBinCache;

async function resolveNpmGlobalBinPath(binaryName) {
  if (npmGlobalBinCache === undefined) {
    try {
      const { stdout } = await execFileAsync('npm', ['root', '-g'], {
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
      });
      npmGlobalBinCache = stdout.trim();
    } catch {
      npmGlobalBinCache = null;
    }
  }

  if (!npmGlobalBinCache) return null;
  return path.join(npmGlobalBinCache, '..', 'bin', binaryName);
}

function compareNodeVersionsDesc(a, b) {
  const pa = a.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return db - da;
  }
  return 0;
}

function uniquePaths(paths) {
  const seen = new Set();
  const deduped = [];
  for (const candidate of paths) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    deduped.push(candidate);
  }
  return deduped;
}

export function getCodexBinaryCandidates({
  platform = process.platform,
  env = process.env,
  homeDir = env.HOME || env.USERPROFILE || homedir(),
  npmGlobalBinPath = null,
} = {}) {
  const candidates = [];

  if (platform === 'win32') {
    candidates.push(
      path.join(homeDir, '.local', 'bin', 'codex.exe'),
      ...getWindowsCliShimCandidates('codex'),
    );

    if (env.APPDATA) {
      candidates.push(
        path.join(env.APPDATA, 'npm', 'codex.cmd'),
        path.join(env.APPDATA, 'npm', 'codex.ps1'),
      );
    }
    if (env.LOCALAPPDATA) {
      candidates.push(path.join(env.LOCALAPPDATA, 'Volta', 'bin', 'codex.exe'));
    }
    candidates.push(
      path.join(homeDir, 'scoop', 'shims', 'codex.cmd'),
      path.join(homeDir, 'scoop', 'shims', 'codex.exe'),
      'C:\\ProgramData\\chocolatey\\bin\\codex.exe',
    );
  } else {
    candidates.push(
      path.join(homeDir, '.local', 'bin', 'codex'),
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      path.join(homeDir, '.volta', 'bin', 'codex'),
      path.join(homeDir, '.fnm', 'aliases', 'default', 'bin', 'codex'),
      path.join(homeDir, '.nvm', 'current', 'bin', 'codex'),
      path.join(homeDir, '.asdf', 'shims', 'codex'),
      path.join(homeDir, '.npm-global', 'bin', 'codex'),
      path.join(homeDir, 'node_modules', '.bin', 'codex'),
    );
  }

  if (npmGlobalBinPath) {
    candidates.push(npmGlobalBinPath);
  }

  return uniquePaths(candidates);
}

function canExecute(candidate, platform = process.platform) {
  try {
    fs.accessSync(candidate, platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function normalizeCodexBinaryPath(candidate, platform = process.platform) {
  return cliInstallService.resolveWindowsCodexExecutablePath(candidate, { platform });
}

function findNvmCodexBinary({
  platform = process.platform,
  env = process.env,
  homeDir = env.HOME || env.USERPROFILE || homedir(),
} = {}) {
  if (platform === 'win32' && !env.APPDATA) {
    return null;
  }

  const versionRoot = platform === 'win32'
    ? path.join(env.APPDATA || '', 'nvm')
    : path.join(homeDir, '.nvm', 'versions', 'node');

  try {
    const versions = fs.readdirSync(versionRoot).sort(compareNodeVersionsDesc);
    for (const version of versions) {
      const candidates = platform === 'win32'
        ? [
            path.join(versionRoot, version, 'codex.cmd'),
            path.join(versionRoot, version, 'codex.exe'),
            path.join(versionRoot, version, 'codex.ps1'),
          ]
        : [path.join(versionRoot, version, 'bin', 'codex')];

      for (const candidate of candidates) {
        if (canExecute(candidate, platform)) {
          return normalizeCodexBinaryPath(candidate, platform);
        }
      }
    }
  } catch {
    // No nvm install, or inaccessible directory.
  }

  return null;
}

export async function findCodexBinary(options = {}) {
  const platform = options.platform || process.platform;
  const candidates = getCodexBinaryCandidates({ ...options, platform });
  const systemFallbackCandidates = new Set(
    platform === 'win32'
      ? ['C:\\ProgramData\\chocolatey\\bin\\codex.exe']
      : ['/opt/homebrew/bin/codex', '/usr/local/bin/codex']
  );
  const primaryCandidates = candidates.filter((candidate) => !systemFallbackCandidates.has(candidate));
  const fallbackCandidates = candidates.filter((candidate) => systemFallbackCandidates.has(candidate));

  for (const candidate of primaryCandidates) {
    if (canExecute(candidate, platform)) {
      return normalizeCodexBinaryPath(candidate, platform);
    }
  }

  const nvmCandidate = findNvmCodexBinary({ ...options, platform });
  if (nvmCandidate) {
    return nvmCandidate;
  }

  try {
    const cmd = platform === 'win32' ? 'where' : 'which';
    const { stdout } = await execFileAsync(cmd, ['codex'], { timeout: 5000 });
    const binPath = stdout.trim().split(/\r?\n/)[0].trim();
    if (binPath) {
      return normalizeCodexBinaryPath(binPath, platform);
    }
  } catch {
    // Not on PATH, try npm global metadata below.
  }

  for (const candidate of fallbackCandidates) {
    if (canExecute(candidate, platform)) {
      return normalizeCodexBinaryPath(candidate, platform);
    }
  }

  const npmGlobalBinPath = await resolveNpmGlobalBinPath('codex');
  if (npmGlobalBinPath && canExecute(npmGlobalBinPath, platform)) {
    return normalizeCodexBinaryPath(npmGlobalBinPath, platform);
  }

  return null;
}
