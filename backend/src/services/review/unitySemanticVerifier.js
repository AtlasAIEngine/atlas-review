import path from 'path';

import { buildChangedLineIndex, filterAnchoredFindings, resolveCanonicalDiffPath } from './linter/linterDiffAnchors.js';
import { LOCAL_CODEBASE_VERIFICATION_TOOL_ID, runReviewLocalCodebaseVerification } from './localCodebaseVerification.js';
import { normalizePathForMatch, parseEnvBoolean } from './reviewHelpers.js';

const UNITY_SEMANTIC_SOURCE = 'unity-semantic';
const UNITY_SEMANTIC_TOOL_ID = 'unity_semantic_verifier';
const UNITY_RUNTIME_EDITOR_REFERENCE_RE = /\busing\s+UnityEditor\s*;|\bUnityEditor\./;
const UNITY_EDITOR_ONLY_PATH_RE = /(^|\/)(Assets\/Editor\b|Editor\/)/i;
const UNITY_EDITOR_ONLY_REFERENCE_RE = /(^UnityEditor$|\.Editor$|\.Editor\.|^Unity\.[A-Za-z0-9_.]+\.Editor$)/i;
const UNITY_POOL_MARKER_RE = /\b(IObjectPool<|ObjectPool<|OnReturnedToPool|OnTakeFromPool|ReturnToPool|ReleaseToPool|ResetState|pool\.Release\s*\()/;
const UNITY_RESET_VALUE_RE = /\b(null|false|0|default(?:\s*\([^)]*\))?|string\.Empty)\b/;

const SUBSCRIPTION_METHOD_NAMES = new Set(['Awake', 'OnEnable', 'Start']);
const CLEANUP_METHOD_NAMES = new Set(['OnDisable', 'OnDestroy']);
const POOL_INIT_METHOD_NAMES = new Set(['Bind', 'Configure', 'Initialize', 'OnSpawned', 'OnTakeFromPool', 'Setup']);
const POOL_RESET_METHOD_NAMES = new Set(['ClearState', 'OnDisable', 'OnReturnedToPool', 'ReleaseToPool', 'ResetForPool', 'ResetState']);

function emptyUnitySemanticResult(reason) {
  return {
    findings: [],
    anchoredFindings: [],
    promptFindings: [],
    stats: {
      enabled: false,
      skippedReason: reason || null,
      toolsAttempted: [],
      toolsSucceeded: [],
      toolsSkipped: [],
      toolsFailed: [],
      totalFindings: 0,
      anchoredFindings: 0,
      unanchoredFindings: 0,
      findingsBySeverity: {},
      findingsBySource: {},
      findingsByRule: {},
      durationMs: 0,
    },
  };
}

function normalizeConfidence(value, fallback = 'medium') {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'high' || normalized === 'medium' || normalized === 'low') return normalized;
  return fallback;
}

function shouldExposeUnityFindingToPrompt(finding) {
  const promotionMode = String(finding?.promotionMode || '').trim().toLowerCase();
  if (promotionMode === 'candidate_evidence') return true;
  return normalizeConfidence(finding?.confidence) !== 'high';
}

function isUnitySemanticVerifierEnabled(config = null) {
  if (config && typeof config === 'object' && typeof config.enabled === 'boolean') {
    return config.enabled;
  }
  return parseEnvBoolean('ATLAS_REVIEW_UNITY_SEMANTIC_VERIFIER_ENABLED', false);
}

function isUnityLocalCodebaseVerificationEnabled(config = null) {
  const localConfig = config?.localCodebaseVerification;
  if (localConfig && typeof localConfig === 'object' && typeof localConfig.enabled === 'boolean') {
    return localConfig.enabled;
  }
  return true;
}

function isPathUnderUnityRoot(normalizedPath, unityRoot) {
  const root = normalizePathForMatch(unityRoot || '');
  if (!root) return true;
  return normalizedPath === root || normalizedPath.startsWith(`${root}/`);
}

function buildLineOffsets(content) {
  const offsets = [0];
  const normalized = String(content || '');
  for (let index = 0; index < normalized.length; index += 1) {
    if (normalized[index] === '\n') offsets.push(index + 1);
  }
  return offsets;
}

function lineNumberFromIndex(offsets, index) {
  if (!Array.isArray(offsets) || offsets.length === 0) return 1;
  let low = 0;
  let high = offsets.length - 1;
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    if (offsets[mid] <= index) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return Math.max(1, high + 1);
}

function extractMethodBlocks(content) {
  const normalized = String(content || '');
  if (!normalized.trim()) return [];

  const methods = [];
  const signatureRe = /(^|\n)\s*(?:\[[^\]]+\]\s*)*(?:(?:public|private|protected|internal|static|virtual|override|sealed|async|partial|new|extern)\s+)*[\w<>\[\],?.]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\([^;{}]*\)\s*(?:where[^{\n]+)?\{/g;
  const lineOffsets = buildLineOffsets(normalized);
  let match;
  while ((match = signatureRe.exec(normalized)) !== null) {
    const methodName = String(match[2] || '').trim();
    if (!methodName) continue;
    const openBraceIndex = normalized.indexOf('{', signatureRe.lastIndex - 1);
    if (openBraceIndex < 0) continue;
    let depth = 1;
    let cursor = openBraceIndex + 1;
    while (cursor < normalized.length && depth > 0) {
      const ch = normalized[cursor];
      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;
      cursor += 1;
    }
    if (depth !== 0) continue;
    const bodyStart = openBraceIndex + 1;
    const bodyEnd = cursor - 1;
    methods.push({
      name: methodName,
      body: normalized.slice(bodyStart, bodyEnd),
      startLine: lineNumberFromIndex(lineOffsets, openBraceIndex),
      bodyStartLine: lineNumberFromIndex(lineOffsets, bodyStart),
    });
    signatureRe.lastIndex = cursor;
  }
  return methods;
}

function createFinding({
  file,
  line,
  severity,
  ruleId,
  message,
  confidence,
  suggestedFix = null,
  category = 'correctness',
  promotionMode = 'direct_finding',
}) {
  return {
    file,
    line: Math.max(1, Math.trunc(Number(line) || 0)),
    severity,
    ruleId,
    message,
    source: UNITY_SEMANTIC_SOURCE,
    category,
    confidence: normalizeConfidence(confidence),
    suggestedFix,
    promotionMode,
  };
}

function collectMissingUnsubscribeFindings(filePath, afterContent) {
  const methods = extractMethodBlocks(afterContent);
  const cleanupBodies = methods
    .filter((method) => CLEANUP_METHOD_NAMES.has(method.name))
    .map((method) => method.body);
  if (cleanupBodies.length === 0) return [];

  const findings = [];
  for (const method of methods) {
    if (!SUBSCRIPTION_METHOD_NAMES.has(method.name)) continue;
    const lines = method.body.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const eventMatch = line.match(/([A-Za-z_][A-Za-z0-9_.]+)\s*\+=\s*([A-Za-z_][A-Za-z0-9_.]+)/);
      if (eventMatch) {
        const [, eventName, callbackName] = eventMatch;
        const hasCleanup = cleanupBodies.some((body) => (
          body.includes(`${eventName} -= ${callbackName}`)
          || body.includes(`${eventName}-=${callbackName}`)
        ));
        if (!hasCleanup) {
          findings.push(createFinding({
            file: filePath,
            line: method.bodyStartLine + index,
            severity: 'high',
            ruleId: 'unity.missing_unsubscribe',
            message: `Subscribes to ${eventName} in ${method.name} but no matching cleanup for ${callbackName} is visible in OnDisable/OnDestroy.`,
            confidence: 'high',
            suggestedFix: `Add ${eventName} -= ${callbackName}; in OnDisable or OnDestroy.`,
            category: 'reliability',
            promotionMode: 'direct_finding',
          }));
        }
        continue;
      }

      const listenerMatch = line.match(/([A-Za-z_][A-Za-z0-9_.]+)\.AddListener\(\s*([A-Za-z_][A-Za-z0-9_.]+)\s*\)/);
      if (!listenerMatch) continue;
      const [, eventName, callbackName] = listenerMatch;
      const hasCleanup = cleanupBodies.some((body) => body.includes(`${eventName}.RemoveListener(${callbackName})`));
      if (hasCleanup) continue;
      findings.push(createFinding({
        file: filePath,
        line: method.bodyStartLine + index,
        severity: 'high',
        ruleId: 'unity.missing_unsubscribe',
        message: `Adds ${callbackName} as a listener on ${eventName} in ${method.name} but no matching RemoveListener appears in OnDisable/OnDestroy.`,
        confidence: 'high',
        suggestedFix: `Call ${eventName}.RemoveListener(${callbackName}); during teardown.`,
        category: 'reliability',
        promotionMode: 'direct_finding',
      }));
    }
  }

  return findings;
}

function isEditorOnlyRuntimePath(normalizedPath) {
  return UNITY_EDITOR_ONLY_PATH_RE.test(normalizedPath);
}

function isEditorOnlyPreprocessorExpression(expression) {
  const normalized = String(expression || '').trim();
  if (!normalized) return false;
  if (/!\s*UNITY_EDITOR\b/.test(normalized)) return false;
  return /\bUNITY_EDITOR\b/.test(normalized);
}

function buildEditorOnlyLineSet(content) {
  const lines = String(content || '').split('\n');
  const editorOnlyLines = new Set();
  const stack = [];

  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    const lineNumber = index + 1;

    const ifMatch = trimmed.match(/^#if\s+(.+)$/);
    if (ifMatch) {
      const editorOnly = isEditorOnlyPreprocessorExpression(ifMatch[1]);
      stack.push({
        editorOnly,
        hasMatchedEditorOnlyBranch: editorOnly,
      });
      continue;
    }

    const elifMatch = trimmed.match(/^#elif\s+(.+)$/);
    if (elifMatch && stack.length > 0) {
      const editorOnly = isEditorOnlyPreprocessorExpression(elifMatch[1]);
      const current = stack[stack.length - 1];
      stack[stack.length - 1] = {
        editorOnly: current?.hasMatchedEditorOnlyBranch === true ? false : editorOnly,
        hasMatchedEditorOnlyBranch: current?.hasMatchedEditorOnlyBranch === true || editorOnly,
      };
      continue;
    }

    if (/^#else\b/.test(trimmed) && stack.length > 0) {
      const current = stack[stack.length - 1];
      stack[stack.length - 1] = {
        editorOnly: current?.hasMatchedEditorOnlyBranch !== true,
        hasMatchedEditorOnlyBranch: true,
      };
      continue;
    }

    if (/^#endif\b/.test(trimmed)) {
      stack.pop();
      continue;
    }

    if (stack.some((entry) => entry?.editorOnly === true)) {
      editorOnlyLines.add(lineNumber);
    }
  }

  return editorOnlyLines;
}

function collectEditorApiUsageFindings(filePath, afterContent) {
  const normalizedPath = normalizePathForMatch(filePath);
  if (!normalizedPath || isEditorOnlyRuntimePath(normalizedPath)) return [];

  const lines = String(afterContent || '').split('\n');
  const editorOnlyLines = buildEditorOnlyLineSet(afterContent);
  const findings = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (editorOnlyLines.has(index + 1)) continue;
    if (!UNITY_RUNTIME_EDITOR_REFERENCE_RE.test(lines[index])) continue;
    findings.push(createFinding({
      file: filePath,
      line: index + 1,
      severity: 'high',
      ruleId: 'unity.editor_api_in_runtime_path',
      message: 'Runtime code references UnityEditor APIs, which will break player builds or runtime execution.',
      confidence: 'high',
      suggestedFix: 'Move the code behind an editor-only assembly/path or replace the UnityEditor dependency with a runtime-safe API.',
      category: 'build',
      promotionMode: 'direct_finding',
    }));
  }
  return findings;
}

function isAsmdefRuntimeTarget(parsedAsmdef = {}, normalizedPath = '') {
  if (isEditorOnlyRuntimePath(normalizedPath)) return false;
  const includePlatforms = Array.isArray(parsedAsmdef?.includePlatforms)
    ? parsedAsmdef.includePlatforms.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean)
    : [];
  if (includePlatforms.length === 0) return true;
  return !includePlatforms.every((entry) => entry === 'editor');
}

function collectEditorAssemblyReferenceFindings(filePath, afterContent) {
  const normalizedPath = normalizePathForMatch(filePath);
  if (!normalizedPath || !normalizedPath.endsWith('.asmdef')) return [];

  let parsed;
  try {
    parsed = JSON.parse(String(afterContent || ''));
  } catch {
    return [];
  }

  if (!isAsmdefRuntimeTarget(parsed, normalizedPath)) return [];

  const references = Array.isArray(parsed?.references) ? parsed.references : [];
  const editorReferences = references.filter((entry) => UNITY_EDITOR_ONLY_REFERENCE_RE.test(String(entry || '').trim()));
  if (editorReferences.length === 0) return [];

  const lines = String(afterContent || '').split('\n');
  const targetReference = editorReferences[0];
  const lineIndex = Math.max(0, lines.findIndex((line) => line.includes(`"${targetReference}"`)));

  return [createFinding({
    file: filePath,
    line: lineIndex + 1,
    severity: 'high',
    ruleId: 'unity.editor_api_in_runtime_path',
    message: `Runtime asmdef references editor-only assembly "${targetReference}", which will break non-editor builds.`,
    confidence: 'high',
    suggestedFix: 'Move the reference into an editor-only asmdef or gate the assembly with includePlatforms: ["Editor"].',
    category: 'build',
    promotionMode: 'direct_finding',
  })];
}

function collectPooledStateResetFindings(filePath, afterContent) {
  const normalizedContent = String(afterContent || '');
  if (!UNITY_POOL_MARKER_RE.test(normalizedContent)) return [];

  const methods = extractMethodBlocks(afterContent);
  const resetMethods = methods.filter((method) => POOL_RESET_METHOD_NAMES.has(method.name));
  if (resetMethods.length === 0) return [];

  const findings = [];
  for (const method of methods) {
    if (!POOL_INIT_METHOD_NAMES.has(method.name)) continue;
    const lines = method.body.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      const assignmentMatch = line.match(/\b(this\.[A-Za-z_][A-Za-z0-9_]*|_[A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;]+);/);
      if (!assignmentMatch) continue;
      const fieldName = assignmentMatch[1];
      const escapedFieldName = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const resetSeen = resetMethods.some((resetMethod) => {
        const fieldResetMatch = resetMethod.body.match(new RegExp(`${escapedFieldName}\\s*=\\s*([^;]+);`, 'g'));
        return Array.isArray(fieldResetMatch) && fieldResetMatch.some((candidate) => UNITY_RESET_VALUE_RE.test(candidate));
      });
      if (resetSeen) continue;
      findings.push(createFinding({
        file: filePath,
        line: method.bodyStartLine + index,
        severity: 'medium',
        ruleId: 'unity.pooled_state_not_reset',
        message: `${fieldName} is assigned on a pooled initialization path (${method.name}) but no matching reset is visible on the pool return path.`,
        confidence: 'medium',
        suggestedFix: `Reset ${fieldName} in ${resetMethods[0].name} or another pool-release path.`,
        category: 'reliability',
        promotionMode: 'candidate_evidence',
      }));
    }
  }

  return findings;
}

function summarizeCounts(findings = [], keyGetter) {
  const counts = {};
  for (const finding of Array.isArray(findings) ? findings : []) {
    const key = String(keyGetter(finding) || '').trim();
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

async function runUnitySemanticVerifier(projectPath, reviewFiles, diffText, options = {}) {
  const startedAt = Date.now();
  const config = options.unitySemanticVerifier || null;
  if (!isUnitySemanticVerifierEnabled(config)) {
    return emptyUnitySemanticResult('feature_disabled');
  }

  const reviewProfile = options.reviewProfile || null;
  if (!reviewProfile || reviewProfile.stackFamily !== 'unity') {
    return emptyUnitySemanticResult('not_unity');
  }

  const unityRoot = normalizePathForMatch(reviewProfile?.projectContext?.unityRoot || '');
  const safeFiles = (Array.isArray(reviewFiles) ? reviewFiles : []).filter((entry) => {
    const normalizedPath = normalizePathForMatch(entry?.path || '');
    if (!normalizedPath) return false;
    if (!isPathUnderUnityRoot(normalizedPath, unityRoot)) return false;
    return typeof entry?.after === 'string';
  });
  if (safeFiles.length === 0) {
    return emptyUnitySemanticResult('no_files');
  }

  const findings = [];
  for (const file of safeFiles) {
    const normalizedPath = normalizePathForMatch(file?.path || '');
    if (!normalizedPath) continue;
    const extension = path.extname(normalizedPath).toLowerCase();
    if (extension === '.cs') {
      findings.push(...collectMissingUnsubscribeFindings(normalizedPath, file.after));
      findings.push(...collectPooledStateResetFindings(normalizedPath, file.after));
      findings.push(...collectEditorApiUsageFindings(normalizedPath, file.after));
      continue;
    }
    if (extension === '.asmdef') {
      findings.push(...collectEditorAssemblyReferenceFindings(normalizedPath, file.after));
    }
  }

  let verifiedFindings = findings;
  const localVerificationStats = {
    attempted: false,
    succeeded: false,
    skippedReason: null,
    failedReason: null,
    bundleEntries: [],
    providerId: null,
  };
  if (findings.length > 0 && isUnityLocalCodebaseVerificationEnabled(config)) {
    localVerificationStats.attempted = true;
    try {
      const localVerification = await runReviewLocalCodebaseVerification(projectPath, findings, {
        reviewProfile,
        reviewFiles: safeFiles,
      });
      verifiedFindings = Array.isArray(localVerification?.findings) ? localVerification.findings : findings;
      localVerificationStats.bundleEntries = Array.isArray(localVerification?.bundleEntries) ? localVerification.bundleEntries : [];
      localVerificationStats.providerId = localVerification?.providerId || null;
      if (localVerification?.stats?.enabled) {
        localVerificationStats.succeeded = true;
      } else {
        localVerificationStats.skippedReason = localVerification?.stats?.skippedReason || 'unknown';
      }
    } catch (error) {
      localVerificationStats.failedReason = error?.message || 'unknown';
    }
  } else if (findings.length > 0) {
    localVerificationStats.skippedReason = 'feature_disabled';
  }

  const diffIndex = buildChangedLineIndex(diffText);
  const normalizedFindings = verifiedFindings.map((finding) => ({
    ...finding,
    file: resolveCanonicalDiffPath(finding.file, diffIndex) || finding.file,
  }));
  const { anchored, unanchored } = filterAnchoredFindings(normalizedFindings, diffIndex);
  const promptFindings = anchored.filter((finding) => shouldExposeUnityFindingToPrompt(finding));

  const toolsAttempted = [UNITY_SEMANTIC_TOOL_ID];
  const toolsSucceeded = [UNITY_SEMANTIC_TOOL_ID];
  const toolsSkipped = [];
  const toolsFailed = [];
  if (localVerificationStats.attempted) {
    toolsAttempted.push(LOCAL_CODEBASE_VERIFICATION_TOOL_ID);
    if (localVerificationStats.succeeded) {
      toolsSucceeded.push(LOCAL_CODEBASE_VERIFICATION_TOOL_ID);
    } else if (localVerificationStats.failedReason) {
      toolsFailed.push(`${LOCAL_CODEBASE_VERIFICATION_TOOL_ID}:${localVerificationStats.failedReason}`);
    } else {
      toolsSkipped.push(`${LOCAL_CODEBASE_VERIFICATION_TOOL_ID}:${localVerificationStats.skippedReason || 'unknown'}`);
    }
  }

  return {
    findings: normalizedFindings,
    anchoredFindings: anchored,
    promptFindings,
    localVerification: localVerificationStats.attempted
      ? {
          enabled: localVerificationStats.succeeded,
          skippedReason: localVerificationStats.skippedReason,
          failedReason: localVerificationStats.failedReason,
          providerId: localVerificationStats.providerId,
          toolId: LOCAL_CODEBASE_VERIFICATION_TOOL_ID,
          bundleEntries: localVerificationStats.bundleEntries,
        }
      : null,
    stats: {
      enabled: true,
      skippedReason: null,
      toolsAttempted,
      toolsSucceeded,
      toolsSkipped,
      toolsFailed,
      totalFindings: normalizedFindings.length,
      anchoredFindings: anchored.length,
      unanchoredFindings: unanchored.length,
      findingsBySeverity: summarizeCounts(normalizedFindings, (finding) => finding.severity),
      findingsBySource: summarizeCounts(normalizedFindings, (finding) => finding.source),
      findingsByRule: summarizeCounts(normalizedFindings, (finding) => finding.ruleId),
      durationMs: Date.now() - startedAt,
    },
  };
}

export {
  UNITY_SEMANTIC_SOURCE,
  UNITY_SEMANTIC_TOOL_ID,
  isUnitySemanticVerifierEnabled,
  runUnitySemanticVerifier,
};
