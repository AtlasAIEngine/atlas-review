/**
 * Semgrep Adapter
 * Runs local Semgrep binary with repo-owned config first, then optional Atlas-managed fallback rules.
 * Strictly local: no --config auto, no remote rule downloads.
 */

import { existsSync, readdirSync, constants as fsConstants, accessSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execFile, execFileSync } from 'child_process';
import {
  LINTER_IDS,
  REVIEW_LINTER_MAX_FINDINGS_PER_TOOL,
  normalizeLinterSeverity,
  isSecurityRule,
  classifyCategory,
} from './linterConstants.js';
import { toRepoRelativePath } from './linterPathUtils.js';

const SEMGREP_CONFIG_PATHS = [
  '.semgrep.yml',
  '.semgrep.yaml',
  '.semgrep',
  '.semgrep/rules.yml',
  '.semgrep/rules.yaml',
];

const ATLAS_MANAGED_SOURCE_EXTENSIONS = [
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.py',
];

const SEMGREP_ADAPTER_DIR = dirname(fileURLToPath(import.meta.url));
const ATLAS_REPO_ROOT = resolve(SEMGREP_ADAPTER_DIR, '../../../../../');

let _cachedSemgrepBinary = undefined;

function resolveLocalBinary() {
  if (_cachedSemgrepBinary !== undefined) return _cachedSemgrepBinary;
  const homeDir = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = [
    process.env.ATLAS_SEMGREP_PATH || null,
    '/Library/Frameworks/Python.framework/Versions/3.12/bin/semgrep',
    '/Library/Frameworks/Python.framework/Versions/Current/bin/semgrep',
    '/opt/homebrew/bin/semgrep',
    '/usr/local/bin/semgrep',
    homeDir ? join(homeDir, '.local', 'bin', 'semgrep') : null,
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      _cachedSemgrepBinary = candidate;
      return _cachedSemgrepBinary;
    } catch {
      // try next candidate
    }
  }
  try {
    const result = execFileSync('which', ['semgrep'], { timeout: 3000, stdio: 'pipe' });
    _cachedSemgrepBinary = String(result || '').trim() || null;
  } catch {
    _cachedSemgrepBinary = null;
  }
  return _cachedSemgrepBinary;
}

function resolveVendoredConfigCandidates({
  adapterDir = SEMGREP_ADAPTER_DIR,
  atlasRepoRoot = ATLAS_REPO_ROOT,
} = {}) {
  return [
    join(adapterDir, 'semgrep-rules'),
    join(atlasRepoRoot, '.atlas', 'semgrep-rules'),
  ];
}

function findProjectOwnedConfig(projectPath) {
  for (const configPath of SEMGREP_CONFIG_PATHS) {
    const fullPath = join(projectPath, configPath);
    if (existsSync(fullPath)) return fullPath;
  }
  return null;
}

function findVendoredConfig(options = {}) {
  // Check vendored Atlas ruleset
  for (const fullPath of resolveVendoredConfigCandidates(options)) {
    if (existsSync(fullPath)) return fullPath;
  }
  return null;
}

function findLocalConfig(projectPath, options = {}) {
  return findProjectOwnedConfig(projectPath) || findVendoredConfig(options);
}

function hasRepoOwnedConfig(projectPath) {
  return Boolean(findProjectOwnedConfig(projectPath));
}

function projectHasAtlasManagedSupportedFiles(projectPath) {
  if (!projectPath) return false;
  const queue = [projectPath];
  const ignoredDirs = new Set(['.git', 'node_modules', 'dist', 'build', '.next', 'coverage', 'vendor', '__pycache__']);

  while (queue.length > 0) {
    const currentDir = queue.shift();
    if (!currentDir) continue;

    let entries;
    try {
      entries = readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) {
          queue.push(join(currentDir, entry.name));
        }
        continue;
      }
      const lower = entry.name.toLowerCase();
      if (ATLAS_MANAGED_SOURCE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
        return true;
      }
    }
  }

  return false;
}

function hasSupportedChangedFile(changedFiles) {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  return files.some((file) => {
    const normalized = String(file || '').toLowerCase();
    return ATLAS_MANAGED_SOURCE_EXTENSIONS.some((ext) => normalized.endsWith(ext));
  });
}

function getRuntimeConfig(projectPath, { allowAtlasManagedFallback = false } = {}) {
  const projectConfig = findProjectOwnedConfig(projectPath);
  if (projectConfig) {
    return { path: projectConfig, mode: 'project_linter' };
  }
  if (allowAtlasManagedFallback) {
    const vendoredConfig = findVendoredConfig();
    if (vendoredConfig) {
      return { path: vendoredConfig, mode: 'atlas_managed' };
    }
  }
  return null;
}

/**
 * Check whether Semgrep should be enabled by default for this repo.
 * Uses repo-owned configuration only so generated policy is stable across machines.
 */
export function detectProjectAvailability(projectPath) {
  return hasRepoOwnedConfig(projectPath);
}

export function getDetectionMetadata(projectPath) {
  const hasConfig = hasRepoOwnedConfig(projectPath);
  const binary = resolveLocalBinary();
  const atlasManagedEligible = Boolean(findVendoredConfig()) && projectHasAtlasManagedSupportedFiles(projectPath);
  const runtimeConfig = getRuntimeConfig(projectPath, {
    allowAtlasManagedFallback: !hasConfig && atlasManagedEligible,
  });
  let configLabel = null;
  if (hasConfig) {
    configLabel = SEMGREP_CONFIG_PATHS.find((configPath) => existsSync(join(projectPath, configPath))) || '.semgrep config';
  } else if (runtimeConfig?.path) {
    configLabel = runtimeConfig.path.startsWith(projectPath)
      ? runtimeConfig.path.slice(projectPath.length + 1)
      : 'Atlas vendored rules';
  }
  return {
    policyDefaultEligible: hasConfig,
    atlasManagedEligible,
    runtimeReady: Boolean(binary) && Boolean(runtimeConfig?.path),
    effectiveMode: hasConfig && Boolean(binary)
      ? 'project_linter'
      : (!hasConfig && atlasManagedEligible && Boolean(binary) && runtimeConfig?.mode === 'atlas_managed')
        ? 'atlas_managed'
        : 'unavailable',
    hasConfig,
    hasBinary: Boolean(binary),
    configLabel,
    binaryLabel: binary || null,
  };
}

/**
 * Detect whether Semgrep can run in this project.
 */
export function detect(projectPath, changedFiles, { allowAtlasManagedFallback = false } = {}) {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  if (files.length === 0) return false;
  if (!resolveLocalBinary()) return false;
  const runtimeConfig = getRuntimeConfig(projectPath, { allowAtlasManagedFallback });
  if (!runtimeConfig?.path) return false;
  if (runtimeConfig.mode === 'atlas_managed' && !hasSupportedChangedFile(files)) return false;
  return true;
}

/**
 * Run Semgrep with local config and return normalized findings.
 */
export async function run(projectPath, changedFiles, { signal, allowAtlasManagedFallback = false } = {}) {
  const binary = resolveLocalBinary();
  if (!binary) return [];
  const runtimeConfig = getRuntimeConfig(projectPath, { allowAtlasManagedFallback });
  if (!runtimeConfig?.path) return [];

  // Build --include patterns for changed files
  const includeArgs = [];
  const includeSet = new Set();
  for (const rawFile of changedFiles) {
    const normalized = toRepoRelativePath(rawFile, projectPath);
    const includePath = String(normalized || '').trim().replace(/^\.\/+/, '');
    if (!includePath || includeSet.has(includePath)) continue;
    includeSet.add(includePath);
    includeArgs.push('--include', includePath);
  }

  const args = [
    'scan',
    '--json',
    '--config', runtimeConfig.path,
    '--no-git-ignore', // We already scoped to changed files
    '--quiet',
    ...includeArgs,
    projectPath,
  ];

  const stdout = await new Promise((resolvePromise, reject) => {
    const proc = execFile(binary, args, {
      cwd: projectPath,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 0,
      signal,
    }, (err, stdout, stderr) => {
      if (err && (err.killed || err.code === 'ABORT_ERR')) {
        reject(new Error('Semgrep process killed (deadline exceeded)'));
        return;
      }
      if (err && !hasParsableSemgrepResults(stdout)) {
        reject(new Error(`Semgrep failed: ${String(stderr || err.message || 'unknown error').trim()}`));
        return;
      }
      // Semgrep exits non-zero on findings — expected
      resolvePromise(stdout || '');
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      }, { once: true });
    }
  });

  return parseSemgrepOutput(stdout, projectPath);
}

function parseSemgrepOutput(stdout, projectPath) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }

  const results = Array.isArray(parsed?.results) ? parsed.results : [];
  const findings = [];

  for (const result of results) {
    if (!result || typeof result !== 'object') continue;

    const relativePath = toRepoRelativePath(result.path, projectPath);

    const ruleId = String(result.check_id || result.rule_id || 'unknown');
    const semgrepSeverity = String(result.extra?.severity || result.severity || '').toUpperCase();

    let severity;
    if (semgrepSeverity === 'ERROR') severity = 'high';
    else if (semgrepSeverity === 'WARNING') severity = 'medium';
    else severity = 'low';

    // Promote security rules
    if (isSecurityRule(ruleId)) {
      severity = severity === 'low' ? 'medium' : severity;
    }

    findings.push({
      file: relativePath,
      line: Math.max(1, Math.trunc(Number(result.start?.line) || 0)),
      column: Math.max(1, Math.trunc(Number(result.start?.col) || 0)),
      severity: normalizeLinterSeverity(severity),
      ruleId,
      message: String(result.extra?.message || result.message || '').trim(),
      source: LINTER_IDS.SEMGREP,
      category: classifyCategory(ruleId, LINTER_IDS.SEMGREP),
      confidence: 'high',
      suggestedFix: result.extra?.fix || null,
    });

    if (findings.length >= REVIEW_LINTER_MAX_FINDINGS_PER_TOOL) break;
  }

  return findings;
}

function hasParsableSemgrepResults(stdout) {
  try {
    return Array.isArray(JSON.parse(String(stdout || ''))?.results);
  } catch {
    return false;
  }
}

export const id = LINTER_IDS.SEMGREP;
export { findLocalConfig, findProjectOwnedConfig, findVendoredConfig, resolveVendoredConfigCandidates, projectHasAtlasManagedSupportedFiles };
