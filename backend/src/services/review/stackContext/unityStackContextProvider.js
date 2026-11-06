import fs from 'fs/promises';
import path from 'path';

import { normalizePathForMatch } from '../reviewHelpers.js';

async function readTextIfExists(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function parseUnityEditorVersion(content) {
  const match = String(content || '').match(/m_EditorVersion:\s*([^\s]+)/i);
  return match?.[1] || null;
}

function parseUnityManifestDependencies(content) {
  if (typeof content !== 'string' || !content.trim()) return [];
  try {
    const parsed = JSON.parse(content);
    const dependencies = parsed?.dependencies && typeof parsed.dependencies === 'object'
      ? Object.keys(parsed.dependencies)
      : [];
    return dependencies
      .map((entry) => String(entry || '').trim())
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function countUnityChangedFileClasses(reviewProfile, contextFiles = []) {
  const allPaths = new Set(
    (Array.isArray(contextFiles) ? contextFiles : [])
      .map((entry) => normalizePathForMatch(entry?.path || ''))
      .filter(Boolean)
  );
  const counts = {
    deep: 0,
    structural: 0,
    collapsed: 0,
  };

  for (const file of Array.isArray(contextFiles) ? contextFiles : []) {
    const classification = typeof reviewProfile?.classifyEntry === 'function'
      ? reviewProfile.classifyEntry(file, { allPaths })
      : null;
    const fileClass = String(classification?.fileClass || '').trim().toLowerCase();
    if (fileClass === 'deep' || fileClass === 'structural' || fileClass === 'collapsed') {
      counts[fileClass] += 1;
    }
  }

  return counts;
}

function buildUnityFocusAreas(contextFiles = [], maxItems = 3) {
  const safeFiles = Array.isArray(contextFiles) ? contextFiles : [];
  const focusAreas = [];

  if (safeFiles.some((entry) => /\.(prefab|unity)$/i.test(entry?.path || ''))) {
    focusAreas.push('serialized reference stability across prefab and scene edits');
  }
  if (safeFiles.some((entry) => /\.(asmdef|asmref)$/i.test(entry?.path || ''))) {
    focusAreas.push('assembly boundary and define-constraint compatibility');
  }
  if (safeFiles.some((entry) => /(^|\/)(Packages|ProjectSettings)\//i.test(entry?.path || ''))) {
    focusAreas.push('editor, package, and build-pipeline compatibility');
  }
  if (safeFiles.some((entry) => (
    /(^|\/)Assets\/Editor\//i.test(entry?.path || '')
    || (/Editor/i.test(entry?.path || '') && /\.cs$/i.test(entry?.path || ''))
  ))) {
    focusAreas.push('editor-only code paths and runtime/editor separation');
  }
  if (safeFiles.some((entry) => /\.(shader|shadergraph|hlsl|cginc)$/i.test(entry?.path || ''))) {
    focusAreas.push('render-pipeline and material compatibility');
  }
  if (safeFiles.some((entry) => /\.cs$/i.test(entry?.path || ''))) {
    focusAreas.push('Unity lifecycle symmetry around Awake/OnEnable/OnDisable/OnDestroy');
  }

  return focusAreas.slice(0, Math.max(1, Math.trunc(Number(maxItems) || 3)));
}

async function collectUnityStackContext(projectPath, {
  reviewProfile = null,
  contextFiles = [],
  maxItems = 4,
} = {}) {
  const normalizedUnityRoot = normalizePathForMatch(reviewProfile?.projectContext?.unityRoot || '');
  if (!projectPath || !reviewProfile || reviewProfile.stackFamily !== 'unity') {
    return null;
  }

  const unityRootPath = normalizedUnityRoot
    ? path.join(projectPath, normalizedUnityRoot)
    : projectPath;
  const projectVersionPath = path.join(unityRootPath, 'ProjectSettings', 'ProjectVersion.txt');
  const manifestPath = path.join(unityRootPath, 'Packages', 'manifest.json');
  const [projectVersionContent, manifestContent] = await Promise.all([
    readTextIfExists(projectVersionPath),
    readTextIfExists(manifestPath),
  ]);

  const editorVersion = parseUnityEditorVersion(projectVersionContent);
  const dependencies = parseUnityManifestDependencies(manifestContent);
  const changedFiles = (Array.isArray(contextFiles) ? contextFiles : []).filter((entry) => {
    const normalizedPath = normalizePathForMatch(entry?.path || '');
    if (!normalizedPath) return false;
    if (!normalizedUnityRoot) return true;
    return normalizedPath === normalizedUnityRoot || normalizedPath.startsWith(`${normalizedUnityRoot}/`);
  });
  const changedFileCounts = countUnityChangedFileClasses(reviewProfile, changedFiles);
  const focusAreas = buildUnityFocusAreas(changedFiles);
  const unityRootLabel = normalizedUnityRoot || '.';

  const signals = [
    `Unity root: ${unityRootLabel}`,
    editorVersion ? `Unity editor version: ${editorVersion}` : '',
    dependencies.length > 0
      ? `Packages manifest dependencies: ${dependencies.slice(0, 5).join(', ')}${dependencies.length > 5 ? ` (+${dependencies.length - 5} more)` : ''}`
      : '',
    `Changed Unity files in scope: deep ${changedFileCounts.deep}, structural ${changedFileCounts.structural}, collapsed ${changedFileCounts.collapsed}`,
  ].filter(Boolean);

  const focusLines = focusAreas.length > 0
    ? [`Changed Unity hotspots: ${focusAreas.join('; ')}`]
    : [];

  return {
    projectMetadata: {
      projectType: 'unity',
      configFile: normalizePathForMatch(path.join(normalizedUnityRoot, 'ProjectSettings', 'ProjectVersion.txt')),
    },
    additionalBlocks: [
      {
        id: 'unity_stack_signals',
        title: '### Atlas Local Context: Unity Stack Signals',
        priority: 52,
        lines: signals.slice(0, Math.max(1, Math.trunc(Number(maxItems) || 4))),
      },
      ...(focusLines.length > 0 ? [{
        id: 'unity_review_focus',
        title: '### Atlas Local Context: Unity Review Focus',
        priority: 53,
        lines: focusLines,
      }] : []),
    ],
  };
}

export {
  collectUnityStackContext,
};
