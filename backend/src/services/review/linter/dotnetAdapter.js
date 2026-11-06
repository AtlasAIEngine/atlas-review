/**
 * .NET/Roslyn Adapter
 * Runs dotnet build for C# compiler diagnostics and Roslyn analyzer findings.
 * Supports Unity projects via Microsoft.Unity.Analyzers detection.
 * Strictly local: no remote downloads, --no-restore.
 */

import { existsSync, readdirSync, realpathSync, constants as fsConstants, accessSync } from 'fs';
import { basename, join, relative } from 'path';
import { execFile, execFileSync } from 'child_process';
import {
  LINTER_IDS,
  REVIEW_LINTER_MAX_FINDINGS_PER_TOOL,
  normalizeLinterSeverity,
  isSecurityRule,
  isUnityAnalyzerRule,
  classifyCategory,
} from './linterConstants.js';
import { toRepoRelativePath } from './linterPathUtils.js';

const CS_EXTENSION = '.cs';

// Pattern: path/File.cs(line,col): warning CS1234: message
// Also matches: path/File.cs(line,col): error CS1234: message
const DOTNET_DIAGNOSTIC_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(\w+\d+):\s+(.+?)(?:\s+\[.+\])?$/;
// Pattern: CSC : error CS2001: Source file '/path/File.cs' could not be found.
const DOTNET_COMPILER_DIAGNOSTIC_RE = /^CSC\s*:\s+(error|warning)\s+(\w+\d+):\s+(.+?)(?:\s+\[.+\])?$/;

const UNITY_PROJECT_MARKERS = ['Assembly-CSharp.csproj', 'ProjectSettings'];
const DOTNET_DISCOVERY_MAX_DEPTH = Math.max(0, Number(process.env.ATLAS_DOTNET_DISCOVERY_MAX_DEPTH || 4));
const UNITY_NOISE_RULE_IDS = new Set(['MSB3270', 'MSB3277']);
const UNITY_PRIMARY_PROJECT_NAMES = ['Assembly-CSharp.csproj', 'Assembly-CSharp-Editor.csproj'];

let _cachedDotnetBinary = undefined;

function resolveLocalBinary() {
  if (_cachedDotnetBinary !== undefined) return _cachedDotnetBinary;
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = [
    process.env.DOTNET_ROOT ? join(process.env.DOTNET_ROOT, 'dotnet') : null,
    '/usr/local/share/dotnet/dotnet',
    '/opt/homebrew/bin/dotnet',
    '/usr/local/bin/dotnet',
    homeDir ? join(homeDir, '.dotnet', 'dotnet') : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      _cachedDotnetBinary = candidate;
      return _cachedDotnetBinary;
    } catch {
      // try next candidate
    }
  }
  try {
    const result = execFileSync('which', ['dotnet'], { timeout: 3000, stdio: 'pipe' });
    _cachedDotnetBinary = String(result || '').trim() || 'dotnet';
  } catch {
    _cachedDotnetBinary = null;
  }
  return _cachedDotnetBinary;
}

function hasProjectFile(projectPath) {
  return findProjectFile(projectPath) !== null;
}

function findProjectFiles(projectPath, options = {}) {
  const searchRoot = resolveScopedSearchRoot(projectPath, options);
  const queue = [{ path: searchRoot, depth: 0 }];
  const projectFiles = [];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth > DOTNET_DISCOVERY_MAX_DEPTH) continue;

    let entries;
    try {
      entries = readdirSync(current.path, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const fullPath = join(current.path, entry.name);
      if (entry.isFile() && (entry.name.endsWith('.csproj') || entry.name.endsWith('.sln'))) {
        projectFiles.push(fullPath);
        continue;
      }
      if (entry.isDirectory()) {
        queue.push({ path: fullPath, depth: current.depth + 1 });
      }
    }
  }

  return projectFiles;
}

function findProjectFile(projectPath, options = {}) {
  return findProjectFiles(projectPath, options)[0] || null;
}

function isUnityProject(projectPath) {
  return UNITY_PROJECT_MARKERS.some((marker) => existsSync(join(projectPath, marker)));
}

/**
 * Check whether .NET analysis should be enabled by default for this repo.
 * Uses repo-owned project files only so generated policy is stable across machines.
 */
export function detectProjectAvailability(projectPath) {
  return hasProjectFile(projectPath);
}

export function getDetectionMetadata(projectPath) {
  const projectFile = findProjectFile(projectPath);
  const hasConfig = Boolean(projectFile);
  const binary = resolveLocalBinary();
  let configLabel = null;
  if (projectFile) configLabel = relative(projectPath, projectFile).replace(/\\/g, '/');
  return {
    policyDefaultEligible: hasConfig,
    runtimeReady: hasConfig && Boolean(binary),
    atlasManagedEligible: false,
    effectiveMode: hasConfig && Boolean(binary) ? 'project_linter' : 'unavailable',
    hasConfig,
    hasBinary: Boolean(binary),
    configLabel,
    binaryLabel: binary || null,
  };
}

/**
 * Detect whether dotnet build can run in this project.
 */
export function detect(projectPath, changedFiles, options = {}) {
  const hasCsFiles = changedFiles.some((f) => String(f || '').toLowerCase().endsWith(CS_EXTENSION));
  if (!hasCsFiles) return false;
  if (!findProjectFile(projectPath, { reviewProfile: options.reviewProfile || null })) return false;
  return resolveLocalBinary() !== null;
}

/**
 * Run dotnet build --no-restore and return normalized findings.
 * In Unity-aware mode, the build target is scoped to the selected primary Unity root when possible.
 */
export async function run(projectPath, changedFiles, { signal, reviewProfile = null } = {}) {
  const binary = resolveLocalBinary();
  if (!binary) return [];

  const target = resolveDotnetBuildTarget(projectPath, changedFiles, { reviewProfile });
  const args = ['build'];
  if (target?.buildPath) {
    args.push(target.buildPath);
  }
  args.push('--no-restore', '--verbosity', 'quiet');
  const unityContext = resolveUnityContext(projectPath, reviewProfile);
  const isUnity = Boolean(unityContext) || isUnityProject(projectPath);

  const output = await new Promise((resolvePromise, reject) => {
    const proc = execFile(binary, args, {
      cwd: projectPath,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 0,
      signal,
    }, (err, stdout, stderr) => {
      if (err && (err.killed || err.code === 'ABORT_ERR')) {
        reject(new Error('dotnet build process killed (deadline exceeded)'));
        return;
      }
      // dotnet build exits non-zero on errors — expected
      resolvePromise((stdout || '') + (stderr || ''));
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      }, { once: true });
    }
  });

  return parseDotnetOutput(output, projectPath, {
    isUnity,
    unityRoot: unityContext?.unityRoot || null,
  });
}

function resolveScopedSearchRoot(projectPath, options = {}) {
  const unityContext = resolveUnityContext(projectPath, options.reviewProfile || null);
  if (!unityContext?.absoluteRoot) return projectPath;
  return unityContext.absoluteRoot;
}

function resolveUnityContext(projectPath, reviewProfile = null) {
  if (!reviewProfile || reviewProfile.stackFamily !== 'unity') return null;
  const rawUnityRoot = String(reviewProfile?.projectContext?.unityRoot || '').trim().replace(/\\/g, '/');
  const absoluteRoot = rawUnityRoot ? join(projectPath, rawUnityRoot) : projectPath;
  return {
    unityRoot: rawUnityRoot,
    absoluteRoot,
  };
}

function scoreProjectFile(projectFile, projectPath, normalizedChangedFiles, unityContext = null) {
  const normalizedRelativePath = relative(projectPath, projectFile).replace(/\\/g, '/');

  let score = 0;
  const fileName = basename(projectFile);
  const isCsproj = fileName.endsWith('.csproj');

  if (normalizedChangedFiles.has(normalizedRelativePath)) {
    score += 1000;
  }
  if (unityContext) {
    if (fileName === UNITY_PRIMARY_PROJECT_NAMES[0]) score += 400;
    if (fileName === UNITY_PRIMARY_PROJECT_NAMES[1]) score += 350;
    if (isCsproj) score += 200;
  } else if (isCsproj) {
    score += 50;
  }

  const depth = normalizedRelativePath.split('/').filter(Boolean).length;
  score -= depth;

  return {
    score,
    relativePath: normalizedRelativePath,
    isCsproj,
  };
}

function resolveDotnetBuildTarget(projectPath, changedFiles, options = {}) {
  const unityContext = resolveUnityContext(projectPath, options.reviewProfile || null);
  const projectFiles = findProjectFiles(projectPath, { reviewProfile: options.reviewProfile || null });
  if (projectFiles.length === 0) return null;
  const normalizedChangedFiles = new Set(
    (Array.isArray(changedFiles) ? changedFiles : [])
      .map((entry) => toRepoRelativePath(entry, projectPath))
      .filter(Boolean)
  );

  const scored = projectFiles.map((projectFile) => ({
    projectFile,
    ...scoreProjectFile(projectFile, projectPath, normalizedChangedFiles, unityContext),
  }));

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.isCsproj !== right.isCsproj) return left.isCsproj ? -1 : 1;
    return left.relativePath.localeCompare(right.relativePath);
  });

  const selected = scored[0];
  if (!selected) return null;

  return {
    absolutePath: selected.projectFile,
    buildPath: selected.relativePath,
    relativePath: selected.relativePath,
  };
}

function isPathUnderUnityRoot(relativePath, unityRoot) {
  const normalizedRoot = String(unityRoot || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalizedRoot) return true;
  const normalizedPath = String(relativePath || '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function parseDotnetOutput(output, projectPath, options = {}) {
  // Resolve symlinks (macOS /tmp → /private/tmp) for reliable path prefix stripping
  let resolvedProjectPath = projectPath;
  try { resolvedProjectPath = realpathSync(projectPath); } catch { /* use original */ }

  const isUnity = options.isUnity === true;
  const unityRoot = options.unityRoot || null;

  const lines = String(output || '').split('\n');
  const findings = [];
  const seen = new Set();

  for (const line of lines) {
    let rawPath = null;
    let rawLine = 1;
    let rawCol = 1;
    let level = null;
    let ruleId = null;
    let message = null;

    const fileScopedMatch = line.match(DOTNET_DIAGNOSTIC_RE);
    if (fileScopedMatch) {
      [, rawPath, rawLine, rawCol, level, ruleId, message] = fileScopedMatch;
    } else {
      const compilerMatch = line.match(DOTNET_COMPILER_DIAGNOSTIC_RE);
      if (!compilerMatch) continue;

      [, level, ruleId, message] = compilerMatch;
      const sourceFileMatch = String(message || '').match(/Source file '(.+?)'/);
      if (!sourceFileMatch) continue;
      rawPath = sourceFileMatch[1];
    }

    const relativePath = toRepoRelativePath(rawPath, resolvedProjectPath);

    // Only include .cs files
    if (!relativePath.toLowerCase().endsWith(CS_EXTENSION)) continue;
    if (isUnity && UNITY_NOISE_RULE_IDS.has(ruleId)) continue;
    if (isUnity && !isPathUnderUnityRoot(relativePath, unityRoot)) continue;

    // Deduplicate — dotnet build emits diagnostics to both stdout and stderr
    const dedupeKey = `${relativePath}:${rawLine}:${rawCol}:${ruleId}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    let severity = level === 'error' ? 'high' : 'medium';
    if (isSecurityRule(ruleId)) severity = 'high';

    let category = classifyCategory(ruleId, LINTER_IDS.DOTNET);
    if (isUnity && isUnityAnalyzerRule(ruleId)) {
      category = 'unity';
    }

    findings.push({
      file: relativePath,
      line: Math.max(1, Math.trunc(Number(rawLine) || 0)),
      column: Math.max(1, Math.trunc(Number(rawCol) || 0)),
      severity: normalizeLinterSeverity(severity),
      ruleId,
      message: String(message || '').trim(),
      source: LINTER_IDS.DOTNET,
      category,
      confidence: 'high',
      suggestedFix: null,
    });

    if (findings.length >= REVIEW_LINTER_MAX_FINDINGS_PER_TOOL) break;
  }

  return findings;
}

export const id = LINTER_IDS.DOTNET;
export {
  findProjectFile,
  findProjectFiles,
  parseDotnetOutput,
  resolveLocalBinary as resolveDotnetBinary,
  resolveDotnetBuildTarget,
  resolveUnityContext,
  toRepoRelativePath,
};
