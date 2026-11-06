/**
 * ESLint Adapter
 * Runs local ESLint binary against changed JS/TS files.
 * Strictly local: no npx, no remote downloads.
 */

import { existsSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { execFile } from 'child_process';
import {
  LINTER_IDS,
  REVIEW_LINTER_MAX_FINDINGS_PER_TOOL,
  normalizeLinterSeverity,
  isSecurityRule,
  classifyCategory,
} from './linterConstants.js';
import { toRepoRelativePath } from './linterPathUtils.js';

const JS_TS_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts']);

const ESLINT_CONFIG_PATTERNS = [
  '.eslintrc',
  '.eslintrc.js',
  '.eslintrc.cjs',
  '.eslintrc.json',
  '.eslintrc.yml',
  '.eslintrc.yaml',
  'eslint.config.js',
  'eslint.config.mjs',
  'eslint.config.cjs',
  'eslint.config.ts',
  'eslint.config.mts',
  'eslint.config.cts',
];

function hasExtension(filePath) {
  const lower = String(filePath || '').toLowerCase();
  return Array.from(JS_TS_EXTENSIONS).some((ext) => lower.endsWith(ext));
}

function resolveLocalBinary(projectPath) {
  const candidates = [
    join(projectPath, 'node_modules', '.bin', 'eslint'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function hasLocalConfig(projectPath) {
  for (const pattern of ESLINT_CONFIG_PATTERNS) {
    if (existsSync(join(projectPath, pattern))) return true;
  }
  // Check package.json for eslintConfig field
  try {
    const pkgPath = join(projectPath, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.eslintConfig && typeof pkg.eslintConfig === 'object') return true;
    }
  } catch {
    // ignore parse errors
  }
  return false;
}

/**
 * Check whether ESLint should be enabled by default for this repo.
 * Uses repo-owned configuration only so generated policy is stable across machines.
 */
export function detectProjectAvailability(projectPath) {
  return hasLocalConfig(projectPath);
}

export function getDetectionMetadata(projectPath) {
  const binary = resolveLocalBinary(projectPath);
  const hasConfig = hasLocalConfig(projectPath);
  return {
    policyDefaultEligible: hasConfig,
    runtimeReady: hasConfig && Boolean(binary),
    atlasManagedEligible: false,
    effectiveMode: hasConfig && Boolean(binary) ? 'project_linter' : 'unavailable',
    hasConfig,
    hasBinary: Boolean(binary),
    configLabel: hasConfig ? ESLINT_CONFIG_PATTERNS.find((pattern) => existsSync(join(projectPath, pattern))) || 'package.json#eslintConfig' : null,
    binaryLabel: binary ? 'node_modules/.bin/eslint' : null,
  };
}

/**
 * Detect whether ESLint can run in this project.
 */
export function detect(projectPath, changedFiles) {
  const hasJsTsFiles = changedFiles.some((f) => hasExtension(f));
  if (!hasJsTsFiles) return false;
  const binary = resolveLocalBinary(projectPath);
  if (!binary) return false;
  return hasLocalConfig(projectPath);
}

/**
 * Run ESLint on changed JS/TS files and return normalized findings.
 */
export async function run(projectPath, changedFiles, { signal } = {}) {
  const binary = resolveLocalBinary(projectPath);
  if (!binary) return [];

  const targetFiles = changedFiles
    .filter((f) => hasExtension(f))
    .map((f) => resolve(projectPath, f));

  if (targetFiles.length === 0) return [];

  const args = [
    '--format', 'json',
    '--no-error-on-unmatched-pattern',
    ...targetFiles,
  ];

  const stdout = await new Promise((resolvePromise, reject) => {
    const proc = execFile(binary, args, {
      cwd: projectPath,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 0, // Managed by outer deadline
      signal,
    }, (err, stdout, stderr) => {
      // ESLint exits with code 1 when there are lint errors — that's expected
      if (err && (err.killed || err.code === 'ABORT_ERR')) {
        reject(new Error('ESLint process killed (deadline exceeded)'));
        return;
      }
      if (err && !hasParsableEslintResults(stdout)) {
        reject(new Error(`ESLint failed: ${String(stderr || err.message || 'unknown error').trim()}`));
        return;
      }
      resolvePromise(stdout || '');
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      }, { once: true });
    }
  });

  return parseEslintOutput(stdout, projectPath);
}

function parseEslintOutput(stdout, projectPath) {
  let results;
  try {
    results = JSON.parse(stdout);
  } catch {
    return [];
  }

  if (!Array.isArray(results)) return [];

  const findings = [];

  for (const fileResult of results) {
    const relativePath = toRepoRelativePath(fileResult?.filePath, projectPath);

    if (!Array.isArray(fileResult?.messages)) continue;

    for (const msg of fileResult.messages) {
      if (!msg || typeof msg !== 'object') continue;

      const ruleId = String(msg.ruleId || 'unknown');
      const eslintSeverity = Number(msg.severity) || 0;
      let severity = eslintSeverity >= 2 ? 'medium' : 'low';

      // Promote security-related rules
      if (isSecurityRule(ruleId)) {
        severity = eslintSeverity >= 2 ? 'high' : 'medium';
      }

      findings.push({
        file: relativePath,
        line: Math.max(1, Math.trunc(Number(msg.line) || 0)),
        column: Math.max(1, Math.trunc(Number(msg.column) || 0)),
        severity: normalizeLinterSeverity(severity),
        ruleId,
        message: String(msg.message || '').trim(),
        source: LINTER_IDS.ESLINT,
        category: classifyCategory(ruleId, LINTER_IDS.ESLINT),
        confidence: 'high',
        suggestedFix: msg.fix?.text || null,
      });

      if (findings.length >= REVIEW_LINTER_MAX_FINDINGS_PER_TOOL) break;
    }

    if (findings.length >= REVIEW_LINTER_MAX_FINDINGS_PER_TOOL) break;
  }

  return findings;
}

function hasParsableEslintResults(stdout) {
  try {
    return Array.isArray(JSON.parse(String(stdout || '')));
  } catch {
    return false;
  }
}

export const id = LINTER_IDS.ESLINT;
