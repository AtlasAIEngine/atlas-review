import { createHash } from 'node:crypto';
import path from 'node:path';

import { getAppDataDir } from '../config/paths.js';

function normalizeProjectPath(projectPath) {
  const resolvedPath = path.resolve(projectPath);
  return process.platform === 'win32'
    ? resolvedPath.toLowerCase()
    : resolvedPath;
}

export function getProjectStorageRoot() {
  return path.join(getAppDataDir(), 'project-metadata');
}

export function getProjectStorageId(projectPath) {
  return createHash('sha1')
    .update(normalizeProjectPath(projectPath))
    .digest('hex');
}

export function getProjectStorageDir(projectPath) {
  return path.join(getProjectStorageRoot(), getProjectStorageId(projectPath));
}

export function getProjectStoragePath(projectPath, ...segments) {
  return path.join(getProjectStorageDir(projectPath), ...segments);
}

export default {
  getProjectStorageRoot,
  getProjectStorageId,
  getProjectStorageDir,
  getProjectStoragePath,
};
