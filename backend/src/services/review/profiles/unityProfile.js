import path from 'path';

import { normalizePathForMatch } from '../reviewHelpers.js';

const UNITY_PROJECT_MARKERS = [
  'ProjectSettings/ProjectVersion.txt',
  'Assets',
];

const UNITY_STRUCTURAL_EXTENSIONS = new Set([
  '.anim',
  '.asset',
  '.controller',
  '.playable',
  '.shadergraph',
]);

const UNITY_COLLAPSED_EXTENSIONS = new Set([
  '.bmp',
  '.csproj',
  '.dds',
  '.fbx',
  '.gif',
  '.jpg',
  '.jpeg',
  '.mat',
  '.mp3',
  '.ogg',
  '.png',
  '.psd',
  '.tga',
  '.tif',
  '.tiff',
  '.wav',
  '.sln',
]);

const UNITY_SCENE_PREFAB_EXTENSIONS = new Set([
  '.prefab',
  '.unity',
]);

const UNITY_DEEP_PATH_RE = /(^|\/)(Assets\/(Editor|Scripts)\b|Packages\/|ProjectSettings\/|\.github\/|Tools\/|Build\/|build\/)/i;
const UNITY_DEEP_EXTENSION_RE = /\.(asmdef|asmref|cginc|cs|hlsl|json|shader)$/i;
const UNITY_SKIP_PATH_RE = /(^|\/)(Library|Logs|Obj|Packages\/packages-lock\.json|Temp|Build|Builds|MemoryCaptures|UserSettings\/Layouts)(\/|$)/i;
const UNITY_COLLAPSED_PATH_RE = /(^|\/)(UserSettings|Library\/PackageCache|Assets\/Art(?:\/|$)|Assets\/UI\/Art(?:\/|$))(\/|$)/i;
const UNITY_EXPORT_PATH_RE = /(^|\/)(Art|Art_Raw|Art_Source_Export|Source_Export|Exports?)(\/|$)/i;
const UNITY_RISK_INVARIANT_PATH_RE = /(^|\/)(Assets\/(Editor|Scripts)\b|Packages\/|ProjectSettings\/|Tools\/)/i;
const UNITY_RISK_INVARIANT_EXTENSION_RE = /\.(anim|asmdef|asmref|asset|controller|cs|cginc|hlsl|json|playable|shader|shadergraph)$/i;
const UNITY_SCENE_PREFAB_CHURN_EXTENSIONS = new Set([
  '.mat',
  '.meta',
  '.prefab',
  '.unity',
]);

function hasUnityRiskInvariant(allPaths = new Set(), currentPath = '') {
  for (const candidate of allPaths instanceof Set ? allPaths : []) {
    const normalizedCandidate = normalizePathForMatch(candidate || '');
    if (!normalizedCandidate || normalizedCandidate === currentPath) continue;
    if (normalizedCandidate.endsWith('.meta')) {
      const siblingPath = normalizedCandidate.slice(0, -'.meta'.length);
      const siblingExt = path.extname(siblingPath).toLowerCase();
      if (UNITY_SCENE_PREFAB_CHURN_EXTENSIONS.has(siblingExt)) continue;
      if (UNITY_RISK_INVARIANT_PATH_RE.test(siblingPath) || UNITY_RISK_INVARIANT_EXTENSION_RE.test(siblingPath)) {
        return true;
      }
      continue;
    }
    if (UNITY_RISK_INVARIANT_PATH_RE.test(normalizedCandidate) || UNITY_RISK_INVARIANT_EXTENSION_RE.test(normalizedCandidate)) {
      return true;
    }
  }
  return false;
}

function shouldCollapseSceneOrPrefabChurn(normalizedPath, allPaths = new Set()) {
  const extension = path.extname(normalizedPath).toLowerCase();
  if (!UNITY_SCENE_PREFAB_EXTENSIONS.has(extension)) return false;
  return !hasUnityRiskInvariant(allPaths, normalizedPath);
}

function classifyUnityNonMetaPath(normalizedPath, allPaths = new Set()) {
  if (!normalizedPath) {
    return { fileClass: 'skip', reason: 'empty_path' };
  }
  if (UNITY_SKIP_PATH_RE.test(normalizedPath)) {
    return { fileClass: 'skip', reason: 'unity_generated_path' };
  }
  if (UNITY_COLLAPSED_PATH_RE.test(normalizedPath)) {
    return { fileClass: 'collapsed', reason: 'unity_editor_or_artifact_noise', riskBoost: -45, sizeMultiplier: 0.2 };
  }
  if (UNITY_DEEP_PATH_RE.test(normalizedPath) || UNITY_DEEP_EXTENSION_RE.test(normalizedPath)) {
    return { fileClass: 'deep', reason: 'unity_code_or_config', riskBoost: 60, sizeMultiplier: 1.1 };
  }

  const extension = path.extname(normalizedPath).toLowerCase();
  if (shouldCollapseSceneOrPrefabChurn(normalizedPath, allPaths)) {
    return { fileClass: 'collapsed', reason: 'unity_scene_or_prefab_churn_without_risky_invariant', riskBoost: -15, sizeMultiplier: 0.35 };
  }
  if (UNITY_STRUCTURAL_EXTENSIONS.has(extension)) {
    return { fileClass: 'structural', reason: 'unity_text_asset', riskBoost: 20, sizeMultiplier: 0.8 };
  }
  if (UNITY_SCENE_PREFAB_EXTENSIONS.has(extension)) {
    return { fileClass: 'structural', reason: 'unity_scene_or_prefab_with_risky_invariant', riskBoost: 35, sizeMultiplier: 0.9 };
  }
  if (UNITY_COLLAPSED_EXTENSIONS.has(extension)) {
    return { fileClass: 'collapsed', reason: 'unity_low_signal_asset', riskBoost: -40, sizeMultiplier: 0.2 };
  }
  if (UNITY_EXPORT_PATH_RE.test(normalizedPath)) {
    return { fileClass: 'collapsed', reason: 'unity_export_artifact', riskBoost: -60, sizeMultiplier: 0.15 };
  }

  return { fileClass: 'deep', reason: 'generic_fallback' };
}

function isPathUnderUnityRoot(normalizedPath, unityRoot) {
  const root = normalizePathForMatch(unityRoot || '');
  if (!root) return true;
  return normalizedPath === root || normalizedPath.startsWith(`${root}/`);
}

const UNITY_REVIEW_PROFILE = Object.freeze({
  id: 'unity_csharp',
  label: 'Unity / C#',
  stackFamily: 'unity',
  presetIds: ['unity_csharp'],
  detection: {
    markers: UNITY_PROJECT_MARKERS,
    minMarkersMatched: 2,
    maxDepth: 4,
  },
  fileClasses: ['deep', 'structural', 'shallow', 'collapsed', 'skip'],
  pairingRules: [
    {
      id: 'asset_meta_pair',
      description: 'Pair changed Unity assets with sibling .meta files so review budgets track one logical unit.',
    },
  ],
  shapingHints: {
    collapseLowSignalAssets: true,
    preferStructuralAssetReview: true,
  },
  fallbackBehavior: {
    strategy: 'generic',
  },
  summary:
    'Prioritize C#, packages, project settings, editor tooling, and text-based Unity assets. Collapse low-signal material/art/meta churn unless it is the only meaningful change.',
  promptGuidance:
    'Treat C#, asmdefs, package/config changes, and ProjectSettings as deep review targets. Review prefab/scene/controller/shadergraph changes structurally. Do not over-index on .meta, .mat, and exported art churn.',
  async detectProject({ projectPath, findMarkersInProject, findPrimaryUnityProject }) {
    if (typeof findPrimaryUnityProject === 'function') {
      const primary = await findPrimaryUnityProject(projectPath, {
        markers: UNITY_PROJECT_MARKERS,
        minMarkersMatched: 2,
        maxDepth: 4,
      });
      if (primary && Array.isArray(primary.detectionSignals) && primary.detectionSignals.length > 0) {
        return {
          detectionSignals: primary.detectionSignals,
          projectContext: {
            unityRoot: primary.root || '',
          },
        };
      }
    }
    if (typeof findMarkersInProject === 'function') {
      return findMarkersInProject(projectPath, {
        markers: UNITY_PROJECT_MARKERS,
        minMarkersMatched: 2,
        maxDepth: 4,
      });
    }
    return [];
  },
  classifyEntry(entry, { allPaths, projectContext } = {}) {
    const normalizedPath = normalizePathForMatch(entry?.path || '');
    if (!normalizedPath) {
      return { fileClass: 'skip', reason: 'empty_path', pairWithSiblingMeta: false };
    }
    const unityRoot = normalizePathForMatch(projectContext?.unityRoot || '');
    if (!isPathUnderUnityRoot(normalizedPath, unityRoot)) {
      return { fileClass: 'skip', reason: 'outside_primary_unity_root', pairWithSiblingMeta: false };
    }

    if (normalizedPath.endsWith('.meta')) {
      const siblingPath = normalizedPath.slice(0, -'.meta'.length);
      if (allPaths instanceof Set && allPaths.has(siblingPath)) {
        const siblingClassification = classifyUnityNonMetaPath(siblingPath, allPaths);
        if (siblingClassification.fileClass === 'skip') {
          return { fileClass: 'collapsed', reason: 'meta_for_skipped_asset', pairWithSiblingMeta: false };
        }
        if (siblingClassification.fileClass === 'collapsed') {
          return { fileClass: 'collapsed', reason: 'meta_for_low_signal_asset', pairWithSiblingMeta: false };
        }
        return {
          fileClass: siblingClassification.fileClass,
          reason: 'paired_meta_file',
          pairWithSiblingMeta: false,
          riskBoost: siblingClassification.riskBoost || 0,
          sizeMultiplier: siblingClassification.sizeMultiplier || 1,
        };
      }
      return { fileClass: 'collapsed', reason: 'orphan_meta_file', pairWithSiblingMeta: false };
    }

    const classification = classifyUnityNonMetaPath(normalizedPath, allPaths);
    return {
      ...classification,
      pairWithSiblingMeta: classification.fileClass === 'deep' || classification.fileClass === 'structural',
    };
  },
});

export {
  UNITY_REVIEW_PROFILE,
};
