/**
 * .NET Format Adapter
 * Runs dotnet format in verify mode to surface repo-owned C# formatting and convention issues.
 * Strictly local: no remote downloads, no implicit restore.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import {
  LINTER_IDS,
  REVIEW_LINTER_MAX_FINDINGS_PER_TOOL,
  normalizeLinterSeverity,
  isSecurityRule,
  classifyCategory,
} from './linterConstants.js';
import {
  findProjectFile,
  resolveDotnetBinary,
  resolveDotnetBuildTarget,
  resolveUnityContext,
  toRepoRelativePath,
} from './dotnetAdapter.js';

const CS_EXTENSION = '.cs';
const REPORT_FILE_NAME = 'format-report.json';

function isCsFile(filePath) {
  return String(filePath || '').toLowerCase().endsWith(CS_EXTENSION);
}

export function detectProjectAvailability(projectPath) {
  return Boolean(findProjectFile(projectPath));
}

export function getDetectionMetadata(projectPath) {
  const projectFile = findProjectFile(projectPath);
  const hasConfig = Boolean(projectFile);
  const binary = resolveDotnetBinary();
  return {
    policyDefaultEligible: hasConfig,
    defaultEnabled: false,
    runtimeReady: hasConfig && Boolean(binary),
    atlasManagedEligible: false,
    effectiveMode: hasConfig && Boolean(binary) ? 'project_linter' : 'unavailable',
    hasConfig,
    hasBinary: Boolean(binary),
    configLabel: projectFile ? toRepoRelativePath(projectFile, projectPath) : null,
    binaryLabel: binary || null,
  };
}

export function detect(projectPath, changedFiles, { reviewProfile } = {}) {
  if (!Array.isArray(changedFiles) || !changedFiles.some((file) => isCsFile(file))) {
    return false;
  }
  if (!findProjectFile(projectPath, { reviewProfile })) return false;
  return resolveDotnetBinary() !== null;
}

export async function run(projectPath, changedFiles, { signal, reviewProfile = null } = {}) {
  const binary = resolveDotnetBinary();
  if (!binary) return [];

  const target = resolveDotnetBuildTarget(projectPath, changedFiles, { reviewProfile });
  if (!target?.buildPath) return [];
  const unityContext = resolveUnityContext(projectPath, reviewProfile);

  const includeFiles = Array.from(new Set(
    (Array.isArray(changedFiles) ? changedFiles : [])
      .map((file) => toRepoRelativePath(file, projectPath))
      .filter((file) => isCsFile(file))
      .filter((file) => !unityContext || isPathUnderUnityRoot(file, unityContext.unityRoot))
  ));
  if (includeFiles.length === 0) return [];

  const reportDir = await fs.mkdtemp(path.join(os.tmpdir(), 'atlas-dotnet-format-'));
  const args = [
    'format',
    target.buildPath,
    '--no-restore',
    '--verify-no-changes',
    '--report',
    reportDir,
    '--verbosity',
    'quiet',
    ...includeFiles.flatMap((file) => ['--include', file]),
  ];

  try {
    const output = await new Promise((resolvePromise, reject) => {
      const proc = execFile(binary, args, {
        cwd: projectPath,
        maxBuffer: 10 * 1024 * 1024,
        timeout: 0,
        signal,
      }, (err, stdout, stderr) => {
        if (err && (err.killed || err.code === 'ABORT_ERR')) {
          reject(new Error('dotnet format process killed (deadline exceeded)'));
          return;
        }
        resolvePromise({
          error: err || null,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        });
      });

      if (signal) {
        signal.addEventListener('abort', () => {
          try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        }, { once: true });
      }
    });

    const reportPath = path.join(reportDir, REPORT_FILE_NAME);
    const reportContent = await fs.readFile(reportPath, 'utf8').catch(() => null);
    if (!reportContent) {
      if (output.error) {
        throw new Error(`dotnet format failed: ${String(output.stderr || output.stdout || output.error.message || 'unknown error').trim()}`);
      }
      return [];
    }

    return parseDotnetFormatReport(reportContent, projectPath, {
      isUnity: Boolean(unityContext),
      unityRoot: unityContext?.unityRoot || null,
    });
  } finally {
    await fs.rm(reportDir, { recursive: true, force: true }).catch(() => {});
  }
}

function isPathUnderUnityRoot(relativePath, unityRoot) {
  const normalizedRoot = String(unityRoot || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!normalizedRoot) return true;
  const normalizedPath = String(relativePath || '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '');
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function resolveSeverity(ruleId) {
  if (isSecurityRule(ruleId)) return 'high';
  if (String(ruleId || '').startsWith('CA')) return 'medium';
  return 'low';
}

function resolveCategory(ruleId) {
  if (String(ruleId || '').toUpperCase() === 'WHITESPACE') return 'style';
  return classifyCategory(ruleId, LINTER_IDS.DOTNET_FORMAT);
}

function parseDotnetFormatReport(reportContent, projectPath, options = {}) {
  let entries;
  try {
    entries = JSON.parse(String(reportContent || ''));
  } catch {
    return [];
  }
  if (!Array.isArray(entries)) return [];

  const findings = [];
  const seen = new Set();
  const isUnity = options.isUnity === true;
  const unityRoot = options.unityRoot || null;

  for (const entry of entries) {
    const relativePath = toRepoRelativePath(entry?.FilePath || entry?.FileName, projectPath);
    if (!isCsFile(relativePath)) continue;
    if (isUnity && !isPathUnderUnityRoot(relativePath, unityRoot)) continue;

    const fileChanges = Array.isArray(entry?.FileChanges) ? entry.FileChanges : [];
    for (const change of fileChanges) {
      const ruleId = String(change?.DiagnosticId || 'dotnet-format').trim();
      const line = Math.max(1, Math.trunc(Number(change?.LineNumber) || 0));
      const column = Math.max(1, Math.trunc(Number(change?.CharNumber) || 0));
      const dedupeKey = `${relativePath}:${line}:${column}:${ruleId}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      findings.push({
        file: relativePath,
        line,
        column,
        severity: normalizeLinterSeverity(resolveSeverity(ruleId)),
        ruleId,
        message: String(change?.FormatDescription || 'Fix formatting or code style issue.').trim(),
        source: LINTER_IDS.DOTNET_FORMAT,
        category: resolveCategory(ruleId),
        confidence: 'high',
        suggestedFix: null,
      });

      if (findings.length >= REVIEW_LINTER_MAX_FINDINGS_PER_TOOL) break;
    }

    if (findings.length >= REVIEW_LINTER_MAX_FINDINGS_PER_TOOL) break;
  }

  return findings;
}

export const id = LINTER_IDS.DOTNET_FORMAT;
export { parseDotnetFormatReport };
