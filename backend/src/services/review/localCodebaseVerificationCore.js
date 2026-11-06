import fs from 'fs/promises';
import path from 'path';

import { normalizePathForMatch } from './reviewHelpers.js';

const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const DEFAULT_MAX_SCAN_FILES = 180;
const DEFAULT_MAX_SUPPORTING_FILES = 5;
const DEFAULT_SKIP_DIRS = new Set([
  '.git',
  'Library',
  'Logs',
  'Obj',
  'Temp',
  'node_modules',
]);

export function buildReviewFileLookup(reviewFiles = []) {
  const lookup = new Map();
  for (const file of Array.isArray(reviewFiles) ? reviewFiles : []) {
    const normalizedPath = normalizePathForMatch(file?.path || '');
    if (!normalizedPath) continue;
    if (typeof file?.after === 'string') {
      lookup.set(normalizedPath, file.after);
      continue;
    }
    if (typeof file?.before === 'string') {
      lookup.set(normalizedPath, file.before);
    }
  }
  return lookup;
}

export async function safeReadFileText(absPath, { maxFileBytes = DEFAULT_MAX_FILE_BYTES } = {}) {
  try {
    const stat = await fs.stat(absPath);
    if (!stat.isFile() || stat.size > maxFileBytes) return null;
    return await fs.readFile(absPath, 'utf8');
  } catch {
    return null;
  }
}

export async function readRepoRelativeText(projectPath, relativePath, reviewFileLookup, options = {}) {
  const normalizedPath = normalizePathForMatch(relativePath || '');
  if (!normalizedPath) return null;
  if (reviewFileLookup?.has(normalizedPath)) return reviewFileLookup.get(normalizedPath);
  const absPath = path.resolve(projectPath, normalizedPath);
  return safeReadFileText(absPath, options);
}

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildSearchRoots(normalizedPath, {
  supportingPaths = [],
  maxDepth = 3,
} = {}) {
  const roots = new Set();
  let currentDir = path.posix.dirname(normalizedPath || '');
  for (let depth = 0; currentDir && currentDir !== '.' && depth < maxDepth; depth += 1) {
    roots.add(currentDir);
    const parentDir = path.posix.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  for (const supportingPath of Array.isArray(supportingPaths) ? supportingPaths : []) {
    const normalizedSupportingPath = normalizePathForMatch(supportingPath || '');
    if (!normalizedSupportingPath) continue;
    roots.add(path.posix.dirname(normalizedSupportingPath));
  }
  return [...roots].sort((left, right) => left.localeCompare(right));
}

export async function collectNearbySymbolReferences(projectPath, normalizedPath, symbolName, options = {}) {
  if (!symbolName) return [];

  const searchRoots = buildSearchRoots(normalizedPath, {
    supportingPaths: options.supportingPaths || [],
    maxDepth: Number.isFinite(Number(options.maxDepth)) ? Number(options.maxDepth) : 3,
  });
  const symbolRe = new RegExp(`\\b${escapeRegex(symbolName)}\\b`);
  const matches = [];
  const seenPaths = new Set();
  const skipDirs = options.skipDirs instanceof Set ? options.skipDirs : DEFAULT_SKIP_DIRS;
  const extensions = options.extensions instanceof Set ? options.extensions : new Set(['.js', '.ts', '.tsx', '.jsx']);
  const maxScanFiles = Number.isFinite(Number(options.maxScanFiles))
    ? Number(options.maxScanFiles)
    : DEFAULT_MAX_SCAN_FILES;
  const maxSupportingFiles = Number.isFinite(Number(options.maxSupportingFiles))
    ? Number(options.maxSupportingFiles)
    : DEFAULT_MAX_SUPPORTING_FILES;
  let scannedFiles = 0;

  const walk = async (relativeDir) => {
    if (scannedFiles >= maxScanFiles) return;
    const absDir = path.resolve(projectPath, relativeDir);
    let entries = [];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (scannedFiles >= maxScanFiles) break;
      const relativePath = normalizePathForMatch(path.posix.join(relativeDir, entry.name));
      if (entry.isDirectory()) {
        if (skipDirs.has(entry.name)) continue;
        await walk(relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = path.posix.extname(relativePath).toLowerCase();
      if (!extensions.has(extension)) continue;
      if (relativePath === normalizedPath || (Array.isArray(options.supportingPaths) && options.supportingPaths.includes(relativePath))) continue;
      scannedFiles += 1;
      const content = await safeReadFileText(path.resolve(projectPath, relativePath), options);
      if (typeof content !== 'string' || !symbolRe.test(content)) continue;
      if (seenPaths.has(relativePath)) continue;
      const lineNumber = Math.max(1, content.split('\n').findIndex((line) => symbolRe.test(line)) + 1 || 1);
      seenPaths.add(relativePath);
      matches.push({
        path: relativePath,
        line: lineNumber,
        symbolName,
      });
      if (matches.length >= maxSupportingFiles) return;
    }
  };

  for (const searchRoot of searchRoots) {
    if (matches.length >= maxSupportingFiles || scannedFiles >= maxScanFiles) break;
    await walk(searchRoot);
  }

  return matches;
}
