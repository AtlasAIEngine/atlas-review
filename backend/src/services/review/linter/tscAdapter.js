/**
 * TypeScript Compiler Adapter
 * Runs local tsc binary for type-check diagnostics.
 * Strictly local: no npx, no remote downloads.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import {
  LINTER_IDS,
  REVIEW_LINTER_MAX_FINDINGS_PER_TOOL,
  normalizeLinterSeverity,
  isSecurityRule,
  classifyCategory,
} from './linterConstants.js';
import { toRepoRelativePath } from './linterPathUtils.js';

const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);

// Pattern: path/file.ts(line,col): error TS1234: message
const TSC_DIAGNOSTIC_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/;

function hasExtension(filePath) {
  const lower = String(filePath || '').toLowerCase();
  return Array.from(TS_EXTENSIONS).some((ext) => lower.endsWith(ext));
}

function resolveLocalBinary(projectPath) {
  const candidate = join(projectPath, 'node_modules', '.bin', 'tsc');
  return existsSync(candidate) ? candidate : null;
}

/**
 * Check whether TypeScript type-checking should be enabled by default for this repo.
 * Uses repo-owned configuration only so generated policy is stable across machines.
 */
export function detectProjectAvailability(projectPath) {
  return existsSync(join(projectPath, 'tsconfig.json'));
}

export function getDetectionMetadata(projectPath) {
  const hasConfig = existsSync(join(projectPath, 'tsconfig.json'));
  const binary = resolveLocalBinary(projectPath);
  return {
    policyDefaultEligible: hasConfig,
    runtimeReady: hasConfig && Boolean(binary),
    atlasManagedEligible: false,
    effectiveMode: hasConfig && Boolean(binary) ? 'project_linter' : 'unavailable',
    hasConfig,
    hasBinary: Boolean(binary),
    configLabel: hasConfig ? 'tsconfig.json' : null,
    binaryLabel: binary ? 'node_modules/.bin/tsc' : null,
  };
}

/**
 * Detect whether tsc can run in this project.
 */
export function detect(projectPath, changedFiles) {
  const hasTsFiles = changedFiles.some((f) => hasExtension(f));
  if (!hasTsFiles) return false;
  if (!existsSync(join(projectPath, 'tsconfig.json'))) return false;
  return resolveLocalBinary(projectPath) !== null;
}

/**
 * Run tsc --noEmit and return normalized findings.
 * Note: tsc runs on the whole project — findings are filtered to changed lines by the runner.
 */
export async function run(projectPath, changedFiles, { signal } = {}) {
  const binary = resolveLocalBinary(projectPath);
  if (!binary) return [];

  const args = ['--noEmit', '--pretty', 'false'];

  const output = await new Promise((resolvePromise, reject) => {
    const proc = execFile(binary, args, {
      cwd: projectPath,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 0,
      signal,
    }, (err, stdout, stderr) => {
      if (err && (err.killed || err.code === 'ABORT_ERR')) {
        reject(new Error('tsc process killed (deadline exceeded)'));
        return;
      }
      // tsc exits non-zero when there are errors — that's expected
      resolvePromise((stdout || '') + (stderr || ''));
    });

    if (signal) {
      signal.addEventListener('abort', () => {
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      }, { once: true });
    }
  });

  return parseTscOutput(output, projectPath);
}

function parseTscOutput(output, projectPath) {
  const lines = String(output || '').split('\n');
  const findings = [];

  for (const line of lines) {
    const match = line.match(TSC_DIAGNOSTIC_RE);
    if (!match) continue;

    const [, rawPath, rawLine, rawCol, level, ruleId, message] = match;
    const relativePath = toRepoRelativePath(rawPath, projectPath);

    const severity = level === 'error' ? 'medium' : 'low';

    findings.push({
      file: relativePath,
      line: Math.max(1, Math.trunc(Number(rawLine) || 0)),
      column: Math.max(1, Math.trunc(Number(rawCol) || 0)),
      severity: normalizeLinterSeverity(severity),
      ruleId,
      message: String(message || '').trim(),
      source: LINTER_IDS.TSC,
      category: classifyCategory(ruleId, LINTER_IDS.TSC),
      confidence: 'high',
      suggestedFix: null,
    });

    if (findings.length >= REVIEW_LINTER_MAX_FINDINGS_PER_TOOL) break;
  }

  return findings;
}

export const id = LINTER_IDS.TSC;
export { toRepoRelativePath };
