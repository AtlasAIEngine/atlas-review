import fs from 'fs/promises';
import { accessSync, constants as fsConstants, existsSync, readdirSync } from 'fs';
import path from 'path';

import { getGlobalReviewIgnorePresetSelection } from './reviewIgnorePatterns.js';
import { UNITY_REVIEW_PROFILE } from './profiles/unityProfile.js';

const DETECTION_SCAN_SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'Library',
  'Logs',
  'node_modules',
  'Obj',
  'Temp',
  'vendor',
]);
const DETECTION_SCAN_MAX_DIRECTORIES = 240;

const GENERIC_REVIEW_PROFILE = Object.freeze({
  id: 'generic',
  label: 'Generic',
  stackFamily: 'generic',
  presetIds: ['javascript_typescript'],
  detection: {
    markers: [],
  },
  fileClasses: ['deep', 'structural', 'shallow', 'collapsed', 'skip'],
  pairingRules: [],
  shapingHints: {
    collapseLowSignalAssets: false,
  },
  fallbackBehavior: {
    strategy: 'self',
  },
  summary:
    'Use the default review heuristics. Treat changed files as independent review targets unless a stack-specific profile says otherwise.',
  promptGuidance:
    'Use Atlas default risk prioritization. Focus on correctness, security, data integrity, and meaningful regressions across the changed files.',
  async detectProject() {
    return [];
  },
  classifyEntry(entry) {
    return {
      fileClass: 'deep',
      reason: 'generic_default',
      pairWithSiblingMeta: false,
      riskBoost: 0,
      sizeMultiplier: 1,
    };
  },
});

const REVIEW_PROFILES = Object.freeze([
  GENERIC_REVIEW_PROFILE,
  UNITY_REVIEW_PROFILE,
]);

const REVIEW_PROFILE_BY_ID = new Map(REVIEW_PROFILES.map((profile) => [profile.id, profile]));
const PRESET_TO_PROFILE_ID = new Map([
  ['javascript_typescript', 'generic'],
  ['unity_csharp', 'unity_csharp'],
]);

const DEFAULT_REVIEW_PROFILE_ID = GENERIC_REVIEW_PROFILE.id;
const UNITY_PRIMARY_MARKERS = Object.freeze([
  'Packages/manifest.json',
  'ProjectSettings/ProjectSettings.asset',
  'Packages/packages-lock.json',
  'UserSettings',
]);

function invalidateReviewProfileCache() {
  // Profile resolution currently relies on ignore-pattern cache state and
  // on-demand filesystem detection, so there is no independent cache here.
}

function cloneResolvedProfile(profile, overrides = {}) {
  const projectContext = overrides.projectContext && typeof overrides.projectContext === 'object'
    ? { ...overrides.projectContext }
    : null;
  const baseClassifyEntry = typeof profile.classifyEntry === 'function'
    ? profile.classifyEntry.bind(profile)
    : null;
  return {
    ...profile,
    source: overrides.source || 'fallback',
    presetId: overrides.presetId || null,
    detectionSignals: Array.isArray(overrides.detectionSignals) ? overrides.detectionSignals : [],
    projectContext,
    classifyEntry(entry, context = {}) {
      if (typeof baseClassifyEntry !== 'function') {
        return {
          fileClass: 'deep',
          reason: 'generic_default',
          pairWithSiblingMeta: false,
          riskBoost: 0,
          sizeMultiplier: 1,
        };
      }
      const mergedContext = projectContext
        ? {
            ...context,
            projectContext: {
              ...(context?.projectContext && typeof context.projectContext === 'object' ? context.projectContext : {}),
              ...projectContext,
            },
          }
        : context;
      return baseClassifyEntry(entry, mergedContext);
    },
  };
}

function getReviewProfileById(profileId) {
  const resolved = REVIEW_PROFILE_BY_ID.get(String(profileId || '').trim()) || GENERIC_REVIEW_PROFILE;
  return cloneResolvedProfile(resolved);
}

async function pathExists(candidatePath) {
  try {
    await fs.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

function pathExistsSync(candidatePath) {
  try {
    accessSync(candidatePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function findMarkersInProject(projectPath, detection = {}) {
  if (!projectPath || typeof projectPath !== 'string') {
    return [];
  }

  const markers = Array.isArray(detection?.markers)
    ? detection.markers.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  if (markers.length === 0) {
    return [];
  }

  const minMarkersMatched = Math.max(
    1,
    Math.min(markers.length, Math.trunc(Number(detection?.minMarkersMatched) || 1))
  );
  const maxDepth = Math.max(0, Math.min(6, Math.trunc(Number(detection?.maxDepth) || 0)));
  const queue = [{ dir: projectPath, depth: 0 }];
  const visited = new Set([projectPath]);
  let scannedDirectories = 0;

  while (queue.length > 0 && scannedDirectories < DETECTION_SCAN_MAX_DIRECTORIES) {
    const { dir, depth } = queue.shift();
    scannedDirectories += 1;

    const matchedSignals = [];
    for (const marker of markers) {
      if (await pathExists(path.join(dir, marker))) {
        matchedSignals.push(path.relative(projectPath, path.join(dir, marker)));
      }
    }
    if (matchedSignals.length >= minMarkersMatched) {
      return matchedSignals
        .map((entry) => String(entry || '').replace(/\\/g, '/'))
        .filter(Boolean);
    }

    if (depth >= maxDepth) {
      continue;
    }

    let children = [];
    try {
      children = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const child of children) {
      if (!child.isDirectory()) continue;
      if (DETECTION_SCAN_SKIP_DIRS.has(child.name)) continue;
      const childPath = path.join(dir, child.name);
      if (visited.has(childPath)) continue;
      visited.add(childPath);
      queue.push({ dir: childPath, depth: depth + 1 });
    }
  }

  return [];
}

async function findMarkerRootsInProject(projectPath, detection = {}) {
  if (!projectPath || typeof projectPath !== 'string') {
    return [];
  }

  const markers = Array.isArray(detection?.markers)
    ? detection.markers.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  if (markers.length === 0) {
    return [];
  }

  const minMarkersMatched = Math.max(
    1,
    Math.min(markers.length, Math.trunc(Number(detection?.minMarkersMatched) || 1))
  );
  const maxDepth = Math.max(0, Math.min(6, Math.trunc(Number(detection?.maxDepth) || 0)));
  const queue = [{ dir: projectPath, depth: 0 }];
  const visited = new Set([projectPath]);
  const matches = [];
  let scannedDirectories = 0;

  while (queue.length > 0 && scannedDirectories < DETECTION_SCAN_MAX_DIRECTORIES) {
    const { dir, depth } = queue.shift();
    scannedDirectories += 1;

    const matchedSignals = [];
    for (const marker of markers) {
      if (await pathExists(path.join(dir, marker))) {
        matchedSignals.push(path.relative(projectPath, path.join(dir, marker)));
      }
    }
    if (matchedSignals.length >= minMarkersMatched) {
      const relativeRoot = path.relative(projectPath, dir).replace(/\\/g, '/');
      matches.push({
        root: relativeRoot || '',
        matchedSignals: matchedSignals
          .map((entry) => String(entry || '').replace(/\\/g, '/'))
          .filter(Boolean),
      });
    }

    if (depth >= maxDepth) {
      continue;
    }

    let children = [];
    try {
      children = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const child of children) {
      if (!child.isDirectory()) continue;
      if (DETECTION_SCAN_SKIP_DIRS.has(child.name)) continue;
      const childPath = path.join(dir, child.name);
      if (visited.has(childPath)) continue;
      visited.add(childPath);
      queue.push({ dir: childPath, depth: depth + 1 });
    }
  }

  return matches;
}

async function scoreUnityRoot(projectPath, relativeRoot) {
  const rootPath = relativeRoot ? path.join(projectPath, relativeRoot) : projectPath;
  let score = 0;
  const matchedSignals = [];
  for (const marker of UNITY_PRIMARY_MARKERS) {
    if (await pathExists(path.join(rootPath, marker))) {
      matchedSignals.push(marker);
    }
  }
  if (matchedSignals.includes('Packages/manifest.json')) score += 8;
  if (matchedSignals.includes('ProjectSettings/ProjectSettings.asset')) score += 4;
  if (matchedSignals.includes('Packages/packages-lock.json')) score += 2;
  if (matchedSignals.includes('UserSettings')) score += 1;
  return {
    score,
    matchedSignals,
  };
}

async function findPrimaryUnityProject(projectPath, detection = {}) {
  const candidates = await findMarkerRootsInProject(projectPath, detection);
  if (candidates.length === 0) return null;

  const scored = await Promise.all(candidates.map(async (candidate) => {
    const extra = await scoreUnityRoot(projectPath, candidate.root);
    return {
      ...candidate,
      score: extra.score,
      extraSignals: extra.matchedSignals.map((marker) => {
        const normalizedRoot = candidate.root ? `${candidate.root}/` : '';
        return `${normalizedRoot}${marker}`.replace(/\\/g, '/');
      }),
      depth: candidate.root ? candidate.root.split('/').filter(Boolean).length : 0,
    };
  }));

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.depth !== right.depth) return left.depth - right.depth;
    return left.root.localeCompare(right.root);
  });

  const selected = scored[0];
  return {
    root: selected.root,
    detectionSignals: [...selected.matchedSignals, ...selected.extraSignals],
  };
}

function findMarkerRootsInProjectSync(projectPath, detection = {}) {
  if (!projectPath || typeof projectPath !== 'string') {
    return [];
  }

  const markers = Array.isArray(detection?.markers)
    ? detection.markers.map((entry) => String(entry || '').trim()).filter(Boolean)
    : [];
  if (markers.length === 0) {
    return [];
  }

  const minMarkersMatched = Math.max(
    1,
    Math.min(markers.length, Math.trunc(Number(detection?.minMarkersMatched) || 1))
  );
  const maxDepth = Math.max(0, Math.min(6, Math.trunc(Number(detection?.maxDepth) || 0)));
  const queue = [{ dir: projectPath, depth: 0 }];
  const visited = new Set([projectPath]);
  const matches = [];
  let scannedDirectories = 0;

  while (queue.length > 0 && scannedDirectories < DETECTION_SCAN_MAX_DIRECTORIES) {
    const { dir, depth } = queue.shift();
    scannedDirectories += 1;

    const matchedSignals = [];
    for (const marker of markers) {
      if (pathExistsSync(path.join(dir, marker))) {
        matchedSignals.push(path.relative(projectPath, path.join(dir, marker)));
      }
    }
    if (matchedSignals.length >= minMarkersMatched) {
      const relativeRoot = path.relative(projectPath, dir).replace(/\\/g, '/');
      matches.push({
        root: relativeRoot || '',
        matchedSignals: matchedSignals
          .map((entry) => String(entry || '').replace(/\\/g, '/'))
          .filter(Boolean),
      });
    }

    if (depth >= maxDepth) {
      continue;
    }

    let children = [];
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const child of children) {
      if (!child.isDirectory()) continue;
      if (DETECTION_SCAN_SKIP_DIRS.has(child.name)) continue;
      const childPath = path.join(dir, child.name);
      if (visited.has(childPath)) continue;
      visited.add(childPath);
      queue.push({ dir: childPath, depth: depth + 1 });
    }
  }

  return matches;
}

function scoreUnityRootSync(projectPath, relativeRoot) {
  const rootPath = relativeRoot ? path.join(projectPath, relativeRoot) : projectPath;
  let score = 0;
  const matchedSignals = [];
  for (const marker of UNITY_PRIMARY_MARKERS) {
    if (existsSync(path.join(rootPath, marker))) {
      matchedSignals.push(marker);
    }
  }
  if (matchedSignals.includes('Packages/manifest.json')) score += 8;
  if (matchedSignals.includes('ProjectSettings/ProjectSettings.asset')) score += 4;
  if (matchedSignals.includes('Packages/packages-lock.json')) score += 2;
  if (matchedSignals.includes('UserSettings')) score += 1;
  return {
    score,
    matchedSignals,
  };
}

function findPrimaryUnityProjectSync(projectPath, detection = {}) {
  const candidates = findMarkerRootsInProjectSync(projectPath, detection);
  if (candidates.length === 0) return null;

  const scored = candidates.map((candidate) => {
    const extra = scoreUnityRootSync(projectPath, candidate.root);
    return {
      ...candidate,
      score: extra.score,
      extraSignals: extra.matchedSignals.map((marker) => {
        const normalizedRoot = candidate.root ? `${candidate.root}/` : '';
        return `${normalizedRoot}${marker}`.replace(/\\/g, '/');
      }),
      depth: candidate.root ? candidate.root.split('/').filter(Boolean).length : 0,
    };
  });

  scored.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (left.depth !== right.depth) return left.depth - right.depth;
    return left.root.localeCompare(right.root);
  });

  const selected = scored[0];
  return {
    root: selected.root,
    detectionSignals: [...selected.matchedSignals, ...selected.extraSignals],
  };
}

async function resolveReviewProjectProfile({
  projectPath = null,
  explicitPresetId = null,
  presetLoader = getGlobalReviewIgnorePresetSelection,
} = {}) {
  const presetId = explicitPresetId || await presetLoader();
  const presetProfileId = PRESET_TO_PROFILE_ID.get(String(presetId || '').trim());
  if (presetProfileId && REVIEW_PROFILE_BY_ID.has(presetProfileId)) {
    return cloneResolvedProfile(REVIEW_PROFILE_BY_ID.get(presetProfileId), {
      source: 'preset',
      presetId,
    });
  }

  for (const profile of REVIEW_PROFILES) {
    if (profile.id === DEFAULT_REVIEW_PROFILE_ID || typeof profile.detectProject !== 'function') {
      continue;
    }
    const detectionResult = await profile.detectProject({
      projectPath,
      findMarkersInProject,
      findMarkerRootsInProject,
      findPrimaryUnityProject,
    });
    const detectionSignals = Array.isArray(detectionResult)
      ? detectionResult
      : (Array.isArray(detectionResult?.detectionSignals) ? detectionResult.detectionSignals : []);
    const projectContext = detectionResult && typeof detectionResult === 'object' && !Array.isArray(detectionResult)
      ? (detectionResult.projectContext && typeof detectionResult.projectContext === 'object' ? detectionResult.projectContext : null)
      : null;
    if (detectionSignals.length > 0) {
      return cloneResolvedProfile(profile, {
        source: 'detected',
        presetId: presetId || null,
        detectionSignals,
        projectContext,
      });
    }
  }

  return cloneResolvedProfile(GENERIC_REVIEW_PROFILE, {
    source: 'fallback',
    presetId: presetId || null,
  });
}

export {
  DEFAULT_REVIEW_PROFILE_ID,
  GENERIC_REVIEW_PROFILE,
  PRESET_TO_PROFILE_ID,
  REVIEW_PROFILES,
  findMarkerRootsInProject,
  findPrimaryUnityProject,
  findPrimaryUnityProjectSync,
  findMarkersInProject,
  getReviewProfileById,
  invalidateReviewProfileCache,
  resolveReviewProjectProfile,
};
