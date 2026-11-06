import { homedir } from 'os';
import path from 'path';
import fs from 'fs';

function getLocalAppDataDir() {
  if (process.platform !== 'win32') {
    return null;
  }

  if (process.env.LOCALAPPDATA) {
    return process.env.LOCALAPPDATA;
  }

  const homeDir = process.env.USERPROFILE || process.env.HOME || homedir();
  return homeDir ? path.join(homeDir, 'AppData', 'Local') : null;
}

export function getWindowsCliShimCandidates(binaryName) {
  if (process.platform !== 'win32') {
    return [];
  }

  const localAppData = getLocalAppDataDir();
  if (!localAppData) {
    return [];
  }

  const baseName = path.parse(binaryName).name;
  const roots = [
    path.join(localAppData, 'Microsoft', 'WinGet', 'Links'),
    path.join(localAppData, 'Microsoft', 'WindowsApps'),
  ];
  const names = [
    `${baseName}.exe`,
    `${baseName}.cmd`,
    `${baseName}.ps1`,
    baseName,
  ];

  return [...new Set(
    roots.flatMap((root) => names.map((name) => path.join(root, name)))
  )];
}

export function resolveWindowsCliExecutablePath(binaryPath, options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') {
    return binaryPath;
  }

  const candidate = path.normalize(String(binaryPath || '').trim());
  if (!candidate) {
    return candidate;
  }

  const ext = path.extname(candidate).toLowerCase();
  if (ext === '.exe' || ext === '.cmd' || ext === '.bat') {
    return candidate;
  }

  const siblingCandidates = [
    `${candidate}.exe`,
    `${candidate}.cmd`,
    `${candidate}.bat`,
    candidate,
  ];

  for (const sibling of siblingCandidates) {
    try {
      fs.accessSync(sibling, fs.constants.F_OK);
      return sibling;
    } catch {
      // Try next sibling path.
    }
  }

  return candidate;
}

export default {
  getWindowsCliShimCandidates,
  resolveWindowsCliExecutablePath,
};
