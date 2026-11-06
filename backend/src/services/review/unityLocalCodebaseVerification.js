import fs from 'fs/promises';
import path from 'path';

import {
  buildReviewFileLookup,
  collectNearbySymbolReferences,
  readRepoRelativeText,
} from './localCodebaseVerificationCore.js';
import { normalizePathForMatch } from './reviewHelpers.js';

const UNITY_LOCAL_CODEBASE_TOOL_ID = 'unity_local_codebase_verifier';
const UNITY_EDITOR_ONLY_PATH_RE = /(^|\/)(Assets\/Editor\b|Editor\/)/i;
const UNITY_SUPPORT_ONLY_PATH_RE = /(^|\/)(Tests?\b|TestData\b|Samples?\b|Sample~\b|Documentation~\b|Mocks?\b|MockData\b|Benchmarks?\b|Fuzz(?:ers?)?\b)(\/|$)/i;
const UNITY_SCAN_EXTENSIONS = new Set(['.cs', '.asmdef', '.prefab', '.unity']);
const UNITY_SKIP_DIRS = new Set([
  '.git',
  'Library',
  'Logs',
  'Obj',
  'Temp',
  'node_modules',
]);
const MAX_SUPPORTING_FILES = 5;

function emptyLocalVerificationResult(reason = null, findings = []) {
  return {
    findings,
    bundleEntries: [],
    stats: {
      enabled: false,
      skippedReason: reason,
      toolId: UNITY_LOCAL_CODEBASE_TOOL_ID,
      verifiedCount: 0,
      suppressedCount: 0,
    },
  };
}

function normalizeIncludePlatforms(value) {
  return Array.isArray(value)
    ? value.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
    : [];
}

function isEditorOnlyAsmdef(parsedAsmdef = null) {
  const includePlatforms = normalizeIncludePlatforms(parsedAsmdef?.includePlatforms);
  return includePlatforms.length > 0 && includePlatforms.every((entry) => entry === 'editor');
}

function isSupportOnlyUnityPath(normalizedPath) {
  if (!normalizedPath) return false;
  if (UNITY_EDITOR_ONLY_PATH_RE.test(normalizedPath)) return true;
  return UNITY_SUPPORT_ONLY_PATH_RE.test(normalizedPath);
}

async function findNearestAsmdef(projectPath, normalizedPath, unityRoot, reviewFileLookup) {
  const normalizedUnityRoot = normalizePathForMatch(unityRoot || '');
  const relativePath = normalizePathForMatch(normalizedPath || '');
  if (!relativePath) return null;

  let currentDir = path.posix.dirname(relativePath);
  const rootDir = normalizedUnityRoot || '';
  let depth = 0;

  while (depth < 8) {
    const absDir = path.resolve(projectPath, currentDir);
    let entries = [];
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      entries = [];
    }

    const asmdefNames = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.asmdef'))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    if (asmdefNames.length > 0) {
      const asmdefPath = normalizePathForMatch(path.posix.join(currentDir, asmdefNames[0]));
      const content = await readRepoRelativeText(projectPath, asmdefPath, reviewFileLookup);
      let parsed = null;
      if (typeof content === 'string') {
        try {
          parsed = JSON.parse(content);
        } catch {
          parsed = null;
        }
      }

      const supportingLine = typeof content === 'string'
        ? Math.max(1, content.split('\n').findIndex((line) => line.includes('includePlatforms')) + 1 || 1)
        : 1;

      return {
        path: asmdefPath,
        parsed,
        line: supportingLine,
      };
    }

    if (!currentDir || currentDir === '.' || currentDir === rootDir) break;
    const parentDir = path.posix.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
    depth += 1;
  }

  return null;
}

function extractPrimaryTypeName(content) {
  const match = String(content || '').match(/\b(?:class|struct|interface)\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
  return match ? String(match[1] || '').trim() : '';
}

async function collectNearbyReferences(projectPath, normalizedPath, symbolName, asmdefPath = null) {
  const matches = await collectNearbySymbolReferences(projectPath, normalizedPath, symbolName, {
    supportingPaths: asmdefPath ? [asmdefPath] : [],
    extensions: UNITY_SCAN_EXTENSIONS,
    skipDirs: UNITY_SKIP_DIRS,
    maxSupportingFiles: MAX_SUPPORTING_FILES,
    maxScanFiles: 180,
    maxDepth: 3,
  });
  return matches.map((entry) => ({
    ...entry,
    productionPath: !isSupportOnlyUnityPath(entry.path),
  }));
}

function detectRuntimeBoundarySignals(content) {
  const normalized = String(content || '');
  return {
    runtimeServiceBinding: /\[\s*ServiceBinding\s*\(/.test(normalized),
    monoBehaviourOrScriptableObject: /\b:\s*(?:MonoBehaviour|ScriptableObject)\b/.test(normalized),
  };
}

function buildEvidenceSummary({
  productionPath,
  asmdefInfo,
  nearbyReferences = [],
  runtimeBoundarySignals = {},
}) {
  const parts = [];
  if (runtimeBoundarySignals.runtimeServiceBinding) {
    parts.push('runtime service binding');
  } else if (runtimeBoundarySignals.monoBehaviourOrScriptableObject) {
    parts.push('runtime Unity object');
  } else {
    parts.push(productionPath ? 'production path' : 'support-only path');
  }
  if (asmdefInfo?.path) {
    parts.push(isEditorOnlyAsmdef(asmdefInfo.parsed)
      ? `editor-only asmdef ${asmdefInfo.path}`
      : `runtime-capable asmdef ${asmdefInfo.path}`);
  } else {
    parts.push('no local asmdef override found');
  }
  const productionRefs = nearbyReferences.filter((entry) => entry.productionPath);
  if (productionRefs.length > 0) {
    parts.push(`${productionRefs.length} nearby runtime reference${productionRefs.length === 1 ? '' : 's'}`);
  }
  return parts.join('; ');
}

function buildPromptEvidenceSummary({
  productionPath,
  asmdefInfo,
  nearbyReferences = [],
  runtimeBoundarySignals = {},
}) {
  const parts = [];
  if (runtimeBoundarySignals.runtimeServiceBinding) {
    parts.push('runtime service');
  } else if (runtimeBoundarySignals.monoBehaviourOrScriptableObject) {
    parts.push('runtime object');
  } else if (!productionPath) {
    parts.push('support-only');
  } else {
    parts.push('runtime path');
  }

  if (asmdefInfo?.path) {
    parts.push(isEditorOnlyAsmdef(asmdefInfo.parsed) ? 'editor asmdef' : 'runtime asmdef');
  }

  const runtimeReferenceCount = nearbyReferences.filter((entry) => entry.productionPath).length;
  if (runtimeReferenceCount > 0) {
    parts.push(`${runtimeReferenceCount} runtime ref${runtimeReferenceCount === 1 ? '' : 's'}`);
  }

  return parts.join(', ');
}

function withLocalVerificationFields(finding, bundleEntry) {
  const nextMessage = (
    bundleEntry.bugClass === 'unity.editor_api_in_runtime_path'
    && bundleEntry.runtimeBoundarySignals?.runtimeServiceBinding
    && typeof finding?.message === 'string'
    && !finding.message.includes('runtime service binding')
  )
    ? `Runtime service binding references UnityEditor APIs, which will break player builds or runtime execution.`
    : finding.message;
  return {
    ...finding,
    message: nextMessage,
    bugClass: bundleEntry.bugClass,
    supportingFiles: bundleEntry.supportingFiles,
    supportingLines: bundleEntry.supportingLines,
    productionPath: bundleEntry.productionPath,
    evidenceSummary: bundleEntry.evidenceSummary,
    promptEvidenceSummary: bundleEntry.promptEvidenceSummary,
    localCodebaseVerification: bundleEntry,
  };
}

export async function verifyUnityFindingsAgainstLocalCodebase(projectPath, findings = [], options = {}) {
  const normalizedProjectPath = typeof projectPath === 'string' ? projectPath.trim() : '';
  if (!normalizedProjectPath) {
    return emptyLocalVerificationResult('project_unavailable', findings);
  }

  const reviewProfile = options.reviewProfile || null;
  if (!reviewProfile || reviewProfile.stackFamily !== 'unity') {
    return emptyLocalVerificationResult('not_unity', findings);
  }

  const reviewFileLookup = buildReviewFileLookup(options.reviewFiles || []);
  const verifiedFindings = [];
  const bundleEntries = [];
  let suppressedCount = 0;

  for (const finding of Array.isArray(findings) ? findings : []) {
    const normalizedPath = normalizePathForMatch(finding?.file || '');
    if (!normalizedPath) {
      verifiedFindings.push(finding);
      continue;
    }

    const fileContent = await readRepoRelativeText(normalizedProjectPath, normalizedPath, reviewFileLookup);
    const symbolName = extractPrimaryTypeName(fileContent);
    const runtimeBoundarySignals = detectRuntimeBoundarySignals(fileContent);
    const asmdefInfo = await findNearestAsmdef(
      normalizedProjectPath,
      normalizedPath,
      reviewProfile?.projectContext?.unityRoot || '',
      reviewFileLookup
    );
    const nearbyReferences = await collectNearbyReferences(
      normalizedProjectPath,
      normalizedPath,
      symbolName,
      asmdefInfo?.path || null
    );

    const productionPath = !isSupportOnlyUnityPath(normalizedPath)
      || nearbyReferences.some((entry) => entry.productionPath);
    const bundleEntry = {
      bugClass: String(finding?.ruleId || '').trim() || 'unknown',
      confidence: String(finding?.confidence || 'medium').trim().toLowerCase(),
      changedFile: normalizedPath,
      supportingFiles: [
        ...(asmdefInfo?.path ? [asmdefInfo.path] : []),
        ...nearbyReferences.map((entry) => entry.path),
      ].slice(0, MAX_SUPPORTING_FILES),
      supportingLines: [
        ...(asmdefInfo?.path ? [{ file: asmdefInfo.path, line: asmdefInfo.line || 1 }] : []),
        ...nearbyReferences.map((entry) => ({ file: entry.path, line: entry.line || 1 })),
      ].slice(0, MAX_SUPPORTING_FILES),
      productionPath,
      evidenceSummary: buildEvidenceSummary({
        productionPath,
        asmdefInfo,
        nearbyReferences,
        runtimeBoundarySignals,
      }),
      promptEvidenceSummary: buildPromptEvidenceSummary({
        productionPath,
        asmdefInfo,
        nearbyReferences,
        runtimeBoundarySignals,
      }),
      runtimeBoundarySignals,
      suppressionReason: null,
    };

    if (!productionPath) {
      bundleEntry.suppressionReason = 'support_only_path';
    } else if (
      bundleEntry.bugClass === 'unity.editor_api_in_runtime_path'
      && asmdefInfo
      && isEditorOnlyAsmdef(asmdefInfo.parsed)
    ) {
      bundleEntry.productionPath = false;
      bundleEntry.evidenceSummary = buildEvidenceSummary({
        productionPath: false,
        asmdefInfo,
        nearbyReferences,
        runtimeBoundarySignals,
      });
      bundleEntry.promptEvidenceSummary = buildPromptEvidenceSummary({
        productionPath: false,
        asmdefInfo,
        nearbyReferences,
        runtimeBoundarySignals,
      });
      bundleEntry.suppressionReason = 'editor_only_assembly';
    }

    bundleEntries.push(bundleEntry);
    if (bundleEntry.suppressionReason) {
      suppressedCount += 1;
      continue;
    }

    verifiedFindings.push(withLocalVerificationFields(finding, bundleEntry));
  }

  return {
    findings: verifiedFindings,
    bundleEntries,
    stats: {
      enabled: true,
      skippedReason: null,
      toolId: UNITY_LOCAL_CODEBASE_TOOL_ID,
      verifiedCount: verifiedFindings.length,
      suppressedCount,
    },
  };
}

export { UNITY_LOCAL_CODEBASE_TOOL_ID };
